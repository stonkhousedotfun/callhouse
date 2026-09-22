import { db } from "ponder:api";
import schema from "ponder:schema";
import type { Hono } from "hono";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, lte, sql } from "ponder";

import { V2_AUTO_ROLLER, V2_ORDER_BOOK } from "../../../lib/env";
import { eligibleStrategyPriceBand, trackedAutoRollerAskLive } from "../../../lib/v2/autoRoller";
import { fetchFairQuote } from "../../../lib/v2/pricing";
import { matchTakeFees } from "../../../lib/v2/reconcile";
import { readSpots } from "./chain";
import type { IndexedHead } from "./head";
import { address, error, limit, money, parseId, seriesWire } from "./shared";
import { readIndexedSnapshot } from "./snapshot";

export { indexedHead, type IndexedHead } from "./head";

type ActivityKind = "fill" | "settlement" | "redemption" | "roll" | "stale_cancel";

const STRATEGY_FAIR_CONCURRENCY = 8;
const STRATEGY_FAIR_PAGE_BUDGET_MS = 2_500;

function delegateApproved(raw: string | undefined, delegate: string | undefined): boolean {
  if (raw === undefined || delegate === undefined) return false;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value) &&
      (value as Record<string, unknown>)[delegate.toLowerCase()] === true;
  } catch { return false; }
}

/** Fixed worker pool with one page-wide budget: preserve completed results and abandon the rest. */
async function mapConcurrentWithin<T, R>(items: readonly T[], concurrency: number, budgetMs: number,
  map: (item: T, index: number) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const completed: { index: number; value: R }[] = [];
  let next = 0;
  let expired = false;
  const worker = async () => {
    while (!expired && next < items.length) {
      const index = next;
      next += 1;
      const value = await map(items[index]!, index);
      if (expired) return;
      completed.push({ index, value });
    }
  };
  let expire!: () => void;
  const budget = new Promise<void>((resolve) => { expire = resolve; });
  const timer = setTimeout(() => { expired = true; expire(); }, budgetMs);
  const workers = Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  await Promise.race([workers, budget]);
  expired = true;
  clearTimeout(timer);
  // A pricing implementation may ignore its own timeout. Keep its late settlement handled while
  // returning the page on budget; workers observe `expired` and never schedule another fair read.
  void workers.catch(() => undefined);
  return completed.sort((a, b) => a.index - b.index).map(({ value }) => value);
}
type Activity = {
  block: bigint; logIndex: number; id: string; kind: ActivityKind; ts: number;
  longId: string; series: ReturnType<typeof seriesWire>; accounts: string[]; data: Record<string, unknown>;
};

const cursorOf = (event: Pick<Activity, "block" | "logIndex" | "id">): string =>
  Buffer.from(JSON.stringify([event.block.toString(), event.logIndex, event.id])).toString("base64url");

function parseCursor(raw: string | undefined): { block: bigint; logIndex: number; id: string } | null {
  if (raw === undefined || raw.length > 512) return null;
  try {
    const parts: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parts) || parts.length !== 3 || typeof parts[0] !== "string" ||
      typeof parts[1] !== "number" || typeof parts[2] !== "string" ||
      !/^(0|[1-9]\d{0,18})$/.test(parts[0]) || !Number.isInteger(parts[1]) ||
      parts[1] < 0 || parts[1] > 2_147_483_647 || parts[2].length === 0 || parts[2].length > 256) return null;
    const block = BigInt(parts[0]);
    return block <= 9_223_372_036_854_775_807n ? { block, logIndex: parts[1], id: parts[2] } : null;
  } catch { return null; }
}

function compareActivity(a: Pick<Activity, "block" | "logIndex" | "id">,
  b: Pick<Activity, "block" | "logIndex" | "id">): number {
  return a.block < b.block ? -1 : a.block > b.block ? 1 :
    a.logIndex - b.logIndex || a.id.localeCompare(b.id);
}

type ActivityQuery = {
  since: bigint | null;
  kinds: ReadonlySet<ActivityKind>;
  cursor: { block: bigint; logIndex: number; id: string } | null;
  size: number;
};

