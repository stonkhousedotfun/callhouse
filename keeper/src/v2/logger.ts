/**
 * Structured logging for a v2 mode: v1's logger.ts without its import of the v1 config.
 *
 * Same choices: `level` as a word, bigints stringified by a hook rather than throwing halfway
 * through a line (every chain value is a bigint), pino-pretty on a TTY only. The base names the
 * mode, so the cranker, the MM bot and the pricer can share one log stream.
 */
import { pino, type Logger } from 'pino';
import type { V2LogLevel } from './config.js';

export type { Logger } from 'pino';

export function createV2Logger(options: { level: V2LogLevel; mode: string; base?: Record<string, unknown> }): Logger {
  return pino({
    level: options.level,
    base: { service: `callhouse-${options.mode}`, mode: options.mode, ...options.base },
    formatters: { level: (label) => ({ level: label }) },
    hooks: {
      logMethod(args, method) {
        method.apply(this, args.map(scrubBigints) as Parameters<typeof method>);
      },
    },
    ...(process.stdout.isTTY === true ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } } : {}),
  });
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
