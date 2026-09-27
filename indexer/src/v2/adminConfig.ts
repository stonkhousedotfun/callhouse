import schema from "ponder:schema";

import {
  v2CalendarPonder,
  v2ChainlinkSourcePonder,
  v2DataStreamsSourcePonder,
  v2EarnVaultPonder,
  v2FeeSplitterPonder,
  v2HouseVaultEventsPonder,
  v2HouseVaultKindedFactoryPonder,
  v2HouseVaultPonder,
  v2MakerVaultPonder,
  v2PayoutRouterPonder,
  v2Ponder,
  v2RewardsDistributorPonder,
  v2RewardsPonder,
  v2UniV3SourcePonder,
} from "../../lib/registry";
import { recordCalendarConstruction } from "./calendarMode";

/**
 * The admin-configuration facts the indexer read and dropped.
 *
 * Every restricted v8 contract emits `AuthorityUpdated` when its AccessManager is set or re-pointed,
 * and each one emits a `*Set` event per pointer or parameter. None of them had a handler, and none
 * had a column: adding a handler without a column persists nothing, which is why an earlier fix could only
 * guard the source-level half of this problem.
 *
 * The two shapes here are deliberate:
 *   - {@link setting} writes the CURRENT value (v2ContractSetting, one row per source+key) and the
 *     CHANGE that produced it (v2ContractSettingChange, append-only) in the same handler, so a
 *     current value always has its provenance. The value goes in a typed column chosen by the ABI
 *     type; `valueKind` says which one is live, so a consumer never parses text back into a number.
 *   - {@link authority} writes one row per contract, keyed by the source name rather than the
 *     address, because the question it answers is "is THIS contract governed by the AccessManager we
 *     deployed" and the address is the answer's subject, not its key.
 *
 * Each registration is written out with a literal event name on purpose. src/v2/eventCoverage.test.ts
 * parses these call expressions, and a helper that took the name as a variable would make the census
 * unreadable to its own check.
 */

type SettingValue =
  | { kind: "address"; address: `0x${string}` }
  | { kind: "uint"; uint: bigint }
  | { kind: "bool"; bool: boolean }
  | { kind: "text"; text: string };

type SettingColumns = {
  valueKind: string;
  valueAddress: `0x${string}` | null;
  valueUint: bigint | null;
  valueBool: boolean | null;
  valueText: string | null;
};

function columns(value: SettingValue): SettingColumns {
  return {
    valueKind: value.kind,
    valueAddress: value.kind === "address" ? value.address : null,
    valueUint: value.kind === "uint" ? value.uint : null,
    valueBool: value.kind === "bool" ? value.bool : null,
    valueText: value.kind === "text" ? value.text : null,
  };
}

/** The block/tx coordinates every row below carries, under the names that row uses. */
type EventLike = {
  block: { timestamp: bigint; number: bigint };
  log: { logIndex: number; address: `0x${string}` };
  transaction: { hash: `0x${string}` };
};
type Context = { db: any };

async function setting(context: Context, event: EventLike, source: string, key: string, value: SettingValue): Promise<void> {
  await writeSetting(context, event, source, key, value, `${event.transaction.hash}-${event.log.logIndex}`);
}

/**
 * Several keys from ONE log (a price source's FeedSet carries the feed, its staleness bound
 * and its round-jump bound together). The change rows share a tx and log index, so the key is
 * appended to each change id; {@link setting}'s ids are unchanged.
 */
async function settings(
  context: Context, event: EventLike, source: string, entries: readonly (readonly [string, SettingValue])[],
): Promise<void> {
  for (const [key, value] of entries) {
    await writeSetting(context, event, source, key, value, `${event.transaction.hash}-${event.log.logIndex}:${key}`);
  }
}

