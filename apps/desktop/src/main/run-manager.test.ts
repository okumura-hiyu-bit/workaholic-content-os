/**
 * 解析の実行管理（二重実行防止・中止・異常終了）。
 *
 * ★ffmpeg / faster-whisper は動かさない。
 * 解析専用プロセスを差し替え可能にしてあるので、実プロセスを起動せずに
 * 開始・進捗・中止・異常終了・アプリ終了の筋道だけを検証する。
 */

import { describe, expect, it, vi } from 'vitest';

import type { PipelineFinishedEvent, PipelineProgressEvent } from '../shared/dto.ts';
import type {
  WorkerFinishedPayload,
  WorkerInbound,
  WorkerOutbound,
} from '../shared/worker-protocol.ts';
import type { AnalysisProcess } from './analysis-process.ts';
import { buildFinishedEvent, decideOutcome, RunManager } from './run-manager.ts';

const PROJECT_ROOT = '/Users/someone/workaholic-content-os';

function createFakeProcess() {
  const sent: WorkerInbound[] = [];
  let onMessage: ((m: WorkerOutbound) => void) | undefined;
  let onExit: ((i: { code: number | null; signal: string | null }) => void) | undefined;
  const state = { killed: false };

  const proc: AnalysisProcess = {
    send: (message) => sent.push(message),
    kill: () => {
      state.killed = true;
      onExit?.({ code: null, signal: 'SIGTERM' });
    },
    onMessage: (listener) => {
      onMessage = listener;
    },
    onExit: (listener) => {
      onExit = listener;
    },
  };

  return {
    proc,
    sent,
    get killed() {
      return state.killed;
    },
    emit: (message: WorkerOutbound) => onMessage?.(message),
    exit: (info: { code: number | null; signal: string | null }) => onExit?.(info),
  };
}

function createManager(options: { spawnThrows?: boolean } = {}) {
  const processes: ReturnType<typeof createFakeProcess>[] = [];
  const spawnCalls: { projectRoot: string; workerPath: string }[] = [];
  const progress: PipelineProgressEvent[] = [];
  const finished: PipelineFinishedEvent[] = [];
  const logs: { message: string; fields?: Record<string, unknown> }[] = [];
  let runCounter = 0;
  let clock = 1_000;

  const manager = new RunManager({
    spawn: vi.fn((opts) => {
      spawnCalls.push(opts);
      if (options.spawnThrows) throw new Error('spawn failed');
      const fake = createFakeProcess();
      processes.push(fake);
      return fake.proc;
    }),
    workerPath: '/built/analysis-worker.mjs',
    newRunId: () => `run-${(runCounter += 1)}`,
    now: () => clock,
    emitProgress: (event) => progress.push(event),
    emitFinished: (event) => finished.push(event),
    logger: {
      info: (message, fields) => logs.push({ message, ...(fields ? { fields } : {}) }),
      error: (message, fields) => logs.push({ message, ...(fields ? { fields } : {}) }),
    },
    cancelGraceMs: 50,
  });

  return {
    manager,
    processes,
    spawnCalls,
    progress,
    finished,
    logs,
    advance: (ms: number) => {
      clock += ms;
    },
    start: (projectId = 'ep012') =>
      manager.start({
        projectPath: `/tmp/${projectId}`,
        projectId,
        projectRoot: PROJECT_ROOT,
        options: {},
      }),
  };
}

const emptyPayload = (
  overrides: Partial<WorkerFinishedPayload> = {},
): WorkerFinishedPayload => ({
  cancelled: false,
  outcomes: [],
  outputFiles: [],
  orphanedCount: 0,
  conflictedCount: 0,
  ...overrides,
});

