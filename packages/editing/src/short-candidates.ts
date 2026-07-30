/**
 * ショート候補の一次抽出（ローカル処理・APIを使わない）。
 *
 * ★区間の選定はここで決定的に行い、APIには「候補の評価」だけを任せる。
 * 最初からAIに候補を探させない理由:
 *   1. 文字起こし全文をAPIに送ることになり、コストと情報漏れの両面で不利
 *   2. 同じ素材で毎回違う候補が出ると、編集者が基準を信頼できない
 *   3. 尺・文の完結性・話者交代のような機械的な条件は、そもそもAIが不要
 *
 * ★文の途中で切らない。句点と発話区間の切れ目を境界に使う。
 * ★無音を根拠に「削るべき区間」を出すことはしない。沈黙率は
 *   「候補として成立するか」の判断にのみ使う。
 *
 * @see docs/11-editing-pipeline.md 11.3⑦
 */

import type {
  EmphasisPoint,
  LaughterSegment,
  ShortCandidate,
  SpeechSegment,
  TopicSegment,
  Word,
} from './types.ts';

export interface ShortCandidateSource {
  durationSec: number;
  /** 文字起こし。空でも動くが、境界とフックの精度が落ちる。 */
  words: readonly Word[];
  speech: readonly SpeechSegment[];
  backchannels?: readonly SpeechSegment[];
  overlaps?: readonly { startSec: number; endSec: number; speakerIds: string[] }[];
  laughter: readonly LaughterSegment[];
  emphasis: readonly EmphasisPoint[];
  topics: readonly TopicSegment[];
  /** 音量エンベロープ（任意）。音量変化・感情変化の判定に使う。 */
  energy?: { frameRate: number; values: Float32Array | readonly number[] };
  /** 拾いたいキーワード（briefのテーマ・重要語）。 */
  keywords?: readonly string[];
}

export interface ShortRules {
  minSec: number;
  /**
   * ★90秒はInstagramリールの要件（超えるとリールタブに載らない）。
   * ここを緩めてはならない。
   */
  maxSec: number;
  targetSec: number;
  /** APIに渡す候補数。10〜20本を想定。 */
  maxCandidates: number;
  minGapSec: number;
  leadInSec: number;
  tailSec: number;
  /** 沈黙率がこれを超える候補は落とす（間が多すぎて成立しない）。 */
  maxSilenceRatio: number;
}

export const DEFAULT_SHORT_RULES: ShortRules = {
  minSec: 15,
  maxSec: 90,
  targetSec: 45,
  maxCandidates: 16,
  minGapSec: 5,
  leadInSec: 6,
  tailSec: 3,
  maxSilenceRatio: 0.5,
};

/** 加点・減点の内訳。GUIとAPIの両方が読む。 */
export interface ShortSignal {
  key: string;
  label: string;
  points: number;
}

export interface ScoredShortCandidate extends ShortCandidate {
  score: number;
  signals: string[];
  /** 内訳。確認画面で「なぜこの順位か」を示す。 */
  breakdown: ShortSignal[];
  /** APIに送る抜粋（この区間の文字起こしのみ）。 */
  transcriptExcerpt: string;
  metrics: {
    lengthSec: number;
    /** 発話密度（発話時間 ÷ 尺）。 */
    speechRatio: number;
    silenceRatio: number;
    speakerChanges: number;
    laughterSec: number;
    overlapSec: number;
    emphasisCount: number;
    keywordHits: string[];
    /** 音量変化の大きさ（energy が渡された場合のみ）。 */
    energyVariation?: number;
    endsAtSentence: boolean;
    /** 冒頭が文脈依存の語で始まっていないか。 */
    selfContained: boolean;
    hasOpeningHook: boolean;
  };
}

const SENTENCE_END = /[。！？!?]$/;

/** 冒頭にあると前後の文脈が必要になる語。 */
const CONTEXT_DEPENDENT_HEAD = [
  'それ', 'その', 'これ', 'この', 'あれ', 'あの',
  'さっき', '先ほど', '今の', 'そう', 'で、', 'でも', 'だから',
  'つまり', 'なので', 'ということで',
];

