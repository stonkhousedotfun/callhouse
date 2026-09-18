import { collateralWithRent } from "./rent";
import { collateralPerUnit, makerKey, totalUnits, type AggregatedBook, type BookSeries, type FillableOrder } from "./book";

const BPS = 10_000n;
const UNITS_PER_SHARE = 100n;
const UNIT = 10n ** 16n;
const WAD = 10n ** 18n;
const MAX_PAYOUT_FEE_SHARE_BPS = 1_000n;

export type CardFees = { takerFeeFlat: bigint; takerFeeCapBps: number; exerciseFeeBps: number };
export type Ladder = { rungs: number; firstOtmBps: number; stepBps: number; cardTargetBps: number };
export type TicketFill = { orderId: bigint; maker: `0x${string}`; kind: FillableOrder["kind"]; units: bigint; price: bigint };
export type Ticket = { requested: bigint; filled: bigint; premium: bigint; takerFee: bigint; cost: bigint; orderIds: bigint[]; fills: TicketFill[] };

export type CardMath = {
  /** Best executable ask for one whole share of 100 units, from the book's first ask level. */
  ask: bigint;
  target: bigint;
  perUnit: { cost: bigint; payoutAtTarget: bigint; multiple: number };
  /** The 100-unit ticket walks ask levels and pays the once-per-take taker fee once. */
  perShare: { cost: bigint; payoutAtTarget: bigint; multiple: number; filledUnits: bigint } | null;
  maxLoss: "cost";
  unitsAvailable: bigint;
  orderIds: bigint[];
  /** Executable ask depth after shared maker collateral is reserved in take order. */
  askDepth: bigint;
};

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

function validFees(fees: CardFees): void {
  if (fees.takerFeeFlat < 0n || !Number.isInteger(fees.takerFeeCapBps) || fees.takerFeeCapBps < 0 || fees.takerFeeCapBps > 1_000
      || !Number.isInteger(fees.exerciseFeeBps) || fees.exerciseFeeBps < 0 || fees.exerciseFeeBps > 200) {
    throw new RangeError("card fee parameters exceed the contract ceilings");
  }
}

/** One fee per OrderBook.take call, capped by the premium share. */
export function takerFee(premium: bigint, fees: Pick<CardFees, "takerFeeFlat" | "takerFeeCapBps">): bigint {
  if (premium < 0n) throw new RangeError("negative premium");
  const cap = (premium * BigInt(fees.takerFeeCapBps)) / BPS;
  return fees.takerFeeFlat < cap ? fees.takerFeeFlat : cap;
}

/**
 * Walk the executable asks in price/time order. AskWrite orders from one maker share the same
 * free collateral, so reserve it after each fill. The aggregate book deliberately retains the
 * per-order capacity view. The contract proposes min(stored remaining, requested remaining)
 * and skips an AskWrite when that WHOLE proposed fill is not funded.
 */
export function walkAsks(book: AggregatedBook, requested: bigint, series: BookSeries, freeByMaker: ReadonlyMap<string, bigint>, fees: CardFees): Ticket {
  validFees(fees);
  if (requested <= 0n) throw new RangeError("requested units must be positive");
  const cpu = collateralPerUnit(series.isPut, series.strike);
  const free = new Map(freeByMaker);
  let filled = 0n;
  let premium = 0n;
  const fills: TicketFill[] = [];
  for (const level of book.asks) {
    for (const order of level.orders) {
      const remaining = requested - filled;
      if (remaining === 0n) break;
      const storedRemaining = order.onChainRemainingUnits ?? order.units;
      const units = storedRemaining < remaining ? storedRemaining : remaining;
      if (order.kind === "AskWrite") {
        const key = makerKey(order.maker);
        const need = collateralWithRent(units, cpu, series.mintFeePpm, series.expiry - book.snapshotTimestamp);
        const available = free.get(key) ?? 0n;
        if (available < need || book.snapshotTimestamp >= series.mintCutoff) continue;
        free.set(key, available - need);
      }
      fills.push({ orderId: order.orderId, maker: order.maker, kind: order.kind, units, price: order.price });
      filled += units;
      premium += (order.price * units) / UNITS_PER_SHARE;
    }
    if (filled === requested) break;
  }
  const fee = takerFee(premium, fees);
  return { requested, filled, premium, takerFee: fee, cost: premium + fee, orderIds: fills.map((fill) => fill.orderId), fills };
}

/**
 * Largest ticket that the whole-or-skip planner fills completely. Summing individual caps
 * can overstate shared maker depth; requesting that sum can also skip every large write.
 * Feasibility is monotone: before the final partial fill, proposed whole order sizes and
 * budgets do not depend on the requested total; reducing that last fill cannot cost more.
 */
export function executableAskDepth(book: AggregatedBook, series: BookSeries, freeByMaker: ReadonlyMap<string, bigint>, fees: CardFees): Ticket {
  let lo = 0n;
  const sum = totalUnits(book.asks);
  let hi = sum < (1n << 64n) - 1n ? sum : (1n << 64n) - 1n;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (walkAsks(book, mid, series, freeByMaker, fees).filled === mid) lo = mid;
    else hi = mid - 1n;
  }
  // Callers require at least one fillable ask; avoid passing zero to the quote validator.
  return walkAsks(book, lo > 0n ? lo : 1n, series, freeByMaker, fees);
}

