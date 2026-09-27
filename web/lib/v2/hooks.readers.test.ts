/** lib/v2/hooks.ts: every API reader's key, enabled gate, cadence and request, with react-query stubbed to echo options. */
import { useQuery } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-query", () => ({ useQuery: vi.fn((options: unknown) => options) }));
vi.mock("./owed", () => ({ readOrderBookOwed: vi.fn(async () => 5n) }));
const deployment = vi.hoisted(() => ({ contracts: { orderBook: "0x0000000000000000000000000000000000000022" as string | undefined } }));
vi.mock("./config", async (importOriginal) => ({ ...(await importOriginal<typeof import("./config")>()), V2_DEPLOYMENT: deployment }));

import { v2Api } from "./api";
import * as hooks from "./hooks";
import { readOrderBookOwed } from "./owed";

type Options = {
  queryKey: readonly unknown[];
  queryFn: (ctx: { signal: AbortSignal }) => Promise<unknown>;
  enabled: boolean;
  staleTime: number;
  refetchInterval: number | false;
  refetchOnWindowFocus: boolean;
  retry?: number | boolean;
};
const lastOptions = () => vi.mocked(useQuery).mock.calls.at(-1)![0] as unknown as Options;
const signal = new AbortController().signal;

beforeEach(() => {
  vi.mocked(useQuery).mockClear();
  vi.restoreAllMocks();
  deployment.contracts.orderBook = "0x0000000000000000000000000000000000000022";
});

const ADDR = "0x00000000000000000000000000000000000000Ab";
const addr = ADDR.toLowerCase();

type Row = [name: string, call: () => unknown, method: keyof typeof v2Api, key: readonly unknown[], args: readonly unknown[]];

/** Readers that are always enabled. */
const always: Row[] = [
  ["useAdminOperations", () => hooks.useAdminOperations({ limit: 5 } as never), "getAdminOperations", ["v2", "adminOperations", { limit: 5 }], [{ limit: 5 }]],
  ["useFlywheel", () => hooks.useFlywheel(), "getFlywheel", ["v2", "flywheel"], []],
  ["useEarn", () => hooks.useEarn(ADDR), "getEarn", ["v2", "earn", addr], [{ address: ADDR }]],
  ["useHouse", () => hooks.useHouse(), "getHouse", ["v2", "house"], []],
  ["useMarkets", () => hooks.useMarkets(), "getMarkets", ["v2", "markets"], []],
  ["useCards", () => hooks.useCards({ limit: 3 } as never), "getCards", ["v2", "cards", { limit: 3 }], [{ limit: 3 }]],
  ["useHeroCard", () => hooks.useHeroCard(), "getHeroCard", ["v2", "heroCard"], []],
  ["useWins", () => hooks.useWins(), "getWins", ["v2", "wins", {}], [{}]],
  ["useActivity", () => hooks.useActivity(), "getActivity", ["v2", "activity", {}], [{}]],
  ["useStrategies", () => hooks.useStrategies(), "getStrategies", ["v2", "strategies", {}], [{}]],
  ["useLeaderboard", () => hooks.useLeaderboard(), "getLeaderboard", ["v2", "leaderboard", {}], [{}]],
  ["useStats", () => hooks.useStats(), "getStats", ["v2", "stats"], []],
  ["useMakers", () => hooks.useMakers(), "getMakers", ["v2", "makers", {}], [{}]],
];

/** Readers gated on an id or address; the second call omits it. */
const gated: Array<[...Row, () => unknown]> = [
  ["useMarketSeries", () => hooks.useMarketSeries("NVDA"), "getMarketSeries", ["v2", "marketSeries", "NVDA", {}], ["NVDA", {}], () => hooks.useMarketSeries()],
  ["useSeries", () => hooks.useSeries("42"), "getSeries", ["v2", "series", "42"], ["42"], () => hooks.useSeries()],
  ["useBook", () => hooks.useBook("42"), "getBook", ["v2", "book", "42", 20], ["42", 20], () => hooks.useBook()],
  ["useHolders", () => hooks.useHolders("42", { side: "short" }), "getHolders", ["v2", "holders", "42", { side: "short" }], ["42", { side: "short" }], () => hooks.useHolders()],
  ["useTrades", () => hooks.useTrades("42"), "getTrades", ["v2", "trades", "42", {}], ["42", {}], () => hooks.useTrades()],
  ["usePositions", () => hooks.usePositions(ADDR), "getPositions", ["v2", "positions", addr], [ADDR], () => hooks.usePositions()],
  ["useHistory", () => hooks.useHistory(ADDR), "getHistory", ["v2", "history", addr, {}], [ADDR, {}], () => hooks.useHistory()],
  ["usePnl", () => hooks.usePnl("p1"), "getPnl", ["v2", "pnl", "p1"], ["p1"], () => hooks.usePnl()],
  ["useMaker", () => hooks.useMaker(ADDR), "getMaker", ["v2", "maker", addr], [ADDR], () => hooks.useMaker()],
  ["useFair", () => hooks.useFair("42"), "getFair", ["v2", "fair", "42"], ["42"], () => hooks.useFair()],
  ["useHouseMarket", () => hooks.useHouseMarket("NVDA"), "getHouseMarket", ["v2", "houseMarket", "NVDA", undefined, undefined], ["NVDA", { address: undefined, vault: undefined }], () => hooks.useHouseMarket(undefined)],
];

