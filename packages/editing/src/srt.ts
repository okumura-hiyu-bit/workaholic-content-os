/**
 * テロップを3本のSRTとして生成する。
 *
 * MOGRT挿入APIの将来が不確実なのに対し、SRTのキャプション読み込みは
 * Adobeが公式に案内している安定した機能。確実に動くものでPhase1を組む。
 *
 * @see docs/12-premiere-capability-matrix.md 12.4
 */

import type { EmphasisPoint, Speaker, SpeechSegment, Word } from './types.ts';

export interface SubtitleOptions {
  /** 1行あたりの最大文字数（全角換算）。縦型での可読性を基準にする。 */
  maxCharsPerLine: number;
  /** 1キューの最大行数。 */
  maxLines: number;
  /** この秒数以上の間があれば、キューを分割する（息継ぎで割る）。 */
  pauseSplitSec: number;
  /** 1キューの最長表示時間。 */
  maxCueSec: number;
  /** 字幕から除外する語（音声はカットしない。字幕に出さないだけ）。 */
  fillerWords: readonly string[];
}

export const DEFAULT_SUBTITLE_OPTIONS: SubtitleOptions = {
  maxCharsPerLine: 14,
  maxLines: 2,
  pauseSplitSec: 0.6,
  maxCueSec: 6,
  // 音声は絶対にカットしない。字幕の可読性のために表示から省くだけ。
  fillerWords: ['えー', 'えーと', 'あのー', 'あの', 'そのー', 'まあ', 'ええと', 'んー'],
};

export interface SrtCue {
  index: number;
  startSec: number;
  endSec: number;
  lines: string[];
  /** 話者ID（分かる場合）。話者交代で必ずキューが割れるため、キュー内は単一話者。 */
  speakerId?: string;
}

