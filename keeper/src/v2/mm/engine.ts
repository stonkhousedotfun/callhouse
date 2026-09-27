/**
 * The MM bot's quote engine: pure functions from what a tick read to the prices it wants, and from
 * those to the vault calls that get there. Nothing here reads a chain, a clock or the network
 * (mm/quoter.ts gathers; mm/risk.ts sizes; mm/pnl.ts keeps the realised-loss ledger).
 *
 * PRICES are USDG base units (6 dp) per WHOLE share, on the book's PRICE_TICK (100) grid; sizes are
 * 0.01-share units; `delta` is the pricing service's, dPrice/dTokenSpot per share.
 *
 * THE QUOTE:
 *   halfSpread = max(fair × MM_HALF_SPREAD_BPS / 1e4, MM_MIN_HALF_SPREAD_USDG6) × widen
 *   skew       = seriesDelta × spot × MM_SKEW_BPS_PER_DELTA_SHARE / 1e4 × netDeltaShares,
 *                capped at ± fair × MM_MAX_SKEW_BPS / 1e4
 *   bid        = roundDown(fair − halfSpread − skew), never above the vault's bidCap
 *   target     = fair + halfSpread − skew                     (the NET the vault must keep)
 *   writeAsk   = roundUp(target / (1 − premiumFeeBps/1e4)),   never below askFloorOf(longId, true)
 *   resaleAsk  = roundUp((target − PRICE_TICK) / (1 − resaleFeeBps/1e4)), never below askFloorOf(longId, false)
 * `netDeltaShares` is the vault's inventory delta on the series' underlying (positive = long delta):
 * a vault that is long delta lowers every call quote and raises every put quote, which sells delta and
 * buys negative delta. The resale ask (inventory) sits one tick under the write ask so the book sells
 * inventory before it writes, whenever that keeps it above the bid and the floor.
 *
 * THE SELLER FEE IS TAKEN FROM THE MAKER, so it belongs in the ask (INTERFACE_VERSION 8). OrderBook
 * credits a selling maker `premium − sellerFee + rebate`, so an ask placed at the bare target nets the
 * vault LESS than the target. At the v8 launch parameters that is not a rounding error: with
 * MM_HALF_SPREAD_BPS 500 and premiumFeeBps 500 a bare ask nets fair × 1.05 × 0.95 = 0.9975 × fair, a
 * guaranteed loss on every option the vault writes.
 *
 * IT IS A GROSS-UP, NOT A MARKUP. Divide by (1 − rate); do not add rate × fair. With f = hs = 5 % a
 * markup nets 1.10 × 0.95 = 1.045 × fair and is short ~0.5 % of fair for ever.
 *
 * EACH ASK IS GROSSED BY ITS OWN RATE, and this is the trap. OrderBook picks the rate per ORDER KIND —
 * premiumFeeBps for an AskWrite (a primary sale), resaleFeeBps for an AskResale — and v8 launches at
 * 500 / 0. If the resale ask were derived from the GROSSED write ask it would carry the 5 % primary fee
 * while owing 0, sit ~5 % too high, never fill, and the bot would write new options instead of unwinding
 * inventory — inverting the priority stated two paragraphs above. So the "one tick under" relation holds
 * on the UNGROSSED prices, and the two asks may end up MORE than one tick apart on chain. That is
 * correct. `mm/pnl.ts` `sellerFeeBpsOf` is the single definition of which rate a kind pays; it is reused
 * here rather than restated.
 *
 * BIDS CARRY NO FEE TERM. A selling taker is paid `premium − sellerFees − takerFee` and the bid maker is
 * credited only its rebate, so the vault's escrow pays the full premium either way (OrderBook.sol).
 *
 * WIDENING. From `expiry − MM_EXPIRY_WIDEN_S` the half spread grows linearly to (1 + MM_EXPIRY_WIDEN_BPS
 * / 1e4) times itself at the pull time: gamma per unit of premium explodes into the close.
 *
 * HALTS, in the order they are judged (the first one wins and every order of the series is pulled):
 *   killed, loss-stop, not-quoter, trading-paused (vault-wide), expired, pull-window (inside the last
 *   MM_PULL_MINUTES before the mint cutoff), market-closed (no regular session and MM_QUOTE_OFF_HOURS=0),
 *   market-not-quoted (outside MM_MARKETS or no longer live: its orders are pulled), market-disabled, spot-stale (the series' oracle's trySpot not ok: every vault call would revert
 *   StaleSpot), then the market-safety halts (the safest-ask policy; {marketSafetyHalt}, computed
 *   per market by the quoter and carried on planner.MarketView.halt): spot-move-breaker (P15: the spot moved more than
 *   MM_BREAKER_BPS inside MM_BREAKER_WINDOW_S; halted MM_BREAKER_HALT_S), open-grace (P8: no in-session print today, or
 *   inside MM_OPEN_GRACE_S of the open), spot-age (P7: the oracle's print is older than MM_MAX_SPOT_AGE_S in session,
 *   corroborated or not), not-selected (beyond MM_MAX_SERIES), fair-unavailable (the pricing service said null or
 *   could not be reached), fair-before-open (in session, a chain dated before this session's open; judged before
 *   fair-stale), fair-stale (asOf older than the limit against the head block), fair-spot-mismatch (priced at
 *   a spot more than MM_FAIR_SPOT_TOLERANCE_BPS from the oracle's), fair-out-of-bounds (a call fair at or above spot,
 *   a put fair at or above strike, or a quoted fair below its intrinsic value at the oracle's spot), guards-unreadable,
 *   epoch-outside (series.expiry > vault epochEnd as
 *   the runtime read it; costs no /fair), epoch-winddown (inside the lead: no NEW risk; unwind still
 *   plans), protocol-cross (a rest would cross a protocol-owned maker; skip that slot). Among the fair checks,
 *   event-uncertainty (P9: the pricing service flagged the fair `event-uncertainty` or `model-uncertainty` in
 *   provenance.quality.reasons, or an event inside the series' window) is judged first. Inside the
 *   tolerance, the fair value is carried to the oracle's spot along its delta (fairAtSpot) before it is quoted, and a
 *   fair that carries to zero is fair-unavailable too (quotedFairOf, judged after fair-spot-mismatch). The fair checks
 *   are one function, fairCheckOf, which the planner also runs before it prices a series that is winding down.
 *
 * THE SAFEST ASK. The ungrossed ask target above is then only ever RAISED, never lowered:
 *   volBump   = vega × (askIv − iv)                   when /fair carried askIv and vega
 *             = vega × MM_VOL_MARKUP_PTS / 100        otherwise, vega from /fair or local Black-Scholes at `iv`
 *   floor     = max(intrinsic(oracle spot) + spot × MM_INTRINSIC_BUFFER_BPS / 1e4,     (P4)
 *                   MM_MIN_PREMIUM_USDG6)                                               (P5, independent of fair)
 *   target    = max(fair + halfSpread − skew + volBump, floor)
 * and both asks end at max(shaped, the ask the rules above would have given without these three): the explicit
 * max() is what makes "no rule may lower an ask" hold by construction, including the resale fallback's corner.
 * The bid is untouched (it only moves down, when a raised ask would otherwise cross it).
 *
 * REPLACE DISCIPLINE (gas): a live quote is left alone unless its target price moved more than
 * MM_REQUOTE_BPS, its remaining size is above the target or more than MM_RESIZE_BPS below it, it now sits
 * outside a vault guard, or it is about to expire while a later validUntil is allowed. Inside the replace margin
 * (MM_REPLACE_CONFIRM_S before validUntil, config.ts replaceMarginOf) it is never replaced, since the replace could land
 * after validUntil and revert OrderNotLive: a quote that must move is cancelled and placed fresh, one that need not lapses.
 * Every action says whether it is PROTECTIVE (MmAction); only those go out on a read between a vault's routine
 * sends (MM_SEND_INTERVAL_S).
 *
 * SAFE CALL SELLING (the planner and mm/spot-lag.ts drive it). Three rules live here:
 * fairCheckOf halts `fair-before-open` when, in session, the fair's chain is dated before this session's open (the
 * planner passes `sessionOpenedAt` only while MM_FAIR_FROM_SESSION=1); judgeReplace replaces a live ask under its slot's
 * spot-lag floor, and a live bid over the spot-lag cap, whatever MM_REQUOTE_BPS says; quoteValidUntil ends every AskWrite at the write stop
 * (writeStopAtOf, MM_WRITE_STOP_MINUTES before the mint cutoff), because the book never re-checks a resting order.
 */
import { bsDelta, bsGamma, bsVega, tradingYears } from '../pricing/bs.js';
import { BPS, KIND_INDEX, PRICE_TICK, SETTLEMENT_WINDOW, UNITS_PER_SHARE, type OrderKindName } from './constants.js';
import { epochSelectable, type EpochView } from './epoch.js';
import { sellerFeeBpsOf, type FeeRegime, type TrackedOrder } from './pnl.js';

export type { EpochView } from './epoch.js';

/*//////////////////////////////////////////////////////////////
                              TYPES
//////////////////////////////////////////////////////////////*/

export interface QuoteParams {
  halfSpreadBps: number;
  minHalfSpreadUsdg6: bigint;
  expiryWidenS: number;
  expiryWidenBps: number;
  pullMinutes: number;
  quoteOffHours: boolean;
  fairMaxAgeS: number;
  fairMaxAgeOffHoursS: number;
  skewBpsPerDeltaShare: number;
  maxSkewBps: number;
  requoteBps: number;
  resizeBps: number;
  /** MM_FAIR_SPOT_TOLERANCE_BPS: the pricing service's spot may differ from the oracle's by at most this (0 = unchecked). */
  fairSpotToleranceBps?: number;
  /*
   * the safest-ask knobs. OPTIONAL ON THE TYPE, NEVER OFF WHEN ABSENT: an absent knob resolves to
   * its SAFEST_ASK_DEFAULTS value ({safestAskOf}), the same number config.ts defaults the env to. A caller that does not
   * wire a knob gets the guard at its default, not a disabled guard. 0 is the explicit opt-out where one exists.
   */
  /** P3 fallback: vol points (1 = 0.01 of vol) the ask is marked up by when /fair gave no askIv. */
  volMarkupPts?: number;
  /** P4: the ask target is at least intrinsic + this many bps of the oracle spot. */
  intrinsicBufferBps?: number;
  /** P5: the ask target is at least this, USDG base units per share, whatever the fair. */
  minPremiumUsdg6?: bigint;
  /** P16: selection ranks series by |delta| distance from [deltaBandLo, deltaBandHi], estimated at selectVol. deltaBandHi 0 = off (nearest the money). */
  deltaBandLo?: number;
  deltaBandHi?: number;
  selectVol?: number;
}

