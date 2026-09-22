import schema from "ponder:schema";
import { and, eq, gt, gte, inArray, lt, lte } from "ponder";
import type { Address } from "viem";

import { USDG } from "../../lib/env";
import { aggregateBook, makerKey, type BookOrder, type BookSeries, type FillableOrder } from "../../lib/v2/book";
import { makerEpochId } from "../../lib/v2/makerRegistry";
import {
  advanceMakerEpoch, emptyMakerEpoch, enrolledMakerKeys, MAKER_SCORING_POLICY,
  makerWeekStartUtc, sampleMakerSeries, scoreMakerEpochs, type FlowTotals, type MakerEpochState, type MakerSample,
} from "../../lib/v2/makerScoring";
import { v2Ponder as ponder } from "../../lib/registry";

const WEEK = 604_800n;
const CHAIN_REFERENCE_WINDOW_SECONDS = 3_600n;

/** A maker cannot set its own quality benchmark. Use only other participants' recent chain fills. */
function chainReference(fills: readonly (typeof schema.v2Fill.$inferSelect)[], longId: bigint,
  maker: string, now: bigint): bigint | null {
  let premium = 0n;
  let units = 0n;
  for (const fill of fills) {
    if (fill.longId !== longId || fill.units <= 0n || fill.ts > now
        || now - fill.ts > CHAIN_REFERENCE_WINDOW_SECONDS
        || makerKey(fill.maker) === maker || makerKey(fill.taker) === maker) continue;
    premium += fill.premium;
    units += fill.units;
  }
  return units === 0n ? null : premium * 100n / units;
}

function stateFromRow(row: typeof schema.v2MakerEpoch.$inferSelect): MakerEpochState {
  return { maker: row.maker, epoch: row.epoch, tierBps: row.tierBps, benchmarkPolicy: row.benchmarkPolicy,
    samples: row.samples, absentSamples: row.absentSamples, validSamples: row.validSamples,
    missingReferenceSamples: row.missingReferenceSamples, twoSidedSamples: row.twoSidedSamples,
    uptimePpm: row.uptimePpm, avgSpreadBps: row.avgSpreadBps,
    depthWithin100bps: row.depthWithin100bps, depthInBand: row.depthInBand, fills: row.fills,
    volumeUsdg: row.volumeUsdg, rebatesUsdg: row.rebatesUsdg, scorePpm: row.scorePpm };
}

