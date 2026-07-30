/**
 * カメラ切り替え案の算出。
 *
 * AIモデルではなくルールベースで組む。理由は、切替の根拠が明示的になり
 * 編集者が「なぜここで切れているか」を理解でき、ルール自体を調整できるため。
 * AIに任せると理由が説明できず、直したいときに直せない。
 *
 * ★ここで出すのは「提案」であり、編集者はPremiere上で自由に変更できる。
 * ★無音・間・沈黙を理由にカットを入れることは一切しない。
 *
 * @see docs/11-editing-pipeline.md 11.3⑥
 */

import {
  DEFAULT_CAMERA_RULES,
  type CameraRules,
  type CameraShot,
  type CameraSource,
  type LaughterSegment,
  type ShotReason,
  type SpeechSegment,
} from './types.ts';

export interface CameraPlanInput {
  /** 本編の長さ（秒）。 */
  durationSec: number;
  speech: readonly SpeechSegment[];
  laughter?: readonly LaughterSegment[];
  cameras: readonly CameraSource[];
  rules?: Partial<CameraRules>;
}

interface Interval {
  startSec: number;
  endSec: number;
  cameraId: string;
  reason: ShotReason;
  /** 大きいほど優先。重なったときの解決に使う。 */
  priority: number;
}

const PRIORITY = {
  speech: 1,
  overlap: 2,
  laughter: 3,
} as const;

function findWideCamera(cameras: readonly CameraSource[]): CameraSource | undefined {
  return cameras.find((c) => c.kind === 'wide');
}

function findSpeakerCamera(
  cameras: readonly CameraSource[],
  speakerId: string,
): CameraSource | undefined {
  return cameras.find((c) => c.kind === 'closeup' && c.speakerId === speakerId);
}

/** 発話が重なっている区間を抽出する。 */
function findOverlaps(speech: readonly SpeechSegment[]): { startSec: number; endSec: number }[] {
  const overlaps: { startSec: number; endSec: number }[] = [];

  for (let i = 0; i < speech.length; i++) {
    for (let j = i + 1; j < speech.length; j++) {
      const a = speech[i]!;
      const b = speech[j]!;
      if (a.speakerId === b.speakerId) continue;

      const start = Math.max(a.startSec, b.startSec);
      const end = Math.min(a.endSec, b.endSec);
      if (end > start) overlaps.push({ startSec: start, endSec: end });
    }
  }
  return overlaps;
}

/**
 * 優先度つきの区間リストから、重なりのないタイムラインを作る。
 * 後から来た高優先度の区間が、低優先度の区間を上書きする。
 */
function flatten(intervals: Interval[], durationSec: number): Interval[] {
  const boundaries = new Set<number>([0, durationSec]);
  for (const iv of intervals) {
    if (iv.startSec > 0 && iv.startSec < durationSec) boundaries.add(iv.startSec);
    if (iv.endSec > 0 && iv.endSec < durationSec) boundaries.add(iv.endSec);
  }
  const points = [...boundaries].sort((a, b) => a - b);
  const result: Interval[] = [];

  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i]!;
    const end = points[i + 1]!;
    const mid = (start + end) / 2;

    // この区間を覆う候補のうち、最も優先度の高いものを選ぶ。
    let winner: Interval | undefined;
    for (const iv of intervals) {
      if (iv.startSec <= mid && mid < iv.endSec) {
        if (!winner || iv.priority > winner.priority) winner = iv;
      }
    }
    if (winner) {
      result.push({ ...winner, startSec: start, endSec: end });
    } else {
      // 誰も話していない区間。★カットを入れず、直前のカメラを維持する。
      const prev = result[result.length - 1];
      result.push({
        startSec: start,
        endSec: end,
        cameraId: prev?.cameraId ?? '',
        reason: 'hold',
        priority: 0,
      });
    }
  }
  return result;
}

/**
 * 隣接する同一カメラの区間を1ショットに統合する。
 *
 * 統合時は、より優先度の高い理由を残す。1つのショットが複数の理由に
 * またがる場合（同時発話のあと笑いが起きて引きが続くなど）、編集者にとって
 * 情報量の多い理由を見せるため。
 */
function mergeAdjacent(intervals: Interval[]): Interval[] {
  const merged: Interval[] = [];

  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && last.cameraId === iv.cameraId) {
      last.endSec = iv.endSec;
      if (iv.priority > last.priority) {
        last.reason = iv.reason;
        last.priority = iv.priority;
      } else if (last.reason === 'hold' && iv.reason !== 'hold') {
        last.reason = iv.reason;
      }
    } else {
      merged.push({ ...iv });
    }
  }
  return merged;
}

/**
 * 最短ショット長を満たさないショットを前のショットに吸収する。
 * 頻繁な切替（フラッシュカット）を防ぐ。
 */
function enforceMinDuration(intervals: Interval[], minShotSec: number): Interval[] {
  if (intervals.length === 0) return [];
  const result: Interval[] = [{ ...intervals[0]! }];

  for (let i = 1; i < intervals.length; i++) {
    const iv = intervals[i]!;
    const last = result[result.length - 1]!;

    if (iv.endSec - iv.startSec < minShotSec) {
      // 短すぎるショットは前に吸収する。
      last.endSec = iv.endSec;
      if (last.reason !== iv.reason) last.reason = 'merged';
    } else {
      result.push({ ...iv });
    }
  }

  // 先頭が短い場合は次に吸収させる。
  if (result.length > 1 && result[0]!.endSec - result[0]!.startSec < minShotSec) {
    result[1]!.startSec = result[0]!.startSec;
    result.shift();
  }
  return mergeAdjacent(result);
}

