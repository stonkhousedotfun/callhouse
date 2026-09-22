import { and, desc, eq, isNull, lt } from "ponder";
import schema from "ponder:schema";

import { v2Ponder as ponder } from "../../lib/registry";
import { recordHouseFills } from "./houseVault";
import { scheduledFeeColumns, type OrderBookFees } from "../../lib/v2/fees";
import { V2_REGISTRY } from "../../lib/v2/marketRegistry.generated";
import {
  cancelOrder, fillOrder, fillParties, orderKind, orderValidUntil, placeOrder, replacementPredecessor, withDelegate,
} from "../../lib/v2/orderBook";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const addressKey = <T extends string>(address: T): T => address.toLowerCase() as T;

const initialFees: OrderBookFees = {
  premiumFeeBps: V2_REGISTRY.fees.premiumFeeBps,
  resaleFeeBps: V2_REGISTRY.fees.resaleFeeBps,
  takerFeeFlat: BigInt(V2_REGISTRY.fees.takerFeeFlat),
  takerFeeCapBps: V2_REGISTRY.fees.takerFeeCapBps,
  makerRebateBps: V2_REGISTRY.fees.makerRebateBps,
};

/** Orders are log-derived. ERC-1155 escrow movements are reduced by clearinghouse.ts only. */

ponder.on("OrderBook:OrderPlaced", async ({ event, context }) => {
  const { orderId, maker, longId, kind: rawKind, price, units, validUntil } = event.args;
  const series = await context.db.find(schema.v2Series, { longId });
  if (series === null) throw new Error(`Order ${orderId}: unknown series ${longId}`);
  const kind = orderKind(Number(rawKind));
  const initial = placeOrder(units);

  await context.db.insert(schema.v2Order).values({
    orderId, maker, longId, kind, price, units: initial.units, filled: initial.filled,
    validUntil: orderValidUntil(kind, BigInt(validUntil), series.mintCutoff, series.expiry),
    status: initial.status, placedAt: event.block.timestamp, placedBlock: event.block.number,
    placedTx: event.transaction.hash, updatedAt: event.block.timestamp,
  });

  // replace() has no distinct event. It emits Cancelled then Placed in the same transaction.
  // Persisted cancellation provenance makes this work across restarts and replays.
  const candidates = await context.db.sql.select().from(schema.v2Order).where(and(
    eq(schema.v2Order.maker, maker), eq(schema.v2Order.longId, longId),
    eq(schema.v2Order.status, "cancelled"), eq(schema.v2Order.cancelledTx, event.transaction.hash),
    lt(schema.v2Order.cancelledLogIndex, event.log.logIndex), isNull(schema.v2Order.replacedBy),
  )).orderBy(desc(schema.v2Order.cancelledLogIndex)).limit(1);
  const predecessor = replacementPredecessor(candidates, {
    maker, longId, tx: event.transaction.hash, logIndex: event.log.logIndex,
  });
  if (predecessor !== null) {
    await context.db.update(schema.v2Order, { orderId: predecessor }).set({ replacedBy: orderId });
  }
});

