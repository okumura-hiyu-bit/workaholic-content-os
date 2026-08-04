/**
 * ショート候補Reviewの状態遷移。
 *
 * ★このテストの主眼は「二重保存・再出力中の再実行・未保存の変更の取りこぼし」を
 * 状態側で止められていること。ボタンのdisabledは見た目の防止でしかない。
 */

import { describe, expect, it } from 'vitest';

import type { SafePipelineError } from '../shared/dto.ts';
import type {
  ShortCandidateItem,
  ShortsCounts,
  ShortsData,
} from '../shared/shorts-dto.ts';
import {
  canExport,
  canSave,
  candidateIndexAtTime,
  draftOf,
  initialShortsState,
  isDraftChanged,
  reducer,
  visibleIndexes,
  type ShortsState,
} from './shorts-state.ts';

function candidate(
  id: string,
  startSec: number,
  endSec: number,
  overrides: Partial<ShortCandidateItem> = {},
): ShortCandidateItem {
  return {
    id,
    startSec,
    endSec,
    durationSec: endSec - startSec,
    score: 50,
    signals: ['笑い'],
    adopted: undefined,
    edited: false,
    rangeChanged: false,
    ...overrides,
  };
}

function counts(overrides: Partial<ShortsCounts> = {}): ShortsCounts {
  return {
    candidates: 3,
    adopted: 0,
    rejected: 0,
    undecided: 3,
    edited: 0,
    orphaned: 0,
    rangeChanged: 0,
    ...overrides,
  };
}

function data(overrides: Partial<ShortsData> = {}): ShortsData {
  return {
    summary: {
      projectPath: '/tmp/ep012',
      projectId: 'ep012',
      name: '第12回 収録',
      status: '確認待ち',
      assetCount: 1,
      updatedAt: '2026-08-04T00:00:00.000Z',
      notes: [],
    },
    updatedAt: '2026-08-04T00:00:00.000Z',
    speakers: [{ id: 'spk_a', name: '話者A' }],
    candidates: [
      candidate('short_01', 2, 32),
      candidate('short_02', 40, 70),
      candidate('short_03', 90, 105),
    ],
    counts: counts(),
    orphaned: [],
    reanalysisWarning: '再解析すると外れる可能性があります',
    fieldsNotExported: ['投稿文'],
    timecodeEditingSupported: false,
    ...overrides,
  };
}

const ERROR: SafePipelineError = {
  code: 'UNKNOWN',
  userMessage: '失敗しました',
  recoverable: true,
};

/** 読み込み済みの状態を作る。 */
function loaded(overrides: Partial<ShortsState> = {}): ShortsState {
  const base = reducer(initialShortsState, { type: 'load/succeeded', data: data() });
  return { ...base, ...overrides };
}

/** 下書きを1つ変更した状態を作る。 */
function dirty(): ShortsState {
  return reducer(loaded(), { type: 'draft/changed', patch: { adopted: true } });
}

describe('読み込み', () => {
  it('成功すると ready になり先頭を選択する', () => {
    const state = loaded();
    expect(state.phase).toBe('ready');
    expect(state.selectedIndex).toBe(0);
    expect(state.updatedAt).toBe('2026-08-04T00:00:00.000Z');
    expect(state.dirty).toBe(false);
  });

  it('候補が0件なら選択しない', () => {
    const state = reducer(initialShortsState, {
      type: 'load/succeeded',
      data: data({ candidates: [], counts: counts({ candidates: 0, undecided: 0 }) }),
    });
    expect(state.selectedIndex).toBeUndefined();
  });

  it('失敗すると failed になりエラーを保持する', () => {
    const state = reducer(initialShortsState, { type: 'load/failed', error: ERROR });
    expect(state.phase).toBe('failed');
    expect(state.error).toBe(ERROR);
  });

  it('★再読み込みで絞り込みは保つ（読み込むたびに戻ると使いにくい）', () => {
    const filtered = reducer(loaded(), { type: 'filter/changed', filter: 'undecided' });
    const reloaded = reducer(filtered, { type: 'load/started' });
    expect(reloaded.filter).toBe('undecided');
    expect(reloaded.phase).toBe('loading');
  });
});

describe('選択', () => {
  it('別の候補を選べる', () => {
    const state = reducer(loaded(), { type: 'candidate/selected', index: 2 });
    expect(state.selectedIndex).toBe(2);
  });

  it('★未保存の変更があるまま別の候補へ移らせない（黙って捨てないため）', () => {
    const state = reducer(dirty(), { type: 'candidate/selected', index: 2 });
    expect(state.selectedIndex).toBe(0);
    expect(state.dirty).toBe(true);
  });

  it('同じ候補の選び直しは許す', () => {
    const state = reducer(dirty(), { type: 'candidate/selected', index: 0 });
    expect(state.selectedIndex).toBe(0);
  });
});

