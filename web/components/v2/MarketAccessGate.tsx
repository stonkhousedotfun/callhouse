"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { LockedMarket } from "@/components/v2/LaunchCountdown";
import { MarketAccessPending, MarketAccessUnavailable, NotListedMarket } from "@/components/v2/NotListedMarket";
import type { V2MarketStatus } from "@/lib/markets";
import { readMarketEnabledOnChain } from "@/lib/v2/chainReads";
import { useMarkets } from "@/lib/v2/hooks";
import { marketAccess, type MarketEnablement } from "@/lib/v2/marketAccess";

/** Mounts market UI only after the released market is confirmed enabled. */
export function MarketAccessGate({ ticker, registered, releaseStatus, children }: {
  ticker: string;
  registered: boolean;
  releaseStatus: V2MarketStatus;
  children: ReactNode;
}) {
  const markets = useMarkets();
  const chain = useQuery({
    queryKey: ["v2", "marketEnabled", ticker],
    queryFn: () => readMarketEnabledOnChain(ticker),
    enabled: registered && releaseStatus === "live" && markets.isError,
    staleTime: 5_000,
    refetchInterval: 15_000,
    retry: 0,
  });

  let enablement: MarketEnablement;
  if (!registered || releaseStatus !== "live") enablement = "disabled";
  else if (!markets.isError && markets.data === undefined) enablement = "checking";
  else if (!markets.isError) {
    enablement = markets.data?.find((market) => market.ticker === ticker)?.status === "live" ? "enabled" : "disabled";
  } else if (chain.isPending) enablement = "checking";
  else if (chain.isError || chain.data === undefined) enablement = "unavailable";
  else enablement = chain.data ? "enabled" : "disabled";

  const access = marketAccess({ registered, releaseStatus, enablement });
  // Registered but not open: show the page faded with the on-chain countdown rather than hiding it.
  if (access.routeState === "not-listed") return registered ? <LockedMarket ticker={ticker}>{children}</LockedMarket> : <NotListedMarket ticker={ticker} />;
  if (access.routeState === "checking") return <MarketAccessPending ticker={ticker} />;
  if (access.routeState === "unavailable") return <MarketAccessUnavailable ticker={ticker} />;
  return children;
}
