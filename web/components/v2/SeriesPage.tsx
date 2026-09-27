"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAddress } from "viem";
import { useAccount } from "wagmi";

import { TradeTicket, type TicketQuote } from "@/components/v2/TradeTicket";
import { SettlementDisclosure } from "@/components/v2/SettlementDisclosure";
import { PremiumChart } from "@/components/v2/PremiumChart";
import { Button, InfoTip, Notice, Panel, Table, Tabs } from "@/components/ui";
import { USDG } from "@/lib/contracts";
import { fmtUsdg, fmtUsdPriceExact } from "@/lib/format";
import { displayExact } from "@/lib/numberFormat";
import type { BookResponse, Level, SeriesDetailResponse } from "@/lib/v2/api-types";
import { bookFromChain, selectBookSnapshot } from "@/lib/v2/bookFromChain";
import { assertSeriesTermsMatch, readMarketSpotOnChain, readSeriesOnChain } from "@/lib/v2/chainReads";
import { V2_DEPLOYMENT } from "@/lib/v2/config";
import { useBook, useCards, useConfig, useMarkets, useSeries, useTrades } from "@/lib/v2/hooks";
import { v2Markets } from "@/lib/markets";
import { selectTradeSpot } from "@/lib/v2/marketSpot";
import { tradingOpen } from "@/lib/v2/tradingGate";
import { cardTarget } from "@/lib/v2/payoff";
import { formatShares, formatUsdg } from "@/lib/v2/payoffCard";
import { Time } from "@/components/ui/Time";

function BookSide({ levels, title, account }: { levels: Level[]; title: string; account?: string }) {
  return <div className="min-w-0">
    <h3 className="mb-2 text-[13px] font-semibold uppercase tracking-[0.05em] text-ink-3">{title}</h3>
    {levels.length === 0 ? <p className="text-sm text-ink-2">No {title.toLowerCase()} yet.</p> :
      <Table label={`${title} by price`} minWidth={280}><thead><tr><th scope="col">Price / share</th><th scope="col">Size</th><th scope="col">Orders</th></tr></thead>
        <tbody>{levels.map((level) => {
          const mine = level.orders.some((order) => account && order.maker.toLowerCase() === account.toLowerCase());
          return <tr key={level.price.raw} className={mine ? "bg-accent-soft" : undefined}>
            <td className="num font-semibold">{fmtUsdPriceExact(BigInt(level.price.raw))}</td>
            <td className="num">{formatShares(BigInt(level.units))} sh</td>
            <td className="num text-ink-2">{level.orders.length}{mine ? <span className="ml-2 text-xs font-semibold text-accent-text">Your order</span> : null}</td>
          </tr>;
        })}</tbody></Table>}
  </div>;
}

function OrderBook({ book, account, degraded, loading }: { book: BookResponse | null; account?: string; degraded: boolean; loading: boolean }) {
  return <section aria-label="Order book" className="grid gap-3">
    {book ? <p className="flex items-center gap-1.5 text-xs text-ink-3">Block {book.updatedBlock}{degraded ? " · rebuilt on chain" : ""}
      <InfoTip label="About the order book" text="Prices are dollars per share, paid in USDG. Your own orders are tinted." /></p> : null}
    {book ? <div className="grid gap-5 sm:grid-cols-2"><BookSide levels={book.bids} title="Bids" account={account} />
      <BookSide levels={book.asks} title="Asks" account={account} /></div> :
      <p className="text-sm text-ink-2" role="status">{loading ? "Loading order book…" : "Order book unavailable. Try refreshing."}</p>}
  </section>;
}

