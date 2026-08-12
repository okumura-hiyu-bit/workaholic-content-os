/**
 * 復旧画面（Recovery）の組み立てと、付け替え・破棄。
 *
 * ★electron を import しない。fs も直接触らない（すべて注入）。
 *
 * ★既存4画面のMainを1行も変更しない。
 * ここは `buildReviewData` / `buildShortsData` / `buildCameraData` /
 * `buildMarkerData` を**読むだけ**で、警告の判定ロジックを写し取らない。
 * 写すと、各画面の判定が変わったときにこちらだけ古いまま残る
 * （Step 8 で `timeFromId` を写さず本体を使ったのと同じ理由）。
 *
 * ★中核となる実測（2026-08-09 / Step 10 の設計時）
 * `packages/core` の `matchEdits` は**ID完全一致を時刻での再接続より先に**
 * 評価する。よって `edits` のキーを実在IDへ移すだけで、孤立した修正は
 * その要素へ適用される。実測では orphaned=1 → 0 になり、しかも
 * `reattached` にも載らない（＝「元からそのID宛」として扱われる）。
 * 付け替えはこの性質にだけ乗る。packages/ には触れない。
 *
 * ★不変条件：`RecoveryItem.sourceId` は常に `edits` 側のキーである。
 * これは5種すべてで成り立つ（実装・実測で確認）。
 *   orphaned     → `originalId`（＝ edits のキー）
 *   reattached   → `reattached.fromId`。`matchEdits` は edits を書き換えないので、
 *                  繋ぎ直された後も修正は**古いキーのまま**保存されている。
 *   kindMismatch → 同上
 *   rangeChanged → 候補ID（ショートは時刻再接続が無いのでキーと一致）
 *   conflicted   → `detectSubtitleConflicts` が `edits.subtitles` を走査して返すID
 * この不変条件のおかげで「破棄」を4ドメイン×5種で1つの処理に書ける。
 */

// ★IDから時刻を読む判定は本体をそのまま使う（marker.ts と同じ理由）。
//   ここに正規表現を写すと、採番が変わったときにこのファイルだけ古い判定で残る。
import { timeFromId } from '@contentos/core/project';

import type { SafePipelineError } from '../shared/dto.ts';
import { DESKTOP_ERROR_CODES, safeError } from '../shared/errors.ts';
import type {
  RecoveryCounts,
  RecoveryData,
  RecoveryDiscardRequest,
  RecoveryDomain,
  RecoveryItem,
  RecoveryKind,
  RecoveryLoadResult,
  RecoveryReattachRequest,
  RecoverySaveResult,
  RecoveryTarget,
  RecoveryTargetsRequest,
  RecoveryTargetsResult,
} from '../shared/recovery-dto.ts';
import { RECOVERY_DOMAINS, RECOVERY_KINDS } from '../shared/recovery-dto.ts';
import { buildCameraData, cameraEditsOf } from './camera.ts';
import { buildMarkerData, markerEditsOf } from './marker.ts';
import type { CameraData } from '../shared/camera-dto.ts';
import type { MarkerData } from '../shared/marker-dto.ts';
import type { ReviewData } from '../shared/review-dto.ts';
import type { ShortsData } from '../shared/shorts-dto.ts';
import {
  analysisNotReadyError,
  loadForSave,
  loadProjectOrError,
  saveAndRebuild,
  summaryOf,
} from './review-common.ts';
import { buildReviewData, normalizeAnalysis } from './review.ts';
import type { EditsLike, ProjectLike, ReviewDeps } from './review.ts';
import { buildShortsData } from './shorts.ts';

/** 破棄の保存に失敗したときの文言。 */
const SAVE_FAILED_RECOVERY =
  '修復の内容を保存できませんでした。プロジェクトの内容は変更されていません。';

// ─── エラー ────────────────────────────────────────────

function itemNotFound(): SafePipelineError {
  return safeError(
    DESKTOP_ERROR_CODES.UNKNOWN,
    '対象の修正が見つかりませんでした。',
    {
      recoverable: true,
      suggestedAction:
        '一覧が古くなっている可能性があります。画面を読み直してください。',
    },
  );
}

