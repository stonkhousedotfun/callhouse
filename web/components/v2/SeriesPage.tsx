"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getAddress } from "viem";
import { useAccount } from "wagmi";

import { TradeTicket } from "@/components/v2/TradeTicket";
import { SettlementDisclosure } from "@/components/v2/SettlementDisclosure";
import { PremiumChart } from "@/components/v2/PremiumChart";
import { Button, Notice, PageHead, Panel, Table } from "@/components/ui";
import { USDG } from "@/lib/contracts";
import type { BookResponse, Level, SeriesDetailResponse } from "@/lib/v2/api-types";
import { bookFromChain, selectBookSnapshot } from "@/lib/v2/bookFromChain";
import { assertSeriesTermsMatch, readMarketSpotOnChain, readSeriesOnChain } from "@/lib/v2/chainReads";
import { V2_DEPLOYMENT } from "@/lib/v2/config";
import { useBook, useCards, useConfig, useMarkets, useSeries, useTrades } from "@/lib/v2/hooks";
import { v2Markets } from "@/lib/markets";
import { selectTradeSpot } from "@/lib/v2/marketSpot";
import { cardTarget } from "@/lib/v2/payoff";
import { formatShares, formatUsdg } from "@/lib/v2/payoffCard";
import { stamp } from "@/lib/v2/time";

function BookSide({ levels, title, account }: { levels: Level[]; title: string; account?: string }) {
  return <div>
    <h3 className="mb-2 font-display text-lg font-bold">{title}</h3>
    {levels.length === 0 ? <p className="text-sm text-ink-2">No {title.toLowerCase()} are available.</p> :
      <Table label={`${title} by price`} minWidth={300}><thead><tr><th scope="col">USDG / share</th><th scope="col">Size</th><th scope="col">Orders</th></tr></thead>
        <tbody>{levels.map((level) => {
          const mine = level.orders.some((order) => account && order.maker.toLowerCase() === account.toLowerCase());
          return <tr key={level.price.raw} className={mine ? "bg-accent-soft" : undefined}>
            <td className="num font-semibold">{level.price.formatted}</td>
            <td className="num">{formatShares(BigInt(level.units))} shares</td>
            <td className="num text-ink-2">{level.orders.length}{mine ? <span className="ml-2 text-xs font-semibold text-accent-text">Your order</span> : null}</td>
          </tr>;
        })}</tbody></Table>}
  </div>;
}

function OrderBook({ book, account, degraded, loading }: { book: BookResponse | null; account?: string; degraded: boolean; loading: boolean }) {
  return <Panel as="section" aria-label="Order book">
    <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2"><h2 className="font-display text-xl font-bold">Order book</h2>
      {book ? <p className="text-xs text-ink-3">Block {book.updatedBlock}{degraded ? " · rebuilt on chain" : ""}</p> : null}</div>
    {book ? <div className="grid gap-5 sm:grid-cols-2"><BookSide levels={book.bids} title="Bids" account={account} />
      <BookSide levels={book.asks} title="Asks" account={account} /></div> :
      <p className="text-sm text-ink-2" role="status">{loading ? "Loading order book…" : "The order book is unavailable. Try refreshing."}</p>}
  </Panel>;
}

