import { InfoTip } from "@/components/ui";

/**
 * The four things a first-time writer needs before depositing, in plain words: what they earn, when it
 * arrives, when they can take their collateral back, and the one risk. Calls are the launch path; the put wording
 * renders only while the market has puts enabled (EarnMarket forces calls otherwise).
 */
export type EarnFact = { label: string; short: string; value: string };

export function earnFacts(ticker: string, isPut: boolean): EarnFact[] {
  const asset = isPut ? "USDG" : `${ticker} Stock Tokens`;
  return [
    { label: "What you earn", short: "Premium in USDG",
      value: "Premium in USDG when a buyer fills your ask. There is no fixed APY: it depends on "
      + "the price you set and whether a buyer takes it." },
    { label: "When you get paid", short: "At the fill",
      value: "In the same transaction as the fill, into your Stonkhouse balance." },
    { label: "Taking it back", short: isPut ? "Free USDG, any time" : `Free ${ticker}, any time`,
      value: `Free ${asset} can be withdrawn any time. What backs a sold ${isPut ? "put" : "call"} `
      + "stays locked until that option expires and settles." },
    { label: "The risk", short: isPut ? "You cover falls below your strike" : "Gains above your strike go to the buyer",
      value: isPut
        ? `If ${ticker} ends below your strike (the price you agreed to buy at), you pay the difference from your USDG. `
          + "The premium covers part of it."
        : `If ${ticker} ends above your strike (the price you agreed to sell at), the gain above it goes to the buyer. `
          + "You keep the premium." },
  ];
}

export function EarnFacts({ ticker, isPut }: { ticker: string; isPut: boolean }) {
  return <section aria-label="How Earn works" className="mb-6">
    <dl className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {earnFacts(ticker, isPut).map((fact) => <div key={fact.label}
        className="min-w-0 rounded-md border border-line bg-surface px-3.5 py-3">
        <dt className="flex items-center gap-1.5 text-[12px] font-medium text-ink-3">{fact.label}
          <InfoTip label={`About ${fact.label.toLowerCase()}`} text={fact.value} /></dt>
        <dd className="mt-1 text-[14px] font-semibold leading-snug text-ink">{fact.short}</dd>
      </div>)}
    </dl>
  </section>;
}
