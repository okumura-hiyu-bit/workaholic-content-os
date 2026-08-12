/**
 * 復旧画面のリクエスト検証。
 * ★Rendererを信用しない。fs には触らない純粋な構造検証だけを行う。
 *
 * ★IDの形式チェックは各画面の検証をそのまま使い回す。
 * ここで独自の正規表現を書くと、字幕・ショート・カメラ・マーカーの
 * ID形式がこのファイルにも二重に書かれ、本体が変わったときに片方だけ
 * 古いまま残る。Step 9 で `createIdValidator` に集約した意図を保つ。
 */

import { validateCameraShotId } from './camera-validate.ts';
import { validateMarkerId } from './marker-validate.ts';
import {
  RECOVERY_DOMAINS,
  type RecoveryDiscardRequest,
  type RecoveryDomain,
  type RecoveryReattachRequest,
  type RecoveryTargetsRequest,
} from './recovery-dto.ts';
import { validateSubtitleId } from './review-validate.ts';
import { validateShortId } from './shorts-validate.ts';
import { invalid, validateExpectedUpdatedAt } from './validate-common.ts';
import type { Validated } from './validate.ts';
import { validateProjectPath } from './validate.ts';

/** 対象の検証。★4つ以外は受け付けない。 */
export function validateRecoveryDomain(value: unknown): Validated<RecoveryDomain> {
  if (typeof value !== 'string' || value.length === 0) {
    return invalid('対象が指定されていません。');
  }
  if (!RECOVERY_DOMAINS.includes(value as RecoveryDomain)) {
    return invalid('対象の指定が不正です。');
  }
  return { ok: true, value: value as RecoveryDomain };
}

/**
 * 対象に応じたIDの検証。
 *
 * ★対象ごとに形式が違うので、対象を確定してから引く。
 * 字幕IDの形をしたものをマーカーとして送る、といった取り違えをここで弾く。
 */
export function validateIdFor(
  domain: RecoveryDomain,
  value: unknown,
): Validated<string> {
  switch (domain) {
    case 'subtitle':
      return validateSubtitleId(value);
    case 'short':
      return validateShortId(value);
    case 'cameraShot':
      return validateCameraShotId(value);
    case 'marker':
      return validateMarkerId(value);
  }
}

type Raw = Record<string, unknown> | null | undefined;

export function validateRecoveryTargetsRequest(
  value: unknown,
): Validated<RecoveryTargetsRequest> {
  const raw = value as Raw;
  const path = validateProjectPath(raw?.projectPath);
  if (!path.ok) return path;

  const domain = validateRecoveryDomain(raw?.domain);
  if (!domain.ok) return domain;

  const sourceId = validateIdFor(domain.value, raw?.sourceId);
  if (!sourceId.ok) return sourceId;

  return {
    ok: true,
    value: {
      projectPath: path.value,
      domain: domain.value,
      sourceId: sourceId.value,
    },
  };
}

export function validateRecoveryReattachRequest(
  value: unknown,
): Validated<RecoveryReattachRequest> {
  const raw = value as Raw;
  const path = validateProjectPath(raw?.projectPath);
  if (!path.ok) return path;

  const domain = validateRecoveryDomain(raw?.domain);
  if (!domain.ok) return domain;

  const sourceId = validateIdFor(domain.value, raw?.sourceId);
  if (!sourceId.ok) return sourceId;

  const targetId = validateIdFor(domain.value, raw?.targetId);
  if (!targetId.ok) return targetId;

  // ★同じIDへの付け替えは意味が無く、実行すると「消して同じ場所へ足す」
  //   だけの履歴が残る。操作として受け付けない。
  if (sourceId.value === targetId.value) {
    return invalid(
      '付け替え先が元と同じです。',
      '別の要素を選んでください。',
    );
  }

  const expectedUpdatedAt = validateExpectedUpdatedAt(raw?.expectedUpdatedAt);
  if (!expectedUpdatedAt.ok) return expectedUpdatedAt;

  return {
    ok: true,
    value: {
      projectPath: path.value,
      domain: domain.value,
      sourceId: sourceId.value,
      targetId: targetId.value,
      expectedUpdatedAt: expectedUpdatedAt.value,
    },
  };
}

export function validateRecoveryDiscardRequest(
  value: unknown,
): Validated<RecoveryDiscardRequest> {
  const raw = value as Raw;
  const path = validateProjectPath(raw?.projectPath);
  if (!path.ok) return path;

  const domain = validateRecoveryDomain(raw?.domain);
  if (!domain.ok) return domain;

  const sourceId = validateIdFor(domain.value, raw?.sourceId);
  if (!sourceId.ok) return sourceId;

  const expectedUpdatedAt = validateExpectedUpdatedAt(raw?.expectedUpdatedAt);
  if (!expectedUpdatedAt.ok) return expectedUpdatedAt;

  return {
    ok: true,
    value: {
      projectPath: path.value,
      domain: domain.value,
      sourceId: sourceId.value,
      expectedUpdatedAt: expectedUpdatedAt.value,
    },
  };
}
