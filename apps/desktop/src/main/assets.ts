/**
 * 素材の登録・役割設定・解析前チェック。
 *
 * ★元素材を移動・コピー・上書きしない。読むだけ。
 * project.json には絶対パスとメタデータだけを保存する。
 *
 * ★project.analysis と project.edits には一切触らない。
 * 素材登録は `assets` と（無効素材の退避先である）`disabledAssets` だけを扱う。
 *
 * ★無効にした素材は project.assets から外す。
 * パイプラインは project.assets を全部使うため、外さないと「無効にしたのに
 * 解析に使われる」ことになる。捨てずに disabledAssets へ退避して保持する。
 */

import { basename, dirname } from 'node:path';

import { DESKTOP_ERROR_CODES, safeError } from '../shared/errors.ts';
import { conflictError } from '../shared/review-validate.ts';
import type {
  AssetDto,
  AssetRoleId,
  SetupData,
  SetupIssue,
  SetupLoadResult,
  SetupSaveResult,
  SetupSpeakerDto,
  SpeakerSlot,
} from '../shared/setup-dto.ts';
import { SPEAKER_SLOTS } from '../shared/setup-dto.ts';
import type { ProjectLike } from './review.ts';

// ─── 型 ────────────────────────────────────────────────

/** project.json に保存する素材。★core の ProjectAsset に任意項目を足した形。 */
export interface StoredAsset {
  id: string;
  role: AssetRoleId;
  absolutePath: string;
  fileName: string;
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
  audioChannels?: number;
  audioSampleRate?: number;
  sizeBytes?: number;
  mtimeMs?: number;
  /** ★自動推測のまま解析に使わせないための印。未設定（旧データ）は確定扱い。 */
  roleConfirmed?: boolean;
  suggestedRole?: AssetRoleId;
}

export interface MediaProbe {
  durationSec: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  fps?: number;
  audioChannels?: number;
  audioSampleRate?: number;
}

export interface AssetDeps {
  loadProject(projectDir: string): { project: ProjectLike };
  saveProject(projectDir: string, project: ProjectLike): string;
  fileExists(path: string): boolean;
  /** 読み取り可能か。 */
  canRead(path: string): boolean;
  /** 書き込み可能か。 */
  canWrite(dir: string): boolean;
  statFile(path: string): { sizeBytes: number; mtimeMs: number } | undefined;
  /** ffprobe。★テストでは差し替えて実行しない。 */
  probe(path: string): MediaProbe;
  /** 空き容量（バイト）。取得できなければ undefined。 */
  freeBytes(dir: string): number | undefined;
}

/** 空き容量がこれを下回ったら警告する。 */
export const LOW_DISK_WARNING_BYTES = 2 * 1024 * 1024 * 1024;

// ─── 役割の自動推測 ────────────────────────────────────

/**
 * ファイル名から役割を推測する。★あくまで提案。
 * 人が確定するまで `roleConfirmed` は false のままにし、解析を止める。
 */
export function suggestRole(fileName: string, probe: MediaProbe): AssetRoleId {
  const name = fileName.toLowerCase();

  for (const slot of SPEAKER_SLOTS) {
    const s = slot.toLowerCase();
    if (new RegExp(`mic[_\\-. ]?${s}\\b|${s}[_\\-. ]?mic`).test(name)) {
      return `mic_${slot}` as AssetRoleId;
    }
    if (new RegExp(`cam(era)?[_\\-. ]?${s}\\b`).test(name)) {
      return `cam_${slot}` as AssetRoleId;
    }
  }

  if (/wide|hiki|引き|ひき|全景|マスター|master/.test(name)) return 'wide';
  if (/bgm|music|音楽/.test(name)) return 'bgm';
  if (/opening|オープニング|^op[_\-.]/.test(name)) return 'opening';
  if (/ending|エンディング|^ed[_\-.]/.test(name)) return 'ending';
  if (/logo|ロゴ/.test(name)) return 'logo';
  if (/thumb|サムネ/.test(name)) return 'thumbnail';

  // 名前から分からない場合は中身で寄せる。
  if (!probe.hasVideo && probe.hasAudio) return 'other';
  return 'other';
}

