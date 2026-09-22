import { describe, expect, it } from "vitest";

import {
  SELF_TRADE_MIN_PRICE_TICKS,
  SELF_TRADE_SUSPECT_PRICE_TICKS,
  emptySelfTradeState,
  indexedSelfTradeLinks,
  reduceSelfTrade,
  selfTradeCoverage,
  selfTradeUnitsFor,
  totalSelfTradeUnits,
  totalSelfTradeUnseenUnits,
  type SelfTradeBatch,
  type SelfTradeEvent,
  type SelfTradeFillEvent,
} from "../../lib/v2/selfTrade";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const A = address("1");
const B = address("2");
const C = address("3");
const D = address("4");
const E = address("5");
const F = address("6");
const BOOK = address("b");

function fill(id: string, block: bigint, values: Partial<SelfTradeFillEvent> = {}): SelfTradeFillEvent {
  return {
    kind: "fill", id, block, logIndex: 1, ts: block * 10n, longId: 1n,
    maker: A, taker: B, recipient: B, buyer: B, seller: A,
    units: 10n, price: 100n, primary: true, takerIsBuyer: true, fairAtFill: null,
    ...values,
  };
}

function batch(events: readonly SelfTradeEvent[], overrides: Partial<SelfTradeBatch> = {}): SelfTradeBatch {
  const through = events.reduce((max, event) => event.block > max ? event.block : max, 0n);
  return {
    through,
    throughTimestamp: through * 10n,
    events,
    linkEvidence: [],
    seriesExpiries: [],
    matchedTransferIds: new Set(),
    protocolAddresses: [BOOK],
    ...overrides,
  };
}

