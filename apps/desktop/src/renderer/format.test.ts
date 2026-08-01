import { describe, expect, it } from 'vitest';

import { formatElapsed, percent, shortenPath } from './format.ts';

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
