import { describe, expect, it, vi } from "vitest";
import type { PublicClient } from "viem";
import { v2Markets } from "../markets";
import type { SeriesRef } from "./api-types";

vi.mock("./config", () => ({
  requireV2Address: (name: string) => name === "orderBook"
    ? "0x0000000000000000000000000000000000000001"
    : "0x0000000000000000000000000000000000000002",
}));

import { assertPortfolioSeries, assertPayoutPrefsMatch, assertSeriesTermsMatch, readMarketEnabledOnChain,
  readMarketSpotOnChain, readOrderPreflight, readPayoutPrefs } from "./chainReads";

describe("on-chain market enablement fallback", () => {
  it("reads the compiled market's enabled bit from the Clearinghouse", async () => {
    const asset = v2Markets().find((row) => row.ticker === "NVDA")!.asset;
    const readContract = vi.fn(async () => ({ enabled: true }));
    const client = { readContract } as unknown as PublicClient;
    await expect(readMarketEnabledOnChain("nvda", client)).resolves.toBe(true);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "market", args: [asset] }));
    readContract.mockResolvedValueOnce({ enabled: false });
    await expect(readMarketEnabledOnChain("NVDA", client)).resolves.toBe(false);
  });

  it("does not query an unknown ticker", async () => {
    const readContract = vi.fn();
    await expect(readMarketEnabledOnChain("UNKNOWN", { readContract } as unknown as PublicClient)).rejects.toThrow(/not in this app/);
    expect(readContract).not.toHaveBeenCalled();
  });
});

describe("indexer outage spot fallback", () => {
  it("reads a live registry market through SettlementOracle.spot", async () => {
    const asset = v2Markets().find((row) => row.ticker === "NVDA")!.asset;
    const readContract = vi.fn(async () => [123_000_000n, 1_700_000_000n]);
    const client = { readContract } as unknown as PublicClient;
    await expect(readMarketSpotOnChain("nvda", client)).resolves.toBe(123_000_000n);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "spot", args: [asset] }));
  });

  it("fails closed for an unknown market, a failed oracle read, or a zero price", async () => {
    const readContract = vi.fn(async () => [0n, 0n]);
    const client = { readContract } as unknown as PublicClient;
    await expect(readMarketSpotOnChain("UNKNOWN", client)).rejects.toThrow(/not in this app/);
    expect(readContract).not.toHaveBeenCalled();
    await expect(readMarketSpotOnChain("NVDA", client)).rejects.toThrow(/unavailable/);
    readContract.mockRejectedValueOnce(new Error("StaleSpot"));
    await expect(readMarketSpotOnChain("NVDA", client)).rejects.toThrow(/StaleSpot/);
  });
});

describe("on-chain order preflight", () => {
  it("pins order and write-on-fill collateral reads to the same block", async () => {
    const maker = "0x0000000000000000000000000000000000000003";
    const asset = "0x0000000000000000000000000000000000000004";
    const getBlockNumber = vi.fn(async () => 123n);
    const readContract = vi.fn(async () => [
      { maker, kind: 2 }, // AskWrite: free stock matters.
      { maker, kind: 1 }, // AskResale: stock is held in ERC-1155 escrow.
      { maker, kind: 0 }, // Bid: USDG is held in bid escrow.
    ]);
    const multicall = vi.fn(async (_input: { contracts: unknown[]; blockNumber: bigint }) => [50n]);
    const client = { getBlockNumber, readContract, multicall } as unknown as PublicClient;
    const snapshot = await readOrderPreflight([10n, 11n, 12n], asset, client);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 123n }));
    expect(multicall).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 123n }));
    expect(multicall.mock.calls[0]![0].contracts).toHaveLength(1);
    expect(snapshot.map((row) => row.freeCollateral)).toEqual([50n, null, null]);
    expect(snapshot.every((row) => row.blockNumber === 123n)).toBe(true);
  });
});

