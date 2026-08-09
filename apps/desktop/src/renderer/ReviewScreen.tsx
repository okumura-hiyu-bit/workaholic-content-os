/**
 * 確認画面（Review）— 字幕の確認・修正。
 *
 * ★今回のスコープは字幕のみ。
 * カメラ切替・マーカー・ショート候補の編集は入れていない。
 *
 * ★色の意味を固定する（青・白・グレーが基本）。
 * 黄：低confidence語 / 赤：孤立修正・競合 / 青：保存済みの修正
 */

import { useCallback, useEffect, useReducer, type JSX } from 'react';

import type { ProjectSummary } from '../shared/dto.ts';
import type { ReviewSubtitleCue } from '../shared/review-dto.ts';
import { formatTimecode, splitByLowConfidence } from './format.ts';
import {
  ReviewPlayer,
  SaveBadge,
  useReviewMedia,
  usePipelineFinished,
} from './review-shared.tsx';
import {
  canEditCue,
  canExport,
  canSave,
  initialReviewState,
  reducer,
} from './review-state.ts';

function CueText({ cue }: { cue: ReviewSubtitleCue }): JSX.Element {
  const parts = splitByLowConfidence(cue.text, cue.lowConfidenceWords);
  return (
    <span>
      {parts.map((part, i) =>
        part.low ? (
          <mark key={i} className="lowconf">
            {part.text}
          </mark>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}

export function ReviewScreen({
  summary,
  onBack,
}: {
  summary: ProjectSummary;
  onBack: () => void;
}): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialReviewState);
  const media = useReviewMedia(summary.projectPath);
  // ★`setMediaUrl` は恒久的に安定なので、依存に入れても `load` の同一性は
  //   案件が変わったときしか変わらない（＝完了イベントの購読は張り直されない）。
  const { setMediaUrl } = media;

  const load = useCallback(async () => {
    dispatch({ type: 'load/started' });
    const result = await window.contentOs.reviewLoad(summary.projectPath);
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

  const cues = state.data?.subtitles ?? [];
  const selected =
    state.selectedIndex !== undefined ? cues[state.selectedIndex] : undefined;
  const draft = state.draft?.index === state.selectedIndex ? state.draft : undefined;

  const save = useCallback(async () => {
    if (!canSave(state) || state.draft === undefined || state.updatedAt === undefined) return;
    const cue = cues[state.draft.index];
    if (cue === undefined) return;

    dispatch({ type: 'save/started' });
    const result = await window.contentOs.reviewUpdateSubtitle({
      projectPath: summary.projectPath,
      subtitleId: cue.id,
      expectedUpdatedAt: state.updatedAt,
      patch: {
        text: state.draft.text,
        ...(state.draft.speakerId !== undefined
          ? { speakerId: state.draft.speakerId }
          : {}),
      },
    });

    if (result.ok) {
      dispatch({
        type: 'save/succeeded',
        updatedAt: result.updatedAt,
        cue: result.cue,
        counts: result.counts,
      });
    } else if (result.conflict === true) {
      dispatch({ type: 'save/conflicted', error: result.error });
    } else {
      dispatch({ type: 'save/failed', error: result.error });
    }
  }, [state, cues, summary.projectPath]);

  const revert = useCallback(async () => {
    if (selected === undefined || state.updatedAt === undefined) return;
    dispatch({ type: 'save/started' });
    const result = await window.contentOs.reviewRemoveSubtitleEdit({
      projectPath: summary.projectPath,
      subtitleId: selected.id,
      expectedUpdatedAt: state.updatedAt,
    });
    if (result.ok) {
      dispatch({
        type: 'save/succeeded',
        updatedAt: result.updatedAt,
        cue: result.cue,
        counts: result.counts,
      });
    } else if (result.conflict === true) {
      dispatch({ type: 'save/conflicted', error: result.error });
    } else {
      dispatch({ type: 'save/failed', error: result.error });
    }
  }, [selected, state.updatedAt, summary.projectPath]);

  const runExport = useCallback(async () => {
    if (!canExport(state)) return;
    const result = await window.contentOs.reviewExport({
      projectPath: summary.projectPath,
    });
    if (result.ok) {
      dispatch({ type: 'export/started', runId: result.runId });
    } else {
      dispatch({ type: 'save/failed', error: result.error });
    }
  }, [state, summary.projectPath]);

  // ─── 再生操作 ───────────────────────────────────────

  if (state.phase === 'loading') {
    return (
      <section className="card">
        <p>確認画面を読み込んでいます…</p>
      </section>
    );
  }

  if (state.data === undefined) {
    return (
      <section className="card card--failed">
        <h2 className="card__title">確認画面を開けませんでした</h2>
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

  return (
    <div className="review">
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
            <span className="stat__label">字幕キュー</span>
            <span className="stat__value">{data.counts.cues}</span>
          </div>
          <div className="stat">
            <span className="stat__label">低confidence語</span>
            <span className="stat__value stat__value--warn">
              {data.counts.lowConfidenceWords}
            </span>
          </div>
          <div className="stat">
            <span className="stat__label">修正済み</span>
            <span className="stat__value stat__value--edited">{data.counts.edited}</span>
          </div>
          <div className="stat">
            <span className="stat__label">未保存</span>
            <span className="stat__value">{state.dirty ? 1 : 0}</span>
          </div>
          <div className="stat">
            <span className="stat__label">保存状態</span>
            <SaveBadge state={state} />
          </div>
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
        <ReviewPlayer
          media={media}
          durationSec={data.media?.durationSec ?? 1}
          playheadSec={state.playheadSec}
          onPlayheadChange={(sec) => dispatch({ type: 'playhead/moved', sec })}
        />
      </section>

      {/* ── 孤立・競合 ── */}
      {(data.orphaned.length > 0 ||
        data.conflicted.length > 0 ||
        data.ambiguous.length > 0) && (
        <section className="card card--attention">
          <h3 className="card__subtitle">
            要確認：孤立した修正 {data.orphaned.length} 件 / 競合 {data.conflicted.length} 件
            {data.ambiguous.length > 0 && ` / ID重複への修正 ${data.ambiguous.length} 件`}
          </h3>
          {data.ambiguous.map((a) => (
            <div key={a.subtitleId} className="attention">
              <span className="attention__tag attention__tag--conflict">要確認</span>
              <span className="attention__body">
                {formatTimecode(a.approxSec ?? 0)}：同じIDのキューが{a.cueCount}件あり、
                そこに修正が保存されています。どちらへの修正か判断できないため、
                自動では移動していません。
                {a.text !== undefined && <> 内容：「{a.text}」</>}
                <span className="attention__reason">
                  もう一度解析すると、キューごとに別のIDが振られて解消します。
                </span>
              </span>
            </div>
          ))}
          {data.orphaned.map((o) => (
            <div key={o.originalId} className="attention">
              <span className="attention__tag attention__tag--orphan">孤立</span>
              <span className="attention__body">
                {o.originalId}（約{formatTimecode(o.approxSec ?? 0)}）の修正が繋がりませんでした。
                {o.text !== undefined && <> 内容：「{o.text}」</>}
                <span className="attention__reason">{o.reason}</span>
              </span>
            </div>
          ))}
          {data.conflicted.map((c) => (
            <div key={c.subtitleId} className="attention">
              <span className="attention__tag attention__tag--conflict">競合</span>
              <span className="attention__body">
                {formatTimecode(c.approxSec ?? 0)}：修正後に解析結果が変わりました。
                <br />
                修正「{c.humanText}」／ 修正時の解析「{c.previousAnalysisText}」／ 現在の解析「
                {c.currentAnalysisText}」
              </span>
            </div>
          ))}
        </section>
      )}

      {/* ── 字幕一覧 ── */}
      <section className="card">
        <h3 className="card__subtitle">字幕（{cues.length} キュー）</h3>
        <ol className="cues">
          {cues.map((cue, index) => (
            <li
              key={`${cue.id}-${index}`}
              className={[
                'cues__item',
                index === state.selectedIndex ? 'cues__item--selected' : '',
                cue.edited ? 'cues__item--edited' : '',
                cue.conflicted ? 'cues__item--conflicted' : '',
                !cue.editable ? 'cues__item--locked' : '',
              ].join(' ')}
            >
              <button
                type="button"
                className="cues__button"
                onClick={() => {
                  dispatch({ type: 'cue/selected', index });
                  media.seek(cue.startSec);
                }}
              >
                <span className="cues__tc">
                  {formatTimecode(cue.startSec)} → {formatTimecode(cue.endSec)}
                </span>
                <span className="cues__speaker">
                  {data.speakers.find((s) => s.id === cue.speakerId)?.name ?? cue.speakerId ?? '—'}
                </span>
                <span className="cues__text">
                  <CueText cue={cue} />
                </span>
                <span className="cues__flags">
                  {cue.minProbability !== undefined && (
                    <span className="cues__conf">
                      信頼度 {Math.round(cue.minProbability * 100)}%
                    </span>
                  )}
                  {cue.edited && <span className="tag tag--edited">修正済み</span>}
                  {cue.conflicted && <span className="tag tag--conflict">競合</span>}
                  {!cue.editable && <span className="tag tag--locked">ID重複</span>}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </section>

      {/* ── 編集 ── */}
      {selected !== undefined && (
        <section className="card">
          <h3 className="card__subtitle">
            選択中：{formatTimecode(selected.startSec)} → {formatTimecode(selected.endSec)}
          </h3>

          {!canEditCue(selected) ? (
            <p className="review__note review__note--danger">
              このキューは同じ開始時刻の別キューとIDが重複しているため、修正できません。
              修正すると両方に適用されてしまうためです。
            </p>
          ) : (
            <>
              <label className="field">
                <span className="field__label">字幕本文</span>
                <textarea
                  className="field__input"
                  rows={3}
                  value={draft?.text ?? selected.text}
                  disabled={state.phase === 'saving' || state.phase === 'conflict'}
                  onChange={(e) =>
                    dispatch({ type: 'draft/changed', patch: { text: e.currentTarget.value } })
                  }
                />
              </label>

              <label className="field">
                <span className="field__label">話者</span>
                <select
                  className="field__input"
                  value={draft?.speakerId ?? selected.speakerId ?? ''}
                  disabled={state.phase === 'saving' || state.phase === 'conflict'}
                  onChange={(e) =>
                    dispatch({
                      type: 'draft/changed',
                      patch: { speakerId: e.currentTarget.value },
                    })
                  }
                >
                  <option value="" disabled>
                    選択してください
                  </option>
                  {data.speakers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>

              <p className="review__note">
                タイムコードの編集は今回のバージョンでは未対応です（本文と話者のみ）。
              </p>
              <p className="review__note">
                ★話者の修正は project.json に保存されますが、現時点では書き出す成果物に
                反映されません。字幕SRTは本文のみ、話者テロップSRTは発話区間の判定結果から
                作られるためです。本文の修正は字幕SRTに反映されます。
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

              {selected.edited && (
                <p className="review__note">
                  解析（AI）の元の本文：「{selected.analysisText}」
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
          字幕SRT・話者名SRT・FCP7 XMLを、保存した修正を反映して作り直します。
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
