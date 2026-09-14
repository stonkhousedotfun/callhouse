/**
 * The weekly roll state machine, write-on-fill edition.
 *
 * Every decision binds to the vault's own `phase()` and the head block's timestamp, never the
 * wall clock and never a third party's registry. The vault reads the option tuple from the
 * clearinghouse and numbers its own cycles; the keeper's job is to hand it a tuple worth arming,
 * a listing worth authorising, and to close the week.
 *
 *   phase Idle, flat
 *     -> next NYSE Friday close -> strike = spot + KEEPER_STRIKE_OTM_BPS (whole USDG) -> the
 *        option id is precomputed; created on Clear if it does not exist -> rollOpen(id)
 *        (ARMS ONLY, writes nothing) -> approveListing(PARTIAL_RESTRICTED, zone = vault, one
 *        USDG item, amount = capacity) -> served from /orders with an empty signature
 *   phase Idle, `queuedShares > 0`  -> settleQueue()            (permissionless)
 *   phase Idle, `isStranded()`      -> no arm; retryStrandedClaim() on a timer; alert
 *   phase Listed, each tick
 *     -> fills: every Seaport fill runs the vault's authorizeOrder, which WRITES the filled
 *        contracts (CallsWritten per fill; contractsWritten == sold). The keeper reads the count
 *        and Seaport's fill fraction. The fill gate re-prices the floor at the spot of the FILL,
 *        so the keeper mirrors that check and reprices (cancel + approve, three approvals a week)
 *        when a rally would make the live listing unfillable. A fully filled listing with
 *        capacity left (deposits grew NAV) is replaced by a fresh one for the remainder.
 *   now >= cycleExerciseTs -> no new listings, lockBook()
 *   now >= cycleExpiryTs   -> rollClose(); a ClaimStranded in the receipt is the stranded path
 *
 * Every transaction is simulated, then sent, then waited on, then written to SQLite. Nothing
 * is fired and forgotten, and nothing is re-done after a restart.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  BaseError,
  ContractFunctionRevertedError,
  parseEventLogs,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import {
  callsWrittenEvent,
  claimStrandedEvent,
  clearAbi,
  harvestEvent,
  rollCloseEvent,
  rollOpenEvent,
  stockTokenAbi,
  vaultAbi,
} from './abi.js';
import { alert, clearAlert } from './alerts.js';
import { describeInstant, nextWeekWindow, type WeekWindow } from './calendar.js';
import { account, logClient, publicClient, walletClient } from './clients.js';
import { config } from './config.js';
import { log } from './logger.js';
import { TOKEN_TYPE_OPTION, optionIdFor, weeklyTuple, type OptionTuple } from './optionType.js';
import {
  MAX_LISTINGS_PER_CYCLE,
  capacity as capacityOf,
  fillVerdict,
  planWeek,
  priceListing,
  readPolicy,
  type PolicyParams,
} from './policy.js';
import {
  EMPTY_SIGNATURE,
  buildOrderComponents,
  componentsFromJson,
  componentsToJson,
  filledContracts,
  localOrderHash,
  readCounter,
  readOrderHash,
  readOrderStatus,
  toOrderParametersJson,
  type OrderComponentsJson,
  type OrderComponentsStruct,
  type SeaportOrderStatus,
} from './seaport.js';
import { splitGross, store, type CycleRow, type ListingStatus, type TxKind } from './state.js';

/*//////////////////////////////////////////////////////////////
                              TYPES
//////////////////////////////////////////////////////////////*/

export enum Phase {
  Idle = 0,
  Listed = 1,
  Exercisable = 2,
  Settling = 3,
}

export const PHASE_NAMES: Record<Phase, string> = {
  [Phase.Idle]: 'Idle',
  [Phase.Listed]: 'Listed',
  [Phase.Exercisable]: 'Exercisable',
  [Phase.Settling]: 'Settling',
};

export interface ChainSnapshot {
  at: number;
  blockNumber: bigint;
  blockTimestamp: bigint;
  /** Head-block lag against the wall clock, in seconds. */
  rpcLagSeconds: number;

  phase: Phase;
  writesHalted: boolean;
  valoremFeeAccepted: boolean;
  valoremFeesEnabled: boolean;
  valoremFeeBps: number;
  /** null when the Stock Token has no `oraclePaused()` at all (older implementations). */
  oraclePaused: boolean | null;
  /** `vault.spotUsdg()`, or null when the read reverted (a stale feed: the vault's own gate). */
  spotUsdg6: bigint | null;
  spotError: string | null;

  vaultCycleNumber: number;
  vaultExerciseTs: bigint;
  vaultExpiryTs: bigint;
  vaultStrikeUsdg6: bigint;
  vaultOptionId: bigint;
  vaultClaimKey: bigint;
  /** == sold: the sum of CallsWritten over the cycle's claim. */
  contractsWritten: bigint;
  listingHash: Hex;
  listingGrossUsdg6: bigint;
  listingAmount: bigint;
  listingsThisCycle: number;
  idleAssets: bigint;
  totalAssets: bigint;
  lockedAssets: bigint;
  /** `phase == Idle && claimKey != 0`: rollClose could not redeem the claim. */
  isStranded: boolean;
  strandGen: bigint;
  queuedShares: bigint;
  policy: PolicyParams;

  keeperBalanceWei: bigint;
  hasKeeperRole: boolean;
}

const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

let lastSnapshot: ChainSnapshot | null = null;

export function getLastSnapshot(): ChainSnapshot | null {
  return lastSnapshot;
}

/** Set when a tick begins, cleared in its finally. /health reads this so a slow transaction
 *  holding the loop (a rollClose can wait out the whole receipt timeout) is not mistaken for
 *  a wedged loop — a 503 reader would restart a healthy keeper mid-transaction. */
let tickStartedAt: number | null = null;

export function getTickStartedAt(): number | null {
  return tickStartedAt;
}

/** Listing hashes this process has already invalidated once because the vault authorised them
 *  and the database has no row (see pollLiveListing). Once per hash per boot: if the
 *  invalidation reverts, the alert's hourly cooldown is the backstop against tx spam. */
const invalidatedUnservable = new Set<string>();

/*//////////////////////////////////////////////////////////////
                            SNAPSHOT
//////////////////////////////////////////////////////////////*/

export async function snapshot(): Promise<ChainSnapshot> {
  const block = await publicClient.getBlock({ blockTag: 'latest' });

  const [
    phaseRaw,
    writesHalted,
    valoremFeeAccepted,
    vaultCycleNumber,
    vaultExerciseTs,
    vaultExpiryTs,
    vaultStrikeUsdg6,
    vaultOptionId,
    vaultClaimKey,
    contractsWritten,
    listingHash,
    listingGrossUsdg6,
    listingAmount,
    listingsThisCycle,
    idleAssets,
    totalAssets,
    lockedAssets,
    isStranded,
    strandGen,
    queuedShares,
    keeperRole,
  ] = await Promise.all([
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'phase' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'writesHalted' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'valoremFeeAccepted' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'cycleNumber' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'cycleExerciseTs' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'cycleExpiryTs' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'cycleStrikeUsdg' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'optionId' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'claimKey' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'contractsWritten' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'listingHash' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'listingGrossUsdg' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'listingAmount' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'listingsThisCycle' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'idleAssets' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'totalAssets' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'lockedAssets' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'isStranded' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'strandGen' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'queuedShares' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'KEEPER_ROLE' }),
  ]);

  const [valoremFeesEnabled, valoremFeeBps, keeperBalanceWei, hasKeeperRole, policy] = await Promise.all([
    publicClient.readContract({ address: config.CLEARINGHOUSE, abi: clearAbi, functionName: 'feesEnabled' }),
    publicClient.readContract({ address: config.CLEARINGHOUSE, abi: clearAbi, functionName: 'feeBps' }),
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({
      address: config.VAULT,
      abi: vaultAbi,
      functionName: 'hasRole',
      args: [keeperRole, account.address],
    }),
    readPolicy(),
  ]);

  const spot = await readSpot();

  const snap: ChainSnapshot = {
    at: Date.now(),
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
    rpcLagSeconds: Math.max(0, Math.floor(Date.now() / 1000) - Number(block.timestamp)),
    phase: phaseRaw as Phase,
    writesHalted,
    valoremFeeAccepted,
    valoremFeesEnabled,
    valoremFeeBps,
    oraclePaused: await readOraclePaused(),
    spotUsdg6: spot.value,
    spotError: spot.error,
    vaultCycleNumber,
    vaultExerciseTs: BigInt(vaultExerciseTs),
    vaultExpiryTs: BigInt(vaultExpiryTs),
    vaultStrikeUsdg6,
    vaultOptionId,
    vaultClaimKey,
    contractsWritten: BigInt(contractsWritten),
    listingHash,
    listingGrossUsdg6,
    listingAmount,
    listingsThisCycle,
    idleAssets,
    totalAssets,
    lockedAssets,
    isStranded,
    strandGen,
    queuedShares,
    policy,
    keeperBalanceWei,
    hasKeeperRole,
  };

  lastSnapshot = snap;
  return snap;
}

/** The Stock Token can halt its own oracle. Probed, never assumed: an older implementation
 *  does not have the function and a hard call would make the keeper think the chain is broken. */
async function readOraclePaused(): Promise<boolean | null> {
  try {
    return await publicClient.readContract({
      address: config.ASSET,
      abi: stockTokenAbi,
      functionName: 'oraclePaused',
    });
  } catch {
    return null;
  }
}

/** `spotUsdg()` reverts `StalePrice` on a stale feed. That is the vault's own gate — it refuses
 *  to arm, approve or fill for the same reason — so the revert is a fact of the snapshot, not
 *  a failure of it. */
async function readSpot(): Promise<{ value: bigint | null; error: string | null }> {
  try {
    const value = await publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'spotUsdg' });
    return { value, error: null };
  } catch (error) {
    return { value: null, error: describeError(error) };
  }
}

/** The vault's remaining capacity at this snapshot: what the next listing may offer. */
export function snapshotCapacity(snap: Pick<ChainSnapshot, 'totalAssets' | 'contractsWritten' | 'policy'>): bigint {
  return capacityOf(snap.totalAssets, snap.contractsWritten, snap.policy);
}

/*//////////////////////////////////////////////////////////////
                        TRANSACTION PLUMBING
//////////////////////////////////////////////////////////////*/

