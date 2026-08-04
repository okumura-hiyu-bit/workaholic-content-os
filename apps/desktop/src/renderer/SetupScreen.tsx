/**
 * プロジェクト一覧・新規作成・素材登録。
 *
 * ★実運用の入口。
 * 新規案件を作る → 素材を登録する → 役割を決める → 解析へ進む、までを担う。
 *
 * ★Rendererは素材の絶対パスを持たない。
 * 登録はファイル選択ダイアログ（Main）か、ドロップしたFileをPreloadへ渡す形だけ。
 */

import { useCallback, useEffect, useReducer, useState, type JSX } from 'react';

import type { ProjectSummary } from '../shared/dto.ts';
import {
  ASSET_ROLE_IDS,
  ASSET_ROLE_LABELS,
  type AssetDto,
  type AssetRoleId,
  type SetupIssue,
} from '../shared/setup-dto.ts';
import { formatDateTime, formatElapsed } from './format.ts';
import {
  canCreate,
  canStartAnalysis,
  emptyDraft,
  errorIssues,
  initialSetupState,
  reducer,
  warningIssues,
  type SetupState,
} from './setup-state.ts';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return '—';
  if (bytes > 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

function IssueList({ issues }: { issues: SetupIssue[] }): JSX.Element | null {
  if (issues.length === 0) return null;
  return (
    <>
      {issues.map((issue, i) => (
        <div key={`${issue.code}-${i}`} className="attention">
          <span
            className={`attention__tag attention__tag--${
              issue.severity === 'error' ? 'conflict' : 'warn'
            }`}
          >
            {issue.severity === 'error' ? '必須' : '注意'}
          </span>
          <span className="attention__body">
            {issue.message}
            {issue.suggestedAction !== undefined && (
              <span className="attention__reason">{issue.suggestedAction}</span>
            )}
          </span>
        </div>
      ))}
    </>
  );
}

function AssetRow({
  asset,
  disabled,
  onRole,
  onEnabled,
  onRemove,
}: {
  asset: AssetDto;
  disabled: boolean;
  onRole: (role: AssetRoleId) => void;
  onEnabled: (enabled: boolean) => void;
  onRemove: () => void;
}): JSX.Element {
  return (
    <li className={`assets__item ${asset.roleConfirmed ? '' : 'assets__item--unconfirmed'}`}>
      <div className="assets__head">
        <span className="assets__name">{asset.fileName}</span>
        <span className="assets__dir">{asset.directoryName}</span>
        {asset.mainAudio && <span className="tag tag--edited">メイン音声</span>}
        {!asset.roleConfirmed && <span className="tag tag--conflict">役割 未確定</span>}
      </div>

      <div className="assets__controls">
        <label className="assets__field">
          <span className="field__label">役割</span>
          <select
            className="field__input"
            value={asset.role}
            disabled={disabled}
            onChange={(e) => onRole(e.currentTarget.value as AssetRoleId)}
          >
            {ASSET_ROLE_IDS.map((role) => (
              <option key={role} value={role}>
                {ASSET_ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </label>

        <label className="assets__toggle">
          <input
            type="checkbox"
            checked={asset.enabled}
            disabled={disabled}
            onChange={(e) => onEnabled(e.currentTarget.checked)}
          />
          解析に使う
        </label>

        <button
          type="button"
          className="btn btn--ghost"
          disabled={disabled}
          onClick={onRemove}
        >
          登録から外す
        </button>
      </div>

      <dl className="assets__meta">
        <div><dt>出演者</dt><dd>{asset.speakerSlot ?? '—'}</dd></div>
        <div><dt>尺</dt><dd>{formatElapsed(asset.durationSec * 1000)}</dd></div>
        <div>
          <dt>解像度</dt>
          <dd>{asset.width && asset.height ? `${asset.width}×${asset.height}` : '—'}</dd>
        </div>
        <div><dt>fps</dt><dd>{asset.fps ? asset.fps.toFixed(2) : '—'}</dd></div>
        <div><dt>音声</dt><dd>{asset.hasAudio ? `${asset.audioChannels ?? '?'}ch` : 'なし'}</dd></div>
        <div>
          <dt>サンプルレート</dt>
          <dd>{asset.audioSampleRate ? `${asset.audioSampleRate} Hz` : '—'}</dd>
        </div>
        <div><dt>サイズ</dt><dd>{formatSize(asset.sizeBytes)}</dd></div>
      </dl>
    </li>
  );
}

export function SetupScreen({
  onOpenProject,
}: {
  onOpenProject: (summary: ProjectSummary) => void;
}): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialSetupState(today()));
  const [dragging, setDragging] = useState(false);

  const loadList = useCallback(async () => {
    dispatch({ type: 'list/loading' });
    const result = await window.contentOs.listProjects();
    if (result.ok) dispatch({ type: 'list/loaded', entries: result.entries });
    else dispatch({ type: 'list/failed', error: result.error });
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openProject = useCallback(async (projectPath: string) => {
    dispatch({ type: 'assets/loading' });
    const result = await window.contentOs.loadSetup(projectPath);
    if (result.ok) dispatch({ type: 'assets/loaded', data: result.data });
    else dispatch({ type: 'assets/failed', error: result.error });
  }, []);

  const applySave = useCallback(
    (result: Awaited<ReturnType<typeof window.contentOs.updateAsset>>) => {
      if (result.ok) {
        dispatch({
          type: 'assets/saved',
          data: result.data,
          ...(result.added !== undefined ? { added: result.added } : {}),
          ...(result.skipped !== undefined ? { skipped: result.skipped } : {}),
        });
      } else if (result.conflict === true) {
        dispatch({ type: 'assets/conflicted', error: result.error });
      } else {
        dispatch({ type: 'assets/failed', error: result.error });
      }
    },
    [],
  );

  const chooseDir = useCallback(async () => {
    const dir = await window.contentOs.chooseParentDir();
    if (dir !== undefined) dispatch({ type: 'create/changed', patch: { parentDir: dir } });
  }, []);

  const submitCreate = useCallback(async () => {
    if (!canCreate(state)) return;
    dispatch({ type: 'create/submitting' });
    const d = state.draft;
    const result = await window.contentOs.createProject({
      name: d.name,
      recordedAt: d.recordedAt,
      ...(d.programName.trim().length > 0 ? { programName: d.programName } : {}),
      parentDir: d.parentDir!,
      syncMode: d.syncMode,
      speakers: d.speakers.map((s) => ({ slot: s.slot, name: s.name, role: s.role })),
    });
    if (result.ok) {
      dispatch({ type: 'create/closed' });
      dispatch({ type: 'create/changed', patch: emptyDraft(today()) });
      await openProject(result.entry.projectPath);
    } else {
      dispatch({ type: 'create/failed', error: result.error });
    }
  }, [state, openProject]);

  const addFiles = useCallback(async () => {
    if (state.data === undefined) return;
    dispatch({ type: 'assets/saving' });
    applySave(
      await window.contentOs.chooseAssetFiles(
        state.data.projectPath,
        state.data.updatedAt,
      ),
    );
  }, [state.data, applySave]);

  const handleDrop = useCallback(
    async (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      if (state.data === undefined) return;
      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) return;
      dispatch({ type: 'assets/saving' });
      applySave(
        await window.contentOs.registerDroppedAssets(
          state.data.projectPath,
          state.data.updatedAt,
          files,
        ),
      );
    },
    [state.data, applySave],
  );

  const changeRole = useCallback(
    async (assetId: string, role: AssetRoleId) => {
      if (state.data === undefined) return;
      dispatch({ type: 'assets/saving' });
      applySave(
        await window.contentOs.updateAsset({
          projectPath: state.data.projectPath,
          expectedUpdatedAt: state.data.updatedAt,
          assetId,
          patch: { role },
        }),
      );
    },
    [state.data, applySave],
  );

  const changeEnabled = useCallback(
    async (assetId: string, enabled: boolean) => {
      if (state.data === undefined) return;
      dispatch({ type: 'assets/saving' });
      applySave(
        await window.contentOs.updateAsset({
          projectPath: state.data.projectPath,
          expectedUpdatedAt: state.data.updatedAt,
          assetId,
          patch: { enabled },
        }),
      );
    },
    [state.data, applySave],
  );

  const removeAsset = useCallback(
    async (assetId: string) => {
      if (state.data === undefined) return;
      dispatch({ type: 'assets/saving' });
      applySave(
        await window.contentOs.removeAsset({
          projectPath: state.data.projectPath,
          expectedUpdatedAt: state.data.updatedAt,
          assetId,
        }),
      );
    },
    [state.data, applySave],
  );

  const goAnalyze = useCallback(async () => {
    if (state.data === undefined) return;
    const summary = await window.contentOs.readProjectSummary(state.data.projectPath);
    if (summary.ok) onOpenProject(summary.summary);
  }, [state.data, onOpenProject]);

  // ─── 素材登録画面 ──────────────────────────────────

  if (state.data !== undefined) {
    const data = state.data;
    const busy = state.phase === 'saving' || state.phase === 'conflict';
    const errors = errorIssues(data);
    const warnings = warningIssues(data);

    return (
      <div className="review">
        <section className="card">
          <div className="card__head">
            <div>
              <h2 className="card__title">{data.name}</h2>
              <p className="review__meta">
                収録日 {data.recordedAt ?? '—'} ／ 番組 {data.programName ?? '—'} ／
                ステータス {data.status} ／ 同期 {data.syncMode}
              </p>
            </div>
            <button
              type="button"
              className="btn btn--ghost"
              onClick={() => {
                dispatch({ type: 'assets/closed' });
                void loadList();
              }}
            >
              一覧へ戻る
            </button>
          </div>

          <div className="stats">
            <div className="stat">
              <span className="stat__label">登録素材</span>
              <span className="stat__value">{data.assets.length}</span>
            </div>
            <div className="stat">
              <span className="stat__label">解析に使わない</span>
              <span className="stat__value">{data.disabledAssets.length}</span>
            </div>
            <div className="stat">
              <span className="stat__label">必須の不足</span>
              <span className="stat__value stat__value--warn">{errors.length}</span>
            </div>
            <div className="stat">
              <span className="stat__label">注意</span>
              <span className="stat__value">{warnings.length}</span>
            </div>
          </div>

          {state.phase === 'conflict' && (
            <div className="banner banner--error" role="alert">
              <p className="banner__message">{state.error?.userMessage}</p>
              <div className="card__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  onClick={() => void openProject(data.projectPath)}
                >
                  再読み込み
                </button>
              </div>
            </div>
          )}
          {state.phase !== 'conflict' && state.error !== undefined && (
            <div className="banner banner--error" role="alert">
              <p className="banner__message">{state.error.userMessage}</p>
            </div>
          )}
        </section>

        <section className="card">
          <h3 className="card__subtitle">出演者</h3>
          <ul className="notes">
            {data.speakers.map((s) => (
              <li key={s.slot}>
                {s.slot}：{s.name}（{s.role === 'host' ? 'ホスト' : 'ゲスト'}）
                ／ マイク {s.micRegistered ? '登録済み' : '未登録'}
                ／ カメラ {s.cameraRegistered ? '登録済み' : '未登録'}
              </li>
            ))}
          </ul>
        </section>

        <section
          className={`card dropzone ${dragging ? 'dropzone--active' : ''}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => void handleDrop(e)}
        >
          <h3 className="card__subtitle">素材を登録</h3>
          <p className="review__note">
            ここにファイルをドラッグ＆ドロップするか、ボタンから選んでください。
            元のファイルは移動もコピーもしません（場所を覚えるだけです）。
          </p>
          <div className="card__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy}
              onClick={() => void addFiles()}
            >
              ファイルを選ぶ
            </button>
            {state.lastRegister !== undefined && (
              <span className="review__note">
                {state.lastRegister.added} 件を登録しました
                {state.lastRegister.skipped.length > 0 &&
                  `／${state.lastRegister.skipped.length} 件はスキップ`}
              </span>
            )}
          </div>
          {state.lastRegister !== undefined && state.lastRegister.skipped.length > 0 && (
            <ul className="notes">
              {state.lastRegister.skipped.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          )}
        </section>

        {(errors.length > 0 || warnings.length > 0) && (
          <section className="card card--attention">
            <h3 className="card__subtitle">
              解析前の確認：必須 {errors.length} 件 / 注意 {warnings.length} 件
            </h3>
            <IssueList issues={errors} />
            <IssueList issues={warnings} />
          </section>
        )}

        <section className="card">
          <h3 className="card__subtitle">登録した素材（{data.assets.length}）</h3>
          {data.assets.length === 0 ? (
            <p className="review__note">まだ登録されていません。</p>
          ) : (
            <ul className="assets">
              {data.assets.map((asset) => (
                <AssetRow
                  key={asset.id}
                  asset={asset}
                  disabled={busy}
                  onRole={(role) => void changeRole(asset.id, role)}
                  onEnabled={(enabled) => void changeEnabled(asset.id, enabled)}
                  onRemove={() => void removeAsset(asset.id)}
                />
              ))}
            </ul>
          )}
        </section>

        {data.disabledAssets.length > 0 && (
          <section className="card">
            <h3 className="card__subtitle">
              解析に使わない素材（{data.disabledAssets.length}）
            </h3>
            <ul className="assets">
              {data.disabledAssets.map((asset) => (
                <AssetRow
                  key={asset.id}
                  asset={asset}
                  disabled={busy}
                  onRole={(role) => void changeRole(asset.id, role)}
                  onEnabled={(enabled) => void changeEnabled(asset.id, enabled)}
                  onRemove={() => void removeAsset(asset.id)}
                />
              ))}
            </ul>
          </section>
        )}

        <section className="card">
          <h3 className="card__subtitle">解析へ進む</h3>
          {!canStartAnalysis(state) && (
            <p className="review__note review__note--danger">
              必須の不足が {errors.length} 件あります。解決すると解析へ進めます。
            </p>
          )}
          <div className="card__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canStartAnalysis(state)}
              onClick={() => void goAnalyze()}
            >
              解析画面へ進む
            </button>
          </div>
        </section>
      </div>
    );
  }

  // ─── 一覧・新規作成 ────────────────────────────────

  return (
    <div className="review">
      {state.error !== undefined && (
        <div className="banner banner--error" role="alert">
          <p className="banner__message">{state.error.userMessage}</p>
          {state.error.suggestedAction !== undefined && (
            <p className="banner__action">{state.error.suggestedAction}</p>
          )}
        </div>
      )}

      <section className="card">
        <div className="card__head">
          <h2 className="card__title">プロジェクト</h2>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => dispatch({ type: state.creating ? 'create/closed' : 'create/opened' })}
          >
            {state.creating ? '作成をやめる' : '新規プロジェクト'}
          </button>
        </div>

        {state.phase === 'list-loading' && <p className="review__note">読み込んでいます…</p>}

        {state.phase !== 'list-loading' && state.entries.length === 0 && (
          <p className="review__note">
            まだプロジェクトがありません。「新規プロジェクト」から始めてください。
          </p>
        )}

        {state.entries.length > 0 && (
          <ul className="projects">
            {state.entries.map((entry) => (
              <li
                key={entry.projectPath}
                className={`projects__item ${entry.missing ? 'projects__item--missing' : ''}`}
              >
                <button
                  type="button"
                  className="projects__button"
                  disabled={entry.missing}
                  onClick={() => void openProject(entry.projectPath)}
                >
                  <span className="projects__name">{entry.name}</span>
                  <span className="projects__meta">
                    {entry.recordedAt ?? '—'} ／ {entry.status} ／ 素材{entry.assetCount}件
                  </span>
                  <span className="projects__updated">
                    更新 {formatDateTime(entry.updatedAt)}
                  </span>
                </button>
                {entry.missing && (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={async () => {
                      const result = await window.contentOs.forgetProject(entry.projectPath);
                      if (result.ok) dispatch({ type: 'list/loaded', entries: result.entries });
                    }}
                  >
                    一覧から外す
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {state.creating && (
        <section className="card">
          <h3 className="card__subtitle">新規プロジェクト</h3>

          <label className="field">
            <span className="field__label">案件名（必須）</span>
            <input
              className="field__input"
              value={state.draft.name}
              onChange={(e) =>
                dispatch({ type: 'create/changed', patch: { name: e.currentTarget.value } })
              }
            />
          </label>

          <label className="field">
            <span className="field__label">収録日（必須）</span>
            <input
              className="field__input"
              type="date"
              value={state.draft.recordedAt}
              onChange={(e) =>
                dispatch({
                  type: 'create/changed',
                  patch: { recordedAt: e.currentTarget.value },
                })
              }
            />
          </label>

          <label className="field">
            <span className="field__label">番組名</span>
            <input
              className="field__input"
              value={state.draft.programName}
              onChange={(e) =>
                dispatch({
                  type: 'create/changed',
                  patch: { programName: e.currentTarget.value },
                })
              }
            />
          </label>

          <label className="field">
            <span className="field__label">同期モード</span>
            <select
              className="field__input"
              value={state.draft.syncMode}
              onChange={(e) =>
                dispatch({
                  type: 'create/changed',
                  patch: { syncMode: e.currentTarget.value as 'preserve' | 'common' },
                })
              }
            >
              <option value="preserve">preserve（各素材の頭を保つ）</option>
              <option value="common">common（共通区間に揃える）</option>
            </select>
          </label>

          <div className="field">
            <span className="field__label">出演者（必須）</span>
            {state.draft.speakers.map((s) => (
              <div key={s.slot} className="speaker-row">
                <span className="speaker-row__slot">{s.slot}</span>
                <input
                  className="field__input"
                  placeholder="お名前"
                  value={s.name}
                  onChange={(e) =>
                    dispatch({
                      type: 'create/speakerChanged',
                      slot: s.slot,
                      patch: { name: e.currentTarget.value },
                    })
                  }
                />
                <select
                  className="field__input"
                  value={s.role}
                  onChange={(e) =>
                    dispatch({
                      type: 'create/speakerChanged',
                      slot: s.slot,
                      patch: { role: e.currentTarget.value as 'host' | 'guest' },
                    })
                  }
                >
                  <option value="host">ホスト</option>
                  <option value="guest">ゲスト</option>
                </select>
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => dispatch({ type: 'create/speakerRemoved', slot: s.slot })}
                >
                  削除
                </button>
              </div>
            ))}
            {state.draft.speakers.length < 3 && (
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => dispatch({ type: 'create/speakerAdded' })}
              >
                出演者を追加
              </button>
            )}
            <p className="review__note">
              出演者の記号（A / B / C）が、素材の役割（mic_A・cam_A）と対応します。
            </p>
          </div>

          <label className="field">
            <span className="field__label">保存場所（必須）</span>
            <div className="card__actions">
              <button type="button" className="btn btn--secondary" onClick={() => void chooseDir()}>
                フォルダを選ぶ
              </button>
              <span className="review__note">
                {state.draft.parentDir ?? '未選択'}
              </span>
            </div>
          </label>

          <div className="card__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={!canCreate(state)}
              onClick={() => void submitCreate()}
            >
              {state.phase === 'creating' ? '作成中…' : 'プロジェクトを作成'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

export type { SetupState };
