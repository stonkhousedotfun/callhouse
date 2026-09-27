import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useWalletClient } from "wagmi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import type { HouseMarketResponse } from "@/lib/v2/api-types";
import {
  HOUSE_DEPOSIT_NOW_LABEL, HOUSE_DEPOSIT_QUEUE_LABEL, HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS, HOUSE_INSTANT_DEPOSIT_RULE,
  housePerformanceFeeOwedLine,
} from "@/lib/v2/houseCopy";
import { useConfig, useHouse, useHouseMarket, useHouseVaultReads, useSplitterReads } from "@/lib/v2/hooks";
import { SHARE_DECIMALS, USDG_DECIMALS } from "@/lib/v2/houseEpoch";
import { parseHouseWithdrawShares } from "@/lib/v2/houseTx";
import { HOUSE_WIND_DOWN_DETAIL, HOUSE_WIND_DOWN_UNREAD, houseWindDownHeadline } from "@/lib/v2/houseWindDown";
import { HOUSE_SIBLING_CLOSED, HOUSE_VAULT_MISMATCH, houseVaultUnavailable } from "@/lib/v2/houseVaultSelect";
import type { HouseVaultReads } from "@/lib/v2/chainReads";
import { HOUSE_DISCLOSURE_DAILY_WITHDRAWALS, HOUSE_DISCLOSURE_FRIDAYS_ONLY_WITHDRAWALS, HOUSE_DISCLOSURE_UNKNOWN_WITHDRAWALS, houseLede } from "@/lib/v2/houseCopy";
import { NO_HISTORY } from "@/lib/v2/vaultCopy";
import { Time } from "@/components/ui/Time";
import { houseDepositsOpen } from "@/lib/v2/launchGates";
import { houseClaimLine } from "@/lib/v2/houseClaim";
import {
  HOUSE_DEPOSIT_CANCEL_CLOSED, HOUSE_DEPOSIT_PRICED, HOUSE_DEPOSIT_TO_CLAIM, HOUSE_DEPOSITS_CLOSED, HOUSE_WITHDRAWAL_PRICED,
  HOUSE_WITHDRAWAL_TO_CLAIM,
} from "@/lib/v2/houseGates";
import { HOUSE_ARMING_UNREAD, houseNotQuoting } from "./LaunchCountdown";
import { HouseVault, houseArming, houseDepositAllowed } from "./HouseVault";

/**
 * React escapes text when it renders, so an approved copy string containing an apostrophe never appears
 * verbatim in the markup: `'` arrives as `&#x27;`. Asserting on the raw constant therefore fails against a
 * component that is displaying exactly the right words. The constant stays the source of truth and this
 * escapes it the way the renderer does, rather than retyping the sentence in its escaped form.
 */
const asRendered = (copy: string) =>
  copy.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");


// `useQuery` is stubbed pending for anything on the page that still reads through React Query directly. The House
// arming itself comes from useHouseVaultReads, mocked below per test.
vi.mock("@tanstack/react-query", () => ({ useQueryClient: vi.fn(), useQuery: vi.fn(() => ({ data: undefined, isError: false })) }));
vi.mock("wagmi", () => ({ useAccount: vi.fn(), useWalletClient: vi.fn() }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => createElement("button", null, "Connect wallet") }));
vi.mock("@/components/TxToast", () => ({ useNotice: vi.fn(), useV2ReceiptNotice: vi.fn() }));
// SPCX carries its registry override (tier1.json: Friday closes, no dailies). NVDA has no v2
// block here, which the page reads as the registry default (dailies listed).
vi.mock("@/lib/markets", () => ({ v2Markets: () => [{ ticker: "NVDA", asset: "0x0000000000000000000000000000000000000011" },
  { ticker: "SPCX", asset: "0x0000000000000000000000000000000000000012", v2: { overrides: { expiriesAhead: { weekly: 2, daily: 0 } } } }] }));
vi.mock("@/lib/v2/hooks", () => ({
  useHouse: vi.fn(), useHouseMarket: vi.fn(), useHouseVaultReads: vi.fn(), useSplitterReads: vi.fn(), useConfig: vi.fn(),
  // The guardian brakes; unread by default: not a pause, but the deposit door stays shut until it answers.
  useMarkets: vi.fn(() => ({ data: undefined, isError: false })),
  // The real key takes the requested vault as a third argument; the mock mirrors that signature.
  v2Keys: { houseMarket: (ticker: string, address?: string, vault?: string) => ["v2", "house", ticker, address, vault] },
}));

const account = "0x0000000000000000000000000000000000000044" as const;
// Typed as the wire response so tsc still checks this fixture's shape: the query-result mocks below
// must cast through `unknown` (a two-field object never overlaps the UseQueryResult union), and that
// cast would otherwise hide a fixture the strict house schema would reject.
// `kind` is the API's (the launch vaults are weekly by their factory); the page's cadence follows it.
const market = (end: number | null, kind: HouseMarketResponse["kind"] = "weekly"): HouseMarketResponse => ({
  market: "NVDA",
  vault: "0x0000000000000000000000000000000000000066",
  kind,
  currentEpoch: { id: "12", start: 1_760_000_000, end, nav: null, resultUsdg: null },
  epochs: [],
  shares: { address: account, shares: "0", queued: [] },
  queue: [],
});

beforeEach(() => {
  // The deposit-route query is pending unless a test answers for the vault.
  vi.mocked(useQuery).mockReturnValue({ data: undefined, isError: false } as unknown as ReturnType<typeof useQuery>);
  vi.mocked(useAccount).mockReturnValue({ address: account } as unknown as ReturnType<typeof useAccount>);
  vi.mocked(useWalletClient).mockReturnValue({ data: {} } as unknown as ReturnType<typeof useWalletClient>);
  vi.mocked(useQueryClient).mockReturnValue({ invalidateQueries: vi.fn() } as unknown as ReturnType<typeof useQueryClient>);
  vi.mocked(useNotice).mockReturnValue(vi.fn() as ReturnType<typeof useNotice>);
  vi.mocked(useV2ReceiptNotice).mockReturnValue(vi.fn() as ReturnType<typeof useV2ReceiptNotice>);
  vi.mocked(useHouseMarket).mockReturnValue({ data: market(1_760_604_800), isError: false } as unknown as ReturnType<typeof useHouseMarket>);
  // Chain reads pending by default: every block must render its own "not read" state, never a 0.
  vi.mocked(useHouseVaultReads).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useHouseVaultReads>);
  vi.mocked(useSplitterReads).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useSplitterReads>);
  vi.mocked(useConfig).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useConfig>);
  // The /v2/house list at launch: the two weekly vaults and no daily one, so nothing is winding down.
  vi.mocked(useHouse).mockReturnValue(houseList(["weekly", "weekly"]));
});

/** A /v2/house list result carrying vaults of these kinds (reads only the kinds). */
function houseList(kinds: Array<"weekly" | "daily" | "unknown">, isError = false): ReturnType<typeof useHouse> {
  const items = kinds.map((kind, i) => ({ market: i % 2 ? "SPCX" : "NVDA", vault: `0x${(0x70 + i).toString(16).padStart(40, "0")}`, kind,
    currentEpoch: null, sharesSupply: null }));
  return { data: isError ? undefined : { items, nextCursor: null }, isError } as unknown as ReturnType<typeof useHouse>;
}

