"use client";

/**
 * The market page, in the Neon design (the Market screen, desktop, day and phone
 * layouts).
 *
 * LAYOUT (RailLayout): the main column carries the price hero, the Price | Payoff control (Payoff by
 * default), the chart, the day picker, Calls | Puts and the selectable strike rows. The rail carries the order summary
 * (size stepper, premium, capped fee, break-even, "At $X" bound to the chart handle, max loss as the largest number,
 * Review order, the settlement caveat). Below 1024px the rail stacks under the rows
 * and the max loss and Buy button ride in the sticky buy bar above the tab bar (components/TabBar.tsx).
 *
 * WHAT IS REAL. Spot, expiries, strikes, asks and ask depth come from /v2/markets and
 * /v2/markets/:ticker/series; fees from /v2/config. The API publishes no day change and no price history, so the hero
 * shows how fresh the spot is instead of a "+1.51% Today", and the Price view draws only the spot readings this page
 * has received (components/v2/PriceChart.tsx).
 *
 * THE RAIL IS A SUMMARY AT THE BEST ASK. Review order opens the series page's ticket (`?buy=1&shares=N`), which walks
 * every level, re-reads the orders on chain and takes the wallet steps. When the size is more than rests at the best
 * ask the rail says so rather than pretending the best-ask figure is the fill.
 *
 * ONE PAGE, TWO ROUTES. /[ticker]/[series] renders this same page with that series chosen (its day and side come from
 * the series itself), the series' book, trades and terms under the strike rows (SeriesDetails), and, on `?buy=1`, the
 * real TradeTicket in the rail in place of the summary (SeriesRail). The chart then follows the ticket's own quote and
 * the ticket shows "At $X" for the chart handle. Choosing another strike there keeps the address bar on that series.
 *
 * EMPTY STATE (spec 8.1). With no ask on any strike of the chosen day, the day picker and the chart stay: the chart is
 * drawn from the strike's last trade, or from an example labelled "Not a live quote", and the page says "No
 * asks for <day> yet" with a Sell options action (/sell/<ticker>, which was /earn/<ticker>).
 *
 * Multiples are "If +10%" / "If −10%" and, like the chart, BEFORE the exercise fee, because the
 * market series wire does not carry each series' pinned fee; both say so on the page.
 */
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";

import { SellTicket } from "@/components/v2/sell/SellTicket";
import { StickyBuyBar } from "@/components/TabBar";
import { Button, InfoTip, Notice, Panel, SegmentedControl, TickerLogo } from "@/components/ui";
import { useViewerTimeZone } from "@/components/ui/Time";
import { BuyStockWidget } from "@/components/v2/BuyStockWidget";
import { PayoffChart } from "@/components/v2/PayoffChart";
import { PriceChart, type SpotSample } from "@/components/v2/PriceChart";
import { SeriesDetails, SeriesRail, useSeriesRef } from "@/components/v2/SeriesPage";
import type { TicketQuote } from "@/components/v2/TradeTicket";
import { ExpiryChips } from "@/components/v2/trade/ExpiryChips";
import { contractName, expiryName, pctFrom, usd } from "@/components/v2/trade/price";
import { TicketHead } from "@/components/v2/trade/TicketParts";
import { changeText, useDayChange } from "@/components/v2/trade/useDayChange";
import { cn } from "@/lib/cn";
import { fmtUsd, fmtUsdPrice, fmtUsdPriceExact } from "@/lib/format";
import { getV2Market } from "@/lib/markets";
import { dayOptions, expiryDayLabel, noAsksHeading } from "@/lib/ui/dayPicker";
import { v2Api } from "@/lib/v2/api";
import { NEW_YORK_TIME_ZONE } from "@/lib/v2/time";
import type { Market, MarketSeriesResponse } from "@/lib/v2/api-types";
import { useConfig, useMarkets } from "@/lib/v2/hooks";
import { displaySourceLine, pickDisplaySpot, useDisplaySpots, type DisplaySpot } from "@/lib/v2/displaySpot";
import { PRICE_TICK, UNITS_PER_SHARE, premium, type TakerFeeParams } from "@/lib/v2/payoff";
import { chartDomain, costFromQuote, defaultHandlePrice, type ChartInput } from "@/lib/v2/payoffChart";
import { formatShares } from "@/lib/v2/payoffCard";
import {
  railSummary, stepShares, strikeRow, type RailSummary, type StrikeRow,
} from "@/lib/v2/ticket";
import { TRADING_PAUSED_LINE, tradingOpen } from "@/lib/v2/tradingGate";

export type LadderRow = MarketSeriesResponse["items"][number];

/**
 * PLAN gap 10, kept for the series page and anyone else who shows delta: the magnitude as a whole percent, labelled
 * a model estimate wherever it appears, never a probability of profit. The Neon market rows do not show delta.
 */
/**
 * The page's two prices, from one input, and they must never be swapped:
 *   - `trade`: the strict live spot (the API's, null when it has none). Every strike row, the chart source and the
 *     ticket read this, exactly as before.
 *   - `display`: what the hero SHOWS -- the same API spot when present, else the server's fallback (Chainlink, pool or
 *     last good price; lib/v2/displaySpot.ts). Never a trade or quote input.
 */
export function marketPageSpots(liveSpot: { raw: string } | null, spotUpdatedAt: number | null | undefined,
  fallback: DisplaySpot | undefined): { trade: bigint | null; display: DisplaySpot | null } {
  return { trade: liveSpot ? BigInt(liveSpot.raw) : null, display: pickDisplaySpot(liveSpot?.raw, spotUpdatedAt, fallback) };
}

