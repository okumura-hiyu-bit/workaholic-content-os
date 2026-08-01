/**
 * リポジトリルート（projectRoot）の解決と、実行環境の事前チェック。
 *
 * ★なぜ必要か
 * packages/media/src/transcribe.ts は scripts/transcribe.py と .venv を
 * `projectRoot ?? process.cwd()` から解決する。CLIはリポジトリルートで
 * 起動されるので cwd で足りていたが、**Electronアプリのcwdはリポジトリルート
 * ではない**（macOSでは `/` になることすらある）。
 *
 * ★方針：cwdを一切読まない
 * ここで明示的にリポジトリルートを求め、解析専用プロセスの cwd として固定する。
 * 「たまたま正しいcwdで起動されていること」に依存しない。
 *
 * ★テスト可能にするため fs には直接触らない
 * 存在確認は呼び出し側から関数として渡す（RootResolverDeps）。
 */

import { dirname, join } from 'node:path';

import type { SafePipelineError } from '../shared/dto.ts';
import { DESKTOP_ERROR_CODES, safeError } from '../shared/errors.ts';

export interface RootResolverDeps {
  fileExists(path: string): boolean;
  readTextFile(path: string): string | undefined;
}

export interface RootResolverInput {
  /** ユーザー設定・環境変数による明示指定（最優先）。 */
  explicitRoot?: string | undefined;
  /** app.isPackaged */
  isPackaged: boolean;
  /** process.resourcesPath（パッケージ時） */
  resourcesPath?: string | undefined;
  /** app.getAppPath()。開発時の探索開始点。 */
  appPath: string;
}

export type RootResolution =
  | { ok: true; projectRoot: string; source: 'explicit' | 'resources' | 'repo' }
  | { ok: false; error: SafePipelineError };

const ROOT_PACKAGE_NAME = 'workaholic-content-os';

/** package.json の name がリポジトリルートのものかを判定する。 */
function isRepoRoot(dir: string, deps: RootResolverDeps): boolean {
  const raw = deps.readTextFile(join(dir, 'package.json'));
  if (raw === undefined) return false;
  try {
    const parsed = JSON.parse(raw) as { name?: unknown };
    return parsed.name === ROOT_PACKAGE_NAME;
  } catch {
    return false;
  }
}

/** 開始ディレクトリから上へたどってリポジトリルートを探す。 */
function findRepoRoot(startDir: string, deps: RootResolverDeps): string | undefined {
  let dir = startDir;
  // 最大でも十数階層。ルート（'/'）に達したら終了する。
  for (let i = 0; i < 32; i += 1) {
    if (isRepoRoot(dir, deps)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * projectRoot を解決する。
 *
 * 優先順位
 *   1. ユーザー設定・環境変数（CONTENTOS_PROJECT_ROOT）
 *   2. パッケージされたアプリの resources
 *   3. 開発時のリポジトリルート（appPathから上へ探索）
 *
 * ★process.cwd() は一切参照しない。
 */
export function resolveProjectRoot(
  input: RootResolverInput,
  deps: RootResolverDeps,
): RootResolution {
  if (input.explicitRoot !== undefined && input.explicitRoot.trim() !== '') {
    const root = input.explicitRoot.trim();
    if (!deps.fileExists(join(root, 'package.json'))) {
      return {
        ok: false,
        error: safeError(
          DESKTOP_ERROR_CODES.PROJECT_ROOT_NOT_FOUND,
          '指定された実行環境のパスが見つかりません。',
          {
            recoverable: true,
            suggestedAction:
              '環境変数 CONTENTOS_PROJECT_ROOT に、workaholic-content-os のフォルダを指定してください。',
          },
        ),
      };
    }
    return { ok: true, projectRoot: root, source: 'explicit' };
  }

  if (input.isPackaged && input.resourcesPath) {
    const root = join(input.resourcesPath, 'app');
    if (deps.fileExists(join(root, 'package.json'))) {
      return { ok: true, projectRoot: root, source: 'resources' };
    }
    if (deps.fileExists(join(input.resourcesPath, 'package.json'))) {
      return { ok: true, projectRoot: input.resourcesPath, source: 'resources' };
    }
  }

  const repoRoot = findRepoRoot(input.appPath, deps);
  if (repoRoot !== undefined) {
    return { ok: true, projectRoot: repoRoot, source: 'repo' };
  }

  return {
    ok: false,
    error: safeError(
      DESKTOP_ERROR_CODES.PROJECT_ROOT_NOT_FOUND,
      '実行環境（workaholic-content-os フォルダ）を見つけられませんでした。',
      {
        recoverable: true,
        suggestedAction:
          '環境変数 CONTENTOS_PROJECT_ROOT に workaholic-content-os のフォルダを指定して起動してください。',
      },
    ),
  };
}

// ─── 実行環境の事前チェック ────────────────────────────

export interface PreflightResult {
  ok: boolean;
  error?: SafePipelineError;
}

/**
 * 解析を始める前に、必要なものが揃っているかを確認する。
 *
 * ★ここで止める理由
 * 揃っていないと解析は必ず失敗するが、失敗するのが文字起こし工程（12番目）
 * だと、そこまでの数分〜十数分が無駄になる。開始前に分かることは開始前に返す。
 */
export function preflightEnvironment(
  projectRoot: string,
  deps: RootResolverDeps,
): PreflightResult {
  // ① ビルド済みのパイプライン（解析専用プロセスが読み込む本体）
  for (const rel of ['dist/pipeline.js', 'dist/core.js']) {
    if (!deps.fileExists(join(projectRoot, rel))) {
      return {
        ok: false,
        error: safeError(
          DESKTOP_ERROR_CODES.ENVIRONMENT_NOT_READY,
          '解析エンジンがまだビルドされていません。',
          {
            recoverable: true,
            suggestedAction:
              'ターミナルで npm run build を実行してから、もう一度お試しください。',
          },
        ),
      };
    }
  }

  // ② Pythonブリッジ
  if (!deps.fileExists(join(projectRoot, 'scripts', 'transcribe.py'))) {
    return {
      ok: false,
      error: safeError(
        DESKTOP_ERROR_CODES.ENVIRONMENT_NOT_READY,
        '文字起こし用のスクリプト（scripts/transcribe.py）が見つかりません。',
        {
          recoverable: true,
          suggestedAction:
            'workaholic-content-os フォルダが壊れていないか確認してください。',
        },
      ),
    };
  }

  // ③ Python仮想環境
  if (!deps.fileExists(join(projectRoot, '.venv', 'bin', 'python'))) {
    return {
      ok: false,
      error: safeError(
        DESKTOP_ERROR_CODES.ENVIRONMENT_NOT_READY,
        '文字起こしに必要なPython環境（.venv）が見つかりません。',
        {
          recoverable: true,
          suggestedAction:
            'ターミナルで python3 -m venv .venv && .venv/bin/pip install faster-whisper を実行してください。',
        },
      ),
    };
  }

  return { ok: true };
}
