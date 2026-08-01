/**
 * 解析専用プロセスの起動。
 *
 * ★方式の選定：child_process.fork（Electronのバイナリを Node モードで使う）
 *
 * Electron の `utilityProcess` と比較して fork を選んだ理由：
 *
 * 1. **ESMをそのまま扱える**
 *    解析専用プロセスは projectRoot 配下の `dist/pipeline.js`（ESM）を
 *    動的importする。Nodeとして起動すれば標準のESMがそのまま使える。
 *
 * 2. **テストできる**
 *    utilityProcess は Electron ランタイムの中でしか存在しない。
 *    fork なら起動の抽象（AnalysisProcessSpawner）を差し替えるだけで、
 *    Electronを起動せずに開始・進捗・中止・異常終了をテストできる。
 *    今回のテスト要件（二重実行拒否・異常終了時のロック解除など）は
 *    この差し替えが前提になる。
 *
 * 3. **システムのNodeに依存しない**
 *    `execPath: process.execPath` + `ELECTRON_RUN_AS_NODE=1` により、
 *    Electronに同梱されたNodeで動く。利用者のマシンにNodeが無くてもよい。
 *
 * utilityProcess の利点（Electron側でのライフサイクル管理、プロセス種別の
 * 明示）は、アプリ終了時の明示的な kill（run-manager.ts の disposeAll）で
 * 代替している。
 */

import { fork } from 'node:child_process';

import type { WorkerInbound, WorkerOutbound } from '../shared/worker-protocol.ts';

export interface AnalysisProcess {
  send(message: WorkerInbound): void;
  kill(): void;
  onMessage(listener: (message: WorkerOutbound) => void): void;
  onExit(listener: (info: { code: number | null; signal: string | null }) => void): void;
}

export interface SpawnOptions {
  /** リポジトリルート。★解析プロセスのcwdとして固定する。 */
  projectRoot: string;
  /** ビルド済みワーカースクリプトの絶対パス。 */
  workerPath: string;
}

export type AnalysisProcessSpawner = (options: SpawnOptions) => AnalysisProcess;

/**
 * 実プロセスを起動する。
 *
 * ★cwd に projectRoot を指定しているのが要点。
 * packages/media の transcribe() は projectRoot 未指定時に process.cwd() から
 * scripts/transcribe.py と .venv を解決する。解析プロセスのcwdをここで
 * リポジトリルートに固定することで、Electronアプリのcwd（リポジトリルート
 * ではない）に一切依存しなくなる。
 */
export const forkAnalysisProcess: AnalysisProcessSpawner = ({
  projectRoot,
  workerPath,
}) => {
  const child = fork(workerPath, [], {
    cwd: projectRoot,
    execPath: process.execPath,
    env: {
      ...process.env,
      // Electronのバイナリを素のNodeとして動かす。
      ELECTRON_RUN_AS_NODE: '1',
      // 解析プロセスにも基準を明示的に渡す（cwdと二重の担保）。
      CONTENTOS_PROJECT_ROOT: projectRoot,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  return {
    send(message) {
      if (child.connected) child.send(message);
    },
    kill() {
      if (!child.killed) child.kill('SIGTERM');
    },
    onMessage(listener) {
      child.on('message', (raw) => listener(raw as WorkerOutbound));
    },
    onExit(listener) {
      child.on('exit', (code, signal) => listener({ code, signal }));
    },
  };
};
