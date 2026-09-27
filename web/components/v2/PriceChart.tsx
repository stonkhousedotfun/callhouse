"use client";

/**
 * The market page's "Price" view, with history.
 *
 * HISTORY. Candles of the market's registry pool, read through this app's own route (`/api/v2/price-history`, see
 * lib/v2/priceHistory.ts; the browser never calls the third party). Ranges 1D / 1W / 1M / 1Y map to 15-minute,
 * hourly, 4-hour and daily candles. The live oracle spot the page already polls is appended as the last point when
 * it is newer than the last candle. The caption says the data is delayed up to fifteen minutes, prints the newest
 * candle's time, and credits the source ("Data: GeckoTerminal"), as its terms require.
 *
 * FALLBACK, NEVER BLANK. While the history loads, and whenever it cannot be read, this draws what it drew before
 * The spot readings the page has received since it opened, labelled as such, with a line saying why there
 * is no history. A history that is older than its own candle width plus the fifteen-minute delay says so in the
 * caption instead of passing for current.
 *
 * `PriceChartView` is the pure part (history state and range in, markup out) and is what the tests render; the
 * `PriceChart` export owns the range state and the fetch, and keeps the props MarketPage already passes.
 */
import { useEffect, useState } from "react";

import { SegmentedControl } from "@/components/ui";
import { LineChart } from "@/components/v2/chart/LineChart";
import { downsample, type ChartPoint } from "@/components/v2/chart/chartMath";
import { cn } from "@/lib/cn";
import {
  PRICE_RANGES, RANGE_SPECS, toUsdg6, type Candle, type PriceHistoryBody, type PriceHistoryOk, type PriceRange,
} from "@/lib/v2/priceHistory";
import { useViewerTimeZone } from "@/components/ui/Time";
import { localStamp, NEW_YORK_TIME_ZONE } from "@/lib/v2/time";

export type SpotSample = { t: number; price: bigint };

export const PRICE_VIEW = { width: 820, height: 280, pad: 12 } as const;

/** SVG polyline points for `samples` in a PRICE_VIEW box, or null with fewer than two distinct times. */
export function priceLine(samples: readonly SpotSample[]): { points: string; last: { x: number; y: number } } | null {
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  if (sorted.length < 2 || sorted[0].t === sorted.at(-1)!.t) return null;
  const t0 = sorted[0].t;
  const span = sorted.at(-1)!.t - t0;
  let lo = sorted[0].price;
  let hi = sorted[0].price;
  for (const { price } of sorted) { if (price < lo) lo = price; if (price > hi) hi = price; }
  const { width, height, pad } = PRICE_VIEW;
  const range = hi - lo;
  const xy = ({ t, price }: SpotSample) => {
    const x = pad + ((t - t0) / span) * (width - 2 * pad);
    // A flat line sits mid-height rather than on an edge.
    const y = range === 0n ? height / 2 : pad + (1 - Number(price - lo) / Number(range)) * (height - 2 * pad);
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  };
  const coords = sorted.map(xy);
  return { points: coords.map(({ x, y }) => `${x},${y}`).join(" "), last: coords.at(-1)! };
}

/**
 * The points the history view draws: every candle's close at its open time, then the latest live spot sample when it
 * was observed after the last candle opened (an older print would draw a point out of order, so it is left out).
 */
export function historySamples(candles: readonly Candle[], live: readonly SpotSample[]): SpotSample[] {
  const points = candles.map((k) => ({ t: k.t, price: toUsdg6(k.c) }));
  const lastAt = candles.at(-1)?.t ?? -Infinity;
  const newest = [...live].sort((a, b) => a.t - b.t).at(-1);
  if (newest && newest.t > lastAt) points.push(newest);
  return points;
}

/** USDG 6-decimal samples as dollar points, sorted by time and downsampled for drawing. */
export function chartPoints(samples: readonly SpotSample[]): ChartPoint[] {
  const sorted = [...samples].sort((a, b) => a.t - b.t).map(({ t, price }) => ({ t, v: Number(price) / 1_000_000 }));
  return downsample(sorted);
}

/** The change readout's words for each range: plain language, no jargon. */
export const RANGE_WORDS: Record<PriceRange, string> = { "1D": "past day", "1W": "past week", "1M": "past month", "1Y": "past year" };

/** Fifteen minutes: the source's accepted delay. */
export const SOURCE_DELAY_S = 15 * 60;

/** Whether the newest candle is older than one candle width plus the source's delay at `fetchedAt`. */
export function isStale(body: Pick<PriceHistoryOk, "lastAt" | "fetchedAt" | "resolutionSec">): boolean {
  return body.fetchedAt - body.lastAt > body.resolutionSec + SOURCE_DELAY_S;
}

