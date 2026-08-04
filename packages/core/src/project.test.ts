/**
 * 字幕IDの採番とIDからの時刻復元。
 *
 * ★字幕IDは人間の修正（edits.subtitles）のキーそのもの。
 * ここが変わると保存済みの修正が孤立するため、
 * 「衝突していないIDは絶対に変わらない」ことを最優先で固定する。
 */

import { describe, expect, it } from 'vitest';

import {
  assignSubtitleIds,
  cameraShotId,
  chapterId,
  duplicateStartCount,
  markerId,
  occurrenceFromId,
  subtitleId,
  timeFromId,
} from './project.ts';

describe('subtitleId', () => {
  it('★1件目は連番を付けない（従来のIDと完全一致）', () => {
    expect(subtitleId(20.96)).toBe('sub-00020960');
    expect(subtitleId(20.96, 1)).toBe('sub-00020960');
    expect(subtitleId(0)).toBe('sub-00000000');
  });

  it('2件目以降に連番を付ける', () => {
    expect(subtitleId(20.96, 2)).toBe('sub-00020960-2');
    expect(subtitleId(20.96, 3)).toBe('sub-00020960-3');
    expect(subtitleId(20.96, 12)).toBe('sub-00020960-12');
  });

  it('負の時刻は0に丸める', () => {
    expect(subtitleId(-5)).toBe('sub-00000000');
  });
});

describe('assignSubtitleIds', () => {
  it('★同一開始時刻の2件が一意になる', () => {
    const ids = assignSubtitleIds([{ startSec: 20.96 }, { startSec: 20.96 }]);
    expect(ids).toEqual(['sub-00020960', 'sub-00020960-2']);
    expect(new Set(ids).size).toBe(2);
  });

  it('★同一開始時刻の3件以上が一意になる', () => {
    const ids = assignSubtitleIds([
      { startSec: 20.96 },
      { startSec: 20.96 },
      { startSec: 20.96 },
      { startSec: 20.96 },
    ]);
    expect(ids).toEqual([
      'sub-00020960',
      'sub-00020960-2',
      'sub-00020960-3',
      'sub-00020960-4',
    ]);
    expect(new Set(ids).size).toBe(4);
  });

  it('★1件目は既存IDを維持する', () => {
    const ids = assignSubtitleIds([{ startSec: 20.96 }, { startSec: 20.96 }]);
    expect(ids[0]).toBe(subtitleId(20.96));
  });

  it('★衝突しないキューのIDは従来と完全一致する', () => {
    const cues = [
      { startSec: 0 },
      { startSec: 0.62 },
      { startSec: 21.12 },
      { startSec: 23.94 },
      { startSec: 34.6 },
    ];
    const ids = assignSubtitleIds(cues);
    // 連番なしの形＝変更前の subtitleId(startSec) と同じ
    expect(ids).toEqual([
      'sub-00000000',
      'sub-00000620',
      'sub-00021120',
      'sub-00023940',
      'sub-00034600',
    ]);
    expect(ids.every((id) => !id.includes('-', 4))).toBe(true);
  });

  it('★同じ入力なら毎回同じIDになる（再実行で入れ替わらない）', () => {
    const cues = [
      { startSec: 20.96 },
      { startSec: 20.96 },
      { startSec: 20.96 },
      { startSec: 21.12 },
    ];
    const first = assignSubtitleIds(cues);
    for (let i = 0; i < 20; i += 1) {
      expect(assignSubtitleIds(cues)).toEqual(first);
    }
  });

  it('★並び順が変われば採番も変わる（順序に依存することを明示）', () => {
    // 入力順が安定していることが前提。順序が変わるとIDも変わるので、
    // 上流（buildSubtitleCues）が安定した順序を返すことが要件になる。
    const a = assignSubtitleIds([{ startSec: 1 }, { startSec: 1 }, { startSec: 2 }]);
    const b = assignSubtitleIds([{ startSec: 2 }, { startSec: 1 }, { startSec: 1 }]);
    expect(a).toEqual(['sub-00001000', 'sub-00001000-2', 'sub-00002000']);
    expect(b).toEqual(['sub-00002000', 'sub-00001000', 'sub-00001000-2']);
  });

  it('離れた位置にある同一開始時刻にも通し番号を振る', () => {
    const ids = assignSubtitleIds([
      { startSec: 1 },
      { startSec: 2 },
      { startSec: 1 },
    ]);
    expect(ids).toEqual(['sub-00001000', 'sub-00002000', 'sub-00001000-2']);
  });

  it('ミリ秒未満の差は同一時刻として扱う（丸めの一貫性）', () => {
    const ids = assignSubtitleIds([{ startSec: 20.9601 }, { startSec: 20.9604 }]);
    expect(ids).toEqual(['sub-00020960', 'sub-00020960-2']);
  });

  it('空の入力では空を返す', () => {
    expect(assignSubtitleIds([])).toEqual([]);
  });
});

