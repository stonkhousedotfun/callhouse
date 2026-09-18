/** The periodic block source advances time-derived status after the last matching log. */
export type SeriesClockStatus = "open" | "cutoff" | "expired" | "settling" | "held" | "settled";
export type OrderClockKind = "Bid" | "AskResale" | "AskWrite";

/** Oracle and Clearinghouse verdicts take precedence over time-derived states. */
export function seriesStatusAt(
  status: SeriesClockStatus,
  mintCutoff: bigint,
  expiry: bigint,
  now: bigint,
): SeriesClockStatus {
  if (status === "settling" || status === "held" || status === "settled") return status;
  if (now >= expiry) return "expired";
  if (now >= mintCutoff) return "cutoff";
  return status;
}

/** Writing an AskWrite needs a live mint window; other orders can trade until expiry. */
export function orderExpiresAt(
  kind: OrderClockKind,
  validUntil: bigint,
  mintCutoff: bigint,
  expiry: bigint,
  now: bigint,
): boolean {
  return now >= validUntil || now >= expiry || (kind === "AskWrite" && now >= mintCutoff);
}