async function writeSetting(
  context: Context, event: EventLike, source: string, key: string, value: SettingValue, changeId: string,
): Promise<void> {
  const current = {
    source, key, ...columns(value),
    updatedAt: event.block.timestamp,
    updatedBlock: event.block.number,
    updatedLogIndex: event.log.logIndex,
    updatedTx: event.transaction.hash,
  };
  await context.db.insert(schema.v2ContractSetting)
    .values({ id: `${source}:${key}`, ...current })
    .onConflictDoUpdate(current);
  await context.db.insert(schema.v2ContractSettingChange).values({
    id: changeId,
    source, key, ...columns(value),
    ts: event.block.timestamp,
    block: event.block.number,
    logIndex: event.log.logIndex,
    tx: event.transaction.hash,
  });
}

async function authority(context: Context, event: EventLike, source: string, value: `0x${string}`): Promise<void> {
  const current = {
    source,
    contract: event.log.address,
    authority: value,
    updatedAt: event.block.timestamp,
    updatedBlock: event.block.number,
    updatedLogIndex: event.log.logIndex,
    updatedTx: event.transaction.hash,
  };
  await context.db.insert(schema.v2ContractAuthority)
    .values({ id: source.toLowerCase(), ...current })
    .onConflictDoUpdate(current);
}

/* ---------------------------------------------------------------- authority */

v2Ponder.on("AutoRoller:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "AutoRoller", event.args.authority);
});

v2Ponder.on("Clearinghouse:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "Clearinghouse", event.args.authority);
});

v2EarnVaultPonder.on("EarnVault:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "EarnVault", event.args.authority);
});

v2CalendarPonder.on("ExpiryCalendar:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "ExpiryCalendar", event.args.authority);
  // The first one is the constructor's; its transaction decides the fail-closed switch.
  await recordCalendarConstruction(context, event);
});

v2FeeSplitterPonder.on("FeeSplitter:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "FeeSplitter", event.args.authority);
});

v2HouseVaultEventsPonder.on("HouseVault:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "HouseVault", event.args.authority);
});

v2HouseVaultPonder.on("HouseVaultFactory:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "HouseVaultFactory", event.args.authority);
});

// The (daily) factories are their own source; their own row, so the launch factory's is not overwritten.
v2HouseVaultKindedFactoryPonder.on("HouseVaultFactoryKinded:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "HouseVaultFactoryKinded", event.args.authority);
});

v2RewardsPonder.on("KeeperRewards:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "KeeperRewards", event.args.authority);
});

v2Ponder.on("MakerRegistry:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "MakerRegistry", event.args.authority);
});

v2MakerVaultPonder.on("MakerVault:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "MakerVault", event.args.authority);
});

v2Ponder.on("OrderBook:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "OrderBook", event.args.authority);
});

v2PayoutRouterPonder.on("PayoutRouter:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "PayoutRouter", event.args.authority);
});

v2RewardsDistributorPonder.on("RewardsDistributor:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "RewardsDistributor", event.args.authority);
});

v2Ponder.on("SettlementOracle:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "SettlementOracle", event.args.authority);
});

/* ----------------------------------------------------------------- settings */

v2Ponder.on("AutoRoller:KeeperRewardsSet", async ({ event, context }) => {
  await setting(context, event, "AutoRoller", "keeperRewards", { kind: "address", address: event.args.keeperRewards });
});

v2Ponder.on("AutoRoller:MinRollUnitsSet", async ({ event, context }) => {
  await setting(context, event, "AutoRoller", "minRollUnits", { kind: "uint", uint: BigInt(event.args.units) });
});

v2Ponder.on("Clearinghouse:BaseUriSet", async ({ event, context }) => {
  await setting(context, event, "Clearinghouse", "baseUri", { kind: "text", text: event.args.baseUri });
});

v2Ponder.on("Clearinghouse:CalendarSet", async ({ event, context }) => {
  await setting(context, event, "Clearinghouse", "calendar", { kind: "address", address: event.args.calendar });
});

v2Ponder.on("Clearinghouse:KeeperRewardsSet", async ({ event, context }) => {
  await setting(context, event, "Clearinghouse", "keeperRewards", { kind: "address", address: event.args.keeperRewards });
});

