/**
 * ⑧ 字幕生成。
 *
 * 文字起こしの単語に話者を割り当て（時刻の突き合わせ）、字幕キューに組む。
 * 低confidence語はキューに保持し、確認画面で赤字表示できるようにする。
 */

import { subtitleId, type IdentifiedSubtitleCue } from '@contentos/core/project';
import { buildSubtitleCues } from '@contentos/editing/srt';
import { assignSpeakers, lowConfidenceWords } from '@contentos/media/transcribe';
import type { StepContext, StepDefinition, StepResult } from '../types.ts';

const LOW_CONFIDENCE_THRESHOLD = 0.5;

export const generateSubtitlesStep: StepDefinition = {
  id: 'generate-subtitles',
  deps: ['transcribe', 'detect-speakers'],
  async run(ctx: StepContext): Promise<StepResult> {
    const words = ctx.analysis.transcript?.words ?? [];
    const assigned = assignSpeakers(words, ctx.analysis.speech);
    const lowConfidence = lowConfidenceWords(assigned, LOW_CONFIDENCE_THRESHOLD);
    const cues = buildSubtitleCues(assigned);

    const subtitles: IdentifiedSubtitleCue[] = cues.map((cue) => {
      const cueLowConfidence = lowConfidence
        .filter((w) => w.startSec >= cue.startSec && w.endSec <= cue.endSec)
        .map((w) => ({ text: w.text, probability: w.probability ?? 0 }));

      return {
        id: subtitleId(cue.startSec),
        startSec: cue.startSec,
        endSec: cue.endSec,
        lines: cue.lines,
        speakerId: cue.speakerId,
        lowConfidenceWords: cueLowConfidence.length > 0 ? cueLowConfidence : undefined,
      };
    });

    ctx.log({ event: 'finish', success: true });

    return {
      status: 'completed',
      analysisPatch: { subtitles },
      message: `字幕${subtitles.length}キュー（低confidence語 ${lowConfidence.length}件）`,
    };
  },
};
