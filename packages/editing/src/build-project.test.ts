import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildEditProject,
  computeCommonRegion,
  resetClipIds,
  type AudioSource,
  type BuildProjectInput,
  type VideoSource,
} from './build-project.ts';
import { generateFcp7Xml, type Fcp7MediaFile, type Fcp7Rate } from './fcp7xml.ts';
import { planCameraSwitches } from './camera-plan.ts';
import type { CameraSource, ShortCandidate, TimelineMarker } from './types.ts';

const RATE: Fcp7Rate = { timebase: 30, ntsc: false };

function videoFile(id: string, name: string): Fcp7MediaFile {
  return {
    id,
    name,
    absolutePath: `/Volumes/SSD/ep012/raw/${name}`,
    durationFrames: 54_000,
    hasVideo: true,
    hasAudio: true,
    width: 1920,
    height: 1080,
  };
}

function audioFile(id: string, path: string): Fcp7MediaFile {
  return {
    id,
    name: path.split('/').pop()!,
    absolutePath: `/Volumes/SSD/ep012/${path}`,
    durationFrames: 54_000,
    hasVideo: false,
    hasAudio: true,
    audioChannels: 1,
  };
}

const VIDEOS: VideoSource[] = [
  { id: 'wide', file: videoFile('f-wide', 'wide.mp4'), syncOffsetSec: 0 },
  { id: 'cam_A', file: videoFile('f-a', 'cam_A.mp4'), syncOffsetSec: 1.2, speakerId: 'A' },
  { id: 'cam_B', file: videoFile('f-b', 'cam_B.mp4'), syncOffsetSec: -0.4, speakerId: 'B' },
];

const AUDIOS: AudioSource[] = [
  {
    id: 'mic_A',
    kind: 'original',
    speakerId: 'A',
    file: audioFile('f-mica', 'raw/audio/mic_A.wav'),
    syncOffsetSec: 1.35,
  },
  {
    id: 'mic_B',
    kind: 'original',
    speakerId: 'B',
    file: audioFile('f-micb', 'raw/audio/mic_B.wav'),
    syncOffsetSec: 1.35,
  },
  {
    id: 'mic_A_corrected',
    kind: 'corrected',
    speakerId: 'A',
    file: audioFile('f-mica-c', 'audio/processed/mic_A.corrected.wav'),
    syncOffsetSec: 1.35,
  },
  {
    id: 'mic_B_corrected',
    kind: 'corrected',
    speakerId: 'B',
    file: audioFile('f-micb-c', 'audio/processed/mic_B.corrected.wav'),
    syncOffsetSec: 1.35,
  },
  {
    id: 'bgm',
    kind: 'bgm',
    file: audioFile('f-bgm', 'assets/bgm/main_theme.wav'),
    syncOffsetSec: 0,
  },
];

const CAMERAS: CameraSource[] = [
  { id: 'wide', kind: 'wide', file: 'wide.mp4', syncOffsetSec: 0 },
  { id: 'cam_A', kind: 'closeup', speakerId: 'A', file: 'cam_A.mp4', syncOffsetSec: 1.2 },
  { id: 'cam_B', kind: 'closeup', speakerId: 'B', file: 'cam_B.mp4', syncOffsetSec: -0.4 },
];

const MARKERS: TimelineMarker[] = [
  { startSec: 0, kind: 'OP', name: 'オープニング', comment: '' },
  { startSec: 135, kind: 'TOPIC', name: '給与では勝てない理由', comment: '話題区切り' },
  {
    startSec: 200,
    endSec: 204,
    kind: 'LAUGH',
    name: '笑い（4秒）',
    comment: 'A・B両名',
  },
  {
    startSec: 250,
    kind: 'CHECK',
    name: 'mic_A クリッピング',
    comment: '0.4秒・要確認（自動補正はしていません）',
  },
];

const SHORTS: ShortCandidate[] = [
  {
    id: 'short_01',
    startSec: 83,
    endSec: 130,
    title: '辞退率の話',
    hook: '応募数より辞退率を見てください',
    rationale: '数値提示型。保存されやすい傾向',
    primarySpeakerId: 'B',
  },
];

