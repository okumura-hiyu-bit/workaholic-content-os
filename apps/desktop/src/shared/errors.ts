/**
 * Electron層のエラーコードと、安全なDTOへの変換。
 *
 * ★`packages/pipeline` の PipelineError は technicalMessage を持つ。
 * これはRendererへ渡さない（stack traceと同様、開発者向け情報のため）。
 * 落とす作業をこの1箇所に集約し、あちこちで手作業に変換しないようにする。
 */

import type { SafePipelineError } from './dto.ts';

export const DESKTOP_ERROR_CODES = {
  /** Rendererから届いた値が型・形式として不正。 */
  INVALID_REQUEST: 'INVALID_REQUEST',
  /** 指定パスに有効な project.json が無い。 */
  INVALID_PROJECT: 'INVALID_PROJECT',
  /** このウィンドウで既に解析が動いている。 */
  ALREADY_RUNNING: 'ALREADY_RUNNING',
  /** 同じプロジェクトが既に解析中。 */
  PROJECT_ALREADY_RUNNING: 'PROJECT_ALREADY_RUNNING',
  /** 指定された runId の実行が見つからない。 */
  RUN_NOT_FOUND: 'RUN_NOT_FOUND',
  /** 解析プロセスが異常終了した。 */
  ANALYSIS_PROCESS_CRASHED: 'ANALYSIS_PROCESS_CRASHED',
  /** transcribe.py / .venv など実行環境が見つからない。 */
  ENVIRONMENT_NOT_READY: 'ENVIRONMENT_NOT_READY',
  /** リポジトリルート（projectRoot）を解決できなかった。 */
  PROJECT_ROOT_NOT_FOUND: 'PROJECT_ROOT_NOT_FOUND',
  /** 読み込み後に project.json が別の処理で更新されていた（競合更新）。 */
  PROJECT_CHANGED: 'PROJECT_CHANGED',
  /** 指定された字幕が見つからない。 */
  SUBTITLE_NOT_FOUND: 'SUBTITLE_NOT_FOUND',
  /** IDが重複していて安全に修正できない字幕。 */
  SUBTITLE_NOT_EDITABLE: 'SUBTITLE_NOT_EDITABLE',
  /** 解析がまだ行われていない（字幕が存在しない）。 */
  ANALYSIS_NOT_READY: 'ANALYSIS_NOT_READY',
  UNKNOWN: 'UNKNOWN',
} as const;

export type DesktopErrorCode =
  (typeof DESKTOP_ERROR_CODES)[keyof typeof DESKTOP_ERROR_CODES];

export function safeError(
  code: string,
  userMessage: string,
  opts: {
    stepId?: string;
    recoverable?: boolean;
    suggestedAction?: string;
  } = {},
): SafePipelineError {
  const error: SafePipelineError = {
    code,
    userMessage,
    recoverable: opts.recoverable ?? true,
  };
  if (opts.stepId !== undefined) error.stepId = opts.stepId;
  if (opts.suggestedAction !== undefined) error.suggestedAction = opts.suggestedAction;
  return error;
}

/** PipelineError（technicalMessageを持つ）に相当する形。 */
export interface PipelineErrorLike {
  code: string;
  stepId?: string;
  userMessage: string;
  technicalMessage?: string;
  recoverable?: boolean;
  suggestedAction?: string;
}

/**
 * PipelineError を Renderer へ渡してよい形へ落とす。
 *
 * ★technicalMessage は意図的に捨てる。開発者向け情報は
 * 構造化ログ（main/logger.ts）にのみ残す。
 */
export function toSafeError(error: PipelineErrorLike): SafePipelineError {
  return safeError(error.code, error.userMessage, {
    ...(error.stepId !== undefined ? { stepId: error.stepId } : {}),
    recoverable: error.recoverable ?? true,
    ...(error.suggestedAction !== undefined
      ? { suggestedAction: error.suggestedAction }
      : {}),
  });
}

/**
 * 想定外の例外を安全なDTOにする。
 * ★例外のメッセージ本文はユーザーに出さない（パスや内部情報が混ざるため）。
 */
export function unknownToSafeError(userMessage: string): SafePipelineError {
  return safeError(DESKTOP_ERROR_CODES.UNKNOWN, userMessage, {
    recoverable: true,
  });
}
