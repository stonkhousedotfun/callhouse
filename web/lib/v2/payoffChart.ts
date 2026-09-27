/**
 * The neon payoff chart's model. Pure: prices in, SVG coordinates and
 * copy out, so the component only draws and the arithmetic is unit-tested here.
 *
 * - X is the underlying price, starting where the option is worth $0 and showing only the upside.
 * - Y is the option's VALUE in USDG for the chosen size, from 0. Not P&L: there is no negative region.
 * - The dashed hinge is the exact settlement value (`payoutAt`, bigint, contract rounding).
 * - The solid curve is a Black–Scholes estimate of the value before expiry, at the vol implied by the live ask,
 *   so the curve passes through the quoted price at spot. When no vol reproduces the quote, only the hinge is
 *   drawn and the caption says why.
 */
import { breakeven, payoutAt, takerFee, type PayoffPosition, type TakerFeeParams } from "./payoff";
import { SECONDS_PER_YEAR, VOL_FAILURE_TEXT, bsPrice, impliedVol, type VolFailure } from "./impliedVol";
import { formatPriceExact, formatShares, formatSignedUsdg, formatUsdgCents } from "./payoffFormat";

/** SVG user units. The component stretches the plot horizontally; strokes do not scale. */
export const CHART_VIEW = { width: 820, height: 280, left: 44, right: 12, top: 24, bottom: 30 } as const;
/** Samples of the before-expiry curve: 72 points, so it is smooth. */
export const CURVE_SAMPLES = 72;
/** Keyboard steps in USDG-6: arrows 0.50, Page Up/Down 5.00. */
export const ARROW_STEP = 500_000n;
export const PAGE_STEP = 5_000_000n;

const SIX = 1_000_000n;
const CENT = 10_000n;
const DOLLAR = 1_000_000n;

export type ChartInput = {
  ticker: string;
  isPut: boolean;
  /** USDG-6 per share. */
  strike: bigint;
  /** Contract units (0.01 share each). */
  units: bigint;
  /** Live underlying price, USDG-6 per share; null when unavailable. */
  spot: bigint | null;
  /** Everything paid for the size, taker fee included, USDG-6. The max loss and the cost line. */
  cost: bigint;
  /** The premium part of `cost` for the size, at the live ask. Null when there is no live quote. */
  premium: bigint | null;
  /** Series-pinned exercise fee. Null when the quote does not expose it: the chart then says "before exercise fee". */
  exerciseFeeBps: number | null;
  /** Series expiry and the current time, unix seconds. Either null: no before-expiry estimate. */
  expiry: number | null;
  now: number | null;
  /** A call's USDG conversion floor, bps of value (`PayoffPosition.conversionFloorBps`). When set, the expiry
   * value, P&L and break-even are what the routed payout delivers at that floor; the before-expiry estimate is a
   * book sale and stays unconverted. Absent: valued in kind, as before. Ignored for puts. */
  conversionFloorBps?: number;
  /** Where `premium` came from: the app's live ask (default) or the site's example ask. Changes copy only. */
  quote?: "live" | "example";
};

export type ChartDomain = { min: bigint; max: bigint; reversed: boolean };
export type Estimate = { ok: true; vol: number; years: number } | { ok: false; reason: VolFailure | "no-quote" };
export type ChartPoint = {
  price: bigint;
  x: number;
  /** Where the handle sits: on the curve when there is an estimate, else on the hinge. */
  y: number;
  /** Exact settlement value for the size, USDG-6. */
  expiryValue: bigint;
  /** Exact P&L at expiry: `expiryValue - cost`. */
  pnl: bigint;
  /** Estimated value before expiry, USDG (float); null without an estimate. */
  estimateValue: number | null;
};
export type Tick = { label: string; at: number };
export type ChartModel = {
  input: ChartInput;
  domain: ChartDomain;
  estimate: Estimate;
  feeKnown: boolean;
  yMax: number;
  yTicks: Tick[];
  xTicks: Tick[];
  baseY: number;
  costY: number;
  /** Null when spot is unknown or outside the domain: the "Now" label is hidden, never the axis stretched. */
  spotX: number | null;
  strikeX: number;
  breakeven: bigint | null;
  curvePath: string;
  areaPath: string;
  expiryPath: string;
  gridPath: string;
  at: (price: bigint) => ChartPoint;
};

