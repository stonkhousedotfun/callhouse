/**
 * TradeTicket driven end to end in node. TradeTicket.test.ts covers the pure exports and the source structure and
 * lib/v2/tradeTicket.test.ts the first render; this file runs the ticket's controls and its submit path.
 *
 * The ticket is one limit-order form: a limit price and a size in shares. When the limit
 * meets enough asks to fill the whole size the order buys now; otherwise what crosses buys now and the rest rests as
 * a bid. "Review order" opens a review step, and only that step's button signs.
 *
 * How, without a DOM: `react`'s useState/useMemo/useEffect are swapped for in-memory slots while the ticket function
 * runs (the harness), the returned element tree is searched for a control and its handler is called directly, and
 * the next render is read as markup (the harness is off then, so child components use real React). Every chain
 * boundary (series and order reads, approve, take, place, the trading brake, the gas reads) is a mock, so a test can
 * say exactly what the chain answers and assert what the ticket then sends and shows.
 *
 * Expected figures are worked by hand from the fixtures (TSLA $380 call, 25 bps exercise fee; one ask of 120 units at
 * 0.3989; best bid 0.3397; fair 0.369263; taker fee min(0.1 USDG flat, 10 % of premium)):
 *   0.10 share = 10 units: premium 10 × 3_989 = 39_890, fee 3_989, cost 43_879.
 *   1.2 shares = 120 units: premium 478_680, fee 47_868, cost 526_548.
 *   A call at price P pays per unit (1e16 × (P − 380)/P − 2.5e13) × P / 1e18 USDG base units: 190_000 at $400,
 *   1_187_500 at $500.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BookResponse, Card, ConfigResponse, SeriesDetailResponse } from "@/lib/v2/api-types";

const h = vi.hoisted(() => ({
  active: false, cursor: 0, slots: [] as unknown[], effects: [] as (() => unknown)[],
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      if (!h.active) return actual.useState(init);
      const i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      return [h.slots[i], (next: unknown) => {
        h.slots[i] = typeof next === "function" ? (next as (v: unknown) => unknown)(h.slots[i]) : next;
      }];
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => (h.active ? fn() : actual.useMemo(fn, deps)),
    useEffect: (fn: () => unknown, deps?: unknown[]) => (h.active ? void h.effects.push(fn) : actual.useEffect(fn as never, deps)),
  };
});

type QueryOptions = { queryKey: unknown[]; queryFn: () => Promise<unknown>; enabled: boolean };
const m = vi.hoisted(() => ({
  address: undefined as Address | undefined,
  wallet: undefined as unknown,
  config: undefined as unknown,
  gas: undefined as unknown,
  gasQuery: null as QueryOptions | null,
  usdg: undefined as bigint | undefined,
  usdgQuery: null as QueryOptions | null,
  invalidate: vi.fn(),
  notice: vi.fn(),
  receipt: vi.fn(() => false),
  offset: 0 as number | null,
  warnings: [] as string[],
  readSeriesOnChain: vi.fn(), readOrderPreflight: vi.fn(), assertSeriesTermsMatch: vi.fn(), staleSelectedOrders: vi.fn(() => []),
  approveExact: vi.fn(), place: vi.fn(), recheckTakeQuote: vi.fn(), restingValidUntil: vi.fn(), take: vi.fn(),
  assertTradingOpen: vi.fn(),
  client: { readContract: vi.fn(), getGasPrice: vi.fn(), getBlock: vi.fn(), estimateContractGas: vi.fn() },
}));
vi.mock("@tanstack/react-query", () => ({
  // Only the ticket's own gas query is recorded; children (ConversionFloor) run their own queries through here too.
  // The wallet's USDG query answers from m.usdg.
  useQuery: (options: QueryOptions) => {
    if (options.queryKey[1] === "wallet-usdg") { m.usdgQuery = options; return { data: m.usdg }; }
    if (options.queryKey[1] === "buy-gas") m.gasQuery = options;
    return { data: m.gas };
  },
  useQueryClient: () => ({ invalidateQueries: m.invalidate }),
}));
vi.mock("wagmi", () => ({ useAccount: () => ({ address: m.address }), useWalletClient: () => ({ data: m.wallet }) }));
vi.mock("@/components/ConnectButton", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return { ConnectButton: () => react.createElement("button", null, "Connect wallet") };
});
vi.mock("@/components/TxToast", () => ({ useNotice: () => m.notice, useV2ReceiptNotice: () => m.receipt }));
vi.mock("@/lib/v2/hooks", () => ({
  useConfig: () => ({ data: m.config }), useMarkets: () => ({ data: undefined, isError: false }), v2Keys: { all: ["v2"] },
}));
vi.mock("@/lib/v2/chainClock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/chainClock")>()), useChainClockOffset: () => m.offset,
}));
vi.mock("@/lib/v2/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/config")>()), v2ConfigWarnings: () => m.warnings,
}));
vi.mock("@/lib/v2/chainReads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/chainReads")>()),
  readSeriesOnChain: m.readSeriesOnChain, readOrderPreflight: m.readOrderPreflight, assertSeriesTermsMatch: m.assertSeriesTermsMatch,
}));
vi.mock("@/lib/v2/ticket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/ticket")>()), staleSelectedOrders: m.staleSelectedOrders,
}));
vi.mock("@/lib/v2/tx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/tx")>()),
  approveExact: m.approveExact, place: m.place, recheckTakeQuote: m.recheckTakeQuote, restingValidUntil: m.restingValidUntil, take: m.take,
}));
vi.mock("@/lib/v2/tradingGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/tradingGate")>()), assertTradingOpen: m.assertTradingOpen,
}));
vi.mock("@/lib/chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain")>()), publicClient: m.client,
}));

import { USDG } from "@/lib/contracts";
import { V2_DEPLOYMENT } from "@/lib/v2/config";
import { TRADING_PAUSED_LINE } from "@/lib/v2/tradingGate";
import { V2ReceiptUnknownError } from "@/lib/v2/txStatus";
import { TradeTicket } from "./TradeTicket";

const fixtures = fileURLToPath(new URL("../../../ops/fixtures/api/v2/", import.meta.url));
const read = <T,>(path: string): T => JSON.parse(readFileSync(`${fixtures}/${path}`, "utf8")) as T;
const hero = read<{ card: Card }>("cards/hero.json").card;
const detail = read<SeriesDetailResponse>(`series/${hero.series.longId}.json`);
const book = read<BookResponse>(`series/${hero.series.longId}/book.json`);
const config = read<ConfigResponse>("config.json");
const ACCOUNT = "0x00000000000000000000000000000000000000a1" as Address;
const LONG_ID = BigInt(detail.series.longId);
const NOW_S = 1_789_600_000; // after the book snapshot, before the mint cutoff (1789759800)
const CHAIN_SERIES = { exists: true, series: { mintFeePpm: 0, expiry: BigInt(detail.series.expiry) },
  collateral: 10n ** 16n, snapshotTimestamp: NOW_S, cutoff: BigInt(detail.series.mintCutoff), blockNumber: 1n };
const ASK = 398_900n; // the only ask level: 120 units
const MAX_UINT128 = (1n << 128n) - 1n;

type Props = ComponentProps<typeof TradeTicket>;
let props: Props;
let tree: ReactNode = null;
function run(): string {
  h.active = true; h.cursor = 0; h.effects = [];
  try { tree = TradeTicket(props); } finally { h.active = false; }
  return renderToStaticMarkup(createElement("div", null, tree));
}
/** A fresh mount: first render plus the mount effects (the clock tick), then the settled render. */
function mount(over: Partial<Props> = {}): string {
  h.slots = [];
  props = { ticker: detail.series.ticker, detail, book, target: BigInt(hero.target.raw), spot: BigInt(hero.spot!.raw),
    marketSettlement: undefined, onRefresh: vi.fn(), ...over };
  run();
  h.effects.forEach((fn) => fn());
  return run();
}
type El = ReactElement<Record<string, unknown>>;
function findWhere(pred: (p: Record<string, unknown>) => boolean): El {
  const walk = (n: unknown): El | null => {
    if (Array.isArray(n)) { for (const c of n) { const r = walk(c); if (r) return r; } return null; }
    if (!isValidElement(n)) return null;
    const p = n.props as Record<string, unknown>;
    if (pred(p)) return n as El;
    for (const v of Object.values(p)) { const r = walk(v); if (r) return r; }
    return null;
  };
  const hit = walk(tree);
  if (!hit) throw new Error("no such element");
  return hit;
}
const textOf = (n: unknown): string => typeof n === "string" || typeof n === "number" ? String(n)
  : Array.isArray(n) ? n.map(textOf).join("") : isValidElement(n) ? textOf((n.props as { children?: unknown }).children) : "";
