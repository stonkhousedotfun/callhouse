/**
 * House vault ingest. Sources: HouseVaultFactory (fixed) + HouseVault (factory()-resolved
 * on VaultCreated.vault). Do not register these clones under MakerVault — every depositor
 * withdrawal would be published as a treasury exit (src/v2/treasury.ts:28-43).
 *
 * NAV rows come only from EpochRolled. Transfer never writes v2HouseNav.
 * take() self-deal reverts without a log; v2HouseSelfDealRefusal stays empty.
 */
import schema from "ponder:schema";
import type { Address } from "viem";

import { houseVaultAbi } from "../../abis/v2/houseVault";
import {
  applyTransferSupply,
  decodeLimits,
  epochRowId,
  houseFillRows,
  lower,
  meta,
  nextShareBalance,
  queueId,
  shareBalanceId,
} from "../../lib/v2/houseVault";
import type { DB } from "../../lib/indexing";
import { v2HouseVaultPonder } from "../../lib/registry";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * The two queue tables these helpers close. Typed to the tables themselves rather than `unknown`:
 * ponder's `db.find`/`db.update` are keyed on the onchain table's own type, so `unknown` made the
 * call unresolvable and forced the hand-written `Db` shim this file used to carry.
 */
type QueueTable = typeof schema.v2HouseDepositQueue | typeof schema.v2HouseWithdrawQueue;

async function closeQueue(
  db: DB,
  table: QueueTable,
  id: string,
  status: string,
  event: Parameters<typeof meta>[0],
) {
  const row = await db.find(table, { id });
  if (row === null || row.status !== "queued") return;
  const m = meta(event);
  await db.update(table, { id }).set({
    status,
    closedAt: m.ts,
    closedBlock: m.block,
    closedLogIndex: m.logIndex,
    closedTx: m.tx,
  });
}

/**
 * Close a queue row because the CONTRACT retired the request, which is not the same question as whether
 * the claim paid anything (F-APP-INDEXER-01).
 *
 * `HouseVault.claim` retires each side on `(a request existed) && (its epochId < the vault's epochId)` and
 * deletes it there — the payout is computed afterwards and may floor to zero on either side. Floor division
 * at any boundary above 1:1 produces a zero `sharesOut`, and a withdrawal batch whose per-holder slice floors
 * away produces zero USDG and zero stock. The contract's own comment calls that out: "the test is whether a
 * request was RETIRED, not whether anything was transferred."
 *
 * The event carries amounts, not a retirement flag, so it CANNOT say which side retired — that is why gating
 * on the amounts was wrong in both directions and why the fix cannot live in a different amount test. The
 * indexer already holds the fact the contract compares: the queue row's own `epochId`. Mirror that.
 *
 * `current === null` means the vault row is missing or has never seen an epoch, so maturity cannot be
 * established; the row is LEFT QUEUED. That is the conservative error — a row wrongly left queued is visible
 * and repairable, a row wrongly closed loses the request from the tape and only a full re-index restores it.
 */
async function closeMaturedQueue(
  db: DB,
  table: QueueTable,
  id: string,
  current: bigint | null,
  event: Parameters<typeof meta>[0],
) {
  if (current === null) return;
  const row = await db.find(table, { id });
  if (row === null || row.status !== "queued") return;
  if (row.epochId >= current) return; // requested in the open epoch: the contract did not retire it either
  await closeQueue(db, table, id, "claimed", event);
}

v2HouseVaultPonder.on("HouseVaultFactory:VaultCreated", async ({ event, context }) => {
  const m = meta(event);
  const vault = lower(event.args.vault);
  const factory = m.sourceAddress;
  const underlying = lower(event.args.underlying);
  let epochEnd: bigint | null = null;
  let epochId = 0n;
  try {
    epochEnd = BigInt(
      await context.client.readContract({
        abi: houseVaultAbi,
        address: event.args.vault,
        functionName: "epochEnd",
      }),
    );
    epochId = BigInt(
      await context.client.readContract({
        abi: houseVaultAbi,
        address: event.args.vault,
        functionName: "epochId",
      }),
    );
  } catch {
    epochEnd = null;
    epochId = 0n;
  }
  await context.db.insert(schema.v2HouseVault).values({
    vault,
    underlying,
    sharesToken: vault,
    factory,
    name: event.args.name,
    symbol: event.args.symbol,
    createdAt: m.ts,
    createdBlock: m.block,
    createdLogIndex: m.logIndex,
    createdTx: m.tx,
    sharesSupply: null,
    quotingPaused: null,
    performanceFeeBps: null,
    currentEpochId: epochId,
    currentEpochEnd: epochEnd,
  });
  await context.db.insert(schema.v2HouseEpoch).values({
    id: epochRowId(vault, epochId),
    vault,
    epochId,
    start: m.ts,
    end: epochEnd,
    status: "running",
    rolledAt: null,
    rolledBlock: null,
    rolledLogIndex: null,
    rolledTx: null,
    resultUsdg: null,
  });
});

