import { describe, expect, it } from 'vitest';

import {
  fcp7FileName,
  generateFcp7Xml,
  secondsToFrames,
  toPathUrl,
  type Fcp7MediaFile,
  type Fcp7Project,
  type Fcp7Rate,
} from './fcp7xml.ts';

const RATE: Fcp7Rate = { timebase: 30, ntsc: false };

const WIDE: Fcp7MediaFile = {
  id: 'file-wide',
  name: 'wide.mp4',
  absolutePath: '/Volumes/SSD/ep012/raw/wide.mp4',
  durationFrames: 54_000,
  hasVideo: true,
  hasAudio: true,
  width: 1920,
  height: 1080,
  audioChannels: 2,
  sampleRate: 48_000,
};

const MIC_A: Fcp7MediaFile = {
  id: 'file-mic-a',
  name: 'mic_A.wav',
  absolutePath: '/Volumes/SSD/ep012/raw/audio/mic_A.wav',
  durationFrames: 54_000,
  hasVideo: false,
  hasAudio: true,
  audioChannels: 1,
  sampleRate: 48_000,
};

function minimalProject(): Fcp7Project {
  return {
    name: 'ep012',
    rate: RATE,
    files: [WIDE, MIC_A],
    sequences: [
      {
        id: 'seq-main',
        name: '01_本編',
        width: 1920,
        height: 1080,
        durationFrames: 900,
        rate: RATE,
        sampleRate: 48_000,
        videoTracks: [
          {
            items: [
              {
                id: 'clip-1',
                name: 'wide.mp4',
                fileId: 'file-wide',
                startFrame: 0,
                endFrame: 900,
                inFrame: 30,
                outFrame: 930,
              },
            ],
          },
        ],
        audioTracks: [
          {
            enabled: true,
            items: [
              {
                id: 'aclip-1',
                name: 'mic_A.wav',
                fileId: 'file-mic-a',
                startFrame: 0,
                endFrame: 900,
                inFrame: 0,
                outFrame: 900,
                audioSourceTrack: 1,
              },
            ],
          },
        ],
        markers: [
          { name: '[TOPIC] オープニング', comment: '章タイトル', inFrame: 0 },
          {
            name: '[SHORT-1] 辞退率の話',
            comment: '数値提示型・保存されやすい',
            inFrame: 300,
            outFrame: 450,
          },
        ],
      },
    ],
  };
}

describe('generateFcp7Xml — 形式', () => {
  it('xmeml形式で出力する（Final Cut Pro X の fcpxml ではない）', () => {
    const xml = generateFcp7Xml(minimalProject());
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<!DOCTYPE xmeml>');
    expect(xml).toContain('<xmeml version="5">');
    // fcpxml のルート要素が混入していないこと。
    expect(xml).not.toContain('<fcpxml');
    expect(xml).not.toContain('<resources>');
  });

  it('プロジェクト名とシーケンス名を出力する', () => {
    const xml = generateFcp7Xml(minimalProject());
    expect(xml).toContain('<name>ep012</name>');
    expect(xml).toContain('<name>01_本編</name>');
  });

  it('出力ファイル名は .fcp7.xml', () => {
    expect(fcp7FileName('ep012')).toBe('ep012.fcp7.xml');
    expect(fcp7FileName('ep012').endsWith('.xml')).toBe(true);
  });
});

describe('generateFcp7Xml — 素材参照', () => {
  it('pathurlをfile://URLで出力する', () => {
    const xml = generateFcp7Xml(minimalProject());
    expect(xml).toContain(
      '<pathurl>file://localhost/Volumes/SSD/ep012/raw/wide.mp4</pathurl>',
    );
  });

  it('同じ素材を2回目以降は id 参照のみにする（重複素材を防ぐ）', () => {
    const project = minimalProject();
    project.sequences[0]!.videoTracks[0]!.items.push({
      id: 'clip-2',
      name: 'wide.mp4',
      fileId: 'file-wide',
      startFrame: 900,
      endFrame: 1800,
      inFrame: 930,
      outFrame: 1830,
    });
    const xml = generateFcp7Xml(project);

    // 完全定義（pathurlを含むもの）は1回だけ。
    expect(xml.match(/<pathurl>file:\/\/localhost\/Volumes\/SSD\/ep012\/raw\/wide\.mp4<\/pathurl>/g))
      .toHaveLength(1);
    // 2回目は空要素参照。
    expect(xml).toContain('<file id="file-wide"/>');
  });

  it('存在しない素材を参照したらエラーにする', () => {
    const project = minimalProject();
    project.sequences[0]!.videoTracks[0]!.items[0]!.fileId = 'file-missing';
    expect(() => generateFcp7Xml(project)).toThrow(/素材が見つかりません/);
  });
});

