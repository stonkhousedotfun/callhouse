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

/**
 * One V2Clock tick's time-derived changes, decided from ONE read of every open/cutoff series and every open
 * order (with its series' deadlines), so maker scoring can take the rows it needs from the same read instead of
 * selecting them again. The rows acted on are exactly those the old deadline-filtered selects returned: for an
 * open/cutoff series seriesStatusAt changes the status only when `mintCutoff <= now || expiry <= now`, and
 * orderExpiresAt is that select's own predicate. An order whose series row is missing (`mintCutoff`/`expiry` null) is
 * never expired, as the old inner join never returned it.
 *
 * Returns the writes to make and what maker scoring reads after them: `liveSeries` is `status in (open, cutoff) and
 * expiry > now` with the new status, `openOrders` is `status = open` without the orders expired here.
 */
export function clockTick<
  S extends { longId: bigint; status: SeriesClockStatus; mintCutoff: bigint; expiry: bigint },
  O extends { orderId: bigint; kind: OrderClockKind; validUntil: bigint },
>(input: {
  now: bigint;
  series: readonly S[];
  orders: readonly { order: O; mintCutoff: bigint | null; expiry: bigint | null }[];
}): {
  seriesStatus: { longId: bigint; status: SeriesClockStatus }[];
  expiredOrders: bigint[];
  liveSeries: S[];
  openOrders: O[];
} {
  const { now } = input;
  const seriesStatus: { longId: bigint; status: SeriesClockStatus }[] = [];
  const liveSeries: S[] = [];
  for (const row of input.series) {
    const status = seriesStatusAt(row.status, row.mintCutoff, row.expiry, now);
    if (status !== row.status) seriesStatus.push({ longId: row.longId, status });
    if ((status === "open" || status === "cutoff") && row.expiry > now) liveSeries.push({ ...row, status });
  }
  const expiredOrders: bigint[] = [];
  const openOrders: O[] = [];
  for (const { order, mintCutoff, expiry } of input.orders) {
    if (mintCutoff !== null && expiry !== null
        && orderExpiresAt(order.kind, order.validUntil, mintCutoff, expiry, now)) expiredOrders.push(order.orderId);
    else openOrders.push(order);
  }
  return { seriesStatus, expiredOrders, liveSeries, openOrders };
}