const reads = (over: Partial<HouseVaultReads> = {}): HouseVaultReads => ({
  nav: 1_034_200n, totalSupply: 10n ** 18n, balance: 10n ** 18n, performanceFeeBps: 0, epochPerformanceFeeBps: 0, performanceFeeCeilBps: 2000,
  highWaterMark: 1_034_200n, splitter: "0x00000000000000000000000000000000000000aa", oracle: "0x00000000000000000000000000000000000000bb",
  lastSettlementPrice: 178_420_000n, limits: null, ...over,
});
const withNav = (): HouseMarketResponse => ({
  ...market(1_760_604_800),
  epochs: [{ id: "11", start: 1_759_395_200, end: 1_760_000_000, resultUsdg: null,
    nav: { epoch: "11", at: 1_760_000_000, usdg: null, stockUnits: null,
      settlementPrice: { raw: "178420000", decimals: 6, formatted: "178.42" }, navUsdg: { raw: "1034200", decimals: 6, formatted: "1.03" } } }],
});

/** The design's blocks A-H, in its order, each rendering from its own source. */
describe("HouseVault vault-page blocks", () => {
  it("renders the figures, the one action card, the history and the collapsed details, in that order", () => {
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    const order = ['aria-label="NVDA house vault summary"', 'aria-label="Vault actions"', 'aria-label="Deposit"',
      'aria-label="Withdraw"', 'aria-label="Your requests"',
      // "Past epochs" -> "Past closes" (no "epoch" in visible copy).
      'aria-label="Past closes"', 'aria-label="About this vault"', 'data-slot="house-return-source"', 'data-slot="house-costs"',
      'data-slot="house-how-to-exit"', 'data-slot="house-risks"', 'data-slot="house-on-chain"'].map((marker) => html.indexOf(marker));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(3);
    expect(html.match(/<details/g)).toHaveLength(5);
    expect(html).not.toMatch(/<details[^>]* open=/);
  });

  it("before the first boundary: no mark, the first-boundary sentence, one empty history, and fee reads shown as not read", () => {
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain("No boundary yet");
    expect(html).toContain("No close has settled yet.");
    expect(html).not.toContain('data-chart="none"');
    expect(html).toContain(asRendered(NO_HISTORY));
    expect(html).toContain("Vault fee: not read.");
    expect(html).not.toContain("0.00 %");
  });

  it("with a boundary and reads: the labelled mark, the read fee line and the in-kind line", () => {
    vi.mocked(useHouseMarket).mockReturnValue({ data: withNav(), isError: false } as unknown as ReturnType<typeof useHouseMarket>);
    vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads() } as unknown as ReturnType<typeof useHouseVaultReads>);
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain("1.0342 USDG");
    expect(html).toContain("not a live price");
    // The fee line through displayRatioPercent (lib/v2/vaultCopy.ts houseFeeLine), exact.
    expect(html).toContain(
      asRendered("Performance fee 0% now (up to 20%), taken in USDG at each close, only on gains above the vault's previous high."),
    );
    // The in-kind line (lib/v2/vaultCopy.ts houseInKindLine), exact.
    expect(html).toContain(asRendered("You get your share of the vault's USDG and its NVDA stock, not USDG only."));
    expect(html).toContain("Weekly lock");
  });

  it("a daily vault (API kind daily) swaps every cadence sentence and never says once a week", () => {
    vi.mocked(useHouseMarket).mockReturnValue({ data: market(1_760_604_800, "daily"), isError: false } as unknown as ReturnType<typeof useHouseMarket>);
    vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads() } as unknown as ReturnType<typeof useHouseVaultReads>);
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain(asRendered(HOUSE_DISCLOSURE_DAILY_WITHDRAWALS));
    expect(html).not.toContain("once a week");
    expect(html).not.toContain("Weekly lock");
    expect(html).toContain("Daily lock");
  });

  // An unknown or absent kind is never rendered as weekly (or daily), and deposits stay shut while it is.
  for (const kind of ["unknown", undefined] as const) {
    it(`kind ${String(kind)}: names no cadence, shows the unknown terms, keeps the block order, and disables deposits`, () => {
      // Built without the default: `kind: undefined` must reach the page as an ABSENT field (an older producer).
      const { kind: _weekly, ...rest } = market(1_760_604_800);
      const data: HouseMarketResponse = kind === undefined ? rest : { ...rest, kind };
      expect("kind" in data).toBe(kind !== undefined);
      vi.mocked(useHouseMarket).mockReturnValue({ data, isError: false } as unknown as ReturnType<typeof useHouseMarket>);
      const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
      expect(html).toContain(asRendered(HOUSE_DISCLOSURE_UNKNOWN_WITHDRAWALS));
      expect(html).not.toMatch(/once a week|once a day|Weekly lock|Daily lock|Friday|today&#x27;s close/);
      expect(html.split('aria-label="Withdrawal terms"').length - 1).toBe(2);
      const order = ['aria-label="Deposit"', 'data-slot="house-how-to-exit"', 'data-slot="house-risks"'].map((marker) => html.indexOf(marker));
      expect(order.every((i) => i > -1)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    });
  }

  // The deposit buttons are also disabled by an empty amount, so a static render cannot see this gate; test it directly.
  it("deposits need an armed vault AND a known cadence; an unknown cadence refuses even when armed", () => {
    expect(houseDepositAllowed(true, "weekly")).toBe(true);
    expect(houseDepositAllowed(true, "daily")).toBe(true);
    expect(houseDepositAllowed(true, null)).toBe(false);
    expect(houseDepositAllowed(false, "weekly")).toBe(false);
  });
});

describe("HouseVault withdrawal terms", () => {
  it("places the exact weekly in-kind terms above both deposit confirmations", () => {
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain(asRendered(HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS));
    expect(html).toContain('aria-label="Withdrawal terms"');
    // plain words, same statement. 
    expect(html).toContain("Next close");

    const deposit = html.indexOf('aria-label="Deposit"');
    const terms = html.indexOf('aria-label="Withdrawal terms"', deposit);
    const usdg = html.indexOf("Queue USDG deposit", deposit);
    const stock = html.indexOf("Queue Stock Token deposit", deposit);
    expect(terms).toBeGreaterThan(deposit);
    expect(usdg).toBeGreaterThan(terms);
    expect(stock).toBeGreaterThan(terms);
  });

  // Epoch 3. A holder asking for their money back needs the boundary rule as much as a depositor
  // does, and "Withdrawal queued until the next boundary" arrives in the toast AFTER the button is pressed.
  it("states the withdrawal's close and payout above the request button; the terms box shows once", () => {
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    const withdraw = html.indexOf('aria-label="Withdraw"');
    expect(withdraw).toBeGreaterThan(-1);
    const timing = html.indexOf('data-payout-timing="house-withdraw"', withdraw);
    const request = html.indexOf("Request withdrawal", withdraw);
    expect(timing).toBeGreaterThan(withdraw);
    expect(request).toBeGreaterThan(timing);
    expect(html.slice(timing, request)).toMatch(/Withdrawal|withdrawal/);
    expect(html.split('aria-label="Withdrawal terms"').length - 1).toBe(1);
    expect(html.indexOf('aria-label="Withdrawal terms"')).toBeLessThan(withdraw);
  });

  it("a winding-down vault (no deposit form) shows the terms box on Withdraw, above the request button", () => {
    vi.mocked(useHouse).mockReturnValue(houseList(["weekly", "daily"]));
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    const withdraw = html.indexOf('aria-label="Withdraw"');
    const terms = html.indexOf('aria-label="Withdrawal terms"', withdraw);
    expect(terms).toBeGreaterThan(withdraw);
    expect(html.indexOf("Request withdrawal", withdraw)).toBeGreaterThan(terms);
    expect(html.split('aria-label="Withdrawal terms"').length - 1).toBe(1);
  });

  it("renders unavailable timing instead of crashing when the API has no current boundary", () => {
    vi.mocked(useHouseMarket).mockReturnValue({ data: market(null), isError: false } as unknown as ReturnType<typeof useHouseMarket>);
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    // plain words, same statement. 
    expect(html).toContain("Close timing is unavailable");
    // plain words; the panel is "Next close", not "This epoch".
    expect(html).toContain("The next close is unavailable");
    expect(html).not.toMatch(/>This epoch</);
  });
});

