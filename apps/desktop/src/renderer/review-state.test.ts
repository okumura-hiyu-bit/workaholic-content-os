/**
 * 確認画面の状態遷移。
 * loading / ready / dirty / saving / saved / conflict /
 * export-running / export-complete / failed
 */

import { describe, expect, it } from 'vitest';

import type { ReviewCounts, ReviewData, ReviewSubtitleCue } from '../shared/review-dto.ts';
import {
  canEditCue,
  canExport,
  canSave,
  cueIndexAtTime,
  initialReviewState,
  reducer,
  type ReviewState,
} from './review-state.ts';

function cue(overrides: Partial<ReviewSubtitleCue> = {}): ReviewSubtitleCue {
  return {
    id: 'sub-00000000',
    startSec: 0,
    endSec: 2.5,
    text: 'こんばんは',
    speakerId: 'spk_a',
    lowConfidenceWords: [],
    edited: false,
    conflicted: false,
    analysisText: 'こんばんは',
    duplicateId: false,
    editable: true,
    ...overrides,
  };
}

const counts: ReviewCounts = {
  cues: 2,
  lowConfidenceWords: 1,
  edited: 0,
  orphaned: 0,
  conflicted: 0,
  duplicateId: 0,
  ambiguous: 0,
};

function data(overrides: Partial<ReviewData> = {}): ReviewData {
  return {
    summary: {
      projectPath: '/tmp/ep012',
      projectId: 'ep012',
      name: '第12回',
      status: '確認待ち',
      assetCount: 1,
      updatedAt: '2026-08-01T00:00:00.000Z',
      notes: [],
    },
    updatedAt: '2026-08-01T00:00:00.000Z',
    speakers: [{ id: 'spk_a', name: '話者A' }],
    subtitles: [
      cue(),
      cue({ id: 'sub-00002500', startSec: 2.5, endSec: 5, text: 'よろしく' }),
    ],
    counts,
    orphaned: [],
    conflicted: [],
    ambiguous: [],
    timecodeEditingSupported: false,
    ...overrides,
  };
}

/** 読み込み済みの状態を作る。 */
function ready(overrides: Partial<ReviewData> = {}): ReviewState {
  return reducer(initialReviewState, { type: 'load/succeeded', data: data(overrides) });
}

/** 未保存の変更がある状態を作る。 */
function dirty(): ReviewState {
  return reducer(ready(), { type: 'draft/changed', patch: { text: '直した' } });
}

describe('loading', () => {
  it('初期状態は loading', () => {
    expect(initialReviewState.phase).toBe('loading');
    expect(canSave(initialReviewState)).toBe(false);
    expect(canExport(initialReviewState)).toBe(false);
  });

  it('読み込みに失敗したら failed', () => {
    const state = reducer(initialReviewState, {
      type: 'load/failed',
      error: { code: 'ANALYSIS_NOT_READY', userMessage: '未解析です。', recoverable: true },
    });
    expect(state.phase).toBe('failed');
    expect(state.error?.userMessage).toBe('未解析です。');
  });
});

