"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button, InfoIcon, Notice, Panel, SegmentedControl, Stat, TickerLogo } from "@/components/ui";
import { cn } from "@/lib/cn";
import { shortAddress } from "@/lib/format";
import { displayMoney, displayQuantity } from "@/lib/numberFormat";
import { v2Api } from "@/lib/v2/api";
import type { StatsResponse, Win } from "@/lib/v2/api-types";
import { useNow } from "@/lib/hooks";
import { useStats } from "@/lib/v2/hooks";
import { NEW_YORK_TIME_ZONE } from "@/lib/v2/time";
import { timeText, useViewerTimeZone } from "@/components/ui/Time";

import { imageMoney, multipleText } from "./PnlText";

/**
 * The wins feed, Neon screen "A · Wins".
 *
 * Main column of /wins: the 56px "Wins" title with the period switch beside it, four stat tiles, the
 * worthless-expiry note, then one row per win (avatar, option, wallet · time · paid → got, the multiple,
 * Receipt). The leaderboard rail beside it lives in WinsLeaderboard.tsx.
 *
 * NOTHING HERE IS SAMPLE DATA. The mockup's rows, wallets and tile values (184 fills, 412 USDG, 4.2×) are
 * illustrative. Every figure below comes from /v2/stats or /v2/feed/wins, and a book with no
 * fills renders the designed empty state: the tiles read 0 in mono and the feed says
 * "First win lands here". Sample rows never ship.
 *
 * What a row does NOT say: the mockup labels rows "sold early" or "settled", but a Win carries no exit kind, and
 * `settledAt` is the position's close time, which for a profitable resale comes before the series settles.
 * Printing either label would be a guess, so the row names the option only.
 */

export type WinWindow = "day" | "week" | "all";

const winWindows: readonly { value: WinWindow; label: string }[] = [
  { value: "day", label: "Today" }, { value: "week", label: "This week" }, { value: "all", label: "All time" },
];

/** Results can include Stock Tokens paid in kind, valued at settlement price, so a payout is a USDG *value*. */
export const usdgValue = (formatted: string) => `${formatted} USDG value`;

/** "2.4×", "8×". Up to two decimals and no zero tail, so 1.04× never rounds to a break-even-looking 1×. */
export const fmtMultiple = multipleText;

/** The worthless-expiry line, verbatim from the design ("The wins feed and receipts keep ..."). */
export const WINS_ONLY_NOTE = "Most options expire worthless. This feed shows wins only.";


/**
 * How long ago a win closed, in the mockup's short form: "now", "12m", "5h", then the New York weekday ("Tue")
 * inside a week, then the date ("Sep 12"). Unix SECONDS in, like every other time helper (lib/v2/time.ts).
 * A close time in the future (clock skew between the indexer and this browser) reads "now", not "-3m".
 */
export function winAge(closedAt: number, now: number, timeZone: string = NEW_YORK_TIME_ZONE): string {
  const seconds = Math.max(0, now - closedAt);
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  const at = new Date(closedAt * 1000);
  if (seconds < 7 * 86_400) return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone }).format(at);
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(at);
}

/**
 * The avatar's colour, derived from the wallet so one wallet keeps one colour across the feed and the rail.
 * The mockup cycles five token colours by row position; by-position would repaint a wallet whenever a new win
 * pushed it down a row. Tokens only, so the dot follows night and day mode with everything else.
 */
const AVATAR_TONES = ["bg-accent", "bg-usdg", "bg-danger-text", "bg-warn", "bg-ink-3"] as const;

export function avatarTone(holder: string): (typeof AVATAR_TONES)[number] {
  const tail = Number.parseInt(holder.slice(-4), 16);
  return AVATAR_TONES[(Number.isFinite(tail) ? tail : 0) % AVATAR_TONES.length]!;
}

/** "NVDA $218 call". */
export const optionLabel = (win: Win) => `${win.ticker} $${win.series.strike.formatted} ${win.series.isPut ? "put" : "call"}`;

export function Avatar({ holder, size = "md", className }: { holder: string; size?: "sm" | "md"; className?: string }) {
  return <span aria-hidden="true" data-slot="avatar"
    className={cn("shrink-0 rounded-full", size === "md" ? "size-10" : "size-7", avatarTone(holder), className)} />;
}

/** `now` is unix seconds, or 0 before mount (useNow), when the age is left out rather than printed as "now". */
export function WinRow({ win, now }: { win: Win; now: number }) {
  const zone = useViewerTimeZone();
  return <article data-slot="win-row" className="flex items-center gap-3 px-4 py-3.5 sm:gap-4 sm:px-5">
    <Avatar holder={win.holder} className="max-sm:hidden" />
    <div className="grid min-w-0 flex-1 gap-0.5">
      <p className="truncate text-[15px] font-bold"><TickerLogo ticker={win.ticker} className="mr-1.5 align-[-0.125em]" />{optionLabel(win)}</p>
      <p className="num text-xs text-ink-3 [overflow-wrap:anywhere]">
        <span title={win.holder}>{shortAddress(win.holder)}</span>
        {now > 0 ? <>{" · "}<time dateTime={new Date(win.settledAt * 1000).toISOString()} title={timeText({ at: win.settledAt }, zone)}>{winAge(win.settledAt, now, zone ?? NEW_YORK_TIME_ZONE)}</time></> : null}
        {" · "}paid {imageMoney(win.cost, "up")} → {usdgValue(imageMoney(win.payout, "down"))}
      </p>
    </div>
    <span className="num text-[20px] font-bold tracking-[-0.03em] text-accent-text sm:text-[24px]">{fmtMultiple(win.multiple)}</span>
    <Button href={`/pnl/${encodeURIComponent(win.id)}`} size="sm" variant="secondary" aria-label={`Receipt for ${optionLabel(win)}, ${shortAddress(win.holder)}`}>Receipt</Button>
  </article>;
}