/*
 * ("The House vault page should say plainly that SPCX earns on Fridays
 * and pays withdrawals the next day"). SPCX's daily vault gets the Friday-only copy everywhere the page states terms;
 * NVDA's daily vault keeps the daily copy.
 */
describe("the SPCX daily vault page says Fridays only", () => {
  it("SPCX: the lede, both withdrawal-terms panels and the risks tip carry the Friday-only copy, never the daily promise", () => {
    vi.mocked(useHouseMarket).mockReturnValue({ data: market(1_760_604_800, "daily"), isError: false } as unknown as ReturnType<typeof useHouseMarket>);
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "SPCX" }));
    expect(html).toContain(asRendered(houseLede("daily", false)));
    expect(html).toContain("on Fridays, when its options expire");
    expect(html.split(asRendered(HOUSE_DISCLOSURE_FRIDAYS_ONLY_WITHDRAWALS)).length - 1).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain(asRendered(HOUSE_DISCLOSURE_DAILY_WITHDRAWALS));
    expect(html).not.toContain(asRendered("after today's options settle"));
  });

  it("NVDA: the same daily vault response keeps the daily copy", () => {
    vi.mocked(useHouseMarket).mockReturnValue({ data: market(1_760_604_800, "daily"), isError: false } as unknown as ReturnType<typeof useHouseMarket>);
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain(asRendered(HOUSE_DISCLOSURE_DAILY_WITHDRAWALS));
    expect(html).not.toContain(asRendered(HOUSE_DISCLOSURE_FRIDAYS_ONLY_WITHDRAWALS));
    expect(html).not.toContain("Fridays only");
  });
});

const queuedRow = (html: string, status = "unknown") => {
  const at = html.indexOf(`data-slot="house-queued-${status}"`);
  expect(at, `a ${status} queued row`).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</li>", at));
};
const queuedAmountText = (row: string) => row.match(/data-slot="house-queued-amount">([^<]*)</)?.[1] ?? null;

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
    const row = queuedRow(html);
    expect(row).toContain(">Deposit ");
    expect(queuedAmountText(row), "the queued row must name the nonzero stock leg").toBe("2 Stock Tokens");
    expect(row, "the observed zero USDG leg must not replace the stock leg").not.toMatch(/>0 USDG|0 USDG and/);
    expect(html, "Stock Token base units must be formatted at 18 decimals").not.toContain("2000000000000000000");
  });

  it("formats a USDG-only deposit through the money rule (a tiny one reads <0.01) without adding a zero stock clause", () => {
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
    // 500 base units = 0.0005 USDG, below a cent. The time is a New York date, not a raw unix number.
    const row = queuedRow(html);
    expect(row).toContain(">Deposit ");
    expect(queuedAmountText(row)).toBe("&lt;0.01 USDG");
    expect(row).toContain(`Requested ${renderToStaticMarkup(createElement(Time, { at: 1760000200 }))}`);
    expect(html).not.toContain("1760000200");
    expect(html).not.toContain("0 Stock Tokens");
  });

  it("keeps null deposit legs absent from a withdrawal row", () => {
    const data = market(1_760_604_800);
    data.shares!.queued = [{
      kind: "withdraw",
      account,
      assets: null,
      stockAmount: null,
      // The API's raw share base units (18 dp), as indexer api house.ts serves them: 42 whole shares.
      shares: (42n * 10n ** BigInt(SHARE_DECIMALS)).toString(),
      requestedAt: 1_760_000_210,
    }];
    vi.mocked(useHouseMarket).mockReturnValue({ data, isError: false } as unknown as ReturnType<typeof useHouseMarket>);

    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    const row = queuedRow(html);
    expect(row).toContain(">Withdrawal ");
    expect(queuedAmountText(row)).toBe("42 shares");
    expect(row).toContain(`Requested ${renderToStaticMarkup(createElement(Time, { at: 1760000210 }))}`);
    // Never the raw base units.
    expect(html).not.toContain("42000000000000000000");
    expect(row.replace(/<[^>]+>/g, "")).not.toMatch(/USDG|Stock Tokens/);
  });
});

/** The vault page shows the indexer's earliestWithdrawal with its reason, and "Unavailable" without it. */
describe("/house/[ticker]: earliest withdrawal", () => {
  it("renders the pending-roll line when the boundary has passed unrolled", () => {
    vi.mocked(useHouseMarket).mockReturnValue({ data: { ...market(1_760_604_800),
      earliestWithdrawal: { kind: "weekly", at: 1_760_604_800, reason: "boundary-pending" } }, isError: false } as unknown as ReturnType<typeof useHouseMarket>);
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain("Earliest withdrawal:");
    expect(html).toContain('data-earliest-withdrawal="boundary-pending"');
    expect(html).toContain("At the pending roll (");
  });

  it("says Unavailable, never Now, when the indexer does not send it", () => {
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain('data-earliest-withdrawal="not-sent"');
    expect(html).not.toMatch(/Earliest withdrawal:<\/span> <span[^>]*>Now/);
  });
});

/**
 * Once a daily vault is listed, a weekly vault's page stops offering deposits and
 * says when to withdraw. Its way out -- request, cancel, claim -- is untouched: HouseVault.claim is permissionless and
 * a wind-down must never trap a depositor.
 */
