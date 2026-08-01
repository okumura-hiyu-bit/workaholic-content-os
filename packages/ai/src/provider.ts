/**
 * AIプロバイダーの共通インターフェース。
 *
 * ★特定プロバイダーに依存しない。Gemini / OpenAI / Claude を差し替えられる。
 *
 * ★APIに送るのは「ローカルで抽出・圧縮した情報」だけ。
 * 文字起こし全文や映像素材そのものを送らない。ショート候補の評価では、
 * 候補区間の文字起こし抜粋（数百字）だけを送る。
 *
 * @see docs/13-gui-mvp.md
 */

import type { Speaker } from '@contentos/editing/types';

// ─── 動作モード ──────────────────────────────────────────

/**
 * - `local` … APIを一切呼ばない。ローカル処理の結果だけで完結する。
 * - `assist` … APIを使って順位付け・文章生成を行う。
 */
export type AiMode = 'local' | 'assist';

// ─── ショート候補の順位付け ─────────────────────────────────

/** APIに送る1候補ぶんの情報。★映像も全文も送らない。 */
export interface ShortCandidateForReview {
  id: string;
  startSec: number;
  endSec: number;
  /** ローカル一次抽出のスコア。 */
  localScore: number;
  /** 加点の根拠（ローカル判定）。 */
  signals: string[];
  /** ★この区間の文字起こしのみ。前後の文脈は含めない。 */
  transcript: string;
  primarySpeakerId?: string;
}

export interface ShortCandidateInput {
  /** 番組・回のテーマ（数十字）。 */
  theme?: string;
  speakers: readonly Speaker[];
  /** ★10〜20本の候補。全文ではなくこれだけを送る。 */
  candidates: readonly ShortCandidateForReview[];
  /** 何本の採用を想定しているか。順位付けの粒度に使う。 */
  desiredCount?: number;
}

export interface ShortCandidateResult {
  shortId: string;
  rank: number;
  rationale: string;
  targetAudience?: string;
  hook?: string;
  suggestedTitle?: string;
  /** 各尺への適性（0〜1）。 */
  lengthFit?: { sec15: number; sec30: number; sec60: number };
  /** 前後の文脈がないと理解できないか。 */
  contextInsufficient?: boolean;
  riskLevel?: 'low' | 'medium' | 'high';
  riskNote?: string;
}

// ─── メタデータ生成 ─────────────────────────────────────

export interface MetadataInput {
  theme?: string;
  speakers: readonly Speaker[];
  /** ★全文ではなく、ローカルで作った要約・章立て・重要発言だけを送る。 */
  summaryPoints: readonly string[];
  chapters: readonly { id: string; startSec: number; title: string }[];
  keyQuotes: readonly string[];
  /** 生成してほしいもの。必要なものだけ依頼してトークンを節約する。 */
  want: {
    titleOptions?: boolean;
    youtubeDescription?: boolean;
    summary?: boolean;
    chapterTitles?: boolean;
    captions?: readonly ('youtube_shorts' | 'instagram_reels' | 'tiktok')[];
  };
}

export interface MetadataResult {
  titleOptions?: string[];
  youtubeDescription?: string;
  summary?: string;
  /** チャプターID → 改善後のタイトル。 */
  chapterTitles?: Record<string, string>;
  captions?: Record<string, { text: string; hashtags: string[] }>;
}

// ─── コスト ────────────────────────────────────────────

export interface CostEstimate {
  provider: string;
  model: string;
  /** 送信予定のトークン数（推定）。 */
  inputTokens: number;
  /** 受信予定のトークン数（推定）。 */
  outputTokens: number;
  /** 概算（円）。 */
  estimatedJpy: number;
  /** キャッシュに当たる見込みなら true（費用0）。 */
  willUseCache: boolean;
  /** 上限に達している等で実行できない場合の理由。 */
  blockedReason?: string;
}

export type AiRequestInput =
  | { kind: 'rankShortCandidates'; input: ShortCandidateInput }
  | { kind: 'generateMetadata'; input: MetadataInput };

// ─── プロバイダー ────────────────────────────────────────

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** APIキーを必要とするか。ローカルプロバイダーは false。 */
  readonly requiresApiKey: boolean;

  rankShortCandidates(
    input: ShortCandidateInput,
  ): Promise<ShortCandidateResult[]>;

  generateMetadata(input: MetadataInput): Promise<MetadataResult>;

  /** 実行前の推定。GUIで確認ダイアログに出す。 */
  estimateCost(input: AiRequestInput): Promise<CostEstimate>;
}

/** プロバイダーの生成に必要な設定。 */
export interface ProviderConfig {
  /**
   * ★APIキーはここに直接書かない。
   * 環境変数（CONTENTOS_AI_API_KEY）またはOSのキーチェーンから読む。
   * プロジェクトJSONにもリポジトリにも保存しない。
   */
  apiKey?: string;
  model?: string;
  /** キャッシュの保存先ディレクトリ。 */
  cacheDir?: string;
}