ponder.on("OrderBook:OrderFilled", async ({ event, context }) => {
  const { orderId, longId, taker, maker, units, price, premium, sellerFee, makerRebate, primary, takerIsBuyer, recipient } = event.args;
  const order = await context.db.find(schema.v2Order, { orderId });
  if (order === null || order.longId !== longId || order.maker.toLowerCase() !== maker.toLowerCase()) {
    throw new Error(`OrderFilled ${orderId}: missing or inconsistent order`);
  }
  const next = fillOrder(order, units);
  await context.db.update(schema.v2Order, { orderId }).set({
    filled: next.filled, status: next.status, updatedAt: event.block.timestamp,
  });

  const { buyer, seller } = fillParties(maker, taker, recipient, takerIsBuyer);
  await context.db.insert(schema.v2Fill).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    orderId, longId, maker, taker, recipient, units, price, premium, sellerFee, makerRebate,
    primary, takerIsBuyer, buyer, seller,
    ts: event.block.timestamp, block: event.block.number, logIndex: event.log.logIndex,
    tx: event.transaction.hash,
  });

  const series = await context.db.find(schema.v2Series, { longId });
  if (series === null) throw new Error(`OrderFilled ${orderId}: unknown series ${longId}`);
  await context.db.update(schema.v2Series, { longId }).set({
    volumeUnits: series.volumeUnits + units,
    volumeUsdg: series.volumeUsdg + premium,
    lastPrice: price,
  });
  const market = await context.db.find(schema.v2Market, { underlying: series.underlying });
  if (market === null) throw new Error(`OrderFilled ${orderId}: unknown market ${series.underlying}`);
  await context.db.update(schema.v2Market, { underlying: series.underlying }).set({
    volumeUnits: market.volumeUnits + units,
    volumeUsdg: market.volumeUsdg + premium,
    premiumUsdg: market.premiumUsdg + (primary ? premium : 0n),
    feesUsdg: market.feesUsdg + sellerFee - makerRebate,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  /**
   * F-APP-INDEXER-03. `recordHouseFills` existed, was exported, and was called by NOTHING: the whole
   * repository held exactly one occurrence of the name, its own definition. So `v2_house_fill` was
   * silently always empty wherever House fills happened, with no error of any kind, and Ponder has no
   * partial replay — recovery is a full re-index.
   *
   * IT BELONGS HERE, not in a dedicated House source. `OrderBook:OrderFilled` is a core, always-registered
   * event; the House sources are behind the V2_HOUSE_VAULT_FACTORY gate. A House-sourced hook would miss
   * every fill wherever that gate is off, which is the same silence in a new place. `recordHouseFills`
   * already decides for itself whether either party is a known House vault and writes nothing when neither
   * is, so calling it unconditionally is correct and costs one lookup per side on a non-House fill.
   */
  await recordHouseFills(event, context.db);
});

ponder.on("OrderBook:OrderCancelled", async ({ event, context }) => {
  const { orderId, unitsRemaining, pruned } = event.args;
  const order = await context.db.find(schema.v2Order, { orderId });
  if (order === null) throw new Error(`OrderCancelled ${orderId}: unknown order`);
  const next = cancelOrder(order, unitsRemaining, pruned);
  await context.db.update(schema.v2Order, { orderId }).set({
    status: next.status, updatedAt: event.block.timestamp,
    cancelledTx: event.transaction.hash, cancelledLogIndex: event.log.logIndex,
  });
});

ponder.on("OrderBook:Taken", async ({ event, context }) => {
  const { taker, longId, buying, units, premium, takerFee } = event.args;
  await context.db.insert(schema.v2Take).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    taker, longId, buying, units, premium, takerFee,
    ts: event.block.timestamp, block: event.block.number,
    logIndex: event.log.logIndex, tx: event.transaction.hash,
  });
  const series = await context.db.find(schema.v2Series, { longId });
  if (series === null) throw new Error(`Taken: unknown series ${longId}`);
  const market = await context.db.find(schema.v2Market, { underlying: series.underlying });
  if (market === null) throw new Error(`Taken: unknown market ${series.underlying}`);
  await context.db.update(schema.v2Market, { underlying: series.underlying }).set({
    feesUsdg: market.feesUsdg + takerFee,
    lastBlock: event.block.number, lastTimestamp: event.block.timestamp,
  });
});

ponder.on("OrderBook:DelegateSet", async ({ event, context }) => {
  const { maker, delegate, approved } = event.args;
  const current = await context.db.find(schema.v2Account, { account: maker });
  if (current === null) {
    await context.db.insert(schema.v2Account).values({
      account: maker, delegates: withDelegate("{}", delegate, approved),
      firstSeen: event.block.timestamp, lastSeen: event.block.timestamp,
    });
  } else {
    await context.db.update(schema.v2Account, { account: maker }).set({
      delegates: withDelegate(current.delegates, delegate, approved), lastSeen: event.block.timestamp,
    });
  }
});

ponder.on("OrderBook:FeeParamsSet", async ({ event, context }) => {
  const { params } = event.args;
  const values = {
    premiumFeeBps: Number(params.premiumFeeBps),
    resaleFeeBps: Number(params.resaleFeeBps),
    takerFeeFlat: BigInt(params.takerFeeFlat),
    takerFeeCapBps: Number(params.takerFeeCapBps),
    makerRebateBps: Number(params.makerRebateBps),
    updatedAt: event.block.timestamp,
  };
  await context.db.insert(schema.v2OrderBookState).values({ id: event.log.address, ...values })
    .onConflictDoUpdate(values);
});

