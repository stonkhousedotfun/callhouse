/**
 * The cranker's steps (K2-03). Each one reads what it needs from chain (reads.ts), asks the planner
 * (planner.ts), and sends through the CrankSender with a fixed gas limit. Each is independent (a
 * failing step does not stop the next), bounded (at most CRANKER_MAX_TX_PER_STEP sends per tick) and
 * idempotent (every send re-checks state, and the contracts no-op a repeat).
 *
 *   index         scan the contracts' logs into the cranker's own index (scanner.ts)
 *   stale         INTERFACE_VERSION 7 (c16): AutoRoller.cancelStale for every live roller ask the spot has
 *                 overtaken, before anything slow — the ask fills below intrinsic value until it is withdrawn
 *   snapshot      K2-03 step 2: SettlementOracle.snapshot once inside [expiry, expiry + 600] for
 *                 every (underlying, expiry) with open interest
 *   finalize      step 3: finalize from expiry + 120 when a view says it would advance; the
 *                 disagreement, held, no-source and stuck alerts
 *   settle        step 3: Clearinghouse.settle every series of a final expiry with long supply
 *   prune         step 4, first half: every open order of an expired series, resale asks first
 *   redeem        step 4, second half: redeemBatch holders (indexer pages ∪ log index), longs then
 *                 shorts, in chunks sized by fixed per-holder gas budgets and split when a
 *                 simulation under the limit falls short; zero payouts and opted-out holders skipped
 *   ladders       step 1: the registry ladder for the next expiries of each live market and tenor,
 *                 each batch budgeted for the settlement pin a first series of an expiry pays; a refused
 *                 pin (cranker/pin.ts) skips that expiry and pages v2_pin_refused
 *   rolls         step 5: AutoRoller.roll for due strategies (skipped without a roller); a roll refused
 *                 by its series' pin pages v2_pin_refused
 *   housekeeping  step 6: prune orders past validUntil; sweepFees per asset weekly
 *
 * EXECUTION ORDER is the list above, not the task's numbering: the snapshot window is the only
 * deadline measured in minutes, so a tick woken at an expiry reaches it before anything slow (a
 * cold ladder of 35 markets), and settle and redeem follow finalize in the same tick. `stale` runs first of the
 * sending steps because every block an overtaken roller ask stays live is a block a taker can lift it below
 * intrinsic value, and the call is cheap (350k) and permissionless.
 */
