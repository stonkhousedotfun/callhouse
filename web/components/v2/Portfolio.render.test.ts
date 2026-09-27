/**
 * Portfolio driven end to end in node: the page's states and tabs, and every card's write path (sell, list,
 * collect, buy back, close, cancel, edit, withdraw, the payout preference and the lend-queue actions).
 * Portfolio.test.ts covers the presentational exports; this file covers the stateful page and cards.
 *
 * How, without a DOM: `react`'s useState/useMemo/useEffect are swapped for in-memory slots while a component
 * function runs (the harness; each mounted component keeps its own slots), the returned element tree is searched
 * for a control whose handler is then called directly, and the next render is read as markup (the harness is off
 * then, so children use real React). Cards the page does not export (OrderCard, Ledger, the short row) are mounted
 * from the element the page rendered, with the props the page gave them. Every chain read and write is a mock.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountOrder, BookResponse, ConfigResponse, HistoryResponse, LongPosition, PositionsResponse,
  ShortPosition } from "@/lib/v2/api-types";

// ---- hook harness ----
const h = vi.hoisted(() => ({
  active: false, cursor: 0, slots: [] as unknown[], effects: [] as (() => unknown)[],
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (init: unknown) => {
      if (!h.active) return actual.useState(init);
      const slots = h.slots;
      const i = h.cursor++;
      if (!(i in slots)) slots[i] = typeof init === "function" ? (init as () => unknown)() : init;
      return [slots[i], (next: unknown) => {
        slots[i] = typeof next === "function" ? (next as (v: unknown) => unknown)(slots[i]) : next;
      }];
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => (h.active ? fn() : actual.useMemo(fn, deps)),
    useEffect: (fn: () => unknown, deps?: unknown[]) => (h.active ? void h.effects.push(fn) : actual.useEffect(fn as never, deps)),
  };
});

// ---- module boundaries ----
type Query = { data?: unknown; isPending?: boolean; isError?: boolean; hasNextPage?: boolean; isFetchingNextPage?: boolean;
  fetchNextPage?: () => unknown };
type QueryOptions = { queryKey: unknown[]; queryFn: (ctx?: unknown) => unknown; enabled?: boolean; getNextPageParam?: (last: unknown) => unknown };
const m = vi.hoisted(() => ({
  address: undefined as Address | undefined,
  wallet: { id: "wallet" } as unknown,
  config: undefined as unknown,
  warnings: [] as string[],
  positions: {} as Query,
  markets: {} as Query,
  strategies: {} as Query,
  books: {} as Record<string, Query>,
  fair: {} as Query,
  history: {} as Query,
  queries: {} as Record<string, Query>,
  queryOptions: {} as Record<string, QueryOptions>,
  infiniteOptions: null as QueryOptions | null,
  invalidate: vi.fn(async () => undefined),
  notice: vi.fn(),
  receipt: vi.fn(() => false),
  offset: 0 as number | null,
  chain: {
    assertPortfolioSeries: vi.fn(), assertPayoutPrefsMatch: vi.fn(), assertSeriesTermsMatch: vi.fn(), readAccountOnChain: vi.fn(),
    readOrderPreflight: vi.fn(), readPayoutPrefs: vi.fn(), readSeriesOnChain: vi.fn(),
  },
  tx: {
    approveExact: vi.fn(), cancel: vi.fn(), chainNow: vi.fn(), close: vi.fn(), place: vi.fn(), redeem: vi.fn(), replace: vi.fn(),
    restingValidUntil: vi.fn(), setPayoutInKind: vi.fn(), setTokenApproval: vi.fn(), recheckTakeQuote: vi.fn(), take: vi.fn(), withdraw: vi.fn(),
  },
  cancelQueuedRequest: vi.fn(), claimDeferredPayment: vi.fn(), claimOrderBookOwed: vi.fn(), readWriterRent: vi.fn(),
  readOptionRedeemPreview: vi.fn(), assertTradingOpen: vi.fn(), staleSelectedOrders: vi.fn(() => []),
  getServices: vi.fn(), getHistory: vi.fn(),
  client: { readContract: vi.fn() },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: QueryOptions) => {
    const key = String(options.queryKey[1]);
    m.queryOptions[key] = options;
    return { isPending: false, isError: false, data: undefined, ...m.queries[key] };
  },
  useInfiniteQuery: (options: QueryOptions) => { m.infiniteOptions = options; return m.history; },
  useQueryClient: () => ({ invalidateQueries: m.invalidate }),
}));
vi.mock("wagmi", () => ({ useAccount: () => ({ address: m.address }), useWalletClient: () => ({ data: m.wallet }) }));
vi.mock("@/components/ConnectButton", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return { ConnectButton: () => react.createElement("button", null, "Connect wallet") };
});
vi.mock("@/components/TxToast", () => ({ useNotice: () => m.notice, useV2ReceiptNotice: () => m.receipt }));
vi.mock("@/lib/v2/hooks", () => ({
  useBook: (longId: string) => m.books[longId] ?? { data: undefined, isError: false },
  useConfig: () => ({ data: m.config }),
  useEarn: () => ({ data: undefined }),
  useFair: () => m.fair,
  useMarkets: () => m.markets,
  useOrderBookOwed: () => ({ data: undefined }),
  usePositions: () => m.positions,
  useSeries: () => ({ data: undefined }),
  useStrategies: () => m.strategies,
  v2Keys: { all: ["v2"] },
}));
vi.mock("@/lib/v2/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/api")>()),
  v2Api: { getServices: m.getServices, getHistory: m.getHistory },
}));
vi.mock("@/lib/v2/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/config")>()), v2ConfigWarnings: () => m.warnings,
}));
vi.mock("@/lib/v2/chainClock", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/chainClock")>()), useChainClockOffset: () => m.offset,
}));
vi.mock("@/lib/v2/chainReads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/chainReads")>()), ...m.chain,
}));
vi.mock("@/lib/v2/tx", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/v2/tx")>()), ...m.tx }));
vi.mock("@/lib/v2/lendTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/lendTx")>()),
  cancelQueuedRequest: m.cancelQueuedRequest, claimDeferredPayment: m.claimDeferredPayment,
  earnVaultAddress: () => "0x0000000000000000000000000000000000000066",
}));
vi.mock("@/lib/v2/earnDeferred", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/earnDeferred")>()), useHeldPayments: () => ({ data: undefined }),
}));
vi.mock("@/lib/v2/owed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/owed")>()), claimOrderBookOwed: m.claimOrderBookOwed,
}));
vi.mock("@/lib/v2/earnTx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/earnTx")>()), readWriterRent: m.readWriterRent,
}));
vi.mock("@/lib/v2/moneyPreviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/moneyPreviews")>()), readOptionRedeemPreview: m.readOptionRedeemPreview,
}));
vi.mock("@/lib/v2/tradingGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/tradingGate")>()), assertTradingOpen: m.assertTradingOpen,
}));
vi.mock("@/lib/v2/ticket", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/ticket")>()), staleSelectedOrders: m.staleSelectedOrders,
}));
vi.mock("@/lib/chain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/chain")>()), publicClient: m.client,
}));

import { V2_DEPLOYMENT } from "@/lib/v2/config";
import { TRADING_PAUSED_LINE } from "@/lib/v2/tradingGate";
import { V2ConfirmedStepError } from "@/lib/v2/txStatus";
import { LongCard, Portfolio, ShortCard } from "./Portfolio";

// ---- fixtures ----
const fixtures = fileURLToPath(new URL("../../../ops/fixtures/api/v2/", import.meta.url));
const read = <T,>(path: string): T => JSON.parse(readFileSync(`${fixtures}/${path}`, "utf8")) as T;
const BUYER = "0xE37876AcBfbA6186E4687f4ef465D9AC21558De3" as Address;
const WRITER = "0xD6b49a27Ead99118b61F0827C7aB2782aea07bE6" as Address;
const buyerPositions = read<PositionsResponse>(`accounts/${BUYER}/positions.json`);
const writerPositions = read<PositionsResponse>(`accounts/${WRITER}/positions.json`);
const buyerHistory = read<HistoryResponse>(`accounts/${BUYER}/history.json`);
const config = read<ConfigResponse>("config.json");
const NOW_S = 1_789_600_000;
const [settledLong, , openLong] = buyerPositions.longs as [LongPosition, LongPosition, LongPosition];
const writerShort = writerPositions.shorts[0] as ShortPosition;
const writerAsk = writerPositions.orders[0] as AccountOrder;
const buyerBid = buyerPositions.orders[0] as AccountOrder;
const OTHER = "0x00000000000000000000000000000000000000b0";
const money = (raw: string, decimals = 6) => ({ raw, decimals, formatted: raw });

function book(side: "bids" | "asks", levels: [price: string, units: string, orderId: string][], maker = OTHER): BookResponse {
  const rows = levels.map(([price, units, orderId]) => ({ price: money(price), units,
    orders: [{ orderId, maker, units, onChainRemainingUnits: units, makerFreeUnits: "100000", makerFreeCollateral: money("10000000000000000000000", 18),
      kind: side === "bids" ? "Bid" : "AskWrite", validUntil: NOW_S + 86_400 }] }));
  return { bids: side === "bids" ? rows : [], asks: side === "asks" ? rows : [], updatedBlock: "1", snapshotTimestamp: NOW_S } as unknown as BookResponse;
}

// ---- mounting ----
type Instance = { fn: (props: never) => ReactNode; props: Record<string, unknown>; slots: unknown[]; effects: (() => unknown)[]; tree: ReactNode };
function mount(fn: (props: never) => ReactNode, props: Record<string, unknown> = {}): Instance {
  const instance: Instance = { fn, props, slots: [], effects: [], tree: null };
  render(instance);
  return instance;
}
function render(instance: Instance): string {
  h.active = true; h.cursor = 0; h.slots = instance.slots; h.effects = [];
  try { instance.tree = instance.fn(instance.props as never); } finally { h.active = false; }
  instance.effects = h.effects;
  return renderToStaticMarkup(createElement("div", null, instance.tree));
}
type El = ReactElement<Record<string, unknown>>;
function findAll(node: unknown, pred: (el: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, pred, out)); return out; }
  // The redesign's <Tabs items> holds each tab's panel in a plain { value, label, badge, panel } object.
  if (node !== null && typeof node === "object" && !isValidElement(node) && "panel" in node) return findAll((node as { panel: unknown }).panel, pred, out);
  if (!isValidElement(node)) return out;
  const el = node as El;
  if (pred(el)) out.push(el);
  for (const value of Object.values(el.props)) findAll(value, pred, out);
  return out;
}
const textOf = (n: unknown): string => typeof n === "string" || typeof n === "number" ? String(n)
  : Array.isArray(n) ? n.map(textOf).join("") : isValidElement(n) ? textOf((n.props as { children?: unknown }).children) : "";
function control(instance: Instance, label: string): El {
  const [hit] = findAll(instance.tree, (el) => typeof el.props.onClick === "function"
    && (textOf(el.props.children) === label || el.props["aria-label"] === label));
  if (!hit) throw new Error(`no control ${label}`);
  return hit;
}
function byType(instance: Instance, name: string): El {
  const [hit] = findAll(instance.tree, (el) => typeof el.type === "function" && el.type.name === name);
  if (!hit) throw new Error(`no ${name}`);
  return hit;
}
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
async function press(instance: Instance, label: string): Promise<string> {
  (control(instance, label).props.onClick as () => void)();
  await flush();
  return render(instance);
}
function type(instance: Instance, id: string, value: string): string {
  const [hit] = findAll(instance.tree, (el) => el.props.id === id);
  if (!hit) throw new Error(`no input ${id}`);
  (hit.props.onChange as (e: unknown) => void)({ target: { value } });
  return render(instance);
}
/** The value a card shows next to a label: a ui Row's or a Fact's `v`, and a Fact's `sub`. */
function fact(instance: Instance, k: string): { v?: unknown; sub?: unknown; tip?: unknown } {
  const [hit] = findAll(instance.tree, (el) => el.props.k === k && "v" in el.props);
  if (!hit) throw new Error(`no row ${k}`);
  return hit.props;
}
type TabsProps = { value: string; items: { value: string; badge?: unknown }[]; onChange: (value: string) => void };
const tabsOf = (instance: Instance) => byType(instance, "Tabs").props as unknown as TabsProps;
/** Picks a Portfolio tab through the Tabs onChange the page passed, and renders the page again. */
function choose(instance: Instance, tab: string): string { tabsOf(instance).onChange(tab); return render(instance); }
/** The label of the tab the markup shows as selected. */
const selectedTab = (html: string) => /aria-selected="true"[^>]*><span class="truncate">([^<]+)</.exec(html)?.[1];
function page(): Instance {
  const instance = mount(Portfolio as never);
  instance.effects.forEach((fn) => fn());
  render(instance);
  return instance;
}