ponder.on("OrderBook:FeeParamsScheduled", async ({ event, context }) => {
  const id = event.log.address;
  const previous = await context.db.find(schema.v2OrderBookState, { id });
  // The constructor's FeeParamsSet log may predate this indexer's start block. In that case,
  // registry fees are the deployed constructor defaults until the scheduled change is due.
  const values = {
    ...scheduledFeeColumns(previous, initialFees, event.args.params,
      BigInt(event.args.effectiveAt), event.block.timestamp),
    updatedAt: event.block.timestamp,
  };
  await context.db.insert(schema.v2OrderBookState).values({ id, ...values })
    .onConflictDoUpdate(values);
});

ponder.on("OrderBook:TradingPausedSet", async ({ event, context }) => {
  const values = { tradingPaused: event.args.paused, updatedAt: event.block.timestamp };
  await context.db.insert(schema.v2OrderBookState).values({ id: event.log.address, ...values })
    .onConflictDoUpdate(values);
});

ponder.on("OrderBook:DiscountModuleSet", async ({ event, context }) => {
  const module = addressKey(event.args.module);
  const values = {
    discountModule: module === ZERO_ADDRESS ? null : module,
    updatedAt: event.block.timestamp,
  };
  await context.db.insert(schema.v2OrderBookState).values({ id: event.log.address, ...values })
    .onConflictDoUpdate(values);
});

ponder.on("OrderBook:FundingAllowedSet", async ({ event, context }) => {
  const maker = addressKey(event.args.maker);
  const current = await context.db.find(schema.v2FundingSource, { maker });
  const values = {
    allowed: event.args.allowed,
    // setFundingAllowed(maker, false) clears `on` without a second FundingSet event.
    fundingOn: event.args.allowed ? (current?.fundingOn ?? false) : false,
    changedAt: event.block.timestamp,
    changedBlock: event.block.number,
    changedTx: event.transaction.hash,
  };
  if (current === null) await context.db.insert(schema.v2FundingSource).values({ maker, ...values });
  else await context.db.update(schema.v2FundingSource, { maker }).set(values);
});

/**
 * F-APP-INDEXER-04: THIS THROWS ON PURPOSE, and the choice was made, not inherited (T-188).
 *
 * `OrderBook.setFunding` reverts NotAuthorized unless `_funding[maker].allowed`, so the chain cannot
 * emit this event for a maker it has not allowed. Reaching here without an allowed row therefore
 * never means "the maker is disallowed"; it means THIS INDEX MISSED the maker's FundingAllowedSet --
 * a V2_START_BLOCK later than the OrderBook deploy, a truncated backfill, or ABI/source drift.
 *
 * The rejected alternative was an upsert of `allowed: true`, which the log does prove. It was rejected
 * because the gap it would paper over is not local: whatever dropped this one event dropped every other
 * event in the same range, so fills, orders and positions are silently incomplete too, and this is one
 * of the few handlers able to notice. Ponder retries a throwing handler forever, so the indexer halts
 * loudly at the first proof of a gap instead of serving an incomplete history as a complete one.
 */
ponder.on("OrderBook:FundingSet", async ({ event, context }) => {
  const maker = addressKey(event.args.maker);
  const current = await context.db.find(schema.v2FundingSource, { maker });
  if (current === null || !current.allowed) {
    throw new Error(`FundingSet for disallowed maker ${maker} at block ${event.block.number}: ` +
      "OrderBook.setFunding reverts unless the maker is allowed, so this index is missing its " +
      "FundingAllowedSet. Check V2_START_BLOCK is the OrderBook deploy block and the backfill is complete.");
  }
  await context.db.update(schema.v2FundingSource, { maker }).set({
    fundingOn: event.args.on,
    changedAt: event.block.timestamp,
    changedBlock: event.block.number,
    changedTx: event.transaction.hash,
  });
});

ponder.on("OrderBook:Funded", async ({ event, context }) => {
  const { maker, asset, requested, delivered } = event.args;
  await context.db.insert(schema.v2FundingAttempt).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    maker: addressKey(maker), asset: addressKey(asset), requested, delivered, succeeded: true,
    ts: event.block.timestamp, block: event.block.number, logIndex: event.log.logIndex,
    tx: event.transaction.hash,
  });
});

ponder.on("OrderBook:FundingFailed", async ({ event, context }) => {
  const { maker, asset, requested } = event.args;
  await context.db.insert(schema.v2FundingAttempt).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    maker: addressKey(maker), asset: addressKey(asset), requested, delivered: null, succeeded: false,
    ts: event.block.timestamp, block: event.block.number, logIndex: event.log.logIndex,
    tx: event.transaction.hash,
  });
});
