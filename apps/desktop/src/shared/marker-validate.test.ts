/**
 * マーカーの修正・削除リクエストの検証。
 *
 * ★このテストの主眼は「実在する2系統のID形式を両方通す」こと。
 * `generate-markers.ts` は TOPIC/LAUGH を `mk-<KIND>-<時刻>`、CHECK を
 * `mk-CHECK-<check.id>` で採番する。片方しか通さないと、実データの
 * 過半数（実測で5件中3件がCHECK）が編集できなくなる。
 */

import { describe, expect, it } from 'vitest';

import {
  MAX_MARKER_COMMENT_LENGTH,
  MAX_MARKER_NAME_LENGTH,
  validateDeleteMarkerRequest,
  validateMarkerId,
  validateMarkerPatch,
  validateRemoveMarkerEditRequest,
  validateUpdateMarkerRequest,
} from './marker-validate.ts';

const PATH = '/Users/someone/projects/ep012';
const UPDATED_AT = '2026-08-05T10:00:00.000Z';

function ok<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok: ${JSON.stringify(result.error)}`);
  return result.value;
}

function errorMessage(result: { ok: boolean; error?: { userMessage: string } }): string {
  if (result.ok) throw new Error('expected failure');
  return result.error!.userMessage;
}

describe('★validateMarkerId — 実在する2系統を両方通す', () => {
  it('時刻キー形式（TOPIC / LAUGH）を通す', () => {
    expect(ok(validateMarkerId('mk-TOPIC-00000000'))).toBe('mk-TOPIC-00000000');
    expect(ok(validateMarkerId('mk-LAUGH-00033990'))).toBe('mk-LAUGH-00033990');
  });

  it('★CHECK の任意ID形式を通す（実データから採取した実物）', () => {
    // これらは実プロジェクトの project.json から採取した実IDそのもの。
    expect(ok(validateMarkerId('mk-CHECK-check-lowconf-7700'))).toBe(
      'mk-CHECK-check-lowconf-7700',
    );
    expect(ok(validateMarkerId('mk-CHECK-check-lowconf-33040'))).toBe(
      'mk-CHECK-check-lowconf-33040',
    );
    expect(ok(validateMarkerId('mk-CHECK-check-sync-camA'))).toBe(
      'mk-CHECK-check-sync-camA',
    );
  });

  it('未生成の種別も通す（将来の工程追加で壊れないように）', () => {
    for (const id of [
      'mk-KEY-00012000',
      'mk-SHORT-00012000',
      'mk-RETAKE-00005000',
      'mk-SPONSOR-00001000',
      'mk-OP-00000000',
      'mk-ED-00099000',
    ]) {
      expect(validateMarkerId(id).ok).toBe(true);
    }
  });

  it('★パス断片・コマンドとして解釈されうる文字を拒否する', () => {
    for (const bad of [
      'mk-CHECK-../../etc/passwd',
      'mk-CHECK-a/b',
      'mk-CHECK-a\\b',
      'mk-CHECK-a.b',
      'mk-CHECK-a b',
      'mk-CHECK-a;rm -rf /',
      'mk-CHECK-a|b',
    ]) {
      expect(validateMarkerId(bad).ok).toBe(false);
    }
  });

  it('形式外を拒否する', () => {
    for (const bad of [
      'mk-',
      'mk-CHECK-',
      'mk-check-00000000', // 種別は大文字
      'marker-TOPIC-00000000',
      'sub-00020960', // 字幕IDを渡された場合
      'short_01', // ショートIDを渡された場合
      'shot-00024010', // カットIDを渡された場合
      '',
      42,
      null,
      undefined,
      {},
    ]) {
      expect(validateMarkerId(bad).ok).toBe(false);
    }
  });
});

describe('validateMarkerPatch — 名前', () => {
  it('通常の名前を通し、前後の空白を落とす', () => {
    expect(ok(validateMarkerPatch({ name: '  第2章：本題へ  ' })).name).toBe(
      '第2章：本題へ',
    );
  });

  it('★名前に改行を許さない（Premiereのマーカー名は1行）', () => {
    expect(errorMessage(validateMarkerPatch({ name: '前半\n後半' }))).toContain('改行');
  });

  it('★空の名前を拒否し、取り消しへ誘導する', () => {
    const message = errorMessage(validateMarkerPatch({ name: '   ' }));
    expect(message).toContain('マーカー名が空です');
    expect(validateMarkerPatch({ name: '' }).ok).toBe(false);
  });

  it('null は「解析値に戻す」として通す', () => {
    expect(ok(validateMarkerPatch({ name: null })).name).toBeNull();
  });

  it('長すぎる名前を拒否し、上限ちょうどは通す', () => {
    expect(
      validateMarkerPatch({ name: 'あ'.repeat(MAX_MARKER_NAME_LENGTH + 1) }).ok,
    ).toBe(false);
    const exact = 'あ'.repeat(MAX_MARKER_NAME_LENGTH);
    expect(ok(validateMarkerPatch({ name: exact })).name).toBe(exact);
  });

  it('★制御文字は黙って取り除かず拒否する', () => {
    expect(errorMessage(validateMarkerPatch({ name: 'a\u0000b' }))).toContain('制御文字');
    expect(validateMarkerPatch({ name: 'a\tb' }).ok).toBe(false);
  });
});

describe('validateMarkerPatch — コメント', () => {
  it('複数行のコメントを通す', () => {
    expect(ok(validateMarkerPatch({ comment: '1行目\n2行目' })).comment).toBe(
      '1行目\n2行目',
    );
  });

  it('★空のコメントは許す（名前と違い、意図的に消したい場合がある）', () => {
    expect(ok(validateMarkerPatch({ comment: '' })).comment).toBe('');
  });

  it('CRLF を LF に正規化する', () => {
    expect(ok(validateMarkerPatch({ comment: 'a\r\nb' })).comment).toBe('a\nb');
  });

  it('制御文字を拒否する', () => {
    expect(validateMarkerPatch({ comment: 'a\u001Bb' }).ok).toBe(false);
    expect(validateMarkerPatch({ comment: 'a\tb' }).ok).toBe(false);
  });

  it('長すぎるコメントを拒否する', () => {
    expect(
      validateMarkerPatch({ comment: 'あ'.repeat(MAX_MARKER_COMMENT_LENGTH + 1) }).ok,
    ).toBe(false);
  });

  it('null は「解析値に戻す」として通す', () => {
    expect(ok(validateMarkerPatch({ comment: null })).comment).toBeNull();
  });
});

describe('validateMarkerPatch — 未対応・空の指定', () => {
  it('★時刻の編集は妥当な値でも拒否する（黙って無視しない）', () => {
    const message = errorMessage(validateMarkerPatch({ name: 'X', startSec: 12 }));
    expect(message).toContain('時刻の編集は未対応');
    expect(validateMarkerPatch({ name: 'X', endSec: 30 }).ok).toBe(false);
  });

  it('★種類の変更を拒否する', () => {
    const message = errorMessage(validateMarkerPatch({ name: 'X', kind: 'LAUGH' }));
    expect(message).toContain('種類の変更は未対応');
  });

  it('時刻の値そのものが不正な場合も拒否する', () => {
    expect(validateMarkerPatch({ startSec: -1 }).ok).toBe(false);
    expect(validateMarkerPatch({ startSec: 'abc' }).ok).toBe(false);
  });

  it('中身が何も無ければ拒否する', () => {
    expect(errorMessage(validateMarkerPatch({}))).toContain('修正内容がありません');
    expect(validateMarkerPatch(null).ok).toBe(false);
    expect(validateMarkerPatch('name').ok).toBe(false);
  });

  it('未知のキーだけなら「内容がない」として拒否する', () => {
    expect(validateMarkerPatch({ deleted: true }).ok).toBe(false);
  });
});

describe('validateUpdateMarkerRequest', () => {
  const base = {
    projectPath: PATH,
    markerId: 'mk-TOPIC-00000000',
    expectedUpdatedAt: UPDATED_AT,
    patch: { name: '第2章' },
  };

  it('正しいリクエストを通す', () => {
    const value = ok(validateUpdateMarkerRequest(base));
    expect(value.markerId).toBe('mk-TOPIC-00000000');
    expect(value.patch.name).toBe('第2章');
  });

  it('★CHECK マーカーへの修正も通す（編集は許可する方針）', () => {
    const value = ok(
      validateUpdateMarkerRequest({ ...base, markerId: 'mk-CHECK-check-lowconf-7700' }),
    );
    expect(value.markerId).toBe('mk-CHECK-check-lowconf-7700');
  });

  it('相対パスを拒否する', () => {
    expect(validateUpdateMarkerRequest({ ...base, projectPath: '../ep012' }).ok).toBe(
      false,
    );
  });

  it('不正なマーカーIDを拒否する', () => {
    expect(validateUpdateMarkerRequest({ ...base, markerId: 'mk-' }).ok).toBe(false);
  });

  it('★expectedUpdatedAt が無い・形式違いなら拒否する（競合検出を外させない）', () => {
    expect(validateUpdateMarkerRequest({ ...base, expectedUpdatedAt: '' }).ok).toBe(false);
    expect(
      validateUpdateMarkerRequest({ ...base, expectedUpdatedAt: '2026/08/05' }).ok,
    ).toBe(false);
  });

  it('オブジェクト以外を拒否する', () => {
    expect(validateUpdateMarkerRequest(null).ok).toBe(false);
    expect(validateUpdateMarkerRequest('mk-TOPIC-00000000').ok).toBe(false);
  });
});

describe('validateDeleteMarkerRequest / validateRemoveMarkerEditRequest', () => {
  const base = {
    projectPath: PATH,
    markerId: 'mk-LAUGH-00033990',
    expectedUpdatedAt: UPDATED_AT,
  };

  it('正しいリクエストを通す', () => {
    expect(ok(validateDeleteMarkerRequest(base)).markerId).toBe('mk-LAUGH-00033990');
    expect(ok(validateRemoveMarkerEditRequest(base)).markerId).toBe('mk-LAUGH-00033990');
  });

  it('CHECK マーカーのIDも通す', () => {
    const id = 'mk-CHECK-check-lowconf-7700';
    expect(ok(validateDeleteMarkerRequest({ ...base, markerId: id })).markerId).toBe(id);
    expect(ok(validateRemoveMarkerEditRequest({ ...base, markerId: id })).markerId).toBe(
      id,
    );
  });

  it('不正な値を拒否する', () => {
    for (const bad of [
      { ...base, projectPath: 'ep012' },
      { ...base, markerId: 'x' },
      { ...base, expectedUpdatedAt: 1 },
      null,
      undefined,
      'mk-LAUGH-00033990',
    ]) {
      expect(validateDeleteMarkerRequest(bad).ok).toBe(false);
      expect(validateRemoveMarkerEditRequest(bad).ok).toBe(false);
    }
  });
});
