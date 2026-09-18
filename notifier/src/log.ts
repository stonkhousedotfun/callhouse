/**
 * Structured logging, one JSON object per line, in the same {level, service, time, msg, ...fields}
 * shape as relay/src/log.ts, the keeper's pino output and the indexer's lib/log.ts, so one log
 * shipper reads all of them.
 *
 * WHAT NEVER GOES IN A FIELD: a target (Telegram chat id, push endpoint, email address), a wallet
 * address, a link token, a session token or an Authorization header, a signature,
 * NOTIFIER_DATA_KEY, the bot token (it sits in every Bot API path), a
 * request URL with its query string (signatures and tokens ride there), or `String(error)` (an
 * undici or nodemailer message can carry the host or mailbox it was talking to). Callers pass
 * subscription ids, delivery ids, kinds, channels, statuses and error CODES. Nothing here can
 * redact after the fact, so the rule is enforced at the call sites and pinned by the tests,
 * which capture every line and assert on what is absent.
 */

export type LogSink = (line: string) => void;
export type Fields = Record<string, unknown>;

export interface Logger {
  info(fields: Fields, msg: string): void;
  warn(fields: Fields, msg: string): void;
  error(fields: Fields, msg: string): void;
}

const SERVICE = 'callhouse-notifier';

export function createLogger(sink: LogSink = (line) => process.stdout.write(`${line}\n`)): Logger {
  const write = (level: 'info' | 'warn' | 'error', fields: Fields, msg: string): void => {
    sink(JSON.stringify({ level, service: SERVICE, time: new Date().toISOString(), msg, ...fields }));
  };
  return {
    info: (fields, msg) => write('info', fields, msg),
    warn: (fields, msg) => write('warn', fields, msg),
    error: (fields, msg) => write('error', fields, msg),
  };
}

/** A secret-free code for a failed outbound call (relay/src/targets.ts). Never the message. */
export function errorCode(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
    const own = (error as { code?: unknown }).code;
    if (typeof own === 'string' && /^[A-Z0-9_]{2,40}$/.test(own)) return own;
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== null && typeof cause === 'object') {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) return code;
    }
    return /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'error';
  }
  return 'error';
}