describe("on-chain option term guard", () => {
  const underlying = v2Markets().find((row) => row.ticker === "NVDA")!.asset;
  const displayed: SeriesRef = {
    longId: "2", shortId: "3", ticker: "NVDA", underlying, isPut: false,
    strike: { raw: "210000000", decimals: 6, formatted: "210" }, expiry: 1_800_000_000,
    mintFeePpm: 1200, mintFeesHeld: { raw: "0", decimals: 18, formatted: "0" }, mintFeesAccrued: { raw: "0", decimals: 18, formatted: "0" }, tenor: "weekly", mintCutoff: 1_799_998_200, status: "open",
  };
  const chain = {
    underlying, isPut: false, expiry: 1_800_000_000, strike: 210_000_000n,
    oracle: "0x0000000000000000000000000000000000000001", exerciseFeeBps: 25,
    mintFeePpm: 1200, mintFeesHeld: 0n, settled: false, settlementPrice: 0n, longPayoutPerUnit: 0n, feePerUnit: 0n, shortPayoutPerUnit: 0n,
  } as Parameters<typeof assertSeriesTermsMatch>[1];

  it("accepts a displayed series matching the compiled market and chain", () => {
    expect(() => assertSeriesTermsMatch(displayed, chain, "NVDA", 25)).not.toThrow();
  });

  it("stops a trade when the API misstates a real series' payoff, expiry, fee, or ticker", () => {
    const reject = (shown: SeriesRef, onChain = chain, ticker = "NVDA", fee = 25) =>
      expect(() => assertSeriesTermsMatch(shown, onChain, ticker, fee)).toThrow(/Option terms differ/);
    reject({ ...displayed, strike: { ...displayed.strike, raw: "220000000" } });
    reject({ ...displayed, isPut: true });
    reject({ ...displayed, mintFeePpm: 5000 });
    reject({ ...displayed, shortId: "5" });
    reject({ ...displayed, expiry: displayed.expiry + 86_400 });
    reject({ ...displayed, ticker: "TSLA" });
    reject(displayed, chain, "TSLA");
    reject(displayed, chain, "NVDA", 100);
  });

  it("checks the on-chain series before replacing an order or collecting a position", async () => {
    const multicall = vi.fn(async () => [true, chain, 1_799_998_200, 1n]);
    const client = { multicall, getBlockNumber: vi.fn(async () => 123n), getBlock: vi.fn(async () => ({ timestamp: 1_799_000_000n })) } as unknown as PublicClient;
    await expect(assertPortfolioSeries(displayed, client)).resolves.toBeUndefined();
    await expect(assertPortfolioSeries({ ...displayed, isPut: true }, client)).rejects.toThrow(/Option terms differ/);
    await expect(assertPortfolioSeries({ ...displayed, shortId: "5" }, client)).rejects.toThrow(/Option terms differ/);
    multicall.mockResolvedValueOnce([false, chain, 1_799_998_200, 1n]);
    await expect(assertPortfolioSeries(displayed, client)).rejects.toThrow(/no longer on chain/);
  });
});

describe("on-chain payout preference guard", () => {
  it("reads the actual Clearinghouse preference and rejects a stale displayed choice", async () => {
    const account = "0x0000000000000000000000000000000000000003";
    const readContract = vi.fn(async () => [true, true] as const);
    const client = { readContract } as unknown as PublicClient;
    const current = await readPayoutPrefs(account, client);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "payoutPrefs", args: [account] }));
    expect(current).toEqual({ inKind: true, toLedger: true });
    expect(() => assertPayoutPrefsMatch({ inKind: false, toLedger: true }, current)).toThrow(/changed/);
    expect(() => assertPayoutPrefsMatch({ inKind: true, toLedger: false }, current)).toThrow(/changed/);
    expect(() => assertPayoutPrefsMatch(current, current)).not.toThrow();
  });
});