/**
 * The hero's freshness line for a fallback price, in `timeZone` (the reader's, New York until it is known):
 * "Last close price, updated Sep 23, 1:59 PM EDT." Before the page's clock is set (`now` null) the age is
 * unknown, and displaySourceLine dates the line; it used to be measured against the price's own time, age 0, current.
 */
export function heroSourceLine(spot: DisplaySpot, now: number | null, timeZone: string): string {
  const line = displaySourceLine(spot, now ?? 0, timeZone);
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}.`;
}

export function formatDeltaChance(delta: number | null | undefined): string {
  if (delta === null || delta === undefined || !Number.isFinite(delta)) return "—";
  return `${Math.round(Math.abs(delta) * 100)}%`;
}

/** The series page's ticket for a row and size. `shares` is whole shares; the route validates it again. */
export function reviewHref(ticker: string, longId: string, shares: number): string {
  return `/${ticker.toLowerCase()}/${longId}?buy=1&shares=${shares}`;
}

/** The rail stepper's starting size from the route's `shares` (already validated there): whole shares, at least 1. */
export function initialStepperShares(shares: string | undefined): number {
  const value = Number(shares);
  return Number.isFinite(value) && value >= 1 ? stepShares(Math.floor(value), 0) : 1;
}

/**
 * The day and side the page shows: the reader's choice, else the route's series (/[ticker]/[series]), else the first
 * listed day and calls. A day that is not listed (an expired series, a stale link) falls back to the first listed day
 * rather than showing an empty picker.
 */
export function pageView(listed: readonly number[], chosen: { expiry: number | null; type: "call" | "put" | null },
  routeSeries: { expiry: number; isPut: boolean } | null, supportsPuts: boolean): { expiry: number | undefined; type: "call" | "put" } {
  const wanted = chosen.expiry ?? routeSeries?.expiry ?? null;
  const expiry = wanted !== null && listed.includes(wanted) ? wanted : listed[0];
  const type = supportsPuts ? chosen.type ?? (routeSeries?.isPut ? "put" : "call") : "call";
  return { expiry, type };
}

/**
 * The route's series the page may show. A put
 * series on a market whose registry flag is `puts: false` is NOT shown: no rail, ticket or details for it. The page
 * shows that market's calls instead, and the address bar moves to /[ticker], the calls view. Until both the series
 * and the market are known (`marketPuts` undefined), the route is kept as before, so a put link on a market that does
 * enable puts is never bounced while the markets load.
 */
export function shownRouteId(routeId: string | null, routeSeries: { isPut: boolean } | null,
  marketPuts: boolean | undefined): string | null {
  return routeId !== null && routeSeries?.isPut === true && marketPuts === false ? null : routeId;
}

/**
 * The route's series belongs to another market (`/spcx/<an NVDA id>`). Only puts were checked before, so the
 * page drew the other market's strike, book and terms under this market's name and spot (the ticket still refused to
 * trade it). Such a route is not shown: the page falls back to this market's own rows, as /[ticker] does.
 */
export function routeSeriesOnOtherMarket(routeSeries: { ticker: string } | null, ticker: string): boolean {
  return routeSeries !== null && routeSeries.ticker.toUpperCase() !== ticker.toUpperCase();
}

/**
 * The strike row's price cell. "No ask" only when there is no ask: a row whose asks add up to less than one share has
 * an ask (the rail quotes it), and a row without fee parameters (/config not loaded) has an unknown cost, not no ask.
 */
export function rowCostCell(row: Pick<StrikeRow, "ask" | "askUnits" | "costPerShare">): "cost" | "no-ask" | "under-one-share" | "unknown" {
  if (row.costPerShare !== null) return "cost";
  if (row.ask === null || row.ask <= 0n) return "no-ask";
  return row.askUnits < UNITS_PER_SHARE ? "under-one-share" : "unknown";
}

/**
 * Which row is chosen. The reader's pick when it is on screen; otherwise, on /[ticker], the first row with an ask (or
 * the first row). On /[ticker]/[series] the route's own series is NOT swapped for another strike while its row is off
 * screen (still loading, or on a day that is no longer listed): the rail keeps that series rather than a stranger.
 */
export function chooseRow(rows: readonly StrikeRow[], selectedId: string | null, routeId: string | null): StrikeRow | null {
  const picked = selectedId === null ? undefined : rows.find((row) => row.longId === selectedId);
  if (picked) return picked;
  if (routeId !== null && selectedId === routeId) return null;
  return rows.find((row) => row.ask !== null) ?? rows[0] ?? null;
}

/** The ticket's quote in the rail summary's shape, so the chart draws what the ticket is actually quoting. */
export function ticketSummary(quote: TicketQuote): RailSummary {
  return { units: quote.units, premium: quote.premium, fee: quote.cost - quote.premium, cost: quote.cost, breakEven: null,
    beyondBestAsk: false };
}

/** Spec 8.1's illustrative ticket: a 1.00 premium plus its capped fee, on a strike ~3% out of the money. */
const EXAMPLE_PREMIUM_PER_SHARE = 1_000_000n;

type ChartSource = { input: ChartInput; label: string | null };

/**
 * The route's own series while its row is off screen: /[ticker]/[series] on an expired-but-listed series,
 * or before its row loads. chooseRow deliberately returns null then rather than swap in a stranger, and the chart used
 * to fall back to an example strike at spot +3%, so the ticket said "Buy NVDA $230 call" over a chart of "$236.00 call".
 */
export type RouteChartSeries = { label: string; strike: bigint; isPut: boolean; expiry: number };

export function routeChartSeries(series: { strike: { raw: string; formatted: string }; isPut: boolean; expiry: number } | null):
  RouteChartSeries | null {
  if (!series) return null;
  // The strike row's label format ("$230 call", lib/v2/ticket.ts strikeRow), so the header reads like the ticket.
  return { label: `$${series.strike.formatted} ${series.isPut ? "put" : "call"}`, strike: BigInt(series.strike.raw),
    isPut: series.isPut, expiry: series.expiry };
}

/**
 * What the chart draws: the selected row at its best ask; else that row's last trade; else an example premium on the
 * route's own series when it is off screen (`routeSeries`), or on a strike near spot. The label is shown whenever the
 * curve is not a live quote.
 */
export function chartSource(ticker: string, row: StrikeRow | null, lastPerShare: bigint | null, summary: RailSummary | null,
  units: bigint, spot: bigint | null, fees: TakerFeeParams | null, now: number | null,
  routeSeries: RouteChartSeries | null = null): ChartSource | null {
  if (row && summary) {
    return { label: null, input: { ticker, isPut: row.isPut, strike: row.strike, units, spot, cost: summary.cost,
      premium: summary.premium, exerciseFeeBps: null, expiry: row.expiry, now } };
  }
  if (row && lastPerShare !== null && lastPerShare > 0n && fees) {
    const paid = premium(lastPerShare, units);
    return { label: "Last trade, not a live quote", input: { ticker, isPut: row.isPut, strike: row.strike, units, spot,
      cost: costFromQuote(paid, fees), premium: null, exerciseFeeBps: null, expiry: null, now: null } };
  }
  if (!fees || spot === null || spot <= 0n) return null;
  const isPut = row?.isPut ?? routeSeries?.isPut ?? false;
  const strike = row?.strike ?? routeSeries?.strike ?? ((spot * 103n) / 100n + 999_999n) / 1_000_000n * 1_000_000n;
  const paid = (EXAMPLE_PREMIUM_PER_SHARE * units) / UNITS_PER_SHARE;
  // No "example" framing in visible copy; the label still says the curve is not a live quote.
  return { label: "Not a live quote", input: { ticker, isPut, strike, units, spot,
    cost: costFromQuote(paid, fees), premium: null, exerciseFeeBps: null, expiry: null, now: null } };
}

/**
 * The chart header: the series named, then "N sh · <day> · option value by price". The picker's day label belongs to the
 * picker's day, so the route's series carries its OWN day when its expiry differs -- "$230 call · 1 sh ·
 * Wed 23", never "· Fri 25" beside a series that expired on the 23rd.
 */
export function chartHeading({ row, routeSeries, source, shares, dayLabel, selectedExpiry, now }: {
  row: StrikeRow | null;
  routeSeries: RouteChartSeries | null;
  source: ChartSource;
  shares: string;
  dayLabel: string | null;
  selectedExpiry: number | undefined;
  now: number | null;
}): { name: string; detail: string } {
  const name = row ? row.label : routeSeries ? routeSeries.label
    : `Example ${fmtUsd(source.input.strike)} ${source.input.isPut ? "put" : "call"}`;
  const day = row || !routeSeries ? dayLabel
    : routeSeries.expiry === selectedExpiry ? dayLabel : expiryDayLabel(routeSeries.expiry, now);
  return { name, detail: ` · ${shares} sh${day ? ` · ${day}` : ""} · option value by price` };
}

export type ChainQuote = { bid: bigint | null; fair: bigint | null; askDepth: bigint; bidDepth: bigint };

export function chainQuotes(items: readonly LadderRow[]): ReadonlyMap<string, ChainQuote> {
  return new Map(items.map((item) => [item.series.longId, {
    bid: item.quote.bestBid ? BigInt(item.quote.bestBid.raw) : null,
    fair: item.quote.fair ? BigInt(item.quote.fair.raw) : null,
    askDepth: BigInt(item.quote.askUnits),
    bidDepth: BigInt(item.quote.bidUnits),
  }]));
}

export function sharePriceIndex(rows: readonly Pick<StrikeRow, "strike">[], spot: bigint | null): number {
  if (spot === null || spot <= 0n) return -1;
  const at = rows.findIndex((row) => row.strike > spot);
  return at === -1 ? rows.length : at;
}

export function chainBreakEven(row: StrikeRow, fair: bigint | null, fees: TakerFeeParams | null): bigint | null {
  if (row.breakEven !== null) return row.breakEven;
  // premium() throws off the order tick, and the fair value is not on it.
  const price = row.ask !== null && row.ask > 0n ? row.ask : fair !== null ? (fair / PRICE_TICK) * PRICE_TICK : null;
  if (price === null || price <= 0n || !fees) return null;
  try { return railSummary({ ...row, ask: price }, UNITS_PER_SHARE, fees)?.breakEven ?? null; } catch { return null; }
}

/** The selectable strike rows (drawn as cards on a phone). */
export function StrikeRows({ rows, selected, onSelect, side = "buy", quotes, spot = null, fees = null, ticker = "" }: {
  rows: readonly StrikeRow[];
  selected: string | null;
  onSelect: (longId: string) => void;
  side?: "buy" | "sell";
  quotes?: ReadonlyMap<string, ChainQuote>;
  spot?: bigint | null;
  fees?: TakerFeeParams | null;
  ticker?: string;
}) {
  const divider = sharePriceIndex(rows, spot);
  const line = spot !== null && divider >= 0 ? <li key="share-price" data-slot="share-price" aria-label={`Share price ${fmtUsdPrice(spot)}`}
    className="flex items-center gap-3 border-b border-line bg-field px-4 py-1.5 text-[12.5px] font-semibold text-ink-2 sm:px-[18px]">
    <span aria-hidden="true" className="h-px flex-1 bg-accent/60" />
    <span className="shrink-0">Share price <span className="num">{fmtUsdPrice(spot)}</span></span>
    <span aria-hidden="true" className="h-px flex-1 bg-accent/60" />
  </li> : null;
  const body = "flex w-full min-h-11 items-center justify-between gap-4 px-4 py-3.5 text-left transition-colors sm:px-[18px] focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-accent/40";
  return <ul className="grid" aria-label="Strikes" data-side={side}>
    {rows.flatMap((row, index) => {
      const on = row.longId === selected;
      const quote = quotes?.get(row.longId);
      const fair = quote?.fair ?? null;
      const name = <b className="text-[17px] tracking-[-0.01em] text-ink"><span className="num font-semibold">{row.label.replace(/ (call|put)$/, "")}</span> {row.isPut ? "Put" : "Call"}</b>;
      const out: ReactNode[] = index === divider && line ? [line] : [];
      if (side === "sell") {
        const away = pctFrom(row.strike, spot);
        out.push(<li key={row.longId} className="border-b border-line last:border-b-0">
          <button type="button" aria-pressed={on} aria-label={`Sell ${ticker} ${row.label}`} data-long-id={row.longId}
            onClick={() => onSelect(row.longId)} className={cn(body, on ? "bg-accent-soft" : "hover:bg-field")}>
            <span className="grid min-w-0 gap-0.5">
              {name}
              <span className="text-[13px] text-ink-3">{away ? <><span className="num">{away}</span> vs share price</> : "Sell a call at this strike"}</span>
            </span>
            <span className="grid shrink-0 justify-items-end gap-1">
              <PricePill price={fair} round="down" selected={on} />
              <span className="text-[11.5px] text-ink-3">Mark</span>
            </span>
          </button>
        </li>);
        return out;
      }
      const cell = rowCostCell(row);
      const hasAsk = row.ask !== null && row.ask > 0n;
      const shown = hasAsk ? row.ask : fair;
      const be = chainBreakEven(row, fair, fees);
      const toBe = be !== null ? pctFrom(be, spot) : null;
      out.push(<li key={row.longId} className="border-b border-line last:border-b-0">
        <button type="button" aria-pressed={on} data-long-id={row.longId} onClick={() => onSelect(row.longId)}
          className={cn(body, on ? "bg-accent-soft" : "hover:bg-field")}>
          <span className="grid min-w-0 gap-0.5">
            {name}
            <span className="text-[13px] text-ink-3">Breakeven <span className="num">{toBe ?? "—"}</span></span>
          </span>
          <span className="grid shrink-0 justify-items-end gap-1">
            <PricePill price={shown} exact={hasAsk} selected={on} />
            <span className="text-[11.5px] text-ink-3">{cell === "no-ask" ? fair !== null ? "Est." : "No ask"
              : <><span className="num">{formatShares(quote?.askDepth ?? row.askUnits)} sh</span> for sale</>}</span>
          </span>
        </button>
      </li>);
      return out;
    })}
    {divider === rows.length && line ? line : null}
  </ul>;
}

/**
 * A strike row's price bubble. `exact` is for a price the book trades at, the best ask: every digit at the
 * 0.0001 USDG tick (fmtUsdPriceExact), so two asks within a cent read apart and none reads cheaper or dearer than it
 * is. Without it the bubble shows a model value (the fair estimate) rounded to the cent in `round`'s direction: up for a
 * buyer's "Est.", down for a seller's mark, so neither side is shown a better price than the model gives.
 */
function PricePill({ price, selected = false, round = "up", exact = false }: { price: bigint | null; selected?: boolean; round?: "up" | "down"; exact?: boolean }) {
  return <span data-slot="price" className={cn("num inline-flex min-w-[76px] justify-center rounded-pill border-[1.5px] px-3 py-1.5 text-[14.5px] font-semibold sm:min-w-[84px]",
    price === null ? "border-line-2 text-ink-3" : selected ? "border-accent bg-accent text-accent-ink" : "border-accent/60 text-accent-text")}>
    {price === null ? "—" : exact ? fmtUsdPriceExact(price) : usd(price, 6, round)}
  </span>;
}

type ChartView = "payoff" | "price";

/** Below Tailwind's `sm` (640px) the market page draws the compact chart. False on the server. */
const PHONE_QUERY = "(max-width: 639.98px)";
function subscribePhone(onChange: () => void): () => void {
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
function usePhone(): boolean {
  return useSyncExternalStore(subscribePhone, () => window.matchMedia(PHONE_QUERY).matches, () => false);
}

export function MarketPage({ ticker, longId, initialShares, openTicket = false, embedded = false }: {
  ticker: string;
  embedded?: boolean;
  /** /[ticker]/[series]: the route's series, chosen on arrival. */
  longId?: string;
  /** The route's validated `shares`. */
  initialShares?: string;
  /** The route's `?buy=1`: the real ticket replaces the rail summary. */
  openTicket?: boolean;
}) {
  const requestedId = longId ?? null;
  const routeSeries = useSeriesRef(longId);
  const [expiry, setExpiry] = useState<number | null>(null);
  const [type, setType] = useState<"call" | "put" | null>(null);
  const [chartView, setChartView] = useState<ChartView>("payoff");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [sheetOpen, setSheetOpen] = useState(openTicket);
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setSheetOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);
  const [selectedId, setSelectedId] = useState<string | null>(requestedId);
  const [shares, setShares] = useState(() => initialStepperShares(initialShares));
  const [handle, setHandle] = useState<{ key: string; price: bigint } | null>(null);
  const [samples, setSamples] = useState<SpotSample[]>([]);
  const [ticketQuote, setTicketQuote] = useState<TicketQuote | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const phone = usePhone();
  const viewerZone = useViewerTimeZone();
  useEffect(() => { const tick = () => setNow(Math.floor(Date.now() / 1000)); tick();
    const timer = window.setInterval(tick, 1_000); return () => window.clearInterval(timer); }, []);

  const markets = useMarkets();
  const config = useConfig();
  const market = markets.data?.find((item) => item.ticker === ticker);
  const supportsPuts = market?.puts === true;
  // A put link on a market without puts lands on that market's calls view. The flag is the indexer's, or the
  // compiled registry's while the market list is loading or unavailable, so a resolved put series is never shown on a
  // market whose registry says puts: false merely because /markets failed.
  // A series of another market is not shown here either; the address bar moves to this market's calls view.
  const foreignRoute = routeSeriesOnOtherMarket(routeSeries, ticker);
  const routeId = foreignRoute ? null : shownRouteId(requestedId, routeSeries, market?.puts ?? getV2Market(ticker)?.v2.puts);
  const routeHidden = requestedId !== null && routeId === null;
  useEffect(() => {
    if (!routeHidden) return;
    const path = `/${ticker.toLowerCase()}`;
    if (window.location.pathname !== path) window.history.replaceState(null, "", path);
  }, [ticker, routeHidden]);
  // A day past its mint cutoff still trades resale asks and bids until expiry, so it stays in the
  // picker, marked resale-only; `expiries` alone is only the days a writer can still mint on.
  const cutoffDays = market?.cutoffExpiries ?? [];
  const listedDays = [...(market?.expiries ?? []), ...cutoffDays];
  const days = now === null ? [] : dayOptions(listedDays, now, undefined, cutoffDays);
  const view = pageView(days.map((day) => day.expiry), { expiry, type }, foreignRoute ? null : routeSeries, supportsPuts);
  const activeType = view.type;
  const selectedExpiry = view.expiry;
  const dayLabel = days.find((day) => day.expiry === selectedExpiry)?.label ?? null;
  const chipDay = selectedExpiry === undefined || dayLabel === "Today" ? dayLabel : expiryName(selectedExpiry);

  const series = useInfiniteQuery({
    queryKey: ["v2", "marketSeriesInfinite", ticker, activeType, selectedExpiry],
    queryFn: ({ pageParam, signal }) => v2Api.getMarketSeries(ticker,
      { type: activeType, expiry: selectedExpiry, limit: 50, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: selectedExpiry !== undefined,
    staleTime: 15_000,
    refetchInterval: 15_000,
  });

  const liveSpot = markets.isError ? null : market?.spot ?? null;
  // DISPLAY ONLY: the hero shows a price whenever anything has one (API, else Chainlink, pool or the server's
  // last good price, lib/v2/displaySpot.ts), with its age. `spot` stays the strict live spot and is the only one the
  // rows, the chart source and the ticket ever see ({marketPageSpots}).
  const displaySpots = useDisplaySpots();
  const { trade: spot, display: heroSpot } = marketPageSpots(liveSpot, market?.spotUpdatedAt, displaySpots.data?.get(ticker));
  // Record each new spot reading for the Price view as it arrives (during render: it is derived from the query).
  const reading = market?.spot && market.spotUpdatedAt != null ? { t: market.spotUpdatedAt, price: BigInt(market.spot.raw) } : null;
  if (reading && !samples.some((sample) => sample.t === reading.t)) setSamples([...samples, reading].slice(-240));

  const fees: TakerFeeParams | null = config.data
    ? { takerFeeFlat: BigInt(config.data.fees.takerFeeFlat.raw), takerFeeCapBps: config.data.fees.takerFeeCapBps } : null;
  const items = [...new Map((series.data?.pages.flatMap((page) => page.items) ?? [])
    .map((item) => [item.series.longId, item])).values()]
    .filter((item) => item.series.expiry === selectedExpiry && item.series.isPut === (activeType === "put"))
    .sort((a, b) => (BigInt(a.series.strike.raw) < BigInt(b.series.strike.raw) ? -1 : 1));
  const rows = items.map((item) => strikeRow(item, fees, spot));
  const anyAsk = rows.some((row) => row.ask !== null);
  const selected = chooseRow(rows, selectedId, routeId);
  // The series whose ticket and activity the page shows: the chosen row, or the route's series while its row is off
  // screen. Only /[ticker]/[series] has either.
  const seriesId = routeId === null ? null : selected?.longId ?? (selectedId === routeId ? routeId : null);
  const ticketId = routeId === null ? selected?.longId ?? null : seriesId;
  const lastPerShare = selected ? (() => {
    const last = items.find((item) => item.series.longId === selected.longId)?.quote.last;
    return last ? BigInt(last.raw) : null;
  })() : null;
  // The ticket names the series it quoted, so a quote from the previous strike never draws on the new one.
  const bound = ticketId !== null && selected?.longId === ticketId && ticketQuote?.longId === ticketId ? ticketQuote : null;
  const units = bound ? bound.units : BigInt(shares) * UNITS_PER_SHARE;
  const summary = bound ? ticketSummary(bound) : selected ? railSummary(selected, units, fees) : null;
  // The route's series, when chooseRow kept it rather than swap in another row: the chart then plots ITS strike and side.
  const offScreenRoute = selected === null && routeId !== null && selectedId === routeId ? routeChartSeries(routeSeries) : null;
  const source = chartSource(ticker, selected, lastPerShare, summary, units, spot, fees, now, offScreenRoute);
  const heading = source ? chartHeading({ row: selected, routeSeries: offScreenRoute, source,
    shares: bound ? formatShares(bound.units) : String(shares), dayLabel: chipDay, selectedExpiry, now }) : null;
  // Keep the address bar on the series the page is showing, so a copied link opens the same strike.
  const shownId = routeId === null ? null : selected?.longId ?? null;
  useEffect(() => {
    if (shownId === null) return;
    const path = `/${ticker.toLowerCase()}/${shownId}`;
    if (window.location.pathname !== path) window.history.replaceState(null, "", `${path}${window.location.search}`);
  }, [ticker, shownId]);
  const handleKey = source ? `${source.input.isPut}:${source.input.strike}:${spot === null}` : "";
  const atPrice = source ? (handle?.key === handleKey ? handle.price
    : defaultHandlePrice(source.input, chartDomain(source.input.isPut, source.input.strike, source.input.spot))) : null;
  const typeWord = activeType === "put" ? "Puts" : "Calls";
  const dayChange = useDayChange(ticker);
  const quotes = chainQuotes(items);

  const pick = (longId: string) => { setSelectedId(longId); setSheetOpen(true); };
  const main = <div className="flex flex-col gap-5">
    {!embedded ? <>
    <header className="flex flex-col gap-2" data-slot="market-hero">
      <p className="flex min-w-0 items-center gap-2 text-[15px]">
        <TickerLogo ticker={ticker} className="text-[20px]" />
        <span className="font-extrabold text-ink">{ticker}</span>
        <span className="truncate font-medium text-ink-3">{market ? market.name : `${ticker} Stock Token`}</span>
      </p>
      <h1 className="font-display text-[46px] font-extrabold leading-none tracking-[-0.045em] sm:text-[60px]" data-slot="price-hero">
        {heroSpot !== null ? fmtUsdPrice(heroSpot.raw) : markets.isPending || displaySpots.isPending ? "…" : "Unavailable"}
      </h1>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold text-ink-3 sm:text-[14px]">
        {dayChange !== null ? <span data-slot="day-change" className={cn("num", dayChange >= 0 ? "text-accent-text" : "text-danger-text")}>
          {changeText(dayChange)} <span className="font-body font-semibold text-ink-3">past day</span>
          <InfoTip className="ml-1.5" label="About the day change" text="From the Stock Token's pool price over the past day, delayed up to 15 minutes. The share price above is the live oracle price." /></span> : null}
        {liveSpot ? null : <span className="flex items-center gap-2">
          <span aria-hidden="true" className="size-2 shrink-0 rounded-pill bg-warn" />
          {heroSpot !== null ? heroSourceLine(heroSpot, now, viewerZone ?? NEW_YORK_TIME_ZONE) : "Live price unavailable."}</span>}</p>
    </header>

    </> : null}
    {markets.isError ? <Notice tone="warn" role="status">Market data is unavailable.{markets.data
      ? " Showing the last loaded prices, which may be delayed." : ""}
      <Button size="xs" variant="ghost" className="ml-2" disabled={markets.isFetching}
        onClick={() => void markets.refetch()}>{markets.isFetching ? "Retrying…" : "Retry market data"}</Button>
    </Notice> : null}
    {/* The page says it whatever the ticket does. A chosen strike binds a ticket, and below
        1024px that ticket sits in a shut sheet while the sticky Buy bar shows, so the ticket's own line (beside its
        shut button) cannot be the only one. */}
    <TradingPausedNotice market={market} />

    {!embedded ? <>
    <Panel as="section" pad="sm" aria-label="Chart" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        {chartView === "payoff" && source && heading ? <div className="min-w-0 text-[13px] text-ink-3">
          <p><b className="text-ink">{contractName(heading.name)}</b>{heading.detail}</p>
          {source.label ? <p data-slot="chart-label" className="mt-0.5 font-bold text-warn">{source.label}</p>
            : <p className="mt-0.5 max-sm:hidden">Drag the chart to test a price</p>}
        </div> : <p className="text-[13px] font-semibold text-ink">{chartView === "price" ? `${ticker} price` : "Payoff"}</p>}
        <SegmentedControl label="Chart view" selected={chartView} onSelect={setChartView}
          options={[{ value: "price", label: "Price" }, { value: "payoff", label: "Payoff" }] as const} />
      </div>
      {chartView === "price" ? <PriceChart ticker={ticker} samples={samples} /> : source && heading
        ? <PayoffChart input={source.input} variant={phone ? "compact" : "large"} price={atPrice ?? undefined}
          onPriceChange={(price) => setHandle({ key: handleKey, price })} />
        : <p className="grid h-[180px] place-items-center rounded-md border border-dashed border-line-2 text-sm text-ink-3 sm:h-[240px]">
          {markets.isPending || config.isPending ? "Loading the payoff…" : "Payoff unavailable right now."}</p>}
    </Panel>

    </> : null}

    <section aria-labelledby="chain-title" data-slot="option-chain" className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="chain-title" className="flex items-center gap-2 font-display text-[26px] font-extrabold tracking-[-0.03em]">{typeWord} <InfoTip align="start" label="About buying and selling"
          text={`Buy a ${activeType}: you pay the premium, which is your max loss. Sell: list a covered call on your ${ticker} Stock Tokens and collect the premium.`} /></h2>
        <div className="flex flex-wrap items-center gap-2.5">
          {supportsPuts ? <SegmentedControl label="Option type" selected={activeType}
            options={[{ value: "call", label: "Calls" }, { value: "put", label: "Puts" }] as const}
            onSelect={(kind) => { setType(kind); setSelectedId(null); }} /> : null}
          <SegmentedControl label="Buy or sell" selected={side} onSelect={setSide}
            options={[{ value: "buy", label: "Buy" }, { value: "sell", label: "Sell" }] as const} />
        </div>
      </div>
      {days.length > 0 && now !== null ? <ExpiryChips expiries={listedDays} resaleOnly={cutoffDays} now={now}
        selected={selectedExpiry ?? null} onSelect={(next) => { setExpiry(next); setSelectedId(null); }} /> : null}

      {series.isError ? <Notice tone="warn" role="status" title="Strikes are delayed.">
        {series.data ? "Showing the last ones loaded." : null}
        <Button size="xs" variant="ghost" className="ml-2" onClick={() => void series.refetch()}>Retry</Button>
      </Notice> : null}

      {/* Before the clock is read there are no days yet, which is not "no expiries". */}
      {(!market && markets.isPending) || (selectedExpiry === undefined && now === null) ? <ChainLoading />
        : selectedExpiry === undefined ? markets.isError
          ? <p className="text-ink-2">Expiries are unavailable. Try again shortly.</p>
          : <NoExpiries ticker={ticker} />
        : series.isPending && !series.data ? <ChainLoading />
        : rows.length === 0 ? series.isError ? null : <EmptyAsks ticker={ticker} dayLabel={dayLabel} typeWord={typeWord} listed={false} />
        : <>
          {side === "buy" && !anyAsk ? <EmptyAsks ticker={ticker} dayLabel={dayLabel} typeWord={typeWord} listed onSell={() => setSide("sell")} /> : null}
          <div className="overflow-hidden rounded-md border border-line-2 bg-surface-2">
            <div aria-hidden="true" className="flex justify-between border-b border-line px-4 py-2 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3 sm:px-[18px]">
              <span>Strike</span><span>{side === "buy" ? "Price / share" : "Mark / share"}</span>
            </div>
            <StrikeRows rows={rows} selected={selected?.longId ?? null} onSelect={pick}
              side={side} quotes={quotes} spot={heroSpot?.raw ?? null} fees={fees} ticker={ticker} />
          </div>
          <p className="text-[12.5px] text-ink-3">{side === "buy"
            ? "Prices are per share, paid in USDG. Est. means nobody is selling that strike yet: your order waits as a bid."
            : "Mark is the fair estimate per share, in USDG. You set your own price; your ask waits for a buyer."}</p>
        </>}
      {series.hasNextPage ? <Button size="sm" variant="ghost" className="self-start" disabled={series.isFetchingNextPage}
        onClick={() => void series.fetchNextPage()}>{series.isFetchingNextPage ? "Loading strikes…" : "Load more strikes"}</Button> : null}
    </section>
    {seriesId !== null && !embedded ? <SeriesDetails key={seriesId} ticker={ticker} longId={seriesId} /> : null}
  </div>;

  const ticket = ticketId !== null ? <SeriesRail ticker={ticker} longId={ticketId} openTicket={openTicket}
    initialShares={ticketId === routeId ? initialShares : undefined} atPrice={atPrice} onQuote={setTicketQuote} />
    : <Panel pad="sm"><p className="text-sm text-ink-3">Pick a strike to start an order.</p></Panel>;
  const sellItem = selected ? items.find((item) => item.series.longId === selected.longId) ?? null : null;
  const sellTicket = sellItem ? <div className="grid gap-3">
    <SellTicket key={sellItem.series.longId} ticker={ticker} row={sellItem} expiry={sellItem.series.expiry} />
    <Link href={`/sell/${ticker.toLowerCase()}`} className="text-center text-[13.5px] font-bold text-accent-text no-underline hover:underline">Sell one every day with auto-roll →</Link>
  </div> : <Panel pad="sm"><p className="text-sm text-ink-3">Pick a strike to sell a call.</p></Panel>;
  const rail = <>
    {sheetOpen ? <button type="button" aria-label="Close the order" className="fixed inset-0 z-40 bg-ground/70 backdrop-blur-[2px] lg:hidden"
      onClick={() => setSheetOpen(false)} /> : null}
    <div data-slot="ticket-sheet" data-open={sheetOpen ? "true" : "false"} className={cn("flex flex-col gap-4 lg:sticky lg:top-6",
      "max-lg:fixed max-lg:inset-x-0 max-lg:bottom-0 max-lg:z-50 max-lg:max-h-[88dvh] max-lg:overflow-y-auto max-lg:transition-transform max-lg:duration-200",
      "max-lg:[&_#ticket]:rounded-b-none max-lg:[&_#ticket]:border-b-0 max-lg:[&_#ticket]:pb-[calc(18px+env(safe-area-inset-bottom))]",
      "max-lg:[&_#sell-ticket]:rounded-b-none max-lg:[&_#sell-ticket]:border-b-0 max-lg:[&_#sell-ticket]:pb-[calc(18px+env(safe-area-inset-bottom))]",
      sheetOpen ? "max-lg:translate-y-0" : "max-lg:pointer-events-none max-lg:translate-y-[105%]")}>
      <button type="button" aria-label="Close" onClick={() => setSheetOpen(false)}
        className="absolute right-3 top-3 z-10 grid size-10 place-items-center rounded-pill border border-line-2 bg-surface-2 text-ink-2 lg:hidden">✕</button>
      {side === "sell" ? sellTicket : ticket}
    </div>
  </>;

  return <>
    {/* Not RailLayout: its fixed 820px main column squeezes the rail to under 160px below 1280px wide. */}
    <div className={cn("grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(340px,380px)] lg:gap-10", !embedded && "pt-6 sm:pt-8")}>
      <div data-slot="main-column" className="min-w-0">{main}</div>
      <aside data-slot="rail" aria-label="Order ticket" className="min-w-0">
        {rail}
        <div className="mt-4 flex flex-col gap-4">
          {/* renders only for a connected wallet that holds none of this stock. */}
          <BuyStockWidget ticker={ticker} />
        </div>
      </aside>
    </div>
    {selected && side === "sell" && !sheetOpen ? <StickyBuyBar height={64}>
      <Button onClick={() => setSheetOpen(true)} className="w-full">Sell {contractName(selected.label)}</Button>
    </StickyBuyBar> : null}
    {selected && summary && side === "buy" && !sheetOpen ? <StickyBuyBar height={96}>
      <div className="flex flex-col gap-2">
        <div className="flex justify-between gap-3 text-[13px]"><span className="text-ink-3">{bound ? formatShares(bound.units) : shares} sh · max loss</span>
          <span className="num font-extrabold">{usd(summary.cost, 6, "up")}</span></div>
        <Button onClick={() => setSheetOpen(true)} className="w-full">Buy {contractName(selected.label)}</Button>
      </div>
    </StickyBuyBar> : null}
  </>;
}

function ChainLoading() {
  return <div role="status" aria-label="Loading strikes" className="grid gap-2 px-[18px] pb-5 sm:px-[22px]">
    {[0, 1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-surface-2" />)}
  </div>;
}

/**
 * The OrderBook's trading brake, said on the page itself and not only under a shut button.
 * Shown only on an explicit brake from /v2/markets (`tradingOpen`): an unread list is not a pause here either.
 */
export function TradingPausedNotice({ market }: { market: Pick<Market, "tradingPaused"> | null | undefined }) {
  if (tradingOpen(market)) return null;
  return <div data-slot="trading-paused-notice"><Notice tone="warn" role="status">{TRADING_PAUSED_LINE}</Notice></div>;
}

/** Spec 8.1: no asks for the chosen day. The day picker and chart stay; this says so and offers Earn. */
export function EmptyAsks({ ticker, dayLabel, typeWord, listed, onSell }: { ticker: string; dayLabel: string | null; typeWord: string; listed: boolean; onSell?: () => void }) {
  return <div data-slot="empty-asks" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed border-line-2 bg-field px-4 py-3.5">
    <div className="min-w-0">
      <p className="font-bold text-ink">{noAsksHeading(dayLabel, "No asks for this day yet")}</p>
      <p className="text-sm text-ink-3">{listed
        ? `${ticker} ${typeWord.toLowerCase()} are listed, but no one is selling yet.`
        : `No ${ticker} ${typeWord.toLowerCase()} are listed for this day.`}</p>
    </div>
    <EmptyActions ticker={ticker} onSell={onSell} />
  </div>;
}

/** Spec 8.1's two ways out of an empty book: be told when it fills, or be the seller. */
function EmptyActions({ ticker, onSell }: { ticker: string; onSell?: () => void }) {
  return <div className="flex flex-wrap gap-2">
    <Button size="sm" variant="secondary" href="/settings/notifications">Get notified</Button>
    {onSell ? <Button size="sm" variant="ghost" onClick={onSell}>Sell options</Button>
      : <Button size="sm" variant="ghost" href={`/sell/${ticker.toLowerCase()}`}>Sell options</Button>}
  </div>;
}

/**
 * Spec 8.1: nothing is listed for this market at all, so there is no day to pick. It used to be a bare
 * sentence with no way forward; it now offers the same two actions as a day with no asks.
 */
export function NoExpiries({ ticker }: { ticker: string }) {
  return <div data-slot="no-expiries" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed border-line-2 bg-field px-4 py-3.5">
    <div className="min-w-0">
      <p className="font-bold text-ink">No expiries are open for {ticker} yet</p>
      <p className="text-sm text-ink-3">Get notified when one opens, or earn on the stock you hold.</p>
    </div>
    <EmptyActions ticker={ticker} />
  </div>;
}
