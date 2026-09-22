import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { HistoryItem, HistoryResponse, StrategiesResponse } from "@/lib/v2/api-types";
import { summariseHistory } from "@/lib/v2/historySummary";
import { AutoPricedAskCard, HistoryRows, HistorySummaryPanel } from "./Portfolio";

const fixture = JSON.parse(readFileSync(fileURLToPath(new URL(
  "../../../ops/fixtures/api/v2/accounts/0xE37876AcBfbA6186E4687f4ef465D9AC21558De3/history.json", import.meta.url)), "utf8")) as HistoryResponse;
const fill = fixture.items.find((item): item is Extract<HistoryItem, { kind: "fill" }> => item.kind === "fill")!;
const mint = fixture.items.find((item): item is Extract<HistoryItem, { kind: "mint" }> => item.kind === "mint")!;
const usdg = "0x1111111111111111111111111111111111111111";
const wallet = "0x4444444444444444444444444444444444444444";
const money = (raw: string, decimals: number, formatted: string) => ({ raw, decimals, formatted });

type IndexedStrategy = StrategiesResponse["items"][number];
const usd = (raw: string, formatted: string) => ({ raw, decimals: 6 as const, formatted });
const smartStrategy = (overrides: Partial<IndexedStrategy> = {}): IndexedStrategy => ({
  writer: wallet,
  underlying: "0x2222222222222222222222222222222222222222",
  ticker: "NVDA",
  strategy: { active: true, weekly: true, smartPricing: true, otmBps: 500,
    askBps: 100, minAskBps: 50, maxAskBps: 200, maxUnits: "100" },
  currentLongId: "1", orderId: "9", expiry: 1_800_086_400,
  lastRolledAt: 1_800_000_000, lastStaleCancelAt: null, staleSpot: null,
  pricing: { currentAsk: usd("2000000", "2"), band: { min: usd("1000000", "1"), max: usd("3000000", "3") },
    lastRepricedAt: 1_800_000_100, lastRepricedPrice: usd("2000000", "2"), repriceCount: 4,
    fair: usd("1750000", "1.75") },
  ...overrides,
});

