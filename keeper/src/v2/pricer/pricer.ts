/**
 * One pricer tick (K2-05): for every AutoRoller strategy with smartPricing, right after each roll and
 * then at most every PRICER_MIN_INTERVAL_S, the target price
 *     clamp(fair × (1 + PRICER_EDGE_BPS), minAskBps · spot, maxAskBps · spot)
 * and AutoRoller.reprice when it differs from the live ask by more than PRICER_REPRICE_THRESHOLD_BPS.
 *
 * A TICK
 *   0. once per process: the deployment anchor (../anchor.ts) against the one recorded for the roller;
 *      a store written for another deployment at the same address is reset before it is read;
 *   1. head block (every time below is its timestamp, never the wall clock);
 *   2. the strategy list: the pricer's StrategySet scan ∪ the indexer's /v2/strategies?active=1
 *      (strategies.ts);
 *   3. reads pinned to that block: AccessManager.canCall(signer, roller, reprice-selector), strategy() and
 *      position() per pair; then getOrders() for the tracked asks and series() for their strike, expiry and
 *      PINNED ORACLE; then trySpot() once per (series oracle, underlying). The spot that judges an ask comes
 *      from its series' oracle, which is what `reprice` reads on chain (T-310/T-437) - never market(u).oracle;
 *   4. per pair, planner.ts planCheck (live ask, cadence, regular session, spot); only a due pair costs a /fair request;
 *   5. qualifyFair (K3-301): source-age, unknown times, optional provenance readiness/identity,
 *      oracle-vs-/fair.spot (PRICER_FAIR_SPOT_TOLERANCE_BPS); then planReprice; a reprice goes through
 *      tx.ts (in flight? → still the same ask? → simulate → send → journal → wait), keyed by the ask
 *      it replaces, with a fixed gas limit.
 *
 * WHAT COUNTS AS AN EVALUATION (the cadence clock, planner.ts evaluationDue). A decision reached with
 * a fair value: repriced (confirmed), or left alone because the target is within the threshold or the
 * band is empty. Nothing else moves the clock: a missing or unqualified fair value, a stale spot, a refused
 * simulation, a transaction that reverted or is still in flight are all retried on the next tick
 * (simulations are free; the journal stops a second copy of an unmined reprice).
 *
 * ALERTS: v2_pricer_no_role (the manager refuses the key `reprice`, by revocation or by a non-zero execution
 * delay: nothing is sent), v2_pricer_role_unread (the canCall read itself failed for ROLE_UNREAD_TICKS
 * consecutive ticks, so authority is unknown and, because `hasRole !== true` refuses every send, nothing
 * is repriced either), v2_pricer_strategy_scan (the AutoRoller StrategySet log scan threw: the list falls
 * back to what earlier scans found, so a strategy created since is priced by nobody),
 * v2_pricer_fair_unavailable
 * (no fair value for a live, due ask for PRICER_FAIR_ALERT_S), v2_pricer_reprice_failed (a due
 * reprice was refused by the simulation (warn), reverted on chain or not confirmed (error)),
 * v2_pricer_clamped (four consecutive COMPLETED EVALUATIONS landed on the minAsk/maxAsk clamp; reset by
 * any completed evaluation that did not, band-empty included, and not moved at all by a tick that reached
 * a target and then sent nothing).
 *
 * READINESS (T-423, GET /ready via main.ts). /health says the loop is alive; it cannot say the pricer can
 * price. The tick records the four facts that can: the latest canCall answer (lastRoleRead), the latest
 * qualified fair value (lastQualifiedFairAt), whether the latest tick threw (lastTickFailed) and the
 * latest completed evaluation (lastEvaluationAt); evaluatePricerReadiness judges them, fail-closed.
 *
 * WHY THREE OF THOSE ARE HERE (K8-178). Each of them was already RECORDED truthfully - in `/state`, in
 * `PricerTickReport` - and read by nobody at the moment it mattered. A failure that is honestly stored and
 * never alerted is indistinguishable, from outside, from a pricer with nothing to do. The rule this file
 * now follows: every branch that can stop a reprice either pages or is one the operator chose
 * (market-closed, not-due, in-the-money).
 */
import { getAddress, keccak256, toBytes, toFunctionSelector, type Address, type PublicClient } from 'viem';
import { accessManagerAbi } from '../abi/accessManager.js';
import { autoRollerAbi } from '../abi/autoRoller.js';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { expiryCalendarAbi } from '../abi/expiryCalendar.js';
import { orderBookAbi } from '../abi/orderBook.js';
import { settlementOracleAbi } from '../abi/settlementOracle.js';
import type { Alerter, V2AlertKind } from '../alerts.js';
import { anchorWarning, readDeploymentAnchor } from '../anchor.js';
import { readHead, type Head } from '../chain.js';
import type { PricerConfig, PricerTuning } from '../config.js';
import type { IndexerClient } from '../cranker/indexer-client.js';
import { okResult, readMany, type AnyRead } from '../cranker/reads.js';
import type { Readiness, ReadyReason } from '../health.js';
import type { Logger } from '../logger.js';
import { marketByUnderlying } from '../registry.js';
import type { V2Store } from '../store.js';
import type { TxOutcome, TxSender } from '../tx.js';
import type { FairSource } from './fair-client.js';
import { qualifyFair } from './fair-gates.js';
import { planCheck, planReprice, type AskView, type EvaluationMemory, type PositionView, type StrategyView } from './planner.js';
import { listStrategies, type LogClient, type ScanResult, type StrategyIndex, type StrategyPair } from './strategies.js';

