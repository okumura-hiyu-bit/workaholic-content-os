/**
 * 確認画面（Review）— カメラ切替の組み立てと、変更・追加・削除の保存。
 *
 * ★このファイルが守る最重要ルール（review.ts / shorts.ts と同一）
 * 1. `project.analysis` を絶対に書き換えない。人間の修正は
 *    `project.edits.cameraShots` にだけ書く。
 * 2. 表示値は `resolveProject()` に作らせる（独自の突き合わせを作らない）。
 * 3. 孤立した修正を黙って捨てない。件数と中身を画面へ返す。
 * 4. 保存は `saveProject()`（一時ファイル→rename）に任せる。
 *
 * ★electron を import しない。fs も直接触らない（すべて注入）。
 *
 * ★カメラ固有の責務：整合性を守るのはこの層だけ
 * `build-project.ts`（凍結対象）は重なりを検査せず、ゼロ長カットを黙って
 * 捨て、未知の cameraId では例外を投げる。保存を通してしまうと
 * 「再出力が失敗する」「保存したのにXMLに出ない」という、編集者が理由に
 * 気づけない壊れ方をする。そのため**保存前に必ず適用後の並びを検査する**。
 */

import type { SafePipelineError } from '../shared/dto.ts';
import { DESKTOP_ERROR_CODES, safeError } from '../shared/errors.ts';
import type {
  CameraCounts,
  CameraData,
  CameraLoadResult,
  CameraOption,
  CameraOrphanedEdit,
  CameraShotItem,
  CameraShotPatch,
  CameraShotReasonDto,
  SaveCameraEditResult,
} from '../shared/camera-dto.ts';
import {
  INSERTED_SHOT_PREFIX,
  MIN_CAMERA_SHOT_SEC,
  TIME_EPSILON,
  validateNoOverlap,
  validateShotRange,
} from '../shared/camera-validate.ts';
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
  AnalysisCameraShotLike,
  CameraEditsLike,
  CameraShotOverrideLike,
  EditsLike,
  ProjectLike,
  ReattachedEditLike,
  ResolvedCameraShotLike,
  ReviewDeps,
} from './review.ts';
import { normalizeAnalysis } from './review.ts';

/**
 * ★人が追加したカットに付ける `reason`（暫定措置）。
 *
 * `ShotReason`（`packages/editing/src/types.ts`）は
 * 'speech' | 'overlap' | 'laughter' | 'hold' | 'reaction' | 'merged' の
 * 閉じた union で、**「人が追加した」を表す値が無い**。
 * この値は FCP7 XML のクリップ名に `(${reason})` として現れるため、
 * 何かを選ばざるを得ない。
 *
 * 'hold' を選んだ理由：camera-plan では「そのカメラを明示的に保持する区間」に
 * 使われており、「編集者がこのカメラで固定した」という意図に最も近いため。
 *
 * ★将来 `ShotReason` に 'manual' 等を追加できるようになったら、ここを
 * 差し替えるだけで済むよう1箇所に閉じてある（packages は現在変更禁止）。
 */
export const INSERTED_SHOT_REASON = 'hold';

/**
 * ★常時表示する注意書き。Renderer のフラグではなく Main が本文を持つ。
 *
 * カメラ修正だけが Premiere プロジェクト（FCP7 XML）そのものを書き換える。
 * 字幕（SRT）やショート（CSV）と違い、やり直しの影響が大きいので明示する。
 */
export const EXPORT_NOTICE =
  'カメラ切替の修正は、再出力すると Premiere用の FCP7 XML に反映されます。' +
  '字幕SRT・ショート候補CSVと違い、Premiereプロジェクトの映像トラックそのものが変わります。' +
  '再出力の前に、重なり・隙間の警告が残っていないか確認してください。';

/** 理由の日本語表示。★Renderer に対応表を持たせない。 */
const REASON_LABELS: Record<string, string> = {
  speech: '発話',
  overlap: '同時発話',
  laughter: '笑い',
  hold: 'カメラ維持',
  reaction: 'リアクション',
  merged: '統合',
};

