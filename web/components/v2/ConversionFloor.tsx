"use client";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { readConversionFloorState, type ConversionFloorState } from "@/lib/v2/conversion";
import { V2_DEPLOYMENT } from "@/lib/v2/config";

export function ConversionFloorCopy({ state, unavailable = false }: {
  state?: ConversionFloorState; unavailable?: boolean;
}) {
  const message = state?.kind === "routed"
    ? `This market's current conversion floor is ${(state.floorBps / 100).toFixed(2)}% of the contract's reference value, including the route fee. The reference uses settlement price or an acceptable higher live spot. If conversion fails, you receive Stock Tokens.`
    : state?.kind === "unrouted"
      ? "This market has no USDG conversion route. Winning calls are paid in Stock Tokens."
      : state?.kind === "unset"
        ? "USDG conversion is disabled. Winning calls are paid in Stock Tokens."
        : unavailable
          ? "The market's payout route is unavailable. Winning calls may be paid in Stock Tokens."
          : "Checking this market's USDG conversion route. Winning calls are owed Stock Tokens.";
  return <p className="mt-2 text-xs text-ink-3">{message}</p>;
}

export function ConversionFloor({ underlying }: { underlying: string }) {
  const enabled = Boolean(V2_DEPLOYMENT.contracts.clearinghouse);
  const floor = useQuery({ queryKey: ["v2", "conversion-floor", underlying.toLowerCase()],
    queryFn: () => readConversionFloorState(underlying as Address), enabled,
    staleTime: 30_000, refetchInterval: 30_000, retry: 0 });
  return <ConversionFloorCopy state={!enabled ? { kind: "unset" } : floor.isError ? undefined : floor.data}
    unavailable={floor.isError} />;
}
