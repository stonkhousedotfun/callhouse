import { ImageResponse } from "next/og";
import { cache } from "react";
import type { PnlResponse } from "@/lib/v2/api-types";
import { MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS, type PayoffPosition } from "@/lib/v2/payoff";
import { buildPayoffChart, CHART_VIEW } from "@/lib/v2/payoffChart";
import { formatPriceExact, formatSignedUsdg, formatUsdgCents, scenarioFigures, type ScenarioFigures } from "@/lib/v2/payoffReceipt";
import { RECEIPT_DISCLAIMER, receiptView, type ReceiptView } from "./PnlReceipt";
import { expiryLabel, multipleText } from "./PnlText";

export type ImageShape = "wide" | "square";
type ImageLines = { eyebrow: string; metric: string; headline: string; detail: string; risk: string };
/** Neon NIGHT: lime on black. Night or day for OG images is an open
 * question; night is the default. */
const COLORS = { ground: "#000000", surface: "#1C1C1C", line2: "#2A2A2A", accent: "#C8FF2E", accentInk: "#000000",
  text: "#FFFFFF", ink2: "#BDBDBD", muted: "#9A9A9A", down: "#FF8A7E" };
const SANS = "Plus Jakarta Sans";
const MONO = "JetBrains Mono";

type Font = { name: string; data: ArrayBuffer; weight: 500 | 800; style: "normal" };

/** Fetch a subset at render time; React caches repeated requests in one server process. */
const loadFont = cache(async (family: string, weight: 500 | 800, glyphs: string): Promise<Font | null> => {
  try {
    const query = `family=${encodeURIComponent(family)}:wght@${weight}&text=${encodeURIComponent([...new Set(glyphs)].join(""))}`;
    const cssResponse = await fetch(`https://fonts.googleapis.com/css2?${query}`, { signal: AbortSignal.timeout(8_000), cache: "force-cache" });
    if (!cssResponse.ok) return null;
    const css = await cssResponse.text();
    const source = css.match(/src:\s*url\(([^)]+)\)\s*format\('(?:truetype|opentype)'\)/)?.[1];
    if (!source) return null;
    const response = await fetch(source, { signal: AbortSignal.timeout(8_000), cache: "force-cache" });
    return response.ok ? { name: family, data: await response.arrayBuffer(), weight, style: "normal" } : null;
  } catch {
    return null;
  }
});

function BrandMark() {
  return <svg width="42" height="42" viewBox="0 0 26 26"><rect width="26" height="26" rx="8" fill={COLORS.accent} />
    <rect x="6" y="16.5" width="14" height="2.5" rx="1" fill={COLORS.accentInk} />
    <path d="M7 15 12.04 8.7 14.68 11.58 19 6v1.98l-4.08 6.12-2.76-2.88L8.44 15Z" fill={COLORS.accentInk} /></svg>;
}

export async function renderBrandImage(lines: ImageLines, shape: ImageShape = "wide"): Promise<ImageResponse> {
  const square = shape === "square";
  const width = square ? 1080 : 1200;
  const height = square ? 1080 : 630;
  const glyphs = Object.values(lines).join(" ") + "stonkhouse.fun";
  const [display, body] = await Promise.all([loadFont(SANS, 800, glyphs), loadFont(SANS, 500, glyphs)]);
  const fonts = display && body ? [display, body] : undefined;
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between",
      backgroundColor: COLORS.ground, color: COLORS.text, padding: square ? "74px" : "58px 68px", fontFamily: fonts ? SANS : "sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "16px", fontFamily: fonts ? SANS : "sans-serif", fontSize: square ? 36 : 30, fontWeight: 800 }}>
          <BrandMark /> stonkhouse
        </div>
        <div style={{ color: COLORS.accent, fontSize: square ? 23 : 19, fontWeight: 500, letterSpacing: "0.13em", textTransform: "uppercase" }}>{lines.eyebrow}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: square ? 24 : 12 }}>
        <div style={{ color: COLORS.accent, fontFamily: fonts ? SANS : "sans-serif", fontWeight: 800,
          fontSize: square ? 146 : 112, lineHeight: 1.02, letterSpacing: "-0.055em" }}>{lines.metric}</div>
        <div style={{ fontFamily: fonts ? SANS : "sans-serif", fontWeight: 800, fontSize: square ? 64 : 58,
          lineHeight: 1.12, letterSpacing: "-0.035em" }}>{lines.headline}</div>
        <div style={{ color: COLORS.muted, fontSize: square ? 34 : 27 }}>{lines.detail}</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: `2px solid ${COLORS.surface}`,
        paddingTop: square ? 30 : 24, color: COLORS.muted, fontSize: square ? 28 : 22 }}>
        <div>{lines.risk}</div><div>app.stonkhouse.fun</div>
      </div>
    </div>,
    { width, height, fonts },
  );
}

