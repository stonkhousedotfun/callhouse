/**
 * The MM bot's tick and its kill switch: reads the chain and the pricing service into a planner.TickInput, plans,
 * sends through tx.ts (simulate → send → journal → wait, one at a time, fixed gas), raises alerts and keeps /state.
 *
 * ONE TICK
 *   0. once per process: the deployment anchor (../anchor.ts) checked against the store's, which resets a store written
 *      for another deployment at the same addresses before anything is read from it
 *   1. head block (every decision uses its timestamp); the vault must belong to the configured order book
 *   2. series index: Clearinghouse SeriesCreated logs (series-index.ts)
 *   3. vault state, the calendar session, fees
 *   4. vault orders: new ids from OrderBook.ordersOfMaker(vault) ingested; every open one re-read, a grown `filled` is
 *      a fill written to the realised-PnL ledger in the same SQLite transaction as the new `filled`, a sale at the
 *      seller fee its OrderFilled logs show (fills.ts: not the fees in effect at the head, which a scheduled change
 *      may have moved since the fill)
 *   5. settlements of the ledger's open positions → the day's realised result → the loss stop
 *   6. the quoted markets (MM_MARKETS, else every live v2 market): config, spot, free collateral, wallet tokens
 *   7. the managed series (managedSeries): the selection (nearest the money, MM_MAX_SERIES) plus every series with a
 *      vault order or tracked exposure on any market (outside the quoted set: pull-only); their vault guards, exposure,
 *      collateral, oracle spot
 *   8. /fair for the series that need it (planner.fairRequests), MM_PRICING_TIMEOUT_MS each, never throwing
 *   9. planner.planTick → at most MM_MAX_TX_PER_TICK transactions, cancels first; a kill that lands mid-tick stops
 *      everything but cancels
 *  10. alerts, /state
 *
 * KILL (POST /kill, routes.ts): the killed state is written to v2_meta first (a restart stays killed), `v2_mm_killed`
 * pages, then every vault order with units left is cancelled: live ones and expired ones that still hold escrow
 * (engine.isKillTarget), on every market, whoever placed them through the vault. Passes repeat until a re-read finds
 * none (a place the tick had already queued lands before the kill's cancel, which the sender serialises behind it). The
 * answer is done only when that same re-read finds none: an expired Bid or AskResale whose cancel keeps failing is
 * still escrow on the book, so it is reported as remaining (202) with its id. Every later tick plans nothing but
 * cancels, expired escrowed orders included, until POST /resume.
 */
