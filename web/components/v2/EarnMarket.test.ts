import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount, useWalletClient } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { useNow } from "@/lib/hooks";
import { v2Markets } from "@/lib/markets";
import { Time } from "@/components/ui/Time";
import { useAllMarketSeries, useConfig, useFair, useMarketSeries, useMarkets, usePositions, useStrategies } from "@/lib/v2/hooks";
import { cycleOptions, EarnMarket, EMPTY_STRATEGY, emptyStrategyFor, portfolioStrategyEditRequested } from "./EarnMarket";
import { weeklyOffered } from "@/lib/v2/presets";
import { PRICER_READING_MAX_AGE_SECONDS, SMART_PRICING_PRICER_DOWN,
  SMART_PRICING_PRICER_UNKNOWN } from "@/lib/v2/smartPricing";

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn(), useQueryClient: vi.fn() }));
vi.mock("wagmi", () => ({ useAccount: vi.fn(), useWalletClient: vi.fn() }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => createElement("button", null, "Connect wallet") }));
vi.mock("@/components/TxToast", () => ({ useNotice: vi.fn(), useV2ReceiptNotice: vi.fn() }));
vi.mock("@/components/v2/PendingOperationsNotice", () => ({ PendingOperationsNotice: () => null }));
// EarnMarket reads its render-time clock from useNow(), which only ticks inside an effect, and
// renderToStaticMarkup never runs effects: left real, the clock would be 0 in every test here. So the clock is
// driven directly, and every other export of the module stays real.
vi.mock("@/lib/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/hooks")>()), useNow: vi.fn(),
}));
vi.mock("@/lib/v2/hooks", () => ({
  useAllMarketSeries: vi.fn(), useConfig: vi.fn(), useFair: vi.fn(), useMarketSeries: vi.fn(),
  useMarkets: vi.fn(), usePositions: vi.fn(), useStrategies: vi.fn(), v2Keys: { all: ["v2"] },
}));

// `emptyQuery` is a PARTIAL UseQueryResult: the real type carries ~20 more fields. Each mock below
// therefore routes through `unknown`, which is what tsc asks for and what this file already does for
// `useQueryClient`. Nothing here widens a production type.
const emptyQuery = { data: undefined, isError: false, isPending: false, isFetching: false, refetch: vi.fn() };

/** A mounted clock, in whole seconds, as useNow() returns it. Fixed so no test depends on the host clock. */
const MOUNTED_NOW_SECONDS = 1_800_000_000;

beforeEach(() => {
  vi.mocked(useAccount).mockReturnValue({ address: undefined } as ReturnType<typeof useAccount>);
  vi.mocked(useWalletClient).mockReturnValue({ data: undefined } as ReturnType<typeof useWalletClient>);
  vi.mocked(useQueryClient).mockReturnValue({ invalidateQueries: vi.fn() } as unknown as ReturnType<typeof useQueryClient>);
  vi.mocked(useQuery).mockReturnValue(emptyQuery as never);
  vi.mocked(useMarkets).mockReturnValue(emptyQuery as unknown as ReturnType<typeof useMarkets>);
  vi.mocked(useMarketSeries).mockReturnValue(emptyQuery as unknown as ReturnType<typeof useMarketSeries>);
  vi.mocked(useAllMarketSeries).mockReturnValue(emptyQuery as unknown as ReturnType<typeof useAllMarketSeries>);
  vi.mocked(useConfig).mockReturnValue(emptyQuery as unknown as ReturnType<typeof useConfig>);
  vi.mocked(useFair).mockReturnValue(emptyQuery as unknown as ReturnType<typeof useFair>);
  vi.mocked(usePositions).mockReturnValue(emptyQuery as unknown as ReturnType<typeof usePositions>);
  vi.mocked(useStrategies).mockReturnValue(emptyQuery as unknown as ReturnType<typeof useStrategies>);
  vi.mocked(useNotice).mockReturnValue(vi.fn() as ReturnType<typeof useNotice>);
  vi.mocked(useV2ReceiptNotice).mockReturnValue(vi.fn() as ReturnType<typeof useV2ReceiptNotice>);
  vi.mocked(useNow).mockReturnValue(MOUNTED_NOW_SECONDS);
});

/*
 * (six daily closes, no weekly ladder). The registry's weekly count is 0, so a new strategy
 * starts daily, the Cycle select offers Daily only, and no weekly preset is shown; a saved weekly strategy stays visible.
 */
describe("Earn defaults to the daily cycle while the registry lists no weeklies", () => {
  it("a new strategy starts daily, derived from the registry", () => {
    expect(weeklyOffered()).toBe(false);
    expect(EMPTY_STRATEGY.weekly).toBe(weeklyOffered());
  });

  it("the Cycle choices: daily only, unless weeklies are listed or the saved strategy is already weekly", () => {
    expect(cycleOptions(false, { weekly: false })).toEqual(["daily"]);
    expect(cycleOptions(false, { weekly: true })).toEqual(["weekly", "daily"]);
    expect(cycleOptions(true, { weekly: false })).toEqual(["weekly", "daily"]);
  });

  it("the rendered page offers no Weekly cycle and no weekly preset", () => {
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(html).toMatch(/<option value="daily"[^>]*>Daily<\/option>/);
    expect(html).not.toMatch(/<option value="weekly"/);
    expect(html).toContain("Daily, +2% OTM");
    expect(html).not.toContain("Weekly, +5% OTM");
    expect(html).not.toContain("Weekly, ~0.15 delta");
    expect(html).not.toContain("Conservative, +10% OTM weekly");
  });
});

