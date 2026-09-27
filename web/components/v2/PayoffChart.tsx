"use client";

import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { InfoTip } from "@/components/ui";
import { displayPrice, withDollar } from "@/lib/numberFormat";

import {
  CHART_VIEW, ariaValueText, buildPayoffChart, chartCaptions, clampChartPrice, costLabel, defaultHandlePrice, keyboardChartPrice,
  priceAtRatio, tooltipFor, type ChartInput,
} from "@/lib/v2/payoffChart";

/** large: market page; compact: phone market page; mini: static (receipts, cards), no controls. */
export type PayoffChartVariant = "large" | "compact" | "mini";

type PayoffChartProps = {
  input: ChartInput;
  variant?: PayoffChartVariant;
  /** Controlled handle price (USDG-6). Omit to let the chart keep its own, starting at spot + 5 %. */
  price?: bigint;
  onPriceChange?: (price: bigint) => void;
  className?: string;
};

const TOUCH_DRAG_THRESHOLD = 8;
const CENT = 10_000n;
const SIX = 1_000_000;
const HEIGHT: Record<PayoffChartVariant, string> = {
  large: "h-[220px] sm:h-[280px]",
  compact: "h-[180px]",
  mini: "h-[96px]",
};

type TouchGesture = { pointerId: number; startX: number; startY: number; axis: "pending" | "horizontal" | "vertical" };

const pct = (value: number, of: number) => `${((value / of) * 100).toFixed(3)}%`;

/**
 * The neon payoff chart: option value by price, from where the option is worth $0, with the curvy
 * before-expiry estimate (vol implied by the live ask), the dashed expiry hinge, the dashed cost line, a handle,
 * an inverse tooltip and a legend. The plot is the slider; a native range input mirrors it.
 *
 * Gesture code is the site PayoffDemo's (pointer capture, touch axis-lock so vertical scroll still works).
 */