function makeInput(overrides: Partial<BuildProjectInput> = {}): BuildProjectInput {
  const durationSec = 300;
  return {
    episodeId: 'ep012',
    rate: RATE,
    sampleRate: 48_000,
    durationSec,
    width: 1920,
    height: 1080,
    videos: VIDEOS,
    audios: AUDIOS,
    shots: planCameraSwitches({
      durationSec,
      speech: [
        { startSec: 0, endSec: 120, speakerId: 'A', text: '' },
        { startSec: 120, endSec: 300, speakerId: 'B', text: '' },
      ],
      cameras: CAMERAS,
    }),
    markers: MARKERS,
    shorts: SHORTS,
    ...overrides,
  };
}

beforeEach(() => resetClipIds());

describe('buildEditProject — シーケンス構成', () => {
  it('本編・同期確認・ショートのシーケンスを作る', () => {
    const project = buildEditProject(makeInput());
    expect(project.sequences.map((s) => s.name)).toEqual([
      '01_本編',
      '02_同期確認_全カメラ',
      '03_short_01_辞退率の話',
    ]);
  });

  it('ショート候補の本数だけシーケンスを作る', () => {
    const project = buildEditProject(
      makeInput({
        shorts: [
          SHORTS[0]!,
          { ...SHORTS[0]!, id: 'short_02', title: '二本目' },
          { ...SHORTS[0]!, id: 'short_03', title: '三本目' },
        ],
      }),
    );
    expect(project.sequences).toHaveLength(5);
  });

  it('ショートは1080×1920で作る', () => {
    const project = buildEditProject(makeInput());
    const short = project.sequences[2]!;
    expect(short.width).toBe(1080);
    expect(short.height).toBe(1920);
  });

  it('本編は指定解像度で作る', () => {
    const project = buildEditProject(makeInput());
    expect(project.sequences[0]).toMatchObject({ width: 1920, height: 1080 });
  });

  it('映像素材が無ければエラーにする', () => {
    expect(() => buildEditProject(makeInput({ videos: [] }))).toThrow(
      /映像素材が1本もありません/,
    );
  });
});

describe('buildEditProject — 音声の非破壊構成', () => {
  it('原音トラックを有効にする', () => {
    const project = buildEditProject(makeInput());
    const originals = project.sequences[0]!.audioTracks.filter((t) =>
      t.label?.startsWith('原音'),
    );
    expect(originals).toHaveLength(2);
    for (const track of originals) {
      expect(track.enabled).toBe(true);
    }
  });

  it('★補正音トラックを必ず無効（ミュート）にする', () => {
    const project = buildEditProject(makeInput());
    const corrected = project.sequences[0]!.audioTracks.filter((t) =>
      t.label?.startsWith('補正音'),
    );
    expect(corrected).toHaveLength(2);
    for (const track of corrected) {
      expect(track.enabled).toBe(false);
    }
  });

  it('原音が補正音より先（A1側）に並ぶ', () => {
    const project = buildEditProject(makeInput());
    const labels = project.sequences[0]!.audioTracks.map((t) => t.label ?? '');
    const lastOriginal = labels.findLastIndex((l) => l.startsWith('原音'));
    const firstCorrected = labels.findIndex((l) => l.startsWith('補正音'));
    expect(lastOriginal).toBeLessThan(firstCorrected);
  });

  it('BGMは有効にする', () => {
    const project = buildEditProject(makeInput());
    const bgm = project.sequences[0]!.audioTracks.find((t) => t.label === 'BGM');
    expect(bgm?.enabled).toBe(true);
  });

  it('補正音が無い場合（案件設定でオフ）も成立する', () => {
    const project = buildEditProject(
      makeInput({ audios: AUDIOS.filter((a) => a.kind !== 'corrected') }),
    );
    const tracks = project.sequences[0]!.audioTracks;
    expect(tracks.every((t) => !t.label?.startsWith('補正音'))).toBe(true);
    expect(tracks).toHaveLength(3);
  });

  it('原音ファイルのパスと補正音のパスが別である（上書きしていない）', () => {
    const project = buildEditProject(makeInput());
    const original = project.files.find((f) => f.id === 'f-mica')!;
    const corrected = project.files.find((f) => f.id === 'f-mica-c')!;
    expect(original.absolutePath).not.toBe(corrected.absolutePath);
    expect(original.absolutePath).toContain('/raw/');
    expect(corrected.absolutePath).toContain('/audio/processed/');
  });

  it('ショートには原音のみを置く', () => {
    const project = buildEditProject(makeInput());
    const short = project.sequences[2]!;
    expect(short.audioTracks).toHaveLength(2);
    expect(short.audioTracks.every((t) => t.enabled === true)).toBe(true);
  });
});

