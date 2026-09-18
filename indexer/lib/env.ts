import { getAddress, isAddress, type Address } from "viem";

/**
 * Every address and tuning knob the indexer needs, resolved once from the environment.
 *
 * The protocol addresses below are hard-coded defaults because they were confirmed with
 * `eth_getCode` on chain 4663 during recon (see ops/recon/). They are still overridable by
 * env so a fork or a dry-run deployment can point somewhere else without a code change.
 *
 * A legacy deployment indexes one product, named by whichever of these two is set (both may be):
 *   VAULT_ADDRESS    — the pooled vault (closed to new markets; the NVDA deployment keeps it).
 *   FACTORY_ADDRESS  — a factory market: an `AccountFactory` and the `WriterAccount` clones it
 *                      creates (contracts/src/solo/). One process per market, per the Tier 1
 *                      plan; there is no multi-market indexer. `MARKET` is the ticker label the
 *                      API publishes beside it.
 * V2_CLEARINGHOUSE enables one v2 source group for all v2 markets. It can run alongside either
 * legacy product, or on its own. The other four v2 addresses and V2_START_BLOCK are required
 * with it. Without any V2_* vars, the legacy configuration behaves as before.
 *
 * Required for either legacy product:
 *   START_BLOCK      — chain 4663 is past block 61,000,000. Scanning from genesis is hours of
 *                      `eth_getLogs` for a contract that did not exist for any of it. For a
 *                      factory market it is that market's `deployment.deployBlock` in
 *                      ops/markets/tier1.json.
 *
 * There is no registry and no Overcall here. The redesigned vault (contracts branch
 * redesign/a2-own-strikes-2026-09-13) numbers its own cycles and reads the option tuple from the
 * clearinghouse; the only venue is the vault's own Seaport listing, zone == the vault.
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

/**
 * RPC. A VAULT deployment needs an archive endpoint: during backfill the vault handlers
 * `eth_call` the vault at past blocks, not only `eth_getLogs`, and
 * rpc.mainnet.chain.robinhood.com answers "historical state ... is not available" on a
 * historical `eth_call` (a vault backfill against it stalled at 0% on 2026-09-15), while the
 * publicnode backup answers "Archive requests require a personal token". A FACTORY market's
 * handlers are log-only and backfill on the public RPC; the one thing that wants the archive
 * there is the optional `Factory:setup` read of the constructor-set settings at START_BLOCK,
 * and without it those stay unverified on `/v1/market` (README "Factory markets"). Production
 * uses a keyed Alchemy endpoint.
 */
export const RPC_URL =
  env("PONDER_RPC_URL_4663") ??
  requireEnv(
    "PONDER_RPC_URL_4663",
    "Set it to an archive RPC for chain 4663 that serves historical eth_call and eth_getLogs " +
      "(production uses https://robinhood-mainnet.g.alchemy.com/v2/<key>). A VAULT deployment " +
      "cannot backfill without one: the public RPC answers 'historical state ... is not available' " +
      "on a historical eth_call. A FACTORY market backfills logs on the public RPC and wants the " +
      "archive only for the optional Factory:setup settings read.",
  );

/** An address env var with an alias and no default: undefined when neither name is set. */
function optionalAddress(name: string, alias?: string): Address | undefined {
  const raw = env(name) ?? (alias === undefined ? undefined : env(alias));
  if (raw === undefined) return undefined;
  if (!isAddress(raw)) {
    throw new Error(`[callhouse/indexer] ${name}="${raw}" is not a valid address.`);
  }
  return getAddress(raw);
}

/**
 * Our pooled vault: the Seaport offerer AND zone, the Valorem writer, the ERC-20 whose shares we
 * track. Undefined on a factory-only deployment, where none of the vault sources is registered
 * (ponder.config.ts), none of the vault handlers is (lib/registry.ts), and every `/v1/vault*`
 * route answers 404 `{configured: false}`.
 */
export const VAULT: Address | undefined = optionalAddress("VAULT_ADDRESS", "VAULT");

/**
 * A factory market's `AccountFactory`. Its `WriterAccount` clones are discovered from
 * `AccountCreated` (Ponder's factory address pattern), so nothing else about the market needs
 * configuring: the asset, the feed and the policy are the factory's own views, read once at
 * setup. Undefined on a vault-only deployment (the NVDA vault as deployed today), where the
 * `/v1/market*` routes answer 404 `{configured: false}`.
 */
