/**
 * 文字起こし（faster-whisper・ローカル実行）。
 *
 * Pythonブリッジ（scripts/transcribe.py）を呼び出し、結果を型付きで返す。
 * 後処理はすべてTypeScript側で行い、Pythonには faster-whisper の呼び出しだけを
 * 任せる。テストできる範囲をTypeScript側に寄せるため。
 *
 * ★VAD（無音除去）は既定で無効。沈黙・間は作品の一部であり、文字起こしの
 * 都合で時間軸を詰めてはならない。
 *
 * @see docs/11-editing-pipeline.md 11.3③
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { Word } from '../../editing/src/types.ts';
import { runProcess } from './process.ts';

export interface TranscriptSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface TranscriptWord extends Word {
  /** 認識の確からしさ（0〜1）。低い語は字幕確認画面で目印にする。 */
  probability?: number;
}

/**
 * 工程内の細かい時間内訳（秒）。
 *
 * 「7.5秒の音声に9.6秒」がモデル読込込みなのか純粋な推論時間なのかを
 * 明確にするための計測。scripts/transcribe.py が計測して返す。
 */
export interface TranscribeTimings {
  modelLoadSec: number;
  /** 音声デコード・特徴量抽出・言語検出。 */
  preprocessSec: number;
  /** 実際のデコード（推論）。ここが音声尺に対して伸びると重い処理。 */
  inferenceSec: number;
  postprocessSec: number;
  jsonSec: number;
  totalSec: number;
}

export interface Transcript {
  language: string;
  languageProbability?: number;
  durationSec: number;
  model: string;
  vadFilter: boolean;
  words: TranscriptWord[];
  segments: TranscriptSegment[];
  timings?: TranscribeTimings;
}

/**
 * 語彙ヒントを組む。
 *
 * ⚠️ **実測では `small` モデルの誤認識をこのヒントでは直せませんでした**
 * （「自己紹介」→「事故紹介」が残る）。モデルを `large-v3` にすると解消したため、
 * 精度はモデル選択が主で、ヒントは補助と考えるのが妥当です。
 * 固有名詞（ゲスト名・企業名）には効く可能性があるため渡しますが、
 * これに依存した設計にはしません。
 */
export function buildVocabularyPrompt(input: {
  theme?: string;
  speakers: readonly { name: string; title?: string }[];
  keywords: readonly string[];
}): string | undefined {
  const terms: string[] = [];
  if (input.theme) terms.push(input.theme);
  for (const speaker of input.speakers) {
    terms.push(speaker.name);
    if (speaker.title) terms.push(speaker.title);
  }
  terms.push(...input.keywords);

  const unique = [...new Set(terms.map((s) => s.trim()).filter(Boolean))];
  if (unique.length === 0) return undefined;

  // Whisperのプロンプトは長すぎると効果が薄れるため、上限を設ける。
  const MAX_LENGTH = 200;
  let prompt = '';
  for (const term of unique) {
    const next = prompt ? `${prompt}、${term}` : term;
    if (next.length > MAX_LENGTH) break;
    prompt = next;
  }
  return prompt || undefined;
}

export interface TranscribeOptions {
  /**
   * モデル名。★既定は `large-v3`。
   *
   * 実測で `small` は日本語の同音異義語を誤認識した（「自己紹介」→「事故紹介」、
   * 「辞退率」→「自体率」）。`large-v3` では両方とも正しく認識されたため、
   * 業務用語が頻出する本用途では `large-v3` を既定とする。
   * 初回のみ約3GBのダウンロードが発生する。
   */
  model: string;
  language: string;
  device: 'auto' | 'cpu' | 'cuda';
  /**
   * ★Apple Silicon では `int8` を既定にする。
   * `float16` は非対応で `float32` に自動変換され、実測で int8 の約1.7倍
   * 時間がかかった（9.6秒 vs 16.4秒）。精度差は確認できなかった。
   */
  computeType: string;
  /** ★既定 false。時間軸を詰めないため。 */
  vadFilter: boolean;
  /** 語彙ヒント（固有名詞・専門用語）。buildVocabularyPrompt で組む。 */
  initialPrompt?: string;
  /** 特に拾わせたい語（空白区切り）。 */
  hotwords?: string;
  /** Pythonの実行パス。未指定ならプロジェクトの .venv を探す。 */
  pythonPath?: string;
  /** ブリッジスクリプトのパス。未指定なら scripts/transcribe.py。 */
  scriptPath?: string;
  /** リポジトリのルート。パス解決の基準。 */
  projectRoot?: string;
}

export const DEFAULT_TRANSCRIBE_OPTIONS: TranscribeOptions = {
  model: 'large-v3',
  language: 'ja',
  device: 'auto',
  computeType: 'int8',
  vadFilter: false,
};

/**
 * Pythonの実行パスを解決する。
 *
 * プロジェクト内の `.venv` を優先する。システムのPythonに依存すると、
 * 別のプロジェクトの都合で壊れることがあるため。
 */
export function resolvePython(projectRoot: string, explicit?: string): string {
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`指定されたPythonが見つかりません: ${explicit}`);
    }
    return explicit;
  }

  const venv = join(projectRoot, '.venv', 'bin', 'python');
  if (existsSync(venv)) return venv;

  const probe = spawnSync('python3', ['-V'], { stdio: 'ignore' });
  if (probe.status === 0) return 'python3';

  throw new Error(
    'Pythonが見つかりません。\n' +
      '  python3 -m venv .venv && .venv/bin/pip install faster-whisper\n' +
      'を実行してください。',
  );
}

