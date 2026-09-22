"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useAccount } from "wagmi";

import { ConnectButton } from "@/components/ConnectButton";
import { Button, Notice, PageHead, Panel } from "@/components/ui";
import { v2ConfigWarnings } from "@/lib/v2/config";
import {
  useConfig, useLeaderboard, useMakers, useMarketSeries,
  useMarkets, usePnl, usePositions, useWins,
} from "@/lib/v2/hooks";
import type { SeriesRef } from "@/lib/v2/api-types";

type Query<T> = {
  data: T | undefined;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => unknown;
};

function StatePanel<T>({ query, empty, isEmpty, children }: {
  query: Query<T>;
  empty: string;
  isEmpty: (data: T) => boolean;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending && !query.data) {
    return <Panel role="status" aria-label="Loading market data" className="animate-pulse">
      <div className="h-5 w-40 rounded bg-surface-2" />
      <div className="mt-4 h-4 w-full rounded bg-surface-2" />
      <div className="mt-2 h-4 w-2/3 rounded bg-surface-2" />
      <span className="sr-only">Loading market data</span>
    </Panel>;
  }
  if (!query.data) {
    return <Notice tone="warn" role="status" title="Live data is unavailable.">
      <p>The indexer could not answer. Market history and quotes will return when the service recovers.</p>
      {query.error ? <p className="mt-1 text-xs">{query.error.message}</p> : null}
      <Button size="xs" variant="ghost" className="mt-3" onClick={() => void query.refetch()}>Try again</Button>
    </Notice>;
  }
  return <>
    {query.isError ? <Notice tone="warn" role="status" className="mb-4">Showing the latest available data. Refresh is delayed.</Notice> : null}
    {isEmpty(query.data) ? <Panel><p className="text-ink-2">{empty}</p></Panel> : children(query.data)}
  </>;
}

function seriesLabel(series: SeriesRef) {
  return `${series.ticker} $${series.strike.formatted} ${series.isPut ? "put" : "call"}`;
}

/** A nonblocking cross-check between compiled addresses and the indexer boot response. */
export function V2ConfigNotice() {
  const query = useConfig();
  if (!query.data) return null;
  const warnings = v2ConfigWarnings(query.data);
  if (warnings.length === 0) return null;
  return <Notice tone="warn" role="status" className="fixed inset-x-4 bottom-4 z-50 mx-auto max-h-[40vh] max-w-xl overflow-auto shadow-lift" title="App and indexer configuration differ.">
    <p>Quotes remain visible. Trade actions must wait for matching deployment settings.</p>
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer font-semibold">Show {warnings.length} configuration differences</summary>
      <ul className="mt-1 list-inside list-disc">
        {warnings.map((warning) => <li key={warning}>{warning}</li>)}
      </ul>
    </details>
  </Notice>;
}

export function PortfolioShell() {
  const { address } = useAccount();
  const positions = usePositions(address);
  return <>
    <PageHead eyebrow="Your account" title="Portfolio" lede="Positions, open orders, and balances in one place." />
    {!address ? <Panel><p className="text-ink-2">Connect a wallet to see your positions.</p><div className="mt-4"><ConnectButton /></div></Panel> :
      <StatePanel query={positions} empty="No positions or open orders for this wallet yet." isEmpty={(data) => data.longs.length + data.shorts.length + data.orders.length === 0}>
        {(data) => <div className="grid gap-4 sm:grid-cols-3">
          <Panel><h2 className="font-bold">Long positions</h2><p className="num mt-2 text-2xl">{data.longs.length}</p></Panel>
          <Panel><h2 className="font-bold">Short positions</h2><p className="num mt-2 text-2xl">{data.shorts.length}</p></Panel>
          <Panel><h2 className="font-bold">Open orders</h2><p className="num mt-2 text-2xl">{data.orders.length}</p></Panel>
        </div>}
      </StatePanel>}
  </>;
}

export function EarnShell() {
  const markets = useMarkets();
  return <>
    <PageHead eyebrow="Writers" title="Earn by setting your price." lede="Own Stock Tokens? Explore markets where you can offer covered options." />
    <StatePanel query={markets} empty="No writing markets are open yet." isEmpty={(data) => !data.some((market) => market.status === "live")}>
      {(data) => <ul className="grid gap-4 sm:grid-cols-2">{data.filter((market) => market.status === "live").map((market) => <li key={market.ticker}>
        <Panel><h2 className="font-display text-xl font-bold">{market.ticker}</h2><p className="mt-1 text-ink-2">{market.name}</p><Button href={`/earn/${market.ticker.toLowerCase()}`} size="sm" className="mt-4">View market</Button></Panel>
      </li>)}</ul>}
    </StatePanel>
    <Notice tone="warn" className="mt-4">Premium arrives only when a buyer fills. Writing a call caps your upside above its strike.</Notice>
  </>;
}

