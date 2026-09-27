/**
 * Structured logging, one JSON object per line, in the same {level, service, msg, ...fields}
 * shape as the keeper's pino output and the indexer's lib/log.ts, so one log shipper reads all
 * three.
 *
 * WHAT NEVER GOES IN A FIELD: RELAY_TOKEN, a Discord webhook URL (its path IS the credential),
 * a Telegram bot token (it sits in the sendMessage path), or a request URL with its query string
 * (the keeper's token may ride there as `?token=`). Callers pass target names, HTTP statuses and
 * error codes, and server.test.ts pins that.
 *
 * This module is also the backstop. Every finished line goes through redactUrls (./redact.ts)
 * BEFORE the sink, so a future `error: String(err)` that quotes one of those URLs prints scheme://host/…
 * instead of the webhook path or bot<TOKEN>, and an injected sink sees the redacted text too. It is a rule
 * by URL shape: a bare secret that is not inside a URL (RELAY_TOKEN on its own) is still the call sites' job.
 *
 * The sink is injectable so the tests can capture every line and assert on what is absent.
 */

import { redactUrls } from './redact.js';

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
    sink(redactUrls(JSON.stringify({ level, service: SERVICE, time: new Date().toISOString(), msg, ...fields })));
  };
  return {
    info: (fields, msg) => write('info', fields, msg),
    warn: (fields, msg) => write('warn', fields, msg),
    error: (fields, msg) => write('error', fields, msg),
  };
}
