import { describe, expect, it } from 'vitest';

import { emptyEdits, subtitleId, type AnalysisLayer, type EditsLayer } from '@contentos/core/project';
import { buildResolveDiffReport } from './diff-report.ts';

function analysis(overrides: Partial<AnalysisLayer> = {}): AnalysisLayer {
  return {
    generatedAt: '2026-07-30T00:00:00.000Z',
    fingerprint: 'fp',
    speakers: [],
    speech: [],
    backchannels: [],
    overlaps: [],
    laughter: [],
    emphasis: [],
    subtitles: [
      { id: subtitleId(3.5), startSec: 3.5, endSec: 5, lines: ['事故紹介です'] },
    ],
    chapters: [],
    markers: [],
    cameraShots: [],
    shortCandidates: [],
    checks: [],
    ...overrides,
  };
}

describe('buildResolveDiffReport — 初回解析', () => {
  it('比較対象が無ければ全項目が空', () => {
    const report = buildResolveDiffReport(undefined, analysis(), emptyEdits());
    expect(report).toEqual({
      reconnected: [],
      orphaned: [],
      conflicted: [],
      added: [],
      removed: [],
    });
  });
});

describe('buildResolveDiffReport — 再接続・孤立', () => {
  it('IDが変わらなければ差分は無い', () => {
    const old = analysis();
    const report = buildResolveDiffReport(old, analysis(), emptyEdits());
    expect(report.reconnected).toEqual([]);
    expect(report.orphaned).toEqual([]);
  });

  it('★時刻が近ければ再接続として報告する', () => {
    const old = analysis();
    const edits: EditsLayer = {
      ...emptyEdits(),
      subtitles: { [subtitleId(3.5)]: { text: '正直な自己紹介です' } },
    };
    const next = analysis({
      subtitles: [{ id: subtitleId(3.7), startSec: 3.7, endSec: 5.2, lines: ['事故紹介です'] }],
    });

    const report = buildResolveDiffReport(old, next, edits);
    expect(report.reconnected).toHaveLength(1);
    expect(report.reconnected[0]).toMatchObject({ kind: 'subtitle', fromId: subtitleId(3.5) });
  });

  it('★接続先が無ければ孤立として報告する（修正内容は消えない）', () => {
    const old = analysis();
    const edits: EditsLayer = {
      ...emptyEdits(),
      subtitles: { [subtitleId(3.5)]: { text: '正直な自己紹介です' } },
    };
    const next = analysis({ subtitles: [] });

    const report = buildResolveDiffReport(old, next, edits);
    expect(report.orphaned).toHaveLength(1);
    expect(report.orphaned[0]!.originalId).toBe(subtitleId(3.5));
  });
});

describe('buildResolveDiffReport — 競合', () => {
  it('★同じIDでも中身が変わっていれば競合として報告する', () => {
    const old = analysis();
    const edits: EditsLayer = {
      ...emptyEdits(),
      subtitles: { [subtitleId(3.5)]: { text: '正直な自己紹介です' } },
    };
    // 同じIDのまま、解析側の元の内容だけが変わった（AIの再判定で違う文言になった）。
    const next = analysis({
      subtitles: [{ id: subtitleId(3.5), startSec: 3.5, endSec: 5, lines: ['まったく違う内容'] }],
    });

    const report = buildResolveDiffReport(old, next, edits);
    expect(report.conflicted).toHaveLength(1);
    expect(report.conflicted[0]).toMatchObject({
      kind: 'subtitle',
      id: subtitleId(3.5),
      humanEdit: { text: '正直な自己紹介です' },
    });
  });

  it('修正が無ければ内容が変わっても競合にしない', () => {
    const old = analysis();
    const next = analysis({
      subtitles: [{ id: subtitleId(3.5), startSec: 3.5, endSec: 5, lines: ['別の内容'] }],
    });
    const report = buildResolveDiffReport(old, next, emptyEdits());
    expect(report.conflicted).toEqual([]);
  });

  it('修正した内容と解析側の内容が一致していれば競合にしない', () => {
    const old = analysis();
    const edits: EditsLayer = {
      ...emptyEdits(),
      subtitles: { [subtitleId(3.5)]: { text: '事故紹介です' } },
    };
    const report = buildResolveDiffReport(old, analysis(), edits);
    expect(report.conflicted).toEqual([]);
  });
});

describe('buildResolveDiffReport — 追加・削除', () => {
  it('新しく増えた項目をIDつきで報告する', () => {
    const old = analysis({ subtitles: [] });
    const next = analysis();
    const report = buildResolveDiffReport(old, next, emptyEdits());
    expect(report.added).toEqual([`subtitle:${subtitleId(3.5)}`]);
  });

  it('無くなった項目をIDつきで報告する', () => {
    const old = analysis();
    const next = analysis({ subtitles: [] });
    const report = buildResolveDiffReport(old, next, emptyEdits());
    expect(report.removed).toEqual([`subtitle:${subtitleId(3.5)}`]);
  });
});
