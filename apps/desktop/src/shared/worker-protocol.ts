/**
 * Main ⇄ 解析専用プロセス のメッセージ契約。
 *
 * ★Renderer には出さない（Node同士の内部プロトコル）。
 * この経路には technicalMessage を載せてよい。Mainが構造化ログに残すため。
 * Renderer へ渡す直前に main/ipc.ts が toSafeError() で落とす。
 *
 * ★載せないもの（重要）
 * RunPipelineResult.project は文字起こし全文・字幕全文を含むため、
 * まるごと送らない。ワーカー側で件数とファイル名だけに落としてから送る。
 */

import type { PipelineErrorLike } from './errors.ts';
import type { StepId, StepStatus, SyncModeDto } from './steps.ts';

export interface WorkerRunOptions {
  fromStep?: StepId;
  toStep?: StepId;
  onlySteps?: StepId[];
  syncMode?: SyncModeDto;
  force?: boolean;
}

export type WorkerInbound =
  | {
      type: 'start';
      runId: string;
      /** project.json があるディレクトリ。 */
      projectPath: string;
      /** リポジトリルート。dist/ と scripts/ と .venv の解決基準。 */
      projectRoot: string;
      options: WorkerRunOptions;
    }
  | { type: 'cancel'; runId: string };

export interface WorkerProgress {
  stepId: StepId;
  stepLabel: string;
  stepIndex: number;
  stepCount: number;
  overallRatio: number;
  stepRatio?: number;
  status: StepStatus;
  elapsedMs?: number;
  warning?: string;
  message?: string;
  error?: PipelineErrorLike;
}

export interface WorkerStepOutcome {
  stepId: StepId;
  status: StepStatus;
  durationMs?: number;
  warnings: string[];
  error?: PipelineErrorLike;
}

export interface WorkerFinishedPayload {
  cancelled: boolean;
  outcomes: WorkerStepOutcome[];
  /** 各工程が返した成果物のパス（実測では絶対パス）。 */
  outputFiles: string[];
  orphanedCount: number;
  conflictedCount: number;
}

export type WorkerOutbound =
  | { type: 'ready' }
  | { type: 'progress'; runId: string; event: WorkerProgress }
  | { type: 'finished'; runId: string; payload: WorkerFinishedPayload }
  | { type: 'failed'; runId: string; error: PipelineErrorLike };