export function SeriesFacts({ detail }: { detail: SeriesDetailResponse }) {
  const s = detail.series;
  const settlement = detail.settlement;
  return <section aria-label="Series facts">
    <dl className="grid grid-cols-2 gap-x-4 gap-y-4 text-sm sm:grid-cols-3">
      <div><dt className="text-ink-3">Expires</dt><dd className="font-semibold"><Time at={s.expiry} market /></dd></div>
      <div><dt className="text-ink-3">New sales close <InfoTip label="About new sales">Resales stay open until expiry.</InfoTip></dt><dd className="font-semibold"><Time at={s.mintCutoff} market /></dd></div>
      <div><dt className="text-ink-3">Exercise fee</dt><dd className="num font-semibold">{displayExact(BigInt(Math.round(detail.exerciseFeeBps)), 2, { minDecimals: 0 })}%</dd></div>
      <div><dt className="text-ink-3">Status</dt><dd className="font-semibold capitalize">{s.status}</dd></div>
      <div><dt className="text-ink-3">Open interest</dt><dd className="num font-semibold">{formatShares(BigInt(detail.openInterestUnits))} shares</dd></div>
      <div><dt className="text-ink-3">Volume</dt><dd className="num font-semibold">{fmtUsdg(BigInt(detail.volume.raw))} USDG</dd></div>
      {settlement ? <>
        <div><dt className="text-ink-3">Settlement</dt><dd className="font-semibold">{settlement.status}</dd></div>
        <div><dt className="text-ink-3">Settled price</dt><dd className="num font-semibold">{settlement.price ? `$${settlement.price.formatted}` : "Pending"}</dd></div>
        {settlement.sourceIndex !== null ? <div><dt className="text-ink-3">Price source</dt><dd className="num font-semibold">#{settlement.sourceIndex}</dd></div> : null}
        {settlement.candidate ? <div><dt className="text-ink-3">Candidate price</dt><dd className="num font-semibold">${settlement.candidate.price.formatted}{settlement.candidate.disagreed ? " · disputed" : ""}</dd></div> : null}
      </> : null}
    </dl>
  </section>;
}

/**
 * One series' trading data: the indexer detail, the order book with its on-chain rebuild when the
 * indexer is down, the card target and the trade spot. Split out of the old SeriesPage so the Neon market page can
 * mount the real ticket in its rail (SeriesRail) and the book and trades under its strike rows (SeriesDetails) for
 * both /[ticker] and /[ticker]/[series]. React Query dedupes the reads, so the two halves share one set of requests.
 */
function useSeriesTrade(ticker: string, longId: string) {
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => { const tick = () => setNowMs(Date.now()); tick();
    const timer = window.setInterval(tick, 1_000); return () => window.clearInterval(timer); }, []);
  const series = useSeries(longId);
  const book = useBook(longId);
  const trades = useTrades(longId);
  const config = useConfig();
  const markets = useMarkets();
  const cards = useCards({ ticker, limit: 200 });
  const { address } = useAccount();
  const detail = series.data;
  const market = markets.data?.find((item) => item.ticker === ticker);
  const compiledMarket = v2Markets().find((item) => item.ticker === ticker.toUpperCase());
  const card = cards.data?.items.find((item) => item.series.longId === longId);
  const chainSpot = useQuery({ queryKey: ["v2", "chainSpot", ticker], enabled: markets.isError && Boolean(detail) &&
      Boolean(V2_DEPLOYMENT.contracts.settlementOracle), retry: 0,
    queryFn: () => readMarketSpotOnChain(ticker), staleTime: 0, refetchInterval: 5_000,
    refetchOnWindowFocus: true });
  const canRebuildBook = book.isError && Boolean(detail) &&
    Boolean(V2_DEPLOYMENT.contracts.orderBook && V2_DEPLOYMENT.contracts.clearinghouse);
  const fallback = useQuery({ queryKey: ["v2", "chainBook", longId], enabled: canRebuildBook, retry: 0,
    queryFn: async () => {
      const onChain = await readSeriesOnChain(BigInt(longId));
      if (!onChain.exists) throw new Error("Series does not exist on chain");
      assertSeriesTermsMatch(detail!.series, onChain.series, ticker, detail!.exerciseFeeBps);
      const asset = detail!.series.isPut ? getAddress(config.data?.usdg.address ?? USDG) : getAddress(detail!.series.underlying);
      return bookFromChain(BigInt(longId), asset, onChain.collateral, Number(onChain.cutoff));
    }, staleTime: 15_000, refetchInterval: 15_000 });
  const chainBook = nowMs > 0 && !fallback.isError && fallback.dataUpdatedAt >= book.errorUpdatedAt &&
    nowMs - fallback.dataUpdatedAt <= 30_000 ? fallback.data : undefined;
  const { book: shownBook, degraded } = selectBookSnapshot(book.data, chainBook, book.isError);
  const bookLoading = book.isPending || (canRebuildBook && fallback.isPending);
  const strike = detail ? BigInt(detail.series.strike.raw) : 0n;
  const defaults = config.data && detail ? config.data.ladder[detail.series.tenor === "daily" ? "daily" : "weekly"] : null;
  const target = card ? BigInt(card.target.raw) : detail && compiledMarket && defaults
    ? cardTarget(strike, defaults.cardTargetBps, compiledMarket.v2.strikeTick, detail.series.isPut) : null;
  // A card may carry an older pricing feed. Never substitute it for a failed live oracle spot.
  const spot = selectTradeSpot(market?.spot?.raw, markets.isError, markets.errorUpdatedAt,
    chainSpot.data, chainSpot.dataUpdatedAt, chainSpot.isError || chainSpot.isFetching, nowMs);
  const refresh = () => { void book.refetch(); void fallback.refetch(); void series.refetch(); void trades.refetch(); };
  return { series, book, trades, fallback, canRebuildBook, detail, market, shownBook, degraded, bookLoading, target, spot, address, refresh };
}

