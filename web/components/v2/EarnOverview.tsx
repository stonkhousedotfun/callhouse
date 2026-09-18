"use client";

import { Button, Notice, PageHead, Panel } from "@/components/ui";
import { useMarkets } from "@/lib/v2/hooks";
import { formatShares } from "@/lib/v2/payoffCard";

export function EarnOverview() {
  const markets = useMarkets();
  const live = markets.isError ? [] : markets.data?.filter((market) => market.status === "live") ?? [];
  const hasPuts = live.some((market) => market.puts);
  return <>
    <PageHead eyebrow="Writers" title="Set your ask." lede={hasPuts
      ? "Deposit Stock Tokens for covered calls or USDG for cash-secured puts, then name the premium a buyer must pay."
      : "Deposit Stock Tokens, choose an option, and name the premium a buyer must pay."} />
    <Notice tone="warn" className="mb-6">{hasPuts
      ? "A call caps your upside; a put can lose the difference below its strike from USDG collateral. Premium arrives only when a buyer fills your ask."
      : "Writing a call caps your upside above its strike. Premium arrives only when a buyer fills your ask."}</Notice>
    {markets.isError ? <Notice tone="warn" role="status" className="mb-5" title="Writing markets are unavailable.">
      The indexer could not answer. This page cannot verify current markets or balances until data returns. Check your transactions in a block explorer.
      <Button variant="ghost" size="xs" className="mt-2" onClick={() => void markets.refetch()}>Try again</Button>
    </Notice> : null}
    {markets.isPending && !markets.data ? <Panel role="status">Loading writing markets…</Panel> : live.length ?
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{live.map((market) => <Panel key={market.ticker} as="article" className="flex flex-col">
        <div className="flex items-baseline justify-between gap-3"><h2 className="font-display text-2xl font-bold">{market.ticker}</h2><span className="num text-sm text-ink-2">{market.spot ? `$${market.spot.formatted}` : "Spot unavailable"}</span></div>
        <p className="mt-1 text-sm text-ink-2">{market.name}</p>
        <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-line pt-4 text-sm">
          <div><dt className="text-ink-3">Premium · 7 days</dt><dd className="num mt-1 font-semibold">{market.stats.premium7d.formatted} USDG</dd></div>
          <div><dt className="text-ink-3">Volume · 24 hours</dt><dd className="num mt-1 font-semibold">{market.stats.volume24h.formatted} USDG</dd></div>
          <div><dt className="text-ink-3">Open series</dt><dd className="num mt-1 font-semibold">{market.stats.seriesOpen}</dd></div>
          <div><dt className="text-ink-3">Open interest</dt><dd className="num mt-1 font-semibold">{formatShares(BigInt(market.stats.openInterestUnits))} shares</dd></div>
        </dl>
        <Button href={`/earn/${market.ticker.toLowerCase()}`} size="sm" className="mt-5 w-full">{market.spot ? `Write ${market.ticker}` : `View ${market.ticker}`}</Button>
      </Panel>)}</div> : !markets.isError ? <Panel>No writing markets are open yet.</Panel> : null}
  </>;
}
