/**
 * 解析の実行管理。二重実行防止と、解析専用プロセスの生存管理。
 *
 * ★run-pipeline.ts は変更しない。
 * 排他制御はパイプライン側ではなくこのElectron層だけで行う。
 *
 * ★UI操作に依存しない。
 * ボタンの disabled は「見た目の防止」でしかない。実行中のプロジェクトを
 * Main側の Map / Set で持ち、開始要求そのものを拒否する。
 */

import type {
  PipelineFinishedEvent,
  PipelineProgressEvent,
  PipelineStartResult,
  CancelPipelineResult,
  RunOutcome,
  SafePipelineError,
  StepOutcomeDto,
} from '../shared/dto.ts';
import { DESKTOP_ERROR_CODES, safeError, toSafeError } from '../shared/errors.ts';
import type {
  WorkerFinishedPayload,
  WorkerOutbound,
  WorkerRunOptions,
} from '../shared/worker-protocol.ts';
import type { AnalysisProcess, AnalysisProcessSpawner } from './analysis-process.ts';
import type { StructuredLogger } from './logger.ts';

export interface StartRunInput {
  projectPath: string;
  projectId: string;
  projectRoot: string;
  options: WorkerRunOptions;
}

export interface RunManagerDeps {
  spawn: AnalysisProcessSpawner;
  /** ビルド済みワーカースクリプトの絶対パス。 */
  workerPath: string;
  newRunId(): string;
  now(): number;
  emitProgress(event: PipelineProgressEvent): void;
  emitFinished(event: PipelineFinishedEvent): void;
  logger: StructuredLogger;
  /** 中止要求からプロセス強制終了までの猶予（ミリ秒）。 */
  cancelGraceMs?: number;
}

interface ActiveRun {
  runId: string;
  projectId: string;
  projectPath: string;
  proc: AnalysisProcess;
  startedAt: number;
  /** 中止要求済み。完了イベントが返るまで新規実行を受け付けない。 */
  cancelling: boolean;
  /** 完了イベントを送ったか。exitとの二重送信を防ぐ。 */
  settled: boolean;
  killTimer?: ReturnType<typeof setTimeout>;
}

/** 工程結果から全体の判定を出す。 */
export function decideOutcome(
  payload: WorkerFinishedPayload,
): RunOutcome {
  if (payload.cancelled) return 'cancelled';
  if (payload.outcomes.some((o) => o.status === 'failed')) return 'failed';
  if (
    payload.outcomes.some((o) => o.status === 'warning' || o.warnings.length > 0)
  ) {
    return 'warning';
  }
  return 'completed';
}

/** 解析専用プロセスの完了報告を、Rendererへ渡してよい形にする。 */
export function buildFinishedEvent(
  runId: string,
  payload: WorkerFinishedPayload,
  durationMs: number,
): PipelineFinishedEvent {
  const counts = {
    completed: 0,
    warning: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
  };
  const warnings: string[] = [];
  const steps: StepOutcomeDto[] = [];

  for (const outcome of payload.outcomes) {
    if (outcome.status in counts) {
      counts[outcome.status as keyof typeof counts] += 1;
    }
    warnings.push(...outcome.warnings);

    const dto: StepOutcomeDto = {
      stepId: outcome.stepId,
      status: outcome.status,
      warnings: outcome.warnings,
    };
    if (outcome.durationMs !== undefined) dto.durationMs = outcome.durationMs;
    // ★technicalMessage をここで落とす。
    if (outcome.error !== undefined) dto.error = toSafeError(outcome.error);
    steps.push(dto);
  }

  const failed = steps.find((s) => s.error !== undefined);

  const event: PipelineFinishedEvent = {
    runId,
    outcome: decideOutcome(payload),
    counts,
    steps,
    warnings,
    outputFiles: payload.outputFiles,
    orphanedCount: payload.orphanedCount,
    conflictedCount: payload.conflictedCount,
    durationMs,
  };
  if (failed?.error !== undefined) event.error = failed.error;
  return event;
}

export class RunManager {
  private active: ActiveRun | undefined;

  /** ★実行中プロジェクトの集合。UIの状態に依存しない排他の実体。 */
  private readonly runningProjectIds = new Set<string>();

