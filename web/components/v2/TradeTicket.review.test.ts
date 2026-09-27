/**
 * The Review step locks what the buyer reviewed. The ticket derives buy or bid from the live book every
 * render, and the book refetches every 15 s, so without a lock a refresh could turn a reviewed "Buy now" into a
 * resting bid (or change what a buy sends) with no new review. These tests drive the ticket through Review, change
 * the live book or the ticket state underneath it, and assert that signing is blocked and that nothing is sent.
 *
 * How, without a DOM (the harness of the removed TradeTicket.render.test.ts): `react`'s useState/useMemo/
 * useEffect are swapped for in-memory slots while the ticket function runs, the returned element tree is searched for
 * a control and its handler is called directly, and the next render is read as markup (the harness is off then, so
 * child components use real React). Every chain boundary is a mock, so a test says what the chain answers and
 * asserts what the ticket sends. TradeTicket.render.test.ts belongs to this file is separate on purpose.
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
  invalidate: vi.fn(),
  notice: vi.fn(),
  receipt: vi.fn(() => false),
  readSeriesOnChain: vi.fn(), readOrderPreflight: vi.fn(), assertSeriesTermsMatch: vi.fn(), staleSelectedOrders: vi.fn(() => []),
  approveExact: vi.fn(), place: vi.fn(), recheckTakeQuote: vi.fn(), restingValidUntil: vi.fn(), take: vi.fn(),
  assertTradingOpen: vi.fn(),
  client: { readContract: vi.fn(), getGasPrice: vi.fn(), getBlock: vi.fn(), estimateContractGas: vi.fn() },
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (_options: QueryOptions) => ({ data: undefined }),
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
  ...(await importOriginal<typeof import("@/lib/v2/chainClock")>()), useChainClockOffset: () => 0,
}));
vi.mock("@/lib/v2/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/config")>()), v2ConfigWarnings: () => [],
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

import { BOOK_CHANGED_LINE, limitText, reviewDrift, reviewNotesFor, TradeTicket, type ReviewedOrder } from "./TradeTicket";

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
const ASK = BigInt(book.asks[0]!.price.raw); // 0.3989 USDG: the fixture's one ask level, 120 units
const SIZE = 10n; // the ticket's default 0.10 share

/** The fixture book with its one ask level cut to `units`: below SIZE the live mode becomes a bid. */
function bookWithAskUnits(units: bigint): BookResponse {
  const level = book.asks[0]!;
  const orders = level.orders.map((order) => ({ ...order, units: units.toString(), onChainRemainingUnits: units.toString() }));
  return { ...book, asks: [{ ...level, units: units.toString(), orders }] };
}

