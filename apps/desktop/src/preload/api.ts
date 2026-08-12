/**
 * Rendererへ公開するAPIの組み立て。
 *
 * ★ここに無いものはRendererから触れない。
 * 公開するのは下記の6メソッド + 2購読だけ。
 * ipcRenderer そのもの・fs・child_process・任意コマンド実行・任意パス読み書き・
 * APIキーは一切公開しない。invoke するチャンネル名もRendererから指定させず、
 * この層で固定する（チャンネル名を引数で受けると任意チャンネルを叩けてしまう）。
 *
 * ★electron を import しない。
 * ipcRenderer 相当を引数で受け取るので、Electronを起動せずに
 * 「許可されたAPIだけを公開しているか」「購読解除が効くか」をテストできる。
 */

import type {
  CancelPipelineResult,
  ContentOsDesktopApi,
  PipelineFinishedEvent,
  PipelineProgressEvent,
  PipelineStartResult,
  ProjectSelectionResult,
  ReadProjectSummaryResult,
  StartPipelineRequest,
} from '../shared/dto.ts';
import type {
  OpenMediaResult,
  RemoveSubtitleEditRequest,
  ReviewExportRequest,
  ReviewExportResult,
  ReviewLoadResult,
  SaveSubtitleEditResult,
  UpdateSubtitleEditRequest,
} from '../shared/review-dto.ts';
import type {
  DeleteMarkerRequest,
  MarkerExportRequest,
  MarkerExportResult,
  MarkerLoadResult,
  RemoveMarkerEditRequest,
  SaveMarkerEditResult,
  UpdateMarkerRequest,
} from '../shared/marker-dto.ts';
import type {
  CameraExportRequest,
  CameraExportResult,
  CameraLoadResult,
  DeleteCameraShotRequest,
  InsertCameraShotRequest,
  RemoveCameraEditRequest,
  SaveCameraEditResult,
  UpdateCameraShotRequest,
} from '../shared/camera-dto.ts';
import type {
  RemoveShortDecisionRequest,
  SaveShortDecisionResult,
  ShortsExportRequest,
  ShortsExportResult,
  ShortsLoadResult,
  UpdateShortDecisionRequest,
} from '../shared/shorts-dto.ts';
import type {
  CreateProjectRequest,
  CreateProjectResult,
  DroppedFile,
  ProjectListResult,
  RemoveAssetRequest,
  SetupLoadResult,
  SetupSaveResult,
  UpdateAssetRequest,
} from '../shared/setup-dto.ts';
import type {
  RecoveryDiscardRequest,
  RecoveryLoadResult,
  RecoveryReattachRequest,
  RecoverySaveResult,
  RecoveryTargetsRequest,
  RecoveryTargetsResult,
} from '../shared/recovery-dto.ts';
import { IPC } from '../shared/ipc.ts';

/** ipcRenderer のうち、この層が使う部分だけ。 */
export interface IpcBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /**
   * ドラッグ＆ドロップされたファイルの絶対パスを解決する。
   * ★Electron 32以降 File.path は使えないため webUtils.getPathForFile を使う。
   * この関数は Preload の中だけで呼び、結果（パス）は Renderer へ返さない。
   */
  resolveDroppedPath(file: DroppedFile): string | undefined;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
  removeListener(
    channel: string,
    listener: (event: unknown, ...args: unknown[]) => void,
  ): void;
}

/** 公開してよいキーの一覧。テストで完全一致を確認する。 */
export const ALLOWED_API_KEYS = [
  'selectProject',
  'readProjectSummary',
  'startPipeline',
  'cancelPipeline',
  'openProjectFolder',
  'onPipelineProgress',
  'onPipelineFinished',
  'reviewLoad',
  'reviewUpdateSubtitle',
  'reviewRemoveSubtitleEdit',
  'reviewExport',
  'reviewOpenMedia',
  'shortsLoad',
  'shortsUpdateDecision',
  'shortsRemoveDecision',
  'shortsExport',
  'cameraLoad',
  'cameraUpdateShot',
  'cameraInsertShot',
  'cameraDeleteShot',
  'cameraRemoveEdit',
  'cameraExport',
  'markerLoad',
  'markerUpdate',
  'markerDelete',
  'markerRemoveEdit',
  'markerExport',
  'recoveryLoad',
  'recoveryTargets',
  'recoveryReattach',
  'recoveryDiscard',
  'listProjects',
  'createProject',
  'chooseParentDir',
  'forgetProject',
  'loadSetup',
  'chooseAssetFiles',
  'registerDroppedAssets',
  'updateAsset',
  'removeAsset',
] as const;

