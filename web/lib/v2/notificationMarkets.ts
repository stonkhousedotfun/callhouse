import { liveV2Markets, v2Markets } from "@/lib/markets";

export const PLANNED_ALERT_MARKET_NOTE = "alerts start when this market is live";

const MISSING_MARKET_DATA_NOTE = "alerts are unavailable while this market is missing from market data";
const PAUSED_ALERT_MARKET_NOTE = "alerts are paused for this market";

export type AlertMarketOption = {
  ticker: string;
  disabled: boolean;
  note: string | null;
};

/**
 * Build the price-alert market list from the compiled registry and, when available, the indexer.
 * An unavailable indexer falls back to registry-live markets; a successful response (including an
 * empty one) narrows those markets so the editor cannot offer a ticker the notifier cannot observe.
 */
export function alertMarketOptions(apiTickers?: readonly string[]): readonly AlertMarketOption[] {
  const published = apiTickers === undefined
    ? null
    : new Set(apiTickers.map((ticker) => ticker.trim().toUpperCase()));
  const registryLive = liveV2Markets();
  const available = registryLive.filter((market) => published === null || published.has(market.ticker));
  const missing = registryLive.filter((market) => published !== null && !published.has(market.ticker));
  const planned = v2Markets().filter((market) => market.v2.status === "planned");
  const paused = v2Markets().filter((market) => market.v2.status === "paused");

  return [
    ...available.map((market) => ({ ticker: market.ticker, disabled: false, note: null })),
    ...missing.map((market) => ({ ticker: market.ticker, disabled: true, note: MISSING_MARKET_DATA_NOTE })),
    ...planned.map((market) => ({ ticker: market.ticker, disabled: true, note: PLANNED_ALERT_MARKET_NOTE })),
    ...paused.map((market) => ({ ticker: market.ticker, disabled: true, note: PAUSED_ALERT_MARKET_NOTE })),
  ];
}

export function alertMarketOptionsForQueryState(
  apiTickers: readonly string[] | undefined,
  isError: boolean,
): readonly AlertMarketOption[] {
  return alertMarketOptions(isError ? undefined : apiTickers);
}

export function enabledAlertTickers(options: readonly AlertMarketOption[]): readonly string[] {
  return options.filter((option) => !option.disabled).map((option) => option.ticker);
}