describe("Portfolio auto-priced ask card", () => {
  it("shows a healthy current ask, exact band, fair, last reprice, count, and real edit route", () => {
    const html = renderToStaticMarkup(createElement(AutoPricedAskCard,
      { row: smartStrategy(), pricerAvailable: true, dataUnavailable: false }));
    expect(html).toContain("Current live ask");
    expect(html).toContain("2 USDG");
    expect(html).toContain("Current fair estimate");
    expect(html).toContain("1.75 USDG");
    expect(html).toContain("1–3 USDG");
    expect(html).toContain("In band");
    expect(html).toContain("Reprice count");
    expect(html).toContain(">4<");
    expect(html).toContain('/earn/nvda?edit=smart-pricing#auto-roll');
  });

  it("names a clamped boundary and distinguishes withdrawn, no-order, and legacy states", () => {
    const base = smartStrategy();
    const clamped = renderToStaticMarkup(createElement(AutoPricedAskCard, { row: smartStrategy({
      pricing: { ...base.pricing!, currentAsk: base.pricing!.band!.max },
    }), pricerAvailable: true, dataUnavailable: false }));
    expect(clamped).toContain("Clamped at maximum");

    const withdrawn = renderToStaticMarkup(createElement(AutoPricedAskCard, { row: smartStrategy({
      orderId: null, lastStaleCancelAt: 1_800_000_200,
    }), pricerAvailable: true, dataUnavailable: false }));
    expect(withdrawn).toContain("Withdrawn");
    expect(withdrawn).toContain("There is no live order currently repricing");

    const noOrder = renderToStaticMarkup(createElement(AutoPricedAskCard, { row: smartStrategy({
      orderId: null, lastStaleCancelAt: null,
    }), pricerAvailable: true, dataUnavailable: false }));
    expect(noOrder).toContain("No live order");

    const legacy = renderToStaticMarkup(createElement(AutoPricedAskCard, { row: smartStrategy({ pricing: undefined }),
      pricerAvailable: true, dataUnavailable: false }));
    expect(legacy).toContain("Pricing state not reported");
    expect(legacy).toContain("legacy strategy");
  });

  it("keeps zero fair numeric, null fair unavailable, and outage copy honest", () => {
    const base = smartStrategy();
    const zero = renderToStaticMarkup(createElement(AutoPricedAskCard, { row: smartStrategy({
      pricing: { ...base.pricing!, fair: usd("0", "0") },
    }), pricerAvailable: true, dataUnavailable: false }));
    expect(zero).toContain("Current fair estimate");
    expect(zero).toContain(">0 USDG<");

    const missing = renderToStaticMarkup(createElement(AutoPricedAskCard, { row: smartStrategy({
      pricing: { ...base.pricing!, fair: null },
    }), pricerAvailable: true, dataUnavailable: false }));
    expect(missing).toContain(">Unavailable<");
    expect(missing).toContain("fair data is unavailable");
    expect(missing).toContain("not currently repricing");

    const pricerDown = renderToStaticMarkup(createElement(AutoPricedAskCard,
      { row: base, pricerAvailable: false, dataUnavailable: false }));
    expect(pricerDown).toContain("Last indexed ask");
    expect(pricerDown).toContain("pricer is unavailable");
    expect(pricerDown).toContain("not currently repricing");

    const readFailed = renderToStaticMarkup(createElement(AutoPricedAskCard,
      { row: base, pricerAvailable: true, dataUnavailable: true }));
    expect(readFailed).toContain("last indexed ask is shown");
    expect(readFailed).toContain("not currently tracking repricing");
  });

  it("does not promise fills or claim an unchanged ask stays safe", () => {
    const html = renderToStaticMarkup(createElement(AutoPricedAskCard,
      { row: smartStrategy(), pricerAvailable: true, dataUnavailable: false })).toLowerCase();
    expect(html).not.toContain("guaranteed");
    expect(html).not.toContain("static ask cannot become cheap");
    expect(html).toContain("does not promise a fill");
    expect(html).toContain("unchanged ask");
  });
});

