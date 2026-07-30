import { describe, expect, it } from 'vitest';

import { computeEnvelope, type Envelope } from './audio-sync.ts';
import {
  detectLaughterCandidates,
  detectSpeakers,
  type MicTrack,
} from './speaker-detect.ts';

const SAMPLE_RATE = 8000;
const DURATION = 40;

/**
 * ピンマイク音声を合成する。
 *
 * bleed は「他の人の声のかぶり」。実際のピンマイクは他の出演者の声も拾うため、
 * 話者判定はこのかぶりを越えて支配的かどうかで判断する必要がある。
 */
function synthMic(
  own: [number, number][],
  bleed: [number, number][] = [],
  opts: { gain?: number; bleedGain?: number; modulation?: number } = {},
): Float32Array {
  const gain = opts.gain ?? 0.5;
  // -14dB 程度のかぶりを既定にする（現実のピンマイクに近い水準）。
  const bleedGain = opts.bleedGain ?? gain * 0.2;
  const modRate = opts.modulation ?? 3.7;
  const samples = new Float32Array(Math.round(DURATION * SAMPLE_RATE));

  let seed = 987654321;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };

  for (let i = 0; i < samples.length; i++) {
    const t = i / SAMPLE_RATE;
    let value = rand() * 0.0008; // 暗騒音
    const mod = 0.6 + 0.4 * Math.sin(2 * Math.PI * modRate * t);

    for (const [start, end] of own) {
      if (t >= start && t < end) value += gain * mod * Math.sin(2 * Math.PI * 220 * t);
    }
    for (const [start, end] of bleed) {
      if (t >= start && t < end) {
        value += bleedGain * mod * Math.sin(2 * Math.PI * 220 * t);
      }
    }
    samples[i] = value;
  }
  return samples;
}

function env(samples: Float32Array): Envelope {
  return computeEnvelope(samples, SAMPLE_RATE);
}

// ─── ご提示の素材条件をすべて含むシナリオ ──────────────────────
// A: 0-8秒 / 相槌 12.3-12.7秒 / 同時発話 20-21.5秒 / 26-32秒
// B: 10-18秒 / 同時発話 20-22秒 / 笑い 34-36秒
// 沈黙（考える間）: 8-10秒、18-20秒、32-34秒
const A_SPEECH: [number, number][] = [
  [0, 8],
  [26, 32],
];
const A_BACKCHANNEL: [number, number][] = [[12.3, 12.7]];
const A_OVERLAP: [number, number][] = [[20, 21.5]];
const A_LAUGH: [number, number][] = [[34, 36]];

const B_SPEECH: [number, number][] = [[10, 18]];
const B_OVERLAP: [number, number][] = [[20, 22]];
const B_LAUGH: [number, number][] = [[34, 36]];

function scenarioMics(): MicTrack[] {
  const aOwn = [...A_SPEECH, ...A_BACKCHANNEL, ...A_OVERLAP, ...A_LAUGH];
  const bOwn = [...B_SPEECH, ...B_OVERLAP, ...B_LAUGH];

  return [
    { speakerId: 'A', envelope: env(synthMic(aOwn, bOwn)) },
    { speakerId: 'B', envelope: env(synthMic(bOwn, aOwn)) },
  ];
}

/** ある時刻に発話中と判定された話者を返す。 */
function speakersAt(
  segments: { startSec: number; endSec: number; speakerId: string }[],
  t: number,
): string[] {
  return segments
    .filter((s) => s.startSec <= t && t < s.endSec)
    .map((s) => s.speakerId);
}

describe('detectSpeakers — 基本の話者判定', () => {
  const result = detectSpeakers(scenarioMics());

  it('Aの発話区間をAと判定する', () => {
    expect(speakersAt(result.speech, 4)).toEqual(['A']);
    expect(speakersAt(result.speech, 29)).toEqual(['A']);
  });

  it('Bの発話区間をBと判定する', () => {
    expect(speakersAt(result.speech, 14)).toEqual(['B']);
  });

  it('★ピンマイクのかぶりに引きずられない（Aが話す間にBを検出しない）', () => {
    expect(speakersAt(result.speech, 4)).not.toContain('B');
    expect(speakersAt(result.speech, 14)).not.toContain('A');
  });

  it('発話区間の境界が概ね合っている', () => {
    const first = result.speech.find((s) => s.speakerId === 'A')!;
    expect(first.startSec).toBeCloseTo(0, 0);
    expect(first.endSec).toBeCloseTo(8, 0);
  });

  it('話者ごとのノイズフロアを推定する', () => {
    expect(result.noiseFloorDb.get('A')).toBeLessThan(-40);
    expect(result.noiseFloorDb.get('B')).toBeLessThan(-40);
  });
});