describe('duplicateStartCount', () => {
  it('重複している件数を返す（1件目は数えない）', () => {
    expect(duplicateStartCount([{ startSec: 1 }, { startSec: 2 }])).toBe(0);
    expect(duplicateStartCount([{ startSec: 1 }, { startSec: 1 }])).toBe(1);
    expect(
      duplicateStartCount([{ startSec: 1 }, { startSec: 1 }, { startSec: 1 }]),
    ).toBe(2);
  });
});

describe('timeFromId', () => {
  it('通常のIDから時刻を取り出す', () => {
    expect(timeFromId('sub-00020960')).toBeCloseTo(20.96, 3);
    expect(timeFromId(subtitleId(3.5))).toBeCloseTo(3.5, 3);
  });

  it('★連番付きIDからも同じ時刻を取り出す', () => {
    expect(timeFromId('sub-00020960-2')).toBeCloseTo(20.96, 3);
    expect(timeFromId('sub-00020960-3')).toBeCloseTo(20.96, 3);
  });

  it('★2桁以上の連番にも対応する', () => {
    expect(timeFromId('sub-00020960-12')).toBeCloseTo(20.96, 3);
    expect(timeFromId('sub-00020960-100')).toBeCloseTo(20.96, 3);
  });

  it('★連番を時刻と誤読しない', () => {
    // 末尾の数字を拾う実装だと `2` を時刻にしかねない箇所。
    expect(timeFromId('sub-00020960-2')).not.toBeCloseTo(0.002, 3);
  });

  it('★他の種類のIDでも従来どおり動く', () => {
    expect(timeFromId(cameraShotId(12.5))).toBeCloseTo(12.5, 3);
    expect(timeFromId(chapterId(60))).toBeCloseTo(60, 3);
    expect(timeFromId(markerId('LAUGH', 200))).toBeCloseTo(200, 3);
    expect(timeFromId('mk-TOPIC-00034600')).toBeCloseTo(34.6, 3);
  });

  it('8桁を超える時刻キーも読める', () => {
    // 100000秒 = 100000000ms（9桁）
    expect(timeFromId('sub-100000000')).toBeCloseTo(100000, 3);
  });

  it('★形式外のIDは undefined（誤った時刻に変換しない）', () => {
    for (const id of [
      'short_01',
      'sub-',
      'sub-123',
      'sub-abcdefgh',
      'sub-00020960-',
      'sub-00020960-x',
      '00020960',
      '',
      'sub_00020960',
      '../../etc/passwd',
    ]) {
      expect(timeFromId(id)).toBeUndefined();
    }
  });
});

describe('occurrenceFromId', () => {
  it('連番が無ければ1', () => {
    expect(occurrenceFromId('sub-00020960')).toBe(1);
  });

  it('連番を取り出す', () => {
    expect(occurrenceFromId('sub-00020960-2')).toBe(2);
    expect(occurrenceFromId('sub-00020960-12')).toBe(12);
  });

  it('形式外は undefined', () => {
    expect(occurrenceFromId('short_01')).toBeUndefined();
  });

  it('assignSubtitleIds の結果と一致する', () => {
    const ids = assignSubtitleIds([
      { startSec: 5 },
      { startSec: 5 },
      { startSec: 5 },
    ]);
    expect(ids.map(occurrenceFromId)).toEqual([1, 2, 3]);
  });
});
