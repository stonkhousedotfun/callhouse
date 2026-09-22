import schema from "ponder:schema";
import type { Address, Hex } from "viem";

import { USDG, V2_CLEARINGHOUSE } from "../../lib/env";
import {
  v2MakerVaultPonder,
  v2RewardsDistributorPonder,
  v2RewardsPonder,
} from "../../lib/registry";

const lower = <T extends string>(value: T): T => value.toLowerCase() as T;

function meta(event: {
  block: { timestamp: bigint; number: bigint };
  log: { logIndex: number; address: Address };
  transaction: { hash: Hex };
}) {
  return {
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    sourceAddress: lower(event.log.address),
    ts: event.block.timestamp,
    block: event.block.number,
    logIndex: event.log.logIndex,
    tx: event.transaction.hash,
  };
}

v2MakerVaultPonder.on("MakerVault:Withdrawn", async ({ event, context }) => {
  await context.db.insert(schema.v2TreasuryExit).values({
    ...meta(event), source: "makerVault", eventKind: "withdrawn", assetKind: "erc20",
    asset: lower(event.args.asset), tokenId: null,
    recipient: lower(event.args.to), amount: event.args.amount,
  });
});

v2MakerVaultPonder.on("MakerVault:PositionWithdrawn", async ({ event, context }) => {
  if (V2_CLEARINGHOUSE === undefined) throw new Error("V2_CLEARINGHOUSE is required for MakerVault positions");
  await context.db.insert(schema.v2TreasuryExit).values({
    ...meta(event), source: "makerVault", eventKind: "positionWithdrawn", assetKind: "erc1155",
    asset: lower(V2_CLEARINGHOUSE), tokenId: event.args.tokenId,
    recipient: lower(event.args.to), amount: event.args.units,
  });
});

v2RewardsPonder.on("KeeperRewards:Defunded", async ({ event, context }) => {
  await context.db.insert(schema.v2TreasuryExit).values({
    ...meta(event), source: "keeperRewards", eventKind: "defunded", assetKind: "erc20",
    asset: lower(USDG), tokenId: null,
    recipient: lower(event.args.to), amount: event.args.amount,
  });
});

v2RewardsDistributorPonder.on("RewardsDistributor:Defunded", async ({ event, context }) => {
  await context.db.insert(schema.v2TreasuryExit).values({
    ...meta(event), source: "rewardsDistributor", eventKind: "defunded", assetKind: "erc20",
    asset: lower(USDG), tokenId: null,
    recipient: lower(event.args.to), amount: event.args.amount,
  });
});