describe("linked-wallet resale measurement", () => {
  it("counts the linked minimum-price path, keeps fair optional, and leaves the honest look-alike at zero", () => {
    const events: SelfTradeEvent[] = [
      fill("linked-primary", 1n, { fairAtFill: null }),
      fill("honest-primary", 2n, { longId: 2n, maker: C, taker: D, recipient: D, buyer: D, seller: C, units: 7n }),
      fill("linked-resale", 3n, { primary: false, maker: B, taker: E, recipient: E, buyer: E, seller: B }),
      fill("honest-resale", 4n, { longId: 2n, primary: false, maker: D, taker: F, recipient: F,
        buyer: F, seller: D, units: 7n }),
    ];
    const linkEvidence = indexedSelfTradeLinks([], [{ account: A, actor: B }]);
    const state = reduceSelfTrade(emptySelfTradeState(), batch(events, { linkEvidence }));

    expect(selfTradeUnitsFor(state, A)).toBe(10n);
    expect(selfTradeUnitsFor(state, C)).toBe(0n);
    expect(totalSelfTradeUnits(state)).toBe(10n);
    // There is intentionally no maker-enrollment input: a one-order writer is still attributed.
    expect(state.makers).toEqual([{ writer: A, units: 10n }]);
  });

  it("pins the one-tick band independently of fair value", () => {
    expect(SELF_TRADE_MIN_PRICE_TICKS).toBe(1n);
    const events: SelfTradeEvent[] = [
      fill("two-tick-primary", 1n, { price: 200n, fairAtFill: 10_000n }),
      fill("resale", 2n, { primary: false, maker: B, taker: C, recipient: C, buyer: C, seller: B }),
    ];
    const state = reduceSelfTrade(emptySelfTradeState(), batch(events, {
      linkEvidence: indexedSelfTradeLinks([], [{ account: A, actor: B }]),
    }));
    expect(totalSelfTradeUnits(state)).toBe(0n);
    // Mutation check: lowering the exported band below the one-tick fixture makes the linked case fail.
    // AND the zero must not read as "clean". This assertion is the point of the row: before it,
    // this test asserted that a two-tick evasion produces 0 and stopped there, which is the
    // detector's blind spot recorded as though it were a passing property.
    expect(selfTradeCoverage(state).status).toBe("blind");
  });

  it("links accounts transitively through active operator and delegate facts", () => {
    const sharedController = address("a");
    const accounts = [
      { account: A, operators: JSON.stringify({ [sharedController]: true }), approvals: "{}", delegates: "{}" },
      { account: B, operators: "{}", approvals: "{}", delegates: JSON.stringify({ [sharedController]: true }) },
    ];
    const events: SelfTradeEvent[] = [
      fill("primary", 1n),
      fill("resale", 2n, { primary: false, maker: B, taker: C, recipient: C, buyer: C, seller: B }),
    ];
    const state = reduceSelfTrade(emptySelfTradeState(), batch(events, {
      linkEvidence: indexedSelfTradeLinks(accounts, []),
    }));
    expect(selfTradeUnitsFor(state, A)).toBe(10n);
  });

  it("uses FIFO across direct-mint inventory and counts each primary unit at most once", () => {
    const events: SelfTradeEvent[] = [
      { kind: "mint", id: "direct-mint", block: 1n, logIndex: 1, ts: 10n, longId: 1n, holder: B, units: 5n },
      fill("primary", 2n),
      fill("first-resale", 3n, { primary: false, maker: B, taker: C, recipient: C, buyer: C, seller: B, units: 8n }),
      fill("second-resale", 4n, { primary: false, maker: B, taker: D, recipient: D, buyer: D, seller: B, units: 7n }),
      fill("resold-again", 5n, { primary: false, maker: C, taker: E, recipient: E, buyer: E, seller: C, units: 8n }),
    ];
    const state = reduceSelfTrade(emptySelfTradeState(), batch(events, {
      linkEvidence: indexedSelfTradeLinks([], [{ account: A, actor: B }]),
    }));
    expect(selfTradeUnitsFor(state, A)).toBe(10n);
  });

  it("propagates tainted FIFO portions through a linked wallet transfer", () => {
    const events: SelfTradeEvent[] = [
      fill("primary", 1n),
      { kind: "transfer", id: "wallet-transfer", block: 2n, logIndex: 1, ts: 20n,
        longId: 1n, from: B, to: C, units: 6n },
      fill("resale", 3n, { primary: false, maker: C, taker: D, recipient: D, buyer: D, seller: C, units: 6n }),
    ];
    const state = reduceSelfTrade(emptySelfTradeState(), batch(events, {
      linkEvidence: indexedSelfTradeLinks([], [{ account: A, actor: B }]),
    }));
    expect(selfTradeUnitsFor(state, A)).toBe(6n);
  });

  it("excludes protocol relationships and matched delivery transfers from the graph", () => {
    const accounts = [
      { account: A, operators: JSON.stringify({ [BOOK]: true }), approvals: "{}", delegates: "{}" },
      { account: B, operators: "{}", approvals: JSON.stringify({ [BOOK]: true }), delegates: "{}" },
    ];
    const events: SelfTradeEvent[] = [
      fill("primary", 1n),
      { kind: "transfer", id: "matched-delivery", block: 2n, logIndex: 1, ts: 20n,
        longId: 1n, from: A, to: B, units: 10n },
      fill("resale", 3n, { primary: false, maker: B, taker: C, recipient: C, buyer: C, seller: B }),
    ];
    const state = reduceSelfTrade(emptySelfTradeState(), batch(events, {
      linkEvidence: indexedSelfTradeLinks(accounts, []),
      matchedTransferIds: new Set(["matched-delivery"]),
    }));
    expect(totalSelfTradeUnits(state)).toBe(0n);
  });

  it("extinguishes taint on close, redemption, and expiry", () => {
    const events: SelfTradeEvent[] = [
      fill("close-primary", 1n, { longId: 1n }),
      fill("redeem-primary", 2n, { longId: 2n, maker: C, taker: D, recipient: D, buyer: D, seller: C }),
      fill("expiry-primary", 3n, { longId: 3n, maker: E, taker: F, recipient: F, buyer: F, seller: E }),
      { kind: "close", id: "close", block: 4n, logIndex: 1, ts: 40n, longId: 1n, holder: B, units: 10n },
      { kind: "redemption", id: "redeem", block: 5n, logIndex: 1, ts: 50n, longId: 2n, holder: D, units: 10n },
      fill("after-close", 6n, { longId: 1n, primary: false, maker: B, taker: E, recipient: E, buyer: E, seller: B }),
      fill("after-redeem", 7n, { longId: 2n, primary: false, maker: D, taker: E, recipient: E, buyer: E, seller: D }),
      fill("after-expiry", 8n, { longId: 3n, primary: false, maker: F, taker: B, recipient: B, buyer: B, seller: F }),
    ];
    const state = reduceSelfTrade(emptySelfTradeState(), batch(events, {
      linkEvidence: indexedSelfTradeLinks([], [
        { account: A, actor: B }, { account: C, actor: D }, { account: E, actor: F },
      ]),
      seriesExpiries: [{ longId: 3n, expiry: 60n }],
    }));
    expect(totalSelfTradeUnits(state)).toBe(0n);
  });

  it("is idempotent when the same completed block range is applied twice", () => {
    const events: SelfTradeEvent[] = [
      fill("primary", 1n),
      fill("resale", 2n, { primary: false, maker: B, taker: C, recipient: C, buyer: C, seller: B }),
    ];
    const input = batch(events, { linkEvidence: indexedSelfTradeLinks([], [{ account: A, actor: B }]) });
    const once = reduceSelfTrade(emptySelfTradeState(), input);
    const twice = reduceSelfTrade(once, input);
    expect(twice).toEqual(once);
    expect(selfTradeUnitsFor(twice, A)).toBe(10n);
  });
});

