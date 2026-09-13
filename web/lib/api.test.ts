/**
 * The consumer's half of the web <-> indexer contract.
 *
 * The four files under ops/fixtures/api/ are exactly what `/v1/cycles` puts on the wire for a
 * filled, an unfilled, an assigned and a skipped (idle) week; indexer/src/api/index.test.ts
 * proves the indexer still emits them. This file proves `normaliseCycle` still reads them, down
 * to the base-unit integer. The readiness audit found the dapp reading flat keys the indexer
 * never sent, so a week that sold 12 contracts for 48 USDG rendered as "unfilled, 0" and an
 * assigned week as "open". The assertions that matter most are therefore the negatives: the
 * filled fixture must not come out `filled: false`, the assigned one must not come out
 * `settled: false`, and a skipped week whose expiry has passed must not come out `settled:
 * false` either — that one rendered as "the week is still running" for ever, because nothing
 * ever closes a week the vault never wrote into.
 *
 * No network, no React: `normaliseCycle` is a pure function over parsed JSON. The fixtures are
 * read from disk by relative path so a fixture edit is a test edit, visible in the same diff.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { normaliseCycle } from "./api";
import { fmtRealizedWeek, fmtUsdg, premiumPerShare } from "./format";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../ops/fixtures/api/${name}`, import.meta.url), "utf8"));
}

/** ISO → epoch seconds, the way the row stores every timestamp. */
const secs = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

const WAD = 10n ** 18n;

