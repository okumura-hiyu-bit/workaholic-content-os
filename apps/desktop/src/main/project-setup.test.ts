/**
 * プロジェクト一覧・新規作成・素材登録。
 *
 * ★このテストの主眼は3つ。
 * 1. 元素材を一切変更しないこと
 * 2. project.analysis / project.edits を素材登録が変えないこと
 * 3. 必須素材が足りないときに解析へ進ませないこと
 *
 * ffmpeg / faster-whisper は起動しない（probe を差し替えている）。
 */

import { describe, expect, it } from 'vitest';

import {
  buildSetupData,
  checkSetup,
  makeAssetId,
  mainAudioAssetId,
  registerAssets,
  removeAsset,
  speakerSlotOfRole,
  suggestRole,
  updateAsset,
} from './assets.ts';
import { createProjectFolder, uniqueFolderName } from './project-create.ts';
import { forgetProject, listProjects, rememberProject } from './project-registry.ts';
import {
  audioProbe,
  createFakeWorld,
  videoProbe,
  type FakeWorld,
} from './testing/fake-core.ts';

const PARENT = '/work';

const CREATE = {
  name: '第12回 収録',
  recordedAt: '2026-08-05',
  programName: 'WORKAHOLIC',
  parentDir: PARENT,
  syncMode: 'preserve' as const,
  speakers: [
    { slot: 'A' as const, name: '岸本', role: 'host' as const },
    { slot: 'B' as const, name: 'ゲスト', role: 'guest' as const },
  ],
};

/** 新規作成まで済ませた世界を作る。 */
function setup(): { world: FakeWorld; dir: string } {
  const world = createFakeWorld();
  const result = createProjectFolder(CREATE, world.creator);
  if (!result.ok) throw new Error('create failed');
  return { world, dir: result.entry.projectPath };
}

/** 素材ファイルを置いて登録する。 */
function register(world: FakeWorld, dir: string, files: [string, ReturnType<typeof videoProbe>][]) {
  for (const [path, probe] of files) {
    world.putFile(path, { sizeBytes: 1024, mtimeMs: 1, probe });
  }
  const updatedAt = world.readProject(dir).updatedAt;
  return registerAssets(dir, updatedAt, files.map(([p]) => p), world.assets);
}

function load(world: FakeWorld, dir: string) {
  const result = buildSetupData(dir, world.assets);
  if (!result.ok) throw new Error(result.error.userMessage);
  return result.data;
}

// ─── 新規作成 ──────────────────────────────────────────

describe('新規プロジェクト作成', () => {
  it('★createProject の初期構造をそのまま使う', () => {
    const { world, dir } = setup();
    const project = world.readProject(dir);

    expect(project.name).toBe('第12回 収録');
    expect(project.recordedAt).toBe('2026-08-05');
    expect((project as { theme?: string }).theme).toBe('WORKAHOLIC');
    expect(project.status).toBe('素材準備中');
    expect(project.assets).toEqual([]);
    // ★edits は createProject の初期構造のまま
    expect(project.edits).toEqual({
      subtitles: {},
      cameraShots: { overrides: {}, inserted: [], deletedIds: [] },
      chapters: {},
      markers: {},
      shorts: {},
      syncOffsets: {},
      history: [],
    });
    // ★analysis は作らない（解析前なので存在しない）
    expect((project as { analysis?: unknown }).analysis).toBeUndefined();
  });

  it('出演者を A / B の枠で保存する（素材の役割と対応させるため）', () => {
    const { world, dir } = setup();
    expect(world.readProject(dir).speakers).toEqual([
      { id: 'A', name: '岸本', role: 'host' },
      { id: 'B', name: 'ゲスト', role: 'guest' },
    ]);
  });

  it('syncMode を保存する', () => {
    const world = createFakeWorld();
    const result = createProjectFolder({ ...CREATE, syncMode: 'common' }, world.creator);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((world.readProject(result.entry.projectPath) as { sync?: { mode?: string } }).sync?.mode)
      .toBe('common');
  });

  it('フォルダ名は 収録日_案件名', () => {
    const { dir } = setup();
    expect(dir).toBe('/work/2026-08-05_第12回 収録');
  });

  it('★既存フォルダを上書きしない（連番を付ける）', () => {
    const world = createFakeWorld();
    createProjectFolder(CREATE, world.creator);
    const second = createProjectFolder(CREATE, world.creator);

    expect(second.ok).toBe(true);
    expect(second.ok && second.entry.projectPath).toBe('/work/2026-08-05_第12回 収録-2');
  });

  it('uniqueFolderName は空きが無ければ undefined', () => {
    expect(uniqueFolderName('/work', 'x', () => true)).toBeUndefined();
  });

  it('★存在しない保存先を拒否する', () => {
    const world = createFakeWorld();
    const result = createProjectFolder({ ...CREATE, parentDir: '/nowhere' }, world.creator);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.userMessage).toContain('見つかりません');
  });

  it('★書き込めない保存先を拒否する', () => {
    const world = createFakeWorld();
    world.setReadOnly(PARENT);
    const result = createProjectFolder(CREATE, world.creator);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.userMessage).toContain('書き込めません');
  });
});

