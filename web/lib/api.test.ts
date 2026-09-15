/**
 * The consumer's half of the web <-> indexer contract.
 *
 * The four files under ops/fixtures/api/ are exactly what `/v1/cycles` puts on the wire for a
 * filled, an unfilled, an assigned and a stranded week; indexer/src/api/index.test.ts proves the
 * indexer still emits them. This file proves `normaliseCycle` still reads them, down to the
 * base-unit integer. The readiness audit found the dapp reading flat keys the indexer never sent,
 * so a week that sold 12 contracts for 48 USDG rendered as "unfilled, 0" and an assigned week as
 * "open". The assertions that matter most are therefore the negatives: the filled fixture must
 * not come out `filled: false`, the assigned one must not come out `settled: false`, and the
 * stranded one must not come out as a running week — its close ran and its premium was
 * harvested; only the claim is still inside Valorem.
 *
 * THE MONEY. Under write on fill there is one payment leg, to the vault, so a 12-contract week
 * at 4.000000 USDG is exactly 48 gross, 2.4 protocol fee (5% of 48), 45.6 net, 0.456 per share
 * over 100 shares. An assigned week with 5 contracts taken at 190 sweeps 48 + 950 = 998, and the
 * fee is still 2.4: the 950 of strike proceeds is returned principal and is never fee'd.
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
    expect(r.status).toBe("closed");
    expect(r.stranded).toBe(false);
    expect(r.strandGen).toBeUndefined();
    expect(r.strandRecovered).toBeUndefined();

    // USDG figures are 6-decimal base units, read from `raw`, never from `formatted`. One leg,
    // to the vault: 12 × 4.000000 = 48 gross, and the buyer paid exactly that.
    expect(r.harvestGrossUsdg).toBe(48_000000n);
    expect(r.premiumGrossUsdg).toBe(48_000000n); // nothing assigned, so all of it is premium
    expect(r.feeUsdg).toBe(2_400000n); // the protocol's 5% of the premium
    expect(r.premiumNetUsdg).toBe(45_600000n); // what depositors earned
    expect(r.strikeProceedsUsdg).toBe(0n);
    expect(r.creditedUsdg).toBe(45_600000n);
    expect(r.strikeUsdg).toBe(190_000000n);

    // Shares are 18 decimals: 100 whole shares.
    expect(r.sharesAtHarvest).toBe(100n * WAD);
    // 45.6 USDG over 100 shares: 0.456000 USDG per share, in USDG base units.
    expect(r.premiumNetPerShare).toBe(456000n);

    expect(r.contracts).toBe(12n);
    expect(r.contractsSold).toBe(12n);
    expect(r.contractsAssigned).toBe(0n);
    expect(r.optionId).toBe(0x8f3a9c1d2e4b5a6f7c8d9e0f1a2b3c4d5e6f7a8b_000000000000000000000000n);

    expect(r.orderHash).toBe("0x0000000000000000000000000000000000000000000000000000000000000073");
    expect(r.txOpen).toBe("0x0000000000000000000000000000000000000000000000000000000000000072");
    expect(r.txClose).toBe("0x0000000000000000000000000000000000000000000000000000000000000074");

    // Timestamps: ISO on the wire, epoch seconds in the row. The clock is the option type's.
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

  it("cycle-unfilled.json: armed and listed 12, wrote and sold 0, every money field exactly zero, and settled", () => {
    const r = normaliseCycle(fixture("cycle-unfilled.json"))!;
    expect(r.filled).toBe(false);
    expect(r.settled).toBe(true);
    expect(r.status).toBe("unfilled");
    // Nothing was written: under write on fill the arm writes nothing and no fill came.
    expect(r.contracts).toBe(0n);
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
    expect(r.stranded).toBe(false);
    expect(r.filledAt).toBeUndefined();
    // The type was armed and an order authorised; the listing's size is not the week's size.
    expect(r.optionId).toBe(0x8f3a9c1d2e4b5a6f7c8d9e0f1a2b3c4d5e6f7a8b_000000000000000000000000n);
    expect(r.orderHash).toBe("0x0000000000000000000000000000000000000000000000000000000000000083");
    expect(r.closedAt).toBe(secs("2026-09-11T21:00:30Z"));
  });

  it("cycle-assigned.json: sold 12, 5 assigned, premium and strike proceeds apart, and NOT open", () => {
    const r = normaliseCycle(fixture("cycle-assigned.json"))!;

    // The audit's other failure mode: an assigned week rendering as "open".
    expect(r.settled).not.toBe(false);
    expect(r.settled).toBe(true);
    expect(r.filled).toBe(true);
    expect(r.status).toBe("assigned");
    expect(r.stranded).toBe(false);

    expect(r.contractsSold).toBe(12n);
    expect(r.contractsAssigned).toBe(5n);
    // 48 premium to the vault + 5 × 190 at the strike = 998 swept. The protocol fee is 5% of the
    // 48 premium only (48_000000 × 500 / 10_000 = 2_400000); the 950 of strike proceeds are never
    // fee'd, and 998 − 2.4 = 995.6 is credited to holders.
    expect(r.harvestGrossUsdg).toBe(998_000000n);
    expect(r.feeUsdg).toBe(2_400000n);
    expect(r.creditedUsdg).toBe(995_600000n);
    // W-21: the premium figures are premium only. 998 − 950 = 48 premium; 48 − 2.4 = 45.6 net
    // premium, identical to the filled week that sold the same 12 contracts.
    expect(r.strikeProceedsUsdg).toBe(950_000000n);
    expect(r.premiumGrossUsdg).toBe(48_000000n);
    expect(r.premiumNetUsdg).toBe(45_600000n);
    expect(r.premiumNetUsdg).toBe(normaliseCycle(fixture("cycle-filled.json"))!.premiumNetUsdg);
    expect(r.premiumNetUsdg! + r.strikeProceedsUsdg!).toBe(r.creditedUsdg);
    // 45_600000 × 1e18 / 100e18 = 456_000 per share, not 995_600000 / 100 = 9_956_000.
    expect(r.premiumNetPerShare).toBe(456000n);
    expect(r.sharesAtHarvest).toBe(100n * WAD);
    expect(r.closedAt).toBe(secs("2026-09-18T21:00:30Z"));
    expect(r.txClose).toBe("0x0000000000000000000000000000000000000000000000000000000000000094");
  });

  it("cycle-assigned.json renders premium-only realized figures and a separate strike line", () => {
    const r = normaliseCycle(fixture("cycle-assigned.json"))!;
    // What `/vault/nvda` and `/activity` put on screen for this week.
    expect(fmtUsdg(premiumPerShare(r), 6)).toBe("0.456000");
    expect(fmtUsdg(r.premiumGrossUsdg)).toBe("48.00");
    expect(fmtUsdg(r.premiumNetUsdg)).toBe("45.60");
    expect(fmtUsdg(r.strikeProceedsUsdg)).toBe("950.00");
    // Net premium over collateral at harvest. Take 7 lots left × 200 USDG spot = 1_400_000000
    // of collateral: 45_600000 × 100 × 100_000 / 1_400_000000 = 325_714 → 3.25714% → "3.257%".
    // With the strike proceeds wrongly included it would be 995_600000 / 1_400_000000 = 71.114%.
    const tvl = 1_400_000000n;
    expect(fmtRealizedWeek(r.premiumNetUsdg, tvl)).toBe("3.257%");
    expect(fmtRealizedWeek(r.creditedUsdg, tvl)).toBe("71.114%");
  });

  describe("cycle-stranded.json: the close could not redeem the claim", () => {
    it("is a stranded, SETTLED week: closed and harvested, the claim's legs still zero, the generation known", () => {
      const r = normaliseCycle(fixture("cycle-stranded.json"))!;

      // The failure mode to rule out: a stranded week rendering as "the week is still running".
      // Its close ran (`closedAt`, `txClose`), its premium was harvested, and only the claim is
      // still inside Valorem.
      expect(r.settled).not.toBe(false);
      expect(r.settled).toBe(true);
      expect(r.status).toBe("stranded");
      expect(r.stranded).toBe(true);
      expect(r.strandGen).toBe(1);
      expect(r.strandRecovered).toBe(false);
      expect(r.closedAt).toBe(secs("2026-09-25T21:00:30Z"));
      expect(r.txClose).toBe("0x00000000000000000000000000000000000000000000000000000000000000a4");

      // Sold 12 and 5 were assigned (read before the redeem, so known on a stranded close), but
      // the redeem reverted: RollClose reported zero legs, so the strike proceeds are 0 for now
      // and the harvest is the 48 of premium alone.
      expect(r.filled).toBe(true);
      expect(r.contracts).toBe(12n);
      expect(r.contractsSold).toBe(12n);
      expect(r.contractsAssigned).toBe(5n);
      expect(r.strikeProceedsUsdg).toBe(0n);
      expect(r.harvestGrossUsdg).toBe(48_000000n);
      expect(r.premiumGrossUsdg).toBe(48_000000n);
      expect(r.feeUsdg).toBe(2_400000n);
      expect(r.premiumNetUsdg).toBe(45_600000n);
      expect(r.creditedUsdg).toBe(45_600000n);
      expect(r.premiumNetPerShare).toBe(456000n);
      expect(r.sharesAtHarvest).toBe(100n * WAD);
      expect(r.strikeUsdg).toBe(190_000000n);
      expect(r.exerciseTs).toBe(1790366400);
      expect(r.expiryTs).toBe(1790370000);
    });

    it("stays marked stranded after the recovery, with recovered true and the strike proceeds landed", () => {
      // What the indexer publishes once `retryStrandedClaim` has redeemed the claim: the status
      // resolves to `assigned`, `stranded` stays true (the close did strand), the strand object
      // says recovered, and the retry's fee-free Harvest carried the 950 of strike proceeds.
      const base = fixture("cycle-stranded.json") as Record<string, unknown>;
      const settlement = base.settlement as Record<string, unknown>;
      const harvest = base.harvest as Record<string, unknown>;
      const r = normaliseCycle({
        ...base,
        status: "assigned",
        settlement: {
          ...settlement,
          assignmentUsdg: { raw: "950000000", decimals: 6, formatted: "950" },
          assetsReturned: { raw: "7000000000000000000", decimals: 18, formatted: "7" },
          strand: {
            gen: "1",
            recovered: true,
            recoveredAt: "2026-09-29T15:00:00.000Z",
            recoveredTx: "0x00000000000000000000000000000000000000000000000000000000000000a5",
          },
        },
        harvest: {
          ...harvest,
          grossUsdg: { raw: "998000000", decimals: 6, formatted: "998" },
          strikeProceedsUsdg: { raw: "950000000", decimals: 6, formatted: "950" },
          creditedUsdg: { raw: "995600000", decimals: 6, formatted: "995.6" },
        },
      })!;
      expect(r.settled).toBe(true);
      expect(r.status).toBe("assigned");
      expect(r.stranded).toBe(true);
      expect(r.strandGen).toBe(1);
      expect(r.strandRecovered).toBe(true);
      expect(r.contractsAssigned).toBe(5n);
      expect(r.strikeProceedsUsdg).toBe(950_000000n);
      expect(r.harvestGrossUsdg).toBe(998_000000n);
      expect(r.creditedUsdg).toBe(995_600000n);
      // The premium figures are unchanged by the recovery: it carried strike proceeds only.
      expect(r.premiumGrossUsdg).toBe(48_000000n);
      expect(r.premiumNetUsdg).toBe(45_600000n);
      expect(r.feeUsdg).toBe(2_400000n);
    });

    it("a `stranded` status alone, from a payload without the boolean or the strand object, is stranded and unrecovered", () => {
      const r = normaliseCycle({ cycle: 13, status: "stranded", contractsSold: "3", closedAt: 1790370030 })!;
      expect(r.settled).toBe(true);
      expect(r.stranded).toBe(true);
      expect(r.strandRecovered).toBe(false);
      expect(r.strandGen).toBeUndefined();
    });

    it("stranded true under a resolved status, without a strand object, is read as recovered", () => {
      const r = normaliseCycle({ cycle: 14, status: "closed", stranded: true, contractsSold: "3", closedAt: 1790370030 })!;
      expect(r.stranded).toBe(true);
      expect(r.strandRecovered).toBe(true);
    });
  });

  it("splits a pre-W-21 indexer payload by subtraction, where premiumNet still meant gross − fee", () => {
    // The shape before this change: no `creditedUsdg`, no `strikeProceedsUsdg`, and
    // `harvest.premiumNet` = 995.6 INCLUDING the strike proceeds. The split comes from
    // `settlement.assignmentUsdg`: 998 − 950 = 48 premium; 995.6 − 950 = 45.6 net premium.
    const r = normaliseCycle({
      cycle: 9,
      status: "assigned",
      filled: true,
      fill: { contractsSold: "12" },
      settlement: { contractsAssigned: "5", assignmentUsdg: { raw: "950000000", decimals: 6 } },
      harvest: {
        grossUsdg: { raw: "998000000", decimals: 6 },
        fee: { raw: "2400000", decimals: 6 },
        premiumNet: { raw: "995600000", decimals: 6 },
        usdgPerShare: { raw: "9956000", decimals: 6 },
      },
    })!;
    expect(r.creditedUsdg).toBe(995_600000n);
    expect(r.strikeProceedsUsdg).toBe(950_000000n);
    expect(r.premiumGrossUsdg).toBe(48_000000n);
    expect(r.premiumNetUsdg).toBe(45_600000n);
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
      grossUsdg: "998000000",
      feeUsdg: "2400000",
      netUsdg: "995600000",
    })!;
    expect(r.creditedUsdg).toBe(995_600000n);
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

  it("a running week (listed, or filled and not yet closed) is not settled", () => {
    // The two running statuses. Neither has a close on record, and no clock is consulted: a
    // running week is over when the indexer records its RollClose, not when a timestamp passes.
    const listed = normaliseCycle({ cycle: 15, status: "listed", option: { expiryTimestamp: "1" } })!;
    expect(listed.settled).toBe(false);
    expect(listed.filled).toBe(false);
    const filled = normaliseCycle({ cycle: 16, status: "filled", fill: { contractsSold: "2" }, option: { expiryTimestamp: "1" } })!;
    expect(filled.settled).toBe(false);
    expect(filled.filled).toBe(true);
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
    expect(r.stranded).toBeUndefined();
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
