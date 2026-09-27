/**
 * The OrderBook brake's line on the market pages. The page renders
 * {TradingPausedNotice} in its main column WHATEVER the ticket does, and the ticket keeps the same line beside its shut
 * button (TradeTicket). The page's copy was once dropped when a ticket was bound, and a chosen strike
 * always binds one on /[ticker], and below 1024px that ticket sits in a shut sheet while the sticky Buy bar shows, so
 * the page said nothing a buyer could see. RENDERED, not read from source: the real MarketPage, its SeriesRail and the
 * real TradeTicket, with the data hooks answered from the API fixtures and the wallet disconnected.
 *
 * The /[ticker] cases need the page's clock (no day, so no strike, before it ticks), which a server render never runs.
 * For those, React's useState/useEffect/useSyncExternalStore are a slot stand-in while MarketPage is called as a
 * function (H.on), the clock effect is run once, and the returned tree is server-rendered with the real hooks. The
 * other cases render with the real hooks throughout (H.on is false).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount, useWalletClient } from "wagmi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StickyBuyBar } from "@/components/TabBar";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import type { BookResponse, Card, ConfigResponse, Market, MarketSeriesResponse, SeriesDetailResponse } from "@/lib/v2/api-types";
import { useBook, useCards, useConfig, useMarkets, useSeries, useTrades } from "@/lib/v2/hooks";
import { TRADING_PAUSED_LINE } from "@/lib/v2/tradingGate";
import { MarketPage, StrikeRows } from "./MarketPage";
import { SeriesRail } from "./SeriesPage";

const H = vi.hoisted(() => ({ on: false, slots: [] as unknown[], i: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (orig) => {
  const real = await orig<typeof import("react")>();
  return {
    ...real,
    useState: (init: unknown) => {
      if (!H.on) return real.useState(init);
      const k = H.i++;
      if (!(k in H.slots)) H.slots[k] = typeof init === "function" ? (init as () => unknown)() : init;
      return [H.slots[k], (v: unknown) => { H.slots[k] = typeof v === "function" ? (v as (p: unknown) => unknown)(H.slots[k]) : v; }];
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => (H.on ? void H.effects.push(fn) : real.useEffect(fn, deps)),
    useSyncExternalStore: (sub: (cb: () => void) => () => void, get: () => unknown, server?: () => unknown) =>
      (H.on ? get() : real.useSyncExternalStore(sub, get, server)),
  };
});
vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn(), useQueryClient: vi.fn(), useInfiniteQuery: vi.fn() }));
vi.mock("wagmi", () => ({ useAccount: vi.fn(), useWalletClient: vi.fn() }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => createElement("button", null, "Connect wallet") }));
vi.mock("@/components/TxToast", () => ({ useNotice: vi.fn(), useV2ReceiptNotice: vi.fn() }));
vi.mock("@/lib/v2/hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/v2/hooks")>()),
  useBook: vi.fn(), useCards: vi.fn(), useConfig: vi.fn(), useMarkets: vi.fn(), useSeries: vi.fn(), useTrades: vi.fn(),
}));

const fixtures = fileURLToPath(new URL("../../../ops/fixtures/api/v2/", import.meta.url));
const read = <T>(path: string): T => JSON.parse(readFileSync(`${fixtures}/${path}`, "utf8")) as T;
const hero = read<{ card: Card }>("cards/hero.json").card;
const detail = read<SeriesDetailResponse>(`series/${hero.series.longId}.json`);
const book = read<BookResponse>(`series/${hero.series.longId}/book.json`);
const config = read<ConfigResponse>("config.json");
const markets = read<Market[]>("markets.json");
const nvdaSeries = read<MarketSeriesResponse>("markets/NVDA/series.json");
const NOW = 1_789_589_112; // Wed Sep 16 2026, 4:05 PM New York: before NVDA's first listed expiry (Thu Sep 17)
const ticker = hero.series.ticker;
const query = <T>(data: T) => ({ data, isError: false, isPending: false, isFetching: false, errorUpdatedAt: 0,
  dataUpdatedAt: 0, refetch: vi.fn() });
const unread = query(undefined);

function setMarkets(tradingPaused: boolean, which = ticker) {
  const rows = markets.map((m) => (m.ticker === which ? { ...m, tradingPaused } : m));
  vi.mocked(useMarkets).mockReturnValue(query(rows) as unknown as ReturnType<typeof useMarkets>);
}

beforeEach(() => {
  vi.mocked(useAccount).mockReturnValue({ address: undefined } as ReturnType<typeof useAccount>);
  vi.mocked(useWalletClient).mockReturnValue({ data: undefined } as ReturnType<typeof useWalletClient>);
  vi.mocked(useQueryClient).mockReturnValue({ invalidateQueries: vi.fn() } as unknown as ReturnType<typeof useQueryClient>);
  vi.mocked(useQuery).mockReturnValue(unread as never);
  vi.mocked(useInfiniteQuery).mockReturnValue({ ...unread, hasNextPage: false, isFetchingNextPage: false,
    fetchNextPage: vi.fn() } as never);
  vi.mocked(useNotice).mockReturnValue(vi.fn() as ReturnType<typeof useNotice>);
  vi.mocked(useV2ReceiptNotice).mockReturnValue(vi.fn() as ReturnType<typeof useV2ReceiptNotice>);
  vi.mocked(useConfig).mockReturnValue(query(config) as unknown as ReturnType<typeof useConfig>);
  vi.mocked(useSeries).mockReturnValue(query(detail) as unknown as ReturnType<typeof useSeries>);
  vi.mocked(useBook).mockReturnValue(query(book) as unknown as ReturnType<typeof useBook>);
  vi.mocked(useTrades).mockReturnValue(query({ items: [], nextCursor: null }) as unknown as ReturnType<typeof useTrades>);
  vi.mocked(useCards).mockReturnValue(query({ items: [hero], nextCursor: null }) as unknown as ReturnType<typeof useCards>);
  setMarkets(true);
});

const render = (openTicket: boolean) =>
  renderToStaticMarkup(createElement(MarketPage, { ticker, longId: hero.series.longId, openTicket }));
const count = (html: string, text: string) => html.split(text).length - 1;
/** The page's own column: everything before the rail, which holds the ticket (a sheet below 1024px). */
const mainColumn = (html: string) => {
  const rail = html.indexOf('data-slot="rail"');
  expect(rail, "premise: the rail rendered").toBeGreaterThan(0);
  return html.slice(0, rail);
};