const CANDLE_LABEL: Record<PriceRange, string> = { "1D": "15-minute", "1W": "1-hour", "1M": "4-hour", "1Y": "daily" };


export type HistoryState =
  | { status: "loading" }
  | { status: "ok"; body: PriceHistoryOk }
  | { status: "error"; message: string };

/** The history state a route answer produces. */
export function historyStateOf(body: PriceHistoryBody | null, fallbackMessage: string): HistoryState {
  if (body?.ok) return { status: "ok", body };
  return { status: "error", message: body?.error ?? fallbackMessage };
}

export function PriceChartView({ ticker, samples, range, onRange, history, className, timeZone }: {
  ticker: string;
  samples: readonly SpotSample[];
  range: PriceRange;
  onRange: (range: PriceRange) => void;
  history: HistoryState;
  className?: string;
  /** For tests; the browser uses the viewer's own zone. */
  timeZone?: string;
}) {
  const ok = history.status === "ok" ? history.body : null;
  const historyPoints = ok ? historySamples(ok.candles, samples) : [];
  const drawn = ok && priceLine(historyPoints) ? chartPoints(historyPoints) : null;
  const session = drawn ? null : priceLine(samples) ? chartPoints(samples) : null;
  const first = ok?.candles[0];
  const lastClose = ok?.candles.at(-1)?.c;
  const change = first && lastClose ? (lastClose - first.o) / first.o : null;
  const why = history.status === "loading" ? "Loading price history…"
    : history.status === "error" ? `Price history is unavailable right now: ${history.message}` : null;

  return (
    <figure data-testid="price-chart" data-history={history.status} className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SegmentedControl label={`${ticker} price range`} selected={range} onSelect={onRange}
          options={PRICE_RANGES.map((value) => ({ value, label: value }))} />
        {change !== null ? <span data-slot="price-change"
          className={cn("text-[13px] font-bold", change >= 0 ? "text-accent-text" : "text-warn")}>
          {`${change >= 0 ? "+" : ""}${(change * 100).toFixed(2)}% ${RANGE_WORDS[range]}`}</span> : null}
      </div>
      {drawn ? <LineChart points={drawn} timeZone={timeZone} label={`${ticker} price, ${range}, ${CANDLE_LABEL[range]} candles`} />
        : session ? <LineChart points={session} timeZone={timeZone} label={`${ticker} spot since this page opened`} />
          : <div className="grid h-[220px] place-items-center rounded-lg border border-dashed border-line-2 px-6 text-center sm:h-[280px]">
            <p className="max-w-sm text-sm text-ink-3">{why ?? "No price points yet."} This view draws the live {ticker} spot as it
              updates while the page is open.</p>
          </div>}
      <figcaption className="text-xs text-ink-3">
        {ok ? <>
          {`Delayed up to 15 minutes · ${CANDLE_LABEL[range]} candles · last candle ${localStamp(ok.lastAt, timeZone ?? NEW_YORK_TIME_ZONE)}`}
          {isStale(ok) ? <b className="text-warn"> · no newer trade in the pool since then</b> : null}
          {" · Data: "}<a href={ok.sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">GeckoTerminal</a>
        </> : <>{why ? `${why} ` : ""}Live oracle spot since you opened this page. Not a trading chart.</>}
      </figcaption>
    </figure>
  );
}

export function PriceChart({ ticker, samples, className }: { ticker: string; samples: readonly SpotSample[]; className?: string }) {
  const zone = useViewerTimeZone();
  const [range, setRange] = useState<PriceRange>("1D");
  const [history, setHistory] = useState<{ key: string; state: HistoryState } | null>(null);
  const key = `${ticker}|${range}`;

  useEffect(() => {
    const controller = new AbortController();
    const url = `/api/v2/price-history?${new URLSearchParams({ ticker, range })}`;
    const load = () => fetch(url, { signal: controller.signal, headers: { accept: "application/json" } })
      .then(async (res) => historyStateOf(await res.json().catch(() => null), `the price route answered HTTP ${res.status}.`))
      .catch((): HistoryState => ({ status: "error", message: "the price route could not be reached." }))
      .then((state) => { if (!controller.signal.aborted) setHistory({ key, state }); });
    void load();
    // The route caches for three minutes; refreshing on that cadence keeps the 1D view within one candle.
    const timer = window.setInterval(() => void load(), RANGE_SPECS[range].resolutionSec >= 3_600 ? 600_000 : 180_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [key, ticker, range]);

  const state: HistoryState = history?.key === key ? history.state : { status: "loading" };
  return <PriceChartView ticker={ticker} samples={samples} range={range} onRange={setRange} history={state} className={className}
    timeZone={zone ?? NEW_YORK_TIME_ZONE} />;
}
