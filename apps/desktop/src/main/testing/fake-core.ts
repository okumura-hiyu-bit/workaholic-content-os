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