export function describeError(error: unknown): string {
  if (error instanceof BaseError) {
    const cause = error.walk();
    const short = error.shortMessage || error.message;
    const detail = cause instanceof BaseError && cause.shortMessage !== short ? ` (${cause.shortMessage})` : '';
    return `${short}${detail}${describeRevert(error)}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * The decoded custom error, if the chain of causes holds one.
 *
 * viem keeps a decoded error's NAME out of `shortMessage`: for `StrikeBelowBand(226, 231)` the
 * short message is only 'The contract function "rollOpen" reverted.' and the name and arguments
 * sit in `.data`. Before this, every `tx_revert` alert said "reverted" and nothing else — and
 * the alert is what an operator reads at 20:00 UTC on a Friday. Every error the vault and its
 * two linked libraries can throw is in abi.ts, so a revert through `simulateContract` decodes
 * here; abi.test.ts pins that list against the compiled artifacts. An undecodable revert is
 * reported by selector rather than swallowed.
 */
function describeRevert(error: BaseError): string {
  const revert = error.walk((candidate) => candidate instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return '';
  if (revert.data) {
    const args = (revert.data.args ?? []).map((value) => String(value)).join(', ');
    return `: ${revert.data.errorName}(${args})`;
  }
  if (revert.signature) return `: undecoded error ${revert.signature}`;
  return '';
}

/** The decoded custom error's NAME, if any — for branching on `StillStranded` and friends. */
export function revertName(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const revert = error.walk((candidate) => candidate instanceof ContractFunctionRevertedError);
  return revert instanceof ContractFunctionRevertedError ? revert.data?.errorName ?? null : null;
}

/** Simulate first, always. A revert here costs nothing; a revert on chain costs gas, a nonce,
 *  and — during the selling window — time we may not get back. */
async function guardedSimulate<T>(kind: TxKind, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    const reason = describeError(error);
    await alert('tx_revert', `${kind} would revert: ${reason}`, { kind, reason }, { dedupeKey: kind });
    log.roll.error({ kind, reason }, 'simulation reverted; not sending');
    return null;
  }
}

async function sendAndConfirm(
  kind: TxKind,
  cycleNumber: number | null,
  send: () => Promise<Hash>,
): Promise<TransactionReceipt | null> {
  let hash: Hash;
  try {
    hash = await send();
  } catch (error) {
    const reason = describeError(error);
    await alert('tx_revert', `${kind} submission failed: ${reason}`, { kind, reason }, { dedupeKey: kind });
    return null;
  }

  store.recordTxSubmitted(hash, kind, cycleNumber);
  log.roll.info({ kind, hash, cycleNumber }, 'transaction submitted');

  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      timeout: config.KEEPER_TX_TIMEOUT_MS,
      confirmations: 1,
    });
    if (receipt.status === 'success') {
      store.recordTxResult(hash, 'success', receipt.blockNumber, receipt.gasUsed, null);
      clearAlert('tx_revert', kind);
      log.roll.info({ kind, hash, block: receipt.blockNumber, gas: receipt.gasUsed }, 'transaction confirmed');
      return receipt;
    }
    store.recordTxResult(hash, 'reverted', receipt.blockNumber, receipt.gasUsed, 'receipt status: reverted');
    await alert('tx_revert', `${kind} reverted on chain`, { kind, hash }, { dedupeKey: kind, force: true });
    return null;
  } catch (error) {
    const reason = describeError(error);
    store.recordTxResult(hash, 'pending', null, null, reason);
    await alert(
      'tx_revert',
      `${kind} was submitted but not confirmed in time: ${reason}`,
      { kind, hash, reason },
      { dedupeKey: kind },
    );
    return null;
  }
}

/*//////////////////////////////////////////////////////////////
                          BOOT RECONCILE
//////////////////////////////////////////////////////////////*/

/**
 * Make the keeper's memory agree with the chain before it is allowed to act.
 *
 * This is what makes a restart safe. The keeper never assumes its database is complete: it
 * checks the vault's wiring against config, resolves transactions it lost track of, refreshes
 * every non-terminal listing from Seaport, adopts an open cycle it has no row for (which
 * happens if it died between `rollOpen` landing and the write to SQLite), and closes out from
 * chain logs a cycle whose `rollClose` it never witnessed (which happens if it was down through
 * expiry and anyone called the permissionless close).
 */
export async function reconcile(): Promise<void> {
  await assertWiring();
  await reconcilePendingTxs();
  const snap = await snapshot();
  await adoptOpenCycle(snap);
  await closeUnwitnessedCycle(snap);
  await refreshListings();
  log.boot.info(
    {
      phase: PHASE_NAMES[snap.phase],
      vaultCycle: snap.vaultCycleNumber,
      stranded: snap.isStranded,
      listingHash: snap.listingHash,
      rows: store.counts(),
    },
    'reconciled against chain state',
  );
}

/**
 * Refuse to run against a vault that is not the one this config describes.
 *
 * The vault knows its own asset, USDG, clearinghouse, Seaport and conduit key, and it is its own
 * Seaport zone; every one is compared with the environment. The clearinghouse matters most:
 * with no registry the keeper creates option types on `CLEARINGHOUSE`, and a type created on a
 * different Clear than the vault's would arm nothing but burn gas.
 */
async function assertWiring(): Promise<void> {
  const [asset, usdg, clear, seaport, conduitKey, zone, transferTarget] = await Promise.all([
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'asset' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'usdg' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'clear' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'seaport' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'conduitKey' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'seaportZone' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'transferApprovalTarget' }),
  ]);

  const mismatches: string[] = [];
  const check = (name: string, onChain: string, configured: string) => {
    if (onChain.toLowerCase() !== configured.toLowerCase()) {
      mismatches.push(`${name}: vault says ${onChain}, config says ${configured}`);
    }
  };
  check('asset', asset, config.ASSET);
  check('usdg', usdg, config.USDG);
  check('clearinghouse', clear, config.CLEARINGHOUSE);
  check('seaport', seaport, config.SEAPORT);
  check('conduitKey', conduitKey, config.SEAPORT_CONDUIT_KEY);
  check('seaportZone', zone, config.VAULT);

  if (mismatches.length > 0) {
    throw new Error(
      `Keeper config does not match the deployed vault at ${config.VAULT}:\n  ${mismatches.join('\n  ')}\n` +
        'Fix the environment. Creating option types on the wrong clearinghouse arms nothing.',
    );
  }

  // Seaport pulls the freshly minted ERC-1155 straight out of the vault inside every fill.
  // Without this approval every fill reverts in the transfer step, after the write.
  const approved = await publicClient.readContract({
    address: config.CLEARINGHOUSE,
    abi: clearAbi,
    functionName: 'isApprovedForAll',
    args: [config.VAULT, transferTarget],
  });
  if (!approved) {
    await alert(
      'listing_unfillable',
      `vault has not approved ${transferTarget} to move its option tokens; every fill will fail`,
      { transferTarget },
      { force: true, severity: 'error' },
    );
  }

  const keeperRole = await publicClient.readContract({
    address: config.VAULT,
    abi: vaultAbi,
    functionName: 'KEEPER_ROLE',
  });
  const hasRole = await publicClient.readContract({
    address: config.VAULT,
    abi: vaultAbi,
    functionName: 'hasRole',
    args: [keeperRole, account.address],
  });
  if (!hasRole) {
    // Not fatal. lockBook, settleQueue and retryStrandedClaim are permissionless and rollClose
    // opens to anyone an hour after expiry, so a keeper without the role is still useful — it
    // just cannot arm a new cycle or authorise a listing.
    await alert(
      'boot',
      `keeper ${account.address} does not hold KEEPER_ROLE on ${config.VAULT}; it can close but not open`,
      { keeper: account.address },
      { force: true, severity: 'warn' },
    );
  }
}

async function reconcilePendingTxs(): Promise<void> {
  for (const row of store.pendingTxs()) {
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: row.hash as Hash });
      store.recordTxResult(
        row.hash,
        receipt.status === 'success' ? 'success' : 'reverted',
        receipt.blockNumber,
        receipt.gasUsed,
        receipt.status === 'success' ? null : 'receipt status: reverted',
      );
      log.boot.info({ hash: row.hash, kind: row.kind, status: receipt.status }, 'resolved a transaction we lost');
    } catch {
      // Still unmined, or dropped. Leave it pending; the next boot looks again.
      log.boot.warn({ hash: row.hash, kind: row.kind }, 'transaction still unresolved');
    }
  }
}

/** If the vault is mid-cycle and we have no row for it, write one from chain state. */
async function adoptOpenCycle(snap: ChainSnapshot): Promise<void> {
  if (snap.phase === Phase.Idle || snap.vaultCycleNumber === 0) return;
  if (store.getCycle(snap.vaultCycleNumber)) return;

  store.ensureCycle(snap.vaultCycleNumber, snap.phase === Phase.Listed ? 'open' : 'locked');
  store.updateCycle(snap.vaultCycleNumber, {
    option_id: snap.vaultOptionId.toString(),
    strike_usdg6: snap.vaultStrikeUsdg6.toString(),
    contracts: Number(snap.contractsWritten),
    exercise_ts: Number(snap.vaultExerciseTs),
    expiry_ts: Number(snap.vaultExpiryTs),
    lot_size: '1000000000000000000',
    opened_at: Date.now(),
  });
  // The row is created without its rollOpen hash; recover it from the txs table when the
  // submission was ours (harvestForCycle sums from the rollOpen BLOCK).
  backfillOpenTx(snap.vaultCycleNumber);
  log.boot.warn(
    { cycleNumber: snap.vaultCycleNumber, phase: PHASE_NAMES[snap.phase] },
    'adopted an open cycle the database had no record of',
  );
}

/**
 * Close out, from the chain's own logs, a cycle the chain says is already closed.
 *
 * phase Idle with a nonzero `cycleNumber` and an expiry still on the vault means rollClose
 * already ran for the last cycle the vault armed: rollOpen is the only way in and rollClose
 * the only way back. Two triggers land here — the keeper down through expiry while someone
 * called the permissionless `rollClose()`, or our own rollClose receipt timing out as the tx
 * landed — and a third, rarer one: another operator running the entire week while this keeper
 * was down. Without this the row sits 'open'/'locked' forever: harvest never summed, listings
 * never retired, no roll_close alert. A close that STRANDED the claim (ClaimStranded in the same
 * receipt) is recorded as such, not as closed. Never throws: a log-query failure degrades to a
 * warn and a retry next tick, never a boot failure.
 */
async function closeUnwitnessedCycle(snap: ChainSnapshot): Promise<void> {
  if (snap.phase !== Phase.Idle || snap.vaultCycleNumber === 0 || snap.vaultExpiryTs === 0n) return;
  const recorded = store.getCycle(snap.vaultCycleNumber);
  if (recorded !== null && (recorded.status === 'closed' || recorded.status === 'stranded')) return;
  try {
    await closeCycleFromLogs(snap.vaultCycleNumber, snap);
  } catch (error) {
    log.roll.warn(
      { cycleNumber: snap.vaultCycleNumber, err: describeError(error) },
      'could not reconstruct the closed cycle from logs; will retry',
    );
  }
}

async function closeCycleFromLogs(cycleNumber: number, snap: ChainSnapshot): Promise<void> {
  const closeLogs = await logClient.getLogs({
    address: config.VAULT,
    event: rollCloseEvent,
    args: { cycleNumber },
    fromBlock: 0n,
    toBlock: snap.blockNumber,
  });
  const closeLog = closeLogs[closeLogs.length - 1];
  if (!closeLog) {
    // The phase machine says the close ran, so a missing log means the archive node is not
    // serving the range. Write nothing; the next tick asks again.
    log.roll.warn({ cycleNumber }, 'the vault is back to Idle but no RollClose log is findable');
    return;
  }

  let openLog: Awaited<ReturnType<typeof findRollOpenLog>> = null;
  try {
    openLog = await findRollOpenLog(cycleNumber, closeLog.blockNumber);
  } catch (error) {
    log.roll.warn({ cycleNumber, err: describeError(error) }, 'could not read the RollOpen log');
  }
  const submitted = store.latestTxForCycle('rollOpen', cycleNumber);
  const submittedBlock =
    submitted !== null && submitted.status === 'success' && submitted.block_number !== null
      ? BigInt(submitted.block_number)
      : null;
  // The Harvest filter is on the indexed cycleNumber, so the sum is exact from ANY lower
  // bound; the rollOpen block only tightens the archive scan. 0 is safe, just heavier.
  const fromBlock = openLog?.blockNumber ?? submittedBlock ?? 0n;

  const harvestLogs = await logClient.getLogs({
    address: config.VAULT,
    event: harvestEvent,
    args: { cycleNumber },
    fromBlock,
    toBlock: closeLog.blockNumber,
  });
  let gross = 0n;
  let fee = 0n;
  let net = 0n;
  for (const entry of harvestLogs) {
    gross += entry.args.grossUsdg ?? 0n;
    fee += entry.args.feeUsdg ?? 0n;
    net += entry.args.netUsdg ?? 0n;
  }

  // The week's sold count: RollOpen.contractsCount is always 0, so it is the sum of CallsWritten
  // over the armed option id between the arm and the close.
  const optionId = openLog?.args.optionId ?? (snap.vaultOptionId !== 0n ? snap.vaultOptionId : null);
  const written = optionId === null ? null : await sumCallsWritten(optionId, fromBlock, closeLog.blockNumber);

  // A ClaimStranded in the same transaction means the claim is still open in Valorem.
  const strandedLogs = await logClient.getLogs({
    address: config.VAULT,
    event: claimStrandedEvent,
    args: { cycleNumber },
    fromBlock: closeLog.blockNumber,
    toBlock: closeLog.blockNumber,
  });
  const stranded = strandedLogs.find((entry) => entry.transactionHash === closeLog.transactionHash) ?? null;

  const assigned = Number(closeLog.args.contractsAssignedCount ?? 0n);
  // Both straight from the RollClose log. A log that somehow lacks them reads null ("unknown"),
  // never 0: a 0 here would publish an assigned week's strike proceeds as premium.
  const assetsReturned = closeLog.args.assetsReturned ?? null;
  const usdgFromAssignment = closeLog.args.usdgFromAssignment ?? null;

  // Same retirement as doRollClose: the close bumped the Seaport counter, which kills every
  // still-live order without setting isCancelled.
  for (const live of store.liveListingsForCycle(cycleNumber)) {
    store.updateListing(live.order_hash, { status: 'expired' });
  }

  const existing = store.getCycle(cycleNumber);
  const status = stranded ? 'stranded' : 'closed';
  store.ensureCycle(cycleNumber, status);
  const patch: Partial<CycleRow> = {
    status,
    roll_close_tx: closeLog.transactionHash,
    closed_at: Date.now(),
    gross_usdg6: gross.toString(),
    fee_usdg6: fee.toString(),
    net_usdg6: net.toString(),
    contracts_assigned: assigned,
    assets_returned: assetsReturned === null ? null : assetsReturned.toString(),
    usdg_from_assignment: usdgFromAssignment === null ? null : usdgFromAssignment.toString(),
    strand_gen: stranded ? (stranded.args.gen ?? 0n).toString() : null,
  };
  if (written !== null) patch.contracts = Number(written);
  if (existing === null) {
    // A week another operator ran end to end. The vault zeroed optionId at the redeem, so the
    // arm details come from the RollOpen log; the cycle timestamps survive the close.
    patch.exercise_ts = Number(snap.vaultExerciseTs);
    patch.expiry_ts = Number(snap.vaultExpiryTs);
    patch.lot_size = '1000000000000000000';
    if (openLog) {
      patch.option_id = openLog.args.optionId?.toString() ?? null;
      patch.strike_usdg6 = openLog.args.strikeUsdg?.toString() ?? null;
    }
  }
  store.updateCycle(cycleNumber, patch);
  backfillOpenTx(cycleNumber);

  const summary: RollCloseSummary = {
    cycleNumber,
    gross,
    fee,
    net,
    usdgFromAssignment,
    assetsReturned,
    contractsAssigned: assigned,
    witnessedLive: false,
    stranded: stranded !== null,
  };
  await alert(
    'roll_close',
    rollCloseMessage(summary),
    { ...rollCloseAlertData(summary), tx: closeLog.transactionHash, witnessedLive: false },
    { force: true },
  );
  if (stranded) await alertStranded(cycleNumber, stranded.args.gen ?? 0n, snap.vaultClaimKey, closeLog.transactionHash);
  log.boot.warn(
    { cycleNumber, closeTx: closeLog.transactionHash, grossUsdg6: gross.toString(), stranded: stranded !== null },
    'closed a cycle from chain logs that this keeper never witnessed',
  );
}

/**
 * The RollOpen log for a cycle, or null. Its block is where the harvest and CallsWritten sums
 * start; its args carry the option id and strike, which the vault zeroes by the time a close is
 * being reconstructed.
 */
async function findRollOpenLog(cycleNumber: number, toBlock: bigint) {
  const logs = await logClient.getLogs({
    address: config.VAULT,
    event: rollOpenEvent,
    args: { cycleNumber },
    fromBlock: 0n,
    toBlock,
  });
  return logs[0] ?? null;
}

/** Sum of CallsWritten.contractsCount for an option id over a block range: the contracts sold. */
async function sumCallsWritten(optionId: bigint, fromBlock: bigint, toBlock: bigint): Promise<bigint> {
  const logs = await logClient.getLogs({
    address: config.VAULT,
    event: callsWrittenEvent,
    args: { optionId },
    fromBlock,
    toBlock,
  });
  let sum = 0n;
  for (const entry of logs) sum += BigInt(entry.args.contractsCount ?? 0n);
  return sum;
}

/**
 * The block this cycle's rollOpen landed in. Order: the cycle row's recorded hash, then any
 * recorded rollOpen submission for the cycle (the txs table is written BEFORE the receipt wait,
 * so it outlives a lost receipt), then the chain's own RollOpen log — its cycleNumber is
 * indexed, so the query is one filtered scan. null when none of the three knows.
 */
async function resolveOpenBlock(cycleNumber: number, toBlock: bigint): Promise<bigint | null> {
  const recordedHash = store.getCycle(cycleNumber)?.roll_open_tx ?? null;
  const rowBlock = recordedHash ? store.getTx(recordedHash)?.block_number ?? null : null;
  if (rowBlock !== null) return BigInt(rowBlock);
  const submitted = store.latestTxForCycle('rollOpen', cycleNumber);
  if (submitted !== null && submitted.status === 'success' && submitted.block_number !== null) {
    return BigInt(submitted.block_number);
  }
  const openLog = await findRollOpenLog(cycleNumber, toBlock);
  return openLog ? openLog.blockNumber : null;
}

/** A cycle row written without its rollOpen hash is a hole in the tape: harvestForCycle sums
 *  from the rollOpen BLOCK and /cycles shows the hash. The keeper records every submission
 *  before the receipt wait, so the hash is usually still in the txs table. */
function backfillOpenTx(cycleNumber: number): void {
  const row = store.getCycle(cycleNumber);
  if (row === null || row.roll_open_tx !== null) return;
  const submitted = store.latestTxForCycle('rollOpen', cycleNumber);
  if (submitted !== null) {
    store.updateCycle(cycleNumber, { roll_open_tx: submitted.hash });
    log.roll.info({ cycleNumber, hash: submitted.hash }, 'backfilled roll_open_tx from the txs table');
  }
}

/** Refresh every listing that is not in a terminal state from Seaport's own order status. */
async function refreshListings(): Promise<void> {
  for (const row of store.openListings()) {
    try {
      const status = await readOrderStatus(row.order_hash as Hex);
      applySeaportStatus(row.order_hash, row.status, status);
    } catch (error) {
      log.boot.warn({ orderHash: row.order_hash, err: describeError(error) }, 'could not refresh a listing');
    }
  }
}

/**
 * What Seaport's own order status says the lifecycle is. `cancelled` and `expired` are latches:
 * Seaport counters only move forward and a cancelled order never comes back. A counter bump
 * (invalidateAllListings, lockBook, rollClose) kills an order WITHOUT setting `isCancelled`, so
 * the vault's `listingHash` going to zero is what retires those rows (retireUnauthorisedListings),
 * not this verdict.
 */
export function seaportVerdict(current: ListingStatus, status: SeaportOrderStatus): ListingStatus {
  if (current === 'cancelled' || current === 'expired') return current;
  if (status.isFullyFilled) return 'filled';
  if (status.isCancelled) return 'cancelled';
  if (status.totalFilled > 0n) return 'partial';
  return current === 'filled' ? 'partial' : current;
}

function applySeaportStatus(orderHash: string, current: ListingStatus, status: SeaportOrderStatus): ListingStatus {
  const next = seaportVerdict(current, status);
  store.updateListing(orderHash, {
    status: next,
    seaport_total_filled: status.totalFilled.toString(),
    seaport_total_size: status.totalSize.toString(),
    seaport_cancelled: status.isCancelled ? 1 : 0,
  });
  return next;
}

/*//////////////////////////////////////////////////////////////
                          HEALTH ALERTS
//////////////////////////////////////////////////////////////*/

const FEES_ENABLED_KEY = 'clear_fees_enabled';

async function raiseHealthAlerts(snap: ChainSnapshot): Promise<void> {
  if (snap.rpcLagSeconds * 1000 > config.KEEPER_RPC_LAG_ALERT_MS) {
    await alert('rpc_lag', `head block trails the wall clock by ${snap.rpcLagSeconds}s`, {
      blockNumber: snap.blockNumber.toString(),
      lagSeconds: snap.rpcLagSeconds,
    });
  } else {
    clearAlert('rpc_lag');
  }

  if (snap.keeperBalanceWei < config.KEEPER_MIN_GAS_WEI) {
    await alert('low_gas', `keeper gas balance is ${formatEth(snap.keeperBalanceWei)} ETH; top it up`, {
      keeper: account.address,
      balanceWei: snap.keeperBalanceWei.toString(),
      thresholdWei: config.KEEPER_MIN_GAS_WEI.toString(),
    });
  } else {
    clearAlert('low_gas');
  }

  // The fee switch moving in either direction is a state change worth a line: on, it changes
  // what every fill must pay; off again, the vault's accepted flag is now moot.
  const seenFees = store.getMeta(FEES_ENABLED_KEY);
  const nowFees = snap.valoremFeesEnabled ? '1' : '0';
  if (seenFees !== null && seenFees !== nowFees) {
    await alert(
      'fee_switch',
      `Valorem's engine fee switch is now ${snap.valoremFeesEnabled ? 'ON' : 'OFF'} (${snap.valoremFeeBps} bps of notional)`,
      { feesEnabled: snap.valoremFeesEnabled, feeBps: snap.valoremFeeBps, feeAccepted: snap.valoremFeeAccepted },
      { force: true },
    );
  }
  if (seenFees !== nowFees) store.setMeta(FEES_ENABLED_KEY, nowFees);

  // Valorem's engine fee is 15 bps of NOTIONAL, which on a weekly OTM call eats most of the
  // premium. The vault refuses to arm and to fill while it is on unless governance has accepted it.
  if (snap.valoremFeesEnabled && !snap.valoremFeeAccepted) {
    await alert(
      'valorem_fees_enabled',
      `Valorem's engine fee is on (${snap.valoremFeeBps} bps). The vault will not arm or fill ` +
        'until an admin calls acceptValoremFee(true).',
      { feeBps: snap.valoremFeeBps },
    );
  } else {
    clearAlert('valorem_fees_enabled');
  }

  if (snap.oraclePaused === true) {
    await alert('oracle_paused', 'the Stock Token has paused its oracle; the vault will refuse to arm or fill', {});
  } else {
    clearAlert('oracle_paused');
  }

  // The guardian path opens an hour after expiry; if we are still here, say so loudly.
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (snap.phase !== Phase.Idle && snap.vaultExpiryTs > 0n && nowSec > snap.vaultExpiryTs + 3600n) {
    await alert(
      'phase_stuck',
      `vault is still ${PHASE_NAMES[snap.phase]} more than an hour after expiry; anyone can call rollClose() now`,
      {
        phase: PHASE_NAMES[snap.phase],
        expiryTs: snap.vaultExpiryTs.toString(),
        cycleNumber: snap.vaultCycleNumber,
      },
    );
  } else {
    clearAlert('phase_stuck');
  }
}

