import { describe, expect, it } from "vitest";
import { cadenceFromKind, HOUSE_DISCLOSURE_UNKNOWN_WITHDRAWALS, houseCadenceBadge, houseExitLine } from "./houseCopy";

import {
  HOUSE_DISCLOSURE_BOT_QUOTES,
  HOUSE_DISCLOSURE_CAN_LOSE,
  HOUSE_DISCLOSURE_PER_EPOCH_FACTS,
  HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS,
  HOUSE_DISCLOSURE_DAILY_WITHDRAWALS,
  HOUSE_DISCLOSURES,
  houseDisclosures,
  houseLede,
  houseWithdrawalDisclosure,
  HOUSE_DISCLOSURE_FRIDAYS_ONLY_WITHDRAWALS,
  houseTradesFridaysOnly,
} from "./houseCopy";

describe("house disclosures", () => {
  it("exports four non-empty strings covering the required facts", () => {
    expect(HOUSE_DISCLOSURES).toHaveLength(4);
    for (const text of HOUSE_DISCLOSURES) {
      expect(text.trim().length).toBeGreaterThan(20);
    }
    expect(HOUSE_DISCLOSURE_CAN_LOSE.toLowerCase()).toContain("lose money");
    expect(HOUSE_DISCLOSURE_BOT_QUOTES.toLowerCase()).toContain("our bot does the trading");
    expect(HOUSE_DISCLOSURE_BOT_QUOTES.toLowerCase()).toContain("on chain");
    expect(HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS.toLowerCase()).toContain("once a week");
    // The week's last trading day, never a weekday (a holiday Friday moves the weekly close).
    expect(HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS.toLowerCase()).toContain("the week's last trading day");
    expect(HOUSE_DISCLOSURE_PER_EPOCH_FACTS.toLowerCase()).toContain("each period");
    expect(HOUSE_DISCLOSURE_PER_EPOCH_FACTS.toLowerCase()).toContain("losing ones included");
  });

  /**
   * THE NO-RATE RULE IS GONE, BY DECISION. The word detector that used
   * to live here -- and the copy-lint script that ran the same table over the repo -- were removed
   * together, because the interest percentage must BE SHOWN. A rule forbidding
   * "a percentage per unit of time" cannot coexist with a requirement to publish one.
   *
   * WHAT SURVIVES, AND WHY IT IS NOT THIS. `houseEpoch.ts` still returns NAV_NOT_AVAILABLE for a
   * running epoch. That is deliberately NOT covered here and is a different
   * class of thing: removing it does not permit a forbidden word, it produces a WRONG NUMBER
   * RENDERED AS A RIGHT ONE. The decision that loosened the wording does not reach it.
   *
   * The four facts below are still asserted. They are product facts, not linter output.
   */
  it("still states the four facts, which no copy rule was ever what made them true", () => {
    expect(HOUSE_DISCLOSURES.join(" ")).toContain("lose money");
    // "paid in kind" is said in plain words now; the fact is the same.
    expect(HOUSE_DISCLOSURES.join(" ")).toContain("USDG and its stock, not cash only");
  });

  it("names no weekday or clock time, and no internal jargon", () => {
    for (const cadence of ["weekly", "daily", null] as const) {
      const text = [...houseDisclosures(cadence), houseLede(cadence)].join(" ");
      expect(text).not.toMatch(/friday|4:00|\bpm\b/i);
      expect(text).not.toMatch(/epoch|boundary|\bNAV\b|pro rata|in kind/i);
    }
  });
});

/** The "once a week" fact is a function of the vault's cadence, so a daily vault never renders it. */
describe("house disclosures by cadence", () => {
  it("weekly is the unchanged set; daily swaps only the withdrawal fact", () => {
    expect(houseDisclosures("weekly")).toEqual([...HOUSE_DISCLOSURES]);
    const daily = houseDisclosures("daily");
    expect(daily).toHaveLength(4);
    expect(daily[2]).toBe(HOUSE_DISCLOSURE_DAILY_WITHDRAWALS);
    expect(daily.join(" ")).not.toMatch(/once a week|friday/i);
    expect(houseWithdrawalDisclosure("daily").toLowerCase()).toContain("once a day");
    expect(houseWithdrawalDisclosure("daily").toLowerCase()).toContain("not cash only");
    expect(houseLede("daily")).not.toMatch(/week/i);
    expect(houseLede("weekly")).toContain("once a week");
  });
});

