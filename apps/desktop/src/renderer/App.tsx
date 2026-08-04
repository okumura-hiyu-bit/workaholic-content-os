/**
 * 解析の実行画面（今回はこの1画面のみ）。
 *
 * ★見た目より状態と操作の明確さを優先する。
 * 字幕修正・カメラ切替修正・ショート候補編集は今回のスコープ外。
 *
 * ★イベント購読は必ず解除する。
 * onPipelineProgress / onPipelineFinished は解除関数を返すので、
 * useEffect のクリーンアップで呼ぶ。
 */

// React 19 でグローバルの JSX 名前空間が廃止されたため、react から型を取る。
import { useCallback, useEffect, useReducer, useState, type JSX } from 'react';

import { STEP_LABELS } from '../shared/steps.ts';
import { formatDateTime, formatElapsed, percent, shortenPath } from './format.ts';
import { ReviewScreen } from './ReviewScreen.tsx';
import { SetupScreen } from './SetupScreen.tsx';
import {
  canCancel,
  canStart,
  initialState,
  OUTCOME_LABELS,
  reducer,
  type AppState,
} from './state.ts';

function ErrorBanner({ state }: { state: AppState }): JSX.Element | null {
  if (state.error === undefined) return null;
  return (
    <div className="banner banner--error" role="alert">
      <p className="banner__message">{state.error.userMessage}</p>
      {state.error.suggestedAction !== undefined && (
        <p className="banner__action">{state.error.suggestedAction}</p>
      )}
    </div>
  );
}

