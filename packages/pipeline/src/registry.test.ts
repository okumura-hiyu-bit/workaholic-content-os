import { describe, expect, it } from 'vitest';

import { PIPELINE_STEP_IDS } from './types.ts';
import {
  assertDependenciesSatisfied,
  assertValidGraph,
  collectDependencies,
  collectDependents,
  computeExecutionPlan,
  STEP_DEPENDENCIES,
  topologicalOrder,
} from './registry.ts';

describe('STEP_DEPENDENCIES — グラフの健全性', () => {
  it('循環していない・未知IDが無い', () => {
    expect(() => assertValidGraph()).not.toThrow();
  });

  it('全15工程が定義されている', () => {
    expect(Object.keys(STEP_DEPENDENCIES)).toHaveLength(15);
    for (const id of PIPELINE_STEP_IDS) {
      expect(STEP_DEPENDENCIES[id]).toBeDefined();
    }
  });

  it('validate-project は依存を持たない（起点）', () => {
    expect(STEP_DEPENDENCIES['validate-project']).toEqual([]);
  });

  it('ご指定の依存関係を満たす：字幕は文字起こしに依存', () => {
    expect(STEP_DEPENDENCIES['generate-subtitles']).toContain('transcribe');
  });

  it('ご指定の依存関係を満たす：カメラ切替案は同期と話者判定に依存', () => {
    expect(STEP_DEPENDENCIES['generate-camera-plan']).toEqual(
      expect.arrayContaining(['sync-media', 'detect-speakers']),
    );
  });

  it('ご指定の依存関係を満たす：XMLは同期・字幕・マーカー・カメラ切替案に依存', () => {
    const deps = STEP_DEPENDENCIES['generate-premiere-xml'];
    expect(deps).toEqual(
      expect.arrayContaining([
        'sync-media',
        'generate-subtitles',
        'generate-markers',
        'generate-camera-plan',
      ]),
    );
  });

  it('save-project は最終工程（何にも依存されない）', () => {
    for (const id of PIPELINE_STEP_IDS) {
      if (id === 'save-project') continue;
      expect(STEP_DEPENDENCIES[id]).not.toContain('save-project');
    }
  });
});

describe('topologicalOrder', () => {
  const order = topologicalOrder();

  it('全15工程を含む', () => {
    expect(order).toHaveLength(15);
    expect(new Set(order)).toEqual(new Set(PIPELINE_STEP_IDS));
  });

  it('依存が必ず先に来る', () => {
    const index = new Map(order.map((id, i) => [id, i]));
    for (const id of order) {
      for (const dep of STEP_DEPENDENCIES[id]) {
        expect(index.get(dep)!).toBeLessThan(index.get(id)!);
      }
    }
  });

  it('validate-project が先頭、save-project が末尾', () => {
    expect(order[0]).toBe('validate-project');
    expect(order.at(-1)).toBe('save-project');
  });
});

describe('collectDependencies / collectDependents', () => {
  it('generate-premiere-xml の依存に validate-project まで遡って含まれる', () => {
    const deps = collectDependencies('generate-premiere-xml');
    expect(deps.has('validate-project')).toBe(true);
    expect(deps.has('generate-premiere-xml')).toBe(true);
  });

  it('validate-project の下流に save-project まで含まれる', () => {
    const dependents = collectDependents('validate-project');
    expect(dependents.has('save-project')).toBe(true);
    expect(dependents.has('validate-project')).toBe(false);
  });

  it('独立した分岐は互いの下流に含まれない', () => {
    // generate-camera-plan は transcribe の下流ではない
    const dependents = collectDependents('generate-camera-plan');
    expect(dependents.has('generate-subtitles')).toBe(false);
  });
});

describe('computeExecutionPlan', () => {
  it('指定なしなら全工程をトポロジカル順で返す', () => {
    expect(computeExecutionPlan({})).toEqual(topologicalOrder());
  });

  it('fromStep/toStep で範囲を絞る', () => {
    const plan = computeExecutionPlan({ fromStep: 'transcribe', toStep: 'generate-premiere-xml' });
    expect(plan[0]).toBe('transcribe');
    expect(plan.at(-1)).toBe('generate-premiere-xml');
    expect(plan).not.toContain('validate-project');
    expect(plan).not.toContain('save-project');
  });

  it('onlySteps は指定した工程だけを返す（依存を自動追加しない）', () => {
    const plan = computeExecutionPlan({
      onlySteps: ['generate-subtitles', 'generate-premiere-xml'],
    });
    expect(plan).toEqual(['generate-subtitles', 'generate-premiere-xml']);
  });

  it('onlySteps はトポロジカル順に並べ替える', () => {
    const plan = computeExecutionPlan({
      onlySteps: ['generate-premiere-xml', 'generate-subtitles'],
    });
    expect(plan).toEqual(['generate-subtitles', 'generate-premiere-xml']);
  });

  it('未知の fromStep はエラーにする', () => {
    // @ts-expect-error 意図的に不正な値
    expect(() => computeExecutionPlan({ fromStep: 'not-a-step' })).toThrow();
  });

  it('fromStep が toStep より後ろならエラーにする', () => {
    expect(() =>
      computeExecutionPlan({ fromStep: 'save-project', toStep: 'validate-project' }),
    ).toThrow(/後ろ/);
  });
});

describe('assertDependenciesSatisfied', () => {
  it('計画外の依存が完了済みなら通す', () => {
    expect(() =>
      assertDependenciesSatisfied(['transcribe'], () => true),
    ).not.toThrow();
  });

  it('★計画外の依存が未完了ならエラーにする', () => {
    expect(() =>
      assertDependenciesSatisfied(['transcribe'], () => false),
    ).toThrow();
  });

  it('依存が計画内にあれば、完了状態を問わず通す', () => {
    expect(() =>
      assertDependenciesSatisfied(['validate-project', 'probe-media'], () => false),
    ).not.toThrow();
  });
});
