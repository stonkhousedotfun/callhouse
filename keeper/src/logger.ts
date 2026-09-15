/**
 * Structured logging. One logger for the process, child loggers per subsystem.
 *
 * bigint is not JSON-serialisable and the keeper's whole vocabulary is bigints, so the
 * serialiser stringifies them rather than throwing halfway through a log line.
 */
import { pino, type Logger } from 'pino';
import { config } from './config.js';

const isTty = process.stdout.isTTY === true;

export const logger: Logger = pino({
  level: config.KEEPER_LOG_LEVEL,
  base: { service: 'callhouse-keeper', vault: config.VAULT, chainId: config.CHAIN_ID },
  formatters: {
    // Emit `level: "info"` instead of `level: 30`; log shippers read the word, humans do too.
    level: (label) => ({ level: label }),
  },
  hooks: {
    logMethod(args, method) {
      method.apply(this, args.map(scrubBigints) as Parameters<typeof method>);
    },
  },
  ...(isTty
    ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } } }
    : {}),
});

function scrubBigints(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(scrubBigints);
  if (value && typeof value === 'object' && value.constructor === Object) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = scrubBigints(v);
    return out;
  }
  return value;
}

export const log = {
  roll: logger.child({ mod: 'roll' }),
  policy: logger.child({ mod: 'policy' }),
  seaport: logger.child({ mod: 'seaport' }),
  state: logger.child({ mod: 'state' }),
  alerts: logger.child({ mod: 'alerts' }),
  health: logger.child({ mod: 'health' }),
  boot: logger.child({ mod: 'boot' }),
} as const;
