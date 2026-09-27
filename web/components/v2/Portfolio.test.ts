import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { HistoryItem, HistoryResponse, StrategiesResponse } from "@/lib/v2/api-types";
import { summariseHistory } from "@/lib/v2/historySummary";
import type { LongPosition, Market, PositionsResponse } from "@/lib/v2/api-types";
import { type StrategiesOptions, writerStrategiesOptions } from "@/lib/v2/api";
import { selectPortfolioSmartPricingStrategies } from "@/lib/v2/smartPricing";
import { AutoPricedAskCard, CollectPayoutCard, HistoryRows, HistorySummaryPanel, LongPositionRowView, OrderActions, PortfolioDisconnected, PortfolioLendRequests, payoutPreferenceHelp, rowMeta } from "./Portfolio";
import { rollerPlacedAskIds } from "@/lib/v2/portfolio";
import { heldPaymentsView } from "@/lib/v2/earnDeferred";
import { Time } from "@/components/ui/Time";

// ConnectButton reads wagmi's context; the disconnected view only needs to prove it mounts one.
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => createElement("button", { type: "button" }, "Connect wallet") }));

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
    expect(html).toContain('/sell/nvda?edit=smart-pricing#auto-roll');
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

    // The AutoRoller closed the position; the card says so instead of "No live order".
    const closedAt = 1_800_090_000;
    const closed = renderToStaticMarkup(createElement(AutoPricedAskCard, { row: smartStrategy({
      currentLongId: null, orderId: null, expiry: null,
      lastClose: { at: closedAt, longId: "1", orderId: "9", redeemed: true },
      pricing: { ...base.pricing!, currentAsk: null, band: null },
    }), pricerAvailable: true, dataUnavailable: false }));
    expect(closed).toContain(">Closed<");
    expect(closed).toContain(`The last call closed on ${renderToStaticMarkup(createElement(Time, { at: closedAt }))}`);
    expect(closed).not.toContain("No live order");
    expect(closed).not.toContain("has no live order");

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
    // trimmed to the label; still never a fee of zero.
    expect(html).toContain("Fee: not itemized");
    expect(html).toContain("Fee: not reported");
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
    // "Attributable" dropped from the visible labels; the exclusions moved into the Fees paid tile's "?".
    expect(html).toContain("USDG fees this wallet paid");
    expect(html).toContain("Stock Token mint fees paid");
    expect(html).toContain("1 mint row without payer identity");
    expect(html).toContain("Stock Token amounts are never added to USDG");
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
 * History rows print their time through the shared `stamp()`, not the local `date` helper
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
    expect(html).toContain("Sep 21, 4:00 PM EDT"); // server render (and hydration) shows New York, zone named; the browser switches to the reader's zone.
    expect(html).toContain("Jan 21, 4:00 PM EST");
  });
});

describe("neon Portfolio rows and disconnected state", () => {
  const positions = JSON.parse(readFileSync(fileURLToPath(new URL(
    "../../../ops/fixtures/api/v2/accounts/0xE37876AcBfbA6186E4687f4ef465D9AC21558De3/positions.json", import.meta.url)), "utf8")) as PositionsResponse;
  const open = positions.longs.find((long) => long.series.status === "open")!;
  const row = (position: LongPosition, expanded = false) => renderToStaticMarkup(createElement(LongPositionRowView,
    { position, now: position.series.expiry - 3_600, open: expanded, onToggle: () => {} }));

  it("shows paid, the bid now, the change and a Sell action for an open long", () => {
    const html = row({ ...open, avgCost: usd("1000000", "1"), mark: usd("1250000", "1.25"), markSource: "best-bid", claimable: null });
    expect(html).toContain('data-slot="position-row"');
    expect(html).toMatch(/Paid<\/span><span class="num">1</);
    expect(html).toMatch(/Bid now<\/span><span class="num">1.25</);
    expect(html).toContain("+25%"); // percent without a zero tail
    expect(html).toContain(">Sell</button>");
    expect(html).toContain("1 hour left");
  });

  it("the row names the expiry day as the spec does, never the long timestamp", () => {
    const html = row({ ...open, avgCost: usd("1000000", "1"), mark: null, markSource: null, claimable: null });
    expect(html).toContain("Today, 1 hour left · ");
    expect(html).not.toMatch(/\d{4}, \d{1,2}:\d\d [AP]M/);
    expect(rowMeta(open.series.expiry, "454", open.series.expiry - 3 * 86_400)).toMatch(/^[A-Z][a-z]{2} \d{1,2} · 4\.54 sh$/);
    expect(rowMeta(open.series.expiry, "100", null)).not.toContain("Today");
  });

  it("never calls a fair-value mark a bid, and shows a dash without one", () => {
    expect(row({ ...open, mark: usd("900000", "0.9"), markSource: "fair" })).toContain("Fair now");
    const html = row({ ...open, mark: null, markSource: null });
    expect(html).toMatch(/Bid now<\/span><span class="num">—</);
  });

  it("offers Collect on a settled long with a claim, and Close once expanded", () => {
    const settled = { ...open, series: { ...open.series, status: "settled" as const }, claimable: usd("4620000", "4.62") };
    expect(row(settled)).toContain(">Collect</button>");
    expect(row(settled, true)).toContain('aria-expanded="true"');
    expect(row(settled, true)).toContain(">Close</button>");
  });

  it("explains what appears once connected and mounts the Connect button", () => {
    const html = renderToStaticMarkup(createElement(PortfolioDisconnected));
    expect(html).toContain("Connect a wallet to see your portfolio");
    // The four-bullet list became one line.
    expect(html).toContain("Your P&amp;L, positions, orders and payouts ready to collect.");
    expect(html).toContain(">Connect wallet</button>");
  });
});

