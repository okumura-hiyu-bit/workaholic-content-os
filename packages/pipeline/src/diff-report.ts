/**
 * 再解析後、人間の修正がどうなったかをレポートする。
 *
 * ★競合時はAI結果を自動採用せず、人間の修正を優先する。
 * `resolveProject`（core）自体がすでにその原則で動く（edits の値が常に勝つ）。
 * このファイルはその上に「何が起きたか」を人間に説明するための差分を足す。
 *
 * @see docs/14-pipeline.md
 */

import { resolveProject } from '../../core/src/resolve.ts';
import type { AnalysisLayer, EditsLayer } from '../../core/src/project.ts';
import { canonicalize } from './hash.ts';
import type {
  ConflictedEditReport,
  OrphanedEditReport,
  ReattachedEditReport,
  ResolveDiffReport,
} from './types.ts';

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

function diffIds(
  category: string,
  oldIds: readonly string[],
  newIds: readonly string[],
): { added: string[]; removed: string[] } {
  const oldSet = new Set(oldIds);
  const newSet = new Set(newIds);
  return {
    added: newIds.filter((id) => !oldSet.has(id)).map((id) => `${category}:${id}`),
    removed: oldIds.filter((id) => !newSet.has(id)).map((id) => `${category}:${id}`),
  };
}

/**
 * ある要素について、人間の修正が「まだ的を射ているか」を調べる。
 *
 * 同じIDが新旧どちらの解析結果にも存在し、かつ編集対象ではない部分の値が
 * 変わっている場合を競合とみなす。人間の修正は常に適用されるが
 * （resolveProjectの原則）、「AIの提案は変わったのに気づかず古い修正のまま」
 * という状態を検知するためのもの。
 */
function findConflicts<T extends { id: string }>(
  category: string,
  editedIds: readonly string[],
  oldItems: readonly T[],
  newItems: readonly T[],
  valueOf: (item: T) => unknown,
  editValueOf: (id: string) => unknown,
): ConflictedEditReport[] {
  const oldMap = byId(oldItems);
  const newMap = byId(newItems);
  const conflicts: ConflictedEditReport[] = [];

  for (const id of editedIds) {
    const oldItem = oldMap.get(id);
    const newItem = newMap.get(id);
    if (!oldItem || !newItem) continue; // orphaned側で扱う

    const oldValue = canonicalize(valueOf(oldItem));
    const newValue = canonicalize(valueOf(newItem));
    if (oldValue !== newValue) {
      conflicts.push({
        kind: category,
        id,
        previousAnalysisValue: valueOf(oldItem),
        currentAnalysisValue: valueOf(newItem),
        humanEdit: editValueOf(id),
      });
    }
  }
  return conflicts;
}

/**
 * 再解析前後の解析結果と、人間の修正レイヤーから差分レポートを作る。
 *
 * `oldAnalysis` が undefined（初回解析）の場合、再接続・孤立・競合は
 * すべて空になる（比較対象が無いため）。
 */
export function buildResolveDiffReport(
  oldAnalysis: AnalysisLayer | undefined,
  newAnalysis: AnalysisLayer,
  edits: EditsLayer,
): ResolveDiffReport {
  if (!oldAnalysis) {
    return { reconnected: [], orphaned: [], conflicted: [], added: [], removed: [] };
  }

  const { orphaned, reattached } = resolveProject(newAnalysis, edits);

  const reconnected: ReattachedEditReport[] = reattached.map((r) => ({
    kind: r.kind,
    fromId: r.fromId,
    toId: r.toId,
    deltaSec: r.deltaSec,
  }));

  const orphanedReport: OrphanedEditReport[] = orphaned.map((o) => ({
    kind: o.kind,
    originalId: o.originalId,
    approxSec: o.approxSec,
    reason: o.reason,
  }));

  const conflicted: ConflictedEditReport[] = [
    ...findConflicts(
      'subtitle',
      Object.keys(edits.subtitles),
      oldAnalysis.subtitles,
      newAnalysis.subtitles,
      (c) => ({ lines: c.lines, speakerId: c.speakerId }),
      (id) => edits.subtitles[id],
    ),
    ...findConflicts(
      'cameraShot',
      Object.keys(edits.cameraShots.overrides),
      oldAnalysis.cameraShots,
      newAnalysis.cameraShots,
      (s) => ({ cameraId: s.cameraId, startSec: s.startSec, endSec: s.endSec }),
      (id) => edits.cameraShots.overrides[id],
    ),
    ...findConflicts(
      'chapter',
      Object.keys(edits.chapters),
      oldAnalysis.chapters,
      newAnalysis.chapters,
      (c) => ({ title: c.title }),
      (id) => edits.chapters[id],
    ),
    ...findConflicts(
      'marker',
      Object.keys(edits.markers),
      oldAnalysis.markers,
      newAnalysis.markers,
      (m) => ({ name: m.name, comment: m.comment }),
      (id) => edits.markers[id],
    ),
  ];

  const idDiffs = [
    diffIds(
      'subtitle',
      oldAnalysis.subtitles.map((c) => c.id),
      newAnalysis.subtitles.map((c) => c.id),
    ),
    diffIds(
      'cameraShot',
      oldAnalysis.cameraShots.map((s) => s.id),
      newAnalysis.cameraShots.map((s) => s.id),
    ),
    diffIds(
      'chapter',
      oldAnalysis.chapters.map((c) => c.id),
      newAnalysis.chapters.map((c) => c.id),
    ),
    diffIds(
      'marker',
      oldAnalysis.markers.map((m) => m.id),
      newAnalysis.markers.map((m) => m.id),
    ),
    diffIds(
      'short',
      oldAnalysis.shortCandidates.map((s) => s.id),
      newAnalysis.shortCandidates.map((s) => s.id),
    ),
  ];

  return {
    reconnected,
    orphaned: orphanedReport,
    conflicted,
    added: idDiffs.flatMap((d) => d.added),
    removed: idDiffs.flatMap((d) => d.removed),
  };
}