v2HouseVaultPonder.on("HouseVault:DepositRequested", async ({ event, context }) => {
  const m = meta(event);
  const vault = m.sourceAddress;
  const account = lower(event.args.account);
  const id = queueId(vault, account);
  const existing = await context.db.find(schema.v2HouseDepositQueue, { id });
  const usdgAmount = existing !== null && existing.status === "queued"
    ? existing.usdgAmount + event.args.usdgAmount
    : event.args.usdgAmount;
  const stockAmount = existing !== null && existing.status === "queued"
    ? existing.stockAmount + event.args.stockAmount
    : event.args.stockAmount;
  await context.db.insert(schema.v2HouseDepositQueue).values({
    id,
    vault,
    account,
    epochId: BigInt(event.args.epochId),
    usdgAmount,
    stockAmount,
    status: "queued",
    requestedAt: m.ts,
    requestedBlock: m.block,
    requestedLogIndex: m.logIndex,
    requestedTx: m.tx,
    closedAt: null,
    closedBlock: null,
    closedLogIndex: null,
    closedTx: null,
  }).onConflictDoUpdate({
    epochId: BigInt(event.args.epochId),
    usdgAmount,
    stockAmount,
    status: "queued",
    requestedAt: m.ts,
    requestedBlock: m.block,
    requestedLogIndex: m.logIndex,
    requestedTx: m.tx,
    closedAt: null,
    closedBlock: null,
    closedLogIndex: null,
    closedTx: null,
  });
});

v2HouseVaultPonder.on("HouseVault:DepositRequestCancelled", async ({ event, context }) => {
  const m = meta(event);
  const id = queueId(m.sourceAddress, event.args.account);
  await closeQueue(context.db, schema.v2HouseDepositQueue, id, "cancelled", event);
});

v2HouseVaultPonder.on("HouseVault:WithdrawRequested", async ({ event, context }) => {
  const m = meta(event);
  const vault = m.sourceAddress;
  const account = lower(event.args.account);
  const id = queueId(vault, account);
  const existing = await context.db.find(schema.v2HouseWithdrawQueue, { id });
  const shares = existing !== null && existing.status === "queued"
    ? existing.shares + event.args.shares
    : event.args.shares;
  await context.db.insert(schema.v2HouseWithdrawQueue).values({
    id,
    vault,
    account,
    epochId: BigInt(event.args.epochId),
    shares,
    status: "queued",
    requestedAt: m.ts,
    requestedBlock: m.block,
    requestedLogIndex: m.logIndex,
    requestedTx: m.tx,
    closedAt: null,
    closedBlock: null,
    closedLogIndex: null,
    closedTx: null,
  }).onConflictDoUpdate({
    epochId: BigInt(event.args.epochId),
    shares,
    status: "queued",
    requestedAt: m.ts,
    requestedBlock: m.block,
    requestedLogIndex: m.logIndex,
    requestedTx: m.tx,
    closedAt: null,
    closedBlock: null,
    closedLogIndex: null,
    closedTx: null,
  });
});

v2HouseVaultPonder.on("HouseVault:WithdrawRequestCancelled", async ({ event, context }) => {
  const m = meta(event);
  await closeQueue(context.db, schema.v2HouseWithdrawQueue, queueId(m.sourceAddress, event.args.account), "cancelled", event);
});

