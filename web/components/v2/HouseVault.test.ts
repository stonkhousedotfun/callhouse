import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useQueryClient } from "@tanstack/react-query";
import { useAccount, useWalletClient } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import type { HouseMarketResponse } from "@/lib/v2/api-types";
import { HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS } from "@/lib/v2/houseCopy";
import { useHouseMarket } from "@/lib/v2/hooks";
import { HouseVault } from "./HouseVault";

/**
 * React escapes text when it renders, so an approved copy string containing an apostrophe never appears
 * verbatim in the markup: `'` arrives as `&#x27;`. Asserting on the raw constant therefore fails against a
 * component that is displaying exactly the right words. The constant stays the source of truth and this
 * escapes it the way the renderer does, rather than retyping the sentence in its escaped form.
 */
const asRendered = (copy: string) =>
  copy.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");


// `useQuery` is what HouseArmNotice (LaunchCountdown.tsx) reads the launch gates with; pending here, so the
// arming notice renders its "checking on chain" line and never a countdown the test did not set up.
vi.mock("@tanstack/react-query", () => ({ useQueryClient: vi.fn(), useQuery: () => ({ data: undefined, isError: false }) }));
vi.mock("wagmi", () => ({ useAccount: vi.fn(), useWalletClient: vi.fn() }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => createElement("button", null, "Connect wallet") }));
vi.mock("@/components/TxToast", () => ({ useNotice: vi.fn(), useV2ReceiptNotice: vi.fn() }));
vi.mock("@/lib/markets", () => ({ v2Markets: () => [{ ticker: "NVDA", asset: "0x0000000000000000000000000000000000000011" }] }));
vi.mock("@/lib/v2/hooks", () => ({
  useHouseMarket: vi.fn(), v2Keys: { houseMarket: (ticker: string, address?: string) => ["v2", "house", ticker, address] },
}));

const account = "0x0000000000000000000000000000000000000044" as const;
// Typed as the wire response so tsc still checks this fixture's shape: the query-result mocks below
// must cast through `unknown` (a two-field object never overlaps the UseQueryResult union), and that
// cast would otherwise hide a fixture the strict house schema would reject.
const market = (end: number | null): HouseMarketResponse => ({
  market: "NVDA",
  vault: "0x0000000000000000000000000000000000000066",
  currentEpoch: { id: "12", start: 1_760_000_000, end, nav: null, resultUsdg: null },
  epochs: [],
  shares: { address: account, shares: "0", queued: [] },
  queue: [],
});

beforeEach(() => {
  vi.mocked(useAccount).mockReturnValue({ address: account } as unknown as ReturnType<typeof useAccount>);
  vi.mocked(useWalletClient).mockReturnValue({ data: {} } as unknown as ReturnType<typeof useWalletClient>);
  vi.mocked(useQueryClient).mockReturnValue({ invalidateQueries: vi.fn() } as unknown as ReturnType<typeof useQueryClient>);
  vi.mocked(useNotice).mockReturnValue(vi.fn() as ReturnType<typeof useNotice>);
  vi.mocked(useV2ReceiptNotice).mockReturnValue(vi.fn() as ReturnType<typeof useV2ReceiptNotice>);
  vi.mocked(useHouseMarket).mockReturnValue({ data: market(1_760_604_800), isError: false } as unknown as ReturnType<typeof useHouseMarket>);
});

describe("HouseVault withdrawal terms", () => {
  it("places the exact weekly in-kind terms above both deposit confirmations", () => {
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain(asRendered(HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS));
    expect(html).toContain('aria-label="Withdrawal terms"');
    expect(html).toContain("Next boundary");

    const deposit = html.indexOf('aria-label="Deposit"');
    const terms = html.indexOf('aria-label="Withdrawal terms"', deposit);
    const usdg = html.indexOf("Queue USDG deposit", deposit);
    const stock = html.indexOf("Queue Stock Token deposit", deposit);
    expect(terms).toBeGreaterThan(deposit);
    expect(usdg).toBeGreaterThan(terms);
    expect(stock).toBeGreaterThan(terms);
  });

  // T-404 epoch 3. A holder asking for their money back needs the boundary rule as much as a depositor
  // does, and "Withdrawal queued until the next boundary" arrives in the toast AFTER the button is pressed.
  it("places the same terms above the withdrawal request button", () => {
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    const withdraw = html.indexOf('aria-label="Withdraw"');
    expect(withdraw).toBeGreaterThan(-1);
    const terms = html.indexOf('aria-label="Withdrawal terms"', withdraw);
    const request = html.indexOf("Request withdrawal", withdraw);
    expect(terms).toBeGreaterThan(withdraw);
    expect(request).toBeGreaterThan(terms);
    // Both panels carry it, so this cannot pass on the deposit panel's copy alone.
    expect(html.split('aria-label="Withdrawal terms"').length - 1).toBe(2);
  });

  it("renders unavailable timing instead of crashing when the API has no current boundary", () => {
    vi.mocked(useHouseMarket).mockReturnValue({ data: market(null), isError: false } as unknown as ReturnType<typeof useHouseMarket>);
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain("Boundary timing is unavailable");
    expect(html).toContain("Epoch figures are unavailable");
  });
});

describe("HouseVault queued requests", () => {
  it("renders a stock-only queued deposit in Stock Token units", () => {
    const data = market(1_760_604_800);
    data.shares!.queued = [{
      kind: "deposit",
      account,
      assets: "0",
      stockAmount: "2000000000000000000",
      shares: null,
      requestedAt: 1_760_000_190,
    }];
    vi.mocked(useHouseMarket).mockReturnValue({ data, isError: false } as unknown as ReturnType<typeof useHouseMarket>);

    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html, "the queued row must name the nonzero stock leg").toContain("Queued deposit: 2 Stock Tokens");
    expect(html, "the observed zero USDG leg must not replace the stock leg").not.toContain("Queued deposit: 0");
    expect(html, "Stock Token base units must be formatted at 18 decimals").not.toContain("2000000000000000000");
  });

  it("formats a USDG-only deposit at six decimals without adding a zero stock clause", () => {
    const data = market(1_760_604_800);
    data.shares!.queued = [{
      kind: "deposit",
      account,
      assets: "500",
      stockAmount: "0",
      shares: null,
      requestedAt: 1_760_000_200,
    }];
    vi.mocked(useHouseMarket).mockReturnValue({ data, isError: false } as unknown as ReturnType<typeof useHouseMarket>);

    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain("Queued deposit: 0.0005 USDG, requested at 1760000200.");
    expect(html).not.toContain("0 Stock Tokens");
  });

  it("keeps null deposit legs absent from a withdrawal row", () => {
    const data = market(1_760_604_800);
    data.shares!.queued = [{
      kind: "withdraw",
      account,
      assets: null,
      stockAmount: null,
      shares: "42",
      requestedAt: 1_760_000_210,
    }];
    vi.mocked(useHouseMarket).mockReturnValue({ data, isError: false } as unknown as ReturnType<typeof useHouseMarket>);

    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain("Queued withdraw: 42 shares, requested at 1760000210.");
    expect(html).not.toContain("Queued withdraw: 0");
    expect(html).not.toMatch(/Queued withdraw: .*?(USDG|Stock Tokens)/);
  });
});
