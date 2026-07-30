/**
 * 解析レイヤーと人間修正レイヤーを突き合わせ、実際に使う値を得る。
 *
 * ★再解析しても人間の修正が消えない仕組みの中核。
 *
 * 修正はIDで紐づくが、再解析で時刻が数フレームずれるとIDが変わる。
 * そのため「IDが完全一致 → 時刻が近いものに再接続」の2段で照合し、
 * どちらでも繋がらなかった修正は**捨てずに orphaned として返す**。
 * 黙って落とすと、編集者は自分の修正が消えたことに気づけない。
 *
 * @see docs/13-gui-mvp.md
 */

import {
  timeFromId,
  type AnalysisLayer,
  type CameraShotOverride,
  type EditsLayer,
  type IdentifiedCameraShot,
  type IdentifiedChapter,
  type IdentifiedMarker,
  type IdentifiedShortCandidate,
  type IdentifiedSubtitleCue,
  type ShortDecision,
  type SubtitleEdit,
} from './project.ts';

export interface ResolveOptions {
  /**
   * IDが一致しない修正を、この秒数以内の要素に再接続する。
   * 既定0.5秒。再解析で境界が多少動いても追随できる幅。
   */
  reattachToleranceSec: number;
}

export const DEFAULT_RESOLVE_OPTIONS: ResolveOptions = {
  reattachToleranceSec: 0.5,
};

/** 繋ぎ先が見つからなかった修正。編集者に必ず知らせる。 */
export interface OrphanedEdit {
  kind: 'subtitle' | 'cameraShot' | 'chapter' | 'marker' | 'short';
  /** 修正が付いていたID。 */
  originalId: string;
  /** IDから読み取れる時刻（分かる場合）。 */
  approxSec?: number;
  edit: unknown;
  reason: string;
}

/** 再接続が起きたことの記録。GUIで「位置が動きました」と示すため。 */
export interface ReattachedEdit {
  kind: OrphanedEdit['kind'];
  fromId: string;
  toId: string;
  deltaSec: number;
}

export interface ResolvedSubtitleCue extends IdentifiedSubtitleCue {
  /** 人が直したか。確認画面で目印にする。 */
  edited: boolean;
}

export interface ResolvedShortCandidate extends IdentifiedShortCandidate {
  /** 未判断は undefined。 */
  adopted?: boolean;
  title?: string;
  hook?: string;
  caption?: string;
  hashtags?: string[];
  note?: string;
  edited: boolean;
}

export interface ResolvedCameraShot extends IdentifiedCameraShot {
  edited: boolean;
  /** 人が追加したカットか。 */
  inserted?: boolean;
}

export interface ResolvedProject {
  subtitles: ResolvedSubtitleCue[];
  cameraShots: ResolvedCameraShot[];
  chapters: (IdentifiedChapter & { edited: boolean })[];
  markers: (IdentifiedMarker & { edited: boolean })[];
  shorts: ResolvedShortCandidate[];
}

export interface ResolveResult {
  resolved: ResolvedProject;
  orphaned: OrphanedEdit[];
  reattached: ReattachedEdit[];
}

/**
 * 修正キーを解析結果の要素に対応づける。
 *
 * 1. IDが完全一致するものを探す
 * 2. 見つからなければ、IDから読み取った時刻に最も近い要素へ（許容範囲内なら）
 */
