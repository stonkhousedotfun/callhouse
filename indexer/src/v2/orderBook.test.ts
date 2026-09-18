import { describe, expect, it } from "vitest";
import {
  cancelOrder, expireOrder, fillOrder, fillParties, orderKind, orderValidUntil, placeOrder,
  replacementPredecessor, withDelegate,
} from "../../lib/v2/orderBook";

describe("OrderBook event reductions", () => {
  it("maps every ABI order kind and the zero deadline sentinel", () => {
    expect([0, 1, 2].map(orderKind)).toEqual(["Bid", "AskResale", "AskWrite"]);
    expect(() => orderKind(3)).toThrow("Unknown OrderKind");
    expect(orderValidUntil("AskWrite", 0n, 50n, 100n)).toBe(50n);
    expect(orderValidUntil("AskResale", 0n, 50n, 100n)).toBe(100n);
    expect(orderValidUntil("Bid", 60n, 50n, 100n)).toBe(60n);
    expect(orderValidUntil("Bid", 200n, 50n, 100n)).toBe(100n);
  });

  it("replays placement, partial fills, complete fill, cancellation, pruning, and expiry", () => {
    const placed = placeOrder(10n);
    const partial = fillOrder(placed, 4n);
    expect(partial).toEqual({ units: 10n, filled: 4n, status: "open" });
    expect(fillOrder(partial, 6n)).toEqual({ units: 10n, filled: 10n, status: "filled" });
    expect(cancelOrder(partial, 6n, false).status).toBe("cancelled");
    expect(cancelOrder(partial, 6n, true).status).toBe("pruned");
    expect(expireOrder(partial, 50n, 49n).status).toBe("open");
    expect(expireOrder(partial, 50n, 50n).status).toBe("expired");
    expect(() => fillOrder(partial, 7n)).toThrow("outside remaining");
    expect(() => cancelOrder(partial, 10n, false)).toThrow("mismatch");
    expect(() => fillOrder(cancelOrder(partial, 6n, false), 1n)).toThrow("Cannot fill");
  });

  it("links replacement only to the nearest unused same-tx cancellation", () => {
    const base = { maker: "0xAbC", longId: 9n, cancelledTx: "0xA", status: "cancelled" as const, replacedBy: null };
    const candidates = [
      { ...base, orderId: 1n, cancelledLogIndex: 3 },
      { ...base, orderId: 2n, cancelledLogIndex: 7 },
      { ...base, orderId: 3n, cancelledLogIndex: 8, replacedBy: 40n },
      { ...base, orderId: 4n, cancelledLogIndex: 9, status: "pruned" as const },
      { ...base, orderId: 5n, cancelledLogIndex: 10, cancelledTx: "0xB" },
    ];
    expect(replacementPredecessor(candidates, { maker: "0xabc", longId: 9n, tx: "0xa", logIndex: 11 })).toBe(2n);
    expect(replacementPredecessor(candidates, { maker: "0xabc", longId: 10n, tx: "0xa", logIndex: 11 })).toBeNull();
  });

  it("updates delegate approvals without dropping prior permissions", () => {
    const one = withDelegate("{}", "0xBB", true);
    const two = withDelegate(one, "0xAA", true);
    expect(JSON.parse(two)).toEqual({ "0xaa": true, "0xbb": true });
    expect(JSON.parse(withDelegate(two, "0xbb", false))).toEqual({ "0xaa": true });
  });

  it("attributes bid and ask fills to the correct buyer and seller", () => {
    expect(fillParties("maker", "taker", "recipient", false)).toEqual({ buyer: "maker", seller: "taker" });
    expect(fillParties("maker", "taker", "recipient", true)).toEqual({ buyer: "recipient", seller: "maker" });
  });
});
