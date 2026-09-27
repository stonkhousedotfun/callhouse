/**
 * indexer-derived states that restate a contract rule, pinned against the rule they restate (contracts at
 * callhouse-contracts). The handler-level cases are in derivedStates.handler.test.ts; the route
 * cases (Earn ledger term, expired resale escrow, cutoff mark, short claimable) are in src/api/v2/routes.test.ts.
 */
import { describe, expect, it } from "vitest";

import { eligibleStrategyPriceBand, MAX_REPRICE_DROP_BPS, repriceDropFloor } from "../../lib/v2/autoRoller";
import { marketStatus } from "../../lib/v2/clearinghouse";
import { seriesStatusOnVerdict } from "../../lib/v2/oracle";
import { earnEarliestWithdrawal } from "./earnYield";

describe("series status on a settlement verdict (SettlementOracle.veto: allowed before expiry)", () => {
  it("before expiry a verdict leaves an open or cutoff series as it is", () => {
    expect(seriesStatusOnVerdict("open", "Held", 1_000n, 999n)).toBe("open");
    expect(seriesStatusOnVerdict("cutoff", "Pending", 1_000n, 999n)).toBe("cutoff");
  });
  it("from expiry (Clearinghouse.settle: NotExpired while now < expiry) the verdict applies", () => {
    expect(seriesStatusOnVerdict("open", "Held", 1_000n, 1_000n)).toBe("held");
    expect(seriesStatusOnVerdict("expired", "Pending", 1_000n, 1_000n)).toBe("settling");
    expect(seriesStatusOnVerdict("expired", "Finalized", 1_000n, 2_000n)).toBe("settling");
    expect(seriesStatusOnVerdict("expired", null, 1_000n, 2_000n)).toBe("expired");
    expect(seriesStatusOnVerdict("expired", "None", 1_000n, 2_000n)).toBe("expired");
  });
  it("never moves a settled series", () => {
    expect(seriesStatusOnVerdict("settled", "Held", 1_000n, 2_000n)).toBe("settled");
  });
});

describe("AutoRoller reprice band respects the per-call drop floor (AutoRoller.sol:504)", () => {
  it("mirrors the compiled MAX_REPRICE_DROP_BPS", () => {
    expect(MAX_REPRICE_DROP_BPS).toBe(2_500);
  });
  it("the floor is the lowest tick price the contract accepts: newPrice x BPS >= current x (BPS - drop)", () => {
    for (const current of [3_000_000n, 3_183_100n, 100n, 1_000_100n]) {
      const floor = repriceDropFloor(current);
      expect(floor % 100n).toBe(0n);
      expect(floor * 10_000n >= current * 7_500n).toBe(true);
      expect((floor - 100n) * 10_000n >= current * 7_500n).toBe(false);
    }
    expect(repriceDropFloor(3_000_000n)).toBe(2_250_000n);
    expect(repriceDropFloor(3_183_100n)).toBe(2_387_400n);
  });

  const writer = "0x00000000000000000000000000000000000000aa";
  const base = {
    writer,
    strategy: { active: true, smartPricing: true, askBps: 100, minAskBps: 50, maxAskBps: 200 },
    currentLongId: 42n,
    orderId: 7n,
    order: { orderId: 7n, maker: writer, longId: 42n, kind: "AskWrite", status: "open", price: 3_000_000n,
      units: 10n, filled: 0n, validUntil: 2_000n },
    series: { longId: 42n, isPut: false, strike: 220_000_000n },
    spot: 200_000_000n,
    tradingPaused: false,
    delegateApproved: true,
    now: 1_000n,
  };
  it("raises the band's min to the floor when the spot band reaches below it", () => {
    // Spot band [1.00, 4.00]; the 3.00 ask can only fall to 2.25 in one call.
    expect(eligibleStrategyPriceBand(base)).toEqual({ min: 2_250_000n, max: 4_000_000n });
  });
  it("offers no band when the floor is above the spot band's max", () => {
    // A 6.00 ask cannot come down to the 4.00 band ceiling in one call (floor 4.50).
    expect(eligibleStrategyPriceBand({ ...base, order: { ...base.order, price: 6_000_000n } })).toBeNull();
  });
});

describe("Earn liquidity cap counts what EarnVault._raise can reach", () => {
  const input = { now: 1_000, positionOpen: false, positionExpiry: null, queueOpen: false, venueUnreadable: false, venueAttached: true };
  it("adds the vault's free Clearinghouse ledger to the wallet and venue", () => {
    expect(earnEarliestWithdrawal({ ...input, wallet: 0n, ledger: 300_000n, venue: 0n }))
      .toEqual({ kind: "now", at: 1_000, reason: "liquid", liquidityCap: "300000" });
    expect(earnEarliestWithdrawal({ ...input, wallet: 1n, ledger: 2n, venue: 4n }))
      .toEqual({ kind: "now", at: 1_000, reason: "liquid", liquidityCap: "7" });
  });
  it("queues only when all three are zero, and never reads an unread ledger as zero", () => {
    expect(earnEarliestWithdrawal({ ...input, wallet: 0n, ledger: 0n, venue: 0n }))
      .toEqual({ kind: "queued", at: null, reason: "venue-liquidity", liquidityCap: "0" });
    expect(earnEarliestWithdrawal({ ...input, wallet: 5n, ledger: null, venue: 5n }))
      .toEqual({ kind: "unknown", at: null, reason: "not-read", liquidityCap: null });
  });
});

describe("market status label (Clearinghouse: `enabled` gates createSeries and mint only)", () => {
  it("is live when enabled and paused when not", () => {
    expect(marketStatus(true)).toBe("live");
    expect(marketStatus(false)).toBe("paused");
  });
});