describe('解析の開始', () => {
  it('★解析専用プロセスを起動し、開始メッセージを送る', () => {
    const ctx = createManager();
    const result = ctx.start();

    expect(result.ok).toBe(true);
    expect(ctx.processes).toHaveLength(1);
    expect(ctx.processes[0]?.sent[0]).toMatchObject({
      type: 'start',
      projectPath: '/tmp/ep012',
    });
  });

  it('★projectRoot を明示的に渡す', () => {
    const ctx = createManager();
    ctx.start();

    const startMessage = ctx.processes[0]?.sent[0];
    expect(startMessage?.type).toBe('start');
    expect(startMessage && 'projectRoot' in startMessage && startMessage.projectRoot).toBe(
      PROJECT_ROOT,
    );
  });

  it('★projectRoot を spawn にも渡す（解析プロセスのcwdになる）', () => {
    const ctx = createManager();
    ctx.start();

    expect(ctx.spawnCalls).toHaveLength(1);
    expect(ctx.spawnCalls[0]).toEqual({
      projectRoot: PROJECT_ROOT,
      workerPath: '/built/analysis-worker.mjs',
    });
  });

  it('★projectRoot は cwd から推測されない（呼び出し側の指定がそのまま使われる）', () => {
    const ctx = createManager();
    ctx.manager.start({
      projectPath: '/tmp/ep012',
      projectId: 'ep012',
      projectRoot: '/Volumes/SSD/elsewhere',
      options: {},
    });

    expect(ctx.spawnCalls[0]?.projectRoot).toBe('/Volumes/SSD/elsewhere');
    expect(ctx.spawnCalls[0]?.projectRoot).not.toBe(process.cwd());
  });

  it('起動時にrunIdを返し、実行中になる', () => {
    const ctx = createManager();
    const result = ctx.start();
    expect(result.ok && result.runId).toBe('run-1');
    expect(ctx.manager.isRunning()).toBe(true);
    expect(ctx.manager.isProjectRunning('ep012')).toBe(true);
  });

  it('プロセス起動に失敗したらエラーを返し、ロックを取らない', () => {
    const ctx = createManager({ spawnThrows: true });
    const result = ctx.start();
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('ANALYSIS_PROCESS_CRASHED');
    expect(ctx.manager.isRunning()).toBe(false);
  });
});

describe('二重実行の防止', () => {
  it('★1ウィンドウにつき実行は1件（別プロジェクトでも拒否する）', () => {
    const ctx = createManager();
    ctx.start('ep012');
    const second = ctx.start('ep013');

    expect(second.ok).toBe(false);
    expect(second.ok === false && second.error.code).toBe('ALREADY_RUNNING');
    // ★プロセスを増やさない
    expect(ctx.processes).toHaveLength(1);
  });

  it('★同じprojectIdの並行実行を拒否する（二度押し）', () => {
    const ctx = createManager();
    ctx.start('ep012');
    const duplicate = ctx.start('ep012');

    expect(duplicate.ok).toBe(false);
    expect(duplicate.ok === false && duplicate.error.code).toBe('PROJECT_ALREADY_RUNNING');
    expect(ctx.processes).toHaveLength(1);
  });

  it('★排他はUIではなくMainが持つ（disabledに依存しない）', () => {
    const ctx = createManager();
    ctx.start('ep012');
    // UIが壊れて連打された状況を想定して、続けて開始要求を送る。
    for (let i = 0; i < 5; i += 1) ctx.start('ep012');

    expect(ctx.processes).toHaveLength(1);
    expect(ctx.manager.isProjectRunning('ep012')).toBe(true);
  });

  it('★中止の完了を待たずに再実行できない', () => {
    const ctx = createManager();
    const started = ctx.start();
    expect(started.ok).toBe(true);

    ctx.manager.cancel('run-1');
    const retry = ctx.start();

    expect(retry.ok).toBe(false);
    expect(retry.ok === false && retry.error.userMessage).toContain('中止');
  });

  it('完了後は再実行できる', () => {
    const ctx = createManager();
    ctx.start();
    ctx.processes[0]?.emit({ type: 'finished', runId: 'run-1', payload: emptyPayload() });

    expect(ctx.manager.isRunning()).toBe(false);
    expect(ctx.manager.isProjectRunning('ep012')).toBe(false);
    expect(ctx.start().ok).toBe(true);
  });
});

