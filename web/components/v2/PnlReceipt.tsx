import Link from "next/link";
import { txUrl } from "@/lib/chain";
import { APP_URL } from "@/lib/site";
import type { PnlResponse } from "@/lib/v2/api-types";
import { expiryLabel, receiptMoney, seriesTitle, sharesFromUnits } from "./PnlText";
import { PnlShareActions } from "./PnlShareActions";

export function PnlReceipt({ pnl }: { pnl: PnlResponse | null }) {
  if (!pnl) return <section className="mx-auto mt-12 max-w-3xl rounded-lg border border-line bg-surface p-7 shadow-soft sm:p-10">
    <p className="text-sm font-semibold uppercase tracking-[0.12em] text-accent-text">StonkHouse outcome</p>
    <h1 className="mt-3 font-display text-3xl font-extrabold">This outcome is unavailable</h1>
    <p className="mt-3 text-ink-2">The link may be incomplete, or the outcome feed may be temporarily unavailable.</p>
    <Link href="/" className="mt-6 inline-flex rounded-md bg-accent px-5 py-3 font-semibold text-accent-ink">Explore options</Link>
  </section>;
  const url = `${APP_URL}/pnl/${encodeURIComponent(pnl.id)}`;
  const multiple = pnl.multiple.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
  return <article className="mx-auto mt-10 max-w-4xl">
    <div className="rounded-lg border border-line bg-surface p-6 shadow-lift sm:p-10">
      <p className="text-sm font-semibold uppercase tracking-[0.12em] text-accent-text">Verified outcome · Robinhood Chain</p>
      <h1 className="mt-3 font-display text-3xl font-extrabold sm:text-5xl">{seriesTitle(pnl.series)}</h1>
      <p className="mt-2 text-ink-2">Position closed {expiryLabel(pnl.settledAt)} · {sharesFromUnits(pnl.units)} shares</p>
      <div className="mt-8 grid gap-5 rounded-md bg-accent-soft p-6 sm:grid-cols-[1fr_auto] sm:items-end">
        <div>
          <p className="text-sm font-semibold text-accent-text">Paid → value received</p>
          <p className="num mt-2 text-3xl font-bold text-ink sm:text-4xl">{receiptMoney(pnl.cost)} → {receiptMoney(pnl.payout)} <span className="text-xl">USDG value</span></p>
        </div>
        <p className="num font-display text-5xl font-extrabold text-accent-text">{multiple}×</p>
      </div>
      <p className="mt-5 font-semibold text-ink">Max loss was {receiptMoney(pnl.cost)} USDG.</p>
      <dl className="mt-8 grid gap-4 border-t border-line pt-6 text-sm sm:grid-cols-2">
        <div><dt className="text-ink-3">Strike</dt><dd className="num mt-1 font-semibold">${receiptMoney(pnl.series.strike)}</dd></div>
        <div><dt className="text-ink-3">{pnl.settlementPrice === null ? "Series expiry" : "Settlement price"}</dt>
          <dd className="num mt-1 font-semibold">{pnl.settlementPrice === null
            ? expiryLabel(pnl.series.expiry) : `$${receiptMoney(pnl.settlementPrice)}`}</dd></div>
        <div><dt className="text-ink-3">Holder</dt><dd className="num mt-1 break-all font-semibold">{pnl.holder}</dd></div>
        <div><dt className="text-ink-3">Closing transaction</dt><dd className="mt-1"><a className="break-all font-semibold text-accent-text underline" href={txUrl(pnl.tx)} target="_blank" rel="noopener noreferrer">View on explorer ↗</a></dd></div>
      </dl>
      <PnlShareActions pnl={pnl} url={url} />
    </div>
    <div className="mt-8 flex flex-wrap items-center justify-between gap-4">
      <p className="max-w-xl text-sm text-ink-2">{pnl.settlementPrice === null
        ? "This indexed outcome closed through resale before series settlement. The return shown is USDG value from sale proceeds; no settlement price exists yet. The transaction link shows the close on chain. Most options expire worthless."
        : "This receipt uses indexed trades and settlement data. The return can include sale proceeds and redemption payouts. Stock Tokens paid in kind are valued at the settlement price; the value shown does not mean all of it arrived as USDG. The transaction link shows how the position closed on chain. Most options expire worthless."}</p>
      <Link href="/" className="inline-flex min-h-11 items-center rounded-md bg-accent px-5 py-3 font-semibold text-accent-ink">Find your own {multiple}×</Link>
    </div>
  </article>;
}
