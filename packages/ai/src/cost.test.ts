import { describe, expect, it } from 'vitest';

import {
  buildEstimate,
  cacheKey,
  calculateJpy,
  checkBudget,
  DEFAULT_BUDGET,
  DEFAULT_PRICING,
  estimateInputTokens,
  estimateOutputTokens,
  estimateTokens,
  findPricing,
  monthlySpentJpy,
} from './cost.ts';
import type { AiRequestInput, ShortCandidateInput } from './provider.ts';

const RANK_REQUEST: AiRequestInput = {
  kind: 'rankShortCandidates',
  input: {
    theme: '採用ブランディング',
    speakers: [{ id: 'A', name: '岸本', role: 'host' }],
    candidates: [
      {
        id: 'short_01',
        startSec: 30,
        endSec: 75,
        localScore: 82,
        signals: ['印象的な発言を含む'],
        transcript: '応募数よりも辞退率を見てください。'.repeat(10),
      },
      {
        id: 'short_02',
        startSec: 120,
        endSec: 160,
        localScore: 60,
        signals: ['笑いが起きている'],
        transcript: '綺麗すぎる採用動画は逆効果です。'.repeat(10),
      },
    ],
  } satisfies ShortCandidateInput,
};

describe('estimateTokens', () => {
  it('日本語は1文字あたり約1トークンとして数える', () => {
    // 10文字 × 1.1（安全側）
    expect(estimateTokens('あいうえおかきくけこ')).toBe(11);
  });

  it('英数字は約4文字で1トークンとして数える', () => {
    expect(estimateTokens('abcd')).toBe(2);
  });

  it('空文字は0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('★安全側（多め）に見積もる', () => {
    // 見積りより実費が多くなる事故を避けるため、1.1倍している。
    const plain = 'あ'.repeat(100);
    expect(estimateTokens(plain)).toBeGreaterThan(100);
  });
});

describe('estimateInputTokens / estimateOutputTokens', () => {
  it('候補の文字起こし量に応じて入力が増える', () => {
    const small = estimateInputTokens(RANK_REQUEST);
    const large = estimateInputTokens({
      kind: 'rankShortCandidates',
      input: {
        ...RANK_REQUEST.input as ShortCandidateInput,
        candidates: [
          ...(RANK_REQUEST.input as ShortCandidateInput).candidates,
          {
            id: 'short_03',
            startSec: 200,
            endSec: 240,
            localScore: 50,
            signals: [],
            transcript: 'あ'.repeat(500),
          },
        ],
      },
    });
    expect(large).toBeGreaterThan(small);
  });

  it('候補数に比例して出力が増える', () => {
    expect(estimateOutputTokens(RANK_REQUEST)).toBe(2 * 150 + 100);
  });

  it('依頼する項目だけ出力を見積もる（トークン節約）', () => {
    const base: AiRequestInput = {
      kind: 'generateMetadata',
      input: {
        speakers: [],
        summaryPoints: ['要点1'],
        chapters: [{ id: 'ch-1', startSec: 0, title: 'オープニング' }],
        keyQuotes: [],
        want: {},
      },
    };
    const withTitles: AiRequestInput = {
      kind: 'generateMetadata',
      input: { ...base.input, want: { titleOptions: true } } as never,
    };
    expect(estimateOutputTokens(withTitles)).toBeGreaterThan(
      estimateOutputTokens(base),
    );
  });
});

describe('calculateJpy', () => {
  it('単価表から費用を計算する', () => {
    const pricing = findPricing('gemini', 'gemini-2.5-flash')!;
    // 100万入力 + 100万出力 = (0.3 + 2.5) USD × 155円
    expect(calculateJpy(pricing, 1_000_000, 1_000_000, 155)).toBeCloseTo(434, 0);
  });

  it('少量なら極小の金額になる', () => {
    const pricing = findPricing('gemini', 'gemini-2.5-flash')!;
    expect(calculateJpy(pricing, 3000, 500, 155)).toBeLessThan(1);
  });

  it('為替レートを変えられる', () => {
    const pricing = findPricing('gemini', 'gemini-2.5-flash')!;
    const a = calculateJpy(pricing, 1_000_000, 0, 150);
    const b = calculateJpy(pricing, 1_000_000, 0, 160);
    expect(b).toBeGreaterThan(a);
  });
});

describe('checkBudget — 上限到達で自動停止', () => {
  const state = { projectSpentJpy: 0, monthSpentJpy: 0 };

  it('上限内なら許可する', () => {
    expect(checkBudget(1, state).allowed).toBe(true);
  });

  it('★1回の呼び出しの上限を超えたら止める', () => {
    const result = checkBudget(60, state, DEFAULT_BUDGET);
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('1回の呼び出し') });
  });

  it('★プロジェクトの累計上限に達したら止める', () => {
    const result = checkBudget(
      10,
      { projectSpentJpy: 95, monthSpentJpy: 95 },
      DEFAULT_BUDGET,
    );
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('プロジェクトの上限') });
  });

  it('★月間の上限に達したら止める', () => {
    const result = checkBudget(
      10,
      { projectSpentJpy: 0, monthSpentJpy: 495 },
      DEFAULT_BUDGET,
    );
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('月間の上限') });
  });

  it('上限0は無制限として扱う', () => {
    const result = checkBudget(10_000, state, {
      perProjectJpy: 0,
      perMonthJpy: 0,
      perRequestJpy: 0,
    });
    expect(result.allowed).toBe(true);
  });
});