describe('進捗の転送', () => {
  it('★進捗イベントをrunId付きで転送する', () => {
    const ctx = createManager();
    ctx.start();
    ctx.processes[0]?.emit({
      type: 'progress',
      runId: 'run-1',
      event: {
        stepId: 'transcribe',
        stepLabel: '文字起こし',
        stepIndex: 6,
        stepCount: 15,
        overallRatio: 0.4,
        stepRatio: 0.5,
        status: 'running',
        message: '22語を認識しました',
      },
    });

    expect(ctx.progress).toHaveLength(1);
    expect(ctx.progress[0]).toMatchObject({
      runId: 'run-1',
      stepId: 'transcribe',
      stepLabel: '文字起こし',
      stepIndex: 6,
      stepCount: 15,
      overallRatio: 0.4,
      stepRatio: 0.5,
      status: 'running',
    });
  });

  it('★進捗に含まれるエラーからtechnicalMessageを落とす', () => {
    const ctx = createManager();
    ctx.start();
    ctx.processes[0]?.emit({
      type: 'progress',
      runId: 'run-1',
      event: {
        stepId: 'validate-project',
        stepLabel: 'プロジェクト検証',
        stepIndex: 1,
        stepCount: 15,
        overallRatio: 0,
        status: 'failed',
        error: {
          code: 'FFMPEG_NOT_FOUND',
          userMessage: 'ffmpeg が見つかりません。',
          technicalMessage: 'spawn /Users/someone/SECRET/ffmpeg ENOENT',
          recoverable: true,
        },
      },
    });

    const forwarded = ctx.progress[0];
    expect(forwarded?.error?.userMessage).toBe('ffmpeg が見つかりません。');
    expect(JSON.stringify(forwarded)).not.toContain('SECRET');
    expect(JSON.stringify(forwarded)).not.toContain('technicalMessage');
  });

  it('進捗イベントは構造化クローンで送れる', () => {
    const ctx = createManager();
    ctx.start();
    ctx.processes[0]?.emit({
      type: 'progress',
      runId: 'run-1',
      event: {
        stepId: 'sync-media',
        stepLabel: '音声同期',
        stepIndex: 4,
        stepCount: 15,
        overallRatio: 0.2,
        status: 'running',
      },
    });
    expect(() => structuredClone(ctx.progress[0])).not.toThrow();
  });

  it('完了後の進捗イベントは無視する', () => {
    const ctx = createManager();
    ctx.start();
    ctx.processes[0]?.emit({ type: 'finished', runId: 'run-1', payload: emptyPayload() });
    ctx.processes[0]?.emit({
      type: 'progress',
      runId: 'run-1',
      event: {
        stepId: 'save-project',
        stepLabel: 'プロジェクトJSONの更新',
        stepIndex: 15,
        stepCount: 15,
        overallRatio: 1,
        status: 'completed',
      },
    });
    expect(ctx.progress).toHaveLength(0);
  });
});