/** 冒頭にあるとフックになりやすい形。 */
const HOOK_PATTERNS = [
  /[?？]/,
  /ですか$/,
  /^実は/,
  /^結論/,
  /^一番/,
  /^絶対/,
  /^多くの/,
  /^ほとんど/,
  /ません/,
  /^\d/,
];

/** 区間を切ってよい時刻の一覧。文の途中で切らないための土台。 */
export function collectBoundaries(source: ShortCandidateSource): number[] {
  const boundaries = new Set<number>([0, source.durationSec]);

  for (const word of source.words) {
    if (SENTENCE_END.test(word.text)) boundaries.add(word.endSec);
  }
  for (const segment of source.speech) {
    boundaries.add(segment.startSec);
    boundaries.add(segment.endSec);
  }
  for (const topic of source.topics) {
    boundaries.add(topic.startSec);
  }

  return [...boundaries]
    .filter((t) => t >= 0 && t <= source.durationSec)
    .sort((a, b) => a - b);
}

function boundaryAtOrBefore(boundaries: readonly number[], target: number): number {
  let best = boundaries[0] ?? target;
  for (const b of boundaries) {
    if (b <= target) best = b;
    else break;
  }
  return best;
}

function boundaryAtOrAfter(boundaries: readonly number[], target: number): number {
  for (const b of boundaries) {
    if (b >= target) return b;
  }
  return target;
}

interface Range {
  startSec: number;
  endSec: number;
}

function overlapSec(a: Range, b: Range): number {
  return Math.max(0, Math.min(a.endSec, b.endSec) - Math.max(a.startSec, b.startSec));
}

/** 区間内の文字起こしを連結する。 */
export function textInRange(words: readonly Word[], range: Range): string {
  return words
    .filter((w) => w.startSec >= range.startSec && w.endSec <= range.endSec)
    .map((w) => w.text)
    .join('');
}

function dominantSpeaker(
  range: Range,
  speech: readonly SpeechSegment[],
): string | undefined {
  const totals = new Map<string, number>();
  for (const segment of speech) {
    const seconds = overlapSec(range, segment);
    if (seconds > 0) {
      totals.set(segment.speakerId, (totals.get(segment.speakerId) ?? 0) + seconds);
    }
  }
  let best: string | undefined;
  let bestSeconds = 0;
  for (const [speakerId, seconds] of totals) {
    if (seconds > bestSeconds) {
      bestSeconds = seconds;
      best = speakerId;
    }
  }
  return best;
}

/** 区間内での話者の切り替わり回数。会話のやりとりの density を示す。 */
function countSpeakerChanges(range: Range, speech: readonly SpeechSegment[]): number {
  const inRange = speech
    .filter((s) => overlapSec(range, s) > 0.2)
    .sort((a, b) => a.startSec - b.startSec);

  let changes = 0;
  for (let i = 1; i < inRange.length; i++) {
    if (inRange[i]!.speakerId !== inRange[i - 1]!.speakerId) changes += 1;
  }
  return changes;
}

/** 音量変化の大きさ（変動係数）。感情の起伏の代理指標。 */
function energyVariation(
  range: Range,
  energy: ShortCandidateSource['energy'],
): number | undefined {
  if (!energy) return undefined;
  const values = energy.values;
  const from = Math.max(0, Math.round(range.startSec * energy.frameRate));
  const to = Math.min(values.length, Math.round(range.endSec * energy.frameRate));
  if (to - from < 4) return undefined;

  let sum = 0;
  for (let i = from; i < to; i++) sum += values[i]!;
  const mean = sum / (to - from);
  if (mean <= 0) return undefined;

  let variance = 0;
  for (let i = from; i < to; i++) {
    const d = values[i]! - mean;
    variance += d * d;
  }
  return Number((Math.sqrt(variance / (to - from)) / mean).toFixed(3));
}

