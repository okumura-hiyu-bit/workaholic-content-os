/**
 * 復旧（Recovery）の組み立てと、付け替え・破棄。
 *
 * ★このテストの主眼は4つ。
 * 1. 4画面の警告が漏れなく1本の一覧になること（対称に扱えていること）
 * 2. ★付け替えが「edits のキーを移すだけ」で成立すること
 *    （`matchEdits` がID完全一致を時刻再接続より先に見る性質に乗っている）
 * 3. ★`analysis` が一切変わらないこと（書き換わるのは edits と history だけ）
 * 4. 付け替え先の排他（既に修正がある要素へ寄せて先客を押し出さないこと）
 *
 * ffmpeg / faster-whisper は起動しない。`resolveProject` は本物を使う
 * （突き合わせの仕様を写すと、本体が変わってもテストだけ通ってしまう）。
 */

import { describe, expect, it } from 'vitest';

import {
  buildRecoveryData,
  countsOf,
  discardRecoveryEdit,
  listRecoveryTargets,
  reattachRecoveryEdit,
} from './recovery.ts';
import type { EditsLike, ProjectLike } from './review.ts';
import {
  createFakeStore,
  emptyEditsFixture,
  projectFixture,
} from './testing/fake-core.ts';

const DIR = '/tmp/ep012';

/** fixture に実在するID（`fake-core.ts` の projectFixture より）。 */
const SUB_0 = 'sub-00000000';
const SUB_2500 = 'sub-00002500';
const SUB_5000 = 'sub-00005000';
const SHOT_0 = 'shot-00000000';
const SHOT_10000 = 'shot-00010000';
const SHOT_25000 = 'shot-00025000';
const TOPIC = 'mk-TOPIC-00000000';
const CHECK = 'mk-CHECK-check-lowconf-7700';
const LAUGH = 'mk-LAUGH-00033990';

/** fixture に**存在しない**ID（孤立させるために使う）。 */
const SUB_ORPHAN = 'sub-00100000';
const SHOT_ORPHAN = 'shot-00090000';
const MARKER_ORPHAN = 'mk-CHECK-check-lowconf-9999';
const SHORT_ORPHAN = 'short_07';

function withEdits(mutate: (edits: EditsLike) => void): ProjectLike {
  const edits = emptyEditsFixture();
  mutate(edits);
  return projectFixture({ edits });
}

function setup(project: ProjectLike = projectFixture()) {
  return createFakeStore({ [DIR]: project });
}

function loadOk(store: ReturnType<typeof setup>) {
  const result = buildRecoveryData(DIR, store.deps);
  if (!result.ok) throw new Error(`load failed: ${result.error.userMessage}`);
  return result.data;
}

function updatedAt(store: ReturnType<typeof setup>): string {
  return store.read(DIR).updatedAt;
}

/** ★analysis が1文字も変わっていないことを確かめるための指紋。 */
function analysisFingerprint(project: ProjectLike): string {
  return JSON.stringify(project.analysis);
}

