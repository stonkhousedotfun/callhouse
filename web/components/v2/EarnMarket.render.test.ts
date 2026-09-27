/**
 * EarnMarket (/sell/[ticker]) driven end to end in node, against the redesigned screen: the balance panel's deposit and
 * withdraw, the "Get NVDA" swap tab's two zaps, the "Sell once" tab's strike ladder and its one-call ticket (SellTicket:
 * price, review, Place ask, the shortfall deposit), the "Auto-roll" tab's setup, pause, presets, proposed band, USDG
 * price inputs and smart-pricing switch, the Portfolio edit link, and the put path. EarnMarket.test.ts pins the layout
 * from single renders; this file runs the handlers.
 *
 * How, without a DOM: `react`'s state, ref, memo, effect and external-store hooks are swapped for in-memory slots while
 * a component function runs (the harness). The page's returned element tree is searched for a control, and its
 * handler is called directly. The redesign nests panels in props (Tabs `items[].panel`, Disclosure children, Field
 * `tip`), so the search walks every prop value, arrays and plain objects included. The one-call ticket (SellTicket) is
 * a separate component with its own state: it is run under the harness from the element the page rendered, with its
 * own slots, remounted when its React key changes. Effects run after each harness render, as a commit would. Markup is
 * read with the harness off, so children use real React. Every chain read and write is a mock with a stated answer.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Address } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import type { ConfigResponse, MarketSeriesResponse, Strategy } from "@/lib/v2/api-types";

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
    useRef: (init: unknown) => {
      if (!h.active) return actual.useRef(init);
      const i = h.cursor++;
      if (!(i in h.slots)) h.slots[i] = { current: init };
      return h.slots[i];
    },
    useMemo: (fn: () => unknown, deps: unknown[]) => (h.active ? fn() : actual.useMemo(fn, deps)),
    useEffect: (fn: () => unknown, deps?: unknown[]) => (h.active ? void h.effects.push(fn) : actual.useEffect(fn as never, deps)),
    useSyncExternalStore: (subscribe: never, get: () => unknown, server?: () => unknown) =>
      h.active ? get() : actual.useSyncExternalStore(subscribe, get as never, server as never),
  };
});

type Query = { data?: unknown; isPending?: boolean; isError?: boolean; isFetching?: boolean; error?: unknown; refetch?: () => Promise<unknown> };
type QueryOptions = { queryKey: unknown[]; queryFn: (ctx?: unknown) => unknown; enabled?: boolean };
const m = vi.hoisted(() => ({
  address: undefined as Address | undefined,
  wallet: { id: "wallet" } as unknown,
  now: 0,
  config: undefined as unknown,
  warnings: [] as string[],
  provenance: [] as string[],
  conflicts: [] as string[],
  zapMismatch: null as string | null,
  markets: {} as Query,
  series: {} as Query,
  allCalls: {} as Query,
  fair: {} as Query,
  positions: {} as Query,
  strategies: {} as Query,
  queries: {} as Record<string, Query>,
  options: {} as Record<string, QueryOptions>,
  seriesArgs: [] as unknown[][],
  allCallArgs: [] as unknown[][],
  invalidate: vi.fn(async () => undefined),
  notice: vi.fn(),
  receipt: vi.fn(() => false),
  earn: {
    createSeries: vi.fn(), preflightAsk: vi.fn(), readMintCutoff: vi.fn(), readRollPosition: vi.fn(), readRollState: vi.fn(),
    readWriterBalance: vi.fn(), readWriterFree: vi.fn(), readWriterRent: vi.fn(), setDelegate: vi.fn(), setStrategy: vi.fn(), stopStrategy: vi.fn(),
  },
  tx: { approveExact: vi.fn(), deposit: vi.fn(), place: vi.fn(), setOperator: vi.fn(), setPayoutToLedger: vi.fn(), withdraw: vi.fn() },
  zap: { exitZap: vi.fn(), writeZap: vi.fn() },
  readPayoutPrefs: vi.fn(), readRollPreview: vi.fn(), lifetimePremium: vi.fn(), getServices: vi.fn(), getFair: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: QueryOptions) => {
    const key = String(options.queryKey[1]);
    m.options[key] = options;
    return { isPending: false, isError: false, data: undefined, ...m.queries[key] };
  },
  useQueryClient: () => ({ invalidateQueries: m.invalidate }),
}));
vi.mock("wagmi", () => ({ useAccount: () => ({ address: m.address }), useWalletClient: () => ({ data: m.wallet }) }));
vi.mock("@/components/ConnectButton", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return { ConnectButton: () => react.createElement("button", null, "Connect wallet") };
});
vi.mock("@/components/TxToast", () => ({ useNotice: () => m.notice, useV2ReceiptNotice: () => m.receipt }));
vi.mock("@/components/v2/PendingOperationsNotice", () => ({ PendingOperationsNotice: () => null }));
vi.mock("@/lib/hooks", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/hooks")>()), useNow: () => m.now }));
vi.mock("@/lib/v2/hooks", () => ({
  useAllMarketSeries: (...args: unknown[]) => { m.allCallArgs.push(args); return m.allCalls; },
  useConfig: () => ({ data: m.config }), useFair: () => m.fair,
  useMarketSeries: (...args: unknown[]) => { m.seriesArgs.push(args); return m.series; },
  useMarkets: () => m.markets, usePositions: () => m.positions, useStrategies: () => m.strategies, v2Keys: { all: ["v2"] },
}));
vi.mock("@/lib/v2/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/config")>()),
  v2ConfigWarnings: () => m.warnings, v2AddressProvenanceNotices: () => m.provenance,
  v2AddressOverrideConflictNotices: () => m.conflicts, v2StockZapMismatch: () => m.zapMismatch,
}));
vi.mock("@/lib/v2/earnTx", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/v2/earnTx")>()), ...m.earn }));
vi.mock("@/lib/v2/tx", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/v2/tx")>()), ...m.tx }));
vi.mock("@/lib/v2/zapTx", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/v2/zapTx")>()), ...m.zap }));
vi.mock("@/lib/v2/chainReads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/chainReads")>()), readPayoutPrefs: m.readPayoutPrefs,
}));
vi.mock("@/lib/v2/moneyPreviews", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/moneyPreviews")>()), readRollPreview: m.readRollPreview,
}));
vi.mock("@/lib/v2/historySummary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/historySummary")>()), lifetimePremium: m.lifetimePremium,
}));
vi.mock("@/lib/v2/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/api")>()), v2Api: { getServices: m.getServices, getFair: m.getFair },
}));

import { USDG } from "@/lib/contracts";
import { v2Markets } from "@/lib/markets";
import { V2_DEPLOYMENT } from "@/lib/v2/config";
import { presetAutoRollTarget } from "@/lib/v2/presets";
import { SMART_PRICING_PRICER_DOWN, SMART_PRICING_PRICER_UNKNOWN } from "@/lib/v2/smartPricing";
import { TRADING_PAUSED_LINE } from "@/lib/v2/tradingGate";
import { UPGRADE_PAUSE_NOTE, UPGRADE_PAUSE_UNREAD_NOTE } from "@/lib/v2/upgradePause";
import { EarnMarket } from "./EarnMarket";
import { SellTicket } from "./sell/SellTicket";

// ---- fixtures ----
const fixtures = fileURLToPath(new URL("../../../ops/fixtures/api/v2/", import.meta.url));
const read = <T,>(path: string): T => JSON.parse(readFileSync(`${fixtures}/${path}`, "utf8")) as T;
const config = read<ConfigResponse>("config.json");
const seriesFixture = read<MarketSeriesResponse>("markets/NVDA/series.json");
const NOW_S = 1_800_000_000;
const EXPIRY = NOW_S + 86_400;
const EXPIRY_2 = NOW_S + 2 * 86_400;
const WRITER = "0x1111111111111111111111111111111111111111" as Address;
const UNDERLYING = v2Markets().find((row) => row.ticker === "NVDA")!.asset as Address;
const money = (raw: string, decimals = 6) => ({ raw, decimals, formatted: String(Number(raw) / 10 ** decimals) });
const liveMarket = (over: Record<string, unknown> = {}) => ({
  ticker: "NVDA", underlying: UNDERLYING, status: "live", puts: false, tradingPaused: false, mintPaused: false,
  spot: money("200000000"), strikeTick: money("1000000"), expiries: [EXPIRY], ...over,
});
function row(longId: string, strike: number, over: { isPut?: boolean; tenor?: string; expiry?: number; fair?: string | null; delta?: number | null } = {}) {
  const base = seriesFixture.items[0]!;
  return { ...base, series: { ...base.series, longId, isPut: over.isPut ?? false, strike: money(String(strike * 1_000_000)),
    expiry: over.expiry ?? EXPIRY, mintCutoff: (over.expiry ?? EXPIRY) - 1_800, tenor: over.tenor ?? "daily", status: "open" },
    quote: { ...base.quote, fair: over.fair === null ? null : money(over.fair ?? "2500000"), delta: over.delta ?? null } };
}
const LADDER = [row("201", 201), row("205", 205), row("210", 210)];
const BALANCE = { wallet: 10n ** 18n, free: 5n * 10n ** 17n, rollerOperator: false, orderBookOperator: false };
const HEALTHY_PRICER = { data: { pricer: { healthy: true, checkedAt: NOW_S - 5 } } };
const PRESET_DAILY = "Daily, +2% OTM" + "A short daily call about 2% above spot.";

// ---- mounting ----
let slots: unknown[] = [];
let effects: (() => unknown)[] = [];
let tree: ReactNode = null;
let ticketSlots: unknown[] = [];
let ticketKey: unknown = Symbol("unmounted");
let ticketTree: ReactNode = null;

/** One page render under the harness, then its effects (a commit), then the markup with real React. */
function render(ticker = "NVDA"): string {
  h.active = true; h.cursor = 0; h.slots = slots; h.effects = [];
  try { tree = EarnMarket({ ticker }); } finally { h.active = false; }
  effects = h.effects;
  effects.forEach((fn) => fn());
  return renderToStaticMarkup(createElement("div", null, tree));
}

