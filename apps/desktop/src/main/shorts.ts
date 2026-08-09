/**
 * 確認画面（Review）— ショート候補の組み立てと、採否・編集の保存。
 *
 * ★このファイルが守る最重要ルール（review.ts と同一）
 * 1. `project.analysis` を絶対に書き換えない。人間の判断は `project.edits.shorts` にだけ書く。
 * 2. 表示値は `resolveProject()` に作らせる（独自の突き合わせロジックを作らない）。
 * 3. 孤立した判断を黙って捨てない。件数と中身を画面へ返す。
 * 4. 保存は `saveProject()`（一時ファイル→rename）に任せ、書き込み方式を自作しない。
 *
 * ★electron を import しない。fs も直接触らない（すべて注入）。
 * 依存は字幕Reviewと同じ `ReviewDeps` を使い回す。
 *
 * ★ショート固有の事情
 * ショート候補のIDは `short_01` のような連番で時刻を含まない。
 * `resolveProject` は時刻での再接続ができないため、再解析で候補の並びが
 * 変わると採否・編集内容は**必ず** orphaned になる（resolve.ts の仕様）。
 * これは直せない前提なので、画面に常時警告を出す（REANALYSIS_WARNING）。
 */

import type { SafePipelineError } from '../shared/dto.ts';
import { DESKTOP_ERROR_CODES, safeError } from '../shared/errors.ts';
import type {
  SaveShortDecisionResult,
  ShortCandidateItem,
  ShortDecisionPatch,
  ShortsCounts,
  ShortsData,
  ShortsLoadResult,
  ShortsOrphanedDecision,
  ShortsSpeaker,
} from '../shared/shorts-dto.ts';
import type { ReviewMedia } from '../shared/review-dto.ts';
import { conflictError } from '../shared/validate-common.ts';
import {
  analysisNotReadyError,
  loadProjectOrError,
  SAVE_FAILED_DECISION,
  saveAndRebuild,
  summaryOf,
} from './review-common.ts';
import type {
  AnalysisShortCandidateLike,
  EditsLike,
  ProjectLike,
  ResolvedShortLike,
  ReviewDeps,
  ShortDecisionLike,
} from './review.ts';
import { normalizeAnalysis } from './review.ts';

/**
 * ★画面から消せない警告。Renderer のフラグではなく Main が本文を持つ。
 *
 * ショートIDが時刻を含まないことの直接の帰結で、実装で回避できない。
 * 「後で気づく」と採否のやり直しになるため、編集前に必ず見える位置に出す。
 */
export const REANALYSIS_WARNING =
  '再解析すると、ここで付けた採否・タイトル・投稿文などが外れる可能性があります。' +
  'ショート候補のIDは時刻を持たない連番のため、候補の並びが変わると元の候補に繋ぎ直せません。' +
  '外れた内容は消さずに「孤立した判断」として残します。';

/**
 * ★shorts.csv に載らない項目。
 *
 * `save-artifacts.ts`（凍結対象）が書くのは
 * id / startSec / endSec / score / adopted / title / signals の7列だけ。
 * それ以外は project.json にのみ残る。画面で明示しないと
 * 「入力したのに書き出されない」ことに気づけない。
 */
export const FIELDS_NOT_EXPORTED = ['冒頭フック', '投稿文', 'ハッシュタグ', 'メモ'] as const;

/**
 * 判断した時点の候補の区間を履歴に残すときの `field` 名。
 *
 * ★なぜ必要か
 * 再解析で候補が入れ替わっても **IDが残っていれば orphaned にならない**。
 * つまり「short_01 の判断が、別の区間の short_01 に付いたまま」という
 * 静かな取り違えが起きうる。orphaned より気づきにくいぶん危険なので、
 * 最初に判断した時点の区間を履歴へ残し、読み込み時に現在値と比べる。
 *
 * 履歴は追記のみで `field` は自由文字列のため、データモデルは変えていない。
 */
const RANGE_FIELD = 'candidateRange';

interface CandidateRange {
  startSec: number;
  endSec: number;
  score: number;
}

// ─── 組み立て ──────────────────────────────────────────