/**
 * F-APP-INDEXER-09. One page of /feed/activity, read entirely at ONE indexed checkpoint.
 *
 * The page is assembled from ten independent selects across five tables. Read against a moving
 * checkpoint they can land on either side of a Ponder commit, so a page can mix two index states:
 * a row committed between two selects is ordered against a cursor derived from the other state, and
 * the next page then skips it or repeats it. The three-block safeBlock margin does not close that -
 * it bounds reorgs, not a checkpoint advance mid-route.
 *
 * `head` is supplied by readIndexedSnapshot, which re-reads the checkpoint afterwards and retries
 * the whole read if it moved. Keep every network call OUT of here for the reason /strategies keeps
 * readSpots outside: a slow oracle would otherwise burn the retries. Every read below is a db select.
 */
async function activityPage(head: IndexedHead | null, { since, kinds, cursor, size }: ActivityQuery) {
  if (head === null || head.block < 3n) return { items: [], nextCursor: null };
  const safeBlock = head.block - 3n;
  const ascending = since !== null;
  const after = (block: unknown, logIndex: unknown, id: unknown) => cursor === null ? undefined :
    ascending ? sql`(${block}, ${logIndex}, ${id}) > (${cursor.block}, ${cursor.logIndex}, ${cursor.id})` :
      sql`(${block}, ${logIndex}, ${id}) < (${cursor.block}, ${cursor.logIndex}, ${cursor.id})`;
  const events: Activity[] = [];
  const byId = new Map<string, typeof schema.v2Series.$inferSelect>();
  const addSeries = async (longIds: readonly bigint[]) => {
    const missing = [...new Set(longIds.filter((id) => !byId.has(id.toString())))];
    if (missing.length === 0) return;
    const rows = await db.select().from(schema.v2Series).where(inArray(schema.v2Series.longId, missing));
    for (const row of rows) byId.set(row.longId.toString(), row);
  };
  const keep = (ts: bigint, block: bigint) => block <= safeBlock && (since === null || ts >= since);

  const fills = kinds.has("fill") ? await db.select().from(schema.v2Fill).where(and(
    lte(schema.v2Fill.block, safeBlock),
    ...(since === null ? [] : [gte(schema.v2Fill.ts, since)]),
    after(schema.v2Fill.block, schema.v2Fill.logIndex, schema.v2Fill.id),
  )).orderBy(ascending ? asc(schema.v2Fill.block) : desc(schema.v2Fill.block),
    ascending ? asc(schema.v2Fill.logIndex) : desc(schema.v2Fill.logIndex),
    ascending ? asc(schema.v2Fill.id) : desc(schema.v2Fill.id)).limit(size + 1) : [];
  const fillTxs = [...new Set(fills.map((fill) => fill.tx))];
  const [takes, txFills] = fillTxs.length > 0 ? await Promise.all([
    db.select().from(schema.v2Take).where(inArray(schema.v2Take.tx, fillTxs)),
    db.select().from(schema.v2Fill).where(inArray(schema.v2Fill.tx, fillTxs)),
  ]) : [[], []];
  const takerFees = matchTakeFees(txFills, takes);
  await addSeries(fills.map((row) => row.longId));
  for (const row of fills) {
    if (!keep(row.ts, row.block)) continue;
    const ref = byId.get(row.longId.toString()); if (!ref) continue;
    const takerFee = takerFees.get(row.id) ?? 0n;
    events.push({ block: row.block, logIndex: row.logIndex, id: row.id, kind: "fill", ts: Number(row.ts),
      longId: row.longId.toString(), series: seriesWire(ref),
      accounts: [...new Set([row.taker, row.maker, row.recipient, row.buyer, row.seller].map(address))],
      data: { orderId: row.orderId.toString(), taker: address(row.taker), maker: address(row.maker),
        recipient: address(row.recipient),
        units: row.units.toString(), price: money(row.price), premium: money(row.premium),
        takerFee: money(takerFee), sellerFee: money(row.sellerFee), makerRebate: money(row.makerRebate),
        primary: row.primary, takerIsBuyer: row.takerIsBuyer, tx: row.tx } });
  }
  const redemptions = kinds.has("redemption") ? await db.select().from(schema.v2Redemption).where(and(
    lte(schema.v2Redemption.block, safeBlock),
    ...(since === null ? [] : [gte(schema.v2Redemption.ts, since)]),
    after(schema.v2Redemption.block, schema.v2Redemption.logIndex, schema.v2Redemption.id),
  )).orderBy(ascending ? asc(schema.v2Redemption.block) : desc(schema.v2Redemption.block),
    ascending ? asc(schema.v2Redemption.logIndex) : desc(schema.v2Redemption.logIndex),
    ascending ? asc(schema.v2Redemption.id) : desc(schema.v2Redemption.id)).limit(size + 1) : [];
  await addSeries(redemptions.map((row) => row.longId));
  for (const row of redemptions) {
    if (!keep(row.ts, row.block)) continue;
    const ref = byId.get(row.longId.toString()); if (!ref) continue;
    if (ref.settlementPrice === null) throw new Error(`Redeemed series ${row.longId} has no settlement price`);
    const collateralDecimals = ref.isPut ? 6 : 18;
    const amountDecimals = row.asset.toLowerCase() === ref.underlying.toLowerCase() ? 18 : 6;
    events.push({ block: row.block, logIndex: row.logIndex, id: row.id, kind: "redemption", ts: Number(row.ts),
      longId: row.longId.toString(), series: seriesWire(ref),
      accounts: [...new Set([row.holder, row.to].map(address))],
      data: { holder: address(row.holder), side: row.side, tokenId: row.tokenId.toString(),
        units: row.units.toString(), asset: address(row.asset), amount: money(row.amount, amountDecimals),
        amountInKind: money(row.amountInKind, collateralDecimals), settlementPrice: money(ref.settlementPrice),
        toLedger: row.toLedger, tx: row.tx } });
  }
  const rolls = kinds.has("roll") ? await db.select().from(schema.v2Roll).where(and(
    lte(schema.v2Roll.block, safeBlock),
    ...(since === null ? [] : [gte(schema.v2Roll.ts, since)]),
    after(schema.v2Roll.block, schema.v2Roll.logIndex, schema.v2Roll.id),
  )).orderBy(ascending ? asc(schema.v2Roll.block) : desc(schema.v2Roll.block),
    ascending ? asc(schema.v2Roll.logIndex) : desc(schema.v2Roll.logIndex),
    ascending ? asc(schema.v2Roll.id) : desc(schema.v2Roll.id)).limit(size + 1) : [];
  await addSeries(rolls.map((row) => row.longId));
  for (const row of rolls) {
    if (!keep(row.ts, row.block)) continue;
    const ref = byId.get(row.longId.toString()); if (!ref) continue;
    events.push({ block: row.block, logIndex: row.logIndex, id: row.id, kind: "roll", ts: Number(row.ts),
      longId: row.longId.toString(), series: seriesWire(ref), accounts: [address(row.writer)],
      data: { writer: address(row.writer), orderId: row.orderId.toString(), price: money(row.price),
        units: row.units.toString(), tx: row.tx } });
  }
  const staleCancels = kinds.has("stale_cancel") ? await db.select().from(schema.v2StaleCancel).where(and(
    lte(schema.v2StaleCancel.block, safeBlock),
    ...(since === null ? [] : [gte(schema.v2StaleCancel.ts, since)]),
    after(schema.v2StaleCancel.block, schema.v2StaleCancel.logIndex, schema.v2StaleCancel.id),
  )).orderBy(ascending ? asc(schema.v2StaleCancel.block) : desc(schema.v2StaleCancel.block),
    ascending ? asc(schema.v2StaleCancel.logIndex) : desc(schema.v2StaleCancel.logIndex),
    ascending ? asc(schema.v2StaleCancel.id) : desc(schema.v2StaleCancel.id)).limit(size + 1) : [];
  await addSeries(staleCancels.map((row) => row.longId));
  for (const row of staleCancels) {
    const ref = byId.get(row.longId.toString()); if (!ref) continue;
    events.push({ block: row.block, logIndex: row.logIndex, id: row.id, kind: "stale_cancel", ts: Number(row.ts),
      longId: row.longId.toString(), series: seriesWire(ref), accounts: [address(row.writer)],
      data: { writer: address(row.writer), orderId: row.orderId.toString(), spot: money(row.spot),
        spotUpdatedAt: Number(row.spotUpdatedAt), nextRollAfter: Number(ref.expiry), tx: row.tx } });
  }
  // The oracle can finalize well before a keeper settles each series. Anchor activity to
  // SeriesSettled so a later settlement cannot appear behind an already-issued cursor.
  const settlementId = sql<string>`${schema.v2Series.settledTx} || '-' || ${schema.v2Series.settledLogIndex}::text || '-' || ${schema.v2Series.longId}::text`;
  // Block timestamps cannot decrease on the canonical chain. Seek the earliest safe
  // settlement at or after `since`, including the earliest block in a timestamp tie,
  // so the activity index need not walk all older settlements on the first page.
  let settlementFloor: bigint | null = null;
  if (kinds.has("settlement") && since !== null) {
    const first = await db.select({ block: schema.v2Series.settledBlock }).from(schema.v2Series).where(and(
      gte(schema.v2Series.settledAt, since), isNotNull(schema.v2Series.settledBlock),
      lte(schema.v2Series.settledBlock, safeBlock),
    )).orderBy(asc(schema.v2Series.settledAt), asc(schema.v2Series.settledBlock)).limit(1);
    settlementFloor = first[0]?.block ?? null;
  }
  const settlements = kinds.has("settlement") && (since === null || settlementFloor !== null) ? await db.select().from(schema.v2Series).where(and(
    isNotNull(schema.v2Series.settledAt), isNotNull(schema.v2Series.settledBlock),
    isNotNull(schema.v2Series.settledLogIndex), isNotNull(schema.v2Series.settledTx),
    isNotNull(schema.v2Series.settlementPrice), isNotNull(schema.v2Series.longPayoutPerUnit),
    isNotNull(schema.v2Series.feePerUnit), isNotNull(schema.v2Series.shortPayoutPerUnit),
    lte(schema.v2Series.settledBlock, safeBlock),
    settlementFloor === null ? undefined : gte(schema.v2Series.settledBlock, settlementFloor),
    since === null ? undefined : gte(schema.v2Series.settledAt, since),
    after(schema.v2Series.settledBlock, schema.v2Series.settledLogIndex, settlementId),
  )).orderBy(ascending ? asc(schema.v2Series.settledBlock) : desc(schema.v2Series.settledBlock),
    ascending ? asc(schema.v2Series.settledLogIndex) : desc(schema.v2Series.settledLogIndex),
    ascending ? asc(settlementId) : desc(settlementId)).limit(size + 1) : [];
  for (const ref of settlements) {
    // SQL has already excluded incomplete or newer settlement rows.
    if (ref.settledAt === null || ref.settledBlock === null || ref.settledLogIndex === null ||
      ref.settledTx === null || ref.settlementPrice === null || ref.longPayoutPerUnit === null ||
      ref.feePerUnit === null || ref.shortPayoutPerUnit === null) continue;
    const decimals = ref.isPut ? 6 : 18;
    events.push({ block: ref.settledBlock, logIndex: ref.settledLogIndex,
      id: `${ref.settledTx}-${ref.settledLogIndex}-${ref.longId}`, kind: "settlement", ts: Number(ref.settledAt),
      longId: ref.longId.toString(), series: seriesWire(ref), accounts: [],
      data: { price: money(ref.settlementPrice), longPayoutPerUnit: money(ref.longPayoutPerUnit, decimals),
        feePerUnit: money(ref.feePerUnit, decimals), shortPayoutPerUnit: money(ref.shortPayoutPerUnit, decimals),
        tx: ref.settledTx } });
  }
  events.sort((a, b) => compareActivity(a, b) * (ascending ? 1 : -1));
  const filtered = cursor === null ? events : events.filter((event) =>
    compareActivity(event, cursor) * (ascending ? 1 : -1) > 0);
  const items = filtered.slice(0, size).map(({ block: _block, logIndex: _logIndex, ...item }) => item);
  return { items, nextCursor: filtered.length > size ? cursorOf(filtered[size - 1]!) : null };
}

