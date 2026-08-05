/**
 * カメラ切替Reviewの状態遷移。
 *
 * ★このテストの主眼は2つ。
 * 1. 二重保存・再出力中の再実行・未保存の変更の取りこぼしを状態側で止める
 * 2. ★重なり・不正な長さが残っているうちは保存・再出力させない
 *    （カメラは FCP7 XML を書き換える唯一の画面のため）
 */

import { describe, expect, it } from 'vitest';

import type { SafePipelineError } from '../shared/dto.ts';
import type {
  CameraCounts,
  CameraData,
  CameraShotItem,
} from '../shared/camera-dto.ts';
import {
  canExport,
  canInsert,
  canSave,
  draftOf,
  initialCameraState,
  isDraftChanged,
  isRangeValid,
  previewIssues,
  reducer,
  shotIndexAtTime,
  visibleIndexes,
  type CameraState,
} from './camera-state.ts';

function shot(
  id: string,
  startSec: number,
  endSec: number,
  overrides: Partial<CameraShotItem> = {},
): CameraShotItem {
  return {
    id,
    startSec,
    endSec,
    durationSec: endSec - startSec,
    cameraId: 'wide',
    cameraLabel: '引き',
    reason: 'speech',
    reasonLabel: '発話',
    edited: false,
    inserted: false,
    overlapsPrevious: false,
    tooShort: false,
    outOfRange: false,
    ...overrides,
  };
}

function counts(overrides: Partial<CameraCounts> = {}): CameraCounts {
  return {
    shots: 3,
    edited: 0,
    inserted: 0,
    deleted: 0,
    reattached: 0,
    orphaned: 0,
    overlaps: 0,
    gaps: 0,
    tooShort: 0,
    outOfRange: 0,
    ...overrides,
  };
}

function data(overrides: Partial<CameraData> = {}): CameraData {
  return {
    summary: {
      projectPath: '/tmp/ep012',
      projectId: 'ep012',
      name: '第12回 収録',
      status: '確認待ち',
      assetCount: 4,
      updatedAt: '2026-08-04T00:00:00.000Z',
      notes: [],
    },
    updatedAt: '2026-08-04T00:00:00.000Z',
    cameras: [
      { cameraId: 'wide', label: '引き', fileName: 'wide.mp4', durationSec: 120 },
      { cameraId: 'cam_A', label: '寄りA', fileName: 'cam_A.mp4', durationSec: 120 },
    ],
    shots: [
      shot('shot-00000000', 0, 10),
      shot('shot-00010000', 10, 25, { cameraId: 'cam_A', cameraLabel: '寄りA' }),
      shot('shot-00025000', 25, 40),
    ],
    counts: counts(),
    orphaned: [],
    timelineDurationSec: 120,
    minShotSec: 2.5,
    exportNotice: 'カメラ切替の修正は FCP7 XML に反映されます',
    ...overrides,
  };
}

const ERROR: SafePipelineError = {
  code: 'UNKNOWN',
  userMessage: '失敗しました',
  recoverable: true,
};

function loaded(overrides: Partial<CameraState> = {}): CameraState {
  const base = reducer(initialCameraState, { type: 'load/succeeded', data: data() });
  return { ...base, ...overrides };
}

/** 2番目のカットのカメラを変えた状態。 */
function dirty(): CameraState {
  const selected = reducer(loaded(), { type: 'shot/selected', index: 1 });
  return reducer(selected, { type: 'draft/changed', patch: { cameraId: 'wide' } });
}

describe('読み込み', () => {
  it('成功すると ready になり先頭を選択する', () => {
    const state = loaded();
    expect(state.phase).toBe('ready');
    expect(state.selectedIndex).toBe(0);
    expect(state.dirty).toBe(false);
  });

  it('カットが0件なら選択しない', () => {
    const state = reducer(initialCameraState, {
      type: 'load/succeeded',
      data: data({ shots: [], counts: counts({ shots: 0 }) }),
    });
    expect(state.selectedIndex).toBeUndefined();
  });

  it('失敗すると failed になりエラーを保持する', () => {
    const state = reducer(initialCameraState, { type: 'load/failed', error: ERROR });
    expect(state.phase).toBe('failed');
    expect(state.error).toBe(ERROR);
  });

  it('★再読み込みで絞り込みは保つ', () => {
    const filtered = reducer(loaded(), { type: 'filter/changed', filter: 'problem' });
    expect(reducer(filtered, { type: 'load/started' }).filter).toBe('problem');
  });
});

