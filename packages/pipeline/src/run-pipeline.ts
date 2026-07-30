/**
 * パイプラインのオーケストレーター。
 *
 * ★このファイルが唯一「実行順序・進捗通知・キャンセル・キャッシュ判定・
 * ディスクへの永続化」を知っている場所。個々の工程（steps/*.ts）は
 * 自分がどう呼ばれるか、他に何が走っているかを一切知らない。
 *
 * 保存のタイミングについて：実際の `project.json` 書き込みは、
 * 個別の工程（save-project）ではなく、この関数が実行の最後に必ず1回だけ
 * 行う。`onlySteps` で実行範囲を絞ったとき save-project 自体が計画に
 * 含まれないことがあるが、それでも完了した工程の結果は必ず残さなければ
 * ならないため。
 *
 * @see docs/14-pipeline.md
 */

import { statSync } from 'node:fs';

import {
  emptyStepRecord,
  type AnalysisLayer,
  type Project,
  type ProjectStatus,
  type StepRecord,
} from '../../core/src/project.ts';
import { saveProject } from '../../core/src/project-store.ts';
import { buildResolveDiffReport } from './diff-report.ts';
import { PipelineErrors, isPipelineError } from './errors.ts';
import {
  canonicalize,
  hashAssetFingerprints,
  hashConfig,
  hashFromDependencyOutputs,
} from './hash.ts';
import { createProjectLogger, scopedLogger } from './logger.ts';
import { buildProjectPaths, clearTemp, ensureProjectDirs } from './paths.ts';
import { isAbortError } from './process.ts';
import {
  assertDependenciesSatisfied,
  assertValidGraph,
  computeExecutionPlan,
  stepConfigSlice,
  STEP_DEPENDENCIES,
} from './registry.ts';
import { DEFAULT_STEP_DEFINITIONS } from './steps/index.ts';
import {
  DEFAULT_PIPELINE_CONFIG,
  PIPELINE_STEP_LABELS,
  type PipelineStepId,
  type ProgressEvent,
  type ResolvedPipelineConfig,
  type RunPipelineOptions,
  type RunPipelineResult,
  type StepContext,
  type StepDefinition,
  type StepOutcome,
} from './types.ts';

export interface RunPipelineDeps {
  /** テスト用の工程差し替え。実ffmpeg/実whisperを使わない検証に使う。 */
  steps?: Partial<Record<PipelineStepId, StepDefinition>>;
  now?: () => Date;
}

function mergeConfig(
  project: Project,
  options: RunPipelineOptions,
): ResolvedPipelineConfig {
  const base = DEFAULT_PIPELINE_CONFIG;
  return {
    syncMode: options.config?.syncMode ?? project.sync.mode ?? base.syncMode,
    transcribe: { ...base.transcribe, ...options.config?.transcribe },
    correctAudio: { ...base.correctAudio, ...options.config?.correctAudio },
    shortCandidates: { ...base.shortCandidates, ...options.config?.shortCandidates },
  };
}

function emptyAnalysisLayer(generatedAt: string): AnalysisLayer {
  return {
    generatedAt,
    fingerprint: '',
    speakers: [],
    speech: [],
    backchannels: [],
    overlaps: [],
    laughter: [],
    emphasis: [],
    subtitles: [],
    chapters: [],
    markers: [],
    cameraShots: [],
    shortCandidates: [],
    checks: [],
  };
}

function computeFingerprint(analysis: AnalysisLayer): string {
  const { generatedAt: _generatedAt, fingerprint: _fingerprint, ...content } = analysis;
  return hashConfig(canonicalize(content));
}

/**
 * 工程の入力ハッシュ。
 *
 * `validate-project` と `probe-media` は素材そのもの（サイズ・更新時刻）を
 * 直接見る。それ以外の工程は、依存する工程の出力ハッシュだけを見る——
 * これにより「上流の出力が変わった」ことが自動的に連鎖する
 * （文字起こしのモデルを変えれば、字幕・チャプター・ショート候補・
 * マーカー・XMLまで、影響を受ける工程だけが再実行される）。
 */
