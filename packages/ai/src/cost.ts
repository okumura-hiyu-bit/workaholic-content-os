/**
 * APIのトークン推定・費用計算・上限管理・キャッシュ。
 *
 * ★実行前に必ず概算を出し、上限を超える呼び出しは実行させない。
 * 「気をつけて使う」ではなく、超えたら止まる構造にする。
 *
 * @see docs/13-gui-mvp.md
 */

import { createHash } from 'node:crypto';

import type { AiRequestInput, CostEstimate } from './provider.ts';

// ─── 単価表 ────────────────────────────────────────────

export interface ModelPricing {
  provider: string;
  model: string;
  /** 100万トークンあたりの入力単価（米ドル）。 */
  inputUsdPerMillion: number;
  /** 100万トークンあたりの出力単価（米ドル）。 */
  outputUsdPerMillion: number;
  /** 無料枠があるか（Geminiなど）。 */
  hasFreeTier: boolean;
}

/**
 * 単価は変わるため、コードに埋め込まず設定として持つ。
 * 既定値は目安であり、**請求額の根拠にはしない**（実費は各サービスの
 * ダッシュボードで確認する）。GUIには「概算」と明記して表示する。
 */
export const DEFAULT_PRICING: ModelPricing[] = [
  {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    inputUsdPerMillion: 0.3,
    outputUsdPerMillion: 2.5,
    hasFreeTier: true,
  },
  {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    inputUsdPerMillion: 0.4,
    outputUsdPerMillion: 1.6,
    hasFreeTier: false,
  },
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    inputUsdPerMillion: 1.0,
    outputUsdPerMillion: 5.0,
    hasFreeTier: false,
  },
];

/** 為替レート。設定で変更できるようにし、コードに固定しない。 */
export const DEFAULT_USD_JPY = 155;

export function findPricing(
  provider: string,
  model: string,
  table: readonly ModelPricing[] = DEFAULT_PRICING,
): ModelPricing | undefined {
  return table.find((p) => p.provider === provider && p.model === model);
}

// ─── トークン推定 ────────────────────────────────────────

/**
 * トークン数を推定する。
 *
 * 日本語は1文字あたり約1トークン、英数字は約4文字で1トークンという
 * おおまかな経験則を使う。正確な値はプロバイダーのトークナイザに依存するため、
 * **推定値であることを前提に安全側（多め）に見積もる**。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    if (/[　-鿿＀-￯]/.test(ch)) cjk += 1;
    else ascii += 1;
  }
  // 安全側に1.1倍する。見積りより実費が多くなる事故を避けるため。
  return Math.ceil((cjk + ascii / 4) * 1.1);
}

/** リクエスト内容から入力トークン数を推定する。 */
export function estimateInputTokens(request: AiRequestInput): number {
  if (request.kind === 'rankShortCandidates') {
    const { input } = request;
    const parts = [
      input.theme ?? '',
      ...input.speakers.map((s) => `${s.name}${s.title ?? ''}`),
      ...input.candidates.map(
        (c) => `${c.id}${c.transcript}${c.signals.join('')}`,
      ),
    ];
    // 指示文のぶんを固定で加算する。
    return estimateTokens(parts.join('\n')) + 600;
  }

  const { input } = request;
  const parts = [
    input.theme ?? '',
    ...input.speakers.map((s) => `${s.name}${s.title ?? ''}`),
    ...input.summaryPoints,
    ...input.chapters.map((c) => c.title),
    ...input.keyQuotes,
  ];
  return estimateTokens(parts.join('\n')) + 800;
}

/** 生成される出力トークン数を推定する。 */
export function estimateOutputTokens(request: AiRequestInput): number {
  if (request.kind === 'rankShortCandidates') {
    // 1候補あたり、順位・理由・フック・タイトル等で約150トークン。
    return request.input.candidates.length * 150 + 100;
  }

  const { want } = request.input;
  let tokens = 0;
  if (want.titleOptions) tokens += 300;
  if (want.youtubeDescription) tokens += 900;
  if (want.summary) tokens += 400;
  if (want.chapterTitles) tokens += request.input.chapters.length * 30;
  if (want.captions) tokens += want.captions.length * 250;
  return tokens + 100;
}

