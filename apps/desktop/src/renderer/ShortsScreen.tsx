/**
 * 確認画面（Review）— ショート候補の確認・採否。
 *
 * ★色の意味は字幕Reviewと揃える（青・白・グレーが基本）。
 * 緑：採用 / グレー：不採用 / 赤：孤立・要確認 / 青：保存済みの判断
 *
 * ★この画面が必ず出すもの
 * 1. 再解析で判断が外れうるという警告（ShortsData.reanalysisWarning）
 * 2. shorts.csv に書き出されない項目（ShortsData.fieldsNotExported）
 * どちらも実装で回避できない性質なので、編集を始める前に見える位置に置く。
 */

import { useCallback, useEffect, useReducer, useRef, useState, type JSX } from 'react';

import type { ProjectSummary } from '../shared/dto.ts';
import type { ShortCandidateItem } from '../shared/shorts-dto.ts';
import { formatTimecode } from './format.ts';
import {
  canExport,
  canSave,
  draftOf,
  initialShortsState,
  reducer,
  visibleIndexes,
  type ShortsFilter,
  type ShortsState,
} from './shorts-state.ts';

const SKIP_SEC = 5;

const FILTER_LABELS: { value: ShortsFilter; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'undecided', label: '未判断' },
  { value: 'adopted', label: '採用' },
  { value: 'rejected', label: '不採用' },
];

