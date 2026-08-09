/**
 * 確認画面（Review）— カメラ切替の確認・修正。
 *
 * ★色の意味は字幕・ショートReviewと揃える。
 * 青：保存済みの修正 / 緑：人が追加したカット / 赤：重なり・尺超過（要修正）
 * 黄：隙間・再接続（確認してほしい）
 *
 * ★この画面が必ず出すもの
 * 1. 再出力すると FCP7 XML が作り直される旨（CameraData.exportNotice）
 * 2. 重なり・尺超過が残っているうちは保存・再出力できないこと
 * どちらも実装で回避できない性質なので、操作の前に見える位置に置く。
 */

import { useCallback, useEffect, useReducer, type JSX } from 'react';

import type { ProjectSummary } from '../shared/dto.ts';
import type { CameraShotItem } from '../shared/camera-dto.ts';
import { formatTimecode } from './format.ts';
import {
  ReviewPlayer,
  SaveBadge,
  useReviewMedia,
  usePipelineFinished,
} from './review-shared.tsx';
import {
  canExport,
  canInsert,
  canSave,
  draftOf,
  initialCameraState,
  previewIssues,
  reducer,
  visibleIndexes,
  type CameraFilter,
} from './camera-state.ts';

/** 追加パネルを開いたときの既定の長さ。 */
const DEFAULT_INSERT_SEC = 5;

const FILTER_LABELS: { value: CameraFilter; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'edited', label: '修正済み' },
  { value: 'inserted', label: '追加' },
  { value: 'problem', label: '要確認' },
];

