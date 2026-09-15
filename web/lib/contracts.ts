import { getAddress, isAddress, type Address } from "viem";

import { valoremClearAbi } from "./abi/clear";
import { erc20Abi, stockTokenAbi } from "./abi/erc20";
import { seaportAbi } from "./abi/seaport";
import { vaultAbi } from "./abi/vault";
import { accountFactoryAbi } from "./abi/accountFactory";
import { writerAccountAbi } from "./abi/writerAccount";

export { valoremClearAbi, erc20Abi, stockTokenAbi, seaportAbi, vaultAbi, accountFactoryAbi, writerAccountAbi };

/**
 * Addresses.
 *
 * Everything except the vault is a third-party contract whose address on 4663 was confirmed by
 * eth_getCode during recon (ops/addresses.json, ops/recon/*). Those are compiled in as defaults
 * so a misconfigured .env cannot quietly point this UI at the wrong market — the env var is an
 * override for a fork or a rehearsal deploy, not a blank to be filled in.
 *
 * The vault has NO default. It does not exist until we deploy it, and inventing an address
 * would be worse than rendering "not configured".
 *
 * There is no registry and no third-party fee recipient any more. The vault reads the weekly
 * option type from the clearinghouse itself, numbers its own cycles, and every listing pays ONE
 * USDG leg to the vault (contracts/README.md "No registry"). The clearinghouse is a deploy-time
 * choice: `vault.clear()` is the authority, and NEXT_PUBLIC_CLEARINGHOUSE must agree with it.
 */
function fromEnv(name: string, value: string | undefined, fallback?: Address): Address | undefined {
  const raw = value?.trim();
  if (!raw) return fallback;
  if (!isAddress(raw)) {
    // Never throw at module scope: that would take down a statically prerendered page and
    // replace a fixable config message with a build failure.
    if (typeof console !== "undefined") console.error(`[contracts] ${name} is not an address: ${raw}`);
    return fallback;
  }
  return getAddress(raw);
}

/** Stonkhouse vault (cNVDA). Deploy-time only — set NEXT_PUBLIC_VAULT. */
export const VAULT = fromEnv("NEXT_PUBLIC_VAULT", process.env.NEXT_PUBLIC_VAULT);

/** Isolated 1-lot account factory. The product. Deployed 2026-09-15. */
export const FACTORY = fromEnv(
  "NEXT_PUBLIC_FACTORY",
  process.env.NEXT_PUBLIC_FACTORY,
  getAddress("0xc4A5Cd0DE91CaB7F5Ebe2114bc63Fbb43E642BBb"),
)!;

/** NVDA Stock Token, 18 decimals, proxy. The vault's `asset`. */
export const ASSET = fromEnv(
  "NEXT_PUBLIC_ASSET",
  process.env.NEXT_PUBLIC_ASSET,
  getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"),
)!;

/** USDG, 6 decimals. Every premium, strike and claim in this app is denominated in it. */
export const USDG = fromEnv(
  "NEXT_PUBLIC_USDG",
  process.env.NEXT_PUBLIC_USDG,
  getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
)!;

/**
 * The Valorem clearinghouse the vault was constructed with. Holds the option ERC-1155s and the
 * vault's claim NFT; the vault reads each week's option tuple (strike, exercise, expiry, lot)
 * from it. The default is the Clear the live vault was constructed with: our own
 * ValoremOptionsClearinghouse (contracts/script/DeployClear.s.sol), whose runtime equals the
 * upstream build apart from the metadata hash. It is not Overcall's instance at 0x9a7b…C0C0.
 */
export const CLEARINGHOUSE = fromEnv(
  "NEXT_PUBLIC_CLEARINGHOUSE",
  process.env.NEXT_PUBLIC_CLEARINGHOUSE,
  getAddress("0x53d7A6d0489Daf3d67b9A314e0eAB2B78Acab9C6"),
)!;

/** Seaport 1.6. The vault is the offerer AND the zone of its own listing; Seaport pulls directly. */
export const SEAPORT = fromEnv(
  "NEXT_PUBLIC_SEAPORT",
  process.env.NEXT_PUBLIC_SEAPORT,
  getAddress("0x0000000000000068F116a894984e2DB1123eB395"),
)!;

/**
 * Seaport's zero conduit key. The vault is deployed with `conduitKey == 0` (approvals go to
 * Seaport itself), and `vault.conduitKey()` is read live to confirm it before any fill.
 */
export const ZERO_CONDUIT_KEY = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
export const ZERO_HASH = ZERO_CONDUIT_KEY;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** Decimals. USDG is 6, the Stock Token is 18, and vault shares follow the asset at 18. */
export const USDG_DECIMALS = 6;
export const ASSET_DECIMALS = 18;
export const SHARE_DECIMALS = 18;

/**
 * One contract = one lot = 1.0 Stock Token. Compiled into the vault (Policy.LOT); the arm gate
 * refuses any option type whose `underlyingAmount` differs, so this is a fact, not a default.
 */
export const LOT_SIZE = 10n ** 18n;

/** At most this many `approveListing` calls per cycle (Policy.MAX_LISTINGS_PER_CYCLE). */
export const MAX_LISTINGS_PER_CYCLE = 3;

/** Market label used in URLs and page copy. */
export const MARKET = "NVDA";
export const SHARE_TICKER = "cNVDA";

/**
 * First block worth scanning for vault logs. Defaults to 0 because the primary RPC accepts a
 * full-range eth_getLogs for a single address (recon R2 §3); set it to the deploy block to make
 * /activity's fallback path cheaper.
 */
export const VAULT_FROM_BLOCK = (() => {
  const raw = process.env.NEXT_PUBLIC_VAULT_FROM_BLOCK?.trim();
  if (!raw) return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
})();

/** True when this build knows which vault to talk to. Pages render a config notice when false. */
export const isVaultConfigured = VAULT !== undefined;