/** Scenario target, rounded outwards to a registry strike tick. */
export function cardTarget(strike: bigint, isPut: boolean, bps: number, tick: bigint): bigint {
  if (strike <= 0n || tick <= 0n || !Number.isInteger(bps) || bps < 0 || bps >= 10_000) throw new RangeError("invalid card target");
  if (isPut) {
    const rounded = ((strike * (BPS - BigInt(bps))) / (BPS * tick)) * tick;
    return rounded < tick ? tick : rounded;
  }
  return ceilDiv(strike * (BPS + BigInt(bps)), BPS * tick) * tick;
}

/** Net hypothetical settlement value in USDG base units for one 0.01-share unit. */
export function payoutAtTarget(series: Pick<BookSeries, "isPut" | "strike">, target: bigint, exerciseFeeBps: number): bigint {
  if (target < 0n || !Number.isInteger(exerciseFeeBps) || exerciseFeeBps < 0 || exerciseFeeBps > 200) throw new RangeError("invalid payout input");
  let gross: bigint;
  if (series.isPut) gross = target < series.strike ? (series.strike - target) / UNITS_PER_SHARE : 0n;
  else gross = target > series.strike ? (UNIT * (target - series.strike)) / target : 0n;
  if (gross === 0n) return 0n;
  const collateral = collateralPerUnit(series.isPut, series.strike);
  const configured = (collateral * BigInt(exerciseFeeBps)) / BPS;
  const maxShare = (gross * MAX_PAYOUT_FEE_SHARE_BPS) / BPS;
  const fee = configured < maxShare ? configured : maxShare;
  const net = gross - fee;
  return series.isPut ? net : (net * target) / WAD;
}

/** Honest headline rounding: down to two decimals, never up. */
export function cardMultiple(payout: bigint, cost: bigint): number {
  if (cost <= 0n || payout < 0n) return 0;
  const hundredths = (payout * 100n) / cost;
  return Number(hundredths > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : hundredths) / 100;
}

export function buildCardMath(input: {
  book: AggregatedBook;
  series: BookSeries;
  freeByMaker: ReadonlyMap<string, bigint>;
  fees: CardFees;
  targetBps: number;
  strikeTick: bigint;
}): CardMath | null {
  const best = input.book.asks[0];
  if (best === undefined || best.units === 0n) return null;
  const one = walkAsks(input.book, 1n, input.series, input.freeByMaker, input.fees);
  if (one.filled !== 1n) return null;
  const hundred = walkAsks(input.book, 100n, input.series, input.freeByMaker, input.fees);
  const all = executableAskDepth(input.book, input.series, input.freeByMaker, input.fees);
  const target = cardTarget(input.series.strike, input.series.isPut, input.targetBps, input.strikeTick);
  const payout = payoutAtTarget(input.series, target, input.fees.exerciseFeeBps);
  return {
    ask: best.price,
    target,
    perUnit: { cost: one.cost, payoutAtTarget: payout, multiple: cardMultiple(payout, one.cost) },
    perShare: hundred.filled === 100n
      ? { cost: hundred.cost, payoutAtTarget: payout * 100n, multiple: cardMultiple(payout * 100n, hundred.cost), filledUnits: 100n }
      : null,
    maxLoss: "cost",
    unitsAvailable: all.filled,
    orderIds: hundred.filled === 100n ? hundred.orderIds : all.orderIds,
    askDepth: all.filled,
  };
}

/** Only strikes in the current registry ladder can make the headline. */
export function isStrikeInLadder(input: { strike: bigint; spot: bigint; isPut: boolean; tick: bigint; ladder: Ladder }): boolean {
  const { strike, spot, isPut, tick, ladder } = input;
  if (spot <= 0n || tick <= 0n || ladder.rungs < 1 || ladder.firstOtmBps < 0 || ladder.stepBps < 0) return false;
  const first = BigInt(ladder.firstOtmBps);
  const last = BigInt(ladder.firstOtmBps + (ladder.rungs - 1) * ladder.stepBps);
  if (isPut) {
    if (last >= BPS) return false;
    const highest = ((spot * (BPS - first)) / BPS / tick) * tick;
    const lowest = ((spot * (BPS - last)) / BPS / tick) * tick;
    return strike >= lowest && strike <= highest;
  }
  const lowest = ceilDiv(spot * (BPS + first), BPS * tick) * tick;
  const highest = ceilDiv(spot * (BPS + last), BPS * tick) * tick;
  return strike >= lowest && strike <= highest;
}

export type HeroCandidate<T> = { card: T; math: CardMath; expiry: bigint; strike: bigint; spot: bigint; isPut: boolean; tick: bigint; ladder: Ladder };

export function pickHero<T>(candidates: readonly HeroCandidate<T>[], now: bigint): HeroCandidate<T> | null {
  const eligible = candidates.filter((candidate) => candidate.expiry >= now + 7_200n
    && candidate.math.perShare !== null
    && isStrikeInLadder({ strike: candidate.strike, spot: candidate.spot, isPut: candidate.isPut, tick: candidate.tick, ladder: candidate.ladder }));
  eligible.sort((a, b) => b.math.perUnit.multiple - a.math.perUnit.multiple
    || Number(a.expiry - b.expiry)
    || (a.strike < b.strike ? -1 : a.strike > b.strike ? 1 : 0));
  return eligible[0] ?? null;
}
