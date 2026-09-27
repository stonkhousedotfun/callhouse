"use client";

import { useAccount, useWalletClient } from "wagmi";

import { USDG, USDG_DECIMALS } from "@/lib/contracts";
import { useNow } from "@/lib/hooks";
import { v2Markets } from "@/lib/markets";
import { V2_DEPLOYMENT, v2ConfigWarnings } from "@/lib/v2/config";
import { earnActionAvailability } from "@/lib/v2/earnAccess";
import { useConfig, useMarkets } from "@/lib/v2/hooks";
import { selectTradeSpot } from "@/lib/v2/marketSpot";

export function useWriteGate(ticker: string, typeChoice: "call" | "put" = "call") {
  const { address } = useAccount();
  const wallet = useWalletClient();
  const markets = useMarkets();
  const config = useConfig();
  const registryMarket = v2Markets().find((row) => row.ticker === ticker);
  const market = markets.data?.find((row) => row.ticker === ticker);
  const putsEnabled = market?.puts === true;
  const isPut = putsEnabled && typeChoice === "put";
  const underlying = registryMarket?.asset ?? null;
  const collateralAsset = isPut ? USDG : underlying;
  const nowSeconds = useNow();
  const spot = nowSeconds === 0 ? null
    : selectTradeSpot(market?.spot?.raw, markets.isError, 0, undefined, 0, true, nowSeconds * 1000);
  const spotDecimals = market?.spot?.decimals ?? USDG_DECIMALS;
  const mismatch = config.data ? [
    ...v2ConfigWarnings(config.data),
    ...(isPut && config.data.usdg.address.toLowerCase() !== USDG.toLowerCase() ? ["USDG address differs from this app."] : []),
  ] : [];
  const availability = earnActionAvailability({
    walletConnected: Boolean(address && wallet.data), assetConfigured: Boolean(collateralAsset),
    clearinghouseConfigured: Boolean(V2_DEPLOYMENT.contracts.clearinghouse),
    orderBookConfigured: Boolean(V2_DEPLOYMENT.contracts.orderBook),
    calendarConfigured: Boolean(V2_DEPLOYMENT.contracts.expiryCalendar),
    autoRollerConfigured: Boolean(V2_DEPLOYMENT.contracts.autoRoller),
    marketLive: market?.status === "live",
    marketMatchesRegistry: Boolean(market && underlying && market.underlying.toLowerCase() === underlying.toLowerCase()),
    indexerConfigHealthy: Boolean(config.data && mismatch.length === 0),
  });
  const canWrite = availability.newWritesReady && !markets.isError && spot !== null && (!isPut || market?.puts === true);
  return {
    address, wallet, markets, config, registryMarket, market, putsEnabled, isPut, underlying, collateralAsset,
    collateralDecimals: isPut ? 6 : 18, collateralLabel: isPut ? "USDG" : "Stock Tokens",
    nowSeconds, spot, spotDecimals, mismatch, availability, canWrite,
  };
}
