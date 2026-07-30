/**
 * ⑬ Premiere用XML生成。
 *
 * ★人間の修正を反映してから書き出す。`resolveProject(analysis, edits)` を
 * ここで呼び、編集者が直したカメラ切替・マーカー・採用ショートを
 * 実際のXMLに反映する——これが「字幕やカメラを直した後、書き出しだけ
 * やり直す」というワークフローを成立させている中心の仕組み。
 *
 * 原音は必ず有効トラック、補正音は必ず無効（ミュート）トラックにする
 * （build-project.ts が保証する非破壊の原則）。
 */

import { join } from 'node:path';

import { adoptedShorts, resolveProject } from '../../../core/src/resolve.ts';
import type { ProjectAsset } from '../../../core/src/project.ts';
import {
  buildEditProject,
  type AudioSource,
  type VideoSource,
} from '../../../editing/src/build-project.ts';
import {
  fcp7FileName,
  generateFcp7Xml,
  type Fcp7MediaFile,
  type Fcp7Rate,
} from '../../../editing/src/fcp7xml.ts';
import type { ShortCandidate } from '../../../editing/src/types.ts';
import { PipelineErrors } from '../errors.ts';
import { writeManagedArtifact } from '../paths.ts';
import type { StepContext, StepDefinition, StepResult } from '../types.ts';
import { correctedAudioPath } from './correct-audio.ts';

const STEP_ID = 'generate-premiere-xml' as const;
const SAMPLE_RATE = 48_000;

const NTSC_RATES = [23.976, 29.97, 59.94, 119.88];

function resolveRate(fps: number | undefined): Fcp7Rate {
  const f = fps ?? 30;
  for (const candidate of NTSC_RATES) {
    if (Math.abs(f - candidate) < 0.05) return { timebase: Math.round(candidate), ntsc: true };
  }
  return { timebase: Math.round(f), ntsc: false };
}

function toMediaFile(asset: ProjectAsset, rate: Fcp7Rate, overridePath?: string): Fcp7MediaFile {
  const fps = rate.ntsc ? (rate.timebase * 1000) / 1001 : rate.timebase;
  return {
    id: `f-${asset.id}`,
    name: asset.fileName,
    absolutePath: overridePath ?? asset.absolutePath,
    durationFrames: Math.round((asset.durationSec ?? 0) * fps),
    hasVideo: asset.hasVideo,
    hasAudio: asset.hasAudio,
    width: asset.width,
    height: asset.height,
    audioChannels: asset.audioChannels,
    sampleRate: asset.audioSampleRate ?? SAMPLE_RATE,
  };
}

export const generatePremiereXmlStep: StepDefinition = {
  id: STEP_ID,
  deps: ['sync-media', 'correct-audio', 'generate-subtitles', 'generate-markers', 'generate-camera-plan'],
  async run(ctx: StepContext): Promise<StepResult> {
    const wide = ctx.project.assets.find((a) => a.role === 'wide');
    if (!wide) {
      throw PipelineErrors.assetMissing(STEP_ID, '（wide 素材が未登録です）');
    }

    const rate = resolveRate(wide.fps);

    const videos: VideoSource[] = ctx.project.assets
      .filter((a) => a.role === 'wide' || a.role.startsWith('cam_'))
      .map((a) => ({
        id: a.role,
        file: toMediaFile(a, rate),
        syncOffsetSec: ctx.syncOffsets[a.id]?.offsetSec ?? 0,
        speakerId: a.role.startsWith('cam_') ? a.role.replace(/^cam_/, '') : undefined,
      }));

    const audios: AudioSource[] = [];
    for (const asset of ctx.project.assets.filter((a) => a.role.startsWith('mic_'))) {
      const speakerId = asset.role.replace(/^mic_/, '');
      const offsetSec = ctx.syncOffsets[asset.id]?.offsetSec ?? 0;

      audios.push({
        id: asset.id,
        kind: 'original',
        speakerId,
        // ★原音は元ファイルを直接参照する（キャッシュではない）。
        file: toMediaFile(asset, rate),
        syncOffsetSec: offsetSec,
      });

      const correctedPath = correctedAudioPath(ctx.paths.cache.audio, asset.id);
      if (ctx.config.correctAudio.enabled) {
        audios.push({
          id: `${asset.id}_corrected`,
          kind: 'corrected',
          speakerId,
          // ★補正音はcache由来。ここだけがcacheクリアの影響を受けうる。
          file: {
            ...toMediaFile(asset, rate, correctedPath),
            id: `f-${asset.id}-corrected`,
            name: `${asset.fileName}.corrected.wav`,
          },
          syncOffsetSec: offsetSec,
        });
      }
    }

    const bgm = ctx.project.assets.find((a) => a.role === 'bgm');
    if (bgm) {
      audios.push({
        id: bgm.id,
        kind: 'bgm',
        file: toMediaFile(bgm, rate),
        syncOffsetSec: 0,
      });
    }

    // ★人間の修正を反映する。ここが「編集後は書き出しだけやり直せる」の要。
    const { resolved } = resolveProject(ctx.analysis, ctx.project.edits);

    const shorts: ShortCandidate[] = adoptedShorts(resolved).map((s) => ({
      id: s.id,
      startSec: s.startSec,
      endSec: s.endSec,
      title: s.title ?? '',
      hook: s.hook ?? '',
      rationale: s.signals.join(' / '),
      primarySpeakerId: s.primarySpeakerId,
    }));

    let xml: string;
    try {
      const project = buildEditProject({
        episodeId: ctx.project.id,
        rate,
        sampleRate: SAMPLE_RATE,
        durationSec: wide.durationSec,
        width: wide.width ?? 1920,
        height: wide.height ?? 1080,
        videos,
        audios,
        shots: resolved.cameraShots,
        markers: resolved.markers,
        shorts,
        syncMode: ctx.config.syncMode,
      });
      xml = generateFcp7Xml(project);
    } catch (error) {
      throw PipelineErrors.xmlGenerationFailed(
        STEP_ID,
        error instanceof Error ? error.message : String(error),
      );
    }

    const target = join(ctx.paths.exports.premiere, fcp7FileName(ctx.project.id));
    const written = writeManagedArtifact(ctx.project, ctx.paths, target, xml);

    ctx.log({ event: 'finish', success: true });

    return {
      status: 'completed',
      outputFiles: [written],
      message: `${videos.length}映像 / ${audios.length}音声 / ショート${shorts.length}本を含むXMLを書き出しました`,
    };
  },
};
