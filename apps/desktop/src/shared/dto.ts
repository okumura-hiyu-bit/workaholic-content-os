/**
 * Main ⇄ Preload ⇄ Renderer を流れるデータの型。
 *
 * ★ここに置いてよいのは「構造化クローンで送れるプレーンな値」だけ。
 * Error / AbortSignal / 関数 / クラスインスタンスは絶対に含めない
 * （Electronのipcは構造化クローンで送るため、送れないものは例外になる。
 * それ以前に、Rendererへ渡してよい情報の範囲をこの型で固定する）。
 *
 * ★載せない情報（意図的な除外）
 * - technicalMessage / stack trace … 開発者向け。構造化ログにのみ残す
 * - 文字起こし全文 / 字幕全文 / 音声内容 … 画面表示に不要
 * - APIキー … そもそもMainが保持しない
 */

import type { StepId, StepStatus, SyncModeDto } from './steps.ts';
import type {
  CreateProjectRequest,
  CreateProjectResult,
  DroppedFile,
  ProjectListResult,
  RemoveAssetRequest,
  SetupLoadResult,
  SetupSaveResult,
  UpdateAssetRequest,
} from './setup-dto.ts';
import type {
  RemoveShortDecisionRequest,
  SaveShortDecisionResult,
  ShortsExportRequest,
  ShortsExportResult,
  ShortsLoadResult,
  UpdateShortDecisionRequest,
} from './shorts-dto.ts';
import type {
  OpenMediaResult,
  RemoveSubtitleEditRequest,
  ReviewExportRequest,
  ReviewExportResult,
  ReviewLoadResult,
  SaveSubtitleEditResult,
  UpdateSubtitleEditRequest,
} from './review-dto.ts';

// ─── エラー ────────────────────────────────────────────

/**
 * Rendererへ渡してよい形に落としたエラー。
 * `PipelineError` から technicalMessage を落としたもの。
 */
export interface SafePipelineError {
  code: string;
  stepId?: string;
  userMessage: string;
  recoverable: boolean;
  suggestedAction?: string;
}

// ─── プロジェクト ──────────────────────────────────────

export interface ProjectSummary {
  /** project.json が置かれているディレクトリの絶対パス。 */
  projectPath: string;
  projectId: string;
  name: string;
  status: string;
  assetCount: number;
  updatedAt: string;
  recordedAt?: string;
  /** スキーマ移行や欠損補完を行った場合の説明。画面に出して知らせる。 */
  notes: string[];
}

export type ProjectSelectionResult =
  | { ok: true; summary: ProjectSummary }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'invalid'; error: SafePipelineError };

export type ReadProjectSummaryResult =
  | { ok: true; summary: ProjectSummary }
  | { ok: false; error: SafePipelineError };

// ─── 解析の開始・中止 ──────────────────────────────────

export interface StartPipelineRequest {
  projectPath: string;
  fromStep?: StepId;
  toStep?: StepId;
  onlySteps?: StepId[];
  syncMode?: SyncModeDto;
  force?: boolean;
}

export type PipelineStartResult =
  | { ok: true; runId: string }
  | { ok: false; error: SafePipelineError };

export type CancelPipelineResult =
  | { ok: true }
  | { ok: false; error: SafePipelineError };

// ─── 進捗・完了 ────────────────────────────────────────

/**
 * `@contentos/pipeline` の ProgressEvent に runId を足しただけのもの。
 * 値はすべてプレーン。
 */
export interface PipelineProgressEvent {
  runId: string;
  stepId: StepId;
  stepLabel: string;
  stepIndex: number;
  stepCount: number;
  /** 0〜1。全工程を通した進捗率。 */
  overallRatio: number;
  /** 0〜1。この工程内での進捗率（不明なら undefined）。 */
  stepRatio?: number;
  status: StepStatus;
  elapsedMs?: number;
  warning?: string;
  message?: string;
  error?: SafePipelineError;
}

export type RunOutcome = 'completed' | 'warning' | 'failed' | 'cancelled';

export interface StepOutcomeDto {
  stepId: StepId;
  status: StepStatus;
  durationMs?: number;
  warnings: string[];
  error?: SafePipelineError;
}

