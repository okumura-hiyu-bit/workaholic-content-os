/**
 * 復旧画面（Recovery）のDTO。
 *
 * ★何のための画面か（2026-08-09 / Step 10）
 * 4つの確認画面（字幕・ショート候補・カメラ切替・マーカー）は、それぞれの
 * 「要確認」セクションに警告を出している。しかし編集者は**4画面を順に開いて
 * 初めて全体が分かる**状態だった。再解析のたびに、どこに何が起きたのかを
 * 画面をまたいで探し回ることになる。この画面はそれを1本の一覧にまとめる。
 *
 * ★責務は「表示・付け替え・破棄」まで（Step 10 で確定）。
 * 再出力はしない。カメラ切替の整合性チェック（重なり・尺超過でXMLを壊さない）を
 * 迂回してしまうため、書き出しは各Review画面の責務のまま残す。
 * 「確認済み」の記録も持たない。記録するには packages/core の `EditsLayer` に
 * 新しいフィールドが要り、変更禁止の資産に手を入れることになる。
 *
 * ★実測に基づく設計（2026-08-09）
 * `packages/core` の `matchEdits` は**ID完全一致を時刻での再接続より先に**
 * 評価する。したがって `edits` のキーを実在するIDへ移し替えるだけで、
 * 孤立した修正はその要素へ適用される（実測で確認：orphaned=1 → 0、
 * `reattached` にも載らず「元からそのID宛だった」扱いになる）。
 * この画面の「付け替え」はそれだけを行う。packages/ には一切触れない。
 */

import type { ProjectSummary, SafePipelineError } from './dto.ts';
import type { ReviewMedia } from './review-dto.ts';

// ─── 対象と種別 ────────────────────────────────────────

/**
 * どの確認画面のものか。
 *
 * ★`chapter` は含めない。`resolveProject` は章の孤立も返すが、
 * 章に対応するReview画面がまだ無く、付け替え先を選ばせられないため。
 */
export type RecoveryDomain = 'subtitle' | 'short' | 'cameraShot' | 'marker';

export const RECOVERY_DOMAINS: readonly RecoveryDomain[] = [
  'subtitle',
  'short',
  'cameraShot',
  'marker',
] as const;

/**
 * 要確認の種別。
 *
 * ★実測で分かった分布（4画面すべてに出るのは `orphaned` だけ）
 *   orphaned     : 字幕・ショート・カメラ・マーカー
 *   reattached   : 字幕（★従来どこにも表示していなかった）・カメラ・マーカー
 *                  ショートはIDに時刻を含まないため原理的に発生しない
 *   kindMismatch : マーカーのみ
 *   rangeChanged : ショートのみ
 *   conflicted   : 字幕のみ
 */
export type RecoveryKind =
  | 'orphaned'
  | 'reattached'
  | 'kindMismatch'
  | 'rangeChanged'
  | 'conflicted';

export const RECOVERY_KINDS: readonly RecoveryKind[] = [
  'orphaned',
  'reattached',
  'kindMismatch',
  'rangeChanged',
  'conflicted',
] as const;

// ─── 一覧 ──────────────────────────────────────────────

/**
 * 一覧の1行。★4ドメインを同じ形に正規化する。
 *
 * ★表示文言（`headline` / `body` / `detail`）は Main が組み立てる。
 * 4画面の既存の「要確認」セクションと同じ方針（Rendererに文面を持たせない）。
 */
export interface RecoveryItem {
  /** 一覧の安定キー。`${domain}:${kind}:${sourceId}`。 */
  key: string;
  domain: RecoveryDomain;
  kind: RecoveryKind;
  /**
   * 操作の対象。
   * `orphaned` は `edits` 側のキー（解析結果には存在しない）。
   * それ以外は現在の要素のID。
   */
  sourceId: string;
  /** 分かる場合の概算時刻。IDに時刻を含まないもの（ショート・CHECK系）は undefined。 */
  approxSec?: number;
  /** 見出し。何が起きたかを1行で。 */
  headline: string;
  /** 失われかけている／確認すべき中身。 */
  body?: string;
  /** `resolveProject` の reason など、判断の根拠。 */
  detail?: string;
  /**
   * 付け替えできるか。
   * ★`orphaned` だけ true。他は既に要素へ適用済みなので、取れる操作は破棄のみ。
   */
  reattachable: boolean;
}

/** 付け替え先の候補。 */
export interface RecoveryTarget {
  id: string;
  startSec: number;
  /** 一覧に出す短い説明（字幕なら本文、マーカーなら種別と名前）。 */
  label: string;
  /** 元の概算時刻からの差。概算時刻が無い場合は undefined。 */
  deltaSec?: number;
  /**
   * ★既に修正が付いている＝付け替え先に選べない。
   *
   * `matchEdits` は1つの要素に2つの修正を付けない（`taken` で排他）。
   * ここを無視して付け替えると、先にあった修正が押し出されて孤立する。
   */
  occupied: boolean;
}

export interface RecoveryCounts {
  total: number;
  /** 付け替えで直せる件数（＝ `orphaned` の件数）。 */
  reattachable: number;
  byDomain: Record<RecoveryDomain, number>;
  byKind: Record<RecoveryKind, number>;
}

export interface RecoveryData {
  summary: ProjectSummary;
  /** 競合更新の検出に使うリビジョン値。 */
  updatedAt: string;
  items: RecoveryItem[];
  counts: RecoveryCounts;
  /** 再生用プレビュー。★4画面と同じ型を使う。 */
  media?: ReviewMedia;
}

export type RecoveryLoadResult =
  | { ok: true; data: RecoveryData }
  | { ok: false; error: SafePipelineError };

// ─── 付け替え先の候補 ──────────────────────────────────

export interface RecoveryTargetsRequest {
  projectPath: string;
  domain: RecoveryDomain;
  sourceId: string;
}

export type RecoveryTargetsResult =
  | { ok: true; targets: RecoveryTarget[] }
  | { ok: false; error: SafePipelineError };

// ─── 付け替え・破棄 ────────────────────────────────────

export interface RecoveryReattachRequest {
  projectPath: string;
  domain: RecoveryDomain;
  /** `edits` 側の現在のキー。 */
  sourceId: string;
  /** 付け替え先の要素ID。 */
  targetId: string;
  expectedUpdatedAt: string;
}

export interface RecoveryDiscardRequest {
  projectPath: string;
  domain: RecoveryDomain;
  sourceId: string;
  expectedUpdatedAt: string;
}

/**
 * 付け替え・破棄の結果。
 *
 * ★保存後に読み直した一覧をそのまま返す。件数だけ返すと、直したはずの項目が
 * 消えていないことに画面が気づけない。
 */
export type RecoverySaveResult =
  | { ok: true; updatedAt: string; items: RecoveryItem[]; counts: RecoveryCounts }
  | { ok: false; conflict: true; error: SafePipelineError }
  | { ok: false; conflict?: false; error: SafePipelineError };
