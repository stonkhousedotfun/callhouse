/**
 * The DISPLAY price fallback (lib/v2/displaySpot.ts). The chain is read through injected readers and an
 * injected RPC here, so no test touches the network.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  MAX_FEED_AGE_S,
  MEMO_S,
  chainSources,
  chainlinkPrice,
  displaySourceLine,
  parseDisplaySpots,
  pickDisplaySpot,
  poolPrice,
  poolPriceUsdg6,
  resetDisplayCache,
  resolveDisplaySpot,
  toUsdg6,
  usdgDollars,
  type ChainSource,
  type Readers,
  type Rpc,
} from "./displaySpot";

const NOW = 1_790_223_000; // Thu 2026-09-24 04:10 UTC
const SOURCE: ChainSource = { feed: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15", pool: "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3", stockIsToken0: false };
const SOURCES = { NVDA: SOURCE };

function readers(o: { chainlink?: bigint | null | "throw"; pool?: bigint | null; now?: number } = {}): Readers {
  return {
    chainlink: async () => {
      if (o.chainlink === "throw") throw new Error("rpc down");
      return o.chainlink ? { raw: o.chainlink, updatedAt: NOW - 11 * 3600 } : null;
    },
    pool: async (_source, now) => (o.pool ? { raw: o.pool, updatedAt: now } : null),
    now: () => o.now ?? NOW,
  };
}

const word = (value: bigint) => (value < 0n ? (1n << 256n) + value : value).toString(16).padStart(64, "0");

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

beforeEach(() => resetDisplayCache());

describe("the fallback chain, in order", () => {
  it("uses the API spot when it has one, and does not read the chain", async () => {
    let asked = false;
    const r = readers({ chainlink: 999_000_000n });
    r.chainlink = async () => { asked = true; return null; };
    const spot = await resolveDisplaySpot("NVDA", { raw: 225_549_701n, updatedAt: NOW - 60 }, r, SOURCES);
    expect(spot).toEqual({ raw: 225_549_701n, updatedAt: NOW - 60, source: "api" });
    expect(asked, "the chain must not be read when the API has a price").toBe(false);
  });

  it("API null -> the Chainlink feed", async () => {
    expect(await resolveDisplaySpot("NVDA", null, readers({ chainlink: 225_000_000n, pool: 226_000_000n }), SOURCES))
      .toEqual({ raw: 225_000_000n, updatedAt: NOW - 11 * 3600, source: "chainlink" });
  });

  it("Chainlink failed (null or throwing) -> the pool", async () => {
    expect((await resolveDisplaySpot("NVDA", null, readers({ chainlink: null, pool: 226_000_000n }), SOURCES))?.source).toBe("pool");
    resetDisplayCache();
    expect(await resolveDisplaySpot("NVDA", null, readers({ chainlink: "throw", pool: 226_000_000n }), SOURCES))
      .toEqual({ raw: 226_000_000n, updatedAt: NOW, source: "pool" });
  });

  it("everything failing -> the last good price, marked cached, with the time it was true", async () => {
    await resolveDisplaySpot("NVDA", null, readers({ chainlink: 225_000_000n }), SOURCES);
    const later = NOW + MEMO_S + 1; // past the reuse window, so the chain is asked again and fails
    expect(await resolveDisplaySpot("NVDA", null, readers({ now: later }), SOURCES))
      .toEqual({ raw: 225_000_000n, updatedAt: NOW - 11 * 3600, source: "cached" });
  });

  it("nothing has ever priced the market -> null, and a market with no chain source is never read", async () => {
    expect(await resolveDisplaySpot("NVDA", null, readers(), SOURCES)).toBeNull();
    expect(await resolveDisplaySpot("TSLA", null, readers({ chainlink: 1n }), SOURCES)).toBeNull();
  });

  it("reuses a chain read for MEMO_S seconds", async () => {
    await resolveDisplaySpot("NVDA", null, readers({ chainlink: 225_000_000n }), SOURCES);
    expect((await resolveDisplaySpot("NVDA", null, readers({ now: NOW + MEMO_S - 1 }), SOURCES))?.source).toBe("chainlink");
  });
});

describe("units", () => {
  it("scales a feed answer to USDG 6 dp and 6 dp to dollars", () => {
    expect(toUsdg6(22_554_970_100n, 8)).toBe(225_549_701n); // an 8-decimal Chainlink answer
    expect(toUsdg6(225_549_701n, 6)).toBe(225_549_701n);
    expect(toUsdg6(0n, 8)).toBeNull();
    expect(toUsdg6(-1n, 8)).toBeNull();
    expect(usdgDollars(225_549_701n)).toBe("225.54"); // floored to the cent
    expect(usdgDollars(148_774_050n)).toBe("148.77");
    expect(usdgDollars(5n)).toBe("0.00");
  });

  it("reads a v3 pool price either way round (Stock Token 18 dp, USDG 6 dp)", () => {
    const price = 225_550_000n; // USDG 6 dp per share
    // token0 = Stock: raw = token1/token0 = price / 1e18 per base unit; sqrtPriceX96 = sqrt(raw * 2^192).
    const stock0 = isqrt((price << 192n) / 10n ** 18n);
    expect(Number(poolPriceUsdg6(stock0, true)! - price)).toBeLessThanOrEqual(1);
    expect(Number(price - poolPriceUsdg6(stock0, true)!)).toBeLessThanOrEqual(1);
    // token0 = USDG: raw = token1/token0 = 1e18 / price.
    const usdg0 = isqrt((10n ** 18n << 192n) / price);
    const got = poolPriceUsdg6(usdg0, false)!;
    expect(got > price - 2n && got < price + 2n).toBe(true);
    expect(poolPriceUsdg6(0n, true)).toBeNull();
  });

  it("decodes latestRoundData, and refuses a feed older than 26 h", async () => {
    const rpcAt = (updatedAt: number): Rpc => async (_to, data) => data === "0x313ce567"
      ? `0x${word(8n)}`
      : `0x${word(1n)}${word(22_554_970_100n)}${word(BigInt(updatedAt))}${word(BigInt(updatedAt))}${word(1n)}`;
    expect(await chainlinkPrice(SOURCE.feed, NOW, rpcAt(NOW - 3600))).toEqual({ raw: 225_549_701n, updatedAt: NOW - 3600 });
    expect(await chainlinkPrice(SOURCE.feed, NOW, rpcAt(NOW - MAX_FEED_AGE_S - 1))).toBeNull();
    expect(await chainlinkPrice(SOURCE.feed, NOW, async () => null)).toBeNull();
  });

  it("the pool read masks slot0 to 160 bits, and a market without a pool is not read", async () => {
    const sqrt = isqrt((10n ** 18n << 192n) / 225_550_000n);
    const rpc: Rpc = async () => `0x${word(sqrt | (123n << 160n))}${word(1n)}`; // tick bits above the price
    expect((await poolPrice(SOURCE, NOW, rpc))?.updatedAt).toBe(NOW);
    expect(await poolPrice({ ...SOURCE, pool: null }, NOW, rpc)).toBeNull();
  });
});

describe("the registry, never typed in", () => {
  it("takes feed and pool from the compiled registry and derives the pool's token order from the addresses", () => {
    const sources = chainSources();
    expect(sources.NVDA?.feed).toBe("0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15");
    expect(sources.NVDA?.pool).toBe("0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3");
    // USDG 0x5fc5... sorts below NVDA 0xd060... (Stock is token1) and above SPCX 0x4a0E... (Stock is token0).
    expect(sources.NVDA?.stockIsToken0).toBe(false);
    expect(sources.SPCX?.stockIsToken0).toBe(true);
  });
});

describe("the client side", () => {
  it("parses the route's rows and drops malformed ones", () => {
    const map = parseDisplaySpots({ items: [
      { ticker: "NVDA", raw: "225549701", updatedAt: NOW - 39_600, source: "chainlink" },
      { ticker: "SPCX", raw: "0", updatedAt: NOW, source: "pool" },
      { ticker: "BAD", raw: "1.5", updatedAt: NOW, source: "api" },
      { ticker: "ODD", raw: "1", updatedAt: NOW, source: "oracle" },
    ] });
    expect([...map.keys()]).toEqual(["NVDA"]);
    expect(map.get("NVDA")).toEqual({ raw: 225_549_701n, updatedAt: NOW - 39_600, source: "chainlink" });
    expect(parseDisplaySpots(null).size).toBe(0);
  });

  it("prefers the page's own API spot; otherwise the fallback row", () => {
    const fallback = { raw: 225_000_000n, updatedAt: NOW - 3600, source: "chainlink" as const };
    expect(pickDisplaySpot("225549701", NOW, fallback)).toEqual({ raw: 225_549_701n, updatedAt: NOW, source: "api" });
    expect(pickDisplaySpot(null, null, fallback)).toBe(fallback);
    expect(pickDisplaySpot(undefined, undefined, undefined)).toBeNull();
  });

  it("says where the price came from and how old it is, in plain words, in the zone it is given", () => {
    const NY = "America/New_York";
    const LA = "America/Los_Angeles";
    // 1790186399 = Wed 2026-09-23 17:59:59 UTC, the NVDA print the dev indexer served on 2026-09-24.
    expect(displaySourceLine({ raw: 1n, updatedAt: 1_790_186_399, source: "chainlink" }, NOW, NY))
      .toBe("last close price, updated Sep 23, 1:59 PM EDT");
    expect(displaySourceLine({ raw: 1n, updatedAt: NOW - 120, source: "chainlink" }, NOW, NY)).toBe("updated 12:08 AM EDT");
    expect(displaySourceLine({ raw: 1n, updatedAt: NOW, source: "pool" }, NOW, NY)).toBe("pool price, updated 12:10 AM EDT");
    expect(displaySourceLine({ raw: 1n, updatedAt: 1_790_186_399, source: "cached" }, NOW, NY))
      .toBe("last known price, updated Sep 23, 1:59 PM EDT");
    // The same instants for a reader in Los Angeles. The zone is the caller's, never the process's.
    expect(displaySourceLine({ raw: 1n, updatedAt: 1_790_186_399, source: "chainlink" }, NOW, LA))
      .toBe("last close price, updated Sep 23, 10:59 AM PDT");
    expect(displaySourceLine({ raw: 1n, updatedAt: NOW, source: "pool" }, NOW, LA)).toBe("pool price, updated 9:10 PM PDT");
    // No UTC line for any source, fresh or old, in either zone.
    for (const source of ["api", "chainlink", "pool", "cached"] as const) {
      for (const updatedAt of [NOW - 120, 1_790_186_399]) {
        for (const zone of [NY, LA]) expect(displaySourceLine({ raw: 1n, updatedAt, source }, NOW, zone)).not.toContain("UTC");
      }
    }
  });

  it("before the clock is read (now 0) the age is unknown, so no api or Chainlink line reads as current", () => {
    const NY = "America/New_York";
    // A two-day-old Chainlink print, which before the fix read "updated 1:59 PM EDT": its age measured against 0.
    expect(displaySourceLine({ raw: 1n, updatedAt: 1_790_186_399, source: "chainlink" }, 0, NY)).toBe("updated Sep 23, 1:59 PM EDT");
    expect(displaySourceLine({ raw: 1n, updatedAt: 1_790_186_399, source: "api" }, 0, NY)).toBe("updated Sep 23, 1:59 PM EDT");
    // A recent one is dated too: with no clock, nothing says it is fresh, and nothing calls it the last close.
    expect(displaySourceLine({ raw: 1n, updatedAt: NOW - 120, source: "chainlink" }, 0, NY)).toBe("updated Sep 24, 12:08 AM EDT");
    // Pool and cached lines never depended on the clock.
    expect(displaySourceLine({ raw: 1n, updatedAt: NOW, source: "pool" }, 0, NY)).toBe("pool price, updated 12:10 AM EDT");
    expect(displaySourceLine({ raw: 1n, updatedAt: 1_790_186_399, source: "cached" }, 0, NY))
      .toBe("last known price, updated Sep 23, 1:59 PM EDT");
  });
});