/** A clickable control by its text, its aria-label, or a StepButton's `label`. */
const control = (label: string) => findWhere((p) => typeof p.onClick === "function"
  && (textOf(p.children) === label || p["aria-label"] === label || p.label === label));
const click = (label: string) => { (control(label).props.onClick as () => void)(); return run(); };
/** The Bid / Mark / Ask chips that fill the limit price: the first span names the chip. */
const chip = (name: string) => findWhere((p) => typeof p.onClick === "function" && Array.isArray(p.children)
  && textOf(p.children[0]) === name);
const press = (el: El) => { (el.props.onClick as () => void)(); return run(); };
const input = (id: string, value: string | boolean) => {
  (findWhere((p) => p.id === id || (id === "partial" && p.type === "checkbox")).props.onChange as (e: unknown) => void)({ target: { value, checked: value } });
  return run();
};
const valueOf = (id: string) => findWhere((p) => p.id === id).props.value;
const review = () => click("Review order");
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
async function submit(): Promise<string> {
  const button = findWhere((p) => typeof p.onClick === "function" && ["Buy now", "Place bid"].includes(textOf(p.children)) && p.disabled !== undefined);
  (button.props.onClick as () => void)();
  await flush();
  return run();
}
const buyButton = () => findWhere((p) => p.disabled !== undefined && ["Buy now", "Place bid", "Confirming…"].includes(textOf(p.children)));
const notices = () => m.notice.mock.calls.map((c) => [c[0], c[1]]);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The value cell of the summary row whose key starts with `key` (SummaryRow renders <dt>key…</dt><dd>value</dd>). */
const rowValue = (html: string, key: string) =>
  html.match(new RegExp(`<dt data-slot="k"[^>]*>${escapeRe(key)}(?:(?!</dt>).)*</dt><dd data-slot="v"[^>]*>(.*?)</dd>`, "s"))?.[1];
