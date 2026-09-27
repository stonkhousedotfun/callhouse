/**
 * The cranker's steps. Each one reads what it needs from chain (reads.ts), asks the planner
 * (planner.ts), and sends through the CrankSender with a fixed gas limit. Each is independent (a
 * failing step does not stop the next), bounded (at most CRANKER_MAX_TX_PER_STEP sends per tick) and
 * idempotent (every send re-checks state, and the contracts no-op a repeat).
 *
 *   index         scan the contracts' logs into the cranker's own index (scanner.ts)
 *   stale         INTERFACE_VERSION 7: AutoRoller.cancelStale for every live roller ask the spot has
 *                 overtaken, before anything slow — the ask fills below intrinsic value until it is withdrawn
 *   snapshot      step 2: SettlementOracle.snapshot once inside [expiry, expiry + 600] for
 *                 every (underlying, expiry) with open interest
 *   finalize      step 3: finalize from expiry + 120 when a view says it would advance; the
 *                 disagreement, held, no-source and stuck alerts
 *   settle        step 3: Clearinghouse.settle every series of a final expiry with long supply, and every expired
 *                 series a House vault still tracks, at any supply (HouseVault._requireFlat needs it)
 *   prune         step 4, first half: every open order of an expired series, resale asks first
 *   redeem        step 4, second half: redeemBatch holders (indexer pages ∪ log index), longs then
 *                 shorts, in chunks sized by fixed per-holder gas budgets and split when a
 *                 simulation under the limit falls short; zero payouts and opted-out holders skipped
 *   ladders       step 1: the registry ladder for the next expiries of each live market and tenor,
 *                 each batch budgeted for the settlement pin a first series of an expiry pays; a refused
 *                 pin (cranker/pin.ts) skips that expiry and pages v2_pin_refused. Since contracts
 *                 createSeries no longer pins (the first MINT does), so that budget is unused
 *                 headroom (planner.ts pinGasOf)
 *   rolls         step 5: AutoRoller.roll for due strategies (skipped without a roller); a roll refused
 *                 by its series' pin pages v2_pin_refused
 *   firstmint     a one-unit take into the keeper's own account on each live-market expiry
 *                 this Clearinghouse has not pinned, under a per-day USDG cap (firstmint.ts), so no
 *                 heavy-hook receiver's fill is the first mint and pays the pin
 *   housekeeping  step 6: prune orders past validUntil; sweepFees per asset weekly
 *
 * EXECUTION ORDER is the list above, not the step numbering: the snapshot window is the only
 * deadline measured in minutes, so a tick woken at an expiry reaches it before anything slow (a
 * cold ladder of 35 markets), and settle and redeem follow finalize in the same tick. `stale` runs first of the
 * sending steps because every block an overtaken roller ask stays live is a block a taker can lift it below
 * intrinsic value, and the call is cheap (350k) and permissionless.
 */
import { BaseError, encodeFunctionData, getAddress, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { autoRollerAbi } from '../abi/autoRoller.js';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { earnVaultAbi } from '../abi/earnVault.js';
import { houseVaultAbi } from '../abi/houseVault.js';
import { houseVaultFactoryAbi } from '../abi/houseVaultFactory.js';
import { expiryCalendarAbi } from '../abi/expiryCalendar.js';
import { orderBookAbi } from '../abi/orderBook.js';
import { priceSourceAbi } from '../abi/priceSource.js';
import { settlementOracleAbi } from '../abi/settlementOracle.js';
import { uniV3TwapSourceAbi } from '../abi/uniV3TwapSource.js';
import { readHead, type Head } from '../chain.js';
import type { CrankerConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { listsDailyOn, marketByUnderlying, TENORS, v2Markets, WEEKDAYS, type Tenor } from '../registry.js';
import { longIdOf, shortIdOf } from '../seriesId.js';
import type { V2Store } from '../store.js';
import { describeError, redactUrls, revertDetail, type ExecuteOptions } from '../tx.js';
import { drainQueue, queueIsOpen, type DrainIo } from '../earn/queue.js';
import { readVenueUnpriced } from '../earn/venue.js';
import { BOOK_PULL_GAS, DAILY_MIN_LEAD_S, GAS, MAX_ORACLE_SOURCES, PIN_REFUSED_RECHECK_S, ROLL_OPEN_GRACE_S, SETTLEMENT_STATUS, SNAPSHOT_GRACE, SOURCE_GAS, STALE_WITNESS_MAX_AGE_S, starvedCeiling, UNIT, VENUE_PULL_GAS } from './constants.js';
import { rollDue } from '../mm/house.js';
import { advanced, type CrankAlerts, type CrankOutcome, type CrankSender, type FixedGasCall } from './effects.js';
import type { CrankerIndex } from './index-store.js';
import type { IndexerClient } from './indexer-client.js';
import {
  chunkByGas,
  chunkCreates,
  expiryKeyString,
  isDeadOrder,
  ladderSlots,
  overtaken,
  planExpiry,
  planLadder,
  planPinGroup,
  planRoll,
  planStale,
  pinGroupKey,
  prunableOrders,
  redeemBaseGas,
  redeemGasOf,
  selectRedeemable,
  splitChunk,
  sweepDue,
  upcomingLadderExpiries,
  type ExpiryKey,
  type GasChunk,
  type HolderView,
  type OrderView,
  type PinGroupView,
  type RollDecision,
} from './planner.js';
import { decodeRevertData, pinRefusalOf, type PinRefusal } from './pin.js';
import { marketOracleOf, okResult, readHolders, readMany, readOrders, surveyExpiries, type AnyRead, type ExpirySurvey } from './reads.js';
import { scanLogs, type LogClient } from './scanner.js';

/** `firstmint` (firstmint.ts) after `rolls`: the rolls just placed the fresh expiry's asks it buys from. */
export const STEP_ORDER = ['index', 'stale', 'snapshot', 'finalize', 'settle', 'prune', 'redeem', 'house', 'ladders', 'rolls', 'firstmint', 'housekeeping', 'flywheel'] as const;
export type StepName = (typeof STEP_ORDER)[number];

export interface ActionRecord {
  what: string;
  kind: string;
  key: string;
  status: CrankOutcome['status'] | 'not-sent';
  hash?: string;
  gasUsed?: string;
  revert?: string | null;
  error?: string;
  result?: unknown;
}

export interface StepReport {
  step: StepName;
  actions: ActionRecord[];
  notes: Record<string, unknown>;
  /** Head timestamps at which this step has time-critical work. */
  wakeAt: number[];
}

export interface CrankAddresses {
  clearinghouse: Address;
  orderBook: Address;
  settlementOracle: Address;
  expiryCalendar: Address;
  autoRoller: Address | null;
  /**
   * The FeeSplitter (`v2.flywheel.feeSplitter`), null until the v8 flywheel is deployed. Nullable for the same
   * reason `autoRoller` is: distribute and buyback are ONE step of eleven, and ops/v2/env/cranker.env:26-27
   * already promises the operator that an empty V2_FEE_SPLITTER makes the cranker skip them and run the rest.
   */
  feeSplitter: Address | null;
  multicall3: Address;
}

export interface CrankContext {
  config: CrankerConfig;
  log: Logger;
  /** Reads, simulations and multicalls (fallback across RPCs). */
  client: PublicClient;
  /** eth_getLogs, pinned to the primary RPC. */
  logClient: LogClient;
  addresses: CrankAddresses;
  store: V2Store;
  index: CrankerIndex;
  sender: CrankSender;
  alerts: CrankAlerts;
  indexer: IndexerClient | null;
  /**
   * Set by the cranker during a tick: true once the head has reached a time-critical target planned this tick (planner
   * yieldDeadlineMs). Every step but snapshot and finalize then stops sending, so the tick ends and the wake-up runs.
   */
  yieldWhen?: () => boolean;
  /**
   * Set by the cranker during a tick: the expiryKeyString of every House vault's current epoch boundary
   * ({houseBoundaryKeys}). The survey marks those expiries `houseBoundary`, so they are snapshotted and finalized with
   * no series. Absent = none.
   */
  houseBoundaries?: ReadonlySet<string>;
  /** SEAM: the index step's backoff wait (INDEX_BACKOFF_MS). Tests pass one that records and returns at once. */
  sleep?: (ms: number) => Promise<void>;
}

const multicall3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);

/* ---- meta keys ---- */
export const snapshotMetaKey = (k: ExpiryKey) => `cranker:snapshot:${expiryKeyString(k)}`;
export const settledSeenMetaKey = (longId: bigint) => `cranker:settled-seen:${longId}`;
export const ladderAnchorMetaKey = (underlying: string, expiry: number, isPut: boolean, tenor: Tenor) => `cranker:ladder:${underlying.toLowerCase()}:${expiry}:${isPut ? 'P' : 'C'}:${tenor}`;
export const sweepMetaKey = (asset: string) => `cranker:sweep:${asset.toLowerCase()}`;
/** When the flywheel step last ran a pass (head seconds). One key: the pass is claim, distribute and buyback together. */
export const flywheelMetaKey = 'cranker:flywheel';
/** A refused settlement pin of one (oracle, underlying, expiry) (planner.pinGroupKey): JSON PinRefusedMark. */
export const pinRefusedMetaKey = (group: string) => `cranker:pin-refused:${group}`;
/** A House vault boundary whose rollEpoch the vault holds: JSON HouseRollHeldMark, keyed by the vault. */
export const houseRollHeldMetaKey = (vault: string) => `cranker:house-roll-held:${vault.toLowerCase()}`;
/** An order OrderBook.prune skipped alone under the gas cap (its maker rejects the refund): the head timestamp it was seen. */
export const unprunableMetaKey = (orderId: bigint) => `cranker:unprunable:${orderId}`;
/** Where the next rolls step starts in its strategy list (a rotation, so no address prefix always goes first). */
export const rollsOffsetMetaKey = 'cranker:rolls:offset';
/** Most rolls per tick that earn no ROLL bounty (under AutoRoller.minRollUnits): each costs the cranker ~700k gas. */
export const ROLLS_BELOW_BOUNTY_PER_TICK = 10;

export const newReport = (step: StepName): StepReport => ({ step, actions: [], notes: {}, wakeAt: [] });

/** How many sends a step may still make this tick; none once the tick must yield (CrankContext.yieldWhen). */
export class Budget {
  used = 0;
  constructor(
    readonly max: number,
    private readonly yieldWhen: (() => boolean) | undefined = undefined,
  ) {}
  get left(): boolean {
    return this.used < this.max && !(this.yieldWhen?.() ?? false);
  }
  spend(outcome: CrankOutcome): void {
    if (['confirmed', 'reverted', 'unconfirmed', 'send-failed', 'would-send'].includes(outcome.status)) this.used += 1;
  }
}

function tickerOf(ctx: CrankContext, underlying: string): string {
  return marketByUnderlying(ctx.config.registry, underlying)?.ticker ?? underlying;
}

/**
 * Whether the market's registry row lists daily expiries (`params.expiriesAhead.daily > 0`; SPCX sets 0).
 * Undefined for a market the registry does not carry or carries without a v2 block: not known, so planRoll
 * refuses nothing on it.
 *
 * And whether the close a daily roll would create now (`rollExpiry`, the roller's own
 * nextExpiry(now + DAILY_MIN_LEAD, false)) is on one of the market's `dailyWeekdays`: an NVDA daily strategy is not
 * rolled into a Tuesday or Thursday series. An unread `rollExpiry` (null) counts as unlisted on a market that restricts
 * its weekdays, so no Tue/Thu series is ever created on a failed read; the next tick reads again.
 */
function dailyListedOf(ctx: CrankContext, underlying: string, rollExpiry: number | null): boolean | undefined {
  const params = marketByUnderlying(ctx.config.registry, underlying)?.v2?.params;
  if (params === undefined) return undefined;
  if (params.expiriesAhead.daily === 0) return false;
  if (params.dailyWeekdays.length === WEEKDAYS.length) return true;
  return rollExpiry !== null && listsDailyOn(params, rollExpiry);
}

/** A Multicall3 result list reads as counts in a report; anything else as it is. */
function summarizeResult(result: unknown): unknown {
  if (Array.isArray(result) && result.every((r) => typeof r === 'object' && r !== null && 'success' in r)) {
    const succeeded = result.filter((r) => (r as { success: boolean }).success).length;
    return { succeeded, failed: result.length - succeeded };
  }
  return result;
}

/**
 * Send (or, dry, judge) one call and record it in the report; pages v2_tx_revert on a revert, a lost receipt, or a
 * broadcast that failed: the signing wallet is pinned to RH_RPC while reads fall back, so a primary that answers reads
 * but refuses sends would otherwise leave /health ok while nothing reaches the chain.
 *
 * AND v2_rpc_lag WHEN THE SIMULATION GOT NO ANSWER. A full outage never reaches here:
 * runtime.ts probes the chain first and a probe that fails on every RPC pages v2_rpc_lag, throws, and stales the
 * heartbeat. A PARTIAL outage does reach here -- the head answers, eth_call does not (a rate limit, a timeout, a node
 * that stopped serving simulations) -- as an ordinary `simulation-reverted` carrying `transportError: true`. Before this
 * the steps treated that as a contract's answer: prune and redeem dropped it (fellShort excludes it, so the chunk was
 * simply skipped), rolls listed it as "reverting", settle paged v2_settle_stuck as "reverts (null)" and cancelStale
 * paged "refused (no reason)". Nothing said the node. This names it once, at the one place every send passes, keyed
 * per step kind so a node that is down for an hour pages once per step and not once per series.
 */
export async function send(ctx: CrankContext, report: StepReport, budget: Budget, what: string, call: FixedGasCall, options: ExecuteOptions<unknown>): Promise<CrankOutcome> {
  const outcome = await ctx.sender.execute(call, options);
  budget.spend(outcome);
  const record: ActionRecord = { what, kind: options.kind, key: options.key, status: outcome.status };
  if ('hash' in outcome) record.hash = outcome.hash;
  if ('gasUsed' in outcome) record.gasUsed = outcome.gasUsed.toString();
  if (outcome.status === 'simulation-reverted') {
    record.revert = outcome.revert;
    record.error = outcome.error.slice(0, 300);
  }
  if (outcome.status === 'send-failed' || outcome.status === 'unconfirmed') record.error = outcome.error.slice(0, 300);
  if (outcome.status === 'no-op' || outcome.status === 'confirmed' || outcome.status === 'would-send') record.result = summarizeResult(outcome.result);
  report.actions.push(record);
  if (outcome.status === 'simulation-reverted' && outcome.transportError === true) {
    await ctx.alerts.raise({
      kind: 'v2_rpc_lag',
      dedupeKey: `transport:${options.kind}`,
      once: false,
      severity: 'warn',
      message: `cranker ${what}: the node did not answer the simulation (${outcome.error.slice(0, 160)}). This is a transport failure, not a contract refusal: nothing was sent and the step retries next tick`,
      data: { kind: options.kind, key: options.key, status: outcome.status, transportError: true, error: outcome.error.slice(0, 300) },
    });
  }
  if (outcome.status === 'reverted' || outcome.status === 'unconfirmed' || outcome.status === 'send-failed') {
    const why = outcome.status === 'reverted' ? 'reverted on chain' : outcome.status === 'unconfirmed' ? 'not confirmed in time' : `could not be broadcast (${outcome.error.slice(0, 160)})`;
    await ctx.alerts.raise({
      kind: 'v2_tx_revert',
      dedupeKey: `${options.kind}:${options.key}`,
      once: false,
      message: `cranker ${what}: transaction ${why}`,
      data: { kind: options.kind, key: options.key, status: outcome.status, ...('hash' in outcome ? { hash: outcome.hash } : {}) },
    });
  }
  return outcome;
}

/**
 * The limit a snapshot or finalize is RESENT with when its simulation reverted without a reason:
 * the fixed limit plus starvedCeiling(SOURCE_GAS) for every source call the oracle makes (`sourceCalls`), so each of
 * them either answers or is recorded not ok, whatever the ones before it burned. Capped 2M under the chain's
 * per-transaction cap, like the House roll.
 */
export function oracleStarvedGas(base: bigint, sourceCalls: number): bigint {
  const gas = base + BigInt(sourceCalls) * starvedCeiling(SOURCE_GAS);
  const cap = CHAIN_MAX_TX_GAS - 2_000_000n;
  return gas < cap ? gas : cap;
}

/**
 * How many source calls one snapshot or finalize makes, for oracleStarvedGas: `snapshot` records each source once
 * (SettlementOracle `_record`); `finalize` records each one first while `now <= expiry + SNAPSHOT_GRACE` and then reads
 * each one's window (`_refresh`), so twice inside the grace. An unreadable source list counts as MAX_ORACLE_SOURCES.
 */
export function oracleSourceCalls(view: { sourcesKnown: boolean; sources: readonly unknown[] }, fn: 'snapshot' | 'finalize', now: number, expiry: number): number {
  const n = view.sourcesKnown ? view.sources.length : MAX_ORACLE_SOURCES;
  return fn === 'finalize' && now <= expiry + SNAPSHOT_GRACE ? 2 * n : n;
}

/**
 * {send}, then once more at oracleStarvedGas when the simulation reverted with no reason.
 *
 * SettlementOracle sends every source call with `{gas: SOURCE_GAS}` and, when it held less than starvedCeiling(SOURCE_GAS)
 * just before, RE-THROWS a failure that left it a quarter of its gas instead of recording the source not ok
 * (SettlementOracle.sol:947-948, :1029-1030, :1084-1085). A correct source never fails that way, so GAS.snapshot and
 * GAS.finalize stand; but a source that burns what it is handed now reverts the whole call at those limits, with no
 * reason (an out-of-gas carries none), every tick. That revert means "resend with more gas", never "the source failed"
 * and never a reason to give up on the expiry, so it is resent at once. A decoded revert (TooEarly, a pause) or a
 * transport failure is the contract's or the node's answer and is not resent.
 */
async function sendPastStarvedSources(ctx: CrankContext, report: StepReport, budget: Budget, what: string, call: FixedGasCall, options: ExecuteOptions<unknown>, sourceCalls: number): Promise<CrankOutcome> {
  const first = await send(ctx, report, budget, what, call, options);
  if (first.status !== 'simulation-reverted' || first.revert !== null || first.transportError === true) return first;
  const gas = oracleStarvedGas(call.gas, sourceCalls);
  if (gas <= call.gas || !budget.left) return first;
  ctx.log.warn({ what, gas: gas.toString(), sourceCalls }, 'simulation reverted without a reason: resent with every source call\'s starved-call ceiling (T-OP-679)');
  return send(ctx, report, budget, `${what} (resent at ${gas} gas: a source call may have been starved, T-OP-679)`, { ...call, gas }, options);
}

export async function head(ctx: CrankContext): Promise<Head> {
  return readHead(ctx.client);
}

/**
 * prunableOrders without the orders the book was found to skip (unprunableMetaKey), for good: one maker who rejects its
 * refund cannot keep an expiry from being finished. Such an order stays on the book until its maker cancels it.
 */
function prunableHere(ctx: CrankContext, orders: readonly OrderView[], now: number): OrderView[] {
  return prunableOrders(orders, now).filter((o) => ctx.store.getMeta(unprunableMetaKey(o.id)) === null);
}

async function survey(ctx: CrankContext, keys: readonly ExpiryKey[], now: Head, withOrders: boolean): Promise<ExpirySurvey[]> {
  return surveyExpiries(ctx.client, {
    clearinghouse: ctx.addresses.clearinghouse,
    orderBook: ctx.addresses.orderBook,
    keys,
    seriesOf: (k) => ctx.index.seriesOf(k.underlying, k.expiry, k.oracle),
    snapshotDone: (k) => ctx.store.getMeta(snapshotMetaKey(k)) !== null,
    houseBoundary: (k) => ctx.houseBoundaries?.has(expiryKeyString(k)) ?? false,
    now: now.timestamp,
    blockNumber: now.blockNumber,
    withOrders,
    prunable: (orders, at) => prunableHere(ctx, orders, at),
  });
}

const thresholds = (ctx: CrankContext) => ({ noSourceAlertS: ctx.config.tuning.noSourceAlertS, pendingStuckS: ctx.config.tuning.pendingStuckS });

/*//////////////////////////////////////////////////////////////
                              INDEX
//////////////////////////////////////////////////////////////*/

/*
 * THE FAILURE THIS STEP USED TO REPORT WAS "HTTP request failed", AND NOTHING ELSE. That is viem's shortMessage
 * for any non-2xx answer (HttpRequestError), and describeError (tx.ts) prints only the shortMessage, so the page named
 * neither the node nor the status nor what the node said -- in production, for weeks, every tick. The step now says all
 * three, with the RPC HOST only: provider URLs carry their key in the path or the query, so the URL is never printed.
 *
 * WHAT IS RETRIED. A transient failure -- no HTTP status (a network error or a timeout), 408, 429 or a 5xx -- is tried
 * again after INDEX_BACKOFF_MS, up to INDEX_ATTEMPTS in all. A deterministic refusal (any other 4xx: e.g. a node that
 * refuses archive-depth eth_getLogs with 403, which robinhood-rpc.publicnode.com does for any range starting more than
 * ~128 blocks back, measured 2026-09-23) fails at once: waiting cannot change the answer, and the snapshot step behind
 * this one is time-critical. scanLogs' own chunk halving still runs inside every attempt.
 *
 * WHY THERE IS NO BACKUP-RPC FALLBACK FOR eth_getLogs. The log client is pinned to RH_RPC on purpose (chain.ts,
 * scanner.ts): the index cursor moves on whatever a range returned, so a backup that answered a range it does not hold
 * with an empty result would make the cranker skip those blocks for good -- series never settled, holders never
 * redeemed -- and nothing would say so. The head read already falls back (it runs on ctx.client, which ranks RH_RPC and
 * RH_RPC_2). Moving eth_getLogs to a backup is safe only once the backup is an archive node whose answers can be trusted
 * past its own head; that is an ops decision, not a retry policy.
 */

/** Tries of each index-step RPC phase, the first included. */
export const INDEX_ATTEMPTS = 3;
/** Wait before try 2, then before try 3, milliseconds. Short: the index step runs first in every tick. */
export const INDEX_BACKOFF_MS: readonly number[] = [500, 1_500];

export type IndexPhase = 'head' | 'scan';

/** An index-step failure that names the phase, the RPC host (never the URL), the HTTP status and the node's words. */
export class IndexStepError extends Error {
  constructor(
    readonly phase: IndexPhase,
    readonly host: string,
    readonly status: number | null,
    readonly attempts: number,
    readonly detail: string,
  ) {
    super(
      `${phase === 'head' ? 'head read' : 'eth_getLogs'} failed at ${host}${status === null ? '' : ` (HTTP ${status})`} ` +
        `after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${detail}`,
    );
    this.name = 'IndexStepError';
  }
}

/** The host (and port) of `url`, or null. Never its path, query or credentials. */
export function rpcHost(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url === '') return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

export interface RpcFailure {
  host: string | null;
  status: number | null;
  /** describeError plus the node's own words, every URL reduced to its origin, at most 300 characters. */
  detail: string;
  transient: boolean;
}

/** Where and why a viem transport error happened, read off the error and its causes, without any URL in it. */
export function rpcFailureOf(error: unknown): RpcFailure {
  let url: string | undefined;
  let status: number | null = null;
  let details: string | undefined;
  let cur: unknown = error;
  for (let depth = 0; depth < 8 && cur !== null && typeof cur === 'object'; depth += 1) {
    const e = cur as { url?: unknown; status?: unknown; details?: unknown; cause?: unknown };
    if (url === undefined && typeof e.url === 'string') url = e.url;
    if (status === null && typeof e.status === 'number') status = e.status;
    if (details === undefined && typeof e.details === 'string' && e.details !== '') details = e.details;
    cur = e.cause;
  }
  const base = describeError(error);
  const detail = redactUrls(details !== undefined && !base.includes(details) ? `${base} ${details}` : base).slice(0, 300);
  const transient = error instanceof BaseError && (status === null || status === 408 || status === 429 || status >= 500);
  return { host: rpcHost(url), status, detail, transient };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `fn` with the index step's retry rule; its last failure as an IndexStepError. `knownHost`: the pinned client's. */
async function indexPhase<T>(ctx: CrankContext, phase: IndexPhase, knownHost: string | null, fn: () => Promise<T>): Promise<T> {
  const sleep = ctx.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const f = rpcFailureOf(error);
      const host = f.host ?? knownHost ?? 'unknown host';
      if (!f.transient || attempt >= INDEX_ATTEMPTS) throw new IndexStepError(phase, host, f.status, attempt, f.detail);
      const waitMs = INDEX_BACKOFF_MS[attempt - 1] ?? INDEX_BACKOFF_MS[INDEX_BACKOFF_MS.length - 1] ?? 0;
      ctx.log.warn({ step: 'index', phase, host, status: f.status, attempt, waitMs, err: f.detail }, 'index RPC call failed; retrying');
      await sleep(waitMs);
    }
  }
}