/** カメラの表示名。role から作る。 */
function cameraLabelOf(cameraId: string): string {
  if (cameraId === 'wide') return '引き';
  if (cameraId.startsWith('cam_')) return `寄り${cameraId.slice('cam_'.length)}`;
  return cameraId;
}

function reasonLabelOf(reason: string): string {
  return REASON_LABELS[reason] ?? reason;
}

// ─── 組み立て ──────────────────────────────────────────

/**
 * 切替先に選べるカメラの一覧。
 *
 * ★`generate-premiere-xml.ts` の `videos` と同じ条件で絞る
 * （`role === 'wide' || role.startsWith('cam_')`、id は **role**）。
 * ここがずれると、画面で選べるのに XML 生成が例外を投げる状態になる。
 */
export function cameraOptionsOf(project: ProjectLike): CameraOption[] {
  return project.assets
    .filter((a) => a.role === 'wide' || a.role.startsWith('cam_'))
    .map((a) => ({
      cameraId: a.role,
      label: cameraLabelOf(a.role),
      // ★絶対パスは載せない。表示用のファイル名のみ。
      fileName: a.fileName,
      durationSec: a.durationSec,
    }));
}

/** タイムラインの尺。基準映像（wide）を優先し、無ければ最長の映像素材。 */
export function timelineDurationOf(cameras: readonly CameraOption[]): number {
  const wide = cameras.find((c) => c.cameraId === 'wide');
  if (wide !== undefined && wide.durationSec > 0) return wide.durationSec;
  return cameras.reduce((max, c) => Math.max(max, c.durationSec), 0);
}

