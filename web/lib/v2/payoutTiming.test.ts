import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buyCallTiming,
  closePairTiming,
  earnVaultDepositTiming,
  earnVaultRedeemTiming,
  FINALIZE_DELAY_S,
  formatLocal,
  houseDepositCancelTiming,
  houseDepositTiming,
  houseWithdrawTiming,
  KEEPER_POLL_S,
  ledgerWithdrawTiming,
  restingOrderTiming,
  selfRedeemTiming,
  sellCallTiming,
  settlementWindow,
  UNCORROBORATED_DELAY_S,
  zapTiming,
  type PayoutTiming,
} from "./payoutTiming";
import { HOUSE_ROLL_OVERDUE_S } from "./houseEpoch";
import { stamp } from "./time";
import { ZAP_DEADLINE_SECONDS } from "./zapTx";

// Fri Sep 25 2026 20:00:00 UTC = 4:00 PM EDT. This is the live House vaults' `epochEnd()` read on chain 4663 on
// 2026-09-23 (1790366400), so the weekly fixture is a real weekly boundary, not an invented one.
const WEEKLY_END = 1_790_366_400;
// Wed Sep 23 2026 20:00:00 UTC = 4:00 PM EDT: a session close, the shape of a daily boundary.
const DAILY_END = 1_790_193_600;
const HOUR = 3_600;

const REPO = join(import.meta.dirname, "..", "..", "..");

function everyPathStatesTheUnhappyCase(t: PayoutTiming) {
  expect(t.unhappy.length, `${t.path} has no unhappy-path sentence`).toBeGreaterThan(0);
}

describe("settlementWindow", () => {
  it("is expiry + FINALIZE_DELAY, one keeper poll of slack, and the single-source wait on top", () => {
    const w = settlementWindow(WEEKLY_END);
    expect(w.earliestAt).toBe(WEEKLY_END + 120);
    expect(w.usualBy).toBe(WEEKLY_END + 120 + 60);
    expect(w.singleSourceBy).toBe(WEEKLY_END + 120 + 21_600 + 60);
  });

  it("refuses milliseconds and nonsense rather than mis-rendering them", () => {
    expect(() => settlementWindow(Number.NaN)).toThrow(RangeError);
    expect(() => settlementWindow(-1)).toThrow(RangeError);
  });

  // The single-source wait is per market and settable (SettlementOracle.setMarket, 30 min to 24 h).
  it("uses the market's live single-source wait when given, and only the corroborated times stay put", () => {
    const live = settlementWindow(WEEKLY_END, 5_400);
    expect(live.singleSourceBy).toBe(WEEKLY_END + 120 + 5_400 + 60);
    expect(live.earliestAt).toBe(settlementWindow(WEEKLY_END).earliestAt);
    expect(live.usualBy).toBe(settlementWindow(WEEKLY_END).usualBy);
  });

  it("falls back to the 21600 s default when the live wait is absent or unusable", () => {
    for (const bad of [undefined, 0, -1, Number.NaN, 1.5]) {
      expect(settlementWindow(WEEKLY_END, bad).singleSourceBy).toBe(WEEKLY_END + 120 + 21_600 + 60);
    }
  });
});

