/**
 * ⑮ プロジェクトJSONの更新（検証）。
 *
 * ★実際のディスク書き込みは、この工程の run() ではなく
 * オーケストレーター（run-pipeline.ts）が実行全体の最後に必ず1回行う。
 * 理由：実行範囲を `onlySteps` で絞ったとき（例: `transcribe` だけ）
 * この工程自体が計画に含まれないことがあるが、それでも文字起こしの
 * 結果は必ずディスクへ残さなければならない。「保存」を特定の工程の
 * 成否に結びつけると、部分実行のたびに保存が抜け落ちる危険がある。
 *
 * この工程自身の役割は、書き出す直前の解析結果に明らかな欠落が
 * ないかを検証すること（例：字幕はあるのにカメラ切替案が空、等）。
 */

import type { StepContext, StepDefinition, StepResult } from '../types.ts';

export const saveProjectStep: StepDefinition = {
  id: 'save-project',
  deps: ['save-artifacts'],
  async run(ctx: StepContext): Promise<StepResult> {
    const warnings: string[] = [];
    const a = ctx.analysis;

    if (a.subtitles.length > 0 && a.cameraShots.length === 0) {
      warnings.push('字幕はありますがカメラ切替案が空です。generate-camera-plan を確認してください。');
    }
    if ((a.transcript?.words.length ?? 0) > 0 && a.subtitles.length === 0) {
      warnings.push('文字起こしはありますが字幕が生成されていません。');
    }

    ctx.log({ event: 'finish', success: true, warningCount: warnings.length });

    return {
      status: warnings.length > 0 ? 'warning' : 'completed',
      warnings,
      message: '解析結果の整合性を確認しました（実際の保存はこの後に行われます）',
    };
  },
};