function toShotItem(
  resolved: ResolvedCameraShotLike,
  index: number,
  all: readonly ResolvedCameraShotLike[],
  analysisById: ReadonlyMap<string, AnalysisCameraShotLike>,
  reattachedTo: ReadonlyMap<string, ReattachedEditLike>,
  cameraById: ReadonlyMap<string, CameraOption>,
  timelineDurationSec: number,
): CameraShotItem {
  const previous = index > 0 ? all[index - 1] : undefined;
  const analysis = analysisById.get(resolved.id);
  const camera = cameraById.get(resolved.cameraId);
  const durationSec = Math.max(0, resolved.endSec - resolved.startSec);

  const item: CameraShotItem = {
    id: resolved.id,
    startSec: resolved.startSec,
    endSec: resolved.endSec,
    durationSec,
    cameraId: resolved.cameraId,
    cameraLabel: camera?.label ?? cameraLabelOf(resolved.cameraId),
    reason: resolved.reason as CameraShotReasonDto,
    reasonLabel: reasonLabelOf(resolved.reason),
    edited: resolved.edited,
    inserted: resolved.inserted === true,
    overlapsPrevious:
      previous !== undefined && resolved.startSec < previous.endSec - TIME_EPSILON,
    tooShort: durationSec < MIN_CAMERA_SHOT_SEC - TIME_EPSILON,
    // ★素材が見つからない場合も「範囲外」として扱う。放置すると
    //   再出力時に build-project が例外を投げるため、画面で気づけるようにする。
    outOfRange:
      camera === undefined ||
      resolved.endSec > timelineDurationSec + TIME_EPSILON,
  };

  if (previous !== undefined) {
    const gap = resolved.startSec - previous.endSec;
    if (gap > TIME_EPSILON) item.gapBeforeSec = gap;
  }

  if (analysis !== undefined) {
    item.analysisCameraId = analysis.cameraId;
    item.analysisStartSec = analysis.startSec;
    item.analysisEndSec = analysis.endSec;
  }

  const reattached = reattachedTo.get(resolved.id);
  if (reattached !== undefined) {
    item.reattached = { fromId: reattached.fromId, deltaSec: reattached.deltaSec };
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
): CameraOrphanedEdit[] {
  return orphaned
    .filter((o) => o.kind === 'cameraShot')
    .map((o) => {
      const edit = o.edit as
        | (CameraShotOverrideLike & { deleted?: boolean })
        | undefined;
      const item: CameraOrphanedEdit = {
        originalId: o.originalId,
        reason: o.reason,
      };
      if (o.approxSec !== undefined) item.approxSec = o.approxSec;
      if (edit?.cameraId !== undefined) item.cameraId = edit.cameraId;
      if (edit?.startSec !== undefined) item.startSec = edit.startSec;
      if (edit?.endSec !== undefined) item.endSec = edit.endSec;
      if (edit?.deleted === true) item.deleted = true;
      return item;
    });
}

export function countsOf(
  shots: readonly CameraShotItem[],
  orphaned: readonly unknown[],
  deletedCount: number,
): CameraCounts {
  return {
    shots: shots.length,
    edited: shots.filter((s) => s.edited && !s.inserted).length,
    inserted: shots.filter((s) => s.inserted).length,
    deleted: deletedCount,
    reattached: shots.filter((s) => s.reattached !== undefined).length,
    orphaned: orphaned.length,
    overlaps: shots.filter((s) => s.overlapsPrevious).length,
    gaps: shots.filter((s) => s.gapBeforeSec !== undefined).length,
    tooShort: shots.filter((s) => s.tooShort).length,
    outOfRange: shots.filter((s) => s.outOfRange).length,
  };
}

/** `edits.cameraShots` を安全に取り出す（旧形式・手書きで欠けていても落ちない）。 */
export function cameraEditsOf(edits: EditsLike): CameraEditsLike {
  const raw = edits.cameraShots as Partial<CameraEditsLike> | undefined;
  return {
    overrides:
      raw?.overrides !== undefined && typeof raw.overrides === 'object'
        ? raw.overrides
        : {},
    inserted: Array.isArray(raw?.inserted) ? raw.inserted : [],
    deletedIds: Array.isArray(raw?.deletedIds) ? raw.deletedIds : [],
  };
}

/** カメラ切替の確認に必要な情報だけを組み立てる。★Project全体は返さない。 */
export function buildCameraData(
  projectDir: string,
  deps: ReviewDeps,
): CameraLoadResult {
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

  const cameras = cameraOptionsOf(project);
  const cameraById = new Map(cameras.map((c) => [c.cameraId, c]));
  const timelineDurationSec = timelineDurationOf(cameras);

  const analysisById = new Map(normalized.cameraShots.map((s) => [s.id, s]));
  // 再接続は「移動先のID」で引けるようにする。
  const reattachedTo = new Map(
    result.reattached
      .filter((r) => r.kind === 'cameraShot')
      .map((r) => [r.toId, r]),
  );

  const resolvedShots = result.resolved.cameraShots ?? [];
  const shots = resolvedShots.map((shot, index) =>
    toShotItem(
      shot,
      index,
      resolvedShots,
      analysisById,
      reattachedTo,
      cameraById,
      timelineDurationSec,
    ),
  );
  const orphaned = toOrphaned(result.orphaned);
  const edits = cameraEditsOf(project.edits);

  const data: CameraData = {
    summary: summaryOf(project, projectDir, loaded.value.notes ?? []),
    updatedAt: project.updatedAt,
    cameras,
    shots,
    counts: countsOf(shots, orphaned, edits.deletedIds.length),
    orphaned,
    timelineDurationSec,
    minShotSec: MIN_CAMERA_SHOT_SEC,
    exportNotice: EXPORT_NOTICE,
  };

  // ★common モードでは XML 側の時刻が共通区間の開始分だけ前に詰められる。
  //   画面は常に解析時刻で表示するので、その差を明示する。
  const syncMode = (project.sync as { mode?: unknown } | undefined)?.mode;
  if (syncMode === 'common') {
    data.syncModeNotice =
      '同期モードが「共通区間（common）」のため、書き出したXML上の時刻は' +
      'この画面の表示より前に詰められます。カットの前後関係は変わりません。';
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
    DESKTOP_ERROR_CODES.CAMERA_SHOT_NOT_FOUND,
    '対象のカットが見つかりませんでした。',
    { recoverable: true, suggestedAction: '再読み込みしてください。' },
  );
}

function invalidRequest(
  userMessage: string,
  suggestedAction?: string,
): SafePipelineError {
  return safeError(DESKTOP_ERROR_CODES.INVALID_REQUEST, userMessage, {
    recoverable: true,
    ...(suggestedAction !== undefined ? { suggestedAction } : {}),
  });
}

interface LoadedForSave {
  project: ProjectLike;
  edits: CameraEditsLike;
  /** 解析＋人が追加したカット（＝IDで引ける全カット）。 */
  analysisShots: AnalysisCameraShotLike[];
}

/**
 * 読み込み・競合検出・解析の有無をまとめて行い、カメラ固有の断片を取り出す。
 * ★共通部分（読み込み・競合・解析の有無）は `review-common.ts` に集約済み。
 */
function loadForSave(
  projectPath: string,
  expectedUpdatedAt: string,
  deps: ReviewDeps,
): { ok: true; value: LoadedForSave } | { ok: false; result: SaveCameraEditResult } {
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
      edits: cameraEditsOf(project.edits),
      analysisShots: loaded.analysis.cameraShots ?? [],
    },
  };
}

