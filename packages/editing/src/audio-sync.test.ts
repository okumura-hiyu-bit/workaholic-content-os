import { describe, expect, it } from 'vitest';

import {
  computeEnvelope,
  estimateOffset,
  syncSources,
  type Envelope,
} from './audio-sync.ts';

const SAMPLE_RATE = 8000;

/**
 * 発話パターンから合成波形を作る。
 * intervals は [開始秒, 終了秒] の配列。
 */
function synthesize(
  durationSec: number,
  intervals: [number, number][],
  opts: { freq?: number; gain?: number; noise?: number } = {},
): Float32Array {
  const freq = opts.freq ?? 220;
  const gain = opts.gain ?? 0.5;
  const noise = opts.noise ?? 0.001;
  const samples = new Float32Array(Math.round(durationSec * SAMPLE_RATE));

  // 再現性のある擬似乱数（テストを不安定にしないため）。
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };

  for (let i = 0; i < samples.length; i++) {
    const t = i / SAMPLE_RATE;
    let value = rand() * noise;
    for (const [start, end] of intervals) {
      if (t >= start && t < end) {
        // 音量を揺らして「声らしい」エンベロープにする。
        const modulation = 0.6 + 0.4 * Math.sin(2 * Math.PI * 3.7 * t);
        value += gain * modulation * Math.sin(2 * Math.PI * freq * t);
      }
    }
    samples[i] = value;
  }
  return samples;
}

/**
 * オフセット offsetSec を持つ別素材を作る。
 *
 * 符号の定義（build-project の規約と一致させる）:
 *   offsetSec > 0 … その素材は基準より **早く録画を開始** した。
 *                   基準の時刻 t の内容は、素材内では t + offsetSec の位置にある。
 *                   → イン点 = タイムライン時刻 + offsetSec
 */
function shiftWaveform(samples: Float32Array, offsetSec: number): Float32Array {
  const shift = Math.round(offsetSec * SAMPLE_RATE);
  const out = new Float32Array(samples.length);
  for (let i = 0; i < out.length; i++) {
    const src = i - shift;
    out[i] = src >= 0 && src < samples.length ? samples[src]! : 0;
  }
  return out;
}

function envelopeOf(samples: Float32Array): Envelope {
  return computeEnvelope(samples, SAMPLE_RATE);
}

const PATTERN: [number, number][] = [
  [1, 4],
  [5.5, 9],
  [11, 13.5],
  [15, 19],
];

describe('computeEnvelope', () => {
  it('10ms刻み＝100Hzのエンベロープを作る', () => {
    const env = computeEnvelope(new Float32Array(SAMPLE_RATE), SAMPLE_RATE);
    expect(env.frameRate).toBe(100);
    expect(env.values.length).toBe(100);
  });

  it('無音区間は0に近く、発話区間は大きくなる', () => {
    const env = envelopeOf(synthesize(6, [[2, 4]]));
    expect(env.values[50]!).toBeLessThan(0.01); // 0.5秒＝無音
    expect(env.values[300]!).toBeGreaterThan(0.1); // 3.0秒＝発話
  });

  it('hopMsを変えられる', () => {
    const env = computeEnvelope(new Float32Array(SAMPLE_RATE), SAMPLE_RATE, 20);
    expect(env.frameRate).toBe(50);
  });
});

describe('estimateOffset — 既知のオフセットを復元する', () => {
  const master = synthesize(20, PATTERN);

  // ★同期精度の中心的なテスト。オフセットの符号と大きさが正確に戻ること。
  it.each([0, 0.5, 1.2, -0.4, 3.75, -2.5])(
    'オフセット %s 秒を復元する',
    (offset) => {
      const target = shiftWaveform(master, offset);
      const result = estimateOffset(envelopeOf(master), envelopeOf(target));

      // エンベロープの分解能は10ms。誤差はその範囲に収まること。
      expect(result.offsetSec).toBeCloseTo(offset, 1);
      expect(result.reliable).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.9);
    },
  );

  it('符号の向きが build-project の規約と一致する', () => {
    // cam_A が wide より 1.2秒早く録画を開始した状況を作る。
    const target = shiftWaveform(master, 1.2);
    const { offsetSec } = estimateOffset(envelopeOf(master), envelopeOf(target));
    // イン点 = タイムライン時刻 + offsetSec で素材内の位置になる。
    expect(offsetSec).toBeGreaterThan(0);
    expect(offsetSec).toBeCloseTo(1.2, 1);
  });
});