/** 役割から対応する出演者枠を導く（`mic_A` → 'A'）。 */
export function speakerSlotOfRole(role: AssetRoleId): SpeakerSlot | undefined {
  const match = /^(?:mic|cam)_([A-C])$/.exec(role);
  return match ? (match[1] as SpeakerSlot) : undefined;
}

// ─── 変換 ──────────────────────────────────────────────

/**
 * 文字起こしの音声源になる素材を選ぶ。
 * ★`packages/pipeline` の transcribe 工程と同じ基準にする（wide優先）。
 * 変更できる値ではないので、画面には読み取り専用で出す。
 */
export function mainAudioAssetId(assets: readonly StoredAsset[]): string | undefined {
  return (
    assets.find((a) => a.role === 'wide' && a.hasAudio)?.id ??
    assets.find((a) => a.role.startsWith('cam_') && a.hasAudio)?.id
  );
}

function toDto(asset: StoredAsset, enabled: boolean, mainId: string | undefined): AssetDto {
  const dto: AssetDto = {
    id: asset.id,
    role: asset.role,
    fileName: asset.fileName,
    // ★絶対パスは渡さない。どのフォルダから来たかが分かる親フォルダ名まで。
    directoryName: basename(dirname(asset.absolutePath)),
    durationSec: asset.durationSec,
    hasVideo: asset.hasVideo,
    hasAudio: asset.hasAudio,
    // 旧データ（roleConfirmed 未設定）は確定済みとして扱う。
    roleConfirmed: asset.roleConfirmed !== false,
    enabled,
    mainAudio: enabled && asset.id === mainId,
  };
  if (asset.width !== undefined) dto.width = asset.width;
  if (asset.height !== undefined) dto.height = asset.height;
  if (asset.fps !== undefined) dto.fps = asset.fps;
  if (asset.audioChannels !== undefined) dto.audioChannels = asset.audioChannels;
  if (asset.audioSampleRate !== undefined) dto.audioSampleRate = asset.audioSampleRate;
  if (asset.sizeBytes !== undefined) dto.sizeBytes = asset.sizeBytes;
  if (asset.suggestedRole !== undefined) dto.suggestedRole = asset.suggestedRole;
  const slot = speakerSlotOfRole(asset.role);
  if (slot !== undefined) dto.speakerSlot = slot;
  return dto;
}

function assetsOf(project: ProjectLike): StoredAsset[] {
  return Array.isArray(project.assets) ? (project.assets as unknown as StoredAsset[]) : [];
}

function disabledOf(project: ProjectLike): StoredAsset[] {
  const value = (project as { disabledAssets?: unknown }).disabledAssets;
  return Array.isArray(value) ? (value as StoredAsset[]) : [];
}

// ─── 解析前チェック ────────────────────────────────────

/**
 * 解析を始めてよいかを調べる。
 * ★error は開始不可、warning は人が確認して続行できる。
 */
