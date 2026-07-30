/**
 * 解析結果から Premiere 用の編集プロジェクト（FCP7 XML）を組み立てる。
 *
 * 音声は非破壊。原音を有効なトラックとして置き、補正音は無効（ミュート）の
 * 別トラックに並べる。原音ファイルを書き換えることは一切しない。
 *
 * @see docs/11-editing-pipeline.md 11.4 / docs/12-premiere-capability-matrix.md 12.7
 */

import {
  fcp7FileName,
  secondsToFrames,
  type Fcp7ClipItem,
  type Fcp7MediaFile,
  type Fcp7Marker,
  type Fcp7Project,
  type Fcp7Rate,
  type Fcp7Sequence,
  type Fcp7Track,
} from './fcp7xml.ts';
import type { CameraShot, ShortCandidate, TimelineMarker } from './types.ts';

/** 音声素材。原音か補正音かを型で区別し、取り違えを防ぐ。 */
export interface AudioSource {
  id: string;
  /** 'original' は必ず有効トラック、'corrected' は必ず無効トラックになる。 */
  kind: 'original' | 'corrected' | 'bgm';
  /** どの話者の音声か（BGMでは未設定）。 */
  speakerId?: string;
  file: Fcp7MediaFile;
  /** 引き映像を基準としたオフセット秒。 */
  syncOffsetSec: number;
}

export interface VideoSource {
  /** 'wide' | 'cam_A' | 'cam_B' … カメラ切替案の cameraId と一致させる。 */
  id: string;
  file: Fcp7MediaFile;
  syncOffsetSec: number;
  speakerId?: string;
}

/**
 * 素材の開始タイミングがずれている場合の扱い。
 *
 * - `preserve`（既定）… 各素材の尺を最大限残し、参照できない先頭部分のみ
 *   イン点を0に丸める。負のオフセットを持つカメラは冒頭が数フレーム揃わない。
 * - `common` … 全カメラが揃っている共通区間だけでシーケンスを作る。
 *   冒頭から完全に揃うが、そのぶん尺が短くなる。
 *
 * 実収録では収録開始から本編開始まで余白を取るため、既定は `preserve` で
 * 問題にならない想定。実素材で不都合が出たら `common` に切り替える。
 */
export type SyncMode = 'preserve' | 'common';

export interface BuildProjectInput {
  episodeId: string;
  rate: Fcp7Rate;
  sampleRate: number;
  /** 本編の尺（秒）。 */
  durationSec: number;
  width: number;
  height: number;
  videos: readonly VideoSource[];
  audios: readonly AudioSource[];
  shots: readonly CameraShot[];
  markers: readonly TimelineMarker[];
  shorts: readonly ShortCandidate[];
  /** ショートシーケンスの解像度。既定は 1080×1920。 */
  shortWidth?: number;
  shortHeight?: number;
  /** 既定は 'preserve'。 */
  syncMode?: SyncMode;
}

export interface CommonRegion {
  /** 全素材が揃う開始時刻（元のタイムライン基準の秒）。 */
  startSec: number;
  /** 全素材が揃う終了時刻。 */
  endSec: number;
}

/**
 * 全素材が参照可能な共通区間を求める。
 *
 * オフセット O の素材は、タイムライン時刻 t に対して素材内 t + O を参照する。
 * これが 0 以上かつ素材の尺以内である必要があるため、
 *   開始 = max(0, 各素材の -O の最大)
 *   終了 = min(本編の尺, 各素材の (尺 - O) の最小)
 */
export function computeCommonRegion(
  input: Pick<BuildProjectInput, 'videos' | 'audios' | 'durationSec' | 'rate'>,
): CommonRegion {
  const fps = input.rate.ntsc
    ? (input.rate.timebase * 1000) / 1001
    : input.rate.timebase;

  let startSec = 0;
  let endSec = input.durationSec;

  const sources = [
    ...input.videos.map((v) => ({
      offsetSec: v.syncOffsetSec,
      durationSec: v.file.durationFrames / fps,
    })),
    ...input.audios.map((a) => ({
      offsetSec: a.syncOffsetSec,
      durationSec: a.file.durationFrames / fps,
    })),
  ];

  for (const source of sources) {
    startSec = Math.max(startSec, -source.offsetSec);
    endSec = Math.min(endSec, source.durationSec - source.offsetSec);
  }

  // 区間が成立しない場合（素材が短すぎる等）は空区間を返さず、
  // 呼び出し側が preserve に落とせるよう開始=終了で返す。
  return { startSec, endSec: Math.max(startSec, endSec) };
}

