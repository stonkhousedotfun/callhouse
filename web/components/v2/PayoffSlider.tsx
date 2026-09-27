"use client";

import { useState, type ReactNode } from "react";

import { InfoTip } from "@/components/ui";
import { PayoffChart } from "@/components/v2/PayoffChart";
import { fmtUsdPrice } from "@/lib/format";
import {
  MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS, breakeven, breakevenUsdg, type ConversionTerms, type PayoffPosition,
} from "@/lib/v2/payoff";
import { formatShareQuantity } from "@/lib/v2/payoffCard";
import { buildPayoffChart, clampChartPrice, defaultHandlePrice, type ChartInput } from "@/lib/v2/payoffChart";
import {
  bandText, formatMultiple, formatPct, formatSignedUsdg, formatTokens, formatUsdgCents, scenarioFigures, type ScenarioFigures,
} from "@/lib/v2/payoffReceipt";

/** What the slider hands to whatever is mounted under it (the receipt, the share button). */
export type SliderScenario = { price: bigint; figures: ScenarioFigures; moved: boolean };

type PayoffSliderProps = {
  ticker: string;
  /** Live underlying price, USDG-6 per whole share. */
  spot: bigint;
  /** Include the ticket's selected quantity and the series-pinned exercise fee. */
  position: PayoffPosition;
  /** Total ticket cost including taker fee, USDG-6. */
  cost: bigint;
  /** The premium part of `cost` at the live ask. With `expiry` and `now` it fits the before-expiry curve's implied
   * vol; without them the chart draws the expiry value only and says why. */
  premium?: bigint | null;
  /** Series expiry and the current time, unix seconds. */
  expiry?: number | null;
  now?: number | null;
  /** G7. The Clearinghouse conversion bound for a call's USDG band; the contract ceiling when the wire has none. */
  terms?: ConversionTerms;
  className?: string;
  /** Mounted inside the figure under the stat row, re-rendered with every handle move. */
  renderScenario?: (scenario: SliderScenario) => ReactNode;
  bare?: boolean;
};

export const CEILING_TERMS: ConversionTerms = { slippageBps: MAX_PAYOUT_SLIPPAGE_CEIL_BPS, routeFeeBps: MAX_ROUTE_FEE_BPS };

/** The scenario sentence under the tiles. */
export function scenarioSentence(ticker: string, isPut: boolean, figures: ScenarioFigures, cost: bigint): string {
  const priceText = fmtUsdPrice(figures.price);
  const costText = formatUsdgCents(cost, "up");
  if (isPut) return `If ${ticker} settles at ${priceText} you receive ${formatUsdgCents(figures.netTotal, "down")} USDG — you paid ${costText} USDG.`;
  return `If ${ticker} settles at ${priceText} you receive ${formatTokens(figures.netTotal)} ${ticker}, worth about ${bandText(figures.band!)} — you paid ${costText} USDG.`;
}

/** The ticket's payoff explorer: the neon PayoffChart bound to the ticket's strike and size, with the
 * four figures under it. The chart is the control; this component owns the chosen price. */