const maxLoss = (html: string) => html.match(/<span data-slot="max-loss"[^>]*>(.*?)<\/span>/)?.[1];
const order = (fn: { mock: { invocationCallOrder: number[] } }, call = 0) => fn.mock.invocationCallOrder[call]!;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_S * 1000);
  vi.stubGlobal("window", { setInterval: vi.fn(() => 7), clearInterval: vi.fn() });
  h.slots = []; h.effects = [];
  m.address = ACCOUNT; m.wallet = { id: "wallet" }; m.config = config; m.gas = undefined; m.offset = 0; m.warnings = [];
  m.usdg = undefined; m.usdgQuery = null;
  for (const fn of [m.invalidate, m.notice, m.receipt, m.readSeriesOnChain, m.readOrderPreflight, m.assertSeriesTermsMatch,
    m.staleSelectedOrders, m.approveExact, m.place, m.recheckTakeQuote, m.restingValidUntil, m.take, m.assertTradingOpen,
    ...Object.values(m.client)]) fn.mockReset();
  m.receipt.mockReturnValue(false);
  m.staleSelectedOrders.mockReturnValue([]);
  m.readSeriesOnChain.mockResolvedValue(CHAIN_SERIES);
  m.readOrderPreflight.mockResolvedValue([]);
  m.recheckTakeQuote.mockImplementation(async (_c: unknown, request: object) => ({ ...request, deadline: 1, maxTotalFee: 1n }));
  m.take.mockResolvedValue({ unitsFilled: 120n });
  m.restingValidUntil.mockResolvedValue(detail.series.expiry - 60);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("TradeTicket: the clock and the write gates", () => {
  it("ticks the page clock every second, notices expiry on the next tick, and clears it on unmount", () => {
    vi.setSystemTime((detail.series.expiry - 1) * 1000);
    expect(mount()).not.toContain("This series has expired");
    const [tick, every] = (window.setInterval as unknown as ReturnType<typeof vi.fn>).mock.calls[0]! as [() => void, number];
    expect(every).toBe(1_000);
    vi.setSystemTime(detail.series.expiry * 1000);
    tick();
    expect(run()).toContain("This series has expired or entered settlement.");
    const cleanup = h.effects[0]!() as () => void;
    cleanup();
    expect(window.clearInterval).toHaveBeenCalledWith(7);
  });

  it("opens the review from the edit step; Buy now there needs a wallet, a matching config, a live price and the brake off", async () => {
    mount();
    expect(() => buyButton()).toThrow(); // the edit step never signs
    let html = review();
    expect(html).toContain('data-slot="order-review"');
    expect(buyButton().props.disabled).toBe(false);
    click("Edit order");
    expect(() => buyButton()).toThrow();

    const gates: [string, () => void, string | null][] = [
      ["config mismatch", () => { m.warnings = ["orderBook address differs from the generated registry."]; }, "Trading is paused while app settings are out of sync."],
      ["no live price", () => { props.spot = null; }, "Live price unavailable. Trading is paused until it returns."],
      ["brake on", () => { props.tradingPaused = true; }, TRADING_PAUSED_LINE],
      ["no wallet client", () => { m.wallet = undefined; }, null],
    ];
    for (const [name, apply, line] of gates) {
      m.warnings = []; m.wallet = { id: "wallet" };
      mount();
      apply();
      html = run();
      html = review();
      if (line) expect(html, name).toContain(line);
      expect(buyButton().props.disabled, name).toBe(true);
      // submit() refuses on its own too: pressing the disabled button reaches no chain read or write.
      await submit();
      expect(m.assertTradingOpen, name).not.toHaveBeenCalled();
      expect(m.approveExact, name).not.toHaveBeenCalled();
    }
  });

  it("judges expiry on the chain's clock, treats an unmeasured clock as expired, and disables Buy now then", () => {
    m.offset = detail.series.expiry - NOW_S; // the chain is already at expiry while the browser is not
    mount();
    expect(review()).toContain("This series has expired or entered settlement.");
    expect(buyButton().props.disabled).toBe(true);
    m.offset = null;
    mount();
    expect(review()).toContain("This series has expired or entered settlement.");
    expect(buyButton().props.disabled).toBe(true);
    m.offset = 0;
    expect(mount({ detail: { ...detail, series: { ...detail.series, status: "settled" } } })).toContain("This series has expired");
    mount();
    expect(review()).not.toContain("This series has expired");
    expect(buyButton().props.disabled).toBe(false);
  });

  it("shows Connect wallet in place of Review order without an account", () => {
    m.address = undefined;
    const html = mount();
    expect(html).toContain("Connect wallet");
    expect(() => control("Review order")).toThrow();
    expect(m.gasQuery!.enabled).toBe(false);
  });

  it("says fees are unavailable before /v2/config loads, and the book unavailable without a book, with Review order off", () => {
    m.config = undefined;
    expect(mount()).toContain("Fees are unavailable, so there is no quote yet.");
    expect(control("Review order").props.disabled).toBe(true);
    m.config = config;
    expect(mount({ book: null })).toContain("Order book unavailable. Refresh in a moment.");
    expect(control("Review order").props.disabled).toBe(true);
  });

  it("warns when the book is rebuilt from chain", () => {
    expect(mount({ bookDegraded: true })).toContain("Quote built from on-chain orders.");
    expect(mount()).not.toContain("Quote built from on-chain orders.");
  });
});

