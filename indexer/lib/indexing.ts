import type { Context } from "ponder:registry";
import schema from "ponder:schema";
import type { Address, Hex } from "viem";

import { stockTokenAbi } from "../abis/stockToken";
import { ASSET, VAULT } from "./env";

/** The writable database handle handed to every indexing function. */
export type DB = Context["db"];

/** The cached, block-pinned viem client handed to every indexing function. */
export type ReadClient = Context["client"];

/** The slice of a ponder log event every helper here needs. */
export type EventMeta = {
  block: { number: bigint; timestamp: bigint };
  log: { logIndex: number };
  transaction: { hash: Hex };
};

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Vault.Phase, mirrored. Defined in ./lifecycle (no Ponder import, so it is unit-testable). */
export { PHASE } from "./lifecycle";

/** Stable, monotonic id for an append-only row. */
export const eventId = (event: EventMeta): string =>
  `${event.block.number}-${event.log.logIndex}`;

/*//////////////////////////////////////////////////////////////
                          VAULT STATE
//////////////////////////////////////////////////////////////*/

/**
 * Read the singleton vault-state row, creating it on first touch.
 *
 * Every column has a default, so the freshly created row is the vault at genesis: flat, idle,
 * no shares, no cycle. Handlers then reduce events onto it in log order.
 */
export async function getState(db: DB) {
  const existing = await db.find(schema.vaultState, { id: VAULT });
  if (existing !== null) return existing;
  return await db.insert(schema.vaultState).values({ id: VAULT });
}

export type VaultState = Awaited<ReturnType<typeof getState>>;

/** Any subset of the mutable columns. The primary key is never patched. */
type StatePatch = Partial<Omit<VaultState, "id">>;

/** Apply a patch to the singleton vault-state row and return the updated row. */
export async function patchState(db: DB, values: StatePatch) {
  await getState(db);
  return await db.update(schema.vaultState, { id: VAULT }).set(values);
}

