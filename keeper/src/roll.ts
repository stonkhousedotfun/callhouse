/**
 * The weekly roll state machine.
 *
 * Every decision binds to two things and nothing else: the Overcall registry's own gates
 * (`isWritingOpen()`, the cycle's `exerciseTimestamp` / `expiryTimestamp`) and the vault's own
 * `phase()`. Never the wall clock, never "it is Friday". The registry can move a cycle and the
 * vault can be rolled by a guardian while the keeper is asleep; both cases have to come out
 * right on the next tick.
 *
 *   phase Idle + isWritingOpen + a cycle we have not handled
 *     -> pick strike -> rollOpen -> build order -> approveListing -> POST -> verify visible
 *   phase Listed, each tick
 *     -> Seaport getOrderStatus; hourly, Overcall's book. Fully filled: stop. Cancelled or
 *        invalid: relist once, never past the vault's 3-listings-per-cycle cap.
 *   now >= cycleExerciseTs -> no new listings, call lockBook()
 *   now >= cycleExpiryTs   -> rollClose()
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
import { clearAbi, harvestEvent, registryAbi, rollCloseEvent, rollOpenEvent, stockTokenAbi, vaultAbi } from './abi.js';
import { alert, clearAlert } from './alerts.js';
import { account, logClient, publicClient, walletClient } from './clients.js';
import { config } from './config.js';
import { log } from './logger.js';
import {
  OvercallApiError,
  fetchListing,
  fetchListings,
  lastFilledUnitPrice6,
  publishListing,
  recordCancellation,
} from './overcallApi.js';
import {
  MAX_LISTINGS_PER_CYCLE,
  liftedUnitPrice6,
  minUnitPrice6,
  pickWrite,
  readCycle,
  readPolicy,
  readRungs,
  relistUnitPrice6,
  type CycleView,
  type Rung,
} from './policy.js';
import {
  PLACEHOLDER_SIGNATURE,
  buildOrderComponents,
  componentsFromJson,
  componentsToJson,
  localOrderHash,
  readCounter,
  readOrderHash,
  readOrderStatus,
  toOrderParametersJson,
  type OrderComponentsJson,
  type OrderComponentsStruct,
  type SeaportOrderStatus,
} from './seaport.js';
import { splitGross, store, type CycleRow, type ListingRow, type ListingStatus, type TxKind } from './state.js';

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

  vaultCycleNumber: number;
  vaultExerciseTs: bigint;
  vaultExpiryTs: bigint;
  vaultStrikeUsdg6: bigint;
  vaultOptionId: bigint;
  vaultClaimKey: bigint;
  contractsWritten: bigint;
  /** clear.balanceOf(vault, optionId): the only honest count of what is still sellable. */
  optionInventory: bigint;
  listingHash: Hex;
  listingsThisCycle: number;
  idleAssets: bigint;
  totalAssets: bigint;
  lockedAssets: bigint;

  registryCycle: CycleView;
  isWritingOpen: boolean;
  isCycleLive: boolean;

  keeperBalanceWei: bigint;
  hasKeeperRole: boolean;
}

const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

/** How often to re-POST a listing Overcall has not accepted. Ten minutes: often enough that a
 *  transient outage costs minutes rather than the week, rare enough not to spend the per-IP
 *  token bucket on an order the server keeps refusing. */
const POST_RETRY_INTERVAL_MS = 600_000;

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
    listingsThisCycle,
    idleAssets,
    totalAssets,
    lockedAssets,
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
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'listingsThisCycle' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'idleAssets' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'totalAssets' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'lockedAssets' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'KEEPER_ROLE' }),
  ]);

  const [
    valoremFeesEnabled,
    valoremFeeBps,
    registryCycle,
    isWritingOpen,
    isCycleLive,
    keeperBalanceWei,
    hasKeeperRole,
  ] = await Promise.all([
    publicClient.readContract({ address: config.CLEARINGHOUSE, abi: clearAbi, functionName: 'feesEnabled' }),
    publicClient.readContract({ address: config.CLEARINGHOUSE, abi: clearAbi, functionName: 'feeBps' }),
    readCycle(),
    publicClient.readContract({ address: config.REGISTRY, abi: registryAbi, functionName: 'isWritingOpen' }),
    publicClient.readContract({ address: config.REGISTRY, abi: registryAbi, functionName: 'isCycleLive' }),
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({
      address: config.VAULT,
      abi: vaultAbi,
      functionName: 'hasRole',
      args: [keeperRole, account.address],
    }),
  ]);

  const optionInventory =
    vaultOptionId === 0n
      ? 0n
      : await publicClient.readContract({
          address: config.CLEARINGHOUSE,
          abi: clearAbi,
          functionName: 'balanceOf',
          args: [config.VAULT, vaultOptionId],
        });

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
    vaultCycleNumber,
    vaultExerciseTs: BigInt(vaultExerciseTs),
    vaultExpiryTs: BigInt(vaultExpiryTs),
    vaultStrikeUsdg6,
    vaultOptionId,
    vaultClaimKey,
    contractsWritten: BigInt(contractsWritten),
    optionInventory,
    listingHash,
    listingsThisCycle,
    idleAssets,
    totalAssets,
    lockedAssets,
    registryCycle,
    isWritingOpen,
    isCycleLive,
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
 * here; overcallApi.test.ts pins that list against the compiled artifacts. An undecodable
 * revert is reported by selector rather than swallowed.
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

/** Simulate first, always. A revert here costs nothing; a revert on chain costs gas, a nonce,
 *  and — during the write window — time we may not get back. */
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
      registryCycle: snap.registryCycle.number,
      listingHash: snap.listingHash,
      rows: store.counts(),
    },
    'reconciled against chain state',
  );
}

/**
 * Refuse to run against a vault that is not the one this config describes.
 *
 * The specific accident this prevents: Overcall publishes eleven per-market registries and
 * their frontend config has a top-level `registry` key that is the JUGGERNAUT market, not NVDA.
 * Pointing the keeper at the wrong registry would have it write calls against the wrong book
 * and only find out at `rollOpen`. The vault knows its own registry; we compare.
 */
