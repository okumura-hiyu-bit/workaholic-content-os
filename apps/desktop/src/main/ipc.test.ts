/**
 * IPCハンドラ。プロジェクト選択・入力検証・事前チェック・排他の噛み合わせ。
 *
 * ★Electronを起動しない。ダイアログもフォルダ表示も注入で差し替える。
 */

import { describe, expect, it, vi } from 'vitest';

import { safeError } from '../shared/errors.ts';
import {
  createIpcHandlers,
  REVIEW_EXPORT_STEPS,
  SHORTS_EXPORT_STEPS,
  type IpcDeps,
} from './ipc.ts';
import { RunManager } from './run-manager.ts';
import type { AnalysisProcess } from './analysis-process.ts';
import { createFakeStore, createFakeWorld, projectFixture } from './testing/fake-core.ts';

const PROJECT_ROOT = '/Users/someone/workaholic-content-os';

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
  return {
    send: () => {},
    kill: () => {},
    onMessage: () => {},
    onExit: () => {},
  };
}

function createDeps(overrides: Partial<IpcDeps> = {}) {
  const spawn = vi.fn(() => noopProcess());
  const openFolder = vi.fn(async () => {});
  const showProjectDialog = vi.fn(async () => '/tmp/ep012/project.json');

  const runManager = new RunManager({
    spawn,
    workerPath: '/built/analysis-worker.mjs',
    newRunId: () => 'run-1',
    now: () => 0,
    emitProgress: () => {},
    emitFinished: () => {},
    logger: { info: () => {}, error: () => {} },
  });

  const store = createFakeStore({ '/tmp/ep012': projectFixture() });
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
    showProjectDialog,
    openFolder,
    resolveRoot: () => ({ ok: true, projectRoot: PROJECT_ROOT }),
    preflight: () => ({ ok: true }),
    ...overrides,
  };

  return {
    deps,
    handlers: createIpcHandlers(deps),
    spawn,
    openFolder,
    showProjectDialog,
    runManager,
    store,
  };
}

describe('selectProject', () => {
  it('★有効なproject.jsonを選ぶと要約を返す', async () => {
    const { handlers } = createDeps();
    const result = await handlers.selectProject();

    expect(result.ok).toBe(true);
    expect(result.ok && result.summary.projectId).toBe('ep012');
    expect(result.ok && result.summary.projectPath).toBe('/tmp/ep012');
  });

  it('ダイアログをキャンセルしたら cancelled を返す', async () => {
    const { handlers } = createDeps({ showProjectDialog: async () => undefined });
    const result = await handlers.selectProject();

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('cancelled');
  });

  it('★project.jsonでないものを選んだら invalid を返す', async () => {
    const { handlers } = createDeps({ fileExists: () => false });
    const result = await handlers.selectProject();

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('invalid');
  });

  it('★壊れたproject.jsonを選んだら invalid を返す', async () => {
    const { handlers } = createDeps({
      loadProject: () => {
        throw new Error('broken json');
      },
    });
    const result = await handlers.selectProject();
    expect(result.ok === false && result.reason).toBe('invalid');
  });
});

