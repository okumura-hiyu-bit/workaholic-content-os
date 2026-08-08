/**
 * マーカーReviewの状態遷移。
 *
 * ★このテストの主眼は、二重保存・未保存の取りこぼし・ID重複マーカーの
 * 保存抑止を状態側で止めること、および種別と状態の2軸絞り込み。
 */

import { describe, expect, it } from 'vitest';

import type { SafePipelineError } from '../shared/dto.ts';
import type {
  MarkerCounts,
  MarkerData,
  MarkerItem,
} from '../shared/marker-dto.ts';
import {
  canEditMarker,
  canExport,
  canSave,
  draftOf,
  initialMarkerState,
  isDraftChanged,
  markerIndexAtTime,
  needsAttention,
  reducer,
  visibleIndexes,
  type MarkerState,
} from './marker-state.ts';

function marker(
  id: string,
  kind: MarkerItem['kind'],
  startSec: number,
  overrides: Partial<MarkerItem> = {},
): MarkerItem {
  return {
    id,
    kind,
    kindLabel: kind,
    startSec,
    name: `${kind}名`,
    comment: 'コメント',
    edited: false,
    volatileId: false,
    duplicateId: false,
    editable: true,
    ...overrides,
  };
}

function counts(overrides: Partial<MarkerCounts> = {}): MarkerCounts {
  return {
    markers: 3,
    edited: 0,
    deleted: 0,
    reattached: 0,
    kindMismatch: 0,
    orphaned: 0,
    volatile: 1,
    duplicateId: 0,
    ...overrides,
  };
}

function data(overrides: Partial<MarkerData> = {}): MarkerData {
  return {
    summary: {
      projectPath: '/tmp/ep012',
      projectId: 'ep012',
      name: '第12回 収録',
      status: '確認待ち',
      assetCount: 4,
      updatedAt: '2026-08-05T00:00:00.000Z',
      notes: [],
    },
    updatedAt: '2026-08-05T00:00:00.000Z',
    markers: [
      marker('mk-TOPIC-00000000', 'TOPIC', 0),
      marker('mk-CHECK-check-lowconf-7700', 'CHECK', 7.7, { volatileId: true }),
      marker('mk-LAUGH-00033990', 'LAUGH', 33.99, { endSec: 36.01 }),
    ],
    counts: counts(),
    kinds: [
      { kind: 'TOPIC', label: '話題', count: 1 },
      { kind: 'LAUGH', label: '笑い', count: 1 },
      { kind: 'CHECK', label: '要確認', count: 1 },
    ],
    orphaned: [],
    exportNotice: 'マーカーの修正は FCP7 XML にだけ反映されます',
    namePrefixNotice: 'Premiereのマーカー名には種別が自動で付きます',
    timeEditingSupported: false,
    markerCreationSupported: false,
    ...overrides,
  };
}

const ERROR: SafePipelineError = {
  code: 'UNKNOWN',
  userMessage: '失敗しました',
  recoverable: true,
};

function loaded(overrides: Partial<MarkerState> = {}): MarkerState {
  const base = reducer(initialMarkerState, { type: 'load/succeeded', data: data() });
  return { ...base, ...overrides };
}

function dirty(): MarkerState {
  return reducer(loaded(), { type: 'draft/changed', patch: { name: '第1章' } });
}

describe('読み込み', () => {
  it('成功すると ready になり先頭を選択する', () => {
    const state = loaded();
    expect(state.phase).toBe('ready');
    expect(state.selectedIndex).toBe(0);
    expect(state.dirty).toBe(false);
  });

  it('マーカーが0件なら選択しない', () => {
    const state = reducer(initialMarkerState, {
      type: 'load/succeeded',
      data: data({ markers: [], counts: counts({ markers: 0 }) }),
    });
    expect(state.selectedIndex).toBeUndefined();
  });

  it('失敗すると failed になりエラーを保持する', () => {
    const state = reducer(initialMarkerState, { type: 'load/failed', error: ERROR });
    expect(state.phase).toBe('failed');
    expect(state.error).toBe(ERROR);
  });

  it('★再読み込みで絞り込み（状態・種別の両方）を保つ', () => {
    let state = reducer(loaded(), { type: 'filter/changed', filter: 'attention' });
    state = reducer(state, { type: 'kindFilter/changed', kind: 'CHECK' });
    const reloaded = reducer(state, { type: 'load/started' });
    expect(reloaded.filter).toBe('attention');
    expect(reloaded.kindFilter).toBe('CHECK');
  });
});

