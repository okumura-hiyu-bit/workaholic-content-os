/**
 * 確認画面のデータ組み立てと字幕修正の保存。
 *
 * ★このテストの主眼は「analysis が変わらないこと」。
 * 人間の修正が edits にだけ入り、再解析で消えないことを固定する。
 * ffmpeg / faster-whisper は起動しない。
 */

import { describe, expect, it } from 'vitest';

import {
  applySubtitleEdit,
  buildReviewData,
  detectSubtitleConflicts,
  duplicateSubtitleIds,
  removeSubtitleEdit,
  type ProjectLike,
} from './review.ts';
import {
  createFakeStore,
  projectFixture,
  subtitleFixture,
} from './testing/fake-core.ts';

const DIR = '/tmp/ep012';
const FIRST = 'sub-00000000';
const SECOND = 'sub-00002500';

function setup(project: ProjectLike = projectFixture()) {
  const store = createFakeStore({ [DIR]: project });
  return store;
}

function loadOk(store: ReturnType<typeof setup>) {
  const result = buildReviewData(DIR, store.deps);
  if (!result.ok) throw new Error(`load failed: ${result.error.userMessage}`);
  return result.data;
}

describe('Reviewデータの読み込み', () => {
  it('★字幕・話者・件数を返す', () => {
    const data = loadOk(setup());

    expect(data.subtitles).toHaveLength(3);
    expect(data.speakers.map((s) => s.id)).toEqual(['spk_a', 'spk_b']);
    expect(data.counts.cues).toBe(3);
    expect(data.summary.projectId).toBe('ep012');
    expect(data.updatedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('★低confidence語を表示用に返す', () => {
    const data = loadOk(setup());
    const first = data.subtitles[0]!;

    expect(first.lowConfidenceWords).toEqual([
      { text: 'こんばんは', probability: 0.41 },
    ]);
    expect(first.minProbability).toBeCloseTo(0.41);
    expect(data.counts.lowConfidenceWords).toBe(2);
  });

  it('低confidence語が無いキューは minProbability を持たない', () => {
    const data = loadOk(setup());
    expect(data.subtitles[1]!.lowConfidenceWords).toEqual([]);
    expect(data.subtitles[1]!.minProbability).toBeUndefined();
  });

  it('★Project全体を返さない（解析の内部データを載せない）', () => {
    const data = loadOk(setup());
    const serialized = JSON.stringify(data);

    expect(serialized).not.toContain('"pipeline"');
    expect(serialized).not.toContain('"apiUsage"');
    expect(serialized).not.toContain('absolutePath');
    expect(serialized).not.toContain('/tmp/ep012/raw');
    expect('edits' in data).toBe(false);
    expect('analysis' in data).toBe(false);
  });

  it('★タイムコード編集が未対応であることを明示する', () => {
    expect(loadOk(setup()).timecodeEditingSupported).toBe(false);
  });

  it('構造化クローンで送れる', () => {
    expect(() => structuredClone(loadOk(setup()))).not.toThrow();
  });

  it('解析前のプロジェクトは読み込めない（理由を返す）', () => {
    const project = projectFixture();
    delete project.analysis;
    const result = buildReviewData(DIR, setup(project).deps);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('ANALYSIS_NOT_READY');
  });

  it('壊れたプロジェクトは読み込めない', () => {
    const store = createFakeStore({});
    const result = buildReviewData('/tmp/none', store.deps);
    expect(result.ok).toBe(false);
  });
});

describe('字幕本文の修正', () => {
  it('★修正が保存され、再読込しても残る', () => {
    const store = setup();
    const data = loadOk(store);

    const saved = applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: data.updatedAt,
        patch: { text: 'こんばんは、ワーカホリックです' },
      },
      store.deps,
    );

    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.cue.text).toBe('こんばんは、ワーカホリックです');
    expect(saved.cue.edited).toBe(true);

    // 読み直しても残っている
    const reloaded = loadOk(store);
    expect(reloaded.subtitles[0]!.text).toBe('こんばんは、ワーカホリックです');
    expect(reloaded.subtitles[0]!.edited).toBe(true);
    expect(reloaded.counts.edited).toBe(1);
  });

  it('★edits だけが変わり、analysis は変わらない', () => {
    const store = setup();
    const before = structuredClone(store.read(DIR).analysis);

    applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { text: '書き換えた本文' },
      },
      store.deps,
    );

    const after = store.read(DIR);
    // ★解析レイヤーは1バイトも変わらない
    expect(after.analysis).toEqual(before);
    // 修正は edits にだけ入る
    expect(after.edits.subtitles[FIRST]).toEqual({ text: '書き換えた本文' });
  });

  it('★履歴に変更前の値が残る', () => {
    const store = setup();
    applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { text: '直した' },
      },
      store.deps,
    );

    const history = store.read(DIR).edits.history;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      kind: 'subtitle',
      targetId: FIRST,
      field: 'text',
      before: 'こんばんは',
      after: '直した',
    });
  });

  it('同じ内容で保存しても履歴を増やさない', () => {
    const store = setup();
    applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { text: 'こんばんは' },
      },
      store.deps,
    );
    expect(store.read(DIR).edits.history).toHaveLength(0);
  });

  it('複数行の本文を保存できる', () => {
    const store = setup();
    const saved = applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { text: '1行目\n2行目' },
      },
      store.deps,
    );
    expect(saved.ok && saved.cue.text).toBe('1行目\n2行目');
  });
});

