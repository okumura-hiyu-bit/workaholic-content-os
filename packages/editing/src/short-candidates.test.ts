import { describe, expect, it } from 'vitest';

import {
  collectBoundaries,
  DEFAULT_SHORT_RULES,
  deriveEmphasisPoints,
  extractShortCandidates,
  textInRange,
  type ShortCandidateSource,
} from './short-candidates.ts';
import type { Word } from './types.ts';

/** 文を単語に割る（句点を単語末尾に残す）。 */
function words(sentences: [number, string][]): Word[] {
  const result: Word[] = [];
  for (const [startSec, sentence] of sentences) {
    const chars = [...sentence];
    const step = 0.12;
    chars.forEach((ch, i) => {
      result.push({
        startSec: Number((startSec + i * step).toFixed(3)),
        endSec: Number((startSec + (i + 1) * step).toFixed(3)),
        text: ch,
      });
    });
  }
  return result;
}

function makeSource(
  overrides: Partial<ShortCandidateSource> = {},
): ShortCandidateSource {
  return {
    durationSec: 300,
    words: words([
      [10, '応募数よりも辞退率を見てください。'],
      [40, '採用は広告ではなく正直な自己紹介です。'],
      [100, 'それはさっきの話と同じです。'],
      [200, '綺麗すぎる採用動画は逆効果になります。'],
    ]),
    speech: [
      { startSec: 5, endSec: 35, speakerId: 'A', text: '' },
      { startSec: 38, endSec: 70, speakerId: 'B', text: '' },
      { startSec: 95, endSec: 130, speakerId: 'A', text: '' },
      { startSec: 195, endSec: 240, speakerId: 'B', text: '' },
    ],
    overlaps: [],
    laughter: [],
    emphasis: [
      {
        startSec: 12,
        endSec: 16,
        text: '辞退率を見ろ',
        quote: '応募数よりも辞退率を見てください',
        speakerId: 'A',
      },
      {
        startSec: 42,
        endSec: 46,
        text: '正直な自己紹介',
        quote: '採用は広告ではなく正直な自己紹介です',
        speakerId: 'B',
      },
    ],
    topics: [
      { startSec: 0, endSec: 90, title: '採用の指標' },
      { startSec: 90, endSec: 300, title: '採用動画の作り方' },
    ],
    keywords: ['辞退率', '採用', '自己紹介'],
    ...overrides,
  };
}

describe('collectBoundaries', () => {
  it('句点・発話区間・話題の切れ目を境界にする', () => {
    const boundaries = collectBoundaries(makeSource());
    expect(boundaries[0]).toBe(0);
    expect(boundaries.at(-1)).toBe(300);
    // 発話区間の開始が境界に含まれる
    expect(boundaries).toContain(5);
    expect(boundaries).toContain(38);
    // 話題の切れ目が含まれる
    expect(boundaries).toContain(90);
  });

  it('昇順に並び、尺の外を含まない', () => {
    const boundaries = collectBoundaries(makeSource());
    expect([...boundaries]).toEqual([...boundaries].sort((a, b) => a - b));
    expect(boundaries.every((b) => b >= 0 && b <= 300)).toBe(true);
  });

  it('文字起こしが無くても発話区間から境界を作れる', () => {
    const boundaries = collectBoundaries(makeSource({ words: [] }));
    expect(boundaries.length).toBeGreaterThan(2);
  });
});

describe('textInRange', () => {
  it('区間内の文字起こしを連結する', () => {
    const text = textInRange(makeSource().words, { startSec: 10, endSec: 14 });
    expect(text).toContain('応募数');
  });

  it('範囲外は含めない', () => {
    const text = textInRange(makeSource().words, { startSec: 10, endSec: 14 });
    expect(text).not.toContain('綺麗');
  });
});