describe('buildEditProject — 同期オフセットの反映', () => {
  it('カメラごとのオフセットをイン点に反映する', () => {
    const project = buildEditProject(makeInput());
    const items = project.sequences[0]!.videoTracks[0]!.items;
    // 冒頭は cam_A（オフセット +1.2秒 = 36フレーム）
    const first = items[0]!;
    expect(first.startFrame).toBe(0);
    expect(first.inFrame).toBe(36);
  });

  it('音声のオフセットもイン点に反映する', () => {
    const project = buildEditProject(makeInput());
    const micA = project.sequences[0]!.audioTracks.find((t) =>
      t.label?.includes('A'),
    )!;
    // 1.35秒 × 30fps = 40.5 → 41フレーム
    expect(micA.items[0]!.inFrame).toBe(41);
  });

  it('同期確認シーケンスでは引きのみ有効にする', () => {
    const project = buildEditProject(makeInput());
    const sync = project.sequences[1]!;
    expect(sync.videoTracks[0]!.enabled).toBe(true);
    expect(sync.videoTracks[1]!.enabled).toBe(false);
    expect(sync.videoTracks[2]!.enabled).toBe(false);
  });
});

describe('buildEditProject — マーカー', () => {
  it('接頭辞つきの名前に変換する', () => {
    const project = buildEditProject(makeInput());
    const names = project.sequences[0]!.markers.map((m) => m.name);
    expect(names).toContain('[TOPIC] 給与では勝てない理由');
    expect(names).toContain('[LAUGH] 笑い（4秒）');
    expect(names).toContain('[CHECK] mic_A クリッピング');
  });

  it('時刻順に並べる', () => {
    const project = buildEditProject(makeInput());
    const frames = project.sequences[0]!.markers.map((m) => m.inFrame);
    expect([...frames]).toEqual([...frames].sort((a, b) => a - b));
  });

  it('範囲マーカーの終点をフレームに変換する', () => {
    const project = buildEditProject(makeInput());
    const laugh = project.sequences[0]!.markers.find((m) =>
      m.name.startsWith('[LAUGH]'),
    )!;
    expect(laugh.inFrame).toBe(6000);
    expect(laugh.outFrame).toBe(6120);
  });

  it('単一点マーカーの終点は -1', () => {
    const project = buildEditProject(makeInput());
    const topic = project.sequences[0]!.markers.find((m) =>
      m.name.startsWith('[TOPIC]'),
    )!;
    expect(topic.outFrame).toBe(-1);
  });

  it('ショートのマーカーにフックと選定理由を入れる', () => {
    const project = buildEditProject(makeInput());
    const marker = project.sequences[2]!.markers[0]!;
    expect(marker.comment).toContain('フック: 応募数より辞退率を見てください');
    expect(marker.comment).toContain('選定理由: 数値提示型');
  });

  it('★無音を理由とするマーカーは存在しない', () => {
    const project = buildEditProject(makeInput());
    const names = project.sequences[0]!.markers.map((m) => m.name).join(' ');
    expect(names).not.toMatch(/無音|沈黙|SILENCE|間の削除/);
  });
});