describe('選択', () => {
  it('別のカットを選べる', () => {
    expect(reducer(loaded(), { type: 'shot/selected', index: 2 }).selectedIndex).toBe(2);
  });

  it('★未保存の変更があるまま別のカットへ移らせない', () => {
    const state = reducer(dirty(), { type: 'shot/selected', index: 2 });
    expect(state.selectedIndex).toBe(1);
    expect(state.dirty).toBe(true);
  });
});

describe('絞り込み', () => {
  const list = [
    shot('a', 0, 10),
    shot('b', 10, 25, { edited: true }),
    shot('c', 25, 40, { inserted: true, edited: true }),
    shot('d', 40, 50, { overlapsPrevious: true }),
    shot('e', 50, 60, { reattached: { fromId: 'x', deltaSec: 0.2 } }),
  ];

  it('すべて／修正済み／追加／問題ありで絞り込める', () => {
    expect(visibleIndexes(list, 'all')).toEqual([0, 1, 2, 3, 4]);
    expect(visibleIndexes(list, 'edited')).toEqual([1, 2]);
    expect(visibleIndexes(list, 'inserted')).toEqual([2]);
    expect(visibleIndexes(list, 'problem')).toEqual([3, 4]);
  });

  it('★隙間・尺超過も「問題あり」に含める', () => {
    const withIssues = [
      shot('a', 0, 10),
      shot('b', 15, 25, { gapBeforeSec: 5 }),
      shot('c', 25, 40, { outOfRange: true }),
    ];
    expect(visibleIndexes(withIssues, 'problem')).toEqual([1, 2]);
  });

  it('絞り込みは元の位置を保つ（選択インデックスとずれない）', () => {
    expect(visibleIndexes(list, 'edited')).toEqual([1, 2]);
  });
});

describe('下書き', () => {
  it('カメラを変えると dirty になる', () => {
    const state = dirty();
    expect(state.phase).toBe('dirty');
    expect(state.draft?.cameraId).toBe('wide');
  });

  it('時刻を変えても dirty になる', () => {
    const state = reducer(loaded(), { type: 'draft/changed', patch: { endSec: 12 } });
    expect(state.dirty).toBe(true);
    expect(state.draft?.endSec).toBe(12);
  });

  it('★元の値に戻したら dirty ではなくなる', () => {
    const changed = dirty();
    const restored = reducer(changed, {
      type: 'draft/changed',
      patch: { cameraId: 'cam_A' },
    });
    expect(restored.dirty).toBe(false);
    expect(restored.phase).toBe('ready');
  });

  it('保存中・競合中は下書きを変えられない', () => {
    const saving = { ...dirty(), phase: 'saving' as const };
    expect(reducer(saving, { type: 'draft/changed', patch: { endSec: 30 } })).toBe(saving);
    const conflict = { ...dirty(), phase: 'conflict' as const };
    expect(reducer(conflict, { type: 'draft/changed', patch: { endSec: 30 } })).toBe(
      conflict,
    );
  });

  it('★追加中は既存カットを編集させない（どちらを保存するか曖昧になる）', () => {
    const inserting = reducer(loaded(), {
      type: 'insert/started',
      startSec: 40,
      endSec: 50,
      cameraId: 'wide',
    });
    expect(reducer(inserting, { type: 'draft/changed', patch: { endSec: 5 } })).toBe(
      inserting,
    );
  });

  it('破棄すると ready に戻る', () => {
    const state = reducer(dirty(), { type: 'draft/discarded' });
    expect(state.phase).toBe('ready');
    expect(state.dirty).toBe(false);
    expect(state.draft).toBeUndefined();
  });

  it('draftOf / isDraftChanged が対応する', () => {
    const s = shot('a', 0, 10, { cameraId: 'cam_A' });
    const d = draftOf(s, 0);
    expect(d).toEqual({ index: 0, cameraId: 'cam_A', startSec: 0, endSec: 10 });
    expect(isDraftChanged(d, s)).toBe(false);
    expect(isDraftChanged({ ...d, cameraId: 'wide' }, s)).toBe(true);
    expect(isDraftChanged({ ...d, endSec: 11 }, s)).toBe(true);
    // 1ms未満の差は変更とみなさない（浮動小数の誤差）。
    expect(isDraftChanged({ ...d, endSec: 10.0005 }, s)).toBe(false);
  });
});