describe('detectSpeakers — ★沈黙・間は検出しない', () => {
  const result = detectSpeakers(scenarioMics());

  it.each([9, 19, 33])('沈黙（%s秒）に発話セグメントを作らない', (t) => {
    expect(speakersAt(result.speech, t)).toEqual([]);
  });

  it('沈黙を「カット候補」等の別リストにも入れない', () => {
    // 返り値に沈黙を表すフィールドが存在しないこと自体が仕様。
    expect(Object.keys(result).sort()).toEqual([
      'backchannels',
      'noiseFloorDb',
      'overlaps',
      'speech',
    ]);
  });

  it('沈黙をまたいだ発話を1つに繋げない（別セグメントとして扱う）', () => {
    const aSegments = result.speech.filter((s) => s.speakerId === 'A');
    expect(aSegments.length).toBeGreaterThanOrEqual(2);
  });
});

describe('detectSpeakers — ★相槌はカメラ切替の対象にしない', () => {
  const result = detectSpeakers(scenarioMics());

  it('Bが話している最中のAの短い受け答えを発話セグメントにしない', () => {
    expect(speakersAt(result.speech, 12.5)).not.toContain('A');
  });

  it('相槌はカメラ切替の対象から外れるがBの発話は続く', () => {
    expect(speakersAt(result.speech, 12.5)).toEqual(['B']);
  });

  it('相槌は情報として残す（リアクションの手がかりに使う）', () => {
    const backchannel = result.backchannels.find(
      (b) => b.speakerId === 'A' && b.startSec > 11 && b.endSec < 14,
    );
    expect(backchannel).toBeDefined();
  });

  it('相槌の長さのしきい値を変えられる', () => {
    // しきい値を下げれば、同じ受け答えが発話として扱われる。
    const loose = detectSpeakers(scenarioMics(), {
      backchannelMaxSec: 0.1,
      minSpeechSec: 0.2,
    });
    expect(speakersAt(loose.speech, 12.5)).toContain('A');
  });
});

describe('detectSpeakers — 同時発話', () => {
  const result = detectSpeakers(scenarioMics());

  it('同時発話区間で両者を検出する', () => {
    expect(speakersAt(result.speech, 20.7).sort()).toEqual(['A', 'B']);
  });

  it('同時発話区間を overlaps として返す', () => {
    const overlap = result.overlaps.find((o) => o.startSec < 21 && o.endSec > 20);
    expect(overlap).toBeDefined();
    expect(overlap!.speakerIds.sort()).toEqual(['A', 'B']);
  });

  it('カメラ切替が引きになる入力として使える形になっている', () => {
    // camera-plan は speech の重なりから引きを選ぶ。重なりが実際にあること。
    const a = result.speech.find((s) => s.speakerId === 'A' && s.startSec > 19);
    const b = result.speech.find((s) => s.speakerId === 'B' && s.startSec > 19);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(Math.min(a!.endSec, b!.endSec)).toBeGreaterThan(
      Math.max(a!.startSec, b!.startSec),
    );
  });
});

describe('detectSpeakers — 同期オフセットの補正', () => {
  it('マイクにオフセットがあっても引き映像基準の時刻で返す', () => {
    const mics = scenarioMics();
    // mic_A が 2秒早く録画開始した状況（イン点 = 時刻 + 2）。
    const shifted = new Float32Array(mics[0]!.envelope.values.length);
    const shift = Math.round(2 * mics[0]!.envelope.frameRate);
    for (let i = 0; i < shifted.length; i++) {
      const src = i - shift;
      shifted[i] = src >= 0 ? mics[0]!.envelope.values[src]! : 0;
    }

    const result = detectSpeakers([
      {
        speakerId: 'A',
        envelope: { frameRate: mics[0]!.envelope.frameRate, values: shifted },
        offsetSec: 2,
      },
      mics[1]!,
    ]);

    // 補正が効いていれば、Aの発話は元どおり 0〜8秒に現れる。
    const first = result.speech.find((s) => s.speakerId === 'A')!;
    expect(first.startSec).toBeCloseTo(0, 0);
    expect(first.endSec).toBeCloseTo(8, 0);
  });
});

describe('detectSpeakers — 3人以上', () => {
  it('3人でもそれぞれを判定する', () => {
    const a: [number, number][] = [[0, 6]];
    const b: [number, number][] = [[8, 14]];
    const c: [number, number][] = [[16, 22]];
    const all = [...a, ...b, ...c];

    const result = detectSpeakers([
      { speakerId: 'A', envelope: env(synthMic(a, [...b, ...c])) },
      { speakerId: 'B', envelope: env(synthMic(b, [...a, ...c])) },
      { speakerId: 'C', envelope: env(synthMic(c, [...a, ...b])) },
    ]);

    expect(speakersAt(result.speech, 3)).toEqual(['A']);
    expect(speakersAt(result.speech, 11)).toEqual(['B']);
    expect(speakersAt(result.speech, 19)).toEqual(['C']);
    expect(all.length).toBe(3);
  });
});

