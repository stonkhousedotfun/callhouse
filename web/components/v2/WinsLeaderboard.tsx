"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { useAccount } from "wagmi";

import { Button, InfoIcon, InfoTip, Notice, Panel, RailLayout, SegmentedControl, Segments } from "@/components/ui";
import { cn } from "@/lib/cn";
import { shortAddress } from "@/lib/format";
import { v2Api } from "@/lib/v2/api";
import type { LeaderboardResponse } from "@/lib/v2/api-types";

import { imageMoney } from "./PnlText";
import { Avatar, fmtMultiple, usdgValue, WinsFeed, WINS_ONLY_NOTE } from "./WinsFeed";

/**
 * The leaderboard, Neon screen "A · Wins".
 *
 * Two layouts of one list:
 *   - the RAIL beside the /wins feed: "Leaderboard · This week" (the Monday reset and exclusion rules in its "?"), the
 *     Multiple / Biggest win / Streak chips, the top five, and "Full leaderboard →";
 *   - /leaderboard: the same list full width, paged, with the period switch the rail leaves out.
 *
 * Every row is a real /v2/leaderboard row; the mockup's five wallets are illustrative. An empty
 * board says so rather than drawing placeholder ranks.
 */

type LeaderWindow = "week" | "month" | "all";
type Metric = "multiple" | "absolute" | "streak";
type LeaderRow = LeaderboardResponse["items"][number];

const leaderWindows: readonly { value: LeaderWindow; label: string }[] = [
  { value: "week", label: "This week" }, { value: "month", label: "This month" }, { value: "all", label: "All time" },
];
// The mockup's chip labels. "Biggest win" ranks by absolute USDG value, "Streak" by consecutive wins.
const metrics: readonly { value: Metric; label: string }[] = [
  { value: "multiple", label: "Multiple" },
  { value: "absolute", label: "Biggest win" },
  { value: "streak", label: "Streak" },
];

/** The rail shows the top five, as drawn. */
export const RAIL_ROWS = 5;

/**
 * The reset and exclusion rules, stated once for both layouts, measured against the indexer rather than copied:
 *   - the week window starts Monday 00:00 America/New_York (indexer/lib/v2/windows.ts `windowStarts`); month and
 *     all-time do not reset weekly, so the sentence names the weekly ranking;
 *   - ineligible POSITIONS are dropped, not whole accounts (indexer/src/api/v2/feed.ts `eligible`: self-fills,
 *     tokens transferred in or out, off-market fills, below-minimum cost). The pre-Neon copy said "accounts with
 *     flagged or gifted positions are excluded", which overstated it; the mockup's wording is the accurate one.
 */
export const LEADERBOARD_RULES = "Weekly rankings reset Monday 00:00 New York. Flagged or gifted positions are excluded.";

export function leaderValue(row: LeaderRow, metric: Metric): string {
  // A realised amount rounds down to the cent, the receipt's rule.
  if (metric === "absolute" && typeof row.value !== "number") return usdgValue(imageMoney(row.value, "down"));
  if (metric === "streak" && typeof row.value === "number") return `${row.value} ${row.value === 1 ? "win" : "wins"}`;
  return typeof row.value === "number" ? fmtMultiple(row.value) : usdgValue(imageMoney(row.value, "down"));
}

/** "01" … "99": the rank as the mockup prints it, two digits in mono. Ranks past 99 print as they are. */
export const rankLabel = (rank: number) => String(rank).padStart(2, "0");

/** One wallet per rank. A holder can appear on two pages while the board moves; keep the first. */
export function uniqueHolders(rows: readonly LeaderRow[]): LeaderRow[] {
  return [...new Map(rows.map((row) => [row.holder.toLowerCase(), row] as const)).values()];
}

function QueryNotice({ error, retry }: { error?: Error | null; retry: () => void }) {
  return <Notice tone="warn" role="status" title="Results are unavailable.">
    {error ? <p className="text-xs">{error.message}</p> : null}
    <Button variant="ghost" size="sm" className="mt-3" onClick={retry}>Try again</Button>
  </Notice>;
}