describe("a weekly vault winds down once a daily vault is listed", () => {
  const END = 1_760_604_800;

  it("hides the deposit action, shows the wind-down notice with the exit time, and keeps every exit action", () => {
    vi.mocked(useHouse).mockReturnValue(houseList(["weekly", "daily"]));
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain(asRendered(houseWindDownHeadline(END)));
    expect(html).toContain(asRendered(HOUSE_WIND_DOWN_DETAIL));
    expect(html).toContain("This house vault is winding down.");
    expect(html).not.toContain("Queue USDG deposit");
    expect(html).not.toContain("Queue Stock Token deposit");
    expect(html).not.toContain('id="house-deposit-usdg"');
    for (const exit of ["Cancel queued deposit", "Request withdrawal", "Cancel queued withdrawal", "Claim settled withdrawal"]) {
      expect(html).toContain(exit);
    }
  });

  it("control: with only weekly vaults listed the deposit form is there and no wind-down notice is", () => {
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain("Queue USDG deposit");
    expect(html).toContain("Queue Stock Token deposit");
    expect(html).toContain("Deposit into the house vault.");
    expect(html).not.toContain("Winding down");
  });

  it("an unknown kind beside the weekly one does not wind it down (unknown is never read as daily)", () => {
    vi.mocked(useHouse).mockReturnValue(houseList(["weekly", "unknown"]));
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain("Queue USDG deposit");
    expect(html).not.toContain("Winding down");
  });

  it("an unread list winds nothing down", () => {
    vi.mocked(useHouse).mockReturnValue(houseList(["weekly", "daily"], true));
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain("Queue USDG deposit");
    expect(html).not.toContain("Winding down");
  });

  // But a failed list leaves the weekly vault's wind-down UNKNOWN: its Deposit panel says it could not
  // check, and the door is shut (the wiring pin in the block below). Only the list differs from the control.
  it("a failed list says the weekly vault's wind-down could not be checked; a read one says nothing", () => {
    vi.mocked(useHouse).mockReturnValue(houseList(["weekly", "daily"], true));
    const failed = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    const deposit = failed.slice(failed.indexOf('aria-label="Deposit"'));
    expect(deposit).toContain('data-slot="wind-down-unread"');
    expect(deposit).toContain(asRendered(HOUSE_WIND_DOWN_UNREAD));
    vi.mocked(useHouse).mockReturnValue(houseList(["weekly", "weekly"]));
    const read = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(read).not.toContain('data-slot="wind-down-unread"');
  });

  it("a daily vault's page never says its wind-down could not be checked", () => {
    vi.mocked(useHouseMarket).mockReturnValue({ data: market(END, "daily"), isError: false } as unknown as ReturnType<typeof useHouseMarket>);
    vi.mocked(useHouse).mockReturnValue(houseList(["weekly", "daily"], true));
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).not.toContain('data-slot="wind-down-unread"');
  });

  it("a daily vault's own page is never wound down", () => {
    vi.mocked(useHouseMarket).mockReturnValue({ data: market(END, "daily"), isError: false } as unknown as ReturnType<typeof useHouseMarket>);
    vi.mocked(useHouse).mockReturnValue(houseList(["weekly", "daily"]));
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain("Queue USDG deposit");
    expect(html).not.toContain("Winding down");
  });

  it("with no epoch end observed, the notice names the next boundary rather than a date", () => {
    vi.mocked(useHouseMarket).mockReturnValue({ data: market(null), isError: false } as unknown as ReturnType<typeof useHouseMarket>);
    vi.mocked(useHouse).mockReturnValue(houseList(["weekly", "daily"]));
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain(asRendered(houseWindDownHeadline(null)));
    expect(html).not.toContain("1970");
  });
});

/**
 * /house/<ticker>?vault= opens one exact vault. The page fetches the vault it was given, writes only to the vault
 * the response names, refuses every write when the response names a different vault (an indexer that predates `?vault=`
 * answers with its first vault), and links every other vault of the market.
 */
describe("one page per House vault", () => {
  const SERVED = "0x0000000000000000000000000000000000000066";
  const OTHER = "0x0000000000000000000000000000000000000077";

  /** The opening tag of the <button> whose text is `label`. */
  function buttonTag(html: string, label: string): string {
    const match = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)]
      .find((m) => m[2]!.replace(/<[^>]+>/g, "").trim() === label);
    expect(match, `button ${label}`).toBeDefined();
    return match![1]!;
  }
  // Cancel, withdraw-cancel and claim are enabled for a connected wallet on a served vault, so a static render can see
  // the guard on them. The two deposits and the withdrawal request are also disabled by their empty amount inputs.
  // Claim is enabled only with a matured request, so these renders carry one (claimable()); without it the
  // claim button is off for its own reason and the mismatch guard on it would be unobservable.
  // The two Cancels are enabled only with a request queued THIS epoch (lib/v2/houseGates.ts), and no one wallet
  // has that and a matured request at once (one deposit request and one withdrawal request per account). So each exit is
  // checked under the fixture that enables it: claimable() for the claim, cancellable() for the two Cancels.
  const CLAIM = ["Claim settled withdrawal"];
  const CANCELS = ["Cancel queued deposit", "Cancel queued withdrawal"];
  const claimable = () => vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads({ epochId: 13n,
    withdrawRequest: { epochId: 12n, shares: 10n ** 18n }, depositRequest: { epochId: 0n, usdg: 0n, stock: 0n } }) } as unknown as
    ReturnType<typeof useHouseVaultReads>);
  const cancellable = () => vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads({ epochId: 13n,
    withdrawRequest: { epochId: 13n, shares: 10n ** 18n }, depositRequest: { epochId: 13n, usdg: 5_000_000n, stock: 0n } }) } as unknown as
    ReturnType<typeof useHouseVaultReads>);
  const fixtures: Array<[() => unknown, string[]]> = [[claimable, CLAIM], [cancellable, CANCELS]];

  it("passes the vault it was given to the market read", () => {
    renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA", vault: SERVED }));
    expect(useHouseMarket).toHaveBeenLastCalledWith("NVDA", account, SERVED);
    renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(useHouseMarket).toHaveBeenLastCalledWith("NVDA", account, undefined);
  });

  it("control: the served vault is the one asked for, so no notice and every exit stays enabled", () => {
    for (const [fixture, exits] of fixtures) {
      fixture();
      const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA", vault: SERVED }));
      expect(html).not.toContain(asRendered(HOUSE_VAULT_MISMATCH));
      for (const label of exits) expect(buttonTag(html, label), label).not.toMatch(/ disabled=""/);
    }
  });

  it("a response for a different vault shows the notice and disables every write", () => {
    for (const [fixture, exits] of fixtures) {
      fixture();
      const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA", vault: OTHER }));
      expect(html).toContain(asRendered(HOUSE_VAULT_MISMATCH));
      for (const label of [...exits, "Queue USDG deposit", "Queue Stock Token deposit", "Request withdrawal"]) {
        expect(buttonTag(html, label), label).toMatch(/ disabled=""/);
      }
    }
  });

  it("a requested vault that cannot be read says so and links back, and never says the vault is not deployed", () => {
    vi.mocked(useHouseMarket).mockReturnValue({ data: undefined, isError: true } as unknown as ReturnType<typeof useHouseMarket>);
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA", vault: OTHER }));
    expect(html).toContain(asRendered(houseVaultUnavailable("NVDA")));
    expect(html).toContain('href="/house/nvda"');
    expect(html).not.toContain("is not deployed yet");
  });

  it("control: with no vault asked for, an unread market still says not deployed yet", () => {
    vi.mocked(useHouseMarket).mockReturnValue({ data: undefined, isError: true } as unknown as ReturnType<typeof useHouseMarket>);
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain("is not deployed yet");
    expect(html).not.toContain(asRendered(houseVaultUnavailable("NVDA")));
  });

  it("links the market's other vault, labelled with its cadence, and not the vault on screen or another market's", () => {
    // houseList: NVDA 0x..70 (weekly) and SPCX 0x..71 (weekly). The page shows NVDA 0x..66.
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    const nvdaSibling = "0x0000000000000000000000000000000000000070";
    expect(html).toContain(`href="/house/nvda?vault=${nvdaSibling}"`);
    expect(html).toMatch(/data-sibling-vault="0x0000000000000000000000000000000000000070"[^>]*>Weekly house vault/);
    expect(html).not.toContain("0x0000000000000000000000000000000000000071");
    expect(html).not.toContain(`?vault=${SERVED}`);
    expect(html).not.toContain(HOUSE_SIBLING_CLOSED);
  });

  it("on a daily page, a winding-down weekly sibling carries the new marker while the page itself never says Winding down", () => {
    vi.mocked(useHouseMarket).mockReturnValue({ data: market(1_760_604_800, "daily"), isError: false } as unknown as ReturnType<typeof useHouseMarket>);
    vi.mocked(useHouse).mockReturnValue(houseList(["weekly", "daily"]));
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toMatch(/data-sibling-vault="0x0000000000000000000000000000000000000070"[^>]*>Weekly house vault[\s\S]*?closed to new deposits/);
    expect(html).toContain(HOUSE_SIBLING_CLOSED);
    expect(html).not.toContain("Winding down");
  });
});

