/**
 * IPCチャンネル名の定義。
 *
 * ★Preload と Main の両方がここだけを参照する。文字列リテラルを
 * それぞれの場所に直接書くと、片方の変更で静かに壊れるため。
 */

export const IPC = {
  /** invoke（Renderer → Main、戻り値あり） */
  selectProject: 'contentos:project:select',
  readProjectSummary: 'contentos:project:summary',
  startPipeline: 'contentos:pipeline:start',
  cancelPipeline: 'contentos:pipeline:cancel',
  openProjectFolder: 'contentos:project:open-folder',

  /** 確認画面（Review）。今回は字幕のみ。 */
  reviewLoad: 'contentos:review:load',
  reviewUpdateSubtitle: 'contentos:review:update-subtitle',
  reviewRemoveSubtitleEdit: 'contentos:review:remove-subtitle-edit',
  reviewExport: 'contentos:review:export',
  reviewOpenMedia: 'contentos:review:open-media',

  /** プロジェクト一覧・新規作成・素材登録。 */
  listProjects: 'contentos:setup:list',
  createProject: 'contentos:setup:create',
  chooseParentDir: 'contentos:setup:choose-dir',
  forgetProject: 'contentos:setup:forget',
  loadSetup: 'contentos:setup:load',
  chooseAssetFiles: 'contentos:setup:choose-assets',
  registerDroppedAssets: 'contentos:setup:register-dropped',
  updateAsset: 'contentos:setup:update-asset',
  removeAsset: 'contentos:setup:remove-asset',

  /** send（Main → Renderer、一方向） */
  pipelineProgress: 'contentos:pipeline:progress',
  pipelineFinished: 'contentos:pipeline:finished',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];

/** Renderer → Main の invoke チャンネル（Preloadが許可する対象）。 */
export const INVOKE_CHANNELS = [
  IPC.selectProject,
  IPC.readProjectSummary,
  IPC.startPipeline,
  IPC.cancelPipeline,
  IPC.openProjectFolder,
  IPC.reviewLoad,
  IPC.reviewUpdateSubtitle,
  IPC.reviewRemoveSubtitleEdit,
  IPC.reviewExport,
  IPC.reviewOpenMedia,
  IPC.listProjects,
  IPC.createProject,
  IPC.chooseParentDir,
  IPC.forgetProject,
  IPC.loadSetup,
  IPC.chooseAssetFiles,
  IPC.registerDroppedAssets,
  IPC.updateAsset,
  IPC.removeAsset,
] as const;

/** Main → Renderer の一方向チャンネル。 */
export const EVENT_CHANNELS = [IPC.pipelineProgress, IPC.pipelineFinished] as const;
