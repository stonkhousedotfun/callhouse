"use client";

import { useState } from "react";

import { Button, InfoTip, Notice, PageHead, Panel, Segments, type SegmentOption } from "@/components/ui";
import { v2Markets } from "@/lib/markets";
import { useMarkets } from "@/lib/v2/hooks";
import {
  filterMarketDirectory,
  marketDirectoryRows,
  type MarketDirectoryApiState,
  type MarketDirectoryAvailability,
  type MarketDirectoryRow,
} from "@/lib/v2/marketDirectory";

import { MarketStatusCard, registryFacts } from "./MarketStatusCard";

type Filter = MarketDirectoryAvailability | "all";

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "live", label: "Live" },
  { value: "coming-soon", label: "Coming soon" },
  { value: "paused", label: "Paused" },
  { value: "deferred", label: "Deferred" },
];

/**
 * A market card with its registry facts (source names, cadence) looked up by ticker. A row the app's registry does not
 * carry gets no facts: the card then shows the indexer's count and wait with no names, rather than guessing them.
 * Kept under this name because the acceptance tests and /trust/markets both render it.
 */
export function MarketDirectoryCard({ market }: { market: MarketDirectoryRow }) {
  const registry = v2Markets().find((row) => row.ticker === market.ticker);
  return <MarketStatusCard market={market} facts={registry ? registryFacts(registry) : undefined} />;
}

/** /trust/markets: the Neon markets screen. The page component stays this one. */
export function MarketDirectory() {
  const [filter, setFilter] = useState<Filter>("all");
  const markets = useMarkets();
  const apiState: MarketDirectoryApiState = markets.isError
    ? { kind: "error" }
    : markets.data
      ? { kind: "ready", markets: markets.data }
      : { kind: "loading" };
  const rows = marketDirectoryRows(v2Markets(), apiState);
  const visible = filterMarketDirectory(rows, "", filter);
  // "All · 2": the count is the whole directory, so it reads the same whichever filter is on.
  const options: readonly SegmentOption<Filter>[] = FILTERS.map(({ value, label }) =>
    ({ value, label: value === "all" ? `${label} · ${rows.length}` : label }));

  return <>
    <PageHead
      title={<>Market status <InfoTip label="About market status">A live market can still have no open orders.</InfoTip></>}
      lede="Price and settlement setup for every listed market."
      aside={<Segments label="Market availability" options={options} selected={filter} onSelect={setFilter} />} />

    {markets.isError ? <Notice tone="warn" role="status" className="mb-6" title="Live market data is unavailable.">
      Status, prices and settlement details are hidden, and trading links are off until it loads.
      <Button size="xs" variant="ghost" className="ml-3" disabled={markets.isFetching}
        onClick={() => void markets.refetch()}>{markets.isFetching ? "Retrying…" : "Retry"}</Button>
    </Notice> : null}

    {visible.length ? <div className="grid gap-5 md:grid-cols-2">
      {visible.map((market) => <MarketDirectoryCard key={market.ticker} market={market} />)}
    </div> : <Panel>
      <h2 className="text-xl font-extrabold">No markets match</h2>
      <p className="mt-2 text-sm text-ink-2">No market is {FILTERS.find((f) => f.value === filter)?.label.toLowerCase()} right now.</p>
      <Button size="sm" variant="ghost" className="mt-4" onClick={() => setFilter("all")}>Show all markets</Button>
    </Panel>}
  </>;
}
