import { describe, expect, it } from "vitest";
import { clockTick, orderExpiresAt, seriesStatusAt, type OrderClockKind, type SeriesClockStatus } from "../../lib/v2/clock";

describe("periodic v2 status", () => {
  it("moves open series through cutoff and expiry at the exact timestamp", () => {
    expect(seriesStatusAt("open", 100n, 200n, 99n)).toBe("open");
    expect(seriesStatusAt("open", 100n, 200n, 100n)).toBe("cutoff");
    expect(seriesStatusAt("cutoff", 100n, 200n, 200n)).toBe("expired");
    expect(seriesStatusAt("settling", 100n, 200n, 300n)).toBe("settling");
    expect(seriesStatusAt("held", 100n, 200n, 300n)).toBe("held");
    expect(seriesStatusAt("settled", 100n, 200n, 300n)).toBe("settled");
  });

  it("expires asks requiring fresh mint at cutoff, and all orders at their own deadline or expiry", () => {
    expect(orderExpiresAt("AskWrite", 190n, 100n, 200n, 100n)).toBe(true);
    expect(orderExpiresAt("AskResale", 190n, 100n, 200n, 100n)).toBe(false);
    expect(orderExpiresAt("Bid", 190n, 100n, 200n, 190n)).toBe(true);
    expect(orderExpiresAt("AskResale", 300n, 100n, 200n, 200n)).toBe(true);
  });
});

/**
 * The V2Clock tick reads every open/cutoff series and every open order once and decides in clockTick. The
 * reference below is the handler BEFORE step by step: the deadline-filtered series select and its updates,
 * then the inner-joined, deadline-filtered order select and its updates, then maker scoring's own two selects over the
 * updated tables. Every combination of status, kind and deadline around `now` must produce the same writes and the same
 * rows for maker scoring.
 */
describe("clockTick matches the old deadline-filtered selects", () => {
  type Series = { longId: bigint; status: SeriesClockStatus; mintCutoff: bigint; expiry: bigint; strike: bigint };
  type Order = { orderId: bigint; longId: bigint; kind: OrderClockKind; validUntil: bigint; status: string; units: bigint };
  const now = 1_000n;
  const statuses: SeriesClockStatus[] = ["open", "cutoff", "expired", "settling", "held", "settled"];
  const times = [990n, 999n, 1_000n, 1_001n, 1_020n];

  const seriesTable: Series[] = [];
  for (const status of statuses) for (const mintCutoff of times) for (const expiry of times) {
    if (mintCutoff > expiry) continue;
    seriesTable.push({ longId: BigInt(seriesTable.length + 1) * 2n, status, mintCutoff, expiry, strike: 7n });
  }
  const orderTable: Order[] = [];
  const kinds: OrderClockKind[] = ["Bid", "AskResale", "AskWrite"];
  // Every series, plus one id with no series row (the old inner join never returned its orders).
  const longIds = [...seriesTable.map((row) => row.longId), 9_999_998n];
  for (const longId of longIds) for (const kind of kinds) for (const validUntil of [0n, 999n, 1_000n, 1_001n])
    for (const status of ["open", "filled"]) {
      orderTable.push({ orderId: BigInt(orderTable.length + 1), longId, kind, validUntil, status, units: 5n });
    }

  function before() {
    const seriesStatus: { longId: bigint; status: SeriesClockStatus }[] = [];
    for (const row of seriesTable) {
      if ((row.status !== "open" && row.status !== "cutoff") || !(row.mintCutoff <= now || row.expiry <= now)) continue;
      const status = seriesStatusAt(row.status, row.mintCutoff, row.expiry, now);
      if (status !== row.status) seriesStatus.push({ longId: row.longId, status });
    }
    const updated = seriesTable.map((row) => {
      const change = seriesStatus.find((item) => item.longId === row.longId);
      return change === undefined ? row : { ...row, status: change.status };
    });
    const expiredOrders: bigint[] = [];
    for (const order of orderTable) {
      const series = seriesTable.find((row) => row.longId === order.longId);
      if (series === undefined || order.status !== "open") continue;
      if (!(order.validUntil <= now || series.expiry <= now || (order.kind === "AskWrite" && series.mintCutoff <= now))) continue;
      if (orderExpiresAt(order.kind, order.validUntil, series.mintCutoff, series.expiry, now)) expiredOrders.push(order.orderId);
    }
    const liveSeries = updated.filter((row) => (row.status === "open" || row.status === "cutoff") && row.expiry > now);
    const openOrders = orderTable.filter((row) => row.status === "open" && !expiredOrders.includes(row.orderId));
    return { seriesStatus, expiredOrders, liveSeries, openOrders };
  }

  function after() {
    const series = seriesTable.filter((row) => row.status === "open" || row.status === "cutoff");
    const orders = orderTable.filter((row) => row.status === "open").map((order) => {
      const row = seriesTable.find((item) => item.longId === order.longId);
      return { order, mintCutoff: row?.mintCutoff ?? null, expiry: row?.expiry ?? null };
    });
    return clockTick({ now, series, orders });
  }

  const byId = <T,>(rows: T[], id: (row: T) => bigint) => [...rows].sort((a, b) => (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0));

  it("writes the same series statuses and expires the same orders", () => {
    const [old, next] = [before(), after()];
    expect(byId(next.seriesStatus, (row) => row.longId)).toEqual(byId(old.seriesStatus, (row) => row.longId));
    expect([...next.expiredOrders].sort()).toEqual([...old.expiredOrders].sort());
    // The grid reaches every branch: cutoff and expiry transitions, each order predicate, and untouched rows.
    expect(old.seriesStatus.some((row) => row.status === "cutoff")).toBe(true);
    expect(old.seriesStatus.some((row) => row.status === "expired")).toBe(true);
    expect(old.expiredOrders.length).toBeGreaterThan(0);
    expect(next.openOrders.some((row) => row.longId === 9_999_998n)).toBe(true);
  });

  it("hands maker scoring the rows its own selects would read after those writes", () => {
    const [old, next] = [before(), after()];
    expect(byId(next.liveSeries, (row) => row.longId)).toEqual(byId(old.liveSeries, (row) => row.longId));
    expect(byId(next.openOrders, (row) => row.orderId)).toEqual(byId(old.openOrders, (row) => row.orderId));
    expect(old.liveSeries.some((row) => row.status === "cutoff")).toBe(true);
  });
});