describe('話者の修正', () => {
  it('★話者を変更できる', () => {
    const store = setup();
    const saved = applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { speakerId: 'spk_b' },
      },
      store.deps,
    );

    expect(saved.ok && saved.cue.speakerId).toBe('spk_b');
    expect(store.read(DIR).edits.subtitles[FIRST]).toEqual({ speakerId: 'spk_b' });
    // ★解析側の話者は変わらない
    expect(store.read(DIR).analysis!.subtitles[0]!.speakerId).toBe('spk_a');
  });

  it('本文と話者を同時に修正できる', () => {
    const store = setup();
    const saved = applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: SECOND,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { text: 'よろしくお願いいたします', speakerId: 'spk_a' },
      },
      store.deps,
    );
    expect(saved.ok).toBe(true);
    expect(store.read(DIR).edits.subtitles[SECOND]).toEqual({
      text: 'よろしくお願いいたします',
      speakerId: 'spk_a',
    });
  });
});

describe('修正の取り消し', () => {
  it('解析結果の値に戻る', () => {
    const store = setup();
    applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { text: '直した' },
      },
      store.deps,
    );

    const removed = removeSubtitleEdit(
      { projectPath: DIR, subtitleId: FIRST, expectedUpdatedAt: loadOk(store).updatedAt },
      store.deps,
    );

    expect(removed.ok).toBe(true);
    expect(removed.ok && removed.cue.text).toBe('こんばんは');
    expect(removed.ok && removed.cue.edited).toBe(false);
    expect(store.read(DIR).edits.subtitles[FIRST]).toBeUndefined();
    // 取り消した記録も履歴に残る
    expect(store.read(DIR).edits.history.at(-1)).toMatchObject({ field: 'removed' });
  });

  it('修正が無いキューの取り消しは拒否する', () => {
    const store = setup();
    const result = removeSubtitleEdit(
      { projectPath: DIR, subtitleId: SECOND, expectedUpdatedAt: loadOk(store).updatedAt },
      store.deps,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('SUBTITLE_NOT_FOUND');
  });
});

