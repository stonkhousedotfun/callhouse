import schema from "ponder:schema";
import { parseAbi, type Address } from "viem";

import { earnVaultAbi } from "../../abis/v2/earnVault";
import { EARN_SAMPLE_INTERVAL_S, EARN_VENUE_PROBE_SHARES, netOfSkim, pricePerShare } from "./earnYield";

/**
 * The hourly Earn price sampler, run from the V2Clock tick (clock.ts, every 600 blocks, about a minute).
 *
 * WHY A SAMPLER AND NOT EVENTS. A share price moves every block the venue accrues interest, with no log at all, so a
 * history built from Deposited/Redeemed would have holes exactly where a quiet vault earns. One eth_call batch per
 * vault per hour closes them for a few calls an hour: the tick checks the hour's row by primary key first and reads
 * nothing when it exists, so 59 of 60 ticks cost one indexed lookup and no RPC.
 *
 * WHAT IS READ, all at the tick's block (Ponder's context.client pins the block):
 *   vault    totalAssets, totalSupply, highWaterMark, skimBps, hasOpenPosition, adapter (earnVaultAbi, generated);
 *   adapter  venue()                                        (Erc4626VenueAdapter; not in the generated set);
 *   venue    name(), convertToAssets(EARN_VENUE_PROBE_SHARES) (the venue's own ERC-4626 views).
 * Each read fails on its own into null. The row is written only when totalAssets AND totalSupply were read: without
 * them there is no price, and writing a null row would take the hour's slot from the retry on the next tick.
 */

/** Erc4626VenueAdapter's views this package reads. Hand-listed because the adapter ABI is not generated here. */
export const earnVenueAdapterReadAbi = parseAbi([
  "function venue() view returns (address)",
  "function withdrawable() view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function maxIsAdvisory() view returns (bool)",
]);

/** The two ERC-4626 / ERC-20 views read from the venue itself. */
export const erc4626ReadAbi = parseAbi([
  "function name() view returns (string)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);

const ZERO = "0x0000000000000000000000000000000000000000";

/** `${vault}-${hour}`, the row's primary key: one row per vault per hour. */
export function earnSampleId(vault: string, ts: bigint): string {
  return `${vault.toLowerCase()}-${ts / BigInt(EARN_SAMPLE_INTERVAL_S)}`;
}

type SampleContext = {
  db: any;
  client: { readContract: (args: any) => Promise<unknown> };
};

async function read<T>(context: SampleContext, args: Record<string, unknown>): Promise<T | null> {
  try {
    return (await context.client.readContract(args)) as T;
  } catch {
    return null;
  }
}

const big = (value: unknown): bigint | null => (typeof value === "bigint" ? value : null);

/**
 * Samples one Earn vault at `event`'s block. `vault` / `startBlock` are the configured V2_EARN_VAULT and
 * V2_EARN_START_BLOCK, passed in so the tests drive every branch without env. Returns what it did, for the tests.
 */
export async function sampleEarnVault(input: {
  vault: Address | undefined;
  startBlock: number | undefined;
  event: { block: { number: bigint; timestamp: bigint } };
  context: SampleContext;
}): Promise<"unconfigured" | "before-deploy" | "exists" | "unread" | "written"> {
  const { vault, startBlock, event, context } = input;
  if (vault === undefined || startBlock === undefined) return "unconfigured";
  if (event.block.number < BigInt(startBlock)) return "before-deploy";
  const id = earnSampleId(vault, event.block.timestamp);
  if (await context.db.find(schema.v2EarnVaultSample, { id })) return "exists";

  const call = (functionName: string) => ({ abi: earnVaultAbi, address: vault, functionName });
  const [totalAssets, totalSupply, highWaterMark, skimBps, positionOpen, adapter] = await Promise.all([
    read<bigint>(context, call("totalAssets")).then(big),
    read<bigint>(context, call("totalSupply")).then(big),
    read<bigint>(context, call("highWaterMark")).then(big),
    read<number | bigint>(context, call("skimBps")).then((v) => (v === null ? null : Number(v))),
    read<boolean>(context, call("hasOpenPosition")).then((v) => (typeof v === "boolean" ? v : null)),
    read<Address>(context, call("adapter")),
  ]);
  if (totalAssets === null || totalSupply === null) return "unread";

  const attached = typeof adapter === "string" && adapter.toLowerCase() !== ZERO;
  const venue = attached
    ? await read<Address>(context, { abi: earnVenueAdapterReadAbi, address: adapter, functionName: "venue" })
    : null;
  const [venueName, venueProbeAssets] = venue === null || venue.toLowerCase() === ZERO
    ? [null, null]
    : await Promise.all([
      read<string>(context, { abi: erc4626ReadAbi, address: venue, functionName: "name", cache: "immutable" }),
      read<bigint>(context, {
        abi: erc4626ReadAbi, address: venue, functionName: "convertToAssets", args: [EARN_VENUE_PROBE_SHARES],
      }).then(big),
    ]);

  const price = pricePerShare(totalAssets, totalSupply);
  await context.db.insert(schema.v2EarnVaultSample).values({
    id,
    vault: vault.toLowerCase() as Address,
    ts: event.block.timestamp,
    block: event.block.number,
    totalAssets,
    totalSupply,
    highWaterMark,
    skimBps,
    pricePerShare: price,
    netPricePerShare: netOfSkim(price, highWaterMark, skimBps),
    positionOpen,
    adapter: typeof adapter === "string" ? (adapter.toLowerCase() as Address) : null,
    venue: venue === null ? null : (venue.toLowerCase() as Address),
    venueName: typeof venueName === "string" && venueName !== "" ? venueName : null,
    venueProbeAssets,
  }).onConflictDoNothing();
  return "written";
}