/**
 * 適用後の並びを組み立てる。
 *
 * ★`resolveProject` と同じ順序で組み立てる（削除を除く → override を当てる
 * → inserted を足して時刻順）。ここがずれると、画面の整合性チェックと
 * 実際にXMLへ出る並びが食い違う。
 */
export function previewShots(
  analysisShots: readonly AnalysisCameraShotLike[],
  edits: CameraEditsLike,
): { id: string; startSec: number; endSec: number; cameraId: string }[] {
  const deleted = new Set(edits.deletedIds);
  const shots = analysisShots
    .filter((s) => !deleted.has(s.id))
    .map((s) => {
      const override = edits.overrides[s.id];
      return {
        id: s.id,
        startSec: override?.startSec ?? s.startSec,
        endSec: override?.endSec ?? s.endSec,
        cameraId: override?.cameraId ?? s.cameraId,
      };
    });
  for (const inserted of edits.inserted) {
    shots.push({
      id: inserted.id,
      startSec: inserted.startSec,
      endSec: inserted.endSec,
      cameraId: inserted.cameraId,
    });
  }
  return shots.sort((a, b) => a.startSec - b.startSec);
}

/**
 * 適用後の並びが FCP7 XML を壊さないかを確かめる。
 *
 * ★保存を通す前に必ず呼ぶ。ここを抜けると再出力が失敗するか、
 * 保存したカットが黙って消える。
 */
export function assertTimelineSafe(
  analysisShots: readonly AnalysisCameraShotLike[],
  edits: CameraEditsLike,
  cameras: readonly CameraOption[],
  timelineDurationSec: number,
): SafePipelineError | undefined {
  const shots = previewShots(analysisShots, edits);

  if (shots.length === 0) {
    return invalidRequest(
      'カットが1つも残りません。',
      '少なくとも1つのカットを残してください。すべて消すと映像トラックが空になります。',
    );
  }

  const known = new Set(cameras.map((c) => c.cameraId));
  for (const shot of shots) {
    if (!known.has(shot.cameraId)) {
      // ★通すと build-project.ts が例外を投げ、再出力ごと失敗する。
      return invalidRequest(
        `カット ${shot.id} のカメラ「${shot.cameraId}」がこのプロジェクトにありません。`,
        '素材登録画面で、その役割の映像素材が登録されているか確認してください。',
      );
    }
    const range = validateShotRange(shot.startSec, shot.endSec, {
      maxSec: timelineDurationSec,
    });
    if (!range.ok) return range.error;
  }

  const overlap = validateNoOverlap(shots);
  if (!overlap.ok) return overlap.error;

  return undefined;
}