/** Every safest-ask knob resolved. */
export interface SafestAsk {
  volMarkupPts: number;
  intrinsicBufferBps: number;
  minPremiumUsdg6: bigint;
  deltaBandLo: number;
  deltaBandHi: number;
  selectVol: number;
  /** P14 (planner/risk): a side that would take |net delta| past this many shares on its market is not quoted. */
  maxDeltaShares: number;
  /** P14: likewise for |net gamma|, share-delta per USD of spot. */
  maxGamma: number;
  /** P13 (risk.planSizes): Σ notional of one expiry's series, USDG base units. */
  maxExpiryNotionalUsdg6: bigint;
  /** P18 (pnl.mtmLossStop): realised today + mark-to-market of open positions at or below −this stops quoting. */
  dailyMtmLossLimitUsdg6: bigint;
}

/**
 * The defaults, starting points for 0DTE (tunable). config.ts defaults every MM_* knob to exactly
 * these (config.test.ts pins the equality), so an unwired knob and an unset env var mean the same guard.
 */
export const SAFEST_ASK_DEFAULTS: Readonly<SafestAsk> = Object.freeze({
  volMarkupPts: 2,
  intrinsicBufferBps: 5,
  minPremiumUsdg6: 20_000n,
  deltaBandLo: 0.1,
  deltaBandHi: 0.3,
  selectVol: 0.5,
  maxDeltaShares: 100,
  maxGamma: 20,
  maxExpiryNotionalUsdg6: 100_000_000_000n,
  dailyMtmLossLimitUsdg6: 1_000_000_000n,
});

/** The knobs a params object carries, each absent one at its default. */
export function safestAskOf(params: Partial<SafestAsk>): SafestAsk {
  const d = SAFEST_ASK_DEFAULTS;
  return {
    volMarkupPts: params.volMarkupPts ?? d.volMarkupPts,
    intrinsicBufferBps: params.intrinsicBufferBps ?? d.intrinsicBufferBps,
    minPremiumUsdg6: params.minPremiumUsdg6 ?? d.minPremiumUsdg6,
    deltaBandLo: params.deltaBandLo ?? d.deltaBandLo,
    deltaBandHi: params.deltaBandHi ?? d.deltaBandHi,
    selectVol: params.selectVol ?? d.selectVol,
    maxDeltaShares: params.maxDeltaShares ?? d.maxDeltaShares,
    maxGamma: params.maxGamma ?? d.maxGamma,
    maxExpiryNotionalUsdg6: params.maxExpiryNotionalUsdg6 ?? d.maxExpiryNotionalUsdg6,
    dailyMtmLossLimitUsdg6: params.dailyMtmLossLimitUsdg6 ?? d.dailyMtmLossLimitUsdg6,
  };
}

export interface SeriesInfo {
  longId: bigint;
  underlying: string;
  isPut: boolean;
  /** USDG base units per share. */
  strike: bigint;
  expiry: number;
}

export type FairInput =
  /** `spot`: the token spot the pricing service priced at (USDG base units per share), when it said. */
  | {
      ok: true;
      fair: bigint;
      delta: number;
      iv: number;
      asOf: number;
      source: string;
      spot?: bigint;
      /**
       * P3/P14: the askIv (>= iv, trading clock), vega (USD per share per 1.00 of vol) and gamma
       * (per USD of spot), when the pricing client carried them. Absent = the engine computes vega and gamma itself
       * ({localGreeks}) and marks the ask up by MM_VOL_MARKUP_PTS instead of pricing it at askIv.
       */
      askIv?: number;
      vega?: number;
      gamma?: number;
      /**
       * P9: the service's quality.reasons and event.inWindow / event.input (top-level), when it sent
       * them. Absent = an older service: no event halt (the field is additive; its absence is not a flag).
       */
      quality?: {
        reasons: readonly string[];
        eventInWindow?: boolean;
        /**
         * The event.input. 'missing' / 'short' = the service had no (full) event calendar for the window: UNKNOWN,
         * not clear. Carried into the halt detail and /state; it does not halt on its own (see eventUncertaintyOf).
         */
        eventInput?: 'supplied' | 'missing' | 'short';
      };
    }
  | { ok: false; reason: string };

export const HALTS = [
  'killed',
  'loss-stop',
  'not-quoter',
  'trading-paused',
  'expired',
  'pull-window',
  'market-closed',
  'market-not-quoted',
  'market-disabled',
  'spot-stale',
  'not-selected',
  'fair-unavailable',
  'fair-stale',
  'fair-spot-mismatch',
  'fair-out-of-bounds',
  'guards-unreadable',
  'epoch-outside',
  'epoch-winddown',
  'protocol-cross',
  /** MM_ASK_FALLBACK_ONLY=1 and another maker's live ask rests on the series; the bot's ask side stays off. */
  'other-asker',
  /** P7: in session, the series oracle's print (trySpot updatedAt) is older than MM_MAX_SPOT_AGE_S. */
  'spot-age',
  /** P8: in session, no in-session oracle print today yet, or the session opened less than MM_OPEN_GRACE_S ago. */
  'open-grace',
  /** P15: the market's spot moved more than MM_BREAKER_BPS inside MM_BREAKER_WINDOW_S; halted MM_BREAKER_HALT_S. */
  'spot-move-breaker',
  /** P9: the pricing service flagged the fair event- or model-uncertain, or an event sits inside the window. */
  'event-uncertainty',
  /**
   * Safe call selling: in session, the fair was priced on an option chain dated before this session's open
   * (its vol is the previous close's), or the open cannot be placed. MM_FAIR_FROM_SESSION=0 turns it off.
   */
  'fair-before-open',
  /**
   * The House vault's own quoting brake, `HouseVault.quotingPaused()` (GUARDIAN). Its place and replace revert
   * TradingPaused (`_requireQuoting`) while OrderBook.tradingPaused is false; cancels still go out.
   */
  'quoting-paused',
] as const;
export type HaltName = (typeof HALTS)[number];
export interface Halt {
  halt: HaltName;
  detail?: string;
}

export type Slot = 'bid' | 'write' | 'resale';
export const SLOT_KIND: Record<Slot, OrderKindName> = { bid: 'Bid', write: 'AskWrite', resale: 'AskResale' };
export const KIND_SLOT: Record<OrderKindName, Slot> = { Bid: 'bid', AskWrite: 'write', AskResale: 'resale' };

/*//////////////////////////////////////////////////////////////
                              TICKS
//////////////////////////////////////////////////////////////*/

export const roundDownToTick = (x: bigint): bigint => (x <= 0n ? 0n : (x / PRICE_TICK) * PRICE_TICK);
export const roundUpToTick = (x: bigint): bigint => (x <= 0n ? 0n : ((x + PRICE_TICK - 1n) / PRICE_TICK) * PRICE_TICK);

/** Clearinghouse.mintCutoff: AskWrite orders stop here. */
export const mintCutoffOf = (expiry: number): number => expiry - SETTLEMENT_WINDOW;

/** The moment every quote of the series is pulled: MM_PULL_MINUTES before the mint cutoff. */
export const pullAtOf = (expiry: number, pullMinutes: number): number => mintCutoffOf(expiry) - pullMinutes * 60;

/** The last moment an AskWrite may rest or fill: MM_WRITE_STOP_MINUTES before the mint cutoff. */
export const writeStopAtOf = (expiry: number, writeStopMinutes: number): number => mintCutoffOf(expiry) - writeStopMinutes * 60;

/*//////////////////////////////////////////////////////////////
                              HALTS
//////////////////////////////////////////////////////////////*/

export interface HaltInput {
  now: number;
  series: SeriesInfo;
  params: Pick<QuoteParams, 'pullMinutes' | 'quoteOffHours' | 'fairMaxAgeS' | 'fairMaxAgeOffHoursS' | 'fairSpotToleranceBps'>;
  killed: boolean;
  lossStopped: boolean;
  isQuoter: boolean;
  tradingPaused: boolean;
  /** HouseVault.quotingPaused (the planner's vault.quotingPaused). Absent = false: a treasury MakerVault. */
  quotingPaused?: boolean;
  sessionOpen: boolean;
  marketEnabled: boolean;
  /** false: the series' market is outside the quoted set (MM_MARKETS, or not live): pull-only. Default true. */
  marketQuoted?: boolean;
  spotFresh: boolean;
  /**
   * The series' market's safety halt this tick (P7 spot-age, P8 open-grace, P15 spot-move-breaker) from
   * {marketSafetyHalt}, set by mm/quoter.ts on planner.MarketView.halt. Absent or null = none.
   */
  marketHalt?: Halt | null;
  selected: boolean;
  /**
   * Vault epoch as the runtime read it. `null` = treasury / unrestricted (today's behaviour).
   * `epochEnd` is never derived here.
   */
  epoch?: EpochView | null;
  /** Seconds of lead before epochEnd during which no new risk is opened. */
  epochWindDownS?: number;
  /** undefined: not asked (a halt above made it moot). */
  fair?: FairInput;
  /** The series oracle's spot (trySpot), when read: the fair value is checked against it. */
  spot?: bigint | null;
  /**
   * The 09:30 open of the session `now` is in (pricing/bs.ts sessionOpenOf), for `fair-before-open`. Set by the planner
   * only while MM_FAIR_FROM_SESSION=1: undefined = the check is off; null = the session is open but its open cannot be
   * placed, which halts rather than guesses.
   */
  sessionOpenedAt?: number | null;
  guardsOk: boolean;
}

