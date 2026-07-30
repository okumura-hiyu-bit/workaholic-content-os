/**
 * プロジェクト配下のディレクトリ構成とパスの安全性。
 *
 * - `media/`  … 元素材への参照置き場（★ここには素材を複製しない。元は
 *               rootDir外・外付けSSD上のパスをそのまま参照する運用が基本で、
 *               `media/` はプロジェクト内に素材を置く場合の既定位置として提供する）
 * - `cache/`  … 再実行時に再利用可能。削除しても次回実行時に作り直せる
 * - `exports/`… ユーザー成果物。パイプラインは削除しない
 * - `logs/`   … 構造化ログ
 * - `temp/`   … ★削除可能。実行開始時に必ずクリアする
 *
 * @see docs/14-pipeline.md
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

import type { Project } from '../../core/src/project.ts';
import { PipelineErrors } from './errors.ts';
import type { PipelineStepId, ProjectPaths } from './types.ts';

/** プロジェクトルートから各ディレクトリのパスを組み立てる。 */
export function buildProjectPaths(projectDir: string): ProjectPaths {
  const root = resolve(projectDir);
  const cacheRoot = join(root, 'cache');
  const exportsRoot = join(root, 'exports');

  return {
    root,
    projectJson: join(root, 'project.json'),
    media: join(root, 'media'),
    cache: {
      root: cacheRoot,
      audio: join(cacheRoot, 'audio'),
      waveform: join(cacheRoot, 'waveform'),
      transcription: join(cacheRoot, 'transcription'),
      analysis: join(cacheRoot, 'analysis'),
    },
    exports: {
      root: exportsRoot,
      premiere: join(exportsRoot, 'premiere'),
      subtitles: join(exportsRoot, 'subtitles'),
      chapters: join(exportsRoot, 'chapters'),
      shorts: join(exportsRoot, 'shorts'),
      reports: join(exportsRoot, 'reports'),
    },
    logs: join(root, 'logs'),
    temp: join(root, 'temp'),
  };
}

/** 構成ディレクトリを一括で作る。 */
export function ensureProjectDirs(paths: ProjectPaths): void {
  const dirs = [
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
  ];
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
}

/**
 * temp/ を空にする。
 *
 * ★実行のたびに必ず呼ぶ。前回の実行が中断・クラッシュして残った
 * 半端なファイルは再利用せず、常に作り直す前提にする。
 */
export function clearTemp(paths: ProjectPaths): void {
  rmSync(paths.temp, { recursive: true, force: true });
  mkdirSync(paths.temp, { recursive: true });
}

/** この工程専用の一時作業ディレクトリを作る。 */
export function stepTempDir(paths: ProjectPaths, stepId: PipelineStepId): string {
  const dir = join(paths.temp, stepId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 相対パスをプロジェクトルート配下の絶対パスに解決する。
 *
 * ★`../` 等でルートの外に出ようとするパスは拒否する
 * （「プロジェクト外への意図しない書き込みを防ぐ」）。
 */
export function resolveWithinProject(
  paths: ProjectPaths,
  stepId: PipelineStepId,
  relativePath: string,
): string {
  const absolute = isAbsolute(relativePath)
    ? resolve(relativePath)
    : resolve(paths.root, relativePath);

  const rel = relative(paths.root, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw PipelineErrors.pathEscapesProject(stepId, absolute);
  }
  return absolute;
}

/**
 * ファイル名を安全な形にする。
 *
 * 日本語・空白はそのまま許容する（要件どおり動作させる対象）。
 * パス区切り文字と制御文字だけを除去する。
 */
export function safeFileName(name: string): string {
  return name
    .replace(/[/\\]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '')
    .trim() || 'untitled';
}

/**
 * 出力先が既に存在する場合、衝突しない名前を作る。
 *
 * 上書きは絶対にしない。`name (2).ext` のように連番を振る。
 */
export function collisionSafePath(targetPath: string): string {
  if (!existsSync(targetPath)) return targetPath;

  const { dir, name, ext } = parse(targetPath);
  for (let i = 2; i < 10_000; i++) {
    const candidate = join(dir, `${name} (${i})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`衝突を回避できませんでした: ${targetPath}`);
}

/**
 * ファイルを原子的に書き込む（一時ファイル→rename）。
 * 書き込み途中でプロセスが落ちても、既存の成果物を壊さない。
 */
export function writeFileAtomic(path: string, data: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, data);
  renameSync(temp, path);
}

/** この実行がこれまでに書いた（＝上書きしてよい）ファイルの集合。 */
function knownArtifactPaths(project: Project, paths: ProjectPaths): Set<string> {
  const rels = [
    ...project.exports.flatMap((e) => e.files),
    ...Object.values(project.pipeline.steps).flatMap((s) => s.outputFiles ?? []),
  ];
  return new Set(rels.map((rel) => resolve(paths.root, rel)));
}

/**
 * パイプラインの成果物を書き込む。
 *
 * ★このツールが過去に書いたファイル（`project.exports` / 各工程の
 * `outputFiles` に記録がある）は自由に上書きする——毎回の再実行で
 * 同じファイル名を使い続けられることが「Premiereへの再出力」の前提のため。
 * それ以外の理由で既に存在するファイル（ユーザーが手で置いた等）は
 * `collisionSafePath` で衝突しない名前に逃がし、黙って消さない。
 */
export function writeManagedArtifact(
  project: Project,
  paths: ProjectPaths,
  absolutePath: string,
  data: string | Buffer,
): string {
  const known = knownArtifactPaths(project, paths);
  const target =
    known.has(absolutePath) || !existsSync(absolutePath)
      ? absolutePath
      : collisionSafePath(absolutePath);
  writeFileAtomic(target, data);
  return target;
}