export function PayoffSlider({
  ticker, spot, position, cost, premium = null, expiry = null, now = null, terms = CEILING_TERMS, className = "", renderScenario,
  bare = false,
}: PayoffSliderProps) {
  const input: ChartInput = {
    ticker, isPut: position.isPut, strike: position.strike, units: position.units, spot, cost,
    premium, exerciseFeeBps: position.exerciseFeeBps, expiry, now,
  };
  const domain = buildPayoffChart(input).domain;
  // A new strike or side resets the handle to its default; a size or quote refresh keeps a moved one.
  const key = `${ticker}:${position.isPut}:${position.strike}`;
  const [scenario, setScenario] = useState<{ key: string; price: bigint } | null>(null);
  const moved = scenario !== null && scenario.key === key;
  const selected = clampChartPrice(moved ? scenario.price : defaultHandlePrice(input, domain), domain);
  const figures = scenarioFigures(position, cost, selected, terms);
  const breakevenUsdgPrice = position.isPut ? null : breakevenUsdg(position, cost, terms.slippageBps, terms.routeFeeBps);
  const inKind = breakeven(position, cost);
  const heroBreakeven = position.isPut ? inKind : breakevenUsdgPrice;
  const sentence = scenarioSentence(ticker, position.isPut, figures, cost);
  const costText = formatUsdgCents(cost, "up");
  const gain = figures.pnlHigh.pnl > 0n;
  const loss = figures.pnlLow.pnl < 0n;
  const pnlTone = gain && !loss ? "text-accent-text" : loss && !gain ? "text-danger-text" : "text-ink";
  const pnlGlyph = gain && !loss ? "▲ " : loss && !gain ? "▼ " : "";

  return <figure className={`@container min-w-0 ${bare ? "" : "rounded-md border border-line bg-surface p-4 sm:p-5"} ${className}`}>
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 className="font-display text-base font-extrabold text-ink">Explore the payoff <InfoTip label="About the payoff">
        {position.isPut ? "Drag the chart or use the arrow keys."
          : "Drag the chart or use the arrow keys. Winning calls are owed Stock Tokens; USDG conversion may deliver less or fall back to tokens."}
      </InfoTip></h3>
      <span className="text-xs text-ink-3">{formatShareQuantity(position.units)} · option value by price</span>
    </div>
    <PayoffChart className="mt-3" input={input} price={selected} onPriceChange={(price) => setScenario({ key, price })} />

    <dl className="mt-4 grid grid-cols-2 gap-2.5 @xl:grid-cols-4">
      <div className="min-w-0 rounded-sm border border-line bg-surface-2 p-3">
        <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-3">Max loss</dt>
        <dd className="num mt-1 text-base font-semibold text-ink">{costText} USDG</dd>
      </div>
      <div className="min-w-0 rounded-sm border border-line bg-surface-2 p-3">
        <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-3">Break-even</dt>
        {position.isPut
          ? <dd className="num mt-1 text-base font-semibold text-ink">{inKind === null ? "—" : fmtUsdPrice(inKind)}</dd>
          : <>
            <dd className="num mt-1 text-sm font-semibold text-ink">in tokens {inKind === null ? "—" : fmtUsdPrice(inKind)}</dd>
            <dd className="num mt-0.5 text-sm font-semibold text-ink">in USDG about {breakevenUsdgPrice === null ? "—" : fmtUsdPrice(breakevenUsdgPrice)}</dd>
          </>}
        {heroBreakeven === null ? <dd className="mt-0.5 text-xs text-ink-3">this option cannot cover its cost at any price</dd> : null}
      </div>
      <div className="min-w-0 rounded-sm border border-line bg-surface-2 p-3">
        <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-3">Value at {fmtUsdPrice(selected)}</dt>
        {position.isPut
          ? <><dd className="num mt-1 text-base font-semibold text-ink">{formatUsdgCents(figures.netTotal, "down")} USDG</dd>
            <dd className="mt-0.5 text-xs text-ink-3">USDG you receive</dd></>
          : <><dd className="num mt-1 text-base font-semibold text-ink">{formatTokens(figures.netTotal)} {ticker}</dd>
            <dd className="num mt-0.5 text-xs text-ink-3">Stock Tokens worth about {bandText(figures.band!)}</dd></>}
      </div>
      <div className="min-w-0 rounded-sm border border-line bg-surface-2 p-3">
        <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-3">Net P&amp;L</dt>
        <dd className={`num mt-1 text-base font-semibold ${pnlTone}`}>{pnlGlyph}{figures.pnlLow.pnl === figures.pnlHigh.pnl
          ? formatSignedUsdg(figures.pnlHigh.pnl)
          : `${formatSignedUsdg(figures.pnlLow.pnl)} … ${formatSignedUsdg(figures.pnlHigh.pnl)}`} USDG</dd>
        <dd className={`num mt-0.5 text-xs ${pnlTone}`}>{figures.pnlLow.pct === figures.pnlHigh.pct
          ? `${formatPct(figures.pnlHigh.pct)} · ${formatMultiple(figures.pnlHigh.multiple)}`
          : `${formatPct(figures.pnlLow.pct)} to ${formatPct(figures.pnlHigh.pct)} · ${formatMultiple(figures.pnlLow.multiple)} to ${formatMultiple(figures.pnlHigh.multiple)}`}</dd>
      </div>
    </dl>
    <p className="mt-4 text-sm leading-relaxed text-ink" aria-live="off">{sentence}</p>
    {renderScenario ? renderScenario({ price: selected, figures, moved }) : null}
  </figure>;
}
