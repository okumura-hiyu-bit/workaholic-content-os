/**
 * プロジェクト一覧・新規作成・素材登録のDTO。
 *
 * ★Rendererへ素材の絶対パスを渡さない。
 * 表示に必要なのはファイル名と親フォルダ名までで、フルパスは要らない。
 * Rendererから任意のパスを受け取ることもしない（登録はMainが解決した
 * パスだけで行う）。
 */

import type { SafePipelineError } from './dto.ts';

// ─── 素材の役割 ────────────────────────────────────────

/**
 * `packages/core` の ASSET_ROLES と同じ並び。
 * ★一致することは setup-dto.test.ts で検証している（レンダラーからは
 * @contentos/core を読めないため写しを持つ）。
 */
export const ASSET_ROLE_IDS = [
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
  'logo',
  'other',
] as const;

export type AssetRoleId = (typeof ASSET_ROLE_IDS)[number];

export const ASSET_ROLE_LABELS: Record<AssetRoleId, string> = {
  wide: '引き（基準映像）',
  cam_A: '寄りカメラ A',
  cam_B: '寄りカメラ B',
  cam_C: '寄りカメラ C',
  mic_A: 'マイク A',
  mic_B: 'マイク B',
  mic_C: 'マイク C',
  bgm: 'BGM',
  opening: 'オープニング',
  ending: 'エンディング',
  thumbnail: 'サムネイル',
  logo: 'ロゴ',
  other: 'その他',
};

/** 出演者・カメラの識別子。3名以上に増えてもここを足すだけで済む形にする。 */
export const SPEAKER_SLOTS = ['A', 'B', 'C'] as const;
export type SpeakerSlot = (typeof SPEAKER_SLOTS)[number];

export function isAssetRoleId(value: unknown): value is AssetRoleId {
  return typeof value === 'string' && (ASSET_ROLE_IDS as readonly string[]).includes(value);
}

// ─── プロジェクト一覧 ──────────────────────────────────

export interface ProjectListEntry {
  /** project.json があるディレクトリ。開く操作にだけ使う。 */
  projectPath: string;
  projectId: string;
  name: string;
  recordedAt?: string;
  status: string;
  assetCount: number;
  /** project.json の更新時刻。 */
  updatedAt: string;
  /** このアプリで最後に開いた時刻。並び順に使う。 */
  lastOpenedAt: string;
  /**
   * ★参照先の project.json が見つからない。
   * 一覧から黙って消さず、理由を出して手動で外せるようにする。
   */
  missing: boolean;
}

export type ProjectListResult =
  | { ok: true; entries: ProjectListEntry[] }
  | { ok: false; error: SafePipelineError };

// ─── 新規作成 ──────────────────────────────────────────

export interface SpeakerInput {
  /** 'A' | 'B' | 'C'。素材の役割（mic_A 等）と対応する。 */
  slot: SpeakerSlot;
  name: string;
  title?: string;
  role: 'host' | 'guest';
}

export interface CreateProjectRequest {
  name: string;
  /** YYYY-MM-DD。 */
  recordedAt: string;
  /** 番組名。Project.theme に入れる。 */
  programName?: string;
  speakers: SpeakerInput[];
  /** 保存先の親ディレクトリ。この下に案件フォルダを作る。 */
  parentDir: string;
  syncMode: 'preserve' | 'common';
}

export type CreateProjectResult =
  | { ok: true; entry: ProjectListEntry }
  | { ok: false; error: SafePipelineError };

// ─── 素材 ──────────────────────────────────────────────

export interface AssetDto {
  id: string;
  role: AssetRoleId;
  fileName: string;
  /** ★親フォルダ名だけ。絶対パスは渡さない。 */
  directoryName: string;
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
  audioChannels?: number;
  audioSampleRate?: number;
  sizeBytes?: number;
  /**
   * ★自動推測した役割（提案）。人が確定するまで `roleConfirmed` は false。
   * 誤推測のまま解析に使わせないため、未確定の素材があると解析を止める。
   */
  suggestedRole?: AssetRoleId;
  roleConfirmed: boolean;
  /** 解析に使うか。false のものは project.assets から外して保持する。 */
  enabled: boolean;
  /** 対応する出演者（`mic_A` → 'A'）。役割から導出した表示用の値。 */
  speakerSlot?: SpeakerSlot;
  /** この素材が文字起こしの音声源になるか（役割から決まる。読み取り専用）。 */
  mainAudio: boolean;
}

export interface SetupSpeakerDto {
  slot: string;
  name: string;
  title?: string;
  role: string;
  /** 対応するマイク素材が登録されているか。 */
  micRegistered: boolean;
  /** 対応する寄りカメラが登録されているか。 */
  cameraRegistered: boolean;
}

/** 解析前チェックの1件。 */
export interface SetupIssue {
  /** error は解析開始不可。warning は人が確認して続行できる。 */
  severity: 'error' | 'warning';
  code: string;
  message: string;
  suggestedAction?: string;
  /** 対象素材（あれば）。 */
  assetId?: string;
}

export interface SetupData {
  projectPath: string;
  projectId: string;
  name: string;
  recordedAt?: string;
  programName?: string;
  status: string;
  updatedAt: string;
  syncMode: 'preserve' | 'common';
  speakers: SetupSpeakerDto[];
  assets: AssetDto[];
  /** 解析に使わない設定にした素材。 */
  disabledAssets: AssetDto[];
  issues: SetupIssue[];
  /** error が1件も無ければ解析を開始できる。 */
  canAnalyze: boolean;
  /** 解析済みかどうか。素材構成を変えるときの警告に使う。 */
  analyzed: boolean;
}

export type SetupLoadResult =
  | { ok: true; data: SetupData }
  | { ok: false; error: SafePipelineError };

/**
 * ドラッグ＆ドロップで受け取るファイル。
 *
 * ★実体はDOMの File だが、この型はPreload（Node向けの型設定）からも
 * 参照するため、DOMの型に依存しない不透明な型にしている。
 * Preload が webUtils.getPathForFile でパスに変換し、Rendererへは返さない。
 */
export type DroppedFile = { readonly name?: unknown };

export interface RegisterAssetsRequest {
  projectPath: string;
  expectedUpdatedAt: string;
}

export interface UpdateAssetRequest {
  projectPath: string;
  expectedUpdatedAt: string;
  assetId: string;
  patch: {
    role?: AssetRoleId;
    enabled?: boolean;
    roleConfirmed?: boolean;
  };
}

export interface RemoveAssetRequest {
  projectPath: string;
  expectedUpdatedAt: string;
  assetId: string;
}

export type SetupSaveResult =
  | { ok: true; data: SetupData; added?: number; skipped?: string[] }
  | { ok: false; conflict: true; error: SafePipelineError }
  | { ok: false; conflict?: false; error: SafePipelineError };
