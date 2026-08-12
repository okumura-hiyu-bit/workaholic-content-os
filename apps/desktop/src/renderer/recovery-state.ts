/**
 * 復旧画面（Recovery）の状態遷移。
 *
 * ★Reactに依存しない純粋なリデューサ。
 * ★共通フィールドは Step 9 の `ReviewStateBase` から継承する。
 *   保存の連打・二重保存・競合中の操作を止める判定も `isSavablePhase` を使う
 *   （4つのReview画面と同じ土台に乗せる）。
 *
 * ★この画面には「未保存の下書き」が無い。
 * 付け替えも破棄も1操作＝1保存で完結するため、`dirty` は常に false のまま使う。
 * それでも `ReviewStateBase` を継承するのは、`SaveBadge` と `isSavablePhase` を
 * そのまま使うため（＝保存中・競合中の見え方を4画面と揃えるため）。
 */

import type { SafePipelineError } from '../shared/dto.ts';
import type {
  RecoveryCounts,
  RecoveryData,
  RecoveryDomain,
  RecoveryItem,
  RecoveryKind,
  RecoveryTarget,
} from '../shared/recovery-dto.ts';
import {
  isSavablePhase,
  type ReviewPhaseBase,
  type ReviewStateBase,
} from './review-shared.tsx';

/** ★4画面共通（`review-shared.tsx` の `ReviewPhaseBase`）。名前だけ画面側に残す。 */
export type RecoveryPhase = ReviewPhaseBase;

/** 対象の絞り込み。undefined はすべて。 */
export type RecoveryDomainFilter = RecoveryDomain | 'all';
/** 種別の絞り込み。undefined はすべて。 */
export type RecoveryKindFilter = RecoveryKind | 'all';

/**
 * ★共通フィールドは `ReviewStateBase` から継承する。
 * ここに書くのは復旧画面固有のものだけ。
 */
export interface RecoveryState extends ReviewStateBase {
  data?: RecoveryData;
  /** 選択中の項目（IDではなく位置で持つ。4画面と同じ方針）。 */
  selectedIndex?: number;
  domainFilter: RecoveryDomainFilter;
  kindFilter: RecoveryKindFilter;
  /** 選択中の項目の付け替え先候補。読み込み中は undefined。 */
  targets?: RecoveryTarget[];
  /** 候補を読み込み中か。 */
  targetsLoading: boolean;
  /** 選んだ付け替え先。 */
  selectedTargetId?: string;
}

export type RecoveryAction =
  | { type: 'load/started' }
  | { type: 'load/succeeded'; data: RecoveryData }
  | { type: 'load/failed'; error: SafePipelineError }
  | { type: 'item/selected'; index: number }
  | { type: 'item/deselected' }
  | { type: 'domainFilter/changed'; filter: RecoveryDomainFilter }
  | { type: 'kindFilter/changed'; filter: RecoveryKindFilter }
  | { type: 'targets/started' }
  | { type: 'targets/succeeded'; targets: RecoveryTarget[] }
  | { type: 'targets/failed'; error: SafePipelineError }
  | { type: 'target/selected'; targetId: string }
  | { type: 'save/started' }
  | {
      type: 'save/succeeded';
      updatedAt: string;
      items: RecoveryItem[];
      counts: RecoveryCounts;
    }
  | { type: 'save/conflicted'; error: SafePipelineError }
  | { type: 'save/failed'; error: SafePipelineError }
  | { type: 'playhead/moved'; sec: number };

export const initialRecoveryState: RecoveryState = {
  phase: 'loading',
  dirty: false,
  playheadSec: 0,
  domainFilter: 'all',
  kindFilter: 'all',
  targetsLoading: false,
};

/**
 * 操作を受け付けてよい状態か。
 *
 * ★判定の土台は4画面共通（`review-shared.tsx` の `isSavablePhase`）。
 * この画面固有の条件は「項目が選ばれていること」だけ。
 */
export function canDiscard(state: RecoveryState): boolean {
  if (state.data === undefined || state.selectedIndex === undefined) return false;
  if (selectedItem(state) === undefined) return false;
  return isSavablePhase(state);
}

/**
 * 付け替えできるか。
 *
 * ★`reattachable` な項目（＝孤立）で、かつ埋まっていない候補を選んでいること。
 * 埋まった候補へ付け替えると先客が押し出されて新しい孤立を生むので、
 * Main でも拒否するが画面でも押させない。
 */