let clipCounter = 0;
function nextClipId(prefix: string): string {
  clipCounter += 1;
  return `${prefix}-${clipCounter}`;
}

/** テスト間で採番を安定させるために使う。 */
export function resetClipIds(): void {
  clipCounter = 0;
}

function markerName(marker: TimelineMarker): string {
  return `[${marker.kind}] ${marker.name}`;
}

function toFcp7Markers(
  markers: readonly TimelineMarker[],
  rate: Fcp7Rate,
): Fcp7Marker[] {
  return [...markers]
    .sort((a, b) => a.startSec - b.startSec)
    .map((m) => ({
      name: markerName(m),
      comment: m.comment,
      inFrame: secondsToFrames(m.startSec, rate),
      outFrame:
        m.endSec !== undefined ? secondsToFrames(m.endSec, rate) : -1,
    }));
}

/**
 * 本編シーケンスの映像トラックを作る。
 *
 * カメラ切替案を V1 上の連続したカットとして置く。単一トラックにするのは、
 * 編集者が通常の編集操作（リップル・ロール・置き換え）でそのまま扱えるため。
 */
function buildSwitchedVideoTrack(
  shots: readonly CameraShot[],
  videos: readonly VideoSource[],
  rate: Fcp7Rate,
  /** 共通区間方式で切り落とす先頭の秒数。preserve では 0。 */
  trimStartSec: number,
): Fcp7Track {
  const byId = new Map(videos.map((v) => [v.id, v]));
  const items: Fcp7ClipItem[] = [];

  for (const shot of shots) {
    const video = byId.get(shot.cameraId);
    if (!video) {
      throw new Error(`カメラ素材が見つかりません: ${shot.cameraId}`);
    }

    // タイムライン上の位置は共通区間の開始分だけ前に詰める。
    const startFrame = secondsToFrames(shot.startSec - trimStartSec, rate);
    const endFrame = secondsToFrames(shot.endSec - trimStartSec, rate);
    // 同期オフセットを素材内のイン点に反映する。これによりPremiereを開いた
    // 時点で全カメラが揃った状態になる。
    const inFrame = secondsToFrames(shot.startSec + video.syncOffsetSec, rate);
    const outFrame = secondsToFrames(shot.endSec + video.syncOffsetSec, rate);

    if (endFrame <= startFrame) continue;

    items.push({
      id: nextClipId('clip'),
      name: `${video.file.name} (${shot.reason})`,
      fileId: video.file.id,
      startFrame,
      endFrame,
      inFrame: Math.max(0, inFrame),
      outFrame: Math.max(1, outFrame),
    });
  }

  return { items, label: 'カメラ切替済み' };
}

/**
 * 音声トラックを作る。
 *
 * ★原音は enabled、補正音は disabled（ミュート）で並べる。
 * 編集者はトラックのミュートを切り替えるだけで聴き比べられる。
 */
function buildAudioTracks(
  audios: readonly AudioSource[],
  durationSec: number,
  rate: Fcp7Rate,
  trimStartSec: number,
): Fcp7Track[] {
  // 原音 → 補正音 → BGM の順に並べる。原音が上（A1側）に来るようにする。
  const order: AudioSource['kind'][] = ['original', 'corrected', 'bgm'];
  const sorted = [...audios].sort(
    (a, b) =>
      order.indexOf(a.kind) - order.indexOf(b.kind) ||
      (a.speakerId ?? '').localeCompare(b.speakerId ?? ''),
  );

  return sorted.map((audio) => {
    const startFrame = 0;
    const endFrame = secondsToFrames(durationSec, rate);
    const inFrame = Math.max(
      0,
      secondsToFrames(trimStartSec + audio.syncOffsetSec, rate),
    );

    const label =
      audio.kind === 'original'
        ? `原音 ${audio.speakerId ?? ''}`.trim()
        : audio.kind === 'corrected'
          ? `補正音 ${audio.speakerId ?? ''}（ミュート）`.trim()
          : 'BGM';

    return {
      // ★補正音トラックは必ず無効。原音とBGMは有効。
      enabled: audio.kind !== 'corrected',
      label,
      items: [
        {
          id: nextClipId('aclip'),
          name: audio.file.name,
          fileId: audio.file.id,
          startFrame,
          endFrame,
          inFrame,
          outFrame: inFrame + (endFrame - startFrame),
          audioSourceTrack: 1,
        },
      ],
    };
  });
}

