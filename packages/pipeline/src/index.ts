/**
 * packages/pipeline の公開面。
 *
 * ★このパッケージは React / Electron / DOM を一切importしない。
 * CLI（cli/src/pipeline.ts）とGUI（将来のElectronメインプロセス）の
 * どちらからも、ここに書かれた関数と型だけで完結して呼び出せる。
 */

export * from './types.ts';
export * from './registry.ts';
export * from './errors.ts';
export * from './hash.ts';
export * from './paths.ts';
export * from './logger.ts';
export * from './process.ts';
export * from './envelope-cache.ts';
export * from './diff-report.ts';
export * from './run-pipeline.ts';
export { DEFAULT_STEP_DEFINITIONS } from './steps/index.ts';
