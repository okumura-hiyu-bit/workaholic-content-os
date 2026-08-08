/**
 * マーカーの修正・削除リクエストの検証。
 *
 * ★Rendererを信用しない。保存はディスクへの書き込みなので、
 * 通す前にここで必ず形を確かめる。fs には触らない純粋な検証。
 *
 * ★カメラ切替のような重い整合性チェックは要らない
 * `build-project.ts` の `toFcp7Markers` は throw もせず、条件付きで捨てもしない
 * （`escapeXml` が全出力に掛かる）。マーカー同士も干渉しない。
 * そのため、ここが見るのは「長さ・制御文字・未対応項目」だけでよい。
 */

import type {
  DeleteMarkerRequest,
  MarkerPatch,
  RemoveMarkerEditRequest,
  UpdateMarkerRequest,
} from './marker-dto.ts';
import type { Validated } from './validate.ts';
import { validateProjectPath } from './validate.ts';
import {
  invalid,
  validateExpectedUpdatedAt,
  validateMultiLineText,
  validateSingleLineText,
  validateTimeSec,
} from './validate-common.ts';

/** マーカー名の上限。Premiereのマーカー名に出るので短めにする。 */
export const MAX_MARKER_NAME_LENGTH = 120;
/** コメントの上限。選定理由・引用が入るので長めに取る。 */
export const MAX_MARKER_COMMENT_LENGTH = 2000;

/**
 * マーカーIDの形。★2系統あるので両方を通す。
 *
 * `generate-markers.ts` の採番（実データで採取して確認）：
 *
 * ```
 * mk-TOPIC-00000000              markerId(kind, startSec)。時刻キー
 * mk-LAUGH-00033990              同上
 * mk-CHECK-check-lowconf-7700    mk-CHECK-${check.id}。★時刻を含まない
 * mk-CHECK-check-sync-camA       同上（assetIdが入る）
 * ```
 *
 * ★後者は `timeFromId()` が `undefined` を返すため再接続できず、
 * 再解析すると修正が必ず孤立する。その事実は DTO の `volatileId` で示す。
 * 検証としては「安全な文字だけで構成されているか」を見る。
 *
 * パス断片・コマンドとして解釈されうる文字（`/` `\` `.` `;` 空白等）は通さない。
 */
const MARKER_ID = /^mk-[A-Z]{2,12}-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function validateMarkerId(value: unknown): Validated<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return invalid('マーカーIDが指定されていません。');
  }
  if (!MARKER_ID.test(value)) {
    return invalid('マーカーIDの形式が不正です。');
  }
  return { ok: true, value };
}

/**
 * マーカーの修正内容。
 *
 * ★`name` は空を拒否し、`comment` は空を許す。
 * `resolve.ts` が `edit?.name ?? marker.name` で解決するため、空文字を保存すると
 * 「空にしたつもりが解析値に戻る」紛らわしい状態になる。名前を消したいときは
 * 修正の取り消しへ誘導する。コメントは補足情報なので、意図的に空にしたい
 * 場合があり、空文字のまま保存して差し支えない。
 */
export function validateMarkerPatch(raw: unknown): Validated<MarkerPatch> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('修正内容の形式が不正です。');
  }
  const input = raw as Record<string, unknown>;
  const patch: MarkerPatch = {};
  let touched = false;

  if ('name' in input && input.name !== undefined) {
    if (input.name === null) {
      patch.name = null;
    } else {
      const name = validateSingleLineText(input.name, 'マーカー名', MAX_MARKER_NAME_LENGTH);
      if (!name.ok) return name;
      if (name.value.length === 0) {
        return invalid(
          'マーカー名が空です。',
          '空にしたい場合は修正を取り消してください（解析結果の名前に戻ります）。',
        );
      }
      patch.name = name.value;
    }
    touched = true;
  }

  if ('comment' in input && input.comment !== undefined) {
    if (input.comment === null) {
      patch.comment = null;
    } else {
      const comment = validateMultiLineText(
        input.comment,
        'コメント',
        MAX_MARKER_COMMENT_LENGTH,
      );
      if (!comment.ok) return comment;
      // ★空文字はそのまま保存する（name と違い、消したい正当な理由がある）。
      patch.comment = comment.value;
    }
    touched = true;
  }

  // ★時刻・種別の編集は未対応。値が妥当でも受け付けない。
  // 黙って無視すると「直したのに反映されない」になるため、明示的に断る。
  for (const [key, label] of [
    ['startSec', '開始時刻'],
    ['endSec', '終了時刻'],
  ] as const) {
    if (input[key] !== undefined && input[key] !== null) {
      const time = validateTimeSec(input[key], label);
      if (!time.ok) return time;
      return invalid(
        'マーカーの時刻の編集は未対応です。',
        '名前とコメントの修正のみ保存できます。',
      );
    }
  }
  if (input.kind !== undefined && input.kind !== null) {
    return invalid(
      'マーカーの種類の変更は未対応です。',
      '名前とコメントの修正のみ保存できます。',
    );
  }

  if (!touched) {
    return invalid('修正内容がありません。');
  }
  return { ok: true, value: patch };
}

export function validateUpdateMarkerRequest(
  raw: unknown,
): Validated<UpdateMarkerRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('保存リクエストの形式が不正です。');
  }
  const input = raw as Record<string, unknown>;

  const path = validateProjectPath(input.projectPath);
  if (!path.ok) return path;

  const markerId = validateMarkerId(input.markerId);
  if (!markerId.ok) return markerId;

  const expected = validateExpectedUpdatedAt(input.expectedUpdatedAt);
  if (!expected.ok) return expected;

  const patch = validateMarkerPatch(input.patch);
  if (!patch.ok) return patch;

  return {
    ok: true,
    value: {
      projectPath: path.value,
      markerId: markerId.value,
      expectedUpdatedAt: expected.value,
      patch: patch.value,
    },
  };
}

export function validateDeleteMarkerRequest(
  raw: unknown,
): Validated<DeleteMarkerRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('削除リクエストの形式が不正です。');
  }
  const input = raw as Record<string, unknown>;

  const path = validateProjectPath(input.projectPath);
  if (!path.ok) return path;

  const markerId = validateMarkerId(input.markerId);
  if (!markerId.ok) return markerId;

  const expected = validateExpectedUpdatedAt(input.expectedUpdatedAt);
  if (!expected.ok) return expected;

  return {
    ok: true,
    value: {
      projectPath: path.value,
      markerId: markerId.value,
      expectedUpdatedAt: expected.value,
    },
  };
}

export function validateRemoveMarkerEditRequest(
  raw: unknown,
): Validated<RemoveMarkerEditRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('リクエストの形式が不正です。');
  }
  const input = raw as Record<string, unknown>;

  const path = validateProjectPath(input.projectPath);
  if (!path.ok) return path;

  const markerId = validateMarkerId(input.markerId);
  if (!markerId.ok) return markerId;

  const expected = validateExpectedUpdatedAt(input.expectedUpdatedAt);
  if (!expected.ok) return expected;

  return {
    ok: true,
    value: {
      projectPath: path.value,
      markerId: markerId.value,
      expectedUpdatedAt: expected.value,
    },
  };
}
