/**
 * One MM tick, decided: from everything the tick read (TickInput) to the vault transactions it sends and the /state
 * view it reports. Pure: quoter.ts reads the chain and the pricing service into a TickInput, calls these, and sends.
 *
 *   selectedSeries   which series are quoted (engine.selectSeries over the managed series of the quoted markets)
 *   fairRequests     which series need a /fair answer: every selected series not halted before fair, and every
 *                    series with inventory (its delta counts towards the net delta even while it is not quoted)
 *   planTick         net delta per market → per series halt, prices (engine.quotePrices), sizes (risk.planSizes in
 *                    selection order), targets → vault calls (engine.planSeriesActions), plus housekeeping:
 *                    close long/short pairs, claim owed USDG, move wallet Stock Tokens into the ledger, sync the
 *                    stored exposure of series whose stored notional is above the measured one
 *
 * EXECUTION ORDER of the returned transactions: cancels (chunked, CANCEL_CHUNK ids per call), sync, closes, claimOwed,
 * deposits, replaces (shrinking before growing), places. Cancels free escrow and lower stored exposure, sync lowers
 * stored notional, closes and deposits free collateral, so every later call meets the most room under the guards.
 *
 * KILLED: every managed series is halted `killed` (all its orders cancelled) and no housekeeping is planned. The
 * kill switch itself (quoter.ts) also cancels orders on markets the bot does not manage.
 * NOT QUOTER (the signer lost QUOTER_ROLE): nothing is planned at all, since the vault refuses even a cancel.
 */
import { CANCEL_CHUNK, SYNC_CHUNK, UNITS_PER_SHARE } from './constants.js';
import { bidEscrowOf, budgetFor } from './outflow.js';
import {
  fairAtSpot,
  haltBeforeFair,
  haltOf,
  isLiveOrder,
  netDeltaByUnderlying,
  orderActions,
  planSeriesActions,
  quoteValidUntil,
  quotePrices,
  selectSeries,
  type FairInput,
  type Halt,
  type LiveOrder,
  type MmAction,
  type NetDelta,
  type QuoteParams,
  type QuotePrices,
  type SeriesInfo,
  type Slot,
  type SlotTarget,
} from './engine.js';
import type { LossStop } from './pnl.js';
import { planSizes, type SeriesSizes, type SizeSeries } from './risk.js';

/*//////////////////////////////////////////////////////////////
                              INPUT
//////////////////////////////////////////////////////////////*/

export interface MmPlanParams extends QuoteParams {
  maxSeries: number;
  maxSeriesPerMarket: number;
  bidUnits: bigint;
  askUnits: bigint;
  maxSeriesUnits: bigint;
  maxTotalNotionalUsdg6: bigint;
  deltaAlertShares: number;
  syncIntervalS: number;
  depositTokens: boolean;
  /** MM_MAX_QUOTE_LIFETIME_S: the longest validUntil a new quote gets, whatever the vault allows (0 = none). */
  maxQuoteLifetimeS: number;
}

export interface VaultLimits {
  maxSeriesUnits: bigint;
  maxTotalNotional: bigint;
  askToleranceBps: number;
  maxBidBpsOfSpot: number;
  maxOrderLifetime: number;
  /** INTERFACE_VERSION 7 (c21): USDG the quoter may pay out net at once; refills linearly per OUTFLOW_WINDOW. */
  maxDailyOutflow: bigint;
}

export interface VaultView {
  isQuoter: boolean;
  tradingPaused: boolean;
  limits: VaultLimits;
  /** MakerVault.outflow(): the leaky bucket now. */
  outflow: { used: bigint; available: bigint };
  /** MakerVault.totalNotional (stored). */
  totalNotional: bigint;
  /** USDG in the vault's wallet. */
  usdgWallet: bigint;
  /** OrderBook.owed(vault). */
  owed: bigint;
  /** Clearinghouse.free(vault, asset), lower-case asset. */
  freeCollateral: ReadonlyMap<string, bigint>;
  /** Stock Token balances of the vault's wallet, lower-case token (the quoted markets only). */
  walletTokens: ReadonlyMap<string, bigint>;
  /** MakerVault.trackedSeries with the stored and the measured notional of each. */
  tracked: ReadonlyArray<{ longId: bigint; stored: bigint; measured: bigint | null }>;
}

