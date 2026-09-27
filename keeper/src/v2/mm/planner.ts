/**
 * One MM tick, decided: from everything the tick read (TickInput) to the vault transactions it sends and the /state
 * view it reports. Pure: quoter.ts reads the chain and the pricing service into a TickInput, calls these, and sends.
 *
 *   selectedSeries   which series are quoted (engine.selectSeries over the managed series of the quoted markets)
 *   fairRequests     which series need a /fair answer: every selected series not halted before fair, and every
 *                    series with inventory (its delta counts towards the net delta even while it is not quoted)
 *   planTick         net delta per market → per series halt, prices (engine.quotePrices), sizes (risk.planSizes in
 *                    selection order), targets → vault calls (engine.planSeriesActions), plus housekeeping:
 *                    close long/short pairs, claim owed USDG, move wallet Stock Tokens into the ledger, and sync
 *                    the stored exposure of series whose stored notional is above the measured one
 *
 * EXECUTION ORDER of the returned transactions: cancels (chunked, CANCEL_CHUNK ids per call), sync, closes, claimOwed,
 * deposits, replaces (shrinking before growing), places. Cancels free escrow and lower stored
 * exposure, sync lowers stored notional, closes and deposits free collateral, so every later call meets the most room
 * under the guards.
 *
 * SAFEST ASK: the ask is shaped in engine.quotePrices (P3 vol markup at askIv or MM_VOL_MARKUP_PTS,
 * P4 intrinsic buffer, P5 minimum premium), selection ranks by the P16 delta band, planSizes caps each expiry's notional
 * (P13), risk.gateGreeks stops the side of a series that would push its market's |net delta| or |net gamma| past its
 * limit (P14), and pnl.mtmLossStop halts everything `loss-stop` when today's realised result plus the mark-to-market of
 * the open ledger positions reaches −MM_DAILY_MTM_LOSS_LIMIT_USDG6 (P18). Vega and gamma come from /fair when it sent
 * them, else from Black-Scholes at the fair's iv (engine.localGreeks).
 *
 * SAFE CALL SELLING, on top of the market halts and the engine's fair checks:
 *   - the spot-lag floor (mm/spot-lag.ts): each priced series is quoted a second time at the fair value at the spot the
 *     market can be at before the oracle prints, and keeps the higher ask; that value grossed per slot is the floor no
 *     live ask may stay under (engine.judgeReplace);
 *   - fair-before-open: haltContext hands the engine this session's open while MM_FAIR_FROM_SESSION=1;
 *   - the write stop: from MM_WRITE_STOP_MINUTES before the mint cutoff the series offers no AskWrite (`writeHold`;
 *     bids and inventory resales carry on), and no AskWrite placed before it is valid past it.
 * `sessionOpenedAt` is REQUIRED while MM_FAIR_FROM_SESSION=1, for the same reason as the four inputs below.
 *
 * KILLED: every managed series is halted `killed` (all its orders cancelled) and no housekeeping is planned. The
 * kill switch itself (quoter.ts) also cancels orders on markets the bot does not manage.
 * NOT QUOTER (the AccessManager no longer admits the signer's `place` on the vault, whether because the role was
 * revoked or because its calls now carry an execution delay): nothing is planned at all, since the vault refuses
 * even a cancel.
 */
import { CANCEL_CHUNK, SYNC_CHUNK, UNITS_PER_SHARE } from './constants.js';
import { windDownAction, type EpochView } from './epoch.js';
import { bidEscrowOf, budgetFor } from './outflow.js';
import {
  fairAtSpot,
  fairCheckOf,
  haltBeforeFair,
  haltOf,
  intrinsicOf,
  isLiveOrder,
  localGreeks,
  mintCutoffOf,
  moveBps,
  safestAskOf,
  netDeltaByUnderlying,
  orderActions,
  planSeriesActions,
  quoteLifeOf,
  quoteValidUntil,
  quotePrices,
  selectSeries,
  validUntilAt,
  writeStopAtOf,
  type AskFloors,
  type FairInput,
  type Halt,
  type LiveOrder,
  type MmAction,
  type NetDelta,
  type QuoteParams,
  type QuoteFees,
  type QuotePrices,
  type SeriesInfo,
  type Slot,
  type SlotTarget,
} from './engine.js';
import { maxWriteUnits, remainingLife } from '../mintFee.js';
import { crossesProtocol, type ProtocolBook, type ProtocolResting } from './protocol-accounts.js';
import { mtmLossStop, type LossStop, type MtmStop } from './pnl.js';
import { gateGreeks, marketGreeksOf, planSizes, type SeriesSizes, type SizeCap, type SizeSeries } from './risk.js';
import { spotLagOf, spotLagOn, withSpotLag, type SpotLagQuote } from './spot-lag.js';

/*//////////////////////////////////////////////////////////////
                              INPUT
//////////////////////////////////////////////////////////////*/

