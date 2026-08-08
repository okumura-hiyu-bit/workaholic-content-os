/**
 * 確認画面（Review）— マーカーのDTO。
 *
 * ★Renderer へ Project 全体を渡さない。画面に出す値だけをここで定義し、
 * 解析の内部データ・文字起こし全文・パイプラインログ・APIキー・
 * 素材の絶対パスは載せない。
 * ★Renderer から Project 全体を送らせない。保存は「どのマーカーを、どう直すか」
 * だけを持つ専用DTOで受ける。
 *
 * ★他の3画面との違い（実測で確認した2点）
 *
 * 1. **マーカーIDには2系統あり、再解析後の挙動が分かれる。**
 *    `generate-markers.ts` は2通りの採番をしている：
 *      TOPIC / LAUGH → `markerId(kind, startSec)` → `mk-<KIND>-<8桁ミリ秒>`
 *      CHECK         → `mk-CHECK-${check.id}`（例 `mk-CHECK-check-lowconf-7700`）
 *    前者は `timeFromId()` が時刻を返すので時刻での再接続が効く（カメラ切替と同じ）。
 *    後者は `undefined` を返すので**必ず孤立する**（ショート候補と同じ）。
 *    実データでは5件中3件が CHECK だった。この差は `volatileId` で個別に示す。
 *
 * 2. **種別をまたぐ再接続が起きる。**
 *    `resolve.ts` の `matchEdits` は種別を見ず、時刻の近さだけで繋ぎ直す。
 *    実測で TOPIC への修正が LAUGH マーカーへ付くことを確認した（孤立にならない）。
 *    章タイトルが笑いマーカーに乗るような静かな取り違えなので、
 *    `reattachedKindMismatch` として検出し「要確認」で提示する。
 *    ★システムは検出まで。自動で取り消したり付け替えたりはしない。
 */

import type { ProjectSummary, SafePipelineError } from './dto.ts';

// ─── 読み取り ──────────────────────────────────────────

/**
 * マーカーの種類（`packages/editing` の `MarkerKind` に対応）。
 *
 * ★実際に生成されるのは TOPIC / LAUGH / CHECK の3種だけ
 * （`generate-markers.ts` を全走査して確認）。残り6種は型に定義があるだけだが、
 * 将来の工程追加で増えても画面が壊れないよう9種すべて受けられるようにする。
 */
export type MarkerKindDto =
  | 'TOPIC'
  | 'LAUGH'
  | 'KEY'
  | 'SHORT'
  | 'RETAKE'
  | 'CHECK'
  | 'SPONSOR'
  | 'OP'
  | 'ED';

export interface MarkerItem {
  id: string;
  kind: MarkerKindDto;
  /** 種別の日本語表示。Main が持つ（Renderer に対応表を持たせない）。 */
  kindLabel: string;
  startSec: number;
  /** 区間を持つマーカー（実データでは LAUGH のみ）。表示専用で編集しない。 */
  endSec?: number;

  /** 表示・編集する値（人間の修正を適用済み）。 */
  name: string;
  comment: string;

  /** 解析（AI）が出した元の値。修正済みのとき比較・復元に使う。 */
  analysisName?: string;
  analysisComment?: string;

  edited: boolean;

  /**
   * ★再解析で別のマーカーへ繋ぎ直された。
   * IDに時刻を含む種別（TOPIC / LAUGH 等）で起こる。
   */
  reattached?: { fromId: string; deltaSec: number };

  /**
   * ★★繋ぎ直し先の種別が元と違う（静かな取り違え）。
   *
   * `matchEdits` は種別を見ずに時刻だけで繋ぎ直すため、
   * 章タイトル（TOPIC）の修正が笑い（LAUGH）マーカーへ付きうる。
   * 孤立しないので放置すると気づけない。
   */
  reattachedKindMismatch?: { fromKind: string; toKind: string };

  /**
   * ★このマーカーのIDは時刻を含まないため、**再解析すると修正が必ず外れる**。
   *
   * CHECK マーカー（`mk-CHECK-<check.id>`）が該当する。
   * 編集は許可するが、永続化されない可能性を編集前に必ず知らせる。
   */
  volatileId: boolean;

  /**
   * ★同じIDのマーカーが他にもある（IDが一意でない）。
   *
   * `markerId(kind, startSec)` に連番が無いため、同じ種別・同じ開始時刻の
   * マーカーが2つできると衝突する。修正が両方に適用されてしまうので
   * 該当マーカーは編集不可にする（字幕IDの重複と同じ扱い）。
   */
  duplicateId: boolean;
  /** 編集できるか（`duplicateId` が true なら false）。 */
  editable: boolean;
}

