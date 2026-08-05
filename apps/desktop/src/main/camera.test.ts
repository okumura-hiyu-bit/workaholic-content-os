/**
 * カメラ切替の組み立てと、変更・追加・削除の保存。
 *
 * ★このテストの主眼は3つ。
 * 1. `analysis` が変わらないこと（書き換わるのは edits.cameraShots と history だけ）
 * 2. FCP7 XML を壊すデータを保存させないこと（重なり・未知カメラ・ゼロ長・空）
 * 3. 再接続（reattached）を画面へ届けること
 *
 * ffmpeg / faster-whisper は起動しない。`resolveProject` は本物を使う。
 */

import { describe, expect, it } from 'vitest';

import {
  applyCameraShotEdit,
  assertTimelineSafe,
  buildCameraData,
  cameraEditsOf,
  cameraOptionsOf,
  deleteCameraShot,
  EXPORT_NOTICE,
  insertCameraShot,
  insertedShotId,
  INSERTED_SHOT_REASON,
  previewShots,
  removeCameraEdit,
  timelineDurationOf,
} from './camera.ts';
import type { ProjectLike } from './review.ts';
import {
  cameraShotFixture,
  createFakeStore,
  projectFixture,
} from './testing/fake-core.ts';

const DIR = '/tmp/ep012';
const FIRST = 'shot-00000000'; // 0〜10秒 wide
const SECOND = 'shot-00010000'; // 10〜25秒 cam_A
const THIRD = 'shot-00025000'; // 25〜40秒 cam_B

function setup(project: ProjectLike = projectFixture()) {
  return createFakeStore({ [DIR]: project });
}

function loadOk(store: ReturnType<typeof setup>) {
  const result = buildCameraData(DIR, store.deps);
  if (!result.ok) throw new Error(`load failed: ${result.error.userMessage}`);
  return result.data;
}

function saveOk(
  result: ReturnType<typeof applyCameraShotEdit>,
): Extract<ReturnType<typeof applyCameraShotEdit>, { ok: true }> {
  if (!result.ok) throw new Error(`save failed: ${result.error.userMessage}`);
  return result;
}

