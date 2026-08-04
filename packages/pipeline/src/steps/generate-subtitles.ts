/**
 * ⑧ 字幕生成。
 *
 * 文字起こしの単語に話者を割り当て（時刻の突き合わせ）、字幕キューに組む。
 * 低confidence語はキューに保持し、確認画面で赤字表示できるようにする。
 */

import {
  assignSubtitleIds,
  duplicateStartCount,
  type IdentifiedSubtitleCue,
} from '@contentos/core/project';
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

    // ★IDは並び順に対して決定的に振る。開始時刻が同じキューがあると
    // 2件目以降に連番が付く（1件目は従来と同じIDのまま）。
    const ids = assignSubtitleIds(cues);

    const subtitles: IdentifiedSubtitleCue[] = cues.map((cue, index) => {
      const cueLowConfidence = lowConfidence
        .filter((w) => w.startSec >= cue.startSec && w.endSec <= cue.endSec)
        .map((w) => ({ text: w.text, probability: w.probability ?? 0 }));

      return {
        id: ids[index]!,
        startSec: cue.startSec,
        endSec: cue.endSec,
        lines: cue.lines,
        speakerId: cue.speakerId,
        lowConfidenceWords: cueLowConfidence.length > 0 ? cueLowConfidence : undefined,
      };
    });

    // ゼロ長キューは開始時刻の衝突を生む主因。今回は自動削除せず、
    // 気づけるように警告として残す（時間軸を勝手に詰めない方針のため）。
    const zeroLength = cues.filter((cue) => cue.endSec <= cue.startSec).length;
    const duplicateStarts = duplicateStartCount(cues);

    const warnings: string[] = [];
    if (zeroLength > 0) {
      warnings.push(
        `長さが0の字幕キューが${zeroLength}件あります。開始時刻が重なる原因になります（自動削除はしていません）。`,
      );
    }
    if (duplicateStarts > 0) {
      warnings.push(
        `開始時刻が同じ字幕キューが${duplicateStarts}件あります。2件目以降のIDには連番を付けました。`,
      );
    }

    ctx.log({ event: 'finish', success: true, warningCount: warnings.length });

    return {
      status: warnings.length > 0 ? 'warning' : 'completed',
      warnings,
      analysisPatch: { subtitles },
      message: `字幕${subtitles.length}キュー（低confidence語 ${lowConfidence.length}件）`,
    };
  },
};
