import Link from "next/link";
import { InfoTip, TickerLogo } from "@/components/ui";
import { txUrl } from "@/lib/chain";
import { APP_URL } from "@/lib/site";
import type { Money, PnlResponse } from "@/lib/v2/api-types";
import type { ChartInput } from "@/lib/v2/payoffChart";
import { formatPriceExact } from "@/lib/v2/payoffFormat";
import { PayoffChart } from "./PayoffChart";
import { imageMoney, multipleText, pnlShareText, seriesTitle } from "./PnlText";

/**
 * The win receipt: a 600 × 760 share card with the option, the
 * realised multiple at 140px, paid → got, a static mini payoff chart with the exit marked, entry / exit / wallet,
 * Share on X, View on explorer and the disclaimer. Every figure comes from the indexed outcome; nothing from the
 * mockup's illustrative data ships. The OG image draws the same card from the same view (PnlImage).
 */

export type ReceiptView = {
  /** "RECEIPT #8b4d": the first four hex digits of the closing transaction. */
  receiptNo: string;
  /** "NVDA $214 call · Fri 18 Sep". */
  option: string;
  /** "6.54×". The realised ratio: USDG value got ÷ USDG paid. A fact, not a scenario. */
  multiple: string;
  multipleLabel: string;
  /** "Paid 0.75 USDG → got 4.85 USDG value": the cost rounded up, the value rounded down (the explorer's rule). */
  paidGot: string;
  entry: string;
  exit: string;
  wallet: string;
  /** Null when a figure the chart needs is missing or not USDG-6. `caption` names the dot; `legend` (in the "?")
   * names the lines. */
  chart: { input: ChartInput; price: bigint; caption: string; legend: string } | null;
};

export const RECEIPT_DISCLAIMER = "Most options expire worthless.";
export const MULTIPLE_LABEL = "Realised: value got ÷ paid";

const USDG_DECIMALS = 6;
const usdg6 = (money: Money | null): bigint | null =>
  money !== null && money.decimals === USDG_DECIMALS && /^\d+$/.test(money.raw) ? BigInt(money.raw) : null;

/** "Fri 18 Sep", in New York time like every other expiry label. */
export function receiptDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", day: "numeric", month: "short" })
    .formatToParts(new Date(timestamp * 1000));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")}`;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function receiptView(pnl: PnlResponse): ReceiptView {
  const { series } = pnl;
  const spot = usdg6(pnl.spotAtEntry);
  const settlement = usdg6(pnl.settlementPrice);
  const strike = usdg6(series.strike);
  const cost = usdg6(pnl.cost);
  const units = /^\d+$/.test(pnl.units) ? BigInt(pnl.units) : 0n;
  let chart: ReceiptView["chart"] = null;
  if (strike !== null && strike > 0n && cost !== null && units > 0n) {
    // The exit is the settlement price when the series settled; a position sold before expiry has no exit PRICE,
    // so the dot marks the entry price instead and the caption says so.
    const price = settlement ?? spot ?? strike;
    const caption = settlement !== null
      ? `Dot: settled at $${formatPriceExact(settlement)}.`
      : spot !== null
        ? `Sold before expiry. Dot: entry price $${formatPriceExact(spot)}.`
        : "Sold before expiry.";
    const legend = `${settlement !== null && spot !== null ? `Dotted: entry price $${formatPriceExact(spot)}. ` : ""}Dashed: value at expiry. Red: what was paid.`;
    chart = {
      input: {
        ticker: series.ticker, isPut: series.isPut, strike, units, spot, cost,
        // No live quote on a receipt: the chart draws the exact expiry value only, no before-expiry estimate.
        premium: null, exerciseFeeBps: null, expiry: series.expiry, now: pnl.settledAt,
      },
      price,
      caption,
      legend,
    };
  }
  return {
    receiptNo: `RECEIPT #${pnl.tx.replace(/^0x/, "").slice(0, 4).toLowerCase()}`,
    option: `${seriesTitle(series)} · ${receiptDate(series.expiry)}`,
    multiple: multipleText(pnl.multiple),
    multipleLabel: MULTIPLE_LABEL,
    paidGot: `Paid ${imageMoney(pnl.cost, "up")} USDG → got ${imageMoney(pnl.payout, "down")} USDG value`,
    entry: spot === null ? "—" : `${series.ticker} $${formatPriceExact(spot)}`,
    exit: settlement === null ? "Sold early" : `Settled $${formatPriceExact(settlement)}`,
    wallet: shortAddress(pnl.holder),
    chart,
  };
}