function rangeOf(candidate: AnalysisShortCandidateLike): CandidateRange {
  return {
    startSec: candidate.startSec,
    endSec: candidate.endSec,
    score: candidate.score,
  };
}

function sameRange(a: CandidateRange, b: CandidateRange): boolean {
  // 秒は浮動小数なので、表示上区別できない差（1ms未満）は同一とみなす。
  return (
    Math.abs(a.startSec - b.startSec) < 0.001 &&
    Math.abs(a.endSec - b.endSec) < 0.001 &&
    a.score === b.score
  );
}

function parseRange(value: unknown): CandidateRange | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (
    typeof v.startSec !== 'number' ||
    typeof v.endSec !== 'number' ||
    typeof v.score !== 'number'
  ) {
    return undefined;
  }
  return { startSec: v.startSec, endSec: v.endSec, score: v.score };
}

/**
 * 「判断した時点の区間」を履歴から取り出す。
 * 最初の1件だけを見る（＝人が最初に判断したときの状態）。
 */
export function decidedRanges(edits: EditsLike): Map<string, CandidateRange> {
  const ranges = new Map<string, CandidateRange>();
  for (const entry of edits.history) {
    if (entry.kind !== 'short' || entry.field !== RANGE_FIELD) continue;
    if (ranges.has(entry.targetId)) continue; // 最初の1件のみ
    const range = parseRange(entry.after);
    if (range !== undefined) ranges.set(entry.targetId, range);
  }
  return ranges;
}

/**
 * 判断した時点から候補の区間・スコアが変わったものを見つける。
 *
 * ★review.ts の detectSubtitleConflicts と同じ考え方。
 * パイプラインの `buildResolveDiffReport` は project.json に結果を残さないため、
 * `recordEdit` が残した履歴を現在の解析値と突き合わせて検出する。
 */
export function detectRangeChanges(
  candidates: readonly AnalysisShortCandidateLike[],
  edits: EditsLike,
): Map<string, CandidateRange> {
  const decided = decidedRanges(edits);
  const changed = new Map<string, CandidateRange>();
  for (const candidate of candidates) {
    const before = decided.get(candidate.id);
    if (before === undefined) continue;
    if (!sameRange(before, rangeOf(candidate))) changed.set(candidate.id, before);
  }
  return changed;
}

function toCandidateItem(
  resolved: ResolvedShortLike,
  rangeChanges: ReadonlyMap<string, CandidateRange>,
): ShortCandidateItem {
  const decidedRange = rangeChanges.get(resolved.id);
  const item: ShortCandidateItem = {
    id: resolved.id,
    startSec: resolved.startSec,
    endSec: resolved.endSec,
    durationSec: Math.max(0, resolved.endSec - resolved.startSec),
    score: resolved.score,
    signals: [...(resolved.signals ?? [])],
    adopted: resolved.adopted,
    edited: resolved.edited,
    rangeChanged: decidedRange !== undefined,
  };
  if (resolved.primarySpeakerId !== undefined) {
    item.primarySpeakerId = resolved.primarySpeakerId;
  }
  if (resolved.transcriptExcerpt !== undefined) {
    item.transcriptExcerpt = resolved.transcriptExcerpt;
  }
  if (resolved.title !== undefined) item.title = resolved.title;
  if (resolved.hook !== undefined) item.hook = resolved.hook;
  if (resolved.caption !== undefined) item.caption = resolved.caption;
  if (resolved.hashtags !== undefined) item.hashtags = [...resolved.hashtags];
  if (resolved.note !== undefined) item.note = resolved.note;
  if (decidedRange !== undefined) item.decidedRange = decidedRange;
  return item;
}

/** ★内容ごと返す。件数だけだと編集者は何を失うのか分からない。 */
function toOrphaned(
  orphaned: { kind: string; originalId: string; edit: unknown; reason: string }[],
): ShortsOrphanedDecision[] {
  return orphaned
    .filter((o) => o.kind === 'short')
    .map((o) => {
      const decision = o.edit as ShortDecisionLike | undefined;
      const item: ShortsOrphanedDecision = {
        originalId: o.originalId,
        reason: o.reason,
        adopted: decision?.adopted,
      };
      if (decision?.title !== undefined) item.title = decision.title;
      if (decision?.hook !== undefined) item.hook = decision.hook;
      if (decision?.caption !== undefined) item.caption = decision.caption;
      if (decision?.hashtags !== undefined) item.hashtags = [...decision.hashtags];
      if (decision?.note !== undefined) item.note = decision.note;
      return item;
    });
}

