/**
 * 確認画面（Review）系で共通に使う検証部品。
 *
 * ★なぜ切り出したか（2026-08-04 / Step 7 の最初に実施）
 * 字幕・ショート候補・カメラ切替の各Reviewは、同じ形の検証を必ず持つ
 * （競合検出の updatedAt・秒数の範囲・制御文字の拒否・エラーの作り方）。
 * これらが `review-validate.ts`（実体は字幕Review専用）に置かれていたため、
 * ショート候補が「字幕に依存している」ように見える構造になっていた。
 * カメラ切替が3本目として同じ依存をなぞる前に、中立な置き場所へ移した。
 *
 * ★このファイルは fs にも electron にも触らない純粋な検証だけを持つ。
 * ★移設であって仕様変更ではない。関数の中身は移動前と1文字も変えていない。
 */

import type { SafePipelineError } from './dto.ts';
import { DESKTOP_ERROR_CODES, safeError } from './errors.ts';
import type { Validated } from './validate.ts';

/**
 * 改行（\n）以外の制御文字。タブ・NUL・エスケープなどを含む。
 *
 * タブまで拒否対象に含めるのが要点：字幕本文やタイトルに紛れ込むと
 * SRT や CSV の見た目を壊すため。
 */
export const CONTROL_CHARS = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/;

/** ISO 8601（project-store が updatedAt に書く形）。 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** 検証失敗を組み立てる。★Rendererへ返すのは userMessage までで、詳細は載せない。 */
export function invalid(
  userMessage: string,
  suggestedAction?: string,
): Validated<never> {
  return {
    ok: false,
    error: safeError(DESKTOP_ERROR_CODES.INVALID_REQUEST, userMessage, {
      recoverable: true,
      ...(suggestedAction !== undefined ? { suggestedAction } : {}),
    }),
  };
}

/**
 * 競合検出に使う updatedAt の検証。
 *
 * ★形式が違うものを通してはいけない。この値は保存直前に現在値と照合され、
 * 競合を検出する唯一の手掛かりになるため。
 */
export function validateExpectedUpdatedAt(value: unknown): Validated<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return invalid('プロジェクトの更新時刻が指定されていません。');
  }
  if (!ISO_TIMESTAMP.test(value)) {
    return invalid('プロジェクトの更新時刻の形式が不正です。');
  }
  return { ok: true, value };
}

/** 秒数の検証。24時間を超える収録は想定しない（異常値で成果物を壊さないための上限）。 */
export function validateTimeSec(value: unknown, label: string): Validated<number> {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return invalid(`${label}の形式が不正です。`);
  }
  if (value < 0) {
    return invalid(`${label}に負の値は指定できません。`);
  }
  // 24時間を超える収録は想定しない。異常値でXMLを壊さないための上限。
  if (value > 24 * 60 * 60) {
    return invalid(`${label}が範囲外です。`);
  }
  return { ok: true, value };
}

/**
 * 1行のテキスト項目（タイトル・フックなど）。
 * 改行は「1行」の約束を壊すので拒否する。
 */
export function validateSingleLineText(
  value: unknown,
  label: string,
  maxLength: number,
): Validated<string> {
  if (typeof value !== 'string') {
    return invalid(`${label}の形式が不正です。`);
  }
  const normalized = value.replace(/\r\n?/g, '\n');
  if (normalized.includes('\n')) {
    return invalid(`${label}に改行は使えません。`, '1行で入力してください。');
  }
  if (CONTROL_CHARS.test(normalized)) {
    return invalid(
      `${label}に使用できない制御文字が含まれています。`,
      '貼り付け元の書式を外して、もう一度入力してください。',
    );
  }
  const trimmed = normalized.trim();
  if (trimmed.length > maxLength) {
    return invalid(
      `${label}が長すぎます（${trimmed.length}文字 / 上限${maxLength}文字）。`,
    );
  }
  return { ok: true, value: trimmed };
}

/** 複数行のテキスト項目（投稿文・メモなど）。改行のみ許す。 */
export function validateMultiLineText(
  value: unknown,
  label: string,
  maxLength: number,
): Validated<string> {
  if (typeof value !== 'string') {
    return invalid(`${label}の形式が不正です。`);
  }
  const normalized = value.replace(/\r\n?/g, '\n');
  if (CONTROL_CHARS.test(normalized)) {
    return invalid(
      `${label}に使用できない制御文字が含まれています。`,
      '貼り付け元の書式を外して、もう一度入力してください。',
    );
  }
  if (normalized.length > maxLength) {
    return invalid(
      `${label}が長すぎます（${normalized.length}文字 / 上限${maxLength}文字）。`,
    );
  }
  return { ok: true, value: normalized };
}

/** 競合更新のエラー。文言は画面にそのまま出す。 */
export function conflictError(): SafePipelineError {
  return safeError(
    DESKTOP_ERROR_CODES.PROJECT_CHANGED,
    'プロジェクトが別の処理で更新されました。再読み込みしてください',
    {
      recoverable: true,
      suggestedAction: '「再読み込み」を押すと最新の内容を取得します。',
    },
  );
}
