/**
 * 確認画面（Review）— マーカーの確認・修正。
 *
 * ★色の意味は他のReview画面と揃える。
 * 青：保存済みの修正 / 赤：孤立・種別またぎ（要確認）/ 黄：再解析で外れうる
 *
 * ★この画面が必ず出すもの
 * 1. マーカー修正が FCP7 XML にしか反映されない旨（exportNotice）
 * 2. Premiereのマーカー名に `[KIND] ` が自動で前置される旨（namePrefixNotice）
 * 3. ★CHECK 系マーカー（volatileId）を選んだときの個別警告
 *    「編集はできるが、再解析すると外れる」ことを編集前に必ず知らせる
 * いずれも実装で回避できない性質なので、操作の前に見える位置に置く。
 */

import { useCallback, useEffect, useReducer, useRef, useState, type JSX } from 'react';

import type { ProjectSummary } from '../shared/dto.ts';
import type { MarkerKindDto } from '../shared/marker-dto.ts';
import { formatTimecode } from './format.ts';
import {
  canEditMarker,
  canExport,
  canSave,
  draftOf,
  initialMarkerState,
  reducer,
  visibleIndexes,
  type MarkerFilter,
  type MarkerState,
} from './marker-state.ts';

const SKIP_SEC = 5;

const FILTER_LABELS: { value: MarkerFilter; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'edited', label: '修正済み' },
  { value: 'attention', label: '要確認' },
];

