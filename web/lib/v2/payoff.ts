import { writerCollateralNeed, type RentTerms } from "./rent";

/** v2 amounts are bigint base units: USDG has 6 decimals; one contract is 0.01 share. */
export const UNIT = 10n ** 16n;
export const UNITS_PER_SHARE = 100n;
export const PRICE_TICK = 100n;
export const BPS = 10_000n;
const WAD = 10n ** 18n;
const USDG_CENT = 10_000n;
const MAX_EXERCISE_FEE_BPS = 200n;
const MAX_PAYOUT_FEE_SHARE_BPS = 1_000n;

export type TakerFeeParams = { takerFeeFlat: bigint; takerFeeCapBps: number };
export type Ask = { orderId: string; price: bigint; units: bigint;
  maker?: string; kind?: "AskResale" | "AskWrite"; onChainRemainingUnits?: bigint;
  makerFreeCollateral?: bigint | null; makerFreeUnits?: bigint | null };
export type BuyCost = {
  filledUnits: bigint;
  unfilledUnits: bigint;
  premium: bigint;
  fee: bigint;
  cost: bigint;
  averagePrice: bigint | null;
  orderIds: string[];
  fills: { orderId: string; price: bigint; units: bigint; premium: bigint }[];
};
export type PayoffPosition = { isPut: boolean; strike: bigint; units: bigint; exerciseFeeBps: number };
export type MoneyRaw = { raw: string; decimals: number };
export type CardSentenceInput = {
  series: { ticker: string; expiry: number; isPut?: boolean };
  target: MoneyRaw;
  perUnit: { cost: MoneyRaw; payoutAtTarget: MoneyRaw };
};

function requireNonnegative(value: bigint, name: string): void {
  if (value < 0n) throw new RangeError(`${name} must be nonnegative`);
}

