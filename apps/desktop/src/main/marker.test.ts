/**
 * マーカーの組み立てと、修正・削除の保存。
 *
 * ★このテストの主眼は3つ。
 * 1. `analysis` が変わらないこと（書き換わるのは edits.markers と history だけ）
 * 2. ★volatileId（CHECK系は再解析で修正が必ず外れる）を正しく判定すること
 * 3. ★種別をまたぐ再接続を検出すること（章タイトルが笑いマーカーに乗る事故）
 *
 * ffmpeg / faster-whisper は起動しない。`resolveProject` は本物を使う。
 */

import { describe, expect, it } from 'vitest';

import {
  applyMarkerEdit,
  buildMarkerData,
  countsOf,
  deleteMarker,
  duplicateMarkerIds,
  EXPORT_NOTICE,
  isVolatileId,
  kindCountsOf,
  kindFromId,
  kindLabelOf,
  markerEditsOf,
  NAME_PREFIX_NOTICE,
  removeMarkerEdit,
} from './marker.ts';
import type { ProjectLike } from './review.ts';
import { createFakeStore, markerFixture, projectFixture } from './testing/fake-core.ts';

const DIR = '/tmp/ep012';
const TOPIC = 'mk-TOPIC-00000000';
const CHECK = 'mk-CHECK-check-lowconf-7700';
const LAUGH = 'mk-LAUGH-00033990';

function setup(project: ProjectLike = projectFixture()) {
  return createFakeStore({ [DIR]: project });
}

function loadOk(store: ReturnType<typeof setup>) {
  const result = buildMarkerData(DIR, store.deps);
  if (!result.ok) throw new Error(`load failed: ${result.error.userMessage}`);
  return result.data;
}

function saveOk(result: ReturnType<typeof applyMarkerEdit>) {
  if (!result.ok) throw new Error(`save failed: ${result.error.userMessage}`);
  return result;
}