export function neutralPnlLines(): ImageLines {
  return { eyebrow: "On-chain outcomes", metric: "StonkHouse", headline: "See what settled", detail: "Verifiable option outcomes on Robinhood Chain",
    risk: "Know the maximum loss before buying" };
}

/** The receipt's mini payoff as plain SVG for the image renderer: the same model the page's
 * PayoffChart draws (value at expiry, what was paid, the exit dot), in CHART_VIEW coordinates. */
export function receiptChartSvg(view: ReceiptView): { area: string; expiry: string; baseY: number; costY: number; dot: { x: number; y: number } } | null {
  if (!view.chart) return null;
  const model = buildPayoffChart(view.chart.input);
  const point = model.at(view.chart.price);
  return { area: model.areaPath, expiry: model.expiryPath, baseY: model.baseY, costY: model.costY, dot: { x: point.x, y: point.y } };
}

function ReceiptChart({ view, width, height }: { view: ReceiptView; width: number; height: number }) {
  const svg = receiptChartSvg(view);
  if (!svg) return null;
  const { width: w, height: h } = CHART_VIEW;
  return <svg width={width} height={height} viewBox={`0 0 ${w} ${h}`}>
    <path d={svg.area} fill={COLORS.accent} fillOpacity={0.2} />
    <line x1="0" y1={svg.baseY} x2={w} y2={svg.baseY} stroke={COLORS.line2} strokeWidth={2} />
    <path d={svg.expiry} fill="none" stroke={COLORS.accent} strokeWidth={5} strokeLinejoin="round" />
    <line x1="0" y1={svg.costY} x2={w} y2={svg.costY} stroke={COLORS.down} strokeWidth={3} strokeDasharray="12 10" />
    <circle cx={svg.dot.x} cy={svg.dot.y} r={14} fill={COLORS.ground} stroke={COLORS.accent} strokeWidth={6} />
  </svg>;
}

/** The win receipt card as the receipt URL's OG image: the page's card, laid out for 1200 × 630 (wide)
 * or 1080 × 1080 (square). Night palette, Plus Jakarta Sans + JetBrains Mono. */
