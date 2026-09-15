import { describe, expect, it } from "vitest";

import {
  canSettleQueue,
  capacityContracts,
  depositsClosedReason,
  fmtEastern,
  fmtUtc,
  fmtWadPercent,
  listedDepositRisk,
  maxContracts,
  minPremiumUsdg,
  strikeBand,
  unitPriceUsdg,
  type PolicyBps,
} from "./format";

const E18 = 10n ** 18n;
const STRIKE = 150_000_000n; // 150 USDG per lot

/** Policy.launchDefaults() */
const LAUNCH: PolicyBps = {
  minOtmBps: 300,
  maxOtmBps: 1200,
  minPremiumBps: 40,
  maxUtilizationBps: 9500,
  protocolFeeBps: 500,
  maxContractsCap: 50n,
};

describe("policy maths mirror contracts/src/Policy.sol", () => {
  it("maxContracts is the utilisation ceiling in whole lots, capped", () => {
    // 25 NVDA × 95% = 23.75 lots → 23.
    expect(maxContracts(25n * E18, LAUNCH)).toBe(23n);
    // 100 NVDA × 95% = 95 lots, but the cap is 50.
    expect(maxContracts(100n * E18, LAUNCH)).toBe(50n);
    expect(maxContracts(undefined, LAUNCH)).toBeUndefined();
    expect(maxContracts(25n * E18, undefined)).toBeUndefined();
  });

  it("capacity is what the vault can still write: max less written, floored at zero", () => {
    expect(capacityContracts(25n * E18, 0n, LAUNCH)).toBe(23n);
    expect(capacityContracts(25n * E18, 5n, LAUNCH)).toBe(18n);
    // NAV fell after the writes (an issuer burn): the cap is below what was written.
    expect(capacityContracts(5n * E18, 23n, LAUNCH)).toBe(0n);
    expect(capacityContracts(25n * E18, undefined, LAUNCH)).toBeUndefined();
  });

  it("strikeBand is [spot × 1.03, spot × 1.12] at launch", () => {
    expect(strikeBand(100_000_000n, LAUNCH)).toEqual({ min: 103_000_000n, max: 112_000_000n });
    expect(strikeBand(0n, LAUNCH)).toBeUndefined();
    expect(strikeBand(undefined, LAUNCH)).toBeUndefined();
  });

  it("minPremiumUsdg is spot × contracts × 0.40% at launch", () => {
    // 200 USDG spot, 5 contracts: 1000 × 0.004 = 4 USDG.
    expect(minPremiumUsdg(200_000_000n, 5n, LAUNCH)).toBe(4_000_000n);
    expect(minPremiumUsdg(undefined, 5n, LAUNCH)).toBeUndefined();
  });

  it("unitPriceUsdg is exact because the vault enforces gross % amount == 0", () => {
    expect(unitPriceUsdg(80_000_000n, 20n)).toBe(4_000_000n);
    expect(unitPriceUsdg(80_000_000n, 0n)).toBeUndefined();
    expect(unitPriceUsdg(undefined, 20n)).toBeUndefined();
  });

  it("fmtWadPercent renders a WAD share as a percentage", () => {
    expect(fmtWadPercent(E18)).toBe("100.00%");
    expect(fmtWadPercent(E18 / 4n)).toBe("25.00%");
    expect(fmtWadPercent(0n)).toBe("0.00%");
    expect(fmtWadPercent(undefined)).toBe("—");
  });
});

describe("listedDepositRisk", () => {
  it("is none outside Listed, and for an unread phase", () => {
    expect(listedDepositRisk({ phase: 0, cycleStrikeUsdg: STRIKE, spotUsdg: STRIKE, minOtmBps: 300 })).toBe("none");
    expect(listedDepositRisk({ phase: 2, cycleStrikeUsdg: STRIKE, spotUsdg: STRIKE, minOtmBps: 300 })).toBe("none");
    expect(listedDepositRisk({})).toBe("none");
  });

  it("is listed below strike × (1 − minOtm), near at or above it", () => {
    // threshold = 150 × 0.97 = 145.5 USDG
    expect(listedDepositRisk({ phase: 1, cycleStrikeUsdg: STRIKE, spotUsdg: 145_499_999n, minOtmBps: 300 })).toBe(
      "listed",
    );
    expect(listedDepositRisk({ phase: 1, cycleStrikeUsdg: STRIKE, spotUsdg: 145_500_000n, minOtmBps: 300 })).toBe(
      "near",
    );
    expect(listedDepositRisk({ phase: 1, cycleStrikeUsdg: STRIKE, spotUsdg: 160_000_000n, minOtmBps: 300 })).toBe(
      "near",
    );
  });

  it("falls back to listed when spot is stale or policy unread, never to none", () => {
    expect(listedDepositRisk({ phase: 1, cycleStrikeUsdg: STRIKE, minOtmBps: 300 })).toBe("listed");
    expect(listedDepositRisk({ phase: 1, cycleStrikeUsdg: STRIKE, spotUsdg: STRIKE })).toBe("listed");
  });
});