describe("TradeTicket: size and limit price", () => {
  it("quotes 1.2 shares at the 0.3989 ask plus the capped taker fee, and reports each quote by value", () => {
    const onQuote = vi.fn();
    let html = mount({ onQuote });
    expect(valueOf("ticket-bid-price")).toBe("0.3989"); // the limit starts at the lowest ask
    expect(valueOf("ticket-shares")).toBe("0.10");
    h.effects[1]!();
    expect(onQuote).toHaveBeenLastCalledWith({ longId: detail.series.longId, units: 10n, premium: 39_890n, cost: 43_879n });
    html = input("ticket-shares", "1.2");
    expect(rowValue(html, "Order")).toBe("Buys now");
    expect(maxLoss(html)).toBe("$0.53"); // 526_548, rounded up
    expect(rowValue(html, "If TSLA reaches $400")).toBe("$22.80 · 43.3×"); // 120 × 190_000; 22_800_000 / 526_548
    h.effects[1]!();
    expect(onQuote).toHaveBeenLastCalledWith({ longId: detail.series.longId, units: 120n, premium: 478_680n, cost: 526_548n });
    html = review();
    expect(rowValue(html, "Premium")).toBe("$0.48");
    expect(rowValue(html, "Fee")).toBe("$0.048"); // 10 % of premium; the 0.1 USDG flat is higher
    expect(rowValue(html, "Max loss")).toBe("$0.53");
    expect(html).toContain("Buy 1.20 sh of the TSLA $380 Call");
  });

  it("refuses a size that is not a positive 0.01-share step: the alert shows and Review order is off", () => {
    mount();
    for (const bad of ["0.015", "0", "-1", "1e2", ""]) {
      const html = input("ticket-shares", bad);
      expect(html, bad).toContain("Enter a positive quantity in 0.01-share steps.");
      expect(html, bad).toContain("Enter a size.");
      expect(control("Review order").props.disabled, bad).toBe(true);
    }
    expect(input("ticket-shares", "0.01")).not.toContain("Enter a positive quantity");
    expect(control("Review order").props.disabled).toBe(false);
  });

  it("steps the size in whole shares with a floor of one", () => {
    mount(); // 0.10
    click("Increase size");
    expect(valueOf("ticket-shares")).toBe("1");
    click("Increase size");
    expect(valueOf("ticket-shares")).toBe("2");
    click("Decrease size");
    click("Decrease size");
    expect(valueOf("ticket-shares")).toBe("1");
  });

  it("does not buy a partial size: what the asks cannot fill at the limit rests as a bid, shown before review", () => {
    mount();
    let html = input("ticket-shares", "2"); // the book holds 1.2 shares at or under the 0.3989 limit
    expect(rowValue(html, "Order")).toBe("1.2 sh now, rest as a bid");
    expect(maxLoss(html)).toBe("$0.85"); // 526_548 crossing + 319_120 held for 0.8 share at 0.3989
    expect(html).not.toContain('data-slot="ticket-advanced"'); // no partial-fill choice on a bid
    expect(html).not.toContain('data-slot="payoff-explorer"');
    html = review();
    expect(rowValue(html, "Buys now")).toBe("1.2 sh · $0.53");
    expect(rowValue(html, "Waits as a bid")).toBe("0.8 sh · $0.32 held");
    expect(textOf(buyButton().props.children)).toBe("Place bid");
  });

  it("fills the limit from the Bid, Mark and Ask chips on the 0.0001 tick, and refuses an off-tick limit", () => {
    mount();
    let html = press(chip("Bid"));
    expect(valueOf("ticket-bid-price")).toBe("0.3397");
    expect(chip("Bid").props["aria-pressed"]).toBe(true);
    expect(rowValue(html, "Order")).toBe("Waits as a bid"); // below every ask
    press(chip("Mark"));
    expect(valueOf("ticket-bid-price")).toBe("0.3692"); // fair 0.369263, rounded down onto the tick
    html = press(chip("Ask"));
    expect(valueOf("ticket-bid-price")).toBe("0.3989");
    expect(chip("Ask").props["aria-pressed"]).toBe(true);
    expect(chip("Bid").props["aria-pressed"]).toBe(false);
    expect(rowValue(html, "Order")).toBe("Buys now");
    for (const bad of ["0.39895", "0", "-0.3"]) {
      html = input("ticket-bid-price", bad);
      expect(html, bad).toContain("Use a positive price in 0.0001 USDG steps.");
      expect(html, bad).toMatch(/id="ticket-bid-price"[^>]*aria-invalid="true"/);
      expect(html, bad).toContain("Enter a limit price.");
      expect(control("Review order").props.disabled, bad).toBe(true);
    }
  });

  it("shows the P&L at the chart handle's price when one is set", () => {
    let html = mount({ atPrice: 500_000_000n });
    expect(rowValue(html, "At $500")).toBe("+$11.83"); // 10 × 1_187_500 − 43_879
    html = mount({ atPrice: 300_000_000n });
    expect(rowValue(html, "At $300")).toBe("−$0.044"); // below the strike: the whole cost
    expect(mount()).not.toContain('data-slot="at-price"');
  });
});

