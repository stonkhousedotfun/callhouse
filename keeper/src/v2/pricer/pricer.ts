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
 *   3. one pinned multicall: hasRole(PRICER_ROLE, signer), strategy() and position() per pair,
 *      market() per underlying; then trySpot() per underlying from the market's oracle, getOrders()
 *      for the tracked asks and series() for their strike and expiry;
 *   4. per pair, planner.ts planCheck (live ask, cadence, spot); only a due pair costs a /fair request;
 *   5. planReprice; a reprice goes through tx.ts (in flight? → still the same ask? → simulate → send →
 *      journal → wait), keyed by the ask it replaces, with a fixed gas limit.
 *
 * WHAT COUNTS AS AN EVALUATION (the cadence clock, planner.ts evaluationDue). A decision reached with
 * a fair value: repriced (confirmed), or left alone because the target is within the threshold or the
 * band is empty. Nothing else moves the clock: a missing fair value, a stale spot, a refused
 * simulation, a transaction that reverted or is still in flight are all retried on the next tick
 * (simulations are free; the journal stops a second copy of an unmined reprice).
 *
 * ALERTS: v2_pricer_no_role (the key lost PRICER_ROLE: nothing is sent), v2_pricer_fair_unavailable
 * (no fair value for a live, due ask for PRICER_FAIR_ALERT_S), v2_pricer_reprice_failed (a due
 * reprice was refused by the simulation (warn), reverted on chain or not confirmed (error)).
 */
import { keccak256, toBytes, type Address, type PublicClient } from 'viem';
import { autoRollerAbi } from '../abi/autoRoller.js';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { orderBookAbi } from '../abi/orderBook.js';
import { settlementOracleAbi } from '../abi/settlementOracle.js';
import type { Alerter, V2AlertKind } from '../alerts.js';
import { anchorWarning, readDeploymentAnchor } from '../anchor.js';
import { readHead, type Head } from '../chain.js';
import type { PricerConfig } from '../config.js';
import type { IndexerClient } from '../cranker/indexer-client.js';
import { okResult, readMany, type AnyRead } from '../cranker/reads.js';
import type { Logger } from '../logger.js';
import { marketByUnderlying } from '../registry.js';
import type { V2Store } from '../store.js';
import type { TxOutcome, TxSender } from '../tx.js';
import type { FairSource } from './fair-client.js';
import { planCheck, planReprice, type AskView, type EvaluationMemory, type PositionView, type StrategyView } from './planner.js';
import { listStrategies, type LogClient, type ScanResult, type StrategyIndex, type StrategyPair } from './strategies.js';

/** V2Constants.PRICER_ROLE. */
export const PRICER_ROLE = keccak256(toBytes('PRICER_ROLE'));

/**
 * AutoRoller.reprice, fixed like every v2 keeper write (cranker/constants.ts): role and strategy
 * reads, the oracle's spot, getOrders, and OrderBook.replace of an AskWrite (~220k, V2Gas.t.sol).
 * 251,368 measured on ops/devnet (pricer/devnet-reprice.ts, NVDA through its ChainlinkFeedSource).
 * reprice has no try/catch, so an estimate would be safe too; fixed keeps every v2 write alike.
 * Unused gas is not charged.
 */
export const GAS_REPRICE = 600_000n;

const MAX_ACTIONS = 50;

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
  /** Wall clock for /state only. */
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
  nextCheckAt?: number;
  tx?: { status: TxOutcome['status']; hash?: string; gasUsed?: bigint; revert?: string | null; error?: string };
  detail?: string;
}

export interface PricerTickReport {
  head: Head;
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
}

const SENT_STATUSES: ReadonlySet<TxOutcome['status']> = new Set(['confirmed', 'reverted', 'unconfirmed', 'send-failed']);

export class Pricer {
  ticks = 0;
  lastTickAt: string | null = null;
  lastTickDurationMs: number | null = null;
  lastReport: PricerTickReport | null = null;
  readonly outcomes: Record<string, number> = {};
  recentActions: Array<PairReport & { at: string }> = [];
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

  private saveMemory(pair: StrategyPair, memory: EvaluationMemory): void {
    this.ctx.store.setMeta(evaluatedMetaKey(this.roller, pair), JSON.stringify({ longId: memory.longId.toString(), checkedAt: memory.checkedAt }));
  }