function SaveBadge({ state }: { state: ShortsState }): JSX.Element {
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

function adoptionLabel(adopted: boolean | undefined): string {
  if (adopted === true) return '採用';
  if (adopted === false) return '不採用';
  return '未判断';
}

function formatDuration(sec: number): string {
  return `${sec.toFixed(1)}秒`;
}

export function ShortsScreen({
  summary,
  onBack,
}: {
  summary: ProjectSummary;
  onBack: () => void;
}): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialShortsState);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [mediaUrl, setMediaUrl] = useState<string | undefined>(undefined);
  const [mediaNote, setMediaNote] = useState<string | undefined>(undefined);
  /** ハッシュタグは1行1件のテキストで編集する（配列を直接触らせない）。 */
  const [tagText, setTagText] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    dispatch({ type: 'load/started' });
    const result = await window.contentOs.shortsLoad(summary.projectPath);
    if (result.ok) {
      dispatch({ type: 'load/succeeded', data: result.data });
      if (result.data.media !== undefined) setMediaUrl(result.data.media.url);
    } else {
      dispatch({ type: 'load/failed', error: result.error });
    }
    setTagText(undefined);
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

  const candidates = state.data?.candidates ?? [];
  const selected =
    state.selectedIndex !== undefined ? candidates[state.selectedIndex] : undefined;
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

  const selectCandidate = useCallback(
    (index: number, candidate: ShortCandidateItem) => {
      dispatch({ type: 'candidate/selected', index });
      setTagText(undefined);
      seek(candidate.startSec);
    },
    [seek],
  );

  const save = useCallback(async () => {
    if (!canSave(state) || state.draft === undefined || state.updatedAt === undefined) {
      return;
    }
    const candidate = candidates[state.draft.index];
    if (candidate === undefined) return;
    const d = state.draft;

    dispatch({ type: 'save/started' });
    // ★空文字は null（＝項目を消す）として送る。空文字を保存に残さない。
    const result = await window.contentOs.shortsUpdateDecision({
      projectPath: summary.projectPath,
      shortId: candidate.id,
      expectedUpdatedAt: state.updatedAt,
      patch: {
        adopted: d.adopted === undefined ? null : d.adopted,
        title: d.title.trim() === '' ? null : d.title,
        hook: d.hook.trim() === '' ? null : d.hook,
        caption: d.caption.trim() === '' ? null : d.caption,
        hashtags: d.hashtags.length === 0 ? null : d.hashtags,
        note: d.note.trim() === '' ? null : d.note,
      },
    });

    if (result.ok) {
      dispatch({
        type: 'save/succeeded',
        updatedAt: result.updatedAt,
        candidate: result.candidate,
        counts: result.counts,
      });
      setTagText(undefined);
    } else if (result.conflict === true) {
      dispatch({ type: 'save/conflicted', error: result.error });
    } else {
      dispatch({ type: 'save/failed', error: result.error });
    }
  }, [state, candidates, summary.projectPath]);

  const revert = useCallback(async () => {
    if (selected === undefined || state.updatedAt === undefined) return;
    dispatch({ type: 'save/started' });
    const result = await window.contentOs.shortsRemoveDecision({
      projectPath: summary.projectPath,
      shortId: selected.id,
      expectedUpdatedAt: state.updatedAt,
    });
    if (result.ok) {
      dispatch({
        type: 'save/succeeded',
        updatedAt: result.updatedAt,
        candidate: result.candidate,
        counts: result.counts,
      });
      setTagText(undefined);
    } else if (result.conflict === true) {
      dispatch({ type: 'save/conflicted', error: result.error });
    } else {
      dispatch({ type: 'save/failed', error: result.error });
    }
  }, [selected, state.updatedAt, summary.projectPath]);

  const runExport = useCallback(async () => {
    if (!canExport(state)) return;
    const result = await window.contentOs.shortsExport({
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
        <p>ショート候補を読み込んでいます…</p>
      </section>
    );
  }

  if (state.data === undefined) {
    return (
      <section className="card card--failed">
        <h2 className="card__title">ショート候補を開けませんでした</h2>
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
  const shown = visibleIndexes(candidates, state.filter);
  const editingDisabled = state.phase === 'saving' || state.phase === 'conflict';

  return (
    <div className="review shorts">
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
            <span className="stat__label">候補</span>
            <span className="stat__value">{data.counts.candidates}</span>
          </div>
          <div className="stat">
            <span className="stat__label">採用</span>
            <span className="stat__value stat__value--adopted">{data.counts.adopted}</span>
          </div>
          <div className="stat">
            <span className="stat__label">不採用</span>
            <span className="stat__value">{data.counts.rejected}</span>
          </div>
          <div className="stat">
            <span className="stat__label">未判断</span>
            <span className="stat__value stat__value--warn">{data.counts.undecided}</span>
          </div>
          <div className="stat">
            <span className="stat__label">保存状態</span>
            <SaveBadge state={state} />
          </div>
        </div>

        {/* ★実装で回避できない性質。常時表示する。 */}
        <div className="banner banner--warn" role="status">
          <p className="banner__message">⚠️ {data.reanalysisWarning}</p>
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

      {/* ── 孤立・取り違え ── */}
      {(data.orphaned.length > 0 || data.counts.rangeChanged > 0) && (
        <section className="card card--attention">
          <h3 className="card__subtitle">
            要確認：孤立した判断 {data.orphaned.length} 件
            {data.counts.rangeChanged > 0 && ` / 区間が変わった候補 ${data.counts.rangeChanged} 件`}
          </h3>
          {data.orphaned.map((o) => (
            <div key={o.originalId} className="attention">
              <span className="attention__tag attention__tag--orphan">孤立</span>
              <span className="attention__body">
                {o.originalId}（{adoptionLabel(o.adopted)}）の判断が繋がりませんでした。
                {o.title !== undefined && <> タイトル：「{o.title}」</>}
                {o.note !== undefined && <> メモ：「{o.note}」</>}
                <span className="attention__reason">{o.reason}</span>
              </span>
            </div>
          ))}
          {candidates
            .filter((c) => c.rangeChanged)
            .map((c) => (
              <div key={`range-${c.id}`} className="attention">
                <span className="attention__tag attention__tag--conflict">要確認</span>
                <span className="attention__body">
                  {c.id}：判断したときと区間が変わっています。判断は
                  {adoptionLabel(c.adopted)}のまま残っていますが、対象の内容が
                  別物になっている可能性があります。
                  <br />
                  判断時 {formatTimecode(c.decidedRange?.startSec ?? 0)} →{' '}
                  {formatTimecode(c.decidedRange?.endSec ?? 0)}（スコア{' '}
                  {c.decidedRange?.score ?? '—'}） ／ 現在 {formatTimecode(c.startSec)} →{' '}
                  {formatTimecode(c.endSec)}（スコア {c.score}）
                  <span className="attention__reason">
                    区間を再生して、判断が今も妥当か確認してください。
                  </span>
                </span>
              </div>
            ))}
        </section>
      )}

      {/* ── 候補一覧 ── */}
      <section className="card">
        <div className="card__head">
          <h3 className="card__subtitle">ショート候補（{candidates.length} 件）</h3>
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
          <p className="review__note">この絞り込みに該当する候補はありません。</p>
        ) : (
          <ol className="cues shorts__list">
            {shown.map((index) => {
              const c = candidates[index]!;
              return (
                <li
                  key={c.id}
                  className={[
                    'cues__item',
                    index === state.selectedIndex ? 'cues__item--selected' : '',
                    c.edited ? 'cues__item--edited' : '',
                    c.adopted === true ? 'cues__item--adopted' : '',
                    c.adopted === false ? 'cues__item--rejected' : '',
                    c.rangeChanged ? 'cues__item--conflicted' : '',
                  ].join(' ')}
                >
                  <button
                    type="button"
                    className="cues__button"
                    onClick={() => selectCandidate(index, c)}
                  >
                    <span className="cues__tc">
                      {formatTimecode(c.startSec)} → {formatTimecode(c.endSec)}
                    </span>
                    <span className="shorts__dur">{formatDuration(c.durationSec)}</span>
                    <span className="cues__text">
                      {c.title ?? c.transcriptExcerpt ?? '（タイトル未設定）'}
                    </span>
                    <span className="cues__flags">
                      <span className="shorts__score">スコア {c.score}</span>
                      {c.adopted === true && <span className="tag tag--adopted">採用</span>}
                      {c.adopted === false && <span className="tag tag--rejected">不採用</span>}
                      {c.adopted === undefined && <span className="tag">未判断</span>}
                      {c.edited && <span className="tag tag--edited">保存済み</span>}
                      {c.rangeChanged && <span className="tag tag--conflict">区間変更</span>}
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
            選択中：{selected.id}／{formatTimecode(selected.startSec)} →{' '}
            {formatTimecode(selected.endSec)}（{formatDuration(selected.durationSec)}）
          </h3>

          <p className="review__note">
            加点の根拠：{selected.signals.length > 0 ? selected.signals.join(' / ') : '—'}
          </p>
          {selected.transcriptExcerpt !== undefined && (
            <p className="review__note shorts__excerpt">
              区間の文字起こし：「{selected.transcriptExcerpt}」
            </p>
          )}

          <fieldset className="field">
            <legend className="field__label">採否</legend>
            <div className="card__actions">
              {[
                { value: true as const, label: '採用' },
                { value: false as const, label: '不採用' },
                { value: undefined, label: '未判断に戻す' },
              ].map((option) => (
                <button
                  key={String(option.label)}
                  type="button"
                  className={[
                    'btn',
                    draft.adopted === option.value ? 'btn--primary' : 'btn--secondary',
                  ].join(' ')}
                  disabled={editingDisabled}
                  onClick={() =>
                    dispatch({ type: 'draft/changed', patch: { adopted: option.value } })
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          </fieldset>

          <label className="field">
            <span className="field__label">タイトル</span>
            <input
              className="field__input"
              type="text"
              value={draft.title}
              disabled={editingDisabled}
              onChange={(e) =>
                dispatch({ type: 'draft/changed', patch: { title: e.currentTarget.value } })
              }
            />
          </label>

          <label className="field">
            <span className="field__label">冒頭フック</span>
            <input
              className="field__input"
              type="text"
              value={draft.hook}
              disabled={editingDisabled}
              onChange={(e) =>
                dispatch({ type: 'draft/changed', patch: { hook: e.currentTarget.value } })
              }
            />
          </label>

          <label className="field">
            <span className="field__label">投稿文</span>
            <textarea
              className="field__input"
              rows={4}
              value={draft.caption}
              disabled={editingDisabled}
              onChange={(e) =>
                dispatch({ type: 'draft/changed', patch: { caption: e.currentTarget.value } })
              }
            />
          </label>

          <label className="field">
            <span className="field__label">ハッシュタグ（1行に1件）</span>
            <textarea
              className="field__input"
              rows={3}
              value={tagText ?? draft.hashtags.join('\n')}
              disabled={editingDisabled}
              onChange={(e) => {
                const raw = e.currentTarget.value;
                setTagText(raw);
                dispatch({
                  type: 'draft/changed',
                  patch: {
                    hashtags: raw
                      .split('\n')
                      .map((t) => t.trim().replace(/^#/, ''))
                      .filter((t) => t.length > 0),
                  },
                });
              }}
            />
          </label>

          <label className="field">
            <span className="field__label">メモ</span>
            <textarea
              className="field__input"
              rows={3}
              value={draft.note}
              disabled={editingDisabled}
              onChange={(e) =>
                dispatch({ type: 'draft/changed', patch: { note: e.currentTarget.value } })
              }
            />
          </label>

          <p className="review__note">
            ショート候補の区間（開始・終了時刻）の編集は未対応です。区間を変えたい場合は
            Premiere側で調整してください。
          </p>
          <p className="review__note review__note--danger">
            ★shorts.csv に書き出されるのは「採否」と「タイトル」までです。
            {data.fieldsNotExported.join('・')}は project.json に保存されますが、
            現時点では書き出す成果物に含まれません。
          </p>

          <div className="card__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void save()}
              disabled={!canSave(state)}
            >
              {state.phase === 'saving' ? '保存中…' : '判断を保存'}
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => {
                dispatch({ type: 'draft/discarded' });
                setTagText(undefined);
              }}
              disabled={!state.dirty || state.phase === 'saving'}
            >
              下書きを破棄
            </button>
            {selected.edited && (
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => void revert()}
                disabled={state.phase === 'saving' || state.dirty}
              >
                この候補の判断を取り消す
              </button>
            )}
          </div>
        </section>
      )}

      {/* ── 再出力 ── */}
      <section className="card">
        <h3 className="card__subtitle">ショート候補一覧（shorts.csv）の再出力</h3>
        <p className="review__note">
          保存した採否・タイトルを反映して shorts.csv を作り直します。
          解析・文字起こし・音声同期はやり直しません。
          <br />
          ★FCP7 XML（Premiereプロジェクト）は作り直しません。ショート候補は
          XMLに含まれないためです。
        </p>
        <div className="card__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void runExport()}
            disabled={!canExport(state)}
          >
            {state.phase === 'export-running' ? '再出力中…' : 'shorts.csv を再出力'}
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
