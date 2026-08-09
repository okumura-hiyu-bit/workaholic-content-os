/**
 * 確認画面（Review）4画面で共通の状態・部品・Hook。
 *
 * ★なぜ切り出したか（2026-08-05 / Step 9）
 * 字幕・ショート候補・カメラ切替・マーカーの4画面が出そろい、重複が確定した。
 * `SaveBadge` は型名以外バイト一致、`canExport` は4画面中3画面で完全一致、
 * 再生エリア・`onPipelineFinished` の購読は4画面とも同じ形だった。
 *
 * ★これは移設であって仕様変更ではない。
 * 表示される文言・クラス名・状態遷移は移設前と1文字も変えていない。
 *
 * ★共通化しなかったもの（意図的）
 * - カメラ切替固有：`previewIssues` / `canInsert` / `insertDraft` /
 *   重なりを理由に再出力を止める判定。他の3画面には無い概念なので持ち込まない。
 * - 各画面の一覧・編集フォーム。項目も操作も画面ごとに違う。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';

import type { SafePipelineError } from '../shared/dto.ts';
import { formatTimecode } from './format.ts';

// ─── 状態 ──────────────────────────────────────────────

/** 4画面で共通の状態フェーズ。 */
export type ReviewPhaseBase =
  | 'loading'
  | 'ready'
  | 'dirty'
  | 'saving'
  | 'saved'
  | 'conflict'
  | 'export-running'
  | 'export-complete'
  | 'failed';

/**
 * 4画面で共通の状態フィールド。
 *
 * 各画面の State（`ReviewState` / `ShortsState` / `CameraState` /
 * `MarkerState`）はこれを `extends` し、固有のフィールド（下書き・絞り込み・
 * 選択位置など）だけを足す。★`data` はここに置かない：画面ごとに型が違い、
 * `unknown` で持つと各画面が毎回絞り込む羽目になるため。
 */
export interface ReviewStateBase {
  phase: ReviewPhaseBase;
  /** 競合更新の検出に使う。保存のたびに更新する。 */
  updatedAt?: string;
  /** 未保存の変更があるか。 */
  dirty: boolean;
  /** 再出力の実行ID。 */
  exportRunId?: string;
  /** 再生位置（秒）。 */
  playheadSec: number;
  error?: SafePipelineError;
  lastSavedAt?: string;
}

/**
 * 保存の操作を受け付けてよいフェーズか。
 *
 * ★連打・二重保存・競合中/再出力中の保存を止める。
 * 「下書きがあるか」「その要素が編集可能か」は画面ごとに違うので、
 * 4画面の `canSave`（およびカメラ切替の `canInsert`）がこれに自分の条件を足す。
 */
export function isSavablePhase(state: ReviewStateBase): boolean {
  return (
    state.phase !== 'saving' &&
    state.phase !== 'conflict' &&
    state.phase !== 'export-running' &&
    state.phase !== 'loading'
  );
}

/**
 * 再出力を始めてよい状態か。
 *
 * ★未保存の変更があるうちは始めさせない（保存前の内容で書き出さないため）。
 * ★カメラ切替はこれに加えて「重なり・尺超過が残っていないこと」を求める。
 * XMLを壊す可能性があるのはカメラだけなので、その条件は共通化しない。
 */
export function canExportBase(state: ReviewStateBase & { data?: unknown }): boolean {
  return (
    state.data !== undefined &&
    !state.dirty &&
    state.phase !== 'saving' &&
    state.phase !== 'export-running' &&
    state.phase !== 'conflict' &&
    state.phase !== 'loading'
  );
}

// ─── 表示部品 ──────────────────────────────────────────

/** 保存状態のバッジ。★4画面で同じ文言・同じ配色。 */
export function SaveBadge({ state }: { state: ReviewStateBase }): JSX.Element {
  const label =
    state.phase === 'saving' ? '保存中…'
    : state.phase === 'conflict' ? '競合しています'
    : state.dirty ? '未保存の変更あり'
    : state.phase === 'saved' ? '保存しました'
    : '変更なし';
  const tone =
    state.phase === 'conflict' ? 'danger'
    : state.dirty ? 'warn'
    : state.phase === 'saved' ? 'ok'
    : 'muted';
  return <span className={`badge badge--${tone}`}>{label}</span>;
}

// ─── 再生 ──────────────────────────────────────────────

const SKIP_SEC = 5;

export interface ReviewMediaController {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  mediaUrl: string | undefined;
  mediaNote: string | undefined;
  /** ★恒久的に安定（useState のセッターそのもの）。依存配列に入れて安全。 */
  setMediaUrl: (url: string) => void;
  seek: (sec: number) => void;
  togglePlay: () => void;
  prepareMedia: () => Promise<void>;
}

