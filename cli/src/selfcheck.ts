/**
 * パイプライン全体の自己検証。
 *
 * ffmpeg で「オフセットと発話パターンが既知の」合成素材を作り、
 * 解析 → カメラ切替案 → FCP7 XML 生成までを通して、
 * 推定結果が正解と一致するかを確認する。
 *
 * 実素材が届く前に、パイプラインの接続とオフセットの符号を検証するのが目的。
 * 実素材が届いたら同じ検証を実素材に対して行う。
 *
 * 使い方:
 *   node --experimental-strip-types cli/src/selfcheck.ts [出力先] [--keep]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  checkFfmpegAvailable,
  decodeAudioMono,
  probeMedia,
  resolveBinary,
} from '@contentos/media/ffmpeg';
import { correctAudio } from '@contentos/media/audio-correct';
import {
  generateEmphasisSrt,
  generateSpeakerSrt,
  generateSubtitleSrt,
  generateYoutubeChapters,
} from '@contentos/editing/srt';
import {
  computeEnvelope,
  syncSources,
  type Envelope,
} from '@contentos/editing/audio-sync';
import {
  detectLaughterCandidates,
  detectSpeakers,
} from '@contentos/editing/speaker-detect';
import { planCameraSwitches } from '@contentos/editing/camera-plan';
import {
  buildEditProject,
  type AudioSource,
  type VideoSource,
} from '@contentos/editing/build-project';
import {
  fcp7FileName,
  generateFcp7Xml,
  type Fcp7MediaFile,
  type Fcp7Rate,
} from '@contentos/editing/fcp7xml';
import type {
  CameraSource,
  Speaker,
  Word,
} from '@contentos/editing/types';

// ─── 正解データ ───────────────────────────────────────────
/** 素材の長さ（秒）。マスター音声はこれより長く作る。 */
const CLIP_SEC = 40;
/** マスター音声上での各素材の開始位置。差がオフセットになる。 */
const STARTS = {
  wide: 3.0,
  cam_A: 1.8, // wide より 1.2秒早く録画開始 → offset +1.2
  cam_B: 3.4, // wide より 0.4秒遅く録画開始 → offset -0.4
  mic_A: 2.55, // offset +0.45
  mic_B: 3.0, // offset 0
} as const;

const EXPECTED_OFFSETS: Record<string, number> = {
  wide: 0,
  cam_A: STARTS.wide - STARTS.cam_A,
  cam_B: STARTS.wide - STARTS.cam_B,
  mic_A: STARTS.wide - STARTS.mic_A,
  mic_B: STARTS.wide - STARTS.mic_B,
};

/** マスター音声上での発話区間（wide基準の時刻に直すには STARTS.wide を引く）。 */
const MASTER = {
  aSpeech: [
    [3, 11],
    [29, 35],
  ],
  bSpeech: [[13, 21]],
  aBackchannel: [[15.3, 15.7]],
  // 最短ショット長(2.5秒)を超える同時発話にして、引きへの切替を検証する。
  overlap: [[23, 26.5]],
  bOverlapTail: [[23, 27]],
  laughter: [[37, 39]],
} as const;

const MASTER_SEC = 46;
const FPS = 30;

// ─── 合成素材の生成 ────────────────────────────────────────

/** ffmpeg の aevalsrc 用に「区間で鳴る正弦波」の式を組む。 */
function burstExpr(
  intervals: readonly (readonly [number, number])[],
  freq: number,
  modRate: number,
  gain: number,
): string {
  const gate = intervals
    .map(([s, e]) => `(gte(t,${s})*lt(t,${e}))`)
    .join('+');
  const modulation = `(0.6+0.4*sin(2*PI*${modRate}*t))`;
  return `${gain}*${modulation}*sin(2*PI*${freq}*t)*(${gate})`;
}