function targetNotFound(): SafePipelineError {
  return safeError(
    DESKTOP_ERROR_CODES.UNKNOWN,
    '付け替え先が見つかりませんでした。',
    {
      recoverable: true,
      suggestedAction:
        '一覧が古くなっている可能性があります。画面を読み直してください。',
    },
  );
}

/**
 * ★付け替え先が既に埋まっている場合。
 *
 * `matchEdits` は1つの要素に2つの修正を付けない。ここを通すと、先にあった
 * 修正が押し出されて新たな孤立を生む。直しに来た操作で壊すことになるので拒否する。
 */
function targetOccupied(): SafePipelineError {
  return safeError(
    DESKTOP_ERROR_CODES.INVALID_REQUEST,
    'その要素には既に別の修正が付いています。',
    {
      recoverable: true,
      suggestedAction:
        '修正が付いていない要素を選ぶか、先にそちらの修正を取り消してください。',
    },
  );
}

/** 付け替えできない種別に付け替えを指示された場合。 */
function notReattachable(): SafePipelineError {
  return safeError(
    DESKTOP_ERROR_CODES.INVALID_REQUEST,
    'この項目は付け替えできません。',
    {
      recoverable: true,
      suggestedAction:
        'この修正は既にどこかの要素へ適用されています。取り消す場合は「修正を破棄」を使ってください。',
    },
  );
}

// ─── 一覧の組み立て ────────────────────────────────────

function keyOf(domain: RecoveryDomain, kind: RecoveryKind, sourceId: string): string {
  return `${domain}:${kind}:${sourceId}`;
}

/** 「内容：〜」の本文。★件数だけでは何を失うのか分からないので必ず中身を出す。 */
function joinBody(parts: (string | undefined)[]): string | undefined {
  const body = parts.filter((p): p is string => p !== undefined && p.length > 0).join(' / ');
  return body.length > 0 ? body : undefined;
}

function subtitleItems(data: ReviewData): RecoveryItem[] {
  const items: RecoveryItem[] = [];

  for (const o of data.orphaned) {
    const item: RecoveryItem = {
      key: keyOf('subtitle', 'orphaned', o.originalId),
      domain: 'subtitle',
      kind: 'orphaned',
      sourceId: o.originalId,
      headline: '字幕の修正が繋がりませんでした',
      reattachable: true,
      detail: o.reason,
    };
    if (o.approxSec !== undefined) item.approxSec = o.approxSec;
    const body = joinBody([
      o.text !== undefined ? `本文「${o.text}」` : undefined,
      o.speakerId !== undefined ? `話者 ${o.speakerId}` : undefined,
    ]);
    if (body !== undefined) item.body = body;
    items.push(item);
  }

  for (const c of data.conflicted) {
    const item: RecoveryItem = {
      key: keyOf('subtitle', 'conflicted', c.subtitleId),
      domain: 'subtitle',
      kind: 'conflicted',
      sourceId: c.subtitleId,
      headline: '修正したあとで解析結果が変わりました',
      body: `修正「${c.humanText}」`,
      detail: `修正時の解析「${c.previousAnalysisText}」／ 現在の解析「${c.currentAnalysisText}」`,
      reattachable: false,
    };
    if (c.approxSec !== undefined) item.approxSec = c.approxSec;
    items.push(item);
  }

  return items;
}

