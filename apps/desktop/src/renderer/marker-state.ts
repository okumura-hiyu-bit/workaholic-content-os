/**
 * マーカーReviewの状態遷移。
 *
 * ★Reactに依存しない純粋なリデューサ（review / shorts / camera と同じ方針）。
 *
 * ★カメラ切替から持ち込まないもの
 * `previewIssues` / `canInsert` / `insertDraft` は不要。
 * マーカー同士は干渉せず（重なりという概念が無い）、
 * `build-project.ts` の `toFcp7Markers` は throw も暗黙の切り捨てもしない。
 * そのため保存前の整合性チェックが要らず、構造はショート候補に近い。
 *
 * ★マーカー固有
 * 種別での絞り込みを持つ。実データでは CHECK が5件中3件を占め、
 * 「TOPIC だけ見たい」「要確認だけ見たい」需要が高いため。
 */

import type { SafePipelineError } from '../shared/dto.ts';
import type {
  MarkerCounts,
  MarkerData,
  MarkerItem,
  MarkerKindDto,
  MarkerOrphanedEdit,
} from '../shared/marker-dto.ts';

export type MarkerPhase =
  | 'loading'
  | 'ready'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'conflict'
  | 'export-running'
  | 'export-complete'
  | 'failed';

/** 状態での絞り込み。種別の絞り込みとは独立に効く。 */
export type MarkerFilter = 'all' | 'edited' | 'attention';

export interface MarkerDraft {
  index: number;
  name: string;
  comment: string;
}

export interface MarkerState {
  phase: MarkerPhase;
  data?: MarkerData;
  /** 競合更新の検出に使う。保存のたびに更新する。 */
  updatedAt?: string;
  /** 選択中のマーカー（IDではなく位置で持つ）。 */
  selectedIndex?: number;
  draft?: MarkerDraft;
  dirty: boolean;
  filter: MarkerFilter;
  /** 種別の絞り込み。undefined はすべて。 */
  kindFilter?: MarkerKindDto;
  exportRunId?: string;
  playheadSec: number;
  error?: SafePipelineError;
  lastSavedAt?: string;
}

export type MarkerAction =
  | { type: 'load/started' }
  | { type: 'load/succeeded'; data: MarkerData }
  | { type: 'load/failed'; error: SafePipelineError }
  | { type: 'marker/selected'; index: number }
  | { type: 'filter/changed'; filter: MarkerFilter }
  | { type: 'kindFilter/changed'; kind?: MarkerKindDto }
  | { type: 'draft/changed'; patch: Partial<Omit<MarkerDraft, 'index'>> }
  | { type: 'draft/discarded' }
  | { type: 'save/started' }
  | {
      type: 'save/succeeded';
      updatedAt: string;
      /** 削除した場合は undefined（一覧から消えるため）。 */
      marker?: MarkerItem;
      counts: MarkerCounts;
      orphaned: MarkerOrphanedEdit[];
      /** 一覧の再取得が必要か（削除・取り消しのとき true）。 */
      reload?: boolean;
    }
  | { type: 'save/conflicted'; error: SafePipelineError }
  | { type: 'save/failed'; error: SafePipelineError }
  | { type: 'export/started'; runId: string }
  | { type: 'export/finished'; runId: string; ok: boolean; error?: SafePipelineError }
  | { type: 'playhead/moved'; sec: number };

export const initialMarkerState: MarkerState = {
  phase: 'loading',
  dirty: false,
  filter: 'all',
  playheadSec: 0,
};

/** マーカーから下書きの初期値を作る。 */
export function draftOf(marker: MarkerItem, index: number): MarkerDraft {
  return { index, name: marker.name, comment: marker.comment };
}

/** 下書きが保存済みの内容から変わっているか。 */
export function isDraftChanged(draft: MarkerDraft, marker: MarkerItem): boolean {
  return draft.name !== marker.name || draft.comment !== marker.comment;
}

/**
 * 「要確認」に該当するか。
 *
 * ★種別またぎの繋ぎ直し・孤立しうるID・ID重複・繋ぎ直しを1つの絞り込みに束ねる。
 * どれも「人が見て判断すべき」もので、埋もれると気づけない。
 */
export function needsAttention(marker: MarkerItem): boolean {
  return (
    marker.reattachedKindMismatch !== undefined ||
    marker.reattached !== undefined ||
    marker.duplicateId ||
    (marker.volatileId && marker.edited)
  );
}

/** 編集できるマーカーか。IDが重複しているものは触らせない。 */
export function canEditMarker(marker: MarkerItem | undefined): boolean {
  return marker !== undefined && marker.editable;
}

/** 保存できる状態か。★連打・二重保存を止める唯一の判定。 */
export function canSave(state: MarkerState): boolean {
  if (!state.dirty || state.draft === undefined || state.data === undefined) return false;
  if (
    state.phase === 'saving' ||
    state.phase === 'conflict' ||
    state.phase === 'export-running' ||
    state.phase === 'loading'
  ) {
    return false;
  }
  // ★ID重複のマーカーは保存させない（修正が両方に適用されてしまうため）。
  return canEditMarker(state.data.markers[state.draft.index]);
}

