/**
 * ★テスト専用。製品コードからimportしない（tsupのentryにも含めない）。
 *
 * project.json の読み書きだけをメモリ上に置き換え、
 * `resolveProject` / `recordEdit` は **本物の @contentos/core を使う**。
 * 突き合わせの仕様（IDの一致→時刻での再接続→孤立）を写し取ると、
 * 本体が変わったときにテストだけが通ってしまうため。
 */

import { recordEdit, resolveProject } from '@contentos/core/resolve';

import type {
  AnalysisSubtitleLike,
  EditsLike,
  ProjectLike,
  ReviewDeps,
} from '../review.ts';

export function emptyEditsFixture(): EditsLike {
  return {
    subtitles: {},
    cameraShots: { overrides: {}, inserted: [], deletedIds: [] },
    chapters: {},
    markers: {},
    shorts: {},
    syncOffsets: {},
    history: [],
  };
}

export function subtitleFixture(
  startSec: number,
  endSec: number,
  lines: string[],
  options: {
    speakerId?: string;
    lowConfidenceWords?: { text: string; probability: number }[];
  } = {},
): AnalysisSubtitleLike {
  const cue: AnalysisSubtitleLike = {
    id: `sub-${String(Math.round(startSec * 1000)).padStart(8, '0')}`,
    startSec,
    endSec,
    lines,
  };
  if (options.speakerId !== undefined) cue.speakerId = options.speakerId;
  if (options.lowConfidenceWords !== undefined) {
    cue.lowConfidenceWords = options.lowConfidenceWords;
  }
  return cue;
}

export function projectFixture(
  overrides: Partial<ProjectLike> = {},
): ProjectLike {
  return {
    id: 'ep012',
    name: '第12回 収録',
    status: '確認待ち',
    updatedAt: '2026-08-01T00:00:00.000Z',
    recordedAt: '2026-07-30',
    assets: [
      {
        id: 'wide',
        role: 'wide',
        fileName: 'wide.mp4',
        absolutePath: '/tmp/ep012/raw/wide.mp4',
        hasAudio: true,
        durationSec: 40,
      },
    ],
    speakers: [
      { id: 'spk_a', name: '話者A' },
      { id: 'spk_b', name: '話者B' },
    ],
    analysis: {
      subtitles: [
        subtitleFixture(0, 2.5, ['こんばんは'], {
          speakerId: 'spk_a',
          lowConfidenceWords: [{ text: 'こんばんは', probability: 0.41 }],
        }),
        subtitleFixture(2.5, 5, ['よろしくお願いします'], { speakerId: 'spk_b' }),
        subtitleFixture(5, 8.25, ['今日のテーマは'], {
          speakerId: 'spk_a',
          lowConfidenceWords: [{ text: 'テーマ', probability: 0.52 }],
        }),
      ],
    },
    edits: emptyEditsFixture(),
    ...overrides,
  };
}

export interface FakeStore {
  deps: ReviewDeps;
  /** 現在ディスクにある想定のプロジェクト。 */
  read(dir: string): ProjectLike;
  /** 保存回数。二重保存の検証に使う。 */
  saveCount(): number;
  /** 次回の保存を失敗させる（保存失敗時の挙動の検証用）。 */
  failNextSave(message?: string): void;
  /** 外部処理がproject.jsonを更新した状況を作る。 */
  touchExternally(dir: string): void;
}

/** メモリ上の project.json ストア。 */
export function createFakeStore(
  initial: Record<string, ProjectLike>,
  options: { now?: () => Date } = {},
): FakeStore {
  const disk = new Map<string, string>();
  for (const [dir, project] of Object.entries(initial)) {
    disk.set(dir, JSON.stringify(project));
  }

  let saves = 0;
  let failNext: string | undefined;
  let clock = 0;
  const now = options.now ?? (() => new Date(Date.UTC(2026, 7, 1, 0, 0, ++clock)));

  const read = (dir: string): ProjectLike => {
    const raw = disk.get(dir);
    if (raw === undefined) throw new Error(`not found: ${dir}`);
    return JSON.parse(raw) as ProjectLike;
  };

  const deps: ReviewDeps = {
    loadProject: (dir) => ({ project: read(dir), notes: [] }),
    saveProject: (dir, project) => {
      if (failNext !== undefined) {
        const message = failNext;
        failNext = undefined;
        // ★本物の saveProject は一時ファイル→rename なので、
        //   失敗しても既存の内容は残る。その性質をここでも再現する。
        throw new Error(message);
      }
      saves += 1;
      // 本物の saveProject と同じく updatedAt はここで更新される。
      const persisted = { ...project, updatedAt: now().toISOString() };
      disk.set(dir, JSON.stringify(persisted));
      return `${dir}/project.json`;
    },
    // ★本物を使う。
    resolveProject: (analysis, edits) =>
      resolveProject(analysis as never, edits as never) as never,
    recordEdit: (edits, entry) => recordEdit(edits as never, entry) as never,
  };

  return {
    deps,
    read,
    saveCount: () => saves,
    failNextSave: (message = 'ENOSPC: no space left on device') => {
      failNext = message;
    },
    touchExternally: (dir) => {
      const project = read(dir);
      disk.set(
        dir,
        JSON.stringify({ ...project, updatedAt: '2099-01-01T00:00:00.000Z' }),
      );
    },
  };
}

// ─── プロジェクト一覧・新規作成・素材登録のテスト補助 ──────

import { createProject as realCreateProject } from '@contentos/core/project';

import type { AssetDeps, MediaProbe } from '../assets.ts';
import type { CreateProjectDeps } from '../project-create.ts';
import { rememberProject } from '../project-registry.ts';
import type { RegistryDeps } from '../project-registry.ts';

