/**
 * 話者判定。
 *
 * 出演者ごとのピンマイク音声の音量を比較し、「今誰が話しているか」を決める。
 * AIモデルを使わないのは、音量比較のほうが速く・確実で・費用がかからないため。
 *
 * ★沈黙・間は「検出しない」。無音区間はセグメントを作らないだけで、
 * カット候補としても提示しない（docs/11-editing-pipeline.md 11.5）。
 *
 * ★相槌（短い受け答え）は発話セグメントにしない。相槌でカメラを切り替えると
 * 落ち着かない映像になるため、切替の対象から外す。ただし情報としては残し、
 * リアクションカットの手がかりに使う。
 */

import type { Envelope } from './audio-sync.ts';
import type { LaughterSegment, SpeechSegment } from './types.ts';

export interface MicTrack {
  speakerId: string;
  envelope: Envelope;
  /** 引き映像を基準としたオフセット秒。エンベロープの時刻補正に使う。 */
  offsetSec?: number;
}

export interface SpeakerDetectOptions {
  /** ノイズフロアからこのdB以上大きければ「鳴っている」と見なす。 */
  activationMarginDb: number;
  /**
   * 他のマイクよりこのdB以上大きければ「その人が話している」と見なす。
   * ピンマイクは他の人の声も拾う（かぶり）ため、この余裕が必要。
   */
  dominanceMarginDb: number;
  /** これより短い発話は発話セグメントにしない。 */
  minSpeechSec: number;
  /** この長さ以下の途切れは同じ発話として繋ぐ。 */
  mergeGapSec: number;
  /** 他の人が話している最中のこの長さ以下の発声は「相槌」と判定する。 */
  backchannelMaxSec: number;
}

export const DEFAULT_SPEAKER_OPTIONS: SpeakerDetectOptions = {
  activationMarginDb: 12,
  dominanceMarginDb: 6,
  minSpeechSec: 0.8,
  mergeGapSec: 0.3,
  backchannelMaxSec: 0.9,
};

export interface SpeakerDetectResult {
  /** カメラ切替と話者名テロップに使う発話区間。 */
  speech: SpeechSegment[];
  /** 相槌。★カメラ切替の対象にしない。 */
  backchannels: SpeechSegment[];
  /** 複数人が同時に話している区間。 */
  overlaps: { startSec: number; endSec: number; speakerIds: string[] }[];
  /** マイクごとの推定ノイズフロア（dB）。要確認情報の判断に使う。 */
  noiseFloorDb: Map<string, number>;
}

const SILENCE_DB = -120;

function toDb(value: number): number {
  return value <= 0 ? SILENCE_DB : 20 * Math.log10(value);
}

/**
 * ノイズフロアを推定する。下位20パーセンタイルを使う。
 * 平均や最小値ではなく分位点を使うのは、突発ノイズや長い無音に
 * 引きずられないようにするため。
 */
function estimateNoiseFloorDb(values: Float32Array): number {
  const db = Array.from(values, toDb).sort((a, b) => a - b);
  if (db.length === 0) return SILENCE_DB;
  const index = Math.floor(db.length * 0.2);
  return db[Math.min(index, db.length - 1)]!;
}

interface Run {
  speakerId: string;
  startFrame: number;
  endFrame: number;
}

/** 連続した true の区間を取り出し、短い途切れを繋ぐ。 */
function toRuns(
  active: boolean[],
  speakerId: string,
  mergeGapFrames: number,
): Run[] {
  const runs: Run[] = [];
  let start: number | null = null;

  for (let f = 0; f <= active.length; f++) {
    const on = f < active.length && active[f]!;
    if (on && start === null) start = f;
    if (!on && start !== null) {
      const last = runs[runs.length - 1];
      if (last && start - last.endFrame <= mergeGapFrames) {
        last.endFrame = f;
      } else {
        runs.push({ speakerId, startFrame: start, endFrame: f });
      }
      start = null;
    }
  }
  return runs;
}

function overlapsFrames(a: Run, b: Run): number {
  return Math.max(0, Math.min(a.endFrame, b.endFrame) - Math.max(a.startFrame, b.startFrame));
}

/**
 * 話者を判定する。
 *
 * 各マイクについて「ノイズフロアより十分大きく、かつ他のマイクより
 * 支配的」なフレームを発話とみなす。その後、短いものを相槌に分類する。
 */
