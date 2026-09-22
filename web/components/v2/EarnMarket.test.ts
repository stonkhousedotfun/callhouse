import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount, useWalletClient } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { useNow } from "@/lib/hooks";
import { useAllMarketSeries, useConfig, useFair, useMarketSeries, useMarkets, usePositions, useStrategies } from "@/lib/v2/hooks";
import { EarnMarket, portfolioStrategyEditRequested, stageAfterEarnAction } from "./EarnMarket";
import { PRICER_READING_MAX_AGE_SECONDS, SMART_PRICING_PRICER_DOWN,
  SMART_PRICING_PRICER_UNKNOWN } from "@/lib/v2/smartPricing";

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn(), useQueryClient: vi.fn() }));
vi.mock("wagmi", () => ({ useAccount: vi.fn(), useWalletClient: vi.fn() }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => createElement("button", null, "Connect wallet") }));
vi.mock("@/components/TxToast", () => ({ useNotice: vi.fn(), useV2ReceiptNotice: vi.fn() }));
vi.mock("@/components/v2/PendingOperationsNotice", () => ({ PendingOperationsNotice: () => null }));
// T-467. EarnMarket reads its render-time clock from useNow(), which only ticks inside an effect, and
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

describe("Earn writer stages", () => {
  it("starts with Deposit, keeps the other sections reachable, and offers an expert shortcut", () => {
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(html).toContain('aria-label="Earn flow"');
    expect(html).toContain('aria-controls="earn-stage-automate"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("Optional · skip ahead anytime");
    expect(html).toMatch(/id="earn-stage-deposit" class="block"/);
    expect(html).toMatch(/id="earn-stage-ask" class="hidden"/);
    expect(html).toMatch(/id="earn-stage-automate" class="hidden"/);
    expect(html).toContain('id="writer-deposit"');
    expect(html).toContain('id="manual-ask"');
    expect(html).toContain('id="auto-roll"');
    expect(html).toContain('aria-label="Writer balance"');
    expect(html).toContain('aria-label="Manual ask"');
    expect(html).toContain('aria-label="Auto-roll strategy"');
    expect(html).toContain("Connect wallet");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Withdrawal terms"');
    expect(html).toContain("Free now");
    expect(html).toContain("Locked in shorts");

    const source = readFileSync(fileURLToPath(new URL("./EarnMarket.tsx", import.meta.url)), "utf8");
    const terms = source.indexOf('<WithdrawalTerms className="mt-3" surface="writer"');
    const confirm = source.indexOf('onClick={() => void moveBalance("deposit")}');
    expect(terms).toBeGreaterThan(-1);
    expect(confirm).toBeGreaterThan(terms);
  });

  it("advances only after confirmed deposit and ask actions; put asks do not expose automation", () => {
    expect(stageAfterEarnAction("deposit", "deposit", false)).toBe("ask");
    expect(stageAfterEarnAction("ask", "ask", false)).toBe("automate");
    expect(stageAfterEarnAction("ask", "ask", true)).toBe("ask");
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
 * W3-301: the smart-pricing control is offered only while the pricer is alive.
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
    // AC3. A warning the user can click past is the failure this row exists to remove, so the
    // assertion is on `disabled` and not on the presence of a message.
    withServices(reading({ healthy: false, reason: "not_ready", reasons: ["role-refused"] }));
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(smartPricingInput(html)).toContain("disabled");
    expect(html).toContain(SMART_PRICING_PRICER_DOWN);
  });

  it("the health read has not answered yet: disabled, because not knowing is not healthy", () => {
    // AC4, and the default state of the page on first paint.
    withServices({ data: undefined, isPending: true });
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(smartPricingInput(html)).toContain("disabled");
    expect(html).toContain(SMART_PRICING_PRICER_UNKNOWN);
  });

  it("the health read FAILED: disabled, because a broken probe is not a healthy pricer", () => {
    // AC4, and the defect class this board keeps hitting: a check that cannot see its subject
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

  it("T-467: the offer re-evaluates as the clock advances, with nothing else changing", () => {
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

  it("T-467: before mount (useNow() === 0) even a healthy reading is not offered", () => {
    // smartPricingOffer(reading, 0) would see a negative age and offer the control; the page must not.
    withServices(reading());
    vi.mocked(useNow).mockReturnValue(0);
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(smartPricingInput(html)).toContain("disabled");
    expect(html).toContain(SMART_PRICING_PRICER_UNKNOWN);
  });

  it("the note names what still works, so the page does not read as a dead end", () => {
    // AC5 in the copy: the standing order is untouched by this row and the user is told so.
    withServices(reading({ healthy: false, reason: "not_ready", reasons: ["loop-wedged"] }));
    const html = renderToStaticMarkup(createElement(EarnMarket, { ticker: "NVDA" }));
    expect(html).toContain("fixed ask");
    expect(html).toContain("stays live");
  });
});

/**
 * T-467. The trade spot is only used once the clock has mounted. EarnMarket passes selectTradeSpot a
 * chainFailedOrFetching of true, so on the indexer path its clock argument decides nothing (marketSpot.ts returns
 * the indexer spot before reading it); what the clock does decide is the pre-mount frame, where no spot is used.
 * The "Live spot is required" error is the observable: absent once mounted (the positive control), present at 0.
 */
describe("T-467: the trade spot fails closed before mount", () => {
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