interface Seed extends Range {
  kind: 'emphasis' | 'laughter';
  speakerId?: string;
}

function collectSeeds(source: ShortCandidateSource): Seed[] {
  const seeds: Seed[] = [];
  for (const point of source.emphasis) {
    seeds.push({
      startSec: point.startSec,
      endSec: point.endSec,
      kind: 'emphasis',
      speakerId: point.speakerId,
    });
  }
  for (const laugh of source.laughter) {
    seeds.push({
      startSec: laugh.startSec,
      endSec: laugh.endSec,
      kind: 'laughter',
      speakerId: laugh.speakerIds?.[0],
    });
  }
  return seeds.sort((a, b) => a.startSec - b.startSec);
}

interface Window extends Range {
  seed: Seed;
  score: number;
  breakdown: ShortSignal[];
  metrics: ScoredShortCandidate['metrics'];
  excerpt: string;
}

function buildWindow(
  seed: Seed,
  boundaries: readonly number[],
  source: ShortCandidateSource,
  rules: ShortRules,
): Window | undefined {
  const desiredStart = Math.max(0, seed.startSec - rules.leadInSec);
  const desiredEnd = Math.min(source.durationSec, seed.endSec + rules.tailSec);

  let startSec = boundaryAtOrBefore(boundaries, desiredStart);
  let endSec = boundaryAtOrAfter(boundaries, desiredEnd);

  // 尺が足りなければ後ろに伸ばす（核は冒頭寄りが望ましい）。
  if (endSec - startSec < rules.minSec) {
    endSec = boundaryAtOrAfter(boundaries, startSec + rules.minSec);
  }
  if (endSec - startSec < rules.minSec) {
    startSec = boundaryAtOrBefore(boundaries, endSec - rules.minSec);
  }
  // ★上限は絶対に超えない。
  if (endSec - startSec > rules.maxSec) {
    endSec = boundaryAtOrBefore(boundaries, startSec + rules.maxSec);
    if (endSec - startSec > rules.maxSec) endSec = startSec + rules.maxSec;
  }

  const lengthSec = endSec - startSec;
  if (lengthSec < rules.minSec) return undefined;

  const range: Range = { startSec, endSec };
  const excerpt = textInRange(source.words, range);

  // ─── 指標の算出 ───────────────────────────────────────
  const speechSec = source.speech.reduce((sum, s) => sum + overlapSec(range, s), 0);
  const speechRatio = Number(Math.min(1, speechSec / lengthSec).toFixed(3));
  const silenceRatio = Number((1 - speechRatio).toFixed(3));
  const laughterSec = Number(
    source.laughter.reduce((sum, l) => sum + overlapSec(range, l), 0).toFixed(2),
  );
  const overlapSecTotal = Number(
    (source.overlaps ?? [])
      .reduce((sum, o) => sum + overlapSec(range, o), 0)
      .toFixed(2),
  );
  const emphasisCount = source.emphasis.filter((e) => overlapSec(range, e) > 0).length;
  const keywordHits = (source.keywords ?? []).filter((k) => k && excerpt.includes(k));
  const speakerChanges = countSpeakerChanges(range, source.speech);

  const endsAtSentence = source.words.some(
    (w) => Math.abs(w.endSec - endSec) < 0.05 && SENTENCE_END.test(w.text),
  );

  const head = excerpt.slice(0, 12);
  const selfContained =
    head.length === 0 ||
    !CONTEXT_DEPENDENT_HEAD.some((term) => head.startsWith(term));
  const hasOpeningHook = HOOK_PATTERNS.some((pattern) =>
    pattern.test(excerpt.slice(0, 40)),
  );

  const metrics: ScoredShortCandidate['metrics'] = {
    lengthSec: Number(lengthSec.toFixed(2)),
    speechRatio,
    silenceRatio,
    speakerChanges,
    laughterSec,
    overlapSec: overlapSecTotal,
    emphasisCount,
    keywordHits,
    energyVariation: energyVariation(range, source.energy),
    endsAtSentence,
    selfContained,
    hasOpeningHook,
  };

  // ★沈黙が多すぎる区間は候補にしない。ただし「沈黙を削る」提案はしない。
  if (silenceRatio > rules.maxSilenceRatio) return undefined;

  // ─── 採点 ─────────────────────────────────────────────
  const breakdown: ShortSignal[] = [];
  const add = (key: string, label: string, points: number) => {
    if (points !== 0) breakdown.push({ key, label, points });
  };

  add(
    seed.kind,
    seed.kind === 'emphasis' ? '印象的な発言を含む' : '笑いが起きている',
    seed.kind === 'emphasis' ? 40 : 25,
  );

  if (laughterSec > 0 && seed.kind !== 'laughter') {
    add('laughter_bonus', `笑いを${laughterSec}秒含む`, 15);
  }
  if (emphasisCount > 1) {
    add('emphasis_multi', `強調ポイントが${emphasisCount}箇所`, 10);
  }
  if (keywordHits.length > 0) {
    add('keywords', `キーワード: ${keywordHits.join('・')}`, Math.min(15, keywordHits.length * 5));
  }
  if (speakerChanges >= 2) {
    add('dialogue', `やりとりが${speakerChanges}回`, 8);
  } else if (speakerChanges === 0) {
    add('monologue', '1人が話し切っている', 5);
  }
  if (overlapSecTotal > 0.5) {
    add('overlap', '同時発話があり熱量が高い', 5);
  }
  if (speechRatio >= 0.8) {
    add('density', `発話密度が高い（${Math.round(speechRatio * 100)}%）`, 10);
  }
  if (metrics.energyVariation !== undefined && metrics.energyVariation >= 0.45) {
    add('energy', '音量の起伏が大きい', 8);
  }

  const lengthPenalty = Math.abs(lengthSec - rules.targetSec) / rules.targetSec;
  add(
    'length',
    `尺${Math.round(lengthSec)}秒`,
    Math.round(Math.max(0, 20 * (1 - lengthPenalty))),
  );

  if (endsAtSentence) add('sentence_end', '文の終わりで終わっている', 10);
  if (hasOpeningHook) add('hook', '冒頭にフックがある', 12);
  if (!selfContained) {
    add('context', `冒頭が文脈依存（「${head.slice(0, 6)}…」）`, -18);
  }

  const straddles = source.topics.some(
    (t) => t.startSec > startSec + 0.5 && t.startSec < endSec - 0.5,
  );
  if (straddles) add('topic_straddle', '話題の切れ目をまたぐ', -15);

  const score = breakdown.reduce((sum, s) => sum + s.points, 0);

  return { startSec, endSec, seed, score, breakdown, metrics, excerpt };
}

