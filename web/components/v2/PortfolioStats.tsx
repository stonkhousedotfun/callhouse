"use client";

import { InfoTip, SegmentedControl, Stat } from "@/components/ui";
import { fmtUsdg } from "@/lib/format";
import type { HistoryItem } from "@/lib/v2/api-types";
import type { summariseHistory } from "@/lib/v2/historySummary";
import { PNL_PERIODS, pnlPolyline, realisedPnlSeries, realisedPnlSince, type PnlPeriod } from "@/lib/v2/portfolio";

/**
 * The Portfolio hero and stat tiles.
 * Every figure is read from the wallet's indexed history through summariseHistory and the
 * lib/v2/portfolio helpers; the mockup's +12.40 / +4.62 and its chart shape are illustrative
 * and never ship.
 */

const CHART_W = 820;
const CHART_H = 120;
const WEEK = 7 * 86_400;

const signed = (raw: bigint) => `${raw > 0n ? "+" : raw < 0n ? "−" : ""}${fmtUsdg(raw < 0n ? -raw : raw)}`;

export const REALISED_PNL_HELP = "A USDG value, not necessarily USDG received. Net maker premium is a separate figure; do not add it to P&L.";

export function PortfolioHero({ items, realisedUsdg, period, onPeriod, now }: {
  items: readonly HistoryItem[];
  /** summariseHistory's total, so the hero and the Realised P&L tile can never disagree. */
  realisedUsdg: bigint;
  period: PnlPeriod;
  onPeriod: (period: PnlPeriod) => void;
  /** Unix seconds; null before the first client tick, when no window can be drawn. */
  now: number | null;
}) {
  const seconds = PNL_PERIODS.find((option) => option.id === period)!.seconds;
  const since = now === null || seconds === null ? null : now - seconds;
  const points = now === null ? [] : realisedPnlSeries(items, since);
  const line = pnlPolyline(points, CHART_W, CHART_H);
  const week = now === null ? null : realisedPnlSince(items, now - WEEK);
  const last = line ? line.split(" ").at(-1)!.split(",").map(Number) : null;
  const periodLabel = period === "1W" ? "the last week" : period === "1M" ? "the last month" : "all loaded activity";

  return <section aria-labelledby="portfolio-pnl-title" className="flex flex-col gap-4">
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-col gap-2">
        <h2 id="portfolio-pnl-title" className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-3">Realised P&amp;L · USDG value
          <InfoTip label="About realised P&L" align="start" text={REALISED_PNL_HELP} /></h2>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p data-slot="pnl-hero" className={`num text-[38px] font-extrabold leading-none tracking-[-0.045em] sm:text-[48px] ${
            realisedUsdg < 0n ? "text-danger-text" : "text-ink"}`}>{signed(realisedUsdg)}<small
            className="ml-1.5 text-[15px] font-semibold tracking-normal text-ink-3">USDG</small></p>
          {week !== null ? <p className="text-[14px] font-semibold">
            <span className={week < 0n ? "text-danger-text" : "text-accent-text"}>{signed(week)}</span>{" "}
            <span className="font-medium text-ink-3">this week</span></p> : null}
        </div>
      </div>
      <SegmentedControl label="Realised P&L period" options={PNL_PERIODS.map(({ id, label }) => ({ value: id, label }))}
        selected={period} onSelect={onPeriod} />
    </div>
    {line ? <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="h-[88px] w-full sm:h-[104px]" preserveAspectRatio="none"
      role="img" aria-label={`Realised P and L over ${periodLabel}`}>
      <line x1="0" y1={CHART_H - 8} x2={CHART_W} y2={CHART_H - 8} className="stroke-line-2" strokeDasharray="2 5" />
      <polyline fill="none" className="stroke-accent" strokeWidth="2.5" strokeLinejoin="round" points={line}
        vectorEffect="non-scaling-stroke" />
      {last ? <circle cx={last[0]} cy={last[1]} r="5" className="fill-accent" /> : null}
    </svg>
      : <div data-slot="pnl-empty" className="flex h-16 items-center max-sm:h-12 justify-center rounded-md border border-dashed border-line-2 text-[13px] text-ink-3">
        {now === null ? "Loading your realised P&L…" : "No realised P&L in this period yet."}
      </div>}
  </section>;
}

/**
 * The fee tile names put mints only while a live market enables puts. `anyPuts` is
 * the caller's `putTickers(markets.data).size > 0`; it defaults to calls-only.
 */
export function PortfolioStatTiles({ summary, anyPuts = false }: {
  summary: ReturnType<typeof summariseHistory>;
  anyPuts?: boolean;
}) {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const cell = "min-w-0 py-1 sm:px-5 sm:first:pl-0 sm:last:pr-0";
  return <div className="grid grid-cols-2 gap-x-3 gap-y-4 max-sm:[&>*:first-child]:col-span-2 sm:grid-cols-3 sm:gap-0 sm:divide-x sm:divide-line">
    <div data-tile="stat" className={cell}>
      <Stat size="sm" label={<span className="inline-flex items-center gap-1.5">Net maker premium <InfoTip label="About net maker premium"
        align="start">Premium from options you wrote that filled as your resting ask, after fees, with fill rebates added.</InfoTip></span>} value={fmtUsdg(summary.primaryMakerPremiumUsdg)} unit="USDG"
        title="Primary maker premium, net" />
    </div>
    <div data-tile="stat" className={cell}>
      <Stat size="sm" label={<span className="inline-flex items-center gap-1.5">Fees paid <InfoTip label="About fees paid">{`USDG fees this wallet paid. Leaves out ${
        plural(summary.mintFeesWithoutPayer, "mint row")} without payer identity and ${plural(summary.mintFeesPaidByAnother, "mint fee")
        } paid by another wallet. Stock Token amounts are never added to USDG.`}</InfoTip></span>}
        value={fmtUsdg(summary.feesPaidUsdg)} unit="USDG"
        sub={<>Fills {fmtUsdg(summary.fillFeesUsdg)}{anyPuts ? <> · put mints {fmtUsdg(summary.mintFeesUsdg)}</> : null}</>} />
    </div>
    <div data-tile="stat" className={cell}>
      <Stat size="sm" label="Fill rebates" value={fmtUsdg(summary.fillRebatesUsdg)} unit="USDG" />
    </div>
  </div>;
}
