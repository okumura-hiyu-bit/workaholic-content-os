/**
 * 復旧画面の状態遷移。
 *
 * ★主眼は「位置で持っている選択が、一覧の変化で別の項目を指さないこと」。
 * この画面は直すたびに一覧から項目が消えるため、選択を残すと危険。
 */

import { describe, expect, it } from 'vitest';

import type {
  RecoveryCounts,
  RecoveryData,
  RecoveryItem,
  RecoveryTarget,
} from '../shared/recovery-dto.ts';
import {
  canDiscard,
  canReattach,
  initialRecoveryState,
  reducer,
  selectedItem,
  visibleIndexes,
  type RecoveryState,
} from './recovery-state.ts';

function item(over: Partial<RecoveryItem> = {}): RecoveryItem {
  return {
    key: over.key ?? 'subtitle:orphaned:sub-00100000',
    domain: over.domain ?? 'subtitle',
    kind: over.kind ?? 'orphaned',
    sourceId: over.sourceId ?? 'sub-00100000',
    headline: over.headline ?? '字幕の修正が繋がりませんでした',
    reattachable: over.reattachable ?? true,
    ...(over.approxSec !== undefined ? { approxSec: over.approxSec } : {}),
  };
}

function counts(over: Partial<RecoveryCounts> = {}): RecoveryCounts {
  return {
    total: 0,
    reattachable: 0,
    byDomain: { subtitle: 0, short: 0, cameraShot: 0, marker: 0 },
    byKind: {
      orphaned: 0,
      reattached: 0,
      kindMismatch: 0,
      rangeChanged: 0,
      conflicted: 0,
    },
    ...over,
  };
}

function data(items: RecoveryItem[]): RecoveryData {
  return {
    summary: {
      projectPath: '/tmp/ep012',
      projectId: 'ep012',
      name: '第12回 収録',
      status: '確認待ち',
      assetCount: 4,
      updatedAt: '2026-08-01T00:00:00.000Z',
      notes: [],
    },
    updatedAt: '2026-08-01T00:00:00.000Z',
    items,
    counts: counts({ total: items.length }),
  };
}

function loaded(items: RecoveryItem[]): RecoveryState {
  return reducer(initialRecoveryState, { type: 'load/succeeded', data: data(items) });
}

const target = (over: Partial<RecoveryTarget> = {}): RecoveryTarget => ({
  id: over.id ?? 'sub-00002500',
  startSec: over.startSec ?? 2.5,
  label: over.label ?? 'よろしくお願いします',
  occupied: over.occupied ?? false,
  ...(over.deltaSec !== undefined ? { deltaSec: over.deltaSec } : {}),
});

describe('読み込み', () => {
  it('成功すると ready になり updatedAt を持つ', () => {
    const state = loaded([item()]);
    expect(state.phase).toBe('ready');
    expect(state.updatedAt).toBe('2026-08-01T00:00:00.000Z');
    expect(state.data?.items).toHaveLength(1);
  });

  it('★読み直すと選択と候補を捨てる（並びが変わるため）', () => {
    let state = loaded([item(), item({ key: 'b', sourceId: 'sub-00200000' })]);
    state = reducer(state, { type: 'item/selected', index: 1 });
    state = reducer(state, { type: 'targets/succeeded', targets: [target()] });
    expect(state.selectedIndex).toBe(1);

    state = reducer(state, { type: 'load/succeeded', data: data([item()]) });
    expect(state.selectedIndex).toBeUndefined();
    expect(state.targets).toBeUndefined();
    expect(state.selectedTargetId).toBeUndefined();
  });

  it('失敗すると failed になりエラーを持つ', () => {
    const state = reducer(initialRecoveryState, {
      type: 'load/failed',
      error: { code: 'INVALID_PROJECT', userMessage: 'ダメ', recoverable: true },
    });
    expect(state.phase).toBe('failed');
    expect(state.error?.userMessage).toBe('ダメ');
  });
});

describe('絞り込み', () => {
  const items = [
    item({ key: 'a', domain: 'subtitle', kind: 'orphaned' }),
    item({ key: 'b', domain: 'marker', kind: 'kindMismatch', reattachable: false }),
    item({ key: 'c', domain: 'marker', kind: 'orphaned' }),
    item({ key: 'd', domain: 'short', kind: 'rangeChanged', reattachable: false }),
  ];

  it('対象で絞り込む（元の index を保つ）', () => {
    expect(visibleIndexes(items, 'marker', 'all')).toEqual([1, 2]);
  });

  it('種別で絞り込む', () => {
    expect(visibleIndexes(items, 'all', 'orphaned')).toEqual([0, 2]);
  });

  it('対象と種別を重ねて絞り込む', () => {
    expect(visibleIndexes(items, 'marker', 'orphaned')).toEqual([2]);
  });

  it('すべてなら全件', () => {
    expect(visibleIndexes(items, 'all', 'all')).toEqual([0, 1, 2, 3]);
  });

  it('★絞り込みを変えると選択を解除する（別の項目を指さないため）', () => {
    let state = loaded(items);
    state = reducer(state, { type: 'item/selected', index: 2 });
    expect(state.selectedIndex).toBe(2);

    state = reducer(state, { type: 'domainFilter/changed', filter: 'short' });
    expect(state.selectedIndex).toBeUndefined();
    expect(state.targets).toBeUndefined();
  });
});