/*//////////////////////////////////////////////////////////////
                              TICK
//////////////////////////////////////////////////////////////*/

export async function tick(): Promise<void> {
  tickStartedAt = Date.now();
  try {
    let snap: ChainSnapshot;
    try {
      snap = await snapshot();
    } catch (error) {
      // The read client fails over between both RPCs, so a throw here means both are down.
      // That is an rpc_lag-grade fact — no reads, no writes, no closes — so name it before the
      // generic keeper_error path in index.ts proceeds.
      const reason = describeError(error);
      await alert('rpc_lag', `both RPC endpoints unreachable: ${reason}`, { reason });
      throw error;
    }
    store.beat(snap.at);
    await raiseHealthAlerts(snap);

    log.roll.debug(
      {
        phase: PHASE_NAMES[snap.phase],
        vaultCycle: snap.vaultCycleNumber,
        stranded: snap.isStranded,
        listingHash: snap.listingHash,
        contractsWritten: snap.contractsWritten.toString(),
        totalAssets: snap.totalAssets.toString(),
      },
      'tick',
    );

    switch (snap.phase) {
      case Phase.Idle:
        await onIdle(snap);
        break;
      case Phase.Listed:
        await onListed(snap);
        break;
      case Phase.Exercisable:
        await onExercisable(snap);
        break;
      case Phase.Settling:
        // rollClose does everything in one transaction, so this phase is not observable between
        // ticks. Seeing it means a transaction is mid-flight or something is very wrong.
        log.roll.warn({ cycleNumber: snap.vaultCycleNumber }, 'vault is Settling between ticks');
        break;
      default:
        log.roll.error({ phase: snap.phase }, 'unknown vault phase');
        break;
    }

    // Beat again on the way out: the heartbeat at tick START alone means a slow transaction
    // leaves /health stale for the whole receipt wait, and a 503 reader restarts the process.
    store.beat();
  } finally {
    tickStartedAt = null;
  }
}

