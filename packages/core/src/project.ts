/**
 * プロジェクトのデータモデル。
 *
 * ★最重要の設計判断：解析結果（analysis）と人間の修正（edits）を別レイヤーに置く。
 *
 * 再解析は analysis を丸ごと差し替えるが、edits には一切触れない。
 * これにより「素材を差し替えて再解析したら手直しが全部消えた」という事故が
 * 構造的に起こり得ない。両者を突き合わせて実際の値を得るのは resolveProject()。
 *
 * @see docs/13-gui-mvp.md
 */

import type { SyncMode } from '@contentos/editing/build-project';
import type {
  CameraShot,
  EmphasisPoint,
  LaughterSegment,
  MarkerKind,
  Speaker,
  SpeechSegment,
  Word,
} from '@contentos/editing/types';

/** 保存形式のバージョン。読み込み時の移行判断に使う。 */
export const PROJECT_SCHEMA_VERSION = 1;

export const ASSET_ROLES = [
  'wide',
  'cam_A',
  'cam_B',
  'cam_C',
  'mic_A',
  'mic_B',
  'mic_C',
  'bgm',
  'opening',
  'ending',
  'thumbnail',
  'other',
] as const;

export type AssetRole = (typeof ASSET_ROLES)[number];

/** 素材1つ。ffprobeで読んだ情報を保持する。 */
export interface ProjectAsset {
  id: string;
  role: AssetRole;
  /** ★絶対パス。動画はクラウドに上げず、ローカル／外付けSSDに置く。 */
  absolutePath: string;
  fileName: string;
  durationSec: number;
  fps?: number;
  width?: number;
  height?: number;
  audioChannels?: number;
  audioSampleRate?: number;
  hasVideo: boolean;
  hasAudio: boolean;
  /** 素材が差し替えられたことを検知するための情報。 */
  sizeBytes?: number;
  mtimeMs?: number;
}

