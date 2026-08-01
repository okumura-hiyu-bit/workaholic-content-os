/**
 * ⑩ カメラ切替案生成。
 *
 * packages/editing/camera-plan.ts のルールベース算出をそのまま使う。
 * ★沈黙を理由にした切替は行わない（camera-plan.ts 側の原則）。
 */

import { cameraShotId, type IdentifiedCameraShot } from '@contentos/core/project';
import { planCameraSwitches } from '@contentos/editing/camera-plan';
import type { CameraSource } from '@contentos/editing/types';
import { PipelineErrors } from '../errors.ts';
import type { StepContext, StepDefinition, StepResult } from '../types.ts';

const STEP_ID = 'generate-camera-plan' as const;

export const generateCameraPlanStep: StepDefinition = {
  id: STEP_ID,
  deps: ['sync-media', 'detect-speakers'],
  async run(ctx: StepContext): Promise<StepResult> {
    const wide = ctx.project.assets.find((a) => a.role === 'wide');
    if (!wide) {
      throw PipelineErrors.assetMissing(STEP_ID, '（wide 素材が未登録です）');
    }

    const cameras: CameraSource[] = ctx.project.assets
      .filter((a) => a.role === 'wide' || a.role.startsWith('cam_'))
      .map((a) => ({
        id: a.role,
        kind: a.role === 'wide' ? 'wide' : 'closeup',
        speakerId: a.role.startsWith('cam_') ? a.role.replace(/^cam_/, '') : undefined,
        file: a.fileName,
        syncOffsetSec: ctx.syncOffsets[a.id]?.offsetSec ?? 0,
      }));

    const shots = planCameraSwitches({
      durationSec: wide.durationSec,
      speech: ctx.analysis.speech,
      laughter: ctx.analysis.laughter,
      cameras,
    });

    const cameraShots: IdentifiedCameraShot[] = shots.map((shot) => ({
      id: cameraShotId(shot.startSec),
      ...shot,
    }));

    ctx.log({ event: 'finish', success: true });

    return {
      status: 'completed',
      analysisPatch: { cameraShots },
      message: `${cameraShots.length}カットのカメラ切替案を作成しました`,
    };
  },
};
