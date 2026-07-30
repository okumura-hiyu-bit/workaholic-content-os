/**
 * ⑥ 文字起こし。
 *
 * ★単一の代表トラック（wide優先）を文字起こしする。マイクごとに別々に
 * 文字起こしすると同じ発言が重複するため、テキスト化は1回だけ行い、
 * 話者の割り当ては detect-speakers の発話区間との時刻突き合わせ
 * （generate-subtitles / extract-short-candidates 側）で行う。
 *
 * VAD（無音除去）は常に無効。沈黙・間は作品の一部であり、文字起こしの
 * 都合で時間軸を詰めない。
 */

import { buildVocabularyPrompt, transcribe } from '../../../media/src/transcribe.ts';
import { PipelineErrors } from '../errors.ts';
import type { StepContext, StepDefinition, StepResult } from '../types.ts';
import { extractedAudioPath } from './extract-audio.ts';

const STEP_ID = 'transcribe' as const;

export const transcribeStep: StepDefinition = {
  id: STEP_ID,
  deps: ['extract-audio'],
  async run(ctx: StepContext): Promise<StepResult> {
    const source =
      ctx.project.assets.find((a) => a.role === 'wide' && a.hasAudio) ??
      ctx.project.assets.find((a) => a.role.startsWith('cam_') && a.hasAudio);

    if (!source) {
      throw PipelineErrors.assetMissing(
        STEP_ID,
        '（文字起こしできる音声つきの本編素材が見つかりません）',
      );
    }

    const initialPrompt = buildVocabularyPrompt({
      theme: ctx.project.theme,
      speakers: ctx.project.speakers,
      keywords: ctx.project.keywords ?? [],
    });

    let transcript;
    try {
      transcript = await transcribe(
        extractedAudioPath(ctx.paths.cache.audio, source.id),
        { ...ctx.config.transcribe, initialPrompt },
        ctx.signal,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('faster_whisper')) {
        throw PipelineErrors.whisperNotFound(STEP_ID, message);
      }
      throw error;
    }

    ctx.log({
      event: 'finish',
      success: true,
      inputFileNames: [source.fileName],
      durationMs: transcript.timings ? transcript.timings.totalSec * 1000 : undefined,
      toolVersions: { model: transcript.model },
    });

    return {
      status: 'completed',
      analysisPatch: {
        transcript: {
          language: transcript.language,
          model: transcript.model,
          vadFilter: transcript.vadFilter,
          words: transcript.words,
          segments: transcript.segments,
        },
      },
      toolVersions: { whisperModel: transcript.model },
      timings: transcript.timings
        ? {
            modelLoadMs: transcript.timings.modelLoadSec * 1000,
            preprocessMs: transcript.timings.preprocessSec * 1000,
            inferenceMs: transcript.timings.inferenceSec * 1000,
            postprocessMs: transcript.timings.postprocessSec * 1000,
            jsonMs: transcript.timings.jsonSec * 1000,
            totalMs: transcript.timings.totalSec * 1000,
            realtimeFactor: transcript.durationSec > 0
              ? transcript.timings.totalSec / transcript.durationSec
              : 0,
          }
        : undefined,
      message: `${transcript.words.length}語を認識しました（${transcript.model}）`,
    };
  },
};