function matchEdits<T extends { id: string; startSec: number }, E>(
  items: readonly T[],
  edits: Record<string, E>,
  kind: OrphanedEdit['kind'],
  tolerance: number,
): {
  applied: Map<string, E>;
  orphaned: OrphanedEdit[];
  reattached: ReattachedEdit[];
} {
  const byId = new Map(items.map((item) => [item.id, item]));
  const applied = new Map<string, E>();
  const orphaned: OrphanedEdit[] = [];
  const reattached: ReattachedEdit[] = [];
  // 1つの要素に2つの修正が付かないようにする。
  const taken = new Set<string>();

  // まずID完全一致を確定させる。時刻での再接続より優先する。
  const remaining: [string, E][] = [];
  for (const [editId, edit] of Object.entries(edits)) {
    if (byId.has(editId) && !taken.has(editId)) {
      applied.set(editId, edit);
      taken.add(editId);
    } else {
      remaining.push([editId, edit]);
    }
  }

  for (const [editId, edit] of remaining) {
    const approxSec = timeFromId(editId);
    if (approxSec === undefined) {
      orphaned.push({
        kind,
        originalId: editId,
        edit,
        reason: 'IDから時刻を読み取れず、対応先を特定できません',
      });
      continue;
    }

    let best: T | undefined;
    let bestDelta = Infinity;
    for (const item of items) {
      if (taken.has(item.id)) continue;
      const delta = Math.abs(item.startSec - approxSec);
      if (delta < bestDelta) {
        bestDelta = delta;
        best = item;
      }
    }

    if (best && bestDelta <= tolerance) {
      applied.set(best.id, edit);
      taken.add(best.id);
      reattached.push({
        kind,
        fromId: editId,
        toId: best.id,
        deltaSec: Number(bestDelta.toFixed(3)),
      });
    } else {
      orphaned.push({
        kind,
        originalId: editId,
        approxSec,
        edit,
        reason:
          best === undefined
            ? '再解析後の要素が空のため接続先がありません'
            : `最も近い要素まで${bestDelta.toFixed(2)}秒あり、許容範囲（${tolerance}秒）を超えています`,
      });
    }
  }

  return { applied, orphaned, reattached };
}

/**
 * 解析結果に人間の修正を重ねる。
 *
 * ★解析レイヤーと修正レイヤーのどちらも書き換えない（純粋関数）。
 */