describe("TradeTicket: gas estimate", () => {
  it("reads the USDG allowance for the order book first, and says two transactions with no figure when it is short", async () => {
    mount();
    expect(m.gasQuery!.enabled).toBe(true);
    m.client.readContract.mockResolvedValue(43_878n); // one short of premium 39_890 + fee 3_989
    await expect(m.gasQuery!.queryFn()).resolves.toMatchObject({ transactions: 2, wei: null });
    expect(m.client.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: USDG, functionName: "allowance", args: [ACCOUNT, V2_DEPLOYMENT.contracts.orderBook] }));
    expect(m.client.estimateContractGas).not.toHaveBeenCalled();
  });

  it("estimates the take at the live gas price once the allowance covers it, with a bounded deadline", async () => {
    mount();
    m.client.readContract.mockResolvedValue(43_879n);
    m.client.getGasPrice.mockResolvedValue(3n);
    m.client.getBlock.mockResolvedValue({ timestamp: 1_000n });
    m.client.estimateContractGas.mockResolvedValue(100_000n);
    await expect(m.gasQuery!.queryFn()).resolves.toMatchObject({ transactions: 1, wei: 300_000n });
    const [call] = m.client.estimateContractGas.mock.calls[0]! as [{ args: [Record<string, unknown>] }];
    expect(call.args[0]).toMatchObject({ deadline: 1_300, orderIds: [1049n], units: 10n, minUnits: 10n, limitPrice: ASK,
      recipient: ACCOUNT, maxTotalFee: MAX_UINT128 });
  });

  it("reports one transaction with no figure when the estimate fails", async () => {
    mount();
    m.client.readContract.mockResolvedValue(10n ** 12n);
    m.client.getGasPrice.mockRejectedValue(new Error("rpc"));
    m.client.getBlock.mockResolvedValue({ timestamp: 1n });
    await expect(m.gasQuery!.queryFn()).resolves.toMatchObject({ transactions: 1, wei: null });
  });
});