/** The one-call ticket the page rendered, run under the harness with its own state; remounted when its key changes. */
function ticket(): string {
  const [el] = findAll(tree, (e) => e.type === SellTicket);
  if (!el) throw new Error("the page rendered no SellTicket");
  if (el.key !== ticketKey) { ticketSlots = []; ticketKey = el.key; }
  h.active = true; h.cursor = 0; h.slots = ticketSlots; h.effects = [];
  try { ticketTree = SellTicket(el.props as Parameters<typeof SellTicket>[0]); } finally { h.active = false; }
  return renderToStaticMarkup(createElement("div", null, ticketTree));
}

type El = ReactElement<Record<string, unknown>>;
const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;
/** Every element under `node` that `pred` accepts, walking all props (elements, arrays and plain objects). */
function findAll(node: unknown, pred: (el: El) => boolean, out: El[] = [], seen = new Set<unknown>()): El[] {
  if (node === null || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) { node.forEach((child) => findAll(child, pred, out, seen)); return out; }
  if (isValidElement(node)) {
    const el = node as El;
    if (pred(el)) out.push(el);
    for (const value of Object.values(el.props)) findAll(value, pred, out, seen);
    return out;
  }
  if (isPlain(node)) for (const value of Object.values(node)) findAll(value, pred, out, seen);
  return out;
}
const textOf = (n: unknown): string => typeof n === "string" || typeof n === "number" ? String(n)
  : Array.isArray(n) ? n.map(textOf).join("") : isValidElement(n) ? textOf((n.props as { children?: unknown }).children) : "";
function control(label: string, root: ReactNode = tree): El {
  const [hit] = findAll(root, (el) => (typeof el.props.onClick === "function" || typeof el.props.onSelect === "function")
    && (textOf(el.props.children) === label || el.props["aria-label"] === label || el.props.label === label));
  if (!hit) throw new Error(`no control ${label}`);
  return hit;
}
const buttons = (label: string, root: ReactNode = tree) =>
  findAll(root, (el) => typeof el.props.onClick === "function" && textOf(el.props.children) === label);
/** A strike row on the ladder, by its strike ("$205 Call…"). */
function strikeRow(strike: string): El {
  const [hit] = findAll(tree, (el) => el.type === "button" && "aria-pressed" in el.props && textOf(el.props.children).startsWith(`$${strike} `));
  if (!hit) throw new Error(`no strike row ${strike}`);
  return hit;
}
const customStrikeButton = () => findAll(tree, (el) => el.type === "button" && textOf(el.props.children).startsWith("Custom strike"))[0]!;
const presetButton = () => control(PRESET_DAILY);
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
async function press(label: string): Promise<string> {
  (control(label).props.onClick as () => void)();
  await flush();
  return render();
}
async function pressTicket(label: string): Promise<string> {
  (control(label, ticketTree).props.onClick as () => void)();
  await flush();
  render();
  return ticket();
}
function field(id: string, root: ReactNode = tree): El {
  const [hit] = findAll(root, (el) => el.props.id === id && typeof el.props.onChange === "function");
  if (!hit) throw new Error(`no field ${id}`);
  return hit;
}
const hasField = (id: string, root: ReactNode = tree) => findAll(root, (el) => el.props.id === id).length > 0;
function set(id: string, value: string): string {
  (field(id).props.onChange as (e: unknown) => void)({ target: { value, checked: value } });
  return render();
}
function setTicket(id: string, value: string): string {
  (field(id, ticketTree).props.onChange as (e: unknown) => void)({ target: { value } });
  render();
  return ticket();
}
function blur(id: string): string {
  (field(id).props.onBlur as () => void)();
  return render();
}
const checkbox = () => findAll(tree, (el) => el.type === "input" && el.props.type === "checkbox")[0]!;
function toggleSmartPricing(on: boolean): string {
  (checkbox().props.onChange as (e: unknown) => void)({ target: { checked: on } });
  return render();
}
const lastNotice = () => m.notice.mock.calls.at(-1)!;

