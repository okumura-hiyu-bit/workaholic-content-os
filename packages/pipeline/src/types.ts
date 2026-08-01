/**
 * パイプラインの型定義。
 *
 * ★このファイル、およびこのパッケージ全体は React / Electron / DOM /
 * 画面状態を一切importしない。CLIからもGUIからも同じ関数を呼べることを
 * 保証する境界がここ。
 *
 * @see docs/14-pipeline.md
 */

import type {
  AnalysisLayer,
  Project,
  ProjectAsset,
  SyncOffset,
} from '@contentos/core/project';
import type { SyncMode } from '@contentos/editing/build-project';

// ─── 工程ID ────────────────────────────────────────────

export const PIPELINE_STEP_IDS = [
  'validate-project',
  'probe-media',
  'extract-audio',
  'sync-media',
  'correct-audio',
  'transcribe',
  'detect-speakers',
  'generate-subtitles',
  'generate-chapters',
  'generate-camera-plan',
  'generate-markers',
  'extract-short-candidates',
  'generate-premiere-xml',
  'save-artifacts',
  'save-project',
] as const;

export type PipelineStepId = (typeof PIPELINE_STEP_IDS)[number];

export const PIPELINE_STEP_LABELS: Record<PipelineStepId, string> = {
  'validate-project': 'プロジェクト検証',
  'probe-media': '素材情報取得',
  'extract-audio': '音声抽出',
  'sync-media': '音声同期',
  'correct-audio': '音声補正',
  transcribe: '文字起こし',
  'detect-speakers': '話者判定',
  'generate-subtitles': '字幕生成',
  'generate-chapters': 'チャプター生成',
  'generate-camera-plan': 'カメラ切替案生成',
  'generate-markers': 'マーカー生成',
  'extract-short-candidates': 'ショート候補の一次抽出',
  'generate-premiere-xml': 'Premiere用XML生成',
  'save-artifacts': '成果物の保存',
  'save-project': 'プロジェクトJSONの更新',
};

// ─── 状態 ──────────────────────────────────────────────

export type PipelineStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'warning'
  | 'failed'
  | 'skipped'
  | 'cancelled';

// ─── エラー ────────────────────────────────────────────

/**
 * ユーザー向けメッセージと開発者向けメッセージを分ける。
 * `userMessage` はそのままGUI/CLIに表示してよい文言にする。
 */
export interface PipelineError {
  code: string;
  stepId: PipelineStepId;
  userMessage: string;
  technicalMessage?: string;
  recoverable: boolean;
  suggestedAction?: string;
}

// ─── 進捗通知 ──────────────────────────────────────────

export interface ProgressEvent {
  stepId: PipelineStepId;
  stepLabel: string;
  /** 実行計画の中でのこの工程の位置（1始まり）。 */
  stepIndex: number;
  stepCount: number;
  /** 0〜1。全工程を通した進捗率。 */
  overallRatio: number;
  /** 0〜1。この工程内での進捗率（不明なら undefined）。 */
  stepRatio?: number;
  status: PipelineStepStatus;
  startedAt?: string;
  elapsedMs?: number;
  warning?: string;
  error?: PipelineError;
  /** 完了時などの一言メッセージ。 */
  message?: string;
}

export type ProgressListener = (event: ProgressEvent) => void;

// ─── 工程の入出力 ──────────────────────────────────────

/** 工程が実際に行った処理を表す。core の AnalysisLayer/SyncState に統合される。 */
export interface StepResult {
  status: 'completed' | 'warning';
  warnings?: string[];
  /** この工程が更新する解析レイヤーの一部。 */
  analysisPatch?: Partial<AnalysisLayer>;
  /** sync-media のみが更新する。 */
  syncOffsetsPatch?: Record<string, SyncOffset>;
  /** probe-media のみが更新する。素材一覧の全置き換え（IDは変えない）。 */
  assetsPatch?: ProjectAsset[];
  /** 書き出したファイル（プロジェクトルートからの相対パス）。 */
  outputFiles?: string[];
  toolVersions?: Record<string, string>;
  /** 工程内の細かい時間内訳（ミリ秒）。文字起こしのモデル読込等。 */
  timings?: Record<string, number>;
  message?: string;
}

export interface StepContext {
  /** 実行開始時点のプロジェクト（読み取り専用の元データ：素材一覧・edits等）。 */
  readonly project: Project;
  /**
   * ここまでの工程で更新された解析結果の作業コピー。
   * 前の工程の出力をそのまま参照できる（同一プロセス内）。
   */
  readonly analysis: AnalysisLayer;
  readonly syncOffsets: Readonly<Record<string, SyncOffset>>;
  readonly syncMode: SyncMode;
  readonly paths: ProjectPaths;
  readonly config: ResolvedPipelineConfig;
  readonly signal: AbortSignal;
  readonly log: (fields: Omit<LogEntry, 'at' | 'stepId'>) => void;
  /** 工程内の進捗（0〜1）を報告する。省略可。 */
  readonly reportStepProgress: (ratio: number) => void;
  readonly now: () => Date;
}