describe('再解析との関係', () => {
  it('★再解析で解析結果が差し替わっても人間の修正は残る', () => {
    const store = setup();
    applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { text: '人が直した本文' },
      },
      store.deps,
    );

    // 再解析：analysis を丸ごと差し替える（run-pipeline と同じ扱い）。
    const project = store.read(DIR);
    const reanalyzed: ProjectLike = {
      ...project,
      analysis: {
        subtitles: [
          subtitleFixture(0, 2.5, ['こんばんわ'], { speakerId: 'spk_a' }),
          subtitleFixture(2.5, 5, ['よろしくおねがいします'], { speakerId: 'spk_b' }),
          subtitleFixture(5, 8.25, ['本日のテーマは'], { speakerId: 'spk_a' }),
        ],
      },
    };
    store.deps.saveProject(DIR, reanalyzed);

    const data = loadOk(store);
    // ★人間の修正が勝つ
    expect(data.subtitles[0]!.text).toBe('人が直した本文');
    expect(data.subtitles[0]!.edited).toBe(true);
    // 解析側の値も参照できる
    expect(data.subtitles[0]!.analysisText).toBe('こんばんわ');
  });

  it('★時刻がずれても再接続され、修正が消えない', () => {
    const store = setup();
    applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { text: '人が直した本文' },
      },
      store.deps,
    );

    // 開始が 0.000 → 0.200 にずれる（許容範囲0.5秒以内）
    const project = store.read(DIR);
    store.deps.saveProject(DIR, {
      ...project,
      analysis: {
        subtitles: [
          subtitleFixture(0.2, 2.5, ['こんばんは'], { speakerId: 'spk_a' }),
          ...project.analysis!.subtitles.slice(1),
        ],
      },
    });

    const data = loadOk(store);
    expect(data.subtitles[0]!.text).toBe('人が直した本文');
    expect(data.counts.orphaned).toBe(0);
  });

  it('★繋がらなかった修正は孤立として内容ごと報告する（黙って捨てない）', () => {
    const store = setup();
    applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { text: '失われては困る修正' },
      },
      store.deps,
    );

    // 該当キューが大きく移動する（許容範囲外）
    const project = store.read(DIR);
    store.deps.saveProject(DIR, {
      ...project,
      analysis: {
        subtitles: [
          subtitleFixture(30, 32, ['まったく別の位置'], { speakerId: 'spk_a' }),
        ],
      },
    });

    const data = loadOk(store);
    expect(data.counts.orphaned).toBe(1);
    const orphan = data.orphaned[0]!;
    expect(orphan.originalId).toBe(FIRST);
    // ★内容が残っている
    expect(orphan.text).toBe('失われては困る修正');
    expect(orphan.reason.length).toBeGreaterThan(0);
  });
});

describe('競合の検出', () => {
  it('★修正後に解析結果が変わったら競合として表示する', () => {
    const store = setup();
    applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { text: '人が直した本文' },
      },
      store.deps,
    );

    const project = store.read(DIR);
    store.deps.saveProject(DIR, {
      ...project,
      analysis: {
        subtitles: [
          subtitleFixture(0, 2.5, ['AIが出し直した本文'], { speakerId: 'spk_a' }),
          ...project.analysis!.subtitles.slice(1),
        ],
      },
    });

    const data = loadOk(store);
    expect(data.counts.conflicted).toBe(1);
    expect(data.subtitles[0]!.conflicted).toBe(true);
    expect(data.conflicted[0]).toMatchObject({
      subtitleId: FIRST,
      humanText: '人が直した本文',
      previousAnalysisText: 'こんばんは',
      currentAnalysisText: 'AIが出し直した本文',
    });
  });

  it('解析が変わっていなければ競合にしない', () => {
    const store = setup();
    applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { text: '直した' },
      },
      store.deps,
    );
    expect(loadOk(store).counts.conflicted).toBe(0);
  });

  it('履歴が無い修正は競合と判定しない', () => {
    const project = projectFixture();
    project.edits.subtitles[FIRST] = { text: '外から入った修正' };
    const conflicts = detectSubtitleConflicts(
      project.analysis!.subtitles,
      project.edits,
    );
    expect(conflicts).toHaveLength(0);
  });
});

describe('競合更新（expectedUpdatedAt）', () => {
  it('★食い違えば上書きせず競合を返す', () => {
    const store = setup();
    const data = loadOk(store);
    store.touchExternally(DIR); // 別の処理が更新した

    const result = applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: data.updatedAt,
        patch: { text: '上書きされてはいけない' },
      },
      store.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.conflict).toBe(true);
    expect(result.ok === false && result.error.userMessage).toBe(
      'プロジェクトが別の処理で更新されました。再読み込みしてください',
    );
    // ★書き込まれていない
    expect(store.read(DIR).edits.subtitles[FIRST]).toBeUndefined();
    expect(store.saveCount()).toBe(0);
  });

  it('★取り消しでも競合を検出する', () => {
    const store = setup();
    const data = loadOk(store);
    store.touchExternally(DIR);

    const result = removeSubtitleEdit(
      { projectPath: DIR, subtitleId: FIRST, expectedUpdatedAt: data.updatedAt },
      store.deps,
    );
    expect(result.ok === false && result.conflict).toBe(true);
  });

  it('★保存のたびに updatedAt が変わる（古い値での連続保存を防ぐ）', () => {
    const store = setup();
    const first = loadOk(store).updatedAt;

    const saved = applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: first,
        patch: { text: '1回目' },
      },
      store.deps,
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.updatedAt).not.toBe(first);

    // 古い updatedAt では保存できない
    const stale = applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: first,
        patch: { text: '2回目' },
      },
      store.deps,
    );
    expect(stale.ok === false && stale.conflict).toBe(true);
  });
});