export interface MarketView {
  /** Lower-case Stock Token. */
  underlying: string;
  ticker: string;
  enabled: boolean;
  mintPaused: boolean;
  /** The market oracle's spot when trySpot is ok, else null. */
  spot: bigint | null;
}

export interface ExposureDetail {
  longs: bigint;
  shorts: bigint;
  bids: bigint;
  resale: bigint;
  writes: bigint;
  live: bigint;
}

export interface SeriesView {
  info: SeriesInfo;
  ticker: string;
  settled: boolean;
  /** The series' pinned oracle: trySpot ok (vault calls on it revert StaleSpot otherwise). */
  spotFresh: boolean;
  spot: bigint | null;
  /** MakerVault.exposure detail; null when unreadable. */
  exposure: ExposureDetail | null;
  /** MakerVault.seriesNotional (stored). */
  seriesNotional: bigint;
  /** MakerVault.askFloor / bidCap; null when they revert (stale spot). */
  askFloor: bigint | null;
  bidCap: bigint | null;
  collateralAsset: string;
  collateralPerUnit: bigint;
  /** The rent rate pinned into the series at creation, millionths per 7 days (INTERFACE_VERSION 7). */
  mintFeePpm: number;
  /** Every vault order known on the series, dead ones included. */
  orders: readonly LiveOrder[];
}

export interface TickInput {
  /** Head block timestamp. */
  now: number;
  sessionOpen: boolean;
  /** The regular session's close when it is open, else null. */
  sessionClose: number | null;
  killed: boolean;
  lossStop: LossStop;
  /** Head time of the last vault.sync, or null. */
  lastSync: number | null;
  vault: VaultView;
  /** By lower-case underlying: the quoted markets. */
  markets: ReadonlyMap<string, MarketView>;
  /** Every series the bot manages: quoted markets, not expired, or with vault orders or inventory. */
  series: readonly SeriesView[];
  /** /fair answers by decimal longId (fairRequests says which were asked). */
  fairs: ReadonlyMap<string, FairInput>;
  params: MmPlanParams;
  /** A live quote expiring sooner than this is re-placed when a later validUntil is allowed. */
  refreshS: number;
}

/*//////////////////////////////////////////////////////////////
                             OUTPUT
//////////////////////////////////////////////////////////////*/

export type MmTx =
  | { type: 'cancel'; orderIds: bigint[]; longIds: bigint[]; reason: string }
  | Extract<MmAction, { type: 'replace' | 'place' }>
  | { type: 'sync'; longIds: bigint[]; reason: string }
  | { type: 'close'; longId: bigint; units: bigint; reason: string }
  | { type: 'claimOwed'; amount: bigint; reason: string }
  | { type: 'deposit'; asset: string; amount: bigint; reason: string };

export interface NetDeltaRow extends NetDelta {
  underlying: string;
  ticker: string;
  spot: bigint | null;
  /** |deltaShares| above MM_DELTA_ALERT_SHARES (when that is > 0). */
  alert: boolean;
}

export interface SeriesPlan {
  longId: bigint;
  ticker: string;
  isPut: boolean;
  strike: bigint;
  expiry: number;
  selected: boolean;
  halt: Halt | null;
  fair: Extract<FairInput, { ok: true }> | null;
  fairReason: string | null;
  prices: QuotePrices | null;
  sizes: SeriesSizes | null;
  targets: Record<Slot, SlotTarget | null> | null;
  /** Signed inventory: longs (wallet + live resale escrow) − shorts, 0.01-share units. */
  inventory: bigint;
  live: Array<{ id: bigint; kind: LiveOrder['kind']; price: bigint; remaining: bigint; validUntil: number }>;
}