function requirePositive(value: bigint, name: string): void {
  if (value <= 0n) throw new RangeError(`${name} must be positive`);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

function feeBps(value: number): bigint {
  if (!Number.isInteger(value) || value < 0 || value > Number(MAX_EXERCISE_FEE_BPS)) {
    throw new RangeError("exerciseFeeBps exceeds the contract ceiling");
  }
  return BigInt(value);
}

function validatePosition(position: PayoffPosition): void {
  requirePositive(position.strike, "strike");
  requirePositive(position.units, "units");
  feeBps(position.exerciseFeeBps);
}

/** Premium is exact because order prices are multiples of PRICE_TICK. */
export function premium(price: bigint, units: bigint): bigint {
  requirePositive(price, "price");
  requirePositive(units, "units");
  if (price % PRICE_TICK !== 0n) throw new RangeError("price must be a multiple of PRICE_TICK");
  return (price * units) / UNITS_PER_SHARE;
}

/** One capped taker fee per take call, on the actual filled premium. */
export function takerFee(premiumPaid: bigint, params: TakerFeeParams): bigint {
  requireNonnegative(premiumPaid, "premiumPaid");
  requireNonnegative(params.takerFeeFlat, "takerFeeFlat");
  if (!Number.isInteger(params.takerFeeCapBps) || params.takerFeeCapBps < 0 || params.takerFeeCapBps > 1_000) {
    throw new RangeError("takerFeeCapBps exceeds the contract ceiling");
  }
  const capped = (premiumPaid * BigInt(params.takerFeeCapBps)) / BPS;
  return params.takerFeeFlat < capped ? params.takerFeeFlat : capped;
}

/** Walk asks as OrderBook._plan does: a writer's free collateral is shared by all its asks,
 * and an ask that cannot cover this call's planned units is skipped whole. quoteTake remains
 * authoritative before a trade (approvals, pauses and concurrent transactions can still change). */
export function costToBuy(asks: readonly Ask[], units: bigint, params: TakerFeeParams, rent?: RentTerms): BuyCost {
  requirePositive(units, "units");
  const sorted = asks.map((ask, index) => ({ ...ask, index })).sort((a, b) =>
    a.price < b.price ? -1 : a.price > b.price ? 1 : a.index - b.index);
  const seen = new Set<string>();
  const writerBudget = new Map<string, bigint>();
  let remaining = units;
  let totalPremium = 0n;
  const fills: BuyCost["fills"] = [];
  for (const ask of sorted) {
    if (!/^\d+$/.test(ask.orderId) || seen.has(ask.orderId)) throw new RangeError("order IDs must be unique decimal strings");
    seen.add(ask.orderId);
    premium(ask.price, ask.units);
    if (remaining === 0n) continue;
    const orderRemaining = ask.onChainRemainingUnits ?? ask.units;
    if (orderRemaining <= 0n) continue;
    const filled = orderRemaining < remaining ? orderRemaining : remaining;
    if (ask.kind === "AskWrite") {
      const key = ask.maker?.toLowerCase();
      if (key === undefined || !rent) continue;
      const initial = ask.makerFreeCollateral;
      if (initial === undefined || initial === null) continue;
      if ((rent.snapshotTimestamp >= rent.expiry || (rent.mintCutoff !== undefined && rent.snapshotTimestamp >= rent.mintCutoff))) continue;
      const budget = writerBudget.get(key) ?? initial;
      const need = writerCollateralNeed(filled, rent);
      if (budget < need) continue;
      writerBudget.set(key, budget - need);
    }
    const amount = premium(ask.price, filled);
    fills.push({ orderId: ask.orderId, price: ask.price, units: filled, premium: amount });
    totalPremium += amount;
    remaining -= filled;
  }
  const filledUnits = units - remaining;
  const fee = takerFee(totalPremium, params);
  return { filledUnits, unfilledUnits: remaining, premium: totalPremium, fee, cost: totalPremium + fee,
    averagePrice: filledUnits > 0n ? ceilDiv(totalPremium * UNITS_PER_SHARE, filledUnits) : null,
    orderIds: fills.map((fill) => fill.orderId), fills };
}

export function collateralPerUnit(isPut: boolean, strike: bigint): bigint {
  requirePositive(strike, "strike");
  return isPut ? strike / UNITS_PER_SHARE : UNIT;
}

/** Calls return Stock Token base units; puts return USDG base units. */
export function grossPayoutPerUnit(isPut: boolean, strike: bigint, price: bigint): bigint {
  requirePositive(strike, "strike");
  requireNonnegative(price, "price");
  if (isPut) return price < strike ? (strike - price) / UNITS_PER_SHARE : 0n;
  return price > strike ? (UNIT * (price - strike)) / price : 0n;
}

export function exerciseFeePerUnit(gross: bigint, collateral: bigint, exerciseFeeBps: number): bigint {
  requireNonnegative(gross, "gross");
  requireNonnegative(collateral, "collateral");
  const rate = feeBps(exerciseFeeBps);
  if (gross === 0n) return 0n;
  const byCollateral = (collateral * rate) / BPS;
  const byPayout = (gross * MAX_PAYOUT_FEE_SHARE_BPS) / BPS;
  return byCollateral < byPayout ? byCollateral : byPayout;
}

/** Call payouts are valued at settlement price after the in-kind exercise fee. */
export function netPayoutUsdgPerUnit(isPut: boolean, strike: bigint, price: bigint, exerciseFeeBps: number): bigint {
  const gross = grossPayoutPerUnit(isPut, strike, price);
  const fee = exerciseFeePerUnit(gross, collateralPerUnit(isPut, strike), exerciseFeeBps);
  const net = gross - fee;
  return isPut ? net : (net * price) / WAD;
}

/** Hypothetical settlement payout in USDG base units, rounded down per contract. */
export function payoutAt(price: bigint, position: PayoffPosition): bigint {
  validatePosition(position);
  return netPayoutUsdgPerUnit(position.isPut, position.strike, price, position.exerciseFeeBps) * position.units;
}

/** First profitable price for a call; highest profitable price for a put. */
export function breakeven(position: PayoffPosition, cost: bigint): bigint | null {
  validatePosition(position);
  requireNonnegative(cost, "cost");
  if (cost === 0n) return position.strike;
  if (position.isPut) {
    if (payoutAt(0n, position) < cost) return null;
    let low = 0n;
    let high = position.strike;
    while (low < high) {
      const mid = (low + high + 1n) / 2n;
      if (payoutAt(mid, position) >= cost) low = mid;
      else high = mid - 1n;
    }
    return low;
  }
  let low = position.strike;
  let high = position.strike * 2n;
  while (payoutAt(high, position) < cost) high *= 2n;
  while (low < high) {
    const mid = (low + high) / 2n;
    if (payoutAt(mid, position) >= cost) high = mid;
    else low = mid + 1n;
  }
  return low;
}

export function maxLoss(cost: bigint): bigint {
  requireNonnegative(cost, "cost");
  return cost;
}

/** Multiple rounds down to two decimals; null when nothing was paid. */
export function multipleAt(price: bigint, position: PayoffPosition, cost: bigint): number | null {
  requireNonnegative(cost, "cost");
  if (cost === 0n) return null;
  const hundredths = (payoutAt(price, position) * 100n) / cost;
  if (hundredths > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("multiple too large to display");
  return Number(hundredths) / 100;
}

export function cardTarget(strike: bigint, bps: number, tick: bigint, isPut = false): bigint {
  requirePositive(strike, "strike");
  requirePositive(tick, "tick");
  if (!Number.isInteger(bps) || bps < 0) throw new RangeError("target bps must be nonnegative integer");
  if (isPut) {
    const rounded = ((strike * (BPS - BigInt(bps))) / (BPS * tick)) * tick;
    return rounded < tick ? tick : rounded;
  }
  return ceilDiv(strike * (BPS + BigInt(bps)), BPS * tick) * tick;
}

export function sharesToUnits(shares: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(shares)) throw new RangeError("shares must use 0.01 increments");
  const [whole, fraction = ""] = shares.split(".");
  const units = BigInt(whole) * UNITS_PER_SHARE + BigInt((fraction + "00").slice(0, 2));
  requirePositive(units, "shares");
  return units;
}

/** Writer outcome; premiumReceived is net of any seller fee paid on the sale. */
export function shortOutcome(price: bigint, position: PayoffPosition, premiumReceived: bigint): {
  collateralReturned: bigint;
  collateralAsset: "Stock Token" | "USDG";
  premiumReceived: bigint;
  profitVsHoldUsdg: bigint;
} {
  validatePosition(position);
  requireNonnegative(price, "price");
  requireNonnegative(premiumReceived, "premiumReceived");
  const gross = grossPayoutPerUnit(position.isPut, position.strike, price);
  const collateral = collateralPerUnit(position.isPut, position.strike);
  const collateralReturned = (collateral - gross) * position.units;
  const intrinsicPaid = position.isPut ? gross * position.units : ceilDiv(gross * price, WAD) * position.units;
  return { collateralReturned, collateralAsset: position.isPut ? "USDG" : "Stock Token",
    premiumReceived, profitVsHoldUsdg: premiumReceived - intrinsicPaid };
}

function formatTwo(raw: bigint, roundUp: boolean): string {
  requireNonnegative(raw, "money");
  const cents = roundUp ? ceilDiv(raw, USDG_CENT) : raw / USDG_CENT;
  const whole = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole}.${(cents % 100n).toString().padStart(2, "0")}`;
}

function usdgRaw(money: MoneyRaw): bigint {
  if (money.decimals !== 6 || !/^\d+$/.test(money.raw)) throw new RangeError("expected USDG-6 Money");
  return BigInt(money.raw);
}

function formatExactUsdg(raw: bigint): string {
  requireNonnegative(raw, "money");
  const whole = (raw / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (raw % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${fraction}`;
}