export interface StepDefinition {
  id: PipelineStepId;
  /** この工程が正常に走るために完了していなければならない工程。 */
  deps: readonly PipelineStepId[];
  run: (ctx: StepContext) => Promise<StepResult>;
}

// ─── 実行設定 ──────────────────────────────────────────

export interface TranscribeConfig {
  model: string;
  computeType: string;
  vadFilter: boolean;
  language: string;
}

export interface CorrectAudioConfig {
  enabled: boolean;
  noiseReduction: boolean;
  loudness: boolean;
  targetLufs: number;
}

export interface ShortCandidateConfig {
  minSec: number;
  maxSec: number;
  targetSec: number;
  maxCandidates: number;
}

export interface ResolvedPipelineConfig {
  syncMode: SyncMode;
  transcribe: TranscribeConfig;
  correctAudio: CorrectAudioConfig;
  shortCandidates: ShortCandidateConfig;
}

export const DEFAULT_PIPELINE_CONFIG: ResolvedPipelineConfig = {
  syncMode: 'preserve',
  transcribe: {
    model: 'large-v3',
    computeType: 'int8',
    vadFilter: false,
    language: 'ja',
  },
  correctAudio: {
    enabled: true,
    noiseReduction: true,
    loudness: true,
    targetLufs: -14,
  },
  shortCandidates: {
    minSec: 15,
    maxSec: 90,
    targetSec: 45,
    maxCandidates: 16,
  },
};

// ─── プロジェクトのディレクトリ構成 ────────────────────────

export interface ProjectPaths {
  root: string;
  projectJson: string;
  media: string;
  cache: {
    root: string;
    audio: string;
    waveform: string;
    transcription: string;
    analysis: string;
  };
  exports: {
    root: string;
    premiere: string;
    subtitles: string;
    chapters: string;
    shorts: string;
    reports: string;
  };
  logs: string;
  temp: string;
}

// ─── 実行オプション ────────────────────────────────────

export interface RunPipelineOptions {
  fromStep?: PipelineStepId;
  toStep?: PipelineStepId;
  onlySteps?: readonly PipelineStepId[];
  /** true で計画内すべて強制再実行。配列なら指定工程だけ強制。 */
  force?: boolean | readonly PipelineStepId[];
  config?: Partial<{
    syncMode: SyncMode;
    transcribe: Partial<TranscribeConfig>;
    correctAudio: Partial<CorrectAudioConfig>;
    shortCandidates: Partial<ShortCandidateConfig>;
  }>;
  onProgress?: ProgressListener;
  signal?: AbortSignal;
}

// ─── ログ ──────────────────────────────────────────────

/**
 * 構造化ログの1行。★許可されたフィールドしか持てない型にすることで、
 * APIキー・音声内容・字幕全文・文字起こし全文が誤って混入するのを防ぐ。
 */
export interface LogEntry {
  at: string;
  stepId: PipelineStepId;
  event: 'start' | 'finish' | 'warning' | 'error';
  durationMs?: number;
  /** ファイル名のみ（basename）。パス・内容は含めない。 */
  inputFileNames?: string[];
  success?: boolean;
  warningCount?: number;
  errorCode?: string;
  toolVersions?: Record<string, string>;
}

// ─── 実行結果 ──────────────────────────────────────────

export interface StepOutcome {
  stepId: PipelineStepId;
  status: PipelineStepStatus;
  durationMs?: number;
  warnings: string[];
  error?: PipelineError;
  outputFiles?: string[];
  timings?: Record<string, number>;
}

export interface ReattachedEditReport {
  kind: string;
  fromId: string;
  toId: string;
  deltaSec: number;
}

export interface OrphanedEditReport {
  kind: string;
  originalId: string;
  approxSec?: number;
  reason: string;
}

/** 人間の修正と、新しい解析結果が同じ要素を指しているが内容が変わった場合。 */
export interface ConflictedEditReport {
  kind: string;
  id: string;
  /** 編集前（前回解析時点）の解析値。 */
  previousAnalysisValue: unknown;
  /** 今回の解析値。 */
  currentAnalysisValue: unknown;
  /** 人間の修正内容（そのまま適用される）。 */
  humanEdit: unknown;
}

export interface ResolveDiffReport {
  reconnected: ReattachedEditReport[];
  orphaned: OrphanedEditReport[];
  conflicted: ConflictedEditReport[];
  /** 新しく増えた解析項目のID。 */
  added: string[];
  /** 前回はあったが今回は無くなった解析項目のID。 */
  removed: string[];
}

export interface RunPipelineResult {
  project: Project;
  outcomes: StepOutcome[];
  cancelled: boolean;
  resolveDiff?: ResolveDiffReport;
}
