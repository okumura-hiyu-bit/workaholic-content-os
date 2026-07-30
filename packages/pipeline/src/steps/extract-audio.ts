/**
 * ③ 音声抽出。
 *
 * 各素材（映像・音声問わず）から音声トラックを cache/audio/<assetId>.wav に
 * 抽出しておく。以降の工程（同期・補正・文字起こし）はこのWAVだけを触り、
 * 元の映像ファイルには一切アクセスしない——大きな動画ファイルを何度も
 * 開き直すコストを避けるため。
 *
 * ★ffmpeg呼び出しは runProcess 経由。AbortSignal で確実に中止できる。
 */

import { join } from 'node:path';

import { resolveBinary } from '../../../media/src/ffmpeg.ts';
import { runProcess } from '../../../media/src/process.ts';
import { checkAborted } from '../process.ts';
import type { StepContext, StepDefinition, StepResult } from '../types.ts';

export function extractedAudioPath(cacheAudioDir: string, assetId: string): string {
  return join(cacheAudioDir, `${assetId}.wav`);
}

export const extractAudioStep: StepDefinition = {
  id: 'extract-audio',
  deps: ['probe-media'],
  async run(ctx: StepContext): Promise<StepResult> {
    const targets = ctx.project.assets.filter((a) => a.hasAudio);
    const outputFiles: string[] = [];

    for (const [index, asset] of targets.entries()) {
      checkAborted(ctx.signal);

      const outPath = extractedAudioPath(ctx.paths.cache.audio, asset.id);
      const result = await runProcess(
        resolveBinary('ffmpeg'),
        [
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', asset.absolutePath,
          '-vn',
          '-acodec', 'pcm_s16le',
          '-ar', '48000',
          '-ac', String(asset.audioChannels && asset.audioChannels <= 2 ? asset.audioChannels : 2),
          outPath,
        ],
        { signal: ctx.signal, maxBufferBytes: 16 * 1024 * 1024 },
      );

      if (result.code !== 0) {
        throw new Error(`音声抽出に失敗しました（${asset.fileName}）:\n${result.stderr}`);
      }

      outputFiles.push(outPath);
      ctx.reportStepProgress((index + 1) / targets.length);
    }

    ctx.log({
      event: 'finish',
      success: true,
      inputFileNames: targets.map((a) => a.fileName),
    });

    return {
      status: 'completed',
      outputFiles,
      message: `${outputFiles.length}素材から音声を抽出しました`,
    };
  },
};
