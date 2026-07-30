/**
 * ⑨ チャプター生成（ローカル・決定的）。
 *
 * AIによる文脈理解ではなく、発話の間（切れ目）を境界とするヒューリスティック。
 * タイトルは次の発話の冒頭を仮タイトルとして置く——「チャプター名の改善」は
 * API処理の対象（後段のAIアシストモードで差し替える前提）。
 */

import { chapterId, type IdentifiedChapter } from '../../../core/src/project.ts';
import type { StepContext, StepDefinition, StepResult } from '../types.ts';

export interface ChapterHeuristicOptions {
  /** これ以上の間があれば境界候補にする。 */
  minGapSec: number;
  /** 章と章の最小間隔（短すぎる章を作らない）。 */
  minSpacingSec: number;
  /** 仮タイトルに使う先頭の文字数。 */
  titleChars: number;
}

export const DEFAULT_CHAPTER_OPTIONS: ChapterHeuristicOptions = {
  minGapSec: 15,
  minSpacingSec: 60,
  titleChars: 14,
};

function textAfter(
  words: readonly { startSec: number; text: string }[],
  fromSec: number,
  chars: number,
): string {
  const relevant = words.filter((w) => w.startSec >= fromSec);
  const joined = relevant
    .map((w) => w.text)
    .join('')
    .replace(/[、。,.]/g, '');
  return joined.slice(0, chars) || 'チャプター';
}

export const generateChaptersStep: StepDefinition = {
  id: 'generate-chapters',
  deps: ['transcribe', 'detect-speakers'],
  async run(ctx: StepContext): Promise<StepResult> {
    const opt = DEFAULT_CHAPTER_OPTIONS;
    const speech = [...ctx.analysis.speech].sort((a, b) => a.startSec - b.startSec);
    const words = ctx.analysis.transcript?.words ?? [];

    const boundaries: number[] = [0];
    let lastBoundary = 0;
    for (let i = 1; i < speech.length; i++) {
      const gap = speech[i]!.startSec - speech[i - 1]!.endSec;
      if (gap >= opt.minGapSec && speech[i]!.startSec - lastBoundary >= opt.minSpacingSec) {
        boundaries.push(speech[i]!.startSec);
        lastBoundary = speech[i]!.startSec;
      }
    }

    const chapters: IdentifiedChapter[] = boundaries.map((startSec, index) => ({
      id: chapterId(startSec),
      startSec,
      title:
        index === 0
          ? 'オープニング'
          : textAfter(words, startSec, opt.titleChars),
    }));

    ctx.log({ event: 'finish', success: true });

    return {
      status: 'completed',
      analysisPatch: { chapters },
      message: `${chapters.length}章に区切りました（仮タイトル。AIアシストモードで改善できます）`,
    };
  },
};