/** A card's `run`: executes the work with a write context and records the outcome, as the page's run does. */
function cardRun() {
  const calls: { id: string; title: string; requireTrade: boolean; error?: unknown }[] = [];
  const context = { account: BUYER, wallet: m.wallet, onConfirmed: vi.fn() };
  const run = async (id: string, title: string, work: (ctx: typeof context) => Promise<void>, requireTrade = true) => {
    const call: (typeof calls)[number] = { id, title, requireTrade, error: undefined };
    calls.push(call);
    try { await work(context); } catch (error) { call.error = error; }
  };
  return { run, calls, context };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_S * 1000);
  vi.stubGlobal("window", { setInterval: vi.fn(() => 3), clearInterval: vi.fn() });
  m.address = BUYER; m.wallet = { id: "wallet" }; m.config = config; m.warnings = []; m.offset = 0;
  m.positions = { data: buyerPositions, isPending: false, isError: false };
  m.markets = { data: [], isPending: false, isError: false };
  m.strategies = { data: { items: [] }, isPending: false, isError: false };
  m.books = {}; m.fair = { data: undefined };
  m.history = { data: { pages: [buyerHistory] }, isPending: false, isError: false, hasNextPage: false, fetchNextPage: vi.fn() };
  m.queries = { payoutPrefs: { data: { inKind: false, toLedger: false } } };
  m.queryOptions = {};
  for (const fn of [m.invalidate, m.notice, m.receipt, ...Object.values(m.chain), ...Object.values(m.tx), m.cancelQueuedRequest,
    m.claimDeferredPayment, m.claimOrderBookOwed, m.readWriterRent, m.readOptionRedeemPreview, m.assertTradingOpen,
    m.staleSelectedOrders, m.getServices, m.getHistory, m.client.readContract]) (fn as ReturnType<typeof vi.fn>).mockReset();
  m.receipt.mockReturnValue(false);
  m.staleSelectedOrders.mockReturnValue([]);
  m.tx.chainNow.mockResolvedValue(NOW_S);
  m.tx.recheckTakeQuote.mockImplementation(async (_c: unknown, request: object) => ({ ...request, deadline: 1, maxTotalFee: 1n }));
  m.tx.restingValidUntil.mockResolvedValue(NOW_S + 3_600);
  m.chain.readSeriesOnChain.mockResolvedValue({ exists: true, series: { mintFeePpm: 0, expiry: 1n }, collateral: 10n ** 16n,
    snapshotTimestamp: NOW_S, cutoff: 1n, blockNumber: 1n });
  m.chain.readAccountOnChain.mockResolvedValue({ longBalance: 10_000n, shortBalance: 10_000n, approvedForAll: true });
  m.chain.readPayoutPrefs.mockResolvedValue({ inKind: false, toLedger: false });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Portfolio page: states", () => {
  it("asks for a wallet and reads nothing account-bound without one", () => {
    m.address = undefined;
    const html = render(mount(Portfolio as never));
    expect(html).toContain("Connect a wallet to see your portfolio");
    expect(m.queryOptions.services!.enabled).toBe(false);
    expect(m.infiniteOptions!.enabled).toBe(false);
  });

  it("ticks the page clock every 30 seconds and clears it on unmount", () => {
    const instance = mount(Portfolio as never);
    const cleanup = instance.effects[0]!() as () => void;
    expect((window.setInterval as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBe(30_000);
    cleanup();
    expect(window.clearInterval).toHaveBeenCalledWith(3);
  });

  it("says what is loading, and what is unavailable, for positions, history, the payout choice and auto-priced asks", () => {
    m.positions = { isPending: true };
    m.history = { isPending: true };
    m.queries = { payoutPrefs: { isPending: true } };
    let html = render(page());
    expect(html).toContain("Loading your positions…");
    expect(html).toContain("Loading your history…");
    expect(html).toContain("Checking your payout choice…");
    expect(html).toContain("Checking your settled positions…");
    m.positions = { isPending: false, isError: true };
    m.history = { isPending: false, isError: true };
    m.queries = { payoutPrefs: { isError: true } };
    html = render(page());
    expect(html).toContain("Positions are unavailable right now.");
    expect(html).toContain("History is unavailable right now.");
    expect(html).toContain("Payout choice unavailable. Collecting waits until it loads.");
    expect(html).not.toContain("Checking your payout choice…");
    // The redesign shows the writer's auto-priced asks on the Selling tab, under the loaded positions.
    m.positions = { data: buyerPositions };
    m.strategies = { isPending: true };
    expect(choose(page(), "selling")).toContain("Loading auto-priced asks…");
    m.strategies = { isError: true };
    html = choose(page(), "selling");
    expect(html).toContain("Strategy pricing could not be read. Try again shortly.");
    expect(html).not.toContain("Loading auto-priced asks…");
  });

  it("says trading is paused when the app and indexer settings differ, and waits for data otherwise", () => {
    m.warnings = ["orderBook address differs"];
    expect(render(page())).toContain("Trading is paused: the app and indexer settings differ.");
    m.warnings = [];
    m.config = undefined;
    expect(render(page())).toContain("Trading opens once your wallet and market data are ready.");
    m.config = config;
    expect(render(page())).not.toContain("Trading opens once");
  });

  it("counts options held, options written and orders on the tabs and lists a settled Stock Token payout separately from USDG", () => {
    const instance = page();
    const html = render(instance);
    expect([buyerPositions.longs.length, buyerPositions.shorts.length, buyerPositions.orders.length]).toEqual([3, 0, 1]);
    expect(Object.fromEntries(tabsOf(instance).items.map((item) => [item.value, item.badge])))
      .toEqual({ positions: 3, selling: undefined, orders: 1, history: undefined });
    expect(html).toMatch(/<span class="truncate">Options<\/span><span[^>]*>3<\/span>/);
    expect(html).toMatch(/<span class="truncate">Orders<\/span><span[^>]*>1<\/span>/);
    // The settled long's claim is 18-decimal Stock Tokens: counted, never summed into the USDG figure.
    expect(html).toMatch(/0 USDG<\/p><p[^>]*>1 settled position, 1 paid in Stock Tokens \(not added to USDG\)\./);
  });

  it("Collect payout opens the first collectable long's card on the Options tab", () => {
    const instance = page();
    expect(selectedTab(choose(instance, "history"))).toBe("History");
    expect(findAll(instance.tree, (el) => (el.type as { name?: string }).name === "LongCard")).toHaveLength(0);
    (byType(instance, "CollectPayoutCard").props.onCollect as () => void)();
    const markup = render(instance);
    expect(selectedTab(markup)).toBe("Options");
    const cards = findAll(instance.tree, (el) => (el.type as { name?: string }).name === "LongCard");
    expect(cards.map((card) => card.props.position)).toEqual([settledLong]);
  });

  it("expands and closes a row", () => {
    const instance = page();
    const row = () => findAll(instance.tree, (el) => (el.type as { name?: string }).name === "LongPositionRowView"
      && el.props.position === openLong)[0]!;
    const cards = () => findAll(instance.tree, (el) => (el.type as { name?: string }).name === "LongCard");
    expect(cards()).toHaveLength(0);
    (row().props.onToggle as () => void)();
    expect(render(instance)).toContain(`id="sell-size-${openLong.series.longId}"`);
    expect(row().props.open).toBe(true);
    expect(cards().map((card) => card.props.position)).toEqual([openLong]);
    (row().props.onToggle as () => void)();
    expect(render(instance)).not.toContain("id=\"sell-size-");
    expect(cards()).toHaveLength(0);
  });

  it("says there are no options, written options or orders on an empty account", () => {
    m.positions = { data: { ...buyerPositions, longs: [], shorts: [], orders: [] } };
    const instance = page();
    expect(render(instance)).toContain("No options held.");
    expect(choose(instance, "selling")).toContain("No options written yet.");
    expect(choose(instance, "orders")).toContain("No open orders.");
    expect(tabsOf(instance).items.map((item) => item.badge)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("keeps saved positions on screen with a notice while positions refresh fails", () => {
    m.positions = { data: buyerPositions, isError: true };
    expect(render(page())).toContain("Showing saved positions.");
  });
});

describe("Portfolio page: tabs and history", () => {
  it("the orders tab shows each order, and says so while positions load or fail", () => {
    const instance = page();
    expect(render(instance)).not.toContain(`Bid #${buyerBid.orderId}`);
    let html = choose(instance, "orders");
    expect(selectedTab(html)).toBe("Orders");
    expect(html).toContain(`Bid #${buyerBid.orderId}`);
    m.positions = { isPending: true };
    expect(render(instance)).toContain("Loading your orders…");
    m.positions = { isError: true };
    expect(render(instance)).toContain("Orders are unavailable right now.");
    html = choose(instance, "history");
    expect(html).toContain("View transaction");
  });

  it("the history tab loads older activity, and says so while loading or unavailable", async () => {
    const fetchNextPage = vi.fn();
    m.history = { ...m.history, hasNextPage: true, isError: true, fetchNextPage };
    const instance = page();
    let html = choose(instance, "history");
    expect(html).toContain("Showing saved activity.");
    expect(html).toContain("Partial: older activity is not loaded. Showing saved activity.");
    html = await press(instance, "Load older activity");
    expect(fetchNextPage).toHaveBeenCalled();
    m.history = { ...m.history, isFetchingNextPage: true };
    expect(render(instance)).toContain("Loading…");
    m.history = { isPending: true };
    expect(render(instance)).toContain("Loading your history…");
    m.history = { isPending: false };
    expect(render(instance)).toContain("History is unavailable right now.");
  });

  it("See history rows switches to the history tab", () => {
    const instance = page();
    expect(selectedTab(render(instance))).toBe("Options");
    (byType(instance, "HistorySummaryPanel").props.onHistory as () => void)();
    expect(selectedTab(render(instance))).toBe("History");
    expect(selectedTab(choose(instance, "positions"))).toBe("Options");
  });

  it("pages history 50 at a time by cursor for this wallet, and reads services once connected", async () => {
    render(page());
    const options = m.infiniteOptions!;
    expect(options.queryKey).toEqual(["v2", "portfolio-history", BUYER.toLowerCase()]);
    const signal = new AbortController().signal;
    options.queryFn({ pageParam: "c", signal });
    expect(m.getHistory).toHaveBeenCalledWith(BUYER, { limit: 50, cursor: "c" }, { signal });
    expect(options.getNextPageParam!({ nextCursor: null })).toBeUndefined();
    expect(options.getNextPageParam!({ nextCursor: "n" })).toBe("n");
    m.queryOptions.services!.queryFn();
    expect(m.getServices).toHaveBeenCalled();
    m.queryOptions.payoutPrefs!.queryFn();
    expect(m.chain.readPayoutPrefs).toHaveBeenCalledWith(BUYER);
  });
});

describe("Portfolio page: writes through the page's run", () => {
  it("switches the payout to Stock Tokens after re-reading the on-chain preference, then refreshes", async () => {
    const instance = page();
    const usdg = control(instance, "USDG");
    expect(usdg.props["aria-pressed"]).toBe(true);
    expect(usdg.props.disabled).toBe(true);
    const html = await press(instance, "Stock Tokens");
    expect(m.chain.assertPayoutPrefsMatch).toHaveBeenCalledWith({ inKind: false, toLedger: false }, { inKind: false, toLedger: false });
    expect(m.tx.setPayoutInKind.mock.calls[0]![1]).toBe(true);
    expect(m.tx.setPayoutInKind.mock.calls[0]![0]).toMatchObject({ account: BUYER, wallet: m.wallet });
    expect(m.notice.mock.calls.map((c) => [c[0], c[1]])).toEqual([["pending", "Stock Token payout selected"], ["success", "Stock Token payout selected"]]);
    expect(m.invalidate).toHaveBeenCalledWith({ queryKey: ["v2"] });
    expect(html).toContain("Stock Token payout selected. Your portfolio updates shortly.");
  });

  it("switches back to USDG, and says the payout goes to the Stonkhouse balance when that is the setting", async () => {
    m.queries = { payoutPrefs: { data: { inKind: true, toLedger: true } } };
    const instance = page();
    const html = render(instance);
    expect(html).toContain("Paid to your Stonkhouse balance.");
    expect(html).not.toContain("Paid to your wallet.");
    expect(control(instance, "Stock Tokens").props.disabled).toBe(true);
    await press(instance, "USDG");
    expect(m.tx.setPayoutInKind.mock.calls[0]![1]).toBe(false);
    m.queries = { payoutPrefs: { data: { inKind: false, toLedger: false } } };
    expect(render(page())).toContain("Paid to your wallet.");
  });

  it("reports a failed write in buyer copy, and leaves an unknown receipt to its own notice", async () => {
    m.tx.setPayoutInKind.mockRejectedValueOnce(new Error("The preference changed on chain."));
    const instance = page();
    await press(instance, "Stock Tokens");
    expect(m.notice).toHaveBeenLastCalledWith("error", "Stock Token payout selected stopped", "The preference changed on chain.");
    m.notice.mockClear();
    m.tx.setPayoutInKind.mockRejectedValueOnce(new Error("unknown"));
    m.receipt.mockReturnValueOnce(true);
    await press(instance, "Stock Tokens");
    expect(m.notice.mock.calls.map((c) => c[0])).toEqual(["pending"]);
  });

  it("does nothing without a wallet client, and ignores a second action while one is busy", async () => {
    m.wallet = undefined;
    let instance = page();
    await press(instance, "Stock Tokens");
    expect(m.tx.setPayoutInKind).not.toHaveBeenCalled();
    m.wallet = { id: "wallet" };
    instance = page();
    let release!: () => void;
    m.tx.setPayoutInKind.mockReturnValueOnce(new Promise<void>((r) => { release = r; }));
    (control(instance, "Stock Tokens").props.onClick as () => void)();
    await flush();
    render(instance);
    const run = byType(instance, "OwedBanner").props.onClaim as () => void;
    run();
    await flush();
    expect(m.claimOrderBookOwed).not.toHaveBeenCalled();
    release();
    await flush();
  });

  it("claims the order book balance, cancels a queued lend request and claims a held payment", async () => {
    const instance = page();
    (byType(instance, "OwedBanner").props.onClaim as () => void)();
    await flush();
    expect(m.claimOrderBookOwed).toHaveBeenCalledTimes(1);
    const lend = byType(instance, "PortfolioLendRequests").props as {
      onCancel: (card: unknown) => void; onClaim: (card: unknown, to: Address) => void };
    lend.onCancel({ key: "q1", kind: "deposit", cancelId: null });
    await flush();
    expect(m.notice).toHaveBeenLastCalledWith("error", "Queued deposit cancelled stopped", "This request has no queue id to cancel.");
    lend.onCancel({ key: "q2", kind: "withdrawal", cancelId: 7n });
    await flush();
    expect(m.cancelQueuedRequest.mock.calls[0]![1]).toBe(7n);
    expect(m.notice).toHaveBeenLastCalledWith("success", "Queued withdrawal cancelled", expect.any(String));
    lend.onClaim({ key: "h1", held: { id: 4n } }, WRITER);
    await flush();
    expect(m.claimDeferredPayment.mock.calls[0]!.slice(1)).toEqual([4n, WRITER]);
  });
});

describe("Portfolio page: the writer's account", () => {
  beforeEach(() => { m.address = WRITER; m.positions = { data: writerPositions }; });

  it("labels a written row Manage, with its premium and locked collateral", () => {
    const html = render(page());
    expect(html).toContain(`aria-label="Manage NVDA $227 call (written)"`);
    // Money rules truncate: 0.148257 USDG premium shows 0.14, and 0.6 NVDA collateral as a quantity.
    expect(html).toMatch(/Premium<\/span><span class="num">0.14 <small[^>]*>USDG<\/small><\/span>/);
    expect(html).toMatch(/Collateral locked<\/span><span class="num">0.6 <small[^>]*>NVDA<\/small><\/span>/);
  });

  it("labels a settled written row with a claim Collect", () => {
    const settled = { ...writerShort, series: { ...writerShort.series, status: "settled" as const }, claimable: money("5", 6) };
    m.positions = { data: { ...writerPositions, shorts: [settled] } };
    expect(render(page())).toContain(`aria-label="Collect NVDA $227 call (written)"`);
  });

  it("names an ask the roller pulled on a stale price, with the price that triggered it", () => {
    const pulled = { ...writerPositions.strategies[0]!, orderId: null, lastStaleCancelAt: NOW_S - 60,
      staleSpot: money("231500000", 6) };
    m.positions = { data: { ...writerPositions, strategies: [pulled] } };
    const html = render(page());
    expect(html).toContain("Ask withdrawn");
    expect(html).toContain("NVDA $227 ask was pulled when the price hit $231.50");
  });

  it("withdraws the on-chain free balance, not the indexed one, and refuses when none remains", async () => {
    const instance = page();
    const ledger = mount(byType(instance, "Ledger").type as never, byType(instance, "Ledger").props);
    expect(render(ledger)).toMatch(/>2\.3767 <small[^>]*>NVDA<\/small>/);
    m.client.readContract.mockResolvedValueOnce(5n);
    await press(ledger, "Withdraw");
    expect(m.client.readContract.mock.calls[0]![0]).toMatchObject({ functionName: "free", args: [WRITER, writerPositions.ledger[0]!.asset] });
    expect(m.tx.withdraw.mock.calls[0]!.slice(1)).toEqual([writerPositions.ledger[0]!.asset, 5n]);
    m.client.readContract.mockResolvedValueOnce(0n);
    await press(ledger, "Withdraw");
    expect(m.notice).toHaveBeenLastCalledWith("error", "Balance withdrawn stopped", "No free balance remains on chain. Refresh Portfolio.");
    expect(m.tx.withdraw).toHaveBeenCalledTimes(1);
  });

  it("shows the writer's auto-priced asks, with saved data flagged when a feed fails", () => {
    const strategy = { writer: WRITER, underlying: writerShort.series.underlying, ticker: "NVDA",
      strategy: { active: true, weekly: true, smartPricing: true, otmBps: 500, askBps: 100, minAskBps: 50, maxAskBps: 200, maxUnits: "100" },
      currentLongId: writerShort.series.longId, orderId: writerAsk.orderId, expiry: writerShort.series.expiry,
      lastRolledAt: NOW_S - 100, lastStaleCancelAt: null, staleSpot: null,
      pricing: { currentAsk: money("260100"), band: { min: money("100000"), max: money("900000") }, lastRepricedAt: NOW_S - 10,
        lastRepricedPrice: money("260100"), repriceCount: 2, fair: money("250000") } };
    m.strategies = { data: { items: [strategy] }, isError: false };
    m.markets = { data: [{ ticker: "NVDA", underlying: writerShort.series.underlying, spot: money("220000000"), tradingPaused: false }] };
    let html = render(page());
    expect(html).toContain("Auto-priced asks");
    expect(html).toContain("0.2601 USDG");
    m.strategies = { data: { items: [strategy] }, isError: true };
    html = render(page());
    expect(html).toContain("Showing saved strategy data.");
  });
});

// ---------------------------------------------------------------- the cards
const FEES = { takerFeeFlat: 100_000n, takerFeeCapBps: 1_000 };
const bidRows = (levels: [string, string, string][], longId: string) => levels.map(([price, units, orderId]) => ({
  orderId: BigInt(orderId), freeCollateral: 0n,
  order: { maker: OTHER, longId: BigInt(longId), kind: 0, price: BigInt(price), units: BigInt(units), filled: 0n,
    validUntil: NOW_S + 86_400, cancelled: false },
}));

describe("LongCard: selling and listing an open long", () => {
  const BIDS: [string, string, string][] = [["500000", "100", "1"], ["400000", "100", "2"]];
  function longCard(over: Record<string, unknown> = {}) {
    const { run, calls, context } = cardRun();
    m.books[openLong.series.longId] = { data: book("bids", BIDS), isError: false };
    m.queries["wallet-long"] = { data: 150n };
    m.chain.readOrderPreflight.mockResolvedValue(bidRows(BIDS, openLong.series.longId));
    const card = mount(LongCard as never, { position: openLong, history: [], now: NOW_S, account: BUYER,
      payoutPrefs: { inKind: false, toLedger: false }, run, ready: true, exitReady: true, busy: null, fees: FEES,
      resaleFeeBps: 0, pendingFees: null, withdrawalTiming: null, trading: true, ...over });
    return { card, calls, context };
  }

  it("quotes the whole position into the best bids, net of the taker fee", () => {
    const { card } = longCard();
    // 1 share at 0.5 plus 0.5 share at 0.4 = 0.7 USDG, less the 0.07 fee capped at 10%.
    expect(render(card)).toContain("0.63 USDG");
    expect(fact(card, "Bids pay now").v).toBe("0.63 USDG");
    expect(control(card, "Sell now").props.disabled).toBe(false);
  });

  it("reads the wallet's own long balance from the Clearinghouse", async () => {
    longCard();
    await m.queryOptions["wallet-long"]!.queryFn();
    expect(m.client.readContract.mock.calls[0]![0]).toMatchObject({ functionName: "balanceOf",
      args: [BUYER, BigInt(openLong.series.longId)], address: V2_DEPLOYMENT.contracts.clearinghouse });
  });

  it("sells: brake, terms, balance, approval when missing, fresh orders, then one take for the quoted fill", async () => {
    m.chain.readAccountOnChain.mockResolvedValue({ longBalance: 150n, shortBalance: 0n, approvedForAll: false });
    const { card, calls } = longCard();
    await press(card, "Sell now");
    expect(calls[0]).toMatchObject({ title: "Sell confirmed", error: undefined });
    expect(m.assertTradingOpen).toHaveBeenCalled();
    expect(m.chain.assertSeriesTermsMatch).toHaveBeenCalled();
    expect(m.tx.setTokenApproval.mock.calls[0]!.slice(1)).toEqual([V2_DEPLOYMENT.contracts.orderBook, true]);
    expect(m.chain.readOrderPreflight).toHaveBeenCalledWith([1n, 2n], openLong.series.underlying);
    expect(m.tx.take.mock.calls[0]![1]).toMatchObject({ buying: false, orderIds: [1n, 2n], units: 150n, minUnits: 150n, writeToSell: false });
  });

  it("refuses a sale when a bid changed on chain, and when the position is smaller on chain", async () => {
    const { card, calls } = longCard();
    m.chain.readOrderPreflight.mockResolvedValue(bidRows([["500000", "10", "1"], ["400000", "100", "2"]], openLong.series.longId));
    await press(card, "Sell now");
    expect((calls[0]!.error as Error).message).toBe("A bid changed. Refresh the book and review the new proceeds.");
    m.chain.readAccountOnChain.mockResolvedValue({ longBalance: 10n, shortBalance: 0n, approvedForAll: true });
    await press(card, "Sell now");
    expect((calls[1]!.error as Error).message).toBe("Your on-chain position is smaller than this amount. Refresh Portfolio.");
    m.chain.readSeriesOnChain.mockResolvedValueOnce({ exists: false });
    await press(card, "Sell now");
    expect((calls[2]!.error as Error).message).toBe("This option is no longer on chain.");
    expect(m.tx.take).not.toHaveBeenCalled();
  });

  it("flags a size above the wallet balance and one the bids cannot cover", () => {
    const { card } = longCard();
    let html = type(card, `sell-size-${openLong.series.longId}`, "3");
    expect(html).toContain("Choose up to 1.5 wallet shares in 0.01 steps.");
    expect(control(card, "Sell now").props.disabled).toBe(true);
    m.books[openLong.series.longId] = { data: book("bids", [["500000", "10", "1"]]), isError: false };
    html = type(card, `sell-size-${openLong.series.longId}`, "1");
    expect(html).not.toContain("Choose up to");
    expect(fact(card, "Bids pay now").v).toBe("No bids cover this size");
    expect(control(card, "Sell now").props.disabled).toBe(true);
    expect(control(card, "List for sale").props.disabled).toBe(false);
    m.books[openLong.series.longId] = { data: undefined, isError: true };
    render(card);
    expect(fact(card, "Bids pay now").v).toBe("Bids unavailable");
    expect(control(card, "Sell now").props.disabled).toBe(true);
  });

  it("says part of the position is listed when the wallet holds less than the indexed size", () => {
    const { card } = longCard();
    render(card);
    expect(fact(card, "Held or listed").sub).toBeUndefined();
    m.queries["wallet-long"] = { data: 50n };
    render(card);
    expect(fact(card, "Held or listed")).toMatchObject({ v: "1.5 shares", sub: "0.5 in wallet, the rest listed" });
    m.queries["wallet-long"] = { isError: true };
    expect(render(card)).toContain("Wallet balance unavailable. Actions are paused until it loads.");
  });

  it("shows the market brake and disables selling while it is on", () => {
    const { card } = longCard({ trading: false });
    expect(render(card)).toContain(TRADING_PAUSED_LINE);
    expect(control(card, "Sell now").props.disabled).toBe(true);
  });

  it("lists: sells the crossing part into bids, then rests the rest at the ask until the chain's valid-until", async () => {
    m.fair = { data: { fair: money("450000") } };
    const { card, calls } = longCard();
    await press(card, "List for sale");
    const [priceField] = findAll(card.tree, (el) => el.props.id === `list-price-${openLong.series.longId}`);
    expect(priceField!.props.aside).toBe("Fair 0.45 USDG");
    type(card, `list-price-${openLong.series.longId}`, "0.45");
    expect(fact(card, "Sells into bids now").v).toBe("1 shares");
    expect(fact(card, "Rests at your ask").v).toBe("0.5 shares");
    await press(card, "Sell crossing bids and list remainder");
    expect(calls[0]!.error).toBeUndefined();
    expect(m.tx.take.mock.calls[0]![1]).toMatchObject({ orderIds: [1n], units: 100n });
    expect(m.tx.place.mock.calls[0]!.slice(1)).toEqual([BigInt(openLong.series.longId), 1, 450_000n, 50n, NOW_S + 3_600]);
  });

  it("reports a failed rest after a confirmed sale as a confirmed step, and a plain failure otherwise", async () => {
    const { card, calls } = longCard();
    await press(card, "List for sale");
    type(card, `list-price-${openLong.series.longId}`, "0.45");
    m.tx.place.mockRejectedValueOnce(new Error("place reverted"));
    await press(card, "Sell crossing bids and list remainder");
    expect(calls[0]!.error).toBeInstanceOf(V2ConfirmedStepError);
    type(card, `list-price-${openLong.series.longId}`, "0.9");
    const plain = new Error("place reverted");
    m.tx.place.mockRejectedValueOnce(plain);
    await press(card, "Sell crossing bids and list remainder");
    expect(calls[1]!.error).toBe(plain);
    m.tx.restingValidUntil.mockResolvedValueOnce(null);
    await press(card, "Sell crossing bids and list remainder");
    expect((calls[2]!.error as Error).message).toBe("This option is too close to expiry to list.");
  });

  it("will not list at a price off the 0.0001 tick", () => {
    const { card } = longCard();
    void press(card, "List for sale");
    render(card);
    type(card, `list-price-${openLong.series.longId}`, "0.00001");
    expect(control(card, "Sell crossing bids and list remainder").props.disabled).toBe(true);
  });
});

describe("LongCard: collecting a settled long", () => {
  function settledCard(prefs: unknown = { inKind: false, toLedger: false }) {
    const { run, calls } = cardRun();
    m.queries["wallet-long"] = { data: 100n };
    m.queries["option-redeem-preview"] = { isPending: true };
    const card = mount(LongCard as never, { position: settledLong, history: [], now: NOW_S, account: BUYER, payoutPrefs: prefs,
      run, ready: true, exitReady: true, busy: null, fees: FEES, resaleFeeBps: 0, pendingFees: null, withdrawalTiming: null, trading: true });
    return { card, calls };
  }

  it("previews the payout before Collect, then redeems after re-checking the series and the payout preference", async () => {
    const { card, calls } = settledCard();
    const html = render(card);
    expect(html).toContain("Checking what collecting would pay…");
    expect(html).not.toContain("Size in shares"); // no trading on a settled series
    await m.queryOptions["option-redeem-preview"]!.queryFn();
    expect(m.readOptionRedeemPreview.mock.calls[0]!.slice(1)).toEqual([V2_DEPLOYMENT.contracts.clearinghouse, BigInt(settledLong.series.longId), BUYER, BUYER]);
    await press(card, "Collect");
    expect(calls[0]).toMatchObject({ title: "Payout collected", requireTrade: false, error: undefined });
    expect(m.chain.assertPortfolioSeries).toHaveBeenCalledWith(settledLong.series);
    expect(m.tx.redeem.mock.calls[0]![1]).toBe(BigInt(settledLong.series.longId));
  });

  it("refuses to collect a payout already pushed", async () => {
    const { card, calls } = settledCard();
    m.chain.readAccountOnChain.mockResolvedValue({ longBalance: 0n, shortBalance: 0n, approvedForAll: true });
    await press(card, "Collect");
    expect((calls[0]!.error as Error).message).toBe("The payout may already have been pushed. Refresh Portfolio.");
    expect(m.tx.redeem).not.toHaveBeenCalled();
  });

  it("keeps Collect shut until the payout preference is read", async () => {
    const { card, calls } = settledCard(null);
    expect(control(card, "Collect").props.disabled).toBe(true);
    await press(card, "Collect");
    expect((calls[0]!.error as Error).message).toBe("Read your on-chain payout preference before collecting.");
  });
});

describe("ShortCard: buying back, closing and collecting a written call", () => {
  const ASKS: [string, string, string][] = [["300000", "100", "11"]];
  function shortCard(over: Record<string, unknown> = {}) {
    const { run, calls } = cardRun();
    m.books[writerShort.series.longId] = { data: book("asks", ASKS), isError: false };
    m.queries["wallet-short"] = { data: 60n };
    const card = mount(ShortCard as never, { position: writerShort, history: [], now: NOW_S, spot: money("230000000"),
      account: WRITER, usdg: config.usdg.address, payoutPrefs: { inKind: false, toLedger: true }, run, ready: true,
      exitReady: true, busy: null, fees: FEES, trading: true, ...over });
    return { card, calls };
  }

  it("shows the money state against spot and the buyback cost", () => {
    const { card } = shortCard();
    render(card);
    expect(fact(card, "Right now").v).toBe("In the money");
    expect(fact(card, "Buyback costs").v).toBe("0.198 USDG"); // 0.6 × 0.3 + the 10% capped fee
    expect(control(card, "Buy back and close").props.disabled).toBe(false);
    expect(fact(mount(ShortCard as never, { ...card.props, spot: money("200000000") }), "Right now").v).toBe("Out of the money");
    expect(fact(mount(ShortCard as never, { ...card.props, spot: null }), "Right now").v).toBe("Price unavailable");
  });

  it("reads the short token balance by its short id", async () => {
    shortCard();
    await m.queryOptions["wallet-short"]!.queryFn();
    expect(m.client.readContract.mock.calls[0]![0]).toMatchObject({ functionName: "balanceOf", args: [WRITER, BigInt(writerShort.series.shortId)] });
  });

  it("buys back at the asks, approves exactly premium plus fee in USDG, then closes the pair", async () => {
    m.chain.readOrderPreflight.mockResolvedValue([{ orderId: 11n, freeCollateral: 9n, order: { maker: OTHER, longId: 1n, kind: 2,
      price: 300_000n, units: 100n, filled: 0n, validUntil: NOW_S + 10, cancelled: false } }]);
    const { card, calls } = shortCard();
    await press(card, "Buy back and close");
    expect(calls[0]).toMatchObject({ title: "Buyback and close confirmed", error: undefined });
    expect(m.chain.readOrderPreflight.mock.calls[0]!.slice(0, 2)).toEqual([[11n], writerShort.series.underlying]);
    expect((m.staleSelectedOrders.mock.calls[0] as unknown[])[1]).toEqual([expect.objectContaining({ orderId: 11n, freeCollateral: 9n })]);
    expect(m.tx.approveExact.mock.calls[0]!.slice(1)).toEqual([config.usdg.address, V2_DEPLOYMENT.contracts.orderBook, 180_000n + 18_000n]);
    expect(m.tx.take.mock.calls[0]![1]).toMatchObject({ buying: true, units: 60n, minUnits: 60n });
    expect(m.tx.close.mock.calls[0]!.slice(1)).toEqual([BigInt(writerShort.series.longId), 60n]);
  });

  it("reports a close that fails after the buyback as a confirmed step", async () => {
    m.chain.readOrderPreflight.mockResolvedValue([]);
    m.tx.close.mockRejectedValueOnce(new Error("close reverted"));
    const { card, calls } = shortCard();
    await press(card, "Buy back and close");
    expect(calls[0]!.error).toBeInstanceOf(V2ConfirmedStepError);
    expect((calls[0]!.error as Error).message).toContain("The buyback completed, but close did not.");
  });

  it("refuses a buyback when an ask changed, the series is gone, or the short balance moved", async () => {
    m.chain.readOrderPreflight.mockResolvedValue([]);
    const { card, calls } = shortCard();
    m.staleSelectedOrders.mockReturnValueOnce([{}] as never);
    await press(card, "Buy back and close");
    expect((calls[0]!.error as Error).message).toBe("An ask changed. Refresh the book and review the buyback cost.");
    m.chain.readSeriesOnChain.mockResolvedValueOnce({ exists: false });
    await press(card, "Buy back and close");
    expect((calls[1]!.error as Error).message).toBe("The series is no longer on chain.");
    m.chain.readAccountOnChain.mockResolvedValueOnce({ longBalance: 0n, shortBalance: 1n, approvedForAll: true });
    await press(card, "Buy back and close");
    expect((calls[2]!.error as Error).message).toBe("Your short balance changed. Refresh Portfolio.");
    expect(m.tx.approveExact).not.toHaveBeenCalled();
  });

  it("closes matched units only when the wallet holds the matching longs", async () => {
    const { card, calls } = shortCard();
    m.chain.readAccountOnChain.mockResolvedValueOnce({ longBalance: 10n, shortBalance: 60n, approvedForAll: true });
    await press(card, "Close matched units");
    expect((calls[0]!.error as Error).message).toBe("Buy or receive matching long units before closing.");
    await press(card, "Close matched units");
    expect(calls[1]).toMatchObject({ title: "Matched position closed", requireTrade: false, error: undefined });
    expect(m.tx.close.mock.calls[0]!.slice(1)).toEqual([BigInt(writerShort.series.longId), 60n]);
  });

  it("says trading has ended but a matched close is still possible after the cutoff window", () => {
    m.offset = writerShort.series.expiry - NOW_S;
    const { card } = shortCard();
    const html = render(card);
    expect(html).toContain("Trading has ended. With matching long units you can still close before settlement.");
    expect(html).not.toContain("Buy back and close");
  });

  it("shows the brake line and no asks message", () => {
    const { card } = shortCard({ trading: false });
    m.books[writerShort.series.longId] = { data: undefined, isError: true };
    const html = render(card);
    expect(html).toContain(TRADING_PAUSED_LINE);
    expect(fact(card, "Buyback costs").v).toBe("Asks unavailable");
    expect(control(card, "Buy back and close").props.disabled).toBe(true);
    m.books[writerShort.series.longId] = { data: book("asks", []), isError: false };
    render(card);
    expect(fact(card, "Buyback costs")).toMatchObject({ v: "No asks cover this size",
      tip: expect.stringContaining("If you hold matching longs, Close matched units needs no buyback.") });
    m.queries["wallet-short"] = { isError: true };
    expect(render(card)).toContain("Wallet balance unavailable. Actions are paused until it loads.");
    type(card, `buyback-size-${writerShort.series.longId}`, "5");
    m.queries["wallet-short"] = { data: 60n };
    expect(render(card)).toContain("Choose up to 0.6 shares in 0.01 steps.");
  });

  it("collects a settled short by redeeming its short token", async () => {
    const settled = { ...writerShort, series: { ...writerShort.series, status: "settled" as const }, claimable: money("1", 18) };
    const { card, calls } = shortCard({ position: settled });
    m.queries["option-redeem-preview"] = { data: { ok: false } };
    await press(card, "Collect");
    expect(calls[0]!.error).toBeUndefined();
    expect(m.tx.redeem.mock.calls[0]![1]).toBe(BigInt(writerShort.series.shortId));
    m.chain.readAccountOnChain.mockResolvedValueOnce({ longBalance: 0n, shortBalance: 0n, approvedForAll: true });
    await press(card, "Collect");
    expect((calls[1]!.error as Error).message).toBe("The payout may already have been pushed. Refresh Portfolio.");
    const noPrefs = shortCard({ position: settled, payoutPrefs: null });
    await press(noPrefs.card, "Collect");
    expect((noPrefs.calls[0]!.error as Error).message).toBe("Read your on-chain payout preference before collecting.");
  });

  it("refuses a buyback without USDG's address", async () => {
    const { card, calls } = shortCard({ usdg: null });
    expect(control(card, "Buy back and close").props.disabled).toBe(true);
    await press(card, "Buy back and close");
    expect((calls[0]!.error as Error).message).toBe("Choose a size fully covered by live asks.");
  });
});

describe("OrderCard (through the orders tab): cancel and edit", () => {
  function orderCard(order: AccountOrder, over: Partial<PositionsResponse> = {}) {
    m.positions = { data: { ...buyerPositions, orders: [order], ...over } };
    const instance = page();
    choose(instance, "orders");
    const element = byType(instance, "OrderCard");
    const card = mount(element.type as never, element.props);
    return { instance, card };
  }
  const chainOrder = (order: AccountOrder, kind: number, over: Record<string, unknown> = {}) => ({
    maker: BUYER, longId: BigInt(order.series.longId), kind, price: BigInt(order.price.raw), units: BigInt(order.units),
    filled: BigInt(order.filled), validUntil: NOW_S + 1_000, cancelled: false, ...over });
  function edit(card: Instance, price: string, size: string) {
    const id = (card.props.order as AccountOrder).orderId;
    if (!findAll(card.tree, (el) => el.props.id === `order-price-${id}`).length) {
      (byType(card, "OrderActions").props.onEdit as () => void)();
      render(card);
    }
    type(card, `order-price-${id}`, price);
    return type(card, `order-size-${id}`, size);
  }

  it("cancels an order after checking it is still this wallet's live order", async () => {
    const { card } = orderCard(buyerBid);
    m.client.readContract.mockResolvedValueOnce([chainOrder(buyerBid, 0)]);
    (byType(card, "OrderActions").props.onCancel as () => void)();
    await flush();
    expect(m.tx.cancel.mock.calls[0]![1]).toEqual([BigInt(buyerBid.orderId)]);
    m.client.readContract.mockResolvedValueOnce([chainOrder(buyerBid, 0, { cancelled: true })]);
    (byType(card, "OrderActions").props.onCancel as () => void)();
    await flush();
    expect(m.notice).toHaveBeenLastCalledWith("error", "Order cancelled stopped", "This order changed. Refresh Portfolio.");
    expect(m.tx.cancel).toHaveBeenCalledTimes(1);
  });

  it("raises a bid: approves only the extra USDG escrow, then replaces", async () => {
    const { card } = orderCard(buyerBid);
    edit(card, "0.6", "1");
    m.client.readContract.mockResolvedValue([chainOrder(buyerBid, 0)]);
    await press(card, "Save replacement");
    expect(m.tx.approveExact.mock.calls[0]!.slice(1)).toEqual([config.usdg.address, V2_DEPLOYMENT.contracts.orderBook, 100_000n]);
    expect(m.tx.replace.mock.calls[0]!.slice(1)).toEqual([BigInt(buyerBid.orderId), 600_000n, 100n]);
  });

  it("lowers a bid without any approval", async () => {
    const { card } = orderCard(buyerBid);
    edit(card, "0.4", "1");
    m.client.readContract.mockResolvedValue([chainOrder(buyerBid, 0)]);
    await press(card, "Save replacement");
    expect(m.tx.approveExact).not.toHaveBeenCalled();
    expect(m.tx.replace).toHaveBeenCalled();
  });

  it("refuses an edit when the chain order expired or changed", async () => {
    const { card } = orderCard(buyerBid);
    edit(card, "0.6", "1");
    m.client.readContract.mockResolvedValue([chainOrder(buyerBid, 0, { validUntil: NOW_S - 1 })]);
    await press(card, "Save replacement");
    expect(m.notice).toHaveBeenLastCalledWith("error", "Order replaced stopped", "This order expired. Cancel it or place a new one.");
    m.client.readContract.mockResolvedValue([chainOrder(buyerBid, 0, { price: 1n })]);
    await press(card, "Save replacement");
    expect(m.notice).toHaveBeenLastCalledWith("error", "Order replaced stopped", "The order changed. Refresh before editing it.");
    expect(m.tx.replace).not.toHaveBeenCalled();
  });

  it("an edit to a size of 0 or a malformed size says to choose a positive size, and replaces nothing", async () => {
    // editOrder parses the size with tryUnits: sharesToUnits threw RangeError("shares must be positive") on 0, so
    // the card's own message was never reached (from PR #1's report).
    const { card } = orderCard(buyerBid);
    m.client.readContract.mockResolvedValue([chainOrder(buyerBid, 0)]);
    for (const size of ["0", "0.00", "1.005", "abc"]) {
      edit(card, "0.6", size);
      await press(card, "Save replacement");
      expect(m.notice).toHaveBeenLastCalledWith("error", "Order replaced stopped", "Choose a positive size in 0.01-share steps.");
    }
    expect(m.tx.replace).not.toHaveBeenCalled();
    expect(m.tx.approveExact).not.toHaveBeenCalled();
    edit(card, "0.6", "1");
    await press(card, "Save replacement");
    expect(m.tx.replace.mock.calls[0]!.slice(1)).toEqual([BigInt(buyerBid.orderId), 600_000n, 100n]);
  });

  it("shows an order past its valid-until as expired and shuts Edit", () => {
    const expired = { ...buyerBid, validUntil: NOW_S - 1 };
    const { card } = orderCard(expired);
    expect(render(card)).toContain("Expired; cancel to recover escrow");
    expect(byType(card, "OrderActions").props.editDisabled).toBe(true);
  });

  it("a writer ask needs enough free collateral for the new size", async () => {
    const ask = { ...buyerBid, orderId: "1010", kind: "AskWrite" as const, price: money("260100"), units: "100", filled: "0" };
    const { card } = orderCard(ask);
    edit(card, "0.3", "1");
    m.client.readContract.mockResolvedValue([chainOrder(ask, 2)]);
    m.readWriterRent.mockResolvedValueOnce({ free: 10n ** 16n * 100n - 1n, rent: 0n });
    await press(card, "Save replacement");
    expect(m.notice).toHaveBeenLastCalledWith("error", "Order replaced stopped", "Deposit enough free collateral for the replacement size.");
    m.readWriterRent.mockResolvedValueOnce({ free: 10n ** 16n * 100n, rent: 0n });
    await press(card, "Save replacement");
    expect(m.tx.replace.mock.calls[0]!.slice(1)).toEqual([1010n, 300_000n, 100n]);
  });

  it("an auto-roll ask offers the strategy link instead of Edit", () => {
    m.address = WRITER;
    const { card } = orderCard(writerAsk, { strategies: writerPositions.strategies });
    expect(byType(card, "OrderActions").props.rollerPlaced).toBe(true);
  });

  describe("resale asks", () => {
    const resale = { ...buyerBid, orderId: "77", kind: "AskResale" as const, price: money("800000"), units: "100", filled: "0" };
    const BIDS: [string, string, string][] = [["700000", "60", "5"]];

    it("re-approves the order book if needed, then replaces a non-crossing resale ask", async () => {
      const { card } = orderCard(resale);
      m.books[resale.series.longId] = { data: book("bids", BIDS), isError: false };
      edit(card, "0.9", "1");
      m.client.readContract.mockImplementation(async ({ functionName }: { functionName: string }) =>
        functionName === "getOrders" ? [chainOrder(resale, 1)] : false);
      expect(render(card)).toContain("Saving cancels this order and places a new one.");
      await press(card, "Save replacement");
      expect(m.tx.setTokenApproval).toHaveBeenCalled();
      expect(m.tx.replace.mock.calls[0]!.slice(1)).toEqual([77n, 900_000n, 100n]);
    });

    it("cancels, sells the crossing part into bids and re-lists the rest when the new price crosses", async () => {
      const { card } = orderCard(resale);
      m.books[resale.series.longId] = { data: book("bids", BIDS), isError: false };
      const html = edit(card, "0.6", "1");
      expect(html).toContain("0.6 shares sell into bids now; 0.4 rest. The old order is cancelled first.");
      m.client.readContract.mockResolvedValue([chainOrder(resale, 1)]);
      m.chain.readOrderPreflight.mockResolvedValue(bidRows(BIDS, resale.series.longId));
      m.chain.readAccountOnChain.mockResolvedValue({ longBalance: 100n, shortBalance: 0n, approvedForAll: false });
      await press(card, "Save replacement");
      expect(m.tx.cancel.mock.calls[0]![1]).toEqual([77n]);
      expect(m.tx.take.mock.calls[0]![1]).toMatchObject({ units: 60n, orderIds: [5n] });
      expect(m.tx.place.mock.calls[0]!.slice(1)).toEqual([BigInt(resale.series.longId), 1, 600_000n, 40n, NOW_S + 1_000]);
      expect(m.tx.replace).not.toHaveBeenCalled();
    });

    it("after cancelling, reports what confirmed if the rest fails", async () => {
      const { card } = orderCard(resale);
      m.books[resale.series.longId] = { data: book("bids", BIDS), isError: false };
      edit(card, "0.6", "1");
      m.client.readContract.mockResolvedValue([chainOrder(resale, 1)]);
      m.chain.readAccountOnChain.mockResolvedValue({ longBalance: 1n, shortBalance: 0n, approvedForAll: true });
      await press(card, "Save replacement");
      const [, title, body] = m.notice.mock.calls.at(-1)!;
      expect(title).toBe("Order replaced stopped");
      expect(body).toContain("The old order was cancelled");
      expect(m.tx.take).not.toHaveBeenCalled();
    });

    it("will not replace a resale ask without bid depth", async () => {
      const { card } = orderCard(resale);
      edit(card, "0.9", "1");
      m.client.readContract.mockResolvedValue([chainOrder(resale, 1)]);
      await press(card, "Save replacement");
      expect(m.notice).toHaveBeenLastCalledWith("error", "Order replaced stopped", "Bid depth is unavailable. Refresh before replacing a resale ask.");
    });
  });
});