function connect() {
  m.address = WRITER;
  m.queries.writerBalance = { data: BALANCE };
  m.queries.writerRoll = { data: { strategyActive: false, delegate: false } };
  m.queries.writerPayoutPrefs = { data: { inKind: false, toLedger: false } };
}

function EMPTY(): Strategy {
  return { active: true, weekly: false, smartPricing: false, otmBps: 500, askBps: 100, minAskBps: 0, maxAskBps: 0, maxUnits: "0" };
}
const savedStrategy = (strategy: Strategy) => ({ writer: WRITER, underlying: UNDERLYING, ticker: "NVDA", strategy,
  currentLongId: null, orderId: null, expiry: null, lastRolledAt: null, lastStaleCancelAt: null, staleSpot: null });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_S * 1000);
  vi.stubGlobal("window", { location: { search: "" }, setTimeout: vi.fn(() => 9), clearTimeout: vi.fn() });
  vi.stubGlobal("document", { getElementById: vi.fn(() => ({ scrollIntoView: vi.fn() })) });
  slots = []; effects = []; tree = null;
  ticketSlots = []; ticketKey = Symbol("unmounted"); ticketTree = null;
  m.address = undefined; m.wallet = { id: "wallet" }; m.now = NOW_S; m.config = config;
  m.warnings = []; m.provenance = []; m.conflicts = []; m.zapMismatch = null;
  m.markets = { data: [liveMarket()], isError: false, refetch: vi.fn(async () => ({ data: [liveMarket()], isError: false })) };
  m.series = { data: { items: LADDER }, isError: false };
  m.allCalls = { data: undefined, isError: false, isFetching: false, refetch: vi.fn(async () => ({ data: { items: LADDER }, error: null })) };
  m.fair = { data: undefined };
  m.positions = { data: undefined };
  m.strategies = { data: undefined, isError: false };
  m.queries = {}; m.options = {}; m.seriesArgs = []; m.allCallArgs = [];
  for (const fn of [m.invalidate, m.notice, m.receipt, ...Object.values(m.earn), ...Object.values(m.tx), ...Object.values(m.zap),
    m.readPayoutPrefs, m.readRollPreview, m.lifetimePremium, m.getServices, m.getFair]) (fn as Mock).mockReset();
  m.receipt.mockReturnValue(false);
  m.earn.readWriterBalance.mockResolvedValue(BALANCE);
  m.earn.readWriterFree.mockResolvedValue(BALANCE.free);
  m.getFair.mockResolvedValue({ fair: null });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("EarnMarket: page reads and notices", () => {
  it("asks the indexer for open series of the chosen type only, and reads the full call list only on demand", () => {
    render();
    expect(m.seriesArgs[0]).toEqual(["NVDA", { type: "call", status: "open", limit: 200 }]);
    expect(m.allCallArgs[0]).toEqual(["NVDA", { type: "call", status: "open" }, { enabled: false }]);
  });

  it("runs each account read against the connected writer and this market's collateral, the ticket's rent read included", () => {
    connect();
    render();
    ticket();
    m.options.writerBalance!.queryFn();
    expect(m.earn.readWriterBalance).toHaveBeenCalledWith(WRITER, UNDERLYING);
    m.options.writerRoll!.queryFn();
    expect(m.earn.readRollState).toHaveBeenCalledWith(WRITER, UNDERLYING);
    m.options.writerPayoutPrefs!.queryFn();
    expect(m.readPayoutPrefs).toHaveBeenCalledWith(WRITER);
    const signal = new AbortController().signal;
    m.options.writerLifetimePremium!.queryFn({ signal });
    expect(m.lifetimePremium).toHaveBeenCalledWith(WRITER, "NVDA", signal);
    m.options["roll-preview"]!.queryFn();
    expect(m.readRollPreview.mock.calls[0]!.slice(1)).toEqual([V2_DEPLOYMENT.contracts.autoRoller, WRITER, UNDERLYING]);
    m.options.services!.queryFn();
    expect(m.getServices).toHaveBeenCalled();
    // The ticket opens on the first open strike (201), 0.01 share (1 unit).
    m.options.writerRent!.queryFn();
    expect(m.earn.readWriterRent).toHaveBeenCalledWith(UNDERLYING, false, 201_000_000n, EXPIRY, 1n, WRITER);
  });

  it("names a missing price, a config mismatch, provenance, conflicts and a zap mismatch, and shuts the writes they gate", () => {
    connect();
    m.markets = { data: [liveMarket({ spot: null })], isError: false };
    m.warnings = ["x"];
    m.provenance = ["Clearinghouse from override."];
    m.conflicts = ["Override outranked."];
    m.zapMismatch = "The indexer's StockZap differs.";
    render();
    set("writer-deposit", "0.25");
    const html = set("writer-withdraw", "0.1");
    expect(html).toContain("The live NVDA price is unavailable. New deposits and asks are paused; you can still withdraw.");
    expect(html).toContain("App and indexer contract settings differ. Writing is paused until they match.");
    expect(html).toContain("Clearinghouse from override.");
    expect(html).toContain("Override outranked.");
    expect(html).toContain("The indexer&#x27;s StockZap differs.");
    // Both zap buttons read "Zap paused" and are shut; so are Deposit and the auto-roll button. Withdraw stays open.
    const zaps = buttons("Zap paused");
    expect(zaps).toHaveLength(2);
    expect(zaps.every((el) => el.props.disabled === true)).toBe(true);
    expect(control("Deposit").props.disabled).toBe(true);
    expect(control("Enable auto-roll").props.disabled).toBe(true);
    expect(control("Withdraw").props.disabled).toBe(false);
    // A failed market read: the page says so, and the deposit door stays shut with its reason.
    m.markets = { data: undefined, isError: true };
    const down = render();
    expect(down).toContain("Market data is unavailable right now. Your balance is unaffected.");
    expect(down).toContain(UPGRADE_PAUSE_UNREAD_NOTE);
    expect(control("Deposit").props.disabled).toBe(true);
  });

  it("before the clock mounts: no spot, so no USDG price conversion, no smart pricing, no presets and no auto-roll", () => {
    connect();
    m.now = 0;
    m.queries.services = HEALTHY_PRICER;
    const html = render();
    expect(html).toContain("Live spot is required to convert USDG prices to contract bps.");
    expect(checkbox().props.disabled).toBe(true);
    expect(html).toContain(SMART_PRICING_PRICER_UNKNOWN);
    expect(presetButton().props.disabled).toBe(true);
    expect(control("Fill proposed band").props.disabled).toBe(true);
    expect(control("Enable auto-roll").props.disabled).toBe(true);
  });

  it("shows the position card with free, locked, premium and roll status, and the stale-cancel notice", () => {
    connect();
    m.queries.writerRoll = { data: { strategyActive: true, delegate: true } };
    m.queries.writerBalance = { data: { ...BALANCE, rollerOperator: true, orderBookOperator: true } };
    m.queries.writerLifetimePremium = { data: { amount: 1_234_500n, complete: false } };
    const short = { series: { ...LADDER[0]!.series, ticker: "NVDA", expiry: EXPIRY }, units: "10", premiumReceived: money("1"),
      collateralLocked: money("100000000000000000", 18), claimable: null };
    m.positions = { data: { longs: [], shorts: [short], orders: [], ledger: [], strategies: [{ ticker: "NVDA", strategy: { active: true },
      currentSeries: LADDER[0]!.series, orderId: "12" }] } };
    m.strategies = { data: { items: [{ writer: WRITER, underlying: UNDERLYING, ticker: "NVDA", strategy: { ...EMPTY(), active: true },
      currentLongId: "201", orderId: null, expiry: EXPIRY, lastRolledAt: NOW_S - 50, lastStaleCancelAt: NOW_S - 10,
      staleSpot: money("212000000"), pricing: undefined }] } };
    const html = render();
    expect(html).toContain("Your position");
    expect(html).toContain("Premium in loaded history");
    expect(html).toContain("1.2345");
    expect(html).toContain("Active");
    expect(html).toContain("Next possible roll");
    expect(html).toContain("Current call: NVDA $201");
    expect(html).toContain("Ask withdrawn at/past strike after spot reached $212");
    expect(control("Pause auto-roll").props.disabled).toBe(false);
    expect(control("Update strategy").props.disabled).toBe(true);
    expect(html).toContain("Load the saved strategy or select a preset to update it.");
  });

  it("names unreadable balance and roll status in the position card, and keeps the Withdraw form", () => {
    connect();
    m.queries.writerBalance = { isError: true };
    m.queries.writerRoll = { isError: true };
    m.queries.writerLifetimePremium = { isError: true };
    const html = render();
    expect(html).toContain("Your position");
    expect(html).toContain("Your balance could not be read.");
    expect(html).toContain("Auto-roll status could not be read.");
    expect(html).toContain("Status unavailable");
    expect(html).toContain("Premium history is temporarily unavailable.");
    expect(hasField("writer-withdraw")).toBe(true);
    // An unreadable roll state is not a paused one: Pause is still offered.
    expect(control("Pause auto-roll").props.disabled).toBe(false);
  });
});

