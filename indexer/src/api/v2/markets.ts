import { db } from "ponder:api";
import schema from "ponder:schema";
import type { Hono } from "hono";
import { and, desc, eq, gte, inArray, lte, sql } from "ponder";

import { CHAIN_ID, PRICING_URL, USDG, V2_AUTO_ROLLER, V2_CLEARINGHOUSE, V2_EXPIRY_CALENDAR,
  V2_ACCESS_MANAGER, V2_BUYBACK_EXECUTOR, V2_FEE_SPLITTER, V2_KEEPER_REWARDS,
  V2_MAKER_REGISTRY, V2_ORDER_BOOK, V2_SETTLEMENT_ORACLE, V2_START_BLOCK } from "../../../lib/env";
import { V2_ACCESS_MANIFEST } from "../../../lib/v2/accessManagerRoles.generated";
import { V2_REGISTRY } from "../../../lib/v2/marketRegistry.generated";
import { effectiveFees, feeStateFromRow, feesEqual } from "../../../lib/v2/fees";
import { fetchFairResult } from "../../../lib/v2/pricing";
import { loadPendingOperations } from "./admin";
import { readSpots } from "./chain";
import { bookWire, heroFromCards, loadBook, loadCards, loadQuote } from "./bookData";
import { computeAtCheckpoint } from "../cache";
import { type IndexedHead, windowAsOf } from "./head";
import { indexedHead } from "./machine";
import { address, error, limit, money, nextOffset, offset, page, parseId, seriesWire, settlementWire } from "./shared";

const ZERO_QUOTE = { bestBid: null, bestAsk: null, bidUnits: "0", askUnits: "0",
  fair: null, iv: null, delta: null, last: null, fairProvenance: null };
const registryMarkets = new Map<string, (typeof V2_REGISTRY.markets)[number]>(V2_REGISTRY.markets.map((market) => [market.ticker, market]));
// T-OP-099. The owner's launch set (registry `launchSet.markets`, rendered by gen-v2-registry.mjs). The chain decides
// what is REGISTERED; this decides what is IN THE LAUNCH. A registered market outside it is served with
// `launch: false` rather than dropped, so the app can show it as deferred and an operator can see it exists.
const launchTickers = new Set<string>(V2_REGISTRY.launchSet.markets);
const addressOrNull = (value: string | null | undefined) => value ? address(value) : null;

type RegistrySupplement = {
  safes?: { admin?: string | null; treasury?: string | null };
  shared?: { safes?: { admin?: string | null; treasury?: string | null } };
};

const registrySupplement = V2_REGISTRY as unknown as RegistrySupplement;
const registrySafes = registrySupplement.safes ?? registrySupplement.shared?.safes;
const manifestRoles = V2_ACCESS_MANIFEST.roles as Record<string, number>;

function effectiveDelay(
  current: bigint | null | undefined,
  pending: bigint | null | undefined,
  pendingAt: bigint | null | undefined,
  indexedAt: bigint,
): bigint {
  return pending !== null && pending !== undefined && pendingAt !== null && pendingAt !== undefined && pendingAt <= indexedAt
    ? pending : current ?? 0n;
}

function accessRoles(
  rows: (typeof schema.v2AccessRole.$inferSelect)[],
  members: (typeof schema.v2AccessRoleMember.$inferSelect)[],
  indexedAt: bigint,
) {
  const roles = new Map(rows.map((row) => [row.roleId, row]));
  const holders = new Map<bigint, { address: `0x${string}`; delayS: number }[]>();
  for (const member of members) {
    if (!member.granted || (member.memberSince !== null && member.memberSince > indexedAt)) continue;
    const list = holders.get(member.roleId) ?? [];
    list.push({
      address: address(member.account),
      delayS: Number(effectiveDelay(
        member.executionDelayS,
        member.pendingExecutionDelayS,
        member.pendingExecutionDelayAt,
        indexedAt,
      )),
    });
    holders.set(member.roleId, list);
  }
  return Object.entries(manifestRoles).flatMap(([name, numericId]) => {
    const roleId = BigInt(numericId);
    const row = roles.get(roleId);
    if (row === undefined) return [];
    return [{
      id: numericId,
      name,
      delayS: Number(effectiveDelay(row.grantDelayS, row.pendingGrantDelayS, row.pendingGrantDelayAt, indexedAt)),
      holders: (holders.get(roleId) ?? []).sort((left, right) => left.address.localeCompare(right.address)),
    }];
  }).sort((left, right) => left.id - right.id);
}