/**
 * 同期確認用シーケンス。全カメラを尺いっぱいに重ねて配置する。
 *
 * 上位トラックは無効にしてあるため、既定では引き映像が見える。
 * トラックのオン/オフで各カメラの同期を目視確認できる。実測項目4（同期確認に
 * 必要な操作数）を小さくするために用意する。
 */
function buildSyncCheckSequence(
  input: BuildProjectInput,
  trimStartSec: number,
  durationSec: number,
): Fcp7Sequence {
  const { rate } = input;
  const endFrame = secondsToFrames(durationSec, rate);

  const videoTracks: Fcp7Track[] = input.videos.map((video, index) => ({
    // V1（引き）だけ有効。寄りは無効にして重なりで隠れないようにする。
    enabled: index === 0,
    label: video.id,
    items: [
      {
        id: nextClipId('sync'),
        name: video.file.name,
        fileId: video.file.id,
        startFrame: 0,
        endFrame,
        inFrame: Math.max(
          0,
          secondsToFrames(trimStartSec + video.syncOffsetSec, rate),
        ),
        outFrame:
          Math.max(
            0,
            secondsToFrames(trimStartSec + video.syncOffsetSec, rate),
          ) + endFrame,
      },
    ],
  }));

  return {
    id: `seq-${input.episodeId}-sync`,
    name: '02_同期確認_全カメラ',
    width: input.width,
    height: input.height,
    durationFrames: endFrame,
    rate,
    sampleRate: input.sampleRate,
    videoTracks,
    audioTracks: buildAudioTracks(
      input.audios.filter((a) => a.kind === 'original'),
      durationSec,
      rate,
      trimStartSec,
    ),
    markers: [],
  };
}

/**
 * ショートシーケンス。1080×1920 で該当区間を切り出す。
 *
 * 縦型の話者追従はXMLで指定できないため、Premiereの自動リフレームを
 * 適用してもらう前提（[12](../../docs/12-premiere-capability-matrix.md) 12.3④）。
 */
function buildShortSequence(
  short: ShortCandidate,
  index: number,
  input: BuildProjectInput,
): Fcp7Sequence {
  const { rate } = input;
  const lengthSec = short.endSec - short.startSec;
  const endFrame = secondsToFrames(lengthSec, rate);

  // 話している人の寄りカメラを優先し、無ければ引きを使う。
  const preferred =
    input.videos.find(
      (v) => short.primarySpeakerId && v.speakerId === short.primarySpeakerId,
    ) ?? input.videos[0];

  if (!preferred) throw new Error('ショート用のカメラ素材がありません');

  const inFrame = Math.max(
    0,
    secondsToFrames(short.startSec + preferred.syncOffsetSec, rate),
  );

  const videoTracks: Fcp7Track[] = [
    {
      label: preferred.id,
      items: [
        {
          id: nextClipId('short'),
          name: preferred.file.name,
          fileId: preferred.file.id,
          startFrame: 0,
          endFrame,
          inFrame,
          outFrame: inFrame + endFrame,
        },
      ],
    },
  ];

  // ショートでも原音のみを置く（補正音の聴き比べは本編で行う）。
  const audioTracks: Fcp7Track[] = input.audios
    .filter((a) => a.kind === 'original')
    .map((audio) => {
      const audioIn = Math.max(
        0,
        secondsToFrames(short.startSec + audio.syncOffsetSec, rate),
      );
      return {
        enabled: true,
        label: `原音 ${audio.speakerId ?? ''}`.trim(),
        items: [
          {
            id: nextClipId('shorta'),
            name: audio.file.name,
            fileId: audio.file.id,
            startFrame: 0,
            endFrame,
            inFrame: audioIn,
            outFrame: audioIn + endFrame,
            audioSourceTrack: 1,
          },
        ],
      };
    });

  return {
    id: `seq-${input.episodeId}-${short.id}`,
    name: `${String(index + 3).padStart(2, '0')}_${short.id}_${short.title}`,
    width: input.shortWidth ?? 1080,
    height: input.shortHeight ?? 1920,
    durationFrames: endFrame,
    rate,
    sampleRate: input.sampleRate,
    videoTracks,
    audioTracks,
    // ショートの先頭にフックをマーカーで置く。編集者が意図を確認できるように。
    markers: [
      {
        name: `[SHORT] ${short.title}`,
        comment: `フック: ${short.hook}\n選定理由: ${short.rationale}`,
        inFrame: 0,
        outFrame: -1,
      },
    ],
  };
}

