"use client";

import { useEffect, useState } from "react";

import { Button, Notice, TickerLogo } from "@/components/ui";
import { MarketPage } from "@/components/v2/MarketPage";
import { putTickers } from "@/components/v2/trade/puts";
import { cn } from "@/lib/cn";
import { displayPrice, withDollar } from "@/lib/numberFormat";
import { tickerCards, type TickerCard } from "@/lib/v2/buyHome";
import type { Money } from "@/lib/v2/api-types";
import { useMarkets } from "@/lib/v2/hooks";
import { displaySourceLine, pickDisplaySpot, useDisplaySpots, type DisplaySpot } from "@/lib/v2/displaySpot";
import { NEW_YORK_TIME_ZONE } from "@/lib/v2/time";
import { useViewerTimeZone } from "@/components/ui/Time";

export { putTickers };

function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const timer = window.setInterval(tick, 15_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

const spotText = (spot: Money) => withDollar(displayPrice(BigInt(spot.raw), spot.decimals));

/**
 * DISPLAY ONLY: a ticker card's price. The API spot when present (unchanged), else the server's fallback
 * (Chainlink, pool or last good price, lib/v2/displaySpot.ts) with a plain source line, else "Price unavailable".
 * The line's time is in `timeZone`: the reader's, New York until it is known.
 */
export function cardPriceView(card: TickerCard, fallback: DisplaySpot | undefined, now: number, timeZone: string):
  { price: string; fallbackLine: string | null } {
  const shown = pickDisplaySpot(card.spot?.raw, card.spotUpdatedAt, fallback);
  if (!shown) return { price: "Price unavailable", fallbackLine: null };
  if (card.spot && shown.source === "api") return { price: spotText(card.spot), fallbackLine: null };
  const line = displaySourceLine(shown, now, timeZone);
  return { price: withDollar(displayPrice(shown.raw, 6)), fallbackLine: `${line.charAt(0).toUpperCase()}${line.slice(1)}` };
}

export function TickerCards({ cards, fallback, now: tick = null, selected = null, onSelect }: {
  cards: readonly TickerCard[]; fallback?: ReadonlyMap<string, DisplaySpot>;
  now?: number | null;
  selected?: string | null;
  onSelect?: (ticker: string) => void;
}) {
  const zone = useViewerTimeZone() ?? NEW_YORK_TIME_ZONE;
  const [mounted] = useState(() => Math.floor(Date.now() / 1000));
  const now = tick ?? mounted;
  if (cards.length === 0) return null;
  return <ul className="grid w-full grid-cols-2 gap-3 lg:max-w-[560px] lg:justify-self-end" aria-label="Launch markets">
    {cards.map((card) => {
      const view = cardPriceView(card, fallback?.get(card.ticker), now, zone);
      const on = card.ticker === selected;
      const body = <>
        <span className="flex min-w-0 items-center gap-2 text-[17px] font-extrabold tracking-[-0.01em] text-ink"><TickerLogo ticker={card.ticker} />{card.ticker}</span>
        <span className="num text-[17px] font-semibold text-ink max-sm:col-span-2 sm:text-right">{view.price}</span>
        <span className="col-span-2 truncate text-[12.5px] text-ink-3" title={card.name}>{card.name.split(" • ")[0]} · Stock Token</span>
        {card.spotUpdatedAt === null && view.fallbackLine !== null ? <span className="col-span-2 truncate text-[12px] text-ink-3">
          {view.fallbackLine}
        </span> : null}
      </>;
      const box = cn("grid h-full min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 rounded-md border px-4 py-3.5 text-left no-underline transition-colors",
        "focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-accent/40",
        on ? "border-accent bg-accent-soft" : "border-line-2 bg-surface hover:border-ink-3");
      return <li key={card.ticker} className="min-w-0">
        {onSelect ? <button type="button" aria-pressed={on} className={box} onClick={() => onSelect(card.ticker)}>{body}</button>
          : <a href={`/${card.ticker.toLowerCase()}`} className={box}>{body}</a>}
      </li>;
    })}
  </ul>;
}

export function defaultMarket(markets: readonly { ticker: string; expiries?: readonly number[] }[], cards: readonly TickerCard[]): string | null {
  const soonest = (ticker: string) => Math.min(...(markets.find((market) => market.ticker === ticker)?.expiries ?? [Infinity]));
  return [...cards].sort((a, b) => soonest(a.ticker) - soonest(b.ticker))[0]?.ticker ?? null;
}

export function Marketplace() {
  const now = useNow();
  const markets = useMarkets();
  const displaySpots = useDisplaySpots();
  const [chosen, setChosen] = useState<string | null>(null);
  const cards = tickerCards(markets.data);
  const active = chosen !== null && cards.some((card) => card.ticker === chosen) ? chosen : defaultMarket(markets.data ?? [], cards);

  return <>
    <section aria-labelledby="buy-title" className="grid gap-6 pb-7 pt-8 sm:pt-10 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-end lg:gap-10">
      <div className="flex flex-col gap-3">
        <h1 id="buy-title" className="font-display text-[42px] font-extrabold leading-[0.98] tracking-[-0.045em] sm:text-[60px]">
          Options.<br /><span className="text-accent-text">On-Chain.</span>
        </h1>
      </div>
      <TickerCards cards={cards} fallback={displaySpots.data} now={now} selected={active} onSelect={setChosen} />
    </section>
    <div className="border-t border-line pt-6">
      {/* A failed read with nothing cached is not "loading". With a cached list the embedded page stays
          and its own market-data notice says the prices may be delayed. */}
      {active === null && markets.isError ? <Notice tone="warn" role="status" title="Live quotes are delayed.">
        Markets could not load.
        <Button size="xs" variant="ghost" className="ml-3" disabled={markets.isFetching}
          onClick={() => void markets.refetch()}>{markets.isFetching ? "Retrying…" : "Retry"}</Button>
      </Notice>
        : active !== null ? <MarketPage key={active} ticker={active} embedded />
        : <div role="status" aria-label="Loading markets" className="grid gap-2">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-14 animate-pulse rounded-md bg-surface-2" />)}
        </div>}
    </div>
  </>;
}