function shortItems(data: ShortsData): RecoveryItem[] {
  const items: RecoveryItem[] = [];

  for (const o of data.orphaned) {
    const adopted =
      o.adopted === true ? '採用' : o.adopted === false ? '不採用' : '未判断';
    const item: RecoveryItem = {
      key: keyOf('short', 'orphaned', o.originalId),
      domain: 'short',
      kind: 'orphaned',
      sourceId: o.originalId,
      headline: 'ショート候補の判断が繋がりませんでした',
      detail: o.reason,
      reattachable: true,
    };
    const body = joinBody([
      `判断 ${adopted}`,
      o.title !== undefined ? `タイトル「${o.title}」` : undefined,
      o.note !== undefined ? `メモ「${o.note}」` : undefined,
    ]);
    if (body !== undefined) item.body = body;
    items.push(item);
  }

  for (const c of data.candidates) {
    if (!c.rangeChanged) continue;
    // ★判断が残っているものだけを出す。
    //   `rangeChanged` は `edits.history` の `candidateRange` から算出される。
    //   履歴は追記のみで消えないため、判断を破棄しても印が残り続ける。
    //   その状態で一覧に出すと「破棄しても消えない項目」になり、
    //   編集者が永久に片付けられない（実機確認で発覚）。
    //   判断が無いなら区間が変わっても失うものが無いので、警告する意味も無い。
    if (!c.edited) continue;
    const item: RecoveryItem = {
      key: keyOf('short', 'rangeChanged', c.id),
      domain: 'short',
      kind: 'rangeChanged',
      sourceId: c.id,
      approxSec: c.startSec,
      headline: '判断したあとで候補の区間が変わりました',
      reattachable: false,
    };
    if (c.decidedRange !== undefined) {
      item.detail =
        `判断した時点：${c.decidedRange.startSec.toFixed(1)}〜${c.decidedRange.endSec.toFixed(1)}秒` +
        `（スコア${c.decidedRange.score}）／ 現在：${c.startSec.toFixed(1)}〜${c.endSec.toFixed(1)}秒（スコア${c.score}）`;
    }
    const body = joinBody([c.title !== undefined ? `タイトル「${c.title}」` : undefined]);
    if (body !== undefined) item.body = body;
    items.push(item);
  }

  return items;
}

function cameraItems(data: CameraData): RecoveryItem[] {
  const items: RecoveryItem[] = [];

  for (const o of data.orphaned) {
    const item: RecoveryItem = {
      key: keyOf('cameraShot', 'orphaned', o.originalId),
      domain: 'cameraShot',
      kind: 'orphaned',
      sourceId: o.originalId,
      headline:
        o.deleted === true
          ? 'カットの削除指定が繋がりませんでした'
          : 'カット切替の修正が繋がりませんでした',
      detail: o.reason,
      reattachable: true,
    };
    if (o.approxSec !== undefined) item.approxSec = o.approxSec;
    const body = joinBody([
      o.cameraId !== undefined ? `カメラ ${o.cameraId}` : undefined,
      o.startSec !== undefined && o.endSec !== undefined
        ? `区間 ${o.startSec.toFixed(1)}〜${o.endSec.toFixed(1)}秒`
        : undefined,
      o.deleted === true ? '削除の指定' : undefined,
    ]);
    if (body !== undefined) item.body = body;
    items.push(item);
  }

  return items;
}

function markerItems(data: MarkerData): RecoveryItem[] {
  const items: RecoveryItem[] = [];

  for (const o of data.orphaned) {
    const item: RecoveryItem = {
      key: keyOf('marker', 'orphaned', o.originalId),
      domain: 'marker',
      kind: 'orphaned',
      sourceId: o.originalId,
      headline: 'マーカーの修正が繋がりませんでした',
      detail: o.reason,
      reattachable: true,
    };
    if (o.approxSec !== undefined) item.approxSec = o.approxSec;
    const body = joinBody([
      o.name !== undefined ? `名前「${o.name}」` : undefined,
      o.comment !== undefined ? `コメント「${o.comment}」` : undefined,
      o.deleted === true ? '削除の指定' : undefined,
    ]);
    if (body !== undefined) item.body = body;
    items.push(item);
  }

  // ★種別またぎ。孤立しないので放置すると気づけない（Step 8 の実測）。
  for (const m of data.markers) {
    const mismatch = m.reattachedKindMismatch;
    if (mismatch === undefined || m.reattached === undefined) continue;
    items.push({
      key: keyOf('marker', 'kindMismatch', m.reattached.fromId),
      domain: 'marker',
      kind: 'kindMismatch',
      sourceId: m.reattached.fromId,
      approxSec: m.startSec,
      headline: `別の種別のマーカーへ繋ぎ直されました（${mismatch.fromKind} → ${mismatch.toKind}）`,
      body: `名前「${m.name}」`,
      detail:
        `${m.reattached.fromId} の修正が ${m.id} へ ${m.reattached.deltaSec.toFixed(3)}秒 ずれて付いています。` +
        '時刻の近さだけで繋ぎ直されるため、種別が違っていても孤立しません。',
      reattachable: false,
    });
  }

  return items;
}

