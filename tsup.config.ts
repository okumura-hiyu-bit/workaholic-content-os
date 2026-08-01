/**
 * Electronメインプロセス向けのビルド定義。
 *
 * ★なぜ必要か
 * CLIは `node --experimental-strip-types` でTypeScriptソースを直接実行できるが、
 * Electronのメインプロセスではこの方法が使えない。GUIから解析を呼ぶには、
 * packages/* を通常のJavaScriptに変換したものが必要になる。
 *
 * ★何を出力するか
 * GUIがimportしてよい入口だけをentryにする（依存の向きを崩さないため）。
 *   - pipeline … 解析の実行（runPipeline）。CLIとGUIが共用する唯一の入口
 *   - core     … プロジェクトの読み書き・3レイヤーの統合（確認画面が使う）
 *
 * ★形式
 * packages/* はすべて `"type": "module"` なのでESMのみを出力する。
 * splitting を有効にして core を共有チャンクに切り出し、pipeline側に
 * core のコピーが二重に入るのを防ぐ（＝実行時のcoreは常に単一インスタンス）。
 *
 * ★なぜビルドを3つに分けているか
 * 複数entryと .d.ts 生成を1パスで同時に行うと tsup が宣言のロールアップに
 * 失敗する（`Error parsing ... project.ts`）。entry単体なら成功するため、
 * JS（splittingあり・1パス）と .d.ts（entryごと）を分離している。
 * 型は分離しても実体は同じソースから生成されるのでズレは生じない。
 *
 * ★注意（GUI実装時）
 * scripts/transcribe.py と .venv は `projectRoot ?? process.cwd()` から解決される
 * （packages/media/src/transcribe.ts）。Electronアプリのcwdはリポジトリルートでは
 * ないため、GUIから呼ぶときは projectRoot を明示的に渡すこと。
 */
import { defineConfig, type Options } from 'tsup';

const shared = {
  outDir: 'dist',
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  // node:* 以外の実行時依存はない（packages/* は相互依存のみ）ため、
  // 出力は自己完結したバンドルになる。
} satisfies Options;

export default defineConfig([
  // ① JS本体。2つのentryをまとめて1パスで作り、共有部分をチャンクに切り出す。
  {
    ...shared,
    entry: {
      pipeline: 'packages/pipeline/src/index.ts',
      core: 'packages/core/src/index.ts',
    },
    splitting: true,
    sourcemap: true,
    clean: true,
  },
  // ②③ 型定義。entryごとに単独パスで生成する（上記「なぜ3つか」を参照）。
  {
    ...shared,
    entry: { pipeline: 'packages/pipeline/src/index.ts' },
    dts: { only: true },
  },
  {
    ...shared,
    entry: { core: 'packages/core/src/index.ts' },
    dts: { only: true },
  },
]);