// ─── 一覧 ──────────────────────────────────────────────

describe('プロジェクト一覧', () => {
  it('★作成すると一覧に載る', () => {
    const { world, dir } = setup();
    const result = listProjects(world.registry);

    expect(result.ok).toBe(true);
    expect(result.ok && result.entries).toHaveLength(1);
    expect(result.ok && result.entries[0]?.projectPath).toBe(dir);
    expect(result.ok && result.entries[0]?.name).toBe('第12回 収録');
  });

  it('★project.json から毎回読み直す（素材数が最新になる）', () => {
    const { world, dir } = setup();
    register(world, dir, [['/media/wide.mp4', videoProbe()]]);

    const result = listProjects(world.registry);
    expect(result.ok && result.entries[0]?.assetCount).toBe(1);
  });

  it('★最近開いた順に並ぶ', () => {
    const world = createFakeWorld();
    const a = createProjectFolder({ ...CREATE, name: 'A案件' }, world.creator);
    const b = createProjectFolder({ ...CREATE, name: 'B案件' }, world.creator);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // A をもう一度開く＝最後に開いたのは A
    rememberProject(a.entry.projectPath, world.registry);

    const result = listProjects(world.registry);
    expect(result.ok && result.entries.map((e) => e.name)).toEqual(['A案件', 'B案件']);
  });

  it('★参照先が消えても黙って落とさず missing として残す', () => {
    const world = createFakeWorld();
    rememberProject('/work/消えた案件', world.registry);

    const result = listProjects(world.registry);
    expect(result.ok && result.entries[0]?.missing).toBe(true);
    expect(result.ok && result.entries[0]?.status).toBe('見つかりません');
  });

  it('一覧から外せる（project.json は消さない）', () => {
    const { world, dir } = setup();
    forgetProject(dir, world.registry);

    expect(listProjects(world.registry)).toEqual({ ok: true, entries: [] });
    // ★プロジェクト本体は残っている
    expect(world.hasProject(dir)).toBe(true);
  });

  it('壊れた設定ファイルでも一覧が開ける', () => {
    const world = createFakeWorld();
    world.registry.write('{ broken');
    expect(listProjects(world.registry)).toEqual({ ok: true, entries: [] });
  });

  it('★一覧は参照情報だけを持つ（プロジェクト本体を写さない）', () => {
    const { world } = setup();
    const raw = world.registryContents() ?? '';
    expect(raw).toContain('projectPath');
    expect(raw).toContain('lastOpenedAt');
    expect(raw).not.toContain('speakers');
    expect(raw).not.toContain('edits');
    expect(raw).not.toContain('analysis');
  });
});

// ─── 役割の推測 ────────────────────────────────────────

