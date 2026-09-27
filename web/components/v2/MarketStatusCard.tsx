import Link from "next/link";

import { Chip, InfoTip, StatusPill, TickerLogo, type MarketStatus } from "@/components/ui";
import type { V2Market } from "@/lib/markets";
import { displayPrice, withDollar } from "@/lib/numberFormat";
import {
  settlementModeLabel,
  settlementPayoutLabel,
  type MarketDirectoryAvailability,
  type MarketDirectoryRow,
} from "@/lib/v2/marketDirectory";
import { dailyWeekdaysLabel, expiriesAheadOf } from "@/lib/v2/presets";
import { Time } from "@/components/ui/Time";

/**
 * One market on /trust/markets, drawn to the Neon markets card: logo, ticker and name,
 * the status pill, the accepted oracle spot with its observation time, open series, and the settlement chips. The
 * listing cadence and the payout rule sit in the "?" beside their labels, where the
 * explanation belongs.
 *
 * EVERY VALUE IS READ, NONE IS COPIED FROM THE MOCKUP. The spot, its observation time, open series
 * and the settlement source count, wait and payout route come from the indexer's /v2/markets row (the
 * MarketDirectoryRow built by lib/v2/marketDirectory.ts). The source NAMES and the cadence come from the registry
 * ({@link registryFacts}), and a source-name chip is drawn only when the registry's count agrees with the indexer's.
 */

/** What the registry says about a market that the indexer's row does not carry. */
export type MarketStatusRegistryFacts = {
  /** The settlement sources the registry configures, in RegisterMarkets order: Chainlink first, then the pool. */
  sources: readonly string[];
  /** The listing cadence, e.g. "Daily, up to 6 days out"; null when the registry lists no expiries ahead. */
  cadence: string | null;
};

/**
 * The registry half of a card. Sources mirror how `script/v2/RegisterMarkets.s.sol` builds the oracle list: the
 * Chainlink feed always, and the Uniswap v3 pool when the market has one (NVDA and SPCX do; the launch
 * set). The cadence reads `expiriesAhead` from the market's overrides, else `v2.defaults` (`expiriesAheadOf` in
 * lib/v2/presets.ts, the rule the writer presets use); by default six daily closes and no weekly ladder.
 * SPCX lists its Friday closes only (weekly 2, daily 0), and the weekly-only line says Fridays. A
 * weekly expiry is the week's last trading day, which is Thursday in a week whose Friday is a market holiday.
 * NVDA lists its dailies on Mondays, Wednesdays and Fridays only, and its line names those days
 * (`dailyWeekdaysLabel`, from the registry's `dailyWeekdays`).
 */
export function registryFacts(market: Pick<V2Market, "feed" | "v2">): MarketStatusRegistryFacts {
  const sources: string[] = [];
  if (market.feed) sources.push("Chainlink");
  if (market.v2.univ3Pool) sources.push("Uniswap v3");
  const { weekly, daily } = expiriesAheadOf(market.v2.overrides);
  let cadence: string | null = null;
  if (daily > 0 && weekly > 0) cadence = `Daily and weekly, ${daily} daily ${daily === 1 ? "close" : "closes"} ahead`;
  else if (daily > 0) cadence = `${dailyWeekdaysLabel(market.v2.overrides) ?? "Daily"}, up to ${daily} ${daily === 1 ? "day" : "days"} out`;
  else if (weekly > 0) cadence = `Fridays only (the week's last trading day), up to ${weekly} ${weekly === 1 ? "week" : "weeks"} out`;
  return { sources, cadence };
}