describe('読み込み', () => {
  it('解析のカットをすべて返す', () => {
    const data = loadOk(setup());
    expect(data.shots).toHaveLength(3);
    expect(data.shots.map((s) => s.id)).toEqual([FIRST, SECOND, THIRD]);
  });

  it('カメラの表示名・理由の日本語を付ける', () => {
    const shots = loadOk(setup()).shots;
    expect(shots[0]!.cameraLabel).toBe('引き');
    expect(shots[1]!.cameraLabel).toBe('寄りA');
    expect(shots[1]!.reasonLabel).toBe('発話');
    expect(shots[2]!.reasonLabel).toBe('リアクション');
  });

  it('★切替先に選べるのは映像素材（wide / cam_*）だけ', () => {
    const data = loadOk(setup());
    expect(data.cameras.map((c) => c.cameraId)).toEqual(['wide', 'cam_A', 'cam_B']);
    // マイクは候補に出さない。
    expect(data.cameras.some((c) => c.cameraId.startsWith('mic_'))).toBe(false);
  });

  it('★cameraId は asset.id ではなく role（XML生成が role で素材を引くため）', () => {
    const data = loadOk(setup());
    // fixture の映像素材は id: 'camA' / role: 'cam_A'。
    expect(data.cameras.map((c) => c.cameraId)).not.toContain('camA');
    expect(data.cameras.map((c) => c.cameraId)).toContain('cam_A');
  });

  it('判断前は未編集・未挿入', () => {
    const data = loadOk(setup());
    expect(data.shots.every((s) => !s.edited && !s.inserted)).toBe(true);
    expect(data.counts).toMatchObject({ shots: 3, edited: 0, inserted: 0, deleted: 0 });
  });

  it('連続したカットは重なりも隙間も無い', () => {
    const data = loadOk(setup());
    expect(data.counts.overlaps).toBe(0);
    expect(data.counts.gaps).toBe(0);
  });

  it('★再出力の注意書きを必ず載せる（画面から消せないようにするため）', () => {
    const data = loadOk(setup());
    expect(data.exportNotice).toBe(EXPORT_NOTICE);
    expect(data.exportNotice).toContain('FCP7 XML');
  });

  it('★syncMode が common のときだけ時刻ずれの注意を出す', () => {
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
    const result = buildCameraData(DIR, setup(project).deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('ANALYSIS_NOT_READY');
  });

  it('cameraShots が無い旧形式でも落ちずに0件で開ける', () => {
    const project = projectFixture();
    project.analysis = { subtitles: project.analysis!.subtitles };
    const data = loadOk(setup(project));
    expect(data.shots).toEqual([]);
    expect(data.counts.shots).toBe(0);
  });

  it('project.json を読めなければ INVALID_PROJECT を返す', () => {
    const result = buildCameraData('/tmp/none', setup().deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_PROJECT');
  });
});

describe('カメラの差し替え', () => {
  it('差し替えて読み直しても残る', () => {
    const store = setup();
    const saved = saveOk(
      applyCameraShotEdit(
        {
          projectPath: DIR,
          shotId: SECOND,
          expectedUpdatedAt: loadOk(store).updatedAt,
          patch: { cameraId: 'cam_B' },
        },
        store.deps,
      ),
    );

    expect(saved.shots[1]!.cameraId).toBe('cam_B');
    expect(saved.shots[1]!.edited).toBe(true);
    expect(loadOk(store).shots[1]!.cameraId).toBe('cam_B');
  });

  it('解析の元の値を併せて返す（比較・復元できるように）', () => {
    const store = setup();
    applyCameraShotEdit(
      {
        projectPath: DIR,
        shotId: SECOND,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { cameraId: 'cam_B' },
      },
      store.deps,
    );
    const shot = loadOk(store).shots[1]!;
    expect(shot.analysisCameraId).toBe('cam_A');
    expect(shot.analysisStartSec).toBe(10);
  });

  it('null を渡すと解析値に戻る', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      applyCameraShotEdit(
        { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt, patch: { cameraId: 'cam_B' } },
        store.deps,
      ),
    ).updatedAt;

    const reverted = saveOk(
      applyCameraShotEdit(
        { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt, patch: { cameraId: null } },
        store.deps,
      ),
    );
    expect(reverted.shots[1]!.cameraId).toBe('cam_A');
    expect(reverted.shots[1]!.edited).toBe(false);
  });

  it('★存在しないカメラは保存しない（XML生成が例外を投げるため）', () => {
    const store = setup();
    const result = applyCameraShotEdit(
      {
        projectPath: DIR,
        shotId: SECOND,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { cameraId: 'cam_Z' },
      },
      store.deps,
    );
    expect(result.ok).toBe(false);
    expect(cameraEditsOf(store.read(DIR).edits).overrides[SECOND]).toBeUndefined();
  });
});