function computeInputHash(
  stepId: PipelineStepId,
  assets: Project['assets'],
  stepRecords: Record<string, StepRecord>,
): string {
  if (stepId === 'validate-project' || stepId === 'probe-media') {
    const fingerprints = assets.map((asset) => {
      try {
        const stat = statSync(asset.absolutePath);
        return { path: asset.absolutePath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return { path: asset.absolutePath, sizeBytes: undefined, mtimeMs: undefined };
      }
    });
    return hashAssetFingerprints(fingerprints);
  }

  const deps = STEP_DEPENDENCIES[stepId];
  return hashFromDependencyOutputs(deps.map((dep) => stepRecords[dep]?.outputHash));
}

function isCacheableStatus(status: StepRecord['status']): boolean {
  return status === 'completed' || status === 'warning';
}

function deriveProjectStatus(
  previous: ProjectStatus,
  outcomes: readonly StepOutcome[],
  cancelled: boolean,
  reachedSaveProject: boolean,
): ProjectStatus {
  if (cancelled) return '解析中';
  if (outcomes.some((o) => o.status === 'failed')) return '解析中';
  if (reachedSaveProject) return '確認待ち';
  return previous === '素材準備中' ? '解析中' : previous;
}

/**
 * パイプラインを実行する。
 *
 * ★React / Electron / DOM への依存は一切無い。CLIからもGUI（Electronの
 * メインプロセス経由）からも、この関数を呼ぶだけで同じ結果になる。
 */
export async function runPipeline(
  project: Project,
  options: RunPipelineOptions = {},
  deps: RunPipelineDeps = {},
): Promise<RunPipelineResult> {
  assertValidGraph();

  const now = deps.now ?? (() => new Date());
  const stepDefs = { ...DEFAULT_STEP_DEFINITIONS, ...deps.steps };
  const config = mergeConfig(project, options);
  const paths = buildProjectPaths(project.rootDir);
  ensureProjectDirs(paths);
  clearTemp(paths); // ★毎回クリア。前回の中断で残った半端なファイルは再利用しない。

  const logger = createProjectLogger(paths.logs, now());
  const signal = options.signal ?? new AbortController().signal;

  const plan = computeExecutionPlan({
    fromStep: options.fromStep,
    toStep: options.toStep,
    onlySteps: options.onlySteps,
  });

  const isAlreadyCompleted = (id: PipelineStepId): boolean => {
    const record = project.pipeline.steps[id];
    return record !== undefined && isCacheableStatus(record.status);
  };

  try {
    assertDependenciesSatisfied(plan, isAlreadyCompleted);
  } catch (error) {
    const pipelineError = isPipelineError(error)
      ? error
      : PipelineErrors.unknown(plan[0] ?? 'validate-project', error);
    return {
      project,
      cancelled: false,
      outcomes: [
        {
          stepId: pipelineError.stepId,
          status: 'failed',
          warnings: [],
          error: pipelineError,
        },
      ],
    };
  }

  const forceAll = options.force === true;
  const forcedSteps = new Set(Array.isArray(options.force) ? options.force : []);

  let workingAnalysis: AnalysisLayer = project.analysis
    ? structuredClone(project.analysis)
    : emptyAnalysisLayer(now().toISOString());
  let workingAssets = project.assets;
  let workingSyncOffsets = { ...project.sync.offsets };

  const stepRecords: Record<string, StepRecord> = { ...project.pipeline.steps };
  const stepStatus = new Map<PipelineStepId, StepOutcome['status']>();
  /** 依存工程の失敗で連鎖的にスキップされた工程。'skipped' との違いは
   * 「キャッシュ利用でスキップ」は下流に影響しないが、こちらは
   * さらに下流も同様にスキップさせる必要がある点。 */
  const brokenChain = new Set<PipelineStepId>();
  const outcomes: StepOutcome[] = [];
  let cancelled = false;

  const emitProgress = (
    stepId: PipelineStepId,
    index: number,
    status: ProgressEvent['status'],
    extra: Partial<ProgressEvent> = {},
  ): void => {
    options.onProgress?.({
      stepId,
      stepLabel: PIPELINE_STEP_LABELS[stepId],
      stepIndex: index + 1,
      stepCount: plan.length,
      overallRatio: plan.length > 0 ? (index + (status === 'running' ? 0 : 1)) / plan.length : 1,
      status,
      ...extra,
    });
  };

  for (const [index, stepId] of plan.entries()) {
    if (signal.aborted) {
      cancelled = true;
      break;
    }

    const inPlanDeps = STEP_DEPENDENCIES[stepId].filter((dep) => plan.includes(dep));
    const failedDep = inPlanDeps.find(
      (dep) => stepStatus.get(dep) === 'failed' || brokenChain.has(dep),
    );
    if (failedDep) {
      const error = PipelineErrors.dependencyFailed(stepId, failedDep);
      brokenChain.add(stepId);
      stepStatus.set(stepId, 'skipped');
      outcomes.push({ stepId, status: 'skipped', warnings: [], error });
      emitProgress(stepId, index, 'skipped', { error, message: error.userMessage });
      continue;
    }

    const inputHash = computeInputHash(stepId, workingAssets, stepRecords);
    const configHash = hashConfig(stepConfigSlice(stepId, config));
    const stored = stepRecords[stepId];
    const forced = forceAll || forcedSteps.has(stepId);
    const cacheHit =
      !forced &&
      stored !== undefined &&
      isCacheableStatus(stored.status) &&
      stored.inputHash === inputHash &&
      stored.configHash === configHash;

    if (cacheHit && stored) {
      stepStatus.set(stepId, stored.status);
      outcomes.push({
        stepId,
        status: 'skipped',
        durationMs: 0,
        warnings: stored.warnings,
        outputFiles: stored.outputFiles,
      });
      emitProgress(stepId, index, 'skipped', {
        message: '変更が無いためキャッシュを利用しました',
      });
      continue;
    }

    const definition = stepDefs[stepId];
    const startedAt = now();
    emitProgress(stepId, index, 'running', { startedAt: startedAt.toISOString() });

    const stepLog = scopedLogger(logger, stepId, now);
    // ★project.assets は probe-media が更新した最新版（workingAssets）を渡す。
    // ここを元の project のままにすると、probe-mediaが確定させた尺・fps等が
    // 同じ実行内の後続工程（camera-plan等）に反映されないバグになる
    // （実機検証で実際に発生：wideのdurationSecが0のままカメラ切替0件になった）。
    const ctx: StepContext = {
      project: { ...project, assets: workingAssets },
      analysis: workingAnalysis,
      syncOffsets: workingSyncOffsets,
      syncMode: config.syncMode,
      paths,
      config,
      signal,
      log: stepLog,
      reportStepProgress: (ratio) => {
        emitProgress(stepId, index, 'running', {
          startedAt: startedAt.toISOString(),
          stepRatio: ratio,
        });
      },
      now,
    };

    stepLog({ event: 'start' });

    let result;
    try {
      result = await definition.run(ctx);
    } catch (error) {
      const finishedAt = now();
      const durationMs = finishedAt.getTime() - startedAt.getTime();

      if (isAbortError(error)) {
        cancelled = true;
        stepStatus.set(stepId, 'cancelled');
        stepRecords[stepId] = {
          status: 'cancelled',
          startedAt: startedAt.toISOString(),
          finishedAt: finishedAt.toISOString(),
          durationMs,
          warnings: [],
        };
        outcomes.push({ stepId, status: 'cancelled', durationMs, warnings: [] });
        emitProgress(stepId, index, 'cancelled', { elapsedMs: durationMs });
        stepLog({ event: 'error', durationMs, success: false, errorCode: 'CANCELLED' });
        break;
      }

      const pipelineError = isPipelineError(error)
        ? error
        : PipelineErrors.unknown(stepId, error);

      stepStatus.set(stepId, 'failed');
      stepRecords[stepId] = {
        status: 'failed',
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs,
        inputHash,
        configHash,
        warnings: [],
        errorCode: pipelineError.code,
        errorMessage: pipelineError.userMessage,
      };
      outcomes.push({ stepId, status: 'failed', durationMs, warnings: [], error: pipelineError });
      emitProgress(stepId, index, 'failed', { elapsedMs: durationMs, error: pipelineError });
      stepLog({
        event: 'error',
        durationMs,
        success: false,
        errorCode: pipelineError.code,
      });
      continue;
    }

    const finishedAt = now();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    if (result.analysisPatch) {
      workingAnalysis = { ...workingAnalysis, ...result.analysisPatch };
    }
    if (result.syncOffsetsPatch) {
      workingSyncOffsets = { ...workingSyncOffsets, ...result.syncOffsetsPatch };
    }
    if (result.assetsPatch) {
      workingAssets = result.assetsPatch;
    }

    const outputHash = hashConfig(
      canonicalize({
        inputHash,
        configHash,
        patch: result.analysisPatch ?? null,
        sync: result.syncOffsetsPatch ?? null,
        assets: result.assetsPatch ?? null,
      }),
    );

    stepRecords[stepId] = {
      status: result.status,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      inputHash,
      configHash,
      outputHash,
      warnings: result.warnings ?? [],
      toolVersions: result.toolVersions,
      outputFiles: result.outputFiles,
      timings: result.timings,
    };
    stepStatus.set(stepId, result.status);
    outcomes.push({
      stepId,
      status: result.status,
      durationMs,
      warnings: result.warnings ?? [],
      outputFiles: result.outputFiles,
      timings: result.timings,
    });

    stepLog({
      event: 'finish',
      durationMs,
      success: true,
      warningCount: result.warnings?.length ?? 0,
      toolVersions: result.toolVersions,
    });

    emitProgress(stepId, index, result.status, {
      elapsedMs: durationMs,
      message: result.message,
      warning: result.warnings?.[0],
    });
  }

  // ★ここから先は「今回どこまで進んだか」に関わらず必ず実行する。
  // 完了した工程の結果を失わないための、実行全体で唯一の永続化ポイント。
  workingAnalysis = {
    ...workingAnalysis,
    generatedAt: now().toISOString(),
    fingerprint: computeFingerprint(workingAnalysis),
  };

  const resolveDiff = buildResolveDiffReport(project.analysis, workingAnalysis, project.edits);
  const reachedSaveProject = stepStatus.get('save-project') !== undefined;

  const savedAt = now();
  const persisted: Project = {
    ...project,
    assets: workingAssets,
    sync: { mode: config.syncMode, offsets: workingSyncOffsets },
    analysis: workingAnalysis,
    pipeline: {
      steps: stepRecords,
      lastRunAt: savedAt.toISOString(),
      lastRunCancelled: cancelled,
    },
    status: deriveProjectStatus(project.status, outcomes, cancelled, reachedSaveProject),
    updatedAt: savedAt.toISOString(),
  };

  saveProject(paths.root, persisted, { now: savedAt });

  return { project: persisted, outcomes, cancelled, resolveDiff };
}

export { emptyStepRecord };
