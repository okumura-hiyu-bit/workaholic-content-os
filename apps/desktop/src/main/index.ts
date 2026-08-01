/**
 * Electron メインプロセスの入口。
 *
 * ★このファイルの責務は「配線」だけ。
 * 検証・排他・エラー変換などの判断は main/*.ts の純粋なモジュールが持ち、
 * ここは electron の API とそれらを繋ぐ。テストしづらい部分を薄く保つため。
 *
 * ★解析はこのプロセスで実行しない。
 * runPipeline() は解析専用プロセス（worker/analysis-worker.ts）で動かす。
 * 同期CPU処理（相互相関など）でウィンドウが固まるのを避けるため。
 */

import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';

import { loadProject } from '@contentos/core/project-store';

import type { PipelineFinishedEvent, PipelineProgressEvent } from '../shared/dto.ts';
import { IPC } from '../shared/ipc.ts';
import { forkAnalysisProcess } from './analysis-process.ts';
import { createIpcHandlers } from './ipc.ts';
import { consoleSink, createLogger } from './logger.ts';
import { PROJECT_FILE_NAME } from './project.ts';
import { preflightEnvironment, resolveProjectRoot } from './project-root.ts';
import { RunManager } from './run-manager.ts';

const logger = createLogger(consoleSink);

const fsDeps = {
  fileExists: (path: string): boolean => existsSync(path),
  readTextFile: (path: string): string | undefined => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/** projectRoot は起動時に一度だけ解決し、以後は使い回す。 */
function resolveRootOnce(): ReturnType<typeof resolveProjectRoot> {
  return resolveProjectRoot(
    {
      explicitRoot: process.env.CONTENTOS_PROJECT_ROOT,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      appPath: app.getAppPath(),
    },
    fsDeps,
  );
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 900,
    minHeight: 640,
    title: 'WORKAHOLIC Content OS',
    backgroundColor: '#f5f7fa',
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devServer = process.env.CONTENTOS_RENDERER_URL;
  if (devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
  }

  return window;
}

function wire(window: BrowserWindow): RunManager {
  const send = (channel: string, payload: unknown): void => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  };

  const runManager = new RunManager({
    spawn: forkAnalysisProcess,
    workerPath: join(__dirname, '..', 'worker', 'analysis-worker.mjs'),
    newRunId: () => `run-${randomUUID()}`,
    now: () => Date.now(),
    emitProgress: (event: PipelineProgressEvent) => send(IPC.pipelineProgress, event),
    emitFinished: (event: PipelineFinishedEvent) => send(IPC.pipelineFinished, event),
    logger,
  });

  const handlers = createIpcHandlers({
    runManager,
    fileExists: fsDeps.fileExists,
    loadProject: (dir: string) => loadProject(dir),
    async showProjectDialog() {
      const result = await dialog.showOpenDialog(window, {
        title: 'project.json を選択',
        properties: ['openFile'],
        filters: [{ name: 'Content OS プロジェクト', extensions: ['json'] }],
      });
      if (result.canceled || result.filePaths.length === 0) return undefined;
      return result.filePaths[0];
    },
    async openFolder(path: string) {
      await shell.openPath(path);
    },
    resolveRoot() {
      const resolved = resolveRootOnce();
      return resolved.ok
        ? { ok: true, projectRoot: resolved.projectRoot }
        : { ok: false, error: resolved.error };
    },
    preflight(projectRoot: string) {
      const result = preflightEnvironment(projectRoot, fsDeps);
      return result.error ? { ok: result.ok, error: result.error } : { ok: result.ok };
    },
  });

  ipcMain.handle(IPC.selectProject, () => handlers.selectProject());
  ipcMain.handle(IPC.readProjectSummary, (_e, path: unknown) =>
    handlers.readProjectSummary(path),
  );
  ipcMain.handle(IPC.startPipeline, (_e, request: unknown) =>
    handlers.startPipeline(request),
  );
  ipcMain.handle(IPC.cancelPipeline, (_e, runId: unknown) =>
    handlers.cancelPipeline(runId),
  );
  ipcMain.handle(IPC.openProjectFolder, (_e, path: unknown) =>
    handlers.openProjectFolder(path),
  );

  return runManager;
}

let runManager: RunManager | undefined;

void app.whenReady().then(() => {
  const root = resolveRootOnce();
  if (root.ok) {
    logger.info('実行環境を解決', {
      projectRoot: root.projectRoot,
      source: root.source,
      projectFile: PROJECT_FILE_NAME,
    });
  } else {
    logger.error('実行環境を解決できません', { code: root.error.code });
  }

  const window = createWindow();
  runManager = wire(window);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const next = createWindow();
      runManager = wire(next);
    }
  });
});

/** ★アプリ終了時に実行中の解析を必ず止める。 */
app.on('before-quit', () => {
  runManager?.disposeAll();
});

app.on('window-all-closed', () => {
  runManager?.disposeAll();
  if (process.platform !== 'darwin') app.quit();
});