describe('読み込み', () => {
  it('解析のマーカーをすべて返す', () => {
    const data = loadOk(setup());
    expect(data.markers).toHaveLength(3);
    expect(data.markers.map((m) => m.id)).toEqual([TOPIC, CHECK, LAUGH]);
  });

  it('種別の日本語表示を付ける', () => {
    const markers = loadOk(setup()).markers;
    expect(markers[0]!.kindLabel).toBe('話題');
    expect(markers[1]!.kindLabel).toBe('要確認');
    expect(markers[2]!.kindLabel).toBe('笑い');
  });

  it('区間を持つマーカー（LAUGH）は endSec も返す', () => {
    const markers = loadOk(setup()).markers;
    expect(markers[2]!.endSec).toBe(36.01);
    expect(markers[0]!.endSec).toBeUndefined();
  });

  it('種別ごとの件数を返す（絞り込み用）', () => {
    const kinds = loadOk(setup()).kinds;
    expect(kinds).toEqual([
      { kind: 'TOPIC', label: '話題', count: 1 },
      { kind: 'LAUGH', label: '笑い', count: 1 },
      { kind: 'CHECK', label: '要確認', count: 1 },
    ]);
  });

  it('修正前はすべて未編集', () => {
    const data = loadOk(setup());
    expect(data.markers.every((m) => !m.edited)).toBe(true);
    expect(data.counts).toMatchObject({ markers: 3, edited: 0, deleted: 0, orphaned: 0 });
  });

  it('★再出力の注意書きを必ず載せる（画面から消せないようにするため）', () => {
    const data = loadOk(setup());
    expect(data.exportNotice).toBe(EXPORT_NOTICE);
    expect(data.exportNotice).toContain('FCP7 XML');
    expect(data.namePrefixNotice).toBe(NAME_PREFIX_NOTICE);
    expect(data.namePrefixNotice).toContain('[TOPIC]');
  });

  it('★時刻編集・マーカー追加が未対応であることを示す', () => {
    const data = loadOk(setup());
    expect(data.timeEditingSupported).toBe(false);
    expect(data.markerCreationSupported).toBe(false);
  });

  it('★syncMode が common のときだけ除外の注意を出す', () => {
    expect(loadOk(setup()).syncModeNotice).toBeUndefined();
    const project = projectFixture();
    project.sync = { mode: 'common', offsets: {} };
    expect(loadOk(setup(project)).syncModeNotice).toContain('共通区間');
  });

  it('★DTOに素材の絶対パス・analysis・edits を含めない', () => {
    const serialized = JSON.stringify(loadOk(setup()));
    expect(serialized).not.toContain('/tmp/ep012/raw/wide.mp4');
    expect(serialized).not.toContain('"analysis"');
    expect(serialized).not.toContain('"edits"');
    expect(serialized).not.toContain('"words"');
  });

  it('解析前のプロジェクトは ANALYSIS_NOT_READY で断る', () => {
    const project = projectFixture();
    delete project.analysis;
    const result = buildMarkerData(DIR, setup(project).deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ANALYSIS_NOT_READY');
  });

  it('markers が無い旧形式でも落ちずに0件で開ける', () => {
    const project = projectFixture();
    project.analysis = { subtitles: project.analysis!.subtitles };
    const data = loadOk(setup(project));
    expect(data.markers).toEqual([]);
    expect(data.counts.markers).toBe(0);
  });

  it('project.json を読めなければ INVALID_PROJECT を返す', () => {
    const result = buildMarkerData('/tmp/none', setup().deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_PROJECT');
  });
});

describe('★volatileId — 再解析で修正が外れるマーカー', () => {
  it('★CHECK は volatileId が立つ（IDが時刻を含まない）', () => {
    const data = loadOk(setup());
    const check = data.markers.find((m) => m.id === CHECK)!;
    expect(check.volatileId).toBe(true);
  });

  it('★TOPIC / LAUGH は volatileId が立たない（時刻キー）', () => {
    const data = loadOk(setup());
    expect(data.markers.find((m) => m.id === TOPIC)!.volatileId).toBe(false);
    expect(data.markers.find((m) => m.id === LAUGH)!.volatileId).toBe(false);
  });

  it('件数に出る', () => {
    expect(loadOk(setup()).counts.volatile).toBe(1);
  });

  it('★volatile でも編集は許可する（永続化されない旨を示したうえで使わせる）', () => {
    const store = setup();
    const saved = saveOk(
      applyMarkerEdit(
        {
          projectPath: DIR,
          markerId: CHECK,
          expectedUpdatedAt: loadOk(store).updatedAt,
          patch: { name: '聞き直す' },
        },
        store.deps,
      ),
    );
    expect(saved.marker?.name).toBe('聞き直す');
    expect(saved.marker?.volatileId).toBe(true);
  });

  it('isVolatileId は本物の timeFromId と同じ判定をする', () => {
    // 実データから採取したIDそのもの。
    expect(isVolatileId('mk-CHECK-check-lowconf-7700')).toBe(true);
    expect(isVolatileId('mk-CHECK-check-sync-camA')).toBe(true);
    expect(isVolatileId('mk-TOPIC-00000000')).toBe(false);
    expect(isVolatileId('mk-LAUGH-00033990')).toBe(false);
  });
});

describe('名前・コメントの修正', () => {
  it('名前を修正して読み直しても残る', () => {
    const store = setup();
    const saved = saveOk(
      applyMarkerEdit(
        {
          projectPath: DIR,
          markerId: TOPIC,
          expectedUpdatedAt: loadOk(store).updatedAt,
          patch: { name: '第1章：導入' },
        },
        store.deps,
      ),
    );
    expect(saved.marker?.name).toBe('第1章：導入');
    expect(saved.marker?.edited).toBe(true);
    expect(loadOk(store).markers[0]!.name).toBe('第1章：導入');
  });

  it('コメントも修正できる', () => {
    const store = setup();
    const saved = saveOk(
      applyMarkerEdit(
        {
          projectPath: DIR,
          markerId: LAUGH,
          expectedUpdatedAt: loadOk(store).updatedAt,
          patch: { comment: 'ここは使える' },
        },
        store.deps,
      ),
    );
    expect(saved.marker?.comment).toBe('ここは使える');
  });

  it('★コメントを空文字にできる（名前と違い意図的に消せる）', () => {
    const store = setup();
    const saved = saveOk(
      applyMarkerEdit(
        {
          projectPath: DIR,
          markerId: LAUGH,
          expectedUpdatedAt: loadOk(store).updatedAt,
          patch: { comment: '' },
        },
        store.deps,
      ),
    );
    expect(saved.marker?.comment).toBe('');
  });

  it('解析の元の値を併せて返す（比較・復元できるように）', () => {
    const store = setup();
    applyMarkerEdit(
      {
        projectPath: DIR,
        markerId: TOPIC,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { name: '第1章' },
      },
      store.deps,
    );
    const marker = loadOk(store).markers[0]!;
    expect(marker.analysisName).toBe('オープニング');
    expect(marker.analysisComment).toContain('章タイトル');
  });

  it('null を渡すと解析値に戻る', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      applyMarkerEdit(
        { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: updatedAt, patch: { name: '第1章' } },
        store.deps,
      ),
    ).updatedAt;

    const reverted = saveOk(
      applyMarkerEdit(
        { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: updatedAt, patch: { name: null } },
        store.deps,
      ),
    );
    expect(reverted.marker?.name).toBe('オープニング');
    expect(reverted.marker?.edited).toBe(false);
    expect(markerEditsOf(store.read(DIR).edits)[TOPIC]).toBeUndefined();
  });

  it('指定しなかった項目は変更されない', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      applyMarkerEdit(
        { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: updatedAt, patch: { name: '第1章' } },
        store.deps,
      ),
    ).updatedAt;

    const next = saveOk(
      applyMarkerEdit(
        { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: updatedAt, patch: { comment: 'メモ' } },
        store.deps,
      ),
    );
    expect(next.marker?.name).toBe('第1章');
    expect(next.marker?.comment).toBe('メモ');
  });
});

