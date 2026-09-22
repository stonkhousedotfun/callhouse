"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useAccount } from "wagmi";

import { Button, Notice, PageHead, Panel, Segments } from "@/components/ui";
import { v2Api } from "@/lib/v2/api";
import type { LeaderboardResponse, Win } from "@/lib/v2/api-types";
import { useStats } from "@/lib/v2/hooks";

type WinWindow = "day" | "week" | "all";
type LeaderWindow = "week" | "month" | "all";
type Metric = "multiple" | "absolute" | "streak";

const winWindows: readonly { value: WinWindow; label: string }[] = [
  { value: "day", label: "Today" }, { value: "week", label: "This week" }, { value: "all", label: "All time" },
];
const leaderWindows: readonly { value: LeaderWindow; label: string }[] = [
  { value: "week", label: "This week" }, { value: "month", label: "This month" }, { value: "all", label: "All time" },
];
const metrics: readonly { value: Metric; label: string }[] = [
  { value: "multiple", label: "Biggest multiple" },
  { value: "absolute", label: "Biggest win" },
  { value: "streak", label: "Win streak" },
];
// Results can include Stock Tokens paid in kind, valued at settlement price.
const money = (formatted: string) => `${formatted} USDG value`;
const shortAddress = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const date = (unix: number) => new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", year: "numeric", timeZone: "UTC",
}).format(new Date(unix * 1000));

// `Segments` moved to components/ui (UX review item 7). This file was its original home and is
// now just another caller, which is the point: one control, one appearance, one keyboard contract.

export function WinTile({ win }: { win: Win }) {
  return <Panel as="article" className="flex h-full flex-col">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-2">{win.ticker} · {date(win.settledAt)}</p>
        <h2 className="mt-2 font-display text-xl font-bold">
          {win.ticker} ${win.series.strike.formatted} {win.series.isPut ? "put" : "call"}
        </h2>
      </div>
      <span className="num rounded-lg bg-accent/15 px-3 py-1.5 text-xl font-extrabold text-accent-text">
        {win.multiple.toFixed(2)}×
      </span>
    </div>
    <p className="num mt-5 text-lg font-semibold">{win.cost.formatted} → {money(win.payout.formatted)}</p>
    <p className="mt-1 text-sm text-ink-2">Entry cost → total proceeds and payout</p>
    <div className="mt-auto flex flex-wrap items-end justify-between gap-3 pt-6">
      <span className="num text-xs text-ink-2" title={win.holder}>{shortAddress(win.holder)}</span>
      <Button href={`/pnl/${encodeURIComponent(win.id)}`} size="sm" variant="ghost">View receipt</Button>
    </div>
  </Panel>;
}

function QueryNotice({ error, retry }: { error?: Error | null; retry: () => void }) {
  return <Notice tone="warn" role="status" title="Live results are unavailable.">
    <p>The latest recorded results will return when the indexer recovers.</p>
    {error ? <p className="mt-1 text-xs">{error.message}</p> : null}
    <Button variant="ghost" size="sm" className="mt-3" onClick={retry}>Try again</Button>
  </Notice>;
}

