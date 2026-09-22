"use client";

import { useId, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import {
  MAX_PAYOUT_SLIPPAGE_CEIL_BPS, MAX_ROUTE_FEE_BPS, breakevenUsdg, type ConversionTerms, type PayoffPosition,
} from "@/lib/v2/payoff";
import {
  CURVE_VIEW, buildPayoffCurve, clampPrice, keyboardPriceStep, presetPrices, priceAtRatio, type PresetKey,
} from "@/lib/v2/payoffCurve";
import {
  bandText, formatMultiple, formatPct, formatPriceExact, formatSignedUsdg, formatTokens, formatUsdgCents, pnlRangeText,
  scenarioFigures, type ScenarioFigures,
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
  /** G7. The Clearinghouse conversion bound for a call's USDG band; the contract ceiling when the wire has none. */
  terms?: ConversionTerms;
  className?: string;
  /** Mounted inside the figure under the stat row, re-rendered with every handle move. */
  renderScenario?: (scenario: SliderScenario) => ReactNode;
};

export const CEILING_TERMS: ConversionTerms = { slippageBps: MAX_PAYOUT_SLIPPAGE_CEIL_BPS, routeFeeBps: MAX_ROUTE_FEE_BPS };
const SIX = 1_000_000n;

/** The scenario sentence, shared by the visible copy, `aria-valuetext` and the preset announcement. */
export function scenarioSentence(ticker: string, isPut: boolean, figures: ScenarioFigures, cost: bigint): string {
  const priceText = formatPriceExact(figures.price);
  const costText = formatUsdgCents(cost, "up");
  if (isPut) return `If ${ticker} settles at $${priceText} you receive ${formatUsdgCents(figures.netTotal, "down")} USDG — you paid ${costText} USDG.`;
  return `If ${ticker} settles at $${priceText} you receive ${formatTokens(figures.netTotal)} ${ticker}, worth about ${bandText(figures.band!)} — you paid ${costText} USDG.`;
}

/** Explore a hypothetical settlement price. The SVG is a fee-net P&L curve; the handle is the slider (design §2.2-2.4). */
export function PayoffSlider({ ticker, spot, position, cost, terms = CEILING_TERMS, className = "", renderScenario }: PayoffSliderProps) {
  const key = `${ticker}:${position.isPut}:${position.strike}`;
  // An untouched slider follows live spot. A moved scenario survives quote/quantity refreshes.
  const [scenario, setScenario] = useState<{ key: string; price: bigint | null }>({ key, price: null });
  // Announced only when a preset is chosen, never per drag step (§2.7).
  const [announcement, setAnnouncement] = useState("");
  const breakevenUsdgPrice = position.isPut ? null : breakevenUsdg(position, cost, terms.slippageBps, terms.routeFeeBps);
  const curve = buildPayoffCurve(spot, position, cost, breakevenUsdgPrice);
  const heroBreakeven = position.isPut ? curve.breakevenPrice : breakevenUsdgPrice;
  const moved = scenario.key === key && scenario.price !== null;
  const selected = clampPrice(moved ? scenario.price! : spot, curve.range);
  const point = curve.pointAt(selected);
  const figures = scenarioFigures(position, cost, selected, terms);
  const presets = presetPrices(spot, position.strike, heroBreakeven);
  const step = keyboardPriceStep(curve.range);
  const activePreset: PresetKey | null = presets.find((preset) => preset.price !== null &&
    (preset.price > selected ? preset.price - selected : selected - preset.price) <= step)?.key ?? null;
  const sentence = scenarioSentence(ticker, position.isPut, figures, cost);
  const costText = formatUsdgCents(cost, "up");
  const instructionId = useId();
  const liveId = useId();

  function choose(price: bigint, label?: string) {
    const bounded = clampPrice(price, curve.range);
    setScenario({ key, price: bounded });
    if (label) {
      const next = scenarioFigures(position, cost, bounded, terms);
      setAnnouncement(`${label}: net ${pnlRangeText(next.pnlLow, next.pnlHigh)}. ${scenarioSentence(ticker, position.isPut, next, cost)}`);
    }
  }

  function updateFromPointer(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const left = rect.left + rect.width * CURVE_VIEW.left / CURVE_VIEW.width;
    const usable = rect.width * (CURVE_VIEW.width - CURVE_VIEW.left - CURVE_VIEW.right) / CURVE_VIEW.width;
    if (usable <= 0) return;
    choose(priceAtRatio((event.clientX - left) / usable, curve.range));
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    updateFromPointer(event);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) updateFromPointer(event);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    let next: bigint;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp": next = selected + step; break;
      case "ArrowLeft":
      case "ArrowDown": next = selected - step; break;
      case "PageUp": next = selected + step * 10n; break;
      case "PageDown": next = selected - step * 10n; break;
      case "Home": next = curve.range.min; break;
      case "End": next = curve.range.max; break;
      default: return;
    }
    event.preventDefault();
    choose(next);
  }

  const plotBottom = CURVE_VIEW.height - CURVE_VIEW.bottom;
  const marker = (x: number, color: string, width = 1.5) => <line
    x1={x} x2={x} y1={CURVE_VIEW.top} y2={plotBottom}
    stroke={color} strokeWidth={width} strokeDasharray="5 5"
  />;
  // Axis labels follow the tile rule: floor toward negative infinity, so a partial loss never reads as 0 %.
  const pctOfCost = (pnl: bigint) => {
    if (cost === 0n) return "—";
    const q = (pnl * 100n) / cost;
    return formatPct(Number((pnl * 100n) % cost !== 0n && pnl < 0n ? q - 1n : q));
  };
  const gain = figures.pnlHigh.pnl > 0n;
  const loss = figures.pnlLow.pnl < 0n;
  const pnlTone = gain && !loss ? "text-accent-text" : loss && !gain ? "text-danger" : "text-ink";
  const pnlGlyph = gain && !loss ? "▲ " : loss && !gain ? "▼ " : "";
  const chip = (active: boolean) => `num min-h-10 shrink-0 rounded-full border px-3 text-xs font-semibold ${active
    ? "border-accent bg-accent-soft text-accent-text" : "border-line-2 bg-surface text-ink-2"}`;

  return <figure className={`min-w-0 rounded-md border border-line bg-surface p-4 sm:p-5 ${className}`}>
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 className="font-display text-base font-semibold text-ink">Explore the payoff</h3>
      <span className="text-xs text-ink-2">At settlement · {position.units.toString()} × 0.01 share</span>
    </div>
    <div className="relative mt-3 select-none">
      <svg viewBox={`0 0 ${CURVE_VIEW.width} ${CURVE_VIEW.height}`} preserveAspectRatio="none"
        className="block h-[200px] w-full sm:h-[260px]" aria-hidden="true" focusable="false">
        <path d={curve.gainPath} fill="var(--accent)" fillOpacity={0.14} className="motion-safe:transition-[d] motion-safe:duration-150 motion-reduce:transition-none" />
        <path d={curve.lossPath} fill="var(--danger)" fillOpacity={0.12} className="motion-safe:transition-[d] motion-safe:duration-150 motion-reduce:transition-none" />
        <line x1={CURVE_VIEW.left} x2={CURVE_VIEW.width - CURVE_VIEW.right} y1={curve.zeroY} y2={curve.zeroY}
          stroke="var(--line-2)" strokeWidth={1.5} />
        {curve.strikeX !== null ? marker(curve.strikeX, "var(--ink-3)") : null}
        {!position.isPut && curve.breakevenX !== null ? marker(curve.breakevenX, "var(--usdg)", 0.75) : null}
        {position.isPut && curve.breakevenX !== null ? marker(curve.breakevenX, "var(--usdg)") : null}
        {curve.breakevenUsdgX !== null ? marker(curve.breakevenUsdgX, "var(--usdg)") : null}
        {marker(curve.spotX, "var(--warn)")}
        <path d={curve.path} fill="none" stroke="var(--accent)" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" />
        <line x1={point.x} x2={point.x} y1={CURVE_VIEW.top} y2={plotBottom} stroke="var(--accent)" strokeWidth={2} />
      </svg>
      {/* Axis labels: P&L in USDG on the left, % of cost on the right (§2.2). */}
      <div className="num pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-between py-1 text-[10px] leading-none text-ink-3" aria-hidden="true">
        <span>{formatSignedUsdg(curve.domain.high)}</span><span>0</span><span>{formatSignedUsdg(curve.domain.low)}</span>
      </div>
      <div className="num pointer-events-none absolute inset-y-0 right-0 flex flex-col justify-between py-1 text-right text-[10px] leading-none text-ink-3" aria-hidden="true">
        <span>{pctOfCost(curve.domain.high)}</span><span>0 %</span><span>{pctOfCost(curve.domain.low)}</span>
      </div>
      {/* The handle is HTML so it stays round and 44 px on any chart size; the whole chart is the track. */}
      <div aria-hidden="true" className="pointer-events-none absolute flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center motion-safe:transition-[left,top] motion-safe:duration-100 motion-reduce:transition-none"
        style={{ left: `${(point.x / CURVE_VIEW.width) * 100}%`, top: `${(point.y / CURVE_VIEW.height) * 100}%` }}>
        <span className="block h-[18px] w-[18px] rounded-full border-[3px] border-accent bg-surface shadow-soft" />
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label={`${ticker} price at settlement`}
        aria-valuemin={Number(curve.range.min) / Number(SIX)}
        aria-valuemax={Number(curve.range.max) / Number(SIX)}
        aria-valuenow={Number(selected) / Number(SIX)}
        aria-valuetext={`${sentence} Max loss: ${costText} USDG.`}
        aria-describedby={instructionId}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onPointerCancel={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
        onKeyDown={onKeyDown}
        className="absolute inset-0 cursor-crosshair touch-none rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      />
    </div>
    <div className="num flex justify-between gap-2 text-xs text-ink-3" aria-hidden="true">
      <span>${formatPriceExact(curve.range.min)}</span><span>${formatPriceExact(curve.range.max)}</span>
    </div>
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2" aria-hidden="true">
      <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-warn" />Spot <span className="num text-ink">${formatPriceExact(spot)}</span></span>
      <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-ink-3" />Strike <span className="num text-ink">${formatPriceExact(position.strike)}</span></span>
      <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-usdg" />{position.isPut ? "Break-even" : "Break-even in USDG"} <span className="num text-ink">{heroBreakeven === null ? "outside this option’s payout" : `$${formatPriceExact(heroBreakeven)}`}</span></span>
    </div>

    <div role="group" aria-label="Price presets" className="-mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0">
      {presets.map((preset) => <button key={preset.key} type="button" disabled={preset.price === null}
        aria-pressed={activePreset === preset.key} onClick={() => choose(preset.price!, preset.label)}
        className={`${chip(activePreset === preset.key)} disabled:opacity-50`}>{preset.label}</button>)}
      {moved ? <button type="button" onClick={() => { setScenario({ key, price: null }); setAnnouncement("Reset to spot."); }}
        className="min-h-10 shrink-0 rounded-full border border-line-2 bg-surface-2 px-3 text-xs font-semibold text-ink">Reset to spot</button> : null}
    </div>

    <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div className="rounded-sm border border-line bg-surface-2 p-3">
        <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-3">Max loss</dt>
        <dd className="num mt-1 text-base font-semibold text-ink">{costText} USDG</dd>
        <dd className="mt-0.5 text-xs text-ink-3">always — never changes with the slider</dd>
      </div>
      <div className="rounded-sm border border-line bg-surface-2 p-3">
        <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-3">Break-even</dt>
        {position.isPut
          ? <dd className="num mt-1 text-base font-semibold text-ink">{curve.breakevenPrice === null ? "—" : `$${formatPriceExact(curve.breakevenPrice)}`}</dd>
          : <>
            <dd className="num mt-1 text-sm font-semibold text-ink">in kind {curve.breakevenPrice === null ? "—" : `$${formatPriceExact(curve.breakevenPrice)}`}</dd>
            <dd className="num mt-0.5 text-sm font-semibold text-ink">in USDG about {breakevenUsdgPrice === null ? "—" : `$${formatPriceExact(breakevenUsdgPrice)}`}</dd>
          </>}
        {heroBreakeven === null ? <dd className="mt-0.5 text-xs text-ink-3">this option cannot cover its cost at any price</dd> : null}
      </div>
      <div className="rounded-sm border border-line bg-surface-2 p-3">
        <dt className="text-[11px] font-bold uppercase tracking-wide text-ink-3">Value at ${formatPriceExact(selected)}</dt>
        {position.isPut
          ? <><dd className="num mt-1 text-base font-semibold text-ink">{formatUsdgCents(figures.netTotal, "down")} USDG</dd>
            <dd className="mt-0.5 text-xs text-ink-3">USDG you receive</dd></>
          : <><dd className="num mt-1 text-base font-semibold text-ink">{formatTokens(figures.netTotal)} {ticker}</dd>
            <dd className="num mt-0.5 text-xs text-ink-3">Stock Tokens worth about {bandText(figures.band!)}</dd></>}
      </div>
      <div className="rounded-sm border border-line bg-surface-2 p-3">
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
    {!position.isPut ? <p className="mt-1 text-xs text-ink-3">Winning calls are owed Stock Tokens. USDG conversion may deliver less or fall back to tokens; the band is the floor to the settlement value.</p> : null}
    <p id={liveId} role="status" aria-live="polite" className="sr-only">{announcement}</p>
    {renderScenario ? renderScenario({ price: selected, figures, moved }) : null}
    <p id={instructionId} className="mt-3 text-xs text-ink-3">Drag the chart, tap a price or a preset, or use arrow keys. Page Up and Down move faster; Home and End go to the edges.</p>
  </figure>;
}
