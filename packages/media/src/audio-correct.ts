/**
 * 音声補正（非破壊）。
 *
 * ★原音を書き換えることは絶対にしない。補正音は別ファイルとして出力する。
 * 「気をつける」ではなく、出力先が入力と同一なら実行前に例外で止める構造にする。
 *
 * @see docs/12-premiere-capability-matrix.md 12.7
 */

import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { resolveBinary } from './ffmpeg.ts';
import { runProcess } from './process.ts';

export interface CorrectionSettings {
  /** false なら補正音を生成しない（案件ごとに切り替える）。 */
  enabled: boolean;
  noiseReduction: boolean;
  loudness: boolean;
  /** 動画用は -14 LUFS、ポッドキャスト用は -16 LUFS。 */
  targetLufs: number;
  /** トゥルーピークの上限（dBTP）。 */
  truePeakDb: number;
}

export const DEFAULT_CORRECTION: CorrectionSettings = {
  enabled: true,
  noiseReduction: true,
  loudness: true,
  targetLufs: -14,
  truePeakDb: -1,
};

/**
 * 出力先が入力を上書きしないことを検証する。
 *
 * パスを正規化してから比較する。`./a.wav` と `a.wav` のような表記差で
 * 検査をすり抜けないようにするため。
 */
export function assertNonDestructive(inputPath: string, outputPath: string): void {
  const input = resolve(inputPath);
  const output = resolve(outputPath);

  if (input === output) {
    throw new Error(
      `原音を上書きしようとしました。補正音は別ファイルに出力してください。\n` +
        `  入力: ${input}\n  出力: ${output}`,
    );
  }

  // シンボリックリンクやハードリンクで同一実体を指す場合も弾く。
  if (existsSync(output)) {
    try {
      const a = statSync(input);
      const b = statSync(output);
      if (a.ino !== 0 && a.ino === b.ino && a.dev === b.dev) {
        throw new Error(
          `出力先が原音と同一のファイル実体を指しています。\n` +
            `  入力: ${input}\n  出力: ${output}`,
        );
      }
    } catch (error) {
      // statSync 自体の失敗（権限など）は上書き判定の対象外。
      if (error instanceof Error && error.message.startsWith('出力先が')) throw error;
    }
  }
}

export interface CorrectionReport {
  inputPath: string;
  outputPath: string;
  settings: CorrectionSettings;
  /** 補正前のラウドネス（LUFS）。測定できなかった場合は undefined。 */
  inputLufs?: number;
  /** 適用したフィルタ列。何をしたかを記録に残す。 */
  filters: string[];
}

interface LoudnormStats {
  inputI?: number;
  inputTp?: number;
  inputLra?: number;
  inputThresh?: number;
  targetOffset?: number;
}

/**
 * loudnorm の1パス目でラウドネスを測定する。
 *
 * ★loudnorm は測定結果のJSONを **stderr** に出力する。stdout だけを見ると
 * 常に空になり、2パス目が測定値なしの動的正規化になってしまう（実際にその
 * 不具合を出した）。stdout と stderr の両方を読む必要がある。
 */
async function measureLoudness(
  inputPath: string,
  settings: CorrectionSettings,
  signal?: AbortSignal,
): Promise<LoudnormStats> {
  const filter =
    `loudnorm=I=${settings.targetLufs}:TP=${settings.truePeakDb}` +
    `:LRA=11:print_format=json`;

  const result = await runProcess(
    resolveBinary('ffmpeg'),
    ['-hide_banner', '-nostats', '-i', inputPath, '-af', filter, '-f', 'null', '-'],
    { signal, maxBufferBytes: 16 * 1024 * 1024 },
  );

  return parseLoudnorm(`${result.stdout}\n${result.stderr}`);
}

/** loudnorm の出力JSONを取り出す。見つからなければ空を返す。 */
export function parseLoudnorm(output: string): LoudnormStats {
  const match = output.match(/\{[^{}]*"input_i"[\s\S]*?\}/);
  if (!match) return {};
  try {
    const json = JSON.parse(match[0]) as Record<string, string>;
    const num = (key: string) => {
      const value = Number.parseFloat(json[key] ?? '');
      return Number.isFinite(value) ? value : undefined;
    };
    return {
      inputI: num('input_i'),
      inputTp: num('input_tp'),
      inputLra: num('input_lra'),
      inputThresh: num('input_thresh'),
      targetOffset: num('target_offset'),
    };
  } catch {
    return {};
  }
}

/**
 * 補正音を生成する。
 *
 * 原音は読み取りのみ。出力は必ず別ファイル。
 * `signal` を渡すと、ユーザーによる中止でffmpegプロセスを確実に止められる
 * （spawnにsignalを渡す方式。実測で長尺素材のノイズ低減・ラウドネス測定は
 * 数十秒かかりうるため、中止の即時性が要る）。
 */
export async function correctAudio(
  inputPath: string,
  outputPath: string,
  settings: Partial<CorrectionSettings> = {},
  signal?: AbortSignal,
): Promise<CorrectionReport> {
  const config = { ...DEFAULT_CORRECTION, ...settings };

  // ★何よりも先に上書きチェックを行う。
  assertNonDestructive(inputPath, outputPath);

  if (!config.enabled) {
    throw new Error(
      '補正が無効（correction.enabled = false）の設定で correctAudio が呼ばれました',
    );
  }

  const filters: string[] = [];
  let stats: LoudnormStats = {};

  if (config.noiseReduction) {
    // 定常的な環境ノイズ（空調音など）の低減。控えめな設定にする。
    // 強くかけると声の質感が損なわれ、編集者が原音に戻すことになる。
    filters.push('afftdn=nr=12:nf=-40');
  }

  if (config.loudness) {
    stats = await measureLoudness(inputPath, config, signal);
    const measured =
      stats.inputI !== undefined
        ? `:measured_I=${stats.inputI}` +
          `:measured_TP=${stats.inputTp ?? 0}` +
          `:measured_LRA=${stats.inputLra ?? 0}` +
          `:measured_thresh=${stats.inputThresh ?? -70}` +
          `:offset=${stats.targetOffset ?? 0}:linear=true`
        : '';
    filters.push(
      `loudnorm=I=${config.targetLufs}:TP=${config.truePeakDb}:LRA=11${measured}`,
    );
  }

  if (filters.length === 0) {
    throw new Error('適用する補正が1つもありません');
  }

  mkdirSync(dirname(outputPath), { recursive: true });

  const result = await runProcess(
    resolveBinary('ffmpeg'),
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', inputPath,
      '-af', filters.join(','),
      '-c:a', 'pcm_s16le',
      outputPath,
    ],
    { signal, maxBufferBytes: 64 * 1024 * 1024 },
  );

  if (result.code !== 0) {
    throw new Error(`ffmpegによる音声補正に失敗しました（code ${result.code}）:\n${result.stderr}`);
  }

  return {
    inputPath,
    outputPath,
    settings: config,
    inputLufs: stats.inputI,
    filters,
  };
}

/** 補正音の出力先を決める。原音と必ず別ディレクトリになる。 */
export function correctedPathFor(episodeDir: string, micId: string): string {
  return resolve(episodeDir, 'audio', 'processed', `${micId}.corrected.wav`);
}