describe('保存の失敗', () => {
  it('★保存に失敗しても project.json の内容が壊れない', () => {
    const store = setup();
    const before = structuredClone(store.read(DIR));
    store.failNextSave();

    const result = applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: before.updatedAt,
        patch: { text: '保存できない修正' },
      },
      store.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.userMessage).toContain('変更されていません');
    // ★内容がそのまま残っている
    expect(store.read(DIR)).toEqual(before);
  });
});

describe('IDが重複する字幕（旧形式プロジェクトとの互換性）', () => {
  const duplicated = (): ProjectLike =>
    projectFixture({
      analysis: {
        subtitles: [
          subtitleFixture(20.96, 20.96, ['前半'], { speakerId: 'spk_a' }),
          subtitleFixture(20.96, 21.12, ['後半'], { speakerId: 'spk_a' }),
        ],
      },
    });

  it('重複IDと件数を検出する', () => {
    expect([...duplicateSubtitleIds(duplicated().analysis!.subtitles)]).toEqual([
      ['sub-00020960', 2],
    ]);
  });

  it('★重複しているキューは編集不可として返す', () => {
    const data = loadOk(setup(duplicated()));
    expect(data.subtitles.every((c) => c.duplicateId)).toBe(true);
    expect(data.subtitles.every((c) => !c.editable)).toBe(true);
    expect(data.counts.duplicateId).toBe(2);
  });

  it('★重複しているキューの保存は拒否する（両方に適用されるのを防ぐ）', () => {
    const store = setup(duplicated());
    const result = applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: 'sub-00020960',
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { text: 'どちらに適用されるか分からない' },
      },
      store.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('SUBTITLE_NOT_EDITABLE');
    expect(store.saveCount()).toBe(0);
  });

  it('重複していないキューは編集できる', () => {
    const data = loadOk(setup());
    expect(data.subtitles.every((c) => c.editable)).toBe(true);
    expect(data.counts.duplicateId).toBe(0);
  });

  it('★連番付きIDなら一意なので編集できる（新形式）', () => {
    // 再解析後に生成される形。開始時刻は同じでもIDが分かれる。
    const project = projectFixture({
      analysis: {
        subtitles: [
          { ...subtitleFixture(20.96, 20.96, ['前半'], { speakerId: 'spk_a' }) },
          {
            ...subtitleFixture(20.96, 21.12, ['後半'], { speakerId: 'spk_a' }),
            id: 'sub-00020960-2',
          },
        ],
      },
    });
    const store = setup(project);
    const data = loadOk(store);

    expect(data.subtitles.map((c) => c.id)).toEqual([
      'sub-00020960',
      'sub-00020960-2',
    ]);
    expect(data.subtitles.every((c) => c.editable)).toBe(true);
    expect(data.counts.duplicateId).toBe(0);

    // 実際に保存できる
    const saved = applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: 'sub-00020960-2',
        expectedUpdatedAt: data.updatedAt,
        patch: { text: '2件目だけを直した' },
      },
      store.deps,
    );
    expect(saved.ok).toBe(true);

    // ★1件目には影響しない
    const reloaded = loadOk(store);
    expect(reloaded.subtitles[0]!.text).toBe('前半');
    expect(reloaded.subtitles[0]!.edited).toBe(false);
    expect(reloaded.subtitles[1]!.text).toBe('2件目だけを直した');
    expect(reloaded.subtitles[1]!.edited).toBe(true);
  });

  it('★重複IDに修正が付いている異常データを要確認として報告する', () => {
    const project = duplicated();
    // 旧形式で保存されてしまった修正を再現する。
    project.edits.subtitles['sub-00020960'] = { text: 'どちらへの修正か不明' };

    const data = loadOk(setup(project));

    expect(data.counts.ambiguous).toBe(1);
    expect(data.ambiguous[0]).toMatchObject({
      subtitleId: 'sub-00020960',
      cueCount: 2,
      text: 'どちらへの修正か不明',
    });
    // ★自動でどちらかへ移していない（editsは元のまま）
    expect(Object.keys(project.edits.subtitles)).toEqual(['sub-00020960']);
  });

  it('重複IDでも修正が無ければ要確認にしない', () => {
    expect(loadOk(setup(duplicated())).counts.ambiguous).toBe(0);
  });

  it('★異常データがあっても保存は拒否したままにする', () => {
    const project = duplicated();
    project.edits.subtitles['sub-00020960'] = { text: '既存の修正' };
    const store = setup(project);

    const result = applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: 'sub-00020960',
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { text: 'さらに直す' },
      },
      store.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('SUBTITLE_NOT_EDITABLE');
    expect(store.saveCount()).toBe(0);
    // 既存の修正は消えていない
    expect(store.read(DIR).edits.subtitles['sub-00020960']).toEqual({
      text: '既存の修正',
    });
  });
});

