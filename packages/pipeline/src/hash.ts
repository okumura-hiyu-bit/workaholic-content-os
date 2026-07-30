/**
 * 入力・設定のハッシュ計算。
 *
 * ★これが「再解析しても完了済み工程はスキップできる」仕組みの根拠。
 * 素材の中身までは読まない（動画は数GB〜数十GBあり、毎回読むと遅すぎる）。
 * サイズ＋更新時刻を「実質的な内容の指紋」として使う。同名同サイズ同時刻の
 * 別内容ファイルに差し替えられた場合は検知できないが、この用途では
 * 十分な精度と割り切る（GUIには「最初から再解析」を必ず残す）。
 */

import { createHash } from 'node:crypto';

/** オブジェクトをキー順序に依存しない形で正規化してJSON化する。 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      );
    }
    return v;
  });
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32);
}

/** 設定オブジェクトのハッシュ。 */
export function hashConfig(config: unknown): string {
  return sha256(canonicalize(config));
}

export interface FileFingerprint {
  path: string;
  sizeBytes?: number;
  mtimeMs?: number;
}

/** 素材ファイルの指紋からハッシュを作る。 */
export function hashAssetFingerprints(
  files: readonly FileFingerprint[],
): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  return sha256(
    canonicalize(
      sorted.map((f) => `${f.path}:${f.sizeBytes ?? '?'}:${f.mtimeMs ?? '?'}`),
    ),
  );
}

/**
 * 依存工程の出力ハッシュから、この工程の入力ハッシュを作る。
 *
 * これにより連鎖的な無効化が成立する：上流工程の出力が変われば、
 * ここで計算される入力ハッシュも変わり、下流工程は自動的にキャッシュミスになる。
 */
export function hashFromDependencyOutputs(
  depOutputHashes: readonly (string | undefined)[],
  extra?: unknown,
): string {
  return sha256(
    canonicalize({ deps: depOutputHashes, extra: extra ?? null }),
  );
}
