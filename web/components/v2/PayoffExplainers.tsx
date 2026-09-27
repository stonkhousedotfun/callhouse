import { putTickers } from "@/components/v2/trade/puts";
import { useMarkets } from "@/lib/v2/hooks";

/**
 * The two payoff explainers, final copy. PayoffExplainersView is pure markup (no state, no data) so the copy can
 * be pinned; PayoffExplainers reads the markets only to know whether a live market enables puts.
 */

export const SETTLEMENT_EXPLAINER = {
  title: "How settlement works",
  body: "Settles on the average price of the last 30 minutes before expiry (the 16:00 New York close), not the price at that moment. The price you slide stands in for that average.",
} as const;

export const PAYOUT_EXPLAINER = {
  title: "How you get paid",
  body: "A winning put pays USDG. A winning call pays Stock Tokens. Unless you choose to keep them, they are converted to USDG at no worse than about 3 % under the settlement price, or paid as tokens if that fails. Out of the money, both expire worthless and you lose what you paid.",
} as const;

/**
 * (no put surface while no live market enables puts). The same payout rule for calls
 * alone, shown until a live market's registry flag enables puts; PAYOUT_EXPLAINER comes back unchanged when one does.
 */
export const CALLS_PAYOUT_EXPLAINER = {
  title: "How you get paid",
  body: "A winning call pays Stock Tokens. Unless you choose to keep them, they are converted to USDG at no worse than about 3 % under the settlement price, or paid as tokens if that fails. Out of the money, it expires worthless and you lose what you paid.",
} as const;

function Explainer({ title, body }: { title: string; body: string }) {
  return <details className="group rounded-sm border border-line-2 bg-surface-2 px-3 py-2">
    <summary className="cursor-pointer list-none text-sm font-semibold text-ink [&::-webkit-details-marker]:hidden">
      <span className="mr-2 inline-block w-3 text-ink-3 group-open:hidden" aria-hidden="true">▸</span>
      <span className="mr-2 hidden w-3 text-ink-3 group-open:inline-block" aria-hidden="true">▾</span>
      {title}
    </summary>
    <p className="mt-2 text-xs leading-relaxed text-ink-2">{body}</p>
  </details>;
}

export function PayoffExplainersView({ className = "", anyPuts }: { className?: string; anyPuts: boolean }) {
  return <div className={`grid gap-2 sm:grid-cols-2 ${className}`} aria-label="How settlement and payout work">
    <Explainer {...SETTLEMENT_EXPLAINER} />
    <Explainer {...(anyPuts ? PAYOUT_EXPLAINER : CALLS_PAYOUT_EXPLAINER)} />
  </div>;
}

/** The ticket's explainers. Put copy shows only while a live market's registry flag enables puts (putTickers). */
export function PayoffExplainers({ className = "" }: { className?: string }) {
  const markets = useMarkets();
  return <PayoffExplainersView className={className} anyPuts={putTickers(markets.data).size > 0} />;
}