/**
 * 再生用プレビューの用意と再生操作。
 *
 * ★4画面とも `reviewOpenMedia`（字幕Reviewで作ったAPI）を使い回す。
 * 4K素材は再生せず、Mainが作った低ビットレート音声だけを鳴らす。
 * Rendererには絶対パスを渡さず `contentos-media://<token>` のみが来る。
 *
 * ★戻り値は `useMemo` で包み、各関数は `useCallback` で固定する。
 * 移設前は `seek` などが画面側の `useCallback([])` で永久に安定していた。
 * ここで毎回新しいオブジェクトを返すと、それを依存に持つ画面側の
 * `useCallback` が毎レンダー作り直され、安定性が移設前より落ちる。
 * `setMediaUrl` は useState のセッターをそのまま返す（恒久的に安定）。
 */
export function useReviewMedia(projectPath: string): ReviewMediaController {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | undefined>(undefined);
  const [mediaNote, setMediaNote] = useState<string | undefined>(undefined);

  const seek = useCallback((sec: number) => {
    const audio = audioRef.current;
    if (audio === null) return;
    audio.currentTime = Math.max(0, sec);
  }, []);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }, []);

  const prepareMedia = useCallback(async () => {
    setMediaNote('プレビュー音声を準備しています…');
    const result = await window.contentOs.reviewOpenMedia(projectPath);
    if (result.ok) {
      setMediaUrl(result.media.url);
      setMediaNote(undefined);
    } else {
      setMediaNote(result.error.userMessage);
    }
  }, [projectPath]);

  return useMemo(
    () => ({
      audioRef,
      mediaUrl,
      mediaNote,
      setMediaUrl,
      seek,
      togglePlay,
      prepareMedia,
    }),
    [mediaUrl, mediaNote, seek, togglePlay, prepareMedia],
  );
}

/**
 * 再生エリア。★4画面で同じ見た目・同じ操作。
 *
 * `durationSec` は画面ごとに参照元が違う（プレビューの尺／タイムラインの尺）ため
 * 引数で受ける。
 */
export function ReviewPlayer({
  media,
  durationSec,
  playheadSec,
  onPlayheadChange,
}: {
  media: ReviewMediaController;
  durationSec: number;
  playheadSec: number;
  onPlayheadChange: (sec: number) => void;
}): JSX.Element {
  if (media.mediaUrl === undefined) {
    return (
      <div className="card__actions">
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => void media.prepareMedia()}
        >
          プレビュー音声を用意する
        </button>
        {media.mediaNote !== undefined && (
          <span className="review__note">{media.mediaNote}</span>
        )}
      </div>
    );
  }

  return (
    <>
      {/* 4K素材は再生しない。cache/preview に作った低ビットレート音声のみ。 */}
      <audio
        ref={media.audioRef}
        src={media.mediaUrl}
        preload="metadata"
        onTimeUpdate={(e) => onPlayheadChange(e.currentTarget.currentTime)}
      />
      <div className="player">
        <button type="button" className="btn btn--secondary" onClick={media.togglePlay}>
          再生 / 停止
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => media.seek(playheadSec - SKIP_SEC)}
        >
          ← 5秒
        </button>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => media.seek(playheadSec + SKIP_SEC)}
        >
          5秒 →
        </button>
        <span className="player__tc">{formatTimecode(playheadSec)}</span>
        <input
          className="player__seek"
          type="range"
          min={0}
          max={Math.max(1, durationSec)}
          step={0.1}
          value={playheadSec}
          onChange={(e) => media.seek(Number(e.currentTarget.value))}
          aria-label="再生位置"
        />
      </div>
    </>
  );
}

// ─── パイプライン完了の監視 ────────────────────────────

/**
 * 再出力の完了を受け取る。
 *
 * ★4画面とも「既存の完了イベントに相乗りし、完了したら読み直す」形。
 * ★購読解除を必ず行う（useEffect のクリーンアップ）。
 *
 * ★依存は `reload` だけにする（移設前の各画面の `[load]` と同じ）。
 * `onFinished` は各画面が呼び出しごとに作る無名関数だが、中身は届いた
 * `event` を `dispatch` に渡すだけで、外側の値を一切読まない。だから
 * 古い関数を掴んだままでも結果は変わらない。逆に依存へ入れると毎レンダー
 * 購読が張り直され、その隙間に届いた完了イベントを取りこぼす。
 *
 * ★この判断を担保するリンタはこのリポジトリに無い（`npm run verify` は
 * typecheck / test / build のみで、ESLint の設定自体が存在しない）。
 * react-hooks/exhaustive-deps を将来入れるときは、ここが意図的な例外で
 * あることと、`onFinished` が上の性質を保っていることを確かめること。
 */
export function usePipelineFinished(
  onFinished: (event: {
    runId: string;
    ok: boolean;
    error?: SafePipelineError;
  }) => void,
  reload: () => void | Promise<void>,
): void {
  useEffect(() => {
    const off = window.contentOs.onPipelineFinished((event) => {
      onFinished({
        runId: event.runId,
        ok: event.outcome === 'completed' || event.outcome === 'warning',
        ...(event.error !== undefined ? { error: event.error } : {}),
      });
      void reload();
    });
    return () => off();
  }, [reload]);
}