describe('★analysis を書き換えない', () => {
  it('保存の前後で analysis が完全一致する', () => {
    const store = setup();
    const before = JSON.stringify(store.read(DIR).analysis);

    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      applyMarkerEdit(
        { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: updatedAt, patch: { name: 'X', comment: 'Y' } },
        store.deps,
      ),
    ).updatedAt;
    saveOk(deleteMarker({ projectPath: DIR, markerId: LAUGH, expectedUpdatedAt: updatedAt }, store.deps));

    expect(JSON.stringify(store.read(DIR).analysis)).toBe(before);
  });

  it('★書き換わるのは edits.markers と edits.history だけ', () => {
    const store = setup();
    const before = store.read(DIR);
    saveOk(
      applyMarkerEdit(
        { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: loadOk(store).updatedAt, patch: { name: 'X' } },
        store.deps,
      ),
    );
    const after = store.read(DIR);

    expect(after.edits.subtitles).toEqual(before.edits.subtitles);
    expect(after.edits.shorts).toEqual(before.edits.shorts);
    expect(after.edits.cameraShots).toEqual(before.edits.cameraShots);
    expect(after.edits.chapters).toEqual(before.edits.chapters);
    expect(after.edits.syncOffsets).toEqual(before.edits.syncOffsets);

    expect(markerEditsOf(after.edits)[TOPIC]).toEqual({ name: 'X' });
    expect(after.edits.history.length).toBeGreaterThan(before.edits.history.length);
  });

  it('他画面の修正はマーカーの保存で消えない', () => {
    const project = projectFixture();
    project.edits.subtitles = { 'sub-00000000': { text: '人が直した本文' } };
    project.edits.shorts = { short_01: { adopted: true } };
    const store = setup(project);

    saveOk(
      applyMarkerEdit(
        { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: loadOk(store).updatedAt, patch: { name: 'X' } },
        store.deps,
      ),
    );

    expect(store.read(DIR).edits.subtitles).toEqual({
      'sub-00000000': { text: '人が直した本文' },
    });
    expect(store.read(DIR).edits.shorts).toEqual({ short_01: { adopted: true } });
  });
});

