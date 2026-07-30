/**
 * プロジェクトごとの構造化ログ。
 *
 * ★ `LogEntry`（types.ts）に無いフィールドは物理的に書き込めない。
 * これにより、APIキー・音声内容・字幕全文・文字起こし全文が誤って
 * ログに混入することを型レベルで防ぐ。呼び出し側が「うっかり全文を渡す」
 * ことはできても、それを受け取るフィールド自体が存在しない。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { join } from 'node:path';

import type { LogEntry, PipelineStepId } from './types.ts';

export interface ProjectLogger {
  write: (entry: LogEntry) => void;
  filePath: string;
}

/** 実行ごとに1ファイル（logs/run-<timestamp>.jsonl）に書く。 */
export function createProjectLogger(
  logsDir: string,
  now: Date = new Date(),
): ProjectLogger {
  mkdirSync(logsDir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const filePath = join(logsDir, `run-${stamp}.jsonl`);

  return {
    filePath,
    write(entry) {
      appendFileSync(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    },
  };
}

/** ファイル一覧をログに安全な形（basenameのみ）に変換する。 */
export function toLoggableFileNames(paths: readonly string[]): string[] {
  return paths.map((p) => basename(p));
}

/** ある工程用のログ書き込み関数を作る。StepContext.log として渡す。 */
export function scopedLogger(
  logger: ProjectLogger,
  stepId: PipelineStepId,
  now: () => Date,
) {
  return (fields: Omit<LogEntry, 'at' | 'stepId'>): void => {
    logger.write({ at: now().toISOString(), stepId, ...fields });
  };
}
