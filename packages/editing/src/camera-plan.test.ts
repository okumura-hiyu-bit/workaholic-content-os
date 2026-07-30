import { describe, expect, it } from 'vitest';

import { planCameraSwitches } from './camera-plan.ts';
import type { CameraSource, LaughterSegment, SpeechSegment } from './types.ts';

const CAMERAS: CameraSource[] = [
  { id: 'wide', kind: 'wide', file: 'wide.mp4', syncOffsetSec: 0 },
  { id: 'cam_A', kind: 'closeup', speakerId: 'A', file: 'cam_A.mp4', syncOffsetSec: 1.2 },
  { id: 'cam_B', kind: 'closeup', speakerId: 'B', file: 'cam_B.mp4', syncOffsetSec: -0.4 },
];

/** 3人目を加えた構成。出演者数の上限を持たないことの確認に使う。 */
const CAMERAS_3: CameraSource[] = [
  ...CAMERAS,
  { id: 'cam_C', kind: 'closeup', speakerId: 'C', file: 'cam_C.mp4', syncOffsetSec: 0.8 },
];

function speech(
  parts: [number, number, string][],
): SpeechSegment[] {
  return parts.map(([startSec, endSec, speakerId]) => ({
    startSec,
    endSec,
    speakerId,
    text: '…',
  }));
}

/** 連続性の検査：隙間も重複もないこと。 */
function assertContinuous(shots: { startSec: number; endSec: number }[], durationSec: number) {
  expect(shots[0]!.startSec).toBeCloseTo(0, 3);
  expect(shots[shots.length - 1]!.endSec).toBeCloseTo(durationSec, 3);
  for (let i = 1; i < shots.length; i++) {
    expect(shots[i]!.startSec).toBeCloseTo(shots[i - 1]!.endSec, 3);
  }
}

describe('planCameraSwitches — 基本動作', () => {
  it('話している人の寄りカメラに切り替える', () => {
    const shots = planCameraSwitches({
      durationSec: 30,
      speech: speech([
        [0, 10, 'A'],
        [10, 20, 'B'],
        [20, 30, 'A'],
      ]),
      cameras: CAMERAS,
    });

    expect(shots.map((s) => s.cameraId)).toEqual(['cam_A', 'cam_B', 'cam_A']);
    assertContinuous(shots, 30);
  });

  it('タイムラインに隙間も重複もない', () => {
    const shots = planCameraSwitches({
      durationSec: 60,
      speech: speech([
        [2, 9, 'A'],
        [12, 19, 'B'],
        [25, 40, 'A'],
        [45, 58, 'B'],
      ]),
      cameras: CAMERAS,
    });
    assertContinuous(shots, 60);
  });

  it('各ショットに理由が付いている（編集者が判断できるように）', () => {
    const shots = planCameraSwitches({
      durationSec: 30,
      speech: speech([[0, 15, 'A'], [15, 30, 'B']]),
      cameras: CAMERAS,
    });
    for (const shot of shots) {
      expect(shot.reason).toBeTruthy();
    }
  });
});

describe('planCameraSwitches — 間を埋めるための切替をしない', () => {
  it('誰も話していない区間では直前のカメラを維持する（★切らない）', () => {
    const shots = planCameraSwitches({
      durationSec: 30,
      speech: speech([
        [0, 8, 'A'],
        // 8〜20秒は無音（間）。ここでカメラを切ってはならない。
        [20, 30, 'A'],
      ]),
      cameras: CAMERAS,
      // リアクションカットは別の機能。無音の扱いだけを検証するため無効化する。
      rules: { maxSameCameraSec: 999 },
    });

    // 全区間が cam_A のまま。無音を境にショットが分割されない。
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ startSec: 0, endSec: 30, cameraId: 'cam_A' });
  });

  it('長い間があっても、その前後で話者が同じならカットが増えない', () => {
    const shots = planCameraSwitches({
      durationSec: 120,
      speech: speech([
        [0, 10, 'A'],
        [60, 70, 'A'],
        [110, 120, 'A'],
      ]),
      cameras: CAMERAS,
    });
    // リアクションカットは入りうるが、無音を理由にした分割は起きない。
    const holdSplits = shots.filter((s) => s.reason === 'hold');
    expect(holdSplits.length).toBeLessThanOrEqual(1);
  });
});