/** 繋ぎ先が見つからなかった修正。★黙って捨てず、内容ごと表示する。 */
export interface MarkerOrphanedEdit {
  originalId: string;
  approxSec?: number;
  reason: string;
  /** 失われかけている修正の中身。 */
  name?: string;
  comment?: string;
  deleted?: boolean;
}

export interface MarkerCounts {
  markers: number;
  edited: number;
  deleted: number;
  reattached: number;
  /** ★種別をまたいで繋ぎ直された件数（要確認）。 */
  kindMismatch: number;
  orphaned: number;
  /** ★再解析で修正が外れる可能性のあるマーカーの件数。 */
  volatile: number;
  duplicateId: number;
}

/** 種別ごとの件数。画面の絞り込みに使う。 */
export interface MarkerKindCount {
  kind: MarkerKindDto;
  label: string;
  count: number;
}

export interface MarkerData {
  summary: ProjectSummary;
  /** 競合更新の検出に使うリビジョン値。 */
  updatedAt: string;
  markers: MarkerItem[];
  counts: MarkerCounts;
  /** 実際に存在する種別と件数（画面の絞り込み用）。 */
  kinds: MarkerKindCount[];
  orphaned: MarkerOrphanedEdit[];
  /** 再生用プレビュー。字幕Reviewと同じものを使い回す。 */
  media?: {
    url: string;
    durationSec: number;
    sourceFileName: string;
  };
  /**
   * ★常時表示する注意書き。Main が本文を持ち、Renderer のフラグで消せない。
   * マーカー修正が反映される成果物は FCP7 XML だけであることを示す。
   */
  exportNotice: string;
  /** ★XMLの名前に `[KIND] ` が自動で前置される旨。 */
  namePrefixNotice: string;
  /** ★`syncMode: 'common'` のとき、区間外のマーカーが除外される旨。 */
  syncModeNotice?: string;
  /** ★時刻の編集・マーカーの追加は未対応（データモデルが持たない）。 */
  timeEditingSupported: false;
  markerCreationSupported: false;
}

export type MarkerLoadResult =
  | { ok: true; data: MarkerData }
  | { ok: false; error: SafePipelineError };

// ─── 保存 ──────────────────────────────────────────────

/**
 * マーカーの修正。
 *
 * `null` は「この項目の修正を取り消して解析値に戻す」。
 * undefined（キー自体が無い）は「この項目は変更しない」。
 */
export interface MarkerPatch {
  name?: string | null;
  /** ★空文字を許す（補足情報なので、意図的に空にしたい場合がある）。 */
  comment?: string | null;
  /**
   * ★未対応。`MarkerEdit`（`packages/core`）が name / comment / deleted しか
   * 持たず、時刻や種別を適用するには凍結対象の `resolve.ts` の変更が要る。
   * 受け取ったら検証で拒否する（黙って無視しない）。
   */
  startSec?: number;
  endSec?: number;
  kind?: string;
}

export interface UpdateMarkerRequest {
  projectPath: string;
  markerId: string;
  /** 読み込み時の updatedAt。食い違ったら上書きせず競合として返す。 */
  expectedUpdatedAt: string;
  patch: MarkerPatch;
}

export interface DeleteMarkerRequest {
  projectPath: string;
  markerId: string;
  expectedUpdatedAt: string;
}

export interface RemoveMarkerEditRequest {
  projectPath: string;
  markerId: string;
  expectedUpdatedAt: string;
}

/**
 * 保存結果。
 *
 * ★マーカー同士は干渉しないので「1要素」を返す
 * （カメラ切替のように並び全体を返す必要がない）。
 * ただし削除したマーカーは一覧から消えるため、その場合は `marker` を返さない。
 */
export type SaveMarkerEditResult =
  | {
      ok: true;
      updatedAt: string;
      /** 削除した場合は undefined（一覧から消えるため）。 */
      marker?: MarkerItem;
      counts: MarkerCounts;
      orphaned: MarkerOrphanedEdit[];
    }
  | { ok: false; conflict: true; error: SafePipelineError }
  | { ok: false; conflict?: false; error: SafePipelineError };

// ─── 再出力 ────────────────────────────────────────────

export interface MarkerExportRequest {
  projectPath: string;
}

/**
 * 再出力は既存の部分実行に乗せる。
 * ★どの工程を動かすかは Main が固定する（Renderer に選ばせない）。
 * ★`generate-premiere-xml` は**必須**。マーカー修正が反映される成果物は
 * FCP7 XML だけで、`save-artifacts` は `analysis.markers` の件数しか使わない。
 */
export type MarkerExportResult =
  | { ok: true; runId: string; steps: string[] }
  | { ok: false; error: SafePipelineError };
