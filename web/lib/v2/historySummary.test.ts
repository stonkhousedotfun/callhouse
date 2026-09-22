import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { HistoryItem, HistoryResponse } from "./api-types";
import { lifetimePremium, primaryMakerPremium, summariseHistory } from "./historySummary";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL(
  "../../../ops/fixtures/api/v2/accounts/0xE37876AcBfbA6186E4687f4ef465D9AC21558De3/history.json", import.meta.url)), "utf8")) as HistoryResponse;
const baseFill = fixture.items.find((item): item is Extract<HistoryItem, { kind: "fill" }> => item.kind === "fill")!;
const baseMint = fixture.items.find((item): item is Extract<HistoryItem, { kind: "mint" }> => item.kind === "mint")!;
const usdg = "0x1111111111111111111111111111111111111111";
const stockTwo = "0x2222222222222222222222222222222222222222";
const money = (raw: string, decimals = 6) => ({ raw, decimals, formatted: raw });
const maker = (id: string, ticker = "NVDA", overrides: Partial<typeof baseFill.data> = {}): HistoryItem => ({
  ...baseFill, id, series: { ...baseFill.series, ticker }, data: { ...baseFill.data,
    role: "maker", side: "sell", primary: true, premium: money("4000000"), fee: money("250000"),
    rebate: money("50000"), ...overrides },
});
const redemption = (id: string, ticker: string, asset: string, raw: string, amountInKind: string,
  side: "long" | "short" = "long"): HistoryItem => ({
  id, kind: "redemption", ts: baseFill.ts, longId: baseFill.longId,
  series: { ...baseFill.series, ticker, underlying: ticker === "NVDA" ? baseFill.series.underlying : stockTwo },
  data: { side, tokenId: "1", units: "100", asset, amount: money(raw, asset === usdg ? 6 : 18),
    amountInKind: money(amountInKind, 18), toLedger: false, realisedPnl: money("100000"), tx: baseFill.data.tx },
});

describe("indexed history accounting", () => {
  it("keeps net primary maker premium separate from P&L and counts only maker primary sells", () => {
    const rows = [maker("a"), maker("b", "AAPL", { fee: money("100000"), rebate: money("0") }),
      maker("c", "NVDA", { role: "taker" }), maker("d", "NVDA", { side: "buy" }),
      maker("e", "NVDA", { primary: false }), maker("a")];
    expect(primaryMakerPremium(rows, "NVDA")).toBe(3_800_000n);
    expect(primaryMakerPremium(rows)).toBe(7_700_000n);
    const summary = summariseHistory(rows);
    expect(summary).toMatchObject({ fillFeesUsdg: 1_100_000n, fillRebatesUsdg: 200_000n,
      primaryMakerPremiumUsdg: 7_700_000n, realisedUsdg: 0n });
  });

  it("attributes mint fees by payer and asset while excluding gifts and unknown legacy rows", () => {
    const wallet = "0x4444444444444444444444444444444444444444";
    const gift: HistoryItem = { ...baseMint, id: "gift", data: { ...baseMint.data,
      fee: money("50000000000000000", 18), payer: "0x5555555555555555555555555555555555555555",
      longTo: wallet } };
    const ownCall: HistoryItem = { ...baseMint, id: "own-call", data: { ...baseMint.data,
      fee: money("20000000000000000", 18), payer: wallet, longTo: wallet } };
    const ownPut: HistoryItem = { ...baseMint, id: "own-put", series: { ...baseMint.series, isPut: true },
      data: { ...baseMint.data, fee: money("300000", 6), payer: wallet, longTo: wallet } };
    const unknown: HistoryItem = { ...baseMint, id: "unknown", data: { units: baseMint.data.units,
      collateral: baseMint.data.collateral, fee: money("10000000000000000", 18), longTo: wallet,
      tx: baseMint.data.tx } };
    const close: HistoryItem = { id: "close", kind: "close", ts: baseFill.ts, longId: baseFill.longId,
      series: baseFill.series, data: { units: "100", collateralFreed: money("1000000000000000000", 18),
        feeRefund: money("40000000000000000", 18), realisedPnl: money("-300000"), tx: baseFill.data.tx } };
    const converted = redemption("converted", "NVDA", usdg, "2000000", "1000000000000000000");
    const stock = redemption("stock", "NVDA", baseFill.series.underlying, "750000000000000000", "750000000000000000");
    const otherStock = redemption("other", "AAPL", stockTwo, "2000000000000000000", "2000000000000000000");
    const returnedCollateral = redemption("short", "NVDA", baseFill.series.underlying, "500000000000000000", "500000000000000000", "short");
    const summary = summariseHistory([gift, ownCall, ownPut, unknown, close, converted, stock, otherStock,
      returnedCollateral], wallet);
    expect(summary.fillFeesUsdg).toBe(0n);
    expect(summary.mintFeesUsdg).toBe(300_000n);
    expect(summary.feesPaidUsdg).toBe(300_000n);
    expect(summary.stockMintFees.map(({ ticker, raw }) => [ticker, raw])).toEqual([
      [baseMint.series.ticker, 20_000_000_000_000_000n],
    ]);
    expect(summary.mintFeesPaidByAnother).toBe(1);
    expect(summary.mintFeesWithoutPayer).toBe(1);
    expect(summary.realisedUsdg).toBe(100_000n);
    expect(summary.stockPayouts.map(({ ticker, raw }) => [ticker, raw])).toEqual([
      ["AAPL", 2_000_000_000_000_000_000n], ["NVDA", 750_000_000_000_000_000n],
    ]);
  });

  it("preserves abort/cursor behavior and labels a repeated cursor as incomplete", async () => {
    const signal = new AbortController().signal;
    const calls: Array<{ cursor?: string; signal: AbortSignal }> = [];
    const readHistory = async (_address: string, params: { limit?: number; cursor?: string }, options?: { signal?: AbortSignal }) => {
      calls.push({ cursor: params.cursor, signal: options!.signal! });
      return { items: [maker("same-id")], nextCursor: "same-cursor" };
    };
    expect(await lifetimePremium("0xabc", "NVDA", signal, readHistory)).toEqual({ amount: 3_800_000n, complete: false });
    expect(calls).toEqual([{ cursor: undefined, signal }, { cursor: "same-cursor", signal }]);
    expect(await lifetimePremium("0xabc", "NVDA", signal, async () =>
      ({ items: [maker("last")], nextCursor: null }))).toEqual({ amount: 3_800_000n, complete: true });
  });
});
