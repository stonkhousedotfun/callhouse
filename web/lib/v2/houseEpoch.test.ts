import { describe, expect, it } from "vitest";

import {
  NAV_NOT_AVAILABLE,
  NEW_YORK_TIME_ZONE,
  SHARE_DECIMALS,
  STOCK_DECIMALS,
  USDG_DECIMALS,
  depositJoinsSentence,
  epochResult,
  formatNewYork,
  inKindPreview,
  navView,
  secondsUntilBoundary,
} from "./houseEpoch";

// One boundary snapshot, shared by the in-kind cases. Four shares exist, three of them are queued
// to withdraw, and this holder owns two of those three. The pool figures are chosen so the two
// floors the contract applies do NOT collapse into one -- see "composes both floors" below.
const TOTAL_SHARES = 4_000_000_000_000_000_000n; // 4 shares, 18 dp
const QUEUE_SHARES = 3_000_000_000_000_000_000n; // the whole withdraw queue
const ALICE = 2_000_000_000_000_000_000n; // 2 of the 3 queued shares
const BOB = 1_000_000_000_000_000_000n; // the other 1
const POOL_USDG = 100_000_002n; // 100.000002 USDG, 6 dp
const POOL_STOCK = 4_000_000_000_000_000_002n; // ~4 Stock Tokens, 18 dp

const atBoundary = (shares: bigint) =>
  ({
    atBoundary: true,
    shares,
    queueShares: QUEUE_SHARES,
    totalShares: TOTAL_SHARES,
    poolUsdg: POOL_USDG,
    poolStock: POOL_STOCK,
  }) as const;

describe("navView", () => {
  it("never returns a number for a running epoch", () => {
    const view = navView({ atBoundary: false });
    expect(view).toEqual({ available: false, message: NAV_NOT_AVAILABLE });
    expect(view.available).toBe(false);
  });

  it("echoes a caller-supplied boundary NAV and does not derive one", () => {
    expect(navView({ atBoundary: true, navUsdg: 9_420_000_000n })).toEqual({
      available: true,
      navUsdg: 9_420_000_000n,
    });
  });
});

describe("epochResult", () => {
  it("records a losing epoch as a negative USDG fact", () => {
    // Vector from ops/fixtures/api/v2/house/NVDA.json: the settled epoch 1788552000 has
    // nav.navUsdg.raw "9420000000" and resultUsdg.raw "-180000000" (6 dp), so it started at
    // 9600000000. Both figures read from that file, not reasoned.
    const row = epochResult(9_600_000_000n, 9_420_000_000n);
    expect(row.resultUsdg).toBe(-180_000_000n);
    expect(row.resultUsdg < 0n).toBe(true);
    expect(row.endNavUsdg).toBe(9_420_000_000n);
  });

  it("records a winning epoch as a positive USDG fact", () => {
    const row = epochResult(1_000_000_000n, 1_250_000_000n);
    expect(row.resultUsdg).toBe(250_000_000n);
  });
});