describe("TradeTicket: buying", () => {
  function buyReview(shares = "1.2", over: Partial<Props> = {}) {
    mount(over);
    input("ticket-shares", shares);
    return review();
  }

  it("checks the brake, re-reads the series and orders, approves exactly premium plus fee, then takes at the reader's limit", async () => {
    const onRefresh = vi.fn();
    const chainOrder = { maker: ACCOUNT, longId: LONG_ID, kind: 2, price: ASK, units: 120n, filled: 0n, validUntil: 1n, cancelled: false };
    m.readOrderPreflight.mockResolvedValue([{ orderId: 1049n, order: chainOrder, freeCollateral: 5n }]);
    buyReview("1.2", { onRefresh });
    const html = await submit();
    // The fresh chain orders are flattened for the staleness check, collateral included.
    expect((m.staleSelectedOrders.mock.calls[0] as unknown[])[1]).toEqual([{ orderId: 1049n, ...chainOrder, freeCollateral: 5n }]);
    expect(m.assertTradingOpen).toHaveBeenCalledTimes(1);
    expect(m.readSeriesOnChain).toHaveBeenCalledWith(LONG_ID);
    expect(m.readOrderPreflight.mock.calls[0]!.slice(0, 2)).toEqual([[1049n], detail.series.underlying]);
    expect(m.assertSeriesTermsMatch).toHaveBeenCalled();
    const [, token, spender, amount] = m.approveExact.mock.calls[0]!;
    expect(token).toBe(config.usdg.address);
    expect(spender).toBe(V2_DEPLOYMENT.contracts.orderBook);
    expect(amount).toBe(478_680n + 47_868n); // premium + the taker fee, capped at 10% of premium (the 0.1 flat is higher)
    expect(m.approveExact).toHaveBeenCalledTimes(1);
    expect(m.recheckTakeQuote).toHaveBeenCalledTimes(2);
    expect(m.recheckTakeQuote.mock.calls[0]![2]).toEqual({ filled: 120n, premium: 478_680n, takerFee: 47_868n, sellerFees: 0n });
    expect(m.take.mock.calls[0]![1]).toMatchObject({ longId: LONG_ID, buying: true, orderIds: [1049n], units: 120n, minUnits: 120n,
      limitPrice: ASK, writeToSell: false, recipient: ACCOUNT });
    // Brake first, then the chain reads, the requote, the one approval, the requote again, the take.
    expect(order(m.assertTradingOpen)).toBeLessThan(order(m.readSeriesOnChain));
    expect(order(m.readOrderPreflight)).toBeLessThan(order(m.recheckTakeQuote, 0));
    expect(order(m.recheckTakeQuote, 0)).toBeLessThan(order(m.approveExact));
    expect(order(m.approveExact)).toBeLessThan(order(m.recheckTakeQuote, 1));
    expect(order(m.recheckTakeQuote, 1)).toBeLessThan(order(m.take));
    expect(m.place).not.toHaveBeenCalled();
    expect(html).toContain("Bought 1.2 shares.");
    expect(notices()).toEqual([["pending", "Confirm your buy"], ["success", "Buy confirmed"]]);
    expect(onRefresh).toHaveBeenCalled();
    // The write context refreshes every v2 query once a transaction confirms.
    (m.take.mock.calls[0]![0] as { onConfirmed: () => void }).onConfirmed();
    expect(m.invalidate).toHaveBeenCalledWith({ queryKey: ["v2"] });
  });

  it("takes with minUnits 1 only when the reader allows a partial fill", async () => {
    mount();
    input("ticket-shares", "1.2");
    expect(input("partial", true)).toContain("Partial fills on");
    review();
    await submit();
    expect(m.take.mock.calls[0]![1]).toMatchObject({ units: 120n, minUnits: 1n });
    expect(m.recheckTakeQuote.mock.calls[0]![1]).toMatchObject({ units: 120n, minUnits: 1n });
  });

  it("says the fill size is unknown when the take cannot report it", async () => {
    m.take.mockResolvedValue({ unitsFilled: null });
    buyReview();
    expect(await submit()).toContain("Buy confirmed. Check Portfolio for the filled size.");
    expect(m.notice).toHaveBeenLastCalledWith("success", "Buy confirmed", "Couldn't read the fill size. Check Portfolio before trading again.", expect.any(Array));
  });

  it("refuses when the option is gone from chain or an ask changed, and never approves", async () => {
    m.readSeriesOnChain.mockResolvedValueOnce({ ...CHAIN_SERIES, exists: false });
    buyReview();
    await submit();
    expect(m.notice).toHaveBeenLastCalledWith("error", "Trade stopped", "This option is no longer on chain.");
    m.staleSelectedOrders.mockReturnValueOnce([{}] as never);
    run();
    await submit();
    expect(m.notice).toHaveBeenLastCalledWith("error", "Trade stopped", "An ask changed. Refresh and review your quote.");
    expect(m.approveExact).not.toHaveBeenCalled();
    expect(m.take).not.toHaveBeenCalled();
  });

  it("stops a buy and a bid before any chain read or write when the book's brake is on", async () => {
    m.assertTradingOpen.mockRejectedValue(new Error(TRADING_PAUSED_LINE));
    buyReview();
    await submit();
    expect(m.notice).toHaveBeenLastCalledWith("error", "Trade stopped", TRADING_PAUSED_LINE);
    mount();
    input("ticket-bid-price", "0.30");
    review();
    expect(textOf(buyButton().props.children)).toBe("Place bid");
    await submit();
    expect(m.assertTradingOpen).toHaveBeenCalledTimes(2);
    expect(m.notice).toHaveBeenLastCalledWith("error", "Trade stopped", TRADING_PAUSED_LINE);
    for (const write of [m.readSeriesOnChain, m.approveExact, m.take, m.place]) expect(write).not.toHaveBeenCalled();
  });

  it("hands an unknown receipt to the receipt notice instead of an error toast", async () => {
    const unknown = new V2ReceiptUnknownError("0x01", "take", null);
    m.take.mockRejectedValueOnce(unknown);
    m.receipt.mockReturnValueOnce(true);
    buyReview();
    await submit();
    expect(m.receipt).toHaveBeenCalledWith(unknown);
    expect(notices().map((n) => n[0])).toEqual(["pending"]);
  });

  it("shows Confirming… and disables the button and Edit order while the trade is pending", async () => {
    let release!: () => void;
    m.assertTradingOpen.mockReturnValueOnce(new Promise<void>((r) => { release = r; }));
    buyReview();
    (buyButton().props.onClick as () => void)();
    const html = run();
    expect(html).toContain("Confirming…");
    expect(buyButton().props.disabled).toBe(true);
    expect(control("Edit order").props.disabled).toBe(true);
    release();
    await flush();
    expect(run()).not.toContain("Confirming…");
  });
});