export function countsOf(
  candidates: readonly ShortCandidateItem[],
  orphaned: readonly unknown[],
): ShortsCounts {
  return {
    candidates: candidates.length,
    adopted: candidates.filter((c) => c.adopted === true).length,
    rejected: candidates.filter((c) => c.adopted === false).length,
    undecided: candidates.filter((c) => c.adopted === undefined).length,
    edited: candidates.filter((c) => c.edited).length,
    orphaned: orphaned.length,
    rangeChanged: candidates.filter((c) => c.rangeChanged).length,
  };
}

/** ショート候補の確認に必要な情報だけを組み立てる。★Project全体は返さない。 */
export function buildShortsData(
  projectDir: string,
  deps: ReviewDeps,
): ShortsLoadResult {
  const loaded = loadProjectOrError(projectDir, deps);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const project = loaded.value.project;
  const analysis = project.analysis;
  if (analysis === undefined || !Array.isArray(analysis.subtitles)) {
    return { ok: false, error: analysisNotReadyError() };
  }

  // ★表示値は resolveProject に作らせる（独自の突き合わせをしない）。
  // 配列が欠けた project.json でも落ちないよう、渡す前に空配列で補う。
  const normalized = normalizeAnalysis(analysis);
  const result = deps.resolveProject(normalized, project.edits);
  const rangeChanges = detectRangeChanges(normalized.shortCandidates, project.edits);

  const candidates = (result.resolved.shorts ?? []).map((short) =>
    toCandidateItem(short, rangeChanges),
  );
  const orphaned = toOrphaned(result.orphaned);

  const speakers: ShortsSpeaker[] = (project.speakers ?? []).map((s) => ({
    id: s.id,
    name: s.name,
  }));

  const data: ShortsData = {
    summary: summaryOf(project, projectDir, loaded.value.notes ?? []),
    updatedAt: project.updatedAt,
    speakers,
    candidates,
    counts: countsOf(candidates, orphaned),
    orphaned,
    reanalysisWarning: REANALYSIS_WARNING,
    fieldsNotExported: FIELDS_NOT_EXPORTED,
    timecodeEditingSupported: false,
  };

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
    DESKTOP_ERROR_CODES.SHORT_NOT_FOUND,
    '対象のショート候補が見つかりませんでした。',
    { recoverable: true, suggestedAction: '再読み込みしてください。' },
  );
}

/** patch の1項目を edits へ適用し、値が変わっていれば履歴を残す。 */
function applyField<K extends keyof ShortDecisionLike>(
  field: K,
  patchValue: ShortDecisionLike[K] | null | undefined,
  existing: ShortDecisionLike | undefined,
  next: ShortDecisionLike,
  shortId: string,
  edits: EditsLike,
  deps: ReviewDeps,
): EditsLike {
  if (patchValue === undefined) return edits;

  const before = existing?.[field];
  const after = patchValue === null ? undefined : patchValue;

  // 配列（hashtags）も含めて比較したいので JSON で突き合わせる。
  if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) {
    if (after === undefined) delete next[field];
    else next[field] = after;
    return edits;
  }

  if (after === undefined) delete next[field];
  else next[field] = after;

  return deps.recordEdit(edits, {
    kind: 'short',
    targetId: shortId,
    field: String(field),
    before: before ?? null,
    after: after ?? null,
  });
}

/**
 * ショート候補の採否・編集を保存する。
 *
 * ★analysis には一切触れない。書き換えるのは `project.edits.shorts` と
 * `project.edits.history` だけ。
 * ★保存前に updatedAt を照合し、食い違えば上書きせず競合として返す。
 */