/**
 * 繋ぎ直された修正。
 *
 * ★`resolveProject` の結果から直接作る。カメラ・マーカーは各画面のDTOにも
 * `reattached` があるが、**字幕は従来どこにも出していなかった**
 * （`review.ts` は `ReattachedEditLike` を型宣言しているだけで一度も読んでいない）。
 * 4ドメインを対称に扱うため、ここでは出所を1つに揃える。
 */
function reattachedItems(
  resolveResult: { reattached: { kind: string; fromId: string; toId: string; deltaSec: number }[] },
  suppressed: ReadonlySet<string>,
): RecoveryItem[] {
  const items: RecoveryItem[] = [];

  for (const r of resolveResult.reattached) {
    // ★`chapter` は対応するReview画面が無いので出さない（付け替え先を選ばせられない）。
    if (!RECOVERY_DOMAINS.includes(r.kind as RecoveryDomain)) continue;
    const domain = r.kind as RecoveryDomain;

    // ★種別またぎとして既に出している分は重ねない。
    //   同じ事象を2行に分けても、片方を直せばもう片方も消えるだけで混乱する。
    if (suppressed.has(`${domain}:${r.fromId}`)) continue;

    const entry: RecoveryItem = {
      key: keyOf(domain, 'reattached', r.fromId),
      domain,
      kind: 'reattached',
      sourceId: r.fromId,
      headline: '再解析で別の要素へ繋ぎ直されました',
      detail: `${r.fromId} の修正が ${r.toId} へ ${r.deltaSec.toFixed(3)}秒 ずれて付いています。`,
      reattachable: false,
    };
    // ★時刻を必ず載せる。繋ぎ直しは「IDから時刻が読めた」からこそ起きた事象なので、
    //   ここが undefined になることは実質ない。載せないと一覧が時刻順に並ばず、
    //   その項目だけ再生位置へ飛べなくなる（実機確認で発覚）。
    const approxSec = approxSecOf(domain, r.fromId);
    if (approxSec !== undefined) entry.approxSec = approxSec;
    items.push(entry);
  }

  return items;
}

function emptyCounts(): RecoveryCounts {
  const byDomain = {} as Record<RecoveryDomain, number>;
  for (const d of RECOVERY_DOMAINS) byDomain[d] = 0;
  const byKind = {} as Record<RecoveryKind, number>;
  for (const k of RECOVERY_KINDS) byKind[k] = 0;
  return { total: 0, reattachable: 0, byDomain, byKind };
}

export function countsOf(items: readonly RecoveryItem[]): RecoveryCounts {
  const counts = emptyCounts();
  counts.total = items.length;
  for (const item of items) {
    counts.byDomain[item.domain] += 1;
    counts.byKind[item.kind] += 1;
    if (item.reattachable) counts.reattachable += 1;
  }
  return counts;
}

/** 一覧の並び。★時刻順。時刻が無いもの（ショート・CHECK系）は末尾へ回す。 */
function sortItems(items: RecoveryItem[]): RecoveryItem[] {
  return items.sort((a, b) => {
    if (a.approxSec === undefined && b.approxSec === undefined) {
      return a.key.localeCompare(b.key);
    }
    if (a.approxSec === undefined) return 1;
    if (b.approxSec === undefined) return -1;
    if (a.approxSec !== b.approxSec) return a.approxSec - b.approxSec;
    return a.key.localeCompare(b.key);
  });
}

/**
 * 4画面を横断した「要確認」の一覧を組み立てる。
 *
 * ★各画面の `buildXxxData` を呼ぶ（判定を写さない）。そのぶん project.json を
 * 複数回読むが、判定が1箇所に保たれることを優先する。読み込みは
 * ローカルファイルで、この画面は保存のたびにしか動かない。
 */
