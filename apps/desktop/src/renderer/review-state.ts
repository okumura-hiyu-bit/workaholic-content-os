/**
 * 確認画面（Review）の状態遷移。
 *
 * ★Reactに依存しない純粋なリデューサ。
 * loading / ready / dirty / saving / saved / conflict /
 * export-running / export-complete / failed を明示的に持つ。
 *
 * ★保存の連打・二重保存・再出力中の再実行はここで止める。
 * ボタンのdisabledは見た目の防止でしかないので、状態側でも塞ぐ。
 */

import type { SafePipelineError } from '../shared/dto.ts';
import {
  canExportBase,
  isSavablePhase,
  type ReviewPhaseBase,
  type ReviewStateBase,
} from './review-shared.tsx';
import type {
  ReviewCounts,
  ReviewData,
  ReviewSubtitleCue,
  SubtitleEditPatch,
} from '../shared/review-dto.ts';

/** ★4画面共通（`review-shared.tsx` の `ReviewPhaseBase`）。名前だけ画面側に残す。 */
export type ReviewPhase = ReviewPhaseBase;

/**
 * ★共通フィールド（phase / updatedAt / dirty / exportRunId / playheadSec /
 * error / lastSavedAt）は `ReviewStateBase` から継承する。
 * ここに書くのは字幕Review固有のものだけ。
 */
export interface ReviewState extends ReviewStateBase {
  data?: ReviewData;
  /** 選択中の字幕（IDではなく位置で持つ。IDが重複しうるため）。 */
  selectedIndex?: number;
  /** 編集中の下書き。保存前の値。 */
  draft?: { index: number; text: string; speakerId?: string };
}

export type ReviewAction =
  | { type: 'load/started' }
  | { type: 'load/succeeded'; data: ReviewData }
  | { type: 'load/failed'; error: SafePipelineError }
  | { type: 'cue/selected'; index: number }
  | { type: 'draft/changed'; patch: SubtitleEditPatch }
  | { type: 'draft/discarded' }
  | { type: 'save/started' }
  | { type: 'save/succeeded'; updatedAt: string; cue: ReviewSubtitleCue; counts: ReviewCounts }
  | { type: 'save/conflicted'; error: SafePipelineError }
  | { type: 'save/failed'; error: SafePipelineError }
  | { type: 'export/started'; runId: string }
  | { type: 'export/finished'; runId: string; ok: boolean; error?: SafePipelineError }
  | { type: 'playhead/moved'; sec: number };

export const initialReviewState: ReviewState = {
  phase: 'loading',
  dirty: false,
  playheadSec: 0,
};

/** 保存できる状態か。★連打・二重保存を止める唯一の判定。 */
export function canSave(state: ReviewState): boolean {
  return state.dirty && state.draft !== undefined && isSavablePhase(state);
}

/**
 * 再出力を始められるか。★実行中の再実行を止める。
 * 判定は4画面共通（`review-shared.tsx` の `canExportBase`）。
 */
export function canExport(state: ReviewState): boolean {
  return canExportBase(state);
}

/** 編集できるキューか。IDが重複しているものは触らせない。 */
export function canEditCue(cue: ReviewSubtitleCue | undefined): boolean {
  return cue !== undefined && cue.editable;
}

/** 再生位置に対応する字幕の位置を返す。 */
export function cueIndexAtTime(
  cues: readonly ReviewSubtitleCue[],
  sec: number,
): number | undefined {
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i]!;
    if (sec >= cue.startSec && sec < cue.endSec) return i;
  }
  return undefined;
}

export function reducer(state: ReviewState, action: ReviewAction): ReviewState {
  switch (action.type) {
    case 'load/started':
      return { ...initialReviewState, phase: 'loading' };

    case 'load/succeeded': {
      const next: ReviewState = {
        ...initialReviewState,
        phase: 'ready',
        data: action.data,
        updatedAt: action.data.updatedAt,
      };
      if (action.data.subtitles.length > 0) next.selectedIndex = 0;
      return next;
    }

    case 'load/failed':
      return { ...initialReviewState, phase: 'failed', error: action.error };

    case 'cue/selected': {
      if (state.data === undefined) return state;
      // 未保存の変更を持ったまま別のキューへ移らせない（黙って捨てないため）。
      if (state.dirty && state.draft !== undefined && state.draft.index !== action.index) {
        return state;
      }
      return { ...state, selectedIndex: action.index };
    }

    case 'draft/changed': {
      if (state.data === undefined || state.selectedIndex === undefined) return state;
      if (state.phase === 'saving' || state.phase === 'conflict') return state;

      const cue = state.data.subtitles[state.selectedIndex];
      if (!canEditCue(cue)) return state;

      const base = state.draft?.index === state.selectedIndex
        ? state.draft
        : { index: state.selectedIndex, text: cue!.text, speakerId: cue!.speakerId };

      const draft = {
        index: state.selectedIndex,
        text: action.patch.text ?? base.text,
        ...(action.patch.speakerId !== undefined
          ? { speakerId: action.patch.speakerId }
          : base.speakerId !== undefined
            ? { speakerId: base.speakerId }
            : {}),
      };

      const changed = draft.text !== cue!.text || draft.speakerId !== cue!.speakerId;
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
      const subtitles = state.data.subtitles.map((cue, i) =>
        i === index ? action.cue : cue,
      );
      return {
        ...state,
        phase: 'saved',
        data: { ...state.data, subtitles, counts: action.counts },
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
      return { ...state, phase: 'export-running', exportRunId: action.runId, error: undefined };

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
      const next: ReviewState = { ...state, playheadSec: action.sec };
      // 再生位置に合わせて字幕を自動選択する。ただし編集中は動かさない。
      if (state.data !== undefined && !state.dirty) {
        const index = cueIndexAtTime(state.data.subtitles, action.sec);
        if (index !== undefined) next.selectedIndex = index;
      }
      return next;
    }

    default:
      return state;
  }
}
