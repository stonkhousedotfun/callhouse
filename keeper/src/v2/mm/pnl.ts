/**
 * The MM bot's realised profit and loss, for the daily realised-loss stop. Pure.
 *
 * WHAT COUNTS. Average cost per series, in USDG base units:
 *   - a fill of a vault Bid buys `units` at the order's price;
 *   - a fill of a vault AskWrite (primary) or AskResale sells `units` for the premium less the seller
 *     fee the book took from the maker. Exactly: the OrderFilled logs of the fill carry `premium` and
 *     `sellerFee` (matchFillLogs). Where the logs cannot account for the fill, conservatively: the
 *     highest seller fee (premiumFeeBps for primary fills, resaleFeeBps for resale) of any fee regime
 *     that can have been in effect between the bot's previous look and this one
 *     (conservativeSellerFeeBps). Since INTERFACE_VERSION 6 a fee change takes effect 24 h after it
 *     is scheduled, so a fill made before `effectiveAt` and seen after it must not be booked at the
 *     new fees: a fee cut read at detection would overstate the proceeds, understate the day's loss,
 *     and weaken the loss stop;
 *   - buying against a short position, or selling against a long one, realises
 *     (sale − average cost) × closed units / 100; the rest opens the other way at the fill price;
 *   - settlement of a series with a position realises it at intrinsic value per share at the
 *     settlement price (calls max(P − K, 0), puts max(K − P, 0)): a short call that settles in the money
 *     loses exactly that, whatever the collateral was; a long receives it less the series' exercise fee
 *     (Clearinghouse longPayoutPerUnit), so a long is booked net of exerciseFeeBps.
 * Maker rebates are income the stop ignores (a conservative stop). Positions the vault got some other
 * way (an admin's transfer) are not in the ledger. Units are 0.01 share, so premium = price × units / 100.
 *
 * WHICH DAY. A fill or a settlement belongs to the UTC day of the head block at which the bot first
 * saw it (`dayOf`). The stop trips when that day's realised result is at or below −MM_DAILY_LOSS_LIMIT and
 * holds until the day changes.
 */
import { BPS, UNITS_PER_SHARE } from './constants.js';

export type LedgerEvent =
  | {
      type: 'fill';
      longId: string;
      side: 'buy' | 'sell';
      units: bigint;
      price: bigint;
      /** The seller fee rate booked: exact fills carry the rate their logs imply (informational), others the rate used. */
      feeBps: number;
      /**
       * A sale matched to its OrderFilled logs: the premium and the seller fee the book computed, USDG base units. When
       * both are present the proceeds are `premium - sellerFee` and `feeBps` is not used.
       */
      premium?: bigint;
      sellerFee?: bigint;
      at: number;
    }
  /** `exerciseFeeBps`: the series' exercise fee, taken from the long payout (absent on rows stored before it: none). */
  | { type: 'settle'; longId: string; isPut: boolean; strike: bigint; settlementPrice: bigint; exerciseFeeBps?: number; at: number };

export interface Position {
  /** Signed units: positive long, negative short. */
  units: bigint;
  /** |units| × average price (USDG base units per share × units), so the average is basis / |units|. */
  basis: bigint;
}

export const dayOf = (timestamp: number): number => Math.floor(timestamp / 86_400);

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

/** Proceeds per share after the seller fee. */
export const netSalePrice = (price: bigint, feeBps: number): bigint => (price * (BPS - BigInt(feeBps))) / BPS;

/** Proceeds per share of a sale whose premium and seller fee are known exactly, floored (never above what was paid). */
export function exactNetSalePrice(units: bigint, premium: bigint, sellerFee: bigint): bigint {
  if (units <= 0n || premium <= sellerFee) return 0n;
  return ((premium - sellerFee) * UNITS_PER_SHARE) / units;
}