export function WinsFeed() {
  const [window, setWindow] = useState<WinWindow>("week");
  const stats = useStats();
  const feed = useInfiniteQuery({
    queryKey: ["v2", "winsInfinite", window],
    queryFn: ({ pageParam, signal }) => v2Api.getWins({ window, limit: 20, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
  // A new win can shift page boundaries while paging; keep each receipt once.
  const wins = [...new Map((feed.data?.pages.flatMap((page) => page.items) ?? []).map((win) => [win.id, win])).values()];
  const emptyHeadline = !stats.data
    ? stats.isPending ? "Loading recorded wins…" : "Results unavailable"
    : stats.isError ? "No recorded win in saved results" : "No recorded win yet";

  return <>
    <PageHead eyebrow="Community" title="The wins feed" lede="Closed positions with a recorded cost and realised return. A win can come from a sale before expiry or a redemption. Open a receipt to inspect the result."
      aside={<Button href="/leaderboard" variant="ghost">See leaderboard</Button>} />
    <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Panel pad="sm"><p className="text-sm text-ink-2">Contracts filled</p><p className="num mt-2 text-2xl font-bold">{stats.data ? new Intl.NumberFormat("en-US").format(BigInt(stats.data.contractsFilled)) : "—"}</p></Panel>
      <Panel pad="sm"><p className="text-sm text-ink-2">Volume, 24h</p><p className="num mt-2 text-2xl font-bold">{stats.data ? stats.data.volume24h.formatted : "—"}<span className="ml-1 text-sm font-normal text-ink-2">USDG</span></p></Panel>
      <Panel pad="sm"><p className="text-sm text-ink-2">Biggest win today</p>{stats.data?.biggestWinDay
        ? <Button href={`/pnl/${encodeURIComponent(stats.data.biggestWinDay.id)}`} variant="ghost" size="sm" className="mt-2">{stats.data.biggestWinDay.multiple.toFixed(2)}× · {stats.data.biggestWinDay.ticker}</Button>
        : <p className="mt-2 text-sm text-ink-2">{emptyHeadline}</p>}</Panel>
      <Panel pad="sm"><p className="text-sm text-ink-2">Biggest win this week</p>{stats.data?.biggestWinWeek
        ? <Button href={`/pnl/${encodeURIComponent(stats.data.biggestWinWeek.id)}`} variant="ghost" size="sm" className="mt-2">{stats.data.biggestWinWeek.multiple.toFixed(2)}× · {stats.data.biggestWinWeek.ticker}</Button>
        : <p className="mt-2 text-sm text-ink-2">{emptyHeadline}</p>}</Panel>
    </div>
    {stats.isError ? <Notice tone="warn" className="mb-4">{stats.data
      ? "Live headline updates are unavailable. Showing saved totals."
      : "Headline totals are temporarily unavailable."}</Notice> : null}
    <Notice tone="info" className="mb-6">Most options expire worthless; the feed shows wins only.</Notice>
    <div className="mb-5"><Segments label="Wins period" options={winWindows} selected={window} onSelect={setWindow} /></div>
    {feed.isPending ? <Panel role="status">Loading recorded wins…</Panel> : !feed.data
      ? <QueryNotice error={feed.error} retry={() => void feed.refetch()} />
      : <>
        {feed.isError ? <Notice tone="warn" className="mb-4">Showing saved results while live updates recover.</Notice> : null}
        {wins.length === 0 ? <Panel><p className="text-ink-2">No recorded wins for this period yet.</p></Panel>
          : <ul className="grid gap-4 md:grid-cols-2">{wins.map((win) => <li key={win.id}><WinTile win={win} /></li>)}</ul>}
        {feed.hasNextPage ? <div className="mt-6 text-center"><Button variant="ghost" disabled={feed.isFetchingNextPage}
          onClick={() => void feed.fetchNextPage()}>{feed.isFetchingNextPage ? "Loading…" : "Load more wins"}</Button></div> : null}
      </>}
  </>;
}

export function leaderValue(row: LeaderboardResponse["items"][number], metric: Metric): string {
  if (metric === "absolute" && typeof row.value !== "number") return money(row.value.formatted);
  if (metric === "streak" && typeof row.value === "number") return `${row.value} ${row.value === 1 ? "win" : "wins"}`;
  return typeof row.value === "number" ? `${row.value.toFixed(2)}×` : money(row.value.formatted);
}

export function Leaderboard() {
  const [metric, setMetric] = useState<Metric>("multiple");
  const [window, setWindow] = useState<LeaderWindow>("week");
  const { address } = useAccount();
  const board = useInfiniteQuery({
    queryKey: ["v2", "leaderboardInfinite", metric, window],
    queryFn: ({ pageParam, signal }) => v2Api.getLeaderboard({ metric, window, limit: 20, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
  const allRows = board.data?.pages.flatMap((page) => page.items as LeaderboardResponse["items"][number][]) ?? [];
  const rows = [...new Map(allRows.map((row) => [row.holder.toLowerCase(), row])).values()];

  return <>
    <PageHead eyebrow="Community" title="Leaderboard" lede="Recorded outcomes, ranked by the measure and period you choose."
      aside={<Button href="/wins" variant="ghost">See wins feed</Button>} />
    <Notice tone="info" className="mb-6">Most options expire worthless; the feed shows wins only.</Notice>
    <div className="mb-6 flex flex-wrap gap-x-8 gap-y-4">
      <Segments label="Ranking measure" options={metrics} selected={metric} onSelect={setMetric} />
      <Segments label="Ranking period" options={leaderWindows} selected={window} onSelect={setWindow} />
    </div>
    {board.isPending ? <Panel role="status">Loading leaderboard…</Panel> : !board.data
      ? <QueryNotice error={board.error} retry={() => void board.refetch()} />
      : <>
        {board.isError ? <Notice tone="warn" className="mb-4">Showing saved rankings while live updates recover.</Notice> : null}
        {rows.length === 0 ? <Panel><p className="text-ink-2">No ranked outcomes for this period yet.</p></Panel>
          : <ol className="grid gap-3">{rows.map((row) => {
            const own = address?.toLowerCase() === row.holder.toLowerCase();
            return <li key={row.holder}><Panel as="article" className={own ? "border-accent" : undefined}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-4">
                  <span className="num text-xl font-bold text-ink-2">#{row.rank}</span>
                  <div><p className="num font-bold" title={row.holder}>{shortAddress(row.holder)}{own ? <span className="ml-2 text-xs text-accent-text">You</span> : null}</p>
                    <p className="mt-1 text-sm text-ink-2">{row.wins} {row.wins === 1 ? "win" : "wins"} · {row.losses} {row.losses === 1 ? "loss" : "losses"}</p></div>
                </div>
                <div className="text-right"><p className="num text-xl font-bold text-accent-text">{leaderValue(row, metric)}</p>
                  <Button href={`/pnl/${encodeURIComponent(row.best.id)}`} variant="ghost" size="xs" className="mt-2">Best receipt · {row.best.ticker}</Button></div>
              </div>
            </Panel></li>;
          })}</ol>}
        {board.hasNextPage ? <div className="mt-6 text-center"><Button variant="ghost" disabled={board.isFetchingNextPage}
          onClick={() => void board.fetchNextPage()}>{board.isFetchingNextPage ? "Loading…" : "Load more ranks"}</Button></div> : null}
      </>}
    <p className="mt-6 text-xs text-ink-2">Weekly rankings reset Monday at midnight New York time. Accounts with flagged or gifted positions are excluded from ranking.</p>
  </>;
}

/*//////////////////////////////////////////////////////////////
          ONE PAGE, TWO TABS — UX review item 4 (section 3)
//////////////////////////////////////////////////////////////*/

export type WinsTab = "wins" | "leaderboard";

/** The tab a `?tab=` value selects. Anything else is the default rather than an error page. */
export function winsTabFromParam(raw: string | null | undefined): WinsTab {
  return raw === "leaderboard" ? "leaderboard" : "wins";
}

/**
 * `/wins` and `/leaderboard` as one tabbed page.
 *
 * WHY THIS EXISTS: `/leaderboard` was a real page — three windows by three metrics — that NOTHING
 * LINKED TO. Only `/wins` was in the nav, so the leaderboard could be reached solely by typing the
 * URL. A page nobody can navigate to is not a feature, and adding a ninth nav destination to fix
 * it would have worsened the review's item 1 (eight top-level destinations, four of which take
 * your money).
 *
 * `/leaderboard` IS NOT DELETED. It still renders, now as this page with the leaderboard tab
 * selected, so an existing link, bookmark or share keeps working and lands where the reader
 * expected. Removing the route would have turned every such link into a 404 to fix a discovery
 * problem, which trades one silent failure for a louder one.
 *
 * The tab idiom is `Segments`, the same control the rest of the app now uses (item 1), so this
 * page did not invent a third toggle appearance while the row was busy removing the second.
 */
export function WinsAndLeaderboard({ initialTab = "wins" }: { initialTab?: WinsTab }) {
  const [tab, setTab] = useState<WinsTab>(initialTab);
  return <>
    <Segments className="mb-6" label="Wins or leaderboard" selected={tab} onSelect={setTab}
      options={[{ value: "wins", label: "Recent wins" }, { value: "leaderboard", label: "Leaderboard" }] as const} />
    {tab === "wins" ? <WinsFeed /> : <Leaderboard />}
  </>;
}