describe("TradeTicket: bidding", () => {
  function bidEdit(shares: string, price: string) {
    mount();
    input("ticket-shares", shares);
    return input("ticket-bid-price", price);
  }

  it("rests the whole size as a bid when the limit is below every ask, holding price × size", () => {
    let html = bidEdit("1", "0.30");
    expect(rowValue(html, "Order")).toBe("Waits as a bid");
    expect(maxLoss(html)).toBe("$0.30");
    html = review();
    expect(rowValue(html, "Buys now")).toBe("0 sh · $0.00");
    expect(rowValue(html, "Waits as a bid")).toBe("1 sh · $0.30 held");
    expect(textOf(buyButton().props.children)).toBe("Place bid");
    expect(buyButton().props.disabled).toBe(false);
  });

  it("places a non-crossing bid for the whole size at a valid expiry", async () => {
    bidEdit("1", "0.30");
    review();
    const html = await submit();
    expect(m.take).not.toHaveBeenCalled();
    expect(m.approveExact.mock.calls[0]![3]).toBe(300_000n); // 0.30 × 1 share
    expect(m.place.mock.calls[0]!.slice(1)).toEqual([LONG_ID, 0, 300_000n, 100n, detail.series.expiry - 60]);
    expect(order(m.assertTradingOpen)).toBeLessThan(order(m.approveExact));
    expect(html).toContain("1 share resting as a bid.");
    expect(notices()).toEqual([["success", "Bid confirmed"]]);
  });

  it("buys the crossing part at the ask first, then rests the remainder", async () => {
    expect(rowValue(bidEdit("2", "0.40"), "Order")).toBe("1.2 sh now, rest as a bid");
    review();
    const html = await submit();
    expect(m.take.mock.calls[0]![1]).toMatchObject({ units: 120n, minUnits: 120n });
    expect(m.approveExact.mock.calls.map((c) => c[3])).toEqual([478_680n + 47_868n, 320_000n]); // the take, then 0.40 × 0.8 share
    expect(m.place.mock.calls[0]!.slice(1)).toEqual([LONG_ID, 0, 400_000n, 80n, detail.series.expiry - 60]);
    expect(order(m.take)).toBeLessThan(order(m.place));
    expect(html).toContain("1.2 shares bought now. 0.8 shares resting as a bid.");
    expect(notices()).toEqual([["pending", "Buying at the ask first"], ["success", "Bid confirmed"]]);
  });

  it("stops before placing the rest when the crossing fill cannot be verified", async () => {
    m.take.mockResolvedValue({ unitsFilled: 100n });
    bidEdit("2", "0.40");
    review();
    const html = await submit();
    expect(m.place).not.toHaveBeenCalled();
    expect(m.approveExact).toHaveBeenCalledTimes(1);
    expect(html).toContain("Bought at the ask. Check Portfolio before placing the rest of your bid.");
  });

  it("reports a bought-now, rest-failed bid as partial with the reason", async () => {
    m.restingValidUntil.mockResolvedValue(null);
    bidEdit("2", "0.40");
    review();
    const html = await submit();
    expect(m.place).not.toHaveBeenCalled();
    expect(html).toContain("Bought 1.2 shares now. The rest of your bid could not be confirmed.");
    expect(m.notice.mock.calls.at(-1)![2]).toContain("This series is too close to expiry for a new bid.");
  });

  it("reports an unknown remainder receipt after a crossing fill as such", async () => {
    m.place.mockRejectedValue(new V2ReceiptUnknownError("0x02", "place", null));
    bidEdit("2", "0.40");
    review();
    const html = await submit();
    expect(m.receipt).toHaveBeenCalled();
    expect(html).toContain("Bought 1.2 shares now. The remaining bid transaction was submitted, but its status is unknown.");
  });

  it("reports an unknown approval receipt on a non-crossing bid", async () => {
    m.approveExact.mockRejectedValue(new V2ReceiptUnknownError("0x03", "approve", null));
    m.receipt.mockReturnValue(true);
    bidEdit("1", "0.30");
    review();
    const html = await submit();
    expect(m.place).not.toHaveBeenCalled();
    expect(html).toContain("The USDG approval for the bid was submitted, but its status is unknown. The bid was not placed.");
  });

  it("refuses a bid when the option has left the chain", async () => {
    m.readSeriesOnChain.mockResolvedValue({ ...CHAIN_SERIES, exists: false });
    bidEdit("1", "0.30");
    review();
    await submit();
    expect(m.notice).toHaveBeenLastCalledWith("error", "Trade stopped", "This option is no longer on chain.");
    expect(m.approveExact).not.toHaveBeenCalled();
    expect(m.place).not.toHaveBeenCalled();
  });
});

