/**
 * projectRoot の解決と実行環境チェック。
 *
 * ★process.cwd() を参照しないことがこのモジュールの要点なので、
 * cwdを変えても結果が変わらないことを含めて固定する。
 */

import { describe, expect, it } from 'vitest';

import { preflightEnvironment, resolveProjectRoot, type RootResolverDeps } from './project-root.ts';

const REPO = '/Users/someone/Desktop/workaholic-content-os';

/** 与えたパス集合だけが存在する、という擬似ファイルシステム。 */
function fakeFs(files: Record<string, string>): RootResolverDeps {
  return {
    fileExists: (path) => path in files,
    readTextFile: (path) => files[path],
  };
}

const repoPackageJson = JSON.stringify({ name: 'workaholic-content-os' });

describe('resolveProjectRoot', () => {
  it('開発時：appPathから上へたどってリポジトリルートを見つける', () => {
    const deps = fakeFs({
      [`${REPO}/package.json`]: repoPackageJson,
      [`${REPO}/apps/desktop/package.json`]: JSON.stringify({ name: '@contentos/desktop' }),
    });
    const result = resolveProjectRoot(
      { isPackaged: false, appPath: `${REPO}/apps/desktop` },
      deps,
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.projectRoot).toBe(REPO);
    expect(result.ok && result.source).toBe('repo');
  });

  it('★環境変数の明示指定が最優先される', () => {
    const custom = '/Volumes/SSD/content-os';
    const deps = fakeFs({
      [`${REPO}/package.json`]: repoPackageJson,
      [`${custom}/package.json`]: repoPackageJson,
    });
    const result = resolveProjectRoot(
      { explicitRoot: custom, isPackaged: false, appPath: `${REPO}/apps/desktop` },
      deps,
    );
    expect(result.ok && result.projectRoot).toBe(custom);
    expect(result.ok && result.source).toBe('explicit');
  });

  it('明示指定が存在しなければエラーを返す（黙って別の場所を使わない）', () => {
    const deps = fakeFs({ [`${REPO}/package.json`]: repoPackageJson });
    const result = resolveProjectRoot(
      { explicitRoot: '/nowhere', isPackaged: false, appPath: `${REPO}/apps/desktop` },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe('PROJECT_ROOT_NOT_FOUND');
  });

  it('パッケージ時：resources/app を使う', () => {
    const resources = '/Applications/ContentOS.app/Contents/Resources';
    const deps = fakeFs({ [`${resources}/app/package.json`]: repoPackageJson });
    const result = resolveProjectRoot(
      { isPackaged: true, resourcesPath: resources, appPath: `${resources}/app` },
      deps,
    );
    expect(result.ok && result.projectRoot).toBe(`${resources}/app`);
    expect(result.ok && result.source).toBe('resources');
  });

  it('パッケージ時：resources直下にpackage.jsonがあればそれを使う', () => {
    const resources = '/Applications/ContentOS.app/Contents/Resources';
    const deps = fakeFs({ [`${resources}/package.json`]: repoPackageJson });
    const result = resolveProjectRoot(
      { isPackaged: true, resourcesPath: resources, appPath: resources },
      deps,
    );
    expect(result.ok && result.projectRoot).toBe(resources);
  });

  it('★見つからなければエラーを返す（cwdへフォールバックしない）', () => {
    const deps = fakeFs({});
    const result = resolveProjectRoot(
      { isPackaged: false, appPath: '/somewhere/else' },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.suggestedAction).toContain(
      'CONTENTOS_PROJECT_ROOT',
    );
  });

  it('★名前が違う package.json をリポジトリルートと誤認しない', () => {
    const deps = fakeFs({
      '/somewhere/package.json': JSON.stringify({ name: 'some-other-project' }),
    });
    const result = resolveProjectRoot(
      { isPackaged: false, appPath: '/somewhere/nested/dir' },
      deps,
    );
    expect(result.ok).toBe(false);
  });

  it('壊れた package.json を無視して上へ探索を続ける', () => {
    const deps = fakeFs({
      '/a/b/package.json': '{ this is not json',
      '/a/package.json': repoPackageJson,
    });
    const result = resolveProjectRoot({ isPackaged: false, appPath: '/a/b' }, deps);
    expect(result.ok && result.projectRoot).toBe('/a');
  });

  it('★cwdを変えても結果が変わらない', () => {
    const deps = fakeFs({ [`${REPO}/package.json`]: repoPackageJson });
    const input = { isPackaged: false, appPath: `${REPO}/apps/desktop` } as const;
    const before = resolveProjectRoot(input, deps);
    const originalCwd = process.cwd();
    try {
      process.chdir('/tmp');
      const after = resolveProjectRoot(input, deps);
      expect(after).toEqual(before);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

describe('preflightEnvironment', () => {
  const ready = () =>
    fakeFs({
      [`${REPO}/dist/pipeline.js`]: '',
      [`${REPO}/dist/core.js`]: '',
      [`${REPO}/scripts/transcribe.py`]: '',
      [`${REPO}/.venv/bin/python`]: '',
    });

  it('すべて揃っていれば通る', () => {
    expect(preflightEnvironment(REPO, ready()).ok).toBe(true);
  });

  it('★dist が無ければ「npm run build」を案内する', () => {
    const deps = fakeFs({
      [`${REPO}/scripts/transcribe.py`]: '',
      [`${REPO}/.venv/bin/python`]: '',
    });
    const result = preflightEnvironment(REPO, deps);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ENVIRONMENT_NOT_READY');
    expect(result.error?.suggestedAction).toContain('npm run build');
  });

  it('★transcribe.py が無ければ分かりやすいエラーを返す', () => {
    const deps = fakeFs({
      [`${REPO}/dist/pipeline.js`]: '',
      [`${REPO}/dist/core.js`]: '',
      [`${REPO}/.venv/bin/python`]: '',
    });
    const result = preflightEnvironment(REPO, deps);
    expect(result.ok).toBe(false);
    expect(result.error?.userMessage).toContain('transcribe.py');
  });

  it('★.venv が無ければ作成コマンドを案内する', () => {
    const deps = fakeFs({
      [`${REPO}/dist/pipeline.js`]: '',
      [`${REPO}/dist/core.js`]: '',
      [`${REPO}/scripts/transcribe.py`]: '',
    });
    const result = preflightEnvironment(REPO, deps);
    expect(result.ok).toBe(false);
    expect(result.error?.userMessage).toContain('.venv');
    expect(result.error?.suggestedAction).toContain('faster-whisper');
  });

  it('エラーは安全なDTOの形をしている（technicalMessageを持たない）', () => {
    const result = preflightEnvironment(REPO, fakeFs({}));
    expect(result.error && 'technicalMessage' in result.error).toBe(false);
    expect(() => structuredClone(result.error)).not.toThrow();
  });
});
