"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";

import { Button, Notice, PageHead, Panel, Table } from "@/components/ui";
import { fmtCountdown } from "@/lib/format";
import { v2Api } from "@/lib/v2/api";
import { useCards, useMarkets } from "@/lib/v2/hooks";
import { formatShares, formatUsdg } from "@/lib/v2/payoffCard";

const DATE = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" });

function percent(numerator: bigint, denominator: bigint): string {
  if (denominator === 0n) return "—";
  const tenths = (numerator * 1_000n) / denominator;
  return `${(Number(tenths) / 10).toFixed(1)}%`;
}

export function MarketPage({ ticker }: { ticker: string }) {
  const [expiry, setExpiry] = useState<number | null>(null);
  const [type, setType] = useState<"call" | "put">("call");
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => { const tick = () => setNow(Math.floor(Date.now() / 1000)); tick();
    const timer = window.setInterval(tick, 1_000); return () => window.clearInterval(timer); }, []);
  const markets = useMarkets();
  const market = markets.data?.find((item) => item.ticker === ticker);
  const supportsPuts = market?.puts === true;
  const activeType = supportsPuts ? type : "call";
  const expiries = [...(market?.expiries ?? [])].sort((a, b) => a - b);
  const selected = expiry !== null && expiries.includes(expiry) ? expiry : expiries[0];
  const series = useInfiniteQuery({
    queryKey: ["v2", "marketSeriesInfinite", ticker, activeType, selected],
    queryFn: ({ pageParam, signal }) => v2Api.getMarketSeries(ticker,
      { type: activeType, expiry: selected, limit: 50, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: selected !== undefined,
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
  const allSeries = [...new Map((series.data?.pages.flatMap((page) => page.items) ?? [])
    .map((row) => [row.series.longId, row])).values()];
  const cards = useCards({ ticker, type: activeType, limit: 200 });
  const rows = allSeries.filter((row) => row.series.expiry === selected && row.series.isPut === (activeType === "put"));
  const cardById = new Map(cards.data?.items.map((card) => [card.series.longId, card]) ?? []);
  const liveSpot = markets.isError ? null : market?.spot ?? null;
  const spot = liveSpot ? BigInt(liveSpot.raw) : 0n;
  const spotAge = !markets.isError && now !== null && market?.spotUpdatedAt !== null && market?.spotUpdatedAt !== undefined
    ? Math.max(0, now - market.spotUpdatedAt) : null;

  return <>
    <PageHead eyebrow="Market" title={`${ticker} options`} lede="Compare live strikes, quoted size, and the payoff before opening a trade." />
    {market ? <Panel className="mb-5 flex flex-wrap items-center justify-between gap-4">
      <div><p className="text-sm text-ink-2">{market.name} spot</p>
        <p className="num mt-1 text-3xl font-bold">{liveSpot ? `$${liveSpot.formatted}` : "Unavailable"}</p>
        <p className="mt-1 text-xs text-ink-3">{liveSpot ? `Feed updated ${spotAge === null ? "—" : spotAge < 60 ? `${spotAge}s` : `${Math.floor(spotAge / 60)}m`} ago` : "Live spot feed unavailable; price comparisons are paused."}</p></div>
      <div className="text-sm text-ink-2">{market.stats.seriesOpen} open series · {formatShares(BigInt(market.stats.openInterestUnits))} shares open interest</div>
    </Panel> : markets.isPending ? <Panel role="status" className="mb-5 animate-pulse">Loading market spot…</Panel>
      : markets.isError ? null : <Notice tone="warn" className="mb-5">Market spot is unavailable. Quotes below may still load.</Notice>}
    {markets.isError ? <Notice tone="warn" role="status" className="mb-5">Market data is unavailable. Quotes below may still load.
      <Button size="xs" variant="ghost" className="ml-2" disabled={markets.isFetching}
        onClick={() => void markets.refetch()}>{markets.isFetching ? "Retrying…" : "Retry market data"}</Button>
    </Notice> : null}
    {supportsPuts ? <div className="mb-5 flex gap-2" role="group" aria-label="Option type">
      {(["call", "put"] as const).map((kind) => <button key={kind} type="button" aria-pressed={activeType === kind} onClick={() => { setType(kind); setExpiry(null); }}
        className={`min-h-10 rounded-sm border px-4 text-sm font-semibold ${activeType === kind ? "border-accent bg-accent-soft text-accent-text" : "border-line-2 bg-surface"}`}>
        {kind === "call" ? "Calls" : "Puts"}</button>)}
    </div> : null}
    {series.isError ? <Notice tone="warn" role="status" className="mb-5" title="Ladder updates are delayed.">
      {series.data ? "Showing the last available series." : "The indexer is unavailable. Open a series from a saved link to use its on-chain order-book fallback."}
      <Button size="xs" variant="ghost" className="ml-2" onClick={() => void series.refetch()}>Retry</Button>
    </Notice> : null}
    {expiries.length > 0 ? <div className="mb-4 flex gap-2 overflow-x-auto pb-2" role="group" aria-label="Expiry">
          {expiries.map((date) => <button key={date} type="button" aria-pressed={selected === date} onClick={() => setExpiry(date)}
            className={`shrink-0 rounded-sm border px-4 py-2 text-left text-sm ${selected === date ? "border-accent bg-accent-soft text-accent-text" : "border-line-2 bg-surface hover:bg-surface-2"}`}>
            <span className="font-semibold">{DATE.format(new Date(date * 1000))}</span>
            <span className="num block text-xs">{now === null ? "—" : fmtCountdown(date, now)}</span>
          </button>)}
        </div> : null}
    {!market && markets.isPending ? <Panel role="status" className="min-h-64 animate-pulse">Loading strike ladder…</Panel>
      : selected === undefined ? <Panel><p className="text-ink-2">{markets.isError ? "Market expiries are unavailable. Try again shortly." : "No expiries are open for this market yet."}</p></Panel>
      : series.isPending && !series.data ? <Panel role="status" className="min-h-64 animate-pulse">Loading strike ladder…</Panel>
      : series.isError && rows.length === 0 ? null
      : rows.length === 0 ? <Panel><p className="text-ink-2">No {activeType}s are listed for this expiry yet.</p>
        {series.hasNextPage ? <Button size="sm" variant="ghost" className="mt-4" disabled={series.isFetchingNextPage}
          onClick={() => void series.fetchNextPage()}>{series.isFetchingNextPage ? "Loading strikes…" : "Load more strikes"}</Button> : null}
      </Panel> : <>
        <Panel><h2 className="mb-4 font-display text-xl font-bold">Strike ladder</h2>
          <Table label={`${ticker} ${activeType} strikes`} bleed minWidth={970}>
            <thead><tr><th scope="col">Strike</th><th scope="col">OTM</th><th scope="col">Bid / share</th><th scope="col">Ask / share</th>
              <th scope="col">Ask / 0.01</th><th scope="col">Fair</th><th scope="col">Ask vs fair</th><th scope="col">At target</th>
              <th scope="col">Ask depth</th><th scope="col">Open interest</th></tr></thead>
            <tbody>{rows.map(({ series: row, quote, openInterestUnits }) => {
              const strike = BigInt(row.strike.raw);
              const deviation = quote.bestAsk && quote.fair && BigInt(quote.fair.raw) > 0n
                ? percent(BigInt(quote.bestAsk.raw) - BigInt(quote.fair.raw), BigInt(quote.fair.raw)) : "—";
              const card = cardById.get(row.longId);
              return <tr key={row.longId}>
                <td><Link className="link font-semibold text-accent-text" href={`/${ticker.toLowerCase()}/${row.longId}`}>${row.strike.formatted}</Link></td>
                <td>{spot > 0n ? (row.isPut ? spot > strike : strike > spot)
                  ? percent(row.isPut ? spot - strike : strike - spot, spot) : "ITM" : "—"}</td>
                <td>{quote.bestBid ? `$${quote.bestBid.formatted}` : "—"}</td>
                <td>{quote.bestAsk ? `$${quote.bestAsk.formatted}` : "—"}</td>
                <td>{quote.bestAsk ? `${formatUsdg(BigInt(quote.bestAsk.raw) / 100n)} USDG` : "—"}</td>
                <td>{quote.fair ? `$${quote.fair.formatted}` : "—"}</td><td>{deviation}</td>
                <td>{card ? `${card.perUnit.multiple.toFixed(2)}×` : "—"}</td>
                <td>{formatShares(BigInt(quote.askUnits))} shares</td><td>{formatShares(BigInt(openInterestUnits))} shares</td>
              </tr>;
            })}</tbody>
          </Table>
          <p className="mt-4 text-xs text-ink-3">OTM means out of the money; ITM means in the money. Fair is a model estimate, not a tradable quote. The At target multiple uses the option&apos;s target scenario; open it to see the target price. Prices are per whole share unless marked 0.01. The maximum loss for a buy is the full cost, including fees.</p>
          {series.hasNextPage ? <Button size="sm" variant="ghost" className="mt-4" disabled={series.isFetchingNextPage}
            onClick={() => void series.fetchNextPage()}>{series.isFetchingNextPage ? "Loading strikes…" : "Load more strikes"}</Button> : null}
        </Panel>
      </>}
  </>;
}
