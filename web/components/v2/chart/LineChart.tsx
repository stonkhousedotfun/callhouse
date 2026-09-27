"use client";

/**
 * The ticker page's line chart. One SVG plot with light gridlines, round price levels, time ticks, a clear
 * line with a soft area fill, and a crosshair: moving the pointer, dragging a finger, or pressing Left/Right while the
 * chart has focus puts a guide line and a dot on the nearest point and floats two labels, the DATE + HOUR under the
 * guide on the X axis and the PRICE beside the dot on the Y axis. Home/End jump to the ends; Escape clears.
 *
 * The SVG stretches to the box (`preserveAspectRatio="none"`, strokes non-scaling), so every piece of TEXT and the dot
 * are HTML placed by percentage over it: stretched SVG text would smear on a phone. Colours come from the theme
 * tokens, so night and day modes both work without a branch here.
 */
import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";

import { cn } from "@/lib/cn";

import {
  formatChartPrice, formatHoverTime, formatTimeTick, nearestIndex, niceTicks, ticksShowHours, timeTicks,
  type ChartPoint,
} from "./chartMath";

export const CHART_VIEW = { width: 820, height: 280, top: 14, bottom: 14 } as const;

export type Plot = {
  /** SVG x/y for each point, same order as the input. */
  xy: { x: number; y: number }[];
  yTicks: { v: number; y: number }[];
  xTicks: { t: number; x: number }[];
  hours: boolean;
};

