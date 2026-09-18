import { getAddress, isAddress, type Address } from "viem";

import { valoremClearAbi } from "./abi/clear";
import { erc20Abi, stockTokenAbi } from "./abi/erc20";
import { seaportAbi } from "./abi/seaport";
import { vaultAbi } from "./abi/vault";
import { accountFactoryAbi } from "./abi/accountFactory";
import { writerAccountAbi } from "./abi/writerAccount";
import { GENERATED_MARKETS } from "./markets.generated";

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
 * There is no option registry and no third-party fee recipient any more. The vault reads the
 * weekly option type from the clearinghouse itself, numbers its own cycles, and every listing pays
 * ONE USDG leg to the vault (contracts/README.md "No registry"). The clearinghouse is a deploy-time
 * choice: `vault.clear()` is the authority, and NEXT_PUBLIC_CLEARINGHOUSE must agree with it.
 *
 * MARKETS ARE NOT HERE. The per-market addresses (Stock Token, feed, factory) come from the market
 * registry, ops/markets/tier1.json, compiled into lib/markets.generated.ts and read through
 * lib/markets.ts. The two market-shaped constants that remain in this file, FACTORY and ASSET,
 * are the DEFAULT market's (NVDA, the first one): they exist so that NEXT_PUBLIC_FACTORY and
 * NEXT_PUBLIC_ASSET can still point a rehearsal build at a fork's factory and token, and so the
 * closed pooled vault under app/vault/nvda keeps its asset. Their compiled-in defaults are the
 * registry's own row, not a second copy of the address. The overrides apply to the default market
 * ONLY; every other market is exactly what the registry says (lib/markets.ts).
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

/**
 * The default market's registry row. lib/markets.ts owns the market list; this file needs the
 * one row so the env overrides below have the registry's addresses as their fallback. A registry
 * without the default market is a broken registry, and the generator refuses to write one whose
 * live rows lack a factory, so the `!` on the factory is a statement, not a hope.
 */
const DEFAULT_MARKET_ROW = GENERATED_MARKETS.find((m) => m.ticker === "NVDA")!;

/** Stonkhouse vault (cNVDA). Deploy-time only — set NEXT_PUBLIC_VAULT. */
export const VAULT = fromEnv("NEXT_PUBLIC_VAULT", process.env.NEXT_PUBLIC_VAULT);

/**
 * The DEFAULT market's isolated 1-lot account factory (NVDA, deployed 2026-09-15 at
 * 0xc4A5Cd0DE91CaB7F5Ebe2114bc63Fbb43E642BBb, block 64038234). The fallback is the registry's row,
 * so blank NEXT_PUBLIC_FACTORY is safe and is the production value. Set it only to point a
 * rehearsal build at another factory for the default market; the other markets' factories are
 * read from the registry and are not affected (lib/markets.ts).
 */
export const FACTORY = fromEnv("NEXT_PUBLIC_FACTORY", process.env.NEXT_PUBLIC_FACTORY, getAddress(DEFAULT_MARKET_ROW.factory!))!;

/**
 * The DEFAULT market's Stock Token (NVDA, 18 decimals, proxy), and the closed pooled vault's
 * `asset`. Same rule as FACTORY: the fallback is the registry's row, and NEXT_PUBLIC_ASSET moves
 * the default market only.
 */
export const ASSET = fromEnv("NEXT_PUBLIC_ASSET", process.env.NEXT_PUBLIC_ASSET, getAddress(DEFAULT_MARKET_ROW.asset))!;

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

/**
 * The CLOSED pooled vault's market label and share ticker. Read only by the vault pages and
 * components under app/vault/nvda, app/collect and app/activity (the vault's tape), which are kept
 * as they were. Every other page takes its ticker from a `Market` (lib/markets.ts); do not import
 * MARKET into new code.
 */
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
