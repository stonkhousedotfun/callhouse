import { getAddress, zeroAddress, type Address, type PublicClient } from "viem";

import { erc20Abi } from "../abi/erc20";
import { clearinghouseAbi } from "../abi/v2/clearinghouse";
import { earnVaultAbi } from "../abi/v2/earnVault";
import { feeSplitterAbi } from "../abi/v2/feeSplitter";
import { houseVaultAbi } from "../abi/v2/houseVault";
import { orderBookAbi } from "../abi/v2/orderBook";
import { settlementOracleAbi } from "../abi/v2/settlementOracle";
import { publicClient } from "../chain";
import { v2Markets } from "../markets";
import { requireV2Address, v2ContractAddress } from "./config";
import { houseClaimAmounts, type HouseClaimAmounts } from "./houseClaim";
import { shortIdOf } from "./seriesId";
import type { SeriesRef } from "./api-types";

/** Read the authoritative enabled bit when the indexer's market snapshot is unavailable. */
export async function readMarketEnabledOnChain(ticker: string, client: PublicClient = publicClient): Promise<boolean> {
  const market = v2Markets().find((row) => row.ticker === ticker.toUpperCase());
  if (!market) throw new Error("Market is not in this app's registry");
  const config = await client.readContract({ address: requireV2Address("clearinghouse"),
    abi: clearinghouseAbi, functionName: "market", args: [market.asset] });
  return config.enabled;
}

/** Read the compiled market's oracle directly when the indexer cannot serve /markets. */
export async function readMarketSpotOnChain(ticker: string, client: PublicClient = publicClient): Promise<bigint> {
  const market = v2Markets().find((row) => row.ticker === ticker.toUpperCase());
  if (!market) throw new Error("Market is not in this app's registry");
  // SettlementOracle.spot itself enforces the configured feed age and source validity.
  const [price] = await client.readContract({ address: requireV2Address("settlementOracle"),
    abi: settlementOracleAbi, functionName: "spot", args: [market.asset] });
  if (price <= 0n) throw new Error("Oracle spot is unavailable");
  return price;
}

/** On-chain state is authoritative for transactions; API snapshots are display data. */
export async function readSeriesOnChain(longId: bigint, client: PublicClient = publicClient, pinnedBlock?: bigint) {
  // cacheTime 0. viem caches the head for 4 s; a trade check must not pin a block that is already stale.
  const blockNumber = pinnedBlock ?? await client.getBlockNumber({ cacheTime: 0 });
  const block = await client.getBlock({ blockNumber });
  const address = requireV2Address("clearinghouse");
  const [exists, series, cutoff, collateral] = await client.multicall({
    allowFailure: false, blockNumber,
    contracts: [
      { address, abi: clearinghouseAbi, functionName: "seriesExists", args: [longId] },
      { address, abi: clearinghouseAbi, functionName: "series", args: [longId] },
      { address, abi: clearinghouseAbi, functionName: "mintCutoff", args: [longId] },
      { address, abi: clearinghouseAbi, functionName: "collateralPerUnit", args: [longId] },
    ],
  });
  return { exists, series, cutoff, collateral, blockNumber, snapshotTimestamp: Number(block.timestamp) };
}

/** API option terms are display data; compare them to the compiled market and on-chain series before a trade. */
export function assertSeriesTermsMatch(
  displayed: SeriesRef, onChain: Awaited<ReturnType<typeof readSeriesOnChain>>["series"],
  expectedTicker: string, displayedExerciseFeeBps?: number,
): void {
  const market = v2Markets().find((row) => row.ticker === expectedTicker.toUpperCase());
  if (!market || BigInt(displayed.shortId) !== shortIdOf(BigInt(displayed.longId)) ||
      displayed.ticker !== market.ticker ||
      getAddress(displayed.underlying) !== market.asset || getAddress(onChain.underlying) !== market.asset ||
      displayed.mintFeePpm !== onChain.mintFeePpm || displayed.isPut !== onChain.isPut || BigInt(displayed.strike.raw) !== onChain.strike ||
      BigInt(displayed.expiry) !== BigInt(onChain.expiry) ||
      (displayedExerciseFeeBps !== undefined && displayedExerciseFeeBps !== Number(onChain.exerciseFeeBps)))
    throw new Error("Option terms differ from the chain or this app's market registry. Refresh before trading.");
}

