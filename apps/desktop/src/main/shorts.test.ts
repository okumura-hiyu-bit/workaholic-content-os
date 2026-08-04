/**
 * ショート候補の組み立てと、採否・編集の保存。
 *
 * ★このテストの主眼は「analysis が変わらないこと」と
 * 「書き換わるのが edits.shorts と edits.history だけであること」。
 * ffmpeg / faster-whisper は起動しない。
 */

import { describe, expect, it } from 'vitest';

import {
  applyShortDecision,
  buildShortsData,
  detectRangeChanges,
  FIELDS_NOT_EXPORTED,
  REANALYSIS_WARNING,
  removeShortDecision,
} from './shorts.ts';
import type { ProjectLike } from './review.ts';
import {
  createFakeStore,
  projectFixture,
  shortCandidateFixture,
} from './testing/fake-core.ts';

const DIR = '/tmp/ep012';
const FIRST = 'short_01';
const SECOND = 'short_02';
const THIRD = 'short_03';

function setup(project: ProjectLike = projectFixture()) {
  return createFakeStore({ [DIR]: project });
}

function loadOk(store: ReturnType<typeof setup>) {
  const result = buildShortsData(DIR, store.deps);
  if (!result.ok) throw new Error(`load failed: ${result.error.userMessage}`);
  return result.data;
}

function saveOk(
  store: ReturnType<typeof setup>,
  shortId: string,
  expectedUpdatedAt: string,
  patch: Parameters<typeof applyShortDecision>[0]['patch'],
) {
  const result = applyShortDecision(
    { projectPath: DIR, shortId, expectedUpdatedAt, patch },
    store.deps,
  );
  if (!result.ok) throw new Error(`save failed: ${result.error.userMessage}`);
  return result;
}

describe('ショート候補の読み込み', () => {
  it('解析の候補をすべて返す', () => {
    const data = loadOk(setup());
    expect(data.candidates).toHaveLength(3);
    expect(data.candidates.map((c) => c.id)).toEqual([FIRST, SECOND, THIRD]);
  });

  it('尺・スコア・加点根拠・文字起こし抜粋を渡す', () => {
    const first = loadOk(setup()).candidates[0]!;
    expect(first.startSec).toBe(2);
    expect(first.endSec).toBe(32);
    expect(first.durationSec).toBe(30);
    expect(first.score).toBe(82);
    expect(first.signals).toEqual(['笑い', '強調']);
    expect(first.transcriptExcerpt).toBe('ここが盛り上がった部分です');
  });

  it('判断前はすべて未判断・未編集', () => {
    const data = loadOk(setup());
    expect(data.candidates.every((c) => c.adopted === undefined)).toBe(true);
    expect(data.candidates.every((c) => !c.edited)).toBe(true);
    expect(data.counts.undecided).toBe(3);
    expect(data.counts.adopted).toBe(0);
    expect(data.counts.rejected).toBe(0);
  });

  it('★再解析の警告を必ず載せる（画面から消せないようにするため）', () => {
    const data = loadOk(setup());
    expect(data.reanalysisWarning).toBe(REANALYSIS_WARNING);
    expect(data.reanalysisWarning).toContain('外れる可能性');
  });

  it('★shorts.csv に載らない項目を明示する', () => {
    const data = loadOk(setup());
    expect(data.fieldsNotExported).toEqual(FIELDS_NOT_EXPORTED);
    expect(data.fieldsNotExported).toContain('投稿文');
  });

  it('★タイムコード編集は未対応であることを示す', () => {
    expect(loadOk(setup()).timecodeEditingSupported).toBe(false);
  });

  it('★DTOに素材の絶対パス・文字起こし全文・editsレイヤーを含めない', () => {
    const serialized = JSON.stringify(loadOk(setup()));
    expect(serialized).not.toContain('/tmp/ep012/raw/wide.mp4');
    expect(serialized).not.toContain('"edits"');
    expect(serialized).not.toContain('"analysis"');
    expect(serialized).not.toContain('"words"');
  });

  it('解析前のプロジェクトは ANALYSIS_NOT_READY で断る', () => {
    const project = projectFixture();
    delete project.analysis;
    const result = buildShortsData(DIR, setup(project).deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ANALYSIS_NOT_READY');
  });

  it('shortCandidates が無い旧形式でも落ちずに0件で開ける', () => {
    const project = projectFixture();
    project.analysis = { subtitles: project.analysis!.subtitles };
    const data = loadOk(setup(project));
    expect(data.candidates).toEqual([]);
    expect(data.counts.candidates).toBe(0);
  });

  it('project.json を読めなければ INVALID_PROJECT を返す', () => {
    const result = buildShortsData('/tmp/none', setup().deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_PROJECT');
  });
});

describe('採否の保存', () => {
  it('採用を保存すると読み直しても残る', () => {
    const store = setup();
    const before = loadOk(store);
    const saved = saveOk(store, FIRST, before.updatedAt, { adopted: true });

    expect(saved.candidate.adopted).toBe(true);
    expect(saved.candidate.edited).toBe(true);
    expect(loadOk(store).candidates[0]!.adopted).toBe(true);
  });

  it('不採用も保存できる（未判断と区別される）', () => {
    const store = setup();
    const saved = saveOk(store, SECOND, loadOk(store).updatedAt, { adopted: false });
    expect(saved.candidate.adopted).toBe(false);
    expect(saved.counts.rejected).toBe(1);
    expect(saved.counts.undecided).toBe(2);
  });

  it('null を渡すと未判断へ戻せる', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(store, FIRST, updatedAt, { adopted: true }).updatedAt;
    const cleared = saveOk(store, FIRST, updatedAt, { adopted: null });
    expect(cleared.candidate.adopted).toBeUndefined();
  });

  it('件数が採用・不採用・未判断で正しく分かれる', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(store, FIRST, updatedAt, { adopted: true }).updatedAt;
    const result = saveOk(store, SECOND, updatedAt, { adopted: false });
    expect(result.counts).toMatchObject({
      candidates: 3,
      adopted: 1,
      rejected: 1,
      undecided: 1,
      edited: 2,
    });
  });
});

