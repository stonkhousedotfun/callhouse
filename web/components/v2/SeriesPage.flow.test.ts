/**
 * SeriesRail and SeriesDetails (the market page's per-series halves) with the API fixtures: the ticket's loading /
 * unavailable / stale states, its card target (from the card, else from the ladder default), the ?buy=1 focus-and-scroll
 * effect, the on-chain book rebuild (its query guard, fetcher, freshness window and the "rebuilt on chain" label),
 * and the activity block's book, trades and notices. React's useState/useEffect/useRef are a slot stand-in while the
 * components are called as functions (no DOM renderer here); the trees are then server-rendered with the real hooks.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { useQuery } from "@tanstack/react-query";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { getAddress } from "viem";
import { useAccount } from "wagmi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TradeTicket } from "@/components/v2/TradeTicket";
import type { BookResponse, Card, ConfigResponse, Market, SeriesDetailResponse, Trade } from "@/lib/v2/api-types";
import { bookFromChain } from "@/lib/v2/bookFromChain";
import { assertSeriesTermsMatch, readMarketSpotOnChain, readSeriesOnChain } from "@/lib/v2/chainReads";
import { V2_DEPLOYMENT } from "@/lib/v2/config";
import { useBook, useCards, useConfig, useMarkets, useSeries, useTrades } from "@/lib/v2/hooks";
import { cardTarget } from "@/lib/v2/payoff";
import { v2Markets } from "@/lib/markets";
import { SeriesDetails, SeriesRail, useSeriesRef } from "./SeriesPage";

const H = vi.hoisted(() => ({ on: false, slots: [] as unknown[], i: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  const slot = (init: () => unknown) => {
    const k = H.i++;
    if (!(k in H.slots)) H.slots[k] = init();
    return k;
  };
  return {
    ...real,
    useState: (init: unknown) => {
      if (!H.on) return real.useState(init);
      const k = slot(() => init);
      return [H.slots[k], (v: unknown) => { H.slots[k] = v; }];
    },
    useRef: (init: unknown) => (H.on ? H.slots[slot(() => ({ current: init }))] : real.useRef(init)),
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => (H.on ? void H.effects.push(fn) : real.useEffect(fn, deps)),
  };
});
vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn() }));
vi.mock("wagmi", () => ({ useAccount: vi.fn() }));
vi.mock("@/components/v2/TradeTicket", () => ({ TradeTicket: vi.fn(() => null) }));
vi.mock("@/lib/v2/hooks", () => ({
  useBook: vi.fn(), useCards: vi.fn(), useConfig: vi.fn(), useMarkets: vi.fn(), useSeries: vi.fn(), useTrades: vi.fn(),
}));
vi.mock("@/lib/v2/chainReads", () => ({ assertSeriesTermsMatch: vi.fn(), readMarketSpotOnChain: vi.fn(), readSeriesOnChain: vi.fn() }));
vi.mock("@/lib/v2/bookFromChain", async (orig) => ({
  ...(await orig<typeof import("@/lib/v2/bookFromChain")>()),
  bookFromChain: vi.fn(),
}));

const fixtures = fileURLToPath(new URL("../../../ops/fixtures/api/v2/", import.meta.url));
const read = <T>(path: string): T => JSON.parse(readFileSync(`${fixtures}/${path}`, "utf8")) as T;
const LONG = "103958645695364239832519143371390703150538693767596812376310949450919320284464";
const detail = read<SeriesDetailResponse>(`series/${LONG}.json`); // NVDA $224 daily call
const config = read<ConfigResponse>("config.json");
const markets = read<Market[]>("markets.json");
const ME = "0xd3b47D8a6B8e3fc6160Cd02634CF7Ae74aDeB66f";
const NOW_MS = 1_789_592_400_000;

const level = (raw: string, units: string, maker: string) => ({
  price: { raw, decimals: 6, formatted: String(Number(raw) / 1e6) }, units,
  orders: [{ orderId: "1", maker, units, onChainRemainingUnits: units, makerFreeUnits: null, makerFreeCollateral: null, kind: "Ask", validUntil: 0 }],
});
const book: BookResponse = { bids: [level("339700", "100", "0x0000000000000000000000000000000000000009")],
  asks: [level("398900", "120", ME)], updatedBlock: "64418153", snapshotTimestamp: 1_789_592_400 } as unknown as BookResponse;
const trade = (id: string, ts: number, priceRaw = "400000"): Trade => ({ id, ts, price: { raw: priceRaw, decimals: 6, formatted: String(Number(priceRaw) / 1e6) }, units: "250",
  premium: { raw: "1000000", decimals: 6, formatted: "1" }, takerIsBuyer: true, primary: true,
  taker: "0x0000000000000000000000000000000000000001", maker: "0x0000000000000000000000000000000000000002", tx: "0x" });

const q = (data: unknown, over: Record<string, unknown> = {}) => ({ data, isError: false, isPending: false, isFetching: false,
  error: null, errorUpdatedAt: 0, dataUpdatedAt: 0, refetch: vi.fn(), ...over });
type QueryOpts = { queryKey: unknown[]; enabled: boolean; queryFn: () => Promise<unknown> };
let chainSpotQ: ReturnType<typeof q>;
let fallbackQ: ReturnType<typeof q>;
const opts = (name: string) => vi.mocked(useQuery).mock.calls.map((c) => c[0] as unknown as QueryOpts).filter((o) => o.queryKey[1] === name).at(-1)!;

type Props = Record<string, unknown> & { children?: ReactNode };
type El = ReactElement<Props>;
function all(node: unknown, pred: (e: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const n of node) all(n, pred, out); return out; }
  if (!isValidElement(node)) return out;
  if (pred(node as El)) out.push(node as El);
  all((node as El).props.children, pred, out);
  return out;
}
function call<P>(component: (p: P) => unknown, props: P) {
  H.on = true;
  H.i = 0;
  H.effects = [];
  const tree = component(props) as ReactNode;
  H.on = false;
  return { tree, html: tree ? renderToStaticMarkup(tree as ReactElement) : "" };
}
/** Render, run the clock effect (effect 0), render again with the clock set. */
function mounted<P>(component: (p: P) => unknown, props: P) {
  call(component, props);
  H.effects[0]!();
  return call(component, props);
}
const ticketProps = (tree: ReactNode) => all(tree, (e) => e.type === TradeTicket)[0]?.props as Record<string, unknown> | undefined;