export interface TickPlan {
  selected: bigint[];
  netDelta: NetDeltaRow[];
  series: SeriesPlan[];
  txs: MmTx[];
  /** The bot's view of what caps it: series sizes cut by a guard or by funds. */
  capped: Array<{ longId: bigint; caps: string[] }>;
  /** The vault's daily outflow cap as this tick planned against it (INTERFACE_VERSION 7, c21). */
  outflow: {
    cap: bigint;
    /** MakerVault.outflow().used at the tick's head. */
    used: bigint;
    /** Escrow this tick's cancels and replaces hand back before its places run. */
    released: bigint;
    /** USDG of new bid escrow the plan may create: `cap − max(0, used − released)`. */
    budget: bigint;
    /** USDG of new bid escrow the plan does create. */
    planned: bigint;
    /** The cap cut at least one bid (risk cap `'outflow'`). */
    blocked: boolean;
  };
}

/*//////////////////////////////////////////////////////////////
                            SELECTION
//////////////////////////////////////////////////////////////*/

const key = (id: bigint): string => id.toString();
const lc = (a: string): string => a.toLowerCase();

const inventoryOf = (e: ExposureDetail | null): bigint => (e === null ? 0n : e.longs + e.resale - e.shorts);
const hasInventory = (e: ExposureDetail | null): boolean => e !== null && (e.longs > 0n || e.shorts > 0n || e.resale > 0n);

/** The quoted series, in quoting priority. */
export function selectedSeries(input: Pick<TickInput, 'now' | 'series' | 'markets' | 'params'>): SeriesInfo[] {
  const spots = new Map<string, bigint>();
  for (const [u, m] of input.markets) if (m.spot !== null) spots.set(lc(u), m.spot);
  const candidates = input.series.filter((s) => !s.settled && input.markets.has(lc(s.info.underlying))).map((s) => s.info);
  return selectSeries({
    now: input.now,
    candidates,
    spots,
    pullMinutes: input.params.pullMinutes,
    maxSeries: input.params.maxSeries,
    maxSeriesPerMarket: input.params.maxSeriesPerMarket,
  });
}

function haltContext(input: Omit<TickInput, 'fairs'>, view: SeriesView, selected: boolean) {
  const market = input.markets.get(lc(view.info.underlying));
  return {
    now: input.now,
    series: view.info,
    params: input.params,
    killed: input.killed,
    lossStopped: input.lossStop.tripped,
    isQuoter: input.vault.isQuoter,
    tradingPaused: input.vault.tradingPaused,
    sessionOpen: input.sessionOpen,
    marketEnabled: market?.enabled ?? false,
    marketQuoted: market !== undefined,
    spotFresh: view.spotFresh,
    selected,
  };
}

/** The series a /fair answer is needed for (decimal longIds, in series order). */
export function fairRequests(input: Omit<TickInput, 'fairs'>): SeriesView[] {
  const selected = new Set(selectedSeries(input).map((s) => key(s.longId)));
  return input.series.filter((view) => {
    if (input.now >= view.info.expiry || view.settled) return false;
    if (hasInventory(view.exposure)) return true;
    return haltBeforeFair(haltContext(input, view, selected.has(key(view.info.longId)))) === null;
  });
}

/*//////////////////////////////////////////////////////////////
                              PLAN
//////////////////////////////////////////////////////////////*/

const escrowOf = (o: LiveOrder): bigint => (o.price * (o.units - o.filled)) / UNITS_PER_SHARE;