export function SeriesFacts({ detail }: { detail: SeriesDetailResponse }) {
  const s = detail.series;
  const settlement = detail.settlement;
  const [localExpiry, setLocalExpiry] = useState<string | null>(null);
  useEffect(() => { const timer = window.setTimeout(() => setLocalExpiry(
    new Date(s.expiry * 1_000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })), 0);
    return () => window.clearTimeout(timer); }, [s.expiry]);
  return <Panel as="section" aria-label="Series facts">
    <h2 className="font-display text-xl font-bold">Series facts</h2>
    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-4 text-sm">
      <div><dt className="text-ink-3">Expires (New York)</dt><dd className="font-semibold">{stamp(s.expiry)}</dd></div>
      <div><dt className="text-ink-3">Your local time</dt><dd className="font-semibold">{localExpiry ?? "Loading…"}</dd></div>
      <div><dt className="text-ink-3">New writing closes</dt><dd className="font-semibold">{stamp(s.mintCutoff)}</dd></div>
      <div><dt className="text-ink-3">Exercise fee</dt><dd className="num font-semibold">{(detail.exerciseFeeBps / 100).toFixed(2)}%</dd></div>
      <div><dt className="text-ink-3">Status</dt><dd className="font-semibold capitalize">{s.status}</dd></div>
      <div><dt className="text-ink-3">Open interest</dt><dd className="num font-semibold">{formatShares(BigInt(detail.openInterestUnits))} shares</dd></div>
      <div><dt className="text-ink-3">Volume</dt><dd className="num font-semibold">{detail.volume.formatted} USDG</dd></div>
      {settlement ? <>
        <div><dt className="text-ink-3">Settlement</dt><dd className="font-semibold">{settlement.status}</dd></div>
        <div><dt className="text-ink-3">Settled price</dt><dd className="num font-semibold">{settlement.price ? `$${settlement.price.formatted}` : "Pending"}</dd></div>
        {settlement.sourceIndex !== null ? <div><dt className="text-ink-3">Oracle source</dt><dd className="num font-semibold">#{settlement.sourceIndex}</dd></div> : null}
        {settlement.candidate ? <div><dt className="text-ink-3">Candidate price</dt><dd className="num font-semibold">${settlement.candidate.price.formatted}{settlement.candidate.disagreed ? " · disputed" : ""}</dd></div> : null}
      </> : null}
    </dl>
    <p className="mt-4 text-xs text-ink-3">One share equals 100 contract units. A long option can lose its full purchase cost.</p>
  </Panel>;
}

