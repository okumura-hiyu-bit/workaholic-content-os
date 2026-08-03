/**
 * 確認画面（Review）のデータ組み立てと、字幕修正の保存。
 *
 * ★このファイルが守る最重要ルール
 * 1. `project.analysis` を絶対に書き換えない。人間の修正は `project.edits` にだけ書く。
 * 2. 表示値は `resolveProject()` に作らせる（独自の突き合わせロジックを作らない）。
 * 3. 孤立修正・競合修正を黙って捨てない。件数と中身を画面へ返す。
 * 4. 保存は `saveProject()`（一時ファイル→rename）に任せ、書き込み方式を自作しない。
 *
 * ★electron を import しない。fs も直接触らない（すべて注入）。
 * Electronを起動せずに保存の筋道を検証できるようにするため。
 */

import type { ProjectSummary, SafePipelineError } from '../shared/dto.ts';
import { DESKTOP_ERROR_CODES, safeError } from '../shared/errors.ts';
import type {
  ReviewConflictedEdit,
  ReviewCounts,
  ReviewData,
  ReviewLoadResult,
  ReviewMedia,
  ReviewOrphanedEdit,
  ReviewSpeaker,
  ReviewSubtitleCue,
  SaveSubtitleEditResult,
  SubtitleEditPatch,
} from '../shared/review-dto.ts';
import { conflictError } from '../shared/review-validate.ts';

// ─── 依存（core の関数を注入で受け取る）──────────────────

/** `@contentos/core` の型のうち、ここで使う部分だけを緩く写したもの。 */
export interface AnalysisSubtitleLike {
  id: string;
  startSec: number;
  endSec: number;
  lines: string[];
  speakerId?: string;
  lowConfidenceWords?: { text: string; probability: number }[];
}

export interface SubtitleEditLike {
  text?: string;
  speakerId?: string;
  deleted?: boolean;
}

export interface EditHistoryEntryLike {
  at: string;
  actor: string;
  kind: string;
  targetId: string;
  field: string;
  before: unknown;
  after: unknown;
}

export interface EditsLike {
  subtitles: Record<string, SubtitleEditLike>;
  history: EditHistoryEntryLike[];
  [key: string]: unknown;
}

export interface ProjectLike {
  id: string;
  name: string;
  status: string;
  updatedAt: string;
  recordedAt?: string;
  assets: { id: string; role: string; fileName: string; absolutePath: string; hasAudio: boolean; durationSec: number }[];
  speakers: { id: string; name: string; title?: string }[];
  analysis?: { subtitles: AnalysisSubtitleLike[] };
  edits: EditsLike;
  [key: string]: unknown;
}

export interface ResolvedSubtitleLike {
  id: string;
  startSec: number;
  endSec: number;
  lines: string[];
  speakerId?: string;
  lowConfidenceWords?: { text: string; probability: number }[];
  edited: boolean;
}

export interface ResolveResultLike {
  resolved: { subtitles: ResolvedSubtitleLike[] };
  orphaned: {
    kind: string;
    originalId: string;
    approxSec?: number;
    edit: unknown;
    reason: string;
  }[];
  reattached: unknown[];
}

export interface ReviewDeps {
  /** `@contentos/core` の loadProject。 */
  loadProject(projectDir: string): { project: ProjectLike; notes?: string[] };
  /** `@contentos/core` の saveProject。 */
  saveProject(projectDir: string, project: ProjectLike): string;
  /** `@contentos/core` の resolveProject。 */
  resolveProject(
    analysis: { subtitles: AnalysisSubtitleLike[] },
    edits: EditsLike,
  ): ResolveResultLike;
  /** `@contentos/core` の recordEdit。履歴を必ず残すためこれを使う。 */
  recordEdit(
    edits: EditsLike,
    entry: {
      kind: 'subtitle';
      targetId: string;
      field: string;
      before: unknown;
      after: unknown;
    },
  ): EditsLike;
  /** 再生用プレビューの用意。未生成なら undefined を返してよい（必須ではない）。 */
  prepareMedia?(project: ProjectLike, projectDir: string): ReviewMedia | undefined;
  now?(): Date;
}