function SaveBadge({ state }: { state: MarkerState }): JSX.Element {
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

export function MarkerScreen({
  summary,
  onBack,
}: {
  summary: ProjectSummary;
  onBack: () => void;
}): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialMarkerState);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | undefined>(undefined);
  const [mediaNote, setMediaNote] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    dispatch({ type: 'load/started' });
    const result = await window.contentOs.markerLoad(summary.projectPath);
    if (result.ok) {
      dispatch({ type: 'load/succeeded', data: result.data });
      if (result.data.media !== undefined) setMediaUrl(result.data.media.url);
    } else {
      dispatch({ type: 'load/failed', error: result.error });
    }
  }, [summary.projectPath]);

  useEffect(() => {
    void load();
  }, [load]);

  // ★再出力の完了は既存の完了イベントで受け取る。購読解除を必ず行う。
  useEffect(() => {
    const off = window.contentOs.onPipelineFinished((event) => {
      dispatch({
        type: 'export/finished',
        runId: event.runId,
        ok: event.outcome === 'completed' || event.outcome === 'warning',
        ...(event.error !== undefined ? { error: event.error } : {}),
      });
      void load();
    });
    return () => off();
  }, [load]);

  const prepareMedia = useCallback(async () => {
    setMediaNote('プレビュー音声を準備しています…');
    const result = await window.contentOs.reviewOpenMedia(summary.projectPath);
    if (result.ok) {
      setMediaUrl(result.media.url);
      setMediaNote(undefined);
    } else {
      setMediaNote(result.error.userMessage);
    }
  }, [summary.projectPath]);

  const markers = state.data?.markers ?? [];
  const selected =
    state.selectedIndex !== undefined ? markers[state.selectedIndex] : undefined;
  const draft =
    state.draft?.index === state.selectedIndex
      ? state.draft
      : selected !== undefined && state.selectedIndex !== undefined
        ? draftOf(selected, state.selectedIndex)
        : undefined;

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

  const applySaveResult = useCallback(
    async (
      result: Awaited<ReturnType<typeof window.contentOs.markerUpdate>>,
      options: { reload?: boolean } = {},
    ) => {
      if (result.ok) {
        dispatch({
          type: 'save/succeeded',
          updatedAt: result.updatedAt,
          ...(result.marker !== undefined ? { marker: result.marker } : {}),
          counts: result.counts,
          orphaned: result.orphaned,
          ...(options.reload === true ? { reload: true } : {}),
        });
        // ★件数が変わる操作（削除・取り消し）は一覧を取り直して揃える。
        if (options.reload === true) await load();
      } else if (result.conflict === true) {
        dispatch({ type: 'save/conflicted', error: result.error });
      } else {
        dispatch({ type: 'save/failed', error: result.error });
      }
    },
    [load],
  );

  const save = useCallback(async () => {
    if (!canSave(state) || state.draft === undefined || state.updatedAt === undefined) {
      return;
    }
    const target = markers[state.draft.index];
    if (target === undefined) return;
    const d = state.draft;

    dispatch({ type: 'save/started' });
    await applySaveResult(
      await window.contentOs.markerUpdate({
        projectPath: summary.projectPath,
        markerId: target.id,
        expectedUpdatedAt: state.updatedAt,
        patch: { name: d.name, comment: d.comment },
      }),
    );
  }, [state, markers, summary.projectPath, applySaveResult]);

  const remove = useCallback(async () => {
    if (selected === undefined || state.updatedAt === undefined) return;
    dispatch({ type: 'save/started' });
    await applySaveResult(
      await window.contentOs.markerDelete({
        projectPath: summary.projectPath,
        markerId: selected.id,
        expectedUpdatedAt: state.updatedAt,
      }),
      { reload: true },
    );
  }, [selected, state.updatedAt, summary.projectPath, applySaveResult]);

  const revert = useCallback(async () => {
    if (selected === undefined || state.updatedAt === undefined) return;
    dispatch({ type: 'save/started' });
    await applySaveResult(
      await window.contentOs.markerRemoveEdit({
        projectPath: summary.projectPath,
        markerId: selected.id,
        expectedUpdatedAt: state.updatedAt,
      }),
      { reload: true },
    );
  }, [selected, state.updatedAt, summary.projectPath, applySaveResult]);

  const runExport = useCallback(async () => {
    if (!canExport(state)) return;
    const result = await window.contentOs.markerExport({
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
        <p>マーカーを読み込んでいます…</p>
      </section>
    );
  }

  if (state.data === undefined) {
    return (
      <section className="card card--failed">
        <h2 className="card__title">マーカーを開けませんでした</h2>
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
  const shown = visibleIndexes(markers, state.filter, state.kindFilter);
  const editingDisabled = state.phase === 'saving' || state.phase === 'conflict';

  return (
    <div className="review marker">
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
            <span className="stat__label">マーカー</span>
            <span className="stat__value">{data.counts.markers}</span>
          </div>
          <div className="stat">
            <span className="stat__label">修正済み</span>
            <span className="stat__value stat__value--edited">{data.counts.edited}</span>
          </div>
          <div className="stat">
            <span className="stat__label">削除</span>
            <span className="stat__value">{data.counts.deleted}</span>
          </div>
          <div className="stat">
            <span className="stat__label">要確認</span>
            <span
              className={`stat__value ${
                data.counts.kindMismatch > 0 ? 'stat__value--danger' : ''
              }`}
            >
              {data.counts.kindMismatch + data.counts.duplicateId}
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
          <p className="banner__action">{data.namePrefixNotice}</p>
          {data.syncModeNotice !== undefined && (
            <p className="banner__action">{data.syncModeNotice}</p>
          )}
        </div>

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
        {mediaUrl === undefined ? (
          <div className="card__actions">
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => void prepareMedia()}
            >
              プレビュー音声を用意する
            </button>
            {mediaNote !== undefined && <span className="review__note">{mediaNote}</span>}
          </div>
        ) : (
          <>
            {/* 4K素材は再生しない。cache/preview に作った低ビットレート音声のみ。 */}
            <audio
              ref={audioRef}
              src={mediaUrl}
              preload="metadata"
              onTimeUpdate={(e) =>
                dispatch({ type: 'playhead/moved', sec: e.currentTarget.currentTime })
              }
            />
            <div className="player">
              <button type="button" className="btn btn--secondary" onClick={togglePlay}>
                再生 / 停止
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => seek(state.playheadSec - SKIP_SEC)}
              >
                ← 5秒
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => seek(state.playheadSec + SKIP_SEC)}
              >
                5秒 →
              </button>
              <span className="player__tc">{formatTimecode(state.playheadSec)}</span>
              <input
                className="player__seek"
                type="range"
                min={0}
                max={Math.max(1, data.media?.durationSec ?? 1)}
                step={0.1}
                value={state.playheadSec}
                onChange={(e) => seek(Number(e.currentTarget.value))}
                aria-label="再生位置"
              />
            </div>
          </>
        )}
      </section>

      {/* ── 孤立・種別またぎ ── */}
      {(data.orphaned.length > 0 || data.counts.kindMismatch > 0) && (
        <section className="card card--attention">
          <h3 className="card__subtitle">
            要確認：孤立した修正 {data.orphaned.length} 件
            {data.counts.kindMismatch > 0 &&
              ` / 別の種別へ繋ぎ直された修正 ${data.counts.kindMismatch} 件`}
          </h3>
          {markers
            .filter((m) => m.reattachedKindMismatch !== undefined)
            .map((m) => (
              <div key={`mismatch-${m.id}`} className="attention">
                <span className="attention__tag attention__tag--conflict">要確認</span>
                <span className="attention__body">
                  {formatTimecode(m.startSec)}：
                  <strong>{m.reattachedKindMismatch!.fromKind}</strong> に付けた修正が、
                  再解析で <strong>{m.reattachedKindMismatch!.toKind}</strong>{' '}
                  のマーカーへ繋ぎ直されました。現在の名前は「{m.name}」です。
                  <span className="attention__reason">
                    種類が違うので、意図した内容か確認してください。
                    違う場合は「解析結果に戻す」で取り消せます。
                  </span>
                </span>
              </div>
            ))}
          {data.orphaned.map((o) => (
            <div key={o.originalId} className="attention">
              <span className="attention__tag attention__tag--orphan">孤立</span>
              <span className="attention__body">
                {o.originalId}
                {o.approxSec !== undefined && `（約${formatTimecode(o.approxSec)}）`}
                の修正が繋がりませんでした。
                {o.name !== undefined && <> 名前：「{o.name}」</>}
                {o.deleted === true && <> 内容：このマーカーの削除</>}
                <span className="attention__reason">{o.reason}</span>
              </span>
            </div>
          ))}
        </section>
      )}

      {/* ── マーカー一覧 ── */}
      <section className="card">
        <div className="card__head">
          <h3 className="card__subtitle">マーカー（{markers.length} 件）</h3>
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

        {/* 種別の絞り込み。実データでは CHECK が過半を占めるため独立させる。 */}
        <div className="filters filters--kinds">
          <button
            type="button"
            className={[
              'btn',
              'btn--chip',
              state.kindFilter === undefined ? 'btn--chip-active' : '',
            ].join(' ')}
            onClick={() => dispatch({ type: 'kindFilter/changed' })}
          >
            全種別
          </button>
          {data.kinds.map((k) => (
            <button
              key={k.kind}
              type="button"
              className={[
                'btn',
                'btn--chip',
                state.kindFilter === k.kind ? 'btn--chip-active' : '',
              ].join(' ')}
              onClick={() =>
                dispatch({
                  type: 'kindFilter/changed',
                  kind: state.kindFilter === k.kind ? undefined : (k.kind as MarkerKindDto),
                })
              }
            >
              {k.label} {k.count}
            </button>
          ))}
        </div>

        {shown.length === 0 ? (
          <p className="review__note">この絞り込みに該当するマーカーはありません。</p>
        ) : (
          <ol className="cues marker__list">
            {shown.map((index) => {
              const m = markers[index]!;
              return (
                <li
                  key={m.id}
                  className={[
                    'cues__item',
                    index === state.selectedIndex ? 'cues__item--selected' : '',
                    m.edited ? 'cues__item--edited' : '',
                    m.reattachedKindMismatch !== undefined || m.duplicateId
                      ? 'cues__item--conflicted'
                      : '',
                    !m.editable ? 'cues__item--locked' : '',
                  ].join(' ')}
                >
                  <button
                    type="button"
                    className="cues__button"
                    onClick={() => {
                      dispatch({ type: 'marker/selected', index });
                      seek(m.startSec);
                    }}
                  >
                    <span className="cues__tc">
                      {formatTimecode(m.startSec)}
                      {m.endSec !== undefined && ` → ${formatTimecode(m.endSec)}`}
                    </span>
                    <span className="marker__kind">{m.kindLabel}</span>
                    <span className="cues__text">{m.name}</span>
                    <span className="cues__flags">
                      {m.edited && <span className="tag tag--edited">修正済み</span>}
                      {m.volatileId && <span className="tag tag--warn">再解析で外れる</span>}
                      {m.reattachedKindMismatch !== undefined && (
                        <span className="tag tag--conflict">種別違い</span>
                      )}
                      {m.reattached !== undefined &&
                        m.reattachedKindMismatch === undefined && (
                          <span className="tag tag--warn">繋ぎ直し</span>
                        )}
                      {m.duplicateId && <span className="tag tag--locked">ID重複</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* ── 編集 ── */}
      {selected !== undefined && draft !== undefined && (
        <section className="card">
          <h3 className="card__subtitle">
            選択中：[{selected.kind}] {formatTimecode(selected.startSec)}
          </h3>

          {!canEditMarker(selected) ? (
            <p className="review__note review__note--danger">
              このマーカーは同じ種別・同じ時刻の別マーカーとIDが重複しているため、
              修正できません。修正すると両方に適用されてしまうためです。
            </p>
          ) : (
            <>
              {/* ★CHECK 系マーカーの個別警告。編集は許可するが必ず知らせる。 */}
              {selected.volatileId && (
                <div className="banner banner--warn" role="status">
                  <p className="banner__message">
                    ⚠️ このマーカーのIDは時刻を持たないため、
                    <strong>再解析すると、ここで付けた名前・コメントは外れます</strong>。
                  </p>
                  <p className="banner__action">
                    一時的な確認メモとしては使えます。外れた内容は消さずに
                    「孤立した修正」として残します。
                  </p>
                </div>
              )}

              {selected.reattachedKindMismatch !== undefined && (
                <div className="banner banner--error" role="alert">
                  <p className="banner__message">
                    この修正はもともと{' '}
                    {selected.reattachedKindMismatch.fromKind} のマーカーに付けたものです。
                    再解析で {selected.reattachedKindMismatch.toKind}{' '}
                    のマーカーへ繋ぎ直されました。
                  </p>
                  <p className="banner__action">
                    意図した内容でなければ「解析結果に戻す」で取り消してください。
                  </p>
                </div>
              )}

              <label className="field">
                <span className="field__label">マーカー名</span>
                <input
                  className="field__input"
                  type="text"
                  value={draft.name}
                  disabled={editingDisabled}
                  onChange={(e) =>
                    dispatch({ type: 'draft/changed', patch: { name: e.currentTarget.value } })
                  }
                />
              </label>

              <label className="field">
                <span className="field__label">コメント</span>
                <textarea
                  className="field__input"
                  rows={4}
                  value={draft.comment}
                  disabled={editingDisabled}
                  onChange={(e) =>
                    dispatch({
                      type: 'draft/changed',
                      patch: { comment: e.currentTarget.value },
                    })
                  }
                />
              </label>

              <p className="review__note">
                時刻と種類の変更は未対応です。マーカーの追加もできません
                （データ構造が持たないためです）。
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
                  disabled={state.phase === 'saving' || state.dirty}
                >
                  このマーカーを削除
                </button>
                {selected.edited && (
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

              {selected.edited && selected.analysisName !== undefined && (
                <p className="review__note">
                  解析（AI）の元の名前：「{selected.analysisName}」
                </p>
              )}
            </>
          )}
        </section>
      )}

      {/* ── 再出力 ── */}
      <section className="card">
        <h3 className="card__subtitle">Premiere用データの再出力</h3>
        <p className="review__note">
          保存したマーカーの修正を反映して FCP7 XML を作り直します。
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