describe("buy-call", () => {
  it("premium now, payout after expiry settlement, automatic with a self-redeem fallback", () => {
    const t = buyCallTiming({ expiry: WEEKLY_END, now: WEEKLY_END - 2 * HOUR });
    expect(t.arrival).toBe("automatic");
    expect(t.earliestAt).toBe(WEEKLY_END + FINALIZE_DELAY_S);
    expect(t.usualBy).toBe(WEEKLY_END + FINALIZE_DELAY_S + KEEPER_POLL_S);
    expect(t.late).toBe(false);
    expect(t.headline).toMatch(/pay the premium now/);
    expect(t.selfServe).toMatch(/redeem it yourself/);
    expect(t.whenEt).toBe("Sep 25, 2026, 4:03 PM EDT");
    everyPathStatesTheUnhappyCase(t);
  });

  it("says plainly that an out-of-the-money call pays nothing", () => {
    const t = buyCallTiming({ expiry: WEEKLY_END, now: WEEKLY_END + HOUR });
    expect(t.unhappy).toMatch(/at or below its strike pays nothing/);
  });

  // This pinned "about 6 hours longer" as a fixed fact. The wait is settable per market, so without the
  // market's live value the sentence now says the 6 hours is the default; with it, it names that market's wait.
  it("without the market's live wait, names the registry default AS the default", () => {
    const t = buyCallTiming({ expiry: WEEKLY_END, now: WEEKLY_END });
    expect(t.unhappy).toContain(`payment waits about ${UNCORROBORATED_DELAY_S / HOUR} hours longer by default (each market sets its own);`);
  });

  it("with the market's live wait, names that wait and drops 'by default'", () => {
    const t = buyCallTiming({ expiry: WEEKLY_END, now: WEEKLY_END, uncorroboratedDelayS: 5_400 });
    expect(t.unhappy).toContain("payment waits about 90 minutes longer;");
    expect(t.unhappy).not.toContain("by default");
    expect(t.unhappy).not.toContain("6 hours");
    expect(buyCallTiming({ expiry: WEEKLY_END, now: WEEKLY_END, uncorroboratedDelayS: 86_400 }).unhappy)
      .toContain("payment waits about 24 hours longer;");
    // The corroborated headline times do not depend on the single-source wait.
    expect(t.usualBy).toBe(buyCallTiming({ expiry: WEEKLY_END, now: WEEKLY_END }).usualBy);
  });

  it("keeper-late: past usualBy and still due is flagged late, before it is not", () => {
    const w = settlementWindow(WEEKLY_END);
    expect(buyCallTiming({ expiry: WEEKLY_END, now: w.usualBy }).late).toBe(false);
    expect(buyCallTiming({ expiry: WEEKLY_END, now: w.usualBy + 1 }).late).toBe(true);
  });
});

describe("sell-call", () => {
  it("selling an existing call: premium in the same transaction, nothing to wait for", () => {
    const now = WEEKLY_END - HOUR;
    const t = sellCallTiming({ expiry: WEEKLY_END, now, writes: false });
    expect(t.arrival).toBe("immediate");
    expect(t.earliestAt).toBe(now);
    expect(t.usualBy).toBeNull();
    expect(t.steps).toEqual([]);
    expect(t.unhappy).toMatch(/held for you on the order book/);
  });

  it("writing to sell: premium now, collateral back only after settlement", () => {
    const t = sellCallTiming({ expiry: WEEKLY_END, now: WEEKLY_END - HOUR, writes: true });
    expect(t.arrival).toBe("automatic");
    expect(t.earliestAt).toBe(WEEKLY_END + FINALIZE_DELAY_S);
    expect(t.headline).toMatch(/collateral is locked until the option settles/);
    expect(t.unhappy).toMatch(/in the money, some or all of your Stock Token collateral goes to the buyer/);
  });

  it("the written collateral's single-source wait is the market's live value, else the stated default", () => {
    const base = { expiry: WEEKLY_END, now: WEEKLY_END - HOUR, writes: true };
    expect(sellCallTiming(base).unhappy).toContain("the collateral waits about 6 hours longer by default (each market sets its own).");
    expect(sellCallTiming({ ...base, uncorroboratedDelayS: 1_800 }).unhappy).toContain("the collateral waits about 30 minutes longer.");
  });
});

describe("resting-order", () => {
  it("an ask has no clock: it pays only if filled before validUntil", () => {
    const t = restingOrderTiming({ kind: "ask", validUntil: WEEKLY_END - 1_800, now: WEEKLY_END - 6 * HOUR });
    expect(t.earliestAt).toBeNull();
    expect(t.usualBy).toBeNull();
    expect(t.late).toBe(false);
    expect(t.headline).toContain("Sep 25, 2026, 3:30 PM EDT");
    expect(t.unhappy).toMatch(/nobody fills pays nothing/);
  });

  it("a bid's USDG is escrowed and refundable", () => {
    const t = restingOrderTiming({ kind: "bid", validUntil: WEEKLY_END - 1_800, now: WEEKLY_END - 6 * HOUR });
    expect(t.selfServe).toMatch(/cancel an unfilled bid/);
    expect(t.unhappy).toMatch(/refunded when it is cancelled, or cleaned up after it expires/);
  });
});