/**
 * The House deposit gate after the launch clock went. The arming is read on THE VAULT THE DEPOSIT WRITES TO
 * (the /v2/house response's `vault`), in the page's own vault multicall, and it fails closed: unread, errored and false
 * all keep deposits shut. Only `true` on that vault opens them. The deposit buttons are also disabled by their empty
 * amount inputs, so the gate is tested through the page's own helpers, and the page is rendered for the notice.
 */
describe("House deposits fail closed on the deposit vault's arming", () => {
  const canDeposit = (r: Parameters<typeof houseArming>[0]) => houseDepositAllowed(houseDepositsOpen(houseArming(r)), "weekly");

  it("shut while the arming is unread, when the read errored, when that call failed, and when it reads false", () => {
    expect(canDeposit({ data: undefined }), "unread").toBe(false);
    expect(canDeposit({ data: reads({ protocolAccountsConfirmed: true }), isError: true }), "query error wins over stale data").toBe(false);
    expect(canDeposit({ data: reads({ protocolAccountsConfirmed: null }) }), "failed call").toBe(false);
    expect(canDeposit({ data: reads() }), "field absent").toBe(false);
    expect(canDeposit({ data: reads({ protocolAccountsConfirmed: false }) }), "armed=false").toBe(false);
  });

  it("open only for armed=true (with a known cadence)", () => {
    expect(canDeposit({ data: reads({ protocolAccountsConfirmed: true }) })).toBe(true);
    expect(houseDepositAllowed(houseDepositsOpen(houseArming({ data: reads({ protocolAccountsConfirmed: true }) })), null)).toBe(false);
  });

  it("the arming is read on the vault the deposit writes to, not the registry's per-market vault", () => {
    vi.mocked(useHouseVaultReads).mockClear();
    renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    // market().vault is 0x...66; the registry mock names no house vault at all.
    expect(vi.mocked(useHouseVaultReads).mock.calls.every(([vault]) => vault === "0x0000000000000000000000000000000000000066")).toBe(true);
    expect(vi.mocked(useHouseVaultReads)).toHaveBeenCalled();
  });

  it("the page's notice: static not-quoting copy for false, the unread line for an error, gone once armed; never a clock", () => {
    const page = () => renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads({ protocolAccountsConfirmed: false }) } as unknown as ReturnType<typeof useHouseVaultReads>);
    let html = page();
    expect(html).toContain(asRendered(houseNotQuoting("NVDA")));
    vi.mocked(useHouseVaultReads).mockReturnValue({ data: undefined, isError: true } as unknown as ReturnType<typeof useHouseVaultReads>);
    html = page();
    expect(html).toContain(asRendered(HOUSE_ARMING_UNREAD));
    vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads({ protocolAccountsConfirmed: true }) } as unknown as ReturnType<typeof useHouseVaultReads>);
    html = page();
    expect(html).not.toContain('aria-label="NVDA house vault status"');
    for (const h of [html]) {
      expect(h).not.toContain('role="timer"');
      expect(h).not.toMatch(/quotes in|Admin Safe/);
    }
  });

  it("the House epoch countdown (a product timer) still renders", () => {
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    // "Epoch 12 ends in" -> "Closes in" (the countdown itself is unchanged).
    expect(html).toMatch(/data-slot="house-countdown"[^>]*>\d+d \d+h \d+m \d\ds<\/span>/);
    expect(html).toMatch(/Next close[\s\S]*?data-slot="house-countdown"/);
  });
});

/** (v9): the owed performance fee beside the value, and the instant-deposit path the vault chose. */
describe("v9 owed fee and instant USDG deposits", () => {
  const routeAnswer = (answer: unknown) =>
    vi.mocked(useQuery).mockReturnValue(answer as unknown as ReturnType<typeof useQuery>);

  it("a non-zero performanceFeeOwed is shown beside the value, quoting the read amount", () => {
    vi.mocked(useHouseMarket).mockReturnValue({ data: withNav(), isError: false } as unknown as ReturnType<typeof useHouseMarket>);
    vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads({ performanceFeeOwed: 12_500_000n }) } as unknown as ReturnType<typeof useHouseVaultReads>);
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain('data-slot="house-performance-fee-owed"');
    expect(html).toContain(asRendered(housePerformanceFeeOwedLine("12.50"))); // money: cents shown when not zero
  });

  it("zero owed, a failed read, and an unread vault all show no owed line (never a 0 or a guess)", () => {
    for (const data of [reads({ performanceFeeOwed: 0n }), reads({ performanceFeeOwed: null }), undefined]) {
      vi.mocked(useHouseVaultReads).mockReturnValue({ data } as unknown as ReturnType<typeof useHouseVaultReads>);
      const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
      expect(html).not.toContain('data-slot="house-performance-fee-owed"');
    }
  });

  it("the deposit panel states the instant-deposit rule", () => {
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain('data-slot="house-instant-deposit-rule"');
    expect(html).toContain(asRendered(HOUSE_INSTANT_DEPOSIT_RULE));
  });

  it("the vault's previewDepositNow picks the label; unknown keeps the queued one and says nothing", () => {
    routeAnswer({ data: { instant: true, shares: 5n }, isError: false });
    let html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain(HOUSE_DEPOSIT_NOW_LABEL);
    expect(html).not.toContain(HOUSE_DEPOSIT_QUEUE_LABEL);
    // The route lines (lib/v2/houseCopy.ts houseDepositRouteLine), exact.
    expect(html).toContain("The vault says this deposit gets shares now.");
    expect(html).not.toMatch(/5 shares/); // no share estimate before the transaction

    routeAnswer({ data: { instant: false, refusal: "NotSettled" }, isError: false });
    html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain(HOUSE_DEPOSIT_QUEUE_LABEL);
    expect(html).toContain("The vault says this deposit waits for the close.");

    for (const unknown of [{ data: undefined, isError: false }, { data: undefined, isError: true }]) {
      routeAnswer(unknown);
      html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
      expect(html).toContain(HOUSE_DEPOSIT_QUEUE_LABEL);
      expect(html).not.toContain('data-slot="house-deposit-route"');
    }
  });

  it("a not-exact preview (NoSource or StaleSpot) is the queue label, names the refusal, and quotes no shares", () => {
    for (const refusal of ["NoSource", "StaleSpot"] as const) {
      routeAnswer({ data: { instant: false, refusal }, isError: false });
      const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
      expect(html, refusal).toContain(HOUSE_DEPOSIT_QUEUE_LABEL);
      expect(html, refusal).not.toContain(HOUSE_DEPOSIT_NOW_LABEL);
      expect(html, refusal).not.toContain("The vault says this deposit gets shares now.");
      const start = html.indexOf('data-slot="house-deposit-route"');
      expect(start, refusal).toBeGreaterThan(-1);
      const routeHtml = html.slice(start, html.indexOf("</p>", start));
      expect(routeHtml, refusal).toContain(`data-refusal="${refusal}"`);
      expect(routeHtml, refusal).toContain("The vault says this deposit waits for the close.");
      // The route line is the share promise. Other panels on this page say "shares" about the position.
      expect(routeHtml, refusal).not.toMatch(/\d/);
      expect(routeHtml, refusal).not.toMatch(/\bnow\b/);
    }
  });
});