describe("inKindPreview", () => {
  it("refuses to value a withdrawal mid-epoch, exactly as navView does", () => {
    // The boundary discipline has to hold on BOTH doors. Mid-epoch the vault also holds open
    // ERC-1155 positions, so no pair of token balances describes what a share is worth.
    const preview = inKindPreview({ atBoundary: false });
    expect(preview).toEqual({ available: false, message: NAV_NOT_AVAILABLE });
    expect(preview.available).toBe(false);
  });

  it("composes both floors, and is strictly below what a single floor would promise", () => {
    expect(USDG_DECIMALS).toBe(6);
    expect(STOCK_DECIMALS).toBe(18);
    expect(SHARE_DECIMALS).toBe(18);

    const a = inKindPreview(atBoundary(ALICE));
    if (!a.available) throw new Error("boundary input must produce a preview");

    // Stage 1 -- HouseVault.rollEpoch:617-618 (contracts v8 0124b58e), the whole queue out of the pool.
    expect(a.queueUsdg).toBe((POOL_USDG * QUEUE_SHARES) / TOTAL_SHARES);
    expect(a.queueUsdg).toBe(75_000_001n);
    expect(a.queueStock).toBe(3_000_000_000_000_000_001n);

    // Stage 2 -- HouseVault.claim:478-479, this holder out of that.
    expect(a.usdgOut).toBe((a.queueUsdg * ALICE) / QUEUE_SHARES);
    expect(a.usdgOut).toBe(50_000_000n);
    expect(a.stockOut).toBe(2_000_000_000_000_000_000n);

    // THE POINT OF THE VECTOR: one floor is not two. A single-stage preview would quote
    // 50_000_001 and 2_000_000_000_000_000_001 -- one base unit more than claim() will pay in
    // each asset. A preview that overstates the payout is the defect this asserts against.
    const oneStageUsdg = (POOL_USDG * ALICE) / TOTAL_SHARES;
    const oneStageStock = (POOL_STOCK * ALICE) / TOTAL_SHARES;
    expect(oneStageUsdg).toBe(50_000_001n);
    expect(oneStageStock).toBe(2_000_000_000_000_000_001n);
    expect(a.usdgOut).toBeLessThan(oneStageUsdg);
    expect(a.stockOut).toBeLessThan(oneStageStock);
  });

  it("the queue's slice exceeds the sum of the previews: the residue is real dust", () => {
    const a = inKindPreview(atBoundary(ALICE));
    const b = inKindPreview(atBoundary(BOB));
    if (!a.available || !b.available) throw new Error("boundary input must produce a preview");

    // Alice and Bob are the entire queue, so their two previews are the whole batch as this module
    // previews it. The residue is real dust and it is strictly positive for this vector -- not an
    // identity that holds for any input, which is what the previous version of this assertion was.
    // WHERE THE DUST GOES is the next test's subject: since SEC-27 it is paid to the last claimant,
    // it does NOT stay in the vault, and this test's conservation equation is about the preview's
    // own outputs, not about the contract's final balances.
    expect(ALICE + BOB).toBe(QUEUE_SHARES);
    const usdgDust = a.queueUsdg - (a.usdgOut + b.usdgOut);
    const stockDust = a.queueStock - (a.stockOut + b.stockOut);
    expect(usdgDust).toBe(1n);
    expect(stockDust).toBe(1n);
    expect(usdgDust).toBeGreaterThan(0n);
    expect(stockDust).toBeGreaterThan(0n);

    // Nothing overdraws: the two payouts together never exceed the queue's slice, and the queue's
    // slice never exceeds the pool.
    expect(a.usdgOut + b.usdgOut).toBeLessThanOrEqual(a.queueUsdg);
    expect(a.stockOut + b.stockOut).toBeLessThanOrEqual(a.queueStock);
    expect(a.queueUsdg).toBeLessThanOrEqual(POOL_USDG);
    expect(a.queueStock).toBeLessThanOrEqual(POOL_STOCK);

    // Conservation, stated as a real equation rather than a tautology: pool = previewed out + kept
    // for the non-withdrawing shareholders + dust.
    expect(a.usdgOut + b.usdgOut + a.usdgLeftInVault + usdgDust).toBe(POOL_USDG);
    expect(a.stockOut + b.stockOut + a.stockLeftInVault + stockDust).toBe(POOL_STOCK);
  });

  it("is exact for the first claimant and a lower bound for every later one (SEC-27 run-down)", () => {
    // HouseVault.claim:478-503 at contracts v8 0124b58e756568b239f7ad97acd1571add5b58a9 pays each
    // claimant mulDiv(batchUsdgRemaining, holderShares, batchSharesRemaining) and then SUBTRACTS what
    // it paid from the batch (SEC-27, T-SEC-P4-HOUSEVAULT 5c7ac72b), so the last claimant of an epoch
    // divides the whole remainder by the whole remaining share count and takes the dust. This test
    // walks that run-down for both claim orders and asserts what the preview may promise against it.
    const a = inKindPreview(atBoundary(ALICE));
    const b = inKindPreview(atBoundary(BOB));
    if (!a.available || !b.available) throw new Error("boundary input must produce a preview");

    type Paid = { usdg: bigint; stock: bigint };
    const runDown = (order: Array<[holder: "alice" | "bob", shares: bigint]>) => {
      let usdg = a.queueUsdg;
      let stock = a.queueStock;
      let shares = QUEUE_SHARES;
      const paid: Record<"alice" | "bob", Paid> = { alice: { usdg: 0n, stock: 0n }, bob: { usdg: 0n, stock: 0n } };
      for (const [holder, s] of order) {
        const payUsdg = (usdg * s) / shares;
        const payStock = (stock * s) / shares;
        paid[holder] = { usdg: payUsdg, stock: payStock };
        usdg -= payUsdg;
        stock -= payStock;
        shares -= s;
      }
      // Nothing is stranded: the running totals reach zero together (HouseVault.claim:496-500).
      expect(usdg).toBe(0n);
      expect(stock).toBe(0n);
      expect(shares).toBe(0n);
      return paid;
    };

    const aliceFirst = runDown([["alice", ALICE], ["bob", BOB]]);
    const bobFirst = runDown([["bob", BOB], ["alice", ALICE]]);

    // Whoever claims first receives exactly the preview.
    expect(aliceFirst.alice.usdg).toBe(a.usdgOut);
    expect(aliceFirst.alice.stock).toBe(a.stockOut);
    expect(bobFirst.bob.usdg).toBe(b.usdgOut);
    expect(bobFirst.bob.stock).toBe(b.stockOut);

    // Whoever claims last receives the preview PLUS the batch's dust -- one base unit for this vector.
    expect(aliceFirst.bob.usdg).toBe(b.usdgOut + 1n);
    expect(aliceFirst.bob.stock).toBe(b.stockOut + 1n);
    expect(bobFirst.alice.usdg).toBe(a.usdgOut + 1n);
    expect(bobFirst.alice.stock).toBe(a.stockOut + 1n);

    // THE PROTECTED FACT: in neither order does any holder receive LESS than previewed. A preview that
    // overstates the payout is the defect this module exists to refuse; run-down accounting only ever
    // moves the truth upward from the two-stage floor.
    for (const paid of [aliceFirst, bobFirst]) {
      expect(paid.alice.usdg).toBeGreaterThanOrEqual(a.usdgOut);
      expect(paid.alice.stock).toBeGreaterThanOrEqual(a.stockOut);
      expect(paid.bob.usdg).toBeGreaterThanOrEqual(b.usdgOut);
      expect(paid.bob.stock).toBeGreaterThanOrEqual(b.stockOut);
    }
  });

  it("usdgLeftInVault is the pool minus the WHOLE queue, not minus this one holder", () => {
    const a = inKindPreview(atBoundary(ALICE));
    if (!a.available) throw new Error("boundary input must produce a preview");
    expect(a.usdgLeftInVault).toBe(POOL_USDG - a.queueUsdg);
    expect(a.usdgLeftInVault).toBe(25_000_001n);
    expect(a.stockLeftInVault).toBe(POOL_STOCK - a.queueStock);
    // The old meaning -- pool minus this holder's slice -- would have been 50_000_002, double the
    // truth, and a page rendering "remaining in vault" from it would be wrong by 2x.
    expect(a.usdgLeftInVault).not.toBe(POOL_USDG - a.usdgOut);
  });

  it("pays nothing when the withdraw queue is empty, matching the contract's guards", () => {
    const none = inKindPreview({
      atBoundary: true,
      shares: 0n,
      queueShares: 0n,
      totalShares: TOTAL_SHARES,
      poolUsdg: POOL_USDG,
      poolStock: POOL_STOCK,
    });
    if (!none.available) throw new Error("boundary input must produce a preview");
    expect(none.usdgOut).toBe(0n);
    expect(none.stockOut).toBe(0n);
    expect(none.queueUsdg).toBe(0n);
    expect(none.usdgLeftInVault).toBe(POOL_USDG);
  });

  it("rejects inputs the contract could never present", () => {
    expect(() => inKindPreview({ ...atBoundary(ALICE), totalShares: 0n })).toThrow();
    expect(() =>
      inKindPreview({ ...atBoundary(ALICE), queueShares: TOTAL_SHARES + 1n }),
    ).toThrow();
    expect(() => inKindPreview(atBoundary(QUEUE_SHARES + 1n))).toThrow();
    expect(() => inKindPreview({ ...atBoundary(ALICE), poolUsdg: -1n })).toThrow();
  });
});

describe("countdown", () => {
  it("counts unix seconds remaining and formats America/New_York", () => {
    expect(secondsUntilBoundary(1_700_000_000, 1_700_000_100)).toBe(100);
    expect(secondsUntilBoundary(1_700_000_200, 1_700_000_100)).toBe(0);
    const stamp = formatNewYork(1_700_000_000);
    expect(stamp.length).toBeGreaterThan(0);
    expect(NEW_YORK_TIME_ZONE).toBe("America/New_York");
    // Exact, not substring: a rewrite that keeps "next boundary" and the stamp but loses the meaning
    // ("does not join before the next boundary") stayed green under the previous two `toContain`s.
    expect(depositJoinsSentence(1_700_000_000)).toBe(
      `Your deposit joins at the next boundary (${stamp}).`,
    );
  });
});