/**
 * @deprecated INTERFACE_VERSION 8. The AutoRoller is `Managed` and has no role storage and no `hasRole`,
 * so nothing in this file reads this any more — authority is now one `AccessManager.canCall`. K8-04 has
 * since rewritten `pricer/devnet-reprice.ts`, which was the last importer, and K8-178 moved the test
 * fixture onto `canCall`, so NOTHING in the keeper package imports this today. It is kept only because
 * `V2Constants.PRICER_ROLE` is still a live id in the contracts repo; deleting it is a cleanup task, not
 * this one's.
 */
export const PRICER_ROLE = keccak256(toBytes('PRICER_ROLE'));

/**
 * The AutoRoller call the PRICER role authorises. Derived from the signature, never pasted as hex, and
 * verified byte-identical between `script/v2/roles.v8.json` (AutoRoller.reprice -> PRICER) and the
 * published `ops/abis/v2/AutoRoller.json`.
 */
export const ROLLER_REPRICE_SELECTOR = toFunctionSelector('reprice(address,address,uint128)');

/**
 * AutoRoller.reprice, fixed like every v2 keeper write (cranker/constants.ts): role and strategy
 * reads, the oracle's spot, getOrders, and OrderBook.replace of an AskWrite (~220k, V2Gas.t.sol).
 * 251,368 measured on ops/devnet (pricer/devnet-reprice.ts, NVDA through its ChainlinkFeedSource).
 * reprice has no try/catch, so an estimate would be safe too; fixed keeps every v2 write alike.
 * Unused gas is not charged.
 */
export const GAS_REPRICE = 600_000n;

const MAX_ACTIONS = 50;

/**
 * Consecutive ticks whose `AccessManager.canCall` read came back unread before the pricer pages. One
 * failed multicall is not an outage and must not wake anyone; at POLL_INTERVAL_MS's 60 s default
 * (config.ts) three in a row is three minutes in which every pair reports `role-unread` and no ask moves,
 * which is. Counted in TICKS, not in pairs: the read is one entry of the pinned multicall, made once per
 * tick for the whole roller.
 */
const ROLE_UNREAD_TICKS = 3;

/** Both mark keys fall under strategies.ts rollerMetaPrefixes, so a deployment reset clears them. */
export const evaluatedMetaKey = (roller: string, pair: StrategyPair) => `pricer:evaluated:${roller.toLowerCase()}:${pair.writer.toLowerCase()}:${pair.underlying.toLowerCase()}`;
export const fairMissingMetaKey = (roller: string, pair: StrategyPair) => `pricer:fair-missing:${roller.toLowerCase()}:${pair.writer.toLowerCase()}:${pair.underlying.toLowerCase()}`;

export type PricerClient = Pick<PublicClient, 'getBlock' | 'multicall' | 'getBlockNumber' | 'readContract'>;
export type PricerSender = Pick<TxSender, 'execute' | 'account'>;

export interface PricerContext {
  config: PricerConfig;
  log: Logger;
  client: PricerClient;
  logClient: LogClient;
  store: V2Store;
  sender: PricerSender;
  alerter: Pick<Alerter, 'alert' | 'clear'>;
  fair: FairSource;
  indexer: Pick<IndexerClient, 'activeStrategies'> | null;
  strategies: StrategyIndex;
  /** Wall clock for /state and /ready only. */
  now?: () => number;
}

/** What the tick did with one pair. */
export interface PairReport {
  writer: Address;
  underlying: Address;
  ticker: string | null;
  longId: bigint | null;
  orderId: bigint | null;
  livePrice: bigint | null;
  spot: bigint | null;
  /** planCheck's skip reason, or what happened after the fair value. */
  outcome: string;
  why?: string;
  fair?: bigint;
  fairSource?: string;
  target?: bigint;
  raw?: bigint;
  band?: { min: bigint; max: bigint };
  clamped?: 'floor' | 'ceiling' | null;
  /** Consecutive evaluations whose target sat on the minAsk/maxAsk clamp. */
  clampStreak?: number;
  nextCheckAt?: number;
  tx?: { status: TxOutcome['status']; hash?: string; gasUsed?: bigint; revert?: string | null; error?: string };
  detail?: string;
}

export interface PricerTickReport {
  head: Head;
  sessionOpen: boolean | null;
  hasRole: boolean | null;
  strategies: number;
  indexer: string;
  scan: ScanResult | { error: string };
  pairs: PairReport[];
  sent: number;
}

interface OrderStruct {
  maker: Address;
  longId: bigint;
  kind: number;
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
}

