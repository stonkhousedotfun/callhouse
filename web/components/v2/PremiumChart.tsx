"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { Panel } from "@/components/ui";
import type { Trade } from "@/lib/v2/api-types";
import { formatShares } from "@/lib/v2/payoffCard";

type PremiumChartProps = {
  trades: Trade[];
  loading: boolean;
  error: boolean;
};

type ChartPoint = {
  trade: Trade;
  price: number;
  x: number;
  y: number;
};

const HEIGHT = 304;
const LEFT = 72;
const RIGHT = 20;
const TOP = 18;
const BOTTOM = 54;

const ET_TICK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const ET_DETAIL = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});

function time(seconds: number, detail = false): string {
  return (detail ? ET_DETAIL : ET_TICK).format(new Date(seconds * 1_000));
}

function priceNumber(trade: Trade): number {
  return Number(trade.price.raw) / 10 ** trade.price.decimals;
}

function axisPrice(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: value < 1 ? 4 : 2 }).format(value);
}

function selectedSentence(point: ChartPoint, latest: boolean): string {
  const side = point.trade.takerIsBuyer ? "Buyer took the ask" : "Seller took the bid";
  return `${latest ? "Latest" : "Selected"} trade: ${point.trade.price.formatted} USDG per share at ${time(point.trade.ts, true)}. ${formatShares(BigInt(point.trade.units))} shares. ${side}.`;
}

function chartPoints(trades: Trade[], width: number): {
  points: ChartPoint[];
  low: number;
  high: number;
} {
  const ordered = trades
    .map((trade, order) => ({ trade, order, price: priceNumber(trade) }))
    .filter(({ price }) => Number.isFinite(price))
    .sort((a, b) => a.trade.ts - b.trade.ts || a.order - b.order);

  if (ordered.length === 0) return { points: [], low: 0, high: 1 };

  const values = ordered.map(({ price }) => price);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const padding = Math.max((maximum - minimum) * 0.12, maximum * 0.04, 0.01);
  const low = Math.max(0, minimum - padding);
  const high = maximum + padding;
  const firstTime = ordered[0]!.trade.ts;
  const lastTime = ordered[ordered.length - 1]!.trade.ts;
  const plotWidth = Math.max(1, width - LEFT - RIGHT);
  const plotHeight = HEIGHT - TOP - BOTTOM;

  return {
    low,
    high,
    points: ordered.map(({ trade, price }, index) => {
      const timeRatio = lastTime === firstTime
        ? ordered.length === 1 ? 0.5 : index / (ordered.length - 1)
        : (trade.ts - firstTime) / (lastTime - firstTime);
      return {
        trade,
        price,
        x: LEFT + timeRatio * plotWidth,
        y: TOP + (high - price) / (high - low) * plotHeight,
      };
    }),
  };
}