export async function renderPnlImage(pnl: PnlResponse | null, shape: ImageShape = "wide"): Promise<ImageResponse> {
  if (!pnl) return renderBrandImage(neutralPnlLines(), shape);
  const view = receiptView(pnl);
  const square = shape === "square";
  const width = square ? 1080 : 1200;
  const height = square ? 1080 : 630;
  const text = [view.receiptNo, view.option, view.multiple, view.multipleLabel, view.paidGot, view.entry, view.exit, view.wallet,
    RECEIPT_DISCLAIMER, "stonkhouse EntryExitWallet app.stonkhouse.fun"].join(" ");
  const [heavy, body, mono] = await Promise.all([loadFont(SANS, 800, text), loadFont(SANS, 500, text), loadFont(MONO, 500, text)]);
  const fonts = heavy && body && mono ? [heavy, body, mono] : undefined;
  const sans = fonts ? SANS : "sans-serif";
  const monoFamily = fonts ? MONO : "monospace";
  const stat = (label: string, value: string) => <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
    <div style={{ color: COLORS.muted, fontSize: square ? 22 : 18 }}>{label}</div>
    <div style={{ fontFamily: monoFamily, fontSize: square ? 30 : 19, color: COLORS.text, whiteSpace: "nowrap" }}>{value}</div>
  </div>;
  const headline = <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
    <div style={{ color: COLORS.ink2, fontSize: square ? 34 : 28, fontWeight: 800 }}>{view.option}</div>
    <div style={{ color: COLORS.accent, fontSize: square ? 220 : 170, fontWeight: 800, lineHeight: 0.9, letterSpacing: "-0.06em" }}>{view.multiple}</div>
    <div style={{ color: COLORS.muted, fontSize: square ? 20 : 17, fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase" }}>{view.multipleLabel}</div>
    <div style={{ fontSize: square ? 34 : 28, fontWeight: 800 }}>{view.paidGot}</div>
  </div>;
  const details = <div style={{ display: "flex", gap: square ? 16 : 10, borderTop: `2px solid ${COLORS.surface}`, paddingTop: 20 }}>
    {stat("Entry", view.entry)}{stat("Exit", view.exit)}{stat("Wallet", view.wallet)}
  </div>;
  const chartW = square ? 936 : 520;
  const chartH = Math.round(chartW * CHART_VIEW.height / CHART_VIEW.width);
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 24,
      backgroundColor: COLORS.ground, color: COLORS.text, padding: square ? "72px" : "52px 60px", fontFamily: sans }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: square ? 38 : 32, fontWeight: 800, letterSpacing: "-0.02em" }}>
          <BrandMark /> stonkhouse
        </div>
        <div style={{ fontFamily: monoFamily, color: COLORS.muted, fontSize: square ? 24 : 20 }}>{view.receiptNo}</div>
      </div>
      {square
        ? <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>{headline}<ReceiptChart view={view} width={chartW} height={chartH} />{details}</div>
        : <div style={{ display: "flex", gap: 40, alignItems: "flex-end" }}>
          <div style={{ display: "flex", flex: 1 }}>{headline}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 18, width: chartW }}><ReceiptChart view={view} width={chartW} height={chartH} />{details}</div>
        </div>}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 24, color: COLORS.muted, fontSize: square ? 20 : 18 }}>
        <div style={{ display: "flex", flex: 1 }}>{RECEIPT_DISCLAIMER}</div><div style={{ display: "flex" }}>app.stonkhouse.fun</div>
      </div>
    </div>,
    { width, height, fonts },
  );
}

/** A hypothetical the explorer shares: the same card as a settled outcome, watermarked as a
 * scenario. Every figure is recomputed here from the position and the ticket's quoted cost; nothing in the
 * query is trusted as a number, only as an input to the same math the slider runs. */
export type PnlScenario = {
  ticker: string;
  position: PayoffPosition;
  /** Total the ticket quoted (premium + taker fee), USDG-6. */
  cost: bigint;
  /** The slid settlement price, USDG-6. */
  price: bigint;
  expiry: number;
  slippageBps: number;
  routeFeeBps: number;
};

export const SCENARIO_WATERMARK = "Scenario, not a fill";

/** The scenario card's figures keep the explorer's rounding (cost up, P&L down) but drop a ".00" tail: "$240", "0". */
const noZeroCents = (text: string) => text.replace(/\.00$/, "");
const scenarioMultiple = (multiple: number | null) => multiple === null ? "—" : multipleText(multiple);