describe("EarnMarket: moving collateral", () => {
  beforeEach(connect);

  it("deposits exactly the typed amount after checking the wallet holds it", async () => {
    render();
    set("writer-deposit", "0.25");
    expect(control("Deposit").props.disabled).toBe(false);
    await press("Deposit");
    expect(m.earn.readWriterBalance).toHaveBeenCalledWith(WRITER, UNDERLYING);
    expect(m.tx.approveExact.mock.calls[0]!.slice(1)).toEqual([UNDERLYING, V2_DEPLOYMENT.contracts.clearinghouse, 25n * 10n ** 16n]);
    expect(m.tx.deposit.mock.calls[0]!.slice(1)).toEqual([UNDERLYING, 25n * 10n ** 16n]);
    expect(m.tx.approveExact.mock.invocationCallOrder[0]).toBeLessThan(m.tx.deposit.mock.invocationCallOrder[0]!);
    expect(lastNotice()).toEqual(["success", "Deposit Stock Tokens", "0.25 Stock Tokens moved into your free Stonkhouse balance."]);
    expect(field("writer-deposit").props.value).toBe("");
    // The write context refreshes the writer reads once a transaction confirms.
    await (m.tx.deposit.mock.calls[0]![0] as { onConfirmed: () => Promise<void> }).onConfirmed();
    expect(m.invalidate).toHaveBeenCalledWith({ queryKey: ["v2", "writerBalance", WRITER, "NVDA"] });
  });

  it("refuses a deposit the wallet cannot cover, and one while the deployment is paused for an upgrade", async () => {
    m.earn.readWriterBalance.mockResolvedValue({ ...BALANCE, wallet: 1n });
    render();
    set("writer-deposit", "0.25");
    await press("Deposit");
    expect(lastNotice()).toEqual(["error", "Deposit Stock Tokens stopped", "Your wallet does not hold that much Stock Tokens."]);
    expect(m.tx.approveExact).not.toHaveBeenCalled();
    // Every market reading both brakes on is the upgrade pause: the deposit door closes and says why.
    m.markets = { data: [liveMarket({ tradingPaused: true, mintPaused: true })], isError: false };
    expect(render()).toContain(UPGRADE_PAUSE_NOTE);
    expect(control("Deposit").props.disabled).toBe(true);
    await press("Deposit");
    expect(lastNotice()[2]).toBe(UPGRADE_PAUSE_NOTE);
    expect(m.tx.deposit).not.toHaveBeenCalled();
  });

  it("withdraws only free collateral", async () => {
    render();
    set("writer-withdraw", "0.1");
    await press("Withdraw");
    expect(m.earn.readWriterFree).toHaveBeenCalledWith(WRITER, UNDERLYING);
    expect(m.tx.withdraw.mock.calls[0]!.slice(1)).toEqual([UNDERLYING, 10n ** 17n]);
    expect(lastNotice()[2]).toBe("0.1 Stock Tokens returned to your wallet.");
    set("writer-withdraw", "0.9");
    await press("Withdraw");
    expect(lastNotice()[2]).toBe("Only free collateral can be withdrawn. Open asks and short positions may lock the rest.");
    expect(m.tx.withdraw).toHaveBeenCalledTimes(1);
  });

  it("names a bad amount, a non-Error failure generically, and leaves an unknown receipt to the receipt notice", async () => {
    render();
    set("writer-withdraw", "abc");
    expect(control("Withdraw").props.disabled).toBe(true);
    (control("Withdraw").props.onClick as () => void)();
    await flush();
    expect(lastNotice()[2]).toBe("Enter a positive Stock Tokens amount, up to 18 decimal places.");
    set("writer-withdraw", "0.1");
    m.tx.withdraw.mockRejectedValueOnce("boom");
    await press("Withdraw");
    expect(lastNotice()).toEqual(["error", "Withdraw Stock Tokens stopped", "Try again after refreshing."]);
    m.tx.withdraw.mockRejectedValueOnce(new Error("unknown receipt"));
    m.receipt.mockReturnValueOnce(true);
    m.notice.mockClear();
    await press("Withdraw");
    expect(m.notice.mock.calls.map((c) => c[0])).toEqual(["pending"]);
  });

  it("refuses to write without a wallet client", async () => {
    m.wallet = undefined;
    render();
    set("writer-withdraw", "0.1");
    expect(control("Withdraw").props.disabled).toBe(true);
    await press("Withdraw");
    expect(lastNotice()).toEqual(["error", "Withdraw Stock Tokens stopped", "Connect your wallet and check the configured Clearinghouse address."]);
    expect(m.tx.withdraw).not.toHaveBeenCalled();
  });
});

