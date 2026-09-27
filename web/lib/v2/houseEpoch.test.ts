import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  boundaryState,
  cutoffSentences,
  HOUSE_ROLL_OVERDUE_S,
  houseExposed,
  houseHeldUntil,
  UNPINNED_BOUNDARY_HOLD_S,
  NAV_NOT_AVAILABLE,
  NEW_YORK_TIME_ZONE,
  SHARE_DECIMALS,
  STOCK_DECIMALS,
  USDG_DECIMALS,
  depositJoinsSentence,
  epochResult,
  formatNewYork,
  houseRollPreviewLabel,
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

describe("houseRollPreviewLabel", () => {
  it("labels a non-exact preview as an estimate and an exact one as the close", () => {
    expect(houseRollPreviewLabel(false)).toMatch(/estimate/i);
    expect(houseRollPreviewLabel(true)).not.toMatch(/estimate/i);
    expect(houseRollPreviewLabel(false)).not.toBe(houseRollPreviewLabel(true));
  });
});

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

    // Stage 1 -- HouseVault.rollEpoch, the whole queue out of the pool.
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
    // WHERE THE DUST GOES is the next test's subject: it is paid to the last claimant,
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

  it("is exact for the first claimant and a lower bound for every later one (the batch runs down as claims pay)", () => {
    // HouseVault.claim (HouseVault.sol) pays each
    // claimant mulDiv(batchUsdgRemaining, holderShares, batchSharesRemaining) and then SUBTRACTS what
    // it paid from the batch, so the last claimant of an epoch
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
    // Exact, not substring: a rewrite that keeps "next close" and the stamp but loses the meaning
    // ("does not join before the next close") stayed green under the previous two `toContain`s.
    expect(depositJoinsSentence(1_700_000_000)).toBe(
      `Your deposit joins at the next close (${stamp}).`,
    );
  });
});

/**
 * The two cutoffs are separate rules, stated separately, and the wording follows the cadence.
 * The close is the vault's own epochEnd, stamped; no sentence hard-codes "Fri" or "4:00 pm", because a
 * holiday week closes on Thursday and an early-close day closes at 1:00 pm.
 */
describe("cutoffSentences", () => {
  const friday = 1_789_156_800; // Fri 2026-09-11 16:00 EDT
  const thursday = friday - 86_400; // a holiday week's last trading day
  /** A test fixture for the chain's SETTLEMENT_WINDOW() read; cutoffSentences takes it, never a literal. */
  const W = 1_800;
  it("requests stop SETTLEMENT_WINDOW before the close they were given; the withdrawal rule is the same for both", () => {
    const w = cutoffSentences("weekly", friday, W);
    const d = cutoffSentences("daily", friday, W);
    expect(w.deposit).toBe(`Deposit before ${formatNewYork(friday - W)} to be priced at this week's close (${formatNewYork(friday)}).`);
    expect(d.deposit).toBe(`Deposit before ${formatNewYork(friday - W)} to be priced at today's close (${formatNewYork(friday)}).`);
    expect(d.deposit).not.toMatch(/fri|week/i);
    expect(d.idle).not.toMatch(/fri|week|monday/i);
    expect(w.withdraw).toBe(d.withdraw);
    // This reversed "Withdrawal requests are taken until the close is processed".
    expect(w.withdraw).toBe(`Withdrawal requests are taken until ${formatNewYork(friday - W)}, 30 minutes before the close, and are priced at that close.`);
  });

  it("the window is the one passed in, not a literal", () => {
    expect(cutoffSentences("daily", friday, 600).withdraw)
      .toBe(`Withdrawal requests are taken until ${formatNewYork(friday - 600)}, 10 minutes before the close, and are priced at that close.`);
  });

  it("names no weekday or clock time of its own, so a holiday-week close is stated as it is", () => {
    const h = cutoffSentences("weekly", thursday, W);
    expect(h.deposit).toBe(`Deposit before ${formatNewYork(thursday - W)} to be priced at this week's close (${formatNewYork(thursday)}).`);
    for (const c of [h, cutoffSentences("daily", thursday, W)]) {
      // The stamps are the chain's own times and may read "4:00 PM"; only the words around them are checked.
      const text = [c.deposit, c.withdraw, c.idle].join(" ")
        .split(formatNewYork(thursday)).join("").split(formatNewYork(thursday - W)).join("");
      expect(text).not.toMatch(/fri|monday|4:00|\bpm\b|boundary|epoch/i);
    }
  });
});

