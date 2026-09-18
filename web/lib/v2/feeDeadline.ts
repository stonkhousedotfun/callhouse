/**
 * A take quoted under today's OrderBook fees must expire before a scheduled change.
 * OrderBook checks the deadline at execution, so a transaction mined after the
 * activation boundary reverts instead of filling under an unseen fee schedule.
 * `now` is the timestamp of the chain block used to read the quote; `effectiveAt`
 * comes from OrderBook.pendingFeeParams at that block, not the API or a host clock.
 */
export function feeBoundTakeDeadline(now: number, effectiveAt: bigint | null, quoteLifetimeSeconds = 300): number {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(quoteLifetimeSeconds) || quoteLifetimeSeconds <= 0)
    throw new RangeError("Invalid quote clock or lifetime");
  const normal = now + quoteLifetimeSeconds;
  if (effectiveAt === null || effectiveAt <= BigInt(now) || effectiveAt > BigInt(normal)) return normal;
  return Number(effectiveAt) - 1;
}