/*
 * SPCX's registry row lists weekly (Friday) expiries
 * and no dailies, so its page is the mirror image of NVDA's: a new strategy starts weekly, the Cycle select offers
 * Weekly only, and the "Daily, +2% OTM" preset (which could only fail there) is gone. A saved daily strategy stays visible.
 */
describe("SPCX Earn offers the weekly (Friday) cycle only", () => {
  it("the Cycle choices drop Daily when the market lists no dailies, unless the saved strategy is already daily", () => {
    expect(cycleOptions(true, { weekly: true }, false)).toEqual(["weekly"]);
    expect(cycleOptions(true, { weekly: false }, false)).toEqual(["weekly", "daily"]);
    // The third argument defaults to on, so the cases above keep their meaning.
    expect(cycleOptions(false, { weekly: false })).toEqual(cycleOptions(false, { weekly: false }, true));
  });

  it("a blank form starts on a cycle the market lists", () => {
    expect(emptyStrategyFor(true, false).weekly).toBe(true);
    expect(emptyStrategyFor(false, true)).toEqual(EMPTY_STRATEGY);
    expect(emptyStrategyFor(true, true)).toEqual(EMPTY_STRATEGY);
  });

  it("the rendered SPCX page offers the Weekly cycle and the weekly presets, and nothing daily", () => {
    expect(v2Markets().find((row) => row.ticker === "SPCX")?.v2.overrides).toMatchObject({ expiriesAhead: { weekly: 2, daily: 0 } });
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "SPCX" }));
    expect(html).toMatch(/<option value="weekly"[^>]*>Weekly<\/option>/);
    expect(html).not.toMatch(/<option value="daily"/);
    expect(html).toContain("Weekly, +5% OTM");
    expect(html).toContain("Weekly, ~0.15 delta");
    expect(html).toContain("Conservative, +10% OTM weekly");
    expect(html).not.toContain("Daily, +2% OTM");
    expect(html).toContain("Sell a weekly call");
  });
});

/*
 * The three-step stage stepper this block
 * used to pin is GONE ON PURPOSE: replaces it with one sentence, a facts card, one
 * "Start earning" card, "Your position" only when the wallet has one, and one collapsed Advanced section. These
 * cases pin that layout instead, each against the rendered markup.
 */