describe('履歴', () => {
  it('名前の修正が履歴に残る（kind は marker）', () => {
    const store = setup();
    saveOk(
      applyMarkerEdit(
        { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: loadOk(store).updatedAt, patch: { name: '第1章' } },
        store.deps,
      ),
    );
    const entry = store.read(DIR).edits.history.find((h) => h.field === 'name');
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('marker');
    expect(entry!.targetId).toBe(TOPIC);
    expect(entry!.before).toBe('オープニング');
    expect(entry!.after).toBe('第1章');
  });

  it('削除も履歴に残す（何を消したか分かるように中身ごと）', () => {
    const store = setup();
    saveOk(
      deleteMarker({ projectPath: DIR, markerId: LAUGH, expectedUpdatedAt: loadOk(store).updatedAt }, store.deps),
    );
    const entry = store.read(DIR).edits.history.find((h) => h.field === 'deleted');
    expect(entry!.before).toMatchObject({ id: LAUGH, kind: 'LAUGH' });
  });

  it('★値が変わらない保存では履歴を増やさない', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      applyMarkerEdit(
        { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: updatedAt, patch: { name: '第1章' } },
        store.deps,
      ),
    ).updatedAt;
    const length = store.read(DIR).edits.history.length;

    saveOk(
      applyMarkerEdit(
        { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: updatedAt, patch: { name: '第1章' } },
        store.deps,
      ),
    );
    expect(store.read(DIR).edits.history.length).toBe(length);
  });
});

describe('★競合更新の検出', () => {
  it('古い updatedAt では上書きせず conflict を返す', () => {
    const store = setup();
    const data = loadOk(store);
    store.touchExternally(DIR);

    const result = applyMarkerEdit(
      { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: data.updatedAt, patch: { name: 'X' } },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe(true);
      expect(result.error.code).toBe('PROJECT_CHANGED');
    }
    expect(markerEditsOf(store.read(DIR).edits)[TOPIC]).toBeUndefined();
  });

  it('削除・取り消しでも競合を検出する', () => {
    for (const run of [
      (store: ReturnType<typeof setup>, updatedAt: string) =>
        deleteMarker({ projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: updatedAt }, store.deps),
      (store: ReturnType<typeof setup>, updatedAt: string) =>
        removeMarkerEdit({ projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: updatedAt }, store.deps),
    ]) {
      const store = setup();
      const data = loadOk(store);
      store.touchExternally(DIR);
      const result = run(store, data.updatedAt);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.conflict).toBe(true);
    }
  });

  it('保存のたびに updatedAt が変わり、古い値での連続保存は弾かれる', () => {
    const store = setup();
    const first = loadOk(store);
    const saved = saveOk(
      applyMarkerEdit(
        { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: first.updatedAt, patch: { name: 'X' } },
        store.deps,
      ),
    );
    expect(saved.updatedAt).not.toBe(first.updatedAt);

    const stale = applyMarkerEdit(
      { projectPath: DIR, markerId: LAUGH, expectedUpdatedAt: first.updatedAt, patch: { name: 'Y' } },
      store.deps,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.conflict).toBe(true);
  });
});

