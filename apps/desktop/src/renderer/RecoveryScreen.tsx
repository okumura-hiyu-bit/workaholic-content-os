/**
 * 復旧画面（Recovery）。4画面を横断した「要確認」を1本の一覧で扱う。
 *
 * ★この画面が持つのは表示・付け替え・破棄まで。
 * 再出力は置かない。カメラ切替の整合性チェック（重なり・尺超過でXMLを壊さない）を
 * 迂回してしまうため、書き出しは各Review画面の責務のまま残す。
 *
 * ★Step 9 の `review-shared.tsx` をそのまま使う。
 * `SaveBadge` / `useReviewMedia` / `ReviewPlayer` / `usePipelineFinished` は
 * 4画面と同じものを共有している。この画面のために追加した部品は無い。
 */

import { useCallback, useEffect, useReducer, type JSX } from 'react';

import type { ProjectSummary } from '../shared/dto.ts';
import type {
  RecoveryDomain,
  RecoveryItem,
  RecoveryKind,
} from '../shared/recovery-dto.ts';
import { formatTimecode } from './format.ts';
import {
  ReviewPlayer,
  SaveBadge,
  useReviewMedia,
  usePipelineFinished,
} from './review-shared.tsx';
import {
  canDiscard,
  canReattach,
  initialRecoveryState,
  reducer,
  selectedItem,
  visibleIndexes,
  type RecoveryDomainFilter,
  type RecoveryKindFilter,
} from './recovery-state.ts';

/** ★対応表は画面が持つ（Main が持つのは項目ごとの文面）。 */
const DOMAIN_LABELS: Record<RecoveryDomain, string> = {
  subtitle: '字幕',
  short: 'ショート',
  cameraShot: 'カメラ',
  marker: 'マーカー',
};

const KIND_LABELS: Record<RecoveryKind, string> = {
  orphaned: '孤立',
  reattached: '繋ぎ直し',
  kindMismatch: '種別またぎ',
  rangeChanged: '区間変化',
  conflicted: '解析変化',
};

const DOMAIN_FILTERS: { value: RecoveryDomainFilter; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'subtitle', label: '字幕' },
  { value: 'short', label: 'ショート' },
  { value: 'cameraShot', label: 'カメラ' },
  { value: 'marker', label: 'マーカー' },
];

const KIND_FILTERS: { value: RecoveryKindFilter; label: string }[] = [
  { value: 'all', label: 'すべて' },
  { value: 'orphaned', label: '孤立' },
  { value: 'reattached', label: '繋ぎ直し' },
  { value: 'kindMismatch', label: '種別またぎ' },
  { value: 'rangeChanged', label: '区間変化' },
  { value: 'conflicted', label: '解析変化' },
];

/** 時刻を持たない項目（ショート・CHECK系）は「—」で示す。 */
function timeLabel(item: RecoveryItem): string {
  return item.approxSec === undefined ? '—' : formatTimecode(item.approxSec);
}