describe('時間軸の変更', () => {
  it('開始・終了を変更できる', () => {
    const store = setup();
    const saved = saveOk(
      applyCameraShotEdit(
        {
          projectPath: DIR,
          shotId: SECOND,
          expectedUpdatedAt: loadOk(store).updatedAt,
          patch: { startSec: 12, endSec: 24 },
        },
        store.deps,
      ),
    );
    expect(saved.shots[1]!.startSec).toBe(12);
    expect(saved.shots[1]!.endSec).toBe(24);
  });

  it('★隣のカットと重なる変更を拒否する', () => {
    const store = setup();
    const result = applyCameraShotEdit(
      {
        projectPath: DIR,
        shotId: SECOND,
        // 直前のカット（0〜10）に食い込む。
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { startSec: 5 },
      },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.userMessage).toContain('重なっています');
    expect(cameraEditsOf(store.read(DIR).edits).overrides[SECOND]).toBeUndefined();
  });

  it('★ゼロ長になる変更を拒否する（XMLで黙って消えるため）', () => {
    const store = setup();
    const result = applyCameraShotEdit(
      {
        projectPath: DIR,
        shotId: SECOND,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { endSec: 10 },
      },
      store.deps,
    );
    expect(result.ok).toBe(false);
  });

  it('★素材の尺を超える変更を拒否する', () => {
    const store = setup();
    const result = applyCameraShotEdit(
      {
        projectPath: DIR,
        shotId: THIRD,
        expectedUpdatedAt: loadOk(store).updatedAt,
        patch: { endSec: 5000 },
      },
      store.deps,
    );
    expect(result.ok).toBe(false);
  });

  it('隙間ができる変更は許すが、警告として数える', () => {
    const store = setup();
    const saved = saveOk(
      applyCameraShotEdit(
        {
          projectPath: DIR,
          shotId: SECOND,
          expectedUpdatedAt: loadOk(store).updatedAt,
          patch: { startSec: 14 },
        },
        store.deps,
      ),
    );
    expect(saved.counts.gaps).toBe(1);
    expect(saved.shots[1]!.gapBeforeSec).toBeCloseTo(4, 5);
  });
});

describe('カットの追加', () => {
  it('隙間に追加できる', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    // まず 40〜50 秒を空けた状態を作る（末尾の後ろは元から空いている）。
    const saved = saveOk(
      insertCameraShot(
        {
          projectPath: DIR,
          expectedUpdatedAt: updatedAt,
          startSec: 40,
          endSec: 50,
          cameraId: 'wide',
        },
        store.deps,
      ),
    );
    expect(saved.shots).toHaveLength(4);
    expect(saved.shots[3]!.inserted).toBe(true);
    expect(saved.counts.inserted).toBe(1);
    void updatedAt;
  });

  it('★IDは解析側と衝突しない接頭辞で採番する', () => {
    const store = setup();
    const saved = saveOk(
      insertCameraShot(
        {
          projectPath: DIR,
          expectedUpdatedAt: loadOk(store).updatedAt,
          startSec: 40,
          endSec: 50,
          cameraId: 'wide',
        },
        store.deps,
      ),
    );
    expect(saved.shots[3]!.id).toBe('shot-ins-00040000');
  });

  it('★reason は暫定で hold を付ける（ShotReason に「人が追加」が無いため）', () => {
    const store = setup();
    saveOk(
      insertCameraShot(
        {
          projectPath: DIR,
          expectedUpdatedAt: loadOk(store).updatedAt,
          startSec: 40,
          endSec: 50,
          cameraId: 'wide',
        },
        store.deps,
      ),
    );
    const inserted = cameraEditsOf(store.read(DIR).edits).inserted[0]!;
    expect(inserted.reason).toBe(INSERTED_SHOT_REASON);
    expect(inserted.reason).toBe('hold');
  });

  it('★既存カットと重なる追加を拒否する', () => {
    const store = setup();
    const result = insertCameraShot(
      {
        projectPath: DIR,
        expectedUpdatedAt: loadOk(store).updatedAt,
        startSec: 20,
        endSec: 30,
        cameraId: 'wide',
      },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.userMessage).toContain('重なっています');
    expect(cameraEditsOf(store.read(DIR).edits).inserted).toHaveLength(0);
  });

  it('★存在しないカメラでの追加を拒否する', () => {
    const store = setup();
    const result = insertCameraShot(
      {
        projectPath: DIR,
        expectedUpdatedAt: loadOk(store).updatedAt,
        startSec: 40,
        endSec: 50,
        cameraId: 'cam_Z',
      },
      store.deps,
    );
    expect(result.ok).toBe(false);
  });

  it('同じ開始時刻に2件追加すると連番が付く', () => {
    const taken = new Set(['shot-ins-00040000']);
    expect(insertedShotId(40, taken)).toBe('shot-ins-00040000-2');
    expect(insertedShotId(40, new Set())).toBe('shot-ins-00040000');
  });

  it('追加したカットも変更できる', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      insertCameraShot(
        { projectPath: DIR, expectedUpdatedAt: updatedAt, startSec: 40, endSec: 50, cameraId: 'wide' },
        store.deps,
      ),
    ).updatedAt;

    const changed = saveOk(
      applyCameraShotEdit(
        {
          projectPath: DIR,
          shotId: 'shot-ins-00040000',
          expectedUpdatedAt: updatedAt,
          patch: { cameraId: 'cam_A' },
        },
        store.deps,
      ),
    );
    expect(changed.shots[3]!.cameraId).toBe('cam_A');
    // ★overrides ではなく inserted の中身が直接変わる。
    expect(cameraEditsOf(store.read(DIR).edits).inserted[0]!.cameraId).toBe('cam_A');
    expect(cameraEditsOf(store.read(DIR).edits).overrides['shot-ins-00040000']).toBeUndefined();
  });
});