// ─── 組み立て ──────────────────────────────────────────

function textOf(lines: readonly string[]): string {
  return lines.join('\n');
}

function minProbability(
  words: readonly { probability: number }[] | undefined,
): number | undefined {
  if (words === undefined || words.length === 0) return undefined;
  return words.reduce((min, w) => Math.min(min, w.probability), 1);
}

/**
 * 修正後に解析結果が変わったキューを見つける。
 *
 * ★なぜ履歴を使うのか
 * パイプラインの `buildResolveDiffReport` は「再解析の前後の解析結果」を
 * 比べて競合を出すが、その結果は project.json に残らない。確認画面を開く
 * 時点では旧解析が手元に無い。
 *
 * 代わりに `recordEdit` が残した履歴の `before`（修正した時点の解析値）を
 * 現在の解析値と比べる。ズレていれば「修正後に解析が変わった」＝競合で、
 * これは buildResolveDiffReport が検出したいものと同じ状況を指す。
 */
export function detectSubtitleConflicts(
  analysisSubtitles: readonly AnalysisSubtitleLike[],
  edits: EditsLike,
): ReviewConflictedEdit[] {
  const byId = new Map(analysisSubtitles.map((cue) => [cue.id, cue]));
  const conflicts: ReviewConflictedEdit[] = [];

  for (const [subtitleId, edit] of Object.entries(edits.subtitles)) {
    if (edit.text === undefined) continue;
    const cue = byId.get(subtitleId);
    if (cue === undefined) continue; // 孤立側で扱う

    // この字幕の本文修正のうち、いちばん古い履歴の before が
    // 「人が直す前の解析値」。それを現在の解析値と比べる。
    const first = edits.history.find(
      (h) => h.kind === 'subtitle' && h.targetId === subtitleId && h.field === 'text',
    );
    if (first === undefined) continue;

    const previous = typeof first.before === 'string' ? first.before : undefined;
    if (previous === undefined) continue;

    const current = textOf(cue.lines);
    if (previous !== current) {
      conflicts.push({
        subtitleId,
        approxSec: cue.startSec,
        humanText: edit.text,
        previousAnalysisText: previous,
        currentAnalysisText: current,
      });
    }
  }
  return conflicts;
}

/** 同じIDのキューが複数あるIDの集合。 */
export function duplicateSubtitleIds(
  subtitles: readonly { id: string }[],
): Set<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const cue of subtitles) {
    if (seen.has(cue.id)) duplicated.add(cue.id);
    seen.add(cue.id);
  }
  return duplicated;
}

function toReviewCue(
  resolved: ResolvedSubtitleLike,
  analysisById: Map<string, AnalysisSubtitleLike>,
  conflictedIds: ReadonlySet<string>,
  duplicatedIds: ReadonlySet<string>,
): ReviewSubtitleCue {
  const analysis = analysisById.get(resolved.id);
  const words = resolved.lowConfidenceWords ?? [];
  const duplicateId = duplicatedIds.has(resolved.id);

  const cue: ReviewSubtitleCue = {
    id: resolved.id,
    startSec: resolved.startSec,
    endSec: resolved.endSec,
    text: textOf(resolved.lines),
    lowConfidenceWords: words.map((w) => ({ text: w.text, probability: w.probability })),
    edited: resolved.edited,
    conflicted: conflictedIds.has(resolved.id),
    analysisText: analysis ? textOf(analysis.lines) : textOf(resolved.lines),
    duplicateId,
    editable: !duplicateId,
  };
  if (resolved.speakerId !== undefined) cue.speakerId = resolved.speakerId;
  if (analysis?.speakerId !== undefined) cue.analysisSpeakerId = analysis.speakerId;
  const min = minProbability(words);
  if (min !== undefined) cue.minProbability = min;
  return cue;
}