/*
 * HouseVault.requestDeposit has no pause of its own, so while the chain says the whole deployment is paused
 * (trading AND every market's mint) both House deposit buttons close with one note, on an ARMED vault too. Withdrawal
 * requests, cancels and claims are not touched. The buttons are also disabled by their empty amount inputs in a static
 * render (above), so the gate is proven through `depositDoor`, the rendered note and the wiring below.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { useMarkets } from "@/lib/v2/hooks";
import { UPGRADE_PAUSE_NOTE, UPGRADE_PAUSE_UNREAD_NOTE } from "@/lib/v2/upgradePause";

describe("House deposits close while the deployment is paused for an upgrade", () => {
  const markets = (tradingPaused: boolean, mintPaused: boolean) => vi.mocked(useMarkets).mockReturnValue({
    data: [{ ticker: "NVDA", tradingPaused, mintPaused }, { ticker: "SPCX", tradingPaused, mintPaused }], isError: false,
  } as unknown as ReturnType<typeof useMarkets>);
  const armedPage = () => {
    vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads({ protocolAccountsConfirmed: true }) } as unknown as ReturnType<typeof useHouseVaultReads>);
    return renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
  };

  it("paused: an armed vault's Deposit panel says it is paused for upgrade", () => {
    markets(true, true);
    const html = armedPage();
    const deposit = html.slice(html.indexOf('aria-label="Deposit"'));
    expect(deposit).toContain('data-slot="upgrade-paused"');
    expect(deposit).toContain(UPGRADE_PAUSE_NOTE);
  });

  it("unpaused, or only one market's mint paused: no note on an armed vault", () => {
    for (const [trading, mint] of [[false, false], [true, false], [false, true]] as const) {
      markets(trading, mint);
      const html = armedPage();
      expect(html).not.toContain('data-slot="upgrade-paused"');
      expect(html).not.toContain(UPGRADE_PAUSE_NOTE);
    }
  });

  // A FAILED /v2/markets read is not "unpaused", even with an unpaused list from an earlier read still cached
  // beside isError. Only the markets query differs from the unpaused case above.
  it("a failed market read: an armed vault's Deposit panel says it could not check, even with an unpaused list cached", () => {
    try {
      vi.mocked(useMarkets).mockReturnValue({
        data: [{ ticker: "NVDA", tradingPaused: false, mintPaused: false }, { ticker: "SPCX", tradingPaused: false, mintPaused: false }],
        isError: true,
      } as unknown as ReturnType<typeof useMarkets>);
      const html = armedPage();
      const deposit = html.slice(html.indexOf('aria-label="Deposit"'));
      expect(deposit).toContain('data-slot="upgrade-paused"');
      expect(deposit).toContain(asRendered(UPGRADE_PAUSE_UNREAD_NOTE));
    } finally {
      // Do not leak a failed read into the tests after this one: they would pass with the door shut for this reason.
      markets(false, false);
    }
  });

  it("both deposit buttons read canDeposit, and canDeposit is the door around the page's own deposit gate", () => {
    const source = readFileSync(fileURLToPath(new URL("./HouseVault.tsx", import.meta.url)), "utf8");
    // The door also stays shut while a weekly vault's wind-down is unknown (the /v2/house list is unread).
    expect(source).toContain("const houseDeposit = depositDoor(houseDepositAllowed(depositsOpen, cadence) && !windingDown && !windDownUnread && !mismatch,");
    expect(source).toContain("const windDownUnread = houseWindDownUnknown(kind, !list.isError && list.data !== undefined);");
    expect(source).toContain("const canDeposit = houseDeposit.open;");
    expect(source.match(/disabled=\{mismatch \|\| !canDeposit \|\| /g)?.length).toBe(2);
  });
});

/**
 * (measured on a v9 fork): a depositor who queued a withdrawal and clicked "Claim settled
 * withdrawal" before the close got the shared BadUnits text. The button now follows HouseVault.claim()'s own test
 * (lib/v2/houseClaim.ts): it is live only when a request queued in an EARLIER epoch exists, and the line under it says
 * when a pending one will be. A request in the current epoch is pending, not claimable.
 */
describe("the claim button is live only when claim() has something matured", () => {
  const END = 1_760_604_800;
  // An hour before the fixture epoch's close, so the pending line is the one that names the close.
  const NOW = END - 3_600;
  beforeEach(() => { vi.useFakeTimers({ now: NOW * 1000, toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); });
  /** The claim button's opening tag, so the ` disabled=""` check reads THIS button, not a Tailwind `disabled:` class. */
  const claimButton = (html: string) => {
    const m = html.match(/<button([^>]*)>Claim settled withdrawal<\/button>/);
    expect(m, "the claim button is on the page").not.toBeNull();
    return m![1]!;
  };
  const page = (over: Partial<HouseVaultReads>) => {
    vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads({ epochId: 12n, withdrawRequest: { epochId: 0n, shares: 0n },
      depositRequest: { epochId: 0n, usdg: 0n, stock: 0n }, ...over }) } as unknown as ReturnType<typeof useHouseVaultReads>);
    return renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
  };

  it("disabled before the close: a withdrawal queued THIS epoch, with the close it pays after", () => {
    const html = page({ withdrawRequest: { epochId: 12n, shares: 10n ** 18n } });
    expect(claimButton(html)).toContain(' disabled=""');
    expect(html).toContain('data-slot="house-claim-state"');
    expect(html).toContain(asRendered(houseClaimLine({ kind: "pending" }, END, NOW)!));
    expect(houseClaimLine({ kind: "pending" }, END, NOW)).toMatch(/^Claimable after this epoch closes at /);
  });

  it("enabled after the close: the same withdrawal once the vault's epoch has moved on, with no line", () => {
    const html = page({ epochId: 13n, withdrawRequest: { epochId: 12n, shares: 10n ** 18n } });
    expect(claimButton(html)).not.toContain(' disabled=""');
    expect(html).not.toContain('data-slot="house-claim-state"');
  });

  it("enabled for a matured deposit too, since claim() collects its shares", () => {
    const html = page({ depositRequest: { epochId: 11n, usdg: 5_000_000n, stock: 0n } });
    expect(claimButton(html)).not.toContain(' disabled=""');
  });

  it("disabled with nothing queued, and while the reads are unread or failed", () => {
    expect(claimButton(page({}))).toContain(' disabled=""');
    expect(page({})).toContain("Nothing to claim.");
    expect(claimButton(page({ withdrawRequest: null }))).toContain(' disabled=""');
    expect(page({ withdrawRequest: null })).toContain("Could not read your queued requests");
    vi.mocked(useHouseVaultReads).mockReturnValue({ data: undefined } as unknown as ReturnType<typeof useHouseVaultReads>);
    const unread = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(claimButton(unread)).toContain(' disabled=""');
    expect(unread).toContain("Checking whether anything is ready to claim.");
  });

  it("control: the other exit buttons are not gated by the claim state", () => {
    // Both Cancels need a request queued this epoch to be live (houseGates.ts), so both legs carry one here.
    const html = page({ withdrawRequest: { epochId: 12n, shares: 10n ** 18n }, depositRequest: { epochId: 12n, usdg: 5_000_000n, stock: 0n } });
    for (const label of ["Cancel queued withdrawal", "Cancel queued deposit"]) {
      const m = html.match(new RegExp(`<button([^>]*)>${label}</button>`));
      expect(m, label).not.toBeNull();
      expect(m![1], label).not.toContain(' disabled=""');
    }
  });
});

/**
 * (measured on a v9 fork): each deposit and withdrawal button follows the vault's own rule for it
 * (lib/v2/houseGates.ts, one HouseVault.sol refusal per gate), and a click re-checks the chain before any write.
 */
