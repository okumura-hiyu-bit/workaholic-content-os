/**
 * 音声同期（オフセット算出）。
 *
 * カメラのスクラッチ音声と引き映像の音声を突き合わせ、フレーム単位の
 * オフセットを求める。この結果をXMLのイン点に反映することで、Premiereを
 * 開いた時点で全カメラが揃った状態になる。
 *
 * 生波形ではなく「音量の時間変化（エンベロープ）」を相関させる。カメラごとに
 * マイクの特性・距離・EQが違うため生波形はそのまま一致しないが、
 * 音量の変化パターンは一致するため、こちらのほうがはるかに頑健。
 *
 * @see docs/11-editing-pipeline.md 11.3①
 */

/** 音量エンベロープ。values の1要素が 1/frameRate 秒に対応する。 */
export interface Envelope {
  /** エンベロープのフレームレート（Hz）。 */
  frameRate: number;
  values: Float32Array;
}

/**
 * RMSエンベロープを計算する。
 *
 * @param hopMs 1フレームの長さ（ミリ秒）。既定10ms＝100Hz。
 */
export function computeEnvelope(
  samples: Float32Array,
  sampleRate: number,
  hopMs = 10,
): Envelope {
  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  const frameCount = Math.floor(samples.length / hop);
  const values = new Float32Array(frameCount);

  for (let f = 0; f < frameCount; f++) {
    const start = f * hop;
    let sum = 0;
    for (let i = start; i < start + hop; i++) {
      const s = samples[i]!;
      sum += s * s;
    }
    values[f] = Math.sqrt(sum / hop);
  }

  return { frameRate: 1000 / hopMs, values };
}

/** エンベロープを整数倍に間引く。粗探索を高速化するために使う。 */
function decimate(envelope: Envelope, factor: number): Envelope {
  if (factor <= 1) return envelope;
  const count = Math.floor(envelope.values.length / factor);
  const values = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    let sum = 0;
    for (let j = 0; j < factor; j++) sum += envelope.values[i * factor + j]!;
    values[i] = sum / factor;
  }
  return { frameRate: envelope.frameRate / factor, values };
}

/**
 * 指定したラグでの正規化相互相関（ピアソン相関）を求める。
 *
 * 平均を引いて正規化するため、マイクごとの音量差の影響を受けない。
 * `target[t + lag] ≈ reference[t]` となる lag を探すのが目的。
 */
function correlationAtLag(
  reference: Float32Array,
  target: Float32Array,
  lag: number,
): number {
  const start = Math.max(0, -lag);
  const end = Math.min(reference.length, target.length - lag);
  const n = end - start;
  // 重なりが短すぎる比較は信用できない。
  if (n < 32) return 0;

  let sumR = 0;
  let sumT = 0;
  for (let t = start; t < end; t++) {
    sumR += reference[t]!;
    sumT += target[t + lag]!;
  }
  const meanR = sumR / n;
  const meanT = sumT / n;

  let num = 0;
  let devR = 0;
  let devT = 0;
  for (let t = start; t < end; t++) {
    const dr = reference[t]! - meanR;
    const dt = target[t + lag]! - meanT;
    num += dr * dt;
    devR += dr * dr;
    devT += dt * dt;
  }

  const denom = Math.sqrt(devR * devT);
  return denom === 0 ? 0 : num / denom;
}

export interface SyncOptions {
  /** 探索するオフセットの範囲（秒）。既定±30秒。 */
  maxOffsetSec: number;
  /** 粗探索の間引き率。既定4（100Hz→25Hz）。 */
  coarseFactor: number;
  /** この相関を下回ったら信頼できないと判断する。 */
  minConfidence: number;
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  maxOffsetSec: 30,
  coarseFactor: 4,
  minConfidence: 0.5,
};

export interface SyncResult {
  /**
   * オフセット秒。`target` の中で `reference` と同じ内容が
   * `offsetSec` だけ後ろにある、という意味。
   * XMLのイン点は「タイムライン上の時刻 + offsetSec」で求める。
   */
  offsetSec: number;
  /** 正規化相互相関の最大値（0〜1）。 */
  confidence: number;
  /** minConfidence を満たしたか。false なら人の確認が必要。 */
  reliable: boolean;
}

/**
 * 2つのエンベロープからオフセットを推定する。
 *
 * 粗探索（間引き）→ 細探索（元解像度で±数フレーム）の2段構えにして、
 * 10分素材でも実用的な速度で全範囲を探索できるようにしている。
 */
export function estimateOffset(
  reference: Envelope,
  target: Envelope,
  options: Partial<SyncOptions> = {},
): SyncResult {
  const opt = { ...DEFAULT_SYNC_OPTIONS, ...options };

  if (reference.frameRate !== target.frameRate) {
    throw new Error('エンベロープのフレームレートが一致していません');
  }
  if (reference.values.length === 0 || target.values.length === 0) {
    return { offsetSec: 0, confidence: 0, reliable: false };
  }

  const factor = Math.max(1, Math.floor(opt.coarseFactor));
  const coarseRef = decimate(reference, factor);
  const coarseTarget = decimate(target, factor);

  const coarseMaxLag = Math.round(opt.maxOffsetSec * coarseRef.frameRate);
  let bestCoarseLag = 0;
  let bestCoarseScore = -Infinity;

  for (let lag = -coarseMaxLag; lag <= coarseMaxLag; lag++) {
    const score = correlationAtLag(coarseRef.values, coarseTarget.values, lag);
    if (score > bestCoarseScore) {
      bestCoarseScore = score;
      bestCoarseLag = lag;
    }
  }

  // 粗探索の当たりを元解像度に戻し、その周辺だけを1フレーム刻みで探す。
  const center = bestCoarseLag * factor;
  const window = factor * 2;
  let bestLag = center;
  let bestScore = -Infinity;

  for (let lag = center - window; lag <= center + window; lag++) {
    const score = correlationAtLag(reference.values, target.values, lag);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  const confidence = Math.max(0, bestScore);
  return {
    offsetSec: bestLag / reference.frameRate,
    confidence,
    reliable: confidence >= opt.minConfidence,
  };
}

/**
 * 引き映像を基準に、各素材のオフセットをまとめて求める。
 *
 * 基準素材自身のオフセットは常に0。信頼度が低いものは reliable=false で
 * 返し、`[CHECK]` マーカーと管理画面で編集者に知らせる。
 */
export function syncSources(
  reference: { id: string; envelope: Envelope },
  targets: readonly { id: string; envelope: Envelope }[],
  options: Partial<SyncOptions> = {},
): Map<string, SyncResult> {
  const results = new Map<string, SyncResult>();
  results.set(reference.id, { offsetSec: 0, confidence: 1, reliable: true });

  for (const target of targets) {
    if (target.id === reference.id) continue;
    results.set(
      target.id,
      estimateOffset(reference.envelope, target.envelope, options),
    );
  }
  return results;
}