describe('中止', () => {
  it('★cancel で解析プロセスへ中止メッセージを送る', () => {
    const ctx = createManager();
    ctx.start();
    const result = ctx.manager.cancel('run-1');

    expect(result.ok).toBe(true);
    expect(ctx.processes[0]?.sent).toContainEqual({ type: 'cancel', runId: 'run-1' });
  });

  it('中止後に cancelled として完了する', () => {
    const ctx = createManager();
    ctx.start();
    ctx.manager.cancel('run-1');
    ctx.processes[0]?.emit({
      type: 'finished',
      runId: 'run-1',
      payload: emptyPayload({ cancelled: true }),
    });

    expect(ctx.finished[0]?.outcome).toBe('cancelled');
    expect(ctx.manager.isRunning()).toBe(false);
  });

  it('存在しないrunIdの中止は拒否する', () => {
    const ctx = createManager();
    ctx.start();
    const result = ctx.manager.cancel('run-999');
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('RUN_NOT_FOUND');
  });

  it('★猶予を過ぎても終わらない場合はプロセスを強制終了する', async () => {
    const ctx = createManager();
    ctx.start();
    ctx.manager.cancel('run-1');

    expect(ctx.processes[0]?.killed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(ctx.processes[0]?.killed).toBe(true);
    // 強制終了でもロックは解放される
    expect(ctx.manager.isRunning()).toBe(false);
  });
});

describe('異常終了', () => {
  it('★完了報告なしに終了したらロックを解除する', () => {
    const ctx = createManager();
    ctx.start();
    expect(ctx.manager.isRunning()).toBe(true);

    ctx.processes[0]?.exit({ code: 1, signal: null });

    expect(ctx.manager.isRunning()).toBe(false);
    expect(ctx.manager.isProjectRunning('ep012')).toBe(false);
    expect(ctx.finished[0]?.outcome).toBe('failed');
    expect(ctx.finished[0]?.error?.code).toBe('ANALYSIS_PROCESS_CRASHED');
  });

  it('★異常終了後に再実行できる', () => {
    const ctx = createManager();
    ctx.start();
    ctx.processes[0]?.exit({ code: 1, signal: null });
    expect(ctx.start().ok).toBe(true);
  });

  it('failedメッセージを受けたら安全なDTOで完了を通知する', () => {
    const ctx = createManager();
    ctx.start();
    ctx.processes[0]?.emit({
      type: 'failed',
      runId: 'run-1',
      error: {
        code: 'PYTHON_NOT_FOUND',
        userMessage: 'Python仮想環境が見つかりません。',
        technicalMessage: '/Users/someone/SECRET/.venv missing',
        recoverable: true,
      },
    });

    expect(ctx.finished[0]?.outcome).toBe('failed');
    expect(ctx.finished[0]?.error?.userMessage).toBe('Python仮想環境が見つかりません。');
    expect(JSON.stringify(ctx.finished[0])).not.toContain('SECRET');
    expect(ctx.manager.isRunning()).toBe(false);
  });

  it('完了報告のあとの終了で二重に通知しない', () => {
    const ctx = createManager();
    ctx.start();
    ctx.processes[0]?.emit({ type: 'finished', runId: 'run-1', payload: emptyPayload() });
    ctx.processes[0]?.exit({ code: 0, signal: null });

    expect(ctx.finished).toHaveLength(1);
  });
});

describe('アプリ終了', () => {
  it('★実行中の解析を中止して強制終了する', () => {
    const ctx = createManager();
    ctx.start();

    ctx.manager.disposeAll();

    expect(ctx.processes[0]?.sent).toContainEqual({ type: 'cancel', runId: 'run-1' });
    expect(ctx.processes[0]?.killed).toBe(true);
    expect(ctx.manager.isRunning()).toBe(false);
  });

  it('実行中でなければ何もしない', () => {
    const ctx = createManager();
    expect(() => ctx.manager.disposeAll()).not.toThrow();
    expect(ctx.processes).toHaveLength(0);
  });
});

describe('完了イベントの組み立て', () => {
  it('工程の件数を集計する', () => {
    const event = buildFinishedEvent(
      'run-1',
      emptyPayload({
        outcomes: [
          { stepId: 'validate-project', status: 'completed', warnings: [] },
          { stepId: 'probe-media', status: 'warning', warnings: ['素材が未登録です'] },
          { stepId: 'transcribe', status: 'skipped', warnings: [] },
          { stepId: 'save-project', status: 'failed', warnings: [] },
        ],
      }),
      5_000,
    );

    expect(event.counts).toEqual({
      completed: 1,
      warning: 1,
      failed: 1,
      skipped: 1,
      cancelled: 0,
    });
    expect(event.warnings).toEqual(['素材が未登録です']);
    expect(event.durationMs).toBe(5_000);
  });

  it('孤立・競合した修正の件数を運ぶ', () => {
    const event = buildFinishedEvent(
      'run-1',
      emptyPayload({ orphanedCount: 3, conflictedCount: 2 }),
      1,
    );
    expect(event.orphanedCount).toBe(3);
    expect(event.conflictedCount).toBe(2);
  });

  it('成果物のパスを運ぶ', () => {
    const event = buildFinishedEvent(
      'run-1',
      emptyPayload({ outputFiles: ['exports/ep012.fcp7.xml', 'exports/ep012.srt'] }),
      1,
    );
    expect(event.outputFiles).toEqual([
      'exports/ep012.fcp7.xml',
      'exports/ep012.srt',
    ]);
  });

  it('★工程のエラーからtechnicalMessageを落とす', () => {
    const event = buildFinishedEvent(
      'run-1',
      emptyPayload({
        outcomes: [
          {
            stepId: 'transcribe',
            status: 'failed',
            warnings: [],
            error: {
              code: 'WHISPER_NOT_FOUND',
              userMessage: 'faster-whisper が見つかりません。',
              technicalMessage: 'ModuleNotFoundError at /Users/someone/SECRET/.venv',
              recoverable: true,
            },
          },
        ],
      }),
      1,
    );

    expect(JSON.stringify(event)).not.toContain('SECRET');
    expect(JSON.stringify(event)).not.toContain('ModuleNotFoundError');
    expect(event.error?.userMessage).toBe('faster-whisper が見つかりません。');
  });

  it('完了イベントは構造化クローンで送れる', () => {
    const event = buildFinishedEvent('run-1', emptyPayload(), 1);
    expect(() => structuredClone(event)).not.toThrow();
  });
});

describe('decideOutcome', () => {
  it('中止が最優先', () => {
    expect(
      decideOutcome(
        emptyPayload({
          cancelled: true,
          outcomes: [{ stepId: 'transcribe', status: 'failed', warnings: [] }],
        }),
      ),
    ).toBe('cancelled');
  });

  it('失敗があれば failed', () => {
    expect(
      decideOutcome(
        emptyPayload({
          outcomes: [
            { stepId: 'probe-media', status: 'completed', warnings: [] },
            { stepId: 'transcribe', status: 'failed', warnings: [] },
          ],
        }),
      ),
    ).toBe('failed');
  });

  it('警告があれば warning', () => {
    expect(
      decideOutcome(
        emptyPayload({
          outcomes: [{ stepId: 'probe-media', status: 'warning', warnings: ['注意'] }],
        }),
      ),
    ).toBe('warning');
  });

  it('すべて完了なら completed', () => {
    expect(
      decideOutcome(
        emptyPayload({
          outcomes: [{ stepId: 'probe-media', status: 'completed', warnings: [] }],
        }),
      ),
    ).toBe('completed');
  });
});
