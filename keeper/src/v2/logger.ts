/**
 * Structured logging for a v2 mode: v1's logger.ts without its import of the v1 config.
 *
 * Same choices: `level` as a word, bigints stringified by a hook rather than throwing halfway
 * through a line (every chain value is a bigint), pino-pretty on a TTY only. The base names the
 * mode, so the cranker, the MM bot and the pricer can share one log stream.
 *
 * Every finished line goes through redactUrls (./redact.ts) on its way to the stream, whatever the caller
 * passed. An error object logged whole (a viem HttpRequestError carries the keyed RPC URL in its message, its stack
 * and its `url` field) cannot print the key: the hook sees the serialized line, not the fields one call site chose.
 */
import { pino, type DestinationStream, type Logger } from 'pino';
import type { V2LogLevel } from './config.js';
import { redactUrls } from './redact.js';

export type { Logger } from 'pino';

/** `destination` is a seam for tests (the lines a caller would see); the process default is stdout. */
export function createV2Logger(options: { level: V2LogLevel; mode: string; base?: Record<string, unknown>; destination?: DestinationStream }): Logger {
  const pretty = options.destination === undefined && process.stdout.isTTY === true;
  return pino(
    {
      level: options.level,
      base: { service: `callhouse-${options.mode}`, mode: options.mode, ...options.base },
      formatters: { level: (label) => ({ level: label }) },
      hooks: {
        logMethod(args, method) {
          method.apply(this, args.map(scrubBigints) as Parameters<typeof method>);
        },
        streamWrite: redactUrls,
      },
      ...(pretty ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } } : {}),
    },
    options.destination,
  );
}

export function scrubBigints(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(scrubBigints);
  if (value && typeof value === 'object' && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubBigints(v);
    return out;
  }
  return value;
}

/** For tests and seams: a logger that writes nothing. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