describe('選択', () => {
  it('選ぶと選択中の項目を引ける', () => {
    let state = loaded([item({ key: 'a' }), item({ key: 'b', sourceId: 'sub-00200000' })]);
    state = reducer(state, { type: 'item/selected', index: 1 });
    expect(selectedItem(state)?.sourceId).toBe('sub-00200000');
  });

  it('★項目を変えると前の候補を捨てる', () => {
    let state = loaded([item({ key: 'a' }), item({ key: 'b' })]);
    state = reducer(state, { type: 'targets/succeeded', targets: [target()] });
    state = reducer(state, { type: 'target/selected', targetId: 'sub-00002500' });
    state = reducer(state, { type: 'item/selected', index: 1 });
    expect(state.targets).toBeUndefined();
    expect(state.selectedTargetId).toBeUndefined();
  });

  it('選択を解除できる', () => {
    let state = loaded([item()]);
    state = reducer(state, { type: 'item/selected', index: 0 });
    state = reducer(state, { type: 'item/deselected' });
    expect(state.selectedIndex).toBeUndefined();
    expect(selectedItem(state)).toBeUndefined();
  });
});

describe('canReattach：付け替えてよいか', () => {
  function ready(): RecoveryState {
    let state = loaded([item()]);
    state = reducer(state, { type: 'item/selected', index: 0 });
    state = reducer(state, { type: 'targets/succeeded', targets: [target()] });
    return reducer(state, { type: 'target/selected', targetId: 'sub-00002500' });
  }

  it('孤立を選び、埋まっていない候補を選んでいれば押せる', () => {
    expect(canReattach(ready())).toBe(true);
  });

  it('候補を選んでいなければ押せない', () => {
    let state = loaded([item()]);
    state = reducer(state, { type: 'item/selected', index: 0 });
    state = reducer(state, { type: 'targets/succeeded', targets: [target()] });
    expect(canReattach(state)).toBe(false);
  });

  it('★埋まっている候補は選んでも押せない（先客を押し出さない）', () => {
    let state = loaded([item()]);
    state = reducer(state, { type: 'item/selected', index: 0 });
    state = reducer(state, {
      type: 'targets/succeeded',
      targets: [target({ occupied: true })],
    });
    state = reducer(state, { type: 'target/selected', targetId: 'sub-00002500' });
    expect(canReattach(state)).toBe(false);
  });

  it('★付け替えできない種別では押せない', () => {
    let state = loaded([item({ kind: 'conflicted', reattachable: false })]);
    state = reducer(state, { type: 'item/selected', index: 0 });
    state = reducer(state, { type: 'targets/succeeded', targets: [target()] });
    state = reducer(state, { type: 'target/selected', targetId: 'sub-00002500' });
    expect(canReattach(state)).toBe(false);
  });

  it('★保存中・競合中は押せない（連打と二重保存を止める）', () => {
    for (const phase of ['saving', 'conflict', 'export-running', 'loading'] as const) {
      expect(canReattach({ ...ready(), phase })).toBe(false);
    }
  });
});

describe('canDiscard：破棄してよいか', () => {
  it('項目を選んでいれば押せる（種別を問わない）', () => {
    let state = loaded([item({ kind: 'conflicted', reattachable: false })]);
    state = reducer(state, { type: 'item/selected', index: 0 });
    expect(canDiscard(state)).toBe(true);
  });

  it('何も選んでいなければ押せない', () => {
    expect(canDiscard(loaded([item()]))).toBe(false);
  });

  it('★保存中・競合中は押せない', () => {
    let state = loaded([item()]);
    state = reducer(state, { type: 'item/selected', index: 0 });
    for (const phase of ['saving', 'conflict', 'export-running', 'loading'] as const) {
      expect(canDiscard({ ...state, phase })).toBe(false);
    }
  });
});

describe('保存', () => {
  it('成功すると一覧を差し替え、選択を解除する', () => {
    let state = loaded([item({ key: 'a' }), item({ key: 'b' })]);
    state = reducer(state, { type: 'item/selected', index: 0 });
    state = reducer(state, { type: 'save/started' });
    expect(state.phase).toBe('saving');

    state = reducer(state, {
      type: 'save/succeeded',
      updatedAt: '2026-08-02T00:00:00.000Z',
      items: [item({ key: 'b' })],
      counts: counts({ total: 1 }),
    });

    expect(state.phase).toBe('saved');
    expect(state.updatedAt).toBe('2026-08-02T00:00:00.000Z');
    expect(state.data?.items).toHaveLength(1);
    // ★直した項目は消える。位置で持つ選択は必ず解除する。
    expect(state.selectedIndex).toBeUndefined();
    expect(state.targets).toBeUndefined();
  });

  it('★競合すると conflict になり、以降の操作を止める', () => {
    let state = loaded([item()]);
    state = reducer(state, { type: 'item/selected', index: 0 });
    state = reducer(state, {
      type: 'save/conflicted',
      error: { code: 'PROJECT_CHANGED', userMessage: '競合', recoverable: true },
    });
    expect(state.phase).toBe('conflict');
    expect(canDiscard(state)).toBe(false);
    expect(canReattach(state)).toBe(false);
  });

  it('失敗すると failed になる', () => {
    let state = loaded([item()]);
    state = reducer(state, {
      type: 'save/failed',
      error: { code: 'UNKNOWN', userMessage: '保存できません', recoverable: true },
    });
    expect(state.phase).toBe('failed');
  });
});

describe('再生位置', () => {
  it('playhead/moved で更新する', () => {
    const state = reducer(loaded([item()]), { type: 'playhead/moved', sec: 12.5 });
    expect(state.playheadSec).toBe(12.5);
  });
});