let doc: { getElementById: ReturnType<typeof vi.fn> };
let reducedMotion: boolean;

beforeEach(() => {
  vi.clearAllMocks();
  H.slots = [];
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
  reducedMotion = false;
  doc = { getElementById: vi.fn(() => null) };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
    matchMedia: () => ({ matches: reducedMotion }) });
  chainSpotQ = q(undefined);
  fallbackQ = q(undefined);
  vi.mocked(useQuery).mockImplementation(((o: QueryOpts) => (o.queryKey[1] === "chainSpot" ? chainSpotQ : fallbackQ)) as never);
  vi.mocked(useAccount).mockReturnValue({ address: undefined } as never);
  vi.mocked(useSeries).mockReturnValue(q(detail) as never);
  vi.mocked(useBook).mockReturnValue(q(book) as never);
  vi.mocked(useTrades).mockReturnValue(q({ items: [], nextCursor: null }) as never);
  vi.mocked(useConfig).mockReturnValue(q(config) as never);
  vi.mocked(useMarkets).mockReturnValue(q(markets) as never);
  vi.mocked(useCards).mockReturnValue(q({ items: [], nextCursor: null }) as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("SeriesRail", () => {
  it("no card: the target is the daily ladder's default above the strike, on the registry's tick", () => {
    const { tree } = mounted(SeriesRail, { ticker: "NVDA", longId: LONG });
    const nvda = v2Markets().find((m) => m.ticker === "NVDA")!;
    const expected = cardTarget(224_000_000n, config.ladder.daily.cardTargetBps, nvda.v2.strikeTick, false);
    expect(ticketProps(tree)).toMatchObject({ ticker: "NVDA", target: expected, tradingPaused: false, bookDegraded: false });
    expect(ticketProps(tree)!.book).toBe(book);
    expect(vi.mocked(useCards)).toHaveBeenCalledWith({ ticker: "NVDA", limit: 200 });
  });

  it("a card for the series supplies its own target", () => {
    const card = { series: { longId: LONG }, target: { raw: "250000000", decimals: 6, formatted: "250" } } as unknown as Card;
    vi.mocked(useCards).mockReturnValue(q({ items: [card], nextCursor: null }) as never);
    expect(ticketProps(mounted(SeriesRail, { ticker: "NVDA", longId: LONG }).tree)!.target).toBe(250_000_000n);
  });

  it("no card and no config: a loading-ticket panel instead of a ticket", () => {
    vi.mocked(useConfig).mockReturnValue(q(undefined) as never);
    const { tree, html } = mounted(SeriesRail, { ticker: "NVDA", longId: LONG });
    expect(ticketProps(tree)).toBeUndefined();
    expect(html).toContain("Loading the ticket…");
  });

  it("the market's trading brake reaches the ticket", () => {
    vi.mocked(useMarkets).mockReturnValue(q(markets.map((m) => ({ ...m, tradingPaused: true }))) as never);
    expect(ticketProps(mounted(SeriesRail, { ticker: "NVDA", longId: LONG }).tree)!.tradingPaused).toBe(true);
  });

  it("series loading: a loading panel; series failed with nothing: an unavailable notice whose Try again refetches", () => {
    vi.mocked(useSeries).mockReturnValue(q(undefined, { isPending: true }) as never);
    expect(call(SeriesRail, { ticker: "NVDA", longId: LONG }).html).toContain("Loading option terms…");
    const failed = q(undefined, { isError: true });
    vi.mocked(useSeries).mockReturnValue(failed as never);
    const { tree, html } = call(SeriesRail, { ticker: "NVDA", longId: LONG });
    expect(html).toContain("Option details are unavailable.");
    const retry = all(tree, (e) => typeof e.props.onClick === "function")[0]!;
    (retry.props.onClick as () => void)();
    expect(failed.refetch).toHaveBeenCalled();
  });

  it("series refresh failed with cached terms: a may-be-stale warning above the ticket", () => {
    vi.mocked(useSeries).mockReturnValue(q(detail, { isError: true }) as never);
    const { tree, html } = mounted(SeriesRail, { ticker: "NVDA", longId: LONG });
    expect(html).toContain("Option details may be out of date.");
    expect(ticketProps(tree)).toBeDefined();
  });

  it("the ticket's refresh refetches the book, the chain rebuild, the series and the trades", () => {
    const refetches = { book: vi.fn(), series: vi.fn(), trades: vi.fn() };
    vi.mocked(useBook).mockReturnValue(q(book, { refetch: refetches.book }) as never);
    vi.mocked(useSeries).mockReturnValue(q(detail, { refetch: refetches.series }) as never);
    vi.mocked(useTrades).mockReturnValue(q({ items: [] }, { refetch: refetches.trades }) as never);
    (ticketProps(mounted(SeriesRail, { ticker: "NVDA", longId: LONG }).tree)!.onRefresh as () => void)();
    expect(refetches.book).toHaveBeenCalled();
    expect(refetches.series).toHaveBeenCalled();
    expect(refetches.trades).toHaveBeenCalled();
    expect(fallbackQ.refetch).toHaveBeenCalled();
  });

  describe("?buy=1 focus", () => {
    function focusEffect(props: Partial<Parameters<typeof SeriesRail>[0]>) {
      mounted(SeriesRail, { ticker: "NVDA", longId: LONG, ...props });
      return H.effects[1]!;
    }

    it("focuses the budget input without scrolling, then scrolls the ticket smoothly; only once per route", () => {
      const input = { focus: vi.fn() };
      const ticket = { scrollIntoView: vi.fn() };
      doc.getElementById.mockImplementation((id: string) => (id === "ticket-budget" ? input : id === "ticket" ? ticket : null));
      const effect = focusEffect({ openTicket: true });
      effect();
      expect(input.focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(ticket.scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
      effect();
      expect(input.focus).toHaveBeenCalledTimes(1);
    });

    it("falls back to the shares input, and respects reduced motion", () => {
      reducedMotion = true;
      const input = { focus: vi.fn() };
      const ticket = { scrollIntoView: vi.fn() };
      doc.getElementById.mockImplementation((id: string) => (id === "ticket-shares" ? input : id === "ticket" ? ticket : null));
      focusEffect({ openTicket: true, initialShares: "2" })();
      expect(input.focus).toHaveBeenCalled();
      expect(ticket.scrollIntoView).toHaveBeenCalledWith({ behavior: "auto", block: "start" });
    });

    it("no input mounted yet: nothing, and it tries again next time", () => {
      const effect = focusEffect({ openTicket: true });
      effect();
      const input = { focus: vi.fn() };
      doc.getElementById.mockImplementation((id: string) => (id === "ticket-budget" ? input : null));
      effect();
      expect(input.focus).toHaveBeenCalledTimes(1);
    });

    it("no target yet, or the ticket closed: never focuses", () => {
      const input = { focus: vi.fn() };
      doc.getElementById.mockReturnValue(input);
      vi.mocked(useConfig).mockReturnValue(q(undefined) as never);
      focusEffect({ openTicket: true })();
      vi.mocked(useConfig).mockReturnValue(q(config) as never);
      focusEffect({ openTicket: false })();
      expect(input.focus).not.toHaveBeenCalled();
    });
  });
});

describe("the on-chain book rebuild", () => {
  it("is only enabled when the indexer's book failed and the series is known", () => {
    mounted(SeriesRail, { ticker: "NVDA", longId: LONG });
    expect(opts("chainBook").enabled).toBe(false);
    expect(opts("chainSpot").enabled, "market list fine: no chain spot read").toBe(false);
    vi.mocked(useBook).mockReturnValue(q(undefined, { isError: true }) as never);
    vi.mocked(useMarkets).mockReturnValue(q(undefined, { isError: true }) as never);
    mounted(SeriesRail, { ticker: "NVDA", longId: LONG });
    const contractsPresent = Boolean(V2_DEPLOYMENT.contracts.orderBook && V2_DEPLOYMENT.contracts.clearinghouse);
    expect(opts("chainBook").enabled).toBe(contractsPresent);
    expect(opts("chainSpot").enabled).toBe(Boolean(V2_DEPLOYMENT.contracts.settlementOracle));
    expect(opts("chainBook").queryKey).toEqual(["v2", "chainBook", LONG]);
  });

  it("the chain spot fetcher reads this market", async () => {
    mounted(SeriesRail, { ticker: "NVDA", longId: LONG });
    vi.mocked(readMarketSpotOnChain).mockResolvedValue(215_000_000n);
    await expect(opts("chainSpot").queryFn()).resolves.toBe(215_000_000n);
    expect(readMarketSpotOnChain).toHaveBeenCalledWith("NVDA");
  });

  it("the fetcher checks the terms, then rebuilds a call's book on its underlying; a put's on USDG", async () => {
    vi.mocked(readSeriesOnChain).mockResolvedValue({ exists: true, series: { s: 1 }, collateral: 7n, cutoff: 99n } as never);
    vi.mocked(bookFromChain).mockResolvedValue(book as never);
    mounted(SeriesRail, { ticker: "NVDA", longId: LONG });
    await expect(opts("chainBook").queryFn()).resolves.toBe(book);
    expect(readSeriesOnChain).toHaveBeenCalledWith(BigInt(LONG));
    expect(assertSeriesTermsMatch).toHaveBeenCalledWith(detail.series, { s: 1 }, "NVDA", 25);
    expect(bookFromChain).toHaveBeenLastCalledWith(BigInt(LONG), getAddress(detail.series.underlying), 7n, 99);

    vi.mocked(useSeries).mockReturnValue(q({ ...detail, series: { ...detail.series, isPut: true } }) as never);
    mounted(SeriesRail, { ticker: "NVDA", longId: LONG });
    await opts("chainBook").queryFn();
    expect(bookFromChain).toHaveBeenLastCalledWith(BigInt(LONG), getAddress(config.usdg.address), 7n, 99);
  });

  it("a series the chain does not have is an error, and terms that disagree stop the rebuild", async () => {
    vi.mocked(readSeriesOnChain).mockResolvedValue({ exists: false } as never);
    mounted(SeriesRail, { ticker: "NVDA", longId: LONG });
    await expect(opts("chainBook").queryFn()).rejects.toThrow("Series does not exist on chain");
    vi.mocked(readSeriesOnChain).mockResolvedValue({ exists: true, series: {}, collateral: 1n, cutoff: 1n } as never);
    vi.mocked(assertSeriesTermsMatch).mockImplementationOnce(() => { throw new Error("terms differ"); });
    await expect(opts("chainBook").queryFn()).rejects.toThrow("terms differ");
    expect(bookFromChain).not.toHaveBeenCalled();
  });

  it("a rebuilt book is shown (and labelled) only while fresh: newer than the failure and under 30 s old", () => {
    vi.mocked(useBook).mockReturnValue(q(undefined, { isError: true, errorUpdatedAt: NOW_MS - 5_000 }) as never);
    fallbackQ = q(book, { dataUpdatedAt: NOW_MS - 1_000 });
    const fresh = mounted(SeriesDetails, { ticker: "NVDA", longId: LONG });
    expect(fresh.html).toContain("Block 64418153 · rebuilt on chain");
    H.slots = [];
    fallbackQ = q(book, { dataUpdatedAt: NOW_MS - 31_000 });
    expect(mounted(SeriesDetails, { ticker: "NVDA", longId: LONG }).html).not.toContain("rebuilt on chain");
    H.slots = [];
    fallbackQ = q(book, { dataUpdatedAt: NOW_MS - 6_000 });
    expect(mounted(SeriesDetails, { ticker: "NVDA", longId: LONG }).html, "older than the failure").not.toContain("rebuilt on chain");
    H.slots = [];
    fallbackQ = q(book, { dataUpdatedAt: NOW_MS - 1_000 });
    expect(call(SeriesDetails, { ticker: "NVDA", longId: LONG }).html, "not before the clock is read").not.toContain("rebuilt on chain");
  });
});

describe("SeriesDetails", () => {
  it("summary: the best ask and its size; the book marks the reader's own order", () => {
    vi.mocked(useAccount).mockReturnValue({ address: ME.toLowerCase() } as never);
    const { html } = mounted(SeriesDetails, { ticker: "NVDA", longId: LONG });
    expect(detail.series).toMatchObject({ isPut: false, strike: { formatted: "224" } });
    expect(html).toContain("Book, trades and terms · $224 Call");
    // The fixture book's best ask is 0.3989 for 120 units (1.2 sh). It is shown at its real 0.0001 precision, not
    // rounded to the cent, so no ask reads cheaper (or dearer) than it is.
    expect(html).toContain("Best ask $0.3989 · 1.2 sh");
    expect(html).toContain("Block 64418153<");
    // The reader's order is the ASK (maker ME); the bid is someone else's. Exactly the ask row is tinted and labelled.
    expect(html.match(/Your order/g)).toHaveLength(1);
    const table = (name: string) => html.slice(html.indexOf(`aria-label="${name} by price"`), html.indexOf("</table>", html.indexOf(`aria-label="${name} by price"`)));
    expect(table("Asks")).toMatch(/<tr class="bg-accent-soft"><td[^>]*>\$0\.3989<\/td><td[^>]*>1\.2 sh<\/td>/);
    expect(table("Asks")).toContain("Your order");
    expect(table("Bids")).toMatch(/<tr><td[^>]*>\$0\.3397<\/td><td[^>]*>1 sh<\/td>/);
    expect(table("Bids")).not.toContain("bg-accent-soft");
    expect(html).toContain("No trades yet.");
  });

  it("an empty book: 'No ask', and each side says it is empty", () => {
    vi.mocked(useBook).mockReturnValue(q({ ...book, bids: [], asks: [] }) as never);
    const { html } = mounted(SeriesDetails, { ticker: "NVDA", longId: LONG });
    expect(html).toContain("No ask");
    expect(html).toContain("No bids yet.");
    expect(html).toContain("No asks yet.");
  });

  // ('s NEEDS-ROW): the book trades in 0.0001 USDG steps. Two asks that differ only past the cents
  // both read $0.40 when rounded, and a buyer comparing them cannot tell them apart.
  it("two asks that differ only past the cents (0.3989 vs 0.3997) read differently, in the book and the summary", () => {
    vi.mocked(useBook).mockReturnValue(q({ ...book, asks: [level("398900", "120", "0x0000000000000000000000000000000000000007"),
      level("399700", "50", "0x0000000000000000000000000000000000000008")] }) as never);
    const { html } = mounted(SeriesDetails, { ticker: "NVDA", longId: LONG });
    const asks = html.slice(html.indexOf('aria-label="Asks by price"'), html.indexOf("</table>", html.indexOf('aria-label="Asks by price"')));
    const prices = [...asks.matchAll(/<tr[^>]*><td[^>]*>([^<]+)<\/td>/g)].map((m) => m[1]);
    expect(prices).toEqual(["$0.3989", "$0.3997"]);
    expect(new Set(prices).size, "two different asks never print the same").toBe(2);
    expect(html).toContain("Best ask $0.3989 · 1.2 sh");
    expect(html).not.toContain("$0.40");
  });

  it("book loading, then unavailable with the rebuild's error or its progress", () => {
    vi.mocked(useBook).mockReturnValue(q(undefined, { isPending: true }) as never);
    const loading = mounted(SeriesDetails, { ticker: "NVDA", longId: LONG }).html;
    expect(loading).toContain(">Loading…<");
    expect(loading).toContain("Loading order book…");

    vi.mocked(useBook).mockReturnValue(q(undefined, { isError: true }) as never);
    fallbackQ = q(undefined, { isError: true, error: new Error("RPC down") });
    const failed = mounted(SeriesDetails, { ticker: "NVDA", longId: LONG }).html;
    expect(failed).toContain("Book unavailable");
    expect(failed).toContain("Order book unavailable. Try refreshing.");
    expect(failed).toContain("Order book unavailable. RPC down");

    fallbackQ = q(undefined, { isPending: true });
    const rebuilding = mounted(SeriesDetails, { ticker: "NVDA", longId: LONG }).html;
    const canRebuild = Boolean(V2_DEPLOYMENT.contracts.orderBook && V2_DEPLOYMENT.contracts.clearinghouse);
    expect(rebuilding.includes("Loading it from the chain."), "says it is rebuilding only when it can").toBe(canRebuild);
  });

  it("trades: a row per trade with time, price and size; loading and failure say so", () => {
    vi.mocked(useTrades).mockReturnValue(q({ items: [trade("t1", 1_789_590_000, "399700"), trade("t2", 1_789_591_000)] }) as never);
    const html = mounted(SeriesDetails, { ticker: "NVDA", longId: LONG }).html;
    expect(html).toContain("Recent option trades");
    // 0.3997 and 0.40 a share, each for 250 units (2.5 sh), at their real 0.0001 precision.
    expect(html.match(/<td class="num">\$0\.3997<\/td><td class="num">2\.5 sh<\/td>/g)).toHaveLength(1);
    expect(html.match(/<td class="num">\$0\.40<\/td><td class="num">2\.5 sh<\/td>/g)).toHaveLength(1);
    for (const ts of [1_789_590_000, 1_789_591_000]) expect(html, "each row has its trade's time").toMatch(new RegExp(`<time datetime="${new Date(ts * 1000).toISOString()}"`, "i"));
    vi.mocked(useTrades).mockReturnValue(q(undefined, { isPending: true }) as never);
    expect(mounted(SeriesDetails, { ticker: "NVDA", longId: LONG }).html).toContain("Loading trades…");
    vi.mocked(useTrades).mockReturnValue(q(undefined, { isError: true }) as never);
    expect(mounted(SeriesDetails, { ticker: "NVDA", longId: LONG }).html).toContain("Trades are unavailable right now.");
  });

  it("no series detail: renders nothing", () => {
    vi.mocked(useSeries).mockReturnValue(q(undefined) as never);
    expect(call(SeriesDetails, { ticker: "NVDA", longId: LONG }).tree).toBeNull();
  });

  it("the clock ticks each second and stops on unmount", () => {
    call(SeriesDetails, { ticker: "NVDA", longId: LONG });
    const cleanup = H.effects[0]!() as () => void;
    expect(H.slots[0]).toBe(NOW_MS);
    vi.advanceTimersByTime(2_000);
    expect(H.slots[0]).toBe(NOW_MS + 2_000);
    cleanup();
    vi.advanceTimersByTime(2_000);
    expect(H.slots[0]).toBe(NOW_MS + 2_000);
  });
});

describe("useSeriesRef", () => {
  it("the route series' ref, or null without a route or before it loads", () => {
    expect(useSeriesRef(LONG)).toBe(detail.series);
    expect(useSeriesRef(undefined)).toBeNull();
    expect(vi.mocked(useSeries)).toHaveBeenLastCalledWith("");
    vi.mocked(useSeries).mockReturnValue(q(undefined) as never);
    expect(useSeriesRef(LONG)).toBeNull();
  });
});
