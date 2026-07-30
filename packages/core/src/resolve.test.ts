import { describe, expect, it } from 'vitest';

import {
  emptyEdits,
  subtitleId,
  cameraShotId,
  chapterId,
  markerId,
  timeFromId,
  type AnalysisLayer,
  type EditsLayer,
} from './project.ts';
import { adoptedShorts, recordEdit, resolveProject } from './resolve.ts';

function makeAnalysis(overrides: Partial<AnalysisLayer> = {}): AnalysisLayer {
  return {
    generatedAt: '2026-07-30T00:00:00.000Z',
    fingerprint: 'fp-1',
    speakers: [
      { id: 'A', name: '岸本', role: 'host' },
      { id: 'B', name: '山田太郎', role: 'guest' },
    ],
    speech: [],
    backchannels: [],
    overlaps: [],
    laughter: [],
      emphasis: [],
    subtitles: [
      {
        id: subtitleId(1.0),
        startSec: 1.0,
        endSec: 3.0,
        lines: ['採用は広告じゃなくて'],
        speakerId: 'A',
      },
      {
        id: subtitleId(3.5),
        startSec: 3.5,
        endSec: 5.0,
        lines: ['正直な事故紹介です'],
        speakerId: 'A',
        lowConfidenceWords: [{ text: '事故', probability: 0.68 }],
      },
    ],
    chapters: [
      { id: chapterId(0), startSec: 0, title: 'オープニング' },
      { id: chapterId(120), startSec: 120, title: '給与では勝てない' },
    ],
    markers: [
      {
        id: markerId('LAUGH', 200),
        kind: 'LAUGH',
        startSec: 200,
        endSec: 204,
        name: '笑い（4秒）',
        comment: '確信度 0.6',
      },
    ],
    cameraShots: [
      { id: cameraShotId(0), startSec: 0, endSec: 10, cameraId: 'cam_A', reason: 'speech' },
      { id: cameraShotId(10), startSec: 10, endSec: 20, cameraId: 'cam_B', reason: 'speech' },
    ],
    shortCandidates: [
      { id: 'short_01', startSec: 30, endSec: 75, score: 82, signals: ['印象的な発言を含む'] },
      { id: 'short_02', startSec: 120, endSec: 160, score: 60, signals: ['笑いが起きている'] },
    ],
    checks: [],
    ...overrides,
  };
}

describe('resolveProject — 修正がない場合', () => {
  it('解析結果をそのまま返す', () => {
    const { resolved, orphaned } = resolveProject(makeAnalysis(), emptyEdits());
    expect(resolved.subtitles).toHaveLength(2);
    expect(resolved.subtitles[0]!.lines).toEqual(['採用は広告じゃなくて']);
    expect(resolved.subtitles[0]!.edited).toBe(false);
    expect(orphaned).toEqual([]);
  });
});

describe('resolveProject — 字幕の修正', () => {
  it('本文を上書きする', () => {
    const edits: EditsLayer = {
      ...emptyEdits(),
      subtitles: { [subtitleId(3.5)]: { text: '正直な自己紹介です' } },
    };
    const { resolved } = resolveProject(makeAnalysis(), edits);
    expect(resolved.subtitles[1]!.lines).toEqual(['正直な自己紹介です']);
    expect(resolved.subtitles[1]!.edited).toBe(true);
  });

  it('改行を含む修正を行に分ける', () => {
    const edits: EditsLayer = {
      ...emptyEdits(),
      subtitles: { [subtitleId(1.0)]: { text: '1行目\n2行目' } },
    };
    const { resolved } = resolveProject(makeAnalysis(), edits);
    expect(resolved.subtitles[0]!.lines).toEqual(['1行目', '2行目']);
  });

  it('話者を付け替える', () => {
    const edits: EditsLayer = {
      ...emptyEdits(),
      subtitles: { [subtitleId(1.0)]: { speakerId: 'B' } },
    };
    const { resolved } = resolveProject(makeAnalysis(), edits);
    expect(resolved.subtitles[0]!.speakerId).toBe('B');
  });

  it('削除指定した字幕を除く', () => {
    const edits: EditsLayer = {
      ...emptyEdits(),
      subtitles: { [subtitleId(1.0)]: { deleted: true } },
    };
    const { resolved } = resolveProject(makeAnalysis(), edits);
    expect(resolved.subtitles).toHaveLength(1);
  });
});