describe('役割の自動推測', () => {
  it('ファイル名から推測する', () => {
    expect(suggestRole('wide.mp4', videoProbe())).toBe('wide');
    expect(suggestRole('cam_A.mp4', videoProbe())).toBe('cam_A');
    expect(suggestRole('camera-b.mov', videoProbe())).toBe('cam_B');
    expect(suggestRole('mic_A.wav', audioProbe())).toBe('mic_A');
    expect(suggestRole('BGM.mp3', audioProbe())).toBe('bgm');
    expect(suggestRole('opening.mp4', videoProbe())).toBe('opening');
    expect(suggestRole('ending.mp4', videoProbe())).toBe('ending');
    expect(suggestRole('logo.png', videoProbe())).toBe('logo');
  });

  it('分からなければ other', () => {
    expect(suggestRole('DSC_0001.MP4', videoProbe())).toBe('other');
  });

  it('★推測しても確定はしない（roleConfirmed は false）', () => {
    const { world, dir } = setup();
    register(world, dir, [['/media/wide.mp4', videoProbe()]]);

    const data = load(world, dir);
    expect(data.assets[0]?.role).toBe('wide');
    expect(data.assets[0]?.suggestedRole).toBe('wide');
    expect(data.assets[0]?.roleConfirmed).toBe(false);
  });

  it('役割から出演者枠を導く', () => {
    expect(speakerSlotOfRole('mic_A')).toBe('A');
    expect(speakerSlotOfRole('cam_B')).toBe('B');
    expect(speakerSlotOfRole('wide')).toBeUndefined();
  });

  it('メイン音声は wide 優先（transcribe 工程と同じ基準）', () => {
    expect(
      mainAudioAssetId([
        { id: 'c', role: 'cam_A', hasAudio: true } as never,
        { id: 'w', role: 'wide', hasAudio: true } as never,
      ]),
    ).toBe('w');
  });

  it('素材IDはファイル名から作り、衝突したら連番', () => {
    expect(makeAssetId('wide.mp4', new Set())).toBe('wide');
    expect(makeAssetId('wide.mp4', new Set(['wide']))).toBe('wide-2');
    expect(makeAssetId('日本語.mp4', new Set())).toBe('asset');
  });
});

// ─── 素材登録 ──────────────────────────────────────────

