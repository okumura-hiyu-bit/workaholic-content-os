/**
 * ショート候補の採否・編集リクエストの検証。
 *
 * ★Rendererを信用しない。保存はディスクへの書き込みなので、
 * 通す前にここで必ず形を確かめる。fs には触らない純粋な検証。
 *
 * 方針は review-validate.ts と揃える：
 * - 制御文字は黙って取り除かず、拒否して理由を返す（消えたことに気づけないため）
 * - 未対応の項目（タイムコード）は黙って無視せず、明示的に断る
 */

import type {
  RemoveShortDecisionRequest,
  ShortDecisionPatch,
  UpdateShortDecisionRequest,
} from './shorts-dto.ts';
import type { Validated } from './validate.ts';
import { validateProjectPath } from './validate.ts';
import {
  CONTROL_CHARS,
  createIdValidator,
  invalid,
  validateExpectedUpdatedAt,
  validateMultiLineText,
  validateSingleLineText,
  validateTimeSec,
} from './validate-common.ts';

/** タイトル（YouTube Shorts の表示を想定し、余裕を見た上限）。 */
export const MAX_SHORT_TITLE_LENGTH = 100;
/** 冒頭フック（1〜2文を想定）。 */
export const MAX_SHORT_HOOK_LENGTH = 200;
/** 投稿文。複数行を許す。 */
export const MAX_SHORT_CAPTION_LENGTH = 2000;
/** 編集者向けメモ。複数行を許す。 */
export const MAX_SHORT_NOTE_LENGTH = 1000;
/** ハッシュタグの本数と1本あたりの長さ。 */
export const MAX_SHORT_HASHTAGS = 30;
export const MAX_SHORT_HASHTAG_LENGTH = 50;

/**
 * ショート候補IDの形。`packages/editing/short-candidates.ts` の
 * `short_${String(index + 1).padStart(2, '0')}` に合わせる。
 *
 * ```
 * short_01     通常（2桁ゼロ埋め）
 * short_100    候補が100件を超えた場合（padStart は切り詰めない）
 * ```
 */
const SHORT_ID = /^short_[0-9]{2,4}$/;

export const validateShortId = createIdValidator(SHORT_ID, 'ショート候補ID');

/**
 * ハッシュタグの検証。
 *
 * 先頭の `#` は入力の揺れなので1つだけ取り除いて正規化する（`#` 無しで保存）。
 * 一方、途中の `#` と空白は「1本のタグ」を壊すため拒否する。
 * 黙って分割・除去すると、入力したものと保存されたものが食い違うため。
 */
export function validateHashtags(value: unknown): Validated<string[]> {
  if (!Array.isArray(value)) {
    return invalid('ハッシュタグの形式が不正です。');
  }
  if (value.length > MAX_SHORT_HASHTAGS) {
    return invalid(
      `ハッシュタグが多すぎます（${value.length}件 / 上限${MAX_SHORT_HASHTAGS}件）。`,
    );
  }

  const tags: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') {
      return invalid('ハッシュタグの形式が不正です。');
    }
    const tag = raw.trim().replace(/^#/, '');
    if (tag.length === 0) continue; // 空欄は無視する（行を消したのと同じ）
    if (CONTROL_CHARS.test(tag) || /\n/.test(tag)) {
      return invalid('ハッシュタグに使用できない文字が含まれています。');
    }
    if (/\s/.test(tag)) {
      return invalid(
        `ハッシュタグに空白は使えません（「${tag}」）。`,
        '空白で区切らず、1件ずつ入力してください。',
      );
    }
    if (tag.includes('#')) {
      return invalid(
        `ハッシュタグの途中に # は使えません（「${tag}」）。`,
        '1件ずつ入力してください。',
      );
    }
    if (tag.length > MAX_SHORT_HASHTAG_LENGTH) {
      return invalid(
        `ハッシュタグが長すぎます（${tag.length}文字 / 上限${MAX_SHORT_HASHTAG_LENGTH}文字）。`,
      );
    }
    if (!tags.includes(tag)) tags.push(tag); // 重複は1件にまとめる
  }
  return { ok: true, value: tags };
}

