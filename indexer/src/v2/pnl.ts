import { and, asc, eq, gt, gte, lte } from "ponder";
import schema from "ponder:schema";
import type { Address } from "viem";

import { USDG, V2_ORDER_BOOK, V2_START_BLOCK } from "../../lib/env";
import type { DB } from "../../lib/indexing";
import { v2Ponder as ponder } from "../../lib/registry";
import { consumeFifo, payoutValueUsdg } from "../../lib/v2/fifo";
import { fairAtFill, isOffMarket, nearbyVwap } from "../../lib/v2/integrity";
import { buyPosition, closePosition, emptyPosition, isExcludedFromLeaderboard, markTransferIn, redeemPosition, sellPosition, transferOutPosition } from "../../lib/v2/pnl";
import { fetchFairQuote } from "../../lib/v2/pricing";
import { matchDeliveries, matchTakeFees } from "../../lib/v2/reconcile";
import { rankTotals, windowStarts } from "../../lib/v2/windows";
import { assignedValue, collateralValue, primaryPremiumReceived } from "../../lib/v2/writer";

const address = (value: string): Address => value.toLowerCase() as Address;
const positionId = (longId: bigint, holder: Address) => `${longId}-${address(holder)}`;
const lotId = (longId: bigint, holder: Address, seq: number) => `${longId}-${address(holder)}-${seq}`;

async function position(db: DB, longId: bigint, holder: Address) {
  const id = positionId(longId, holder);
  return await db.find(schema.v2PositionPnl, { id }) ??
    await db.insert(schema.v2PositionPnl).values({ id, longId, holder: address(holder), ...emptyPosition() });
}

async function savePosition(db: DB, longId: bigint, holder: Address,
  values: ReturnType<typeof buyPosition>) {
  await position(db, longId, holder);
  await db.update(schema.v2PositionPnl, { id: positionId(longId, holder) }).set(values);
}

async function addLot(db: DB, longId: bigint, holder: Address, units: bigint, cost: bigint,
  source: "fill" | "transfer" | "mint", sourceId: string, at: bigint) {
  if (units <= 0n || cost < 0n) throw new Error(`invalid lot ${sourceId}`);
  const previous = await db.sql.select({ seq: schema.v2Lot.seq }).from(schema.v2Lot)
    .where(and(eq(schema.v2Lot.longId, longId), eq(schema.v2Lot.holder, address(holder))))
    .orderBy(asc(schema.v2Lot.seq));
  const seq = previous.length === 0 ? 0 : previous[previous.length - 1]!.seq + 1;
  await db.insert(schema.v2Lot).values({
    id: lotId(longId, holder, seq), longId, holder: address(holder), seq,
    units, unitsRemaining: units, costUsdg: cost, costRemainingUsdg: cost,
    acquiredAt: at, source, sourceId,
  });
}

async function consume(db: DB, longId: bigint, holder: Address, units: bigint) {
  const lots = await db.sql.select().from(schema.v2Lot).where(and(
    eq(schema.v2Lot.longId, longId), eq(schema.v2Lot.holder, address(holder)), gt(schema.v2Lot.unitsRemaining, 0n),
  )).orderBy(asc(schema.v2Lot.seq));
  const result = consumeFifo(lots, units);
  for (const { lot, units: taken, costUsdg } of result.consumed) {
    await db.update(schema.v2Lot, { id: lot.id }).set({
      unitsRemaining: lot.unitsRemaining - taken,
      costRemainingUsdg: lot.costRemainingUsdg - costUsdg,
    });
  }
  return result;
}

async function maybeClose(db: DB, longId: bigint, holder: Address, at: bigint, tx: `0x${string}`) {
  const remaining = await db.sql.select({ id: schema.v2Lot.id }).from(schema.v2Lot).where(and(
    eq(schema.v2Lot.longId, longId), eq(schema.v2Lot.holder, address(holder)), gt(schema.v2Lot.unitsRemaining, 0n),
  )).limit(1);
  if (remaining.length !== 0) return;
  const current = await position(db, longId, holder);
  if (current.closedAt !== null ||
      (current.unitsBought === 0n && current.unitsTransferredOut === 0n &&
       current.unitsSold === 0n && current.unitsRedeemed === 0n)) return;
  const closed = closePosition(current, at);
  await db.update(schema.v2PositionPnl, { id: current.id }).set({ ...closed, closedTx: tx });
  await refreshRanks(db, holder, at);
}

