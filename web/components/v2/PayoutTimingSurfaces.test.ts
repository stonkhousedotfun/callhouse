import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every surface where the user commits money shows "When you get paid" (components/ui/PayoutTiming.tsx,
 * fed by lib/v2/payoutTiming.ts) ABOVE the button that signs. The surfaces are wallet-bound client components, so
 * the placement is read from source, the way TradeTicket.test.ts and SeriesPage.test.ts read their mount structure:
 * for each sign button (found by the handler it calls), a `<PayoutTiming>` built from the RIGHT module function must
 * sit before that button's `<Button` tag, in the same block. Remove one and its family's test fails.
 *
 * THE SURFACE LIST is the callers of web/lib/v2/*Tx.ts (TradeTicket, EarnMarket, HouseVault, LendVault, Portfolio;
 * `grep -l "@/lib/v2/(tx|earnTx|houseTx|lendTx|zapTx)"` under components/). Buttons that pay nobody are not listed:
 * Continue, pause, strategy settings, cancel of a queued withdrawal, claim, and processQueue.
 */
const read = (file: string) => readFileSync(resolve(import.meta.dirname, file), "utf8");

/** The `<PayoutTiming ... />` blocks of a source, with where each one ends. */
function timingBlocks(source: string): { end: number; text: string }[] {
  const out: { end: number; text: string }[] = [];
  for (const m of source.matchAll(/<PayoutTiming\b[\s\S]*?\/>/g)) out.push({ end: m.index + m[0].length, text: m[0] });
  return out;
}

/** How far above its button a timing block may sit and still belong to it (one panel's worth of JSX). */
const SAME_BLOCK = 2_500;

/**
 * For EVERY occurrence of `marker` (the button's handler), the `<Button` that holds it is preceded, within SAME_BLOCK
 * characters, by a `<PayoutTiming>` block calling `fn`. Returns how many buttons were checked.
 */
function expectTimingAbove(source: string, marker: string, fn: string): number {
  const blocks = timingBlocks(source);
  let checked = 0;
  for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
    const button = source.lastIndexOf("<Button", at);
    expect(button, `no <Button holds ${marker}`).toBeGreaterThan(-1);
    const above = blocks.filter((b) => b.end <= button && button - b.end <= SAME_BLOCK && new RegExp(`\\b${fn}\\b`).test(b.text));
    expect(above.length, `${fn} is not shown above the button for ${marker}`).toBeGreaterThan(0);
    checked += 1;
  }
  expect(checked, `the marker ${marker} was not found`).toBeGreaterThan(0);
  return checked;
}

describe("when you get paid, above every sign button", () => {
  it("TradeTicket: one payout line, the call's settlement date, whether the order buys now or waits as a bid", () => {
    const src = read("TradeTicket.tsx");
    expectTimingAbove(src, "onClick={() => void submit()}", "buyCallTiming");
    expect(src.match(/<PayoutTiming\b/g)).toHaveLength(1);
    // The single-source wait in the buy sentence is this market's live value from /v2/markets, not the default.
    expect(src).toContain("buyCallTiming({ expiry: detail.series.expiry, now: t, uncorroboratedDelayS: marketSettlement?.uncorroboratedDelayS })");
  });

  it("EarnMarket (sell/write and zap): withdraw, zap in and exit zap", () => {
    const src = read("EarnMarket.tsx");
    expectTimingAbove(src, 'onClick={() => void moveBalance("withdraw")}', "ledgerWithdrawTiming");
    expectTimingAbove(src, "onClick={() => void zapWrite()}", "zapTiming");
    expectTimingAbove(src, "onClick={() => void zapExit()}", "zapTiming");
  });

  it("SellTicket: the AskWrite order, from the same helper listAsk sends", () => {
    const src = read("sell/SellTicket.tsx");
    expectTimingAbove(src, "onClick={() => void listAsk()}", "restingOrderTiming");
    expect(src).toMatch(/restingOrderTiming\(\{ kind: "ask", validUntil: nextAskExpiry\(t, cutoff\), now: t \}\)/);
  });

  it("HouseVault: both deposits, the deposit cancel and the withdrawal request, from the vault's own cadence and epochEnd", () => {
    const src = read("HouseVault.tsx");
    expectTimingAbove(src, 'act("Deposit USDG into the house vault"', "houseDepositTiming");
    expectTimingAbove(src, 'act("Deposit Stock Tokens into the house vault"', "houseDepositTiming");
    expectTimingAbove(src, 'act("Cancel queued deposit"', "houseDepositCancelTiming");
    expectTimingAbove(src, 'act("Request a house vault withdrawal"', "houseWithdrawTiming");
    // The withdrawal line gets the chain's SETTLEMENT_WINDOW() read, as the deposit lines do.
    expect(src).toMatch(/houseWithdrawTiming\(\{ cadence, epochEnd: end, now: t, settlementWindow \}\)/);
  });

  it("LendVault (Earn vault): deposit and redeem, with the position flag read conservatively", () => {
    const src = read("LendVault.tsx");
    expectTimingAbove(src, 'act("Deposit into the lending vault"', "earnVaultDepositTiming");
    expectTimingAbove(src, 'act("Redeem lending-vault shares"', "earnVaultRedeemTiming");
    expect(src).toContain("positionOpen: reads.data?.hasOpenPosition !== false");
  });

  it("Portfolio: sell now, list, collect (long and short), buy back, close, replace an order, and withdraw a balance", () => {
    const src = read("Portfolio.tsx");
    expectTimingAbove(src, '"Sell confirmed", sellNow', "sellCallTiming");
    expectTimingAbove(src, '"Resale order submitted", list', "restingOrderTiming");
    expect(expectTimingAbove(src, '"Payout collected", collect', "selfRedeemTiming")).toBe(2);
    expectTimingAbove(src, '"Buyback and close confirmed", buyBack', "closePairTiming");
    expectTimingAbove(src, '"Matched position closed", closeMatched', "closePairTiming");
    expectTimingAbove(src, '"Order replaced", editOrder', "restingOrderTiming");
    expectTimingAbove(src, '"Balance withdrawn"', "ledgerWithdrawTiming");
  });

  it("no surface writes its own payout sentence: the words come from the module only", () => {
    for (const file of ["TradeTicket.tsx", "EarnMarket.tsx", "sell/SellTicket.tsx", "HouseVault.tsx", "LendVault.tsx", "Portfolio.tsx"]) {
      const src = read(file);
      expect(src, file).toContain('from "@/lib/v2/payoutTiming"');
      expect(src, file).not.toMatch(/When you get paid/);
    }
  });
});
