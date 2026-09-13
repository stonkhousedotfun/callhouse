import { getAddress, isAddress, type Address } from "viem";

/**
 * Every address and tuning knob the indexer needs, resolved once from the environment.
 *
 * The protocol addresses below are hard-coded defaults because they were confirmed with
 * `eth_getCode` on chain 4663 during recon (see ops/recon/). They are still overridable by
 * env so a fork or a dry-run deployment can point somewhere else without a code change.
 *
 * Two values have no safe default and are therefore required:
 *   VAULT_ADDRESS  — the vault does not exist until we deploy it.
 *   START_BLOCK    — chain 4663 is past block 61,000,000. Scanning from genesis is hours of
 *                    `eth_getLogs` for a contract that did not exist for any of it.
 */

/** Robinhood Chain mainnet. An Arbitrum Orbit L2. 0x1237. */
export const CHAIN_ID = 4663;

/** The key this chain is registered under in ponder.config.ts. Also the `ponder:api` client key. */
export const CHAIN_NAME = "robinhood";

function env(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? undefined : v.trim();
}

function requireEnv(name: string, why: string): string {
  const v = env(name);
  if (v === undefined) {
    throw new Error(
      `[callhouse/indexer] Missing required environment variable ${name}. ${why}`,
    );
  }
  return v;
}

function address(name: string, fallback?: Address): Address {
  const raw = env(name);
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`[callhouse/indexer] Missing required address env var ${name}.`);
  }
  if (!isAddress(raw)) {
    throw new Error(`[callhouse/indexer] ${name}="${raw}" is not a valid address.`);
  }
  return getAddress(raw);
}

function blockNumber(name: string, fallback?: number): number {
  const raw = env(name);
  if (raw === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(
      `[callhouse/indexer] Missing required env var ${name}. Set it to the block the ` +
        `contract was deployed in; chain 4663 is past block 61,000,000 and a genesis scan ` +
        `is not a viable backfill.`,
    );
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`[callhouse/indexer] ${name}="${raw}" is not a non-negative integer.`);
  }
  return n;
}

/** RPC. The publicnode backup rejects `eth_getLogs` on old ranges, so backfill needs the primary. */
export const RPC_URL =
  env("PONDER_RPC_URL_4663") ??
  requireEnv(
    "PONDER_RPC_URL_4663",
    "Set it to https://rpc.mainnet.chain.robinhood.com (archive-capable). The publicnode " +
      "backup answers 'Archive requests require a personal token' on historical getLogs and " +
      "cannot backfill.",
  );

/** Our vault. The Seaport offerer, the Valorem writer, the ERC-20 whose shares we track. */
export const VAULT: Address = (() => {
  const raw = env("VAULT_ADDRESS") ?? env("VAULT");
  if (raw === undefined) {
    throw new Error(
      "[callhouse/indexer] Missing required env var VAULT_ADDRESS (alias: VAULT). " +
        "Set it to the deployed Callhouse vault on chain 4663.",
    );
  }
  if (!isAddress(raw)) {
    throw new Error(`[callhouse/indexer] VAULT_ADDRESS="${raw}" is not a valid address.`);
  }
  return getAddress(raw);
})();

/**
 * Overcall's NVDA registry.
 *
 * TRAP, carried over from recon: Overcall's frontend config also exposes a top-level
 * `registry` key = 0x65dD4079..., which is the JUGGERNAUT market, not NVDA. There are 11
 * per-market registries. This is the NVDA one and it is the only one this vault may bind to;
 * the vault's constructor reverts if the registry's collateralToken is not the vault asset.
 */
export const REGISTRY = address(
  "REGISTRY",
  getAddress("0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA"),
);

/** ValoremOptionsClearinghouse (exact upstream, valorem-core @6436c823, solc 0.8.16). */
export const CLEARINGHOUSE = address(
  "CLEARINGHOUSE",
  getAddress("0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0"),
);

/** Seaport 1.6. Bytecode-identical to Ethereum mainnet apart from chainId + domain separator. */
export const SEAPORT = address(
  "SEAPORT",
  getAddress("0x0000000000000068F116a894984e2DB1123eB395"),
);