export function detectSpeakers(
  mics: readonly MicTrack[],
  options: Partial<SpeakerDetectOptions> = {},
): SpeakerDetectResult {
  const opt = { ...DEFAULT_SPEAKER_OPTIONS, ...options };
  const noiseFloorDb = new Map<string, number>();

  if (mics.length === 0) {
    return { speech: [], backchannels: [], overlaps: [], noiseFloorDb };
  }

  const frameRate = mics[0]!.envelope.frameRate;
  for (const mic of mics) {
    if (mic.envelope.frameRate !== frameRate) {
      throw new Error('マイクのエンベロープのフレームレートが一致していません');
    }
  }

  // オフセットを引いて、全マイクを引き映像基準の時刻に揃える。
  const shifted = mics.map((mic) => {
    const shift = Math.round((mic.offsetSec ?? 0) * frameRate);
    return { speakerId: mic.speakerId, values: mic.envelope.values, shift };
  });

  const frameCount = Math.max(
    ...shifted.map((m) => m.values.length - m.shift),
  );

  const db = new Map<string, Float32Array>();
  for (const mic of shifted) {
    const series = new Float32Array(frameCount);
    for (let f = 0; f < frameCount; f++) {
      const index = f + mic.shift;
      series[f] =
        index >= 0 && index < mic.values.length
          ? toDb(mic.values[index]!)
          : SILENCE_DB;
    }
    db.set(mic.speakerId, series);
    noiseFloorDb.set(mic.speakerId, estimateNoiseFloorDb(mic.values));
  }

  // 「鳴っている」判定と「支配的」判定。
  const activeMap = new Map<string, boolean[]>();
  const loudMap = new Map<string, boolean[]>();
  for (const mic of shifted) {
    activeMap.set(mic.speakerId, new Array(frameCount).fill(false));
    loudMap.set(mic.speakerId, new Array(frameCount).fill(false));
  }

  for (let f = 0; f < frameCount; f++) {
    let best = -Infinity;
    for (const mic of shifted) {
      const level = db.get(mic.speakerId)![f]!;
      if (level > best) best = level;
    }

    for (const mic of shifted) {
      const level = db.get(mic.speakerId)![f]!;
      const floor = noiseFloorDb.get(mic.speakerId)!;
      const loud = level > floor + opt.activationMarginDb;
      loudMap.get(mic.speakerId)![f] = loud;
      // 他のマイクとの差が dominanceMargin 未満なら「支配的でない」＝同時発話。
      activeMap.get(mic.speakerId)![f] =
        loud && level >= best - opt.dominanceMarginDb;
    }
  }

  const mergeGapFrames = Math.round(opt.mergeGapSec * frameRate);
  const minSpeechFrames = Math.round(opt.minSpeechSec * frameRate);
  const backchannelFrames = Math.round(opt.backchannelMaxSec * frameRate);

  const allRuns: Run[] = [];
  for (const mic of shifted) {
    allRuns.push(
      ...toRuns(activeMap.get(mic.speakerId)!, mic.speakerId, mergeGapFrames),
    );
  }
  allRuns.sort((a, b) => a.startFrame - b.startFrame);

  const speechRuns: Run[] = [];
  const backchannelRuns: Run[] = [];

  for (const run of allRuns) {
    const length = run.endFrame - run.startFrame;

    // 他の人の「より長い発話」と重なっている短い発声は相槌とみなす。
    const coveredByLonger = allRuns.some(
      (other) =>
        other.speakerId !== run.speakerId &&
        other.endFrame - other.startFrame > length &&
        overlapsFrames(run, other) > length * 0.5,
    );

    if (length <= backchannelFrames && coveredByLonger) {
      backchannelRuns.push(run);
      continue;
    }
    if (length < minSpeechFrames) {
      // 短いが相槌でもないもの（単独の短い発話）は情報として残す。
      backchannelRuns.push(run);
      continue;
    }
    speechRuns.push(run);
  }

  const toSegment = (run: Run): SpeechSegment => ({
    startSec: run.startFrame / frameRate,
    endSec: run.endFrame / frameRate,
    speakerId: run.speakerId,
    text: '',
  });

  // 同時発話区間の抽出。
  const overlaps: SpeakerDetectResult['overlaps'] = [];
  for (let i = 0; i < speechRuns.length; i++) {
    for (let j = i + 1; j < speechRuns.length; j++) {
      const a = speechRuns[i]!;
      const b = speechRuns[j]!;
      if (a.speakerId === b.speakerId) continue;
      const frames = overlapsFrames(a, b);
      if (frames <= 0) continue;
      overlaps.push({
        startSec: Math.max(a.startFrame, b.startFrame) / frameRate,
        endSec: Math.min(a.endFrame, b.endFrame) / frameRate,
        speakerIds: [a.speakerId, b.speakerId],
      });
    }
  }

  return {
    speech: speechRuns.map(toSegment),
    backchannels: backchannelRuns.map(toSegment),
    overlaps,
    noiseFloorDb,
  };
}

export interface LaughterOptions {
  /** 笑いと見なす最短の長さ。 */
  minLaughSec: number;
  /** 複数人の同時発声がこの人数以上で笑いの候補にする。 */
  minSpeakers: number;
  /** エンベロープの変動の深さの下限（変動係数）。 */
  minModulation: number;
  /**
   * 音量変動の速さ（Hz）の下限。
   * 通常の発話の音節速度は4〜6Hz程度。笑いはそれより速く途切れるため、
   * 音節速度より上に下限を置くことで会話の被りと区別する。
   */
  minModulationRateHz: number;
  /** 同上の上限。これを超える変動はノイズとみなす。 */
  maxModulationRateHz: number;
}

export const DEFAULT_LAUGHTER_OPTIONS: LaughterOptions = {
  minLaughSec: 0.8,
  minSpeakers: 2,
  minModulation: 0.35,
  minModulationRateHz: 6,
  maxModulationRateHz: 14,
};