export interface MmPlanParams extends QuoteParams {
  maxSeries: number;
  maxSeriesPerMarket: number;
  bidUnits: bigint;
  askUnits: bigint;
  /**
   * Hold the ask while another maker's live ask rests on the series (halt `other-asker`, bids untouched).
   * Only an ask that can fill, for at least STEP_ASIDE_MIN_UNITS, at or below the bot's ask (stepAsideAsks).
   * Optional on the type so fixtures elsewhere keep compiling; ABSENT MEANS ON, the default (config.ts).
   */
  askFallbackOnly?: boolean;
  /** The per-asset write pool the asks are sized against, bps of free; absent = 10_000, the exact budget. */
  writeOversubscribeBps?: number;
  maxSeriesUnits: bigint;
  maxTotalNotionalUsdg6: bigint;
  deltaAlertShares: number;
  syncIntervalS: number;
  depositTokens: boolean;
  /** MM_MAX_QUOTE_LIFETIME_S: the longest validUntil a new quote gets, whatever the vault allows (0 = none). */
  maxQuoteLifetimeS: number;
  /** Seconds of lead before vault epochEnd during which the plan opens no new risk. Runtime-populated. */
  epochWindDownS: number;
  /*
   * (engine.SafestAsk): optional on the type, AT THEIR DEFAULTS when absent (engine.safestAskOf), never off.
   * The P3/P4/P5/P16 knobs are on QuoteParams.
   */
  /** P14: MM_MAX_DELTA_SHARES (0 = off). */
  maxDeltaShares?: number;
  /** P14: MM_MAX_GAMMA (0 = off). */
  maxGamma?: number;
  /** P13: MM_MAX_EXPIRY_NOTIONAL_USDG6 (0n = off). */
  maxExpiryNotionalUsdg6?: bigint;
  /** P18: MM_DAILY_MTM_LOSS_LIMIT_USDG6 (0n = off). */
  dailyMtmLossLimitUsdg6?: bigint;
  /*
   * Safe call selling. REQUIRED on the type, so no fixture and no refactor can leave one
   * out and quietly quote without it; each has an explicit off value.
   */
  /** MM_SPOT_LAG_BPS: the spot band of a print at most 30 min old (mm/spot-lag.ts). With spotLagStaleBps, 0 = off. */
  spotLagBps: number;
  /**
   * MM_SPOT_LAG_STALE_BPS: the band of an older print, a FLOOR under the market's live oracle band: the
   * floor prices at the wider of this and the series' SeriesView.oracleBandBps.
   */
  spotLagStaleBps: number;
  /** MM_FAIR_FROM_SESSION: halt fair-before-open when, in session, the fair's chain predates the open. */
  fairFromSession: boolean;
  /** MM_WRITE_STOP_MINUTES: no AskWrite from this long before the mint cutoff (0 = the cutoff itself). */
  writeStopMinutes: number;
}

export interface VaultLimits {
  maxSeriesUnits: bigint;
  maxTotalNotional: bigint;
  askToleranceBps: number;
  maxBidBpsOfSpot: number;
  maxOrderLifetime: number;
  /** INTERFACE_VERSION 7: USDG the quoter may pay out net at once; refills linearly per OUTFLOW_WINDOW. */
  maxDailyOutflow: bigint;
}

export interface VaultView {
  isQuoter: boolean;
  /** AccessManager.canCall's `delay` for (signer, vault, place): >0 with isQuoter false = member but delayed. */
  quoterDelay: number;
  tradingPaused: boolean;
  /**
   * `HouseVault.quotingPaused()` (reads.VaultState.quotingPaused): while set, the vault's place and replace
   * revert TradingPaused and every series halts `quoting-paused`, which cancels its resting orders (cancel is not
   * braked). Absent or null = no such brake: a treasury MakerVault.
   */
  quotingPaused?: boolean | null;
  /**
   * OrderBook.feeParams() and pendingFeeParams() as this tick read them. It lives HERE and not in
   * `MmPlanParams` on purpose: `MmPlanParams` is static env configuration built once at boot, and the
   * seller fee is per-tick CHAIN STATE that an admin can change under the bot.
   */
  fees: QuoteFees;
  limits: VaultLimits;
  /** MakerVault.outflow(): the leaky bucket now. */
  outflow: { used: bigint; available: bigint };
  /** MakerVault.totalNotional (stored). */
  totalNotional: bigint;
  /** USDG in the vault's wallet. */
  usdgWallet: bigint;
  /**
   * USDG in that wallet which belongs to OTHER PEOPLE on a House vault:
   * `HouseVault.pendingDepositUsdg() + owedUsdg()`, read in the same pinned multicall as `usdgWallet`. No bid may
   * escrow it, so it comes out of the bid budget. `null` = treasury MakerVault (no such getters). REQUIRED, with no
   * default: a House vault planned without it would treat depositor money as free (`vault.usdgReserved` below).
   * NOT `owed`, which is OrderBook.owed(vault) -- USDG the book owes TO the vault.
   */
  usdgReserved: bigint | null;
  /** OrderBook.owed(vault). */
  owed: bigint;
  /** Clearinghouse.free(vault, asset), lower-case asset. */
  freeCollateral: ReadonlyMap<string, bigint>;
  /** Stock Token balances of the vault's wallet, lower-case token (the quoted markets only). */
  walletTokens: ReadonlyMap<string, bigint>;
  /** The free / balanceOf reads that failed (reads.MarketsRead.balancesUnread); their 0n above is not measured. */
  balancesUnread?: readonly string[];
  /**
   * The part of `walletTokens` that belongs to OTHER PEOPLE, lower-case token: on a House vault its own
   * underlying's `pendingDepositStock() + owedStock()` (reads.VaultState.stockReserved). `HouseVault
   * .depositToClearinghouse` clamps a deposit to the balance less this and reverts BadUnits when nothing is left, so the
   * planner deposits only the rest. Absent, or a token not in it = nothing reserved (a treasury MakerVault).
   */
  walletReserved?: ReadonlyMap<string, bigint>;
  /** MakerVault.trackedSeries with the stored and the measured notional of each, and whether anything is held in it
   *  (exposure detail longs, shorts, live; null when unreadable, absent when not read). */
  tracked: ReadonlyArray<{ longId: bigint; stored: bigint; measured: bigint | null; held?: boolean | null }>;
  /**
   * (N3). Settled Clearinghouse tokens the TREASURY MakerVault still holds (reads.readSettledHoldings), one per
   * token id with a non-zero balance. The planner redeems each through `MakerVault.redeem(tokenId)`, because once the
   * vault opts out of third-party redemption the cranker's `redeemBatch` skips it silently. Set by the quoter
   * on the treasury MakerVault only: a House vault has no `redeem` and an EarnVault's is a different function.
   * Optional: absent reads as none, which plans exactly what the planner did before.
   */
  settledHeld?: ReadonlyArray<{ tokenId: bigint; longId: bigint; units: bigint }>;
  /**
   * Vault epoch as the runtime read it. `null` = treasury MakerVault: unrestricted (today's behaviour).
   * `epochEnd` is a UNIX second from the vault; never derived here.
   */
  epoch: EpochView | null;
}