describe("self-redeem, close-pair, ledger-withdraw, zap", () => {
  it("self-redeem pays immediately once settled, and waits for settlement before", () => {
    expect(selfRedeemTiming({ settled: true, expiry: WEEKLY_END, now: WEEKLY_END + HOUR }).arrival).toBe("immediate");
    const pending = selfRedeemTiming({ settled: false, expiry: WEEKLY_END, now: WEEKLY_END + 30 });
    expect(pending.earliestAt).toBe(WEEKLY_END + FINALIZE_DELAY_S);
    expect(pending.steps).toHaveLength(3);
  });

  it("close-pair frees collateral to the Clearinghouse balance now", () => {
    const t = closePairTiming(WEEKLY_END - HOUR);
    expect(t.arrival).toBe("immediate");
    expect(t.headline).toMatch(/Clearinghouse balance/);
  });

  it("ledger-withdraw is a plain transfer", () => {
    expect(ledgerWithdrawTiming(WEEKLY_END).arrival).toBe("immediate");
  });

  it("zap is atomic and names the deadline from zapTx, not a literal", () => {
    const t = zapTiming(WEEKLY_END);
    expect(t.arrival).toBe("immediate");
    expect(t.headline).toContain(`within ${ZAP_DEADLINE_SECONDS / 60} minutes`);
    expect(t.unhappy).toMatch(/reverts and nothing is swapped/);
  });
});

