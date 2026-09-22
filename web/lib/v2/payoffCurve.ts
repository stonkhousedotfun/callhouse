import { BPS, breakeven, payoutAt, type PayoffPosition } from "./payoff";

/** All prices and money are raw USDG-6 amounts. SVG coordinates are unitless. */
export type PriceRange = { min: bigint; max: bigint };
export type CurvePoint = { price: bigint; pnl: bigint; x: number; y: number };
export type PayoffCurve = {
  range: PriceRange;
  points: CurvePoint[];
  path: string;
  /** Closed SVG paths of the area between the curve and the zero line: the gain side and the loss side. */
  gainPath: string;
  lossPath: string;
  /** P&L extent of the plot, for axis labels. `low <= 0 <= high` always holds. */
  domain: { low: bigint; high: bigint };
  zeroY: number;
  strikeX: number | null;
  spotX: number;
  breakevenX: number | null;
  breakevenPrice: bigint | null;
  /** G4. Where a call covers its cost after USDG conversion at the floor; a put's equals `breakevenPrice`. */
  breakevenUsdgX: number | null;
  breakevenUsdgPrice: bigint | null;
  pointAt: (price: bigint) => CurvePoint;
};
export type PresetKey = "-20" | "-10" | "-5" | "spot" | "+5" | "+10" | "+20" | "strike" | "breakeven";
export type PricePreset = { key: PresetKey; label: string; price: bigint | null };

export const CURVE_VIEW = { width: 640, height: 260, left: 24, right: 24, top: 22, bottom: 44 } as const;
const CENT = 10_000n;
const RATIO_SCALE = 1_000_000n;
/** Widest preset, in percent of spot; the range must contain it on both sides (design §2.2). */
const PRESET_REACH_PERCENT = 20n;
const PRESET_STEPS: { key: PresetKey; label: string; bps: bigint }[] = [
  { key: "-20", label: "−20 %", bps: -2_000n }, { key: "-10", label: "−10 %", bps: -1_000n }, { key: "-5", label: "−5 %", bps: -500n },
  { key: "spot", label: "Spot", bps: 0n },
  { key: "+5", label: "+5 %", bps: 500n }, { key: "+10", label: "+10 %", bps: 1_000n }, { key: "+20", label: "+20 %", bps: 2_000n },
];

function assertPositive(value: bigint, name: string): void {
  if (value <= 0n) throw new RangeError(`${name} must be positive`);
}

function max(a: bigint, b: bigint): bigint { return a > b ? a : b; }
function min(a: bigint, b: bigint): bigint { return a < b ? a : b; }

/** Spot ± the greater of 25% of spot or three times the spot-to-strike distance. 25% keeps the ±20% presets
 * inside the view with room to read them; three distances keep the strike and the bend around it inside. */
export function payoffPriceRange(spot: bigint, strike: bigint): PriceRange {
  assertPositive(spot, "spot");
  assertPositive(strike, "strike");
  const distance = spot > strike ? spot - strike : strike - spot;
  const radius = max((spot * (PRESET_REACH_PERCENT + 5n) + 99n) / 100n, distance * 3n);
  return { min: max(0n, spot - radius), max: spot + radius };
}

/** Snap to the nearest cent, never below one cent. */
function toCent(raw: bigint): bigint {
  const rounded = ((raw + CENT / 2n) / CENT) * CENT;
  return rounded < CENT ? CENT : rounded;
}

/** The preset chips (design §2.3), in display order. Percentages are of SPOT and snap to the cent; "At strike"
 * is the strike itself; "Break-even" is null when the option cannot cover its cost at any price. Callers pass
 * whichever break-even they show as the hero mark (the USDG one for a call). */
export function presetPrices(spot: bigint, strike: bigint, breakeven: bigint | null): PricePreset[] {
  assertPositive(spot, "spot");
  assertPositive(strike, "strike");
  if (breakeven !== null && breakeven < 0n) throw new RangeError("breakeven must be nonnegative");
  return [
    ...PRESET_STEPS.map(({ key, label, bps }) => ({ key, label, price: toCent((spot * (BPS + bps)) / BPS) })),
    { key: "strike", label: "At strike", price: strike },
    { key: "breakeven", label: "Break-even", price: breakeven },
  ];
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

function inRange(price: bigint | null, range: PriceRange): price is bigint {
  return price !== null && price >= range.min && price <= range.max;
}

/** A closed path hugging the curve on one side of zero and the zero line on the other: the fill of the gain
 * (`above`) or the loss region. A point on the wrong side of zero is pinned to the zero line, so the fill never
 * crosses it; the break-even vertex is on the curve, so the crossing is exact to the sampled cent. */
function sidePath(points: CurvePoint[], zeroY: number, above: boolean): string {
  if (points.length === 0) return "";
  const clampY = (y: number) => above ? Math.min(y, zeroY) : Math.max(y, zeroY);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return [`M${first.x.toFixed(2)} ${zeroY.toFixed(2)}`,
    ...points.map((point) => `L${point.x.toFixed(2)} ${clampY(point.y).toFixed(2)}`),
    `L${last.x.toFixed(2)} ${zeroY.toFixed(2)} Z`].join(" ");
}

/** Actual fee-net P&L, sampled across the visible range with exact strike and break-even vertices. The optional
 * USDG break-even (G4, from `breakevenUsdg`) is placed as a second mark; the caller decides which one is the hero. */
export function buildPayoffCurve(spot: bigint, position: PayoffPosition, cost: bigint, breakevenUsdgPrice: bigint | null = null): PayoffCurve {
  const range = payoffPriceRange(spot, position.strike);
  if (cost < 0n) throw new RangeError("cost must be nonnegative");
  if (breakevenUsdgPrice !== null && breakevenUsdgPrice < 0n) throw new RangeError("breakevenUsdgPrice must be nonnegative");
  // W2-02 validates units, strike and fee bounds in payoutAt / breakeven.
  const threshold = breakeven(position, cost);
  const prices = new Set<bigint>([range.min, range.max, spot]);
  for (let i = 1n; i < 64n; i++) {
    prices.add(range.min + ((range.max - range.min) * i) / 64n);
  }
  if (inRange(position.strike, range)) prices.add(position.strike);
  if (inRange(threshold, range)) prices.add(threshold);
  if (inRange(breakevenUsdgPrice, range)) prices.add(breakevenUsdgPrice);
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
  const zeroY = yFor(0n);
  return {
    range,
    points,
    path: points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" "),
    gainPath: sidePath(points, zeroY, true),
    lossPath: sidePath(points, zeroY, false),
    domain: { low, high },
    zeroY,
    strikeX: inRange(position.strike, range) ? xFor(position.strike, range) : null,
    spotX: xFor(spot, range),
    breakevenX: inRange(threshold, range) ? xFor(threshold, range) : null,
    breakevenPrice: threshold,
    breakevenUsdgX: inRange(breakevenUsdgPrice, range) ? xFor(breakevenUsdgPrice, range) : null,
    breakevenUsdgPrice,
    pointAt,
  };
}