/** 費用（円）を計算する。 */
export function calculateJpy(
  pricing: ModelPricing,
  inputTokens: number,
  outputTokens: number,
  usdJpy: number = DEFAULT_USD_JPY,
): number {
  const usd =
    (inputTokens / 1_000_000) * pricing.inputUsdPerMillion +
    (outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
  return Number((usd * usdJpy).toFixed(4));
}

// ─── 上限管理 ──────────────────────────────────────────

export interface BudgetSettings {
  /** 1プロジェクトの上限（円）。0は無制限。 */
  perProjectJpy: number;
  /** 月間の上限（円）。0は無制限。 */
  perMonthJpy: number;
  /** 1回の呼び出しの上限（円）。暴発を防ぐ。 */
  perRequestJpy: number;
}

export const DEFAULT_BUDGET: BudgetSettings = {
  // MVPは固定費0円が方針。控えめな既定値にし、必要なら引き上げる。
  perProjectJpy: 100,
  perMonthJpy: 500,
  perRequestJpy: 50,
};

export interface BudgetState {
  /** このプロジェクトの累計（円）。 */
  projectSpentJpy: number;
  /** 当月の累計（円）。 */
  monthSpentJpy: number;
}

export type BudgetDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * 上限に照らして実行可否を判定する。
 *
 * ★上限に達したら自動で停止する。警告を出して続行はしない。
 */
export function checkBudget(
  estimateJpy: number,
  state: BudgetState,
  settings: BudgetSettings = DEFAULT_BUDGET,
): BudgetDecision {
  if (settings.perRequestJpy > 0 && estimateJpy > settings.perRequestJpy) {
    return {
      allowed: false,
      reason:
        `1回の呼び出しの上限（${settings.perRequestJpy}円）を超えます` +
        `（概算 ${estimateJpy.toFixed(2)}円）。候補数を減らすか上限を見直してください。`,
    };
  }

  if (
    settings.perProjectJpy > 0 &&
    state.projectSpentJpy + estimateJpy > settings.perProjectJpy
  ) {
    return {
      allowed: false,
      reason:
        `プロジェクトの上限（${settings.perProjectJpy}円）に達します` +
        `（使用済み ${state.projectSpentJpy.toFixed(2)}円 + 概算 ${estimateJpy.toFixed(2)}円）。`,
    };
  }

  if (
    settings.perMonthJpy > 0 &&
    state.monthSpentJpy + estimateJpy > settings.perMonthJpy
  ) {
    return {
      allowed: false,
      reason:
        `月間の上限（${settings.perMonthJpy}円）に達します` +
        `（当月 ${state.monthSpentJpy.toFixed(2)}円 + 概算 ${estimateJpy.toFixed(2)}円）。`,
    };
  }

  return { allowed: true };
}

/** 使用履歴から当月の累計を出す。 */
export function monthlySpentJpy(
  entries: readonly { at: string; costJpy: number; cached: boolean }[],
  now: Date = new Date(),
): number {
  const prefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const total = entries
    .filter((e) => !e.cached && e.at.startsWith(prefix))
    .reduce((sum, e) => sum + e.costJpy, 0);
  return Number(total.toFixed(4));
}

// ─── キャッシュ ────────────────────────────────────────

/**
 * リクエストのキャッシュキー。
 *
 * 同じ入力・同じモデルなら同じキーになる。プロバイダーとモデルを含めるのは、
 * モデルを変えたら結果も変わるため。
 */
export function cacheKey(
  provider: string,
  model: string,
  request: AiRequestInput,
): string {
  // JSONのキー順序に依存しないよう、キーをソートして直列化する。
  const canonical = JSON.stringify(request, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      );
    }
    return value;
  });

  const hash = createHash('sha256')
    .update(`${provider}\n${model}\n${canonical}`)
    .digest('hex')
    .slice(0, 32);

  return `${provider}-${model}-${request.kind}-${hash}`;
}

/** 見積りをまとめて作る。GUIの確認ダイアログがそのまま使える形。 */
export function buildEstimate(input: {
  provider: string;
  model: string;
  request: AiRequestInput;
  budgetState: BudgetState;
  budget?: BudgetSettings;
  pricing?: readonly ModelPricing[];
  usdJpy?: number;
  cacheHit?: boolean;
}): CostEstimate {
  const pricing = findPricing(input.provider, input.model, input.pricing);
  const inputTokens = estimateInputTokens(input.request);
  const outputTokens = estimateOutputTokens(input.request);

  if (input.cacheHit) {
    return {
      provider: input.provider,
      model: input.model,
      inputTokens: 0,
      outputTokens: 0,
      estimatedJpy: 0,
      willUseCache: true,
    };
  }

  if (!pricing) {
    return {
      provider: input.provider,
      model: input.model,
      inputTokens,
      outputTokens,
      estimatedJpy: 0,
      willUseCache: false,
      blockedReason:
        `${input.provider} / ${input.model} の単価が未登録です。` +
        '費用が読めない状態で実行しないため停止しました。単価を設定してください。',
    };
  }

  const estimatedJpy = calculateJpy(
    pricing,
    inputTokens,
    outputTokens,
    input.usdJpy,
  );
  const decision = checkBudget(estimatedJpy, input.budgetState, input.budget);

  return {
    provider: input.provider,
    model: input.model,
    inputTokens,
    outputTokens,
    estimatedJpy,
    willUseCache: false,
    blockedReason: decision.allowed ? undefined : decision.reason,
  };
}