describe('monthlySpentJpy', () => {
  const entries = [
    { at: '2026-07-01T00:00:00.000Z', costJpy: 10, cached: false },
    { at: '2026-07-15T00:00:00.000Z', costJpy: 5, cached: false },
    { at: '2026-06-30T00:00:00.000Z', costJpy: 100, cached: false },
    { at: '2026-07-20T00:00:00.000Z', costJpy: 50, cached: true },
  ];

  it('当月分だけを合計する', () => {
    expect(monthlySpentJpy(entries, new Date('2026-07-30T00:00:00Z'))).toBe(15);
  });

  it('キャッシュから返した分は費用に含めない', () => {
    const total = monthlySpentJpy(entries, new Date('2026-07-30T00:00:00Z'));
    expect(total).not.toBe(65);
  });

  it('該当月が無ければ0', () => {
    expect(monthlySpentJpy(entries, new Date('2026-09-01T00:00:00Z'))).toBe(0);
  });
});

describe('cacheKey — 同じ入力への再実行を避ける', () => {
  it('同じ入力なら同じキーになる', () => {
    const a = cacheKey('gemini', 'gemini-2.5-flash', RANK_REQUEST);
    const b = cacheKey('gemini', 'gemini-2.5-flash', RANK_REQUEST);
    expect(a).toBe(b);
  });

  it('入力が変われば違うキーになる', () => {
    const modified: AiRequestInput = {
      kind: 'rankShortCandidates',
      input: {
        ...(RANK_REQUEST.input as ShortCandidateInput),
        theme: '別のテーマ',
      },
    };
    expect(cacheKey('gemini', 'gemini-2.5-flash', RANK_REQUEST)).not.toBe(
      cacheKey('gemini', 'gemini-2.5-flash', modified),
    );
  });

  it('★モデルが変われば違うキーになる（結果も変わるため）', () => {
    expect(cacheKey('gemini', 'gemini-2.5-flash', RANK_REQUEST)).not.toBe(
      cacheKey('gemini', 'gemini-2.5-pro', RANK_REQUEST),
    );
  });

  it('プロパティの順序が違っても同じキーになる', () => {
    const reordered: AiRequestInput = {
      kind: 'rankShortCandidates',
      input: {
        candidates: (RANK_REQUEST.input as ShortCandidateInput).candidates,
        speakers: (RANK_REQUEST.input as ShortCandidateInput).speakers,
        theme: (RANK_REQUEST.input as ShortCandidateInput).theme,
      },
    };
    expect(cacheKey('gemini', 'gemini-2.5-flash', RANK_REQUEST)).toBe(
      cacheKey('gemini', 'gemini-2.5-flash', reordered),
    );
  });

  it('キーにプロバイダー・モデル・種別が読める形で入る', () => {
    const key = cacheKey('gemini', 'gemini-2.5-flash', RANK_REQUEST);
    expect(key.startsWith('gemini-gemini-2.5-flash-rankShortCandidates-')).toBe(true);
  });
});

describe('buildEstimate — 実行前の推定', () => {
  const budgetState = { projectSpentJpy: 0, monthSpentJpy: 0 };

  it('トークン数と概算金額を返す', () => {
    const estimate = buildEstimate({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      request: RANK_REQUEST,
      budgetState,
    });
    expect(estimate.inputTokens).toBeGreaterThan(0);
    expect(estimate.outputTokens).toBeGreaterThan(0);
    expect(estimate.estimatedJpy).toBeGreaterThan(0);
    expect(estimate.blockedReason).toBeUndefined();
  });

  it('キャッシュに当たるなら費用0で返す', () => {
    const estimate = buildEstimate({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      request: RANK_REQUEST,
      budgetState,
      cacheHit: true,
    });
    expect(estimate).toMatchObject({
      estimatedJpy: 0,
      willUseCache: true,
      inputTokens: 0,
    });
  });

  it('★単価が未登録なら実行を止める（費用が読めない状態で走らせない）', () => {
    const estimate = buildEstimate({
      provider: 'unknown',
      model: 'mystery-model',
      request: RANK_REQUEST,
      budgetState,
    });
    expect(estimate.blockedReason).toContain('単価が未登録');
  });

  it('上限を超える場合は理由を添えて止める', () => {
    const estimate = buildEstimate({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      request: RANK_REQUEST,
      budgetState: { projectSpentJpy: 100, monthSpentJpy: 100 },
    });
    expect(estimate.blockedReason).toBeDefined();
  });

  it('単価表にプロバイダーが3種類以上ある（差し替え前提）', () => {
    expect(new Set(DEFAULT_PRICING.map((p) => p.provider)).size).toBeGreaterThanOrEqual(3);
  });
});