/** JSONの生データを型付きの Transcript に変換する。 */
export function parseTranscript(raw: string): Transcript {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `文字起こしの結果を解釈できませんでした:\n${raw.slice(0, 500)}`,
    );
  }

  const data = parsed as Record<string, unknown>;
  if (typeof data.error === 'string') {
    throw new Error(`文字起こしに失敗しました: ${data.error}`);
  }

  const words = Array.isArray(data.words) ? data.words : [];
  const segments = Array.isArray(data.segments) ? data.segments : [];
  const rawTimings = data.timings as Record<string, unknown> | undefined;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

  const timings: TranscribeTimings | undefined =
    rawTimings && typeof rawTimings === 'object'
      ? {
          modelLoadSec: num(rawTimings.modelLoadSec) ?? 0,
          preprocessSec: num(rawTimings.preprocessSec) ?? 0,
          inferenceSec: num(rawTimings.inferenceSec) ?? 0,
          postprocessSec: num(rawTimings.postprocessSec) ?? 0,
          jsonSec: num(rawTimings.jsonSec) ?? 0,
          totalSec: num(rawTimings.totalSec) ?? 0,
        }
      : undefined;

  return {
    language: typeof data.language === 'string' ? data.language : 'unknown',
    languageProbability:
      typeof data.languageProbability === 'number'
        ? data.languageProbability
        : undefined,
    durationSec: typeof data.durationSec === 'number' ? data.durationSec : 0,
    model: typeof data.model === 'string' ? data.model : 'unknown',
    vadFilter: data.vadFilter === true,
    timings,
    words: words
      .map((w) => w as Record<string, unknown>)
      .filter(
        (w) =>
          typeof w.startSec === 'number' &&
          typeof w.endSec === 'number' &&
          typeof w.text === 'string' &&
          w.text.length > 0,
      )
      .map((w) => ({
        startSec: w.startSec as number,
        endSec: w.endSec as number,
        text: w.text as string,
        probability:
          typeof w.probability === 'number' ? w.probability : undefined,
      })),
    segments: segments
      .map((s) => s as Record<string, unknown>)
      .filter(
        (s) =>
          typeof s.startSec === 'number' &&
          typeof s.endSec === 'number' &&
          typeof s.text === 'string',
      )
      .map((s) => ({
        startSec: s.startSec as number,
        endSec: s.endSec as number,
        text: s.text as string,
      })),
  };
}

/**
 * 単語に話者を割り当てる。
 *
 * 話者判定（マイクの音量比較）の結果と、文字起こしの単語を突き合わせる。
 * 単語の中心時刻が発話区間に含まれる話者を採用する。単語の開始時刻で
 * 判定すると、話者の切り替わり境界で1語ずれるため中心を使う。
 *
 * どの区間にも当てはまらない単語（無音中の物音を拾った場合など）は
 * speakerId を付けずに残す。捨てないのは、字幕としては必要なため。
 */
export function assignSpeakers(
  words: readonly TranscriptWord[],
  speech: readonly { startSec: number; endSec: number; speakerId: string }[],
): TranscriptWord[] {
  const sorted = [...speech].sort((a, b) => a.startSec - b.startSec);

  return words.map((word) => {
    const center = (word.startSec + word.endSec) / 2;
    const match = sorted.find((s) => s.startSec <= center && center < s.endSec);
    return match ? { ...word, speakerId: match.speakerId } : { ...word };
  });
}

/**
 * 認識の確からしさが低い単語を抜き出す。
 *
 * 字幕確認画面で「ここは聞き直したほうがよい」と示すために使う。
 * 自動で消したり書き換えたりはしない。
 */
export function lowConfidenceWords(
  words: readonly TranscriptWord[],
  threshold = 0.5,
): TranscriptWord[] {
  return words.filter(
    (w) => w.probability !== undefined && w.probability < threshold,
  );
}

/**
 * 文字起こしを実行する。
 *
 * `signal` を渡すと、ユーザーによる中止でPythonプロセス（faster-whisper）を
 * 確実に止められる。数分かかりうる処理のため、中止の即時性が特に重要。
 */
export async function transcribe(
  audioPath: string,
  options: Partial<TranscribeOptions> = {},
  signal?: AbortSignal,
): Promise<Transcript> {
  const opt = { ...DEFAULT_TRANSCRIBE_OPTIONS, ...options };
  const projectRoot = opt.projectRoot ?? process.cwd();
  const python = resolvePython(projectRoot, opt.pythonPath);
  const script = opt.scriptPath ?? join(projectRoot, 'scripts', 'transcribe.py');

  if (!existsSync(script)) {
    throw new Error(`ブリッジスクリプトが見つかりません: ${script}`);
  }
  if (!existsSync(audioPath)) {
    throw new Error(`音声ファイルが見つかりません: ${audioPath}`);
  }

  const args = [
    script,
    audioPath,
    '--model', opt.model,
    '--language', opt.language,
    '--device', opt.device,
    '--compute-type', opt.computeType,
  ];
  if (opt.vadFilter) args.push('--vad');
  if (opt.initialPrompt) args.push('--initial-prompt', opt.initialPrompt);
  if (opt.hotwords) args.push('--hotwords', opt.hotwords);

  const result = await runProcess(python, args, {
    signal,
    maxBufferBytes: 256 * 1024 * 1024,
  });

  if (!result.stdout.trim()) {
    throw new Error(
      `文字起こしが結果を返しませんでした。\n${result.stderr.slice(0, 1000)}`,
    );
  }

  return parseTranscript(result.stdout);
}