function maxBig(a: bigint, b: bigint): bigint { return a > b ? a : b; }
function minBig(a: bigint, b: bigint): bigint { return a < b ? a : b; }
function floorTo(value: bigint, step: bigint): bigint { return (value / step) * step; }
function ceilTo(value: bigint, step: bigint): bigint { return ((value + step - 1n) / step) * step; }
function usdg(raw: bigint): number { return Number(raw) / Number(SIX); }

/** The cost of a take, from the quote's premium and the live fee parameters (never constants). */
export function costFromQuote(premiumPaid: bigint, fees: TakerFeeParams): bigint {
  return premiumPaid + takerFee(premiumPaid, fees);
}

/**
 * Calls run from floor(K × 0.975) to ceil(max(spot × 1.12, K × 1.08)); puts mirror it, from the upside $0
 * point ceil(K × 1.025) down to floor(min(spot × 0.88, K × 0.92)), drawn right-to-left (`reversed`) so value still
 * rises to the right. Whole dollars. Spot never widens the domain on the $0 side.
 */
export function chartDomain(isPut: boolean, strike: bigint, spot: bigint | null): ChartDomain {
  if (strike <= 0n) throw new RangeError("strike must be positive");
  if (spot !== null && spot <= 0n) throw new RangeError("spot must be positive");
  if (!isPut) {
    const min = floorTo((strike * 975n) / 1000n, DOLLAR);
    const reach = spot === null ? strike * 108n : maxBig(spot * 112n, strike * 108n);
    return { min, max: ceilTo((reach + 99n) / 100n, DOLLAR), reversed: false };
  }
  const max = ceilTo((strike * 1025n + 999n) / 1000n, DOLLAR);
  const reach = spot === null ? strike * 92n : minBig(spot * 88n, strike * 92n);
  return { min: maxBig(DOLLAR, floorTo(reach / 100n, DOLLAR)), max, reversed: true };
}

export function clampChartPrice(price: bigint, domain: ChartDomain): bigint {
  return maxBig(domain.min, minBig(domain.max, price));
}

/** The handle's start: spot + 5 % (a put: spot − 5 %, its upside), to the cent, clamped into the domain. */
export function defaultHandlePrice(input: Pick<ChartInput, "isPut" | "strike" | "spot">, domain: ChartDomain): bigint {
  const base = input.spot ?? input.strike;
  const moved = (base * (input.isPut ? 95n : 105n) + 50n) / 100n;
  return clampChartPrice(((moved + CENT / 2n) / CENT) * CENT, domain);
}

/** Keyboard: arrows 0.50, Page Up/Down 5.00, Home/End the domain edges. Up and Right raise the price (the
 * ARIA slider convention), also on a put's right-to-left axis. Null for any other key. */
export function keyboardChartPrice(key: string, price: bigint, domain: ChartDomain): bigint | null {
  let next: bigint;
  switch (key) {
    case "ArrowRight":
    case "ArrowUp": next = price + ARROW_STEP; break;
    case "ArrowLeft":
    case "ArrowDown": next = price - ARROW_STEP; break;
    case "PageUp": next = price + PAGE_STEP; break;
    case "PageDown": next = price - PAGE_STEP; break;
    case "Home": next = domain.min; break;
    case "End": next = domain.max; break;
    default: return null;
  }
  return clampChartPrice(next, domain);
}

/** The plot-width ratio (0 = left edge) of a price. */
export function ratioOfPrice(price: bigint, domain: ChartDomain): number {
  const width = domain.max - domain.min;
  const ratio = Number(clampChartPrice(price, domain) - domain.min) / Number(width);
  return domain.reversed ? 1 - ratio : ratio;
}

/** A pointer's plot-width ratio to a price, snapped to the cent and clamped. */
export function priceAtRatio(ratio: number, domain: ChartDomain): bigint {
  if (!Number.isFinite(ratio)) throw new RangeError("ratio must be finite");
  const bounded = Math.max(0, Math.min(1, ratio));
  const along = domain.reversed ? 1 - bounded : bounded;
  const raw = domain.min + BigInt(Math.round(along * Number(domain.max - domain.min)));
  return clampChartPrice(((raw + CENT / 2n) / CENT) * CENT, domain);
}