describe("TradeTicket: the wallet's USDG", () => {
  // The default order is 0.10 share at the 0.3989 ask: premium 39_890 + fee 3_989 = 43_879 USDG base units.
  const COST = 43_879n;
  const shortfall = (html: string) => html.match(/<span data-slot="usdg-shortfall">(.*?)<\/span>/)?.[1];
  const reviewButton = () => control("Review order");

  it("reads balanceOf on the configured USDG for the connected account, and shows it beside the cost", async () => {
    m.usdg = 5_000_000n;
    const html = mount();
    expect(m.usdgQuery!.enabled).toBe(true);
    expect(m.usdgQuery!.queryKey).toEqual(["v2", "wallet-usdg", ACCOUNT, config.usdg.address]);
    m.client.readContract.mockResolvedValueOnce(5_000_000n);
    expect(await m.usdgQuery!.queryFn()).toBe(5_000_000n);
    expect(m.client.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: config.usdg.address, functionName: "balanceOf", args: [ACCOUNT] }));
    expect(rowValue(html, "Your USDG")).toBe("$5.00");
    expect(shortfall(html)).toBeUndefined();
    expect(reviewButton().props.disabled).toBe(false);
    expect(review()).toContain('data-slot="order-review"');
    expect(buyButton().props.disabled).toBe(false);
  });

  it("a wallet with no USDG is told what the order needs and where to get it, and cannot review or sign", async () => {
    m.usdg = 0n;
    let html = mount();
    expect(rowValue(html, "Your USDG")).toBe("$0.00");
    expect(shortfall(html)).toBe("You need $0.044 of USDG and your wallet has $0.00. Calls are paid in USDG, not TSLA Stock Tokens.");
    expect(html).toContain('href="/sell/tsla?tab=swap"');
    expect(html).toContain("Swap TSLA for USDG");
    expect(reviewButton().props.disabled).toBe(true);
    html = review(); // the handler refuses on its own too
    expect(html).not.toContain('data-slot="order-review"');
    expect(m.approveExact).not.toHaveBeenCalled();
  });

  it("blocks signing when the balance drops after the review, before any chain read or write", async () => {
    m.usdg = 5_000_000n;
    mount();
    review();
    m.usdg = 0n;
    const html = run();
    expect(shortfall(html)).toContain("You need $0.044 of USDG");
    expect(buyButton().props.disabled).toBe(true);
    await submit();
    expect(m.assertTradingOpen).not.toHaveBeenCalled();
    expect(m.approveExact).not.toHaveBeenCalled();
  });

  it("exactly the cost is enough, one base unit less is short, and an unread balance never blocks", () => {
    m.usdg = COST;
    expect(shortfall(mount())).toBeUndefined();
    expect(reviewButton().props.disabled).toBe(false);
    m.usdg = COST - 1n;
    expect(shortfall(mount())).toContain("You need $0.044 of USDG and your wallet has $0.043.");
    expect(reviewButton().props.disabled).toBe(true);
    m.usdg = undefined;
    const html = mount();
    expect(rowValue(html, "Your USDG")).toBe("—");
    expect(shortfall(html)).toBeUndefined();
    expect(reviewButton().props.disabled).toBe(false);
  });

  it("counts a bid's held USDG: a resting bid the wallet cannot fund is refused the same way", () => {
    m.usdg = 299_999n;
    mount();
    input("ticket-shares", "1");
    const html = input("ticket-bid-price", "0.30"); // rests 1 share at 0.30: 300_000 held
    expect(rowValue(html, "Order")).toBe("Waits as a bid");
    expect(shortfall(html)).toBe("You need $0.30 of USDG and your wallet has $0.29. Calls are paid in USDG, not TSLA Stock Tokens.");
    expect(reviewButton().props.disabled).toBe(true);
  });

  it("with no wallet connected there is no USDG row, no read and no shortfall line", () => {
    m.address = undefined;
    m.usdg = 0n;
    const html = mount();
    expect(m.usdgQuery!.enabled).toBe(false);
    expect(rowValue(html, "Your USDG")).toBeUndefined();
    expect(shortfall(html)).toBeUndefined();
  });
});
