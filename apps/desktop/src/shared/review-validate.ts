/**
 * 字幕修正リクエストの検証。
 *
 * ★Rendererを信用しない。保存はディスクへの書き込みなので、
 * 通す前にここで必ず形を確かめる。fs には触らない純粋な検証。
 */

import type {
  RemoveSubtitleEditRequest,
  SubtitleEditPatch,
  UpdateSubtitleEditRequest,
} from './review-dto.ts';
import type { Validated } from './validate.ts';
import { validateProjectPath } from './validate.ts';
import {
  CONTROL_CHARS,
  createIdValidator,
  invalid,
  validateExpectedUpdatedAt,
  validateTimeSec,
} from './validate-common.ts';

/** 字幕本文の上限。1キューは2行程度が前提なので、余裕を見てこの長さで頭打ちにする。 */
export const MAX_SUBTITLE_LENGTH = 500;
/** 1キューの最大行数。 */
export const MAX_SUBTITLE_LINES = 8;

/**
 * 字幕IDの形。`packages/core` の `subtitleId()` に合わせる。
 *
 * ```
 * sub-00020960        通常
 * sub-00020960-2      同じ開始時刻の2件目（連番付き）
 * sub-00020960-12     連番は2桁以上もありうる
 * ```
 */
const SUBTITLE_ID = /^sub-[0-9]{8,12}(?:-[0-9]{1,4})?$/;
/** 話者IDに許す文字。 */
const SPEAKER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const validateSubtitleId = createIdValidator(SUBTITLE_ID, '字幕ID');

/**
 * 字幕本文の検証。
 *
 * 改行だけは許可し、それ以外の制御文字（タブ・NUL・エスケープ等）は拒否する。
 * 黙って取り除くと「入力した文字が消えた」ことに編集者が気づけないため、
 * 拒否して理由を返す。CRLF・CR は改行として正規化する（入力経路による差なので害がない）。
 */
export function validateSubtitleText(value: unknown): Validated<string> {
  if (typeof value !== 'string') {
    return invalid('字幕本文の形式が不正です。');
  }

  const normalized = value.replace(/\r\n?/g, '\n');

  // 改行(\u000A)以外の制御文字を拒否する。タブ(\u0009)・NUL・エスケープなど。
  // タブまで含めるのが要点：字幕本文に入ると SRT の見た目を壊すため。
  if (CONTROL_CHARS.test(normalized)) {
    return invalid(
      '字幕本文に使用できない制御文字が含まれています。',
      '貼り付け元の書式を外して、もう一度入力してください。',
    );
  }
  if (normalized.length > MAX_SUBTITLE_LENGTH) {
    return invalid(
      `字幕本文が長すぎます（${normalized.length}文字 / 上限${MAX_SUBTITLE_LENGTH}文字）。`,
      'キューを分けるか、短く言い換えてください。',
    );
  }
  if (normalized.split('\n').length > MAX_SUBTITLE_LINES) {
    return invalid(`字幕の行数が多すぎます（上限${MAX_SUBTITLE_LINES}行）。`);
  }
  if (normalized.trim().length === 0) {
    return invalid(
      '字幕本文が空です。',
      '空にしたい場合は修正を取り消してください。',
    );
  }
  return { ok: true, value: normalized };
}

/**
 * 話者IDの検証。
 * `known` を渡した場合は、プロジェクトに実在する話者かどうかも確かめる。
 */
export function validateSpeakerId(
  value: unknown,
  known?: ReadonlySet<string>,
): Validated<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return invalid('話者が指定されていません。');
  }
  if (!SPEAKER_ID.test(value)) {
    return invalid('話者IDの形式が不正です。');
  }
  if (known !== undefined && !known.has(value)) {
    return invalid('このプロジェクトに存在しない話者です。');
  }
  return { ok: true, value };
}

function validatePatch(
  raw: unknown,
  knownSpeakers?: ReadonlySet<string>,
): Validated<SubtitleEditPatch> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('修正内容の形式が不正です。');
  }
  const input = raw as Record<string, unknown>;
  const patch: SubtitleEditPatch = {};

  if (input.text !== undefined && input.text !== null) {
    const text = validateSubtitleText(input.text);
    if (!text.ok) return text;
    patch.text = text.value;
  }

  if (input.speakerId !== undefined && input.speakerId !== null) {
    const speaker = validateSpeakerId(input.speakerId, knownSpeakers);
    if (!speaker.ok) return speaker;
    patch.speakerId = speaker.value;
  }

  // ★タイムコード編集は今回未対応。値が妥当でも受け付けない。
  // 黙って無視すると「直したのに反映されない」になるため、明示的に断る。
  for (const [key, label] of [
    ['startSec', '開始時刻'],
    ['endSec', '終了時刻'],
  ] as const) {
    if (input[key] !== undefined && input[key] !== null) {
      const time = validateTimeSec(input[key], label);
      if (!time.ok) return time;
      return invalid(
        'タイムコードの編集は今回のバージョンでは未対応です。',
        '本文と話者の修正のみ保存できます。',
      );
    }
  }

  if (patch.text === undefined && patch.speakerId === undefined) {
    return invalid('修正内容がありません。');
  }

  return { ok: true, value: patch };
}

export function validateUpdateSubtitleRequest(
  raw: unknown,
  knownSpeakers?: ReadonlySet<string>,
): Validated<UpdateSubtitleEditRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('保存リクエストの形式が不正です。');
  }
  const input = raw as Record<string, unknown>;

  const path = validateProjectPath(input.projectPath);
  if (!path.ok) return path;

  const subtitleId = validateSubtitleId(input.subtitleId);
  if (!subtitleId.ok) return subtitleId;

  const expected = validateExpectedUpdatedAt(input.expectedUpdatedAt);
  if (!expected.ok) return expected;

  const patch = validatePatch(input.patch, knownSpeakers);
  if (!patch.ok) return patch;

  return {
    ok: true,
    value: {
      projectPath: path.value,
      subtitleId: subtitleId.value,
      expectedUpdatedAt: expected.value,
      patch: patch.value,
    },
  };
}

export function validateRemoveSubtitleRequest(
  raw: unknown,
): Validated<RemoveSubtitleEditRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('リクエストの形式が不正です。');
  }
  const input = raw as Record<string, unknown>;

  const path = validateProjectPath(input.projectPath);
  if (!path.ok) return path;

  const subtitleId = validateSubtitleId(input.subtitleId);
  if (!subtitleId.ok) return subtitleId;

  const expected = validateExpectedUpdatedAt(input.expectedUpdatedAt);
  if (!expected.ok) return expected;

  return {
    ok: true,
    value: {
      projectPath: path.value,
      subtitleId: subtitleId.value,
      expectedUpdatedAt: expected.value,
    },
  };
}
