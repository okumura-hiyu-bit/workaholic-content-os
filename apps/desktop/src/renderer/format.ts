/** 表示用の整形。Reactに依存しないのでそのままテストできる。 */

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatDateTime(iso: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('ja-JP');
}

export function percent(ratio: number): string {
  return `${Math.round(Math.min(Math.max(ratio, 0), 1) * 100)}%`;
}

/** 秒を `00:00:00.000` 形式にする。字幕の確認では小数点以下まで見たい。 */
export function formatTimecode(sec: number): string {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.floor((clamped % 1) * 1000);
  return (
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:` +
    `${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`
  );
}

/**
 * 本文を、低confidence語とそれ以外に分割する。
 * ★元の文字列は変えない。表示のために区切るだけ。
 */
export function splitByLowConfidence(
  text: string,
  words: readonly { text: string }[],
): { text: string; low: boolean }[] {
  const targets = [...new Set(words.map((w) => w.text).filter((t) => t.length > 0))];
  if (targets.length === 0) return [{ text, low: false }];

  const parts: { text: string; low: boolean }[] = [];
  let rest = text;

  while (rest.length > 0) {
    // 最も手前で一致する語を探す。
    let bestIndex = -1;
    let bestWord = '';
    for (const word of targets) {
      const index = rest.indexOf(word);
      if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
        bestIndex = index;
        bestWord = word;
      }
    }
    if (bestIndex === -1) {
      parts.push({ text: rest, low: false });
      break;
    }
    if (bestIndex > 0) parts.push({ text: rest.slice(0, bestIndex), low: false });
    parts.push({ text: bestWord, low: true });
    rest = rest.slice(bestIndex + bestWord.length);
  }

  return parts;
}

/**
 * 成果物のパスを読みやすくする。
 * 工程からは絶対パスが返るため、プロジェクトフォルダ配下なら相対表記に短縮する。
 */
export function shortenPath(filePath: string, projectPath: string): string {
  if (projectPath === '') return filePath;
  const prefix = projectPath.endsWith('/') ? projectPath : `${projectPath}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}