describe("the Collect payout button keeps a visible focus ring on the accent card", () => {
  const css = readFileSync(fileURLToPath(new URL("../../app/globals.css", import.meta.url)), "utf8");
  const source = readFileSync(fileURLToPath(new URL("./Portfolio.tsx", import.meta.url)), "utf8");
  const html = renderToStaticMarkup(createElement(CollectPayoutCard,
    { collectable: { usdgRaw: 12_500_000n, positions: 2, otherAssets: 1 }, onCollect: () => undefined }));
  const classOf = (pattern: RegExp) => pattern.exec(html)?.[1]?.split(/\s+/) ?? [];

  it("the global ring is --accent, so on this accent card it would vanish without an override", () => {
    expect(css).toMatch(/:focus-visible \{\s*outline: 2\.5px solid var\(--accent\);/);
    expect(classOf(/<section[^>]*class="([^"]*)"/)).toContain("bg-accent");
  });

  it("the button rings in --accent-ink, the card's own text colour", () => {
    const button = classOf(/<button[^>]*class="([^"]*)"[^>]*>Collect payout<\/button>/);
    expect(button, "the Collect payout button renders").not.toEqual([]);
    expect(button).toContain("focus-visible:outline-accent-ink");
    expect(classOf(/<section[^>]*class="([^"]*)"/)).toContain("text-accent-ink");
    expect(html).toContain("12.50 USDG"); // the money rule, through fmtUsdg
    expect(html).toContain("2 settled positions, 1 paid in Stock Tokens (not added to USDG).");
  });

  it("the Portfolio page renders this card for a collectable payout", () => {
    expect(source).toContain("? <CollectPayoutCard collectable={collectable} onCollect={() => {");
  });
});

/*
 * /portfolio shows the payments the lending vault HELD for this wallet, next to its queued requests, with the
 * same Claim as /lend. PortfolioLendRequests is the section Portfolio renders; the source check pins that it is fed by
 * the on-chain read of the registry vault for the connected wallet.
 */
describe("/portfolio: payments held for you", () => {
  const me = "0x4444444444444444444444444444444444444444" as const;
  const vault = "0x00000000000000000000000000000000000000E5" as const;

  it("a wallet with a held payment sees it with an enabled Claim, beside its queued requests", () => {
    const held = heldPaymentsView({ status: "ok", complete: true, checked: 2,
      items: [{ vault, id: 2n, owner: me, receiver: me, assets: 7_000_000n }] }, me);
    const html = renderToStaticMarkup(createElement(PortfolioLendRequests, { queueCards: [], held, canAct: true, busy: false,
      onCancel: () => {}, onClaim: () => {} }));
    expect(html).toContain("Payments held for you");
    expect(html).toContain("Held payment for request #2");
    expect(html).toContain("7 USDG"); // No zero tail
    expect(html).toMatch(/<button(?![^>]* disabled="")[^>]*>Claim<\/button>/);
    const off = renderToStaticMarkup(createElement(PortfolioLendRequests, { queueCards: [], held, canAct: false, busy: false,
      onCancel: () => {}, onClaim: () => {} }));
    expect(off).toMatch(/<button[^>]* disabled=""[^>]*>Claim<\/button>/);
  });

  it("Portfolio reads the held payments of the REGISTRY vault for the connected wallet, and claims through claimDeferredPayment", () => {
    const source = readFileSync(fileURLToPath(new URL("./Portfolio.tsx", import.meta.url)), "utf8");
    expect(source).toContain("useHeldPayments(earnVaultAddress(), address)");
    expect(source).toContain("<PortfolioLendRequests queueCards={queueCards} held={held}");
    expect(source).toContain("await claimDeferredPayment(ctx, card.held.id, to);");
  });
});