/**
 * エンベロープの変動の深さ（変動係数）と速さ（Hz）を測る。
 *
 * 速さは平均を挟んだ往復回数から求める。深さだけでは「抑揚のある通常の
 * 発話」と区別できないため、速さの条件を併用する。
 *
 * ★往復の数え方にヒステリシス（不感帯）を設ける。エンベロープには
 * 細かなリップルが必ず乗るため、単純な符号反転を数えると変動の速さを
 * 過大評価してしまう（自己検証で実際にこの誤検出が起きた）。
 * 標準偏差の一定割合を超える往復だけを1周期として数える。
 */
function measureModulation(
  values: Float32Array,
  from: number,
  to: number,
  frameRate: number,
  /** 不感帯の幅（標準偏差に対する比）。 */
  hysteresisRatio = 0.5,
): { depth: number; rateHz: number } {
  const n = to - from;
  if (n < 4) return { depth: 0, rateHz: 0 };

  let sum = 0;
  for (let f = from; f < to; f++) sum += values[f]!;
  const mean = sum / n;
  if (mean <= 0) return { depth: 0, rateHz: 0 };

  let variance = 0;
  for (let f = from; f < to; f++) {
    const d = values[f]! - mean;
    variance += d * d;
  }
  const stdDev = Math.sqrt(variance / n);
  if (stdDev <= 0) return { depth: 0, rateHz: 0 };

  const threshold = stdDev * hysteresisRatio;
  let crossings = 0;
  // 0 = まだどちらにも振れていない、1 = 上に振れた、-1 = 下に振れた
  let state = 0;

  for (let f = from; f < to; f++) {
    const d = values[f]! - mean;
    if (d > threshold && state !== 1) {
      if (state !== 0) crossings += 1;
      state = 1;
    } else if (d < -threshold && state !== -1) {
      if (state !== 0) crossings += 1;
      state = -1;
    }
  }

  const durationSec = n / frameRate;
  return {
    depth: stdDev / mean,
    // 1周期に上下の往復が2回起きるため2で割る。
    rateHz: crossings / 2 / durationSec,
  };
}

/**
 * 笑いの候補を検出する。
 *
 * ★削るためではなく活かすための情報。カメラを引きに切り替える手がかりと、
 * ショート候補の手がかりに使う。
 *
 * 判定は「複数人が同時に発声し、かつ音量の変動が深く・速い区間」。
 * 変動の深さだけでは抑揚のある通常の発話と区別できないため、変動の速さ
 * （音節速度より上）を併用する。
 *
 * ⚠️ **これは暫定的なヒューリスティックです。** 音量変動だけで笑いを確実に
 * 判別することはできません。実素材では以下で精度を上げる前提です:
 *   1. 文字起こしの「(笑)」相当の表記との突き合わせ（主たる根拠にする）
 *   2. 実際の笑い声で minModulationRateHz を調整
 * confidence が低い候補は、マーカーのコメントにその旨を記載して編集者に委ねます。
 */
export function detectLaughterCandidates(
  mics: readonly MicTrack[],
  overlaps: readonly { startSec: number; endSec: number; speakerIds: string[] }[],
  options: Partial<LaughterOptions> = {},
): LaughterSegment[] {
  const opt = { ...DEFAULT_LAUGHTER_OPTIONS, ...options };
  if (mics.length === 0) return [];

  const frameRate = mics[0]!.envelope.frameRate;
  const candidates: LaughterSegment[] = [];

  for (const overlap of overlaps) {
    if (overlap.endSec - overlap.startSec < opt.minLaughSec) continue;
    if (overlap.speakerIds.length < opt.minSpeakers) continue;

    let bestDepth = 0;
    let bestRate = 0;
    for (const mic of mics) {
      const from = Math.max(0, Math.round(overlap.startSec * frameRate));
      const to = Math.min(
        mic.envelope.values.length,
        Math.round(overlap.endSec * frameRate),
      );
      const { depth, rateHz } = measureModulation(
        mic.envelope.values,
        from,
        to,
        frameRate,
      );
      // 最も「笑いらしい」マイクの数値を代表値にする。
      if (
        depth >= opt.minModulation &&
        rateHz >= opt.minModulationRateHz &&
        rateHz <= opt.maxModulationRateHz &&
        depth > bestDepth
      ) {
        bestDepth = depth;
        bestRate = rateHz;
      }
    }

    if (bestDepth > 0) {
      // 変動が深く、速さが帯域の中心に近いほど確信度を上げる。
      const center =
        (opt.minModulationRateHz + opt.maxModulationRateHz) / 2;
      const span = (opt.maxModulationRateHz - opt.minModulationRateHz) / 2;
      const rateScore = 1 - Math.min(1, Math.abs(bestRate - center) / span);
      const depthScore = Math.min(1, bestDepth / 0.7);
      candidates.push({
        startSec: overlap.startSec,
        endSec: overlap.endSec,
        speakerIds: overlap.speakerIds,
        confidence: Number(((rateScore + depthScore) / 2).toFixed(3)),
      });
    }
  }

  return candidates;
}
