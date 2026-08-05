/**
 * カメラ切替Reviewの状態遷移。
 *
 * ★Reactに依存しない純粋なリデューサ（review-state / shorts-state と同じ方針）。
 *
 * ★カメラ固有の責務：保存する前に整合性を見せる
 * 字幕・ショートの下書きは「その要素の中身を変えるだけ」で他に影響しなかった。
 * カメラは時間軸を触るので、下書きの段階で隣のカットと重なりうる。
 * Main も保存時に必ず検査するが、そこで初めて弾かれると
 * 「保存を押したのに失敗した」体験になる。そこで下書きを反映した並びを
 * ここで組み立て、重なりがあれば**保存ボタンを押せなくする**。
 */

import type { SafePipelineError } from '../shared/dto.ts';
import type {
  CameraCounts,
  CameraData,
  CameraOrphanedEdit,
  CameraShotItem,
} from '../shared/camera-dto.ts';
import { MIN_CAMERA_SHOT_SEC, TIME_EPSILON } from '../shared/camera-validate.ts';

export type CameraPhase =
  | 'loading'
  | 'ready'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'conflict'
  | 'export-running'
  | 'export-complete'
  | 'failed';

/** 一覧の絞り込み。カットが増えると問題のある箇所が埋もれるため。 */
export type CameraFilter = 'all' | 'edited' | 'inserted' | 'problem';

/** 既存カットの編集中の下書き。 */
export interface CameraDraft {
  index: number;
  cameraId: string;
  startSec: number;
  endSec: number;
}

/** 追加中のカットの下書き。 */
export interface CameraInsertDraft {
  startSec: number;
  endSec: number;
  cameraId: string;
}

export interface CameraState {
  phase: CameraPhase;
  data?: CameraData;
  /** 競合更新の検出に使う。保存のたびに更新する。 */
  updatedAt?: string;
  /** 選択中のカット（IDではなく位置で持つ）。 */
  selectedIndex?: number;
  draft?: CameraDraft;
  /** 追加パネルを開いているときの下書き。 */
  insertDraft?: CameraInsertDraft;
  dirty: boolean;
  filter: CameraFilter;
  exportRunId?: string;
  playheadSec: number;
  error?: SafePipelineError;
  lastSavedAt?: string;
}

export type CameraAction =
  | { type: 'load/started' }
  | { type: 'load/succeeded'; data: CameraData }
  | { type: 'load/failed'; error: SafePipelineError }
  | { type: 'shot/selected'; index: number }
  | { type: 'filter/changed'; filter: CameraFilter }
  | { type: 'draft/changed'; patch: Partial<Omit<CameraDraft, 'index'>> }
  | { type: 'draft/discarded' }
  | { type: 'insert/started'; startSec: number; endSec: number; cameraId: string }
  | { type: 'insert/changed'; patch: Partial<CameraInsertDraft> }
  | { type: 'insert/cancelled' }
  | { type: 'save/started' }
  | {
      type: 'save/succeeded';
      updatedAt: string;
      shots: CameraShotItem[];
      counts: CameraCounts;
      orphaned: CameraOrphanedEdit[];
    }
  | { type: 'save/conflicted'; error: SafePipelineError }
  | { type: 'save/failed'; error: SafePipelineError }
  | { type: 'export/started'; runId: string }
  | { type: 'export/finished'; runId: string; ok: boolean; error?: SafePipelineError }
  | { type: 'playhead/moved'; sec: number };

export const initialCameraState: CameraState = {
  phase: 'loading',
  dirty: false,
  filter: 'all',
  playheadSec: 0,
};

/** カットから下書きの初期値を作る。 */
export function draftOf(shot: CameraShotItem, index: number): CameraDraft {
  return {
    index,
    cameraId: shot.cameraId,
    startSec: shot.startSec,
    endSec: shot.endSec,
  };
}

/** 下書きが保存済みの内容から変わっているか。 */
export function isDraftChanged(draft: CameraDraft, shot: CameraShotItem): boolean {
  return (
    draft.cameraId !== shot.cameraId ||
    Math.abs(draft.startSec - shot.startSec) > TIME_EPSILON ||
    Math.abs(draft.endSec - shot.endSec) > TIME_EPSILON
  );
}