describe("EarnMarket: zaps (the Get NVDA tab)", () => {
  beforeEach(connect);

  it("zaps USDG into Stock Tokens with a quoted minimum, approving the zap for exactly the amount", async () => {
    render();
    const html = set("writer-zap-in", "100");
    expect(html).toMatch(/Minimum received<\/dt><dd[^>]*>[\d.,]+ NVDA<\/dd>/);
    expect(control("Zap in").props.disabled).toBe(false);
    await press("Zap in");
    expect(V2_DEPLOYMENT.contracts.stockZap).toBeTruthy();
    expect(m.tx.approveExact.mock.calls[0]!.slice(1)).toEqual([USDG, V2_DEPLOYMENT.contracts.stockZap, 100_000_000n]);
    expect(m.zap.writeZap.mock.calls[0]!.slice(1, 3)).toEqual([UNDERLYING, 100_000_000n]);
    expect(lastNotice()[2]).toBe("100 USDG swapped to Stock Tokens in your free Stonkhouse balance.");
    expect(field("writer-zap-in").props.value).toBe("");
  });

  it("exits Stock Tokens to USDG with a quoted minimum, approving the zap for exactly the amount", async () => {
    render();
    const html = set("writer-zap-out", "0.5");
    expect(html).toMatch(/Minimum received<\/dt><dd[^>]*>[\d.,]+ USDG<\/dd>/);
    await press("Exit zap");
    expect(m.tx.approveExact.mock.calls[0]!.slice(1)).toEqual([UNDERLYING, V2_DEPLOYMENT.contracts.stockZap, 5n * 10n ** 17n]);
    expect(m.zap.exitZap.mock.calls[0]!.slice(1, 3)).toEqual([UNDERLYING, 5n * 10n ** 17n]);
    expect(lastNotice()[2]).toBe("0.5 Stock Tokens sold for USDG.");
  });
});

describe("EarnMarket: a manual ask (the Sell once tab and its ticket)", () => {
  beforeEach(() => {
    connect();
    m.queries.writerRent = { data: { rent: 0n, free: 10n ** 18n } };
  });

  it("prices an ask against fair value, reviews it, and lists it: operator, new series, then place until the cutoff", async () => {
    m.earn.preflightAsk.mockResolvedValue({ longId: 205n, operator: false, exists: false, mintCutoff: null, now: NOW_S });
    m.earn.readMintCutoff.mockResolvedValue(EXPIRY - 1_800);
    render();
    (strikeRow("205").props.onClick as () => void)();
    render();
    expect(strikeRow("205").props["aria-pressed"]).toBe(true);
    let html = ticket();
    expect(html).toContain("Sell NVDA $205 Call");
    // An untouched price starts at the row's mark, on the tick.
    expect(field("ask-price", ticketTree).props.value).toBe("2.5");
    html = setTicket("ask-price", "3");
    expect(html).toContain("Your price is 20.0% over fair value.");
    expect(html).toMatch(/Locked while open[\s\S]*?<\/dt><dd[^>]*>0\.01 NVDA<\/dd>/);
    expect(html).toContain("At expiry");
    expect(html).toContain("Keep your 0.01 NVDA, plus");
    html = await pressTicket("Review order");
    expect(html).toContain("Sell 0.01 shares of the NVDA $205 call expiring");
    expect(html).toContain("at $3 per share or more.");
    expect(control("Place ask", ticketTree).props.disabled).toBe(false);
    await pressTicket("Place ask");
    expect(m.tx.setOperator.mock.calls[0]!.slice(1)).toEqual([V2_DEPLOYMENT.contracts.orderBook, true]);
    expect(m.earn.createSeries.mock.calls[0]!.slice(1)).toEqual([UNDERLYING, false, 205_000_000n, EXPIRY]);
    const [, longId, kind, price, units, validUntil] = m.tx.place.mock.calls[0]!;
    expect([longId, kind, price, units]).toEqual([205n, 2, 3_000_000n, 1n]);
    expect(m.earn.readMintCutoff).toHaveBeenCalledWith(205n);
    expect(validUntil).toBeGreaterThan(NOW_S);
    expect(validUntil).toBeLessThan(EXPIRY - 1_800);
    const order = [m.tx.setOperator, m.earn.createSeries, m.tx.place].map((fn) => fn.mock.invocationCallOrder[0]!);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(lastNotice()).toEqual(["success", "Place your ask", "Your NVDA call ask is open at 3 USDG per share. Premium arrives only if a buyer fills."]);
  });

  it("refuses when the chain's series differs from the one picked, before any write", async () => {
    m.earn.preflightAsk.mockResolvedValue({ longId: 999n, operator: false, exists: false, mintCutoff: 1, now: NOW_S });
    render();
    ticket();
    setTicket("ask-price", "3");
    await pressTicket("Review order");
    await pressTicket("Place ask");
    expect(lastNotice()).toEqual(["error", "Place your ask stopped", "The selected series changed. Refresh the ladder."]);
    expect(m.tx.setOperator).not.toHaveBeenCalled();
    expect(m.earn.createSeries).not.toHaveBeenCalled();
    expect(m.tx.place).not.toHaveBeenCalled();
  });

  it("asks for the shortfall when the free balance cannot cover the size, keeps Place ask shut, and deposits exactly it", async () => {
    m.queries.writerRent = { data: { rent: 10n, free: 1n } };
    // Collateral is 0.01 NVDA (1e16) for one unit, plus rent 10, less free 1.
    const shortfall = 10n ** 16n + 9n;
    render();
    ticket();
    let html = setTicket("ask-price", "3");
    expect(html).toMatch(/Deposit <b[^>]*>0\.01 NVDA<\/b> into your StonkHouse balance to cover this ask\./);
    html = await pressTicket("Review order");
    expect(html).toContain("Deposit 0.01 NVDA first: press Edit.");
    expect(control("Place ask", ticketTree).props.disabled).toBe(true);
    await pressTicket("Edit");
    await pressTicket("Deposit 0.01 NVDA");
    expect(m.tx.approveExact.mock.calls[0]!.slice(1)).toEqual([UNDERLYING, V2_DEPLOYMENT.contracts.clearinghouse, shortfall]);
    expect(m.tx.deposit.mock.calls[0]!.slice(1)).toEqual([UNDERLYING, shortfall]);
    expect(lastNotice()[0]).toBe("success");
    expect(m.tx.place).not.toHaveBeenCalled();
  });

  it("keeps Place ask shut until the on-chain collateral estimate is read, and while that read is failing", async () => {
    m.queries.writerRent = { data: undefined };
    render();
    ticket();
    const html = setTicket("ask-price", "3");
    expect(html).toMatch(/Free balance needed[\s\S]*?<\/dt><dd[^>]*><span[^>]*>Checking…<\/span><\/dd>/);
    await pressTicket("Review order");
    expect(control("Place ask", ticketTree).props.disabled).toBe(true);
    // A failed re-read is not trusted even with an older answer still cached.
    m.queries.writerRent = { isError: true, data: { rent: 0n, free: 10n ** 18n } };
    render();
    ticket();
    expect(control("Place ask", ticketTree).props.disabled).toBe(true);
    m.queries.writerRent = { data: { rent: 0n, free: 10n ** 18n } };
    render();
    ticket();
    expect(control("Place ask", ticketTree).props.disabled).toBe(false);
  });

  it("accepts a custom strike and hands it to the ticket; a new expiry clears the pick", () => {
    m.markets = { data: [liveMarket({ expiries: [EXPIRY, EXPIRY_2] })], isError: false };
    render();
    (customStrikeButton().props.onClick as () => void)();
    let html = render();
    expect(customStrikeButton().props["aria-pressed"]).toBe(true);
    expect(html).toContain("Strikes go in steps of 1 USDG. A new strike adds one transaction.");
    set("custom-strike", "207");
    html = ticket();
    expect(html).toContain("Sell NVDA $207 Call");
    setTicket("ask-price", "1");
    m.options.writerRent!.queryFn();
    expect(m.earn.readWriterRent).toHaveBeenLastCalledWith(UNDERLYING, false, 207_000_000n, EXPIRY, 1n, WRITER);
    // A new expiry resets the strike: no custom field, no row for a date with no open strikes, and nothing to review.
    (control("Expiry").props.onSelect as (value: string) => void)(String(EXPIRY_2));
    html = render();
    expect(control("Expiry").props.selected).toBe(String(EXPIRY_2));
    expect(hasField("custom-strike")).toBe(false);
    expect(html).toContain("No open strikes for this expiry yet. Use a custom strike to create one.");
    ticket();
    const [el] = findAll(tree, (e) => e.type === SellTicket);
    expect(el!.props).toMatchObject({ row: null, customStrike: null, expiry: EXPIRY_2 });
    expect(control("Review order", ticketTree).props.disabled).toBe(true);
  });

  it("shows the trading brake and keeps Place ask shut while it is on", async () => {
    m.markets = { data: [liveMarket({ tradingPaused: true })], isError: false };
    render();
    ticket();
    setTicket("ask-price", "3");
    const html = await pressTicket("Review order");
    expect(html).toContain(TRADING_PAUSED_LINE);
    expect(control("Place ask", ticketTree).props.disabled).toBe(true);
  });
});

