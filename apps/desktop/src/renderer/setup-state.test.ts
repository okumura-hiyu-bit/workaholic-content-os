/**
 * プロジェクト一覧・新規作成・素材登録の状態遷移。
 */

import { describe, expect, it } from 'vitest';

import type { ProjectListEntry, SetupData } from '../shared/setup-dto.ts';
import {
  canCreate,
  canEditAssets,
  canStartAnalysis,
  emptyDraft,
  errorIssues,
  initialSetupState,
  reducer,
  rolesForSlot,
  warningIssues,
  type SetupState,
} from './setup-state.ts';

const TODAY = '2026-08-05';

function entry(overrides: Partial<ProjectListEntry> = {}): ProjectListEntry {
  return {
    projectPath: '/work/ep012',
    projectId: 'ep012',
    name: '第12回',
    recordedAt: '2026-08-05',
    status: '素材準備中',
    assetCount: 0,
    updatedAt: '2026-08-05T00:00:00.000Z',
    lastOpenedAt: '2026-08-05T00:00:00.000Z',
    missing: false,
    ...overrides,
  };
}

function setupData(overrides: Partial<SetupData> = {}): SetupData {
  return {
    projectPath: '/work/ep012',
    projectId: 'ep012',
    name: '第12回',
    status: '素材準備中',
    updatedAt: '2026-08-05T00:00:00.000Z',
    syncMode: 'preserve',
    speakers: [],
    assets: [],
    disabledAssets: [],
    issues: [],
    canAnalyze: true,
    analyzed: false,
    ...overrides,
  };
}

/** 一覧を読み終えた状態。 */
function listed(): SetupState {
  return reducer(initialSetupState(TODAY), { type: 'list/loaded', entries: [entry()] });
}

/** 入力が揃った新規作成フォーム。 */
function filledDraft(): SetupState {
  let state = reducer(listed(), { type: 'create/opened' });
  state = reducer(state, {
    type: 'create/changed',
    patch: { name: '第12回', parentDir: '/work' },
  });
  state = reducer(state, {
    type: 'create/speakerChanged',
    slot: 'A',
    patch: { name: '岸本' },
  });
  return reducer(state, {
    type: 'create/speakerChanged',
    slot: 'B',
    patch: { name: 'ゲスト' },
  });
}

/** 素材登録画面を開いた状態。 */
function assets(overrides: Partial<SetupData> = {}): SetupState {
  return reducer(listed(), { type: 'assets/loaded', data: setupData(overrides) });
}

describe('一覧', () => {
  it('初期状態は読み込み中', () => {
    expect(initialSetupState(TODAY).phase).toBe('list-loading');
  });

  it('読み込むと一覧になる', () => {
    const state = listed();
    expect(state.phase).toBe('list');
    expect(state.entries).toHaveLength(1);
  });

  it('読み込みに失敗したら failed', () => {
    const state = reducer(initialSetupState(TODAY), {
      type: 'list/failed',
      error: { code: 'UNKNOWN', userMessage: '読めません。', recoverable: true },
    });
    expect(state.phase).toBe('failed');
  });
});

describe('新規作成フォーム', () => {
  it('初期の下書きは今日の日付・preserve・出演者2名', () => {
    const draft = emptyDraft(TODAY);
    expect(draft.recordedAt).toBe(TODAY);
    expect(draft.syncMode).toBe('preserve');
    expect(draft.speakers.map((s) => s.slot)).toEqual(['A', 'B']);
  });

  it('★必須が埋まるまで作成できない', () => {
    let state = reducer(listed(), { type: 'create/opened' });
    expect(canCreate(state)).toBe(false);

    state = reducer(state, { type: 'create/changed', patch: { name: '第12回' } });
    expect(canCreate(state)).toBe(false); // 保存場所が未選択

    state = reducer(state, { type: 'create/changed', patch: { parentDir: '/work' } });
    expect(canCreate(state)).toBe(false); // 出演者名が空

    state = reducer(state, {
      type: 'create/speakerChanged',
      slot: 'A',
      patch: { name: '岸本' },
    });
    state = reducer(state, {
      type: 'create/speakerChanged',
      slot: 'B',
      patch: { name: 'ゲスト' },
    });
    expect(canCreate(state)).toBe(true);
  });

  it('★不正な日付では作成できない', () => {
    const state = reducer(filledDraft(), {
      type: 'create/changed',
      patch: { recordedAt: '2026/08/05' },
    });
    expect(canCreate(state)).toBe(false);
  });

  it('出演者を追加できる（最大3名）', () => {
    let state = reducer(filledDraft(), { type: 'create/speakerAdded' });
    expect(state.draft.speakers.map((s) => s.slot)).toEqual(['A', 'B', 'C']);

    // 4人目は増えない
    state = reducer(state, { type: 'create/speakerAdded' });
    expect(state.draft.speakers).toHaveLength(3);
  });

  it('出演者を減らせる（1名は必ず残る）', () => {
    let state = reducer(filledDraft(), { type: 'create/speakerRemoved', slot: 'B' });
    expect(state.draft.speakers.map((s) => s.slot)).toEqual(['A']);

    state = reducer(state, { type: 'create/speakerRemoved', slot: 'A' });
    expect(state.draft.speakers).toHaveLength(1);
  });

  it('★送信中は二重に送信できない', () => {
    const submitting = reducer(filledDraft(), { type: 'create/submitting' });
    expect(submitting.phase).toBe('creating');
    expect(canCreate(submitting)).toBe(false);
    expect(reducer(submitting, { type: 'create/submitting' })).toBe(submitting);
  });

  it('作成に失敗したら一覧へ戻り、エラーを出す', () => {
    let state = reducer(filledDraft(), { type: 'create/submitting' });
    state = reducer(state, {
      type: 'create/failed',
      error: { code: 'INVALID_REQUEST', userMessage: '保存できません。', recoverable: true },
    });
    expect(state.phase).toBe('list');
    expect(state.error?.userMessage).toBe('保存できません。');
  });

  it('出演者枠と役割が対応する', () => {
    expect(rolesForSlot('A')).toEqual(['cam_A', 'mic_A']);
    expect(rolesForSlot('C')).toEqual(['cam_C', 'mic_C']);
  });
});