interface SeriesStruct {
  underlying: Address;
  isPut: boolean;
  expiry: number;
  strike: bigint;
  /** The oracle createSeries pinned into the series: the one it settles on and AutoRoller.reprice reads (T-310). */
  oracle: Address;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** A spot is one oracle's price for one underlying. Two series of one underlying may differ after a migration (T-437). */
const spotKey = (oracle: Address, underlying: Address): string => `${oracle.toLowerCase()}:${underlying.toLowerCase()}`;

/**
 * The latest AccessManager.canCall(signer, roller, reprice) READ: its answer, or `{ read: false }` when
 * the read itself failed. Kept apart from `hasRole` (which folds both into null) because /ready must say
 * WHICH: an unreadable manager and a revoked key have different remedies.
 */
export type RoleRead = { read: true; immediate: boolean; delay: number } | { read: false };

/** What evaluatePricerReadiness judges. Wall-clock milliseconds throughout, like /health. */
export interface PricerReadinessFacts {
  /** evaluateHealth(...).alive at the same instant: /health's own liveness rule, not a second one. */
  alive: boolean;
  /** Ticks that returned (Pricer.ticks). */
  completedTicks: number;
  lastTickFailed: boolean;
  /** Null before the first canCall read. */
  role: RoleRead | null;
  lastQualifiedFairAt: number | null;
  lastEvaluationAt: number | null;
}

/**
 * How old the latest qualified fair value may be for /ready to call the pricer ready:
 *     max(PRICER_FAIR_ALERT_S, PRICER_MIN_INTERVAL_S) + 3 × POLL_INTERVAL_MS.
 * PRICER_FAIR_ALERT_S is the operator's own threshold for "no fair value for too long" (it pages
 * v2_pricer_fair_unavailable at that age), so /ready may not claim more than the pager tolerates.
 * PRICER_MIN_INTERVAL_S is the evaluation cadence: a healthy pricer asks /fair for a pair at most once
 * per interval, so a bound below it would call a healthy pricer unready between two evaluations - the
 * max() keeps a config with FAIR_ALERT_S < MIN_INTERVAL_S from flapping. Three poll intervals is
 * /health's stale window (evaluateHealth), the slack for the tick that notices the pair is due.
 * Defaults (7,200 s, 1,800 s, 60 s): 7,380 s.
 *
 * NOT READY BY DESIGN once nothing asks /fair for longer than this: no smart-pricing strategy with a
 * live ask, or the market closed with PRICER_REPRICE_OFF_HOURS off. Ready means "can price now", and a
 * pricer that has not obtained a price in that long does not know that it can.
 */
export function fairReadyBoundMs(tuning: Pick<PricerTuning, 'fairAlertS' | 'minIntervalS'>, pollIntervalMs: number): number {
  return Math.max(tuning.fairAlertS, tuning.minIntervalS) * 1_000 + 3 * pollIntervalMs;
}

/**
 * The pricer's readiness (T-423). Ready ONLY when all four hold, each read as an explicit fact:
 *   1. the loop is alive by /health's rule                           else loop-wedged
 *   2. a tick has completed, and the latest one did not throw         else no-completed-tick / tick-failed
 *   3. the latest canCall read SUCCEEDED and answered (true, 0)       else role-unread / role-refused / role-delayed
 *   4. a qualified fair value within fairReadyBoundMs                 else fair-stale
 * Every condition names its own reason, so a condition failing alone names exactly one. `ready` is the
 * conjunction of the four, never "no reasons": a condition forgotten here would read as not ready.
 *
 * Why (2) also refuses a failed LATEST tick: runtime.ts beats after the chain probe, before the mode's
 * tick, so a pricer whose every tick throws stays alive to /health, and its last role read and fair value
 * stay whatever an earlier tick left - ready for up to the fair bound while nothing is read at all.
 */
export function evaluatePricerReadiness(facts: PricerReadinessFacts, fairBoundMs: number, now: number): Readiness {
  const reasons: ReadyReason[] = [];
  const alive = facts.alive === true;
  if (!alive) reasons.push('loop-wedged');
  const ticked = facts.completedTicks > 0;
  if (!ticked) reasons.push('no-completed-tick');
  const lastTickOk = facts.lastTickFailed === false;
  if (!lastTickOk) reasons.push('tick-failed');
  const role = facts.role;
  const may = role !== null && role.read && role.immediate === true && role.delay === 0;
  if (!may) reasons.push(role === null || !role.read || !Number.isFinite(role.delay) ? 'role-unread' : role.delay > 0 ? 'role-delayed' : 'role-refused');
  const fresh = facts.lastQualifiedFairAt !== null && now - facts.lastQualifiedFairAt <= fairBoundMs;
  if (!fresh) reasons.push('fair-stale');
  return { ready: alive && ticked && lastTickOk && may && fresh, reasons, lastEvaluationAt: facts.lastEvaluationAt };
}

const SENT_STATUSES: ReadonlySet<TxOutcome['status']> = new Set(['confirmed', 'reverted', 'unconfirmed', 'send-failed']);

export class Pricer {
  ticks = 0;
  lastTickAt: string | null = null;
  lastTickDurationMs: number | null = null;
  lastReport: PricerTickReport | null = null;
  readonly outcomes: Record<string, number> = {};
  recentActions: Array<PairReport & { at: string }> = [];
  /** /ready: the latest canCall read, null before the first. Set when read, before the tick goes on. */
  lastRoleRead: RoleRead | null = null;
  /** /ready: wall-clock ms of the latest fair value that passed qualifyFair, null before the first. */
  lastQualifiedFairAt: number | null = null;
  /** /ready: wall-clock ms of the latest completed evaluation (saveMemory), null before the first. */
  lastEvaluationAt: number | null = null;
  /** /ready: whether the latest tick threw. False before the first; `ticks === 0` answers that case. */
  lastTickFailed = false;
  /** Consecutive clamped evaluations per writer:underlying. */
  private readonly clampStreaks = new Map<string, number>();
  /** Consecutive ticks whose canCall read failed. Reset by any read that answers, true or false. */
  private roleUnreadTicks = 0;
  private readonly now: () => number;
  private anchored: Promise<void> | null = null;

  constructor(readonly ctx: PricerContext) {
    this.now = ctx.now ?? Date.now;
  }