export const FACTORY: Address | undefined = optionalAddress("FACTORY_ADDRESS", "FACTORY");

/** V2 is a single Clearinghouse that contains every market. No address has a default. */
export const V2_CLEARINGHOUSE: Address | undefined = optionalAddress("V2_CLEARINGHOUSE");

function v2Address(name: string): Address | undefined {
  const raw = env(name);
  if (V2_CLEARINGHOUSE === undefined) {
    if (raw !== undefined) {
      throw new Error(`[callhouse/indexer] ${name} is set without V2_CLEARINGHOUSE.`);
    }
    return undefined;
  }
  if (raw === undefined) {
    throw new Error(`[callhouse/indexer] Missing required address env var ${name} when V2_CLEARINGHOUSE is set.`);
  }
  if (!isAddress(raw)) {
    throw new Error(`[callhouse/indexer] ${name}="${raw}" is not a valid address.`);
  }
  return getAddress(raw);
}

export const V2_ORDER_BOOK: Address | undefined = v2Address("V2_ORDER_BOOK");
export const V2_SETTLEMENT_ORACLE: Address | undefined = v2Address("V2_SETTLEMENT_ORACLE");
export const V2_AUTO_ROLLER: Address | undefined = v2Address("V2_AUTO_ROLLER");
export const V2_MAKER_REGISTRY: Address | undefined = v2Address("V2_MAKER_REGISTRY");

/** Optional v2 periphery sources. A five-address deployment remains valid without either. */
function optionalV2Address(name: string): Address | undefined {
  const raw = env(name);
  if (V2_CLEARINGHOUSE === undefined) {
    if (raw !== undefined) throw new Error(`[callhouse/indexer] ${name} is set without V2_CLEARINGHOUSE.`);
    return undefined;
  }
  if (raw === undefined) return undefined;
  if (!isAddress(raw)) throw new Error(`[callhouse/indexer] ${name}="${raw}" is not a valid address.`);
  return getAddress(raw);
}

export const V2_EXPIRY_CALENDAR: Address | undefined = optionalV2Address("V2_EXPIRY_CALENDAR");
export const V2_KEEPER_REWARDS: Address | undefined = optionalV2Address("V2_KEEPER_REWARDS");

/** V2 deployment block. A genesis scan is never an acceptable implicit default. */
export const V2_START_BLOCK: number | undefined = (() => {
  if (V2_CLEARINGHOUSE !== undefined) return blockNumber("V2_START_BLOCK");
  if (env("V2_START_BLOCK") !== undefined) {
    throw new Error("[callhouse/indexer] V2_START_BLOCK is set without V2_CLEARINGHOUSE.");
  }
  return undefined;
})();