type Props = ComponentProps<typeof TradeTicket>;
let props: Props;
let tree: ReactNode = null;
function run(): string {
  h.active = true; h.cursor = 0; h.effects = [];
  try { tree = TradeTicket(props); } finally { h.active = false; }
  return renderToStaticMarkup(createElement("div", null, tree));
}
/** First render plus the mount effects (the clock tick), then the settled render. */
function mount(over: Partial<Props> = {}): string {
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
const click = (label: string) => {
  (findWhere((p) => typeof p.onClick === "function" && textOf(p.children) === label).props.onClick as () => void)();
  return run();
};
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
/** The one button that calls submit(): its label, disabled flag, and a direct call of its handler (as a stale click would). */
const signButton = () => findWhere((p) => p.disabled !== undefined && ["Buy now", "Place bid", "Confirming…"].includes(textOf(p.children)));
async function pressSign(): Promise<string> {
  (signButton().props.onClick as () => void)();
  await flush();
  return run();
}
const nothingSent = () => {
  expect(m.take).not.toHaveBeenCalled();
  expect(m.place).not.toHaveBeenCalled();
  expect(m.approveExact).not.toHaveBeenCalled();
  expect(m.assertTradingOpen).not.toHaveBeenCalled();
};
/** The state slot holding `value` (the ticket's share or limit input), so a test can change it under the review. */
function slotOf(value: string): number {
  const at = h.slots.findIndex((slot) => slot === value);
  if (at === -1) throw new Error(`no state slot holds ${value}`);
  return at;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_S * 1000);
  vi.stubGlobal("window", { setInterval: vi.fn(() => 7), clearInterval: vi.fn() });
  h.slots = []; h.effects = [];
  m.address = ACCOUNT; m.wallet = { id: "wallet" }; m.config = config;
  for (const fn of [m.invalidate, m.notice, m.receipt, m.readSeriesOnChain, m.readOrderPreflight, m.assertSeriesTermsMatch,
    m.staleSelectedOrders, m.approveExact, m.place, m.recheckTakeQuote, m.restingValidUntil, m.take, m.assertTradingOpen,
    ...Object.values(m.client)]) fn.mockReset();
  m.receipt.mockReturnValue(false);
  m.staleSelectedOrders.mockReturnValue([]);
  m.readSeriesOnChain.mockResolvedValue(CHAIN_SERIES);
  m.readOrderPreflight.mockResolvedValue([]);
  m.recheckTakeQuote.mockImplementation(async (_c: unknown, request: object) => ({ ...request, deadline: 1, maxTotalFee: 1n }));
  m.take.mockImplementation(async (_c: unknown, params: { units: bigint }) => ({ unitsFilled: params.units }));
  m.restingValidUntil.mockResolvedValue(detail.series.expiry - 60);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("(a): a book refresh that turns the reviewed buy into a bid blocks signing", () => {
  it("disables the signing button, says the book changed, and sends no take, approve or place", async () => {
    mount();
    let html = click("Review order");
    expect(html).toContain("Review order");
    expect(signButton().props.disabled).toBe(false);
    expect(textOf(signButton().props.children)).toBe("Buy now");
    expect(html).not.toContain(BOOK_CHANGED_LINE);

    // The 15 s refetch lands: only 5 units remain at the limit, so the live ticket would now place a bid.
    props = { ...props, book: bookWithAskUnits(5n) };
    html = run();
    expect(signButton().props.disabled).toBe(true);
    expect(textOf(signButton().props.children)).toBe("Buy now"); // the reviewed order, never the live one
    expect(html).toContain(BOOK_CHANGED_LINE);
    expect(html).toContain("Edit order");

    await pressSign(); // a click that reached the handler anyway: submit() refuses on its own
    nothingSent();
  });

  it("the same when a reviewed bid would now buy everything at once", async () => {
    mount({ book: bookWithAskUnits(5n) });
    let html = click("Review order");
    expect(textOf(signButton().props.children)).toBe("Place bid");
    expect(signButton().props.disabled).toBe(false);
    props = { ...props, book };
    html = run();
    expect(signButton().props.disabled).toBe(true);
    expect(textOf(signButton().props.children)).toBe("Place bid");
    expect(html).toContain(BOOK_CHANGED_LINE);
    await pressSign();
    nothingSent();
  });

  it("Edit order clears the reviewed order; reviewing again records the live one", () => {
    mount();
    click("Review order");
    props = { ...props, book: bookWithAskUnits(5n) };
    run();
    expect(signButton().props.disabled).toBe(true);
    click("Edit order");
    const html = click("Review order");
    expect(html).not.toContain(BOOK_CHANGED_LINE);
    expect(textOf(signButton().props.children)).toBe("Place bid");
    expect(signButton().props.disabled).toBe(false);
  });
});

describe("(b): a size or limit change under the review blocks signing", () => {
  it("a different size", async () => {
    mount();
    click("Review order");
    h.slots[slotOf("0.10")] = "0.20";
    const html = run();
    expect(signButton().props.disabled).toBe(true);
    expect(html).toContain(BOOK_CHANGED_LINE);
    await pressSign();
    nothingSent();
  });

  it("a different limit", async () => {
    mount();
    click("Review order"); // Review pins the limit input to the value shown
    h.slots[slotOf("0.3989")] = "0.399";
    const html = run();
    expect(signButton().props.disabled).toBe(true);
    expect(html).toContain(BOOK_CHANGED_LINE);
    await pressSign();
    nothingSent();
  });

  it("reviewDrift names every field that changes what is sent, and nothing else", () => {
    const reviewed: ReviewedOrder = { mode: "buy", units: 10n, limitPrice: ASK, allowPartial: false };
    expect(reviewDrift(reviewed, { ...reviewed })).toBeNull();
    for (const live of [null, { ...reviewed, mode: "bid" as const }, { ...reviewed, units: 11n },
      { ...reviewed, limitPrice: ASK + 100n }, { ...reviewed, allowPartial: true }]) {
      expect(reviewDrift(reviewed, live), JSON.stringify(live, (_k, v) => typeof v === "bigint" ? `${v}` : v)).toBe(BOOK_CHANGED_LINE);
    }
  });
});

describe("(c): with no change, signing sends the reviewed order", () => {
  it("a reviewed buy sends one take at the reviewed size and limit, all or nothing, and no place", async () => {
    mount();
    click("Review order");
    run(); // a refresh with the same book changes nothing
    expect(signButton().props.disabled).toBe(false);
    await pressSign();
    expect(m.assertTradingOpen).toHaveBeenCalledTimes(1);
    expect(m.take).toHaveBeenCalledTimes(1);
    expect(m.take.mock.calls[0]![1]).toMatchObject({ longId: LONG_ID, buying: true, units: SIZE, minUnits: SIZE, limitPrice: ASK });
    expect(m.place).not.toHaveBeenCalled();
  });

  it("a reviewed bid buys what crosses and rests the rest at the reviewed limit", async () => {
    mount({ book: bookWithAskUnits(5n) });
    click("Review order");
    await pressSign();
    expect(m.take).toHaveBeenCalledTimes(1);
    expect(m.take.mock.calls[0]![1]).toMatchObject({ units: 5n, minUnits: 5n, limitPrice: ASK });
    expect(m.place).toHaveBeenCalledTimes(1);
    expect(m.place.mock.calls[0]!.slice(1)).toEqual([LONG_ID, 0, ASK, SIZE - 5n, detail.series.expiry - 60]);
  });
});

describe("(d): the review notes describe what will be sent", () => {
  it("says All or nothing only when the take sends minUnits = size", async () => {
    mount();
    let html = click("Review order");
    expect(html).toContain("All or nothing.");
    click("Edit order");
    (findWhere((p) => p.type === "checkbox").props.onChange as (e: unknown) => void)({ target: { checked: true } });
    run();
    html = click("Review order");
    expect(html).not.toContain("All or nothing.");
    expect(html).toContain("Partial fills are on");
    await pressSign();
    expect(m.take.mock.calls[0]![1]).toMatchObject({ units: SIZE, minUnits: 1n });
  });

  it("reviewNotesFor: buy all-or-nothing, buy with partial fills, and the bid notes", () => {
    expect(reviewNotesFor({ mode: "buy", allowPartial: false })[0]).toMatch(/All or nothing\.$/);
    expect(reviewNotesFor({ mode: "buy", allowPartial: true }).join(" ")).not.toContain("All or nothing");
    expect(reviewNotesFor({ mode: "bid", allowPartial: false })[0]).toContain("The rest waits as a bid for 24 hours.");
  });
});

describe("(e): prices at their real 0.0001 precision", () => {
  it("the review sentence shows the 0.3989 limit, not $0.40", () => {
    mount();
    const html = click("Review order");
    expect(html).toContain("at $0.3989 per share or less.");
    expect(html).not.toContain("at $0.40 per share");
  });

  it("the Bid, Mark and Ask chips show the on-tick value each one sets", () => {
    const html = mount();
    expect(html).toContain("$0.3989"); // Ask 0.3989
    expect(html).toContain("$0.3397"); // Bid 0.3397
    expect(html).toContain("$0.3692"); // Mark 0.369263, set as the 0.3692 tick
    (findWhere((p) => typeof p.onClick === "function" && textOf(p.children).startsWith("Mark")).props.onClick as () => void)();
    run();
    expect(h.slots).toContain("0.3692");
  });

  it("limitText keeps two decimals at least and every tick digit", () => {
    expect(limitText(398_900n)).toBe("$0.3989");
    expect(limitText(400_000n)).toBe("$0.40");
    expect(limitText(1_234_500n)).toBe("$1.2345");
  });
});
