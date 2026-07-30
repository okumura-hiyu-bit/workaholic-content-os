import { describe, expect, it } from 'vitest';

import {
  canonicalize,
  hashAssetFingerprints,
  hashConfig,
  hashFromDependencyOutputs,
  sha256,
} from './hash.ts';

describe('canonicalize', () => {
  it('キー順序に依存しない', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it('配列の順序は保持する', () => {
    expect(canonicalize([1, 2, 3])).not.toBe(canonicalize([3, 2, 1]));
  });

  it('入れ子でも順序に依存しない', () => {
    expect(canonicalize({ x: { b: 1, a: 2 } })).toBe(canonicalize({ x: { a: 2, b: 1 } }));
  });
});

describe('sha256 / hashConfig', () => {
  it('同じ入力は同じハッシュになる', () => {
    expect(sha256('a')).toBe(sha256('a'));
  });

  it('違う入力は違うハッシュになる', () => {
    expect(sha256('a')).not.toBe(sha256('b'));
  });

  it('hashConfig はキー順序に依存しない', () => {
    expect(hashConfig({ model: 'large-v3', lang: 'ja' })).toBe(
      hashConfig({ lang: 'ja', model: 'large-v3' }),
    );
  });

  it('★モデル名を変えるとハッシュが変わる', () => {
    expect(hashConfig({ model: 'large-v3' })).not.toBe(hashConfig({ model: 'small' }));
  });
});

describe('hashAssetFingerprints', () => {
  it('サイズ・更新時刻が同じなら同じハッシュ', () => {
    const a = [{ path: '/a.mp4', sizeBytes: 100, mtimeMs: 1000 }];
    const b = [{ path: '/a.mp4', sizeBytes: 100, mtimeMs: 1000 }];
    expect(hashAssetFingerprints(a)).toBe(hashAssetFingerprints(b));
  });

  it('★更新時刻が変われば違うハッシュになる（素材の差し替え検知）', () => {
    const a = [{ path: '/a.mp4', sizeBytes: 100, mtimeMs: 1000 }];
    const b = [{ path: '/a.mp4', sizeBytes: 100, mtimeMs: 2000 }];
    expect(hashAssetFingerprints(a)).not.toBe(hashAssetFingerprints(b));
  });

  it('並び順に依存しない', () => {
    const a = [
      { path: '/b.mp4', sizeBytes: 1, mtimeMs: 1 },
      { path: '/a.mp4', sizeBytes: 1, mtimeMs: 1 },
    ];
    const b = [...a].reverse();
    expect(hashAssetFingerprints(a)).toBe(hashAssetFingerprints(b));
  });

  it('空配列でも安定する', () => {
    expect(hashAssetFingerprints([])).toBe(hashAssetFingerprints([]));
  });
});

describe('hashFromDependencyOutputs — 連鎖的な無効化', () => {
  it('依存の出力ハッシュが同じなら同じ値', () => {
    expect(hashFromDependencyOutputs(['h1', 'h2'])).toBe(
      hashFromDependencyOutputs(['h1', 'h2']),
    );
  });

  it('★依存の出力ハッシュが1つでも変われば違う値になる', () => {
    expect(hashFromDependencyOutputs(['h1', 'h2'])).not.toBe(
      hashFromDependencyOutputs(['h1', 'h3']),
    );
  });

  it('依存が無い（undefined）場合も安定する', () => {
    expect(hashFromDependencyOutputs([undefined])).toBe(
      hashFromDependencyOutputs([undefined]),
    );
  });

  it('extra情報を混ぜられる', () => {
    expect(hashFromDependencyOutputs(['h1'], { syncMode: 'preserve' })).not.toBe(
      hashFromDependencyOutputs(['h1'], { syncMode: 'common' }),
    );
  });
});