describe('削除と取り消し', () => {
  it('削除すると一覧から消える（marker は返さない）', () => {
    const store = setup();
    const result = deleteMarker(
      { projectPath: DIR, markerId: LAUGH, expectedUpdatedAt: loadOk(store).updatedAt },
      store.deps,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.marker).toBeUndefined();
      expect(result.counts.markers).toBe(2);
      expect(result.counts.deleted).toBe(1);
    }
    expect(loadOk(store).markers.map((m) => m.id)).toEqual([TOPIC, CHECK]);
  });

  it('★解析結果からは消さない（戻せる状態を保つ）', () => {
    const store = setup();
    saveOk(
      deleteMarker({ projectPath: DIR, markerId: LAUGH, expectedUpdatedAt: loadOk(store).updatedAt }, store.deps),
    );
    expect(store.read(DIR).analysis!.markers!.some((m) => m.id === LAUGH)).toBe(true);
    expect(markerEditsOf(store.read(DIR).edits)[LAUGH]).toEqual({ deleted: true });
  });

  it('削除を取り消すとマーカーが戻る', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      deleteMarker({ projectPath: DIR, markerId: LAUGH, expectedUpdatedAt: updatedAt }, store.deps),
    ).updatedAt;

    const restored = saveOk(
      removeMarkerEdit({ projectPath: DIR, markerId: LAUGH, expectedUpdatedAt: updatedAt }, store.deps),
    );
    expect(restored.counts.markers).toBe(3);
    expect(restored.counts.deleted).toBe(0);
  });

  it('★全マーカーを削除できる（XMLはマーカー0件でも正常）', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    for (const id of [TOPIC, CHECK, LAUGH]) {
      updatedAt = saveOk(
        deleteMarker({ projectPath: DIR, markerId: id, expectedUpdatedAt: updatedAt }, store.deps),
      ).updatedAt;
    }
    expect(loadOk(store).markers).toEqual([]);
  });

  it('二重削除を拒否する', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      deleteMarker({ projectPath: DIR, markerId: LAUGH, expectedUpdatedAt: updatedAt }, store.deps),
    ).updatedAt;
    const again = deleteMarker(
      { projectPath: DIR, markerId: LAUGH, expectedUpdatedAt: updatedAt },
      store.deps,
    );
    expect(again.ok).toBe(false);
  });

  it('削除済みのマーカーは修正できない', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      deleteMarker({ projectPath: DIR, markerId: LAUGH, expectedUpdatedAt: updatedAt }, store.deps),
    ).updatedAt;

    const result = applyMarkerEdit(
      { projectPath: DIR, markerId: LAUGH, expectedUpdatedAt: updatedAt, patch: { name: 'X' } },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.userMessage).toContain('削除済み');
  });

  it('修正が無いマーカーの取り消しは MARKER_NOT_FOUND', () => {
    const store = setup();
    const result = removeMarkerEdit(
      { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: loadOk(store).updatedAt },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MARKER_NOT_FOUND');
  });

  it('★他のマーカーの修正は消えない', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      applyMarkerEdit(
        { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: updatedAt, patch: { name: 'X' } },
        store.deps,
      ),
    ).updatedAt;
    updatedAt = saveOk(
      applyMarkerEdit(
        { projectPath: DIR, markerId: LAUGH, expectedUpdatedAt: updatedAt, patch: { name: 'Y' } },
        store.deps,
      ),
    ).updatedAt;

    removeMarkerEdit({ projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: updatedAt }, store.deps);
    expect(markerEditsOf(store.read(DIR).edits)[LAUGH]).toEqual({ name: 'Y' });
  });
});