// ═══════════════════════════════════════════════════════
describe('buildRecoveryData：4画面を横断した一覧', () => {
  it('警告がなければ空の一覧を返す', () => {
    const data = loadOk(setup());
    expect(data.items).toEqual([]);
    expect(data.counts.total).toBe(0);
    expect(data.counts.reattachable).toBe(0);
  });

  it('4ドメインの孤立を漏れなく拾う', () => {
    const store = setup(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: '孤立字幕' };
        e.shorts[SHORT_ORPHAN] = { adopted: true, title: '孤立ショート' };
        e.markers[MARKER_ORPHAN] = { comment: '孤立マーカー' };
        e.cameraShots.deletedIds = [SHOT_ORPHAN];
      }),
    );
    const data = loadOk(store);

    const orphans = data.items.filter((i) => i.kind === 'orphaned');
    expect(orphans.map((o) => o.domain).sort()).toEqual([
      'cameraShot',
      'marker',
      'short',
      'subtitle',
    ]);
    expect(data.counts.byKind.orphaned).toBe(4);
    // ★孤立はすべて付け替えの対象。
    expect(orphans.every((o) => o.reattachable)).toBe(true);
    expect(data.counts.reattachable).toBe(4);
  });

  it('孤立した修正の中身を一覧に載せる（件数だけにしない）', () => {
    const store = setup(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: '失われかけている本文' };
      }),
    );
    const item = loadOk(store).items[0];
    expect(item?.body).toContain('失われかけている本文');
    // reason は resolveProject が出した文面をそのまま渡す。
    expect(item?.detail).toContain('許容範囲');
  });

  it('★字幕の繋ぎ直しを一覧に出す（従来どこにも出ていなかった）', () => {
    // 0.4秒ずらす。許容範囲（0.5秒）内なので自動で繋ぎ直される。
    const store = setup(
      withEdits((e) => {
        e.subtitles['sub-00000400'] = { text: '繋ぎ直された修正' };
      }),
    );
    const data = loadOk(store);
    const reattached = data.items.filter((i) => i.kind === 'reattached');
    expect(reattached).toHaveLength(1);
    expect(reattached[0]?.domain).toBe('subtitle');
    // ★sourceId は edits 側のキー。matchEdits は edits を書き換えないので、
    //   繋ぎ直された後も修正は古いキーのまま保存されている。
    expect(reattached[0]?.sourceId).toBe('sub-00000400');
    expect(reattached[0]?.reattachable).toBe(false);
  });

  it('★マーカーの種別またぎを検出する（孤立しないので気づけない事故）', () => {
    // LAUGH(33.99秒) の近くへ TOPIC の修正を置く。
    const store = setup(
      withEdits((e) => {
        e.markers['mk-TOPIC-00033900'] = { name: '第2章：本題へ' };
      }),
    );
    const data = loadOk(store);
    const mismatch = data.items.filter((i) => i.kind === 'kindMismatch');
    expect(mismatch).toHaveLength(1);
    expect(mismatch[0]?.headline).toContain('TOPIC');
    expect(mismatch[0]?.headline).toContain('LAUGH');
    expect(mismatch[0]?.sourceId).toBe('mk-TOPIC-00033900');

    // ★種別またぎとして出した分は、素の「繋ぎ直し」に重ねない。
    const plain = data.items.filter(
      (i) => i.kind === 'reattached' && i.domain === 'marker',
    );
    expect(plain).toHaveLength(0);
  });

  it('★繋ぎ直しにも時刻を載せる（時刻順に並び、再生位置へ飛べるように）', () => {
    // ★実機確認で発覚した抜け。IDから時刻が読めたからこそ繋ぎ直されたのに、
    //   一覧に時刻を載せておらず、その項目だけ末尾へ落ちていた。
    const store = setup(
      withEdits((e) => {
        e.subtitles['sub-00000400'] = { text: '繋ぎ直された修正' };
      }),
    );
    const reattached = loadOk(store).items.find((i) => i.kind === 'reattached');
    expect(reattached?.approxSec).toBeCloseTo(0.4, 3);
  });

  it('★判断を破棄したショートは「区間変化」を出さない（消せない項目を作らない）', () => {
    // ★実機確認で発覚した抜け。`rangeChanged` は edits.history から算出され、
    //   履歴は追記のみで消えない。判断を破棄しても印だけが残るため、
    //   そのまま一覧に出すと二度と片付けられない項目になっていた。
    const store = setup(
      withEdits((e) => {
        // 判断はすでに破棄済み（edits.shorts は空）。履歴だけが残っている状態。
        e.history.push({
          at: '2026-08-09T00:00:00.000Z',
          actor: 'human',
          kind: 'short',
          targetId: 'short_01',
          field: 'candidateRange',
          before: null,
          after: { startSec: 999, endSec: 1099, score: 99 },
        });
      }),
    );
    const items = loadOk(store).items;
    expect(items.filter((i) => i.kind === 'rangeChanged')).toHaveLength(0);
  });

  it('判断が残っていれば「区間変化」を出す', () => {
    const store = setup(
      withEdits((e) => {
        e.shorts['short_01'] = { adopted: true, title: '採用' };
        e.history.push({
          at: '2026-08-09T00:00:00.000Z',
          actor: 'human',
          kind: 'short',
          targetId: 'short_01',
          field: 'candidateRange',
          before: null,
          after: { startSec: 999, endSec: 1099, score: 99 },
        });
      }),
    );
    const items = loadOk(store).items;
    expect(items.filter((i) => i.kind === 'rangeChanged')).toHaveLength(1);
  });

  it('一覧は時刻順。時刻を持たない項目は末尾へ回す', () => {
    const store = setup(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: '100秒地点' };
        e.shorts[SHORT_ORPHAN] = { adopted: false };
        e.markers[MARKER_ORPHAN] = { comment: '時刻なし' };
      }),
    );
    const items = loadOk(store).items;
    const times = items.map((i) => i.approxSec);
    // 時刻を持つものが先、undefined は後ろ。
    const firstUndefined = times.findIndex((t) => t === undefined);
    expect(firstUndefined).toBeGreaterThan(-1);
    expect(times.slice(firstUndefined).every((t) => t === undefined)).toBe(true);
  });

  it('解析前は ANALYSIS_NOT_READY を返す', () => {
    const project = projectFixture();
    delete project.analysis;
    const result = buildRecoveryData(DIR, setup(project).deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ANALYSIS_NOT_READY');
  });
});

