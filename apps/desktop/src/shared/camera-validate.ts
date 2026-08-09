/**
 * カメラ切替の変更・追加・削除リクエストの検証。
 *
 * ★Rendererを信用しない。保存はディスクへの書き込みなので、
 * 通す前にここで必ず形を確かめる。fs には触らない純粋な検証。
 *
 * ★この層が特に重い理由（字幕・ショートとの違い）
 * カメラ修正は `generate-premiere-xml` を経て FCP7 XML の V1 トラックに
 * そのまま並ぶ。`build-project.ts`（凍結対象）は次の2つを検査しない：
 *
 * - 存在しない `cameraId` → **`throw new Error('カメラ素材が見つかりません')`**
 *   （＝再出力が XML_GENERATION_FAILED で失敗する）
 * - `endFrame <= startFrame` → **`continue` で黙って捨てられる**
 *   （＝「保存したのにXMLに無い」となり、編集者は理由に気づけない）
 *
 * さらにカット同士の重なりも検査されないため、重なったまま出すと
 * V1 上でクリップが衝突する。**これらはすべてこの層で塞ぐ。**
 */

import type {
  CameraShotPatch,
  DeleteCameraShotRequest,
  InsertCameraShotRequest,
  RemoveCameraEditRequest,
  UpdateCameraShotRequest,
} from './camera-dto.ts';
import type { Validated } from './validate.ts';
import { validateProjectPath } from './validate.ts';
import {
  createIdValidator,
  invalid,
  validateExpectedUpdatedAt,
  validateTimeSec,
} from './validate-common.ts';

/**
 * カットIDの形。`packages/core` の `cameraShotId()` と、
 * この層が採番する挿入カットのIDの両方を通す。
 *
 * ```
 * shot-00024010       解析が作ったカット（cameraShotId）
 * shot-ins-00024010   人が追加したカット（この層が採番）
 * ```
 *
 * ★`shot-ins-` 形式は `packages/core` の `timeFromId()`
 * （`/^[a-z]+(?:-[A-Za-z_]+)?-(\d{8,})(?:-(\d+))?$/`）でも時刻を復元できる。
 * つまり core を変更せずに、孤立時の時刻表示と再接続が従来どおり働く。
 */
const CAMERA_SHOT_ID = /^shot-(?:ins-)?[0-9]{8,12}(?:-[0-9]{1,4})?$/;

/** 挿入カットのID接頭辞。解析側のIDと衝突させないために分ける。 */
export const INSERTED_SHOT_PREFIX = 'shot-ins-';

/**
 * カットの最小長。`packages/editing` の `DEFAULT_CAMERA_RULES.minShotSec`
 * と同じ値。★短すぎるカットは編集として成立しないので保存させない。
 */
export const MIN_CAMERA_SHOT_SEC = 2.5;

/**
 * 重なり・隣接の判定に使う許容誤差（秒）。
 *
 * 秒は浮動小数なので、`endSec === 次のstartSec` を厳密比較すると
 * 「ぴったり隣接しているのに重なり扱い」になりうる。1ms 未満は同一とみなす。
 */
export const TIME_EPSILON = 0.001;

/** 1本の収録に置けるカットの上限。異常な件数でXMLを膨張させないため。 */
export const MAX_CAMERA_SHOTS = 5000;

export const validateCameraShotId = createIdValidator(CAMERA_SHOT_ID, 'カットID');

/**
 * カメラIDの検証。
 *
 * ★`known` には「そのプロジェクトに実在する映像素材の role」を渡す。
 * ここを通さないと、XML生成が例外を投げて再出力ごと失敗する。
 */
export function validateCameraId(
  value: unknown,
  known?: ReadonlySet<string>,
): Validated<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return invalid('カメラが指定されていません。');
  }
  // role は ASSET_ROLES 由来なので英数字とアンダースコアのみ。
  if (!/^[A-Za-z0-9][A-Za-z0-9_]{0,31}$/.test(value)) {
    return invalid('カメラの指定が不正です。');
  }
  if (known !== undefined && !known.has(value)) {
    return invalid(
      'このプロジェクトに存在しないカメラです。',
      '素材登録画面で、その役割の映像素材が登録されているか確認してください。',
    );
  }
  return { ok: true, value };
}

