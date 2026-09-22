import schema from "ponder:schema";

import {
  v2MakerVaultPonder,
  v2Ponder,
  v2RewardsDistributorPonder,
  v2RewardsPonder,
} from "../../lib/registry";

/**
 * T-295: the value-bearing events that had no column to land in.
 *
 * These are not configuration. Each one moves money, publishes a commitment, or records an exposure,
 * and each was read by the indexer and dropped because ponder.schema.ts had nowhere to put it. They
 * are separated from src/v2/adminConfig.ts because their facts have shape: a Merkle root is not a
 * setting, and a claim is not a pointer change.
 *
 * Event names are literal here for the same reason as in adminConfig.ts — the census in
 * src/v2/eventCoverage.test.ts parses these call expressions.
 */

type Context = { db: any };
type EventLike = {
  block: { timestamp: bigint; number: bigint };
  log: { logIndex: number; address: `0x${string}` };
  transaction: { hash: `0x${string}` };
};

/** `${tx}-${logIndex}`: unique per log, and the id every append-only table below uses. */
const logId = (event: EventLike): string => `${event.transaction.hash}-${event.log.logIndex}`;

/** The coordinates an append-only row carries. */
const stamp = (event: EventLike) => ({
  ts: event.block.timestamp,
  block: event.block.number,
  logIndex: event.log.logIndex,
  tx: event.transaction.hash,
});

/* --------------------------------------------------------------- funding in */

/**
 * USDG paid into the keeper budget. The paid-OUT side is v2KeeperReward; without this the budget
 * could only be seen shrinking, and "the keeper stopped because the budget ran out" was
 * indistinguishable from "the keeper stopped".
 */
v2RewardsPonder.on("KeeperRewards:Funded", async ({ event, context }) => {
  await context.db.insert(schema.v2ContractFunding).values({
    id: logId(event), source: "KeeperRewards", contract: event.log.address,
    from: event.args.from, amount: event.args.amount, ...stamp(event),
  });
});

/** The same fact for the lender-rewards distributor: an epoch root is only claimable if funded. */
v2RewardsDistributorPonder.on("RewardsDistributor:Funded", async ({ event, context }) => {
  await context.db.insert(schema.v2ContractFunding).values({
    id: logId(event), source: "RewardsDistributor", contract: event.log.address.toLowerCase(),
    from: event.args.from, amount: event.args.amount, ...stamp(event),
  });
});

/** Which contracts may spend the keeper budget. An allow-list, so it is a row per caller. */
v2RewardsPonder.on("KeeperRewards:CallerSet", async ({ event, context }) => {
  const values = {
    registered: event.args.registered,
    changedAt: event.block.timestamp,
    changedBlock: event.block.number,
    changedLogIndex: event.log.logIndex,
    changedTx: event.transaction.hash,
  };
  await context.db.insert(schema.v2KeeperCaller)
    .values({ caller: event.args.caller, ...values })
    .onConflictDoUpdate(values);
});

/* ------------------------------------------------------------ lender rewards */

/**
 * The published Merkle root for one epoch. The claim UI checks a proof against this root and shows
 * the epoch total; off-chain epoch generation computes the same numbers, and a disagreement between
 * the generator's root and this one is exactly the thing that must be visible before a claim opens.
 */
v2RewardsDistributorPonder.on("RewardsDistributor:RootSet", async ({ event, context }) => {
  const distributor = event.log.address.toLowerCase();
  const values = {
    distributor, epoch: event.args.epoch,
    root: event.args.root, total: event.args.total,
    setAt: event.block.timestamp, setBlock: event.block.number,
    setLogIndex: event.log.logIndex, setTx: event.transaction.hash,
  };
  await context.db.insert(schema.v2RewardsEpoch)
    .values({ id: `${distributor}-${event.args.epoch}`, ...values })
    .onConflictDoUpdate(values);
});

/**
 * One spent leaf. Keyed by (distributor, epoch, index) rather than by the log, because a leaf is
 * claim-once inside one distributor instance. Replacements may reuse epoch and leaf numbers; a
 * second Claimed for the same instance and leaf surfaces as a conflict instead of storing both.
 */
v2RewardsDistributorPonder.on("RewardsDistributor:Claimed", async ({ event, context }) => {
  const { epoch, index, account, amount } = event.args;
  const distributor = event.log.address.toLowerCase();
  await context.db.insert(schema.v2RewardsClaim).values({
    id: `${distributor}-${epoch}-${index}`, distributor,
    epoch, leafIndex: index, account, amount, ...stamp(event),
  });
});

