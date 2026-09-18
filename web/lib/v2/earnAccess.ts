export type EarnActionInputs = {
  walletConnected: boolean;
  assetConfigured: boolean;
  clearinghouseConfigured: boolean;
  orderBookConfigured: boolean;
  calendarConfigured: boolean;
  autoRollerConfigured: boolean;
  marketLive: boolean;
  marketMatchesRegistry: boolean;
  indexerConfigHealthy: boolean;
};

/** Exits depend on compiled contract addresses and the wallet, not the indexer or market status. */
export function earnActionAvailability(input: EarnActionInputs) {
  const exitReady = input.walletConnected && input.assetConfigured && input.clearinghouseConfigured;
  const pauseReady = exitReady && input.autoRollerConfigured;
  const newWritesReady = exitReady && input.orderBookConfigured && input.calendarConfigured &&
    input.marketLive && input.marketMatchesRegistry && input.indexerConfigHealthy;
  return { exitReady, pauseReady, newWritesReady };
}