v2HouseVaultPonder.on("HouseVault:EpochRolled", async ({ event, context }) => {
  const m = meta(event);
  const vault = m.sourceAddress;
  const closed = BigInt(event.args.epochId);
  const closedId = epochRowId(vault, closed);
  const closedRow = await context.db.find(schema.v2HouseEpoch, { id: closedId });
  await context.db.insert(schema.v2HouseEpoch).values({
    id: closedId,
    vault,
    epochId: closed,
    start: closedRow?.start ?? null,
    end: BigInt(event.args.epochEnd),
    status: "rolled",
    rolledAt: m.ts,
    rolledBlock: m.block,
    rolledLogIndex: m.logIndex,
    rolledTx: m.tx,
    resultUsdg: null,
  }).onConflictDoUpdate({
    end: BigInt(event.args.epochEnd),
    status: "rolled",
    rolledAt: m.ts,
    rolledBlock: m.block,
    rolledLogIndex: m.logIndex,
    rolledTx: m.tx,
  });

  const nextId = closed + 1n;
  /**
   * F-APP-INDEXER-02. The new epoch's end was inserted as `null` and the vault's `currentEpochEnd` set to
   * null, though `roll()` sets the new end in the SAME TRANSACTION this event comes from — so by the time
   * this handler runs, `epochEnd()` already returns the NEW epoch's end and reading it at this block is
   * correct rather than racy. `event.args.epochEnd` is the CLOSED epoch's end (it is written into the closed
   * row above) and must not be reused here.
   *
   * It matters beyond tidiness: `houseEpochSchema.end` is `unixSchema`, non-nullable and frozen, so a null
   * end becomes a hard 500 from the response-schema middleware the moment the ingest and the real /v2/house*
   * routes are both wired. Making the wire schema nullable would hide the null instead of filling it.
   *
   * A failed read leaves `null`, exactly as the VaultCreated path does: one unreadable vault must not abort
   * the roll's other writes, and the next roll fills it.
   */
  let nextEnd: bigint | null = null;
  try {
    nextEnd = BigInt(
      await context.client.readContract({
        abi: houseVaultAbi,
        address: event.log.address,
        functionName: "epochEnd",
      }),
    );
  } catch {
    nextEnd = null;
  }
  await context.db.insert(schema.v2HouseEpoch).values({
    id: epochRowId(vault, nextId),
    vault,
    epochId: nextId,
    start: m.ts,
    end: nextEnd,
    status: "running",
    rolledAt: null,
    rolledBlock: null,
    rolledLogIndex: null,
    rolledTx: null,
    resultUsdg: null,
  });

  await context.db.insert(schema.v2HouseNav).values({
    id: m.id,
    vault,
    epochId: closed,
    at: m.ts,
    usdg: null,
    stockUnits: null,
    settlementPrice: event.args.price,
    navUsdg: event.args.nav,
    sourceEvent: "EpochRolled",
    supply: event.args.supply,
    sharesMinted: event.args.sharesMinted,
    sharesBurned: event.args.sharesBurned,
    performanceFee: event.args.performanceFee,
    ts: m.ts,
    block: m.block,
    logIndex: m.logIndex,
    tx: m.tx,
  });

  await context.db.insert(schema.v2HouseQueueSettlement).values({
    id: m.id,
    vault,
    epochId: closed,
    sharesMinted: event.args.sharesMinted,
    sharesBurned: event.args.sharesBurned,
    performanceFee: event.args.performanceFee,
    ts: m.ts,
    block: m.block,
    logIndex: m.logIndex,
    tx: m.tx,
  });

  await context.db.insert(schema.v2HousePerformanceFee).values({
    id: m.id,
    vault,
    epochId: closed,
    amount: event.args.performanceFee,
    ts: m.ts,
    block: m.block,
    logIndex: m.logIndex,
    tx: m.tx,
  });

  const vaultRow = await context.db.find(schema.v2HouseVault, { vault });
  if (vaultRow !== null) {
    await context.db.update(schema.v2HouseVault, { vault }).set({
      currentEpochId: nextId,
      currentEpochEnd: nextEnd,
    });
  }
});

v2HouseVaultPonder.on("HouseVault:Claimed", async ({ event, context }) => {
  const m = meta(event);
  const vault = m.sourceAddress;
  const account = lower(event.args.account);
  await context.db.insert(schema.v2HouseClaim).values({
    id: m.id,
    vault,
    account,
    shares: event.args.shares,
    usdgAmount: event.args.usdgAmount,
    stockAmount: event.args.stockAmount,
    ts: m.ts,
    block: m.block,
    logIndex: m.logIndex,
    tx: m.tx,
  });
  // Both sides are judged on maturity, not on this event's amounts: see closeMaturedQueue. A zero-output
  // claim used to leave its row `queued` forever, and the next request then ADDED to the phantom amount.
  const vaultRow = await context.db.find(schema.v2HouseVault, { vault });
  const current = vaultRow?.currentEpochId ?? null;
  await closeMaturedQueue(context.db, schema.v2HouseDepositQueue, queueId(vault, account), current, event);
  await closeMaturedQueue(context.db, schema.v2HouseWithdrawQueue, queueId(vault, account), current, event);
});

