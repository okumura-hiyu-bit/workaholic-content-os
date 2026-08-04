/**
 * プロジェクト一覧・新規作成・素材登録の状態遷移。
 * ★Reactに依存しない純粋なリデューサ。
 */

import type { SafePipelineError } from '../shared/dto.ts';
import type {
  AssetRoleId,
  ProjectListEntry,
  SetupData,
  SpeakerSlot,
} from '../shared/setup-dto.ts';

export type SetupPhase =
  | 'list-loading'
  | 'list'
  | 'creating'
  | 'assets-loading'
  | 'assets'
  | 'saving'
  | 'conflict'
  | 'failed';

export interface SpeakerDraft {
  slot: SpeakerSlot;
  name: string;
  role: 'host' | 'guest';
}

export interface NewProjectDraft {
  name: string;
  recordedAt: string;
  programName: string;
  parentDir?: string;
  syncMode: 'preserve' | 'common';
  speakers: SpeakerDraft[];
}

export interface SetupState {
  phase: SetupPhase;
  entries: ProjectListEntry[];
  /** 新規作成フォームを開いているか。 */
  creating: boolean;
  draft: NewProjectDraft;
  /** 素材登録画面で開いているプロジェクト。 */
  data?: SetupData;
  error?: SafePipelineError;
  /** 直近の登録結果（何件追加・何件スキップ）。 */
  lastRegister?: { added: number; skipped: string[] };
}

export type SetupAction =
  | { type: 'list/loading' }
  | { type: 'list/loaded'; entries: ProjectListEntry[] }
  | { type: 'list/failed'; error: SafePipelineError }
  | { type: 'create/opened' }
  | { type: 'create/closed' }
  | { type: 'create/changed'; patch: Partial<NewProjectDraft> }
  | { type: 'create/speakerChanged'; slot: SpeakerSlot; patch: Partial<SpeakerDraft> }
  | { type: 'create/speakerAdded' }
  | { type: 'create/speakerRemoved'; slot: SpeakerSlot }
  | { type: 'create/submitting' }
  | { type: 'create/failed'; error: SafePipelineError }
  | { type: 'assets/loading' }
  | { type: 'assets/loaded'; data: SetupData }
  | { type: 'assets/failed'; error: SafePipelineError }
  | { type: 'assets/saving' }
  | { type: 'assets/saved'; data: SetupData; added?: number; skipped?: string[] }
  | { type: 'assets/conflicted'; error: SafePipelineError }
  | { type: 'assets/closed' };

const ALL_SLOTS: SpeakerSlot[] = ['A', 'B', 'C'];

export function emptyDraft(today: string): NewProjectDraft {
  return {
    name: '',
    recordedAt: today,
    programName: '',
    syncMode: 'preserve',
    speakers: [
      { slot: 'A', name: '', role: 'host' },
      { slot: 'B', name: '', role: 'guest' },
    ],
  };
}

export function initialSetupState(today: string): SetupState {
  return {
    phase: 'list-loading',
    entries: [],
    creating: false,
    draft: emptyDraft(today),
  };
}

/** 新規作成を送信できるか。★必須項目が埋まるまで押させない。 */
export function canCreate(state: SetupState): boolean {
  const d = state.draft;
  return (
    state.phase !== 'creating' &&
    d.name.trim().length > 0 &&
    /^\d{4}-\d{2}-\d{2}$/.test(d.recordedAt) &&
    d.parentDir !== undefined &&
    d.speakers.length > 0 &&
    d.speakers.every((s) => s.name.trim().length > 0)
  );
}

/** 素材を操作できるか。★保存中・競合中は触らせない。 */
export function canEditAssets(state: SetupState): boolean {
  return state.phase === 'assets' && state.data !== undefined;
}

/** 解析を開始できるか。★errorが1件でもあれば不可。 */
export function canStartAnalysis(state: SetupState): boolean {
  return state.phase === 'assets' && state.data?.canAnalyze === true;
}

export function errorIssues(data: SetupData | undefined) {
  return data?.issues.filter((i) => i.severity === 'error') ?? [];
}

export function warningIssues(data: SetupData | undefined) {
  return data?.issues.filter((i) => i.severity === 'warning') ?? [];
}

/** 役割の選択肢のうち、この出演者枠に対応するもの。 */
export function rolesForSlot(slot: SpeakerSlot): AssetRoleId[] {
  return [`cam_${slot}` as AssetRoleId, `mic_${slot}` as AssetRoleId];
}

export function reducer(state: SetupState, action: SetupAction): SetupState {
  switch (action.type) {
    case 'list/loading':
      return { ...state, phase: 'list-loading', error: undefined };

    case 'list/loaded':
      return { ...state, phase: 'list', entries: action.entries, error: undefined };

    case 'list/failed':
      return { ...state, phase: 'failed', error: action.error };

    case 'create/opened':
      return { ...state, creating: true, error: undefined };

    case 'create/closed':
      return { ...state, creating: false, phase: 'list', error: undefined };

    case 'create/changed':
      return { ...state, draft: { ...state.draft, ...action.patch }, error: undefined };

    case 'create/speakerChanged':
      return {
        ...state,
        draft: {
          ...state.draft,
          speakers: state.draft.speakers.map((s) =>
            s.slot === action.slot ? { ...s, ...action.patch } : s,
          ),
        },
      };

    case 'create/speakerAdded': {
      const used = new Set(state.draft.speakers.map((s) => s.slot));
      const next = ALL_SLOTS.find((s) => !used.has(s));
      if (next === undefined) return state;
      return {
        ...state,
        draft: {
          ...state.draft,
          speakers: [...state.draft.speakers, { slot: next, name: '', role: 'guest' }],
        },
      };
    }

    case 'create/speakerRemoved': {
      // 1名は必ず残す。
      if (state.draft.speakers.length <= 1) return state;
      return {
        ...state,
        draft: {
          ...state.draft,
          speakers: state.draft.speakers.filter((s) => s.slot !== action.slot),
        },
      };
    }

    case 'create/submitting':
      if (!canCreate(state)) return state; // ★二重送信を止める
      return { ...state, phase: 'creating', error: undefined };

    case 'create/failed':
      return { ...state, phase: 'list', error: action.error };

    case 'assets/loading':
      return { ...state, phase: 'assets-loading', error: undefined };

    case 'assets/loaded':
      return {
        ...state,
        phase: 'assets',
        data: action.data,
        creating: false,
        error: undefined,
      };

    case 'assets/failed':
      return { ...state, phase: 'failed', error: action.error };

    case 'assets/saving':
      if (state.phase !== 'assets') return state; // ★連打を止める
      return { ...state, phase: 'saving', error: undefined };

    case 'assets/saved': {
      const next: SetupState = {
        ...state,
        phase: 'assets',
        data: action.data,
        error: undefined,
      };
      if (action.added !== undefined) {
        next.lastRegister = { added: action.added, skipped: action.skipped ?? [] };
      }
      return next;
    }

    case 'assets/conflicted':
      // ★上書きしない。再読み込みを促す。
      return { ...state, phase: 'conflict', error: action.error };

    case 'assets/closed':
      return {
        ...state,
        phase: 'list-loading',
        data: undefined,
        lastRegister: undefined,
        error: undefined,
      };

    default:
      return state;
  }
}
