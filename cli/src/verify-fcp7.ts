/**
 * Premiere実機検証用のFCP7 XMLを生成する。
 *
 * 最小構成（引き1本・寄り2本・出演者ごとの音声・字幕・マーカー・本編・ショート1本）
 * を組み立て、Premiereで読み込めるかを最優先で確認するためのコマンド。
 *
 * 使い方:
 *   node --experimental-strip-types cli/src/verify-fcp7.ts <素材フォルダ> [--fps 30] [--ntsc]
 *
 * 素材フォルダに以下があることを想定する（無いものは自動でスキップ）:
 *   wide.mp4 / cam_A.mp4 / cam_B.mp4
 *   audio/mic_A.wav / audio/mic_B.wav
 *
 * @see docs/12-premiere-capability-matrix.md 12.8（実測計画）
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

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
import { planCameraSwitches } from '@contentos/editing/camera-plan';
import {
  generateEmphasisSrt,
  generateSpeakerSrt,
  generateSubtitleSrt,
  generateYoutubeChapters,
} from '@contentos/editing/srt';
import type {
  CameraSource,
  ShortCandidate,
  Speaker,
  SpeechSegment,
  TimelineMarker,
  Word,
} from '@contentos/editing/types';

/** ffprobe があれば実尺を読む。無ければ null（呼び出し側で既定値を使う）。 */
function probeDurationSec(path: string): number | null {
  try {
    const out = execFileSync(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        path,
      ],
      { encoding: 'utf8' },
    ).trim();
    const value = Number.parseFloat(out);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function mediaFile(
  id: string,
  absolutePath: string,
  durationFrames: number,
  opts: { hasVideo: boolean; hasAudio: boolean; channels?: number },
): Fcp7MediaFile {
  return {
    id,
    name: basename(absolutePath),
    absolutePath,
    durationFrames,
    hasVideo: opts.hasVideo,
    hasAudio: opts.hasAudio,
    width: opts.hasVideo ? 1920 : undefined,
    height: opts.hasVideo ? 1080 : undefined,
    audioChannels: opts.channels ?? 2,
    sampleRate: 48_000,
  };
}

const SPEAKERS: Speaker[] = [
  { id: 'A', name: '出演者A', role: 'host' },
  { id: 'B', name: '出演者B', title: '検証用の肩書き', role: 'guest' },
];

function main(): void {
  const [rawDir, ...flags] = process.argv.slice(2);
  if (!rawDir) {
    console.error(
      '素材フォルダを指定してください。\n' +
        '  node --experimental-strip-types cli/src/verify-fcp7.ts <素材フォルダ> [--fps 30] [--ntsc]',
    );
    process.exit(1);
  }

  const dir = isAbsolute(rawDir) ? rawDir : resolve(process.cwd(), rawDir);
  if (!existsSync(dir)) {
    console.error(`素材フォルダが見つかりません: ${dir}`);
    process.exit(1);
  }

  const fpsIndex = flags.indexOf('--fps');
  const timebase = fpsIndex >= 0 ? Number(flags[fpsIndex + 1]) : 30;
  const rate: Fcp7Rate = { timebase, ntsc: flags.includes('--ntsc') };

  // ── 素材の検出 ────────────────────────────────────────
  const videoSpecs = [
    { id: 'wide', file: 'wide.mp4', speakerId: undefined },
    { id: 'cam_A', file: 'cam_A.mp4', speakerId: 'A' },
    { id: 'cam_B', file: 'cam_B.mp4', speakerId: 'B' },
  ];
  const audioSpecs = [
    { id: 'mic_A', file: join('audio', 'mic_A.wav'), speakerId: 'A' },
    { id: 'mic_B', file: join('audio', 'mic_B.wav'), speakerId: 'B' },
  ];

  const found: string[] = [];
  const missing: string[] = [];
  const videos: VideoSource[] = [];
  const audios: AudioSource[] = [];

  let durationSec = 0;

  for (const spec of videoSpecs) {
    const path = join(dir, spec.file);
    if (!existsSync(path)) {
      missing.push(spec.file);
      continue;
    }
    found.push(spec.file);
    const probed = probeDurationSec(path);
    if (probed && probed > durationSec) durationSec = probed;
  }

  // 尺が取れない場合（ffprobe未導入）は検証用に既定値を使う。
  const probeAvailable = durationSec > 0;
  if (!probeAvailable) durationSec = 300;

  const durationFrames = Math.round(durationSec * timebase) + timebase;

  for (const spec of videoSpecs) {
    const path = join(dir, spec.file);
    if (!existsSync(path)) continue;
    videos.push({
      id: spec.id,
      file: mediaFile(`f-${spec.id}`, path, durationFrames, {
        hasVideo: true,
        hasAudio: true,
      }),
      // 検証段階では同期解析を回さないため 0。実装後は解析結果を渡す。
      syncOffsetSec: 0,
      speakerId: spec.speakerId,
    });
  }

  for (const spec of audioSpecs) {
    const path = join(dir, spec.file);
    if (!existsSync(path)) {
      missing.push(spec.file);
      continue;
    }
    found.push(spec.file);
    audios.push({
      id: spec.id,
      kind: 'original',
      speakerId: spec.speakerId,
      file: mediaFile(`f-${spec.id}`, path, durationFrames, {
        hasVideo: false,
        hasAudio: true,
        channels: 1,
      }),
      syncOffsetSec: 0,
    });

    // 補正音があれば取り込む。★原音とは別ファイルであることが前提で、
    // 同一パスなら非破壊性が壊れているため取り込まない。
    const correctedPath = join(
      dir,
      'processed',
      `${spec.id}.corrected.wav`,
    );
    if (existsSync(correctedPath) && correctedPath !== path) {
      found.push(`processed/${spec.id}.corrected.wav`);
      audios.push({
        id: `${spec.id}_corrected`,
        kind: 'corrected',
        speakerId: spec.speakerId,
        file: mediaFile(`f-${spec.id}-c`, correctedPath, durationFrames, {
          hasVideo: false,
          hasAudio: true,
          channels: 1,
        }),
        syncOffsetSec: 0,
      });
    }
  }

  if (videos.length === 0) {
    console.error(
      `映像素材が見つかりません。以下のいずれかを ${dir} に置いてください:\n` +
        videoSpecs.map((v) => `  ${v.file}`).join('\n'),
    );
    process.exit(1);
  }

  // ── 検証用の解析結果（実際の解析はStep 2で実装）────────────
  const half = durationSec / 2;
  const speech: SpeechSegment[] = [
    { startSec: 0, endSec: half, speakerId: 'A', text: '' },
    { startSec: half, endSec: durationSec, speakerId: 'B', text: '' },
  ];

  const cameras: CameraSource[] = videos.map((v) => ({
    id: v.id,
    kind: v.id === 'wide' ? 'wide' : 'closeup',
    speakerId: v.speakerId,
    file: v.file.name,
    syncOffsetSec: v.syncOffsetSec,
  }));

  const shots = planCameraSwitches({ durationSec, speech, cameras });

  // マーカーは全種類を1つずつ入れて、Premiere側で欠落しないかを確認する。
  const markers: TimelineMarker[] = [
    { startSec: 0, kind: 'OP', name: 'オープニング', comment: '検証用' },
    {
      startSec: Math.min(10, durationSec * 0.1),
      kind: 'TOPIC',
      name: '話題区切りの検証',
      comment: '章タイトルがコメントに入るか',
    },
    {
      startSec: Math.min(20, durationSec * 0.2),
      endSec: Math.min(24, durationSec * 0.25),
      kind: 'LAUGH',
      name: '笑い（範囲マーカー）',
      comment: '範囲マーカーが範囲として入るか',
    },
    {
      startSec: Math.min(30, durationSec * 0.3),
      kind: 'KEY',
      name: '重要発言の検証',
      comment: '特殊文字テスト: A & B <重要> "引用"',
    },
    {
      startSec: Math.min(40, durationSec * 0.4),
      kind: 'RETAKE',
      name: '言い直し候補',
      comment: '★削除はしていません。候補の提示のみです',
    },
    {
      startSec: Math.min(50, durationSec * 0.5),
      kind: 'CHECK',
      name: '要確認の検証',
      comment: 'クリッピング等の要確認情報がここに入る',
    },
    { startSec: Math.max(0, durationSec - 5), kind: 'ED', name: 'エンディング', comment: '' },
  ];

  const shortEnd = Math.min(durationSec, half + 30);
  const shorts: ShortCandidate[] = [
    {
      id: 'short_01',
      startSec: half,
      endSec: shortEnd,
      title: '縦型シーケンスの検証',
      hook: '冒頭2秒のフックがここに入ります',
      rationale: '検証用の候補。1080×1920で生成されているかを確認',
      primarySpeakerId: 'B',
    },
  ];

  // ── 生成 ─────────────────────────────────────────────
  const project = buildEditProject({
    episodeId: 'verify',
    rate,
    sampleRate: 48_000,
    durationSec,
    width: 1920,
    height: 1080,
    videos,
    audios,
    shots,
    markers,
    shorts,
  });

  const outDir = join(dir, '_fcp7_verify');
  mkdirSync(join(outDir, '字幕'), { recursive: true });

  const xmlPath = join(outDir, fcp7FileName('verify'));
  writeFileSync(xmlPath, generateFcp7Xml(project), 'utf8');

  // 字幕3本。マーカーと同じく欠落率の確認対象。
  const words: Word[] = [
    { startSec: 0.0, endSec: 0.3, text: 'えー', speakerId: 'A' },
    { startSec: 0.3, endSec: 0.9, text: '字幕の', speakerId: 'A' },
    { startSec: 0.9, endSec: 1.5, text: '検証です', speakerId: 'A' },
    { startSec: 3.0, endSec: 3.6, text: '句読点は、', speakerId: 'A' },
    { startSec: 3.6, endSec: 4.4, text: '出力しません。', speakerId: 'A' },
    { startSec: half, endSec: half + 0.8, text: '話者が', speakerId: 'B' },
    { startSec: half + 0.8, endSec: half + 1.6, text: '変わりました', speakerId: 'B' },
  ];

  writeFileSync(join(outDir, '字幕', 'subtitle.srt'), generateSubtitleSrt(words), 'utf8');
  writeFileSync(join(outDir, '字幕', 'speaker.srt'), generateSpeakerSrt(speech, SPEAKERS), 'utf8');
  writeFileSync(
    join(outDir, '字幕', 'emphasis.srt'),
    generateEmphasisSrt([
      {
        startSec: Math.min(30, durationSec * 0.3),
        endSec: Math.min(34, durationSec * 0.34),
        text: '強調テロップ',
        quote: '強調テロップの検証',
      },
    ]),
    'utf8',
  );
  writeFileSync(
    join(outDir, 'youtube-chapters.txt'),
    generateYoutubeChapters(
      markers
        .filter((m) => m.kind === 'TOPIC' || m.kind === 'OP')
        .map((m) => ({ startSec: m.startSec, title: m.name })),
    ),
    'utf8',
  );

  // ── 期待値（欠落率の突き合わせ用）─────────────────────────
  const expected = {
    sequences: project.sequences.map((s) => ({
      name: s.name,
      width: s.width,
      height: s.height,
      videoClips: s.videoTracks.reduce((n, t) => n + t.items.length, 0),
      audioTracks: s.audioTracks.length,
      disabledAudioTracks: s.audioTracks.filter((t) => t.enabled === false).length,
      markers: s.markers.length,
    })),
    mediaFiles: project.files.length,
    totalMarkers: project.sequences.reduce((n, s) => n + s.markers.length, 0),
  };
  writeFileSync(
    join(outDir, 'expected.json'),
    JSON.stringify(expected, null, 2),
    'utf8',
  );

  // ── 結果表示 ──────────────────────────────────────────
  const line = '─'.repeat(60);
  console.log(line);
  console.log('FCP7 XML 生成完了（Premiere実機検証用）');
  console.log(line);
  console.log(`素材フォルダ : ${dir}`);
  console.log(`検出した素材 : ${found.join(', ')}`);
  if (missing.length > 0) console.log(`見つからず   : ${missing.join(', ')}`);
  console.log(
    `尺           : ${durationSec.toFixed(1)}秒` +
      (probeAvailable ? '（ffprobeで実測）' : '（★ffprobe未導入のため既定値300秒）'),
  );
  console.log(`フレームレート: ${timebase}${rate.ntsc ? ' (NTSC 29.97)' : ''}`);
  console.log('');
  console.log('生成ファイル:');
  console.log(`  ${xmlPath}`);
  console.log(`  ${join(outDir, '字幕')}/{subtitle,speaker,emphasis}.srt`);
  console.log(`  ${join(outDir, 'youtube-chapters.txt')}`);
  console.log(`  ${join(outDir, 'expected.json')}   ← 欠落率の突き合わせ用`);
  console.log('');
  console.log('期待される内容:');
  for (const seq of expected.sequences) {
    console.log(
      `  ${seq.name.padEnd(24)} ${seq.width}×${seq.height}  ` +
        `映像${seq.videoClips}クリップ 音声${seq.audioTracks}トラック` +
        `（うちミュート${seq.disabledAudioTracks}）マーカー${seq.markers}`,
    );
  }
  console.log('');
  console.log('Premiereでの確認手順:');
  console.log('  1. ファイル > 読み込み で上記の .fcp7.xml を選択');
  console.log('  2. 読み込みエラーが出ないか（実測項目8：エラー率 0%）');
  console.log('  3. メディア再リンクを求められないか（実測項目3：操作数 0）');
  console.log('  4. expected.json とシーケンス数・クリップ数・マーカー数を突き合わせる');
  console.log('     （実測項目9：欠落率 0%）');
  const hasCorrected = audios.some((a) => a.kind === 'corrected');
  console.log('  5. 01_本編 の音声トラック構成を確認');
  if (hasCorrected) {
    console.log('     ★原音が有効／補正音がミュートになっているか');
  } else {
    console.log(
      '     ※補正音が未生成のため今回は検証できません（Step 4で実装）。',
    );
    console.log(
      `     検証するには processed/mic_A.corrected.wav を ${dir} に置いてください。`,
    );
  }
  console.log('  6. 03_short_01 が 1080×1920 になっているか');
  console.log('  7. 字幕SRT 3本を読み込み、キャプショントラックに乗るか');
  console.log(line);
}

main();