v2HouseVaultPonder.on("HouseVault:LimitsSet", async ({ event, context }) => {
  const m = meta(event);
  const limits = decodeLimits(event.args.limits);
  await context.db.insert(schema.v2HouseLimits).values({
    id: m.id,
    vault: m.sourceAddress,
    ...limits,
    // The ABI permits uint32; Ponder bigint prevents PostgreSQL int4 overflow above 2^31 - 1.
    maxOrderLifetime: BigInt(limits.maxOrderLifetime),
    ts: m.ts,
    block: m.block,
    logIndex: m.logIndex,
    tx: m.tx,
  });
});

v2HouseVaultPonder.on("HouseVault:PerformanceFeeBpsSet", async ({ event, context }) => {
  const vault = lower(event.log.address);
  const row = await context.db.find(schema.v2HouseVault, { vault });
  if (row !== null) {
    await context.db.update(schema.v2HouseVault, { vault }).set({
      performanceFeeBps: Number(event.args.bps),
    });
  }
});

v2HouseVaultPonder.on("HouseVault:ProtocolAccountSet", async ({ event, context }) => {
  const m = meta(event);
  await context.db.insert(schema.v2HouseProtocolAccount).values({
    id: m.id,
    vault: m.sourceAddress,
    account: lower(event.args.account),
    blocked: event.args.blocked,
    ts: m.ts,
    block: m.block,
    logIndex: m.logIndex,
    tx: m.tx,
  });
});

v2HouseVaultPonder.on("HouseVault:QuotingPausedSet", async ({ event, context }) => {
  const vault = lower(event.log.address);
  const row = await context.db.find(schema.v2HouseVault, { vault });
  if (row !== null) {
    await context.db.update(schema.v2HouseVault, { vault }).set({ quotingPaused: event.args.paused });
  }
});

v2HouseVaultPonder.on("HouseVault:ExposureSet", async ({ event, context }) => {
  const m = meta(event);
  await context.db.insert(schema.v2HouseExposure).values({
    id: m.id,
    vault: m.sourceAddress,
    longId: event.args.longId,
    units: event.args.units,
    notional: event.args.notional,
    totalNotional: event.args.totalNotional,
    ts: m.ts,
    block: m.block,
    logIndex: m.logIndex,
    tx: m.tx,
  });
});

v2HouseVaultPonder.on("HouseVault:Transfer", async ({ event, context }) => {
  const m = meta(event);
  const vault = m.sourceAddress;
  const from = lower(event.args.from);
  const to = lower(event.args.to);
  const value = event.args.value;
  const vaultRow = await context.db.find(schema.v2HouseVault, { vault });
  if (vaultRow !== null) {
    await context.db.update(schema.v2HouseVault, { vault }).set({
      // `sharesSupply` is a nullable column (ponder.schema.ts) and {applyTransferSupply} spells
      // "not observed" as undefined, the same thing {nextShareBalance} receives from `prev?.shares`
      // below. Convert at this boundary rather than widening the helper, which lives outside this
      // row's scope; null and undefined carry identical meaning for this field.
      sharesSupply: applyTransferSupply(vaultRow.sharesSupply ?? undefined, from, to, value),
    });
  }
  const bump = async (account: Address, delta: bigint) => {
    if (account === ZERO) return;
    const id = shareBalanceId(vault, account);
    const prev = await context.db.find(schema.v2HouseShareBalance, { id });
    const shares = nextShareBalance(prev?.shares, delta);
    await context.db.insert(schema.v2HouseShareBalance).values({
      id,
      vault,
      account,
      shares,
      updatedAt: m.ts,
      updatedBlock: m.block,
      updatedLogIndex: m.logIndex,
      updatedTx: m.tx,
    }).onConflictDoUpdate({
      shares,
      updatedAt: m.ts,
      updatedBlock: m.block,
      updatedLogIndex: m.logIndex,
      updatedTx: m.tx,
    });
  };
  await bump(from, -value);
  await bump(to, value);
});

export async function recordHouseFills(event: Parameters<typeof houseFillRows>[0], db: DB) {
  const known = new Set<string>();
  for (const addr of [event.args.maker, event.args.taker] as Address[]) {
    const row = await db.find(schema.v2HouseVault, { vault: lower(addr) });
    if (row !== null) known.add(lower(addr));
  }
  for (const row of houseFillRows(event, known)) {
    await db.insert(schema.v2HouseFill).values(row);
  }
}
