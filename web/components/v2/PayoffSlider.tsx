"use client";

import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";

import { multipleAt, payoutAt, type PayoffPosition } from "@/lib/v2/payoff";
import {
  CURVE_VIEW, buildPayoffCurve, clampPrice, keyboardPriceStep, priceAtRatio,
} from "@/lib/v2/payoffCurve";

type PayoffSliderProps = {
  ticker: string;
  /** Live underlying price, USDG-6 per whole share. */
  spot: bigint;
  /** Include the ticket's selected quantity and the series-pinned exercise fee. */
  position: PayoffPosition;
  /** Total ticket cost including taker fee, USDG-6. */
  cost: bigint;
  className?: string;
};

const CENT = 10_000n;
const SIX = 1_000_000n;

function group(value: bigint): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Show the exact scenario price, with at least cents. */
function formatPrice(raw: bigint): string {
  const whole = group(raw / SIX);
  const fraction = (raw % SIX).toString().padStart(6, "0").replace(/0+$/, "").padEnd(2, "0");
  return `${whole}.${fraction}`;
}

/** Costs round up; projected payouts round down to the displayed cent. */
function formatMoney(raw: bigint, roundUp: boolean): string {
  const cents = roundUp ? (raw + CENT - 1n) / CENT : raw / CENT;
  return `${group(cents / 100n)}.${(cents % 100n).toString().padStart(2, "0")}`;
}

/** Explore a hypothetical expiry price. The SVG is a fee-net P&L curve; the handle is the slider. */
export function PayoffSlider({ ticker, spot, position, cost, className = "" }: PayoffSliderProps) {
  const key = `${ticker}:${position.isPut}:${position.strike}`;
  // An untouched slider follows live spot. A moved scenario survives quote/quantity refreshes.
  const [scenario, setScenario] = useState<{ key: string; price: bigint | null }>({ key, price: null });
  const curve = buildPayoffCurve(spot, position, cost);
  const selected = clampPrice(scenario.key === key ? scenario.price ?? spot : spot, curve.range);
  const point = curve.pointAt(selected);
  const payout = payoutAt(selected, position);
  const multiple = multipleAt(selected, position, cost);
  const priceText = formatPrice(selected);
  const costText = formatMoney(cost, true);
  const payoutText = formatMoney(payout, false);
  const sentence = position.isPut
    ? `If ${ticker} is at $${priceText} at expiry you get ${payoutText} USDG (${multiple === null ? "—" : `${multiple.toFixed(2)}×`}) — you paid ${costText} USDG.`
    : `If ${ticker} is at $${priceText} at expiry, the estimated settlement value is ${payoutText} USDG (${multiple === null ? "—" : `${multiple.toFixed(2)}×`}) — you paid ${costText} USDG.`;
  const instructionId = useId();

  function updateFromPointer(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const left = rect.left + rect.width * CURVE_VIEW.left / CURVE_VIEW.width;
    const usable = rect.width * (CURVE_VIEW.width - CURVE_VIEW.left - CURVE_VIEW.right) / CURVE_VIEW.width;
    if (usable <= 0) return;
    setScenario({ key, price: priceAtRatio((event.clientX - left) / usable, curve.range) });
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
    const step = keyboardPriceStep(curve.range);
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
    setScenario({ key, price: clampPrice(next, curve.range) });
  }

  const plotBottom = CURVE_VIEW.height - CURVE_VIEW.bottom;
  const marker = (x: number, color: string, dashed = false) => <line
    x1={x} x2={x} y1={CURVE_VIEW.top} y2={plotBottom}
    stroke={color} strokeWidth={1.5} strokeDasharray={dashed ? "5 5" : undefined}
  />;

  return <figure className={`min-w-0 rounded-md border border-line bg-surface p-4 sm:p-5 ${className}`}>
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
      <h3 className="font-display text-base font-semibold text-ink">Explore the payoff</h3>
      <span className="text-xs text-ink-2">At expiry · {position.units.toString()} × 0.01 share</span>
    </div>
    <div className="relative mt-3 select-none">
      <svg viewBox={`0 0 ${CURVE_VIEW.width} ${CURVE_VIEW.height}`} className="block h-auto w-full" aria-hidden="true" focusable="false">
        <line x1={CURVE_VIEW.left} x2={CURVE_VIEW.width - CURVE_VIEW.right} y1={curve.zeroY} y2={curve.zeroY}
          stroke="var(--line-2)" strokeWidth={1.5} />
        {curve.strikeX !== null ? marker(curve.strikeX, "var(--ink-3)", true) : null}
        {curve.breakevenX !== null ? marker(curve.breakevenX, "var(--usdg)", true) : null}
        {marker(curve.spotX, "var(--warn)", true)}
        <path d={curve.path} fill="none" stroke="var(--accent)" strokeWidth={3.5} strokeLinecap="round" strokeLinejoin="round" />
        <line x1={point.x} x2={point.x} y1={CURVE_VIEW.top} y2={plotBottom} stroke="var(--accent)" strokeWidth={2} />
        <circle cx={point.x} cy={point.y} r={8} fill="var(--surface)" stroke="var(--accent)" strokeWidth={3} />
      </svg>
      <div
        role="slider"
        tabIndex={0}
        aria-label={`${ticker} price at expiry`}
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
      <span>${formatPrice(curve.range.min)}</span><span>${formatPrice(curve.range.max)}</span>
    </div>
    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2" aria-hidden="true">
      <span>Strike <span className="num text-ink">${formatPrice(position.strike)}</span></span>
      <span>Spot <span className="num text-ink">${formatPrice(spot)}</span></span>
      <span>{position.isPut ? "Break-even" : "Estimated break-even"} <span className="num text-ink">{curve.breakevenPrice === null ? "outside this option’s payout" : `$${formatPrice(curve.breakevenPrice)}`}</span></span>
    </div>
    <p className="mt-4 text-sm leading-relaxed text-ink" aria-live="off">{sentence}</p>
    {!position.isPut ? <p className="mt-1 text-xs text-ink-3">Winning calls are owed Stock Tokens. USDG conversion may deliver less or fall back to tokens.</p> : null}
    <p className="mt-1 text-sm font-semibold text-ink">Max loss: {costText} USDG.</p>
    <p id={instructionId} className="mt-2 text-xs text-ink-3">Drag the chart, tap a price, or use arrow keys. Page Up and Down move faster.</p>
  </figure>;
}