export function BrandMark({ size = 26 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true">
    <rect width="26" height="26" rx="8" fill="var(--accent)" />
    <path d="M7 15 12 8.7 14.7 11.6 19 6v2l-4.1 6.1-2.8-2.9L8.4 15Z" fill="var(--accent-ink)" />
    <rect x="6" y="16.5" width="14" height="2.5" rx="1" fill="var(--accent-ink)" />
  </svg>;
}

export function PnlReceipt({ pnl }: { pnl: PnlResponse | null }) {
  if (!pnl) return <section className="mx-auto mt-12 flex w-full max-w-[600px] flex-col gap-4 rounded-lg border border-line-2 bg-ground p-6 sm:p-10">
    <span className="flex items-center gap-2.5 text-lg font-extrabold tracking-[-0.02em]"><BrandMark /> stonkhouse</span>
    <h1 className="font-display text-3xl font-extrabold tracking-[-0.03em]">This outcome is unavailable</h1>
    <p className="text-ink-2">Check the link, or try again in a moment.</p>
    <Link href="/" className="inline-flex min-h-11 w-fit items-center rounded-pill bg-accent px-6 py-3 font-extrabold text-accent-ink">Explore options</Link>
  </section>;
  const view = receiptView(pnl);
  const url = `${APP_URL}/pnl/${encodeURIComponent(pnl.id)}`;
  const xIntent = `https://x.com/intent/post?${new URLSearchParams({ text: pnlShareText(pnl), url })}`;
  const imageUrl = `/api/pnl/${encodeURIComponent(pnl.id)}/image?format=square`;
  return <article className="mx-auto mt-10 flex w-full max-w-[600px] flex-col gap-6">
    <div className="flex w-full flex-col gap-[22px] rounded-lg border border-line-2 bg-ground p-6 text-ink sm:min-h-[760px] sm:p-10">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2.5 text-lg font-extrabold tracking-[-0.02em]"><BrandMark /> stonkhouse</span>
        <span className="font-mono text-xs text-ink-3">{view.receiptNo}</span>
      </div>
      <div className="flex flex-col gap-1.5 pt-4">
        <h1 className="flex items-center gap-2 text-base font-bold text-ink-2"><TickerLogo ticker={pnl.series.ticker} />{view.option}</h1>
        <p className="font-display text-[88px] font-extrabold leading-[0.9] tracking-[-0.06em] text-accent-text sm:text-[140px]">{view.multiple}</p>
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-ink-3">{view.multipleLabel}</p>
        <p className="text-lg font-bold">{view.paidGot}</p>
      </div>
      {view.chart ? <figure className="flex flex-col gap-2">
        <PayoffChart input={view.chart.input} variant="mini" price={view.chart.price} />
        <figcaption className="flex items-center gap-2 text-xs text-ink-3">{view.chart.caption}
          <InfoTip label="About the chart">{view.chart.legend}</InfoTip></figcaption>
      </figure> : null}
      <dl className="grid grid-cols-3 gap-3 border-t border-line pt-[18px] text-xs text-ink-3">
        <div className="flex flex-col gap-1"><dt>Entry</dt><dd className="font-mono text-[15px] text-ink">{view.entry}</dd></div>
        <div className="flex flex-col gap-1"><dt>Exit</dt><dd className="font-mono text-[15px] text-ink">{view.exit}</dd></div>
        <div className="flex flex-col gap-1"><dt>Wallet</dt><dd className="font-mono text-[15px] text-ink" title={pnl.holder}>{view.wallet}</dd></div>
      </dl>
      <div className="mt-auto flex gap-2.5">
        <a href={xIntent} target="_blank" rel="noopener noreferrer"
          className="flex min-h-11 flex-1 items-center justify-center rounded-pill bg-accent px-4 py-[15px] text-[15px] font-extrabold text-accent-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">Share on X</a>
        <a href={txUrl(pnl.tx)} target="_blank" rel="noopener noreferrer" aria-label="Closing transaction: view on explorer"
          className="flex min-h-11 flex-1 items-center justify-center rounded-pill border border-line-2 bg-surface px-4 py-[15px] text-[15px] font-bold text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">View on explorer</a>
      </div>
      <p className="text-[11px] text-ink-3">{RECEIPT_DISCLAIMER}</p>
    </div>
    <div className="flex flex-col gap-3 text-sm text-ink-2">
      {pnl.settlementPrice === null
        ? <p>Closed by resale before settlement, so the value is the sale proceeds.</p>
        : <p className="flex items-center gap-2">The value can include sale proceeds and the settlement payout.
          <InfoTip label="About this value">Stock Tokens paid in kind are valued at the settlement price, so not all of it
            arrived as USDG.</InfoTip></p>}
      <p>Closing transaction: <a className="font-mono break-all text-accent-text underline" href={txUrl(pnl.tx)} target="_blank" rel="noopener noreferrer">{shortAddress(pnl.tx)} ↗</a>
        {" · "}<a className="text-accent-text underline" href={imageUrl} download={`stonkhouse-${pnl.series.ticker.toLowerCase()}-outcome.png`}>Save image</a>
        {" · "}<a className="text-accent-text underline" href={url}>Link to this receipt</a></p>
      <Link href="/" className="inline-flex min-h-11 w-fit items-center rounded-pill bg-accent px-6 py-3 font-extrabold text-accent-ink">Find your own</Link>
    </div>
  </article>;
}