export function planTick(input: TickInput): TickPlan {
  const { now, params, vault } = input;
  const selectedInfo = selectedSeries(input);
  const rank = new Map(selectedInfo.map((s, i) => [key(s.longId), i]));

  /* ---- net delta ---- */
  const okFair = (id: bigint) => {
    const f = input.fairs.get(key(id));
    return f !== undefined && f.ok ? f : null;
  };
  const byUnderlying = netDeltaByUnderlying(
    input.series
      .filter((v) => now < v.info.expiry && !v.settled)
      .map((v) => ({ underlying: v.info.underlying, units: inventoryOf(v.exposure), delta: okFair(v.info.longId)?.delta ?? null })),
  );
  const netDelta: NetDeltaRow[] = [...input.markets.values()].map((m) => {
    const row = byUnderlying.get(lc(m.underlying)) ?? { deltaShares: 0, unknown: 0, positions: 0 };
    return { ...row, underlying: lc(m.underlying), ticker: m.ticker, spot: m.spot, alert: params.deltaAlertShares > 0 && Math.abs(row.deltaShares) > params.deltaAlertShares };
  });

  /* ---- halts and prices ---- */
  interface Working {
    view: SeriesView;
    selected: boolean;
    halt: Halt | null;
    fair: Extract<FairInput, { ok: true }> | null;
    fairReason: string | null;
    prices: QuotePrices | null;
  }
  const working: Working[] = input.series.map((view) => {
    const selected = rank.has(key(view.info.longId));
    const fairAnswer = input.fairs.get(key(view.info.longId));
    const halt = haltOf({
      ...haltContext(input, view, selected),
      ...(fairAnswer === undefined ? {} : { fair: fairAnswer }),
      spot: view.spot,
      guardsOk: view.askFloor !== null && view.bidCap !== null && view.exposure !== null,
    });
    const fair = fairAnswer !== undefined && fairAnswer.ok ? fairAnswer : null;
    let prices: QuotePrices | null = null;
    if (halt === null && fair !== null && view.askFloor !== null && view.bidCap !== null && view.spot !== null) {
      prices = quotePrices({
        now,
        series: view.info,
        // Priced at the pricing service's spot, quoted at the oracle's (within MM_FAIR_SPOT_TOLERANCE_BPS: haltOf).
        fair: fairAtSpot({ fair: fair.fair, delta: fair.delta, fairSpot: fair.spot, spot: view.spot }),
        delta: fair.delta,
        spot: view.spot,
        netDeltaShares: byUnderlying.get(lc(view.info.underlying))?.deltaShares ?? 0,
        askFloor: view.askFloor,
        bidCap: view.bidCap,
        params,
      });
    }
    return { view, selected, halt, fair, fairReason: fairAnswer !== undefined && !fairAnswer.ok ? fairAnswer.reason : null, prices };
  });

  /* ---- sizes, in quoting priority ---- */
  // Housekeeping closes long/short pairs before any place (EXECUTION ORDER): size every series as closed, or a resale ask
  // would escrow wallet longs the close burns first and revert.
  const housekeeping = !input.killed && vault.isQuoter;
  const closePair = (view: SeriesView): bigint => {
    const e = view.exposure;
    if (!housekeeping || e === null || view.settled || now >= view.info.expiry) return 0n;
    return e.longs < e.shorts ? e.longs : e.shorts;
  };
  const quoted = working.filter((w) => w.prices !== null).sort((a, b) => (rank.get(key(a.view.info.longId)) ?? 0) - (rank.get(key(b.view.info.longId)) ?? 0));
  const bidEscrow = input.series.reduce((sum, v) => sum + v.orders.filter((o) => o.kind === 'Bid' && isLiveOrder(o, now)).reduce((s, o) => s + escrowOf(o), 0n), 0n);
  const sizeInput: SizeSeries[] = quoted.map((w) => {
    const e = w.view.exposure!;
    const pair = closePair(w.view);
    const market = input.markets.get(lc(w.view.info.underlying));
    return {
      longId: w.view.info.longId,
      strike: w.view.info.strike,
      longs: e.longs - pair,
      resale: e.resale,
      shorts: e.shorts - pair,
      seriesNotional: w.view.seriesNotional,
      collateralAsset: w.view.collateralAsset,
      collateralPerUnit: w.view.collateralPerUnit,
      mintFeePpm: w.view.mintFeePpm,
      expiry: w.view.info.expiry,
      bidPrice: w.prices!.bid,
      askPrice: w.prices!.ask,
      writeAllowed: market !== undefined && !market.mintPaused,
    };
  });
  // The outflow cap (c21): every live bid's escrow comes back before a place runs (a cancel credits it, a replace
  // books the net), so the room for new bid escrow is the cap less what the credits cannot cancel out.
  const outflowBudget = budgetFor({ cap: vault.limits.maxDailyOutflow, used: vault.outflow.used, released: bidEscrow });
  const sizes = planSizes(sizeInput, {
    now,
    vaultMaxSeriesUnits: vault.limits.maxSeriesUnits,
    botMaxSeriesUnits: params.maxSeriesUnits,
    vaultMaxTotalNotional: vault.limits.maxTotalNotional,
    botMaxTotalNotional: params.maxTotalNotionalUsdg6,
    totalNotional: vault.totalNotional,
    usdgBudget: vault.usdgWallet + bidEscrow,
    outflowBudget,
    freeCollateral: vault.freeCollateral,
    bidUnits: params.bidUnits,
    askUnits: params.askUnits,
  });
  const sizeOf = new Map(sizes.map((s) => [key(s.longId), s]));

  /* ---- per-series actions ---- */
  const sessionClose = params.quoteOffHours ? null : input.sessionClose;
  const perSeries: MmAction[][] = [];
  const plans: SeriesPlan[] = [];
  for (const w of [...working].sort((a, b) => (rank.get(key(a.view.info.longId)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(key(b.view.info.longId)) ?? Number.MAX_SAFE_INTEGER))) {
    const { view } = w;
    const s = sizeOf.get(key(view.info.longId)) ?? null;
    let targets: Record<Slot, SlotTarget | null> | null = null;
    if (w.prices !== null && s !== null) {
      targets = {
        bid: w.prices.bid !== null && s.bid > 0n ? { price: w.prices.bid, units: s.bid } : null,
        write: s.write > 0n ? { price: w.prices.ask, units: s.write } : null,
        resale: s.resale > 0n ? { price: w.prices.resale, units: s.resale } : null,
      };
    }
    const until = (slot: Slot) =>
      quoteValidUntil({ now, expiry: view.info.expiry, slot, pullMinutes: params.pullMinutes, sessionClose, maxOrderLifetime: vault.limits.maxOrderLifetime, maxQuoteLifetime: params.maxQuoteLifetimeS });
    perSeries.push(
      planSeriesActions({
        longId: view.info.longId,
        now,
        orders: view.orders,
        targets,
        haltReason: w.halt === null ? (targets === null ? 'not quoted' : undefined) : `${w.halt.halt}${w.halt.detail === undefined ? '' : `: ${w.halt.detail}`}`,
        validUntil: { bid: until('bid'), write: until('write'), resale: until('resale') },
        askFloor: view.askFloor ?? 0n,
        bidCap: view.bidCap ?? 0n,
        refreshS: input.refreshS,
        params,
      }),
    );
    plans.push({
      longId: view.info.longId,
      ticker: view.ticker,
      isPut: view.info.isPut,
      strike: view.info.strike,
      expiry: view.info.expiry,
      selected: w.selected,
      halt: w.halt,
      fair: w.fair,
      fairReason: w.fairReason,
      prices: w.prices,
      sizes: s,
      targets,
      inventory: inventoryOf(view.exposure),
      live: view.orders.filter((o) => isLiveOrder(o, now)).map((o) => ({ id: o.id, kind: o.kind, price: o.price, remaining: o.units - o.filled, validUntil: o.validUntil })),
    });
  }
  const ordered = orderActions(perSeries);

  /* ---- transactions ---- */
  // A signer without the role can send nothing the vault accepts, cancels included: plan none (v2_mm_not_quoter pages).
  const txs: MmTx[] = [];
  const outflow = {
    cap: vault.limits.maxDailyOutflow,
    used: vault.outflow.used,
    released: bidEscrow,
    budget: outflowBudget,
    // planSizes answers in the order it was given, so sizes[i] is sizeInput[i].
    planned: sizes.reduce((sum, s, i) => sum + bidEscrowOf(sizeInput[i]?.bidPrice ?? 0n, s.bid), 0n),
    blocked: sizes.some((s) => s.capped.includes('outflow')),
  };
  if (!vault.isQuoter) {
    return { selected: selectedInfo.map((s) => s.longId), netDelta, series: plans, txs, capped: [], outflow: { ...outflow, planned: 0n } };
  }
  const cancels = ordered.filter((a): a is Extract<MmAction, { type: 'cancel' }> => a.type === 'cancel');
  const ids = cancels.flatMap((c) => c.orderIds.map((id) => ({ id, longId: c.longId, reason: c.reason })));
  for (let i = 0; i < ids.length; i += CANCEL_CHUNK) {
    const part = ids.slice(i, i + CANCEL_CHUNK);
    txs.push({
      type: 'cancel',
      orderIds: part.map((p) => p.id),
      longIds: [...new Set(part.map((p) => key(p.longId)))].map((k) => BigInt(k)),
      reason: [...new Set(part.map((p) => p.reason))].join(' | '),
    });
  }

  if (housekeeping) {
    const cappedByTotal = sizes.some((s) => s.capped.includes('total-notional'));
    const stale = vault.tracked.filter((t) => t.measured !== null && t.measured < t.stored).map((t) => t.longId);
    const due = input.lastSync === null || now - input.lastSync >= params.syncIntervalS;
    if (stale.length > 0 && (due || cappedByTotal)) {
      for (let i = 0; i < stale.length; i += SYNC_CHUNK) {
        txs.push({ type: 'sync', longIds: stale.slice(i, i + SYNC_CHUNK), reason: `${stale.length} series store more notional than they measure${cappedByTotal ? ' (a quote is capped by total notional)' : ''}` });
      }
    }
    for (const view of input.series) {
      const pair = closePair(view);
      if (pair > 0n) txs.push({ type: 'close', longId: view.info.longId, units: pair, reason: `${pair} units held long and short: free their collateral` });
    }
    if (vault.owed > 0n) txs.push({ type: 'claimOwed', amount: vault.owed, reason: `the book owes the vault ${vault.owed}` });
    if (params.depositTokens) {
      for (const [asset, amount] of vault.walletTokens) {
        if (amount > 0n) txs.push({ type: 'deposit', asset, amount, reason: `${amount} of ${asset} idle in the vault wallet: write collateral` });
      }
    }
  }
  if (!input.killed) {
    for (const a of ordered) if (a.type === 'replace' || a.type === 'place') txs.push(a);
  }

  return {
    selected: selectedInfo.map((s) => s.longId),
    netDelta,
    series: plans,
    txs,
    capped: sizes.filter((s) => s.capped.length > 0).map((s) => ({ longId: s.longId, caps: s.capped })),
    outflow,
  };
}

/**
 * The booked vault calls of a plan, in execution order, as the outflow bucket will see them (outflow.ts): the escrow a
 * Bid place pays out, the NET of a Bid replace, and the escrow a cancel of a live Bid hands back. Nothing else the bot
 * sends is booked. `live` is every vault order the tick read, by order id, so a cancel knows what it releases.
 */
export function bookedCalls(
  plan: TickPlan,
  live: ReadonlyMap<string, { kind: LiveOrder['kind']; price: bigint; remaining: bigint }>,
): Array<{ index: number; what: string; delta: bigint }> {
  const out: Array<{ index: number; what: string; delta: bigint }> = [];
  plan.txs.forEach((tx, index) => {
    if (tx.type === 'cancel') {
      const back = tx.orderIds.reduce((sum, id) => {
        const o = live.get(id.toString());
        return o === undefined || o.kind !== 'Bid' ? sum : sum + bidEscrowOf(o.price, o.remaining);
      }, 0n);
      if (back > 0n) out.push({ index, what: `cancel ${tx.orderIds.join(',')}`, delta: -back });
    } else if (tx.type === 'replace' && tx.slot === 'bid') {
      const o = live.get(tx.orderId.toString());
      const before = o === undefined ? bidEscrowOf(tx.fromPrice, tx.fromUnits) : bidEscrowOf(o.price, o.remaining);
      out.push({ index, what: `replace ${tx.orderId}`, delta: bidEscrowOf(tx.price, tx.units) - before });
    } else if (tx.type === 'place' && tx.slot === 'bid') {
      out.push({ index, what: `place bid on ${tx.longId}`, delta: bidEscrowOf(tx.price, tx.units) });
    }
  });
  return out;
}

/** How many of a plan's series quote both sides (a bid and at least one ask target). */
export function twoSidedCount(plan: TickPlan): number {
  return plan.series.filter((s) => s.targets !== null && s.targets.bid !== null && (s.targets.write !== null || s.targets.resale !== null)).length;
}
