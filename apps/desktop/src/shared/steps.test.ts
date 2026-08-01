/**
 * shared/steps.ts が本物の工程定義とズレていないことを確認する。
 *
 * ★この一覧はレンダラー（ブラウザ）でも使うため @contentos/pipeline を
 * 直接importできない（fs/child_processを引き込むため）。写しを持つ代わりに、
 * Nodeで動くこのテストで本物と突き合わせて固定する。
 * 工程が増減したらここが落ちるので、更新漏れに気づける。
 */

import { describe, expect, it } from 'vitest';

import { PIPELINE_STEP_IDS, PIPELINE_STEP_LABELS } from '@contentos/pipeline';

import { isStepId, STEP_IDS, STEP_LABELS } from './steps.ts';

describe('shared/steps', () => {
  it('工程IDが @contentos/pipeline と完全一致する（順序も含む）', () => {
    expect([...STEP_IDS]).toEqual([...PIPELINE_STEP_IDS]);
  });

  it('工程数が15である', () => {
    expect(STEP_IDS).toHaveLength(15);
  });

  it('工程ラベルが @contentos/pipeline と一致する', () => {
    expect(STEP_LABELS).toEqual(PIPELINE_STEP_LABELS);
  });

  it('isStepId が既知の工程だけを通す', () => {
    for (const id of PIPELINE_STEP_IDS) {
      expect(isStepId(id)).toBe(true);
    }
  });

  it('isStepId が未知の値を拒否する', () => {
    const rejected = [
      'unknown-step',
      'validate-projectX',
      '',
      null,
      undefined,
      42,
      {},
      ['transcribe'],
      // プロトタイプ汚染経由の擬似ヒットを拒否する
      'toString',
      'constructor',
    ];
    for (const value of rejected) {
      expect(isStepId(value)).toBe(false);
    }
  });
});