describe('estimateOffset — 頑健性', () => {
  const master = synthesize(20, PATTERN);

  it('マイク特性が違っても（音量が10倍違う）オフセットを復元する', () => {
    const quiet = synthesize(20, PATTERN, { gain: 0.05 });
    const target = shiftWaveform(quiet, 1.2);
    const result = estimateOffset(envelopeOf(master), envelopeOf(target));
    expect(result.offsetSec).toBeCloseTo(1.2, 1);
    expect(result.reliable).toBe(true);
  });

  it('周波数特性が違っても（別の音程）オフセットを復元する', () => {
    // 生波形なら一致しないが、エンベロープは一致するため復元できる。
    const other = synthesize(20, PATTERN, { freq: 440 });
    const target = shiftWaveform(other, 2);
    const result = estimateOffset(envelopeOf(master), envelopeOf(target));
    expect(result.offsetSec).toBeCloseTo(2, 1);
  });

  it('ノイズが多くてもオフセットを復元する', () => {
    const noisy = synthesize(20, PATTERN, { noise: 0.05 });
    const target = shiftWaveform(noisy, 1.5);
    const result = estimateOffset(envelopeOf(master), envelopeOf(target));
    expect(result.offsetSec).toBeCloseTo(1.5, 1);
  });

  it('無関係な音声では信頼度が低くなる（人の確認を促す）', () => {
    const unrelated = synthesize(20, [
      [0.3, 0.7],
      [2.1, 2.4],
      [8.8, 9.2],
      [17.2, 17.6],
    ]);
    const result = estimateOffset(envelopeOf(master), envelopeOf(unrelated));
    expect(result.confidence).toBeLessThan(0.9);
  });

  it('探索範囲外のオフセットは復元できない（範囲を明示する意味がある）', () => {
    const target = shiftWaveform(master, 5);
    const result = estimateOffset(envelopeOf(master), envelopeOf(target), {
      maxOffsetSec: 2,
    });
    expect(Math.abs(result.offsetSec)).toBeLessThanOrEqual(2.5);
  });

  it('空のエンベロープでも落ちない', () => {
    const empty: Envelope = { frameRate: 100, values: new Float32Array(0) };
    const result = estimateOffset(empty, envelopeOf(master));
    expect(result).toMatchObject({ offsetSec: 0, reliable: false });
  });

  it('フレームレートが違えばエラーにする', () => {
    const a = computeEnvelope(master, SAMPLE_RATE, 10);
    const b = computeEnvelope(master, SAMPLE_RATE, 20);
    expect(() => estimateOffset(a, b)).toThrow(/フレームレート/);
  });
});

describe('syncSources', () => {
  const master = synthesize(20, PATTERN);

  it('基準素材のオフセットは0', () => {
    const results = syncSources(
      { id: 'wide', envelope: envelopeOf(master) },
      [],
    );
    expect(results.get('wide')).toMatchObject({ offsetSec: 0, reliable: true });
  });

  it('全カメラのオフセットをまとめて返す', () => {
    const results = syncSources({ id: 'wide', envelope: envelopeOf(master) }, [
      { id: 'cam_A', envelope: envelopeOf(shiftWaveform(master, 1.2)) },
      { id: 'cam_B', envelope: envelopeOf(shiftWaveform(master, -0.4)) },
    ]);

    expect(results.get('cam_A')!.offsetSec).toBeCloseTo(1.2, 1);
    expect(results.get('cam_B')!.offsetSec).toBeCloseTo(-0.4, 1);
    expect(results.size).toBe(3);
  });

  it('基準素材が targets に含まれていても重複しない', () => {
    const env = envelopeOf(master);
    const results = syncSources({ id: 'wide', envelope: env }, [
      { id: 'wide', envelope: env },
    ]);
    expect(results.size).toBe(1);
  });
});
