/**
 * 新規プロジェクトの作成。
 *
 * ★独自のProject構造を作らない。`@contentos/core` の `createProject()` が
 * 返したものに、出演者と同期モードだけを載せて保存する。
 * `analysis` と `edits` は createProject の初期構造をそのまま使う。
 *
 * ★元素材は一切触らない。作るのは案件フォルダと project.json だけ。
 */

import { join } from 'node:path';

import { DESKTOP_ERROR_CODES, safeError } from '../shared/errors.ts';
import type {
  CreateProjectRequest,
  CreateProjectResult,
  ProjectListEntry,
} from '../shared/setup-dto.ts';
import type { ProjectLike } from './review.ts';

export interface CreateProjectDeps {
  /** `@contentos/core` の createProject。 */
  createProject(input: {
    id: string;
    name: string;
    rootDir: string;
    recordedAt?: string;
    theme?: string;
  }): ProjectLike;
  /** `@contentos/core` の saveProject。 */
  saveProject(projectDir: string, project: ProjectLike): string;
  fileExists(path: string): boolean;
  /** ディレクトリを作る。既にあれば何もしない。 */
  ensureDir(path: string): void;
  /** 書き込めるか。 */
  canWrite(dir: string): boolean;
  /** 一覧に登録する。 */
  remember(projectDir: string): void;
  now(): Date;
}

/**
 * 案件フォルダ名。`2026-08-01_第12回 収録` の形。
 * 案件名は検証済みで、パス区切り・制御文字を含まない。
 */
export function projectFolderName(recordedAt: string, name: string): string {
  return `${recordedAt}_${name}`;
}

/**
 * 重複しないフォルダ名を返す。既にあれば `-2`, `-3` を付ける。
 * ★既存フォルダを絶対に上書きしない。
 */
export function uniqueFolderName(
  parentDir: string,
  base: string,
  fileExists: (path: string) => boolean,
): string | undefined {
  if (!fileExists(join(parentDir, base))) return base;
  for (let n = 2; n <= 50; n += 1) {
    const candidate = `${base}-${n}`;
    if (!fileExists(join(parentDir, candidate))) return candidate;
  }
  return undefined;
}

export function createProjectFolder(
  request: CreateProjectRequest,
  deps: CreateProjectDeps,
): CreateProjectResult {
  // ① 保存先が使えるか
  if (!deps.fileExists(request.parentDir)) {
    return {
      ok: false,
      error: safeError(
        DESKTOP_ERROR_CODES.INVALID_REQUEST,
        '選択した保存場所が見つかりません。',
        { recoverable: true, suggestedAction: '保存場所を選び直してください。' },
      ),
    };
  }
  if (!deps.canWrite(request.parentDir)) {
    return {
      ok: false,
      error: safeError(
        DESKTOP_ERROR_CODES.INVALID_REQUEST,
        '選択した保存場所に書き込めません。',
        {
          recoverable: true,
          suggestedAction: '別の場所を選ぶか、フォルダの権限を確認してください。',
        },
      ),
    };
  }

  // ② 既存フォルダを上書きしない
  const base = projectFolderName(request.recordedAt, request.name);
  const folder = uniqueFolderName(request.parentDir, base, deps.fileExists);
  if (folder === undefined) {
    return {
      ok: false,
      error: safeError(
        DESKTOP_ERROR_CODES.INVALID_REQUEST,
        '同じ名前の案件フォルダが多すぎます。',
        { recoverable: true, suggestedAction: '案件名を変えてください。' },
      ),
    };
  }

  const rootDir = join(request.parentDir, folder);

  // ③ createProject に作らせる（analysis / edits の初期構造をそのまま使う）
  const project = deps.createProject({
    id: folder,
    name: request.name,
    rootDir,
    recordedAt: request.recordedAt,
    ...(request.programName !== undefined ? { theme: request.programName } : {}),
  });

  // ④ 出演者と同期モードだけを載せる。
  //    Speaker.id は 'A' | 'B' | 'C'。素材の役割（mic_A / cam_A）と対応させるため。
  project.speakers = request.speakers.map((s) => ({
    id: s.slot,
    name: s.name,
    role: s.role,
    ...(s.title !== undefined ? { title: s.title } : {}),
  }));
  (project as unknown as { sync: { mode: string; offsets: Record<string, unknown> } }).sync =
    { mode: request.syncMode, offsets: {} };

  try {
    deps.ensureDir(rootDir);
    deps.saveProject(rootDir, project);
  } catch {
    return {
      ok: false,
      error: safeError(
        DESKTOP_ERROR_CODES.UNKNOWN,
        'プロジェクトを作成できませんでした。',
        {
          recoverable: true,
          suggestedAction: '保存先の空き容量と書き込み権限を確認してください。',
        },
      ),
    };
  }

  deps.remember(rootDir);

  const entry: ProjectListEntry = {
    projectPath: rootDir,
    projectId: project.id,
    name: project.name,
    recordedAt: request.recordedAt,
    status: project.status,
    assetCount: 0,
    updatedAt: project.updatedAt,
    lastOpenedAt: deps.now().toISOString(),
    missing: false,
  };
  return { ok: true, entry };
}
