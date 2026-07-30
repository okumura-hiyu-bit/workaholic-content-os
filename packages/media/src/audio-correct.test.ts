import { describe, expect, it } from 'vitest';

import {
  assertNonDestructive,
  correctedPathFor,
  parseLoudnorm,
} from './audio-correct.ts';

describe('assertNonDestructive — 原音の保護', () => {
  it('入力と出力が同一パスなら例外にする', () => {
    expect(() =>
      assertNonDestructive('/tmp/raw/mic_A.wav', '/tmp/raw/mic_A.wav'),
    ).toThrow(/原音を上書き/);
  });

  it('表記が違っても同一パスと判定する（./ を含む場合）', () => {
    expect(() =>
      assertNonDestructive('/tmp/raw/./mic_A.wav', '/tmp/raw/mic_A.wav'),
    ).toThrow(/原音を上書き/);
  });

  it('相対パスと絶対パスの混在でも同一なら弾く', () => {
    const cwd = process.cwd();
    expect(() =>
      assertNonDestructive('a.wav', `${cwd}/a.wav`),
    ).toThrow(/原音を上書き/);
  });

  it('親ディレクトリを遡る表記でも同一なら弾く', () => {
    expect(() =>
      assertNonDestructive('/tmp/raw/audio/../audio/mic_A.wav', '/tmp/raw/audio/mic_A.wav'),
    ).toThrow(/原音を上書き/);
  });

  it('別パスなら通す', () => {
    expect(() =>
      assertNonDestructive(
        '/tmp/ep012/raw/audio/mic_A.wav',
        '/tmp/ep012/audio/processed/mic_A.corrected.wav',
      ),
    ).not.toThrow();
  });

  it('ファイル名だけ違う場合も通す', () => {
    expect(() =>
      assertNonDestructive('/tmp/a.wav', '/tmp/a.corrected.wav'),
    ).not.toThrow();
  });
});

describe('correctedPathFor', () => {
  it('原音とは別ディレクトリを返す', () => {
    const output = correctedPathFor('/tmp/ep012', 'mic_A');
    expect(output).toContain('/audio/processed/');
    expect(output).toContain('mic_A.corrected.wav');
    expect(output).not.toContain('/raw/');
  });

  it('返したパスが上書きチェックを通る', () => {
    const input = '/tmp/ep012/raw/audio/mic_A.wav';
    const output = correctedPathFor('/tmp/ep012', 'mic_A');
    expect(() => assertNonDestructive(input, output)).not.toThrow();
  });
});

describe('parseLoudnorm', () => {
  const sample = `
[Parsed_loudnorm_0 @ 0x123]
{
	"input_i" : "-21.53",
	"input_tp" : "-3.20",
	"input_lra" : "8.40",
	"input_thresh" : "-31.80",
	"output_i" : "-14.00",
	"target_offset" : "0.30"
}
`;

  it('測定値を取り出す', () => {
    expect(parseLoudnorm(sample)).toMatchObject({
      inputI: -21.53,
      inputTp: -3.2,
      inputLra: 8.4,
      inputThresh: -31.8,
      targetOffset: 0.3,
    });
  });

  it('JSONが無ければ空を返す（測定失敗時に落ちない）', () => {
    expect(parseLoudnorm('Error: no audio stream')).toEqual({});
  });

  it('壊れたJSONでも落ちない', () => {
    expect(parseLoudnorm('{ "input_i" : "-21.5"')).toEqual({});
  });

  it('数値でない値は undefined にする', () => {
    const broken = '{ "input_i" : "-inf", "input_tp" : "-3.2" }';
    const result = parseLoudnorm(broken);
    expect(result.inputI).toBeUndefined();
    expect(result.inputTp).toBe(-3.2);
  });
});
