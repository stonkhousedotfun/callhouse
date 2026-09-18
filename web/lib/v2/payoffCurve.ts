import { breakeven, payoutAt, type PayoffPosition } from "./payoff";

/** All prices and money are raw USDG-6 amounts. SVG coordinates are unitless. */
export type PriceRange = { min: bigint; max: bigint };
export type CurvePoint = { price: bigint; pnl: bigint; x: number; y: number };
export type PayoffCurve = {
  range: PriceRange;
  points: CurvePoint[];
  path: string;
  zeroY: number;
  strikeX: number | null;
  spotX: number;
  breakevenX: number | null;
  breakevenPrice: bigint | null;
  pointAt: (price: bigint) => CurvePoint;
};

export const CURVE_VIEW = { width: 640, height: 260, left: 24, right: 24, top: 22, bottom: 44 } as const;
const CENT = 10_000n;
const RATIO_SCALE = 1_000_000n;

function assertPositive(value: bigint, name: string): void {
  if (value <= 0n) throw new RangeError(`${name} must be positive`);
}

function max(a: bigint, b: bigint): bigint { return a > b ? a : b; }
function min(a: bigint, b: bigint): bigint { return a < b ? a : b; }

/** Spot ± the greater of 15% of spot or three times the spot-to-strike distance. */
export function payoffPriceRange(spot: bigint, strike: bigint): PriceRange {
  assertPositive(spot, "spot");
  assertPositive(strike, "strike");
  const distance = spot > strike ? spot - strike : strike - spot;
  const radius = max((spot * 15n + 99n) / 100n, distance * 3n);
  return { min: max(0n, spot - radius), max: spot + radius };
}

export function clampPrice(price: bigint, range: PriceRange): bigint {
  if (range.max <= range.min) throw new RangeError("price range must have positive width");
  return max(range.min, min(range.max, price));
}

/** Ratio is clamped to [0, 1]; pointer prices snap to the nearest cent. */
export function priceAtRatio(ratio: number, range: PriceRange): bigint {
  if (!Number.isFinite(ratio)) throw new RangeError("ratio must be finite");
  const bounded = Math.max(0, Math.min(1, ratio));
  const scaled = BigInt(Math.round(bounded * Number(RATIO_SCALE)));
  const raw = range.min + ((range.max - range.min) * scaled) / RATIO_SCALE;
  const rounded = ((raw + CENT / 2n) / CENT) * CENT;
  return clampPrice(rounded, range);
}

/** One percent of the visible range, at least one cent; PageUp/Down use ten steps. */
export function keyboardPriceStep(range: PriceRange): bigint {
  if (range.max <= range.min) throw new RangeError("price range must have positive width");
  const onePercent = (range.max - range.min + 99n) / 100n;
  return max(CENT, ((onePercent + CENT - 1n) / CENT) * CENT);
}

function ratioOf(value: bigint, low: bigint, high: bigint): number {
  if (high === low) return 0;
  return Number(((value - low) * RATIO_SCALE) / (high - low)) / Number(RATIO_SCALE);
}

function xFor(price: bigint, range: PriceRange): number {
  return CURVE_VIEW.left + ratioOf(price, range.min, range.max) *
    (CURVE_VIEW.width - CURVE_VIEW.left - CURVE_VIEW.right);
}

/** Actual fee-net P&L, sampled across the visible range with exact strike and break-even vertices. */
export function buildPayoffCurve(spot: bigint, position: PayoffPosition, cost: bigint): PayoffCurve {
  const range = payoffPriceRange(spot, position.strike);
  if (cost < 0n) throw new RangeError("cost must be nonnegative");
  // W2-02 validates units, strike and fee bounds in payoutAt / breakeven.
  const threshold = breakeven(position, cost);
  const prices = new Set<bigint>([range.min, range.max, spot]);
  for (let i = 1n; i < 64n; i++) {
    prices.add(range.min + ((range.max - range.min) * i) / 64n);
  }
  if (position.strike >= range.min && position.strike <= range.max) prices.add(position.strike);
  if (threshold !== null && threshold >= range.min && threshold <= range.max) prices.add(threshold);
  const samples = [...prices].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    .map((price) => ({ price, pnl: payoutAt(price, position) - cost }));
  let low = 0n;
  let high = 0n;
  for (const sample of samples) {
    low = min(low, sample.pnl);
    high = max(high, sample.pnl);
  }
  if (low === high) { low -= 1n; high += 1n; }
  const yFor = (pnl: bigint) => CURVE_VIEW.top + (1 - ratioOf(pnl, low, high)) *
    (CURVE_VIEW.height - CURVE_VIEW.top - CURVE_VIEW.bottom);
  const pointAt = (price: bigint): CurvePoint => {
    const bounded = clampPrice(price, range);
    const pnl = payoutAt(bounded, position) - cost;
    return { price: bounded, pnl, x: xFor(bounded, range), y: yFor(pnl) };
  };
  const points = samples.map(({ price }) => pointAt(price));
  return {
    range,
    points,
    path: points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" "),
    zeroY: yFor(0n),
    strikeX: position.strike >= range.min && position.strike <= range.max ? xFor(position.strike, range) : null,
    spotX: xFor(spot, range),
    breakevenX: threshold !== null && threshold >= range.min && threshold <= range.max ? xFor(threshold, range) : null,
    breakevenPrice: threshold,
    pointAt,
  };
}