type SeriesCursor = { expiry: bigint; strike: bigint; longId: bigint };

/** The series list is mutable, so its cursor names the last emitted sort key instead of an offset. */
function parseSeriesCursor(raw: string | undefined): SeriesCursor | null | undefined {
  if (raw === undefined) return undefined;
  if (!raw.length || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(decoded) || decoded.length !== 3 ||
        !decoded.every((value) => typeof value === "string")) return null;
    const [expiryRaw, strikeRaw, longIdRaw] = decoded as [string, string, string];
    const expiry = parseId(expiryRaw);
    const strike = parseId(strikeRaw);
    const longId = parseId(longIdRaw);
    if (expiry === null || strike === null || longId === null) return null;
    const canonical = Buffer.from(JSON.stringify([expiryRaw, strikeRaw, longIdRaw])).toString("base64url");
    return canonical === raw ? { expiry, strike, longId } : null;
  } catch {
    return null;
  }
}

function seriesCursorOf(row: { expiry: bigint; strike: bigint; longId: bigint }): string {
  return Buffer.from(JSON.stringify([
    row.expiry.toString(), row.strike.toString(), row.longId.toString(),
  ])).toString("base64url");
}

export function registerMarketRoutes(app: Hono) {
  /**
   * F-APP-INDEXER-08. This route stays `no-store` and OFF the 15-second cache on purpose: fee changes
   * and pending governance operations must switch at the indexed block, and a TTL would serve the old
   * policy for up to 15 s after it stopped being true. What it used to cost instead was a scan of both
   * AccessManager role tables plus loadPendingOperations on EVERY hit of a public GET.
   *
   * It is now computed once per indexed checkpoint (computeAtCheckpoint) and shared until the
   * checkpoint moves. That adds NO staleness beyond the index itself, and bounds the work by the
   * block rate instead of the request rate. With no checkpoint there is nothing to key on, so that
   * degraded case still computes per hit.
   */
  async function buildConfig(head: IndexedHead | null) {
    const [policy, protocol, roles, members] = await Promise.all([
      db.select().from(schema.v2OrderBookState).limit(1),
      db.select().from(schema.v2ProtocolState).limit(1),
      db.select().from(schema.v2AccessRole),
      db.select().from(schema.v2AccessRoleMember),
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
    const accessManager = V2_ACCESS_MANAGER ?? contracts.accessManager;
    const indexedAt = head?.ts ?? 0n;
    const pendingOperations = await loadPendingOperations(indexedAt);
    return {
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
        accessManager: addressOrNull(accessManager),
        sources: Object.fromEntries(Object.entries(contracts.sources).map(([key, value]) => [key, addressOrNull(value)])),
      },
      flywheel: {
        feeSplitter: addressOrNull(V2_FEE_SPLITTER ?? V2_REGISTRY.flywheel.feeSplitter),
        buybackExecutor: addressOrNull(V2_BUYBACK_EXECUTOR ?? V2_REGISTRY.flywheel.buybackExecutor),
      },
      safes: {
        admin: addressOrNull(registrySafes?.admin),
        treasury: addressOrNull(registrySafes?.treasury),
      },
      ...(accessManager === null || accessManager === undefined ? {} : { access: {
        manager: address(accessManager),
        // The manifest supplies stable role ids/names only. Live role and holder delays come from
        // indexed AccessManager state, never expectedExecutionDelayS or V2_ACCESS_MANIFEST.delaysS.
        roles: accessRoles(roles, members, indexedAt),
      } }),
      pendingOperations,
      fees: {
        premiumFeeBps: current.premiumFeeBps,
        resaleFeeBps: current.resaleFeeBps,
        takerFeeFlat: money(current.takerFeeFlat),
        takerFeeCapBps: current.takerFeeCapBps,
        makerRebateBps: current.makerRebateBps,
        exerciseFeeBps: protocol[0]?.defaultExerciseFeeBps ?? fees.exerciseFeeBps,
        mintFeePpm: protocol[0]?.defaultMintFeePpm ?? fees.mintFeePpm,
        // T-OP-120 (G7). Indexed from Clearinghouse:PayoutAdapterSet (src/v2/clearinghouse.ts); null until one has
        // been emitted. The app prices a call's USDG band with this, falling back to the 300 bps ceiling.
        maxPayoutSlippageBps: protocol[0]?.maxSlippageBps ?? null,
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
        // Source: callhouse-contracts branch v8, src/v2/interfaces/V2Constants.sol:60.
        // This protocol fee-change delay is distinct from the AccessManager FEE_MANAGER delay.
        mintFeePeriod: 604800, mintFeeCeilPpm: 5000, feeChangeDelay: 172800,
      },
      ladder: V2_REGISTRY.defaults.ladder,
    };
  }

  app.get("/config", async (c) => {
    // F-APP-INDEXER-08, acceptance criterion 6e - the staleness this introduces for pending
    // operations, stated: NONE beyond the index itself. /config is kept off the 15s response cache
    // (see index.ts) because a pending operation that has just become executable must not be
    // announced up to 15 seconds late. computeAtCheckpoint instead shares ONE computation per
    // indexed checkpoint, and Ponder writes projections and the checkpoint in one transaction, so an
    // unchanged checkpoint means unchanged indexed state. A pending operation therefore appears on
    // the first request after the block that scheduled it is indexed - the same instant every other
    // v2 route would see it - while both role-table scans and loadPendingOperations run once per
    // block instead of once per request.
    c.header("cache-control", "no-store");
    const head = await indexedHead();
    return c.json(head === null ? await buildConfig(null)
      : await computeAtCheckpoint("v2-config", head.checkpoint, () => buildConfig(head)));
  });

  app.get("/markets", async (c) => {
    const rows = await db.select().from(schema.v2Market);
    const spots = await readSpots(rows.map((row) => row.underlying));
    // F-APP-INDEXER-05: the 24h and 7d windows end at the INDEXED head, not the host clock, and agree
    // with /stats. A missing checkpoint measures no window at all. See windowAsOf.
    const asOf = windowAsOf(await indexedHead());
    const [openExpiries, recentPremiums] = await Promise.all([
      db.selectDistinct({ underlying: schema.v2Series.underlying, expiry: schema.v2Series.expiry })
        .from(schema.v2Series).where(eq(schema.v2Series.status, "open")),
      asOf === null ? [] : db.select({
        underlying: schema.v2Series.underlying,
        volume24h: sql<string>`coalesce(sum(case when ${schema.v2Fill.ts} >= ${asOf - 86_400n} then ${schema.v2Fill.premium} else 0 end), 0)::text`,
        premium7d: sql<string>`coalesce(sum(${schema.v2Fill.premium}), 0)::text`,
      }).from(schema.v2Fill)
        .innerJoin(schema.v2Series, eq(schema.v2Fill.longId, schema.v2Series.longId))
        .where(gte(schema.v2Fill.ts, asOf - 7n * 86_400n))
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
        status: row.status, launch: launchTickers.has(row.ticker),
        spot: spot ? money(spot.price) : null, spotUpdatedAt: spot?.updatedAt ?? null,
        strikeTick: money(row.strikeTick), mintFeePpm: row.mintFeePpm, puts: registered?.puts ?? false, expiries,
        ...(registered === undefined ? {} : { settlement: {
          sourceCount: registered.settlement.sourceCount,
          uncorroboratedDelayS: registered.settlement.uncorroboratedDelayS,
          route: registered.payoutRoute,
        } }),
        stats: { volume24h: money(volume24h), premium7d: money(premium7d),
          // T-425. The instant the two windows above end at: the INDEXED head, never the host clock.
          // It sits inside `stats` because that is the object whose figures it qualifies, and it is
          // one value per response -- every market's copy comes from the same `asOf` local, so two
          // markets on one page cannot disagree. 0 means no checkpoint was readable, which is the
          // same condition that makes both figures 0: no window was measured rather than a quiet day.
          asOf: Number(asOf ?? 0n),
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
    const rawCursor = c.req.query("cursor");
    const cursor = parseSeriesCursor(rawCursor);
    if (cursor === null)
      return error(c, "bad_cursor", "Invalid series cursor.");
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
    // Two clocks, deliberately. `now` (host) decides which resting orders are still live in the book,
    // as on every book route; the trailing 24h volume is a window over indexed fills and ends at the
    // indexed head, like /markets and /stats (F-APP-INDEXER-05).
    const now = BigInt(Math.floor(Date.now() / 1000));
    const asOf = windowAsOf(await indexedHead());
    const size = limit(c.req.query("limit"));
    const rows = await db.select().from(schema.v2Series).where(and(
      eq(schema.v2Series.underlying, market.underlying),
      expiry === undefined ? undefined : eq(schema.v2Series.expiry, expiry),
      type === undefined ? undefined : eq(schema.v2Series.isPut, type === "put"),
      statusFilter === undefined ? undefined : eq(schema.v2Series.status, statusFilter),
      cursor === undefined ? undefined : sql`(${schema.v2Series.expiry}, ${schema.v2Series.strike}, ${schema.v2Series.longId}) > (${cursor.expiry}, ${cursor.strike}, ${cursor.longId})`,
    )).orderBy(schema.v2Series.expiry, schema.v2Series.strike, schema.v2Series.longId)
      .limit(size + 1);
    const sliced = rows.slice(0, size);
    const volumes = sliced.length === 0 || asOf === null ? [] : await db.select({
      longId: schema.v2Fill.longId,
      premium: sql<string>`coalesce(sum(${schema.v2Fill.premium}), 0)::text`,
    }).from(schema.v2Fill).where(and(
      inArray(schema.v2Fill.longId, sliced.map((row) => row.longId)),
      gte(schema.v2Fill.ts, asOf - 86_400n),
    )).groupBy(schema.v2Fill.longId);
    const volumeBySeries = new Map(volumes.map((row) => [row.longId, BigInt(row.premium)]));
    const items = await Promise.all(sliced.map(async (row) => {
      const loaded = await loadBook(row.longId, now);
      const quote = loaded ? await loadQuote(loaded) : ZERO_QUOTE;
      const volume24h = volumeBySeries.get(row.longId) ?? 0n;
      return { series: seriesWire(row), quote, openInterestUnits: row.openInterestUnits.toString(), volume24h: money(volume24h) };
    }));
    // T-425. `volume24h` on every item is a window over indexed fills ending at the indexed head, so
    // the page states that head once. Note `now` above is the HOST clock and is a different thing: it
    // decides which resting orders are still live, and it is deliberately not published.
    return c.json({ items, asOf: Number(asOf ?? 0n),
      nextCursor: rows.length > size ? seriesCursorOf(sliced[sliced.length - 1]!) : null });
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
      // `id` is TEXT: lexicographic DESC only makes ties deterministic and is not a chain-order key.
      .orderBy(desc(schema.v2Fill.ts), desc(schema.v2Fill.logIndex), desc(schema.v2Fill.id))
      .limit(size + 1).offset(start);
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
    const result = await fetchFairResult({ ticker: row.ticker, underlying: row.underlying, strike: row.strike,
      expiry: Number(row.expiry), isPut: row.isPut });
    return result.quote === null
      ? c.json({ fair: null, reason: "Pricing service is unavailable.",
        ...(result.reasonCode === null ? {} : { reasonCode: result.reasonCode }),
        ...(result.provenance === null ? {} : { provenance: result.provenance }) })
      : c.json({ fair: money(result.quote.fair), iv: result.quote.iv, delta: result.quote.delta,
        source: result.quote.source, asOf: result.quote.asOf, spot: money(result.quote.spot),
        ...(result.provenance === null ? {} : { provenance: result.provenance }) });
  });
}
