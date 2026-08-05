/**
 * Review系で共通に使う検証部品。
 *
 * ★このテストは `review-validate.test.ts` から移設したもの（Step 7）。
 * 検証内容は移設前と同一で、置き場所だけを中立な共通ファイルへ移した。
 */

import { describe, expect, it } from 'vitest';

import {
  conflictError,
  validateExpectedUpdatedAt,
  validateTimeSec,
} from './validate-common.ts';

describe('validateExpectedUpdatedAt', () => {
  it('ISO 8601 を受け入れる', () => {
    expect(validateExpectedUpdatedAt('2026-08-01T00:00:00.000Z').ok).toBe(true);
    expect(validateExpectedUpdatedAt('2026-08-01T00:00:00Z').ok).toBe(true);
    expect(validateExpectedUpdatedAt('2026-08-01T09:00:00+09:00').ok).toBe(true);
  });

  it('★形式が違えば拒否する', () => {
    for (const value of ['2026-08-01', 'yesterday', '', null, 1754006400000, {}]) {
      expect(validateExpectedUpdatedAt(value).ok).toBe(false);
    }
  });
});

describe('validateTimeSec', () => {
  it('妥当な秒を受け入れる', () => {
    expect(validateTimeSec(0, '開始時刻').ok).toBe(true);
    expect(validateTimeSec(123.456, '開始時刻').ok).toBe(true);
  });

  it('★範囲外・非数値を拒否する', () => {
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, 24 * 3600 + 1, '5', null]) {
      expect(validateTimeSec(value, '開始時刻').ok).toBe(false);
    }
  });
});

describe('conflictError', () => {
  it('指定どおりの文言を返す', () => {
    const error = conflictError();
    expect(error.userMessage).toBe(
      'プロジェクトが別の処理で更新されました。再読み込みしてください',
    );
    expect(error.code).toBe('PROJECT_CHANGED');
    expect('technicalMessage' in error).toBe(false);
  });
});