export function buildRecoveryData(
  projectDir: string,
  deps: ReviewDeps,
): RecoveryLoadResult {
  const loaded = loadProjectOrError(projectDir, deps);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const project = loaded.value.project;
  const analysis = project.analysis;
  if (analysis === undefined || !Array.isArray(analysis.subtitles)) {
    return { ok: false, error: analysisNotReadyError() };
  }

  const review = buildReviewData(projectDir, deps);
  if (!review.ok) return { ok: false, error: review.error };
  const shorts = buildShortsData(projectDir, deps);
  if (!shorts.ok) return { ok: false, error: shorts.error };
  const camera = buildCameraData(projectDir, deps);
  if (!camera.ok) return { ok: false, error: camera.error };
  const marker = buildMarkerData(projectDir, deps);
  if (!marker.ok) return { ok: false, error: marker.error };

  // ★種別またぎとして出した分は、素の「繋ぎ直し」からは外す。
  const suppressed = new Set<string>();
  for (const m of marker.data.markers) {
    if (m.reattachedKindMismatch !== undefined && m.reattached !== undefined) {
      suppressed.add(`marker:${m.reattached.fromId}`);
    }
  }

  // ★配列が欠けた project.json でも落ちないよう、渡す前に空配列で補う
  //   （`review.ts` が既に持っている補正をそのまま使う。ここで書き直さない）。
  const resolveResult = deps.resolveProject(
    normalizeAnalysis(analysis),
    project.edits,
  );

  const items = sortItems([
    ...subtitleItems(review.data),
    ...shortItems(shorts.data),
    ...cameraItems(camera.data),
    ...markerItems(marker.data),
    ...reattachedItems(resolveResult, suppressed),
  ]);

  const data: RecoveryData = {
    summary: summaryOf(project, projectDir, loaded.value.notes ?? []),
    updatedAt: project.updatedAt,
    items,
    counts: countsOf(items),
  };
  // ★プレビューは字幕Reviewが作ったものを使い回す（4画面と同じ）。
  if (review.data.media !== undefined) data.media = review.data.media;

  return { ok: true, data };
}

// ─── 付け替え先の候補 ──────────────────────────────────

/**
 * カメラの孤立が「削除指定」由来かどうか。
 *
 * ★カメラだけ `edits` の形が2系統ある（`overrides` は Record、
 * `deletedIds` は配列）。埋まっているかの判定先が変わるので先に見分ける。
 */
function isDeletedCameraSource(edits: EditsLike, sourceId: string): boolean {
  return cameraEditsOf(edits).deletedIds.includes(sourceId);
}