export interface FakeFileEntry {
  sizeBytes: number;
  mtimeMs: number;
  probe?: MediaProbe;
  /** 読み取れないファイルを再現する。 */
  unreadable?: boolean;
}

export interface FakeWorld {
  registry: RegistryDeps;
  creator: CreateProjectDeps;
  assets: AssetDeps;
  /** 現在ディスクにある想定のプロジェクト。 */
  readProject(dir: string): ProjectLike;
  /** project.json が存在するか。 */
  hasProject(dir: string): boolean;
  /** 設定ファイル（一覧）の中身。 */
  registryContents(): string | undefined;
  /** 素材ファイルを置く。 */
  putFile(path: string, entry: FakeFileEntry): void;
  /** 素材ファイルを消す（移動・削除の再現）。 */
  removeFile(path: string): void;
  /** 素材ファイルの現在の内容（変更されていないことの確認に使う）。 */
  fileSnapshot(): Record<string, FakeFileEntry>;
  /** ディレクトリを作る。 */
  mkdir(path: string): void;
  saveCount(): number;
  failNextSave(message?: string): void;
  /** 書き込み不可のディレクトリを設定する。 */
  setReadOnly(dir: string): void;
  /** 空き容量を設定する。 */
  setFreeBytes(bytes: number | undefined): void;
}

const DEFAULT_PROBE: MediaProbe = {
  durationSec: 40,
  hasVideo: true,
  hasAudio: true,
  width: 1920,
  height: 1080,
  fps: 30,
  audioChannels: 2,
  audioSampleRate: 48000,
};

export function audioProbe(overrides: Partial<MediaProbe> = {}): MediaProbe {
  return {
    durationSec: 40,
    hasVideo: false,
    hasAudio: true,
    audioChannels: 1,
    audioSampleRate: 48000,
    ...overrides,
  };
}

export function videoProbe(overrides: Partial<MediaProbe> = {}): MediaProbe {
  return { ...DEFAULT_PROBE, ...overrides };
}

/**
 * メモリ上のファイルシステム＋プロジェクトストア。
 * ★ffprobe は差し替えて実行しない。元素材は「読むだけ」であることも検証できる。
 */
export function createFakeWorld(
  options: { now?: () => Date } = {},
): FakeWorld {
  const dirs = new Set<string>(['/work']);
  const files = new Map<string, FakeFileEntry>();
  const projects = new Map<string, string>();
  const readOnly = new Set<string>();
  let registryRaw: string | undefined;
  let saves = 0;
  let failNext: string | undefined;
  let freeBytes: number | undefined = 500 * 1024 ** 3;

  let tick = 0;
  const now = options.now ?? (() => new Date(Date.UTC(2026, 7, 5, 0, 0, ++tick)));

  const readProject = (dir: string): ProjectLike => {
    const raw = projects.get(dir);
    if (raw === undefined) throw new Error(`project not found: ${dir}`);
    return JSON.parse(raw) as ProjectLike;
  };

  const writeProject = (dir: string, project: ProjectLike): string => {
    if (failNext !== undefined) {
      const message = failNext;
      failNext = undefined;
      // 本物の saveProject は一時ファイル→rename なので既存は壊れない。
      throw new Error(message);
    }
    saves += 1;
    const persisted = { ...project, updatedAt: now().toISOString() };
    projects.set(dir, JSON.stringify(persisted));
    return `${dir}/project.json`;
  };

  const exists = (path: string): boolean =>
    dirs.has(path) ||
    files.has(path) ||
    projects.has(path) ||
    (path.endsWith('/project.json') && projects.has(path.slice(0, -'/project.json'.length)));

  const registry: RegistryDeps = {
    read: () => registryRaw,
    write: (contents) => {
      registryRaw = contents;
    },
    loadProject: (dir) => ({ project: readProject(dir) }),
    fileExists: exists,
    now,
  };

  const creator: CreateProjectDeps = {
    createProject: (input) => realCreateProject(input) as unknown as ProjectLike,
    saveProject: writeProject,
    fileExists: exists,
    ensureDir: (path) => dirs.add(path),
    canWrite: (dir) => !readOnly.has(dir),
    // ★本物の rememberProject を使う（登録ロジックの写しを持たない）。
    remember: (dir) => {
      rememberProject(dir, registry);
    },
    now,
  };

  const assets: AssetDeps = {
    loadProject: (dir) => ({ project: readProject(dir) }),
    saveProject: writeProject,
    fileExists: exists,
    canRead: (path) => files.has(path) && files.get(path)?.unreadable !== true,
    canWrite: (dir) => !readOnly.has(dir),
    statFile: (path) => {
      const entry = files.get(path);
      return entry ? { sizeBytes: entry.sizeBytes, mtimeMs: entry.mtimeMs } : undefined;
    },
    probe: (path) => {
      const entry = files.get(path);
      if (entry?.probe === undefined) {
        throw new Error(`not a media file: ${path}`);
      }
      return entry.probe;
    },
    freeBytes: () => freeBytes,
  };

  return {
    registry,
    creator,
    assets,
    readProject,
    hasProject: (dir) => projects.has(dir),
    registryContents: () => registryRaw,
    putFile: (path, entry) => {
      files.set(path, entry);
      dirs.add(path.slice(0, path.lastIndexOf('/')));
    },
    removeFile: (path) => {
      files.delete(path);
    },
    fileSnapshot: () => Object.fromEntries([...files.entries()].map(([k, v]) => [k, { ...v }])),
    mkdir: (path) => dirs.add(path),
    saveCount: () => saves,
    failNextSave: (message = 'ENOSPC: no space left on device') => {
      failNext = message;
    },
    setReadOnly: (dir) => readOnly.add(dir),
    setFreeBytes: (bytes) => {
      freeBytes = bytes;
    },
  };
}