/** Apply one fill to a position; returns the realised USDG base units. */
export function applyFill(position: Position, side: 'buy' | 'sell', units: bigint, price: bigint): bigint {
  if (units <= 0n) return 0n;
  const sign = side === 'buy' ? 1n : -1n;
  const held = position.units;
  let realised = 0n;
  let left = units;
  // Closing part: a buy against a short, a sell against a long.
  if ((held < 0n && sign > 0n) || (held > 0n && sign < 0n)) {
    const size = abs(held);
    const closed = left < size ? left : size;
    const costOfClosed = (position.basis * closed) / size;
    // long closed by a sale: (sale − cost); short closed by a buy: (cost − purchase)
    realised = sign < 0n ? (price * closed - costOfClosed) / UNITS_PER_SHARE : (costOfClosed - price * closed) / UNITS_PER_SHARE;
    position.basis -= costOfClosed;
    position.units += sign * closed;
    left -= closed;
    if (position.units === 0n) position.basis = 0n;
  }
  if (left > 0n) {
    position.units += sign * left;
    position.basis += price * left;
  }
  return realised;
}

/** Intrinsic value per share at settlement, USDG base units. */
export function intrinsicAt(isPut: boolean, strike: bigint, settlementPrice: bigint): bigint {
  if (isPut) return strike > settlementPrice ? strike - settlementPrice : 0n;
  return settlementPrice > strike ? settlementPrice - strike : 0n;
}

/** What one share of a position is worth at settlement: intrinsic, less the exercise fee for a long. */
export function settlementValue(position: Position, e: { isPut: boolean; strike: bigint; settlementPrice: bigint; exerciseFeeBps?: number }): bigint {
  const intrinsic = intrinsicAt(e.isPut, e.strike, e.settlementPrice);
  const fee = e.exerciseFeeBps ?? 0;
  return position.units > 0n && fee > 0 ? (intrinsic * (BPS - BigInt(fee))) / BPS : intrinsic;
}

/** Close a position at settlement; returns the realised USDG base units. */
export function applySettlement(position: Position, value: bigint): bigint {
  if (position.units === 0n) return 0n;
  const size = abs(position.units);
  const realised = position.units > 0n ? (value * size - position.basis) / UNITS_PER_SHARE : (position.basis - value * size) / UNITS_PER_SHARE;
  position.units = 0n;
  position.basis = 0n;
  return realised;
}

export interface Ledger {
  positions: Map<string, Position>;
  /** Realised USDG base units by UTC day. */
  realisedByDay: Map<number, bigint>;
}

/** Replay events in order (the ledger's insertion order is the order they were seen). */
export function replayLedger(events: readonly LedgerEvent[]): Ledger {
  const positions = new Map<string, Position>();
  const realisedByDay = new Map<number, bigint>();
  for (const e of events) {
    const position = positions.get(e.longId) ?? { units: 0n, basis: 0n };
    positions.set(e.longId, position);
    const realised =
      e.type === 'fill'
        ? applyFill(position, e.side, e.units, e.side === 'buy' ? e.price : e.premium !== undefined && e.sellerFee !== undefined ? exactNetSalePrice(e.units, e.premium, e.sellerFee) : netSalePrice(e.price, e.feeBps))
        : applySettlement(position, settlementValue(position, e));
    const day = dayOf(e.at);
    realisedByDay.set(day, (realisedByDay.get(day) ?? 0n) + realised);
  }
  return { positions, realisedByDay };
}

export interface LossStop {
  day: number;
  realised: bigint;
  limit: bigint;
  tripped: boolean;
}

/** The stop for the head's day: tripped once that day's realised result is at or below −limit. */
export function lossStop(ledger: Ledger, now: number, limit: bigint): LossStop {
  const day = dayOf(now);
  const realised = ledger.realisedByDay.get(day) ?? 0n;
  return { day, realised, limit, tripped: realised <= -limit };
}

/*//////////////////////////////////////////////////////////////
                              FILLS
//////////////////////////////////////////////////////////////*/

export interface TrackedOrder {
  orderId: bigint;
  longId: bigint;
  kind: 'Bid' | 'AskResale' | 'AskWrite';
  price: bigint;
  units: bigint;
  /** `filled` when the bot last looked. */
  filledSeen: bigint;
}

export interface OrderNow {
  filled: bigint;
  cancelled: boolean;
  units: bigint;
  validUntil: number;
}

export interface FillSeen {
  orderId: bigint;
  longId: bigint;
  side: 'buy' | 'sell';
  kind: TrackedOrder['kind'];
  units: bigint;
  price: bigint;
  /** Nothing left to watch: cancelled, fully filled, or an AskWrite past validUntil. A Bid or AskResale past validUntil
   *  stays open until it is cancelled or pruned: it still holds the vault's escrow. */
  closed: boolean;
  filled: bigint;
}