  private get roller(): Address {
    return this.ctx.config.contracts.autoRoller;
  }

  private loadMemory(pair: StrategyPair): EvaluationMemory | null {
    const raw = this.ctx.store.getMeta(evaluatedMetaKey(this.roller, pair));
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as { longId: string; checkedAt: number };
      return { longId: BigInt(parsed.longId), checkedAt: parsed.checkedAt };
    } catch {
      return null;
    }
  }

  /** The evaluation clock's only writer (see the header), so it also stamps lastEvaluationAt for /ready. */
  private saveMemory(pair: StrategyPair, memory: EvaluationMemory): void {
    this.lastEvaluationAt = this.now();
    this.ctx.store.setMeta(evaluatedMetaKey(this.roller, pair), JSON.stringify({ longId: memory.longId.toString(), checkedAt: memory.checkedAt }));
  }

  private async alert(kind: V2AlertKind, message: string, data: Record<string, unknown>, options: { dedupeKey?: string; severity?: 'warn' | 'error' } = {}): Promise<void> {
    await this.ctx.alerter.alert(kind, message, data, options);
  }

  private pairKey(pair: StrategyPair): string {
    return `${pair.writer.toLowerCase()}:${pair.underlying.toLowerCase()}`;
  }

  /**
   * Count consecutive minAsk/maxAsk clamps; warn at 4; reset on an unclamped evaluation. Called once per
   * COMPLETED EVALUATION — repriced, within-threshold or band-empty — and never on a tick that could not
   * decide, so the number means what its name says. `entry.clamped` undefined (band-empty) counts as
   * not clamped.
   */
  private async noteClamp(pair: StrategyPair, ticker: string, entry: PairReport): Promise<void> {
    const key = this.pairKey(pair);
    const clamped = entry.clamped === 'floor' || entry.clamped === 'ceiling';
    const streak = clamped ? (this.clampStreaks.get(key) ?? 0) + 1 : 0;
    this.clampStreaks.set(key, streak);
    entry.clampStreak = streak;
    if (clamped && streak >= 4) {
      await this.alert(
        'v2_pricer_clamped',
        `pricer: ${ticker} ask for ${pair.writer} clamped to the ${entry.clamped} for ${streak} consecutive evaluations`,
        { writer: pair.writer, underlying: pair.underlying, ticker, streak, clamped: entry.clamped },
        { dedupeKey: key },
      );
    } else {
      this.ctx.alerter.clear('v2_pricer_clamped', key);
    }
  }

  /** Once per process: reset the roller's store if it describes another deployment at the same address. */
  private bindAnchor(): Promise<void> {
    this.anchored ??= (async () => {
      const anchor = await readDeploymentAnchor(this.ctx.client, this.ctx.config.registry.deployBlock);
      const recorded = this.ctx.strategies.anchor();
      const check = this.ctx.strategies.bindAnchor(anchor);
      const warning = anchorWarning(check, 'the pricer store');
      if (warning !== null) this.ctx.log.warn({ check, anchor, recorded, autoRoller: this.roller, db: this.ctx.store.path }, `${warning}${check === 'unanchored' ? '' : ' (strategies rescanned, evaluation clocks restarted, pending journal rows dropped)'}`);
      else this.ctx.log.info({ check, anchor }, 'pricer store bound to the deployment anchor');
    })().catch((error: unknown) => {
      this.anchored = null;
      throw error;
    });
    return this.anchored;
  }

  /** One tick. Records whether it threw, for /ready: a tick that threw left what it would have read unknown. */
  async tick(): Promise<PricerTickReport> {
    try {
      const report = await this.runTick();
      this.lastTickFailed = false;
      return report;
    } catch (error) {
      this.lastTickFailed = true;
      throw error;
    }
  }

  /** /ready's rule over this pricer's facts; `alive` is /health's verdict at `now` (main.ts). */
  readiness(alive: boolean, now: number): Readiness {
    const { tuning, pollIntervalMs } = this.ctx.config;
    return evaluatePricerReadiness(
      { alive, completedTicks: this.ticks, lastTickFailed: this.lastTickFailed, role: this.lastRoleRead, lastQualifiedFairAt: this.lastQualifiedFairAt, lastEvaluationAt: this.lastEvaluationAt },
      fairReadyBoundMs(tuning, pollIntervalMs),
      now,
    );
  }