/** One ranked wallet. `compact` is the rail's row (rank, wallet, value); the full row adds record and receipt. */
export function LeaderRowView({ row, metric, own, compact = false }: { row: LeaderRow; metric: Metric; own: boolean; compact?: boolean }) {
  const rankTone = row.rank === 1 ? "text-accent-text" : "text-ink-3";
  if (compact) {
    return <div data-slot="leader-row" className="flex items-center gap-3 border-t border-line py-2.5">
      <span className={cn("num w-6 text-[13px] font-semibold", rankTone)}>{rankLabel(row.rank)}</span>
      <span className="num min-w-0 flex-1 truncate text-[13px]" title={row.holder}>
        {shortAddress(row.holder)}{own ? <span className="ml-2 font-body text-xs font-semibold text-accent-text">You</span> : null}
      </span>
      <span className="text-base font-extrabold">{leaderValue(row, metric)}</span>
    </div>;
  }
  return <article data-slot="leader-row"
    className={cn("flex flex-wrap items-center gap-3 px-4 py-3.5 sm:gap-4 sm:px-5", own && "bg-row-selected")}>
    <span className={cn("num w-8 text-[15px] font-semibold", rankTone)}>{rankLabel(row.rank)}</span>
    <Avatar holder={row.holder} className="max-sm:hidden" />
    <div className="grid min-w-0 flex-1 gap-0.5">
      <p className="num truncate text-[15px] font-semibold" title={row.holder}>
        {shortAddress(row.holder)}{own ? <span className="ml-2 font-body text-xs font-semibold text-accent-text">You</span> : null}
      </p>
      <p className="text-xs text-ink-3">{row.wins} {row.wins === 1 ? "win" : "wins"} · {row.losses} {row.losses === 1 ? "loss" : "losses"}</p>
    </div>
    <span className="num text-[18px] font-bold tracking-[-0.02em] text-accent-text sm:text-[20px]">{leaderValue(row, metric)}</span>
    <Button href={`/pnl/${encodeURIComponent(row.best.id)}`} variant="secondary" size="sm" className="max-sm:ml-11">Best receipt · {row.best.ticker}</Button>
  </article>;
}

/** The rail card beside the wins feed: this week's top five by the chosen measure. */
export function LeaderboardRail() {
  const [metric, setMetric] = useState<Metric>("multiple");
  const { address } = useAccount();
  const board = useQuery({
    queryKey: ["v2", "leaderboardRail", metric],
    queryFn: ({ signal }) => v2Api.getLeaderboard({ metric, window: "week", limit: RAIL_ROWS }, { signal }),
    staleTime: 15_000,
    refetchInterval: 15_000,
  });
  const rows = uniqueHolders((board.data?.items ?? []) as LeaderRow[]).slice(0, RAIL_ROWS);

  return <Panel as="section" pad="none" aria-labelledby="leaderboard-rail-title" className="grid gap-3.5 p-5">
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-1.5"><h2 id="leaderboard-rail-title" className="text-[17px] font-bold">Leaderboard</h2>
        <InfoTip label="About the leaderboard">{LEADERBOARD_RULES}</InfoTip></div>
      <span className="text-xs font-medium text-ink-3">This week</span>
    </div>
    <Segments label="Ranking measure" options={metrics} selected={metric} onSelect={setMetric} />
    {board.isPending ? <p role="status" className="text-sm text-ink-3">Loading leaderboard…</p> : !board.data
      ? <QueryNotice error={board.error} retry={() => void board.refetch()} />
      : rows.length === 0
        ? <p data-slot="leaderboard-empty" className="border-t border-line pt-3 text-sm text-ink-2">No ranked wins this week yet.</p>
        : <ol className="grid">{rows.map((row) => <li key={row.holder}>
          <LeaderRowView row={row} metric={metric} own={address?.toLowerCase() === row.holder.toLowerCase()} compact />
        </li>)}</ol>}
    <Link href="/leaderboard" className="w-fit text-[13px] font-bold text-accent-text hover:underline">Full leaderboard →</Link>
  </Panel>;
}

