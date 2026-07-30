/**
 * ffmpeg / ffprobe の呼び出し。
 *
 * バイナリは PATH に無い場合がある（Homebrew on Apple Silicon の
 * /opt/homebrew/bin は、GUIアプリから起動したプロセスのPATHに入らないことが多い）。
 * そのため PATH だけに頼らず、環境変数と既知の設置先を順に探す。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const CANDIDATE_DIRS = [
  '/opt/homebrew/bin', // Homebrew (Apple Silicon)
  '/usr/local/bin', // Homebrew (Intel) / 手動導入
  '/opt/local/bin', // MacPorts
];

const resolved = new Map<string, string>();

/**
 * ffmpeg / ffprobe の実行パスを解決する。
 *
 * 優先順: 環境変数（FFMPEG_PATH / FFPROBE_PATH）→ PATH → 既知の設置先。
 */
export function resolveBinary(name: 'ffmpeg' | 'ffprobe'): string {
  const cached = resolved.get(name);
  if (cached) return cached;

  const envKey = name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH';
  const fromEnv = process.env[envKey];
  if (fromEnv && existsSync(fromEnv)) {
    resolved.set(name, fromEnv);
    return fromEnv;
  }

  // PATH 上にあるか（-version が成功するかで判定する）。
  const probe = spawnSync(name, ['-version'], { stdio: 'ignore' });
  if (probe.status === 0) {
    resolved.set(name, name);
    return name;
  }

  for (const dir of CANDIDATE_DIRS) {
    const path = `${dir}/${name}`;
    if (existsSync(path)) {
      resolved.set(name, path);
      return path;
    }
  }

  throw new Error(
    `${name} が見つかりません。\n` +
      `  brew install ffmpeg でインストールするか、環境変数 ${envKey} に実行パスを設定してください。\n` +
      `  探した場所: PATH, ${CANDIDATE_DIRS.join(', ')}`,
  );
}

export interface MediaInfo {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  /** 映像のフレームレート（分数表記を解決した値）。 */
  fps?: number;
  audioChannels?: number;
  audioSampleRate?: number;
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
}

/** ffprobe で素材の情報を読む。 */
export function probeMedia(path: string): MediaInfo {
  const raw = execFileSync(
    resolveBinary('ffprobe'),
    [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      path,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );

  const parsed = JSON.parse(raw) as {
    format?: { duration?: string };
    streams?: FfprobeStream[];
  };

  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  let fps: number | undefined;
  if (video?.r_frame_rate) {
    const [num, den] = video.r_frame_rate.split('/').map(Number);
    if (num && den) fps = num / den;
  }

  const duration = Number.parseFloat(parsed.format?.duration ?? '');
  if (!Number.isFinite(duration)) {
    throw new Error(`尺を取得できませんでした: ${path}`);
  }

  return {
    durationSec: duration,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width,
    height: video?.height,
    fps,
    audioChannels: audio?.channels,
    audioSampleRate: audio?.sample_rate
      ? Number.parseInt(audio.sample_rate, 10)
      : undefined,
  };
}

export interface DecodedAudio {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * 音声をモノラルの32bit float PCMとして読み出す。
 *
 * 同期解析・話者判定には高いサンプルレートが不要なため、既定で8kHzに
 * ダウンサンプルする。処理量を数十分の1にでき、精度は落ちない
 * （どちらも音量の時間変化しか見ないため）。
 */
export function decodeAudioMono(
  path: string,
  sampleRate = 8000,
): DecodedAudio {
  const result = spawnSync(
    resolveBinary('ffmpeg'),
    [
      '-v', 'error',
      '-i', path,
      '-vn',
      '-ac', '1',
      '-ar', String(sampleRate),
      '-f', 'f32le',
      '-',
    ],
    { maxBuffer: 512 * 1024 * 1024 },
  );

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? '';
    throw new Error(`音声の読み出しに失敗しました: ${path}\n${stderr}`);
  }

  const buffer = result.stdout;
  // Buffer の先頭が4バイト境界に無い場合があるためコピーしてから解釈する。
  const aligned =
    buffer.byteOffset % 4 === 0
      ? buffer
      : Buffer.from(buffer);

  const samples = new Float32Array(
    aligned.buffer,
    aligned.byteOffset,
    Math.floor(aligned.byteLength / 4),
  );

  return { samples, sampleRate };
}

/** ffmpeg / ffprobe が使えるかを確認する。導入案内のために使う。 */
export function checkFfmpegAvailable(): { ok: boolean; message: string } {
  try {
    const ffmpeg = resolveBinary('ffmpeg');
    const ffprobe = resolveBinary('ffprobe');
    const version = execFileSync(ffmpeg, ['-version'], { encoding: 'utf8' })
      .split('\n')[0]
      ?.trim();
    return { ok: true, message: `${version}\n  ffmpeg: ${ffmpeg}\n  ffprobe: ${ffprobe}` };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}