export const PROJECT_STATUSES = [
  '素材準備中',
  '解析中',
  '確認待ち',
  '修正中',
  '書き出し済み',
  'アーカイブ',
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export interface SyncOffset {
  offsetSec: number;
  confidence: number;
  /** false なら人の確認が必要。確認画面で警告を出す。 */
  reliable: boolean;
}

export interface SyncState {
  mode: SyncMode;
  /** assetId → オフセット。 */
  offsets: Record<string, SyncOffset>;
}

// ─── 解析結果の要素（すべて安定IDを持つ）──────────────────────
//
// IDは時刻から決定的に作る（例: sub-001234 = 開始1.234秒）。
// 再解析で時刻が少しずれてもIDが近い値になるため、人間の修正を
// 時刻の近さで再接続できる（resolveProject の照合）。

export interface IdentifiedSubtitleCue {
  id: string;
  startSec: number;
  endSec: number;
  lines: string[];
  speakerId?: string;
  /** 認識の確からしさが低い語（確認画面で色を変えて示す）。 */
  lowConfidenceWords?: { text: string; probability: number }[];
}

export interface IdentifiedCameraShot extends CameraShot {
  id: string;
}

export interface IdentifiedMarker {
  id: string;
  kind: MarkerKind;
  startSec: number;
  endSec?: number;
  name: string;
  comment: string;
}

/**
 * チャプター。
 *
 * editing の `Chapter` はRSS配信用に `startTime` を使うため、そちらとは
 * 別の型にする。時刻の単位を取り違えないよう、ここでは一貫して `startSec`。
 */
export interface IdentifiedChapter {
  id: string;
  startSec: number;
  title: string;
}

/** ショート候補（区間の選定はローカル処理で決定的に行う）。 */
export interface IdentifiedShortCandidate {
  id: string;
  startSec: number;
  endSec: number;
  /** 一次抽出のスコア。 */
  score: number;
  /** 加点の根拠。編集者が採否を判断するために必ず出す。 */
  signals: string[];
  primarySpeakerId?: string;
  /** 区間内の文字起こし（APIに送るのはここだけ）。 */
  transcriptExcerpt?: string;
}

/** 自動補正しないが知らせる情報（クリッピング・同期の信頼度低下など）。 */
export interface AnalysisCheck {
  id: string;
  severity: 'info' | 'warning' | 'error';
  /** 対象（assetId など）。 */
  target?: string;
  startSec?: number;
  message: string;
}

/**
 * 解析レイヤー。★再解析で丸ごと差し替えられる。
 * 人間の修正をここに書き込んではならない。
 */
export interface AnalysisLayer {
  generatedAt: string;
  /**
   * 解析の入力の指紋。素材とオプションが同じなら同じ値になる。
   * 再解析が必要かの判断と、APIキャッシュのキーに使う。
   */
  fingerprint: string;
  speakers: Speaker[];
  transcript?: {
    language: string;
    model: string;
    vadFilter: boolean;
    words: (Word & { probability?: number })[];
    segments: { startSec: number; endSec: number; text: string }[];
  };
  speech: SpeechSegment[];
  /** 相槌。★カメラ切替の対象にしない。 */
  backchannels: SpeechSegment[];
  overlaps: { startSec: number; endSec: number; speakerIds: string[] }[];
  laughter: LaughterSegment[];
  /** キーワード一致から作った強調ポイント（ローカル・決定的）。強調字幕の元。 */
  emphasis: EmphasisPoint[];
  subtitles: IdentifiedSubtitleCue[];
  chapters: IdentifiedChapter[];
  markers: IdentifiedMarker[];
  cameraShots: IdentifiedCameraShot[];
  shortCandidates: IdentifiedShortCandidate[];
  checks: AnalysisCheck[];
}

// ─── AI評価レイヤー（APIの出力。解析とも人間修正とも別）──────────

export interface ShortAiReview {
  shortId: string;
  rank: number;
  rationale: string;
  targetAudience?: string;
  hook?: string;
  suggestedTitle?: string;
  /** 15秒 / 30秒 / 60秒 のどれに向くか。 */
  lengthFit?: { sec15: number; sec30: number; sec60: number };
  /** 前後の文脈がないと理解できないと判定されたか。 */
  contextInsufficient?: boolean;
  /** 誤解・炎上のリスク。低いほど安全。 */
  riskLevel?: 'low' | 'medium' | 'high';
  riskNote?: string;
}

export interface GeneratedMetadata {
  titleOptions?: string[];
  youtubeDescription?: string;
  summary?: string;
  chapterTitles?: Record<string, string>;
  captions?: Record<string, { text: string; hashtags: string[] }>;
}

/** APIの出力。★人間が採用するまでは提案に留まる。 */
export interface AiLayer {
  generatedAt?: string;
  /** どの解析結果に対する評価か。fingerprint が変われば作り直す。 */
  analysisFingerprint?: string;
  provider?: string;
  model?: string;
  shortReviews: ShortAiReview[];
  metadata?: GeneratedMetadata;
}

// ─── 人間の修正レイヤー（★上書きされない）─────────────────────

export interface SubtitleEdit {
  text?: string;
  speakerId?: string;
  deleted?: boolean;
}

export interface CameraShotOverride {
  cameraId?: string;
  startSec?: number;
  endSec?: number;
}

export interface ShortDecision {
  /** 採用 / 不採用。未設定は「未判断」。 */
  adopted?: boolean;
  title?: string;
  hook?: string;
  caption?: string;
  hashtags?: string[];
  note?: string;
}

export interface EditHistoryEntry {
  at: string;
  actor: string;
  kind: 'subtitle' | 'cameraShot' | 'chapter' | 'marker' | 'short' | 'sync';
  targetId: string;
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * 人間の修正レイヤー。
 * ★再解析で消してはならない。解析結果と突き合わせて使う。
 */
export interface EditsLayer {
  /** 字幕ID → 修正内容。 */
  subtitles: Record<string, SubtitleEdit>;
  cameraShots: {
    overrides: Record<string, CameraShotOverride>;
    /** 人が追加したカット。 */
    inserted: IdentifiedCameraShot[];
    deletedIds: string[];
  };
  chapters: Record<string, { title?: string; deleted?: boolean }>;
  markers: Record<string, { name?: string; comment?: string; deleted?: boolean }>;
  shorts: Record<string, ShortDecision>;
  /** 同期オフセットを人が直した場合。 */
  syncOffsets: Record<string, number>;
  history: EditHistoryEntry[];
}

export function emptyEdits(): EditsLayer {
  return {
    subtitles: {},
    cameraShots: { overrides: {}, inserted: [], deletedIds: [] },
    chapters: {},
    markers: {},
    shorts: {},
    syncOffsets: {},
    history: [],
  };
}

// ─── API使用量 ──────────────────────────────────────────

export interface ApiUsageEntry {
  at: string;
  provider: string;
  model: string;
  /** 何のための呼び出しか。 */
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  /** 円。プロバイダーの単価表から算出する。 */
  costJpy: number;
  /** キャッシュから返した場合は true（費用は0）。 */
  cached: boolean;
}

export interface ApiUsage {
  entries: ApiUsageEntry[];
  /** プロジェクト累計（円）。 */
  totalJpy: number;
}

export function emptyApiUsage(): ApiUsage {
  return { entries: [], totalJpy: 0 };
}

// ─── 書き出し履歴 ────────────────────────────────────────

export interface ExportRecord {
  at: string;
  /** 出力先ディレクトリ。 */
  outputDir: string;
  files: string[];
  syncMode: SyncMode;
  /** どの解析結果から書き出したか。 */
  analysisFingerprint?: string;
  note?: string;
}

// ─── パイプライン実行状態（再開・キャッシュの根拠）─────────────────
//
// ステップIDの実体（15工程のリテラル型）は packages/pipeline が定義する。
// core はそれに依存しない方向を保つため、ここでは汎用の文字列キーで持つ。

export type PipelineStepRunStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'warning'
  | 'failed'
  | 'skipped'
  | 'cancelled';

/**
 * 1工程ぶんの実行記録。★これが再開・キャッシュ判定の根拠になる。
 *
 * inputHash / configHash が前回と一致し、status が completed/warning なら、
 * その工程は次回実行時にスキップできる（force指定が無い限り）。
 */
export interface StepRecord {
  status: PipelineStepRunStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** 素材や依存工程の出力から計算した入力の指紋。 */
  inputHash?: string;
  /** この工程に渡された設定（モデル名・syncMode等）の指紋。 */
  configHash?: string;
  /** この工程が生み出した内容の指紋。下流工程の入力ハッシュに連鎖する。 */
  outputHash?: string;
  warnings: string[];
  errorCode?: string;
  errorMessage?: string;
  toolVersions?: Record<string, string>;
  /** 書き出したファイル（プロジェクトルートからの相対パス）。 */
  outputFiles?: string[];
  /** 工程内の細かい時間内訳（文字起こしのモデル読込等）。単位ミリ秒。 */
  timings?: Record<string, number>;
}

export interface PipelineState {
  /** ステップID → 実行記録。 */
  steps: Record<string, StepRecord>;
  lastRunAt?: string;
  /** 直近の実行が最後まで完了せず中断されたか。 */
  lastRunCancelled?: boolean;
}

export function emptyPipelineState(): PipelineState {
  return { steps: {} };
}

export function emptyStepRecord(): StepRecord {
  return { status: 'pending', warnings: [] };
}

// ─── プロジェクト全体 ─────────────────────────────────────

export interface Project {
  schemaVersion: number;
  id: string;
  /** 案件名。 */
  name: string;
  recordedAt?: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  /** 素材の置き場（外付けSSDのパスなど）。 */
  rootDir: string;
  assets: ProjectAsset[];
  sync: SyncState;
  /** 出演者の名前と役割（brief由来）。 */
  speakers: Speaker[];
  /** 番組・回のテーマ（brief由来。文字起こしの語彙ヒント・短尺候補の判定に使う）。 */
  theme?: string;
  /** 拾いたいキーワード（brief由来）。 */
  keywords?: string[];
  /** 未解析なら undefined。 */
  analysis?: AnalysisLayer;
  ai: AiLayer;
  edits: EditsLayer;
  apiUsage: ApiUsage;
  exports: ExportRecord[];
  /** パイプラインの実行状態（再開・キャッシュの根拠）。 */
  pipeline: PipelineState;
}

/** 新規プロジェクトを作る。 */
export function createProject(input: {
  id: string;
  name: string;
  rootDir: string;
  recordedAt?: string;
  theme?: string;
  keywords?: string[];
  now?: Date;
}): Project {
  const now = (input.now ?? new Date()).toISOString();
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: input.id,
    name: input.name,
    recordedAt: input.recordedAt,
    theme: input.theme,
    keywords: input.keywords,
    status: '素材準備中',
    createdAt: now,
    updatedAt: now,
    rootDir: input.rootDir,
    assets: [],
    sync: { mode: 'preserve', offsets: {} },
    speakers: [],
    ai: { shortReviews: [] },
    edits: emptyEdits(),
    apiUsage: emptyApiUsage(),
    exports: [],
    pipeline: emptyPipelineState(),
  };
}

// ─── ID生成（時刻から決定的に作る）────────────────────────────

/** 時刻をミリ秒に丸めた6桁のキーにする。 */
function timeKey(seconds: number): string {
  return String(Math.max(0, Math.round(seconds * 1000))).padStart(8, '0');
}

export function subtitleId(startSec: number): string {
  return `sub-${timeKey(startSec)}`;
}

export function cameraShotId(startSec: number): string {
  return `shot-${timeKey(startSec)}`;
}

export function markerId(kind: MarkerKind, startSec: number): string {
  return `mk-${kind}-${timeKey(startSec)}`;
}

export function chapterId(startSec: number): string {
  return `ch-${timeKey(startSec)}`;
}

/** IDから時刻（秒）を取り出す。人間修正の再接続で使う。 */
export function timeFromId(id: string): number | undefined {
  const match = id.match(/(\d{8})$/);
  if (!match) return undefined;
  return Number.parseInt(match[1]!, 10) / 1000;
}

/** 不足している素材の役割を返す。素材登録画面の警告に使う。 */
export function missingRoles(
  assets: readonly ProjectAsset[],
  speakerIds: readonly string[],
): AssetRole[] {
  const present = new Set(assets.map((a) => a.role));
  const required: AssetRole[] = ['wide'];

  for (const speakerId of speakerIds) {
    required.push(`cam_${speakerId}` as AssetRole);
    required.push(`mic_${speakerId}` as AssetRole);
  }

  return required.filter(
    (role) => ASSET_ROLES.includes(role) && !present.has(role),
  );
}
