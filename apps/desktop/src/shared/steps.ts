/**
 * 15工程のIDとラベル。
 *
 * ★なぜ @contentos/pipeline から直接importしないのか
 * この一覧はレンダラー（ブラウザ）でも工程一覧の描画に使う。
 * `@contentos/pipeline` は fs / child_process を読み込むNode専用のため、
 * レンダラーのバンドルに入れるわけにいかない。
 *
 * ★ズレはテストで防ぐ
 * この一覧が `@contentos/pipeline` の PIPELINE_STEP_IDS / PIPELINE_STEP_LABELS と
 * 完全一致することを steps.test.ts で検証している（テストはNodeで動くので
 * 本物をimportできる）。工程が増減したらテストが落ちるので、写し間違いや
 * 更新漏れはそこで止まる。
 */

export const STEP_IDS = [
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

export type StepId = (typeof STEP_IDS)[number];

export const STEP_LABELS: Record<StepId, string> = {
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

const STEP_ID_SET: ReadonlySet<string> = new Set<string>(STEP_IDS);

/** 文字列が既知の工程IDかを判定する。IPCの入力検証で使う。 */
export function isStepId(value: unknown): value is StepId {
  return typeof value === 'string' && STEP_ID_SET.has(value);
}

export const STEP_STATUSES = [
  'pending',
  'running',
  'completed',
  'warning',
  'failed',
  'skipped',
  'cancelled',
] as const;

export type StepStatus = (typeof STEP_STATUSES)[number];

export const SYNC_MODES = ['preserve', 'common'] as const;

export type SyncModeDto = (typeof SYNC_MODES)[number];

export function isSyncMode(value: unknown): value is SyncModeDto {
  return value === 'preserve' || value === 'common';
}