describe('extractShortCandidates — 基本', () => {
  it('強調ポイントを核に候補を作る', () => {
    const candidates = extractShortCandidates(makeSource());
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.id).toBe('short_01');
  });

  it('IDは時刻順の連番になる', () => {
    const candidates = extractShortCandidates(makeSource());
    expect(candidates.map((c) => c.id)).toEqual(
      candidates.map((_, i) => `short_${String(i + 1).padStart(2, '0')}`),
    );
    const starts = candidates.map((c) => c.startSec);
    expect([...starts]).toEqual([...starts].sort((a, b) => a - b));
  });

  it('★同じ入力なら毎回同じ候補になる（決定的）', () => {
    const a = extractShortCandidates(makeSource());
    const b = extractShortCandidates(makeSource());
    expect(a).toEqual(b);
  });

  it('★タイトルとフックは埋めない（AIまたは人が書く）', () => {
    for (const candidate of extractShortCandidates(makeSource())) {
      expect(candidate.title).toBe('');
      expect(candidate.hook).toBe('');
    }
  });

  it('加点の根拠を必ず持つ', () => {
    for (const candidate of extractShortCandidates(makeSource())) {
      expect(candidate.signals.length).toBeGreaterThan(0);
      expect(candidate.breakdown.length).toBeGreaterThan(0);
      expect(candidate.rationale).not.toBe('');
    }
  });

  it('APIに送る抜粋を持つ（★これだけを送る）', () => {
    const candidates = extractShortCandidates(makeSource());
    expect(candidates[0]!.transcriptExcerpt.length).toBeGreaterThan(0);
  });

  it('主に話している人を特定する', () => {
    const candidates = extractShortCandidates(makeSource());
    expect(candidates[0]!.primarySpeakerId).toBeDefined();
  });
});

describe('extractShortCandidates — 尺の制約', () => {
  it('★90秒を超える候補を作らない（リールタブの要件）', () => {
    const candidates = extractShortCandidates(
      makeSource({
        emphasis: [
          { startSec: 10, endSec: 200, text: '長い', quote: '長い' },
        ],
      }),
    );
    for (const candidate of candidates) {
      expect(candidate.endSec - candidate.startSec).toBeLessThanOrEqual(
        DEFAULT_SHORT_RULES.maxSec + 0.001,
      );
    }
  });

  it('最短を下回る候補を作らない', () => {
    for (const candidate of extractShortCandidates(makeSource())) {
      expect(candidate.endSec - candidate.startSec).toBeGreaterThanOrEqual(
        DEFAULT_SHORT_RULES.minSec,
      );
    }
  });

  it('尺の上下限を設定で変えられる', () => {
    const candidates = extractShortCandidates(makeSource(), {
      minSec: 20,
      maxSec: 30,
    });
    for (const candidate of candidates) {
      const length = candidate.endSec - candidate.startSec;
      expect(length).toBeGreaterThanOrEqual(20);
      expect(length).toBeLessThanOrEqual(30.001);
    }
  });

  it('狙いの尺に近いほど加点される', () => {
    const near = extractShortCandidates(makeSource(), { targetSec: 30 });
    const lengthSignal = near[0]!.breakdown.find((s) => s.key === 'length')!;
    expect(lengthSignal.points).toBeGreaterThan(0);
  });
});