/**
 * The market page's rail for one series: the real TradeTicket (book walk, on-chain recheck, wallet steps), or its
 * loading and unavailable states. `openTicket` (the route's `?buy=1`) focuses the size input once and scrolls the
 * ticket into view, as the series page always did.
 */
export function SeriesRail({ ticker, longId, initialShares, openTicket = false, atPrice = null, onQuote }: {
  ticker: string;
  longId: string;
  initialShares?: string;
  openTicket?: boolean;
  atPrice?: bigint | null;
  onQuote?: (quote: TicketQuote | null) => void;
}) {
  const focusedTicketFor = useRef<string | null>(null);
  const { series, detail, market, shownBook, degraded, target, spot, refresh } = useSeriesTrade(ticker, longId);
  const ticketRoute = `${longId}:${openTicket ? initialShares ?? "" : ""}`;

  useEffect(() => {
    if (!openTicket) { focusedTicketFor.current = null; return; }
    if (target === null || focusedTicketFor.current === ticketRoute) return;
    // The ticket mounts exactly ONE size input, and which one depends on the prefill: budget mode
    // renders `ticket-budget`, shares mode renders `ticket-shares`. Looking only for the shares
    // input meant a ladder Buy arriving as `?buy=1` -- the dollar-first default, with no `shares`
    // param -- focused nothing and never scrolled, because this effect returned early.
    const input = document.getElementById("ticket-budget") ?? document.getElementById("ticket-shares");
    if (!input) return;
    focusedTicketFor.current = ticketRoute;
    input.focus({ preventScroll: true });
    document.getElementById("ticket")?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "start",
    });
  }, [openTicket, ticketRoute, target, detail]);

  if (!detail) return series.isPending ? <Panel pad="sm" id="ticket" role="status" className="animate-pulse">Loading option terms…</Panel>
    : <Notice tone="warn" title="Option details are unavailable." role="status">
      <Button size="xs" variant="ghost" className="mt-1" onClick={() => void series.refetch()}>Try again</Button></Notice>;
  return <>
    {series.isError ? <Notice tone="warn" className="mb-4">Option details may be out of date. Check the terms before you trade.</Notice> : null}
    {target !== null ? <TradeTicket key={ticketRoute} ticker={ticker} detail={detail} book={shownBook} target={target} spot={spot}
      marketSettlement={market?.settlement} initialShares={initialShares} bookDegraded={degraded} onRefresh={refresh}
      atPrice={atPrice} onQuote={onQuote} tradingPaused={!tradingOpen(market)} />
      : <Panel pad="sm" id="ticket" role="status">Loading the ticket…</Panel>}
  </>;
}

