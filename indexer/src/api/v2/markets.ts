import { db } from "ponder:api";
import schema from "ponder:schema";
import type { Hono } from "hono";
import { and, desc, eq, gte, inArray, lte, sql } from "ponder";

import { CHAIN_ID, PRICING_URL, USDG, V2_AUTO_ROLLER, V2_CLEARINGHOUSE, V2_EXPIRY_CALENDAR,
  V2_KEEPER_REWARDS, V2_MAKER_REGISTRY, V2_ORDER_BOOK, V2_SETTLEMENT_ORACLE, V2_START_BLOCK } from "../../../lib/env";
import { V2_REGISTRY } from "../../../lib/v2/marketRegistry.generated";
import { effectiveFees, feeStateFromRow, feesEqual } from "../../../lib/v2/fees";
import { fetchFairQuote } from "../../../lib/v2/pricing";
import { readSpots } from "./chain";
import { bookWire, heroFromCards, loadBook, loadCards, loadQuote } from "./bookData";
import { indexedHead } from "./machine";
import { address, error, limit, money, nextOffset, offset, page, parseId, seriesWire, settlementWire } from "./shared";

const ZERO_QUOTE = { bestBid: null, bestAsk: null, bidUnits: "0", askUnits: "0",
  fair: null, iv: null, delta: null, last: null };
const registryMarkets = new Map<string, (typeof V2_REGISTRY.markets)[number]>(V2_REGISTRY.markets.map((market) => [market.ticker, market]));
const addressOrNull = (value: string | null | undefined) => value ? address(value) : null;

