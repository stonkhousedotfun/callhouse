import { db } from "ponder:api";
import schema from "ponder:schema";
import type { Hono } from "hono";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lt, sql } from "ponder";

import { makerEpoch } from "../../../lib/v2/makerRegistry";
import { nyDayBounds, windowStarts } from "../../../lib/v2/windows";
import { address, error, limit, money, nextOffset, offset, seriesWire, type PnlRow, type SeriesRow } from "./shared";

function eligible(row: PnlRow): boolean {
  return row.closedAt !== null && row.closedTx !== null && row.multiplePpm !== null &&
    row.multiplePpm > 1_000_000n && !row.selfFill && !row.belowMinCost && !row.offMarket &&
    !row.transferIn && !row.transferredOut;
}

const eligibleSql = and(
  isNotNull(schema.v2PositionPnl.closedAt), isNotNull(schema.v2PositionPnl.closedTx),
  gt(schema.v2PositionPnl.multiplePpm, 1_000_000n),
  eq(schema.v2PositionPnl.selfFill, false), eq(schema.v2PositionPnl.belowMinCost, false),
  eq(schema.v2PositionPnl.offMarket, false), eq(schema.v2PositionPnl.transferIn, false),
  eq(schema.v2PositionPnl.transferredOut, false),
);

function winWire(row: PnlRow, series: SeriesRow) {
  return { id: row.id, holder: address(row.holder), ticker: series.ticker, series: seriesWire(series),
    cost: money(row.costUsdg), payout: money(row.proceedsUsdg + row.payoutUsdgValue),
    multiple: Number(row.multiplePpm!) / 1_000_000, settledAt: Number(row.closedAt), tx: row.closedTx! };
}

async function wins(pnl: PnlRow[]) {
  const longIds = [...new Set(pnl.map((row) => row.longId))];
  const series = longIds.length === 0 ? [] : await db.select().from(schema.v2Series)
    .where(inArray(schema.v2Series.longId, longIds));
  const byId = new Map(series.map((row) => [row.longId.toString(), row]));
  return pnl.filter(eligible).flatMap((row) => {
    const ref = byId.get(row.longId.toString());
    return ref ? [{ row, series: ref, wire: winWire(row, ref) }] : [];
  });
}

function weekBounds(at: bigint) {
  const start = windowStarts(at).week;
  // A New York Monday at noon seven days later stays in the next Monday even
  // if the intervening week crossed a DST boundary.
  const end = nyDayBounds(start + 7n * 86_400n + 12n * 3_600n).start;
  return { start, end };
}

async function biggestWin(start: bigint, end: bigint) {
  const [row] = await db.select().from(schema.v2PositionPnl)
    .where(and(eligibleSql, gte(schema.v2PositionPnl.closedAt, start), lt(schema.v2PositionPnl.closedAt, end)))
    .orderBy(desc(schema.v2PositionPnl.realisedUsdg), asc(schema.v2PositionPnl.id)).limit(1);
  return row === undefined ? null : (await wins([row]))[0]?.wire ?? null;
}

function epochWire(start: bigint) {
  const end = makerEpoch(start + 8n * 86_400n);
  return { id: Number(start / 604_800n), start: Number(start), end: Number(end) };
}

// JavaScript Date stops at 8.64e12 seconds, and epochWire looks eight days ahead.
const maxMakerEpochId = (8_640_000_000_000n - 8n * 86_400n - 604_800n) / 604_800n;

function makerStats(row: typeof schema.v2MakerEpoch.$inferSelect) {
  return { uptimePct: Number(row.uptimePpm) / 10_000,
    avgSpreadBps: row.twoSidedSamples > 0 ? Number(row.avgSpreadBps) : null,
    depthWithin100bps: row.depthWithin100bps.toString(), fills: row.fills,
    volume: money(row.volumeUsdg), rebates: money(row.rebatesUsdg), score: Number(row.scorePpm) / 10_000 };
}