// ═══════════════════════════════════════════════════════
describe('countsOf', () => {
  it('対象別・種別別・付け替え可能数を数える', () => {
    const counts = countsOf([
      {
        key: 'a',
        domain: 'subtitle',
        kind: 'orphaned',
        sourceId: 'x',
        headline: '',
        reattachable: true,
      },
      {
        key: 'b',
        domain: 'marker',
        kind: 'kindMismatch',
        sourceId: 'y',
        headline: '',
        reattachable: false,
      },
    ]);
    expect(counts.total).toBe(2);
    expect(counts.reattachable).toBe(1);
    expect(counts.byDomain.subtitle).toBe(1);
    expect(counts.byDomain.marker).toBe(1);
    expect(counts.byDomain.short).toBe(0);
    expect(counts.byKind.orphaned).toBe(1);
    expect(counts.byKind.kindMismatch).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════
describe('listRecoveryTargets：付け替え先の候補', () => {
  it('字幕の候補を近い順に返す', () => {
    const store = setup(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: '孤立' };
      }),
    );
    const result = listRecoveryTargets(
      { projectPath: DIR, domain: 'subtitle', sourceId: SUB_ORPHAN },
      store.deps,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targets.map((t) => t.id)).toEqual([SUB_5000, SUB_2500, SUB_0]);
    // 100秒地点から最も近いのは5.0秒のキュー。
    expect(result.targets[0]?.deltaSec).toBeCloseTo(95, 3);
  });

  it('★既に修正がある要素は occupied として返す（選ばせない）', () => {
    const store = setup(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: '孤立' };
        e.subtitles[SUB_0] = { text: '先客' };
      }),
    );
    const result = listRecoveryTargets(
      { projectPath: DIR, domain: 'subtitle', sourceId: SUB_ORPHAN },
      store.deps,
    );
    if (!result.ok) throw new Error('failed');
    expect(result.targets.find((t) => t.id === SUB_0)?.occupied).toBe(true);
    expect(result.targets.find((t) => t.id === SUB_2500)?.occupied).toBe(false);
  });

  it('ショートは時刻を持たないので deltaSec が付かない', () => {
    const store = setup(
      withEdits((e) => {
        e.shorts[SHORT_ORPHAN] = { adopted: true };
      }),
    );
    const result = listRecoveryTargets(
      { projectPath: DIR, domain: 'short', sourceId: SHORT_ORPHAN },
      store.deps,
    );
    if (!result.ok) throw new Error('failed');
    expect(result.targets.length).toBeGreaterThan(0);
    expect(result.targets.every((t) => t.deltaSec === undefined)).toBe(true);
  });

  it('★カメラの削除指定：既に削除済みのカットは候補に現れない', () => {
    const store = setup(
      withEdits((e) => {
        e.cameraShots.deletedIds = [SHOT_ORPHAN, SHOT_0];
        e.cameraShots.overrides[SHOT_10000] = { cameraId: 'cam_B' };
      }),
    );
    const result = listRecoveryTargets(
      { projectPath: DIR, domain: 'cameraShot', sourceId: SHOT_ORPHAN },
      store.deps,
    );
    if (!result.ok) throw new Error('failed');

    // ★候補は「解決後の並び」から作る。削除済みのカットはそこに残らないので、
    //   そもそも候補に現れない（＝二重に削除指定できない）。
    expect(result.targets.map((t) => t.id)).not.toContain(SHOT_0);
    // override が付いているだけのカットを削除指定に加えるのは正当な操作。
    expect(result.targets.find((t) => t.id === SHOT_10000)?.occupied).toBe(false);
  });

  it('★カメラの override 側は overrides を見て occupied を決める', () => {
    const store = setup(
      withEdits((e) => {
        e.cameraShots.overrides[SHOT_ORPHAN] = { cameraId: 'cam_A' };
        e.cameraShots.overrides[SHOT_10000] = { cameraId: 'cam_B' };
      }),
    );
    const result = listRecoveryTargets(
      { projectPath: DIR, domain: 'cameraShot', sourceId: SHOT_ORPHAN },
      store.deps,
    );
    if (!result.ok) throw new Error('failed');
    expect(result.targets.find((t) => t.id === SHOT_10000)?.occupied).toBe(true);
    expect(result.targets.find((t) => t.id === SHOT_25000)?.occupied).toBe(false);
  });

  it('★人が追加したカットは付け替え先にしない（解析側にしか付かないため）', () => {
    const store = setup(
      withEdits((e) => {
        e.cameraShots.deletedIds = [SHOT_ORPHAN];
        e.cameraShots.inserted = [
          { id: 'shot-00050000', startSec: 50, endSec: 55, cameraId: 'cam_A', reason: 'speech' },
        ];
      }),
    );
    const result = listRecoveryTargets(
      { projectPath: DIR, domain: 'cameraShot', sourceId: SHOT_ORPHAN },
      store.deps,
    );
    if (!result.ok) throw new Error('failed');
    expect(result.targets.map((t) => t.id)).not.toContain('shot-00050000');
  });

  it('★既に削除指定されたカットへの付け替えは Main が拒否する', () => {
    // 候補一覧には出ないが、古い画面からの要求で届きうる経路を塞ぐ。
    const store = setup(
      withEdits((e) => {
        e.cameraShots.deletedIds = [SHOT_ORPHAN, SHOT_10000];
      }),
    );
    const result = reattachRecoveryEdit(
      {
        projectPath: DIR,
        domain: 'cameraShot',
        sourceId: SHOT_ORPHAN,
        targetId: SHOT_10000,
        expectedUpdatedAt: updatedAt(store),
      },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_REQUEST');
    expect(store.saveCount()).toBe(0);
  });

  it('存在しない修正を指定したら拒否する', () => {
    const result = listRecoveryTargets(
      { projectPath: DIR, domain: 'subtitle', sourceId: SUB_ORPHAN },
      setup().deps,
    );
    expect(result.ok).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════
describe('reattachRecoveryEdit：付け替え', () => {
  it('★字幕：孤立が消え、修正が付け替え先へ適用される', () => {
    const store = setup(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: '救い出した本文' };
      }),
    );
    const before = analysisFingerprint(store.read(DIR));
    expect(loadOk(store).counts.byKind.orphaned).toBe(1);

    const result = reattachRecoveryEdit(
      {
        projectPath: DIR,
        domain: 'subtitle',
        sourceId: SUB_ORPHAN,
        targetId: SUB_2500,
        expectedUpdatedAt: updatedAt(store),
      },
      store.deps,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // ★孤立が消えている。しかも「繋ぎ直し」にもならない（完全一致で適用される）。
    expect(result.counts.total).toBe(0);

    const saved = store.read(DIR);
    expect(saved.edits.subtitles[SUB_ORPHAN]).toBeUndefined();
    expect(saved.edits.subtitles[SUB_2500]).toEqual({ text: '救い出した本文' });
    // ★analysis は1文字も変わらない。
    expect(analysisFingerprint(saved)).toBe(before);
  });

  it('★ショート：時刻が無くても付け替えできる', () => {
    const store = setup(
      withEdits((e) => {
        e.shorts[SHORT_ORPHAN] = { adopted: true, title: '救い出した判断' };
      }),
    );
    const result = reattachRecoveryEdit(
      {
        projectPath: DIR,
        domain: 'short',
        sourceId: SHORT_ORPHAN,
        targetId: 'short_02',
        expectedUpdatedAt: updatedAt(store),
      },
      store.deps,
    );
    expect(result.ok).toBe(true);
    const saved = store.read(DIR);
    expect(saved.edits.shorts[SHORT_ORPHAN]).toBeUndefined();
    expect(saved.edits.shorts['short_02']).toEqual({
      adopted: true,
      title: '救い出した判断',
    });
  });

  it('★マーカー：CHECK系（IDに時刻が無い）も付け替えできる', () => {
    const store = setup(
      withEdits((e) => {
        e.markers[MARKER_ORPHAN] = { comment: '救い出したメモ' };
      }),
    );
    const result = reattachRecoveryEdit(
      {
        projectPath: DIR,
        domain: 'marker',
        sourceId: MARKER_ORPHAN,
        targetId: CHECK,
        expectedUpdatedAt: updatedAt(store),
      },
      store.deps,
    );
    expect(result.ok).toBe(true);
    const saved = store.read(DIR);
    expect(saved.edits.markers[MARKER_ORPHAN]).toBeUndefined();
    expect(saved.edits.markers[CHECK]).toEqual({ comment: '救い出したメモ' });
  });

  it('★カメラ：override は Record のキーを移す', () => {
    const store = setup(
      withEdits((e) => {
        e.cameraShots.overrides[SHOT_ORPHAN] = { cameraId: 'cam_B' };
      }),
    );
    const result = reattachRecoveryEdit(
      {
        projectPath: DIR,
        domain: 'cameraShot',
        sourceId: SHOT_ORPHAN,
        targetId: SHOT_25000,
        expectedUpdatedAt: updatedAt(store),
      },
      store.deps,
    );
    expect(result.ok).toBe(true);
    const saved = store.read(DIR);
    expect(saved.edits.cameraShots.overrides[SHOT_ORPHAN]).toBeUndefined();
    expect(saved.edits.cameraShots.overrides[SHOT_25000]).toEqual({
      cameraId: 'cam_B',
    });
  });

  it('★カメラ：削除指定は配列の要素を差し替える', () => {
    const store = setup(
      withEdits((e) => {
        e.cameraShots.deletedIds = [SHOT_ORPHAN];
      }),
    );
    const result = reattachRecoveryEdit(
      {
        projectPath: DIR,
        domain: 'cameraShot',
        sourceId: SHOT_ORPHAN,
        targetId: SHOT_25000,
        expectedUpdatedAt: updatedAt(store),
      },
      store.deps,
    );
    expect(result.ok).toBe(true);
    const saved = store.read(DIR);
    expect(saved.edits.cameraShots.deletedIds).toEqual([SHOT_25000]);
  });

  it('★埋まっている要素へは付け替えさせない（先客を押し出さない）', () => {
    const store = setup(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: '後から来た' };
        e.subtitles[SUB_0] = { text: '先客' };
      }),
    );
    const result = reattachRecoveryEdit(
      {
        projectPath: DIR,
        domain: 'subtitle',
        sourceId: SUB_ORPHAN,
        targetId: SUB_0,
        expectedUpdatedAt: updatedAt(store),
      },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('INVALID_REQUEST');
    // ★保存していない。先客も孤立側も無傷。
    expect(store.saveCount()).toBe(0);
    expect(store.read(DIR).edits.subtitles[SUB_0]).toEqual({ text: '先客' });
    expect(store.read(DIR).edits.subtitles[SUB_ORPHAN]).toEqual({
      text: '後から来た',
    });
  });

  it('孤立していない修正は付け替えさせない', () => {
    const store = setup(
      withEdits((e) => {
        e.subtitles[SUB_0] = { text: '適用済み' };
      }),
    );
    const result = reattachRecoveryEdit(
      {
        projectPath: DIR,
        domain: 'subtitle',
        sourceId: SUB_0,
        targetId: SUB_2500,
        expectedUpdatedAt: updatedAt(store),
      },
      store.deps,
    );
    expect(result.ok).toBe(false);
    expect(store.saveCount()).toBe(0);
  });

  it('存在しない付け替え先は拒否する', () => {
    const store = setup(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: '孤立' };
      }),
    );
    const result = reattachRecoveryEdit(
      {
        projectPath: DIR,
        domain: 'subtitle',
        sourceId: SUB_ORPHAN,
        targetId: 'sub-00999999',
        expectedUpdatedAt: updatedAt(store),
      },
      store.deps,
    );
    expect(result.ok).toBe(false);
    expect(store.saveCount()).toBe(0);
  });

  it('★競合更新を検出して保存しない', () => {
    const store = setup(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: '孤立' };
      }),
    );
    const stale = updatedAt(store);
    store.touchExternally(DIR);

    const result = reattachRecoveryEdit(
      {
        projectPath: DIR,
        domain: 'subtitle',
        sourceId: SUB_ORPHAN,
        targetId: SUB_2500,
        expectedUpdatedAt: stale,
      },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.conflict).toBe(true);
    expect(store.saveCount()).toBe(0);
  });

  it('★履歴に「どこから移したか」を残す', () => {
    const store = setup(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: '孤立' };
      }),
    );
    reattachRecoveryEdit(
      {
        projectPath: DIR,
        domain: 'subtitle',
        sourceId: SUB_ORPHAN,
        targetId: SUB_2500,
        expectedUpdatedAt: updatedAt(store),
      },
      store.deps,
    );
    const history = store.read(DIR).edits.history;
    const entry = history.find((h) => h.field === 'reattachedFrom');
    expect(entry).toBeDefined();
    expect(entry?.before).toBe(SUB_ORPHAN);
    expect(entry?.after).toBe(SUB_2500);
    expect(entry?.targetId).toBe(SUB_2500);
  });
});

