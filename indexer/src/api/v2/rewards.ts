import { db } from "ponder:api";
import schema from "ponder:schema";
import type { Hono } from "hono";
import { and, asc, desc, eq, inArray } from "ponder";
import type { Address, Hex } from "viem";

import { V2_REWARDS_DISTRIBUTORS } from "../../../lib/env";
import {
  REWARD_EPOCH_FILES,
  type RewardEpochProjection,
} from "../../../lib/v2/rewardEpochFiles.generated";
import type { RewardDistributor } from "../../../lib/v2/rewardDistributors";
import { readRewardBalances } from "./chain";
import { address, error, limit, money, nextOffset, offset, parseAddress } from "./shared";

type EpochRow = {
  distributor: string;
  epoch: bigint;
  root: string;
  total: bigint;
};

type ClaimRow = {
  distributor: string;
  epoch: bigint;
  leafIndex: bigint;
  account: string;
  amount: bigint;
  tx: string;
};

export type MergedRewardClaim = {
  program: string;
  distributor: Address;
  epochId: number;
  index: number;
  amount: bigint;
  claimed: boolean;
  tx: Hex | null;
};

const claimKey = (distributor: string, epoch: bigint | number, index: bigint | number) =>
  `${distributor.toLowerCase()}-${epoch}-${index}`;

