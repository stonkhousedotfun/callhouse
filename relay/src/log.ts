/**
 * Structured logging, one JSON object per line, in the same {level, service, msg, ...fields}
 * shape as the keeper's pino output and the indexer's lib/log.ts, so one log shipper reads all
 * three.
 *
 * WHAT NEVER GOES IN A FIELD: RELAY_TOKEN, a Discord webhook URL (its path IS the credential),
 * a Telegram bot token (it sits in the sendMessage path), or a request URL with its query string
 * (the keeper's token may ride there as `?token=`). Callers pass target names, HTTP statuses and
 * error codes; nothing in this module can redact after the fact, so the rule is enforced at the
 * call sites and pinned by server.test.ts.
 *
 * The sink is injectable so the tests can capture every line and assert on what is absent.
 */

export type LogSink = (line: string) => void;
export type Fields = Record<string, unknown>;

export interface Logger {
  info(fields: Fields, msg: string): void;
  warn(fields: Fields, msg: string): void;
  error(fields: Fields, msg: string): void;
}

const SERVICE = 'callhouse-relay';

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