/** Called by the one V2Clock:block handler, after expiry maintenance. Ponder rejects duplicate registrations. */
export const scoreMakerBlock: Parameters<typeof ponder.on<"V2Clock:block">>[1] = async ({ event, context }) => {
  const now = event.block.timestamp;
  const epoch = makerWeekStartUtc(now);
  const referenceStart = now > CHAIN_REFERENCE_WINDOW_SECONDS ? now - CHAIN_REFERENCE_WINDOW_SECONDS : 0n;
  const fillStart = referenceStart < epoch ? referenceStart : epoch;
  const [seriesRows, orderRows, marketRows, bookStateRows, historicalRows, fillRows] = await Promise.all([
    context.db.sql.select().from(schema.v2Series).where(and(
      inArray(schema.v2Series.status, ["open", "cutoff"]), gt(schema.v2Series.expiry, now),
    )),
    context.db.sql.select().from(schema.v2Order).where(eq(schema.v2Order.status, "open")),
    context.db.sql.select().from(schema.v2Market),
    context.db.sql.select().from(schema.v2OrderBookState).limit(1),
    context.db.sql.select().from(schema.v2MakerEpoch).where(lte(schema.v2MakerEpoch.epoch, epoch)),
    context.db.sql.select().from(schema.v2Fill).where(and(gte(schema.v2Fill.ts, fillStart), lt(schema.v2Fill.ts, epoch + WEEK),
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

  const tracked: { series: typeof schema.v2Series.$inferSelect; orders: FillableOrder[] }[] = [];
  const orderCounts = new Map<string, number>();
  const addresses = new Map<string, Address>();
  for (const row of seriesRows) {
    const market = markets.get(row.underlying.toLowerCase());
    if (market === undefined || !market.enabled || tradingPaused) continue;
    const asset = (row.isPut ? USDG : row.underlying).toLowerCase();
    const freeByMaker = new Map<string, bigint>();
    for (const ledger of ledgerRows) if (ledger.asset.toLowerCase() === asset) freeByMaker.set(makerKey(ledger.account), ledger.free);
    const series: BookSeries = { longId: row.longId, isPut: row.isPut, strike: row.strike, mintCutoff: row.mintCutoff,
      expiry: row.expiry, mintFeePpm: row.mintFeePpm, status: row.status };
    const book = aggregateBook({ series, orders: ordersBySeries.get(row.longId) ?? [], freeByMaker, now,
      marketEnabled: market.enabled, mintPaused: market.mintPaused, tradingPaused });
    const orders = [...book.bids, ...book.asks].flatMap((level) => level.orders);
    for (const order of orders) {
      const key = makerKey(order.maker);
      orderCounts.set(key, (orderCounts.get(key) ?? 0) + 1);
      addresses.set(key, order.maker);
    }
    tracked.push({ series: row, orders });
  }
  for (const row of historicalRows) addresses.set(makerKey(row.maker), row.maker);

  const enrolled = enrolledMakerKeys(tierByMaker, orderCounts, currentRows.keys());

  const flowsByMaker = new Map<string, FlowTotals>();
  for (const fill of fillRows) {
    if (fill.ts < epoch || fill.ts >= epoch + WEEK) continue;
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
    const samples: MakerSample[] = [];
    for (const item of tracked) {
      const makerOrders = item.orders.filter((order) => makerKey(order.maker) === maker);
      // No benchmark is needed to prove that an enrolled maker has no quote on either side.
      if (makerOrders.length === 0) {
        samples.push({ kind: "absent" });
        continue;
      }
      const reference = chainReference(fillRows, item.series.longId, maker, now);
      if (reference === null || reference <= 0n) {
        samples.push({ kind: "missingReference" });
        continue;
      }
      // The epoch's band, not a bare bps constant: the same policy the API publishes on the epoch object
      // has to be the one the sample was taken under, or `band` documents a measurement nobody made.
      samples.push({ kind: "valid", quality: sampleMakerSeries(makerOrders, reference, MAKER_SCORING_POLICY.band) });
    }
    const previous = states.get(maker) ?? emptyMakerEpoch(address, epoch, tierByMaker.get(maker) ?? 0);
    states.set(maker, advanceMakerEpoch(previous, samples,
      flowsByMaker.get(maker) ?? { fills: 0, volumeUsdg: 0n, rebatesUsdg: 0n }, tierByMaker.get(maker) ?? 0));
  }
  const scored = scoreMakerEpochs([...states.values()]);
  for (const row of scored) {
    const id = makerEpochId(row.maker, epoch);
    const values = { maker: makerKey(row.maker) as Address, epoch, tierBps: row.tierBps,
      benchmarkPolicy: row.benchmarkPolicy, samples: row.samples, absentSamples: row.absentSamples,
      validSamples: row.validSamples, missingReferenceSamples: row.missingReferenceSamples,
      twoSidedSamples: row.twoSidedSamples, uptimePpm: row.uptimePpm, avgSpreadBps: row.avgSpreadBps,
      depthWithin100bps: row.depthWithin100bps, depthInBand: row.depthInBand, fills: row.fills,
      volumeUsdg: row.volumeUsdg, rebatesUsdg: row.rebatesUsdg, scorePpm: row.scorePpm };
    if (currentRows.has(makerKey(row.maker))) await context.db.update(schema.v2MakerEpoch, { id }).set(values);
    else await context.db.insert(schema.v2MakerEpoch).values({ id, ...values });
  }
};