export function PayoffChart({ input, variant = "large", price, onPriceChange, className = "" }: PayoffChartProps) {
  const model = buildPayoffChart(input);
  const key = `${input.ticker}:${input.isPut}:${input.strike}:${input.spot === null}`;
  const [own, setOwn] = useState<{ key: string; price: bigint } | null>(null);
  const touchGesture = useRef<TouchGesture | null>(null);
  const gradientId = useId();
  const captionId = useId();
  const selected = clampChartPrice(price ?? (own?.key === key ? own.price : defaultHandlePrice(input, model.domain)), model.domain);
  const point = model.at(selected);
  const tip = tooltipFor(model, selected);
  const interactive = variant !== "mini";
  const captions = chartCaptions(model);

  function choose(next: bigint) {
    const bounded = clampChartPrice(next, model.domain);
    setOwn({ key, price: bounded });
    onPriceChange?.(bounded);
  }

  function fromPointer(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const left = rect.left + rect.width * CHART_VIEW.left / CHART_VIEW.width;
    const width = rect.width * (CHART_VIEW.width - CHART_VIEW.left - CHART_VIEW.right) / CHART_VIEW.width;
    if (width > 0) choose(priceAtRatio((event.clientX - left) / width, model.domain));
  }
  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    if (event.pointerType === "touch") {
      if (touchGesture.current) return;
      touchGesture.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, axis: "pending" };
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    fromPointer(event);
  }
  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "touch") {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) fromPointer(event);
      return;
    }
    const gesture = touchGesture.current;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.axis === "vertical") return;
    if (gesture.axis === "pending") {
      const dx = Math.abs(event.clientX - gesture.startX);
      const dy = Math.abs(event.clientY - gesture.startY);
      if (Math.max(dx, dy) < TOUCH_DRAG_THRESHOLD) return;
      if (dy > dx * 1.5) { gesture.axis = "vertical"; return; }
      if (dx <= dy * 1.5) return;
      gesture.axis = "horizontal";
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    fromPointer(event);
  }
  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    const gesture = touchGesture.current;
    if (event.pointerType === "touch" && gesture?.pointerId === event.pointerId) {
      const dx = Math.abs(event.clientX - gesture.startX);
      const dy = Math.abs(event.clientY - gesture.startY);
      if (gesture.axis === "horizontal" || (gesture.axis === "pending" &&
        (Math.max(dx, dy) < TOUCH_DRAG_THRESHOLD || dx > dy * 1.5))) fromPointer(event);
      touchGesture.current = null;
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function onPointerCancel(event: PointerEvent<HTMLDivElement>) {
    if (touchGesture.current?.pointerId === event.pointerId) touchGesture.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = keyboardChartPrice(event.key, selected, model.domain);
    if (next === null) return;
    event.preventDefault();
    choose(next);
  }

  const W = CHART_VIEW.width;
  const H = CHART_VIEW.height;
  const tipOnLeft = point.x / W > 0.55;

  const tipWidth = "min(214px, 72%)";
  const tipLeft = tipOnLeft
    ? `clamp(0px, calc(${pct(point.x, W)} - 16px - ${tipWidth}), calc(100% - ${tipWidth}))`
    : `clamp(0px, calc(${pct(point.x, W)} + 16px), calc(100% - ${tipWidth}))`;

  return <figure className={`min-w-0 ${className}`} data-testid="payoff-chart" aria-describedby={interactive ? captionId : undefined}>
    {variant === "compact" ? <div aria-hidden="true" data-testid="payoff-tooltip"
      className="mb-2 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-md bg-inverse-bg px-3 py-2 text-inverse-ink">
      <span className="num text-xs opacity-75">{tip.title}</span>
      <span className="text-[17px] font-extrabold leading-tight tracking-[-0.02em]">{tip.headline}</span>
      <span className="basis-full text-xs font-semibold opacity-80">{tip.worth}{tip.estimate ? ` · ${tip.estimate}` : ""}</span>
    </div> : null}
    <div className={`relative select-none ${HEIGHT[variant]}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="absolute inset-0 block h-full w-full"
        aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity={0.34} />
            <stop offset="1" stopColor="var(--accent)" stopOpacity={0} />
          </linearGradient>
        </defs>
        {variant !== "mini" ? <path d={model.gridPath} stroke="var(--line)" fill="none" vectorEffect="non-scaling-stroke" /> : null}
        <path d={model.areaPath} fill={`url(#${gradientId})`} />
        <line x1={CHART_VIEW.left} x2={W - CHART_VIEW.right} y1={model.baseY} y2={model.baseY} stroke="var(--line-2)" vectorEffect="non-scaling-stroke" />
        <path d={model.expiryPath} fill="none" stroke="var(--ink-3)" strokeWidth={1.5} strokeDasharray="3 5" vectorEffect="non-scaling-stroke" />
        <line x1={CHART_VIEW.left} x2={W - CHART_VIEW.right} y1={model.costY} y2={model.costY} stroke="var(--danger-text)"
          strokeWidth={1.5} strokeDasharray="6 5" vectorEffect="non-scaling-stroke" />
        {model.curvePath ? <path d={model.curvePath} fill="none" stroke="var(--accent)" strokeWidth={3.5} strokeLinecap="round"
          strokeLinejoin="round" vectorEffect="non-scaling-stroke" /> : null}
        <line x1={point.x} x2={point.x} y1={CHART_VIEW.top} y2={model.baseY} stroke="var(--ink)" strokeWidth={1} strokeDasharray="2 3"
          vectorEffect="non-scaling-stroke" />
      </svg>

      {variant !== "mini" ? <>
        {model.yTicks.map((tick) => <span key={tick.label} aria-hidden="true"
          className="num pointer-events-none absolute left-0 w-9 -translate-y-1/2 text-right text-[11px] leading-none text-ink-3"
          style={{ top: pct(tick.at, H) }}>{tick.label}</span>)}
        {model.xTicks.map((tick) => <span key={tick.label} aria-hidden="true"
          className="num pointer-events-none absolute bottom-0 -translate-x-1/2 text-[11px] leading-none text-ink-3"
          style={{ left: pct(tick.at, W) }}>{tick.label}</span>)}
        {model.spotX !== null ? <span aria-hidden="true"
          className="pointer-events-none absolute top-0 -translate-x-1/2 text-[11px] font-bold text-ink-2"
          style={{ left: pct(model.spotX, W) }}>Now {withDollar(displayPrice(input.spot ?? 0n, 6))}</span> : null}
      </> : null}

      {/* HTML, so the ring stays round on a stretched plot. */}
      <div aria-hidden="true" className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 motion-safe:transition-[left,top] motion-safe:duration-100 motion-reduce:transition-none"
        style={{ left: pct(point.x, W), top: pct(point.y, H) }}>
        <span className={`block rounded-full border-accent bg-ground ${variant === "mini" ? "h-3 w-3 border-2" : "h-[18px] w-[18px] border-[3.5px]"}`} />
      </div>

      {interactive ? <>
        {variant !== "compact" ? <div aria-hidden="true" data-testid="payoff-tooltip"
          className="pointer-events-none absolute top-8 flex flex-col gap-0.5 rounded-md bg-inverse-bg px-3.5 py-3 text-inverse-ink shadow-lift"
          style={{ left: tipLeft, width: tipWidth }}>
          <span className="num text-xs opacity-75">{tip.title}</span>
          <span className="text-[22px] font-extrabold leading-tight tracking-[-0.02em]">{tip.headline}</span>
          <span className="text-xs font-semibold opacity-80">{tip.worth}</span>
          {tip.estimate ? <span className="text-xs font-semibold opacity-80">{tip.estimate}</span> : null}
        </div> : null}
        <div
          role="slider"
          tabIndex={0}
          aria-label={`${input.ticker} price at expiry`}
          aria-valuemin={Number(model.domain.min) / SIX}
          aria-valuemax={Number(model.domain.max) / SIX}
          aria-valuenow={Number(selected) / SIX}
          aria-valuetext={ariaValueText(model, selected)}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onKeyDown={onKeyDown}
          className="absolute inset-0 cursor-crosshair touch-pan-y touch-pinch-zoom rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
      </> : null}
    </div>

    {!interactive && !model.feeKnown ? <figcaption className="mt-1 text-[10px] leading-none text-ink-3">Before exercise fee</figcaption> : null}

    {interactive ? <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
      <input type="range" aria-label={`${input.ticker} price`} className="min-w-40 grow accent-accent"
        min={Number(model.domain.min) / SIX} max={Number(model.domain.max) / SIX} step={0.01} value={Number(selected) / SIX}
        onChange={(event) => {
          const dollars = Number(event.currentTarget.value);
          if (Number.isFinite(dollars)) choose(BigInt(Math.round(dollars * 100)) * CENT);
        }} />
      <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 text-xs font-semibold text-ink-3" aria-hidden="true">
        <span className="flex items-center gap-1.5"><span className="block h-[3px] w-[18px] rounded-full bg-accent" />Value before expiry (est.)</span>
        <span className="flex items-center gap-1.5"><span className="block w-[18px] border-t-2 border-dashed border-ink-3" />At expiry</span>
        <span className="flex items-center gap-1.5 text-danger-text"><span className="block w-[18px] border-t-2 border-dashed border-danger-text" />{costLabel(input.cost)}</span>
      </div>
      {/* The captions sit in the "?" rather than under every chart; the figure still points at them. */}
      <InfoTip label="About this chart">
        <span id={captionId} className="flex flex-col gap-1">{captions.map((caption) => <span key={caption}>{caption}</span>)}</span>
      </InfoTip>
    </div> : null}
  </figure>;
}