export function scenarioImageCopy(scenario: PnlScenario) {
  const figures: ScenarioFigures = scenarioFigures(scenario.position, scenario.cost, scenario.price,
    { slippageBps: scenario.slippageBps, routeFeeBps: scenario.routeFeeBps });
  const low = figures.pnlLow;
  const high = figures.pnlHigh;
  const pnl = (raw: bigint) => noZeroCents(formatSignedUsdg(raw));
  const metric = low.pnl === high.pnl ? `${pnl(high.pnl)} USDG` : `${pnl(low.pnl)} to ${pnl(high.pnl)} USDG`;
  const multiple = low.multiple === high.multiple ? scenarioMultiple(high.multiple)
    : `${scenarioMultiple(low.multiple)} to ${scenarioMultiple(high.multiple)}`;
  const side = scenario.position.isPut ? "put" : "call";
  const cost = noZeroCents(formatUsdgCents(scenario.cost, "up"));
  return {
    eyebrow: SCENARIO_WATERMARK,
    metric,
    headline: `If ${scenario.ticker} ends at $${noZeroCents(formatPriceExact(scenario.price))} by ${expiryLabel(scenario.expiry)}`,
    detail: `${scenario.ticker} $${noZeroCents(formatPriceExact(scenario.position.strike))} ${side} · ${multiple} on a ${cost} USDG buy`,
    risk: `Max loss ${cost} USDG · ${SCENARIO_WATERMARK.toLowerCase()}`,
  };
}

export async function renderScenarioImage(scenario: PnlScenario | null, shape: ImageShape = "wide"): Promise<ImageResponse> {
  if (!scenario) return renderBrandImage(neutralPnlLines(), shape);
  let lines: ImageLines;
  try {
    lines = scenarioImageCopy(scenario);
  } catch (error) {
    // The math refuses what the contracts would (a fee above its ceiling, a percentage too large to display):
    // a query that passes the shape check but not the arithmetic gets the neutral card, never a 500.
    if (!(error instanceof RangeError)) throw error;
    lines = neutralPnlLines();
  }
  return renderBrandImage(lines, shape);
}

const EXERCISE_FEE_CEIL_BPS = 200;
const TICKER = /^[A-Z][A-Z0-9.]{0,11}$/;

function uint(value: string | null, max?: bigint): bigint | null {
  if (value === null || !/^\d{1,40}$/.test(value)) return null;
  const parsed = BigInt(value);
  return max !== undefined && parsed > max ? null : parsed;
}

/** A small whole number within `max`. Ten digits: a unix expiry is ten digits until 2286, and the bps counts are
 * three. (A nine-digit cap refused every real expiry and sent every share link to the neutral card.) */
function count(value: string | null, max: number): number | null {
  if (value === null || !/^\d{1,10}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed > max ? null : parsed;
}

/** The share card's inputs, from the explorer's query. Every number is re-validated to the contract's own
 * bounds; a malformed or out-of-range query renders the neutral brand card rather than a wrong number. */
export function parseScenario(params: URLSearchParams): PnlScenario | null {
  const ticker = params.get("ticker")?.toUpperCase() ?? "";
  const strike = uint(params.get("strike"));
  const units = uint(params.get("units"));
  const cost = uint(params.get("cost"));
  const price = uint(params.get("price"));
  const expiry = count(params.get("expiry"), 4_102_444_800);
  const exerciseFeeBps = count(params.get("fee"), EXERCISE_FEE_CEIL_BPS);
  const slippageBps = params.has("slippage") ? count(params.get("slippage"), MAX_PAYOUT_SLIPPAGE_CEIL_BPS) : MAX_PAYOUT_SLIPPAGE_CEIL_BPS;
  const routeFeeBps = params.has("routeFee") ? count(params.get("routeFee"), MAX_ROUTE_FEE_BPS) : MAX_ROUTE_FEE_BPS;
  const side = params.get("side");
  if (!TICKER.test(ticker) || strike === null || strike === 0n || units === null || units === 0n || cost === null ||
    price === null || expiry === null || expiry === 0 || exerciseFeeBps === null || slippageBps === null || routeFeeBps === null ||
    (side !== "put" && side !== "call")) return null;
  return { ticker, position: { isPut: side === "put", strike, units, exerciseFeeBps }, cost, price, expiry, slippageBps, routeFeeBps };
}