describe("the simple Earn layout", () => {
  const WRITER = "0x1111111111111111111111111111111111111111";
  const liveMarket = (puts: boolean) => ({
    ticker: "NVDA", underlying: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", status: "live", puts,
    spot: { raw: "200000000", decimals: 6, formatted: "200" },
    strikeTick: { raw: "1000000", decimals: 6, formatted: "1" },
    expiries: [MOUNTED_NOW_SECONDS + 86_400],
  });
  const connect = () => {
    vi.mocked(useAccount).mockReturnValue({ address: WRITER } as unknown as ReturnType<typeof useAccount>);
    vi.mocked(useWalletClient).mockReturnValue({ data: {} } as unknown as ReturnType<typeof useWalletClient>);
  };
  /** Answer the named writer reads (the second queryKey element); every other query keeps the empty default. */
  const withReads = (reads: Record<string, Record<string, unknown>>) => {
    vi.mocked(useQuery).mockImplementation(((options: { queryKey?: unknown }) => {
      const key = options?.queryKey;
      const name = Array.isArray(key) && key[0] === "v2" ? String(key[1]) : "";
      return name in reads ? { ...emptyQuery, ...reads[name] } : emptyQuery;
    }) as never);
  };
  const render = () => renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
  const POSITION = 'aria-label="Your position"';

  it("no wallet: one sentence, the facts, Connect in step 1, no position, and no stepper", () => {
    const html = render();
    expect(html).toContain("Earn premium on your NVDA");
    // writing a call is not lending: "Sell covered calls on your NVDA Stock Tokens" (was "Lend your ...").
    expect(html).toContain("Sell covered calls on your NVDA Stock Tokens and earn the premium buyers pay");
    expect(html).not.toContain("Lend your");
    expect(html).toContain('aria-label="How Earn works"');
    expect(html).toContain("There is no fixed APY");
    expect(html).toContain("the gain above it goes to the buyer. You keep the premium.");
    expect(html).toContain('aria-label="Start earning"');
    expect(html).toContain("Connect wallet");
    expect(html).not.toContain('id="writer-deposit"');
    expect(html).not.toContain(POSITION);
    expect(html).not.toContain('id="writer-withdraw"');
    // The removed stepper: none of its markers may come back.
    expect(html).not.toContain('aria-label="Earn flow"');
    expect(html).not.toContain("earn-stage-");
    expect(html).not.toContain("Continue to");
  });

  it("wallet with no position: the deposit form shows, withdrawal terms sit above Deposit, and no position card", () => {
    connect();
    const html = render();
    expect(html).toContain('id="writer-deposit"');
    expect(html).toContain('aria-label="Writer balance"');
    expect(html).toContain('aria-label="Withdrawal terms"');
    expect(html).toContain("Free now");
    // plain words, same statement. 
    expect(html).toContain("Locked in sold options");
    expect(html).not.toContain(POSITION);
    expect(html).not.toContain('id="writer-withdraw"');
    // The writer reads the withdrawal terms BEFORE the deposit button, in the markup and in the source.
    expect(html.indexOf('aria-label="Withdrawal terms"')).toBeLessThan(html.indexOf(">Deposit</button>"));
    const source = readFileSync(fileURLToPath(new URL("./EarnMarket.tsx", import.meta.url)), "utf8");
    const terms = source.indexOf('<WithdrawalTerms className="mt-3" surface="writer"');
    const confirm = source.indexOf('onClick={() => void moveBalance("deposit")}');
    expect(terms).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(terms);
  });

  it("wallet with a position: free, locked, premium and auto-roll tiles, and the Withdraw form", () => {
    connect();
    withReads({
      writerBalance: { data: { wallet: 2n * 10n ** 18n, free: 5n * 10n ** 17n, orderBookOperator: false, rollerOperator: false } },
      writerLifetimePremium: { data: { amount: 1_500_000n, complete: true } },
    });
    const html = render();
    expect(html).toContain(POSITION);
    expect(html).toContain("Locked in sold calls");
    expect(html).toContain("Lifetime premium");
    // The premium goes through money rule (lib/numberFormat displayMoney), which shows money to the
    // cent once it has a fraction: "1.50" (the local toLocaleString it replaced printed "1.5").
    expect(html).toMatch(/>1\.50 <small[^>]*>USDG<\/small>/);
    expect(html).toMatch(/>0\.5 <small[^>]*>NVDA<\/small>/);
    expect(html).toContain('id="writer-withdraw"');
    expect(html).toContain(">Withdraw</button>");
    expect(html).toContain("Earn more");
    // The position comes before the deposit card, so a returning writer sees it first.
    expect(html.indexOf(POSITION)).toBeLessThan(html.indexOf('aria-label="Start earning"'));
  });

  it("the saved strategy is found when it sorts past the first 200 of everyone's strategies", () => {
    connect();
    withReads({
      writerBalance: { data: { wallet: 2n * 10n ** 18n, free: 5n * 10n ** 17n, orderBookOperator: false, rollerOperator: true } },
      writerRoll: { data: { strategyActive: true, delegate: true } },
    });
    const underlying = v2Markets().find((row) => row.ticker === "NVDA")!.asset;
    const LAST_ROLLED = MOUNTED_NOW_SECONDS - 3_600;
    const row = (writer: string, lastRolledAt: number | null) => ({
      writer, underlying, ticker: "NVDA",
      strategy: { active: true, weekly: false, smartPricing: false, otmBps: 500, askBps: 100, minAskBps: 50,
        maxAskBps: 200, maxUnits: "0" },
      currentLongId: null, orderId: null, expiry: null, lastRolledAt, lastStaleCancelAt: null, staleSpot: null,
    });
    // 205 other writers whose ids sort before WRITER's, then WRITER's own row: the indexer's /v2/strategies order.
    const rows = [...Array.from({ length: 205 }, (_, index) =>
      row(`0x${(0x1000 + index).toString(16).padStart(40, "0")}`, null)), row(WRITER, LAST_ROLLED)];
    // The mock answers the way the indexer does: `writer` filters, `limit` cuts the page (default 50).
    vi.mocked(useStrategies).mockImplementation(((filters: { writer?: string; limit?: number; active?: boolean } = {}) => ({
      ...emptyQuery,
      data: { items: rows.filter((item) => (filters.writer === undefined || item.writer.toLowerCase() === filters.writer.toLowerCase())
        && (filters.active === undefined || item.strategy.active === filters.active)).slice(0, filters.limit ?? 50), nextCursor: null },
    })) as unknown as typeof useStrategies);
    vi.mocked(useStrategies).mockClear();
    const html = render();
    expect(vi.mocked(useStrategies)).toHaveBeenCalledWith(expect.objectContaining({ writer: WRITER, active: true }));
    expect(html).toContain(`last roll ${renderToStaticMarkup(createElement(Time, { at: LAST_ROLLED }))}`); // <Time>, server render
    expect(html).not.toContain("last roll not recorded");
  });

  it("a call the AutoRoller closed reads closed, not as a pending expiry", () => {
    connect();
    withReads({
      writerBalance: { data: { wallet: 2n * 10n ** 18n, free: 5n * 10n ** 17n, orderBookOperator: true, rollerOperator: true } },
      writerRoll: { data: { strategyActive: true, delegate: true } },
    });
    const underlying = v2Markets().find((row) => row.ticker === "NVDA")!.asset;
    const CLOSED_AT = MOUNTED_NOW_SECONDS - 600;
    const strategy = (lastClose: { at: number; longId: string; orderId: string | null; redeemed: boolean } | null) => ({
      writer: WRITER, underlying, ticker: "NVDA",
      strategy: { active: true, weekly: false, smartPricing: false, otmBps: 500, askBps: 100, minAskBps: 50,
        maxAskBps: 200, maxUnits: "0" },
      // What the indexer serves after PositionClosed: no current position, order or expiry.
      currentLongId: null, orderId: null, expiry: null, lastRolledAt: CLOSED_AT - 86_400, lastStaleCancelAt: null,
      staleSpot: null, lastClose,
    });
    const serve = (lastClose: Parameters<typeof strategy>[0]) => vi.mocked(useStrategies).mockImplementation((() => ({
      ...emptyQuery, data: { items: [strategy(lastClose)], nextCursor: null },
    })) as unknown as typeof useStrategies);
    serve({ at: CLOSED_AT, longId: "7", orderId: null, redeemed: true });
    let html = render();
    expect(html).toContain(`Current call: none, the last one closed on ${renderToStaticMarkup(createElement(Time, { at: CLOSED_AT }))}`);
    expect(html).toContain("Last call closed; the next roll opens a new one");
    expect(html).not.toContain("Next roll after the next expiry");
    // No close recorded (an older indexer): the old copy, unchanged.
    serve(null);
    html = render();
    expect(html).toContain("Current call: none ·");
    expect(html).toContain("Next roll after the next expiry");
    expect(html).not.toContain("the last one closed");
  });

  /*
   * AutoRoller.roll needs both Clearinghouse operator flags (roller AND OrderBook) plus the delegate. A saved
   * strategy on a writer without the OrderBook flag is the state the old wizard left behind: it read "Active" while
   * every keeper roll reverted NotAuthorized. The Auto-roll tile must say so, and the setup must list the missing step.
   */
  it("a saved strategy without the OrderBook operator flag reads Setup incomplete, not Active", () => {
    connect();
    const reads = (orderBookOperator: boolean) => withReads({
      writerBalance: { data: { wallet: 2n * 10n ** 18n, free: 5n * 10n ** 17n, orderBookOperator, rollerOperator: true } },
      writerRoll: { data: { strategyActive: true, delegate: true } },
    });
    const AUTO_ROLL = (value: string) => new RegExp(`>Auto-roll<[^]*?>${value}<`);
    reads(false);
    let html = render();
    expect(html).toMatch(AUTO_ROLL("Setup incomplete"));
    expect(html).not.toMatch(AUTO_ROLL("Active"));
    expect(html).toContain("A permission is missing, so nothing rolls: finish the setup below");
    expect(html).toContain("Allow the order book to use your free collateral when an ask fills");
    expect(html).toContain("Setup, up to five transactions");
    expect(html).toContain(">Finish setup</button>");
    reads(true);
    html = render();
    expect(html).toMatch(AUTO_ROLL("Active"));
    expect(html).not.toContain("Setup incomplete");
    expect(html).toContain(">Update strategy</button>");
  });

  it("an unreadable balance still shows the position card, so Withdraw is never hidden by a failed read", () => {
    connect();
    withReads({ writerBalance: { isError: true } });
    const html = render();
    expect(html).toContain(POSITION);
    expect(html).toContain('id="writer-withdraw"');
    expect(html).toContain("A withdrawal can retry the free-balance check on chain before signing.");
  });

  it("the three ways to sell are tabs: auto-roll by default, the one-call ticket and the swap mounted but hidden", () => {
    const html = render();
    expect(html).not.toContain('data-slot="earn-advanced"');
    expect(html).toContain('role="tablist" aria-label="How to sell"');
    const tabs = [...html.matchAll(/role="tab"[^>]*aria-selected="(true|false)"[^>]*>(?:<span[^>]*>)?([^<]+)</g)].map((m) => [m[2], m[1]]);
    expect(tabs).toEqual([["Auto-roll", "true"], ["Sell once", "false"], ["Get NVDA", "false"]]);
    const panel = (name: string) => {
      const at = html.indexOf(`data-tab="${name}"`);
      expect(at, `the ${name} panel renders`).toBeGreaterThan(-1);
      return html.slice(html.lastIndexOf("<div", at), html.indexOf('role="tabpanel"', at + 1) === -1 ? undefined : html.indexOf('role="tabpanel"', at + 1));
    };
    const auto = panel("auto");
    expect(auto).not.toMatch(/^<div[^>]*hidden/);
    expect(auto).toContain("Daily, +2% OTM");
    expect(auto).toMatch(/>Enable auto-roll<\/button>/);
    expect(auto).toContain('id="auto-roll"');
    expect(auto).toContain("Smart pricing within my limits");
    const customize = auto.slice(auto.indexOf("<details"), auto.indexOf("</details>"));
    expect(customize).toContain('id="auto-roll"');
    expect(customize.match(/<details[^>]*>/)![0]).not.toMatch(/\sopen/);
    expect(panel("once")).toMatch(/^<div[^>]*hidden/);
    expect(panel("once")).toContain('id="manual-ask"');
    expect(panel("swap")).toMatch(/^<div[^>]*hidden/);
    expect(panel("swap")).toContain('id="writer-zap-in"');
  });

  it("puts:false: calls only, with no Calls/Puts switch, no put copy and no put-unavailable notice", () => {
    vi.mocked(useMarkets).mockReturnValue({ ...emptyQuery, data: [liveMarket(false)] } as unknown as ReturnType<typeof useMarkets>);
    const html = render();
    expect(html).not.toContain("Option type to write");
    expect(html).not.toContain(">Puts</button>");
    expect(html).not.toContain("Put writing is unavailable");
    expect(html).not.toMatch(/cash-secured|put ask|sold puts/i);
    expect(html).toContain("Sell calls automatically");
  });

  it("puts:true: the Calls/Puts switch is back, calls selected by default", () => {
    vi.mocked(useMarkets).mockReturnValue({ ...emptyQuery, data: [liveMarket(true)] } as unknown as ReturnType<typeof useMarkets>);
    const html = render();
    expect(html).toContain('aria-label="Option type to write"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Calls<\/button>/);
    expect(html).toContain(">Puts</button>");
    expect(html).toContain("Sell calls automatically");
  });
});

/*
 * The plan's max size defaults to ALL FREE TOKENS, not 0.01. Blank is the page's
 * "all free collateral" (it saves maxUnits 0, and AutoRoller caps only when maxUnits != 0). The one-off "Size in
 * shares" order field is a different setting and keeps its 0.01 default.
 */
describe("a new plan's max size is all free tokens", () => {
  const render = () => renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
  const field = (html: string, id: string) => {
    const at = html.indexOf(`id="${id}"`);
    expect(at, `the #${id} field renders`).toBeGreaterThan(-1);
    const open = html.lastIndexOf("<input", at);
    return html.slice(open, html.indexOf(">", at) + 1);
  };

  it("the Max size field starts blank, and says blank is all free tokens", () => {
    const html = render();
    const maxSize = field(html, "roll-max");
    expect(maxSize).toContain('value=""');
    expect(maxSize).not.toContain('value="0.01"');
    expect(maxSize).toContain('placeholder="All free"');
    expect(html).toContain("Blank means all free collateral.");
    expect(html).toContain("using all your free tokens");
    expect(html).not.toContain("up to 0.01 shares");
  });

  it("the one-off order's Size in shares keeps its 0.01 default", () => {
    expect(field(render(), "ask-size")).toContain('value="0.01"');
  });

  it("a preset keeps the plan's own max size and never copies the one-off size into it", () => {
    const source = readFileSync(fileURLToPath(new URL("./EarnMarket.tsx", import.meta.url)), "utf8");
    const start = source.indexOf("async function applyPreset(");
    const end = source.indexOf("async function fillProposedBand(");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const applyPreset = source.slice(start, end);
    expect(applyPreset).not.toContain("setMaxShares(");
    expect(applyPreset).not.toContain("units ?? 1n");
    expect(applyPreset).toContain("strategySize");
  });
});

describe("Portfolio smart-pricing edit handoff", () => {
  it("accepts only the explicit edit request", () => {
    expect(portfolioStrategyEditRequested("?edit=smart-pricing")).toBe(true);
    expect(portfolioStrategyEditRequested("?edit=manual")).toBe(false);
    expect(portfolioStrategyEditRequested("?smart-pricing=1")).toBe(false);
  });

  it("loads the exact writer/underlying strategy into the guarded on-chain update path", () => {
    const source = readFileSync(fileURLToPath(new URL("./EarnMarket.tsx", import.meta.url)), "utf8");
    expect(source).toContain("row.writer.toLowerCase() === address.toLowerCase()");
    expect(source).toContain("row.underlying.toLowerCase() === underlying.toLowerCase()");
    expect(source).toContain("setStrategyForm(indexedStrategy.strategy)");
    expect(source).toContain("if (strategyError || !strategyToSave)");
    expect(source).toContain("const writeState = pricingWriteState(requested");
    expect(source).toContain("await setStrategy(ctx, underlying, strategyToSave)");
    expect(source).toContain("nothing changes on chain until Update strategy passes the current checks and you sign");
  });
});

// The pagination and arithmetic are exercised by historySummary.test.ts; this
// binding check protects the writer page from drifting back to a local copy.
describe("writer premium history binding", () => {
  it("uses the shared lifetime calculation and keeps the partial-history label", () => {
    const source = readFileSync(fileURLToPath(new URL("./EarnMarket.tsx", import.meta.url)), "utf8");
    expect(source).toContain('import { lifetimePremium } from "@/lib/v2/historySummary"');
    expect(source).toContain("queryFn: ({ signal }) => lifetimePremium(address!, ticker, signal)");
    expect(source).toContain('earned.data.complete ? "Lifetime premium" : "Premium in loaded history"');
    expect(source).not.toContain("async function lifetimePremium(");
  });
});

/**
 * The smart-pricing control is offered only while the pricer is alive.
 *
 * THESE RENDER THE PAGE rather than only asserting the pure helper. The helper has its own tests
 * in smartPricing.test.ts; what those cannot show is that the component actually CONSULTS it —
 * a correct decision function that nothing calls is the same bug with better unit coverage. So
 * the assertions below are on the rendered markup: the checkbox carries `disabled`, and the note
 * is in the HTML.
 */
describe("smart pricing is not offered while the pricer is down", () => {
  const SMART_LABEL = "Smart pricing within my limits";
  // The component's clock is the mocked useNow(), so readings are dated against it, not the host clock.
  const NOW_SECONDS = MOUNTED_NOW_SECONDS;

  /** Drive the /v2/services query specifically; every other useQuery keeps the empty default. */
  function withServices(result: Record<string, unknown>) {
    vi.mocked(useQuery).mockImplementation(((options: { queryKey?: unknown }) => {
      const key = options?.queryKey;
      return Array.isArray(key) && key[0] === "v2" && key[1] === "services"
        ? { ...emptyQuery, ...result } : emptyQuery;
    }) as never);
  }

  /** The `<input>` immediately before the smart-pricing label text. */
  function smartPricingInput(html: string): string {
    const at = html.indexOf(SMART_LABEL);
    expect(at, "the smart-pricing control is on the page at all").toBeGreaterThan(-1);
    const before = html.slice(0, at);
    const open = before.lastIndexOf("<input");
    expect(open, "an <input> precedes the label").toBeGreaterThan(-1);
    return before.slice(open, before.indexOf(">", open) + 1);
  }

  const reading = (over: Record<string, unknown> = {}) => ({
    data: { pricer: { healthy: true, reason: "ready", reasons: [], checkedAt: NOW_SECONDS, lastEvaluationAt: NOW_SECONDS, ...over } },
  });

  it("healthy pricer: the control is selectable and no note is shown", () => {
    withServices(reading());
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(smartPricingInput(html)).not.toContain("disabled");
    expect(html).not.toContain(SMART_PRICING_PRICER_DOWN);
    expect(html).not.toContain(SMART_PRICING_PRICER_UNKNOWN);
  });

  it("pricer says not ready: the control is DISABLED, not merely warned about", () => {
    // A warning the user can click past is the failure this guard exists to remove, so the
    // assertion is on `disabled` and not on the presence of a message.
    withServices(reading({ healthy: false, reason: "not_ready", reasons: ["role-refused"] }));
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(smartPricingInput(html)).toContain("disabled");
    expect(html).toContain(SMART_PRICING_PRICER_DOWN);
  });

  it("the health read has not answered yet: disabled, because not knowing is not healthy", () => {
    // The default state of the page on first paint.
    withServices({ data: undefined, isPending: true });
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(smartPricingInput(html)).toContain("disabled");
    expect(html).toContain(SMART_PRICING_PRICER_UNKNOWN);
  });

  it("the health read FAILED: disabled, because a broken probe is not a healthy pricer", () => {
    // The defect class that keeps recurring: a check that cannot see its subject
    // reading as green. If this one ever goes green with the control enabled, that is the bug.
    withServices({ data: undefined, isError: true });
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(smartPricingInput(html)).toContain("disabled");
    expect(html).toContain(SMART_PRICING_PRICER_UNKNOWN);
  });

  it("the indexer answered but omitted the pricer field entirely: still disabled", () => {
    // An indexer older than the /v2/services route, or a proxy stripping the body.
    withServices({ data: {} });
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(smartPricingInput(html)).toContain("disabled");
    expect(html).toContain(SMART_PRICING_PRICER_UNKNOWN);
  });

  it("a stale reading is not a current one", () => {
    withServices(reading({ checkedAt: NOW_SECONDS - PRICER_READING_MAX_AGE_SECONDS - 60 }));
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(smartPricingInput(html)).toContain("disabled");
  });

  it("the offer re-evaluates as the clock advances, with nothing else changing", () => {
    // The reading is fresh at t and past PRICER_READING_MAX_AGE_SECONDS one bound later. Only the clock moves
    // between the two renders, so the second answer can only come from the clock being read again.
    withServices(reading());
    vi.mocked(useNow).mockReturnValue(NOW_SECONDS);
    const fresh = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(smartPricingInput(fresh)).not.toContain("disabled");

    vi.mocked(useNow).mockReturnValue(NOW_SECONDS + PRICER_READING_MAX_AGE_SECONDS + 1);
    const later = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(smartPricingInput(later)).toContain("disabled");
    expect(later).toContain(SMART_PRICING_PRICER_UNKNOWN);
  });

  it("before mount (useNow() === 0) even a healthy reading is not offered", () => {
    // smartPricingOffer(reading, 0) would see a negative age and offer the control; the page must not.
    withServices(reading());
    vi.mocked(useNow).mockReturnValue(0);
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(smartPricingInput(html)).toContain("disabled");
    expect(html).toContain(SMART_PRICING_PRICER_UNKNOWN);
  });

  it("the note names what still works, so the page does not read as a dead end", () => {
    // In the copy: the standing order is untouched by this gate and the user is told so.
    withServices(reading({ healthy: false, reason: "not_ready", reasons: ["loop-wedged"] }));
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(html).toContain("fixed ask");
    expect(html).toContain("stays live");
  });
});

/**
 * The trade spot is only used once the clock has mounted. EarnMarket passes selectTradeSpot a
 * chainFailedOrFetching of true, so on the indexer path its clock argument decides nothing (marketSpot.ts returns
 * the indexer spot before reading it); what the clock does decide is the pre-mount frame, where no spot is used.
 * The "Live spot is required" error is the observable: absent once mounted (the positive control), present at 0.
 */
describe("the trade spot fails closed before mount", () => {
  const SPOT_REQUIRED = "Live spot is required to convert USDG prices to contract bps.";
  const market = {
    ticker: "NVDA", underlying: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", status: "live", puts: false,
    spot: { raw: "200000000", decimals: 6, formatted: "200" },
    strikeTick: { raw: "1000000", decimals: 6, formatted: "1" },
    expiries: [MOUNTED_NOW_SECONDS + 86_400],
  };

  beforeEach(() => {
    vi.mocked(useMarkets).mockReturnValue({ ...emptyQuery, data: [market] } as unknown as ReturnType<typeof useMarkets>);
  });

  it("mounted: the indexer spot is used, so the spot-required error is not shown", () => {
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(html).not.toContain(SPOT_REQUIRED);
  });

  it("before mount (useNow() === 0): no spot is used", () => {
    vi.mocked(useNow).mockReturnValue(0);
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(html).toContain(SPOT_REQUIRED);
  });
});

/**
 * tier1.json fills `v2.contracts.stockZap`, so the Zap panel is live. Its indexer cross-check is the
 * Zap-only `v2StockZapMismatch` (lib/v2/config.ts), never the `mismatch` array that pauses every write: a StockZap
 * the indexer contradicts turns the two Zap buttons off and says why, and nothing else.
 */
describe("the Zap buttons follow their own check", () => {
  const ZAP_OTHER = "0x3333333333333333333333333333333333333333";

  it("with the registry's StockZap and no indexer disagreement, both buttons offer Zap (not 'not configured')", () => {
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(html).toMatch(/>Zap in<\/button>/);
    expect(html).toMatch(/>Exit zap<\/button>/);
    expect(html).not.toContain("Zap not configured");
    expect(html).not.toContain("Zap is paused");
  });

  it("an indexer that publishes a different StockZap pauses only Zap, with the reason shown", async () => {
    const { configResponseSchema } = await import("@/lib/v2/api-schema");
    const fixture = configResponseSchema.parse((await import("../../../ops/fixtures/api/v2/config.json")).default);
    const data = { ...fixture, contracts: { ...fixture.contracts, stockZap: ZAP_OTHER } };
    vi.mocked(useConfig).mockReturnValue({ ...emptyQuery, data } as unknown as ReturnType<typeof useConfig>);
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(html.match(/>Zap paused<\/button>/g)).toHaveLength(2);
    expect(html).toContain(`Zap is paused: the indexer publishes StockZap ${ZAP_OTHER}`);
    expect(html).not.toMatch(/>Zap in<\/button>/);
  });
});

/*
 * The series page is oldest-first and capped at 200, and the ladder keeps only open rows. Unfiltered,
 * a market with more than 200 series of one type filled the page with expired and settled rows and the strike list
 * went empty. The filter is the indexer's `status=open`, which the V2Clock tick keeps current.
 * PROVE BY BREAKING: drop `status: "open"` from the useMarketSeries call in EarnMarket.tsx and this goes red.
 */
describe("the strike ladder reads open series only", () => {
  it("asks the indexer for OPEN series of the active type", () => {
    renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(vi.mocked(useMarketSeries)).toHaveBeenCalledWith("NVDA", { type: "call", status: "open", limit: 200 });
  });
});

/*
 * Clearinghouse.deposit has no pause of its own, so while the chain says the whole deployment is paused
 * (trading AND every market's mint) the writer's Deposit button closes with one note; Withdraw is not touched. The
 * button is also disabled by its empty amount input in a static render, so the gate is proven through `depositDoor`
 * (lib/v2/upgradePause.test.ts), the rendered note and the wiring below.
 */
import { UPGRADE_PAUSE_NOTE } from "@/lib/v2/upgradePause";

describe("the writer's ledger deposit closes while the deployment is paused for an upgrade", () => {
  const WRITER = "0x00000000000000000000000000000000000000a1";
  const connect = () => {
    vi.mocked(useAccount).mockReturnValue({ address: WRITER } as unknown as ReturnType<typeof useAccount>);
    vi.mocked(useWalletClient).mockReturnValue({ data: {} } as unknown as ReturnType<typeof useWalletClient>);
  };
  const markets = (tradingPaused: boolean, mintPaused: boolean) => vi.mocked(useMarkets).mockReturnValue({
    ...emptyQuery,
    data: [{ ticker: "NVDA", underlying: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", status: "live", puts: false,
      spot: { raw: "200000000", decimals: 6, formatted: "200" }, strikeTick: { raw: "1000000", decimals: 6, formatted: "1" },
      expiries: [MOUNTED_NOW_SECONDS + 86_400], tradingPaused, mintPaused }],
  } as unknown as ReturnType<typeof useMarkets>);
  const render = () => renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));

  it("paused: the Deposit step says it is paused for upgrade, above the Deposit button", () => {
    connect();
    markets(true, true);
    const html = render();
    expect(html).toContain('data-slot="upgrade-paused"');
    expect(html).toContain(UPGRADE_PAUSE_NOTE);
    expect(html.indexOf('data-slot="upgrade-paused"')).toBeLessThan(html.indexOf(">Deposit</button>"));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Deposit<\/button>/);
  });

  it("unpaused, or only the mint or only trading paused: no note", () => {
    connect();
    for (const [trading, mint] of [[false, false], [true, false], [false, true]] as const) {
      markets(trading, mint);
      const html = render();
      expect(html).not.toContain('data-slot="upgrade-paused"');
      expect(html).not.toContain(UPGRADE_PAUSE_NOTE);
    }
  });

  it("the Deposit button and the deposit action both read the door; Withdraw does not", () => {
    const source = readFileSync(fileURLToPath(new URL("./EarnMarket.tsx", import.meta.url)), "utf8");
    expect(source).toContain("const ledgerDeposit = depositDoor(canWrite, markets.isError ? null : markets.data);");
    expect(source).toContain('disabled={!ledgerDeposit.open || !balance.data || !!busy || !parsePositiveAsset(depositAmount, collateralDecimals)} onClick={() => void moveBalance("deposit")}>Deposit</Button>');
    expect(source).toContain('if (direction === "deposit" && ledgerDeposit.note) throw new Error(ledgerDeposit.note);');
    const withdraw = source.slice(source.indexOf('onClick={() => void moveBalance("withdraw")}') - 300, source.indexOf('onClick={() => void moveBalance("withdraw")}'));
    expect(withdraw).not.toContain("ledgerDeposit");
  });
});

