import { describe, expect, it } from 'vitest';

import {
  formatElapsed,
  formatTimecode,
  percent,
  shortenPath,
  splitByLowConfidence,
} from './format.ts';

describe('formatElapsed', () => {
  it('分:秒 で表示する', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(9_000)).toBe('00:09');
    expect(formatElapsed(65_000)).toBe('01:05');
    expect(formatElapsed(3_600_000)).toBe('60:00');
  });

  it('負の値でも壊れない', () => {
    expect(formatElapsed(-100)).toBe('00:00');
  });
});

describe('percent', () => {
  it('0〜1を%に変換する', () => {
    expect(percent(0)).toBe('0%');
    expect(percent(0.4)).toBe('40%');
    expect(percent(1)).toBe('100%');
  });

  it('範囲外を丸める', () => {
    expect(percent(-1)).toBe('0%');
    expect(percent(5)).toBe('100%');
  });
});

describe('formatTimecode', () => {
  it('時:分:秒.ミリ秒 で表示する', () => {
    expect(formatTimecode(0)).toBe('00:00:00.000');
    expect(formatTimecode(2.5)).toBe('00:00:02.500');
    expect(formatTimecode(65.125)).toBe('00:01:05.125');
    expect(formatTimecode(3725.9)).toBe('01:02:05.900');
  });

  it('負の値でも壊れない', () => {
    expect(formatTimecode(-3)).toBe('00:00:00.000');
  });
});

describe('splitByLowConfidence', () => {
  it('★低confidence語だけを切り出す', () => {
    const parts = splitByLowConfidence('今日のテーマは', [{ text: 'テーマ' }]);
    expect(parts).toEqual([
      { text: '今日の', low: false },
      { text: 'テーマ', low: true },
      { text: 'は', low: false },
    ]);
  });

  it('★元の文字列を変えない（連結すると元に戻る）', () => {
    const text = '黒いスクレーダーを使用して話者Bと話';
    const parts = splitByLowConfidence(text, [{ text: 'スクレーダー' }, { text: '話者B' }]);
    expect(parts.map((p) => p.text).join('')).toBe(text);
  });

  it('複数の語を切り出す', () => {
    const parts = splitByLowConfidence('AとBとC', [{ text: 'A' }, { text: 'C' }]);
    expect(parts.filter((p) => p.low).map((p) => p.text)).toEqual(['A', 'C']);
  });

  it('語が無ければそのまま返す', () => {
    expect(splitByLowConfidence('こんばんは', [])).toEqual([
      { text: 'こんばんは', low: false },
    ]);
  });

  it('一致しない語は無視する', () => {
    const parts = splitByLowConfidence('こんばんは', [{ text: 'さようなら' }]);
    expect(parts).toEqual([{ text: 'こんばんは', low: false }]);
  });

  it('空文字の語で無限ループしない', () => {
    const parts = splitByLowConfidence('abc', [{ text: '' }]);
    expect(parts.map((p) => p.text).join('')).toBe('abc');
  });
});

describe('shortenPath', () => {
  it('★プロジェクト配下なら相対表記にする', () => {
    expect(shortenPath('/tmp/ep012/exports/ep012.fcp7.xml', '/tmp/ep012')).toBe(
      'exports/ep012.fcp7.xml',
    );
  });

  it('末尾スラッシュ付きでも動く', () => {
    expect(shortenPath('/tmp/ep012/cache/audio/wide.wav', '/tmp/ep012/')).toBe(
      'cache/audio/wide.wav',
    );
  });

  it('プロジェクト外のパスはそのまま出す（隠さない）', () => {
    expect(shortenPath('/other/place/file.wav', '/tmp/ep012')).toBe(
      '/other/place/file.wav',
    );
  });

  it('プロジェクトパスが空ならそのまま返す', () => {
    expect(shortenPath('/tmp/a.wav', '')).toBe('/tmp/a.wav');
  });
});