/**
 * The series' activity, under the market page's strike rows: premium history, the (demoted) order book, recent
 * trades and the series facts, in that order. Collapsed by default, because the Neon market page leads with the
 * payoff and the ticket; nothing that the old series page showed is dropped.
 */
export function SeriesDetails({ ticker, longId }: { ticker: string; longId: string }) {
  const { trades, book, fallback, canRebuildBook, detail, shownBook, degraded, bookLoading, address } = useSeriesTrade(ticker, longId);
  const bestAsk = shownBook?.asks[0];
  if (!detail) return null;
  return <details className="group rounded-lg border border-line-2 bg-surface" data-slot="series-details">
    <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1 px-[18px] py-3.5 sm:px-[22px] [&::-webkit-details-marker]:hidden">
      <span className="text-[15px] font-semibold text-ink">Book, trades and terms · ${detail.series.strike.formatted} {detail.series.isPut ? "Put" : "Call"}</span>
      <span className="flex items-center gap-3">
        <span className="num text-xs font-medium text-ink-3">{bestAsk ? `Best ask ${fmtUsdPriceExact(BigInt(bestAsk.price.raw))} · ${formatShares(BigInt(bestAsk.units))} sh`
          : shownBook ? "No ask" : bookLoading ? "Loading…" : "Book unavailable"}</span>
        <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-pill border border-line-2 text-[13px] text-ink-2 transition-transform duration-150 group-open:rotate-180">▾</span>
      </span>
    </summary>
    <div className="grid gap-4 border-t border-line p-[18px] sm:p-[22px]">
      <p className="text-sm text-ink-2">Expires <Time at={detail.series.expiry} market /> · {detail.series.status}</p>
      <Tabs label="Series activity" items={[
        { value: "history", label: "History", panel: <PremiumChart trades={trades.data?.items ?? []} loading={trades.isPending} error={trades.isError} /> },
        { value: "book", label: "Book", panel: <div className="grid gap-3">
          <OrderBook book={shownBook} account={address} degraded={degraded} loading={bookLoading} />
          {book.isError && !shownBook ? <Notice tone="warn" role="status">Order book unavailable.{fallback.error
            ? ` ${fallback.error.message}` : canRebuildBook ? " Loading it from the chain." : ""}</Notice> : null}
        </div> },
        { value: "trades", label: "Trades", panel: <section aria-label="Recent trades">
          {trades.data?.items.length ? <Table label="Recent option trades" minWidth={320}><thead><tr><th scope="col">Time</th><th scope="col">Price / share</th><th scope="col">Size</th></tr></thead>
            <tbody>{trades.data.items.map((trade) => <tr key={trade.id}><td><Time at={trade.ts} /></td><td className="num">{fmtUsdPriceExact(BigInt(trade.price.raw))}</td>
              <td className="num">{formatShares(BigInt(trade.units))} sh</td></tr>)}</tbody></Table> :
            <p className="text-sm text-ink-2">{trades.isPending ? "Loading trades…" : trades.isError ? "Trades are unavailable right now." : "No trades yet."}</p>}
        </section> },
        { value: "terms", label: "Terms", panel: <SeriesFacts detail={detail} /> },
      ]} />
    </div>
  </details>;
}

/** The series' own facts for a route that needs them before the market data (the market page's initial day/type). */
export function useSeriesRef(longId: string | undefined) {
  const series = useSeries(longId ?? "");
  return longId ? series.data?.series ?? null : null;
}
