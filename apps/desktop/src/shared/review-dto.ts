/**
 * 確認画面（Review）のDTO。今回は字幕の確認・修正のみ。
 *
 * ★Renderer へ Project 全体を渡さない。
 * 画面に出す値だけをここで定義し、解析の内部データ・音声サンプル・
 * パイプラインログ・APIキー・不要な絶対パスは載せない。
 *
 * ★Renderer から Project 全体を送らせない。
 * 保存は「どの字幕を、どう直すか」だけを持つ専用DTO（UpdateSubtitleEditRequest）で受ける。
 */

import type { ProjectSummary, SafePipelineError } from './dto.ts';

// ─── 読み込み ──────────────────────────────────────────

export interface ReviewSpeaker {
  id: string;
  name: string;
  title?: string;
}

export interface ReviewLowConfidenceWord {
  text: string;
  probability: number;
}

export interface ReviewSubtitleCue {
  id: string;
  startSec: number;
  endSec: number;
  /** 表示・編集する本文（複数行は \n 区切り）。人間修正を適用済みの値。 */
  text: string;
  speakerId?: string;
  /** 認識の確からしさが低い語。画面で色を変えて示す。 */
  lowConfidenceWords: ReviewLowConfidenceWord[];
  /** このキューの最小確からしさ（低いほど要確認）。語情報が無ければ undefined。 */
  minProbability?: number;
  /** 人が直したか。 */
  edited: boolean;
  /** 修正後に解析結果が変わっている（＝古い修正のままの可能性）。 */
  conflicted: boolean;
  /** 解析（AI）が出した元の本文。修正済みのとき比較・復元に使う。 */
  analysisText: string;
  analysisSpeakerId?: string;
  /**
   * ★同じIDのキューが他にもある（＝IDが一意でない）。
   *
   * 字幕IDは開始時刻から作られる（`sub-` + ミリ秒）ため、
   * 開始時刻が同一のキューが2つできると衝突する。実データで発生を確認済み。
   * `resolveProject` は修正をIDで紐づけるので、この状態で修正すると
   * 同じIDの全キューに同じ修正が適用されてしまう。
   * 誤った修正を保存させないため、該当キューは編集不可にする。
   */
  duplicateId: boolean;
  /** 編集できるか（duplicateId が true なら false）。 */
  editable: boolean;
}

/** 繋ぎ先が見つからなかった修正。★黙って捨てず、内容ごと表示する。 */
export interface ReviewOrphanedEdit {
  kind: string;
  originalId: string;
  approxSec?: number;
  reason: string;
  /** 失われかけている修正の中身。 */
  text?: string;
  speakerId?: string;
}

/** 修正後に解析結果が変わったもの。人間修正は保持されるが、確認を促す。 */
export interface ReviewConflictedEdit {
  subtitleId: string;
  approxSec?: number;
  /** 人が入れた本文。 */
  humanText: string;
  /** 修正した時点での解析結果。 */
  previousAnalysisText: string;
  /** 現在の解析結果。 */
  currentAnalysisText: string;
}

/**
 * 再生用メディアの識別子。
 * ★絶対パスは渡さない。Main が発行したトークン付きURLだけを渡し、
 * カスタムプロトコルのハンドラが許可済みのファイルにのみ解決する。
 */
export interface ReviewMedia {
  /** contentos-media://<token> 形式。 */
  url: string;
  durationSec: number;
  /** どの素材から作ったか（表示用のファイル名のみ）。 */
  sourceFileName: string;
}

export interface ReviewCounts {
  cues: number;
  lowConfidenceWords: number;
  edited: number;
  orphaned: number;
  conflicted: number;
  /** IDが重複していて編集できないキューの数。 */
  duplicateId: number;
}

export interface ReviewData {
  summary: ProjectSummary;
  /** 競合更新の検出に使うリビジョン値。 */
  updatedAt: string;
  speakers: ReviewSpeaker[];
  subtitles: ReviewSubtitleCue[];
  counts: ReviewCounts;
  orphaned: ReviewOrphanedEdit[];
  conflicted: ReviewConflictedEdit[];
  /** 生成できなかった場合は undefined（解析前・ffmpeg未導入など）。 */
  media?: ReviewMedia;
  /** ★今回はタイムコード編集に未対応。画面に明記するためのフラグ。 */
  timecodeEditingSupported: false;
}

export type ReviewLoadResult =
  | { ok: true; data: ReviewData }
  | { ok: false; error: SafePipelineError };

// ─── 保存 ──────────────────────────────────────────────

export interface SubtitleEditPatch {
  text?: string;
  speakerId?: string;
  /**
   * ★今回は未対応。
   * `SubtitleEdit`（packages/core）が text / speakerId / deleted しか持たず、
   * 時刻を適用するのは resolve.ts（凍結対象）の変更が必要になるため。
   * 受け取ったら検証で拒否する（黙って無視しない）。
   */
  startSec?: number;
  endSec?: number;
}

export interface UpdateSubtitleEditRequest {
  projectPath: string;
  subtitleId: string;
  /** 読み込み時の updatedAt。食い違ったら上書きせず競合として返す。 */
  expectedUpdatedAt: string;
  patch: SubtitleEditPatch;
}

export interface RemoveSubtitleEditRequest {
  projectPath: string;
  subtitleId: string;
  expectedUpdatedAt: string;
}

/** 保存結果。成功時は次の保存に使う updatedAt と、更新後のキューを返す。 */
export type SaveSubtitleEditResult =
  | {
      ok: true;
      updatedAt: string;
      cue: ReviewSubtitleCue;
      counts: ReviewCounts;
    }
  | { ok: false; conflict: true; error: SafePipelineError }
  | { ok: false; conflict?: false; error: SafePipelineError };

// ─── 再出力 ────────────────────────────────────────────

export interface ReviewExportRequest {
  projectPath: string;
}

/**
 * 再出力は既存の部分実行に乗せる。
 * ★どの工程を動かすかは Main が固定する（Renderer に選ばせない）。
 */
export type ReviewExportResult =
  | { ok: true; runId: string; steps: string[] }
  | { ok: false; error: SafePipelineError };

// ─── メディア ──────────────────────────────────────────

export type OpenMediaResult =
  | { ok: true; media: ReviewMedia }
  | { ok: false; error: SafePipelineError };
