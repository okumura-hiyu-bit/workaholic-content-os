/**
 * ⑪ マーカー生成。
 *
 * FCP7 XMLに載せるタイムラインマーカー（[TOPIC][LAUGH][CHECK]…）を
 * 組み立てる。色分けができないため種類は接頭辞で表現する
 * （docs/12-premiere-capability-matrix.md 12.3②）。
 *
 * ★笑いは確信度に関わらずマーカーとして提示する。カメラ切替の根拠に
 * するかどうかは camera-plan 側の確信度しきい値で制御済み（別の話）。
 * ここでは低確信度に「要確認」を添えるだけで、判断は編集者に委ねる。
 *
 * ★checks の所有権は correct-audio と共有する。ここでは
 * `ctx.analysis.checks`（correct-audioが書いたもの）を読み、
 * 低confidence語・低同期信頼度ぶんを足して返す
 * （オーケストレーターは配列を自動マージしないため、自分で連結する）。
 */

import {
  markerId,
  type AnalysisCheck,
  type IdentifiedMarker,
} from '../../../core/src/project.ts';
import { lowConfidenceWords } from '../../../media/src/transcribe.ts';
import type { StepContext, StepDefinition, StepResult } from '../types.ts';

const LOW_CONFIDENCE_THRESHOLD = 0.5;
const LOW_CONFIDENCE_GROUP_GAP_SEC = 2;
const LAUGH_CONFIDENCE_THRESHOLD = 0.5;

export const generateMarkersStep: StepDefinition = {
  id: 'generate-markers',
  deps: ['detect-speakers', 'transcribe', 'generate-chapters', 'correct-audio'],
  async run(ctx: StepContext): Promise<StepResult> {
    const markers: IdentifiedMarker[] = [];

    for (const chapter of ctx.analysis.chapters) {
      markers.push({
        id: markerId('TOPIC', chapter.startSec),
        kind: 'TOPIC',
        startSec: chapter.startSec,
        name: chapter.title,
        comment: '章タイトル（AIアシストモードで改善できます）',
      });
    }

    for (const laugh of ctx.analysis.laughter) {
      const confidence = laugh.confidence;
      const lowConf = confidence !== undefined && confidence < LAUGH_CONFIDENCE_THRESHOLD;
      markers.push({
        id: markerId('LAUGH', laugh.startSec),
        kind: 'LAUGH',
        startSec: laugh.startSec,
        endSec: laugh.endSec,
        name: `笑い（${(laugh.endSec - laugh.startSec).toFixed(1)}秒）`,
        comment:
          `関与: ${(laugh.speakerIds ?? []).join(', ')} / 確信度 ${confidence ?? '不明'}` +
          (lowConf ? '（低いため要確認・カメラ切替の根拠にはしていません）' : ''),
      });
    }

    // 低confidence語を、近いもの同士でグループ化してCHECKマーカーにする。
    const words = ctx.analysis.transcript?.words ?? [];
    const lowWords = lowConfidenceWords(words, LOW_CONFIDENCE_THRESHOLD);
    const groups: { startSec: number; endSec: number; texts: string[] }[] = [];
    for (const word of lowWords) {
      const last = groups[groups.length - 1];
      if (last && word.startSec - last.endSec <= LOW_CONFIDENCE_GROUP_GAP_SEC) {
        last.endSec = word.endSec;
        last.texts.push(word.text);
      } else {
        groups.push({ startSec: word.startSec, endSec: word.endSec, texts: [word.text] });
      }
    }

    const newChecks: AnalysisCheck[] = groups.map((g) => ({
      id: `check-lowconf-${Math.round(g.startSec * 1000)}`,
      severity: 'info',
      startSec: g.startSec,
      message: `低confidence: 「${g.texts.join('')}」（聞き直しを推奨）`,
    }));

    for (const [assetId, offset] of Object.entries(ctx.syncOffsets)) {
      if (!offset.reliable) {
        const asset = ctx.project.assets.find((a) => a.id === assetId);
        newChecks.push({
          id: `check-sync-${assetId}`,
          severity: 'warning',
          target: assetId,
          message: `${asset?.fileName ?? assetId} の同期信頼度が低いです（${offset.confidence.toFixed(2)}）`,
        });
      }
    }

    for (const check of [...ctx.analysis.checks, ...newChecks]) {
      if (check.startSec === undefined) continue;
      markers.push({
        id: `mk-CHECK-${check.id}`,
        kind: 'CHECK',
        startSec: check.startSec,
        name: '要確認',
        comment: check.message,
      });
    }

    markers.sort((a, b) => a.startSec - b.startSec);

    ctx.log({ event: 'finish', success: true, warningCount: newChecks.length });

    return {
      status: 'completed',
      analysisPatch: {
        markers,
        checks: [...ctx.analysis.checks, ...newChecks],
      },
      message: `マーカー${markers.length}件を生成しました`,
    };
  },
};