/** `null` は「この項目を消す」。undefined は「変更しない」。 */
function isClear(value: unknown): boolean {
  return value === null;
}

export function validateShortPatch(raw: unknown): Validated<ShortDecisionPatch> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('判断内容の形式が不正です。');
  }
  const input = raw as Record<string, unknown>;
  const patch: ShortDecisionPatch = {};
  let touched = false;

  if ('adopted' in input && input.adopted !== undefined) {
    if (isClear(input.adopted)) {
      patch.adopted = null;
    } else if (typeof input.adopted === 'boolean') {
      patch.adopted = input.adopted;
    } else {
      return invalid('採否の形式が不正です。');
    }
    touched = true;
  }

  const textFields = [
    ['title', 'タイトル', MAX_SHORT_TITLE_LENGTH, 'single'],
    ['hook', '冒頭フック', MAX_SHORT_HOOK_LENGTH, 'single'],
    ['caption', '投稿文', MAX_SHORT_CAPTION_LENGTH, 'multi'],
    ['note', 'メモ', MAX_SHORT_NOTE_LENGTH, 'multi'],
  ] as const;

  for (const [key, label, max, mode] of textFields) {
    if (!(key in input) || input[key] === undefined) continue;
    if (isClear(input[key])) {
      patch[key] = null;
      touched = true;
      continue;
    }
    const checked =
      mode === 'single'
        ? validateSingleLineText(input[key], label, max)
        : validateMultiLineText(input[key], label, max);
    if (!checked.ok) return checked;
    // 空文字は「消す」と同じ扱いにする。保存に空文字を残さない。
    patch[key] = checked.value.length === 0 ? null : checked.value;
    touched = true;
  }

  if ('hashtags' in input && input.hashtags !== undefined) {
    if (isClear(input.hashtags)) {
      patch.hashtags = null;
    } else {
      const tags = validateHashtags(input.hashtags);
      if (!tags.ok) return tags;
      patch.hashtags = tags.value.length === 0 ? null : tags.value;
    }
    touched = true;
  }

  // ★タイムコードの編集は未対応。値が妥当でも受け付けない。
  // 黙って無視すると「直したのに反映されない」になるため、明示的に断る。
  for (const [key, label] of [
    ['startSec', '開始時刻'],
    ['endSec', '終了時刻'],
  ] as const) {
    if (input[key] !== undefined && input[key] !== null) {
      const time = validateTimeSec(input[key], label);
      if (!time.ok) return time;
      return invalid(
        'ショート候補の区間の編集は未対応です。',
        '採否・タイトル・フック・投稿文・ハッシュタグ・メモのみ保存できます。',
      );
    }
  }

  if (!touched) {
    return invalid('判断内容がありません。');
  }

  return { ok: true, value: patch };
}

export function validateUpdateShortRequest(
  raw: unknown,
): Validated<UpdateShortDecisionRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('保存リクエストの形式が不正です。');
  }
  const input = raw as Record<string, unknown>;

  const path = validateProjectPath(input.projectPath);
  if (!path.ok) return path;

  const shortId = validateShortId(input.shortId);
  if (!shortId.ok) return shortId;

  const expected = validateExpectedUpdatedAt(input.expectedUpdatedAt);
  if (!expected.ok) return expected;

  const patch = validateShortPatch(input.patch);
  if (!patch.ok) return patch;

  return {
    ok: true,
    value: {
      projectPath: path.value,
      shortId: shortId.value,
      expectedUpdatedAt: expected.value,
      patch: patch.value,
    },
  };
}

export function validateRemoveShortRequest(
  raw: unknown,
): Validated<RemoveShortDecisionRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('リクエストの形式が不正です。');
  }
  const input = raw as Record<string, unknown>;

  const path = validateProjectPath(input.projectPath);
  if (!path.ok) return path;

  const shortId = validateShortId(input.shortId);
  if (!shortId.ok) return shortId;

  const expected = validateExpectedUpdatedAt(input.expectedUpdatedAt);
  if (!expected.ok) return expected;

  return {
    ok: true,
    value: {
      projectPath: path.value,
      shortId: shortId.value,
      expectedUpdatedAt: expected.value,
    },
  };
}
