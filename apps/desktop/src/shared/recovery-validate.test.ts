/**
 * 復旧画面のリクエスト検証。
 *
 * ★主眼は「対象（domain）ごとにID形式が違う」ことを取り違えないこと。
 * 字幕IDの形をしたものをマーカーとして送る、といった要求を通すと、
 * 存在しないキーで edits を書き換えることになる。
 */

import { describe, expect, it } from 'vitest';

import {
  validateIdFor,
  validateRecoveryDiscardRequest,
  validateRecoveryDomain,
  validateRecoveryReattachRequest,
  validateRecoveryTargetsRequest,
} from './recovery-validate.ts';

const PATH = '/tmp/ep012';
const UPDATED_AT = '2026-08-01T00:00:00.000Z';

const SUB = 'sub-00002500';
const SHORT = 'short_02';
const SHOT = 'shot-00010000';
const MARKER = 'mk-TOPIC-00000000';
/** ★実データから採取した CHECK 系（時刻を含まない2系統目）。 */
const CHECK = 'mk-CHECK-check-lowconf-7700';

describe('validateRecoveryDomain', () => {
  it('4つの対象を受け付ける', () => {
    for (const d of ['subtitle', 'short', 'cameraShot', 'marker']) {
      expect(validateRecoveryDomain(d).ok).toBe(true);
    }
  });

  it('それ以外は拒否する', () => {
    // ★chapter は resolveProject が孤立を返すが、対応するReview画面が無いので受けない。
    for (const bad of ['chapter', '', 'Subtitle', 'markers', null, undefined, 7, {}]) {
      expect(validateRecoveryDomain(bad).ok).toBe(false);
    }
  });
});

describe('validateIdFor：対象ごとのID形式', () => {
  it('正しい組み合わせを通す', () => {
    expect(validateIdFor('subtitle', SUB).ok).toBe(true);
    expect(validateIdFor('short', SHORT).ok).toBe(true);
    expect(validateIdFor('cameraShot', SHOT).ok).toBe(true);
    expect(validateIdFor('marker', MARKER).ok).toBe(true);
    // ★マーカーIDは2系統ある。両方通ること。
    expect(validateIdFor('marker', CHECK).ok).toBe(true);
  });

  it('★対象とIDの取り違えを拒否する', () => {
    expect(validateIdFor('marker', SUB).ok).toBe(false);
    expect(validateIdFor('subtitle', MARKER).ok).toBe(false);
    expect(validateIdFor('cameraShot', SUB).ok).toBe(false);
    expect(validateIdFor('short', SHOT).ok).toBe(false);
    expect(validateIdFor('subtitle', SHORT).ok).toBe(false);
  });

  it('未指定・空文字・型違いを拒否する', () => {
    for (const bad of [undefined, null, '', 0, {}, []]) {
      expect(validateIdFor('subtitle', bad).ok).toBe(false);
    }
  });
});

describe('validateRecoveryTargetsRequest', () => {
  it('正しい要求を通す', () => {
    const result = validateRecoveryTargetsRequest({
      projectPath: PATH,
      domain: 'subtitle',
      sourceId: SUB,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.sourceId).toBe(SUB);
  });

  it('パス・対象・IDのどれが欠けても拒否する', () => {
    expect(validateRecoveryTargetsRequest(null).ok).toBe(false);
    expect(validateRecoveryTargetsRequest({ domain: 'subtitle', sourceId: SUB }).ok).toBe(
      false,
    );
    expect(validateRecoveryTargetsRequest({ projectPath: PATH, sourceId: SUB }).ok).toBe(
      false,
    );
    expect(
      validateRecoveryTargetsRequest({ projectPath: PATH, domain: 'subtitle' }).ok,
    ).toBe(false);
  });
});

describe('validateRecoveryReattachRequest', () => {
  it('正しい要求を通す', () => {
    const result = validateRecoveryReattachRequest({
      projectPath: PATH,
      domain: 'subtitle',
      sourceId: 'sub-00100000',
      targetId: SUB,
      expectedUpdatedAt: UPDATED_AT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.targetId).toBe(SUB);
      expect(result.value.expectedUpdatedAt).toBe(UPDATED_AT);
    }
  });

  it('★元と同じIDへの付け替えを拒否する', () => {
    const result = validateRecoveryReattachRequest({
      projectPath: PATH,
      domain: 'subtitle',
      sourceId: SUB,
      targetId: SUB,
      expectedUpdatedAt: UPDATED_AT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.userMessage).toContain('同じ');
  });

  it('★付け替え先のIDも対象の形式で検証する', () => {
    const result = validateRecoveryReattachRequest({
      projectPath: PATH,
      domain: 'subtitle',
      sourceId: 'sub-00100000',
      targetId: MARKER,
      expectedUpdatedAt: UPDATED_AT,
    });
    expect(result.ok).toBe(false);
  });

  it('updatedAt の形式違いを拒否する', () => {
    for (const bad of ['', '2026-08-01', 'yesterday', 17548000000, null]) {
      const result = validateRecoveryReattachRequest({
        projectPath: PATH,
        domain: 'subtitle',
        sourceId: 'sub-00100000',
        targetId: SUB,
        expectedUpdatedAt: bad,
      });
      expect(result.ok).toBe(false);
    }
  });
});

describe('validateRecoveryDiscardRequest', () => {
  it('正しい要求を通す', () => {
    const result = validateRecoveryDiscardRequest({
      projectPath: PATH,
      domain: 'marker',
      sourceId: CHECK,
      expectedUpdatedAt: UPDATED_AT,
    });
    expect(result.ok).toBe(true);
  });

  it('対象とIDの取り違えを拒否する', () => {
    const result = validateRecoveryDiscardRequest({
      projectPath: PATH,
      domain: 'short',
      sourceId: SUB,
      expectedUpdatedAt: UPDATED_AT,
    });
    expect(result.ok).toBe(false);
  });

  it('updatedAt が無ければ拒否する（競合検出の手掛かりを失わない）', () => {
    const result = validateRecoveryDiscardRequest({
      projectPath: PATH,
      domain: 'marker',
      sourceId: CHECK,
    });
    expect(result.ok).toBe(false);
  });
});