/*//////////////////////////////////////////////////////////////
                             IDLE
//////////////////////////////////////////////////////////////*/

const SKIP_REASON_KEY = (exerciseTs: number) => `skip_reason:${exerciseTs}`;
const WEEK_TARGET_KEY = 'week_target_ts';
const WEEK_ARMED_KEY = 'week_armed_ts';

/** The week the keeper would arm next, from the head block's clock. Exported for /state. */
export function nextWindow(snap: Pick<ChainSnapshot, 'blockTimestamp'>): WeekWindow {
  return nextWeekWindow(Number(snap.blockTimestamp), config.KEEPER_ARM_LEAD_S, config.KEEPER_NYSE_HOLIDAYS);
}

async function onIdle(snap: ChainSnapshot): Promise<void> {
  // A close we never witnessed. phase Idle with a nonzero cycle number and an expiry still on
  // the vault means rollClose already ran for the last cycle the vault armed. Close the row out
  // from chain logs before anything else is decided.
  if (snap.vaultCycleNumber !== 0 && snap.vaultExpiryTs > 0n) {
    await closeUnwitnessedCycle(snap);
    await reconcileRecoveredStrand(snap);
  }

  // The queue settles while flat, permissionlessly. Stranded or not: while stranded it is the
  // queuers' only exit (their idle slice now, their claim share at the retry).
  if (snap.queuedShares > 0n) {
    await doSettleQueue(snap);
  }

  if (snap.isStranded) {
    await handleStranded(snap);
    return;
  }

  const window = nextWindow(snap);
  await noteWeekRollover(window);

  if (snap.writesHalted) {
    await remember(window, 'writes-halted');
    log.roll.warn({ exerciseTs: window.exerciseTs }, 'writes are halted; not arming');
    return;
  }
  if (!snap.hasKeeperRole) {
    await remember(window, 'no-keeper-role');
    return;
  }
  if (snap.valoremFeesEnabled && !snap.valoremFeeAccepted) {
    await remember(window, 'valorem-fees-enabled');
    return;
  }
  if (snap.oraclePaused === true) {
    await remember(window, 'oracle-paused');
    return;
  }
  if (snap.spotUsdg6 === null) {
    // `spotUsdg()` reverts on a stale feed. That is the vault's own gate and it will reject
    // `rollOpen` for the same reason, so stop here rather than burn a simulation.
    await remember(window, `stale-oracle: ${snap.spotError ?? 'unknown'}`);
    return;
  }

  const plan = planWeek({
    policy: snap.policy,
    spotUsdg6: snap.spotUsdg6,
    totalAssets: snap.totalAssets,
    contractsWritten: snap.contractsWritten,
    feesEnabled: snap.valoremFeesEnabled,
    feeBps: snap.valoremFeeBps,
  });
  if (!plan.ok) {
    await remember(window, plan.reason);
    log.roll.info({ exerciseTs: window.exerciseTs, reason: plan.reason, ...plan.detail }, 'not arming this tick');
    return;
  }

  /* ---- the option type ---- */

  const tuple = weeklyTuple(config.ASSET, config.USDG, plan.strikeUsdg6, window.exerciseTs, window.expiryTs);
  const optionId = await ensureOptionType(tuple);
  if (optionId === null) {
    await remember(window, 'option-type-failed');
    return;
  }

  /* ---- rollOpen: arm only ---- */

  const sim = await guardedSimulate('rollOpen', () =>
    publicClient.simulateContract({
      address: config.VAULT,
      abi: vaultAbi,
      functionName: 'rollOpen',
      args: [optionId],
      account,
    }),
  );
  if (!sim) {
    await remember(window, 'rollOpen-would-revert');
    return;
  }

  // The cycle number is the vault's: read it from the RollOpen log rather than guessing +1.
  const receipt = await sendAndConfirm('rollOpen', null, () => walletClient.writeContract(sim.request));
  if (!receipt) return;
  const opened = parseEventLogs({ abi: vaultAbi, eventName: 'RollOpen', logs: receipt.logs }).find(
    (event) => event.address.toLowerCase() === config.VAULT.toLowerCase(),
  );
  const cycleNumber = opened ? Number(opened.args.cycleNumber) : snap.vaultCycleNumber + 1;
  // The submission was recorded without a cycle; attach it now that the number is known.
  store.db.prepare('UPDATE txs SET cycle_number = ? WHERE hash = ?').run(cycleNumber, receipt.transactionHash);

  store.ensureCycle(cycleNumber, 'open');
  store.updateCycle(cycleNumber, {
    status: 'open',
    option_id: optionId.toString(),
    strike_usdg6: plan.strikeUsdg6.toString(),
    contracts: 0,
    exercise_ts: window.exerciseTs,
    expiry_ts: window.expiryTs,
    lot_size: tuple.underlyingAmount.toString(),
    roll_open_tx: receipt.transactionHash,
    opened_at: Date.now(),
  });
  store.setMeta(WEEK_ARMED_KEY, String(window.exerciseTs));

  await alert(
    'roll_open',
    `cycle ${cycleNumber}: armed strike ${formatUsdg(plan.strikeUsdg6)} USDG for the ${window.friday} close ` +
      `(${describeInstant(window.exerciseTs)}); capacity ${plan.contracts} contracts, nothing written yet`,
    {
      cycleNumber,
      optionId: optionId.toString(),
      strikeUsdg: formatUsdg(plan.strikeUsdg6),
      capacity: plan.contracts.toString(),
      exerciseTs: window.exerciseTs,
      expiryTs: window.expiryTs,
      closeDay: window.closeDay,
      spotUsdg: formatUsdg(plan.spotUsdg6),
      tx: receipt.transactionHash,
    },
    { force: true },
  );

  // List in the same tick: every minute between arming and listing is a minute nothing can sell.
  const after = await snapshot();
  await createListing(after);
}

/**
 * The option id for the tuple, creating the type on Clear when it does not exist yet.
 *
 * The id is a pure function of the tuple, so `tokenType(id)` decides: Option means it exists
 * (created by anyone, or by us on a tick whose receipt was lost) and is reused; None means
 * `newOptionType`, permissionless and paid from the keeper's gas. The NewOptionType log in the
 * receipt is the confirmation, and it must carry the precomputed id — a disagreement would mean
 * the derivation is wrong and the vault would be armed on nothing.
 */
async function ensureOptionType(tuple: OptionTuple): Promise<bigint | null> {
  const expected = optionIdFor(tuple);
  const kind = await publicClient.readContract({
    address: config.CLEARINGHOUSE,
    abi: clearAbi,
    functionName: 'tokenType',
    args: [expected],
  });
  if (kind === TOKEN_TYPE_OPTION) {
    log.roll.info({ optionId: expected.toString(), strikeUsdg6: tuple.exerciseAmount.toString() }, 'option type already exists; reusing it');
    return expected;
  }

  const sim = await guardedSimulate('newOptionType', () =>
    publicClient.simulateContract({
      address: config.CLEARINGHOUSE,
      abi: clearAbi,
      functionName: 'newOptionType',
      args: [
        tuple.underlyingAsset,
        tuple.underlyingAmount,
        tuple.exerciseAsset,
        tuple.exerciseAmount,
        tuple.exerciseTimestamp,
        tuple.expiryTimestamp,
      ],
      account,
    }),
  );
  if (!sim) {
    await alert('option_type_failed', 'clear.newOptionType would revert; the week cannot be armed', {
      strikeUsdg6: tuple.exerciseAmount.toString(),
      exerciseTs: tuple.exerciseTimestamp,
    });
    return null;
  }
  if (sim.result !== expected) {
    await alert(
      'option_type_failed',
      `clear.newOptionType would return ${sim.result} but the keeper derived ${expected}; refusing to arm on a mismatch`,
      { expected: expected.toString(), got: sim.result.toString() },
      { force: true },
    );
    return null;
  }

  const receipt = await sendAndConfirm('newOptionType', null, () => walletClient.writeContract(sim.request));
  if (!receipt) {
    await alert('option_type_failed', 'clear.newOptionType did not confirm; the week cannot be armed', {
      strikeUsdg6: tuple.exerciseAmount.toString(),
    });
    return null;
  }
  const created = parseEventLogs({ abi: clearAbi, eventName: 'NewOptionType', logs: receipt.logs }).find(
    (event) => event.address.toLowerCase() === config.CLEARINGHOUSE.toLowerCase(),
  );
  if (!created || created.args.optionId !== expected) {
    await alert(
      'option_type_failed',
      `newOptionType confirmed but its NewOptionType log ${created ? `names ${created.args.optionId}` : 'is missing'}; expected ${expected}`,
      { tx: receipt.transactionHash, expected: expected.toString() },
      { force: true },
    );
    return null;
  }
  log.roll.info(
    { optionId: expected.toString(), strikeUsdg6: tuple.exerciseAmount.toString(), tx: receipt.transactionHash },
    'created the week’s option type on Clear',
  );
  return expected;
}

/**
 * Remember why we did not arm, so the week's alert carries an honest reason. Keyed by the
 * exercise timestamp the arm would have used: there is no cycle number for a week that was
 * never armed.
 */
async function remember(window: WeekWindow, reason: string): Promise<void> {
  store.setMeta(SKIP_REASON_KEY(window.exerciseTs), reason);
  if (reason.startsWith('stale-oracle')) {
    // A stale feed silently blocks every arm for as long as it lasts. Surfacing it only when the
    // week rolls by means hearing about it once the week is already lost, so it warns while
    // there is still time to chase the feed. (oracle-paused gets no such line: the
    // snapshot-level oracle_paused alert already covers it.)
    await alert(
      'cycle_not_created',
      `week of ${window.friday}: ${reason}; the vault refuses to arm while the feed is stale`,
      { exerciseTs: window.exerciseTs, reason },
      { dedupeKey: `${window.exerciseTs}:stale-oracle` },
    );
  }
}

/**
 * A Friday went by without the vault being armed for it. Published once, when the next window
 * first differs from the last one the keeper was aiming at, with the last reason it recorded.
 * A week that WAS armed (week_armed_ts) is not a missed week, whatever happened to it after.
 */
async function noteWeekRollover(window: WeekWindow): Promise<void> {
  const previous = store.getMetaNumber(WEEK_TARGET_KEY);
  if (previous !== null && previous < window.exerciseTs) {
    const armed = store.getMetaNumber(WEEK_ARMED_KEY);
    if (armed !== previous) {
      const reason = store.getMeta(SKIP_REASON_KEY(previous)) ?? 'unknown';
      await alert(
        'cycle_not_created',
        `the week closing ${describeInstant(previous)} passed without a cycle (${reason}). Published as unfilled, 0.`,
        { exerciseTs: previous, reason },
        { dedupeKey: String(previous), force: true },
      );
    }
  }
  if (previous !== window.exerciseTs) store.setMeta(WEEK_TARGET_KEY, String(window.exerciseTs));
}

