/**
 * 解析専用プロセスの入口。
 *
 * ★なぜ別プロセスなのか
 * computeEnvelope / estimateOffset / syncSources は同期のCPU集約処理で、
 * ffmpeg・whisperと違って子プロセスに逃げない。Electronのメインプロセスで
 * 直接 runPipeline() を呼ぶと、相互相関の計算中はイベントループが止まり
 * ウィンドウが固まる。だから解析はまるごとこのプロセスに追い出す。
 *
 * ★このファイルが守っていること
 * - packages/* を相対パスでimportしない。実行時に projectRoot 配下の
 *   ビルド済み dist/pipeline.js・dist/core.js を動的importする。
 *   よって型ストリッピングにも開発時のディレクトリ構造にも依存しない。
 * - RunPipelineResult.project をそのまま送り返さない。
 *   文字起こし全文・字幕全文を含むため、件数とファイル名だけに落とす。
 */

import { pathToFileURL } from 'node:url';

import type {
  WorkerFinishedPayload,
  WorkerInbound,
  WorkerOutbound,
  WorkerProgress,
  WorkerStepOutcome,
} from '../shared/worker-protocol.ts';
import type { PipelineErrorLike } from '../shared/errors.ts';

function send(message: WorkerOutbound): void {
  process.send?.(message);
}

/** 実行中の解析を止めるためのハンドル。runIdごとに1件だけ持つ。 */
let current: { runId: string; controller: AbortController } | undefined;

function toErrorLike(error: unknown): PipelineErrorLike {
  // PipelineError（code / userMessage を持つプレーンオブジェクト）はそのまま使う。
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'userMessage' in error
  ) {
    const e = error as PipelineErrorLike;
    return {
      code: String(e.code),
      userMessage: String(e.userMessage),
      ...(e.stepId !== undefined ? { stepId: e.stepId } : {}),
      ...(e.technicalMessage !== undefined
        ? { technicalMessage: e.technicalMessage }
        : {}),
      recoverable: e.recoverable ?? true,
      ...(e.suggestedAction !== undefined
        ? { suggestedAction: e.suggestedAction }
        : {}),
    };
  }

  // 想定外の例外。message は technicalMessage 側にだけ入れる
  // （Mainがログに残し、Rendererへは渡さない）。
  return {
    code: 'UNKNOWN',
    userMessage: '解析中に予期しないエラーが発生しました。',
    technicalMessage: error instanceof Error ? error.stack ?? error.message : String(error),
    recoverable: true,
  };
}

/** dist/ のビルド済みモジュールを読み込む。 */
async function loadPipeline(projectRoot: string): Promise<{
  runPipeline: (project: unknown, options: unknown) => Promise<unknown>;
  loadProject: (dir: string) => { project: unknown };
}> {
  const pipelineUrl = pathToFileURL(`${projectRoot}/dist/pipeline.js`).href;
  const coreUrl = pathToFileURL(`${projectRoot}/dist/core.js`).href;

  // 動的importにしているのは、パスが実行時にしか決まらないため。
  // バンドラはこの形をそのまま残す（＝dist/ を取り込まない）。
  const pipeline = (await import(pipelineUrl)) as {
    runPipeline: (project: unknown, options: unknown) => Promise<unknown>;
  };
  const core = (await import(coreUrl)) as {
    loadProject: (dir: string) => { project: unknown };
  };

  return { runPipeline: pipeline.runPipeline, loadProject: core.loadProject };
}

interface RawStepOutcome {
  stepId: string;
  status: string;
  durationMs?: number;
  warnings?: string[];
  error?: PipelineErrorLike;
  outputFiles?: string[];
}

interface RawRunResult {
  outcomes: RawStepOutcome[];
  cancelled: boolean;
  resolveDiff?: { orphaned?: unknown[]; conflicted?: unknown[] };
}

/** RunPipelineResult を、送ってよい情報だけに落とす。 */
function toFinishedPayload(result: RawRunResult): WorkerFinishedPayload {
  const outcomes: WorkerStepOutcome[] = result.outcomes.map((o) => ({
    stepId: o.stepId as WorkerStepOutcome['stepId'],
    status: o.status as WorkerStepOutcome['status'],
    ...(o.durationMs !== undefined ? { durationMs: o.durationMs } : {}),
    warnings: o.warnings ?? [],
    ...(o.error !== undefined ? { error: o.error } : {}),
  }));

  const outputFiles = result.outcomes.flatMap((o) => o.outputFiles ?? []);

  return {
    cancelled: result.cancelled,
    outcomes,
    outputFiles,
    orphanedCount: result.resolveDiff?.orphaned?.length ?? 0,
    conflictedCount: result.resolveDiff?.conflicted?.length ?? 0,
  };
}

async function start(message: Extract<WorkerInbound, { type: 'start' }>): Promise<void> {
  const { runId, projectPath, projectRoot, options } = message;
  const controller = new AbortController();
  current = { runId, controller };

  try {
    const { runPipeline, loadProject } = await loadPipeline(projectRoot);
    const { project } = loadProject(projectPath);

    const runOptions: Record<string, unknown> = {
      signal: controller.signal,
      onProgress: (event: WorkerProgress) => {
        send({ type: 'progress', runId, event });
      },
    };
    if (options.fromStep !== undefined) runOptions.fromStep = options.fromStep;
    if (options.toStep !== undefined) runOptions.toStep = options.toStep;
    if (options.onlySteps !== undefined) runOptions.onlySteps = options.onlySteps;
    if (options.force !== undefined) runOptions.force = options.force;
    if (options.syncMode !== undefined) {
      runOptions.config = { syncMode: options.syncMode };
    }

    const result = (await runPipeline(project, runOptions)) as RawRunResult;
    send({ type: 'finished', runId, payload: toFinishedPayload(result) });
  } catch (error) {
    send({ type: 'failed', runId, error: toErrorLike(error) });
  } finally {
    current = undefined;
  }
}

process.on('message', (raw: unknown) => {
  const message = raw as WorkerInbound;
  if (message?.type === 'start') {
    void start(message);
    return;
  }
  if (message?.type === 'cancel') {
    // runId が一致するときだけ止める（取り違え防止）。
    if (current && current.runId === message.runId) {
      current.controller.abort();
    }
  }
});

send({ type: 'ready' });