describe('startPipeline の入力検証', () => {
  it('★不正なprojectPathを拒否する', async () => {
    const { handlers, spawn } = createDeps();
    const result = await handlers.startPipeline({ projectPath: 'relative/path' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('INVALID_REQUEST');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('★不正なstepIdを拒否する（解析プロセスを起動しない）', async () => {
    const { handlers, spawn } = createDeps();
    const result = await handlers.startPipeline({
      projectPath: '/tmp/ep012',
      fromStep: 'rm -rf /',
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('INVALID_REQUEST');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('★onlyStepsの未知工程を拒否する', async () => {
    const { handlers, spawn } = createDeps();
    const result = await handlers.startPipeline({
      projectPath: '/tmp/ep012',
      onlySteps: ['transcribe', 'evil-step'],
    });
    expect(result.ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('★有効なproject.jsonでなければ起動しない', async () => {
    const { handlers, spawn } = createDeps({ fileExists: () => false });
    const result = await handlers.startPipeline({ projectPath: '/tmp/not-a-project' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('INVALID_PROJECT');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('リクエストがオブジェクトでなければ拒否する', async () => {
    const { handlers } = createDeps();
    for (const value of [null, undefined, 'start', 42]) {
      const result = await handlers.startPipeline(value);
      expect(result.ok).toBe(false);
    }
  });
});

describe('startPipeline の実行環境チェック', () => {
  it('★projectRootを解決できなければ起動しない', async () => {
    const { handlers, spawn } = createDeps({
      resolveRoot: () => ({
        ok: false,
        error: safeError('PROJECT_ROOT_NOT_FOUND', '実行環境が見つかりません。'),
      }),
    });
    const result = await handlers.startPipeline({ projectPath: '/tmp/ep012' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('PROJECT_ROOT_NOT_FOUND');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('★.venv が無ければ起動前に分かりやすいエラーを返す', async () => {
    const { handlers, spawn } = createDeps({
      preflight: () => ({
        ok: false,
        error: safeError(
          'ENVIRONMENT_NOT_READY',
          '文字起こしに必要なPython環境（.venv）が見つかりません。',
          { suggestedAction: 'python3 -m venv .venv を実行してください。' },
        ),
      }),
    });
    const result = await handlers.startPipeline({ projectPath: '/tmp/ep012' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.userMessage).toContain('.venv');
    expect(result.ok === false && result.error.suggestedAction).toContain('venv');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('★解決したprojectRootを解析プロセスへ渡す', async () => {
    const { handlers, spawn } = createDeps();
    const result = await handlers.startPipeline({ projectPath: '/tmp/ep012' });

    expect(result.ok).toBe(true);
    expect(spawn).toHaveBeenCalledWith({
      projectRoot: PROJECT_ROOT,
      workerPath: '/built/analysis-worker.mjs',
    });
  });
});

describe('startPipeline の排他', () => {
  it('★二重実行を拒否する', async () => {
    const { handlers, spawn } = createDeps();
    const first = await handlers.startPipeline({ projectPath: '/tmp/ep012' });
    const second = await handlers.startPipeline({ projectPath: '/tmp/ep012' });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error.code).toBe('PROJECT_ALREADY_RUNNING');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('cancelPipeline', () => {
  it('★不正なrunIdを拒否する', async () => {
    const { handlers } = createDeps();
    const result = await handlers.cancelPipeline('../../etc/passwd');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('INVALID_REQUEST');
  });

  it('文字列以外のrunIdを拒否する', async () => {
    const { handlers } = createDeps();
    for (const value of [null, undefined, 42, {}]) {
      const result = await handlers.cancelPipeline(value);
      expect(result.ok).toBe(false);
    }
  });

  it('実行中の解析を中止できる', async () => {
    const { handlers } = createDeps();
    const started = await handlers.startPipeline({ projectPath: '/tmp/ep012' });
    expect(started.ok).toBe(true);

    const result = await handlers.cancelPipeline('run-1');
    expect(result.ok).toBe(true);
  });
});

describe('review:load', () => {
  it('★確認画面のデータを返す', async () => {
    const { handlers } = createDeps();
    const result = await handlers.reviewLoad('/tmp/ep012');

    expect(result.ok).toBe(true);
    expect(result.ok && result.data.subtitles).toHaveLength(3);
    expect(result.ok && result.data.speakers.map((s) => s.id)).toEqual([
      'spk_a',
      'spk_b',
    ]);
  });

  it('★不正なパスを拒否する', async () => {
    const { handlers } = createDeps();
    const result = await handlers.reviewLoad('relative/path');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('INVALID_REQUEST');
  });

  it('★有効なプロジェクトでなければ拒否する', async () => {
    const { handlers } = createDeps({ fileExists: () => false });
    const result = await handlers.reviewLoad('/tmp/none');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('INVALID_PROJECT');
  });
});

describe('review:update-subtitle', () => {
  const base = () => ({
    projectPath: '/tmp/ep012',
    subtitleId: 'sub-00000000',
    expectedUpdatedAt: '2026-08-01T00:00:00.000Z',
  });

  it('★本文を修正できる', async () => {
    const { handlers, store } = createDeps();
    const result = await handlers.reviewUpdateSubtitle({
      ...base(),
      patch: { text: '直しました' },
    });

    expect(result.ok).toBe(true);
    expect(store.read('/tmp/ep012').edits.subtitles['sub-00000000']).toEqual({
      text: '直しました',
    });
  });

  it('★不正な subtitleId を拒否する（保存しない）', async () => {
    const { handlers, store } = createDeps();
    const result = await handlers.reviewUpdateSubtitle({
      ...base(),
      subtitleId: '../../etc/passwd',
      patch: { text: 'x' },
    });
    expect(result.ok).toBe(false);
    expect(store.saveCount()).toBe(0);
  });

  it('★存在しない speakerId を拒否する（保存しない）', async () => {
    const { handlers, store } = createDeps();
    const result = await handlers.reviewUpdateSubtitle({
      ...base(),
      patch: { speakerId: 'spk_zzz' },
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.userMessage).toContain('存在しない');
    expect(store.saveCount()).toBe(0);
  });

  it('★タイムコードの編集を拒否する', async () => {
    const { handlers, store } = createDeps();
    const result = await handlers.reviewUpdateSubtitle({
      ...base(),
      patch: { text: 'x', startSec: 1 },
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.userMessage).toContain('未対応');
    expect(store.saveCount()).toBe(0);
  });

  it('★長すぎる本文を拒否する', async () => {
    const { handlers, store } = createDeps();
    const result = await handlers.reviewUpdateSubtitle({
      ...base(),
      patch: { text: 'あ'.repeat(1000) },
    });
    expect(result.ok).toBe(false);
    expect(store.saveCount()).toBe(0);
  });

  it('★制御文字を含む本文を拒否する', async () => {
    const { handlers, store } = createDeps();
    const result = await handlers.reviewUpdateSubtitle({
      ...base(),
      patch: { text: 'あ い' },
    });
    expect(result.ok).toBe(false);
    expect(store.saveCount()).toBe(0);
  });

  it('★expectedUpdatedAt が食い違えば競合として拒否する', async () => {
    const { handlers, store } = createDeps();
    const result = await handlers.reviewUpdateSubtitle({
      ...base(),
      expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
      patch: { text: 'x' },
    });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.conflict).toBe(true);
    expect(store.saveCount()).toBe(0);
  });
});

describe('review:remove-subtitle-edit', () => {
  it('修正を取り消せる', async () => {
    const { handlers, store } = createDeps();
    const saved = await handlers.reviewUpdateSubtitle({
      projectPath: '/tmp/ep012',
      subtitleId: 'sub-00000000',
      expectedUpdatedAt: '2026-08-01T00:00:00.000Z',
      patch: { text: '直した' },
    });
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;

    const removed = await handlers.reviewRemoveSubtitleEdit({
      projectPath: '/tmp/ep012',
      subtitleId: 'sub-00000000',
      expectedUpdatedAt: saved.updatedAt,
    });
    expect(removed.ok).toBe(true);
    expect(store.read('/tmp/ep012').edits.subtitles['sub-00000000']).toBeUndefined();
  });

  it('★不正なリクエストを拒否する', async () => {
    const { handlers } = createDeps();
    const result = await handlers.reviewRemoveSubtitleEdit({ projectPath: 'rel' });
    expect(result.ok).toBe(false);
  });
});

describe('review:export（部分再出力）', () => {
  it('★字幕に関わる工程だけを実行する', async () => {
    const { handlers, runManager } = createDeps();
    const start = vi.spyOn(runManager, 'start');

    const result = await handlers.reviewExport({ projectPath: '/tmp/ep012' });

    expect(result.ok).toBe(true);
    expect(result.ok && result.steps).toEqual([
      'generate-premiere-xml',
      'save-artifacts',
      'save-project',
    ]);

    const options = start.mock.calls[0]?.[0].options;
    expect(options?.onlySteps).toEqual(REVIEW_EXPORT_STEPS);
  });

  it('★解析・文字起こし・同期を再実行しない', async () => {
    const { handlers, runManager } = createDeps();
    const start = vi.spyOn(runManager, 'start');
    await handlers.reviewExport({ projectPath: '/tmp/ep012' });

    const steps = start.mock.calls[0]?.[0].options.onlySteps ?? [];
    for (const heavy of [
      'transcribe',
      'sync-media',
      'extract-audio',
      'detect-speakers',
      'correct-audio',
      'probe-media',
      'generate-subtitles',
    ]) {
      expect(steps).not.toContain(heavy);
    }
  });

  it('★force を付ける（editsはキャッシュキーに入らないため）', async () => {
    const { handlers, runManager } = createDeps();
    const start = vi.spyOn(runManager, 'start');
    await handlers.reviewExport({ projectPath: '/tmp/ep012' });
    expect(start.mock.calls[0]?.[0].options.force).toBe(true);
  });

  it('★projectRoot を明示的に渡す', async () => {
    const { handlers, runManager } = createDeps();
    const start = vi.spyOn(runManager, 'start');
    await handlers.reviewExport({ projectPath: '/tmp/ep012' });
    expect(start.mock.calls[0]?.[0].projectRoot).toBe(PROJECT_ROOT);
  });

  it('★実行中は再出力を拒否する', async () => {
    const { handlers } = createDeps();
    const first = await handlers.reviewExport({ projectPath: '/tmp/ep012' });
    const second = await handlers.reviewExport({ projectPath: '/tmp/ep012' });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error.code).toBe('PROJECT_ALREADY_RUNNING');
  });

  it('★環境が整っていなければ実行しない', async () => {
    const { handlers, spawn } = createDeps({
      preflight: () => ({
        ok: false,
        error: safeError('ENVIRONMENT_NOT_READY', 'ビルドされていません。'),
      }),
    });
    const result = await handlers.reviewExport({ projectPath: '/tmp/ep012' });
    expect(result.ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('★不正なパスを拒否する', async () => {
    const { handlers, spawn } = createDeps();
    const result = await handlers.reviewExport({ projectPath: 'relative' });
    expect(result.ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('review:open-media', () => {
  it('★不正なパスを拒否する', async () => {
    const { handlers } = createDeps();
    const result = await handlers.reviewOpenMedia('relative/path');
    expect(result.ok).toBe(false);
  });

  it('有効なプロジェクトなら openMedia に委ねる', async () => {
    const openMedia = vi.fn(async () => ({
      ok: true as const,
      media: { url: 'contentos-media://abc', durationSec: 40, sourceFileName: 'wide.mp4' },
    }));
    const { handlers } = createDeps({ openMedia });
    const result = await handlers.reviewOpenMedia('/tmp/ep012');

    expect(result.ok).toBe(true);
    expect(openMedia).toHaveBeenCalledWith('/tmp/ep012');
  });
});

describe('shorts:load / update / remove', () => {
  it('ショート候補を読み込める', async () => {
    const { handlers } = createDeps();
    const result = await handlers.shortsLoad('/tmp/ep012');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.candidates.length).toBeGreaterThan(0);
      expect(result.data.reanalysisWarning).toContain('再解析');
    }
  });

  it('★不正なパスを拒否する', async () => {
    const { handlers } = createDeps();
    expect((await handlers.shortsLoad('relative/path')).ok).toBe(false);
    expect((await handlers.shortsLoad('../../etc/passwd')).ok).toBe(false);
  });

  it('採否を保存できる', async () => {
    const { handlers } = createDeps();
    const loaded = await handlers.shortsLoad('/tmp/ep012');
    if (!loaded.ok) throw new Error('load failed');

    const result = await handlers.shortsUpdateDecision({
      projectPath: '/tmp/ep012',
      shortId: 'short_01',
      expectedUpdatedAt: loaded.data.updatedAt,
      patch: { adopted: true, title: '神回の入り' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.adopted).toBe(true);
      expect(result.candidate.title).toBe('神回の入り');
    }
  });

  it('★不正な入力を検証層で弾く（保存経路まで届かせない）', async () => {
    const { handlers } = createDeps();
    const loaded = await handlers.shortsLoad('/tmp/ep012');
    if (!loaded.ok) throw new Error('load failed');
    const base = {
      projectPath: '/tmp/ep012',
      expectedUpdatedAt: loaded.data.updatedAt,
    };

    const bad = [
      { ...base, shortId: 'short_x', patch: { adopted: true } }, // ID形式
      { ...base, shortId: 'short_01', patch: {} }, // 中身なし
      { ...base, shortId: 'short_01', patch: { adopted: 'yes' } }, // 型違い
      { ...base, shortId: 'short_01', patch: { adopted: true, startSec: 5 } }, // 未対応
      { ...base, shortId: 'short_01', patch: { title: 'a\nb' } }, // 改行
      { ...base, projectPath: 'relative', shortId: 'short_01', patch: { adopted: true } },
      {
        ...base,
        expectedUpdatedAt: '2026/08/04',
        shortId: 'short_01',
        patch: { adopted: true },
      },
      { ...base, shortId: 'short_99', patch: { adopted: true } }, // 解析に無いID
    ];

    for (const request of bad) {
      const result = await handlers.shortsUpdateDecision(request);
      expect(result.ok).toBe(false);
    }
  });

  it('★古い updatedAt は競合として拒否する', async () => {
    const { handlers } = createDeps();
    const loaded = await handlers.shortsLoad('/tmp/ep012');
    if (!loaded.ok) throw new Error('load failed');

    await handlers.shortsUpdateDecision({
      projectPath: '/tmp/ep012',
      shortId: 'short_01',
      expectedUpdatedAt: loaded.data.updatedAt,
      patch: { adopted: true },
    });

    const stale = await handlers.shortsUpdateDecision({
      projectPath: '/tmp/ep012',
      shortId: 'short_02',
      expectedUpdatedAt: loaded.data.updatedAt,
      patch: { adopted: true },
    });

    expect(stale.ok).toBe(false);
    expect(stale.ok === false && stale.error.code).toBe('PROJECT_CHANGED');
  });

  it('判断を取り消せる', async () => {
    const { handlers } = createDeps();
    const loaded = await handlers.shortsLoad('/tmp/ep012');
    if (!loaded.ok) throw new Error('load failed');

    const saved = await handlers.shortsUpdateDecision({
      projectPath: '/tmp/ep012',
      shortId: 'short_01',
      expectedUpdatedAt: loaded.data.updatedAt,
      patch: { adopted: true },
    });
    if (!saved.ok) throw new Error('save failed');

    const removed = await handlers.shortsRemoveDecision({
      projectPath: '/tmp/ep012',
      shortId: 'short_01',
      expectedUpdatedAt: saved.updatedAt,
    });

    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.candidate.adopted).toBeUndefined();
  });

  it('★取り消しでも不正な入力を弾く', async () => {
    const { handlers } = createDeps();
    expect(
      (
        await handlers.shortsRemoveDecision({
          projectPath: 'relative',
          shortId: 'short_01',
          expectedUpdatedAt: '2026-08-01T00:00:00.000Z',
        })
      ).ok,
    ).toBe(false);
  });
});

describe('shorts:export', () => {
  it('★save-artifacts と save-project だけを実行する', async () => {
    const { handlers, runManager } = createDeps();
    const start = vi.spyOn(runManager, 'start');
    const result = await handlers.shortsExport({ projectPath: '/tmp/ep012' });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.steps).toEqual(['save-artifacts', 'save-project']);
    expect(start.mock.calls[0]?.[0].options.onlySteps).toEqual(SHORTS_EXPORT_STEPS);
  });

  it('★FCP7 XML（generate-premiere-xml）を作り直さない', async () => {
    const { handlers, runManager } = createDeps();
    const start = vi.spyOn(runManager, 'start');
    await handlers.shortsExport({ projectPath: '/tmp/ep012' });

    const steps = start.mock.calls[0]?.[0].options.onlySteps ?? [];
    expect(steps).not.toContain('generate-premiere-xml');
  });

  it('★字幕の再出力より狭い（Premiere関連を含まない）', () => {
    expect(REVIEW_EXPORT_STEPS).toContain('generate-premiere-xml');
    expect(SHORTS_EXPORT_STEPS).not.toContain('generate-premiere-xml');
    for (const step of SHORTS_EXPORT_STEPS) {
      expect(REVIEW_EXPORT_STEPS).toContain(step);
    }
  });

  it('★解析・文字起こし・同期を再実行しない', async () => {
    const { handlers, runManager } = createDeps();
    const start = vi.spyOn(runManager, 'start');
    await handlers.shortsExport({ projectPath: '/tmp/ep012' });

    const steps = start.mock.calls[0]?.[0].options.onlySteps ?? [];
    for (const heavy of [
      'transcribe',
      'sync-media',
      'extract-audio',
      'detect-speakers',
      'correct-audio',
      'probe-media',
      'extract-short-candidates',
    ]) {
      expect(steps).not.toContain(heavy);
    }
  });

  it('★force を付ける（editsはキャッシュキーに入らないため）', async () => {
    const { handlers, runManager } = createDeps();
    const start = vi.spyOn(runManager, 'start');
    await handlers.shortsExport({ projectPath: '/tmp/ep012' });
    expect(start.mock.calls[0]?.[0].options.force).toBe(true);
  });

  it('★実行中は再出力を拒否する', async () => {
    const { handlers } = createDeps();
    const first = await handlers.shortsExport({ projectPath: '/tmp/ep012' });
    const second = await handlers.shortsExport({ projectPath: '/tmp/ep012' });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error.code).toBe('PROJECT_ALREADY_RUNNING');
  });

  it('★環境が整っていなければ実行しない', async () => {
    const { handlers, spawn } = createDeps({
      preflight: () => ({
        ok: false,
        error: safeError('ENVIRONMENT_NOT_READY', 'ビルドされていません。'),
      }),
    });
    const result = await handlers.shortsExport({ projectPath: '/tmp/ep012' });
    expect(result.ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('★不正なパスを拒否する', async () => {
    const { handlers, spawn } = createDeps();
    const result = await handlers.shortsExport({ projectPath: 'relative' });
    expect(result.ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('openProjectFolder', () => {
  it('有効なプロジェクトのフォルダを開く', async () => {
    const { handlers, openFolder } = createDeps();
    await handlers.openProjectFolder('/tmp/ep012');

    expect(openFolder).toHaveBeenCalledWith('/tmp/ep012');
  });

  it('★任意のパスは開かない（有効なプロジェクトのみ）', async () => {
    const { handlers, openFolder } = createDeps({ fileExists: () => false });
    await handlers.openProjectFolder('/etc');

    expect(openFolder).not.toHaveBeenCalled();
  });

  it('★相対パスを開かない', async () => {
    const { handlers, openFolder } = createDeps();
    await handlers.openProjectFolder('../../../etc');

    expect(openFolder).not.toHaveBeenCalled();
  });

  it('project.jsonを渡してもフォルダを開く', async () => {
    const { handlers, openFolder } = createDeps();
    await handlers.openProjectFolder('/tmp/ep012/project.json');

    expect(openFolder).toHaveBeenCalledWith('/tmp/ep012');
  });
});