describe('★再解析しても人間の修正が消えない', () => {
  const edits: EditsLayer = {
    ...emptyEdits(),
    subtitles: { [subtitleId(3.5)]: { text: '正直な自己紹介です' } },
    cameraShots: {
      overrides: { [cameraShotId(10)]: { cameraId: 'wide' } },
      inserted: [],
      deletedIds: [],
    },
    chapters: { [chapterId(120)]: { title: '給与では大手に勝てない' } },
  };

  it('解析結果を差し替えても修正が生き残る（IDが同じ場合）', () => {
    const reanalyzed = makeAnalysis({ fingerprint: 'fp-2' });
    const { resolved, orphaned } = resolveProject(reanalyzed, edits);

    expect(resolved.subtitles[1]!.lines).toEqual(['正直な自己紹介です']);
    expect(resolved.cameraShots[1]!.cameraId).toBe('wide');
    expect(resolved.chapters[1]!.title).toBe('給与では大手に勝てない');
    expect(orphaned).toEqual([]);
  });

  it('★時刻が少しずれても近いものに再接続する', () => {
    // 再解析で字幕の開始が3.5秒 → 3.7秒に動いた場合。
    const reanalyzed = makeAnalysis({
      subtitles: [
        {
          id: subtitleId(1.05),
          startSec: 1.05,
          endSec: 3.0,
          lines: ['採用は広告じゃなくて'],
        },
        {
          id: subtitleId(3.7),
          startSec: 3.7,
          endSec: 5.1,
          lines: ['正直な事故紹介です'],
        },
      ],
    });

    const { resolved, reattached, orphaned } = resolveProject(reanalyzed, edits);

    expect(resolved.subtitles[1]!.lines).toEqual(['正直な自己紹介です']);
    expect(reattached.some((r) => r.kind === 'subtitle')).toBe(true);
    expect(orphaned.filter((o) => o.kind === 'subtitle')).toEqual([]);
  });

  it('★許容範囲を超えたずれは捨てずに orphaned として報告する', () => {
    // 3.5秒の字幕が消え、10秒に別の字幕がある状況。
    const reanalyzed = makeAnalysis({
      subtitles: [
        { id: subtitleId(10), startSec: 10, endSec: 12, lines: ['別の内容'] },
      ],
    });

    const { orphaned } = resolveProject(reanalyzed, edits);
    const subtitleOrphan = orphaned.find((o) => o.kind === 'subtitle');

    expect(subtitleOrphan).toBeDefined();
    expect(subtitleOrphan!.originalId).toBe(subtitleId(3.5));
    expect(subtitleOrphan!.approxSec).toBeCloseTo(3.5, 3);
    // ★修正内容そのものが失われていないこと。
    expect(subtitleOrphan!.edit).toEqual({ text: '正直な自己紹介です' });
    expect(subtitleOrphan!.reason).toContain('許容範囲');
  });

  it('許容範囲を設定で変えられる', () => {
    const reanalyzed = makeAnalysis({
      subtitles: [
        { id: subtitleId(5.0), startSec: 5.0, endSec: 6.0, lines: ['ずれた'] },
      ],
    });
    const loose = resolveProject(reanalyzed, edits, {
      reattachToleranceSec: 2,
    });
    expect(loose.resolved.subtitles[0]!.lines).toEqual(['正直な自己紹介です']);
  });

  it('1つの要素に2つの修正が付かない', () => {
    const twoEdits: EditsLayer = {
      ...emptyEdits(),
      subtitles: {
        [subtitleId(3.4)]: { text: 'A' },
        [subtitleId(3.6)]: { text: 'B' },
      },
    };
    const reanalyzed = makeAnalysis({
      subtitles: [
        { id: subtitleId(3.5), startSec: 3.5, endSec: 5, lines: ['元'] },
      ],
    });
    const { resolved, orphaned } = resolveProject(reanalyzed, twoEdits);
    expect(resolved.subtitles).toHaveLength(1);
    // どちらか1つが適用され、もう1つは orphaned になる。
    expect(orphaned.filter((o) => o.kind === 'subtitle')).toHaveLength(1);
  });

  it('解析結果とIDが完全一致する修正が、時刻の近い別要素に奪われない', () => {
    const twoEdits: EditsLayer = {
      ...emptyEdits(),
      subtitles: {
        [subtitleId(3.5)]: { text: '完全一致' },
        [subtitleId(3.4)]: { text: '近いだけ' },
      },
    };
    const { resolved } = resolveProject(makeAnalysis(), twoEdits);
    const cue = resolved.subtitles.find((c) => c.id === subtitleId(3.5))!;
    expect(cue.lines).toEqual(['完全一致']);
  });
});

describe('resolveProject — カメラ切替の修正', () => {
  it('カメラを差し替える', () => {
    const edits: EditsLayer = {
      ...emptyEdits(),
      cameraShots: {
        overrides: { [cameraShotId(0)]: { cameraId: 'wide' } },
        inserted: [],
        deletedIds: [],
      },
    };
    const { resolved } = resolveProject(makeAnalysis(), edits);
    expect(resolved.cameraShots[0]!.cameraId).toBe('wide');
    expect(resolved.cameraShots[0]!.edited).toBe(true);
  });

  it('人が追加したカットを混ぜて時刻順に並べる', () => {
    const edits: EditsLayer = {
      ...emptyEdits(),
      cameraShots: {
        overrides: {},
        inserted: [
          {
            id: 'shot-manual-1',
            startSec: 5,
            endSec: 7,
            cameraId: 'wide',
            reason: 'reaction',
          },
        ],
        deletedIds: [],
      },
    };
    const { resolved } = resolveProject(makeAnalysis(), edits);
    expect(resolved.cameraShots.map((s) => s.startSec)).toEqual([0, 5, 10]);
    expect(resolved.cameraShots[1]!.inserted).toBe(true);
  });

  it('削除指定したカットを除く', () => {
    const edits: EditsLayer = {
      ...emptyEdits(),
      cameraShots: { overrides: {}, inserted: [], deletedIds: [cameraShotId(0)] },
    };
    const { resolved } = resolveProject(makeAnalysis(), edits);
    expect(resolved.cameraShots).toHaveLength(1);
  });

  it('削除対象が消えていたら報告する', () => {
    const edits: EditsLayer = {
      ...emptyEdits(),
      cameraShots: { overrides: {}, inserted: [], deletedIds: ['shot-99999999'] },
    };
    const { orphaned } = resolveProject(makeAnalysis(), edits);
    expect(orphaned.some((o) => o.reason.includes('削除対象'))).toBe(true);
  });
});