describe('カットの削除', () => {
  it('解析のカットを削除すると deletedIds に積まれる', () => {
    const store = setup();
    const saved = saveOk(
      deleteCameraShot(
        { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: loadOk(store).updatedAt },
        store.deps,
      ),
    );
    expect(saved.shots).toHaveLength(2);
    expect(saved.counts.deleted).toBe(1);
    expect(cameraEditsOf(store.read(DIR).edits).deletedIds).toEqual([SECOND]);
  });

  it('★追加したカットの削除は inserted から取り除く（deletedIds には積まない）', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      insertCameraShot(
        { projectPath: DIR, expectedUpdatedAt: updatedAt, startSec: 40, endSec: 50, cameraId: 'wide' },
        store.deps,
      ),
    ).updatedAt;

    const saved = saveOk(
      deleteCameraShot(
        { projectPath: DIR, shotId: 'shot-ins-00040000', expectedUpdatedAt: updatedAt },
        store.deps,
      ),
    );
    expect(saved.shots).toHaveLength(3);
    const edits = cameraEditsOf(store.read(DIR).edits);
    expect(edits.inserted).toHaveLength(0);
    expect(edits.deletedIds).toEqual([]);
  });

  it('削除時に不要になった変更も外す', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      applyCameraShotEdit(
        { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt, patch: { cameraId: 'cam_B' } },
        store.deps,
      ),
    ).updatedAt;

    deleteCameraShot(
      { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt },
      store.deps,
    );
    expect(cameraEditsOf(store.read(DIR).edits).overrides[SECOND]).toBeUndefined();
  });

  it('★全カットの削除を拒否する（映像トラックが空になるため）', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      deleteCameraShot({ projectPath: DIR, shotId: FIRST, expectedUpdatedAt: updatedAt }, store.deps),
    ).updatedAt;
    updatedAt = saveOk(
      deleteCameraShot({ projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt }, store.deps),
    ).updatedAt;

    const last = deleteCameraShot(
      { projectPath: DIR, shotId: THIRD, expectedUpdatedAt: updatedAt },
      store.deps,
    );
    expect(last.ok).toBe(false);
    if (!last.ok) expect(last.error.userMessage).toContain('カットが1つも残りません');
  });

  it('二重削除を拒否する', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      deleteCameraShot({ projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt }, store.deps),
    ).updatedAt;

    const again = deleteCameraShot(
      { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt },
      store.deps,
    );
    expect(again.ok).toBe(false);
  });

  it('削除済みのカットは変更できない', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      deleteCameraShot({ projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt }, store.deps),
    ).updatedAt;

    const result = applyCameraShotEdit(
      { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt, patch: { cameraId: 'wide' } },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.userMessage).toContain('削除済み');
  });
});