/** A position or order ID is not evidence that its API-displayed payoff is correct. */
export async function assertPortfolioSeries(displayed: SeriesRef, client: PublicClient = publicClient): Promise<void> {
  const onChain = await readSeriesOnChain(BigInt(displayed.longId), client);
  if (!onChain.exists) throw new Error("This option is no longer on chain. Refresh Portfolio.");
  assertSeriesTermsMatch(displayed, onChain.series, displayed.ticker);
}

export type PayoutPrefs = { inKind: boolean; toLedger: boolean };

/** Read the destination and asset choice that Clearinghouse will use at redemption. */
export async function readPayoutPrefs(account: Address, client: PublicClient = publicClient): Promise<PayoutPrefs> {
  const [inKind, toLedger] = await client.readContract({ address: requireV2Address("clearinghouse"),
    abi: clearinghouseAbi, functionName: "payoutPrefs", args: [account] });
  return { inKind, toLedger };
}

/** Stop a claim when another tab or transaction changed the preference after it was shown. */
export function assertPayoutPrefsMatch(shown: PayoutPrefs, current: PayoutPrefs): void {
  if (shown.inKind !== current.inKind || shown.toLedger !== current.toLedger)
    throw new Error("Your on-chain payout preference changed. Refresh Portfolio and review the payout before collecting.");
}

/** Reread exact selected orders just before a fill, including their makers' free stock collateral. */
export async function readOrderPreflight(orderIds: readonly bigint[], underlying: Address, client: PublicClient = publicClient, pinnedBlock?: bigint) {
  if (!orderIds.length) return [];
  // The calls cannot share a multicall: maker addresses come from getOrders. Pin both
  // reads to one block so an order and its collateral never describe different states.
  // Uncached head, as in readSeriesOnChain: a just-replaced order must not read as live.
  const blockNumber = pinnedBlock ?? await client.getBlockNumber({ cacheTime: 0 });
  const orders = await client.readContract({
    address: requireV2Address("orderBook"), abi: orderBookAbi, functionName: "getOrders", args: [[...orderIds]], blockNumber,
  });
  const clearinghouse = requireV2Address("clearinghouse");
  const orderBook = requireV2Address("orderBook");
  const writers = orders.filter((order) => order.kind === 2);
  // Two reads per write ask, in one pinned multicall: the maker's free Stock Tokens, and whether the book is the
  // maker's Clearinghouse operator. Without the operator approval the take skips the ask (the book's
  // `usable` is false and it consumes nothing), so ticket.ts refuses it when `writerIsOperator` is false.
  const reads = writers.length ? await client.multicall({
    allowFailure: false,
    blockNumber,
    contracts: writers.flatMap((order) => [
      { address: clearinghouse, abi: clearinghouseAbi, functionName: "free" as const, args: [order.maker, underlying] as const },
      { address: clearinghouse, abi: clearinghouseAbi, functionName: "isOperator" as const, args: [order.maker, orderBook] as const },
    ]),
  }) : [];
  let writerIndex = 0;
  return orders.map((order, index) => {
    // Bid collateral is USDG escrow and resale asks hold ERC-1155s in the book;
    // free Stock Tokens and the operator approval only gate write-on-fill orders.
    const at = order.kind === 2 ? 2 * writerIndex++ : -1;
    return {
      orderId: orderIds[index]!, order,
      freeCollateral: at < 0 ? null : reads[at] as bigint,
      writerIsOperator: at < 0 ? null : reads[at + 1] as boolean,
      blockNumber,
    };
  });
}

/** One block snapshot of balances, ledger, allowance and ERC-1155/operator approvals. */
export async function readAccountOnChain(
  account: Address,
  asset: Address,
  longId: bigint,
  spender: Address,
  client: PublicClient = publicClient,
) {
  const clearinghouse = requireV2Address("clearinghouse");
  const orderBook = requireV2Address("orderBook");
  const [longBalance, shortBalance, free, usdgBalance, allowance, approvedForAll, operator, thirdPartyRedeem] =
    await client.multicall({
      allowFailure: false,
      contracts: [
        { address: clearinghouse, abi: clearinghouseAbi, functionName: "balanceOf", args: [account, longId] },
        { address: clearinghouse, abi: clearinghouseAbi, functionName: "balanceOf", args: [account, longId | 1n] },
        { address: clearinghouse, abi: clearinghouseAbi, functionName: "free", args: [account, asset] },
        { address: asset, abi: erc20Abi, functionName: "balanceOf", args: [account] },
        { address: asset, abi: erc20Abi, functionName: "allowance", args: [account, spender] },
        { address: clearinghouse, abi: clearinghouseAbi, functionName: "isApprovedForAll", args: [account, orderBook] },
        { address: clearinghouse, abi: clearinghouseAbi, functionName: "isOperator", args: [account, orderBook] },
        { address: clearinghouse, abi: clearinghouseAbi, functionName: "thirdPartyRedeemAllowed", args: [account] },
      ],
    });
  return { longBalance, shortBalance, free, tokenBalance: usdgBalance, allowance, approvedForAll, operator, thirdPartyRedeem };
}

