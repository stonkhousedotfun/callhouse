import type { Context } from "hono";
import type schema from "ponder:schema";
import { formatUnits, getAddress, isAddress, type Address } from "viem";

export type SeriesRow = typeof schema.v2Series.$inferSelect;
export type MarketRow = typeof schema.v2Market.$inferSelect;
export type SettlementRow = typeof schema.v2Settlement.$inferSelect;
export type FillRow = typeof schema.v2Fill.$inferSelect;
export type PnlRow = typeof schema.v2PositionPnl.$inferSelect;

export function money(raw: bigint | null | undefined, decimals = 6) {
  const value = raw ?? 0n;
  return { raw: value.toString(), decimals, formatted: formatUnits(value, decimals) };
}

export function signedMoney(raw: bigint, decimals = 6) {
  return money(raw, decimals);
}

export function address(raw: string): Address { return getAddress(raw); }

export function seriesWire(row: SeriesRow) {
  return {
    longId: row.longId.toString(), shortId: (row.longId + 1n).toString(), ticker: row.ticker,
    underlying: address(row.underlying), isPut: row.isPut, strike: money(row.strike),
    expiry: Number(row.expiry), tenor: row.tenor as "daily" | "weekly" | "special",
    mintFeePpm: row.mintFeePpm, mintFeesHeld: money(row.mintFeesHeld, row.isPut ? 6 : 18),
    mintFeesAccrued: money(row.mintFeesAccrued, row.isPut ? 6 : 18),
    mintCutoff: Number(row.mintCutoff), status: row.status,
  };
}

export function settlementWire(row: SettlementRow | null, series: SeriesRow) {
  if (row === null) return null;
  const collateralDecimals = series.isPut ? 6 : 18;
  return {
    status: row.status,
    price: row.price === null ? null : money(row.price),
    longPayoutPerUnit: row.status === "Finalized" && series.longPayoutPerUnit !== null
      ? money(series.longPayoutPerUnit, collateralDecimals) : null,
    feePerUnit: row.status === "Finalized" && series.feePerUnit !== null
      ? money(series.feePerUnit, collateralDecimals) : null,
    shortPayoutPerUnit: row.status === "Finalized" && series.shortPayoutPerUnit !== null
      ? money(series.shortPayoutPerUnit, collateralDecimals) : null,
    finalizedAt: row.finalizedAt === null ? null : Number(row.finalizedAt),
    settledAt: series.settledAt === null ? null : Number(series.settledAt),
    sourceIndex: row.sourceIndex,
    corroborated: row.corroborated,
    candidate: row.candidatePrice === null ? null : {
      price: money(row.candidatePrice), sourceIndex: row.candidateSourceIndex ?? 0,
      disagreed: row.candidateDisagreed ?? false, finalizableAt: Number(row.finalizableAt ?? 0n),
    },
  };
}

export function parseId(raw: string): bigint | null {
  if (!/^(0|[1-9]\d{0,77})$/.test(raw)) return null;
  const id = BigInt(raw);
  return id <= (1n << 256n) - 1n ? id : null;
}

export function parseAddress(raw: string): Address | null {
  return isAddress(raw) ? getAddress(raw) : null;
}

export function limit(raw: string | undefined, fallback = 50): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 200) : fallback;
}

/** UI list offsets are bounded; the notifier feed uses a block/log keyset instead. */
const MAX_OFFSET = 10_000;
export function offset(raw: string | undefined): number | null {
  if (raw === undefined) return 0;
  if (raw.length > 5) return null;
  if (!/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return n <= MAX_OFFSET ? n : null;
}

export function nextOffset(start: number, size: number, hasMore: boolean): string | null {
  return hasMore && start + size <= MAX_OFFSET ? String(start + size) : null;
}

export function page<T>(items: T[], start: number, size: number) {
  return { items: items.slice(start, start + size), nextCursor: nextOffset(start, size, start + size < items.length) };
}

export function error(c: Context, code: string, message: string, status: 400 | 404 | 503 = 400) {
  return c.json({ error: { code, message } }, status);
}