/**
 * カットの区間を検証する。
 *
 * ★`endSec <= startSec` を必ず弾く。通すと `build-project.ts` が
 * `endFrame <= startFrame` で**黙って捨てる**ため、
 * 「保存できたのにXMLに出ない」という気づけない不具合になる。
 */
export function validateShotRange(
  startSec: unknown,
  endSec: unknown,
  options: { maxSec?: number; minShotSec?: number } = {},
): Validated<{ startSec: number; endSec: number }> {
  const start = validateTimeSec(startSec, '開始時刻');
  if (!start.ok) return start;
  const end = validateTimeSec(endSec, '終了時刻');
  if (!end.ok) return end;

  if (end.value <= start.value + TIME_EPSILON) {
    return invalid(
      'カットの終了時刻は開始時刻より後にしてください。',
      '長さが0のカットは書き出し時に消えてしまいます。',
    );
  }

  const minShotSec = options.minShotSec ?? MIN_CAMERA_SHOT_SEC;
  if (end.value - start.value < minShotSec - TIME_EPSILON) {
    return invalid(
      `カットが短すぎます（${(end.value - start.value).toFixed(2)}秒 / 最短${minShotSec}秒）。`,
      '短いカットは切り替わりが速すぎて見づらくなります。',
    );
  }

  if (options.maxSec !== undefined && end.value > options.maxSec + TIME_EPSILON) {
    return invalid(
      `カットが素材の長さ（${options.maxSec.toFixed(2)}秒）を超えています。`,
      '終了時刻を素材の範囲内にしてください。',
    );
  }

  return { ok: true, value: { startSec: start.value, endSec: end.value } };
}

/** 重なりの検査対象。並び順は問わない（この関数が並べ替える）。 */
export interface ShotInterval {
  id: string;
  startSec: number;
  endSec: number;
}

/**
 * カット同士の重なりを検出する。
 *
 * ★`build-project.ts` は重なりを検査せず V1 に並べる。重なったまま出すと
 * Premiere のタイムライン上でクリップが衝突するので、保存前に弾く。
 *
 * 端が接するだけ（前のカットの終わり＝次のカットの始まり）は重なりではない。
 */
export function findOverlaps(
  shots: readonly ShotInterval[],
): { first: ShotInterval; second: ShotInterval }[] {
  const sorted = [...shots].sort(
    (a, b) => a.startSec - b.startSec || a.endSec - b.endSec,
  );
  const overlaps: { first: ShotInterval; second: ShotInterval }[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (cur.startSec < prev.endSec - TIME_EPSILON) {
      overlaps.push({ first: prev, second: cur });
    }
  }
  return overlaps;
}

/**
 * 変更・追加を適用した後の並びに重なりが無いかを確かめる。
 *
 * `shots` には**適用後の全カット**を渡す（呼び出し側が組み立てる）。
 */
export function validateNoOverlap(
  shots: readonly ShotInterval[],
): Validated<true> {
  if (shots.length > MAX_CAMERA_SHOTS) {
    return invalid(`カットが多すぎます（上限${MAX_CAMERA_SHOTS}件）。`);
  }
  const overlaps = findOverlaps(shots);
  if (overlaps.length > 0) {
    const { first, second } = overlaps[0]!;
    return invalid(
      `カットが重なっています（${first.startSec.toFixed(2)}〜${first.endSec.toFixed(2)}秒 と ` +
        `${second.startSec.toFixed(2)}〜${second.endSec.toFixed(2)}秒）。`,
      '重なったまま書き出すとPremiereのタイムラインが崩れます。時刻を調整してください。',
    );
  }
  return { ok: true, value: true };
}

/** 既存カットの変更内容。★時刻は片方だけの変更も許す（もう片方は現在値を使う）。 */
export function validateCameraPatch(
  raw: unknown,
  knownCameras?: ReadonlySet<string>,
): Validated<CameraShotPatch> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('修正内容の形式が不正です。');
  }
  const input = raw as Record<string, unknown>;
  const patch: CameraShotPatch = {};
  let touched = false;

  if ('cameraId' in input && input.cameraId !== undefined) {
    if (input.cameraId === null) {
      patch.cameraId = null;
    } else {
      const camera = validateCameraId(input.cameraId, knownCameras);
      if (!camera.ok) return camera;
      patch.cameraId = camera.value;
    }
    touched = true;
  }

  for (const [key, label] of [
    ['startSec', '開始時刻'],
    ['endSec', '終了時刻'],
  ] as const) {
    if (!(key in input) || input[key] === undefined) continue;
    if (input[key] === null) {
      patch[key] = null;
      touched = true;
      continue;
    }
    // ★ここでは値の妥当性だけを見る。区間としての整合（前後関係・最短長・
    //   他カットとの重なり）は、現在値と突き合わせられる Main 側で確かめる。
    const time = validateTimeSec(input[key], label);
    if (!time.ok) return time;
    patch[key] = time.value;
    touched = true;
  }

  if (!touched) {
    return invalid('修正内容がありません。');
  }
  return { ok: true, value: patch };
}

