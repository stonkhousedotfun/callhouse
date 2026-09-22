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
import { houseVaultAbi } from '../abi/houseVault.js';
import { houseVaultFactoryAbi } from '../abi/houseVaultFactory.js';
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
import { GAS, PIN_REFUSED_RECHECK_S, ROLL_OPEN_GRACE_S, SETTLEMENT_STATUS, SNAPSHOT_GRACE, UNIT } from './constants.js';
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
  upcomingLadderExpiries,
  type ExpiryKey,
  type GasChunk,
  type HolderView,
  type OrderView,
  type PinGroupView,
} from './planner.js';
import { decodeRevertData, pinRefusalOf, type PinRefusal } from './pin.js';
import { marketOracleOf, okResult, readHolders, readMany, readOrders, surveyExpiries, type AnyRead, type ExpirySurvey } from './reads.js';
import { scanLogs, type LogClient } from './scanner.js';

export const STEP_ORDER = ['index', 'stale', 'snapshot', 'finalize', 'settle', 'prune', 'redeem', 'ladders', 'rolls', 'housekeeping', 'flywheel'] as const;
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
 * AND v2_rpc_lag WHEN THE SIMULATION GOT NO ANSWER (T-556, T-202's suspicion 2). A full outage never reaches here:
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
  /** The oracle createSeries pinned into the series: the one it settles on and AutoRoller.cancelStale reads (T-310). */
  oracle: Address;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** stepStale's spot key: one oracle's price for one underlying. Two series of one underlying may differ (T-437). */
const spotKey = (oracle: Address, underlying: Address): string => `${oracle.toLowerCase()}:${underlying.toLowerCase()}`;

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
 * ORACLE (T-437). The spot of each ask comes from ITS SERIES' pinned oracle (`Clearinghouse.series(longId).oracle`),
 * which is what `cancelStale` reads on chain since T-310 and what the series settles on. Never `market(u).oracle`: a
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
  // FAIL CLOSED (coordinator amendment M-57015e47e436488e, from T-290 M-32bbd7e2207b408b). The minimum decides which
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

  const decided = live.map((x, i) => {
    const order = orders[i];
    const series = seriesOf.get(x.position![0].toString());
    const spot = series === undefined ? null : (spotOf.get(spotKey(series.oracle, x.p.underlying)) ?? null);
    return {
      p: x.p,
      longId: x.position![0],
      orderId: x.position![1],
      oracle: series?.oracle ?? null,
      spot,
      strike: series?.strike ?? null,
      decision: planStale({
        orderId: x.position![1],
        positionExpiry: Number(x.position![2]),
        now: h.timestamp,
        order: order === undefined || order.maker.toLowerCase() === ZERO_ADDRESS ? null : { units: BigInt(order.units), filled: BigInt(order.filled), validUntil: Number(order.validUntil), cancelled: order.cancelled },
        series: series === undefined ? null : { isPut: series.isPut, strike: series.strike },
        spot,
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
    cancelled.push({ writer: d.p.writer, ticker, orderId: d.orderId.toString(), oracle: d.oracle, spot: d.spot, strike: d.strike, status: outcome.status });
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

/**
 * T-469. After a mined snapshot, the expiry surveyed again at the receipt's block through the planner's own reads: the
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
    if (ctx.sender.dryRun || h.timestamp > s.key.expiry + SNAPSHOT_GRACE) continue;
    if (outcome.status === 'no-op') {
      ctx.store.setMeta(snapshotMetaKey(s.key), JSON.stringify({ at: h.timestamp, recorded: 0 }));
    } else if (outcome.status === 'confirmed') {
      // T-469. The mark stops every later snapshot of this expiry, lets finalize go ahead of it and silences
      // v2_snapshot_missed (planner.planExpiry), and a confirmed outcome's `result` is the SIMULATION's count (tx.ts).
      // SettlementOracle.snapshot calls each source's `record` raw, so a source that fails on chain leaves a successful
      // receipt. The mark and its count are read from the sources at the mined block; left unset, the next tick asks
      // again, and a snapshot with nothing left to record then marks it through the no-op above.
      const recorded = await recordedAtBlock(ctx, s, { blockNumber: outcome.blockNumber, timestamp: h.timestamp });
      if (recorded !== null) ctx.store.setMeta(snapshotMetaKey(s.key), JSON.stringify({ at: h.timestamp, recorded }));
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

/** T-462. Whether chain state at `blockNumber` shows the series settled; false when that read fails. */
async function settledAtBlock(ctx: CrankContext, longId: bigint, blockNumber: bigint): Promise<boolean> {
  try {
    return (await ctx.client.readContract({ address: ctx.addresses.clearinghouse, abi: clearinghouseAbi, functionName: 'series', args: [longId], blockNumber })).settled;
  } catch (error) {
    ctx.log.warn({ longId: longId.toString(), block: blockNumber.toString(), error: describeError(error) }, 'could not read the series a mined settle covered: its settled mark waits for the next survey');
    return false;
  }
}

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
      // T-462. Clearinghouse.settle returns false, with a successful receipt, when the price is not final on chain, and a
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
 * T-462. The ids of a mined prune chunk that the book shows dead at the receipt's block: what the prune did, not what its
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
      // T-462. A confirmed outcome's `result` is the SIMULATION's count (tx.ts), and the receipt reads success whether
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
 * T-462. The holders of a mined redeemBatch chunk that still hold the token at the receipt's block: the ones the batch
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
        { kind: 'redeemBatch', key: tokenId.toString(), worthSending: (count) => (count as bigint) === BigInt(n) },
      );
      if (outcome.status === 'confirmed') {
        // T-462. Worth sending only when the SIMULATION redeemed all n, and a confirmed outcome carries that simulated
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
  // A market whose market() read failed has no known oracle: no spot is read for it, so its writers read as spot-stale
  // (no new roll) and are flagged marketUnread. A close-out does not use the spot and still goes ahead.
  const oracleOf = new Map(underlyings.map((u, i) => [u, marketOracleOf(reads[BASE + list.length * PER + i])]));
  // FAIL CLOSED (coordinator amendment M-57015e47e436488e): with the minimum unread, `?? 0n` let every roll count as
  // bounty-paying and bypassed ROLLS_BELOW_BOUNTY_PER_TICK. No roll or close-out is planned this tick; the next reads again.
  const minRollUnits = okResult<bigint>(reads[BASE + list.length * PER + underlyings.length]);
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
                 HOUSE VAULT EPOCH ROLL (T-OP-117)
//////////////////////////////////////////////////////////////*/

/**
 * `HouseVault.rollEpoch()` is PERMISSIONLESS and nothing in the keeper sent it (T-OP-100 finding (c)): the MM bot
 * computes `rollDue` (mm/house.ts) to stop opening risk, and stopped there. Without a sender, the first weekly
 * boundary after launch prices no deposit and no withdrawal until a human calls the function. This is the sender.
 *
 * WHERE IT RUNS. Inside `stepHousekeeping`, after the sweeps, on the housekeeping step's own budget. A step of its own
 * in STEP_ORDER would need a `case` in cranker/cranker.ts (outside T-OP-117's fence), so until that row lands the roll
 * rides the step that already runs once per tick after settle/prune/redeem - which is the order it needs: a vault is
 * only flat once its series are settled and redeemed. Actions carry `kind: 'house-roll'` so /metrics and the journal
 * can tell them apart.
 *
 * WHICH KEY. The cranker's (CRANKER_PK). `rollEpoch` is `unrestricted` in roles.v8.json, so any key may send it; the
 * QUOTER key is the MM bot's and spends the MM budget on quoting - a boundary call from it would compete with the
 * bot's own cancels at exactly the moment it must be flat. Cranking is the cranker's job.
 *
 * THE PRECONDITIONS ARE THE CONTRACT'S, MIRRORED FROM HouseVault.sol (callhouse-contracts v8, `rollEpoch` NatSpec):
 *   1. `block.timestamp >= epochEnd`  (TooEarly)               -> `rollDue(epochEnd, head.timestamp)`;
 *   2. every tracked series settled and the vault flat          -> `trackedSeries()` x `clearinghouse.series(id).settled`
 *      (`_requireFlat`: no longs, shorts or live orders)           and `exposure(id).detail` longs/shorts/live == 0;
 *   3. `oracle.settlementPrice(underlying, epochEnd)` Finalized  -> the vault's own `oracle()` and `underlying()`.
 * Nothing looser is invented here; a vault that fails 2 or 3 is reported with the reason and NOT sent, because the
 * send would revert `NotSettled`. A send that reverts anyway (a race with a fill, an unpriced donation) is recorded
 * with its reason by `send` and is re-evaluated from chain state next tick - never retried blind.
 *
 * THE FACTORY ADDRESS. The cranker config has no House factory field (config.ts, outside this fence); the MM bot's
 * `MM_HOUSE_FACTORY` is the one place the operator already names it. `houseFactoryFor` reads `CRANKER_HOUSE_FACTORY`
 * then `MM_HOUSE_FACTORY` from the environment, strictly validated, and answers null - a documented no-op - when
 * neither is set. Moving this into `CrankerTuning` is the follow-up named in the ledger.
 */

/**
 * rollEpoch: `_redeemSettled` redeems every settled tracked series the vault still holds (a long redeem that converts
 * an ITM call payout through the PayoutRouter is ~450k, GAS.redeemConvertEach), `_requireFlat` re-reads each tracked
 * series, then fee transfer, burns and mints. 2.5M covers several tracked series with conversions; a boundary with
 * more is the exception, and a fixed limit that is too small reverts loudly rather than doing half a boundary.
 * NOT MEASURED on a fork yet - the ledger says so.
 */
export const HOUSE_ROLL_GAS = 2_500_000n;

/**
 * How long `rollDue` may stay true before `v2_house_roll_overdue` pages. 7 hours = the oracle's uncorroborated delay
 * (SettlementOracle.DEFAULT_UNCORROBORATED_DELAY, 6 h: a single-ok-source expiry cannot finalize sooner) plus one hour
 * for the settle/redeem steps to run after finalization. Inside that window an unrolled boundary is the settlement
 * chain doing its job, not an incident; past it, either the oracle is Held (GUARDIAN vetoed; SEC-21 rota) or nothing
 * is sending, and a human should look. The launch pair is dual-source and normally finalizes at expiry + 120 s.
 */
export const HOUSE_ROLL_OVERDUE_S = 7 * 3_600;

/** `HouseVault.rollEpoch` per vault; the dedupe key of the overdue page is the vault. */
export const HOUSE_ROLL_KIND = 'house-roll';

export interface HouseVaultRollView {
  epochEnd: number;
  epochId: bigint;
  underlying: Address;
  oracle: Address;
  tracked: readonly bigint[];
}

export interface HouseTrackedView {
  longId: bigint;
  settled: boolean;
  longs: bigint;
  shorts: bigint;
  live: bigint;
}

/** The chain reads the roll needs, injectable so the decision is tested without an RPC (the house.ts pattern). */
export interface HouseRollReads {
  factory: Address | null;
  discover: (factory: Address, blockNumber: bigint) => Promise<readonly Address[]>;
  readVault: (vault: Address, blockNumber: bigint) => Promise<HouseVaultRollView | null>;
  readTracked: (vault: Address, tracked: readonly bigint[], blockNumber: bigint) => Promise<readonly HouseTrackedView[]>;
  /** `oracle.settlementPrice(underlying, epochEnd)` is Finalized. */
  readFinalized: (oracle: Address, underlying: Address, epochEnd: number, blockNumber: bigint) => Promise<boolean>;
}

const STRICT_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** CRANKER_HOUSE_FACTORY, else MM_HOUSE_FACTORY; null when unset or not an address (never a partial read). */
export function houseFactoryFor(env: NodeJS.ProcessEnv = process.env): Address | null {
  const raw = (env.CRANKER_HOUSE_FACTORY ?? env.MM_HOUSE_FACTORY ?? '').trim();
  if (raw === '') return null;
  if (!STRICT_ADDRESS.test(raw)) return null;
  try {
    return getAddress(raw);
  } catch {
    return null;
  }
}

export function chainHouseRollReads(ctx: CrankContext, factory: Address | null = houseFactoryFor()): HouseRollReads {
  return {
    factory,
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
        return { epochEnd: Number(epochEnd), epochId: epochId as bigint, underlying: underlying as Address, oracle: oracle as Address, tracked: tracked as readonly bigint[] };
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
        const settled = series?.ok === true && (series.result as { settled: boolean }).settled === true;
        const detail = exposure?.ok === true ? ((exposure.result as readonly unknown[])[2] as { longs: bigint; shorts: bigint; live: bigint }) : null;
        return { longId, settled, longs: detail?.longs ?? 1n, shorts: detail?.shorts ?? 1n, live: detail?.live ?? 1n };
      });
    },
    readFinalized: async (oracle, underlying, epochEnd, blockNumber) => {
      const [status] = (await ctx.client.readContract({ address: oracle, abi: settlementOracleAbi, functionName: 'settlementPrice', args: [underlying, epochEnd], blockNumber })) as readonly [number, bigint];
      return (SETTLEMENT_STATUS[Number(status)] ?? 'None') === 'Finalized';
    },
  };
}

export interface HouseRollNote {
  vault: Address;
  epochId: string;
  epochEnd: number;
  decision: 'not-due' | 'not-finalized' | 'not-flat' | 'unreadable' | 'sent' | 'no-budget';
  detail?: string;
  overdueS?: number;
}

/**
 * Rolls every House vault of the configured factory whose boundary is due and whose preconditions hold; pages
 * `v2_house_roll_overdue` for a boundary that has been due longer than HOUSE_ROLL_OVERDUE_S without rolling, and
 * clears it when the vault is not due (it rolled, by this bot or by hand). Exported for the test; `stepHousekeeping`
 * calls it.
 */
export async function houseRoll(ctx: CrankContext, report: StepReport, budget: Budget, h: Head, reads: HouseRollReads = chainHouseRollReads(ctx)): Promise<HouseRollNote[]> {
  const notes: HouseRollNote[] = [];
  if (reads.factory === null) return notes;
  let vaults: readonly Address[];
  try {
    vaults = await reads.discover(reads.factory, h.blockNumber);
  } catch (error) {
    report.notes.houseRoll = { factory: reads.factory, error: `vaults() failed: ${String(error).slice(0, 200)}` };
    return notes;
  }
  for (const vault of vaults) {
    const key = vault.toLowerCase();
    const view = await reads.readVault(vault, h.blockNumber);
    if (view === null) {
      notes.push({ vault, epochId: '?', epochEnd: 0, decision: 'unreadable' });
      continue;
    }
    const note: HouseRollNote = { vault, epochId: view.epochId.toString(), epochEnd: view.epochEnd, decision: 'not-due' };
    notes.push(note);
    if (!rollDue(view.epochEnd, h.timestamp)) {
      ctx.alerts.clear('v2_house_roll_overdue', key);
      continue;
    }
    const overdueS = h.timestamp - view.epochEnd;
    note.overdueS = overdueS;
    // Precondition 3 first: it is one read and it is the usual reason a due boundary waits.
    const finalized = await reads.readFinalized(view.oracle, view.underlying, view.epochEnd, h.blockNumber);
    if (!finalized) {
      note.decision = 'not-finalized';
      note.detail = `oracle ${view.oracle} settlementPrice(${view.underlying}, ${view.epochEnd}) is not Finalized`;
    } else {
      const tracked = await reads.readTracked(vault, view.tracked, h.blockNumber);
      const blocking = tracked.filter((t) => !t.settled || t.longs !== 0n || t.shorts !== 0n || t.live !== 0n);
      if (blocking.length > 0) {
        note.decision = 'not-flat';
        note.detail = blocking.map((t) => `${t.longId}:${t.settled ? 'held/live' : 'unsettled'}`).join(',');
      }
    }
    if (note.decision !== 'not-due') {
      // Due and blocked. Inside the settlement chain's own delay this is normal; past it, page.
      if (overdueS > HOUSE_ROLL_OVERDUE_S) {
        await ctx.alerts.raise({
          kind: 'v2_house_roll_overdue',
          dedupeKey: key,
          once: false,
          severity: 'error',
          message: `House vault ${vault} epoch ${view.epochId} ended ${Math.floor(overdueS / 60)} min ago and has not rolled: ${note.decision} (${note.detail ?? ''}). rollEpoch() is permissionless - see ops/alerts.md v2_house_roll_overdue`,
          data: { vault, epochId: view.epochId.toString(), epochEnd: view.epochEnd, overdueS, decision: note.decision, detail: note.detail ?? null },
        });
      }
      continue;
    }
    if (!budget.left) {
      note.decision = 'no-budget';
      continue;
    }
    const before = view.epochId;
    const outcome = await send(
      ctx,
      report,
      budget,
      `rollEpoch ${vault} epoch ${before}`,
      { address: vault, abi: houseVaultAbi, functionName: 'rollEpoch', args: [], gas: HOUSE_ROLL_GAS },
      {
        kind: HOUSE_ROLL_KIND,
        key: `${key}:${before}`,
        // Already rolled (by hand, or by an earlier tick whose receipt was lost): epochId moved past the one we read.
        isAdvanced: async () => ((await ctx.client.readContract({ address: vault, abi: houseVaultAbi, functionName: 'epochId' })) as bigint) > before,
      },
    );
    note.decision = 'sent';
    note.detail = outcome.status;
    if (outcome.status === 'confirmed' || outcome.status === 'already-advanced') ctx.alerts.clear('v2_house_roll_overdue', key);
    if (outcome.status === 'simulation-reverted') note.detail = `simulation-reverted: ${outcome.revert ?? outcome.error.slice(0, 120)}`;
  }
  return notes;
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
  const houseRollNotes = await houseRoll(ctx, report, budget, h);
  report.notes = { expiredOpenOrders: candidates.length, markedDead: dead.length, prunable: prunable.length, pruned, unprunable: unprunable.map(String), fees: swept, houseRoll: houseRollNotes };
  return report;
}
