/**
 * Renderer（ブラウザ向け）のビルド設定。
 *
 * ★Main / Preload / 解析専用プロセスはここではビルドしない（tsup.config.ts）。
 * Node向けとブラウザ向けでビルドを分けることで、レンダラーのバンドルに
 * fs や child_process が混ざらないようにする。
 */

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'src/renderer',
  // file:// から読み込むため相対パスで出力する。
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    // 開発時の調査用。配布時に外部公開されるものではない。
    sourcemap: true,
  },
  server: {
    port: 5183,
    strictPort: true,
  },
});
