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

/**
 * 成果物のパスを読みやすくする。
 * 工程からは絶対パスが返るため、プロジェクトフォルダ配下なら相対表記に短縮する。
 */
export function shortenPath(filePath: string, projectPath: string): string {
  if (projectPath === '') return filePath;
  const prefix = projectPath.endsWith('/') ? projectPath : `${projectPath}/`;
  return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
}