describe('planCameraSwitches — 引きへの切り替え', () => {
  it('同時発話では引きに切り替える', () => {
    const shots = planCameraSwitches({
      durationSec: 30,
      speech: speech([
        [0, 16, 'A'],
        [12, 30, 'B'],
      ]),
      cameras: CAMERAS,
    });
    expect(shots.some((s) => s.cameraId === 'wide' && s.reason === 'overlap')).toBe(true);
  });

  it('笑いでは引きに切り替える（場の空気を見せるため）', () => {
    const laughter: LaughterSegment[] = [{ startSec: 10, endSec: 14 }];
    const shots = planCameraSwitches({
      durationSec: 40,
      speech: speech([[0, 10, 'A'], [16, 40, 'B']]),
      laughter,
      cameras: CAMERAS,
    });
    expect(shots.some((s) => s.cameraId === 'wide' && s.reason === 'laughter')).toBe(true);
  });

  it('笑いは同時発話より優先される', () => {
    const shots = planCameraSwitches({
      durationSec: 40,
      speech: speech([[0, 20, 'A'], [5, 40, 'B']]),
      laughter: [{ startSec: 8, endSec: 15 }],
      cameras: CAMERAS,
    });
    const at10 = shots.find((s) => s.startSec <= 10 && 10 < s.endSec);
    expect(at10?.reason).toBe('laughter');
  });

  it('★確信度が低い笑いではカメラを切り替えない（補助判定に留める）', () => {
    const shots = planCameraSwitches({
      durationSec: 40,
      speech: speech([[0, 20, 'A'], [20, 40, 'B']]),
      laughter: [{ startSec: 8, endSec: 14, confidence: 0.3 }],
      cameras: CAMERAS,
      rules: { maxSameCameraSec: 999 },
    });
    expect(shots.every((s) => s.reason !== 'laughter')).toBe(true);
  });

  it('確信度が十分な笑いでは切り替える', () => {
    const shots = planCameraSwitches({
      durationSec: 40,
      speech: speech([[0, 20, 'A'], [20, 40, 'B']]),
      laughter: [{ startSec: 8, endSec: 14, confidence: 0.8 }],
      cameras: CAMERAS,
      rules: { maxSameCameraSec: 999 },
    });
    expect(shots.some((s) => s.reason === 'laughter')).toBe(true);
  });

  it('確信度が未設定なら信頼できるものとして扱う（文字起こし由来など）', () => {
    const shots = planCameraSwitches({
      durationSec: 40,
      speech: speech([[0, 20, 'A'], [20, 40, 'B']]),
      laughter: [{ startSec: 8, endSec: 14 }],
      cameras: CAMERAS,
      rules: { maxSameCameraSec: 999 },
    });
    expect(shots.some((s) => s.reason === 'laughter')).toBe(true);
  });

  it('確信度のしきい値を変えられる', () => {
    const shots = planCameraSwitches({
      durationSec: 40,
      speech: speech([[0, 20, 'A'], [20, 40, 'B']]),
      laughter: [{ startSec: 8, endSec: 14, confidence: 0.3 }],
      cameras: CAMERAS,
      rules: { maxSameCameraSec: 999, minLaughterConfidence: 0.2 },
    });
    expect(shots.some((s) => s.reason === 'laughter')).toBe(true);
  });

  it('ルールで引きへの切り替えを無効にできる', () => {
    const shots = planCameraSwitches({
      durationSec: 40,
      speech: speech([[0, 20, 'A'], [20, 40, 'B']]),
      laughter: [{ startSec: 10, endSec: 14 }],
      cameras: CAMERAS,
      rules: { wideOnLaughter: false, wideOnOverlap: false, maxSameCameraSec: 999 },
    });
    expect(shots.every((s) => s.cameraId !== 'wide')).toBe(true);
  });
});

