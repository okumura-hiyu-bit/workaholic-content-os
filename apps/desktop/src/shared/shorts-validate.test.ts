/**
 * ショート候補の採否・編集リクエストの検証。
 *
 * ★このテストの主眼は「Rendererを信用しない」こと。
 * 不正な入力が保存経路へ届かないこと、未対応の項目を黙って無視しないことを固定する。
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_SHORT_CAPTION_LENGTH,
  MAX_SHORT_HASHTAGS,
  MAX_SHORT_HASHTAG_LENGTH,
  MAX_SHORT_NOTE_LENGTH,
  MAX_SHORT_TITLE_LENGTH,
  validateHashtags,
  validateRemoveShortRequest,
  validateShortId,
  validateShortPatch,
  validateUpdateShortRequest,
} from './shorts-validate.ts';

const PATH = '/Users/someone/projects/ep012';
const UPDATED_AT = '2026-08-04T10:00:00.000Z';

function ok<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok: ${JSON.stringify(result.error)}`);
  return result.value;
}

function errorMessage(result: { ok: boolean; error?: { userMessage: string } }): string {
  if (result.ok) throw new Error('expected failure');
  return result.error!.userMessage;
}

describe('validateShortId', () => {
  it('short_NN 形式を通す', () => {
    expect(ok(validateShortId('short_01'))).toBe('short_01');
    expect(ok(validateShortId('short_12'))).toBe('short_12');
  });

  it('候補が100件を超えた場合の3桁・4桁も通す', () => {
    // padStart(2) は切り詰めないため、100件目は short_100 になる。
    expect(ok(validateShortId('short_100'))).toBe('short_100');
    expect(ok(validateShortId('short_1000'))).toBe('short_1000');
  });

  it('形式外を拒否する', () => {
    for (const bad of [
      'short_1', // 1桁は採番されない
      'short_',
      'shorts_01',
      'sub-00020960', // 字幕IDを渡された場合
      'short_01; rm -rf /',
      '../../etc/passwd',
      '',
      42,
      null,
      undefined,
      {},
    ]) {
      expect(validateShortId(bad).ok).toBe(false);
    }
  });
});

describe('validateHashtags', () => {
  it('先頭の # を1つだけ取り除いて正規化する', () => {
    expect(ok(validateHashtags(['#切り抜き', 'ラジオ']))).toEqual(['切り抜き', 'ラジオ']);
  });

  it('前後の空白を落とす', () => {
    expect(ok(validateHashtags(['  切り抜き  ']))).toEqual(['切り抜き']);
  });

  it('空欄は無視する（行を消したのと同じ扱い）', () => {
    expect(ok(validateHashtags(['切り抜き', '', '   ', '#']))).toEqual(['切り抜き']);
  });

  it('重複は1件にまとめる', () => {
    expect(ok(validateHashtags(['切り抜き', '#切り抜き']))).toEqual(['切り抜き']);
  });

  it('★空白を含むタグを拒否する（黙って分割しない）', () => {
    expect(errorMessage(validateHashtags(['切り 抜き']))).toContain('空白');
  });

  it('★途中の # を拒否する（黙って分割しない）', () => {
    expect(errorMessage(validateHashtags(['切り抜き#ラジオ']))).toContain('#');
  });

  it('制御文字を拒否する', () => {
    expect(validateHashtags(['切り\u0000抜き']).ok).toBe(false);
    expect(validateHashtags(['切り\tabc']).ok).toBe(false);
  });

  it('本数の上限を超えたら拒否する', () => {
    const many = Array.from({ length: MAX_SHORT_HASHTAGS + 1 }, (_, i) => `tag${i}`);
    expect(errorMessage(validateHashtags(many))).toContain('多すぎます');
  });

  it('1件が長すぎたら拒否する', () => {
    const long = 'あ'.repeat(MAX_SHORT_HASHTAG_LENGTH + 1);
    expect(errorMessage(validateHashtags([long]))).toContain('長すぎます');
  });

  it('配列でなければ拒否する', () => {
    expect(validateHashtags('切り抜き').ok).toBe(false);
    expect(validateHashtags(null).ok).toBe(false);
    expect(validateHashtags([1, 2]).ok).toBe(false);
  });
});

describe('validateShortPatch — 採否', () => {
  it('true / false を通す', () => {
    expect(ok(validateShortPatch({ adopted: true })).adopted).toBe(true);
    expect(ok(validateShortPatch({ adopted: false })).adopted).toBe(false);
  });

  it('null は「未判断に戻す」として通す', () => {
    expect(ok(validateShortPatch({ adopted: null })).adopted).toBeNull();
  });

  it('boolean 以外を拒否する', () => {
    expect(validateShortPatch({ adopted: 'yes' }).ok).toBe(false);
    expect(validateShortPatch({ adopted: 1 }).ok).toBe(false);
  });
});

describe('validateShortPatch — テキスト項目', () => {
  it('タイトルの前後の空白を落とす', () => {
    expect(ok(validateShortPatch({ title: '  神回の入り  ' })).title).toBe('神回の入り');
  });

  it('★タイトルに改行を許さない（1行の約束を守る）', () => {
    expect(errorMessage(validateShortPatch({ title: '前半\n後半' }))).toContain('改行');
  });

  it('★冒頭フックにも改行を許さない', () => {
    expect(validateShortPatch({ hook: 'a\nb' }).ok).toBe(false);
  });

  it('投稿文とメモは改行を許す', () => {
    expect(ok(validateShortPatch({ caption: '1行目\n2行目' })).caption).toBe('1行目\n2行目');
    expect(ok(validateShortPatch({ note: '1行目\n2行目' })).note).toBe('1行目\n2行目');
  });

  it('CRLF を LF に正規化する', () => {
    expect(ok(validateShortPatch({ caption: 'a\r\nb' })).caption).toBe('a\nb');
  });

  it('★制御文字は黙って取り除かず拒否する', () => {
    expect(errorMessage(validateShortPatch({ caption: 'a\u0000b' }))).toContain('制御文字');
    expect(validateShortPatch({ caption: 'a\tb' }).ok).toBe(false);
    expect(validateShortPatch({ note: 'a\u001Bb' }).ok).toBe(false);
  });

  it('長さの上限を超えたら拒否する', () => {
    expect(
      validateShortPatch({ title: 'あ'.repeat(MAX_SHORT_TITLE_LENGTH + 1) }).ok,
    ).toBe(false);
    expect(
      validateShortPatch({ caption: 'あ'.repeat(MAX_SHORT_CAPTION_LENGTH + 1) }).ok,
    ).toBe(false);
    expect(
      validateShortPatch({ note: 'あ'.repeat(MAX_SHORT_NOTE_LENGTH + 1) }).ok,
    ).toBe(false);
  });

  it('上限ちょうどは通す', () => {
    const exact = 'あ'.repeat(MAX_SHORT_TITLE_LENGTH);
    expect(ok(validateShortPatch({ title: exact })).title).toBe(exact);
  });

  it('★空文字は null（＝項目を消す）に正規化する。空文字を保存に残さない', () => {
    expect(ok(validateShortPatch({ title: '' })).title).toBeNull();
    expect(ok(validateShortPatch({ title: '   ' })).title).toBeNull();
    expect(ok(validateShortPatch({ hashtags: [] })).hashtags).toBeNull();
  });

  it('null を渡した場合も「消す」として通す', () => {
    expect(ok(validateShortPatch({ note: null })).note).toBeNull();
    expect(ok(validateShortPatch({ hashtags: null })).hashtags).toBeNull();
  });
});

describe('validateShortPatch — 未対応・空の指定', () => {
  it('★区間の編集は妥当な値でも拒否する（黙って無視しない）', () => {
    const message = errorMessage(validateShortPatch({ adopted: true, startSec: 12 }));
    expect(message).toContain('区間の編集は未対応');
    expect(validateShortPatch({ adopted: true, endSec: 30 }).ok).toBe(false);
  });

  it('区間の値そのものが不正な場合も拒否する', () => {
    expect(validateShortPatch({ startSec: -1 }).ok).toBe(false);
    expect(validateShortPatch({ startSec: 'abc' }).ok).toBe(false);
  });

  it('中身が何も無ければ拒否する', () => {
    expect(errorMessage(validateShortPatch({}))).toContain('判断内容がありません');
    expect(validateShortPatch(null).ok).toBe(false);
    expect(validateShortPatch('adopted').ok).toBe(false);
  });

  it('未知のキーだけを渡された場合も「内容がない」として拒否する', () => {
    expect(validateShortPatch({ deleted: true }).ok).toBe(false);
  });
});

describe('validateUpdateShortRequest', () => {
  const base = {
    projectPath: PATH,
    shortId: 'short_01',
    expectedUpdatedAt: UPDATED_AT,
    patch: { adopted: true },
  };

  it('正しいリクエストを通す', () => {
    const value = ok(validateUpdateShortRequest(base));
    expect(value.shortId).toBe('short_01');
    expect(value.patch.adopted).toBe(true);
  });

  it('相対パスを拒否する', () => {
    expect(validateUpdateShortRequest({ ...base, projectPath: '../ep012' }).ok).toBe(false);
  });

  it('不正なショートIDを拒否する', () => {
    expect(validateUpdateShortRequest({ ...base, shortId: 'short_x' }).ok).toBe(false);
  });

  it('★expectedUpdatedAt が無い・形式違いなら拒否する（競合検出を外させない）', () => {
    expect(validateUpdateShortRequest({ ...base, expectedUpdatedAt: '' }).ok).toBe(false);
    expect(
      validateUpdateShortRequest({ ...base, expectedUpdatedAt: '2026/08/04' }).ok,
    ).toBe(false);
  });

  it('オブジェクトでなければ拒否する', () => {
    expect(validateUpdateShortRequest(null).ok).toBe(false);
    expect(validateUpdateShortRequest('short_01').ok).toBe(false);
  });
});

describe('validateRemoveShortRequest', () => {
  const base = {
    projectPath: PATH,
    shortId: 'short_02',
    expectedUpdatedAt: UPDATED_AT,
  };

  it('正しいリクエストを通す', () => {
    expect(ok(validateRemoveShortRequest(base)).shortId).toBe('short_02');
  });

  it('パス・ID・updatedAt のいずれかが不正なら拒否する', () => {
    expect(validateRemoveShortRequest({ ...base, projectPath: 'ep012' }).ok).toBe(false);
    expect(validateRemoveShortRequest({ ...base, shortId: 'x' }).ok).toBe(false);
    expect(validateRemoveShortRequest({ ...base, expectedUpdatedAt: 1 }).ok).toBe(false);
    expect(validateRemoveShortRequest(undefined).ok).toBe(false);
  });
});