function subscribe<T>(
  ipc: IpcBridge,
  channel: string,
  listener: (payload: T) => void,
): () => void {
  // ★IpcRendererEvent（senderを持つ）をRendererへ渡さない。payloadだけ渡す。
  const wrapped = (_event: unknown, ...args: unknown[]): void => {
    listener(args[0] as T);
  };
  ipc.on(channel, wrapped);
  return () => {
    ipc.removeListener(channel, wrapped);
  };
}

export function createDesktopApi(ipc: IpcBridge): ContentOsDesktopApi {
  return {
    async selectProject() {
      return (await ipc.invoke(IPC.selectProject)) as ProjectSelectionResult;
    },

    async readProjectSummary(projectPath: string) {
      return (await ipc.invoke(
        IPC.readProjectSummary,
        projectPath,
      )) as ReadProjectSummaryResult;
    },

    async startPipeline(request: StartPipelineRequest) {
      return (await ipc.invoke(IPC.startPipeline, request)) as PipelineStartResult;
    },

    async cancelPipeline(runId: string) {
      return (await ipc.invoke(IPC.cancelPipeline, runId)) as CancelPipelineResult;
    },

    async openProjectFolder(projectPath: string) {
      await ipc.invoke(IPC.openProjectFolder, projectPath);
    },

    onPipelineProgress(listener: (event: PipelineProgressEvent) => void) {
      return subscribe<PipelineProgressEvent>(ipc, IPC.pipelineProgress, listener);
    },

    onPipelineFinished(listener: (event: PipelineFinishedEvent) => void) {
      return subscribe<PipelineFinishedEvent>(ipc, IPC.pipelineFinished, listener);
    },

    async reviewLoad(projectPath: string) {
      return (await ipc.invoke(IPC.reviewLoad, projectPath)) as ReviewLoadResult;
    },

    async reviewUpdateSubtitle(request: UpdateSubtitleEditRequest) {
      return (await ipc.invoke(
        IPC.reviewUpdateSubtitle,
        request,
      )) as SaveSubtitleEditResult;
    },

    async reviewRemoveSubtitleEdit(request: RemoveSubtitleEditRequest) {
      return (await ipc.invoke(
        IPC.reviewRemoveSubtitleEdit,
        request,
      )) as SaveSubtitleEditResult;
    },

    async reviewExport(request: ReviewExportRequest) {
      return (await ipc.invoke(IPC.reviewExport, request)) as ReviewExportResult;
    },

    async reviewOpenMedia(projectPath: string) {
      return (await ipc.invoke(IPC.reviewOpenMedia, projectPath)) as OpenMediaResult;
    },

    // ─── ショート候補の確認・採否 ─────────────────────────

    async shortsLoad(projectPath: string) {
      return (await ipc.invoke(IPC.shortsLoad, projectPath)) as ShortsLoadResult;
    },

    async shortsUpdateDecision(request: UpdateShortDecisionRequest) {
      return (await ipc.invoke(
        IPC.shortsUpdateDecision,
        request,
      )) as SaveShortDecisionResult;
    },

    async shortsRemoveDecision(request: RemoveShortDecisionRequest) {
      return (await ipc.invoke(
        IPC.shortsRemoveDecision,
        request,
      )) as SaveShortDecisionResult;
    },

    async shortsExport(request: ShortsExportRequest) {
      return (await ipc.invoke(IPC.shortsExport, request)) as ShortsExportResult;
    },

    // ─── カメラ切替の確認・修正 ───────────────────────────

    async cameraLoad(projectPath: string) {
      return (await ipc.invoke(IPC.cameraLoad, projectPath)) as CameraLoadResult;
    },

    async cameraUpdateShot(request: UpdateCameraShotRequest) {
      return (await ipc.invoke(IPC.cameraUpdateShot, request)) as SaveCameraEditResult;
    },

    async cameraInsertShot(request: InsertCameraShotRequest) {
      return (await ipc.invoke(IPC.cameraInsertShot, request)) as SaveCameraEditResult;
    },

    async cameraDeleteShot(request: DeleteCameraShotRequest) {
      return (await ipc.invoke(IPC.cameraDeleteShot, request)) as SaveCameraEditResult;
    },

    async cameraRemoveEdit(request: RemoveCameraEditRequest) {
      return (await ipc.invoke(IPC.cameraRemoveEdit, request)) as SaveCameraEditResult;
    },

    async cameraExport(request: CameraExportRequest) {
      return (await ipc.invoke(IPC.cameraExport, request)) as CameraExportResult;
    },

    // ─── マーカーの確認・修正 ─────────────────────────────

    async markerLoad(projectPath: string) {
      return (await ipc.invoke(IPC.markerLoad, projectPath)) as MarkerLoadResult;
    },

    async markerUpdate(request: UpdateMarkerRequest) {
      return (await ipc.invoke(IPC.markerUpdate, request)) as SaveMarkerEditResult;
    },

    async markerDelete(request: DeleteMarkerRequest) {
      return (await ipc.invoke(IPC.markerDelete, request)) as SaveMarkerEditResult;
    },

    async markerRemoveEdit(request: RemoveMarkerEditRequest) {
      return (await ipc.invoke(IPC.markerRemoveEdit, request)) as SaveMarkerEditResult;
    },

    async markerExport(request: MarkerExportRequest) {
      return (await ipc.invoke(IPC.markerExport, request)) as MarkerExportResult;
    },

    // ─── 復旧（4画面横断の要確認） ───────────────────────

    async recoveryLoad(projectPath: string) {
      return (await ipc.invoke(IPC.recoveryLoad, projectPath)) as RecoveryLoadResult;
    },

    async recoveryTargets(request: RecoveryTargetsRequest) {
      return (await ipc.invoke(
        IPC.recoveryTargets,
        request,
      )) as RecoveryTargetsResult;
    },

    async recoveryReattach(request: RecoveryReattachRequest) {
      return (await ipc.invoke(IPC.recoveryReattach, request)) as RecoverySaveResult;
    },

    async recoveryDiscard(request: RecoveryDiscardRequest) {
      return (await ipc.invoke(IPC.recoveryDiscard, request)) as RecoverySaveResult;
    },

    // ─── プロジェクト一覧・新規作成・素材登録 ─────────────

    async listProjects() {
      return (await ipc.invoke(IPC.listProjects)) as ProjectListResult;
    },

    async createProject(request: CreateProjectRequest) {
      return (await ipc.invoke(IPC.createProject, request)) as CreateProjectResult;
    },

    async chooseParentDir() {
      return (await ipc.invoke(IPC.chooseParentDir)) as string | undefined;
    },

    async forgetProject(projectPath: string) {
      return (await ipc.invoke(IPC.forgetProject, projectPath)) as ProjectListResult;
    },

    async loadSetup(projectPath: string) {
      return (await ipc.invoke(IPC.loadSetup, projectPath)) as SetupLoadResult;
    },

    async chooseAssetFiles(projectPath: string, expectedUpdatedAt: string) {
      return (await ipc.invoke(
        IPC.chooseAssetFiles,
        projectPath,
        expectedUpdatedAt,
      )) as SetupSaveResult;
    },

    async registerDroppedAssets(
      projectPath: string,
      expectedUpdatedAt: string,
      files: readonly DroppedFile[],
    ) {
      // ★パスの解決はこの層で完結させ、Rendererへは絶対パスを渡さない。
      const paths: string[] = [];
      for (const file of files) {
        const path = ipc.resolveDroppedPath(file);
        if (typeof path === 'string' && path.length > 0) paths.push(path);
      }
      return (await ipc.invoke(
        IPC.registerDroppedAssets,
        projectPath,
        expectedUpdatedAt,
        paths,
      )) as SetupSaveResult;
    },

    async updateAsset(request: UpdateAssetRequest) {
      return (await ipc.invoke(IPC.updateAsset, request)) as SetupSaveResult;
    },

    async removeAsset(request: RemoveAssetRequest) {
      return (await ipc.invoke(IPC.removeAsset, request)) as SetupSaveResult;
    },
  };
}