/**
 * 発話開始の少し前に切り替える。頭の音が欠けて聞こえるのを防ぐ。
 * 前のショットが最短長を割らない範囲でのみ適用する。
 */
function applyLeadIn(intervals: Interval[], rules: CameraRules): Interval[] {
  const result = intervals.map((iv) => ({ ...iv }));

  for (let i = 1; i < result.length; i++) {
    const cur = result[i]!;
    const prev = result[i - 1]!;
    if (cur.reason === 'hold') continue;

    const shifted = cur.startSec - rules.leadInSec;
    if (shifted - prev.startSec >= rules.minShotSec) {
      cur.startSec = shifted;
      prev.endSec = shifted;
    }
  }
  return result;
}

/**
 * 同一カメラが長く続く箇所に、聞き手側のリアクションカットを挿入する。
 * 単調さを避けるための提案であり、編集者が消しても構わない。
 */
function insertReactionShots(
  intervals: Interval[],
  cameras: readonly CameraSource[],
  speech: readonly SpeechSegment[],
  rules: CameraRules,
): Interval[] {
  const result: Interval[] = [];

  for (const iv of intervals) {
    const length = iv.endSec - iv.startSec;
    if (length <= rules.maxSameCameraSec || iv.reason === 'hold') {
      result.push(iv);
      continue;
    }

    // このショットで話している人以外の寄りカメラを探す。
    const talking = speech.find(
      (s) => s.startSec < iv.endSec && s.endSec > iv.startSec,
    )?.speakerId;
    const listenerCam = cameras.find(
      (c) => c.kind === 'closeup' && c.speakerId !== talking && c.id !== iv.cameraId,
    );

    if (!listenerCam) {
      result.push(iv);
      continue;
    }

    // 中間にリアクションを挟み、前後を元のカメラで挟む。
    const mid = iv.startSec + length / 2;
    const reactionStart = mid - rules.reactionShotSec / 2;
    const reactionEnd = mid + rules.reactionShotSec / 2;

    result.push({ ...iv, endSec: reactionStart });
    result.push({
      startSec: reactionStart,
      endSec: reactionEnd,
      cameraId: listenerCam.id,
      reason: 'reaction',
      priority: iv.priority,
    });
    result.push({ ...iv, startSec: reactionEnd });
  }
  return result;
}

/**
 * カメラ切替案を算出する。
 *
 * 寄りカメラが1台も無い場合は、引き1本の単一ショットを返す（切替できないため）。
 */
export function planCameraSwitches(input: CameraPlanInput): CameraShot[] {
  const rules = { ...DEFAULT_CAMERA_RULES, ...input.rules };
  const wide = findWideCamera(input.cameras);
  const closeups = input.cameras.filter((c) => c.kind === 'closeup');

  const fallbackId = wide?.id ?? input.cameras[0]?.id;
  if (!fallbackId) return [];

  if (closeups.length === 0) {
    return [
      {
        startSec: 0,
        endSec: input.durationSec,
        cameraId: fallbackId,
        reason: 'hold',
      },
    ];
  }

  const intervals: Interval[] = [];

  // 発話 → その人の寄りカメラ。寄りが無ければ引き。
  for (const seg of input.speech) {
    const cam = findSpeakerCamera(input.cameras, seg.speakerId);
    intervals.push({
      startSec: Math.max(0, seg.startSec),
      endSec: Math.min(input.durationSec, seg.endSec),
      cameraId: cam?.id ?? fallbackId,
      reason: 'speech',
      priority: PRIORITY.speech,
    });
  }

  // 同時発話 → 引き（場のやりとりを見せる）。
  if (rules.wideOnOverlap && wide) {
    for (const ov of findOverlaps(input.speech)) {
      intervals.push({
        startSec: ov.startSec,
        endSec: ov.endSec,
        cameraId: wide.id,
        reason: 'overlap',
        priority: PRIORITY.overlap,
      });
    }
  }

  // 笑い → 引き（場の空気を見せる）。削るためではなく活かすため。
  //
  // ★確信度が低い候補はカメラ切替の根拠にしない。笑い検出は補助判定であり、
  // 誤検出でカットが入ると編集者が直す手間が増える。低確信度のものは
  // マーカー（要確認）としてのみ提示し、切替は人の判断に委ねる。
  if (rules.wideOnLaughter && wide) {
    for (const l of input.laughter ?? []) {
      if (
        l.confidence !== undefined &&
        l.confidence < rules.minLaughterConfidence
      ) {
        continue;
      }
      intervals.push({
        startSec: Math.max(0, l.startSec),
        endSec: Math.min(input.durationSec, l.endSec),
        cameraId: wide.id,
        reason: 'laughter',
        priority: PRIORITY.laughter,
      });
    }
  }

  let plan = flatten(intervals, input.durationSec);
  plan = mergeAdjacent(plan);
  plan = enforceMinDuration(plan, rules.minShotSec);
  plan = insertReactionShots(plan, input.cameras, input.speech, rules);
  plan = applyLeadIn(plan, rules);
  plan = mergeAdjacent(plan);

  // 冒頭に有効なカメラが無い場合（発話前の無音）は引きで埋める。
  return plan
    .filter((iv) => iv.endSec > iv.startSec)
    .map(({ startSec, endSec, cameraId, reason }) => ({
      startSec: Number(startSec.toFixed(3)),
      endSec: Number(endSec.toFixed(3)),
      cameraId: cameraId || fallbackId,
      reason,
    }));
}