export function PremiumChart({ trades, loading, error }: PremiumChartProps) {
  const headingId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.max(320, Math.round(entry.contentRect.width)));
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const { points, low, high } = chartPoints(trades, width);
  const selectedIndex = points.findIndex(({ trade }) => trade.id === selectedId);
  const effectiveIndex = selectedId && selectedIndex >= 0 ? selectedIndex : points.length - 1;
  const selected = points[effectiveIndex];

  if (points.length === 0) {
    return <Panel as="section" aria-labelledby={headingId}>
      <h2 id={headingId} className="font-display text-xl font-bold">Premium history</h2>
      <p className="mt-3 text-sm text-ink-2" role="status">
        {loading ? "Loading premium history…" : error ? "Premium history is temporarily unavailable." : "No trades recorded yet. The chart will appear after the first fill."}
      </p>
    </Panel>;
  }

  const plotBottom = HEIGHT - BOTTOM;
  const plotWidth = Math.max(1, width - LEFT - RIGHT);
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const areaLine = points.map((point) => `L ${point.x} ${point.y}`).join(" ");
  const area = `M ${points[0]!.x} ${plotBottom} ${areaLine} L ${points[points.length - 1]!.x} ${plotBottom} Z`;
  const yTicks = [high, (high + low) / 2, low];
  const xIndices = Array.from(new Set(width < 480
    ? [0, points.length - 1]
    : [0, Math.floor((points.length - 1) / 2), points.length - 1]));
  const latest = points[points.length - 1]!;
  const detail = selectedSentence(selected!, effectiveIndex === points.length - 1);
  const minimumTrade = points.reduce((best, point) => point.price < best.price ? point : best, points[0]!);
  const maximumTrade = points.reduce((best, point) => point.price > best.price ? point : best, points[0]!);

  function selectFromPointer(event: PointerEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const targetX = LEFT + Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * plotWidth;
    const nearest = points.reduce((best, point, index) =>
      Math.abs(point.x - targetX) < Math.abs(points[best]!.x - targetX) ? index : best, 0);
    setSelectedId(points[nearest]!.trade.id);
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    selectFromPointer(event);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    let next = effectiveIndex;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowUp": next += 1; break;
      case "ArrowLeft":
      case "ArrowDown": next -= 1; break;
      case "Home": next = 0; break;
      case "End": next = points.length - 1; break;
      default: return;
    }
    event.preventDefault();
    setSelectedId(points[Math.max(0, Math.min(points.length - 1, next))]!.trade.id);
  }

  return <Panel as="section" aria-labelledby={headingId}>
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <h2 id={headingId} className="font-display text-xl font-bold">Premium history</h2>
      <p className="num text-xs text-ink-3">{points.length} trade{points.length === 1 ? "" : "s"} · latest {latest.trade.price.formatted} USDG</p>
    </div>
    {error ? <p className="mt-2 text-xs text-ink-2" role="status">Live updates are unavailable. Showing saved trades.</p> : null}
    <figure className="mt-4 min-w-0">
      <div ref={containerRef} className="relative min-w-0">
        <svg
          viewBox={`0 0 ${width} ${HEIGHT}`}
          className="block h-[19rem] w-full"
          role="img"
          aria-labelledby={`${titleId} ${descriptionId}`}
          preserveAspectRatio="none"
        >
          <title id={titleId}>Option premium per share over time</title>
          <desc id={descriptionId}>{points.length} trades from {time(points[0]!.trade.ts, true)} to {time(latest.trade.ts, true)}. Prices range from {minimumTrade.trade.price.formatted} to {maximumTrade.trade.price.formatted} USDG per share.</desc>
          <rect x={LEFT} y={TOP} width={plotWidth} height={plotBottom - TOP} fill="var(--surface-2)" />
          {yTicks.map((tick, index) => {
            const y = TOP + index * (plotBottom - TOP) / 2;
            return <g key={tick}>
              <line x1={LEFT} x2={width - RIGHT} y1={y} y2={y} stroke="var(--line-2)" strokeWidth={1} />
              <text x={LEFT - 10} y={y + 4} textAnchor="end" fill="var(--ink-3)" fontSize={12}>{axisPrice(tick)}</text>
            </g>;
          })}
          <path d={area} fill="var(--accent-soft)" />
          <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {xIndices.map((index) => {
            const point = points[index]!;
            const anchor = index === 0 ? "start" : index === points.length - 1 ? "end" : "middle";
            return <g key={`${point.trade.id}:${index}`}>
              <line x1={point.x} x2={point.x} y1={plotBottom} y2={plotBottom + 5} stroke="var(--line-2)" />
              <text x={point.x} y={plotBottom + 20} textAnchor={anchor} fill="var(--ink-3)" fontSize={12}>{time(point.trade.ts)}</text>
            </g>;
          })}
          {/* The latest fill keeps a surface ring so it stays readable where it sits on the line. */}
          <circle cx={latest.x} cy={latest.y} r={5} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} vectorEffect="non-scaling-stroke" />
          <line x1={selected!.x} x2={selected!.x} y1={TOP} y2={plotBottom} stroke="var(--accent)" strokeWidth={1.5} opacity={0.75} />
          <circle cx={selected!.x} cy={selected!.y} r={7} fill="var(--surface)" stroke="var(--accent)" strokeWidth={3} vectorEffect="non-scaling-stroke" />
          <text x={LEFT + plotWidth / 2} y={HEIGHT - 5} textAnchor="middle" fill="var(--ink-3)" fontSize={12}>Trade time · New York</text>
          <text transform={`translate(17 ${TOP + (plotBottom - TOP) / 2}) rotate(-90)`} textAnchor="middle" fill="var(--ink-3)" fontSize={12}>USDG / share</text>
        </svg>
        {points.length > 1 ? <div
          role="slider"
          tabIndex={0}
          aria-label="Select a premium trade"
          aria-valuemin={1}
          aria-valuemax={points.length}
          aria-valuenow={effectiveIndex + 1}
          aria-valuetext={detail}
          onPointerDown={onPointerDown}
          onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) selectFromPointer(event); }}
          onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onPointerCancel={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
          onKeyDown={onKeyDown}
          className="absolute cursor-crosshair touch-none rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          style={{ left: LEFT, right: RIGHT, top: TOP, bottom: BOTTOM }}
        /> : null}
      </div>
      <figcaption className="mt-3">
        <p className="text-sm text-ink" aria-live="polite">{detail}</p>
        {points.length > 1 ? <p className="mt-1 text-xs text-ink-3">Tap or drag across the chart, or use arrow keys, to inspect a trade.</p> : null}
      </figcaption>
    </figure>
  </Panel>;
}
