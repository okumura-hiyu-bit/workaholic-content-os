/**
 * 確認画面（Review）— マーカーの組み立てと、修正・削除の保存。
 *
 * ★このファイルが守る最重要ルール（review.ts / shorts.ts / camera.ts と同一）
 * 1. `project.analysis` を絶対に書き換えない。人間の修正は
 *    `project.edits.markers` にだけ書く。
 * 2. 表示値は `resolveProject()` に作らせる（独自の突き合わせを作らない）。
 * 3. 孤立した修正を黙って捨てない。件数と中身を画面へ返す。
 * 4. 保存は `saveProject()`（一時ファイル→rename）に任せる。
 *
 * ★electron を import しない。fs も直接触らない（すべて注入）。
 *
 * ★マーカー固有の事情（実測で確認した2点）
 *
 * 1. **IDには2系統あり、再解析後の挙動が分かれる。**
 *    TOPIC / LAUGH は `markerId(kind, startSec)`（時刻キー）、
 *    CHECK は `mk-CHECK-${check.id}`（時刻を含まない）。
 *    後者は `timeFromId()` が undefined を返すので時刻での再接続ができず、
 *    再解析すると修正が**必ず孤立する**。`volatileId` で個別に示す。
 *    ★編集は禁止しない。一時的に名前やコメントを付けて確認したい運用があるため、
 *    「永続化されない可能性」を明示したうえで使えるようにする。
 *
 * 2. **種別をまたぐ再接続が起きる。**
 *    `resolve.ts` の `matchEdits` は種別を見ず時刻の近さだけで繋ぎ直すため、
 *    章タイトル（TOPIC）の修正が笑い（LAUGH）マーカーへ付きうる。
 *    孤立しないので放置すると気づけない。`reattachedKindMismatch` で検出する。
 *    ★システムは検出まで。自動で取り消したり付け替えたりはしない。
 */

// ★`timeFromId` は純粋関数（fs も electron も触らない）。
//   `volatileId` の判定は「resolve.ts が時刻で再接続できるか」と同義なので、
//   同じ正規表現を写さず本体の関数をそのまま使う。写すと本体が変わったときに
//   ここだけ古い判定のまま残る。
import { timeFromId } from '@contentos/core/project';

import type { SafePipelineError } from '../shared/dto.ts';
import { DESKTOP_ERROR_CODES, safeError } from '../shared/errors.ts';
import type {
  MarkerCounts,
  MarkerData,
  MarkerItem,
  MarkerKindCount,
  MarkerKindDto,
  MarkerLoadResult,
  MarkerOrphanedEdit,
  MarkerPatch,
  SaveMarkerEditResult,
} from '../shared/marker-dto.ts';
import type { ReviewMedia } from '../shared/review-dto.ts';
import {
  analysisNotReadyError,
  loadForSave as loadProjectForSave,
  loadProjectOrError,
  SAVE_FAILED_EDIT,
  saveAndRebuild,
  summaryOf,
} from './review-common.ts';
import type {
  AnalysisMarkerLike,
  EditsLike,
  MarkerEditLike,
  ProjectLike,
  ReattachedEditLike,
  ResolvedMarkerLike,
  ReviewDeps,
} from './review.ts';
import { normalizeAnalysis } from './review.ts';

/**
 * ★常時表示する注意書き。Renderer のフラグではなく Main が本文を持つ。
 *
 * マーカー修正が反映される成果物は FCP7 XML だけ。
 * `save-artifacts.ts` は `analysis.markers` の**件数**しかレポートに使わないため、
 * 修正しても SRT・CSV・レポートには一切出ない。
 */
export const EXPORT_NOTICE =
  'マーカーの修正は、再出力すると Premiere用の FCP7 XML にだけ反映されます。' +
  '字幕SRT・ショート候補CSV・解析レポートには出ません（レポートの件数は解析結果の件数です）。';

/** ★XMLの名前には種別が自動で前置される旨。 */
export const NAME_PREFIX_NOTICE =
  'Premiereのマーカー名には種別が自動で付きます（例：「第2章」→「[TOPIC] 第2章」）。' +
  '名前に自分で [TOPIC] と入れると二重になります。';