export function resolveProject(
  analysis: AnalysisLayer,
  edits: EditsLayer,
  options: Partial<ResolveOptions> = {},
): ResolveResult {
  const tolerance =
    options.reattachToleranceSec ?? DEFAULT_RESOLVE_OPTIONS.reattachToleranceSec;

  const orphaned: OrphanedEdit[] = [];
  const reattached: ReattachedEdit[] = [];

  // ── 字幕 ──────────────────────────────────────────────
  const subtitleMatch = matchEdits<IdentifiedSubtitleCue, SubtitleEdit>(
    analysis.subtitles,
    edits.subtitles,
    'subtitle',
    tolerance,
  );
  orphaned.push(...subtitleMatch.orphaned);
  reattached.push(...subtitleMatch.reattached);

  const subtitles: ResolvedSubtitleCue[] = [];
  for (const cue of analysis.subtitles) {
    const edit = subtitleMatch.applied.get(cue.id);
    if (edit?.deleted) continue;
    subtitles.push({
      ...cue,
      lines: edit?.text !== undefined ? edit.text.split('\n') : cue.lines,
      speakerId: edit?.speakerId ?? cue.speakerId,
      edited: edit !== undefined,
    });
  }

  // ── カメラ切替 ────────────────────────────────────────
  const shotMatch = matchEdits<IdentifiedCameraShot, CameraShotOverride>(
    analysis.cameraShots,
    edits.cameraShots.overrides,
    'cameraShot',
    tolerance,
  );
  orphaned.push(...shotMatch.orphaned);
  reattached.push(...shotMatch.reattached);

  const deleted = new Set(edits.cameraShots.deletedIds);
  const cameraShots: ResolvedCameraShot[] = analysis.cameraShots
    .filter((shot) => !deleted.has(shot.id))
    .map((shot) => {
      const override = shotMatch.applied.get(shot.id);
      return {
        ...shot,
        cameraId: override?.cameraId ?? shot.cameraId,
        startSec: override?.startSec ?? shot.startSec,
        endSec: override?.endSec ?? shot.endSec,
        edited: override !== undefined,
      };
    });

  // 人が追加したカットを混ぜて時刻順に並べる。
  for (const inserted of edits.cameraShots.inserted) {
    cameraShots.push({ ...inserted, edited: true, inserted: true });
  }
  cameraShots.sort((a, b) => a.startSec - b.startSec);

  // 削除指定されたIDが解析結果に存在しない場合も知らせる。
  for (const id of edits.cameraShots.deletedIds) {
    if (!analysis.cameraShots.some((shot) => shot.id === id)) {
      orphaned.push({
        kind: 'cameraShot',
        originalId: id,
        approxSec: timeFromId(id),
        edit: { deleted: true },
        reason: '削除対象のカットが再解析後に存在しません',
      });
    }
  }

  // ── チャプター ────────────────────────────────────────
  const chapterMatch = matchEdits<
    IdentifiedChapter,
    { title?: string; deleted?: boolean }
  >(analysis.chapters, edits.chapters, 'chapter', tolerance);
  orphaned.push(...chapterMatch.orphaned);
  reattached.push(...chapterMatch.reattached);

  const chapters = analysis.chapters
    .filter((chapter) => !chapterMatch.applied.get(chapter.id)?.deleted)
    .map((chapter) => {
      const edit = chapterMatch.applied.get(chapter.id);
      return {
        ...chapter,
        title: edit?.title ?? chapter.title,
        edited: edit !== undefined,
      };
    });

  // ── マーカー ──────────────────────────────────────────
  const markerMatch = matchEdits<
    IdentifiedMarker,
    { name?: string; comment?: string; deleted?: boolean }
  >(analysis.markers, edits.markers, 'marker', tolerance);
  orphaned.push(...markerMatch.orphaned);
  reattached.push(...markerMatch.reattached);

  const markers = analysis.markers
    .filter((marker) => !markerMatch.applied.get(marker.id)?.deleted)
    .map((marker) => {
      const edit = markerMatch.applied.get(marker.id);
      return {
        ...marker,
        name: edit?.name ?? marker.name,
        comment: edit?.comment ?? marker.comment,
        edited: edit !== undefined,
      };
    });

  // ── ショート候補 ──────────────────────────────────────
  // ショートのIDは連番（short_01…）で時刻を含まないため、時刻での
  // 再接続ができない。再解析で候補が変わると採否判断が外れうるので、
  // 繋がらなかったものは必ず orphaned として報告する。
  const shortIds = new Set(analysis.shortCandidates.map((s) => s.id));
  for (const [shortId, decision] of Object.entries(edits.shorts)) {
    if (!shortIds.has(shortId)) {
      orphaned.push({
        kind: 'short',
        originalId: shortId,
        edit: decision,
        reason:
          '再解析でショート候補が変わり、この採否判断の対象がなくなりました',
      });
    }
  }

  const shorts: ResolvedShortCandidate[] = analysis.shortCandidates.map(
    (candidate) => {
      const decision: ShortDecision | undefined = edits.shorts[candidate.id];
      return {
        ...candidate,
        adopted: decision?.adopted,
        title: decision?.title,
        hook: decision?.hook,
        caption: decision?.caption,
        hashtags: decision?.hashtags,
        note: decision?.note,
        edited: decision !== undefined,
      };
    },
  );

  return {
    resolved: { subtitles, cameraShots, chapters, markers, shorts },
    orphaned,
    reattached,
  };
}

/**
 * 修正を記録する。履歴を必ず残し、変更前の値を保持する。
 *
 * ★edits を直接書き換えず、新しいオブジェクトを返す。
 */
export function recordEdit<K extends keyof EditsLayer>(
  edits: EditsLayer,
  entry: {
    kind: 'subtitle' | 'cameraShot' | 'chapter' | 'marker' | 'short' | 'sync';
    targetId: string;
    field: string;
    before: unknown;
    after: unknown;
    actor?: string;
    now?: Date;
  },
): EditsLayer {
  void (null as unknown as K);
  return {
    ...edits,
    history: [
      ...edits.history,
      {
        at: (entry.now ?? new Date()).toISOString(),
        actor: entry.actor ?? 'director',
        kind: entry.kind,
        targetId: entry.targetId,
        field: entry.field,
        before: entry.before,
        after: entry.after,
      },
    ],
  };
}

/** 採用されたショート候補だけを返す。書き出しの対象になる。 */
export function adoptedShorts(
  resolved: ResolvedProject,
): ResolvedShortCandidate[] {
  return resolved.shorts.filter((short) => short.adopted === true);
}