// The SETTLE and REDEEM bounty threshold, and also SettlementOracle's SNAPSHOT and FINALIZE
// bounty floor: the oracle reads it from the Clearinghouse, so this one row is all four.
v2Ponder.on("Clearinghouse:MinRedeemPayoutSet", async ({ event, context }) => {
  await setting(context, event, "Clearinghouse", "minRedeemPayout", { kind: "uint", uint: BigInt(event.args.amount) });
});

v2FeeSplitterPonder.on("FeeSplitter:BurnBpsSet", async ({ event, context }) => {
  await setting(context, event, "FeeSplitter", "burnBps", { kind: "uint", uint: BigInt(event.args.burnBps) });
});

v2FeeSplitterPonder.on("FeeSplitter:BuybackCapSet", async ({ event, context }) => {
  await setting(context, event, "FeeSplitter", "buybackCapUsdg", { kind: "uint", uint: BigInt(event.args.perCallUsdg) });
});

// A change made the per-call ceiling of buybackCap and the buyback cooldown ADMIN-settable
// (FeeSplitter.setBuybackCapCeiling / setBuybackCooldown); until the regenerated ABI carried these events they were dropped.
v2FeeSplitterPonder.on("FeeSplitter:BuybackCapCeilingSet", async ({ event, context }) => {
  await setting(context, event, "FeeSplitter", "buybackCapCeiling", { kind: "uint", uint: BigInt(event.args.ceiling) });
});

v2FeeSplitterPonder.on("FeeSplitter:BuybackCooldownSet", async ({ event, context }) => {
  await setting(context, event, "FeeSplitter", "buybackCooldown", { kind: "uint", uint: BigInt(event.args.cooldown) });
});

v2FeeSplitterPonder.on("FeeSplitter:BuybackExecutorSet", async ({ event, context }) => {
  await setting(context, event, "FeeSplitter", "buybackExecutor", { kind: "address", address: event.args.executor });
});

v2FeeSplitterPonder.on("FeeSplitter:ConversionSlippageBpsSet", async ({ event, context }) => {
  await setting(context, event, "FeeSplitter", "conversionSlippageBps", { kind: "uint", uint: BigInt(event.args.bps) });
});

v2FeeSplitterPonder.on("FeeSplitter:OrderBookSet", async ({ event, context }) => {
  await setting(context, event, "FeeSplitter", "orderBook", { kind: "address", address: event.args.orderBook });
});

v2FeeSplitterPonder.on("FeeSplitter:PausedSet", async ({ event, context }) => {
  await setting(context, event, "FeeSplitter", "paused", { kind: "bool", bool: event.args.paused });
});

v2FeeSplitterPonder.on("FeeSplitter:RouterSet", async ({ event, context }) => {
  await setting(context, event, "FeeSplitter", "router", { kind: "address", address: event.args.router });
});

v2FeeSplitterPonder.on("FeeSplitter:SettlementOracleSet", async ({ event, context }) => {
  await setting(context, event, "FeeSplitter", "settlementOracle", { kind: "address", address: event.args.oracle });
});

v2FeeSplitterPonder.on("FeeSplitter:StonkhouseSet", async ({ event, context }) => {
  await setting(context, event, "FeeSplitter", "stonkhouse", { kind: "address", address: event.args.token });
});

v2FeeSplitterPonder.on("FeeSplitter:TreasurySet", async ({ event, context }) => {
  await setting(context, event, "FeeSplitter", "treasury", { kind: "address", address: event.args.treasury });
});

v2RewardsPonder.on("KeeperRewards:DailyCapSet", async ({ event, context }) => {
  await setting(context, event, "KeeperRewards", "dailyCap", { kind: "uint", uint: BigInt(event.args.amount) });
});

