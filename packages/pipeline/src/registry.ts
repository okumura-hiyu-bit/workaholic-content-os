/**
 * 工程の依存関係グラフと実行計画の計算。
 *
 * @see docs/14-pipeline.md（依存関係の一覧と、設計上の意図的な逸脱）
 */

import { PipelineErrors } from './errors.ts';
import type {
  PipelineStepId,
  ResolvedPipelineConfig,
} from './types.ts';
import { PIPELINE_STEP_IDS } from './types.ts';

/**
 * 依存関係。
 *
 * ★ご提示の例（字幕は文字起こしに依存／カメラ切替は同期と話者判定に依存／
 * XMLは同期・字幕・マーカー・カメラ切替案に依存）をそのまま採用しつつ、
 * 実装上必要な依存を2点追加している：
 *
 * 1. `generate-premiere-xml` は `correct-audio` にも依存する。
 *    非破壊の補正音トラック（ミュート・別ファイル）をXMLに含めるため、
 *    補正音の実体が先に存在している必要がある。
 * 2. `generate-premiere-xml` は `generate-subtitles` の代わりに
 *    字幕SRTそのものではなく「編集者の修正が字幕に入っていたら書き出しだけ
 *    やり直せる」ようにするため、字幕はXML本体には埋め込まれない
 *    （SRTは別ファイル、save-artifacts工程が書き出す）。それでも
 *    ご指定どおり依存関係としては保持し、字幕が未生成のままXMLだけ
 *    先に作ることを防いでいる。
 *
 * また `syncMode` はオフセット算出（sync-media）ではなく
 * XML組み立て（generate-premiere-xml）の設定として扱う。
 * オフセット自体はモードに関係なく同じ値になるため、syncMode変更だけでは
 * sync-media を再実行する必要がない（「⑨syncMode変更による無効化範囲」参照）。
 */
export const STEP_DEPENDENCIES: Record<PipelineStepId, readonly PipelineStepId[]> = {
  'validate-project': [],
  'probe-media': ['validate-project'],
  'extract-audio': ['probe-media'],
  'sync-media': ['extract-audio'],
  'correct-audio': ['extract-audio'],
  transcribe: ['extract-audio'],
  'detect-speakers': ['sync-media'],
  'generate-subtitles': ['transcribe', 'detect-speakers'],
  'generate-chapters': ['transcribe', 'detect-speakers'],
  'generate-camera-plan': ['sync-media', 'detect-speakers'],
  // ★correct-audio への依存は「マーカーが要る」以上に、AnalysisLayer.checks
  // の所有権を明確にするためのもの。checks は correct-audio と
  // generate-markers の両方が書き足すため、generate-markers は必ず
  // correct-audio の後に走り、その出力（checks）を読んでから自分の分を
  // 足し込む（オーケストレーターは配列を自動マージしない。詳細は
  // run-pipeline.ts のマージ方針コメントを参照）。
  'generate-markers': ['detect-speakers', 'transcribe', 'generate-chapters', 'correct-audio'],
  'extract-short-candidates': ['transcribe', 'detect-speakers', 'generate-chapters'],
  'generate-premiere-xml': [
    'sync-media',
    'correct-audio',
    'generate-subtitles',
    'generate-markers',
    'generate-camera-plan',
  ],
  'save-artifacts': [
    'generate-premiere-xml',
    'generate-subtitles',
    'generate-chapters',
    'extract-short-candidates',
  ],
  'save-project': ['save-artifacts'],
};

/**
 * 工程ごとに「設定のどの部分が結果に影響するか」を返す。
 * ここで選ばれた値だけが configHash に入るため、無関係な設定変更で
 * 無駄にキャッシュが無効化されることを防ぐ。
 */
export function stepConfigSlice(
  stepId: PipelineStepId,
  config: ResolvedPipelineConfig,
): unknown {
  switch (stepId) {
    case 'transcribe':
      return config.transcribe;
    case 'correct-audio':
      return config.correctAudio;
    case 'extract-short-candidates':
      return config.shortCandidates;
    case 'generate-premiere-xml':
      // ★syncMode はここでのみ効く。
      return { syncMode: config.syncMode };
    default:
      return null;
  }
}