export function canReattach(state: RecoveryState): boolean {
  const item = selectedItem(state);
  if (item === undefined || !item.reattachable) return false;
  if (state.selectedTargetId === undefined) return false;
  const target = state.targets?.find((t) => t.id === state.selectedTargetId);
  if (target === undefined || target.occupied) return false;
  return isSavablePhase(state);
}

/** 選択中の項目。絞り込み後の一覧ではなく、元の一覧の位置で引く。 */
export function selectedItem(state: RecoveryState): RecoveryItem | undefined {
  if (state.data === undefined || state.selectedIndex === undefined) return undefined;
  return state.data.items[state.selectedIndex];
}

/**
 * 絞り込みを適用した項目の位置一覧を返す（元の index を保つ）。
 * ★4画面の `visibleIndexes` と同じ方針。位置で選択を持つため。
 */
export function visibleIndexes(
  items: readonly RecoveryItem[],
  domainFilter: RecoveryDomainFilter,
  kindFilter: RecoveryKindFilter,
): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item === undefined) continue;
    if (domainFilter !== 'all' && item.domain !== domainFilter) continue;
    if (kindFilter !== 'all' && item.kind !== kindFilter) continue;
    indexes.push(i);
  }
  return indexes;
}

export function reducer(state: RecoveryState, action: RecoveryAction): RecoveryState {
  switch (action.type) {
    case 'load/started':
      return { ...state, phase: 'loading', error: undefined };

    case 'load/succeeded': {
      const next: RecoveryState = {
        ...state,
        phase: 'ready',
        data: action.data,
        updatedAt: action.data.updatedAt,
        error: undefined,
        // ★読み直したら選択と候補は捨てる。一覧の並びが変わるため、
        //   位置で持っている選択をそのまま残すと別の項目を指してしまう。
        selectedIndex: undefined,
        selectedTargetId: undefined,
        targets: undefined,
        targetsLoading: false,
      };
      return next;
    }

    case 'load/failed':
      return { ...state, phase: 'failed', error: action.error };

    case 'item/selected':
      return {
        ...state,
        selectedIndex: action.index,
        // ★項目が変われば候補も選択も無効になる。
        targets: undefined,
        selectedTargetId: undefined,
        targetsLoading: false,
      };

    case 'item/deselected':
      return {
        ...state,
        selectedIndex: undefined,
        targets: undefined,
        selectedTargetId: undefined,
        targetsLoading: false,
      };

    case 'domainFilter/changed':
      // ★絞り込みを変えると一覧に出る項目が変わる。選択は解除する。
      return {
        ...state,
        domainFilter: action.filter,
        selectedIndex: undefined,
        targets: undefined,
        selectedTargetId: undefined,
      };

    case 'kindFilter/changed':
      return {
        ...state,
        kindFilter: action.filter,
        selectedIndex: undefined,
        targets: undefined,
        selectedTargetId: undefined,
      };

    case 'targets/started':
      return { ...state, targetsLoading: true, targets: undefined };

    case 'targets/succeeded':
      return { ...state, targetsLoading: false, targets: action.targets };

    case 'targets/failed':
      return {
        ...state,
        targetsLoading: false,
        targets: [],
        error: action.error,
      };

    case 'target/selected':
      return { ...state, selectedTargetId: action.targetId };

    case 'save/started':
      return { ...state, phase: 'saving', error: undefined };

    case 'save/succeeded': {
      if (state.data === undefined) return state;
      return {
        ...state,
        phase: 'saved',
        data: {
          ...state.data,
          updatedAt: action.updatedAt,
          items: action.items,
          counts: action.counts,
        },
        updatedAt: action.updatedAt,
        lastSavedAt: action.updatedAt,
        error: undefined,
        // ★直した項目は一覧から消える。位置で持つ選択は必ず解除する。
        selectedIndex: undefined,
        selectedTargetId: undefined,
        targets: undefined,
        targetsLoading: false,
      };
    }

    case 'save/conflicted':
      return { ...state, phase: 'conflict', error: action.error };

    case 'save/failed':
      return { ...state, phase: 'failed', error: action.error };

    case 'playhead/moved':
      return { ...state, playheadSec: action.sec };
  }
}