// ═══════════════════════════════════════════════════════
describe('discardRecoveryEdit：破棄', () => {
  it('★4ドメインすべてで ok を返し、edits から消える', () => {
    const cases: {
      domain: 'subtitle' | 'short' | 'cameraShot' | 'marker';
      sourceId: string;
      mutate: (e: EditsLike) => void;
      remains: (p: ProjectLike) => unknown;
    }[] = [
      {
        domain: 'subtitle',
        sourceId: SUB_ORPHAN,
        mutate: (e) => {
          e.subtitles[SUB_ORPHAN] = { text: 'x' };
        },
        remains: (p) => p.edits.subtitles[SUB_ORPHAN],
      },
      {
        domain: 'short',
        sourceId: SHORT_ORPHAN,
        mutate: (e) => {
          e.shorts[SHORT_ORPHAN] = { adopted: true };
        },
        remains: (p) => p.edits.shorts[SHORT_ORPHAN],
      },
      {
        domain: 'marker',
        sourceId: MARKER_ORPHAN,
        mutate: (e) => {
          e.markers[MARKER_ORPHAN] = { comment: 'x' };
        },
        remains: (p) => p.edits.markers[MARKER_ORPHAN],
      },
      {
        domain: 'cameraShot',
        sourceId: SHOT_ORPHAN,
        mutate: (e) => {
          e.cameraShots.deletedIds = [SHOT_ORPHAN];
        },
        remains: (p) =>
          p.edits.cameraShots.deletedIds.includes(SHOT_ORPHAN) ? 'still' : undefined,
      },
    ];

    for (const c of cases) {
      const store = setup(withEdits(c.mutate));
      const result = discardRecoveryEdit(
        {
          projectPath: DIR,
          domain: c.domain,
          sourceId: c.sourceId,
          expectedUpdatedAt: updatedAt(store),
        },
        store.deps,
      );
      // ★ここが要点：保存が成功したなら ok:true を返すこと。
      expect(result.ok, `${c.domain} が ok を返していない`).toBe(true);
      expect(c.remains(store.read(DIR))).toBeUndefined();
      if (result.ok) expect(result.counts.total).toBe(0);
    }
  });

  it('適用済みの修正を破棄すると解析結果の値に戻る', () => {
    const store = setup(
      withEdits((e) => {
        e.markers[TOPIC] = { name: '人が付けた章タイトル' };
      }),
    );
    const result = discardRecoveryEdit(
      {
        projectPath: DIR,
        domain: 'marker',
        sourceId: TOPIC,
        expectedUpdatedAt: updatedAt(store),
      },
      store.deps,
    );
    expect(result.ok).toBe(true);
    expect(store.read(DIR).edits.markers[TOPIC]).toBeUndefined();
  });

  it('★analysis は変わらない', () => {
    const store = setup(
      withEdits((e) => {
        e.markers[LAUGH] = { name: 'x' };
      }),
    );
    const before = analysisFingerprint(store.read(DIR));
    discardRecoveryEdit(
      {
        projectPath: DIR,
        domain: 'marker',
        sourceId: LAUGH,
        expectedUpdatedAt: updatedAt(store),
      },
      store.deps,
    );
    expect(analysisFingerprint(store.read(DIR))).toBe(before);
  });

  it('存在しない修正の破棄は拒否し、保存しない', () => {
    const store = setup();
    const result = discardRecoveryEdit(
      {
        projectPath: DIR,
        domain: 'subtitle',
        sourceId: SUB_ORPHAN,
        expectedUpdatedAt: updatedAt(store),
      },
      store.deps,
    );
    expect(result.ok).toBe(false);
    expect(store.saveCount()).toBe(0);
  });

  it('★競合更新を検出して保存しない', () => {
    const store = setup(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: 'x' };
      }),
    );
    const stale = updatedAt(store);
    store.touchExternally(DIR);

    const result = discardRecoveryEdit(
      {
        projectPath: DIR,
        domain: 'subtitle',
        sourceId: SUB_ORPHAN,
        expectedUpdatedAt: stale,
      },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.conflict).toBe(true);
    expect(store.saveCount()).toBe(0);
  });

  it('保存に失敗したら内容を変えずにエラーを返す', () => {
    const store = setup(
      withEdits((e) => {
        e.subtitles[SUB_ORPHAN] = { text: 'x' };
      }),
    );
    store.failNextSave();
    const result = discardRecoveryEdit(
      {
        projectPath: DIR,
        domain: 'subtitle',
        sourceId: SUB_ORPHAN,
        expectedUpdatedAt: updatedAt(store),
      },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.userMessage).toContain('変更されていません');
    expect(store.read(DIR).edits.subtitles[SUB_ORPHAN]).toEqual({ text: 'x' });
  });
});