async function writerStats(db: DB, writer: Address, ts: bigint,
  delta: { premium?: bigint; collateral?: bigint; assigned?: bigint }) {
  for (const [window, start] of Object.entries(windowStarts(ts)) as ["week" | "month" | "all", bigint][]) {
    const id = `${window}-${start}-${address(writer)}`;
    const current = await db.find(schema.v2WriterStats, { id });
    const values = {
      premiumUsdg: (current?.premiumUsdg ?? 0n) + (delta.premium ?? 0n),
      collateralUsdg: (current?.collateralUsdg ?? 0n) + (delta.collateral ?? 0n),
      assignedUsdg: (current?.assignedUsdg ?? 0n) + (delta.assigned ?? 0n),
      realisedYieldUsdg: (current?.realisedYieldUsdg ?? 0n) + (delta.premium ?? 0n) - (delta.assigned ?? 0n),
      updatedAt: ts,
    };
    await db.insert(schema.v2WriterStats).values({ id, writer: address(writer), window, windowStart: start, ...values })
      .onConflictDoUpdate(values);
  }
}

async function refreshRanks(db: DB, holder: Address, at: bigint) {
  const closed = await db.sql.select().from(schema.v2PositionPnl).where(and(
    eq(schema.v2PositionPnl.holder, address(holder)), gte(schema.v2PositionPnl.closedAt, 0n),
  ));
  const starts = windowStarts(at);
  for (const [window, start] of Object.entries(starts) as ["week" | "month" | "all", bigint][]) {
    const relevant = closed.filter((row) => row.closedAt !== null && row.closedAt >= start && row.closedAt <= at);
    const totals = rankTotals(relevant.map((row) => ({
      id: row.id, closedAt: row.closedAt!, multiplePpm: row.multiplePpm,
      realisedUsdg: row.realisedUsdg, excluded: isExcludedFromLeaderboard(row),
    })));
    const id = `${window}-${start}-${address(holder)}`;
    const values = { ...totals, updatedAt: at };
    await db.insert(schema.v2Leaderboard).values({ id, window, windowStart: start, holder: address(holder), ...values })
      .onConflictDoUpdate(values);
    if (window === "all") {
      const account = await db.find(schema.v2Account, { account: address(holder) });
      if (account !== null) await db.update(schema.v2Account, { account: address(holder) }).set({
        wins: totals.wins, losses: totals.losses, streak: totals.streak,
        bestStreak: Math.max(account.bestStreak, totals.streak), realisedUsdg: relevant.reduce((sum, row) => sum + row.realisedUsdg, 0n),
      });
    }
  }
}

/** Pricing service responses from a current quote cannot validate a historical backfill fill. */
async function priceReference(db: DB, fill: typeof schema.v2Fill.$inferSelect,
  series: typeof schema.v2Series.$inferSelect): Promise<{ fair: bigint | null; spot: bigint | null }> {
  const quote = await fetchFairQuote({
    ticker: series.ticker, strike: series.strike, expiry: Number(series.expiry), isPut: series.isPut,
  });
  const fair = quote === null ? null : fairAtFill({ fair: quote.fair, asOf: BigInt(quote.asOf) }, fill.ts);
  if (fair !== null) return { fair, spot: quote!.spot };
  const nearby = await db.sql.select({
    taker: schema.v2Fill.taker, ts: schema.v2Fill.ts,
    units: schema.v2Fill.units, premium: schema.v2Fill.premium,
  }).from(schema.v2Fill).where(and(
    eq(schema.v2Fill.longId, fill.longId),
    gte(schema.v2Fill.ts, fill.ts - 3600n), lte(schema.v2Fill.ts, fill.ts + 3600n),
  ));
  return { fair: nearbyVwap(nearby, fill.taker, fill.ts), spot: null };
}