const PLOT_WIDTH = CHART_VIEW.width - CHART_VIEW.left - CHART_VIEW.right;
const BASE_Y = CHART_VIEW.height - CHART_VIEW.bottom;
const PLOT_HEIGHT = BASE_Y - CHART_VIEW.top;

function xOf(price: bigint, domain: ChartDomain): number {
  return CHART_VIEW.left + ratioOfPrice(price, domain) * PLOT_WIDTH;
}

/** 1, 2, 2.5 or 5 × 10^k, the smallest at or above `raw`. */
function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * power >= raw - 1e-12) return m * power;
  return 10 * power;
}

/** As many decimals as the step has, so 0, 2.5, 5 and 0, 0.25, 0.5 both read cleanly. */
function tickLabel(value: number, step: number): string {
  const decimals = (Number(step.toPrecision(6)).toString().split(".")[1] ?? "").length;
  return value.toFixed(Math.min(6, decimals));
}

function path(points: { x: number; y: number }[]): string {
  return points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
}

/** Build the chart for one ticket. Throws on an invalid position, as `payoutAt` does. */
export function buildPayoffChart(input: ChartInput): ChartModel {
  if (input.cost < 0n) throw new RangeError("cost must be nonnegative");
  if (input.premium !== null && (input.premium < 0n || input.premium > input.cost)) {
    throw new RangeError("premium must be within the cost");
  }
  const feeKnown = input.exerciseFeeBps !== null;
  // In kind: the before-expiry estimate and the fee it deducts never see the conversion floor.
  const inKind: PayoffPosition = { isPut: input.isPut, strike: input.strike, units: input.units, exerciseFeeBps: input.exerciseFeeBps ?? 0 };
  // What settlement pays: the expiry value, the P&L and the break-even.
  const position: PayoffPosition = input.isPut || input.conversionFloorBps === undefined
    ? inKind
    : { ...inKind, conversionFloorBps: input.conversionFloorBps };
  const perShare: PayoffPosition = { ...inKind, units: 100n };
  const gross: PayoffPosition = { ...perShare, exerciseFeeBps: 0 };
  const domain = chartDomain(input.isPut, input.strike, input.spot);
  const shares = Number(input.units) / 100;
  const strike = usdg(input.strike);
  // Exercise fee per share at a price, USDG: what the settlement deducts from the gross payout.
  const feePerShare = (price: bigint) => usdg(payoutAt(price, gross) - payoutAt(price, perShare));

  let estimate: Estimate = { ok: false, reason: "no-quote" };
  if (input.premium !== null && input.premium > 0n && input.spot !== null) {
    if (input.expiry === null || input.now === null) estimate = { ok: false, reason: "invalid" };
    else {
      const years = (input.expiry - input.now) / SECONDS_PER_YEAR;
      // Solve the GROSS model price the market implies: the ask plus the fee the curve will deduct at spot, so
      // the curve's value at spot is the quoted premium exactly.
      const target = usdg(input.premium) / shares + feePerShare(input.spot);
      const solved = impliedVol({ isPut: input.isPut, spot: usdg(input.spot), strike, years }, target);
      estimate = solved.ok ? { ok: true, vol: solved.vol, years } : { ok: false, reason: solved.reason };
    }
  }

  const estimateAt = (price: bigint): number | null => {
    if (!estimate.ok) return null;
    const perShareValue = bsPrice({ isPut: input.isPut, spot: usdg(price), strike, years: estimate.years }, estimate.vol) - feePerShare(price);
    return Math.max(0, perShareValue) * shares;
  };

  const samples: bigint[] = [];
  for (let i = 0; i < CURVE_SAMPLES; i++) {
    samples.push(domain.min + ((domain.max - domain.min) * BigInt(i)) / BigInt(CURVE_SAMPLES - 1));
  }
  const expiryPrices = [...new Set([...samples, ...(input.strike > domain.min && input.strike < domain.max ? [input.strike] : [])])]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const expiryValues = expiryPrices.map((price) => ({ price, value: payoutAt(price, position) }));
  const estimates = samples.map((price) => ({ price, value: estimateAt(price) }));

  const peak = Math.max(
    usdg(input.cost),
    ...expiryValues.map(({ value }) => usdg(value)),
    ...estimates.map(({ value }) => value ?? 0),
  );
  const step = niceStep(Math.max(peak * 1.1, 1e-6) / 4);
  const yMax = Math.ceil(peak * 1.1 / step - 1e-9) * step || step;
  const yOf = (value: number) => BASE_Y - (Math.min(value, yMax) / yMax) * PLOT_HEIGHT;
  const yTicks: Tick[] = [];
  for (let v = 0; v <= yMax + step / 2; v += step) yTicks.push({ label: tickLabel(v, step), at: yOf(v) });

  const xTicks: Tick[] = [];
  const span = domain.max - domain.min;
  const xStep = BigInt(Math.max(1, niceStep(usdg(span) / 5))) * DOLLAR;
  for (let p = ceilTo(domain.min, xStep); p <= domain.max; p += xStep) {
    xTicks.push({ label: `$${(p / DOLLAR).toString()}`, at: xOf(p, domain) });
  }

  const curvePoints = estimate.ok ? estimates.map(({ price, value }) => ({ x: xOf(price, domain), y: yOf(value!) })) : [];
  const hingePoints = expiryValues.map(({ price, value }) => ({ x: xOf(price, domain), y: yOf(usdg(value)) }))
    .sort((a, b) => a.x - b.x);
  const fillEdge = (estimate.ok ? [...curvePoints] : hingePoints).sort((a, b) => a.x - b.x);
  const areaPath = fillEdge.length === 0 ? "" : `${path(fillEdge)} L${fillEdge[fillEdge.length - 1]!.x.toFixed(2)} ${BASE_Y.toFixed(2)} L${fillEdge[0]!.x.toFixed(2)} ${BASE_Y.toFixed(2)} Z`;
  const gridPath = yTicks.slice(1).map((t) => `M${CHART_VIEW.left} ${t.at.toFixed(2)} H${CHART_VIEW.width - CHART_VIEW.right}`).join(" ");

  const spotIn = input.spot !== null && input.spot >= domain.min && input.spot <= domain.max;
  const at = (price: bigint): ChartPoint => {
    const bounded = clampChartPrice(price, domain);
    const expiryValue = payoutAt(bounded, position);
    const estimateValue = estimateAt(bounded);
    return {
      price: bounded, x: xOf(bounded, domain), y: yOf(estimateValue ?? usdg(expiryValue)),
      expiryValue, pnl: expiryValue - input.cost, estimateValue,
    };
  };

  return {
    input, domain, estimate, feeKnown, yMax, yTicks, xTicks, baseY: BASE_Y, costY: yOf(usdg(input.cost)),
    spotX: spotIn ? xOf(input.spot!, domain) : null,
    strikeX: xOf(input.strike, domain),
    breakeven: breakeven(position, input.cost),
    curvePath: path([...curvePoints].sort((a, b) => a.x - b.x)),
    areaPath,
    expiryPath: path(hingePoints),
    gridPath,
    at,
  };
}