function QueryNotice({ error, retry }: { error?: Error | null; retry: () => void }) {
  return <Notice tone="warn" role="status" title="Results are unavailable.">
    {error ? <p className="text-xs">{error.message}</p> : null}
    <Button variant="ghost" size="sm" className="mt-3" onClick={retry}>Try again</Button>
  </Notice>;
}

/**
 * What a "biggest win" tile shows. Loading and an outage are NOT zero: only a successful stats response with no
 * win in the window reads 0. A failed refresh over saved totals says the zero is a saved one.
 */
export function biggestTile(
  stats: { data: StatsResponse | undefined; isPending: boolean; isError: boolean },
  win: Win | null | undefined,
): { value: string; sub?: string; href?: string } {
  if (!stats.data) return { value: "—", sub: stats.isPending ? "Loading recorded wins…" : "Results unavailable" };
  if (win) return { value: fmtMultiple(win.multiple), sub: win.ticker, href: `/pnl/${encodeURIComponent(win.id)}` };
  return { value: "0", sub: stats.isError ? "No recorded win in saved results" : "No recorded win yet" };
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
  // 0 until mounted (lib/hooks.ts useNow), so the server render and the first client frame agree; ages appear after.
  const now = useNow();
  const day = biggestTile(stats, stats.data?.biggestWinDay);
  const week = biggestTile(stats, stats.data?.biggestWinWeek);

  const cell = "min-w-0 px-4 py-4 sm:px-5";
  const receipt = (href: string | undefined) => href ? <Button href={href} size="xs" variant="ghost" className="mt-2">Receipt</Button> : null;
  return <section aria-labelledby="wins-title" className="grid gap-5">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <h1 id="wins-title" className="text-[length:clamp(32px,4vw,44px)] font-extrabold leading-none tracking-[-0.035em]">Wins</h1>
      <SegmentedControl label="Wins period" options={winWindows} selected={window} onSelect={setWindow} />
    </div>

    <Panel pad="none" className="grid grid-cols-2 divide-line max-lg:[&>*:nth-child(-n+2)]:border-b max-lg:[&>*:nth-child(odd)]:border-r lg:grid-cols-4 lg:divide-x">
      <Stat className={cell} label="Contracts filled"
        value={stats.data ? displayQuantity(BigInt(stats.data.contractsFilled), 0) : "—"} />
      <Stat className={cell} label="Volume, 24h" unit="USDG"
        value={stats.data ? displayMoney(BigInt(stats.data.volume24h.raw), stats.data.volume24h.decimals) : "—"} />
      <div className={cell}><Stat label="Biggest win today" value={day.value} sub={day.sub} />{receipt(day.href)}</div>
      <div className={cell}><Stat label="Biggest this week" value={week.value} sub={week.sub} />{receipt(week.href)}</div>
    </Panel>
    {stats.isError ? <Notice tone="warn">{stats.data ? "Showing saved totals." : "Totals are unavailable."}</Notice> : null}

    {feed.isPending ? <Panel role="status" className="text-sm text-ink-2">Loading recorded wins…</Panel> : !feed.data
      ? <QueryNotice error={feed.error} retry={() => void feed.refetch()} />
      : <div className="grid gap-4">
        {feed.isError ? <Notice tone="warn">Showing saved results.</Notice> : null}
        <Panel as="section" pad="none" aria-label="Recent wins" className="overflow-hidden">
          <p className="flex items-center gap-2 border-b border-line px-4 py-3 text-[13px] text-ink-3 sm:px-5"><InfoIcon className="shrink-0 text-usdg" />{WINS_ONLY_NOTE}</p>
          {wins.length === 0
            ? <div data-slot="wins-empty" className="grid justify-items-center gap-1.5 px-4 py-12 text-center">
              <h2 className="text-lg font-extrabold">First win lands here</h2>
              <p className="text-sm text-ink-2">Any position that closes for more than it cost shows up here.</p>
            </div>
            : <ul className="divide-y divide-line">{wins.map((win) => <li key={win.id}><WinRow win={win} now={now} /></li>)}</ul>}
        </Panel>
        {feed.hasNextPage ? <div className="text-center"><Button variant="ghost" disabled={feed.isFetchingNextPage}
          onClick={() => void feed.fetchNextPage()}>{feed.isFetchingNextPage ? "Loading…" : "Load more wins"}</Button></div> : null}
      </div>}
  </section>;
}
