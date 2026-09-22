import { db } from "ponder:api";
import schema from "ponder:schema";
import type { Hono } from "hono";
import { and, asc, desc, eq, gt, isNotNull, sql } from "ponder";

import { indexedHead } from "./machine";
import { address, error, limit } from "./shared";

type OperationStatus = "pending" | "executed" | "canceled";
type OperationCursor = { block: bigint; logIndex: number; id: string };
type OperationRow = typeof schema.v2AccessOperation.$inferSelect;

// NOTE THE ABSENCE OF `label` HERE, AND DO NOT ADD IT BACK.
// Every column below is structurally required to render an operation row. `label` is not: it is a
// human description of the target and selector. Filtering on it meant that any operation whose
// target this indexer could not name was dropped from BOTH this route and the /v2/config pending
// notice, so consumers read "no pending governance operations" with HTTP 200 while operations were
// pending against the AccessManager. A descriptive field must never decide whether a row exists.
// `accessManager.ts` now also guarantees a non-null label for unnamed targets, so this is belt and
// braces rather than the only guard — deliberately, because the failure it prevents is silent.
// `selector` is also intentionally absent: short scheduled calldata is stored with null selector.
const COMPLETE_OPERATION = and(
  isNotNull(schema.v2AccessOperation.caller),
  isNotNull(schema.v2AccessOperation.target),
  isNotNull(schema.v2AccessOperation.roleName),
  isNotNull(schema.v2AccessOperation.scheduledAt),
  isNotNull(schema.v2AccessOperation.readyAt),
  isNotNull(schema.v2AccessOperation.scheduledBlock),
  isNotNull(schema.v2AccessOperation.scheduledLogIndex),
);

function operationWire(row: OperationRow) {
  // Same rule as COMPLETE_OPERATION: a null label must not delete the row. Rows indexed BEFORE the
  // label fallback landed still carry null, and dropping them here would reproduce the exact
  // fail-open this route was fixed for — silently, and only for historical rows, which is worse.
  // The wire contract requires a non-empty string (schema.ts adminOperationSchema `label`), so the
  // description is synthesised here rather than emitted as null.
  if (row.caller === null || row.target === null ||
      row.roleName === null || row.scheduledAt === null || row.readyAt === null) return null;
  return {
    // THE ROW KEY IS PUBLISHED NOW, AND IT IS NOT A RENAME OF `id`.
    // `row.id` is `operationId:nonce` (accessManager.ts:135-137) and is unique per scheduled
    // operation. `row.opId` is NOT: AccessManager reuses an operation id when the same call
    // is rescheduled, so two pending rows can publish the same `id`. Consumers that key a list on
    // `id` collapse or mis-render those two -- the pending operation that disappears is a real one.
    // `id` keeps its meaning and its place on the wire; `key` is the additive unique field.
    key: row.id,
    // The public id is AccessManager's operation id. The internal row key also carries the nonce.
    // The DB column is `opId` (ponder reserves `operation_id`, T-OP-197); the WIRE name stays `id`.
    id: row.opId,
    role: row.roleName,
    target: address(row.target),
    selector: row.selector,
    label: row.label ?? `unknown-target ${row.target.toLowerCase()} ${row.selector?.toLowerCase() ?? "no-selector"}`,
    caller: address(row.caller),
    scheduledAt: Number(row.scheduledAt),
    readyAt: Number(row.readyAt),
    status: row.status,
  };
}

function operationCursor(row: OperationRow): string {
  if (row.scheduledBlock === null || row.scheduledLogIndex === null) throw new Error("operation cursor lacks schedule provenance");
  return Buffer.from(JSON.stringify([
    row.scheduledBlock.toString(), row.scheduledLogIndex, row.id,
  ])).toString("base64url");
}