/*//////////////////////////////////////////////////////////////
                           SELLER FEES
//////////////////////////////////////////////////////////////*/

/** OrderBook.FeeParams' seller rates, bps. */
export interface FeeRegime {
  premiumFeeBps: number;
  resaleFeeBps: number;
}

/** The seller fee rate a fill of a vault order of `kind` pays under `regime`: the maker sells on AskWrite and AskResale only. */
export function sellerFeeBpsOf(kind: TrackedOrder['kind'], regime: FeeRegime): number {
  return kind === 'AskWrite' ? regime.premiumFeeBps : kind === 'AskResale' ? regime.resaleFeeBps : 0;
}

/**
 * The seller fee rate to book a sale at when its logs cannot account for it: the highest rate of any fee regime that
 * can have been in effect for a fill made between the bot's previous look (`previous`, with the regime in effect then)
 * and this one (`current`, in effect at the head). A scheduled change takes effect `delayS` after it is scheduled, and
 * one scheduled while another is pending replaces it, so an interval shorter than `delayS` sees at most one change:
 * the two ends' regimes are every regime in it. A longer interval, or no previous look, can hide any number of changes:
 * the compiled ceiling (`ceilingBps`, V2Constants.PREMIUM_FEE_CEIL_BPS) bounds them. The highest rate makes the booked
 * proceeds, and so the realised result, the lowest the fill can have had.
 */
export function conservativeSellerFeeBps(kind: TrackedOrder['kind'], input: { current: FeeRegime; previous: { regime: FeeRegime; at: number } | null; now: number; delayS: number; ceilingBps: number }): number {
  if (kind === 'Bid') return 0;
  const current = sellerFeeBpsOf(kind, input.current);
  if (input.previous === null || input.now - input.previous.at >= input.delayS) return Math.max(current, input.ceilingBps);
  return Math.max(current, sellerFeeBpsOf(kind, input.previous.regime));
}

/** One OrderBook.OrderFilled of a vault order, as the fee accounting reads it. Premium and seller fee in USDG base units. */
export interface FillLog {
  orderId: bigint;
  maker: string;
  units: bigint;
  premium: bigint;
  sellerFee: bigint;
  blockNumber: bigint;
  logIndex: number;
}

/**
 * The OrderFilled logs of a fill of `units` just seen on ONE order (its `filled` grew by `units` since the previous
 * look): walking back from the newest log, the logs whose units add up to exactly `units`, with their premium and
 * seller fee summed. Fills only ever add to `filled`, one log per fill, so the newest logs are the new ones and the walk
 * stops exactly at the previous look whatever older history the range also holds. null when the logs cannot account
 * for exactly `units` (a range that starts too late, a log the node left out): the caller books conservatively.
 * Duplicate logs (the same block and index) count once.
 */
export function matchFillLogs(units: bigint, logs: readonly FillLog[]): { premium: bigint; sellerFee: bigint; logs: number } | null {
  if (units <= 0n) return null;
  const unique = new Map<string, FillLog>();
  for (const l of logs) unique.set(`${l.blockNumber}:${l.logIndex}`, l);
  const newestFirst = [...unique.values()].sort((a, b) => (a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1));
  let sum = 0n;
  let premium = 0n;
  let sellerFee = 0n;
  let n = 0;
  for (const l of newestFirst) {
    if (sum >= units) break;
    sum += l.units;
    premium += l.premium;
    sellerFee += l.sellerFee;
    n += 1;
  }
  return sum === units ? { premium, sellerFee, logs: n } : null;
}

/** New fills of a tracked order (its `filled` grew) and whether it can still fill. */
export function fillOf(tracked: TrackedOrder, now: OrderNow, head: number): FillSeen {
  const delta = now.filled > tracked.filledSeen ? now.filled - tracked.filledSeen : 0n;
  return {
    orderId: tracked.orderId,
    longId: tracked.longId,
    side: tracked.kind === 'Bid' ? 'buy' : 'sell',
    kind: tracked.kind,
    units: delta,
    price: tracked.price,
    closed: now.cancelled || now.filled >= now.units || (head >= now.validUntil && tracked.kind === 'AskWrite'),
    filled: now.filled,
  };
}
