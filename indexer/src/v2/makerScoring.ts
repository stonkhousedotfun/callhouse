import schema from "ponder:schema";
import { and, eq, gt, gte, inArray, lt, lte } from "ponder";
import type { Address } from "viem";

import { USDG, V2_EARN_VAULT, V2_FEE_SPLITTER, V2_MAKER_VAULT, V2_ORDER_BOOK } from "../../lib/env";
import { aggregateBook, makerKey, writeGatesFromRows, type BookOrder, type BookSeries, type FillableOrder } from "../../lib/v2/book";
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

/**
 * The protocol's own accounts are never scored, so they never hold a maker allocation.
 *
 * WHY. MakerVault credits any rise in its cash across a booked call as money the call brought back
 * (callhouse-contracts MakerVault._bookOutflow). Anyone may
 * `RewardsDistributor.claim` for any account and the claim pays that account, so a claim made on a vault's behalf in
 * the middle of such a call would be counted against its outflow cap. The contracts are not upgradeable. The off-chain
 * mitigation is sufficient: an account that never has an allocation cannot be claimed for.
 *
 * THE SET IS DERIVED, NEVER LISTED. It has three parts:
 *  - the registry's own protocol makers (MakerVault, EarnVault, FeeSplitter, from the deployment env);
 *  - every House vault the indexer enumerated from a factory (`v2HouseVault`), so the next vault is excluded the
 *    block its VaultCreated is indexed;
 *  - every account a House vault currently declares a protocol account (`v2HouseProtocolAccount`, the on-chain
 *    ProtocolAccountSet record). The latest event per (vault, account) decides.
 * A hard-coded address list would score the next vault.
 */
export function protocolMakerKeys(input: {
  registry: readonly (string | undefined)[];
  houseVaults: readonly { vault: string }[];
  protocolAccounts: readonly { vault: string; account: string; blocked: boolean; block: bigint; logIndex: number }[];
}): Set<string> {
  const keys = new Set<string>();
  for (const address of input.registry) if (address !== undefined) keys.add(makerKey(address));
  for (const row of input.houseVaults) keys.add(makerKey(row.vault));
  const latest = new Map<string, (typeof input.protocolAccounts)[number]>();
  for (const row of input.protocolAccounts) {
    const id = `${makerKey(row.vault)}:${makerKey(row.account)}`;
    const seen = latest.get(id);
    if (seen === undefined || row.block > seen.block || (row.block === seen.block && row.logIndex > seen.logIndex)) {
      latest.set(id, row);
    }
  }
  for (const row of latest.values()) if (row.blocked) keys.add(makerKey(row.account));
  return keys;
}

function stateFromRow(row: typeof schema.v2MakerEpoch.$inferSelect): MakerEpochState {
  return { maker: row.maker, epoch: row.epoch, tierBps: row.tierBps, benchmarkPolicy: row.benchmarkPolicy,
    samples: row.samples, absentSamples: row.absentSamples, validSamples: row.validSamples,
    missingReferenceSamples: row.missingReferenceSamples, twoSidedSamples: row.twoSidedSamples,
    uptimePpm: row.uptimePpm, avgSpreadBps: row.avgSpreadBps,
    depthWithin100bps: row.depthWithin100bps, depthInBand: row.depthInBand, fills: row.fills,
    volumeUsdg: row.volumeUsdg, rebatesUsdg: row.rebatesUsdg, scorePpm: row.scorePpm };
}

/**
 * What the V2Clock tick already read, after its expiry maintenance: `series` is every series with status open
 * or cutoff and `expiry > now`, `orders` every order with status open (lib/v2/clock.ts clockTick). Passing them saves
 * the two selects that would read the same rows again.
 */
export type OpenBookRows = {
  series: (typeof schema.v2Series.$inferSelect)[];
  orders: (typeof schema.v2Order.$inferSelect)[];
};

type ClockArgs = Parameters<Parameters<typeof ponder.on<"V2Clock:block">>[1]>[0];

/**
 * Called by the one V2Clock:block handler, after expiry maintenance. Ponder rejects duplicate registrations. Without
 * `open` it selects the open series and orders itself (the tests drive it that way).
 *
 * NOTHING TO SCORE RETURNS AFTER ONE READ. With no open order, no maker has a quote (`orderCounts` stays
 * empty), and with no epoch row up to this epoch there is no tier and no current row, so `enrolled`, `states` and
 * `scored` are all empty and the tick writes nothing. That is every tick of a chain nobody quotes on yet, so the other
 * five selects are skipped there.
 */
