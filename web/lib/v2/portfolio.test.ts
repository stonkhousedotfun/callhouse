import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { HistoryItem, LongPosition, PositionsResponse, ShortPosition } from "./api-types";
import { expiryCountdown, formatChangeBps, longPositionRow, orderIdentityMatches, payoffSentence, pnlPolyline, positionOutcome,
  quoteSell, readyToCollect, realisedPnlSeries, realisedPnlSince, rollerPlacedAskIds, splitResale, tradeWindowOpen, verifySellOrders } from "./portfolio";
import { summariseHistory } from "./historySummary";

const positions = JSON.parse(readFileSync(fileURLToPath(new URL(
  "../../../ops/fixtures/api/v2/accounts/0xE37876AcBfbA6186E4687f4ef465D9AC21558De3/positions.json", import.meta.url)), "utf8")) as PositionsResponse;
const [settled, settling, open] = positions.longs;

describe("portfolio position states", () => {
  it("distinguishes an open long, settlement in progress, and an unpaid settled long", () => {
    expect(payoffSentence(open!)).toMatch(/above \$222/);
    expect(expiryCountdown(open!.series.expiry, open!.series.expiry - 3_600)).toBe("1 hour left");
    expect(positionOutcome(open!, "long", [], open!.series.expiry - 86_400).label).toBe("Position is open.");
    expect(positionOutcome(settling!, "long", [], settling!.series.expiry + 1).label).toBe("Expired. Waiting for the final price.");
    expect(positionOutcome(settled!, "long", [], settled!.series.expiry + 1)).toMatchObject({ collect: false, withdraw: false });
    expect(positionOutcome(settled!, "long", [], settled!.series.expiry + 1, 100n)).toMatchObject({ collect: true, withdraw: false });
    const defaultUsdg = { ...settled!, claimable: null };
    expect(positionOutcome(defaultUsdg, "long", [], settled!.series.expiry + 1, 100n).collect).toBe(true);
    expect(positionOutcome({ ...settled!, claimable: { raw: "0", decimals: 6, formatted: "0" } }, "long", [],
      settled!.series.expiry + 1, 100n).collect).toBe(true);
  });

  it("names a settled claim's asset and how redeem delivers it", () => {
    const at = settled!.series.expiry + 1;
    const putSeries = { ...settled!.series, isPut: true };
    const putClaim = { ...settled!, series: putSeries, claimable: { raw: "4620000", decimals: 6, formatted: "4.62" } };
    expect(positionOutcome(putClaim, "long", [], at, 100n).label)
      .toBe("Settled. Collect the options in your wallet. Claim: 4.62 USDG.");
    // A long call is owed in the underlying and converted at redemption on the default preference, so the
    // claim is never presented as a USDG amount or as "in kind" alone.
    // At most 4 decimals of stock (lib/numberFormat.ts), truncated, never the 15-digit wire string.
    expect(positionOutcome(settled!, "long", [], at, 100n).label).toBe("Settled. Collect the options in "
      + "your wallet. Claim: 0.0057 NVDA, paid as USDG unless you chose stock.");
    const shortCall = { series: settled!.series, units: "100", premiumReceived: { raw: "0", decimals: 6, formatted: "0" },
      collateralLocked: { raw: "0", decimals: 18, formatted: "0" }, claimable: settled!.claimable } as ShortPosition;
    expect(positionOutcome(shortCall, "short", [], at, 100n).label)
      .toBe("Settled. Collect the options in your wallet. Claim: 0.0057 NVDA, paid as stock.");
  });

  it("uses redemption history to identify wallet payouts and ledger balances", () => {
    const event = { kind: "redemption", longId: settled!.series.longId, data: {
      side: "long", amount: { raw: "2500000", decimals: 6, formatted: "2.5" }, toLedger: false,
    } } as HistoryItem;
    expect(positionOutcome(settled!, "long", [event], settled!.series.expiry + 1)).toEqual({
      label: "Paid 2.50 USDG to your wallet.", collect: false, withdraw: false,
    });
    expect(positionOutcome(settled!, "long", [{ ...event, data: { ...event.data, toLedger: true } } as HistoryItem], settled!.series.expiry + 1))
      .toMatchObject({ label: "Held in your Stonkhouse balance: 2.50 USDG.", withdraw: true });
  });

  it("says why a winning call was paid in stock, and only for a long paid in stock", () => {
    const at = settled!.series.expiry + 1;
    const stock = { kind: "redemption", longId: settled!.series.longId, data: {
      side: "long", amount: { raw: "165800000000000000", decimals: 18, formatted: "0.1658" }, toLedger: false,
    } } as HistoryItem;
    const why = "Winning calls pay in stock when you chose stock, or when converting to USDG would pay less than the settlement value.";
    expect(positionOutcome(settled!, "long", [stock], at).label).toBe(`Paid 0.1658 NVDA to your wallet. ${why}`);
    expect(positionOutcome(settled!, "long", [{ ...stock, data: { ...stock.data, toLedger: true } } as HistoryItem], at).label)
      .toBe(`Held in your Stonkhouse balance: 0.1658 NVDA. ${why}`);
    // A short call always returns its stock collateral: no note.
    const shortCall = { series: settled!.series, units: "100", premiumReceived: { raw: "0", decimals: 6, formatted: "0" },
      collateralLocked: { raw: "0", decimals: 18, formatted: "0" }, claimable: settled!.claimable } as ShortPosition;
    const shortPaid = { ...stock, data: { ...stock.data, side: "short" } } as HistoryItem;
    expect(positionOutcome(shortCall, "short", [shortPaid], at).label).toBe("Paid 0.1658 NVDA to your wallet.");
  });

  it("rejects an order that changed between a displayed sell quote and chain preflight", () => {
    const quote = quoteSell([{ price: { raw: "500000", decimals: 6, formatted: "0.5" }, units: "40", orders: [
      { orderId: "17", maker: "0x1111111111111111111111111111111111111111", kind: "Bid", units: "40", onChainRemainingUnits: "40", makerFreeCollateral: null, makerFreeUnits: null, validUntil: 100 },
    ] }, { price: { raw: "400000", decimals: 6, formatted: "0.4" }, units: "70", orders: [
      { orderId: "18", maker: "0x2222222222222222222222222222222222222222", kind: "Bid", units: "70", onChainRemainingUnits: "70", makerFreeCollateral: null, makerFreeUnits: null, validUntil: 100 },
    ] }], 100n, { takerFeeFlat: 100_000n, takerFeeCapBps: 1000 });
    expect(quote).toMatchObject({ filled: 100n, premium: 440_000n, fee: 44_000n, sellerFee: 0n, net: 396_000n, limitPrice: 400_000n,
      orderIds: ["17", "18"] });
    const current = quote.selected.map((row) => ({ orderId: BigInt(row.orderId), maker: row.maker, longId: 2n,
      kind: 0, price: row.price, units: row.units, filled: 0n, validUntil: 100, cancelled: false }));
    expect(verifySellOrders(quote, current, 2n, 99)).toBe(true);
    expect(verifySellOrders(quote, [{ ...current[0]!, price: 490_000n }, current[1]!], 2n, 99)).toBe(false);
    const feeQuote = quoteSell([{ price: { raw: "500000", decimals: 6, formatted: "0.5" }, units: "100", orders: [
      { orderId: "17", maker: "0x1111111111111111111111111111111111111111", kind: "Bid", units: "100", onChainRemainingUnits: "100", makerFreeCollateral: null, makerFreeUnits: null, validUntil: 100 },
      { orderId: "18", maker: "0x2222222222222222222222222222222222222222", kind: "Bid", units: "100", onChainRemainingUnits: "100", makerFreeCollateral: null, makerFreeUnits: null, validUntil: 100 },
    ] }], 100n, { takerFeeFlat: 100_000n, takerFeeCapBps: 1000 }, 500,
    "0x1111111111111111111111111111111111111111");
    expect(feeQuote).toMatchObject({ orderIds: ["18"], sellerFee: 25_000n, net: 425_000n });
    const crossing = splitResale([{ price: { raw: "500000", decimals: 6, formatted: "0.5" }, units: "40", orders: [
      { orderId: "17", maker: "0x1111111111111111111111111111111111111111", kind: "Bid", units: "40", onChainRemainingUnits: "40", makerFreeCollateral: null, makerFreeUnits: null, validUntil: 100 },
    ] }], 100n, 450_000n, { takerFeeFlat: 100_000n, takerFeeCapBps: 1000 }, 0,
    "0x2222222222222222222222222222222222222222");
    expect(crossing).toMatchObject({ crossing: { filled: 40n, limitPrice: 500_000n }, restingUnits: 60n });
  });

  it("refuses to cancel or edit a different on-chain order disguised by an API row", () => {
    const displayed = positions.orders[0]!;
    const longId = BigInt(displayed.series.longId);
    expect(orderIdentityMatches(displayed, { longId, kind: 0 })).toBe(true);
    expect(orderIdentityMatches(displayed, { longId: longId + 2n, kind: 0 })).toBe(false);
    expect(orderIdentityMatches(displayed, { longId, kind: 1 })).toBe(false);
  });

  it("marks only the writer asks the AutoRoller's strategy rows track", () => {
    const base = positions.orders[0]!;
    const rollerAsk = { ...base, orderId: "7", kind: "AskWrite" as const };
    const manualAsk = { ...base, orderId: "8", kind: "AskWrite" as const };
    const resale = { ...base, orderId: "10", kind: "AskResale" as const };
    // A strategy id on a non-AskWrite row cannot be the roller's (it only ever places AskWrite): never marked.
    const bid = { ...base, orderId: "9", kind: "Bid" as const };
    const ids = rollerPlacedAskIds([rollerAsk, manualAsk, resale, bid],
      [{ orderId: "7" }, { orderId: "9" }, { orderId: null }, { orderId: "10" }]);
    expect([...ids]).toEqual(["7"]);
    // No strategy rows (a wallet that never used Auto-roll): every ask keeps Edit.
    expect(rollerPlacedAskIds([rollerAsk, manualAsk], []).size).toBe(0);
  });
});