describe("depositsClosedReason mirrors Vault._depositRefused", () => {
  const NOW = 1_789_000_000;
  const open = { phase: 1, cycleExerciseTs: NOW + 3600, claimKey: 0n, contractsAssigned: 0n, assetHeld: 10n * E18, reservedAssets: 0n };

  it("is undefined while deposits are open, and before the vault has been read", () => {
    expect(depositsClosedReason(open, NOW)).toBeUndefined();
    expect(depositsClosedReason({ ...open, phase: 0 }, NOW)).toBeUndefined();
    expect(depositsClosedReason({}, NOW)).toBeUndefined();
  });

  it("names the phase outside Idle and Listed", () => {
    expect(depositsClosedReason({ ...open, phase: 2 }, NOW)).toBe("phase");
    expect(depositsClosedReason({ ...open, phase: 3 }, NOW)).toBe("phase");
  });

  it("closes at the exercise time in Listed whether or not lockBook ran (W-2), never before the clock starts", () => {
    expect(depositsClosedReason({ ...open, cycleExerciseTs: NOW }, NOW)).toBe("window");
    expect(depositsClosedReason({ ...open, cycleExerciseTs: NOW + 1 }, NOW)).toBeUndefined();
    expect(depositsClosedReason({ ...open, cycleExerciseTs: NOW - 1 }, 0)).toBeUndefined();
  });

  it("names a stranded claim, an unredeemed assignment, and an unbacked reserve", () => {
    expect(depositsClosedReason({ ...open, phase: 0, claimKey: 7n }, NOW)).toBe("stranded");
    expect(depositsClosedReason({ ...open, claimKey: 7n, contractsAssigned: 2n }, NOW)).toBe("assignmentPending");
    // Listed with a claim and nothing assigned: deposits are open (D8).
    expect(depositsClosedReason({ ...open, claimKey: 7n }, NOW)).toBeUndefined();
    expect(depositsClosedReason({ ...open, assetHeld: 1n * E18, reservedAssets: 2n * E18 }, NOW)).toBe("reserveUnbacked");
  });
});

describe("canSettleQueue", () => {
  const base = { phase: 0, epochId: 4n, queuedShares: 1n, queuedEpoch: 4n };

  it("is true for a current-epoch entry while Idle", () => {
    expect(canSettleQueue(base)).toBe(true);
  });

  it("is false outside Idle, for an already-settled epoch, with nothing queued, or unread", () => {
    expect(canSettleQueue({ ...base, phase: 1 })).toBe(false);
    expect(canSettleQueue({ ...base, queuedEpoch: 3n })).toBe(false);
    expect(canSettleQueue({ ...base, queuedShares: 0n })).toBe(false);
    expect(canSettleQueue({ ...base, epochId: undefined })).toBe(false);
  });
});

describe("fmtEastern renders the chain's timestamp on the NYSE clock, beside the UTC figure", () => {
  it("a September Friday close is 4:00pm EDT = 8:00pm UTC (cycle-assigned.json's exercise time)", () => {
    expect(fmtUtc(1789761600)).toBe("Fri 18 Sep, 8:00pm UTC");
    expect(fmtEastern(1789761600)).toBe("Fri 18 Sep, 4:00pm EDT");
  });

  it("a December Friday close is 4:00pm EST = 9:00pm UTC: the UTC hour moves, the Eastern one does not", () => {
    // 2026-12-18T21:00:00Z, the first NYSE Friday close after daylight time ends on 2026-11-01.
    expect(fmtUtc(1797627600)).toBe("Fri 18 Dec, 9:00pm UTC");
    expect(fmtEastern(1797627600)).toBe("Fri 18 Dec, 4:00pm EST");
  });

  it("expiry a day later, and a midnight-UTC instant on the previous Eastern day", () => {
    expect(fmtEastern(1789848000)).toBe("Sat 19 Sep, 4:00pm EDT");
    // 2026-09-10T00:26:40Z is still the evening of the 9th in New York.
    expect(fmtUtc(1789000000)).toBe("Thu 10 Sep, 12:26am UTC");
    expect(fmtEastern(1789000000)).toBe("Wed 9 Sep, 8:26pm EDT");
  });

  it("is a dash for nothing, zero and a bigint that is not a time", () => {
    expect(fmtEastern(undefined)).toBe("—");
    expect(fmtEastern(null)).toBe("—");
    expect(fmtEastern(0)).toBe("—");
    expect(fmtEastern(1789761600n)).toBe("Fri 18 Sep, 4:00pm EDT");
  });
});
