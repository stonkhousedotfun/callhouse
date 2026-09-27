/**
 * The Buy widget appears only when the wallet holds none of the market's stock, and its confirm button
 * is disabled when the quote is refused for price impact. Rendered to static markup, as HouseVault.test.tsx does;
 * wagmi and react-query are mocked, and the quotes are built with the real `assembleQuote`.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useWalletClient } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { getV2Market } from "@/lib/markets";
import { assembleQuote, MAX_PRICE_IMPACT_BPS, routesFor, type BuyBalances, type StockQuote } from "@/lib/v2/stockSwap";
import { BuyStockWidget } from "./BuyStockWidget";

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn(), useQueryClient: vi.fn() }));
vi.mock("wagmi", () => ({ useAccount: vi.fn(), useWalletClient: vi.fn() }));
vi.mock("@/components/TxToast", () => ({ useNotice: vi.fn(), useV2ReceiptNotice: vi.fn() }));

const ONE = 10n ** 18n;
const Q96 = 1n << 96n;
const account = "0x00000000000000000000000000000000000000a1" as const;
const nvda = getV2Market("NVDA")!.asset;

/** A 1 ETH quote on the direct route at price 1 (spot net of fee 0.9995 ETH-units out). */
function quoteWithImpact(outBps: bigint): StockQuote {
  const route = routesFor("ETH", nvda, "NVDA")[0]!;
  return assembleQuote({
    payToken: "ETH", stock: nvda, amountIn: ONE, slippageBps: 50,
    candidates: [{ route, amountOut: ONE * outBps / 10_000n }], sqrtPricesX96: [Q96],
  });
}

let balances: BuyBalances | undefined;
let quote: StockQuote | undefined;

beforeEach(() => {
  balances = { stock: 0n, eth: 2n * ONE, usdg: 0n };
  quote = quoteWithImpact(9_990n);
  vi.mocked(useAccount).mockReturnValue({ address: account } as unknown as ReturnType<typeof useAccount>);
  vi.mocked(useWalletClient).mockReturnValue({ data: {} } as unknown as ReturnType<typeof useWalletClient>);
  vi.mocked(useQueryClient).mockReturnValue({ invalidateQueries: vi.fn() } as unknown as ReturnType<typeof useQueryClient>);
  vi.mocked(useNotice).mockReturnValue(vi.fn() as ReturnType<typeof useNotice>);
  vi.mocked(useV2ReceiptNotice).mockReturnValue(vi.fn() as ReturnType<typeof useV2ReceiptNotice>);
  vi.mocked(useQuery).mockImplementation(((options: { queryKey: readonly unknown[] }) => {
    const kind = options.queryKey[1];
    const data = kind === "balances" ? balances : kind === "quote" ? quote : undefined;
    return { data, isError: false, error: null };
  }) as unknown as typeof useQuery);
});

const render = (initialAmount = "1") => renderToStaticMarkup(createElement(BuyStockWidget, { ticker: "NVDA", initialAmount }));

/** The Buy button's markup: its disabled flag and its text. */
function buyButton(html: string): { disabled: boolean; text: string } {
  const match = [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].find((m) => m[2]!.replace(/<[^>]+>/g, "").trim().startsWith("Buy"));
  if (!match) throw new Error("no Buy button rendered");
  return { disabled: /\sdisabled(=""|\s|$)/.test(match[1]!), text: match[2]!.replace(/<[^>]+>/g, "").trim() };
}

describe("BuyStockWidget visibility", () => {
  it("is hidden when the wallet already holds the stock", () => {
    balances = { stock: 1n, eth: 2n * ONE, usdg: 0n };
    expect(render()).toBe("");
  });

  it("is hidden with no wallet connected, and while the balance is unread", () => {
    vi.mocked(useAccount).mockReturnValue({ address: undefined } as unknown as ReturnType<typeof useAccount>);
    expect(render()).toBe("");
    vi.mocked(useAccount).mockReturnValue({ address: account } as unknown as ReturnType<typeof useAccount>);
    balances = undefined;
    expect(render()).toBe("");
  });

  it("is shown at a zero balance, with the quote, minimum out, impact and route", () => {
    const html = render();
    expect(html).toContain("You hold no NVDA");
    expect(html).toContain("Minimum out");
    expect(html).toContain("Price impact");
    expect(html).toContain("ETH → NVDA");
    expect(buyButton(html)).toEqual({ disabled: false, text: "Buy NVDA" });
  });

  it("amounts drop their zero tails, and the swap detail sits in the heading's \"?\"", () => {
    const html = render();
    expect(html).toContain("Wallet: 2 ETH");
    expect(html).not.toContain("2.0000");
    expect(html).toContain(">0.999 NVDA<"); // you get about
    expect(html).toContain(">0.994 NVDA<"); // minimum out at 0.5% slippage, truncated
    expect(html).toContain(">&lt;0.1%<"); // price impact under a tenth of a percent
    expect(html).toContain('aria-label="About this swap"');
    expect(html).toContain("reverts if you would get less than the minimum");
    expect(html).not.toContain("Network gas extra");
  });

  it("uses the page's stock address when given, and shows nothing for an explicit null", () => {
    const seen: unknown[] = [];
    vi.mocked(useQuery).mockImplementation(((options: { queryKey: readonly unknown[] }) => {
      seen.push(options.queryKey);
      return { data: options.queryKey[1] === "balances" ? balances : quote, isError: false, error: null };
    }) as unknown as typeof useQuery);
    const other = "0x0000000000000000000000000000000000000011" as const;
    expect(renderToStaticMarkup(createElement(BuyStockWidget, { ticker: "NVDA", stock: other, initialAmount: "1" }))).toContain("You hold no NVDA");
    expect(seen[0]).toEqual(["stockSwap", "balances", other, account]);
    expect(renderToStaticMarkup(createElement(BuyStockWidget, { ticker: "NVDA", stock: null }))).toBe("");
  });

  it("renders nothing for a ticker outside the launch set", () => {
    expect(renderToStaticMarkup(createElement(BuyStockWidget, { ticker: "NOPE" }))).toBe("");
  });
});

describe("BuyStockWidget confirm", () => {
  it("disables confirm above the price-impact cap and says why", () => {
    quote = quoteWithImpact(9_600n); // about 3.95% under spot
    expect(quote.impactBps).toBeGreaterThan(MAX_PRICE_IMPACT_BPS);
    const html = render();
    expect(buyButton(html).disabled).toBe(true);
    expect(html).toContain("Price impact too high");
    expect(html).toContain("above the 3% limit");
  });

  it("disables confirm when the amount is more than the wallet holds", () => {
    balances = { stock: 0n, eth: ONE / 2n, usdg: 0n };
    const html = render("1");
    expect(buyButton(html).disabled).toBe(true);
    expect(html).toContain("more ETH than this wallet holds");
  });

  it("disables confirm with no amount entered, even if a quote is cached", () => {
    expect(buyButton(render("")).disabled).toBe(true);
  });
});