  private async alert(kind: V2AlertKind, message: string, data: Record<string, unknown>, options: { dedupeKey?: string; severity?: 'warn' | 'error' } = {}): Promise<void> {
    await this.ctx.alerter.alert(kind, message, data, options);
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

  async tick(): Promise<PricerTickReport> {
    const started = this.now();
    const { config, client } = this.ctx;
    await this.bindAnchor();
    const roller = this.roller;
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
    const pairs = list.pairs;
    const underlyings = [...new Set(pairs.map((p) => p.underlying))];

    const reads = await readMany(
      client,
      [
        { address: roller, abi: autoRollerAbi, functionName: 'hasRole', args: [PRICER_ROLE, this.ctx.sender.account] },
        ...pairs.flatMap((p): AnyRead[] => [
          { address: roller, abi: autoRollerAbi, functionName: 'strategy', args: [p.writer, p.underlying] },
          { address: roller, abi: autoRollerAbi, functionName: 'position', args: [p.writer, p.underlying] },
        ]),
        ...underlyings.map((u): AnyRead => ({ address: config.contracts.clearinghouse, abi: clearinghouseAbi, functionName: 'market', args: [u] })),
      ],
      head.blockNumber,
    );
    const hasRole = okResult<boolean>(reads[0]) ?? null;
    if (hasRole === false) {
      await this.alert('v2_pricer_no_role', `pricer ${this.ctx.sender.account} does not hold PRICER_ROLE on AutoRoller ${roller}: no ask is repriced`, { signer: this.ctx.sender.account, autoRoller: roller });
    } else if (hasRole === true) {
      this.ctx.alerter.clear('v2_pricer_no_role');
    }

    const strategies = pairs.map((_, i) => okResult<StrategyView & Record<string, unknown>>(reads[1 + i * 2]));
    const positions = pairs.map((_, i) => {
      const raw = okResult<readonly [bigint, bigint, number]>(reads[2 + i * 2]);
      return raw === undefined ? undefined : ({ longId: raw[0], orderId: raw[1], expiry: Number(raw[2]) } satisfies PositionView);
    });
    const oracleOf = new Map(underlyings.map((u, i) => [u, okResult<{ oracle: Address }>(reads[1 + pairs.length * 2 + i])?.oracle ?? config.contracts.settlementOracle]));

    // Only pairs a smart-pricing strategy could reprice need the ask, the series and the spot.
    const candidates = pairs.map((p, i) => ({ p, i })).filter(({ i }) => strategies[i]?.active === true && strategies[i]?.smartPricing === true && (positions[i]?.orderId ?? 0n) !== 0n);
    const spotUnderlyings = [...new Set(candidates.map(({ p }) => p.underlying))];
    const orderIds = candidates.map(({ i }) => positions[i]!.orderId);
    const longIds = [...new Set(candidates.map(({ i }) => positions[i]!.longId))];
    const second = await readMany(
      client,
      [
        ...spotUnderlyings.map((u): AnyRead => ({ address: oracleOf.get(u)!, abi: settlementOracleAbi, functionName: 'trySpot', args: [u] })),
        ...(orderIds.length === 0 ? [] : [{ address: config.contracts.orderBook, abi: orderBookAbi, functionName: 'getOrders', args: [orderIds] } as AnyRead]),
        ...longIds.map((id): AnyRead => ({ address: config.contracts.clearinghouse, abi: clearinghouseAbi, functionName: 'series', args: [id] })),
      ],
      head.blockNumber,
    );
    const spotOf = new Map(
      spotUnderlyings.map((u, i) => {
        const r = okResult<readonly [boolean, bigint, bigint]>(second[i]);
        return [u, r !== undefined && r[0] ? r[1] : null] as const;
      }),
    );
    const orders = orderIds.length === 0 ? [] : (okResult<readonly OrderStruct[]>(second[spotUnderlyings.length]) ?? []);
    const orderOf = new Map(orderIds.map((id, k) => [id, orders[k]]));
    const seriesBase = spotUnderlyings.length + (orderIds.length === 0 ? 0 : 1);
    const seriesOf = new Map(longIds.map((id, k) => [id, okResult<SeriesStruct>(second[seriesBase + k])]));

    const report: PricerTickReport = { head, hasRole, strategies: pairs.length, indexer: list.indexer, scan: list.scan, pairs: [], sent: 0 };

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
      entry.spot = spotOf.get(pair.underlying) ?? null;

      // The series is read in the same pinned multicall as the ask and the spot, so `planCheck` can hold the
      // in-the-money refusal (INTERFACE_VERSION 7) before a /fair request is spent on a pair that cannot be repriced.
      const series = seriesOf.get(position.longId);
      const check = planCheck(
        {
          strategy,
          position,
          order: ask,
          spot: entry.spot,
          series: series === undefined ? null : { isPut: series.isPut, strike: series.strike },
          now: head.timestamp,
          memory: this.loadMemory(pair),
        },
        { minIntervalS: tuning.minIntervalS },
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
      if (!answer.ok) {
        entry.outcome = 'fair-unavailable';
        entry.detail = answer.reason;
        await this.noteFairMissing(pair, ticker, head.timestamp, answer.reason);
        continue;
      }
      this.clearFairMissing(pair);
      entry.fair = answer.fair;
      entry.fairSource = answer.source;

      const plan = planReprice({ fair: answer.fair, spot: check.spot, livePrice: check.order.price, strategy, edgeBps: tuning.edgeBps, thresholdBps: tuning.repriceThresholdBps });
      if (!plan.reprice) {
        entry.outcome = plan.reason;
        if (plan.reason === 'within-threshold') Object.assign(entry, { target: plan.target.price, raw: plan.target.raw, band: plan.target.band, clamped: plan.target.clamped });
        this.saveMemory(pair, { longId: position.longId, checkedAt: head.timestamp });
        entry.nextCheckAt = head.timestamp + tuning.minIntervalS;
        continue;
      }
      Object.assign(entry, { target: plan.price, raw: plan.target.raw, band: plan.target.band, clamped: plan.target.clamped });
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
      if (p.tx !== undefined || p.outcome === 'fair-unavailable' || p.outcome === 'within-threshold') {
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
      hasRole: r?.hasRole ?? null,
      strategies: r?.strategies ?? 0,
      indexerStatus: r?.indexer ?? null,
      scan: r?.scan ?? null,
      scannedTo: this.ctx.strategies.scannedTo(),
      pairs: r?.pairs ?? [],
      outcomes: this.outcomes,
      recentActions: this.recentActions,
      recentTxs: this.ctx.store.recentTxs(20),
    };
  }
}