/** A configured wait as a chip-sized figure: 21600 → "6h", 300 → "5m", 90 → "90s". */
export function compactWait(seconds: number): string {
  if (seconds > 0 && seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds > 0 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * The settlement chips, or null when the indexer has no settlement row for the market (nothing is inferred then).
 * `summary` is the long form ("2 sources · 6 hours fallback wait") that labels the chip group for a screen reader,
 * because "6h" read aloud is worse than the words.
 */
export function settlementChips(
  settlement: MarketDirectoryRow["settlement"],
  sources: readonly string[] = [],
): { chips: readonly string[]; summary: string } | null {
  const summary = settlementModeLabel(settlement);
  if (settlement === undefined || summary === null) return null;
  const count = settlement.sourceCount;
  const chips = [`${count} ${count === 1 ? "source" : "sources"}`];
  // Names only when the web registry and the indexer's count agree on how many there are; otherwise the count stands
  // alone. The indexer's count is ITS compiled registry (indexer/src/api/v2/markets.ts:275), not a chain read, so this
  // agreement shows the two registry copies match; it says nothing about what the oracle actually has registered.
  if (sources.length > 0 && sources.length === count) chips.push(sources.join(" + "));
  chips.push(`${compactWait(settlement.uncorroboratedDelayS)} ${count === 1 ? "uncorroborated" : "fallback"} wait`);
  return { chips, summary };
}

/** The four-word status vocabulary of the Neon pills; "checking" and "unavailable" are not market states. */
export function statusPillOf(availability: MarketDirectoryAvailability): MarketStatus | null {
  switch (availability) {
    case "live": return "live";
    case "coming-soon": return "soon";
    case "paused": return "paused";
    case "deferred": return "deferred";
    default: return null;
  }
}

const LABEL = "text-[11px] font-bold uppercase tracking-[0.08em] text-ink-3";

/** Shown on a live market whose minting the guardian has paused. */
export const MINT_PAUSED_NOTE = "Writing is paused. Resale asks and bids still trade.";

export function MarketStatusCard({ market, facts }: { market: MarketDirectoryRow; facts?: MarketStatusRegistryFacts }) {
  const pill = statusPillOf(market.availability);
  const settlement = settlementChips(market.settlement, facts?.sources);
  const payout = settlementPayoutLabel(market.settlement, market.puts === true);
  return <article
    aria-label={`${market.ticker} market`}
    data-slot="market-status-card"
    className="flex h-full min-w-0 flex-col gap-5 rounded-lg border border-line-2 bg-surface p-5 sm:p-6"
  >
    <div className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <TickerLogo ticker={market.ticker} className="text-[34px]" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-[22px] font-extrabold leading-none tracking-[-0.02em]">{market.ticker}</h2>
          {/* The registry name is the token's own, e.g. "NVIDIA • Robinhood Token"; nothing is appended to it. */}
          <p className="truncate text-[13px] text-ink-3" title={market.name}>{market.name}</p>
        </div>
      </div>
      {pill ? <StatusPill status={pill} />
        : <Chip tone={market.availability === "unavailable" ? "warn" : "neutral"} dot>{market.availabilityLabel}</Chip>}
    </div>

    {market.availability === "live" ? null : <p className="-mt-1 text-[13px] leading-relaxed text-ink-2">{market.availabilityDetail}</p>}
    {/* A mint pause leaves the market live for resale and bids, so it is a note, not a status. */}
    {market.availability === "live" && market.mintPaused ? <p data-slot="mint-paused"
      className="-mt-1 text-[13px] leading-relaxed text-ink-2">{MINT_PAUSED_NOTE}</p> : null}

    <dl className="grid grid-cols-2 gap-4 rounded-md border border-line bg-field px-4 py-3.5">
      <div className="flex min-w-0 flex-col gap-1">
        <dt className={LABEL}>Price</dt>
        <dd className="num text-[20px] font-semibold">
          {market.spot ? withDollar(displayPrice(BigInt(market.spot.raw), market.spot.decimals)) : "Unavailable"}
        </dd>
        {market.spotUpdatedAt !== null ? <dd className="text-xs text-ink-3">
          Observed <Time className="num" at={market.spotUpdatedAt} />
        </dd> : null}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <dt className={`${LABEL} flex items-center gap-1.5`}>
          Open series{facts?.cadence ? <InfoTip label="About open series">{facts.cadence}.</InfoTip> : null}
        </dt>
        <dd className="num text-[20px] font-semibold">{market.seriesOpen ?? "—"}</dd>
      </div>
    </dl>

    <div className="flex flex-col gap-2.5">
      <p className={`${LABEL} flex items-center gap-1.5`}>
        Settlement{payout ? <InfoTip label="About payouts">{payout}</InfoTip> : null}
      </p>
      {settlement ? <ul className="flex flex-wrap gap-2" aria-label={`Settlement: ${settlement.summary}`}>
        {settlement.chips.map((chip) => <li key={chip}
          className="rounded-pill border border-line-2 bg-field px-2.5 py-1.5 text-xs font-bold text-ink">{chip}</li>)}
      </ul> : <Chip tone="neutral" wrap className="self-start">Details unavailable</Chip>}
    </div>

    <div className="mt-auto border-t border-line pt-4">
      {market.tradeable
        ? <Link href={market.href} className="inline-flex min-h-11 items-center gap-1 text-sm font-bold text-accent-text hover:underline">
          Trade {market.ticker} <span aria-hidden="true">&nbsp;→</span>
        </Link>
        : <span className="inline-flex min-h-11 items-center text-xs font-semibold text-ink-3">Trading unavailable</span>}
    </div>
  </article>;
}