describe("normaliseCycle reads the indexer's nested shape (ops/fixtures/api/)", () => {
  it("cycle-filled.json: a week that sold 12 contracts is filled, with every figure intact", () => {
    const row = normaliseCycle(fixture("cycle-filled.json"));
    expect(row).not.toBeNull();
    const r = row!;

    // The audit's failure mode, stated as the assertion.
    expect(r.filled).not.toBe(false);
    expect(r.filled).toBe(true);
    expect(r.settled).toBe(true);
    expect(r.wrote).toBe(true);
    expect(r.status).toBe("closed");

    // USDG figures are 6-decimal base units, read from `raw`, never from `formatted`.
    expect(r.harvestGrossUsdg).toBe(45_600000n); // the vault's take: 48 gross less Overcall's 5%
    expect(r.premiumGrossUsdg).toBe(45_600000n); // nothing assigned, so all of it is premium
    expect(r.feeUsdg).toBe(2_280000n); // the protocol's 5% of the premium
    expect(r.premiumNetUsdg).toBe(43_320000n); // what depositors earned
    expect(r.strikeProceedsUsdg).toBe(0n);
    expect(r.creditedUsdg).toBe(43_320000n);
    expect(r.strikeUsdg).toBe(190_000000n);

    // Shares are 18 decimals: 100 whole shares.
    expect(r.sharesAtHarvest).toBe(100n * WAD);
    // 43.32 USDG over 100 shares: 0.433200 USDG per share, in USDG base units.
    expect(r.premiumNetPerShare).toBe(433200n);

    expect(r.contracts).toBe(12n);
    expect(r.contractsSold).toBe(12n);
    expect(r.contractsAssigned).toBe(0n);
    expect(r.optionId).toBe(0x8f3a9c1d2e4b5a6f7c8d9e0f1a2b3c4d5e6f7a8b_000000000000000000000000n);

    expect(r.orderHash).toBe("0x0000000000000000000000000000000000000000000000000000000000000073");
    expect(r.txOpen).toBe("0x0000000000000000000000000000000000000000000000000000000000000072");
    expect(r.txClose).toBe("0x0000000000000000000000000000000000000000000000000000000000000074");

    // Timestamps: ISO on the wire, epoch seconds in the row.
    expect(r.openedAt).toBe(secs("2026-08-31T14:35:00Z"));
    expect(r.listedAt).toBe(secs("2026-08-31T14:36:00Z"));
    expect(r.filledAt).toBe(secs("2026-09-01T15:10:00Z"));
    expect(r.closedAt).toBe(secs("2026-09-04T21:00:30Z"));
    expect(r.exerciseTs).toBe(1788552000);
    expect(r.expiryTs).toBe(1788555600);

    // The indexer's cycle row carries neither; they must be absent, not zero.
    expect(r.assetsAtHarvest).toBeUndefined();
    expect(r.spotUsdgAtHarvest).toBeUndefined();
  });

  it("cycle-unfilled.json: wrote 12, sold 0, every money field exactly zero, and settled", () => {
    const r = normaliseCycle(fixture("cycle-unfilled.json"))!;
    expect(r.filled).toBe(false);
    expect(r.settled).toBe(true);
    expect(r.status).toBe("unfilled");
    expect(r.contracts).toBe(12n);
    expect(r.contractsSold).toBe(0n);
    expect(r.contractsAssigned).toBe(0n);
    expect(r.harvestGrossUsdg).toBe(0n);
    expect(r.premiumGrossUsdg).toBe(0n);
    expect(r.feeUsdg).toBe(0n);
    expect(r.premiumNetUsdg).toBe(0n);
    expect(r.strikeProceedsUsdg).toBe(0n);
    expect(r.creditedUsdg).toBe(0n);
    expect(r.premiumNetPerShare).toBe(0n);
    expect(r.sharesAtHarvest).toBe(100n * WAD);
    expect(r.wrote).toBe(true);
    expect(r.filledAt).toBeUndefined();
    expect(r.closedAt).toBe(secs("2026-09-11T21:00:30Z"));
  });

  it("cycle-assigned.json: sold 12, 5 assigned, premium and strike proceeds apart, and NOT open", () => {
    const r = normaliseCycle(fixture("cycle-assigned.json"))!;

    // The audit's other failure mode: an assigned week rendering as "open".
    expect(r.settled).not.toBe(false);
    expect(r.settled).toBe(true);
    expect(r.filled).toBe(true);
    expect(r.status).toBe("assigned");

    expect(r.contractsSold).toBe(12n);
    expect(r.contractsAssigned).toBe(5n);
    // 45.6 premium to the vault + 5 × 190 at the strike = 995.6 swept. The protocol fee is 5%
    // of the 45.6 premium only (floor(45_600000 × 500 / 10_000) = 2_280000); the 950 of strike
    // proceeds are never fee'd, and 995.6 − 2.28 = 993.32 is credited to holders.
    expect(r.harvestGrossUsdg).toBe(995_600000n);
    expect(r.feeUsdg).toBe(2_280000n);
    expect(r.creditedUsdg).toBe(993_320000n);
    // W-21: the premium figures are premium only. 995.6 − 950 = 45.6 premium; 45.6 − 2.28 =
    // 43.32 net premium, identical to the filled week that sold the same 12 contracts.
    expect(r.strikeProceedsUsdg).toBe(950_000000n);
    expect(r.premiumGrossUsdg).toBe(45_600000n);
    expect(r.premiumNetUsdg).toBe(43_320000n);
    expect(r.premiumNetUsdg).toBe(normaliseCycle(fixture("cycle-filled.json"))!.premiumNetUsdg);
    expect(r.premiumNetUsdg! + r.strikeProceedsUsdg!).toBe(r.creditedUsdg);
    // 43_320000 × 1e18 / 100e18 = 433_200 per share, not 993_320000 / 100 = 9_933_200.
    expect(r.premiumNetPerShare).toBe(433200n);
    expect(r.sharesAtHarvest).toBe(100n * WAD);
    expect(r.closedAt).toBe(secs("2026-09-18T21:00:30Z"));
    expect(r.txClose).toBe("0x0000000000000000000000000000000000000000000000000000000000000094");
  });

  it("cycle-assigned.json renders premium-only realized figures and a separate strike line", () => {
    const r = normaliseCycle(fixture("cycle-assigned.json"))!;
    // What `/`, `/vault/nvda` and `/activity` put on screen for this week.
    expect(fmtUsdg(premiumPerShare(r), 6)).toBe("0.433200");
    expect(fmtUsdg(r.premiumGrossUsdg)).toBe("45.60");
    expect(fmtUsdg(r.premiumNetUsdg)).toBe("43.32");
    expect(fmtUsdg(r.strikeProceedsUsdg)).toBe("950.00");
    // Net premium over collateral at harvest. Take 7 lots left × 200 USDG spot = 1_400_000000
    // of collateral: 43_320000 × 100 × 100_000 / 1_400_000000 = 309_428 → 3.09428% → "3.094%".
    // With the strike proceeds wrongly included it would be 993_320000 / 1_400_000000 = 70.951%.
    const tvl = 1_400_000000n;
    expect(fmtRealizedWeek(r.premiumNetUsdg, tvl)).toBe("3.094%");
    expect(fmtRealizedWeek(r.creditedUsdg, tvl)).toBe("70.951%");
  });

  it("splits a pre-W-21 indexer payload by subtraction, where premiumNet still meant gross − fee", () => {
    // The shape before this change: no `creditedUsdg`, no `strikeProceedsUsdg`, and
    // `harvest.premiumNet` = 993.32 INCLUDING the strike proceeds. The split comes from
    // `settlement.assignmentUsdg`: 995.6 − 950 = 45.6 premium; 993.32 − 950 = 43.32 net premium.
    const r = normaliseCycle({
      cycle: 9,
      status: "assigned",
      filled: true,
      fill: { contractsSold: "12" },
      settlement: { contractsAssigned: "5", assignmentUsdg: { raw: "950000000", decimals: 6 } },
      harvest: {
        grossUsdg: { raw: "995600000", decimals: 6 },
        fee: { raw: "2280000", decimals: 6 },
        premiumNet: { raw: "993320000", decimals: 6 },
        usdgPerShare: { raw: "9933200", decimals: 6 },
      },
    })!;
    expect(r.creditedUsdg).toBe(993_320000n);
    expect(r.strikeProceedsUsdg).toBe(950_000000n);
    expect(r.premiumGrossUsdg).toBe(45_600000n);
    expect(r.premiumNetUsdg).toBe(43_320000n);
    // The old per-share figure included the strike proceeds and is never carried.
    expect(r.premiumNetPerShare).toBeUndefined();
  });

  it("an assigned week that does not say how much was strike proceeds has no premium figure at all", () => {
    // 5 contracts assigned and no strike figure anywhere: the premium is unknown. It must come
    // out undefined (a dash), never as the whole harvest.
    const r = normaliseCycle({
      cycle: 12,
      status: "assigned",
      contractsSold: "12",
      contractsAssigned: "5",
      grossUsdg: "995600000",
      feeUsdg: "2280000",
      netUsdg: "993320000",
    })!;
    expect(r.creditedUsdg).toBe(993_320000n);
    expect(r.strikeProceedsUsdg).toBeUndefined();
    expect(r.premiumGrossUsdg).toBeUndefined();
    expect(r.premiumNetUsdg).toBeUndefined();
    expect(fmtUsdg(r.premiumNetUsdg)).toBe("—");
    expect(fmtRealizedWeek(r.premiumNetUsdg, 1_400_000000n)).toBe("—");
  });

  it("uses the indexer's own `filled` when present, even if USDG arrived without a sale", () => {
    // USDG sent straight to the vault is harvested but nobody bought a call. The indexer says
    // unfilled (contractsSold is 0) and the page must not contradict it.
    const r = normaliseCycle({
      cycle: 4,
      status: "unfilled",
      filled: false,
      fill: { contractsSold: "0" },
      harvest: { grossUsdg: { raw: "7000000", decimals: 6, formatted: "7" } },
    })!;
    expect(r.harvestGrossUsdg).toBe(7_000000n);
    expect(r.filled).toBe(false);
    expect(r.settled).toBe(true);
  });

  it("reads a money object's raw and never its formatted", () => {
    const r = normaliseCycle({
      cycle: 5,
      harvest: { grossUsdg: { raw: "48000000", decimals: 6, formatted: "not a number" } },
    })!;
    expect(r.harvestGrossUsdg).toBe(48_000000n);
  });

  describe("cycle-idle.json: the registry opened the week and the vault sat it out", () => {
    // The fixture's registry expiry: 2026-08-28T21:00:00Z.
    const EXPIRY = 1787950800;

    it("is settled once its expiry has passed — it is a published outcome, not a running week", () => {
      const r = normaliseCycle(fixture("cycle-idle.json"), EXPIRY + 1)!;

      // The gap the review found: this came out `settled: false` and rendered as
      // "the week is still running", permanently, because nothing ever closes a skipped week.
      expect(r.settled).not.toBe(false);
      expect(r.settled).toBe(true);

      expect(r.status).toBe("idle");
      expect(r.wrote).toBe(false);
      expect(r.filled).toBe(false);
      expect(r.expiryTs).toBe(EXPIRY);
      expect(r.exerciseTs).toBe(1787947200);

      // Nothing was written, listed, sold, closed or harvested: absent where the wire says null,
      // zero where the schema defaults to zero. Never a stale figure from another week.
      expect(r.optionId).toBeUndefined();
      expect(r.openedAt).toBeUndefined();
      expect(r.listedAt).toBeUndefined();
      expect(r.orderHash).toBeUndefined();
      expect(r.closedAt).toBeUndefined();
      expect(r.txOpen).toBeUndefined();
      expect(r.txClose).toBeUndefined();
      expect(r.strikeUsdg).toBe(0n);
      expect(r.contracts).toBe(0n);
      expect(r.contractsSold).toBe(0n);
      expect(r.contractsAssigned).toBe(0n);
      expect(r.harvestGrossUsdg).toBe(0n);
      expect(r.feeUsdg).toBe(0n);
      expect(r.premiumNetUsdg).toBe(0n);
      expect(r.strikeProceedsUsdg).toBe(0n);
      expect(r.creditedUsdg).toBe(0n);
      expect(r.sharesAtHarvest).toBe(0n);
    });

    it("is NOT settled before its expiry — the current week is idle until Monday's rollOpen", () => {
      const r = normaliseCycle(fixture("cycle-idle.json"), EXPIRY - 1)!;
      expect(r.settled).toBe(false);
      expect(r.filled).toBe(false);
      expect(r.wrote).toBe(false);
    });

    it("at the expiry itself the week is still live: the registry's `isCycleLive` is `now < expiry`", () => {
      expect(normaliseCycle(fixture("cycle-idle.json"), EXPIRY)!.settled).toBe(false);
    });

    it("an idle status alone, without the indexer's `wrote: false`, is never called settled", () => {
      // A flat payload that says only "idle" has not said whether the vault sat the week out.
      const r = normaliseCycle({ cycle: 10, status: "idle", expiryTs: EXPIRY }, EXPIRY + 1)!;
      expect(r.settled).toBe(false);
      expect(r.wrote).toBeUndefined();
    });

    it("an idle week without a registry expiry is never called settled", () => {
      const r = normaliseCycle({ cycle: 11, status: "idle", wrote: false, settlement: { closedAt: null } })!;
      expect(r.settled).toBe(false);
    });
  });
});