export function registerFeedRoutes(app: Hono) {
  app.get("/feed/wins", async (c) => {
    const window = c.req.query("window") ?? "all";
    if (!["day", "week", "all"].includes(window)) return error(c, "bad_window", "Window must be day, week, or all.");
    const now = BigInt(Math.floor(Date.now() / 1000));
    const bounds = window === "day" ? nyDayBounds(now) : window === "week" ? weekBounds(now) : null;
    const start = offset(c.req.query("cursor"));
    if (start === null) return error(c, "bad_cursor", "Cursor is outside the supported page range.");
    const size = limit(c.req.query("limit"));
    const rows = await db.select().from(schema.v2PositionPnl)
      .where(and(eligibleSql, bounds === null ? undefined : gte(schema.v2PositionPnl.closedAt, bounds.start),
        bounds === null ? undefined : lt(schema.v2PositionPnl.closedAt, bounds.end)))
      .orderBy(desc(schema.v2PositionPnl.closedAt), asc(schema.v2PositionPnl.id))
      .limit(size + 1).offset(start);
    const selected = rows.slice(0, size);
    return c.json({ items: (await wins(selected)).map(({ wire }) => wire),
      nextCursor: nextOffset(start, size, rows.length > size) });
  });

  app.get("/leaderboard", async (c) => {
    const metric = c.req.query("metric") ?? "multiple";
    const window = c.req.query("window") ?? "week";
    if (!["multiple", "absolute", "streak"].includes(metric)) return error(c, "bad_metric", "Unknown leaderboard metric.");
    if (!["week", "month", "all"].includes(window)) return error(c, "bad_window", "Unknown leaderboard window.");
    const starts = windowStarts(BigInt(Math.floor(Date.now() / 1000)));
    const start = offset(c.req.query("cursor"));
    if (start === null) return error(c, "bad_cursor", "Cursor is outside the supported page range.");
    const size = limit(c.req.query("limit"));
    const score = metric === "multiple" ? schema.v2Leaderboard.bestMultiplePpm :
      metric === "absolute" ? schema.v2Leaderboard.absoluteRealisedUsdg : schema.v2Leaderboard.streak;
    const rows = await db.select().from(schema.v2Leaderboard).where(and(
      eq(schema.v2Leaderboard.window, window),
      eq(schema.v2Leaderboard.windowStart, starts[window as "week" | "month" | "all"]),
      isNotNull(schema.v2Leaderboard.bestWinId),
      // A later inbound token transfer can make a materialized best win ineligible
      // without refreshing its rank. Filter it before LIMIT/OFFSET so pages and
      // displayed ranks cannot have holes.
      sql`exists (select 1 from ${schema.v2PositionPnl} where
        ${schema.v2PositionPnl.id} = ${schema.v2Leaderboard.bestWinId} and ${eligibleSql})`,
    )).orderBy(desc(score), asc(schema.v2Leaderboard.holder)).limit(size + 1).offset(start);
    const selected = rows.slice(0, size);
    const ids = selected.flatMap((row) => row.bestWinId === null ? [] : [row.bestWinId]);
    const bestRows = ids.length === 0 ? [] : await db.select().from(schema.v2PositionPnl)
      .where(and(eligibleSql, inArray(schema.v2PositionPnl.id, ids)));
    const winById = new Map((await wins(bestRows)).map(({ wire }) => [wire.id, wire]));
    return c.json({ metric, window, items: selected.filter((row) => winById.has(row.bestWinId!)).map((row, index) => ({ rank: start + index + 1,
      holder: address(row.holder), value: metric === "multiple" ? Number(row.bestMultiplePpm) / 1_000_000 :
        metric === "absolute" ? money(row.absoluteRealisedUsdg) : row.streak,
      wins: row.wins, losses: row.losses, best: winById.get(row.bestWinId!)! })),
      nextCursor: nextOffset(start, size, rows.length > size) });
  });

  app.get("/pnl/:id", async (c) => {
    const row = (await db.select().from(schema.v2PositionPnl).where(eq(schema.v2PositionPnl.id, c.req.param("id"))).limit(1))[0];
    if (!row || !eligible(row)) return error(c, "pnl_not_found", "Verified win was not found.", 404);
    const series = (await db.select().from(schema.v2Series).where(eq(schema.v2Series.longId, row.longId)).limit(1))[0];
    if (!series) return error(c, "pnl_not_found", "Verified win was not found.", 404);
    const [entry] = await db.select({
      units: sql<string>`coalesce(sum(${schema.v2Fill.units}), 0)::text`,
      gross: sql<string>`coalesce(sum(${schema.v2Fill.premium}), 0)::text`,
    }).from(schema.v2Fill).where(and(eq(schema.v2Fill.longId, row.longId),
      sql`lower(${schema.v2Fill.buyer}) = ${row.holder.toLowerCase()}`));
    const units = BigInt(entry?.units ?? "0");
    const gross = BigInt(entry?.gross ?? "0");
    const entryPrice = units > 0n ? gross * 100n / units : 0n;
    return c.json({ ...winWire(row, series), units: row.unitsBought.toString(), entryPrice: money(entryPrice),
      settlementPrice: series.settlementPrice === null ? null : money(series.settlementPrice),
      spotAtEntry: row.spotAtEntry === null ? null : money(row.spotAtEntry) });
  });

  app.get("/stats", async (c) => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const [markets, fillTotals, pnlHolderCount, balanceOnlyHolderCount, biggestDay, biggestWeek] = await Promise.all([
      db.select().from(schema.v2Market),
      db.select({ volume24h: sql<string>`coalesce(sum(${schema.v2Fill.premium}), 0)::text` })
        .from(schema.v2Fill).where(gte(schema.v2Fill.ts, now - 86_400n)),
      db.select({ n: sql<number>`count(distinct ${schema.v2PositionPnl.holder})::int` })
        .from(schema.v2PositionPnl),
      db.select({ n: sql<number>`count(distinct ${schema.v2Balance.holder})::int` })
        .from(schema.v2Balance).where(and(gt(schema.v2Balance.units, 0n),
          sql`${schema.v2Balance.holder} not in
            (select ${schema.v2PositionPnl.holder} from ${schema.v2PositionPnl})`)),
      biggestWin(nyDayBounds(now).start, nyDayBounds(now).end),
      biggestWin(weekBounds(now).start, weekBounds(now).end),
    ]);
    const sum = (field: "volumeUsdg" | "premiumUsdg" | "feesUsdg") => markets.reduce((v, row) => v + row[field], 0n);
    return c.json({ volume24h: money(BigInt(fillTotals[0]?.volume24h ?? "0")),
    volumeAll: money(sum("volumeUsdg")), premiumAll: money(sum("premiumUsdg")), feesAll: money(sum("feesUsdg")),
    contractsFilled: markets.reduce((v, row) => v + row.volumeUnits, 0n).toString(),
    holders: Number(pnlHolderCount[0]?.n ?? 0) + Number(balanceOnlyHolderCount[0]?.n ?? 0),
    biggestWinDay: biggestDay, biggestWinWeek: biggestWeek });
  });

  app.get("/makers", async (c) => {
    const start = offset(c.req.query("cursor"));
    if (start === null) return error(c, "bad_cursor", "Cursor is outside the supported page range.");
    const epochRaw = c.req.query("epoch");
    if (epochRaw !== undefined && !/^\d{1,13}$/.test(epochRaw))
      return error(c, "bad_epoch", "Epoch must be a non-negative integer id.");
    const epochId = epochRaw === undefined ? null : BigInt(epochRaw);
    if (epochId !== null && epochId > maxMakerEpochId)
      return error(c, "bad_epoch", "Epoch is outside the supported date range.");
    const epochStart = epochId === null ? null : epochId * 604_800n;
    const [latest] = await db.select({ epoch: schema.v2MakerEpoch.epoch }).from(schema.v2MakerEpoch)
      .where(epochStart === null ? undefined : and(
        gte(schema.v2MakerEpoch.epoch, epochStart), lt(schema.v2MakerEpoch.epoch, epochStart + 604_800n)))
      .orderBy(desc(schema.v2MakerEpoch.epoch)).limit(1);
    const epoch = latest?.epoch ?? (epochId === null
      ? makerEpoch(BigInt(Math.floor(Date.now() / 1000))) : epochStart! + 345_600n);
    const size = limit(c.req.query("limit"));
    const rows = await db.select().from(schema.v2MakerEpoch)
      .where(eq(schema.v2MakerEpoch.epoch, epoch))
      .orderBy(desc(schema.v2MakerEpoch.scorePpm), asc(schema.v2MakerEpoch.maker))
      .limit(size + 1).offset(start);
    return c.json({ epoch: epochWire(epoch), items: rows.slice(0, size).map((row) => ({ maker: address(row.maker),
      tierBps: row.tierBps, ...makerStats(row) })), nextCursor: nextOffset(start, size, rows.length > size) });
  });

  app.get("/makers/:address", async (c) => {
    const raw = c.req.param("address");
    const maker = /^0x[\da-fA-F]{40}$/.test(raw) ? address(raw) : null;
    if (!maker) return error(c, "bad_address", "Maker must be an EVM address.");
    const rows = await db.select().from(schema.v2MakerEpoch)
      .where(sql`lower(${schema.v2MakerEpoch.maker}) = ${maker.toLowerCase()}`)
      .orderBy(desc(schema.v2MakerEpoch.epoch));
    if (rows.length === 0) return error(c, "maker_not_found", "Maker was not found.", 404);
    return c.json({ maker, tierBps: rows[0]!.tierBps, epochs: rows.map((row) => ({ epoch: epochWire(row.epoch), ...makerStats(row) })) });
  });
}
