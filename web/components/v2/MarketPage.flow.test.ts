/**
 * The market page component's client behaviour (Neon redesign), driven with the API fixtures: after mount the clock
 * picks the first listed day and the strike list loads (the infinite query's key, fetcher and next-page cursor), a row
 * is chosen and the rail's real ticket, the chart and the sticky bar follow it; the day chips, the Calls | Puts control
 * and the chart handle; the order sheet (a row or the sticky bar opens it, Close and Escape shut it); the address bar
 * is kept on the shown series and a foreign route is moved off; phone width; the page embedded on the Buy home; and
 * the error / loading / empty / paging states.
 *
 * No DOM renderer here (node environment by design): while MarketPage is called as a function, React's
 * useState/useEffect/useSyncExternalStore are a slot stand-in (H.on), so effects and handlers can be driven; the
 * returned tree is then server-rendered with the real hooks. `window` is a small fake.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount, useWalletClient } from "wagmi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { StickyBuyBar } from "@/components/TabBar";
import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import { SegmentedControl } from "@/components/ui";
import { v2Api } from "@/lib/v2/api";
import type { ConfigResponse, Market, MarketSeriesResponse, SeriesDetailResponse } from "@/lib/v2/api-types";
import { useBook, useCards, useConfig, useMarkets, useSeries, useTrades } from "@/lib/v2/hooks";
import { PayoffChart } from "./PayoffChart";
import { EmptyAsks, MarketPage, NoExpiries, StrikeRows } from "./MarketPage";
import { SeriesDetails, SeriesRail } from "./SeriesPage";
import { ExpiryChips } from "./trade/ExpiryChips";

const H = vi.hoisted(() => ({
  on: false, slots: [] as unknown[], i: 0, effects: [] as (() => void | (() => void))[],
  subscribes: [] as ((cb: () => void) => () => void)[],
}));
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
    useSyncExternalStore: (sub: (cb: () => void) => () => void, get: () => unknown, server?: () => unknown) => {
      if (!H.on) return real.useSyncExternalStore(sub, get, server);
      H.subscribes.push(sub);
      return get();
    },
  };
});
vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn(), useQueryClient: vi.fn(), useInfiniteQuery: vi.fn() }));
vi.mock("wagmi", () => ({ useAccount: vi.fn(), useWalletClient: vi.fn() }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/components/TxToast", () => ({ useNotice: vi.fn(), useV2ReceiptNotice: vi.fn() }));
vi.mock("@/lib/v2/hooks", async (orig) => ({
  ...(await orig<typeof import("@/lib/v2/hooks")>()),
  useBook: vi.fn(), useCards: vi.fn(), useConfig: vi.fn(), useMarkets: vi.fn(), useSeries: vi.fn(), useTrades: vi.fn(),
}));
vi.mock("@/lib/v2/api", () => ({ v2Api: { getMarketSeries: vi.fn() } }));

const fixtures = fileURLToPath(new URL("../../../ops/fixtures/api/v2/", import.meta.url));
const read = <T>(path: string): T => JSON.parse(readFileSync(`${fixtures}/${path}`, "utf8")) as T;
const config = read<ConfigResponse>("config.json");
const markets = read<Market[]>("markets.json");
const nvdaSeries = read<MarketSeriesResponse>("markets/NVDA/series.json");
const tslaDetail = read<SeriesDetailResponse>("series/21165361030703244250250325315731231611793543999394763286193608411968431077920.json");
const nvdaMarket = markets.find((m) => m.ticker === "NVDA")!;
const NOW = 1_789_589_112; // Wed Sep 16 2026, 4:05 PM New York
const FIRST_DAY = 1_789_675_200; // Thu Sep 17, 4:00 PM New York: NVDA's first listed expiry
const SECOND_DAY = 1_789_761_600; // Fri Sep 18

/**
 * MarketPage's useEffect calls, in the order it makes them: the order sheet's Escape key, the one-second clock, moving
 * a hidden route off the address bar, keeping the address bar on the shown series. (useDayChange's fetch is the fifth
 * and is never run here.) Its useState slots: `sheetOpen` is the fifth, `selectedId` the sixth, `now` the eleventh.
 */