describe("house vault", () => {
  it("weekly deposit: priced at this week's close, shares need a claim after the close is processed", () => {
    const t = houseDepositTiming({ cadence: "weekly", epochEnd: WEEKLY_END, now: WEEKLY_END - 2 * 86_400 });
    expect(t.arrival).toBe("claim");
    expect(t.earliestAt).toBe(WEEKLY_END);
    expect(t.usualBy).toBe(WEEKLY_END + FINALIZE_DELAY_S + KEEPER_POLL_S);
    // The stamp is the vault's epochEnd; the words never name a weekday (holiday weeks close earlier).
    expect(t.headline).toContain("this week's close (Sep 25, 2026, 4:00 PM EDT)");
    expect(t.headline).toMatch(/^If your deposit queues/); // a v9 USDG deposit into an empty or flat vault gets shares at once
    expect(t.steps.at(-1)).toBe("you claim your shares");
    expect(t.late).toBe(false);
  });

  it("daily deposit: priced at today's close, never a weekly promise", () => {
    const t = houseDepositTiming({ cadence: "daily", epochEnd: DAILY_END, now: DAILY_END - 3 * HOUR });
    expect(t.headline).toContain("today's close (Sep 23, 2026, 4:00 PM EDT)");
    expect(t.headline).not.toMatch(/week/);
  });

  it("after the close a new deposit is refused until the close is processed, and a late one is flagged", () => {
    const after = houseDepositTiming({ cadence: "weekly", epochEnd: WEEKLY_END, now: WEEKLY_END + 30 });
    expect(after.headline).toBe("Deposits reopen after the Sep 25, 2026, 4:00 PM EDT close is processed; until then a new request is refused.");
    expect(after.late).toBe(false);
    const late = houseDepositTiming({ cadence: "weekly", epochEnd: WEEKLY_END, now: WEEKLY_END + HOUR });
    expect(late.late).toBe(true);
    expect(late.selfServe).toBe("Anyone can process the close once the price is final.");
    expect(late.unhappy).toContain(`after ${HOUSE_ROLL_OVERDUE_S / HOUR} hours it is flagged overdue`);
  });

  it("withdrawal is paid in kind, on claim", () => {
    const t = houseWithdrawTiming({ cadence: "daily", epochEnd: DAILY_END, now: DAILY_END - HOUR });
    expect(t.arrival).toBe("claim");
    expect(t.headline).toMatch(/paid in USDG and Stock Tokens/);
    expect(t.headline).toContain("today's close");
    expect(t.unhappy).toMatch(/not a fixed USDG amount/);
  });

  it("deposit cancel works only before the close", () => {
    expect(houseDepositCancelTiming({ cadence: "weekly", epochEnd: WEEKLY_END, now: WEEKLY_END - 1 }).earliestAt)
      .toBe(WEEKLY_END - 1);
    const closed = houseDepositCancelTiming({ cadence: "weekly", epochEnd: WEEKLY_END, now: WEEKLY_END });
    expect(closed.earliestAt).toBeNull();
    expect(closed.headline).toMatch(/can no longer be cancelled/);
  });

  it("with the chain's window read, deposit cancels and queued deposits stop at epochEnd - SETTLEMENT_WINDOW", () => {
    const W = 1_800; // a fixture for the SETTLEMENT_WINDOW() read
    const cut = WEEKLY_END - W;
    const before = houseDepositCancelTiming({ cadence: "weekly", epochEnd: WEEKLY_END, now: cut - 1, settlementWindow: W });
    expect(before.earliestAt).toBe(cut - 1);
    expect(before.headline).toContain(`until ${stamp(cut)}`);
    const at = houseDepositCancelTiming({ cadence: "weekly", epochEnd: WEEKLY_END, now: cut, settlementWindow: W });
    expect(at.earliestAt).toBeNull();
    expect(at.headline).toBe("Cancels stop 30 minutes before the close, so this deposit can no longer be cancelled; it is priced at that close.");
    expect(at.unhappy).toBe("From 30 minutes before the close, a queued deposit stays in and is priced at that close.");
    expect(houseDepositTiming({ cadence: "weekly", epochEnd: WEEKLY_END, now: cut - 1, settlementWindow: W }).headline).toMatch(/^If your deposit queues/);
    const queue = houseDepositTiming({ cadence: "weekly", epochEnd: WEEKLY_END, now: cut, settlementWindow: W });
    expect(queue.headline).toMatch(/^Deposits reopen after/);
    expect(queue.unhappy).toMatch(/You can cancel until 30 minutes before the close, not after\.$/);
  });

  it("a withdrawal request stops at epochEnd - SETTLEMENT_WINDOW too, not at the close", () => {
    const W = 1_800; // a fixture for the SETTLEMENT_WINDOW() read
    const cut = WEEKLY_END - W;
    const before = houseWithdrawTiming({ cadence: "weekly", epochEnd: WEEKLY_END, now: cut - 1, settlementWindow: W });
    expect(before.headline).toMatch(/^Your withdrawal is priced at this week's close/);
    expect(before.unhappy).toMatch(/You can cancel until 30 minutes before the close, not after\.$/);
    const at = houseWithdrawTiming({ cadence: "weekly", epochEnd: WEEKLY_END, now: cut, settlementWindow: W });
    expect(at.headline).toBe(`Withdrawal requests reopen after the ${stamp(WEEKLY_END)} close is processed; until then a new request is refused.`);
    expect(at.earliestAt).toBe(WEEKLY_END);
    // Unread window: only the close is known, as for the deposit.
    expect(houseWithdrawTiming({ cadence: "weekly", epochEnd: WEEKLY_END, now: cut }).headline).toMatch(/^Your withdrawal is priced/);
    expect(houseWithdrawTiming({ cadence: "weekly", epochEnd: WEEKLY_END, now: WEEKLY_END }).headline).toMatch(/^Withdrawal requests reopen after/);
  });
});

describe("earn vault (Lend page)", () => {
  const OPEN_EXPIRY = WEEKLY_END;

  it("deposit with nothing written and an empty queue mints shares now", () => {
    const t = earnVaultDepositTiming({ now: WEEKLY_END - HOUR, positionOpen: false, queueOpen: false, openExpiry: null });
    expect(t.arrival).toBe("immediate");
  });

  it("deposit while a call is open is queued until that option settles and the queue runs", () => {
    const t = earnVaultDepositTiming({ now: WEEKLY_END - HOUR, positionOpen: true, queueOpen: false, openExpiry: OPEN_EXPIRY });
    expect(t.arrival).toBe("automatic");
    expect(t.earliestAt).toBe(OPEN_EXPIRY + FINALIZE_DELAY_S);
    expect(t.usualBy).toBe(settlementWindow(OPEN_EXPIRY).usualBy + KEEPER_POLL_S);
    expect(t.headline).toMatch(/queued while the vault has an open call/);
  });

  it("queued redeem: priced when paid, cancellable, paid automatically", () => {
    const t = earnVaultRedeemTiming({ now: WEEKLY_END - HOUR, positionOpen: true, queueOpen: true, openExpiry: OPEN_EXPIRY });
    expect(t.arrival).toBe("automatic");
    expect(t.steps[0]).toMatch(/open call expires and settles/);
    expect(t.unhappy).toMatch(/priced when paid, not when you asked/);
    expect(t.selfServe).toMatch(/Anyone can process the queue/);
    expect(earnVaultRedeemTiming({ now: t.usualBy! + 1, positionOpen: true, queueOpen: true, openExpiry: OPEN_EXPIRY }).late)
      .toBe(true);
  });

  it("queued behind earlier requests with nothing written: served on the next queue run", () => {
    const now = WEEKLY_END - HOUR;
    const t = earnVaultRedeemTiming({ now, positionOpen: false, queueOpen: true, openExpiry: null });
    expect(t.usualBy).toBe(now + KEEPER_POLL_S);
    expect(t.headline).toMatch(/behind earlier requests/);
  });

  it("an unknown open expiry gives no estimate rather than an invented one", () => {
    const t = earnVaultRedeemTiming({ now: WEEKLY_END, positionOpen: true, queueOpen: false, openExpiry: null });
    expect(t.usualBy).toBeNull();
    expect(t.late).toBe(false);
  });

  it("an unblocked redeem is immediate, with the venue-short case stated", () => {
    const t = earnVaultRedeemTiming({ now: WEEKLY_END, positionOpen: false, queueOpen: false, openExpiry: null });
    expect(t.arrival).toBe("immediate");
    // This pinned "the rest of your redemption is queued", which EarnVault.redeem never does -- a redemption
    // it cannot cover queues in full (`have < owed` -> `_enqueue(shares, ...)`), with nothing burned and nothing paid.
    // The visible word is "withdrawal"; the fact pinned (all or nothing) is unchanged.
    expect(t.unhappy).toMatch(/nothing is paid yet: the whole withdrawal is queued/);
    expect(t.unhappy).not.toMatch(/rest of your (redemption|withdrawal)/);
  });
});

/** Copy rule. Every path's visible text is plain: no internal terms, and no weekday the chain did not supply. */
describe("plain words on every path", () => {
  it("no headline, step, self-serve or unhappy line uses an internal term or names a weekday", () => {
    const all: PayoutTiming[] = [
      buyCallTiming({ expiry: WEEKLY_END, now: WEEKLY_END - HOUR }),
      sellCallTiming({ expiry: WEEKLY_END, now: WEEKLY_END - HOUR, writes: true }),
      sellCallTiming({ expiry: WEEKLY_END, now: WEEKLY_END - HOUR, writes: false }),
      restingOrderTiming({ kind: "ask", validUntil: WEEKLY_END - 1_800, now: WEEKLY_END - 6 * HOUR }),
      restingOrderTiming({ kind: "bid", validUntil: WEEKLY_END - 1_800, now: WEEKLY_END - 6 * HOUR }),
      selfRedeemTiming({ settled: true, expiry: WEEKLY_END, now: WEEKLY_END + HOUR }),
      selfRedeemTiming({ settled: false, expiry: WEEKLY_END, now: WEEKLY_END + 30 }),
      closePairTiming(WEEKLY_END - HOUR),
      ledgerWithdrawTiming(WEEKLY_END),
      zapTiming(WEEKLY_END),
      ...(["weekly", "daily"] as const).flatMap((cadence) => {
        const end = cadence === "weekly" ? WEEKLY_END : DAILY_END;
        return [end - HOUR, end + 30, end + HOUR].flatMap((now) => [
          houseDepositTiming({ cadence, epochEnd: end, now }),
          houseWithdrawTiming({ cadence, epochEnd: end, now }),
          houseDepositCancelTiming({ cadence, epochEnd: end, now }),
        ]);
      }),
      ...[true, false].flatMap((positionOpen) => [true, false].flatMap((queueOpen) => [
        earnVaultDepositTiming({ now: WEEKLY_END - HOUR, positionOpen, queueOpen, openExpiry: positionOpen ? WEEKLY_END : null }),
        earnVaultRedeemTiming({ now: WEEKLY_END - HOUR, positionOpen, queueOpen, openExpiry: positionOpen ? WEEKLY_END : null }),
      ])),
    ];
    for (const t of all) {
      // Stamps come from the chain and legitimately carry a date and a time; only the words around them are checked.
      const words = [t.headline, t.selfServe, t.unhappy, ...t.steps].join(" ").replace(/[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M [A-Z]+/g, "");
      expect(words, t.path).not.toMatch(/boundary|epoch|rollEpoch|processQueue|permissionless|\bseries\b|pruned|veto|friday|monday|4:00/i);
    }
  });
});

describe("formatLocal (fixed time zones)", () => {
  it("New York matches time.ts's stamp format and names its zone", () => {
    expect(formatLocal(WEEKLY_END, "America/New_York")).toBe("Sep 25, 2026, 4:00 PM EDT");
  });

  it("London renders the same instant in London time, zone named", () => {
    expect(formatLocal(WEEKLY_END, "Europe/London")).toMatch(/^Sep 25, 2026, 9:00 PM (GMT\+1|BST)$/);
  });

  it("Tokyo crosses the date line correctly", () => {
    expect(formatLocal(WEEKLY_END, "Asia/Tokyo")).toMatch(/^Sep 26, 2026, 5:00 AM (GMT\+9|JST)$/);
  });

  it("refuses a non-finite timestamp", () => {
    expect(() => formatLocal(Number.NaN, "UTC")).toThrow(RangeError);
  });
});

describe("mirrored constants stay mirrored", () => {
  it("KEEPER_POLL_S is the cranker's POLL_INTERVAL_MS default", () => {
    const config = readFileSync(join(REPO, "keeper", "src", "v2", "config.ts"), "utf8");
    const m = config.match(/POLL_INTERVAL_MS: intField\([^)]*\)\.default\(([0-9_]+)\)/);
    expect(m, "keeper/src/v2/config.ts no longer defaults POLL_INTERVAL_MS").not.toBeNull();
    expect(KEEPER_POLL_S * 1_000).toBe(Number(m![1]!.replace(/_/g, "")));
  });

  it("UNCORROBORATED_DELAY_S is the launch registry's v2.defaults.uncorroboratedDelayS", () => {
    const registry = JSON.parse(readFileSync(join(REPO, "ops", "markets", "tier1.json"), "utf8"));
    expect(UNCORROBORATED_DELAY_S).toBe(registry.v2.defaults.uncorroboratedDelayS);
  });
});

// Sentence times follow the input's `timeZone`; omitted, the New York stamp as before.
describe("payout sentences with the reader's zone", () => {
  it("a buyer in Los Angeles reads their time with ET beside it; whenEt stays New York", () => {
    const t = buyCallTiming({ expiry: WEEKLY_END, now: WEEKLY_END - 2 * HOUR, timeZone: "America/Los_Angeles" });
    expect(t.headline).toContain("after expiry (Sep 25, 1:03 PM PDT (4:03 PM ET)).");
    expect(t.whenEt).toBe("Sep 25, 2026, 4:03 PM EDT");
    expect(buyCallTiming({ expiry: WEEKLY_END, now: WEEKLY_END - 2 * HOUR }).headline).toContain("after expiry (Sep 25, 2026, 4:03 PM EDT).");
  });

  it("house and earn sentences take it too", () => {
    const house = houseDepositTiming({ cadence: "weekly", epochEnd: WEEKLY_END, now: WEEKLY_END - 2 * HOUR, timeZone: "America/Los_Angeles" });
    expect(house.headline).toContain("(Sep 25, 1:00 PM PDT (4:00 PM ET))");
  });
});