export async function stepIndex(ctx: CrankContext): Promise<StepReport> {
  const report = newReport('index');
  const h = await indexPhase(ctx, 'head', null, () => head(ctx));
  // The log client is pinned to RH_RPC (chain.ts), so an error that carries no URL still has a known host.
  const result = await indexPhase(ctx, 'scan', rpcHost(ctx.config.rpcUrls[0]), () =>
    scanLogs(
      ctx.logClient,
      ctx.index,
      {
        clearinghouse: ctx.addresses.clearinghouse,
        orderBook: ctx.addresses.orderBook,
        autoRoller: ctx.addresses.autoRoller,
        fromBlock: ctx.config.registry.deployBlock ?? 0n,
      },
      { head: h.blockNumber, chunkBlocks: ctx.config.tuning.logChunkBlocks, maxChunks: ctx.config.tuning.logChunksPerTick },
    ),
  );
  report.notes = { ...result, head: h.blockNumber, lagBlocks: h.blockNumber - (ctx.index.scannedTo() ?? 0n), ...ctx.index.counts() };
  return report;
}

/*//////////////////////////////////////////////////////////////
                          STALE ASKS
//////////////////////////////////////////////////////////////*/

/** Most cancelStale sends per tick that earn no CANCEL_STALE bounty (under AutoRoller.minRollUnits): 350k gas each. */
export const STALE_BELOW_BOUNTY_PER_TICK = 10;

interface RollerOrderStruct {
  maker: Address;
  longId: bigint;
  kind: number;
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
}