// The per-call bounty cap reward() pays under (min(bounty, maxBounty)), ADMIN-settable.
v2RewardsPonder.on("KeeperRewards:MaxBountySet", async ({ event, context }) => {
  await setting(context, event, "KeeperRewards", "maxBounty", { kind: "uint", uint: BigInt(event.args.amount) });
});

v2RewardsPonder.on("KeeperRewards:TreasurySet", async ({ event, context }) => {
  await setting(context, event, "KeeperRewards", "treasury", { kind: "address", address: event.args.treasury });
});

v2MakerVaultPonder.on("MakerVault:TreasurySet", async ({ event, context }) => {
  await setting(context, event, "MakerVault", "treasury", { kind: "address", address: event.args.treasury });
});

v2Ponder.on("OrderBook:FeeRecipientSet", async ({ event, context }) => {
  await setting(context, event, "OrderBook", "feeRecipient", { kind: "address", address: event.args.recipient });
});

v2Ponder.on("OrderBook:MakerRegistrySet", async ({ event, context }) => {
  await setting(context, event, "OrderBook", "makerRegistry", { kind: "address", address: event.args.registry });
});

v2RewardsDistributorPonder.on("RewardsDistributor:TreasurySet", async ({ event, context }) => {
  await setting(context, event, "RewardsDistributor", "treasury", { kind: "address", address: event.args.treasury });
});

v2Ponder.on("SettlementOracle:ClearinghouseSet", async ({ event, context }) => {
  await setting(context, event, "SettlementOracle", "clearinghouse", { kind: "address", address: event.args.clearinghouse });
});

v2Ponder.on("SettlementOracle:KeeperRewardsSet", async ({ event, context }) => {
  await setting(context, event, "SettlementOracle", "keeperRewards", { kind: "address", address: event.args.keeperRewards });
});

// The HouseVaultFactory whose vaults may lock their own epoch boundary (SettlementOracle.pinBoundary).
v2Ponder.on("SettlementOracle:HouseVaultFactorySet", async ({ event, context }) => {
  await setting(context, event, "SettlementOracle", "houseVaultFactory", { kind: "address", address: event.args.houseVaultFactory });
});

// A change turned EarnVault's compiled caps (MAX_SERIES_UNITS, MAX_ORDER_NOTIONAL, MAX_WRITTEN_UNITS_PER_SERIES,
// MAX_WRITTEN_NOTIONAL, MAX_DAILY_OUTFLOW) into one Limits struct, logged whole by LimitsSet from setLimits (TREASURY_ADMIN),
// tightenLimits (GUARDIAN, tighten-only) and the constructor. One setting per field, as multi-field events are.
v2EarnVaultPonder.on("EarnVault:LimitsSet", async ({ event, context }) => {
  const l = event.args.limits;
  await settings(context, event, "EarnVault", [
    ["limits.maxSeriesUnits", { kind: "uint", uint: BigInt(l.maxSeriesUnits) }],
    ["limits.maxOrderNotional", { kind: "uint", uint: BigInt(l.maxOrderNotional) }],
    ["limits.maxWrittenUnitsPerSeries", { kind: "uint", uint: BigInt(l.maxWrittenUnitsPerSeries) }],
    ["limits.maxWrittenNotional", { kind: "uint", uint: BigInt(l.maxWrittenNotional) }],
    ["limits.maxDailyOutflow", { kind: "uint", uint: BigInt(l.maxDailyOutflow) }],
  ]);
});

// setPerformanceFeeBps STAGES a rate; rollEpoch applies it as the next epoch opens
// (PerformanceFeeBpsApplied, handled in src/v2/houseVault.ts on v2HouseVault.performanceFeeBps, the rate in force). The
// staged rate is a setting, keyed by vault as OracleSet is: writing it to the in-force column showed a staged fee as charged.
v2HouseVaultEventsPonder.on("HouseVault:PerformanceFeeBpsSet", async ({ event, context }) => {
  await setting(context, event, "HouseVault", `performanceFeeBps:${event.log.address}`, { kind: "uint", uint: BigInt(event.args.bps) });
});