/** Where everything goes in the CHART_VIEW box, or null with fewer than two distinct times. */
export function plotOf(points: readonly ChartPoint[]): Plot | null {
  if (points.length < 2 || points[0].t === points.at(-1)!.t) return null;
  const { width, height, top, bottom } = CHART_VIEW;
  const t0 = points[0].t;
  const t1 = points.at(-1)!.t;
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of points) { if (p.v < lo) lo = p.v; if (p.v > hi) hi = p.v; }
  const levels = niceTicks(lo, hi);
  const yLo = levels[0] ?? lo;
  const yHi = levels.at(-1) ?? hi;
  const ySpan = yHi - yLo || 1;
  const x = (t: number) => round1(((t - t0) / (t1 - t0)) * width);
  const y = (v: number) => round1(top + (1 - (v - yLo) / ySpan) * (height - top - bottom));
  return {
    xy: points.map((p) => ({ x: x(p.t), y: y(p.v) })),
    yTicks: levels.map((v) => ({ v, y: y(v) })),
    xTicks: timeTicks(t0, t1).map((t) => ({ t, x: x(t) })),
    hours: ticksShowHours(t0, t1),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

const pctX = (x: number) => `${(x / CHART_VIEW.width) * 100}%`;
const pctY = (y: number) => `${(y / CHART_VIEW.height) * 100}%`;

export function LineChart({ points, label, className, timeZone, initialActive = null }: {
  /** Sorted by time, already downsampled. */
  points: readonly ChartPoint[];
  label: string;
  className?: string;
  /** For tests; the browser uses the viewer's own zone. */
  timeZone?: string;
  /** For tests: render with the crosshair on this index. */
  initialActive?: number | null;
}) {
  const plot = useMemo(() => plotOf(points), [points]);
  const [active, setActive] = useState<number | null>(initialActive);
  const gradientId = useId().replace(/:/g, "");
  if (!plot) return null;

  const { width, height } = CHART_VIEW;
  const line = plot.xy.map(({ x, y }) => `${x},${y}`).join(" ");
  const area = `M${plot.xy[0].x},${height} L${line.replaceAll(" ", " L")} L${plot.xy.at(-1)!.x},${height} Z`;
  const last = plot.xy.at(-1)!;
  const shown = active !== null && active >= 0 && active < points.length ? active : null;

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    if (box.width <= 0) return;
    const frac = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const t = points[0].t + frac * (points.at(-1)!.t - points[0].t);
    setActive(nearestIndex(points, t));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = points.length;
    const from = shown ?? n - 1;
    const next = e.key === "ArrowLeft" ? Math.max(0, from - 1) : e.key === "ArrowRight" ? Math.min(n - 1, from + 1)
      : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : e.key === "Escape" ? null : undefined;
    if (next === undefined) return;
    e.preventDefault();
    setActive(next);
  };

  const readout = shown !== null
    ? `${formatHoverTime(points[shown].t, timeZone)}: ${formatChartPrice(points[shown].v)}`
    : `Latest ${formatChartPrice(points.at(-1)!.v)} at ${formatHoverTime(points.at(-1)!.t, timeZone)}`;

  return (
    <div className={cn("flex flex-col gap-1", className)} data-slot="line-chart">
      <div
        role="img"
        aria-label={label}
        aria-describedby={`${gradientId}-readout`}
        tabIndex={0}
        onPointerMove={pick}
        onPointerDown={pick}
        onPointerLeave={(e) => { if (e.pointerType === "mouse") setActive(null); }}
        onKeyDown={onKey}
        onBlur={() => setActive(null)}
        className="relative h-[220px] w-full touch-pan-y select-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] sm:h-[280px]"
      >
        <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="absolute inset-0 block h-full w-full" aria-hidden="true">
          <defs>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          {plot.yTicks.map(({ v, y }) => (
            <line key={`y${v}`} x1={0} x2={width} y1={y} y2={y} stroke="var(--line)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          ))}
          <path d={area} fill={`url(#${gradientId})`} stroke="none" />
          <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth={2.25} strokeLinejoin="round"
            strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          {shown !== null ? (
            <line data-slot="crosshair" x1={plot.xy[shown].x} x2={plot.xy[shown].x} y1={0} y2={height}
              stroke="var(--ink-3)" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
          ) : null}
        </svg>

        {plot.yTicks.map(({ v, y }) => (
          <span key={`yl${v}`} data-slot="y-tick" style={{ top: pctY(y) }}
            className="pointer-events-none absolute right-1 -translate-y-full pb-0.5 text-[11px] tabular-nums text-ink-3">
            {formatChartPrice(v)}
          </span>
        ))}

        {/* The last point, always; the crosshair's point while one is active. */}
        {(shown === null ? [last] : [plot.xy[shown]]).map(({ x, y }) => (
          <span key="dot" aria-hidden="true" style={{ left: pctX(x), top: pctY(y) }}
            className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-[var(--surface,white)] bg-[var(--accent)]" />
        ))}

        {shown !== null ? <>
          <span data-slot="crosshair-price" style={{ top: pctY(plot.xy[shown].y) }}
            className="pointer-events-none absolute left-1 -translate-y-1/2 rounded bg-[var(--ink)] px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-[var(--surface,white)]">
            {formatChartPrice(points[shown].v)}
          </span>
          <span data-slot="crosshair-time"
            style={{ left: `clamp(3.5rem, ${pctX(plot.xy[shown].x)}, calc(100% - 3.5rem))` }}
            className="pointer-events-none absolute bottom-0 -translate-x-1/2 translate-y-full whitespace-nowrap rounded bg-[var(--ink)] px-1.5 py-0.5 text-[11px] font-bold tabular-nums text-[var(--surface,white)]">
            {formatHoverTime(points[shown].t, timeZone)}
          </span>
        </> : null}
      </div>

      <div className="relative h-4 text-[11px] tabular-nums text-ink-3" aria-hidden="true">
        {plot.xTicks.map(({ t, x }) => (
          <span key={`xt${t}`} data-slot="x-tick" style={{ left: pctX(x) }}
            className={cn("absolute -translate-x-1/2 whitespace-nowrap", shown !== null && "opacity-0")}>
            {formatTimeTick(t, plot.hours, timeZone)}
          </span>
        ))}
      </div>
      <p id={`${gradientId}-readout`} className="sr-only" aria-live="polite">{readout}</p>
    </div>
  );
}