describe("the page says the trading brake whatever the ticket does", () => {
  it("with the ticket open: the page's notice stays, and the ticket still says it beside its button", () => {
    const html = render(true);
    expect(html, "premise: the real ticket rendered").toContain('id="ticket"');
    expect(html, "premise: the ticket's button rendered").toContain("Connect wallet");
    expect(count(html, TRADING_PAUSED_LINE)).toBe(2);
    expect(mainColumn(html)).toContain('data-slot="trading-paused-notice"');
    expect(html.slice(html.indexOf('data-slot="rail"'))).toContain(TRADING_PAUSED_LINE);
  });

  it("/[ticker]/[series] with the sheet shut (phones: the ticket is off screen): the page's own column says it", () => {
    const html = render(false);
    expect(html, "premise: the sheet is shut").toContain('data-slot="ticket-sheet" data-open="false"');
    expect(mainColumn(html)).toContain(TRADING_PAUSED_LINE);
  });

  it("with no strike chosen (no ticket): the page's notice is the one line", () => {
    const html = renderToStaticMarkup(createElement(MarketPage, { ticker }));
    expect(html).not.toContain('id="ticket"');
    expect(count(html, TRADING_PAUSED_LINE)).toBe(1);
    expect(html).toContain('data-slot="trading-paused-notice"');
  });

  it("control: trading open, the line shows nowhere, ticket open or not", () => {
    setMarkets(false);
    expect(count(render(true), TRADING_PAUSED_LINE)).toBe(0);
    expect(count(renderToStaticMarkup(createElement(MarketPage, { ticker })), TRADING_PAUSED_LINE)).toBe(0);
  });
});

