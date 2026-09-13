import { getAddress, isAddress, type Address } from "viem";

import { valoremClearAbi } from "./abi/clear";
import { erc20Abi, stockTokenAbi } from "./abi/erc20";
import { overcallRegistryAbi } from "./abi/registry";
import { seaportAbi } from "./abi/seaport";
import { vaultAbi } from "./abi/vault";

export { valoremClearAbi, erc20Abi, stockTokenAbi, overcallRegistryAbi, seaportAbi, vaultAbi };

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

/** Callhouse vault (cNVDA). Deploy-time only — set NEXT_PUBLIC_VAULT. */
export const VAULT = fromEnv("NEXT_PUBLIC_VAULT", process.env.NEXT_PUBLIC_VAULT);

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
 * OvercallRegistry for the NVDA market.
 *
 * TRAP: Overcall's own frontend config carries a top-level `registry` key of 0x65dD4079… —
 * that is the JUGGERNAUT market, not NVDA. There are 11 per-market registries. This one, and
 * only this one, is NVDA's. Every countdown, every rung and every write gate in this app is
 * bound to it rather than to a wall clock.
 */
export const REGISTRY = fromEnv(
  "NEXT_PUBLIC_REGISTRY",
  process.env.NEXT_PUBLIC_REGISTRY,
  getAddress("0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA"),
)!;

/** ValoremOptionsClearinghouse — exact upstream build, solc 0.8.16. Holds the option ERC-1155s. */
export const CLEARINGHOUSE = fromEnv(
  "NEXT_PUBLIC_CLEARINGHOUSE",
  process.env.NEXT_PUBLIC_CLEARINGHOUSE,
  getAddress("0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0"),
)!;

/** Seaport 1.6. The vault is the offerer; Seaport pulls directly (conduitKey is zero). */
export const SEAPORT = fromEnv(
  "NEXT_PUBLIC_SEAPORT",
  process.env.NEXT_PUBLIC_SEAPORT,
  getAddress("0x0000000000000068F116a894984e2DB1123eB395"),
)!;

/** Overcall's 5% premium fee recipient — consideration[1] on every listing. */
export const OVERCALL_FEE_RECIPIENT = getAddress("0xdAe7e82A2E7D566C67E87C164B05a1C560190782");

/** Seaport's zero conduit key. Overcall uses no conduit: approvals go to Seaport itself. */
export const ZERO_CONDUIT_KEY = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
export const ZERO_HASH = ZERO_CONDUIT_KEY;
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

/** Overcall's premium fee, in basis points. Fixed by their order shape, not by us. */
export const OVERCALL_FEE_BPS = 500n;

/** Decimals. USDG is 6, the Stock Token is 18, and vault shares follow the asset at 18. */
export const USDG_DECIMALS = 6;
export const ASSET_DECIMALS = 18;
export const SHARE_DECIMALS = 18;

/** One contract = one lot = 1.0 Stock Token. registry.lotSize() is read live to confirm it. */
export const LOT_SIZE = 10n ** 18n;

/** Market label used in URLs, the Overcall `market` query param and page copy. */
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
