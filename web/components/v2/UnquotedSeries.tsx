"use client";

/**
 * What the marketplace shows when no maker has posted an ask.
 *
 * A SERIES AND AN ASK ARE DIFFERENT THINGS, and the marketplace only ever listed the second. A series
 * is the contract's existence -- `Clearinghouse.createSeries` is permissionless and the cranker writes
 * the ladder as soon as a market is enabled. An ask is somebody offering to write one and sell it,
 * which requires collateral they have to own. So the book is legitimately empty at launch while fifty
 * series sit on chain, and `/#options` rendered nothing but "No asks right now" -- correct, and useless
 * to a reader who wanted to see what exists.
 *
 * These tiles are NOT buyable and must never read as if they were: no ask price, no payoff multiple, no
 * buy control. They say what the contract is and link to its page. `PayoffCard` is deliberately not
 * reused -- its `Card` type requires a non-null `ask`, and inventing a zero one would render a real
 * looking price and a payoff multiple computed from it.
 */
import Link from "next/link";

import { Panel } from "@/components/ui";
import { useMarketSeries } from "@/lib/v2/hooks";

/** Enough to show the ladder is real without turning the empty state into a second marketplace. */
const MAX_SHOWN = 5;

function expiryLabel(expiry: number): string {
  return new Date(expiry * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function UnquotedSeries({ ticker, type }: { ticker: string | undefined; type: "call" | "put" }) {
  const series = useMarketSeries(ticker, { limit: MAX_SHOWN, type });
  const items = (series.data?.items ?? []).slice(0, MAX_SHOWN);
  // Silent when there is nothing to add: no ticker to ask about, the feed failed, or the ladder is empty.
  // The caller's "No asks right now" panel is still the honest answer in every one of those cases.
  if (!ticker || series.isError || items.length === 0) return null;

  return <section aria-labelledby="unquoted-title" className="mt-6">
    <h3 id="unquoted-title" className="font-display text-xl font-bold">Listed, waiting on a maker</h3>
    <p className="mt-2 text-sm text-ink-2">
      These {ticker} contracts exist on chain. None of them can be bought until a maker posts an ask.
    </p>
    <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map(({ series: s }) => <li key={s.longId} className="min-w-0">
        <Panel as="article" className="flex h-full flex-col">
          <p className="font-display text-lg font-bold">
            {s.ticker} {s.strike.formatted} {s.isPut ? "put" : "call"}
          </p>
          <p className="mt-1 text-sm text-ink-2">Expires {expiryLabel(s.expiry)}</p>
          <p className="mt-3 text-sm font-semibold text-ink-3">No ask yet</p>
          <Link href={`/${s.ticker.toLowerCase()}/${s.longId}`}
            className="mt-4 text-sm font-semibold text-accent-text underline">
            See the contract
          </Link>
        </Panel>
      </li>)}
    </ul>
  </section>;
}