async function handleFill(db: DB, fill: typeof schema.v2Fill.$inferSelect, takerFee: bigint) {
  const series = await db.find(schema.v2Series, { longId: fill.longId });
  if (series === null) throw new Error(`fill ${fill.id}: unknown series`);
  const { fair, spot } = await priceReference(db, fill, series);
  if (fair !== null) await db.update(schema.v2Fill, { id: fill.id }).set({ fairAtFill: fair });
  const offMarket = isOffMarket(fill.price, fair);
  const selfFill = address(fill.maker) === address(fill.taker);
  if (!fill.primary) {
    const consumed = await consume(db, fill.longId, fill.seller, fill.units);
    const proceeds = fill.premium - fill.sellerFee + (address(fill.seller) === address(fill.maker) ? fill.makerRebate : 0n)
      - (address(fill.seller) === address(fill.taker) ? takerFee : 0n);
    const current = await position(db, fill.longId, fill.seller);
    await db.update(schema.v2Fill, { id: fill.id }).set({ realisedDeltaUsdg: proceeds - consumed.costUsdg });
    await savePosition(db, fill.longId, fill.seller,
      sellPosition({ ...current, selfFill: current.selfFill || selfFill, offMarket: current.offMarket || offMarket },
        fill.units, proceeds, consumed.costUsdg, consumed.transferIn));
    await maybeClose(db, fill.longId, fill.seller, fill.ts, fill.tx);
  }
  if (fill.primary) {
    const premium = primaryPremiumReceived(fill.premium, fill.sellerFee, fill.makerRebate, takerFee,
      address(fill.seller) === address(fill.maker), address(fill.seller) === address(fill.taker));
    await writerStats(db, fill.seller, fill.ts, { premium });
    const id = positionId(fill.longId, fill.seller);
    const currentPremium = await db.find(schema.v2WriterSeriesPremium, { id });
    await db.insert(schema.v2WriterSeriesPremium).values({ id, longId: fill.longId,
      writer: address(fill.seller), premiumUsdg: (currentPremium?.premiumUsdg ?? 0n) + premium })
      .onConflictDoUpdate({ premiumUsdg: (currentPremium?.premiumUsdg ?? 0n) + premium });
  }
  const buyerCost = fill.premium + (address(fill.buyer) === address(fill.taker) ? takerFee : 0n)
    - (address(fill.buyer) === address(fill.maker) ? fill.makerRebate : 0n);
  if (buyerCost < 0n) throw new Error(`fill ${fill.id}: negative buyer cost`);
  await addLot(db, fill.longId, fill.buyer, fill.units, buyerCost, "fill", fill.id, fill.ts);
  const current = await position(db, fill.longId, fill.buyer);
  await savePosition(db, fill.longId, fill.buyer, buyPosition(current, fill.units, buyerCost, selfFill, offMarket));
  if (current.unitsBought === 0n && current.spotAtEntry === null && spot !== null) await db.update(schema.v2PositionPnl, { id: current.id })
    .set({ spotAtEntry: spot });
  if (current.closedAt !== null) await refreshRanks(db, fill.buyer, fill.ts);
}

/** Every tick processes complete transactions through its block, once. Ponder's block event
 * checkpoint sorts after all logs in that block, so Taken and delivery logs are already stored. */