/*
 * The House cards state the cadence and the exit pricing from the /v2/house `kind` (the vault's factory).
 * Daily is priced at today's close, weekly at the close on the week's last trading day (never "Friday"); an
 * unknown or absent kind is said to be unknown, never weekly.
 */
describe("House cadence and exit copy follow the API kind", () => {
  it("maps weekly and daily through, and unknown or absent to null", () => {
    expect(cadenceFromKind("weekly")).toBe("weekly");
    expect(cadenceFromKind("daily")).toBe("daily");
    expect(cadenceFromKind("unknown")).toBeNull();
    expect(cadenceFromKind(undefined)).toBeNull();
  });

  it("labels the card by kind and never calls an unknown vault weekly", () => {
    expect(houseCadenceBadge("daily")).toBe("Daily");
    expect(houseCadenceBadge("weekly")).toBe("Weekly");
    expect(houseCadenceBadge("unknown")).toBe("Schedule unknown");
    expect(houseCadenceBadge(undefined)).toBe("Schedule unknown");
  });

  it("prices a daily exit at today's close and a weekly one at the week's last trading day", () => {
    expect(houseExitLine("daily")).toContain("priced at today's close");
    expect(houseExitLine("weekly")).toContain("priced at the market close on the week's last trading day");
    expect(houseExitLine("weekly")).not.toMatch(/Friday/);
    for (const k of ["unknown", undefined] as const) {
      expect(houseExitLine(k)).toContain("not known");
      expect(houseExitLine(k)).not.toMatch(/Friday|today's close/);
    }
  });

  it("an unknown kind's disclosures and lede name no cadence and still say paid in kind", () => {
    const unknown = houseDisclosures(cadenceFromKind("unknown"));
    expect(unknown).toHaveLength(4);
    expect(unknown[2]).toBe(HOUSE_DISCLOSURE_UNKNOWN_WITHDRAWALS);
    expect(unknown.join(" ")).not.toMatch(/once a week|once a day|friday|today's close/i);
    expect(unknown.join(" ")).toContain("not cash only");
    expect(houseLede(null)).not.toMatch(/once a week|once a day|week|daily/i);
  });
});

/*
 * (SPCX has no dailies, its House vault is "Daily, Fridays only"). A daily
 * vault on a market that lists no daily expiries says plainly that it trades on Fridays and still pays withdrawals at
 * every close. This variant is the one place a House string names Friday, on purpose; it always carries "the
 * week's last trading day" where it says when the vault trades (a holiday Friday moves the weekly close).
 */
describe("a daily vault on a market with no dailies (SPCX) is Friday-only, and says so", () => {
  it("only a DAILY vault on a market that lists no dailies is Friday-only", () => {
    expect(houseTradesFridaysOnly("daily", false)).toBe(true);
    expect(houseTradesFridaysOnly("daily", true)).toBe(false);
    expect(houseTradesFridaysOnly("weekly", false)).toBe(false);
    expect(houseTradesFridaysOnly(null, false)).toBe(false);
  });

  it("the SPCX vault's copy: Fridays for trading, every close for withdrawals, paid in kind", () => {
    const disclosures = houseDisclosures("daily", false);
    expect(disclosures).toHaveLength(4);
    expect(disclosures[2]).toBe(HOUSE_DISCLOSURE_FRIDAYS_ONLY_WITHDRAWALS);
    expect(houseWithdrawalDisclosure("daily", false)).toBe(HOUSE_DISCLOSURE_FRIDAYS_ONLY_WITHDRAWALS);
    expect(HOUSE_DISCLOSURE_FRIDAYS_ONLY_WITHDRAWALS).toContain("once a day, at the market close");
    expect(HOUSE_DISCLOSURE_FRIDAYS_ONLY_WITHDRAWALS).toContain("Fridays only (the week's last trading day)");
    expect(HOUSE_DISCLOSURE_FRIDAYS_ONLY_WITHDRAWALS).toContain("not cash only");
    // The daily copy's promise is what is false Mon-Thu on SPCX: no option settles at those closes.
    expect(disclosures.join(" ")).not.toContain("after that day's options settle");
    expect(houseLede("daily", false)).toContain("on Fridays");
    expect(houseLede("daily", false)).toContain("once a day, at the market close");
    expect(houseExitLine("daily", false)).toContain("priced at today's close");
    expect(houseExitLine("daily", false)).toContain("Fridays only");
    expect(houseExitLine("daily", false)).not.toContain("after today's options settle");
    expect(houseCadenceBadge("daily", false)).toBe("Daily, Fridays only");
    // No internal jargon here either.
    expect([...disclosures, houseLede("daily", false), houseExitLine("daily", false)].join(" ")).not.toMatch(/epoch|boundary|\bNAV\b|pro rata|in kind/i);
  });

  it("every other vault's copy is unchanged byte for byte, and the new argument defaults to 'lists dailies'", () => {
    for (const cadence of ["weekly", "daily", null] as const) {
      expect(houseDisclosures(cadence, true)).toEqual(houseDisclosures(cadence));
      expect(houseLede(cadence, true)).toBe(houseLede(cadence));
    }
    expect(houseDisclosures("weekly", false)).toEqual([...HOUSE_DISCLOSURES]);
    expect(houseLede("weekly", false)).toBe(houseLede("weekly"));
    for (const kind of ["weekly", "daily", "unknown", undefined] as const) {
      expect(houseExitLine(kind, true)).toBe(houseExitLine(kind));
      expect(houseCadenceBadge(kind, true)).toBe(houseCadenceBadge(kind));
    }
    expect(houseCadenceBadge("unknown", false)).toBe("Schedule unknown");
  });
});

describe("v9 instant deposits and the owed performance fee", () => {
  it("states the vault preview as the instant rule, and quotes no shares when the preview refuses", async () => {
    // houseCopy.test.ts previously pinned "only when the vault is empty, or holds only USDG". The current rule makes that
    // sentence false: a settled position is priced exactly, and a converted ITM call refuses instead of returning
    // a share count. The old regexes are replaced on purpose.
    const { HOUSE_INSTANT_DEPOSIT_RULE } = await import("./houseCopy");
    expect(HOUSE_INSTANT_DEPOSIT_RULE).toMatch(/only when the vault's preview names the exact share count/);
    expect(HOUSE_INSTANT_DEPOSIT_RULE).toMatch(/When that preview refuses/);
    expect(HOUSE_INSTANT_DEPOSIT_RULE).toMatch(/does not quote a share count/);
    expect(HOUSE_INSTANT_DEPOSIT_RULE).toMatch(/Stock Token deposits always wait for the close/);
    expect(HOUSE_INSTANT_DEPOSIT_RULE).not.toMatch(/only when the vault is empty/);
  });

  it("names the path the vault chose, and says nothing before it has answered", async () => {
    const { houseDepositRouteLine, HOUSE_DEPOSIT_NOW_LABEL, HOUSE_DEPOSIT_QUEUE_LABEL } = await import("./houseCopy");
    expect(houseDepositRouteLine(true)).toMatch(/gets shares now/);
    expect(houseDepositRouteLine(true)).not.toMatch(/\d/);
    // A refusal, including the not-exact preview, is not the "now" line and quotes no shares.
    expect(houseDepositRouteLine(false)).toMatch(/waits for the close/);
    expect(houseDepositRouteLine(false)).not.toMatch(/\bnow\b/);
    expect(houseDepositRouteLine(false)).not.toMatch(/\d/);
    expect(houseDepositRouteLine(null)).toBeNull();
    expect(HOUSE_DEPOSIT_QUEUE_LABEL).toBe("Queue USDG deposit"); // the pre-v9 label, kept for the queued path
    expect(HOUSE_DEPOSIT_NOW_LABEL).not.toMatch(/queue/i);
  });

  it("the instant notice quotes the minted shares it was given, and never invents a count", async () => {
    const { houseDepositedNowNotice, HOUSE_DEPOSIT_QUEUED_NOTICE } = await import("./houseCopy");
    expect(houseDepositedNowNotice("12.5")).toBe("Deposited. You got 12.5 shares.");
    expect(houseDepositedNowNotice(null)).not.toMatch(/\d/);
    expect(HOUSE_DEPOSIT_QUEUED_NOTICE).toMatch(/joins at the next close/);
  });

  it("the owed-fee line carries the read amount and says the value shown already takes it out", async () => {
    const { housePerformanceFeeOwedLine } = await import("./houseCopy");
    const line = housePerformanceFeeOwedLine("1,234.5");
    expect(line).toContain("1,234.5 USDG");
    expect(line).toMatch(/The value shown already takes it out/);
  });
});