  private async runTick(): Promise<PricerTickReport> {
    const started = this.now();
    const { config, client } = this.ctx;
    await this.bindAnchor();
    const roller = this.roller;
    // Required for V2_MODE=pricer (config.ts MODE_CONTRACTS): a pricer that cannot find out whether it may
    // act must refuse to start. Its failure mode otherwise is the quiet one - it reports healthy and
    // reprices nothing, for ever.
    const manager = config.contracts.accessManager;
    const tuning = config.tuning;
    const head = await readHead(client);

    const list = await listStrategies(this.ctx.strategies, this.ctx.indexer, () =>
      this.ctx.strategies.scan(this.ctx.logClient, {
        fromBlock: config.registry.deployBlock ?? 0n,
        head: head.blockNumber,
        chunkBlocks: tuning.logChunkBlocks,
        maxChunks: tuning.logChunksPerTick,
      }),
    );
    // F-CH1-04 (T-201), fixed by K8-178. strategies.ts catches a throwing getLogs and stores it as
    // `{ error }`, which is honest and reaches /state — and that was the whole of it. The list then holds
    // only what EARLIER scans found, so a strategy created since this store was last able to scan is
    // repriced by nobody, for as long as the scan keeps failing, and the sole trace is a field nobody is
    // watching at the moment it matters. Page on it. This is not fatal — known pairs are still priced —
    // so it is a warn, and it clears itself the first time a scan gets through.
    if ('error' in list.scan) {
      await this.alert(
        'v2_pricer_strategy_scan',
        `pricer: the AutoRoller StrategySet scan failed (${list.scan.error}); the strategy list is only what earlier scans found (${list.pairs.length} pair(s), indexer ${list.indexer}), so a strategy created since is not being repriced`,
        { autoRoller: roller, error: list.scan.error, indexer: list.indexer, pairs: list.pairs.length, scannedTo: this.ctx.strategies.scannedTo() },
        { severity: 'warn' },
      );
    } else {
      this.ctx.alerter.clear('v2_pricer_strategy_scan');
    }

    const pairs = list.pairs;

    const reads = await readMany(
      client,
      [
        // INTERFACE_VERSION 8: ask the manager whether this key may make THIS call right now. A `Managed`
        // target has no role storage and no hasRole at all, and canCall needs no role id — which the
        // keeper package could not obtain anyway, since ops/abis/v2/roles.json is outside its rootDir and
        // gen-abis.mjs renders only ABI modules. Never hardcode the id.
        { address: manager, abi: accessManagerAbi, functionName: 'canCall', args: [this.ctx.sender.account, roller, ROLLER_REPRICE_SELECTOR] },
        ...(!tuning.repriceOffHours ? [{ address: config.contracts.expiryCalendar, abi: expiryCalendarAbi, functionName: 'isRegularSession', args: [head.timestamp] } as AnyRead] : []),
        ...pairs.flatMap((p): AnyRead[] => [
          { address: roller, abi: autoRollerAbi, functionName: 'strategy', args: [p.writer, p.underlying] },
          { address: roller, abi: autoRollerAbi, functionName: 'position', args: [p.writer, p.underlying] },
        ]),
      ],
      head.blockNumber,
    );
    // canCall returns (bool immediate, uint32 delay). `immediate` is the question: may this key reprice
    // now, with no scheduling? A member with a non-zero execution delay answers false, correctly — the
    // pricer has no scheduling path — and the delay tells the operator WHICH failure it is.
    const canReprice = okResult<readonly [boolean, number]>(reads[0]);
    const hasRole = canReprice === undefined ? null : canReprice[0];
    const repriceDelay = canReprice === undefined ? null : Number(canReprice[1]);
    this.lastRoleRead = canReprice === undefined ? { read: false } : { read: true, immediate: canReprice[0], delay: Number(canReprice[1]) };
    const sessionOpen = tuning.repriceOffHours ? null : (okResult<boolean>(reads[1]) ?? null);
    const base = tuning.repriceOffHours ? 1 : 2;
    if (hasRole === false) {
      // Two causes, one kind. A non-zero delay means the key IS a member but every call must be scheduled
      // through the manager first, which this bot cannot do; zero means it is not a member at all, or the
      // selector is not mapped to any role on that target. The remedy differs, so the message says which.
      const why =
        repriceDelay !== null && repriceDelay > 0
          ? `is a member with a ${repriceDelay}s execution delay, so every reprice would have to be scheduled`
          : 'may not call it (not a member, or the selector is not mapped)';
      this.roleUnreadTicks = 0;
      this.ctx.alerter.clear('v2_pricer_role_unread');
      await this.alert(
        'v2_pricer_no_role',
        `pricer ${this.ctx.sender.account} ${why}: AccessManager ${manager} refuses reprice(address,address,uint128) on AutoRoller ${roller}, so no ask is repriced`,
        { signer: this.ctx.sender.account, autoRoller: roller, manager, selector: ROLLER_REPRICE_SELECTOR, immediate: false, delay: repriceDelay },
      );
    } else if (hasRole === true) {
      this.roleUnreadTicks = 0;
      this.ctx.alerter.clear('v2_pricer_no_role');
      this.ctx.alerter.clear('v2_pricer_role_unread');
    } else {
      // K8-178. The read ITSELF failed, so nothing is known about this key's authority — and the
      // `hasRole !== true` gate below then refuses every send, silently. Two rules hold here:
      //
      //   this arm must NOT clear v2_pricer_no_role. Clearing would report health about a subject that
      //   was never read, which is the same defect in a new place: an operator who had been paged by a
      //   real revocation would watch the page disappear because the manager became UNREACHABLE.
      //
      //   it must not page on the first null either. One multicall failure is a hiccup, and a pricer
      //   that pages on every hiccup is a pricer whose pages stop being read. It counts consecutive
      //   ticks instead and pages at ROLE_UNREAD_TICKS, then keeps paging (the alerter dedupes) until a
      //   read answers.
      this.roleUnreadTicks += 1;
      if (this.roleUnreadTicks >= ROLE_UNREAD_TICKS) {
        await this.alert(
          'v2_pricer_role_unread',
          `pricer: AccessManager ${manager} could not be asked whether ${this.ctx.sender.account} may call reprice(address,address,uint128) on AutoRoller ${roller} — ${this.roleUnreadTicks} consecutive ticks with an unreadable canCall, and nothing is repriced while it is unknown`,
          { signer: this.ctx.sender.account, autoRoller: roller, manager, selector: ROLLER_REPRICE_SELECTOR, unreadTicks: this.roleUnreadTicks },
          { severity: 'error' },
        );
      }
    }

    const strategies = pairs.map((_, i) => okResult<StrategyView & Record<string, unknown>>(reads[base + i * 2]));
    const positions = pairs.map((_, i) => {
      const raw = okResult<readonly [bigint, bigint, number]>(reads[base + 1 + i * 2]);
      return raw === undefined ? undefined : ({ longId: raw[0], orderId: raw[1], expiry: Number(raw[2]) } satisfies PositionView);
    });
    // Only pairs a smart-pricing strategy could reprice need the ask, the series and the spot.
    const candidates = pairs.map((p, i) => ({ p, i })).filter(({ i }) => strategies[i]?.active === true && strategies[i]?.smartPricing === true && (positions[i]?.orderId ?? 0n) !== 0n);
    const orderIds = candidates.map(({ i }) => positions[i]!.orderId);
    const longIds = [...new Set(candidates.map(({ i }) => positions[i]!.longId))];
    const second = await readMany(
      client,
      [
        ...(orderIds.length === 0 ? [] : [{ address: config.contracts.orderBook, abi: orderBookAbi, functionName: 'getOrders', args: [orderIds] } as AnyRead]),
        ...longIds.map((id): AnyRead => ({ address: config.contracts.clearinghouse, abi: clearinghouseAbi, functionName: 'series', args: [id] })),
      ],
      head.blockNumber,
    );
    const orders = orderIds.length === 0 ? [] : (okResult<readonly OrderStruct[]>(second[0]) ?? []);
    const orderOf = new Map(orderIds.map((id, k) => [id, orders[k]]));
    const seriesBase = orderIds.length === 0 ? 0 : 1;
    // A series that could not be read, or that reads back with no oracle, has no known pinned oracle: no spot is read
    // for it from any oracle, so planCheck sees a null spot and the pair is not repriced this tick.
    const seriesOf = new Map(
      longIds.map((id, k) => {
        const s = okResult<SeriesStruct>(second[seriesBase + k]);
        return [id, s === undefined || typeof s.oracle !== 'string' || s.oracle.toLowerCase() === ZERO_ADDRESS ? undefined : s] as const;
      }),
    );
    // One trySpot per (pinned oracle, underlying) some candidate is judged on, at the same pinned block. Two series
    // under one underlying can be judged on two oracles in one tick, which is the whole point of the key.
    const spotReads = [
      ...new Map(
        candidates.flatMap(({ p, i }) => {
          const s = seriesOf.get(positions[i]!.longId);
          return s === undefined ? [] : [[spotKey(s.oracle, p.underlying), { oracle: getAddress(s.oracle), underlying: p.underlying }] as const];
        }),
      ).values(),
    ];
    const third =
      spotReads.length === 0
        ? []
        : await readMany(
            client,
            spotReads.map((r): AnyRead => ({ address: r.oracle, abi: settlementOracleAbi, functionName: 'trySpot', args: [r.underlying] })),
            head.blockNumber,
          );
    const spotOf = new Map(
      spotReads.map((r, i) => {
        const res = okResult<readonly [boolean, bigint, bigint]>(third[i]);
        return [spotKey(r.oracle, r.underlying), res !== undefined && res[0] ? res[1] : null] as const;
      }),
    );

    const report: PricerTickReport = { head, sessionOpen, hasRole, strategies: pairs.length, indexer: list.indexer, scan: list.scan, pairs: [], sent: 0 };

    for (const [i, pair] of pairs.entries()) {
      const strategy = strategies[i];
      const position = positions[i];
      const ticker = marketByUnderlying(config.registry, pair.underlying)?.ticker ?? null;
      const entry: PairReport = { writer: pair.writer, underlying: pair.underlying, ticker, longId: position?.longId ?? null, orderId: position?.orderId ?? null, livePrice: null, spot: null, outcome: 'unread' };
      report.pairs.push(entry);
      if (strategy === undefined || position === undefined) {
        entry.detail = 'strategy() or position() could not be read';
        continue;
      }
      const order = orderOf.get(position.orderId);
      const ask: AskView | null =
        order === undefined || order.maker === '0x0000000000000000000000000000000000000000'
          ? null
          : { price: order.price, units: order.units, filled: order.filled, validUntil: Number(order.validUntil), cancelled: order.cancelled };
      entry.livePrice = ask?.price ?? null;

      // The series is read at the same pinned block as the ask, so `planCheck` can hold the in-the-money refusal
      // (INTERFACE_VERSION 7) before a /fair request is spent on a pair that cannot be repriced. Its PINNED oracle
      // (T-310/T-437) is the one `reprice` reads on chain and the one the series settles on, so that is where this
      // ask's spot comes from - never `market(u).oracle`, which a `setMarketOracle` moves away from every series
      // already created, leaving the mirror judging on a price the contract does not use.
      const series = seriesOf.get(position.longId);
      entry.spot = series === undefined ? null : (spotOf.get(spotKey(series.oracle, pair.underlying)) ?? null);
      const check = planCheck(
        {
          strategy,
          position,
          order: ask,
          spot: entry.spot,
          series: series === undefined ? null : { isPut: series.isPut, strike: series.strike },
          now: head.timestamp,
          sessionOpen,
          memory: this.loadMemory(pair),
        },
        { minIntervalS: tuning.minIntervalS, repriceOffHours: tuning.repriceOffHours },
      );
      if (!check.check) {
        entry.outcome = check.reason;
        if (check.reason === 'in-the-money') {
          entry.detail = `spot ${entry.spot} has reached the ${series?.strike ?? '?'} strike: reprice reverts InTheMoney; AutoRoller.cancelStale (the cranker's stale step) withdraws the ask`;
        }
        if (check.nextAt !== undefined) entry.nextCheckAt = check.nextAt;
        this.clearFairMissing(pair);
        continue;
      }
      entry.why = check.why;

      if (ticker === null || series === undefined) {
        entry.outcome = ticker === null ? 'unknown-market' : 'unread';
        entry.detail = ticker === null ? `underlying ${pair.underlying} is not in the registry: the pricing service prices by ticker` : `series(${position.longId}) could not be read`;
        continue;
      }
      const answer = await this.ctx.fair.fair({ ticker, strike: series.strike, expiry: Number(series.expiry), type: series.isPut ? 'put' : 'call' });
      const gated = qualifyFair(answer, {
        now: head.timestamp,
        maxAgeS: tuning.fairMaxAgeS,
        spotToleranceBps: tuning.fairSpotToleranceBps,
        oracleSpot: entry.spot,
        ticker,
        underlying: pair.underlying,
        strike: series.strike,
        expiry: Number(series.expiry),
        type: series.isPut ? 'put' : 'call',
        uiMultiplier: null,
      });
      if (!gated.ok) {
        entry.outcome = gated.reason;
        entry.detail = gated.detail;
        await this.noteFairMissing(pair, ticker, head.timestamp, gated.detail);
        continue;
      }
      this.clearFairMissing(pair);
      this.lastQualifiedFairAt = this.now();
      entry.fair = gated.fair;
      entry.fairSource = gated.source;

      const plan = planReprice({ fair: gated.fair, spot: check.spot, livePrice: check.order.price, strategy, edgeBps: tuning.edgeBps, thresholdBps: tuning.repriceThresholdBps });
      if (!plan.reprice) {
        entry.outcome = plan.reason;
        if (plan.reason === 'within-threshold') {
          Object.assign(entry, { target: plan.target.price, raw: plan.target.raw, band: plan.target.band, clamped: plan.target.clamped });
        }
        // K8-178. Both arms are completed evaluations by this file's own definition (see the header:
        // "left alone because the target is within the threshold OR THE BAND IS EMPTY"), and both save the
        // memory below, so both must move the streak. `band-empty` leaves entry.clamped undefined, which
        // noteClamp reads as not-clamped and resets on — correctly: an empty band is the absence of a
        // target, not a target sitting on the clamp. Before this, band-empty skipped noteClamp entirely,
        // so a pair alternating clamp / band-empty / clamp / band-empty reached streak 4 and paged
        // "clamped ... for 4 consecutive evaluations" about four clamps that were not consecutive.
        await this.noteClamp(pair, ticker, entry);
        this.saveMemory(pair, { longId: position.longId, checkedAt: head.timestamp });
        entry.nextCheckAt = head.timestamp + tuning.minIntervalS;
        continue;
      }
      Object.assign(entry, { target: plan.price, raw: plan.target.raw, band: plan.target.band, clamped: plan.target.clamped });
      // K8-178. noteClamp is NOT called here. This point is reached on every tick that got as far as a
      // target, including ones that then send nothing - no-role, role-unread, tick-budget - and none of
      // those move the evaluation clock, so the same pair arrives here again on the very next tick. The
      // streak counted TICKS on those paths: at the 60 s POLL_INTERVAL_MS default a role outage reached
      // four in four minutes and paged v2_pricer_clamped, sending the operator after a clamp while the
      // actual fault was the manager. It is called below, where the clock moves.
      if (hasRole !== true) {
        entry.outcome = hasRole === false ? 'no-role' : 'role-unread';
        continue;
      }
      if (report.sent >= tuning.maxTxPerTick) {
        entry.outcome = 'tick-budget';
        continue;
      }

      const orderId = position.orderId;
      const outcome = await this.ctx.sender.execute(
        { address: roller, abi: autoRollerAbi, functionName: 'reprice', args: [pair.writer, pair.underlying, plan.price], gas: GAS_REPRICE },
        {
          kind: 'reprice',
          key: `${pair.writer.toLowerCase()}:${pair.underlying.toLowerCase()}:${orderId}`,
          // Another reprice or a roll replaced the ask since the pinned read: this plan is for an ask that is gone.
          isAdvanced: async () => {
            const [, current] = await client.readContract({ address: roller, abi: autoRollerAbi, functionName: 'position', args: [pair.writer, pair.underlying] });
            return current !== orderId;
          },
        },
      );
      if (SENT_STATUSES.has(outcome.status)) report.sent += 1;
      entry.tx = { status: outcome.status };
      if ('hash' in outcome) entry.tx.hash = outcome.hash;
      if ('gasUsed' in outcome) entry.tx.gasUsed = outcome.gasUsed;
      if (outcome.status === 'simulation-reverted') Object.assign(entry.tx, { revert: outcome.revert, error: outcome.error.slice(0, 300) });
      if (outcome.status === 'send-failed' || outcome.status === 'unconfirmed') entry.tx.error = outcome.error.slice(0, 300);

      const dedupeKey = `${pair.writer.toLowerCase()}:${pair.underlying.toLowerCase()}`;
      switch (outcome.status) {
        case 'confirmed':
          entry.outcome = 'repriced';
          await this.noteClamp(pair, ticker, entry);
          this.saveMemory(pair, { longId: position.longId, checkedAt: head.timestamp });
          entry.nextCheckAt = head.timestamp + tuning.minIntervalS;
          this.ctx.alerter.clear('v2_pricer_reprice_failed', dedupeKey);
          break;
        case 'already-advanced':
        case 'in-flight':
          entry.outcome = outcome.status;
          break;
        // The spot reached the strike between the pinned read and the simulation (INTERFACE_VERSION 7): the ask is
        // withdrawn by cancelStale, not repriced. Expected, so no page and no retry loop — the clock does not move,
        // and the next tick holds `in-the-money` in planCheck instead of simulating again.
        case 'simulation-reverted':
          if (outcome.revert === 'InTheMoney') {
            entry.outcome = 'in-the-money';
            entry.detail = 'the spot reached the strike between the read and the simulation: reprice refuses, cancelStale withdraws the ask';
            break;
          }
        // falls through
        default: {
          entry.outcome = 'reprice-failed';
          const onChain = outcome.status === 'reverted' || outcome.status === 'unconfirmed';
          const what = outcome.status === 'simulation-reverted' ? `simulation reverted (${outcome.revert ?? outcome.error.slice(0, 120)})` : outcome.status === 'reverted' ? 'reverted on chain' : outcome.status === 'unconfirmed' ? 'not confirmed in time' : `send failed (${'error' in outcome ? outcome.error.slice(0, 120) : outcome.status})`;
          await this.alert(
            'v2_pricer_reprice_failed',
            `pricer: reprice of ${ticker} ask ${orderId} for ${pair.writer} to ${plan.price}: ${what}`,
            { writer: pair.writer, underlying: pair.underlying, orderId, price: plan.price, status: outcome.status, ...('hash' in outcome ? { hash: outcome.hash } : {}) },
            { dedupeKey, severity: onChain ? 'error' : 'warn' },
          );
        }
      }
    }

    for (const p of report.pairs) this.outcomes[p.outcome] = (this.outcomes[p.outcome] ?? 0) + 1;
    const at = new Date(this.now()).toISOString();
    for (const p of report.pairs) if (p.tx !== undefined) this.recentActions.push({ ...p, at });
    this.recentActions = this.recentActions.slice(-MAX_ACTIONS);
    for (const p of report.pairs) {
      if (p.tx !== undefined || p.outcome === 'fair-unavailable' || p.outcome === 'fair-stale' || p.outcome === 'fair-spot-mismatch' || p.outcome === 'asOf-unknown' || p.outcome === 'quote-stale' || p.outcome === 'quote-age-unknown' || p.outcome === 'not-ready' || p.outcome === 'identity-mismatch' || p.outcome === 'within-threshold') {
        this.ctx.log.info({ writer: p.writer, ticker: p.ticker, orderId: p.orderId, live: p.livePrice, target: p.target, fair: p.fair, outcome: p.outcome, tx: p.tx, detail: p.detail }, `pricer ${p.outcome}`);
      }
    }
    this.ticks += 1;
    this.lastTickAt = at;
    this.lastTickDurationMs = this.now() - started;
    this.lastReport = report;
    return report;
  }

