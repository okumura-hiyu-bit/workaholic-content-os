/**
 * ① プロジェクト検証。
 *
 * 実際の処理を始める前に、環境（ffmpeg・Python）と権限・素材の存在を
 * 確認する。ここで失敗を検知すれば、後続の重い処理（文字起こし等）に
 * 時間を使う前にユーザーへ分かりやすいエラーを返せる。
 */

import { existsSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkFfmpegAvailable } from '@contentos/media/ffmpeg';
import { resolvePython } from '@contentos/media/transcribe';
import { PipelineErrors } from '../errors.ts';
import type { StepContext, StepDefinition, StepResult } from '../types.ts';

const STEP_ID = 'validate-project' as const;

/** 空き容量がこの値未満なら警告する（バイト）。 */
const LOW_DISK_WARNING_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

function checkDiskSpace(root: string): string | undefined {
  try {
    const stats = statfsSync(root);
    const freeBytes = stats.bavail * stats.bsize;
    if (freeBytes < LOW_DISK_WARNING_BYTES) {
      const freeGb = (freeBytes / 1024 ** 3).toFixed(1);
      return `空き容量が少なくなっています（残り約${freeGb}GB）。`;
    }
  } catch {
    // statfsSync が使えない環境では静かにスキップする（致命的ではない）。
  }
  return undefined;
}

function checkWritable(root: string): void {
  const probe = join(root, `.write-test-${process.pid}`);
  try {
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw PipelineErrors.permissionDenied(STEP_ID, root);
    }
    throw error;
  }
}

export const validateProjectStep: StepDefinition = {
  id: STEP_ID,
  deps: [],
  async run(ctx: StepContext): Promise<StepResult> {
    const warnings: string[] = [];

    const ffmpeg = checkFfmpegAvailable();
    if (!ffmpeg.ok) {
      throw PipelineErrors.ffmpegNotFound(STEP_ID, ffmpeg.message);
    }

    try {
      resolvePython(ctx.project.rootDir);
    } catch (error) {
      throw PipelineErrors.pythonNotFound(
        STEP_ID,
        error instanceof Error ? error.message : String(error),
      );
    }

    checkWritable(ctx.paths.root);

    const diskWarning = checkDiskSpace(ctx.paths.root);
    if (diskWarning) warnings.push(diskWarning);

    if (ctx.project.assets.length === 0) {
      warnings.push('素材が未登録です。素材登録画面で割り当ててから解析してください。');
    } else {
      for (const asset of ctx.project.assets) {
        if (!existsSync(asset.absolutePath)) {
          throw PipelineErrors.assetMissing(STEP_ID, asset.fileName);
        }
      }
    }

    ctx.log({ event: 'finish', success: true, warningCount: warnings.length });

    return {
      status: warnings.length > 0 ? 'warning' : 'completed',
      warnings,
      message:
        warnings.length > 0
          ? `${warnings.length}件の警告があります`
          : '検証OK',
    };
  },
};
