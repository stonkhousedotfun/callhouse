/**
 * House vault ingest. Sources: HouseVaultFactory (the launch factory, legacy event), HouseVaultFactoryKinded (the
 * daily factories from the registry) + HouseVault (the registry's vault list;
 * factory()-resolved on VaultCreated.vault only for a factory the registry does not name, see
 * lib/v2/houseVaultSource.ts). Do not register these clones under MakerVault — every depositor
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
import type { DB, ReadClient } from "../../lib/indexing";
import { v2HouseVaultEventsPonder, v2HouseVaultKindedFactoryPonder, v2HouseVaultPonder } from "../../lib/registry";
import {
  isUnregisteredHouseVault,
  unregisteredHouseVaultAlert,
  v2HouseVaultSource,
  type HouseVaultSource,
} from "../../lib/v2/houseVaultSource";
import {
  houseSourceAnchor,
  houseVaultKind,
  KINDED_HOUSE_FACTORIES,
  legacyHouseFactories,
  v2KindedHouseFactorySources,
} from "./houseVaultKind";

const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * The same decision ponder.config.ts made for the HouseVault source (same env, same registry), read once.
 * Undefined only when no House factory is configured, in which case every House gate is inert anyway. The
 * anchor is the launch factory when set, else the registry's kinded factory (houseSourceAnchor), as in the config.
 *
 * lib/env is imported LAZILY, on the first VaultCreated. orderBook.ts imports this module for recordHouseFills, and
 * lib/env throws at import without a configured deployment, so a module-level import made every OrderBook handler
 * test need a full v2 env (src/v2/orderBookFees.handler.test.ts failed on PONDER_RPC_URL_4663).
 */
let houseSource: Promise<HouseVaultSource | undefined> | undefined;
function configuredHouseSource(): Promise<HouseVaultSource | undefined> {
  houseSource ??= import("../../lib/env").then(({ V2_CLEARINGHOUSE, V2_HOUSE_START_BLOCK, V2_HOUSE_VAULT_FACTORY }) => {
    const kinded = v2KindedHouseFactorySources(V2_CLEARINGHOUSE, V2_HOUSE_START_BLOCK, V2_HOUSE_VAULT_FACTORY);
    const anchor = houseSourceAnchor(V2_HOUSE_VAULT_FACTORY, V2_HOUSE_START_BLOCK, kinded);
    return anchor === undefined ? undefined : v2HouseVaultSource(anchor.factory, anchor.startBlock);
  });
  return houseSource;
}

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
 * the claim paid anything.
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

/** What both factory sources' `VaultCreated` carry; the kinded one adds `weekly`, passed separately. */
type VaultCreatedInput = {
  event: Parameters<typeof meta>[0] & { args: { underlying: Address; vault: Address; name: string; symbol: string } };
  context: { db: DB; client: ReadClient };
};

/**
 * One body for both factory sources. `weekly` is the kinded event's own field: a kinded factory states the
 * vault's kind in the event it emits, so it is used as the answer rather than read back with an RPC call that could
 * fail. The launch factory's event has no such field, and its vaults never have `weekly()`: they resolve by factory.
 */