describe('planCameraSwitches — 最短ショット長', () => {
  it('短すぎるショットを作らない（フラッシュカットの防止）', () => {
    const shots = planCameraSwitches({
      durationSec: 60,
      // 0.5秒ずつ交互に話す状況
      speech: speech([
        [0, 10, 'A'],
        [10, 10.5, 'B'],
        [10.5, 11, 'A'],
        [11, 11.5, 'B'],
        [11.5, 60, 'A'],
      ]),
      cameras: CAMERAS,
      rules: { maxSameCameraSec: 999 },
    });

    for (const shot of shots) {
      expect(shot.endSec - shot.startSec).toBeGreaterThanOrEqual(2.4);
    }
  });

  it('最短ショット長を設定で変更できる', () => {
    const shots = planCameraSwitches({
      durationSec: 30,
      speech: speech([[0, 4, 'A'], [4, 8, 'B'], [8, 30, 'A']]),
      cameras: CAMERAS,
      rules: { minShotSec: 5, maxSameCameraSec: 999 },
    });
    for (const shot of shots) {
      expect(shot.endSec - shot.startSec).toBeGreaterThanOrEqual(4.9);
    }
  });
});

describe('planCameraSwitches — リアクションカット', () => {
  it('同一カメラが長く続く箇所にリアクションを挿入する', () => {
    const shots = planCameraSwitches({
      durationSec: 90,
      speech: speech([[0, 90, 'A']]),
      cameras: CAMERAS,
      rules: { maxSameCameraSec: 20, reactionShotSec: 2 },
    });
    expect(shots.some((s) => s.reason === 'reaction')).toBe(true);
    assertContinuous(shots, 90);
  });

  it('リアクションには話していない人のカメラを使う', () => {
    const shots = planCameraSwitches({
      durationSec: 90,
      speech: speech([[0, 90, 'A']]),
      cameras: CAMERAS,
      rules: { maxSameCameraSec: 20 },
    });
    const reaction = shots.find((s) => s.reason === 'reaction');
    expect(reaction?.cameraId).not.toBe('cam_A');
    expect(reaction?.cameraId).toBe('cam_B');
  });

  it('リアクションを無効化できる', () => {
    const shots = planCameraSwitches({
      durationSec: 90,
      speech: speech([[0, 90, 'A']]),
      cameras: CAMERAS,
      rules: { maxSameCameraSec: 999 },
    });
    expect(shots.every((s) => s.reason !== 'reaction')).toBe(true);
  });
});

describe('planCameraSwitches — 出演者数への対応', () => {
  it('3人でもそれぞれのカメラに切り替える', () => {
    const shots = planCameraSwitches({
      durationSec: 45,
      speech: speech([
        [0, 15, 'A'],
        [15, 30, 'B'],
        [30, 45, 'C'],
      ]),
      cameras: CAMERAS_3,
    });
    const used = new Set(shots.map((s) => s.cameraId));
    expect(used.has('cam_A')).toBe(true);
    expect(used.has('cam_B')).toBe(true);
    expect(used.has('cam_C')).toBe(true);
  });

  it('寄りカメラが無い話者は引きで見せる', () => {
    const shots = planCameraSwitches({
      durationSec: 30,
      speech: speech([[0, 15, 'A'], [15, 30, 'Z']]),
      cameras: CAMERAS,
      rules: { maxSameCameraSec: 999 },
    });
    const at20 = shots.find((s) => s.startSec <= 20 && 20 < s.endSec);
    expect(at20?.cameraId).toBe('wide');
  });
});

describe('planCameraSwitches — 端の条件', () => {
  it('寄りカメラが1台も無ければ引き1本を返す', () => {
    const shots = planCameraSwitches({
      durationSec: 30,
      speech: speech([[0, 30, 'A']]),
      cameras: [CAMERAS[0]!],
    });
    expect(shots).toEqual([
      { startSec: 0, endSec: 30, cameraId: 'wide', reason: 'hold' },
    ]);
  });

  it('カメラが無ければ空を返す', () => {
    expect(
      planCameraSwitches({ durationSec: 30, speech: [], cameras: [] }),
    ).toEqual([]);
  });

  it('発話が無くても全区間を埋める', () => {
    const shots = planCameraSwitches({
      durationSec: 30,
      speech: [],
      cameras: CAMERAS,
    });
    assertContinuous(shots, 30);
  });

  it('発話が尺をはみ出しても範囲内に収める', () => {
    const shots = planCameraSwitches({
      durationSec: 20,
      speech: speech([[-5, 25, 'A']]),
      cameras: CAMERAS,
      rules: { maxSameCameraSec: 999 },
    });
    assertContinuous(shots, 20);
    expect(shots[0]!.startSec).toBe(0);
  });
});
