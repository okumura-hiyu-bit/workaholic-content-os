import { describe, expect, it } from 'vitest';

import {
  assignSpeakers,
  buildVocabularyPrompt,
  lowConfidenceWords,
  parseTranscript,
  type TranscriptWord,
} from './transcribe.ts';

/** faster-whisper が実際に返したJSONを縮めたもの。 */
const REAL_OUTPUT = JSON.stringify({
  language: 'ja',
  languageProbability: 1,
  durationSec: 7.461,
  model: 'large-v3',
  vadFilter: false,
  initialPrompt: null,
  hotwords: null,
  words: [
    { startSec: 0.0, endSec: 0.26, text: '採用', probability: 0.9554 },
    { startSec: 0.5, endSec: 0.74, text: 'は、', probability: 0.883 },
    { startSec: 3.1, endSec: 3.26, text: '事故', probability: 0.6876 },
    { startSec: 5.78, endSec: 5.86, text: '自体', probability: 0.4658 },
  ],
  segments: [
    { startSec: 0.0, endSec: 4.26, text: '採用は、広告ではなく、正直な自己紹介です。' },
  ],
});

describe('parseTranscript', () => {
  it('単語と区間を取り出す', () => {
    const result = parseTranscript(REAL_OUTPUT);
    expect(result.language).toBe('ja');
    expect(result.model).toBe('large-v3');
    expect(result.durationSec).toBeCloseTo(7.461, 3);
    expect(result.words).toHaveLength(4);
    expect(result.segments).toHaveLength(1);
    expect(result.words[0]).toMatchObject({ text: '採用', probability: 0.9554 });
  });

  it('★VADが無効であることを保持する（時間軸を詰めていない証跡）', () => {
    expect(parseTranscript(REAL_OUTPUT).vadFilter).toBe(false);
  });

  it('error が返ってきたら例外にする', () => {
    expect(() =>
      parseTranscript('{"error":"faster_whisper が見つかりません"}'),
    ).toThrow(/faster_whisper が見つかりません/);
  });

  it('JSONでなければ例外にする（Pythonの警告が混ざった場合など）', () => {
    expect(() => parseTranscript('Warning: something\nnot json')).toThrow(
      /解釈できませんでした/,
    );
  });

  it('壊れた単語（時刻が無い・空文字）を除く', () => {
    const raw = JSON.stringify({
      words: [
        { startSec: 0, endSec: 1, text: 'あり' },
        { startSec: 1, text: '終了時刻なし' },
        { startSec: 2, endSec: 3, text: '' },
        { text: '時刻なし' },
      ],
      segments: [],
    });
    const result = parseTranscript(raw);
    expect(result.words.map((w) => w.text)).toEqual(['あり']);
  });

  it('words / segments が無くても落ちない', () => {
    const result = parseTranscript('{"language":"ja"}');
    expect(result.words).toEqual([]);
    expect(result.segments).toEqual([]);
    expect(result.durationSec).toBe(0);
  });
});

describe('assignSpeakers', () => {
  const speech = [
    { startSec: 0, endSec: 5, speakerId: 'A' },
    { startSec: 6, endSec: 12, speakerId: 'B' },
  ];

  const words: TranscriptWord[] = [
    { startSec: 1.0, endSec: 1.4, text: 'あ' },
    { startSec: 7.0, endSec: 7.4, text: 'い' },
    // どの発話区間にも入らない（無音中に拾った物音など）
    { startSec: 5.3, endSec: 5.6, text: 'う' },
  ];

  it('発話区間に応じて話者を割り当てる', () => {
    const result = assignSpeakers(words, speech);
    expect(result[0]!.speakerId).toBe('A');
    expect(result[1]!.speakerId).toBe('B');
  });

  it('どの区間にも入らない語は話者なしで残す（捨てない）', () => {
    const result = assignSpeakers(words, speech);
    expect(result[2]!.speakerId).toBeUndefined();
    expect(result).toHaveLength(3);
  });

  it('単語の中心時刻で判定する（境界で1語ずれないように）', () => {
    // 開始が区間外・中心が区間内の語
    const result = assignSpeakers(
      [{ startSec: 5.8, endSec: 6.4, text: 'x' }],
      speech,
    );
    expect(result[0]!.speakerId).toBe('B');
  });

  it('順序が乱れた発話区間でも動く', () => {
    const result = assignSpeakers(words, [...speech].reverse());
    expect(result[0]!.speakerId).toBe('A');
    expect(result[1]!.speakerId).toBe('B');
  });

  it('発話区間が空なら全語が話者なし', () => {
    const result = assignSpeakers(words, []);
    expect(result.every((w) => w.speakerId === undefined)).toBe(true);
  });
});

describe('lowConfidenceWords', () => {
  it('確信度が低い語を抜き出す（自動修正はしない）', () => {
    const words = parseTranscript(REAL_OUTPUT).words;
    const low = lowConfidenceWords(words, 0.7);
    expect(low.map((w) => w.text)).toEqual(['事故', '自体']);
  });

  it('しきい値を変えられる', () => {
    const words = parseTranscript(REAL_OUTPUT).words;
    expect(lowConfidenceWords(words, 0.5).map((w) => w.text)).toEqual(['自体']);
  });

  it('確信度が無い語は対象にしない', () => {
    expect(lowConfidenceWords([{ startSec: 0, endSec: 1, text: 'x' }])).toEqual([]);
  });
});

describe('buildVocabularyPrompt', () => {
  it('ブリーフの情報から語彙ヒントを組む', () => {
    const prompt = buildVocabularyPrompt({
      theme: '採用ブランディング',
      speakers: [
        { name: '岸本' },
        { name: '山田太郎', title: '株式会社◯◯ 人事部長' },
      ],
      keywords: ['辞退率', '応募数'],
    });
    expect(prompt).toContain('採用ブランディング');
    expect(prompt).toContain('山田太郎');
    expect(prompt).toContain('株式会社◯◯');
    expect(prompt).toContain('辞退率');
  });

  it('重複を除く', () => {
    const prompt = buildVocabularyPrompt({
      theme: '採用',
      speakers: [],
      keywords: ['採用', '採用'],
    });
    expect(prompt?.match(/採用/g)).toHaveLength(1);
  });

  it('情報が無ければ undefined を返す（プロンプトを渡さない）', () => {
    expect(buildVocabularyPrompt({ speakers: [], keywords: [] })).toBeUndefined();
  });

  it('長すぎる場合は切り詰める（Whisperのプロンプト長には上限がある）', () => {
    const prompt = buildVocabularyPrompt({
      speakers: [],
      keywords: Array.from({ length: 200 }, (_, i) => `用語${i}`),
    });
    expect(prompt).toBeDefined();
    expect(prompt!.length).toBeLessThanOrEqual(200);
  });
});