describe("House buttons follow the vault's request state", () => {
  const END = 1_760_604_800;
  const NOW = END - 3_600;
  beforeEach(() => { vi.useFakeTimers({ now: NOW * 1000, toFake: ["Date"] }); });
  afterEach(() => { vi.useRealTimers(); });
  const tag = (html: string, label: string) => {
    const m = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].find((x) => x[2]!.replace(/<[^>]+>/g, "").trim() === label);
    expect(m, label).toBeDefined();
    return m![1]!;
  };
  const page = (over: Partial<HouseVaultReads>, chainOffset: number | null = null) => {
    vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads({ epochId: 12n, protocolAccountsConfirmed: true,
      withdrawRequest: { epochId: 0n, shares: 0n }, depositRequest: { epochId: 0n, usdg: 0n, stock: 0n }, ...over }) } as unknown as
      ReturnType<typeof useHouseVaultReads>);
    // The chain clock's offset from this browser (lib/v2/chainClock.ts); every other query stays pending.
    vi.mocked(useQuery).mockImplementation(((options: { queryKey: readonly unknown[] }) => options.queryKey[1] === "chain-clock-offset"
      ? { data: chainOffset ?? undefined, isError: false } : { data: undefined, isError: false }) as unknown as typeof useQuery);
    return renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
  };

  it("nothing queued: both Cancels are disabled, with no line under them", () => {
    const html = page({});
    for (const label of ["Cancel queued deposit", "Cancel queued withdrawal"]) expect(tag(html, label), label).toContain(' disabled=""');
    expect(html).not.toContain('data-slot="house-cancel-deposit-gate"');
    expect(html).not.toContain('data-slot="house-cancel-withdraw-gate"');
  });

  it("queued this epoch: both Cancels are live (control)", () => {
    const html = page({ withdrawRequest: { epochId: 12n, shares: 1n }, depositRequest: { epochId: 12n, usdg: 5_000_000n, stock: 0n } });
    for (const label of ["Cancel queued deposit", "Cancel queued withdrawal"]) expect(tag(html, label), label).not.toContain(' disabled=""');
  });

  it("a deposit priced at an earlier close: Cancel is shut and says claim it; a new queued deposit says claim first", () => {
    const html = page({ depositRequest: { epochId: 11n, usdg: 5_000_000n, stock: 0n } });
    expect(tag(html, "Cancel queued deposit")).toContain(' disabled=""');
    expect(html).toContain(`data-slot="house-cancel-deposit-gate">${asRendered(HOUSE_DEPOSIT_PRICED)}`);
    expect(html).toContain(asRendered(HOUSE_DEPOSIT_TO_CLAIM));
  });

  it("a withdrawal processed at an earlier close: Cancel is shut and a new request says claim first", () => {
    const html = page({ epochId: 13n, withdrawRequest: { epochId: 12n, shares: 1n } });
    expect(tag(html, "Cancel queued withdrawal")).toContain(' disabled=""');
    expect(html).toContain(`data-slot="house-cancel-withdraw-gate">${asRendered(HOUSE_WITHDRAWAL_PRICED)}`);
    expect(html).toContain(`data-slot="house-withdraw-gate">${asRendered(HOUSE_WITHDRAWAL_TO_CLAIM)}`);
  });

  it("past the epoch end ON THE CHAIN'S CLOCK: deposits and the deposit Cancel close, once, while the browser is an hour behind", () => {
    const queued = { depositRequest: { epochId: 12n, usdg: 5_000_000n, stock: 0n } };
    const html = page(queued, 3_600);
    expect(html).toContain(`data-slot="house-deposit-gate">${asRendered(HOUSE_DEPOSITS_CLOSED)}`);
    expect(html.split(asRendered(HOUSE_DEPOSITS_CLOSED)).length - 1).toBe(1); // the Stock button's same reason is not repeated
    expect(tag(html, "Cancel queued deposit")).toContain(' disabled=""');
    expect(html).toContain(asRendered(HOUSE_DEPOSIT_CANCEL_CLOSED));
    // Control: the same browser clock with the chain in step leaves them open.
    const inStep = page(queued, 0);
    expect(inStep).not.toContain(asRendered(HOUSE_DEPOSITS_CLOSED));
    expect(tag(inStep, "Cancel queued deposit")).not.toContain(' disabled=""');
  });

  it("every write re-checks the chain through its gate before sending", () => {
    const source = readFileSync(fileURLToPath(new URL("./HouseVault.tsx", import.meta.url)), "utf8");
    const WRITES = ["cancelHouseDepositRequest", "cancelHouseWithdrawRequest", "requestHouseWithdraw", "requestHouseDeposit",
      "depositHouseNow", "claimHouseWithdrawal"];
    // The first house write after each gate check is the one that check guards.
    const guards = (check: string, write: string) => {
      const at = source.indexOf(`await checkGate(${check});`);
      expect(at, check).toBeGreaterThan(-1);
      const next = WRITES.map((w) => ({ w, i: source.indexOf(`await ${w}(`, at) })).filter((x) => x.i > -1).sort((a, b) => a.i - b.i)[0];
      expect(next?.w, check).toBe(write);
    };
    guards("houseCancelDepositGate", "cancelHouseDepositRequest");
    guards("houseCancelWithdrawGate", "cancelHouseWithdrawRequest");
    guards("(state) => houseWithdrawGate(state, amount, shares)", "requestHouseWithdraw");
    guards("(state) => houseDepositGate(state, false)", "requestHouseDeposit");
    guards("(state) => houseDepositGate(state, answer.instant)", "depositHouseNow");
  });
});

/** The queue list says which requests are ready to claim, from the API's HouseVault.claim-rule status. */
describe("HouseVault queued requests: claim-rule status", () => {
  it("a claimable request says to claim it and that it can no longer be cancelled; a pending one says when it is priced", () => {
    const data: HouseMarketResponse = {
      ...market(1_760_604_800),
      shares: {
        address: account, shares: "0", queued: [
          { kind: "withdraw", account, assets: null, stockAmount: null, shares: (40n * 10n ** BigInt(SHARE_DECIMALS)).toString(),
            requestedAt: 1_759_400_000, epochId: "11", status: "claimable", maturesAt: 1_760_000_000 },
          { kind: "deposit", account, assets: "5000000", stockAmount: "0", shares: null, requestedAt: 1_760_100_000,
            epochId: "12", status: "pending", maturesAt: 1_760_604_800 },
        ],
      },
    };
    vi.mocked(useHouseMarket).mockReturnValue({ data, isError: false } as unknown as ReturnType<typeof useHouseMarket>);
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    const claimable = queuedRow(html, "claimable");
    expect(claimable).toContain(">Withdrawal ");
    expect(queuedAmountText(claimable)).toBe("40 shares");
    expect(claimable).toContain("Ready to claim");
    expect(claimable).toContain("It was priced at the close.");
    expect(claimable).toContain("it can no longer be cancelled");
    const pending = queuedRow(html, "pending");
    expect(pending).toContain(">Deposit ");
    expect(pending).toContain("Priced at the close after");
    expect(pending).not.toContain("Ready to claim");
  });

  it("an older producer (no status) keeps the plain queued line", () => {
    const data: HouseMarketResponse = {
      ...market(1_760_604_800),
      shares: { address: account, shares: "0", queued: [
        { kind: "withdraw", account, assets: null, stockAmount: null, shares: (40n * 10n ** BigInt(SHARE_DECIMALS)).toString(),
          requestedAt: 1_759_400_000 },
      ] },
    };
    vi.mocked(useHouseMarket).mockReturnValue({ data, isError: false } as unknown as ReturnType<typeof useHouseMarket>);
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    const row = queuedRow(html);
    expect(row).toContain(">Withdrawal ");
    expect(row).toContain(">Queued<");
    expect(html).not.toContain("Ready to claim");
  });
});