export async function readAllowances(
  account: Address, asset: Address, spenders: readonly Address[], client: PublicClient = publicClient,
) {
  return client.multicall({
    allowFailure: false,
    contracts: spenders.map((spender) => ({ address: asset, abi: erc20Abi, functionName: "allowance" as const, args: [account, spender] as const })),
  });
}

/*//////////////////////////////////////////////////////////////
          VAULT PAGES
//////////////////////////////////////////////////////////////*/

/*
 * No `weekly()` read here. A House vault's cadence is the /v2/house `kind`, which the indexer decides from
 * the factory the vault came from (indexer src/v2/houseVaultKind.ts). The launch vaults have no weekly() view, and the
 * read this file used to send mapped that failure -- and every other failure -- to weekly.
 */

/** One multicall result: the value, or null when that call failed. A failed read is never rendered as 0. */
function okOrNull<T>(result: { status: "success"; result: unknown } | { status: "failure"; error: unknown }): T | null {
  return result.status === "success" ? (result.result as T) : null;
}

export type HouseVaultReads = {
  /** `nav()`: a MARK at the last boundary's settlement price. Null before the first boundary (it reverts NotSettled). */
  nav: bigint | null;
  totalSupply: bigint | null;
  /** `balanceOf(account)`; null when no account was given or the read failed. */
  balance: bigint | null;
  /** `performanceFeeBps()`: the CONFIGURED rate. A rate change is staged here and charged only from the next epoch. */
  performanceFeeBps: number | null;
  /**
   * `epochPerformanceFeeBps()`: the rate IN FORCE, the one the next boundary charges (rollEpoch applies the
   * configured rate to it as an epoch opens, PerformanceFeeBpsApplied). The page's fee is this one.
   */
  epochPerformanceFeeBps: number | null;
  performanceFeeCeilBps: number | null;
  highWaterMark: bigint | null;
  splitter: Address | null;
  oracle: Address | null;
  lastSettlementPrice: bigint | null;
  limits: {
    maxSeriesUnits: bigint; maxTotalNotional: bigint; askToleranceBps: number; maxBidBpsOfSpot: number;
    maxOrderLifetime: number; maxDailyOutflow: bigint;
  } | null;
  /**
   * `performanceFeeOwed()` (v9): a performance fee charged at a boundary but not yet paid, in USDG base
   * units. `nav()` already nets it, so it is shown beside NAV, never subtracted again. Null on a failed read; optional
   * only so fixtures written before this field still type.
   */
  performanceFeeOwed?: bigint | null;
  /**
   * `protocolAccountsConfirmed()`: whether THIS vault is armed and quotes. The House page keys its deposit
   * gate on it, because it is the vault the deposit writes to (the registry's per-market vault can be a different one
   * once daily vaults exist). Null on a failed read. Optional only so fixtures written before this field still type;
   * absent, null and false all hold deposits shut (launchGates.houseDepositsOpen).
   */
  protocolAccountsConfirmed?: boolean | null;
  /**
   * What `claim()` tests (lib/v2/houseClaim.ts). `epochId()`, and `account`'s `withdrawRequestOf` /
   * `depositRequestOf`; the two requests are null without an account. Null on a failed read. Optional only so fixtures
   * written before these fields still type; absent reads as unread and keeps the claim button disabled.
   */
  epochId?: bigint | null;
  withdrawRequest?: { epochId: bigint; shares: bigint } | null;
  depositRequest?: { epochId: bigint; usdg: bigint; stock: bigint } | null;
  /**
   * `SETTLEMENT_WINDOW()` in seconds, from the SettlementOracle. HouseVault's queue calls refuse PastCutoff
   * from `epochEnd` minus it, and it is V2Constants' compiled constant, so the registry's oracle answers the
   * same value as the vault's. Null on a failed read. Optional only so fixtures written before this field still type.
   */
  settlementWindow?: number | null;
  /**
   * `claimable(account)`, exactly what `claim()` would pay `account` now (lib/v2/houseClaim.ts).
   * (0, 0, 0) both when nothing has matured and when a matured request prices to zero, so it is shown, never used to
   * gate the claim button. Null without an account, on a failed read, and on a vault that predates the view. Optional
   * only so fixtures written before this field still type.
   */
  claimable?: HouseClaimAmounts | null;
  /**
   * For a MATURED deposit only, `epochRates(depositRequest.epochId).depositRefused`: true when the
   * close REFUSED that deposit batch, so `claim()` returns it in kind instead of minting shares. Null when there is no
   * matured deposit, and on a failed read: the page then says nothing about a refusal. Optional only so fixtures
   * written before this field still type.
   */
  depositRefused?: boolean | null;
  /**
   * `pinnedBoundary()`, the boundary the vault locked on its oracle as the epoch opened, and the
   * queued deposits `pendingDepositUsdg()` / `pendingDepositStock()`. With `totalSupply` they say whether rollEpoch will
   * hold the close for a week (lib/v2/houseEpoch.ts boundaryState). Null on a failed read and on a vault that predates
   * the view. Optional only so fixtures written before these fields still type.
   */
  pinnedBoundary?: number | null;
  pendingDeposit?: { usdg: bigint; stock: bigint } | null;
};

