import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getAddress } from "viem";
import { describe, expect, it, vi } from "vitest";

import {
  GENERATED_MARKETS,
  GENERATED_REGISTRY,
  V2_CONTRACTS,
  V2_DEFAULTS,
  V2_FEES,
  V2_REGISTRY,
  V2_UNISWAP_V3,
} from "./markets.generated";
import {
  ALL_MARKETS,
  DEFAULT_MARKET,
  DEFAULT_TICKER,
  MARKETS,
  getMarket,
  isV2Live,
  marketFromPathname,
  marketHref,
  parseTickerParam,
  plannedByWave,
  resolveDefaultMarket,
  v1FrozenAt,
  v2Markets,
  type LiveMarket,
} from "./markets";

/**
 * lib/markets.generated.ts is committed (the Docker build has no ops/), so the thing that can go
 * wrong is silent: the registry changes, nobody re-runs gen:markets, and the app ships the old
 * market list. This test reads the REAL registry from the workspace and holds the generated file
 * to it field by field, so that drift fails the test gate instead of a deploy.
 *
 * It runs from the workspace on purpose (vitest is never run inside the image), and it reads the
 * JSON itself rather than importing the generator: the check has to be independent of the code
 * that wrote the file.
 *
 * THE COUPLING IS DELIBERATE. `verifiedAtBlock` and `generatedAt` are pinned too, and
 * ops/markets/build-markets.mjs rewrites BOTH on every run (it re-verifies at the current block),
 * so every registry rebuild turns this gate red until gen:markets is re-run and the generated file
 * is committed alongside, even when no field the app copies has changed. That is the intended
 * discipline, not an accident: the docs page prints verifiedAtBlock as the block "every address
 * was verified at", and a committed file that claimed an older verification than the registry's
 * would be a small lie on a page about addresses. The cost is one extra command per registry
 * refresh, and the registry README says to run it.
 *
 * THE REGISTRY MUST BE THERE. A checkout without ops/markets/tier1.json (a partial checkout, or
 * the web change landing before the registry does) fails this file with a message that names the
 * path, rather than passing silently with nothing checked. MARKETS_REGISTRY_OPTIONAL=1 turns that
 * into an explicit skip of the registry-backed cases (vitest reports them as skipped) for the one
 * legitimate case, a run that has no ops/ on purpose; it is never set in CI.
 */
const REGISTRY_PATH = path.resolve(import.meta.dirname, "..", "..", "ops", "markets", "tier1.json");
const REGISTRY_OPTIONAL = process.env.MARKETS_REGISTRY_OPTIONAL === "1";

type RegistryMarket = {
  ticker: string;
  name: string;
  asset: string;
  feed: string;
  status: string;
  wave: string;
  mode: string;
  cboe: { root: string };
  depositCapUsd: number | null;
  v1RunOff?: boolean;
  v1FrozenAt?: number | null;
  deployment: { factory: string | null; deployBlock: number | null };
  v2: {
    status: string;
    wave: string;
    strikeTick: string;
    puts: boolean;
    mintFeePpm: number;
    univ3Pool: string | null;
    univ3MinLiquidity: string | null;
    dataStreamsFeedId: string | null;
    overrides: Record<string, unknown>;
    registeredAt: number | null;
    registerTx: string | null;
  };
};

type Registry = {
  verifiedAtBlock: number;
  generatedAt: string;
  v2: {
    interfaceVersion: number;
    deployBlock: number | string | null;
    contracts: Record<string, unknown>;
    uniswapV3: Record<string, string>;
    fees: Record<string, unknown>;
    defaults: Record<string, unknown>;
  };
  markets: RegistryMarket[];
};

function loadRegistry(): Registry | undefined {
  if (existsSync(REGISTRY_PATH)) return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
  if (REGISTRY_OPTIONAL) return undefined;
  throw new Error(
    `[markets.test] the market registry is missing at ${REGISTRY_PATH}. The web test gate checks ` +
      "lib/markets.generated.ts against ops/markets/tier1.json, so the registry must be in the checkout " +
      "(commit it together with the generated file). Set MARKETS_REGISTRY_OPTIONAL=1 to skip the " +
      "registry-backed cases explicitly in a run that has no ops/ on purpose.",
  );
}

const maybeRegistry = loadRegistry();
// Non-null inside the registry-backed blocks below: they are skipped when it is undefined.
const registry = maybeRegistry as Registry;
const withRegistry = describe.skipIf(maybeRegistry === undefined);
const itWithRegistry = it.skipIf(maybeRegistry === undefined);