/** "a day early", "3 days early", "5 hours early" — how long before expiry a sale at the estimate would be. */
export function earlyText(secondsLeft: number): string {
  if (secondsLeft >= 1.5 * 86_400) return `${Math.round(secondsLeft / 86_400)} days early`;
  if (secondsLeft >= 20 * 3_600) return "a day early";
  if (secondsLeft >= 1.5 * 3_600) return `${Math.round(secondsLeft / 3_600)} hours early`;
  if (secondsLeft >= 45 * 60) return "an hour early";
  return `${Math.max(1, Math.round(secondsLeft / 60))} minutes early`;
}

function signedFloat(value: number): string {
  // Floor to the cent, like formatSignedUsdg: an estimate never reads better than it is.
  const cents = Math.floor(value * 100 + 1e-9);
  const abs = Math.abs(cents);
  const text = `${Math.floor(abs / 100).toLocaleString("en-US")}.${(abs % 100).toString().padStart(2, "0")}`;
  return cents > 0 ? `+${text}` : cents < 0 ? `−${text}` : text;
}

export type Tooltip = {
  title: string;
  /** The exact P&L at expiry, net of cost. Always the headline. */
  headline: string;
  worth: string;
  /** The "≈" line, or why there is none. */
  estimate: string;
  gain: boolean;
};