export interface MarketView {
  /** Lower-case Stock Token. */
  underlying: string;
  ticker: string;
  enabled: boolean;
  mintPaused: boolean;
  /** The market oracle's spot when trySpot is ok, else null. */
  spot: bigint | null;
  /**
   * This tick's market-safety halt (P7 spot-age, P8
   * open-grace, P15 spot-move-breaker; engine.marketSafetyHalt), set by mm/quoter.ts. Every series of the market halts
   * with it and its resting orders, asks included, are cancelled. Absent or null = none.
   */
  halt?: Halt | null;
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
  /** trySpot's `updatedAt` with `spot` (the source-0 print's time); null or absent = unknown, priced as a stale print. */
  spotUpdatedAt?: number | null;
  /**
   * The pinned oracle's marketConfig(underlying).maxDeviationBps this tick, the band it accepts a print older
   * than SPOT_CORROBORATION_AGE within (settable per market, SettlementOracle.setMarket). The spot-lag floor prices an
   * old print at the wider of it and MM_SPOT_LAG_STALE_BPS (mm/spot-lag.ts). Null or absent = unread: the env alone.
   */
  oracleBandBps?: number | null;
  /** MakerVault.exposure detail; null when unreadable. */
  exposure: ExposureDetail | null;
  /** MakerVault.seriesNotional (stored). */
  seriesNotional: bigint;
  /** The seriesNotional read failed (seriesNotional is then 0n and must not be summed as known). */
  seriesNotionalUnread?: boolean;
  /**
   * The vault's askFloorOf(longId, true) and (longId, false), as one pair; null when either reverts (stale spot) or
   * fails. bidCap likewise. Both vault kinds answer askFloorOf; only MakerVault has askFloor(uint256).
   */
  askFloors: AskFloors | null;
  bidCap: bigint | null;
  /**
   * The guard reads that failed this tick (`askFloorOf(longId,true)`, `bidCap(longId)`, `exposure(longId)` ...),
   * each with its error, so a `guards-unreadable` halt names the call that caused it (v2_mm_guards_unreadable, /state).
   * Absent or empty = every guard read answered.
   */
  guardFailures?: readonly string[];
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
  /** No replace for a live quote expiring sooner than this (engine.ts SeriesActionInput.replaceMarginS). */
  replaceMarginS?: number;
  /**
   * How far ahead of `now` a quoted bid is capped (mm/spot-lag.ts bidCapAhead), never past the validUntil a new
   * bid gets. The quoter passes two routine sends ahead, 2 x (MM_SEND_INTERVAL_S + one read), so theta alone cannot lift a
   * bid over the cap before the send after next. Absent or 0: the cap now (a bid at it is over it one read later).
   */
  bidCapAheadS?: number;
  /** Protocol-owned makers (lower-case). Runtime-populated; empty = no protocol-cross check. */
  protocolAccounts: ReadonlySet<string>;
  /** Resting book of other makers this tick, for protocol-cross. Runtime-populated. */
  protocolBook: readonly ProtocolResting[];
  /**
   * Live asks from makers OTHER than the vault, by decimal longId (reads.readOtherAskers). Runtime-populated;
   * an absent series counts as having none. Only consulted when `params.askFallbackOnly`.
   */
  otherAskers?: ReadonlyMap<string, ReadonlyArray<OtherAskInput>>;
  /**
   * The 09:30 open of the session `now` is in (pricing/bs.ts sessionOpenOf), null outside a session or when an open
   * session cannot be placed. REQUIRED while `params.fairFromSession` (undefined is refused).
   */
  sessionOpenedAt?: number | null;
}

/*//////////////////////////////////////////////////////////////
                             OUTPUT
//////////////////////////////////////////////////////////////*/

/** `protective` as on engine.MmAction: absent = routine, sent only on a vault's routine send. */
export type MmTx =
  | { type: 'cancel'; orderIds: bigint[]; longIds: bigint[]; reason: string; protective?: true }
  | Extract<MmAction, { type: 'replace' | 'place' }>
  | { type: 'sync'; longIds: bigint[]; reason: string }
  | { type: 'close'; longId: bigint; units: bigint; reason: string }
  | { type: 'claimOwed'; amount: bigint; reason: string }
  /** (N3): MakerVault.redeem(tokenId) of a settled long or short the vault holds. Not booked (only brings value in). */
  | { type: 'redeem'; tokenId: bigint; longId: bigint; units: bigint; reason: string }
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
  /** The spot-lag floor this tick (mm/spot-lag.ts), or null when off or unpriced. */
  lag: SpotLagQuote | null;
  /** Why the series offers no AskWrite (its bid and resale carry on), or null. */
  writeHold: { hold: 'write-cutoff'; detail: string } | null;
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
  /** P18: the mark-to-market stop as this tick judged it (planTick always sets it; absent on a plan built elsewhere). */
  mtm?: MtmStop;
  /** The vault's daily outflow cap as this tick planned against it (INTERFACE_VERSION 7). */
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

/*//////////////////////////////////////////////////////////////
                        SAFETY INPUTS ARE REQUIRED
//////////////////////////////////////////////////////////////*/

/**
 * The four safety inputs used to be read behind permissive defaults:
 * `vault.epoch ?? null` (an ABSENT epoch became "unrestricted"), `params.epochWindDownS ?? 0` (no wind-down),
 * `protocolAccounts ?? new Set()` and `protocolBook ?? []` (no protocol-cross check). The types already declare all
 * four required, so every TypeScript caller supplies them (the runtime is wired), which is exactly why the
 * defaults were dangerous: they could only ever fire for a caller the compiler did not see -- a refactor that drops
 * an argument, a JS shim, a `as TickInput` cast -- and when they fired, the loss-stop / wind-down / exclusion set
 * went inert while every test stayed green. A safety predicate that defaults to "off" when its input is missing is
 * the fail-open shape this workspace keeps paying for.
 *
 * So the inputs are REQUIRED at the entry points that read them. `null` is still a legal `epoch` (a treasury
 * MakerVault is unrestricted by design, see {VaultView.epoch}); `undefined` is not. An empty `protocolAccounts`
 * set and an empty `protocolBook` are legal when the runtime says so explicitly; a missing one is not. The throw
 * names the input so the operator reads which wire came loose rather than a TypeError three frames down.
 */
type SafetyInput = 'vault.epoch' | 'vault.usdgReserved' | 'params.epochWindDownS' | 'protocolAccounts' | 'protocolBook' | 'sessionOpenedAt';