describe('toPathUrl — 日本語・空白を含むパス', () => {
  it('空白をパーセントエンコードする', () => {
    expect(toPathUrl('/Users/a/My Movies/wide.mp4')).toBe(
      'file://localhost/Users/a/My%20Movies/wide.mp4',
    );
  });

  it('日本語のフォルダ名をエンコードする', () => {
    const url = toPathUrl('/Users/a/収録素材/wide.mp4');
    expect(url).toContain('file://localhost/Users/a/');
    expect(url).toContain('/wide.mp4');
    expect(url).not.toContain('収録素材');
    expect(decodeURI(url)).toBe('file://localhost/Users/a/収録素材/wide.mp4');
  });

  it('# と ? をエンコードする', () => {
    expect(toPathUrl('/a/b#1/c?d.mp4')).toBe(
      'file://localhost/a/b%231/c%3Fd.mp4',
    );
  });

  it('スラッシュは保持する', () => {
    expect(toPathUrl('/a/b/c.mp4')).toBe('file://localhost/a/b/c.mp4');
  });

  it('相対パスはエラーにする（Premiereが解決できないため）', () => {
    expect(() => toPathUrl('raw/wide.mp4')).toThrow(/絶対パス/);
  });
});

describe('generateFcp7Xml — マーカー', () => {
  it('接頭辞つきの名前とコメントを出力する', () => {
    const xml = generateFcp7Xml(minimalProject());
    expect(xml).toContain('<name>[TOPIC] オープニング</name>');
    expect(xml).toContain('<comment>章タイトル</comment>');
  });

  it('単一点マーカーは out を -1 にする', () => {
    const xml = generateFcp7Xml(minimalProject());
    expect(xml).toMatch(/\[TOPIC\][\s\S]*?<in>0<\/in>\s*<out>-1<\/out>/);
  });

  it('範囲マーカーは out にフレーム数を入れる', () => {
    const xml = generateFcp7Xml(minimalProject());
    expect(xml).toMatch(/\[SHORT-1\][\s\S]*?<in>300<\/in>\s*<out>450<\/out>/);
  });
});

describe('generateFcp7Xml — トラックの有効/無効', () => {
  it('既定では有効（TRUE）', () => {
    const xml = generateFcp7Xml(minimalProject());
    expect(xml).toContain('<enabled>TRUE</enabled>');
  });

  it('enabled:false のトラックを無効にする（補正音のミュートに使う）', () => {
    const project = minimalProject();
    project.sequences[0]!.audioTracks.push({
      enabled: false,
      items: [
        {
          id: 'aclip-2',
          name: 'mic_A.corrected.wav',
          fileId: 'file-mic-a',
          startFrame: 0,
          endFrame: 900,
          inFrame: 0,
          outFrame: 900,
          audioSourceTrack: 1,
        },
      ],
    });
    const xml = generateFcp7Xml(project);
    expect(xml).toContain('<enabled>FALSE</enabled>');
  });

  it('音声クリップに sourcetrack を出力する', () => {
    const xml = generateFcp7Xml(minimalProject());
    expect(xml).toContain('<mediatype>audio</mediatype>');
    expect(xml).toContain('<trackindex>1</trackindex>');
  });
});

describe('generateFcp7Xml — XMLの安全性', () => {
  it('特殊文字を含む名前でも壊れない', () => {
    const project = minimalProject();
    project.sequences[0]!.markers[0]!.comment = 'A & B <重要> "引用"';
    const xml = generateFcp7Xml(project);
    expect(xml).toContain('A &amp; B &lt;重要&gt; &quot;引用&quot;');
    expect(xml).not.toContain('<重要>');
  });
});

describe('secondsToFrames', () => {
  it('整数フレームレートで換算する', () => {
    expect(secondsToFrames(1, RATE)).toBe(30);
    expect(secondsToFrames(2.5, RATE)).toBe(75);
    expect(secondsToFrames(0, RATE)).toBe(0);
  });

  it('NTSC（29.97fps）を考慮する', () => {
    const ntsc: Fcp7Rate = { timebase: 30, ntsc: true };
    expect(secondsToFrames(1, ntsc)).toBe(30);
    expect(secondsToFrames(100, ntsc)).toBe(2997);
  });

  it('四捨五入する', () => {
    expect(secondsToFrames(0.51, RATE)).toBe(15);
    expect(secondsToFrames(0.49, RATE)).toBe(15);
  });
});