describe("boundaryState", () => {
  const end = 1_789_156_800;
  it("is open before the close, waiting from the close for seven hours, overdue after", () => {
    expect(boundaryState(end - 1, end)).toBe("open");
    expect(boundaryState(end, end)).toBe("waiting");
    expect(boundaryState(end + HOUSE_ROLL_OVERDUE_S, end)).toBe("waiting");
    expect(boundaryState(end + HOUSE_ROLL_OVERDUE_S + 1, end)).toBe("overdue");
  });

  // A close money is exposed to that the vault did not lock is HELD by rollEpoch for a week.
  it("is held, not overdue, from the close until a week after it when the vault did not lock an exposed boundary", () => {
    const unlocked = { pinnedBoundary: 0, exposed: true };
    expect(UNPINNED_BOUNDARY_HOLD_S).toBe(604_800);
    expect(houseHeldUntil(end)).toBe(end + UNPINNED_BOUNDARY_HOLD_S);
    expect(boundaryState(end - 1, end, unlocked)).toBe("open");
    expect(boundaryState(end, end, unlocked)).toBe("held");
    expect(boundaryState(end + HOUSE_ROLL_OVERDUE_S + 1, end, unlocked)).toBe("held");
    expect(boundaryState(houseHeldUntil(end) - 1, end, unlocked)).toBe("held");
    expect(boundaryState(houseHeldUntil(end), end, unlocked), "past the hold an unrolled close is late again").toBe("overdue");
    expect(boundaryState(end, end, { pinnedBoundary: end - 604_800, exposed: true }), "a lock of the previous close is not this one's").toBe("held");
  });

  it("is never held for a locked close, an unexposed vault, or reads that failed", () => {
    const late = end + HOUSE_ROLL_OVERDUE_S + 1;
    expect(boundaryState(late, end, { pinnedBoundary: end, exposed: true })).toBe("overdue");
    expect(boundaryState(late, end, { pinnedBoundary: 0, exposed: false })).toBe("overdue");
    expect(boundaryState(late, end, { pinnedBoundary: 0, exposed: null })).toBe("overdue");
    expect(boundaryState(late, end, { pinnedBoundary: null, exposed: true })).toBe("overdue");
    expect(boundaryState(late, end, null)).toBe("overdue");
  });

  it("houseExposed: shares or a queued deposit; unknown when a read failed", () => {
    expect(houseExposed(0n, { usdg: 0n, stock: 0n })).toBe(false);
    expect(houseExposed(1n, { usdg: 0n, stock: 0n })).toBe(true);
    expect(houseExposed(0n, { usdg: 1n, stock: 0n })).toBe(true);
    expect(houseExposed(0n, { usdg: 0n, stock: 1n })).toBe(true);
    expect(houseExposed(null, { usdg: 0n, stock: 0n })).toBeNull();
    expect(houseExposed(0n, null)).toBeNull();
    expect(houseExposed(undefined, undefined)).toBeNull();
  });

  it("mirrors the keeper's HOUSE_ROLL_OVERDUE_S rather than restating it", () => {
    const steps = readFileSync(join(import.meta.dirname, "..", "..", "..", "keeper", "src", "v2", "cranker", "steps.ts"), "utf8");
    expect(HOUSE_ROLL_OVERDUE_S).toBe(keeperConst(steps, "HOUSE_ROLL_OVERDUE_S"));
  });
});

/**
 * The value of `export const <name> = <expr>;` in keeper source text, where <expr> is a sum of products of integer
 * literals and other exported constants of the same file. Any other shape throws, so the mirror above fails loudly
 * rather than comparing against a number it could not read.
 */
function keeperConst(src: string, name: string, seen: readonly string[] = []): number {
  if (seen.includes(name)) throw new Error(`keeper constant cycle: ${[...seen, name].join(" -> ")}`);
  const m = src.match(new RegExp(`export const ${name} = ([^;]+);`));
  if (!m) throw new Error(`keeper/src/v2/cranker/steps.ts no longer exports ${name}`);
  const expr = m[1]!;
  const value = expr.split("+").reduce(
    (sum, term) =>
      sum +
      term.split("*").reduce((product, raw) => {
        const factor = raw.trim();
        if (/^[0-9][0-9_]*$/.test(factor)) return product * Number(factor.replace(/_/g, ""));
        if (/^[A-Z][A-Z0-9_]*$/.test(factor)) return product * keeperConst(src, factor, [...seen, name]);
        throw new Error(`cannot resolve keeper ${name} = ${expr}: "${factor}" is not an integer literal or constant`);
      }, 1),
    0,
  );
  if (!Number.isSafeInteger(value)) throw new Error(`keeper ${name} = ${expr} resolved to ${value}`);
  return value;
}
