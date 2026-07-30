/**
 * エラー設計：ユーザー向けメッセージと開発者向けメッセージを分ける。
 *
 * @see docs/14-pipeline.md
 */

import type { PipelineError, PipelineStepId } from './types.ts';

export const ERROR_CODES = {
  FFMPEG_NOT_FOUND: 'FFMPEG_NOT_FOUND',
  PYTHON_NOT_FOUND: 'PYTHON_NOT_FOUND',
  WHISPER_NOT_FOUND: 'WHISPER_NOT_FOUND',
  ASSET_MISSING: 'ASSET_MISSING',
  NO_AUDIO_TRACK: 'NO_AUDIO_TRACK',
  LOW_SYNC_CONFIDENCE: 'LOW_SYNC_CONFIDENCE',
  DISK_FULL: 'DISK_FULL',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  XML_GENERATION_FAILED: 'XML_GENERATION_FAILED',
  CANCELLED: 'CANCELLED',
  DEPENDENCY_FAILED: 'DEPENDENCY_FAILED',
  DEPENDENCY_NOT_COMPLETED: 'DEPENDENCY_NOT_COMPLETED',
  PATH_ESCAPES_PROJECT: 'PATH_ESCAPES_PROJECT',
  INVALID_PROJECT: 'INVALID_PROJECT',
  UNKNOWN: 'UNKNOWN',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

function make(
  code: ErrorCode,
  stepId: PipelineStepId,
  userMessage: string,
  opts: {
    technicalMessage?: string;
    recoverable?: boolean;
    suggestedAction?: string;
  } = {},
): PipelineError {
  return {
    code,
    stepId,
    userMessage,
    technicalMessage: opts.technicalMessage,
    recoverable: opts.recoverable ?? true,
    suggestedAction: opts.suggestedAction,
  };
}

export const PipelineErrors = {
  ffmpegNotFound: (stepId: PipelineStepId, technicalMessage?: string) =>
    make(ERROR_CODES.FFMPEG_NOT_FOUND, stepId, 'ffmpeg が見つかりません。', {
      technicalMessage,
      suggestedAction: 'brew install ffmpeg を実行してから再試行してください。',
    }),

  pythonNotFound: (stepId: PipelineStepId, technicalMessage?: string) =>
    make(
      ERROR_CODES.PYTHON_NOT_FOUND,
      stepId,
      'Python仮想環境が見つかりません。',
      {
        technicalMessage,
        suggestedAction:
          'python3 -m venv .venv && .venv/bin/pip install faster-whisper を実行してください。',
      },
    ),

  whisperNotFound: (stepId: PipelineStepId, technicalMessage?: string) =>
    make(
      ERROR_CODES.WHISPER_NOT_FOUND,
      stepId,
      'faster-whisper が見つかりません。',
      {
        technicalMessage,
        suggestedAction: '.venv/bin/pip install faster-whisper を実行してください。',
      },
    ),

  assetMissing: (stepId: PipelineStepId, fileName: string) =>
    make(
      ERROR_CODES.ASSET_MISSING,
      stepId,
      `素材ファイルが見つかりません: ${fileName}`,
      {
        recoverable: true,
        suggestedAction:
          '素材が移動・削除されていないか確認し、素材登録画面でパスを直してください。',
      },
    ),

  noAudioTrack: (stepId: PipelineStepId, fileName: string) =>
    make(
      ERROR_CODES.NO_AUDIO_TRACK,
      stepId,
      `${fileName} に音声トラックがありません。`,
      { suggestedAction: '正しい素材が割り当てられているか確認してください。' },
    ),

  lowSyncConfidence: (
    stepId: PipelineStepId,
    assetLabel: string,
    confidence: number,
  ) =>
    make(
      ERROR_CODES.LOW_SYNC_CONFIDENCE,
      stepId,
      `${assetLabel} の同期の信頼度が低いです（${confidence.toFixed(2)}）。`,
      {
        recoverable: true,
        suggestedAction: '確認画面で同期状態を目視確認してください。処理は続行します。',
      },
    ),

  diskFull: (stepId: PipelineStepId, path: string) =>
    make(ERROR_CODES.DISK_FULL, stepId, 'ディスクの空き容量が不足しています。', {
      technicalMessage: `insufficient space near ${path}`,
      recoverable: false,
      suggestedAction: '空き容量を確保してから再試行してください。',
    }),

  permissionDenied: (stepId: PipelineStepId, path: string) =>
    make(
      ERROR_CODES.PERMISSION_DENIED,
      stepId,
      '書き込み権限がありません。',
      {
        technicalMessage: `EACCES: ${path}`,
        recoverable: false,
        suggestedAction: 'プロジェクトフォルダの書き込み権限を確認してください。',
      },
    ),

  xmlGenerationFailed: (stepId: PipelineStepId, technicalMessage: string) =>
    make(
      ERROR_CODES.XML_GENERATION_FAILED,
      stepId,
      'Premiere用XMLの生成に失敗しました。',
      { technicalMessage, recoverable: true },
    ),

  cancelled: (stepId: PipelineStepId) =>
    make(ERROR_CODES.CANCELLED, stepId, '処理がユーザーによって中止されました。', {
      recoverable: true,
      suggestedAction: '再開すると、完了済みの工程からやり直せます。',
    }),

  dependencyFailed: (stepId: PipelineStepId, failedDep: PipelineStepId) =>
    make(
      ERROR_CODES.DEPENDENCY_FAILED,
      stepId,
      `依存する工程「${failedDep}」が失敗したため実行できませんでした。`,
      { recoverable: true, suggestedAction: `先に「${failedDep}」の問題を解決してください。` },
    ),

  dependencyNotCompleted: (stepId: PipelineStepId, missingDep: PipelineStepId) =>
    make(
      ERROR_CODES.DEPENDENCY_NOT_COMPLETED,
      stepId,
      `依存する工程「${missingDep}」がまだ完了していません。`,
      {
        recoverable: true,
        suggestedAction: '実行範囲を広げるか、先に全体を1回実行してください。',
      },
    ),

  pathEscapesProject: (stepId: PipelineStepId, path: string) =>
    make(
      ERROR_CODES.PATH_ESCAPES_PROJECT,
      stepId,
      '出力先がプロジェクトフォルダの外を指しています。',
      { technicalMessage: path, recoverable: false },
    ),

  invalidProject: (stepId: PipelineStepId, technicalMessage: string) =>
    make(ERROR_CODES.INVALID_PROJECT, stepId, 'プロジェクトの内容が不正です。', {
      technicalMessage,
      recoverable: false,
    }),

  /** 想定外の例外をラップする。開発者向けメッセージに元の情報を残す。 */
  unknown: (stepId: PipelineStepId, error: unknown) =>
    make(
      ERROR_CODES.UNKNOWN,
      stepId,
      `「${stepId}」の処理中に予期しないエラーが発生しました。`,
      {
        technicalMessage:
          error instanceof Error ? (error.stack ?? error.message) : String(error),
        recoverable: true,
      },
    ),
};

export function isPipelineError(value: unknown): value is PipelineError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'stepId' in value &&
    'userMessage' in value
  );
}