/** Stamp "when did we last see this vault move" without changing anything else. */
export async function touchState(db: DB, event: EventMeta) {
  return await patchState(db, {
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
}

/** `Vault.idleAssets()`: the raw balance less what is already promised to settled redeemers. */
export const idleOf = (s: { assetBalance: bigint; reservedAssets: bigint }): bigint =>
  s.assetBalance > s.reservedAssets ? s.assetBalance - s.reservedAssets : 0n;

/*//////////////////////////////////////////////////////////////
                           SNAPSHOTS
//////////////////////////////////////////////////////////////*/

/**
 * Append a point-in-time snapshot of the vault.
 *
 * `refreshMultiplier` forces a live read of the Stock Token's ERC-8056 `uiMultiplier()`.
 * It is only worth an RPC round trip on the handful of events that bracket a cycle; for
 * everything else the last known value is carried forward, because the multiplier moves on
 * corporate actions, not on deposits. The read is wrapped because `uiMultiplier()` is not
 * part of ERC-20: a token that does not expose it must not be able to halt indexing.
 */
export async function snapshot(
  db: DB,
  event: EventMeta,
  reason: string,
  opts?: { client?: ReadClient; refreshMultiplier?: boolean },
) {
  let s = await getState(db);

  if (opts?.refreshMultiplier && opts.client !== undefined) {
    const m = await readUiMultiplier(opts.client);
    if (m !== null && m !== s.uiMultiplier) {
      s = await patchState(db, { uiMultiplier: m });
    }
  }

  const idle = idleOf(s);

  await db
    .insert(schema.vaultSnapshot)
    .values({
      id: eventId(event),
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
      reason,
      phase: s.phase,
      cycleNumber: s.cycleNumber,
      writesHalted: s.writesHalted,
      stranded: s.stranded,
      assetBalance: s.assetBalance,
      idleAssets: idle,
      lockedCollateral: s.lockedCollateral,
      totalAssets: idle + s.lockedCollateral,
      reservedAssets: s.reservedAssets,
      usdgBalance: s.usdgBalance,
      totalShares: s.totalShares,
      queuedShares: s.queuedShares,
      accUsdgPerShare: s.accUsdgPerShare,
      totalUsdgDistributed: s.totalUsdgDistributed,
      uiMultiplier: s.uiMultiplier,
    })
    // Two vault events can share a log index only if they share a block AND a position,
    // which cannot happen; the guard exists so a replayed event is idempotent.
    .onConflictDoNothing();
}

async function readUiMultiplier(client: ReadClient): Promise<bigint | null> {
  try {
    return await client.readContract({
      abi: stockTokenAbi,
      address: ASSET,
      functionName: "uiMultiplier",
    });
  } catch {
    return null;
  }
}

/*//////////////////////////////////////////////////////////////
                             USERS
//////////////////////////////////////////////////////////////*/

/**
 * True for addresses that are not depositors: the zero address (mint/burn) and the vault
 * itself (which holds escrowed shares for the redeem queue, not a position).
 */
export const isAccountable = (addr: Address): boolean =>
  addr.toLowerCase() !== ZERO_ADDRESS && addr.toLowerCase() !== VAULT.toLowerCase();

export async function getUser(db: DB, address: Address, event: EventMeta) {
  const existing = await db.find(schema.user, { address });
  if (existing !== null) {
    return await db.update(schema.user, { address }).set({
      lastActivityAt: event.block.timestamp,
      lastActivityBlock: event.block.number,
    });
  }
  return await db.insert(schema.user).values({
    address,
    firstSeenAt: event.block.timestamp,
    firstSeenBlock: event.block.number,
    lastActivityAt: event.block.timestamp,
    lastActivityBlock: event.block.number,
  });
}

/*//////////////////////////////////////////////////////////////
                            CYCLES
//////////////////////////////////////////////////////////////*/

/**
 * Read a cycle row, creating a bare one if `RollOpen` has not been indexed.
 *
 * With START_BLOCK at the vault's deploy block every cycle's `RollOpen` is indexed and this
 * never creates anything; the bare row exists so a replay bounded inside a week still
 * attributes its fills and its close to a row rather than dropping them.
 */
export async function getCycle(db: DB, cycleNumber: number) {
  const existing = await db.find(schema.cycle, { cycleNumber });
  if (existing !== null) return existing;
  return await db.insert(schema.cycle).values({ cycleNumber });
}

export type CycleRow = Awaited<ReturnType<typeof getCycle>>;

type CyclePatch = Partial<Omit<CycleRow, "cycleNumber">>;

export async function patchCycle(db: DB, cycleNumber: number, values: CyclePatch) {
  await getCycle(db, cycleNumber);
  return await db.update(schema.cycle, { cycleNumber }).set(values);
}

/*//////////////////////////////////////////////////////////////
                         QUEUE EPOCHS
//////////////////////////////////////////////////////////////*/

export async function getEpoch(db: DB, epochId: bigint, event?: EventMeta) {
  const existing = await db.find(schema.queueEpoch, { epochId });
  if (existing !== null) return existing;
  return await db.insert(schema.queueEpoch).values({
    epochId,
    openedAt: event?.block.timestamp,
  });
}

export type EpochRow = Awaited<ReturnType<typeof getEpoch>>;

type EpochPatch = Partial<Omit<EpochRow, "epochId">>;

export async function patchEpoch(db: DB, epochId: bigint, values: EpochPatch) {
  await getEpoch(db, epochId);
  return await db.update(schema.queueEpoch, { epochId }).set(values);
}

/*//////////////////////////////////////////////////////////////
                        STRANDED CLAIMS
//////////////////////////////////////////////////////////////*/

export type StrandRow = typeof schema.strand.$inferSelect;

type StrandPatch = Partial<Omit<StrandRow, "gen">>;

/** Patch a strand row. Unlike the other tables there is no bare insert: `ClaimStranded` always creates the row first. */
export async function patchStrand(db: DB, gen: bigint, values: StrandPatch) {
  return await db.update(schema.strand, { gen }).set(values);
}

/*//////////////////////////////////////////////////////////////
                             MATHS
//////////////////////////////////////////////////////////////*/

/** Integer division that returns 0 rather than throwing when the divisor is 0. */
export const safeDiv = (a: bigint, b: bigint): bigint => (b === 0n ? 0n : a / b);

/** Saturating subtraction. Balances derived from logs must never go negative. */
export const sub = (a: bigint, b: bigint): bigint => (a > b ? a - b : 0n);