function targetsFor(
  domain: RecoveryDomain,
  sourceId: string,
  approxSec: number | undefined,
  project: ProjectLike,
  review: ReviewData,
  shorts: ShortsData,
  camera: CameraData,
  marker: MarkerData,
): RecoveryTarget[] {
  const withDelta = (t: Omit<RecoveryTarget, 'deltaSec'>): RecoveryTarget =>
    approxSec === undefined
      ? t
      : { ...t, deltaSec: Number(Math.abs(t.startSec - approxSec).toFixed(3)) };

  let targets: RecoveryTarget[];

  switch (domain) {
    case 'subtitle': {
      const edits = project.edits.subtitles;
      targets = review.subtitles.map((c) =>
        withDelta({
          id: c.id,
          startSec: c.startSec,
          label: c.text,
          occupied: edits[c.id] !== undefined,
        }),
      );
      break;
    }
    case 'short': {
      const edits = project.edits.shorts;
      targets = shorts.candidates.map((c) =>
        withDelta({
          id: c.id,
          startSec: c.startSec,
          label: `スコア${c.score}／${c.durationSec.toFixed(0)}秒`,
          occupied: edits[c.id] !== undefined,
        }),
      );
      break;
    }
    case 'cameraShot': {
      const cameraEdits = cameraEditsOf(project.edits);
      const deletedSource = isDeletedCameraSource(project.edits, sourceId);
      targets = camera.shots
        // ★人が追加したカットは解析結果に無いので付け替え先にしない
        //   （`matchEdits` は解析側の要素にしか修正を付けない）。
        .filter((s) => !s.inserted)
        .map((s) =>
          withDelta({
            id: s.id,
            startSec: s.startSec,
            label: `${s.cameraLabel}／${s.startSec.toFixed(1)}〜${s.endSec.toFixed(1)}秒`,
            // ★削除指定の付け替えでは、既に削除済みのカットは
            //   `camera.shots`（解決後の並び）に残らないのでそもそも並ばない。
            //   それでも判定を書いておくのは、`shots` の作り方が将来変わっても
            //   二重の削除指定を作らないため。保存側でも同じ判定で拒否する。
            occupied: deletedSource
              ? cameraEdits.deletedIds.includes(s.id)
              : cameraEdits.overrides[s.id] !== undefined,
          }),
        );
      break;
    }
    case 'marker': {
      const edits = markerEditsOf(project.edits);
      targets = marker.markers.map((m) =>
        withDelta({
          id: m.id,
          startSec: m.startSec,
          label: `[${m.kindLabel}] ${m.name}`,
          occupied: edits[m.id] !== undefined,
        }),
      );
      break;
    }
  }

  // ★近い順に出す。自動再接続の許容範囲は0.5秒（実測）で、ここに来るものは
  //   それを超えて離れている。編集者が最初に見るのは「いちばん近い候補」。
  return targets.sort((a, b) => {
    if (a.deltaSec !== undefined && b.deltaSec !== undefined) {
      if (a.deltaSec !== b.deltaSec) return a.deltaSec - b.deltaSec;
    }
    return a.startSec - b.startSec;
  });
}

export function listRecoveryTargets(
  request: RecoveryTargetsRequest,
  deps: ReviewDeps,
): RecoveryTargetsResult {
  const loaded = loadProjectOrError(request.projectPath, deps);
  if (!loaded.ok) return { ok: false, error: loaded.error };

  const project = loaded.value.project;
  if (project.analysis === undefined) {
    return { ok: false, error: analysisNotReadyError() };
  }

  // ★修正が実在するか先に確かめる。一覧が古いまま操作された場合に
  //   「存在しない修正の付け替え先」を並べても意味が無い。
  if (readEdit(project.edits, request.domain, request.sourceId) === undefined) {
    return { ok: false, error: itemNotFound() };
  }

  const review = buildReviewData(request.projectPath, deps);
  if (!review.ok) return { ok: false, error: review.error };
  const shorts = buildShortsData(request.projectPath, deps);
  if (!shorts.ok) return { ok: false, error: shorts.error };
  const camera = buildCameraData(request.projectPath, deps);
  if (!camera.ok) return { ok: false, error: camera.error };
  const marker = buildMarkerData(request.projectPath, deps);
  if (!marker.ok) return { ok: false, error: marker.error };

  const approxSec = approxSecOf(request.domain, request.sourceId);

  return {
    ok: true,
    targets: targetsFor(
      request.domain,
      request.sourceId,
      approxSec,
      project,
      review.data,
      shorts.data,
      camera.data,
      marker.data,
    ),
  };
}

/**
 * IDから読み取れる概算時刻。
 *
 * ★正規表現を写さず `@contentos/core` の `timeFromId` をそのまま使う
 * （marker.ts と同じ理由：写すと本体が変わったときにここだけ古い判定で残る）。
 * ショートのIDは時刻を含まないので必ず undefined になる。
 */
function approxSecOf(domain: RecoveryDomain, sourceId: string): number | undefined {
  if (domain === 'short') return undefined;
  return timeFromId(sourceId);
}

// ─── edits の読み書き ──────────────────────────────────

/**
 * `edits` からその修正を読む。
 * ★カメラの削除指定は Record ではなく配列に入っている。
 */
function readEdit(
  edits: EditsLike,
  domain: RecoveryDomain,
  sourceId: string,
): unknown {
  switch (domain) {
    case 'subtitle':
      return edits.subtitles[sourceId];
    case 'short':
      return edits.shorts[sourceId];
    case 'marker':
      return markerEditsOf(edits)[sourceId];
    case 'cameraShot': {
      const cam = cameraEditsOf(edits);
      if (cam.overrides[sourceId] !== undefined) return cam.overrides[sourceId];
      if (cam.deletedIds.includes(sourceId)) return { deleted: true };
      return undefined;
    }
  }
}