// HouseVault is a factory of clones, so the key carries the vault. Found unhandled by the
// census run: the export gained OracleSet and the coverage pin had stopped at a stale row count.
v2HouseVaultEventsPonder.on("HouseVault:OracleSet", async ({ event, context }) => {
  await setting(context, event, "HouseVault", `oracle:${event.log.address}`, { kind: "address", address: event.args.oracle });
});

// A vault could not lock `epochEnd`'s settlement configuration on its oracle (best effort; the
// deposit or roll went on), so that boundary rolls only a week after it ends if money is exposed to it. Keyed by vault
// as OracleSet is: the current row is the latest failure, and v2ContractSettingChange keeps every one with its tx.
v2HouseVaultEventsPonder.on("HouseVault:BoundaryPinFailed", async ({ event, context }) => {
  await settings(context, event, "HouseVault", [
    [`boundaryPinFailed:${event.log.address}`, { kind: "uint", uint: BigInt(event.args.epochEnd) }],
    [`boundaryPinFailedReason:${event.log.address}`, { kind: "text", text: event.args.reason }],
  ]);
});

/* ------------------------------------------------------------ price sources */

/*
 * The three shared price sources' admin facts, in the same two tables as every other
 * contract's. Per-market configuration is keyed by the underlying, and an expiry's pinned
 * configuration by underlying and expiry, so "what feed does NVDA use now" and "what feed was
 * pinned for NVDA's 2026-10-02 expiry" are both one row.
 *
 * Handled here: AuthorityUpdated, OracleSet, FeedSet / PoolSet, FeedPinned / PoolPinned, ChainlinkFeedSource's
 * BandSet / BandPinned and DataStreamsSource.MultiplierRegimeChanged. The observation events (both `Recorded`s,
 * `ObservationStored`, `ReportSkipped`) are data, not settings, and are deferred with a reason each
 * in src/v2/eventCoverage.test.ts.
 */

v2ChainlinkSourcePonder.on("ChainlinkFeedSource:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "ChainlinkFeedSource", event.args.authority);
});

v2ChainlinkSourcePonder.on("ChainlinkFeedSource:OracleSet", async ({ event, context }) => {
  await setting(context, event, "ChainlinkFeedSource", `oracle:${event.args.oracle}`, { kind: "bool", bool: event.args.allowed });
});

v2ChainlinkSourcePonder.on("ChainlinkFeedSource:FeedSet", async ({ event, context }) => {
  const { underlying, feed, maxStale, maxRoundJumpBps } = event.args;
  await settings(context, event, "ChainlinkFeedSource", [
    [`feed:${underlying}`, { kind: "address", address: feed }],
    [`maxStale:${underlying}`, { kind: "uint", uint: BigInt(maxStale) }],
    [`maxRoundJumpBps:${underlying}`, { kind: "uint", uint: BigInt(maxRoundJumpBps) }],
  ]);
});

v2ChainlinkSourcePonder.on("ChainlinkFeedSource:FeedPinned", async ({ event, context }) => {
  const { underlying, expiry, feed, maxStale, maxRoundJumpBps } = event.args;
  const pin = `pin:${underlying}:${expiry}`;
  await settings(context, event, "ChainlinkFeedSource", [
    [`${pin}:feed`, { kind: "address", address: feed }],
    [`${pin}:maxStale`, { kind: "uint", uint: BigInt(maxStale) }],
    [`${pin}:maxRoundJumpBps`, { kind: "uint", uint: BigInt(maxRoundJumpBps) }],
  ]);
});

/**
 * v9 ChainlinkFeedSource settlement band: setBand emits BandSet (the live band for an underlying),
 * pin() emits BandPinned (the band frozen for one expiry). Keyed like FeedSet / FeedPinned, one key per bound.
 */
