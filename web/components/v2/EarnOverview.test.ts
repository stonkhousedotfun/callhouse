/**
 * The writer's realised figures, which the history endpoint already
 * returns and the UI already throws away.
 *
 * THE ASSERTION THAT MATTERS is not the arithmetic — it is the refusal to add two assets together.
 * `mint.fee` and `close.feeRefund` are denominated in the series' COLLATERAL (Stock Tokens for a
 * call, USDG for a put); `fill.fee`, `fill.rebate` and `fill.premium` are USDG. A sum across both
 * renders, looks plausible, and is wrong — the failure class this workspace logs as false-green.
 * PROVE BY BREAKING: fold `mint.fee` into `feesRaw` and the collateral test below goes red.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { HistoryItem } from "@/lib/v2/api-types";

import { EarnRealised, earnCardPrice, readWholeHistory, realisedSummary, WHOLE_HISTORY_MAX_ROWS, writerCopy } from "./EarnOverview";

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

describe("writer copy names puts only when a live market enables them", () => {
  it("puts:false on every live market: no put in the lede or the warning", () => {
    const copy = writerCopy([{ puts: false }, { puts: false }]);
    expect(copy.hasPuts).toBe(false);
    expect(copy.lede.toLowerCase()).not.toContain("put");
    expect(copy.notice.toLowerCase()).not.toContain("put");
  });

  it("puts:true on a live market: the put copy is back", () => {
    const copy = writerCopy([{ puts: false }, { puts: true }]);
    expect(copy.hasPuts).toBe(true);
    expect(copy.lede).toContain("cash-secured puts");
    expect(copy.notice).toContain("a put can lose");
  });

  it("no live market: calls copy", () => {
    expect(writerCopy([]).hasPuts).toBe(false);
  });
});

/*
 * The realised block says "your whole history", and it used to read the history endpoint's default
 * page: the newest 50 rows. Now it walks the keyset cursor to the end, and when it stops at its page cap it says how
 * many entries it counted instead.
 * PROVE BY BREAKING: return after the first page in readWholeHistory and "reads every page" goes red; always pass
 * complete=true and "a capped walk" goes red.
 */
describe("the realised figures read the whole history", () => {
  const page = (n: number, next: string | null) => ({ items: Array.from({ length: n }, (_, i) => fill({ premium: String(1_000_000 + i) })), nextCursor: next });

  it("reads every page until the cursor runs out", async () => {
    const pages = [page(200, "c1"), page(200, "c2"), page(7, null)];
    const read = vi.fn(async (cursor: string | undefined) => pages[cursor === undefined ? 0 : cursor === "c1" ? 1 : 2]!);
    const whole = await readWholeHistory(read);
    expect(whole.complete).toBe(true);
    expect(whole.items).toHaveLength(407);
    expect(read.mock.calls.map((call) => call[0])).toEqual([undefined, "c1", "c2"]);
  });

  it("a capped walk reports complete: false, and the block names the entries it counted", async () => {
    let n = 0;
    const whole = await readWholeHistory(async () => page(1, `c${++n}`), 3);
    expect(whole).toMatchObject({ complete: false });
    expect(whole.items).toHaveLength(3);
    const summary = realisedSummary([fill()]);
    const capped = renderToStaticMarkup(createElement(EarnRealised, { summary, complete: false }));
    expect(capped).toContain(`Realised across your latest ${WHOLE_HISTORY_MAX_ROWS.toLocaleString("en-US")} history entries`);
    expect(capped).not.toContain("whole history");
    const full = renderToStaticMarkup(createElement(EarnRealised, { summary }));
    expect(full).toContain("Realised across your whole history, in USDG.");
  });

  it("a cursor the API repeats is an error, not a loop", async () => {
    await expect(readWholeHistory(async () => page(1, "same"))).rejects.toThrow("The history cursor repeated.");
  });
});

/* A writing card always shows a price when anything has one; the Write button is not decided here. */
describe("earn cards fall back to a display price", () => {
  const fallback = { raw: 148_774_050n, updatedAt: 1_790_196_519, source: "pool" as const };

  it("API spot first, else the fallback with its line, else unavailable", () => {
    const NY = "America/New_York";
    expect(earnCardPrice({ spot: { raw: "148774050", decimals: 6, formatted: "148.77405" }, spotUpdatedAt: 1_790_196_519 }, fallback, 1_790_223_000, NY))
      .toEqual({ price: "$148.77405", line: null });
    expect(earnCardPrice({ spot: null, spotUpdatedAt: null }, fallback, 1_790_223_000, NY))
      .toEqual({ price: "$148.77", line: "Pool price, updated 4:48 PM EDT" });
    // The reader's zone, named; never UTC.
    expect(earnCardPrice({ spot: null, spotUpdatedAt: null }, fallback, 1_790_223_000, "America/Los_Angeles"))
      .toEqual({ price: "$148.77", line: "Pool price, updated 1:48 PM PDT" });
    expect(earnCardPrice({ spot: null, spotUpdatedAt: null }, undefined, 1_790_223_000, NY))
      .toEqual({ price: "Price unavailable", line: null });
  });

  it("with the clock not yet read (useNow() is 0 before mount), an old Chainlink price is dated, not current", () => {
    const old = { raw: 148_774_050n, updatedAt: 1_790_196_519, source: "chainlink" as const };
    expect(earnCardPrice({ spot: null, spotUpdatedAt: null }, old, 0, "America/New_York"))
      .toEqual({ price: "$148.77", line: "Updated Sep 23, 4:48 PM EDT" });
  });
});
