/**
 * 画面の状態遷移。
 * 未選択 → 選択済み → 解析中 → 完了 / 警告 / 失敗 / 中止
 */

import { describe, expect, it } from 'vitest';

import type {
  PipelineFinishedEvent,
  PipelineProgressEvent,
  ProjectSummary,
} from '../shared/dto.ts';
import { canCancel, canStart, initialState, reducer, type AppState } from './state.ts';

const summary: ProjectSummary = {
  projectPath: '/tmp/ep012',
  projectId: 'ep012',
  name: '第12回 収録',
  status: '解析待ち',
  assetCount: 3,
  updatedAt: '2026-07-30T10:00:00.000Z',
  notes: [],
};

const progress = (
  overrides: Partial<PipelineProgressEvent> = {},
): PipelineProgressEvent => ({
  runId: 'run-1',
  stepId: 'transcribe',
  stepLabel: '文字起こし',
  stepIndex: 6,
  stepCount: 15,
  overallRatio: 0.4,
  status: 'running',
  ...overrides,
});

const finished = (
  overrides: Partial<PipelineFinishedEvent> = {},
): PipelineFinishedEvent => ({
  runId: 'run-1',
  outcome: 'completed',
  counts: { completed: 15, warning: 0, failed: 0, skipped: 0, cancelled: 0 },
  steps: [],
  warnings: [],
  outputFiles: [],
  orphanedCount: 0,
  conflictedCount: 0,
  durationMs: 12_000,
  ...overrides,
});

/** 選択済み → 解析中 まで進めた状態を作る。 */
function running(): AppState {
  let state = reducer(initialState, { type: 'selection/succeeded', summary });
  state = reducer(state, { type: 'run/requested' });
  return reducer(state, { type: 'run/started', runId: 'run-1', startedAt: 1_000 });
}