describe('素材登録', () => {
  it('★登録できる（メタデータを保存する）', () => {
    const { world, dir } = setup();
    const result = register(world, dir, [['/media/wide.mp4', videoProbe()]]);

    expect(result.ok).toBe(true);
    expect(result.ok && result.added).toBe(1);

    const asset = load(world, dir).assets[0]!;
    expect(asset.fileName).toBe('wide.mp4');
    expect(asset.durationSec).toBe(40);
    expect(asset.width).toBe(1920);
    expect(asset.fps).toBe(30);
    expect(asset.audioChannels).toBe(2);
    expect(asset.audioSampleRate).toBe(48000);
  });

  it('★絶対パスは project.json に保存し、画面には渡さない', () => {
    const { world, dir } = setup();
    register(world, dir, [['/media/raw/wide.mp4', videoProbe()]]);

    // project.json には絶対パスがある
    const stored = world.readProject(dir).assets as { absolutePath: string }[];
    expect(stored[0]?.absolutePath).toBe('/media/raw/wide.mp4');

    // 画面向けDTOには無い（親フォルダ名まで）
    const data = load(world, dir);
    expect(JSON.stringify(data)).not.toContain('/media/raw/wide.mp4');
    expect(data.assets[0]?.directoryName).toBe('raw');
  });

  it('★同じファイルの二重登録を拒否する', () => {
    const { world, dir } = setup();
    register(world, dir, [['/media/wide.mp4', videoProbe()]]);
    const second = register(world, dir, [['/media/wide.mp4', videoProbe()]]);

    expect(second.ok).toBe(true);
    expect(second.ok && second.added).toBe(0);
    expect(second.ok && second.skipped?.[0]).toContain('すでに登録されています');
    expect(load(world, dir).assets).toHaveLength(1);
  });

  it('★映像・音声として読めないファイルを拒否する', () => {
    const { world, dir } = setup();
    world.putFile('/media/memo.txt', { sizeBytes: 10, mtimeMs: 1 }); // probe 無し
    const updatedAt = world.readProject(dir).updatedAt;
    const result = registerAssets(dir, updatedAt, ['/media/memo.txt'], world.assets);

    expect(result.ok).toBe(true);
    expect(result.ok && result.added).toBe(0);
    expect(result.ok && result.skipped?.[0]).toContain('読み取れません');
  });

  it('存在しないファイルを拒否する', () => {
    const { world, dir } = setup();
    const updatedAt = world.readProject(dir).updatedAt;
    const result = registerAssets(dir, updatedAt, ['/media/nope.mp4'], world.assets);
    expect(result.ok && result.skipped?.[0]).toContain('見つかりません');
  });

  it('★競合更新を検出する（上書きしない）', () => {
    const { world, dir } = setup();
    world.putFile('/media/wide.mp4', { sizeBytes: 1, mtimeMs: 1, probe: videoProbe() });
    const result = registerAssets(
      dir,
      '2020-01-01T00:00:00.000Z',
      ['/media/wide.mp4'],
      world.assets,
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.conflict).toBe(true);
    expect(load(world, dir).assets).toHaveLength(0);
  });

  it('★元素材を移動・変更しない', () => {
    const { world, dir } = setup();
    world.putFile('/media/wide.mp4', { sizeBytes: 12345, mtimeMs: 999, probe: videoProbe() });
    const before = world.fileSnapshot();

    const updatedAt = world.readProject(dir).updatedAt;
    registerAssets(dir, updatedAt, ['/media/wide.mp4'], world.assets);

    expect(world.fileSnapshot()).toEqual(before);
  });

  it('★保存に失敗しても project.json が壊れない', () => {
    const { world, dir } = setup();
    const before = world.readProject(dir);
    world.putFile('/media/wide.mp4', { sizeBytes: 1, mtimeMs: 1, probe: videoProbe() });
    world.failNextSave();

    const result = registerAssets(dir, before.updatedAt, ['/media/wide.mp4'], world.assets);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.userMessage).toContain('変更されていません');
    expect(world.readProject(dir)).toEqual(before);
  });
});

// ─── 役割の変更 ────────────────────────────────────────

