/**
 * IPCハンドラ。プロジェクト選択・入力検証・事前チェック・排他の噛み合わせ。
 *
 * ★Electronを起動しない。ダイアログもフォルダ表示も注入で差し替える。
 */

import { describe, expect, it, vi } from 'vitest';

import { safeError } from '../shared/errors.ts';
import { createIpcHandlers, type IpcDeps } from './ipc.ts';
import { RunManager } from './run-manager.ts';
import type { AnalysisProcess } from './analysis-process.ts';

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

  const deps: IpcDeps = {
    runManager,
    fileExists: () => true,
    loadProject: () => structuredClone(validProject),
    showProjectDialog,
    openFolder,
    resolveRoot: () => ({ ok: true, projectRoot: PROJECT_ROOT }),
    preflight: () => ({ ok: true }),
    ...overrides,
  };

  return { deps, handlers: createIpcHandlers(deps), spawn, openFolder, showProjectDialog, runManager };
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