export async function scoreMakerBlock({ event, context, open }: ClockArgs & { open?: OpenBookRows }): Promise<void> {
  const now = event.block.timestamp;
  const epoch = makerWeekStartUtc(now);
  const referenceStart = now > CHAIN_REFERENCE_WINDOW_SECONDS ? now - CHAIN_REFERENCE_WINDOW_SECONDS : 0n;
  const fillStart = referenceStart < epoch ? referenceStart : epoch;
  const [seriesRows, orderRows] = open !== undefined ? [open.series, open.orders] : await Promise.all([
    context.db.sql.select().from(schema.v2Series).where(and(
      inArray(schema.v2Series.status, ["open", "cutoff"]), gt(schema.v2Series.expiry, now),
    )),
    context.db.sql.select().from(schema.v2Order).where(eq(schema.v2Order.status, "open")),
  ]);
  const epochRows = () => context.db.sql.select().from(schema.v2MakerEpoch).where(lte(schema.v2MakerEpoch.epoch, epoch));
  let quietEpochRows: (typeof schema.v2MakerEpoch.$inferSelect)[] | undefined;
  if (orderRows.length === 0) {
    quietEpochRows = await epochRows();
    if (quietEpochRows.length === 0) return;
  }
  const [marketRows, bookStateRows, historicalRows, fillRows, houseVaultRows, protocolAccountRows] = await Promise.all([
    context.db.sql.select().from(schema.v2Market),
    context.db.sql.select().from(schema.v2OrderBookState).limit(1),
    quietEpochRows ?? epochRows(),
    context.db.sql.select().from(schema.v2Fill).where(and(gte(schema.v2Fill.ts, fillStart), lt(schema.v2Fill.ts, epoch + WEEK),
      lte(schema.v2Fill.block, event.block.number))),
    context.db.sql.select().from(schema.v2HouseVault),
    context.db.sql.select().from(schema.v2HouseProtocolAccount),
  ]);
  const protocol = protocolMakerKeys({ registry: [V2_MAKER_VAULT, V2_EARN_VAULT, V2_FEE_SPLITTER],
    houseVaults: houseVaultRows, protocolAccounts: protocolAccountRows });
  const tradingPaused = bookStateRows[0]?.tradingPaused ?? false;
  const markets = new Map(marketRows.map((row) => [row.underlying.toLowerCase(), row]));
  const ordersBySeries = new Map<bigint, BookOrder[]>();
  for (const row of orderRows) {
    const list = ordersBySeries.get(row.longId) ?? [];
    list.push(row);
    ordersBySeries.set(row.longId, list);
  }
  const askWriteMakers = [...new Set(orderRows.filter((row) => row.kind === "AskWrite").map((row) => row.maker))];
  // A write ask the take would skip (book off the minter allow-list, or the writer never made the book its
  // operator; OrderBook.sol:1091, :1101) is not a quote, so it earns no uptime or depth.
  const [ledgerRows, minterRows, accountRows] = askWriteMakers.length === 0 ? [[], [], []] : await Promise.all([
    context.db.sql.select().from(schema.v2Ledger).where(inArray(schema.v2Ledger.account, askWriteMakers)),
    V2_ORDER_BOOK === undefined ? [] : context.db.sql.select().from(schema.v2Minter)
      .where(eq(schema.v2Minter.minter, V2_ORDER_BOOK.toLowerCase() as `0x${string}`)),
    context.db.sql.select().from(schema.v2Account).where(inArray(schema.v2Account.account, askWriteMakers)),
  ]);
  const gates = writeGatesFromRows(V2_ORDER_BOOK, minterRows, accountRows);
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
    // A disabled market is NOT skipped whole. `enabled` gates only mint (Clearinghouse.mint, and the book's
    // `plan.mintOpen`), so its bids and resale asks still fill; aggregateBook below withholds exactly its AskWrites
    // the same rule the served book uses.
    if (market === undefined || tradingPaused) continue;
    const asset = (row.isPut ? USDG : row.underlying).toLowerCase();
    const freeByMaker = new Map<string, bigint>();
    for (const ledger of ledgerRows) if (ledger.asset.toLowerCase() === asset) freeByMaker.set(makerKey(ledger.account), ledger.free);
    const series: BookSeries = { longId: row.longId, isPut: row.isPut, strike: row.strike, mintCutoff: row.mintCutoff,
      expiry: row.expiry, mintFeePpm: row.mintFeePpm, status: row.status };
    const book = aggregateBook({ series, orders: ordersBySeries.get(row.longId) ?? [], freeByMaker, now,
      marketEnabled: market.enabled, mintPaused: market.mintPaused, tradingPaused,
      bookIsMinter: gates.bookIsMinter, operators: gates.operators });
    const orders = [...book.bids, ...book.asks].flatMap((level) => level.orders);
    for (const order of orders) {
      const key = makerKey(order.maker);
      orderCounts.set(key, (orderCounts.get(key) ?? 0) + 1);
      addresses.set(key, order.maker);
    }
    tracked.push({ series: row, orders });
  }
  for (const row of historicalRows) addresses.set(makerKey(row.maker), row.maker);

  // A protocol account is left out before ranking, not zeroed after it: every rank is relative to the other rows.
  const enrolled = [...enrolledMakerKeys(tierByMaker, orderCounts, currentRows.keys())]
    .filter((maker) => !protocol.has(maker));

  const flowsByMaker = new Map<string, FlowTotals>();
  for (const fill of fillRows) {
    if (fill.ts < epoch || fill.ts >= epoch + WEEK) continue;
    const maker = makerKey(fill.maker);
    const old = flowsByMaker.get(maker) ?? { fills: 0, volumeUsdg: 0n, rebatesUsdg: 0n };
    flowsByMaker.set(maker, { fills: old.fills + 1, volumeUsdg: old.volumeUsdg + fill.premium,
      rebatesUsdg: old.rebatesUsdg + fill.makerRebate });
  }
  const states = new Map<string, MakerEpochState>();
  for (const [maker, row] of currentRows) if (!protocol.has(maker)) states.set(maker, stateFromRow(row));
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
  // A current-epoch row written before the account was known to be a protocol account (the vault indexed later, or a
  // ProtocolAccountSet that arrived mid-week) keeps its samples but loses its score, so it carries no allocation.
  for (const [maker, row] of currentRows) {
    if (protocol.has(maker) && row.scorePpm !== 0n) {
      await context.db.update(schema.v2MakerEpoch, { id: makerEpochId(row.maker, epoch) }).set({ scorePpm: 0n });
    }
  }
}