/*//////////////////////////////////////////////////////////////
                      STRANDED CLAIM (AF-02)
//////////////////////////////////////////////////////////////*/

const STRAND_ALERTED_KEY = (gen: bigint) => `strand_alerted:${gen}`;
const STRAND_RETRY_KEY = 'strand_retry_ms';

async function alertStranded(cycleNumber: number, gen: bigint, claimKey: bigint, tx: string): Promise<void> {
  if (store.getMeta(STRAND_ALERTED_KEY(gen)) !== null) return;
  store.setMeta(STRAND_ALERTED_KEY(gen), tx);
  await alert(
    'stranded',
    `cycle ${cycleNumber}: rollClose could not redeem the Valorem claim (strand generation ${gen}). The vault is Idle ` +
      'with the claim kept; deposits and instant redemption are shut, the queue still settles, and the keeper will ' +
      `retry retryStrandedClaim() every ${Math.round(config.KEEPER_RETRY_STRANDED_MS / 60_000)} minutes. ` +
      'Check USDG (pause / freeze of the vault or of Clear) and the Stock Token blocklist.',
    { cycleNumber, gen: gen.toString(), claimKey: claimKey.toString(), tx },
    { force: true },
  );
}

/**
 * Idle with a claim the close could not redeem. Nothing is armed over it (`rollOpen` reverts
 * `StillStranded`); the permissionless retry is attempted on a timer, simulated first so a
 * freeze that still holds costs no gas.
 */
async function handleStranded(snap: ChainSnapshot): Promise<void> {
  const cycleNumber = snap.vaultCycleNumber;
  await alertStranded(cycleNumber, snap.strandGen, snap.vaultClaimKey, store.getCycle(cycleNumber)?.roll_close_tx ?? '');

  const last = store.getMetaNumber(STRAND_RETRY_KEY) ?? 0;
  if (Date.now() - last < config.KEEPER_RETRY_STRANDED_MS) {
    log.roll.debug({ cycleNumber, gen: snap.strandGen.toString() }, 'stranded; retry timer has not elapsed');
    return;
  }
  store.setMeta(STRAND_RETRY_KEY, String(Date.now()));

  // Simulated by hand rather than through guardedSimulate: `StillStranded` is the expected
  // answer while the freeze holds and earns a `retry_failed` line, not a `tx_revert` page.
  const sim = await (async () => {
    try {
      return await publicClient.simulateContract({ address: config.VAULT, abi: vaultAbi, functionName: 'retryStrandedClaim', account });
    } catch (error) {
      const name = revertName(error);
      const reason = describeError(error);
      await alert(
        'retry_failed',
        `cycle ${cycleNumber}: retryStrandedClaim still reverts (${name ?? reason}); the cause has not cleared`,
        { cycleNumber, gen: snap.strandGen.toString(), reason },
        { dedupeKey: snap.strandGen.toString() },
      );
      log.roll.warn({ cycleNumber, reason }, 'stranded claim retry would revert');
      return null;
    }
  })();
  if (sim === null) return;

  const receipt = await sendAndConfirm('retryStrandedClaim', cycleNumber, () => walletClient.writeContract(sim.request));
  if (!receipt) return;
  await recordRecovery(cycleNumber, snap.strandGen, receipt, true);
}

/** The vault is no longer stranded but our row still says so: someone else ran the retry. */
async function reconcileRecoveredStrand(snap: ChainSnapshot): Promise<void> {
  const row = store.getCycle(snap.vaultCycleNumber);
  if (row === null || row.status !== 'stranded' || snap.isStranded) return;
  const gen = row.strand_gen === null ? snap.strandGen : BigInt(row.strand_gen);
  try {
    const logs = await logClient.getLogs({
      address: config.VAULT,
      event: {
        type: 'event',
        name: 'StrandedClaimRecovered',
        inputs: [
          { name: 'gen', type: 'uint256', indexed: true },
          { name: 'assets', type: 'uint256', indexed: false },
          { name: 'usdgOut', type: 'uint256', indexed: false },
          { name: 'queueWad', type: 'uint256', indexed: false },
        ],
      } as const,
      args: { gen },
      fromBlock: 0n,
      toBlock: snap.blockNumber,
    });
    const recovered = logs[logs.length - 1];
    if (!recovered) {
      log.roll.warn({ cycleNumber: snap.vaultCycleNumber, gen: gen.toString() }, 'the strand is resolved on chain but no StrandedClaimRecovered log is findable');
      return;
    }
    const receipt = await publicClient.getTransactionReceipt({ hash: recovered.transactionHash });
    await recordRecovery(snap.vaultCycleNumber, gen, receipt, false);
  } catch (error) {
    log.roll.warn({ err: describeError(error) }, 'could not reconcile the recovered strand; will retry');
  }
}

async function recordRecovery(cycleNumber: number, gen: bigint, receipt: TransactionReceipt, witnessedLive: boolean): Promise<void> {
  const recovered = parseEventLogs({ abi: vaultAbi, eventName: 'StrandedClaimRecovered', logs: receipt.logs }).find(
    (event) => event.address.toLowerCase() === config.VAULT.toLowerCase(),
  );
  // The retry's Harvest carries the stranded cycle's number, so the cycle sum now includes it.
  const harvest = await harvestForCycle(cycleNumber, receipt);
  store.ensureCycle(cycleNumber, 'closed');
  store.updateCycle(cycleNumber, {
    status: 'closed',
    retry_tx: receipt.transactionHash,
    strand_gen: gen.toString(),
    gross_usdg6: harvest.gross.toString(),
    fee_usdg6: harvest.fee.toString(),
    net_usdg6: harvest.net.toString(),
    assets_returned: recovered ? recovered.args.assets.toString() : null,
    usdg_from_assignment: recovered ? recovered.args.usdgOut.toString() : null,
  });
  clearAlert('retry_failed', gen.toString());
  await alert(
    'stranded_recovered',
    `cycle ${cycleNumber}: the stranded claim (generation ${gen}) was redeemed` +
      (recovered ? `: ${recovered.args.assets} asset wei and ${formatUsdg(recovered.args.usdgOut)} USDG came home` : '') +
      `; ${formatUsdg(harvest.net)} USDG to depositors over the cycle.` +
      (witnessedLive ? '' : ' The retry ran without this keeper; reconstructed from chain logs.'),
    {
      cycleNumber,
      gen: gen.toString(),
      assets: recovered ? recovered.args.assets.toString() : null,
      usdgOut: recovered ? formatUsdg(recovered.args.usdgOut) : null,
      queueWad: recovered ? recovered.args.queueWad.toString() : null,
      tx: receipt.transactionHash,
      witnessedLive,
    },
    { force: true },
  );
}

/*//////////////////////////////////////////////////////////////
                           SETTLE QUEUE
//////////////////////////////////////////////////////////////*/

/** Permissionless: settle a redeem queue joined while the vault is flat (Idle). */
async function doSettleQueue(snap: ChainSnapshot): Promise<void> {
  const sim = await guardedSimulate('settleQueue', () =>
    publicClient.simulateContract({ address: config.VAULT, abi: vaultAbi, functionName: 'settleQueue', account }),
  );
  if (!sim) return;
  const receipt = await sendAndConfirm('settleQueue', snap.vaultCycleNumber || null, () => walletClient.writeContract(sim.request));
  if (!receipt) return;
  const settled = parseEventLogs({ abi: vaultAbi, eventName: 'QueueSettled', logs: receipt.logs }).find(
    (event) => event.address.toLowerCase() === config.VAULT.toLowerCase(),
  );
  await alert(
    'queue_settled',
    settled
      ? `settled redeem epoch ${settled.args.epochId}: ${settled.args.shares} shares for ${settled.args.assets} asset wei and ${formatUsdg(settled.args.usdgOut)} USDG`
      : 'settleQueue confirmed',
    {
      epochId: settled ? settled.args.epochId.toString() : null,
      shares: settled ? settled.args.shares.toString() : null,
      assets: settled ? settled.args.assets.toString() : null,
      usdgOut: settled ? formatUsdg(settled.args.usdgOut) : null,
      tx: receipt.transactionHash,
    },
    { force: true },
  );
}

/*//////////////////////////////////////////////////////////////
                            LISTED
//////////////////////////////////////////////////////////////*/

async function onListed(snap: ChainSnapshot): Promise<void> {
  const nowSec = snap.blockTimestamp;

  // Expiry first: rollClose accepts Listed as well as Exercisable, so a keeper that missed
  // lockBook entirely still closes the week rather than stalling.
  if (nowSec >= snap.vaultExpiryTs) {
    await doRollClose(snap);
    return;
  }

  if (nowSec >= snap.vaultExerciseTs) {
    await doLockBook(snap);
    return;
  }

  await syncFills(snap);

  if (snap.listingHash === ZERO_HASH) {
    await retireUnauthorisedListings(snap);
    await createListing(snap);
    return;
  }

  await pollLiveListing(snap);
}

/**
 * Fills happen without the keeper: a buyer's Seaport transaction runs the vault's hooks, which
 * write and emit CallsWritten. The keeper learns of them from `contractsWritten` (== sold) and
 * publishes each increase; the listing row's fill fraction comes from Seaport in pollLiveListing.
 */
async function syncFills(snap: ChainSnapshot): Promise<void> {
  const row = store.getCycle(snap.vaultCycleNumber);
  if (row === null) return;
  const known = BigInt(row.contracts ?? 0);
  const sold = snap.contractsWritten;
  if (sold === known) return;
  store.updateCycle(snap.vaultCycleNumber, { contracts: Number(sold) });
  if (sold > known) {
    await alert(
      'fill',
      `cycle ${snap.vaultCycleNumber}: ${sold - known} contract${sold - known === 1n ? '' : 's'} filled; ${sold} sold so far, ` +
        `${snapshotCapacity(snap)} of capacity left`,
      {
        cycleNumber: snap.vaultCycleNumber,
        filled: (sold - known).toString(),
        sold: sold.toString(),
        capacity: snapshotCapacity(snap).toString(),
        lockedAssets: snap.lockedAssets.toString(),
      },
      { force: true },
    );
  } else {
    log.roll.warn({ cycleNumber: snap.vaultCycleNumber, known: known.toString(), sold: sold.toString() }, 'contractsWritten fell; a fill was reverted?');
  }
}

