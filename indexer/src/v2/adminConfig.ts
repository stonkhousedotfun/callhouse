import schema from "ponder:schema";

import {
  v2CalendarPonder,
  v2EarnVaultPonder,
  v2FeeSplitterPonder,
  v2HouseVaultPonder,
  v2MakerVaultPonder,
  v2PayoutRouterPonder,
  v2Ponder,
  v2RewardsDistributorPonder,
  v2RewardsPonder,
} from "../../lib/registry";

/**
 * T-295: the admin-configuration facts the indexer read and dropped.
 *
 * Every restricted v8 contract emits `AuthorityUpdated` when its AccessManager is set or re-pointed,
 * and each one emits a `*Set` event per pointer or parameter. None of them had a handler, and none
 * had a column: adding a handler without a column persists nothing, which is why T-301 could only
 * fence the source-level half of this problem.
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
    id: `${event.transaction.hash}-${event.log.logIndex}`,
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
});

v2FeeSplitterPonder.on("FeeSplitter:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "FeeSplitter", event.args.authority);
});

v2HouseVaultPonder.on("HouseVault:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "HouseVault", event.args.authority);
});

v2HouseVaultPonder.on("HouseVaultFactory:AuthorityUpdated", async ({ event, context }) => {
  await authority(context, event, "HouseVaultFactory", event.args.authority);
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

v2Ponder.on("Clearinghouse:MinRedeemPayoutSet", async ({ event, context }) => {
  await setting(context, event, "Clearinghouse", "minRedeemPayout", { kind: "uint", uint: BigInt(event.args.amount) });
});

v2FeeSplitterPonder.on("FeeSplitter:BurnBpsSet", async ({ event, context }) => {
  await setting(context, event, "FeeSplitter", "burnBps", { kind: "uint", uint: BigInt(event.args.burnBps) });
});

v2FeeSplitterPonder.on("FeeSplitter:BuybackCapSet", async ({ event, context }) => {
  await setting(context, event, "FeeSplitter", "buybackCapUsdg", { kind: "uint", uint: BigInt(event.args.perCallUsdg) });
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