function toOrphaned(
  orphaned: ResolveResultLike['orphaned'],
): ReviewOrphanedEdit[] {
  return orphaned
    .filter((o) => o.kind === 'subtitle')
    .map((o) => {
      const edit = o.edit as SubtitleEditLike | undefined;
      const item: ReviewOrphanedEdit = {
        kind: o.kind,
        originalId: o.originalId,
        reason: o.reason,
      };
      if (o.approxSec !== undefined) item.approxSec = o.approxSec;
      // ★内容ごと返す。件数だけだと編集者は何を失うのか分からない。
      if (edit?.text !== undefined) item.text = edit.text;
      if (edit?.speakerId !== undefined) item.speakerId = edit.speakerId;
      return item;
    });
}

function summaryOf(project: ProjectLike, projectDir: string, notes: string[]): ProjectSummary {
  const summary: ProjectSummary = {
    projectPath: projectDir,
    projectId: project.id,
    name: project.name,
    status: project.status,
    assetCount: Array.isArray(project.assets) ? project.assets.length : 0,
    updatedAt: project.updatedAt,
    notes,
  };
  if (project.recordedAt !== undefined) summary.recordedAt = project.recordedAt;
  return summary;
}

function countsOf(
  cues: readonly ReviewSubtitleCue[],
  orphaned: readonly unknown[],
  conflicted: readonly unknown[],
): ReviewCounts {
  return {
    cues: cues.length,
    lowConfidenceWords: cues.reduce((n, c) => n + c.lowConfidenceWords.length, 0),
    edited: cues.filter((c) => c.edited).length,
    orphaned: orphaned.length,
    conflicted: conflicted.length,
    duplicateId: cues.filter((c) => c.duplicateId).length,
  };
}

/**
 * `resolveProject` に渡す解析レイヤーを整える。
 *
 * resolveProject は字幕以外（カメラ切替・章・マーカー・ショート）も
 * 突き合わせるため、配列が欠けていると落ちる。手書きや古い project.json を
 * 開いたときに確認画面ごと開けなくなるのを避けるため、ここで空配列を補う。
 * ★補うのは resolveProject へ渡す一時的な値だけで、保存内容には影響しない。
 */
function normalizeAnalysis(analysis: {
  subtitles: AnalysisSubtitleLike[];
  [key: string]: unknown;
}): { subtitles: AnalysisSubtitleLike[] } {
  const filled: Record<string, unknown> = { ...analysis };
  for (const key of ['cameraShots', 'chapters', 'markers', 'shortCandidates']) {
    if (!Array.isArray(filled[key])) filled[key] = [];
  }
  return filled as { subtitles: AnalysisSubtitleLike[] };
}