/** SRTのタイムコード（HH:MM:SS,mmm）に変換する。 */
export function toSrtTime(totalSeconds: number): string {
  const clamped = Math.max(0, totalSeconds);
  const ms = Math.round(clamped * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const milli = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(milli, 3)}`;
}

/** 全角を2、半角を1として数える。日本語の折り返し判定に使う。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += /[ -~｡-ﾟ]/.test(ch) ? 1 : 2;
  }
  return width;
}

export function renderSrt(cues: readonly SrtCue[]): string {
  return (
    cues
      .map(
        (cue) =>
          `${cue.index}\n${toSrtTime(cue.startSec)} --> ${toSrtTime(cue.endSec)}\n${cue.lines.join('\n')}`,
      )
      .join('\n\n') + (cues.length > 0 ? '\n' : '')
  );
}

function isFiller(text: string, fillers: readonly string[]): boolean {
  const normalized = text.replace(/[、。,.\s]/g, '');
  return normalized.length > 0 && fillers.includes(normalized);
}

/**
 * 文字列を最大幅で折り返す。全角14文字相当（幅28）を基準にする。
 * 単語境界を持たない日本語のため、幅で機械的に割る。
 */
export function wrapText(text: string, maxCharsPerLine: number, maxLines: number): string[] {
  const maxWidth = maxCharsPerLine * 2;
  const lines: string[] = [];
  let current = '';

  for (const ch of text) {
    if (displayWidth(current + ch) > maxWidth && current.length > 0) {
      lines.push(current);
      current = ch;
      if (lines.length === maxLines) break;
    } else {
      current += ch;
    }
  }
  if (current.length > 0 && lines.length < maxLines) lines.push(current);
  return lines;
}

/**
 * 単語単位のタイムコードから字幕キューを組む。
 *
 * 分割の基準は「間（息継ぎ）」「表示時間」「文字数」「話者交代」の4つ。
 * 句読点は出力しない（ショートの字幕では読みのリズムを妨げるため）。
 *
 * SRT文字列ではなくキューの配列を返す。パイプラインはこれを
 * `IdentifiedSubtitleCue[]` として解析レイヤーに保存し、SRT化は
 * 書き出し時（renderSrt）に行う——編集者の修正はキュー単位に乗るため。
 */
export function buildSubtitleCues(
  words: readonly Word[],
  options: Partial<SubtitleOptions> = {},
): SrtCue[] {
  const opt = { ...DEFAULT_SUBTITLE_OPTIONS, ...options };
  const cues: SrtCue[] = [];

  let buffer: Word[] = [];

  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer
      .map((w) => w.text)
      .join('')
      .replace(/[、。,.]/g, '')
      .trim();
    if (text.length === 0) {
      buffer = [];
      return;
    }
    const lines = wrapText(text, opt.maxCharsPerLine, opt.maxLines);
    cues.push({
      index: cues.length + 1,
      startSec: buffer[0]!.startSec,
      endSec: buffer[buffer.length - 1]!.endSec,
      lines,
      speakerId: buffer[0]!.speakerId,
    });
    buffer = [];
  };

  for (const word of words) {
    if (isFiller(word.text, opt.fillerWords)) continue;

    const prev = buffer[buffer.length - 1];
    if (prev) {
      const gap = word.startSec - prev.endSec;
      const span = word.endSec - buffer[0]!.startSec;
      const width = displayWidth(buffer.map((w) => w.text).join('') + word.text);

      if (
        gap >= opt.pauseSplitSec ||
        span > opt.maxCueSec ||
        width > opt.maxCharsPerLine * opt.maxLines * 2
      ) {
        flush();
      }
    }
    // 話者が変わったら必ず分割する。
    const head = buffer[0];
    if (head && word.speakerId && head.speakerId && word.speakerId !== head.speakerId) {
      flush();
    }
    buffer.push(word);
  }
  flush();

  return cues;
}

/**
 * 単語単位のタイムコードから字幕SRTを生成する。
 *
 * 分割の基準は「間（息継ぎ）」「表示時間」「文字数」の3つ。
 * 句読点は出力しない（ショートの字幕では読みのリズムを妨げるため）。
 */
export function generateSubtitleSrt(
  words: readonly Word[],
  options: Partial<SubtitleOptions> = {},
): string {
  return renderSrt(buildSubtitleCues(words, options));
}

/**
 * 話者名テロップを生成する。
 * 連続する同一話者は1キューに統合し、切り替わるたびに表示する。
 */
export function generateSpeakerSrt(
  speech: readonly SpeechSegment[],
  speakers: readonly Speaker[],
): string {
  const byId = new Map(speakers.map((s) => [s.id, s]));
  const cues: SrtCue[] = [];

  const sorted = [...speech].sort((a, b) => a.startSec - b.startSec);
  let currentSpeakerId: string | undefined;
  let start = 0;
  let end = 0;

  const flush = () => {
    if (!currentSpeakerId) return;
    const speaker = byId.get(currentSpeakerId);
    if (!speaker) return;
    const lines = speaker.title ? [speaker.name, speaker.title] : [speaker.name];
    cues.push({ index: cues.length + 1, startSec: start, endSec: end, lines });
  };

  for (const seg of sorted) {
    if (seg.speakerId === currentSpeakerId) {
      end = Math.max(end, seg.endSec);
      continue;
    }
    flush();
    currentSpeakerId = seg.speakerId;
    start = seg.startSec;
    end = seg.endSec;
  }
  flush();

  return renderSrt(cues);
}

/** 強調テロップを生成する。1話あたり5〜15箇所を想定。 */
export function generateEmphasisSrt(points: readonly EmphasisPoint[]): string {
  const cues = [...points]
    .sort((a, b) => a.startSec - b.startSec)
    .map((p, i) => ({
      index: i + 1,
      startSec: p.startSec,
      endSec: p.endSec,
      lines: wrapText(p.text, 9, 2),
    }));
  return renderSrt(cues);
}

/** YouTube概要欄用のチャプター表記を生成する。 */
export function generateYoutubeChapters(
  topics: readonly { startSec: number; title: string }[],
): string {
  const sorted = [...topics].sort((a, b) => a.startSec - b.startSec);
  const lines: string[] = [];

  for (const [i, topic] of sorted.entries()) {
    // YouTubeのチャプターは最初が 00:00 でなければ機能しない。
    const startSec = i === 0 ? 0 : topic.startSec;
    const total = Math.floor(startSec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
    lines.push(`${stamp} ${topic.title}`);
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}