/** 再出力を始められるか。★実行中の再実行を止める。 */
export function canExport(state: MarkerState): boolean {
  return (
    state.data !== undefined &&
    !state.dirty &&
    state.phase !== 'saving' &&
    state.phase !== 'export-running' &&
    state.phase !== 'conflict' &&
    state.phase !== 'loading'
  );
}

/** 絞り込みを適用したマーカーの位置一覧を返す（元の index を保つ）。 */
export function visibleIndexes(
  markers: readonly MarkerItem[],
  filter: MarkerFilter,
  kindFilter?: MarkerKindDto,
): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < markers.length; i += 1) {
    const m = markers[i]!;
    if (kindFilter !== undefined && m.kind !== kindFilter) continue;
    const match =
      filter === 'all' ||
      (filter === 'edited' && m.edited) ||
      (filter === 'attention' && needsAttention(m));
    if (match) indexes.push(i);
  }
  return indexes;
}

/**
 * 再生位置に対応するマーカーの位置を返す。
 *
 * ★マーカーは点（endSec を持たないものが多い）なので、
 * 「区間に入っているか」ではなく「直前の最も近いマーカー」を選ぶ。
 */
export function markerIndexAtTime(
  markers: readonly MarkerItem[],
  sec: number,
): number | undefined {
  let found: number | undefined;
  for (let i = 0; i < markers.length; i += 1) {
    if (markers[i]!.startSec <= sec) found = i;
    else break;
  }
  return found;
}

export function reducer(state: MarkerState, action: MarkerAction): MarkerState {
  switch (action.type) {
    case 'load/started':
      return {
        ...initialMarkerState,
        phase: 'loading',
        filter: state.filter,
        ...(state.kindFilter !== undefined ? { kindFilter: state.kindFilter } : {}),
      };

    case 'load/succeeded': {
      const next: MarkerState = {
        ...initialMarkerState,
        phase: 'ready',
        data: action.data,
        updatedAt: action.data.updatedAt,
        filter: state.filter,
        ...(state.kindFilter !== undefined ? { kindFilter: state.kindFilter } : {}),
      };
      if (action.data.markers.length > 0) next.selectedIndex = 0;
      return next;
    }

    case 'load/failed':
      return {
        ...initialMarkerState,
        phase: 'failed',
        filter: state.filter,
        error: action.error,
      };

    case 'marker/selected': {
      if (state.data === undefined) return state;
      // 未保存の変更を持ったまま別のマーカーへ移らせない（黙って捨てないため）。
      if (state.dirty && state.draft !== undefined && state.draft.index !== action.index) {
        return state;
      }
      return { ...state, selectedIndex: action.index };
    }

    case 'filter/changed':
      return { ...state, filter: action.filter };

    case 'kindFilter/changed': {
      const next: MarkerState = { ...state };
      if (action.kind === undefined) delete next.kindFilter;
      else next.kindFilter = action.kind;
      return next;
    }

    case 'draft/changed': {
      if (state.data === undefined || state.selectedIndex === undefined) return state;
      if (state.phase === 'saving' || state.phase === 'conflict') return state;

      const marker = state.data.markers[state.selectedIndex];
      // ★ID重複のマーカーは下書きも作らせない。
      if (!canEditMarker(marker)) return state;

      const base =
        state.draft?.index === state.selectedIndex
          ? state.draft
          : draftOf(marker!, state.selectedIndex);

      const draft: MarkerDraft = { ...base, ...action.patch, index: state.selectedIndex };
      const changed = isDraftChanged(draft, marker!);

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

      // ★削除・取り消しは一覧の件数が変わるので、呼び出し側が再読み込みする。
      //   ここでは件数と孤立だけ反映し、一覧は据え置く。
      if (action.marker === undefined || action.reload === true) {
        return {
          ...state,
          phase: 'saved',
          data: { ...state.data, counts: action.counts, orphaned: action.orphaned },
          updatedAt: action.updatedAt,
          lastSavedAt: action.updatedAt,
          draft: undefined,
          dirty: false,
          error: undefined,
        };
      }

      const index = state.draft?.index ?? state.selectedIndex;
      const markers = state.data.markers.map((m, i) =>
        i === index ? action.marker! : m,
      );
      return {
        ...state,
        phase: 'saved',
        data: {
          ...state.data,
          markers,
          counts: action.counts,
          orphaned: action.orphaned,
        },
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
      // 下書きは捨てない。もう一度保存できるようにする。
      return {
        ...state,
        phase: state.dirty ? 'dirty' : 'ready',
        error: action.error,
      };

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
      const next: MarkerState = { ...state, playheadSec: action.sec };
      // 再生位置に合わせてマーカーを自動選択する。ただし編集中は動かさない。
      if (state.data !== undefined && !state.dirty) {
        const index = markerIndexAtTime(state.data.markers, action.sec);
        if (index !== undefined) next.selectedIndex = index;
      }
      return next;
    }

    default:
      return state;
  }
}
