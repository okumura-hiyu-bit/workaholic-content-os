/**
 * 確認画面の再生用プレビュー音声。
 *
 * ★4K素材をそのまま再生しない。
 * 確認に必要なのは音と時間軸なので、低ビットレートのモノラル音声だけを作る。
 * 10分の収録でも数MBに収まり、Rendererが素直に再生できる。
 *
 * ★元素材を変更しない。
 * 生成先は必ず `<projectDir>/cache/preview/` の別ファイル。入力と出力が
 * 同じパスになる呼び出しは行わない（原音を上書きしない方針を守る）。
 *
 * ★Rendererに絶対パスを渡さない。
 * `contentos-media://<token>` というURLだけを渡し、tokenからパスへの変換は
 * このレジストリだけが知る。Rendererが任意のファイルを要求できない。
 */

import { join } from 'node:path';

import type { ReviewMedia } from '../shared/review-dto.ts';

export const MEDIA_PROTOCOL = 'contentos-media';

/** プレビューの音声設定。確認用途に足りる最低限。 */
export const PREVIEW_AUDIO_ARGS = [
  '-vn', // 映像は捨てる
  '-ac', '1', // モノラル
  '-ar', '32000', // 32kHz
  '-b:a', '64k', // 64kbps
] as const;

// ─── トークン ──────────────────────────────────────────

/**
 * token → 実ファイルパス の対応表。
 * ★Mainが明示的に登録したパスしか解決できない。
 */
export class MediaTokenRegistry {
  private readonly byToken = new Map<string, string>();
  private readonly byPath = new Map<string, string>();

  constructor(private readonly makeToken: () => string) {}

  /** パスを登録し、URLに使うトークンを返す。同じパスには同じトークンを返す。 */
  issue(absolutePath: string): string {
    const existing = this.byPath.get(absolutePath);
    if (existing !== undefined) return existing;
    const token = this.makeToken();
    this.byToken.set(token, absolutePath);
    this.byPath.set(absolutePath, token);
    return token;
  }

  /** 未登録のトークンは undefined。★ここが任意ファイル読み出しの防波堤。 */
  resolve(token: string): string | undefined {
    return this.byToken.get(token);
  }

  url(absolutePath: string): string {
    return `${MEDIA_PROTOCOL}://${this.issue(absolutePath)}`;
  }

  size(): number {
    return this.byToken.size;
  }
}

/** `contentos-media://<token>` から token を取り出す。 */
export function tokenFromUrl(url: string): string | undefined {
  const prefix = `${MEDIA_PROTOCOL}://`;
  if (!url.startsWith(prefix)) return undefined;
  // ホスト部だけを使う。パス・クエリが付いていても無視する
  // （`contentos-media://token/../../etc/passwd` を成立させないため）。
  const rest = url.slice(prefix.length);
  const token = rest.split(/[/?#]/)[0] ?? '';
  return token.length > 0 ? token : undefined;
}

// ─── プレビューの場所と対象素材 ────────────────────────

export interface PreviewAssetLike {
  id: string;
  role: string;
  fileName: string;
  absolutePath: string;
  hasAudio: boolean;
  durationSec: number;
}

/**
 * プレビューを作る素材を選ぶ。
 * 文字起こしと同じ基準（wide優先）にして、字幕と音がずれないようにする。
 */
export function pickPreviewAsset(
  assets: readonly PreviewAssetLike[],
): PreviewAssetLike | undefined {
  return (
    assets.find((a) => a.role === 'wide' && a.hasAudio) ??
    assets.find((a) => a.role.startsWith('cam_') && a.hasAudio) ??
    assets.find((a) => a.hasAudio)
  );
}

export function previewPath(projectDir: string, assetId: string): string {
  return join(projectDir, 'cache', 'preview', `${assetId}.m4a`);
}

// ─── 生成 ──────────────────────────────────────────────

export interface MediaDeps {
  fileExists(path: string): boolean;
  ensureDir(path: string): void;
  /** ffmpeg を実行する。テストでは差し替えて実行しない。 */
  runFfmpeg(args: string[]): Promise<void>;
  registry: MediaTokenRegistry;
}

function toMedia(
  asset: PreviewAssetLike,
  path: string,
  registry: MediaTokenRegistry,
): ReviewMedia {
  return {
    url: registry.url(path),
    durationSec: asset.durationSec,
    // ★絶対パスは渡さない。表示用のファイル名だけ。
    sourceFileName: asset.fileName,
  };
}

/**
 * すでに生成済みのプレビューがあれば返す。無ければ undefined。
 * ★review:load から呼ぶ。読み込みのたびにffmpegを走らせない。
 */
export function existingPreview(
  assets: readonly PreviewAssetLike[],
  projectDir: string,
  deps: MediaDeps,
): ReviewMedia | undefined {
  const asset = pickPreviewAsset(assets);
  if (asset === undefined) return undefined;
  const path = previewPath(projectDir, asset.id);
  if (!deps.fileExists(path)) return undefined;
  return toMedia(asset, path, deps.registry);
}

/**
 * プレビューを用意する（無ければ生成する）。
 * ★review:open-media から呼ぶ。生成には時間がかかるので非同期にし、
 * メインプロセスを止めない。
 */
export async function ensurePreview(
  assets: readonly PreviewAssetLike[],
  projectDir: string,
  deps: MediaDeps,
): Promise<ReviewMedia | undefined> {
  const asset = pickPreviewAsset(assets);
  if (asset === undefined) return undefined;

  const output = previewPath(projectDir, asset.id);
  if (!deps.fileExists(output)) {
    if (!deps.fileExists(asset.absolutePath)) return undefined;
    // ★入力と出力が同じになることはない（出力は cache/preview 配下の .m4a）。
    deps.ensureDir(join(projectDir, 'cache', 'preview'));
    await deps.runFfmpeg([
      '-y',
      '-i', asset.absolutePath,
      ...PREVIEW_AUDIO_ARGS,
      output,
    ]);
    if (!deps.fileExists(output)) return undefined;
  }

  return toMedia(asset, output, deps.registry);
}