import { encodeFunctionData, getAddress, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { autoRollerAbi } from '../abi/autoRoller.js';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { expiryCalendarAbi } from '../abi/expiryCalendar.js';
import { orderBookAbi } from '../abi/orderBook.js';
import { settlementOracleAbi } from '../abi/settlementOracle.js';
import { readHead, type Head } from '../chain.js';
import type { CrankerConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { marketByUnderlying, TENORS, v2Markets, type Tenor } from '../registry.js';
import { longIdOf, shortIdOf } from '../seriesId.js';
import type { V2Store } from '../store.js';
import { describeError, revertDetail, type ExecuteOptions } from '../tx.js';
import { GAS, PIN_REFUSED_RECHECK_S, ROLL_OPEN_GRACE_S, SNAPSHOT_GRACE, UNIT } from './constants.js';
import { advanced, type CrankAlerts, type CrankOutcome, type CrankSender, type FixedGasCall } from './effects.js';
import type { CrankerIndex } from './index-store.js';
import type { IndexerClient } from './indexer-client.js';
import {
  chunkByGas,
  chunkCreates,
  expiryKeyString,
  isDeadOrder,
  ladderSearchStart,
  planExpiry,
  planLadder,
  planPinGroup,
  planRoll,
  planStale,
  pinGroupKey,
  prunableOrders,
  redeemGasOf,
  selectRedeemable,
  splitChunk,
  sweepDue,
  type ExpiryKey,
  type GasChunk,
  type HolderView,
  type OrderView,
  type PinGroupView,
} from './planner.js';
import { decodeRevertData, pinRefusalOf, type PinRefusal } from './pin.js';
import { okResult, readHolders, readMany, readOrders, surveyExpiries, type AnyRead, type ExpirySurvey } from './reads.js';
import { scanLogs, type LogClient } from './scanner.js';

export const STEP_ORDER = ['index', 'stale', 'snapshot', 'finalize', 'settle', 'prune', 'redeem', 'ladders', 'rolls', 'housekeeping'] as const;
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
/** A refused settlement pin of one (oracle, underlying, expiry) (planner.pinGroupKey): JSON PinRefusedMark. */
export const pinRefusedMetaKey = (group: string) => `cranker:pin-refused:${group}`;
/** An order OrderBook.prune skipped alone under the gas cap (its maker rejects the refund): the head timestamp it was seen. */
export const unprunableMetaKey = (orderId: bigint) => `cranker:unprunable:${orderId}`;
/** Where the next rolls step starts in its strategy list (a rotation, so no address prefix always goes first). */
export const rollsOffsetMetaKey = 'cranker:rolls:offset';
/** Most rolls per tick that earn no ROLL bounty (under AutoRoller.minRollUnits): each costs the cranker ~700k gas. */
export const ROLLS_BELOW_BOUNTY_PER_TICK = 10;

const newReport = (step: StepName): StepReport => ({ step, actions: [], notes: {}, wakeAt: [] });

/** How many sends a step may still make this tick; none once the tick must yield (CrankContext.yieldWhen). */
class Budget {
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
 */
async function send(ctx: CrankContext, report: StepReport, budget: Budget, what: string, call: FixedGasCall, options: ExecuteOptions<unknown>): Promise<CrankOutcome> {
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

async function head(ctx: CrankContext): Promise<Head> {
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

export async function stepIndex(ctx: CrankContext): Promise<StepReport> {
  const report = newReport('index');
  const h = await head(ctx);
  const result = await scanLogs(
    ctx.logClient,
    ctx.index,
    {
      clearinghouse: ctx.addresses.clearinghouse,
      orderBook: ctx.addresses.orderBook,
      autoRoller: ctx.addresses.autoRoller,
      fromBlock: ctx.config.registry.deployBlock ?? 0n,
    },
    { head: h.blockNumber, chunkBlocks: ctx.config.tuning.logChunkBlocks, maxChunks: ctx.config.tuning.logChunksPerTick },
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
 * INTERFACE_VERSION 7 (c16): withdraw every live AutoRoller ask the spot has overtaken.
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

  const underlyings = [...new Set(list.map((p) => p.underlying))];
  const first = await readMany(
    ctx.client,
    [
      ...list.map((p): AnyRead => ({ address: roller, abi: autoRollerAbi, functionName: 'position', args: [p.writer, p.underlying] })),
      ...underlyings.map((u): AnyRead => ({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'market', args: [u] })),
      { address: roller, abi: autoRollerAbi, functionName: 'minRollUnits' },
    ],
    h.blockNumber,
  );
  const positions = list.map((_, i) => okResult<readonly [bigint, bigint, number]>(first[i]));
  const oracleOf = new Map(underlyings.map((u, i) => [u, okResult<MarketConfigStruct>(first[list.length + i])?.oracle ?? ctx.addresses.settlementOracle]));
  const minRollUnits = okResult<bigint>(first[list.length + underlyings.length]) ?? 0n;

  // Only a pair with a tracked ask inside its period can be withdrawn: nothing else costs a read.
  const live = list.map((p, i) => ({ p, position: positions[i] })).filter((x) => x.position !== undefined && x.position[1] !== 0n && h.timestamp < Number(x.position[2]));
  if (live.length === 0) {
    report.notes = { strategies: list.length, indexer, withLiveAsk: 0 };
    return report;
  }
  const orderIds = live.map((x) => x.position![1]);
  const longIds = [...new Set(live.map((x) => x.position![0]))];
  const spotUnderlyings = [...new Set(live.map((x) => x.p.underlying))];
  const second = await readMany(
    ctx.client,
    [
      { address: ctx.addresses.orderBook, abi: orderBookAbi, functionName: 'getOrders', args: [orderIds] },
      ...longIds.map((id): AnyRead => ({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'series', args: [id] })),
      ...spotUnderlyings.map((u): AnyRead => ({ address: oracleOf.get(u)!, abi: settlementOracleAbi, functionName: 'trySpot', args: [u] })),
    ],
    h.blockNumber,
  );
  const orders = okResult<readonly RollerOrderStruct[]>(second[0]) ?? [];
  const seriesOf = new Map(longIds.map((id, i) => [id.toString(), okResult<RollerSeriesStruct>(second[1 + i])]));
  const spotOf = new Map(
    spotUnderlyings.map((u, i) => {
      const r = okResult<readonly [boolean, bigint, bigint]>(second[1 + longIds.length + i]);
      return [u, r !== undefined && r[0] && r[1] > 0n ? r[1] : null] as const;
    }),
  );

  const decided = live.map((x, i) => {
    const order = orders[i];
    const series = seriesOf.get(x.position![0].toString());
    return {
      p: x.p,
      longId: x.position![0],
      orderId: x.position![1],
      spot: spotOf.get(x.p.underlying) ?? null,
      strike: series?.strike ?? null,
      decision: planStale({
        orderId: x.position![1],
        positionExpiry: Number(x.position![2]),
        now: h.timestamp,
        order: order === undefined || order.maker.toLowerCase() === '0x0000000000000000000000000000000000000000' ? null : { units: BigInt(order.units), filled: BigInt(order.filled), validUntil: Number(order.validUntil), cancelled: order.cancelled },
        series: series === undefined ? null : { isPut: series.isPut, strike: series.strike },
        spot: spotOf.get(x.p.underlying) ?? null,
        minRollUnits,
      }),
    };
  });
  const cancelling = decided.filter((d) => d.decision.cancel);
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
      `cancelStale ${d.p.writer} ${ticker} (spot ${d.spot} at or past strike ${d.strike})`,
      { address: roller, abi: autoRollerAbi, functionName: 'cancelStale', args: [d.p.writer, d.p.underlying], gas: GAS.cancelStale },
      { kind: 'cancelStale', key, worthSending: (did) => did === true },
    );
    cancelled.push({ writer: d.p.writer, ticker, orderId: d.orderId.toString(), spot: d.spot, strike: d.strike, status: outcome.status });
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
        message: `${ticker}: the AutoRoller ask of ${d.p.writer} is at or past its ${d.strike} strike (spot ${d.spot}) but cancelStale is refused (${outcome.revert ?? 'no reason'})${revoked ? ': the writer revoked the roller, so only the writer can withdraw it' : ''}`,
        data: { writer: d.p.writer, underlying: d.p.underlying, longId: d.longId.toString(), orderId: d.orderId.toString(), spot: d.spot, strike: d.strike, revert: outcome.revert, delegateRevoked: revoked },
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
    const outcome = await send(
      ctx,
      report,
      budget,
      `snapshot ${tickerOf(ctx, underlying)} ${s.key.expiry}`,
      { address: getAddress(s.key.oracle), abi: settlementOracleAbi, functionName: 'snapshot', args: [underlying, s.key.expiry], gas: GAS.snapshot },
      { kind: 'snapshot', key: expiryKeyString(s.key), worthSending: (recorded) => Number(recorded) > 0 },
    );
    // Recorded, or nothing to record at a time inside the window: either way finalize may follow.
    if (!ctx.sender.dryRun && (outcome.status === 'confirmed' || outcome.status === 'no-op') && h.timestamp <= s.key.expiry + SNAPSHOT_GRACE) {
      ctx.store.setMeta(snapshotMetaKey(s.key), JSON.stringify({ at: h.timestamp, recorded: outcome.status === 'confirmed' ? Number(outcome.result) : 0 }));
    }
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
    await send(
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
    );
  }
  report.notes = { expiries };
  return report;
}

/*//////////////////////////////////////////////////////////////
                             SETTLE
//////////////////////////////////////////////////////////////*/

export async function stepSettle(ctx: CrankContext, keys: readonly ExpiryKey[]): Promise<StepReport> {
  const report = newReport('settle');
  const budget = new Budget(ctx.config.tuning.maxTxPerStep, ctx.yieldWhen);
  const h = await head(ctx);
  const surveys = await survey(ctx, keys.filter((k) => k.expiry <= h.timestamp), h, false);
  let planned = 0;
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
      if (advanced(outcome) && !ctx.sender.dryRun) ctx.store.setMeta(settledSeenMetaKey(longId), String(h.timestamp));
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
  report.notes = { planned };
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
      if (!ctx.sender.dryRun) ctx.index.markOrdersDead(ids);
      pruned += Number(outcome.result as bigint);
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
  const adapterSet = adapterRead?.ok === true && (adapterRead.result as string).toLowerCase() !== '0x0000000000000000000000000000000000000000';
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
    const views = candidates.length === 0 ? [] : await readHolders(ctx.client, ctx.addresses.clearinghouse, tokenId, candidates, h.blockNumber);
    const selection = selectRedeemable(views, { perUnitPayout, burnZero });
    const known = views.reduce((sum, v) => sum + v.balance, 0n);
    const unaccounted = supply > known ? supply - known : 0n;
    const gasOf = (holder: HolderView) => redeemGasOf(holder, { isLong: t.isLong, isPut: series.isPut, perUnitPayout, adapterSet });
    const queue: GasChunk<HolderView>[] = chunkByGas(selection.redeem, { gasOf, baseGas: GAS.redeemBase, capGas: cap, maxItems: 200 });
    let redeemed = 0;
    let skipped = 0;
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
        { kind: 'redeemBatch', key: tokenId.toString(), worthSending: (count) => (count as bigint) === BigInt(n) },
      );
      if (advanced(outcome)) redeemed += n;
      else if (fellShort(outcome)) {
        // Fewer redeemed than asked under this limit (an inner out-of-gas swallowed by the batch's try/catch), or the
        // whole call out of gas (a holder that ran out mid-batch leaves the next one 1/64 of the gas): split.
        if (n > 1 || chunk.gas < cap) queue.unshift(...splitChunk(chunk, cap));
        else skipped += 1;
      }
    }
    const remaining = selection.redeem.length - redeemed - skipped;
    remainingByExpiry.set(t.survey, (remainingByExpiry.get(t.survey) ?? 0) + remaining + skipped + (unaccounted > 0n ? 1 : 0));
    summaries.push({ token: label, tokenId: tokenId.toString(), supply, candidates: candidates.length, redeemable: selection.redeem.length, redeemed, skipped, optedOut: selection.optedOut, zeroPayout: selection.zeroPayout, unaccounted });

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

async function upcomingExpiries(ctx: CrankContext, now: number, weekly: boolean, count: number): Promise<number[]> {
  const out: number[] = [];
  let after = ladderSearchStart(now);
  while (out.length < count) {
    let next: number;
    try {
      next = Number(await ctx.client.readContract({ address: ctx.addresses.expiryCalendar, abi: expiryCalendarAbi, functionName: 'nextExpiry', args: [after, weekly] }));
    } catch {
      break; // nothing within the calendar's search window
    }
    out.push(next);
    after = next;
  }
  return out;
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
  const configs = markets.map((m, i) => (marketReads[i]?.ok ? (marketReads[i]!.result as MarketConfigStruct) : null));
  const spotReads = await readMany(
    ctx.client,
    markets.map((m, i): AnyRead => ({ address: configs[i]?.oracle ?? ctx.addresses.settlementOracle, abi: settlementOracleAbi, functionName: 'trySpot', args: [m.underlying] })),
    h.blockNumber,
  );

  const maxAhead: Record<Tenor, number> = { weekly: 0, daily: 0 };
  for (const m of markets) for (const tenor of TENORS) maxAhead[tenor] = Math.max(maxAhead[tenor], m.v2.params.expiriesAhead[tenor]);
  const expiries: Record<Tenor, number[]> = {
    weekly: maxAhead.weekly > 0 ? await upcomingExpiries(ctx, h.timestamp, true, maxAhead.weekly) : [],
    daily: maxAhead.daily > 0 ? await upcomingExpiries(ctx, h.timestamp, false, maxAhead.daily) : [],
  };

  const creates = new Map<string, { underlying: Address; isPut: boolean; strike: bigint; expiry: number; ticker: string; oracle: Address }>();
  markets.forEach((m, i) => {
    const cfg = configs[i];
    const spotRead = spotReads[i];
    const note: Record<string, unknown> = { ticker: m.ticker };
    notes.push(note);
    if (cfg === null || cfg === undefined || cfg.strikeTick === 0n) return void (note.skipped = 'not registered on the Clearinghouse');
    if (!cfg.enabled) return void (note.skipped = 'market disabled');
    const [ok, spot] = spotRead?.ok ? (spotRead.result as readonly [boolean, bigint, bigint]) : [false, 0n, 0n];
    if (!ok || spot === 0n) return void (note.skipped = 'spot not fresh (trySpot not ok): ladders wait for a fresh price');
    note.spot = spot;
    const planned: unknown[] = [];
    for (const tenor of TENORS) {
      const ahead = m.v2.params.expiriesAhead[tenor];
      for (const expiry of expiries[tenor].slice(0, ahead)) {
        const existingAll = ctx.index.seriesOf(m.underlying, expiry);
        for (const isPut of m.v2.puts ? [false, true] : [false]) {
          const anchorKey = ladderAnchorMetaKey(m.underlying, expiry, isPut, tenor);
          const anchorRaw = ctx.store.getMeta(anchorKey);
          const plan = planLadder({
            spot,
            ladder: m.v2.params.ladder[tenor],
            strikeTick: cfg.strikeTick,
            isPut,
            existing: existingAll.filter((s) => s.isPut === isPut).map((s) => s.strike),
            anchor: anchorRaw === null ? null : BigInt(anchorRaw),
          });
          if (!ctx.sender.dryRun && (anchorRaw === null || BigInt(anchorRaw) !== plan.anchor)) ctx.store.setMeta(anchorKey, plan.anchor.toString());
          if (plan.create.length > 0) planned.push({ tenor, expiry, type: isPut ? 'put' : 'call', reason: plan.reason, strikes: plan.create });
          for (const strike of plan.create) {
            const id = longIdOf(m.underlying, isPut, strike, expiry);
            creates.set(id.toString(), { underlying: m.underlying, isPut, strike, expiry, ticker: m.ticker, oracle: cfg.oracle });
          }
        }
      }
    }
    note.planned = planned;
  });

  // What the index has not seen yet may already exist on chain: never pay for a no-op create.
  const wanted = [...creates.entries()];
  const exists = wanted.length === 0 ? [] : await readMany(ctx.client, wanted.map(([id]): AnyRead => ({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'seriesExists', args: [BigInt(id)] })), h.blockNumber);
  const missing = wanted.filter((_, i) => !(exists[i]?.ok && exists[i]!.result === true)).map(([id, c]) => ({ id: BigInt(id), ...c }));

  const creation = await createSeriesBatches(ctx, report, budget, h, missing, notes);
  report.notes = { markets: notes, expiries, planned: creates.size, missing: missing.length, created: creation.created, pins: creation.pins, ...(creation.failures.length > 0 ? { failures: creation.failures } : {}) };
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
 * K2-03 step 1's sends: the missing series in Multicall3 batches, each budgeted for the settlement pin the first
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
    ],
    h.blockNumber,
  );
  const BASE = 2;
  const sessionOpen = okResult<boolean>(reads[0]) === true;
  const sessionOpenAtGrace = okResult<boolean>(reads[1]) === true;
  const oracleOf = new Map(underlyings.map((u, i) => [u, okResult<MarketConfigStruct>(reads[BASE + list.length * PER + i])?.oracle ?? ctx.addresses.settlementOracle]));
  const minRollUnits = okResult<bigint>(reads[BASE + list.length * PER + underlyings.length]) ?? 0n;
  const spots = await readMany(ctx.client, underlyings.map((u): AnyRead => ({ address: oracleOf.get(u)!, abi: settlementOracleAbi, functionName: 'trySpot', args: [u] })), h.blockNumber);
  const spotRead = new Map(underlyings.map((u, i) => [u, okResult<readonly [boolean, bigint, bigint]>(spots[i])]));
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
  const decided = rotated.flatMap((i) => {
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
    });
    const free = okResult<bigint>(reads[BASE + 2 + i * PER]);
    const maxUnits = strategy.maxUnits ?? 0n;
    // `free / UNIT` is an UPPER bound of the roller's rent-aware size (`free / (UNIT + feePerUnit)`, v7 §4.5.4), so
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
    decisions.push({ writer: p.writer, ticker: tickerOf(ctx, p.underlying), ...decision, ...(earnsBounty ? {} : { belowMinRollUnits: true }) });
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
  report.notes = { strategies: list.length, sessionOpen, sessionOpenAtGrace, indexer, minRollUnits, belowMinRollUnitsSent: belowBounty, decisions, reverting };
  return report;
}

/*//////////////////////////////////////////////////////////////
                          HOUSEKEEPING
//////////////////////////////////////////////////////////////*/

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