/** 区間として成立しているか（Mainの検証と同じ条件）。 */
export function isRangeValid(startSec: number, endSec: number): boolean {
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return false;
  if (startSec < 0) return false;
  return endSec - startSec >= MIN_CAMERA_SHOT_SEC - TIME_EPSILON;
}

export interface TimelineIssue {
  kind: 'overlap' | 'range';
  message: string;
}

/**
 * 下書き（変更または追加）を反映した並びを作り、重なりを検出する。
 *
 * ★Main の `previewShots` + `assertTimelineSafe` と同じ判定を、保存前に
 * 画面で行うためのもの。Main 側の検査を置き換えるものではない
 * （Renderer は信用しない方針は変わらない）。
 */
export function previewIssues(
  shots: readonly CameraShotItem[],
  draft?: CameraDraft,
  insertDraft?: CameraInsertDraft,
): TimelineIssue[] {
  const intervals = shots.map((s, i) =>
    draft !== undefined && draft.index === i
      ? { startSec: draft.startSec, endSec: draft.endSec }
      : { startSec: s.startSec, endSec: s.endSec },
  );
  if (insertDraft !== undefined) {
    intervals.push({ startSec: insertDraft.startSec, endSec: insertDraft.endSec });
  }

  const issues: TimelineIssue[] = [];

  for (const iv of intervals) {
    if (!isRangeValid(iv.startSec, iv.endSec)) {
      issues.push({
        kind: 'range',
        message: `カットの長さが不正です（最短${MIN_CAMERA_SHOT_SEC}秒）。`,
      });
      break;
    }
  }

  const sorted = [...intervals].sort((a, b) => a.startSec - b.startSec);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.startSec < sorted[i - 1]!.endSec - TIME_EPSILON) {
      issues.push({
        kind: 'overlap',
        message: 'カットが重なっています。時刻を調整してください。',
      });
      break;
    }
  }

  return issues;
}

/** 保存できる状態か。★連打・二重保存・重なったままの保存を止める。 */
export function canSave(state: CameraState): boolean {
  if (!state.dirty || state.draft === undefined || state.data === undefined) return false;
  if (
    state.phase === 'saving' ||
    state.phase === 'conflict' ||
    state.phase === 'export-running' ||
    state.phase === 'loading'
  ) {
    return false;
  }
  // ★重なり・不正な長さが残っているうちは保存させない。
  return previewIssues(state.data.shots, state.draft).length === 0;
}

/** カットを追加できる状態か。 */
export function canInsert(state: CameraState): boolean {
  if (state.insertDraft === undefined || state.data === undefined) return false;
  if (
    state.phase === 'saving' ||
    state.phase === 'conflict' ||
    state.phase === 'export-running' ||
    state.phase === 'loading'
  ) {
    return false;
  }
  return previewIssues(state.data.shots, undefined, state.insertDraft).length === 0;
}

/** 再出力を始められるか。★実行中の再実行と、問題が残る状態での出力を止める。 */
export function canExport(state: CameraState): boolean {
  if (state.data === undefined || state.dirty) return false;
  if (
    state.phase === 'saving' ||
    state.phase === 'export-running' ||
    state.phase === 'conflict' ||
    state.phase === 'loading'
  ) {
    return false;
  }
  // ★保存済みの内容に重なりが残っている場合も出力させない。
  //   XMLを作り直す唯一の画面なので、壊れたまま書き出させない。
  return state.data.counts.overlaps === 0 && state.data.counts.outOfRange === 0;
}

/** 絞り込みを適用したカットの位置一覧を返す（元の index を保つ）。 */
export function visibleIndexes(
  shots: readonly CameraShotItem[],
  filter: CameraFilter,
): number[] {
  const indexes: number[] = [];
  for (let i = 0; i < shots.length; i += 1) {
    const s = shots[i]!;
    const match =
      filter === 'all' ||
      (filter === 'edited' && (s.edited || s.inserted)) ||
      (filter === 'inserted' && s.inserted) ||
      (filter === 'problem' &&
        (s.overlapsPrevious ||
          s.outOfRange ||
          s.tooShort ||
          s.gapBeforeSec !== undefined ||
          s.reattached !== undefined));
    if (match) indexes.push(i);
  }
  return indexes;
}