/** Every halt judged before a fair value is needed: a series halted here costs no /fair request. */
export function haltBeforeFair(input: Omit<HaltInput, 'fair' | 'guardsOk'>): Halt | null {
  const { now, series, params } = input;
  if (input.killed) return { halt: 'killed' };
  if (input.lossStopped) return { halt: 'loss-stop' };
  if (!input.isQuoter) return { halt: 'not-quoter' };
  if (input.tradingPaused) return { halt: 'trading-paused' };
  if (input.quotingPaused === true) return { halt: 'quoting-paused', detail: 'HouseVault.quotingPaused: place and replace revert TradingPaused; cancels still go out' };
  if (now >= series.expiry) return { halt: 'expired' };
  if (now >= pullAtOf(series.expiry, params.pullMinutes)) return { halt: 'pull-window', detail: `pulled at ${pullAtOf(series.expiry, params.pullMinutes)}` };
  if (!input.sessionOpen && !params.quoteOffHours) return { halt: 'market-closed' };
  if (input.marketQuoted === false) return { halt: 'market-not-quoted' };
  if (!input.marketEnabled) return { halt: 'market-disabled' };
  if (!input.spotFresh) return { halt: 'spot-stale' };
  // The market-safety halts. Judged before epoch and selection so a halted market's resting orders are pulled
  // (targets null -> planSeriesActions cancels every live order of the series, asks included) whatever else is true.
  if (input.marketHalt !== undefined && input.marketHalt !== null) return input.marketHalt;
  const epochSel = epochSelectable(series, input.epoch ?? null, now, input.epochWindDownS ?? 0);
  if (epochSel === 'epoch-outside') return { halt: 'epoch-outside' };
  if (epochSel === 'epoch-winddown') return { halt: 'epoch-winddown' };
  if (!input.selected) return { halt: 'not-selected' };
  return null;
}

/** Why this series must not be quoted now, or null. See HALTS in the header for the order. */
export function haltOf(input: HaltInput): Halt | null {
  const before = haltBeforeFair(input);
  if (before !== null) return before;
  const checked = fairCheckOf(input);
  if (checked.halt !== null) return checked.halt;
  if (!input.guardsOk) return { halt: 'guards-unreadable' };
  return null;
}

export type FairCheckInput = Pick<HaltInput, 'now' | 'series' | 'params' | 'sessionOpen' | 'fair' | 'spot' | 'sessionOpenedAt'>;

export type FairClockInput = Pick<HaltInput, 'now' | 'sessionOpen' | 'sessionOpenedAt'> & { params: Pick<HaltInput['params'], 'fairMaxAgeS' | 'fairMaxAgeOffHoursS'> };

/**
 * The two CLOCK checks on a priced fair, in this order: fair-before-open (in session, a chain dated before this
 * session's open; only when `sessionOpenedAt` is given, i.e. while MM_FAIR_FROM_SESSION=1), then fair-stale (asOf
 * older than the session's or the off-hours limit). Null = the fair's clock passes.
 *
 * fair-before-open is judged FIRST. At the shipped defaults MM_OPEN_GRACE_S and
 * MM_FAIR_MAX_AGE_S are both 1800 s, so once quoting resumes after the open a chain dated before the open is always
 * older than the limit too. Judged second, fair-before-open could not fire in session and the halt named fair-stale
 * instead of the real cause (the previous close's chain).
 *
 * Shared by {fairCheckOf} and the markout sampler (quoter.markoutTick), so a +1/+5 min mark read around 09:30
 * cannot be priced on the previous close's chain that the quoting path would have refused.
 */
export function fairClockHalt(input: FairClockInput, asOf: number): Halt | null {
  // The chain behind the fair must be THIS session's: at 09:45 a 15-minute-delayed chain can be younger than
  // MM_FAIR_MAX_AGE_S and still show the previous close's vol, which open-grace (a spot rule) does not look at.
  if (input.sessionOpen && input.sessionOpenedAt !== undefined) {
    if (input.sessionOpenedAt === null) return { halt: 'fair-before-open', detail: 'the calendar says the session is open but its open cannot be placed' };
    if (asOf < input.sessionOpenedAt) return { halt: 'fair-before-open', detail: `priced on a chain as of ${asOf}, before this session's open at ${input.sessionOpenedAt}` };
  }
  const maxAge = input.sessionOpen ? input.params.fairMaxAgeS : input.params.fairMaxAgeOffHoursS;
  if (input.now - asOf > maxAge) return { halt: 'fair-stale', detail: `asOf ${asOf} is ${input.now - asOf} s old (limit ${maxAge})` };
  return null;
}

/**
 * Every check a fair value must pass before it may price an order, and the fair that is then QUOTED at the oracle's
 * spot ({quotedFairOf}), which is null when there is no positive oracle spot to quote at.
 *
 * ONE function for haltOf AND the planner's pricing branch. epoch-winddown returns from {haltBeforeFair} before
 * haltOf reaches any fair check, yet the planner still prices a wind-down's resale asks from that fair: until this was
 * shared, a stale or spot-mismatched fair priced them (an earlier fix had added only the zero case to that path). Whatever the
 * halt phase, a price the MM posts has passed every check here.
 */
export function fairCheckOf(input: FairCheckInput): { halt: Halt; quoted: null } | { halt: null; quoted: bigint | null } {
  const halted = (halt: Halt) => ({ halt, quoted: null });
  const { now, params } = input;
  if (input.fair === undefined) return halted({ halt: 'fair-unavailable', detail: 'not requested' });
  if (!input.fair.ok) return halted({ halt: 'fair-unavailable', detail: input.fair.reason });
  // P9, first of the checks on a priced fair: an event-day or model-uncertain price is not quoted at all.
  const uncertain = eventUncertaintyOf(input.fair);
  if (uncertain !== null) return halted({ halt: 'event-uncertainty', detail: uncertain });
  const clock = fairClockHalt({ now, params, sessionOpen: input.sessionOpen, sessionOpenedAt: input.sessionOpenedAt }, input.fair.asOf);
  if (clock !== null) return halted(clock);
  if (input.fair.fair <= 0n) return halted({ halt: 'fair-unavailable', detail: 'fair value is zero' });
  // The fair value must be one the market could hold at the ORACLE's spot: priced at a spot the pricing service read
  // from a lagging node, or outside what no-arbitrage allows (a bug, a bad chain), it would be quoted inside the vault's
  // wide guards (bids up to 10 % of spot) and picked off.
  if (input.spot === undefined || input.spot === null || input.spot <= 0n) return { halt: null, quoted: null };
  const tolerance = params.fairSpotToleranceBps ?? 0;
  if (tolerance > 0 && input.fair.spot !== undefined) {
    const gap = input.fair.spot > input.spot ? input.fair.spot - input.spot : input.spot - input.fair.spot;
    const gapBps = (gap * BPS) / input.spot;
    if (gapBps > BigInt(tolerance)) return halted({ halt: 'fair-spot-mismatch', detail: `priced at spot ${input.fair.spot}, the oracle reads ${input.spot} (${gapBps} bps, limit ${tolerance})` });
  }
  // The fair that is QUOTED is fairAtSpot's, not the raw answer: a positive raw fair carried down along its
  // delta can reach zero, and the check above the spot block never sees it.
  const quoted = quotedFairOf(input.fair, input.spot);
  if (quoted.halt !== null) return halted(quoted.halt);
  const bound = input.series.isPut ? input.series.strike : input.spot;
  if (input.fair.fair >= bound) return halted({ halt: 'fair-out-of-bounds', detail: `fair ${input.fair.fair} at or above the ${input.series.isPut ? 'strike' : 'spot'} ${bound}` });
  // The no-arbitrage LOWER bound, on the QUOTED fair at the oracle's spot: an option is worth at least its
  // intrinsic value, max(0, spot − strike) for a call and max(0, strike − spot) for a put, all in USDG base units per
  // share. Exact, no tolerance: neither side is tick-rounded here (quotePrices rounds afterwards), so there is no
  // rounding to absorb. A fair below it is the costliest wrong fair, a too-low price on an in-the-money series.
  // Out of the money the bound is 0 and a positive quoted fair always clears it.
  const intrinsic = intrinsicOf(input.series, input.spot);
  if (quoted.quoted < intrinsic) return halted({ halt: 'fair-out-of-bounds', detail: `quoted fair ${quoted.quoted} below the intrinsic ${intrinsic} at the oracle's spot ${input.spot}` });
  return { halt: null, quoted: quoted.quoted };
}

/*//////////////////////////////////////////////////////////////
                 MARKET SAFETY
//////////////////////////////////////////////////////////////*/

/**
 * P9. The pricing-service quality reasons that refuse a quote. `model-uncertainty` is the service's own spelling
 * (pricing/cboe.ts PricingReason, pricing/provenance.ts); `model-uncertain` is the other spelling, accepted so neither
 * spelling slips through.
 */
export const EVENT_HALT_REASONS: readonly string[] = ['event-uncertainty', 'model-uncertainty', 'model-uncertain'];

/**
 * The halt detail's cause when the service priced the series by extrapolation (provenance.ts adds
 * `extrapolated` for a read before the first or after the last listed expiry, or beyond the outermost listed strike).
 * That is what makes such a read model-uncertain: the before-first term and, with no event calendar, the one-unknown-
 * event term both come from the missing listing (short-maturity.ts). The calendar is not the cause, so it is named only
 * when one was supplied (a real dated event then adds to the flag).
 */
export const EXTRAPOLATED_HALT_CAUSE = 'no listed option expiry or strike near this series: extrapolated';

/**
 * P9: why this priced fair must not be quoted (event day, model uncertainty), or null. Reads only `quality`, so the
 * pricer applies the same rule to its own /fair answer (pricer/fair-gates.ts qualifyFair).
 */
