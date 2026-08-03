/**
 * 字幕修正リクエストの検証。
 * ★保存はディスクへの書き込みなので、不正を通さないことを重点的に固定する。
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_SUBTITLE_LENGTH,
  MAX_SUBTITLE_LINES,
  conflictError,
  validateExpectedUpdatedAt,
  validateRemoveSubtitleRequest,
  validateSpeakerId,
  validateSubtitleId,
  validateSubtitleText,
  validateTimeSec,
  validateUpdateSubtitleRequest,
} from './review-validate.ts';

const BASE = {
  projectPath: '/tmp/ep012',
  subtitleId: 'sub-00000000',
  expectedUpdatedAt: '2026-08-01T00:00:00.000Z',
};

describe('validateSubtitleId', () => {
  it('正しい形式を受け入れる', () => {
    expect(validateSubtitleId('sub-00000000').ok).toBe(true);
    expect(validateSubtitleId('sub-00020960').ok).toBe(true);
  });

  it('★不正な字幕IDを拒否する', () => {
    for (const value of [
      'shot-00000000',
      'sub-',
      'sub-abcdefgh',
      '../../etc/passwd',
      'sub-00000000; rm -rf /',
      '',
      null,
      undefined,
      42,
      {},
    ]) {
      expect(validateSubtitleId(value).ok).toBe(false);
    }
  });
});

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

describe('validateSubtitleText', () => {
  it('通常の本文を受け入れる', () => {
    expect(validateSubtitleText('こんばんは').ok).toBe(true);
  });

  it('改行を許可する', () => {
    const result = validateSubtitleText('1行目\n2行目');
    expect(result.ok && result.value).toBe('1行目\n2行目');
  });

  it('CRLF・CR を改行に正規化する', () => {
    expect(validateSubtitleText('a\r\nb').ok && validateSubtitleText('a\r\nb')).toMatchObject({
      value: 'a\nb',
    });
    expect(validateSubtitleText('a\rb')).toMatchObject({ value: 'a\nb' });
  });

  it('★制御文字を拒否する（黙って取り除かない）', () => {
    const withControl = [
      'あ\u0000い',
      'あ\u0009い',
      'あ\u001Bい',
      'あ\u007Fい',
      'あ\u000Bい',
    ];
    for (const value of withControl) {
      const result = validateSubtitleText(value);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.userMessage).toContain('制御文字');
    }
  });

  it('★長すぎる本文を拒否する', () => {
    const result = validateSubtitleText('あ'.repeat(MAX_SUBTITLE_LENGTH + 1));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.userMessage).toContain('長すぎます');
  });

  it('上限ちょうどは通す', () => {
    expect(validateSubtitleText('あ'.repeat(MAX_SUBTITLE_LENGTH)).ok).toBe(true);
  });

  it('★行数が多すぎる本文を拒否する', () => {
    const result = validateSubtitleText('a\n'.repeat(MAX_SUBTITLE_LINES).trim() + '\nb\nc');
    expect(result.ok).toBe(false);
  });

  it('★空の本文を拒否する（取り消しと区別する）', () => {
    expect(validateSubtitleText('').ok).toBe(false);
    expect(validateSubtitleText('   ').ok).toBe(false);
    expect(validateSubtitleText('\n\n').ok).toBe(false);
  });

  it('文字列以外を拒否する', () => {
    for (const value of [null, undefined, 42, {}, ['a']]) {
      expect(validateSubtitleText(value).ok).toBe(false);
    }
  });
});

describe('validateSpeakerId', () => {
  it('正しい形式を受け入れる', () => {
    expect(validateSpeakerId('spk_a').ok).toBe(true);
  });

  it('★プロジェクトに存在しない話者を拒否する', () => {
    const known = new Set(['spk_a', 'spk_b']);
    const result = validateSpeakerId('spk_zzz', known);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.userMessage).toContain('存在しない');
  });

  it('★不正な形式を拒否する', () => {
    for (const value of ['../etc', 'spk a', '', '_leading', null, 42]) {
      expect(validateSpeakerId(value).ok).toBe(false);
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

describe('validateUpdateSubtitleRequest', () => {
  const speakers = new Set(['spk_a', 'spk_b']);

  it('本文の修正を受け入れる', () => {
    const result = validateUpdateSubtitleRequest(
      { ...BASE, patch: { text: '直した' } },
      speakers,
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.patch).toEqual({ text: '直した' });
  });

  it('話者の修正を受け入れる', () => {
    const result = validateUpdateSubtitleRequest(
      { ...BASE, patch: { speakerId: 'spk_b' } },
      speakers,
    );
    expect(result.ok).toBe(true);
  });

  it('★タイムコードの編集を明示的に拒否する（黙って無視しない）', () => {
    for (const patch of [
      { text: 'a', startSec: 1 },
      { text: 'a', endSec: 2 },
      { startSec: 1, endSec: 2 },
    ]) {
      const result = validateUpdateSubtitleRequest({ ...BASE, patch }, speakers);
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.error.userMessage).toContain('未対応');
    }
  });

  it('★不正なタイムコードは範囲エラーで拒否する', () => {
    const result = validateUpdateSubtitleRequest(
      { ...BASE, patch: { startSec: -5 } },
      speakers,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.userMessage).toContain('負の値');
  });

  it('★不正な projectPath を拒否する', () => {
    expect(
      validateUpdateSubtitleRequest(
        { ...BASE, projectPath: 'relative', patch: { text: 'a' } },
        speakers,
      ).ok,
    ).toBe(false);
  });

  it('★不正な subtitleId を拒否する', () => {
    expect(
      validateUpdateSubtitleRequest(
        { ...BASE, subtitleId: 'nope', patch: { text: 'a' } },
        speakers,
      ).ok,
    ).toBe(false);
  });

  it('★不正な speakerId を拒否する', () => {
    expect(
      validateUpdateSubtitleRequest(
        { ...BASE, patch: { speakerId: 'spk_unknown' } },
        speakers,
      ).ok,
    ).toBe(false);
  });

  it('修正内容が空なら拒否する', () => {
    expect(validateUpdateSubtitleRequest({ ...BASE, patch: {} }, speakers).ok).toBe(false);
  });

  it('patch が無い・オブジェクトでない場合は拒否する', () => {
    expect(validateUpdateSubtitleRequest({ ...BASE }, speakers).ok).toBe(false);
    expect(validateUpdateSubtitleRequest({ ...BASE, patch: 'text' }, speakers).ok).toBe(false);
  });

  it('★許可した項目だけを組み立てる（未知のキーを持ち込まない）', () => {
    const result = validateUpdateSubtitleRequest(
      { ...BASE, patch: { text: 'a', deleted: true, evil: 'x' }, extra: 1 },
      speakers,
    );
    expect(result.ok).toBe(true);
    expect(result.ok && Object.keys(result.value).sort()).toEqual([
      'expectedUpdatedAt',
      'patch',
      'projectPath',
      'subtitleId',
    ]);
    expect(result.ok && Object.keys(result.value.patch)).toEqual(['text']);
  });

  it('オブジェクト以外を拒否する', () => {
    for (const value of [null, undefined, 'x', 42, []]) {
      expect(validateUpdateSubtitleRequest(value, speakers).ok).toBe(false);
    }
  });
});

describe('validateRemoveSubtitleRequest', () => {
  it('正しいリクエストを受け入れる', () => {
    expect(validateRemoveSubtitleRequest(BASE).ok).toBe(true);
  });

  it('★不正な値を拒否する', () => {
    expect(validateRemoveSubtitleRequest({ ...BASE, subtitleId: 'x' }).ok).toBe(false);
    expect(validateRemoveSubtitleRequest({ ...BASE, projectPath: 'rel' }).ok).toBe(false);
    expect(validateRemoveSubtitleRequest({ ...BASE, expectedUpdatedAt: '' }).ok).toBe(false);
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
