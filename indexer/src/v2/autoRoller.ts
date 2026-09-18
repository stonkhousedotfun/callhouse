import schema from "ponder:schema";
import type { Address } from "viem";

import type { DB } from "../../lib/indexing";
import { emptyStrategy, reduceStrategy, strategyId, type RollerEvent } from "../../lib/v2/autoRoller";
import { v2Ponder as ponder } from "../../lib/registry";

async function getStrategy(db: DB, writer: Address, underlying: Address, at: bigint) {
  const id = strategyId(writer, underlying);
  const existing = await db.find(schema.v2Strategy, { id });
  if (existing !== null) return existing;
  const market = await db.find(schema.v2Market, { underlying: underlying.toLowerCase() as Address });
  return await db.insert(schema.v2Strategy).values({
    id,
    writer: writer.toLowerCase() as Address,
    underlying: underlying.toLowerCase() as Address,
    // A bounded replay may start after MarketRegistered. Preserve the strategy
    // under its address until an earlier market registration is backfilled.
    ticker: market?.ticker ?? underlying,
    ...emptyStrategy(at),
  });
}

async function updateStrategy(db: DB, writer: Address, underlying: Address, at: bigint, change: RollerEvent) {
  const current = await getStrategy(db, writer, underlying, at);
  return await db.update(schema.v2Strategy, { id: current.id }).set(reduceStrategy(current, change, at));
}

ponder.on("AutoRoller:StrategySet", async ({ event, context }) => {
  const { writer, underlying, strategy } = event.args;
  await updateStrategy(context.db, writer, underlying, event.block.timestamp, {
    kind: "StrategySet",
    strategy: {
      active: strategy.active,
      weekly: strategy.weekly,
      smartPricing: strategy.smartPricing,
      otmBps: strategy.otmBps,
      askBps: strategy.askBps,
      minAskBps: strategy.minAskBps,
      maxAskBps: strategy.maxAskBps,
      maxUnits: strategy.maxUnits,
    },
  });
});

ponder.on("AutoRoller:StrategyStopped", async ({ event, context }) => {
  const { writer, underlying } = event.args;
  await updateStrategy(context.db, writer, underlying, event.block.timestamp, { kind: "StrategyStopped" });
});

ponder.on("AutoRoller:Rolled", async ({ event, context }) => {
  const { writer, underlying, longId, orderId, strike, expiry, price, units } = event.args;
  const at = event.block.timestamp;
  await updateStrategy(context.db, writer, underlying, at, {
    kind: "Rolled", longId, orderId, expiry: BigInt(expiry),
  });
  await context.db.insert(schema.v2Roll).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    writer: writer.toLowerCase() as Address,
    underlying: underlying.toLowerCase() as Address,
    longId,
    orderId,
    strike,
    expiry: BigInt(expiry),
    price,
    units,
    ts: at,
    block: event.block.number,
    logIndex: event.log.logIndex,
    tx: event.transaction.hash,
  });
});

ponder.on("AutoRoller:Repriced", async ({ event, context }) => {
  const { writer, underlying, oldOrderId, newOrderId } = event.args;
  await updateStrategy(context.db, writer, underlying, event.block.timestamp, { kind: "Repriced", newOrderId });
  const oldOrder = await context.db.find(schema.v2Order, { orderId: oldOrderId });
  if (oldOrder !== null) {
    await context.db.update(schema.v2Order, { orderId: oldOrderId }).set({ replacedBy: newOrderId });
  }
});

ponder.on("AutoRoller:StaleAskCancelled", async ({ event, context }) => {
  const { writer, underlying, longId, orderId, spot, updatedAt } = event.args;
  await updateStrategy(context.db, writer, underlying, event.block.timestamp, {
    kind: "StaleAskCancelled", longId, orderId, spot,
  });
  await context.db.insert(schema.v2StaleCancel).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`, writer: writer.toLowerCase() as Address,
    underlying: underlying.toLowerCase() as Address, longId, orderId, spot, spotUpdatedAt: updatedAt,
    ts: event.block.timestamp, block: event.block.number, logIndex: event.log.logIndex, tx: event.transaction.hash,
  });
});