describe('素材の役割設定', () => {
  it('★役割を変えると確定済みになる', () => {
    const { world, dir } = setup();
    register(world, dir, [['/media/DSC_0001.MP4', videoProbe()]]);
    const data = load(world, dir);
    expect(data.assets[0]?.roleConfirmed).toBe(false);

    const result = updateAsset(
      {
        projectPath: dir,
        expectedUpdatedAt: data.updatedAt,
        assetId: data.assets[0]!.id,
        // ★roleConfirmed を明示しなくても、役割を選べば確定になる。
        patch: { role: 'wide' },
      },
      world.assets,
    );

    expect(result.ok).toBe(true);
    const after = load(world, dir).assets[0]!;
    expect(after.role).toBe('wide');
    expect(after.roleConfirmed).toBe(true);
  });

  it('★確定を明示的に取り消せる', () => {
    const { world, dir } = setup();
    register(world, dir, [['/media/wide.mp4', videoProbe()]]);
    let data = load(world, dir);
    updateAsset(
      {
        projectPath: dir,
        expectedUpdatedAt: data.updatedAt,
        assetId: data.assets[0]!.id,
        patch: { role: 'wide' },
      },
      world.assets,
    );
    data = load(world, dir);
    updateAsset(
      {
        projectPath: dir,
        expectedUpdatedAt: data.updatedAt,
        assetId: data.assets[0]!.id,
        patch: { roleConfirmed: false },
      },
      world.assets,
    );
    expect(load(world, dir).assets[0]?.roleConfirmed).toBe(false);
  });

  it('★出演者とマイクが紐づく', () => {
    const { world, dir } = setup();
    register(world, dir, [['/media/mic_A.wav', audioProbe()]]);
    const data = load(world, dir);

    expect(data.assets[0]?.role).toBe('mic_A');
    expect(data.assets[0]?.speakerSlot).toBe('A');
    expect(data.speakers.find((s) => s.slot === 'A')?.micRegistered).toBe(true);
    expect(data.speakers.find((s) => s.slot === 'B')?.micRegistered).toBe(false);
  });

  it('★無効にすると解析対象（project.assets）から外れる', () => {
    const { world, dir } = setup();
    register(world, dir, [['/media/bgm.mp3', audioProbe()]]);
    const data = load(world, dir);

    updateAsset(
      {
        projectPath: dir,
        expectedUpdatedAt: data.updatedAt,
        assetId: data.assets[0]!.id,
        patch: { enabled: false },
      },
      world.assets,
    );

    const after = load(world, dir);
    expect(after.assets).toHaveLength(0);
    expect(after.disabledAssets).toHaveLength(1);
    // ★project.assets から外れている＝パイプラインが使わない
    expect(world.readProject(dir).assets).toHaveLength(0);
    // ★捨てていない
    expect((world.readProject(dir) as { disabledAssets?: unknown[] }).disabledAssets)
      .toHaveLength(1);
  });

  it('無効にした素材を有効に戻せる', () => {
    const { world, dir } = setup();
    register(world, dir, [['/media/bgm.mp3', audioProbe()]]);
    let data = load(world, dir);
    const id = data.assets[0]!.id;

    updateAsset(
      { projectPath: dir, expectedUpdatedAt: data.updatedAt, assetId: id, patch: { enabled: false } },
      world.assets,
    );
    data = load(world, dir);
    updateAsset(
      { projectPath: dir, expectedUpdatedAt: data.updatedAt, assetId: id, patch: { enabled: true } },
      world.assets,
    );

    expect(load(world, dir).assets).toHaveLength(1);
    expect(load(world, dir).disabledAssets).toHaveLength(0);
  });

  it('登録から外せる（元ファイルは消さない）', () => {
    const { world, dir } = setup();
    register(world, dir, [['/media/wide.mp4', videoProbe()]]);
    const data = load(world, dir);
    const before = world.fileSnapshot();

    removeAsset(
      { projectPath: dir, expectedUpdatedAt: data.updatedAt, assetId: data.assets[0]!.id },
      world.assets,
    );

    expect(load(world, dir).assets).toHaveLength(0);
    expect(world.fileSnapshot()).toEqual(before);
  });

  it('未知の素材IDを拒否する', () => {
    const { world, dir } = setup();
    const data = load(world, dir);
    const result = updateAsset(
      {
        projectPath: dir,
        expectedUpdatedAt: data.updatedAt,
        assetId: 'nope',
        patch: { enabled: false },
      },
      world.assets,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('ASSET_NOT_FOUND');
  });
});

// ─── analysis / edits の不変 ───────────────────────────

describe('素材登録は analysis / edits を変えない', () => {
  /** 解析済みプロジェクトを作る。 */
  function analyzed(): { world: FakeWorld; dir: string } {
    const { world, dir } = setup();
    const project = world.readProject(dir);
    world.assets.saveProject(dir, {
      ...project,
      analysis: {
        subtitles: [
          { id: 'sub-00000000', startSec: 0, endSec: 1, lines: ['こんばんは'] },
        ],
      } as never,
      edits: {
        ...project.edits,
        subtitles: { 'sub-00000000': { text: '人が直した' } },
      },
    });
    return { world, dir };
  }

  it('★素材を登録しても analysis が変わらない', () => {
    const { world, dir } = analyzed();
    const before = structuredClone(world.readProject(dir).analysis);

    register(world, dir, [['/media/wide.mp4', videoProbe()]]);

    expect(world.readProject(dir).analysis).toEqual(before);
  });

  it('★素材を登録しても edits が変わらない', () => {
    const { world, dir } = analyzed();
    const before = structuredClone(world.readProject(dir).edits);

    register(world, dir, [['/media/wide.mp4', videoProbe()]]);

    expect(world.readProject(dir).edits).toEqual(before);
  });

  it('★役割変更・削除でも analysis / edits が変わらない', () => {
    const { world, dir } = analyzed();
    register(world, dir, [['/media/wide.mp4', videoProbe()]]);
    const before = structuredClone(world.readProject(dir));
    const data = load(world, dir);

    updateAsset(
      {
        projectPath: dir,
        expectedUpdatedAt: data.updatedAt,
        assetId: data.assets[0]!.id,
        patch: { role: 'cam_A' },
      },
      world.assets,
    );

    const after = world.readProject(dir);
    expect(after.analysis).toEqual(before.analysis);
    expect(after.edits).toEqual(before.edits);
  });

  it('★解析済みプロジェクトの素材を変えるときは影響範囲を警告する', () => {
    const { world, dir } = analyzed();
    register(world, dir, [['/media/wide.mp4', videoProbe()]]);

    const data = load(world, dir);
    expect(data.analyzed).toBe(true);
    const warning = data.issues.find((i) => i.code === 'ALREADY_ANALYZED');
    expect(warning?.severity).toBe('warning');
    expect(warning?.suggestedAction).toContain('孤立');
  });
});

// ─── 解析前チェック ────────────────────────────────────

describe('解析前チェック', () => {
  it('★素材が無ければ解析できない', () => {
    const { world, dir } = setup();
    const data = load(world, dir);

    expect(data.canAnalyze).toBe(false);
    expect(data.issues.some((i) => i.code === 'NO_ASSETS' && i.severity === 'error')).toBe(true);
  });

  it('★基準映像（wide）が無ければ解析できない', () => {
    const { world, dir } = setup();
    register(world, dir, [['/media/mic_A.wav', audioProbe()]]);
    const data = load(world, dir);

    expect(data.canAnalyze).toBe(false);
    expect(data.issues.some((i) => i.code === 'NO_WIDE')).toBe(true);
  });

  it('★音声付き素材が無ければ解析できない', () => {
    const { world, dir } = setup();
    register(world, dir, [['/media/wide.mp4', videoProbe({ hasAudio: false })]]);
    const data = load(world, dir);

    expect(data.issues.some((i) => i.code === 'NO_AUDIO')).toBe(true);
  });

  it('★役割が未確定なら解析できない（誤推測のまま使わせない）', () => {
    const { world, dir } = setup();
    register(world, dir, [['/media/wide.mp4', videoProbe()]]);
    const data = load(world, dir);

    expect(data.canAnalyze).toBe(false);
    const issue = data.issues.find((i) => i.code === 'ROLE_UNCONFIRMED');
    expect(issue?.severity).toBe('error');
    expect(issue?.assetId).toBe(data.assets[0]!.id);
  });

  it('★役割を確定すると解析できるようになる（警告は残ってよい）', () => {
    const { world, dir } = setup();
    register(world, dir, [['/media/wide.mp4', videoProbe()]]);
    const data = load(world, dir);

    updateAsset(
      {
        projectPath: dir,
        expectedUpdatedAt: data.updatedAt,
        assetId: data.assets[0]!.id,
        patch: { role: 'wide' },
      },
      world.assets,
    );

    const after = load(world, dir);
    expect(after.canAnalyze).toBe(true);
    // ★マイク未登録は警告どまり（続行できる）
    expect(after.issues.some((i) => i.code === 'NO_MIC_FOR_SPEAKER' && i.severity === 'warning'))
      .toBe(true);
  });

  it('★ファイルが消えていれば解析できない', () => {
    const { world, dir } = setup();
    register(world, dir, [['/media/wide.mp4', videoProbe()]]);
    const data = load(world, dir);
    updateAsset(
      {
        projectPath: dir,
        expectedUpdatedAt: data.updatedAt,
        assetId: data.assets[0]!.id,
        patch: { role: 'wide' },
      },
      world.assets,
    );

    world.removeFile('/media/wide.mp4');

    const after = load(world, dir);
    expect(after.canAnalyze).toBe(false);
    expect(after.issues.some((i) => i.code === 'FILE_MISSING')).toBe(true);
  });

  it('★読み取れないファイルを検出する', () => {
    const { world, dir } = setup();
    world.putFile('/media/wide.mp4', {
      sizeBytes: 1,
      mtimeMs: 1,
      probe: videoProbe(),
    });
    const updatedAt = world.readProject(dir).updatedAt;
    registerAssets(dir, updatedAt, ['/media/wide.mp4'], world.assets);
    world.putFile('/media/wide.mp4', {
      sizeBytes: 1,
      mtimeMs: 1,
      probe: videoProbe(),
      unreadable: true,
    });

    expect(load(world, dir).issues.some((i) => i.code === 'FILE_UNREADABLE')).toBe(true);
  });

  it('★書き込めないフォルダを検出する', () => {
    const { world, dir } = setup();
    world.setReadOnly(dir);
    expect(load(world, dir).issues.some((i) => i.code === 'NOT_WRITABLE')).toBe(true);
  });

  it('★空き容量が少なければ警告する（続行はできる）', () => {
    const { world, dir } = setup();
    world.setFreeBytes(1024 ** 3);
    const issue = load(world, dir).issues.find((i) => i.code === 'LOW_DISK');
    expect(issue?.severity).toBe('warning');
  });

  it('★フレームレートが揃っていなければ警告する', () => {
    const { world, dir } = setup();
    register(world, dir, [
      ['/media/wide.mp4', videoProbe({ fps: 30 })],
      ['/media/cam_A.mp4', videoProbe({ fps: 24 })],
    ]);
    expect(load(world, dir).issues.some((i) => i.code === 'FPS_MISMATCH')).toBe(true);
  });

  it('★尺が大きく違えば警告する', () => {
    const { world, dir } = setup();
    register(world, dir, [
      ['/media/wide.mp4', videoProbe({ durationSec: 600 })],
      ['/media/cam_A.mp4', videoProbe({ durationSec: 30 })],
    ]);
    expect(load(world, dir).issues.some((i) => i.code === 'DURATION_MISMATCH')).toBe(true);
  });

  it('★重複登録を検出する（直接project.jsonを書き換えた場合）', () => {
    const { world, dir } = setup();
    register(world, dir, [['/media/wide.mp4', videoProbe()]]);
    const project = world.readProject(dir);
    const assets = project.assets as { id: string }[];
    world.assets.saveProject(dir, {
      ...project,
      assets: [...assets, { ...assets[0]!, id: 'copy' }] as never,
    });

    expect(load(world, dir).issues.some((i) => i.code === 'DUPLICATE_FILE')).toBe(true);
  });

  it('警告だけなら解析できる', () => {
    const { world, dir } = setup();
    register(world, dir, [['/media/wide.mp4', videoProbe()]]);
    const data = load(world, dir);
    updateAsset(
      {
        projectPath: dir,
        expectedUpdatedAt: data.updatedAt,
        assetId: data.assets[0]!.id,
        patch: { role: 'wide' },
      },
      world.assets,
    );
    world.setFreeBytes(1024 ** 3);

    const after = load(world, dir);
    expect(after.issues.some((i) => i.severity === 'warning')).toBe(true);
    expect(after.issues.some((i) => i.severity === 'error')).toBe(false);
    expect(after.canAnalyze).toBe(true);
  });

  it('checkSetup は project と projectDir だけで判定できる', () => {
    const { world, dir } = setup();
    const issues = checkSetup(world.readProject(dir), dir, world.assets);
    expect(issues.some((i) => i.code === 'NO_ASSETS')).toBe(true);
  });
});
