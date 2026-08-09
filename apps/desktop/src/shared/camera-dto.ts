/**
 * 確認画面（Review）— カメラ切替のDTO。
 *
 * ★Renderer へ Project 全体を渡さない。画面に出す値だけをここで定義し、
 * 解析の内部データ・文字起こし全文・パイプラインログ・APIキー・
 * 素材の絶対パスは載せない。
 * ★Renderer から Project 全体を送らせない。保存は「どのカットを、どう変えるか」
 * だけを持つ専用DTOで受ける。
 *
 * ★字幕・ショート候補との決定的な違い（3点）
 *
 * 1. **修正が FCP7 XML そのものを書き換える。**
 *    `generate-premiere-xml` が `resolveProject()` の `resolved.cameraShots` を
 *    そのまま V1 トラックに並べる。字幕（SRT）やショート（CSV）と違い、
 *    Premiereプロジェクトの映像トラック構成が直接変わる。
 *
 * 2. **カメラIDは時刻を持つ（`shot-<ミリ秒>`）ので再接続が効く。**
 *    ショート候補（連番IDのため必ず孤立）とは正反対で、再解析後は
 *    `matchEdits` が時刻の近さで繋ぎ直す。その結果を `reattached` として
 *    画面に出す。★字幕・ショートでは一度も出していなかった情報。
 *
 * 3. **要素の追加・削除・時間軸の変更を伴う。**
 *    `edits.cameraShots` は `overrides` / `inserted` / `deletedIds` の3構造。
 *    そのためカット同士が重なったり隙間が空いたりしうる。この整合性は
 *    `build-project.ts`（凍結対象）が検査しないので、**この層で守る**。
 */

import type { ProjectSummary, SafePipelineError } from './dto.ts';
import type { ReviewExportRequest, ReviewExportResult, ReviewMedia } from './review-dto.ts';

// ─── 読み取り ──────────────────────────────────────────

/**
 * 切替先に選べるカメラ。
 *
 * ★`cameraId` は `asset.id` ではなく **`asset.role`**（`wide` / `cam_A` …）。
 * `generate-premiere-xml.ts` が `videos` を `{ id: a.role }` で組み立てており、
 * `build-project.ts` はこの id で素材を引く。ここを取り違えると
 * 「カメラ素材が見つかりません」で **XML生成が例外を投げる**。
 */
export interface CameraOption {
  cameraId: string;
  /** 画面に出す名前（「引き」「寄りA」など）。 */
  label: string;
  /** 表示用のファイル名のみ。★絶対パスは載せない。 */
  fileName: string;
  /** この素材の尺。カットが尺を超えていないかの判定に使う。 */
  durationSec: number;
}

/** カメラ切替の理由（`packages/editing` の `ShotReason` に対応）。 */
export type CameraShotReasonDto =
  | 'speech'
  | 'overlap'
  | 'laughter'
  | 'hold'
  | 'reaction'
  | 'merged';

/**
 * カット1つ。`resolveProject()` が返した値（＝人間の修正を適用済み）を写す。
 */
export interface CameraShotItem {
  id: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  cameraId: string;
  /** `cameraId` に対応する表示名。解決できなければ cameraId をそのまま出す。 */
  cameraLabel: string;
  reason: CameraShotReasonDto;
  /** 理由の日本語表示。Main が持つ（Renderer に対応表を持たせない）。 */
  reasonLabel: string;

  /** 解析（AI）が出した元の値。修正済みのとき比較・復元に使う。 */
  analysisCameraId?: string;
  analysisStartSec?: number;
  analysisEndSec?: number;

  /** 人が変更したか（`overrides` が付いているか）。 */
  edited: boolean;
  /** 人が追加したカットか（`inserted`）。 */
  inserted: boolean;

  /**
   * ★再解析で別のカットへ繋ぎ直された。
   *
   * `resolveProject` の `reattached` に対応する。IDが時刻を含むため、
   * 再解析でカットの位置が少し動いても `matchEdits` が拾ってくれる。
   * ただし「拾えた」ことは編集者に伝える必要がある（意図と違う場所に
   * 付いている可能性があるため）。
   */
  reattached?: { fromId: string; deltaSec: number };

  // ─── 整合性（★Camera 固有。保存前に画面で気づけるようにする）───

  /** 直前のカットと時間が重なっている。★XMLが壊れるので保存させない。 */
  overlapsPrevious: boolean;
  /** 直前のカットとの隙間（秒）。0より大きいとXML上で黒コマになる。 */
  gapBeforeSec?: number;
  /** 最短ショット長を下回っている。 */
  tooShort: boolean;
  /** 素材の尺を超えている。 */
  outOfRange: boolean;
}

/**
 * 繋ぎ先が見つからなかった修正。★黙って捨てず、内容ごと表示する。
 *
 * カメラのIDは時刻を含むため通常は再接続される。ここに来るのは
 * 「近くに繋げるカットが1つも無かった」場合と、
 * 「削除対象のカットが再解析後に存在しない」場合。
 */