/** `sessionOpenedAt` is read only while fair-before-open is on (MM_FAIR_FROM_SESSION=1). */
const sessionInputs = (params: Partial<Pick<MmPlanParams, 'fairFromSession'>> | undefined): SafetyInput[] => (params?.fairFromSession === false ? [] : ['sessionOpenedAt']);

function missing(name: SafetyInput): never {
  throw new Error(`planner: required safety input "${name}" is missing; refusing to plan with a fail-open default (K8-05, F-APP-KEEPER-01)`);
}

function requireSafetyInputs(input: {
  vault?: Partial<Pick<VaultView, 'epoch' | 'usdgReserved'>>;
  params?: Partial<Pick<MmPlanParams, 'epochWindDownS'>>;
  protocolAccounts?: TickInput['protocolAccounts'];
  protocolBook?: TickInput['protocolBook'];
  sessionOpenedAt?: TickInput['sessionOpenedAt'];
}, which: readonly SafetyInput[]): void {
  for (const name of which) {
    switch (name) {
      case 'vault.epoch':
        if (input.vault === undefined || input.vault.epoch === undefined) missing(name);
        break;
      // Undefined for ANY vault is a loose wire. A House vault (epoch !== null) must carry a bigint: `null`
      // is the treasury's "no reserve" and would make depositor money spendable -- the hole this closes.
      case 'vault.usdgReserved':
        if (input.vault === undefined || input.vault.usdgReserved === undefined) missing(name);
        if (input.vault.epoch !== null && typeof input.vault.usdgReserved !== 'bigint') missing(name);
        break;
      case 'params.epochWindDownS':
        if (input.params === undefined || typeof input.params.epochWindDownS !== 'number' || !Number.isFinite(input.params.epochWindDownS)) missing(name);
        break;
      case 'protocolAccounts':
        if (!(input.protocolAccounts instanceof Set)) missing(name);
        break;
      case 'protocolBook':
        if (!Array.isArray(input.protocolBook)) missing(name);
        break;
      case 'sessionOpenedAt':
        if (input.sessionOpenedAt === undefined || (input.sessionOpenedAt !== null && !Number.isFinite(input.sessionOpenedAt))) missing(name);
        break;
    }
  }
}

/** The quoted series, in quoting priority. */
export function selectedSeries(input: Pick<TickInput, 'now' | 'series' | 'markets' | 'params' | 'vault'>): SeriesInfo[] {
  requireSafetyInputs(input, ['vault.epoch']);
  const spots = new Map<string, bigint>();
  for (const [u, m] of input.markets) if (m.spot !== null) spots.set(lc(u), m.spot);
  const candidates = input.series.filter((s) => !s.settled && input.markets.has(lc(s.info.underlying))).map((s) => s.info);
  const safest = safestAskOf(input.params);
  return selectSeries({
    now: input.now,
    candidates,
    spots,
    pullMinutes: input.params.pullMinutes,
    maxSeries: input.params.maxSeries,
    maxSeriesPerMarket: input.params.maxSeriesPerMarket,
    epoch: input.vault.epoch,
    // MM_DELTA_BAND_HI 0 is the explicit opt-out: the earlier nearest-the-money ranking.
    deltaBand: safest.deltaBandHi > 0 ? { lo: safest.deltaBandLo, hi: safest.deltaBandHi, vol: safest.selectVol } : null,
  });
}

function haltContext(input: Omit<TickInput, 'fairs'>, view: SeriesView, selected: boolean, mtmTripped = false) {
  const market = input.markets.get(lc(view.info.underlying));
  return {
    now: input.now,
    series: view.info,
    params: input.params,
    killed: input.killed,
    lossStopped: input.lossStop.tripped || mtmTripped,
    isQuoter: input.vault.isQuoter,
    tradingPaused: input.vault.tradingPaused,
    quotingPaused: input.vault.quotingPaused === true,
    sessionOpen: input.sessionOpen,
    marketEnabled: market?.enabled ?? false,
    marketQuoted: market !== undefined,
    spotFresh: view.spotFresh,
    marketHalt: market?.halt ?? null,
    selected,
    epoch: input.vault.epoch,
    epochWindDownS: input.params.epochWindDownS,
    // fair-before-open (engine.fairCheckOf): only while it is on, and never defaulted (required above).
    sessionOpenedAt: input.params.fairFromSession ? input.sessionOpenedAt : undefined,
  };
}