async function assertWiring(): Promise<void> {
  const [asset, usdg, clear, seaport, registry, feeRecipient, conduitKey, zone, transferTarget] = await Promise.all([
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'asset' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'usdg' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'clear' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'seaport' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'registry' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'overcallFeeRecipient' }),
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
  check('registry', registry, config.REGISTRY);
  check('overcallFeeRecipient', feeRecipient, config.OVERCALL_FEE_RECIPIENT);
  check('conduitKey', conduitKey, config.SEAPORT_CONDUIT_KEY);
  check('seaportZone', zone, config.SEAPORT_ZONE);

  if (mismatches.length > 0) {
    throw new Error(
      `Keeper config does not match the deployed vault at ${config.VAULT}:\n  ${mismatches.join('\n  ')}\n` +
        'Fix the environment. Writing against the wrong registry or fee recipient produces ' +
        'listings Overcall will never show.',
    );
  }

  // Seaport pulls the ERC-1155 straight out of the vault on fill. Without this approval,
  // Overcall's check 9 answers 422 and the listing flips to "unfillable" in their UI.
  const approved = await publicClient.readContract({
    address: config.CLEARINGHOUSE,
    abi: clearAbi,
    functionName: 'isApprovedForAll',
    args: [config.VAULT, transferTarget],
  });
  if (!approved) {
    await alert(
      'api_reject',
      `vault has not approved ${transferTarget} to move its option tokens; every fill will fail`,
      { transferTarget },
      { force: true },
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
    // Not fatal. lockBook is permissionless and rollClose opens to anyone an hour after expiry,
    // so a keeper without the role is still useful — it just cannot open a new cycle.
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
    lot_size: snap.registryCycle.lotSize.toString(),
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
 * already ran for the last cycle the vault wrote: rollOpen is the only way in and rollClose
 * the only way back. Two triggers land here — the keeper down through expiry while someone
 * called the permissionless `rollClose()`, or our own rollClose receipt timing out as the tx
 * landed — and a third, rarer one: another operator running the entire week while this keeper
 * was down. Without this the row sits 'open'/'locked' forever: harvest never summed, listings
 * never retired, no roll_close alert — or worse, the week gets written "skipped — unfilled, 0"
 * when the vault in fact ran it. Never throws: a log-query failure degrades to a warn and a
 * retry next tick, never a boot failure.
 */
async function closeUnwitnessedCycle(snap: ChainSnapshot): Promise<void> {
  if (snap.phase !== Phase.Idle || snap.vaultCycleNumber === 0 || snap.vaultExpiryTs === 0n) return;
  const recorded = store.getCycle(snap.vaultCycleNumber);
  if (recorded !== null && recorded.status === 'closed') return;
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

  const assigned = Number(closeLog.args.contractsAssignedCount ?? 0n);
  // Both straight from the RollClose log. A log that somehow lacks them reads null ("unknown"),
  // never 0: a 0 here would publish an assigned week's strike proceeds as premium.
  const assetsReturned = closeLog.args.assetsReturned ?? null;
  const usdgFromAssignment = closeLog.args.usdgFromAssignment ?? null;

  // Same retirement as doRollClose: the close bumped the Seaport counter, which kills every
  // still-live order without setting isCancelled — and tell the book, best-effort, or its row
  // lingers until Overcall's lazy expiry sweep.
  for (const live of store.liveListingsForCycle(cycleNumber)) {
    store.updateListing(live.order_hash, { status: 'expired' });
    await recordCancellation(live.order_hash);
  }

  const existing = store.getCycle(cycleNumber);
  store.ensureCycle(cycleNumber, 'closed');
  const patch: Partial<CycleRow> = {
    status: 'closed',
    roll_close_tx: closeLog.transactionHash,
    closed_at: Date.now(),
    gross_usdg6: gross.toString(),
    fee_usdg6: fee.toString(),
    net_usdg6: net.toString(),
    contracts_assigned: assigned,
    assets_returned: assetsReturned === null ? null : assetsReturned.toString(),
    usdg_from_assignment: usdgFromAssignment === null ? null : usdgFromAssignment.toString(),
  };
  if (existing === null) {
    // A week another operator ran end to end. The vault zeroed optionId and contractsWritten
    // at redeem, so the write details come from the RollOpen log; the cycle timestamps survive
    // the close and still read from the vault.
    patch.exercise_ts = Number(snap.vaultExerciseTs);
    patch.expiry_ts = Number(snap.vaultExpiryTs);
    patch.lot_size = snap.registryCycle.lotSize.toString();
    if (openLog) {
      patch.option_id = openLog.args.optionId?.toString() ?? null;
      patch.contracts = Number(openLog.args.contractsCount ?? 0n);
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
  };
  await alert(
    'roll_close',
    rollCloseMessage(summary),
    { ...rollCloseAlertData(summary), tx: closeLog.transactionHash, witnessedLive: false },
    { force: true },
  );
  log.boot.warn(
    { cycleNumber, closeTx: closeLog.transactionHash, grossUsdg6: gross.toString() },
    'closed a cycle from chain logs that this keeper never witnessed',
  );
}

/**
 * The RollOpen log for a cycle, or null. Its block is where the harvest sum starts; its args
 * carry the write details (optionId, contracts, strike) that the vault itself has zeroed by the
 * time a close is being reconstructed.
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
 * What Seaport's own order status says the lifecycle is. The chain outranks the book, so this
 * may DOWNGRADE a status the book reported — a wrong or malicious API row must never latch a
 * listing `filled` and censor it from the keeper's own /orders fallback. `cancelled` is the one
 * latch: Seaport counters only move forward, so a cancelled order never comes back.
 *
 * The revive branch requires a chain-VALID state: a counter bump (invalidateAllListings,
 * lockBook, rollClose) kills an order without ever setting `isCancelled`, and that must not
 * bring a dead order back to /orders.
 */
export function seaportVerdict(current: ListingStatus, status: SeaportOrderStatus): ListingStatus {
  if (status.isFullyFilled) return 'filled';
  if (status.isCancelled) return 'cancelled';
  if (status.totalFilled > 0n) return 'partial';
  if (status.isValidated && (current === 'filled' || current === 'partial' || current === 'unfillable')) return 'visible';
  return current;
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

  // Valorem's engine fee is 15 bps of NOTIONAL, which on a weekly OTM call eats most of the
  // premium. The vault refuses to write while it is on unless governance has accepted it.
  if (snap.valoremFeesEnabled && !snap.valoremFeeAccepted) {
    await alert(
      'valorem_fees_enabled',
      `Valorem turned its engine fee on (${snap.valoremFeeBps} bps). The vault will not write ` +
        'until an admin calls acceptValoremFee(true).',
      { feeBps: snap.valoremFeeBps },
    );
  } else {
    clearAlert('valorem_fees_enabled');
  }

  if (snap.oraclePaused === true) {
    await alert('oracle_paused', 'the Stock Token has paused its oracle; the vault will refuse to write', {});
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
        registryCycle: snap.registryCycle.number,
        vaultCycle: snap.vaultCycleNumber,
        writingOpen: snap.isWritingOpen,
        listingHash: snap.listingHash,
        idleAssets: snap.idleAssets.toString(),
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

const SKIP_REASON_KEY = (cycleNumber: number) => `skip_reason:${cycleNumber}`;

async function onIdle(snap: ChainSnapshot): Promise<void> {
  const cycleNumber = snap.registryCycle.number;
  if (cycleNumber === 0) {
    log.roll.debug({}, 'registry has no cycle yet');
    return;
  }

  // A close we never witnessed. phase Idle with a nonzero cycle number and an expiry still on
  // the vault means rollClose already ran for the last cycle the vault wrote — rollOpen is the
  // only way in and rollClose the only way back. A permissionless close while we were down, or
  // our own receipt timing out as the tx landed, both land here. Close the row out from chain
  // logs; the skip path below must never record such a week as "skipped — unfilled, 0", because
  // the chain says it ran.
  if (snap.vaultCycleNumber !== 0 && snap.vaultExpiryTs > 0n) {
    await closeUnwitnessedCycle(snap);
    if (snap.vaultCycleNumber === cycleNumber) return;
  }

  // Already decided, one way or the other. Restart-safe: a row exists only because we wrote or
  // deliberately skipped, and neither is revisited.
  if (store.isCycleHandled(cycleNumber)) return;

  if (!snap.isWritingOpen) {
    // The window closed and we never wrote. That is a real, publishable outcome: unfilled, 0.
    const reason = store.getMeta(SKIP_REASON_KEY(cycleNumber)) ?? 'writing-window-closed';
    store.ensureCycle(cycleNumber, 'skipped');
    store.updateCycle(cycleNumber, {
      status: 'skipped',
      skip_reason: reason,
      exercise_ts: Number(snap.registryCycle.exerciseTimestamp),
      expiry_ts: Number(snap.registryCycle.expiryTimestamp),
      lot_size: snap.registryCycle.lotSize.toString(),
    });
    await alert(
      'no_rung',
      `cycle ${cycleNumber} closed without a write (${reason}). This week is unfilled, 0.`,
      { cycleNumber, reason },
      { dedupeKey: String(cycleNumber), force: true },
    );
    log.roll.warn({ cycleNumber, reason }, 'write window closed with no write');
    return;
  }

  if (snap.writesHalted) {
    await remember(cycleNumber, 'writes-halted');
    log.roll.warn({ cycleNumber }, 'writes are halted; not writing');
    return;
  }
  if (!snap.hasKeeperRole) {
    await remember(cycleNumber, 'no-keeper-role');
    return;
  }
  if (snap.valoremFeesEnabled && !snap.valoremFeeAccepted) {
    await remember(cycleNumber, 'valorem-fees-enabled');
    return;
  }
  if (snap.oraclePaused === true) {
    await remember(cycleNumber, 'oracle-paused');
    return;
  }

  const policy = await readPolicy();
  let spotUsdg6: bigint;
  try {
    spotUsdg6 = await publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'spotUsdg' });
  } catch (error) {
    // `spotUsdg()` reverts on a stale feed. That is the vault's own write gate and it will
    // reject `rollOpen` for the same reason, so stop here rather than burn a simulation.
    await remember(cycleNumber, `stale-oracle: ${describeError(error)}`);
    return;
  }

  const rungs: Rung[] = await readRungs(snap.registryCycle);
  const plan = await pickWrite({
    cycle: snap.registryCycle,
    rungs,
    policy,
    idleAssets: snap.idleAssets,
    spotUsdg6,
  });

  if (!plan.ok) {
    await remember(cycleNumber, plan.reason);
    log.roll.info({ cycleNumber, reason: plan.reason, ...plan.detail }, 'no write this tick');
    return;
  }

  /* ---- rollOpen ---- */

  const sim = await guardedSimulate('rollOpen', () =>
    publicClient.simulateContract({
      address: config.VAULT,
      abi: vaultAbi,
      functionName: 'rollOpen',
      args: [plan.optionId, plan.contracts],
      account,
    }),
  );
  if (!sim) return;

  const receipt = await sendAndConfirm('rollOpen', cycleNumber, () => walletClient.writeContract(sim.request));
  if (!receipt) return;

  store.ensureCycle(cycleNumber, 'open');
  store.updateCycle(cycleNumber, {
    status: 'open',
    option_id: plan.optionId.toString(),
    strike_usdg6: plan.strikeUsdg6.toString(),
    contracts: Number(plan.contracts),
    exercise_ts: Number(snap.registryCycle.exerciseTimestamp),
    expiry_ts: Number(snap.registryCycle.expiryTimestamp),
    lot_size: snap.registryCycle.lotSize.toString(),
    roll_open_tx: receipt.transactionHash,
    opened_at: Date.now(),
  });

  await alert(
    'roll_open',
    `cycle ${cycleNumber}: wrote ${plan.contracts} contracts at strike ${formatUsdg(plan.strikeUsdg6)} USDG`,
    {
      cycleNumber,
      optionId: plan.optionId.toString(),
      contracts: plan.contracts.toString(),
      strikeUsdg: formatUsdg(plan.strikeUsdg6),
      unitPriceUsdg: formatUsdg(plan.unitPrice6),
      tx: receipt.transactionHash,
    },
    { force: true },
  );

  // List in the same tick. The write deadline is the same timestamp as the listing's endTime,
  // so every minute between writing and listing is a minute the inventory cannot be sold.
  const after = await snapshot();
  await createListing(after, plan.unitPrice6);
}

/** Remember why we did not write, so the end-of-window skip row carries an honest reason. */
async function remember(cycleNumber: number, reason: string): Promise<void> {
  store.setMeta(SKIP_REASON_KEY(cycleNumber), reason);
  if (reason === 'no-rung-in-band' || reason === 'premium-above-strike') {
    await alert('no_rung', `cycle ${cycleNumber}: ${reason}; holding spot and writing nothing`, {
      cycleNumber,
      reason,
    });
    return;
  }
  if (reason.startsWith('stale-oracle')) {
    // A stale feed silently blocks every write for as long as it lasts. Surfacing it only as an
    // info no_rung when the window closes means hearing about it once the week is already lost,
    // so it warns while there is still time to chase the feed. (oracle-paused gets no such line:
    // the snapshot-level oracle_paused alert already covers it.)
    await alert(
      'no_rung',
      `cycle ${cycleNumber}: ${reason}; the vault refuses to write while the feed is stale`,
      { cycleNumber, reason },
      { severity: 'warn', dedupeKey: `${cycleNumber}:stale-oracle` },
    );
  }
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

  if (snap.listingHash === ZERO_HASH) {
    await maybeRelist(snap);
    return;
  }

  await pollLiveListing(snap);
}

/** Rows worth an idempotent repost to Overcall. `partial` with a null api_status is a listing
 *  the book never accepted that then caught a direct fill through our own /orders fallback —
 *  applySeaportStatus flips it to 'partial' on the first fill, and an API outage at listing
 *  time must not permanently stop the repost that gets the rest of the inventory onto the book. */
export function isPostRetryable(row: Pick<ListingRow, 'status' | 'api_status'>): boolean {
  return (
    row.status === 'approved' || row.status === 'post_failed' || (row.status === 'partial' && row.api_status === null)
  );
}

async function pollLiveListing(snap: ChainSnapshot): Promise<void> {
  const row = store.getListing(snap.listingHash);
  const status = await readOrderStatus(snap.listingHash);

  if (row) {
    const next = applySeaportStatus(row.order_hash, row.status, status);
    if (next === 'filled') {
      log.roll.info({ orderHash: row.order_hash }, 'listing fully filled; nothing more to sell this cycle');
      return;
    }
  } else {
    // The vault has authorised a hash we have no record of: another operator's keeper, or a
    // database restored from an older backup. Without the row we do not have the salt, so this
    // order can never be served from /orders or reposted — the recovery is to invalidate it on
    // chain and let maybeRelist build a listing we CAN serve, next tick.
    log.roll.warn({ orderHash: snap.listingHash }, 'vault has a listing this keeper did not create');
    await alert(
      'api_reject',
      `the vault has a listing (${snap.listingHash}) this keeper cannot serve: there is no local row for it. ` +
        'Recovering by invalidating it on chain and relisting from our own records.',
      { listingHash: snap.listingHash },
      { dedupeKey: snap.listingHash },
    );
    if (snap.hasKeeperRole && !invalidatedUnservable.has(snap.listingHash)) {
      // At most one invalidation attempt per hash per boot; if the tx reverts, the alert's
      // hourly cooldown above is the backstop.
      invalidatedUnservable.add(snap.listingHash);
      const sim = await guardedSimulate('invalidateAllListings', () =>
        publicClient.simulateContract({
          address: config.VAULT,
          abi: vaultAbi,
          functionName: 'invalidateAllListings',
          account,
        }),
      );
      if (sim) {
        await sendAndConfirm('invalidateAllListings', snap.vaultCycleNumber, () =>
          walletClient.writeContract(sim.request),
        );
      }
      return;
    }
  }

  if (status.isCancelled) {
    await clearVaultListing(snap, 'seaport reports the order cancelled');
    return;
  }

  // Retry a POST that never landed. The endpoint is idempotent on order hash, so a repost is
  // safe — it answers 200 with the existing row — and it is the difference between an
  // invisible listing and a sold week. Throttled so a rejection we cannot fix does not sit in
  // Overcall's per-IP token bucket all week.
  if (row && isPostRetryable(row)) {
    const retryKey = `post_retry_ms:${row.order_hash}`;
    const lastTry = store.getMetaNumber(retryKey) ?? 0;
    if (Date.now() - lastTry >= POST_RETRY_INTERVAL_MS) {
      store.setMeta(retryKey, String(Date.now()));
      await postToOvercall(
        row.order_hash as Hex,
        JSON.parse(row.components_json) as OrderComponentsJson,
        row.cycle_number,
      );
    }
  }

  await maybeCheckBook(row?.order_hash ?? snap.listingHash);
}

/** Hourly: ask Overcall's book what it thinks, and alert if our listing is not in it. */
async function maybeCheckBook(orderHash: string): Promise<void> {
  const key = `book_poll_ms:${orderHash}`;
  const last = store.getMetaNumber(key) ?? 0;
  if (Date.now() - last < config.KEEPER_FILL_POLL_MS) {
    await checkVisibility(orderHash);
    return;
  }
  store.setMeta(key, String(Date.now()));

  try {
    const listing = await fetchListing(orderHash);
    if (listing === null) {
      // Not by hash — try the offerer index, which is how the book is actually browsed and
      // therefore the honest test of "can a buyer see this". The limit is generous on purpose:
      // 3 listings per cycle (the vault's own cap) means 200 rows is ~1.5 years of cycles, and
      // the old limit of 20 would start false-reporting "missing" once the vault had more
      // history than that.
      const mine = await fetchListings({ offerer: config.VAULT, status: 'all', limit: 200 });
      const found = mine.find((entry) => entry.orderHash.toLowerCase() === orderHash.toLowerCase());
      if (!found) {
        store.updateListing(orderHash, { api_status: 'missing' });
        await checkVisibility(orderHash);
        return;
      }
      await applyBookStatus(
        orderHash,
        found.status ?? null,
        found.filledNumerator ?? null,
        found.filledDenominator ?? null,
      );
      return;
    }
    await applyBookStatus(
      orderHash,
      listing.status ?? null,
      listing.filledNumerator ?? null,
      listing.filledDenominator ?? null,
    );
  } catch (error) {
    log.roll.warn({ orderHash, err: describeError(error) }, 'could not read the book');
  }
}

/**
 * The lifecycle verdict of a book report — or undefined when the report should not move the
 * lifecycle. The book is Overcall's OPINION; the chain outranks it. `filled` is believed only
 * when the row's own Seaport fields agree (the every-tick getOrderStatus poll stamps them): a
 * wrong or malicious API row must never censor a still-fillable order from /orders. And nothing
 * here downgrades a chain-confirmed `filled`.
 */
export function bookVerdict(
  current: ListingStatus,
  apiStatus: string | null,
  seaportFilled: bigint,
  seaportSize: bigint,
): ListingStatus | undefined {
  if (current === 'filled') return undefined;
  if (apiStatus === 'filled') {
    return seaportSize > 0n && seaportFilled >= seaportSize ? 'filled' : undefined;
  }
  if (apiStatus === 'partial') return 'partial';
  if (apiStatus === 'unfillable') return 'unfillable';
  // An 'open' (re-)report — or a row with no status at all — confirms a fresh post, and revives
  // a row the book itself had buried: `unfillable` recovers on its own once the tokens and the
  // approval are both true again, so it is a warning, not a death certificate.
  if (current === 'posted' || current === 'post_failed' || current === 'unfillable') return 'visible';
  return undefined;
}

async function applyBookStatus(
  orderHash: string,
  apiStatus: string | null,
  filledNumerator: string | null,
  filledDenominator: string | null,
): Promise<void> {
  // Being in the book at all is what "visible" means, so stamp it the first time we see it.
  const existing = store.getListing(orderHash);
  const patch: Partial<ListingRow> = {
    api_status: apiStatus,
    filled_numerator: filledNumerator,
    filled_denominator: filledDenominator,
    visible_at: existing?.visible_at ?? Date.now(),
  };
  // Only overwrite our own lifecycle status when the book has a verdict on it; a
  // `status: undefined` in the patch would write a NULL and lose the listing's state.
  const verdict =
    existing === null
      ? undefined
      : bookVerdict(
          existing.status,
          apiStatus,
          BigInt(existing.seaport_total_filled ?? '0'),
          BigInt(existing.seaport_total_size ?? '0'),
        );
  if (verdict !== undefined) patch.status = verdict;
  store.updateListing(orderHash, patch);

  if (apiStatus === 'unfillable') {
    await alert(
      'api_reject',
      `Overcall marked ${orderHash} unfillable: the vault is missing the option tokens or the ` +
        'Seaport approval. It recovers on its own once both are true again.',
      { orderHash },
      { dedupeKey: orderHash },
    );
  }
}

/** An accepted listing that nobody can see is an unfilled week. Say so after 15 minutes. */
async function checkVisibility(orderHash: string): Promise<void> {
  const row = store.getListing(orderHash);
  if (!row || row.visible_at !== null) return;
  const since = row.posted_at ?? row.created_at;
  if (Date.now() - since < config.KEEPER_LISTING_VISIBLE_MS) return;

  await alert(
    'listing_invisible',
    `listing ${orderHash} still is not visible in Overcall's book ${Math.round(
      (Date.now() - since) / 60_000,
    )} minutes after publishing. The signed payload is being served from /orders so a buyer ` +
      'can still fill it directly.',
    { orderHash, postedAt: new Date(since).toISOString() },
    { dedupeKey: orderHash },
  );
}

/*//////////////////////////////////////////////////////////////
                        LISTING CREATION
//////////////////////////////////////////////////////////////*/

/**
 * Build, authorise on chain, and publish one listing.
 *
 * The order of the three steps is fixed and it matters:
 *   1. build the components off chain (fee split per contract, counter read live)
 *   2. vault.approveListing(components) — the vault re-derives every field, records the hash,
 *      and calls seaport.validate() so the order fills with an empty signature
 *   3. POST to Overcall with the 65-byte placeholder
 * Publishing before authorising would put an order in their book that the vault has not
 * agreed to and that their check 8 would reject.
 */
async function createListing(snap: ChainSnapshot, unitPrice6: bigint): Promise<boolean> {
  const cycleNumber = snap.vaultCycleNumber;
  const inventory = snap.optionInventory;

  if (inventory === 0n) {
    log.roll.info({ cycleNumber }, 'no option inventory to list');
    return false;
  }
  if (snap.listingsThisCycle >= MAX_LISTINGS_PER_CYCLE) {
    await alert(
      'api_reject',
      `cycle ${cycleNumber} has used all ${MAX_LISTINGS_PER_CYCLE} of the vault's listings; not relisting`,
      { cycleNumber },
      { dedupeKey: String(cycleNumber) },
    );
    return false;
  }
  if (snap.listingHash !== ZERO_HASH) {
    // The vault refuses a new approval while one is live. Cancel first, next tick relists.
    log.roll.info({ listingHash: snap.listingHash }, 'a listing is already live; not creating another');
    return false;
  }

  const counter = await readCounter(config.VAULT);
  const components = buildOrderComponents({
    offerer: config.VAULT,
    optionId: snap.vaultOptionId,
    contracts: inventory,
    unitPrice6,
    endTime: snap.vaultExerciseTs,
    counter,
  });

  // Cross-check our encoding against Seaport itself before spending gas. Overcall's validator
  // does the same comparison at step 7 and answers 500; catching it here costs one keccak. No
  // force on the alert: this path retries on every tick, and the hourly per-hash cooldown is
  // the right cadence for a mismatch that will not fix itself between two ticks.
  const onChainHash = await readOrderHash(components);
  const offChainHash = localOrderHash(components);
  if (onChainHash.toLowerCase() !== offChainHash.toLowerCase()) {
    await alert(
      'api_reject',
      'locally derived order hash disagrees with seaport.getOrderHash; refusing to publish',
      { onChainHash, offChainHash },
      { dedupeKey: onChainHash },
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
  const offerItem = components.offer[0];
  const vaultLeg = components.consideration[0];
  const overcallLeg = components.consideration[1];
  if (!offerItem || !vaultLeg || !overcallLeg) throw new Error('order builder produced an incomplete order');

  store.insertListing({
    order_hash: onChainHash,
    cycle_number: cycleNumber,
    seq,
    option_id: snap.vaultOptionId.toString(),
    contracts: inventory.toString(),
    unit_price6: unitPrice6.toString(),
    gross_usdg6: (vaultLeg.startAmount + overcallLeg.startAmount).toString(),
    to_vault6: vaultLeg.startAmount.toString(),
    to_overcall6: overcallLeg.startAmount.toString(),
    end_time: Number(components.endTime),
    counter: counter.toString(),
    salt: components.salt.toString(),
    components_json: JSON.stringify(json),
    signature: PLACEHOLDER_SIGNATURE,
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

  mirrorFallbackPayload(onChainHash, components);
  await postToOvercall(onChainHash, json, cycleNumber);
  return true;
}

/**
 * POST to Overcall, and treat failure as survivable.
 *
 * A 200 is an idempotent repost and counts as success. On a persistent failure the listing is
 * marked `post_failed`, an alert goes out, and the signed payload stays available from the
 * keeper's own /orders endpoint for our UI's fallback buy page. The order is a valid, on-chain
 * authorised Seaport order either way — anyone holding a copy can fill it.
 */
async function postToOvercall(orderHash: Hex, json: OrderComponentsJson, cycleNumber: number): Promise<void> {
  try {
    const result = await publishListing(json, PLACEHOLDER_SIGNATURE);
    // Recon R3 (verification C2): Overcall's idempotent-replay short-circuit runs BEFORE
    // validation, so a 200 can carry a row that is not the order we sent. An answer naming a
    // different order hash is a reject, not a success.
    const returnedHash = result.listing?.orderHash;
    if (returnedHash !== undefined && returnedHash.toLowerCase() !== orderHash.toLowerCase()) {
      store.updateListing(orderHash, {
        status: 'post_failed',
        api_error: `book answered the POST with a different orderHash: ${returnedHash}`,
      });
      await alert(
        'api_reject',
        `Overcall answered the POST for ${orderHash} with a different orderHash (${returnedHash}); ` +
          'treating it as a reject. The order is authorised on chain and is being served from /orders.',
        { orderHash, returnedHash, cycleNumber },
        { dedupeKey: orderHash },
      );
      return;
    }
    store.updateListing(orderHash, {
      status: 'posted',
      posted_at: Date.now(),
      api_status: result.listing?.status ?? null,
      api_error: null,
    });
    log.roll.info(
      { orderHash, httpStatus: result.httpStatus, idempotent: result.idempotent, cycleNumber },
      'listing published to Overcall',
    );
    clearAlert('api_reject', orderHash);
  } catch (error) {
    const serverMessage = error instanceof OvercallApiError ? error.serverMessage : null;
    const status = error instanceof OvercallApiError ? error.status : 0;
    store.updateListing(orderHash, {
      status: 'post_failed',
      api_error: serverMessage ?? describeError(error),
    });
    await alert(
      'api_reject',
      `Overcall refused the listing (${status}): ${serverMessage ?? describeError(error)}. ` +
        'The order is authorised on chain and is being served from /orders for our own buy page.',
      { orderHash, status, serverMessage, cycleNumber },
      { dedupeKey: orderHash },
    );
  }
}

/** Mirror the fillable payload to disk for the fallback buy page, if configured. */
function mirrorFallbackPayload(orderHash: Hex, components: OrderComponentsStruct): void {
  if (!config.KEEPER_FALLBACK_DIR) return;
  try {
    mkdirSync(config.KEEPER_FALLBACK_DIR, { recursive: true });
    const payload = {
      orderHash,
      chainId: config.CHAIN_ID,
      // OrderParameters, i.e. what a buyer hands to fulfillOrder / fulfillAdvancedOrder.
      parameters: toOrderParametersJson(components),
      signature: PLACEHOLDER_SIGNATURE,
    };
    writeFileSync(join(config.KEEPER_FALLBACK_DIR, `${orderHash}.json`), JSON.stringify(payload, null, 2));
  } catch (error) {
    log.roll.warn({ err: describeError(error) }, 'could not mirror the fallback payload');
  }
}

/*//////////////////////////////////////////////////////////////
                            RELISTING
//////////////////////////////////////////////////////////////*/

/**
 * Put the inventory back on the book after a cancel or an invalidation.
 *
 * Bounded twice: by the keeper's own KEEPER_MAX_RELISTS (1 by default, per plan.md 5.1) and by
 * the vault's hard cap of 3 listings per cycle, which is read from chain rather than counted
 * locally so a restart cannot lose track of it.
 */
async function maybeRelist(snap: ChainSnapshot): Promise<void> {
  const cycleNumber = snap.vaultCycleNumber;
  const row = store.getCycle(cycleNumber);

  if (snap.optionInventory === 0n) {
    log.roll.debug({ cycleNumber }, 'nothing left to list');
    return;
  }

  const isFirstListing = snap.listingsThisCycle === 0;
  const used = row?.relists_used ?? 0;
  if (!isFirstListing) {
    if (used >= config.KEEPER_MAX_RELISTS) {
      log.roll.info({ cycleNumber, used }, 'relist budget spent; leaving the inventory unlisted');
      return;
    }
    if (snap.listingsThisCycle >= MAX_LISTINGS_PER_CYCLE) return;
  }

  // Price the replacement the same way the first listing was priced. Re-running the picker
  // would also re-pick the strike, which must not change mid-cycle: the vault is already
  // written into one option id.
  const previous = store.latestListingForCycle(cycleNumber);
  let unitPrice6: bigint;
  if (previous) {
    // But never below the floor the chain re-derives from LIVE spot at approveListing
    // (Vault.approveListing -> Policy.checkPremium), plus PREMIUM_MARGIN_BPS: our memory of the
    // earlier price is not a floor, and after a spot uptick it would revert PremiumBelowMinimum
    // on every retry. On a read failure keep the old price; the simulation gate catches a
    // genuinely bad one.
    const floor = await liveFloorUnit6();
    unitPrice6 = relistUnitPrice6(BigInt(previous.unit_price6), floor, config.PREMIUM_MARGIN_BPS);
  } else {
    unitPrice6 = await repriceFromPolicy(snap);
  }
  if (unitPrice6 === 0n) return;

  const listed = await createListing(snap, unitPrice6);

  // The budget is spent only by a relist that actually reached the chain. Charging it up
  // front meant one simulation failure — a transient stale oracle, say — burned the whole
  // week's allowance and left saleable inventory sitting unlisted until Friday.
  if (listed && !isFirstListing) {
    store.updateCycle(cycleNumber, { relists_used: used + 1 });
  }
}

/** The premium floor approveListing will enforce, derived the way the vault derives it: LIVE
 *  spot and LIVE policy. null when the read fails — the caller falls back and lets the
 *  simulation gate be the judge. */
async function liveFloorUnit6(): Promise<bigint | null> {
  try {
    const [policy, spot] = await Promise.all([
      readPolicy(),
      publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'spotUsdg' }),
    ]);
    return minUnitPrice6(spot, policy);
  } catch (error) {
    log.roll.warn({ err: describeError(error) }, 'could not read the live premium floor');
    return null;
  }
}

/** Price a listing when no earlier one exists for this cycle: the policy floor plus
 *  PREMIUM_MARGIN_BPS, lifted to the last observed fill if the book has one. The strike is NOT
 *  re-picked — the vault is already written into one option id and that cannot change mid-cycle. */
async function repriceFromPolicy(snap: ChainSnapshot): Promise<bigint> {
  const floor = await liveFloorUnit6();
  if (floor === null) {
    log.roll.warn({}, 'could not reprice; leaving the inventory unlisted');
    return 0n;
  }
  const lastFill = await lastFilledUnitPrice6([snap.vaultOptionId]);
  // The same margin and clamp pickWrite applies (see liftedUnitPrice6 in policy.ts): a
  // self-fill is a cheap way to shout a fake price, so the signal is honoured only to a
  // multiple of the floor. A zero floor anchors nothing — skip the lift.
  const { unitPrice6: price } = liftedUnitPrice6(floor, config.PREMIUM_MARGIN_BPS, lastFill);
  if (price > snap.vaultStrikeUsdg6 && snap.vaultStrikeUsdg6 > 0n) return 0n;
  return price;
}

/**
 * Clear the vault's live listing so a replacement can be authorised.
 *
 * `cancelListing(components)` is the surgical path and needs the exact components back, which
 * is why they are persisted. When they are not available — a wiped database, a listing another
 * operator authorised — `invalidateAllListings()` bumps the Seaport counter and kills
 * everything at once. That is the guardian's tool and it works with no order data at all.
 */
async function clearVaultListing(snap: ChainSnapshot, why: string): Promise<void> {
  const row = store.getListing(snap.listingHash);
  log.roll.warn({ listingHash: snap.listingHash, why }, 'clearing the vault listing');

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
      const receipt = await sendAndConfirm('cancelListing', snap.vaultCycleNumber, () =>
        walletClient.writeContract(sim.request),
      );
      if (receipt) {
        store.updateListing(row.order_hash, { status: 'cancelled', cancel_tx: receipt.transactionHash });
        await recordCancellation(row.order_hash);
        return;
      }
    }
  }

  const sim = await guardedSimulate('invalidateAllListings', () =>
    publicClient.simulateContract({
      address: config.VAULT,
      abi: vaultAbi,
      functionName: 'invalidateAllListings',
      account,
    }),
  );
  if (!sim) return;
  const receipt = await sendAndConfirm('invalidateAllListings', snap.vaultCycleNumber, () =>
    walletClient.writeContract(sim.request),
  );
  if (receipt && row) {
    store.updateListing(row.order_hash, { status: 'cancelled', cancel_tx: receipt.transactionHash });
    await recordCancellation(row.order_hash);
  }
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
    lock_tx: receipt.transactionHash,
    locked_at: Date.now(),
  });
  // Every still-live listing for this cycle, not just the last one: `lockBook` invalidates
  // them all, and an earlier relist left unretired would keep being offered from /orders.
  for (const live of store.liveListingsForCycle(snap.vaultCycleNumber)) {
    store.updateListing(live.order_hash, { status: 'expired' });
    await recordCancellation(live.order_hash);
  }
  log.roll.info({ cycleNumber: snap.vaultCycleNumber }, 'book locked');
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
 * product makes: depositors are never trapped behind a dead hot key.
 */
async function doRollClose(snap: ChainSnapshot): Promise<void> {
  // MUST be read before the transaction. `rollClose` redeems the claim, which zeroes
  // `claimKey` and makes Valorem's `claim()` revert `TokenNotFound` from then on — so the
  // same read taken afterwards answers 0 and every assigned week would be published as
  // unassigned. The vault has the identical comment at Vault.rollClose for the identical
  // reason; it also emits the number in `RollClose`, which is what gets published. This read is
  // the fallback for a receipt without one and the cross-check for a receipt with one — see
  // resolveContractsAssigned. A failed read is null ("unknown"), never a silent 0.
  const assignedBefore = await contractsAssignedAt(snap);

  const sim = await guardedSimulate('rollClose', () =>
    publicClient.simulateContract({ address: config.VAULT, abi: vaultAbi, functionName: 'rollClose', account }),
  );
  if (!sim) return;

  const receipt = await sendAndConfirm('rollClose', snap.vaultCycleNumber, () =>
    walletClient.writeContract(sim.request),
  );
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
      {
        cycleNumber: snap.vaultCycleNumber,
        fromEvent: String(resolved.fromEvent),
        fromClaim: String(resolved.fromClaim),
        tx: receipt.transactionHash,
      },
      'the RollClose count and the pre-close Valorem claim read disagree; the event is published',
    );
  }
  const assigned = resolved.assigned;
  // The amounts ride in the same RollClose log as the count. No log (the claim-preread and
  // unknown branches above) means unknown: stored NULL and published without a split, never 0.
  const closed = decodeRollClose(receipt);

  // Whatever was still live is dead now: `rollClose` bumps the Seaport counter, which makes
  // the order unfillable without ever setting `isCancelled`, so nothing else would retire
  // these rows and /orders would keep offering a buyer an order Seaport now rejects. Tell the
  // book too — the same best-effort recordCancellation doLockBook sends — or Overcall's row
  // lingers on the book until their lazy expiry sweep.
  for (const live of store.liveListingsForCycle(snap.vaultCycleNumber)) {
    store.updateListing(live.order_hash, { status: 'expired' });
    await recordCancellation(live.order_hash);
  }

  store.ensureCycle(snap.vaultCycleNumber, 'closed');
  backfillOpenTx(snap.vaultCycleNumber);
  store.updateCycle(snap.vaultCycleNumber, {
    status: 'closed',
    roll_close_tx: receipt.transactionHash,
    closed_at: Date.now(),
    gross_usdg6: harvest.gross.toString(),
    fee_usdg6: harvest.fee.toString(),
    net_usdg6: harvest.net.toString(),
    contracts_assigned: assigned,
    assets_returned: closed === null ? null : closed.assetsReturned.toString(),
    usdg_from_assignment: closed === null ? null : closed.usdgFromAssignment.toString(),
  });

  const gross = harvest.gross;
  const summary: RollCloseSummary = {
    cycleNumber: snap.vaultCycleNumber,
    gross,
    fee: harvest.fee,
    net: harvest.net,
    usdgFromAssignment: closed?.usdgFromAssignment ?? null,
    assetsReturned: closed?.assetsReturned ?? null,
    contractsAssigned: assigned,
    witnessedLive: true,
  };
  await alert(
    'roll_close',
    rollCloseMessage(summary),
    {
      ...rollCloseAlertData(summary),
      contractsAssignedSource: resolved.source,
      contractsAssignedFromClaim: resolved.fromClaim === null ? null : Number(resolved.fromClaim),
      tx: receipt.transactionHash,
    },
    { force: true },
  );
  log.roll.info(
    {
      cycleNumber: snap.vaultCycleNumber,
      grossUsdg6: gross.toString(),
      contractsAssigned: assigned,
      contractsAssignedSource: resolved.source,
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
}

const UNWITNESSED_SUFFIX = ' The close ran without this keeper witnessing it; reconstructed from chain logs.';

/**
 * The `roll_close` message. Pure; roll.test.ts pins every wording.
 *
 * On an assigned week the gross includes the strike proceeds, which are returned principal and
 * carry no fee, so the message names premium and strike proceeds separately instead of calling
 * the whole gross "harvested" (K-21):
 *   cycle 3 closed: premium 19.079259 USDG (fee 0.953962), strike proceeds 2025 USDG from 9
 *   contracts assigned; 2043.125297 USDG to depositors.
 * Unfilled and unassigned weeks keep their original wording. An assignment whose proceeds are
 * unknown (no RollClose from the vault — unreachable with the deployed bytecode) says so rather
 * than calling the gross premium.
 */
export function rollCloseMessage(s: RollCloseSummary): string {
  const suffix = s.witnessedLive ? '' : UNWITNESSED_SUFFIX;
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
 * The vault reads `contractsAssigned()` immediately before `_redeemClaim` and emits it in
 * `RollClose` (Vault.sol:797-801, unconditionally), so with the deployed bytecode the event is
 * always in the receipt and is the number published. An event count of 0 is a real unfilled or
 * out-of-the-money week, never a reason to fall through. The keeper's own pre-close read stands
 * in only when the receipt carries no `RollClose` from the vault (a receipt decoded against a
 * mismatched ABI) and is a cross-check when it does: both come from the same Valorem claim across
 * a window in which no exercise can land — the exercise window closes at expiry and rollClose is
 * only sent from expiry — so a disagreement is a keeper or vault defect, not a race.
 *
 * Pure. roll.test.ts pins every branch; dryrun.ts drives both on a real assigned receipt.
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
 * The WHOLE week's harvest, not just the slice that happened to land in the rollClose receipt.
 *
 * WHY THIS IS NOT JUST `decodeHarvest(receipt)`: the vault calls `_checkpointHarvest()` inside
 * `deposit()` and `mint()`, and deposits are open during `Listed`. So a buyer fills on Tuesday,
 * somebody deposits on Wednesday, the deposit sweeps the premium into the index and emits
 * `Harvest(cycle, gross, fee, net)` right then — and Friday's `rollClose` receipt carries
 * `Harvest(cycle, 0, 0, 0)` because there is nothing left to sweep. Reading only the receipt
 * would record a SOLD week as "unfilled, 0", which is precisely the number the product promises
 * to publish honestly. Every Harvest is tagged with the indexed cycle number, so summing the
 * cycle's logs from the rollOpen block to the rollClose block is exact.
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
    // No rollOpen block anywhere: an adopted cycle whose transaction predates this database,
    // and the chain query failed too. The receipt is all we can honestly claim.
    log.roll.warn({ cycleNumber }, 'no rollOpen block on record; harvest read from the rollClose receipt alone');
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
        'summed several Harvest events for this cycle (a deposit checkpointed the premium early)',
      );
    }
    return { gross, fee, net };
  } catch (error) {
    log.roll.warn(
      { cycleNumber, err: describeError(error) },
      'could not read the cycle Harvest logs; falling back to the rollClose receipt',
    );
    return fromReceipt;
  }
}

/**
 * Contracts assigned against the vault's open claim, read from Valorem: the keeper's twin of
 * ValoremLib.contractsAssigned (ValoremLib.sol:146-151), which is what `vault.contractsAssigned()`
 * returns. `claim().amountExercised` is a 1e18-SCALED SCALAR, not a contract count, so it is
 * divided back down; getting that wrong reports a 9-contract assignment as 9e18. A zero
 * `claimKey` is "nothing written this cycle", answered without a read.
 *
 * Call this only BEFORE `rollClose`: `_redeemClaim` zeroes `claimKey` (AdapterValorem.sol:148)
 * and Valorem reverts `TokenNotFound` for the burned claim from then on. Where the vault's
 * library answers 0 to a revert (a view must not revert), the keeper answers null — "unknown" —
 * and logs it, so a failed read can never publish an assigned week as unassigned by accident.
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
