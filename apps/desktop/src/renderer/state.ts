/**
 * 画面の状態遷移。
 *
 * ★Reactに依存しない純粋なリデューサにしている。
 * 「未選択 → 選択済み → 解析中 → 完了/警告/失敗/中止」の遷移は
 * この画面の仕様そのものなので、描画と切り離してテストできるようにする。
 */

import type {
  PipelineFinishedEvent,
  PipelineProgressEvent,
  ProjectSummary,
  RunOutcome,
  SafePipelineError,
} from '../shared/dto.ts';
import { STEP_IDS, type StepId, type StepStatus } from '../shared/steps.ts';

export type Phase = 'idle' | 'selected' | 'running' | 'finished';

export interface StepView {
  stepId: StepId;
  status: StepStatus;
}

export interface AppState {
  phase: Phase;
  summary?: ProjectSummary;
  /** 解析中・完了後の工程一覧。 */
  steps: StepView[];
  runId?: string;
  /** 実行中の工程の進捗表示。 */
  progress?: {
    stepId: StepId;
    stepLabel: string;
    stepIndex: number;
    stepCount: number;
    overallRatio: number;
    stepRatio?: number;
    message?: string;
  };
  warnings: string[];
  /** 解析開始時刻（経過時間の算出に使う）。 */
  startedAt?: number;
  /** 完了後の結果。 */
  result?: PipelineFinishedEvent;
  outcome?: RunOutcome;
  /** 画面に出すエラー（安全なDTOのみ）。 */
  error?: SafePipelineError;
  /** 中止要求済み（ボタンの二度押し防止）。 */
  cancelling: boolean;
  /** 開始要求の送信中。 */
  starting: boolean;
}

export type Action =
  | { type: 'selection/cancelled' }
  | { type: 'selection/failed'; error: SafePipelineError }
  | { type: 'selection/succeeded'; summary: ProjectSummary }
  | { type: 'run/requested' }
  | { type: 'run/started'; runId: string; startedAt: number }
  | { type: 'run/startFailed'; error: SafePipelineError }
  | { type: 'run/progress'; event: PipelineProgressEvent }
  | { type: 'run/finished'; event: PipelineFinishedEvent }
  | { type: 'run/cancelRequested' }
  | { type: 'run/cancelFailed'; error: SafePipelineError }
  | { type: 'run/reset' };

function freshSteps(): StepView[] {
  return STEP_IDS.map((stepId) => ({ stepId, status: 'pending' as StepStatus }));
}

export const initialState: AppState = {
  phase: 'idle',
  steps: freshSteps(),
  warnings: [],
  cancelling: false,
  starting: false,
};

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'selection/cancelled':
      return state;

    case 'selection/failed':
      return { ...state, error: action.error };

    case 'selection/succeeded':
      // プロジェクトを選び直したら、前回の解析結果は持ち越さない。
      return {
        ...initialState,
        steps: freshSteps(),
        phase: 'selected',
        summary: action.summary,
      };

    case 'run/requested':
      if (state.phase !== 'selected' && state.phase !== 'finished') return state;
      return { ...state, starting: true, error: undefined };

    case 'run/started':
      return {
        ...state,
        phase: 'running',
        steps: freshSteps(),
        runId: action.runId,
        startedAt: action.startedAt,
        warnings: [],
        result: undefined,
        outcome: undefined,
        error: undefined,
        progress: undefined,
        cancelling: false,
        starting: false,
      };

    case 'run/startFailed':
      return { ...state, starting: false, error: action.error };

    case 'run/progress': {
      if (state.phase !== 'running') return state;
      // 別の実行のイベントは捨てる（中止直後の取りこぼし対策）。
      if (state.runId !== undefined && action.event.runId !== state.runId) return state;

      const { event } = action;
      const steps = state.steps.map((step) =>
        step.stepId === event.stepId ? { ...step, status: event.status } : step,
      );
      const warnings =
        event.warning !== undefined
          ? [...state.warnings, event.warning]
          : state.warnings;

      const progress: AppState['progress'] = {
        stepId: event.stepId,
        stepLabel: event.stepLabel,
        stepIndex: event.stepIndex,
        stepCount: event.stepCount,
        overallRatio: event.overallRatio,
      };
      if (event.stepRatio !== undefined) progress.stepRatio = event.stepRatio;
      if (event.message !== undefined) progress.message = event.message;

      return { ...state, steps, warnings, progress };
    }

    case 'run/finished': {
      if (state.runId !== undefined && action.event.runId !== state.runId) return state;
      const { event } = action;
      // 完了報告の工程状態で上書きする（進捗を取りこぼしていても整合させる）。
      const byId = new Map(event.steps.map((s) => [s.stepId, s.status]));
      const steps = state.steps.map((step) => {
        const status = byId.get(step.stepId);
        if (status !== undefined) return { ...step, status };
        // 実行されなかった工程は pending のままにせず skipped と分けない。
        return step;
      });

      return {
        ...state,
        phase: 'finished',
        steps,
        result: event,
        outcome: event.outcome,
        warnings: event.warnings.length > 0 ? event.warnings : state.warnings,
        error: event.error,
        progress: undefined,
        cancelling: false,
        starting: false,
      };
    }

    case 'run/cancelRequested':
      if (state.phase !== 'running') return state;
      return { ...state, cancelling: true };

    case 'run/cancelFailed':
      return { ...state, cancelling: false, error: action.error };

    case 'run/reset':
      if (state.summary === undefined) return initialState;
      return {
        ...initialState,
        steps: freshSteps(),
        phase: 'selected',
        summary: state.summary,
      };

    default:
      return state;
  }
}

/** 「解析開始」ボタンを押せるか。 */
export function canStart(state: AppState): boolean {
  return (
    (state.phase === 'selected' || state.phase === 'finished') &&
    !state.starting &&
    state.summary !== undefined
  );
}

/** 「解析を中止」ボタンを押せるか。 */
export function canCancel(state: AppState): boolean {
  return state.phase === 'running' && !state.cancelling;
}

export const OUTCOME_LABELS: Record<RunOutcome, string> = {
  completed: '完了',
  warning: '警告あり',
  failed: '失敗',
  cancelled: '中止しました',
};