/** The optional exact take quote keeps sub-cent card costs consistent with the multiple. */
export function cardSentence(card: CardSentenceInput, qty: bigint, exact?: { cost: bigint; payout: bigint }): string {
  requirePositive(qty, "qty");
  if (!Number.isInteger(card.series.expiry) || card.series.expiry <= 0) throw new RangeError("invalid expiry");
  const cost = exact?.cost ?? usdgRaw(card.perUnit.cost) * qty;
  const payout = exact?.payout ?? usdgRaw(card.perUnit.payoutAtTarget) * qty;
  requireNonnegative(cost, "cost");
  requireNonnegative(payout, "payout");
  const target = usdgRaw(card.target);
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/New_York" })
    .format(new Date(card.series.expiry * 1000));
  const shownCost = exact ? formatExactUsdg(cost) : formatTwo(cost, true);
  const shownPayout = exact ? formatExactUsdg(payout) : formatTwo(payout, false);
  return card.series.isPut
    ? `Pay ${shownCost} USDG → receive ${shownPayout} USDG if ${card.series.ticker} falls to $${formatTwo(target, true)} by ${weekday}. Max loss: ${shownCost} USDG.`
    : `Pay ${shownCost} USDG → estimated settlement value ${shownPayout} USDG if ${card.series.ticker} reaches $${formatTwo(target, true)} by ${weekday}. Max loss: ${shownCost} USDG.`;
}
