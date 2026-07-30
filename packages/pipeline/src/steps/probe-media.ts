/**
 * ② 素材情報取得。
 *
 * ffprobe で各素材のフレームレート・尺・音声チャンネル等を読み、
 * `Project.assets` の更新版を作る。ハッシュ計算の基礎になる
 * サイズ・更新時刻もここで確定させる。
 *
 * ★入力の `ctx.project.assets` は書き換えない。新しい配列を
 * `assetsPatch` として返し、適用はオーケストレーターに任せる
 * （工程を副作用なく単体テストできるようにするため）。
 */

import { statSync } from 'node:fs';

import type { ProjectAsset } from '../../../core/src/project.ts';
import { probeMedia } from '../../../media/src/ffmpeg.ts';
import { PipelineErrors } from '../errors.ts';
import type { StepContext, StepDefinition, StepResult } from '../types.ts';

const STEP_ID = 'probe-media' as const;

function isAudioRole(role: string): boolean {
  return role.startsWith('mic_');
}

export const probeMediaStep: StepDefinition = {
  id: STEP_ID,
  deps: ['validate-project'],
  async run(ctx: StepContext): Promise<StepResult> {
    const warnings: string[] = [];
    const updated: ProjectAsset[] = [];

    for (const asset of ctx.project.assets) {
      const stat = statSync(asset.absolutePath);
      const info = probeMedia(asset.absolutePath);

      if (isAudioRole(asset.role) && !info.hasAudio) {
        throw PipelineErrors.noAudioTrack(STEP_ID, asset.fileName);
      }
      if (!isAudioRole(asset.role) && !info.hasAudio) {
        warnings.push(
          `${asset.fileName} に音声トラックがありません（同期・話者判定の対象外になります）`,
        );
      }

      updated.push({
        ...asset,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        durationSec: info.durationSec,
        fps: info.fps,
        width: info.width,
        height: info.height,
        audioChannels: info.audioChannels,
        audioSampleRate: info.audioSampleRate,
        hasVideo: info.hasVideo,
        hasAudio: info.hasAudio,
      });
    }

    const fpsValues = new Set(updated.filter((a) => a.fps).map((a) => a.fps));
    if (fpsValues.size > 1) {
      warnings.push(
        `フレームレートが混在しています（${[...fpsValues].join(' / ')}）。` +
          '基準は wide の値を使います。',
      );
    }

    ctx.log({
      event: 'finish',
      success: true,
      inputFileNames: updated.map((a) => a.fileName),
      warningCount: warnings.length,
    });

    return {
      status: warnings.length > 0 ? 'warning' : 'completed',
      warnings,
      assetsPatch: updated,
      message: `${updated.length}素材の情報を取得しました`,
    };
  },
};
