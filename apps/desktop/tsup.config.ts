/**
 * Main / Preload / 解析専用プロセス（すべてNode向け）のビルド設定。
 *
 * ★3つを別々に出す理由
 * - main    … electron を外部参照するCJS。@contentos/core はバンドルする。
 * - preload … sandbox:true で動くため、electron 以外を持ち込まない自己完結CJS。
 * - worker  … 解析専用プロセス。ESM。projectRoot配下の dist/pipeline.js を
 *             実行時に動的importするので、パイプライン本体はバンドルしない。
 */

import { defineConfig, type Options } from 'tsup';

const shared = {
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: false,
} satisfies Options;

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/main/index.ts' },
    outDir: 'dist/main',
    format: ['cjs'],
    outExtension: () => ({ js: '.cjs' }),
    // electron は実行時にElectronが提供する。バンドルしてはいけない。
    external: ['electron'],
  },
  {
    ...shared,
    entry: { index: 'src/preload/index.ts' },
    outDir: 'dist/preload',
    format: ['cjs'],
    outExtension: () => ({ js: '.cjs' }),
    external: ['electron'],
  },
  {
    ...shared,
    entry: { 'analysis-worker': 'src/worker/analysis-worker.ts' },
    outDir: 'dist/worker',
    format: ['esm'],
    outExtension: () => ({ js: '.mjs' }),
  },
]);