/**
 * D18 left the self-trade loophole open ON CONDITION that the indexer flags the pattern. These
 * cases are about that condition, not about the counted number: each one drives the counted total
 * to exactly 0 and then asserts that 0 is still distinguishable from an honest market.
 */
describe("self-trade coverage distinguishes a clean zero from a blind zero", () => {
  it("flags evasion (a): linked wallets priced just above the counted floor", () => {
    // Two ticks. Still trivially below fair, and inside the suspect band.
    expect(SELF_TRADE_SUSPECT_PRICE_TICKS).toBeGreaterThan(SELF_TRADE_MIN_PRICE_TICKS);
    const events: SelfTradeEvent[] = [fill("two-tick-linked", 1n, { price: 200n })];
    const state = reduceSelfTrade(emptySelfTradeState(), batch(events, {
      linkEvidence: indexedSelfTradeLinks([], [{ account: A, actor: B }]),
    }));

    expect(totalSelfTradeUnits(state)).toBe(0n);
    expect(state.unseen).toEqual([{ reason: "price-above-counted-band", units: 10n, fills: 1 }]);
    expect(selfTradeCoverage(state)).toMatchObject({ status: "blind", units: 0n, unseenUnits: 10n });
  });

  it("flags evasion (b): floor-priced sale to a wallet with no indexed edge", () => {
    // No linkEvidence at all: the second wallet was funded from off chain.
    const events: SelfTradeEvent[] = [fill("floor-unlinked", 1n, { price: 100n })];
    const state = reduceSelfTrade(emptySelfTradeState(), batch(events));

    expect(totalSelfTradeUnits(state)).toBe(0n);
    expect(state.unseen).toEqual([{ reason: "no-link-evidence", units: 10n, fills: 1 }]);
    expect(selfTradeCoverage(state)).toMatchObject({ status: "blind", units: 0n, unseenUnits: 10n });
  });

  it("reports a REAL zero as clean, so `blind` keeps its meaning", () => {
    // Priced well above the suspect band and unlinked: nothing about this looks like the pattern.
    const events: SelfTradeEvent[] = [fill("honest", 1n, { price: 5_000n })];
    const state = reduceSelfTrade(emptySelfTradeState(), batch(events));

    expect(totalSelfTradeUnits(state)).toBe(0n);
    expect(state.unseen).toEqual([]);
    expect(selfTradeCoverage(state)).toMatchObject({ status: "clean", units: 0n, unseenUnits: 0n });
  });

  it("does not cry wolf on an ordinary sale where the taker is the seller", () => {
    // Fails `takerIsBuyer`, which no evader controls by pricing or funding. Not a blind spot.
    const events: SelfTradeEvent[] = [fill("taker-sells", 1n, { price: 100n, takerIsBuyer: false })];
    const state = reduceSelfTrade(emptySelfTradeState(), batch(events));

    expect(state.unseen).toEqual([]);
    expect(selfTradeCoverage(state).status).toBe("clean");
  });

  it("reports `detected` when units were actually attributed, even alongside a blind spot", () => {
    const events: SelfTradeEvent[] = [
      fill("linked-primary", 1n),
      fill("linked-resale", 2n, { primary: false, maker: B, taker: E, recipient: E, buyer: E, seller: B }),
      // A second, unlinked floor-priced leg on another series: blind, but not what we report.
      fill("floor-unlinked", 3n, { longId: 2n, maker: C, taker: D, recipient: D, buyer: D, seller: C, units: 4n }),
    ];
    const state = reduceSelfTrade(emptySelfTradeState(), batch(events, {
      linkEvidence: indexedSelfTradeLinks([], [{ account: A, actor: B }]),
    }));

    const coverage = selfTradeCoverage(state);
    expect(coverage.units).toBe(10n);
    // `detected` wins: a measured number is a fact, and the blind units stay visible beside it.
    expect(coverage.status).toBe("detected");
    expect(coverage.unseenUnits).toBe(4n);
  });

  it("carries unseen totals across batches rather than resetting each range", () => {
    const first = reduceSelfTrade(emptySelfTradeState(), batch([fill("a", 1n, { price: 100n })]));
    const second = reduceSelfTrade(first, batch([fill("b", 2n, { price: 100n, longId: 2n })], { through: 2n }));

    expect(totalSelfTradeUnseenUnits(second)).toBe(20n);
    expect(second.unseen).toEqual([{ reason: "no-link-evidence", units: 20n, fills: 2 }]);
  });
});