describe('修正の取り消し', () => {
  it('変更を取り消すと解析結果に戻る', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      applyCameraShotEdit(
        { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt, patch: { cameraId: 'cam_B', startSec: 12 } },
        store.deps,
      ),
    ).updatedAt;

    const reverted = saveOk(
      removeCameraEdit({ projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt }, store.deps),
    );
    expect(reverted.shots[1]!.cameraId).toBe('cam_A');
    expect(reverted.shots[1]!.startSec).toBe(10);
    expect(reverted.shots[1]!.edited).toBe(false);
  });

  it('削除を取り消すとカットが戻る', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      deleteCameraShot({ projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt }, store.deps),
    ).updatedAt;

    const restored = saveOk(
      removeCameraEdit({ projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt }, store.deps),
    );
    expect(restored.shots).toHaveLength(3);
    expect(restored.counts.deleted).toBe(0);
  });

  it('修正が無いカットの取り消しは CAMERA_SHOT_NOT_FOUND', () => {
    const store = setup();
    const result = removeCameraEdit(
      { projectPath: DIR, shotId: FIRST, expectedUpdatedAt: loadOk(store).updatedAt },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('CAMERA_SHOT_NOT_FOUND');
  });

  it('★他のカットの修正は消えない', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      applyCameraShotEdit(
        { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt, patch: { cameraId: 'cam_B' } },
        store.deps,
      ),
    ).updatedAt;
    updatedAt = saveOk(
      applyCameraShotEdit(
        { projectPath: DIR, shotId: THIRD, expectedUpdatedAt: updatedAt, patch: { cameraId: 'wide' } },
        store.deps,
      ),
    ).updatedAt;

    removeCameraEdit({ projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt }, store.deps);
    expect(cameraEditsOf(store.read(DIR).edits).overrides[THIRD]).toEqual({ cameraId: 'wide' });
  });
});

