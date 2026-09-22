import { ImageResponse } from "next/og";
import { cache } from "react";
import type { PnlResponse } from "@/lib/v2/api-types";
import { MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS, type PayoffPosition } from "@/lib/v2/payoff";
import { formatMultiple, formatPriceExact, formatSignedUsdg, formatUsdgCents, scenarioFigures, type ScenarioFigures } from "@/lib/v2/payoffReceipt";
import { expiryLabel, receiptImageCopy } from "./PnlText";

export type ImageShape = "wide" | "square";
type ImageLines = { eyebrow: string; metric: string; headline: string; detail: string; risk: string };
const COLORS = { ground: "#0b1511", surface: "#14271e", accent: "#49d49a", text: "#f0f8f2", muted: "#acbdb1" };

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
    <rect x="6" y="16.5" width="14" height="2.5" rx="1" fill={COLORS.ground} />
    <path d="M7 15 12.04 8.7 14.68 11.58 19 6v1.98l-4.08 6.12-2.76-2.88L8.44 15Z" fill={COLORS.ground} /></svg>;
}

export async function renderBrandImage(lines: ImageLines, shape: ImageShape = "wide"): Promise<ImageResponse> {
  const square = shape === "square";
  const width = square ? 1080 : 1200;
  const height = square ? 1080 : 630;
  const glyphs = Object.values(lines).join(" ") + "stonkhouse.fun";
  const [display, body] = await Promise.all([
    loadFont("Schibsted Grotesk", 800, glyphs),
    loadFont("Figtree", 500, glyphs),
  ]);
  const fonts = display && body ? [display, body] : undefined;
  return new ImageResponse(
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between",
      backgroundColor: COLORS.ground, color: COLORS.text, padding: square ? "74px" : "58px 68px", fontFamily: fonts ? "Figtree" : "sans-serif" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "16px", fontFamily: fonts ? "Schibsted Grotesk" : "sans-serif", fontSize: square ? 36 : 30, fontWeight: 800 }}>
          <BrandMark /> stonkhouse
        </div>
        <div style={{ color: COLORS.accent, fontSize: square ? 23 : 19, fontWeight: 500, letterSpacing: "0.13em", textTransform: "uppercase" }}>{lines.eyebrow}</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: square ? 24 : 12 }}>
        <div style={{ color: COLORS.accent, fontFamily: fonts ? "Schibsted Grotesk" : "sans-serif", fontWeight: 800,
          fontSize: square ? 146 : 112, lineHeight: 1.02, letterSpacing: "-0.055em" }}>{lines.metric}</div>
        <div style={{ fontFamily: fonts ? "Schibsted Grotesk" : "sans-serif", fontWeight: 800, fontSize: square ? 64 : 58,
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

export async function renderPnlImage(pnl: PnlResponse | null, shape: ImageShape = "wide"): Promise<ImageResponse> {
  if (!pnl) return renderBrandImage(neutralPnlLines(), shape);
  const copy = receiptImageCopy(pnl);
  return renderBrandImage({ eyebrow: "Verified outcome", metric: copy.multiple, headline: copy.headline,
    detail: `${copy.series} · ${pnl.settlementPrice === null ? "Expiry" : "Expired"} ${copy.expiry}`,
    risk: copy.maxLoss }, shape);
}

/** A hypothetical the explorer shares (design §2.8): the same card as a settled outcome, watermarked as a
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

export function scenarioImageCopy(scenario: PnlScenario) {
  const figures: ScenarioFigures = scenarioFigures(scenario.position, scenario.cost, scenario.price,
    { slippageBps: scenario.slippageBps, routeFeeBps: scenario.routeFeeBps });
  const low = figures.pnlLow;
  const high = figures.pnlHigh;
  const metric = low.pnl === high.pnl ? `${formatSignedUsdg(high.pnl)} USDG` : `${formatSignedUsdg(low.pnl)} to ${formatSignedUsdg(high.pnl)} USDG`;
  const multiple = low.multiple === high.multiple ? formatMultiple(high.multiple) : `${formatMultiple(low.multiple)} to ${formatMultiple(high.multiple)}`;
  const side = scenario.position.isPut ? "put" : "call";
  return {
    eyebrow: SCENARIO_WATERMARK,
    metric,
    headline: `If ${scenario.ticker} ends at $${formatPriceExact(scenario.price)} by ${expiryLabel(scenario.expiry)}`,
    detail: `${scenario.ticker} $${formatPriceExact(scenario.position.strike)} ${side} · ${multiple} on a ${formatUsdgCents(scenario.cost, "up")} USDG buy`,
    risk: `Max loss ${formatUsdgCents(scenario.cost, "up")} USDG · ${SCENARIO_WATERMARK.toLowerCase()}`,
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