describe('★再接続と種別またぎ', () => {
  it('時刻キーのIDは再解析で位置がずれても繋ぎ直され、画面に知らせる', () => {
    const store = setup();
    saveOk(
      applyMarkerEdit(
        { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: loadOk(store).updatedAt, patch: { name: '第1章' } },
        store.deps,
      ),
    );

    // 再解析で TOPIC の位置が 0.2 秒ずれた状況。
    const project = store.read(DIR);
    project.analysis!.markers = [
      markerFixture('TOPIC', 0.2, 'オープニング', '章タイトル'),
      markerFixture('LAUGH', 33.99, '笑い（2.0秒）', '関与: A, B', { endSec: 36.01 }),
    ];
    store.deps.saveProject(DIR, project);

    const data = loadOk(store);
    const reattached = data.markers.find((m) => m.reattached !== undefined)!;
    expect(reattached.reattached!.fromId).toBe(TOPIC);
    expect(reattached.reattached!.deltaSec).toBeCloseTo(0.2, 3);
    expect(reattached.name).toBe('第1章'); // 修正は失われていない
    expect(data.counts.reattached).toBe(1);
    expect(data.counts.kindMismatch).toBe(0);
  });

  it('★★種別をまたぐ再接続を検出する（章タイトルが笑いマーカーに乗る事故）', () => {
    const store = setup();
    saveOk(
      applyMarkerEdit(
        { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: loadOk(store).updatedAt, patch: { name: '第2章：本題へ' } },
        store.deps,
      ),
    );

    // 再解析で TOPIC が消え、近い時刻に LAUGH だけが残った状況。
    const project = store.read(DIR);
    project.analysis!.markers = [
      markerFixture('LAUGH', 0.1, '笑い（1.0秒）', '関与: A', { endSec: 1.1 }),
    ];
    store.deps.saveProject(DIR, project);

    const data = loadOk(store);
    const mismatched = data.markers.find((m) => m.reattachedKindMismatch !== undefined)!;
    expect(mismatched).toBeDefined();
    expect(mismatched.kind).toBe('LAUGH');
    expect(mismatched.name).toBe('第2章：本題へ'); // ★章タイトルが笑いに乗っている
    expect(mismatched.reattachedKindMismatch).toEqual({
      fromKind: 'TOPIC',
      toKind: 'LAUGH',
    });
    expect(data.counts.kindMismatch).toBe(1);
    // ★自動で取り消さない。検出して提示するだけ。
    expect(mismatched.edited).toBe(true);
  });

  it('kindFromId はIDから種別を読み取る', () => {
    expect(kindFromId('mk-TOPIC-00000000')).toBe('TOPIC');
    expect(kindFromId('mk-CHECK-check-lowconf-7700')).toBe('CHECK');
    expect(kindFromId('sub-00000000')).toBeUndefined();
  });
});

describe('★孤立した修正', () => {
  it('CHECK の修正は再解析でIDが変われば必ず孤立し、内容ごと返る', () => {
    const store = setup();
    saveOk(
      applyMarkerEdit(
        { projectPath: DIR, markerId: CHECK, expectedUpdatedAt: loadOk(store).updatedAt, patch: { name: '聞き直す', comment: 'ここ重要' } },
        store.deps,
      ),
    );

    // 再解析で低confidence区間がずれ、check.id が変わった状況。
    const project = store.read(DIR);
    project.analysis!.markers = [
      markerFixture('CHECK', 7.9, '要確認', '低confidence', { checkId: 'check-lowconf-7900' }),
    ];
    store.deps.saveProject(DIR, project);

    const data = loadOk(store);
    expect(data.orphaned).toHaveLength(1);
    expect(data.orphaned[0]!.originalId).toBe(CHECK);
    expect(data.orphaned[0]!.name).toBe('聞き直す');
    expect(data.orphaned[0]!.comment).toBe('ここ重要');
    expect(data.orphaned[0]!.reason).toContain('IDから時刻を読み取れず');
    // ★project.json からは消さない。
    expect(markerEditsOf(store.read(DIR).edits)[CHECK]).toBeDefined();
  });

  it('削除指定が孤立した場合も知らせる', () => {
    const store = setup();
    saveOk(
      deleteMarker({ projectPath: DIR, markerId: CHECK, expectedUpdatedAt: loadOk(store).updatedAt }, store.deps),
    );
    const project = store.read(DIR);
    project.analysis!.markers = [markerFixture('TOPIC', 0, 'オープニング', '章タイトル')];
    store.deps.saveProject(DIR, project);

    const orphan = loadOk(store).orphaned.find((o) => o.originalId === CHECK);
    expect(orphan).toBeDefined();
    expect(orphan!.deleted).toBe(true);
  });
});

