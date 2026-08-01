/**
 * Rendererから届く値の検証。
 * ★「通ること」より「不正を弾くこと」を重点的に固定する。
 */

import { describe, expect, it } from 'vitest';

import { validateId, validateProjectPath, validateStartRequest } from './validate.ts';

describe('validateProjectPath', () => {
  it('絶対パスを受け入れる', () => {
    const result = validateProjectPath('/tmp/ep012');
    expect(result.ok).toBe(true);
  });

  it('相対パスを拒否する（Main側のcwdに依存させないため）', () => {
    const result = validateProjectPath('ep012/project.json');
    expect(result.ok).toBe(false);
  });

  it('空文字・空白のみを拒否する', () => {
    expect(validateProjectPath('').ok).toBe(false);
    expect(validateProjectPath('   ').ok).toBe(false);
  });

  it('NUL文字を含むパスを拒否する', () => {
    expect(validateProjectPath('/tmp/ep012\0/etc/passwd').ok).toBe(false);
  });

  it('文字列以外を拒否する', () => {
    for (const value of [null, undefined, 42, {}, ['/tmp']]) {
      expect(validateProjectPath(value).ok).toBe(false);
    }
  });

  it('パスを正規化する（.. を畳む）', () => {
    const result = validateProjectPath('/tmp/a/../ep012');
    expect(result.ok && result.value).toBe('/tmp/ep012');
  });
});

describe('validateId', () => {
  it('通常のrunIdを受け入れる', () => {
    expect(validateId('run-1a2b3c', '実行ID').ok).toBe(true);
  });

  it('パス断片やコマンドになりうる文字を拒否する', () => {
    const rejected = [
      '../../etc/passwd',
      'run id',
      'run;rm -rf /',
      'run/1',
      '$(whoami)',
      '',
      '-leading-hyphen',
    ];
    for (const value of rejected) {
      expect(validateId(value, '実行ID').ok).toBe(false);
    }
  });

  it('長すぎるIDを拒否する', () => {
    expect(validateId('a'.repeat(200), '実行ID').ok).toBe(false);
  });
});

describe('validateStartRequest', () => {
  const base = { projectPath: '/tmp/ep012' };

  it('最小のリクエストを受け入れる', () => {
    const result = validateStartRequest(base);
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.projectPath).toBe('/tmp/ep012');
  });

  it('既知の工程IDを受け入れる', () => {
    const result = validateStartRequest({
      ...base,
      fromStep: 'generate-camera-plan',
      toStep: 'generate-premiere-xml',
      onlySteps: ['transcribe', 'detect-speakers'],
      syncMode: 'common',
      force: true,
    });
    expect(result.ok).toBe(true);
  });

  it('★未知の fromStep を拒否する', () => {
    const result = validateStartRequest({ ...base, fromStep: 'delete-everything' });
    expect(result.ok).toBe(false);
  });

  it('★未知の toStep を拒否する', () => {
    expect(validateStartRequest({ ...base, toStep: 'nope' }).ok).toBe(false);
  });

  it('★onlySteps に未知の工程が1つでもあれば拒否する', () => {
    const result = validateStartRequest({
      ...base,
      onlySteps: ['transcribe', 'not-a-step'],
    });
    expect(result.ok).toBe(false);
  });

  it('onlySteps が配列でなければ拒否する', () => {
    expect(validateStartRequest({ ...base, onlySteps: 'transcribe' }).ok).toBe(false);
  });

  it('onlySteps の重複を取り除く', () => {
    const result = validateStartRequest({
      ...base,
      onlySteps: ['transcribe', 'transcribe'],
    });
    expect(result.ok && result.value.onlySteps).toEqual(['transcribe']);
  });

  it('未知の syncMode を拒否する', () => {
    expect(validateStartRequest({ ...base, syncMode: 'magic' }).ok).toBe(false);
  });

  it('force が真偽値でなければ拒否する', () => {
    expect(validateStartRequest({ ...base, force: 'yes' }).ok).toBe(false);
  });

  it('不正な projectPath を拒否する', () => {
    expect(validateStartRequest({ projectPath: 'relative/path' }).ok).toBe(false);
    expect(validateStartRequest({}).ok).toBe(false);
  });

  it('オブジェクト以外を拒否する', () => {
    for (const value of [null, undefined, 'start', 42, []]) {
      const result = validateStartRequest(value);
      if (Array.isArray(value)) {
        // 配列は projectPath を持たないので弾かれる
        expect(result.ok).toBe(false);
      } else {
        expect(result.ok).toBe(false);
      }
    }
  });

  it('未知のキーは結果に持ち込まない（許可した項目だけを組み立てる）', () => {
    const result = validateStartRequest({
      ...base,
      evil: 'rm -rf /',
      __proto__: { polluted: true },
    });
    expect(result.ok).toBe(true);
    expect(result.ok && Object.keys(result.value)).toEqual(['projectPath']);
  });
});
