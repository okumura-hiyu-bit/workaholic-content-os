/**
 * 音声の要確認情報を検出する（自動補正はしない）。
 *
 * クリッピング・チャンネル無音・話者間の極端な音量差は機械的に検出できるが、
 * 「どう直すか」は編集者の判断が要る。検出結果は `[CHECK]` マーカーと
 * 確認画面に出すだけで、音声そのものには一切手を加えない。
 *
 * @see docs/12-premiere-capability-matrix.md 12.7
 */

export interface AudioIssue {
  kind: 'clipping' | 'silent_channel' | 'level_mismatch';
  severity: 'info' | 'warning' | 'error';
  message: string;
  startSec?: number;
  endSec?: number;
}

export interface ClippingOptions {
  /** この振幅以上を「クリップしている」とみなす（0〜1）。 */
  threshold: number;
  /** 何サンプル以上連続したら報告するか（短い誤検出を避ける）。 */
  minRunSamples: number;
}

export const DEFAULT_CLIPPING_OPTIONS: ClippingOptions = {
  threshold: 0.999,
  minRunSamples: 8,
};

/** クリッピング（波形が振り切れている区間）を検出する。 */
export function detectClipping(
  samples: Float32Array,
  sampleRate: number,
  options: Partial<ClippingOptions> = {},
): AudioIssue[] {
  const opt = { ...DEFAULT_CLIPPING_OPTIONS, ...options };
  const issues: AudioIssue[] = [];

  let runStart = -1;
  for (let i = 0; i <= samples.length; i++) {
    const clipped = i < samples.length && Math.abs(samples[i]!) >= opt.threshold;
    if (clipped && runStart === -1) {
      runStart = i;
    } else if (!clipped && runStart !== -1) {
      const runLength = i - runStart;
      if (runLength >= opt.minRunSamples) {
        const startSec = runStart / sampleRate;
        const endSec = i / sampleRate;
        issues.push({
          kind: 'clipping',
          severity: 'warning',
          message: `クリッピング（${(endSec - startSec).toFixed(2)}秒）`,
          startSec: Number(startSec.toFixed(3)),
          endSec: Number(endSec.toFixed(3)),
        });
      }
      runStart = -1;
    }
  }

  return issues;
}

/** チャンネルが無音（無入力・断線の疑い）かを判定する。 */
export function detectSilentChannel(
  samples: Float32Array,
  label: string,
  /** これ未満のピークなら無音とみなす。 */
  threshold = 0.001,
): AudioIssue[] {
  if (samples.length === 0) return [];
  let peak = 0;
  for (const s of samples) {
    const abs = Math.abs(s);
    if (abs > peak) peak = abs;
  }
  if (peak < threshold) {
    return [
      {
        kind: 'silent_channel',
        severity: 'error',
        message: `${label} がほぼ無音です（ピーク ${peak.toExponential(2)}）。マイクの接続を確認してください`,
      },
    ];
  }
  return [];
}

/** 話者間のレベル差を検出する（マイク距離差など）。 */
export function detectLevelMismatch(
  levels: readonly { label: string; rmsDb: number }[],
  thresholdDb = 6,
): AudioIssue[] {
  if (levels.length < 2) return [];
  const sorted = [...levels].sort((a, b) => b.rmsDb - a.rmsDb);
  const loudest = sorted[0]!;
  const issues: AudioIssue[] = [];

  for (const level of sorted.slice(1)) {
    const diff = loudest.rmsDb - level.rmsDb;
    if (diff >= thresholdDb) {
      issues.push({
        kind: 'level_mismatch',
        severity: 'info',
        message: `${level.label} が ${loudest.label} より ${diff.toFixed(1)}dB 小さい`,
      });
    }
  }
  return issues;
}