/* -------------------------------------------------------- treasury MakerVault */

/** Capital in. The out side is v2TreasuryExit (src/v2/treasury.ts, source "makerVault"). */
v2MakerVaultPonder.on("MakerVault:Deposited", async ({ event, context }) => {
  await context.db.insert(schema.v2MakerVaultDeposit).values({
    id: logId(event), asset: event.args.asset, from: event.args.from,
    amount: event.args.amount, ...stamp(event),
  });
});

/**
 * Exposure to one series, with the vault-wide total the limits are judged against. Stored as
 * emitted: recomputing `totalNotional` from the per-series rows would make this table agree with
 * itself rather than with the vault.
 */
v2MakerVaultPonder.on("MakerVault:ExposureSet", async ({ event, context }) => {
  const values = {
    units: event.args.units, notional: event.args.notional,
    totalNotional: event.args.totalNotional,
    updatedAt: event.block.timestamp, updatedBlock: event.block.number,
    updatedLogIndex: event.log.logIndex, updatedTx: event.transaction.hash,
  };
  await context.db.insert(schema.v2MakerVaultExposure)
    .values({ longId: event.args.longId, ...values })
    .onConflictDoUpdate(values);
});

/** The limits themselves, so the exposure above can be read against them. */
v2MakerVaultPonder.on("MakerVault:LimitsSet", async ({ event, context }) => {
  const l = event.args.limits;
  const values = {
    maxSeriesUnits: BigInt(l.maxSeriesUnits),
    maxTotalNotional: BigInt(l.maxTotalNotional),
    askToleranceBps: l.askToleranceBps,
    maxBidBpsOfSpot: l.maxBidBpsOfSpot,
    maxOrderLifetime: BigInt(l.maxOrderLifetime),
    maxDailyOutflow: BigInt(l.maxDailyOutflow),
    updatedAt: event.block.timestamp, updatedBlock: event.block.number,
    updatedLogIndex: event.log.logIndex, updatedTx: event.transaction.hash,
  };
  await context.db.insert(schema.v2MakerVaultLimits)
    .values({ vault: event.log.address, ...values })
    .onConflictDoUpdate(values);
});

/* ------------------------------------------------------------------ OrderBook */

/**
 * An owed balance withdrawn. The book credits `owed` when a payout to a maker fails; that credit is
 * indexed and the withdrawal was not, so an owed balance looked permanent once it appeared.
 */
v2Ponder.on("OrderBook:OwedClaimed", async ({ event, context }) => {
  await context.db.insert(schema.v2OwedClaim).values({
    id: logId(event), account: event.args.account, amount: event.args.amount, ...stamp(event),
  });
});

/* ------------------------------------------------------------ SettlementOracle */

/** A market's source list and fallback-chain parameters, in the priority order emitted. */
v2Ponder.on("SettlementOracle:MarketConfigured", async ({ event, context }) => {
  const values = {
    sources: event.args.sources.map((source: string) => source.toLowerCase()),
    maxDeviationBps: event.args.maxDeviationBps,
    uncorroboratedDelayS: BigInt(event.args.uncorroboratedDelay),
    spotMaxAgeS: BigInt(event.args.spotMaxAge),
    updatedAt: event.block.timestamp, updatedBlock: event.block.number,
    updatedLogIndex: event.log.logIndex, updatedTx: event.transaction.hash,
  };
  await context.db.insert(schema.v2OracleMarketConfig)
    .values({ underlying: event.args.underlying, ...values })
    .onConflictDoUpdate(values);
});

/**
 * The configuration pinned to one expiry. This is the copy a settlement is judged by — a later
 * MarketConfigured never moves it — so a dispute is answered from this row rather than from the
 * market's current configuration. The event carries no spotMaxAge, and none is invented here.
 */
v2Ponder.on("SettlementOracle:SettlementConfigPinned", async ({ event, context }) => {
  const { underlying, expiry } = event.args;
  const values = {
    underlying, expiry: BigInt(expiry),
    sources: event.args.sources.map((source: string) => source.toLowerCase()),
    maxDeviationBps: event.args.maxDeviationBps,
    uncorroboratedDelayS: BigInt(event.args.uncorroboratedDelay),
    pinnedAt: event.block.timestamp, pinnedBlock: event.block.number,
    pinnedLogIndex: event.log.logIndex, pinnedTx: event.transaction.hash,
  };
  await context.db.insert(schema.v2OracleExpiryConfig)
    .values({ id: `${underlying.toLowerCase()}-${expiry}`, ...values })
    .onConflictDoUpdate(values);
});