const FX = { escape: 0, clock: 1, routeHidden: 2, shown: 3 } as const;
const SLOT = { sheetOpen: 4, selectedId: 5, now: 10 } as const;

type Props = Record<string, unknown> & { children?: ReactNode };
type El = ReactElement<Props>;
function all(node: unknown, pred: (e: El) => boolean, out: El[] = []): El[] {
  if (Array.isArray(node)) { for (const n of node) all(n, pred, out); return out; }
  if (!isValidElement(node)) return out;
  const el = node as El;
  if (pred(el)) out.push(el);
  for (const value of Object.values(el.props)) if (Array.isArray(value) || isValidElement(value)) all(value, pred, out);
  return out;
}
const one = (tree: unknown, type: unknown) => all(tree, (e) => e.type === type)[0];
const text = (n: ReactNode): string => Array.isArray(n) ? n.map(text).join("") : isValidElement(n) ? text((n as El).props.children) : n == null || typeof n === "boolean" ? "" : String(n);
const byText = (tree: unknown, t: string) => all(tree, (e) => typeof e.props.onClick === "function" && text(e.props.children) === t)[0];
const byLabel = (tree: unknown, label: string) => all(tree, (e) => e.props["aria-label"] === label)[0];
const sheet = (tree: unknown) => all(tree, (e) => e.props["data-slot"] === "ticket-sheet")[0]!;
const query = <T>(data: T, over: Record<string, unknown> = {}) => ({ data, isError: false, isPending: false, isFetching: false,
  errorUpdatedAt: 0, dataUpdatedAt: 0, refetch: vi.fn(), ...over });
/** The fixture's rows for one day and side, cheapest strike first, as the page sorts them. */
const itemsFor = (expiry: number, isPut = false) => nvdaSeries.items
  .filter((i) => i.series.expiry === expiry && i.series.isPut === isPut)
  .sort((a, b) => Number(BigInt(a.series.strike.raw) - BigInt(b.series.strike.raw)));
/** "Thu 17": the day chips' label for a New York day that is not today, derived here from the calendar. */
const dayWord = (expiry: number) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { weekday: "short", day: "numeric", timeZone: "America/New_York" })
    .formatToParts(new Date(expiry * 1000)).map((p) => [p.type, p.value]));
  return `${parts.weekday} ${parts.day}`;
};

let infinite: Record<string, unknown>;
let replaceState: ReturnType<typeof vi.fn>;
let addEventListener: ReturnType<typeof vi.fn>;
let location: { pathname: string; search: string };
let phone: boolean;

function render(props: Partial<Parameters<typeof MarketPage>[0]> = {}) {
  H.on = true;
  H.i = 0;
  H.effects = [];
  H.subscribes = [];
  const tree = MarketPage({ ticker: "NVDA", ...props }) as ReactNode;
  H.on = false;
  return { tree, html: renderToStaticMarkup(tree as ReactElement) };
}
/** First render, then the clock effect ticks once; the second render has `now`. */
function mount(props: Partial<Parameters<typeof MarketPage>[0]> = {}) {
  render(props);
  H.effects[FX.clock]!();
  return render(props);
}
const lastInfinite = () => vi.mocked(useInfiniteQuery).mock.calls.at(-1)![0] as unknown as {
  queryKey: unknown[]; enabled: boolean; queryFn: (ctx: { pageParam?: string; signal: AbortSignal }) => unknown;
  getNextPageParam: (last: { nextCursor: string | null }) => unknown;
};
/** A route series answered by useSeries: the NVDA fixture row's own series, on the TSLA detail's shape. */
function routeTo(routeId: string) {
  vi.mocked(useSeries).mockImplementation(((id: string) => query(id === routeId
    ? { ...tslaDetail, series: nvdaSeries.items.find((i) => i.series.longId === routeId)!.series } : undefined)) as never);
}

