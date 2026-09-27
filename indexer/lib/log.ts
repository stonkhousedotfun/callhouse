/**
 * Structured logging, one JSON object per line.
 *
 * Ponder already logs its own machinery — sync progress, reorgs, handler errors — through its
 * built-in logger. This module is for DOMAIN events the ops runbooks and alerts care about: a
 * cycle opening or closing, a fill, a halt, a role change, the fee being swept. It emits the
 * same {level, service, msg, ...fields} shape as the keeper's pino output so a log shipper
 * can merge the two streams without a parser per service.
 *
 * bigint is not JSON-serialisable and every figure here is a bigint, so values are
 * stringified on the way out rather than throwing halfway through a log line.
 *
 * Every finished line goes through redactUrls (./redact.ts), so a field that carries an RPC URL with its
 * key in the path or query prints scheme://host/… instead. Ponder's OWN logger is not this module: it serializes
 * its RPC errors (url included) straight to fd 1 (ponder/src/internal/logger.ts). Covers that in the
 * image: ./stdio-redact.mjs is PID 1, runs Ponder as its child and redacts every line Ponder writes to fd 1 or 2.
 */
import { redactUrls } from "./redact";

type Fields = Record<string, unknown>;

const SERVICE = "callhouse-indexer";

function write(level: "info" | "warn", msg: string, fields: Fields): void {
  const out: Record<string, unknown> = { level, service: SERVICE, msg };
  for (const [k, v] of Object.entries(fields)) {
    out[k] = typeof v === "bigint" ? v.toString() : v;
  }
  const line = redactUrls(JSON.stringify(out));
  if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  /** Expected domain events worth a record: cycle boundaries, fills, settlements, fee moves. */
  info: (fields: Fields, msg: string) => write("info", msg, fields),
  /** "Somebody should look at this" events: halts, role changes, oracle pauses, bad signatures. */
  warn: (fields: Fields, msg: string) => write("warn", msg, fields),
} as const;
