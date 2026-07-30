import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createProject,
  emptyEdits,
  PROJECT_SCHEMA_VERSION,
  subtitleId,
  type Project,
} from './project.ts';
import {
  appendApiUsage,
  appendExport,
  isAiReviewStale,
  loadProject,
  migrateProject,
  projectFilePath,
  replaceAnalysis,
  saveProject,
} from './project-store.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'contentos-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sample(): Project {
  return createProject({
    id: 'ep012',
    name: '採用ブランディング',
    rootDir: '/Volumes/SSD/ep012',
    recordedAt: '2026-07-15',
    now: new Date('2026-07-30T00:00:00Z'),
  });
}

describe('saveProject / loadProject', () => {
  it('保存して読み込める', () => {
    const project = sample();
    saveProject(dir, project);
    const { project: loaded } = loadProject(dir);

    expect(loaded.id).toBe('ep012');
    expect(loaded.name).toBe('採用ブランディング');
    expect(loaded.rootDir).toBe('/Volumes/SSD/ep012');
    expect(loaded.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
  });

  it('保存時に updatedAt を更新する', () => {
    saveProject(dir, sample(), { now: new Date('2026-08-01T12:00:00Z') });
    const { project } = loadProject(dir);
    expect(project.updatedAt).toBe('2026-08-01T12:00:00.000Z');
  });

  it('★人間の修正を保存して復元できる', () => {
    const project: Project = {
      ...sample(),
      edits: {
        ...emptyEdits(),
        subtitles: { [subtitleId(3.5)]: { text: '正直な自己紹介です' } },
        shorts: { short_01: { adopted: true, title: '辞退率の話' } },
        history: [
          {
            at: '2026-07-30T01:00:00.000Z',
            actor: 'director',
            kind: 'subtitle',
            targetId: subtitleId(3.5),
            field: 'text',
            before: '事故紹介',
            after: '自己紹介',
          },
        ],
      },
    };
    saveProject(dir, project);
    const { project: loaded } = loadProject(dir);

    expect(loaded.edits.subtitles[subtitleId(3.5)]).toEqual({
      text: '正直な自己紹介です',
    });
    expect(loaded.edits.shorts.short_01).toEqual({
      adopted: true,
      title: '辞退率の話',
    });
    expect(loaded.edits.history).toHaveLength(1);
  });

  it('★一時ファイルを残さない（原子的な差し替え）', () => {
    saveProject(dir, sample());
    expect(() => readFileSync(`${projectFilePath(dir)}.tmp`)).toThrow();
  });

  it('読みやすいJSONで保存する（人が中を見て直せるように）', () => {
    saveProject(dir, sample());
    const raw = readFileSync(projectFilePath(dir), 'utf8');
    expect(raw).toContain('\n  "id": "ep012"');
    expect(raw.endsWith('\n')).toBe(true);
  });

  it('ファイルが無ければ分かるエラーにする', () => {
    expect(() => loadProject(dir)).toThrow(/見つかりません/);
  });

  it('壊れたJSONは分かるエラーにする', () => {
    writeFileSync(projectFilePath(dir), '{ broken', 'utf8');
    expect(() => loadProject(dir)).toThrow(/解釈できません/);
  });
});

describe('migrateProject', () => {
  it('★修正レイヤーが欠けていても既存の値を壊さず補う', () => {
    const { project, notes } = migrateProject({
      id: 'ep001',
      name: '旧形式',
      schemaVersion: 0,
    });
    expect(project.edits.subtitles).toEqual({});
    expect(project.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(notes.some((n) => n.includes('修正レイヤー'))).toBe(true);
  });

  it('旧バージョンからの更新を記録する', () => {
    const { notes } = migrateProject({ id: 'a', name: 'b', schemaVersion: 0 });
    expect(notes.some((n) => n.includes('v0'))).toBe(true);
  });

  it('★部分的に欠けた修正レイヤーでも既存分を保持する', () => {
    const { project } = migrateProject({
      id: 'a',
      name: 'b',
      schemaVersion: 1,
      edits: { subtitles: { 'sub-00001000': { text: '残る' } } },
    });
    expect(project.edits.subtitles['sub-00001000']).toEqual({ text: '残る' });
    expect(project.edits.cameraShots).toEqual({
      overrides: {},
      inserted: [],
      deletedIds: [],
    });
  });

  it('新しい形式は読まずにエラーにする（壊すより止める）', () => {
    expect(() =>
      migrateProject({ id: 'a', name: 'b', schemaVersion: 99 }),
    ).toThrow(/新しい形式/);
  });

  it('id や name が無ければエラーにする', () => {
    expect(() => migrateProject({ schemaVersion: 1 })).toThrow(/id または name/);
  });

  it('オブジェクトでなければエラーにする', () => {
    expect(() => migrateProject('文字列')).toThrow(/形式が不正/);
  });
});

describe('replaceAnalysis — ★再解析で修正を消さない', () => {
  it('解析を差し替えても edits はそのまま', () => {
    const project: Project = {
      ...sample(),
      edits: {
        ...emptyEdits(),
        subtitles: { [subtitleId(3.5)]: { text: '直した本文' } },
      },
    };

    const next = replaceAnalysis(project, {
      generatedAt: '2026-07-31T00:00:00.000Z',
      fingerprint: 'fp-2',
      speakers: [],
      speech: [],
      backchannels: [],
      overlaps: [],
      laughter: [],
      emphasis: [],
      subtitles: [],
      chapters: [],
      markers: [],
      cameraShots: [],
      shortCandidates: [],
      checks: [],
    });

    expect(next.edits.subtitles[subtitleId(3.5)]).toEqual({ text: '直した本文' });
    expect(next.analysis?.fingerprint).toBe('fp-2');
  });

  it('元のオブジェクトを書き換えない', () => {
    const project = sample();
    replaceAnalysis(project, undefined);
    expect(project.analysis).toBeUndefined();
  });
});

describe('appendApiUsage', () => {
  it('使用量を追記して累計を更新する', () => {
    const next = appendApiUsage(sample(), {
      at: '2026-07-30T00:00:00.000Z',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      purpose: 'rankShortCandidates',
      inputTokens: 3000,
      outputTokens: 500,
      costJpy: 0.35,
      cached: false,
    });
    expect(next.apiUsage.entries).toHaveLength(1);
    expect(next.apiUsage.totalJpy).toBeCloseTo(0.35, 4);
  });

  it('★キャッシュからの応答は累計に加算しない', () => {
    const next = appendApiUsage(sample(), {
      at: '2026-07-30T00:00:00.000Z',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      purpose: 'rankShortCandidates',
      inputTokens: 0,
      outputTokens: 0,
      costJpy: 0.35,
      cached: true,
    });
    expect(next.apiUsage.totalJpy).toBe(0);
    // 履歴には残す（何回呼ばれたかは分かるようにする）。
    expect(next.apiUsage.entries).toHaveLength(1);
  });
});

describe('appendExport / isAiReviewStale', () => {
  it('書き出し履歴を追記する', () => {
    const next = appendExport(sample(), {
      at: '2026-07-30T00:00:00.000Z',
      outputDir: '/Volumes/SSD/ep012/export',
      files: ['ep012.fcp7.xml', '字幕/subtitle.srt'],
      syncMode: 'preserve',
    });
    expect(next.exports).toHaveLength(1);
    expect(next.exports[0]!.files).toContain('ep012.fcp7.xml');
  });

  it('AI評価が古い解析に紐づいていれば古いと判定する', () => {
    const project: Project = {
      ...sample(),
      analysis: {
        generatedAt: '',
        fingerprint: 'fp-2',
        speakers: [],
        speech: [],
        backchannels: [],
        overlaps: [],
        laughter: [],
      emphasis: [],
        subtitles: [],
        chapters: [],
        markers: [],
        cameraShots: [],
        shortCandidates: [],
        checks: [],
      },
      ai: {
        analysisFingerprint: 'fp-1',
        shortReviews: [{ shortId: 'short_01', rank: 1, rationale: 'x' }],
      },
    };
    expect(isAiReviewStale(project)).toBe(true);
  });

  it('AI評価が無ければ古くない', () => {
    expect(isAiReviewStale(sample())).toBe(false);
  });
});
