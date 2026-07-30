/**
 * キャンセル可能な子プロセス実行。
 *
 * ★シェル文字列を組み立てない。常に「実行ファイル＋引数配列」で呼ぶ
 * （`shell: true` は使わない）。これによりファイル名に日本語・空白・記号
 * （`&`, `;`, `$()` 等）が入っていてもインジェクションの心配なく動く。
 *
 * ★AbortSignal を渡すと、中止時に子プロセスがSIGTERMで確実に止まる
 * （Node 15+ の `spawn(..., { signal })` を利用）。
 */

import { spawn } from 'node:child_process';

export interface RunProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface RunProcessOptions {
  signal?: AbortSignal;
  cwd?: string;
  /** 標準出力が巨大になりうる場合の上限（バイト）。超えたら打ち切る。 */
  maxBufferBytes?: number;
}

/**
 * コマンドを実行する。★args は必ず配列で渡す（文字列結合しない）。
 *
 * AbortSignal が中止された場合、Error('The operation was aborted') 相当の
 * 例外ではなく、呼び出し側が判定しやすいよう `aborted: true` を投げる。
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {},
): Promise<RunProcessResult> {
  return new Promise((resolvePromise, reject) => {
    if (options.signal?.aborted) {
      reject(new AbortError());
      return;
    }

    const child = spawn(command, [...args], {
      cwd: options.cwd,
      signal: options.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const maxBuffer = options.maxBufferBytes ?? 256 * 1024 * 1024;
    let overflowed = false;

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBuffer) stdout += chunk.toString('utf8');
      else overflowed = true;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBuffer) stderr += chunk.toString('utf8');
      else overflowed = true;
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.name === 'AbortError' || options.signal?.aborted) {
        reject(new AbortError());
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      if (options.signal?.aborted) {
        reject(new AbortError());
        return;
      }
      if (overflowed) stderr += '\n[出力が大きすぎるため打ち切りました]';
      resolvePromise({ stdout, stderr, code });
    });
  });
}

/** ユーザーによる中止を表す例外。 */
export class AbortError extends Error {
  constructor() {
    super('The operation was aborted');
    this.name = 'AbortError';
  }
}

export function isAbortError(error: unknown): error is AbortError {
  return (
    error instanceof AbortError ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/** signal.aborted なら即座に中止例外を投げる。長い処理の合間に呼ぶ。 */
export function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AbortError();
}