async function pollLiveListing(snap: ChainSnapshot): Promise<void> {
  const row = store.getListing(snap.listingHash);
  const status = await readOrderStatus(snap.listingHash);

  if (!row) {
    // The vault has authorised a hash we have no record of: another operator's keeper, or a
    // database restored from an older backup. Without the row we do not have the salt, so this
    // order can never be served from /orders — the recovery is to invalidate it on chain and
    // let the next tick build a listing we CAN serve.
    log.roll.warn({ orderHash: snap.listingHash }, 'vault has a listing this keeper did not create');
    await alert(
      'listing_unfillable',
      `the vault has a listing (${snap.listingHash}) this keeper cannot serve: there is no local row for it. ` +
        'Recovering by invalidating it on chain and relisting from our own records.',
      { listingHash: snap.listingHash },
      { dedupeKey: snap.listingHash },
    );
    if (snap.hasKeeperRole && !invalidatedUnservable.has(snap.listingHash)) {
      invalidatedUnservable.add(snap.listingHash);
      const sim = await guardedSimulate('invalidateAllListings', () =>
        publicClient.simulateContract({ address: config.VAULT, abi: vaultAbi, functionName: 'invalidateAllListings', account }),
      );
      if (sim) await sendAndConfirm('invalidateAllListings', snap.vaultCycleNumber, () => walletClient.writeContract(sim.request));
    }
    return;
  }

  const next = applySeaportStatus(row.order_hash, row.status, status);
  const remainingCapacity = snapshotCapacity(snap);

  if (next === 'filled') {
    // Sold out. If NAV grew since (deposits are open while Listed) there is capacity left that
    // nothing offers; free the slot so the next tick lists it, within the vault's three.
    if (remainingCapacity > 0n && snap.listingsThisCycle < MAX_LISTINGS_PER_CYCLE) {
      log.roll.info({ orderHash: row.order_hash, capacity: remainingCapacity.toString() }, 'listing sold out with capacity left; replacing it');
      await cancelLiveListing(snap, row.order_hash, 'sold out with capacity left');
    } else {
      log.roll.info({ orderHash: row.order_hash }, 'listing fully filled; nothing more to sell this cycle');
    }
    return;
  }

  if (status.isCancelled) {
    // Unreachable with this vault (cancelListing clears listingHash in the same transaction),
    // kept so a foreign cancel could never leave a dead hash live in our book.
    store.updateListing(row.order_hash, { status: 'cancelled' });
    return;
  }

  // Would the next buyer be refused? The fill gate re-prices at the spot of the fill.
  if (snap.spotUsdg6 === null) {
    await alert(
      'listing_unfillable',
      `listing ${row.order_hash}: the oracle is stale (${snap.spotError ?? 'unknown'}); every fill reverts until the feed prints`,
      { orderHash: row.order_hash, reason: 'stale-oracle' },
      { dedupeKey: `${row.order_hash}:stale` },
    );
    return;
  }
  const verdict = fillVerdict(
    snap.spotUsdg6,
    { grossUsdg6: snap.listingGrossUsdg6, amount: snap.listingAmount, strikeUsdg6: snap.vaultStrikeUsdg6 },
    snap.policy,
    snap.valoremFeesEnabled,
    snap.valoremFeeBps,
  );
  if (verdict.fillable) {
    clearAlert('listing_unfillable', `${row.order_hash}:strike-below-band`);
    return;
  }

  if (verdict.reason === 'strike-below-band') {
    // A rally pulled the strike inside the band floor. No price fixes that; the listing
    // revives on its own if spot falls back, and cancelling it would only spend a slot.
    await alert(
      'listing_unfillable',
      `listing ${row.order_hash}: strike ${formatUsdg(snap.vaultStrikeUsdg6)} is below the band floor ` +
        `${formatUsdg(BigInt(verdict.detail.bandLowUsdg6 ?? '0'))} at spot ${formatUsdg(snap.spotUsdg6)}; every fill reverts StrikeBelowBand until spot falls back`,
      { orderHash: row.order_hash, reason: verdict.reason, ...verdict.detail },
      { dedupeKey: `${row.order_hash}:strike-below-band` },
    );
    return;
  }

  // premium-below-floor: a reprice fixes it, if a slot is left.
  if (snap.listingsThisCycle >= MAX_LISTINGS_PER_CYCLE) {
    await alert(
      'listing_unfillable',
      `listing ${row.order_hash}: ask ${formatUsdg(BigInt(verdict.detail.unitPrice6 ?? '0'))} is under the fill floor ` +
        `${formatUsdg(verdict.floorUnit6)} at spot ${formatUsdg(snap.spotUsdg6)}, and the vault's ${MAX_LISTINGS_PER_CYCLE} listings are spent; ` +
        'it stays unfillable until spot falls back',
      { orderHash: row.order_hash, reason: verdict.reason, ...verdict.detail },
      { dedupeKey: `${row.order_hash}:budget` },
    );
    return;
  }
  log.roll.warn(
    { orderHash: row.order_hash, ...verdict.detail, floorUnit6: verdict.floorUnit6.toString() },
    'the live listing would be refused at the fill floor; repricing',
  );
  const cancelled = await cancelLiveListing(snap, row.order_hash, 'repricing after a spot move');
  if (!cancelled) return;
  const after = await snapshot();
  await createListing(after);
}

/*//////////////////////////////////////////////////////////////
                        LISTING CREATION
//////////////////////////////////////////////////////////////*/

/**
 * Build, authorise on chain, and serve one listing.
 *
 *   1. size = the vault's remaining capacity (Policy.maxContracts(totalAssets) − contractsWritten)
 *   2. price = the fill floor per contract at this spot (fee valued at spot when the switch is
 *      on) lifted by KEEPER_PREMIUM_MARGIN_BPS, never above the strike
 *   3. components: PARTIAL_RESTRICTED, zone = vault, one USDG item, counter read live
 *   4. cross-check our hash against seaport.getOrderHash, simulate, send approveListing
 *   5. the row is what /orders serves, with an empty signature
 */
async function createListing(snap: ChainSnapshot): Promise<boolean> {
  const cycleNumber = snap.vaultCycleNumber;
  if (snap.phase !== Phase.Listed || snap.blockTimestamp >= snap.vaultExerciseTs) return false;
  if (snap.listingHash !== ZERO_HASH) {
    log.roll.info({ listingHash: snap.listingHash }, 'a listing is already live; not creating another');
    return false;
  }
  if (snap.writesHalted || !snap.hasKeeperRole) return false;
  if (snap.listingsThisCycle >= MAX_LISTINGS_PER_CYCLE) {
    log.roll.info({ cycleNumber }, 'the vault’s listings for this cycle are spent; nothing more can be offered');
    return false;
  }
  const contracts = snapshotCapacity(snap);
  if (contracts === 0n) {
    log.roll.info({ cycleNumber, totalAssets: snap.totalAssets.toString(), sold: snap.contractsWritten.toString() }, 'no capacity left to list');
    return false;
  }
  if (snap.spotUsdg6 === null) {
    log.roll.warn({ cycleNumber, err: snap.spotError }, 'cannot price a listing without spot; the feed is stale');
    return false;
  }
  const priced = priceListing({
    policy: snap.policy,
    spotUsdg6: snap.spotUsdg6,
    strikeUsdg6: snap.vaultStrikeUsdg6,
    contracts,
    feesEnabled: snap.valoremFeesEnabled,
    feeBps: snap.valoremFeeBps,
  });
  if (!priced.ok) {
    log.roll.warn({ cycleNumber, reason: priced.reason, ...priced.detail }, 'cannot price a listing');
    return false;
  }
  const unitPrice6 = priced.unitPrice6;

  const counter = await readCounter(config.VAULT);
  const components = buildOrderComponents({
    vault: config.VAULT,
    optionId: snap.vaultOptionId,
    contracts,
    unitPrice6,
    endTime: snap.vaultExerciseTs,
    counter,
  });

  // Cross-check our encoding against Seaport itself before spending gas. The web fill page
  // derives the same hash and refuses an order whose hash it cannot reproduce.
  const onChainHash = await readOrderHash(components);
  const offChainHash = localOrderHash(components);
  if (onChainHash.toLowerCase() !== offChainHash.toLowerCase()) {
    await alert(
      'listing_unfillable',
      'locally derived order hash disagrees with seaport.getOrderHash; refusing to authorise',
      { onChainHash, offChainHash },
      { dedupeKey: onChainHash, severity: 'error' },
    );
    return false;
  }

  const sim = await guardedSimulate('approveListing', () =>
    publicClient.simulateContract({
      address: config.VAULT,
      abi: vaultAbi,
      functionName: 'approveListing',
      args: [components],
      account,
    }),
  );
  if (!sim) return false;

  const receipt = await sendAndConfirm('approveListing', cycleNumber, () => walletClient.writeContract(sim.request));
  if (!receipt) return false;

  const json = componentsToJson(components);
  const seq = snap.listingsThisCycle + 1;
  const gross6 = unitPrice6 * contracts;

  store.insertListing({
    order_hash: onChainHash,
    cycle_number: cycleNumber,
    seq,
    option_id: snap.vaultOptionId.toString(),
    contracts: contracts.toString(),
    unit_price6: unitPrice6.toString(),
    gross_usdg6: gross6.toString(),
    to_vault6: gross6.toString(),
    to_overcall6: '0',
    end_time: Number(components.endTime),
    counter: counter.toString(),
    salt: components.salt.toString(),
    components_json: JSON.stringify(json),
    signature: EMPTY_SIGNATURE,
    approve_tx: receipt.transactionHash,
    cancel_tx: null,
    status: 'approved',
    api_status: null,
    api_error: null,
    posted_at: null,
    visible_at: null,
    filled_numerator: null,
    filled_denominator: null,
    seaport_total_filled: null,
    seaport_total_size: null,
    seaport_cancelled: null,
  });
  if (seq > 1) {
    const row = store.getCycle(cycleNumber);
    store.updateCycle(cycleNumber, { relists_used: (row?.relists_used ?? 0) + 1 });
  }
  mirrorFallbackPayload(onChainHash, components);

  await alert(
    'listing',
    `cycle ${cycleNumber}: listing ${seq}/${MAX_LISTINGS_PER_CYCLE} authorised: ${contracts} contracts at ` +
      `${formatUsdg(unitPrice6)} USDG each (floor ${formatUsdg(priced.floorUnit6)} at spot ${formatUsdg(snap.spotUsdg6)}, ${priced.priceSource}); served from /orders`,
    {
      cycleNumber,
      orderHash: onChainHash,
      seq,
      contracts: contracts.toString(),
      unitPriceUsdg: formatUsdg(unitPrice6),
      floorUnitUsdg: formatUsdg(priced.floorUnit6),
      spotUsdg: formatUsdg(snap.spotUsdg6),
      priceSource: priced.priceSource,
      tx: receipt.transactionHash,
    },
    { force: true },
  );
  return true;
}

/** Mirror the fillable payload to disk for the fill page, if configured. */
function mirrorFallbackPayload(orderHash: Hex, components: OrderComponentsStruct): void {
  if (!config.KEEPER_FALLBACK_DIR) return;
  try {
    mkdirSync(config.KEEPER_FALLBACK_DIR, { recursive: true });
    const payload = {
      orderHash,
      chainId: config.CHAIN_ID,
      // OrderParameters, i.e. what a buyer hands to fulfillOrder / fulfillAdvancedOrder.
      parameters: toOrderParametersJson(components),
      signature: EMPTY_SIGNATURE,
    };
    writeFileSync(join(config.KEEPER_FALLBACK_DIR, `${orderHash}.json`), JSON.stringify(payload, null, 2));
  } catch (error) {
    log.roll.warn({ err: describeError(error) }, 'could not mirror the fallback payload');
  }
}

/*//////////////////////////////////////////////////////////////
                        CANCEL AND RETIRE
//////////////////////////////////////////////////////////////*/

/** Row statuses that still offer an order: /orders serves them (openListings) until endTime. */
const OFFERED_STATUSES: ReadonlySet<ListingStatus> = new Set(['approved', 'partial']);

/**
 * Retire every row of this cycle that still offers an order, when the vault authorises none.
 *
 * Called with the vault Listed and `listingHash` zero. The vault authorises one order at a time
 * and clears `listingHash` only in `cancelListing` (which sets Seaport's isCancelled) and
 * `invalidateAllListings` (which bumps the Seaport counter and sets nothing on the order), so
 * every earlier listing of the cycle is dead. When the guardian does either, no other path
 * notices: pollLiveListing only reads the vault's live hash, refreshListings runs only at boot,
 * and a counter bump never sets isCancelled. The dead row would then stay `approved`/`partial`
 * and GET /orders would keep serving it beside the relist until endTime — an order Seaport
 * rejects. A row Seaport reports fully filled becomes `filled`; anything else `cancelled`.
 */