  /** runId → 実行の索引。中止要求の取り違えを防ぐ。 */
  private readonly runs = new Map<string, ActiveRun>();

  constructor(private readonly deps: RunManagerDeps) {}

  isRunning(): boolean {
    return this.active !== undefined;
  }

  activeRunId(): string | undefined {
    return this.active?.runId;
  }

  isProjectRunning(projectId: string): boolean {
    return this.runningProjectIds.has(projectId);
  }

  start(input: StartRunInput): PipelineStartResult {
    // ★同じプロジェクトかどうかを先に見る。
    // 「別の案件が動いている」と「同じ案件を二度押しした」では利用者の
    // 次の行動が違うので、メッセージを取り違えないようこの順にする。
    if (this.runningProjectIds.has(input.projectId)) {
      const cancelling = this.active?.cancelling === true;
      return {
        ok: false,
        error: safeError(
          DESKTOP_ERROR_CODES.PROJECT_ALREADY_RUNNING,
          cancelling
            ? 'このプロジェクトの解析を中止しています。完了するまでお待ちください。'
            : 'このプロジェクトは既に解析中です。',
          { recoverable: true },
        ),
      };
    }

    if (this.active !== undefined) {
      const message = this.active.cancelling
        ? '解析を中止しています。完了するまでお待ちください。'
        : 'すでに別の解析を実行中です。';
      return {
        ok: false,
        error: safeError(DESKTOP_ERROR_CODES.ALREADY_RUNNING, message, {
          recoverable: true,
          suggestedAction: '実行中の解析が終わってから、もう一度お試しください。',
        }),
      };
    }

    const runId = this.deps.newRunId();
    let proc: AnalysisProcess;
    try {
      proc = this.deps.spawn({
        projectRoot: input.projectRoot,
        workerPath: this.deps.workerPath,
      });
    } catch (error) {
      this.deps.logger.error('解析プロセスの起動に失敗', { runId, error });
      return {
        ok: false,
        error: safeError(
          DESKTOP_ERROR_CODES.ANALYSIS_PROCESS_CRASHED,
          '解析プロセスを起動できませんでした。',
          { recoverable: true },
        ),
      };
    }

    const run: ActiveRun = {
      runId,
      projectId: input.projectId,
      projectPath: input.projectPath,
      proc,
      startedAt: this.deps.now(),
      cancelling: false,
      settled: false,
    };

    this.active = run;
    this.runs.set(runId, run);
    this.runningProjectIds.add(input.projectId);

    proc.onMessage((message) => this.handleMessage(run, message));
    proc.onExit((info) => this.handleExit(run, info));

    proc.send({
      type: 'start',
      runId,
      projectPath: input.projectPath,
      projectRoot: input.projectRoot,
      options: input.options,
    });

    this.deps.logger.info('解析を開始', {
      runId,
      projectId: input.projectId,
      projectRoot: input.projectRoot,
    });

    return { ok: true, runId };
  }

  cancel(runId: string): CancelPipelineResult {
    const run = this.runs.get(runId);
    if (run === undefined || run.settled) {
      return {
        ok: false,
        error: safeError(
          DESKTOP_ERROR_CODES.RUN_NOT_FOUND,
          '中止できる解析が見つかりませんでした。',
          { recoverable: true },
        ),
      };
    }

    run.cancelling = true;
    run.proc.send({ type: 'cancel', runId });
    this.deps.logger.info('解析の中止を要求', { runId });

    // 猶予を過ぎても終わらない場合は強制終了する。
    // （AbortSignalを見ていない箇所で固まっていても、確実に解放するため）
    const grace = this.deps.cancelGraceMs ?? 10_000;
    run.killTimer = setTimeout(() => {
      if (!run.settled) {
        this.deps.logger.error('中止が完了しないためプロセスを強制終了', { runId });
        run.proc.kill();
      }
    }, grace);
    // Node環境でタイマーがプロセス終了を妨げないようにする。
    run.killTimer.unref?.();

    return { ok: true };
  }