export function eventUncertaintyOf(fair: Pick<Extract<FairInput, { ok: true }>, 'quality'>): string | null {
  const q = fair.quality;
  if (q === undefined) return null;
  const input = q.eventInput === undefined ? '' : ` (event calendar: ${q.eventInput})`;
  const hit = q.reasons.filter((r) => EVENT_HALT_REASONS.includes(r));
  if (hit.length > 0 && q.reasons.includes('extrapolated')) {
    return `${EXTRAPOLATED_HALT_CAUSE} (pricing flagged ${hit.join(', ')})${q.eventInput === 'supplied' ? input : ''}`;
  }
  if (hit.length > 0) return `pricing flagged ${hit.join(', ')}${input}`;
  if (q.eventInWindow === true) return `pricing: an event sits inside the series window${input}`;
  // event.input 'missing' / 'short' is UNKNOWN, not clear, and does not halt on its own: while ops/markets/events.json
  // is empty every series is 'missing', so halting on it would quote nothing on every
  // day. It rides on /state through the fair's quality block.
  return null;
}

/** The three market-safety knobs (config.ts MM_MAX_SPOT_AGE_S, MM_OPEN_GRACE_S; 0 = that guard off, explicitly). */
export interface MarketSafetyParams {
  maxSpotAgeS: number;
  openGraceS: number;
}

export interface MarketSafetyInput {
  now: number;
  /** calendar.isRegularSession(now). Every market-safety halt is a session rule: off-hours is market-closed's. */
  sessionOpen: boolean;
  /** calendar.isRegularSession(now − openGraceS): the session was already open a grace ago (AutoRoller.sol's test). */
  sessionOpenAtGrace: boolean;
  /**
   * The freshest CORROBORATED observation of the market's spot (mm/reads.ts readSpotClocks): the oracle's trySpot
   * updatedAt (source 0's print time) or, when later, the time of any other oracle source whose price agrees with it
   * within MM_FAIR_SPOT_TOLERANCE_BPS (the UniV3 TWAP source answers block.timestamp). Null when nothing was read.
   * P7 ages the spot against this, not against the Chainlink print alone.
   */
  spotObservedAt: number | null;
  /** calendar.isRegularSession(spotObservedAt), or null when unread. */
  spotObservedInSession: boolean | null;
  /** The spot-move breaker's halt, from {SpotMoveBreaker.haltOf}; null = not tripped. */
  breaker: Halt | null;
  params: MarketSafetyParams;
}

/**
 * P15, P8, P7 for one market, first match wins, null when it may quote. Pure.
 *
 *   spot-move-breaker  the breaker tripped and is still holding.
 *   open-grace         (P8) quotes wait until BOTH an in-session observation today exists AND MM_OPEN_GRACE_S has
 *                      passed since the open, whichever is later. The
 *                      in-session test is AutoRoller.sol's ROLL_OPEN_GRACE one (same UTC date, observed in a regular
 *                      session), applied to the freshest corroborated observation; AutoRoller accepts EITHER half.
 *   spot-age           (P7) the freshest corroborated observation is older than MM_MAX_SPOT_AGE_S. A Chainlink print
 *                      alone ages from its print time (SettlementOracle._spot hands that back even when the pool
 *                      corroborates); an agreeing pool reading refreshes it, so a quiet session keeps quoting.
 */
export function marketSafetyHalt(input: MarketSafetyInput): Halt | null {
  if (!input.sessionOpen) return null;
  if (input.breaker !== null) return input.breaker;
  const { now, spotObservedAt, params } = input;
  if (params.openGraceS > 0) {
    const printToday =
      spotObservedAt !== null && Math.floor(spotObservedAt / 86_400) === Math.floor(now / 86_400) && input.spotObservedInSession === true;
    if (!input.sessionOpenAtGrace || !printToday) {
      return {
        halt: 'open-grace',
        detail: !printToday
          ? `no in-session spot observation today (last ${spotObservedAt ?? 'unread'})`
          : `inside the first ${params.openGraceS} s of the session`,
      };
    }
  }
  if (params.maxSpotAgeS > 0) {
    if (spotObservedAt === null) return { halt: 'spot-age', detail: 'no spot observation time' };
    const age = now - spotObservedAt;
    if (age > params.maxSpotAgeS) return { halt: 'spot-age', detail: `freshest corroborated spot ${age} s old (limit ${params.maxSpotAgeS})` };
  }
  return null;
}

export interface BreakerParams {
  /** MM_BREAKER_BPS: a move larger than this, between any two readings inside the window, trips the breaker. */
  bps: number;
  windowS: number;
  haltS: number;
}

/**
 * P15, the spot-move circuit breaker, one per quoter process. Each tick records every quoted market's oracle spot; a
 * market whose spot moved more than `bps` against ANY reading still inside `windowS` is halted until `haltS` after the
 * move was seen (a later move while halted extends it). Readings older than the window are dropped. bps = 0 turns it
 * off (an explicit opt-out; the default is on). State is in memory: a restart forgets a halt, and the fresh history
 * re-trips on the next move.
 */
export class SpotMoveBreaker {
  private readonly history = new Map<string, Array<{ at: number; spot: bigint }>>();
  private readonly until = new Map<string, { until: number; moveBps: bigint; from: bigint; to: bigint }>();

  constructor(private readonly params: BreakerParams) {}

  /** Record `spot` for `underlying` at `now`. Returns the move in bps that tripped it, or null. */
  observe(underlying: string, now: number, spot: bigint | null): bigint | null {
    if (this.params.bps <= 0 || spot === null || spot <= 0n) return null;
    const key = underlying.toLowerCase();
    const kept = (this.history.get(key) ?? []).filter((r) => now - r.at <= this.params.windowS);
    let worst: { moveBps: bigint; from: bigint } | null = null;
    for (const r of kept) {
      const gap = spot > r.spot ? spot - r.spot : r.spot - spot;
      const moveBps = (gap * BPS) / r.spot;
      if (moveBps > BigInt(this.params.bps) && (worst === null || moveBps > worst.moveBps)) worst = { moveBps, from: r.spot };
    }
    kept.push({ at: now, spot });
    this.history.set(key, kept);
    if (worst === null) return null;
    this.until.set(key, { until: now + this.params.haltS, moveBps: worst.moveBps, from: worst.from, to: spot });
    return worst.moveBps;
  }

  /** The breaker's halt for `underlying` at `now`, or null once it has run out. */
  haltOf(underlying: string, now: number): Halt | null {
    const h = this.until.get(underlying.toLowerCase());
    if (h === undefined || now >= h.until) return null;
    return { halt: 'spot-move-breaker', detail: `spot ${h.from} -> ${h.to} (${h.moveBps} bps > ${this.params.bps} in ${this.params.windowS} s); halted until ${h.until}` };
  }
}

/** An option's intrinsic value at `spot`, USDG base units per share: max(0, spot − strike) for a call, max(0, strike − spot) for a put. */
export function intrinsicOf(series: Pick<SeriesInfo, 'isPut' | 'strike'>, spot: bigint): bigint {
  const v = series.isPut ? series.strike - spot : spot - series.strike;
  return v > 0n ? v : 0n;
}

/**
 * A fair value priced at `fairSpot` carried to the oracle's `spot` along its delta (first order, inside
 * MM_FAIR_SPOT_TOLERANCE_BPS), never below zero. Without `fairSpot` it is returned as it is.
 */
export function fairAtSpot(input: { fair: bigint; delta: number; fairSpot: bigint | undefined; spot: bigint }): bigint {
  if (input.fairSpot === undefined || !Number.isFinite(input.delta)) return input.fair;
  const shift = Math.round(input.delta * Number(input.spot - input.fairSpot));
  const moved = input.fair + BigInt(shift);
  return moved > 0n ? moved : 0n;
}

/**
 * The fair value that is QUOTED at the oracle's `spot` ({fairAtSpot}), and the halt it earns when that is zero: a
 * `fair-unavailable`, the same family as a raw fair of zero.
 *
 * haltOf judged only the RAW fair, and the planner quoted {fairAtSpot}, which clamps at zero. A raw fair of 0.5
 * USDG priced 2 USDG above the oracle's spot at delta 0.4 is quoted at 0, inside any tolerance of 100 bps or more, and
 * the only floors left under the ask were PRICE_TICK and a MakerVault askFloor that is 0 out of the money. One rule,
 * reached by haltOf AND by the planner's pricing branch through {fairCheckOf}: epoch-winddown returns from
 * haltBeforeFair before any fair check, so haltOf alone would still let a wind-down price a zero fair.
 */
export function quotedFairOf(fair: { fair: bigint; delta: number; spot?: bigint }, spot: bigint): { quoted: bigint; halt: Halt | null } {
  const quoted = fairAtSpot({ fair: fair.fair, delta: fair.delta, fairSpot: fair.spot, spot });
  if (quoted > 0n) return { quoted, halt: null };
  return { quoted, halt: { halt: 'fair-unavailable', detail: `fair ${fair.fair} priced at spot ${fair.spot} is ${quoted} at the oracle's spot ${spot}: nothing to quote` } };
}

/*//////////////////////////////////////////////////////////////
                          SPREAD AND SKEW
//////////////////////////////////////////////////////////////*/

/** The half-spread multiplier in bps (10_000 = ×1), rising linearly to 10_000 + MM_EXPIRY_WIDEN_BPS at the pull time. */
export function widenBps(now: number, expiry: number, params: Pick<QuoteParams, 'expiryWidenS' | 'expiryWidenBps' | 'pullMinutes'>): bigint {
  if (params.expiryWidenS <= 0 || params.expiryWidenBps <= 0) return BPS;
  const start = expiry - params.expiryWidenS;
  const end = pullAtOf(expiry, params.pullMinutes);
  if (now <= start) return BPS;
  if (end <= start || now >= end) return BPS + BigInt(params.expiryWidenBps);
  return BPS + (BigInt(params.expiryWidenBps) * BigInt(now - start)) / BigInt(end - start);
}

export function halfSpreadUsdg6(fair: bigint, widen: bigint, params: Pick<QuoteParams, 'halfSpreadBps' | 'minHalfSpreadUsdg6'>): bigint {
  const proportional = (fair * BigInt(params.halfSpreadBps)) / BPS;
  const base = proportional > params.minHalfSpreadUsdg6 ? proportional : params.minHalfSpreadUsdg6;
  return (base * widen) / BPS;
}

/**
 * The price shift for inventory, USDG base units per share (positive lowers both quotes). Linear in the
 * series' delta and in the market's net inventory delta; capped at ± fair × MM_MAX_SKEW_BPS.
 */
