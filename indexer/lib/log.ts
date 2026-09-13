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
 */

type Fields = Record<string, unknown>;

const SERVICE = "callhouse-indexer";

function write(level: "info" | "warn", msg: string, fields: Fields): void {
  const out: Record<string, unknown> = { level, service: SERVICE, msg };
  for (const [k, v] of Object.entries(fields)) {
    out[k] = typeof v === "bigint" ? v.toString() : v;
  }
  const line = JSON.stringify(out);
  if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  /** Expected domain events worth a record: cycle boundaries, fills, settlements, fee moves. */
  info: (fields: Fields, msg: string) => write("info", msg, fields),
  /** "Somebody should look at this" events: halts, role changes, oracle pauses, bad signatures. */
  warn: (fields: Fields, msg: string) => write("warn", msg, fields),
} as const;