describe("EarnMarket: auto-roll", () => {
  beforeEach(connect);

  it("walks every missing setup step in order, then saves the strategy", async () => {
    m.earn.readRollState.mockResolvedValue({ strategyActive: false, delegate: false });
    m.readPayoutPrefs.mockResolvedValue({ inKind: false, toLedger: false });
    render();
    expect(control("Enable auto-roll").props.disabled).toBe(false);
    await press("Enable auto-roll");
    expect(m.tx.setPayoutToLedger.mock.calls[0]![1]).toBe(true);
    expect(m.tx.setOperator.mock.calls.map((c) => c.slice(1))).toEqual([
      [V2_DEPLOYMENT.contracts.autoRoller, true], [V2_DEPLOYMENT.contracts.orderBook, true]]);
    expect(m.earn.setDelegate.mock.calls[0]!.slice(1)).toEqual([V2_DEPLOYMENT.contracts.autoRoller, true]);
    const [, underlying, saved] = m.earn.setStrategy.mock.calls[0]!;
    expect(underlying).toBe(UNDERLYING);
    // A blank plan: the default daily 5% call, fixed ask, no band, and max size 0 (all free collateral).
    expect(saved).toEqual({ active: true, weekly: false, smartPricing: false, otmBps: 500, askBps: 100, minAskBps: 0, maxAskBps: 0, maxUnits: "0" });
    const order = [m.tx.setPayoutToLedger.mock.invocationCallOrder[0]!, ...m.tx.setOperator.mock.invocationCallOrder,
      m.earn.setDelegate.mock.invocationCallOrder[0]!, m.earn.setStrategy.mock.invocationCallOrder[0]!];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(lastNotice()[2]).toContain("Auto-roll is on.");
  });

  it("stops at the step that fails: later steps and the strategy are never sent", async () => {
    m.earn.readRollState.mockResolvedValue({ strategyActive: false, delegate: false });
    m.readPayoutPrefs.mockResolvedValue({ inKind: false, toLedger: true });
    m.tx.setOperator.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("user rejected"));
    render();
    const html = await press("Enable auto-roll");
    expect(m.tx.setPayoutToLedger).not.toHaveBeenCalled();
    expect(m.tx.setOperator).toHaveBeenCalledTimes(2);
    expect(m.earn.setDelegate).not.toHaveBeenCalled();
    expect(m.earn.setStrategy).not.toHaveBeenCalled();
    expect(lastNotice()).toEqual(["error", "Enable auto-roll stopped", "user rejected"]);
    expect(html).not.toContain("Confirming…");
  });

  it("refuses to save when the market could not be re-read before the strategy write", async () => {
    m.earn.readRollState.mockResolvedValue({ strategyActive: false, delegate: true });
    m.earn.readWriterBalance.mockResolvedValue({ ...BALANCE, rollerOperator: true, orderBookOperator: true });
    m.readPayoutPrefs.mockResolvedValue({ inKind: false, toLedger: true });
    m.markets.refetch = vi.fn(async () => ({ data: undefined, isError: true }));
    render();
    await press("Enable auto-roll");
    expect(lastNotice()[2]).toBe("Live market inputs could not be refreshed before saving. Review the form and try again.");
    expect(m.earn.setStrategy).not.toHaveBeenCalled();
  });

  it("refuses to save when spot moved between the form and the write", async () => {
    m.earn.readRollState.mockResolvedValue({ strategyActive: false, delegate: true });
    m.earn.readWriterBalance.mockResolvedValue({ ...BALANCE, rollerOperator: true, orderBookOperator: true });
    m.readPayoutPrefs.mockResolvedValue({ inKind: false, toLedger: true });
    m.markets.refetch = vi.fn(async () => ({ data: [liveMarket({ spot: money("250000000") })], isError: false }));
    render();
    await press("Enable auto-roll");
    expect(lastNotice()[2]).toBe("The strategy or market changed before the strategy write. Review the form and try again.");
    expect(m.earn.setStrategy).not.toHaveBeenCalled();
  });

  it("will not overwrite a saved strategy until it is loaded into the form", async () => {
    m.queries.writerRoll = { data: { strategyActive: true, delegate: true } };
    m.queries.writerBalance = { data: { ...BALANCE, rollerOperator: true, orderBookOperator: true } };
    m.strategies = { data: { items: [savedStrategy({ ...EMPTY(), otmBps: 700, maxUnits: "250" })] } };
    render();
    expect(control("Update strategy").props.disabled).toBe(true);
    // Even a click that reached the handler is refused before any read or write.
    await press("Update strategy");
    expect(lastNotice()[2]).toBe("Load your saved strategy or choose a preset before updating it.");
    expect(m.earn.setStrategy).not.toHaveBeenCalled();
    const html = await press("Load saved strategy into form");
    expect(html).toMatch(/Sell a daily call <span[^>]*>7%<\/span> above the NVDA price/);
    expect(html).toContain("up to 2.5 shares");
    expect(control("Update strategy").props.disabled).toBe(false);
  });

  it("pauses: stops the strategy, or says it is already paused", async () => {
    m.queries.writerRoll = { data: { strategyActive: true, delegate: true } };
    m.earn.readRollPosition.mockResolvedValue({ strategyActive: true, orderId: 3n });
    render();
    await press("Pause auto-roll");
    expect(m.earn.readRollPosition).toHaveBeenCalledWith(WRITER, UNDERLYING);
    expect(m.earn.stopStrategy.mock.calls[0]![1]).toBe(UNDERLYING);
    expect(lastNotice()[2]).toBe("Auto-roll is paused. Its live ask was cancelled if one existed. Check Portfolio for separate manual orders.");
    m.earn.readRollPosition.mockResolvedValue({ strategyActive: false, orderId: 0n });
    await press("Pause auto-roll");
    expect(lastNotice()[2]).toBe("Auto-roll is already paused and has no live roller ask.");
    expect(m.earn.stopStrategy).toHaveBeenCalledTimes(1);
  });

  it("shows setup progress and the roll preview, and a single complete line once all five permissions are on chain", () => {
    m.queries.writerPayoutPrefs = { data: { inKind: false, toLedger: true } };
    m.queries["roll-preview"] = { isPending: true };
    let html = render();
    expect(html).toContain("Checking what the next roll would place…");
    expect(html).toContain("Setup, up to five transactions");
    expect(html.match(/>Done<\/span>/g)).toHaveLength(1);
    expect(html.match(/>Needed<\/span>/g)).toHaveLength(4);
    m.queries.writerRoll = { data: { strategyActive: true, delegate: true } };
    m.queries.writerBalance = { data: { ...BALANCE, rollerOperator: true, orderBookOperator: true } };
    html = render();
    expect(html).toContain("Setup complete: all five permissions are on chain.");
    expect(html).not.toMatch(/>Needed<\/span>/);
  });
});