describe('★analysis を書き換えない', () => {
  it('保存の前後で analysis が完全一致する', () => {
    const store = setup();
    const before = JSON.stringify(store.read(DIR).analysis);

    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      applyCameraShotEdit(
        { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt, patch: { cameraId: 'cam_B', startSec: 11 } },
        store.deps,
      ),
    ).updatedAt;
    updatedAt = saveOk(
      insertCameraShot(
        { projectPath: DIR, expectedUpdatedAt: updatedAt, startSec: 40, endSec: 50, cameraId: 'wide' },
        store.deps,
      ),
    ).updatedAt;
    saveOk(
      deleteCameraShot({ projectPath: DIR, shotId: FIRST, expectedUpdatedAt: updatedAt }, store.deps),
    );

    expect(JSON.stringify(store.read(DIR).analysis)).toBe(before);
  });

  it('★書き換わるのは edits.cameraShots と edits.history だけ', () => {
    const store = setup();
    const before = store.read(DIR);
    saveOk(
      applyCameraShotEdit(
        { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: loadOk(store).updatedAt, patch: { cameraId: 'cam_B' } },
        store.deps,
      ),
    );
    const after = store.read(DIR);

    expect(after.edits.subtitles).toEqual(before.edits.subtitles);
    expect(after.edits.shorts).toEqual(before.edits.shorts);
    expect(after.edits.chapters).toEqual(before.edits.chapters);
    expect(after.edits.markers).toEqual(before.edits.markers);
    expect(after.edits.syncOffsets).toEqual(before.edits.syncOffsets);

    expect(cameraEditsOf(after.edits).overrides[SECOND]).toEqual({ cameraId: 'cam_B' });
    expect(after.edits.history.length).toBeGreaterThan(before.edits.history.length);
  });

  it('字幕・ショートの修正はカメラの保存で消えない', () => {
    const project = projectFixture();
    project.edits.subtitles = { 'sub-00000000': { text: '人が直した本文' } };
    project.edits.shorts = { short_01: { adopted: true } };
    const store = setup(project);

    saveOk(
      applyCameraShotEdit(
        { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: loadOk(store).updatedAt, patch: { cameraId: 'cam_B' } },
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
  it('カメラの変更が履歴に残る（kind は cameraShot）', () => {
    const store = setup();
    saveOk(
      applyCameraShotEdit(
        { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: loadOk(store).updatedAt, patch: { cameraId: 'cam_B' } },
        store.deps,
      ),
    );
    const entry = store.read(DIR).edits.history.find((h) => h.field === 'cameraId');
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe('cameraShot');
    expect(entry!.targetId).toBe(SECOND);
    expect(entry!.before).toBe('cam_A');
    expect(entry!.after).toBe('cam_B');
  });

  it('追加・削除も履歴に残す（何をしたか分かるように中身ごと）', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      insertCameraShot(
        { projectPath: DIR, expectedUpdatedAt: updatedAt, startSec: 40, endSec: 50, cameraId: 'wide' },
        store.deps,
      ),
    ).updatedAt;
    saveOk(
      deleteCameraShot({ projectPath: DIR, shotId: FIRST, expectedUpdatedAt: updatedAt }, store.deps),
    );

    const history = store.read(DIR).edits.history.filter((h) => h.kind === 'cameraShot');
    const inserted = history.find((h) => h.field === 'inserted');
    const deleted = history.find((h) => h.field === 'deleted');
    expect(inserted!.after).toMatchObject({ cameraId: 'wide', startSec: 40 });
    expect(deleted!.before).toMatchObject({ id: FIRST, cameraId: 'wide' });
  });

  it('★値が変わらない保存では履歴を増やさない', () => {
    const store = setup();
    let updatedAt = loadOk(store).updatedAt;
    updatedAt = saveOk(
      applyCameraShotEdit(
        { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt, patch: { cameraId: 'cam_B' } },
        store.deps,
      ),
    ).updatedAt;
    const length = store.read(DIR).edits.history.length;

    saveOk(
      applyCameraShotEdit(
        { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt, patch: { cameraId: 'cam_B' } },
        store.deps,
      ),
    );
    expect(store.read(DIR).edits.history.length).toBe(length);
  });
});

describe('★競合更新の検出', () => {
  it('古い updatedAt では上書きせず conflict を返す（変更）', () => {
    const store = setup();
    const data = loadOk(store);
    store.touchExternally(DIR);

    const result = applyCameraShotEdit(
      { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: data.updatedAt, patch: { cameraId: 'cam_B' } },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict).toBe(true);
      expect(result.error.code).toBe('PROJECT_CHANGED');
    }
    expect(cameraEditsOf(store.read(DIR).edits).overrides[SECOND]).toBeUndefined();
  });

  it('追加・削除・取り消しでも競合を検出する', () => {
    for (const run of [
      (store: ReturnType<typeof setup>, updatedAt: string) =>
        insertCameraShot(
          { projectPath: DIR, expectedUpdatedAt: updatedAt, startSec: 40, endSec: 50, cameraId: 'wide' },
          store.deps,
        ),
      (store: ReturnType<typeof setup>, updatedAt: string) =>
        deleteCameraShot({ projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt }, store.deps),
      (store: ReturnType<typeof setup>, updatedAt: string) =>
        removeCameraEdit({ projectPath: DIR, shotId: SECOND, expectedUpdatedAt: updatedAt }, store.deps),
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
      applyCameraShotEdit(
        { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: first.updatedAt, patch: { cameraId: 'cam_B' } },
        store.deps,
      ),
    );
    expect(saved.updatedAt).not.toBe(first.updatedAt);

    const stale = applyCameraShotEdit(
      { projectPath: DIR, shotId: THIRD, expectedUpdatedAt: first.updatedAt, patch: { cameraId: 'wide' } },
      store.deps,
    );
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.conflict).toBe(true);
  });
});

