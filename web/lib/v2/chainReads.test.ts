import { describe, expect, it, vi } from "vitest";
import { ContractFunctionRevertedError, decodeFunctionResult, encodeAbiParameters, encodeErrorResult, parseAbiParameters, type Abi, type Hex,
  type PublicClient } from "viem";
import { earnVaultAbi } from "../abi/v2/earnVault";
import { v2Markets } from "../markets";
import type { SeriesRef } from "./api-types";

vi.mock("./config", () => ({
  requireV2Address: (name: string) => name === "orderBook"
    ? "0x0000000000000000000000000000000000000001"
    : "0x0000000000000000000000000000000000000002",
  v2ContractAddress: (name: string) => name === "settlementOracle" ? "0x0000000000000000000000000000000000000003" : null,
}));

import { assertPortfolioSeries, assertPayoutPrefsMatch, assertSeriesTermsMatch, EARN_QUOTE_SHARES, readEarnVault, readHouseVault,
  readAccountOnChain, readAllowances, readMarketEnabledOnChain, readMarketSpotOnChain, readOrderPreflight, readPayoutPrefs, readSeriesOnChain, readSplitter,
  revertErrorName, venueUnreadableOf } from "./chainReads";
import { advancingHeadClient } from "./testing/advancingHead";

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
    const multicall = vi.fn(async (_input: { contracts: unknown[]; blockNumber: bigint }) => [50n, false]);
    const client = { getBlockNumber, readContract, multicall } as unknown as PublicClient;
    const snapshot = await readOrderPreflight([10n, 11n, 12n], asset, client);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 123n }));
    expect(multicall).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 123n }));
    // Two reads per write ask, free Stock Tokens and Clearinghouse.isOperator(maker, book).
    const contracts = multicall.mock.calls[0]![0].contracts as { functionName: string; args: readonly unknown[] }[];
    expect(contracts.map((c) => c.functionName)).toEqual(["free", "isOperator"]);
    expect(contracts[1]!.args).toEqual([maker, "0x0000000000000000000000000000000000000001"]); // the mocked orderBook
    expect(snapshot.map((row) => row.freeCollateral)).toEqual([50n, null, null]);
    // Only a write ask carries it; a resale ask and a bid never read it (null, not unchecked-as-true).
    expect(snapshot.map((row) => row.writerIsOperator)).toEqual([false, null, null]);
    expect(snapshot.every((row) => row.blockNumber === 123n)).toBe(true);
  });

  it("re-reads the head on every preflight instead of viem's 4-second cached block number", async () => {
    const maker = "0x0000000000000000000000000000000000000003";
    const readContract = vi.fn(async () => [{ maker, kind: 0 }]);
    const client = advancingHeadClient(123n, { readContract });
    expect((await readOrderPreflight([10n], maker, client)).map((row) => row.blockNumber)).toEqual([123n]);
    // A cancel-and-replace lands in block 124; the take's preflight right after must see it.
    expect((await readOrderPreflight([10n], maker, client)).map((row) => row.blockNumber)).toEqual([124n]);
    expect(readContract).toHaveBeenLastCalledWith(expect.objectContaining({ blockNumber: 124n }));
    // A caller-pinned block is still honoured and costs no head read.
    expect((await readOrderPreflight([10n], maker, client, 99n)).map((row) => row.blockNumber)).toEqual([99n]);
    expect((await readOrderPreflight([10n], maker, client)).map((row) => row.blockNumber)).toEqual([125n]);
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

  it("reads the series at the new head, not viem's 4-second cached block number", async () => {
    const multicall = vi.fn(async () => [true, chain, 1_799_998_200, 1n]);
    const client = advancingHeadClient(123n, { multicall, getBlock: vi.fn(async () => ({ timestamp: 1_799_000_000n })) });
    expect((await readSeriesOnChain(2n, client)).blockNumber).toBe(123n);
    expect((await readSeriesOnChain(2n, client)).blockNumber).toBe(124n);
    expect(multicall).toHaveBeenLastCalledWith(expect.objectContaining({ blockNumber: 124n }));
    expect((await readSeriesOnChain(2n, client, 99n)).blockNumber).toBe(99n);
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

/**
 * Vault reads. The rule every page block depends on: a failed read is null, never 0. A fee rendered as
 * "0.00 %" because the RPC failed would be a false statement that looks exactly like the true one.
 */
describe("vault page reads", () => {
  const vault = "0x0000000000000000000000000000000000000066" as const;
  const account = "0x0000000000000000000000000000000000000044" as const;
  const ok = (result: unknown) => ({ status: "success" as const, result });
  const fail = { status: "failure" as const, error: new Error("reverted") };

  // weekly() is not among the calls. The launch vaults have no such view; the cadence is the API's `kind`.
  it("House: maps each call in order, and never calls weekly()", async () => {
    const multicall = vi.fn(async (_request: unknown) => [
      ok(1_000_000n), ok(10n ** 18n), ok(0), ok(2000), ok(1_034_200n), ok("0x00000000000000000000000000000000000000aa"),
      ok("0x00000000000000000000000000000000000000bb"), ok(178_420_000n), ok({ maxSeriesUnits: 10_000n }), ok(5n), ok(true),
      ok(250_000n), ok(12n), ok([11n, 3n]), ok([12n, 4_000_000n, 0n]), ok(1_800), ok(1_000), ok([0n, 7_000_000n, 5n]),
      ok(1_790_020_800), ok(4_000_000n), ok(0n),
    ]);
    const r = await readHouseVault(vault, account, { multicall } as unknown as PublicClient);
    // The staged (configured) rate and the rate in force are two reads; here 0 is configured, 1000 in force.
    expect(r).toMatchObject({ nav: 1_000_000n, totalSupply: 10n ** 18n, performanceFeeBps: 0, epochPerformanceFeeBps: 1_000, performanceFeeCeilBps: 2000,
      highWaterMark: 1_034_200n, lastSettlementPrice: 178_420_000n, balance: 5n, protocolAccountsConfirmed: true,
      performanceFeeOwed: 250_000n, epochId: 12n, withdrawRequest: { epochId: 11n, shares: 3n },
      depositRequest: { epochId: 12n, usdg: 4_000_000n, stock: 0n }, settlementWindow: 1_800,
      // claimable(account), the vault's own quote, passed through as (shares, usdg, stock).
      claimable: { shares: 0n, usdg: 7_000_000n, stock: 5n },
      // The boundary the vault locked, and the queued deposits that expose the running boundary.
      pinnedBoundary: 1_790_020_800, pendingDeposit: { usdg: 4_000_000n, stock: 0n } });
    expect(r).not.toHaveProperty("cadence");
    const calls = (multicall.mock.calls[0]![0] as { contracts: { functionName: string; address: string }[] }).contracts;
    expect(calls.map((x) => x.functionName)).toEqual(["nav", "totalSupply", "performanceFeeBps", "PERFORMANCE_FEE_CEIL_BPS",
      "highWaterMark", "splitter", "oracle", "lastSettlementPrice", "limits", "balanceOf", "protocolAccountsConfirmed",
      "performanceFeeOwed", "epochId", "withdrawRequestOf", "depositRequestOf", "SETTLEMENT_WINDOW", "epochPerformanceFeeBps",
      "claimable", "pinnedBoundary", "pendingDepositUsdg", "pendingDepositStock"]);
    // The two request reads are for THIS account, like balanceOf. So is the claim quote.
    for (const name of ["balanceOf", "withdrawRequestOf", "depositRequestOf", "claimable"])
      expect((calls.find((x) => x.functionName === name) as unknown as { args: unknown[] }).args).toEqual([account]);
    // The arming is read on the vault passed in -- the one the deposit writes to -- not a registry vault.
    // Every vault fact is; only the compiled SETTLEMENT_WINDOW constant is read from the registry's oracle.
    expect(calls.filter((x) => x.functionName !== "SETTLEMENT_WINDOW").every((x) => x.address === vault)).toBe(true);
    expect(calls.find((x) => x.functionName === "SETTLEMENT_WINDOW")!.address).toBe("0x0000000000000000000000000000000000000003");
  });

  it("House: a failed fee read is null, not 0; no account means no balance", async () => {
    const multicall = vi.fn(async (_request: unknown) => [fail, ok(0n), fail, ok(2000), fail, fail, fail, fail, fail, ok(9n), ok(false), ok(0n),
      ok(12n), ok([11n, 3n]), ok([0n, 0n, 0n]), fail, fail, ok([1n, 2n, 3n]), fail, ok(0n), fail]);
    const r = await readHouseVault(vault, undefined, { multicall } as unknown as PublicClient);
    expect(r.nav).toBeNull();
    expect(r.settlementWindow).toBeNull(); // An unread window is unknown, never 0 (0 would open the queue)
    expect(r.performanceFeeBps).toBeNull();
    expect(r.epochPerformanceFeeBps).toBeNull();
    expect(r.balance).toBeNull();
    expect(r.protocolAccountsConfirmed).toBe(false);
    expect(r.performanceFeeOwed).toBe(0n); // 0 owed is a read 0, kept as 0
    // balanceOf is still sent (fixed call shape, zero address) but its result is dropped without an account.
    // So are the two request reads; without an account they are null, never someone else's request.
    expect(r.withdrawRequest).toBeNull();
    expect(r.depositRequest).toBeNull();
    expect(r.epochId).toBe(12n);
    // The claim quote is dropped the same way: it is the zero address's, not this page's.
    expect(r.claimable).toBeNull();
    // A failed pinnedBoundary (an older vault) is unknown, never 0; one failed pending read
    // leaves the pending deposits unknown, never "nothing queued".
    expect(r.pinnedBoundary).toBeNull();
    expect(r.pendingDeposit).toBeNull();
    // + epochPerformanceFeeBps; + claimable; + pinnedBoundary, pendingDepositUsdg/Stock.
    expect((multicall.mock.calls[0]![0] as { contracts: unknown[] }).contracts).toHaveLength(21);
  });

  it("House: a failed arming read is null, never false-as-armed and never true", async () => {
    const multicall = vi.fn(async (_request: unknown) => [ok(0n), ok(0n), ok(0), ok(2000), ok(0n), fail, fail, ok(0n), fail, ok(0n), fail, fail,
      ok(1n), ok([0n, 0n]), ok([0n, 0n, 0n]), ok(1_800), ok(0), fail, fail, fail, fail]);
    const r = await readHouseVault(vault, undefined, { multicall } as unknown as PublicClient);
    expect(r.protocolAccountsConfirmed).toBeNull();
    expect(r.performanceFeeOwed).toBeNull(); // A failed owed-fee read is unknown, never 0
  });

  // The claim button's reads. A failed call is null (unknown), never a zero request that reads as "nothing".
  it("House: failed epoch or request reads are null, never a zero request", async () => {
    const multicall = vi.fn(async (_request: unknown) => [ok(0n), ok(0n), ok(0), ok(2000), ok(0n), fail, fail, ok(0n), fail, ok(0n), ok(true),
      ok(0n), fail, fail, fail, ok(1_800), ok(0), fail, fail, fail, fail]);
    const r = await readHouseVault(vault, account, { multicall } as unknown as PublicClient);
    expect(r.epochId).toBeNull();
    expect(r.withdrawRequest).toBeNull();
    expect(r.depositRequest).toBeNull();
    // A failed quote (or a vault from before which has no claimable) is unknown, never (0, 0, 0).
    expect(r.claimable).toBeNull();
  });

  // (0, 0, 0) is a real answer -- a matured request that priced to zero -- and is kept, not turned into null.
  it("House: a zero claim quote is kept as zeros for an account", async () => {
    const multicall = vi.fn(async (_request: unknown) => [ok(0n), ok(0n), ok(0), ok(2000), ok(0n), fail, fail, ok(0n), fail, ok(0n), ok(true),
      ok(0n), ok(12n), ok([11n, 3n]), ok([0n, 0n, 0n]), ok(1_800), ok(0), ok([0n, 0n, 0n]), fail, fail, fail]);
    const r = await readHouseVault(vault, account, { multicall } as unknown as PublicClient);
    expect(r.claimable).toEqual({ shares: 0n, usdg: 0n, stock: 0n });
  });

  it("Earn: open position leaves the flat-path reads null and keeps the indicative marks", async () => {
    const multicall = vi.fn(async (_request: unknown) => [ok(true), fail, fail, ok(1_004_000n), ok(10_040_000_000n), ok(10n ** 22n), ok(0), ok(1000),
      ok(1_000_000n), ok("0x0000000000000000000000000000000000000000"), ok("0x00000000000000000000000000000000000000aa"), ok(7n), ok(18)]);
    const r = await readEarnVault(vault, undefined, { multicall } as unknown as PublicClient);
    expect(r).toMatchObject({ hasOpenPosition: true, shareDecimals: 18, assetsPerShare: null, totalAssets: null,
      indicativeAssetsPerShare: 1_004_000n, totalSupply: 10n ** 22n, skimBps: 0, skimCeilBps: 1000, balance: null });
  });

  /**
   * The per-share figures are per WHOLE share at the vault's own `decimals()`, never at an assumed 18. The
   * vault quotes them per EARN_QUOTE_SHARES (its compiled ONE_SHARE); the page re-expresses them per `10 ** decimals`.
   * RED if the decimals read is dropped or the unit is hard-coded to 1e18 again: the 6-dp case below would then show
   * one share as 1e12 USDG, the defect fixed on the contract side.
   */
  it("Earn: per-share figures follow decimals(); an unread decimals() shows no price at all", async () => {
    const reads = (decimals: ReturnType<typeof ok> | typeof fail) => vi.fn(async (_request: unknown) => [ok(false), ok(10n ** 18n),
      ok(100_000_000n), ok(10n ** 18n), ok(100_000_000n), ok(10n ** 14n), ok(0), ok(1000), ok(10n ** 18n),
      ok("0x0000000000000000000000000000000000000000"), ok("0x00000000000000000000000000000000000000aa"), ok(5n * 10n ** 13n), decimals]);
    // A 6-dp share at 1 USDG a share: EARN_QUOTE_SHARES (1e18 base units) is 1e12 whole shares, worth 1e18 USDG base units.
    const six = reads(ok(6));
    const r6 = await readEarnVault(vault, account, { multicall: six } as unknown as PublicClient);
    expect(r6).toMatchObject({ shareDecimals: 6, assetsPerShare: 1_000_000n, indicativeAssetsPerShare: 1_000_000n, highWaterMark: 1_000_000n });
    const call = (six.mock.calls[0]![0] as { contracts: { functionName: string; args?: unknown[] }[] }).contracts;
    expect(call.find((c) => c.functionName === "convertToAssets")!.args).toEqual([EARN_QUOTE_SHARES]);
    // This vault: 18 decimals, the quote unit IS one whole share, so the figures pass through unchanged.
    const r18 = await readEarnVault(vault, account, { multicall: reads(ok(18)) } as unknown as PublicClient);
    expect(r18).toMatchObject({ shareDecimals: 18, assetsPerShare: 10n ** 18n, highWaterMark: 10n ** 18n });
    const unread = await readEarnVault(vault, account, { multicall: reads(fail) } as unknown as PublicClient);
    expect(unread).toMatchObject({ shareDecimals: null, assetsPerShare: null, indicativeAssetsPerShare: null, highWaterMark: null,
      totalAssets: 100_000_000n, balance: 5n * 10n ** 13n });
  });

  // convertToAssets reverting VenueUnreadable() means the venue cannot be read and nothing is
  // priced. The revert is decoded by name against the generated ABI, as viem does on chain.
  it("Earn: convertToAssets reverting VenueUnreadable reads as venueUnreadable; any other failure is unknown", async () => {
    const revert = (errorName: "VenueUnreadable" | "PositionOpen") => ({ status: "failure" as const, error: new ContractFunctionRevertedError({
      abi: earnVaultAbi, data: encodeErrorResult({ abi: earnVaultAbi, errorName }), functionName: "convertToAssets" }) });
    expect(encodeErrorResult({ abi: earnVaultAbi, errorName: "VenueUnreadable" })).toBe("0x5e6660df");
    // decimals() last, after the ten reads that follow the probe.
    const rest = [ok(0n), ok(1_004_000n), ok(10_040_000_000n), ok(10n ** 22n), ok(0), ok(1000), ok(1_000_000n),
      ok("0x0000000000000000000000000000000000000000"), ok("0x00000000000000000000000000000000000000aa"), ok(7n), ok(18)];
    const read = async (probe: unknown) => readEarnVault(vault, undefined,
      { multicall: vi.fn(async (_request: unknown) => [ok(false), probe, ...rest]) } as unknown as PublicClient);
    expect(await read(revert("VenueUnreadable"))).toMatchObject({ venueUnreadable: true, assetsPerShare: null });
    expect((await read(ok(1_002_000n))).venueUnreadable).toBe(false);
    expect((await read(revert("PositionOpen"))).venueUnreadable).toBeNull();
    expect((await read(fail)).venueUnreadable).toBeNull();
    expect(revertErrorName(new Error("plain"))).toBeNull();
    expect(venueUnreadableOf(revert("VenueUnreadable"))).toBe(true);
  });

  // The hero's empty-vault state is keyed on this read, so its place in the call list is pinned.
  it("Earn: maps each call in order, totalSupply included; 0 is kept as 0 and a failed read is null", async () => {
    const empty = vi.fn(async (_request: unknown) => [ok(false), ok(0n), ok(0n), ok(0n), ok(0n), ok(0n), ok(0), ok(1000), ok(0n),
      ok("0x0000000000000000000000000000000000000000"), ok("0x00000000000000000000000000000000000000aa"), ok(0n), ok(18)]);
    const r = await readEarnVault(vault, account, { multicall: empty } as unknown as PublicClient);
    expect(r).toMatchObject({ hasOpenPosition: false, assetsPerShare: 0n, totalAssets: 0n, totalSupply: 0n, balance: 0n });
    const calls = (empty.mock.calls[0]![0] as { contracts: { functionName: string }[] }).contracts.map((x) => x.functionName);
    expect(calls).toEqual(["hasOpenPosition", "convertToAssets", "totalAssets", "indicativeAssetsPerShare", "indicativeTotalAssets",
      "totalSupply", "skimBps", "SKIM_BPS_CEIL", "highWaterMark", "adapter", "splitter", "balanceOf", "decimals"]);
    const failed = vi.fn(async (_request: unknown) => [ok(false), ok(0n), ok(0n), ok(0n), ok(0n), fail, ok(0), ok(1000), ok(0n),
      ok("0x0000000000000000000000000000000000000000"), ok("0x00000000000000000000000000000000000000aa"), ok(0n), ok(18)]);
    expect((await readEarnVault(vault, account, { multicall: failed } as unknown as PublicClient)).totalSupply).toBeNull();
  });

  it("Splitter: burnBps as a number, null on failure", async () => {
    const good = vi.fn(async (_request: unknown) => [ok(5000), ok("0x00000000000000000000000000000000000000cc")]);
    await expect(readSplitter(vault, { multicall: good } as unknown as PublicClient)).resolves.toEqual({
      burnBps: 5000, treasury: "0x00000000000000000000000000000000000000cc" });
    const bad = vi.fn(async (_request: unknown) => [fail, fail]);
    await expect(readSplitter(vault, { multicall: bad } as unknown as PublicClient)).resolves.toEqual({ burnBps: null, treasury: null });
  });
});

/**
 * For a MATURED deposit, readHouseVault asks `epochRates(depositRequest.epochId)` whether its close REFUSED the
 * batch (`depositRefused`, the SECOND field of the tuple). The rates below are ABI-encoded here from the layout
 * The contracts shipped, independently of the app's ABI module, and decoded through that module (the fake client decodes with
 * the ABI readHouseVault passes it): a module left on the old layout decodes them wrongly and these go red.
 */
describe("House: a matured deposit's refusal flag, from epochRates", () => {
  const vault = "0x0000000000000000000000000000000000000066" as const;
  const account = "0x0000000000000000000000000000000000000044" as const;
  const ok = (result: unknown) => ({ status: "success" as const, result });
  const fail = { status: "failure" as const, error: new Error("reverted") };
  /** HouseVault.EpochRates as the contract lays it out (HouseVault.sol struct EpochRates). */
  const rates = (refused: boolean, depositValue: bigint, depositShares: bigint) => encodeAbiParameters(
    parseAbiParameters("uint128, bool, uint256, uint256, uint256, uint256, uint256, uint256"),
    [178_420_000n, refused, depositValue, depositShares, 1n, 0n, 0n, 0n],
  );
  /**
   * The 21-call multicall with epochId 12 and this account's deposit request. The last three calls
   * (pinnedBoundary, pendingDepositUsdg/Stock) fail here: these tests judge only the refusal flag.
   */
  const multicall = (deposit: readonly [bigint, bigint, bigint], epoch: ReturnType<typeof ok> | typeof fail = ok(12n)) =>
    vi.fn(async (_request: unknown) => [ok(0n), ok(0n), ok(0), ok(2000), ok(0n), fail, fail, ok(0n), fail, ok(0n), ok(true),
      ok(0n), epoch, ok([0n, 0n]), ok(deposit), ok(1_800), ok(0), ok([0n, 12_340_000n, 0n]), fail, fail, fail]);
  const decoding = (data: Hex) => vi.fn(async (req: { abi: Abi; functionName: string }) =>
    decodeFunctionResult({ abi: req.abi, functionName: req.functionName, data }));

  it("a refused batch reads true, from the deposit's own epoch", async () => {
    const readContract = decoding(rates(true, 12_340_000n, 0n));
    const r = await readHouseVault(vault, account, { multicall: multicall([11n, 12_340_000n, 0n]), readContract } as unknown as PublicClient);
    expect(r.depositRefused).toBe(true);
    expect(readContract).toHaveBeenCalledTimes(1);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ address: vault, functionName: "epochRates", args: [11n] }));
  });

  // The case: a PRICED batch whose shares earlier claimants ran down to zero. depositShares == 0 is not a refusal.
  it("a priced batch run down to zero shares reads false, not refused", async () => {
    const readContract = decoding(rates(false, 5n, 0n));
    const r = await readHouseVault(vault, account, { multicall: multicall([11n, 0n, 1n]), readContract } as unknown as PublicClient);
    expect(r.depositRefused).toBe(false);
  });

  it("no matured deposit, no read: this epoch's deposit, an empty slot, no account, an unread epoch", async () => {
    for (const [deposit, who, epoch] of [
      [[12n, 12_340_000n, 0n], account, ok(12n)], // queued this epoch: not matured
      [[11n, 0n, 0n], account, ok(12n)], // nothing queued
      [[11n, 12_340_000n, 0n], undefined, ok(12n)], // no account: the zero address's request is not this page's
      [[11n, 12_340_000n, 0n], account, fail], // epochId unread: maturity unknown
    ] as const) {
      const readContract = decoding(rates(true, 1n, 0n));
      const r = await readHouseVault(vault, who, { multicall: multicall(deposit, epoch), readContract } as unknown as PublicClient);
      expect(r.depositRefused).toBeNull();
      expect(readContract).not.toHaveBeenCalled();
    }
  });

  // A vault from before answers the seven-field tuple (no flag): it must not decode into a refusal or a price.
  it("an older vault's seven-field answer is null, never read as refused", async () => {
    const old = encodeAbiParameters(parseAbiParameters("uint128, uint256, uint256, uint256, uint256, uint256, uint256"),
      [178_420_000n, 1n, 0n, 1n, 0n, 0n, 0n]);
    const r = await readHouseVault(vault, account, { multicall: multicall([11n, 12_340_000n, 0n]), readContract: decoding(old) } as unknown as PublicClient);
    expect(r.depositRefused).toBeNull();
  });

  it("a failed epochRates read is null, never false (priced) and never true", async () => {
    const readContract = vi.fn(async () => { throw new Error("reverted"); });
    const r = await readHouseVault(vault, account, { multicall: multicall([11n, 12_340_000n, 0n]), readContract } as unknown as PublicClient);
    expect(r.depositRefused).toBeNull();
    expect(readContract).toHaveBeenCalledTimes(1);
  });
});

describe("account and allowance snapshots", () => {
  const account = "0x00000000000000000000000000000000000000a1" as const;
  const asset = "0x00000000000000000000000000000000000000a2" as const;
  const spender = "0x00000000000000000000000000000000000000a3" as const;

  it("reads the eight account facts in one multicall, the short id being longId | 1, and names them", async () => {
    const multicall = vi.fn(async () => [5n, 7n, 11n, 13n, 17n, true, false, true]);
    const client = { multicall } as unknown as PublicClient;
    const out = await readAccountOnChain(account, asset, 42n, spender, client);
    expect(out).toEqual({ longBalance: 5n, shortBalance: 7n, free: 11n, tokenBalance: 13n, allowance: 17n,
      approvedForAll: true, operator: false, thirdPartyRedeem: true });
    const { allowFailure, contracts } = (multicall.mock.calls[0] as unknown as [{ allowFailure: boolean; contracts: Array<{ address: string; functionName: string; args: unknown[] }> }])[0];
    expect(allowFailure).toBe(false);
    expect(contracts.map((c) => c.functionName)).toEqual(["balanceOf", "balanceOf", "free", "balanceOf", "allowance",
      "isApprovedForAll", "isOperator", "thirdPartyRedeemAllowed"]);
    expect(contracts[0]!.args).toEqual([account, 42n]);
    expect(contracts[1]!.args).toEqual([account, 43n]);
    expect(contracts[3]!.address).toBe(asset);
    expect(contracts[4]!.args).toEqual([account, spender]);
    // The book is the operator/approval target (mocked orderBook address), never the spender passed in.
    expect(contracts[5]!.args).toEqual([account, "0x0000000000000000000000000000000000000001"]);
    expect(contracts[0]!.address).toBe("0x0000000000000000000000000000000000000002");
  });

  it("reads one allowance per spender, in order, and fails closed on a revert", async () => {
    const multicall = vi.fn(async () => [1n, 2n]);
    const client = { multicall } as unknown as PublicClient;
    const other = "0x00000000000000000000000000000000000000a4" as const;
    await expect(readAllowances(account, asset, [spender, other], client)).resolves.toEqual([1n, 2n]);
    const { allowFailure, contracts } = (multicall.mock.calls[0] as unknown as [{ allowFailure: boolean; contracts: Array<{ address: string; args: unknown[] }> }])[0];
    expect(allowFailure).toBe(false);
    expect(contracts.map((c) => [c.address, c.args])).toEqual([[asset, [account, spender]], [asset, [account, other]]]);
    multicall.mockRejectedValueOnce(new Error("reverted"));
    await expect(readAllowances(account, asset, [spender], client)).rejects.toThrow("reverted");
  });
});
