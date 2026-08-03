/**
 * 再生用プレビューとメディアトークン。
 * ★ffmpeg は起動しない（runFfmpeg を差し替える）。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ensurePreview,
  existingPreview,
  MediaTokenRegistry,
  PREVIEW_AUDIO_ARGS,
  pickPreviewAsset,
  previewPath,
  tokenFromUrl,
  type MediaDeps,
  type PreviewAssetLike,
} from './media.ts';

const DIR = '/tmp/ep012';

const assets: PreviewAssetLike[] = [
  { id: 'micA', role: 'mic_A', fileName: 'mic_A.wav', absolutePath: '/raw/mic_A.wav', hasAudio: true, durationSec: 40 },
  { id: 'wide', role: 'wide', fileName: 'wide.mp4', absolutePath: '/raw/wide.mp4', hasAudio: true, durationSec: 40 },
  { id: 'camA', role: 'cam_A', fileName: 'cam_A.mp4', absolutePath: '/raw/cam_A.mp4', hasAudio: true, durationSec: 40 },
];

function createDeps(files: string[] = []): MediaDeps & { ffmpegCalls: string[][] } {
  const existing = new Set(files);
  const ffmpegCalls: string[][] = [];
  return {
    ffmpegCalls,
    fileExists: (path) => existing.has(path),
    ensureDir: vi.fn(),
    runFfmpeg: async (args) => {
      ffmpegCalls.push(args);
      // 生成成功をまねる
      existing.add(args[args.length - 1]!);
    },
    registry: new MediaTokenRegistry(() => `t${ffmpegCalls.length}-${existing.size}`),
  };
}

describe('MediaTokenRegistry', () => {
  it('★登録したパスだけを解決できる', () => {
    let n = 0;
    const registry = new MediaTokenRegistry(() => `token${(n += 1)}`);
    const token = registry.issue('/tmp/ep012/cache/preview/wide.m4a');

    expect(registry.resolve(token)).toBe('/tmp/ep012/cache/preview/wide.m4a');
    expect(registry.resolve('token-not-issued')).toBeUndefined();
  });

  it('同じパスには同じトークンを返す（無制限に増やさない）', () => {
    let n = 0;
    const registry = new MediaTokenRegistry(() => `token${(n += 1)}`);
    expect(registry.issue('/a')).toBe(registry.issue('/a'));
    expect(registry.size()).toBe(1);
  });

  it('URLを組み立てる', () => {
    const registry = new MediaTokenRegistry(() => 'abc');
    expect(registry.url('/a')).toBe('contentos-media://abc');
  });
});

describe('tokenFromUrl', () => {
  it('トークンを取り出す', () => {
    expect(tokenFromUrl('contentos-media://abc123')).toBe('abc123');
  });

  it('★パス断片を無視する（../ でファイルを辿らせない）', () => {
    expect(tokenFromUrl('contentos-media://abc/../../etc/passwd')).toBe('abc');
    expect(tokenFromUrl('contentos-media://abc?x=1')).toBe('abc');
    expect(tokenFromUrl('contentos-media://abc#y')).toBe('abc');
  });

  it('別スキームは受け付けない', () => {
    expect(tokenFromUrl('file:///etc/passwd')).toBeUndefined();
    expect(tokenFromUrl('http://example.com')).toBeUndefined();
    expect(tokenFromUrl('contentos-media://')).toBeUndefined();
  });
});

describe('pickPreviewAsset', () => {
  it('★wide を優先する（文字起こしと同じ基準）', () => {
    expect(pickPreviewAsset(assets)?.id).toBe('wide');
  });

  it('wide が無ければカメラ、それも無ければ音声つき素材', () => {
    expect(pickPreviewAsset(assets.filter((a) => a.role !== 'wide'))?.id).toBe('camA');
    expect(pickPreviewAsset([assets[0]!])?.id).toBe('micA');
  });

  it('音声が無ければ選ばない', () => {
    expect(pickPreviewAsset([{ ...assets[1]!, hasAudio: false }])).toBeUndefined();
    expect(pickPreviewAsset([])).toBeUndefined();
  });
});

describe('existingPreview', () => {
  it('★すでにある場合だけ返す（ffmpegを走らせない）', () => {
    const path = previewPath(DIR, 'wide');
    const deps = createDeps([path]);
    const media = existingPreview(assets, DIR, deps);

    expect(media?.url.startsWith('contentos-media://')).toBe(true);
    expect(media?.durationSec).toBe(40);
    expect(deps.ffmpegCalls).toHaveLength(0);
  });

  it('未生成なら undefined', () => {
    const deps = createDeps([]);
    expect(existingPreview(assets, DIR, deps)).toBeUndefined();
  });

  it('★絶対パスを返さない（ファイル名のみ）', () => {
    const deps = createDeps([previewPath(DIR, 'wide')]);
    const media = existingPreview(assets, DIR, deps);
    expect(media?.sourceFileName).toBe('wide.mp4');
    expect(JSON.stringify(media)).not.toContain('/raw/');
    expect(JSON.stringify(media)).not.toContain(DIR);
  });
});

describe('ensurePreview', () => {
  it('★未生成なら低ビットレート音声を作る', async () => {
    const deps = createDeps(['/raw/wide.mp4']);
    const media = await ensurePreview(assets, DIR, deps);

    expect(media).toBeDefined();
    expect(deps.ffmpegCalls).toHaveLength(1);
    const args = deps.ffmpegCalls[0]!;
    expect(args).toContain('-vn');
    for (const arg of PREVIEW_AUDIO_ARGS) expect(args).toContain(arg);
  });

  it('★出力先は cache/preview 配下で、入力と別ファイル（原音を上書きしない）', async () => {
    const deps = createDeps(['/raw/wide.mp4']);
    await ensurePreview(assets, DIR, deps);

    const args = deps.ffmpegCalls[0]!;
    const output = args[args.length - 1]!;
    const input = args[args.indexOf('-i') + 1]!;

    expect(output).toBe(`${DIR}/cache/preview/wide.m4a`);
    expect(input).toBe('/raw/wide.mp4');
    expect(output).not.toBe(input);
  });

  it('すでにあれば作り直さない', async () => {
    const deps = createDeps(['/raw/wide.mp4', previewPath(DIR, 'wide')]);
    await ensurePreview(assets, DIR, deps);
    expect(deps.ffmpegCalls).toHaveLength(0);
  });

  it('元素材が無ければ生成しない', async () => {
    const deps = createDeps([]);
    expect(await ensurePreview(assets, DIR, deps)).toBeUndefined();
    expect(deps.ffmpegCalls).toHaveLength(0);
  });

  it('音声つき素材が無ければ undefined', async () => {
    const deps = createDeps([]);
    expect(await ensurePreview([], DIR, deps)).toBeUndefined();
  });
});
