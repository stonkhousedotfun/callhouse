import { describe, expect, it } from "vitest";
import { mintRent, writerCapacity, writerCollateralNeed } from "./rent";
import { costToBuy } from "./payoff";
import { levelsFromChainOrders, type RawBookOrder } from "./bookFromChain";
import { buyQuote, staleSelectedOrders } from "./ticket";
const now = 1_800_000_000;
const maker = "0x0000000000000000000000000000000000000001";
const terms = { collateralPerUnit: 1n, mintFeePpm: 1200, expiry: now + 604800, snapshotTimestamp: now, mintCutoff: now + 604000 };
const fees = { takerFeeFlat: 0n, takerFeeCapBps: 0 };
describe("v7 writer rent budgets", () => {
  it("rounds once per fill, supports calls and puts, and refuses absent or invalid terms", () => {
    expect(mintRent(100n, terms)).toBe(1n);
    expect(mintRent(1n, terms) * 100n).toBe(100n);
    expect(mintRent(100n, { ...terms, collateralPerUnit: 10n ** 16n })).toBe(1_200_000_000_000_000n);
    expect(mintRent(100n, { ...terms, collateralPerUnit: 2_000_000n })).toBe(240_000n);
    expect(writerCapacity(100n, terms)).toBe(99n);
    expect(writerCapacity(100n, { ...terms, mintFeePpm: 0 })).toBe(100n);
    expect(writerCapacity(1_000n, { ...terms, snapshotTimestamp: terms.mintCutoff })).toBe(0n);
    expect(writerCapacity(1_000n, { ...terms, snapshotTimestamp: terms.expiry })).toBe(0n);
    expect(() => mintRent(1n, { ...terms, mintFeePpm: -1 })).toThrow();
  });
  it("reserves rent separately per selected fill and skips an unaffordable whole ask", () => {
    const ask = { price: 1_000_000n, units: 1n, onChainRemainingUnits: 1n, maker, kind: "AskWrite" as const, makerFreeUnits: 3n, makerFreeCollateral: 3n };
    const asks = [{ ...ask, orderId: "1" }, { ...ask, orderId: "2" }];
    const quote = costToBuy(asks, 2n, fees, terms);
    expect(quote.orderIds).toEqual(["1"]);
    expect(quote.cost).toBe(10_000n); // Writer rent never changes buyer max loss.
    expect(costToBuy(asks, 2n, fees).filledUnits).toBe(0n);
    expect(costToBuy([{ ...ask, orderId: "3", onChainRemainingUnits: 3n }], 3n, fees, terms).filledUnits).toBe(0n);
    expect(costToBuy([{ ...ask, orderId: "3", onChainRemainingUnits: 3n }], 2n, fees, terms).filledUnits).toBe(2n);
  });
  it("carries raw collateral and the snapshot clock through fallback, quote and preflight", () => {
    const order: RawBookOrder = { orderId: 1n, maker, longId: 2n, kind: 2, price: 1_000_000n,
      units: 100n, filled: 0n, validUntil: terms.mintCutoff, cancelled: false };
    const book = levelsFromChainOrders([order], new Map([[maker, 100n]]), 1n, 2n, now, 99n, terms.mintCutoff, 1200, terms.expiry, 6);
    expect(book.snapshotTimestamp).toBe(now);
    expect(book.asks[0].orders[0]).toMatchObject({ units: "99", makerFreeCollateral: { raw: "100", decimals: 6 } });
    expect(buyQuote(book.asks, 100n, fees, 0, undefined, terms).buy.filledUnits).toBe(0n);
    const quote = buyQuote(book.asks, 99n, fees, 0, undefined, terms);
    expect(quote.buy.filledUnits).toBe(99n);
    expect(staleSelectedOrders(quote, [{ ...order, freeCollateral: 99n }], 2n, 1n, now, terms)).toEqual(["1"]);
    expect(staleSelectedOrders(quote, [{ ...order, freeCollateral: 100n }], 2n, 1n, now, terms)).toEqual([]);
    expect(writerCollateralNeed(99n, terms)).toBe(100n);
  });
  it("does not lower rent using a later browser clock against old collateral", () => {
    const pinned = { ...terms, collateralPerUnit: 2_000_000n };
    expect(writerCapacity(200_000_000n, pinned)).toBe(99n);
    expect(mintRent(100n, pinned)).toBe(240_000n);
    expect(mintRent(100n, { ...pinned, snapshotTimestamp: now + 302400 })).toBe(120_000n);
    // Caller supplies the book snapshot, so the old budget keeps the higher rate.
    expect(writerCapacity(200_120_000n, pinned)).toBe(99n);
  });
});
