/**
 * 開発者向けの構造化ログ。
 *
 * ★役割の分担
 * ユーザーには userMessage だけを見せ、technicalMessage・stack trace・
 * 終了コードなどはここに残す。画面に技術的な文言を出さないための受け皿。
 *
 * ★載せてはいけないもの
 * APIキー・文字起こし全文・字幕全文・音声内容。
 * 呼び出し側が渡さない前提だが、ログも漏洩経路になりうるので方針を明記する。
 */

export interface StructuredLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LogSink {
  write(line: string): void;
}

function serialize(
  level: 'info' | 'error',
  message: string,
  fields: Record<string, unknown> | undefined,
): string {
  const entry: Record<string, unknown> = {
    at: new Date().toISOString(),
    level,
    message,
  };
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      // Errorはそのままだと JSON.stringify で {} になるため、明示的に落とす。
      entry[key] =
        value instanceof Error ? (value.stack ?? value.message) : value;
    }
  }
  try {
    return JSON.stringify(entry);
  } catch {
    return JSON.stringify({ at: entry.at, level, message, note: 'fields-unserializable' });
  }
}

export function createLogger(sink: LogSink): StructuredLogger {
  return {
    info(message, fields) {
      sink.write(serialize('info', message, fields));
    },
    error(message, fields) {
      sink.write(serialize('error', message, fields));
    },
  };
}

/** 標準出力に書くだけのシンク。 */
export const consoleSink: LogSink = {
  write(line) {
    process.stdout.write(`${line}\n`);
  },
};
