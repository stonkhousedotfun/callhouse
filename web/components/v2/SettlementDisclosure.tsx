import { InfoTip } from "@/components/ui";
import type { Market } from "@/lib/v2/api-types";

type SettlementMetadata = NonNullable<Market["settlement"]>;

function unit(value: number, singular: string): string {
  return `${value} ${singular}${value === 1 ? "" : "s"}`;
}

export function configuredWaitLabel(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;
  return [
    days ? unit(days, "day") : null,
    hours ? unit(hours, "hour") : null,
    minutes ? unit(minutes, "minute") : null,
    remainingSeconds ? unit(remainingSeconds, "second") : null,
  ].filter((part): part is string => part !== null).join(" ");
}

export function settlementDisclosure(
  settlement: SettlementMetadata | undefined,
  isPut: boolean,
  ticker: string,
): { timing: string; payout: string } {
  const timing = settlement === undefined
    ? "Settlement timing is unavailable. Watch the option's status after expiry."
    : settlement.sourceCount === 1
      ? `This market has one price source, so each settlement price waits about ${configuredWaitLabel(settlement.uncorroboratedDelayS)} before it is final. Missing prices or a safety hold can take longer.`
      : `This market has ${settlement.sourceCount} price sources. If one is missing or they disagree, the price waits about ${configuredWaitLabel(settlement.uncorroboratedDelayS)} before it is final. Missing prices or a safety hold can take longer.`;

  if (isPut) return { timing, payout: "Winning puts pay USDG." };

  const asset = `${ticker.toUpperCase()} Stock Tokens`;
  const route = settlement?.route;
  const routedPayout = `Winning calls are owed ${asset}. Unless you keep tokens, a listed Uniswap ${route?.venue === "v3" ? "v3" : "v4"} route tries to convert them to USDG; if that fails or pays too little, you get the tokens.`;
  const payout = settlement === undefined
    ? `Winning calls are owed ${asset}. Conversion details are unavailable; if conversion fails, you get the tokens.`
    : route === null
      ? `This market has no USDG conversion route configured, so winning calls pay ${asset}.`
      : routedPayout;
  return { timing, payout };
}

export function SettlementDisclosure({ settlement, isPut, ticker, className = "", heading = true }: {
  settlement: SettlementMetadata | undefined;
  isPut: boolean;
  ticker: string;
  className?: string;
  heading?: boolean;
}) {
  const copy = settlementDisclosure(settlement, isPut, ticker);
  if (!heading) return <div aria-label="Settlement and payout" className={`grid gap-2 ${className}`}>
    <p>{copy.payout}</p>
    <p>{copy.timing}</p>
  </div>;
  // The payout is the one line on the card; how long settlement can take is in the "?".
  return <div aria-label="Settlement and payout" className={className}>
    <p className="text-xs font-bold uppercase tracking-wide text-ink-3">Settlement and payout <InfoTip label="About settlement timing">{copy.timing}</InfoTip></p>
    <p className="mt-2 text-xs text-ink-2">{copy.payout}</p>
  </div>;
}
