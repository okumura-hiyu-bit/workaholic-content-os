/**
 * 新規作成・素材登録リクエストの検証。
 * ★Rendererを信用しない。fs には触らない純粋な構造検証だけを行う。
 */

import { DESKTOP_ERROR_CODES, safeError } from './errors.ts';
import {
  isAssetRoleId,
  SPEAKER_SLOTS,
  type CreateProjectRequest,
  type RemoveAssetRequest,
  type SpeakerInput,
  type SpeakerSlot,
  type UpdateAssetRequest,
} from './setup-dto.ts';
import { validateExpectedUpdatedAt } from './review-validate.ts';
import type { Validated } from './validate.ts';
import { validateProjectPath } from './validate.ts';

/** 案件名の上限。フォルダ名にも使うので長すぎると扱いにくい。 */
export const MAX_PROJECT_NAME_LENGTH = 80;
/** 出演者名の上限。 */
export const MAX_SPEAKER_NAME_LENGTH = 40;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ASSET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function invalid(userMessage: string, suggestedAction?: string): Validated<never> {
  return {
    ok: false,
    error: safeError(DESKTOP_ERROR_CODES.INVALID_REQUEST, userMessage, {
      recoverable: true,
      ...(suggestedAction !== undefined ? { suggestedAction } : {}),
    }),
  };
}

/**
 * 名前に使えない文字を弾く。
 * ★案件名はフォルダ名の元にもなるので、パス区切り・制御文字を通さない。
 */
export function validateProjectName(value: unknown): Validated<string> {
  if (typeof value !== 'string') return invalid('案件名の形式が不正です。');
  const trimmed = value.trim();
  if (trimmed.length === 0) return invalid('案件名を入力してください。');
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) {
    return invalid(
      `案件名が長すぎます（${trimmed.length}文字 / 上限${MAX_PROJECT_NAME_LENGTH}文字）。`,
    );
  }
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    return invalid('案件名に使用できない制御文字が含まれています。');
  }
  if (/[/\\:*?"<>|]/.test(trimmed)) {
    return invalid(
      '案件名に使用できない記号が含まれています（/ \\ : * ? " < > |）。',
      'フォルダ名にも使うため、これらの記号は使えません。',
    );
  }
  // '.' や '..' はフォルダ名として危険。
  if (trimmed === '.' || trimmed === '..') {
    return invalid('その案件名は使用できません。');
  }
  return { ok: true, value: trimmed };
}

/** 収録日。YYYY-MM-DD で、実在する日付であること。 */
export function validateRecordedAt(value: unknown): Validated<string> {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) {
    return invalid('収録日は YYYY-MM-DD の形式で入力してください。');
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return invalid('存在しない日付です。');
  // 2月30日のような値を弾く（Dateが繰り上げてしまうため往復で確認する）。
  if (date.toISOString().slice(0, 10) !== value) {
    return invalid('存在しない日付です。');
  }
  const year = Number(value.slice(0, 4));
  if (year < 2000 || year > 2100) return invalid('収録日が範囲外です。');
  return { ok: true, value };
}

function validateSpeakerName(value: unknown): Validated<string> {
  if (typeof value !== 'string') return invalid('出演者名の形式が不正です。');
  const trimmed = value.trim();
  if (trimmed.length === 0) return invalid('出演者名を入力してください。');
  if (trimmed.length > MAX_SPEAKER_NAME_LENGTH) {
    return invalid(`出演者名が長すぎます（上限${MAX_SPEAKER_NAME_LENGTH}文字）。`);
  }
  if (/[\u0000-\u001F\u007F]/.test(trimmed)) {
    return invalid('出演者名に使用できない制御文字が含まれています。');
  }
  return { ok: true, value: trimmed };
}

function validateSpeakers(raw: unknown): Validated<SpeakerInput[]> {
  if (!Array.isArray(raw)) return invalid('出演者の指定が不正です。');
  if (raw.length === 0) return invalid('出演者を1名以上登録してください。');
  if (raw.length > SPEAKER_SLOTS.length) {
    return invalid(`出演者は${SPEAKER_SLOTS.length}名までです。`);
  }

  const speakers: SpeakerInput[] = [];
  const usedSlots = new Set<string>();

  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      return invalid('出演者の指定が不正です。');
    }
    const input = item as Record<string, unknown>;

    if (
      typeof input.slot !== 'string' ||
      !(SPEAKER_SLOTS as readonly string[]).includes(input.slot)
    ) {
      return invalid('出演者の識別子が不正です。');
    }
    if (usedSlots.has(input.slot)) {
      return invalid('同じ出演者枠が重複しています。');
    }
    usedSlots.add(input.slot);

    const name = validateSpeakerName(input.name);
    if (!name.ok) return name;

    if (input.role !== 'host' && input.role !== 'guest') {
      return invalid('出演者の区分が不正です。');
    }

    const speaker: SpeakerInput = {
      slot: input.slot as SpeakerSlot,
      name: name.value,
      role: input.role,
    };
    if (typeof input.title === 'string' && input.title.trim().length > 0) {
      const title = validateSpeakerName(input.title);
      if (!title.ok) return title;
      speaker.title = title.value;
    }
    speakers.push(speaker);
  }

  return { ok: true, value: speakers };
}

