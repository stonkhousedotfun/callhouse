/** The two explainers of design §2.6, final copy. Pure markup: no state, no data, so the copy can be pinned. */

export const SETTLEMENT_EXPLAINER = {
  title: "How settlement works",
  body: "This option settles on the average price of the last 30 minutes before expiry (the 16:00 New York close), from the market's price sources — not on the price at the moment of expiry. The price you slide here stands in for that average.",
} as const;

export const PAYOUT_EXPLAINER = {
  title: "How you get paid",
  body: "A winning put pays USDG. A winning call pays Stock Tokens (a fraction of a share). Unless you choose to keep tokens, the app tries to convert them to USDG at no worse than about 3 % under the settlement price and hands you the tokens if that is not possible. Out of the money, both expire worthless and you lose exactly what you paid.",
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

export function PayoffExplainers({ className = "" }: { className?: string }) {
  return <div className={`grid gap-2 sm:grid-cols-2 ${className}`} aria-label="How settlement and payout work">
    <Explainer {...SETTLEMENT_EXPLAINER} />
    <Explainer {...PAYOUT_EXPLAINER} />
  </div>;
}