export interface PipelineFinishedEvent {
  runId: string;
  outcome: RunOutcome;
  counts: {
    completed: number;
    warning: number;
    failed: number;
    skipped: number;
    cancelled: number;
  };
  steps: StepOutcomeDto[];
  warnings: string[];
  /**
   * 生成された成果物のパス。
   * ★実測では絶対パスが返る（工程が返した値をそのまま運ぶ）。
   * 画面側でプロジェクトフォルダからの相対表記に短縮して表示する。
   */
  outputFiles: string[];
  /** 再接続できなかった人間修正の件数。 */
  orphanedCount: number;
  /** 解析結果と人間修正が衝突した件数。 */
  conflictedCount: number;
  durationMs: number;
  error?: SafePipelineError;
}

// ─── Preloadが公開するAPI ──────────────────────────────

export interface ContentOsDesktopApi {
  selectProject(): Promise<ProjectSelectionResult>;
  readProjectSummary(projectPath: string): Promise<ReadProjectSummaryResult>;
  startPipeline(request: StartPipelineRequest): Promise<PipelineStartResult>;
  cancelPipeline(runId: string): Promise<CancelPipelineResult>;
  openProjectFolder(projectPath: string): Promise<void>;

  /** 確認画面（Review）。今回は字幕のみ。 */
  reviewLoad(projectPath: string): Promise<ReviewLoadResult>;
  reviewUpdateSubtitle(
    request: UpdateSubtitleEditRequest,
  ): Promise<SaveSubtitleEditResult>;
  reviewRemoveSubtitleEdit(
    request: RemoveSubtitleEditRequest,
  ): Promise<SaveSubtitleEditResult>;
  reviewExport(request: ReviewExportRequest): Promise<ReviewExportResult>;
  reviewOpenMedia(projectPath: string): Promise<OpenMediaResult>;

  /**
   * ショート候補の確認・採否。
   * ★再出力は save-artifacts のみ。FCP7 XML は作り直さない。
   */
  shortsLoad(projectPath: string): Promise<ShortsLoadResult>;
  shortsUpdateDecision(
    request: UpdateShortDecisionRequest,
  ): Promise<SaveShortDecisionResult>;
  shortsRemoveDecision(
    request: RemoveShortDecisionRequest,
  ): Promise<SaveShortDecisionResult>;
  shortsExport(request: ShortsExportRequest): Promise<ShortsExportResult>;

  /** プロジェクト一覧・新規作成・素材登録。 */
  listProjects(): Promise<ProjectListResult>;
  createProject(request: CreateProjectRequest): Promise<CreateProjectResult>;
  /** 保存場所を選ぶダイアログ。選ばれた絶対パスだけを返す。 */
  chooseParentDir(): Promise<string | undefined>;
  /** 一覧から外す（project.json も素材も削除しない）。 */
  forgetProject(projectPath: string): Promise<ProjectListResult>;
  loadSetup(projectPath: string): Promise<SetupLoadResult>;
  /** ファイル選択ダイアログで素材を登録する。 */
  chooseAssetFiles(
    projectPath: string,
    expectedUpdatedAt: string,
  ): Promise<SetupSaveResult>;
  /**
   * ドラッグ＆ドロップされたファイルを登録する。
   * ★パスの解決は Preload が webUtils で行い、Renderer には返さない。
   */
  registerDroppedAssets(
    projectPath: string,
    expectedUpdatedAt: string,
    files: readonly DroppedFile[],
  ): Promise<SetupSaveResult>;
  updateAsset(request: UpdateAssetRequest): Promise<SetupSaveResult>;
  removeAsset(request: RemoveAssetRequest): Promise<SetupSaveResult>;

  /** 戻り値は購読解除関数。Reactのアンマウント時に必ず呼ぶこと。 */
  onPipelineProgress(
    listener: (event: PipelineProgressEvent) => void,
  ): () => void;

  /** 戻り値は購読解除関数。Reactのアンマウント時に必ず呼ぶこと。 */
  onPipelineFinished(
    listener: (event: PipelineFinishedEvent) => void,
  ): () => void;
}