/**
 * whether the close that matured `deposit` refused it. A second call, because the epoch to ask about is the
 * deposit's own, known only from the multicall. MIRROR, DO NOT RE-REASON: `depositShares == 0` is NOT a refusal (the
 * shares are run down by every claim), so only the flag the boundary recorded is read, by NAME:
 * put it second in the tuple, so a position copied from the old layout would read `depositValue`.
 */
async function readDepositRefused(
  client: PublicClient, vault: Address, epochId: bigint | null,
  deposit: { epochId: bigint; usdg: bigint; stock: bigint } | null,
): Promise<boolean | null> {
  // claim()'s own "matured" test (houseClaim.ts houseClaimState): a queued deposit from an epoch before this one.
  if (epochId === null || deposit === null || (deposit.usdg === 0n && deposit.stock === 0n) || deposit.epochId >= epochId)
    return null;
  try {
    const rates = await client.readContract({
      address: vault, abi: houseVaultAbi, functionName: "epochRates", args: [deposit.epochId],
    });
    return rates.depositRefused;
  } catch {
    // A failed call, or a vault from before whose shorter tuple does not decode against this ABI.
    return null;
  }
}

/** Every chain fact the House page shows, in one multicall. Each field is null on its own failure. */
export async function readHouseVault(vault: Address, account?: Address, client: PublicClient = publicClient): Promise<HouseVaultReads> {
  const a = vault;
  const h = houseVaultAbi;
  // Fixed shape on purpose: `balanceOf` is always sent (zero address when there is no account) and dropped below,
  // because a conditional element defeats viem's per-call result typing.
  const results = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: a, abi: h, functionName: "nav" },
      { address: a, abi: h, functionName: "totalSupply" },
      { address: a, abi: h, functionName: "performanceFeeBps" },
      { address: a, abi: h, functionName: "PERFORMANCE_FEE_CEIL_BPS" },
      { address: a, abi: h, functionName: "highWaterMark" },
      { address: a, abi: h, functionName: "splitter" },
      { address: a, abi: h, functionName: "oracle" },
      { address: a, abi: h, functionName: "lastSettlementPrice" },
      { address: a, abi: h, functionName: "limits" },
      { address: a, abi: h, functionName: "balanceOf", args: [account ?? zeroAddress] },
      { address: a, abi: h, functionName: "protocolAccountsConfirmed" },
      { address: a, abi: h, functionName: "performanceFeeOwed" },
      { address: a, abi: h, functionName: "epochId" },
      { address: a, abi: h, functionName: "withdrawRequestOf", args: [account ?? zeroAddress] },
      { address: a, abi: h, functionName: "depositRequestOf", args: [account ?? zeroAddress] },
      // No registry oracle: the zero address fails this one call, and the window reads as unknown.
      { address: v2ContractAddress("settlementOracle") ?? zeroAddress, abi: settlementOracleAbi, functionName: "SETTLEMENT_WINDOW" },
      // last, so every index above is unchanged.
      { address: a, abi: h, functionName: "epochPerformanceFeeBps" },
      // After it, for the same reason.
      { address: a, abi: h, functionName: "claimable", args: [account ?? zeroAddress] },
      // After it, for the same reason.
      { address: a, abi: h, functionName: "pinnedBoundary" },
      { address: a, abi: h, functionName: "pendingDepositUsdg" },
      { address: a, abi: h, functionName: "pendingDepositStock" },
    ] as const,
  });
  const [nav, supply, fee, ceil, hwm, splitter, oracle, lastPrice, limits, balance, armed, owed, epoch, wreq, dreq, windowS, epochFee,
    claimableQuote, pinned, pendUsdg, pendStock] = results;
  const pendingUsdg = okOrNull<bigint>(pendUsdg!);
  const pendingStock = okOrNull<bigint>(pendStock!);
  const withdrawRequest = okOrNull<readonly [bigint, bigint]>(wreq!);
  const depositRequest = okOrNull<readonly [bigint, bigint, bigint]>(dreq!);
  const deposit = !account || depositRequest === null
    ? null : { epochId: depositRequest[0], usdg: depositRequest[1], stock: depositRequest[2] };
  const epochIdNow = okOrNull<bigint>(epoch!);
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    nav: okOrNull<bigint>(nav!),
    totalSupply: okOrNull<bigint>(supply!),
    balance: account ? okOrNull<bigint>(balance!) : null,
    performanceFeeBps: num(okOrNull(fee!)),
    epochPerformanceFeeBps: num(okOrNull(epochFee!)),
    performanceFeeCeilBps: num(okOrNull(ceil!)),
    highWaterMark: okOrNull<bigint>(hwm!),
    splitter: okOrNull<Address>(splitter!),
    oracle: okOrNull<Address>(oracle!),
    lastSettlementPrice: okOrNull<bigint>(lastPrice!),
    limits: okOrNull<HouseVaultReads["limits"]>(limits!),
    protocolAccountsConfirmed: okOrNull<boolean>(armed!),
    performanceFeeOwed: okOrNull<bigint>(owed!),
    epochId: epochIdNow,
    withdrawRequest: !account || withdrawRequest === null ? null : { epochId: withdrawRequest[0], shares: withdrawRequest[1] },
    depositRequest: deposit,
    settlementWindow: num(okOrNull(windowS!)),
    claimable: account ? houseClaimAmounts(okOrNull(claimableQuote!)) : null,
    depositRefused: await readDepositRefused(client, a, epochIdNow, deposit),
    pinnedBoundary: num(okOrNull(pinned!)),
    pendingDeposit: pendingUsdg === null || pendingStock === null ? null : { usdg: pendingUsdg, stock: pendingStock },
  };
}

