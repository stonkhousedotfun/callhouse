/**
 * The MM bot's quote engine: pure functions from what a tick read to the prices it wants, and from
 * those to the vault calls that get there. Nothing here reads a chain, a clock or the network
 * (mm/quoter.ts gathers; mm/risk.ts sizes; mm/pnl.ts keeps the realised-loss ledger).
 *
 * PRICES are USDG base units (6 dp) per WHOLE share, on the book's PRICE_TICK (100) grid; sizes are
 * 0.01-share units; `delta` is the pricing service's, dPrice/dTokenSpot per share (K2-02).
 *
 * THE QUOTE (K2-04):
 *   halfSpread = max(fair × MM_HALF_SPREAD_BPS / 1e4, MM_MIN_HALF_SPREAD_USDG6) × widen
 *   skew       = seriesDelta × spot × MM_SKEW_BPS_PER_DELTA_SHARE / 1e4 × netDeltaShares,
 *                capped at ± fair × MM_MAX_SKEW_BPS / 1e4
 *   bid        = roundDown(fair − halfSpread − skew), never above the vault's bidCap
 *   target     = fair + halfSpread − skew                     (the NET the vault must keep)
 *   writeAsk   = roundUp(target / (1 − premiumFeeBps/1e4)),   never below the vault's askFloor
 *   resaleAsk  = roundUp((target − PRICE_TICK) / (1 − resaleFeeBps/1e4))
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
 *   StaleSpot), not-selected (beyond MM_MAX_SERIES), fair-unavailable (the pricing service said null or
 *   could not be reached), fair-stale (asOf older than the limit against the head block), fair-spot-mismatch (priced at
 *   a spot more than MM_FAIR_SPOT_TOLERANCE_BPS from the oracle's), fair-out-of-bounds (a call fair at or above spot,
 *   a put fair at or above strike, or a quoted fair below its intrinsic value at the oracle's spot), guards-unreadable,
 *   epoch-outside (series.expiry > vault epochEnd as
 *   the runtime read it; costs no /fair), epoch-winddown (inside the lead: no NEW risk; unwind still
 *   plans), protocol-cross (a rest would cross a protocol-owned maker; skip that slot). Inside the
 *   tolerance, the fair value is carried to the oracle's spot along its delta (fairAtSpot) before it is quoted, and a
 *   fair that carries to zero is fair-unavailable too (quotedFairOf, judged after fair-spot-mismatch). The fair checks
 *   are one function, fairCheckOf, which the planner also runs before it prices a series that is winding down.
 *
 * REPLACE DISCIPLINE (gas): a live quote is left alone unless its target price moved more than
 * MM_REQUOTE_BPS, its remaining size is above the target or more than MM_RESIZE_BPS below it, it now sits
 * outside a vault guard, or it is about to expire while a later validUntil is allowed.
 */
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
  | { ok: true; fair: bigint; delta: number; iv: number; asOf: number; source: string; spot?: bigint }
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
  /** T-OP-133: MM_ASK_FALLBACK_ONLY=1 and another maker's live ask rests on the series; the bot's ask side stays off. */
  'other-asker',
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
  sessionOpen: boolean;
  marketEnabled: boolean;
  /** false: the series' market is outside the quoted set (MM_MARKETS, or not live): pull-only. Default true. */
  marketQuoted?: boolean;
  spotFresh: boolean;
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
  guardsOk: boolean;
}