/** 確認画面に必要な情報だけを組み立てる。★Project全体は返さない。 */
export function buildReviewData(
  projectDir: string,
  deps: ReviewDeps,
): ReviewLoadResult {
  let loaded: { project: ProjectLike; notes?: string[] };
  try {
    loaded = deps.loadProject(projectDir);
  } catch {
    return {
      ok: false,
      error: safeError(
        DESKTOP_ERROR_CODES.INVALID_PROJECT,
        'project.json を読み込めませんでした。',
        { recoverable: true },
      ),
    };
  }

  const project = loaded.project;
  const analysis = project.analysis;
  if (analysis === undefined || !Array.isArray(analysis.subtitles)) {
    return {
      ok: false,
      error: safeError(
        DESKTOP_ERROR_CODES.ANALYSIS_NOT_READY,
        'このプロジェクトはまだ解析されていません。',
        {
          recoverable: true,
          suggestedAction: '先に「解析開始」を実行してください。',
        },
      ),
    };
  }

  // ★表示値は resolveProject に作らせる（独自の突き合わせをしない）。
  // 配列が欠けた project.json でも落ちないよう、渡す前に空配列で補う。
  const result = deps.resolveProject(normalizeAnalysis(analysis), project.edits);
  const analysisById = new Map(analysis.subtitles.map((cue) => [cue.id, cue]));
  const conflicted = detectSubtitleConflicts(analysis.subtitles, project.edits);
  const conflictedIds = new Set(conflicted.map((c) => c.subtitleId));
  const duplicatedIds = duplicateSubtitleIds(analysis.subtitles);

  const subtitles = result.resolved.subtitles.map((cue) =>
    toReviewCue(cue, analysisById, conflictedIds, duplicatedIds),
  );
  const orphaned = toOrphaned(result.orphaned);

  const speakers: ReviewSpeaker[] = (project.speakers ?? []).map((s) => {
    const speaker: ReviewSpeaker = { id: s.id, name: s.name };
    if (s.title !== undefined) speaker.title = s.title;
    return speaker;
  });

  const data: ReviewData = {
    summary: summaryOf(project, projectDir, loaded.notes ?? []),
    updatedAt: project.updatedAt,
    speakers,
    subtitles,
    counts: countsOf(subtitles, orphaned, conflicted),
    orphaned,
    conflicted,
    timecodeEditingSupported: false,
  };

  const media = deps.prepareMedia?.(project, projectDir);
  if (media !== undefined) data.media = media;

  return { ok: true, data };
}

// ─── 保存 ──────────────────────────────────────────────

function notFound(): SafePipelineError {
  return safeError(
    DESKTOP_ERROR_CODES.SUBTITLE_NOT_FOUND,
    '対象の字幕が見つかりませんでした。',
    { recoverable: true, suggestedAction: '再読み込みしてください。' },
  );
}

function notEditable(): SafePipelineError {
  return safeError(
    DESKTOP_ERROR_CODES.SUBTITLE_NOT_EDITABLE,
    'この字幕は同じ開始時刻の別キューとIDが重複しているため、安全に修正できません。',
    {
      recoverable: false,
      suggestedAction:
        '同じ時刻に複数のキューがある箇所です。Premiere側で調整してください。',
    },
  );
}

/**
 * 字幕修正を保存する。
 *
 * ★analysis には一切触れない。書き換えるのは `project.edits.subtitles` と
 * `project.edits.history` だけ。
 * ★保存前に updatedAt を照合し、食い違えば上書きせず競合として返す。
 */
export function applySubtitleEdit(
  request: {
    projectPath: string;
    subtitleId: string;
    expectedUpdatedAt: string;
    patch: SubtitleEditPatch;
  },
  deps: ReviewDeps,
): SaveSubtitleEditResult {
  let loaded: { project: ProjectLike; notes?: string[] };
  try {
    loaded = deps.loadProject(request.projectPath);
  } catch {
    return {
      ok: false,
      error: safeError(
        DESKTOP_ERROR_CODES.INVALID_PROJECT,
        'project.json を読み込めませんでした。',
        { recoverable: true },
      ),
    };
  }

  const project = loaded.project;

  // ★競合更新の検出。読み込み後に別処理が更新していたら上書きしない。
  if (project.updatedAt !== request.expectedUpdatedAt) {
    return { ok: false, conflict: true, error: conflictError() };
  }

  const analysis = project.analysis;
  if (analysis === undefined) return { ok: false, error: notFound() };

  const targets = analysis.subtitles.filter((cue) => cue.id === request.subtitleId);
  if (targets.length === 0) return { ok: false, error: notFound() };
  if (targets.length > 1) return { ok: false, error: notEditable() };
  const target = targets[0]!;

  const existing = project.edits.subtitles[request.subtitleId];
  const nextEdit: SubtitleEditLike = { ...existing };
  let edits = project.edits;

  if (request.patch.text !== undefined) {
    // before は「この字幕を初めて直す前の値」＝解析結果。
    // 2回目以降の修正では既存の修正値を before にする（履歴として自然なため）。
    const before = existing?.text ?? textOf(target.lines);
    if (before !== request.patch.text) {
      edits = deps.recordEdit(edits, {
        kind: 'subtitle',
        targetId: request.subtitleId,
        field: 'text',
        before,
        after: request.patch.text,
      });
    }
    nextEdit.text = request.patch.text;
  }

  if (request.patch.speakerId !== undefined) {
    const before = existing?.speakerId ?? target.speakerId;
    if (before !== request.patch.speakerId) {
      edits = deps.recordEdit(edits, {
        kind: 'subtitle',
        targetId: request.subtitleId,
        field: 'speakerId',
        before: before ?? null,
        after: request.patch.speakerId,
      });
    }
    nextEdit.speakerId = request.patch.speakerId;
  }

  // ★ここだけが書き換わる。analysis も他のレイヤーも触らない。
  const nextProject: ProjectLike = {
    ...project,
    edits: {
      ...edits,
      subtitles: { ...edits.subtitles, [request.subtitleId]: nextEdit },
    },
  };

  return persistAndReload(request.projectPath, nextProject, request.subtitleId, deps);
}