export function checkSetup(
  project: ProjectLike,
  projectDir: string,
  deps: AssetDeps,
): SetupIssue[] {
  const issues: SetupIssue[] = [];
  const assets = assetsOf(project);
  const speakers = Array.isArray(project.speakers) ? project.speakers : [];

  // ① 素材が1つも無い
  if (assets.length === 0) {
    issues.push({
      severity: 'error',
      code: 'NO_ASSETS',
      message: '素材が登録されていません。',
      suggestedAction: '収録した映像・音声を登録してください。',
    });
  }

  // ② 基準映像
  if (assets.length > 0 && !assets.some((a) => a.role === 'wide')) {
    issues.push({
      severity: 'error',
      code: 'NO_WIDE',
      message: '基準になる映像（引き）がありません。',
      suggestedAction: 'いずれかの映像素材の役割を「引き（基準映像）」にしてください。',
    });
  }

  // ③ 音声
  if (assets.length > 0 && !assets.some((a) => a.hasAudio)) {
    issues.push({
      severity: 'error',
      code: 'NO_AUDIO',
      message: '音声が入っている素材がありません。',
      suggestedAction: 'マイク音声か、音声付きの映像を登録してください。',
    });
  }

  // ④ 役割が未確定のまま（★誤推測のまま解析に使わせない）
  for (const asset of assets) {
    if (asset.roleConfirmed === false) {
      issues.push({
        severity: 'error',
        code: 'ROLE_UNCONFIRMED',
        message: `「${asset.fileName}」の役割が未確定です。`,
        suggestedAction: '自動で推測した役割を確認して確定してください。',
        assetId: asset.id,
      });
    }
  }

  // ⑤ ファイルの実在と読み取り
  for (const asset of assets) {
    if (!deps.fileExists(asset.absolutePath)) {
      issues.push({
        severity: 'error',
        code: 'FILE_MISSING',
        message: `「${asset.fileName}」が見つかりません。`,
        suggestedAction: '素材を移動した場合は登録し直してください。',
        assetId: asset.id,
      });
      continue;
    }
    if (!deps.canRead(asset.absolutePath)) {
      issues.push({
        severity: 'error',
        code: 'FILE_UNREADABLE',
        message: `「${asset.fileName}」を読み取れません。`,
        suggestedAction: 'ファイルの権限を確認してください。',
        assetId: asset.id,
      });
    }
  }

  // ⑥ 同じファイルの重複登録
  const seenPaths = new Map<string, string>();
  for (const asset of assets) {
    const previous = seenPaths.get(asset.absolutePath);
    if (previous !== undefined) {
      issues.push({
        severity: 'error',
        code: 'DUPLICATE_FILE',
        message: `「${asset.fileName}」が二重に登録されています。`,
        suggestedAction: 'どちらか一方を登録から外してください。',
        assetId: asset.id,
      });
    }
    seenPaths.set(asset.absolutePath, asset.id);
  }

  // ⑦ 保存先の書き込み権限
  if (!deps.canWrite(projectDir)) {
    issues.push({
      severity: 'error',
      code: 'NOT_WRITABLE',
      message: 'プロジェクトフォルダに書き込めません。',
      suggestedAction: 'フォルダの権限を確認してください。',
    });
  }

  // ⑧ 空き容量（警告）
  const free = deps.freeBytes(projectDir);
  if (free !== undefined && free < LOW_DISK_WARNING_BYTES) {
    issues.push({
      severity: 'warning',
      code: 'LOW_DISK',
      message: `空き容量が少なくなっています（残り約${(free / 1024 ** 3).toFixed(1)}GB）。`,
      suggestedAction: '解析では音声の抽出・補正でディスクを使います。',
    });
  }

  // ⑨ 出演者とマイク・カメラの対応（警告）
  for (const speaker of speakers) {
    const slot = speaker.id;
    if (!assets.some((a) => a.role === `mic_${slot}`)) {
      issues.push({
        severity: 'warning',
        code: 'NO_MIC_FOR_SPEAKER',
        message: `${speaker.name}（${slot}）のマイク音声が登録されていません。`,
        suggestedAction: '話者判定の精度が落ちます。別録り音声があれば登録してください。',
      });
    }
    if (!assets.some((a) => a.role === `cam_${slot}`)) {
      issues.push({
        severity: 'warning',
        code: 'NO_CAMERA_FOR_SPEAKER',
        message: `${speaker.name}（${slot}）の寄りカメラが登録されていません。`,
        suggestedAction: 'カメラ切替の候補が減ります。',
      });
    }
  }

  // ⑩ 尺・フレームレート（警告）
  const videos = assets.filter((a) => a.hasVideo && a.durationSec > 0);
  if (videos.length > 1) {
    const fpsValues = new Set(
      videos.map((a) => (a.fps !== undefined ? Math.round(a.fps * 100) / 100 : undefined)),
    );
    fpsValues.delete(undefined);
    if (fpsValues.size > 1) {
      issues.push({
        severity: 'warning',
        code: 'FPS_MISMATCH',
        message: `映像のフレームレートが揃っていません（${[...fpsValues].join(' / ')}）。`,
        suggestedAction: 'Premiereでの取り込み時にずれが出ることがあります。',
      });
    }

    const durations = videos.map((a) => a.durationSec);
    const min = Math.min(...durations);
    const max = Math.max(...durations);
    if (max - min > 60) {
      issues.push({
        severity: 'warning',
        code: 'DURATION_MISMATCH',
        message: `映像の尺が大きく違います（最短${Math.round(min)}秒 / 最長${Math.round(max)}秒）。`,
        suggestedAction: '別の収録の素材が混ざっていないか確認してください。',
      });
    }
  }

  // ⑪ 映像も音声も無い素材（警告）
  for (const asset of assets) {
    if (!asset.hasVideo && !asset.hasAudio) {
      issues.push({
        severity: 'warning',
        code: 'NO_STREAM',
        message: `「${asset.fileName}」に映像も音声もありません。`,
        assetId: asset.id,
      });
    }
  }

  // ⑫ 解析済みプロジェクトの素材構成を変えている（警告）
  const analyzed = (project as { analysis?: unknown }).analysis !== undefined;
  if (analyzed) {
    issues.push({
      severity: 'warning',
      code: 'ALREADY_ANALYZED',
      message: 'このプロジェクトは解析済みです。素材を変えると解析結果が作り直されます。',
      suggestedAction:
        '字幕などの人間の修正は保持されますが、位置がずれた修正は「孤立」として報告されます。',
    });
  }

  return issues;
}