describe('素材登録画面', () => {
  it('開くと編集できる', () => {
    const state = assets();
    expect(state.phase).toBe('assets');
    expect(canEditAssets(state)).toBe(true);
  });

  it('★保存中は編集できない（連打を止める）', () => {
    const saving = reducer(assets(), { type: 'assets/saving' });
    expect(saving.phase).toBe('saving');
    expect(canEditAssets(saving)).toBe(false);
    // 保存中に再度 saving を送っても変わらない
    expect(reducer(saving, { type: 'assets/saving' })).toBe(saving);
  });

  it('保存に成功すると内容が更新される', () => {
    let state = reducer(assets(), { type: 'assets/saving' });
    state = reducer(state, {
      type: 'assets/saved',
      data: setupData({ updatedAt: '2026-08-05T00:00:05.000Z' }),
      added: 2,
      skipped: ['dup.mp4（すでに登録されています）'],
    });

    expect(state.phase).toBe('assets');
    expect(state.data?.updatedAt).toBe('2026-08-05T00:00:05.000Z');
    expect(state.lastRegister).toEqual({
      added: 2,
      skipped: ['dup.mp4（すでに登録されています）'],
    });
  });

  it('★競合したら conflict になり、編集できない', () => {
    let state = reducer(assets(), { type: 'assets/saving' });
    state = reducer(state, {
      type: 'assets/conflicted',
      error: {
        code: 'PROJECT_CHANGED',
        userMessage: 'プロジェクトが別の処理で更新されました。再読み込みしてください',
        recoverable: true,
      },
    });

    expect(state.phase).toBe('conflict');
    expect(canEditAssets(state)).toBe(false);
    expect(canStartAnalysis(state)).toBe(false);
  });

  it('再読み込みで復帰する', () => {
    let state = reducer(assets(), { type: 'assets/saving' });
    state = reducer(state, {
      type: 'assets/conflicted',
      error: { code: 'PROJECT_CHANGED', userMessage: 'x', recoverable: true },
    });
    state = reducer(state, { type: 'assets/loaded', data: setupData() });
    expect(state.phase).toBe('assets');
    expect(state.error).toBeUndefined();
  });

  it('一覧へ戻ると読み込み直しになる', () => {
    const state = reducer(assets(), { type: 'assets/closed' });
    expect(state.phase).toBe('list-loading');
    expect(state.data).toBeUndefined();
  });
});

describe('解析への接続', () => {
  it('★必須不足があれば解析へ進めない', () => {
    const state = assets({
      canAnalyze: false,
      issues: [
        { severity: 'error', code: 'NO_WIDE', message: '基準映像がありません。' },
      ],
    });
    expect(canStartAnalysis(state)).toBe(false);
    expect(errorIssues(state.data)).toHaveLength(1);
  });

  it('★警告だけなら解析へ進める', () => {
    const state = assets({
      canAnalyze: true,
      issues: [
        { severity: 'warning', code: 'LOW_DISK', message: '空き容量が少なめです。' },
      ],
    });
    expect(canStartAnalysis(state)).toBe(true);
    expect(warningIssues(state.data)).toHaveLength(1);
    expect(errorIssues(state.data)).toHaveLength(0);
  });

  it('保存中は解析へ進めない', () => {
    const saving = reducer(assets(), { type: 'assets/saving' });
    expect(canStartAnalysis(saving)).toBe(false);
  });
});