/** 依存関係が循環していないか、全ステップの依存が既知IDかを確認する。 */
export function assertValidGraph(): void {
  for (const id of PIPELINE_STEP_IDS) {
    for (const dep of STEP_DEPENDENCIES[id]) {
      if (!PIPELINE_STEP_IDS.includes(dep)) {
        throw new Error(`未知の依存ID: ${id} -> ${dep}`);
      }
    }
  }

  const visited = new Set<PipelineStepId>();
  const inStack = new Set<PipelineStepId>();

  const visit = (id: PipelineStepId): void => {
    if (visited.has(id)) return;
    if (inStack.has(id)) throw new Error(`依存関係が循環しています: ${id}`);
    inStack.add(id);
    for (const dep of STEP_DEPENDENCIES[id]) visit(dep);
    inStack.delete(id);
    visited.add(id);
  };

  for (const id of PIPELINE_STEP_IDS) visit(id);
}

/** トポロジカル順（依存が先に来る順）で全ステップIDを返す。 */
export function topologicalOrder(): PipelineStepId[] {
  const order: PipelineStepId[] = [];
  const visited = new Set<PipelineStepId>();

  const visit = (id: PipelineStepId): void => {
    if (visited.has(id)) return;
    visited.add(id);
    for (const dep of STEP_DEPENDENCIES[id]) visit(dep);
    order.push(id);
  };

  for (const id of PIPELINE_STEP_IDS) visit(id);
  return order;
}

/** id を含み、その依存を再帰的にすべて含む集合を返す（自分自身も含む）。 */
export function collectDependencies(id: PipelineStepId): Set<PipelineStepId> {
  const result = new Set<PipelineStepId>();
  const visit = (current: PipelineStepId): void => {
    if (result.has(current)) return;
    result.add(current);
    for (const dep of STEP_DEPENDENCIES[current]) visit(dep);
  };
  visit(id);
  return result;
}

/** id に依存している（下流の）ステップ集合を返す（自分自身は含まない）。 */
export function collectDependents(id: PipelineStepId): Set<PipelineStepId> {
  const result = new Set<PipelineStepId>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of PIPELINE_STEP_IDS) {
      if (result.has(candidate)) continue;
      const deps = STEP_DEPENDENCIES[candidate];
      if (deps.includes(id) || deps.some((d) => result.has(d))) {
        result.add(candidate);
        changed = true;
      }
    }
  }
  return result;
}

export interface ExecutionPlanInput {
  fromStep?: PipelineStepId;
  toStep?: PipelineStepId;
  onlySteps?: readonly PipelineStepId[];
}

/**
 * 実行計画：今回のリクエストで「対象になりうる」ステップ集合を、
 * トポロジカル順で返す。
 *
 * - `onlySteps` 指定時：それらのステップだけ（依存の自動追加はしない。
 *   依存が未完了ならエラーにする＝「部分実行」の意味を素直に守る）
 * - `fromStep`/`toStep` 指定時：トポロジカル順でその範囲に入るステップ全部
 * - 何も指定しない：全ステップ
 */
export function computeExecutionPlan(
  input: ExecutionPlanInput,
): PipelineStepId[] {
  const order = topologicalOrder();

  if (input.onlySteps && input.onlySteps.length > 0) {
    const set = new Set(input.onlySteps);
    return order.filter((id) => set.has(id));
  }

  const fromIndex = input.fromStep ? order.indexOf(input.fromStep) : 0;
  const toIndex = input.toStep ? order.indexOf(input.toStep) : order.length - 1;

  if (input.fromStep && fromIndex === -1) {
    throw new Error(`未知の fromStep: ${input.fromStep}`);
  }
  if (input.toStep && toIndex === -1) {
    throw new Error(`未知の toStep: ${input.toStep}`);
  }
  if (fromIndex > toIndex) {
    throw new Error('fromStep が toStep より後ろになっています');
  }

  return order.slice(fromIndex, toIndex + 1);
}

/**
 * 計画に含まれないステップで、計画内の最初のステップが依存しているものが
 * 完了済みか検証する。未完了なら PipelineError を投げる。
 */
export function assertDependenciesSatisfied(
  plan: readonly PipelineStepId[],
  isCompleted: (id: PipelineStepId) => boolean,
): void {
  const planSet = new Set(plan);
  for (const id of plan) {
    for (const dep of STEP_DEPENDENCIES[id]) {
      if (planSet.has(dep)) continue; // 計画内で自分より先に実行される
      if (!isCompleted(dep)) {
        throw PipelineErrors.dependencyNotCompleted(id, dep);
      }
    }
  }
}
