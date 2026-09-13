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
    expect(r.grossUsdg).toBe(45_600000n); // the vault's take: 48 gross less Overcall's 5%
    expect(r.feeUsdg).toBe(2_280000n); // the protocol's 5% of the premium
    expect(r.netUsdg).toBe(43_320000n); // what depositors received
    expect(r.strikeUsdg).toBe(190_000000n);

    // Shares are 18 decimals: 100 whole shares.
    expect(r.sharesAtHarvest).toBe(100n * WAD);
    // 43.32 USDG over 100 shares: 0.433200 USDG per share, in USDG base units.
    expect(r.usdgPerShare).toBe(433200n);

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
    expect(r.grossUsdg).toBe(0n);
    expect(r.feeUsdg).toBe(0n);
    expect(r.netUsdg).toBe(0n);
    expect(r.usdgPerShare).toBe(0n);
    expect(r.sharesAtHarvest).toBe(100n * WAD);
    expect(r.wrote).toBe(true);
    expect(r.filledAt).toBeUndefined();
    expect(r.closedAt).toBe(secs("2026-09-11T21:00:30Z"));
  });

  it("cycle-assigned.json: sold 12, 5 assigned, strike proceeds in the harvest, and NOT open", () => {
    const r = normaliseCycle(fixture("cycle-assigned.json"))!;

    // The audit's other failure mode: an assigned week rendering as "open".
    expect(r.settled).not.toBe(false);
    expect(r.settled).toBe(true);
    expect(r.filled).toBe(true);
    expect(r.status).toBe("assigned");

    expect(r.contractsSold).toBe(12n);
    expect(r.contractsAssigned).toBe(5n);
    // 45.6 premium to the vault + 5 × 190 at the strike = 995.6 gross. The protocol fee is 5%
    // of the 45.6 premium only (2.28); the 950 of strike proceeds are never fee'd. 993.32 net.
    expect(r.grossUsdg).toBe(995_600000n);
    expect(r.feeUsdg).toBe(2_280000n);
    expect(r.netUsdg).toBe(993_320000n);
    expect(r.sharesAtHarvest).toBe(100n * WAD);
    expect(r.closedAt).toBe(secs("2026-09-18T21:00:30Z"));
    expect(r.txClose).toBe("0x0000000000000000000000000000000000000000000000000000000000000094");
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
    expect(r.grossUsdg).toBe(7_000000n);
    expect(r.filled).toBe(false);
    expect(r.settled).toBe(true);
  });

  it("reads a money object's raw and never its formatted", () => {
    const r = normaliseCycle({
      cycle: 5,
      harvest: { grossUsdg: { raw: "48000000", decimals: 6, formatted: "not a number" } },
    })!;
    expect(r.grossUsdg).toBe(48_000000n);
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
      expect(r.grossUsdg).toBe(0n);
      expect(r.feeUsdg).toBe(0n);
      expect(r.netUsdg).toBe(0n);
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
    expect(r.grossUsdg).toBe(48_000000n);
    expect(r.feeUsdg).toBe(2_400000n);
    expect(r.netUsdg).toBe(45_600000n);
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
