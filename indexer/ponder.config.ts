import { createConfig } from "ponder";

import { erc20Abi } from "./abis/erc20";
import { stockTokenAbi } from "./abis/stockToken";
import { overcallRegistryAbi } from "./abis/overcallRegistry";
import { seaportAbi } from "./abis/seaport";
import { valoremClearAbi } from "./abis/valoremClear";
import { vaultAbi } from "./abis/vault";
import {
  ASSET,
  CHAIN_ID,
  CLEARINGHOUSE,
  END_BLOCK,
  PGLITE_DIRECTORY,
  REGISTRY,
  REGISTRY_START_BLOCK,
  RPC_URL,
  SEAPORT,
  START_BLOCK,
  USDG,
  VAULT,
} from "./lib/env";

/**
 * Callhouse indexer — chain 4663 (Robinhood Chain mainnet), one vault.
 *
 * Sources, and why each one is here:
 *
 *   Vault          every event the vault emits. This is the primary record.
 *   Registry       Overcall's NVDA registry. `CycleSet` is what creates a week in the tape,
 *                  including weeks the vault never wrote into. Bound to the registry, never
 *                  to the wall clock — the registry's own gates (`isWritingOpen`,
 *                  `writeDeadline`) are the only truth about when a week is open.
 *   Clear          Valorem. Writes and redemptions are topic-filtered to the vault; exercise
 *                  and bucket-assignment events cannot be (the vault is not a topic on
 *                  them), so they are filtered in the handler against the option id we wrote.
 *                  Valorem's whole log history on this chain is tiny, so that is cheap.
 *   Seaport        `OrderFulfilled` topic-filtered to the vault as offerer. This is the only
 *                  place the REAL fill price and the REAL number of contracts sold exist:
 *                  the vault's own `contractsSold` is never written on chain.
 *   StockTokenIn /
 *   StockTokenOut  asset movements in and out of the vault, which give an exact running
 *                  balance without an RPC read. Two sources because a log filter ANDs its
 *                  topics: `from == vault` and `to == vault` cannot be ORed in one filter.
 *   UsdgIn /
 *   UsdgOut        the same trick for USDG, so the vault's premium balance is exact and the
 *                  harvest accounting can be checked against it without an RPC read.
 *   StockToken     the issuer's switches: oracle pause, transfer pause, and the ERC-8056
 *                  multiplier. A paused oracle blocks every write, and a transfer freeze
 *                  blocks settlement. Neither is something we can code around, so both are
 *                  indexed and published.
 *
 * Every source starts at START_BLOCK (the vault's deploy block) except the registry, which
 * may start earlier so pre-deployment cycles land in the tape too. END_BLOCK is normally
 * unset — production follows the head — and exists to bound a replay for a dry-run.
 */
export default createConfig({
  // Only when PGLITE_DIRECTORY is set (the fork sync's throwaway database). Otherwise Ponder
  // decides: Postgres if DATABASE_URL is set, `.ponder/pglite` if not.
  ...(PGLITE_DIRECTORY === undefined
    ? {}
    : { database: { kind: "pglite" as const, directory: PGLITE_DIRECTORY } }),
  chains: {
    robinhood: {
      id: CHAIN_ID,
      rpc: RPC_URL,
      // 4663 is an Orbit L2 with sub-second blocks; poll a little faster than the default.
      pollingInterval: 2_000,
    },
  },
  contracts: {
    Vault: {
      abi: vaultAbi,
      chain: "robinhood",
      address: VAULT,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
    },

    Registry: {
      abi: overcallRegistryAbi,
      chain: "robinhood",
      address: REGISTRY,
      startBlock: REGISTRY_START_BLOCK,
      endBlock: END_BLOCK,
    },

    Clear: {
      abi: valoremClearAbi,
      chain: "robinhood",
      address: CLEARINGHOUSE,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
      filter: [
        // `writer` is topic2 on OptionsWritten, `redeemer` is topic3 on ClaimRedeemed, so
        // both narrow to the vault at the node. The other two Valorem events carry no
        // address for us, only an optionId, and are filtered in the handlers.
        { event: "OptionsWritten", args: { writer: VAULT } },
        { event: "ClaimRedeemed", args: { redeemer: VAULT } },
      ],
    },

    Seaport: {
      abi: seaportAbi,
      chain: "robinhood",
      address: SEAPORT,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
      filter: [
        { event: "OrderFulfilled", args: { offerer: VAULT } },
        { event: "OrderCancelled", args: { offerer: VAULT } },
        { event: "CounterIncremented", args: { offerer: VAULT } },
      ],
    },

    StockTokenIn: {
      abi: stockTokenAbi,
      chain: "robinhood",
      address: ASSET,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
      filter: [{ event: "Transfer", args: { to: VAULT } }],
    },

    StockTokenOut: {
      abi: stockTokenAbi,
      chain: "robinhood",
      address: ASSET,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
      filter: [{ event: "Transfer", args: { from: VAULT } }],
    },

    // The issuer's own switches. Unfiltered by address on purpose: they are contract-wide and
    // carry no counterparty, and every one of them can stop this vault dead.
    StockToken: {
      abi: stockTokenAbi,
      chain: "robinhood",
      address: ASSET,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
    },

    UsdgIn: {
      abi: erc20Abi,
      chain: "robinhood",
      address: USDG,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
      filter: [{ event: "Transfer", args: { to: VAULT } }],
    },

    UsdgOut: {
      abi: erc20Abi,
      chain: "robinhood",
      address: USDG,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
      filter: [{ event: "Transfer", args: { from: VAULT } }],
    },
  },
});