describe('絞り込み', () => {
  it('採用・不採用・未判断で絞り込める', () => {
    const list = [
      candidate('short_01', 0, 10, { adopted: true }),
      candidate('short_02', 10, 20, { adopted: false }),
      candidate('short_03', 20, 30),
    ];
    expect(visibleIndexes(list, 'all')).toEqual([0, 1, 2]);
    expect(visibleIndexes(list, 'adopted')).toEqual([0]);
    expect(visibleIndexes(list, 'rejected')).toEqual([1]);
    expect(visibleIndexes(list, 'undecided')).toEqual([2]);
  });

  it('絞り込みは元の位置を保つ（選択インデックスとずれないため）', () => {
    const list = [
      candidate('short_01', 0, 10),
      candidate('short_02', 10, 20, { adopted: true }),
      candidate('short_03', 20, 30, { adopted: true }),
    ];
    expect(visibleIndexes(list, 'adopted')).toEqual([1, 2]);
  });

  it('★絞り込みを変えても未保存の変更は捨てない', () => {
    const state = reducer(dirty(), { type: 'filter/changed', filter: 'adopted' });
    expect(state.filter).toBe('adopted');
    expect(state.dirty).toBe(true);
    expect(state.draft).toBeDefined();
  });
});

describe('下書き', () => {
  it('採否を変えると dirty になる', () => {
    const state = dirty();
    expect(state.phase).toBe('dirty');
    expect(state.dirty).toBe(true);
    expect(state.draft?.adopted).toBe(true);
  });

  it('テキスト項目を変えても dirty になる', () => {
    const state = reducer(loaded(), {
      type: 'draft/changed',
      patch: { title: '神回の入り' },
    });
    expect(state.dirty).toBe(true);
    expect(state.draft?.title).toBe('神回の入り');
  });

  it('★元の値に戻したら dirty ではなくなる', () => {
    const changed = reducer(loaded(), { type: 'draft/changed', patch: { title: 'X' } });
    const restored = reducer(changed, { type: 'draft/changed', patch: { title: '' } });
    expect(restored.dirty).toBe(false);
    expect(restored.phase).toBe('ready');
  });

  it('複数項目の変更が積み上がる', () => {
    let state = reducer(loaded(), { type: 'draft/changed', patch: { adopted: true } });
    state = reducer(state, { type: 'draft/changed', patch: { title: 'T' } });
    expect(state.draft?.adopted).toBe(true);
    expect(state.draft?.title).toBe('T');
  });

  it('保存中・競合中は下書きを変えられない', () => {
    const saving = { ...dirty(), phase: 'saving' as const };
    expect(reducer(saving, { type: 'draft/changed', patch: { title: 'X' } })).toBe(saving);

    const conflict = { ...dirty(), phase: 'conflict' as const };
    expect(reducer(conflict, { type: 'draft/changed', patch: { title: 'X' } })).toBe(
      conflict,
    );
  });

  it('破棄すると ready に戻る', () => {
    const state = reducer(dirty(), { type: 'draft/discarded' });
    expect(state.phase).toBe('ready');
    expect(state.dirty).toBe(false);
    expect(state.draft).toBeUndefined();
  });

  it('draftOf は未設定の項目を空文字として扱う', () => {
    const d = draftOf(candidate('short_01', 0, 10), 0);
    expect(d).toEqual({
      index: 0,
      adopted: undefined,
      title: '',
      hook: '',
      caption: '',
      hashtags: [],
      note: '',
    });
  });

  it('isDraftChanged はハッシュタグの順序違いも変更として扱う', () => {
    const c = candidate('short_01', 0, 10, { hashtags: ['a', 'b'] });
    const same = { ...draftOf(c, 0) };
    expect(isDraftChanged(same, c)).toBe(false);
    expect(isDraftChanged({ ...same, hashtags: ['b', 'a'] }, c)).toBe(true);
    expect(isDraftChanged({ ...same, hashtags: ['a'] }, c)).toBe(true);
  });
});

