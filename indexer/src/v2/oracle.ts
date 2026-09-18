import { and, eq } from "ponder";
import schema from "ponder:schema";
import type { Address } from "viem";

import type { DB, EventMeta } from "../../lib/indexing";
import { emptySettlement, oracleSeriesStatus, reduceOracle, settlementId, type OracleEvent } from "../../lib/v2/oracle";
import { v2Ponder as ponder } from "../../lib/registry";

async function getSettlement(db: DB, underlying: Address, expiry: bigint) {
  const id = settlementId(underlying, expiry);
  return await db.find(schema.v2Settlement, { id }) ??
    await db.insert(schema.v2Settlement).values({ id, underlying, expiry });
}

async function record(event: EventMeta, db: DB, underlying: Address, expiry: bigint, change: OracleEvent) {
  const key = underlying.toLowerCase() as Address;
  const previous = await getSettlement(db, key, expiry);
  const next = reduceOracle(previous, change, event.block.timestamp);
  const finalizedLog = change.kind === "SettlementFinalized" || change.kind === "SettlementResolved"
    ? { finalizedBlock: event.block.number, finalizedLogIndex: event.log.logIndex }
    : {};
  await db.update(schema.v2Settlement, { id: previous.id }).set({ ...next, ...finalizedLog });

  if (change.kind === "SourceRecorded") return;
  const series = await db.sql.select().from(schema.v2Series).where(and(
    eq(schema.v2Series.underlying, key),
    eq(schema.v2Series.expiry, expiry),
  ));
  for (const row of series) {
    await db.update(schema.v2Series, { longId: row.longId }).set({
      status: oracleSeriesStatus(row.status, next.status),
      ...(next.status === "Finalized" ? { settlementPrice: next.price } : {}),
    });
  }
}

ponder.on("SettlementOracle:SourceRecorded", async ({ event, context }) => {
  const { underlying, expiry, sourceIndex, ok, price } = event.args;
  await record(event, context.db, underlying, BigInt(expiry), { kind: "SourceRecorded", sourceIndex, ok, price });
});

ponder.on("SettlementOracle:SettlementCandidate", async ({ event, context }) => {
  const { underlying, expiry, price, sourceIndex, disagreed, finalizableAt } = event.args;
  await record(event, context.db, underlying, BigInt(expiry), {
    kind: "SettlementCandidate", price, sourceIndex, disagreed, finalizableAt: BigInt(finalizableAt),
  });
});

ponder.on("SettlementOracle:SettlementFinalized", async ({ event, context }) => {
  const { underlying, expiry, price, sourceIndex, corroborated } = event.args;
  await record(event, context.db, underlying, BigInt(expiry), {
    kind: "SettlementFinalized", price, sourceIndex, corroborated, tx: event.transaction.hash,
  });
});

ponder.on("SettlementOracle:SettlementResolved", async ({ event, context }) => {
  const { underlying, expiry, price } = event.args;
  await record(event, context.db, underlying, BigInt(expiry), { kind: "SettlementResolved", price, tx: event.transaction.hash });
});

ponder.on("SettlementOracle:SettlementVetoed", async ({ event, context }) => {
  const { underlying, expiry } = event.args;
  await record(event, context.db, underlying, BigInt(expiry), { kind: "SettlementVetoed" });
});

ponder.on("SettlementOracle:SettlementUnvetoed", async ({ event, context }) => {
  const { underlying, expiry, finalizableAt } = event.args;
  await record(event, context.db, underlying, BigInt(expiry), {
    kind: "SettlementUnvetoed", finalizableAt: BigInt(finalizableAt),
  });
});

ponder.on("SettlementOracle:MarketSourcesSet", async ({ event, context }) => {
  // The ABI gives no source list. Keep the market's activity cursor current; source
  // configuration cannot be reconstructed from this event alone.
  const market = await context.db.find(schema.v2Market, { underlying: event.args.underlying.toLowerCase() as Address });
  if (market !== null) {
    await context.db.update(schema.v2Market, { underlying: market.underlying }).set({
      lastBlock: event.block.number,
      lastTimestamp: event.block.timestamp,
    });
  }
});
