/**
 * 確認画面（Review）— ショート候補のDTO。
 *
 * 字幕Review（review-dto.ts）と同じ考え方で作る。
 * ★Renderer へ Project 全体を渡さない。画面に出す値だけをここで定義し、
 * 解析の内部データ・文字起こし全文・パイプラインログ・APIキー・
 * 素材の絶対パスは載せない。
 * ★Renderer から Project 全体を送らせない。保存は「どの候補を、どう判断したか」
 * だけを持つ専用DTO（UpdateShortDecisionRequest）で受ける。
 *
 * ★字幕との決定的な違い：ショート候補のIDは `short_01` のような連番で、
 * 時刻を含まない。そのため再解析で候補の並びが変わると `resolveProject` は
 * 時刻による再接続ができず、採否・編集内容が必ず orphaned になる。
 * この性質は仕様なので、画面で常時警告する（ShortsData.reanalysisWarning）。
 */

import type { ProjectSummary, SafePipelineError } from './dto.ts';
import type { ReviewExportRequest, ReviewExportResult, ReviewMedia } from './review-dto.ts';

// ─── 読み込み ──────────────────────────────────────────

export interface ShortsSpeaker {
  id: string;
  name: string;
}

/** 採否。未判断は undefined（ShortDecision.adopted と同じ意味）。 */
export type ShortAdoption = boolean | undefined;

export interface ShortCandidateItem {
  id: string;
  startSec: number;
  endSec: number;
  /** 尺（秒）。画面で15/30/60秒の目安を出すために持たせる。 */
  durationSec: number;
  /** 一次抽出のスコア（ローカル・決定的）。 */
  score: number;
  /** 加点の根拠。編集者が採否を判断するために必ず出す。 */
  signals: string[];
  primarySpeakerId?: string;
  /** 区間の文字起こし抜粋。無い場合もある。 */
  transcriptExcerpt?: string;

  // ─── 人間の判断（edits.shorts を適用した値）───
  /** 採用 / 不採用 / 未判断。 */
  adopted: ShortAdoption;
  title?: string;
  hook?: string;
  caption?: string;
  hashtags?: string[];
  note?: string;
  /** 人が何らかの判断・編集を保存したか。 */
  edited: boolean;

  /**
   * ★判断した時点と比べて候補の区間・スコアが変わっている。
   *
   * IDが残っているので orphaned にはならないが、**中身が別物になっている**
   * 可能性がある。orphaned より気づきにくいぶん危険なので明示する。
   */
  rangeChanged: boolean;
  /** rangeChanged のとき、判断した時点の区間。 */
  decidedRange?: { startSec: number; endSec: number; score: number };
}

/**
 * 繋ぎ先が見つからなかった判断。★黙って捨てず、内容ごと表示する。
 *
 * ショートのIDは時刻を含まないため時刻での再接続ができない。
 * 候補が変われば必ずここに来る仕様（resolve.ts のコメントに明記されている）。
 */
export interface ShortsOrphanedDecision {
  originalId: string;
  reason: string;
  adopted: ShortAdoption;
  title?: string;
  hook?: string;
  caption?: string;
  hashtags?: string[];
  note?: string;
}

export interface ShortsCounts {
  candidates: number;
  adopted: number;
  rejected: number;
  undecided: number;
  edited: number;
  orphaned: number;
  rangeChanged: number;
}

export interface ShortsData {
  summary: ProjectSummary;
  /** 競合更新の検出に使うリビジョン値。 */
  updatedAt: string;
  speakers: ShortsSpeaker[];
  candidates: ShortCandidateItem[];
  counts: ShortsCounts;
  orphaned: ShortsOrphanedDecision[];
  /** 再生用プレビュー。★4画面で同じ型（`review-dto.ts` の `ReviewMedia`）。 */
  media?: ReviewMedia;
  /**
   * ★常時表示する警告。ショートIDが時刻を持たないことに由来する仕様。
   * 画面から消せないようにするため、フラグではなく本文をMainが持つ。
   */
  reanalysisWarning: string;
  /**
   * ★shorts.csv に書き出されない項目。
   * save-artifacts.ts（凍結対象）が id/startSec/endSec/score/adopted/title/signals
   * だけを書くため、hook・caption・hashtags・note は project.json にのみ残る。
   */
  fieldsNotExported: readonly string[];
  /** ★タイムコード編集は未対応（ShortDecision が時刻を持たない）。 */
  timecodeEditingSupported: false;
}

export type ShortsLoadResult =
  | { ok: true; data: ShortsData }
  | { ok: false; error: SafePipelineError };

// ─── 保存 ──────────────────────────────────────────────

export interface ShortDecisionPatch {
  /**
   * 採否。`null` は「未判断に戻す」。
   * undefined（キー自体が無い）は「この項目は変更しない」。
   */
  adopted?: boolean | null;
  title?: string | null;
  hook?: string | null;
  caption?: string | null;
  hashtags?: string[] | null;
  note?: string | null;
  /**
   * ★未対応。`ShortDecision`（packages/core）が時刻を持たず、
   * 区間を動かすには resolve.ts（凍結対象）の変更が必要になるため。
   * 受け取ったら検証で拒否する（黙って無視しない）。
   */
  startSec?: number;
  endSec?: number;
}

export interface UpdateShortDecisionRequest {
  projectPath: string;
  shortId: string;
  /** 読み込み時の updatedAt。食い違ったら上書きせず競合として返す。 */
  expectedUpdatedAt: string;
  patch: ShortDecisionPatch;
}

export interface RemoveShortDecisionRequest {
  projectPath: string;
  shortId: string;
  expectedUpdatedAt: string;
}

/** 保存結果。成功時は次の保存に使う updatedAt と、更新後の候補を返す。 */
export type SaveShortDecisionResult =
  | {
      ok: true;
      updatedAt: string;
      candidate: ShortCandidateItem;
      counts: ShortsCounts;
    }
  | { ok: false; conflict: true; error: SafePipelineError }
  | { ok: false; conflict?: false; error: SafePipelineError };

// ─── 再出力 ────────────────────────────────────────────

/**
 * 再出力のリクエスト。★4画面で同じ形なので `ReviewExportRequest` を使う
 * （画面ごとの別名として残すのは、呼び出し側の読みやすさのため）。
 */
export type ShortsExportRequest = ReviewExportRequest;

/**
 * 再出力は既存の部分実行に乗せる。
 * ★どの工程を動かすかは Main が固定する（Renderer に選ばせない）。
 * ★FCP7 XML（generate-premiere-xml）は動かさない。
 */
export type ShortsExportResult = ReviewExportResult;