export function SeriesPage({ ticker, longId, initialShares, openTicket }: { ticker: string; longId: string; initialShares?: string; openTicket: boolean }) {
  const focusedTicketFor = useRef<string | null>(null);
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
  const bestAsk = shownBook?.asks[0];
  const bookLoading = book.isPending || (canRebuildBook && fallback.isPending);
  const strike = detail ? BigInt(detail.series.strike.raw) : 0n;
  const defaults = config.data && detail ? config.data.ladder[detail.series.tenor === "daily" ? "daily" : "weekly"] : null;
  const target = card ? BigInt(card.target.raw) : detail && compiledMarket && defaults
    ? cardTarget(strike, defaults.cardTargetBps, compiledMarket.v2.strikeTick, detail.series.isPut) : null;
  // A card may carry an older pricing feed. Never substitute it for a failed live oracle spot.
  const spot = selectTradeSpot(market?.spot?.raw, markets.isError, markets.errorUpdatedAt,
    chainSpot.data, chainSpot.dataUpdatedAt, chainSpot.isError || chainSpot.isFetching, nowMs);
  const ticketRoute = `${longId}:${openTicket ? initialShares ?? "" : ""}`;

  useEffect(() => {
    if (!openTicket) { focusedTicketFor.current = null; return; }
    if (target === null || focusedTicketFor.current === ticketRoute) return;
    // The ticket mounts exactly ONE size input, and which one depends on W1's prefill: budget mode
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

  return <>
    <PageHead eyebrow={<Link className="link" href={`/${ticker.toLowerCase()}`}>{ticker} market</Link>} title={detail
      ? `${ticker} $${detail.series.strike.formatted} ${detail.series.isPut ? "put" : "call"}` : `${ticker} option`}
      lede="Review the payout, live book, and total cost before confirming in your wallet." />
    {!detail ? series.isPending ? <Panel role="status" className="animate-pulse">Loading option terms…</Panel> :
      <Notice tone="warn" title="Option details are unavailable." role="status">The indexer has not returned this series.
        <Button size="xs" variant="ghost" className="ml-2" onClick={() => void series.refetch()}>Try again</Button></Notice> : <>
      {series.isError ? <Notice tone="warn" className="mb-4">Option details may be delayed. Recheck the terms before trading.</Notice> : null}
      <Panel className="mb-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div><p className="text-sm font-semibold text-ink-2">{detail.series.isPut ? "Payout starts below the strike" : "Payout starts above the strike"}</p>
            <p className="num mt-2 text-2xl font-bold">Strike ${detail.series.strike.formatted}</p>
            <p className="mt-1 text-sm text-ink-2">Expires {stamp(detail.series.expiry)} · {detail.series.status}</p></div>
          <div className="text-right"><p className="text-sm text-ink-3">Best ask / share</p>
            <p className="num text-2xl font-bold">{bestAsk ? `${bestAsk.price.formatted} USDG` : shownBook ? "No ask" : bookLoading ? "Loading…" : "Unavailable"}</p>
            <p className="text-xs text-ink-3">{shownBook ? bestAsk
              ? `${formatShares(BigInt(bestAsk.units))} shares at best ask`
              : "No shares offered" : "Book availability unavailable"}</p></div>
        </div>
        <p className="mt-4 text-sm">{target !== null
          ? detail.series.isPut
            ? `If ${ticker} falls to $${formatUsdg(target)} at expiry, the ticket shows your fee-net USDG payout and max loss for the selected size.`
            : `If ${ticker} reaches $${formatUsdg(target)} at expiry, the ticket shows the estimated settlement value and max loss for the selected size. USDG conversion may deliver less or fall back to Stock Tokens.`
          : detail.series.isPut
            ? "Choose a size below to see the current quoted cost and projected USDG payout."
            : "Choose a size below to see the current quoted cost and estimated settlement value."}</p>
        <p className="mt-2 text-xs text-ink-3">Resale stays open after new writing closes, until expiry.</p>
        <SettlementDisclosure settlement={market?.settlement} isPut={detail.series.isPut} ticker={ticker}
          className="mt-4 border-t border-line pt-4" />
      </Panel>
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,23rem)]">
        <div className="min-w-0 space-y-5">
          <PremiumChart trades={trades.data?.items ?? []} loading={trades.isPending} error={trades.isError} />
          <OrderBook book={shownBook} account={address} degraded={degraded} loading={bookLoading} />
          {book.isError && !shownBook ? <Notice tone="warn" role="status">Indexer book is unavailable.{fallback.error
            ? ` ${fallback.error.message}` : canRebuildBook ? " Trying the chain." : " On-chain fallback is unavailable in this build."}</Notice> : null}
          <Panel as="section" aria-label="Recent trades"><h2 className="font-display text-xl font-bold">Recent trades</h2>
            {trades.data?.items.length ? <Table label="Recent option trades" minWidth={350} className="mt-3"><thead><tr><th scope="col">Time (New York)</th><th scope="col">Price / share</th><th scope="col">Size</th></tr></thead>
              <tbody>{trades.data.items.map((trade) => <tr key={trade.id}><td>{stamp(trade.ts)}</td><td className="num">{trade.price.formatted} USDG</td>
                <td className="num">{formatShares(BigInt(trade.units))} shares</td></tr>)}</tbody></Table> :
              <p className="mt-3 text-sm text-ink-2">{trades.isPending ? "Loading trades…" : trades.isError ? "Recent trades are temporarily unavailable." : "No trades recorded yet."}</p>}
          </Panel>
          <SeriesFacts detail={detail} />
        </div>
        {target !== null ? <TradeTicket key={ticketRoute} ticker={ticker} detail={detail} book={shownBook} target={target} spot={spot}
          marketSettlement={market?.settlement} initialShares={initialShares}
          bookDegraded={degraded} onRefresh={() => { void book.refetch(); void fallback.refetch(); void series.refetch(); void trades.refetch(); }} /> :
          <Panel id="ticket" role="status">Loading the strike target and fee settings for this option…</Panel>}
      </div>
    </>}
  </>;
}
