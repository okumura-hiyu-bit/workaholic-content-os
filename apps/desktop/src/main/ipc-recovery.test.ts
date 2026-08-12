/**
 * 復旧（Recovery）のIPCハンドラ。検証層とプロジェクト解決の噛み合わせ。
 *
 * ★既存の `ipc.test.ts` は触らない（Step 10 のルール：既存テストを変更しない）。
 * ★Electronを起動しない。ダイアログもフォルダ表示も注入で差し替える。
 */

import { describe, expect, it, vi } from 'vitest';

import { safeError } from '../shared/errors.ts';
import { createIpcHandlers, type IpcDeps } from './ipc.ts';
import { RunManager } from './run-manager.ts';
import type { AnalysisProcess } from './analysis-process.ts';
import type { EditsLike, ProjectLike } from './review.ts';
import {
  createFakeStore,
  createFakeWorld,
  emptyEditsFixture,
  projectFixture,
} from './testing/fake-core.ts';

const PROJECT_ROOT = '/Users/someone/workaholic-content-os';
const DIR = '/tmp/ep012';

const SUB_2500 = 'sub-00002500';
const SUB_ORPHAN = 'sub-00100000';

const validProject = {
  project: {
    id: 'ep012',
    name: '第12回 収録',
    status: '解析待ち',
    updatedAt: '2026-07-30T10:00:00.000Z',
    assets: [{ id: 'a1' }],
  },
  notes: [],
};

function noopProcess(): AnalysisProcess {
  return { send: () => {}, kill: () => {}, onMessage: () => {}, onExit: () => {} };
}

function withEdits(mutate: (edits: EditsLike) => void): ProjectLike {
  const edits = emptyEditsFixture();
  mutate(edits);
  return projectFixture({ edits });
}

function createDeps(project: ProjectLike = projectFixture()) {
  const runManager = new RunManager({
    spawn: vi.fn(() => noopProcess()),
    workerPath: '/built/analysis-worker.mjs',
    newRunId: () => 'run-1',
    now: () => 0,
    emitProgress: () => {},
    emitFinished: () => {},
    logger: { info: () => {}, error: () => {} },
  });

  const store = createFakeStore({ [DIR]: project });
  const world = createFakeWorld();

  const deps: IpcDeps = {
    runManager,
    review: store.deps,
    registry: world.registry,
    creator: world.creator,
    assets: world.assets,
    showDirectoryDialog: async () => '/work',
    showAssetDialog: async () => [],
    openMedia: async () => ({
      ok: false,
      error: safeError('ENVIRONMENT_NOT_READY', 'プレビューは未生成です。'),
    }),
    fileExists: () => true,
    loadProject: () => structuredClone(validProject),
    showProjectDialog: async () => `${DIR}/project.json`,
    openFolder: async () => {},
    resolveRoot: () => ({ ok: true, projectRoot: PROJECT_ROOT }),
    preflight: () => ({ ok: true }),
  };

  return { handlers: createIpcHandlers(deps), store };
}

function updatedAt(store: ReturnType<typeof createDeps>['store']): string {
  return store.read(DIR).updatedAt;
}