describe('★IDの重複', () => {
  /** 同じ種別・同じ開始時刻のマーカーを2件作る（markerId に連番が無いため衝突する）。 */
  function withDuplicate() {
    const project = projectFixture();
    project.analysis!.markers = [
      markerFixture('TOPIC', 0, 'オープニング', 'A'),
      markerFixture('TOPIC', 0, '別の章', 'B'),
    ];
    return project;
  }

  it('重複を検出し、編集不可にする', () => {
    const data = loadOk(setup(withDuplicate()));
    expect(data.counts.duplicateId).toBe(2);
    expect(data.markers.every((m) => m.duplicateId && !m.editable)).toBe(true);
  });

  it('★重複しているマーカーの修正を拒否する（両方に適用されてしまうため）', () => {
    const store = setup(withDuplicate());
    const result = applyMarkerEdit(
      { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: loadOk(store).updatedAt, patch: { name: 'X' } },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MARKER_NOT_EDITABLE');
  });

  it('★重複しているマーカーの削除も拒否する', () => {
    const store = setup(withDuplicate());
    const result = deleteMarker(
      { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: loadOk(store).updatedAt },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MARKER_NOT_EDITABLE');
  });

  it('重複が無ければ編集できる', () => {
    const data = loadOk(setup());
    expect(data.counts.duplicateId).toBe(0);
    expect(data.markers.every((m) => m.editable)).toBe(true);
  });

  it('duplicateMarkerIds は重複だけを返す', () => {
    const map = duplicateMarkerIds([{ id: 'a' }, { id: 'a' }, { id: 'b' }]);
    expect([...map.entries()]).toEqual([['a', 2]]);
  });
});

describe('存在しないマーカー', () => {
  it('解析に無いIDは MARKER_NOT_FOUND', () => {
    const store = setup();
    const updatedAt = loadOk(store).updatedAt;
    for (const result of [
      applyMarkerEdit(
        { projectPath: DIR, markerId: 'mk-TOPIC-99999999', expectedUpdatedAt: updatedAt, patch: { name: 'X' } },
        store.deps,
      ),
      deleteMarker(
        { projectPath: DIR, markerId: 'mk-TOPIC-99999999', expectedUpdatedAt: updatedAt },
        store.deps,
      ),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('MARKER_NOT_FOUND');
    }
  });
});

describe('保存の失敗', () => {
  it('保存に失敗したら「変更されていない」ことを伝える', () => {
    const store = setup();
    store.failNextSave();
    const result = applyMarkerEdit(
      { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: loadOk(store).updatedAt, patch: { name: 'X' } },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.userMessage).toContain('変更されていません');
    expect(markerEditsOf(store.read(DIR).edits)[TOPIC]).toBeUndefined();
  });

  it('★保存の失敗時にDTOへ技術的な詳細を載せない', () => {
    const store = setup();
    store.failNextSave('ENOSPC: no space left on device');
    const result = applyMarkerEdit(
      { projectPath: DIR, markerId: TOPIC, expectedUpdatedAt: loadOk(store).updatedAt, patch: { name: 'X' } },
      store.deps,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('ENOSPC');
    expect(serialized).not.toContain('technicalMessage');
  });
});

describe('純粋関数', () => {
  it('kindLabelOf は未知の種別をそのまま返す', () => {
    expect(kindLabelOf('TOPIC')).toBe('話題');
    expect(kindLabelOf('UNKNOWN')).toBe('UNKNOWN');
  });

  it('kindCountsOf は表示順（TOPIC→LAUGH→CHECK）に並べる', () => {
    const items = [
      { kind: 'CHECK' },
      { kind: 'TOPIC' },
      { kind: 'LAUGH' },
      { kind: 'CHECK' },
    ] as never;
    expect(kindCountsOf(items).map((k) => k.kind)).toEqual(['TOPIC', 'LAUGH', 'CHECK']);
    expect(kindCountsOf(items).find((k) => k.kind === 'CHECK')!.count).toBe(2);
  });

  it('markerEditsOf は欠けた構造を空で補う（旧形式でも落ちない）', () => {
    expect(markerEditsOf({ subtitles: {}, shorts: {}, history: [] } as never)).toEqual({});
  });

  it('countsOf は各件数を数える', () => {
    const markers = [
      { edited: true, volatileId: true, duplicateId: false, reattached: undefined, reattachedKindMismatch: undefined },
      { edited: false, volatileId: false, duplicateId: false, reattached: { fromId: 'x', deltaSec: 1 }, reattachedKindMismatch: { fromKind: 'A', toKind: 'B' } },
    ] as never;
    expect(countsOf(markers, [], 2)).toMatchObject({
      markers: 2,
      edited: 1,
      deleted: 2,
      reattached: 1,
      kindMismatch: 1,
      volatile: 1,
    });
  });
});