describe("portfolio history presentation", () => {
  it("itemizes fill fees/rebates, qualifies mint payer, and never treats a refund as a paid fee", () => {
    const rows: HistoryItem[] = [
      { ...fill, id: "fill", data: { ...fill.data, fee: money("250000", 6, "0.25"),
        rebate: money("10000", 6, "0.01") } },
      { ...mint, id: "gift", data: { ...mint.data, fee: money("10000000000000000", 18, "0.01"),
        payer: "0x5555555555555555555555555555555555555555", longTo: wallet } },
      { ...mint, id: "own", data: { ...mint.data, fee: money("20000000000000000", 18, "0.02"),
        payer: wallet, longTo: wallet } },
      { id: "close", kind: "close", ts: fill.ts, longId: fill.longId, series: fill.series,
        data: { units: "100", collateralFreed: money("1000000000000000000", 18, "1"),
          feeRefund: money("10000000000000000", 18, "0.01"), realisedPnl: null, tx: fill.data.tx } },
    ];
    const html = renderToStaticMarkup(createElement(HistoryRows, { items: rows, address: wallet, usdgAddress: usdg }));
    expect(html).toContain("Fee paid: 0.25 USDG");
    expect(html).toContain("Rebate: 0.01 USDG");
    expect(html).toContain("Mint fee paid by the writer, not this wallet: 0.01 NVDA Stock Tokens");
    expect(html).toContain("Mint fee paid by this wallet: 0.02 NVDA Stock Tokens");
    expect(html).toContain("Fee refund: 0.01 NVDA Stock Tokens");
  });

  it("names actual redemption asset and ledger symbol, and labels unitemized fees honestly", () => {
    const redemption: HistoryItem = { id: "redeem", kind: "redemption", ts: fill.ts,
      longId: fill.longId, series: fill.series, data: { side: "long", tokenId: "1", units: "100",
        asset: usdg, amount: money("2000000", 6, "2"),
        amountInKind: money("1000000000000000000", 18, "1"), toLedger: false,
        realisedPnl: money("100000", 6, "0.1"), tx: fill.data.tx } };
    const deposit: HistoryItem = { id: "deposit", kind: "deposit", ts: fill.ts, longId: null, series: null,
      data: { asset: fill.series.underlying, symbol: "NVDA", amount: money("1000000000000000000", 18, "1"),
        from: usdg, tx: fill.data.tx } };
    const html = renderToStaticMarkup(createElement(HistoryRows, { items: [redemption, deposit], usdgAddress: usdg }));
    expect(html).toContain("2 USDG");
    expect(html).not.toContain("1 NVDA Stock Tokens");
    expect(html).toContain("1 NVDA");
    expect(html).toContain("Fee: not itemized in this history record.");
    expect(html).toContain("Fee: not reported for this ledger move.");
  });

  it("marks loaded-only totals partial and keeps attributable USDG and Stock Token fees separate", () => {
    const ownMint: HistoryItem = { ...mint, id: "own", data: { ...mint.data,
      fee: money("20000000000000000", 18, "0.02"), payer: wallet, longTo: wallet } };
    const unknownMint: HistoryItem = { ...mint, id: "unknown", data: { units: mint.data.units,
      collateral: mint.data.collateral, fee: money("10000000000000000", 18, "0.01"), longTo: wallet,
      tx: mint.data.tx } };
    const summary = summariseHistory([fill, ownMint, unknownMint], wallet);
    const html = renderToStaticMarkup(createElement(HistorySummaryPanel,
      { summary, complete: false, stale: false, onHistory: () => {} }));
    expect(html).toContain("Partial: older activity is not loaded");
    expect(html).toContain("Attributable USDG fees paid");
    expect(html).toContain("Attributable Stock Token mint fees paid");
    expect(html).toContain("1 mint row without payer identity");
    expect(html).toContain("Stock Token amounts are never added to USDG");
    expect(html).toContain("not necessarily USDG received");
    expect(html).toContain("See history rows");
  });
});

describe("long-position withdrawal terms binding", () => {
  it("uses live settlement detail and mounts terms before the conditional collect action", () => {
    const source = readFileSync(fileURLToPath(new URL("./Portfolio.tsx", import.meta.url)), "utf8");
    const longCard = source.slice(source.indexOf("function LongCard"), source.indexOf("function ShortCard"));
    const terms = longCard.indexOf('<WithdrawalTerms className="mt-4" surface="redemption"');
    const collect = longCard.indexOf("{outcome.collect ?");

    expect(source).toContain("const detail = useSeries(longId)");
    expect(longCard).toContain("detail.data?.settlement?.candidate?.finalizableAt");
    expect(longCard).toContain("detail.data?.settlement?.settledAt");
    expect(longCard).toContain("timing={withdrawalTiming}");
    expect(terms).toBeGreaterThan(-1);
    expect(collect).toBeGreaterThan(terms);
  });
});

/**
 * T-431: history rows print their time through the shared `stamp()`, not the local `date` helper
 * this file carried. Same New York wall-clock time on each side of the daylight-saving change: a
 * formatter that lost its zone would print 8:00 PM / 9:00 PM on a UTC runner, and a hard-coded
 * suffix would name the wrong zone for half the year.
 */
describe("portfolio history times", () => {
  const SUMMER = Date.UTC(2026, 8, 21, 20, 0, 0) / 1000; // 16:00 New York, EDT
  const WINTER = Date.UTC(2026, 0, 21, 21, 0, 0) / 1000; // 16:00 New York, EST

  it("renders each row's time in New York, naming EDT or EST by the date", () => {
    const html = renderToStaticMarkup(createElement(HistoryRows, { items: [
      { ...fill, id: "summer", ts: SUMMER },
      { ...fill, id: "winter", ts: WINTER },
    ], address: wallet, usdgAddress: usdg }));
    expect(html).toContain("Sep 21, 2026, 4:00 PM EDT");
    expect(html).toContain("Jan 21, 2026, 4:00 PM EST");
  });
});