export function RecoveryScreen({
  summary,
  onBack,
}: {
  summary: ProjectSummary;
  onBack: () => void;
}): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialRecoveryState);
  const media = useReviewMedia(summary.projectPath);
  // ★`setMediaUrl` は恒久的に安定なので、依存に入れても `load` の同一性は
  //   案件が変わったときしか変わらない（＝完了イベントの購読は張り直されない）。
  const { setMediaUrl } = media;

  const load = useCallback(async () => {
    dispatch({ type: 'load/started' });
    const result = await window.contentOs.recoveryLoad(summary.projectPath);
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

  // ★再解析の完了で要確認の中身が変わる。既存の完了イベントに相乗りする。
  usePipelineFinished(() => {}, load);

  const item = selectedItem(state);

  /** 付け替え先の候補を取りに行く。★孤立のときだけ。 */
  const loadTargets = useCallback(
    async (target: RecoveryItem) => {
      dispatch({ type: 'targets/started' });
      const result = await window.contentOs.recoveryTargets({
        projectPath: summary.projectPath,
        domain: target.domain,
        sourceId: target.sourceId,
      });
      if (result.ok) dispatch({ type: 'targets/succeeded', targets: result.targets });
      else dispatch({ type: 'targets/failed', error: result.error });
    },
    [summary.projectPath],
  );

  // ★依存は `media` 全体ではなく `media.seek`。`seek` は恒久的に安定なので、
  //   この useCallback が毎レンダー作り直されない（4画面と同じ扱い）。
  const { seek } = media;
  const selectItem = useCallback(
    (index: number, target: RecoveryItem) => {
      dispatch({ type: 'item/selected', index });
      if (target.approxSec !== undefined) seek(target.approxSec);
      if (target.reattachable) void loadTargets(target);
    },
    [loadTargets, seek],
  );

  /** 保存結果の反映。★付け替え・破棄で共通。 */
  const applySaveResult = useCallback(
    (
      result: Awaited<ReturnType<typeof window.contentOs.recoveryDiscard>>,
    ): void => {
      if (result.ok) {
        dispatch({
          type: 'save/succeeded',
          updatedAt: result.updatedAt,
          items: result.items,
          counts: result.counts,
        });
      } else if (result.conflict === true) {
        dispatch({ type: 'save/conflicted', error: result.error });
      } else {
        dispatch({ type: 'save/failed', error: result.error });
      }
    },
    [],
  );

  const reattach = useCallback(async () => {
    if (!canReattach(state)) return;
    const current = selectedItem(state);
    if (current === undefined || state.selectedTargetId === undefined) return;
    if (state.updatedAt === undefined) return;

    dispatch({ type: 'save/started' });
    applySaveResult(
      await window.contentOs.recoveryReattach({
        projectPath: summary.projectPath,
        domain: current.domain,
        sourceId: current.sourceId,
        targetId: state.selectedTargetId,
        expectedUpdatedAt: state.updatedAt,
      }),
    );
  }, [state, summary.projectPath, applySaveResult]);

  const discard = useCallback(async () => {
    if (!canDiscard(state)) return;
    const current = selectedItem(state);
    if (current === undefined || state.updatedAt === undefined) return;

    dispatch({ type: 'save/started' });
    applySaveResult(
      await window.contentOs.recoveryDiscard({
        projectPath: summary.projectPath,
        domain: current.domain,
        sourceId: current.sourceId,
        expectedUpdatedAt: state.updatedAt,
      }),
    );
  }, [state, summary.projectPath, applySaveResult]);

  if (state.phase === 'loading') {
    return (
      <section className="card">
        <h2 className="card__title">要確認の一覧</h2>
        <p className="review__note">読み込んでいます…</p>
      </section>
    );
  }

  const data = state.data;
  if (data === undefined) {
    return (
      <section className="card">
        <h2 className="card__title">要確認の一覧</h2>
        {state.error !== undefined && (
          <div className="banner banner--error" role="alert">
            <p className="banner__message">{state.error.userMessage}</p>
            {state.error.suggestedAction !== undefined && (
              <p className="banner__action">{state.error.suggestedAction}</p>
            )}
          </div>
        )}
        <div className="card__actions">
          <button type="button" className="btn btn--secondary" onClick={onBack}>
            解析画面へ戻る
          </button>
        </div>
      </section>
    );
  }

  const indexes = visibleIndexes(data.items, state.domainFilter, state.kindFilter);

  return (
    <>
      <section className="card">
        <div className="card__head">
          <h2 className="card__title">要確認の一覧</h2>
          <SaveBadge state={state} />
        </div>
        <p className="review__note">
          {data.summary.name}：要確認 {data.counts.total} 件（うち付け替えで直せるもの{' '}
          {data.counts.reattachable} 件）
        </p>
        <p className="review__note">
          ★この画面は修復までを行います。成果物への反映は、修復のあと各確認画面の
          「再出力」で行ってください。
        </p>

        {state.error !== undefined && (
          <div className="banner banner--error" role="alert">
            <p className="banner__message">{state.error.userMessage}</p>
            {state.error.suggestedAction !== undefined && (
              <p className="banner__action">{state.error.suggestedAction}</p>
            )}
          </div>
        )}

        <div className="card__actions">
          <button type="button" className="btn btn--secondary" onClick={onBack}>
            解析画面へ戻る
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => void load()}
          >
            読み直す
          </button>
        </div>
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

      {/* ── 絞り込み ── */}
      <section className="card">
        <h3 className="card__subtitle">絞り込み</h3>
        <div className="filters">
          <span className="filters__label">対象</span>
          {DOMAIN_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`btn btn--chip${state.domainFilter === f.value ? ' btn--chip-active' : ''}`}
              onClick={() => dispatch({ type: 'domainFilter/changed', filter: f.value })}
            >
              {f.label}
              {f.value !== 'all' && ` ${data.counts.byDomain[f.value]}`}
            </button>
          ))}
        </div>
        <div className="filters">
          <span className="filters__label">種別</span>
          {KIND_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`btn btn--chip${state.kindFilter === f.value ? ' btn--chip-active' : ''}`}
              onClick={() => dispatch({ type: 'kindFilter/changed', filter: f.value })}
            >
              {f.label}
              {f.value !== 'all' && ` ${data.counts.byKind[f.value]}`}
            </button>
          ))}
        </div>
      </section>

      {/* ── 一覧 ── */}
      <section className="card">
        <h3 className="card__subtitle">
          該当 {indexes.length} 件 / 全 {data.items.length} 件
        </h3>

        {data.items.length === 0 && (
          <p className="review__note">
            要確認の項目はありません。4つの確認画面すべてで、修正はすべて対応先に
            繋がっています。
          </p>
        )}

        <ul className="cues recovery__list">
          {indexes.map((index) => {
            const row = data.items[index];
            if (row === undefined) return null;
            return (
              <li
                key={row.key}
                className={[
                  'cues__item',
                  state.selectedIndex === index ? 'cues__item--selected' : '',
                  row.kind === 'orphaned' ? 'cues__item--conflicted' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <button
                  type="button"
                  className="cues__button"
                  onClick={() => selectItem(index, row)}
                >
                  <span className="cues__tc">{timeLabel(row)}</span>
                  <span className="cues__text">
                    <span className="tag">{DOMAIN_LABELS[row.domain]}</span>{' '}
                    <span
                      className={
                        row.kind === 'orphaned' ? 'tag tag--conflict' : 'tag tag--warn'
                      }
                    >
                      {KIND_LABELS[row.kind]}
                    </span>{' '}
                    {row.headline}
                    {row.body !== undefined && (
                      <span className="attention__body"> {row.body}</span>
                    )}
                    {row.detail !== undefined && (
                      <span className="attention__reason">{row.detail}</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {/* ── 選択中の項目に対する操作 ── */}
      {item !== undefined && (
        <section className="card card--attention">
          <h3 className="card__subtitle">
            選択中：{DOMAIN_LABELS[item.domain]} / {KIND_LABELS[item.kind]}（
            {item.sourceId}）
          </h3>

          {item.reattachable ? (
            <>
              <p className="review__note">
                この修正はどの要素にも繋がっていません。付け替え先を選ぶと、その要素へ
                適用されます。
              </p>

              {state.targetsLoading && <p className="review__note">候補を探しています…</p>}

              {state.targets !== undefined && state.targets.length === 0 && (
                <p className="review__note">
                  付け替えできる要素がありません。この修正は破棄するしかありません。
                </p>
              )}

              {state.targets !== undefined && state.targets.length > 0 && (
                <ul className="cues recovery__targets">
                  {state.targets.map((t) => (
                    <li
                      key={t.id}
                      className={[
                        'cues__item',
                        state.selectedTargetId === t.id ? 'cues__item--selected' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <button
                        type="button"
                        className="cues__button"
                        disabled={t.occupied}
                        onClick={() => {
                          dispatch({ type: 'target/selected', targetId: t.id });
                          seek(t.startSec);
                        }}
                      >
                        <span className="cues__tc">{formatTimecode(t.startSec)}</span>
                        <span className="cues__text">
                          {t.label}
                          {t.deltaSec !== undefined && (
                            <span className="attention__reason">
                              元の位置から {t.deltaSec.toFixed(2)} 秒
                            </span>
                          )}
                          {t.occupied && (
                            <span className="attention__reason">
                              ★この要素には既に別の修正が付いているため選べません。
                              先にそちらを取り消してください。
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="review__note">
              この修正は既にどこかの要素へ適用されています。意図と違っていた場合は、
              修正を破棄すると解析結果の値に戻ります。
            </p>
          )}

          <div className="card__actions">
            {item.reattachable && (
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void reattach()}
                disabled={!canReattach(state)}
              >
                この要素に付け替える
              </button>
            )}
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => void discard()}
              disabled={!canDiscard(state)}
            >
              修正を破棄する
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => dispatch({ type: 'item/deselected' })}
            >
              選択を解除
            </button>
          </div>
        </section>
      )}
    </>
  );
}
