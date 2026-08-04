/**
 * ショート候補Reviewの状態遷移。
 *
 * ★Reactに依存しない純粋なリデューサ（review-state.ts と同じ方針）。
 * loading / ready / dirty / saving / saved / conflict /
 * export-running / export-complete / failed を明示的に持つ。
 *
 * ★保存の連打・二重保存・再出力中の再実行はここで止める。
 * ボタンのdisabledは見た目の防止でしかないので、状態側でも塞ぐ。
 */

import type { SafePipelineError } from '../shared/dto.ts';
import type {
  ShortAdoption,
  ShortCandidateItem,
  ShortsCounts,
  ShortsData,
} from '../shared/shorts-dto.ts';

export type ShortsPhase =
  | 'loading'
  | 'ready'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'conflict'
  | 'export-running'
  | 'export-complete'
  | 'failed';

/** 一覧の絞り込み。判断済みが増えると未判断が埋もれるため。 */
export type ShortsFilter = 'all' | 'adopted' | 'rejected' | 'undecided';

/** 編集中の下書き。保存前の値。 */
export interface ShortsDraft {
  index: number;
  adopted: ShortAdoption;
  title: string;
  hook: string;
  caption: string;
  hashtags: string[];
  note: string;
}

export interface ShortsState {
  phase: ShortsPhase;
  data?: ShortsData;
  /** 競合更新の検出に使う。保存のたびに更新する。 */
  updatedAt?: string;
  /** 選択中の候補（IDではなく位置で持つ。一覧の並びと対応させるため）。 */
  selectedIndex?: number;
  draft?: ShortsDraft;
  /** 未保存の変更があるか。 */
  dirty: boolean;
  filter: ShortsFilter;
  /** 再出力の実行ID。 */
  exportRunId?: string;
  /** 再生位置（秒）。 */
  playheadSec: number;
  error?: SafePipelineError;
  lastSavedAt?: string;
}

export type ShortsAction =
  | { type: 'load/started' }
  | { type: 'load/succeeded'; data: ShortsData }
  | { type: 'load/failed'; error: SafePipelineError }
  | { type: 'candidate/selected'; index: number }
  | { type: 'filter/changed'; filter: ShortsFilter }
  | { type: 'draft/changed'; patch: Partial<Omit<ShortsDraft, 'index'>> }
  | { type: 'draft/discarded' }
  | { type: 'save/started' }
  | {
      type: 'save/succeeded';
      updatedAt: string;
      candidate: ShortCandidateItem;
      counts: ShortsCounts;
    }
  | { type: 'save/conflicted'; error: SafePipelineError }
  | { type: 'save/failed'; error: SafePipelineError }
  | { type: 'export/started'; runId: string }
  | { type: 'export/finished'; runId: string; ok: boolean; error?: SafePipelineError }
  | { type: 'playhead/moved'; sec: number };

export const initialShortsState: ShortsState = {
  phase: 'loading',
  dirty: false,
  filter: 'all',
  playheadSec: 0,
};

/** 保存できる状態か。★連打・二重保存を止める唯一の判定。 */
export function canSave(state: ShortsState): boolean {
  return (
    state.dirty &&
    state.draft !== undefined &&
    state.phase !== 'saving' &&
    state.phase !== 'conflict' &&
    state.phase !== 'export-running' &&
    state.phase !== 'loading'
  );
}

/** 再出力を始められるか。★実行中の再実行を止める。 */
export function canExport(state: ShortsState): boolean {
  return (
    state.data !== undefined &&
    !state.dirty &&
    state.phase !== 'saving' &&
    state.phase !== 'export-running' &&
    state.phase !== 'conflict' &&
    state.phase !== 'loading'
  );
}

/** 候補から下書きの初期値を作る。未設定の項目は空文字で扱う。 */
export function draftOf(candidate: ShortCandidateItem, index: number): ShortsDraft {
  return {
    index,
    adopted: candidate.adopted,
    title: candidate.title ?? '',
    hook: candidate.hook ?? '',
    caption: candidate.caption ?? '',
    hashtags: [...(candidate.hashtags ?? [])],
    note: candidate.note ?? '',
  };
}

function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

/** 下書きが保存済みの内容から変わっているか。 */
export function isDraftChanged(
  draft: ShortsDraft,
  candidate: ShortCandidateItem,
): boolean {
  return (
    draft.adopted !== candidate.adopted ||
    draft.title !== (candidate.title ?? '') ||
    draft.hook !== (candidate.hook ?? '') ||
    draft.caption !== (candidate.caption ?? '') ||
    draft.note !== (candidate.note ?? '') ||
    !sameTags(draft.hashtags, candidate.hashtags ?? [])
  );
}

