/**
 * プロジェクトJSONの保存・読み込み。
 *
 * ★保存は「一時ファイルに書いてから差し替える」方式にする。書き込み中に
 * 落ちてもファイルが壊れない。人間の修正が入ったファイルなので、
 * 壊れると取り返しがつかない。
 *
 * クラウドに置くのはメタデータだけ。動画・音声は rootDir 配下の
 * ローカル／外付けSSDに置き、JSONはパスだけを持つ。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  emptyApiUsage,
  emptyEdits,
  emptyPipelineState,
  PROJECT_SCHEMA_VERSION,
  type Project,
} from './project.ts';

export const PROJECT_FILE_NAME = 'project.json';

/** プロジェクトJSONのパス。 */
export function projectFilePath(projectDir: string): string {
  return join(resolve(projectDir), PROJECT_FILE_NAME);
}

export interface LoadResult {
  project: Project;
  /** 移行や補完を行った場合の説明。GUIで知らせる。 */
  notes: string[];
}

/**
 * 読み込んだJSONを現在のスキーマに合わせる。
 *
 * 欠けているレイヤーを空で補い、余計な値は落とさない（将来のフィールドを
 * 消さないため）。ここで人間の修正レイヤーを失わないことが最重要。
 */
export function migrateProject(raw: unknown): LoadResult {
  const notes: string[] = [];

  if (typeof raw !== 'object' || raw === null) {
    throw new Error('プロジェクトファイルの形式が不正です');
  }

  const data = raw as Partial<Project> & { schemaVersion?: unknown };

  if (typeof data.id !== 'string' || typeof data.name !== 'string') {
    throw new Error('プロジェクトファイルに id または name がありません');
  }

  const version =
    typeof data.schemaVersion === 'number' ? data.schemaVersion : 0;

  if (version > PROJECT_SCHEMA_VERSION) {
    throw new Error(
      `このプロジェクトは新しい形式（v${version}）で保存されています。` +
        `アプリを更新してください（対応: v${PROJECT_SCHEMA_VERSION}）。`,
    );
  }
  if (version < PROJECT_SCHEMA_VERSION) {
    notes.push(`保存形式を v${version} → v${PROJECT_SCHEMA_VERSION} に更新しました`);
  }

  // ★修正レイヤーが欠けていても、空で補うだけ。既存の値は触らない。
  const edits = data.edits ?? emptyEdits();
  if (!data.edits) notes.push('修正レイヤーが無かったため空で初期化しました');

  const project: Project = {
    ...(data as Project),
    schemaVersion: PROJECT_SCHEMA_VERSION,
    status: data.status ?? '素材準備中',
    assets: data.assets ?? [],
    speakers: data.speakers ?? [],
    sync: data.sync ?? { mode: 'preserve', offsets: {} },
    ai: data.ai ?? { shortReviews: [] },
    edits: {
      subtitles: edits.subtitles ?? {},
      cameraShots: edits.cameraShots ?? {
        overrides: {},
        inserted: [],
        deletedIds: [],
      },
      chapters: edits.chapters ?? {},
      markers: edits.markers ?? {},
      shorts: edits.shorts ?? {},
      syncOffsets: edits.syncOffsets ?? {},
      history: edits.history ?? [],
    },
    apiUsage: data.apiUsage ?? emptyApiUsage(),
    exports: data.exports ?? [],
    pipeline: data.pipeline ?? emptyPipelineState(),
    createdAt: data.createdAt ?? new Date().toISOString(),
    updatedAt: data.updatedAt ?? new Date().toISOString(),
    rootDir: data.rootDir ?? '',
  };

  return { project, notes };
}

/** プロジェクトJSONを読み込む。 */
export function loadProject(projectDir: string): LoadResult {
  const path = projectFilePath(projectDir);
  if (!existsSync(path)) {
    throw new Error(`プロジェクトファイルが見つかりません: ${path}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `プロジェクトファイルを解釈できません: ${path}\n${(error as Error).message}`,
    );
  }

  return migrateProject(raw);
}

/**
 * プロジェクトJSONを保存する。
 *
 * 一時ファイルに書いてから rename する。rename は同一ボリューム内では
 * 原子的なため、書き込み途中で落ちても既存ファイルが壊れない。
 */
export function saveProject(
  projectDir: string,
  project: Project,
  options: { now?: Date } = {},
): string {
  const path = projectFilePath(projectDir);
  mkdirSync(dirname(path), { recursive: true });

  const next: Project = {
    ...project,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    updatedAt: (options.now ?? new Date()).toISOString(),
  };

  const temp = `${path}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
  return path;
}

/**
 * 解析結果だけを差し替える。★人間の修正レイヤーには触れない。
 *
 * 再解析の入口はこの関数に限定し、edits を書き換える経路を作らない。
 */
export function replaceAnalysis(
  project: Project,
  analysis: Project['analysis'],
  options: { now?: Date } = {},
): Project {
  return {
    ...project,
    analysis,
    // AI評価は解析結果に紐づくため、解析が変わったら作り直しの対象になる。
    // ただし消さずに残し、analysisFingerprint の差で古さを判断する。
    updatedAt: (options.now ?? new Date()).toISOString(),
  };
}

/** API使用量を追記する。 */
export function appendApiUsage(
  project: Project,
  entry: Project['apiUsage']['entries'][number],
): Project {
  return {
    ...project,
    apiUsage: {
      entries: [...project.apiUsage.entries, entry],
      totalJpy: Number(
        (project.apiUsage.totalJpy + (entry.cached ? 0 : entry.costJpy)).toFixed(4),
      ),
    },
  };
}

/** 書き出し履歴を追記する。 */
export function appendExport(
  project: Project,
  record: Project['exports'][number],
): Project {
  return { ...project, exports: [...project.exports, record] };
}

/** AI評価が現在の解析結果に対して古くなっていないか。 */
export function isAiReviewStale(project: Project): boolean {
  if (!project.analysis) return false;
  if (project.ai.shortReviews.length === 0 && !project.ai.metadata) return false;
  return project.ai.analysisFingerprint !== project.analysis.fingerprint;
}
