import { describe, expect, it } from 'vitest';

import {
  displayWidth,
  generateEmphasisSrt,
  generateSpeakerSrt,
  generateSubtitleSrt,
  generateYoutubeChapters,
  toSrtTime,
  wrapText,
} from './srt.ts';
import type { EmphasisPoint, Speaker, SpeechSegment, Word } from './types.ts';

const SPEAKERS: Speaker[] = [
  { id: 'A', name: '岸本', role: 'host' },
  { id: 'B', name: '山田太郎', title: '株式会社◯◯ 人事部長', role: 'guest' },
  { id: 'C', name: '佐藤花子', title: '同 採用担当', role: 'guest' },
];

function words(parts: [number, number, string, string?][]): Word[] {
  return parts.map(([startSec, endSec, text, speakerId]) => ({
    startSec,
    endSec,
    text,
    speakerId,
  }));
}

describe('toSrtTime', () => {
  it('SRTのタイムコード形式で出力する', () => {
    expect(toSrtTime(0)).toBe('00:00:00,000');
    expect(toSrtTime(1.5)).toBe('00:00:01,500');
    expect(toSrtTime(61.25)).toBe('00:01:01,250');
    expect(toSrtTime(3661.001)).toBe('01:01:01,001');
  });

  it('負の値は0に丸める', () => {
    expect(toSrtTime(-3)).toBe('00:00:00,000');
  });
});

describe('displayWidth / wrapText', () => {
  it('全角を2、半角を1として数える', () => {
    expect(displayWidth('あいう')).toBe(6);
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('あa')).toBe(3);
  });

  it('全角14文字相当で折り返す', () => {
    const lines = wrapText('あ'.repeat(30), 14, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveLength(14);
  });

  it('最大行数を超えない', () => {
    expect(wrapText('あ'.repeat(100), 14, 2)).toHaveLength(2);
  });

  it('短い文はそのまま1行', () => {
    expect(wrapText('採用の話', 14, 2)).toEqual(['採用の話']);
  });
});

describe('generateSubtitleSrt', () => {
  it('連続した発話を1キューにまとめる', () => {
    const srt = generateSubtitleSrt(
      words([
        [0, 0.4, '採用は'],
        [0.4, 0.8, '広告じゃ'],
        [0.8, 1.2, 'なくて'],
      ]),
    );
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,200');
    expect(srt).toContain('採用は広告じゃなくて');
  });

  it('間（息継ぎ）でキューを分割する', () => {
    const srt = generateSubtitleSrt(
      words([
        [0, 0.5, '採用は'],
        // 1.5秒の間
        [2.0, 2.5, '難しい'],
      ]),
      { pauseSplitSec: 0.6 },
    );
    expect(srt).toContain('1\n');
    expect(srt).toContain('2\n');
    expect(srt).toContain('採用は');
    expect(srt).toContain('難しい');
  });

  it('話者が変わったら分割する', () => {
    const srt = generateSubtitleSrt(
      words([
        [0, 0.4, 'そうですね', 'A'],
        [0.4, 0.8, 'つまり', 'B'],
      ]),
    );
    const cues = srt.trim().split('\n\n');
    expect(cues).toHaveLength(2);
  });

  it('句読点を出力しない（読みのリズムを妨げないため）', () => {
    const srt = generateSubtitleSrt(words([[0, 1, '採用は、難しい。']]));
    expect(srt).not.toContain('、');
    expect(srt).not.toContain('。');
    expect(srt).toContain('採用は難しい');
  });

  it('フィラーを字幕から除く（★音声はカットしない）', () => {
    const srt = generateSubtitleSrt(
      words([
        [0, 0.3, 'えー'],
        [0.3, 0.7, '採用は'],
        [0.7, 1.0, 'あのー'],
        [1.0, 1.4, '難しい'],
      ]),
    );
    expect(srt).not.toContain('えー');
    expect(srt).not.toContain('あのー');
    expect(srt).toContain('採用は難しい');
  });

  it('最長表示時間を超えたら分割する', () => {
    const srt = generateSubtitleSrt(
      words([
        [0, 3, 'まえはん'],
        [3, 9, 'うしろはん'],
      ]),
      { maxCueSec: 6, pauseSplitSec: 99 },
    );
    expect(srt.trim().split('\n\n')).toHaveLength(2);
  });

  it('2行に収まらない長さは分割する', () => {
    const srt = generateSubtitleSrt(
      words([[0, 1, 'あ'.repeat(60)]]),
      { pauseSplitSec: 99, maxCueSec: 99 },
    );
    // 1キューあたり最大2行×14文字 = 28文字までに収める
    for (const line of srt.split('\n')) {
      if (/^[あ]+$/.test(line)) expect(line.length).toBeLessThanOrEqual(14);
    }
  });

  it('発話が空なら空文字を返す', () => {
    expect(generateSubtitleSrt([])).toBe('');
  });

  it('フィラーだけなら空文字を返す', () => {
    expect(generateSubtitleSrt(words([[0, 0.3, 'えー'], [0.4, 0.7, 'あのー']]))).toBe('');
  });
});

