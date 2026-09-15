import { createConfig } from "ponder";

import { erc20Abi } from "./abis/erc20";
import { stockTokenAbi } from "./abis/stockToken";
import { seaportAbi } from "./abis/seaport";
import { valoremClearAbi } from "./abis/valoremClear";
import { vaultAbi } from "./abis/vault";
import {
  ASSET,
  CHAIN_ID,
  CLEARINGHOUSE,
  END_BLOCK,
  PGLITE_DIRECTORY,
  RPC_URL,
  SEAPORT,
  START_BLOCK,
  USDG,
  VAULT,
} from "./lib/env";

/**
 * Stonkhouse indexer — chain 4663 (Robinhood Chain mainnet), one vault.
 *
 * Sources, and why each one is here:
 *
 *   Vault          every event the vault emits. This is the primary record, and under write on
 *                  fill it is also the clock: `RollOpen` is what creates a week in the tape (the
 *                  vault numbers its own cycles; there is no registry), and `CallsWritten` fires
 *                  once per Seaport fill with that fill's size.
 *   Clear          Valorem. Writes and redemptions are topic-filtered to the vault; exercise
 *                  and bucket-assignment events cannot be (the vault is not a topic on
 *                  them), so they are filtered in the handler against the option id we armed.
 *                  Valorem's whole log history on this chain is tiny, so that is cheap.
 *   Seaport        `OrderFulfilled` topic-filtered to the vault as offerer. Every fill of the
 *                  vault's PARTIAL_RESTRICTED listing (zone == the vault) lands here with the
 *                  contracts moved and the USDG paid; the vault's `CallsWritten` in the same
 *                  transaction is the write it caused.
 *   StockTokenIn /
 *   StockTokenOut  asset movements in and out of the vault, which give an exact running
 *                  balance without an RPC read. Two sources because a log filter ANDs its
 *                  topics: `from == vault` and `to == vault` cannot be ORed in one filter.
 *   UsdgIn /
 *   UsdgOut        the same trick for USDG, so the vault's premium balance is exact and the
 *                  harvest accounting can be checked against it without an RPC read.
 *   StockToken     the issuer's switches: oracle pause, transfer pause, and the ERC-8056
 *                  multiplier. A paused oracle blocks every arm and every fill, and a transfer
 *                  freeze blocks settlement. Neither is something we can code around, so both
 *                  are indexed and published.
 *
 * Every source starts at START_BLOCK (the vault's deploy block). END_BLOCK is normally unset —
 * production follows the head — and exists to bound a replay for a dry-run.
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

    Clear: {
      abi: valoremClearAbi,
      chain: "robinhood",
      address: CLEARINGHOUSE,
      startBlock: START_BLOCK,
      endBlock: END_BLOCK,
      filter: [
        // `writer` is topic2 on OptionsWritten, `redeemer` is topic3 on ClaimRedeemed, so
        // both narrow to the vault at the node. The other three Valorem events carry no
        // address for us, only an optionId or a claimId, and are filtered in the handlers.
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