/**
 * The payout-preference help and the history fee tile carry put copy only while a
 * live market enables puts. The signal is `putTickers(markets.data)`, the one uses; no second one.
 */
describe("Portfolio put copy follows the puts flag", () => {
  it("puts off: the payout help has no put sentence; puts on: today's text, unchanged", () => {
    const off = payoutPreferenceHelp(false);
    expect(off).not.toMatch(/put/i);
    expect(off).toContain("Winning calls try USDG conversion and fall back to Stock Tokens.");
    expect(off).toContain("Short payouts return collateral. Applies to future redemptions.");
    expect(payoutPreferenceHelp(true)).toBe("Winning calls try USDG conversion and fall back to Stock Tokens. "
      + "Puts pay USDG and short payouts return collateral. Applies to future redemptions.");
  });

  it("the history summary passes the flag to the fee tile, calls-only by default", () => {
    const summary = { ...summariseHistory([], undefined), mintFeesUsdg: 250_000n };
    const render = (anyPuts?: boolean) => renderToStaticMarkup(createElement(HistorySummaryPanel,
      { summary, complete: true, stale: false, onHistory: () => {}, ...(anyPuts === undefined ? {} : { anyPuts }) }));
    expect(render()).not.toContain("put mints");
    expect(render(false)).not.toContain("put mints");
    expect(render(true)).toContain("put mints");
  });

  it("Portfolio derives the flag from putTickers(markets.data) and feeds both surfaces", () => {
    const source = readFileSync(fileURLToPath(new URL("./Portfolio.tsx", import.meta.url)), "utf8");
    expect(source).toContain("const anyPuts = putTickers(markets.data).size > 0;");
    // The help moved into the card's "?" tip.
    expect(source).toContain(">{payoutPreferenceHelp(anyPuts)}</InfoTip>");
    expect(source).toContain('onHistory={() => setTab("history")} anyPuts={anyPuts} />');
    expect(source).not.toContain("Puts pay USDG and short payouts return collateral. Applies to future redemptions. Current");
  });
});

/**
 * OrderBook judges validUntil against block.timestamp, so the resale ask Portfolio lists sets it from CHAIN
 * time through restingValidUntil, and editing an order checks its expiry against chainNow (both in tx.ts, tested there
 * against a browser clock skewed both ways). These are wallet-bound handlers inside card components, so what is
 * checkable here is that each handler calls the helper and the browser clock is not in it.
 */
describe("resting-order validUntil uses chain time", () => {
  const source = readFileSync(fileURLToPath(new URL("./Portfolio.tsx", import.meta.url)), "utf8");
  function body(start: string, end: string): string {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    return source.slice(from, to);
  }

  it("the resale ask's validUntil comes from restingValidUntil, never Date.now", () => {
    const list = body("async function list(context: WriteContext)", "async function collect(context: WriteContext)");
    expect(list).toContain("await restingValidUntil(context.client ?? publicClient, position.series.expiry)");
    expect(list).toContain("crossing.restingUnits, expiry)");
    expect(list).not.toContain("Date.now");
    expect(list).not.toContain("86_400");
  });

  it("editing an order checks its validUntil against chain time, never Date.now", () => {
    const edit = body("async function editOrder(context: WriteContext)", "function Ledger(");
    expect(edit).toContain("current.validUntil <= await chainNow(context.client ?? publicClient)");
    expect(edit).not.toContain("Date.now");
  });
});