export type EarnVaultReads = {
  hasOpenPosition: boolean | null;
  /**
   * The vault's `decimals()`: one whole share is `10 ** shareDecimals` share base units. Every per-share
   * figure below is USDG base units per WHOLE share at this scale, and every share amount the page parses or shows
   * uses it. Null when not read, and then every per-share figure is null too: a price in an unknown unit is not shown.
   */
  shareDecimals: number | null;
  /** Flat path only: `convertToAssets` and `totalAssets()` revert PositionOpen while a series is written. Per whole share. */
  assetsPerShare: bigint | null;
  totalAssets: bigint | null;
  /** DISPLAY-ONLY marks, the figure to show while a position is open (EarnVault). Per whole share. */
  indicativeAssetsPerShare: bigint | null;
  indicativeTotalAssets: bigint | null;
  /**
   * `totalSupply()`. 0 is an EMPTY vault: both per-share views then return 0 (EarnVault `convertToAssets` and
   * `indicativeAssetsPerShare` on `supply == 0`), which is a price nobody can get, not a zero price.
   * Null when not read, and an unread supply is never taken to mean empty.
   */
  totalSupply: bigint | null;
  skimBps: number | null;
  skimCeilBps: number | null;
  /** USDG base units per whole share at the last skim. */
  highWaterMark: bigint | null;
  adapter: Address | null;
  splitter: Address | null;
  balance: bigint | null;
  /**
   * True when `convertToAssets(1e18)` reverted `VenueUnreadable()`: the venue adapter cannot be
   * read, so the vault prices nothing and every deposit and withdrawal waits in line. False when it answered. Null when
   * it failed any other way, PositionOpen included (the contract checks that first; `hasOpenPosition` covers it).
   */
  venueUnreadable: boolean | null;
};

/**
 * MIRRORED from `EarnVault.ONE_SHARE` (private, callhouse-contracts src/v2/periphery/earn/EarnVault.sol): the share
 * amount the vault quotes `indicativeAssetsPerShare()` and `highWaterMark()` per, and the amount `convertToAssets` is
 * asked about here. It is a compiled constant there, NOT `10 ** decimals()`; the two are equal (18 over
 * a 1e12-per-USDG-unit mint), and {perWholeShare} converts to the page's unit either way.
 */