/** 素材ファイルの一覧を重複なく集める。 */
function collectFiles(input: BuildProjectInput): Fcp7MediaFile[] {
  const files = new Map<string, Fcp7MediaFile>();
  for (const v of input.videos) files.set(v.file.id, v.file);
  for (const a of input.audios) files.set(a.file.id, a.file);
  return [...files.values()];
}

/**
 * 編集プロジェクトを組み立てる。
 *
 * 生成されるシーケンス:
 *   01_本編             … カメラ切替済み・原音・補正音（ミュート）・BGM
 *   02_同期確認_全カメラ  … 全カメラを重ねて配置（上位トラックは無効）
 *   03〜               … ショートシーケンス（1080×1920）
 */
export function buildEditProject(input: BuildProjectInput): Fcp7Project {
  if (input.videos.length === 0) {
    throw new Error('映像素材が1本もありません');
  }

  const { rate } = input;
  const mode: SyncMode = input.syncMode ?? 'preserve';

  // common 方式では全素材が揃う区間だけを使う。preserve では従来どおり
  // 先頭から全尺を使い、参照できない部分のイン点を0に丸める。
  const region = computeCommonRegion(input);
  const useCommon = mode === 'common' && region.endSec > region.startSec;
  const trimStartSec = useCommon ? region.startSec : 0;
  const durationSec = useCommon
    ? region.endSec - region.startSec
    : input.durationSec;

  const durationFrames = secondsToFrames(durationSec, rate);

  // 共通区間方式では、シーケンス外に出た切替とマーカーを落とし、時刻を前に詰める。
  const shots = useCommon
    ? input.shots
        .map((shot) => ({
          ...shot,
          startSec: Math.max(shot.startSec, region.startSec),
          endSec: Math.min(shot.endSec, region.endSec),
        }))
        .filter((shot) => shot.endSec > shot.startSec)
    : input.shots;

  const markers = useCommon
    ? input.markers
        .filter((m) => m.startSec >= region.startSec && m.startSec < region.endSec)
        .map((m) => ({
          ...m,
          startSec: m.startSec - trimStartSec,
          endSec:
            m.endSec !== undefined
              ? Math.min(m.endSec, region.endSec) - trimStartSec
              : undefined,
        }))
    : input.markers;

  const main: Fcp7Sequence = {
    id: `seq-${input.episodeId}-main`,
    name: '01_本編',
    width: input.width,
    height: input.height,
    durationFrames,
    rate,
    sampleRate: input.sampleRate,
    videoTracks: [
      buildSwitchedVideoTrack(shots, input.videos, rate, trimStartSec),
    ],
    audioTracks: buildAudioTracks(
      input.audios,
      durationSec,
      rate,
      trimStartSec,
    ),
    markers: toFcp7Markers(markers, rate),
  };

  const sequences: Fcp7Sequence[] = [
    main,
    buildSyncCheckSequence(input, trimStartSec, durationSec),
  ];

  for (const [index, short] of input.shorts.entries()) {
    sequences.push(buildShortSequence(short, index, input));
  }

  return {
    name: input.episodeId,
    rate,
    sequences,
    files: collectFiles(input),
  };
}

export { fcp7FileName };