function run(args: string[]): void {
  execFileSync(resolveBinary('ffmpeg'), ['-hide_banner', '-loglevel', 'error', ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
}

function generateFixture(dir: string): void {
  mkdirSync(join(dir, 'audio'), { recursive: true });
  const tmp = join(dir, '_master');
  mkdirSync(tmp, { recursive: true });

  // 話者ごとのマスター音声。笑いは変調を速くして「笑いらしい」エンベロープにする。
  const aExpr = [
    burstExpr(MASTER.aSpeech, 220, 3.7, 0.5),
    burstExpr(MASTER.aBackchannel, 220, 3.7, 0.45),
    burstExpr(MASTER.overlap, 220, 3.7, 0.5),
    burstExpr(MASTER.laughter, 260, 9, 0.5),
  ].join('+');

  const bExpr = [
    burstExpr(MASTER.bSpeech, 180, 4.1, 0.5),
    burstExpr(MASTER.bOverlapTail, 180, 4.1, 0.5),
    burstExpr(MASTER.laughter, 200, 9, 0.5),
  ].join('+');

  const masterA = join(tmp, 'a.wav');
  const masterB = join(tmp, 'b.wav');

  // 式には gte(t,3) のようにカンマが含まれる。ffmpegのフィルタ構文では
  // カンマがフィルタ区切りになるため、値を単一引用符で囲む必要がある。
  const aevalsrc = (expr: string) =>
    `aevalsrc=exprs='${expr}':d=${MASTER_SEC}:s=48000`;

  run(['-y', '-f', 'lavfi', '-i', aevalsrc(aExpr), masterA]);
  run(['-y', '-f', 'lavfi', '-i', aevalsrc(bExpr), masterB]);

  // ピンマイクは他の人の声もかぶって入る（-14dB程度）。
  const micA = join(tmp, 'mic_a_master.wav');
  const micB = join(tmp, 'mic_b_master.wav');
  run([
    '-y', '-i', masterA, '-i', masterB,
    '-filter_complex', '[1:a]volume=0.2[bleed];[0:a][bleed]amix=inputs=2:normalize=0[out]',
    '-map', '[out]', micA,
  ]);
  run([
    '-y', '-i', masterB, '-i', masterA,
    '-filter_complex', '[1:a]volume=0.2[bleed];[0:a][bleed]amix=inputs=2:normalize=0[out]',
    '-map', '[out]', micB,
  ]);

  // カメラのスクラッチ音声は両者のミックス。カメラごとにEQを変えて、
  // 生波形が一致しない状況（実機に近い）を作る。
  const mixed = join(tmp, 'mix.wav');
  run([
    '-y', '-i', masterA, '-i', masterB,
    '-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0[out]',
    '-map', '[out]', mixed,
  ]);

  const videos: { id: keyof typeof STARTS; eq: string }[] = [
    { id: 'wide', eq: 'anull' },
    { id: 'cam_A', eq: 'highpass=f=200' },
    { id: 'cam_B', eq: 'lowpass=f=3000' },
  ];

  for (const video of videos) {
    run([
      '-y',
      '-f', 'lavfi',
      '-i', `color=c=gray:s=640x360:r=${FPS}:d=${CLIP_SEC}`,
      '-ss', String(STARTS[video.id]),
      '-t', String(CLIP_SEC),
      '-i', mixed,
      '-filter_complex', `[1:a]${video.eq}[a]`,
      '-map', '0:v', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      join(dir, `${video.id}.mp4`),
    ]);
  }

  for (const [id, source] of [
    ['mic_A', micA],
    ['mic_B', micB],
  ] as const) {
    run([
      '-y',
      '-ss', String(STARTS[id]),
      '-t', String(CLIP_SEC),
      '-i', source,
      join(dir, 'audio', `${id}.wav`),
    ]);
  }

  rmSync(tmp, { recursive: true, force: true });
}

// ─── 検証 ────────────────────────────────────────────────

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const keep = args.includes('--keep');
  // FCP7 XML の pathurl は絶対パスでなければPremiereが解決できない。
  // 相対パスで渡された場合はここで絶対パスに直す。
  const baseDir = resolve(
    args.find((a) => !a.startsWith('--')) ?? join(process.cwd(), '.selfcheck'),
  );

  // ★日本語と空白を含むパスで検証する（pathurl のエンコードと再リンクの確認）。
  const dir = join(baseDir, '検証素材 fixture');

  const ffmpeg = checkFfmpegAvailable();
  if (!ffmpeg.ok) {
    console.error(ffmpeg.message);
    process.exit(1);
  }
  console.log(`ffmpeg: ${ffmpeg.message.split('\n')[0]}`);
  console.log(`合成素材の生成先: ${dir}\n`);

  rmSync(dir, { recursive: true, force: true });
  generateFixture(dir);

  const checks: Check[] = [];
  const paths = {
    wide: join(dir, 'wide.mp4'),
    cam_A: join(dir, 'cam_A.mp4'),
    cam_B: join(dir, 'cam_B.mp4'),
    mic_A: join(dir, 'audio', 'mic_A.wav'),
    mic_B: join(dir, 'audio', 'mic_B.wav'),
  };

  // ① ffprobe で尺を読む
  const info = Object.fromEntries(
    Object.entries(paths).map(([id, p]) => [id, probeMedia(p)]),
  );
  const wideInfo = info.wide!;
  checks.push({
    name: '① ffprobe で尺とフレームレートを取得',
    ok: Math.abs(wideInfo.durationSec - CLIP_SEC) < 0.5 && wideInfo.fps === FPS,
    detail: `wide: ${wideInfo.durationSec.toFixed(2)}秒 / ${wideInfo.fps}fps / ${wideInfo.width}×${wideInfo.height}`,
  });

  // ② 音声デコードとエンベロープ
  const envelopes = new Map<string, Envelope>();
  for (const [id, p] of Object.entries(paths)) {
    const audio = decodeAudioMono(p);
    envelopes.set(id, computeEnvelope(audio.samples, audio.sampleRate));
  }
  checks.push({
    name: '② 全素材の音声をデコード',
    ok: [...envelopes.values()].every((e) => e.values.length > 100),
    detail: `${envelopes.size}素材 / エンベロープ ${envelopes.get('wide')!.values.length}フレーム`,
  });

  // ③ 同期オフセットの推定 ← 中心的な検証
  const sync = syncSources(
    { id: 'wide', envelope: envelopes.get('wide')! },
    ['cam_A', 'cam_B', 'mic_A', 'mic_B'].map((id) => ({
      id,
      envelope: envelopes.get(id)!,
    })),
  );

  const offsetRows: string[] = [];
  let offsetsOk = true;
  for (const [id, expected] of Object.entries(EXPECTED_OFFSETS)) {
    const result = sync.get(id)!;
    const error = Math.abs(result.offsetSec - expected);
    const withinFrame = error <= 1 / FPS;
    if (!withinFrame) offsetsOk = false;
    offsetRows.push(
      `    ${id.padEnd(6)} 正解 ${expected.toFixed(2).padStart(6)}s  ` +
        `推定 ${result.offsetSec.toFixed(2).padStart(6)}s  ` +
        `誤差 ${(error * 1000).toFixed(0).padStart(3)}ms  ` +
        `信頼度 ${result.confidence.toFixed(3)}  ${withinFrame ? '✓' : '✗'}`,
    );
  }
  checks.push({
    name: '③ 同期オフセットを1フレーム以内で復元',
    ok: offsetsOk,
    detail: `\n${offsetRows.join('\n')}`,
  });

  // ④ 話者判定
  const micTracks = [
    {
      speakerId: 'A',
      envelope: envelopes.get('mic_A')!,
      offsetSec: sync.get('mic_A')!.offsetSec,
    },
    {
      speakerId: 'B',
      envelope: envelopes.get('mic_B')!,
      offsetSec: sync.get('mic_B')!.offsetSec,
    },
  ];
  const detected = detectSpeakers(micTracks);

  const at = (t: number) =>
    detected.speech
      .filter((s) => s.startSec <= t && t < s.endSec)
      .map((s) => s.speakerId)
      .sort();

  // wide 基準の時刻に直す（マスター時刻 - STARTS.wide）。
  const rel = (masterSec: number) => masterSec - STARTS.wide;
  const speakerChecks: [string, string[], string[]][] = [
    ['Aの発話 (5s)', at(rel(6)), ['A']],
    ['Bの発話 (14s)', at(rel(17)), ['B']],
    ['沈黙 (9s)', at(rel(12)), []],
    ['沈黙 (19s)', at(rel(22)), []],
    ['相槌はAを立てない (12.4s)', at(rel(15.5)), ['B']],
    ['同時発話 (21s)', at(rel(24)), ['A', 'B']],
  ];
  const speakerOk = speakerChecks.every(
    ([, actual, expected]) => JSON.stringify(actual) === JSON.stringify(expected),
  );
  checks.push({
    name: '④ 話者判定（相槌・同時発話・沈黙）',
    ok: speakerOk,
    detail:
      '\n' +
      speakerChecks
        .map(
          ([label, actual, expected]) =>
            `    ${label.padEnd(28)} 期待 [${expected.join(',')}]  実際 [${actual.join(',')}]  ` +
            (JSON.stringify(actual) === JSON.stringify(expected) ? '✓' : '✗'),
        )
        .join('\n'),
  });

  // ⑤ 笑い検出
  const laughter = detectLaughterCandidates(micTracks, detected.overlaps);
  const laughFound = laughter.some(
    (l) => l.startSec < rel(39) && l.endSec > rel(37),
  );
  // 通常の会話の被り（23-26.5秒）を笑いと誤検出していないこと。
  const noFalsePositive = !laughter.some(
    (l) => l.startSec < rel(26) && l.endSec > rel(24),
  );
  checks.push({
    name: '⑤ 笑い候補の検出（誤検出なし）',
    ok: laughFound && noFalsePositive,
    detail:
      `${laughter.length}件検出（${laughter.map((l) => `${l.startSec.toFixed(1)}-${l.endSec.toFixed(1)}s conf=${l.confidence}`).join(', ')}）` +
      (noFalsePositive ? ' / 会話の被りの誤検出なし' : ' / ★会話の被りを誤検出'),
  });

  // ⑥ カメラ切替案
  const cameras: CameraSource[] = [
    { id: 'wide', kind: 'wide', file: 'wide.mp4', syncOffsetSec: 0 },
    {
      id: 'cam_A', kind: 'closeup', speakerId: 'A', file: 'cam_A.mp4',
      syncOffsetSec: sync.get('cam_A')!.offsetSec,
    },
    {
      id: 'cam_B', kind: 'closeup', speakerId: 'B', file: 'cam_B.mp4',
      syncOffsetSec: sync.get('cam_B')!.offsetSec,
    },
  ];
  const shots = planCameraSwitches({
    durationSec: wideInfo.durationSec,
    speech: detected.speech,
    laughter,
    cameras,
  });

  const shotAt = (t: number) => shots.find((s) => s.startSec <= t && t < s.endSec);
  const switchOk =
    shotAt(rel(6))?.cameraId === 'cam_A' &&
    shotAt(rel(17))?.cameraId === 'cam_B' &&
    shotAt(rel(12))?.cameraId === 'cam_A' && // 沈黙では切らず維持
    shotAt(rel(24))?.cameraId === 'wide'; // 同時発話は引き
  checks.push({
    name: '⑥ カメラ切替案（沈黙で切らない・同時発話で引き）',
    ok: switchOk,
    detail:
      '\n' +
      shots
        .map(
          (s) =>
            `    ${s.startSec.toFixed(2).padStart(6)}s → ${s.endSec.toFixed(2).padStart(6)}s  ` +
            `${s.cameraId.padEnd(6)} ${s.reason}`,
        )
        .join('\n'),
  });

  // ⑦ FCP7 XML 生成
  const mediaFile = (
    id: string,
    path: string,
    hasVideo: boolean,
  ): Fcp7MediaFile => {
    const probed = info[id]!;
    return {
      id: `f-${id}`,
      name: path.split('/').pop()!,
      absolutePath: path,
      durationFrames: Math.round(probed.durationSec * FPS),
      hasVideo,
      hasAudio: probed.hasAudio,
      width: probed.width,
      height: probed.height,
      audioChannels: probed.audioChannels,
      sampleRate: probed.audioSampleRate,
    };
  };

  const rate: Fcp7Rate = { timebase: FPS, ntsc: false };
  const videos: VideoSource[] = [
    { id: 'wide', file: mediaFile('wide', paths.wide, true), syncOffsetSec: 0 },
    {
      id: 'cam_A', file: mediaFile('cam_A', paths.cam_A, true),
      syncOffsetSec: sync.get('cam_A')!.offsetSec, speakerId: 'A',
    },
    {
      id: 'cam_B', file: mediaFile('cam_B', paths.cam_B, true),
      syncOffsetSec: sync.get('cam_B')!.offsetSec, speakerId: 'B',
    },
  ];
  const audios: AudioSource[] = [
    {
      id: 'mic_A', kind: 'original', speakerId: 'A',
      file: mediaFile('mic_A', paths.mic_A, false),
      syncOffsetSec: sync.get('mic_A')!.offsetSec,
    },
    {
      id: 'mic_B', kind: 'original', speakerId: 'B',
      file: mediaFile('mic_B', paths.mic_B, false),
      syncOffsetSec: sync.get('mic_B')!.offsetSec,
    },
  ];

  // ★補正音を生成する（非破壊。原音とは別ディレクトリ・別ファイル名）。
  // correctAudio は出力先が入力と同一なら実行前に例外で止まる。
  const correctionReports: string[] = [];
  for (const speakerId of ['A', 'B'] as const) {
    const micId = `mic_${speakerId}` as 'mic_A' | 'mic_B';
    const outputPath = join(dir, 'audio', 'processed', `${micId}.corrected.wav`);
    const report = await correctAudio(paths[micId], outputPath, { targetLufs: -14 });
    correctionReports.push(
      `${micId}: ${report.inputLufs?.toFixed(1) ?? '?'} LUFS → -14 LUFS`,
    );
    const probed = probeMedia(outputPath);
    audios.push({
      id: `${micId}_corrected`,
      kind: 'corrected',
      speakerId,
      file: {
        id: `f-${micId}-c`,
        name: `${micId}.corrected.wav`,
        absolutePath: outputPath,
        durationFrames: Math.round(probed.durationSec * FPS),
        hasVideo: false,
        hasAudio: true,
        audioChannels: probed.audioChannels,
        sampleRate: probed.audioSampleRate,
      },
      syncOffsetSec: sync.get(micId)!.offsetSec,
    });
  }

  const project = buildEditProject({
    episodeId: 'selfcheck',
    rate,
    sampleRate: 48_000,
    durationSec: wideInfo.durationSec,
    width: 1920,
    height: 1080,
    videos,
    audios,
    shots,
    markers: [
      ...detected.speech.slice(0, 1).map((s) => ({
        startSec: s.startSec,
        kind: 'TOPIC' as const,
        name: '冒頭',
        comment: '自己検証用',
      })),
      ...laughter.map((l) => ({
        startSec: l.startSec,
        endSec: l.endSec,
        kind: 'LAUGH' as const,
        name: `笑い（${(l.endSec - l.startSec).toFixed(1)}秒）`,
        comment:
          `関与: ${(l.speakerIds ?? []).join(', ')} / 確信度 ${l.confidence}` +
          ((l.confidence ?? 0) < 0.5 ? '（低いため要確認）' : ''),
      })),
    ],
    shorts: laughter.slice(0, 1).map((l) => ({
      id: 'short_01',
      startSec: Math.max(0, l.startSec - 8),
      endSec: Math.min(wideInfo.durationSec, l.endSec + 2),
      title: '笑いを含む候補',
      hook: '笑いの直前から入る',
      rationale: '笑いが起きた箇所は反応が取れている可能性が高い',
      primarySpeakerId: 'A',
    })),
  });

  const xml = generateFcp7Xml(project);
  const xmlPath = join(dir, fcp7FileName('selfcheck'));
  writeFileSync(xmlPath, xml, 'utf8');

  // 字幕3本とYouTubeチャプター（検証項目7）。
  const speakers: Speaker[] = [
    { id: 'A', name: '出演者A', role: 'host' },
    { id: 'B', name: '出演者B', title: '検証用の肩書き', role: 'guest' },
  ];
  const words: Word[] = [
    { startSec: 0.2, endSec: 0.5, text: 'えー', speakerId: 'A' },
    { startSec: 0.5, endSec: 1.1, text: '字幕の', speakerId: 'A' },
    { startSec: 1.1, endSec: 1.8, text: '検証です', speakerId: 'A' },
    { startSec: 3.0, endSec: 3.6, text: '句読点は、', speakerId: 'A' },
    { startSec: 3.6, endSec: 4.4, text: '出力しません。', speakerId: 'A' },
    { startSec: 11.0, endSec: 11.8, text: '話者が', speakerId: 'B' },
    { startSec: 11.8, endSec: 12.6, text: '変わりました', speakerId: 'B' },
  ];

  mkdirSync(join(dir, '字幕'), { recursive: true });
  const srtFiles = {
    subtitle: join(dir, '字幕', 'subtitle.srt'),
    speaker: join(dir, '字幕', 'speaker.srt'),
    emphasis: join(dir, '字幕', 'emphasis.srt'),
  };
  writeFileSync(srtFiles.subtitle, generateSubtitleSrt(words), 'utf8');
  writeFileSync(srtFiles.speaker, generateSpeakerSrt(detected.speech, speakers), 'utf8');
  writeFileSync(
    srtFiles.emphasis,
    generateEmphasisSrt([
      { startSec: 5, endSec: 9, text: '強調テロップ', quote: '強調テロップの検証' },
    ]),
    'utf8',
  );
  const chaptersPath = join(dir, 'youtube-chapters.txt');
  writeFileSync(
    chaptersPath,
    generateYoutubeChapters([
      { startSec: 0, title: 'オープニング' },
      { startSec: 10, title: '2章目の検証' },
      { startSec: 26, title: '3章目の検証' },
    ]),
    'utf8',
  );

  checks.push({
    name: '⑦ FCP7 XML を生成',
    ok: xml.includes('<!DOCTYPE xmeml>') && !xml.includes('<fcpxml'),
    detail: `${project.sequences.length}シーケンス / ${project.files.length}素材 / ${xmlPath}`,
  });

  // ⑧ XML の妥当性（xmllint）
  let xmlValid = false;
  let xmlDetail = '';
  try {
    execFileSync('xmllint', ['--noout', xmlPath]);
    xmlValid = true;
    xmlDetail = 'xmllint: 妥当なXML';
  } catch (error) {
    xmlDetail = `xmllint 失敗: ${(error as Error).message}`;
  }
  checks.push({ name: '⑧ XMLとして妥当', ok: xmlValid, detail: xmlDetail });

  // ⑨ 日本語・空白を含むパスのエンコード
  const encodedOk =
    xml.includes('%E6%A4%9C%E8%A8%BC') && xml.includes('%20fixture');
  const noRawPath = !xml.includes('検証素材 fixture');
  checks.push({
    name: '⑨ 日本語・空白を含むパスをエンコード',
    ok: encodedOk && noRawPath,
    detail: `pathurl 例: ${xml.match(/<pathurl>[^<]*wide\.mp4<\/pathurl>/)?.[0] ?? '(見つからず)'}`,
  });

  // ⑩ 素材定義の重複がない
  const pathurlCount = (xml.match(/<pathurl>/g) ?? []).length;
  checks.push({
    name: '⑩ 素材定義が1回だけ（重複素材を作らない）',
    ok: pathurlCount === project.files.length,
    detail: `<pathurl> ${pathurlCount}件 / 素材 ${project.files.length}件`,
  });

  // ⑪ 補正音が別ファイルかつミュート（非破壊の検証）
  const mainSeq = project.sequences[0]!;
  const correctedTracks = mainSeq.audioTracks.filter((tr) =>
    tr.label?.startsWith('補正音'),
  );
  const originalTracks = mainSeq.audioTracks.filter((tr) =>
    tr.label?.startsWith('原音'),
  );
  const correctedPathsOk = project.files
    .filter((f) => f.name.includes('corrected'))
    .every((f) => f.absolutePath.includes('/audio/processed/'));
  checks.push({
    name: '⑪ 補正音は別ファイル・別トラックでミュート（非破壊）',
    ok:
      correctedTracks.length === 2 &&
      correctedTracks.every((tr) => tr.enabled === false) &&
      originalTracks.length === 2 &&
      originalTracks.every((tr) => tr.enabled === true) &&
      correctedPathsOk,
    detail:
      `原音 ${originalTracks.length}トラック（有効）/ 補正音 ${correctedTracks.length}トラック（ミュート）\n` +
      correctionReports.map((r) => `    ${r}`).join('\n'),
  });

  // ⑫ 字幕・チャプターの出力
  const subtitleText = readFileSync(srtFiles.subtitle, 'utf8');
  const srtOk = Object.values(srtFiles).every((f) =>
    readFileSync(f, 'utf8').includes('-->'),
  );
  checks.push({
    name: '⑫ 字幕3本とチャプターを出力（フィラー除去・句読点なし）',
    ok:
      srtOk &&
      !subtitleText.includes('えー') &&
      !subtitleText.includes('、') &&
      readFileSync(chaptersPath, 'utf8').startsWith('00:00'),
    detail: '字幕/{subtitle,speaker,emphasis}.srt + youtube-chapters.txt',
  });

  // ─── 期待値（Premiereでの欠落率の突き合わせ用）───────────────
  const expected = {
    sequences: project.sequences.map((s) => ({
      name: s.name,
      resolution: `${s.width}x${s.height}`,
      durationFrames: s.durationFrames,
      videoClips: s.videoTracks.reduce((n, tr) => n + tr.items.length, 0),
      audioTracks: s.audioTracks.map((tr) => ({
        label: tr.label,
        enabled: tr.enabled !== false,
      })),
      markers: s.markers.map((m) => ({
        name: m.name,
        inFrame: m.inFrame,
        outFrame: m.outFrame,
      })),
    })),
    mediaFiles: project.files.map((f) => f.name),
    syncOffsetsSec: Object.fromEntries(
      [...sync.entries()].map(([id, r]) => [id, Number(r.offsetSec.toFixed(3))]),
    ),
    cameraShots: shots,
    subtitleCues: Object.fromEntries(
      Object.entries(srtFiles).map(([key, f]) => [
        key,
        (readFileSync(f, 'utf8').match(/-->/g) ?? []).length,
      ]),
    ),
  };
  const expectedPath = join(dir, 'expected.json');
  writeFileSync(expectedPath, JSON.stringify(expected, null, 2), 'utf8');

  // ─── 結果 ──────────────────────────────────────────────
  const line = '─'.repeat(72);
  console.log(line);
  console.log('パイプライン自己検証（合成素材）');
  console.log(line);
  for (const check of checks) {
    console.log(`${check.ok ? '✓' : '✗'} ${check.name}`);
    console.log(`    ${check.detail.trimStart()}`);
  }
  console.log(line);

  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) {
    console.log(`全 ${checks.length} 項目 合格`);
  } else {
    console.log(`${failed.length} / ${checks.length} 項目 不合格:`);
    for (const f of failed) console.log(`  ✗ ${f.name}`);
  }
  console.log(line);
  console.log('');
  console.log('★これは合成素材による検証です。実素材での検証は別途必要です:');
  console.log('  ・Premiereでの読み込み（実測項目1〜10）');
  console.log('  ・笑い検出の閾値調整（合成音は本物の笑い声と特性が違います）');
  console.log('  ・話者判定のかぶり耐性（実際のピンマイクのかぶり量で確認）');
  console.log('');
  console.log(`生成した素材とXML: ${dir}`);
  console.log(`期待値（欠落率の突き合わせ用）: ${expectedPath}`);
  console.log('  → このXMLをPremiereで読み込めば、実素材を待たずに');
  console.log('     読み込み可否（実測項目1・2・8・10）を先に確認できます。');

  if (!keep) {
    console.log('\n（--keep を付けると素材を残します。今回は残しました）');
  }

  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
