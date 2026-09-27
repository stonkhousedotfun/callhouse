import { describe, expect, it } from "vitest";

import * as copy from "./vaultCopy";
import {
  bpsPct,
  EARN_RISKS,
  feeRouteLine,
  houseRisks,
  earnSkimLine,
  HOUSE_BOUNDARY_WAITING,
  HOUSE_CUTOFF_DAILY,
  HOUSE_CUTOFF_WEEKLY,
  HOUSE_IDLE_DAILY,
  HOUSE_IDLE_WEEKLY,
  houseCutoff,
  houseFeeLine,
  houseIdle,
  trailingRate,
  vaultMarkLabel,
} from "./vaultCopy";
import { UNCORROBORATED_DELAY_S } from "./payoutTiming";

describe("vault copy: the cutoff and withdrawal strings, verbatim", () => {
  it("pins the cutoff sentences for both cadences", () => {
    // No "Fri 4:00 pm ET". A holiday week closes on its last trading day and an early close is not 4:00 pm.
    expect(HOUSE_CUTOFF_WEEKLY).toBe(
      "Deposits made before this week's close are priced at it. Withdrawal requests are taken until the close is processed, and priced at that close.",
    );
    expect(HOUSE_CUTOFF_DAILY).toBe(
      "Deposits made before today's close are priced at it. Withdrawal requests are taken until the close is processed, and priced at that close.",
    );
    expect(HOUSE_IDLE_WEEKLY).toBe(
      "A queued deposit waits for the close on the week's last trading day before it earns or loses anything.",
    );
  });

  it("selects by cadence and never lets a daily vault say Friday or week", () => {
    expect(houseCutoff("weekly")).toBe(HOUSE_CUTOFF_WEEKLY);
    expect(houseCutoff("daily")).toBe(HOUSE_CUTOFF_DAILY);
    expect(houseIdle("weekly")).toBe(HOUSE_IDLE_WEEKLY);
    expect(houseIdle("daily")).toBe(HOUSE_IDLE_DAILY);
    for (const s of [houseCutoff("daily"), houseIdle("daily")]) {
      expect(s).not.toMatch(/fri|week|monday/i);
    }
  });

  it("fills the mark label from its argument", () => {
    expect(vaultMarkLabel("Sep 12, 2026")).toBe("as of the last close, Sep 12, 2026 · not a live price");
  });
});

describe("fee lines: rendered from reads, a missing read is never 0", () => {
  it("formats basis points to two decimals and refuses a missing or invalid read", () => {
    expect(bpsPct(0)).toBe("0.00 %");
    expect(bpsPct(2000)).toBe("20.00 %");
    expect(bpsPct(null)).toBeNull();
    expect(bpsPct(-1)).toBeNull();
    expect(bpsPct(1.5)).toBeNull();
  });

  it("builds the House and Earn lines only when both the rate and the ceiling were read", () => {
    // through lib/numberFormat.ts displayRatioPercent, "0% now (up to 20%)".
    expect(houseFeeLine(0, 2000)).toBe(
      "Performance fee 0% now (up to 20%), taken in USDG at each close, only on gains above the vault's previous high.",
    );
    expect(houseFeeLine(1250, 2000)).toBe(
      "Performance fee 12.5% now (up to 20%), taken in USDG at each close, only on gains above the vault's previous high.",
    );
    expect(houseFeeLine(null, 2000)).toBeNull();
    expect(houseFeeLine(0, null)).toBeNull();
    expect(houseFeeLine(-1, 2000)).toBeNull();
    expect(houseFeeLine(0, 1.5)).toBeNull();
    // (ADDITION 3): a staged rate that differs is the rate from the next epoch; an equal or unread one adds nothing.
    expect(houseFeeLine(1000, 2000, 1500)).toBe(
      "Performance fee 10% now (up to 20%), taken in USDG at each close, only on gains above the vault's previous high. It changes to 15% from the next epoch.",
    );
    expect(houseFeeLine(1000, 2000, 0)).toMatch(/ It changes to 0% from the next epoch\.$/);
    expect(houseFeeLine(1000, 2000, 1000)).not.toMatch(/next epoch/);
    expect(houseFeeLine(1000, 2000, null)).not.toMatch(/next epoch/);
    expect(houseFeeLine(1000, 2000, -1)).not.toMatch(/next epoch/);
    expect(earnSkimLine(0, 1000)).toBe(
      "Skim 0% now (up to 10%), taken only on realised gains above the previous high, and only when no call is open and no queue is waiting.",
    );
    expect(earnSkimLine(null, 1000)).toBeNull();
    expect(earnSkimLine(0, -1)).toBeNull();
  });
});

describe("the only rate: trailing, measured, with its formula", () => {
  it("is null until four boundaries exist, and for missing or non-positive prices", () => {
    expect(trailingRate(1.01, 1.0, 3)).toBeNull();
    expect(trailingRate(null, 1.0, 5)).toBeNull();
    expect(trailingRate(1.01, 0, 5)).toBeNull();
  });

  it("prints the formula beside the number", () => {
    const s = trailingRate(1.01, 1.0, 4);
    expect(s).toContain("(price now ÷ price 28 days ago − 1) × 365 ÷ 28");
    expect(s).toContain("13.04 %");
    expect(s).toContain("not a forecast");
  });

  it("no exported string mentions APY or APR", () => {
    for (const v of Object.values(copy)) {
      if (typeof v === "string") expect(v).not.toMatch(/\bAP[RY]\b/i);
    }
  });
});

