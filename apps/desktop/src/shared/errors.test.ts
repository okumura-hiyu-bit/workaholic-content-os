/**
 * PipelineError → 安全なDTO への変換。
 * ★technicalMessage が落ちることを固定する。ここが漏れると
 * 画面に内部パスやstack traceが出る。
 */

import { describe, expect, it } from 'vitest';

import { toSafeError, unknownToSafeError, type PipelineErrorLike } from './errors.ts';

describe('toSafeError', () => {
  const source: PipelineErrorLike = {
    code: 'FFMPEG_NOT_FOUND',
    stepId: 'validate-project',
    userMessage: 'ffmpeg が見つかりません。',
    technicalMessage:
      'spawn /Users/someone/secret-path/ffmpeg ENOENT\n  at ChildProcess.handle',
    recoverable: true,
    suggestedAction: 'brew install ffmpeg を実行してから再試行してください。',
  };

  it('ユーザー向けの情報を保つ', () => {
    const safe = toSafeError(source);
    expect(safe.code).toBe('FFMPEG_NOT_FOUND');
    expect(safe.stepId).toBe('validate-project');
    expect(safe.userMessage).toBe('ffmpeg が見つかりません。');
    expect(safe.recoverable).toBe(true);
    expect(safe.suggestedAction).toBe(
      'brew install ffmpeg を実行してから再試行してください。',
    );
  });

  it('★technicalMessage を落とす', () => {
    const safe = toSafeError(source);
    expect('technicalMessage' in safe).toBe(false);
    expect(JSON.stringify(safe)).not.toContain('secret-path');
    expect(JSON.stringify(safe)).not.toContain('ChildProcess');
  });

  it('recoverable の既定は true', () => {
    const safe = toSafeError({ code: 'X', userMessage: 'm' });
    expect(safe.recoverable).toBe(true);
  });

  it('省略可能な項目は付けない（undefinedを詰めない）', () => {
    const safe = toSafeError({ code: 'X', userMessage: 'm' });
    expect(Object.keys(safe).sort()).toEqual(['code', 'recoverable', 'userMessage']);
  });

  it('構造化クローンで送れる（関数やErrorを含まない）', () => {
    const safe = toSafeError(source);
    expect(() => structuredClone(safe)).not.toThrow();
  });
});

describe('unknownToSafeError', () => {
  it('例外の中身を含めず、決まった文言だけを返す', () => {
    const safe = unknownToSafeError('解析中に問題が発生しました。');
    expect(safe.code).toBe('UNKNOWN');
    expect(safe.userMessage).toBe('解析中に問題が発生しました。');
    expect('technicalMessage' in safe).toBe(false);
  });
});
