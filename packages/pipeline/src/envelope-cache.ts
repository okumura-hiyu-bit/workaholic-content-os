/**
 * 音量エンベロープを cache/waveform/ に永続化する。
 *
 * sync-media が計算したエンベロープを、detect-speakers や
 * extract-short-candidates が再デコードなしで再利用するため。
 * cache/ 配下なので削除しても次回実行時に作り直せる。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Envelope } from '@contentos/editing/audio-sync';

function sidecarPath(waveformDir: string, assetId: string): string {
  return join(waveformDir, `${assetId}.json`);
}

function binPath(waveformDir: string, assetId: string): string {
  return join(waveformDir, `${assetId}.f32`);
}

export function writeEnvelopeCache(
  waveformDir: string,
  assetId: string,
  envelope: Envelope,
): void {
  writeFileSync(
    sidecarPath(waveformDir, assetId),
    JSON.stringify({ frameRate: envelope.frameRate, length: envelope.values.length }),
    'utf8',
  );
  writeFileSync(binPath(waveformDir, assetId), Buffer.from(envelope.values.buffer));
}

export function readEnvelopeCache(
  waveformDir: string,
  assetId: string,
): Envelope | undefined {
  try {
    const sidecar = JSON.parse(
      readFileSync(sidecarPath(waveformDir, assetId), 'utf8'),
    ) as { frameRate: number; length: number };
    const bin = readFileSync(binPath(waveformDir, assetId));
    const values = new Float32Array(
      bin.buffer,
      bin.byteOffset,
      Math.min(sidecar.length, bin.byteLength / 4),
    );
    return { frameRate: sidecar.frameRate, values };
  } catch {
    return undefined;
  }
}
