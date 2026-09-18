import type { Address } from "viem";

/** Calendar policy is mutable and Ponder replays after reorgs. Cache repeated strikes within
 * the same block, then discard at the next block hash rather than retaining stale verdicts. */
const weeklyByCalendarExpiry = new Map<string, boolean>();
let cachedBlockHash: string | null = null;

export async function weeklyAtExpiry(
  calendar: Address,
  expiry: bigint,
  blockHash: string,
  read: () => Promise<boolean>,
): Promise<boolean> {
  if (cachedBlockHash !== blockHash) {
    weeklyByCalendarExpiry.clear();
    cachedBlockHash = blockHash;
  }
  const key = `${calendar.toLowerCase()}-${expiry}`;
  const previous = weeklyByCalendarExpiry.get(key);
  if (previous !== undefined) return previous;
  const weekly = await read();
  weeklyByCalendarExpiry.set(key, weekly);
  return weekly;
}

export function clearCalendarCache(): void {
  weeklyByCalendarExpiry.clear();
  cachedBlockHash = null;
}