// ─── 読み込み ──────────────────────────────────────────

export function buildSetupData(
  projectDir: string,
  deps: AssetDeps,
): SetupLoadResult {
  let project: ProjectLike;
  try {
    project = deps.loadProject(projectDir).project;
  } catch {
    return {
      ok: false,
      error: safeError(
        DESKTOP_ERROR_CODES.INVALID_PROJECT,
        'project.json を読み込めませんでした。',
        { recoverable: true },
      ),
    };
  }

  const assets = assetsOf(project);
  const disabled = disabledOf(project);
  const mainId = mainAudioAssetId(assets);
  const issues = checkSetup(project, projectDir, deps);
  const speakers = Array.isArray(project.speakers) ? project.speakers : [];

  const speakerDtos: SetupSpeakerDto[] = speakers.map((s) => {
    const dto: SetupSpeakerDto = {
      slot: s.id,
      name: s.name,
      role: (s as { role?: string }).role ?? 'guest',
      micRegistered: assets.some((a) => a.role === `mic_${s.id}`),
      cameraRegistered: assets.some((a) => a.role === `cam_${s.id}`),
    };
    if (s.title !== undefined) dto.title = s.title;
    return dto;
  });

  const sync = (project as { sync?: { mode?: string } }).sync;

  const data: SetupData = {
    projectPath: projectDir,
    projectId: project.id,
    name: project.name,
    status: project.status,
    updatedAt: project.updatedAt,
    syncMode: sync?.mode === 'common' ? 'common' : 'preserve',
    speakers: speakerDtos,
    assets: assets.map((a) => toDto(a, true, mainId)),
    disabledAssets: disabled.map((a) => toDto(a, false, undefined)),
    issues,
    canAnalyze: !issues.some((i) => i.severity === 'error'),
    analyzed: (project as { analysis?: unknown }).analysis !== undefined,
  };
  if (project.recordedAt !== undefined) data.recordedAt = project.recordedAt;
  const theme = (project as { theme?: string }).theme;
  if (theme !== undefined) data.programName = theme;

  return { ok: true, data };
}

// ─── 保存 ──────────────────────────────────────────────

/** 保存して読み直す。★保存できたことを確かめてから成功を返す。 */
function persist(
  projectDir: string,
  project: ProjectLike,
  deps: AssetDeps,
  extra: { added?: number; skipped?: string[] } = {},
): SetupSaveResult {
  try {
    deps.saveProject(projectDir, project);
  } catch {
    return {
      ok: false,
      error: safeError(
        DESKTOP_ERROR_CODES.UNKNOWN,
        '素材の登録内容を保存できませんでした。プロジェクトの内容は変更されていません。',
        {
          recoverable: true,
          suggestedAction: '保存先の空き容量と書き込み権限を確認してください。',
        },
      ),
    };
  }

  const reloaded = buildSetupData(projectDir, deps);
  if (!reloaded.ok) return { ok: false, error: reloaded.error };
  return {
    ok: true,
    data: reloaded.data,
    ...(extra.added !== undefined ? { added: extra.added } : {}),
    ...(extra.skipped !== undefined ? { skipped: extra.skipped } : {}),
  };
}