export function skewUsdg6(input: { fair: bigint; delta: number; spot: bigint; netDeltaShares: number; params: Pick<QuoteParams, 'skewBpsPerDeltaShare' | 'maxSkewBps'> }): bigint {
  const { fair, delta, spot, netDeltaShares, params } = input;
  if (!Number.isFinite(delta) || !Number.isFinite(netDeltaShares) || params.skewBpsPerDeltaShare === 0) return 0n;
  const spotShift = (Number(spot) * params.skewBpsPerDeltaShare * netDeltaShares) / 10_000;
  const raw = delta * spotShift;
  const cap = (Number(fair) * params.maxSkewBps) / 10_000;
  const clamped = Math.max(-cap, Math.min(cap, raw));
  const rounded = Math.round(clamped);
  return rounded === 0 ? 0n : BigInt(rounded);
}

/*//////////////////////////////////////////////////////////////
                  SAFEST ASK
//////////////////////////////////////////////////////////////*/

/**
 * Black-Scholes delta, gamma and vega of a series at `vol`, from the oracle's spot, on the pricing service's own
 * trading clock (pricing/bs.ts, r = 0): the numbers /fair would send, for when it did not. Spot and strike are USDG
 * base units per share; delta per share, gamma per USD of spot, vega in USD per share per 1.00 of vol. null when the
 * input is not a Black-Scholes input (no positive spot or strike, a vol that is not finite).
 */
export function localGreeks(input: { now: number; series: Pick<SeriesInfo, 'isPut' | 'strike' | 'expiry'>; spot: bigint; vol: number }): { delta: number; gamma: number; vega: number } | null {
  if (input.spot <= 0n || input.series.strike <= 0n || !Number.isFinite(input.vol) || input.vol < 0) return null;
  const bs = { type: input.series.isPut ? ('put' as const) : ('call' as const), spot: Number(input.spot) / 1e6, strike: Number(input.series.strike) / 1e6, vol: input.vol, t: tradingYears(input.now, input.series.expiry) };
  try {
    return { delta: bsDelta(bs), gamma: bsGamma(bs), vega: bsVega(bs) };
  } catch {
    return null;
  }
}

/**
 * P3: how much the ask target rises for vol, USDG base units per share, rounded UP.
 *   askIv and vega both known  vega × (askIv − iv): the first-order price of the option at askIv (the service sends
 *                              askIv >= iv; a smaller one is treated as no markup, never as a discount)
 *   otherwise                  vega × MM_VOL_MARKUP_PTS / 100 (a vol point is 0.01 of vol)
 * 0 without a usable vega. Never negative.
 */
export function volBumpUsdg6(input: { iv: number; askIv?: number | null; vega: number | null; volMarkupPts: number }): { bump: bigint; how: 'ask-iv' | 'vol-markup' | 'none' } {
  const vega = input.vega;
  if (vega === null || !Number.isFinite(vega) || vega <= 0) return { bump: 0n, how: 'none' };
  const askIv = input.askIv;
  const volUp = askIv !== undefined && askIv !== null && Number.isFinite(askIv) && Number.isFinite(input.iv) ? Math.max(0, askIv - input.iv) : null;
  const how = volUp !== null ? 'ask-iv' : 'vol-markup';
  const up = volUp !== null ? volUp : Math.max(0, input.volMarkupPts) / 100;
  const usdg6 = Math.ceil(vega * up * 1e6);
  return { bump: usdg6 > 0 ? BigInt(usdg6) : 0n, how: usdg6 > 0 ? how : 'none' };
}

/**
 * P4 + P5: the least NET an ask may target, USDG base units per share: max(intrinsic at the oracle's spot + spot ×
 * intrinsicBufferBps / 1e4 (rounded up), minPremiumUsdg6). Independent of the fair value.
 */
export function askFloorNetUsdg6(input: { series: Partial<Pick<SeriesInfo, 'isPut' | 'strike'>>; spot: bigint; intrinsicBufferBps: number; minPremiumUsdg6: bigint }): { floor: bigint; by: 'intrinsic-buffer' | 'min-premium' } {
  const intrinsic = input.series.isPut !== undefined && input.series.strike !== undefined ? intrinsicOf({ isPut: input.series.isPut, strike: input.series.strike }, input.spot) : 0n;
  const bps = BigInt(Math.max(0, Math.floor(input.intrinsicBufferBps)));
  const buffer = input.spot > 0n ? (input.spot * bps + BPS - 1n) / BPS : 0n;
  const byIntrinsic = intrinsic + buffer;
  const minPremium = input.minPremiumUsdg6 > 0n ? input.minPremiumUsdg6 : 0n;
  return byIntrinsic >= minPremium ? { floor: byIntrinsic, by: 'intrinsic-buffer' } : { floor: minPremium, by: 'min-premium' };
}

/*//////////////////////////////////////////////////////////////
                              PRICES
//////////////////////////////////////////////////////////////*/

/**
 * The order book's seller fees as this tick read them: what is in effect now, and any scheduled change.
 * `OrderBook.pendingFeeParams()` returns the zero value when nothing is pending, which is why
 * `effectiveAt === 0` and not a null `pending` is the "nothing scheduled" case on chain.
 */
export interface QuoteFees {
  current: FeeRegime;
  /** null when the read is unavailable; `effectiveAt === 0` when the chain says nothing is scheduled. */
  pending: { params: FeeRegime; effectiveAt: number } | null;
}

/**
 * The rate to quote a slot of `kind` against: the higher of the rate in effect and any scheduled one.
 *
 * THE HORIZON RULE, and why it is the blunt one. A resting order can fill after a scheduled change takes
 * effect, so the quote must assume the worse of the two. The obvious refinement is to ignore a change
 * that cannot bite before the order expires — `effectiveAt <= now + limits.maxOrderLifetime`. THAT RULE
 * IS UNSAFE AT THE v8 LAUNCH: `maxOrderLifetime` is 0 on the launch vault, and 0 means NO LIMIT
 * (`config.ts`: "0 = only the pull time, the session close and the vault's maxOrderLifetime"), so the
 * comparison would read "already effective" and quietly ignore EVERY pending change. A horizon of zero
 * meaning "for ever" is the permissive direction, so this takes the max whenever anything is scheduled.
 * If a future vault sets a real `maxOrderLifetime`, narrowing this is a safe, separate change.
 *
 * Shaped after `conservativeSellerFeeBps` (`mm/pnl.ts`), which makes the same "assume the worse regime"
 * argument for the realised-P&L side.
 */
export function quoteFeeBpsOf(kind: TrackedOrder['kind'], fees: QuoteFees): number {
  const current = sellerFeeBpsOf(kind, fees.current);
  const pending = fees.pending;
  if (pending === null || pending.effectiveAt === 0) return current;
  return Math.max(current, sellerFeeBpsOf(kind, pending.params));
}

/**
 * `price / (1 − feeBps/1e4)`, in integer maths, rounded UP to the tick: the gross ask whose seller fee
 * still leaves `price`. Rounding up is what makes the inequality hold rather than nearly hold.
 *
 * A rate at or above 100 % has no gross-up (the divisor is zero or negative) and cannot happen —
 * `V2Constants.PREMIUM_FEE_CEIL_BPS` is 1000, mirrored at `mm/constants.ts` — so reaching that branch
 * means the fee read is wrong, not that the fee is high. It returns the UNGROSSED price and reports
 * itself, so the caller quotes something honest-but-too-cheap and can halt, rather than dividing by a
 * bad number and resting a garbage price.
 */
export function grossUpToTick(price: bigint, feeBps: number): { price: bigint; ok: boolean } {
  if (feeBps <= 0) return { price: roundUpToTick(price), ok: true };
  const net = BPS - BigInt(feeBps);
  if (net <= 0n) return { price: roundUpToTick(price), ok: false };
  return { price: roundUpToTick((price * BPS + net - 1n) / net), ok: true };
}

export interface QuotePrices {
  /** null: no bid (under one tick after the spread, the skew and the bid cap). */
  bid: bigint | null;
  ask: bigint;
  /** The resale ask for inventory: one tick under `ask` when that stays above the bid and the floor. */
  resale: bigint;
  halfSpread: bigint;
  skew: bigint;
  widen: bigint;
  /**
   * Which guard moved a price, for /state. `fee-out-of-range` means the ask is UNGROSSED and too cheap. The
   * shaping tags: `ask-iv` / `vol-markup` (P3 raised the target), `intrinsic-buffer` / `min-premium` (P4 / P5 set it).
   */
  clampedBy: Array<'bid-cap' | 'ask-floor' | 'crossed' | 'fee-out-of-range' | 'ask-iv' | 'vol-markup' | 'intrinsic-buffer' | 'min-premium'>;
  /** P3: what the vol markup added to the ungrossed ask target (0n when none). */
  volBump: bigint;
}

/**
 * The vault's `askFloorOf(longId, primary)` per ask slot, USDG base units per share: `write` is primary=true (an AskWrite
 * mints), `resale` is primary=false (an AskResale sells inventory). Each is grossed by its own seller fee on chain, so
 * they differ whenever premiumFeeBps and resaleFeeBps do. Both vault kinds have askFloorOf; only MakerVault has the
 * one-argument askFloor (= the write floor), which is why the keeper never reads that.
 */
export interface AskFloors {
  write: bigint;
  resale: bigint;
}

export interface PriceInput {
  now: number;
  /** isPut and strike give P4 its intrinsic value; without them P4 is the spot buffer alone. */
  series: Pick<SeriesInfo, 'expiry'> & Partial<Pick<SeriesInfo, 'isPut' | 'strike'>>;
  fair: bigint;
  delta: number;
  /**
   * P3: the fair's iv, and askIv / vega when /fair sent them (the planner fills vega from {localGreeks}
   * otherwise). Absent vega = no vol markup at all (the old ask), which only a caller with no vol can reach.
   */
  iv?: number;
  askIv?: number | null;
  vega?: number | null;
  spot: bigint;
  netDeltaShares: number;
  /** The vault's floor per ask kind (askFloorOf): an ask below its own kind's floor reverts BadPrice. */
  askFloors: AskFloors;
  /** MakerVault.bidCap(longId): bids above it revert BadPrice. */
  bidCap: bigint;
  /** OrderBook.feeParams() and pendingFeeParams() as this tick read them: per-tick chain state, not config. */
  fees: QuoteFees;
  params: QuoteParams;
}

