/**
 * カメラ切替の変更・追加・削除リクエストの検証。
 *
 * ★このテストの主眼は「FCP7 XML を壊すデータを保存経路へ通さない」こと。
 * `build-project.ts`（凍結対象）は次を検査しないため、ここが最後の砦になる：
 * - 存在しない cameraId → XML生成が throw する
 * - endSec <= startSec  → 黙って捨てられる（保存できたのにXMLに出ない）
 * - カット同士の重なり  → V1トラック上でクリップが衝突する
 */

import { describe, expect, it } from 'vitest';

import {
  findOverlaps,
  INSERTED_SHOT_PREFIX,
  MAX_CAMERA_SHOTS,
  MIN_CAMERA_SHOT_SEC,
  validateCameraId,
  validateCameraPatch,
  validateCameraShotId,
  validateDeleteCameraShotRequest,
  validateInsertCameraShotRequest,
  validateNoOverlap,
  validateRemoveCameraEditRequest,
  validateShotRange,
  validateUpdateCameraShotRequest,
} from './camera-validate.ts';

const PATH = '/Users/someone/projects/ep012';
const UPDATED_AT = '2026-08-04T10:00:00.000Z';
const CAMERAS = new Set(['wide', 'cam_A', 'cam_B']);

function ok<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok: ${JSON.stringify(result.error)}`);
  return result.value;
}

function errorMessage(result: { ok: boolean; error?: { userMessage: string } }): string {
  if (result.ok) throw new Error('expected failure');
  return result.error!.userMessage;
}

function shot(id: string, startSec: number, endSec: number) {
  return { id, startSec, endSec };
}

describe('validateCameraShotId', () => {
  it('解析が作ったIDを通す', () => {
    expect(ok(validateCameraShotId('shot-00024010'))).toBe('shot-00024010');
    expect(ok(validateCameraShotId('shot-000240100'))).toBe('shot-000240100');
  });

  it('★人が追加したカットのID（shot-ins-）を通す', () => {
    expect(ok(validateCameraShotId('shot-ins-00024010'))).toBe('shot-ins-00024010');
  });

  it('連番付きも通す（同時刻が生じた場合の予備）', () => {
    expect(ok(validateCameraShotId('shot-00024010-2'))).toBe('shot-00024010-2');
  });

  it('形式外を拒否する', () => {
    for (const bad of [
      'shot-1234', // 8桁未満
      'shot-',
      'shots-00024010',
      'sub-00020960', // 字幕IDを渡された場合
      'short_01', // ショートIDを渡された場合
      'shot-00024010; rm -rf /',
      '../../etc/passwd',
      '',
      42,
      null,
      undefined,
      {},
    ]) {
      expect(validateCameraShotId(bad).ok).toBe(false);
    }
  });
});

describe('★validateCameraId — XML生成が throw しないための砦', () => {
  it('プロジェクトに実在するカメラを通す', () => {
    expect(ok(validateCameraId('wide', CAMERAS))).toBe('wide');
    expect(ok(validateCameraId('cam_A', CAMERAS))).toBe('cam_A');
  });

  it('★実在しないカメラを拒否する（通すと再出力が失敗する）', () => {
    const message = errorMessage(validateCameraId('cam_Z', CAMERAS));
    expect(message).toContain('存在しないカメラ');
  });

  it('★マイクの role を拒否する（映像素材ではない）', () => {
    expect(validateCameraId('mic_A', CAMERAS).ok).toBe(false);
  });

  it('形式が不正な値を拒否する', () => {
    for (const bad of ['', 'cam A', 'cam-A!', '../wide', 'a'.repeat(40), 1, null, {}]) {
      expect(validateCameraId(bad, CAMERAS).ok).toBe(false);
    }
  });

  it('known を渡さなければ形式だけを見る', () => {
    expect(validateCameraId('cam_Z').ok).toBe(true);
  });
});

describe('★validateShotRange — 黙って捨てられる区間を弾く', () => {
  it('妥当な区間を通す', () => {
    expect(ok(validateShotRange(10, 20))).toEqual({ startSec: 10, endSec: 20 });
  });

  it('★ゼロ長を拒否する（build-project が黙って捨てるため）', () => {
    const message = errorMessage(validateShotRange(10, 10));
    expect(message).toContain('終了時刻は開始時刻より後');
  });

  it('★逆転した区間を拒否する', () => {
    expect(validateShotRange(20, 10).ok).toBe(false);
  });

  it('★1ms未満の差も「長さ0」として拒否する', () => {
    expect(validateShotRange(10, 10.0005).ok).toBe(false);
  });

  it('★最短ショット長を下回る区間を拒否する', () => {
    const message = errorMessage(validateShotRange(10, 10 + MIN_CAMERA_SHOT_SEC - 0.5));
    expect(message).toContain('短すぎます');
  });

  it('最短ちょうどは通す', () => {
    expect(validateShotRange(10, 10 + MIN_CAMERA_SHOT_SEC).ok).toBe(true);
  });

  it('minShotSec を明示すればそれに従う', () => {
    expect(validateShotRange(10, 11, { minShotSec: 1 }).ok).toBe(true);
    expect(validateShotRange(10, 11, { minShotSec: 5 }).ok).toBe(false);
  });

  it('★素材の尺を超える区間を拒否する', () => {
    const message = errorMessage(validateShotRange(10, 50, { maxSec: 40 }));
    expect(message).toContain('素材の長さ');
  });

  it('素材の尺ちょうどは通す', () => {
    expect(validateShotRange(10, 40, { maxSec: 40 }).ok).toBe(true);
  });

  it('負の値・非数値を拒否する', () => {
    expect(validateShotRange(-1, 10).ok).toBe(false);
    expect(validateShotRange(0, Number.NaN).ok).toBe(false);
    expect(validateShotRange('0', '10').ok).toBe(false);
  });
});

describe('★findOverlaps / validateNoOverlap — V1トラックの衝突を防ぐ', () => {
  it('重なりが無ければ空', () => {
    expect(findOverlaps([shot('a', 0, 10), shot('b', 10, 20)])).toEqual([]);
  });

  it('★端が接するだけは重なりにしない（連続したカットは正常）', () => {
    expect(validateNoOverlap([shot('a', 0, 10), shot('b', 10, 20)]).ok).toBe(true);
  });

  it('★1ms未満の差は重なりにしない（浮動小数の誤差）', () => {
    expect(validateNoOverlap([shot('a', 0, 10), shot('b', 9.9995, 20)]).ok).toBe(true);
  });

  it('★明確に重なっていれば拒否する', () => {
    const message = errorMessage(
      validateNoOverlap([shot('a', 0, 10), shot('b', 5, 20)]),
    );
    expect(message).toContain('重なっています');
  });

  it('★入力の並び順に依存しない', () => {
    expect(validateNoOverlap([shot('b', 5, 20), shot('a', 0, 10)]).ok).toBe(false);
  });

  it('★包含関係も重なりとして検出する', () => {
    expect(validateNoOverlap([shot('a', 0, 30), shot('b', 5, 10)]).ok).toBe(false);
  });

  it('隙間があるのは許す（意図的な間の可能性がある）', () => {
    expect(validateNoOverlap([shot('a', 0, 10), shot('b', 15, 20)]).ok).toBe(true);
  });

  it('0件・1件は常に通る', () => {
    expect(validateNoOverlap([]).ok).toBe(true);
    expect(validateNoOverlap([shot('a', 0, 10)]).ok).toBe(true);
  });

  it('★件数が多すぎたら拒否する', () => {
    const many = Array.from({ length: MAX_CAMERA_SHOTS + 1 }, (_, i) =>
      shot(`s${i}`, i * 10, i * 10 + 5),
    );
    expect(errorMessage(validateNoOverlap(many))).toContain('多すぎます');
  });
});

describe('validateCameraPatch', () => {
  it('カメラの変更を通す', () => {
    expect(ok(validateCameraPatch({ cameraId: 'cam_B' }, CAMERAS)).cameraId).toBe('cam_B');
  });

  it('時刻の変更を通す（片方だけでもよい）', () => {
    expect(ok(validateCameraPatch({ startSec: 12.5 }, CAMERAS)).startSec).toBe(12.5);
    expect(ok(validateCameraPatch({ endSec: 30 }, CAMERAS)).endSec).toBe(30);
  });

  it('null は「解析値に戻す」として通す', () => {
    const patch = ok(validateCameraPatch({ cameraId: null, startSec: null }, CAMERAS));
    expect(patch.cameraId).toBeNull();
    expect(patch.startSec).toBeNull();
  });

  it('★実在しないカメラを拒否する', () => {
    expect(validateCameraPatch({ cameraId: 'cam_Z' }, CAMERAS).ok).toBe(false);
  });

  it('不正な時刻を拒否する', () => {
    expect(validateCameraPatch({ startSec: -5 }, CAMERAS).ok).toBe(false);
    expect(validateCameraPatch({ endSec: 'abc' }, CAMERAS).ok).toBe(false);
  });

  it('中身が何も無ければ拒否する', () => {
    expect(errorMessage(validateCameraPatch({}, CAMERAS))).toContain('修正内容がありません');
    expect(validateCameraPatch(null, CAMERAS).ok).toBe(false);
    expect(validateCameraPatch('cam_A', CAMERAS).ok).toBe(false);
  });

  it('未知のキーだけなら「内容がない」として拒否する', () => {
    expect(validateCameraPatch({ reason: 'speech' }, CAMERAS).ok).toBe(false);
  });
});

describe('validateUpdateCameraShotRequest', () => {
  const base = {
    projectPath: PATH,
    shotId: 'shot-00024010',
    expectedUpdatedAt: UPDATED_AT,
    patch: { cameraId: 'cam_B' },
  };

  it('正しいリクエストを通す', () => {
    const value = ok(validateUpdateCameraShotRequest(base, CAMERAS));
    expect(value.shotId).toBe('shot-00024010');
    expect(value.patch.cameraId).toBe('cam_B');
  });

  it('相対パスを拒否する', () => {
    expect(
      validateUpdateCameraShotRequest({ ...base, projectPath: '../ep012' }, CAMERAS).ok,
    ).toBe(false);
  });

  it('不正なカットIDを拒否する', () => {
    expect(
      validateUpdateCameraShotRequest({ ...base, shotId: 'shot-x' }, CAMERAS).ok,
    ).toBe(false);
  });

  it('★expectedUpdatedAt が無い・形式違いなら拒否する（競合検出を外させない）', () => {
    expect(
      validateUpdateCameraShotRequest({ ...base, expectedUpdatedAt: '' }, CAMERAS).ok,
    ).toBe(false);
    expect(
      validateUpdateCameraShotRequest(
        { ...base, expectedUpdatedAt: '2026/08/04' },
        CAMERAS,
      ).ok,
    ).toBe(false);
  });

  it('オブジェクト以外を拒否する', () => {
    expect(validateUpdateCameraShotRequest(null, CAMERAS).ok).toBe(false);
    expect(validateUpdateCameraShotRequest('shot-00024010', CAMERAS).ok).toBe(false);
  });
});

describe('validateInsertCameraShotRequest', () => {
  const base = {
    projectPath: PATH,
    expectedUpdatedAt: UPDATED_AT,
    startSec: 10,
    endSec: 20,
    cameraId: 'cam_A',
  };

  it('正しいリクエストを通す', () => {
    const value = ok(validateInsertCameraShotRequest(base, CAMERAS));
    expect(value).toEqual({
      projectPath: PATH,
      expectedUpdatedAt: UPDATED_AT,
      startSec: 10,
      endSec: 20,
      cameraId: 'cam_A',
    });
  });

  it('★ゼロ長・短すぎる区間を拒否する', () => {
    expect(validateInsertCameraShotRequest({ ...base, endSec: 10 }, CAMERAS).ok).toBe(false);
    expect(validateInsertCameraShotRequest({ ...base, endSec: 11 }, CAMERAS).ok).toBe(false);
  });

  it('★実在しないカメラを拒否する', () => {
    expect(
      validateInsertCameraShotRequest({ ...base, cameraId: 'cam_Z' }, CAMERAS).ok,
    ).toBe(false);
  });

  it('★素材の尺を超える追加を拒否する', () => {
    expect(
      validateInsertCameraShotRequest(base, CAMERAS, { maxSec: 15 }).ok,
    ).toBe(false);
  });

  it('★reason は指定させない（Mainが固定する）', () => {
    const message = errorMessage(
      validateInsertCameraShotRequest({ ...base, reason: 'speech' }, CAMERAS),
    );
    expect(message).toContain('理由は指定できません');
  });

  it('★IDも指定させない（採番はMainの責務）', () => {
    expect(
      validateInsertCameraShotRequest({ ...base, id: 'shot-00010000' }, CAMERAS).ok,
    ).toBe(false);
  });

  it('パス・updatedAt の不正を拒否する', () => {
    expect(
      validateInsertCameraShotRequest({ ...base, projectPath: 'rel' }, CAMERAS).ok,
    ).toBe(false);
    expect(
      validateInsertCameraShotRequest({ ...base, expectedUpdatedAt: 'x' }, CAMERAS).ok,
    ).toBe(false);
    expect(validateInsertCameraShotRequest(undefined, CAMERAS).ok).toBe(false);
  });
});

describe('validateDeleteCameraShotRequest / validateRemoveCameraEditRequest', () => {
  const base = {
    projectPath: PATH,
    shotId: 'shot-00024010',
    expectedUpdatedAt: UPDATED_AT,
  };

  it('正しいリクエストを通す', () => {
    expect(ok(validateDeleteCameraShotRequest(base)).shotId).toBe('shot-00024010');
    expect(ok(validateRemoveCameraEditRequest(base)).shotId).toBe('shot-00024010');
  });

  it('挿入カットのIDも通す（追加したカットは削除・取り消しの対象）', () => {
    const id = `${INSERTED_SHOT_PREFIX}00024010`;
    expect(ok(validateDeleteCameraShotRequest({ ...base, shotId: id })).shotId).toBe(id);
    expect(ok(validateRemoveCameraEditRequest({ ...base, shotId: id })).shotId).toBe(id);
  });

  it('不正な値を拒否する', () => {
    for (const bad of [
      { ...base, projectPath: 'ep012' },
      { ...base, shotId: 'x' },
      { ...base, expectedUpdatedAt: 1 },
      null,
      undefined,
      'shot-00024010',
    ]) {
      expect(validateDeleteCameraShotRequest(bad).ok).toBe(false);
      expect(validateRemoveCameraEditRequest(bad).ok).toBe(false);
    }
  });
});
