import type { Address } from "viem";
import { makerEpochUtc } from "./windows";

/** RewardsDistributor epoch ids use Monday 00:00 UTC (frozen interface §1.9). */
export const makerEpoch = makerEpochUtc;

export const makerEpochId = (maker: Address, epoch: bigint): string =>
  `${maker.toLowerCase()}-${epoch}`;

/** An explicit zero tier means the book's default rebate, not a missing event. */
export function reduceTier(_previous: number, rebateBps: number): number {
  return rebateBps;
}