async function retireUnauthorisedListings(snap: ChainSnapshot): Promise<void> {
  if (snap.listingHash !== ZERO_HASH) return;
  for (const listing of store.listingsForCycle(snap.vaultCycleNumber)) {
    if (!OFFERED_STATUSES.has(listing.status)) continue;
    let status: SeaportOrderStatus;
    try {
      status = await readOrderStatus(listing.order_hash as Hex);
    } catch (error) {
      log.roll.warn({ orderHash: listing.order_hash, err: describeError(error) }, 'could not read a dead listing; will retry');
      continue;
    }
    const next: ListingStatus = status.isFullyFilled ? 'filled' : 'cancelled';
    store.updateListing(listing.order_hash, {
      status: next,
      seaport_total_filled: status.totalFilled.toString(),
      seaport_total_size: status.totalSize.toString(),
      seaport_cancelled: status.isCancelled ? 1 : 0,
    });
    log.roll.warn(
      { orderHash: listing.order_hash, was: listing.status, now: next, seaportCancelled: status.isCancelled },
      'the vault no longer authorises this listing; retired it',
    );
  }
}

/**
 * Cancel the vault's live listing so a replacement can be authorised.
 *
 * `cancelListing(components)` needs the exact components back, which is why they are persisted.
 * When they are not available `invalidateAllListings()` bumps the Seaport counter and kills
 * everything at once. Either way the vault clears `listingHash` in the same transaction.
 */
async function cancelLiveListing(snap: ChainSnapshot, orderHash: string, why: string): Promise<boolean> {
  const row = store.getListing(orderHash);
  log.roll.warn({ listingHash: orderHash, why }, 'cancelling the vault listing');

  if (row) {
    const components = componentsFromJson(JSON.parse(row.components_json) as OrderComponentsJson);
    const sim = await guardedSimulate('cancelListing', () =>
      publicClient.simulateContract({
        address: config.VAULT,
        abi: vaultAbi,
        functionName: 'cancelListing',
        args: [components],
        account,
      }),
    );
    if (sim) {
      const receipt = await sendAndConfirm('cancelListing', snap.vaultCycleNumber, () => walletClient.writeContract(sim.request));
      if (receipt) {
        const status = await readOrderStatus(orderHash as Hex).catch(() => null);
        store.updateListing(row.order_hash, {
          status: status?.isFullyFilled ? 'filled' : 'cancelled',
          cancel_tx: receipt.transactionHash,
          seaport_total_filled: status ? status.totalFilled.toString() : row.seaport_total_filled,
          seaport_total_size: status ? status.totalSize.toString() : row.seaport_total_size,
          seaport_cancelled: 1,
        });
        return true;
      }
    }
  }

  const sim = await guardedSimulate('invalidateAllListings', () =>
    publicClient.simulateContract({ address: config.VAULT, abi: vaultAbi, functionName: 'invalidateAllListings', account }),
  );
  if (!sim) return false;
  const receipt = await sendAndConfirm('invalidateAllListings', snap.vaultCycleNumber, () => walletClient.writeContract(sim.request));
  if (receipt && row) {
    store.updateListing(row.order_hash, { status: 'cancelled', cancel_tx: receipt.transactionHash });
  }
  return receipt !== null;
}

/*//////////////////////////////////////////////////////////////
                      LOCK BOOK / ROLL CLOSE
//////////////////////////////////////////////////////////////*/

/** Permissionless once the exercise window opens. It only moves Listed -> Exercisable, and it
 *  invalidates any listing still live so nothing can be bought after the buyer's right to
 *  exercise has already begun. */
async function doLockBook(snap: ChainSnapshot): Promise<void> {
  const sim = await guardedSimulate('lockBook', () =>
    publicClient.simulateContract({ address: config.VAULT, abi: vaultAbi, functionName: 'lockBook', account }),
  );
  if (!sim) return;
  const receipt = await sendAndConfirm('lockBook', snap.vaultCycleNumber, () => walletClient.writeContract(sim.request));
  if (!receipt) return;

  store.ensureCycle(snap.vaultCycleNumber, 'locked');
  backfillOpenTx(snap.vaultCycleNumber);
  store.updateCycle(snap.vaultCycleNumber, {
    status: 'locked',
    contracts: Number(snap.contractsWritten),
    lock_tx: receipt.transactionHash,
    locked_at: Date.now(),
  });
  // Every still-live listing for this cycle: `lockBook` invalidates them all, and a row left
  // unretired would keep being offered from /orders.
  for (const live of store.liveListingsForCycle(snap.vaultCycleNumber)) {
    const status = await readOrderStatus(live.order_hash as Hex).catch(() => null);
    store.updateListing(live.order_hash, {
      status: status?.isFullyFilled ? 'filled' : 'expired',
      seaport_total_filled: status ? status.totalFilled.toString() : live.seaport_total_filled,
      seaport_total_size: status ? status.totalSize.toString() : live.seaport_total_size,
    });
  }
  log.roll.info({ cycleNumber: snap.vaultCycleNumber, sold: snap.contractsWritten.toString() }, 'book locked');
}

async function onExercisable(snap: ChainSnapshot): Promise<void> {
  if (snap.blockTimestamp < snap.vaultExpiryTs) {
    log.roll.debug(
      { cycleNumber: snap.vaultCycleNumber, expiryTs: snap.vaultExpiryTs.toString() },
      'exercise window open; waiting for expiry',
    );
    return;
  }
  await doRollClose(snap);
}

/**
 * Redeem the claim, harvest, settle the queue, return to Idle — one transaction.
 *
 * Callable by the keeper from expiry and by ANYONE an hour later. That is the promise the
 * product makes: depositors are never trapped behind a dead hot key. A redeem the token issuers
 * refuse (USDG paused/frozen, NVDA blocklist) does not fail the close: the vault reaches Idle
 * with the claim STRANDED (ClaimStranded in the receipt), and handleStranded takes it from there.
 */
async function doRollClose(snap: ChainSnapshot): Promise<void> {
  // MUST be read before the transaction. `rollClose` redeems the claim, which zeroes
  // `claimKey` and makes Valorem's `claim()` revert `TokenNotFound` from then on — so the
  // same read taken afterwards answers 0 and every assigned week would be published as
  // unassigned. The vault emits the number in `RollClose`, which is what gets published; this
  // read is the fallback for a receipt without one and the cross-check for a receipt with one.
  const assignedBefore = await contractsAssignedAt(snap);

  const sim = await guardedSimulate('rollClose', () =>
    publicClient.simulateContract({ address: config.VAULT, abi: vaultAbi, functionName: 'rollClose', account }),
  );
  if (!sim) return;

  const receipt = await sendAndConfirm('rollClose', snap.vaultCycleNumber, () => walletClient.writeContract(sim.request));
  if (!receipt) return;

  const harvest = await harvestForCycle(snap.vaultCycleNumber, receipt);
  const resolved = resolveContractsAssigned(receipt, assignedBefore);
  if (resolved.source !== 'RollClose') {
    log.roll.warn(
      { cycleNumber: snap.vaultCycleNumber, source: resolved.source, assigned: resolved.assigned, tx: receipt.transactionHash },
      resolved.source === 'claim-preread'
        ? 'no RollClose event from the vault in the rollClose receipt; contracts_assigned published from the pre-close Valorem claim read'
        : 'no RollClose event from the vault in the rollClose receipt and the pre-close Valorem claim read failed; contracts_assigned published as 0',
    );
  }
  if (resolved.mismatch) {
    log.roll.warn(
      { cycleNumber: snap.vaultCycleNumber, fromEvent: String(resolved.fromEvent), fromClaim: String(resolved.fromClaim), tx: receipt.transactionHash },
      'the RollClose count and the pre-close Valorem claim read disagree; the event is published',
    );
  }
  const assigned = resolved.assigned;
  const closed = decodeRollClose(receipt);
  const stranded = decodeClaimStranded(receipt);

  // Whatever was still live is dead now: `rollClose` bumps the Seaport counter, which makes
  // the order unfillable without ever setting `isCancelled`, so nothing else would retire
  // these rows and /orders would keep offering a buyer an order Seaport now rejects.
  for (const live of store.liveListingsForCycle(snap.vaultCycleNumber)) {
    store.updateListing(live.order_hash, { status: 'expired' });
  }

  const status = stranded ? 'stranded' : 'closed';
  store.ensureCycle(snap.vaultCycleNumber, status);
  backfillOpenTx(snap.vaultCycleNumber);
  store.updateCycle(snap.vaultCycleNumber, {
    status,
    contracts: Number(snap.contractsWritten),
    roll_close_tx: receipt.transactionHash,
    closed_at: Date.now(),
    gross_usdg6: harvest.gross.toString(),
    fee_usdg6: harvest.fee.toString(),
    net_usdg6: harvest.net.toString(),
    contracts_assigned: assigned,
    assets_returned: closed === null ? null : closed.assetsReturned.toString(),
    usdg_from_assignment: closed === null ? null : closed.usdgFromAssignment.toString(),
    strand_gen: stranded ? stranded.gen.toString() : null,
  });

  const summary: RollCloseSummary = {
    cycleNumber: snap.vaultCycleNumber,
    gross: harvest.gross,
    fee: harvest.fee,
    net: harvest.net,
    usdgFromAssignment: closed?.usdgFromAssignment ?? null,
    assetsReturned: closed?.assetsReturned ?? null,
    contractsAssigned: assigned,
    witnessedLive: true,
    stranded: stranded !== null,
  };
  await alert(
    'roll_close',
    rollCloseMessage(summary),
    {
      ...rollCloseAlertData(summary),
      contractsSold: snap.contractsWritten.toString(),
      contractsAssignedSource: resolved.source,
      contractsAssignedFromClaim: resolved.fromClaim === null ? null : Number(resolved.fromClaim),
      tx: receipt.transactionHash,
    },
    { force: true },
  );
  if (stranded) await alertStranded(snap.vaultCycleNumber, stranded.gen, stranded.claimKey, receipt.transactionHash);
  log.roll.info(
    {
      cycleNumber: snap.vaultCycleNumber,
      grossUsdg6: harvest.gross.toString(),
      sold: snap.contractsWritten.toString(),
      contractsAssigned: assigned,
      contractsAssignedSource: resolved.source,
      stranded: stranded !== null,
    },
    'cycle closed',
  );
}

/** Read the Harvest event out of the rollClose receipt. An unfilled week emits Harvest(0,0,0),
 *  which is a real result and is published as "unfilled, 0" — not treated as a failure. */
function decodeHarvest(receipt: TransactionReceipt): { gross: bigint; fee: bigint; net: bigint } | null {
  const events = parseEventLogs({ abi: vaultAbi, eventName: 'Harvest', logs: receipt.logs });
  const harvest = events.find((event) => event.address.toLowerCase() === config.VAULT.toLowerCase());
  if (!harvest) return null;
  return { gross: harvest.args.grossUsdg, fee: harvest.args.feeUsdg, net: harvest.args.netUsdg };
}

export interface RollCloseAmounts {
  /** Underlying the redeemed claim handed back, asset base units. */
  assetsReturned: bigint;
  /** Strike proceeds from assigned contracts, USDG base units. Inside Harvest.grossUsdg, fee-free. */
  usdgFromAssignment: bigint;
  /** The assignment count the vault read immediately before redeeming. */
  contractsAssignedCount: bigint;
}

/** The vault's `RollClose` event in a receipt, or null when the vault emitted none. */
export function decodeRollClose(receipt: TransactionReceipt): RollCloseAmounts | null {
  const events = parseEventLogs({ abi: vaultAbi, eventName: 'RollClose', logs: receipt.logs });
  const found = events.find((event) => event.address.toLowerCase() === config.VAULT.toLowerCase());
  if (!found) return null;
  return {
    assetsReturned: found.args.assetsReturned,
    usdgFromAssignment: found.args.usdgFromAssignment,
    contractsAssignedCount: found.args.contractsAssignedCount,
  };
}

/** The vault's `ClaimStranded` in a rollClose receipt, or null when the claim redeemed. */
export function decodeClaimStranded(receipt: TransactionReceipt): { cycleNumber: number; claimKey: bigint; gen: bigint } | null {
  const events = parseEventLogs({ abi: vaultAbi, eventName: 'ClaimStranded', logs: receipt.logs });
  const found = events.find((event) => event.address.toLowerCase() === config.VAULT.toLowerCase());
  if (!found) return null;
  return { cycleNumber: Number(found.args.cycleNumber), claimKey: found.args.claimKey, gen: found.args.gen };
}