describe("neon portfolio hero and rows", () => {
  const usdg = (raw: string) => ({ raw, decimals: 6, formatted: (Number(raw) / 1e6).toString() });
  const fill = (id: string, ts: number, pnl: string | null) => ({ id, kind: "fill", ts, longId: "1", series: open!.series,
    data: { premium: usdg("1000000"), fee: usdg("0"), rebate: usdg("0"), tx: "0x00", ...(pnl === null ? {} : { realisedPnl: usdg(pnl) }) },
  }) as unknown as HistoryItem;
  const items = [fill("c", 300, "-500000"), fill("a", 100, "2000000"), fill("x", 150, null), fill("b", 200, "1000000")];

  it("accumulates realised P&L in time order and ends at the summary's realised total", () => {
    const series = realisedPnlSeries(items);
    expect(series.map((point) => [point.ts, point.cumulative])).toEqual([[100, 2_000_000n], [200, 3_000_000n], [300, 2_500_000n]]);
    expect(series.at(-1)!.cumulative).toBe(summariseHistory(items, undefined).realisedUsdg);
  });

  it("opens a period chart at the running total, not at zero, and counts only the period for the delta", () => {
    const series = realisedPnlSeries(items, 150);
    expect(series[0]).toEqual({ ts: 150, cumulative: 2_000_000n });
    expect(series.at(-1)!.cumulative).toBe(2_500_000n);
    expect(realisedPnlSince(items, 150)).toBe(500_000n);
    expect(realisedPnlSeries(items, 400)).toEqual([{ ts: 400, cumulative: 2_500_000n }]);
    expect(realisedPnlSeries([], null)).toEqual([]);
  });

  it("draws nothing for fewer than two points and keeps a rising series rising on screen", () => {
    expect(pnlPolyline([{ ts: 1, cumulative: 5n }], 100, 50)).toBe("");
    const line = pnlPolyline(realisedPnlSeries(items.slice(1, 2).concat(items[3]!)), 100, 50)
      .split(" ").map((pair) => pair.split(",").map(Number));
    expect(line[0]![0]).toBe(0);
    expect(line.at(-1)![0]).toBe(100);
    expect(line.at(-1)![1]).toBeLessThan(line[0]![1]!);
  });

  it("builds the row from the mark and labels a fair-value mark honestly", () => {
    const base = { ...open!, avgCost: usdg("1000000"), mark: usdg("1250000"), markSource: "best-bid" as const, claimable: null };
    expect(longPositionRow(base)).toEqual({ paid: "1", now: "1.25", nowLabel: "Bid now", changeBps: 2500, action: "Sell" });
    expect(longPositionRow({ ...base, markSource: "fair" }).nowLabel).toBe("Fair now");
    expect(longPositionRow({ ...base, mark: null }).changeBps).toBeNull();
    expect(longPositionRow({ ...base, avgCost: usdg("0") }).changeBps).toBeNull();
    expect(formatChangeBps(2500)).toBe("+25.0%");
    expect(formatChangeBps(-300)).toBe("\u22123.0%");
    expect(formatChangeBps(0)).toBe("0.0%");
  });

  it("collects only settled claimables and never adds a Stock Token claim to the USDG total", () => {
    const settledSeries = { ...settled!.series, status: "settled" as const };
    const usdgClaim = { ...settled!, series: settledSeries, claimable: usdg("4620000") };
    const stockClaim = { ...settled!, series: settledSeries, claimable: { raw: "10", decimals: 18, formatted: "0.00000000000000001" } };
    const openClaim = { ...open!, claimable: usdg("9000000") };
    expect(longPositionRow(usdgClaim).action).toBe("Collect");
    expect(longPositionRow(openClaim).action).toBe("Sell");
    expect(readyToCollect([usdgClaim, stockClaim, openClaim, { ...usdgClaim, claimable: usdg("0") }]))
      .toEqual({ usdgRaw: 4_620_000n, positions: 2, otherAssets: 1 });
  });
});

describe("a held position trades until expiry on the chain's clock", () => {
  const series = { status: "open", expiry: 1_790_000_000 };

  it("open a second before expiry, shut at it (OrderBook._place: PastCutoff at block.timestamp >= expiry for a bid or resale ask)", () => {
    expect(tradeWindowOpen(series, series.expiry - 1)).toBe(true);
    expect(tradeWindowOpen(series, series.expiry)).toBe(false);
    expect(tradeWindowOpen(series, series.expiry + 60)).toBe(false);
  });

  it("an unmeasured chain clock keeps it shut, as the order card and the ticket do", () => {
    expect(tradeWindowOpen(series, null)).toBe(false);
  });

  it("the cutoff status still trades (resale asks and bids until expiry); settling and settled do not", () => {
    expect(tradeWindowOpen({ ...series, status: "cutoff" }, series.expiry - 1)).toBe(true);
    expect(tradeWindowOpen({ ...series, status: "settling" }, series.expiry - 1)).toBe(false);
    expect(tradeWindowOpen({ ...series, status: "settled" }, series.expiry - 1)).toBe(false);
  });
});