describe('buildEditProject — ショートの切り出し', () => {
  it('尺を候補の長さに合わせる', () => {
    const project = buildEditProject(makeInput());
    const short = project.sequences[2]!;
    // 130 - 83 = 47秒 × 30fps = 1410フレーム
    expect(short.durationFrames).toBe(1410);
    expect(short.videoTracks[0]!.items[0]!.endFrame).toBe(1410);
  });

  it('主に話している人の寄りカメラを使う', () => {
    const project = buildEditProject(makeInput());
    expect(project.sequences[2]!.videoTracks[0]!.label).toBe('cam_B');
  });

  it('話者が特定できない場合は引きを使う', () => {
    const project = buildEditProject(
      makeInput({
        shorts: [{ ...SHORTS[0]!, primarySpeakerId: undefined }],
      }),
    );
    expect(project.sequences[2]!.videoTracks[0]!.label).toBe('wide');
  });
});

describe('生成したXMLの妥当性', () => {
  it('全素材を1回だけ完全定義する', () => {
    const xml = generateFcp7Xml(buildEditProject(makeInput()));
    for (const path of [
      '/raw/wide.mp4',
      '/raw/cam_A.mp4',
      '/raw/cam_B.mp4',
      '/raw/audio/mic_A.wav',
      '/audio/processed/mic_A.corrected.wav',
    ]) {
      const matches = xml.match(new RegExp(`<pathurl>[^<]*${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</pathurl>`, 'g'));
      expect(matches, `${path} の定義数`).toHaveLength(1);
    }
  });

  it('クリップIDが重複しない', () => {
    const xml = generateFcp7Xml(buildEditProject(makeInput()));
    const ids = [...xml.matchAll(/<clipitem id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ショートを含む全シーケンスが出力される', () => {
    const xml = generateFcp7Xml(buildEditProject(makeInput()));
    expect(xml.match(/<sequence id=/g)).toHaveLength(3);
  });
});

describe('computeCommonRegion — 共通区間の算出', () => {
  it('負のオフセットを持つ素材の分だけ開始が後ろにずれる', () => {
    // cam_B は -0.4秒（遅く録画開始）→ 0.4秒までは参照できない。
    const region = computeCommonRegion(makeInput());
    expect(region.startSec).toBeCloseTo(0.4, 3);
  });

  it('全素材が正のオフセットなら開始は0', () => {
    const region = computeCommonRegion(
      makeInput({
        videos: VIDEOS.map((v) => ({ ...v, syncOffsetSec: Math.abs(v.syncOffsetSec) })),
        audios: AUDIOS.map((a) => ({ ...a, syncOffsetSec: Math.abs(a.syncOffsetSec) })),
      }),
    );
    expect(region.startSec).toBe(0);
  });

  it('素材が短ければ終了が早まる', () => {
    const shortFile = { ...videoFile('f-short', 'short.mp4'), durationFrames: 30 * 60 };
    const region = computeCommonRegion(
      makeInput({
        videos: [{ id: 'wide', file: shortFile, syncOffsetSec: 0 }],
        audios: [],
      }),
    );
    expect(region.endSec).toBeCloseTo(60, 1);
  });

  it('区間が成立しない場合も開始 <= 終了を保つ', () => {
    const tiny = { ...videoFile('f-tiny', 'tiny.mp4'), durationFrames: 10 };
    const region = computeCommonRegion(
      makeInput({
        videos: [{ id: 'wide', file: tiny, syncOffsetSec: -100 }],
        audios: [],
      }),
    );
    expect(region.endSec).toBeGreaterThanOrEqual(region.startSec);
  });
});

describe('buildEditProject — 同期モード', () => {
  it('既定は preserve（全尺を使い、イン点を0に丸める）', () => {
    const project = buildEditProject(makeInput());
    const main = project.sequences[0]!;
    expect(main.durationFrames).toBe(300 * 30);
    expect(main.videoTracks[0]!.items[0]!.startFrame).toBe(0);
  });

  it('preserve では負のオフセットのカメラのイン点が0に丸められる', () => {
    const project = buildEditProject(
      makeInput({
        shots: [{ startSec: 0, endSec: 10, cameraId: 'cam_B', reason: 'speech' }],
      }),
    );
    // cam_B は -0.4秒。0 + (-0.4) = -12フレーム → 0 に丸める。
    expect(project.sequences[0]!.videoTracks[0]!.items[0]!.inFrame).toBe(0);
  });

  it('common では共通区間の開始分だけ尺が短くなる', () => {
    const project = buildEditProject(makeInput({ syncMode: 'common' }));
    const main = project.sequences[0]!;
    // 300秒 - 0.4秒 = 299.6秒 → 8988フレーム
    expect(main.durationFrames).toBe(Math.round(299.6 * 30));
  });

  it('common では負のオフセットのカメラも丸めずに参照できる', () => {
    const project = buildEditProject(
      makeInput({
        syncMode: 'common',
        shots: [{ startSec: 0, endSec: 10, cameraId: 'cam_B', reason: 'speech' }],
      }),
    );
    const item = project.sequences[0]!.videoTracks[0]!.items[0]!;
    // 共通区間は0.4秒から。cam_B のイン点 = 0.4 + (-0.4) = 0フレーム（丸めではなく正確に0）
    expect(item.inFrame).toBe(0);
    // タイムライン上は0から始まる（前に詰めている）
    expect(item.startFrame).toBe(0);
  });

  it('common では他カメラのイン点も共通区間分ずれる', () => {
    const project = buildEditProject(
      makeInput({
        syncMode: 'common',
        shots: [{ startSec: 0.4, endSec: 10, cameraId: 'cam_A', reason: 'speech' }],
      }),
    );
    const item = project.sequences[0]!.videoTracks[0]!.items[0]!;
    // cam_A のイン点 = 0.4 + 1.2 = 1.6秒 = 48フレーム
    expect(item.inFrame).toBe(48);
    expect(item.startFrame).toBe(0);
  });

  it('common では共通区間外のマーカーを落とす', () => {
    const project = buildEditProject(
      makeInput({
        syncMode: 'common',
        markers: [
          { startSec: 0.1, kind: 'OP', name: '区間外', comment: '' },
          { startSec: 10, kind: 'TOPIC', name: '区間内', comment: '' },
        ],
      }),
    );
    const names = project.sequences[0]!.markers.map((m) => m.name);
    expect(names).not.toContain('[OP] 区間外');
    expect(names).toContain('[TOPIC] 区間内');
  });

  it('common ではマーカーの位置も前に詰まる', () => {
    const project = buildEditProject(
      makeInput({
        syncMode: 'common',
        markers: [{ startSec: 10, kind: 'TOPIC', name: 'x', comment: '' }],
      }),
    );
    // 10 - 0.4 = 9.6秒 = 288フレーム
    expect(project.sequences[0]!.markers[0]!.inFrame).toBe(288);
  });

  it('common では音声のイン点も共通区間分ずれる', () => {
    const project = buildEditProject(makeInput({ syncMode: 'common' }));
    const micA = project.sequences[0]!.audioTracks.find((t) =>
      t.label?.startsWith('原音 A'),
    )!;
    // (0.4 + 1.35) * 30 = 52.5 → 53フレーム
    expect(micA.items[0]!.inFrame).toBe(53);
  });

  it('common でも補正音はミュートのまま', () => {
    const project = buildEditProject(makeInput({ syncMode: 'common' }));
    const corrected = project.sequences[0]!.audioTracks.filter((t) =>
      t.label?.startsWith('補正音'),
    );
    expect(corrected.every((t) => t.enabled === false)).toBe(true);
  });

  it('common でもショートは元のタイムライン基準のまま切り出す', () => {
    const preserve = buildEditProject(makeInput());
    resetClipIds();
    const common = buildEditProject(makeInput({ syncMode: 'common' }));
    // ショートは独立したシーケンスなので、本編の詰めに影響されない。
    expect(common.sequences[2]!.durationFrames).toBe(
      preserve.sequences[2]!.durationFrames,
    );
  });
});
