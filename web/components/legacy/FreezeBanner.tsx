"use client";

import { useReadContracts } from "wagmi";

import { Notice } from "@/components/ui";
import { accountFactoryAbi } from "@/lib/contracts";
import { LEGACY_MARKETS } from "@/lib/legacy";

/** The date comes from the generated registry; the halt state comes from the factories themselves. */
export function FreezeBanner({ dates }: { dates: Record<string, number | null> }) {
  const halted = useReadContracts({ contracts: LEGACY_MARKETS.map((market) => ({
    address: market.factory, abi: accountFactoryAbi, functionName: "writesHalted" as const,
  })), query: { enabled: LEGACY_MARKETS.length > 0, refetchInterval: 30_000 } });
  const frozen = LEGACY_MARKETS.flatMap((market, index) =>
    halted.data?.[index]?.status === "success" && halted.data[index].result === true ? [market.ticker] : []);
  const dated = LEGACY_MARKETS.flatMap((market) => {
    const unix = dates[market.ticker];
    return unix && unix > 0 ? [`${market.ticker}: ${new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric",
    }).format(new Date(unix * 1000))}`] : [];
  });
  return <Notice tone="warn" className="mb-6" title="New listings have moved to v2.">
    V1 pages remain open for existing accounts, settlement, withdrawals and buyer exercise.
    {frozen.length ? ` New writes are halted on chain for ${frozen.join(", ")}.` : " New v1 writes are not offered in this interface."}
    {dated.length ? ` Registry freeze date: ${dated.join(" · ")}.` : " No freeze date is recorded in the registry yet."}
  </Notice>;
}