describe('★再接続（reattached）', () => {
  /** 再解析でカットの位置が 0.2 秒ずれた状況を作る。 */
  function shiftAnalysis(store: ReturnType<typeof setup>): void {
    const project = store.read(DIR);
    project.analysis!.cameraShots = [
      cameraShotFixture(0, 10.2, 'wide'),
      cameraShotFixture(10.2, 25, 'cam_A', 'speech'),
      cameraShotFixture(25, 40, 'cam_B', 'reaction'),
    ];
    store.deps.saveProject(DIR, project);
  }

  it('IDが変わっても時刻の近さで繋ぎ直され、画面に知らせる', () => {
    const store = setup();
    saveOk(
      applyCameraShotEdit(
        { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: loadOk(store).updatedAt, patch: { cameraId: 'cam_B' } },
        store.deps,
      ),
    );
    shiftAnalysis(store);

    const data = loadOk(store);
    const reattached = data.shots.find((s) => s.reattached !== undefined);
    expect(reattached).toBeDefined();
    expect(reattached!.reattached!.fromId).toBe(SECOND);
    expect(reattached!.reattached!.deltaSec).toBeCloseTo(0.2, 3);
    // ★修正は失われず、繋ぎ直された先に効いている。
    expect(reattached!.cameraId).toBe('cam_B');
    expect(data.counts.reattached).toBe(1);
    expect(data.counts.orphaned).toBe(0);
  });

  it('位置が変わっていなければ reattached は付かない', () => {
    const store = setup();
    saveOk(
      applyCameraShotEdit(
        { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: loadOk(store).updatedAt, patch: { cameraId: 'cam_B' } },
        store.deps,
      ),
    );
    const data = loadOk(store);
    expect(data.counts.reattached).toBe(0);
    expect(data.shots.every((s) => s.reattached === undefined)).toBe(true);
  });
});

describe('★孤立した修正', () => {
  it('繋ぎ先が無ければ内容ごと返し、project.json からは消さない', () => {
    const store = setup();
    saveOk(
      applyCameraShotEdit(
        { projectPath: DIR, shotId: THIRD, expectedUpdatedAt: loadOk(store).updatedAt, patch: { cameraId: 'wide' } },
        store.deps,
      ),
    );

    // 再解析で該当時刻から遠い位置にしかカットが無くなった状況。
    const project = store.read(DIR);
    project.analysis!.cameraShots = [cameraShotFixture(0, 10, 'wide')];
    store.deps.saveProject(DIR, project);

    const data = loadOk(store);
    expect(data.orphaned).toHaveLength(1);
    expect(data.orphaned[0]!.originalId).toBe(THIRD);
    expect(data.orphaned[0]!.cameraId).toBe('wide');
    expect(data.orphaned[0]!.approxSec).toBeCloseTo(25, 3);
    // 消さずに残す（戻せる状態を保つ）。
    expect(cameraEditsOf(store.read(DIR).edits).overrides[THIRD]).toEqual({ cameraId: 'wide' });
  });

  it('削除対象が再解析で消えた場合も孤立として知らせる', () => {
    const store = setup();
    saveOk(
      deleteCameraShot(
        { projectPath: DIR, shotId: THIRD, expectedUpdatedAt: loadOk(store).updatedAt },
        store.deps,
      ),
    );

    const project = store.read(DIR);
    project.analysis!.cameraShots = [cameraShotFixture(0, 10, 'wide')];
    store.deps.saveProject(DIR, project);

    const data = loadOk(store);
    const orphan = data.orphaned.find((o) => o.originalId === THIRD);
    expect(orphan).toBeDefined();
    expect(orphan!.deleted).toBe(true);
  });
});

describe('存在しないカット', () => {
  it('解析にも追加分にも無いIDは CAMERA_SHOT_NOT_FOUND', () => {
    const store = setup();
    const updatedAt = loadOk(store).updatedAt;
    for (const result of [
      applyCameraShotEdit(
        { projectPath: DIR, shotId: 'shot-99999999', expectedUpdatedAt: updatedAt, patch: { cameraId: 'wide' } },
        store.deps,
      ),
      deleteCameraShot(
        { projectPath: DIR, shotId: 'shot-99999999', expectedUpdatedAt: updatedAt },
        store.deps,
      ),
    ]) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('CAMERA_SHOT_NOT_FOUND');
    }
  });
});