describe('選択', () => {
  it('別のマーカーを選べる', () => {
    expect(reducer(loaded(), { type: 'marker/selected', index: 2 }).selectedIndex).toBe(2);
  });

  it('★未保存の変更があるまま別のマーカーへ移らせない', () => {
    const state = reducer(dirty(), { type: 'marker/selected', index: 2 });
    expect(state.selectedIndex).toBe(0);
    expect(state.dirty).toBe(true);
  });
});

describe('★絞り込み（種別 × 状態の2軸）', () => {
  const list = [
    marker('a', 'TOPIC', 0),
    marker('b', 'CHECK', 5, { volatileId: true, edited: true }),
    marker('c', 'LAUGH', 10, { edited: true }),
    marker('d', 'TOPIC', 20, { reattachedKindMismatch: { fromKind: 'TOPIC', toKind: 'LAUGH' } }),
    marker('e', 'CHECK', 30, { duplicateId: true, editable: false }),
  ];

  it('状態で絞り込める', () => {
    expect(visibleIndexes(list, 'all')).toEqual([0, 1, 2, 3, 4]);
    expect(visibleIndexes(list, 'edited')).toEqual([1, 2]);
  });

  it('★「要確認」は種別またぎ・ID重複・volatileな修正を束ねる', () => {
    expect(visibleIndexes(list, 'attention')).toEqual([1, 3, 4]);
  });

  it('種別で絞り込める', () => {
    expect(visibleIndexes(list, 'all', 'CHECK')).toEqual([1, 4]);
    expect(visibleIndexes(list, 'all', 'TOPIC')).toEqual([0, 3]);
  });

  it('★種別と状態を同時に絞り込める', () => {
    expect(visibleIndexes(list, 'edited', 'CHECK')).toEqual([1]);
    expect(visibleIndexes(list, 'attention', 'TOPIC')).toEqual([3]);
  });

  it('絞り込みは元の位置を保つ（選択インデックスとずれない）', () => {
    expect(visibleIndexes(list, 'edited')).toEqual([1, 2]);
  });

  it('種別の絞り込みを解除できる', () => {
    let state = reducer(loaded(), { type: 'kindFilter/changed', kind: 'CHECK' });
    expect(state.kindFilter).toBe('CHECK');
    state = reducer(state, { type: 'kindFilter/changed' });
    expect(state.kindFilter).toBeUndefined();
  });

  it('needsAttention は未編集の volatile を含めない（警告過多を避ける）', () => {
    expect(needsAttention(marker('x', 'CHECK', 0, { volatileId: true }))).toBe(false);
    expect(
      needsAttention(marker('x', 'CHECK', 0, { volatileId: true, edited: true })),
    ).toBe(true);
  });
});