describe('★保存', () => {
  it('canSave は未変更なら false', () => {
    expect(canSave(loaded())).toBe(false);
  });

  it('canSave は変更後 true', () => {
    expect(canSave(dirty())).toBe(true);
  });

  it('★保存中の再保存を止める（二重保存の防止）', () => {
    const saving = reducer(dirty(), { type: 'save/started' });
    expect(saving.phase).toBe('saving');
    expect(canSave(saving)).toBe(false);
    expect(reducer(saving, { type: 'save/started' })).toBe(saving);
  });

  it('★競合中・再出力中は保存できない', () => {
    expect(canSave({ ...dirty(), phase: 'conflict' })).toBe(false);
    expect(canSave({ ...dirty(), phase: 'export-running' })).toBe(false);
  });

  it('成功すると候補と件数が置き換わり、下書きが消える', () => {
    const saving = reducer(dirty(), { type: 'save/started' });
    const saved = reducer(saving, {
      type: 'save/succeeded',
      updatedAt: '2026-08-04T01:00:00.000Z',
      candidate: candidate('short_01', 2, 32, { adopted: true, edited: true }),
      counts: counts({ adopted: 1, undecided: 2, edited: 1 }),
    });

    expect(saved.phase).toBe('saved');
    expect(saved.dirty).toBe(false);
    expect(saved.draft).toBeUndefined();
    expect(saved.updatedAt).toBe('2026-08-04T01:00:00.000Z');
    expect(saved.data?.candidates[0]?.adopted).toBe(true);
    expect(saved.data?.counts.adopted).toBe(1);
  });

  it('★競合したら上書きせず、下書きを残したまま conflict にする', () => {
    const saving = reducer(dirty(), { type: 'save/started' });
    const conflicted = reducer(saving, { type: 'save/conflicted', error: ERROR });

    expect(conflicted.phase).toBe('conflict');
    expect(conflicted.draft).toBeDefined();
    expect(conflicted.error).toBe(ERROR);
  });

  it('★失敗しても下書きを捨てず、もう一度保存できる', () => {
    const saving = reducer(dirty(), { type: 'save/started' });
    const failed = reducer(saving, { type: 'save/failed', error: ERROR });

    expect(failed.phase).toBe('dirty');
    expect(failed.dirty).toBe(true);
    expect(canSave(failed)).toBe(true);
  });
});

describe('★再出力', () => {
  it('未保存の変更があるうちは始められない', () => {
    expect(canExport(dirty())).toBe(false);
  });

  it('保存済みなら始められる', () => {
    expect(canExport(loaded())).toBe(true);
  });

  it('★実行中の再実行を止める', () => {
    const running = reducer(loaded(), { type: 'export/started', runId: 'run-1' });
    expect(running.phase).toBe('export-running');
    expect(canExport(running)).toBe(false);
    expect(reducer(running, { type: 'export/started', runId: 'run-2' })).toBe(running);
  });

  it('完了すると export-complete になる', () => {
    const running = reducer(loaded(), { type: 'export/started', runId: 'run-1' });
    const done = reducer(running, { type: 'export/finished', runId: 'run-1', ok: true });
    expect(done.phase).toBe('export-complete');
    expect(done.exportRunId).toBeUndefined();
  });

  it('失敗すると failed になりエラーを持つ', () => {
    const running = reducer(loaded(), { type: 'export/started', runId: 'run-1' });
    const failed = reducer(running, {
      type: 'export/finished',
      runId: 'run-1',
      ok: false,
      error: ERROR,
    });
    expect(failed.phase).toBe('failed');
    expect(failed.error).toBe(ERROR);
  });

  it('★別の実行の完了イベントは無視する', () => {
    const running = reducer(loaded(), { type: 'export/started', runId: 'run-1' });
    expect(reducer(running, { type: 'export/finished', runId: 'other', ok: true })).toBe(
      running,
    );
  });
});

describe('再生位置', () => {
  it('位置に対応する候補を返す', () => {
    const list = [candidate('short_01', 2, 32), candidate('short_02', 40, 70)];
    expect(candidateIndexAtTime(list, 10)).toBe(0);
    expect(candidateIndexAtTime(list, 45)).toBe(1);
    expect(candidateIndexAtTime(list, 35)).toBeUndefined();
  });

  it('終端は次の候補に含めない（境界）', () => {
    const list = [candidate('short_01', 0, 10), candidate('short_02', 10, 20)];
    expect(candidateIndexAtTime(list, 10)).toBe(1);
  });

  it('再生に合わせて選択が動く', () => {
    const state = reducer(loaded(), { type: 'playhead/moved', sec: 45 });
    expect(state.playheadSec).toBe(45);
    expect(state.selectedIndex).toBe(1);
  });

  it('★編集中は再生に合わせて選択を動かさない（入力中の候補が変わらないように）', () => {
    const state = reducer(dirty(), { type: 'playhead/moved', sec: 45 });
    expect(state.playheadSec).toBe(45);
    expect(state.selectedIndex).toBe(0);
  });
});