describe("normaliseCycle still accepts the old flat shape", () => {
  it("flat keys, epoch-second timestamps, bigints as strings or numbers", () => {
    const r = normaliseCycle({
      cycle: 3,
      status: "closed",
      grossUsdg: "48000000",
      feeUsdg: 2400000,
      netUsdg: "45600000",
      contracts: 12,
      contractsSold: "12",
      contractsAssigned: "0",
      strikeUsdg: "190000000",
      sharesAtHarvest: "100000000000000000000",
      openedAt: 1788190500,
      closedAt: 1788555630,
      txOpen: "0x0000000000000000000000000000000000000000000000000000000000000001",
    })!;
    expect(r.filled).toBe(true);
    expect(r.settled).toBe(true);
    expect(r.harvestGrossUsdg).toBe(48_000000n);
    expect(r.feeUsdg).toBe(2_400000n);
    expect(r.creditedUsdg).toBe(45_600000n);
    // contractsAssigned "0" and no strike figure: nothing can be strike proceeds, so all premium.
    expect(r.strikeProceedsUsdg).toBe(0n);
    expect(r.premiumGrossUsdg).toBe(48_000000n);
    expect(r.premiumNetUsdg).toBe(45_600000n);
    expect(r.contracts).toBe(12n);
    expect(r.contractsSold).toBe(12n);
    expect(r.strikeUsdg).toBe(190_000000n);
    expect(r.sharesAtHarvest).toBe(100n * WAD);
    expect(r.openedAt).toBe(1788190500);
    expect(r.closedAt).toBe(1788555630);
    expect(r.txOpen).toBe("0x0000000000000000000000000000000000000000000000000000000000000001");
  });

  it("flat shape with no contractsSold falls back to the money to decide filled", () => {
    const paid = normaliseCycle({ cycle: 1, grossUsdg: "1", closedAt: "2026-09-04T21:00:30Z" })!;
    expect(paid.filled).toBe(true);
    expect(paid.settled).toBe(true);
    expect(paid.closedAt).toBe(secs("2026-09-04T21:00:30Z"));

    const zero = normaliseCycle({ cycle: 2, grossUsdg: "0", netUsdg: 0, status: "unfilled" })!;
    expect(zero.filled).toBe(false);
    expect(zero.settled).toBe(true);
  });

  it("returns null without a cycle number", () => {
    expect(normaliseCycle({ status: "closed" })).toBeNull();
    expect(normaliseCycle(null)).toBeNull();
  });
});