  private clearFairMissing(pair: StrategyPair): void {
    const key = fairMissingMetaKey(this.roller, pair);
    if (this.ctx.store.getMeta(key) !== null) this.ctx.store.db.prepare('DELETE FROM v2_meta WHERE key = ?').run(key);
    this.ctx.alerter.clear('v2_pricer_fair_unavailable', `${pair.writer.toLowerCase()}:${pair.underlying.toLowerCase()}`);
  }

  private async noteFairMissing(pair: StrategyPair, ticker: string, now: number, reason: string): Promise<void> {
    const key = fairMissingMetaKey(this.roller, pair);
    const raw = this.ctx.store.getMeta(key);
    const since = raw === null ? now : Number(raw);
    if (raw === null) this.ctx.store.setMeta(key, String(now));
    if (now - since >= this.ctx.config.tuning.fairAlertS) {
      await this.alert(
        'v2_pricer_fair_unavailable',
        `pricer: no fair value for ${ticker} (writer ${pair.writer}) for ${now - since} s: ${reason}`,
        { writer: pair.writer, underlying: pair.underlying, ticker, since, reason },
        { dedupeKey: `${pair.writer.toLowerCase()}:${pair.underlying.toLowerCase()}` },
      );
    }
  }

  /** The /state body. */
  state(): unknown {
    const r = this.lastReport;
    return {
      mode: 'pricer',
      signer: this.ctx.sender.account,
      autoRoller: this.roller,
      pricing: new URL(this.ctx.config.pricingUrl).origin,
      indexer: this.ctx.config.indexerUrl === null ? null : new URL(this.ctx.config.indexerUrl).origin,
      settings: this.ctx.config.tuning,
      ticks: this.ticks,
      lastTickAt: this.lastTickAt,
      lastTickDurationMs: this.lastTickDurationMs,
      head: r?.head ?? null,
      sessionOpen: r?.sessionOpen ?? null,
      hasRole: r?.hasRole ?? null,
      strategies: r?.strategies ?? 0,
      indexerStatus: r?.indexer ?? null,
      scan: r?.scan ?? null,
      scannedTo: this.ctx.strategies.scannedTo(),
      pairs: r?.pairs ?? [],
      clampStreaks: Object.fromEntries(this.clampStreaks),
      outcomes: this.outcomes,
      recentActions: this.recentActions,
      recentTxs: this.ctx.store.recentTxs(20),
    };
  }
}
