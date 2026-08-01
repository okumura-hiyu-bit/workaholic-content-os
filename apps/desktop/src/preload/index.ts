/**
 * Preload。contextBridge で最小限のAPIだけを公開する。
 *
 * ★sandbox: true で動くため、このファイルはCJSにバンドルされ、
 * electron 以外のモジュールを読み込まない（tsup.config.ts の preload 設定）。
 */

import { contextBridge, ipcRenderer } from 'electron';

import { createDesktopApi, type IpcBridge } from './api.ts';

const bridge: IpcBridge = {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  on: (channel, listener) => {
    ipcRenderer.on(channel, listener as never);
  },
  removeListener: (channel, listener) => {
    ipcRenderer.removeListener(channel, listener as never);
  },
};

contextBridge.exposeInMainWorld('contentOs', createDesktopApi(bridge));