describe('resolveProject — ショート候補の採否', () => {
  it('採用・不採用を反映する', () => {
    const edits: EditsLayer = {
      ...emptyEdits(),
      shorts: {
        short_01: { adopted: true, title: '辞退率の話' },
        short_02: { adopted: false },
      },
    };
    const { resolved } = resolveProject(makeAnalysis(), edits);
    expect(resolved.shorts[0]).toMatchObject({ adopted: true, title: '辞退率の話' });
    expect(resolved.shorts[1]!.adopted).toBe(false);
  });

  it('未判断は undefined のまま（採用と区別する）', () => {
    const { resolved } = resolveProject(makeAnalysis(), emptyEdits());
    expect(resolved.shorts[0]!.adopted).toBeUndefined();
  });

  it('採用されたものだけを取り出せる', () => {
    const edits: EditsLayer = {
      ...emptyEdits(),
      shorts: { short_01: { adopted: true }, short_02: { adopted: false } },
    };
    const { resolved } = resolveProject(makeAnalysis(), edits);
    expect(adoptedShorts(resolved).map((s) => s.id)).toEqual(['short_01']);
  });

  it('★再解析で候補が変わったら採否判断を報告する（黙って消さない）', () => {
    const edits: EditsLayer = {
      ...emptyEdits(),
      shorts: { short_01: { adopted: true, title: '採用したもの' } },
    };
    const reanalyzed = makeAnalysis({
      shortCandidates: [
        { id: 'short_09', startSec: 30, endSec: 75, score: 80, signals: [] },
      ],
    });
    const { orphaned } = resolveProject(reanalyzed, edits);
    const orphan = orphaned.find((o) => o.kind === 'short')!;
    expect(orphan.originalId).toBe('short_01');
    expect(orphan.edit).toEqual({ adopted: true, title: '採用したもの' });
  });
});

describe('recordEdit — 修正履歴', () => {
  it('変更前後を履歴に残す', () => {
    const next = recordEdit(emptyEdits(), {
      kind: 'subtitle',
      targetId: subtitleId(3.5),
      field: 'text',
      before: '正直な事故紹介です',
      after: '正直な自己紹介です',
      now: new Date('2026-07-30T12:00:00Z'),
    });
    expect(next.history).toHaveLength(1);
    expect(next.history[0]).toMatchObject({
      kind: 'subtitle',
      field: 'text',
      before: '正直な事故紹介です',
      after: '正直な自己紹介です',
      actor: 'director',
      at: '2026-07-30T12:00:00.000Z',
    });
  });

  it('元のオブジェクトを書き換えない', () => {
    const before = emptyEdits();
    recordEdit(before, {
      kind: 'short',
      targetId: 'short_01',
      field: 'adopted',
      before: undefined,
      after: true,
    });
    expect(before.history).toHaveLength(0);
  });

  it('履歴を積み重ねる', () => {
    let edits = emptyEdits();
    for (let i = 0; i < 3; i++) {
      edits = recordEdit(edits, {
        kind: 'chapter',
        targetId: chapterId(i),
        field: 'title',
        before: 'a',
        after: 'b',
      });
    }
    expect(edits.history).toHaveLength(3);
  });
});

describe('ID', () => {
  it('時刻から決定的にIDを作る', () => {
    expect(subtitleId(3.5)).toBe('sub-00003500');
    expect(cameraShotId(0)).toBe('shot-00000000');
    expect(markerId('LAUGH', 200)).toBe('mk-LAUGH-00200000');
    expect(chapterId(120)).toBe('ch-00120000');
  });

  it('IDから時刻を取り出せる', () => {
    expect(timeFromId(subtitleId(3.5))).toBeCloseTo(3.5, 3);
    expect(timeFromId(markerId('LAUGH', 200))).toBeCloseTo(200, 3);
  });

  it('時刻を含まないIDでは undefined', () => {
    expect(timeFromId('short_01')).toBeUndefined();
  });

  it('同じ時刻なら同じIDになる（再解析での再現性）', () => {
    expect(subtitleId(3.5)).toBe(subtitleId(3.5));
  });
});