/** 再生位置に対応するカットの位置を返す。 */
export function shotIndexAtTime(
  shots: readonly CameraShotItem[],
  sec: number,
): number | undefined {
  for (let i = 0; i < shots.length; i += 1) {
    const s = shots[i]!;
    if (sec >= s.startSec && sec < s.endSec) return i;
  }
  return undefined;
}

export function reducer(state: CameraState, action: CameraAction): CameraState {
  switch (action.type) {
    case 'load/started':
      return { ...initialCameraState, phase: 'loading', filter: state.filter };

    case 'load/succeeded': {
      const next: CameraState = {
        ...initialCameraState,
        phase: 'ready',
        data: action.data,
        updatedAt: action.data.updatedAt,
        filter: state.filter,
      };
      if (action.data.shots.length > 0) next.selectedIndex = 0;
      return next;
    }

    case 'load/failed':
      return {
        ...initialCameraState,
        phase: 'failed',
        filter: state.filter,
        error: action.error,
      };

    case 'shot/selected': {
      if (state.data === undefined) return state;
      // 未保存の変更を持ったまま別のカットへ移らせない（黙って捨てないため）。
      if (state.dirty && state.draft !== undefined && state.draft.index !== action.index) {
        return state;
      }
      return { ...state, selectedIndex: action.index };
    }

    case 'filter/changed':
      return { ...state, filter: action.filter };

    case 'draft/changed': {
      if (state.data === undefined || state.selectedIndex === undefined) return state;
      if (state.phase === 'saving' || state.phase === 'conflict') return state;
      // 追加中は既存カットの編集を受け付けない（どちらを保存するのか曖昧になる）。
      if (state.insertDraft !== undefined) return state;

      const shot = state.data.shots[state.selectedIndex];
      if (shot === undefined) return state;

      const base =
        state.draft?.index === state.selectedIndex
          ? state.draft
          : draftOf(shot, state.selectedIndex);

      const draft: CameraDraft = { ...base, ...action.patch, index: state.selectedIndex };
      const changed = isDraftChanged(draft, shot);

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

    case 'insert/started': {
      if (state.data === undefined) return state;
      // 未保存の変更があるうちは追加を始めさせない。
      if (state.dirty) return state;
      return {
        ...state,
        insertDraft: {
          startSec: action.startSec,
          endSec: action.endSec,
          cameraId: action.cameraId,
        },
        error: undefined,
      };
    }

    case 'insert/changed': {
      if (state.insertDraft === undefined) return state;
      if (state.phase === 'saving' || state.phase === 'conflict') return state;
      return {
        ...state,
        insertDraft: { ...state.insertDraft, ...action.patch },
        error: undefined,
      };
    }

    case 'insert/cancelled':
      return { ...state, insertDraft: undefined, error: undefined };

    case 'save/started':
      // ★変更の保存・追加のどちらかが可能なときだけ進む（二重保存を止める）。
      if (!canSave(state) && !canInsert(state)) return state;
      return { ...state, phase: 'saving', error: undefined };

    case 'save/succeeded': {
      if (state.data === undefined) return state;
      // ★1要素ではなく並び全体を差し替える。
      //   追加・削除・時間変更は隣のカットの重なり・隙間まで変えるため。
      const next: CameraState = {
        ...state,
        phase: 'saved',
        data: {
          ...state.data,
          shots: action.shots,
          counts: action.counts,
          orphaned: action.orphaned,
        },
        updatedAt: action.updatedAt,
        lastSavedAt: action.updatedAt,
        draft: undefined,
        insertDraft: undefined,
        dirty: false,
        error: undefined,
      };
      // 並びが変わって選択が範囲外になった場合は先頭へ寄せる。
      if (
        next.selectedIndex !== undefined &&
        next.selectedIndex >= action.shots.length
      ) {
        next.selectedIndex = action.shots.length > 0 ? action.shots.length - 1 : undefined;
      }
      return next;
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
      const next: CameraState = { ...state, playheadSec: action.sec };
      // 再生位置に合わせてカットを自動選択する。ただし編集中は動かさない。
      if (state.data !== undefined && !state.dirty && state.insertDraft === undefined) {
        const index = shotIndexAtTime(state.data.shots, action.sec);
        if (index !== undefined) next.selectedIndex = index;
      }
      return next;
    }

    default:
      return state;
  }
}