/**
 * ショート候補を抽出する。
 *
 * 既定で最大16本。この候補の文字起こし抜粋だけをAPIに送り、
 * 順位付け・採用理由・フック文を評価させる（APIが新しい区間を作ることはしない）。
 */
export function extractShortCandidates(
  source: ShortCandidateSource,
  rules: Partial<ShortRules> = {},
): ScoredShortCandidate[] {
  const config = { ...DEFAULT_SHORT_RULES, ...rules };
  const boundaries = collectBoundaries(source);

  const windows: Window[] = [];
  for (const seed of collectSeeds(source)) {
    const window = buildWindow(seed, boundaries, source, config);
    if (window) windows.push(window);
  }

  windows.sort((a, b) => b.score - a.score || a.startSec - b.startSec);

  const selected: Window[] = [];
  for (const window of windows) {
    const tooClose = selected.some(
      (chosen) =>
        overlapSec(chosen, window) > 0 ||
        Math.abs(chosen.startSec - window.startSec) < config.minGapSec,
    );
    if (tooClose) continue;
    selected.push(window);
    if (selected.length >= config.maxCandidates) break;
  }

  // 提示は時刻順のほうが確認しやすい。
  selected.sort((a, b) => a.startSec - b.startSec);

  return selected.map((window, index) => ({
    id: `short_${String(index + 1).padStart(2, '0')}`,
    startSec: Number(window.startSec.toFixed(3)),
    endSec: Number(window.endSec.toFixed(3)),
    // ★タイトルとフックはここで埋めない。AIまたは人が書く。
    title: '',
    hook: '',
    rationale: window.breakdown
      .filter((s) => s.points > 0)
      .map((s) => s.label)
      .join(' / '),
    primarySpeakerId:
      dominantSpeaker(window, source.speech) ?? window.seed.speakerId,
    score: window.score,
    signals: window.breakdown.map((s) => s.label),
    breakdown: window.breakdown,
    transcriptExcerpt: window.excerpt,
    metrics: window.metrics,
  }));
}