  /** アプリ終了時に呼ぶ。実行中の解析を安全に止める。 */
  disposeAll(): void {
    for (const run of this.runs.values()) {
      if (run.settled) continue;
      this.deps.logger.info('アプリ終了により解析を中止', { runId: run.runId });
      run.cancelling = true;
      run.proc.send({ type: 'cancel', runId: run.runId });
      run.proc.kill();
      this.clearTimer(run);
    }
    this.runs.clear();
    this.runningProjectIds.clear();
    this.active = undefined;
  }

  private handleMessage(run: ActiveRun, message: WorkerOutbound): void {
    if (message.type === 'progress') {
      if (run.settled) return;
      const { event } = message;
      const progress: PipelineProgressEvent = {
        runId: run.runId,
        stepId: event.stepId,
        stepLabel: event.stepLabel,
        stepIndex: event.stepIndex,
        stepCount: event.stepCount,
        overallRatio: event.overallRatio,
        status: event.status,
      };
      if (event.stepRatio !== undefined) progress.stepRatio = event.stepRatio;
      if (event.elapsedMs !== undefined) progress.elapsedMs = event.elapsedMs;
      if (event.warning !== undefined) progress.warning = event.warning;
      if (event.message !== undefined) progress.message = event.message;
      // ★technicalMessage を落としてから渡す。
      if (event.error !== undefined) progress.error = toSafeError(event.error);
      this.deps.emitProgress(progress);
      return;
    }

    if (message.type === 'finished') {
      this.settle(
        run,
        buildFinishedEvent(
          run.runId,
          message.payload,
          this.deps.now() - run.startedAt,
        ),
      );
      return;
    }

    if (message.type === 'failed') {
      this.deps.logger.error('解析が失敗', {
        runId: run.runId,
        // ★technicalMessage はログにだけ残す。
        technicalMessage: message.error.technicalMessage,
        code: message.error.code,
      });
      this.settle(run, this.failureEvent(run, toSafeError(message.error)));
    }
  }

  private handleExit(
    run: ActiveRun,
    info: { code: number | null; signal: string | null },
  ): void {
    this.clearTimer(run);
    if (run.settled) {
      this.release(run);
      return;
    }

    // ★完了報告が来ないまま終了した＝異常終了。ここでロックを必ず解放する。
    this.deps.logger.error('解析プロセスが異常終了', {
      runId: run.runId,
      code: info.code,
      signal: info.signal,
    });

    const error = run.cancelling
      ? safeError(DESKTOP_ERROR_CODES.ANALYSIS_PROCESS_CRASHED, '解析を中止しました。', {
          recoverable: true,
        })
      : safeError(
          DESKTOP_ERROR_CODES.ANALYSIS_PROCESS_CRASHED,
          '解析プロセスが予期せず終了しました。',
          {
            recoverable: true,
            suggestedAction: 'もう一度解析を実行してください。',
          },
        );

    const event = this.failureEvent(run, error);
    if (run.cancelling) event.outcome = 'cancelled';
    this.settle(run, event);
  }

  private failureEvent(
    run: ActiveRun,
    error: SafePipelineError,
  ): PipelineFinishedEvent {
    return {
      runId: run.runId,
      outcome: 'failed',
      counts: { completed: 0, warning: 0, failed: 0, skipped: 0, cancelled: 0 },
      steps: [],
      warnings: [],
      outputFiles: [],
      orphanedCount: 0,
      conflictedCount: 0,
      durationMs: this.deps.now() - run.startedAt,
      error,
    };
  }

  private settle(run: ActiveRun, event: PipelineFinishedEvent): void {
    if (run.settled) return;
    run.settled = true;
    this.clearTimer(run);
    this.release(run);
    this.deps.emitFinished(event);
  }

  /** ロックを解放する。★どの終わり方でも必ずここを通す。 */
  private release(run: ActiveRun): void {
    this.runningProjectIds.delete(run.projectId);
    this.runs.delete(run.runId);
    if (this.active?.runId === run.runId) this.active = undefined;
  }

  private clearTimer(run: ActiveRun): void {
    if (run.killTimer !== undefined) {
      clearTimeout(run.killTimer);
      run.killTimer = undefined;
    }
  }
}