function parseOperationCursor(raw: string | undefined): OperationCursor | null | undefined {
  if (raw === undefined) return undefined;
  if (!raw.length || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const parts: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parts) || parts.length !== 3 || typeof parts[0] !== "string" ||
        typeof parts[1] !== "number" || typeof parts[2] !== "string" ||
        !/^(0|[1-9]\d{0,18})$/.test(parts[0]) || !Number.isInteger(parts[1]) ||
        parts[1] < 0 || parts[1] > 2_147_483_647 || parts[2].length === 0 || parts[2].length > 256) return null;
    const block = BigInt(parts[0]);
    const canonical = Buffer.from(JSON.stringify(parts)).toString("base64url");
    return block <= 9_223_372_036_854_775_807n && canonical === raw
      ? { block, logIndex: parts[1], id: parts[2] } : null;
  } catch {
    return null;
  }
}

/** Current, still-executable operations for the compact `/v2/config` notice. */
export async function loadPendingOperations(indexedAt: bigint) {
  const rows = await db.select().from(schema.v2AccessOperation).where(and(
    COMPLETE_OPERATION,
    eq(schema.v2AccessOperation.status, "pending"),
    isNotNull(schema.v2AccessOperation.expiresAt),
    gt(schema.v2AccessOperation.expiresAt, indexedAt),
  )).orderBy(asc(schema.v2AccessOperation.readyAt), asc(schema.v2AccessOperation.id));
  return rows.map(operationWire).filter((item) => item !== null).map(({ status: _status, ...operation }) => operation);
}

export function registerAdminRoutes(app: Hono) {
  /**
   * F-APP-INDEXER-08. THIS IS A PUBLIC, UNAUTHENTICATED GET, like every other v2 route.
   *
   * The `/admin/` segment names the SUBJECT of the route - AccessManager operations - and not an
   * access boundary. Nothing in the v2 app authenticates: the only middleware on the path is the
   * V2_CLEARINGHOUSE presence check, the 15s response cache and the frozen-schema validator
   * (src/api/v2/index.ts). Read the name as "the admin operations feed", never as "the feed only an
   * admin may read".
   *
   * DELIBERATELY NOT RENAMED (T-188 acceptance criterion 6d). A name that implied authorization would
   * be worse than one that merely reads oddly, because the next reader would stop looking for the
   * middleware that is not there.
   *
   * NO AUTH ADDED, and none is missing. Every field served here is already public on chain: these are
   * scheduled and executed AccessManager operations, readable by anyone with an RPC endpoint. What the
   * finding leaves open is request COST on an unauthenticated route, not confidentiality. That cost is
   * bounded by the response cache and by the keyset paging below, and it was not measured.
   */
  app.get("/admin/operations", async (c) => {
    const statusRaw = c.req.query("status") ?? "pending";
    if (statusRaw !== "pending" && statusRaw !== "executed" && statusRaw !== "canceled") {
      return error(c, "bad_status", "Status must be pending, executed, or canceled.");
    }
    const status: OperationStatus = statusRaw;
    const cursor = parseOperationCursor(c.req.query("cursor"));
    if (cursor === null) return error(c, "bad_cursor", "Invalid admin-operation cursor.");
    const size = limit(c.req.query("limit"));
    const indexedAt = (await indexedHead())?.ts ?? 0n;
    const rows = await db.select().from(schema.v2AccessOperation).where(and(
      COMPLETE_OPERATION,
      eq(schema.v2AccessOperation.status, status),
      status === "pending" ? and(
        isNotNull(schema.v2AccessOperation.expiresAt),
        gt(schema.v2AccessOperation.expiresAt, indexedAt),
      ) : undefined,
      cursor === undefined ? undefined : sql`(
        ${schema.v2AccessOperation.scheduledBlock},
        ${schema.v2AccessOperation.scheduledLogIndex},
        ${schema.v2AccessOperation.id}
      ) < (${cursor.block}, ${cursor.logIndex}, ${cursor.id})`,
    )).orderBy(
      desc(schema.v2AccessOperation.scheduledBlock),
      desc(schema.v2AccessOperation.scheduledLogIndex),
      desc(schema.v2AccessOperation.id),
    ).limit(size + 1);
    const sliced = rows.slice(0, size);
    const items = sliced.map(operationWire).filter((item) => item !== null);
    return c.json({
      items,
      nextCursor: rows.length > size ? operationCursor(sliced[sliced.length - 1]!) : null,
    });
  });
}
