/**
 * ⑫ ショート候補の一次抽出（ローカル・APIを使わない）。
 *
 * packages/editing/short-candidates.ts の決定的な抽出ロジックをそのまま使う。
 * ここで出た10〜20本の候補の transcriptExcerpt だけが、AIアシストモードで
 * APIに送られる対象になる（文字起こし全文は送らない）。
 */

import type { IdentifiedShortCandidate } from '../../../core/src/project.ts';
import {
  deriveEmphasisPoints,
  extractShortCandidates,
} from '../../../editing/src/short-candidates.ts';
import { readEnvelopeCache } from '../envelope-cache.ts';
import { PipelineErrors } from '../errors.ts';
import type { StepContext, StepDefinition, StepResult } from '../types.ts';

const STEP_ID = 'extract-short-candidates' as const;

export const extractShortCandidatesStep: StepDefinition = {
  id: STEP_ID,
  deps: ['transcribe', 'detect-speakers', 'generate-chapters'],
  async run(ctx: StepContext): Promise<StepResult> {
    const wide = ctx.project.assets.find((a) => a.role === 'wide');
    if (!wide) {
      throw PipelineErrors.assetMissing(STEP_ID, '（wide 素材が未登録です）');
    }

    const words = ctx.analysis.transcript?.words ?? [];
    const keywords = ctx.project.keywords ?? [];
    const emphasis = deriveEmphasisPoints(words, keywords);
    const energy = readEnvelopeCache(ctx.paths.cache.waveform, wide.id);

    const topics = ctx.analysis.chapters.map((chapter, index) => ({
      startSec: chapter.startSec,
      endSec: ctx.analysis.chapters[index + 1]?.startSec ?? wide.durationSec,
      title: chapter.title,
    }));

    const candidates = extractShortCandidates(
      {
        durationSec: wide.durationSec,
        words,
        speech: ctx.analysis.speech,
        backchannels: ctx.analysis.backchannels,
        overlaps: ctx.analysis.overlaps,
        laughter: ctx.analysis.laughter,
        emphasis,
        topics,
        energy,
        keywords,
      },
      ctx.config.shortCandidates,
    );

    const shortCandidates: IdentifiedShortCandidate[] = candidates.map((c) => ({
      id: c.id,
      startSec: c.startSec,
      endSec: c.endSec,
      score: c.score,
      signals: c.signals,
      primarySpeakerId: c.primarySpeakerId,
      transcriptExcerpt: c.transcriptExcerpt,
    }));

    ctx.log({ event: 'finish', success: true });

    return {
      status: 'completed',
      // ★emphasis はここで一度だけ計算し、save-artifacts の強調字幕SRTで
      // 再利用する（同じキーワード一致処理を2箇所で重複させない）。
      analysisPatch: { shortCandidates, emphasis },
      message: `ショート候補${shortCandidates.length}本を抽出しました（強調ポイント${emphasis.length}件）`,
    };
  },
};