export function App(): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [now, setNow] = useState(() => Date.now());
  // 画面の切り替え。入口は一覧（setup）。
  const [screen, setScreen] = useState<'setup' | 'pipeline' | 'review'>('setup');

  // ★購読は1回だけ。解除関数をクリーンアップで必ず呼ぶ。
  useEffect(() => {
    const offProgress = window.contentOs.onPipelineProgress((event) => {
      dispatch({ type: 'run/progress', event });
    });
    const offFinished = window.contentOs.onPipelineFinished((event) => {
      dispatch({ type: 'run/finished', event });
    });
    return () => {
      offProgress();
      offFinished();
    };
  }, []);

  // 経過時間の表示用に1秒ごとに再描画する（解析中のみ）。
  useEffect(() => {
    if (state.phase !== 'running') return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [state.phase]);

  const handleSelect = useCallback(async () => {
    const result = await window.contentOs.selectProject();
    if (result.ok) {
      dispatch({ type: 'selection/succeeded', summary: result.summary });
      return;
    }
    if (result.reason === 'cancelled') {
      dispatch({ type: 'selection/cancelled' });
      return;
    }
    dispatch({ type: 'selection/failed', error: result.error });
  }, []);

  const handleStart = useCallback(async () => {
    if (state.summary === undefined) return;
    dispatch({ type: 'run/requested' });
    const result = await window.contentOs.startPipeline({
      projectPath: state.summary.projectPath,
    });
    if (result.ok) {
      dispatch({ type: 'run/started', runId: result.runId, startedAt: Date.now() });
      setNow(Date.now());
    } else {
      dispatch({ type: 'run/startFailed', error: result.error });
    }
  }, [state.summary]);

  const handleCancel = useCallback(async () => {
    if (state.runId === undefined) return;
    dispatch({ type: 'run/cancelRequested' });
    const result = await window.contentOs.cancelPipeline(state.runId);
    if (!result.ok) {
      dispatch({ type: 'run/cancelFailed', error: result.error });
    }
  }, [state.runId]);

  const handleOpenFolder = useCallback(async () => {
    if (state.summary === undefined) return;
    await window.contentOs.openProjectFolder(state.summary.projectPath);
  }, [state.summary]);

  return (
    <div className="app">
      <header className="app__header">
        <h1 className="app__title">WORKAHOLIC Content OS</h1>
        <p className="app__subtitle">
          Premiereを開く前の準備を終わらせる解析ツール
        </p>
      </header>

      <main className="app__main">
        {screen === 'setup' ? (
          <SetupScreen
            onOpenProject={(summary) => {
              dispatch({ type: 'selection/succeeded', summary });
              setScreen('pipeline');
            }}
          />
        ) : screen === 'review' && state.summary !== undefined ? (
          <ReviewScreen
            summary={state.summary}
            onBack={() => setScreen('pipeline')}
          />
        ) : (
          <>
        <ErrorBanner state={state} />

        {state.phase === 'idle' && (
          <section className="card card--empty">
            <h2 className="card__title">プロジェクトが選択されていません</h2>
            <p className="card__lead">
              解析したい収録の <code>project.json</code> を選んでください。
              素材・話者・同期設定はこのファイルに記録されています。
            </p>
            <div className="card__actions card__actions--center">
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => setScreen('setup')}
              >
                プロジェクト一覧へ
              </button>
              <button type="button" className="btn btn--secondary" onClick={handleSelect}>
                project.json を直接選ぶ
              </button>
            </div>
          </section>
        )}

        {state.summary !== undefined && (
          <section className="card">
            <div className="card__head">
              <h2 className="card__title">{state.summary.name}</h2>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setScreen('setup')}
              >
                プロジェクト一覧へ
              </button>
            </div>

            <dl className="facts">
              <div className="facts__row">
                <dt>案件ID</dt>
                <dd>{state.summary.projectId}</dd>
              </div>
              <div className="facts__row">
                <dt>パス</dt>
                <dd className="facts__path">{state.summary.projectPath}</dd>
              </div>
              <div className="facts__row">
                <dt>ステータス</dt>
                <dd>{state.summary.status}</dd>
              </div>
              <div className="facts__row">
                <dt>登録素材数</dt>
                <dd>{state.summary.assetCount} 件</dd>
              </div>
              <div className="facts__row">
                <dt>最終更新</dt>
                <dd>{formatDateTime(state.summary.updatedAt)}</dd>
              </div>
            </dl>

            {state.summary.notes.length > 0 && (
              <ul className="notes">
                {state.summary.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            )}

            <div className="card__actions">
              {state.phase !== 'running' && (
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={handleStart}
                  disabled={!canStart(state)}
                >
                  {state.phase === 'finished' ? 'もう一度解析' : '解析開始'}
                </button>
              )}
              {state.phase !== 'running' && (
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => setScreen('review')}
                >
                  字幕を確認・修正
                </button>
              )}
              {state.phase === 'running' && (
                <button
                  type="button"
                  className="btn btn--danger"
                  onClick={handleCancel}
                  disabled={!canCancel(state)}
                >
                  {state.cancelling ? '中止しています…' : '解析を中止'}
                </button>
              )}
            </div>
          </section>
        )}

        {state.phase === 'running' && (
          <section className="card">
            <h2 className="card__title">解析中</h2>

            <div className="progress">
              <div className="progress__label">
                <span className="progress__step">
                  {state.progress?.stepLabel ?? '準備中'}
                </span>
                <span className="progress__count">
                  {state.progress
                    ? `${state.progress.stepIndex} / ${state.progress.stepCount} 工程`
                    : ''}
                </span>
              </div>

              <div className="bar">
                <div
                  className="bar__fill"
                  style={{ width: percent(state.progress?.overallRatio ?? 0) }}
                />
              </div>
              <div className="progress__meta">
                <span>全体 {percent(state.progress?.overallRatio ?? 0)}</span>
                <span>
                  工程内{' '}
                  {state.progress?.stepRatio !== undefined
                    ? percent(state.progress.stepRatio)
                    : '—'}
                </span>
                <span>
                  経過{' '}
                  {formatElapsed(
                    state.startedAt !== undefined ? now - state.startedAt : 0,
                  )}
                </span>
              </div>
              {state.progress?.message !== undefined && (
                <p className="progress__message">{state.progress.message}</p>
              )}
            </div>
          </section>
        )}

        {(state.phase === 'running' || state.phase === 'finished') && (
          <section className="card">
            <h2 className="card__title">工程</h2>
            <ol className="steps">
              {state.steps.map((step) => (
                <li key={step.stepId} className={`steps__item steps__item--${step.status}`}>
                  <span className="steps__dot" aria-hidden="true" />
                  <span className="steps__name">{STEP_LABELS[step.stepId]}</span>
                  <span className="steps__status">{step.status}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {state.warnings.length > 0 && (
          <section className="card card--warn">
            <h2 className="card__title">警告 {state.warnings.length} 件</h2>
            <ul className="notes">
              {state.warnings.map((warning, index) => (
                <li key={`${index}-${warning}`}>{warning}</li>
              ))}
            </ul>
          </section>
        )}

        {state.phase === 'finished' && state.result !== undefined && (
          <section className={`card card--result card--${state.outcome}`}>
            <h2 className="card__title">
              {state.outcome !== undefined ? OUTCOME_LABELS[state.outcome] : '完了'}
            </h2>

            <dl className="facts">
              <div className="facts__row">
                <dt>完了</dt>
                <dd>{state.result.counts.completed} 件</dd>
              </div>
              <div className="facts__row">
                <dt>警告</dt>
                <dd>{state.result.counts.warning} 件</dd>
              </div>
              <div className="facts__row">
                <dt>失敗</dt>
                <dd>{state.result.counts.failed} 件</dd>
              </div>
              <div className="facts__row">
                <dt>スキップ</dt>
                <dd>{state.result.counts.skipped} 件</dd>
              </div>
              <div className="facts__row">
                <dt>所要時間</dt>
                <dd>{formatElapsed(state.result.durationMs)}</dd>
              </div>
              <div className="facts__row">
                <dt>孤立した修正</dt>
                <dd>{state.result.orphanedCount} 件</dd>
              </div>
              <div className="facts__row">
                <dt>競合した修正</dt>
                <dd>{state.result.conflictedCount} 件</dd>
              </div>
            </dl>

            {state.result.outputFiles.length > 0 && (
              <>
                <h3 className="card__subtitle">成果物</h3>
                <ul className="files">
                  {state.result.outputFiles.map((file) => (
                    <li key={file}>
                      {shortenPath(file, state.summary?.projectPath ?? '')}
                    </li>
                  ))}
                </ul>
              </>
            )}

            <div className="card__actions">
              <button type="button" className="btn btn--secondary" onClick={handleOpenFolder}>
                プロジェクトフォルダを開く
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={handleStart}
                disabled={!canStart(state)}
              >
                もう一度解析
              </button>
            </div>
          </section>
        )}
          </>
        )}
      </main>
    </div>
  );
}
