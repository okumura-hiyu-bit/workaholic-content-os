/**
 * project.json の読み取りと、画面に出す要約への変換。
 *
 * ★有効な project.json だけを受け付ける。
 * ファイル選択ダイアログで何を選ばれても、ここを通らないものは
 * プロジェクトとして扱わない。
 *
 * ★要約に載せるのは画面に出す値だけ。
 * analysis（文字起こし全文・字幕全文）には触れない。
 */

import { basename, dirname, join } from 'node:path';

import type { ProjectSummary, ReadProjectSummaryResult } from '../shared/dto.ts';
import { DESKTOP_ERROR_CODES, safeError } from '../shared/errors.ts';
import { validateProjectPath } from '../shared/validate.ts';

export const PROJECT_FILE_NAME = 'project.json';

/** loadProject() が返す形のうち、ここで使う部分だけ。 */
export interface LoadedProjectLike {
  project: {
    id?: unknown;
    name?: unknown;
    status?: unknown;
    updatedAt?: unknown;
    recordedAt?: unknown;
    assets?: unknown;
  };
  notes?: string[];
}

export interface ProjectReaderDeps {
  fileExists(path: string): boolean;
  /** @contentos/core の loadProject。ディレクトリを渡すと project.json を読む。 */
  loadProject(projectDir: string): LoadedProjectLike;
}

function invalidProject(
  userMessage: string,
  suggestedAction?: string,
): ReadProjectSummaryResult {
  return {
    ok: false,
    error: safeError(DESKTOP_ERROR_CODES.INVALID_PROJECT, userMessage, {
      recoverable: true,
      ...(suggestedAction !== undefined ? { suggestedAction } : {}),
    }),
  };
}

/**
 * ダイアログで選ばれたパスをプロジェクトディレクトリに正規化する。
 * project.json そのものを選んでも、その親ディレクトリを選んでも動くようにする。
 */
export function toProjectDir(selectedPath: string): string {
  return basename(selectedPath) === PROJECT_FILE_NAME
    ? dirname(selectedPath)
    : selectedPath;
}

/**
 * プロジェクトを読み、画面用の要約を返す。
 *
 * 失敗はすべて安全なDTOで返す（例外を投げない）。例外メッセージには
 * 内部パスが含まれうるため、そのままRendererへ出さない。
 */
export function readProjectSummary(
  rawPath: unknown,
  deps: ProjectReaderDeps,
): ReadProjectSummaryResult {
  const validated = validateProjectPath(rawPath);
  if (!validated.ok) return { ok: false, error: validated.error };

  const projectDir = toProjectDir(validated.value);

  if (!deps.fileExists(join(projectDir, PROJECT_FILE_NAME))) {
    return invalidProject(
      'このフォルダには project.json がありません。',
      'project.json があるフォルダを選択してください。',
    );
  }

  let loaded: LoadedProjectLike;
  try {
    loaded = deps.loadProject(projectDir);
  } catch {
    // ★例外の本文は出さない（パス・内部構造が混ざるため）。
    return invalidProject(
      'project.json を読み込めませんでした。ファイルが壊れている可能性があります。',
      'ファイルが正しいJSON形式かを確認してください。',
    );
  }

  const project = loaded.project;
  if (typeof project?.id !== 'string' || project.id.trim() === '') {
    return invalidProject('project.json に案件ID（id）がありません。');
  }
  if (typeof project.name !== 'string' || project.name.trim() === '') {
    return invalidProject('project.json に案件名（name）がありません。');
  }

  const summary: ProjectSummary = {
    projectPath: projectDir,
    projectId: project.id,
    name: project.name,
    status: typeof project.status === 'string' ? project.status : '不明',
    assetCount: Array.isArray(project.assets) ? project.assets.length : 0,
    updatedAt: typeof project.updatedAt === 'string' ? project.updatedAt : '',
    notes: loaded.notes ?? [],
  };
  if (typeof project.recordedAt === 'string') {
    summary.recordedAt = project.recordedAt;
  }

  return { ok: true, summary };
}