describe('generateSpeakerSrt', () => {
  function speech(parts: [number, number, string][]): SpeechSegment[] {
    return parts.map(([startSec, endSec, speakerId]) => ({
      startSec,
      endSec,
      speakerId,
      text: '…',
    }));
  }

  it('話者名と肩書きを2行で出す', () => {
    const srt = generateSpeakerSrt(speech([[0, 10, 'B']]), SPEAKERS);
    expect(srt).toContain('山田太郎\n株式会社◯◯ 人事部長');
  });

  it('肩書きが無ければ名前だけ', () => {
    const srt = generateSpeakerSrt(speech([[0, 10, 'A']]), SPEAKERS);
    expect(srt).toContain('岸本');
    expect(srt.trim().split('\n')).toHaveLength(3);
  });

  it('連続する同一話者を1キューに統合する', () => {
    const srt = generateSpeakerSrt(
      speech([
        [0, 5, 'A'],
        [5, 10, 'A'],
        [10, 15, 'A'],
      ]),
      SPEAKERS,
    );
    expect(srt.trim().split('\n\n')).toHaveLength(1);
    expect(srt).toContain('00:00:00,000 --> 00:00:15,000');
  });

  it('話者が切り替わるたびに新しいキューを作る', () => {
    const srt = generateSpeakerSrt(
      speech([
        [0, 5, 'A'],
        [5, 10, 'B'],
        [10, 15, 'A'],
      ]),
      SPEAKERS,
    );
    expect(srt.trim().split('\n\n')).toHaveLength(3);
  });

  it('3人目にも対応する', () => {
    const srt = generateSpeakerSrt(
      speech([[0, 5, 'A'], [5, 10, 'B'], [10, 15, 'C']]),
      SPEAKERS,
    );
    expect(srt).toContain('佐藤花子');
  });

  it('未登録の話者は無視する', () => {
    const srt = generateSpeakerSrt(speech([[0, 5, 'Z']]), SPEAKERS);
    expect(srt).toBe('');
  });

  it('順序が乱れた入力でも時刻順に並べる', () => {
    const srt = generateSpeakerSrt(
      speech([[10, 15, 'B'], [0, 5, 'A']]),
      SPEAKERS,
    );
    expect(srt.indexOf('岸本')).toBeLessThan(srt.indexOf('山田太郎'));
  });
});

describe('generateEmphasisSrt', () => {
  const points: EmphasisPoint[] = [
    { startSec: 120, endSec: 124, text: '辞退率を見ろ', quote: '応募数より辞退率です' },
    { startSec: 30, endSec: 34, text: '正直な自己紹介', quote: '採用は正直な自己紹介' },
  ];

  it('時刻順に並べる', () => {
    const srt = generateEmphasisSrt(points);
    expect(srt.indexOf('正直な自己紹介')).toBeLessThan(srt.indexOf('辞退率を見ろ'));
  });

  it('連番を振り直す', () => {
    const srt = generateEmphasisSrt(points);
    expect(srt.startsWith('1\n')).toBe(true);
    expect(srt).toContain('\n2\n');
  });

  it('強調テロップは短く折り返す（大きい文字で表示するため）', () => {
    const srt = generateEmphasisSrt([
      { startSec: 0, endSec: 4, text: 'あ'.repeat(30), quote: '' },
    ]);
    for (const line of srt.split('\n')) {
      if (/^[あ]+$/.test(line)) expect(line.length).toBeLessThanOrEqual(9);
    }
  });

  it('空なら空文字', () => {
    expect(generateEmphasisSrt([])).toBe('');
  });
});

describe('generateYoutubeChapters', () => {
  it('最初のチャプターを必ず00:00にする（YouTubeの要件）', () => {
    const text = generateYoutubeChapters([
      { startSec: 12, title: 'オープニング' },
      { startSec: 135, title: '給与では勝てない理由' },
    ]);
    expect(text.split('\n')[0]).toBe('00:00 オープニング');
  });

  it('1時間を超えたらh:mm:ss表記にする', () => {
    const text = generateYoutubeChapters([
      { startSec: 0, title: 'オープニング' },
      { startSec: 3725, title: '後半' },
    ]);
    expect(text).toContain('1:02:05 後半');
  });

  it('時刻順に並べる', () => {
    const text = generateYoutubeChapters([
      { startSec: 300, title: '後' },
      { startSec: 100, title: '前' },
    ]);
    const lines = text.trim().split('\n');
    expect(lines[0]).toContain('前');
    expect(lines[1]).toContain('後');
  });

  it('空なら空文字', () => {
    expect(generateYoutubeChapters([])).toBe('');
  });
});