describe('再解析によるID移行（既存editsを壊さないこと）', () => {
  it('★衝突していない字幕の修正は再解析後もそのまま当たる', () => {
    const store = setup();
    applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { text: '人が直した本文' },
      },
      store.deps,
    );

    // 再解析：IDの採番方式が変わっても、衝突していないIDは同じまま。
    const project = store.read(DIR);
    store.deps.saveProject(DIR, {
      ...project,
      analysis: {
        subtitles: [
          subtitleFixture(0, 2.5, ['こんばんは'], { speakerId: 'spk_a' }),
          subtitleFixture(2.5, 5, ['よろしくお願いします'], { speakerId: 'spk_b' }),
          subtitleFixture(5, 8.25, ['今日のテーマは'], { speakerId: 'spk_a' }),
        ],
      },
    });

    const data = loadOk(store);
    expect(data.subtitles[0]!.text).toBe('人が直した本文');
    expect(data.subtitles[0]!.edited).toBe(true);
    // ★孤立が増えていない
    expect(data.counts.orphaned).toBe(0);
  });

  it('★旧形式（重複ID）→新形式（連番）へ再解析すると編集可能になる', () => {
    // 旧形式：IDが重複していて編集不可
    const legacy = projectFixture({
      analysis: {
        subtitles: [
          subtitleFixture(20.96, 20.96, ['前半'], { speakerId: 'spk_a' }),
          subtitleFixture(20.96, 21.12, ['後半'], { speakerId: 'spk_a' }),
        ],
      },
    });
    const store = setup(legacy);
    expect(loadOk(store).subtitles.every((c) => c.editable)).toBe(false);

    // 再解析：2件目に連番が付く
    const project = store.read(DIR);
    store.deps.saveProject(DIR, {
      ...project,
      analysis: {
        subtitles: [
          subtitleFixture(20.96, 20.96, ['前半'], { speakerId: 'spk_a' }),
          {
            ...subtitleFixture(20.96, 21.12, ['後半'], { speakerId: 'spk_a' }),
            id: 'sub-00020960-2',
          },
        ],
      },
    });

    const data = loadOk(store);
    expect(data.subtitles.every((c) => c.editable)).toBe(true);
    expect(data.counts.duplicateId).toBe(0);
    expect(data.counts.orphaned).toBe(0);
  });

  it('★移行しても edits 以外の領域を変えない', () => {
    const store = setup();
    const before = structuredClone(store.read(DIR));

    applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: FIRST,
        expectedUpdatedAt: before.updatedAt,
        patch: { text: '直した' },
      },
      store.deps,
    );

    const after = store.read(DIR);
    expect(after.analysis).toEqual(before.analysis);
    expect(after.speakers).toEqual(before.speakers);
    expect(after.assets).toEqual(before.assets);
    expect(after.status).toEqual(before.status);
  });
});

describe('存在しない対象', () => {
  it('未知の字幕IDは拒否する', () => {
    const store = setup();
    const result = applySubtitleEdit(
      {
        projectPath: DIR,
        subtitleId: 'sub-99999999',
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { text: 'x' },
      },
      store.deps,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('SUBTITLE_NOT_FOUND');
    expect(store.saveCount()).toBe(0);
  });
});
