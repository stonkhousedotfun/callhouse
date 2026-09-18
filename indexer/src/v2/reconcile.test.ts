import { describe, expect, it } from "vitest";
import { matchDeliveries, matchTakeFees } from "../../lib/v2/reconcile";
import { primaryPremiumReceived } from "../../lib/v2/writer";

const zero = "0x0000000000000000000000000000000000000000";
const book = "0x4444444444444444444444444444444444444444";
const maker = "0x1111111111111111111111111111111111111111";
const buyer = "0x2222222222222222222222222222222222222222";
const tx = "0xabc";

describe("block-end event matching", () => {
  it("matches escrow resale and primary mint deliveries while leaving unrelated transfers plain", () => {
    const transfers = [
      { id: "escrow", tx, longId: 100n, from: maker, to: book, units: 6n, logIndex: 1 },
      { id: "resale", tx, longId: 100n, from: book, to: buyer, units: 4n, logIndex: 4 },
      { id: "mint", tx, longId: 100n, from: zero, to: buyer, units: 2n, logIndex: 7 },
      { id: "gift", tx, longId: 100n, from: maker, to: buyer, units: 1n, logIndex: 12 },
    ];
    const fills = [
      { id: "fill1", tx, longId: 100n, buyer, seller: maker, takerIsBuyer: true, units: 4n, logIndex: 5, primary: false },
      { id: "fill2", tx, longId: 100n, buyer, seller: maker, takerIsBuyer: true, units: 2n, logIndex: 9, primary: true },
    ];
    const result = matchDeliveries(transfers, fills,
      [{ id: "minted", tx, longId: 100n, longTo: buyer, units: 2n, logIndex: 8 }], [], book);
    expect([...result.matchedTransfers]).toEqual(["resale", "mint"]);
    expect([...result.matchedMints]).toEqual(["minted"]);
  });

  it("attributes a delegated ask delivery to the receiver and a bid delivery to its maker", () => {
    const delegate = "0x3333333333333333333333333333333333333333";
    const transfers = [
      { id: "ask", tx, longId: 100n, from: book, to: delegate, units: 2n, logIndex: 1 },
      { id: "bid", tx, longId: 100n, from: buyer, to: maker, units: 3n, logIndex: 4 },
    ];
    const fills = [
      { id: "askFill", tx, longId: 100n, buyer: delegate, seller: maker, takerIsBuyer: true,
        units: 2n, logIndex: 2, primary: false },
      { id: "bidFill", tx, longId: 100n, buyer: maker, seller: buyer, takerIsBuyer: false,
        units: 3n, logIndex: 5, primary: false },
    ];
    expect([...matchDeliveries(transfers, fills, [], [], book).matchedTransfers]).toEqual(["ask", "bid"]);
  });

  it("matches fees to multiple maker fills in one take and multiple calls in one transaction", () => {
    const fills = [
      { id: "a", tx, longId: 100n, taker: buyer, takerIsBuyer: true, units: 3n, premium: 9n, logIndex: 3 },
      { id: "b", tx, longId: 100n, taker: buyer, takerIsBuyer: true, units: 7n, premium: 21n, logIndex: 7 },
      { id: "c", tx, longId: 100n, taker: buyer, takerIsBuyer: true, units: 2n, premium: 10n, logIndex: 13 },
    ];
    const calls = [
      { tx, longId: 100n, taker: buyer, buying: true, units: 10n, premium: 30n, takerFee: 7n, logIndex: 10 },
      { tx, longId: 100n, taker: buyer, buying: true, units: 2n, premium: 10n, takerFee: 3n, logIndex: 15 },
    ];
    expect([...matchTakeFees(fills, calls)]).toEqual([["a", 2n], ["b", 5n], ["c", 3n]]);
  });

  it("charges only each primary fill's allocated share when a sell take also fills resale bids", () => {
    const fills = [
      { id: "write-a", tx, longId: 100n, taker: buyer, takerIsBuyer: false,
        units: 5n, premium: 50n, logIndex: 3, primary: true, sellerFee: 2n, makerRebate: 0n },
      { id: "resale", tx, longId: 100n, taker: buyer, takerIsBuyer: false,
        units: 3n, premium: 30n, logIndex: 5, primary: false, sellerFee: 1n, makerRebate: 0n },
      { id: "write-b", tx, longId: 100n, taker: buyer, takerIsBuyer: false,
        units: 2n, premium: 20n, logIndex: 7, primary: true, sellerFee: 1n, makerRebate: 0n },
    ];
    const fees = matchTakeFees(fills, [{ tx, longId: 100n, taker: buyer, buying: false,
      units: 10n, premium: 100n, takerFee: 11n, logIndex: 8 }]);
    expect([...fees]).toEqual([["write-a", 5n], ["resale", 3n], ["write-b", 3n]]);
    const primaryTotal = fills.filter((fill) => fill.primary).reduce((sum, fill) =>
      sum + primaryPremiumReceived(fill.premium, fill.sellerFee, fill.makerRebate,
        fees.get(fill.id) ?? 0n, false, true), 0n);
    expect(primaryTotal).toBe(59n);
  });
});
