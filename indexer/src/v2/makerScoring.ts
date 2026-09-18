import schema from "ponder:schema";
import { and, eq, gt, gte, inArray, lt, lte } from "ponder";
import type { Address } from "viem";

import { USDG } from "../../lib/env";
import { aggregateBook, makerKey, type BookOrder, type BookSeries, type FillableOrder } from "../../lib/v2/book";
import { makerEpochId } from "../../lib/v2/makerRegistry";
import {
  advanceMakerEpoch, emptyMakerEpoch, enrolledMakerKeys, FAIR_BAND_BPS, MAX_FAIR_AGE_SECONDS,
  makerWeekStartUtc, sampleMakerSeries, scoreMakerEpochs, type FlowTotals, type MakerEpochState, type MakerQuality,
} from "../../lib/v2/makerScoring";
import { fetchFairQuote } from "../../lib/v2/pricing";
import { v2Ponder as ponder } from "../../lib/registry";

const WEEK = 604_800n;

function stateFromRow(row: typeof schema.v2MakerEpoch.$inferSelect): MakerEpochState {
  return { maker: row.maker, epoch: row.epoch, tierBps: row.tierBps, samples: row.samples,
    twoSidedSamples: row.twoSidedSamples, uptimePpm: row.uptimePpm, avgSpreadBps: row.avgSpreadBps,
    depthWithin100bps: row.depthWithin100bps, fills: row.fills, volumeUsdg: row.volumeUsdg,
    rebatesUsdg: row.rebatesUsdg, scorePpm: row.scorePpm };
}

