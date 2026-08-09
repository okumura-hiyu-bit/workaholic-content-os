/**
 * 確認画面（Review）4画面で共通の組み立て・保存部品。
 *
 * ★なぜ切り出したか（2026-08-05 / Step 9）
 * 字幕・ショート候補・カメラ切替・マーカーの4画面が出そろい、重複が確定した。
 * `summaryOf` は4ファイルで書式以外バイト一致、`analysisNotReady` は3ファイルで
 * 完全一致、`loadProject` の try/catch は計8箇所、競合検出は計6箇所あった。
 *
 * ★これは移設であって仕様変更ではない。
 * 返す値・エラーコード・文言は移設前と1文字も変えていない。
 *
 * ★共通化しなかったもの（意図的）
 * - `persistAndReload` の**結果の組み立て**：字幕・ショート・マーカーは
 *   「1要素」を返し、カメラ切替は「並び全体」を返す。3対1で形が違うため、
 *   共通化するのは「保存して読み直す」ところまでにして、
 *   結果の形は各画面が持つ（無理にまとめるとカメラの都合が他3画面へ流れ込む）。
 * - 各画面固有の検出ロジック（重なり・ID重複・volatileId・種別またぎ）。
 *
 * ★electron を import しない。fs も直接触らない（すべて注入）。
 */

import type { ProjectSummary, SafePipelineError } from '../shared/dto.ts';
import { DESKTOP_ERROR_CODES, safeError } from '../shared/errors.ts';
import { conflictError } from '../shared/validate-common.ts';
import type { ProjectLike, ReviewDeps } from './review.ts';

/**
 * 保存に失敗したときの文言。
 *
 * ★ショート候補だけ「判断」、他の3画面は「修正」。人が行った操作の呼び方が
 * 画面ごとに違うため、移設前の文言をそのまま保つ。
 */
export const SAVE_FAILED_EDIT =
  '修正を保存できませんでした。プロジェクトの内容は変更されていません。';
export const SAVE_FAILED_DECISION =
  '判断を保存できませんでした。プロジェクトの内容は変更されていません。';

/** 確認画面に出すプロジェクトの要約。★Project全体は返さない。 */
export function summaryOf(
  project: ProjectLike,
  projectDir: string,
  notes: string[],
): ProjectSummary {
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

/** project.json を読み込めなかったときのエラー。 */
export function invalidProjectError(): SafePipelineError {
  return safeError(
    DESKTOP_ERROR_CODES.INVALID_PROJECT,
    'project.json を読み込めませんでした。',
    { recoverable: true },
  );
}

/** 解析がまだ行われていないときのエラー。 */
export function analysisNotReadyError(): SafePipelineError {
  return safeError(
    DESKTOP_ERROR_CODES.ANALYSIS_NOT_READY,
    'このプロジェクトはまだ解析されていません。',
    {
      recoverable: true,
      suggestedAction: '先に「解析開始」を実行してください。',
    },
  );
}

/** 保存に失敗したときのエラー。★「内容は変更されていない」ことを必ず伝える。 */
export function saveFailedError(userMessage: string): SafePipelineError {
  // saveProject は一時ファイル→rename なので、失敗しても既存の
  // project.json は壊れない。ここでは保存できなかったことだけを伝える。
  return safeError(DESKTOP_ERROR_CODES.UNKNOWN, userMessage, {
    recoverable: true,
    suggestedAction: '保存先の空き容量と書き込み権限を確認してください。',
  });
}

export type LoadedProject = { project: ProjectLike; notes?: string[] };

/** 解析結果（`ProjectLike['analysis']` の undefined を外したもの）。 */
export type AnalysisOf = NonNullable<ProjectLike['analysis']>;

/** project.json の読み込み。失敗を例外ではなく値で返す。 */
export function loadProjectOrError(
  projectDir: string,
  deps: ReviewDeps,
): { ok: true; value: LoadedProject } | { ok: false; error: SafePipelineError } {
  try {
    return { ok: true, value: deps.loadProject(projectDir) };
  } catch {
    return { ok: false, error: invalidProjectError() };
  }
}

/**
 * 保存に進んでよいかを確かめる。
 *
 * ★競合更新の検出。読み込み後に別処理が更新していたら上書きしない。
 * ★解析の有無もここで確かめる（4画面とも保存には analysis が要る）。
 *
 * ★確かめた `analysis` を `project` と**別に返す**のが要点。
 * `project` だけを返すと、解析があると分かっているのに呼び出し側が
 * `project.analysis!` と書くことになり、保証がコンパイラの手を離れる。
 * かといって `{ ...project, analysis }` のように詰め直すと保存対象の
 * オブジェクトが別物になる（挙動を変えない移設ではそれもしたくない）。
 * 参照はそのまま、事実だけを型で持ち上げる。
 */
export function loadForSave(
  projectPath: string,
  expectedUpdatedAt: string,
  deps: ReviewDeps,
):
  | { ok: true; project: ProjectLike; analysis: AnalysisOf }
  | { ok: false; conflict: true; error: SafePipelineError }
  | { ok: false; conflict?: false; error: SafePipelineError } {
  const loaded = loadProjectOrError(projectPath, deps);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const project = loaded.value.project;

  // ★競合更新の検出。読み込み後に別処理が更新していたら上書きしない。
  if (project.updatedAt !== expectedUpdatedAt) {
    return { ok: false, conflict: true, error: conflictError() };
  }

  const analysis = project.analysis;
  if (analysis === undefined) {
    return { ok: false, error: analysisNotReadyError() };
  }

  return { ok: true, project, analysis };
}

/**
 * 保存し、保存結果を読み直す。
 *
 * ★保存後に必ず読み直す。書けたつもりで書けていない状態を、
 * 画面に「保存済み」と出したまま進ませないため。
 *
 * ★ここまでが4画面の共通部分。**結果をどう組み立てるかは呼び出し側が持つ**
 * （1要素を返す画面と並び全体を返す画面があるため）。
 */
export function saveAndRebuild<TData>(
  projectDir: string,
  nextProject: ProjectLike,
  deps: ReviewDeps,
  saveFailureMessage: string,
  rebuild: (
    dir: string,
    deps: ReviewDeps,
  ) => { ok: true; data: TData } | { ok: false; error: SafePipelineError },
): { ok: true; data: TData } | { ok: false; error: SafePipelineError } {
  try {
    deps.saveProject(projectDir, nextProject);
  } catch {
    return { ok: false, error: saveFailedError(saveFailureMessage) };
  }
  return rebuild(projectDir, deps);
}