describe('保存の失敗', () => {
  it('保存に失敗したら「変更されていない」ことを伝える', () => {
    const store = setup();
    store.failNextSave();
    const result = applyCameraShotEdit(
      { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: loadOk(store).updatedAt, patch: { cameraId: 'cam_B' } },
      store.deps,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.userMessage).toContain('変更されていません');
    expect(cameraEditsOf(store.read(DIR).edits).overrides[SECOND]).toBeUndefined();
  });

  it('★保存の失敗時にDTOへ技術的な詳細を載せない', () => {
    const store = setup();
    store.failNextSave('ENOSPC: no space left on device');
    const result = applyCameraShotEdit(
      { projectPath: DIR, shotId: SECOND, expectedUpdatedAt: loadOk(store).updatedAt, patch: { cameraId: 'cam_B' } },
      store.deps,
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('ENOSPC');
    expect(serialized).not.toContain('technicalMessage');
  });
});

describe('純粋関数', () => {
  it('previewShots は resolveProject と同じ順序で組み立てる', () => {
    const shots = [
      cameraShotFixture(0, 10, 'wide'),
      cameraShotFixture(10, 25, 'cam_A'),
    ];
    const result = previewShots(shots, {
      overrides: { 'shot-00010000': { startSec: 12 } },
      inserted: [{ id: 'shot-ins-00030000', startSec: 30, endSec: 40, cameraId: 'wide', reason: 'hold' }],
      deletedIds: [],
    });
    expect(result.map((s) => s.id)).toEqual([
      'shot-00000000',
      'shot-00010000',
      'shot-ins-00030000',
    ]);
    expect(result[1]!.startSec).toBe(12);
  });

  it('previewShots は削除を除外する', () => {
    const shots = [cameraShotFixture(0, 10, 'wide'), cameraShotFixture(10, 25, 'cam_A')];
    const result = previewShots(shots, {
      overrides: {},
      inserted: [],
      deletedIds: ['shot-00000000'],
    });
    expect(result.map((s) => s.id)).toEqual(['shot-00010000']);
  });

  it('assertTimelineSafe は問題が無ければ undefined', () => {
    const shots = [cameraShotFixture(0, 10, 'wide'), cameraShotFixture(10, 25, 'cam_A')];
    const cameras = [
      { cameraId: 'wide', label: '引き', fileName: 'w.mp4', durationSec: 120 },
      { cameraId: 'cam_A', label: '寄りA', fileName: 'a.mp4', durationSec: 120 },
    ];
    expect(
      assertTimelineSafe(shots, { overrides: {}, inserted: [], deletedIds: [] }, cameras, 120),
    ).toBeUndefined();
  });

  it('cameraEditsOf は欠けた構造を空で補う（旧形式でも落ちない）', () => {
    expect(cameraEditsOf({ subtitles: {}, shorts: {}, history: [] } as never)).toEqual({
      overrides: {},
      inserted: [],
      deletedIds: [],
    });
  });

  it('timelineDurationOf は wide を優先する', () => {
    expect(
      timelineDurationOf([
        { cameraId: 'cam_A', label: 'A', fileName: 'a', durationSec: 200 },
        { cameraId: 'wide', label: 'W', fileName: 'w', durationSec: 120 },
      ]),
    ).toBe(120);
  });

  it('timelineDurationOf は wide が無ければ最長を使う', () => {
    expect(
      timelineDurationOf([
        { cameraId: 'cam_A', label: 'A', fileName: 'a', durationSec: 200 },
        { cameraId: 'cam_B', label: 'B', fileName: 'b', durationSec: 90 },
      ]),
    ).toBe(200);
  });

  it('cameraOptionsOf は映像素材だけを返す', () => {
    const options = cameraOptionsOf(projectFixture());
    expect(options.map((o) => o.cameraId)).toEqual(['wide', 'cam_A', 'cam_B']);
  });
});