/** `edits` からその修正を消した新しい `edits` を作る。★元は書き換えない。 */
function withEditRemoved(
  edits: EditsLike,
  domain: RecoveryDomain,
  sourceId: string,
): EditsLike {
  switch (domain) {
    case 'subtitle': {
      const next = { ...edits.subtitles };
      delete next[sourceId];
      return { ...edits, subtitles: next };
    }
    case 'short': {
      const next = { ...edits.shorts };
      delete next[sourceId];
      return { ...edits, shorts: next };
    }
    case 'marker': {
      const next = { ...markerEditsOf(edits) };
      delete next[sourceId];
      return { ...edits, markers: next };
    }
    case 'cameraShot': {
      const cam = cameraEditsOf(edits);
      return {
        ...edits,
        cameraShots: {
          overrides: Object.fromEntries(
            Object.entries(cam.overrides).filter(([id]) => id !== sourceId),
          ),
          inserted: [...cam.inserted],
          deletedIds: cam.deletedIds.filter((id) => id !== sourceId),
        },
      };
    }
  }
}

/** `edits` のキーを `sourceId` から `targetId` へ移した新しい `edits` を作る。 */
function withEditMoved(
  edits: EditsLike,
  domain: RecoveryDomain,
  sourceId: string,
  targetId: string,
): EditsLike {
  switch (domain) {
    case 'subtitle': {
      const next = { ...edits.subtitles };
      const value = next[sourceId];
      delete next[sourceId];
      if (value !== undefined) next[targetId] = value;
      return { ...edits, subtitles: next };
    }
    case 'short': {
      const next = { ...edits.shorts };
      const value = next[sourceId];
      delete next[sourceId];
      if (value !== undefined) next[targetId] = value;
      return { ...edits, shorts: next };
    }
    case 'marker': {
      const next = { ...markerEditsOf(edits) };
      const value = next[sourceId];
      delete next[sourceId];
      if (value !== undefined) next[targetId] = value;
      return { ...edits, markers: next };
    }
    case 'cameraShot': {
      const cam = cameraEditsOf(edits);
      const override = cam.overrides[sourceId];
      const nextOverrides = { ...cam.overrides };
      let nextDeleted = [...cam.deletedIds];

      if (override !== undefined) {
        delete nextOverrides[sourceId];
        // ★`CameraShotOverride` は { cameraId?, startSec?, endSec? } だけで
        //   ID を持たない。よってキーを移すだけでよい（中身は書き換えない）。
        nextOverrides[targetId] = { ...override };
      } else {
        nextDeleted = nextDeleted.map((id) => (id === sourceId ? targetId : id));
      }

      return {
        ...edits,
        cameraShots: {
          overrides: nextOverrides,
          inserted: [...cam.inserted],
          deletedIds: nextDeleted,
        },
      };
    }
  }
}

// ─── 保存 ──────────────────────────────────────────────

/**
 * 保存し、読み直して一覧を返す。
 *
 * ★Step 9 の `saveAndRebuild` に乗る。この画面は「1要素」ではなく
 * **一覧全体**を返す（1件直すと他の項目の状態も変わりうるため。
 * 例：付け替えで先客が押し出されれば新しい孤立が生まれる）。
 */
function persistAndReload(
  projectDir: string,
  nextProject: ProjectLike,
  deps: ReviewDeps,
): RecoverySaveResult {
  const reloaded = saveAndRebuild(
    projectDir,
    nextProject,
    deps,
    SAVE_FAILED_RECOVERY,
    buildRecoveryData,
  );
  if (!reloaded.ok) return { ok: false, error: reloaded.error };

  return {
    ok: true,
    updatedAt: reloaded.data.updatedAt,
    items: reloaded.data.items,
    counts: reloaded.data.counts,
  };
}