export function registerMachineRoutes(app: Hono) {
  /** Wallet balances only. The OrderBook's escrow balance is never a redeemable holder. */
  app.get("/series/:longId/holders", async (c) => {
    const longId = parseId(c.req.param("longId"));
    if (longId === null) return error(c, "bad_long_id", "Series id must be a decimal integer.");
    const side = c.req.query("side") ?? "long";
    if (side !== "long" && side !== "short") return error(c, "bad_side", "Side must be long or short.");
    const cursor = c.req.query("cursor");
    if (cursor !== undefined && !/^0x[\da-fA-F]{40}$/.test(cursor))
      return error(c, "bad_cursor", "Cursor must be an EVM address.");
    const exists = await db.select({ id: schema.v2Series.longId }).from(schema.v2Series)
      .where(eq(schema.v2Series.longId, longId)).limit(1);
    if (exists.length === 0) return error(c, "series_not_found", "Series was not found.", 404);
    const size = limit(c.req.query("limit"));
    const tokenId = longId + (side === "short" ? 1n : 0n);
    const rows = await db.select().from(schema.v2Balance).where(and(
      eq(schema.v2Balance.tokenId, tokenId), gt(schema.v2Balance.units, 0n),
      ...(cursor ? [gt(schema.v2Balance.holder, cursor.toLowerCase() as `0x${string}`)] : []),
    )).orderBy(schema.v2Balance.holder).limit(size + 1);
    const items = rows.slice(0, size).map((row) => ({ holder: address(row.holder), units: row.units.toString() }));
    return c.json({ items, nextCursor: rows.length > size ? rows[size - 1]!.holder : null });
  });

  /** Active strategies drive the cranker and the pricing bot; never infer them from open orders. */
  app.get("/strategies", async (c) => {
    const size = limit(c.req.query("limit"));
    const active = c.req.query("active");
    if (active !== undefined && active !== "0" && active !== "1") return error(c, "bad_active", "active must be 0 or 1.");
    const cursor = c.req.query("cursor");
    if (cursor !== undefined && !/^0x[\da-fA-F]{40}-0x[\da-fA-F]{40}$/.test(cursor))
      return error(c, "bad_cursor", "Invalid strategy cursor.");
    const { rows, sliced, orders, series, bookState, accounts } = await readIndexedSnapshot(async () => {
      const rows = await db.select().from(schema.v2Strategy).where(and(
        ...(active === undefined ? [] : [eq(schema.v2Strategy.active, active === "1")]),
        ...(cursor ? [gt(schema.v2Strategy.id, cursor.toLowerCase())] : []),
      )).orderBy(schema.v2Strategy.id).limit(size + 1);
      const sliced = rows.slice(0, size);
      const orderIds = [...new Set(sliced.flatMap((row) => row.orderId === null ? [] : [row.orderId]))];
      const longIds = [...new Set(sliced.flatMap((row) => row.currentLongId === null ? [] : [row.currentLongId]))];
      const writers = [...new Set(sliced.map((row) => row.writer))];
      const [orders, series, bookState, accounts] = await Promise.all([
        orderIds.length === 0 ? [] : db.select().from(schema.v2Order).where(inArray(schema.v2Order.orderId, orderIds)),
        longIds.length === 0 ? [] : db.select().from(schema.v2Series).where(inArray(schema.v2Series.longId, longIds)),
        V2_ORDER_BOOK === undefined ? [] : db.select().from(schema.v2OrderBookState)
          .where(eq(schema.v2OrderBookState.id, V2_ORDER_BOOK)).limit(1),
        writers.length === 0 ? [] : db.select().from(schema.v2Account).where(inArray(schema.v2Account.account, writers)),
      ]);
      return { rows, sliced, orders, series, bookState, accounts };
    });
    // Oracle RPC is live network state, not part of Ponder's atomic checkpoint. Keep it outside
    // the retry window so a slow or failed provider cannot consume all indexed-snapshot attempts.
    const spots = await readSpots([...new Set(sliced.map((row) => row.underlying))]);
    const orderById = new Map(orders.map((row) => [row.orderId.toString(), row]));
    const seriesById = new Map(series.map((row) => [row.longId.toString(), row]));
    const accountByAddress = new Map(accounts.map((row) => [row.account.toLowerCase(), row]));
    const tradingPaused = bookState[0]?.tradingPaused ?? false;
    const fairById = new Map(await mapConcurrentWithin(series, STRATEGY_FAIR_CONCURRENCY,
      STRATEGY_FAIR_PAGE_BUDGET_MS, async (row) => {
      const quote = await fetchFairQuote({ ticker: row.ticker, underlying: row.underlying,
        strike: row.strike, expiry: Number(row.expiry), isPut: row.isPut });
      return [row.longId.toString(), quote?.fair ?? null] as const;
    }));
    const now = BigInt(Math.floor(Date.now() / 1000));
    const items = sliced.map((row) => {
      const currentOrder = row.orderId === null ? undefined : orderById.get(row.orderId.toString());
      const currentSeries = row.currentLongId === null ? undefined : seriesById.get(row.currentLongId.toString());
      const hasLiveAsk = trackedAutoRollerAskLive({ writer: row.writer, currentLongId: row.currentLongId,
        orderId: row.orderId, order: currentOrder, now });
      const currentAsk = hasLiveAsk && currentOrder !== undefined ? currentOrder.price : null;
      const spot = spots.get(row.underlying.toLowerCase())?.price ?? null;
      const band = eligibleStrategyPriceBand({ writer: row.writer, strategy: row,
        currentLongId: row.currentLongId, orderId: row.orderId, order: currentOrder,
        series: currentSeries, spot, tradingPaused,
        delegateApproved: delegateApproved(accountByAddress.get(row.writer.toLowerCase())?.delegates, V2_AUTO_ROLLER),
        now });
      const fair = row.currentLongId === null ? null : fairById.get(row.currentLongId.toString()) ?? null;
      return {
        writer: address(row.writer), underlying: address(row.underlying), ticker: row.ticker,
        strategy: {
          active: row.active, weekly: row.weekly, smartPricing: row.smartPricing,
          otmBps: row.otmBps, askBps: row.askBps, minAskBps: row.minAskBps,
          maxAskBps: row.maxAskBps, maxUnits: row.maxUnits.toString(),
        },
        currentLongId: row.currentLongId?.toString() ?? null,
        orderId: row.orderId?.toString() ?? null,
        expiry: row.expiry === null ? null : Number(row.expiry),
        lastRolledAt: row.lastRolledAt === null ? null : Number(row.lastRolledAt),
        lastStaleCancelAt: row.lastStaleCancelAt === null ? null : Number(row.lastStaleCancelAt),
        staleSpot: row.staleSpot === null ? null : money(row.staleSpot),
        pricing: {
          currentAsk: currentAsk === null ? null : money(currentAsk),
          band: band === null ? null : { min: money(band.min), max: money(band.max) },
          lastRepricedAt: row.lastRepricedAt === null ? null : Number(row.lastRepricedAt),
          lastRepricedPrice: row.lastRepricedPrice === null ? null : money(row.lastRepricedPrice),
          repriceCount: row.repriceCount,
          fair: fair === null ? null : money(fair),
        },
      };
    });
    return c.json({ items, nextCursor: rows.length > size ? rows[size - 1]!.id : null });
  });

  /** A three-block lag keeps cursor pages stable during ordinary head reorgs. */
  app.get("/feed/activity", async (c) => {
    const sinceRaw = c.req.query("since");
    if (sinceRaw !== undefined && !/^\d{1,19}$/.test(sinceRaw))
      return error(c, "bad_since", "since must be Unix seconds.");
    const since = sinceRaw === undefined ? null : BigInt(sinceRaw);
    if (since !== null && since > 9_223_372_036_854_775_807n)
      return error(c, "bad_since", "since must be Unix seconds.");
    const kindsRaw = c.req.query("kinds");
    if (kindsRaw !== undefined && kindsRaw.length > 64)
      return error(c, "bad_kinds", "kinds must list fill, settlement, redemption, roll, or stale_cancel.");
    const allowed = new Set<ActivityKind>(["fill", "settlement", "redemption", "roll", "stale_cancel"]);
    const kinds = kindsRaw ? new Set(kindsRaw.split(",") as ActivityKind[]) : allowed;
    if (kinds.size === 0 || [...kinds].some((kind) => !allowed.has(kind)))
      return error(c, "bad_kinds", "kinds must list fill, settlement, redemption, roll, or stale_cancel.");
    const cursor = parseCursor(c.req.query("cursor"));
    if (c.req.query("cursor") !== undefined && cursor === null) return error(c, "bad_cursor", "Invalid activity cursor.");
    const size = limit(c.req.query("limit"));
    // F-APP-INDEXER-09: the whole page comes from ONE indexed checkpoint. Unwrapped, the ten selects
    // inside activityPage could straddle a checkpoint advance and the resulting cursor page could
    // skip or duplicate an item. readIndexedSnapshot retries, then answers 503 snapshot_changing
    // rather than serving a mixed page - the same contract /strategies already exposes.
    return c.json(await readIndexedSnapshot((head) => activityPage(head, { since, kinds, cursor, size })));
  });
}