/** USDG. 6 decimals. The exercise asset and the premium currency. */
export const USDG = address("USDG", getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"));

/** NVDA Stock Token. 18 decimals, upgradeable proxy, exposes uiMultiplier() and oraclePaused(). */
export const ASSET = address("ASSET", getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"));

/**
 * Multicall3, at its canonical cross-chain address and `eth_getCode`-confirmed on 4663.
 *
 * WHY THE API NEEDS IT: `GET /v1/vault` wants ~35 view reads (22 off the vault, 4 off the
 * registry, two per approved rung, one off the Stock Token). Fired one at a time through the
 * shared RPC queue they exceed any sane deadline on a rate-limited public endpoint and the
 * whole payload degrades to nulls — observed on rpc.mainnet.chain.robinhood.com. Batched
 * through `aggregate3` they are four round trips. `allowFailure` is always on, so a view that
 * reverts by design (`spotUsdg()` on a stale feed) still reports as null instead of taking
 * the batch down with it.
 */
export const MULTICALL3 = address(
  "MULTICALL3",
  getAddress("0xcA11bde05977b3631167028862bE2a173976CA11"),
);

/** Overcall's fee recipient: consideration[1] on every listing, 5% of gross. Also ValoremClear.feeTo(). */
export const OVERCALL_FEE_RECIPIENT = address(
  "OVERCALL_FEE_RECIPIENT",
  getAddress("0xdAe7e82A2E7D566C67E87C164B05a1C560190782"),
);

/** First block to scan for vault events. Required: see the module docblock. */
export const START_BLOCK = blockNumber("START_BLOCK");

/**
 * First block to scan the Overcall registry from. Defaults to START_BLOCK, but the registry
 * predates our vault, so set this lower to pick up the CycleSet history that happened before
 * we deployed. Cycles we never wrote into still belong in the public tape.
 */
export const REGISTRY_START_BLOCK = blockNumber("REGISTRY_START_BLOCK", START_BLOCK);

/**
 * Optional last block to index, inclusive. Unset means "follow the head forever", which is
 * what production wants. Set it to bound a replay: a fork dry-run, or a smoke test that
 * needs the historical sync to finish rather than tail the chain.
 */
export const END_BLOCK: number | undefined = (() => {
  const raw = env("END_BLOCK");
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`[callhouse/indexer] END_BLOCK="${raw}" is not a non-negative integer.`);
  }
  return n;
})();

/**
 * Optional PGlite data directory. Unset (the normal case) leaves Ponder's own choice alone:
 * Postgres when `DATABASE_URL` is set, `.ponder/pglite` otherwise. Set, it forces PGlite at this
 * path even if a `DATABASE_URL` is present. It exists for `scripts/fork-sync.ts`, which needs a
 * throwaway database per run: every fork deploys the dry-run vault at the same address, and a
 * reused `.ponder/pglite` would carry Ponder's RPC cache for chain 4663 from an earlier fork.
 */
export const PGLITE_DIRECTORY = env("PGLITE_DIRECTORY");

/** Overcall's listings API. The keeper proxy route forwards here verbatim. */
export const OVERCALL_ORDERS_URL =
  env("OVERCALL_ORDERS_URL") ?? "https://overcall.finance/api/orders";

/** Market symbol appended as ?market=… on the Overcall POST. */
export const OVERCALL_MARKET = env("OVERCALL_MARKET") ?? "NVDA";

/** Shared secret for the keeper-only POST /v1/overcall/list route. Absent ⇒ the route 503s. */
export const KEEPER_HMAC_SECRET = env("KEEPER_HMAC_SECRET");

/**
 * How long one batched live read may take before the API gives up on it.
 *
 * The read routes are index-first: every live value has an indexed fallback, and a slow or
 * rate-limited RPC must degrade a field to null rather than hang the request. Public
 * endpoints on this chain DO rate-limit, and without a deadline a 429 storm turns
 * `GET /v1/vault` into a stalled connection.
 *
 * It applies per Multicall3 batch, not per view. Eight seconds because a batch is one
 * `eth_call` and the public endpoint answers one in well under a second when it is healthy;
 * anything past eight means it is not, and the route should answer from the index instead.
 * A 3s deadline was measured to be too tight once the batch queues behind the indexer's own
 * traffic, and it silently emptied the whole payload.
 */
export const LIVE_READ_TIMEOUT_MS = (() => {
  const raw = env("LIVE_READ_TIMEOUT_MS");
  const n = raw === undefined ? 8000 : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 8000;
})();

/** Decimals. Not read from chain: they are immutable facts of these two tokens. */
export const ASSET_DECIMALS = 18;
export const USDG_DECIMALS = 6;

/** Overcall's cut of gross premium, in bps. Matches Policy.OVERCALL_FEE_BPS. */
export const OVERCALL_FEE_BPS = 500n;
export const BPS = 10_000n;

/** One lot of the underlying: Overcall's lot size is exactly 1.0000 Stock Token per contract. */
export const LOT = 10n ** 18n;

/** Distributor.ACC_PRECISION — the fixed-point scale behind accUsdgPerShare. */
export const ACC_PRECISION = 10n ** 27n;

/** Valorem reports Claim.amountWritten / amountExercised as 1e18-scaled scalars, not counts. */
export const VALOREM_SCALAR = 10n ** 18n;