/** 字幕の修正を取り消す（解析結果の値に戻す）。 */
export function removeSubtitleEdit(
  request: { projectPath: string; subtitleId: string; expectedUpdatedAt: string },
  deps: ReviewDeps,
): SaveSubtitleEditResult {
  let loaded: { project: ProjectLike; notes?: string[] };
  try {
    loaded = deps.loadProject(request.projectPath);
  } catch {
    return {
      ok: false,
      error: safeError(
        DESKTOP_ERROR_CODES.INVALID_PROJECT,
        'project.json を読み込めませんでした。',
        { recoverable: true },
      ),
    };
  }

  const project = loaded.project;
  if (project.updatedAt !== request.expectedUpdatedAt) {
    return { ok: false, conflict: true, error: conflictError() };
  }

  const existing = project.edits.subtitles[request.subtitleId];
  if (existing === undefined) return { ok: false, error: notFound() };

  const edits = deps.recordEdit(project.edits, {
    kind: 'subtitle',
    targetId: request.subtitleId,
    field: 'removed',
    before: existing,
    after: null,
  });

  const nextSubtitles = { ...edits.subtitles };
  delete nextSubtitles[request.subtitleId];

  const nextProject: ProjectLike = {
    ...project,
    edits: { ...edits, subtitles: nextSubtitles },
  };

  return persistAndReload(request.projectPath, nextProject, request.subtitleId, deps);
}

/**
 * 保存し、保存結果を読み直して返す。
 *
 * ★保存後に必ず読み直す。書けたつもりで書けていない状態を、
 * 画面に「保存済み」と出したまま進ませないため。
 */
function persistAndReload(
  projectDir: string,
  nextProject: ProjectLike,
  subtitleId: string,
  deps: ReviewDeps,
): SaveSubtitleEditResult {
  try {
    deps.saveProject(projectDir, nextProject);
  } catch {
    // saveProject は一時ファイル→rename なので、失敗しても既存の
    // project.json は壊れない。ここでは保存できなかったことだけを伝える。
    return {
      ok: false,
      error: safeError(
        DESKTOP_ERROR_CODES.UNKNOWN,
        '修正を保存できませんでした。プロジェクトの内容は変更されていません。',
        {
          recoverable: true,
          suggestedAction: '保存先の空き容量と書き込み権限を確認してください。',
        },
      ),
    };
  }

  const reloaded = buildReviewData(projectDir, deps);
  if (!reloaded.ok) return { ok: false, error: reloaded.error };

  const cue = reloaded.data.subtitles.find((c) => c.id === subtitleId);
  if (cue === undefined) return { ok: false, error: notFound() };

  return {
    ok: true,
    updatedAt: reloaded.data.updatedAt,
    cue,
    counts: reloaded.data.counts,
  };
}