/** The inverse tooltip card: `NVDA at $241.00` / `+3.90 USDG` / `at expiry · worth 5.00` / `≈ +4.65 if sold a day early`. */
export function tooltipFor(model: ChartModel, price: bigint): Tooltip {
  const point = model.at(price);
  const { input } = model;
  const estimate = point.estimateValue === null || input.expiry === null || input.now === null
    ? model.estimate.ok ? "" : estimateMissingText(model.estimate, quoteWord(input))
    : `≈ ${signedFloat(point.estimateValue - usdg(input.cost))} if sold ${earlyText(input.expiry - input.now)}`;
  return {
    title: `${input.ticker} at $${formatPriceExact(point.price)}`,
    headline: `${formatSignedUsdg(point.pnl)} USDG`,
    worth: `at expiry · worth ${formatUsdgCents(point.expiryValue, "down")}${model.feeKnown ? "" : " before exercise fee"}`,
    estimate,
    gain: point.pnl > 0n,
  };
}

/** "live" for the app's quote, "example" for the site's example chart. */
function quoteWord(input: Pick<ChartInput, "quote">): string {
  return input.quote === "example" ? "example" : "live";
}

function estimateMissingText(estimate: Estimate, quote: string): string {
  if (estimate.ok) return "";
  return estimate.reason === "no-quote" ? `No ${quote} quote: at-expiry value only` : "No before-expiry estimate";
}

/** The slider's `aria-valuetext`: "NVDA 241.00, worth 5.00 at expiry, plus 3.90 after the 1.10 paid". */
export function ariaValueText(model: ChartModel, price: bigint): string {
  const point = model.at(price);
  const paid = formatUsdgCents(model.input.cost, "up");
  const change = point.pnl === 0n ? "even" : `${point.pnl > 0n ? "plus" : "minus"} ${formatUsdgCents(point.pnl < 0n ? -point.pnl : point.pnl, point.pnl < 0n ? "up" : "down")}`;
  const fee = model.feeKnown ? "" : " before exercise fee";
  return `${model.input.ticker} ${formatPriceExact(point.price)}, worth ${formatUsdgCents(point.expiryValue, "down")} at expiry${fee}, ${change} after the ${paid} paid`;
}

/** The dashed cost line's label. */
export function costLabel(cost: bigint): string {
  return `You paid ${formatUsdgCents(cost, "up")} · above this line is profit`;
}

/** The site chart's only caption: one plain line, no explanatory text. */
export const SITE_CHART_CAPTION = "Settles on the average price over the last 30 minutes before the close.";

/**
 * Captions under the chart: settlement average, the exercise fee (included or labelled), and what the curve is.
 * The site's chart (`quote: "example"`) carries only SITE_CHART_CAPTION; the app's live chart is unchanged.
 */
export function chartCaptions(model: ChartModel): string[] {
  if (model.input.quote === "example") return [SITE_CHART_CAPTION];
  const lines = [
    "At-expiry values use the settlement price: the average of the last 30 minutes before the close, not a single trade.",
    model.feeKnown ? "Includes the exercise fee taken from the payout." : "Values are before exercise fee.",
  ];
  if (model.estimate.ok) {
    lines.push(`The curve estimates what the option could sell for before expiry: Black–Scholes at ${(model.estimate.vol * 100).toFixed(0)} % implied vol from the ${quoteWord(model.input)} ask. An estimate, not a bid.`);
  } else if (model.estimate.reason === "no-quote") {
    lines.push(`No ${quoteWord(model.input)} ask, so no before-expiry curve: the dashed line is the value at expiry.`);
  } else {
    const reason = model.estimate.reason === "invalid" ? "the quote or expiry is missing" : VOL_FAILURE_TEXT[model.estimate.reason];
    lines.push(`No before-expiry curve because ${reason}. The dashed line is the value at expiry.`);
  }
  return lines;
}

/** "NVDA $236 call · 5 shares" for the chart header. */
export function chartHeading(input: Pick<ChartInput, "ticker" | "isPut" | "strike" | "units">): string {
  const shares = formatShares(input.units);
  return `${input.ticker} $${formatPriceExact(input.strike)} ${input.isPut ? "put" : "call"} · ${shares} share${input.units === 100n ? "" : "s"}`;
}