function safeNumber(value: bigint, what: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${what} is outside the API integer range`);
  return result;
}

/** Merge event truth with root-matched committed leaves; event rows always win. */
export function mergeRewardClaims(
  account: Address,
  distributors: readonly RewardDistributor[],
  epochs: readonly EpochRow[],
  claimedRows: readonly ClaimRow[],
  files: readonly RewardEpochProjection[] = REWARD_EPOCH_FILES,
): MergedRewardClaim[] {
  const configured = new Map(distributors.map((item) => [item.address.toLowerCase(), item]));
  const merged = new Map<string, MergedRewardClaim>();
  const spent = new Set(claimedRows.map((row) => claimKey(row.distributor, row.epoch, row.leafIndex)));

  for (const row of claimedRows) {
    const config = configured.get(row.distributor.toLowerCase());
    if (config === undefined || row.account.toLowerCase() !== account.toLowerCase()) continue;
    const epochId = safeNumber(row.epoch, "reward epoch");
    const index = safeNumber(row.leafIndex, "reward leaf index");
    merged.set(claimKey(row.distributor, row.epoch, row.leafIndex), {
      program: config.program,
      distributor: address(row.distributor),
      epochId,
      index,
      amount: row.amount,
      claimed: true,
      tx: row.tx as Hex,
    });
  }

  const filesByProgramEpoch = new Map(files.map((file) => [`${file.program}-${file.epoch}`, file]));
  for (const epoch of epochs) {
    const config = configured.get(epoch.distributor.toLowerCase());
    if (config === undefined) continue;
    const epochId = safeNumber(epoch.epoch, "reward epoch");
    const file = filesByProgramEpoch.get(`${config.program}-${epochId}`);
    if (file === undefined || file.root.toLowerCase() !== epoch.root.toLowerCase()) continue;
    const entry = file.entries.find((candidate) => candidate.account.toLowerCase() === account.toLowerCase());
    if (entry === undefined) continue;
    const key = claimKey(epoch.distributor, epoch.epoch, entry.index);
    if (spent.has(key) || merged.has(key)) continue;
    merged.set(key, {
      program: config.program,
      distributor: address(epoch.distributor),
      epochId,
      index: entry.index,
      amount: BigInt(entry.amount),
      claimed: false,
      tx: null,
    });
  }

  return [...merged.values()].sort((left, right) =>
    right.epochId - left.epochId || left.program.localeCompare(right.program) ||
    left.distributor.localeCompare(right.distributor) || left.index - right.index);
}

function add(map: Map<string, bigint>, key: string, value: bigint) {
  map.set(key, (map.get(key) ?? 0n) + value);
}

export function registerRewardRoutes(app: Hono) {
  app.get("/rewards/epochs", async (c) => {
    const program = c.req.query("program");
    const configured = program === undefined ? [] : V2_REWARDS_DISTRIBUTORS.filter((item) => item.program === program);
    if (program === undefined || configured.length === 0) {
      return error(c, "bad_program", "Program is missing or unknown.");
    }
    const start = offset(c.req.query("cursor"));
    if (start === null) return error(c, "bad_cursor", "Cursor is outside the supported page range.");
    const size = limit(c.req.query("limit"));
    const addresses = configured.map((item) => item.address.toLowerCase() as Address);
    const [epochRows, claimRows, fundingRows, defundingRows, balances] = await Promise.all([
      db.select().from(schema.v2RewardsEpoch)
        .where(inArray(schema.v2RewardsEpoch.distributor, addresses))
        .orderBy(desc(schema.v2RewardsEpoch.epoch), asc(schema.v2RewardsEpoch.distributor))
        .limit(size + 1).offset(start),
      db.select().from(schema.v2RewardsClaim)
        .where(inArray(schema.v2RewardsClaim.distributor, addresses)),
      db.select().from(schema.v2ContractFunding).where(and(
        eq(schema.v2ContractFunding.source, "RewardsDistributor"),
        inArray(schema.v2ContractFunding.contract, addresses),
      )),
      db.select().from(schema.v2TreasuryExit).where(and(
        eq(schema.v2TreasuryExit.source, "rewardsDistributor"),
        inArray(schema.v2TreasuryExit.sourceAddress, addresses),
      )),
      readRewardBalances(configured.map((item) => item.address)),
    ]);
    if (configured.some((item) => !balances.has(item.address.toLowerCase()))) {
      return error(c, "rewards_unavailable", "Reward token balances are temporarily unavailable.", 503);
    }

    const funded = new Map<string, bigint>();
    const defunded = new Map<string, bigint>();
    const claimed = new Map<string, bigint>();
    for (const row of fundingRows) add(funded, row.contract.toLowerCase(), row.amount);
    for (const row of defundingRows) add(defunded, row.sourceAddress.toLowerCase(), row.amount);
    for (const row of claimRows) add(claimed, `${row.distributor.toLowerCase()}-${row.epoch}`, row.amount);

    const selected = epochRows.slice(0, size);
    return c.json({
      program,
      distributors: configured.map((item) => {
        const live = balances.get(item.address.toLowerCase())!;
        return {
          distributor: item.address,
          funded: money(funded.get(item.address.toLowerCase()) ?? 0n, live.decimals),
          defunded: money(defunded.get(item.address.toLowerCase()) ?? 0n, live.decimals),
          balance: money(live.balance, live.decimals),
        };
      }),
      items: selected.map((row) => {
        const live = balances.get(row.distributor.toLowerCase())!;
        return {
          distributor: address(row.distributor),
          epochId: safeNumber(row.epoch, "reward epoch"),
          root: row.root,
          total: money(row.total, live.decimals),
          claimed: money(claimed.get(`${row.distributor.toLowerCase()}-${row.epoch}`) ?? 0n, live.decimals),
        };
      }),
      nextCursor: nextOffset(start, size, epochRows.length > size),
    });
  });

  app.get("/rewards/:address/claims", async (c) => {
    const account = parseAddress(c.req.param("address"));
    if (account === null) return error(c, "bad_address", "Address must be an EVM address.");
    const start = offset(c.req.query("cursor"));
    if (start === null) return error(c, "bad_cursor", "Cursor is outside the supported page range.");
    const size = limit(c.req.query("limit"));
    const distributors = V2_REWARDS_DISTRIBUTORS;
    if (distributors.length === 0) return c.json({ address: account, items: [], nextCursor: null });
    const addresses = distributors.map((item) => item.address.toLowerCase() as Address);
    const [epochs, claimedRows, balances] = await Promise.all([
      db.select().from(schema.v2RewardsEpoch).where(inArray(schema.v2RewardsEpoch.distributor, addresses)),
      // Read every claimed index, not only this account's rows: the contract bitmap is keyed by
      // index, so a spent bit must suppress an off-chain leaf even if the indexed event's account
      // disagrees with the committed file.
      db.select().from(schema.v2RewardsClaim)
        .where(inArray(schema.v2RewardsClaim.distributor, addresses)),
      readRewardBalances(distributors.map((item) => item.address)),
    ]);
    if (distributors.some((item) => !balances.has(item.address.toLowerCase()))) {
      return error(c, "rewards_unavailable", "Reward token balances are temporarily unavailable.", 503);
    }
    const items = mergeRewardClaims(account, distributors, epochs, claimedRows);
    const selected = items.slice(start, start + size);
    return c.json({
      address: account,
      items: selected.map((item) => ({
        ...item,
        amount: money(item.amount, balances.get(item.distributor.toLowerCase())!.decimals),
      })),
      nextCursor: nextOffset(start, size, start + size < items.length),
    });
  });
}