describe('★整合性チェック（previewIssues）', () => {
  const shots = [shot('a', 0, 10), shot('b', 10, 25), shot('c', 25, 40)];

  it('問題が無ければ空', () => {
    expect(previewIssues(shots)).toEqual([]);
  });

  it('★下書きが隣と重なれば検出する', () => {
    const issues = previewIssues(shots, { index: 1, cameraId: 'wide', startSec: 5, endSec: 25 });
    expect(issues.some((i) => i.kind === 'overlap')).toBe(true);
  });

  it('★下書きの長さが不正なら検出する', () => {
    const issues = previewIssues(shots, { index: 1, cameraId: 'wide', startSec: 10, endSec: 11 });
    expect(issues.some((i) => i.kind === 'range')).toBe(true);
  });

  it('★追加中のカットが既存と重なれば検出する', () => {
    const issues = previewIssues(shots, undefined, {
      startSec: 20,
      endSec: 30,
      cameraId: 'wide',
    });
    expect(issues.some((i) => i.kind === 'overlap')).toBe(true);
  });

  it('末尾の後ろへの追加は問題なし', () => {
    expect(
      previewIssues(shots, undefined, { startSec: 40, endSec: 50, cameraId: 'wide' }),
    ).toEqual([]);
  });

  it('端が接するだけは重なりにしない', () => {
    expect(
      previewIssues(shots, { index: 1, cameraId: 'wide', startSec: 10, endSec: 25 }),
    ).toEqual([]);
  });

  it('isRangeValid が最短長を守る', () => {
    expect(isRangeValid(0, 2.5)).toBe(true);
    expect(isRangeValid(0, 2.4)).toBe(false);
    expect(isRangeValid(0, 0)).toBe(false);
    expect(isRangeValid(-1, 10)).toBe(false);
    expect(isRangeValid(0, Number.NaN)).toBe(false);
  });
});

