/**
 * W5, plan gap 9 and section 5.2: the writer's realised figures, which the history endpoint already
 * returns and the UI already throws away.
 *
 * THE ASSERTION THAT MATTERS is not the arithmetic — it is the refusal to add two assets together.
 * `mint.fee` and `close.feeRefund` are denominated in the series' COLLATERAL (Stock Tokens for a
 * call, USDG for a put); `fill.fee`, `fill.rebate` and `fill.premium` are USDG. A sum across both
 * renders, looks plausible, and is wrong — the failure class this workspace logs as false-green.
 * PROVE BY BREAKING: fold `mint.fee` into `feesRaw` and the collateral test below goes red.
 */
import { describe, expect, it } from "vitest";

import type { HistoryItem } from "@/lib/v2/api-types";

import { realisedSummary } from "./EarnOverview";

const usdg = (raw: string) => ({ raw, decimals: 6, formatted: raw });
const series = { ticker: "NVDA", isPut: false, strike: usdg("220000000"), expiry: 0 } as unknown as HistoryItem extends { series: infer S } ? S : never;

const fill = (over: Partial<{ side: "buy" | "sell"; premium: string; fee: string; rebate: string; realised: string | null }> = {}): HistoryItem => ({
  id: `fill-${over.premium ?? "1"}-${over.side ?? "sell"}`,
  kind: "fill",
  ts: 0,
  longId: "1",
  series,
  data: {
    orderId: "1",
    side: over.side ?? "sell",
    role: "maker",
    counterparty: "0x",
    units: "1",
    price: usdg("1000000"),
    premium: usdg(over.premium ?? "3000000"),
    fee: usdg(over.fee ?? "30000"),
    rebate: usdg(over.rebate ?? "10000"),
    primary: true,
    realisedPnl: over.realised === undefined ? null : over.realised === null ? null : usdg(over.realised),
    tx: "0x",
  },
}) as HistoryItem;

const mint = (fee: string): HistoryItem => ({
  id: `mint-${fee}`,
  kind: "mint",
  ts: 0,
  longId: "1",
  series,
  data: { units: "1", collateral: { raw: "1000000000000000000", decimals: 18, formatted: "1" }, fee: { raw: fee, decimals: 18, formatted: fee }, longTo: "0x", tx: "0x" },
}) as HistoryItem;

describe("a writer's realised figures", () => {
  it("nets premium by side and sums the USDG fees and rebates the table used to drop", () => {
    const summary = realisedSummary([fill(), fill({ side: "buy", premium: "1000000" })]);
    expect(summary.kind).toBe("figures");
    if (summary.kind !== "figures") return;
    expect(summary.premiumRaw).toBe(2_000_000n); // 3.00 received, 1.00 paid
    expect(summary.feesRaw).toBe(60_000n);
    expect(summary.rebatesRaw).toBe(20_000n);
    expect(summary.decimals).toBe(6);
  });

  it("NEVER folds collateral-denominated mint fees into the USDG total, and says how many it left out", () => {
    // The mint fee here is 18-decimal Stock. Adding it to a 6-decimal USDG fee total would be
    // wrong by twelve orders of magnitude and would still render.
    const summary = realisedSummary([fill({ fee: "30000" }), mint("500000000000000000")]);
    expect(summary.kind).toBe("figures");
    if (summary.kind !== "figures") return;
    expect(summary.feesRaw).toBe(30_000n);
    expect(summary.collateralDenominatedItems).toBe(1);
  });

  it("refuses to add across two decimal scales rather than producing a plausible wrong number", () => {
    const odd = fill();
    (odd.data as { fee: { decimals: number } }).fee = { raw: "1", decimals: 18, formatted: "1" } as never;
    expect(realisedSummary([fill(), odd])).toEqual({ kind: "mixed-decimals", saw: [6, 18] });
  });

  it("reports empty rather than a row of zeroes when there is nothing realised", () => {
    expect(realisedSummary([])).toEqual({ kind: "empty" });
    expect(realisedSummary([mint("1")])).toEqual({ kind: "empty" });
  });

  it("counts realised P&L where the API reported one", () => {
    const summary = realisedSummary([fill({ realised: "250000" })]);
    expect(summary.kind === "figures" && summary.realisedRaw).toBe(250_000n);
  });
});