export function validateCreateProjectRequest(
  raw: unknown,
): Validated<CreateProjectRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('作成リクエストの形式が不正です。');
  }
  const input = raw as Record<string, unknown>;

  const name = validateProjectName(input.name);
  if (!name.ok) return name;

  const recordedAt = validateRecordedAt(input.recordedAt);
  if (!recordedAt.ok) return recordedAt;

  const speakers = validateSpeakers(input.speakers);
  if (!speakers.ok) return speakers;

  // 保存先は絶対パスのみ。相対だとMain側のcwdに依存してしまう。
  const parentDir = validateProjectPath(input.parentDir);
  if (!parentDir.ok) {
    return invalid('保存場所を選択してください。', '保存先は絶対パスで指定します。');
  }

  if (input.syncMode !== 'preserve' && input.syncMode !== 'common') {
    return invalid('同期モードの指定が不正です。');
  }

  const value: CreateProjectRequest = {
    name: name.value,
    recordedAt: recordedAt.value,
    speakers: speakers.value,
    parentDir: parentDir.value,
    syncMode: input.syncMode,
  };

  if (typeof input.programName === 'string' && input.programName.trim().length > 0) {
    const program = validateProjectName(input.programName);
    if (!program.ok) return program;
    value.programName = program.value;
  }

  return { ok: true, value };
}

export function validateAssetId(value: unknown): Validated<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return invalid('素材IDが指定されていません。');
  }
  if (!ASSET_ID.test(value)) return invalid('素材IDの形式が不正です。');
  return { ok: true, value };
}

export function validateUpdateAssetRequest(
  raw: unknown,
): Validated<UpdateAssetRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('素材の更新リクエストが不正です。');
  }
  const input = raw as Record<string, unknown>;

  const path = validateProjectPath(input.projectPath);
  if (!path.ok) return path;

  const expected = validateExpectedUpdatedAt(input.expectedUpdatedAt);
  if (!expected.ok) return expected;

  const assetId = validateAssetId(input.assetId);
  if (!assetId.ok) return assetId;

  if (typeof input.patch !== 'object' || input.patch === null) {
    return invalid('更新内容の形式が不正です。');
  }
  const rawPatch = input.patch as Record<string, unknown>;
  const patch: UpdateAssetRequest['patch'] = {};

  if (rawPatch.role !== undefined && rawPatch.role !== null) {
    if (!isAssetRoleId(rawPatch.role)) {
      return invalid('素材の役割に不明な値が指定されました。');
    }
    patch.role = rawPatch.role;
    // ★「役割を選んだ＝確定」の判断はここでは行わない。
    // 検証層は構造だけを見る。業務ルールは updateAsset が持つ。
  }

  if (rawPatch.enabled !== undefined && rawPatch.enabled !== null) {
    if (typeof rawPatch.enabled !== 'boolean') {
      return invalid('有効・無効の指定が不正です。');
    }
    patch.enabled = rawPatch.enabled;
  }

  if (rawPatch.roleConfirmed !== undefined && rawPatch.roleConfirmed !== null) {
    if (typeof rawPatch.roleConfirmed !== 'boolean') {
      return invalid('役割確定の指定が不正です。');
    }
    patch.roleConfirmed = rawPatch.roleConfirmed;
  }

  if (Object.keys(patch).length === 0) return invalid('更新内容がありません。');

  return {
    ok: true,
    value: {
      projectPath: path.value,
      expectedUpdatedAt: expected.value,
      assetId: assetId.value,
      patch,
    },
  };
}

export function validateRemoveAssetRequest(
  raw: unknown,
): Validated<RemoveAssetRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('素材の削除リクエストが不正です。');
  }
  const input = raw as Record<string, unknown>;

  const path = validateProjectPath(input.projectPath);
  if (!path.ok) return path;

  const expected = validateExpectedUpdatedAt(input.expectedUpdatedAt);
  if (!expected.ok) return expected;

  const assetId = validateAssetId(input.assetId);
  if (!assetId.ok) return assetId;

  return {
    ok: true,
    value: {
      projectPath: path.value,
      expectedUpdatedAt: expected.value,
      assetId: assetId.value,
    },
  };
}
