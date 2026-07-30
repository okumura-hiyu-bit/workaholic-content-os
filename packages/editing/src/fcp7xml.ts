/**
 * FCP7 XML（Final Cut Pro 7 XML Interchange Format）の生成。
 *
 * ★Final Cut Pro X の .fcpxml とは別形式。Premiere Proが直接読み込めるのは
 * こちらの xmeml 形式であり、本システムはこちらのみを生成する。
 * 出力ファイル名は `<name>.fcp7.xml`（拡張子は .xml。Premiereの読み込み対象）。
 *
 * 時間はすべてフレーム単位で表現する。秒→フレームの変換は呼び出し側で行い、
 * ここでは整数フレームだけを扱う（丸め方を1か所に集約するため）。
 *
 * @see docs/12-premiere-capability-matrix.md
 */

/** タイムベース。29.97fpsのような非整数レートは ntsc=true で表す。 */
export interface Fcp7Rate {
  timebase: number;
  ntsc: boolean;
}

export interface Fcp7MediaFile {
  id: string;
  name: string;
  /** 絶対パス。pathurl として file:// URL に変換される。 */
  absolutePath: string;
  durationFrames: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  audioChannels?: number;
  sampleRate?: number;
}

export interface Fcp7ClipItem {
  id: string;
  name: string;
  /** Fcp7MediaFile.id への参照。 */
  fileId: string;
  /** シーケンス上の配置位置（フレーム）。 */
  startFrame: number;
  endFrame: number;
  /** 素材内のイン/アウト点（フレーム）。 */
  inFrame: number;
  outFrame: number;
  enabled?: boolean;
  /**
   * 音声クリップの場合、素材内の何番目の音声チャンネルを使うか（1始まり）。
   * 指定すると audio クリップとして出力される。
   */
  audioSourceTrack?: number;
}

export interface Fcp7Track {
  items: Fcp7ClipItem[];
  /** false でトラックを無効化（ミュート）する。補正音トラックに使う。 */
  enabled?: boolean;
  locked?: boolean;
  /** トラックの用途を示すコメント。XMLには出ないが生成側の可読性のために持つ。 */
  label?: string;
}

export interface Fcp7Marker {
  /** 接頭辞つきの名前。FCP7 XMLのマーカーは色を持たないため種類は名前で表す。 */
  name: string;
  comment: string;
  inFrame: number;
  /** 範囲マーカーの終点。単一点の場合は省略（-1 が出力される）。 */
  outFrame?: number;
}

export interface Fcp7Sequence {
  id: string;
  name: string;
  width: number;
  height: number;
  durationFrames: number;
  rate: Fcp7Rate;
  sampleRate: number;
  videoTracks: Fcp7Track[];
  audioTracks: Fcp7Track[];
  markers: Fcp7Marker[];
}

export interface Fcp7Project {
  name: string;
  rate: Fcp7Rate;
  sequences: Fcp7Sequence[];
  files: Fcp7MediaFile[];
}

/** XMLのテキストノード・属性値として安全な文字列にする。 */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 絶対パスを pathurl（file:// URL）に変換する。
 *
 * 日本語のフォルダ名や空白を含むパスでもPremiereが解決できるよう、
 * パーセントエンコードする。素材が外付けSSD上にある運用を想定しているため、
 * ここが誤るとメディア再リンクが必要になり、実測項目3に直接響く。
 */