describe('下書き', () => {
  it('名前を変えると dirty になる', () => {
    const state = dirty();
    expect(state.phase).toBe('dirty');
    expect(state.draft?.name).toBe('第1章');
  });

  it('コメントを変えても dirty になる', () => {
    const state = reducer(loaded(), { type: 'draft/changed', patch: { comment: 'X' } });
    expect(state.dirty).toBe(true);
  });

  it('★元の値に戻したら dirty ではなくなる', () => {
    const changed = dirty();
    const restored = reducer(changed, {
      type: 'draft/changed',
      patch: { name: 'TOPIC名' },
    });
    expect(restored.dirty).toBe(false);
    expect(restored.phase).toBe('ready');
  });

  it('★ID重複のマーカーは下書きも作らせない', () => {
    const withDuplicate = reducer(initialMarkerState, {
      type: 'load/succeeded',
      data: data({
        markers: [marker('dup', 'TOPIC', 0, { duplicateId: true, editable: false })],
        counts: counts({ markers: 1, duplicateId: 1 }),
      }),
    });
    expect(reducer(withDuplicate, { type: 'draft/changed', patch: { name: 'X' } })).toBe(
      withDuplicate,
    );
  });

  it('保存中・競合中は下書きを変えられない', () => {
    const saving = { ...dirty(), phase: 'saving' as const };
    expect(reducer(saving, { type: 'draft/changed', patch: { name: 'Y' } })).toBe(saving);
    const conflict = { ...dirty(), phase: 'conflict' as const };
    expect(reducer(conflict, { type: 'draft/changed', patch: { name: 'Y' } })).toBe(
      conflict,
    );
  });

  it('破棄すると ready に戻る', () => {
    const state = reducer(dirty(), { type: 'draft/discarded' });
    expect(state.phase).toBe('ready');
    expect(state.dirty).toBe(false);
    expect(state.draft).toBeUndefined();
  });

  it('draftOf / isDraftChanged が対応する', () => {
    const m = marker('a', 'TOPIC', 0);
    const d = draftOf(m, 0);
    expect(d).toEqual({ index: 0, name: 'TOPIC名', comment: 'コメント' });
    expect(isDraftChanged(d, m)).toBe(false);
    expect(isDraftChanged({ ...d, name: 'X' }, m)).toBe(true);
    expect(isDraftChanged({ ...d, comment: '' }, m)).toBe(true);
  });

  it('canEditMarker は ID重複を弾く', () => {
    expect(canEditMarker(marker('a', 'TOPIC', 0))).toBe(true);
    expect(canEditMarker(marker('a', 'TOPIC', 0, { editable: false }))).toBe(false);
    expect(canEditMarker(undefined)).toBe(false);
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

  it('成功すると該当マーカーが置き換わる', () => {
    const saving = reducer(dirty(), { type: 'save/started' });
    const saved = reducer(saving, {
      type: 'save/succeeded',
      updatedAt: '2026-08-05T01:00:00.000Z',
      marker: marker('mk-TOPIC-00000000', 'TOPIC', 0, { name: '第1章', edited: true }),
      counts: counts({ edited: 1 }),
      orphaned: [],
    });

    expect(saved.phase).toBe('saved');
    expect(saved.dirty).toBe(false);
    expect(saved.draft).toBeUndefined();
    expect(saved.data?.markers[0]?.name).toBe('第1章');
    expect(saved.data?.markers).toHaveLength(3);
    expect(saved.updatedAt).toBe('2026-08-05T01:00:00.000Z');
  });

  it('★削除（marker が undefined）のときは一覧を据え置き、件数だけ更新する', () => {
    const saved = reducer(loaded(), {
      type: 'save/succeeded',
      updatedAt: '2026-08-05T01:00:00.000Z',
      counts: counts({ markers: 2, deleted: 1 }),
      orphaned: [],
    });
    expect(saved.phase).toBe('saved');
    expect(saved.data?.counts.deleted).toBe(1);
    // 一覧は呼び出し側の再読み込みで揃える。
    expect(saved.data?.markers).toHaveLength(3);
  });

  it('孤立の一覧も更新する', () => {
    const saved = reducer(loaded(), {
      type: 'save/succeeded',
      updatedAt: '2026-08-05T01:00:00.000Z',
      marker: marker('mk-TOPIC-00000000', 'TOPIC', 0),
      counts: counts({ orphaned: 1 }),
      orphaned: [{ originalId: 'mk-CHECK-x', reason: 'IDから時刻を読み取れず' }],
    });
    expect(saved.data?.orphaned).toHaveLength(1);
  });

  it('★競合したら上書きせず、下書きを残したまま conflict にする', () => {
    const saving = reducer(dirty(), { type: 'save/started' });
    const conflicted = reducer(saving, { type: 'save/conflicted', error: ERROR });
    expect(conflicted.phase).toBe('conflict');
    expect(conflicted.draft).toBeDefined();
  });

  it('★失敗しても下書きを捨てない', () => {
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

  it('★孤立や種別またぎが残っていても出力できる（XMLは壊れないため）', () => {
    const withIssues = reducer(initialMarkerState, {
      type: 'load/succeeded',
      data: data({ counts: counts({ orphaned: 2, kindMismatch: 1 }) }),
    });
    expect(canExport(withIssues)).toBe(true);
  });

  it('★実行中の再実行を止める', () => {
    const running = reducer(loaded(), { type: 'export/started', runId: 'run-1' });
    expect(running.phase).toBe('export-running');
    expect(reducer(running, { type: 'export/started', runId: 'run-2' })).toBe(running);
  });

  it('完了すると export-complete になる', () => {
    const running = reducer(loaded(), { type: 'export/started', runId: 'run-1' });
    const done = reducer(running, { type: 'export/finished', runId: 'run-1', ok: true });
    expect(done.phase).toBe('export-complete');
    expect(done.exportRunId).toBeUndefined();
  });

  it('失敗すると failed になる', () => {
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
  it('★点マーカーは「直前の最も近いもの」を選ぶ', () => {
    const list = [marker('a', 'TOPIC', 0), marker('b', 'LAUGH', 10)];
    expect(markerIndexAtTime(list, 5)).toBe(0);
    expect(markerIndexAtTime(list, 10)).toBe(1);
    expect(markerIndexAtTime(list, 999)).toBe(1);
  });

  it('先頭より前なら選ばない', () => {
    const list = [marker('a', 'TOPIC', 5)];
    expect(markerIndexAtTime(list, 1)).toBeUndefined();
  });

  it('再生に合わせて選択が動く', () => {
    const state = reducer(loaded(), { type: 'playhead/moved', sec: 34 });
    expect(state.selectedIndex).toBe(2);
  });

  it('★編集中は再生に合わせて選択を動かさない', () => {
    const state = reducer(dirty(), { type: 'playhead/moved', sec: 34 });
    expect(state.selectedIndex).toBe(0);
  });
});
