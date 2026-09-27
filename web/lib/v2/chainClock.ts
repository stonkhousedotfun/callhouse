/**
 * The chain's clock for the pages' deadline pre-checks.
 *
 * Every deadline the contracts enforce (a series expiry, an order's validUntil, a House epoch's cutoff) is judged
 * against `block.timestamp`, not the browser's clock. A browser clock that runs behind the chain keeps a button open
 * past a deadline the chain has already passed; one that runs ahead shuts it early. The pages keep their own one-second
 * or thirty-second ticks for countdowns (those are display), and add this offset only where a tick decides whether an
 * action is still allowed.
 *
 * The offset is measured, never assumed: the latest block's timestamp minus the wall clock at the moment it arrived.
 * Unread or unreadable is null, and a pre-check with a null clock stays shut (every caller already treats a null `now`
 * as "not yet known").
 */
import { useQuery } from "@tanstack/react-query";
import type { PublicClient } from "viem";

import { publicClient } from "../chain";
import { chainNow } from "./tx";

/** Chain seconds minus wall seconds, measured when `chainSeconds` was read at wall time `wallMs`. */
export function chainClockOffset(chainSeconds: number, wallMs: number): number {
  return chainSeconds - Math.floor(wallMs / 1000);
}

/** A wall-clock tick in seconds moved onto the chain's clock; null while either is unknown. */
export function onChainClock(wallSeconds: number | null, offset: number | null | undefined): number | null {
  return wallSeconds === null || offset === null || offset === undefined ? null : wallSeconds + offset;
}

/** Reads the latest block and returns its clock offset from this browser's. */
export async function readChainClockOffset(client: PublicClient = publicClient, wallMs: () => number = Date.now): Promise<number> {
  return chainClockOffset(await chainNow(client), wallMs());
}

/** The offset for the pre-checks, re-measured every minute. Null until the first block read answers. */
export function useChainClockOffset(): number | null {
  const offset = useQuery({
    queryKey: ["v2", "chain-clock-offset"],
    queryFn: () => readChainClockOffset(),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  return offset.data ?? null;
}