async function recordVaultCreated({ event, context }: VaultCreatedInput, weekly: boolean | undefined) {
  const m = meta(event);
  const vault = lower(event.args.vault);
  const factory = m.sourceAddress;
  const underlying = lower(event.args.underlying);
  // The HouseVault source is the registry's list, so a vault it does not name is created here but none of
  // its own events will ever arrive. The row below is still written (the vault exists); the alert says it is blind.
  // /v2/health/house-registry reads the same fact back from v2HouseVault, so it survives a log rotation.
  const source = await configuredHouseSource();
  if (source !== undefined && isUnregisteredHouseVault(source, vault)) {
    console.error(unregisteredHouseVaultAlert({ vault, factory, block: m.block }));
  }
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
  // The constructor emits EpochOpened before this factory log. That row is the epoch
  // end even when epochEnd() cannot be read. The event wins when both exist: it is the same fact.
  const opened = await context.db.find(schema.v2HouseEpochOpened, { vault });
  if (opened !== null) {
    epochEnd = opened.epochEnd;
    epochId = opened.epochId;
  }
  // The kind from the factory this vault was enumerated from (houseVaultKind.ts). The configured source
  // is the launch factory, whose vaults have no weekly() view: they resolve to weekly without it being called.
  // A 5-field event states the kind itself, and that wins even when the emitter is the launch factory (v9).
  const kind = await houseVaultKind({
    factory,
    legacy: legacyHouseFactories(),
    kinded: KINDED_HOUSE_FACTORIES,
    stated: weekly,
    readWeekly: async () =>
      Boolean(await context.client.readContract({ abi: houseVaultAbi, address: event.args.vault, functionName: "weekly" })),
  });
  await context.db.insert(schema.v2HouseVault).values({
    vault,
    underlying,
    sharesToken: vault,
    factory,
    kind,
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
}

v2HouseVaultPonder.on("HouseVaultFactory:VaultCreated", async ({ event, context }) => {
  await recordVaultCreated({ event, context }, undefined);
});

v2HouseVaultKindedFactoryPonder.on("HouseVaultFactoryKinded:VaultCreated", async ({ event, context }) => {
  await recordVaultCreated({ event, context }, event.args.weekly);
});

v2HouseVaultEventsPonder.on("HouseVault:DepositRequested", async ({ event, context }) => {
  const m = meta(event);
  const vault = m.sourceAddress;
  const account = lower(event.args.account);
  const id = queueId(vault, account);
  const existing = await context.db.find(schema.v2HouseDepositQueue, { id });
  // HouseVault.requestDeposit adds to a request only in the epoch it was opened in; a request from an earlier
  // epoch must be claimed first (TooEarly). So a queued row from another epoch is never topped up, even when its close
  // was missed (closeMaturedQueue leaves it queued when the vault row has no epoch).
  const topUp = existing !== null && existing.status === "queued" && existing.epochId === BigInt(event.args.epochId);
  const usdgAmount = topUp ? existing.usdgAmount + event.args.usdgAmount : event.args.usdgAmount;
  const stockAmount = topUp ? existing.stockAmount + event.args.stockAmount : event.args.stockAmount;
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

v2HouseVaultEventsPonder.on("HouseVault:DepositRequestCancelled", async ({ event, context }) => {
  const m = meta(event);
  const id = queueId(m.sourceAddress, event.args.account);
  await closeQueue(context.db, schema.v2HouseDepositQueue, id, "cancelled", event);
});

v2HouseVaultEventsPonder.on("HouseVault:WithdrawRequested", async ({ event, context }) => {
  const m = meta(event);
  const vault = m.sourceAddress;
  const account = lower(event.args.account);
  const id = queueId(vault, account);
  const existing = await context.db.find(schema.v2HouseWithdrawQueue, { id });
  // The same epoch rule as the deposit side (HouseVault.requestWithdraw, TooEarly for an earlier epoch's shares).
  const topUp = existing !== null && existing.status === "queued" && existing.epochId === BigInt(event.args.epochId);
  const shares = topUp ? existing.shares + event.args.shares : event.args.shares;
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

v2HouseVaultEventsPonder.on("HouseVault:WithdrawRequestCancelled", async ({ event, context }) => {
  const m = meta(event);
  await closeQueue(context.db, schema.v2HouseWithdrawQueue, queueId(m.sourceAddress, event.args.account), "cancelled", event);
});

/**
 * HouseVault.performanceFeeOwed() at `blockNumber`, or null when it cannot be read: a v8 vault has no such
 * view (the call reverts), and an RPC failure is not a zero.
 */
async function readPerformanceFeeOwed(client: ReadClient, vault: Address, blockNumber: bigint): Promise<bigint | null> {
  try {
    return await client.readContract({ abi: houseVaultAbi, address: vault, functionName: "performanceFeeOwed", blockNumber });
  } catch {
    return null;
  }
}

v2HouseVaultEventsPonder.on("HouseVault:EpochRolled", async ({ event, context }) => {
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
   * The new epoch's end was inserted as `null` and the vault's `currentEpochEnd` set to
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

  // On a v9 vault `performanceFee` is the fee CHARGED; what the wallet could not pay is carried in
  // performanceFeeOwed and paid at a later boundary with no event. performanceFeeOwed changes only inside the roll
  // (HouseVault.sol: `performanceFeeOwed = feeDue - feePaid`, feeDue = owed + fee), so
  //   paid at this boundary = charged + owedBefore - owedAfter,
  // with owedBefore read at the previous block and owedAfter at this one. A v8 vault has no such view and reverts; a
  // failed read is UNKNOWN (null), never 0 -- and never inferred from balance deltas.
  const owedBefore = await readPerformanceFeeOwed(context.client, event.log.address, event.block.number - 1n);
  const owedAfter = await readPerformanceFeeOwed(context.client, event.log.address, event.block.number);
  const paid = owedBefore === null || owedAfter === null
    ? null
    : event.args.performanceFee + owedBefore - owedAfter;
  await context.db.insert(schema.v2HousePerformanceFee).values({
    id: m.id,
    vault,
    epochId: closed,
    amount: event.args.performanceFee,
    owedBefore,
    owedAfter,
    paid,
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

/**
 * Epoch `epochId` opened and closes at `epochEnd`. Keyed by the vault, not by the vault
 * row: at construction this log comes BEFORE VaultCreated, and a handler that only updates
 * v2HouseVault would drop it. When the epoch row or the vault row already exists, a null end is
 * filled from this log (EpochRolled's eth_call can fail).
 */
v2HouseVaultEventsPonder.on("HouseVault:EpochOpened", async ({ event, context }) => {
  const m = meta(event);
  const vault = m.sourceAddress;
  const epochId = BigInt(event.args.epochId);
  const epochEnd = BigInt(event.args.epochEnd);
  const stamp = { epochId, epochEnd, ts: m.ts, block: m.block, logIndex: m.logIndex, tx: m.tx };
  await context.db.insert(schema.v2HouseEpochOpened).values({ vault, ...stamp }).onConflictDoUpdate(stamp);
  const epoch = await context.db.find(schema.v2HouseEpoch, { id: epochRowId(vault, epochId) });
  if (epoch !== null && epoch.end === null) {
    await context.db.update(schema.v2HouseEpoch, { id: epochRowId(vault, epochId) }).set({ end: epochEnd });
  }
  const vaultRow = await context.db.find(schema.v2HouseVault, { vault });
  if (vaultRow !== null && (vaultRow.currentEpochId === null || vaultRow.currentEpochId === epochId)) {
    await context.db.update(schema.v2HouseVault, { vault }).set({
      currentEpochId: epochId, currentEpochEnd: epochEnd,
    });
  }
});

/** What the boundary paid the splitter, and the performanceFeeOwed it left. */
v2HouseVaultEventsPonder.on("HouseVault:PerformanceFeePaid", async ({ event, context }) => {
  const m = meta(event);
  await context.db.insert(schema.v2HousePerformanceFeePaid).values({
    id: m.id,
    vault: m.sourceAddress,
    epochId: BigInt(event.args.epochId),
    paid: event.args.paid,
    owed: event.args.owed,
    ts: m.ts,
    block: m.block,
    logIndex: m.logIndex,
    tx: m.tx,
  });
});

/** The batch originals, before claims run the reserved totals down. */
v2HouseVaultEventsPonder.on("HouseVault:EpochBatchesPriced", async ({ event, context }) => {
  const m = meta(event);
  await context.db.insert(schema.v2HouseEpochBatches).values({
    id: m.id,
    vault: m.sourceAddress,
    epochId: BigInt(event.args.epochId),
    depositValue: event.args.depositValue,
    depositRefused: event.args.depositRefused,
    withdrawUsdg: event.args.withdrawUsdg,
    withdrawStock: event.args.withdrawStock,
    ts: m.ts,
    block: m.block,
    logIndex: m.logIndex,
    tx: m.tx,
  });
});

/**
 * HouseVault.depositNow: shares minted to the depositor IN the deposit's own transaction, outside
 * every queue and every EpochRolled. The SHARES need nothing here: `_mint(msg.sender, shares)` emits
 * Transfer(0 -> account) before this event (HouseVault.sol depositNow), and the Transfer handler below already credits
 * v2HouseShareBalance and v2HouseVault.sharesSupply (plus the MIN_SHARES dead mint on a bootstrap deposit). Crediting
 * them again here would double every instant holding. What only this event carries is the deposit itself: the USDG
 * the vault received, the shares that bought, and the epoch. It never touches the queue tables, NAV or the epoch rows,
 * because depositNow does not touch the queues, the reserves or the epoch rates either.
 */
v2HouseVaultEventsPonder.on("HouseVault:DepositedNow", async ({ event, context }) => {
  const m = meta(event);
  await context.db.insert(schema.v2HouseInstantDeposit).values({
    id: m.id,
    vault: m.sourceAddress,
    account: lower(event.args.account),
    usdgAmount: event.args.usdgAmount,
    shares: event.args.shares,
    epochId: BigInt(event.args.epochId),
    ts: m.ts,
    block: m.block,
    logIndex: m.logIndex,
    tx: m.tx,
  });
});

v2HouseVaultEventsPonder.on("HouseVault:Claimed", async ({ event, context }) => {
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

v2HouseVaultEventsPonder.on("HouseVault:LimitsSet", async ({ event, context }) => {
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

/**
 * The rate a boundary CHARGES, `epochPerformanceFeeBps`, changes only here, as rollEpoch opens epoch
 * `epochId` with the configured rate. PerformanceFeeBpsSet only stages it (src/v2/adminConfig.ts records it as a
 * setting), so it no longer writes this column: a staged rise read as already charged.
 */
v2HouseVaultEventsPonder.on("HouseVault:PerformanceFeeBpsApplied", async ({ event, context }) => {
  const vault = lower(event.log.address);
  const row = await context.db.find(schema.v2HouseVault, { vault });
  if (row !== null) {
    await context.db.update(schema.v2HouseVault, { vault }).set({
      performanceFeeBps: Number(event.args.bps),
    });
  }
});

v2HouseVaultEventsPonder.on("HouseVault:ProtocolAccountSet", async ({ event, context }) => {
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

v2HouseVaultEventsPonder.on("HouseVault:QuotingPausedSet", async ({ event, context }) => {
  const vault = lower(event.log.address);
  const row = await context.db.find(schema.v2HouseVault, { vault });
  if (row !== null) {
    await context.db.update(schema.v2HouseVault, { vault }).set({ quotingPaused: event.args.paused });
  }
});

v2HouseVaultEventsPonder.on("HouseVault:ExposureSet", async ({ event, context }) => {
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

v2HouseVaultEventsPonder.on("HouseVault:Transfer", async ({ event, context }) => {
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