describe('ready', () => {
  it('読み込むと ready になり、先頭が選択される', () => {
    const state = ready();
    expect(state.phase).toBe('ready');
    expect(state.selectedIndex).toBe(0);
    expect(state.updatedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(state.dirty).toBe(false);
  });

  it('字幕が無ければ何も選択しない', () => {
    const state = ready({ subtitles: [] });
    expect(state.selectedIndex).toBeUndefined();
  });

  it('キューを選択できる', () => {
    const state = reducer(ready(), { type: 'cue/selected', index: 1 });
    expect(state.selectedIndex).toBe(1);
  });

  it('★未保存の変更があるまま別のキューへ移らない（黙って捨てない）', () => {
    const state = reducer(dirty(), { type: 'cue/selected', index: 1 });
    expect(state.selectedIndex).toBe(0);
    expect(state.dirty).toBe(true);
  });
});

describe('dirty', () => {
  it('本文を変えると dirty になる', () => {
    const state = dirty();
    expect(state.phase).toBe('dirty');
    expect(state.dirty).toBe(true);
    expect(state.draft?.text).toBe('直した');
    expect(canSave(state)).toBe(true);
  });

  it('元の値に戻すと dirty ではなくなる', () => {
    let state = dirty();
    state = reducer(state, { type: 'draft/changed', patch: { text: 'こんばんは' } });
    expect(state.dirty).toBe(false);
    expect(state.phase).toBe('ready');
  });

  it('話者だけの変更でも dirty になる', () => {
    const state = reducer(ready(), {
      type: 'draft/changed',
      patch: { speakerId: 'spk_b' },
    });
    expect(state.dirty).toBe(true);
  });

  it('下書きを破棄できる', () => {
    const state = reducer(dirty(), { type: 'draft/discarded' });
    expect(state.dirty).toBe(false);
    expect(state.draft).toBeUndefined();
    expect(state.phase).toBe('ready');
  });

  it('★編集不可のキューは下書きを作らない', () => {
    const state = reducer(
      ready({ subtitles: [cue({ duplicateId: true, editable: false })] }),
      { type: 'draft/changed', patch: { text: 'x' } },
    );
    expect(state.dirty).toBe(false);
    expect(state.draft).toBeUndefined();
  });

  it('canEditCue は編集可否を返す', () => {
    expect(canEditCue(cue())).toBe(true);
    expect(canEditCue(cue({ editable: false }))).toBe(false);
    expect(canEditCue(undefined)).toBe(false);
  });
});

describe('saving / saved', () => {
  it('保存を開始すると saving になる', () => {
    const state = reducer(dirty(), { type: 'save/started' });
    expect(state.phase).toBe('saving');
  });

  it('★保存中は二重に保存を開始できない', () => {
    const saving = reducer(dirty(), { type: 'save/started' });
    expect(canSave(saving)).toBe(false);
    // もう一度 save/started を送っても状態は変わらない
    expect(reducer(saving, { type: 'save/started' })).toBe(saving);
  });

  it('★変更が無ければ保存を開始できない', () => {
    expect(canSave(ready())).toBe(false);
    expect(reducer(ready(), { type: 'save/started' }).phase).toBe('ready');
  });

  it('保存に成功すると saved になり、下書きが消える', () => {
    let state = reducer(dirty(), { type: 'save/started' });
    state = reducer(state, {
      type: 'save/succeeded',
      updatedAt: '2026-08-01T00:00:05.000Z',
      cue: cue({ text: '直した', edited: true }),
      counts: { ...counts, edited: 1 },
    });

    expect(state.phase).toBe('saved');
    expect(state.dirty).toBe(false);
    expect(state.draft).toBeUndefined();
    expect(state.updatedAt).toBe('2026-08-01T00:00:05.000Z');
    expect(state.data?.subtitles[0]?.text).toBe('直した');
    expect(state.data?.counts.edited).toBe(1);
  });

  it('★保存に失敗しても下書きを捨てない', () => {
    let state = reducer(dirty(), { type: 'save/started' });
    state = reducer(state, {
      type: 'save/failed',
      error: { code: 'UNKNOWN', userMessage: '保存できませんでした。', recoverable: true },
    });

    expect(state.phase).toBe('dirty');
    expect(state.draft?.text).toBe('直した');
    expect(canSave(state)).toBe(true);
  });
});

describe('conflict', () => {
  it('★競合したら conflict になり、上書きを促さない', () => {
    let state = reducer(dirty(), { type: 'save/started' });
    state = reducer(state, {
      type: 'save/conflicted',
      error: {
        code: 'PROJECT_CHANGED',
        userMessage: 'プロジェクトが別の処理で更新されました。再読み込みしてください',
        recoverable: true,
      },
    });

    expect(state.phase).toBe('conflict');
    expect(state.error?.userMessage).toContain('再読み込み');
    // 下書きは残る
    expect(state.draft?.text).toBe('直した');
    // ★競合中は保存も再出力もできない
    expect(canSave(state)).toBe(false);
    expect(canExport(state)).toBe(false);
  });

  it('競合中は下書きを変更できない', () => {
    let state = reducer(dirty(), { type: 'save/started' });
    state = reducer(state, {
      type: 'save/conflicted',
      error: { code: 'PROJECT_CHANGED', userMessage: 'x', recoverable: true },
    });
    const after = reducer(state, { type: 'draft/changed', patch: { text: 'さらに' } });
    expect(after.draft?.text).toBe('直した');
  });

  it('再読み込みで復帰する', () => {
    let state = reducer(dirty(), { type: 'save/started' });
    state = reducer(state, {
      type: 'save/conflicted',
      error: { code: 'PROJECT_CHANGED', userMessage: 'x', recoverable: true },
    });
    state = reducer(state, { type: 'load/succeeded', data: data() });
    expect(state.phase).toBe('ready');
    expect(state.error).toBeUndefined();
  });
});

describe('export', () => {
  it('再出力を開始できる', () => {
    const state = reducer(ready(), { type: 'export/started', runId: 'run-1' });
    expect(state.phase).toBe('export-running');
    expect(state.exportRunId).toBe('run-1');
  });

  it('★未保存の変更があると再出力できない', () => {
    expect(canExport(dirty())).toBe(false);
    expect(reducer(dirty(), { type: 'export/started', runId: 'run-1' }).phase).toBe('dirty');
  });

  it('★再出力中は再実行できない', () => {
    const running = reducer(ready(), { type: 'export/started', runId: 'run-1' });
    expect(canExport(running)).toBe(false);
    expect(reducer(running, { type: 'export/started', runId: 'run-2' })).toBe(running);
  });

  it('完了すると export-complete になる', () => {
    let state = reducer(ready(), { type: 'export/started', runId: 'run-1' });
    state = reducer(state, { type: 'export/finished', runId: 'run-1', ok: true });
    expect(state.phase).toBe('export-complete');
    expect(state.exportRunId).toBeUndefined();
    expect(canExport(state)).toBe(true);
  });

  it('失敗すると failed になる', () => {
    let state = reducer(ready(), { type: 'export/started', runId: 'run-1' });
    state = reducer(state, {
      type: 'export/finished',
      runId: 'run-1',
      ok: false,
      error: { code: 'UNKNOWN', userMessage: '再出力に失敗しました。', recoverable: true },
    });
    expect(state.phase).toBe('failed');
    expect(state.error?.userMessage).toBe('再出力に失敗しました。');
  });

  it('★別の実行の完了イベントは無視する', () => {
    const running = reducer(ready(), { type: 'export/started', runId: 'run-1' });
    const after = reducer(running, { type: 'export/finished', runId: 'run-9', ok: true });
    expect(after.phase).toBe('export-running');
  });
});

describe('再生位置との同期', () => {
  it('再生位置に対応するキューを返す', () => {
    const cues = data().subtitles;
    expect(cueIndexAtTime(cues, 0)).toBe(0);
    expect(cueIndexAtTime(cues, 2.4)).toBe(0);
    expect(cueIndexAtTime(cues, 2.5)).toBe(1);
    expect(cueIndexAtTime(cues, 99)).toBeUndefined();
  });

  it('★再生位置に合わせて字幕が自動選択される', () => {
    const state = reducer(ready(), { type: 'playhead/moved', sec: 3 });
    expect(state.playheadSec).toBe(3);
    expect(state.selectedIndex).toBe(1);
  });

  it('★編集中は再生位置で選択を動かさない（入力中の下書きを守る）', () => {
    const state = reducer(dirty(), { type: 'playhead/moved', sec: 3 });
    expect(state.playheadSec).toBe(3);
    expect(state.selectedIndex).toBe(0);
    expect(state.draft?.text).toBe('直した');
  });

  it('対応する字幕が無ければ選択を変えない', () => {
    const state = reducer(ready(), { type: 'playhead/moved', sec: 99 });
    expect(state.selectedIndex).toBe(0);
  });
});