export function EarnMarketShell({ ticker }: { ticker: string }) {
  const series = useMarketSeries(ticker);
  return <>
    <PageHead eyebrow="Writers" title={`Earn with ${ticker}`} lede="Choose a series and set your ask. The writing flow arrives in the next release." />
    <StatePanel query={series} empty="No series are open for writing in this market." isEmpty={(data) => data.items.length === 0}>
      {(data) => <Panel><p className="text-ink-2">{data.items.length} series available to review.</p><Button href={`/${ticker.toLowerCase()}`} size="sm" variant="ghost" className="mt-4">See series</Button></Panel>}
    </StatePanel>
  </>;
}

export function WinsShell() {
  const wins = useWins();
  return <>
    <PageHead eyebrow="Community" title="Recent wins" lede="Closed positions with recorded returns from sales or redemption." aside={<Button href="/leaderboard" variant="ghost">Leaderboard</Button>} />
    <Notice tone="info" className="mb-4">Most options expire worthless; this feed shows wins only.</Notice>
    <StatePanel query={wins} empty="No wins have been recorded yet." isEmpty={(data) => data.items.length === 0}>
      {(data) => <ul className="grid gap-4 sm:grid-cols-2">{data.items.map((win) => <li key={win.id}><Panel>
        <h2 className="font-display text-lg font-bold">{seriesLabel(win.series)}</h2>
        <p className="num mt-3 text-2xl font-bold text-accent-text">{win.multiple.toFixed(1)}×</p>
        <p className="mt-1 text-sm">{win.cost.formatted} → {win.payout.formatted} USDG</p>
        <p className="mt-1 text-sm font-semibold">Max loss was {win.cost.formatted} USDG.</p>
        <Button href={`/pnl/${encodeURIComponent(win.id)}`} size="sm" variant="ghost" className="mt-4">View win</Button>
      </Panel></li>)}</ul>}
    </StatePanel>
  </>;
}

export function LeaderboardShell() {
  const leaders = useLeaderboard({ metric: "multiple", window: "week" });
  return <>
    <PageHead eyebrow="Community" title="Leaderboard" lede="Biggest realised multiples this week." />
    <Notice tone="info" className="mb-4">Most options expire worthless; this board ranks recorded wins.</Notice>
    <StatePanel query={leaders} empty="No ranked wins for this period yet." isEmpty={(data) => data.items.length === 0}>
      {(data) => <ol className="grid gap-3">{data.items.map((row) => <li key={row.holder}><Panel className="flex items-center justify-between gap-4">
        <div><strong className="num">#{row.rank}</strong><span className="ml-3 num text-sm">{row.holder.slice(0, 6)}…{row.holder.slice(-4)}</span></div>
        <span className="num font-bold">{typeof row.value === "number" ? `${row.value.toFixed(1)}×` : row.value.formatted}</span>
      </Panel></li>)}</ol>}
    </StatePanel>
  </>;
}

export function PnlShell({ id }: { id: string }) {
  const pnl = usePnl(id);
  return <>
    <PageHead eyebrow="Verified win" title="A StonkHouse outcome" lede="Amount received and entry cost for a closed on-chain position." />
    <StatePanel query={pnl} empty="This win was not found." isEmpty={() => false}>
      {(data) => <Panel>
        <h2 className="font-display text-xl font-bold">{seriesLabel(data.series)}</h2>
        <p className="num mt-4 text-3xl font-bold text-accent-text">{data.multiple.toFixed(1)}×</p>
        <p className="mt-2">{data.cost.formatted} → {data.payout.formatted} USDG</p>
        <p className="mt-1 font-semibold">Max loss was {data.cost.formatted} USDG.</p>
        <Button href="/" size="sm" className="mt-5">Explore options</Button>
      </Panel>}
    </StatePanel>
  </>;
}

export function MakersShell() {
  const makers = useMakers();
  return <>
    <PageHead eyebrow="Liquidity" title="Market makers" lede="Public epoch scores and rebates for accounts quoting the book." />
    <StatePanel query={makers} empty="No maker scores published for this epoch." isEmpty={(data) => data.items.length === 0}>
      {(data) => <Panel><h2 className="font-bold">Epoch {data.epoch.id}</h2><p className="mt-2 text-ink-2">{data.items.length} makers scored.</p></Panel>}
    </StatePanel>
  </>;
}

export function NotificationsShell() {
  const { address } = useAccount();
  const config = useConfig();
  return <>
    <PageHead eyebrow="Settings" title="Notifications" lede="Choose where you want fill, price, and settlement updates." />
    {!address ? <Panel><p className="text-ink-2">Connect a wallet to manage notifications.</p><div className="mt-4"><ConnectButton /></div></Panel> :
      <StatePanel query={config} empty="Notification settings are not configured yet." isEmpty={() => false}>
        {() => <Panel><p className="text-ink-2">Notification controls will appear when the notifier is connected.</p></Panel>}
      </StatePanel>}
  </>;
}
