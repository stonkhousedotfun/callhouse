"use client";

import { useEffect, useState } from "react";

import { PayoffCard } from "@/components/v2/PayoffCard";
import { Button, Notice, Panel } from "@/components/ui";
import type { Card } from "@/lib/v2/api-types";
import { marketQuoteAsOf } from "@/lib/v2/marketSpot";
import { useCards, useConfig, useHeroCard, useMarkets } from "@/lib/v2/hooks";
import type { TakerFeeParams } from "@/lib/v2/payoff";

type Tenor = "all" | "daily" | "weekly";
type OptionType = "call" | "put";
type Sort = "multiple" | "expiry" | "volume";

function nextFriday(now: number): number {
  const date = new Date(now * 1000);
  const utcDay = date.getUTCDay();
  let days = (5 - utcDay + 7) % 7;
  if (days === 0 && date.getUTCHours() >= 20) days = 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + days, 20) / 1000;
}

/** Clearly labelled illustration, never passed to the trading link. */
function exampleCard(now: number): Card {
  const expiry = nextFriday(now);
  const money = (raw: string, formatted: string) => ({ raw, decimals: 6, formatted });
  return {
    series: { longId: "0", shortId: "1", ticker: "NVDA", underlying: "0x0000000000000000000000000000000000000000",
      isPut: false, strike: money("240000000", "240"), expiry, mintFeePpm: 0, mintFeesHeld: { raw: "0", decimals: 18, formatted: "0" }, mintFeesAccrued: { raw: "0", decimals: 18, formatted: "0" }, tenor: "weekly", mintCutoff: expiry - 1800, status: "open" },
    spot: money("220000000", "220"), ask: money("909100", "0.9091"), target: money("250000000", "250"),
    perUnit: { cost: money("10000", "0.01"), payoutAtTarget: money("90000", "0.09"), multiple: 9 },
    perShare: { cost: money("1000000", "1"), payoutAtTarget: money("9000000", "9"), multiple: 9 },
    maxLoss: "cost", unitsAvailable: "100", orderIds: [],
  };
}

function useNow(): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function feeParams(config: ReturnType<typeof useConfig>["data"]): TakerFeeParams | null {
  if (!config) return null;
  return { takerFeeFlat: BigInt(config.fees.takerFeeFlat.raw), takerFeeCapBps: config.fees.takerFeeCapBps };
}

function CardSkeleton({ featured = false }: { featured?: boolean }) {
  return <Panel role="status" aria-label="Loading payoff card" className={`animate-pulse ${featured ? "min-h-[420px]" : "min-h-[380px]"}`}>
    <div className="h-4 w-24 rounded bg-surface-2" />
    <div className="mt-4 h-7 w-52 rounded bg-surface-2" />
    <div className="mt-7 h-24 rounded-md bg-surface-2" />
    <div className="mt-5 grid grid-cols-2 gap-4"><div className="h-10 rounded bg-surface-2" /><div className="h-10 rounded bg-surface-2" /></div>
    <span className="sr-only">Loading payoff card</span>
  </Panel>;
}