describe('detectSpeakers — 端の条件', () => {
  it('マイクが無ければ空を返す', () => {
    const result = detectSpeakers([]);
    expect(result.speech).toEqual([]);
    expect(result.backchannels).toEqual([]);
  });

  it('全編無音なら発話セグメントを作らない', () => {
    const silent = env(synthMic([]));
    const result = detectSpeakers([
      { speakerId: 'A', envelope: silent },
      { speakerId: 'B', envelope: silent },
    ]);
    expect(result.speech).toEqual([]);
  });

  it('フレームレートが違えばエラーにする', () => {
    const a = computeEnvelope(synthMic([[0, 5]]), SAMPLE_RATE, 10);
    const b = computeEnvelope(synthMic([[0, 5]]), SAMPLE_RATE, 20);
    expect(() =>
      detectSpeakers([
        { speakerId: 'A', envelope: a },
        { speakerId: 'B', envelope: b },
      ]),
    ).toThrow(/フレームレート/);
  });
});

describe('detectLaughterCandidates', () => {
  it('複数人の同時発声で音量変動が大きい区間を候補にする', () => {
    // 笑いは音量が細かく揺れる（変動を大きくして再現）。
    const laugh: [number, number][] = [[34, 36]];
    const mics: MicTrack[] = [
      { speakerId: 'A', envelope: env(synthMic(laugh, [], { modulation: 9 })) },
      { speakerId: 'B', envelope: env(synthMic(laugh, [], { modulation: 9 })) },
    ];
    const overlaps = [{ startSec: 34, endSec: 36, speakerIds: ['A', 'B'] }];

    const candidates = detectLaughterCandidates(mics, overlaps);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ startSec: 34, endSec: 36 });
  });

  it('短すぎる同時発声は候補にしない', () => {
    const mics = scenarioMics();
    const candidates = detectLaughterCandidates(mics, [
      { startSec: 20, endSec: 20.3, speakerIds: ['A', 'B'] },
    ]);
    expect(candidates).toHaveLength(0);
  });

  it('1人だけの発声は候補にしない', () => {
    const mics = scenarioMics();
    const candidates = detectLaughterCandidates(mics, [
      { startSec: 0, endSec: 8, speakerIds: ['A'] },
    ]);
    expect(candidates).toHaveLength(0);
  });

  it('音量変動が小さい同時発話（議論の被り）は候補にしない', () => {
    const talk: [number, number][] = [[20, 22]];
    const mics: MicTrack[] = [
      { speakerId: 'A', envelope: env(synthMic(talk, [], { modulation: 0.2 })) },
      { speakerId: 'B', envelope: env(synthMic(talk, [], { modulation: 0.2 })) },
    ];
    const candidates = detectLaughterCandidates(mics, [
      { startSec: 20, endSec: 22, speakerIds: ['A', 'B'] },
    ]);
    expect(candidates).toHaveLength(0);
  });

  // ★自己検証で見つかった誤検出への対策。抑揚のある通常の会話は
  // 変動の「深さ」だけ見ると笑いと区別できないため、「速さ」で弾く。
  it('通常の会話の被り（音節速度の変動）を笑いと誤判定しない', () => {
    const talk: [number, number][] = [[20, 23]];
    const mics: MicTrack[] = [
      // 3.7Hz / 4.1Hz は通常の発話の音節速度に相当する。
      { speakerId: 'A', envelope: env(synthMic(talk, [], { modulation: 3.7 })) },
      { speakerId: 'B', envelope: env(synthMic(talk, [], { modulation: 4.1 })) },
    ];
    const candidates = detectLaughterCandidates(mics, [
      { startSec: 20, endSec: 23, speakerIds: ['A', 'B'] },
    ]);
    expect(candidates).toHaveLength(0);
  });

  it('確信度を返す（低い候補は編集者の確認に委ねる）', () => {
    const laugh: [number, number][] = [[34, 36]];
    const mics: MicTrack[] = [
      { speakerId: 'A', envelope: env(synthMic(laugh, [], { modulation: 9 })) },
      { speakerId: 'B', envelope: env(synthMic(laugh, [], { modulation: 9 })) },
    ];
    const candidates = detectLaughterCandidates(mics, [
      { startSec: 34, endSec: 36, speakerIds: ['A', 'B'] },
    ]);
    expect(candidates[0]!.confidence).toBeGreaterThan(0);
    expect(candidates[0]!.confidence).toBeLessThanOrEqual(1);
  });

  it('マイクが無ければ空を返す', () => {
    expect(detectLaughterCandidates([], [])).toEqual([]);
  });
});
