/**
 * Rendererから届いた値の検証。
 *
 * ★Rendererは信用しない。contextIsolation と sandbox で守っていても、
 * レンダラープロセスが乗っ取られた場合にMainが任意のパスを読み書きしたり
 * 未知の工程IDでパイプラインを動かしたりしないよう、Main側で必ず通す。
 *
 * ここは fs に触らない純粋な構造検証だけを行う。
 * 「実際にファイルが存在するか」は main/project.ts の責務。
 */

import { isAbsolute, normalize } from 'node:path';

import type { SafePipelineError, StartPipelineRequest } from './dto.ts';
import { DESKTOP_ERROR_CODES, safeError } from './errors.ts';
import { isStepId, isSyncMode, type StepId } from './steps.ts';

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; error: SafePipelineError };

function invalid(userMessage: string, suggestedAction?: string): Validated<never> {
  return {
    ok: false,
    error: safeError(DESKTOP_ERROR_CODES.INVALID_REQUEST, userMessage, {
      recoverable: true,
      ...(suggestedAction !== undefined ? { suggestedAction } : {}),
    }),
  };
}

/** runId / projectId に許す文字。パス断片やコマンドとして解釈されうる文字を弾く。 */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function validateId(value: unknown, label: string): Validated<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return invalid(`${label}が指定されていません。`);
  }
  if (!SAFE_ID.test(value)) {
    return invalid(`${label}の形式が不正です。`);
  }
  return { ok: true, value };
}

/**
 * プロジェクトディレクトリのパスを検証する。
 *
 * 絶対パスのみ許可し、NUL文字を弾く。相対パスを許すと
 * Main側の解決基準（cwd）に依存してしまうため、必ず絶対パスで受け取る。
 */
export function validateProjectPath(value: unknown): Validated<string> {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return invalid('プロジェクトのパスが指定されていません。');
  }
  if (value.includes('\0')) {
    return invalid('プロジェクトのパスに使用できない文字が含まれています。');
  }
  if (!isAbsolute(value)) {
    return invalid('プロジェクトのパスは絶対パスで指定してください。');
  }
  return { ok: true, value: normalize(value) };
}

function validateOptionalStep(
  value: unknown,
  label: string,
): Validated<StepId | undefined> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (!isStepId(value)) {
    return invalid(`${label}に不明な工程が指定されました。`);
  }
  return { ok: true, value };
}

/**
 * 解析開始リクエストの検証。
 *
 * ★工程IDは PipelineStepId に存在するものだけを通す（shared/steps.ts の
 * STEP_IDS。この一覧が本物と一致することは steps.test.ts で担保している）。
 */
export function validateStartRequest(
  raw: unknown,
): Validated<StartPipelineRequest> {
  if (typeof raw !== 'object' || raw === null) {
    return invalid('解析リクエストの形式が不正です。');
  }
  const input = raw as Record<string, unknown>;

  const path = validateProjectPath(input.projectPath);
  if (!path.ok) return path;

  const from = validateOptionalStep(input.fromStep, '開始工程');
  if (!from.ok) return from;

  const to = validateOptionalStep(input.toStep, '終了工程');
  if (!to.ok) return to;

  let onlySteps: StepId[] | undefined;
  if (input.onlySteps !== undefined && input.onlySteps !== null) {
    if (!Array.isArray(input.onlySteps)) {
      return invalid('実行する工程の指定が不正です。');
    }
    if (!input.onlySteps.every(isStepId)) {
      return invalid('実行する工程に不明な工程が含まれています。');
    }
    onlySteps = [...new Set(input.onlySteps as StepId[])];
  }

  let syncMode: 'preserve' | 'common' | undefined;
  if (input.syncMode !== undefined && input.syncMode !== null) {
    if (!isSyncMode(input.syncMode)) {
      return invalid('同期モードの指定が不正です。');
    }
    syncMode = input.syncMode;
  }

  if (input.force !== undefined && typeof input.force !== 'boolean') {
    return invalid('強制再実行の指定が不正です。');
  }

  const value: StartPipelineRequest = { projectPath: path.value };
  if (from.value !== undefined) value.fromStep = from.value;
  if (to.value !== undefined) value.toStep = to.value;
  if (onlySteps !== undefined) value.onlySteps = onlySteps;
  if (syncMode !== undefined) value.syncMode = syncMode;
  if (input.force === true) value.force = true;

  return { ok: true, value };
}