export function registerMarketRoutes(app: Hono) {
  app.get("/config", async (c) => {
    c.header("cache-control", "no-store");
    const [policy, protocol, head] = await Promise.all([
      db.select().from(schema.v2OrderBookState).limit(1),
      db.select().from(schema.v2ProtocolState).limit(1),
      indexedHead(),
    ]);
    const fees = V2_REGISTRY.fees;
    const feeState = feeStateFromRow(policy[0] ?? null, {
      premiumFeeBps: fees.premiumFeeBps, resaleFeeBps: fees.resaleFeeBps,
      takerFeeFlat: BigInt(fees.takerFeeFlat), takerFeeCapBps: fees.takerFeeCapBps,
      makerRebateBps: fees.makerRebateBps,
    });
    // A missing checkpoint leaves the last indexed policy active; host time cannot activate it.
    const current = effectiveFees(feeState, head?.ts ?? 0n);
    const next = head !== null && feeState.pending !== null && feeState.pending.effectiveAt > head.ts &&
      !feesEqual(current, feeState.pending.fees) ? feeState.pending : null;
    const contracts = V2_REGISTRY.contracts;
    return c.json({
      chainId: CHAIN_ID, interfaceVersion: V2_REGISTRY.interfaceVersion,
      deployBlock: String(V2_START_BLOCK ?? V2_REGISTRY.deployBlock ?? 0),
      usdg: { address: address(USDG), symbol: "USDG", decimals: 6 },
      contracts: {
        clearinghouse: addressOrNull(V2_CLEARINGHOUSE ?? contracts.clearinghouse),
        orderBook: addressOrNull(V2_ORDER_BOOK ?? contracts.orderBook),
        settlementOracle: addressOrNull(V2_SETTLEMENT_ORACLE ?? contracts.settlementOracle),
        expiryCalendar: addressOrNull(V2_EXPIRY_CALENDAR ?? contracts.expiryCalendar),
        keeperRewards: addressOrNull(V2_KEEPER_REWARDS ?? contracts.keeperRewards),
        autoRoller: addressOrNull(V2_AUTO_ROLLER ?? contracts.autoRoller),
        payoutAdapter: addressOrNull(protocol[0]?.payoutAdapter ?? contracts.payoutAdapter),
        makerVault: addressOrNull(contracts.makerVault),
        makerRegistry: addressOrNull(V2_MAKER_REGISTRY ?? contracts.makerRegistry),
        rewardsDistributor: addressOrNull(contracts.rewardsDistributor),
        sources: Object.fromEntries(Object.entries(contracts.sources).map(([key, value]) => [key, addressOrNull(value)])),
      },
      fees: {
        premiumFeeBps: current.premiumFeeBps,
        resaleFeeBps: current.resaleFeeBps,
        takerFeeFlat: money(current.takerFeeFlat),
        takerFeeCapBps: current.takerFeeCapBps,
        makerRebateBps: current.makerRebateBps,
        exerciseFeeBps: fees.exerciseFeeBps,
        mintFeePpm: fees.mintFeePpm,
      },
      pendingFees: next === null ? null : {
        premiumFeeBps: next.fees.premiumFeeBps,
        resaleFeeBps: next.fees.resaleFeeBps,
        takerFeeFlat: money(next.fees.takerFeeFlat),
        takerFeeCapBps: next.fees.takerFeeCapBps,
        makerRebateBps: next.fees.makerRebateBps,
        effectiveAt: Number(next.effectiveAt),
      },
      constants: {
        unit: "10000000000000000", unitsPerShare: 100, priceTick: 100,
        settlementWindow: 1800, finalizeDelay: 120, snapshotGrace: 600,
        resolveDelay: 172800, maxTenor: 3888000, minSeriesLead: 3600,
        mintFeePeriod: 604800, mintFeeCeilPpm: 5000,
      },
      ladder: V2_REGISTRY.defaults.ladder,
    });
  });

  app.get("/markets", async (c) => {
    const rows = await db.select().from(schema.v2Market);
    const spots = await readSpots(rows.map((row) => row.underlying));
    const now = BigInt(Math.floor(Date.now() / 1000));
    const [openExpiries, recentPremiums] = await Promise.all([
      db.selectDistinct({ underlying: schema.v2Series.underlying, expiry: schema.v2Series.expiry })
        .from(schema.v2Series).where(eq(schema.v2Series.status, "open")),
      db.select({
        underlying: schema.v2Series.underlying,
        volume24h: sql<string>`coalesce(sum(case when ${schema.v2Fill.ts} >= ${now - 86_400n} then ${schema.v2Fill.premium} else 0 end), 0)::text`,
        premium7d: sql<string>`coalesce(sum(${schema.v2Fill.premium}), 0)::text`,
      }).from(schema.v2Fill)
        .innerJoin(schema.v2Series, eq(schema.v2Fill.longId, schema.v2Series.longId))
        .where(gte(schema.v2Fill.ts, now - 7n * 86_400n))
        .groupBy(schema.v2Series.underlying),
    ]);
    const expiriesByUnderlying = new Map<string, number[]>();
    for (const row of openExpiries) {
      const key = row.underlying.toLowerCase();
      const expiries = expiriesByUnderlying.get(key) ?? [];
      const expiry = Number(row.expiry);
      if (!expiries.includes(expiry)) expiries.push(expiry);
      expiriesByUnderlying.set(key, expiries);
    }
    for (const expiries of expiriesByUnderlying.values()) expiries.sort((a, b) => a - b);
    const premiumsByUnderlying = new Map<string, { volume24h: bigint; premium7d: bigint }>();
    for (const row of recentPremiums) {
      const key = row.underlying.toLowerCase();
      const prior = premiumsByUnderlying.get(key) ?? { volume24h: 0n, premium7d: 0n };
      premiumsByUnderlying.set(key, {
        volume24h: prior.volume24h + BigInt(row.volume24h),
        premium7d: prior.premium7d + BigInt(row.premium7d),
      });
    }
    return c.json(rows.map((row) => {
      const registered = registryMarkets.get(row.ticker);
      const spot = spots.get(row.underlying.toLowerCase());
      const key = row.underlying.toLowerCase();
      const expiries = expiriesByUnderlying.get(key) ?? [];
      const premiums = premiumsByUnderlying.get(key);
      const volume24h = premiums?.volume24h ?? 0n;
      const premium7d = premiums?.premium7d ?? 0n;
      return {
        ticker: row.ticker, name: registered?.name ?? row.ticker, underlying: address(row.underlying),
        status: row.status, spot: spot ? money(spot.price) : null, spotUpdatedAt: spot?.updatedAt ?? null,
        strikeTick: money(row.strikeTick), mintFeePpm: row.mintFeePpm, puts: registered?.puts ?? false, expiries,
        stats: { volume24h: money(volume24h), premium7d: money(premium7d),
          openInterestUnits: row.openInterestUnits.toString(), seriesOpen: row.seriesOpen },
      };
    }));
  });

  app.get("/calendar/holidays", async (c) => {
    const fromRaw = c.req.query("fromDay");
    const toRaw = c.req.query("toDay");
    if ((fromRaw === undefined) !== (toRaw === undefined))
      return error(c, "bad_calendar_range", "fromDay and toDay must be supplied together.");
    if ((fromRaw !== undefined && !/^\d+$/.test(fromRaw)) ||
      (toRaw !== undefined && !/^\d+$/.test(toRaw)))
      return error(c, "bad_calendar_range", "Calendar day indices must be decimal integers.");
    const today = Math.floor(Date.now() / 86_400_000);
    const fromDay = fromRaw === undefined ? today : Number(fromRaw);
    const toDay = toRaw === undefined ? today + 30 : Number(toRaw);
    if (!Number.isSafeInteger(fromDay) || !Number.isSafeInteger(toDay) || fromDay < 0 ||
      toDay < fromDay || toDay > 100_000_000 || toDay - fromDay >= 62)
      return error(c, "bad_calendar_range", "Calendar range must contain 1 to 62 UTC days.");
    const rows = await db.select().from(schema.v2CalendarHoliday).where(and(
      gte(schema.v2CalendarHoliday.dayIndex, fromDay),
      lte(schema.v2CalendarHoliday.dayIndex, toDay),
    ));
    const holidays = new Map(rows.map((row) => [row.dayIndex, row.isHoliday]));
    const items = Array.from({ length: toDay - fromDay + 1 }, (_, offset) => {
      const dayIndex = fromDay + offset;
      const weekday = new Date(dayIndex * 86_400_000).getUTCDay();
      const isHoliday = holidays.get(dayIndex) ?? false;
      return { dayIndex, isHoliday, isSessionDay: weekday !== 0 && weekday !== 6 && !isHoliday };
    });
    return c.json({ items });
  });

  app.get("/markets/:ticker/series", async (c) => {
    const start = offset(c.req.query("cursor"));
    if (start === null) return error(c, "bad_cursor", "Cursor is outside the supported page range.");
    const ticker = c.req.param("ticker").toUpperCase();
    const market = (await db.select().from(schema.v2Market).where(eq(schema.v2Market.ticker, ticker)).limit(1))[0];
    if (!market) return error(c, "market_not_found", "Market was not found.", 404);
    const expiryRaw = c.req.query("expiry");
    const expiry = expiryRaw === undefined ? undefined : parseId(expiryRaw);
    if (expiry === null) return error(c, "bad_expiry", "Expiry must be Unix seconds.");
    const type = c.req.query("type");
    if (type !== undefined && type !== "call" && type !== "put") return error(c, "bad_type", "Type must be call or put.");
    const status = c.req.query("status");
    const statuses = ["open", "cutoff", "expired", "settling", "held", "settled"] as const;
    const statusFilter = statuses.find((value) => value === status);
    if (status !== undefined && statusFilter === undefined) return error(c, "bad_status", "Unknown series status.");
    const now = BigInt(Math.floor(Date.now() / 1000));
    const size = limit(c.req.query("limit"));
    const rows = await db.select().from(schema.v2Series).where(and(
      eq(schema.v2Series.underlying, market.underlying),
      expiry === undefined ? undefined : eq(schema.v2Series.expiry, expiry),
      type === undefined ? undefined : eq(schema.v2Series.isPut, type === "put"),
      statusFilter === undefined ? undefined : eq(schema.v2Series.status, statusFilter),
    )).orderBy(schema.v2Series.expiry, schema.v2Series.strike, schema.v2Series.longId)
      .limit(size + 1).offset(start);
    const sliced = rows.slice(0, size);
    const volumes = sliced.length === 0 ? [] : await db.select({
      longId: schema.v2Fill.longId,
      premium: sql<string>`coalesce(sum(${schema.v2Fill.premium}), 0)::text`,
    }).from(schema.v2Fill).where(and(
      inArray(schema.v2Fill.longId, sliced.map((row) => row.longId)),
      gte(schema.v2Fill.ts, now - 86_400n),
    )).groupBy(schema.v2Fill.longId);
    const volumeBySeries = new Map(volumes.map((row) => [row.longId, BigInt(row.premium)]));
    const items = await Promise.all(sliced.map(async (row) => {
      const loaded = await loadBook(row.longId, now);
      const quote = loaded ? await loadQuote(loaded) : ZERO_QUOTE;
      const volume24h = volumeBySeries.get(row.longId) ?? 0n;
      return { series: seriesWire(row), quote, openInterestUnits: row.openInterestUnits.toString(), volume24h: money(volume24h) };
    }));
    return c.json({ items, nextCursor: nextOffset(start, size, rows.length > size) });
  });

  app.get("/series/:longId", async (c) => {
    const id = parseId(c.req.param("longId"));
    if (id === null) return error(c, "bad_long_id", "Series id must be decimal.");
    const row = (await db.select().from(schema.v2Series).where(eq(schema.v2Series.longId, id)).limit(1))[0];
    if (!row) return error(c, "series_not_found", "Series was not found.", 404);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const loaded = await loadBook(id, now);
    const quote = loaded ? await loadQuote(loaded) : ZERO_QUOTE;
    const settlement = (await db.select().from(schema.v2Settlement).where(and(
      eq(schema.v2Settlement.underlying, row.underlying), eq(schema.v2Settlement.expiry, row.expiry),
    )).limit(1))[0] ?? null;
    return c.json({ series: seriesWire(row), quote, openInterestUnits: row.openInterestUnits.toString(),
      volume: money(row.volumeUsdg), settlement: settlementWire(settlement, row), exerciseFeeBps: row.exerciseFeeBps });
  });

  app.get("/series/:longId/book", async (c) => {
    const id = parseId(c.req.param("longId"));
    if (id === null) return error(c, "bad_long_id", "Series id must be decimal.");
    const depthRaw = c.req.query("depth");
    const depth = depthRaw === undefined ? 20 : limit(depthRaw, 20);
    const loaded = await loadBook(id, BigInt(Math.floor(Date.now() / 1000)), depth);
    if (!loaded) return error(c, "series_not_found", "Series was not found.", 404);
    const wire = bookWire(loaded.book);
    return c.json({ ...wire, updatedBlock: String(wire.updatedBlock) });
  });

  app.get("/series/:longId/trades", async (c) => {
    const start = offset(c.req.query("cursor"));
    if (start === null) return error(c, "bad_cursor", "Cursor is outside the supported page range.");
    const id = parseId(c.req.param("longId"));
    if (id === null) return error(c, "bad_long_id", "Series id must be decimal.");
    const exists = (await db.select({ id: schema.v2Series.longId }).from(schema.v2Series)
      .where(eq(schema.v2Series.longId, id)).limit(1)).length > 0;
    if (!exists) return error(c, "series_not_found", "Series was not found.", 404);
    const size = limit(c.req.query("limit"));
    const rows = await db.select().from(schema.v2Fill).where(eq(schema.v2Fill.longId, id))
      .orderBy(desc(schema.v2Fill.ts), desc(schema.v2Fill.logIndex)).limit(size + 1).offset(start);
    return c.json({ items: rows.slice(0, size).map((row) => ({ id: row.id, ts: Number(row.ts),
      price: money(row.price), units: row.units.toString(), premium: money(row.premium),
      takerIsBuyer: row.takerIsBuyer, primary: row.primary, taker: address(row.taker), maker: address(row.maker), tx: row.tx })),
      nextCursor: nextOffset(start, size, rows.length > size) });
  });

  app.get("/cards", async (c) => {
    const start = offset(c.req.query("cursor"));
    if (start === null) return error(c, "bad_cursor", "Cursor is outside the supported page range.");
    const type = c.req.query("type");
    if (type !== undefined && type !== "call" && type !== "put") return error(c, "bad_type", "Type must be call or put.");
    const sort = c.req.query("sort") ?? "multiple";
    if (!["multiple", "expiry", "volume"].includes(sort)) return error(c, "bad_sort", "Unknown card sort.");
    const tenor = c.req.query("tenor");
    if (tenor !== undefined && !["daily", "weekly", "special"].includes(tenor)) return error(c, "bad_tenor", "Unknown tenor.");
    const now = BigInt(Math.floor(Date.now() / 1000));
    const snapshot = await loadCards(now, { ticker: c.req.query("ticker")?.toUpperCase(), tenor,
      type: type as "call" | "put" | undefined });
    c.header("x-internal-snapshot-expires-at", String(snapshot.expiresAt));
    const cards = snapshot.cards;
    cards.sort((a, b) => sort === "expiry" ? Number(a.expiry - b.expiry) :
      sort === "volume" ? Number(b.volumeUnits - a.volumeUnits) :
        b.card.perUnit.multiple - a.card.perUnit.multiple);
    const result = page(cards.map((card) => card.card), start, limit(c.req.query("limit")));
    return c.json({ ...result, generatedAt: snapshot.generatedAt });
  });

  app.get("/cards/hero", async (c) => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const snapshot = await loadCards(now);
    c.header("x-internal-snapshot-expires-at", String(snapshot.expiresAt));
    return c.json(heroFromCards(snapshot.cards, now));
  });

  app.get("/fair/:longId", async (c) => {
    const id = parseId(c.req.param("longId"));
    if (id === null) return error(c, "bad_long_id", "Series id must be decimal.");
    const row = (await db.select().from(schema.v2Series).where(eq(schema.v2Series.longId, id)).limit(1))[0];
    if (!row) return error(c, "series_not_found", "Series was not found.", 404);
    if (!PRICING_URL) return c.json({ fair: null, reason: "Pricing service is not configured." });
    const result = await fetchFairQuote({ ticker: row.ticker, strike: row.strike,
      expiry: Number(row.expiry), isPut: row.isPut });
    return result === null
      ? c.json({ fair: null, reason: "Pricing service is unavailable." })
      : c.json({ fair: money(result.fair), iv: result.iv, delta: result.delta,
        source: result.source, asOf: result.asOf });
  });
}
