"use client";

import { useState } from "react";

import { Button, Chip, Notice, PageHead, Panel } from "@/components/ui";
import { v2Markets } from "@/lib/markets";
import { useMarkets } from "@/lib/v2/hooks";
import {
  filterMarketDirectory,
  marketDirectoryRows,
  settlementModeLabel,
  settlementPayoutLabel,
  type MarketDirectoryApiState,
  type MarketDirectoryAvailability,
  type MarketDirectoryRow,
} from "@/lib/v2/marketDirectory";
import { stamp } from "@/lib/v2/time";

type Filter = MarketDirectoryAvailability | "all";

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "live", label: "Live" },
  { value: "coming-soon", label: "Coming soon" },
  { value: "paused", label: "Paused" },
  { value: "deferred", label: "Deferred" },
];

function statusTone(status: MarketDirectoryAvailability): "accent" | "warn" | "neutral" {
  if (status === "live") return "accent";
  if (status === "paused" || status === "unavailable") return "warn";
  return "neutral";
}

export function MarketDirectoryCard({ market }: { market: MarketDirectoryRow }) {
  const settlement = settlementModeLabel(market.settlement);
  const payout = settlementPayoutLabel(market.settlement);
  return <Panel as="article" className="flex h-full flex-col" aria-label={`${market.ticker} market`}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="font-display text-2xl font-bold">{market.ticker}</h2>
        <p className="mt-1 truncate text-sm text-ink-2" title={market.name}>{market.name}</p>
      </div>
      <Chip tone={statusTone(market.availability)} dot>{market.availabilityLabel}</Chip>
    </div>
    <p className="mt-4 min-h-10 text-sm text-ink-2">{market.availabilityDetail}</p>
    <dl className="mt-5 grid grid-cols-2 gap-4 border-y border-line py-4">
      <div>
        <dt className="text-xs font-semibold uppercase tracking-wide text-ink-3">Accepted oracle spot</dt>
        <dd className="num mt-1 text-xl font-bold">{market.spot ? `$${market.spot.formatted}` : "Unavailable"}</dd>
        {market.spotUpdatedAt !== null ? <dd className="mt-1 text-[11px] text-ink-3">
          Feed observed <time dateTime={new Date(market.spotUpdatedAt * 1_000).toISOString()}>{stamp(market.spotUpdatedAt)}</time>
        </dd> : null}
      </div>
      <div>
        <dt className="text-xs font-semibold uppercase tracking-wide text-ink-3">Open series</dt>
        <dd className="num mt-1 text-xl font-bold">{market.seriesOpen ?? "—"}</dd>
      </div>
    </dl>
    <div className="mt-5">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-3">Settlement configuration</p>
      {settlement ? <>
        <Chip className="mt-2" tone="neutral" wrap>{settlement}</Chip>
        <p className="mt-2 text-xs leading-relaxed text-ink-2">{payout}</p>
      </> : <>
        <Chip className="mt-2" tone="neutral" wrap>Details unavailable</Chip>
        <p className="mt-2 text-xs leading-relaxed text-ink-3">No source count, wait, or payout route is inferred.</p>
      </>}
    </div>
    <div className="mt-auto pt-6">
      {market.tradeable ? <Button href={market.href} size="sm">View options</Button>
        : <span className="text-xs font-semibold text-ink-3">Trading unavailable</span>}
    </div>
  </Panel>;
}

export function MarketDirectory() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const markets = useMarkets();
  const apiState: MarketDirectoryApiState = markets.isError
    ? { kind: "error" }
    : markets.data
      ? { kind: "ready", markets: markets.data }
      : { kind: "loading" };
  const rows = marketDirectoryRows(v2Markets(), apiState);
  const visible = filterMarketDirectory(rows, query, filter);

  return <>
    <PageHead eyebrow="Trust" title="Market status"
      lede="Search the registry, check accepted oracle spots and their observation times, and see which markets are open. A listed market can still have an empty order book." />

    {markets.isError ? <Notice tone="warn" role="status" className="mb-6" title="Live market data is unavailable.">
      Registry plans are still shown, but current status, spot, and settlement details are hidden. Trading links stay unavailable until status is confirmed.
      <Button size="xs" variant="ghost" className="ml-3" disabled={markets.isFetching}
        onClick={() => void markets.refetch()}>{markets.isFetching ? "Retrying…" : "Retry"}</Button>
    </Notice> : null}

    <Panel as="section" aria-label="Market filters" pad="sm">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <label className="block min-w-0 flex-1 text-sm font-semibold">Search by ticker or name
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="Try NVDA or NVIDIA" className="mt-2 min-h-11 w-full rounded-sm border border-line-2 bg-surface px-3 text-ink outline-none focus:border-accent focus:ring-[3px] focus:ring-accent/25" />
        </label>
        <p className="text-sm text-ink-3" aria-live="polite">{visible.length} {visible.length === 1 ? "market" : "markets"}</p>
      </div>
      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Market availability">
        {FILTERS.map(({ value, label }) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}
          className={`min-h-10 rounded-sm border px-3 text-sm font-semibold ${filter === value ? "border-accent bg-accent-soft text-accent-text" : "border-line-2 bg-surface text-ink hover:bg-surface-2"}`}>
          {label}
        </button>)}
      </div>
    </Panel>

    <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs text-ink-3">
      <p><strong className="text-ink-2">Coming soon</strong> follows the next-release registry group.</p>
      <p><strong className="text-ink-2">Deferred</strong> rows have no promised launch timing.</p>
    </div>

    {visible.length ? <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {visible.map((market) => <MarketDirectoryCard key={market.ticker} market={market} />)}
    </div> : <Panel className="mt-6">
      <h2 className="font-display text-xl font-bold">No markets match</h2>
      <p className="mt-2 text-sm text-ink-2">Try another ticker, company name, or availability filter.</p>
      <Button size="sm" variant="ghost" className="mt-4" onClick={() => { setQuery(""); setFilter("all"); }}>Clear filters</Button>
    </Panel>}
  </>;
}
