"use client";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { readConversionFloor } from "@/lib/v2/conversion";
import { V2_DEPLOYMENT } from "@/lib/v2/config";

export function ConversionFloor({ underlying }: { underlying: string }) {
  const floor = useQuery({ queryKey: ["v2", "conversion-floor", underlying.toLowerCase()],
    queryFn: () => readConversionFloor(underlying as Address), enabled: Boolean(V2_DEPLOYMENT.contracts.clearinghouse),
    staleTime: 30_000, refetchInterval: 30_000, retry: 0 });
  return <p className="mt-2 text-xs text-ink-3">{!floor.isError && typeof floor.data === "number"
    ? `This market's current conversion floor is ${(floor.data / 100).toFixed(2)}% of the contract's reference value, including the route fee. The reference uses settlement price or an acceptable higher live spot. If conversion fails, you receive Stock Tokens.`
    : !floor.isError && floor.data === null ? "USDG conversion is disabled; call payouts remain in Stock Tokens."
      : "The market's conversion floor is unavailable. Call payouts may remain in Stock Tokens."}</p>;
}
