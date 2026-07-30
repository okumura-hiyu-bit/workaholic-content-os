/**
 * ④ 音声同期。
 *
 * 引き映像を基準に、各カメラ・各マイクのオフセットを算出する
 * （packages/editing/audio-sync.ts の相互相関）。
 *
 * ★syncMode（preserve/common）はここでは使わない。オフセット自体は
 * モードに関係なく同じ値になるため、モード変更だけではこの工程を
 * 再実行する必要がない（registry.ts の設計メモを参照）。
 *
 * 算出したエンベロープは cache/waveform/ に保存し、detect-speakers・
 * extract-short-candidates が再デコードせず再利用できるようにする。
 */

import { computeEnvelope, syncSources } from '../../../editing/src/audio-sync.ts';
import type { ProjectAsset, SyncOffset } from '../../../core/src/project.ts';
import { decodeAudioMono } from '../../../media/src/ffmpeg.ts';
import { PipelineErrors } from '../errors.ts';
import { writeEnvelopeCache } from '../envelope-cache.ts';
import { checkAborted } from '../process.ts';
import type { StepContext, StepDefinition, StepResult } from '../types.ts';
import { extractedAudioPath } from './extract-audio.ts';

const STEP_ID = 'sync-media' as const;
const RELIABILITY_THRESHOLD = 0.5;

function pickReference(assets: readonly ProjectAsset[]): ProjectAsset | undefined {
  return (
    assets.find((a) => a.role === 'wide') ??
    assets.find((a) => a.role.startsWith('cam_')) ??
    assets[0]
  );
}

export const syncMediaStep: StepDefinition = {
  id: STEP_ID,
  deps: ['extract-audio'],
  async run(ctx: StepContext): Promise<StepResult> {
    const candidates = ctx.project.assets.filter(
      (a) => a.hasAudio && (a.role === 'wide' || a.role.startsWith('cam_') || a.role.startsWith('mic_')),
    );
    const reference = pickReference(candidates);
    if (!reference) {
      throw PipelineErrors.assetMissing(STEP_ID, '（引き映像が見つかりません）');
    }

    const envelopeOf = (asset: ProjectAsset) => {
      const audio = decodeAudioMono(extractedAudioPath(ctx.paths.cache.audio, asset.id));
      const envelope = computeEnvelope(audio.samples, audio.sampleRate);
      writeEnvelopeCache(ctx.paths.cache.waveform, asset.id, envelope);
      return envelope;
    };

    const referenceEnvelope = envelopeOf(reference);
    const targets = candidates.filter((a) => a.id !== reference.id);

    const targetEnvelopes = targets.map((asset, index) => {
      checkAborted(ctx.signal);
      const envelope = envelopeOf(asset);
      ctx.reportStepProgress((index + 1) / (targets.length + 1));
      return { id: asset.id, envelope };
    });

    const results = syncSources(
      { id: reference.id, envelope: referenceEnvelope },
      targetEnvelopes,
    );

    const syncOffsetsPatch: Record<string, SyncOffset> = {};
    const warnings: string[] = [];

    for (const [assetId, result] of results) {
      syncOffsetsPatch[assetId] = {
        offsetSec: result.offsetSec,
        confidence: result.confidence,
        reliable: result.reliable,
      };
      if (!result.reliable && result.confidence < RELIABILITY_THRESHOLD) {
        const asset = candidates.find((a) => a.id === assetId);
        warnings.push(
          PipelineErrors.lowSyncConfidence(
            STEP_ID,
            asset?.fileName ?? assetId,
            result.confidence,
          ).userMessage,
        );
      }
    }

    ctx.log({
      event: 'finish',
      success: true,
      inputFileNames: candidates.map((a) => a.fileName),
      warningCount: warnings.length,
    });

    return {
      status: warnings.length > 0 ? 'warning' : 'completed',
      warnings,
      syncOffsetsPatch,
      message: `${targets.length}素材のオフセットを算出しました（基準: ${reference.fileName}）`,
    };
  },
};