describe("/[ticker] and the Buy home with a strike chosen (after the page's clock ticks)", () => {
  let infinite: Record<string, unknown>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), addEventListener: vi.fn(),
      removeEventListener: vi.fn(), matchMedia: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
      location: { pathname: "/nvda", search: "" }, history: { replaceState: vi.fn() } });
    infinite = { data: { pages: [nvdaSeries], pageParams: [undefined] }, isPending: false, isError: false, isFetching: false,
      hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn(), refetch: vi.fn() };
    vi.mocked(useInfiniteQuery).mockImplementation((() => infinite) as never);
    setMarkets(true, "NVDA");
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); H.on = false; });

  type El = ReactElement<Record<string, unknown>>;
  const all = (node: unknown, pred: (e: El) => boolean, out: El[] = []): El[] => {
    if (Array.isArray(node)) { for (const n of node) all(n, pred, out); return out; }
    if (!isValidElement(node)) return out;
    const el = node as El;
    if (pred(el)) out.push(el);
    for (const value of Object.values(el.props)) if (Array.isArray(value) || isValidElement(value)) all(value, pred, out);
    return out;
  };
  const call = (props: Record<string, unknown>) => {
    H.on = true; H.i = 0; H.effects = [];
    try { return MarketPage({ ticker: "NVDA", ...props } as Parameters<typeof MarketPage>[0]) as ReactNode; } finally { H.on = false; }
  };
  /** First render, then the page's clock effect ticks once; the second render has a day, strikes and a chosen row. */
  function mount(props: Record<string, unknown> = {}) {
    H.slots = [];
    call(props);
    const clock = H.effects.find((fn) => String(fn).includes("setNow"));
    if (!clock) throw new Error("no clock effect");
    clock();
    const tree = call(props);
    return { tree, html: renderToStaticMarkup(tree as ReactElement), again: () => {
      const next = call(props);
      return { tree: next, html: renderToStaticMarkup(next as ReactElement) };
    } };
  }

  it("a strike is chosen, its ticket is bound in a shut sheet and the sticky Buy bar shows: the page's column says it", () => {
    const { tree, html } = mount();
    const [rail] = all(tree, (e) => e.type === SeriesRail);
    expect(rail, "premise: a chosen strike binds the ticket").toBeDefined();
    expect(rail!.props.longId).toBe(all(tree, (e) => e.type === StrikeRows)[0]!.props.selected);
    expect(html, "premise: the sheet is shut").toContain('data-slot="ticket-sheet" data-open="false"');
    expect(all(tree, (e) => e.type === StickyBuyBar), "premise: the sticky Buy bar shows").toHaveLength(1);
    expect(mainColumn(html)).toContain('data-slot="trading-paused-notice"');
    expect(count(mainColumn(html), TRADING_PAUSED_LINE)).toBe(1);
  });

  it("a strike picked by hand (the sheet opens on it): the page's column still says it", () => {
    const page = mount();
    const rows = all(page.tree, (e) => e.type === StrikeRows)[0]!;
    const other = (rows.props.rows as { longId: string }[]).map((r) => r.longId).find((id) => id !== rows.props.selected)!;
    (rows.props.onSelect as (id: string) => void)(other);
    const { tree, html } = page.again();
    expect(all(tree, (e) => e.type === SeriesRail)[0]!.props.longId, "premise: the picked strike is bound").toBe(other);
    expect(mainColumn(html)).toContain('data-slot="trading-paused-notice"');
  });

  it("the Buy home (the page embedded) with a strike chosen says it too", () => {
    const { tree, html } = mount({ embedded: true });
    expect(all(tree, (e) => e.type === SeriesRail), "premise: a ticket is bound").toHaveLength(1);
    expect(mainColumn(html)).toContain('data-slot="trading-paused-notice"');
  });

  it("control: trading open, a strike chosen: the line shows nowhere", () => {
    setMarkets(false, "NVDA");
    const { tree, html } = mount();
    expect(all(tree, (e) => e.type === SeriesRail)).toHaveLength(1);
    expect(count(html, TRADING_PAUSED_LINE)).toBe(0);
  });
});