/** Every halt judged before a fair value is needed: a series halted here costs no /fair request. */
export function haltBeforeFair(input: Omit<HaltInput, 'fair' | 'guardsOk'>): Halt | null {
  const { now, series, params } = input;
  if (input.killed) return { halt: 'killed' };
  if (input.lossStopped) return { halt: 'loss-stop' };
  if (!input.isQuoter) return { halt: 'not-quoter' };
  if (input.tradingPaused) return { halt: 'trading-paused' };
  if (now >= series.expiry) return { halt: 'expired' };
  if (now >= pullAtOf(series.expiry, params.pullMinutes)) return { halt: 'pull-window', detail: `pulled at ${pullAtOf(series.expiry, params.pullMinutes)}` };
  if (!input.sessionOpen && !params.quoteOffHours) return { halt: 'market-closed' };
  if (input.marketQuoted === false) return { halt: 'market-not-quoted' };
  if (!input.marketEnabled) return { halt: 'market-disabled' };
  if (!input.spotFresh) return { halt: 'spot-stale' };
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

export type FairCheckInput = Pick<HaltInput, 'now' | 'series' | 'params' | 'sessionOpen' | 'fair' | 'spot'>;

/**
 * Every check a fair value must pass before it may price an order, and the fair that is then QUOTED at the oracle's
 * spot ({quotedFairOf}), which is null when there is no positive oracle spot to quote at.
 *
 * T-484. ONE function for haltOf AND the planner's pricing branch. epoch-winddown returns from {haltBeforeFair} before
 * haltOf reaches any fair check, yet the planner still prices a wind-down's resale asks from that fair: until this was
 * shared, a stale or spot-mismatched fair priced them (T-474 had added only the zero case to that path). Whatever the
 * halt phase, a price the MM posts has passed every check here.
 */
export function fairCheckOf(input: FairCheckInput): { halt: Halt; quoted: null } | { halt: null; quoted: bigint | null } {
  const halted = (halt: Halt) => ({ halt, quoted: null });
  const { now, params } = input;
  if (input.fair === undefined) return halted({ halt: 'fair-unavailable', detail: 'not requested' });
  if (!input.fair.ok) return halted({ halt: 'fair-unavailable', detail: input.fair.reason });
  const maxAge = input.sessionOpen ? params.fairMaxAgeS : params.fairMaxAgeOffHoursS;
  if (now - input.fair.asOf > maxAge) return halted({ halt: 'fair-stale', detail: `asOf ${input.fair.asOf} is ${now - input.fair.asOf} s old (limit ${maxAge})` });
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
  // T-474. The fair that is QUOTED is fairAtSpot's, not the raw answer: a positive raw fair carried down along its
  // delta can reach zero, and the check above the spot block never sees it.
  const quoted = quotedFairOf(input.fair, input.spot);
  if (quoted.halt !== null) return halted(quoted.halt);
  const bound = input.series.isPut ? input.series.strike : input.spot;
  if (input.fair.fair >= bound) return halted({ halt: 'fair-out-of-bounds', detail: `fair ${input.fair.fair} at or above the ${input.series.isPut ? 'strike' : 'spot'} ${bound}` });
  // T-484. The no-arbitrage LOWER bound, on the QUOTED fair at the oracle's spot: an option is worth at least its
  // intrinsic value, max(0, spot − strike) for a call and max(0, strike − spot) for a put, all in USDG base units per
  // share. Exact, no tolerance: neither side is tick-rounded here (quotePrices rounds afterwards), so there is no
  // rounding to absorb. A fair below it is the costliest wrong fair, a too-low price on an in-the-money series.
  // Out of the money the bound is 0 and a positive quoted fair always clears it.
  const intrinsic = intrinsicOf(input.series, input.spot);
  if (quoted.quoted < intrinsic) return halted({ halt: 'fair-out-of-bounds', detail: `quoted fair ${quoted.quoted} below the intrinsic ${intrinsic} at the oracle's spot ${input.spot}` });
  return { halt: null, quoted: quoted.quoted };
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
 * T-474. haltOf judged only the RAW fair, and the planner quoted {fairAtSpot}, which clamps at zero. A raw fair of 0.5
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
function grossUpToTick(price: bigint, feeBps: number): { price: bigint; ok: boolean } {
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
  /** Which guard moved a price, for /state. `fee-out-of-range` means the ask is UNGROSSED and too cheap. */
  clampedBy: Array<'bid-cap' | 'ask-floor' | 'crossed' | 'fee-out-of-range'>;
}

export interface PriceInput {
  now: number;
  series: Pick<SeriesInfo, 'expiry'>;
  fair: bigint;
  delta: number;
  spot: bigint;
  netDeltaShares: number;
  /** MakerVault.askFloor(longId): asks below it revert BadPrice. */
  askFloor: bigint;
  /** MakerVault.bidCap(longId): bids above it revert BadPrice. */
  bidCap: bigint;
  /** OrderBook.feeParams() and pendingFeeParams() as this tick read them: per-tick chain state, not config. */
  fees: QuoteFees;
  params: QuoteParams;
}

/** Tick-rounded, guard-respecting bid and ask around fair (the header's formula). */
export function quotePrices(input: PriceInput): QuotePrices {
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
  let target = roundUpToTick(fair + halfSpread - skew);
  if (target < PRICE_TICK) target = PRICE_TICK;
  const underTarget = target - PRICE_TICK;

  const writeGross = grossUpToTick(target, quoteFeeBpsOf('AskWrite', input.fees));
  const resaleGross = grossUpToTick(underTarget, quoteFeeBpsOf('AskResale', input.fees));
  if (!writeGross.ok || !resaleGross.ok) clampedBy.push('fee-out-of-range');

  let ask = writeGross.price;
  if (ask < PRICE_TICK) ask = PRICE_TICK;
  const floor = roundUpToTick(input.askFloor);
  if (ask < floor) {
    ask = floor;
    clampedBy.push('ask-floor');
  }
  if (bid >= ask) {
    bid = ask - PRICE_TICK;
    clampedBy.push('crossed');
  }
  if (bid < PRICE_TICK) bid = null;

  // The resale ask rests at its OWN grossed price. It is checked against the same guards the write ask is,
  // because those are the vault's on-chain guards on the price that actually rests; when it cannot clear
  // them it falls back to the write ask exactly as it did before.
  const under = underTarget >= PRICE_TICK ? resaleGross.price : 0n;
  const resale = under >= PRICE_TICK && under >= floor && (bid === null || under > bid) ? under : ask;
  return { bid, ask, resale, halfSpread, skew, widen, clampedBy };
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
}

/** |strike / spot − 1| in bps, or +∞ without a spot. */
export function moneynessBps(strike: bigint, spot: bigint | undefined): number {
  if (spot === undefined || spot <= 0n) return Number.POSITIVE_INFINITY;
  const diff = strike > spot ? strike - spot : spot - strike;
  return Number((diff * BPS) / spot);
}

/**
 * The series to quote: not yet in their pull window, nearest the money first, then nearest expiry,
 * then long id; at most `maxSeriesPerMarket` per underlying and `maxSeries` in all.
 */
export function selectSeries(input: SelectInput): SeriesInfo[] {
  const eligible = input.candidates.filter((s) => {
    if (!(input.now < pullAtOf(s.expiry, input.pullMinutes))) return false;
    if (input.epoch != null && s.expiry > input.epoch.epochEnd) return false;
    return true;
  });
  const ranked = [...eligible].sort((a, b) => {
    const ma = moneynessBps(a.strike, input.spots.get(a.underlying.toLowerCase()));
    const mb = moneynessBps(b.strike, input.spots.get(b.underlying.toLowerCase()));
    if (ma !== mb) return ma < mb ? -1 : 1;
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
export function quoteValidUntil(input: { now: number; expiry: number; slot: Slot; pullMinutes: number; sessionClose: number | null; maxOrderLifetime: number; maxQuoteLifetime?: number }): number | null {
  const limit = input.slot === 'write' ? mintCutoffOf(input.expiry) : input.expiry;
  let until = Math.min(limit, pullAtOf(input.expiry, input.pullMinutes));
  if (input.sessionClose !== null) until = Math.min(until, input.sessionClose);
  if (input.maxOrderLifetime > 0) until = Math.min(until, input.now + input.maxOrderLifetime);
  if (input.maxQuoteLifetime !== undefined && input.maxQuoteLifetime > 0) until = Math.min(until, input.now + input.maxQuoteLifetime);
  return until > input.now ? until : null;
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

export type MmAction =
  | { type: 'cancel'; longId: bigint; orderIds: bigint[]; reason: string }
  | { type: 'replace'; longId: bigint; slot: Slot; orderId: bigint; price: bigint; units: bigint; fromPrice: bigint; fromUnits: bigint; reason: string }
  | { type: 'place'; longId: bigint; slot: Slot; kind: number; price: bigint; units: bigint; validUntil: number; reason: string };

/** |target − current| / current in bps (current > 0). */
export function moveBps(current: bigint, target: bigint): number {
  if (current <= 0n) return Number.POSITIVE_INFINITY;
  const diff = target > current ? target - current : current - target;
  return Number((diff * BPS) / current);
}

export interface ReplaceJudgement {
  replace: boolean;
  reason: string;
}

/** Whether a live quote must be replaced to reach `target` (header: REPLACE DISCIPLINE). */
export function judgeReplace(input: { order: LiveOrder; target: SlotTarget; slot: Slot; askFloor: bigint; bidCap: bigint; params: Pick<QuoteParams, 'requoteBps' | 'resizeBps'> }): ReplaceJudgement {
  const { order, target, params } = input;
  const remaining = order.units - order.filled;
  if (input.slot === 'bid' && order.price > input.bidCap) return { replace: true, reason: `bid ${order.price} above the bid cap ${input.bidCap}` };
  if (input.slot !== 'bid' && order.price < input.askFloor) return { replace: true, reason: `ask ${order.price} below the ask floor ${input.askFloor}` };
  const move = moveBps(order.price, target.price);
  if (move > params.requoteBps) return { replace: true, reason: `price ${order.price} -> ${target.price} (${move} bps > ${params.requoteBps})` };
  if (remaining > target.units) return { replace: true, reason: `size ${remaining} above the target ${target.units}` };
  const floorUnits = (target.units * BigInt(10_000 - params.resizeBps)) / BPS;
  if (remaining < floorUnits) return { replace: true, reason: `size ${remaining} under ${floorUnits} (target ${target.units})` };
  return { replace: false, reason: 'within thresholds' };
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
  askFloor: bigint;
  bidCap: bigint;
  /** A live quote expiring within this many seconds is re-placed when a later validUntil is allowed. */
  refreshS: number;
  params: Pick<QuoteParams, 'requoteBps' | 'resizeBps'>;
}

/**
 * The vault calls that take one series from its live orders to its targets, cancels first. Expired orders that still
 * hold escrow are cancelled with them (isReclaimable), halted or not.
 */
export function planSeriesActions(input: SeriesActionInput): MmAction[] {
  const live = input.orders.filter((o) => isLiveOrder(o, input.now));
  const reclaim = input.orders.filter((o) => isReclaimable(o, input.now));
  const cancels: bigint[] = reclaim.map((o) => o.id);
  const cancelReasons: string[] = reclaim.map((o) => `reclaim expired ${o.kind} ${o.id}`);
  const replaces: MmAction[] = [];
  const places: MmAction[] = [];

  if (input.targets === null) {
    const ids = [...cancels, ...live.map((o) => o.id)];
    if (ids.length === 0) return [];
    const why = live.length === 0 ? cancelReasons.join('; ') : `${input.haltReason ?? 'halted'}${reclaim.length > 0 ? `; ${cancelReasons.join('; ')}` : ''}`;
    return [{ type: 'cancel', longId: input.longId, orderIds: ids, reason: why }];
  }

  for (const slot of ['bid', 'write', 'resale'] as const) {
    const kind = SLOT_KIND[slot];
    // Newest first: extras (an admin's order, a replace the journal lost) are cancelled.
    const mine = live.filter((o) => o.kind === kind).sort((a, b) => (a.id > b.id ? -1 : a.id < b.id ? 1 : 0));
    const [keep, ...extra] = mine;
    for (const o of extra) {
      cancels.push(o.id);
      cancelReasons.push(`extra ${slot} ${o.id}`);
    }
    const target = input.targets[slot];
    const validUntil = input.validUntil[slot];
    if (target === null || target.units <= 0n || validUntil === null) {
      if (keep !== undefined) {
        cancels.push(keep.id);
        cancelReasons.push(`no ${slot} target`);
      }
      continue;
    }
    if (keep === undefined) {
      places.push({ type: 'place', longId: input.longId, slot, kind: KIND_INDEX[kind], price: target.price, units: target.units, validUntil, reason: `no live ${slot}` });
      continue;
    }
    if (keep.validUntil - input.now < input.refreshS && validUntil > keep.validUntil + input.refreshS) {
      // replace keeps validUntil: an expiring quote is re-placed instead.
      cancels.push(keep.id);
      cancelReasons.push(`${slot} ${keep.id} expires at ${keep.validUntil}`);
      places.push({ type: 'place', longId: input.longId, slot, kind: KIND_INDEX[kind], price: target.price, units: target.units, validUntil, reason: 'refresh before validUntil' });
      continue;
    }
    const judgement = judgeReplace({ order: keep, target, slot, askFloor: input.askFloor, bidCap: input.bidCap, params: input.params });
    if (judgement.replace) {
      replaces.push({ type: 'replace', longId: input.longId, slot, orderId: keep.id, price: target.price, units: target.units, fromPrice: keep.price, fromUnits: keep.units - keep.filled, reason: judgement.reason });
    }
  }

  const out: MmAction[] = [];
  if (cancels.length > 0) out.push({ type: 'cancel', longId: input.longId, orderIds: cancels, reason: cancelReasons.join('; ') });
  return [...out, ...replaces, ...places];
}

/**
 * Every action of a tick in execution order: all cancels, then replaces that shrink a quote, then those that grow one,
 * then places (series priority kept inside each group). Shrinking first leaves room under the vault's total-notional
 * cap for what grows later in the same tick.
 */
export function orderActions(perSeries: readonly MmAction[][]): MmAction[] {
  const flat = perSeries.flat();
  const replaces = flat.filter((a): a is Extract<MmAction, { type: 'replace' }> => a.type === 'replace');
  return [
    ...flat.filter((a) => a.type === 'cancel'),
    ...replaces.filter((a) => a.units <= a.fromUnits),
    ...replaces.filter((a) => a.units > a.fromUnits),
    ...flat.filter((a) => a.type === 'place'),
  ];
}
