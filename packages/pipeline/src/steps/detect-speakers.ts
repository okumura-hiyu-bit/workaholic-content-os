/**
 * ⑦ 話者判定。
 *
 * マイクごとの音量エンベロープ（sync-media が cache/waveform/ に
 * 保存したもの）を比較し、発話区間・相槌・同時発話・笑いを検出する。
 * 文字起こしとは独立した処理（音量ベース）。
 */

import { detectLaughterCandidates, detectSpeakers } from '../../../editing/src/speaker-detect.ts';
import type { MicTrack } from '../../../editing/src/speaker-detect.ts';
import { readEnvelopeCache } from '../envelope-cache.ts';
import type { StepContext, StepDefinition, StepResult } from '../types.ts';

export const detectSpeakersStep: StepDefinition = {
  id: 'detect-speakers',
  deps: ['sync-media'],
  async run(ctx: StepContext): Promise<StepResult> {
    const micAssets = ctx.project.assets.filter((a) => a.role.startsWith('mic_'));
    const warnings: string[] = [];

    const micTracks: MicTrack[] = [];
    for (const asset of micAssets) {
      const envelope = readEnvelopeCache(ctx.paths.cache.waveform, asset.id);
      if (!envelope) {
        warnings.push(
          `${asset.fileName} の波形キャッシュが見つかりません（sync-media を先に実行してください）`,
        );
        continue;
      }
      const speakerId = asset.role.replace(/^mic_/, '');
      micTracks.push({
        speakerId,
        envelope,
        offsetSec: ctx.syncOffsets[asset.id]?.offsetSec ?? 0,
      });
    }

    const detected = detectSpeakers(micTracks);
    const laughter = detectLaughterCandidates(micTracks, detected.overlaps);

    ctx.log({
      event: 'finish',
      success: true,
      inputFileNames: micAssets.map((a) => a.fileName),
      warningCount: warnings.length,
    });

    return {
      status: warnings.length > 0 ? 'warning' : 'completed',
      warnings,
      analysisPatch: {
        speakers: ctx.project.speakers,
        speech: detected.speech,
        backchannels: detected.backchannels,
        overlaps: detected.overlaps,
        laughter,
      },
      message: `発話${detected.speech.length}区間・相槌${detected.backchannels.length}件・同時発話${detected.overlaps.length}件を検出しました`,
    };
  },
};