/**
 * Tick-rounded, guard-respecting bid and ask around fair (the header's formula), the ask shaped by the safest-ask rules
 * (P3 vol markup, P4 intrinsic buffer, P5 minimum premium) and then held at or above the unshaped ask.
 */
export function quotePrices(input: PriceInput): QuotePrices {
  const safest = safestAskOf(input.params);
  const bump = volBumpUsdg6({ iv: input.iv ?? Number.NaN, askIv: input.askIv, vega: input.vega ?? null, volMarkupPts: safest.volMarkupPts });
  const floorNet = askFloorNetUsdg6({ series: input.series, spot: input.spot, intrinsicBufferBps: safest.intrinsicBufferBps, minPremiumUsdg6: safest.minPremiumUsdg6 });
  const shaped = quotePricesCore(input, bump.bump, floorNet.floor);
  const legacy = quotePricesCore(input, 0n, 0n);
  // FORBIDDEN: any rule that lowers an ask below what the code without it would ask. Every rule above is a
  // max() on the target already; this max() closes the one corner where a higher target could still post a lower
  // resale (the resale falls back to the write ask when it cannot clear the floor, and a raised target can let it clear).
  const ask = shaped.ask > legacy.ask ? shaped.ask : legacy.ask;
  const resale = shaped.resale > legacy.resale ? shaped.resale : legacy.resale;
  const clampedBy = [...shaped.clampedBy];
  if (bump.bump > 0n) clampedBy.push(bump.how === 'ask-iv' ? 'ask-iv' : 'vol-markup');
  if (shaped.floorBound) clampedBy.push(floorNet.by);
  let bid = shaped.bid;
  if (bid !== null && bid >= ask) bid = ask - PRICE_TICK >= PRICE_TICK ? ask - PRICE_TICK : null;
  return { bid, ask, resale, halfSpread: shaped.halfSpread, skew: shaped.skew, widen: shaped.widen, clampedBy, volBump: bump.bump };
}

/** The earlier formula with the ask target raised by `volBump` and held at `floorNet` at least. */
function quotePricesCore(input: PriceInput, volBump: bigint, floorNet: bigint): Omit<QuotePrices, 'volBump'> & { floorBound: boolean } {
  const { fair, params } = input;
  const widen = widenBps(input.now, input.series.expiry, params);
  const halfSpread = halfSpreadUsdg6(fair, widen, params);
  const skew = skewUsdg6({ fair, delta: input.delta, spot: input.spot, netDeltaShares: input.netDeltaShares, params });
  const clampedBy: QuotePrices['clampedBy'] = [];

  let bid: bigint | null = roundDownToTick(fair - halfSpread - skew);
  const cap = roundDownToTick(input.bidCap);
  if (bid > cap) {
    bid = cap;
    clampedBy.push('bid-cap');
  }
  // THE UNGROSSED TARGET: what the vault must be left with after the book takes its seller fee. Both asks
  // are derived from this one number, and the "one tick under" relation between them holds HERE, before
  // either is grossed — see the header. Deriving the resale ask from the grossed write ask is the bug
  // this ordering exists to prevent.
  let target = roundUpToTick(fair + halfSpread - skew + volBump);
  const floorTick = roundUpToTick(floorNet);
  const floorBound = floorTick > target;
  if (floorBound) target = floorTick;
  if (target < PRICE_TICK) target = PRICE_TICK;
  // The resale target sits one tick under, but never under the P4/P5 floor either: inventory is not sold below it.
  const underTarget = target - PRICE_TICK >= floorTick ? target - PRICE_TICK : floorTick;

  const writeGross = grossUpToTick(target, quoteFeeBpsOf('AskWrite', input.fees));
  const resaleGross = grossUpToTick(underTarget, quoteFeeBpsOf('AskResale', input.fees));
  if (!writeGross.ok || !resaleGross.ok) clampedBy.push('fee-out-of-range');

  let ask = writeGross.price;
  if (ask < PRICE_TICK) ask = PRICE_TICK;
  const floor = roundUpToTick(input.askFloors.write);
  if (ask < floor) {
    ask = floor;
    clampedBy.push('ask-floor');
  }
  if (bid >= ask) {
    bid = ask - PRICE_TICK;
    clampedBy.push('crossed');
  }
  if (bid < PRICE_TICK) bid = null;

  // The resale ask rests at its OWN grossed price, checked against its OWN floor: the vault prices a resale's floor
  // net of resaleFeeBps and a write's net of premiumFeeBps (askFloorOf(longId, primary)), so the two differ whenever
  // the rates do. When it cannot clear them it falls back to the write ask, lifted to the resale floor if that is
  // the higher one (a resale resting under its own floor reverts BadPrice whatever the write floor says).
  const resaleFloor = roundUpToTick(input.askFloors.resale);
  const under = underTarget >= PRICE_TICK ? resaleGross.price : 0n;
  let resale = under >= PRICE_TICK && under >= resaleFloor && (bid === null || under > bid) ? under : ask;
  if (resale < resaleFloor) {
    resale = resaleFloor;
    if (!clampedBy.includes('ask-floor')) clampedBy.push('ask-floor');
  }
  return { bid, ask, resale, halfSpread, skew, widen, clampedBy, floorBound };
}

/*//////////////////////////////////////////////////////////////
                             DELTA
//////////////////////////////////////////////////////////////*/

export interface PositionDelta {
  underlying: string;
  /** Signed 0.01-share units: longs (wallet + resale escrow) − shorts. */
  units: bigint;
  /** Per share, or null when no delta is known for the series. */
  delta: number | null;
}

export interface NetDelta {
  /** Share-equivalent delta of the option inventory. */
  deltaShares: number;
  /** Positions whose delta is unknown (counted as 0). */
  unknown: number;
  positions: number;
}

/** Σ units / 100 × delta per underlying (lower-case address keys). */
export function netDeltaByUnderlying(positions: readonly PositionDelta[]): Map<string, NetDelta> {
  const out = new Map<string, NetDelta>();
  for (const p of positions) {
    if (p.units === 0n) continue;
    const key = p.underlying.toLowerCase();
    const row = out.get(key) ?? { deltaShares: 0, unknown: 0, positions: 0 };
    row.positions += 1;
    if (p.delta === null || !Number.isFinite(p.delta)) row.unknown += 1;
    else row.deltaShares += (Number(p.units) / Number(UNITS_PER_SHARE)) * p.delta;
    out.set(key, row);
  }
  return out;
}

/*//////////////////////////////////////////////////////////////
                             SELECTION
//////////////////////////////////////////////////////////////*/

export interface SelectInput {
  now: number;
  candidates: readonly SeriesInfo[];
  /** Spot per underlying (lower-case), USDG base units per share; missing = unknown (ranked last). */
  spots: ReadonlyMap<string, bigint>;
  pullMinutes: number;
  maxSeries: number;
  maxSeriesPerMarket: number;
  /** `null`/omitted = unrestricted. Series with expiry > epochEnd are never selected. */
  epoch?: EpochView | null;
  /**
   * P16: rank by |delta| distance from [lo, hi], delta estimated by Black-Scholes at `vol` (selection runs
   * before any /fair answer, so it cannot use the service's delta). OMITTED = the default band (SAFEST_ASK_DEFAULTS),
   * so a caller that does not pass one ranks the same way the planner does. `null` = the old nearest-the-money ranking,
   * explicitly.
   */
  deltaBand?: DeltaBand | null;
}

export interface DeltaBand {
  lo: number;
  hi: number;
  vol: number;
}

/**
 * P16: how far a series' estimated |delta| sits outside [band.lo, band.hi] (0 inside), and its distance from the band's
 * middle as the tie-break; +∞ for both without a spot.
 */
export function deltaBandRank(series: Pick<SeriesInfo, 'isPut' | 'strike' | 'expiry'>, spot: bigint | undefined, now: number, band: DeltaBand): { outside: number; fromMid: number } {
  if (spot === undefined || spot <= 0n) return { outside: Number.POSITIVE_INFINITY, fromMid: Number.POSITIVE_INFINITY };
  const g = localGreeks({ now, series, spot, vol: band.vol });
  if (g === null) return { outside: Number.POSITIVE_INFINITY, fromMid: Number.POSITIVE_INFINITY };
  const d = Math.abs(g.delta);
  const outside = d < band.lo ? band.lo - d : d > band.hi ? d - band.hi : 0;
  return { outside, fromMid: Math.abs(d - (band.lo + band.hi) / 2) };
}

/** |strike / spot − 1| in bps, or +∞ without a spot. */
export function moneynessBps(strike: bigint, spot: bigint | undefined): number {
  if (spot === undefined || spot <= 0n) return Number.POSITIVE_INFINITY;
  const diff = strike > spot ? strike - spot : spot - strike;
  return Number((diff * BPS) / spot);
}

/**
 * The series to quote: not yet in their pull window; ranked by the P16 delta band (inside the band first, then the
 * nearest to it; inside, nearest the band's middle) -- or, with `deltaBand: null`, nearest the money first -- then
 * nearest expiry, then long id; at most `maxSeriesPerMarket` per underlying and `maxSeries` in all.
 *
 * WHY NOT NEAREST THE MONEY: an at-the-money 0DTE has the most gamma per unit of premium and draws
 * the most informed flow. The band keeps the default quote in the 0.10-0.30 delta wings.
 */
