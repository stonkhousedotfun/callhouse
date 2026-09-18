"use client";

import { useState } from "react";

import { Button, Panel } from "@/components/ui";
import { fmtCountdown } from "@/lib/format";
import type { Card } from "@/lib/v2/api-types";
import { formatShareQuantity, formatUsdg, payoffCardView } from "@/lib/v2/payoffCard";
import type { TakerFeeParams } from "@/lib/v2/payoff";

const SIZES = [1n, 10n, 100n] as const;
const SIZE_LABELS = ["0.01", "0.1", "1"] as const;
const EXPIRY_DATE = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric" });

function PayoffGlyph({ isPut }: { isPut: boolean }) {
  return <svg viewBox="0 0 120 52" width="120" height="52" fill="none" aria-hidden="true" className="shrink-0 text-accent">
    <path d="M4 44H116" stroke="currentColor" strokeOpacity=".28" strokeWidth="1.5" />
    <path d="M60 8V48" stroke="currentColor" strokeOpacity=".28" strokeDasharray="3 3" />
    <path d={isPut ? "M5 6L58 42H116" : "M5 42H58L115 6"} stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="58" cy="42" r="3.5" fill="currentColor" />
  </svg>;
}

export function PayoffCard({ card, feeParams, now, quoteAsOf, featured = false, example = false, spotAvailable = true }: {
  card: Card;
  feeParams: TakerFeeParams | null;
  now: number | null;
  quoteAsOf: number | null;
  featured?: boolean;
  example?: boolean;
  spotAvailable?: boolean;
}) {
  const [units, setUnits] = useState<bigint>(1n);
  const view = payoffCardView(card, units, feeParams, now, quoteAsOf);
  const date = EXPIRY_DATE.format(new Date(card.series.expiry * 1000));
  const canBuy = !example && view.state === "live" && view.cost !== null;
  const target = card.target.formatted;
  const kind = card.series.isPut ? "put" : "call";

  return <Panel as="article" lift={featured} className={`flex h-full min-w-0 flex-col ${featured ? "gap-5 sm:gap-6" : "gap-4"}`}>
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="num text-xs font-semibold uppercase tracking-wide text-ink-3">{example ? "Example payoff" : card.series.ticker}</p>
        <h3 className="mt-1 font-display text-xl font-bold leading-tight sm:text-2xl">
          {card.series.ticker} ${card.series.strike.formatted} {kind}
        </h3>
        <p className="mt-1 text-sm text-ink-2">{example ? "Illustrative Friday" : `Expires ${date}`} · {card.series.tenor}</p>
      </div>
      <PayoffGlyph isPut={card.series.isPut} />
    </div>

    <div className="rounded-md bg-accent-soft px-4 py-3">
      <p className="num text-3xl font-bold leading-none text-accent-text sm:text-4xl">
        {(view.multiple ?? card.perUnit.multiple).toFixed(2)}×
        <span className="ml-2 font-body text-sm font-semibold">{card.series.isPut ? "at" : "estimated at"} ${target}</span>
      </p>
      <p className="mt-2 text-sm leading-snug text-ink-2">{view.cost === null ? "For 0.01 share: " : ""}{view.sentence}</p>
      {!card.series.isPut ? <p className="mt-2 text-xs text-ink-2">Winning calls are owed Stock Tokens. USDG conversion may deliver less or fall back to tokens.</p> : null}
    </div>

    <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
      <div><p className="text-ink-3">Spot</p><p className="num font-semibold">{spotAvailable && card.spot ? `$${card.spot.formatted}` : "Unavailable"}</p></div>
      <div><p className="text-ink-3">Time left</p><p className="num font-semibold" aria-label={`Expires ${date}`}>{example ? "Example" : now === null ? "—" : fmtCountdown(card.series.expiry, now)}</p></div>
      <div><p className="text-ink-3">Pay · max loss</p><p className="num font-semibold">{view.cost === null ? "Quote pending" : `${formatUsdg(view.cost)} USDG`}</p></div>
      <div><p className="text-ink-3">{card.series.isPut ? "Profit" : "Estimated profit"} at ${target}</p><p className="num font-semibold">{view.profitAtTarget === null ? "Quote pending" : `${formatUsdg(view.profitAtTarget)} USDG`}</p></div>
    </div>

    <div className="mt-auto border-t border-line pt-4">
      <p className="mb-2 text-xs font-semibold text-ink-2">Choose size in shares</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label={`Size for ${card.series.ticker} ${kind}`}>
        {SIZES.map((size, index) => <button key={size.toString()} type="button" onClick={() => setUnits(size)} aria-pressed={units === size}
          className={`num min-h-10 min-w-[4.5rem] rounded-sm border px-3 text-sm font-semibold transition-colors ${units === size ? "border-accent bg-accent-soft text-accent-text" : "border-line-2 bg-surface text-ink hover:bg-surface-2"}`}>
          {SIZE_LABELS[index]}
        </button>)}
      </div>
      <p className="mt-2 min-h-5 text-xs text-ink-2" role="status">
        {example ? "Illustration only · no live quote" : view.state === "thin" ? `Only ${view.availableShares} shares available at this price.`
          : view.state === "stale" ? "Quote is stale. Refreshing before a trade."
          : view.state === "cutoff" ? "This option has expired or entered settlement."
          : view.cost === null ? "Waiting for fee settings to price this size."
          : view.quotedAcrossLevels ? "Full-share quote spans the cheapest ask levels."
          : `${view.availableShares} shares available at this price.`}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canBuy ? <Button href={view.buyHref} size="sm">Buy {formatShareQuantity(units)}</Button>
          : <Button size="sm" disabled>{example ? "Example" : view.state === "cutoff" ? "Trading closed" : "Buy unavailable"}</Button>}
        {!example ? <Button href={`/${card.series.ticker.toLowerCase()}/${card.series.longId}`} size="sm" variant="ghost">View option</Button> : null}
      </div>
    </div>
  </Panel>;
}