v2ChainlinkSourcePonder.on("ChainlinkFeedSource:BandSet", async ({ event, context }) => {
  const { underlying, minPrice, maxPrice } = event.args;
  await settings(context, event, "ChainlinkFeedSource", [
    [`band:${underlying}:minPrice`, { kind: "uint", uint: minPrice }],
    [`band:${underlying}:maxPrice`, { kind: "uint", uint: maxPrice }],
  ]);
});

v2ChainlinkSourcePonder.on("ChainlinkFeedSource:BandPinned", async ({ event, context }) => {
  const { underlying, expiry, minPrice, maxPrice } = event.args;
  const pin = `bandPinned:${underlying}:${expiry}`;
  await settings(context, event, "ChainlinkFeedSource", [
    [`${pin}:minPrice`, { kind: "uint", uint: minPrice }],
    [`${pin}:maxPrice`, { kind: "uint", uint: maxPrice }],
  ]);
});

v2UniV3SourcePonder.on("UniV3TwapSource:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "UniV3TwapSource", event.args.authority);
});

v2UniV3SourcePonder.on("UniV3TwapSource:OracleSet", async ({ event, context }) => {
  await setting(context, event, "UniV3TwapSource", `oracle:${event.args.oracle}`, { kind: "bool", bool: event.args.allowed });
});

v2UniV3SourcePonder.on("UniV3TwapSource:PoolSet", async ({ event, context }) => {
  const { underlying, pool, usdgIsToken0, minLiquidity, window } = event.args;
  await settings(context, event, "UniV3TwapSource", [
    [`pool:${underlying}`, { kind: "address", address: pool }],
    [`usdgIsToken0:${underlying}`, { kind: "bool", bool: usdgIsToken0 }],
    [`minLiquidity:${underlying}`, { kind: "uint", uint: BigInt(minLiquidity) }],
    [`window:${underlying}`, { kind: "uint", uint: BigInt(window) }],
  ]);
});

v2UniV3SourcePonder.on("UniV3TwapSource:PoolPinned", async ({ event, context }) => {
  const { underlying, expiry, pool, minLiquidity } = event.args;
  const pin = `pin:${underlying}:${expiry}`;
  await settings(context, event, "UniV3TwapSource", [
    [`${pin}:pool`, { kind: "address", address: pool }],
    [`${pin}:minLiquidity`, { kind: "uint", uint: BigInt(minLiquidity) }],
  ]);
});

v2DataStreamsSourcePonder.on("DataStreamsSource:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "DataStreamsSource", event.args.authority);
});

v2DataStreamsSourcePonder.on("DataStreamsSource:OracleSet", async ({ event, context }) => {
  await setting(context, event, "DataStreamsSource", `oracle:${event.args.oracle}`, { kind: "bool", bool: event.args.allowed });
});

// A Data Streams feed id is a bytes32, not an address; it goes in the text column as 0x-hex.
v2DataStreamsSourcePonder.on("DataStreamsSource:FeedSet", async ({ event, context }) => {
  await setting(context, event, "DataStreamsSource", `feedId:${event.args.underlying}`, { kind: "text", text: event.args.feedId });
});

v2DataStreamsSourcePonder.on("DataStreamsSource:FeedPinned", async ({ event, context }) => {
  const { underlying, expiry, feedId, version } = event.args;
  const pin = `pin:${underlying}:${expiry}`;
  await settings(context, event, "DataStreamsSource", [
    [`${pin}:feedId`, { kind: "text", text: feedId }],
    [`${pin}:version`, { kind: "uint", uint: BigInt(version) }],
  ]);
});

v2DataStreamsSourcePonder.on("DataStreamsSource:MultiplierRegimeChanged", async ({ event, context }) => {
  const { underlying, multiplier, epoch } = event.args;
  await settings(context, event, "DataStreamsSource", [
    [`multiplier:${underlying}`, { kind: "uint", uint: BigInt(multiplier) }],
    [`multiplierEpoch:${underlying}`, { kind: "uint", uint: BigInt(epoch) }],
  ]);
});
