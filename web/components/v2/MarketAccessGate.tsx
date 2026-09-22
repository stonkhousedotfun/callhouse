"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { LockedMarket, useLaunchGates } from "@/components/v2/LaunchCountdown";
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

  // THE CHAIN IS THE AUTHORITY ON WHETHER TRADING IS ENABLED, and this is the bug it fixes (2026-09-22).
  //
  // `/v2/markets` answered 200 with an EMPTY ARRAY while NVDA was enabled on chain. An empty list is not an
  // error, so `markets.isError` was false, `find(ticker)` was undefined, `status === "live"` was false, and
  // the market resolved to "disabled" -- while the chain read below, which would have said otherwise, never
  // ran at all: it is gated on `markets.isError`. The page rendered LOCKED with its own countdown reading
  // "LIVE - trading is enabled on chain" three lines underneath, because the countdown reads the chain and
  // the gate read the indexer.
  //
  // An indexer that does not list a market is ABSENCE OF EVIDENCE. `Clearinghouse.market(asset).enabled`,
  // already fetched by useLaunchGates for every launch market, is the fact itself, so it wins outright. A
  // market outside the launch set has no such gate and keeps the old path unchanged.
  const tradingOnChain = useLaunchGates().data?.trading[ticker];

  // Order matters. `registered` is a hard prerequisite -- an unregistered market has nothing to show. But the
  // chain now outranks `releaseStatus` too, because that flag is compiled into the bundle: a build made before
  // the registry flipped to "live" would keep the page locked no matter what the chain says, which is the same
  // contradiction from a second cause. Once a market is registered AND enabled on chain, it is tradeable, and
  // the app's own release flag is stale information rather than a decision.
  let enablement: MarketEnablement;
  if (!registered) enablement = "disabled";
  else if (tradingOnChain?.done) enablement = "enabled";
  else if (releaseStatus !== "live") enablement = "disabled";
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