// ═══════════════════════════════════════════════════════
describe('recoveryLoad', () => {
  it('要確認の一覧を返す', async () => {
    const { handlers } = createDeps(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: '孤立' };
      }),
    );
    const result = await handlers.recoveryLoad(DIR);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.counts.total).toBe(1);
      expect(result.data.items[0]?.domain).toBe('subtitle');
    }
  });

  it('★不正なパスを拒否する', async () => {
    const { handlers } = createDeps();
    for (const bad of [undefined, null, '', 123, 'relative/path']) {
      const result = await handlers.recoveryLoad(bad);
      expect(result.ok).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════
describe('recoveryTargets', () => {
  it('付け替え先の候補を返す', async () => {
    const { handlers } = createDeps(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: '孤立' };
      }),
    );
    const result = await handlers.recoveryTargets({
      projectPath: DIR,
      domain: 'subtitle',
      sourceId: SUB_ORPHAN,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.targets.length).toBeGreaterThan(0);
  });

  it('★対象とIDの取り違えを検証層で拒否する', async () => {
    const { handlers } = createDeps();
    const result = await handlers.recoveryTargets({
      projectPath: DIR,
      domain: 'marker',
      sourceId: SUB_ORPHAN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_REQUEST');
  });

  it('★未知の対象を拒否する', async () => {
    const { handlers } = createDeps();
    for (const bad of ['chapter', 'syncOffsets', '', null]) {
      const result = await handlers.recoveryTargets({
        projectPath: DIR,
        domain: bad,
        sourceId: SUB_ORPHAN,
      });
      expect(result.ok).toBe(false);
    }
  });
});

// ═══════════════════════════════════════════════════════
describe('recoveryReattach', () => {
  it('付け替えて一覧を返す', async () => {
    const { handlers, store } = createDeps(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: '救い出した本文' };
      }),
    );
    const result = await handlers.recoveryReattach({
      projectPath: DIR,
      domain: 'subtitle',
      sourceId: SUB_ORPHAN,
      targetId: SUB_2500,
      expectedUpdatedAt: updatedAt(store),
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.counts.total).toBe(0);
    expect(store.read(DIR).edits.subtitles[SUB_2500]).toEqual({
      text: '救い出した本文',
    });
  });

  it('★updatedAt が無い要求を拒否し、保存しない', async () => {
    const { handlers, store } = createDeps(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: 'x' };
      }),
    );
    const result = await handlers.recoveryReattach({
      projectPath: DIR,
      domain: 'subtitle',
      sourceId: SUB_ORPHAN,
      targetId: SUB_2500,
    });
    expect(result.ok).toBe(false);
    expect(store.saveCount()).toBe(0);
  });

  it('★元と同じIDへの付け替えを拒否する', async () => {
    const { handlers, store } = createDeps();
    const result = await handlers.recoveryReattach({
      projectPath: DIR,
      domain: 'subtitle',
      sourceId: SUB_2500,
      targetId: SUB_2500,
      expectedUpdatedAt: updatedAt(store),
    });
    expect(result.ok).toBe(false);
    expect(store.saveCount()).toBe(0);
  });

  it('★競合更新を conflict として返す', async () => {
    const { handlers, store } = createDeps(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: 'x' };
      }),
    );
    const stale = updatedAt(store);
    store.touchExternally(DIR);

    const result = await handlers.recoveryReattach({
      projectPath: DIR,
      domain: 'subtitle',
      sourceId: SUB_ORPHAN,
      targetId: SUB_2500,
      expectedUpdatedAt: stale,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toBe(true);
    expect(store.saveCount()).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════
describe('recoveryDiscard', () => {
  it('破棄して一覧を返す', async () => {
    const { handlers, store } = createDeps(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: 'x' };
      }),
    );
    const result = await handlers.recoveryDiscard({
      projectPath: DIR,
      domain: 'subtitle',
      sourceId: SUB_ORPHAN,
      expectedUpdatedAt: updatedAt(store),
    });
    expect(result.ok).toBe(true);
    expect(store.read(DIR).edits.subtitles[SUB_ORPHAN]).toBeUndefined();
  });

  it('★不正な要求を1つも通さない', async () => {
    const { handlers, store } = createDeps();
    const bad: unknown[] = [
      null,
      {},
      { projectPath: DIR },
      { projectPath: DIR, domain: 'subtitle' },
      { projectPath: DIR, domain: 'subtitle', sourceId: SUB_ORPHAN },
      { projectPath: '', domain: 'subtitle', sourceId: SUB_ORPHAN, expectedUpdatedAt: '2026-08-01T00:00:00.000Z' },
      { projectPath: DIR, domain: 'nope', sourceId: SUB_ORPHAN, expectedUpdatedAt: '2026-08-01T00:00:00.000Z' },
      { projectPath: DIR, domain: 'subtitle', sourceId: 'not-an-id', expectedUpdatedAt: '2026-08-01T00:00:00.000Z' },
      { projectPath: DIR, domain: 'subtitle', sourceId: SUB_ORPHAN, expectedUpdatedAt: 'yesterday' },
    ];
    for (const request of bad) {
      const result = await handlers.recoveryDiscard(request);
      expect(result.ok, `通してはいけない要求: ${JSON.stringify(request)}`).toBe(false);
    }
    expect(store.saveCount()).toBe(0);
  });
});