describe("EarnMarket: USDG price inputs and smart pricing", () => {
  beforeEach(connect);

  it("converts a typed starting ask to bps on blur, and names an uncommitted, invalid or out-of-range value", () => {
    render();
    let html = set("roll-start", "3");
    expect(html).toContain("Starting ask is not committed. Move out of the field or press Enter to convert it to contract bps.");
    expect(control("Enable auto-roll").props.disabled).toBe(true);
    html = blur("roll-start");
    expect(html).toContain("Saved as 150 bps of the price after you leave the field.");
    expect(html).toMatch(/starting at <span[^>]*>3<\/span> USDG per share/);
    expect(control("Enable auto-roll").props.disabled).toBe(false);
    html = set("roll-start", "abc");
    expect(html).toContain("Starting ask must be a positive USDG price in 0.0001 steps.");
    expect(blur("roll-start")).toContain("Starting ask must be a positive USDG price in 0.0001 steps.");
    set("roll-start", "150");
    html = blur("roll-start");
    expect(html).toContain("Starting ask is outside AutoRoller&#x27;s 0.5%–10% contract range at the current spot.");
    expect(control("Enable auto-roll").props.disabled).toBe(true);
    // Enter blurs the field, which commits it; other keys do not.
    const blurred = vi.fn();
    (field("roll-start").props.onKeyDown as (e: unknown) => void)({ key: "Enter", currentTarget: { blur: blurred } });
    (field("roll-start").props.onKeyDown as (e: unknown) => void)({ key: "a", currentTarget: { blur: blurred } });
    expect(blurred).toHaveBeenCalledTimes(1);
  });

  it("offers smart pricing only while the pricer reads healthy, and turning it on exposes the band; off hides it", () => {
    m.queries.services = { data: { pricer: { healthy: false, checkedAt: NOW_S - 5 } } };
    let html = render();
    expect(checkbox().props.disabled).toBe(true);
    expect(html).toContain(SMART_PRICING_PRICER_DOWN);
    m.queries.services = HEALTHY_PRICER;
    render();
    expect(checkbox().props.disabled).toBe(false);
    html = toggleSmartPricing(true);
    expect(checkbox().props.checked).toBe(true);
    expect(hasField("roll-min")).toBe(true);
    expect(hasField("roll-maxask")).toBe(true);
    set("roll-min", "1.5");
    html = blur("roll-min");
    expect(html).toMatch(/with smart pricing between 1\.5 and [\d.]+ USDG/);
    expect(html).toContain("Saved as 75 bps after you leave the field; 0.0001 USDG tick.");
    // A pricer that stops while smart pricing is on never locks the writer out of turning it off.
    m.queries.services = { data: { pricer: { healthy: false, checkedAt: NOW_S - 5 } } };
    render();
    expect(checkbox().props.disabled).toBe(false);
    html = toggleSmartPricing(false);
    expect(hasField("roll-min")).toBe(false);
    expect(hasField("roll-maxask")).toBe(false);
    expect(html).not.toContain("with smart pricing between");
  });

  it("changes the strike distance (percent, 1%–25%), the max size and the cycle", () => {
    render();
    let html = set("roll-otm", "7");
    expect(html).toMatch(/Sell a daily call <span[^>]*>7%<\/span> above the NVDA price/);
    html = set("roll-otm", "30");
    expect(html).toContain("Strike distance must be between 1% and 25%.");
    expect(control("Enable auto-roll").props.disabled).toBe(true);
    set("roll-otm", "7");
    // A value that is not a number leaves the plan on the last valid distance; leaving the field shows that value again.
    html = set("roll-otm", "abc");
    expect(html).toMatch(/<span[^>]*>7%<\/span> above the NVDA price/);
    blur("roll-otm");
    expect(field("roll-otm").props.value).toBe("7");
    html = set("roll-max", "1.5");
    expect(html).toContain("up to 1.5 shares");
    html = set("roll-max", "0.001");
    expect(html).toContain("Choose a size in 0.01-share steps, or leave blank for all free collateral.");
    expect(control("Enable auto-roll").props.disabled).toBe(true);
    html = set("roll-max", "");
    expect(html).toContain("using all your free tokens");
    expect(field("roll-cycle").props.value).toBe("daily");
  });
});

