/**
 * ⑤ 音声補正（非破壊）。
 *
 * ★原音は絶対に書き換えない。補正音は cache/audio/corrected/ に
 * 別ファイルとして生成する（cache/ に置くのは、原音＋設定から完全に
 * 再現できる内容だから——削除しても次回実行時に作り直せる）。
 *
 * クリッピング・チャンネル無音・話者間の音量差は自動補正せず、
 * AnalysisCheck として記録するだけに留める（[CHECK]マーカーの元になる）。
 */

import { join } from 'node:path';

import { correctAudio } from '@contentos/media/audio-correct';
import {
  detectClipping,
  detectLevelMismatch,
  detectSilentChannel,
} from '@contentos/media/audio-checks';
import { decodeAudioMono } from '@contentos/media/ffmpeg';
import type { AnalysisCheck } from '@contentos/core/project';
import { checkAborted } from '../process.ts';
import type { StepContext, StepDefinition, StepResult } from '../types.ts';
import { extractedAudioPath } from './extract-audio.ts';

export function correctedAudioPath(cacheAudioDir: string, assetId: string): string {
  return join(cacheAudioDir, 'corrected', `${assetId}.corrected.wav`);
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

function toDb(value: number): number {
  return value <= 0 ? -120 : 20 * Math.log10(value);
}

export const correctAudioStep: StepDefinition = {
  id: 'correct-audio',
  deps: ['extract-audio'],
  async run(ctx: StepContext): Promise<StepResult> {
    const micAssets = ctx.project.assets.filter((a) => a.role.startsWith('mic_'));
    const checks: AnalysisCheck[] = [];
    const outputFiles: string[] = [];
    const levels: { label: string; rmsDb: number }[] = [];
    const decoded = new Map<string, Float32Array>();

    for (const [index, asset] of micAssets.entries()) {
      checkAborted(ctx.signal);
      const inputPath = extractedAudioPath(ctx.paths.cache.audio, asset.id);
      const audio = decodeAudioMono(inputPath, 48_000);
      decoded.set(asset.id, audio.samples);
      levels.push({ label: asset.fileName, rmsDb: toDb(rms(audio.samples)) });

      for (const issue of detectClipping(audio.samples, audio.sampleRate)) {
        checks.push({
          id: `check-clip-${asset.id}-${issue.startSec}`,
          severity: issue.severity,
          target: asset.id,
          startSec: issue.startSec,
          message: `${asset.fileName}: ${issue.message}`,
        });
      }
      for (const issue of detectSilentChannel(audio.samples, asset.fileName)) {
        checks.push({
          id: `check-silence-${asset.id}`,
          severity: issue.severity,
          target: asset.id,
          message: issue.message,
        });
      }

      if (ctx.config.correctAudio.enabled) {
        const outPath = correctedAudioPath(ctx.paths.cache.audio, asset.id);
        await correctAudio(
          inputPath,
          outPath,
          {
            noiseReduction: ctx.config.correctAudio.noiseReduction,
            loudness: ctx.config.correctAudio.loudness,
            targetLufs: ctx.config.correctAudio.targetLufs,
          },
          ctx.signal,
        );
        outputFiles.push(outPath);
      }

      ctx.reportStepProgress((index + 1) / Math.max(1, micAssets.length));
    }

    for (const issue of detectLevelMismatch(levels)) {
      checks.push({
        id: `check-level-${issue.message.slice(0, 16)}`,
        severity: issue.severity,
        message: issue.message,
      });
    }

    ctx.log({
      event: 'finish',
      success: true,
      inputFileNames: micAssets.map((a) => a.fileName),
      warningCount: checks.length,
    });

    return {
      status: 'completed',
      analysisPatch: { checks },
      outputFiles,
      message: ctx.config.correctAudio.enabled
        ? `${outputFiles.length}件の補正音を生成しました（${checks.length}件の要確認事項）`
        : `補正は無効設定のためスキップしました（${checks.length}件の要確認事項）`,
    };
  },
};