export function selectSeries(input: SelectInput): SeriesInfo[] {
  const band = input.deltaBand === undefined ? { lo: SAFEST_ASK_DEFAULTS.deltaBandLo, hi: SAFEST_ASK_DEFAULTS.deltaBandHi, vol: SAFEST_ASK_DEFAULTS.selectVol } : input.deltaBand === null || input.deltaBand.hi <= 0 ? null : input.deltaBand;
  const eligible = input.candidates.filter((s) => {
    if (!(input.now < pullAtOf(s.expiry, input.pullMinutes))) return false;
    if (input.epoch != null && s.expiry > input.epoch.epochEnd) return false;
    return true;
  });
  const rankOf = new Map(eligible.map((s) => [s, band === null ? null : deltaBandRank(s, input.spots.get(s.underlying.toLowerCase()), input.now, band)]));
  const ranked = [...eligible].sort((a, b) => {
    const ra = rankOf.get(a) ?? null;
    const rb = rankOf.get(b) ?? null;
    if (ra !== null && rb !== null) {
      if (ra.outside !== rb.outside) return ra.outside < rb.outside ? -1 : 1;
      if (ra.fromMid !== rb.fromMid) return ra.fromMid < rb.fromMid ? -1 : 1;
    } else {
      const ma = moneynessBps(a.strike, input.spots.get(a.underlying.toLowerCase()));
      const mb = moneynessBps(b.strike, input.spots.get(b.underlying.toLowerCase()));
      if (ma !== mb) return ma < mb ? -1 : 1;
    }
    if (a.expiry !== b.expiry) return a.expiry - b.expiry;
    return a.longId < b.longId ? -1 : a.longId > b.longId ? 1 : 0;
  });
  const perMarket = new Map<string, number>();
  const out: SeriesInfo[] = [];
  for (const s of ranked) {
    if (out.length >= input.maxSeries) break;
    const key = s.underlying.toLowerCase();
    const n = perMarket.get(key) ?? 0;
    if (n >= input.maxSeriesPerMarket) continue;
    perMarket.set(key, n + 1);
    out.push(s);
  }
  return out;
}

/*//////////////////////////////////////////////////////////////
                           VALID UNTIL
//////////////////////////////////////////////////////////////*/

/**
 * The validUntil a new quote is placed with: the series limit (the mint cutoff for AskWrite, the expiry
 * otherwise), the pull time, the session's close when off-hours quoting is off, the vault's
 * maxOrderLifetime, and the bot's own MM_MAX_QUOTE_LIFETIME_S. A quote whose bot dies (or whose sends all
 * fail) therefore expires by itself within that lifetime, not at the session close: the book never re-checks
 * the vault's guards at fill time, and the launch vault has maxOrderLifetime 0. The refresh path re-places a
 * quote that is about to expire. null when that moment is not in the future.
 */
export function quoteValidUntil(input: QuoteLifeInput & { now: number }): number | null {
  return validUntilAt(quoteLifeOf(input), input.now);
}

export interface QuoteLifeInput {
  expiry: number;
  slot: Slot;
  pullMinutes: number;
  sessionClose: number | null;
  maxOrderLifetime: number;
  maxQuoteLifetime?: number;
  /**
   * The write stop (writeStopAtOf), write slot only. The book never re-checks a resting order, so "no new writes after
   * the stop" holds on chain only if no AskWrite placed before it is still fillable after it.
   */
  writeStopAt?: number | null;
  /**
   * The head's timestamp the plan was read at: a BLOCK timestamp, never the bot's estimate of the chain's time.
   * Given, a positive `maxOrderLifetime` is a fixed moment `now + maxOrderLifetime` in `cap` rather than a lifetime
   * counted from the send, because the vault measures it from the block the place lands in (`_boundLifetime`: PastCutoff
   * above `block.timestamp + maxOrderLifetime`) and the simulation from the latest block, neither ever before the head;
   * the send-time estimate (quoter.ts chainNow, head time plus wall-clock seconds since) can run ahead of both. Absent,
   * the vault's lifetime counts from the send as before (callers without a head).
   */
  now?: number;
}

/**
 * {quoteValidUntil} in two parts, so the quoter can stamp a place when it SENDS it rather than when the tick
 * planned it: `cap`, the moments that do not move with the clock (the series limit, the pull time, the write stop, the
 * session close), and `lifetime`, the part measured from the send (the smaller of a positive vault maxOrderLifetime and
 * MM_MAX_QUOTE_LIFETIME_S; 0 = neither). A tick that runs long (a slow or rate-limited RPC) otherwise sent its late
 * places with a lifetime counted from the tick's start: measured on a v9 fork, 76-123 s ticks placed orders
 * that lived 6-14 s.
 */
export interface QuoteLife {
  cap: number;
  lifetime: number;
}

export function quoteLifeOf(input: QuoteLifeInput): QuoteLife {
  const limit = input.slot === 'write' ? mintCutoffOf(input.expiry) : input.expiry;
  let cap = Math.min(limit, pullAtOf(input.expiry, input.pullMinutes));
  if (input.slot === 'write' && input.writeStopAt != null) cap = Math.min(cap, input.writeStopAt);
  if (input.sessionClose !== null) cap = Math.min(cap, input.sessionClose);
  // With the head's time, the vault's bound is anchored there (see QuoteLifeInput.now); only the bot's own
  // MM_MAX_QUOTE_LIFETIME_S still rides on the send.
  const anchored = input.now !== undefined && input.maxOrderLifetime > 0;
  if (anchored) cap = Math.min(cap, input.now! + input.maxOrderLifetime);
  const lifetimes = [anchored ? 0 : input.maxOrderLifetime, input.maxQuoteLifetime ?? 0].filter((l) => l > 0);
  return { cap, lifetime: lifetimes.length === 0 ? 0 : Math.min(...lifetimes) };
}

/** The validUntil of a quote with life `life` sent at `now`: null when that moment is not in the future. */
export function validUntilAt(life: QuoteLife, now: number): number | null {
  const until = life.lifetime > 0 ? Math.min(life.cap, now + life.lifetime) : life.cap;
  return until > now ? until : null;
}

/*//////////////////////////////////////////////////////////////
                         REPLACE DISCIPLINE
//////////////////////////////////////////////////////////////*/

export interface LiveOrder {
  id: bigint;
  kind: OrderKindName;
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
}

export const isLiveOrder = (o: LiveOrder, now: number): boolean => !o.cancelled && o.filled < o.units && now < o.validUntil;

/** Past validUntil but never cancelled or filled: a Bid still escrows USDG and an AskResale longs until someone cancels
 *  or prunes it. The bot cancels its own to have them back at once. */
export const isReclaimable = (o: LiveOrder, now: number): boolean => !o.cancelled && o.filled < o.units && now >= o.validUntil && o.kind !== 'AskWrite';

/** What the kill switch must cancel before it may say it is done: a live order, or an expired one that still holds
 *  escrow. An expired AskWrite is neither (it escrows nothing and can no longer fill). */
export const isKillTarget = (o: LiveOrder, now: number): boolean => isLiveOrder(o, now) || isReclaimable(o, now);

export interface SlotTarget {
  price: bigint;
  units: bigint;
}

/**
 * `protective`: the action takes off or corrects a quote the bot's risk rules no longer allow
 * (a halt, a pull or a lost target; a bid over a cap; an ask under a floor; a size over its target; an extra order), so
 * it is sent on the read that finds it. Absent = routine, sent only on a vault's routine send (MM_SEND_INTERVAL_S):
 * places, requotes on a price move or an under-size, refreshes before validUntil, and reclaims of expired escrow.
 *
 * A place carries its `life` ({quoteLifeOf}) so the quoter restamps `validUntil` from the chain time at SEND,
 * and a replace carries its order's `orderValidUntil` so the quoter re-checks the replace margin at send and skips a
 * replace the order no longer has time for. Absent (a caller that built the action by hand): sent as planned.
 */
export type MmAction =
  | { type: 'cancel'; longId: bigint; orderIds: bigint[]; reason: string; protective?: true }
  | { type: 'replace'; longId: bigint; slot: Slot; orderId: bigint; price: bigint; units: bigint; fromPrice: bigint; fromUnits: bigint; reason: string; protective?: true; orderValidUntil?: number }
  | { type: 'place'; longId: bigint; slot: Slot; kind: number; price: bigint; units: bigint; validUntil: number; reason: string; protective?: true; life?: QuoteLife };

/** |target − current| / current in bps (current > 0). */
export function moveBps(current: bigint, target: bigint): number {
  if (current <= 0n) return Number.POSITIVE_INFINITY;
  const diff = target > current ? target - current : current - target;
  return Number((diff * BPS) / current);
}

export interface ReplaceJudgement {
  replace: boolean;
  reason: string;
  /**
   * The live quote breaks a bound (a cap or a floor, or rests more than its size target), so the fix is
   * protective and goes out on the read that finds it. A price move past MM_REQUOTE_BPS or a quote under its size is a
   * routine requote and waits for the vault's next routine send.
   */
  protective: boolean;
}

/** Whether a live quote must be replaced to reach `target` (header: REPLACE DISCIPLINE). */
export function judgeReplace(input: {
  order: LiveOrder;
  target: SlotTarget;
  slot: Slot;
  askFloors: AskFloors;
  bidCap: bigint;
  /**
   * This slot's spot-lag bound (mm/spot-lag.ts SpotLagQuote.floor): for an ask its floor, and a live ask under it is
   * replaced whatever the move; for the bid its cap, and a live bid over it is replaced whatever the move.
   * MM_REQUOTE_BPS is a gas rule; it must not leave a quote the market has moved through resting for a taker who can see
   * the move before the oracle prints it.
   */
  safeFloor?: bigint | null;
  params: Pick<QuoteParams, 'requoteBps' | 'resizeBps'>;
}): ReplaceJudgement {
  const { order, target, params } = input;
  const remaining = order.units - order.filled;
  if (input.slot === 'bid' && order.price > input.bidCap) return { replace: true, protective: true, reason: `bid ${order.price} above the bid cap ${input.bidCap}` };
  if (input.slot === 'bid' && input.safeFloor != null && order.price > input.safeFloor) return { replace: true, protective: true, reason: `bid ${order.price} above the spot-lag cap ${input.safeFloor}` };
  const askFloor = input.slot === 'resale' ? input.askFloors.resale : input.askFloors.write;
  if (input.slot !== 'bid' && order.price < askFloor) return { replace: true, protective: true, reason: `ask ${order.price} below the ${input.slot} ask floor ${askFloor}` };
  if (input.slot !== 'bid' && input.safeFloor != null && order.price < input.safeFloor) return { replace: true, protective: true, reason: `ask ${order.price} below the spot-lag floor ${input.safeFloor}` };
  const move = moveBps(order.price, target.price);
  if (move > params.requoteBps) return { replace: true, protective: false, reason: `price ${order.price} -> ${target.price} (${move} bps > ${params.requoteBps})` };
  if (remaining > target.units) return { replace: true, protective: true, reason: `size ${remaining} above the target ${target.units}` };
  const floorUnits = (target.units * BigInt(10_000 - params.resizeBps)) / BPS;
  if (remaining < floorUnits) return { replace: true, protective: false, reason: `size ${remaining} under ${floorUnits} (target ${target.units})` };
  return { replace: false, protective: false, reason: 'within thresholds' };
}

