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
import type {
  OpenMediaResult,
  ReviewExportResult,
  ReviewLoadResult,
  SaveSubtitleEditResult,
} from '../shared/review-dto.ts';
import {
  validateRemoveSubtitleRequest,
  validateUpdateSubtitleRequest,
} from '../shared/review-validate.ts';
import { validateId, validateProjectPath, validateStartRequest } from '../shared/validate.ts';
import type { StepId } from '../shared/steps.ts';
import type { WorkerRunOptions } from '../shared/worker-protocol.ts';
import type { ProjectReaderDeps } from './project.ts';
import { readProjectSummary } from './project.ts';
import {
  applySubtitleEdit,
  buildReviewData,
  removeSubtitleEdit,
  type ReviewDeps,
} from './review.ts';
import type { RunManager } from './run-manager.ts';

/**
 * 字幕修正だけを反映するために再実行する工程。
 *
 * ★Rendererに選ばせない。Mainがここで固定する。
 *
 * 選定理由：
 * - `generate-premiere-xml` と `save-artifacts` は resolveProject を通すので、
 *   人間の修正を反映した成果物（SRT・話者名SRT・FCP7 XML）を作り直せる。
 * - `save-project` は上記の完了を記録するために含める。
 * - 解析・文字起こし・同期は含めない（字幕本文の修正では結果が変わらないため）。
 *
 * ★force を付ける理由
 * キャッシュのキーは素材と設定から作られ、`project.edits` は入っていない。
 * 付けないと「変更が無い」と判定されてスキップされ、修正が成果物に出ない。
 * force は既存のオプションで、キャッシュ方式そのものは変えない。
 */
export const REVIEW_EXPORT_STEPS: StepId[] = [
  'generate-premiere-xml',
  'save-artifacts',
  'save-project',
];

export interface IpcDeps extends ProjectReaderDeps {
  runManager: RunManager;
  /** 確認画面（Review）用。core の関数と、プレビュー生成を注入する。 */
  review: ReviewDeps;
  /** 再生用プレビューを用意する（無ければ生成）。 */
  openMedia(projectPath: string): Promise<OpenMediaResult>;
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

  reviewLoad(rawPath: unknown): Promise<ReviewLoadResult>;
  reviewUpdateSubtitle(rawRequest: unknown): Promise<SaveSubtitleEditResult>;
  reviewRemoveSubtitleEdit(rawRequest: unknown): Promise<SaveSubtitleEditResult>;
  reviewExport(rawRequest: unknown): Promise<ReviewExportResult>;
  reviewOpenMedia(rawPath: unknown): Promise<OpenMediaResult>;
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

    // ─── 確認画面（Review）──────────────────────────────

    async reviewLoad(rawPath) {
      const path = validateProjectPath(rawPath);
      if (!path.ok) return { ok: false, error: path.error };
      // 有効なプロジェクトであることを先に確かめる。
      const summary = readProjectSummary(path.value, deps);
      if (!summary.ok) return { ok: false, error: summary.error };
      return buildReviewData(summary.summary.projectPath, deps.review);
    },

    async reviewUpdateSubtitle(rawRequest) {
      // ① 形式の検証（パス・字幕ID・updatedAt・本文・話者・時刻）
      //    話者の実在確認のため、先に候補を集めてから検証する。
      const path = validateProjectPath(
        (rawRequest as { projectPath?: unknown } | null)?.projectPath,
      );
      if (!path.ok) return { ok: false, error: path.error };

      const loaded = buildReviewData(path.value, deps.review);
      if (!loaded.ok) return { ok: false, error: loaded.error };
      const knownSpeakers = new Set(loaded.data.speakers.map((s) => s.id));

      const validated = validateUpdateSubtitleRequest(rawRequest, knownSpeakers);
      if (!validated.ok) return { ok: false, error: validated.error };

      // ② 保存（analysis は触らない・updatedAt を照合する）
      return applySubtitleEdit(validated.value, deps.review);
    },

    async reviewRemoveSubtitleEdit(rawRequest) {
      const validated = validateRemoveSubtitleRequest(rawRequest);
      if (!validated.ok) return { ok: false, error: validated.error };
      return removeSubtitleEdit(validated.value, deps.review);
    },

    async reviewExport(rawRequest) {
      const path = validateProjectPath(
        (rawRequest as { projectPath?: unknown } | null)?.projectPath,
      );
      if (!path.ok) return { ok: false, error: path.error };

      const summary = readProjectSummary(path.value, deps);
      if (!summary.ok) return { ok: false, error: summary.error };

      const root = deps.resolveRoot();
      if (!root.ok) return { ok: false, error: root.error };

      const pre = deps.preflight(root.projectRoot);
      if (!pre.ok) {
        return {
          ok: false,
          error:
            pre.error ??
            safeError(
              DESKTOP_ERROR_CODES.ENVIRONMENT_NOT_READY,
              '再出力に必要な環境が整っていません。',
            ),
        };
      }

      // ★工程はMainが固定する。排他・進捗は解析と同じ仕組みに乗せる。
      const started = deps.runManager.start({
        projectPath: summary.summary.projectPath,
        projectId: summary.summary.projectId,
        projectRoot: root.projectRoot,
        options: {
          onlySteps: REVIEW_EXPORT_STEPS,
          force: true,
        },
      });
      if (!started.ok) return { ok: false, error: started.error };
      return { ok: true, runId: started.runId, steps: [...REVIEW_EXPORT_STEPS] };
    },

    async reviewOpenMedia(rawPath) {
      const path = validateProjectPath(rawPath);
      if (!path.ok) return { ok: false, error: path.error };
      const summary = readProjectSummary(path.value, deps);
      if (!summary.ok) return { ok: false, error: summary.error };
      return deps.openMedia(summary.summary.projectPath);
    },
  };
}
