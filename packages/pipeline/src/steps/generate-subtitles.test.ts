/**
 * ⑧ 字幕生成 の工程テスト。
 *
 * ★実データで起きていた「開始時刻が同じキューでIDが衝突する」状況を再現し、
 * 一意なIDが振られること・1件目のIDが変わらないことを固定する。
 * ffmpeg / faster-whisper は使わない（この工程は純粋な組み立てのみ）。
 */

import { describe, expect, it } from 'vitest';

import type { StepContext } from '../types.ts';
import { generateSubtitlesStep } from './generate-subtitles.ts';

interface WordInput {
  text: string;
  startSec: number;
  endSec: number;
  speakerId?: string;
  probability?: number;
}

/** この工程が実際に読むのは transcript.words / speech / log だけ。 */
function contextFor(words: WordInput[]): StepContext {
  return {
    analysis: {
      transcript: { language: 'ja', model: 'large-v3', vadFilter: false, words, segments: [] },
      speech: [],
    },
    log: () => {},
  } as unknown as StepContext;
}

async function run(words: WordInput[]) {
  const result = await generateSubtitlesStep.run(contextFor(words));
  return {
    result,
    subtitles: result.analysisPatch?.subtitles ?? [],
    ids: (result.analysisPatch?.subtitles ?? []).map((cue) => cue.id),
  };
}

/**
 * 実データで観測されたパターン。
 * 話者が変わると必ず分割されるので、長さ0のキューの直後に
 * 同じ開始時刻のキューができる。
 */
const DUPLICATE_START_WORDS: WordInput[] = [
  { text: '前半', startSec: 20.96, endSec: 20.96, speakerId: 'spk_a' },
  { text: '後半', startSec: 20.96, endSec: 21.12, speakerId: 'spk_b' },
];

describe('通常のキュー', () => {
  it('★衝突しないキューのIDは連番なし（従来と同じ形）', async () => {
    const { ids } = await run([
      { text: 'こんばんは', startSec: 0, endSec: 1.2, speakerId: 'spk_a' },
      { text: 'よろしく', startSec: 3, endSec: 4.2, speakerId: 'spk_a' },
    ]);

    expect(ids).toEqual(['sub-00000000', 'sub-00003000']);
    expect(ids.every((id) => /^sub-\d{8}$/.test(id))).toBe(true);
  });

  it('衝突が無ければ警告を出さない', async () => {
    const { result } = await run([
      { text: 'こんばんは', startSec: 0, endSec: 1.2, speakerId: 'spk_a' },
      { text: 'よろしく', startSec: 3, endSec: 4.2, speakerId: 'spk_a' },
    ]);

    expect(result.status).toBe('completed');
    expect(result.warnings ?? []).toEqual([]);
  });
});

describe('開始時刻が重複するキュー', () => {
  it('★2件が一意なIDになる', async () => {
    const { ids } = await run(DUPLICATE_START_WORDS);

    expect(ids).toEqual(['sub-00020960', 'sub-00020960-2']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('★1件目は従来のIDを維持する', async () => {
    const { ids } = await run(DUPLICATE_START_WORDS);
    expect(ids[0]).toBe('sub-00020960');
  });

  it('★3件以上でも一意になる', async () => {
    const { ids } = await run([
      { text: '一', startSec: 20.96, endSec: 20.96, speakerId: 'spk_a' },
      { text: '二', startSec: 20.96, endSec: 20.96, speakerId: 'spk_b' },
      { text: '三', startSec: 20.96, endSec: 21.12, speakerId: 'spk_a' },
    ]);

    expect(ids).toEqual(['sub-00020960', 'sub-00020960-2', 'sub-00020960-3']);
    expect(new Set(ids).size).toBe(3);
  });

  it('★同じ入力なら毎回同じIDになる', async () => {
    const first = (await run(DUPLICATE_START_WORDS)).ids;
    for (let i = 0; i < 10; i += 1) {
      expect((await run(DUPLICATE_START_WORDS)).ids).toEqual(first);
    }
  });

  it('★重複を警告として報告する（黙って通さない）', async () => {
    const { result } = await run(DUPLICATE_START_WORDS);

    expect(result.status).toBe('warning');
    const warnings = result.warnings ?? [];
    expect(warnings.some((w) => w.includes('開始時刻が同じ'))).toBe(true);
    expect(warnings.some((w) => w.includes('連番'))).toBe(true);
  });
});

describe('ゼロ長キュー', () => {
  it('★自動削除せず、警告として残す', async () => {
    const { result, subtitles } = await run(DUPLICATE_START_WORDS);

    // 長さ0のキューがそのまま残っている（時間軸を勝手に詰めない方針）
    const zeroLength = subtitles.filter((c) => c.endSec <= c.startSec);
    expect(zeroLength).toHaveLength(1);

    const warnings = result.warnings ?? [];
    expect(warnings.some((w) => w.includes('長さが0'))).toBe(true);
    expect(warnings.some((w) => w.includes('自動削除はしていません'))).toBe(true);
  });
});

describe('解析結果の中身', () => {
  it('低confidence語をキューに保持する', async () => {
    const { subtitles } = await run([
      { text: 'あやしい', startSec: 0, endSec: 1, speakerId: 'spk_a', probability: 0.2 },
    ]);

    expect(subtitles[0]?.lowConfidenceWords).toEqual([
      { text: 'あやしい', probability: 0.2 },
    ]);
  });

  it('確からしい語は低confidenceに入れない', async () => {
    const { subtitles } = await run([
      { text: 'はっきり', startSec: 0, endSec: 1, speakerId: 'spk_a', probability: 0.95 },
    ]);
    expect(subtitles[0]?.lowConfidenceWords).toBeUndefined();
  });

  it('★字幕以外の解析レイヤーを書き換えない', async () => {
    const { result } = await run(DUPLICATE_START_WORDS);
    // この工程が返すパッチは subtitles だけ
    expect(Object.keys(result.analysisPatch ?? {})).toEqual(['subtitles']);
  });

  it('文字起こしが無ければ空で返す', async () => {
    const result = await generateSubtitlesStep.run({
      analysis: { speech: [] },
      log: () => {},
    } as unknown as StepContext);

    expect(result.analysisPatch?.subtitles).toEqual([]);
  });
});