export interface CameraOrphanedEdit {
  originalId: string;
  approxSec?: number;
  reason: string;
  /** 失われかけている修正の中身。 */
  cameraId?: string;
  startSec?: number;
  endSec?: number;
  /** 削除指定が孤立した場合。 */
  deleted?: boolean;
}

export interface CameraCounts {
  shots: number;
  edited: number;
  inserted: number;
  deleted: number;
  reattached: number;
  orphaned: number;
  /** ★保存・再出力を止める問題の数。 */
  overlaps: number;
  gaps: number;
  tooShort: number;
  outOfRange: number;
}

export interface CameraData {
  summary: ProjectSummary;
  /** 競合更新の検出に使うリビジョン値。 */
  updatedAt: string;
  /** 切替先に選べるカメラの一覧。★Renderer はここに無い値を送れない。 */
  cameras: CameraOption[];
  shots: CameraShotItem[];
  counts: CameraCounts;
  orphaned: CameraOrphanedEdit[];
  /** 収録全体の尺（基準映像の尺）。タイムラインの表示に使う。 */
  timelineDurationSec: number;
  /** 最短ショット長（`DEFAULT_CAMERA_RULES.minShotSec` に合わせる）。 */
  minShotSec: number;
  /** 再生用プレビュー。★4画面で同じ型（`review-dto.ts` の `ReviewMedia`）。 */
  media?: ReviewMedia;
  /**
   * ★常時表示する注意書き。Main が本文を持ち、Renderer のフラグで消せない。
   * カメラ修正だけが Premiere プロジェクト（FCP7 XML）を書き換えるため。
   */
  exportNotice: string;
  /**
   * ★`syncMode: 'common'` のとき、XML上の時刻が画面の表示とずれる旨。
   * ずれない場合は undefined。
   */
  syncModeNotice?: string;
}

export type CameraLoadResult =
  | { ok: true; data: CameraData }
  | { ok: false; error: SafePipelineError };

// ─── 保存 ──────────────────────────────────────────────

/**
 * 既存カットの変更。`edits.cameraShots.overrides[id]` に入る。
 *
 * `null` は「この項目の変更を取り消して解析値に戻す」。
 * undefined（キー自体が無い）は「この項目は変更しない」。
 */
export interface CameraShotPatch {
  cameraId?: string | null;
  startSec?: number | null;
  endSec?: number | null;
}

export interface UpdateCameraShotRequest {
  projectPath: string;
  shotId: string;
  /** 読み込み時の updatedAt。食い違ったら上書きせず競合として返す。 */
  expectedUpdatedAt: string;
  patch: CameraShotPatch;
}

/**
 * カットの追加。`edits.cameraShots.inserted[]` に入る。
 *
 * ★IDは Main が採番する（Renderer に決めさせない）。
 * ★`reason` も Renderer からは受け取らない（後述の暫定措置のため）。
 */
export interface InsertCameraShotRequest {
  projectPath: string;
  expectedUpdatedAt: string;
  startSec: number;
  endSec: number;
  cameraId: string;
}

/** カットの削除。`edits.cameraShots.deletedIds[]` に入る。 */
export interface DeleteCameraShotRequest {
  projectPath: string;
  shotId: string;
  expectedUpdatedAt: string;
}

/**
 * 修正の取り消し。
 * `overrides` / `inserted` / `deletedIds` のどこに入っていても、
 * そのIDに関する人間の修正をすべて取り除いて解析結果の状態へ戻す。
 */
export interface RemoveCameraEditRequest {
  projectPath: string;
  shotId: string;
  expectedUpdatedAt: string;
}

/**
 * 保存結果。
 *
 * ★字幕・ショートと違い「1要素」ではなく **並び全体** を返す。
 * カットの追加・削除・時間変更は隣のカットとの重なり・隙間を変えるため、
 * 1要素だけ差し替えると画面の整合性表示が古いままになる。
 */
export type SaveCameraEditResult =
  | {
      ok: true;
      updatedAt: string;
      shots: CameraShotItem[];
      counts: CameraCounts;
      orphaned: CameraOrphanedEdit[];
    }
  | { ok: false; conflict: true; error: SafePipelineError }
  | { ok: false; conflict?: false; error: SafePipelineError };

// ─── 再出力 ────────────────────────────────────────────

/**
 * 再出力のリクエスト。★4画面で同じ形なので `ReviewExportRequest` を使う
 * （画面ごとの別名として残すのは、呼び出し側の読みやすさのため）。
 */
export type CameraExportRequest = ReviewExportRequest;

/**
 * 再出力は既存の部分実行に乗せる。
 * ★どの工程を動かすかは Main が固定する（Renderer に選ばせない）。
 * ★字幕と同じ3工程。`generate-premiere-xml` は**必須**
 * （カメラ修正が反映される成果物は FCP7 XML だけのため）。
 */
export type CameraExportResult = ReviewExportResult;
