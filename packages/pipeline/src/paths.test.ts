import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProject } from '../../core/src/project.ts';
import {
  buildProjectPaths,
  clearTemp,
  collisionSafePath,
  ensureProjectDirs,
  resolveWithinProject,
  safeFileName,
  writeFileAtomic,
  writeManagedArtifact,
} from './paths.ts';

function pathsWithDirs(root: string) {
  const paths = buildProjectPaths(root);
  ensureProjectDirs(paths);
  return paths;
}

let dir: string;

beforeEach(() => {
  // ★日本語・空白を含むディレクトリ名で検証する。
  dir = mkdtempSync(join(tmpdir(), 'contentos-検証 '));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildProjectPaths / ensureProjectDirs', () => {
  it('用途別ディレクトリを作る', () => {
    const paths = buildProjectPaths(dir);
    ensureProjectDirs(paths);

    for (const p of [
      paths.media,
      paths.cache.audio,
      paths.cache.waveform,
      paths.cache.transcription,
      paths.cache.analysis,
      paths.exports.premiere,
      paths.exports.subtitles,
      paths.exports.chapters,
      paths.exports.shorts,
      paths.exports.reports,
      paths.logs,
      paths.temp,
    ]) {
      expect(existsSync(p)).toBe(true);
    }
  });

  it('projectJson は root/project.json', () => {
    const paths = buildProjectPaths(dir);
    expect(paths.projectJson).toBe(join(dir, 'project.json'));
  });
});

describe('clearTemp — ★削除可能な一時生成物', () => {
  it('前回の残骸を消して空にする', () => {
    const paths = buildProjectPaths(dir);
    ensureProjectDirs(paths);
    writeFileSync(join(paths.temp, 'leftover.tmp'), 'x');

    clearTemp(paths);

    expect(existsSync(join(paths.temp, 'leftover.tmp'))).toBe(false);
    expect(existsSync(paths.temp)).toBe(true);
  });

  it('cache/exports には触れない', () => {
    const paths = buildProjectPaths(dir);
    ensureProjectDirs(paths);
    writeFileSync(join(paths.cache.audio, 'keep.wav'), 'x');
    writeFileSync(join(paths.exports.premiere, 'keep.xml'), 'x');

    clearTemp(paths);

    expect(existsSync(join(paths.cache.audio, 'keep.wav'))).toBe(true);
    expect(existsSync(join(paths.exports.premiere, 'keep.xml'))).toBe(true);
  });
});

describe('resolveWithinProject — ★プロジェクト外への書き込みを防ぐ', () => {
  it('通常の相対パスは解決できる', () => {
    const paths = buildProjectPaths(dir);
    const resolved = resolveWithinProject(paths, 'save-artifacts', 'exports/report.html');
    expect(resolved).toBe(join(dir, 'exports/report.html'));
  });

  it('★ ../ でルートの外に出ようとすると拒否する', () => {
    const paths = buildProjectPaths(dir);
    expect(() =>
      resolveWithinProject(paths, 'save-artifacts', '../../etc/passwd'),
    ).toThrow();
  });

  it('絶対パスでも外側なら拒否する', () => {
    const paths = buildProjectPaths(dir);
    expect(() =>
      resolveWithinProject(paths, 'save-artifacts', '/etc/passwd'),
    ).toThrow();
  });

  it('絶対パスでも内側なら許可する', () => {
    const paths = buildProjectPaths(dir);
    const target = join(dir, 'exports/report.html');
    expect(resolveWithinProject(paths, 'save-artifacts', target)).toBe(target);
  });
});

describe('safeFileName — ★日本語・空白を許容しつつ危険な文字だけ除く', () => {
  it('日本語・空白はそのまま', () => {
    expect(safeFileName('採用 ブランディング')).toBe('採用 ブランディング');
  });

  it('パス区切り文字を置き換える', () => {
    expect(safeFileName('a/b\\c')).toBe('a_b_c');
  });

  it('制御文字を除く', () => {
    expect(safeFileName('a\x00b')).toBe('ab');
  });

  it('空になったら既定名にする', () => {
    expect(safeFileName('   ')).toBe('untitled');
  });
});

describe('collisionSafePath', () => {
  it('存在しなければそのまま返す', () => {
    const target = join(dir, 'a.txt');
    expect(collisionSafePath(target)).toBe(target);
  });

  it('★存在すれば連番を振る', () => {
    const target = join(dir, 'a.txt');
    writeFileSync(target, 'x');
    expect(collisionSafePath(target)).toBe(join(dir, 'a (2).txt'));
  });

  it('2番目も埋まっていれば3番目にする', () => {
    writeFileSync(join(dir, 'a.txt'), 'x');
    writeFileSync(join(dir, 'a (2).txt'), 'x');
    expect(collisionSafePath(join(dir, 'a.txt'))).toBe(join(dir, 'a (3).txt'));
  });

  it('日本語ファイル名でも動く', () => {
    const target = join(dir, '検証素材.xml');
    writeFileSync(target, 'x');
    expect(collisionSafePath(target)).toBe(join(dir, '検証素材 (2).xml'));
  });
});

describe('writeFileAtomic', () => {
  it('一時ファイルを残さない', () => {
    const target = join(dir, 'sub', 'a.txt');
    writeFileAtomic(target, 'hello');
    expect(readFileSync(target, 'utf8')).toBe('hello');
    expect(existsSync(`${target}.tmp-${process.pid}`)).toBe(false);
  });
});

describe('writeManagedArtifact — ★衝突時は安全な命名、既知の成果物は上書き可', () => {
  it('初回は指定したパスにそのまま書く', () => {
    const paths = pathsWithDirs(dir);
    const project = createProject({ id: 'ep1', name: 'x', rootDir: dir });
    const target = join(paths.exports.premiere, 'ep1.fcp7.xml');

    const written = writeManagedArtifact(project, paths, target, 'v1');
    expect(written).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('v1');
  });

  it('自分が過去に書いたと分かっているファイルは上書きする', () => {
    const paths = pathsWithDirs(dir);
    const target = join(paths.exports.premiere, 'ep1.fcp7.xml');
    writeFileSync(target, 'old');

    const project = createProject({ id: 'ep1', name: 'x', rootDir: dir });
    project.exports.push({
      at: '2026-01-01T00:00:00Z',
      outputDir: paths.exports.root,
      files: [target],
      syncMode: 'preserve',
    });

    const written = writeManagedArtifact(project, paths, target, 'new');
    expect(written).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('new');
  });

  it('★自分が書いたと確認できない既存ファイルは退避する（上書きしない）', () => {
    const paths = pathsWithDirs(dir);
    const target = join(paths.exports.premiere, 'ep1.fcp7.xml');
    writeFileSync(target, 'someone-elses-file');

    const project = createProject({ id: 'ep1', name: 'x', rootDir: dir });
    const written = writeManagedArtifact(project, paths, target, 'new');

    expect(written).not.toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('someone-elses-file');
    expect(readFileSync(written, 'utf8')).toBe('new');
  });
});