/**
 * 保存し、読み直して**並び全体**を返す。
 *
 * ★保存と読み直しは `review-common.ts` の `saveAndRebuild` に任せる。
 * ★ただし結果の形はカメラ固有：字幕・ショート・マーカーが「1要素」を返すのに対し、
 * カメラは追加・削除・時間変更が隣のカットの重なり・隙間まで変えるため
 * **並び全体**を返す。この違いがあるので結果の組み立ては共通化していない。
 */
function persistAndReload(
  projectDir: string,
  nextProject: ProjectLike,
  deps: ReviewDeps,
): SaveCameraEditResult {
  const reloaded = saveAndRebuild(
    projectDir,
    nextProject,
    deps,
    SAVE_FAILED_EDIT,
    buildCameraData,
  );
  if (!reloaded.ok) return { ok: false, error: reloaded.error };

  return {
    ok: true,
    updatedAt: reloaded.data.updatedAt,
    shots: reloaded.data.shots,
    counts: reloaded.data.counts,
    orphaned: reloaded.data.orphaned,
  };
}

/** `edits.cameraShots` だけを差し替えた Project を作る。★他レイヤーは触らない。 */
function withCameraEdits(
  project: ProjectLike,
  edits: EditsLike,
  cameraEdits: CameraEditsLike,
): ProjectLike {
  return {
    ...project,
    edits: { ...edits, cameraShots: cameraEdits as unknown as CameraEditsLike },
  };
}

/**
 * 既存カットを変更する。
 *
 * ★書き換えるのは `edits.cameraShots.overrides` と `edits.history` だけ。
 */
export function applyCameraShotEdit(
  request: {
    projectPath: string;
    shotId: string;
    expectedUpdatedAt: string;
    patch: CameraShotPatch;
  },
  deps: ReviewDeps,
): SaveCameraEditResult {
  const loaded = loadForSave(request.projectPath, request.expectedUpdatedAt, deps);
  if (!loaded.ok) return loaded.result;
  const { project, edits, analysisShots } = loaded.value;

  const cameras = cameraOptionsOf(project);
  const timelineDurationSec = timelineDurationOf(cameras);

  // 変更対象は解析側のカットか、人が追加したカットのどちらか。
  const target = analysisShots.find((s) => s.id === request.shotId);
  const insertedIndex = edits.inserted.findIndex((s) => s.id === request.shotId);
  if (target === undefined && insertedIndex === -1) {
    return { ok: false, error: notFound() };
  }
  if (edits.deletedIds.includes(request.shotId)) {
    return {
      ok: false,
      error: invalidRequest(
        'このカットは削除済みです。',
        '先に削除を取り消してから変更してください。',
      ),
    };
  }

  let history = project.edits;
  const nextEdits: CameraEditsLike = {
    overrides: { ...edits.overrides },
    inserted: [...edits.inserted],
    deletedIds: [...edits.deletedIds],
  };

  const record = (field: string, before: unknown, after: unknown) => {
    history = deps.recordEdit(history, {
      kind: 'cameraShot',
      targetId: request.shotId,
      field,
      before: before ?? null,
      after: after ?? null,
    });
  };

  if (insertedIndex >= 0) {
    // ★人が追加したカットは overrides を使わず、inserted の中身を直接直す。
    //   overrides は解析側のIDにしか当たらないため（resolve.ts の matchEdits）。
    const current = edits.inserted[insertedIndex]!;
    const next = { ...current };
    if (request.patch.cameraId !== undefined && request.patch.cameraId !== null) {
      if (current.cameraId !== request.patch.cameraId) {
        record('cameraId', current.cameraId, request.patch.cameraId);
      }
      next.cameraId = request.patch.cameraId;
    }
    for (const key of ['startSec', 'endSec'] as const) {
      const value = request.patch[key];
      if (value === undefined || value === null) continue;
      if (current[key] !== value) record(key, current[key], value);
      next[key] = value;
    }
    nextEdits.inserted[insertedIndex] = next;
  } else {
    const existing = edits.overrides[request.shotId];
    const nextOverride: CameraShotOverrideLike = { ...existing };

    for (const key of ['cameraId', 'startSec', 'endSec'] as const) {
      const value = request.patch[key];
      if (value === undefined) continue;
      const before = existing?.[key] ?? target![key];
      if (value === null) {
        // 解析値へ戻す。
        if (existing?.[key] !== undefined) record(key, before, target![key]);
        delete nextOverride[key];
        continue;
      }
      if (before !== value) record(key, before, value);
      (nextOverride as Record<string, unknown>)[key] = value;
    }

    if (Object.keys(nextOverride).length === 0) {
      delete nextEdits.overrides[request.shotId];
    } else {
      nextEdits.overrides[request.shotId] = nextOverride;
    }
  }

  // ★適用後の並びを検査してから保存する。
  const unsafe = assertTimelineSafe(
    analysisShots,
    nextEdits,
    cameras,
    timelineDurationSec,
  );
  if (unsafe !== undefined) return { ok: false, error: unsafe };

  return persistAndReload(
    request.projectPath,
    withCameraEdits(project, history, nextEdits),
    deps,
  );
}

