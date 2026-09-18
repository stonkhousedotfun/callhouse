import { describe, expect, it } from "vitest";
import vectors from "../../../ops/fixtures/v2/payoff-vectors.json";
import { aggregateBook, type BookOrder, type BookSeries } from "../../lib/v2/book";
import { buildCardMath, cardMultiple, cardTarget, isStrikeInLadder, payoutAtTarget, pickHero, walkAsks } from "../../lib/v2/cards";

const maker = "0x1111111111111111111111111111111111111111" as const;
const series: BookSeries = { longId: 8n, isPut: false, strike: 200_000_000n, mintCutoff: 900n, mintFeePpm: 0, expiry: 1000n, status: "open" };
const fees = { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000, exerciseFeeBps: 25 };

function order(id: bigint, price: bigint, units: bigint, kind: BookOrder["kind"] = "AskResale"): BookOrder {
  return { orderId: id, maker, longId: 8n, kind, price, units, filled: 0n, validUntil: 0n,
    status: "open", placedAt: id, placedBlock: id };
}

describe("v2 card maths", () => {
  it("matches the on-chain payout vectors in USDG after exercise fees", () => {
    for (const vector of vectors) {
      expect(payoutAtTarget({ isPut: vector.isPut, strike: BigInt(vector.strike) },
        BigInt(vector.price), vector.exerciseFeeBps), vector.name).toBe(BigInt(vector.usdPerUnit));
    }
  });

  it("walks 100 units across cheapest asks and charges one taker fee per ticket", () => {
    const book = aggregateBook({ series, now: 100n, freeByMaker: new Map(), orders: [
      order(1n, 1_000_000n, 40n), order(2n, 1_200_000n, 80n), order(3n, 2_000_000n, 100n),
    ] });
    const single = walkAsks(book, 1n, series, new Map(), fees);
    expect(single).toMatchObject({ filled: 1n, premium: 10_000n, takerFee: 1_000n, cost: 11_000n, orderIds: [1n] });
    const share = walkAsks(book, 100n, series, new Map(), fees);
    expect(share).toMatchObject({ filled: 100n, premium: 1_120_000n, takerFee: 100_000n,
      cost: 1_220_000n, orderIds: [1n, 2n] });
    const card = buildCardMath({ book, series, freeByMaker: new Map(), fees, targetBps: 400, strikeTick: 1_000_000n });
    expect(card).toMatchObject({ ask: 1_000_000n, target: 208_000_000n, perUnit: { cost: 11_000n },
      perShare: { cost: 1_220_000n, filledUnits: 100n }, unitsAvailable: 220n, orderIds: [1n, 2n], askDepth: 220n });
    expect(card?.perUnit.multiple).toBe(cardMultiple(card!.perUnit.payoutAtTarget, 11_000n));
    expect(cardMultiple(19_999n, 1_000n)).toBe(19.99);
  });

  it("reserves one maker's collateral across AskWrite orders in a single ticket", () => {
    const free = new Map([[maker.toLowerCase(), 80n * 10n ** 16n]]);
    const book = aggregateBook({ series, now: 100n, freeByMaker: free, orders: [
      order(1n, 1_000_000n, 60n, "AskWrite"), order(2n, 1_200_000n, 60n, "AskWrite"),
    ] });
    expect(book.asks.reduce((n, level) => n + level.units, 0n)).toBe(120n);
    const share = walkAsks(book, 100n, series, free, fees);
    expect(share.filled).toBe(60n);
    expect(share.fills.map((fill) => fill.units)).toEqual([60n]);
    const card = buildCardMath({ book, series, freeByMaker: free, fees, targetBps: 400, strikeTick: 1_000_000n });
    expect(card?.perShare).toBeNull();
    expect(card?.unitsAvailable).toBe(80n);
  });

  it("rounds call and put scenario targets outward to the strike tick", () => {
    expect(cardTarget(231_000_000n, false, 400, 1_000_000n)).toBe(241_000_000n);
    expect(cardTarget(200_000_000n, true, 400, 2_500_000n)).toBe(190_000_000n);
    expect(cardTarget(1_000_000n, true, 9_900, 500_000n)).toBe(500_000n);
  });

  it("picks the highest honest eligible hero, requiring full depth, time and a registry rung", () => {
    const ladder = { rungs: 2, firstOtmBps: 200, stepBps: 200, cardTargetBps: 400 };
    const math = (multiple: number, hasShare = true) => ({ ask: 100n, target: 200n,
      perUnit: { cost: 1n, payoutAtTarget: 1n, multiple },
      perShare: hasShare ? { cost: 100n, payoutAtTarget: 100n, multiple, filledUnits: 100n } : null,
      maxLoss: "cost" as const, unitsAvailable: 100n, orderIds: [1n], askDepth: 100n });
    const candidate = (card: string, multiple: number, expiry: bigint, strike: bigint, hasShare = true) => ({
      card, math: math(multiple, hasShare), expiry, strike, spot: 200_000_000n, isPut: false,
      tick: 1_000_000n, ladder,
    });
    expect(isStrikeInLadder({ strike: 204_000_000n, spot: 200_000_000n, isPut: false, tick: 1_000_000n, ladder })).toBe(true);
    expect(isStrikeInLadder({ strike: 201_000_000n, spot: 200_000_000n, isPut: false, tick: 1_000_000n, ladder })).toBe(false);
    const hero = pickHero([
      candidate("too soon", 99, 7_199n, 204_000_000n),
      candidate("too little", 90, 10_000n, 204_000_000n, false),
      candidate("off ladder", 80, 10_000n, 201_000_000n),
      candidate("winner", 12.5, 10_000n, 209_000_000n),
      candidate("runner", 10.1, 10_000n, 204_000_000n),
    ], 0n);
    expect(hero?.card).toBe("runner");
  });
});