/**
 * 孤立した修正を、実在する要素へ付け替える。
 *
 * ★やることは `edits` のキーの移動だけ。`analysis` は一切触らない。
 */
export function reattachRecoveryEdit(
  request: RecoveryReattachRequest,
  deps: ReviewDeps,
): RecoverySaveResult {
  const loaded = loadForSave(request.projectPath, request.expectedUpdatedAt, deps);
  if (!loaded.ok) {
    return loaded.conflict === true
      ? { ok: false, conflict: true, error: loaded.error }
      : { ok: false, error: loaded.error };
  }
  const { project, analysis } = loaded;

  const existing = readEdit(project.edits, request.domain, request.sourceId);
  if (existing === undefined) return { ok: false, error: itemNotFound() };

  // ★孤立しているものだけ付け替えられる。既にどこかへ適用されている修正を
  //   動かすと、人が見ている画面の内容と食い違う。
  if (existsInAnalysis(analysis, request.domain, request.sourceId)) {
    return { ok: false, error: notReattachable() };
  }

  if (!existsInAnalysis(analysis, request.domain, request.targetId)) {
    return { ok: false, error: targetNotFound() };
  }

  // ★付け替え先が埋まっていないか。埋まったまま進めると先客が押し出される。
  if (isOccupied(project.edits, request.domain, request.sourceId, request.targetId)) {
    return { ok: false, error: targetOccupied() };
  }

  const moved = withEditMoved(
    project.edits,
    request.domain,
    request.sourceId,
    request.targetId,
  );

  // ★履歴は必ず残す。どのIDからどのIDへ移したかを後から追えるようにする。
  const history = deps.recordEdit(moved, {
    kind: request.domain,
    targetId: request.targetId,
    field: 'reattachedFrom',
    before: request.sourceId,
    after: request.targetId,
  });

  return persistAndReload(request.projectPath, { ...project, edits: history }, deps);
}

/** 修正を破棄する（＝解析結果の値に戻す）。★4ドメイン・5種すべて同じ処理。 */
export function discardRecoveryEdit(
  request: RecoveryDiscardRequest,
  deps: ReviewDeps,
): RecoverySaveResult {
  const loaded = loadForSave(request.projectPath, request.expectedUpdatedAt, deps);
  if (!loaded.ok) {
    return loaded.conflict === true
      ? { ok: false, conflict: true, error: loaded.error }
      : { ok: false, error: loaded.error };
  }
  const { project } = loaded;

  const existing = readEdit(project.edits, request.domain, request.sourceId);
  if (existing === undefined) return { ok: false, error: itemNotFound() };

  const removed = withEditRemoved(project.edits, request.domain, request.sourceId);

  const history = deps.recordEdit(removed, {
    kind: request.domain,
    targetId: request.sourceId,
    field: 'removed',
    before: existing,
    after: null,
  });

  return persistAndReload(request.projectPath, { ...project, edits: history }, deps);
}

// ─── 解析側の存在確認 ──────────────────────────────────

function existsInAnalysis(
  analysis: NonNullable<ProjectLike['analysis']>,
  domain: RecoveryDomain,
  id: string,
): boolean {
  switch (domain) {
    case 'subtitle':
      return analysis.subtitles.some((s) => s.id === id);
    case 'short':
      return (analysis.shortCandidates ?? []).some((s) => s.id === id);
    case 'cameraShot':
      return (analysis.cameraShots ?? []).some((s) => s.id === id);
    case 'marker':
      return (analysis.markers ?? []).some((m) => m.id === id);
  }
}

function isOccupied(
  edits: EditsLike,
  domain: RecoveryDomain,
  sourceId: string,
  targetId: string,
): boolean {
  if (domain === 'cameraShot') {
    const cam = cameraEditsOf(edits);
    // ★削除指定の付け替えは deletedIds の中だけを見る。
    //   overrides が付いているカットを削除指定に加えるのは正当な操作。
    return isDeletedCameraSource(edits, sourceId)
      ? cam.deletedIds.includes(targetId)
      : cam.overrides[targetId] !== undefined;
  }
  return readEdit(edits, domain, targetId) !== undefined;
}
