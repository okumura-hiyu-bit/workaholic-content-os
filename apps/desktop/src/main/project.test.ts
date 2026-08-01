/**
 * project.json の読み取りと検証。
 * ★有効な project.json 以外をプロジェクトとして扱わないことを固定する。
 */

import { describe, expect, it, vi } from 'vitest';

import { readProjectSummary, toProjectDir, type ProjectReaderDeps } from './project.ts';

const validProject = {
  project: {
    id: 'ep012',
    name: '第12回 収録',
    status: '解析待ち',
    updatedAt: '2026-07-30T10:00:00.000Z',
    recordedAt: '2026-07-29',
    assets: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
  },
  notes: [],
};

function deps(overrides: Partial<ProjectReaderDeps> = {}): ProjectReaderDeps {
  return {
    fileExists: () => true,
    loadProject: () => structuredClone(validProject),
    ...overrides,
  };
}

describe('toProjectDir', () => {
  it('project.json を選んだら親ディレクトリにする', () => {
    expect(toProjectDir('/tmp/ep012/project.json')).toBe('/tmp/ep012');
  });

  it('ディレクトリを選んだらそのまま使う', () => {
    expect(toProjectDir('/tmp/ep012')).toBe('/tmp/ep012');
  });
});

describe('readProjectSummary（成功）', () => {
  it('プロジェクトの要約を返す', () => {
    const result = readProjectSummary('/tmp/ep012', deps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toEqual({
      projectPath: '/tmp/ep012',
      projectId: 'ep012',
      name: '第12回 収録',
      status: '解析待ち',
      assetCount: 3,
      updatedAt: '2026-07-30T10:00:00.000Z',
      recordedAt: '2026-07-29',
      notes: [],
    });
  });

  it('project.json のパスを渡してもディレクトリに正規化される', () => {
    const result = readProjectSummary('/tmp/ep012/project.json', deps());
    expect(result.ok && result.summary.projectPath).toBe('/tmp/ep012');
  });

  it('移行メモを引き継ぐ', () => {
    const result = readProjectSummary(
      '/tmp/ep012',
      deps({
        loadProject: () => ({ ...structuredClone(validProject), notes: ['旧形式から移行しました'] }),
      }),
    );
    expect(result.ok && result.summary.notes).toEqual(['旧形式から移行しました']);
  });

  it('★analysis（文字起こし全文など）を要約に含めない', () => {
    const result = readProjectSummary(
      '/tmp/ep012',
      deps({
        loadProject: () => ({
          project: {
            ...validProject.project,
            analysis: {
              transcript: { words: [{ text: 'これは機密の発言内容です' }] },
              subtitles: [{ text: '字幕の全文' }],
            },
          },
          notes: [],
        }),
      }),
    );
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('機密の発言内容');
    expect(serialized).not.toContain('字幕の全文');
  });
});

describe('readProjectSummary（拒否）', () => {
  it('★project.json が無いフォルダを拒否する', () => {
    const result = readProjectSummary('/tmp/not-a-project', deps({ fileExists: () => false }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('INVALID_PROJECT');
  });

  it('★壊れた project.json を拒否する', () => {
    const result = readProjectSummary(
      '/tmp/ep012',
      deps({
        loadProject: () => {
          throw new Error('Unexpected token } in JSON at position 42');
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('INVALID_PROJECT');
  });

  it('★例外の本文をユーザー向けメッセージに含めない', () => {
    const result = readProjectSummary(
      '/tmp/ep012',
      deps({
        loadProject: () => {
          throw new Error('EACCES: /Users/someone/private/project.json');
        },
      }),
    );
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('/Users/someone/private');
  });

  it('★id が無い project.json を拒否する', () => {
    const result = readProjectSummary(
      '/tmp/ep012',
      deps({ loadProject: () => ({ project: { name: 'x' }, notes: [] }) }),
    );
    expect(result.ok).toBe(false);
  });

  it('★name が無い project.json を拒否する', () => {
    const result = readProjectSummary(
      '/tmp/ep012',
      deps({ loadProject: () => ({ project: { id: 'ep012' }, notes: [] }) }),
    );
    expect(result.ok).toBe(false);
  });

  it('★空文字の id を拒否する', () => {
    const result = readProjectSummary(
      '/tmp/ep012',
      deps({ loadProject: () => ({ project: { id: '   ', name: 'x' }, notes: [] }) }),
    );
    expect(result.ok).toBe(false);
  });

  it('★相対パスを拒否する', () => {
    const result = readProjectSummary('relative/ep012', deps());
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('INVALID_REQUEST');
  });

  it('★文字列以外を拒否する', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      expect(readProjectSummary(value, deps()).ok).toBe(false);
    }
  });

  it('拒否時に loadProject を呼ばない（不正な入力でファイルを触らない）', () => {
    const loadProject = vi.fn(() => structuredClone(validProject));
    readProjectSummary('relative/path', deps({ loadProject }));
    expect(loadProject).not.toHaveBeenCalled();
  });

  it('assets が配列でなければ 0件として扱う', () => {
    const result = readProjectSummary(
      '/tmp/ep012',
      deps({
        loadProject: () => ({ project: { id: 'a', name: 'b', assets: 'not-array' }, notes: [] }),
      }),
    );
    expect(result.ok && result.summary.assetCount).toBe(0);
  });
});