/** 絞り込みを適用した候補の位置一覧を返す（元の index を保つ）。 */
export function visibleIndexes(
  candidates: readonly ShortCandidateItem[],
  filter: ShortsFilter,
): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i]!;
    const match =
      filter === 'all' ||
      (filter === 'adopted' && c.adopted === true) ||
      (filter === 'rejected' && c.adopted === false) ||
      (filter === 'undecided' && c.adopted === undefined);
    if (match) indexes.push(i);
  }
  return indexes;
}

/** 再生位置に対応する候補の位置を返す。 */
export function candidateIndexAtTime(
  candidates: readonly ShortCandidateItem[],
  sec: number,
): number | undefined {
  for (let i = 0; i < candidates.length; i += 1) {
    const c = candidates[i]!;
    if (sec >= c.startSec && sec < c.endSec) return i;
  }
  return undefined;
}

export function reducer(state: ShortsState, action: ShortsAction): ShortsState {
  switch (action.type) {
    case 'load/started':
      return { ...initialShortsState, phase: 'loading', filter: state.filter };

    case 'load/succeeded': {
      const next: ShortsState = {
        ...initialShortsState,
        phase: 'ready',
        data: action.data,
        updatedAt: action.data.updatedAt,
        filter: state.filter,
      };
      if (action.data.candidates.length > 0) next.selectedIndex = 0;
      return next;
    }

    case 'load/failed':
      return {
        ...initialShortsState,
        phase: 'failed',
        filter: state.filter,
        error: action.error,
      };

    case 'candidate/selected': {
      if (state.data === undefined) return state;
      // 未保存の変更を持ったまま別の候補へ移らせない（黙って捨てないため）。
      if (state.dirty && state.draft !== undefined && state.draft.index !== action.index) {
        return state;
      }
      return { ...state, selectedIndex: action.index };
    }

    case 'filter/changed':
      // 絞り込みで選択が消えても、未保存の変更は捨てない。
      return { ...state, filter: action.filter };

    case 'draft/changed': {
      if (state.data === undefined || state.selectedIndex === undefined) return state;
      if (state.phase === 'saving' || state.phase === 'conflict') return state;

      const candidate = state.data.candidates[state.selectedIndex];
      if (candidate === undefined) return state;

      const base =
        state.draft?.index === state.selectedIndex
          ? state.draft
          : draftOf(candidate, state.selectedIndex);

      const draft: ShortsDraft = {
        ...base,
        ...action.patch,
        index: state.selectedIndex,
      };

      const changed = isDraftChanged(draft, candidate);
      return {
        ...state,
        draft,
        dirty: changed,
        phase: changed ? 'dirty' : 'ready',
        error: undefined,
      };
    }

    case 'draft/discarded':
      return {
        ...state,
        draft: undefined,
        dirty: false,
        phase: state.data === undefined ? 'loading' : 'ready',
        error: undefined,
      };

    case 'save/started':
      if (!canSave(state)) return state; // ★二重保存を止める
      return { ...state, phase: 'saving', error: undefined };

    case 'save/succeeded': {
      if (state.data === undefined) return state;
      const index = state.draft?.index ?? state.selectedIndex;
      const candidates = state.data.candidates.map((c, i) =>
        i === index ? action.candidate : c,
      );
      return {
        ...state,
        phase: 'saved',
        data: { ...state.data, candidates, counts: action.counts },
        updatedAt: action.updatedAt,
        lastSavedAt: action.updatedAt,
        draft: undefined,
        dirty: false,
        error: undefined,
      };
    }

    case 'save/conflicted':
      // ★上書きしない。下書きは残したまま、再読み込みを促す。
      return { ...state, phase: 'conflict', error: action.error };

    case 'save/failed':
      // 下書きは捨てない。もう一度保存できるように dirty のままにする。
      return { ...state, phase: 'dirty', error: action.error };

    case 'export/started':
      if (!canExport(state)) return state; // ★再出力中の再実行を止める
      return {
        ...state,
        phase: 'export-running',
        exportRunId: action.runId,
        error: undefined,
      };

    case 'export/finished': {
      if (state.exportRunId !== undefined && action.runId !== state.exportRunId) {
        return state;
      }
      if (!action.ok) {
        return { ...state, phase: 'failed', exportRunId: undefined, error: action.error };
      }
      return { ...state, phase: 'export-complete', exportRunId: undefined };
    }

    case 'playhead/moved': {
      const next: ShortsState = { ...state, playheadSec: action.sec };
      // 再生位置に合わせて候補を自動選択する。ただし編集中は動かさない。
      if (state.data !== undefined && !state.dirty) {
        const index = candidateIndexAtTime(state.data.candidates, action.sec);
        if (index !== undefined) next.selectedIndex = index;
      }
      return next;
    }

    default:
      return state;
  }
}