/*
 * The auto-roll step shows AutoRoller.previewRoll for this wallet and underlying before the setup
 * transactions: what the next roll would place, "no roll now" when it is not due, and "cannot preview" on a
 * revert, never a local quote. Rendered with the roll-preview query answered; removing the paragraph turns these red.
 */
import { CANNOT_PREVIEW, formatRollPreview } from "@/lib/v2/moneyPreviews";

describe("the auto-roll step shows previewRoll before the setup transactions", () => {
  const WRITER = "0x00000000000000000000000000000000000000b2";
  const connect = () => {
    vi.mocked(useAccount).mockReturnValue({ address: WRITER } as unknown as ReturnType<typeof useAccount>);
    vi.mocked(useWalletClient).mockReturnValue({ data: {} } as unknown as ReturnType<typeof useWalletClient>);
  };
  const roll = (answer: Record<string, unknown>) => vi.mocked(useQuery).mockImplementation(((options: { queryKey?: unknown }) => {
    const key = options?.queryKey;
    return Array.isArray(key) && key[0] === "v2" && key[1] === "roll-preview" ? { ...emptyQuery, ...answer } : emptyQuery;
  }) as never);
  const render = () => renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
  const line = (html: string) => html.match(/<p data-slot="roll-preview"[^>]*>([^<]*)<\/p>/)?.[1] ?? null;

  it("due: the strike, expiry, ask and size the contract would place, above the setup steps", () => {
    connect();
    const due = { ok: true as const, due: true, strike: 210_000_000n, expiry: 1_790_366_400, price: 1_250_000n, units: 150n };
    roll({ data: due });
    const html = render();
    expect(html).not.toContain("AutoRoller is not deployed in this build.");
    expect(line(html)).toBe(formatRollPreview(due));
    expect(line(html)).toBe("The next roll would write 1.5 shares at strike 210 USDG, expiry Fri 25 Sep, 4:00pm EDT, ask 1.25 USDG.");
    expect(html.indexOf('data-slot="roll-preview"')).toBeLessThan(html.indexOf("Setup, up to five transactions"));
  });

  it("not due, pending, or reverted: says so and shows no number", () => {
    connect();
    roll({ data: { ok: true, due: false, strike: 0n, expiry: 0, price: 0n, units: 0n } });
    expect(line(render())).toBe("No new roll would be placed now.");
    roll({ isPending: true });
    expect(line(render())).toBe("Checking what the next roll would place…");
    roll({ data: { ok: false } });
    const html = render();
    expect(line(html)).toBe(CANNOT_PREVIEW);
    expect(html).not.toContain("The next roll would write");
  });

  it("no wallet: nothing to preview, so no line", () => {
    roll({ data: { ok: true, due: true, strike: 1n, expiry: 1, price: 1n, units: 1n } });
    expect(render()).not.toContain('data-slot="roll-preview"');
  });
});