describe('テキスト項目の保存', () => {
  it('タイトル・フック・投稿文・ハッシュタグ・メモを保存できる', () => {
    const store = setup();
    const saved = saveOk(store, FIRST, loadOk(store).updatedAt, {
      adopted: true,
      title: '神回の入り',
      hook: 'ここから空気が変わります',
      caption: '本編はこちら\n#ラジオ',
      hashtags: ['切り抜き', 'ラジオ'],
      note: 'テロップを大きめに',
    });

    expect(saved.candidate.title).toBe('神回の入り');
    expect(saved.candidate.hook).toBe('ここから空気が変わります');
    expect(saved.candidate.caption).toBe('本編はこちら\n#ラジオ');
    expect(saved.candidate.hashtags).toEqual(['切り抜き', 'ラジオ']);
    expect(saved.candidate.note).toBe('テロップを大きめに');
  });

  it('null を渡した項目だけが消え、他は残る', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(store, FIRST, updatedAt, {
      title: 'タイトル',
      note: 'メモ',
    }).updatedAt;

    const cleared = saveOk(store, FIRST, updatedAt, { title: null });
    expect(cleared.candidate.title).toBeUndefined();
    expect(cleared.candidate.note).toBe('メモ');
  });

  it('指定しなかった項目は変更されない', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(store, FIRST, updatedAt, {
      adopted: true,
      title: 'タイトル',
    }).updatedAt;

    const next = saveOk(store, FIRST, updatedAt, { note: '後から足したメモ' });
    expect(next.candidate.adopted).toBe(true);
    expect(next.candidate.title).toBe('タイトル');
    expect(next.candidate.note).toBe('後から足したメモ');
  });
});