async function expectRequest(method: keyof typeof v2Api, args: readonly unknown[]) {
  const spy = vi.spyOn(v2Api, method as never).mockResolvedValue("ok" as never);
  await expect(lastOptions().queryFn({ signal })).resolves.toBe("ok");
  expect(spy).toHaveBeenCalledWith(...args, { signal });
}

describe("API readers on the LIVE cadence", () => {
  it.each(always)("%s: key, 15 s cadence, and the request with the abort signal", async (_name, call, method, key, args) => {
    call();
    const o = lastOptions();
    expect(o.queryKey).toEqual(key);
    expect(o).toMatchObject({ enabled: true, staleTime: 15_000, refetchInterval: 15_000, refetchOnWindowFocus: true });
    expect(o.retry).toBeUndefined();
    await expectRequest(method, args);
  });

  it.each(gated)("%s: enabled only with its id, and requests it", async (_name, call, method, key, args, without) => {
    without();
    expect(lastOptions().enabled).toBe(false);
    call();
    expect(lastOptions().queryKey).toEqual(key);
    expect(lastOptions().enabled).toBe(true);
    await expectRequest(method, args);
  });
});

describe("FRESH readers", () => {
  it.each([
    ["useHealth", () => hooks.useHealth(), "getHealth", ["v2", "health"]],
    ["useConfig", () => hooks.useConfig(), "getConfig", ["v2", "config"]],
  ] as const)("%s polls every 5 s with no retry, so an outage shows at once", async (_name, call, method, key) => {
    call();
    expect(lastOptions()).toMatchObject({ queryKey: key, enabled: true, staleTime: 0, refetchInterval: 5_000, retry: 0 });
    await expectRequest(method, []);
  });
});

describe("useAllMarketSeries", () => {
  it("is off unless explicitly enabled AND given a ticker, and never polls", async () => {
    hooks.useAllMarketSeries("NVDA");
    expect(lastOptions().enabled).toBe(false);
    hooks.useAllMarketSeries(undefined, {}, { enabled: true });
    expect(lastOptions().enabled).toBe(false);
    hooks.useAllMarketSeries("NVDA", { status: "live" } as never, { enabled: true });
    const o = lastOptions();
    expect(o).toMatchObject({ ...hooks.ALL_MARKET_SERIES_POLICY, enabled: true, queryKey: ["v2", "allMarketSeries", "NVDA", { status: "live" }] });
    await expectRequest("getAllMarketSeries", ["NVDA", { status: "live" }]);
  });
});

describe("useOrderBookOwed", () => {
  it("reads the account's owed credit under the v2 prefix, lowercased", async () => {
    hooks.useOrderBookOwed(ADDR);
    const o = lastOptions();
    expect(o.queryKey).toEqual(["v2", "orderBookOwed", addr]);
    expect(o).toMatchObject({ enabled: true, staleTime: 15_000, refetchInterval: 30_000 });
    await expect(o.queryFn({ signal })).resolves.toBe(5n);
    expect(readOrderBookOwed).toHaveBeenCalledWith(ADDR);
  });

  it("is disabled without an account or without an order book in the deployment", () => {
    hooks.useOrderBookOwed(undefined);
    expect(lastOptions().enabled).toBe(false);
    deployment.contracts.orderBook = undefined;
    hooks.useOrderBookOwed(ADDR);
    expect(lastOptions().enabled).toBe(false);
  });
});

describe("v2Keys", () => {
  it("lowercases addresses so checksummed and lowercase callers share a cache entry", () => {
    expect(hooks.v2Keys.earn(ADDR)).toEqual(hooks.v2Keys.earn(addr));
    expect(hooks.v2Keys.positions(ADDR)).toEqual(hooks.v2Keys.positions(addr));
    expect(hooks.v2Keys.splitterReads(ADDR)).toEqual(["v2", "splitterReads", addr]);
    expect(hooks.v2Keys.earn()).toEqual(["v2", "earn", undefined]);
  });

  it("every key starts with the shared v2 prefix, so one invalidation refreshes them all", () => {
    for (const value of Object.values(hooks.v2Keys)) {
      const key = typeof value === "function" ? (value as (...a: unknown[]) => readonly unknown[])() : value;
      expect(key[0]).toBe("v2");
    }
  });
});