describe('★保存', () => {
  it('canSave は未変更なら false', () => {
    expect(canSave(loaded())).toBe(false);
  });

  it('canSave は変更後 true', () => {
    expect(canSave(dirty())).toBe(true);
  });

  it('★重なる下書きでは保存させない（XMLが壊れるため）', () => {
    const selected = reducer(loaded(), { type: 'shot/selected', index: 1 });
    const overlapping = reducer(selected, {
      type: 'draft/changed',
      patch: { startSec: 5 },
    });
    expect(overlapping.dirty).toBe(true);
    expect(canSave(overlapping)).toBe(false);
  });

  it('★短すぎる下書きでは保存させない', () => {
    const selected = reducer(loaded(), { type: 'shot/selected', index: 1 });
    const tooShort = reducer(selected, { type: 'draft/changed', patch: { endSec: 11 } });
    expect(canSave(tooShort)).toBe(false);
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

  it('★成功すると並び全体が置き換わる（1要素ではない）', () => {
    const saving = reducer(dirty(), { type: 'save/started' });
    const nextShots = [
      shot('shot-00000000', 0, 10),
      shot('shot-00010000', 10, 25, { cameraId: 'wide', edited: true }),
    ];
    const saved = reducer(saving, {
      type: 'save/succeeded',
      updatedAt: '2026-08-04T01:00:00.000Z',
      shots: nextShots,
      counts: counts({ shots: 2, edited: 1, deleted: 1 }),
      orphaned: [],
    });

    expect(saved.phase).toBe('saved');
    expect(saved.dirty).toBe(false);
    expect(saved.draft).toBeUndefined();
    expect(saved.data?.shots).toHaveLength(2);
    expect(saved.data?.counts.deleted).toBe(1);
    expect(saved.updatedAt).toBe('2026-08-04T01:00:00.000Z');
  });

  it('★カットが減って選択が範囲外になったら寄せる', () => {
    const selected = reducer(loaded(), { type: 'shot/selected', index: 2 });
    const saved = reducer(selected, {
      type: 'save/succeeded',
      updatedAt: '2026-08-04T01:00:00.000Z',
      shots: [shot('shot-00000000', 0, 10)],
      counts: counts({ shots: 1 }),
      orphaned: [],
    });
    expect(saved.selectedIndex).toBe(0);
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

describe('★カットの追加', () => {
  it('追加を始められる', () => {
    const state = reducer(loaded(), {
      type: 'insert/started',
      startSec: 40,
      endSec: 50,
      cameraId: 'wide',
    });
    expect(state.insertDraft).toEqual({ startSec: 40, endSec: 50, cameraId: 'wide' });
    expect(canInsert(state)).toBe(true);
  });

  it('★未保存の変更があるうちは追加を始めさせない', () => {
    const state = reducer(dirty(), {
      type: 'insert/started',
      startSec: 40,
      endSec: 50,
      cameraId: 'wide',
    });
    expect(state.insertDraft).toBeUndefined();
  });

  it('★重なる追加は canInsert が false', () => {
    const state = reducer(loaded(), {
      type: 'insert/started',
      startSec: 20,
      endSec: 30,
      cameraId: 'wide',
    });
    expect(canInsert(state)).toBe(false);
  });

  it('追加中の値を変えられる', () => {
    const started = reducer(loaded(), {
      type: 'insert/started',
      startSec: 40,
      endSec: 50,
      cameraId: 'wide',
    });
    const changed = reducer(started, {
      type: 'insert/changed',
      patch: { cameraId: 'cam_A' },
    });
    expect(changed.insertDraft?.cameraId).toBe('cam_A');
  });

  it('取り消すと下書きが消える', () => {
    const started = reducer(loaded(), {
      type: 'insert/started',
      startSec: 40,
      endSec: 50,
      cameraId: 'wide',
    });
    expect(reducer(started, { type: 'insert/cancelled' }).insertDraft).toBeUndefined();
  });

  it('保存に成功すると追加の下書きも消える', () => {
    const started = reducer(loaded(), {
      type: 'insert/started',
      startSec: 40,
      endSec: 50,
      cameraId: 'wide',
    });
    const saving = reducer(started, { type: 'save/started' });
    const saved = reducer(saving, {
      type: 'save/succeeded',
      updatedAt: '2026-08-04T01:00:00.000Z',
      shots: data().shots,
      counts: counts(),
      orphaned: [],
    });
    expect(saved.insertDraft).toBeUndefined();
  });
});

describe('★再出力', () => {
  it('未保存の変更があるうちは始められない', () => {
    expect(canExport(dirty())).toBe(false);
  });

  it('保存済みなら始められる', () => {
    expect(canExport(loaded())).toBe(true);
  });

  it('★重なりが残っていれば始められない（壊れたXMLを書き出さない）', () => {
    const withOverlap = reducer(initialCameraState, {
      type: 'load/succeeded',
      data: data({ counts: counts({ overlaps: 1 }) }),
    });
    expect(canExport(withOverlap)).toBe(false);
  });

  it('★尺超過が残っていれば始められない', () => {
    const withOutOfRange = reducer(initialCameraState, {
      type: 'load/succeeded',
      data: data({ counts: counts({ outOfRange: 1 }) }),
    });
    expect(canExport(withOutOfRange)).toBe(false);
  });

  it('隙間だけなら始められる（意図的な間の可能性がある）', () => {
    const withGap = reducer(initialCameraState, {
      type: 'load/succeeded',
      data: data({ counts: counts({ gaps: 1 }) }),
    });
    expect(canExport(withGap)).toBe(true);
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
  it('位置に対応するカットを返す', () => {
    const list = [shot('a', 0, 10), shot('b', 10, 25)];
    expect(shotIndexAtTime(list, 5)).toBe(0);
    expect(shotIndexAtTime(list, 10)).toBe(1);
    expect(shotIndexAtTime(list, 30)).toBeUndefined();
  });

  it('再生に合わせて選択が動く', () => {
    const state = reducer(loaded(), { type: 'playhead/moved', sec: 30 });
    expect(state.selectedIndex).toBe(2);
  });

  it('★編集中は再生に合わせて選択を動かさない', () => {
    const state = reducer(dirty(), { type: 'playhead/moved', sec: 30 });
    expect(state.selectedIndex).toBe(1);
  });

  it('★追加中も選択を動かさない', () => {
    const inserting = reducer(loaded(), {
      type: 'insert/started',
      startSec: 40,
      endSec: 50,
      cameraId: 'wide',
    });
    const moved = reducer(inserting, { type: 'playhead/moved', sec: 30 });
    expect(moved.selectedIndex).toBe(0);
  });
});