export function applyShortDecision(
  request: {
    projectPath: string;
    shortId: string;
    expectedUpdatedAt: string;
    patch: ShortDecisionPatch;
  },
  deps: ReviewDeps,
): SaveShortDecisionResult {
  const loaded = loadProjectOrError(request.projectPath, deps);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const project = loaded.value.project;

  // ★競合更新の検出。読み込み後に別処理が更新していたら上書きしない。
  if (project.updatedAt !== request.expectedUpdatedAt) {
    return { ok: false, conflict: true, error: conflictError() };
  }

  const analysis = project.analysis;
  if (analysis === undefined) return { ok: false, error: analysisNotReadyError() };

  const candidates = analysis.shortCandidates ?? [];
  const target = candidates.find((c) => c.id === request.shortId);
  // ★解析に無いIDへは保存しない。存在しない候補への判断を作ると
  //   次の読み込みで即 orphaned になり、書いた本人にも理由が分からない。
  if (target === undefined) return { ok: false, error: notFound() };

  const existing = project.edits.shorts[request.shortId];
  const next: ShortDecisionLike = { ...existing };
  let edits = project.edits;

  edits = applyField('adopted', request.patch.adopted, existing, next, request.shortId, edits, deps);
  edits = applyField('title', request.patch.title, existing, next, request.shortId, edits, deps);
  edits = applyField('hook', request.patch.hook, existing, next, request.shortId, edits, deps);
  edits = applyField('caption', request.patch.caption, existing, next, request.shortId, edits, deps);
  edits = applyField('hashtags', request.patch.hashtags, existing, next, request.shortId, edits, deps);
  edits = applyField('note', request.patch.note, existing, next, request.shortId, edits, deps);

  // ★初回の判断時に、その時点の区間を履歴へ残す（取り違えの検出用）。
  // 2回目以降は残さない。「最初に判断したときの状態」を基準にしたいため。
  if (!decidedRanges(project.edits).has(request.shortId)) {
    edits = deps.recordEdit(edits, {
      kind: 'short',
      targetId: request.shortId,
      field: RANGE_FIELD,
      before: null,
      after: rangeOf(target),
    });
  }

  // ★ここだけが書き換わる。analysis も他のレイヤーも触らない。
  const nextProject: ProjectLike = {
    ...project,
    edits: {
      ...edits,
      shorts: { ...edits.shorts, [request.shortId]: next },
    },
  };

  return persistAndReload(request.projectPath, nextProject, request.shortId, deps);
}

/** ショート候補の判断を取り消す（未判断・未入力の状態に戻す）。 */
export function removeShortDecision(
  request: { projectPath: string; shortId: string; expectedUpdatedAt: string },
  deps: ReviewDeps,
): SaveShortDecisionResult {
  const loaded = loadProjectOrError(request.projectPath, deps);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const project = loaded.value.project;
  if (project.updatedAt !== request.expectedUpdatedAt) {
    return { ok: false, conflict: true, error: conflictError() };
  }

  const existing = project.edits.shorts[request.shortId];
  if (existing === undefined) return { ok: false, error: notFound() };

  const edits = deps.recordEdit(project.edits, {
    kind: 'short',
    targetId: request.shortId,
    field: 'removed',
    before: existing,
    after: null,
  });

  const nextShorts = { ...edits.shorts };
  delete nextShorts[request.shortId];

  const nextProject: ProjectLike = {
    ...project,
    edits: { ...edits, shorts: nextShorts },
  };

  return persistAndReload(request.projectPath, nextProject, request.shortId, deps);
}

/**
 * 保存し、読み直して結果を組み立てる。
 *
 * ★保存と読み直しは `review-common.ts` の `saveAndRebuild` に任せる。
 * ここが持つのは**ショート候補固有の結果の形**（1要素を返す）だけ。
 */
function persistAndReload(
  projectDir: string,
  nextProject: ProjectLike,
  shortId: string,
  deps: ReviewDeps,
): SaveShortDecisionResult {
  const reloaded = saveAndRebuild(
    projectDir,
    nextProject,
    deps,
    SAVE_FAILED_DECISION,
    buildShortsData,
  );
  if (!reloaded.ok) return { ok: false, error: reloaded.error };

  const candidate = reloaded.data.candidates.find((c) => c.id === shortId);
  if (candidate === undefined) return { ok: false, error: notFound() };

  return {
    ok: true,
    updatedAt: reloaded.data.updatedAt,
    candidate,
    counts: reloaded.data.counts,
  };
}