function loadForWrite(
  projectDir: string,
  expectedUpdatedAt: string,
  deps: AssetDeps,
): { ok: true; project: ProjectLike } | { ok: false; result: SetupSaveResult } {
  let project: ProjectLike;
  try {
    project = deps.loadProject(projectDir).project;
  } catch {
    return {
      ok: false,
      result: {
        ok: false,
        error: safeError(
          DESKTOP_ERROR_CODES.INVALID_PROJECT,
          'project.json を読み込めませんでした。',
          { recoverable: true },
        ),
      },
    };
  }

  // ★競合更新。読み込み後に別処理が更新していたら上書きしない。
  if (project.updatedAt !== expectedUpdatedAt) {
    return { ok: false, result: { ok: false, conflict: true, error: conflictError() } };
  }

  return { ok: true, project };
}

/** 素材IDを作る。ファイル名から作り、衝突したら連番を付ける。 */
export function makeAssetId(fileName: string, taken: ReadonlySet<string>): string {
  const base =
    fileName
      .replace(/\.[^.]+$/, '')
      .replace(/[^A-Za-z0-9_-]/g, '')
      .slice(0, 40) || 'asset';
  if (!taken.has(base)) return base;
  for (let n = 2; n <= 999; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

/**
 * 素材を登録する。
 * ★absolutePaths は Main が解決したパスだけ（Rendererからは受け取らない）。
 */
export function registerAssets(
  projectDir: string,
  expectedUpdatedAt: string,
  absolutePaths: readonly string[],
  deps: AssetDeps,
): SetupSaveResult {
  const loaded = loadForWrite(projectDir, expectedUpdatedAt, deps);
  if (!loaded.ok) return loaded.result;
  const project = loaded.project;

  const assets = [...assetsOf(project)];
  const disabled = disabledOf(project);
  const knownPaths = new Set([...assets, ...disabled].map((a) => a.absolutePath));
  const takenIds = new Set([...assets, ...disabled].map((a) => a.id));

  const skipped: string[] = [];
  let added = 0;

  for (const path of absolutePaths) {
    const fileName = basename(path);

    if (knownPaths.has(path)) {
      skipped.push(`${fileName}（すでに登録されています）`);
      continue;
    }
    if (!deps.fileExists(path)) {
      skipped.push(`${fileName}（ファイルが見つかりません）`);
      continue;
    }
    if (!deps.canRead(path)) {
      skipped.push(`${fileName}（読み取れません）`);
      continue;
    }

    let probe: MediaProbe;
    try {
      probe = deps.probe(path);
    } catch {
      // ★映像・音声として読めないものは登録しない。
      skipped.push(`${fileName}（映像・音声として読み取れません）`);
      continue;
    }

    const stat = deps.statFile(path);
    const suggested = suggestRole(fileName, probe);
    const id = makeAssetId(fileName, takenIds);
    takenIds.add(id);
    knownPaths.add(path);

    const asset: StoredAsset = {
      id,
      role: suggested,
      absolutePath: path,
      fileName,
      durationSec: probe.durationSec,
      hasVideo: probe.hasVideo,
      hasAudio: probe.hasAudio,
      // ★推測のままでは解析に使わせない。
      roleConfirmed: false,
      suggestedRole: suggested,
    };
    if (probe.width !== undefined) asset.width = probe.width;
    if (probe.height !== undefined) asset.height = probe.height;
    if (probe.fps !== undefined) asset.fps = probe.fps;
    if (probe.audioChannels !== undefined) asset.audioChannels = probe.audioChannels;
    if (probe.audioSampleRate !== undefined) asset.audioSampleRate = probe.audioSampleRate;
    if (stat !== undefined) {
      asset.sizeBytes = stat.sizeBytes;
      asset.mtimeMs = stat.mtimeMs;
    }

    assets.push(asset);
    added += 1;
  }

  if (added === 0) {
    // 何も増えなかったら保存しない（updatedAt を無駄に動かさない）。
    const current = buildSetupData(projectDir, deps);
    if (!current.ok) return { ok: false, error: current.error };
    return { ok: true, data: current.data, added: 0, skipped };
  }

  // ★analysis / edits には触れない。assets だけを差し替える。
  const next: ProjectLike = { ...project, assets: assets as never };
  return persist(projectDir, next, deps, { added, skipped });
}

/** 素材の役割・有効無効を変える。 */
export function updateAsset(
  request: {
    projectPath: string;
    expectedUpdatedAt: string;
    assetId: string;
    patch: { role?: AssetRoleId; enabled?: boolean; roleConfirmed?: boolean };
  },
  deps: AssetDeps,
): SetupSaveResult {
  const loaded = loadForWrite(request.projectPath, request.expectedUpdatedAt, deps);
  if (!loaded.ok) return loaded.result;
  const project = loaded.project;

  let assets = [...assetsOf(project)];
  let disabled = [...disabledOf(project)];

  const inAssets = assets.findIndex((a) => a.id === request.assetId);
  const inDisabled = disabled.findIndex((a) => a.id === request.assetId);

  if (inAssets === -1 && inDisabled === -1) {
    return {
      ok: false,
      error: safeError(
        DESKTOP_ERROR_CODES.ASSET_NOT_FOUND,
        '対象の素材が見つかりませんでした。',
        { recoverable: true, suggestedAction: '再読み込みしてください。' },
      ),
    };
  }

  const currentlyEnabled = inAssets !== -1;
  const asset = currentlyEnabled ? assets[inAssets]! : disabled[inDisabled]!;
  const updated: StoredAsset = { ...asset };

  if (request.patch.role !== undefined) {
    updated.role = request.patch.role;
    // ★人が役割を選んだ＝確定とみなす。
    // 自動推測のまま解析へ進ませないための印なので、
    // 「人が選んだ」ことが分かるこの場所で立てる。
    updated.roleConfirmed = true;
  }
  // 明示指定があればそちらを優先する（確定を取り消したい場合）。
  if (request.patch.roleConfirmed !== undefined) {
    updated.roleConfirmed = request.patch.roleConfirmed;
  }

  const nextEnabled = request.patch.enabled ?? currentlyEnabled;

  // 現在の場所から外し、行き先へ入れ直す。
  if (currentlyEnabled) assets.splice(inAssets, 1);
  else disabled.splice(inDisabled, 1);

  if (nextEnabled) assets = [...assets, updated];
  else disabled = [...disabled, updated];

  const next: ProjectLike = {
    ...project,
    assets: assets as never,
    disabledAssets: disabled as never,
  };
  return persist(request.projectPath, next, deps);
}

/** 登録から外す。★元のファイルは削除しない。 */
export function removeAsset(
  request: { projectPath: string; expectedUpdatedAt: string; assetId: string },
  deps: AssetDeps,
): SetupSaveResult {
  const loaded = loadForWrite(request.projectPath, request.expectedUpdatedAt, deps);
  if (!loaded.ok) return loaded.result;
  const project = loaded.project;

  const assets = assetsOf(project);
  const disabled = disabledOf(project);
  const exists =
    assets.some((a) => a.id === request.assetId) ||
    disabled.some((a) => a.id === request.assetId);

  if (!exists) {
    return {
      ok: false,
      error: safeError(
        DESKTOP_ERROR_CODES.ASSET_NOT_FOUND,
        '対象の素材が見つかりませんでした。',
        { recoverable: true },
      ),
    };
  }

  const next: ProjectLike = {
    ...project,
    assets: assets.filter((a) => a.id !== request.assetId) as never,
    disabledAssets: disabled.filter((a) => a.id !== request.assetId) as never,
  };
  return persist(request.projectPath, next, deps);
}