/** Called by the one V2Clock:block handler, after expiry maintenance. Ponder rejects duplicate registrations. */
export const scoreMakerBlock: Parameters<typeof ponder.on<"V2Clock:block">>[1] = async ({ event, context }) => {
  const now = event.block.timestamp;
  const epoch = makerWeekStartUtc(now);
  const [seriesRows, orderRows, marketRows, bookStateRows, historicalRows, fillRows] = await Promise.all([
    context.db.sql.select().from(schema.v2Series).where(and(
      inArray(schema.v2Series.status, ["open", "cutoff"]), gt(schema.v2Series.expiry, now),
    )),
    context.db.sql.select().from(schema.v2Order).where(eq(schema.v2Order.status, "open")),
    context.db.sql.select().from(schema.v2Market),
    context.db.sql.select().from(schema.v2OrderBookState).limit(1),
    context.db.sql.select().from(schema.v2MakerEpoch).where(lte(schema.v2MakerEpoch.epoch, epoch)),
    context.db.sql.select().from(schema.v2Fill).where(and(gte(schema.v2Fill.ts, epoch), lt(schema.v2Fill.ts, epoch + WEEK),
      lte(schema.v2Fill.block, event.block.number))),
  ]);
  const tradingPaused = bookStateRows[0]?.tradingPaused ?? false;
  const markets = new Map(marketRows.map((row) => [row.underlying.toLowerCase(), row]));
  const ordersBySeries = new Map<bigint, BookOrder[]>();
  for (const row of orderRows) {
    const list = ordersBySeries.get(row.longId) ?? [];
    list.push(row);
    ordersBySeries.set(row.longId, list);
  }
  const askWriteMakers = [...new Set(orderRows.filter((row) => row.kind === "AskWrite").map((row) => row.maker))];
  const ledgerRows = askWriteMakers.length === 0 ? [] : await context.db.sql.select().from(schema.v2Ledger)
    .where(inArray(schema.v2Ledger.account, askWriteMakers));
  const currentRows = new Map<string, typeof schema.v2MakerEpoch.$inferSelect>();
  const tierByMaker = new Map<string, number>();
  for (const row of historicalRows.sort((a, b) => a.epoch < b.epoch ? -1 : a.epoch > b.epoch ? 1 : 0)) {
    const key = makerKey(row.maker);
    tierByMaker.set(key, row.tierBps);
    if (row.epoch === epoch) currentRows.set(key, row);
  }

  const tracked: { series: typeof schema.v2Series.$inferSelect; orders: FillableOrder[]; fair: bigint | null }[] = [];
  const orderCounts = new Map<string, number>();
  const addresses = new Map<string, Address>();
  for (const row of seriesRows) {
    const market = markets.get(row.underlying.toLowerCase());
    if (market === undefined) continue;
    const asset = (row.isPut ? USDG : row.underlying).toLowerCase();
    const freeByMaker = new Map<string, bigint>();
    for (const ledger of ledgerRows) if (ledger.asset.toLowerCase() === asset) freeByMaker.set(makerKey(ledger.account), ledger.free);
    const series: BookSeries = { longId: row.longId, isPut: row.isPut, strike: row.strike, mintCutoff: row.mintCutoff,
      expiry: row.expiry, mintFeePpm: row.mintFeePpm, status: row.status };
    const book = aggregateBook({ series, orders: ordersBySeries.get(row.longId) ?? [], freeByMaker, now,
      marketEnabled: market.enabled, mintPaused: market.mintPaused, tradingPaused });
    const orders = [...book.bids, ...book.asks].flatMap((level) => level.orders);
    if (orders.length === 0) continue;
    for (const order of orders) {
      const key = makerKey(order.maker);
      orderCounts.set(key, (orderCounts.get(key) ?? 0) + 1);
      addresses.set(key, order.maker);
    }
    tracked.push({ series: row, orders, fair: null });
  }
  for (const row of historicalRows) addresses.set(makerKey(row.maker), row.maker);

  // Cap concurrent pricing requests: one process indexes every market and must not flood K2-02.
  for (let i = 0; i < tracked.length; i += 8) {
    await Promise.all(tracked.slice(i, i + 8).map(async (item) => {
      const fair = await fetchFairQuote({ ticker: item.series.ticker, strike: item.series.strike,
        expiry: Number(item.series.expiry), isPut: item.series.isPut });
      if (fair !== null && fair.fair > 0n && now >= BigInt(fair.asOf)
          && now - BigInt(fair.asOf) <= MAX_FAIR_AGE_SECONDS) item.fair = fair.fair;
    }));
  }

  const enrolled = enrolledMakerKeys(tierByMaker, orderCounts, currentRows.keys());

  const flowsByMaker = new Map<string, FlowTotals>();
  for (const fill of fillRows) {
    const maker = makerKey(fill.maker);
    const old = flowsByMaker.get(maker) ?? { fills: 0, volumeUsdg: 0n, rebatesUsdg: 0n };
    flowsByMaker.set(maker, { fills: old.fills + 1, volumeUsdg: old.volumeUsdg + fill.premium,
      rebatesUsdg: old.rebatesUsdg + fill.makerRebate });
  }
  const states = new Map<string, MakerEpochState>();
  for (const [maker, row] of currentRows) states.set(maker, stateFromRow(row));
  for (const maker of enrolled) {
    const address = addresses.get(maker);
    if (address === undefined) continue;
    const observations: MakerQuality[] = [];
    for (const item of tracked) {
      if (item.fair === null) continue; // a pricing outage cannot count as maker downtime
      observations.push(sampleMakerSeries(item.orders.filter((order) => makerKey(order.maker) === maker), item.fair, FAIR_BAND_BPS));
    }
    const previous = states.get(maker) ?? emptyMakerEpoch(address, epoch, tierByMaker.get(maker) ?? 0);
    states.set(maker, advanceMakerEpoch(previous, observations,
      flowsByMaker.get(maker) ?? { fills: 0, volumeUsdg: 0n, rebatesUsdg: 0n }, tierByMaker.get(maker) ?? 0));
  }
  const scored = scoreMakerEpochs([...states.values()]);
  for (const row of scored) {
    const id = makerEpochId(row.maker, epoch);
    const values = { maker: makerKey(row.maker) as Address, epoch, tierBps: row.tierBps, samples: row.samples,
      twoSidedSamples: row.twoSidedSamples, uptimePpm: row.uptimePpm, avgSpreadBps: row.avgSpreadBps,
      depthWithin100bps: row.depthWithin100bps, fills: row.fills, volumeUsdg: row.volumeUsdg,
      rebatesUsdg: row.rebatesUsdg, scorePpm: row.scorePpm };
    if (currentRows.has(makerKey(row.maker))) await context.db.update(schema.v2MakerEpoch, { id }).set(values);
    else await context.db.insert(schema.v2MakerEpoch).values({ id, ...values });
  }
};