export function toPathUrl(absolutePath: string): string {
  if (!absolutePath.startsWith('/')) {
    throw new Error(`絶対パスが必要です: ${absolutePath}`);
  }
  // encodeURI はスラッシュを保ちつつ空白・非ASCIIをエンコードする。
  // '#' と '?' は encodeURI が残すため個別に処理する。
  const encoded = encodeURI(absolutePath)
    .replace(/#/g, '%23')
    .replace(/\?/g, '%3F');
  return `file://localhost${encoded}`;
}

function rateXml(rate: Fcp7Rate, indent: string): string {
  return [
    `${indent}<rate>`,
    `${indent}  <timebase>${rate.timebase}</timebase>`,
    `${indent}  <ntsc>${rate.ntsc ? 'TRUE' : 'FALSE'}</ntsc>`,
    `${indent}</rate>`,
  ].join('\n');
}

/**
 * 素材ファイルの定義。
 *
 * FCP7 XMLでは、同じファイルを複数のクリップから参照する場合、
 * 最初の1回だけ完全な定義を書き、2回目以降は id 参照のみの空要素にする。
 * 全クリップで完全定義を書くとPremiereが重複素材として扱う場合がある。
 */
function fileXml(
  file: Fcp7MediaFile,
  rate: Fcp7Rate,
  indent: string,
  alreadyDefined: boolean,
): string {
  if (alreadyDefined) {
    return `${indent}<file id="${escapeXml(file.id)}"/>`;
  }

  const lines = [
    `${indent}<file id="${escapeXml(file.id)}">`,
    `${indent}  <name>${escapeXml(file.name)}</name>`,
    `${indent}  <pathurl>${escapeXml(toPathUrl(file.absolutePath))}</pathurl>`,
    rateXml(rate, `${indent}  `),
    `${indent}  <duration>${file.durationFrames}</duration>`,
    `${indent}  <media>`,
  ];

  if (file.hasVideo) {
    lines.push(
      `${indent}    <video>`,
      `${indent}      <samplecharacteristics>`,
      rateXml(rate, `${indent}        `),
      `${indent}        <width>${file.width ?? 1920}</width>`,
      `${indent}        <height>${file.height ?? 1080}</height>`,
      `${indent}        <pixelaspectratio>square</pixelaspectratio>`,
      `${indent}      </samplecharacteristics>`,
      `${indent}    </video>`,
    );
  }
  if (file.hasAudio) {
    lines.push(
      `${indent}    <audio>`,
      `${indent}      <samplecharacteristics>`,
      `${indent}        <depth>16</depth>`,
      `${indent}        <samplerate>${file.sampleRate ?? 48000}</samplerate>`,
      `${indent}      </samplecharacteristics>`,
      `${indent}      <channelcount>${file.audioChannels ?? 2}</channelcount>`,
      `${indent}    </audio>`,
    );
  }

  lines.push(`${indent}  </media>`, `${indent}</file>`);
  return lines.join('\n');
}

function clipItemXml(
  item: Fcp7ClipItem,
  file: Fcp7MediaFile,
  rate: Fcp7Rate,
  indent: string,
  alreadyDefined: boolean,
): string {
  const lines = [
    `${indent}<clipitem id="${escapeXml(item.id)}">`,
    `${indent}  <name>${escapeXml(item.name)}</name>`,
    `${indent}  <enabled>${item.enabled === false ? 'FALSE' : 'TRUE'}</enabled>`,
    `${indent}  <duration>${file.durationFrames}</duration>`,
    rateXml(rate, `${indent}  `),
    `${indent}  <start>${item.startFrame}</start>`,
    `${indent}  <end>${item.endFrame}</end>`,
    `${indent}  <in>${item.inFrame}</in>`,
    `${indent}  <out>${item.outFrame}</out>`,
    fileXml(file, rate, `${indent}  `, alreadyDefined),
  ];

  if (item.audioSourceTrack !== undefined) {
    lines.push(
      `${indent}  <sourcetrack>`,
      `${indent}    <mediatype>audio</mediatype>`,
      `${indent}    <trackindex>${item.audioSourceTrack}</trackindex>`,
      `${indent}  </sourcetrack>`,
    );
  }

  lines.push(`${indent}</clipitem>`);
  return lines.join('\n');
}

function trackXml(
  track: Fcp7Track,
  files: Map<string, Fcp7MediaFile>,
  rate: Fcp7Rate,
  indent: string,
  definedFiles: Set<string>,
): string {
  const lines = [`${indent}<track>`];

  for (const item of track.items) {
    const file = files.get(item.fileId);
    if (!file) {
      throw new Error(`素材が見つかりません: ${item.fileId}（クリップ ${item.id}）`);
    }
    lines.push(
      clipItemXml(item, file, rate, `${indent}  `, definedFiles.has(file.id)),
    );
    definedFiles.add(file.id);
  }

  // enabled / locked はクリップの後に置く（FCP7 XMLの要素順）。
  lines.push(`${indent}  <enabled>${track.enabled === false ? 'FALSE' : 'TRUE'}</enabled>`);
  lines.push(`${indent}  <locked>${track.locked ? 'TRUE' : 'FALSE'}</locked>`);
  lines.push(`${indent}</track>`);
  return lines.join('\n');
}

function markerXml(marker: Fcp7Marker, indent: string): string {
  return [
    `${indent}<marker>`,
    `${indent}  <name>${escapeXml(marker.name)}</name>`,
    `${indent}  <comment>${escapeXml(marker.comment)}</comment>`,
    `${indent}  <in>${marker.inFrame}</in>`,
    `${indent}  <out>${marker.outFrame ?? -1}</out>`,
    `${indent}</marker>`,
  ].join('\n');
}

function sequenceXml(
  sequence: Fcp7Sequence,
  files: Map<string, Fcp7MediaFile>,
  definedFiles: Set<string>,
): string {
  const rate = sequence.rate;
  const i = '      ';

  const lines = [
    `${i}<sequence id="${escapeXml(sequence.id)}">`,
    `${i}  <name>${escapeXml(sequence.name)}</name>`,
    `${i}  <duration>${sequence.durationFrames}</duration>`,
    rateXml(rate, `${i}  `),
    `${i}  <in>-1</in>`,
    `${i}  <out>-1</out>`,
    `${i}  <timecode>`,
    rateXml(rate, `${i}    `),
    `${i}    <string>00:00:00:00</string>`,
    `${i}    <frame>0</frame>`,
    `${i}    <displayformat>${rate.ntsc ? 'DF' : 'NDF'}</displayformat>`,
    `${i}  </timecode>`,
    `${i}  <media>`,
    `${i}    <video>`,
    `${i}      <format>`,
    `${i}        <samplecharacteristics>`,
    rateXml(rate, `${i}          `),
    `${i}          <width>${sequence.width}</width>`,
    `${i}          <height>${sequence.height}</height>`,
    `${i}          <pixelaspectratio>square</pixelaspectratio>`,
    `${i}        </samplecharacteristics>`,
    `${i}      </format>`,
  ];

  for (const track of sequence.videoTracks) {
    lines.push(trackXml(track, files, rate, `${i}      `, definedFiles));
  }

  lines.push(
    `${i}    </video>`,
    `${i}    <audio>`,
    `${i}      <format>`,
    `${i}        <samplecharacteristics>`,
    `${i}          <depth>16</depth>`,
    `${i}          <samplerate>${sequence.sampleRate}</samplerate>`,
    `${i}        </samplecharacteristics>`,
    `${i}      </format>`,
    `${i}      <outputs>`,
    `${i}        <group>`,
    `${i}          <index>1</index>`,
    `${i}          <numchannels>2</numchannels>`,
    `${i}          <downmix>0</downmix>`,
    `${i}          <channel><index>1</index></channel>`,
    `${i}          <channel><index>2</index></channel>`,
    `${i}        </group>`,
    `${i}      </outputs>`,
  );

  for (const track of sequence.audioTracks) {
    lines.push(trackXml(track, files, rate, `${i}      `, definedFiles));
  }

  lines.push(`${i}    </audio>`, `${i}  </media>`);

  for (const marker of sequence.markers) {
    lines.push(markerXml(marker, `${i}  `));
  }

  lines.push(`${i}</sequence>`);
  return lines.join('\n');
}

/**
 * FCP7 XML を生成する。
 *
 * ★Final Cut Pro X の fcpxml ではなく、Premiereが直接読み込める xmeml 形式。
 */
export function generateFcp7Xml(project: Fcp7Project): string {
  const files = new Map(project.files.map((f) => [f.id, f]));
  // 素材定義は最初の参照時に1回だけ書き出す。シーケンスをまたいで共有する。
  const definedFiles = new Set<string>();

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE xmeml>',
    '<xmeml version="5">',
    '  <project>',
    `    <name>${escapeXml(project.name)}</name>`,
    '    <children>',
  ];

  for (const sequence of project.sequences) {
    lines.push(sequenceXml(sequence, files, definedFiles));
  }

  lines.push('    </children>', '  </project>', '</xmeml>', '');
  return lines.join('\n');
}

/** 秒をフレームに変換する。丸め方をここに集約する。 */
export function secondsToFrames(seconds: number, rate: Fcp7Rate): number {
  const fps = rate.ntsc ? (rate.timebase * 1000) / 1001 : rate.timebase;
  return Math.round(seconds * fps);
}

/** 出力ファイル名。拡張子は .xml（Premiereの読み込み対象）。 */
export function fcp7FileName(episodeId: string): string {
  return `${episodeId}.fcp7.xml`;
}
