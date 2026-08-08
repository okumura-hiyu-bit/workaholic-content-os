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

import {
  accessSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  statfsSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron';

import { createProject } from '@contentos/core/project';
import { loadProject, saveProject } from '@contentos/core/project-store';
import { recordEdit, resolveProject } from '@contentos/core/resolve';
import { probeMedia, resolveBinary } from '@contentos/media/ffmpeg';

import type { PipelineFinishedEvent, PipelineProgressEvent } from '../shared/dto.ts';
import { DESKTOP_ERROR_CODES, safeError } from '../shared/errors.ts';
import { IPC } from '../shared/ipc.ts';
import type { OpenMediaResult } from '../shared/review-dto.ts';
import { forkAnalysisProcess } from './analysis-process.ts';
import { createIpcHandlers } from './ipc.ts';
import { consoleSink, createLogger } from './logger.ts';
import {
  ensurePreview,
  existingPreview,
  MEDIA_PROTOCOL,
  MediaTokenRegistry,
  tokenFromUrl,
  type MediaDeps,
} from './media.ts';
import { PROJECT_FILE_NAME } from './project.ts';
import { preflightEnvironment, resolveProjectRoot } from './project-root.ts';
import type { AssetDeps } from './assets.ts';
import type { CreateProjectDeps } from './project-create.ts';
import type { RegistryDeps } from './project-registry.ts';
import { rememberProject } from './project-registry.ts';
import type { ProjectLike, ReviewDeps } from './review.ts';
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

// ─── 再生用プレビュー ──────────────────────────────────

const mediaRegistry = new MediaTokenRegistry(() => randomUUID().replace(/-/g, ''));

const mediaDeps: MediaDeps = {
  fileExists: fsDeps.fileExists,
  ensureDir: (path: string) => {
    mkdirSync(path, { recursive: true });
  },
  runFfmpeg: (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(resolveBinary('ffmpeg'), args, { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`)),
      );
    }),
  registry: mediaRegistry,
};

/**
 * `contentos-media://<token>` を実ファイルへ解決する。
 * ★レジストリに登録済みのパスしか返さない。Rendererは任意のファイルを読めない。
 */
function registerMediaProtocol(): void {
  protocol.handle(MEDIA_PROTOCOL, (request) => {
    const token = tokenFromUrl(request.url);
    const path = token !== undefined ? mediaRegistry.resolve(token) : undefined;
    if (path === undefined) {
      logger.error('未登録のメディア要求を拒否', { url: request.url });
      return new Response('not found', { status: 404 });
    }
    return net.fetch(pathToFileURL(path).href);
  });
}

function canAccess(path: string, mode: number): boolean {
  try {
    accessSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

/** アプリ設定（プロジェクト一覧）の保存先。★ローカル完結・固定費0円。 */
function registryPath(): string {
  return join(app.getPath('userData'), 'projects.json');
}

const registryDeps: RegistryDeps = {
  read: () => {
    try {
      return readFileSync(registryPath(), 'utf8');
    } catch {
      return undefined;
    }
  },
  write: (contents) => {
    const path = registryPath();
    mkdirSync(join(path, '..'), { recursive: true });
    // ★一時ファイル→rename。書き込み途中で落ちても一覧が壊れない。
    const temp = `${path}.tmp`;
    writeFileSync(temp, contents, 'utf8');
    renameSync(temp, path);
  },
  loadProject: (dir) => loadProject(dir) as unknown as { project: ProjectLike },
  fileExists: fsDeps.fileExists,
  now: () => new Date(),
};

const creatorDeps: CreateProjectDeps = {
  createProject: (input) => createProject(input) as unknown as ProjectLike,
  saveProject: (dir, project) => saveProject(dir, project as never),
  fileExists: fsDeps.fileExists,
  ensureDir: (path) => {
    mkdirSync(path, { recursive: true });
  },
  canWrite: (dir) => canAccess(dir, fsConstants.W_OK),
  remember: (dir) => {
    rememberProject(dir, registryDeps);
  },
  now: () => new Date(),
};

const assetDeps: AssetDeps = {
  loadProject: (dir) => loadProject(dir) as unknown as { project: ProjectLike },
  saveProject: (dir, project) => saveProject(dir, project as never),
  fileExists: fsDeps.fileExists,
  canRead: (path) => canAccess(path, fsConstants.R_OK),
  canWrite: (dir) => canAccess(dir, fsConstants.W_OK),
  statFile: (path) => {
    try {
      const stat = statSync(path);
      return { sizeBytes: stat.size, mtimeMs: stat.mtimeMs };
    } catch {
      return undefined;
    }
  },
  // ★ffprobe。読むだけで元素材は変更しない。
  probe: (path) => probeMedia(path),
  freeBytes: (dir) => {
    try {
      const stats = statfsSync(dir);
      return stats.bavail * stats.bsize;
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

  // ★確認画面の依存。core の関数をそのまま渡す（独自の突き合わせを作らない）。
  const reviewDeps: ReviewDeps = {
    loadProject: (dir: string) => loadProject(dir) as unknown as { project: ProjectLike; notes?: string[] },
    saveProject: (dir: string, project: ProjectLike) =>
      saveProject(dir, project as never),
    resolveProject: (analysis, edits) =>
      resolveProject(analysis as never, edits as never) as never,
    recordEdit: (edits, entry) => recordEdit(edits as never, entry) as never,
    // 読み込み時は「すでに作ってあるプレビュー」だけを返す（ffmpegを走らせない）。
    prepareMedia: (project, projectDir) =>
      existingPreview(project.assets, projectDir, mediaDeps),
  };

  const handlers = createIpcHandlers({
    runManager,
    review: reviewDeps,
    registry: registryDeps,
    creator: creatorDeps,
    assets: assetDeps,
    async showDirectoryDialog() {
      const result = await dialog.showOpenDialog(window, {
        title: 'プロジェクトの保存場所を選択',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return undefined;
      return result.filePaths[0];
    },
    async showAssetDialog() {
      const result = await dialog.showOpenDialog(window, {
        title: '収録素材を選択',
        properties: ['openFile', 'multiSelections'],
        filters: [
          {
            name: '映像・音声',
            extensions: [
              'mp4', 'mov', 'mxf', 'avi', 'mkv', 'm4v',
              'wav', 'aiff', 'aif', 'mp3', 'm4a', 'flac',
              'png', 'jpg', 'jpeg',
            ],
          },
          { name: 'すべてのファイル', extensions: ['*'] },
        ],
      });
      if (result.canceled) return [];
      return result.filePaths;
    },
    async openMedia(projectPath: string): Promise<OpenMediaResult> {
      try {
        const { project } = loadProject(projectPath);
        const media = await ensurePreview(
          project.assets as never,
          projectPath,
          mediaDeps,
        );
        if (media === undefined) {
          return {
            ok: false,
            error: safeError(
              DESKTOP_ERROR_CODES.ENVIRONMENT_NOT_READY,
              'プレビュー音声を用意できませんでした。',
              {
                recoverable: true,
                suggestedAction:
                  '素材ファイルが存在するか、ffmpeg が使えるかを確認してください。',
              },
            ),
          };
        }
        return { ok: true, media };
      } catch (error) {
        logger.error('プレビュー生成に失敗', { error });
        return {
          ok: false,
          error: safeError(
            DESKTOP_ERROR_CODES.UNKNOWN,
            'プレビュー音声を用意できませんでした。',
            { recoverable: true },
          ),
        };
      }
    },
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

  ipcMain.handle(IPC.reviewLoad, (_e, path: unknown) => handlers.reviewLoad(path));
  ipcMain.handle(IPC.reviewUpdateSubtitle, (_e, request: unknown) =>
    handlers.reviewUpdateSubtitle(request),
  );
  ipcMain.handle(IPC.reviewRemoveSubtitleEdit, (_e, request: unknown) =>
    handlers.reviewRemoveSubtitleEdit(request),
  );
  ipcMain.handle(IPC.reviewExport, (_e, request: unknown) =>
    handlers.reviewExport(request),
  );
  ipcMain.handle(IPC.reviewOpenMedia, (_e, path: unknown) =>
    handlers.reviewOpenMedia(path),
  );

  ipcMain.handle(IPC.shortsLoad, (_e, path: unknown) => handlers.shortsLoad(path));
  ipcMain.handle(IPC.shortsUpdateDecision, (_e, request: unknown) =>
    handlers.shortsUpdateDecision(request),
  );
  ipcMain.handle(IPC.shortsRemoveDecision, (_e, request: unknown) =>
    handlers.shortsRemoveDecision(request),
  );
  ipcMain.handle(IPC.shortsExport, (_e, request: unknown) =>
    handlers.shortsExport(request),
  );

  ipcMain.handle(IPC.cameraLoad, (_e, path: unknown) => handlers.cameraLoad(path));
  ipcMain.handle(IPC.cameraUpdateShot, (_e, request: unknown) =>
    handlers.cameraUpdateShot(request),
  );
  ipcMain.handle(IPC.cameraInsertShot, (_e, request: unknown) =>
    handlers.cameraInsertShot(request),
  );
  ipcMain.handle(IPC.cameraDeleteShot, (_e, request: unknown) =>
    handlers.cameraDeleteShot(request),
  );
  ipcMain.handle(IPC.cameraRemoveEdit, (_e, request: unknown) =>
    handlers.cameraRemoveEdit(request),
  );
  ipcMain.handle(IPC.cameraExport, (_e, request: unknown) =>
    handlers.cameraExport(request),
  );

  ipcMain.handle(IPC.markerLoad, (_e, path: unknown) => handlers.markerLoad(path));
  ipcMain.handle(IPC.markerUpdate, (_e, request: unknown) =>
    handlers.markerUpdate(request),
  );
  ipcMain.handle(IPC.markerDelete, (_e, request: unknown) =>
    handlers.markerDelete(request),
  );
  ipcMain.handle(IPC.markerRemoveEdit, (_e, request: unknown) =>
    handlers.markerRemoveEdit(request),
  );
  ipcMain.handle(IPC.markerExport, (_e, request: unknown) =>
    handlers.markerExport(request),
  );

  ipcMain.handle(IPC.listProjects, () => handlers.listProjects());
  ipcMain.handle(IPC.createProject, (_e, request: unknown) =>
    handlers.createProject(request),
  );
  ipcMain.handle(IPC.chooseParentDir, () => handlers.chooseParentDir());
  ipcMain.handle(IPC.forgetProject, (_e, path: unknown) =>
    handlers.forgetProject(path),
  );
  ipcMain.handle(IPC.loadSetup, (_e, path: unknown) => handlers.loadSetup(path));
  ipcMain.handle(IPC.chooseAssetFiles, (_e, path: unknown, updatedAt: unknown) =>
    handlers.chooseAssetFiles(path, updatedAt),
  );
  ipcMain.handle(
    IPC.registerDroppedAssets,
    (_e, path: unknown, updatedAt: unknown, paths: unknown) =>
      handlers.registerDroppedAssets(path, updatedAt, paths),
  );
  ipcMain.handle(IPC.updateAsset, (_e, request: unknown) =>
    handlers.updateAsset(request),
  );
  ipcMain.handle(IPC.removeAsset, (_e, request: unknown) =>
    handlers.removeAsset(request),
  );

  return runManager;
}

let runManager: RunManager | undefined;

// カスタムプロトコルは app.ready より前に特権を宣言する必要がある。
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_PROTOCOL,
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true },
  },
]);

void app.whenReady().then(() => {
  registerMediaProtocol();
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