describe("EarnMarket: presets and the proposed band", () => {
  beforeEach(connect);

  it("a preset fills the auto-roll form and picks its target on the ladder from the refreshed call list", async () => {
    m.getFair.mockResolvedValue({ fair: money("2400000") });
    render();
    const html = await press(PRESET_DAILY);
    expect(m.allCalls.refetch).toHaveBeenCalled();
    expect(lastNotice()).toEqual(["success", "Choose a preset", "Daily, +2% OTM filled the ask and auto-roll form. Smart pricing stays off until you review and select it."]);
    expect(html).toMatch(/Sell a daily call <span[^>]*>2%<\/span> above the NVDA price/);
    expect(presetButton().props["aria-pressed"]).toBe(true);
    expect(checkbox().props.checked).toBe(false);
    // The ladder row nearest the preset's target strike is the one picked for the ticket.
    const desired = presetAutoRollTarget("daily-2", 200_000_000n, 1_000_000n).strike;
    const nearest = [...LADDER].sort((a, b) => {
      const da = BigInt(a.series.strike.raw) - desired; const db = BigInt(b.series.strike.raw) - desired;
      return (da < 0n ? -da : da) < (db < 0n ? -db : db) ? -1 : 1;
    })[0]!.series.strike.formatted;
    expect(strikeRow(nearest).props["aria-pressed"]).toBe(true);
    for (const other of LADDER.map((r) => r.series.strike.formatted).filter((s) => s !== nearest))
      expect(strikeRow(other).props["aria-pressed"]).toBe(false);
    expect(ticket()).toContain(`Sell NVDA $${nearest} Call`);
  });

  it("a preset with no matching tenor says so", async () => {
    m.allCalls.refetch = vi.fn(async () => ({ data: { items: [row("301", 205, { tenor: "weekly" })] }, error: null }));
    render();
    await press(PRESET_DAILY);
    expect(lastNotice()[2]).toBe("No open series match that expiry type right now.");
    expect(presetButton().props["aria-pressed"]).toBe(false);
  });

  it("fills the proposed band from the reference's live fair, and stops treating it as current after one minute", async () => {
    m.getFair.mockResolvedValue({ fair: money("4000000") });
    m.queries.services = HEALTHY_PRICER;
    render();
    let html = await press("Fill proposed band");
    expect(lastNotice()).toEqual(["success", "Fill proposed band", "Refreshed the complete call list and filled the proposed daily band. Smart pricing remains off; the fixed ask uses the reference price, not the proposed ceiling."]);
    expect(html).toMatch(/From the daily \$\d+ call ending [\s\S]*?, estimated at \$4 USDG\. In smart mode it starts at [\d.]+ and moves between [\d.]+ and [\d.]+ USDG per share\./);
    // The review timer is armed for the candidate's remaining minute.
    const timer = (window.setTimeout as unknown as Mock).mock.calls.at(-1)!;
    expect(timer[1]).toBe(60_001);
    html = toggleSmartPricing(true);
    expect(html).not.toContain("This proposed band expired");
    expect(control("Enable auto-roll").props.disabled).toBe(false);
    // A minute later the candidate is expired: it is no longer shown as current and blocks the save.
    vi.setSystemTime((NOW_S + 61) * 1000);
    ((window.setTimeout as unknown as Mock).mock.calls.at(-1)![0] as () => void)();
    html = render();
    expect(html).toContain("This proposed band expired after one minute. Refresh it before selecting smart pricing, or edit a USDG price to discard the candidate and use a manual band.");
    expect(html).toContain("Refresh the complete call list to calculate a current candidate.");
    expect(html).not.toContain("estimated at $4 USDG");
    expect(control("Enable auto-roll").props.disabled).toBe(true);
  });

  it("says when no reference series or fair estimate is available", async () => {
    m.allCalls.refetch = vi.fn(async () => ({ data: { items: [] }, error: null }));
    render();
    await press("Fill proposed band");
    expect(lastNotice()[2]).toBe("No open daily reference series is available. Manual asks remain available.");
    m.allCalls.refetch = vi.fn(async () => ({ data: { items: [row("210", 204, { fair: null })] }, error: null }));
    m.getFair.mockRejectedValue(new Error("down"));
    await press("Fill proposed band");
    expect(lastNotice()[2]).toBe("A current contract-representable reference estimate is unavailable. Manual asks remain available.");
  });
});

describe("EarnMarket: the Portfolio edit link", () => {
  beforeEach(connect);

  it("loads the saved strategy once from ?edit=smart-pricing, opens Customize plan on the Auto-roll tab, and scrolls to it", () => {
    vi.stubGlobal("window", { location: { search: "?edit=smart-pricing&tab=swap" }, setTimeout: vi.fn(), clearTimeout: vi.fn() });
    const scrollIntoView = vi.fn();
    vi.stubGlobal("document", { getElementById: vi.fn(() => ({ scrollIntoView })) });
    m.strategies = { data: undefined, isError: false };
    expect(render()).toContain("Loading the saved strategy for this wallet and underlying…");
    expect(findAll(tree, (el) => el.props.title === "Customize plan")[0]!.props.open).toBe(true);
    expect(findAll(tree, (el) => el.props.label === "How to sell")[0]!.props.value).toBe("auto");
    m.strategies = { data: undefined, isError: true };
    expect(render()).toContain("The saved strategy could not be loaded.");
    m.strategies = { data: { items: [savedStrategy({ ...EMPTY(), otmBps: 900, maxUnits: "0" })] }, isError: false };
    render();
    const html = render();
    expect(html).toContain("Your saved strategy is loaded into this form.");
    expect(html).toMatch(/Sell a daily call <span[^>]*>9%<\/span> above the NVDA price/);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });
});

describe("EarnMarket: the put path", () => {
  beforeEach(() => {
    connect();
    const put = liveMarket({ puts: true });
    m.markets = { data: [put], isError: false, refetch: vi.fn(async () => ({ data: [put], isError: false })) };
    m.series = { data: { items: [row("401", 190, { isPut: true })] }, isError: false };
    m.queries.writerRent = { data: { rent: 0n, free: 10n ** 12n } };
  });

  it("switches to puts, sized in USDG, and lists a put ask after re-reading that the market still enables puts", async () => {
    render();
    (control("Option type to write").props.onSelect as (kind: string) => void)("put");
    let html = render();
    expect(html).toContain("Earn premium with USDG on NVDA");
    expect(html).toContain("Set your put ask");
    ticket();
    html = setTicket("ask-price", "2");
    expect(html).toMatch(/Locked while open[\s\S]*?<\/dt><dd[^>]*>1\.9 USDG<\/dd>/);
    m.earn.preflightAsk.mockResolvedValue({ longId: 401n, operator: true, exists: true, mintCutoff: EXPIRY - 1_800, now: NOW_S });
    await pressTicket("Review order");
    await pressTicket("Place ask");
    expect(m.markets.refetch).toHaveBeenCalled();
    expect(m.earn.preflightAsk.mock.calls[0]!.slice(0, 6)).toEqual([WRITER, UNDERLYING, true, 190_000_000n, EXPIRY, 1n]);
    expect(m.tx.place.mock.calls[0]!.slice(1, 5)).toEqual([401n, 2, 2_000_000n, 1n]);
    expect(m.earn.createSeries).not.toHaveBeenCalled();
  });

  it("stops a put deposit when the refreshed market no longer enables puts", async () => {
    render();
    (control("Option type to write").props.onSelect as (kind: string) => void)("put");
    render();
    m.markets.refetch = vi.fn(async () => ({ data: [liveMarket({ puts: false })], isError: false }));
    set("writer-deposit", "100");
    expect(control("Deposit").props.disabled).toBe(false);
    await press("Deposit");
    expect(lastNotice()[2]).toBe("Put writing is unavailable for this market. Your free USDG can still be withdrawn.");
    expect(m.tx.approveExact).not.toHaveBeenCalled();
    expect(m.tx.deposit).not.toHaveBeenCalled();
  });
});