describe('未選択', () => {
  it('初期状態は未選択で、工程は15件すべてpending', () => {
    expect(initialState.phase).toBe('idle');
    expect(initialState.steps).toHaveLength(15);
    expect(initialState.steps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('解析開始できない', () => {
    expect(canStart(initialState)).toBe(false);
  });

  it('選択をキャンセルしても未選択のまま', () => {
    const state = reducer(initialState, { type: 'selection/cancelled' });
    expect(state.phase).toBe('idle');
  });

  it('選択に失敗したらエラーを表示し、未選択のまま', () => {
    const state = reducer(initialState, {
      type: 'selection/failed',
      error: {
        code: 'INVALID_PROJECT',
        userMessage: 'project.json がありません。',
        recoverable: true,
      },
    });
    expect(state.phase).toBe('idle');
    expect(state.error?.userMessage).toBe('project.json がありません。');
  });
});

describe('選択済み', () => {
  it('プロジェクトを選ぶと選択済みになる', () => {
    const state = reducer(initialState, { type: 'selection/succeeded', summary });
    expect(state.phase).toBe('selected');
    expect(state.summary?.projectId).toBe('ep012');
    expect(canStart(state)).toBe(true);
    expect(canCancel(state)).toBe(false);
  });

  it('★選び直すと前回の結果を持ち越さない', () => {
    let state = running();
    state = reducer(state, { type: 'run/finished', event: finished() });
    expect(state.result).toBeDefined();

    state = reducer(state, {
      type: 'selection/succeeded',
      summary: { ...summary, projectId: 'ep013' },
    });
    expect(state.phase).toBe('selected');
    expect(state.result).toBeUndefined();
    expect(state.steps.every((s) => s.status === 'pending')).toBe(true);
  });

  it('開始要求中は二重に押せない', () => {
    let state = reducer(initialState, { type: 'selection/succeeded', summary });
    state = reducer(state, { type: 'run/requested' });
    expect(state.starting).toBe(true);
    expect(canStart(state)).toBe(false);
  });

  it('開始に失敗したら選択済みに戻り、エラーを出す', () => {
    let state = reducer(initialState, { type: 'selection/succeeded', summary });
    state = reducer(state, { type: 'run/requested' });
    state = reducer(state, {
      type: 'run/startFailed',
      error: {
        code: 'ENVIRONMENT_NOT_READY',
        userMessage: '.venv が見つかりません。',
        recoverable: true,
      },
    });

    expect(state.phase).toBe('selected');
    expect(state.starting).toBe(false);
    expect(state.error?.userMessage).toBe('.venv が見つかりません。');
    expect(canStart(state)).toBe(true);
  });
});

describe('解析中', () => {
  it('開始すると解析中になる', () => {
    const state = running();
    expect(state.phase).toBe('running');
    expect(state.runId).toBe('run-1');
    expect(canCancel(state)).toBe(true);
    expect(canStart(state)).toBe(false);
  });

  it('進捗で工程の状態と進捗率が更新される', () => {
    let state = running();
    state = reducer(state, { type: 'run/progress', event: progress() });

    expect(state.progress?.stepLabel).toBe('文字起こし');
    expect(state.progress?.overallRatio).toBe(0.4);
    expect(state.steps.find((s) => s.stepId === 'transcribe')?.status).toBe('running');
  });

  it('警告を蓄積する', () => {
    let state = running();
    state = reducer(state, {
      type: 'run/progress',
      event: progress({ stepId: 'validate-project', warning: '素材が未登録です' }),
    });
    state = reducer(state, {
      type: 'run/progress',
      event: progress({ stepId: 'sync-media', warning: '同期の確信度が低い区間があります' }),
    });

    expect(state.warnings).toEqual([
      '素材が未登録です',
      '同期の確信度が低い区間があります',
    ]);
  });

  it('★別runIdの進捗は無視する', () => {
    let state = running();
    state = reducer(state, {
      type: 'run/progress',
      event: progress({ runId: 'run-999', stepId: 'save-project' }),
    });
    expect(state.progress).toBeUndefined();
  });

  it('中止を要求すると中止中になり、二度押しできない', () => {
    let state = running();
    state = reducer(state, { type: 'run/cancelRequested' });

    expect(state.cancelling).toBe(true);
    expect(canCancel(state)).toBe(false);
  });

  it('中止要求が失敗したら中止中を解除する', () => {
    let state = running();
    state = reducer(state, { type: 'run/cancelRequested' });
    state = reducer(state, {
      type: 'run/cancelFailed',
      error: { code: 'RUN_NOT_FOUND', userMessage: '見つかりません。', recoverable: true },
    });

    expect(state.cancelling).toBe(false);
    expect(state.phase).toBe('running');
  });
});

describe('完了', () => {
  it('★完了：結果を保持し、再解析できる', () => {
    let state = running();
    state = reducer(state, {
      type: 'run/finished',
      event: finished({
        outputFiles: ['exports/ep012.fcp7.xml'],
        orphanedCount: 2,
        conflictedCount: 1,
      }),
    });

    expect(state.phase).toBe('finished');
    expect(state.outcome).toBe('completed');
    expect(state.result?.outputFiles).toEqual(['exports/ep012.fcp7.xml']);
    expect(state.result?.orphanedCount).toBe(2);
    expect(state.result?.conflictedCount).toBe(1);
    expect(canStart(state)).toBe(true);
    expect(canCancel(state)).toBe(false);
  });

  it('★警告：outcomeがwarningになり警告が出る', () => {
    let state = running();
    state = reducer(state, {
      type: 'run/finished',
      event: finished({
        outcome: 'warning',
        counts: { completed: 14, warning: 1, failed: 0, skipped: 0, cancelled: 0 },
        warnings: ['空き容量が少なくなっています'],
      }),
    });

    expect(state.phase).toBe('finished');
    expect(state.outcome).toBe('warning');
    expect(state.warnings).toEqual(['空き容量が少なくなっています']);
  });

  it('★失敗：outcomeがfailedになりエラーが出る', () => {
    let state = running();
    state = reducer(state, {
      type: 'run/finished',
      event: finished({
        outcome: 'failed',
        counts: { completed: 5, warning: 0, failed: 1, skipped: 9, cancelled: 0 },
        error: {
          code: 'FFMPEG_NOT_FOUND',
          userMessage: 'ffmpeg が見つかりません。',
          recoverable: true,
          suggestedAction: 'brew install ffmpeg',
        },
      }),
    });

    expect(state.outcome).toBe('failed');
    expect(state.error?.userMessage).toBe('ffmpeg が見つかりません。');
    expect(state.error?.suggestedAction).toBe('brew install ffmpeg');
    // 失敗しても再解析はできる
    expect(canStart(state)).toBe(true);
  });

  it('★中止：outcomeがcancelledになる', () => {
    let state = running();
    state = reducer(state, { type: 'run/cancelRequested' });
    state = reducer(state, {
      type: 'run/finished',
      event: finished({
        outcome: 'cancelled',
        counts: { completed: 3, warning: 0, failed: 0, skipped: 0, cancelled: 1 },
      }),
    });

    expect(state.phase).toBe('finished');
    expect(state.outcome).toBe('cancelled');
    expect(state.cancelling).toBe(false);
    expect(canStart(state)).toBe(true);
  });

  it('完了報告の工程状態で一覧を上書きする', () => {
    let state = running();
    state = reducer(state, {
      type: 'run/finished',
      event: finished({
        steps: [
          { stepId: 'validate-project', status: 'completed', warnings: [] },
          { stepId: 'transcribe', status: 'skipped', warnings: [] },
        ],
      }),
    });

    expect(state.steps.find((s) => s.stepId === 'validate-project')?.status).toBe(
      'completed',
    );
    expect(state.steps.find((s) => s.stepId === 'transcribe')?.status).toBe('skipped');
  });

  it('★別runIdの完了報告は無視する', () => {
    let state = running();
    state = reducer(state, {
      type: 'run/finished',
      event: finished({ runId: 'run-999' }),
    });
    expect(state.phase).toBe('running');
  });

  it('再解析すると工程がリセットされる', () => {
    let state = running();
    state = reducer(state, {
      type: 'run/finished',
      event: finished({
        steps: [{ stepId: 'validate-project', status: 'completed', warnings: [] }],
      }),
    });
    state = reducer(state, { type: 'run/requested' });
    state = reducer(state, { type: 'run/started', runId: 'run-2', startedAt: 2_000 });

    expect(state.phase).toBe('running');
    expect(state.runId).toBe('run-2');
    expect(state.steps.every((s) => s.status === 'pending')).toBe(true);
    expect(state.result).toBeUndefined();
    expect(state.warnings).toEqual([]);
  });
});

describe('reset', () => {
  it('選択済みの状態へ戻す', () => {
    let state = running();
    state = reducer(state, { type: 'run/finished', event: finished() });
    state = reducer(state, { type: 'run/reset' });

    expect(state.phase).toBe('selected');
    expect(state.summary?.projectId).toBe('ep012');
    expect(state.result).toBeUndefined();
  });

  it('プロジェクト未選択なら初期状態へ戻す', () => {
    const state = reducer(initialState, { type: 'run/reset' });
    expect(state.phase).toBe('idle');
  });
});