describe('★analysis を書き換えない', () => {
  it('保存の前後で analysis が完全一致する', () => {
    const store = setup();
    const before = JSON.stringify(store.read(DIR).analysis);

    saveOk(store, FIRST, loadOk(store).updatedAt, {
      adopted: true,
      title: '書き換わってはいけない',
    });

    expect(JSON.stringify(store.read(DIR).analysis)).toBe(before);
  });

  it('★書き換わるのは edits.shorts と edits.history だけ', () => {
    const store = setup();
    const before = store.read(DIR);
    saveOk(store, FIRST, loadOk(store).updatedAt, { adopted: true });
    const after = store.read(DIR);

    // shorts と history 以外の edits レイヤーは触らない。
    expect(after.edits.subtitles).toEqual(before.edits.subtitles);
    expect(after.edits.cameraShots).toEqual(before.edits.cameraShots);
    expect(after.edits.chapters).toEqual(before.edits.chapters);
    expect(after.edits.markers).toEqual(before.edits.markers);
    expect(after.edits.syncOffsets).toEqual(before.edits.syncOffsets);

    expect(after.edits.shorts[FIRST]).toEqual({ adopted: true });
    expect(after.edits.history.length).toBeGreaterThan(before.edits.history.length);
  });

  it('字幕の修正はショートの保存で消えない', () => {
    const project = projectFixture();
    project.edits.subtitles = { 'sub-00000000': { text: '人が直した本文' } };
    const store = setup(project);

    saveOk(store, FIRST, loadOk(store).updatedAt, { adopted: true });

    expect(store.read(DIR).edits.subtitles).toEqual({
      'sub-00000000': { text: '人が直した本文' },
    });
  });
});

describe('履歴', () => {
  it('採否の変更が履歴に残る（kind は short）', () => {
    const store = setup();
    saveOk(store, FIRST, loadOk(store).updatedAt, { adopted: true });

    const entry = store
      .read(DIR)
      .edits.history.find((h) => h.field === 'adopted');
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('short');
    expect(entry!.targetId).toBe(FIRST);
    expect(entry!.before).toBeNull();
    expect(entry!.after).toBe(true);
  });

  it('項目ごとに履歴が残る', () => {
    const store = setup();
    saveOk(store, FIRST, loadOk(store).updatedAt, {
      adopted: true,
      title: 'タイトル',
      note: 'メモ',
    });

    const fields = store
      .read(DIR)
      .edits.history.filter((h) => h.kind === 'short')
      .map((h) => h.field);
    expect(fields).toContain('adopted');
    expect(fields).toContain('title');
    expect(fields).toContain('note');
  });

  it('★値が変わらない保存では履歴を増やさない', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(store, FIRST, updatedAt, { adopted: true }).updatedAt;
    const historyLength = store.read(DIR).edits.history.length;

    saveOk(store, FIRST, updatedAt, { adopted: true });
    expect(store.read(DIR).edits.history.length).toBe(historyLength);
  });

  it('ハッシュタグの中身が変わったときは履歴に残る（配列でも比較できている）', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(store, FIRST, updatedAt, { hashtags: ['a'] }).updatedAt;
    const before = store.read(DIR).edits.history.length;

    saveOk(store, FIRST, updatedAt, { hashtags: ['a', 'b'] });
    expect(store.read(DIR).edits.history.length).toBeGreaterThan(before);
  });
});