export const EARN_QUOTE_SHARES = 10n ** 18n;

/** A per-{EARN_QUOTE_SHARES} quote re-expressed per whole share (`10 ** shareDecimals`); null in, null out. */
export function perWholeShare(quote: bigint | null, shareDecimals: number | null): bigint | null {
  if (quote === null || shareDecimals === null) return null;
  return (quote * 10n ** BigInt(shareDecimals)) / EARN_QUOTE_SHARES;
}

/** The custom error a viem call error decoded against the call's ABI, anywhere in its cause chain; null when none. */
export function revertErrorName(error: unknown): string | null {
  let e: unknown = error;
  for (let i = 0; i < 12 && typeof e === "object" && e !== null; i += 1) {
    const data = (e as { data?: unknown }).data;
    if (typeof data === "object" && data !== null) {
      const name = (data as { errorName?: unknown }).errorName;
      if (typeof name === "string") return name;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** The `convertToAssets` result read as "the venue cannot be read" (see {EarnVaultReads.venueUnreadable}). */
export function venueUnreadableOf(result: { status: "success"; result: unknown } | { status: "failure"; error: unknown }): boolean | null {
  if (result.status === "success") return false;
  return revertErrorName(result.error) === "VenueUnreadable" ? true : null;
}

/** Every chain fact the Earn page shows, in one multicall. Each field is null on its own failure. */
export async function readEarnVault(vault: Address, account?: Address, client: PublicClient = publicClient): Promise<EarnVaultReads> {
  const a = vault;
  const e = earnVaultAbi;
  const results = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: a, abi: e, functionName: "hasOpenPosition" },
      { address: a, abi: e, functionName: "convertToAssets", args: [EARN_QUOTE_SHARES] },
      { address: a, abi: e, functionName: "totalAssets" },
      { address: a, abi: e, functionName: "indicativeAssetsPerShare" },
      { address: a, abi: e, functionName: "indicativeTotalAssets" },
      { address: a, abi: e, functionName: "totalSupply" },
      { address: a, abi: e, functionName: "skimBps" },
      { address: a, abi: e, functionName: "SKIM_BPS_CEIL" },
      { address: a, abi: e, functionName: "highWaterMark" },
      { address: a, abi: e, functionName: "adapter" },
      { address: a, abi: e, functionName: "splitter" },
      { address: a, abi: e, functionName: "balanceOf", args: [account ?? zeroAddress] },
      // LAST, so every index above keeps its place.
      { address: a, abi: e, functionName: "decimals" },
    ] as const,
  });
  const [open, perShare, total, iPerShare, iTotal, supply, skim, ceil, hwm, adapter, splitter, balance, decimals] = results;
  const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const shareDecimals = num(okOrNull(decimals!));
  return {
    hasOpenPosition: okOrNull<boolean>(open!),
    shareDecimals,
    assetsPerShare: perWholeShare(okOrNull<bigint>(perShare!), shareDecimals),
    totalAssets: okOrNull<bigint>(total!),
    indicativeAssetsPerShare: perWholeShare(okOrNull<bigint>(iPerShare!), shareDecimals),
    indicativeTotalAssets: okOrNull<bigint>(iTotal!),
    totalSupply: okOrNull<bigint>(supply!),
    skimBps: num(okOrNull(skim!)),
    skimCeilBps: num(okOrNull(ceil!)),
    highWaterMark: perWholeShare(okOrNull<bigint>(hwm!), shareDecimals),
    adapter: okOrNull<Address>(adapter!),
    splitter: okOrNull<Address>(splitter!),
    balance: account ? okOrNull<bigint>(balance!) : null,
    venueUnreadable: venueUnreadableOf(perShare!),
  };
}

export type SplitterReads = { burnBps: number | null; treasury: Address | null };

/** The FeeSplitter's burn share and treasury, for the fee-route line and the proof block. */
export async function readSplitter(splitter: Address, client: PublicClient = publicClient): Promise<SplitterReads> {
  const [burn, treasury] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address: splitter, abi: feeSplitterAbi, functionName: "burnBps" },
      { address: splitter, abi: feeSplitterAbi, functionName: "treasury" },
    ],
  });
  const b = okOrNull<number | bigint>(burn!);
  return { burnBps: b === null ? null : Number(b), treasury: okOrNull<Address>(treasury!) };
}