/** Everything the `roll_close` alert says, from either close path. */
export interface RollCloseSummary {
  cycleNumber: number;
  /** Cycle-summed Harvest: premium plus, on an assigned week, the strike proceeds. */
  gross: bigint;
  fee: bigint;
  net: bigint;
  /** `RollClose.usdgFromAssignment`; null when unknown. */
  usdgFromAssignment: bigint | null;
  /** `RollClose.assetsReturned`; null when unknown. */
  assetsReturned: bigint | null;
  contractsAssigned: number;
  /** false for a close reconstructed from logs at boot. */
  witnessedLive: boolean;
  /** true when the close left the claim stranded (zero legs reported; the retry pays them). */
  stranded?: boolean;
}

const UNWITNESSED_SUFFIX = ' The close ran without this keeper witnessing it; reconstructed from chain logs.';
const STRANDED_SUFFIX = ' The claim could NOT be redeemed and is stranded: its legs are paid by retryStrandedClaim.';

/**
 * The `roll_close` message. Pure; roll.test.ts pins every wording.
 *
 * On an assigned week the gross includes the strike proceeds, which are returned principal and
 * carry no fee, so the message names premium and strike proceeds separately instead of calling
 * the whole gross "harvested":
 *   cycle 3 closed: premium 19.079259 USDG (fee 0.953962), strike proceeds 2025 USDG from 9
 *   contracts assigned; 2043.125297 USDG to depositors.
 * Unfilled and unassigned weeks keep their wording. An assignment whose proceeds are unknown
 * says so rather than calling the gross premium. A stranded close says so on the end.
 */
export function rollCloseMessage(s: RollCloseSummary): string {
  const suffix = (s.stranded ? STRANDED_SUFFIX : '') + (s.witnessedLive ? '' : UNWITNESSED_SUFFIX);
  if (s.gross === 0n) return `cycle ${s.cycleNumber} closed unfilled: 0 USDG harvested.${suffix}`;
  const { premium, strikeProceeds } = splitGross(s.gross, s.usdgFromAssignment);
  if (premium !== null && strikeProceeds !== null && strikeProceeds > 0n) {
    const noun = s.contractsAssigned === 1 ? 'contract' : 'contracts';
    return (
      `cycle ${s.cycleNumber} closed: premium ${formatUsdg(premium)} USDG (fee ${formatUsdg(s.fee)}), ` +
      `strike proceeds ${formatUsdg(strikeProceeds)} USDG from ${s.contractsAssigned} ${noun} assigned; ` +
      `${formatUsdg(s.net)} USDG to depositors.${suffix}`
    );
  }
  if (strikeProceeds === null && s.contractsAssigned > 0) {
    const noun = s.contractsAssigned === 1 ? 'contract' : 'contracts';
    return (
      `cycle ${s.cycleNumber} closed: ${formatUsdg(s.gross)} USDG gross including strike proceeds from ` +
      `${s.contractsAssigned} ${noun} assigned (premium/proceeds split unknown), ` +
      `${formatUsdg(s.net)} to depositors.${suffix}`
    );
  }
  return `cycle ${s.cycleNumber} closed: ${formatUsdg(s.gross)} USDG harvested, ${formatUsdg(s.net)} to depositors.${suffix}`;
}

/** The amount fields of the `roll_close` alert's `data`, shared by both close paths. */
export function rollCloseAlertData(s: RollCloseSummary): Record<string, unknown> {
  const { premium, strikeProceeds } = splitGross(s.gross, s.usdgFromAssignment);
  if (s.usdgFromAssignment !== null && s.usdgFromAssignment > s.gross) {
    log.roll.warn(
      { cycleNumber: s.cycleNumber, grossUsdg6: s.gross.toString(), usdgFromAssignment: s.usdgFromAssignment.toString() },
      'RollClose.usdgFromAssignment exceeds the summed Harvest gross; premium published as 0',
    );
  }
  return {
    cycleNumber: s.cycleNumber,
    grossUsdg: formatUsdg(s.gross),
    feeUsdg: formatUsdg(s.fee),
    netUsdg: formatUsdg(s.net),
    premiumUsdg: premium === null ? null : formatUsdg(premium),
    strikeProceedsUsdg: strikeProceeds === null ? null : formatUsdg(strikeProceeds),
    assetsReturned: s.assetsReturned === null ? null : s.assetsReturned.toString(),
    contractsAssigned: s.contractsAssigned,
    stranded: s.stranded === true,
  };
}

export type ContractsAssignedSource = 'RollClose' | 'claim-preread' | 'unknown';

export interface ContractsAssignedResolution {
  /** What is published: the cycle row, /cycles and the roll_close alert. */
  assigned: number;
  source: ContractsAssignedSource;
  /** `RollClose.contractsAssignedCount` from the vault, or null when the receipt has no such log. */
  fromEvent: bigint | null;
  /** The pre-close Valorem claim read (`contractsAssignedAt`), or null when that read failed. */
  fromClaim: bigint | null;
  /** Both numbers are known and they differ. The event is published; the caller logs. */
  mismatch: boolean;
}

/**
 * Which assignment count to publish for the cycle, and where it came from.
 *
 * The vault reads `contractsAssigned()` immediately before `_tryRedeemClaim` and emits it in
 * `RollClose` unconditionally, so with the deployed bytecode the event is always in the receipt
 * and is the number published. An event count of 0 is a real unfilled or out-of-the-money week,
 * never a reason to fall through. The keeper's own pre-close read stands in only when the
 * receipt carries no `RollClose` from the vault (a receipt decoded against a mismatched ABI) and
 * is a cross-check when it does: both come from the same Valorem claim across a window in which
 * no exercise can land — the exercise window closes at expiry and rollClose is only sent from
 * expiry — so a disagreement is a keeper or vault defect, not a race.
 */
export function resolveContractsAssigned(
  receipt: TransactionReceipt,
  assignedBefore: bigint | null,
): ContractsAssignedResolution {
  const fromEvent = decodeRollClose(receipt)?.contractsAssignedCount ?? null;
  if (fromEvent !== null) {
    return {
      assigned: Number(fromEvent),
      source: 'RollClose',
      fromEvent,
      fromClaim: assignedBefore,
      mismatch: assignedBefore !== null && assignedBefore !== fromEvent,
    };
  }
  if (assignedBefore !== null) {
    return { assigned: Number(assignedBefore), source: 'claim-preread', fromEvent: null, fromClaim: assignedBefore, mismatch: false };
  }
  return { assigned: 0, source: 'unknown', fromEvent: null, fromClaim: null, mismatch: false };
}

/**
 * The WHOLE week's harvest, not just the slice that happened to land in one receipt.
 *
 * WHY THIS IS NOT JUST `decodeHarvest(receipt)`: the vault calls `_checkpointHarvest()` inside
 * `deposit()` and `mint()`, and deposits are open during `Listed`. So a buyer fills on Tuesday,
 * somebody deposits on Wednesday, the deposit sweeps the premium into the index and emits
 * `Harvest(cycle, gross, fee, net)` right then — and Friday's `rollClose` receipt carries
 * `Harvest(cycle, 0, 0, 0)` because there is nothing left to sweep. Reading only the receipt
 * would record a SOLD week as "unfilled, 0", which is precisely the number the product promises
 * to publish honestly. Every Harvest is tagged with the indexed cycle number (a stranded cycle's
 * retry included), so summing the cycle's logs from the rollOpen block to this receipt is exact.
 *
 * Log queries go over `logClient`, pinned to the primary archive RPC — the backup rejects
 * archive ranges. If the range cannot be resolved or the query fails, fall back to the receipt:
 * under-reporting is bad, but inventing a number is worse.
 */
async function harvestForCycle(
  cycleNumber: number,
  receipt: TransactionReceipt,
): Promise<{ gross: bigint; fee: bigint; net: bigint }> {
  const fromReceipt = decodeHarvest(receipt) ?? { gross: 0n, fee: 0n, net: 0n };

  let openBlock: bigint | null = null;
  try {
    openBlock = await resolveOpenBlock(cycleNumber, receipt.blockNumber);
  } catch (error) {
    log.roll.warn({ cycleNumber, err: describeError(error) }, 'could not resolve the rollOpen block');
  }
  if (openBlock === null) {
    log.roll.warn({ cycleNumber }, 'no rollOpen block on record; harvest read from the receipt alone');
    return fromReceipt;
  }

  try {
    const logs = await logClient.getLogs({
      address: config.VAULT,
      event: harvestEvent,
      args: { cycleNumber },
      fromBlock: openBlock,
      toBlock: receipt.blockNumber,
    });
    let gross = 0n;
    let fee = 0n;
    let net = 0n;
    for (const entry of logs) {
      gross += entry.args.grossUsdg ?? 0n;
      fee += entry.args.feeUsdg ?? 0n;
      net += entry.args.netUsdg ?? 0n;
    }
    if (logs.length > 1) {
      log.roll.info(
        { cycleNumber, harvestEvents: logs.length, grossUsdg6: gross.toString() },
        'summed several Harvest events for this cycle (a deposit checkpointed the premium early, or a stranded claim was recovered)',
      );
    }
    return { gross, fee, net };
  } catch (error) {
    log.roll.warn(
      { cycleNumber, err: describeError(error) },
      'could not read the cycle Harvest logs; falling back to the receipt',
    );
    return fromReceipt;
  }
}

/**
 * Contracts assigned against the vault's open claim, read from Valorem: the keeper's twin of
 * ValoremLib.contractsAssigned, which is what `vault.contractsAssigned()` returns.
 * `claim().amountExercised` is a 1e18-SCALED SCALAR, not a contract count, so it is divided back
 * down; getting that wrong reports a 9-contract assignment as 9e18. A zero `claimKey` is
 * "nothing sold this cycle", answered without a read.
 *
 * Call this only BEFORE `rollClose`: a successful redeem zeroes `claimKey` and Valorem reverts
 * `TokenNotFound` for the burned claim from then on. Where the vault's library answers 0 to a
 * revert (a view must not revert), the keeper answers null — "unknown" — and logs it, so a
 * failed read can never publish an assigned week as unassigned by accident.
 */
export async function contractsAssignedAt(snap: Pick<ChainSnapshot, 'vaultClaimKey'>): Promise<bigint | null> {
  if (snap.vaultClaimKey === 0n) return 0n;
  try {
    const claim = await publicClient.readContract({
      address: config.CLEARINGHOUSE,
      abi: clearAbi,
      functionName: 'claim',
      args: [snap.vaultClaimKey],
    });
    return claim.amountExercised / 1_000_000_000_000_000_000n;
  } catch (error) {
    log.roll.warn(
      { claimKey: snap.vaultClaimKey.toString(), err: describeError(error) },
      'could not read the Valorem claim before rollClose; contracts assigned is unknown',
    );
    return null;
  }
}

/*//////////////////////////////////////////////////////////////
                            HELPERS
//////////////////////////////////////////////////////////////*/

/** Contracts a listing row has sold, from the Seaport fraction stamped on it. */
export function listingFilled(row: { contracts: string; seaport_total_filled: string | null; seaport_total_size: string | null }): bigint {
  return filledContracts(BigInt(row.contracts), {
    totalFilled: BigInt(row.seaport_total_filled ?? '0'),
    totalSize: BigInt(row.seaport_total_size ?? '0'),
  });
}

/** USDG base units -> a human "123.456789" string. Display only. */
export function formatUsdg(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Wei -> a human "0.0042" ETH string, 4 decimal places. Display only. */
export function formatEth(wei: bigint): string {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / 1_000_000_000_000_000_000n;
  const frac = ((abs % 1_000_000_000_000_000_000n) / 100_000_000_000_000n).toString().padStart(4, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}