/** /leaderboard: the same list full width, paged, with the period switch. */
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
  const rows = uniqueHolders(board.data?.pages.flatMap((page) => page.items as LeaderRow[]) ?? []);

  return <section aria-labelledby="leaderboard-title" className="grid gap-5 pt-6 lg:pt-10">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-2"><h1 id="leaderboard-title" className="text-[length:clamp(32px,4vw,44px)] font-extrabold leading-none tracking-[-0.035em]">Leaderboard</h1>
        <InfoTip label="About the leaderboard">{LEADERBOARD_RULES}</InfoTip></div>
      <Button href="/wins" variant="ghost" size="sm">See wins feed</Button>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Segments label="Ranking measure" options={metrics} selected={metric} onSelect={setMetric} />
      <SegmentedControl label="Ranking period" options={leaderWindows} selected={window} onSelect={setWindow} />
    </div>
    {board.isPending ? <Panel role="status" className="text-sm text-ink-2">Loading leaderboard…</Panel> : !board.data
      ? <QueryNotice error={board.error} retry={() => void board.refetch()} />
      : <div className="grid gap-4">
        {board.isError ? <Notice tone="warn">Showing saved rankings.</Notice> : null}
        <Panel as="section" pad="none" aria-label="Rankings" className="overflow-hidden">
          <p className="flex items-center gap-2 border-b border-line px-4 py-3 text-[13px] text-ink-3 sm:px-5"><InfoIcon className="shrink-0 text-usdg" />{WINS_ONLY_NOTE}</p>
          {rows.length === 0
            ? <div data-slot="leaderboard-empty" className="grid justify-items-center gap-1.5 px-4 py-12 text-center">
              <h2 className="text-lg font-extrabold">First ranked win lands here</h2>
              <p className="text-sm text-ink-2">No wallet has a recorded win for this period yet.</p>
            </div>
            : <ol className="divide-y divide-line">{rows.map((row) => <li key={row.holder}>
              <LeaderRowView row={row} metric={metric} own={address?.toLowerCase() === row.holder.toLowerCase()} />
            </li>)}</ol>}
        </Panel>
        {board.hasNextPage ? <div className="text-center"><Button variant="ghost" disabled={board.isFetchingNextPage}
          onClick={() => void board.fetchNextPage()}>{board.isFetchingNextPage ? "Loading…" : "Load more ranks"}</Button></div> : null}
      </div>}
  </section>;
}

/*//////////////////////////////////////////////////////////////
                ONE COMPONENT, TWO ROUTES
//////////////////////////////////////////////////////////////*/

export type WinsTab = "wins" | "leaderboard";

/** The view a `?tab=` value selects. Anything else is the default rather than an error page. */
export function winsTabFromParam(raw: string | null | undefined): WinsTab {
  return raw === "leaderboard" ? "leaderboard" : "wins";
}

/**
 * `/wins` and `/leaderboard`, one component.
 *
 * WHY THIS STILL EXISTS (UX review item 3): `/leaderboard` was a real page that nothing linked to. Before Neon the
 * fix was a tab on /wins. The Neon design fixes it better: the leaderboard is ALWAYS on /wins, as the rail beside
 * the feed, with "Full leaderboard →" to the full-width list. So the tab switch is gone, and each route renders its
 * own layout of the same data.
 *
 * `/leaderboard` IS NOT DELETED, for the same reason as before: bookmarks and shared links to it exist, and removing
 * the route would turn each of them into a 404 to fix a discovery problem.
 */
export function WinsAndLeaderboard({ initialTab = "wins" }: { initialTab?: WinsTab }) {
  if (initialTab === "leaderboard") return <Leaderboard />;
  return <RailLayout main={<WinsFeed />} rail={<LeaderboardRail />} railLabel="Leaderboard" className="pt-6 lg:pt-10" />;
}