/** The series a /fair answer is needed for (decimal longIds, in series order). */
export function fairRequests(input: Omit<TickInput, 'fairs'>): SeriesView[] {
  requireSafetyInputs(input, ['vault.epoch', 'params.epochWindDownS', ...sessionInputs(input.params)]);
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

/**
 * USDG the tick may size bids from: `max(0, wallet + live bid escrow - reserve)`.
 *
 * The escrow is added back FIRST (the plan cancels or replaces every live bid before it places, so that escrow returns
 * to the wallet) and the reserve comes out of the SUM. That is the on-chain rule
 * `unreserved = max(0, walletBefore - (pendingDepositUsdg + owedUsdg))` (HouseVault._requireUnreservedSpend) applied to
 * the wallet once the cancels have landed. The tempting `max(0, wallet - reserve) + escrow` is WRONG exactly when the
 * wallet is already below the reserve -- the state an earlier version left behind, where live bids already hold depositor money:
 * wallet 10, escrow 30, reserve 50 must budget 0, and that form budgets 30. Saturating, because a negative budget
 * would size negative bid units (risk.ts). A treasury vault (reserve null) is unchanged: wallet + escrow.
 */
export function bidBudget(usdgWallet: bigint, liveBidEscrow: bigint, usdgReserved: bigint | null): bigint {
  const free = usdgWallet + liveBidEscrow - (usdgReserved ?? 0n);
  return free > 0n ? free : 0n;
}

/**
 * Another maker's live ask as reads.readOtherAskers reports it. `makerFree` (AskWrite only) is the maker's free
 * balance of the series' collateral asset; null = unread. An AskResale is backed by its escrowed longs.
 */
export interface OtherAskInput {
  id: bigint;
  maker: string;
  kind: 'AskWrite' | 'AskResale';
  price: bigint;
  remaining: bigint;
  makerFree?: bigint | null;
  /**
   * The ask is one of the bot's OWN vaults ranked above this one (a House vault's, to the treasury;
   * quoter.siblingRanks). It counts while it sits at most MM_REQUOTE_BPS above the bot's ask: that vault keeps a
   * resting ask inside that band rather than re-price it (engine.judgeReplace), so the treasury's fresh ask a tick under
   * it is the same quote, and resting it would move the House vault's fill to the fallback.
   */
  sibling?: boolean;
}

/**
 * The smallest FILLABLE size, in units (1/100 share), another maker's ask must offer before the vault's ask
 * steps aside for it: one whole share. Below this an ask is dust: a 0.01-share order would otherwise take the vault's
 * ask of last resort off the series and leave buyers of any real size with nothing to buy.
 */
export const STEP_ASIDE_MIN_UNITS = UNITS_PER_SHARE;

/**
 * How many units of another maker's ask can fill now, by the SAME rule the indexer serves the book with
 * (indexer/lib/v2/book.ts aggregateBook), so the bot and the app agree on whether a series has a buyable ask:
 *   - AskResale: its remaining units (the longs are escrowed at placement).
 *   - AskWrite: 0 once the mint is paused or the mint cutoff has passed; otherwise its remaining units capped at what
 *     the maker's free collateral can mint in one fill, rent included (mintFee.maxWriteUnits, the indexer's
 *     rentCapacity; parity pinned in planner.test.ts). An unread balance (null or absent) is 0: an ask nobody can show
 *     is backed does not take the vault's ask off the book.
 */
export function fillableUnits(
  ask: OtherAskInput,
  series: { expiry: number; collateralPerUnit: bigint; mintFeePpm: number },
  now: number,
  mintPaused: boolean,
): bigint {
  if (ask.remaining <= 0n) return 0n;
  if (ask.kind === 'AskResale') return ask.remaining;
  if (mintPaused || now >= mintCutoffOf(series.expiry)) return 0n;
  if (ask.makerFree === undefined || ask.makerFree === null || series.collateralPerUnit <= 0n) return 0n;
  const capacity = maxWriteUnits(ask.makerFree, series.collateralPerUnit, series.mintFeePpm, remainingLife(series.expiry, now));
  return capacity < ask.remaining ? capacity : ask.remaining;
}

/**
 * The other asks the vault's ask steps aside for: each must FILL (fillableUnits), for at least `minUnits`,
 * at a price at or below the ask the bot would quote this tick (`botAsk`, the write ask; its resale sits one tick
 * under). Anything else -- unbacked, overpriced or dust -- leaves the vault's ask on the book, which is what keeps the
 * "ask of last resort on every listed series" promise. No bot ask (null) means nothing to step aside for.
 */
export function stepAsideAsks(
  asks: readonly OtherAskInput[],
  botAsk: bigint | null,
  series: { expiry: number; collateralPerUnit: bigint; mintFeePpm: number },
  now: number,
  mintPaused: boolean,
  minUnits: bigint = STEP_ASIDE_MIN_UNITS,
  /** How far above `botAsk` a `sibling` ask still counts, in bps (the planner passes MM_REQUOTE_BPS). */
  siblingBandBps = 0,
): Array<OtherAskInput & { fillable: bigint }> {
  if (botAsk === null) return [];
  return asks
    .map((ask) => ({ ...ask, fillable: fillableUnits(ask, series, now, mintPaused) }))
    .filter((ask) => ask.fillable >= minUnits && (ask.price <= botAsk || (ask.sibling === true && moveBps(ask.price, botAsk) <= siblingBandBps)));
}

export function planTick(input: TickInput): TickPlan {
  requireSafetyInputs(input, ['vault.epoch', 'vault.usdgReserved', 'params.epochWindDownS', 'protocolAccounts', 'protocolBook', ...sessionInputs(input.params)]);
  const { now, params, vault } = input;
  const safest = safestAskOf(params);
  const selectedInfo = selectedSeries(input);
  const rank = new Map(selectedInfo.map((s, i) => [key(s.longId), i]));

  /* ---- net delta ---- */
  const okFair = (id: bigint) => {
    const f = input.fairs.get(key(id));
    return f !== undefined && f.ok ? f : null;
  };
  // Each series' greeks -- /fair's when it sent them, else Black-Scholes at its iv from the oracle's spot.
  const greeksOf = (view: SeriesView): { delta: number | null; gamma: number | null; vega: number | null } => {
    const f = okFair(view.info.longId);
    if (f === null) return { delta: null, gamma: null, vega: null };
    const local = view.spot !== null && view.spot > 0n ? localGreeks({ now, series: view.info, spot: view.spot, vol: f.iv }) : null;
    return { delta: f.delta, gamma: f.gamma ?? local?.gamma ?? null, vega: f.vega ?? local?.vega ?? null };
  };

  /* ---- P18: the mark-to-market stop, before any series is priced ---- */
  const marks = new Map<string, bigint | null>();
  for (const v of input.series) {
    const f = okFair(v.info.longId);
    const spot = v.spot !== null && v.spot > 0n ? v.spot : null;
    marks.set(key(v.info.longId), f !== null && f.fair > 0n ? (spot === null ? f.fair : fairAtSpot({ fair: f.fair, delta: f.delta, fairSpot: f.spot, spot })) : spot === null ? null : intrinsicOf(v.info, spot));
  }
  const mtm = mtmLossStop(input.lossStop, marks, safest.dailyMtmLossLimitUsdg6);
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
    lag: SpotLagQuote | null;
    writeHold: { hold: 'write-cutoff'; detail: string } | null;
  }
  const protocolBook: ProtocolBook = {
    protocolAccounts: input.protocolAccounts,
    resting: input.protocolBook,
  };
  const working: Working[] = input.series.map((view) => {
    const selected = rank.has(key(view.info.longId));
    const fairAnswer = input.fairs.get(key(view.info.longId));
    const context = haltContext(input, view, selected, mtm.tripped);
    let halt = haltOf({
      ...context,
      ...(fairAnswer === undefined ? {} : { fair: fairAnswer }),
      spot: view.spot,
      guardsOk: view.askFloors !== null && view.bidCap !== null && view.exposure !== null,
    });
    if (halt?.halt === 'loss-stop' && !input.lossStop.tripped && mtm.tripped) {
      halt = { halt: 'loss-stop', detail: `mark-to-market: realised ${mtm.realised} + unrealised ${mtm.unrealised} = ${mtm.total} at or below −${mtm.limit}` };
    }
    const fair = fairAnswer !== undefined && fairAnswer.ok ? fairAnswer : null;
    let prices: QuotePrices | null = null;
    let lag: SpotLagQuote | null = null;
    // epoch-winddown still prices: AskResale may unwind. epoch-outside does not (no /fair).
    const priceHalt = halt === null || halt.halt === 'epoch-winddown';
    if (priceHalt && fair !== null && view.askFloors !== null && view.bidCap !== null && view.spot !== null) {
      // Priced at the pricing service's spot, quoted at the oracle's (within MM_FAIR_SPOT_TOLERANCE_BPS).
      // Every fair that prices passes fairCheckOf, the SAME checks haltOf runs, because epoch-winddown reaches
      // this branch from haltBeforeFair without haltOf ever looking at the fair (an earlier fix had carried over only the zero
      // case). Stale, spot-mismatched, zero or out-of-bounds: the series halts instead of resting an ask.
      const checked = fairCheckOf({ ...context, fair, spot: view.spot });
      if (checked.halt !== null) halt = checked.halt;
      else if (checked.quoted === null) halt = { halt: 'fair-unavailable', detail: `no positive oracle spot to quote at (${view.spot})` };
      else {
        const priceArgs = {
          now,
          series: view.info,
          fair: checked.quoted,
          delta: fair.delta,
          // The shaping inputs: both quotes below (at the fair and at the lag fair) are shaped the same way.
          iv: fair.iv,
          askIv: fair.askIv ?? null,
          vega: greeksOf(view).vega,
          spot: view.spot,
          netDeltaShares: byUnderlying.get(lc(view.info.underlying))?.deltaShares ?? 0,
          askFloors: view.askFloors,
          bidCap: view.bidCap,
          fees: input.vault.fees,
          params,
        };
        prices = quotePrices(priceArgs);
        // The spot-lag floor: the same quote at the fair value where the market can already be, the higher ask kept.
        // A wind-down's resale ask is an ask too, so it is on this path for the same reason as fairCheckOf.
        if (spotLagOn(params)) {
          // The bid is capped at its value bidCapAheadS ahead, never past the validUntil a new bid gets below
          // (the same quoteValidUntil call), so theta alone does not lift it over the cap before the send after next.
          const ahead = input.bidCapAheadS ?? 0;
          const bidUntil = ahead > 0 ? quoteValidUntil({ now, expiry: view.info.expiry, slot: 'bid', pullMinutes: params.pullMinutes, sessionClose: params.quoteOffHours ? null : input.sessionClose, maxOrderLifetime: vault.limits.maxOrderLifetime, maxQuoteLifetime: params.maxQuoteLifetimeS }) : null;
          const bidAt = ahead > 0 ? Math.min(now + ahead, bidUntil ?? now) : null;
          // The vault's floors as read, so the ask cushion also covers the floor the next print can put up.
          const vaultFloor = view.askFloors === null ? null : { askFloors: view.askFloors, askToleranceBps: vault.limits.askToleranceBps };
          const floor = spotLagOf({ now, series: view.info, fair, spot: view.spot, spotUpdatedAt: view.spotUpdatedAt ?? null, oracleBandBps: view.oracleBandBps ?? null, fees: input.vault.fees, params, bidAt, vaultFloor });
          if (floor === null) {
            prices = null;
            halt = { halt: 'fair-unavailable', detail: `no spot-lag floor for vol ${fair.iv} at spot ${view.spot}: not quoted without it` };
          } else {
            const merged = withSpotLag(prices, quotePrices({ ...priceArgs, fair: floor.lagFair }), floor);
            prices = merged.prices;
            lag = merged.lag;
          }
        }
      }
    }
    const writeStopAt = writeStopAtOf(view.info.expiry, params.writeStopMinutes);
    const writeHold = prices !== null && now >= writeStopAt ? { hold: 'write-cutoff' as const, detail: `no AskWrite from ${writeStopAt}, ${params.writeStopMinutes} min before the mint cutoff` } : null;
    return { view, selected, halt, fair, fairReason: fairAnswer !== undefined && !fairAnswer.ok ? fairAnswer.reason : null, prices, lag, writeHold };
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
  // MM_ASK_FALLBACK_ONLY: the vault's ask is the FALLBACK. While another maker's FILLABLE ask rests on the
  // series the ask side is not sized (so it does not spend the write pool) and not placed, and a resting vault ask
  // is cancelled by the null target below; bids are untouched. The vault's OWN resting ask is never an "other
  // asker" (reads.readOtherAskers drops it), or the ask would flap every tick. Protocol accounts count.
  const fallbackOnly = params.askFallbackOnly ?? true;
  // Only asks that can fill, for at least STEP_ASIDE_MIN_UNITS, at or below the bot's ask count
  // (stepAsideAsks), plus a higher-ranked own vault's up to MM_REQUOTE_BPS above it. Computed once per series from
  // the bot's quoted ask; a series the bot does not price has none.
  const stepAside = new Map<string, Array<OtherAskInput & { fillable: bigint }>>();
  for (const w of working) {
    if (!fallbackOnly || w.prices === null) continue;
    const asks = input.otherAskers?.get(key(w.view.info.longId)) ?? [];
    if (asks.length === 0) continue;
    const market = input.markets.get(lc(w.view.info.underlying));
    const qualified = stepAsideAsks(asks, w.prices.ask, { expiry: w.view.info.expiry, collateralPerUnit: w.view.collateralPerUnit, mintFeePpm: w.view.mintFeePpm }, now, market === undefined || market.mintPaused, STEP_ASIDE_MIN_UNITS, params.requoteBps);
    if (qualified.length > 0) stepAside.set(key(w.view.info.longId), qualified);
  }
  const otherAskOn = (longId: bigint) => stepAside.get(key(longId)) ?? [];
  // P14: the greek gate, in quoting priority, from each market's inventory greeks. A refused side is not sized
  // (so it spends no budget) and its resting orders lose their target, which cancels them.
  const marketGreeks = marketGreeksOf(
    input.series
      .filter((v) => now < v.info.expiry && !v.settled)
      .map((v) => ({ underlying: v.info.underlying, units: inventoryOf(v.exposure), ...greeksOf(v) })),
  );
  const greekRefused = new Map<string, { bid: boolean; ask: boolean; reasons: string[] }>();
  for (const w of quoted) {
    const u = lc(w.view.info.underlying);
    const market = marketGreeks.get(u) ?? { delta: { lo: 0, hi: 0 }, gamma: { lo: 0, hi: 0 } };
    marketGreeks.set(u, market);
    const g = greeksOf(w.view);
    const gate = gateGreeks({ market, delta: g.delta, gamma: g.gamma, bidUnits: params.bidUnits, askUnits: params.askUnits, limits: { maxDeltaShares: safest.maxDeltaShares, maxGamma: safest.maxGamma } });
    if (!gate.bid || !gate.ask) greekRefused.set(key(w.view.info.longId), gate);
  }
  const gateOf = (longId: bigint) => greekRefused.get(key(longId)) ?? { bid: true, ask: true, reasons: [] };
  // P13: the stored notional of every managed series, by expiry.
  const expiryNotional = new Map<number, bigint>();
  for (const v of input.series) if (!v.settled) expiryNotional.set(v.info.expiry, (expiryNotional.get(v.info.expiry) ?? 0n) + v.seriesNotional);
  // An expiry with a series whose stored notional could not be read has an unknown sum.
  const expiryNotionalUnread = new Set(input.series.filter((v) => !v.settled && v.seriesNotionalUnread === true).map((v) => v.info.expiry));
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
      bidPrice: gateOf(w.view.info.longId).bid ? w.prices!.bid : null,
      askPrice: otherAskOn(w.view.info.longId).length > 0 || !gateOf(w.view.info.longId).ask ? null : w.prices!.ask,
      // The write stop leaves only inventory on offer, exactly as a paused mint does.
      writeAllowed: market !== undefined && !market.mintPaused && w.writeHold === null,
    };
  });
  // The outflow cap: every live bid's escrow comes back before a place runs (a cancel credits it, a replace
  // books the net), so the room for new bid escrow is the cap less what the credits cannot cancel out.
  const outflowBudget = budgetFor({ cap: vault.limits.maxDailyOutflow, used: vault.outflow.used, released: bidEscrow });
  const usdgBudget = bidBudget(vault.usdgWallet, bidEscrow, vault.usdgReserved);
  const sizes = planSizes(sizeInput, {
    now,
    vaultMaxSeriesUnits: vault.limits.maxSeriesUnits,
    botMaxSeriesUnits: params.maxSeriesUnits,
    vaultMaxTotalNotional: vault.limits.maxTotalNotional,
    botMaxTotalNotional: params.maxTotalNotionalUsdg6,
    totalNotional: vault.totalNotional,
    usdgBudget,
    outflowBudget,
    freeCollateral: vault.freeCollateral,
    writeOversubscribeBps: params.writeOversubscribeBps,
    bidUnits: params.bidUnits,
    askUnits: params.askUnits,
    maxExpiryNotional: safest.maxExpiryNotionalUsdg6,
    expiryNotional,
    expiryNotionalUnread,
  });
  for (const s of sizes) {
    const gate = greekRefused.get(key(s.longId));
    if (gate === undefined) continue;
    const caps: SizeCap[] = gate.reasons.map((r) => (r.includes('gamma') ? 'gamma' : 'delta'));
    s.capped = [...new Set([...s.capped, ...caps])];
  }
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
      if (w.halt?.halt === 'epoch-winddown') {
        const wd = windDownAction(view);
        if (!wd.bid) targets.bid = null;
        if (!wd.write) targets.write = null;
        if (!wd.resale) targets.resale = null;
      }
      let crossed = false;
      if (targets.bid !== null && crossesProtocol({ longId: view.info.longId, side: 'bid', price: targets.bid.price }, protocolBook)) {
        targets.bid = null;
        crossed = true;
      }
      if (targets.write !== null && crossesProtocol({ longId: view.info.longId, side: 'ask', price: targets.write.price }, protocolBook)) {
        targets.write = null;
        crossed = true;
      }
      if (targets.resale !== null && crossesProtocol({ longId: view.info.longId, side: 'ask', price: targets.resale.price }, protocolBook)) {
        targets.resale = null;
        crossed = true;
      }
      if (crossed && w.halt === null) w.halt = { halt: 'protocol-cross' };
      const others = otherAskOn(view.info.longId);
      if (others.length > 0) {
        // Sized with askPrice null above, so write and resale are already 0; nulled here too so the halt reason
        // is the one /state shows and a resting vault ask is cancelled by the actions planner.
        targets.write = null;
        targets.resale = null;
        if (w.halt === null) {
          // Name each qualifying ask (id, maker, fillable units at price), so /state shows WHY the bot stepped aside.
          const named = others.map((o) => `#${o.id} ${o.kind} ${o.maker} ${o.fillable}u@${o.price}`);
          w.halt = { halt: 'other-asker', detail: `${others.length} fillable ask${others.length === 1 ? '' : 's'} at or below the vault's ask: ${named.join(', ')}; the vault's ask is the fallback` };
        }
      }
    }
    const writeStopAt = writeStopAtOf(view.info.expiry, params.writeStopMinutes);
    // Each slot's life rides on its places, so the quoter stamps validUntil from the chain time at send; the
    // validUntil planned here (the same function at the tick's head time) is what the replace judgement reads.
    const lifeOf = (slot: Slot) =>
      // `now` is the head's timestamp, so the vault's maxOrderLifetime is anchored at a block time (engine.ts).
      quoteLifeOf({ expiry: view.info.expiry, slot, pullMinutes: params.pullMinutes, sessionClose, maxOrderLifetime: vault.limits.maxOrderLifetime, maxQuoteLifetime: params.maxQuoteLifetimeS, writeStopAt, now });
    const life = { bid: lifeOf('bid'), write: lifeOf('write'), resale: lifeOf('resale') };
    const until = (slot: Slot) => validUntilAt(life[slot], now);
    perSeries.push(
      planSeriesActions({
        longId: view.info.longId,
        now,
        orders: view.orders,
        targets,
        haltReason: w.halt === null ? (targets === null ? 'not quoted' : undefined) : `${w.halt.halt}${w.halt.detail === undefined ? '' : `: ${w.halt.detail}`}`,
        validUntil: { bid: until('bid'), write: until('write'), resale: until('resale') },
        life,
        askFloors: view.askFloors,
        bidCap: view.bidCap ?? 0n,
        refreshS: input.refreshS,
        replaceMarginS: input.replaceMarginS,
        params,
        safeFloor: w.lag?.floor ?? null,
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
      lag: w.lag,
      writeHold: w.writeHold,
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
    return { selected: selectedInfo.map((s) => s.longId), netDelta, series: plans, txs, capped: [], mtm, outflow: { ...outflow, planned: 0n } };
  }
  const cancels = ordered.filter((a): a is Extract<MmAction, { type: 'cancel' }> => a.type === 'cancel');
  // Protective cancels are chunked apart from routine ones (reclaims, refreshes), and first, so a read between
  // routine sends can send exactly the protective ones.
  for (const protective of [true, false]) {
    const ids = cancels.filter((c) => (c.protective === true) === protective).flatMap((c) => c.orderIds.map((id) => ({ id, longId: c.longId, reason: c.reason })));
    for (let i = 0; i < ids.length; i += CANCEL_CHUNK) {
      const part = ids.slice(i, i + CANCEL_CHUNK);
      txs.push({
        type: 'cancel',
        orderIds: part.map((p) => p.id),
        longIds: [...new Set(part.map((p) => key(p.longId)))].map((k) => BigInt(k)),
        reason: [...new Set(part.map((p) => p.reason))].join(' | '),
        ...(protective ? { protective: true as const } : {}),
      });
    }
  }

  if (housekeeping) {
    const cappedByTotal = sizes.some((s) => s.capped.includes('total-notional'));
    // Also every tracked series that holds nothing, whatever it stores. A HouseVault series leaves _tracked
    // only when a re-measure finds nothing held, so a flat series already storing 0 (a matched pair held
    // through settlement, then redeemed) would otherwise stay tracked forever and every rollEpoch and depositNow would
    // walk it (~38k gas each, HouseVaultRollGas.t.sol). A MakerVault untracks at zero notional, so there it adds nothing.
    const over = vault.tracked.filter((t) => t.measured !== null && t.measured < t.stored);
    const flat = vault.tracked.filter((t) => t.measured !== null && !(t.measured < t.stored) && t.held === false);
    const stale = [...over, ...flat].map((t) => t.longId);
    const due = input.lastSync === null || now - input.lastSync >= params.syncIntervalS;
    if (stale.length > 0 && (due || cappedByTotal)) {
      const why = [
        ...(over.length > 0 ? [`${over.length} series store more notional than they measure`] : []),
        ...(flat.length > 0 ? [`${flat.length} tracked series hold nothing (a sync untracks them)`] : []),
      ].join('; ');
      for (let i = 0; i < stale.length; i += SYNC_CHUNK) {
        txs.push({ type: 'sync', longIds: stale.slice(i, i + SYNC_CHUNK), reason: `${why}${cappedByTotal ? ' (a quote is capped by total notional)' : ''}` });
      }
    }
    for (const view of input.series) {
      const pair = closePair(view);
      if (pair > 0n) {
        txs.push({ type: 'close', longId: view.info.longId, units: pair, reason: `${pair} units held long and short: free their collateral` });
      }
    }
    // (N3): the vault redeems its own settled tokens (see VaultView.settledHeld).
    for (const h of vault.settledHeld ?? []) {
      if (h.units > 0n) {
        txs.push({ type: 'redeem', tokenId: h.tokenId, longId: h.longId, units: h.units, reason: `${h.units} units of settled ${h.tokenId === h.longId ? 'long' : 'short'} ${h.tokenId}: the vault redeems its own (third-party redemption is off)` });
      }
    }
    if (vault.owed > 0n) txs.push({ type: 'claimOwed', amount: vault.owed, reason: `the book owes the vault ${vault.owed}` });
    if (params.depositTokens) {
      for (const [asset, held] of vault.walletTokens) {
        // Only the unreserved balance, as HouseVault.depositToClearinghouse clamps it (_unreservedWallet);
        // with all of it reserved the call reverts BadUnits, so nothing is proposed.
        const reserved = vault.walletReserved?.get(lc(asset)) ?? 0n;
        const amount = held > reserved ? held - reserved : 0n;
        const why = reserved > 0n ? ` (${held} held, ${reserved} reserved for queued deposits and unclaimed withdrawals)` : '';
        if (amount > 0n) txs.push({ type: 'deposit', asset, amount, reason: `${amount} of ${asset} idle in the vault wallet${why}: write collateral` });
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
    mtm,
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

/**
 * The plan's BID-GROWING txs, by index, with the USDG each takes out of the vault's wallet: every
 * Bid place (its escrow) and every Bid replace whose booked delta is positive. Cancels, shrinking replaces and asks take
 * no USDG. The deltas are {bookedCalls}' own, from the plan's live orders (`series[].live`), so the send-time recheck in
 * quoter.ts measures exactly what the outflow bucket books and what `OrderBook._pullUsdg` takes.
 */
export function bidGrowth(plan: TickPlan): Map<number, bigint> {
  const live = new Map<string, { kind: LiveOrder['kind']; price: bigint; remaining: bigint }>();
  for (const s of plan.series ?? []) for (const o of s.live) live.set(o.id.toString(), { kind: o.kind, price: o.price, remaining: o.remaining });
  const out = new Map<number, bigint>();
  for (const c of bookedCalls(plan, live)) {
    const tx = plan.txs[c.index]!;
    if (tx.type === 'place' || (tx.type === 'replace' && c.delta > 0n)) out.set(c.index, c.delta);
  }
  return out;
}

/** How many of a plan's series quote both sides (a bid and at least one ask target). */
export function twoSidedCount(plan: TickPlan): number {
  return plan.series.filter((s) => s.targets !== null && s.targets.bid !== null && (s.targets.write !== null || s.targets.resale !== null)).length;
}
