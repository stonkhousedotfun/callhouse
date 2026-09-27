/**
 * What /[ticker] (and the Buy home, which embeds it) says before its data is ready and when the market list
 * fails. Before the page's clock is read there are no days, which is not "no expiries": it shows the strikes loader.
 * With a cached market list and a failed refresh, the market-data notice says the prices shown may be delayed.
 *
 * Server renders use the real hooks (the clock never ticks there). The "after the clock" case calls MarketPage as a
 * function with React's useState/useEffect/useSyncExternalStore as a slot stand-in (H.on) and runs its clock once.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount, useWalletClient } from "wagmi";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useNotice, useV2ReceiptNotice } from "@/components/TxToast";
import type { ConfigResponse, Market } from "@/lib/v2/api-types";
import { useBook, useCards, useConfig, useMarkets, useSeries, useTrades } from "@/lib/v2/hooks";
import { MarketPage } from "./MarketPage";

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
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/components/TxToast", () => ({ useNotice: vi.fn(), useV2ReceiptNotice: vi.fn() }));
vi.mock("@/lib/v2/hooks", async (orig) => ({
  ...(await orig<typeof import("@/lib/v2/hooks")>()),
  useBook: vi.fn(), useCards: vi.fn(), useConfig: vi.fn(), useMarkets: vi.fn(), useSeries: vi.fn(), useTrades: vi.fn(),
}));

const fixtures = fileURLToPath(new URL("../../../ops/fixtures/api/v2/", import.meta.url));
const read = <T>(path: string): T => JSON.parse(readFileSync(`${fixtures}/${path}`, "utf8")) as T;
const markets = read<Market[]>("markets.json");
const NOW = 1_789_589_112; // before NVDA's first listed expiry
const q = (data: unknown, over: Record<string, unknown> = {}) => ({ data, isError: false, isPending: false, isFetching: false,
  errorUpdatedAt: 0, dataUpdatedAt: 0, refetch: vi.fn(), ...over });
const setMarkets = (value: ReturnType<typeof q>) => vi.mocked(useMarkets).mockReturnValue(value as never);
const ssr = (props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(MarketPage, { ticker: "NVDA", ...props } as Parameters<typeof MarketPage>[0]));
const NO_EXPIRIES = "No expiries are open for NVDA yet";
const DELAYED = "Showing the last loaded prices, which may be delayed.";

beforeEach(() => {
  vi.mocked(useAccount).mockReturnValue({ address: undefined } as never);
  vi.mocked(useWalletClient).mockReturnValue({ data: undefined } as never);
  vi.mocked(useQueryClient).mockReturnValue({ invalidateQueries: vi.fn() } as never);
  vi.mocked(useQuery).mockReturnValue(q(undefined) as never);
  vi.mocked(useInfiniteQuery).mockReturnValue({ ...q(undefined), hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn() } as never);
  vi.mocked(useNotice).mockReturnValue(vi.fn() as never);
  vi.mocked(useV2ReceiptNotice).mockReturnValue(vi.fn() as never);
  vi.mocked(useConfig).mockReturnValue(q(read<ConfigResponse>("config.json")) as never);
  vi.mocked(useSeries).mockReturnValue(q(undefined) as never);
  vi.mocked(useBook).mockReturnValue(q(undefined) as never);
  vi.mocked(useTrades).mockReturnValue(q(undefined) as never);
  vi.mocked(useCards).mockReturnValue(q({ items: [], nextCursor: null }) as never);
  setMarkets(q(markets));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); H.on = false; });

describe("before the clock is read the page is loading, never 'no expiries'", () => {
  it("market list cached, clock not read (the server render and the first client render): the strikes loader", () => {
    const html = ssr();
    expect(html).toContain('role="status" aria-label="Loading strikes"');
    expect(html).not.toContain(NO_EXPIRIES);
  });

  it("the Buy home's embedded page says the same", () => {
    const html = ssr({ embedded: true });
    expect(html).toContain('aria-label="Loading strikes"');
    expect(html).not.toContain(NO_EXPIRIES);
  });

  it("after the clock, a market with no listed expiry does say so", () => {
    setMarkets(q(markets.map((m) => (m.ticker === "NVDA" ? { ...m, expiries: [], cutoffExpiries: [] } : m))));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW * 1000);
    vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), addEventListener: vi.fn(),
      removeEventListener: vi.fn(), matchMedia: vi.fn(() => ({ matches: false })), location: { pathname: "/nvda", search: "" },
      history: { replaceState: vi.fn() } });
    const call = () => {
      H.on = true; H.i = 0; H.effects = [];
      try { return MarketPage({ ticker: "NVDA" }) as ReactNode; } finally { H.on = false; }
    };
    H.slots = [];
    const first = renderToStaticMarkup(call() as ReactElement);
    expect(first, "premise: before the tick it is the loader").not.toContain(NO_EXPIRIES);
    const clock = H.effects.find((fn) => String(fn).includes("setNow"));
    if (!clock) throw new Error("no clock effect");
    clock();
    const html = renderToStaticMarkup(call() as ReactElement);
    expect(html).toContain(NO_EXPIRIES);
    expect(html).not.toContain('aria-label="Loading strikes"');
  });
});

describe("a failed market-list refresh says what is shown", () => {
  it("with a cached list: unavailable, and the prices shown are the last loaded and may be delayed", () => {
    setMarkets(q(markets, { isError: true }));
    const html = ssr();
    expect(html).toContain(`Market data is unavailable. ${DELAYED}`);
    expect(html).toContain("Retry market data");
  });

  it("with nothing cached: unavailable, and no claim that anything shown is delayed", () => {
    setMarkets(q(undefined, { isError: true }));
    const html = ssr();
    expect(html).toContain("Market data is unavailable.");
    expect(html).not.toContain(DELAYED);
  });
});