ponder.on("V2PnlClock:block", async ({ event, context }) => {
  const db = context.db;
  const current = await db.find(schema.v2PnlCursor, { id: "global" });
  const from = current?.block ?? BigInt(V2_START_BLOCK! - 1);
  const through = event.block.number;
  if (through <= from) return;
  const transfers = await db.sql.select().from(schema.v2Transfer).where(and(gt(schema.v2Transfer.block, from), lte(schema.v2Transfer.block, through)));
  const fills = await db.sql.select().from(schema.v2Fill).where(and(gt(schema.v2Fill.block, from), lte(schema.v2Fill.block, through)));
  const takes = await db.sql.select().from(schema.v2Take).where(and(gt(schema.v2Take.block, from), lte(schema.v2Take.block, through)));
  const mints = await db.sql.select().from(schema.v2Mint).where(and(gt(schema.v2Mint.block, from), lte(schema.v2Mint.block, through)));
  const closes = await db.sql.select().from(schema.v2Close).where(and(gt(schema.v2Close.block, from), lte(schema.v2Close.block, through)));
  const redemptions = await db.sql.select().from(schema.v2Redemption).where(and(gt(schema.v2Redemption.block, from), lte(schema.v2Redemption.block, through)));

  const { matchedTransfers, matchedMints } = matchDeliveries(transfers, fills, mints,
    [...closes.map((row) => ({ id: row.id, tx: row.tx, longId: row.longId, holder: row.account,
      units: row.units, logIndex: row.logIndex })),
    ...redemptions.filter((row) => row.side === "long").map((row) => ({ id: row.id, tx: row.tx,
      longId: row.longId, holder: row.holder, units: row.units, logIndex: row.logIndex }))], V2_ORDER_BOOK!);
  const fees = matchTakeFees(fills, takes);
  const events = [
    ...transfers.map((row) => ({ kind: "transfer" as const, row })),
    ...fills.map((row) => ({ kind: "fill" as const, row })),
    ...mints.map((row) => ({ kind: "mint" as const, row })),
    ...closes.map((row) => ({ kind: "close" as const, row })),
    ...redemptions.map((row) => ({ kind: "redeem" as const, row })),
  ].sort((a, b) => a.row.block < b.row.block ? -1 : a.row.block > b.row.block ? 1 :
    a.row.logIndex - b.row.logIndex || a.row.id.localeCompare(b.row.id));

  for (const item of events) {
    if (item.kind === "fill") {
      const row = item.row;
      await handleFill(db, row, fees.get(row.id) ?? 0n);
    } else if (item.kind === "mint") {
      const row = item.row;
      const series = await db.find(schema.v2Series, { longId: row.longId });
      if (series === null) throw new Error(`mint ${row.id}: unknown series`);
      await writerStats(db, row.writer, row.ts, {
        collateral: collateralValue(row.units, series.strike, series.isPut),
      });
      if (matchedMints.has(row.id)) continue;
      await addLot(db, row.longId, row.longTo, row.units, 0n, "mint", row.id, row.ts);
      const previous = await position(db, row.longId, row.longTo);
      await savePosition(db, row.longId, row.longTo, markTransferIn(previous));
      if (previous.closedAt !== null) await refreshRanks(db, row.longTo, row.ts);
    } else if (item.kind === "transfer") {
      const row = item.row;
      if (matchedTransfers.has(row.id) || row.units === 0n) continue;
      if (address(row.from) === address(V2_ORDER_BOOK!) || address(row.to) === address(V2_ORDER_BOOK!)) continue;
      const zero = "0x0000000000000000000000000000000000000000";
      if (address(row.from) !== zero) {
        const spent = await consume(db, row.longId, row.from, row.units);
        const previous = await position(db, row.longId, row.from);
        await savePosition(db, row.longId, row.from, transferOutPosition(previous, row.units));
        if (spent.transferIn) await savePosition(db, row.longId, row.from,
          markTransferIn(await position(db, row.longId, row.from)));
        await maybeClose(db, row.longId, row.from, row.ts, row.tx);
      }
      if (address(row.to) !== zero) {
        await addLot(db, row.longId, row.to, row.units, 0n,
          address(row.from) === zero ? "mint" : "transfer", row.id, row.ts);
        if (address(row.from) !== zero) {
          const previous = await position(db, row.longId, row.to);
          await savePosition(db, row.longId, row.to, markTransferIn(previous));
          if (previous.closedAt !== null) await refreshRanks(db, row.to, row.ts);
        }
      }
    } else if (item.kind === "close") {
      const row = item.row;
      const spent = await consume(db, row.longId, row.account, row.units);
      const previous = await position(db, row.longId, row.account);
      await db.update(schema.v2Close, { id: row.id }).set({ realisedDeltaUsdg: -spent.costUsdg });
      await savePosition(db, row.longId, row.account,
        sellPosition(previous, row.units, 0n, spent.costUsdg, true));
      await maybeClose(db, row.longId, row.account, row.ts, row.tx);
    } else if (item.kind === "redeem" && item.row.side === "short") {
      const row = item.row;
      const series = await db.find(schema.v2Series, { longId: row.longId });
      if (series === null || series.settlementPrice === null) throw new Error(`short redemption ${row.id}: unsettled series`);
      const payout = payoutValueUsdg(row.amount, series.settlementPrice, address(row.asset) === address(USDG));
      await writerStats(db, row.holder, row.ts, {
        assigned: assignedValue(row.units, series.strike, series.settlementPrice, series.isPut, payout),
      });
    } else if (item.kind === "redeem" && item.row.side === "long") {
      const row = item.row;
      const spent = await consume(db, row.longId, row.holder, row.units);
      const series = await db.find(schema.v2Series, { longId: row.longId });
      if (series === null || series.settlementPrice === null) throw new Error(`redemption ${row.id}: unsettled series`);
      const payout = payoutValueUsdg(row.amount, series.settlementPrice, address(row.asset) === address(USDG));
      const previous = await position(db, row.longId, row.holder);
      await db.update(schema.v2Redemption, { id: row.id }).set({ realisedDeltaUsdg: payout - spent.costUsdg });
      await savePosition(db, row.longId, row.holder,
        redeemPosition(previous, row.units, payout, spent.costUsdg, spent.transferIn));
      await maybeClose(db, row.longId, row.holder, row.ts, row.tx);
    }
  }
  await db.insert(schema.v2PnlCursor).values({ id: "global", block: through }).onConflictDoUpdate({ block: through });
});