/**
 * HouseVault keeps decimals() = 18 and its first mint now pays 10 ** (18 - USDG decimals)
 * shares per USDG base unit, so a 50 USDG first deposit holds 50e18 shares: the page must show about 50 shares and a
 * mark of about one USDG per share. Before the same deposit held 50e6 share base units, 5e-11 of a share.
 */
describe("House share scale", () => {
  const USDG = 10n ** BigInt(USDG_DECIMALS);
  const firstMint = (usdg: bigint) => usdg * 10n ** BigInt(SHARE_DECIMALS - USDG_DECIMALS);
  const deposited = 50n * USDG;
  const held = firstMint(deposited);
  const deadShares = firstMint(1_000n); // MIN_SHARES: 1e3 USDG base units at the first-mint rate

  it("a 50 USDG first deposit renders as 50 shares, with the mark at one USDG per share", () => {
    expect(held).toBe(50n * 10n ** 18n);
    vi.mocked(useHouseMarket).mockReturnValue({
      data: { ...withNav(), shares: { address: account, shares: held.toString(), queued: [] } }, isError: false,
    } as unknown as ReturnType<typeof useHouseMarket>);
    vi.mocked(useHouseVaultReads).mockReturnValue({
      data: reads({ nav: deposited, totalSupply: held + deadShares, balance: held, highWaterMark: USDG }),
    } as unknown as ReturnType<typeof useHouseVaultReads>);
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toMatch(/Your shares: <span class="num">50<\/span>/);
    expect(html).toMatch(/High-water mark[\s\S]*?data-slot="v"[^>]*>1\.00 USDG \/ share</);
    expect(html).not.toMatch(/Your shares: <span class="num">0(\.0+)?<\/span>/);
  });
});

/**
 * review (P2). The withdraw box's amount had no test: sending parsePositive(withdrawShares, 6) in its
 * place kept every web test green and would queue a withdrawal 10^12 times too small. The amount the gate judges, the
 * button enables on and the write sends must all be the share-scale parse of the box's own text.
 */
describe("House withdraw box amount", () => {
  const source = readFileSync(fileURLToPath(new URL("./HouseVault.tsx", import.meta.url)), "utf8");

  it("requestHouseWithdraw sends parseHouseWithdrawShares(withdrawShares), and nothing else parses the box", () => {
    const click = source.indexOf('act("Request a house vault withdrawal"');
    expect(click).toBeGreaterThan(-1);
    const write = source.indexOf("await requestHouseWithdraw(context(), vault, amount);", click);
    expect(write).toBeGreaterThan(click);
    const body = source.slice(click, write);
    expect(body).toContain("const amount = parseHouseWithdrawShares(withdrawShares);");
    expect(body.match(/const amount = /g)).toHaveLength(1);
    // The gate line and the button judge the same parse.
    expect(source).toContain("houseWithdrawGate(gates, parseHouseWithdrawShares(withdrawShares), shares)");
    expect(source).toMatch(/disabled=\{[^}]*!parseHouseWithdrawShares\(withdrawShares\)[^}]*\}\s*onClick=\{\(\) => void act\("Request a house vault withdrawal"/);
    expect(source).not.toMatch(/parsePositive\(withdrawShares/);
  });

  it("typing 50 in the box is a request for 50 x 10^SHARE_DECIMALS share base units", () => {
    expect(parseHouseWithdrawShares("50")).toBe(50n * 10n ** BigInt(SHARE_DECIMALS));
  });
});

describe("HouseVault: the one action card", () => {
  const tagOf = (html: string, label: string) => {
    const m = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].find((x) => x[2]!.replace(/<[^>]+>/g, "").trim() === label);
    expect(m, label).toBeDefined();
    return m![1]!;
  };
  const selectedTab = (html: string) => html.match(/aria-selected="true"[^>]*><span class="truncate">([^<]+)</)?.[1];
  const withReads = (over: Partial<HouseVaultReads>) => {
    vi.mocked(useHouseVaultReads).mockReturnValue({ data: reads({ epochId: 12n, protocolAccountsConfirmed: true,
      withdrawRequest: { epochId: 0n, shares: 0n }, depositRequest: { epochId: 0n, usdg: 0n, stock: 0n }, ...over }) } as unknown as
      ReturnType<typeof useHouseVaultReads>);
    return renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
  };

  it("Deposit is one form with a USDG | Stock Tokens choice; both amount fields stay mounted", () => {
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain('aria-label="Deposit with"');
    expect(tagOf(html, "USDG")).toContain('aria-pressed="true"');
    expect(tagOf(html, "Stock Tokens")).toContain('aria-pressed="false"');
    for (const id of ["house-deposit-usdg", "house-deposit-stock", "house-withdraw"]) expect(html).toContain(`id="${id}"`);
  });

  it("opens on Deposit; on Requests when a claim is ready; on Withdraw when the vault is winding down", () => {
    expect(selectedTab(withReads({}))).toBe("Deposit");
    expect(selectedTab(withReads({ epochId: 13n, withdrawRequest: { epochId: 12n, shares: 10n ** 18n } }))).toBe("Requests");
    vi.mocked(useHouse).mockReturnValue(houseList(["weekly", "daily"]));
    expect(selectedTab(withReads({}))).toBe("Withdraw");
  });

  it("with no wallet, Connect is the one button to press; every action button waits hidden and disabled", () => {
    vi.mocked(useAccount).mockReturnValue({ address: undefined } as unknown as ReturnType<typeof useAccount>);
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toContain(">Connect wallet<");
    for (const label of ["Queue USDG deposit", "Queue Stock Token deposit", "Request withdrawal", "Claim settled withdrawal"]) {
      expect(tagOf(html, label), label).toContain(' hidden=""');
      expect(tagOf(html, label), label).toContain(' disabled=""');
    }
  });

  it("a Cancel with nothing to cancel folds away; one that is live, or shut for a stated reason, shows", () => {
    const folded = (html: string, slot: string) => new RegExp(`<div[^>]* hidden=""[^>]* data-slot="${slot}"`).test(html);
    const idle = withReads({});
    expect(folded(idle, "house-cancel-deposit")).toBe(true);
    expect(folded(idle, "house-cancel-withdraw")).toBe(true);
    const live = withReads({ withdrawRequest: { epochId: 12n, shares: 1n }, depositRequest: { epochId: 12n, usdg: 5_000_000n, stock: 0n } });
    expect(folded(live, "house-cancel-deposit")).toBe(false);
    expect(folded(live, "house-cancel-withdraw")).toBe(false);
    const priced = withReads({ depositRequest: { epochId: 11n, usdg: 5_000_000n, stock: 0n } });
    expect(folded(priced, "house-cancel-deposit")).toBe(false);
    expect(priced).toContain(`data-slot="house-cancel-deposit-gate">${asRendered(HOUSE_DEPOSIT_PRICED)}`);
  });

  it("the explanations sit behind a \"?\": the instant-deposit rule and the in-kind line are tooltips, in the markup", () => {
    const html = renderToStaticMarkup(createElement(HouseVault, { ticker: "NVDA" }));
    expect(html).toMatch(/role="tooltip"[^>]*><span data-slot="house-instant-deposit-rule">/);
    expect(html).toMatch(/role="tooltip"[^>]*>You get your share of the vault&#x27;s USDG and its NVDA stock, not USDG only\./);
  });
});