beforeEach(() => {
  H.slots = [];
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
  phone = false;
  location = { pathname: "/nvda", search: "" };
  replaceState = vi.fn((_s: unknown, _t: string, url: string) => { location.pathname = url.split("?")[0]!; });
  addEventListener = vi.fn();
  vi.stubGlobal("window", {
    setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval,
    matchMedia: () => ({ matches: phone, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    addEventListener, removeEventListener: vi.fn(),
    location, history: { replaceState },
  });
  vi.mocked(useAccount).mockReturnValue({ address: undefined } as never);
  vi.mocked(useWalletClient).mockReturnValue({ data: undefined } as never);
  vi.mocked(useQueryClient).mockReturnValue({ invalidateQueries: vi.fn() } as never);
  vi.mocked(useQuery).mockReturnValue(query(undefined) as never);
  infinite = { ...query({ pages: [nvdaSeries], pageParams: [undefined] }), hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn() };
  vi.mocked(useInfiniteQuery).mockImplementation(() => infinite as never);
  vi.mocked(useNotice).mockReturnValue(vi.fn() as never);
  vi.mocked(useV2ReceiptNotice).mockReturnValue(vi.fn() as never);
  vi.mocked(useConfig).mockReturnValue(query(config) as never);
  vi.mocked(useMarkets).mockReturnValue(query(markets) as never);
  vi.mocked(useSeries).mockReturnValue(query(undefined) as never);
  vi.mocked(useBook).mockReturnValue(query(undefined) as never);
  vi.mocked(useTrades).mockReturnValue(query(undefined) as never);
  vi.mocked(useCards).mockReturnValue(query(undefined) as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("mounting", () => {
  it("before the clock: no day chips, the strike query is disabled; after it: the first day, calls, 50 a page", async () => {
    const first = render();
    expect(lastInfinite().enabled).toBe(false);
    expect(one(first.tree, ExpiryChips)).toBeUndefined();
    H.effects[FX.clock]!();
    const { tree } = render();
    const q = lastInfinite();
    expect(q.enabled).toBe(true);
    expect(q.queryKey).toEqual(["v2", "marketSeriesInfinite", "NVDA", "call", FIRST_DAY]);
    const signal = new AbortController().signal;
    vi.mocked(v2Api.getMarketSeries).mockResolvedValue(nvdaSeries);
    await q.queryFn({ pageParam: "c2", signal });
    expect(v2Api.getMarketSeries).toHaveBeenCalledWith("NVDA", { type: "call", expiry: FIRST_DAY, limit: 50, cursor: "c2" }, { signal });
    expect(q.getNextPageParam({ nextCursor: "n" })).toBe("n");
    expect(q.getNextPageParam({ nextCursor: null })).toBeUndefined();
    const chips = one(tree, ExpiryChips)!.props;
    expect(chips.selected).toBe(FIRST_DAY);
    expect(chips.expiries, "the chips are this market's listed days").toEqual([...nvdaMarket.expiries, ...nvdaMarket.cutoffExpiries]);
    expect(chips.resaleOnly).toEqual(nvdaMarket.cutoffExpiries);
    expect(chips.now).toBe(NOW);
  });

  it("the clock ticks every second and stops on unmount", () => {
    render();
    const cleanup = H.effects[FX.clock]!() as () => void;
    expect(H.slots[SLOT.now]).toBe(NOW);
    vi.advanceTimersByTime(3_000);
    expect(H.slots[SLOT.now]).toBe(NOW + 3);
    cleanup();
    vi.advanceTimersByTime(3_000);
    expect(H.slots[SLOT.now]).toBe(NOW + 3);
  });

  it("rows for the day's calls only, a row with an ask chosen, and the rail's ticket, chart and sticky bar follow it", () => {
    const { tree, html } = mount();
    const rows = one(tree, StrikeRows)!.props.rows as { longId: string; ask: bigint | null }[];
    expect(rows.map((r) => r.longId)).toEqual(itemsFor(FIRST_DAY).map((i) => i.series.longId));
    // The cheapest strike with an ask: the fixture's $216 call at 1.745 a share.
    const chosen = itemsFor(FIRST_DAY).find((i) => i.quote.bestAsk)!;
    expect(chosen.series.strike.formatted).toBe("216");
    expect(one(tree, StrikeRows)!.props.selected).toBe(chosen.series.longId);
    // The rail holds the real ticket for that strike (no review hop), bound to the chart handle.
    const rail = one(tree, SeriesRail)!.props;
    expect(rail).toMatchObject({ ticker: "NVDA", longId: chosen.series.longId, openTicket: false, initialShares: undefined });
    const chart = one(tree, PayoffChart)!.props as { variant: string; price: bigint; input: { strike: bigint; isPut: boolean; cost: bigint } };
    expect(chart.variant).toBe("large");
    expect(typeof chart.price).toBe("bigint");
    expect(rail.atPrice).toBe(chart.price);
    // One share at the best ask: premium 1.745 + the capped taker fee min(0.10, 10% of 1.745) = 1.845 USDG.
    const cost = 1_745_000n + (100_000n < 174_500n ? 100_000n : 174_500n);
    expect(chart.input).toMatchObject({ strike: 216_000_000n, isPut: false, cost });
    expect(html).toContain("Drag the chart to test a price");
    // The sticky bar: the max loss rounded UP to the cent ($1.845 -> $1.85), and Buy opens the order sheet in place.
    const bar = one(tree, StickyBuyBar)!;
    expect(text(bar.props.children)).toBe("1 sh · max loss$1.85Buy $216 Call");
    expect(one(tree, SeriesDetails), "/[ticker] has no series activity").toBeUndefined();
  });

  it("dragging the chart moves the ticket's test price", () => {
    const { tree } = mount();
    (one(tree, PayoffChart)!.props.onPriceChange as (p: bigint) => void)(250_000_000n);
    const next = render().tree;
    expect(one(next, PayoffChart)!.props.price).toBe(250_000_000n);
    expect(one(next, SeriesRail)!.props.atPrice).toBe(250_000_000n);
  });

  it("the ticket's quote drives the chart and the sticky bar, but only the quote for the strike on screen", () => {
    const { tree } = mount();
    const chosen = one(tree, SeriesRail)!.props.longId as string;
    const onQuote = one(tree, SeriesRail)!.props.onQuote as (q: unknown) => void;
    onQuote({ longId: "another-strike", units: 700n, premium: 9_000_000n, cost: 9_100_000n });
    const stale = render().tree;
    expect(text(one(stale, StickyBuyBar)!.props.children), "a quote for another strike is ignored").toMatch(/^1 sh · max loss\$1\.85/);
    onQuote({ longId: chosen, units: 300n, premium: 5_235_000n, cost: 5_535_000n });
    const bound = render().tree;
    expect((one(bound, PayoffChart)!.props.input as { cost: bigint }).cost).toBe(5_535_000n);
    expect(text(one(bound, StickyBuyBar)!.props.children)).toMatch(/^3 sh · max loss\$5\.54Buy /);
  });

  it("picking a day re-asks for that day and clears the picked strike", () => {
    // On a route the clearing shows: were the route's own strike still picked, the page would keep it off screen
    // (chooseRow) instead of choosing a strike of the new day.
    const routeId = itemsFor(FIRST_DAY).find((i) => i.quote.bestAsk)!.series.longId;
    routeTo(routeId);
    location.pathname = `/nvda/${routeId}`;
    const { tree } = mount({ longId: routeId });
    (one(tree, ExpiryChips)!.props.onSelect as (d: number) => void)(SECOND_DAY);
    expect(H.slots[SLOT.selectedId]).toBeNull();
    const next = render({ longId: routeId }).tree;
    expect(lastInfinite().queryKey).toEqual(["v2", "marketSeriesInfinite", "NVDA", "call", SECOND_DAY]);
    const secondDayFirstAsk = itemsFor(SECOND_DAY).find((i) => i.quote.bestAsk)!.series.longId;
    expect(one(next, StrikeRows)!.props.selected).toBe(secondDayFirstAsk);
    expect(one(next, SeriesRail)!.props.longId).toBe(secondDayFirstAsk);
    H.effects[FX.shown]!();
    expect(replaceState).toHaveBeenCalledWith(null, "", `/nvda/${secondDayFirstAsk}`);
  });

  it("phone width: the compact chart; the media query subscription attaches and detaches", () => {
    phone = true;
    const { tree } = mount();
    expect(one(tree, PayoffChart)!.props.variant).toBe("compact");
    const mq = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    (window as unknown as { matchMedia: () => unknown }).matchMedia = () => mq;
    const onChange = vi.fn();
    const unsubscribe = H.subscribes[0]!(onChange);
    expect(mq.addEventListener).toHaveBeenCalledWith("change", onChange);
    unsubscribe();
    expect(mq.removeEventListener).toHaveBeenCalledWith("change", onChange);
  });
});

describe("the order sheet", () => {
  it("choosing a strike opens the sheet on it and hides the sticky bar; Close shuts it and the bar comes back", () => {
    const { tree } = mount();
    expect(sheet(tree).props["data-open"]).toBe("false");
    const other = itemsFor(FIRST_DAY).filter((i) => i.quote.bestAsk)[1]!.series;
    (one(tree, StrikeRows)!.props.onSelect as (id: string) => void)(other.longId);
    const open = render().tree;
    expect(sheet(open).props["data-open"]).toBe("true");
    expect(one(open, SeriesRail)!.props.longId).toBe(other.longId);
    expect(one(open, StickyBuyBar), "the sheet is up: no bar under it").toBeUndefined();
    (byLabel(open, "Close")!.props.onClick as () => void)();
    const shut = render().tree;
    expect(sheet(shut).props["data-open"]).toBe("false");
    const bar = one(shut, StickyBuyBar)!;
    expect(text(bar.props.children)).toContain(`Buy $${other.strike.formatted} Call`);
    (all(bar, (e) => typeof e.props.onClick === "function")[0]!.props.onClick as () => void)();
    expect(sheet(render().tree).props["data-open"], "the bar's Buy reopens the sheet").toBe("true");
  });

  it("Escape shuts an open sheet, and the key listener is only there while it is open", () => {
    const { tree } = mount();
    render();
    expect(H.effects[FX.escape]!(), "sheet shut: no listener").toBeUndefined();
    expect(addEventListener).not.toHaveBeenCalled();
    (one(tree, StrikeRows)!.props.onSelect as (id: string) => void)(one(tree, StrikeRows)!.props.selected as string);
    render();
    const cleanup = H.effects[FX.escape]!() as () => void;
    const [event, onKey] = addEventListener.mock.calls[0]! as [string, (e: { key: string }) => void];
    expect(event).toBe("keydown");
    onKey({ key: "Enter" });
    expect(H.slots[SLOT.sheetOpen]).toBe(true);
    onKey({ key: "Escape" });
    expect(H.slots[SLOT.sheetOpen]).toBe(false);
    cleanup();
    expect((window as unknown as { removeEventListener: ReturnType<typeof vi.fn> }).removeEventListener).toHaveBeenCalledWith("keydown", onKey);
  });
});

describe("puts", () => {
  it("a market with puts offers the side control; choosing Puts re-asks for puts", () => {
    vi.mocked(useMarkets).mockReturnValue(query(markets.map((m) => (m.ticker === "NVDA" ? { ...m, puts: true } : m))) as never);
    const { tree } = mount();
    const side = all(tree, (e) => e.type === SegmentedControl && e.props.label === "Option type")[0]!;
    (side.props.onSelect as (k: string) => void)("put");
    const { html } = render();
    expect(lastInfinite().queryKey).toEqual(["v2", "marketSeriesInfinite", "NVDA", "put", FIRST_DAY]);
    expect(html, "no NVDA puts in the fixture: the listed-nothing empty state").toContain("No NVDA puts are listed for this day.");
  });

  it("no puts flag: no side control, and the chain is calls", () => {
    const { tree } = mount();
    expect(all(tree, (e) => e.type === SegmentedControl && e.props.label === "Option type")).toHaveLength(0);
    expect(lastInfinite().queryKey).toEqual(["v2", "marketSeriesInfinite", "NVDA", "call", FIRST_DAY]);
    expect(one(tree, StrikeRows)).toBeDefined();
  });

  it("a Puts choice cannot survive the market's puts flag turning off: the page asks for calls again", () => {
    vi.mocked(useMarkets).mockReturnValue(query(markets.map((m) => (m.ticker === "NVDA" ? { ...m, puts: true } : m))) as never);
    const { tree } = mount();
    (all(tree, (e) => e.type === SegmentedControl && e.props.label === "Option type")[0]!.props.onSelect as (k: string) => void)("put");
    render();
    expect(lastInfinite().queryKey[3]).toBe("put");
    vi.mocked(useMarkets).mockReturnValue(query(markets) as never);
    const { tree: after, html } = render();
    expect(lastInfinite().queryKey).toEqual(["v2", "marketSeriesInfinite", "NVDA", "call", FIRST_DAY]);
    expect(all(after, (e) => e.type === SegmentedControl && e.props.label === "Option type")).toHaveLength(0);
    expect(html).not.toContain("No NVDA puts");
    expect((one(after, StrikeRows)!.props.rows as { isPut: boolean }[]).every((r) => !r.isPut)).toBe(true);
  });
});

describe("the address bar", () => {
  it("a /[ticker]/[series] route follows the shown strike, keeping the query string", () => {
    const routeId = itemsFor(FIRST_DAY).find((i) => i.quote.bestAsk)!.series.longId;
    routeTo(routeId);
    location.pathname = `/nvda/${routeId}`;
    location.search = "?buy=1";
    const { tree } = mount({ longId: routeId });
    expect(one(tree, SeriesDetails)!.props.longId).toBe(routeId);
    expect(one(tree, SeriesRail)!.props.longId).toBe(routeId);
    H.effects[FX.shown]!();
    expect(replaceState, "already there").not.toHaveBeenCalled();
    const other = (one(tree, StrikeRows)!.props.rows as { longId: string }[]).find((r) => r.longId !== routeId)!.longId;
    (one(tree, StrikeRows)!.props.onSelect as (id: string) => void)(other);
    const next = render({ longId: routeId }).tree;
    expect(one(next, SeriesDetails)!.props.longId, "the activity follows the pick").toBe(other);
    H.effects[FX.shown]!();
    expect(replaceState).toHaveBeenCalledWith(null, "", `/nvda/${other}?buy=1`);
    expect(H.effects[FX.routeHidden]!(), "the route is not hidden").toBeUndefined();
  });

  it("a series of another market moves the address bar to this market's page, once, and none of it is shown", () => {
    vi.mocked(useSeries).mockReturnValue(query(tslaDetail) as never);
    location.pathname = `/nvda/${tslaDetail.series.longId}`;
    const { tree } = mount({ longId: tslaDetail.series.longId });
    H.effects[FX.routeHidden]!();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/nvda");
    H.effects[FX.routeHidden]!();
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(H.effects[FX.shown]!(), "no shown series on a hidden route").toBeUndefined();
    // The TSLA series is not drawn under NVDA's name: no activity for it, and the rail holds an NVDA strike.
    expect(one(tree, SeriesDetails)).toBeUndefined();
    const rail = one(tree, SeriesRail)!.props.longId as string;
    expect(rail).not.toBe(tslaDetail.series.longId);
    expect(itemsFor(FIRST_DAY).some((i) => i.series.longId === rail)).toBe(true);
    expect(lastInfinite().queryKey).toEqual(["v2", "marketSeriesInfinite", "NVDA", "call", FIRST_DAY]);
  });

  it("?buy=1 opens the route's ticket in the sheet with the route's size; the sticky bar waits until the sheet is shut", () => {
    const routeId = itemsFor(FIRST_DAY).find((i) => i.quote.bestAsk)!.series.longId;
    routeTo(routeId);
    location.pathname = `/nvda/${routeId}`;
    const { tree } = mount({ longId: routeId, openTicket: true, initialShares: "3" });
    expect(sheet(tree).props["data-open"]).toBe("true");
    expect(one(tree, SeriesRail)!.props).toMatchObject({ longId: routeId, openTicket: true, initialShares: "3" });
    expect(one(tree, StickyBuyBar)).toBeUndefined();
    (byLabel(tree, "Close the order")!.props.onClick as () => void)();
    const shut = render({ longId: routeId, openTicket: true, initialShares: "3" }).tree;
    expect(sheet(shut).props["data-open"]).toBe("false");
    expect(one(shut, StickyBuyBar)).toBeDefined();
  });
});

describe("embedded on the Buy home", () => {
  it("no hero, chart or series activity; the day chips, the chain and the rail's ticket stay", () => {
    const { tree, html } = mount({ embedded: true });
    expect(html).not.toContain('data-slot="market-hero"');
    expect(one(tree, PayoffChart)).toBeUndefined();
    expect(one(tree, ExpiryChips)!.props.selected).toBe(FIRST_DAY);
    expect(one(tree, StrikeRows)).toBeDefined();
    expect(one(tree, SeriesRail)!.props.longId).toBe(one(tree, StrikeRows)!.props.selected);
  });

  it("market data failed with a cached list: the notice and its Retry still show, and the stale spot draws no share-price line", () => {
    const failed = query(markets, { isError: true });
    vi.mocked(useMarkets).mockReturnValue(failed as never);
    const { tree, html } = mount({ embedded: true });
    expect(html).toContain("Market data is unavailable.");
    (byText(tree, "Retry market data")!.props.onClick as () => void)();
    expect(failed.refetch).toHaveBeenCalled();
    expect(one(tree, StrikeRows)!.props.spot).toBeNull();
    expect(html).not.toContain('data-slot="share-price"');
  });
});

describe("states", () => {
  it("market data failed: Retry market data refetches; while refetching it is disabled", () => {
    const failed = query(undefined, { isError: true });
    vi.mocked(useMarkets).mockReturnValue(failed as never);
    const { tree, html } = mount();
    expect(html).toContain("Market data is unavailable.");
    expect(html).toContain("Expiries are unavailable. Try again shortly.");
    expect(one(tree, NoExpiries), "a failed list is not an empty one").toBeUndefined();
    (byText(tree, "Retry market data")!.props.onClick as () => void)();
    expect(failed.refetch).toHaveBeenCalled();
    vi.mocked(useMarkets).mockReturnValue(query(undefined, { isError: true, isFetching: true }) as never);
    expect(render().html).toMatch(/<button[^>]*disabled=""[^>]*>Retrying…<\/button>/);
  });

  it("no expiries listed: the no-expiries panel, and no day chips", () => {
    vi.mocked(useMarkets).mockReturnValue(query(markets.map((m) => ({ ...m, expiries: [], cutoffExpiries: [] }))) as never);
    const { tree } = mount();
    expect(one(tree, NoExpiries)).toBeDefined();
    expect(one(tree, ExpiryChips)).toBeUndefined();
    expect(lastInfinite().enabled).toBe(false);
  });

  it("strikes loading: a loading status, not an empty state", () => {
    infinite = { ...infinite, data: undefined, isPending: true };
    const { tree, html } = mount();
    expect(html).toMatch(/role="status" aria-label="Loading strikes"/);
    expect(one(tree, EmptyAsks)).toBeUndefined();
    expect(one(tree, StrikeRows)).toBeUndefined();
  });

  it("strikes failed with cached pages: the rows stay, with a delayed notice whose Retry refetches", () => {
    infinite = { ...infinite, isError: true };
    const { tree, html } = mount();
    expect(html).toContain("Strikes are delayed.");
    expect(html).toContain("Showing the last ones loaded.");
    expect(one(tree, StrikeRows)).toBeDefined();
    (byText(tree, "Retry")!.props.onClick as () => void)();
    expect(infinite.refetch).toHaveBeenCalled();
  });

  it("strikes failed with nothing cached: the notice only, no empty state that would claim nothing is listed", () => {
    infinite = { ...infinite, data: undefined, isError: true };
    const { tree, html } = mount();
    expect(lastInfinite().enabled, "premise: a day is chosen").toBe(true);
    expect(html).toContain("Strikes are delayed.");
    expect(html).not.toContain("Showing the last ones loaded.");
    expect(one(tree, EmptyAsks)).toBeUndefined();
    expect(one(tree, NoExpiries)).toBeUndefined();
    expect(one(tree, StrikeRows)).toBeUndefined();
  });

  it("strikes listed but none with an ask: the listed-but-no-sellers state above the rows", () => {
    const noAsks = { ...nvdaSeries, items: nvdaSeries.items.map((i) => ({ ...i, quote: { ...i.quote, bestAsk: null } })) };
    infinite = { ...infinite, data: { pages: [noAsks], pageParams: [undefined] } };
    const { tree, html } = mount();
    expect(one(tree, EmptyAsks)!.props.listed).toBe(true);
    expect(one(tree, StrikeRows)).toBeDefined();
    expect(html).toContain("NVDA calls are listed, but no one is selling yet.");
    expect(one(tree, StickyBuyBar), "no ask, no cost, no bar").toBeUndefined();
  });

  it("nothing listed for the day: the empty state names the day and links to selling this market; the chart is labelled", () => {
    infinite = { ...infinite, data: { pages: [{ ...nvdaSeries, items: [] }], pageParams: [undefined] } };
    const { tree, html } = mount();
    const empty = one(tree, EmptyAsks)!.props;
    expect(empty).toMatchObject({ listed: false, dayLabel: dayWord(FIRST_DAY), typeWord: "Calls" });
    expect(html).toContain(`No asks for ${dayWord(FIRST_DAY)} yet`);
    expect(html).toContain("No NVDA calls are listed for this day.");
    expect(html).toContain('href="/sell/nvda"');
    expect(html).toContain('href="/settings/notifications"');
    expect(one(tree, SeriesRail), "no strike, no ticket").toBeUndefined();
    expect(html).toContain("Pick a strike to start an order.");
    expect(one(tree, StickyBuyBar)).toBeUndefined();
    expect(html, "the example curve is never passed off as a quote").toContain("Not a live quote");
  });

  it("more pages: Load more strikes fetches the next; while it loads it is disabled", () => {
    infinite = { ...infinite, hasNextPage: true };
    const { tree } = mount();
    (byText(tree, "Load more strikes")!.props.onClick as () => void)();
    expect(infinite.fetchNextPage).toHaveBeenCalled();
    infinite = { ...infinite, isFetchingNextPage: true };
    expect(render().html).toMatch(/<button[^>]*disabled=""[^>]*>Loading strikes…<\/button>/);
  });
});