export interface DeriveEmphasisOptions {
  /** キーワードの前後、何秒を強調区間にするか。 */
  windowSec: number;
  /** 同一キーワードの再ヒットをこの秒数以内なら1つにまとめる。 */
  mergeGapSec: number;
}

export const DEFAULT_EMPHASIS_OPTIONS: DeriveEmphasisOptions = {
  windowSec: 2,
  mergeGapSec: 4,
};

/**
 * キーワードの出現箇所から強調ポイントの候補を作る（ローカル・決定的）。
 *
 * AIによる「印象的な発言の検出」の代わりとして、Phase1ではキーワード一致
 * という単純な基準を使う。同じ入力なら毎回同じ結果になり、APIを一切
 * 使わない。将来AIアシストモードで文脈理解による検出に置き換えられる
 * 想定の暫定実装（[06-ai-prompts.md] のAI処理範囲とは別軸）。
 *
 * キーワードが1つも無ければ空を返す——推測でそれらしい強調点を
 * でっち上げることはしない。
 */
export function deriveEmphasisPoints(
  words: readonly Word[],
  keywords: readonly string[],
  options: Partial<DeriveEmphasisOptions> = {},
): EmphasisPoint[] {
  const opt = { ...DEFAULT_EMPHASIS_OPTIONS, ...options };
  const cleanKeywords = keywords.map((k) => k.trim()).filter(Boolean);
  if (cleanKeywords.length === 0 || words.length === 0) return [];

  const fullText = words.map((w) => w.text).join('');
  // 各文字が何単語目に属するかの索引（キーワードの文字位置→単語）を作る。
  const charToWordIndex: number[] = [];
  words.forEach((w, i) => {
    for (const _ch of w.text) charToWordIndex.push(i);
  });

  const hits: { startSec: number; endSec: number; keyword: string }[] = [];
  for (const keyword of cleanKeywords) {
    let fromIndex = 0;
    for (;;) {
      const pos = fullText.indexOf(keyword, fromIndex);
      if (pos === -1) break;
      const wordIndex = charToWordIndex[pos] ?? 0;
      const word = words[wordIndex]!;
      hits.push({
        startSec: Math.max(0, word.startSec - opt.windowSec),
        endSec: word.endSec + opt.windowSec,
        keyword,
      });
      fromIndex = pos + keyword.length;
    }
  }
  if (hits.length === 0) return [];

  hits.sort((a, b) => a.startSec - b.startSec);

  const merged: { startSec: number; endSec: number; keywords: string[] }[] = [];
  for (const hit of hits) {
    const last = merged[merged.length - 1];
    if (last && hit.startSec - last.endSec <= opt.mergeGapSec) {
      last.endSec = Math.max(last.endSec, hit.endSec);
      if (!last.keywords.includes(hit.keyword)) last.keywords.push(hit.keyword);
    } else {
      merged.push({ startSec: hit.startSec, endSec: hit.endSec, keywords: [hit.keyword] });
    }
  }

  return merged.map((m) => ({
    startSec: Number(m.startSec.toFixed(3)),
    endSec: Number(m.endSec.toFixed(3)),
    text: m.keywords.join('・'),
    quote: textInRange(words, m),
  }));
}