withRegistry("lib/markets.generated.ts is in sync with ops/markets/tier1.json", () => {
  it("was generated from this registry build", () => {
    expect(GENERATED_REGISTRY.verifiedAtBlock).toBe(registry.verifiedAtBlock);
    expect(GENERATED_REGISTRY.generatedAt).toBe(registry.generatedAt);
  });

  it("carries every market, in registry order, field for field", () => {
    expect(GENERATED_MARKETS.map((m) => m.ticker)).toEqual(registry.markets.map((m) => m.ticker));
    registry.markets.forEach((row, i) => {
      const gen = GENERATED_MARKETS[i];
      expect(gen, row.ticker).toEqual({
        ticker: row.ticker,
        name: row.name,
        asset: row.asset,
        feed: row.feed,
        factory: row.deployment.factory ?? null,
        deployBlock: row.deployment.deployBlock ?? null,
        status: row.status,
        wave: row.wave,
        mode: row.mode,
        cboeRoot: row.cboe.root,
        depositCapUsd: row.depositCapUsd ?? null,
        v1FrozenAt: row.v1FrozenAt ?? null,
        v2: row.v2,
      });
    });
  });

  it("carries the registry's top-level v2 block: version, deploy block, contracts, Uniswap periphery, fees, defaults", () => {
    expect(V2_REGISTRY).toEqual({ interfaceVersion: registry.v2.interfaceVersion, deployBlock: registry.v2.deployBlock });
    expect(V2_CONTRACTS).toEqual(registry.v2.contracts);
    expect(V2_UNISWAP_V3).toEqual(registry.v2.uniswapV3);
    expect(V2_FEES).toEqual(registry.v2.fees);
    expect(V2_DEFAULTS).toEqual(registry.v2.defaults);
  });

  it("projects every approved nonzero per-market writer rent rate exactly", () => {
    const projected = v2Markets();
    expect(projected).toHaveLength(registry.markets.length);
    registry.markets.forEach((row, i) => {
      expect(GENERATED_MARKETS[i]?.v2.mintFeePpm, row.ticker).toBe(row.v2.mintFeePpm);
      expect(projected[i]?.v2.mintFeePpm, row.ticker).toBe(row.v2.mintFeePpm);
      expect(projected[i]!.v2.mintFeePpm, row.ticker).toBeGreaterThan(0);
      expect(projected[i]!.v2.mintFeePpm, row.ticker).toBeLessThanOrEqual(5_000);
    });
  });

  it("gives every live market a factory and a deploy block", () => {
    const live = GENERATED_MARKETS.filter((m) => m.status === "live");
    expect(live.length).toBeGreaterThan(0);
    for (const m of live) {
      expect(m.factory, `${m.ticker} factory`).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(m.deployBlock, `${m.ticker} deployBlock`).toBeGreaterThan(0);
    }
  });

  it("has no two tickers that differ only by case (they would share a URL)", () => {
    const keys = GENERATED_MARKETS.map((m) => m.ticker.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("lib/markets.ts", () => {
  it("MARKETS is the live subset of ALL_MARKETS and every live row has a factory", () => {
    expect(ALL_MARKETS.length).toBe(GENERATED_MARKETS.length);
    expect(MARKETS.map((m) => m.ticker)).toEqual(
      GENERATED_MARKETS.filter((m) => m.status === "live").map((m) => m.ticker),
    );
    for (const m of MARKETS) {
      expect(m.factory).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(m.deployBlock).toBeGreaterThan(0);
    }
  });

  itWithRegistry("the default market is NVDA, live, on the registry's factory and Stock Token (no env override in a test run)", () => {
    expect(DEFAULT_TICKER).toBe("NVDA");
    expect(DEFAULT_MARKET.ticker).toBe("NVDA");
    const row = registry.markets.find((m) => m.ticker === "NVDA")!;
    expect(DEFAULT_MARKET.factory).toBe(getAddress(row.deployment.factory!));
    expect(DEFAULT_MARKET.asset).toBe(getAddress(row.asset));
    expect(DEFAULT_MARKET.deployBlock).toBe(row.deployment.deployBlock);
  });

  it("resolveDefaultMarket falls back to the first live market when the default is paused, and refuses an empty list", () => {
    // Synthetic rows: the committed generated file cannot carry a paused default, so the resolution
    // is exercised as the pure function DEFAULT_MARKET is built from.
    const nvda: LiveMarket = { ...DEFAULT_MARKET };
    const aapl: LiveMarket = { ...DEFAULT_MARKET, ticker: "AAPL", name: "Apple • Robinhood Token", wave: "canary" };
    const tsla: LiveMarket = { ...DEFAULT_MARKET, ticker: "TSLA", name: "Tesla • Robinhood Token", wave: "canary" };
    // Registry order is alphabetical; the default wins wherever it sits in the list.
    expect(resolveDefaultMarket([aapl, nvda, tsla], "NVDA").ticker).toBe("NVDA");
    // NVDA paused (filtered out of the live list): the first live row, in registry order.
    expect(resolveDefaultMarket([aapl, tsla], "NVDA").ticker).toBe("AAPL");
    expect(resolveDefaultMarket([tsla], "NVDA").ticker).toBe("TSLA");
    // Nothing live: a build-time failure, with the reason in the message.
    expect(() => resolveDefaultMarket([], "NVDA")).toThrow(/no market is live/);
    // The committed file resolves to the registry's live default.
    expect(resolveDefaultMarket(MARKETS, DEFAULT_TICKER)).toBe(DEFAULT_MARKET);
  });

  it("getMarket is case-insensitive and answers only for live markets", () => {
    expect(getMarket("nvda")?.ticker).toBe("NVDA");
    expect(getMarket(" NVDA ")?.ticker).toBe("NVDA");
    expect(getMarket("NvDa")?.ticker).toBe("NVDA");
    // Planned in the registry today; becomes defined once its row is live and gen:markets re-runs.
    const planned = GENERATED_MARKETS.find((m) => m.status !== "live");
    if (planned) expect(getMarket(planned.ticker)).toBeUndefined();
    expect(getMarket("XYZ")).toBeUndefined();
    expect(getMarket("")).toBeUndefined();
    expect(getMarket(undefined)).toBeUndefined();
  });

  it("marketHref lowercases the ticker and names the section", () => {
    expect(marketHref("TSLA", "account")).toBe("/tsla/account");
    expect(marketHref("nvda", "book")).toBe("/nvda/book");
  });

  it("parseTickerParam decodes, matches case-insensitively and refuses anything not live", () => {
    expect(parseTickerParam("nvda")?.ticker).toBe("NVDA");
    expect(parseTickerParam("NVDA")?.ticker).toBe("NVDA");
    expect(parseTickerParam("%6evda")?.ticker).toBe("NVDA");
    expect(parseTickerParam("xyz")).toBeUndefined();
    expect(parseTickerParam("nvda/account")).toBeUndefined();
    expect(parseTickerParam("%E0%A4%A")).toBeUndefined();
    expect(parseTickerParam(["nvda"])).toBeUndefined();
    expect(parseTickerParam(undefined)).toBeUndefined();
    expect(parseTickerParam("a".repeat(11))).toBeUndefined();
  });

  it("marketFromPathname finds the market and the section, or nothing on a non-market page", () => {
    expect(marketFromPathname("/nvda/account")).toMatchObject({ market: { ticker: "NVDA" }, section: "account" });
    expect(marketFromPathname("/NVDA/book/")).toMatchObject({ market: { ticker: "NVDA" }, section: "book" });
    expect(marketFromPathname("/nvda")).toMatchObject({ market: { ticker: "NVDA" }, section: undefined });
    expect(marketFromPathname("/nvda/other")).toMatchObject({ market: { ticker: "NVDA" }, section: undefined });
    expect(marketFromPathname("/")).toBeUndefined();
    expect(marketFromPathname("/docs")).toBeUndefined();
    expect(marketFromPathname("/vault/nvda")).toBeUndefined();
    expect(marketFromPathname("/tsla/account")).toBeUndefined();
    expect(marketFromPathname(null)).toBeUndefined();
  });

  it("plannedByWave lists every planned or paused market exactly once, in wave order, and never a live or superseded one", () => {
    const groups = plannedByWave();
    const listed = groups.flatMap((g) => g.markets.map((m) => m.ticker));
    const expected = ALL_MARKETS.filter((m) => m.status === "planned" || m.status === "paused").map((m) => m.ticker);
    expect([...listed].sort()).toEqual([...expected].sort());
    expect(new Set(listed).size).toBe(listed.length);
    const order = ["live", "canary", "wave1", "wave2"];
    const idx = groups.map((g) => order.indexOf(g.wave));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    for (const g of groups) for (const m of g.markets) expect(MARKETS.some((l) => l.ticker === m.ticker)).toBe(false);
    for (const g of groups) for (const m of g.markets) expect(m.status).not.toBe("superseded-by-v2");
  });

  it("v2Markets is every registry row in order, typed: checksummed addresses, bigint ticks on the price tick, v2 enums", () => {
    const rows = v2Markets();
    expect(rows.map((m) => m.ticker)).toEqual(GENERATED_MARKETS.map((m) => m.ticker));
    rows.forEach((m, i) => {
      const gen = GENERATED_MARKETS[i];
      expect(m.asset).toBe(getAddress(gen.asset));
      expect(m.feed).toBe(getAddress(gen.feed));
      expect(m.v2.strikeTick).toBe(BigInt(gen.v2.strikeTick));
      expect(m.v2.strikeTick > 0n && m.v2.strikeTick % 100n === 0n, `${m.ticker} strikeTick`).toBe(true);
      expect(["planned", "live", "paused"]).toContain(m.v2.status);
      expect(["canary", "wave1", "wave2"]).toContain(m.v2.wave);
      if (m.v2.univ3Pool !== null) {
        expect(m.v2.univ3Pool).toBe(getAddress(m.v2.univ3Pool));
        expect(m.v2.univ3MinLiquidity, `${m.ticker} pool floor`).not.toBeNull();
      } else expect(m.v2.univ3MinLiquidity).toBeNull();
    });
  });

  it("v1FrozenAt follows the generated row in any case, and is null for a market with no v1 factory and for an unknown ticker", () => {
    GENERATED_MARKETS.forEach((gen, i) => {
      expect(ALL_MARKETS[i]!.v1FrozenAt, gen.ticker).toBe(gen.v1FrozenAt);
      expect(v1FrozenAt(gen.ticker)).toBe(gen.v1FrozenAt);
      expect(v1FrozenAt(` ${gen.ticker.toLowerCase()} `)).toBe(gen.v1FrozenAt);
      if (gen.factory === null) expect(v1FrozenAt(gen.ticker), gen.ticker).toBeNull();
    });
    expect(v1FrozenAt("XYZ")).toBeNull();
    expect(v1FrozenAt("")).toBeNull();
  });

  itWithRegistry("v1 freeze dates are null or positive unix seconds paired with run-off", () => {
    for (const row of registry.markets) {
      const frozenAt = row.v1FrozenAt ?? null;
      expect(v1FrozenAt(row.ticker), row.ticker).toBe(frozenAt);
      if (frozenAt === null) {
        expect(row.v1RunOff ?? false, `${row.ticker} run-off requires a freeze date`).toBe(false);
      } else {
        expect(Number.isSafeInteger(frozenAt) && frozenAt > 0, `${row.ticker} freeze date`).toBe(true);
        expect(row.v1RunOff, `${row.ticker} freeze date requires run-off`).toBe(true);
        expect(row.deployment.factory, `${row.ticker} freeze date requires a v1 factory`).not.toBeNull();
      }
    }
  });

  it("v1FrozenAt returns a frozen row's unix seconds (a constructed generated row)", async () => {
    const FROZEN_AT = 1_790_000_000;
    vi.resetModules();
    vi.doMock("./markets.generated", async (importOriginal) => {
      const real = await importOriginal<{ GENERATED_MARKETS: ReadonlyArray<{ ticker: string }> }>();
      return {
        ...real,
        GENERATED_MARKETS: real.GENERATED_MARKETS.map((m) => (m.ticker === DEFAULT_TICKER ? { ...m, v1FrozenAt: FROZEN_AT } : m)),
      };
    });
    try {
      const frozen = await import("./markets");
      expect(frozen.ALL_MARKETS.find((m) => m.ticker === DEFAULT_TICKER)?.v1FrozenAt).toBe(FROZEN_AT);
      expect(frozen.v1FrozenAt(DEFAULT_TICKER)).toBe(FROZEN_AT);
      expect(frozen.v1FrozenAt(` ${DEFAULT_TICKER.toLowerCase()} `)).toBe(FROZEN_AT);
      const other = frozen.ALL_MARKETS.find((m) => m.ticker !== DEFAULT_TICKER)!;
      expect(frozen.v1FrozenAt(other.ticker)).toBeNull();
      expect(frozen.v1FrozenAt("XYZ")).toBeNull();
      // The committed module, imported before the mock, is untouched.
      expect(v1FrozenAt(DEFAULT_TICKER)).toBe(GENERATED_MARKETS.find((m) => m.ticker === DEFAULT_TICKER)!.v1FrozenAt);
    } finally {
      vi.doUnmock("./markets.generated");
      vi.resetModules();
    }
  });

  itWithRegistry("NVDA is the v2 canary on its USDG pool; isV2Live follows v2.status, any case, and is false for unknown tickers", () => {
    const nvda = v2Markets().find((m) => m.ticker === "NVDA")!;
    expect(nvda.v2.wave).toBe("canary");
    expect(nvda.v2.univ3Pool).toBe("0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3");
    for (const m of v2Markets()) {
      expect(isV2Live(m.ticker)).toBe(m.v2.status === "live");
      expect(isV2Live(m.ticker.toLowerCase())).toBe(m.v2.status === "live");
    }
    expect(isV2Live("XYZ")).toBe(false);
    expect(isV2Live("")).toBe(false);
    expect(isV2Live(undefined)).toBe(false);
  });
});
