/**
 * IPCハンドラの中身。
 *
 * ★electron を import しない。
 * ダイアログ表示・フォルダを開く・projectRootの解決はすべて注入で受け取る。
 * こうすることで、Electronを起動せずに検証・排他・エラー変換をテストできる。
 * electron との接続は main/index.ts が担当する。
 *
 * ★Rendererから届く値は、必ずここで検証してから使う。
 */

import type {
  CancelPipelineResult,
  PipelineStartResult,
  ProjectSelectionResult,
  ReadProjectSummaryResult,
} from '../shared/dto.ts';
import { DESKTOP_ERROR_CODES, safeError } from '../shared/errors.ts';
import { validateId, validateStartRequest } from '../shared/validate.ts';
import type { WorkerRunOptions } from '../shared/worker-protocol.ts';
import type { ProjectReaderDeps } from './project.ts';
import { readProjectSummary } from './project.ts';
import type { RunManager } from './run-manager.ts';

export interface IpcDeps extends ProjectReaderDeps {
  runManager: RunManager;
  /** ファイル選択ダイアログ。キャンセル時は undefined を返す。 */
  showProjectDialog(): Promise<string | undefined>;
  /** Finder/エクスプローラでフォルダを開く。 */
  openFolder(path: string): Promise<void>;
  /** projectRoot の解決（未解決なら error）。 */
  resolveRoot():
    | { ok: true; projectRoot: string }
    | { ok: false; error: ReturnType<typeof safeError> };
  /** 実行環境の事前チェック。 */
  preflight(projectRoot: string): { ok: boolean; error?: ReturnType<typeof safeError> };
}

export interface IpcHandlers {
  selectProject(): Promise<ProjectSelectionResult>;
  readProjectSummary(rawPath: unknown): Promise<ReadProjectSummaryResult>;
  startPipeline(rawRequest: unknown): Promise<PipelineStartResult>;
  cancelPipeline(rawRunId: unknown): Promise<CancelPipelineResult>;
  openProjectFolder(rawPath: unknown): Promise<void>;
}

export function createIpcHandlers(deps: IpcDeps): IpcHandlers {
  return {
    async selectProject() {
      const selected = await deps.showProjectDialog();
      if (selected === undefined) {
        return { ok: false, reason: 'cancelled' };
      }
      const result = readProjectSummary(selected, deps);
      if (!result.ok) {
        return { ok: false, reason: 'invalid', error: result.error };
      }
      return { ok: true, summary: result.summary };
    },

    async readProjectSummary(rawPath) {
      return readProjectSummary(rawPath, deps);
    },

    async startPipeline(rawRequest) {
      // ① 形式の検証（工程ID・同期モード・パス）
      const validated = validateStartRequest(rawRequest);
      if (!validated.ok) return { ok: false, error: validated.error };
      const request = validated.value;

      // ② 実在する有効なプロジェクトかの検証（projectIdもここで得る）
      const summary = readProjectSummary(request.projectPath, deps);
      if (!summary.ok) return { ok: false, error: summary.error };

      // ③ 実行環境（リポジトリルート）の解決。★cwdは見ない。
      const root = deps.resolveRoot();
      if (!root.ok) return { ok: false, error: root.error };

      // ④ transcribe.py / .venv / dist の事前チェック
      const pre = deps.preflight(root.projectRoot);
      if (!pre.ok) {
        return {
          ok: false,
          error:
            pre.error ??
            safeError(
              DESKTOP_ERROR_CODES.ENVIRONMENT_NOT_READY,
              '解析に必要な環境が整っていません。',
            ),
        };
      }

      const options: WorkerRunOptions = {};
      if (request.fromStep !== undefined) options.fromStep = request.fromStep;
      if (request.toStep !== undefined) options.toStep = request.toStep;
      if (request.onlySteps !== undefined) options.onlySteps = request.onlySteps;
      if (request.syncMode !== undefined) options.syncMode = request.syncMode;
      if (request.force !== undefined) options.force = request.force;

      // ⑤ 排他は RunManager が持つ（UIのdisabledに依存しない）
      return deps.runManager.start({
        projectPath: summary.summary.projectPath,
        projectId: summary.summary.projectId,
        projectRoot: root.projectRoot,
        options,
      });
    },

    async cancelPipeline(rawRunId) {
      const validated = validateId(rawRunId, '実行ID');
      if (!validated.ok) return { ok: false, error: validated.error };
      return deps.runManager.cancel(validated.value);
    },

    async openProjectFolder(rawPath) {
      // ★任意パスを開かせない。有効なプロジェクトのフォルダだけを許可する。
      const summary = readProjectSummary(rawPath, deps);
      if (!summary.ok) return;
      await deps.openFolder(summary.summary.projectPath);
    },
  };
}