describe('★競合更新の検出', () => {
  it('古い updatedAt では上書きせず conflict を返す', () => {
    const store = setup();
    const data = loadOk(store);
    store.touchExternally(DIR);

    const result = applyShortDecision(
      {
        projectPath: DIR,
        shortId: FIRST,
        expectedUpdatedAt: data.updatedAt,
        patch: { adopted: true },
      },
      store.deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe(true);
      expect(result.error.code).toBe('PROJECT_CHANGED');
    }
    // ★保存されていないこと。
    expect(store.read(DIR).edits.shorts[FIRST]).toBeUndefined();
  });

  it('保存のたびに updatedAt が変わり、古い値での連続保存は弾かれる', () => {
    const store = setup();
    const first = loadOk(store);
    const saved = saveOk(store, FIRST, first.updatedAt, { adopted: true });
    expect(saved.updatedAt).not.toBe(first.updatedAt);

    const stale = applyShortDecision(
      {
        projectPath: DIR,
        shortId: SECOND,
        expectedUpdatedAt: first.updatedAt,
        patch: { adopted: true },
      },
      store.deps,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.conflict).toBe(true);
  });

  it('取り消しでも競合を検出する', () => {
    const store = setup();
    const data = loadOk(store);
    saveOk(store, FIRST, data.updatedAt, { adopted: true });

    const result = removeShortDecision(
      { projectPath: DIR, shortId: FIRST, expectedUpdatedAt: data.updatedAt },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toBe(true);
  });
});

describe('存在しない候補', () => {
  it('解析に無いIDへは保存しない', () => {
    const store = setup();
    const result = applyShortDecision(
      {
        projectPath: DIR,
        shortId: 'short_99',
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { adopted: true },
      },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SHORT_NOT_FOUND');
    expect(store.read(DIR).edits.shorts['short_99']).toBeUndefined();
  });

  it('判断が無いものの取り消しは SHORT_NOT_FOUND', () => {
    const store = setup();
    const result = removeShortDecision(
      { projectPath: DIR, shortId: FIRST, expectedUpdatedAt: loadOk(store).updatedAt },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('SHORT_NOT_FOUND');
  });
});

describe('判断の取り消し', () => {
  it('取り消すと未判断・未編集に戻る', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(store, FIRST, updatedAt, {
      adopted: true,
      title: 'タイトル',
    }).updatedAt;

    const result = removeShortDecision(
      { projectPath: DIR, shortId: FIRST, expectedUpdatedAt: updatedAt },
      store.deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidate.adopted).toBeUndefined();
      expect(result.candidate.title).toBeUndefined();
      expect(result.candidate.edited).toBe(false);
    }
    expect(store.read(DIR).edits.shorts[FIRST]).toBeUndefined();
  });

  it('取り消しも履歴に残す（何を消したか分かるように中身ごと）', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(store, FIRST, updatedAt, { adopted: true, title: 'T' }).updatedAt;

    removeShortDecision(
      { projectPath: DIR, shortId: FIRST, expectedUpdatedAt: updatedAt },
      store.deps,
    );

    const entry = store.read(DIR).edits.history.find((h) => h.field === 'removed');
    expect(entry).toBeDefined();
    expect(entry!.before).toMatchObject({ adopted: true, title: 'T' });
    expect(entry!.after).toBeNull();
  });

  it('★他の候補の判断は消えない', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(store, FIRST, updatedAt, { adopted: true }).updatedAt;
    updatedAt = saveOk(store, SECOND, updatedAt, { adopted: false }).updatedAt;

    removeShortDecision(
      { projectPath: DIR, shortId: FIRST, expectedUpdatedAt: updatedAt },
      store.deps,
    );

    expect(store.read(DIR).edits.shorts[SECOND]).toEqual({ adopted: false });
  });
});

describe('★孤立した判断（再解析で候補が変わった場合）', () => {
  /** 再解析で候補が2件に減り、short_03 が消えた状況を作る。 */
  function reanalyzed(store: ReturnType<typeof setup>): void {
    const project = store.read(DIR);
    project.analysis!.shortCandidates = [
      shortCandidateFixture(1, 2, 32, { score: 82, signals: ['笑い', '強調'] }),
      shortCandidateFixture(2, 40, 70, { score: 61, signals: ['話題の切り替わり'] }),
    ];
    store.deps.saveProject(DIR, project);
  }

  it('繋がらなかった判断を内容ごと返す（黙って捨てない）', () => {
    const store = setup();
    saveOk(store, THIRD, loadOk(store).updatedAt, {
      adopted: true,
      title: '消えては困るタイトル',
      note: 'メモ',
    });
    reanalyzed(store);

    const data = loadOk(store);
    expect(data.orphaned).toHaveLength(1);
    expect(data.orphaned[0]!.originalId).toBe(THIRD);
    expect(data.orphaned[0]!.adopted).toBe(true);
    expect(data.orphaned[0]!.title).toBe('消えては困るタイトル');
    expect(data.orphaned[0]!.note).toBe('メモ');
    expect(data.counts.orphaned).toBe(1);
  });

  it('孤立しても project.json からは消さない（戻せる状態を保つ）', () => {
    const store = setup();
    saveOk(store, THIRD, loadOk(store).updatedAt, { adopted: true });
    reanalyzed(store);

    expect(store.read(DIR).edits.shorts[THIRD]).toEqual({ adopted: true });
  });

  it('残っている候補の判断はそのまま使える', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(store, FIRST, updatedAt, { adopted: true }).updatedAt;
    saveOk(store, THIRD, updatedAt, { adopted: false });
    reanalyzed(store);

    const data = loadOk(store);
    expect(data.candidates[0]!.adopted).toBe(true);
    expect(data.counts.adopted).toBe(1);
  });
});