describe("Portfolio asks the indexer for this wallet's strategies", () => {
  // The indexer's /v2/strategies, emulated: rows ordered by id, `writer` and `active` filter, `limit` cuts the page.
  const serve = (rows: IndexedStrategy[], params: StrategiesOptions) => rows.filter((row) =>
    (params.writer === undefined || row.writer.toLowerCase() === params.writer.toLowerCase()) &&
    (params.active === undefined || row.strategy.active === params.active)).slice(0, params.limit ?? 50);
  const market = { ticker: "NVDA", underlying: "0x2222222222222222222222222222222222222222" } as Market;
  // 205 other writers whose ids sort before `wallet` (0x4444…), then the wallet's own smart-pricing row.
  const rows = [...Array.from({ length: 205 }, (_, index) =>
    smartStrategy({ writer: `0x${(0x1000 + index).toString(16).padStart(40, "0")}` })), smartStrategy()];

  it("the wallet's auto-priced strategy past the first 200 rows is found with the writer filter", () => {
    // The unfiltered 200-row page (the old request) never reached it.
    expect(selectPortfolioSmartPricingStrategies(serve(rows, { active: true, limit: 200 }), wallet, [market])).toEqual([]);
    const page = serve(rows, writerStrategiesOptions(wallet));
    expect(writerStrategiesOptions(wallet)).toEqual({ active: true, writer: wallet, limit: 200 });
    expect(selectPortfolioSmartPricingStrategies(page, wallet, [market])).toEqual([smartStrategy()]);
    // No wallet: the unfiltered page, as before (no `writer` sent).
    expect(writerStrategiesOptions(undefined).writer).toBeUndefined();
  });

  it("Portfolio.tsx and EarnMarket.tsx read strategies through writerStrategiesOptions(address)", () => {
    for (const file of ["./Portfolio.tsx", "./EarnMarket.tsx"]) {
      const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
      expect(source, file).toContain("useStrategies(writerStrategiesOptions(address))");
      expect(source, file).not.toContain("useStrategies({ active: true, limit: 200 })");
    }
  });
});

describe("Portfolio offers Edit only on asks the writer can replace", () => {
  const positions = JSON.parse(readFileSync(fileURLToPath(new URL(
    "../../../ops/fixtures/api/v2/accounts/0xE37876AcBfbA6186E4687f4ef465D9AC21558De3/positions.json", import.meta.url)), "utf8")) as PositionsResponse;
  const base = positions.orders[0]!;
  const rollerAsk = { ...base, orderId: "7", kind: "AskWrite" as const };
  const manualAsk = { ...base, orderId: "8", kind: "AskWrite" as const };
  // The strategy row the indexer serves on the same positions response: its orderId is the roller's live ask.
  const strategies = [{ orderId: "7" }];
  const actions = (order: typeof rollerAsk) => renderToStaticMarkup(createElement(OrderActions, {
    ticker: order.series.ticker, rollerPlaced: rollerPlacedAskIds([rollerAsk, manualAsk], strategies).has(order.orderId),
    cancelDisabled: false, editDisabled: false, onCancel: () => {}, onEdit: () => {} }));

  it("an ask the AutoRoller placed shows no Edit, links to the strategy form and says why", () => {
    const html = actions(rollerAsk);
    expect(html).not.toContain("Edit price and size");
    expect(html).toContain('href="/sell/nvda?edit=smart-pricing#auto-roll"');
    expect(html).toContain("Edit strategy in Auto-roll");
    expect(html).toContain("Auto-roll placed this ask, so only Auto-roll can change it");
    // The maker can always cancel a delegate's ask.
    expect(html).toContain(">Cancel<");
  });

  it("a manual ask keeps Edit and gets no strategy link", () => {
    const html = actions(manualAsk);
    expect(html).toContain("Edit price and size");
    expect(html).not.toContain("#auto-roll");
    expect(html).not.toContain("Auto-roll placed this ask");
    expect(html).toContain(">Cancel<");
  });

  it("Portfolio.tsx feeds each order card from the positions response's strategy rows", () => {
    const source = readFileSync(fileURLToPath(new URL("./Portfolio.tsx", import.meta.url)), "utf8");
    expect(source).toContain("rollerPlacedAskIds(positions.data.orders, positions.data.strategies)");
    expect(source).toContain("rollerPlaced={rollerAskIds.has(order.orderId)}");
    // The replacement form never opens for a roller ask, even if it was open before the rows refreshed.
    expect(source).toContain("{editing && !rollerPlaced ? <div");
  });
});
