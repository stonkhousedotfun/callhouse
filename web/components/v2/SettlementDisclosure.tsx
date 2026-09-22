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
    ? "Settlement timing is unavailable for this market. Expiry alone does not complete settlement; follow the live series status."
    : settlement.sourceCount === 1
      ? `Market configuration lists one price source. Every candidate in this mode is uncorroborated and must wait about ${configuredWaitLabel(settlement.uncorroboratedDelayS)} before it can become final. Missing data or a hold can make settlement take longer.`
      : `Market configuration lists ${settlement.sourceCount} price sources. If a source is unavailable or the sources disagree, a candidate must wait about ${configuredWaitLabel(settlement.uncorroboratedDelayS)} before it can become final. Missing data or a hold can make settlement take longer.`;

  if (isPut) return { timing, payout: "Winning puts pay USDG." };

  const asset = `${ticker.toUpperCase()} Stock Tokens`;
  const route = settlement?.route;
  const routedPayout = route?.venue === "v3"
    ? `Winning calls are owed ${asset}. The market registry lists a Uniswap v3 fee-tier route that can attempt USDG conversion unless you choose in-kind payout; registry data does not prove the route is currently usable. A route failure or conversion-floor miss pays Stock Tokens in kind.`
    : `Winning calls are owed ${asset}. The market registry lists a Uniswap v4 pool route that can attempt USDG conversion unless you choose in-kind payout; registry data does not prove the route is currently usable. A route failure or conversion-floor miss pays Stock Tokens in kind.`;
  const payout = settlement === undefined
    ? `Winning calls are owed ${asset}. Payout-route data is unavailable, so this page cannot confirm whether USDG conversion is configured. If conversion is attempted but the route fails or misses its floor, payout stays in Stock Tokens.`
    : route === null
      ? `There is no USDG conversion route configured in the market registry; winning calls pay ${asset} in kind.`
      : routedPayout;
  return { timing, payout };
}

export function SettlementDisclosure({ settlement, isPut, ticker, className = "" }: {
  settlement: SettlementMetadata | undefined;
  isPut: boolean;
  ticker: string;
  className?: string;
}) {
  const copy = settlementDisclosure(settlement, isPut, ticker);
  return <div aria-label="Settlement and payout" className={className}>
    <p className="text-xs font-bold uppercase tracking-wide text-ink-3">Settlement and payout</p>
    <p className="mt-2 text-xs text-ink-2"><span className="font-semibold text-ink">Timing:</span> {copy.timing}</p>
    <p className="mt-1 text-xs text-ink-2"><span className="font-semibold text-ink">Payout:</span> {copy.payout}</p>
  </div>;
}