export function Marketplace() {
  const [ticker, setTicker] = useState("");
  const [tenor, setTenor] = useState<Tenor>("all");
  const [type, setType] = useState<OptionType>("call");
  const [sort, setSort] = useState<Sort>("multiple");
  const now = useNow();
  const hero = useHeroCard();
  const markets = useMarkets();
  const config = useConfig();
  const selectedMarket = markets.data?.find((market) => market.ticker === ticker);
  const supportsPuts = ticker ? Boolean(selectedMarket?.puts) :
    Boolean(markets.data?.some((market) => market.puts && market.status === "live"));
  const activeType = supportsPuts ? type : "call";
  const cards = useCards({ ticker: ticker || undefined, tenor: tenor === "all" ? undefined : tenor,
    type: activeType, sort, limit: 200 });
  const fees = feeParams(config.data);
  const featured = !hero.isError ? hero.data?.card : null;
  const example = !featured && !hero.isPending && now !== null ? exampleCard(now) : null;
  const heroCard = featured ?? example;
  const heroMultiple = featured ? (hero.data?.maxMultiple ?? featured.perUnit.multiple) : 9;

  return <>
    <section aria-labelledby="marketplace-title" className="pt-8 sm:pt-12">
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(360px,0.9fr)] lg:gap-12">
        <div className="pt-2">
          <p className="text-sm font-bold uppercase tracking-[.15em] text-accent-text">Buy an outcome</p>
          <h1 id="marketplace-title" className="mt-4 max-w-[15ch] font-display text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-6xl">
            {featured ? <>Potential <span className="num">{heroMultiple.toFixed(1)}×</span> at the target. Lose at most what you pay.</>
              : "Know your upside. Know your max loss."}
          </h1>
          <p className="mt-5 max-w-xl text-lg text-ink-2">Choose a Stock Token option by the payout you want. Every live quote includes fees and shows your max loss before you buy.</p>
          {example ? <p className="mt-3 rounded-sm bg-warn-soft px-3 py-2 text-sm font-semibold text-warn" role="status">Example — live quotes are unavailable or no option has enough depth for the hero.</p> : null}
          <Button href="#options" className="mt-7">Explore live options</Button>
        </div>
        <div className="min-w-0">
          {heroCard ? <PayoffCard key={`${heroCard.series.longId}-${featured ? "live" : "example"}`} card={heroCard} featured example={!featured}
            spotAvailable={!featured || marketQuoteAsOf(featured.series.ticker, Math.floor(hero.dataUpdatedAt / 1000), markets.isError ? undefined : markets.data) !== null}
            now={now} feeParams={featured ? fees : { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 }}
            quoteAsOf={featured ? marketQuoteAsOf(featured.series.ticker, Math.floor(hero.dataUpdatedAt / 1000), markets.isError ? undefined : markets.data) : now} />
            : <CardSkeleton featured />}
        </div>
      </div>
    </section>

    <section id="options" aria-labelledby="options-title" className="scroll-mt-10 pt-16 sm:pt-20">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div><p className="text-sm font-bold uppercase tracking-[.15em] text-accent-text">Marketplace</p>
          <h2 id="options-title" className="mt-2 font-display text-3xl font-bold">Find your payoff</h2>
          <p className="mt-2 text-sm text-ink-2">Available asks, refreshed every 15 seconds.</p></div>
        <label className="flex items-center gap-2 text-sm font-semibold">Sort by
          <select value={sort} onChange={(event) => setSort(event.target.value as Sort)} className="min-h-10 rounded-sm border border-line-2 bg-surface px-3 text-ink">
            <option value="multiple">Highest multiple</option><option value="expiry">Soonest</option><option value="volume">Most traded</option>
          </select>
        </label>
      </div>
      <div className="mt-6 flex flex-wrap gap-3 border-b border-line pb-5">
        <label className="flex items-center gap-2 text-sm font-semibold">Market
          <select value={ticker} onChange={(event) => { setTicker(event.target.value); setType("call"); }} className="min-h-10 rounded-sm border border-line-2 bg-surface px-3 text-ink">
            <option value="">All markets</option>
            {markets.data?.filter((market) => market.status === "live").map((market) => <option key={market.ticker} value={market.ticker}>{market.ticker}</option>)}
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Expiry type">
          {(["all", "daily", "weekly"] as const).map((value) => <button key={value} type="button" aria-pressed={tenor === value} onClick={() => setTenor(value)}
            className={`min-h-10 rounded-sm border px-3 text-sm font-semibold ${tenor === value ? "border-accent bg-accent-soft text-accent-text" : "border-line-2 bg-surface text-ink hover:bg-surface-2"}`}>
            {value === "all" ? "All expiries" : value === "daily" ? "Daily" : "Weekly"}
          </button>)}
        </div>
        {supportsPuts ? <div className="flex items-center gap-2" role="group" aria-label="Option type">
          {(["call", "put"] as const).map((value) => <button key={value} type="button" aria-pressed={activeType === value} onClick={() => setType(value)}
            className={`min-h-10 rounded-sm border px-3 text-sm font-semibold ${activeType === value ? "border-accent bg-accent-soft text-accent-text" : "border-line-2 bg-surface text-ink hover:bg-surface-2"}`}>
            {value === "call" ? "Calls" : "Puts"}
          </button>)}
        </div> : null}
      </div>
      {cards.isError ? <Notice tone="warn" role="status" className="mt-5" title="Live quotes are delayed.">
        {cards.data ? "Showing the latest available cards." : "The marketplace feed is unavailable. Try again shortly."}
        <Button size="xs" variant="ghost" className="ml-3" onClick={() => void cards.refetch()}>Retry</Button>
      </Notice> : null}
      {cards.isPending && !cards.data ? <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><CardSkeleton /><CardSkeleton /><CardSkeleton /></div>
        : cards.data?.items.length ? <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cards.data.items.map((card) => <li key={card.series.longId} className="min-w-0">
            <PayoffCard card={card} now={now} feeParams={fees}
              spotAvailable={marketQuoteAsOf(card.series.ticker, cards.data!.generatedAt, markets.isError ? undefined : markets.data) !== null}
              quoteAsOf={cards.isError ? null : marketQuoteAsOf(card.series.ticker, cards.data!.generatedAt, markets.isError ? undefined : markets.data)} />
          </li>)}
        </ul> : cards.isError ? null : <Panel className="mt-6"><h3 className="font-display text-xl font-bold">No asks right now</h3>
          <p className="mt-2 text-ink-2">No options match these filters. Try another market or expiry, or check back when makers post new asks.</p>
          <Button size="sm" variant="ghost" className="mt-4" onClick={() => { setTicker(""); setTenor("all"); setType("call"); }}>Clear filters</Button>
        </Panel>}
    </section>

    <section aria-labelledby="how-it-works-title" className="pt-16 sm:pt-20">
      <h2 id="how-it-works-title" className="font-display text-3xl font-bold">How it works</h2>
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        {[
          ["1", "Choose a payoff", "Compare the strike, expiry, target payout, and live ask."],
          ["2", "Pick your size", "Start at 0.01 share. See the full cost, including fees, and your max loss."],
          ["3", "See the outcome", "At expiry, settlement determines your payout. You can lose the full amount paid."],
        ].map(([step, title, body]) => <Panel key={step}>
          <span className="num text-xl font-bold text-accent-text">{step}</span><h3 className="mt-3 font-display text-lg font-bold">{title}</h3>
          <p className="mt-2 text-sm text-ink-2">{body}</p>
        </Panel>)}
      </div>
    </section>
    <section className="mt-16 rounded-lg bg-ink px-6 py-8 text-ground sm:mt-20 sm:flex sm:items-center sm:justify-between sm:gap-6 sm:px-9">
      <div><p className="text-sm font-bold uppercase tracking-wide text-ground/70">For Stock Token holders</p>
        <h2 className="mt-2 font-display text-2xl font-bold text-ground">Hold Stock Tokens? Set your ask for covered calls.</h2>
        <p className="mt-2 text-sm text-ground/80">Set your own asking price. Premium arrives when a buyer fills; your upside above the strike is capped.</p></div>
      <Button href="/earn" variant="inverse" className="mt-5 sm:mt-0">Explore Earn</Button>
    </section>
  </>;
}
