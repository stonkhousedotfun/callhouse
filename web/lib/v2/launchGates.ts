/**
 * Launch gates: is a launch market's trading on, and is its House vault quoting? Read on chain, nothing else.
 *
 * Two EFFECTS per launch market, never inferred from each other or from the indexer:
 *   - trading  `Clearinghouse.market(asset).enabled`
 *   - house    `HouseVault.protocolAccountsConfirmed()` on the registry's vault for the market
 *
 * NO SCHEDULE AND NO CLOCK. This module used to read the AccessManager schedule of the live v8 launch's
 * Safe operations (hard-coded operation ids) and count down to them. The zero-delay redeploy enables the markets and
 * arms the House vaults inside the deploy window, so there is nothing to count down to, and those operation ids name
 * nothing on the new AccessManager. What stays are the two chain facts, because they are guards, not timers:
 * MarketAccessGate lets `enabled` outrank an indexer that lists no markets, and the House deposit controls stay shut
 * until the vault is armed. A gate that is unread or errored is NOT open.
 */
import { getAddress, type PublicClient } from "viem";

import { clearinghouseAbi } from "../abi/v2/clearinghouse";
import { houseVaultAbi } from "../abi/v2/houseVault";
import { publicClient } from "../chain";
import { GENERATED_MARKETS, LAUNCH_SET } from "../markets.generated";
import { requireV2Address } from "./config";

export type LaunchGates = {
  /** Trading on each launch market: `Clearinghouse.market(asset).enabled`. */
  trading: Readonly<Record<string, boolean>>;
  /**
   * Each launch market's registry House vault quoting: `HouseVault.protocolAccountsConfirmed()`. A market with no
   * registry vault has no entry. This is the REGISTRY vault; the House page's deposit gate reads the vault its deposit
   * writes to instead (chainReads.readHouseVault), because with daily vaults the two can differ.
   */
  house: Readonly<Record<string, boolean>>;
};

/**
 * May the House deposit controls be used?
 *
 * FAIL CLOSED, and that is the whole point of the helper. `undefined` or `null` is the arming still being read, or a
 * read that errored, and an unread arming must not open a deposit: money would go into a vault whose quoting state
 * nobody has established. Only a `true` read back from chain opens it.
 */
export function houseDepositsOpen(armed: boolean | null | undefined): boolean {
  return armed === true;
}

/**
 * The launch markets whose House vault is not armed yet, for an index that stands for all of them (/vaults). `null`
 * while the gates are unread, so a caller cannot mistake "not read" for "none pending". An empty list means every
 * launch House vault is armed.
 */
export function pendingHouseMarkets(house: Readonly<Record<string, boolean>> | undefined): string[] | null {
  if (!house) return null;
  return Object.entries(house).filter(([, armed]) => !houseDepositsOpen(armed)).map(([ticker]) => ticker);
}

function launchMarkets() {
  return LAUNCH_SET.markets.map((ticker) => {
    const row = GENERATED_MARKETS.find((m) => m.ticker === ticker);
    if (!row) throw new Error(`launch market ${ticker} is not in the generated registry`);
    return { ticker, asset: getAddress(row.asset), houseVault: row.v2.houseVault ? getAddress(row.v2.houseVault) : null };
  });
}

export async function readLaunchGates(client: PublicClient = publicClient): Promise<LaunchGates> {
  const clearinghouse = requireV2Address("clearinghouse");
  const trading: Record<string, boolean> = {};
  const house: Record<string, boolean> = {};
  await Promise.all(launchMarkets().map(async (market) => {
    const [config, armed] = await Promise.all([
      client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "market", args: [market.asset] }),
      market.houseVault
        ? client.readContract({ address: market.houseVault, abi: houseVaultAbi, functionName: "protocolAccountsConfirmed" })
        : Promise.resolve(null),
    ]);
    trading[market.ticker] = config.enabled;
    if (armed !== null) house[market.ticker] = armed;
  }));
  return { trading, house };
}
