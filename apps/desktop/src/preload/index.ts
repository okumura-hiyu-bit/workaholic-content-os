/**
 * Preload。contextBridge で最小限のAPIだけを公開する。
 *
 * ★sandbox: true で動くため、このファイルはCJSにバンドルされ、
 * electron 以外のモジュールを読み込まない（tsup.config.ts の preload 設定）。
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';

import { createDesktopApi, type IpcBridge } from './api.ts';

const bridge: IpcBridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  /**
   * ★Electron 32以降、Renderer から File.path は読めない。
   * 公式の代替である webUtils.getPathForFile をこの層で呼び、
   * 得た絶対パスは Renderer へ返さずそのまま Main へ渡す。
   */
  resolveDroppedPath: (file) => {
    try {
      const path = webUtils.getPathForFile(file as never);
      return typeof path === 'string' && path.length > 0 ? path : undefined;
    } catch {
      return undefined;
    }
  },
  on: (channel, listener) => {
    ipcRenderer.on(channel, listener as never);
  },
  removeListener: (channel, listener) => {
    ipcRenderer.removeListener(channel, listener as never);
  },
};

contextBridge.exposeInMainWorld('contentOs', createDesktopApi(bridge));