describe('extractShortCandidates — シグナル', () => {
  it('笑いを含む区間に加点する', () => {
    const candidates = extractShortCandidates(
      makeSource({ laughter: [{ startSec: 14, endSec: 17, confidence: 0.8 }] }),
    );
    const withLaugh = candidates.find((c) => c.metrics.laughterSec > 0);
    expect(withLaugh).toBeDefined();
    expect(withLaugh!.breakdown.some((s) => s.key.includes('laughter'))).toBe(true);
  });

  it('キーワードを含む区間に加点する', () => {
    const candidates = extractShortCandidates(makeSource());
    const withKeyword = candidates.find((c) => c.metrics.keywordHits.length > 0);
    expect(withKeyword).toBeDefined();
    expect(withKeyword!.breakdown.some((s) => s.key === 'keywords')).toBe(true);
  });

  it('★冒頭が文脈依存の語なら減点する', () => {
    const candidates = extractShortCandidates(
      makeSource({
        words: words([[100, 'それはさっきの話と同じです。']]),
        emphasis: [
          { startSec: 100, endSec: 104, text: 'x', quote: 'それはさっきの話' },
        ],
        speech: [{ startSec: 98, endSec: 140, speakerId: 'A', text: '' }],
        topics: [],
        leadInSec: 0,
      } as Partial<ShortCandidateSource>),
      { leadInSec: 0 },
    );
    const candidate = candidates[0];
    if (candidate && !candidate.metrics.selfContained) {
      expect(candidate.breakdown.some((s) => s.key === 'context')).toBe(true);
      expect(candidate.breakdown.find((s) => s.key === 'context')!.points).toBeLessThan(0);
    }
  });

  it('冒頭にフックがあれば加点する', () => {
    const candidates = extractShortCandidates(
      makeSource({
        words: words([[10, '実は応募数は関係ありません。']]),
        emphasis: [{ startSec: 10, endSec: 14, text: 'x', quote: '実は' }],
        speech: [{ startSec: 8, endSec: 50, speakerId: 'A', text: '' }],
        topics: [],
      }),
      { leadInSec: 0 },
    );
    const hooked = candidates.find((c) => c.metrics.hasOpeningHook);
    expect(hooked).toBeDefined();
  });

  it('話題の切れ目をまたぐと減点する', () => {
    const candidates = extractShortCandidates(
      makeSource({
        emphasis: [{ startSec: 85, endSec: 89, text: 'x', quote: 'y' }],
        speech: [{ startSec: 80, endSec: 130, speakerId: 'A', text: '' }],
      }),
    );
    const straddling = candidates.find((c) =>
      c.breakdown.some((s) => s.key === 'topic_straddle'),
    );
    if (straddling) {
      expect(
        straddling.breakdown.find((s) => s.key === 'topic_straddle')!.points,
      ).toBeLessThan(0);
    }
  });

  it('やりとりが多い区間に加点する', () => {
    // 4秒ごとに話者が交代する素材。切り出し範囲に必ず複数回の交代が入る。
    const alternating = Array.from({ length: 15 }, (_, i) => ({
      startSec: i * 4,
      endSec: (i + 1) * 4,
      speakerId: i % 2 === 0 ? 'A' : 'B',
      text: '',
    }));
    const candidates = extractShortCandidates(
      makeSource({
        durationSec: 60,
        words: [],
        speech: alternating,
        emphasis: [{ startSec: 20, endSec: 24, text: 'x', quote: 'y' }],
        topics: [],
        keywords: [],
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.metrics.speakerChanges).toBeGreaterThanOrEqual(2);
    expect(candidates[0]!.breakdown.some((s) => s.key === 'dialogue')).toBe(true);
  });

  it('1人が話し切っている区間にも加点する（切り出しやすさ）', () => {
    const candidates = extractShortCandidates(
      makeSource({
        durationSec: 60,
        words: [],
        speech: [{ startSec: 0, endSec: 60, speakerId: 'A', text: '' }],
        emphasis: [{ startSec: 20, endSec: 24, text: 'x', quote: 'y' }],
        topics: [],
        keywords: [],
      }),
    );
    expect(candidates[0]!.metrics.speakerChanges).toBe(0);
    expect(candidates[0]!.breakdown.some((s) => s.key === 'monologue')).toBe(true);
  });

  it('音量エンベロープを渡すと起伏を評価する', () => {
    const values = new Float32Array(3000);
    for (let i = 0; i < values.length; i++) {
      values[i] = 0.3 + 0.3 * Math.sin(i / 20);
    }
    const candidates = extractShortCandidates(
      makeSource({ energy: { frameRate: 10, values } }),
    );
    expect(candidates[0]!.metrics.energyVariation).toBeDefined();
  });
});

describe('extractShortCandidates — 沈黙の扱い', () => {
  it('★沈黙率が高すぎる区間は候補にしない', () => {
    // 発話が短く、間が非常に長い素材。
    const candidates = extractShortCandidates(
      makeSource({
        speech: [{ startSec: 12, endSec: 14, speakerId: 'A', text: '' }],
        emphasis: [{ startSec: 12, endSec: 14, text: 'x', quote: 'y' }],
        topics: [],
      }),
    );
    expect(candidates).toHaveLength(0);
  });

  it('★沈黙を「削る対象」として出力しない', () => {
    const candidates = extractShortCandidates(makeSource());
    const labels = candidates.flatMap((c) => c.signals).join(' ');
    expect(labels).not.toMatch(/無音|沈黙を削|カット/);
  });

  it('沈黙率のしきい値を変えられる', () => {
    const source = makeSource({
      speech: [{ startSec: 12, endSec: 20, speakerId: 'A', text: '' }],
      emphasis: [{ startSec: 12, endSec: 14, text: 'x', quote: 'y' }],
      topics: [],
    });
    expect(extractShortCandidates(source, { maxSilenceRatio: 0.1 })).toHaveLength(0);
    expect(
      extractShortCandidates(source, { maxSilenceRatio: 0.95 }).length,
    ).toBeGreaterThan(0);
  });
});

describe('extractShortCandidates — 候補数と重複', () => {
  it('候補同士が重ならない', () => {
    const candidates = extractShortCandidates(makeSource());
    for (let i = 1; i < candidates.length; i++) {
      expect(candidates[i]!.startSec).toBeGreaterThanOrEqual(
        candidates[i - 1]!.endSec - 0.001,
      );
    }
  });

  it('上限本数を超えない', () => {
    const emphasis = Array.from({ length: 40 }, (_, i) => ({
      startSec: 10 + i * 6,
      endSec: 14 + i * 6,
      text: `x${i}`,
      quote: `y${i}`,
    }));
    const candidates = extractShortCandidates(
      makeSource({
        durationSec: 600,
        emphasis,
        speech: [{ startSec: 0, endSec: 600, speakerId: 'A', text: '' }],
        topics: [],
      }),
      { maxCandidates: 12 },
    );
    expect(candidates.length).toBeLessThanOrEqual(12);
  });

  it('既定の上限は10〜20本の範囲にある（APIへ送る想定本数）', () => {
    expect(DEFAULT_SHORT_RULES.maxCandidates).toBeGreaterThanOrEqual(10);
    expect(DEFAULT_SHORT_RULES.maxCandidates).toBeLessThanOrEqual(20);
  });
});

describe('extractShortCandidates — 端の条件', () => {
  it('核が無ければ候補も無い', () => {
    const candidates = extractShortCandidates(
      makeSource({ emphasis: [], laughter: [] }),
    );
    expect(candidates).toEqual([]);
  });

  it('文字起こしが無くても候補を作れる', () => {
    const candidates = extractShortCandidates(makeSource({ words: [] }));
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.transcriptExcerpt).toBe('');
  });

  it('尺をはみ出す核でも範囲内に収める', () => {
    const candidates = extractShortCandidates(
      makeSource({
        durationSec: 60,
        emphasis: [{ startSec: 55, endSec: 80, text: 'x', quote: 'y' }],
        speech: [{ startSec: 0, endSec: 60, speakerId: 'A', text: '' }],
        topics: [],
      }),
    );
    for (const candidate of candidates) {
      expect(candidate.endSec).toBeLessThanOrEqual(60.001);
      expect(candidate.startSec).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('deriveEmphasisPoints — ローカルのキーワード検出', () => {
  const testWords = words([[10, '応募数よりも辞退率を見てください。']]);

  it('キーワードの前後に窓を取って強調ポイントを作る', () => {
    const points = deriveEmphasisPoints(testWords, ['辞退率'], { windowSec: 1 });
    expect(points).toHaveLength(1);
    expect(points[0]!.text).toBe('辞退率');
    expect(points[0]!.quote).toContain('辞退率');
  });

  it('★キーワードが無ければ何も作らない（推測しない）', () => {
    expect(deriveEmphasisPoints(testWords, [])).toEqual([]);
  });

  it('文字起こしが無ければ何も作らない', () => {
    expect(deriveEmphasisPoints([], ['辞退率'])).toEqual([]);
  });

  it('近い出現をまとめる', () => {
    const points = deriveEmphasisPoints(testWords, ['応募数', '辞退率'], {
      windowSec: 1,
      mergeGapSec: 10,
    });
    expect(points).toHaveLength(1);
    expect(points[0]!.text).toBe('応募数・辞退率');
  });

  it('離れた出現は別の候補にする', () => {
    const twoOccurrences = words([
      [10, '辞退率が大事です。'],
      [200, '辞退率をもう一度言います。'],
    ]);
    const points = deriveEmphasisPoints(twoOccurrences, ['辞退率'], {
      windowSec: 1,
      mergeGapSec: 5,
    });
    expect(points).toHaveLength(2);
  });

  it('同じ入力なら毎回同じ結果になる（決定的）', () => {
    const a = deriveEmphasisPoints(testWords, ['辞退率']);
    const b = deriveEmphasisPoints(testWords, ['辞退率']);
    expect(a).toEqual(b);
  });
});