function seconds(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function CameraScreen({
  summary,
  onBack,
}: {
  summary: ProjectSummary;
  onBack: () => void;
}): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialCameraState);
  const media = useReviewMedia(summary.projectPath);
  // ★`setMediaUrl` は恒久的に安定なので、依存に入れても `load` の同一性は
  //   案件が変わったときしか変わらない（＝完了イベントの購読は張り直されない）。
  const { setMediaUrl } = media;

  const load = useCallback(async () => {
    dispatch({ type: 'load/started' });
    const result = await window.contentOs.cameraLoad(summary.projectPath);
    if (result.ok) {
      dispatch({ type: 'load/succeeded', data: result.data });
      if (result.data.media !== undefined) setMediaUrl(result.data.media.url);
    } else {
      dispatch({ type: 'load/failed', error: result.error });
    }
  }, [summary.projectPath, setMediaUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  // ★再出力の完了は既存の完了イベントで受け取る（購読解除は Hook が行う）。
  usePipelineFinished(
    (event) =>
      dispatch({
        type: 'export/finished',
        runId: event.runId,
        ok: event.ok,
        ...(event.error !== undefined ? { error: event.error } : {}),
      }),
    load,
  );

  const shots = state.data?.shots ?? [];
  const selected =
    state.selectedIndex !== undefined ? shots[state.selectedIndex] : undefined;
  const draft =
    state.draft?.index === state.selectedIndex
      ? state.draft
      : selected !== undefined && state.selectedIndex !== undefined
        ? draftOf(selected, state.selectedIndex)
        : undefined;

  const applySaveResult = useCallback(
    (result: Awaited<ReturnType<typeof window.contentOs.cameraUpdateShot>>) => {
      if (result.ok) {
        dispatch({
          type: 'save/succeeded',
          updatedAt: result.updatedAt,
          shots: result.shots,
          counts: result.counts,
          orphaned: result.orphaned,
        });
      } else if (result.conflict === true) {
        dispatch({ type: 'save/conflicted', error: result.error });
      } else {
        dispatch({ type: 'save/failed', error: result.error });
      }
    },
    [],
  );

  const save = useCallback(async () => {
    if (!canSave(state) || state.draft === undefined || state.updatedAt === undefined) {
      return;
    }
    const shot = shots[state.draft.index];
    if (shot === undefined) return;
    const d = state.draft;

    dispatch({ type: 'save/started' });
    applySaveResult(
      await window.contentOs.cameraUpdateShot({
        projectPath: summary.projectPath,
        shotId: shot.id,
        expectedUpdatedAt: state.updatedAt,
        patch: { cameraId: d.cameraId, startSec: d.startSec, endSec: d.endSec },
      }),
    );
  }, [state, shots, summary.projectPath, applySaveResult]);

  const insert = useCallback(async () => {
    if (!canInsert(state) || state.insertDraft === undefined || state.updatedAt === undefined) {
      return;
    }
    dispatch({ type: 'save/started' });
    applySaveResult(
      await window.contentOs.cameraInsertShot({
        projectPath: summary.projectPath,
        expectedUpdatedAt: state.updatedAt,
        startSec: state.insertDraft.startSec,
        endSec: state.insertDraft.endSec,
        cameraId: state.insertDraft.cameraId,
      }),
    );
  }, [state, summary.projectPath, applySaveResult]);

  const remove = useCallback(async () => {
    if (selected === undefined || state.updatedAt === undefined) return;
    dispatch({ type: 'save/started' });
    applySaveResult(
      await window.contentOs.cameraDeleteShot({
        projectPath: summary.projectPath,
        shotId: selected.id,
        expectedUpdatedAt: state.updatedAt,
      }),
    );
  }, [selected, state.updatedAt, summary.projectPath, applySaveResult]);

  const revert = useCallback(async () => {
    if (selected === undefined || state.updatedAt === undefined) return;
    dispatch({ type: 'save/started' });
    applySaveResult(
      await window.contentOs.cameraRemoveEdit({
        projectPath: summary.projectPath,
        shotId: selected.id,
        expectedUpdatedAt: state.updatedAt,
      }),
    );
  }, [selected, state.updatedAt, summary.projectPath, applySaveResult]);

  const runExport = useCallback(async () => {
    if (!canExport(state)) return;
    const result = await window.contentOs.cameraExport({
      projectPath: summary.projectPath,
    });
    if (result.ok) {
      dispatch({ type: 'export/started', runId: result.runId });
    } else {
      dispatch({ type: 'save/failed', error: result.error });
    }
  }, [state, summary.projectPath]);

  if (state.phase === 'loading') {
    return (
      <section className="card">
        <p>カメラ切替を読み込んでいます…</p>
      </section>
    );
  }

  if (state.data === undefined) {
    return (
      <section className="card card--failed">
        <h2 className="card__title">カメラ切替を開けませんでした</h2>
        <p>{state.error?.userMessage}</p>
        {state.error?.suggestedAction !== undefined && (
          <p className="banner__action">{state.error.suggestedAction}</p>
        )}
        <div className="card__actions">
          <button type="button" className="btn btn--secondary" onClick={onBack}>
            戻る
          </button>
        </div>
      </section>
    );
  }

  const data = state.data;
  const shown = visibleIndexes(shots, state.filter);
  const editingDisabled = state.phase === 'saving' || state.phase === 'conflict';
  const draftIssues = previewIssues(shots, state.draft, state.insertDraft);
  const lastShot = shots[shots.length - 1];

  return (
    <div className="review camera">
      {/* ── ヘッダー ── */}
      <section className="card review__header">
        <div className="card__head">
          <div>
            <h2 className="card__title">{data.summary.name}</h2>
            <p className="review__meta">
              収録日 {data.summary.recordedAt ?? '—'} ／ ステータス {data.summary.status}
            </p>
          </div>
          <button type="button" className="btn btn--ghost" onClick={onBack}>
            解析画面へ戻る
          </button>
        </div>

        <div className="stats">
          <div className="stat">
            <span className="stat__label">カット</span>
            <span className="stat__value">{data.counts.shots}</span>
          </div>
          <div className="stat">
            <span className="stat__label">修正済み</span>
            <span className="stat__value stat__value--edited">{data.counts.edited}</span>
          </div>
          <div className="stat">
            <span className="stat__label">追加</span>
            <span className="stat__value stat__value--adopted">{data.counts.inserted}</span>
          </div>
          <div className="stat">
            <span className="stat__label">削除</span>
            <span className="stat__value">{data.counts.deleted}</span>
          </div>
          <div className="stat">
            <span className="stat__label">重なり</span>
            <span
              className={`stat__value ${data.counts.overlaps > 0 ? 'stat__value--danger' : ''}`}
            >
              {data.counts.overlaps}
            </span>
          </div>
          <div className="stat">
            <span className="stat__label">保存状態</span>
            <SaveBadge state={state} />
          </div>
        </div>

        {/* ★実装で回避できない性質。常時表示する。 */}
        <div className="banner banner--warn" role="status">
          <p className="banner__message">⚠️ {data.exportNotice}</p>
          {data.syncModeNotice !== undefined && (
            <p className="banner__action">{data.syncModeNotice}</p>
          )}
        </div>

        {(data.counts.overlaps > 0 || data.counts.outOfRange > 0) && (
          <div className="banner banner--error" role="alert">
            <p className="banner__message">
              保存済みの内容に問題が残っています（重なり {data.counts.overlaps} 件 / 素材の尺を超過{' '}
              {data.counts.outOfRange} 件）。
            </p>
            <p className="banner__action">
              解消するまで再出力できません。Premiereのタイムラインが崩れるためです。
            </p>
          </div>
        )}

        {state.phase === 'conflict' && (
          <div className="banner banner--error" role="alert">
            <p className="banner__message">{state.error?.userMessage}</p>
            <div className="card__actions">
              <button type="button" className="btn btn--primary" onClick={() => void load()}>
                再読み込み
              </button>
            </div>
          </div>
        )}

        {state.phase !== 'conflict' && state.error !== undefined && (
          <div className="banner banner--error" role="alert">
            <p className="banner__message">{state.error.userMessage}</p>
            {state.error.suggestedAction !== undefined && (
              <p className="banner__action">{state.error.suggestedAction}</p>
            )}
          </div>
        )}
      </section>

      {/* ── 再生エリア ── */}
      <section className="card">
        <h3 className="card__subtitle">再生（音声）</h3>
        <ReviewPlayer
          media={media}
          durationSec={data.media?.durationSec ?? data.timelineDurationSec}
          playheadSec={state.playheadSec}
          onPlayheadChange={(sec) => dispatch({ type: 'playhead/moved', sec })}
        />
      </section>

      {/* ── 孤立・再接続 ── */}
      {(data.orphaned.length > 0 || data.counts.reattached > 0) && (
        <section className="card card--attention">
          <h3 className="card__subtitle">
            要確認：孤立した修正 {data.orphaned.length} 件
            {data.counts.reattached > 0 && ` / 繋ぎ直された修正 ${data.counts.reattached} 件`}
          </h3>
          {data.orphaned.map((o) => (
            <div key={o.originalId} className="attention">
              <span className="attention__tag attention__tag--orphan">孤立</span>
              <span className="attention__body">
                {o.originalId}（約{formatTimecode(o.approxSec ?? 0)}）の修正が繋がりませんでした。
                {o.deleted === true && <> 内容：このカットの削除</>}
                {o.cameraId !== undefined && <> 内容：カメラを {o.cameraId} に変更</>}
                <span className="attention__reason">{o.reason}</span>
              </span>
            </div>
          ))}
          {shots
            .filter((s) => s.reattached !== undefined)
            .map((s) => (
              <div key={`re-${s.id}`} className="attention">
                <span className="attention__tag attention__tag--conflict">繋ぎ直し</span>
                <span className="attention__body">
                  {formatTimecode(s.startSec)} のカットは、再解析で位置が
                  {s.reattached!.deltaSec.toFixed(2)}秒 動いたため
                  {s.reattached!.fromId} の修正を引き継ぎました。
                  <span className="attention__reason">
                    意図した場所に付いているか、再生して確認してください。
                  </span>
                </span>
              </div>
            ))}
        </section>
      )}

      {/* ── カット一覧 ── */}
      <section className="card">
        <div className="card__head">
          <h3 className="card__subtitle">カメラ切替（{shots.length} カット）</h3>
          <div className="filters">
            {FILTER_LABELS.map((f) => (
              <button
                key={f.value}
                type="button"
                className={[
                  'btn',
                  'btn--chip',
                  state.filter === f.value ? 'btn--chip-active' : '',
                ].join(' ')}
                onClick={() => dispatch({ type: 'filter/changed', filter: f.value })}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {shown.length === 0 ? (
          <p className="review__note">この絞り込みに該当するカットはありません。</p>
        ) : (
          <ol className="cues camera__list">
            {shown.map((index) => {
              const s = shots[index]!;
              return (
                <li
                  key={s.id}
                  className={[
                    'cues__item',
                    index === state.selectedIndex ? 'cues__item--selected' : '',
                    s.edited && !s.inserted ? 'cues__item--edited' : '',
                    s.inserted ? 'cues__item--adopted' : '',
                    s.overlapsPrevious || s.outOfRange ? 'cues__item--conflicted' : '',
                  ].join(' ')}
                >
                  <button
                    type="button"
                    className="cues__button"
                    onClick={() => {
                      dispatch({ type: 'shot/selected', index });
                      media.seek(s.startSec);
                    }}
                  >
                    <span className="cues__tc">
                      {formatTimecode(s.startSec)} → {formatTimecode(s.endSec)}
                    </span>
                    <span className="camera__dur">{s.durationSec.toFixed(1)}秒</span>
                    <span className="cues__text">
                      <strong>{s.cameraLabel}</strong>
                      <span className="camera__reason">（{s.reasonLabel}）</span>
                    </span>
                    <span className="cues__flags">
                      {s.inserted && <span className="tag tag--adopted">追加</span>}
                      {s.edited && !s.inserted && <span className="tag tag--edited">修正済み</span>}
                      {s.reattached !== undefined && (
                        <span className="tag tag--warn">繋ぎ直し</span>
                      )}
                      {s.gapBeforeSec !== undefined && (
                        <span className="tag tag--warn">
                          隙間 {s.gapBeforeSec.toFixed(1)}秒
                        </span>
                      )}
                      {s.overlapsPrevious && <span className="tag tag--conflict">重なり</span>}
                      {s.tooShort && <span className="tag tag--warn">短い</span>}
                      {s.outOfRange && <span className="tag tag--conflict">尺超過</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* ── 編集 ── */}
      {selected !== undefined && draft !== undefined && state.insertDraft === undefined && (
        <section className="card">
          <h3 className="card__subtitle">
            選択中：{formatTimecode(selected.startSec)} → {formatTimecode(selected.endSec)}
            {selected.inserted && '（人が追加したカット）'}
          </h3>

          <label className="field">
            <span className="field__label">カメラ</span>
            <select
              className="field__input"
              value={draft.cameraId}
              disabled={editingDisabled}
              onChange={(e) =>
                dispatch({ type: 'draft/changed', patch: { cameraId: e.currentTarget.value } })
              }
            >
              {data.cameras.map((c) => (
                <option key={c.cameraId} value={c.cameraId}>
                  {c.label}（{c.fileName}）
                </option>
              ))}
            </select>
          </label>

          <div className="camera__times">
            <label className="field">
              <span className="field__label">開始（秒）</span>
              <input
                className="field__input"
                type="number"
                step={0.1}
                min={0}
                value={draft.startSec}
                disabled={editingDisabled}
                onChange={(e) =>
                  dispatch({
                    type: 'draft/changed',
                    patch: { startSec: seconds(e.currentTarget.value) },
                  })
                }
              />
            </label>
            <label className="field">
              <span className="field__label">終了（秒）</span>
              <input
                className="field__input"
                type="number"
                step={0.1}
                min={0}
                value={draft.endSec}
                disabled={editingDisabled}
                onChange={(e) =>
                  dispatch({
                    type: 'draft/changed',
                    patch: { endSec: seconds(e.currentTarget.value) },
                  })
                }
              />
            </label>
          </div>

          {draftIssues.length > 0 && (
            <div className="banner banner--error" role="alert">
              {draftIssues.map((issue) => (
                <p key={issue.kind} className="banner__message">
                  {issue.message}
                </p>
              ))}
            </div>
          )}

          <p className="review__note">
            最短カット長は {data.minShotSec} 秒です。カットが重なっていると保存できません
            （Premiereのタイムラインが崩れるためです）。
          </p>

          <div className="card__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void save()}
              disabled={!canSave(state)}
            >
              {state.phase === 'saving' ? '保存中…' : '修正を保存'}
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => dispatch({ type: 'draft/discarded' })}
              disabled={!state.dirty || state.phase === 'saving'}
            >
              下書きを破棄
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => void remove()}
              disabled={state.phase === 'saving' || state.dirty || shots.length <= 1}
            >
              このカットを削除
            </button>
            {(selected.edited || selected.inserted) && (
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => void revert()}
                disabled={state.phase === 'saving' || state.dirty}
              >
                解析結果に戻す
              </button>
            )}
          </div>

          {selected.edited && selected.analysisCameraId !== undefined && (
            <p className="review__note">
              解析（AI）の元の値：{selected.analysisCameraId} ／{' '}
              {formatTimecode(selected.analysisStartSec ?? 0)} →{' '}
              {formatTimecode(selected.analysisEndSec ?? 0)}
            </p>
          )}
        </section>
      )}

      {/* ── カットの追加 ── */}
      <section className="card">
        <h3 className="card__subtitle">カットを追加</h3>
        {state.insertDraft === undefined ? (
          <div className="card__actions">
            <button
              type="button"
              className="btn btn--secondary"
              disabled={state.dirty || editingDisabled || data.cameras.length === 0}
              onClick={() =>
                dispatch({
                  type: 'insert/started',
                  startSec: lastShot?.endSec ?? 0,
                  endSec: (lastShot?.endSec ?? 0) + DEFAULT_INSERT_SEC,
                  cameraId: data.cameras[0]!.cameraId,
                })
              }
            >
              カットを追加する
            </button>
            {state.dirty && (
              <span className="review__note">
                未保存の変更があります。先に保存するか破棄してください。
              </span>
            )}
          </div>
        ) : (
          <>
            <label className="field">
              <span className="field__label">カメラ</span>
              <select
                className="field__input"
                value={state.insertDraft.cameraId}
                disabled={editingDisabled}
                onChange={(e) =>
                  dispatch({
                    type: 'insert/changed',
                    patch: { cameraId: e.currentTarget.value },
                  })
                }
              >
                {data.cameras.map((c) => (
                  <option key={c.cameraId} value={c.cameraId}>
                    {c.label}（{c.fileName}）
                  </option>
                ))}
              </select>
            </label>

            <div className="camera__times">
              <label className="field">
                <span className="field__label">開始（秒）</span>
                <input
                  className="field__input"
                  type="number"
                  step={0.1}
                  min={0}
                  value={state.insertDraft.startSec}
                  disabled={editingDisabled}
                  onChange={(e) =>
                    dispatch({
                      type: 'insert/changed',
                      patch: { startSec: seconds(e.currentTarget.value) },
                    })
                  }
                />
              </label>
              <label className="field">
                <span className="field__label">終了（秒）</span>
                <input
                  className="field__input"
                  type="number"
                  step={0.1}
                  min={0}
                  value={state.insertDraft.endSec}
                  disabled={editingDisabled}
                  onChange={(e) =>
                    dispatch({
                      type: 'insert/changed',
                      patch: { endSec: seconds(e.currentTarget.value) },
                    })
                  }
                />
              </label>
            </div>

            {draftIssues.length > 0 && (
              <div className="banner banner--error" role="alert">
                {draftIssues.map((issue) => (
                  <p key={issue.kind} className="banner__message">
                    {issue.message}
                  </p>
                ))}
              </div>
            )}

            <p className="review__note">
              追加したカットの理由は「カメラ維持」として記録されます
              （解析が使う理由の一覧に「人が追加」が無いための暫定措置です）。
            </p>

            <div className="card__actions">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void insert()}
                disabled={!canInsert(state)}
              >
                {state.phase === 'saving' ? '保存中…' : 'このカットを追加'}
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => dispatch({ type: 'insert/cancelled' })}
                disabled={state.phase === 'saving'}
              >
                やめる
              </button>
            </div>
          </>
        )}
      </section>

      {/* ── 再出力 ── */}
      <section className="card">
        <h3 className="card__subtitle">Premiere用データの再出力</h3>
        <p className="review__note">
          保存したカメラ切替を反映して FCP7 XML を作り直します。
          解析・文字起こし・音声同期はやり直しません。
        </p>
        <div className="card__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void runExport()}
            disabled={!canExport(state)}
          >
            {state.phase === 'export-running' ? '再出力中…' : 'Premiere用データを再出力'}
          </button>
          {state.phase === 'export-complete' && (
            <span className="badge badge--ok">再出力しました</span>
          )}
          {state.dirty && (
            <span className="review__note">未保存の変更があります。先に保存してください。</span>
          )}
        </div>
      </section>
    </div>
  );
}