describe('★区間の取り違え（IDは残るが中身が変わった場合）', () => {
  /** short_01 の区間だけが別物に置き換わった状況を作る。 */
  function shiftFirst(store: ReturnType<typeof setup>): void {
    const project = store.read(DIR);
    project.analysis!.shortCandidates![0] = shortCandidateFixture(1, 300, 330, {
      score: 40,
      signals: ['強調'],
    });
    store.deps.saveProject(DIR, project);
  }

  it('判断した時点の区間を履歴に残す', () => {
    const store = setup();
    saveOk(store, FIRST, loadOk(store).updatedAt, { adopted: true });

    const entry = store
      .read(DIR)
      .edits.history.find((h) => h.field === 'candidateRange');
    expect(entry).toBeDefined();
    expect(entry!.after).toEqual({ startSec: 2, endSec: 32, score: 82 });
  });

  it('区間が変わったら rangeChanged を立て、判断時の区間を返す', () => {
    const store = setup();
    saveOk(store, FIRST, loadOk(store).updatedAt, { adopted: true });
    shiftFirst(store);

    const data = loadOk(store);
    const first = data.candidates[0]!;
    expect(first.rangeChanged).toBe(true);
    expect(first.decidedRange).toEqual({ startSec: 2, endSec: 32, score: 82 });
    // 判断そのものは残す（勝手に取り消さない）。
    expect(first.adopted).toBe(true);
    expect(data.counts.rangeChanged).toBe(1);
  });

  it('区間が変わっていなければ rangeChanged は立たない', () => {
    const store = setup();
    saveOk(store, FIRST, loadOk(store).updatedAt, { adopted: true });

    const data = loadOk(store);
    expect(data.candidates[0]!.rangeChanged).toBe(false);
    expect(data.candidates[0]!.decidedRange).toBeUndefined();
    expect(data.counts.rangeChanged).toBe(0);
  });

  it('判断していない候補では rangeChanged を見ない', () => {
    const store = setup();
    shiftFirst(store);
    expect(loadOk(store).candidates[0]!.rangeChanged).toBe(false);
  });

  it('★基準は「最初に判断したときの区間」。2回目以降の保存で上書きしない', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(store, FIRST, updatedAt, { adopted: true }).updatedAt;
    shiftFirst(store);

    // 区間が変わったあとにタイトルだけ足しても、基準は最初のままにする。
    const data = loadOk(store);
    saveOk(store, FIRST, data.updatedAt, { title: 'あとから足した' });

    const ranges = store
      .read(DIR)
      .edits.history.filter((h) => h.field === 'candidateRange');
    expect(ranges).toHaveLength(1);
    expect(loadOk(store).candidates[0]!.decidedRange).toEqual({
      startSec: 2,
      endSec: 32,
      score: 82,
    });
  });

  it('detectRangeChanges は判断が無ければ何も返さない', () => {
    const project = projectFixture();
    const changes = detectRangeChanges(
      project.analysis!.shortCandidates!,
      project.edits,
    );
    expect(changes.size).toBe(0);
  });
});

describe('保存の失敗', () => {
  it('保存に失敗したら「変更されていない」ことを伝える', () => {
    const store = setup();
    store.failNextSave();

    const result = applyShortDecision(
      {
        projectPath: DIR,
        shortId: FIRST,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { adopted: true },
      },
      store.deps,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.userMessage).toContain('変更されていません');
      expect(result.error.suggestedAction).toBeDefined();
    }
    // ★一時ファイル→rename なので、失敗しても元の内容が残る。
    expect(store.read(DIR).edits.shorts[FIRST]).toBeUndefined();
  });

  it('★保存の失敗時にDTOへ技術的な詳細を載せない', () => {
    const store = setup();
    store.failNextSave('ENOSPC: no space left on device');

    const result = applyShortDecision(
      {
        projectPath: DIR,
        shortId: FIRST,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { adopted: true },
      },
      store.deps,
    );

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('ENOSPC');
    expect(serialized).not.toContain('technicalMessage');
  });
});