/** Optional pricing service used by v2 quote and card routes. */
export const PRICING_URL: string | undefined = (() => {
  const raw = env("PRICING_URL");
  if (raw === undefined) return undefined;
  // A legacy-only process has never interpreted this variable; keep that boot path unchanged.
  if (V2_CLEARINGHOUSE === undefined) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`[callhouse/indexer] PRICING_URL="${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("[callhouse/indexer] PRICING_URL must use http or https.");
  }
  return url.toString().replace(/\/$/, "");
})();

if (VAULT === undefined && FACTORY === undefined && V2_CLEARINGHOUSE === undefined) {
  throw new Error(
    "[callhouse/indexer] Set VAULT_ADDRESS (alias: VAULT) for the pooled vault, FACTORY_ADDRESS " +
      "(alias: FACTORY) for a factory market, V2_CLEARINGHOUSE for v2, or a combination. None is set. For a factory market use " +
      "ops/markets/tier1.json → deployment.factory, with START_BLOCK = deployment.deployBlock and " +
      "MARKET = the ticker.",
  );
}

/**
 * The ticker the factory market is published under (`/v1/market.ticker`, `/v1/health.market`).
 * A label only: nothing is derived from it. Defaults to NVDA, the one live market, so the
 * existing deployment's env needs no new variable.
 */
export const MARKET: string = env("MARKET") ?? "NVDA";

// The NVDA default exists so the one live market's env needs no variable; on any other market it
// is silently wrong, so say so at boot rather than let an AAPL deployment publish ticker NVDA.
if (FACTORY !== undefined && env("MARKET") === undefined) {
  console.warn(
    "[callhouse/indexer] FACTORY_ADDRESS is set and MARKET is not: every payload publishes " +
      "ticker NVDA, the default. Set MARKET to this market's ticker.",
  );
}

/**
 * What src/vault.ts and src/seaport.ts bind their module-scope `VAULT` to when VAULT_ADDRESS is
 * unset. Ponder loads every file under src/ on every deployment, and those two read the address
 * at module scope; with their handlers unregistered (lib/registry.ts) the value is never used.
 * The zero address is chosen because nothing on chain can ever match it.
 */
export const ZERO_ADDRESS_PLACEHOLDER: Address = "0x0000000000000000000000000000000000000000";

/**
 * The vault address for code that cannot run without one: the vault handlers' shared reducers
 * and the API's live vault reads. Both are reached only on a vault deployment (the handlers are
 * not registered and the routes answer 404 otherwise), so the throw is a programming error, not
 * a configuration one; it exists so a mistake fails loudly instead of indexing under a wrong key.
 */
export function vaultAddress(): Address {
  if (VAULT === undefined) {
    throw new Error("[callhouse/indexer] vault code path reached with VAULT_ADDRESS unset");
  }
  return VAULT;
}

/**
 * The Valorem clearinghouse the vault was constructed with. A deploy-time choice (decision D16):
 * the default is the exact upstream build on chain 4663 (valorem-core @6436c823, solc 0.8.16);
 * a vault deployed against our own `DeployClear.s.sol` instance overrides it. `Vault.clear()`
 * is the authority; ops/addresses.json records which one a deployment used. VAULT-ONLY: a
 * factory market's own Clear is read from the factory at setup (src/factory.ts) and the
 * `/v1/market*` payloads publish that, never this default.
 */
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

/**
 * NVDA Stock Token. 18 decimals, upgradeable proxy, exposes uiMultiplier() and oraclePaused().
 * VAULT-ONLY: a factory market's own asset is read from the factory at setup (src/factory.ts)
 * and the `/v1/market*` payloads publish that, never this default.
 */
export const ASSET = address("ASSET", getAddress("0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"));

/**
 * Multicall3, at its canonical cross-chain address and `eth_getCode`-confirmed on 4663.
 *
 * WHY THE API NEEDS IT: `GET /v1/vault` wants ~30 view reads off the vault plus one off the Stock
 * Token. Fired one at a time through the shared RPC queue they exceed any sane deadline on a
 * rate-limited public endpoint and the whole payload degrades to nulls — observed on
 * rpc.mainnet.chain.robinhood.com. Batched through `aggregate3` they are two round trips.
 * `allowFailure` is always on, so a view that reverts by design (`spotUsdg()` on a stale feed)
 * still reports as null instead of taking the batch down with it.
 */
export const MULTICALL3 = address(
  "MULTICALL3",
  getAddress("0xcA11bde05977b3631167028862bE2a173976CA11"),
);

/** First block for legacy events; v2-only mode leaves the unused legacy value at its v2 block. */
export const START_BLOCK = VAULT !== undefined || FACTORY !== undefined
  ? blockNumber("START_BLOCK")
  : V2_START_BLOCK!;

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

/**
 * One lot of the underlying: exactly 1.0000 Stock Token per contract. `Policy.LOT` is compiled
 * into the vault and `rollOpen` refuses (`UnexpectedLotSize`) to arm an option type whose
 * `underlyingAmount` differs, so this is a constant, not a setting.
 */
export const LOT = 10n ** 18n;

/** Distributor.ACC_PRECISION — the fixed-point scale behind accUsdgPerShare. */
export const ACC_PRECISION = 10n ** 27n;

/** A whole share of a stranded claim, the WAD every `EpochStrandShare` is a fraction of. */
export const WAD = 10n ** 18n;

/** Valorem reports Claim.amountWritten / amountExercised as 1e18-scaled scalars, not counts. */
export const VALOREM_SCALAR = 10n ** 18n;