interface RollerSeriesStruct {
  isPut: boolean;
  strike: bigint;
  /** The series' expiry: the one whose settlement configuration names the witness (AutoRoller._tryWitness). */
  expiry: number;
  /** The oracle createSeries pinned into the series: the one it settles on and AutoRoller.cancelStale reads. */
  oracle: Address;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const MAX_UINT128 = (1n << 128n) - 1n;

/** The issuer's corporate-action switch on a Stock Token, which `_tryWitness` reads (a revert counts as paused). */
const oraclePausableAbi = parseAbi(['function oraclePaused() view returns (bool)']);

/** stepStale's spot key: one oracle's price for one underlying. Two series of one underlying may differ. */
const spotKey = (oracle: Address, underlying: Address): string => `${oracle.toLowerCase()}:${underlying.toLowerCase()}`;

/** stepStale's witness key: one oracle's settlement configuration of one (underlying, expiry). */
const witnessKey = (oracle: Address, underlying: Address, expiry: number): string => `${spotKey(oracle, underlying)}:${expiry}`;

/**
 * `AutoRoller._tryWitness(oracle, underlying, expiry)` for every key in `keys`, read at `h`: the price when
 * ok, else null. Its conditions, in its order, each one a null here where the contract returns (false, 0, 0):
 * `settlementConfig(underlying, expiry)` answers and lists a source 1; the issuer's `oraclePaused()` answers false;
 * source 1's `latest(underlying)` answers ok with a price in (0, 2^128], an `updatedAt` no later than now and at most
 * STALE_WITNESS_MAX_AGE_S before it. Two reads of the chain, only for the keys asked (the asks the spot did not settle).
 */
async function witnessesAt(ctx: CrankContext, keys: ReadonlyArray<{ oracle: Address; underlying: Address; expiry: number }>, h: Head): Promise<Map<string, bigint | null>> {
  const out = new Map<string, bigint | null>();
  if (keys.length === 0) return out;
  const configs = await readMany(
    ctx.client,
    keys.map((k): AnyRead => ({ address: k.oracle, abi: settlementOracleAbi, functionName: 'settlementConfig', args: [k.underlying, k.expiry] })),
    h.blockNumber,
  );
  const withSource1 = keys.flatMap((k, i) => {
    const sources = okResult<readonly [boolean, readonly Address[], number, number, number]>(configs[i])?.[1];
    if (sources === undefined || sources.length < 2) {
      out.set(witnessKey(k.oracle, k.underlying, k.expiry), null);
      return [];
    }
    return [{ ...k, source: getAddress(sources[1]!) }];
  });
  if (withSource1.length === 0) return out;
  const underlyings = [...new Map(withSource1.map((k) => [k.underlying.toLowerCase(), k.underlying])).values()];
  const latests = [...new Map(withSource1.map((k) => [spotKey(k.source, k.underlying), k])).values()];
  const second = await readMany(
    ctx.client,
    [
      ...underlyings.map((underlying): AnyRead => ({ address: underlying, abi: oraclePausableAbi, functionName: 'oraclePaused' })),
      ...latests.map(({ source, underlying }): AnyRead => ({ address: source, abi: priceSourceAbi, functionName: 'latest', args: [underlying] })),
    ],
    h.blockNumber,
  );
  // A revert of oraclePaused() counts as paused, as in SettlementOracle `_oraclePaused` and `_tryWitness`.
  const paused = new Map(underlyings.map((u, i) => [u.toLowerCase(), okResult<boolean>(second[i]) !== false]));
  const latestOf = new Map(latests.map((k, i) => [spotKey(k.source, k.underlying), okResult<readonly [boolean, bigint, bigint]>(second[underlyings.length + i])]));
  for (const k of withSource1) {
    const r = latestOf.get(spotKey(k.source, k.underlying));
    const fresh = r !== undefined && r[0] && r[1] > 0n && r[1] <= MAX_UINT128 && r[2] <= BigInt(h.timestamp) && BigInt(h.timestamp) - r[2] <= BigInt(STALE_WITNESS_MAX_AGE_S);
    out.set(witnessKey(k.oracle, k.underlying, k.expiry), paused.get(k.underlying.toLowerCase()) === true || !fresh ? null : r[1]);
  }
  return out;
}

/** The (writer, underlying) pairs with an AutoRoller strategy: the cranker's log index ∪ the indexer's active list. */
async function strategyPairs(ctx: CrankContext): Promise<{ list: Array<{ writer: Address; underlying: Address }>; indexer: string }> {
  const pairs = new Map<string, { writer: Address; underlying: Address }>();
  for (const s of ctx.index.strategies()) pairs.set(`${s.writer}:${s.underlying}`, { writer: getAddress(s.writer), underlying: getAddress(s.underlying) });
  let indexer = ctx.indexer === null ? 'off' : 'ok';
  if (ctx.indexer !== null) {
    const result = await ctx.indexer.activeStrategies();
    if (result.ok) for (const s of result.items) pairs.set(`${s.writer.toLowerCase()}:${s.underlying.toLowerCase()}`, s);
    else indexer = `down (${result.reason}); log index only`;
  }
  return { list: [...pairs.values()], indexer };
}

/**
 * INTERFACE_VERSION 7: withdraw every live AutoRoller ask the spot has overtaken.
 *
 * WHY IT IS A STEP OF ITS OWN, AND FIRST. A roll-time AskWrite is priced at a few per cent of the spot it was
 * written at; after a rally past the strike every price the writer's band allows is below intrinsic value, so the
 * ask is free money for the first taker and `reprice` refuses to touch it (`InTheMoney`). `cancelStale` is
 * permissionless, moves no collateral, runs under every pause, and pays the CANCEL_STALE bounty when the cancelled
 * remainder is at least `minRollUnits`. After it, `longId` and `expiry` stay and `orderId` is 0: no re-roll inside
 * the period, and the close-out at expiry is unchanged.
 *
 * ORDER AND BUDGET, as the rolls step does it: bounty-paying cancels first, at most
 * STALE_BELOW_BOUNTY_PER_TICK below the threshold, so a crowd of dust strategies cannot spend the tick.
 *
 * ORACLE. The spot of each ask comes from ITS SERIES' pinned oracle (`Clearinghouse.series(longId).oracle`),
 * which is what `cancelStale` reads on chain and what the series settles on. Never `market(u).oracle`: a
 * `setMarketOracle` moves the market's pointer and leaves every existing series on its old oracle, and a mirror that
 * read the market's would decide "not overtaken" on a price the contract does not use, leaving an in-the-money ask
 * resting. Two series under one underlying can therefore be judged on two oracles in one tick, so spots are keyed by
 * (oracle, underlying). A series whose read failed has no known oracle: no spot is read for it from any oracle and
 * planStale answers `unread`. (stepRolls keeps `market(u).oracle`: a roll plans the NEW series, and AutoRoller.roll
 * reads the market's oracle for exactly that.)
 *
 * ALERTS. `planStale` mirrors the contract's own conditions, so a simulation that still refuses means the writer's
 * ask cannot be withdrawn by anyone but the writer: `v2_stale_cancel_failed`, as `warn` for the `NotAuthorized` of a
 * revoked delegate (only the writer can restore it) and `error` otherwise.
 */
export async function stepStale(ctx: CrankContext): Promise<StepReport> {
  const report = newReport('stale');
  const roller = ctx.addresses.autoRoller;
  if (roller === null) {
    report.notes = { skipped: 'no autoRoller configured (V2_AUTO_ROLLER / registry v2.contracts.autoRoller)' };
    return report;
  }
  const budget = new Budget(ctx.config.tuning.maxTxPerStep);
  const h = await head(ctx);
  const { list, indexer } = await strategyPairs(ctx);
  if (list.length === 0) {
    report.notes = { strategies: 0, indexer };
    return report;
  }

  const first = await readMany(
    ctx.client,
    [
      ...list.map((p): AnyRead => ({ address: roller, abi: autoRollerAbi, functionName: 'position', args: [p.writer, p.underlying] })),
      { address: roller, abi: autoRollerAbi, functionName: 'minRollUnits' },
    ],
    h.blockNumber,
  );
  const positions = list.map((_, i) => okResult<readonly [bigint, bigint, number]>(first[i]));
  // FAIL CLOSED. The minimum decides which
  // cancels earn the bounty and which fall under STALE_BELOW_BOUNTY_PER_TICK; `?? 0n` made every cancel "earn" it on a
  // failed read and so lifted the cap. Nothing is planned or sent this tick; the next tick reads it again.
  const minRollUnits = okResult<bigint>(first[list.length]);
  if (minRollUnits === undefined) {
    report.notes = { strategies: list.length, indexer, minRollUnits: null, skipped: 'minRollUnits() read failed: no ask is judged this tick rather than judged against a minimum of 0' };
    return report;
  }

  // Only a pair with a tracked ask inside its period can be withdrawn: nothing else costs a read.
  const live = list.map((p, i) => ({ p, position: positions[i] })).filter((x) => x.position !== undefined && x.position[1] !== 0n && h.timestamp < Number(x.position[2]));
  if (live.length === 0) {
    report.notes = { strategies: list.length, indexer, withLiveAsk: 0 };
    return report;
  }
  const orderIds = live.map((x) => x.position![1]);
  const longIds = [...new Set(live.map((x) => x.position![0]))];
  const second = await readMany(
    ctx.client,
    [
      { address: ctx.addresses.orderBook, abi: orderBookAbi, functionName: 'getOrders', args: [orderIds] },
      ...longIds.map((id): AnyRead => ({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'series', args: [id] })),
    ],
    h.blockNumber,
  );
  const orders = okResult<readonly RollerOrderStruct[]>(second[0]) ?? [];
  // A series that could not be read, or reads back with no oracle, has no known pinned oracle: it is not judged.
  const seriesOf = new Map(
    longIds.map((id, i) => {
      const s = okResult<RollerSeriesStruct>(second[1 + i]);
      return [id.toString(), s === undefined || typeof s.oracle !== 'string' || s.oracle.toLowerCase() === ZERO_ADDRESS ? undefined : s] as const;
    }),
  );
  // One trySpot per (pinned oracle, underlying) that some live ask is judged on.
  const spotReads = [
    ...new Map(
      live.flatMap((x) => {
        const s = seriesOf.get(x.position![0].toString());
        return s === undefined ? [] : [[spotKey(s.oracle, x.p.underlying), { oracle: getAddress(s.oracle), underlying: x.p.underlying }] as const];
      }),
    ).values(),
  ];
  const third = spotReads.length === 0 ? [] : await readMany(ctx.client, spotReads.map((r): AnyRead => ({ address: r.oracle, abi: settlementOracleAbi, functionName: 'trySpot', args: [r.underlying] })), h.blockNumber);
  const spotOf = new Map(
    spotReads.map((r, i) => {
      const res = okResult<readonly [boolean, bigint, bigint]>(third[i]);
      return [spotKey(r.oracle, r.underlying), res !== undefined && res[0] && res[1] > 0n ? res[1] : null] as const;
    }),
  );

  // The witness is what cancelStale reads when the spot does not settle it (not ok, or short of the strike):
  // read it for exactly those asks, one settlementConfig per (pinned oracle, underlying, series expiry).
  const witnessWanted = [
    ...new Map(
      live.flatMap((x) => {
        const s = seriesOf.get(x.position![0].toString());
        if (s === undefined) return [];
        const spot = spotOf.get(spotKey(s.oracle, x.p.underlying)) ?? null;
        if (spot !== null && overtaken(s.isPut, s.strike, spot)) return [];
        const k = { oracle: getAddress(s.oracle), underlying: x.p.underlying, expiry: Number(s.expiry) };
        return [[witnessKey(k.oracle, k.underlying, k.expiry), k] as const];
      }),
    ).values(),
  ];
  const witnessOf = await witnessesAt(ctx, witnessWanted, h);

  const decided = live.map((x, i) => {
    const order = orders[i];
    const series = seriesOf.get(x.position![0].toString());
    const spot = series === undefined ? null : (spotOf.get(spotKey(series.oracle, x.p.underlying)) ?? null);
    const witness = series === undefined ? null : (witnessOf.get(witnessKey(getAddress(series.oracle), x.p.underlying, Number(series.expiry))) ?? null);
    return {
      p: x.p,
      longId: x.position![0],
      orderId: x.position![1],
      oracle: series?.oracle ?? null,
      spot,
      witness,
      strike: series?.strike ?? null,
      decision: planStale({
        orderId: x.position![1],
        positionExpiry: Number(x.position![2]),
        now: h.timestamp,
        order: order === undefined || order.maker.toLowerCase() === ZERO_ADDRESS ? null : { units: BigInt(order.units), filled: BigInt(order.filled), validUntil: Number(order.validUntil), cancelled: order.cancelled },
        series: series === undefined ? null : { isPut: series.isPut, strike: series.strike },
        spot,
        witness,
        minRollUnits,
      }),
    };
  });
  const cancelling = decided.filter((d) => d.decision.cancel);
  const viaOf = (d: (typeof decided)[number]) => (d.decision.cancel ? d.decision.via : null);
  /** The reading the decision was made on: the spot, or the witness when the spot did not settle it. */
  const reading = (d: (typeof decided)[number]) => (viaOf(d) === 'witness' ? `witness ${d.witness}, spot ${d.spot}` : `spot ${d.spot}`);
  const ordered = [...cancelling.filter((d) => (d.decision as { earnsBounty: boolean }).earnsBounty), ...cancelling.filter((d) => !(d.decision as { earnsBounty: boolean }).earnsBounty)];

  const cancelled: unknown[] = [];
  const refused: unknown[] = [];
  let belowBounty = 0;
  for (const d of ordered) {
    const key = `${d.p.writer.toLowerCase()}:${d.p.underlying.toLowerCase()}`;
    if (!budget.left) break;
    if (!(d.decision as { earnsBounty: boolean }).earnsBounty) {
      if (belowBounty >= STALE_BELOW_BOUNTY_PER_TICK) continue;
      belowBounty += 1;
    }
    const ticker = tickerOf(ctx, d.p.underlying);
    const outcome = await send(
      ctx,
      report,
      budget,
      `cancelStale ${d.p.writer} ${ticker} (${reading(d)} at or past strike ${d.strike})`,
      { address: roller, abi: autoRollerAbi, functionName: 'cancelStale', args: [d.p.writer, d.p.underlying], gas: GAS.cancelStale },
      { kind: 'cancelStale', key, worthSending: (did) => did === true },
    );
    cancelled.push({ writer: d.p.writer, ticker, orderId: d.orderId.toString(), oracle: d.oracle, spot: d.spot, witness: d.witness, via: viaOf(d), strike: d.strike, status: outcome.status });
    if (outcome.status === 'simulation-reverted') {
      // planStale already held every condition the contract returns `false` for, so a refusal here is a state only
      // the writer (a revoked delegate) or the admin can change.
      const revoked = outcome.revert === 'NotAuthorized';
      refused.push({ writer: d.p.writer, ticker, revert: outcome.revert, delegateRevoked: revoked });
      await ctx.alerts.raise({
        kind: 'v2_stale_cancel_failed',
        dedupeKey: key,
        once: false,
        severity: revoked ? 'warn' : 'error',
        message: `${ticker}: the AutoRoller ask of ${d.p.writer} is at or past its ${d.strike} strike (${reading(d)}) but cancelStale is refused (${outcome.revert ?? 'no reason'})${revoked ? ': the writer revoked the roller, so only the writer can withdraw it' : ''}`,
        data: { writer: d.p.writer, underlying: d.p.underlying, longId: d.longId.toString(), orderId: d.orderId.toString(), spot: d.spot, witness: d.witness, via: viaOf(d), strike: d.strike, revert: outcome.revert, delegateRevoked: revoked },
      });
    } else if (advanced(outcome) || outcome.status === 'no-op') {
      ctx.alerts.clear('v2_stale_cancel_failed', key);
    }
  }

  report.notes = {
    strategies: list.length,
    indexer,
    withLiveAsk: live.length,
    overtaken: cancelling.length,
    belowMinRollUnitsSent: belowBounty,
    minRollUnits,
    cancelled,
    ...(refused.length > 0 ? { refused } : {}),
    reasons: decided.reduce<Record<string, number>>((acc, d) => {
      const r = d.decision.cancel ? 'cancel' : d.decision.reason;
      acc[r] = (acc[r] ?? 0) + 1;
      return acc;
    }, {}),
  };
  return report;
}

/*//////////////////////////////////////////////////////////////
                            SNAPSHOT
//////////////////////////////////////////////////////////////*/

/**
 * After a mined snapshot, the expiry surveyed again at the receipt's block through the planner's own reads: the
 * number of its sources that price the window there and did not in `before`, or null unless EVERY source prices it (a
 * source left dark is what the next snapshot, or v2_snapshot_missed, is for). Null also when the sources are unknown or
 * the read fails: the mark is not set on what could not be seen.
 */
async function recordedAtBlock(ctx: CrankContext, before: ExpirySurvey, at: Head): Promise<number | null> {
  const label = `${tickerOf(ctx, before.key.underlying)} ${before.key.expiry}`;
  try {
    const [after] = await survey(ctx, [before.key], at, false);
    const sources = after?.view.sources ?? [];
    const dark = sources.filter((x) => !x.windowOk).map((x) => x.address);
    if (sources.length === 0 || dark.length > 0) {
      ctx.log.warn({ expiry: label, block: at.blockNumber.toString(), dark }, 'a mined snapshot left sources that do not price the window: not marked, the next tick asks again');
      return null;
    }
    const wasOk = new Set(before.view.sources.filter((x) => x.windowOk).map((x) => x.address.toLowerCase()));
    return sources.filter((x) => !wasOk.has(x.address.toLowerCase())).length;
  } catch (error) {
    ctx.log.warn({ expiry: label, block: at.blockNumber.toString(), error: describeError(error) }, 'could not re-read the sources after a mined snapshot: not marked');
    return null;
  }
}

/**
 * How soon a snapshot that left the
 * expiry without its pool leg is tried again while the grace is still open. UniV3TwapSource.record answers false and
 * stores nothing when it cannot price the window at that moment (observe fails, its buffer does not reach back,
 * liquidity is under the floor) and allows a retry inside [expiry, expiry + SNAPSHOT_GRACE]; after that it can never
 * record, and the expiry settles on Chainlink alone, uncorroborated. The planner wakes the cranker at the expiry and at
 * finalize's opening only, so without this target an attempt that failed after expiry + FINALIZE_DELAY waited for the
 * next poll, which POLL_INTERVAL_MS (up to an hour) can put past the grace.
 */
export const SNAPSHOT_RETRY_S = 60;

/**
 * The expiry's sources that a snapshot can still help, read at `at`: those that do not price the window AND
 * answer UniV3TwapSource.snapshots(underlying, expiry) with nothing stored. A source that does not answer that view is
 * not snapshot-backed (ChainlinkFeedSource: its round history is replayable, so its `record` is always false) and does
 * not hold the expiry open; it prices the window, or not, whatever the cranker sends. Null when the sources are unknown
 * or the read fails: the mark is not set on what could not be seen.
 */
async function awaitingSnapshot(ctx: CrankContext, s: ExpirySurvey, at: Head): Promise<Address[] | null> {
  if (!s.view.sourcesKnown) return null;
  const dark = s.view.sources.filter((x) => !x.windowOk).map((x) => getAddress(x.address));
  if (dark.length === 0) return [];
  const underlying = getAddress(s.key.underlying);
  try {
    const reads = await readMany(ctx.client, dark.map((address): AnyRead => ({ address, abi: uniV3TwapSourceAbi, functionName: 'snapshots', args: [underlying, s.key.expiry] })), at.blockNumber);
    return dark.filter((_, i) => okResult<readonly [bigint, number, number]>(reads[i])?.[0] === 0n);
  } catch (error) {
    ctx.log.warn({ expiry: `${tickerOf(ctx, underlying)} ${s.key.expiry}`, error: describeError(error) }, 'could not read the snapshot sources after a snapshot that recorded nothing: not marked');
    return null;
  }
}

export async function stepSnapshot(ctx: CrankContext, keys: readonly ExpiryKey[]): Promise<StepReport> {
  const report = newReport('snapshot');
  const budget = new Budget(ctx.config.tuning.maxTxPerStep);
  const h = await head(ctx);
  const surveys = await survey(ctx, keys, h, false);
  const upcoming: Array<{ ticker: string; expiry: number; openInterest: bigint }> = [];
  for (const s of surveys) {
    const plan = planExpiry(s.view, thresholds(ctx));
    if (plan.wakeAt !== null) report.wakeAt.push(plan.wakeAt);
    if (h.timestamp < s.key.expiry && s.view.openInterest > 0n) upcoming.push({ ticker: tickerOf(ctx, s.key.underlying), expiry: s.key.expiry, openInterest: s.view.openInterest });
    if (!plan.snapshot || !budget.left) continue;
    const underlying = getAddress(s.key.underlying);
    const outcome = await sendPastStarvedSources(
      ctx,
      report,
      budget,
      `snapshot ${tickerOf(ctx, underlying)} ${s.key.expiry}`,
      { address: getAddress(s.key.oracle), abi: settlementOracleAbi, functionName: 'snapshot', args: [underlying, s.key.expiry], gas: GAS.snapshot },
      { kind: 'snapshot', key: expiryKeyString(s.key), worthSending: (recorded) => Number(recorded) > 0 },
      oracleSourceCalls(s.view, 'snapshot', h.timestamp, s.key.expiry),
    );
    // Recorded, or nothing to record at a time inside the window: either way finalize may follow.
    const windowEnd = s.key.expiry + SNAPSHOT_GRACE;
    if (ctx.sender.dryRun || h.timestamp > windowEnd) continue;
    let marked = false;
    if (outcome.status === 'no-op') {
      // A simulation that records nothing is "nothing left to record" only when no snapshot-backed source is
      // still dark. UniV3TwapSource.record also answers false when it cannot price the window YET, and a retry inside
      // the grace may succeed. Marking then stopped every retry and silenced v2_snapshot_missed in exactly the case it
      // exists for: the pool leg lost, the expiry settling on Chainlink alone.
      const waiting = await awaitingSnapshot(ctx, s, h);
      if (waiting !== null && waiting.length === 0) {
        ctx.store.setMeta(snapshotMetaKey(s.key), JSON.stringify({ at: h.timestamp, recorded: 0 }));
        marked = true;
      } else {
        ctx.log.warn({ expiry: `${tickerOf(ctx, underlying)} ${s.key.expiry}`, waiting, windowEnd }, 'a snapshot recorded nothing while a pool source still has no snapshot: not marked, retried inside the grace; v2_snapshot_missed pages if the grace closes first');
      }
    } else if (outcome.status === 'confirmed') {
      // The mark stops every later snapshot of this expiry, lets finalize go ahead of it and silences
      // v2_snapshot_missed (planner.planExpiry), and a confirmed outcome's `result` is the SIMULATION's count (tx.ts).
      // SettlementOracle.snapshot calls each source's `record` raw, so a source that fails on chain leaves a successful
      // receipt. The mark and its count are read from the sources at the mined block; left unset, the next tick asks
      // again, and a snapshot with nothing left to record then marks it through the no-op above.
      const recorded = await recordedAtBlock(ctx, s, { blockNumber: outcome.blockNumber, timestamp: h.timestamp });
      if (recorded !== null) {
        ctx.store.setMeta(snapshotMetaKey(s.key), JSON.stringify({ at: h.timestamp, recorded }));
        marked = true;
      }
    }
    // Unmarked (recorded nothing a pool needed, reverted, not broadcast, not confirmed): ask again inside the
    // grace at a precise wake-up rather than at the next poll.
    if (!marked && h.timestamp + SNAPSHOT_RETRY_S < windowEnd) report.wakeAt.push(h.timestamp + SNAPSHOT_RETRY_S);
  }
  report.notes = { surveyed: surveys.length, upcomingWithOpenInterest: upcoming };
  return report;
}

/*//////////////////////////////////////////////////////////////
                            FINALIZE
//////////////////////////////////////////////////////////////*/

export async function stepFinalize(ctx: CrankContext, keys: readonly ExpiryKey[]): Promise<StepReport> {
  const report = newReport('finalize');
  const budget = new Budget(ctx.config.tuning.maxTxPerStep);
  const h = await head(ctx);
  const expired = keys.filter((k) => k.expiry <= h.timestamp);
  const surveys = await survey(ctx, expired, h, false);
  const expiries: unknown[] = [];
  for (const s of surveys) {
    const plan = planExpiry(s.view, thresholds(ctx));
    for (const alert of plan.alerts) await ctx.alerts.raise(alert);
    if (plan.wakeAt !== null) report.wakeAt.push(plan.wakeAt);
    const ticker = tickerOf(ctx, s.key.underlying);
    expiries.push({ ticker, expiry: s.key.expiry, phase: plan.phase, status: s.view.status, openInterest: s.view.openInterest, candidate: s.view.candidate, pinned: s.view.pinned, sources: s.view.sources.map((x) => x.address), sourcesOk: s.view.sources.map((x) => x.windowOk) });
    if (!plan.finalize || !budget.left) continue;
    const underlying = getAddress(s.key.underlying);
    const oracle = getAddress(s.key.oracle);
    await sendPastStarvedSources(
      ctx,
      report,
      budget,
      `finalize ${ticker} ${s.key.expiry}`,
      { address: oracle, abi: settlementOracleAbi, functionName: 'finalize', args: [underlying, s.key.expiry], gas: GAS.finalize },
      {
        kind: 'finalize',
        key: expiryKeyString(s.key),
        isAdvanced: async () => (await ctx.client.readContract({ address: oracle, abi: settlementOracleAbi, functionName: 'settlementPrice', args: [underlying, s.key.expiry] }))[0] === 2,
      },
      oracleSourceCalls(s.view, 'finalize', h.timestamp, s.key.expiry),
    );
  }
  report.notes = { expiries };
  return report;
}

/*//////////////////////////////////////////////////////////////
                             SETTLE
//////////////////////////////////////////////////////////////*/

/** Whether chain state at `blockNumber` shows the series settled; false when that read fails. */
async function settledAtBlock(ctx: CrankContext, longId: bigint, blockNumber: bigint): Promise<boolean> {
  try {
    return (await ctx.client.readContract({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'series', args: [longId], blockNumber })).settled;
  } catch (error) {
    ctx.log.warn({ longId: longId.toString(), block: blockNumber.toString(), error: describeError(error) }, 'could not read the series a mined settle covered: its settled mark waits for the next survey');
    return false;
  }
}

/**
 * The expired, unsettled series some House vault still TRACKS,
 * whatever their supply: `HouseVault._requireFlat` (HouseVault.sol) refuses `rollEpoch`
 * NotSettled for ANY tracked series that is not settled, and planExpiry settles only series with long supply. A vault
 * tracks a series while it holds a long, a short OR a live order, and untracks it only on a re-measure (take, place,
 * replace, cancel, close, QUOTER sync), so a quote that never filled and expired leaves a zero-supply series tracked
 * that nothing else would ever settle, and the vault's boundary would never roll. `Clearinghouse.settle` is
 * permissionless and needs no supply (Clearinghouse.sol:759-811; the SETTLE bounty is simply not paid at zero), and it
 * finalizes the price itself when it can, so the simulation, not a mirror, decides whether the price is final.
 * One multicall of `trackedSeries()` over every House vault (houseVaultsOf), then one of `series(id)`. Empty, and no
 * read at all, when no House factory or registry vault is configured.
 */
async function houseTrackedUnsettled(ctx: CrankContext, h: Head, reads: HouseRollReads): Promise<{ series: Array<{ longId: bigint; vaults: Address[] }>; vaults: number }> {
  const { found } = await houseVaultsOf(reads, h);
  if (found.length === 0) return { series: [], vaults: 0 };
  const trackedReads = await readMany(ctx.client, found.map(({ vault }): AnyRead => ({ address: vault, abi: houseVaultAbi, functionName: 'trackedSeries' })), h.blockNumber);
  const byId = new Map<string, { longId: bigint; vaults: Address[] }>();
  found.forEach(({ vault }, i) => {
    for (const id of okResult<readonly bigint[]>(trackedReads[i]) ?? []) {
      const entry = byId.get(id.toString()) ?? { longId: id, vaults: [] };
      entry.vaults.push(vault);
      byId.set(id.toString(), entry);
    }
  });
  const all = [...byId.values()];
  if (all.length === 0) return { series: [], vaults: found.length };
  const seriesReads = await readMany(ctx.client, all.map((t): AnyRead => ({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'series', args: [t.longId] })), h.blockNumber);
  const series = all.filter((_, i) => {
    const s = okResult<{ underlying: Address; settled: boolean; expiry: number }>(seriesReads[i]);
    // Clearinghouse.settle's own gates: UnknownSeries, already settled (returns false), NotExpired.
    return s !== undefined && s.underlying.toLowerCase() !== ZERO_ADDRESS && !s.settled && h.timestamp >= Number(s.expiry);
  });
  return { series, vaults: found.length };
}

export async function stepSettle(ctx: CrankContext, keys: readonly ExpiryKey[], reads: HouseRollReads = chainHouseRollReads(ctx)): Promise<StepReport> {
  const report = newReport('settle');
  const budget = new Budget(ctx.config.tuning.maxTxPerStep, ctx.yieldWhen);
  const h = await head(ctx);
  const surveys = await survey(ctx, keys.filter((k) => k.expiry <= h.timestamp), h, false);
  let planned = 0;
  /** Every series this step sent (or simulated) a settle for, so the House pass below never asks twice. */
  const tried = new Set<string>();
  for (const s of surveys) {
    const plan = planExpiry(s.view, thresholds(ctx));
    const stuck: Array<{ longId: string; what: string; status: string; revert?: string | null }> = [];
    for (const series of s.series.values()) {
      if (series.settled && !ctx.sender.dryRun && ctx.store.getMeta(settledSeenMetaKey(series.longId)) === null) {
        ctx.store.setMeta(settledSeenMetaKey(series.longId), String(h.timestamp));
      }
    }
    for (const longId of plan.settle) {
      planned += 1;
      if (!budget.left) break;
      tried.add(longId.toString());
      const series = s.series.get(longId.toString())!;
      const what = `settle ${tickerOf(ctx, series.underlying)} ${series.isPut ? 'put' : 'call'} ${series.strike} ${series.expiry}`;
      const outcome = await send(
        ctx,
        report,
        budget,
        what,
        { address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'settle', args: [longId], gas: GAS.settle },
        {
          kind: 'settle',
          key: longId.toString(),
          isAdvanced: async () => (await ctx.client.readContract({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'series', args: [longId] })).settled,
          worthSending: (advancedNow) => advancedNow === true,
        },
      );
      // Clearinghouse.settle returns false, with a successful receipt, when the price is not final on chain, and a
      // confirmed outcome carries the SIMULATED `true`. The mark starts the redeem backlog clock, so it is taken from the
      // series at the mined block; a read that fails leaves it unset, and the next survey of a settled series sets it.
      if (outcome.status === 'confirmed' && !ctx.sender.dryRun && (await settledAtBlock(ctx, longId, outcome.blockNumber))) {
        ctx.store.setMeta(settledSeenMetaKey(longId), String(h.timestamp));
      }
      if (outcome.status === 'no-op' || outcome.status === 'simulation-reverted') {
        stuck.push({ longId: longId.toString(), what, status: outcome.status, ...(outcome.status === 'simulation-reverted' ? { revert: outcome.revert } : {}) });
      }
    }
    // One page per expiry, however many of its series do not settle: a cause is usually the expiry's, not a series'.
    if (stuck.length > 0) {
      const first = stuck[0]!;
      await ctx.alerts.raise({
        kind: 'v2_settle_stuck',
        dedupeKey: `settle:${expiryKeyString(s.key)}`,
        once: false,
        message: `${tickerOf(ctx, s.key.underlying)} expiry ${s.key.expiry} is final but settle ${first.status === 'no-op' ? 'does not advance' : `reverts (${first.revert ?? 'no reason'})`} for ${stuck.length} series (first: ${first.what})`,
        data: { underlying: s.key.underlying, expiry: s.key.expiry, series: stuck.length, longIds: stuck.slice(0, 20).map((x) => x.longId), statuses: [...new Set(stuck.map((x) => x.status))], reverts: [...new Set(stuck.map((x) => x.revert ?? null))] },
      });
    }
  }

  // The House-tracked series planExpiry does not settle (no supply, or an expiry already
  // marked done). The simulation decides whether the price is final: settle returns false, a no-op, until it is.
  const house = await houseTrackedUnsettled(ctx, h, reads);
  const houseSettle: unknown[] = [];
  for (const t of house.series) {
    if (tried.has(t.longId.toString())) continue;
    if (!budget.left) break;
    const outcome = await send(
      ctx,
      report,
      budget,
      `settle ${t.longId} (tracked by House vault ${t.vaults.join(', ')}: rollEpoch needs it settled, whatever its supply)`,
      { address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'settle', args: [t.longId], gas: GAS.settle },
      {
        kind: 'settle',
        key: t.longId.toString(),
        isAdvanced: async () => (await ctx.client.readContract({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'series', args: [t.longId] })).settled,
        worthSending: (advancedNow) => advancedNow === true,
      },
    );
    houseSettle.push({ longId: t.longId.toString(), vaults: t.vaults, status: outcome.status, ...(outcome.status === 'simulation-reverted' ? { revert: outcome.revert } : {}) });
  }
  report.notes = { planned, ...(house.series.length > 0 ? { houseTrackedUnsettled: house.series.length, houseSettle } : {}) };
  return report;
}

/*//////////////////////////////////////////////////////////////
                              PRUNE
//////////////////////////////////////////////////////////////*/

/**
 * A simulation that did less than all of its chunk (prune or redeem returned short) or ran out of gas as a whole (a
 * revert without data from an executed call, not a transport failure): worth splitting.
 */
const fellShort = (outcome: CrankOutcome): boolean => outcome.status === 'no-op' || (outcome.status === 'simulation-reverted' && outcome.revert === null && outcome.transportError !== true);

/**
 * `redeemed` from a redeemBatch simulation. The ABI in this tree returns one uint256.
 * Clearinghouse.redeemBatch returns `(redeemed, paidUsdg, paidInKind)`; viem then gives a
 * readonly tuple, and element 0 is the count the old reader compared. Anything else is not a count.
 */
export function redeemedCount(result: unknown): bigint | null {
  if (typeof result === 'bigint') return result;
  if (Array.isArray(result) && typeof result[0] === 'bigint') return result[0];
  return null;
}

/**
 * The ids of a mined prune chunk that the book shows dead at the receipt's block: what the prune did, not what its
 * simulation said it would. A read that fails marks none of them: an order wrongly left live is re-read next tick, and
 * one wrongly marked dead is never looked at again.
 */
async function deadAtBlock(ctx: CrankContext, ids: readonly bigint[], blockNumber: bigint, label: string): Promise<bigint[]> {
  try {
    const dead = (await readOrders(ctx.client, ctx.addresses.orderBook, ids, blockNumber)).filter(isDeadOrder).map((o) => o.id);
    const live = ids.filter((id) => !dead.includes(id));
    if (live.length > 0) ctx.log.warn({ label, orderIds: live.map(String), block: blockNumber.toString() }, 'a mined prune left orders live that its simulation counted: they stay live for the next tick');
    return dead;
  } catch (error) {
    ctx.log.warn({ label, orderIds: ids.map(String), block: blockNumber.toString(), error: describeError(error) }, 'could not read the orders a mined prune covered: none marked dead');
    return [];
  }
}

/**
 * OrderBook.prune in chunks of fixed per-order gas. A chunk the simulation says prunes nothing, or that runs out of gas
 * as a whole (a resale ask whose maker's ERC-1155 hook burns the gas prune forwards to it leaves the book 1/64, too
 * little for the rest of a chunk), is split in halves, down to one order under the gas cap (planner.splitChunk). One
 * order that the book still skips there is a maker rejecting its refund: marked (unprunableMetaKey) and left out of
 * every later plan, so it neither sinks the honest orders it shares a chunk with nor keeps its expiry open.
 */
async function pruneOrders(ctx: CrankContext, report: StepReport, budget: Budget, orders: readonly OrderView[], label: string, now: number): Promise<{ pruned: number; unprunable: bigint[] }> {
  const cap = ctx.config.tuning.txGasCap;
  const queue = chunkByGas(orders, { gasOf: () => GAS.pruneEach, baseGas: GAS.pruneBase, capGas: cap, maxItems: 100 });
  let pruned = 0;
  const unprunable: bigint[] = [];
  while (queue.length > 0 && budget.left) {
    const chunk = queue.shift()!;
    const ids = chunk.items.map((o) => o.id);
    const outcome = await send(
      ctx,
      report,
      budget,
      `prune ${ids.length} order(s) ${label}`,
      { address: ctx.addresses.orderBook, abi: orderBookAbi, functionName: 'prune', args: [ids], gas: chunk.gas },
      { kind: 'prune', key: `${ids[0]}`, worthSending: (n) => (n as bigint) > 0n },
    );
    if (outcome.status === 'confirmed') {
      // A confirmed outcome's `result` is the SIMULATION's count (tx.ts), and the receipt reads success whether
      // or not the mined prune skipped an order (a refund the maker rejects leaves it live, OrderBook.prune). What is
      // dead is read from the book at the mined block; an order the prune skipped stays live for the next tick.
      const dead = await deadAtBlock(ctx, ids, outcome.blockNumber, label);
      if (!ctx.sender.dryRun && dead.length > 0) ctx.index.markOrdersDead(dead);
      pruned += dead.length;
      continue;
    }
    if (outcome.status === 'would-send') {
      pruned += Number(outcome.result as bigint);
      continue;
    }
    if (!fellShort(outcome)) continue;
    if (ids.length > 1 || chunk.gas < cap) {
      queue.unshift(...splitChunk(chunk, cap));
    } else if (outcome.status === 'no-op') {
      // Alone, with the whole cap, and the book still skips it: its maker rejects the refund.
      unprunable.push(ids[0]!);
      if (!ctx.sender.dryRun) {
        ctx.store.setMeta(unprunableMetaKey(ids[0]!), String(now));
        // Dead to housekeeping as well: its expired-order list is bounded and must not fill with orders nobody can prune.
        ctx.index.markOrdersDead(ids);
      }
    }
  }
  if (unprunable.length > 0) ctx.log.warn({ orderIds: unprunable.map(String), label }, 'orders the book will not prune (their makers reject the refund): left out from now on');
  return { pruned, unprunable };
}

export async function stepPrune(ctx: CrankContext, keys: readonly ExpiryKey[]): Promise<StepReport> {
  const report = newReport('prune');
  const budget = new Budget(ctx.config.tuning.maxTxPerStep, ctx.yieldWhen);
  const h = await head(ctx);
  const surveys = await survey(ctx, keys.filter((k) => k.expiry <= h.timestamp), h, true);
  const perSeries: unknown[] = [];
  let pruned = 0;
  const unprunable: string[] = [];
  for (const s of surveys) {
    const dead: bigint[] = [];
    const prunable: OrderView[] = [];
    for (const [longId, orders] of s.orders) {
      dead.push(...orders.filter(isDeadOrder).map((o) => o.id));
      const p = prunableHere(ctx, orders, h.timestamp);
      if (p.length > 0) perSeries.push({ ticker: tickerOf(ctx, s.key.underlying), longId, prunable: p.length, resaleAsks: p.filter((o) => o.kind === 'AskResale').length });
      prunable.push(...p);
    }
    if (!ctx.sender.dryRun && dead.length > 0) ctx.index.markOrdersDead(dead);
    if (prunable.length === 0) continue;
    // Resale asks first across the whole expiry: they hold the longs the redeem step is about to push.
    const ordered = prunableOrders(prunable, h.timestamp);
    const result = await pruneOrders(ctx, report, budget, ordered, `of ${tickerOf(ctx, s.key.underlying)} expiry ${s.key.expiry}`, h.timestamp);
    pruned += result.pruned;
    unprunable.push(...result.unprunable.map(String));
  }
  report.notes = { series: perSeries, pruned, unprunable };
  return report;
}

/*//////////////////////////////////////////////////////////////
                             REDEEM
//////////////////////////////////////////////////////////////*/

/**
 * The holders of a mined redeemBatch chunk that still hold the token at the receipt's block: the ones the batch
 * skipped (redeemBatch runs each holder in its own try/catch, so the receipt reads success either way, and redeeming
 * burns the whole balance). A read that fails returns every holder: counted as not redeemed, the expiry stays open.
 */
async function stillHeldAtBlock(ctx: CrankContext, tokenId: bigint, holders: readonly HolderView[], blockNumber: bigint, label: string): Promise<string[]> {
  try {
    const after = await readHolders(ctx.client, ctx.addresses.clearinghouse, tokenId, holders.map((x) => getAddress(x.holder)), blockNumber);
    const left = after.filter((v) => v.balance > 0n).map((v) => v.holder);
    if (left.length > 0) ctx.log.warn({ label, tokenId: tokenId.toString(), holders: left, block: blockNumber.toString() }, 'a mined redeemBatch left holders its simulation counted: they stay in the backlog');
    return left;
  } catch (error) {
    ctx.log.warn({ label, tokenId: tokenId.toString(), holders: holders.length, block: blockNumber.toString(), error: describeError(error) }, 'could not read the holders a mined redeemBatch covered: none counted as redeemed');
    return holders.map((x) => x.holder);
  }
}

async function holderCandidates(ctx: CrankContext, tokenId: bigint, side: 'long' | 'short', longId: bigint, askIndexer: boolean): Promise<{ holders: Address[]; indexer: 'ok' | 'off' | string }> {
  const fromLogs = ctx.index.holdersOf(tokenId);
  let indexer: 'ok' | 'off' | string = 'off';
  const merged = new Map<string, Address>(fromLogs.map((a) => [a.toLowerCase(), getAddress(a)]));
  if (ctx.indexer !== null && askIndexer) {
    const result = await ctx.indexer.holders(longId, side);
    if (result.ok) {
      indexer = 'ok';
      for (const a of result.items) merged.set(a.toLowerCase(), a);
    } else {
      indexer = result.reason;
    }
  }
  return { holders: [...merged.values()], indexer };
}

export async function stepRedeem(ctx: CrankContext, keys: readonly ExpiryKey[]): Promise<StepReport> {
  const report = newReport('redeem');
  const budget = new Budget(ctx.config.tuning.maxTxPerStep, ctx.yieldWhen);
  const h = await head(ctx);
  const cap = ctx.config.tuning.txGasCap;
  const surveys = await survey(ctx, keys.filter((k) => k.expiry <= h.timestamp), h, true);
  const [adapterRead] = await readMany(ctx.client, [{ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'payoutAdapter' }], h.blockNumber);
  // The adapter sizes every redeemBatch's gas (redeemGasOf, redeemBaseGas: an ITM call long that converts
  // budgets 450k plus one 1.6M reserve). Unread, that is a guess, so nothing is redeemed this tick and no
  // expiry is marked done; the next tick reads it again.
  if (adapterRead?.ok !== true) {
    report.notes = { adapterSet: null, skipped: `payoutAdapter() read failed: no redeemBatch is sized on a guessed adapter this tick (${adapterRead === undefined ? 'no result' : adapterRead.error.message.split('\n')[0]})` };
    return report;
  }
  const adapterSet = (adapterRead.result as string).toLowerCase() !== '0x0000000000000000000000000000000000000000';
  let burnZero = false;
  if (ctx.config.tuning.zeroPayoutMaxGasPriceWei > 0n) burnZero = (await ctx.client.getGasPrice()) <= ctx.config.tuning.zeroPayoutMaxGasPriceWei;

  const tokens: Array<{ survey: ExpirySurvey; longId: bigint; isLong: boolean }> = [];
  const plans = new Map<ExpirySurvey, ReturnType<typeof planExpiry>>();
  for (const s of surveys) {
    const plan = planExpiry(s.view, thresholds(ctx));
    plans.set(s, plan);
    for (const longId of plan.redeem) tokens.push({ survey: s, longId, isLong: true });
  }
  // Longs first (buyers are paid before writers get their collateral back), then shorts.
  for (const s of surveys) for (const longId of plans.get(s)!.redeem) tokens.push({ survey: s, longId, isLong: false });

  const remainingByExpiry = new Map<ExpirySurvey, number>();
  const backlogByExpiry = new Map<ExpirySurvey, Array<{ token: string; tokenId: string; remaining: number; skipped: number; unaccounted: bigint; ageS: number }>>();
  const summaries: unknown[] = [];
  let indexerState: string = ctx.indexer === null ? 'off' : 'unused';
  for (const t of tokens) {
    const series = t.survey.series.get(t.longId.toString())!;
    const tokenId = t.isLong ? t.longId : shortIdOf(t.longId);
    const supply = t.isLong ? series.longSupply : series.shortSupply;
    if (supply === 0n) continue;
    const perUnitPayout = t.isLong ? series.longPayoutPerUnit : series.shortPayoutPerUnit;
    // One failed indexer call ends indexer use for this step: a down indexer must not cost a timeout per token.
    const askIndexer = ctx.indexer !== null && !indexerState.startsWith('down');
    const { holders: candidates, indexer } = await holderCandidates(ctx, tokenId, t.isLong ? 'long' : 'short', t.longId, askIndexer);
    if (askIndexer) indexerState = indexer === 'ok' ? 'ok' : `down (${indexer}); log index only`;
    // The cranker's own account is the redeemBatch caller: `_mayRedeem(holder, msg.sender)` is judged against it.
    const views = candidates.length === 0 ? [] : await readHolders(ctx.client, ctx.addresses.clearinghouse, tokenId, candidates, h.blockNumber, ctx.sender.account);
    const selection = selectRedeemable(views, { perUnitPayout, burnZero });
    const known = views.reduce((sum, v) => sum + v.balance, 0n);
    const unaccounted = supply > known ? supply - known : 0n;
    const redeemToken = { isLong: t.isLong, isPut: series.isPut, perUnitPayout, adapterSet };
    const gasOf = (holder: HolderView) => redeemGasOf(holder, redeemToken);
    const queue: GasChunk<HolderView>[] = chunkByGas(selection.redeem, { gasOf, baseGas: redeemBaseGas(selection.redeem, redeemToken), capGas: cap, maxItems: 200 });
    let redeemed = 0;
    let skipped = 0;
    const minedSkipped: string[] = [];
    const label = `${tickerOf(ctx, series.underlying)} ${series.isPut ? 'put' : 'call'} ${series.strike} ${series.expiry} ${t.isLong ? 'long' : 'short'}`;
    while (queue.length > 0 && budget.left) {
      const chunk = queue.shift()!;
      const n = chunk.items.length;
      const outcome = await send(
        ctx,
        report,
        budget,
        `redeemBatch ${n} holder(s) ${label}`,
        { address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'redeemBatch', args: [tokenId, chunk.items.map((x) => getAddress(x.holder))], gas: chunk.gas },
        // An older ABI returns one uint256. The current contract's same selector returns
        // (redeemed, paidUsdg, paidInKind). Comparing that tuple to BigInt(n) is always false, worthSending
        // skips the send, and fellShort treats the no-op as a short batch, so redeemBatch stops. Read `redeemed`
        // (element 0), which works with either ABI.
        { kind: 'redeemBatch', key: tokenId.toString(), worthSending: (count) => redeemedCount(count) === BigInt(n) },
      );
      if (outcome.status === 'confirmed') {
        // Worth sending only when the SIMULATION redeemed all n, and a confirmed outcome carries that simulated
        // count, not the mined one. Redeemed is what chain state shows at the mined block; a holder the batch skipped
        // stays in `remaining`, so the expiry stays open and the backlog accounting below sees it.
        const left = await stillHeldAtBlock(ctx, tokenId, chunk.items, outcome.blockNumber, label);
        redeemed += n - left.length;
        minedSkipped.push(...left);
      } else if (outcome.status === 'would-send') redeemed += n; // a dry run has no mined block: today's count
      else if (fellShort(outcome)) {
        // Fewer redeemed than asked under this limit (an inner out-of-gas swallowed by the batch's try/catch), or the
        // whole call out of gas (a holder that ran out mid-batch leaves the next one 1/64 of the gas): split.
        if (n > 1 || chunk.gas < cap) queue.unshift(...splitChunk(chunk, cap));
        else skipped += 1;
      }
    }
    const remaining = selection.redeem.length - redeemed - skipped;
    remainingByExpiry.set(t.survey, (remainingByExpiry.get(t.survey) ?? 0) + remaining + skipped + (unaccounted > 0n ? 1 : 0));
    summaries.push({ token: label, tokenId: tokenId.toString(), supply, candidates: candidates.length, redeemable: selection.redeem.length, redeemed, skipped, minedSkipped, optedOut: selection.optedOut, zeroPayout: selection.zeroPayout, unaccounted });

    const seenRaw = ctx.store.getMeta(settledSeenMetaKey(t.longId));
    const settledSeen = seenRaw === null ? h.timestamp : Number(seenRaw);
    if (seenRaw === null && !ctx.sender.dryRun) ctx.store.setMeta(settledSeenMetaKey(t.longId), String(h.timestamp));
    if ((remaining + skipped > 0 || unaccounted > 0n) && h.timestamp - settledSeen >= ctx.config.tuning.redeemBacklogS) {
      const list = backlogByExpiry.get(t.survey) ?? [];
      list.push({ token: label, tokenId: tokenId.toString(), remaining, skipped, unaccounted, ageS: h.timestamp - settledSeen });
      backlogByExpiry.set(t.survey, list);
    }
  }

  // One page per expiry, not per token id: a redemption wave over a weekly expiry is hundreds of tokens, and each page
  // is a POST inside this tick.
  for (const [s, list] of backlogByExpiry) {
    const holders = list.reduce((n, x) => n + x.remaining + x.skipped, 0);
    const unknownUnits = list.reduce((n, x) => n + x.unaccounted, 0n);
    const oldest = Math.max(...list.map((x) => x.ageS));
    await ctx.alerts.raise({
      kind: 'v2_redeem_backlog',
      dedupeKey: expiryKeyString(s.key),
      once: false,
      message: `${tickerOf(ctx, s.key.underlying)} expiry ${s.key.expiry}: ${holders} redeemable holder(s)${unknownUnits > 0n ? ` and ${unknownUnits} units held by unknown holders` : ''} remain on ${list.length} token(s), up to ${oldest} s after settlement (first: ${list[0]!.token})`,
      data: { underlying: s.key.underlying, expiry: s.key.expiry, holders, unaccounted: unknownUnits, tokens: list.slice(0, 20).map((x) => ({ tokenId: x.tokenId, remaining: x.remaining, skipped: x.skipped, unaccounted: x.unaccounted })) },
    });
  }

  // An expiry is done once it is final, every series with supply is settled, no order is left to
  // prune and no redeemable holder is left: later ticks stop surveying it.
  let doneNow = 0;
  if (!ctx.sender.dryRun) {
    for (const s of surveys) {
      const plan = plans.get(s)!;
      if (s.view.status !== 'Finalized' && !plan.done) continue;
      const settledAll = plan.settle.length === 0;
      const prunedAll = plan.prune.length === 0;
      const redeemedAll = (remainingByExpiry.get(s) ?? 0) === 0;
      if (plan.done || (settledAll && prunedAll && redeemedAll)) {
        ctx.index.markExpiryDone(s.key.oracle, s.key.underlying, s.key.expiry, h.timestamp);
        doneNow += 1;
      }
    }
  }
  report.notes = { tokens: summaries, indexer: indexerState, adapterSet, burnZeroPayouts: burnZero, expiriesDone: doneNow };
  return report;
}

/*//////////////////////////////////////////////////////////////
                             LADDERS
//////////////////////////////////////////////////////////////*/

interface MarketConfigStruct {
  enabled: boolean;
  mintPaused: boolean;
  strikeTick: bigint;
  exerciseFeeBps: number;
  oracle: Address;
}

function upcomingExpiries(ctx: CrankContext, now: number, weekly: boolean, count: number): Promise<number[]> {
  return upcomingLadderExpiries(now, weekly, count, async (after, w) =>
    Number(await ctx.client.readContract({ address: ctx.addresses.expiryCalendar, abi: expiryCalendarAbi, functionName: 'nextExpiry', args: [after, w] })),
  );
}

export async function stepLadders(ctx: CrankContext): Promise<StepReport> {
  const report = newReport('ladders');
  const budget = new Budget(ctx.config.tuning.maxTxPerStep, ctx.yieldWhen);
  const h = await head(ctx);
  const markets = v2Markets(ctx.config.registry, ['live']);
  const notes: Array<Record<string, unknown>> = [];
  if (markets.length === 0) {
    report.notes = { markets: [], reason: 'no live v2 market in the registry' };
    return report;
  }

  const [createPausedRead, ...marketReads] = await readMany(
    ctx.client,
    [
      { address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'createPaused' },
      ...markets.map((m): AnyRead => ({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'market', args: [m.underlying] })),
    ],
    h.blockNumber,
  );
  if (createPausedRead?.ok && createPausedRead.result === true) {
    report.notes = { skipped: 'series creation is paused (guardian)' };
    return report;
  }
  // An unread pause flag is not "not paused": nothing is probed or sent this tick; the next tick reads again.
  if (createPausedRead?.ok !== true) {
    report.notes = { skipped: 'createPaused() read failed: the guardian pause is unknown, nothing is created this tick' };
    return report;
  }
  const configs = markets.map((m, i) => (marketReads[i]?.ok ? (marketReads[i]!.result as MarketConfigStruct) : null));
  // A market whose market() read failed has no known oracle: no spot is read for it (below it is skipped as unread).
  const oracles = markets.map((_, i) => marketOracleOf(marketReads[i]));
  const priced = markets.map((_, i) => i).filter((i) => oracles[i] !== null);
  const pricedReads = priced.length === 0 ? [] : await readMany(ctx.client, priced.map((i): AnyRead => ({ address: oracles[i]!, abi: settlementOracleAbi, functionName: 'trySpot', args: [markets[i]!.underlying] })), h.blockNumber);
  const spotReads = new Map(priced.map((i, k) => [i, pricedReads[k]]));

  const maxAhead: Record<Tenor, number> = { weekly: 0, daily: 0 };
  for (const m of markets) for (const tenor of TENORS) maxAhead[tenor] = Math.max(maxAhead[tenor], m.v2.params.expiriesAhead[tenor]);
  const expiries: Record<Tenor, number[]> = {
    weekly: maxAhead.weekly > 0 ? await upcomingExpiries(ctx, h.timestamp, true, maxAhead.weekly) : [],
    daily: maxAhead.daily > 0 ? await upcomingExpiries(ctx, h.timestamp, false, maxAhead.daily) : [],
  };

  const creates = new Map<string, { underlying: Address; isPut: boolean; strike: bigint; expiry: number; ticker: string; oracle: Address }>();
  markets.forEach((m, i) => {
    const cfg = configs[i];
    const spotRead = spotReads.get(i);
    const note: Record<string, unknown> = { ticker: m.ticker };
    notes.push(note);
    if (cfg === null || cfg === undefined) return void (note.skipped = 'market() read failed: its oracle is unknown, nothing is priced or created this tick');
    if (cfg.strikeTick === 0n) return void (note.skipped = 'not registered on the Clearinghouse');
    if (!cfg.enabled) return void (note.skipped = 'market disabled');
    const [ok, spot] = spotRead?.ok ? (spotRead.result as readonly [boolean, bigint, bigint]) : [false, 0n, 0n];
    if (!ok || spot === 0n) return void (note.skipped = 'spot not fresh (trySpot not ok): ladders wait for a fresh price');
    note.spot = spot;
    const planned: unknown[] = [];
    for (const { tenor, expiry, isPut } of ladderSlots(m.v2.params, m.v2.puts, expiries)) {
      const anchorKey = ladderAnchorMetaKey(m.underlying, expiry, isPut, tenor);
      const anchorRaw = ctx.store.getMeta(anchorKey);
      const plan = planLadder({
        spot,
        ladder: m.v2.params.ladder[tenor],
        strikeTick: cfg.strikeTick,
        isPut,
        existing: ctx.index.seriesOf(m.underlying, expiry).filter((s) => s.isPut === isPut).map((s) => s.strike),
        anchor: anchorRaw === null ? null : BigInt(anchorRaw),
      });
      if (!ctx.sender.dryRun && (anchorRaw === null || BigInt(anchorRaw) !== plan.anchor)) ctx.store.setMeta(anchorKey, plan.anchor.toString());
      if (plan.create.length > 0) planned.push({ tenor, expiry, type: isPut ? 'put' : 'call', reason: plan.reason, strikes: plan.create });
      for (const strike of plan.create) {
        const id = longIdOf(m.underlying, isPut, strike, expiry);
        creates.set(id.toString(), { underlying: m.underlying, isPut, strike, expiry, ticker: m.ticker, oracle: cfg.oracle });
      }
    }
    note.planned = planned;
  });

  // What the index has not seen yet may already exist on chain: never pay for a no-op create.
  const wanted = [...creates.entries()];
  const exists = wanted.length === 0 ? [] : await readMany(ctx.client, wanted.map(([id]): AnyRead => ({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'seriesExists', args: [BigInt(id)] })), h.blockNumber);
  // Only a series the chain says does not exist is missing. An unread one is left out of this tick's creates
  // (a failed read is not "missing") and counted, so the next tick reads it again.
  const missing = wanted.filter((_, i) => exists[i]?.ok === true && exists[i]!.result !== true).map(([id, c]) => ({ id: BigInt(id), ...c }));
  const existsUnread = wanted.filter((_, i) => exists[i]?.ok !== true).length;

  const creation = await createSeriesBatches(ctx, report, budget, h, missing, notes);
  report.notes = { markets: notes, expiries, planned: creates.size, missing: missing.length, ...(existsUnread > 0 ? { existsUnread } : {}), created: creation.created, pins: creation.pins, ...(creation.failures.length > 0 ? { failures: creation.failures } : {}) };
  return report;
}

interface CreateItem {
  id: bigint;
  underlying: Address;
  isPut: boolean;
  strike: bigint;
  expiry: number;
  ticker: string;
  /** The market's oracle, which createSeries pins (planner.pinGroupKey with the underlying and expiry). */
  oracle: Address;
  group: string;
}

/** What v2_meta remembers of a refused pin (pinRefusedMetaKey). */
interface PinRefusedMark {
  at: number;
  /** The v2_pin_refused dedupe key: the oracle and the cause. */
  alertKey: string;
  error: string;
  source: string | null;
  reason: string | null;
  explanation: string;
}

function readPinMark(ctx: CrankContext, group: string): PinRefusedMark | null {
  const raw = ctx.store.getMeta(pinRefusedMetaKey(group));
  if (raw === null) return null;
  try {
    const mark = JSON.parse(raw) as PinRefusedMark;
    return typeof mark.at === 'number' ? mark : null;
  } catch {
    return null;
  }
}

/** One createSeries simulated alone with ample gas (GAS.createSeriesProbe): a refused pin, another revert, or fine. */
async function probeCreate(ctx: CrankContext, c: CreateItem): Promise<{ kind: 'ok' } | { kind: 'refused'; refusal: PinRefusal } | { kind: 'reverted'; revert: string } | { kind: 'unreadable'; error: string }> {
  try {
    await ctx.client.simulateContract({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'createSeries', args: [c.underlying, c.isPut, c.strike, c.expiry], account: ctx.sender.account, gas: GAS.createSeriesProbe });
    return { kind: 'ok' };
  } catch (error) {
    const detail = revertDetail(error);
    if (detail === null) return { kind: 'unreadable', error: describeError(error).slice(0, 200) };
    const refusal = pinRefusalOf(detail, 'createSeries', true);
    return refusal === null ? { kind: 'reverted', revert: detail.name } : { kind: 'refused', refusal };
  }
}

/**
 * Step 1's sends: the missing series in Multicall3 batches, each budgeted for the settlement pin the first
 * series of an expiry pays (planner.chunkCreates, INTERFACE_VERSION 6).
 *
 *   1. per (oracle, underlying, expiry): pinnedBy and settlementConfig, one multicall;
 *   2. planner.planPinGroup: pinned by this Clearinghouse → create; refused less than PIN_REFUSED_RECHECK_S ago →
 *      skip (nothing simulated or sent); anything else → probe one createSeries alone with ample gas. A refused pin
 *      (cranker/pin.ts) marks the group in v2_meta and skips it; a probe that passes clears an earlier mark;
 *   3. the batches; every createSeries a batch simulation reports failed is named (its decoded revert) in the notes,
 *      and a refused pin there marks its group as well, unless it may be a starved source (no revert data);
 *   4. one v2_pin_refused (error) per oracle and cause, listing the expiries it blocks.
 */
async function createSeriesBatches(ctx: CrankContext, report: StepReport, budget: Budget, h: Head, missing: readonly Omit<CreateItem, 'group'>[], notes: Array<Record<string, unknown>>): Promise<{ created: number; pins: unknown[]; failures: unknown[] }> {
  const out = { created: 0, pins: [] as unknown[], failures: [] as unknown[] };
  if (missing.length === 0) return out;
  const groups = new Map<string, CreateItem[]>();
  for (const c of missing) {
    const group = pinGroupKey(c.oracle, c.underlying, c.expiry);
    groups.set(group, [...(groups.get(group) ?? []), { ...c, group }]);
  }
  const list = [...groups.entries()];
  const pinReads = await readMany(
    ctx.client,
    list.flatMap(([, items]): AnyRead[] => [
      { address: items[0]!.oracle, abi: settlementOracleAbi, functionName: 'pinnedBy', args: [items[0]!.underlying, items[0]!.expiry] },
      { address: items[0]!.oracle, abi: settlementOracleAbi, functionName: 'settlementConfig', args: [items[0]!.underlying, items[0]!.expiry] },
    ]),
    h.blockNumber,
  );

  const refusals = new Map<string, { refusal: PinRefusal; oracle: Address; expiries: Array<{ ticker: string; expiry: number }> }>();
  const refusedGroups = new Set<string>();
  const refuse = (item: CreateItem, refusal: PinRefusal) => {
    if (refusedGroups.has(item.group)) return;
    refusedGroups.add(item.group);
    const alertKey = `${item.oracle.toLowerCase()}:${refusal.cause}`;
    const mark: PinRefusedMark = { at: h.timestamp, alertKey, error: refusal.error, source: refusal.source, reason: refusal.reason, explanation: refusal.explanation };
    if (!ctx.sender.dryRun) ctx.store.setMeta(pinRefusedMetaKey(item.group), JSON.stringify(mark));
    const entry = refusals.get(alertKey) ?? { refusal, oracle: item.oracle, expiries: [] };
    entry.expiries.push({ ticker: item.ticker, expiry: item.expiry });
    refusals.set(alertKey, entry);
  };

  const pinGas = new Map<string, bigint>();
  const include: CreateItem[] = [];
  for (const [i, [group, items]] of list.entries()) {
    const first = items[0]!;
    const pinnedBy = okResult<Address>(pinReads[i * 2]);
    const config = okResult<readonly [boolean, readonly Address[], number, number, number]>(pinReads[i * 2 + 1]);
    const mark = readPinMark(ctx, group);
    const view: PinGroupView = {
      key: group,
      pinnedByUs: pinnedBy === undefined ? null : pinnedBy.toLowerCase() === ctx.addresses.clearinghouse.toLowerCase(),
      sources: config === undefined ? null : config[1].length,
      refusedAt: mark?.at ?? null,
    };
    const plan = planPinGroup(view, { now: h.timestamp, recheckS: PIN_REFUSED_RECHECK_S });
    const note: Record<string, unknown> = { ticker: first.ticker, expiry: first.expiry, series: items.length, pinned: config?.[0] ?? null, pinnedByUs: view.pinnedByUs, sources: view.sources, action: plan.action };
    out.pins.push(note);
    if (plan.action === 'skip') {
      Object.assign(note, { refused: mark?.explanation, recheckAt: plan.recheckAt });
      continue;
    }
    if (plan.action === 'probe') {
      const probe = await probeCreate(ctx, first);
      note.probe = probe.kind === 'reverted' ? `reverted ${probe.revert}` : probe.kind === 'unreadable' ? `unreadable: ${probe.error}` : probe.kind;
      if (probe.kind === 'refused') {
        note.refused = probe.refusal.explanation;
        refuse(first, probe.refusal);
        continue;
      }
      if (probe.kind === 'ok' && mark !== null) {
        if (!ctx.sender.dryRun) ctx.store.deleteMeta(pinRefusedMetaKey(group));
        ctx.alerts.clear('v2_pin_refused', mark.alertKey);
      }
    }
    pinGas.set(group, 'pinGas' in plan ? plan.pinGas : 0n);
    include.push(...items);
  }

  const chunks = chunkCreates(include, { pinGasOf: (g) => pinGas.get(g) ?? 0n, eachGas: GAS.createSeriesEach, baseGas: GAS.createSeriesBase, capGas: ctx.config.tuning.txGasCap, maxItems: 40 });
  for (const planned of chunks) {
    if (!budget.left) break;
    // A group a previous batch found refused is not sent again; its budget stays in the limit, unused.
    const chunk = { items: planned.items.filter((c) => !refusedGroups.has(c.group)), gas: planned.gas };
    if (chunk.items.length === 0) continue;
    const calls = chunk.items.map((c) => ({
      target: ctx.addresses.clearinghouse,
      allowFailure: true,
      callData: encodeCreateSeries(c.underlying, c.isPut, c.strike, c.expiry),
    }));
    const ids = chunk.items.map((c) => c.id);
    const outcome = await send(
      ctx,
      report,
      budget,
      `createSeries ×${chunk.items.length} (${[...new Set(chunk.items.map((c) => c.ticker))].join(', ')})`,
      { address: ctx.addresses.multicall3, abi: multicall3Abi, functionName: 'aggregate3', args: [calls], gas: chunk.gas },
      {
        kind: 'createSeries',
        key: ids[0]!.toString(),
        isAdvanced: async () => {
          const now = await readMany(ctx.client, ids.map((id): AnyRead => ({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'seriesExists', args: [id] })), (await readHead(ctx.client)).blockNumber);
          return now.every((r) => r.ok && r.result === true);
        },
        worthSending: (results) => (results as ReadonlyArray<{ success: boolean }>).some((r) => r.success),
      },
    );
    const results = outcome.status === 'confirmed' || outcome.status === 'would-send' || outcome.status === 'no-op' ? (outcome.result as ReadonlyArray<{ success: boolean; returnData: Hex }>) : null;
    if (advanced(outcome)) out.created += results!.filter((r) => r.success).length;
    else if (outcome.status === 'no-op') notes.push({ refused: results!.length, what: 'every createSeries of the batch would revert' });
    results?.forEach((r, j) => {
      const item = chunk.items[j];
      if (r.success || item === undefined) return;
      const detail = decodeRevertData(clearinghouseAbi, r.returnData);
      const refusal = pinRefusalOf(detail, 'createSeries', false);
      out.failures.push({ ticker: item.ticker, expiry: item.expiry, strike: item.strike, type: item.isPut ? 'put' : 'call', revert: detail?.name ?? 'no revert data (out of gas?)', ...(refusal === null ? {} : { pin: refusal.explanation }) });
      if (refusal !== null && !refusal.maybeOutOfGas) refuse(item, refusal);
    });
  }

  for (const [alertKey, r] of refusals) {
    const shown = r.expiries.slice(0, 12).map((e) => `${e.ticker} ${e.expiry}`).join(', ');
    await ctx.alerts.raise({
      kind: 'v2_pin_refused',
      dedupeKey: alertKey,
      once: false,
      message: `createSeries refused by the settlement pin (${r.refusal.error}${r.refusal.reasonName === null ? '' : ` ${r.refusal.reasonName}`}): ${r.refusal.explanation}. Not created, asked again in ${PIN_REFUSED_RECHECK_S} s: ${shown}${r.expiries.length > 12 ? ` and ${r.expiries.length - 12} more` : ''}`,
      data: { oracle: r.oracle, error: r.refusal.error, source: r.refusal.source, reason: r.refusal.reason, reasonName: r.refusal.reasonName, expiries: r.expiries },
    });
  }
  return out;
}

function encodeCreateSeries(underlying: Address, isPut: boolean, strike: bigint, expiry: number) {
  return encodeFunctionData({ abi: clearinghouseAbi, functionName: 'createSeries', args: [underlying, isPut, strike, expiry] });
}

/*//////////////////////////////////////////////////////////////
                              ROLLS
//////////////////////////////////////////////////////////////*/

interface StrategyStruct {
  active: boolean;
  weekly: boolean;
  smartPricing: boolean;
}

export async function stepRolls(ctx: CrankContext): Promise<StepReport> {
  const report = newReport('rolls');
  const roller = ctx.addresses.autoRoller;
  if (roller === null) {
    report.notes = { skipped: 'no autoRoller configured (V2_AUTO_ROLLER / registry v2.contracts.autoRoller)' };
    return report;
  }
  const budget = new Budget(ctx.config.tuning.maxTxPerStep, ctx.yieldWhen);
  const h = await head(ctx);
  const { list, indexer } = await strategyPairs(ctx);
  if (list.length === 0) {
    report.notes = { strategies: 0, indexer };
    return report;
  }
  const underlyings = [...new Set(list.map((p) => p.underlying))];
  const PER = 3;
  const reads = await readMany(
    ctx.client,
    [
      { address: ctx.addresses.expiryCalendar, abi: expiryCalendarAbi, functionName: 'isRegularSession', args: [h.timestamp] },
      // INTERFACE_VERSION 7: the roller's open grace also asks whether the session was already open a grace ago.
      { address: ctx.addresses.expiryCalendar, abi: expiryCalendarAbi, functionName: 'isRegularSession', args: [h.timestamp - ROLL_OPEN_GRACE_S] },
      ...list.flatMap((p): AnyRead[] => [
        { address: roller, abi: autoRollerAbi, functionName: 'strategy', args: [p.writer, p.underlying] },
        { address: roller, abi: autoRollerAbi, functionName: 'position', args: [p.writer, p.underlying] },
        { address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'free', args: [p.writer, p.underlying] },
      ]),
      ...underlyings.map((u): AnyRead => ({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'market', args: [u] })),
      { address: roller, abi: autoRollerAbi, functionName: 'minRollUnits' },
      // The close a daily roll would create now (AutoRoller._plan), for the dailyWeekdays check.
      { address: ctx.addresses.expiryCalendar, abi: expiryCalendarAbi, functionName: 'nextExpiry', args: [h.timestamp + DAILY_MIN_LEAD_S, false] },
    ],
    h.blockNumber,
  );
  const BASE = 2;
  const sessionOpen = okResult<boolean>(reads[0]) === true;
  const sessionOpenAtGrace = okResult<boolean>(reads[1]) === true;
  // A market whose market() read failed has no known oracle: no spot is read for it, so its writers read as spot-stale
  // (no new roll) and are flagged marketUnread. A close-out does not use the spot and still goes ahead.
  const oracleOf = new Map(underlyings.map((u, i) => [u, marketOracleOf(reads[BASE + list.length * PER + i])]));
  // FAIL CLOSED: with the minimum unread, `?? 0n` let every roll count as
  // bounty-paying and bypassed ROLLS_BELOW_BOUNTY_PER_TICK. No roll or close-out is planned this tick; the next reads again.
  const minRollUnits = okResult<bigint>(reads[BASE + list.length * PER + underlyings.length]);
  const rollExpiryRead = okResult<number | bigint>(reads[BASE + list.length * PER + underlyings.length + 1]);
  const dailyRollExpiry = rollExpiryRead === undefined ? null : Number(rollExpiryRead);
  if (minRollUnits === undefined) {
    report.notes = { strategies: list.length, sessionOpen, sessionOpenAtGrace, indexer, minRollUnits: null, skipped: 'minRollUnits() read failed: no roll is planned this tick rather than planned against a minimum of 0' };
    return report;
  }
  const priced = underlyings.filter((u) => oracleOf.get(u) !== null);
  const spots = priced.length === 0 ? [] : await readMany(ctx.client, priced.map((u): AnyRead => ({ address: oracleOf.get(u)!, abi: settlementOracleAbi, functionName: 'trySpot', args: [u] })), h.blockNumber);
  const spotRead = new Map(priced.map((u, i) => [u, okResult<readonly [boolean, bigint, bigint]>(spots[i])]));
  const spotFresh = new Map(underlyings.map((u) => [u, spotRead.get(u)?.[0] === true]));
  const spotUpdatedAt = new Map(underlyings.map((u) => [u, spotRead.get(u)?.[0] === true ? Number(spotRead.get(u)![2]) : 0]));
  // Was the reading itself taken inside a regular session? The open grace accepts it then, whatever the clock says.
  const observedSessions = await readMany(
    ctx.client,
    underlyings.map((u): AnyRead => ({ address: ctx.addresses.expiryCalendar, abi: expiryCalendarAbi, functionName: 'isRegularSession', args: [spotUpdatedAt.get(u) ?? 0] })),
    h.blockNumber,
  );
  const sessionAtSpot = new Map(underlyings.map((u, i) => [u, okResult<boolean>(observedSessions[i]) === true]));

  // ORDER. AutoRoller pays the ROLL bounty only for a roll of at least minRollUnits. Close-outs and bounty-paying rolls go
  // first; rolls below it (a writer with dust collateral, or many sybil strategies at addresses that sort first) take
  // at most ROLLS_BELOW_BOUNTY_PER_TICK sends. Both run from a rotating start (rollsOffsetMetaKey), so no address
  // prefix holds the front of the list tick after tick.
  const start = list.length === 0 ? 0 : Number(ctx.store.getMeta(rollsOffsetMetaKey) ?? '0') % list.length;
  const rotated = [...list.keys()].map((k) => (start + k) % list.length);
  /** planRoll's decision, or the step's own `free-unread` refusal of a new roll whose size could not be read. */
  type Decided = { i: number; p: (typeof list)[number]; decision: RollDecision | { roll: false; reason: 'free-unread' }; earnsBounty: boolean };
  const decided = rotated.flatMap((i): Decided[] => {
    const p = list[i]!;
    const strategy = okResult<StrategyStruct & { maxUnits?: bigint }>(reads[BASE + i * PER]);
    const position = okResult<readonly [bigint, bigint, number]>(reads[BASE + 1 + i * PER]);
    if (strategy === undefined || position === undefined) return [];
    const decision = planRoll({
      active: strategy.active,
      positionLongId: position[0],
      positionExpiry: Number(position[2]),
      now: h.timestamp,
      sessionOpen,
      spotFresh: spotFresh.get(p.underlying) ?? false,
      sessionOpenAtGrace,
      spotUpdatedAt: spotUpdatedAt.get(p.underlying) ?? 0,
      sessionAtSpotObservation: sessionAtSpot.get(p.underlying) ?? false,
      weekly: strategy.weekly,
      dailyListed: dailyListedOf(ctx, p.underlying, dailyRollExpiry),
    });
    const free = okResult<bigint>(reads[BASE + 2 + i * PER]);
    const maxUnits = strategy.maxUnits ?? 0n;
    // A new roll whose free() read failed is not sent this tick: its size is unknown, and counting it as
    // bounty-paying put it ahead of the queue and outside ROLLS_BELOW_BOUNTY_PER_TICK on a read that did not happen
    // (the bypass closed for minRollUnits). A close-out does not use the size and still goes.
    if (free === undefined && decision.roll && decision.reason !== 'close-out') {
      return [{ i, p, decision: { roll: false, reason: 'free-unread' }, earnsBounty: true }];
    }
    // `free / UNIT` is an UPPER bound of the roller's rent-aware size (`free / (UNIT + feePerUnit)`), so
    // this only ever over-estimates: a roll that really earns the ROLL bounty is never demoted behind one that does not.
    const units = free === undefined ? null : maxUnits > 0n && free / UNIT > maxUnits ? maxUnits : free / UNIT;
    const earnsBounty = !decision.roll || decision.reason === 'close-out' || units === null || units >= minRollUnits;
    return [{ i, p, decision, earnsBounty }];
  });
  const ordered = [...decided.filter((d) => d.earnsBounty), ...decided.filter((d) => !d.earnsBounty)];

  const decisions: unknown[] = [];
  const reverting: unknown[] = [];
  let belowBounty = 0;
  let attempted = 0;
  for (const { p, decision, earnsBounty } of ordered) {
    decisions.push({ writer: p.writer, ticker: tickerOf(ctx, p.underlying), ...decision, ...(earnsBounty ? {} : { belowMinRollUnits: true }), ...(oracleOf.get(p.underlying) === null ? { marketUnread: true } : {}) });
    if (!decision.roll || !budget.left) continue;
    if (!earnsBounty) {
      if (belowBounty >= ROLLS_BELOW_BOUNTY_PER_TICK) continue;
      belowBounty += 1;
    }
    attempted += 1;
    const outcome = await send(
      ctx,
      report,
      budget,
      `roll ${p.writer} ${tickerOf(ctx, p.underlying)} (${decision.reason})`,
      { address: roller, abi: autoRollerAbi, functionName: 'roll', args: [p.writer, p.underlying], gas: GAS.roll },
      { kind: 'roll', key: `${p.writer.toLowerCase()}:${p.underlying.toLowerCase()}`, worthSending: (rolled) => rolled === true },
    );
    // A writer whose roll reverts (a revoked approval, a paused market) is skipped: nothing is sent, and the
    // next tick simulates it again (free) in case the writer fixed it.
    if (outcome.status === 'simulation-reverted') {
      // The roll's createSeries could not pin its expiry (cranker/pin.ts): no writer can fix that, the admin must.
      const refusal = pinRefusalOf({ name: outcome.revert, args: outcome.revertArgs }, 'roll', false);
      reverting.push({ writer: p.writer, ticker: tickerOf(ctx, p.underlying), revert: outcome.revert, ...(refusal === null ? {} : { pin: refusal.explanation }) });
      if (refusal !== null) {
        await ctx.alerts.raise({
          kind: 'v2_pin_refused',
          dedupeKey: `roll:${p.underlying.toLowerCase()}:${refusal.cause}`,
          once: false,
          message: `AutoRoller.roll for ${p.writer} on ${tickerOf(ctx, p.underlying)} is refused by the settlement pin of its new series (${refusal.error}${refusal.reasonName === null ? '' : ` ${refusal.reasonName}`}): ${refusal.explanation}. Not sent; simulated again next tick`,
          data: { writer: p.writer, underlying: p.underlying, error: refusal.error, source: refusal.source, reason: refusal.reason, reasonName: refusal.reasonName },
        });
      }
    }
  }
  if (!ctx.sender.dryRun && list.length > 0) ctx.store.setMeta(rollsOffsetMetaKey, String((start + Math.max(1, attempted)) % list.length));
  const marketUnread = underlyings.filter((u) => oracleOf.get(u) === null).map((u) => tickerOf(ctx, u));
  report.notes = { strategies: list.length, sessionOpen, sessionOpenAtGrace, indexer, minRollUnits, belowMinRollUnitsSent: belowBounty, decisions, reverting, ...(marketUnread.length > 0 ? { marketUnread } : {}) };
  return report;
}

/*//////////////////////////////////////////////////////////////
                          HOUSEKEEPING
//////////////////////////////////////////////////////////////*/

/*//////////////////////////////////////////////////////////////
                 HOUSE VAULT EPOCH ROLL
//////////////////////////////////////////////////////////////*/

/**
 * `HouseVault.rollEpoch()` is PERMISSIONLESS and nothing in the keeper sent it: the MM bot
 * computes `rollDue` (mm/house.ts) to stop opening risk, and stopped there. Without a sender, the first weekly
 * boundary after launch prices no deposit and no withdrawal until a human calls the function. This is the sender.
 *
 * WHERE IT RUNS. Its own step, `house` in STEP_ORDER, on its own budget (it first rode on housekeeping
 * because a new step needed a `case` in cranker/cranker.ts that was not yet wired). It sits right after `redeem`
 * because that is the order it needs: a vault is only flat once its series are settled and redeemed, so settle, prune
 * and redeem run first in the same tick. It runs before `ladders` so a boundary roll is not queued behind a ladder
 * backlog. Actions carry `kind: 'house-roll'` so /metrics and the journal can tell them apart.
 *
 * WHICH KEY. The cranker's (CRANKER_PK). `rollEpoch` is `unrestricted` in roles.v8.json, so any key may send it; the
 * QUOTER key is the MM bot's and spends the MM budget on quoting - a boundary call from it would compete with the
 * bot's own cancels at exactly the moment it must be flat. Cranking is the cranker's job.
 *
 * THE PRECONDITIONS ARE THE CONTRACT'S, MIRRORED FROM HouseVault.sol (callhouse-contracts v8, `rollEpoch` NatSpec):
 *   1. `block.timestamp >= epochEnd`  (TooEarly)               -> `rollDue(epochEnd, head.timestamp)`;
 *   2. every tracked series settled and the vault flat          -> `trackedSeries()` x `clearinghouse.series(id).settled`
 *      (`_requireFlat`: no longs, shorts or live orders)           and `exposure(id).detail` longs/shorts/live == 0;
 *   3. `oracle.settlementPrice(underlying, epochEnd)` Finalized  -> the vault's own `oracle()` and `underlying()`;
 *   4. a held settled ITM call long whose     -> `series(id)` isPut / longPayoutPerUnit / oracle /
 *      payout CONVERTS needs a fresh spot (`_redeemSettled` runs      underlying, `payoutPrefs(vault).inKind`,
 *      `_spot`, NoSource on 0)                                        `payoutAdapter()`, `oracle.spot(underlying)`.
 * SETTLED HOLDINGS DO NOT BLOCK. `rollEpoch` runs `_redeemSettled()` BEFORE `_requireFlat()`, so a settled
 * series the vault still holds is redeemed inside the roll; only an unsettled series or a live order stops it. Until
 * a later change, this mirror blocked on any held settled token, and launch House vaults refuse third-party redemption
 * (ArmHouseVaults: setThirdPartyRedeem(false)) and have no QUOTER redeem, so a vault that wrote the expiring series
 * could never be rolled by this step.
 * Nothing looser is invented here; a vault that fails 2, 3 or 4 is reported with the reason and NOT sent, because the
 * send would revert (`NotSettled`, `NoSource`). A send that reverts anyway (a race with a fill, an unpriced donation) is recorded
 * with its reason by `send` and is re-evaluated from chain state next tick - never retried blind.
 *
 * THE VAULTS. The union, deduplicated ignoring case, of two lists:
 *   - every vault of every factory in `CrankerTuning.houseFactories` (config.ts): `CRANKER_HOUSE_FACTORY`, else the MM
 *     bot's `MM_HOUSE_FACTORY`, else the registry's own House factories (config.ts
 *     houseFactoriesFromRegistry), all validated at boot like every other address (a bad value refuses to start);
 *   - every House vault the registry records (`registry.house.vaults`: each market's weekly and daily vault).
 * Neither list is enough alone. An env override wins over the registry's factories AND skips the boot check
 * (house-factory-missing), so a registry that gains a daily factory and its daily vaults is never enumerated while the
 * rendered env still pins the weekly factory; the factory list is not empty then, it is incomplete, and nothing pages.
 * A registry vault no factory listed is therefore still read, rolled under the same three preconditions and paged, and
 * /state names it (`houseRollUnlisted`, and `source: 'registry'` on its note) so the drift is visible. The factory half
 * stays because a factory can hold a vault the registry has not recorded yet. This file never reads the environment.
 *
 * AN UNROLLED BOUNDARY IS RETRIED AND PAGED. Every tick re-reads each vault, so a due vault that did not
 * roll is re-evaluated and re-sent on the next tick. Past HOUSE_ROLL_OVERDUE_S, a boundary that is still not rolled
 * pages `v2_house_roll_overdue` whatever the reason: blocked (not Finalized, not flat), deferred for budget, or a send
 * that did not land. Only a roll that landed (`confirmed`, `already-advanced`) or a vault that is not due clears it.
 *
 * A HELD BOUNDARY IS A WAIT, NOT A FAILURE. A House vault freezes its boundary's
 * settlement configuration on its oracle as the epoch opens (`pinnedBoundary`); when that pin failed and money was
 * exposed to the boundary, `rollEpoch` refuses `TooEarly(epochEnd + UNPINNED_BOUNDARY_HOLD)` (7 days) so holders see a
 * swapped source before it prices them. The step learns the hold from that refusal, the contract's own answer, and
 * keeps no copy of the constant: a simulation that reverts `TooEarly(t)` with `t` after `epochEnd` records
 * {houseRollHeldMetaKey} `{ epochId, epochEnd, until: t }`, and until `t` the vault's roll is neither simulated nor
 * sent again, `v2_house_roll_overdue` is not raised for it (and a page raised before the hold was known is cleared),
 * and the step asks to wake at `t`. The monitor pages the held boundary (`v2_mon_house_roll_held`). `TooEarly(t)` with
 * `t <= epochEnd` is the node's clock behind the head, not a hold, and is retried next tick as before. The mark is
 * dropped once the vault's epochId moves.
 *
 * EPOCH KINDS. A weekly and a daily vault roll the same way: `rollEpoch` at `epochEnd`, whatever its
 * cadence, with the same three preconditions. So the roll reads no kind and never calls `weekly()` -- which would
 * revert on the legacy vaults (mm/house.ts readEpochKind). What the step must do is enumerate EVERY
 * configured factory, legacy and kinded alike, whatever the MM bot's kind tag says: a daily vault's boundary comes
 * every session close, and a factory the roll does not enumerate is a vault that stops rolling.
 */

/**
 * rollEpoch gas, PER CALL from the tracked set the roll step already read. `_redeemSettled` walks every
 * tracked series and redeems what the vault still holds, `_requireFlat` re-reads each one, then fee transfer, burns and
 * mints, so the cost grows with `trackedSeries().length`. The flat 2.5M this replaced was never measured and ran out
 * of gas at ~60 tracked series.
 *
 * MEASURED (callhouse-contracts test/v2/unit/HouseVaultRollGas.t.sol, cold via vm.cool, gasleft
 * delta): rollEpoch with n stale tracked series (settled, redeemed, nothing held) n=1/10/50/100: 229,299 / 571,289 /
 * 2,093,979 / 4,035,625, a slope of ~38.4k per series; ~194,913 at any n once the MM bot's sync has untracked them.
 * Budgets, each about 30 % over the measurement: HOUSE_ROLL_GAS_BASE 300k (the n=1 roll) and HOUSE_ROLL_GAS_PER_TRACKED
 * 50k per tracked series. A series the vault still holds at the boundary also pays its redeems: a call long whose
 * payout converts through the PayoutRouter GAS.redeemConvertEach (450k), any other held long or short
 * GAS.redeemInKindEach (180k); a change measured the held ITM path at ~78k per series warm, both legs, so these are
 * generous. Capped HOUSE_ROLL_GAS_HEADROOM under the chain's per-transaction cap: a boundary past the cap reverts
 * loudly rather than doing half a boundary, and the monitor pages long before that (v2_mon_house_tracked_high,
 * HOUSE_ROLL_WORST_SERIES).
 *
 * PLUS THE NEXT BOUNDARY'S PIN. Since `rollEpoch` ends by pinning the boundary
 * it opens (HouseVault._pinBoundary -> SettlementOracle.pinBoundary: the factory's vaultOf lookups, the config copy, every
 * source's own pin, then the vault's pinnedBoundary store). The measurement predates it and never set a House
 * factory, so its 300k covers none of that. The pin is best effort for a REFUSAL, but a pin the sender STARVED is
 * re-thrown (StarvedCall.DEEP), so a roll sent without room for it reverts with no reason, every tick. The allowance is
 * the createSeries first-pin budget (GAS.createSeriesPinBase + GAS.createSeriesPinPerSource per source; devnet first pin
 * on two sources +181,719) plus HOUSE_ROLL_GAS_PIN_EXTRA for what only the House path does (two cold factory vaultOf
 * staticcalls, the vault's zero-to-non-zero pinnedBoundary store, the try/catch and EIP-150's 1/64). The source count is
 * the market's CURRENT one (the pin copies marketConfig), read right before the send; unread, MAX_ORACLE_SOURCES.
 * UNMEASURED on chain 4663 and in a contracts test with an authorized factory: a generous ceiling (only the gas used is
 * paid), not a measurement.
 *
 * PLUS ONE BOOK PULL'S CEILING. `rollEpoch` sends `orderBook.claimOwed{gas: BOOK_PULL_GAS}` (HouseVault.sol
 * rollEpoch) and swallows its failure only when the roll still held starvedCeiling(BOOK_PULL_GAS) at the pull
 * (revertIfStarvedBelow); below that a failed pull re-throws and the boundary reverts. The measurements above never paid for a pull that
 * burns its gas (the book owed nothing), so every roll carries HOUSE_ROLL_BOOK_PULL_GAS on top of the measured work and
 * the pin: a USDG or book that burns the whole cap is then contained, as the contract intends, instead of reverting the
 * boundary. Sent on every roll: the keeper does not read `owed`, and it is a limit, not a charge.
 */
export const HOUSE_ROLL_GAS_BASE = 300_000n;
export const HOUSE_ROLL_GAS_PER_TRACKED = 50_000n;
export const HOUSE_ROLL_GAS_HEADROOM = 2_000_000n;
export const HOUSE_ROLL_GAS_PIN_EXTRA = 60_000n;
/** The next boundary's pin inside `rollEpoch`, for a market with `sources` price sources (null = unread: the most). */
export const houseRollPinGas = (sources: number | null): bigint =>
  GAS.createSeriesPinBase + HOUSE_ROLL_GAS_PIN_EXTRA + GAS.createSeriesPinPerSource * BigInt(sources ?? MAX_ORACLE_SOURCES);
/** The least gas rollEpoch must hold at its book pull for the pull's failure to be the book's own: 517,936. */
export const HOUSE_ROLL_BOOK_PULL_GAS = starvedCeiling(BOOK_PULL_GAS);
/**
 * The gas one `rollEpoch()` is sent with, for the tracked series `readTracked` returned and the price-source count of the
 * market whose next boundary the roll pins (`readPinSources`; null = unread).
 */
export const houseRollGas = (tracked: readonly HouseTrackedView[], pinSources: number | null): bigint => {
  let gas = HOUSE_ROLL_GAS_BASE + houseRollPinGas(pinSources) + HOUSE_ROLL_BOOK_PULL_GAS;
  let converts = false;
  for (const t of tracked) {
    gas += HOUSE_ROLL_GAS_PER_TRACKED;
    const convertsHere = t.longs !== 0n && t.isPut === false && (t.longPayoutPerUnit ?? 0n) > 0n;
    if (t.longs !== 0n) gas += convertsHere ? GAS.redeemConvertEach : GAS.redeemInKindEach;
    if (t.shorts !== 0n) gas += GAS.redeemInKindEach;
    converts ||= convertsHere;
  }
  // `_redeemSettled` redeems through Clearinghouse.redeem with no try/catch (HouseVault.sol:1176), so a
  // conversion re-thrown below starvedCeiling(CONVERSION_GAS) reverts the whole boundary. One reserve per roll, as per
  // redeemBatch (GAS.redeemConvertReserve). The launch takes calls in kind (HouseVault.setPayoutInKind), so no conversion
  // runs there; this step does not read the vault's payout preference, so like redeemConvertEach above it budgets every
  // held ITM call long as converting (a limit, not a charge).
  if (converts) gas += GAS.redeemConvertReserve;
  const cap = CHAIN_MAX_TX_GAS - HOUSE_ROLL_GAS_HEADROOM;
  return gas < cap ? gas : cap;
};
/**
 * The most tracked series a roll fits under the cap when every one holds a converting call long and its short (the
 * worst case per series), with the one conversion reserve, the book pull's ceiling and the boundary pin at an
 * UNREAD source count (MAX_ORACLE_SOURCES, 8: the pin the roll is sent with when `readPinSources` fails):
 * (32M - 2M - 300k - (120k + 60k + 8 x 90k) - 517,936 - 1.6M) / (50k + 450k + 180k) = 39.2 -> 39. A two-source pin (the
 * launch markets, 360k) fits 40: (32M - 2M - 300k - 360k - 517,936 - 1.6M) / 680k = 40.03. The smaller is the one that
 * holds whatever the read returns (40 before the book pull, when the unread case sat exactly on the cap). The
 * monitor's HOUSE_TRACKED_PAGE (38, ops/v2/monitor.mjs) pages before it.
 */
export const HOUSE_ROLL_WORST_SERIES = 39;

/**
 * How long `rollDue` may stay true before `v2_house_roll_overdue` pages: the boundary expiry's uncorroborated delay (a
 * single-ok-source expiry cannot finalize sooner) plus HOUSE_ROLL_SETTLE_MARGIN_S for the settle/redeem steps to run
 * after finalization. Inside that window an unrolled boundary is the settlement chain doing its job, not an incident;
 * past it, either the oracle is Held (GUARDIAN vetoed) or nothing is sending, and a human should look. The
 * launch pair is dual-source and normally finalizes at expiry + 120 s.
 *
 * The delay is a SETTING (`SettlementOracle.setMarket`, CONFIG_ADMIN), so it is read per boundary from the
 * expiry's pinned `settlementConfig` (the market's current `marketConfig` when the expiry is not pinned): a raised delay
 * no longer pages early. When neither can be read the page falls back to this constant, the 6 h deploy default
 * (SettlementOracle's default uncorroborated delay) plus the margin, which is what it always used.
 */
export const HOUSE_ROLL_SETTLE_MARGIN_S = 3_600;
export const HOUSE_ROLL_OVERDUE_S = 6 * 3_600 + HOUSE_ROLL_SETTLE_MARGIN_S;

/** The overdue threshold of one boundary: its live uncorroborated delay plus the margin, else HOUSE_ROLL_OVERDUE_S. */
export function houseRollOverdueS(uncorroboratedDelayS: number | null | undefined): number {
  return uncorroboratedDelayS != null && Number.isSafeInteger(uncorroboratedDelayS) && uncorroboratedDelayS > 0
    ? uncorroboratedDelayS + HOUSE_ROLL_SETTLE_MARGIN_S
    : HOUSE_ROLL_OVERDUE_S;
}

/** `HouseVault.rollEpoch` per vault; the dedupe key of the overdue page is the vault. */
export const HOUSE_ROLL_KIND = 'house-roll';

export interface HouseVaultRollView {
  epochEnd: number;
  epochId: bigint;
  underlying: Address;
  oracle: Address;
  tracked: readonly bigint[];
  /** The boundary expiry's uncorroborated delay, seconds, read from the oracle; null/absent = unread. */
  uncorroboratedDelayS?: number | null;
}

export interface HouseTrackedView {
  longId: bigint;
  settled: boolean;
  longs: bigint;
  shorts: bigint;
  live: bigint;
  /**
   * `clearinghouse.series(longId)`: a call's settled long with `longPayoutPerUnit > 0` pays out on redeem, and
   * its `oracle` / `underlying` are what `_spot` asks. Absent when the series read failed (the series is then unsettled).
   */
  isPut?: boolean;
  longPayoutPerUnit?: bigint;
  oracle?: Address;
  underlying?: Address;
}

/** The chain reads the roll needs, injectable so the decision is tested without an RPC (the house.ts pattern). */
export interface HouseRollReads {
  /** Every configured House factory, in configuration order. Empty, with no registry vault either = no roll. */
  factories: readonly Address[];
  /**
   * Every House vault the registry records (weekly and daily, every market), in registry order. A function,
   * called only when the step runs, so reads built from a context that carries no config still work.
   */
  registryVaults: () => readonly Address[];
  discover: (factory: Address, blockNumber: bigint) => Promise<readonly Address[]>;
  readVault: (vault: Address, blockNumber: bigint) => Promise<HouseVaultRollView | null>;
  readTracked: (vault: Address, tracked: readonly bigint[], blockNumber: bigint) => Promise<readonly HouseTrackedView[]>;
  /**
   * `oracle.settlementPrice(underlying, epochEnd)` is Finalized AND its price is not 0: both halves of rollEpoch's own
   * check (HouseVault.sol `status != Finalized || price == 0` reverts NotSettled). Asked at the vault's own oracle,
   * underlying and epochEnd, never the head's timestamp.
   */
  readFinalized: (oracle: Address, underlying: Address, epochEnd: number, blockNumber: bigint) => Promise<boolean>;
  /**
   * Whether the Clearinghouse would CONVERT this vault's ITM call payouts to USDG: `payoutPrefs(vault).inKind`
   * false and a `payoutAdapter()` set (Clearinghouse._redeem's own gate before the swap is tried). A failed read answers
   * true, the side on which the roll waits rather than sending into a NoSource revert.
   */
  readConverts: (vault: Address, blockNumber: bigint) => Promise<boolean>;
  /** `oracle.spot(underlying)` answers a non-zero price: HouseVault._spot's own test. A revert is not fresh. */
  readSpotFresh: (oracle: Address, underlying: Address, blockNumber: bigint) => Promise<boolean>;
  /**
   * How many price sources the market has now (`oracle.marketConfig(underlying)` sources): what the roll's
   * boundary pin copies and pins one by one (houseRollPinGas). Null when the read fails.
   */
  readPinSources: (oracle: Address, underlying: Address, blockNumber: bigint) => Promise<number | null>;
}

/**
 * The uncorroborated delay a boundary's settlement is judged by: the expiry's pinned copy when it is pinned,
 * else the market's current configuration. Null when neither read answers; the caller then uses its fallback.
 */
export async function readUncorroboratedDelay(client: PublicClient, oracle: Address, underlying: Address, expiry: number, blockNumber: bigint): Promise<number | null> {
  try {
    const pinned = (await client.readContract({ address: oracle, abi: settlementOracleAbi, functionName: 'settlementConfig', args: [underlying, expiry], blockNumber })) as readonly [boolean, readonly Address[], number, number, number];
    if (pinned[0]) return Number(pinned[3]);
  } catch {
    // fall through to the market's current configuration
  }
  try {
    const current = (await client.readContract({ address: oracle, abi: settlementOracleAbi, functionName: 'marketConfig', args: [underlying], blockNumber })) as readonly [readonly Address[], number, number, number];
    return Number(current[2]);
  } catch {
    return null;
  }
}

export function chainHouseRollReads(ctx: CrankContext, factories: readonly Address[] = ctx.config.tuning.houseFactories.map((f) => f.address)): HouseRollReads {
  return {
    factories,
    registryVaults: () => ctx.config.registry.house.vaults.map((v) => v.address),
    discover: async (f, blockNumber) => (await ctx.client.readContract({ address: f, abi: houseVaultFactoryAbi, functionName: 'vaults', blockNumber })) as readonly Address[],
    readVault: async (vault, blockNumber) => {
      try {
        const [epochEnd, epochId, underlying, oracle, tracked] = await Promise.all([
          ctx.client.readContract({ address: vault, abi: houseVaultAbi, functionName: 'epochEnd', blockNumber }),
          ctx.client.readContract({ address: vault, abi: houseVaultAbi, functionName: 'epochId', blockNumber }),
          ctx.client.readContract({ address: vault, abi: houseVaultAbi, functionName: 'underlying', blockNumber }),
          ctx.client.readContract({ address: vault, abi: houseVaultAbi, functionName: 'oracle', blockNumber }),
          ctx.client.readContract({ address: vault, abi: houseVaultAbi, functionName: 'trackedSeries', blockNumber }),
        ]);
        const view: HouseVaultRollView = { epochEnd: Number(epochEnd), epochId: epochId as bigint, underlying: underlying as Address, oracle: oracle as Address, tracked: tracked as readonly bigint[] };
        view.uncorroboratedDelayS = await readUncorroboratedDelay(ctx.client, view.oracle, view.underlying, view.epochEnd, blockNumber);
        return view;
      } catch {
        return null;
      }
    },
    readTracked: async (vault, tracked, blockNumber) => {
      if (tracked.length === 0) return [];
      const reads: AnyRead[] = [];
      for (const id of tracked) {
        reads.push({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'series', args: [id] });
        reads.push({ address: vault, abi: houseVaultAbi, functionName: 'exposure', args: [id] });
      }
      const results = await readMany(ctx.client, reads, blockNumber);
      return tracked.map((longId, i) => {
        const series = results[2 * i];
        const exposure = results[2 * i + 1];
        // A failed read is NOT flat: the contract would still see the position, so the roll would revert.
        const s = series?.ok === true ? (series.result as { settled: boolean; isPut: boolean; longPayoutPerUnit: bigint; oracle: Address; underlying: Address }) : null;
        const settled = s !== null && s.settled === true;
        const detail = exposure?.ok === true ? ((exposure.result as readonly unknown[])[2] as { longs: bigint; shorts: bigint; live: bigint }) : null;
        const view: HouseTrackedView = { longId, settled, longs: detail?.longs ?? 1n, shorts: detail?.shorts ?? 1n, live: detail?.live ?? 1n };
        if (s !== null) Object.assign(view, { isPut: s.isPut, longPayoutPerUnit: s.longPayoutPerUnit, oracle: s.oracle, underlying: s.underlying });
        return view;
      });
    },
    readFinalized: async (oracle, underlying, epochEnd, blockNumber) => {
      const [status, price] = (await ctx.client.readContract({ address: oracle, abi: settlementOracleAbi, functionName: 'settlementPrice', args: [underlying, epochEnd], blockNumber })) as readonly [number, bigint];
      return (SETTLEMENT_STATUS[Number(status)] ?? 'None') === 'Finalized' && price !== 0n;
    },
    readConverts: async (vault, blockNumber) => {
      try {
        const [prefs, adapter] = await Promise.all([
          ctx.client.readContract({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'payoutPrefs', args: [vault], blockNumber }) as Promise<readonly [boolean, boolean]>,
          ctx.client.readContract({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'payoutAdapter', blockNumber }) as Promise<Address>,
        ]);
        return prefs[0] === false && adapter.toLowerCase() !== ZERO_ADDRESS;
      } catch {
        return true;
      }
    },
    readSpotFresh: async (oracle, underlying, blockNumber) => {
      try {
        const [price] = (await ctx.client.readContract({ address: oracle, abi: settlementOracleAbi, functionName: 'spot', args: [underlying], blockNumber })) as readonly [bigint, bigint];
        return price !== 0n;
      } catch {
        return false;
      }
    },
    readPinSources: async (oracle, underlying, blockNumber) => {
      try {
        const [sources] = (await ctx.client.readContract({ address: oracle, abi: settlementOracleAbi, functionName: 'marketConfig', args: [underlying], blockNumber })) as readonly [readonly Address[], number, number, number];
        return sources.length;
      } catch {
        return null;
      }
    },
  };
}

export interface HouseRollNote {
  vault: Address;
  /** The factory that enumerated the vault; null when no configured factory listed it (`source: 'registry'`). */
  factory: Address | null;
  /** `registry`: only the registry records this vault, so the configured factory list is missing it. */
  source: 'factory' | 'registry';
  epochId: string;
  epochEnd: number;
  /** `epochEnd` as ISO time: when the vault next rolls, for a human reading /state. null when the vault was unreadable. */
  epochEndIso: string | null;
  decision: 'not-due' | 'not-finalized' | 'not-flat' | 'no-fresh-spot' | 'unreadable' | 'sent' | 'no-budget' | 'held';
  detail?: string;
  overdueS?: number;
  /** `held`: the head timestamp from which rollEpoch may price the boundary (its TooEarly argument). */
  heldUntil?: number;
}

/** What v2_meta remembers of a held House boundary (houseRollHeldMetaKey). */
interface HouseRollHeldMark {
  epochId: string;
  epochEnd: number;
  until: number;
  /** Head timestamp the refusal was seen. */
  at: number;
}

/** The hold `vault`'s current boundary is under, or null (none, unparsable, or recorded for another epoch). */
function readHouseRollHold(ctx: CrankContext, vault: Address, view: HouseVaultRollView): HouseRollHeldMark | null {
  const raw = ctx.store.getMeta(houseRollHeldMetaKey(vault));
  if (raw === null) return null;
  try {
    const mark = JSON.parse(raw) as HouseRollHeldMark;
    if (mark.epochId === view.epochId.toString() && mark.epochEnd === view.epochEnd && Number.isSafeInteger(mark.until)) return mark;
  } catch {
    // unparsable: dropped below like a stale one
  }
  if (!ctx.sender.dryRun) ctx.store.deleteMeta(houseRollHeldMetaKey(vault));
  return null;
}

/**
 * The hold end a rollEpoch simulation revert states: `TooEarly(t)` with `t` after the boundary (HouseVault
 * `TooEarly(end + UNPINNED_BOUNDARY_HOLD)`). Null for anything else, including `TooEarly(epochEnd)`, which
 * is the plain "not yet" of a node whose clock is behind the head.
 */
export function houseRollHeldUntil(outcome: CrankOutcome, epochEnd: number): number | null {
  if (outcome.status !== 'simulation-reverted' || outcome.revert !== 'TooEarly') return null;
  const arg = outcome.revertArgs?.[0];
  const t = typeof arg === 'bigint' ? Number(arg) : typeof arg === 'number' ? arg : NaN;
  return Number.isSafeInteger(t) && t > epochEnd ? t : null;
}

/**
 * The House vaults the cranker looks after: every vault each configured factory lists, then every vault the registry
 * records that no factory listed (`unlisted`). One unenumerable factory does not stop the others: its failure
 * is in `errors` and the rest are still returned. Shared by {houseRoll} and {houseBoundaryKeys}, so the vaults whose
 * boundaries are finalized are exactly the vaults that are rolled.
 */
export async function houseVaultsOf(reads: HouseRollReads, h: Head): Promise<{
  found: Array<{ vault: Address; factory: Address | null }>;
  errors: Array<{ factory: Address; error: string }>;
  unlisted: Address[];
}> {
  const errors: Array<{ factory: Address; error: string }> = [];
  const found: Array<{ vault: Address; factory: Address | null }> = [];
  const seen = new Set<string>();
  for (const factory of reads.factories) {
    let vaults: readonly Address[];
    try {
      vaults = await reads.discover(factory, h.blockNumber);
    } catch (error) {
      errors.push({ factory, error: `vaults() failed: ${String(error).slice(0, 200)}` });
      continue;
    }
    for (const vault of vaults) {
      if (seen.has(vault.toLowerCase())) continue;
      seen.add(vault.toLowerCase());
      found.push({ vault, factory });
    }
  }
  // Then every vault the registry records that no factory listed: rolled and paged exactly like the others,
  // and named, because the factory list that missed it is configuration drift a human has to fix.
  const unlisted: Address[] = [];
  for (const vault of reads.registryVaults()) {
    if (seen.has(vault.toLowerCase())) continue;
    seen.add(vault.toLowerCase());
    found.push({ vault, factory: null });
    unlisted.push(vault);
  }
  return { found, errors, unlisted };
}

/**
 * The current epoch boundary of
 * every House vault {houseVaultsOf} returns, as an expiry key on the vault's OWN oracle (HouseVault.oracle, the one
 * rollEpoch reads). The cranker merges these into the tick's expiries and marks them `houseBoundary`. The snapshot and
 * finalize steps then record and finalize a boundary even when no series exists at it. Before this nothing finalized
 * such an expiry (only Clearinghouse.settle finalizes, and it needs a series), which left it to a manual finalize or
 * to adminResolve. A vault that cannot be read gives no key; {houseRoll} names it `unreadable`.
 */
export async function houseBoundaryKeys(ctx: CrankContext, h: Head, reads: HouseRollReads = chainHouseRollReads(ctx)): Promise<ExpiryKey[]> {
  if (reads.factories.length === 0 && reads.registryVaults().length === 0) return [];
  const { found } = await houseVaultsOf(reads, h);
  const keys: ExpiryKey[] = [];
  for (const { vault } of found) {
    const view = await reads.readVault(vault, h.blockNumber);
    if (view === null || view.epochEnd === 0) continue;
    keys.push({ oracle: view.oracle, underlying: view.underlying, expiry: view.epochEnd });
  }
  return keys;
}

/**
 * Rolls every House vault of the configured factories and of the registry whose boundary is due and whose
 * preconditions hold; pages `v2_house_roll_overdue` for a boundary that has been due longer than HOUSE_ROLL_OVERDUE_S
 * without rolling, and clears it when the vault is not due (it rolled, by this bot or by hand). Exported for the test;
 * `stepHouse` calls it.
 */
export async function houseRoll(ctx: CrankContext, report: StepReport, budget: Budget, h: Head, reads: HouseRollReads = chainHouseRollReads(ctx)): Promise<HouseRollNote[]> {
  const notes: HouseRollNote[] = [];
  // One unenumerable factory must not stop the others' boundaries: each failure is recorded and the rest still roll.
  const { found, errors, unlisted } = await houseVaultsOf(reads, h);
  if (errors.length > 0) report.notes.houseRollErrors = errors;
  if (unlisted.length > 0) report.notes.houseRollUnlisted = unlisted;
  for (const { vault, factory } of found) {
    const key = vault.toLowerCase();
    const source = factory === null ? 'registry' : 'factory';
    const view = await reads.readVault(vault, h.blockNumber);
    if (view === null) {
      notes.push({ vault, factory, source, epochId: '?', epochEnd: 0, epochEndIso: null, decision: 'unreadable' });
      continue;
    }
    const note: HouseRollNote = {
      vault, factory, source, epochId: view.epochId.toString(), epochEnd: view.epochEnd, epochEndIso: new Date(view.epochEnd * 1000).toISOString(), decision: 'not-due',
    };
    notes.push(note);
    if (!rollDue(view.epochEnd, h.timestamp)) {
      ctx.alerts.clear('v2_house_roll_overdue', key);
      continue;
    }
    const overdueS = h.timestamp - view.epochEnd;
    note.overdueS = overdueS;
    // A boundary the vault holds waits for the time its own refusal stated: nothing is simulated,
    // sent or paged before then, and the tick asks to wake at it.
    const holdAt = (until: number, seen: string) => {
      note.decision = 'held';
      note.heldUntil = until;
      note.detail = `rollEpoch refuses TooEarly(${until}) until ${new Date(until * 1000).toISOString()}: the vault could not freeze this boundary's settlement configuration before money was exposed to it (HouseVault pinnedBoundary != epochEnd, T-OP-866), so it rolls only after the hold. ${seen}. Not re-sent before then`;
      ctx.alerts.clear('v2_house_roll_overdue', key);
      report.wakeAt.push(until);
    };
    const hold = readHouseRollHold(ctx, vault, view);
    if (hold !== null && h.timestamp < hold.until) {
      holdAt(hold.until, `Recorded at ${new Date(hold.at * 1000).toISOString()}`);
      continue;
    }
    // Due and not rolled by the end of this tick: inside the settlement chain's own delay this is normal; past it, page.
    const pageIfOverdue = async () => {
      if (overdueS <= houseRollOverdueS(view.uncorroboratedDelayS)) return;
      await ctx.alerts.raise({
        kind: 'v2_house_roll_overdue',
        dedupeKey: key,
        once: false,
        message: `House vault ${vault} epoch ${view.epochId} ended ${Math.floor(overdueS / 60)} min ago and has not rolled: ${note.decision} (${note.detail ?? ''}). rollEpoch() is permissionless - see ops/alerts.md v2_house_roll_overdue`,
        data: { vault, epochId: view.epochId.toString(), epochEnd: view.epochEnd, overdueS, decision: note.decision, detail: note.detail ?? null },
      });
    };
    // Precondition 3 first: it is one read and it is the usual reason a due boundary waits.
    // The tracked views the roll's gas is sized from (houseRollGas); read only once the boundary is finalized.
    let tracked: readonly HouseTrackedView[] = [];
    const finalized = await reads.readFinalized(view.oracle, view.underlying, view.epochEnd, h.blockNumber);
    if (!finalized) {
      note.decision = 'not-finalized';
      note.detail = `oracle ${view.oracle} settlementPrice(${view.underlying}, ${view.epochEnd}) is not Finalized with a non-zero price`;
    } else {
      tracked = await reads.readTracked(vault, view.tracked, h.blockNumber);
      // Settled holdings are redeemed inside the roll (_redeemSettled before _requireFlat): only an unsettled series or
      // a live order stops it. A failed exposure read reports live 1, so it still blocks.
      const blocking = tracked.filter((t) => !t.settled || t.live !== 0n);
      if (blocking.length > 0) {
        note.decision = 'not-flat';
        note.detail = blocking.map((t) => `${t.longId}:${t.settled ? 'live order' : 'unsettled'}`).join(',');
      } else {
        // Precondition 4: _redeemSettled runs _spot for a call long whose redeem came back in USDG.
        const paying = tracked.filter((t) => t.isPut === false && t.longs !== 0n && (t.longPayoutPerUnit ?? 0n) > 0n);
        if (paying.length > 0 && (await reads.readConverts(vault, h.blockNumber))) {
          const stale: bigint[] = [];
          for (const t of paying) {
            if (t.oracle === undefined || t.underlying === undefined || !(await reads.readSpotFresh(t.oracle, t.underlying, h.blockNumber))) stale.push(t.longId);
          }
          if (stale.length > 0) {
            note.decision = 'no-fresh-spot';
            note.detail = `waiting for a fresh spot: series ${stale.join(',')} hold an ITM call long whose payout converts to USDG, and HouseVault._redeemSettled reverts NoSource without an ok spot (T-OP-664)`;
          }
        }
      }
    }
    if (note.decision !== 'not-due') {
      // Due and blocked.
      await pageIfOverdue();
      continue;
    }
    if (!budget.left) {
      // Due, unblocked, and deferred: it is retried next tick, but a boundary that keeps losing the budget is still late.
      note.decision = 'no-budget';
      await pageIfOverdue();
      continue;
    }
    const before = view.epochId;
    // The roll pins the next boundary on the vault's oracle; its gas covers that market's sources.
    const pinSources = await reads.readPinSources(view.oracle, view.underlying, h.blockNumber);
    const outcome = await send(
      ctx,
      report,
      budget,
      `rollEpoch ${vault} epoch ${before}`,
      { address: vault, abi: houseVaultAbi, functionName: 'rollEpoch', args: [], gas: houseRollGas(tracked, pinSources) },
      {
        kind: HOUSE_ROLL_KIND,
        key: `${key}:${before}`,
        // Already rolled (by hand, or by an earlier tick whose receipt was lost): epochId moved past the one we read.
        isAdvanced: async () => ((await ctx.client.readContract({ address: vault, abi: houseVaultAbi, functionName: 'epochId' })) as bigint) > before,
      },
    );
    const heldUntil = houseRollHeldUntil(outcome, view.epochEnd);
    if (heldUntil !== null) {
      // The vault holds this boundary. Remembered for this epoch so the next ticks do not simulate it again.
      if (!ctx.sender.dryRun) {
        const mark: HouseRollHeldMark = { epochId: before.toString(), epochEnd: view.epochEnd, until: heldUntil, at: h.timestamp };
        ctx.store.setMeta(houseRollHeldMetaKey(vault), JSON.stringify(mark));
      }
      holdAt(heldUntil, 'Seen in this tick\'s simulation');
      continue;
    }
    note.decision = 'sent';
    note.detail = outcome.status;
    if (outcome.status === 'simulation-reverted') note.detail = `simulation-reverted: ${outcome.revert ?? outcome.error.slice(0, 120)}`;
    if (outcome.status === 'confirmed' || outcome.status === 'already-advanced') {
      ctx.alerts.clear('v2_house_roll_overdue', key);
      if (hold !== null && !ctx.sender.dryRun) ctx.store.deleteMeta(houseRollHeldMetaKey(vault));
    }
    // A send that did not land leaves the boundary unrolled: re-sent next tick from chain state, and paged once late.
    // `would-send` is a dry run, which neither rolls nor pages.
    else if (outcome.status !== 'would-send') await pageIfOverdue();
  }
  return notes;
}

/**
 * EarnVault `processQueue` gas. Fixed gas like every cranker send
 * (constants.ts: a call that runs out of gas inside the loop serves nobody), but a fixed amount PER ENTRY, because
 * the cost grows with the batch and EARN_QUEUE_BATCH is configurable (1..200, v2/config.ts).
 *
 * MEASURED, not estimated. Fork of chain 4663 over https://rpc.mainnet.chain.robinhood.com at blocks 71,051,392 and
 * 71,056,735 (the contracts of that time, `forge test --isolate`, `vm.lastCallGas`): an EarnVault wired to the
 * launch venue (Steakhouse USDG 0xBeEf…09dd through Erc4626VenueAdapter), its wallet swept to the venue, and a queue
 * of redemptions that EACH pull from the venue (every entry prices `totalAssets()` and runs the adapter withdraw):
 *   - no tracked book orders: 1 entry 364,693; 5: 712,470; 10: 1,195,999; 20: 2,165,962 (about 95k per entry).
 *   - the worst case, 128 tracked orders (MAX_ORDER_SERIES 8 x MAX_LIVE_ORDERS_PER_SERIES 16, unfilled AskWrite:
 *     they open no position, so the queue is still served, and every `totalAssets()` walks all of them through
 *     `orderBook.getOrders`): 1 entry 2,402,708; 20: 17,625,757 -- about 1.60M fixed plus 0.80M per entry.
 * The flat 4M this replaced served about 3 entries in that state, so a default batch of 20 ran out of gas on every
 * send and the queue waited for a manual call (found in a v9 review). The constants below are the worst case plus
 * about 25 %: 2.0M fixed and 1.0M per entry. Only the gas USED is paid; the limit is a ceiling.
 *
 * Those figures are the call's own cost. `_tryPull` swallows a venue that burns its stipend
 * only when gasleft at the pull is still `starvedCeiling(VENUE_PULL_GAS)` (5,089,365 at VENUE_PULL_GAS 5,000,000).
 * The send is that ceiling PLUS the measured budget, so the ceiling is still in the frame when the pull starts and
 * each entry's million replaces what that entry spends before the next pull. A batch of 1, 2, or 3 on the old
 * formula (3M, 4M, 5M) was under the ceiling. A change recorded the formula as not SHORT; it was.
 */
export const EARN_PROCESS_QUEUE_GAS_BASE = 2_000_000n;
export const EARN_PROCESS_QUEUE_GAS_PER_ENTRY = 1_000_000n;
/**
 * Chain 4663's per-transaction gas cap: ArbGasInfo (0x…6C) `getGasAccountingParams().maxTxGasLimit` = 32,000,000,
 * read at block 71,057,838. A send above it is not included at all.
 */
export const CHAIN_MAX_TX_GAS = 32_000_000n;
export const EARN_PROCESS_QUEUE_KIND = 'earnProcessQueue';
export const EARN_SKIM_KIND = 'earnSkim';
/**
 * The gas `skim` is sent with. Measured on a fresh v9 deploy on our own anvil fork of 4663 (the v9 contracts
 * plus a scratch V2_EARN_SKIM_BPS keep change, fork block 71,488,450), skimBps 1000 (the
 * registry's launch value), the Steakhouse USDG venue wired. The limit is `eth_estimateGas` (the smallest that
 * succeeds); gasUsed is below it:
 *   - flat, no gain (100,000 USDG in the venue): 228,606.
 *   - a gain with a small supply (10 USDG in the venue, one day of venue interest; the fee is pulled from the venue):
 *     610,364 (gasUsed 550,664).
 *   - the worst case: 128 tracked orders (MAX_ORDER_SERIES 8 x MAX_LIVE_ORDERS_PER_SERIES 16), which every
 *     `totalAssets()` walks through `orderBook.getOrders` and `skim` prices twice, the rest of 1,000,000 USDG in the
 *     venue, 0.5 USDG on the ledger, and a one-day gain whose fee is larger than the ledger balance, so `_raise` does
 *     BOTH the Clearinghouse withdraw and the venue pull: 128 Bids 2,817,194 (gasUsed 2,747,894); 64 Bids + 64
 *     AskWrites 2,747,946; 128 AskWrites 2,678,698. Positions add nothing (`skim` never walks them): 120 Bids plus 8
 *     AskWrites each partly filled, so 8 open shorts, fee charged: 2,791,438.
 * The 1,000,000 this replaced ran out of gas and reverted in all three worst cases. 3.5M is the worst case plus about
 * 24 %: the call's own cost, not the send. 4663 charges no L1 component for the call (NodeInterface
 * `gasEstimateL1Component` = 0 at block 71,496,610). Only the gas USED is paid; the limit is a ceiling.
 *
 * An audit ("no limit is SHORT except houseRollGas") called this 3.5M
 * not SHORT. It is. The worst measurement pulls the fee from the venue (`_raise` -> `_tryPull`). That pull re-throws
 * unless gasleft is still starvedCeiling(VENUE_PULL_GAS), 5,089,365, which 3.5M can never be. The send is the ceiling
 * plus the 3.5M. CRANKER_GAS_SCALE_PCT is not the fix: the default of 100 must already clear it.
 */
/** The measured skim budget: worst case plus ~24 %. Added to the pull ceiling; it is not the send by itself. */
export const EARN_SKIM_MEASURED_BUDGET = 3_500_000n;
export const EARN_SKIM_GAS = starvedCeiling(VENUE_PULL_GAS) + EARN_SKIM_MEASURED_BUDGET;
/**
 * The skim a `processQueue` that DRAINS the queue runs at its end. In the
 * current contracts, the call that drains the queue settles the fee its deposits were
 * minted net of (`if (head > tail && _mintedNetOfFee) _skim();`, EarnVault.processQueue), and `_mintedNetOfFee` persists
 * across calls, so any draining call may skim: one that served a deposit, a redemption, or only dropped cancelled
 * entries. It is the same `_skim` a `skim()` send runs, fee raised from the ledger and then the venue, so its budget
 * is skim's own measured budget, referenced here and never copied.
 * The pull ceiling is reserved once, not twice. It is a floor on gasleft at the moment a pull starts, not gas a pull
 * that succeeds uses up. A pull that FAILS in the entry loop leaves the head entry unpaid (`_raise` returns less than
 * `owed`, so the entry is paid in part or not at all and the loop breaks), and the queue does not drain in that call.
 * So the skim's pull is the only failing pull a draining call can reach.
 * Every send carries it, not only one that looks like it drains: the head can move between the read and the send,
 * and the flag can be set by an earlier call.
 */
export const EARN_PROCESS_QUEUE_DRAIN_SKIM_GAS = EARN_SKIM_MEASURED_BUDGET;
/**
 * The most entries one send may ask for so its gas stays 2M under the cap, after the venue-pull ceiling and the drain
 * skim are reserved. (32M - 2M - starvedCeiling(VENUE_PULL_GAS) - 2M - 3.5M) / 1M = 19. The default batch
 * of 20 no longer fits one send (it was 22 before the drain skim). The drain loop sends it as capped calls, 19 then
 * the rest, re-reading the head after each (earn/queue.ts).
 */
export const EARN_PROCESS_QUEUE_MAX_ENTRIES = Number(
  (CHAIN_MAX_TX_GAS - 2_000_000n - starvedCeiling(VENUE_PULL_GAS) - EARN_PROCESS_QUEUE_GAS_BASE - EARN_PROCESS_QUEUE_DRAIN_SKIM_GAS) /
    EARN_PROCESS_QUEUE_GAS_PER_ENTRY,
);
/** The gas one `processQueue(entries)` is sent with: the pull ceiling, the measured per-batch budget, then the drain skim. */
export const earnProcessQueueGas = (entries: number): bigint =>
  starvedCeiling(VENUE_PULL_GAS) + EARN_PROCESS_QUEUE_GAS_BASE + EARN_PROCESS_QUEUE_GAS_PER_ENTRY * BigInt(entries) +
  EARN_PROCESS_QUEUE_DRAIN_SKIM_GAS;
/** When `skim` was last sent to an EarnVault (head seconds). */
export const earnSkimMetaKey = (vault: string) => `cranker:earn-skim:${vault.toLowerCase()}`;
/**
 * How soon to send `skim` again after a fee that was not taken. The full interval would
 * leave the fee owed until the next day. An hour is long enough that a frozen splitter is not
 * retried every tick.
 */
export const EARN_SKIM_REFUSED_RETRY_S = 3_600;
/** Whole-share price, the unit `highWaterMark()` reports in. Zero supply has no price. */
export function earnSharePrice(totalAssets: bigint, totalSupply: bigint): bigint {
  if (totalSupply === 0n) return 0n;
  return (totalAssets * 10n ** 18n) / totalSupply;
}

/**
 * What a confirmed `skim()` that returned `fee` meant, from the mark before and after.
 *   fee > 0                         collected
 *   price was already at or under the mark   nothing owed (flat or a loss)
 *   mark moved                      zero rate, or a fee that rounded to zero: nothing still owed
 *   mark unchanged and price above it        refused: the fee is still owed
 */
export function earnSkimFollowUp(input: {
  fee: bigint;
  priceBefore: bigint;
  markBefore: bigint;
  markAfter: bigint;
}): 'collected' | 'nothing' | 'mark-moved' | 'refused' {
  if (input.fee > 0n) return 'collected';
  if (input.priceBefore <= input.markBefore) return 'nothing';
  if (input.markAfter !== input.markBefore) return 'mark-moved';
  return 'refused';
}

/**
 * Pay the EarnVault's queued withdrawals as soon as its series have settled (earn/queue.ts has the loop and its stop
 * rules). It runs in the `house` step because that step runs after settle, prune and redeem in the same tick: the
 * moment a series the vault wrote or held settles, the queue behind it is paid. Permissionless, so the cranker key,
 * which holds no QUOTER, can send it; pulling venue cash for the queue is the QUOTER half and is not done here.
 */
/** highWaterMark and the whole-share price. Null when a read fails: the skim still sends, and a zero fee is then neither a refusal nor "nothing owed" but unverified. */
async function readEarnMark(ctx: CrankContext, vault: Address): Promise<{ mark: bigint; price: bigint } | null> {
  try {
    const [mark, assets, supply] = await Promise.all([
      ctx.client.readContract({ address: vault, abi: earnVaultAbi, functionName: 'highWaterMark' }) as Promise<bigint>,
      ctx.client.readContract({ address: vault, abi: earnVaultAbi, functionName: 'totalAssets' }) as Promise<bigint>,
      ctx.client.readContract({ address: vault, abi: earnVaultAbi, functionName: 'totalSupply' }) as Promise<bigint>,
    ]);
    if (typeof mark !== 'bigint' || typeof assets !== 'bigint' || typeof supply !== 'bigint') return null;
    return { mark, price: earnSharePrice(assets, supply) };
  } catch {
    return null;
  }
}

export async function earnQueue(ctx: CrankContext, report: StepReport, budget: Budget, earn: NonNullable<CrankerConfig['tuning']['earn']>) {
  const vault = earn.vault;
  const io: DrainIo = {
    read: async () => {
      const [queue, hasOpenPosition, venueUnreadable] = await Promise.all([
        ctx.client.readContract({ address: vault, abi: earnVaultAbi, functionName: 'queue' }) as Promise<readonly [bigint, bigint]>,
        ctx.client.readContract({ address: vault, abi: earnVaultAbi, functionName: 'hasOpenPosition' }) as Promise<boolean>,
        // processQueue serves nothing and skim takes nothing while this is true.
        readVenueUnpriced(ctx.client, vault),
      ]);
      return { head: queue[0], tail: queue[1], hasOpenPosition, venueUnreadable };
    },
    processQueue: async (maxEntries, headBefore) => {
      if (!budget.left) return false;
      // A configured batch above the cap is sent as several capped calls: the drain loop re-reads the head after
      // each one (earn/queue.ts), so a smaller send only moves the rest of the batch to the next call.
      const entries = Math.min(maxEntries, EARN_PROCESS_QUEUE_MAX_ENTRIES);
      const outcome = await send(
        ctx,
        report,
        budget,
        `processQueue ${vault} from entry ${headBefore}`,
        { address: vault, abi: earnVaultAbi, functionName: 'processQueue', args: [BigInt(entries)], gas: earnProcessQueueGas(entries) },
        {
          kind: EARN_PROCESS_QUEUE_KIND,
          key: `${vault.toLowerCase()}:${headBefore}`,
          // Someone else served it first: the head is already past the one we read.
          isAdvanced: async () => ((await ctx.client.readContract({ address: vault, abi: earnVaultAbi, functionName: 'queue' })) as readonly [bigint, bigint])[0] > headBefore,
        },
      );
      return outcome.status === 'confirmed' || outcome.status === 'already-advanced';
    },
  };
  const r = await drainQueue(io, earn.queueBatch, earn.queueCallsPerTick);

  // Skim once per interval, and only with no queue open: a change makes it take nothing then, so sending it would
  // only spend gas. The launch skimBps is 1000 (ops/markets/tier1.json v2.earn.skimBps), so a gain pays a fee.
  // A confirmed skim whose fee is 0 while the price is still above an unchanged mark did not take that fee
  // Remember it an hour short of the interval so the next tick does not wait a full day, and page it.
  let skim: string = 'not-due';
  const last = ctx.store.getMeta(earnSkimMetaKey(vault));
  const now = Math.floor(Date.now() / 1000);
  if (queueIsOpen(r.last)) skim = 'queue-open';
  // A skim against an unreadable venue takes nothing (Skimmed(0, 0)); sent, it would spend gas and
  // record the interval as skimmed, so the first skim once the venue reads again would wait a whole interval.
  else if (r.last.venueUnreadable) skim = 'venue-unreadable';
  else if (last === null || now - Number(last) >= earn.skimIntervalS) {
    if (!budget.left) skim = 'no-budget';
    else {
      const before = await readEarnMark(ctx, vault);
      const outcome = await send(
        ctx,
        report,
        budget,
        `skim ${vault}`,
        { address: vault, abi: earnVaultAbi, functionName: 'skim', args: [], gas: EARN_SKIM_GAS },
        { kind: EARN_SKIM_KIND, key: `${vault.toLowerCase()}:${Math.floor(now / earn.skimIntervalS)}` },
      );
      skim = outcome.status;
      if ((outcome.status === 'confirmed' || outcome.status === 'no-op') && !ctx.sender.dryRun) {
        const fee = 'result' in outcome && typeof outcome.result === 'bigint' ? outcome.result : null;
        let follow: ReturnType<typeof earnSkimFollowUp> | 'unknown' = fee !== null && fee > 0n ? 'collected' : 'unknown';
        if (fee === 0n && before !== null) {
          const after = await readEarnMark(ctx, vault);
          if (after !== null) follow = earnSkimFollowUp({ fee, priceBefore: before.price, markBefore: before.mark, markAfter: after.mark });
        }
        if (fee === 0n && follow === 'unknown') {
          // A zero fee whose mark could not be read (before or after) is not "nothing owed": whether the fee
          // was refused is unknown, so it is not done for the day. The next skim comes after the refusal retry, which
          // checks again; no page, because nothing is known to be wrong yet.
          skim = 'fee-unverified';
          ctx.store.setMeta(earnSkimMetaKey(vault), String(now - earn.skimIntervalS + EARN_SKIM_REFUSED_RETRY_S));
        } else if (follow === 'refused') {
          skim = 'fee-refused';
          ctx.store.setMeta(earnSkimMetaKey(vault), String(now - earn.skimIntervalS + EARN_SKIM_REFUSED_RETRY_S));
          await ctx.alerts.raise({
            kind: 'v2_earn_skim_refused',
            dedupeKey: vault.toLowerCase(),
            once: false,
            severity: 'warn',
            message: `cranker skim ${vault}: the share price is above the mark and the fee was not taken. It is still owed. The next skim is in ${EARN_SKIM_REFUSED_RETRY_S}s, not the full interval`,
            data: { vault, mark: before?.mark.toString() ?? null, price: before?.price.toString() ?? null },
          });
        } else {
          ctx.store.setMeta(earnSkimMetaKey(vault), String(now));
        }
      }
    }
  }
  return { vault, calls: r.calls, served: r.served.toString(), stop: r.stop, head: r.last.head.toString(), tail: r.last.tail.toString(), hasOpenPosition: r.last.hasOpenPosition, skim };
}

/**
 * The `house` step: `houseRoll`, then the EarnVault queue, on a budget of its own. With no factory, no House vault in
 * the registry and no V2_EARN_VAULT configured it reads nothing, not even the head, so a cranker without any of them
 * pays nothing for the step and cannot fail it.
 */
export async function stepHouse(ctx: CrankContext, reads: HouseRollReads = chainHouseRollReads(ctx)): Promise<StepReport> {
  const report = newReport('house');
  const earn = ctx.config.tuning.earn;
  const anyHouse = reads.factories.length > 0 || reads.registryVaults().length > 0;
  if (!anyHouse && earn === null) {
    report.notes = { factories: [], houseRoll: [] };
    return report;
  }
  const budget = new Budget(ctx.config.tuning.maxTxPerStep, ctx.yieldWhen);
  const notes = anyHouse ? await houseRoll(ctx, report, budget, await head(ctx), reads) : [];
  const earnNotes = earn === null ? null : await earnQueue(ctx, report, budget, earn);
  // houseRoll leaves `houseRollErrors: [{ factory, error }]` for a factory it could not enumerate, and
  // `houseRollUnlisted: [vault]` for a registry vault no factory listed; keep both beside the notes.
  report.notes = {
    factories: reads.factories,
    houseRoll: notes,
    ...(report.notes.houseRollErrors === undefined ? {} : { houseRollErrors: report.notes.houseRollErrors }),
    ...(report.notes.houseRollUnlisted === undefined ? {} : { houseRollUnlisted: report.notes.houseRollUnlisted }),
    ...(earnNotes === null ? {} : { earnQueue: earnNotes }),
  };
  return report;
}

export async function stepHousekeeping(ctx: CrankContext, usdg: Address): Promise<StepReport> {
  const report = newReport('housekeeping');
  const budget = new Budget(ctx.config.tuning.maxTxPerStep, ctx.yieldWhen);
  const h = await head(ctx);

  // Orders past validUntil that are still open (AskWrite past its cutoff, bids and resale asks with an
  // explicit validUntil, anything the prune step did not reach).
  const candidates = ctx.index.expiredOpenOrders(h.timestamp, 2_000);
  const views = candidates.length === 0 ? [] : await readOrders(ctx.client, ctx.addresses.orderBook, candidates.map((o) => o.orderId), h.blockNumber);
  const dead = views.filter(isDeadOrder).map((o) => o.id);
  if (!ctx.sender.dryRun && dead.length > 0) ctx.index.markOrdersDead(dead);
  const prunable = prunableHere(ctx, views, h.timestamp);
  const { pruned, unprunable } = prunable.length === 0 ? { pruned: 0, unprunable: [] } : await pruneOrders(ctx, report, budget, prunable, 'past validUntil', h.timestamp);

  // Exercise fees: USDG (puts) and each live market's Stock Token (calls), weekly.
  const assets = [usdg, ...v2Markets(ctx.config.registry, ['live', 'paused']).map((m) => m.underlying)];
  const accrued = await readMany(ctx.client, assets.map((a): AnyRead => ({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'accruedFees', args: [a] })), h.blockNumber);
  const swept: unknown[] = [];
  for (const [i, asset] of assets.entries()) {
    const amount = accrued[i]?.ok ? (accrued[i]!.result as bigint) : 0n;
    const last = ctx.store.getMeta(sweepMetaKey(asset));
    if (!sweepDue({ accrued: amount, lastSweepAt: last === null ? null : Number(last), now: h.timestamp, intervalS: ctx.config.tuning.sweepIntervalS }) || !budget.left) continue;
    const outcome = await send(
      ctx,
      report,
      budget,
      `sweepFees ${asset} (${amount})`,
      { address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'sweepFees', args: [asset], gas: GAS.sweepFees },
      {
        kind: 'sweepFees',
        key: asset.toLowerCase(),
        isAdvanced: async () => (await ctx.client.readContract({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'accruedFees', args: [asset] })) === 0n,
      },
    );
    if ((outcome.status === 'confirmed' || outcome.status === 'already-advanced') && !ctx.sender.dryRun) ctx.store.setMeta(sweepMetaKey(asset), String(h.timestamp));
    swept.push({ asset, amount, status: outcome.status });
  }
  report.notes = { expiredOpenOrders: candidates.length, markedDead: dead.length, prunable: prunable.length, pruned, unprunable: unprunable.map(String), fees: swept };
  return report;
}
