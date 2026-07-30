/**
 * ローカルモード用のプロバイダー。APIを一切呼ばない。
 *
 * ★これがあることで、APIキーが無くても・上限に達しても・オフラインでも
 * パイプライン全体が止まらない。ローカル一次抽出のスコアをそのまま順位とし、
 * 文章生成は行わず空で返す（人間が書く前提）。
 *
 * 「AIが無いと何もできない」状態を作らないための土台。
 */

import type {
  AiProvider,
  AiRequestInput,
  CostEstimate,
  MetadataInput,
  MetadataResult,
  ShortCandidateInput,
  ShortCandidateResult,
} from './provider.ts';

export class LocalProvider implements AiProvider {
  readonly name = 'local';
  readonly model = 'rule-based';
  readonly requiresApiKey = false;

  /**
   * ローカル一次抽出のスコア順に並べるだけ。
   * 採用理由はローカル判定の根拠（signals）をそのまま使う。
   */
  async rankShortCandidates(
    input: ShortCandidateInput,
  ): Promise<ShortCandidateResult[]> {
    return [...input.candidates]
      .sort((a, b) => b.localScore - a.localScore || a.startSec - b.startSec)
      .map((candidate, index) => ({
        shortId: candidate.id,
        rank: index + 1,
        rationale: candidate.signals.join(' / ') || 'ローカル判定のみ',
        // ★推測で埋めない。AIアシストモードで生成するか、人が書く。
        hook: undefined,
        suggestedTitle: undefined,
        lengthFit: this.lengthFit(candidate.endSec - candidate.startSec),
        // 文脈不足・炎上リスクは文章理解が必要なため判定しない。
        contextInsufficient: undefined,
        riskLevel: undefined,
      }));
  }

  /**
   * 尺だけから機械的に適性を出す。
   * 内容の判断はしないため、参考値として扱う。
   */
  private lengthFit(lengthSec: number): {
    sec15: number;
    sec30: number;
    sec60: number;
  } {
    const fit = (target: number) =>
      Number(Math.max(0, 1 - Math.abs(lengthSec - target) / target).toFixed(2));
    return { sec15: fit(15), sec30: fit(30), sec60: fit(60) };
  }

  /**
   * 文章は生成しない。★空で返し、人が書く前提であることを明示する。
   * それらしい文章を機械的に作ると、確認の手間が増えるだけで価値がない。
   */
  async generateMetadata(input: MetadataInput): Promise<MetadataResult> {
    const result: MetadataResult = {};
    if (input.want.summary) {
      // ローカルで作った要点をそのまま並べる（生成はしない）。
      result.summary = input.summaryPoints.join('\n');
    }
    if (input.want.chapterTitles) {
      // 改善はしない。既存のタイトルをそのまま返す。
      result.chapterTitles = Object.fromEntries(
        input.chapters.map((c) => [c.id, c.title]),
      );
    }
    return result;
  }

  async estimateCost(_input: AiRequestInput): Promise<CostEstimate> {
    return {
      provider: this.name,
      model: this.model,
      inputTokens: 0,
      outputTokens: 0,
      estimatedJpy: 0,
      willUseCache: false,
    };
  }
}

/**
 * APIキーの取得元。
 *
 * ★コードにもプロジェクトJSONにも保存しない。
 * 環境変数を第一とし、将来OSのキーチェーンに対応する（Electron導入時に
 * safeStorage / keytar を使う）。
 */
export function readApiKeyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    env.CONTENTOS_AI_API_KEY ||
    env.GEMINI_API_KEY ||
    env.OPENAI_API_KEY ||
    env.ANTHROPIC_API_KEY ||
    undefined
  );
}

/** APIキーが無い場合にローカルモードへ落とす判断。 */
export function resolveMode(
  requested: 'local' | 'assist',
  apiKey: string | undefined,
): { mode: 'local' | 'assist'; note?: string } {
  if (requested === 'local') return { mode: 'local' };
  if (!apiKey) {
    return {
      mode: 'local',
      note:
        'APIキーが設定されていないため、ローカルモードで実行します。' +
        '環境変数 CONTENTOS_AI_API_KEY を設定するとAIアシストモードが使えます。',
    };
  }
  return { mode: 'assist' };
}