/** 挿入カットのIDを作る。★解析側のIDと衝突しない接頭辞を使う。 */
export function insertedShotId(startSec: number, taken: ReadonlySet<string>): string {
  const key = String(Math.round(startSec * 1000)).padStart(8, '0');
  const base = `${INSERTED_SHOT_PREFIX}${key}`;
  if (!taken.has(base)) return base;
  // 同じ開始時刻に複数追加された場合だけ連番を付ける（字幕IDと同じ考え方）。
  for (let n = 2; n < 10000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/** カットを追加する。★`edits.cameraShots.inserted` にだけ書く。 */
export function insertCameraShot(
  request: {
    projectPath: string;
    expectedUpdatedAt: string;
    startSec: number;
    endSec: number;
    cameraId: string;
  },
  deps: ReviewDeps,
): SaveCameraEditResult {
  const loaded = loadForSave(request.projectPath, request.expectedUpdatedAt, deps);
  if (!loaded.ok) return loaded.result;
  const { project, edits, analysisShots } = loaded.value;

  const cameras = cameraOptionsOf(project);
  const timelineDurationSec = timelineDurationOf(cameras);

  const taken = new Set<string>([
    ...analysisShots.map((s) => s.id),
    ...edits.inserted.map((s) => s.id),
  ]);
  const id = insertedShotId(request.startSec, taken);

  const shot: AnalysisCameraShotLike = {
    id,
    startSec: request.startSec,
    endSec: request.endSec,
    cameraId: request.cameraId,
    // ★暫定措置。詳細は INSERTED_SHOT_REASON のコメントを参照。
    reason: INSERTED_SHOT_REASON,
  };

  const nextEdits: CameraEditsLike = {
    overrides: { ...edits.overrides },
    inserted: [...edits.inserted, shot],
    deletedIds: [...edits.deletedIds],
  };

  const unsafe = assertTimelineSafe(
    analysisShots,
    nextEdits,
    cameras,
    timelineDurationSec,
  );
  if (unsafe !== undefined) return { ok: false, error: unsafe };

  const history = deps.recordEdit(project.edits, {
    kind: 'cameraShot',
    targetId: id,
    field: 'inserted',
    before: null,
    after: shot,
  });

  return persistAndReload(
    request.projectPath,
    withCameraEdits(project, history, nextEdits),
    deps,
  );
}

/** カットを削除する。★解析側は `deletedIds`、追加分は `inserted` から取り除く。 */
export function deleteCameraShot(
  request: { projectPath: string; shotId: string; expectedUpdatedAt: string },
  deps: ReviewDeps,
): SaveCameraEditResult {
  const loaded = loadForSave(request.projectPath, request.expectedUpdatedAt, deps);
  if (!loaded.ok) return loaded.result;
  const { project, edits, analysisShots } = loaded.value;

  const cameras = cameraOptionsOf(project);
  const timelineDurationSec = timelineDurationOf(cameras);

  const insertedIndex = edits.inserted.findIndex((s) => s.id === request.shotId);
  const inAnalysis = analysisShots.some((s) => s.id === request.shotId);
  if (insertedIndex === -1 && !inAnalysis) {
    return { ok: false, error: notFound() };
  }
  if (edits.deletedIds.includes(request.shotId)) {
    return { ok: false, error: invalidRequest('このカットはすでに削除済みです。') };
  }

  const nextEdits: CameraEditsLike = {
    overrides: { ...edits.overrides },
    inserted: [...edits.inserted],
    deletedIds: [...edits.deletedIds],
  };

  let before: unknown;
  if (insertedIndex >= 0) {
    // 人が追加したカットは、記録ごと取り除く（deletedIds には積まない）。
    before = edits.inserted[insertedIndex];
    nextEdits.inserted.splice(insertedIndex, 1);
  } else {
    before = analysisShots.find((s) => s.id === request.shotId);
    nextEdits.deletedIds.push(request.shotId);
    // 変更が残っていても意味を失うので併せて外す。
    delete nextEdits.overrides[request.shotId];
  }

  const unsafe = assertTimelineSafe(
    analysisShots,
    nextEdits,
    cameras,
    timelineDurationSec,
  );
  if (unsafe !== undefined) return { ok: false, error: unsafe };

  const history = deps.recordEdit(project.edits, {
    kind: 'cameraShot',
    targetId: request.shotId,
    field: 'deleted',
    before: before ?? null,
    after: null,
  });

  return persistAndReload(
    request.projectPath,
    withCameraEdits(project, history, nextEdits),
    deps,
  );
}

/**
 * そのカットに関する人間の修正をすべて取り消す。
 * `overrides` / `inserted` / `deletedIds` のどこにあっても取り除く。
 */
export function removeCameraEdit(
  request: { projectPath: string; shotId: string; expectedUpdatedAt: string },
  deps: ReviewDeps,
): SaveCameraEditResult {
  const loaded = loadForSave(request.projectPath, request.expectedUpdatedAt, deps);
  if (!loaded.ok) return loaded.result;
  const { project, edits, analysisShots } = loaded.value;

  const cameras = cameraOptionsOf(project);
  const timelineDurationSec = timelineDurationOf(cameras);

  const override = edits.overrides[request.shotId];
  const insertedIndex = edits.inserted.findIndex((s) => s.id === request.shotId);
  const deletedIndex = edits.deletedIds.indexOf(request.shotId);

  if (override === undefined && insertedIndex === -1 && deletedIndex === -1) {
    return { ok: false, error: notFound() };
  }

  const nextEdits: CameraEditsLike = {
    overrides: { ...edits.overrides },
    inserted: [...edits.inserted],
    deletedIds: [...edits.deletedIds],
  };

  const before: Record<string, unknown> = {};
  if (override !== undefined) {
    before.override = override;
    delete nextEdits.overrides[request.shotId];
  }
  if (insertedIndex >= 0) {
    before.inserted = edits.inserted[insertedIndex];
    nextEdits.inserted.splice(insertedIndex, 1);
  }
  if (deletedIndex >= 0) {
    before.deleted = true;
    nextEdits.deletedIds.splice(deletedIndex, 1);
  }

  const unsafe = assertTimelineSafe(
    analysisShots,
    nextEdits,
    cameras,
    timelineDurationSec,
  );
  if (unsafe !== undefined) return { ok: false, error: unsafe };

  const history = deps.recordEdit(project.edits, {
    kind: 'cameraShot',
    targetId: request.shotId,
    field: 'removed',
    before,
    after: null,
  });

  return persistAndReload(
    request.projectPath,
    withCameraEdits(project, history, nextEdits),
    deps,
  );
}