describe("fee route and risks", () => {
  it("renders the split from burnBps, not a literal 50/50", () => {
    // through lib/numberFormat.ts displayRatioPercent, "50%".
    expect(feeRouteLine(5000)).toBe("Fees are split 50% to buy and burn STONKHOUSE, 50% to the treasury.");
    expect(feeRouteLine(2500)).toBe("Fees are split 25% to buy and burn STONKHOUSE, 75% to the treasury.");
    expect(feeRouteLine(3333)).toBe("Fees are split 33.3% to buy and burn STONKHOUSE, 66.6% to the treasury.");
    expect(feeRouteLine(null)).toBeNull();
    expect(feeRouteLine(10_001)).toBeNull();
  });
  // SettlementOracle's single-source wait is per market and settable (setMarket, 30 min to 24 h). The House
  // copy used to say "up to six hours" / "up to 6 h (one)" as a fixed fact; it now names 6 hours as the default only.
  it("states the single-source wait as the default, adjustable, and ties the number to UNCORROBORATED_DELAY_S", () => {
    expect(UNCORROBORATED_DELAY_S / 3_600).toBe(6);
    expect(HOUSE_BOUNDARY_WAITING).toBe(
      "Market closed. Waiting for the final price (usually a few minutes; longer if only one price source answers, 6 hours by default, adjustable per market), then the close is processed.",
    );
    for (const cadence of ["weekly", "daily"] as const) {
      const row = houseRisks(cadence, "NVDA").find((r) => r.term === "Close delay")!;
      expect(row.words).toContain("longer if only one price source answers (6 hours by default; the wait is set per market and can be changed)");
      expect(row.bound).toBe("Final price: minutes (two sources); one source: 6 h by default, adjustable.");
    }
    const all = [HOUSE_BOUNDARY_WAITING, ...houseRisks("weekly", "NVDA").flatMap((r) => [r.words, r.bound])].join(" ");
    expect(all).not.toMatch(/up to (six hours|6 h)/);
  });

  it("house risks follow the cadence; the daily set never says week or Friday", () => {
    const daily = houseRisks("daily", "NVDA").map((r) => `${r.term} ${r.words}`).join(" ");
    expect(daily).not.toMatch(/week|friday|monday/i);
    expect(houseRisks("weekly", "NVDA").map((r) => r.term)).toContain("Weekly lock");
    expect(houseRisks("weekly", "SPCX")[0]!.words).toContain("SPCX");
    expect(EARN_RISKS.length).toBeGreaterThan(5);
  });

  /** Copy rule. Plain words, no weekday or clock time the chain did not supply, no internal terms. */
  it("no exported string or risk row names a weekday, a clock time or an internal term", () => {
    const rows = [...houseRisks("weekly", "NVDA"), ...houseRisks("daily", "NVDA"), ...EARN_RISKS];
    const texts = [
      ...Object.values(copy).filter((v: unknown): v is string => typeof v === "string"),
      ...rows.flatMap((r) => [r.term, r.words, r.bound]),
      houseFeeLine(1000, 2000)!,
      earnSkimLine(500, 1000)!,
      feeRouteLine(5000)!,
    ];
    for (const t of texts) {
      expect(t).not.toMatch(/friday|monday|4:00|\bpm\b/i);
      expect(t).not.toMatch(/boundary|epoch|\bNAV\b|pro rata|in kind|FeeSplitter|high-water|permissionless|\bseries\b|indicative/i);
    }
  });
});

describe("the House risks carry no fee-change row", () => {
  it("no House risk row talks about the treasury changing the performance fee, in both cadences", () => {
    for (const cadence of ["weekly", "daily"] as const) {
      const rows = houseRisks(cadence, "NVDA");
      expect(rows.find((r) => r.term === "Fee can rise")).toBeUndefined();
      for (const r of rows) expect(`${r.term} ${r.words} ${r.bound}`, r.term).not.toMatch(/change the performance fee|new rate/i);
    }
  });
});

describe("the Earn caps are settable (EarnVault.setLimits), so the copy never calls them fixed", () => {
  it("no Earn risk says the limits are fixed in the contract", () => {
    for (const row of EARN_RISKS) expect(`${row.words} ${row.bound}`, row.term).not.toMatch(/fixed in the contract|Fixed caps/i);
  });

  it("the outflow and size caps say who can change them: the treasury any way, the guardian only down", () => {
    const byTerm = new Map(EARN_RISKS.map((row) => [row.term, row]));
    expect(byTerm.get("Outflow cap")?.bound).toMatch(/the treasury can change it, the guardian can only lower it/);
    expect(byTerm.get("Size caps")?.words).toMatch(/The treasury can change them; the guardian can only lower them/);
    // Earlier the guardian could set any values (EarnVault.setLimits was GUARDIAN); it can no longer raise a cap.
    for (const row of EARN_RISKS) expect(`${row.words} ${row.bound}`, row.term).not.toMatch(/the guardian can change/i);
  });
});
