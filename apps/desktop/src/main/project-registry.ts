/**
 * プロジェクト一覧の管理。
 *
 * ★プロジェクト本体は中央DBへ移さない。
 * ここが持つのは「どこに project.json があるか」と「最後に開いた時刻」だけ。
 * 案件名・ステータス・素材数は毎回 project.json から読み直すので、
 * 一覧とプロジェクト本体がズレることがない。
 *
 * 保存先は Electron の userData 配下の1ファイル。ローカル完結・固定費0円。
 *
 * ★fs には直接触らない（すべて注入）。Electronを起動せずに検証するため。
 */

import type { SafePipelineError } from '../shared/dto.ts';
import { DESKTOP_ERROR_CODES, safeError } from '../shared/errors.ts';
import type { ProjectListEntry, ProjectListResult } from '../shared/setup-dto.ts';
import type { ProjectLike } from './review.ts';

/** 設定ファイルの形。project.json への参照だけを持つ。 */
export interface RegistryFile {
  version: 1;
  entries: { projectPath: string; lastOpenedAt: string }[];
}

export const EMPTY_REGISTRY: RegistryFile = { version: 1, entries: [] };

export interface RegistryDeps {
  /** 設定ファイルを読む。無ければ undefined。 */
  read(): string | undefined;
  /** 設定ファイルを書く（原子的に）。 */
  write(contents: string): void;
  /** project.json を読む。壊れていれば例外でよい。 */
  loadProject(projectDir: string): { project: ProjectLike };
  fileExists(path: string): boolean;
  now(): Date;
}

function parse(raw: string | undefined): RegistryFile {
  if (raw === undefined) return { ...EMPTY_REGISTRY, entries: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<RegistryFile>;
    if (!Array.isArray(parsed.entries)) return { ...EMPTY_REGISTRY, entries: [] };
    const entries = parsed.entries.filter(
      (e): e is RegistryFile['entries'][number] =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as { projectPath?: unknown }).projectPath === 'string',
    );
    return { version: 1, entries };
  } catch {
    // 壊れた設定ファイルで一覧ごと開けなくならないよう、空として扱う。
    return { ...EMPTY_REGISTRY, entries: [] };
  }
}

function projectFilePath(projectDir: string): string {
  return `${projectDir}/project.json`;
}

/**
 * 一覧を組み立てる。
 * ★毎回 project.json を読み直すので、CLIで更新された内容もそのまま反映される。
 */
export function listProjects(deps: RegistryDeps): ProjectListResult {
  const registry = parse(deps.read());
  const entries: ProjectListEntry[] = [];

  for (const item of registry.entries) {
    const exists = deps.fileExists(projectFilePath(item.projectPath));
    if (!exists) {
      // ★黙って消さない。移動・削除されたことが分かるように残す。
      entries.push({
        projectPath: item.projectPath,
        projectId: '—',
        name: item.projectPath.split('/').pop() ?? item.projectPath,
        status: '見つかりません',
        assetCount: 0,
        updatedAt: '',
        lastOpenedAt: item.lastOpenedAt,
        missing: true,
      });
      continue;
    }

    try {
      const { project } = deps.loadProject(item.projectPath);
      const entry: ProjectListEntry = {
        projectPath: item.projectPath,
        projectId: project.id,
        name: project.name,
        status: project.status,
        assetCount: Array.isArray(project.assets) ? project.assets.length : 0,
        updatedAt: project.updatedAt,
        lastOpenedAt: item.lastOpenedAt,
        missing: false,
      };
      if (project.recordedAt !== undefined) entry.recordedAt = project.recordedAt;
      entries.push(entry);
    } catch {
      entries.push({
        projectPath: item.projectPath,
        projectId: '—',
        name: item.projectPath.split('/').pop() ?? item.projectPath,
        status: '読み込めません',
        assetCount: 0,
        updatedAt: '',
        lastOpenedAt: item.lastOpenedAt,
        missing: true,
      });
    }
  }

  // ★最近開いた順。
  entries.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  return { ok: true, entries };
}

function persist(registry: RegistryFile, deps: RegistryDeps): SafePipelineError | undefined {
  try {
    deps.write(`${JSON.stringify(registry, null, 2)}\n`);
    return undefined;
  } catch {
    return safeError(
      DESKTOP_ERROR_CODES.UNKNOWN,
      'プロジェクト一覧を保存できませんでした。',
      {
        recoverable: true,
        suggestedAction: '保存先の空き容量と書き込み権限を確認してください。',
      },
    );
  }
}

/**
 * 一覧に登録する（既にあれば最後に開いた時刻だけ更新）。
 * ★project.json 自体には触らない。
 */
export function rememberProject(
  projectDir: string,
  deps: RegistryDeps,
): SafePipelineError | undefined {
  const registry = parse(deps.read());
  const at = deps.now().toISOString();
  const existing = registry.entries.find((e) => e.projectPath === projectDir);

  if (existing) {
    existing.lastOpenedAt = at;
  } else {
    registry.entries.push({ projectPath: projectDir, lastOpenedAt: at });
  }

  return persist(registry, deps);
}

/** 一覧から外す。★project.json も素材も削除しない。 */
export function forgetProject(
  projectDir: string,
  deps: RegistryDeps,
): SafePipelineError | undefined {
  const registry = parse(deps.read());
  registry.entries = registry.entries.filter((e) => e.projectPath !== projectDir);
  return persist(registry, deps);
}