/** 種別の日本語表示。★Renderer に対応表を持たせない。 */
const KIND_LABELS: Record<string, string> = {
  TOPIC: '話題',
  LAUGH: '笑い',
  KEY: '重要',
  SHORT: 'ショート候補',
  RETAKE: '撮り直し',
  CHECK: '要確認',
  SPONSOR: 'スポンサー',
  OP: 'オープニング',
  ED: 'エンディング',
};

/** 表示順。実際に生成される TOPIC / LAUGH / CHECK を先に置く。 */
const KIND_ORDER = [
  'TOPIC',
  'LAUGH',
  'CHECK',
  'KEY',
  'SHORT',
  'RETAKE',
  'SPONSOR',
  'OP',
  'ED',
];

export function kindLabelOf(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

/** IDから種別を読み取る（`mk-<KIND>-...`）。読めなければ undefined。 */
export function kindFromId(id: string): string | undefined {
  const match = /^mk-([A-Z]{2,12})-/.exec(id);
  return match?.[1];
}

/**
 * ★このマーカーの修正は再解析で外れるか。
 *
 * `resolve.ts` の `matchEdits` は、IDが一致しなければ `timeFromId()` で
 * 時刻を読み、近いものへ繋ぎ直す。時刻が読めないIDは**その場で孤立**する。
 * つまり `timeFromId(id) === undefined` が「再解析で必ず外れる」と同義。
 */
export function isVolatileId(id: string): boolean {
  return timeFromId(id) === undefined;
}

// ─── 組み立て ──────────────────────────────────────────

/** 同じIDのマーカーが複数あるIDと、その件数。 */
export function duplicateMarkerIds(
  markers: readonly { id: string }[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const marker of markers) {
    counts.set(marker.id, (counts.get(marker.id) ?? 0) + 1);
  }
  const duplicated = new Map<string, number>();
  for (const [id, count] of counts) {
    if (count > 1) duplicated.set(id, count);
  }
  return duplicated;
}

function toMarkerItem(
  resolved: ResolvedMarkerLike,
  analysisById: ReadonlyMap<string, AnalysisMarkerLike>,
  reattachedTo: ReadonlyMap<string, ReattachedEditLike>,
  duplicated: ReadonlyMap<string, number>,
): MarkerItem {
  const analysis = analysisById.get(resolved.id);
  const duplicateId = duplicated.has(resolved.id);

  const item: MarkerItem = {
    id: resolved.id,
    kind: resolved.kind as MarkerKindDto,
    kindLabel: kindLabelOf(resolved.kind),
    startSec: resolved.startSec,
    name: resolved.name,
    comment: resolved.comment,
    edited: resolved.edited,
    volatileId: isVolatileId(resolved.id),
    duplicateId,
    editable: !duplicateId,
  };
  if (resolved.endSec !== undefined) item.endSec = resolved.endSec;
  if (analysis !== undefined) {
    item.analysisName = analysis.name;
    item.analysisComment = analysis.comment;
  }

  const reattached = reattachedTo.get(resolved.id);
  if (reattached !== undefined) {
    item.reattached = { fromId: reattached.fromId, deltaSec: reattached.deltaSec };

    // ★繋ぎ直し先の種別が元と違うか。
    //   matchEdits は種別を見ずに時刻だけで繋ぐため、章タイトルの修正が
    //   笑いマーカーへ付きうる。孤立しないので明示しないと気づけない。
    const fromKind = kindFromId(reattached.fromId);
    if (fromKind !== undefined && fromKind !== resolved.kind) {
      item.reattachedKindMismatch = { fromKind, toKind: resolved.kind };
    }
  }

  return item;
}

/** ★内容ごと返す。件数だけだと編集者は何を失うのか分からない。 */
function toOrphaned(
  orphaned: {
    kind: string;
    originalId: string;
    approxSec?: number;
    edit: unknown;
    reason: string;
  }[],
): MarkerOrphanedEdit[] {
  return orphaned
    .filter((o) => o.kind === 'marker')
    .map((o) => {
      const edit = o.edit as MarkerEditLike | undefined;
      const item: MarkerOrphanedEdit = {
        originalId: o.originalId,
        reason: o.reason,
      };
      if (o.approxSec !== undefined) item.approxSec = o.approxSec;
      if (edit?.name !== undefined) item.name = edit.name;
      if (edit?.comment !== undefined) item.comment = edit.comment;
      if (edit?.deleted === true) item.deleted = true;
      return item;
    });
}

export function countsOf(
  markers: readonly MarkerItem[],
  orphaned: readonly unknown[],
  deletedCount: number,
): MarkerCounts {
  return {
    markers: markers.length,
    edited: markers.filter((m) => m.edited).length,
    deleted: deletedCount,
    reattached: markers.filter((m) => m.reattached !== undefined).length,
    kindMismatch: markers.filter((m) => m.reattachedKindMismatch !== undefined).length,
    orphaned: orphaned.length,
    volatile: markers.filter((m) => m.volatileId).length,
    duplicateId: markers.filter((m) => m.duplicateId).length,
  };
}

/** 実際に存在する種別と件数。画面の絞り込みに使う。 */
export function kindCountsOf(markers: readonly MarkerItem[]): MarkerKindCount[] {
  const counts = new Map<string, number>();
  for (const marker of markers) {
    counts.set(marker.kind, (counts.get(marker.kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => {
      const ai = KIND_ORDER.indexOf(a[0]);
      const bi = KIND_ORDER.indexOf(b[0]);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    })
    .map(([kind, count]) => ({
      kind: kind as MarkerKindDto,
      label: kindLabelOf(kind),
      count,
    }));
}

/** `edits.markers` を安全に取り出す（旧形式・手書きで欠けていても落ちない）。 */
export function markerEditsOf(edits: EditsLike): Record<string, MarkerEditLike> {
  const raw = edits.markers;
  return raw !== undefined && typeof raw === 'object' ? raw : {};
}

/** マーカーの確認に必要な情報だけを組み立てる。★Project全体は返さない。 */
export function buildMarkerData(
  projectDir: string,
  deps: ReviewDeps,
): MarkerLoadResult {
  const loaded = loadProjectOrError(projectDir, deps);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const project = loaded.value.project;
  const analysis = project.analysis;
  if (analysis === undefined || !Array.isArray(analysis.subtitles)) {
    return { ok: false, error: analysisNotReadyError() };
  }

  // ★表示値は resolveProject に作らせる（独自の突き合わせをしない）。
  const normalized = normalizeAnalysis(analysis);
  const result = deps.resolveProject(normalized, project.edits);

  const analysisById = new Map(normalized.markers.map((m) => [m.id, m]));
  // 再接続は「移動先のID」で引けるようにする。
  const reattachedTo = new Map(
    result.reattached.filter((r) => r.kind === 'marker').map((r) => [r.toId, r]),
  );
  const duplicated = duplicateMarkerIds(normalized.markers);

  const resolvedMarkers = result.resolved.markers ?? [];
  const markers = resolvedMarkers.map((marker) =>
    toMarkerItem(marker, analysisById, reattachedTo, duplicated),
  );
  const orphaned = toOrphaned(result.orphaned);

  const edits = markerEditsOf(project.edits);
  const deletedCount = Object.values(edits).filter((e) => e.deleted === true).length;

  const data: MarkerData = {
    summary: summaryOf(project, projectDir, loaded.value.notes ?? []),
    updatedAt: project.updatedAt,
    markers,
    counts: countsOf(markers, orphaned, deletedCount),
    kinds: kindCountsOf(markers),
    orphaned,
    exportNotice: EXPORT_NOTICE,
    namePrefixNotice: NAME_PREFIX_NOTICE,
    timeEditingSupported: false,
    markerCreationSupported: false,
  };

  // ★common モードでは区間外のマーカーがXMLから除外され、時刻も前に詰められる。
  //   画面は常に解析時刻で表示するので、その差を明示する。
  const syncMode = (project.sync as { mode?: unknown } | undefined)?.mode;
  if (syncMode === 'common') {
    data.syncModeNotice =
      '同期モードが「共通区間（common）」のため、共通区間の外にあるマーカーは' +
      '書き出したXMLに含まれません。含まれるマーカーの時刻も前に詰められます。';
  }

  const media: ReviewMedia | undefined = deps.prepareMedia?.(project, projectDir);
  if (media !== undefined) {
    data.media = {
      url: media.url,
      durationSec: media.durationSec,
      sourceFileName: media.sourceFileName,
    };
  }

  return { ok: true, data };
}

// ─── 保存 ──────────────────────────────────────────────

function notFound(): SafePipelineError {
  return safeError(
    DESKTOP_ERROR_CODES.MARKER_NOT_FOUND,
    '対象のマーカーが見つかりませんでした。',
    { recoverable: true, suggestedAction: '再読み込みしてください。' },
  );
}

function notEditable(): SafePipelineError {
  return safeError(
    DESKTOP_ERROR_CODES.MARKER_NOT_EDITABLE,
    'このマーカーは同じ種別・同じ時刻の別マーカーとIDが重複しているため、安全に修正できません。',
    {
      recoverable: false,
      suggestedAction: '修正すると両方に適用されてしまいます。Premiere側で調整してください。',
    },
  );
}

function invalidRequest(userMessage: string, suggestedAction?: string): SafePipelineError {
  return safeError(DESKTOP_ERROR_CODES.INVALID_REQUEST, userMessage, {
    recoverable: true,
    ...(suggestedAction !== undefined ? { suggestedAction } : {}),
  });
}

interface LoadedForSave {
  project: ProjectLike;
  edits: Record<string, MarkerEditLike>;
  analysisMarkers: AnalysisMarkerLike[];
}

/**
 * 読み込み・競合検出・解析の有無をまとめて行い、マーカー固有の断片を取り出す。
 * ★共通部分（読み込み・競合・解析の有無）は `review-common.ts` に集約済み。
 */
function loadForSave(
  projectPath: string,
  expectedUpdatedAt: string,
  deps: ReviewDeps,
): { ok: true; value: LoadedForSave } | { ok: false; result: SaveMarkerEditResult } {
  const loaded = loadProjectForSave(projectPath, expectedUpdatedAt, deps);
  if (!loaded.ok) {
    return {
      ok: false,
      result: loaded.conflict === true
        ? { ok: false, conflict: true, error: loaded.error }
        : { ok: false, error: loaded.error },
    };
  }

  const project = loaded.project;
  return {
    ok: true,
    value: {
      project,
      edits: markerEditsOf(project.edits),
      analysisMarkers: loaded.analysis.markers ?? [],
    },
  };
}

/**
 * 保存し、読み直して結果を組み立てる。
 *
 * ★保存と読み直しは `review-common.ts` の `saveAndRebuild` に任せる。
 * ここが持つのは**マーカー固有の結果の形**だけ
 * （削除した場合は一覧から消えるので `marker` を返さない）。
 */
function persistAndReload(
  projectDir: string,
  nextProject: ProjectLike,
  markerId: string,
  deps: ReviewDeps,
): SaveMarkerEditResult {
  const reloaded = saveAndRebuild(
    projectDir,
    nextProject,
    deps,
    SAVE_FAILED_EDIT,
    buildMarkerData,
  );
  if (!reloaded.ok) return { ok: false, error: reloaded.error };

  // ★削除した場合は一覧から消えるので marker を返さない（undefined）。
  const marker = reloaded.data.markers.find((m) => m.id === markerId);

  return {
    ok: true,
    updatedAt: reloaded.data.updatedAt,
    ...(marker !== undefined ? { marker } : {}),
    counts: reloaded.data.counts,
    orphaned: reloaded.data.orphaned,
  };
}

/** `edits.markers` だけを差し替えた Project を作る。★他レイヤーは触らない。 */
function withMarkerEdits(
  project: ProjectLike,
  edits: EditsLike,
  markers: Record<string, MarkerEditLike>,
): ProjectLike {
  return { ...project, edits: { ...edits, markers } };
}

/**
 * マーカーの名前・コメントを修正する。
 *
 * ★書き換えるのは `edits.markers` と `edits.history` だけ。
 */
export function applyMarkerEdit(
  request: {
    projectPath: string;
    markerId: string;
    expectedUpdatedAt: string;
    patch: MarkerPatch;
  },
  deps: ReviewDeps,
): SaveMarkerEditResult {
  const loaded = loadForSave(request.projectPath, request.expectedUpdatedAt, deps);
  if (!loaded.ok) return loaded.result;
  const { project, edits, analysisMarkers } = loaded.value;

  const targets = analysisMarkers.filter((m) => m.id === request.markerId);
  if (targets.length === 0) return { ok: false, error: notFound() };
  // ★IDが重複していると修正が両方に適用されてしまう。字幕IDの重複と同じ扱い。
  if (targets.length > 1) return { ok: false, error: notEditable() };
  const target = targets[0]!;

  if (edits[request.markerId]?.deleted === true) {
    return {
      ok: false,
      error: invalidRequest(
        'このマーカーは削除済みです。',
        '先に削除を取り消してから修正してください。',
      ),
    };
  }

  const existing = edits[request.markerId];
  const next: MarkerEditLike = { ...existing };
  let history = project.edits;

  const record = (field: string, before: unknown, after: unknown) => {
    history = deps.recordEdit(history, {
      kind: 'marker',
      targetId: request.markerId,
      field,
      before: before ?? null,
      after: after ?? null,
    });
  };

  for (const field of ['name', 'comment'] as const) {
    const value = request.patch[field];
    if (value === undefined) continue;
    const before = existing?.[field] ?? target[field];
    if (value === null) {
      // 解析値へ戻す。
      if (existing?.[field] !== undefined) record(field, before, target[field]);
      delete next[field];
      continue;
    }
    if (before !== value) record(field, before, value);
    next[field] = value;
  }

  const nextMarkers = { ...edits };
  if (Object.keys(next).length === 0) {
    delete nextMarkers[request.markerId];
  } else {
    nextMarkers[request.markerId] = next;
  }

  return persistAndReload(
    request.projectPath,
    withMarkerEdits(project, history, nextMarkers),
    request.markerId,
    deps,
  );
}

/** マーカーを削除する（`deleted: true` を立てる。解析結果からは消さない）。 */
export function deleteMarker(
  request: { projectPath: string; markerId: string; expectedUpdatedAt: string },
  deps: ReviewDeps,
): SaveMarkerEditResult {
  const loaded = loadForSave(request.projectPath, request.expectedUpdatedAt, deps);
  if (!loaded.ok) return loaded.result;
  const { project, edits, analysisMarkers } = loaded.value;

  const targets = analysisMarkers.filter((m) => m.id === request.markerId);
  if (targets.length === 0) return { ok: false, error: notFound() };
  if (targets.length > 1) return { ok: false, error: notEditable() };

  if (edits[request.markerId]?.deleted === true) {
    return { ok: false, error: invalidRequest('このマーカーはすでに削除済みです。') };
  }

  const history = deps.recordEdit(project.edits, {
    kind: 'marker',
    targetId: request.markerId,
    field: 'deleted',
    before: targets[0]!,
    after: null,
  });

  const nextMarkers = {
    ...edits,
    [request.markerId]: { ...edits[request.markerId], deleted: true },
  };

  return persistAndReload(
    request.projectPath,
    withMarkerEdits(project, history, nextMarkers),
    request.markerId,
    deps,
  );
}

/**
 * そのマーカーに関する人間の修正をすべて取り消す。
 * 名前・コメントの修正も削除指定も、まとめて解析結果の状態へ戻す。
 */
export function removeMarkerEdit(
  request: { projectPath: string; markerId: string; expectedUpdatedAt: string },
  deps: ReviewDeps,
): SaveMarkerEditResult {
  const loaded = loadForSave(request.projectPath, request.expectedUpdatedAt, deps);
  if (!loaded.ok) return loaded.result;
  const { project, edits } = loaded.value;

  const existing = edits[request.markerId];
  if (existing === undefined) return { ok: false, error: notFound() };

  const history = deps.recordEdit(project.edits, {
    kind: 'marker',
    targetId: request.markerId,
    field: 'removed',
    before: existing,
    after: null,
  });

  const nextMarkers = { ...edits };
  delete nextMarkers[request.markerId];

  return persistAndReload(
    request.projectPath,
    withMarkerEdits(project, history, nextMarkers),
    request.markerId,
    deps,
  );
}