import { getAddress, zeroAddress, type Address, type PublicClient } from 'viem';
import { anchorWarning, readDeploymentAnchor } from '../anchor.js';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { makerVaultAbi } from '../abi/makerVault.js';
import { orderBookAbi } from '../abi/orderBook.js';
import { FAILED_DELIVERY_RETRY_MS, type Alerter } from '../alerts.js';
import { readHead, type Head } from '../chain.js';
import type { MmConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { marketByUnderlying, v2Markets, type V2Market } from '../registry.js';
import type { V2Store } from '../store.js';
import { describeError, type TxOutcome, type TxSender } from '../tx.js';
import { CANCEL_CHUNK, KILL_RESPONSE_WAIT_MS, MM_GAS } from './constants.js';
import { isKillTarget, selectSeries, type FairInput, type LiveOrder, type SeriesInfo } from './engine.js';
import { MM_META, MmStore } from './mm-store.js';
import { trackVaultOrders, type FillRecord, type TrackResult } from './fills.js';
import { lossStop, replayLedger, type LossStop } from './pnl.js';
import { foreignSpend, project, type Projection } from './outflow.js';
import { bookedCalls, fairRequests, planTick, twoSidedCount, type MmPlanParams, type MmTx, type SeriesView, type TickInput, type TickPlan } from './planner.js';
import type { PricingClient } from './pricing-client.js';
import {
  readMakerOrderIds,
  readMarkets,
  readMeasuredNotional,
  readOrders,
  readSeriesViews,
  readSettlements,
  readVaultState,
  type ChainOrder,
  type MmAddresses,
  type VaultState,
} from './reads.js';
import type { KillOutcome, KillSwitch } from './routes.js';
import { scanSeries } from './series-index.js';

const lc = (a: string): string => a.toLowerCase();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface MmBotContext {
  config: MmConfig;
  log: Logger;
  client: PublicClient;
  logClient: PublicClient;
  sender: Pick<TxSender, 'execute'>;
  alerter: Pick<Alerter, 'alert' | 'clear'>;
  store: V2Store;
  pricing: Pick<PricingClient, 'fairMany'>;
  signer: Address;
  /** Wall clock (ms), for /state timings and the kill record only. */
  now?: () => number;
  /** How long POST /kill waits for its cancels before answering 202. */
  killWaitMs?: number;
  /** The pause between the kill's cancel passes after the first (default 1 s). */
  killRetryMs?: number;
}

export interface TxRecord {
  type: MmTx['type'];
  what: string;
  status: TxOutcome['status'];
  hash?: string;
  revert?: string | null;
  error?: string;
  gasUsed?: bigint;
  /** Set when the revert was the vault's outflow cap (INTERFACE_VERSION 7, c21). */
  outflow?: OutflowRefusal;
}

export type { FillRecord } from './fills.js';

/** A vault call the outflow cap refused (`OutflowCapExceeded(available, outflow)`), decoded. */
export interface OutflowRefusal {
  what: string;
  available: bigint | null;
  wanted: bigint | null;
}

interface LastTick {
  head: Head;
  vault: VaultState;
  input: TickInput;
  plan: TickPlan;
  stop: LossStop;
  txs: TxRecord[];
  /** USDG the chain says left the vault that this bot did not send (outflow.foreignSpend), or null. */
  foreignOutflow: bigint | null;
  /** Vault calls the cap refused this tick: after the first, no further bid grows (the cap is shared). */
  outflowRefused: OutflowRefusal[];
  pricing: { requested: number; failed: number; reasons: Record<string, number> };
  scan: { scannedTo: bigint | null; created: number; caughtUp: boolean };
  startedAt: number;
  durationMs: number;
}

export function mmPlanParams(config: MmConfig): MmPlanParams {
  const t = config.tuning;
  return {
    halfSpreadBps: t.halfSpreadBps,
    minHalfSpreadUsdg6: t.minHalfSpreadUsdg6,
    expiryWidenS: t.expiryWidenS,
    expiryWidenBps: t.expiryWidenBps,
    pullMinutes: t.pullMinutes,
    quoteOffHours: t.quoteOffHours,
    fairMaxAgeS: t.fairMaxAgeS,
    fairMaxAgeOffHoursS: t.fairMaxAgeOffHoursS,
    skewBpsPerDeltaShare: t.skewBpsPerDeltaShare,
    maxSkewBps: t.maxSkewBps,
    requoteBps: t.requoteBps,
    resizeBps: t.resizeBps,
    maxSeries: t.maxSeries,
    maxSeriesPerMarket: t.maxSeriesPerMarket,
    bidUnits: t.bidUnits,
    askUnits: t.askUnits,
    maxSeriesUnits: t.maxSeriesUnits,
    maxTotalNotionalUsdg6: t.maxTotalNotionalUsdg6,
    deltaAlertShares: t.deltaAlertShares,
    syncIntervalS: t.syncIntervalS,
    depositTokens: t.depositTokens,
    maxQuoteLifetimeS: t.maxQuoteLifetimeS,
    fairSpotToleranceBps: t.fairSpotToleranceBps,
  };
}

/**
 * The series a tick manages: the selection, plus every series with a vault order or tracked exposure that is not expired
 * or still has an order with units left, ON ANY MARKET. A market outside the quoted set (paused in the registry, dropped
 * from MM_MARKETS) is managed pull-only (planner: halt market-not-quoted): its live quotes are cancelled, its expired
 * escrow reclaimed, its inventory counted for a delta, instead of being left fillable at stale prices until validUntil.
 */
export function managedSeries(input: {
  now: number;
  picked: readonly SeriesInfo[];
  /** Series info of every series with a vault order or tracked exposure, by decimal longId. */
  extra: ReadonlyMap<string, SeriesInfo>;
  ordersBySeries: ReadonlyMap<string, readonly LiveOrder[]>;
}): Map<string, SeriesInfo> {
  const managed = new Map(input.picked.map((s) => [s.longId.toString(), s]));
  for (const [id, info] of input.extra) {
    const hasOrders = (input.ordersBySeries.get(id) ?? []).some((o) => !o.cancelled && o.filled < o.units);
    if (info.expiry > input.now || hasOrders) managed.set(id, info);
  }
  return managed;
}

/** The markets the bot quotes: MM_MARKETS (any status), else every live v2 market. */
export function quotedMarkets(config: Pick<MmConfig, 'registry' | 'tuning'>): V2Market[] {
  const tickers = config.tuning.markets;
  if (tickers === null) return v2Markets(config.registry, ['live']);
  return v2Markets(config.registry, ['live', 'paused', 'planned']).filter((m) => tickers.includes(m.ticker));
}

export class MmBot implements KillSwitch {
  readonly mm: MmStore;
  private addresses: MmAddresses | null = null;
  private calendar: Address | null;
  private wakeLoop: (() => void) | null = null;
  private last: LastTick | null = null;
  private ticks = 0;
  private recentFills: FillRecord[] = [];
  private lastSales: TrackResult['sales'] | null = null;
  private killRun: Promise<{ cancelled: number; remaining: number; remainingOrderIds: bigint[]; errors: string[] }> | null = null;
  private anchored: Promise<void> | null = null;
  private lastKill: KillOutcome | null = null;
  /** Wall clock of the last v2_mm_loss_stop delivery that failed. */
  private lossStopFailedAt: number | null = null;
  private readonly wall: () => number;
  private readonly params: MmPlanParams;

  constructor(readonly ctx: MmBotContext) {
    this.wall = ctx.now ?? Date.now;
    this.params = mmPlanParams(ctx.config);
    this.calendar = ctx.config.contracts.expiryCalendar;
    this.mm = new MmStore(ctx.store);
    const wiped = this.mm.bind({ chainId: ctx.config.chainId, clearinghouse: ctx.config.contracts.clearinghouse, orderBook: ctx.config.contracts.orderBook, vault: ctx.config.contracts.makerVault });
    if (wiped) ctx.log.warn({}, 'the MM store described another deployment; it was cleared (series rescanned, vault orders adopted afresh)');
    const killed = this.mm.killed();
    if (killed !== null) ctx.log.warn({ killedAt: killed.at, reason: killed.reason }, 'the kill switch is engaged: nothing is quoted until POST /resume');
  }

  bindLoop(loop: { wake(): void }): void {
    this.wakeLoop = () => loop.wake();
  }

  /*------------------------------- setup ------------------------------*/

  /** Once per process, before the store is read: reset it if it describes another deployment at these addresses. */
  private bindAnchor(): Promise<void> {
    this.anchored ??= (async () => {
      const anchor = await readDeploymentAnchor(this.ctx.client, this.ctx.config.registry.deployBlock);
      const recorded = this.mm.anchor();
      const check = this.mm.bindAnchor(anchor);
      const warning = anchorWarning(check, 'the MM store');
      if (warning !== null) this.ctx.log.warn({ check, anchor, recorded, db: this.ctx.store.path }, `${warning}${check === 'unanchored' ? '' : ' (series rescanned, vault orders adopted afresh, pending journal rows dropped; the kill switch is kept)'}`);
      else this.ctx.log.info({ check, anchor }, 'MM store bound to the deployment anchor');
    })().catch((error: unknown) => {
      this.anchored = null;
      throw error;
    });
    return this.anchored;
  }

  private async resolveAddresses(blockNumber: bigint): Promise<MmAddresses> {
    if (this.addresses !== null) return this.addresses;
    const { client, config } = this.ctx;
    const { clearinghouse, orderBook, makerVault } = config.contracts;
    const vaultBook = await client.readContract({ address: makerVault, abi: makerVaultAbi, functionName: 'orderBook', blockNumber });
    if (lc(vaultBook) !== lc(orderBook)) {
      throw new Error(`MAKER_VAULT ${makerVault} quotes on order book ${vaultBook}, not the configured ${orderBook}: refusing to quote`);
    }
    const usdg = config.registry.usdg ?? (await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: 'usdg', blockNumber }));
    this.calendar ??= await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: 'calendar', blockNumber });
    this.addresses = { clearinghouse, orderBook, vault: makerVault, usdg: getAddress(usdg) };
    return this.addresses;
  }

  /*------------------------------- orders -----------------------------*/

  /** Vault orders placed since the last ingestion into the store (all of them, adopted, the first time). */
  private async ingestOrders(a: MmAddresses, count: bigint, head: Head): Promise<number> {
    const index = this.mm.makerIndex();
    const from = index ?? 0n;
    if (count <= from) {
      if (index === null) this.mm.ingestOrders([], count, this.wall());
      return 0;
    }
    const ids = await readMakerOrderIds(this.ctx.client, a.orderBook, a.vault, from, count, head.blockNumber);
    const orders = await readOrders(this.ctx.client, a.orderBook, ids, head.blockNumber);
    const adopt = index === null;
    this.mm.ingestOrders(
      orders.map((o) => ({ order: { orderId: o.id, longId: o.longId, kind: o.kind, price: o.price, units: o.units, filledSeen: adopt ? o.filled : 0n }, closed: false })),
      from + BigInt(ids.length),
      this.wall(),
    );
    if (adopt && orders.length > 0) this.ctx.log.info({ orders: orders.length }, 'adopted the vault\'s existing orders at their current fills');
    return orders.length;
  }

  /**
   * Re-read every open vault order; record fills (each sale at the seller fee its OrderFilled logs show, fills.ts) and
   * closes. Returns the chain state of those orders.
   */
  private async trackOrders(a: MmAddresses, fees: VaultState['fees'], head: Head): Promise<ChainOrder[]> {
    const tracked = await trackVaultOrders(
      { client: this.ctx.client, logClient: this.ctx.logClient, mm: this.mm, log: this.ctx.log, orderBook: a.orderBook, vault: a.vault, deployBlock: this.ctx.config.registry.deployBlock ?? 0n },
      fees,
      head,
    );
    if (tracked.fills.length > 0) this.recentFills = [...tracked.fills.reverse(), ...this.recentFills].slice(0, 50);
    this.lastSales = tracked.sales;
    return tracked.chain;
  }

  /** Settlements of open ledger positions, then the loss stop for the head's day. */
  private async ledgerStop(a: MmAddresses, head: Head): Promise<LossStop> {
    let ledger = replayLedger(this.mm.ledger());
    const open = [...ledger.positions].filter(([, p]) => p.units !== 0n).map(([id]) => BigInt(id));
    if (open.length > 0) {
      const infos = this.mm.seriesByIds(open);
      const expired = open.filter((id) => {
        const info = infos.get(id.toString());
        return info !== undefined && info.expiry <= head.timestamp && !this.mm.hasSettlement(id);
      });
      if (expired.length > 0) {
        const settlements = await readSettlements(this.ctx.client, a.clearinghouse, expired, head.blockNumber);
        let recorded = 0;
        for (const id of expired) {
          const s = settlements.get(id.toString());
          if (s === undefined || !s.settled) continue;
          this.mm.recordSettlement({ type: 'settle', longId: id.toString(), isPut: s.isPut, strike: s.strike, settlementPrice: s.settlementPrice, exerciseFeeBps: s.exerciseFeeBps, at: head.timestamp });
          recorded += 1;
        }
        if (recorded > 0) ledger = replayLedger(this.mm.ledger());
      }
    }
    return lossStop(ledger, head.timestamp, this.ctx.config.tuning.dailyLossLimitUsdg6);
  }

  /*-------------------------------- tick ------------------------------*/

  async tick(): Promise<TickPlan> {
    const startedAt = this.wall();
    const { client, config, log } = this.ctx;
    await this.bindAnchor();
    const head = await readHead(client);
    const a = await this.resolveAddresses(head.blockNumber);

    const scan = await scanSeries(this.ctx.logClient, this.mm, { clearinghouse: a.clearinghouse, deployBlock: config.registry.deployBlock ?? 0n, head: head.blockNumber });
    const vault = await readVaultState(client, a, { signer: this.ctx.signer, calendar: this.calendar!, now: head.timestamp, blockNumber: head.blockNumber });
    await this.ingestOrders(a, vault.makerOrderCount, head);
    const chainOrders = await this.trackOrders(a, vault.fees, head);
    const stop = await this.ledgerStop(a, head);

    const markets = quotedMarkets(config);
    const quotedSet = new Set(markets.map((m) => lc(m.underlying)));
    const marketsRead = await readMarkets(client, a, markets.map((m) => ({ ticker: m.ticker, underlying: m.underlying })), head.blockNumber);
    const tickerOf = new Map(markets.map((m) => [lc(m.underlying), m.ticker]));

    // The managed series: the selection over every live series of the quoted markets, plus the series of the vault's
    // open orders and tracked exposure there.
    const live = this.mm.liveSeries(head.timestamp).filter((s) => quotedSet.has(lc(s.underlying)));
    const spots = new Map([...marketsRead.markets].filter(([, m]) => m.spot !== null).map(([u, m]) => [u, m.spot!]));
    const picked = selectSeries({ now: head.timestamp, candidates: live, spots, pullMinutes: this.params.pullMinutes, maxSeries: this.params.maxSeries, maxSeriesPerMarket: this.params.maxSeriesPerMarket });
    const ordersBySeries = new Map<string, LiveOrder[]>();
    for (const o of chainOrders) {
      if (o.maker === zeroAddress) continue;
      const list = ordersBySeries.get(o.longId.toString()) ?? [];
      list.push({ id: o.id, kind: o.kind, price: o.price, units: o.units, filled: o.filled, validUntil: o.validUntil, cancelled: o.cancelled });
      ordersBySeries.set(o.longId.toString(), list);
    }
    const extraIds = [...new Set([...ordersBySeries.keys(), ...vault.tracked.map((id) => id.toString())])].map((k) => BigInt(k));
    const managed = managedSeries({ now: head.timestamp, picked, extra: this.mm.seriesByIds(extraIds), ordersBySeries });
    const views = await readSeriesViews(client, a, {
      series: [...managed.values()].map((info) => ({ info, ticker: tickerOf.get(lc(info.underlying)) ?? marketByUnderlying(config.registry, info.underlying)?.ticker ?? '?', orders: ordersBySeries.get(info.longId.toString()) ?? [] })),
      blockNumber: head.blockNumber,
    });
    const tracked = await readMeasuredNotional(client, a.vault, vault.tracked, head.blockNumber);

    const killed = this.mm.killed();
    const base: Omit<TickInput, 'fairs'> = {
      now: head.timestamp,
      sessionOpen: vault.sessionOpen,
      sessionClose: vault.sessionClose,
      killed: killed !== null,
      lossStop: stop,
      lastSync: this.mm.lastSync(),
      vault: {
        isQuoter: vault.isQuoter,
        tradingPaused: vault.tradingPaused,
        limits: vault.limits,
        outflow: vault.outflow,
        totalNotional: vault.totalNotional,
        usdgWallet: vault.usdgWallet,
        owed: vault.owed,
        freeCollateral: marketsRead.freeCollateral,
        walletTokens: marketsRead.walletTokens,
        tracked,
      } satisfies TickInput['vault'],
      markets: marketsRead.markets,
      series: views,
      params: this.params,
      refreshS: Math.max(60, Math.ceil((config.pollIntervalMs * 2) / 1000)),
    };

    const requests = fairRequests(base);
    const answers = await this.ctx.pricing.fairMany(requests.map((v) => ({ ticker: v.ticker, strike: v.info.strike, expiry: v.info.expiry, isPut: v.info.isPut })));
    const fairs = new Map<string, FairInput>(requests.map((v, i) => [v.info.longId.toString(), answers[i]!]));
    const reasons: Record<string, number> = {};
    for (const f of answers) if (!f.ok) reasons[f.reason] = (reasons[f.reason] ?? 0) + 1;

    const input: TickInput = { ...base, fairs };
    const plan = planTick(input);

    // The outflow bucket is shared by every quoter and by the admin (booked but never enforced), so a reading above
    // what this bot's own booked calls account for is USDG somebody else moved. Checked before the tick books more.
    const foreignOutflow = foreignSpend({
      observedUsed: vault.outflow.used,
      now: head.timestamp,
      cap: vault.limits.maxDailyOutflow,
      previous: this.mm.outflowProjection(),
    });

    const { txs, sent, refused } = await this.execute(plan, a, head);
    // Dated from a head read AFTER the sends: the vault refills the bucket from `_outflowAt`, the block of its last
    // booked call, so a projection dated at the tick's own head would assume a refill the chain has not made and the
    // next tick would read an honest level as a foreign spend (a long tick of many places is minutes of refill).
    this.recordOutflow(plan, views, sent, txs.length === 0 ? head : await readHead(client), vault);
    this.ticks += 1;
    this.last = {
      head,
      vault,
      input,
      plan,
      stop,
      txs,
      foreignOutflow,
      outflowRefused: refused,
      pricing: { requested: requests.length, failed: answers.filter((f) => !f.ok).length, reasons },
      scan: { scannedTo: this.mm.scannedTo(), created: scan.created, caughtUp: scan.caughtUp },
      startedAt,
      durationMs: this.wall() - startedAt,
    };
    await this.raiseAlerts(this.last);
    log.info(
      { head: head.blockNumber, selected: plan.selected.length, twoSided: twoSidedCount(plan), txs: txs.length, killed: killed !== null, lossStop: stop.tripped },
      'mm tick',
    );
    return plan;
  }

  /*------------------------------ sending -----------------------------*/

  private callOf(tx: MmTx, vault: Address): { call: { address: Address; abi: typeof makerVaultAbi; functionName: string; args: readonly unknown[]; gas: bigint }; kind: string; key: string; what: string } {
    const v = { address: vault, abi: makerVaultAbi };
    switch (tx.type) {
      case 'cancel':
        return { call: { ...v, functionName: 'cancel', args: [tx.orderIds], gas: MM_GAS.cancelBase + MM_GAS.cancelEach * BigInt(tx.orderIds.length) }, kind: 'mm-cancel', key: tx.orderIds.join(','), what: `cancel ${tx.orderIds.join(', ')} (${tx.reason})` };
      case 'replace':
        return { call: { ...v, functionName: 'replace', args: [tx.orderId, tx.price, tx.units], gas: MM_GAS.replace }, kind: 'mm-replace', key: tx.orderId.toString(), what: `replace ${tx.slot} ${tx.orderId} on ${tx.longId}: ${tx.units} @ ${tx.price} (${tx.reason})` };
      case 'place':
        return { call: { ...v, functionName: 'place', args: [tx.longId, tx.kind, tx.price, tx.units, tx.validUntil], gas: MM_GAS.place }, kind: 'mm-place', key: `${tx.longId}:${tx.slot}`, what: `place ${tx.slot} on ${tx.longId}: ${tx.units} @ ${tx.price} until ${tx.validUntil} (${tx.reason})` };
      case 'sync':
        return { call: { ...v, functionName: 'sync', args: [tx.longIds], gas: MM_GAS.syncBase + MM_GAS.syncEach * BigInt(tx.longIds.length) }, kind: 'mm-sync', key: tx.longIds.join(','), what: `sync ${tx.longIds.length} series (${tx.reason})` };
      case 'close':
        return { call: { ...v, functionName: 'close', args: [tx.longId, tx.units], gas: MM_GAS.close }, kind: 'mm-close', key: tx.longId.toString(), what: `close ${tx.units} pairs of ${tx.longId}` };
      case 'claimOwed':
        return { call: { ...v, functionName: 'claimOwed', args: [], gas: MM_GAS.claimOwed }, kind: 'mm-claimOwed', key: 'owed', what: `claimOwed ${tx.amount}` };
      case 'deposit':
        return { call: { ...v, functionName: 'depositToClearinghouse', args: [tx.asset as Address, tx.amount], gas: MM_GAS.deposit }, kind: 'mm-deposit', key: lc(tx.asset), what: `depositToClearinghouse ${tx.amount} of ${tx.asset}` };
    }
  }

  private async send(tx: MmTx, vault: Address): Promise<TxRecord> {
    const { call, kind, key, what } = this.callOf(tx, vault);
    const outcome = await this.ctx.sender.execute(call as never, { kind, key });
    const record: TxRecord = { type: tx.type, what, status: outcome.status };
    if ('hash' in outcome) record.hash = outcome.hash;
    if (outcome.status === 'simulation-reverted') {
      record.revert = outcome.revert;
      record.error = outcome.error.slice(0, 300);
      const refusal = MmBot.outflowRefusal(record, outcome);
      if (refusal !== null) record.outflow = refusal;
    }
    if (outcome.status === 'send-failed' || outcome.status === 'unconfirmed') record.error = outcome.error.slice(0, 300);
    if (outcome.status === 'confirmed' || outcome.status === 'reverted') record.gasUsed = outcome.gasUsed;

    const level = outcome.status === 'confirmed' || outcome.status === 'in-flight' ? 'info' : 'warn';
    this.ctx.log[level]({ kind, key, status: outcome.status, hash: record.hash, revert: record.revert, gasUsed: record.gasUsed }, what);
    if (record.outflow !== undefined) {
      // A handled condition, not a guard the bot's reads disagree with: paged as the outflow alert, per UTC day.
      await this.ctx.alerter.alert(
        'v2_mm_outflow',
        `the vault's daily outflow cap refused ${tx.type} (${record.outflow.available ?? '?'} USDG base units left, ${record.outflow.wanted ?? '?'} wanted): ${what}`,
        { kind, key, available: record.outflow.available, wanted: record.outflow.wanted },
        { dedupeKey: String(Math.floor(this.wall() / 86_400_000)) },
      );
    } else if (outcome.status === 'simulation-reverted') {
      await this.ctx.alerter.alert('v2_mm_tx_rejected', `vault ${tx.type} would revert (${outcome.revert ?? 'no reason'}): ${what}`, { kind, key, revert: outcome.revert, error: record.error }, { dedupeKey: `${kind}:${key}` });
    } else if (outcome.status === 'reverted' || outcome.status === 'unconfirmed' || outcome.status === 'send-failed') {
      await this.ctx.alerter.alert('v2_tx_revert', `mm ${tx.type} ${outcome.status}: ${what}`, { kind, key, hash: record.hash, error: record.error }, { dedupeKey: `${kind}:${key}` });
    }
    return record;
  }

  /**
   * A refusal by the vault's outflow cap: `OutflowCapExceeded(available, outflow)` decoded off the simulation. The
   * cap is one shared bucket, so once it has refused one call every later bid in the tick would be refused too.
   */
  private static outflowRefusal(record: TxRecord, outcome: TxOutcome): OutflowRefusal | null {
    if (record.revert !== 'OutflowCapExceeded') return null;
    const args = outcome.status === 'simulation-reverted' ? (outcome.revertArgs ?? []) : [];
    const num = (i: number): bigint | null => (typeof args[i] === 'bigint' ? (args[i] as bigint) : null);
    return { what: record.what, available: num(0), wanted: num(1) };
  }

  private async execute(plan: TickPlan, a: MmAddresses, head: Head): Promise<{ txs: TxRecord[]; sent: Map<number, TxRecord>; refused: OutflowRefusal[] }> {
    const out: TxRecord[] = [];
    const sent = new Map<number, TxRecord>();
    const refused: OutflowRefusal[] = [];
    for (const [index, tx] of plan.txs.entries()) {
      if (out.length >= this.ctx.config.tuning.maxTxPerTick) break;
      // A kill that arrived during this tick: nothing but cancels from here on.
      if (tx.type !== 'cancel' && this.mm.killed() !== null) break;
      // The outflow cap refused a call: every later bid draws on the same bucket, so stop growing them for this tick
      // rather than paying gas for simulations that cannot pass. Cancels (credits) and asks (not booked) carry on.
      const growsBid = (tx.type === 'place' || tx.type === 'replace') && tx.slot === 'bid';
      if (refused.length > 0 && growsBid) continue;
      const record = await this.send(tx, a.vault);
      out.push(record);
      sent.set(index, record);
      if (tx.type === 'sync' && record.status === 'confirmed') this.mm.setLastSync(head.timestamp);
      if (record.outflow !== undefined) {
        refused.push(record.outflow);
        this.ctx.log.warn({ kind: tx.type, available: record.outflow.available, wanted: record.outflow.wanted }, 'the vault\'s daily outflow cap refused a call: no further bid grows this tick');
      }
    }
    return { txs: out, sent, refused };
  }

  /**
   * Record where the outflow bucket stands after this tick's own booked calls, for the next tick's foreign-spend
   * check. A call that was sent but whose fate is unknown (`in-flight`, `unconfirmed`) is counted as booked: an
   * over-estimate of the bot's own spending only makes the next comparison more forgiving, never falsely accusing.
   */
  private recordOutflow(plan: TickPlan, views: readonly SeriesView[], sent: ReadonlyMap<number, TxRecord>, head: Head, vault: VaultState): void {
    const BOOKED: ReadonlySet<TxOutcome['status']> = new Set(['confirmed', 'in-flight', 'unconfirmed']);
    const live = new Map<string, { kind: LiveOrder['kind']; price: bigint; remaining: bigint }>();
    for (const v of views) for (const o of v.orders) live.set(o.id.toString(), { kind: o.kind, price: o.price, remaining: o.units > o.filled ? o.units - o.filled : 0n });
    const applied = bookedCalls(plan, live).filter((c) => {
      const record = sent.get(c.index);
      return record !== undefined && BOOKED.has(record.status);
    });
    this.mm.setOutflowProjection({ used: project(vault.outflow.used, applied), at: head.timestamp, cap: vault.limits.maxDailyOutflow });
  }

  /*------------------------------- alerts -----------------------------*/

  private async raiseAlerts(t: LastTick): Promise<void> {
    const { alerter, store } = this.ctx;
    if (t.stop.tripped) {
      const key = `${MM_META.lossStopAlerted}${t.stop.day}`;
      // Redelivered from its stored row since the failure (alerts.ts redeliver): remembered, not paged twice.
      if (store.getMeta(key) === null && store.alertDeliveredSince('v2_mm_loss_stop', null, t.stop.day * 86_400_000)) {
        store.setMeta(key, String(t.head.timestamp));
        this.lossStopFailedAt = null;
      }
      const retryDue = this.lossStopFailedAt === null || this.wall() - this.lossStopFailedAt >= FAILED_DELIVERY_RETRY_MS;
      if (store.getMeta(key) === null && retryDue) {
        // Remembered only once delivered: a page the relay refused is sent again by a later tick of the same day.
        if (await alerter.alert('v2_mm_loss_stop', `MM daily realised-loss stop: ${t.stop.realised} USDG base units today (limit ${t.stop.limit}); every quote pulled until the next UTC day`, { day: t.stop.day, realised: t.stop.realised, limit: t.stop.limit }, { force: true })) {
          store.setMeta(key, String(t.head.timestamp));
          this.lossStopFailedAt = null;
        } else {
          this.lossStopFailedAt = this.wall();
        }
      }
    }
    if (!t.vault.isQuoter) {
      await alerter.alert('v2_mm_not_quoter', `the MM signer ${this.ctx.signer} holds neither QUOTER_ROLE nor admin on the vault: nothing can be quoted or cancelled`, { signer: this.ctx.signer });
    } else {
      alerter.clear('v2_mm_not_quoter');
    }
    for (const row of t.plan.netDelta) {
      if (row.alert) {
        await alerter.alert('v2_mm_delta', `MM net delta on ${row.ticker} is ${row.deltaShares.toFixed(2)} shares (alert above ${this.params.deltaAlertShares}); hedge by hand`, { ticker: row.ticker, deltaShares: row.deltaShares, positions: row.positions, unknown: row.unknown }, { dedupeKey: row.ticker });
      } else {
        alerter.clear('v2_mm_delta', row.ticker);
      }
    }
    // Nothing quoted for want of a fair value: every selected series halted fair-unavailable (the service down, or a
    // refusal: chain-stale, spot-unavailable, chain-inconsistent) or fair-stale (an asOf that stopped advancing), or
    // every request failed in transport. Pricing /health stays ok for most of these, so this is the page.
    const selected = t.plan.series.filter((s) => s.selected);
    const fairHalted = selected.filter((s) => s.halt !== null && ['fair-unavailable', 'fair-stale', 'fair-spot-mismatch', 'fair-out-of-bounds'].includes(s.halt.halt));
    const allFailed = t.pricing.requested > 0 && t.pricing.failed === t.pricing.requested && Object.keys(t.pricing.reasons).some((r) => r.startsWith('pricing-'));
    if (allFailed || (selected.length > 0 && fairHalted.length === selected.length)) {
      const halts: Record<string, number> = {};
      for (const s of fairHalted) halts[s.halt!.halt] = (halts[s.halt!.halt] ?? 0) + 1;
      await alerter.alert(
        'v2_mm_pricing',
        `no fair value to quote on: ${fairHalted.length} of ${selected.length} selected series halted (${Object.entries(halts).map(([k, n]) => `${k} ${n}`).join(', ') || 'every /fair request failed'}); nothing is quoted`,
        { halts, reasons: t.pricing.reasons, requested: t.pricing.requested, failed: t.pricing.failed, pricingUrl: new URL(this.ctx.config.pricingUrl).origin },
      );
    } else if (selected.length > fairHalted.length || t.pricing.failed < t.pricing.requested) {
      alerter.clear('v2_mm_pricing');
    }
    // The vault's daily outflow cap (c21). Once per UTC day while it binds: the bot trimmed its bids (or the chain
    // refused one), so quoting is smaller than the strategy asks until the bucket refills.
    const outflow = t.plan.outflow;
    if (outflow.blocked || t.outflowRefused.length > 0) {
      const day = Math.floor(this.wall() / 86_400_000);
      const trimmed = t.plan.capped.filter((c) => c.caps.includes('outflow')).length;
      await alerter.alert(
        'v2_mm_outflow',
        `the vault's daily outflow cap is binding: ${outflow.used} of ${outflow.cap} USDG base units used, ${outflow.budget} left for this tick's bids; ${trimmed} series trimmed${t.outflowRefused.length > 0 ? `, ${t.outflowRefused.length} call(s) refused on chain` : ''}`,
        { cap: outflow.cap, used: outflow.used, released: outflow.released, budget: outflow.budget, planned: outflow.planned, seriesTrimmed: trimmed, refused: t.outflowRefused },
        { dedupeKey: String(day) },
      );
    }
    if (t.foreignOutflow !== null) {
      await alerter.alert(
        'v2_mm_outflow_foreign',
        `the MakerVault's outflow bucket is ${t.foreignOutflow} USDG base units above what this bot's own calls account for: USDG left the vault through a quoter or admin call this bot did not send`,
        { over: t.foreignOutflow, used: t.vault.outflow.used, cap: t.vault.limits.maxDailyOutflow, vault: this.addresses?.vault ?? this.ctx.config.contracts.makerVault, signer: this.ctx.signer },
        { force: true },
      );
    }
    const unfunded = t.plan.series.filter((s) => s.sizes !== null && s.halt === null && s.sizes.capped.some((c) => c === 'usdg' || c === 'collateral') && (s.sizes.bid === 0n || s.sizes.write + s.sizes.resale === 0n));
    const byTicker = new Map<string, number>();
    for (const s of unfunded) byTicker.set(s.ticker, (byTicker.get(s.ticker) ?? 0) + 1);
    for (const [ticker, n] of byTicker) {
      await alerter.alert('v2_mm_funds', `MM quotes one side only on ${n} ${ticker} series: the vault lacks USDG (bids) or ledger collateral (write asks)`, { ticker, series: n, usdgWallet: t.vault.usdgWallet }, { dedupeKey: ticker });
    }
  }

  /*-------------------------------- kill ------------------------------*/

  async kill(reason: string): Promise<KillOutcome> {
    const at = Math.floor(this.wall() / 1000);
    this.mm.setKilled({ at, reason });
    this.ctx.log.warn({ reason }, 'kill switch engaged: cancelling every vault order');
    // Paged alongside the cancels, never before them: a relay that hangs (10 s timeout) must not keep quotes fillable.
    void this.ctx.alerter.alert('v2_mm_killed', `MM kill switch engaged (${reason}): every vault order is being cancelled; nothing quotes until POST /resume`, { reason }, { force: true }).catch(() => false);
    // A failure (an unreachable RPC) is an answer, not a 500: the stored kill still halts every later tick.
    this.killRun ??= this.cancelEverything()
      .catch((error: unknown) => ({ cancelled: 0, remaining: -1, remainingOrderIds: [] as bigint[], errors: [describeError(error)] }))
      .finally(() => {
        this.killRun = null;
      });
    const run = this.killRun;
    const waitMs = this.ctx.killWaitMs ?? KILL_RESPONSE_WAIT_MS;
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([run, new Promise<null>((r) => (timer = setTimeout(() => r(null), waitMs)))]);
    clearTimeout(timer);
    const outcome: KillOutcome =
      result === null
        ? { killed: true, at, reason, cancelled: 0, remaining: -1, remainingOrderIds: [], done: false, errors: ['cancels still running; GET /state shows the vault\'s live orders'] }
        : { killed: true, at, reason, cancelled: result.cancelled, remaining: result.remaining, remainingOrderIds: result.remainingOrderIds, done: result.remaining === 0, errors: result.errors };
    this.lastKill = outcome;
    return outcome;
  }

  resume(): { killed: false; at: number } {
    const at = Math.floor(this.wall() / 1000);
    this.mm.setKilled(null);
    this.ctx.log.warn({}, 'kill switch released: quoting resumes at the next tick');
    void this.ctx.alerter.alert('v2_mm_resumed', 'MM kill switch released (POST /resume): quoting resumes', {}, { force: true });
    this.wakeLoop?.();
    return { killed: false, at };
  }

  /**
   * Cancel every vault order with units left (live, or expired still holding escrow: engine.isKillTarget), until a
   * re-read finds none. The final count uses the same predicate as the targets, so a target whose cancel failed is
   * remaining, never done.
   */
  private async cancelEverything(): Promise<{ cancelled: number; remaining: number; remainingOrderIds: bigint[]; errors: string[] }> {
    const errors: string[] = [];
    let cancelled = 0;
    await this.bindAnchor();
    const resumed = () => ({ cancelled, remaining: -1, remainingOrderIds: [] as bigint[], errors: [...errors, 'resumed (POST /resume) while the kill was cancelling: its remaining passes were stopped'] });
    for (let pass = 0; pass < 5; pass += 1) {
      // A resume during the run: the quotes placed since are the operator's intent, not leftovers to cancel.
      if (this.mm.killed() === null) return resumed();
      const head = await readHead(this.ctx.client);
      const a = await this.resolveAddresses(head.blockNumber);
      const count = (await this.ctx.client.readContract({ address: a.orderBook, abi: orderBookAbi, functionName: 'makerOrderCount', args: [a.vault], blockNumber: head.blockNumber })) as bigint;
      await this.ingestOrders(a, count, head);
      const open = this.mm.openOrders();
      const chain = await readOrders(this.ctx.client, a.orderBook, open.map((o) => o.orderId), head.blockNumber);
      const targets = chain.filter((o) => o.maker !== zeroAddress && isKillTarget(o, head.timestamp));
      if (targets.length === 0) return { cancelled, remaining: 0, remainingOrderIds: [], errors };
      for (let i = 0; i < targets.length; i += CANCEL_CHUNK) {
        if (this.mm.killed() === null) return resumed();
        const ids = targets.slice(i, i + CANCEL_CHUNK).map((o) => o.id);
        try {
          const record = await this.send({ type: 'cancel', orderIds: ids, longIds: [], reason: 'kill switch' }, a.vault);
          if (record.status === 'confirmed') cancelled += ids.length;
          else if (record.status !== 'in-flight') errors.push(`${record.what}: ${record.status}${record.revert ? ` ${record.revert}` : ''}`);
        } catch (error) {
          errors.push(describeError(error));
        }
      }
      await sleep(pass === 0 ? 0 : (this.ctx.killRetryMs ?? 1_000));
    }
    if (this.mm.killed() === null) return resumed();
    const head = await readHead(this.ctx.client);
    const a = await this.resolveAddresses(head.blockNumber);
    const chain = await readOrders(this.ctx.client, a.orderBook, this.mm.openOrders().map((o) => o.orderId), head.blockNumber);
    const left = chain.filter((o) => o.maker !== zeroAddress && isKillTarget(o, head.timestamp)).map((o) => o.id);
    if (left.length > 0) this.ctx.log.error({ remainingOrderIds: left, errors }, 'kill switch: vault orders still hold escrow or can fill after every cancel pass; later ticks keep cancelling');
    return { cancelled, remaining: left.length, remainingOrderIds: left, errors };
  }

  /*-------------------------------- state -----------------------------*/

  state(): unknown {
    const t = this.last;
    if (t === null) return null;
    const { plan, input, vault } = t;
    const halts: Record<string, number> = {};
    for (const s of plan.series) {
      const k = s.halt === null ? (s.targets === null ? 'not-quoted' : 'quoting') : s.halt.halt;
      halts[k] = (halts[k] ?? 0) + 1;
    }
    return {
      mode: 'mm',
      signer: this.ctx.signer,
      vault: this.addresses?.vault ?? this.ctx.config.contracts.makerVault,
      head: t.head,
      ticks: this.ticks,
      lastTickAt: new Date(t.startedAt).toISOString(),
      lastTickDurationMs: t.durationMs,
      killed: this.mm.killed(),
      lastKill: this.lastKill,
      lossStop: { day: t.stop.day, realisedUsdg6: t.stop.realised, limitUsdg6: t.stop.limit, tripped: t.stop.tripped },
      session: { open: vault.sessionOpen, close: vault.sessionClose, quoteOffHours: this.params.quoteOffHours },
      netDelta: plan.netDelta.map((r) => ({
        ticker: r.ticker,
        underlying: r.underlying,
        deltaShares: Number(r.deltaShares.toFixed(6)),
        deltaUsdg: r.spot === null ? null : Number(((r.deltaShares * Number(r.spot)) / 1e6).toFixed(2)),
        spot: r.spot,
        positions: r.positions,
        positionsWithoutDelta: r.unknown,
        alertAboveShares: this.params.deltaAlertShares,
        alert: r.alert,
        hedging: 'manual (no borrow market)',
      })),
      vaultState: {
        isQuoter: vault.isQuoter,
        tradingPaused: vault.tradingPaused,
        limits: vault.limits,
        outflow: {
          capUsdg6: plan.outflow.cap,
          usedUsdg6: plan.outflow.used,
          availableUsdg6: vault.outflow.available,
          releasedThisTickUsdg6: plan.outflow.released,
          budgetThisTickUsdg6: plan.outflow.budget,
          plannedThisTickUsdg6: plan.outflow.planned,
          blocked: plan.outflow.blocked,
          refused: t.outflowRefused,
          foreignUsdg6: t.foreignOutflow,
          projection: this.mm.outflowProjection(),
        },
        botLimits: { maxSeriesUnits: this.params.maxSeriesUnits, maxTotalNotionalUsdg6: this.params.maxTotalNotionalUsdg6 },
        totalNotional: vault.totalNotional,
        usdgWallet: vault.usdgWallet,
        owed: vault.owed,
        freeCollateral: Object.fromEntries(input.vault.freeCollateral),
        walletTokens: Object.fromEntries(input.vault.walletTokens),
        trackedSeries: input.vault.tracked.length,
        lastSync: this.mm.lastSync(),
      },
      quoting: { managed: plan.series.length, selected: plan.selected.length, twoSided: twoSidedCount(plan), byHalt: halts, capped: plan.capped },
      pricing: t.pricing,
      series: plan.series.map((s) => ({
        longId: s.longId,
        ticker: s.ticker,
        type: s.isPut ? 'put' : 'call',
        strike: s.strike,
        expiry: s.expiry,
        selected: s.selected,
        halt: s.halt,
        fair: s.fair === null ? null : { fair: s.fair.fair, delta: s.fair.delta, iv: s.fair.iv, source: s.fair.source, asOf: s.fair.asOf },
        fairReason: s.fairReason,
        quote: s.prices === null ? null : { bid: s.prices.bid, ask: s.prices.ask, resale: s.prices.resale, halfSpread: s.prices.halfSpread, skew: s.prices.skew, widenBps: s.prices.widen, clampedBy: s.prices.clampedBy },
        targets: s.targets,
        sizes: s.sizes === null ? null : { bid: s.sizes.bid, write: s.sizes.write, resale: s.sizes.resale, exposure: s.sizes.exposure, notional: s.sizes.notional, capped: s.sizes.capped },
        inventory: s.inventory,
        live: s.live,
      })),
      lastTxs: t.txs,
      recentFills: this.recentFills,
      lastSales: this.lastSales,
      index: { ...t.scan, ...this.mm.counts() },
      recentTxs: this.ctx.store.recentTxs(20),
    };
  }
}