export function validateUpdateCameraShotRequest(
  raw: unknown,
  knownCameras?: ReadonlySet<string>,
): Validated<UpdateCameraShotRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('保存リクエストの形式が不正です。');
  }
  const input = raw as Record<string, unknown>;

  const path = validateProjectPath(input.projectPath);
  if (!path.ok) return path;

  const shotId = validateCameraShotId(input.shotId);
  if (!shotId.ok) return shotId;

  const expected = validateExpectedUpdatedAt(input.expectedUpdatedAt);
  if (!expected.ok) return expected;

  const patch = validateCameraPatch(input.patch, knownCameras);
  if (!patch.ok) return patch;

  return {
    ok: true,
    value: {
      projectPath: path.value,
      shotId: shotId.value,
      expectedUpdatedAt: expected.value,
      patch: patch.value,
    },
  };
}

/**
 * カットの追加。
 *
 * ★変更と違い、区間は必ず両方そろって届く。ここで完結して検証できるので
 * 最短長・前後関係まで見る（他カットとの重なりは Main 側）。
 */
export function validateInsertCameraShotRequest(
  raw: unknown,
  knownCameras?: ReadonlySet<string>,
  options: { maxSec?: number } = {},
): Validated<InsertCameraShotRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('追加リクエストの形式が不正です。');
  }
  const input = raw as Record<string, unknown>;

  const path = validateProjectPath(input.projectPath);
  if (!path.ok) return path;

  const expected = validateExpectedUpdatedAt(input.expectedUpdatedAt);
  if (!expected.ok) return expected;

  const camera = validateCameraId(input.cameraId, knownCameras);
  if (!camera.ok) return camera;

  const range = validateShotRange(input.startSec, input.endSec, options);
  if (!range.ok) return range;

  // ★`reason` は受け取らない。Main が固定する（Renderer に決めさせない）。
  if ('reason' in input && input.reason !== undefined && input.reason !== null) {
    return invalid(
      'カットの理由は指定できません。',
      '追加したカットの理由は自動で設定されます。',
    );
  }
  // ★IDも受け取らない。採番は Main の責務。
  if ('id' in input && input.id !== undefined && input.id !== null) {
    return invalid('カットIDは指定できません。');
  }

  return {
    ok: true,
    value: {
      projectPath: path.value,
      expectedUpdatedAt: expected.value,
      startSec: range.value.startSec,
      endSec: range.value.endSec,
      cameraId: camera.value,
    },
  };
}

export function validateDeleteCameraShotRequest(
  raw: unknown,
): Validated<DeleteCameraShotRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('削除リクエストの形式が不正です。');
  }
  const input = raw as Record<string, unknown>;

  const path = validateProjectPath(input.projectPath);
  if (!path.ok) return path;

  const shotId = validateCameraShotId(input.shotId);
  if (!shotId.ok) return shotId;

  const expected = validateExpectedUpdatedAt(input.expectedUpdatedAt);
  if (!expected.ok) return expected;

  return {
    ok: true,
    value: {
      projectPath: path.value,
      shotId: shotId.value,
      expectedUpdatedAt: expected.value,
    },
  };
}

export function validateRemoveCameraEditRequest(
  raw: unknown,
): Validated<RemoveCameraEditRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('リクエストの形式が不正です。');
  }
  const input = raw as Record<string, unknown>;

  const path = validateProjectPath(input.projectPath);
  if (!path.ok) return path;

  const shotId = validateCameraShotId(input.shotId);
  if (!shotId.ok) return shotId;

  const expected = validateExpectedUpdatedAt(input.expectedUpdatedAt);
  if (!expected.ok) return expected;

  return {
    ok: true,
    value: {
      projectPath: path.value,
      shotId: shotId.value,
      expectedUpdatedAt: expected.value,
    },
  };
}