export interface SeriesActionInput {
  longId: bigint;
  now: number;
  /** Every vault order known on the series (dead ones are ignored). */
  orders: readonly LiveOrder[];
  /** null for a halted series: pull everything. A slot with null or zero units is pulled. */
  targets: Record<Slot, SlotTarget | null> | null;
  haltReason?: string;
  validUntil: Record<Slot, number | null>;
  /** Each slot's {quoteLifeOf}, attached to its places (the quoter restamps validUntil at send). */
  life?: Partial<Record<Slot, QuoteLife | null>>;
  /**
   * The vault's ask floor per kind, or null when it could not be read. A series with targets and no floors is pulled
   * like a halted one: a failed read is never a zero floor. The planner only prices with floors in hand, so this is the
   * fail-closed answer to a caller that does not.
   */
  askFloors: AskFloors | null;
  bidCap: bigint;
  /** A live quote expiring within this many seconds is re-placed when a later validUntil is allowed. */
  refreshS: number;
  /**
   * No `replace` is sent for a live quote expiring within this many seconds. OrderBook.replace reverts
   * OrderNotLive once the block reaches the order's validUntil, and a replace sent now can land up to one poll plus
   * the tx-confirm timeout later. A quote that must still move is cancelled and placed fresh instead (cancel takes an
   * expired order); one that need not move is left to lapse. The quoter passes config.ts replaceMarginOf
   * (MM_REPLACE_CONFIRM_S); refreshS when absent.
   */
  replaceMarginS?: number;
  params: Pick<QuoteParams, 'requoteBps' | 'resizeBps'>;
  /**
   * The spot-lag bound per slot (mm/spot-lag.ts SpotLagQuote.floor): a live ask under its slot's floor, or a live bid
   * over the bid's cap, is replaced at once.
   */
  safeFloor?: { write: bigint; resale: bigint; bid: bigint } | null;
}

/**
 * The vault calls that take one series from its live orders to its targets, cancels first. Expired orders that still
 * hold escrow are cancelled with them (isReclaimable), halted or not.
 */
export function planSeriesActions(input: SeriesActionInput): MmAction[] {
  const live = input.orders.filter((o) => isLiveOrder(o, input.now));
  const reclaim = input.orders.filter((o) => isReclaimable(o, input.now));
  // Each cancel carries whether it is protective (see MmAction); a reclaim of expired escrow is not.
  const cancels: Array<{ id: bigint; reason: string; protective: boolean }> = reclaim.map((o) => ({ id: o.id, reason: `reclaim expired ${o.kind} ${o.id}`, protective: false }));
  const replaces: MmAction[] = [];
  const places: MmAction[] = [];
  const replaceMarginS = input.replaceMarginS ?? input.refreshS;
  const flag = (protective: boolean): { protective?: true } => (protective ? { protective: true } : {});
  const lifeOf = (slot: Slot): { life?: QuoteLife } => {
    const life = input.life?.[slot];
    return life == null ? {} : { life };
  };

  if (input.targets === null || input.askFloors === null) {
    const ids = [...cancels.map((c) => c.id), ...live.map((o) => o.id)];
    if (ids.length === 0) return [];
    const halted = input.targets === null ? (input.haltReason ?? 'halted') : 'ask floors unread';
    const reclaims = cancels.map((c) => c.reason).join('; ');
    const why = live.length === 0 ? reclaims : `${halted}${reclaim.length > 0 ? `; ${reclaims}` : ''}`;
    // A halt, a pull or unread floors takes live quotes off at once; reclaims alone wait for a routine send.
    return [{ type: 'cancel', longId: input.longId, orderIds: ids, reason: why, ...flag(live.length > 0) }];
  }
  const askFloors = input.askFloors;

  for (const slot of ['bid', 'write', 'resale'] as const) {
    const kind = SLOT_KIND[slot];
    // Newest first: extras (an admin's order, a replace the journal lost) are cancelled.
    const mine = live.filter((o) => o.kind === kind).sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
    const [keep, ...extra] = mine;
    for (const o of extra) cancels.push({ id: o.id, reason: `extra ${slot} ${o.id}`, protective: true });
    const target = input.targets[slot];
    const validUntil = input.validUntil[slot];
    if (target === null || target.units <= 0n || validUntil === null) {
      if (keep !== undefined) cancels.push({ id: keep.id, reason: `no ${slot} target`, protective: true });
      continue;
    }
    if (keep === undefined) {
      places.push({ type: 'place', longId: input.longId, slot, kind: KIND_INDEX[kind], price: target.price, units: target.units, validUntil, reason: `no live ${slot}`, ...lifeOf(slot) });
      continue;
    }
    if (keep.validUntil - input.now < input.refreshS && validUntil > keep.validUntil + input.refreshS) {
      // replace keeps validUntil: an expiring quote is re-placed instead.
      cancels.push({ id: keep.id, reason: `${slot} ${keep.id} expires at ${keep.validUntil}`, protective: false });
      places.push({ type: 'place', longId: input.longId, slot, kind: KIND_INDEX[kind], price: target.price, units: target.units, validUntil, reason: 'refresh before validUntil', ...lifeOf(slot) });
      continue;
    }
    const safeFloor = input.safeFloor == null ? null : input.safeFloor[slot];
    const judgement = judgeReplace({ order: keep, target, slot, askFloors, bidCap: input.bidCap, safeFloor, params: input.params });
    if (judgement.replace && keep.validUntil - input.now < replaceMarginS) {
      // Too close to validUntil for a replace to land in time (OrderBook.replace reverts OrderNotLive past it).
      cancels.push({ id: keep.id, reason: `${slot} ${keep.id} expires at ${keep.validUntil}, inside the ${replaceMarginS} s replace margin`, protective: judgement.protective });
      places.push({ type: 'place', longId: input.longId, slot, kind: KIND_INDEX[kind], price: target.price, units: target.units, validUntil, reason: `placed fresh, not replaced: ${judgement.reason}`, ...flag(judgement.protective), ...lifeOf(slot) });
      continue;
    }
    if (judgement.replace) {
      replaces.push({ type: 'replace', longId: input.longId, slot, orderId: keep.id, price: target.price, units: target.units, fromPrice: keep.price, fromUnits: keep.units - keep.filled, reason: judgement.reason, ...flag(judgement.protective), orderValidUntil: keep.validUntil });
    }
  }

  const out: MmAction[] = [];
  // Protective cancels first, in their own action, so a read that may only send those can take them alone.
  for (const protective of [true, false]) {
    const part = cancels.filter((c) => c.protective === protective);
    if (part.length > 0) out.push({ type: 'cancel', longId: input.longId, orderIds: part.map((c) => c.id), reason: part.map((c) => c.reason).join('; '), ...flag(protective) });
  }
  return [...out, ...replaces, ...places];
}

/**
 * Every action of a tick in execution order, series priority kept inside each group:
 *   1. every cancel;
 *   2. every protective replace, and every replace to fewer units (it frees notional, write collateral or inventory);
 *   3. ask places (a series with no ask is dark to buyers; a missing bid is not);
 *   4. routine bid replaces that only free escrow: same units, lower price;
 *   5. bid places;
 *   6. every other replace: a price move that frees nothing (an ask's, a bid's upward) or more units.
 * Shrinking replaces go before growing ones inside 2 and 6, as before.
 * WHY THIS ORDER. The send budget cuts the tail of the list. Earlier places came last, so under a moving spot the
 * routine 1 % requotes took the budget and the series whose ask was due for a place stayed dark (measured 36-40
 * of 47 with an ask). Routine requotes now go after the places; the next routine send plans them again.
 * WHY IT CANNOT OVER-COMMIT, resource by resource, for EVERY prefix a budget can cut. Notional, write collateral and
 * inventory move only with units: 1-2 free them, 4 holds them, 3, 5 and 6 only add, so a prefix never holds more than
 * the larger of where the tick started and where the full plan ends. Bid escrow: 1-4 free or hold it (a protective
 * replace lowers a bid, an ask costs no USDG), 5-6 only add. The planner holds both ends inside the vault's limits. The
 * one exception is older than this order: a replace to fewer units at a higher bid price (2) can add escrow before 4
 * frees it; the vault's own outflow cap and, on a House vault, the send-time reserve re-check (quoter.ts)
 * still refuse what does not fit.
 */
export function orderActions(perSeries: readonly MmAction[][]): MmAction[] {
  const flat = perSeries.flat();
  const replaces = flat.filter((a): a is Extract<MmAction, { type: 'replace' }> => a.type === 'replace');
  const places = flat.filter((a): a is Extract<MmAction, { type: 'place' }> => a.type === 'place');
  const early = (a: Extract<MmAction, { type: 'replace' }>): boolean => a.protective === true || a.units < a.fromUnits;
  const escrowOnly = (a: Extract<MmAction, { type: 'replace' }>): boolean =>
    !early(a) && a.slot === 'bid' && a.units === a.fromUnits && a.price < a.fromPrice;
  const shrinkFirst = (xs: Extract<MmAction, { type: 'replace' }>[]) => [...xs.filter((a) => a.units <= a.fromUnits), ...xs.filter((a) => a.units > a.fromUnits)];
  return [
    ...flat.filter((a) => a.type === 'cancel'),
    ...shrinkFirst(replaces.filter(early)),
    ...places.filter((a) => a.slot !== 'bid'),
    ...replaces.filter(escrowOnly),
    ...places.filter((a) => a.slot === 'bid'),
    ...shrinkFirst(replaces.filter((a) => !early(a) && !escrowOnly(a))),
  ];
}
