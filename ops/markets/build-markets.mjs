#!/usr/bin/env node
/**
 * Build the Tier-1 market registry: ops/markets/tier1.json.
 *
 * One file drives every market-specific thing in the system: the factory deploy scripts
 * (contracts/script/DeploySoloBatch.sh), the per-market keeper env files (ops/keeper-env.sh), the
 * indexer env, the web app's market list (web/lib/markets.ts via web/scripts/gen-markets.mjs) and
 * the docs page (callhouse-docs/product/markets.md). Nothing else may hard-code a market.
 *
 * WHAT IT DOES
 *   1. Fetches Chainlink's feed directory for chain 4663 (or reads --feeds <file>), keeps the
 *      feeds whose `docs.marketHours` is `us_equities_24/5` (the tokenised-equity feeds), and
 *      derives the ticker from the feed name (`Robinhood NVDA / USD`, `Robinhood DELL-USD`).
 *   2. Cross-references each ticker with ops/recon/R6-stock-tokens-list.json (204 Stock Tokens
 *      the issuer had deployed by 2026-09-12) by token `symbol`. A ticker with no token, or with
 *      more than one, is reported and skipped.
 *   3. Verifies every pair ON CHAIN with `cast` against RH_RPC: feed `decimals() == 8`,
 *      `latestRoundData().answer > 0` and its age, `description()` containing the ticker; token
 *      `decimals() == 18`, `symbol()`, and the ERC-8056 `uiMultiplier()` / `oraclePaused()` probes.
 *      A market that fails any check is written with `verification.ok == false` and its issues,
 *      never silently dropped, and the script exits 1.
 *   4. Fetches Cboe's delayed option chain for the ticker (unless --skip-cboe) and records whether
 *      a weekly chain exists (the next two Fridays both listed) and how far Cboe's `current_price`
 *      sits from the feed's spot. The keeper's vol mode needs both: it prices the week from the
 *      chain of the SAME underlying and refuses a spot divergence above
 *      KEEPER_VOL_MAX_SPOT_DIVERGENCE_BPS (300). A root whose chain is a different instrument
 *      (SPCX on Cboe is not the SpaceX token) or has no weeklies (SGOV) is `mode: "fixed"`.
 *   5. Merges the result over the existing tier1.json so hand-maintained fields survive a
 *      regeneration: `deployment.*`, `wave`, `status`, `depositCapUsd`, `strikeOtmBps`,
 *      `minAskUsdg6`, `targetDelta`, `priceEdgeBps`, `premiumMarginBps`, `modeOverride`, `v1RunOff`
 *      (ADR-10: the owner froze this v1 factory; ops/keeper-env.sh then renders SOLO_WIND_DOWN=1),
 *      `v1FrozenAt` (unix seconds of that freeze, written with `v1RunOff: true`), `notes`, and the
 *      v2 blocks: the top-level `v2` (contract addresses, bot addresses, Uniswap periphery, fees,
 *      defaults) and each market's `v2` (status, wave, strikeTick, pool, liquidity floor, Data
 *      Streams id, overrides). The v2 blocks are written by hand and by the v2 deploy write-back,
 *      never derived here: nothing the builder fetches can say which pool a settlement source
 *      should trust or which wave a market opens in. At the root, every key of the registry read
 *      comes out as it went in unless REGENERATED_ROOT_KEYS or RETIRED_ROOT_KEYS names it; a
 *      rebuild that would drop or rewrite any other root key is refused before it writes (T-607).
 *   6. Validates what it cannot regenerate, so a bad hand edit fails loudly here instead of at a
 *      deploy: `status` is live | planned | paused | superseded-by-v2 (the v1 factory lifecycle;
 *      ADR-02 cancelled the per-market factory rollout, so the 34 rows that were planned are
 *      superseded and a live row needs a factory while a superseded one must not have one);
 *      `v1FrozenAt` is absent, null or positive unix seconds, and when set the row has a factory
 *      and `v1RunOff: true`; the v2 blocks match ops/markets/README.md "v2 blocks" (interface
 *      version, enums, strikeTick a positive multiple of PRICE_TICK = 100, fee ceilings of
 *      V2Constants, overrides naming only keys of `v2.defaults`, each market's effective
 *      `spotMaxAgeS` at most the oracle's 4-day ceiling and at least its feed heartbeat + 1 h,
 *      a pool always with its floor, the
 *      three bot addresses EIP-55 checksummed or null and distinct from each other and from every
 *      other key the registry names). A pool is checked twice: offline, its token pair must be
 *      {asset, USDG} in the F2-02 recon (ops/markets/v2-sources.json), and on chain
 *      `token0()`/`token1()` must be that pair and the v3 factory's `getPool` must return it for the
 *      pool's own `fee()`. Current in-range liquidity under the floor is reported, not failed: it
 *      moves with the market, and the floor is a settlement-time gate.
 *
 * USAGE
 *   node ops/markets/build-markets.mjs                      # fetch feeds, verify, fetch Cboe, write
 *   node ops/markets/build-markets.mjs --feeds path.json    # use a saved feed directory
 *   node ops/markets/build-markets.mjs --skip-cboe          # no Cboe fetch (keeps previous evidence)
 *   node ops/markets/build-markets.mjs --check              # verify only; exit 1 on drift, write nothing
 *   node ops/markets/build-markets.mjs --check --registry /path/to/other.json    # explicit alternate registry
 *   node ops/markets/build-markets.mjs --check --registry ops/markets/dev.json   # the local-devnet registry
 *   RH_RPC=... overrides the RPC (default: the public primary).
 *
 * `--registry <file>` reads AND writes that file instead of ops/markets/tier1.json, under exactly the
 * same rules. A separate development registry can be supplied explicitly; nothing defaults to it.
 * Every consumer that reads a non-production registry is told so on its own command line.
 *
 * Needs `cast` (foundry) on PATH and Node >= 22. No npm dependencies on purpose: this runs from
 * a bare checkout during a deploy, before any workspace install.
 */
import { execFile } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";

const execFileP = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const opsDir = path.resolve(here, "..");
/** The registry this run reads and writes: ops/markets/tier1.json, or `--registry <file>`. */
const OUT = (() => {
  const i = process.argv.indexOf("--registry");
  if (i === -1) return path.join(here, "tier1.json");
  const p = process.argv[i + 1];
  if (!p || p.startsWith("--")) {
    console.error("--registry needs a path");
    process.exit(2);
  }
  return path.resolve(process.cwd(), p);
})();
/**
 * Production, always this path whichever registry the run reads. A `_dev` registry is checked against
 * it (`validateDevIsolation`): the point of a development registry is that it names none of these.
 */
const PRODUCTION_REGISTRY = path.join(here, "tier1.json");
const TOKENS = path.join(opsDir, "recon", "R6-stock-tokens-list.json");
const V2_SOURCES = path.join(here, "v2-sources.json");
const FEEDS_URL = "https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json";
const RPC = process.env.RH_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const CBOE = (root) => `https://cdn.cboe.com/api/global/delayed_quotes/options/${root}.json`;
const EXPLORER = "https://robinhoodchain.blockscout.com";

/**
 * The `shared` block: chain-wide facts and the protocol's own wallets.
 *
 * INTERFACE_VERSION 8: this block is **hand-maintained**, like the `v2` blocks, and only a registry
 * that has none at all gets this skeleton. Until v7 it was this constant, rewritten on every build —
 * which is precisely why `dev.json` could not stop being a copy of production: a rebuild put
 * production's admin, guardian and fee wallets back into it. v8 adds three hand-maintained members
 * (`safes`, `opsWallet`, `token`) that no build could derive anyway.
 *
 * The four chain addresses are facts of 4663 (USDG, the v1 Clearinghouse the v1 run-off still reads,
 * Seaport, Multicall3). The three role wallets are **null in the v8 skeleton**: `admin` is the Admin
 * Safe and `feeRecipient` the FeeSplitter, neither of which exists before the v8 deploy, and the v8
 * guardian is a new hot key that is never the v7 one (06-QUIRKS §G).
 */
const SHARED_SKELETON = {
  chainId: 4663,
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  clearinghouse: "0x53d7A6d0489Daf3d67b9A314e0eAB2B78Acab9C6",
  seaport: "0x0000000000000068F116a894984e2DB1123eB395",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
  // v8: the Admin Safe (OWN8-01), the guardian hot key and the FeeSplitter. Null until each exists.
  admin: null,
  guardian: null,
  feeRecipient: null,
  // The hot ops wallet that receives capped top-ups from the Treasury Safe for bot gas (V8-DESIGN §2.4).
  opsWallet: null,
  // The two 2-of-3 Safes (V3-D1, D10). `safes.admin` is the same address as `shared.admin`.
  safes: { admin: null, treasury: null },
  // STONKHOUSE, and the pinned hookless Uniswap v4 pool the buyback buys it on (V8-DESIGN §6).
  token: {
    address: null,
    symbol: null,
    decimals: null,
    poolKey: { currency0: null, currency1: null, fee: null, tickSpacing: null, hooks: null },
    poolId: null,
  },
};
/**
 * The `shared` block a build writes: the registry's own, as written. Only a registry that has none gets
 * the skeleton. One function because two readers need the answer (the market literal's deployment
 * defaults and `assembleRegistry`) and two spellings of it are two chances to disagree.
 */
const sharedOf = (existing) => (existing && "shared" in existing ? existing.shared : SHARED_SKELETON);
/** The keys of `shared`, closed like every other block. */
const SHARED_KEYS = Object.keys(SHARED_SKELETON);
const SHARED_SAFE_KEYS = ["admin", "treasury"];
const SHARED_TOKEN_KEYS = ["address", "symbol", "decimals", "poolKey", "poolId"];
const POOL_KEY_KEYS = ["currency0", "currency1", "fee", "tickSpacing", "hooks"];
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Per-market defaults. Everything here is a keeper or deploy parameter an operator may override
 * per market in tier1.json; the builder never overwrites an existing per-market value.
 *
 *   depositCapUsd     per-ACCOUNT cap (AccountFactory.depositCap is checked against one account's
 *                     held balance, not a global total), in USD notional at build time. Converted
 *                     to whole tokens at the verified spot (`depositCap`, 18 dp, at least 1 token).
 *   strikeOtmBps      fixed mode: strike = spot × (1 + bps/10000), whole USDG. Inside the 3%–12% band.
 *   minAskUsdg6       the ask is never below this (USDG base units). Replaces the 1 USDG floor of
 *                     the NVDA-only keeper, meaningless for a $25 token. 0.10 USDG.
 *   targetDelta / priceEdgeBps / premiumMarginBps  vol-mode knobs, the keeper's own defaults.
 */
const DEFAULTS = {
  depositCapUsd: 10_000,
  strikeOtmBps: 500,
  minAskUsdg6: "100000",
  targetDelta: 0.15,
  priceEdgeBps: 1000,
  premiumMarginBps: 100,
  maxPriceAgeS: 345_600,
  maxSpotDivergenceBps: 300,
};

/**
 * What is live on v7 TODAY. This is the only wave information the generator owns, and it is written
 * into the registry UNCONDITIONALLY (`waves: WAVES` below) -- the registry is generated, so a
 * hand-edit to its `waves` block does not survive the next run.
 *
 * T-566 REMOVED THE `canary` AND `wave1` KEYS. They recorded the v1 rollout plan, which ADR-02
 * superseded, but they shared a NAMESPACE with the v8 waves in `markets[].v2.wave`:
 * `DeployV2Batch.sh` reads both sources for the same wave name and refuses a disagreement, so the v1
 * `canary` of [TSLA, AAPL] collided with the v8 `canary` of [NVDA] and killed `--wave canary`.
 * Nothing in the repository read those two keys -- the only reader of this map is
 * `ops/v8/freeze-v7.mjs:135`, which reads `.live` alone. WHAT WAS LOST is the v1 plan's membership
 * for canary and wave1; it survives in git history and in `markets[].wave`, the per-market v1 field
 * that `build-markets.mjs:1105` still validates against `V1_WAVES`.
 *
 * v8 waves live in each market's `v2.wave` and nowhere else. Put a new one there.
 */
export const WAVES = {
  live: ["NVDA"],
};

const README =
  "Tier-1 market registry for Stonkhouse on Robinhood Chain 4663: every Stock Token that has a live Chainlink us_equities_24/5 feed. GENERATED by ops/markets/build-markets.mjs; hand-edit only deployment.*, wave, status, depositCapUsd, strikeOtmBps, minAskUsdg6, targetDelta, priceEdgeBps, premiumMarginBps, modeOverride, v1RunOff, v1FrozenAt, notes, the top-level v2 block and each market's v2 block — the builder preserves those and regenerates everything else. `status` is the v1 factory lifecycle (live | planned | paused | superseded-by-v2: the per-market factory rollout was cancelled for v2); `v2.status` is the v2 market lifecycle (ops/markets/README.md). Every address was read on chain at verifiedAtBlock (see verification per market). Consumers: contracts/script/DeploySoloBatch.sh, ops/keeper-env.sh, ops/v2-env.mjs, web/scripts/gen-markets.mjs, callhouse-docs/product/markets.md, keeper/src/v2.";

/*//////////////////////////////////////////////////////////////
                          V2 SCHEMA
//////////////////////////////////////////////////////////////*/

/**
 * The frozen v2 interface version the registry's v2 blocks are written for. The one place it is spelled in
 * ops/ and web/: v2.interfaceVersion must equal it, and every other reader copies the registry's
 * value. Version 2 (ISettlementOracle candidate view and events), version 3 (API only: card
 * `perShare` ticket and the put card target), version 4 (OrderFilled.recipient), version 5 (notifier
 * settings sessions) and version 6 (24 h fee-change delay, per-expiry settlement pins, the 1 % payout
 * route fee-tier ceiling) left the registry schema as is. Version 7 (c05 collateral rent, c16 stale-ask
 * cancel, c21 vault outflow cap) was the first that grew it: `v2.fees.mintFeePpm` and a per-market
 * `v2.mintFeePpm` (the writer fee, then rent at mint), `v2.vault` (the six-field MakerVault Limits the
 * deploy sets), `v2.fees.premiumFeeBps` 0, and a pool observation ring of at least
 * MIN_POOL_OBSERVATION_CARDINALITY for any market that keeps a univ3 settlement source.
 *
 * **Version 8** (the v8 redeploy: AccessManager, 5 % premium fee, no rent, native flywheel, v4 payout
 * routes) is a breaking version, so every closed key set and every rule that reads one moves in this
 * one commit (ops/markets/README.md "Schema compatibility"):
 *
 *   grown      `v2.contracts.accessManager` (13 addresses -> 14); `v2.flywheel`; `shared.safes`,
 *              `shared.opsWallet`, `shared.token`; per-market `v2.payoutRoute`; `v2.fees.allowRent`.
 *   renamed    `v2.bots.mmQuoter` -> `v2.bots.quoter`, and `v2.bots.guardian` joins it.
 *   INVERTED   `premiumFeeBps <= resaleFeeBps` is now the refusal (it was `>`), and a NON-zero
 *              `mintFeePpm` is now the refusal (it was zero). Both directions are one edit each and
 *              both are here, because a half-inverted pair accepts every registry or none.
 *   moved      `shared` is hand-maintained, not rewritten from a constant on every build. That is what
 *              made `ops/markets/dev.json` a permanent copy of production, and `validateDevIsolation`
 *              now refuses a `_dev` registry that names a production wallet, key or contract at all.
 *   frozen     `ops/markets/v7-legacy.json` keeps the v7 production registry readable for the run-off.
 *              It carries `_legacy` and this builder refuses to touch it.
 */
const INTERFACE_VERSION = 8;
const V1_STATUSES = ["live", "planned", "paused", "superseded-by-v2"];
const V1_WAVES = ["live", "canary", "wave1", "wave2"];
const V2_STATUSES = ["planned", "live", "paused"];
const V2_WAVES = ["canary", "wave1", "wave2"];
/**
 * INTERFACE_VERSION 8: `accessManager` joins the set (the OpenZeppelin AccessManager every v8 target
 * is `Managed` by), so the count the deploy tooling asserts goes from 13 addresses to **14**
 * (11 here plus the three `sources`). `payoutAdapter` keeps its name and now holds the `PayoutRouter`,
 * so nothing downstream has to learn a second key for the same slot (03-INTERFACES §4).
 */
const V2_CONTRACT_NAMES = [
  "clearinghouse", "orderBook", "settlementOracle", "expiryCalendar", "keeperRewards",
  "autoRoller", "payoutAdapter", "makerVault", "makerRegistry", "rewardsDistributor", "accessManager",
];
const V2_SOURCE_NAMES = ["chainlink", "univ3", "dataStreams"];
/**
 * T-OP-114. THE SIX `v2.contracts` KEYS THE DEPLOY WRAPPER READS BUT DOES NOT CREATE. In callhouse-contracts,
 * `script/v2/lib/registry-env.sh:413` names them `EXTERNAL_KEYS`; `contract_of` (`:172-178`, the default arm)
 * reads each from `.v2.contracts.<key>` and `export_contracts` (`:414-420`) hands it to DeployV8 as its V2_*
 * variable (`env_name`, `:387-401`) — UNSET when the key is absent OR null, which `DeployV8._mapTarget` reads as
 * "not supplied: skip the target and say so" rather than "supplied as zero". They are deliberately NOT in the
 * wrapper's `CONTRACT_KEYS` (`:56`), the recorded-and-counted set DeployV8 creates, and for the same reason they
 * are NOT in {V2_CONTRACT_NAMES} here: that list is the 11-plus-3 count that `ops/v2/finish-dev-deploy.sh:104-110`,
 * `keeper/src/v2/registry.ts:92`, `web/scripts/gen-markets.mjs:6` and `render-docs.mjs:99-111` all close over.
 *
 * WHAT WENT WRONG WITHOUT THIS LIST (T-OP-081's rehearsal, operator M-3fb6774607fd4e0a): the six arrive from their
 * own deploy steps and are written back under `v2.contracts.<key>` (T-OP-116's externals step, the path
 * `check-deploy-inputs.sh:132-133` already pins), and `exactKeys` — symmetric, refusing any key it was not told
 * about — refused the written-back registry as "not a known key". The registry the deploy itself produced failed
 * the check the deploy is supposed to pass, the day after the broadcast.
 *
 * ACCEPTED, NOT REQUIRED (coordinator ruling M-ad3328c276524acb), and that asymmetry is deliberate. Every other
 * closed block is symmetric because its keys are written by THIS builder or by the core deploy in one shot. These
 * six are written by a later step at a time this builder does not control, and two of them may be skipped by the
 * owner's item-19 decision (`--skip-external`), so they are never in {V2_DEPLOYED_REQUIRED_PATHS} either. To every
 * reader "absent" and "null" already mean the same thing (`contract_of` returns empty for both; the keeper's
 * `contractsSchema` is `.passthrough()`). And the committed registries do NOT carry them yet, on purpose:
 * `render-docs.mjs:383-386` and `web/scripts/gen-markets.mjs:130` still throw on the keys, so a registry that
 * carried them today would land red under both generators; the consumers row that follows this one widens them
 * and adds the six to {V2_SKELETON} and to both registries in ONE commit (the README's rule for a new key), and only
 * then does a write-back put an address into `tier1.json`. Until then {V2_SKELETON} does not carry them either: a
 * first build from nothing must not emit a registry the generators refuse. Present or absent, then; when present,
 * null or an address; a seventh name is still refused.
 *
 * Which step deploys each — none is created by DeployV8, whose `_externallySupplied` (`DeployV8.s.sol:1740-1743`)
 * lists exactly these six by manifest name. Re-derived at callhouse-contracts `0124b58e` (leekzor/v8):
 *   earnVault, stockVenueAdapter  — `script/v2/DeployEarnVault.s.sol:104,115` (P8-02; its StockZap at `:111` has no
 *                                    registry key at all, and this row adds none — WIRE-06 P1)
 *   rewardsDistributorLender      — `script/v2/DeployLenderRewards.s.sol` (P8-05): the SECOND RewardsDistributor,
 *                                    which is why `v2.protocolAddresses.distributors.lender` is twin-less
 *   houseVaultFactory, houseVault — no production script at that SHA: only `script/v2/DevDeploy.s.sol:670`
 *                                    constructs a HouseVaultFactory, and vaults are factory-created per market
 *                                    (why `v2.protocolAddresses` has no house twin, T-232). T-OP-116 chooses the step.
 *   hedger                        — no script at that SHA either (`src/v2/periphery/Hedger.sol:88`: "`new Hedger(`
 *                                    appears only in test files"); item 19 may skip it.
 * A registry slot is not a deploy path: null here says "not yet", it never says "not planned".
 */
export const V2_EXTERNAL_CONTRACT_NAMES = [
  "houseVault", "houseVaultFactory", "hedger", "rewardsDistributorLender", "earnVault", "stockVenueAdapter",
];
/**
 * T-OP-114, from T-302's launch-phase action ("provenance-checked Earn/StockZap/HouseFactory address and
 * start-block slots"). The indexer REQUIRES a dedicated start block beside two of these addresses and refuses to
 * boot without it — `indexer/lib/env.ts:241-270`: `V2_EARN_START_BLOCK` with `V2_EARN_VAULT`, `V2_HOUSE_START_BLOCK`
 * with `V2_HOUSE_VAULT_FACTORY`, because starting them at `V2_START_BLOCK` would backfill every block between the
 * core deploy and the vault's. The only deploy blocks the registry held were `v2.deployBlock` (the core) and
 * `v2.flywheel.deployBlock` (the splitter), so a written-back external address had nowhere to record when it
 * started. `v2.externalDeployBlocks` is that home: ONE SLOT PER EXTERNAL KEY, the raw fact the externals step
 * can record mechanically beside the address it writes (the block forge simulates at is a LOWER bound on the
 * creation block, the safe direction, exactly as `DeployV8.recordBlocks` reasons for the core). The renderer
 * (`ops/v2-env.mjs`) derives the indexer's per-group value from these — the earliest of a group's members — so
 * the grouping lives with its consumer.
 *
 * REQUIRED, unlike the six address keys, and the difference is deliberate (coordinator M-b3f5ca18efa5443f): a new
 * top-level `v2` block breaks no consumer — `render-docs.mjs` and `gen-markets.mjs` close `v2.contracts`, not
 * `v2`, and the keeper's `v2BlockSchema` is `.passthrough()` — so it can land the way every other block did, in
 * {V2_SKELETON} and in both committed registries at once, all null, and stay symmetric. Exact over the six names;
 * every value null or a positive block number.
 *
 * COUPLED to the address, the flywheel's own rule (`v2.flywheel.feeSplitter` set with `deployBlock` null is
 * refused below): an external whose address is written back with its block still null is refused by name. A
 * step that records one and not the other is a half-written registry, the failure this validator exists to
 * catch, and the indexer would refuse the same pair at boot anyway (`env.ts:241-270`) — better here, on the
 * launch night, than there, after the deploy.
 */
export const V2_EXTERNAL_DEPLOY_BLOCK_KEYS = V2_EXTERNAL_CONTRACT_NAMES;
/**
 * The v2 bot keys, by ADDRESS only (ops/v2/derive-bot-keys.sh writes them; the keys stay under
 * ~/.callhouse-keys/v2/).
 *
 * INTERFACE_VERSION 8 renames and extends the set, and **every v8 key is a new key**: v7's keys are
 * never reused by v8 or by a dev stack (06-QUIRKS §G). `mmQuoter` becomes `quoter` (the role is
 * QUOTER on the manager, not a vault role any more) and `guardian` joins it, because the guardian is
 * a hot key the protocol runs rather than a wallet the owner holds. `cranker` is no longer roleless:
 * it holds BUYBACK and cranks `FeeSplitter.buyback` (V8-DESIGN §2.2).
 */
const V2_BOT_NAMES = ["cranker", "pricer", "quoter", "guardian"];
/** Which manager role each bot key holds at launch, for the messages and for ops/go-live-v2.sh. */
const V2_BOT_ROLES = { cranker: "BUYBACK", pricer: "PRICER", quoter: "QUOTER", guardian: "GUARDIAN" };
/**
 * `v2.protocolAddresses` (02-interfaces.md §3.3, O3-204): the protocol's own addresses — the ones
 * scoring flags `protocol` and `maker-epoch.mjs` never allocates to a maker (F2 D13). It is NOT a
 * `v2.contracts` key (§3.1 rule 2, which the 14-address count in ops/v2/finish-dev-deploy.sh and
 * render-docs both enforce): this block is the exclusion list, and it mirrors the blocks that hold
 * the contract slots rather than replacing them.
 *
 * Mirroring is the whole point, so it is checked. A key with a TWIN must equal it exactly, `null`
 * included, and then the list cannot silently miss a contract that was deployed, a bot key that was
 * derived or the admin wallet — the ways an exclusion list goes wrong are all "something was added
 * somewhere else and nobody added it here".
 *
 * INTERFACE_VERSION 8 closes the gap O3-204 left: `feeSplitter`, `buybackExecutor` and `treasury`
 * were "later-phase entries with no twin", which is exactly the hole this block exists to prevent.
 * Their blocks (`v2.flywheel`, `shared.safes`) exist now, so **every key but `distributors.user`
 * has a twin**. `accessManager` and `opsWallet` join for the same reason: the manager is the one
 * contract that can hand out a role, and the ops wallet is a hot wallet the protocol funds.
 */
export const V2_PROTOCOL_KEYS = [
  "accessManager", "makerVault", "autoRoller", "admin", "guardian", "feeRecipient", "opsWallet",
  "cranker", "pricer", "quoter", "feeSplitter", "buybackExecutor", "treasury", "distributors",
];
/**
 * INTERFACE_VERSION 8. `lender` was added to `tier1.json` when P8-05 landed the lender-rewards
 * distributor and this constant was not widened, so `exactKeys` reported the registry the protocol
 * actually ships as invalid — and, more quietly, the leaf-entry loop below iterates THIS array, so
 * `distributors.lender` was skipped by the null/address check and by the duplicate-address check too:
 * a lender slot holding a non-address, or the same address as another slot, passed unreported.
 */
export const V2_PROTOCOL_DISTRIBUTOR_KEYS = ["maker", "user", "lender"];
/**
 * WHY THERE IS NO `earnVault` OR `houseVault` KEY IN V2_PROTOCOL_KEYS, recorded so the next reader does not
 * add one (T-232). The lender-rewards generator excludes protocol-owned addresses by walking this block, and
 * the two it most needs to exclude are exactly the two that cannot live here:
 *   - the House vaults are FACTORY-CREATED AND PER-MARKET, so no fixed key could name them at all;
 *   - `exactKeys` is symmetric, so adding a key makes it REQUIRED on every registry the validator walks —
 *     which is precisely how adding `distributors.lender` left `ops/markets/dev.json` a line short and
 *     created a follow-up row.
 * They are passed to the generator with repeated `--exclude` instead; see ops/runbooks/lender-rewards-epoch.md.
 */
/** Each key that has a twin elsewhere in the registry, and where that twin lives. */
export const V2_PROTOCOL_TWINS = {
  accessManager: "v2.contracts.accessManager",
  makerVault: "v2.contracts.makerVault",
  autoRoller: "v2.contracts.autoRoller",
  admin: "shared.admin",
  guardian: "shared.guardian",
  feeRecipient: "shared.feeRecipient",
  opsWallet: "shared.opsWallet",
  cranker: "v2.bots.cranker",
  pricer: "v2.bots.pricer",
  quoter: "v2.bots.quoter",
  feeSplitter: "v2.flywheel.feeSplitter",
  buybackExecutor: "v2.flywheel.buybackExecutor",
  treasury: "shared.safes.treasury",
  "distributors.maker": "v2.contracts.rewardsDistributor",
  // `distributors.user` and `distributors.lender` have NO twin, deliberately. The lender distributor is
  // a SECOND DEPLOYMENT of RewardsDistributor, not a second contract, and `v2.contracts` is a closed,
  // counted block (§3.1 rule 2 — the address count and render-docs both close it), so giving it a
  // `rewardsDistributorLender` slot to mirror would change a count other tooling consumes in order to
  // describe a deployment rather than a contract. That is the same distinction that made the roles
  // manifest containment check one-way. A twin-less key is still checked: it must be an address or null,
  // and it may not duplicate another slot's address.
};
/**
 * INTERFACE_VERSION 8: empty. In v7 the deploy read `admin`, `guardian` and `feeRecipient` straight
 * out of the registry, so `null` meant a broken deploy. In v8 all three are addresses that **do not
 * exist yet** while the set is being built: `admin` is the Admin Safe the owner creates (OWN8-01),
 * `feeRecipient` is the FeeSplitter the deploy itself produces, and the guardian is a fresh hot key.
 * The rule they encoded has not gone: it moved to `v2.deployBlock` (below), which is the registry's
 * own statement that a deployment exists.
 */
export const V2_PROTOCOL_NEVER_NULL = [];
/** Once `v2.deployBlock` is set there IS a deployment, and a deployment has these. */
export const V2_PROTOCOL_DEPLOYED_NEVER_NULL = ["accessManager", "admin", "guardian", "feeRecipient"];
/**
 * The same rule, with the reach it was missing (O8-08A). `v2.deployBlock` is the switch and the four
 * keys above were the list, but that list governed only the `v2.protocolAddresses` mirror: everywhere
 * else the shape is `!== null && !isAddress(...)`, so a null passed. A post-broadcast registry with the
 * deploy block set, the four mirror keys written and `v2.contracts.orderBook` still null was GREEN —
 * a guard that is permissive at the one moment it exists for, which is launch night, under time
 * pressure, with the owner reading the check.
 *
 * Paths are dotted from the registry root so one list covers every block a deployment fills. Written
 * as a list rather than folded into each validator so the whole post-broadcast contract is readable in
 * one place and a test can assert its membership instead of restating it.
 *
 * NOT HERE, DELIBERATELY:
 *   - `v2.bots.*` — derived AFTER the deploy by `ops/v2/derive-bot-keys.sh`, which is why the message
 *     at the bots block says "null per bot until" it runs. Requiring them at deployBlock would fire
 *     during a correct launch sequence, and a guard that cries wolf on the happy path gets disabled.
 *     They stay unguarded by this rule; their own marker, if they ever need one, is a later task.
 *   - `v2.flywheel.deployBlock` — a block number, not an address, and the flywheel may be deployed in
 *     a second transaction after the core set.
 *   - Everything the twin rule already reaches: `shared.admin`, `shared.guardian`, `shared.feeRecipient`
 *     and `shared.safes.admin` are required transitively, because their `v2.protocolAddresses` mirrors
 *     are in the four-key list above and `V2_PROTOCOL_TWINS` forces equality. `shared.safes.treasury`
 *     is NOT, because `protocolAddresses.treasury` is not in that list — so it is named here.
 *
 *   - `v2.contracts.sources.dataStreams` — EXEMPT, and this is the entry most likely to be "fixed" back
 *     by someone reading the list and seeing two of three sources. `ops/go-live-v2.sh:333` treats a null
 *     there as fine ("v2.contracts.sources.dataStreams is null: fine, DataStreamsSource ships disabled
 *     (C2-12)"), and its preflight header repeats it at :29-30. Requiring it would turn
 *     `build-markets --check` RED on a correct launch night, at the moment the owner is reading the check
 *     to decide whether to broadcast. If DataStreamsSource is ever deployed, add it back here.
 *
 *   - the six {V2_EXTERNAL_CONTRACT_NAMES} (T-OP-114) — EXEMPT for the same shape of reason. They are written
 *     back by the externals step that runs AFTER DeployV8 has set `v2.deployBlock`, so between the two steps
 *     a correct launch registry has the block set and every external null; and the owner's item-19 decision
 *     may skip `hedger` and `rewardsDistributorLender` outright (`--skip-external`). Requiring them here would
 *     make the registry red in the middle of the sequence the deploy scripts themselves define.
 */
export const V2_DEPLOYED_REQUIRED_PATHS = [
  ...V2_CONTRACT_NAMES.map((k) => `v2.contracts.${k}`),
  ...V2_SOURCE_NAMES.filter((k) => k !== "dataStreams").map((k) => `v2.contracts.sources.${k}`),
  "v2.flywheel.feeSplitter",
  "v2.flywheel.buybackExecutor",
  "shared.safes.admin",
  "shared.safes.treasury",
];
/**
 * INTERFACE_VERSION 8: no key may repeat, with **one** declared alias.
 *
 * v7 allowed any two "wallet roles" to be one wallet, because `shared.admin` and
 * `shared.feeRecipient` were one hot EOA. v8 removes that: the fee recipient is a contract, the two
 * Safes are two Safes with the same owners on purpose (V3-D1, D10), the ops wallet is hot precisely
 * so that neither Safe has to be, and the guardian is a hot key that must not be able to sign as the
 * Safe. A repeat among them is no longer a configuration, it is the configuration mistake that makes
 * a delay or a 2-of-3 threshold decorative — so it is refused and the message says which pair.
 *
 * The alias: `feeRecipient` IS `feeSplitter`. Both core contracts are constructed with the splitter
 * as their fee recipient (V8-DESIGN §6), so the two keys naming one address is the design, and the
 * registry says it once here rather than in a comment somebody has to find.
 */
export const V2_PROTOCOL_ALIASES = [["feeRecipient", "feeSplitter"]];
/**
 * The per-market `v2` block. INTERFACE_VERSION 8 adds `payoutRoute`: the venue that converts a
 * winning call's Stock Tokens to USDG (and the FeeSplitter's fee stock too), which from v8 may be a
 * Uniswap **v4** pool and is therefore no longer the same thing as `univ3Pool`. `univ3Pool` stays
 * exactly what it was — the settlement TWAP source — because v4 has no observation array
 * (06-QUIRKS §H). Keeping one key for both would have silently re-pointed settlement at a v4 pool.
 */
/**
 * The markets that settle on Chainlink ALONE, frozen deliberately (T-568 posture, pinned by T-599).
 *
 * WHY THEY ARE SINGLE-SOURCE, and it is a trade rather than an oversight: every one of the 33 was
 * checked against the F2-02 recon in `ops/markets/v2-sources.json`. Pools EXIST for them — one to
 * four each — but not one has an `observationCardinality` reaching
 * `MIN_POOL_OBSERVATION_CARDINALITY`, which `src/v2/interfaces/V2Constants.sol:148` defines as
 * SETTLEMENT_WINDOW + SNAPSHOT_GRACE + 1 = 2401. Measured at callhouse `aac9d583`: the best ring
 * across all 33 is 1801, while NVDA is 6000 and SPCX 3100 — the only two that clear the bar and the
 * only two the registry points at. `RegisterMarkets.s.sol:693` makes that a HARD REQUIRE, so wiring
 * one of the 33 to its pool would not merely be worse settlement, it would REFUSE AT REGISTRATION.
 * Raising a ring with `increaseObservationCardinalityNext(2401)` and re-running
 * `ops/recon/r13-probe.mjs` is the other way forward. Either way it is not a one-line registry edit.
 *
 * WHY THE SET IS FROZEN RATHER THAN THE CONDITION REFUSED: a validator that failed on ANY
 * single-source market would fail the build on 33 markets at once, which is an outage and not a
 * guard. Freezing the set makes a 34th a DECISION someone makes, not a row that slips in.
 *
 * This is the single source of truth; `build-markets.test.mjs` imports it rather than keeping a
 * second copy, because two lists that must agree are a list that will not.
 */
export const SINGLE_SOURCE_AT_2026_09_21 = new Set([
  "AAPL", "AMD", "AMZN", "ASML", "BABA", "CLSK",
  "COIN", "CRCL", "CRWV", "DELL", "EWY", "GME",
  "GOOGL", "INTC", "IONQ", "META", "MSFT", "MSTR",
  "MU", "NBIS", "ORCL", "PLTR", "QQQ", "RGTI",
  "RKLB", "SGOV", "SLV", "SNDK", "SPY", "TSLA",
  "TSM", "USAR", "USO",
]);

/**
 * `markets[].v2`: the closed per-market key set (exactKeys, symmetric). EXPORTED, and that is T-OP-156's rule
 * "one list": `web/scripts/gen-markets.mjs` used to carry its own copy (V2_MARKET_NAMES) and threw on the
 * thirteenth key the day this file gained one -- the T-OP-138 shape for the market block. It now imports this
 * constant, as it already imports {V2_EXTERNAL_CONTRACT_NAMES}; a consumer that must close the block reads it
 * from here, never re-types it.
 */
export const V2_MARKET_KEYS = [
  "status", "wave", "strikeTick", "puts", "mintFeePpm", "univ3Pool", "univ3MinLiquidity", "dataStreamsFeedId",
  "payoutRoute", "overrides", "houseVault", "registeredAt", "registerTx",
];
/** `markets[].v2.payoutRoute`: the keys each venue carries, closed per venue (03-INTERFACES §4). */
export const PAYOUT_ROUTE_KEYS = {
  v3: ["venue", "fee"],
  v4: ["venue", "fee", "tickSpacing", "poolId"],
};
/** V2Constants: strikes and prices are multiples of PRICE_TICK; the fee ceilings the contracts enforce. */
const PRICE_TICK = 100n;
const FEE_CEIL_BPS = { premiumFeeBps: 1000, resaleFeeBps: 1000, takerFeeCapBps: 1000, makerRebateBps: 10_000, exerciseFeeBps: 200 };
const TAKER_FEE_FLAT_CEIL = 1_000_000n;
/**
 * V2Constants.MINT_FEE_CEIL_PPM (INTERFACE_VERSION 7, c05): the highest collateral rent a market may be
 * registered with, in millionths of the locked collateral per MINT_FEE_PERIOD (7 days) of remaining life.
 * Clearinghouse._checkConfig reverts CeilingExceeded above it.
 */
const MINT_FEE_CEIL_PPM = 5000;
/**
 * V8-DESIGN §4.3 / V3-D18: v8 charges a 5 % premium fee on first sale and **no writer rent**. The rent
 * code stays in the Clearinghouse as a dial at zero, so the ceiling above still bounds it — but a
 * registry that carries a non-zero rate is refused unless it also carries `v2.fees.allowRent: true`.
 * The v7 rule was the exact opposite (zero was refused), which is why the inversion has to be one
 * commit with the data: a half-inverted pair of checks passes both registries or neither.
 */
const ALLOW_RENT_KEY = "v2.fees.allowRent";
/**
 * Uniswap v4: a pool's `tickSpacing` is an int24 the PoolManager bounds to [1, 32767] (MAX_TICK_SPACING).
 * It is part of the PoolKey and therefore of the pool id, so a wrong one names a different pool.
 */
const MAX_TICK_SPACING = 32_767;
/**
 * SettlementOracle: the delay a market with only one ok source waits between recording a candidate and
 * finalizing on it. 21,600 s (6 h) is the registry default; the owner's 2026-09-19 decision drops it to
 * 3,600 s on the Chainlink-only launch markets (the 19 rows land in O8-10, the mechanism here). It is a
 * uint32 in `SettlementConfigPinned`, and 0 would finalize a single uncorroborated source immediately —
 * which is the one thing the delay exists to prevent.
 *
 * These two MIRROR `SettlementOracle.MIN_UNCORROBORATED_DELAY` (30 minutes) and
 * `MAX_UNCORROBORATED_DELAY` (24 hours). They are not an independent ops policy: the contract reverts
 * outside that band, so a looser registry bound only means a market passes `--check` and then fails
 * on chain. They were originally reasoned rather than read — 900 and 4 days — and both were too
 * permissive in the direction that hides the failure until deploy time. If the contract's band ever
 * changes, re-derive these from it rather than re-reasoning them.
 */
const MIN_UNCORROBORATED_DELAY_S = 1_800;
const MAX_UNCORROBORATED_DELAY_S = 86_400;
/**
 * V2Constants.MIN_POOL_OBSERVATION_CARDINALITY (SETTLEMENT_WINDOW + SNAPSHOT_GRACE + 1). Owner sign-off c10
 * (DECISIONS-2026-09-17 §7): a pool with a shorter observation ring can have the expiry's window overwritten by
 * one dust mint or burn per second before the snapshot grace ends, so UniV3TwapSource.setPool refuses it and the
 * market is registered Chainlink-only. Every launch pool but NVDA's and SPCX's is below it.
 */
const MIN_POOL_OBSERVATION_CARDINALITY = 2401;
/** V2Constants.MAX_ROUTE_FEE_TIER: the highest Uniswap v3 fee tier (hundredths of a bip) a v2 pool may have. */
const MAX_ROUTE_FEE_TIER = 10_000;
/** SettlementOracle.MAX_SPOT_MAX_AGE (4 days): setMarket refuses a larger spotMaxAge. */
const MAX_SPOT_MAX_AGE_S = 4 * 86_400;
/**
 * The least a market's spotMaxAgeS may exceed its feed's heartbeat by. The Robinhood Chain equity feeds print on a
 * 0.5 % move or the 24 h heartbeat, so a quiet feed's last print is up to a heartbeat (plus a transmit latency of at
 * most 30 s, 2026-08-03..09-17) old inside a regular session; any smaller age makes `spot()` revert StaleSpot for part
 * of most sessions (ops/deploy.md §15.13).
 */
const SPOT_AGE_OVER_HEARTBEAT_S = 3600;
const UINT128_MAX = (1n << 128n) - 1n;

/**
 * What a registry with no top-level `v2` block gets (a first build from nothing): the frozen
 * schema with every address null. The periphery addresses are the Uniswap v3 deployment on 4663
 * that the F2-02 recon found with code; the fees and defaults are the launch values of the plan.
 */
export const V2_SKELETON = {
  interfaceVersion: INTERFACE_VERSION,
  deployBlock: null,
  contracts: {
    ...Object.fromEntries(V2_CONTRACT_NAMES.map((k) => [k, null])),
    sources: Object.fromEntries(V2_SOURCE_NAMES.map((k) => [k, null])),
  },
  // T-OP-114 (T-302): one start block per external contract, null until the externals step writes the
  // address beside it. The six ADDRESS keys are not here yet — see V2_EXTERNAL_CONTRACT_NAMES.
  externalDeployBlocks: Object.fromEntries(V2_EXTERNAL_DEPLOY_BLOCK_KEYS.map((k) => [k, null])),
  bots: Object.fromEntries(V2_BOT_NAMES.map((k) => [k, null])),
  // 02-interfaces.md §3.3. Every twin starts where its own block starts, which in v8 is null for all
  // of them: the Safes, the splitter and the v8 bot keys are all made during the v8 launch.
  protocolAddresses: {
    ...Object.fromEntries(V2_PROTOCOL_KEYS.filter((k) => k !== "distributors").map((k) => [k, null])),
    distributors: Object.fromEntries(V2_PROTOCOL_DISTRIBUTOR_KEYS.map((k) => [k, null])),
  },
  // INTERFACE_VERSION 8 (V8-DESIGN §6): the native FeeSplitter and the v4 buyback executor. They are
  // not `v2.contracts` keys — that block is closed and counted by the deploy tooling — and they carry
  // their own deploy block because the splitter is constructed BEFORE the core (it is the core's fee
  // recipient), so its first event can precede `v2.deployBlock`.
  //
  // DO NOT ADD A `tokenPool` BLOCK HERE. T-OP-002 asked whether the v4 token-pool parameters belong
  // under `v2.flywheel`, and the answer is that they belong in the registry but ALREADY HAVE A HOME
  // somewhere else: `shared.token.poolKey` at :137, whose five keys are validated by
  // SHARED_TOKEN_KEYS (:144) and POOL_KEY_KEYS (:145). The contracts side names that path as the
  // source of truth twice -- `script/v2/lib/V2DeployBase.sol:281-282` ("`poolKey` is the registry's
  // `shared.token.poolKey` verbatim") and `:288` ("V2_TOKEN_POOL_*: shared.token.poolKey, the ONE v4
  // pool the token is bought on") -- and `ops/v2/monitor.mjs:3792-3799` reads it, so the home is live
  // rather than vestigial.
  //
  // WHAT SENDS PEOPLE HERE: `script/v2/DeployV2Batch.sh:339-342` reads
  // `.v2.flywheel.tokenPool.currency1 / .hooks / .fee / .tickSpacing`, and its die messages at :354
  // and :357 tell the operator to "write it down" in the registry. Doing what they say produces a
  // registry that `exactKeys` rejects, because this block is closed -- so the instruction and the
  // validator contradict each other and each is individually reasonable. The validator is not being
  // over-strict: it is correctly refusing a path the schema does not define.
  //
  // WHY ADDING IT HERE WOULD BE WORSE THAN THE BUG: `exactKeys` is SYMMETRIC (see the note at :290),
  // so a new key here becomes REQUIRED on every registry this validator walks, and the same four
  // values would then have two homes that can disagree. One path that is wrong is strictly better
  // than two paths that drift. The fix belongs in the contracts wrapper, which must read
  // `shared.token.poolKey`; `currency0` is not among the four it reads because `V2DeployBase.sol:281`
  // fixes it at native ETH, address zero.
  //
  // AND REPOINTING THE WRAPPER WAS NECESSARY BUT NOT SUFFICIENT -- found while running the proof for
  // T-OP-002, not by reading. `shared.token.poolKey` could not hold a key the DEPLOYED executor would
  // accept: the validator required `hooks` to be the zero address (quoting V8-DESIGN 6A, "the buyback
  // only ever buys on a hookless pool"), while `src/v2/periphery/V4BuybackExecutor.sol:255` reverts
  // `NoSource` when `cfg.key.hooks.code.length == 0` and `:256` further requires that hook to be the
  // PoolManager's registered launch hook -- the executor reads `launches(poolId).hookFeeBps` and
  // `.creatorTaxBps` off it for its whole fee model. Measured then: a scratch tier1.json with the live
  // pinned key filled in failed `--check` on that rule.
  // RESOLVED BY THE OWNER, 2026-09-21, and implemented in T-OP-012: the buyback venue is PERMANENTLY
  // the Pons launch pool. The validator was stale, not the executor. 6A is the PAYOUT ROUTE section and
  // its zero-hooks sentence never governed this key; routes keep it. The rule on
  // `shared.token.poolKey.hooks` is now the positive one -- a pinned key must name a real hook -- and
  // relaxing it does NOT admit arbitrary hook code into a payout swap, because a route's poolId is
  // still recomputed with `hooks: ZERO_ADDRESS` hard-coded. No contracts file changed.
  flywheel: { feeSplitter: null, buybackExecutor: null, deployBlock: null },
  // WHY THERE IS NO `uniswapV4` SIBLING, recorded so the next reader does not add one (T-OP-018).
  //
  // The v4 PoolManager (0x8366a39C...40951) and StateView (0xF3334192...E673b) are known, verified and
  // written down -- in ops/markets/v2-sources.json `contracts.v4PoolManager` / `contracts.v4StateView`,
  // the external-dependency block whose every entry carries `codeExists`. That is the home the ONE
  // live consumer reads: `script/v2/DeployV2Batch.sh:312-313` (callhouse-contracts v8) exports
  // V2_V4_POOL_MANAGER / V2_V4_STATE_VIEW from `.contracts.v4PoolManager.address` and
  // `.contracts.v4StateView.address` of the recon, deliberately, with the same reasoning as
  // `verifierProxy` and `pythPro` -- neither of which has a registry twin either.
  //
  // `uniswapV3` is here because five app-side readers take it from THIS file and nothing else
  // (keeper/src/v2/registry.ts:703, web/scripts/gen-markets.mjs:351, ops/devnet/seed.mjs:400 and
  // up.sh:228, ops/v2/rehearse/1-fork.mjs:230, ops/markets/render-docs.mjs:556). Measured at
  // 135c0712 (2026-09-21): NOTHING in keeper, web, indexer, ops or the contracts scripts reads a
  // `v2.uniswapV4` path. The one would-be reader is the monitor's token-pool depth check
  // (ops/v2/monitor.mjs:5696, alerts.md "registry publishes no PoolManager"), which is off by default
  // and recorded as a deliberate gap; when that check is built it can read the recon like the wrapper.
  //
  // What DOES name `v2.uniswapV4` is documentation, and it is stale: callhouse-contracts
  // docs/DEPLOY-V2.md:113 and :499 and script/v2/lib/V2DeployBase.sol:253-254 say the two env vars
  // come from `v2.uniswapV4.poolManager` / `.stateView`. An operator who follows them adds the block
  // here, and `exactKeys` refuses it ("not a known key") -- the same contradiction shape as the
  // `tokenPool` note above. validateV2Top now says where the value lives instead.
  //
  // Adding the key would also make it REQUIRED on ops/markets/dev.json, because `exactKeys` is
  // symmetric (see :290); and it would be a second hand-written copy of an address the recon already
  // holds -- the drift this registry exists to prevent. If a reader of this file ever needs the pair,
  // add it with a recon cross-check like the v3 loop in validateV2Top, in the same commit as dev.json.
  //
  // Re-derived on chain before this note was written (rpc.mainnet.chain.robinhood.com, 2026-09-21):
  // eth_chainId 0x1237; eth_getCode 24009 bytes at the PoolManager and 3531 at the StateView;
  // eth_call StateView.poolManager() (selector 0xdc4c90d3) returned the PoolManager, and the same
  // selector against the PoolManager itself reverted -- so the check can fail.
  //
  // EIP-55, EXACTLY AS `cast to-check-sum-address` PRINTS THEM (T-OP-131). These three were lowercase from
  // the first build and every reader that compared case-insensitively was happy; the strict readers were not:
  // viem's `isAddress(a, { strict: true })`, the registry test's own EIP-55 rule, and the contracts deploy
  // preflight's EIP-55 rule (T-OP-112 finding #3; the wrapper reads `v2.uniswapV3.factory` / `.swapRouter02`
  // through callhouse-contracts script/v2/lib/registry-env.sh since T-OP-113), which refuses any registry
  // address that is not canonical. The case is a function of the twenty bytes, so this is a re-casing and not
  // a new fact: the bytes are the F2-02 recon's (`validateV2Top` still cross-checks them against
  // v2-sources.json by value), and a registry copy that differs from these strings -- by case, or by bytes --
  // is refused by `--check` (`validateV2Top`) with the fault named, so the three cannot drift again. Not
  // mirrored on build: `v2` is a hand-maintained root key that T-607's guard carries as written, so a rebuild
  // cannot repair a drifted copy either -- the refusal names the string to set.
  uniswapV3: {
    factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
    swapRouter02: "0xCaf681a66D020601342297493863E78C959E5cb2",
    quoterV2: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
  },
  // INTERFACE_VERSION 8 (V3-D6, D17, D18): the writer pays 5 % of the premium on FIRST SALE and no rent.
  // `mint` is callable only by an allowlisted minter (the OrderBook at launch), so every long that
  // exists was created inside a fill with a known premium — which is what makes a premium fee above the
  // resale fee collectable at all. `mintFeePpm` is the rent dial, launched at 0 on every market and kept
  // only so it can be switched on later under the 72 h lane; `allowRent` is the explicit opt-in that a
  // non-zero rate needs anywhere in the registry.
  fees: { premiumFeeBps: 500, mintFeePpm: 0, allowRent: false, resaleFeeBps: 0, takerFeeFlat: "100000", takerFeeCapBps: 1000, makerRebateBps: 5000, exerciseFeeBps: 25 },
  // INTERFACE_VERSION 7 (c21): the MakerVault Limits tuple the deploy sets, all six fields in setLimits order
  // in the pinned contracts. maxDailyOutflow is the leaky-bucket cap on net USDG a quoter call may pay out: at most the
  // cap at once and at most twice the cap in 24 h. The deploy reads them as V2_VAULT_* env; recorded here so the
  // incident runbook, the monitor and a later setLimits all quote the same six fields.
  vault: {
    maxSeriesUnits: "10000",
    maxTotalNotional: "250000000000",
    askToleranceBps: 100,
    maxBidBpsOfSpot: 1000,
    maxOrderLifetime: 0,
    maxDailyOutflow: "2500000000",
  },
  defaults: {
    maxDeviationBps: 150,
    uncorroboratedDelayS: 21600,
    // The feeds' 24 h heartbeat plus 1 h (ops/deploy.md §15.13): a quiet feed's last print stays accepted.
    spotMaxAgeS: 90000,
    ladder: {
      weekly: { rungs: 5, firstOtmBps: 200, stepBps: 200, cardTargetBps: 400 },
      daily: { rungs: 5, firstOtmBps: 100, stepBps: 100, cardTargetBps: 200 },
    },
    expiriesAhead: { weekly: 2, daily: 3 },
  },
};

/**
 * A market first seen by the builder gets this `v2` block: planned, last wave, no pool, no route.
 * `strikeTick` is deliberately null, which validation refuses: a tick has to be chosen from the Cboe
 * listing (ops/recon/r13-probe.mjs proposes one), never defaulted.
 *
 * INTERFACE_VERSION 8: `mintFeePpm` is **0**, not null. In v7 it was null on purpose, because a market
 * that silently inherited a rent rate would charge its writers the wrong one. v8 LAUNCHES every market
 * at 0 rent (V3-D18), so 0 is the reviewed value rather than a missing one — and a new market that came
 * up with a non-zero rate is now what the validator refuses.
 *
 * The rent PATH is still in the contract, and saying "v8 charges no rent" would be a claim about the
 * chain rather than about this file: `Clearinghouse.mint` still computes
 * `OptionMath.mintFee(need, s.mintFeePpm, expiry - block.timestamp)` on every mint
 * (callhouse-contracts v8 `1c536ffe`, `src/v2/Clearinghouse.sol:579`), and a series pins its rate at
 * creation for its whole life. 0 here is a configuration, not a capability that was removed — which is
 * exactly why the monitor's rent alert is inverted under interface 8 rather than deleted (alerts.md §V59).
 */
const v2MarketSkeleton = () => ({
  status: "planned",
  wave: "wave2",
  strikeTick: null,
  puts: false,
  mintFeePpm: 0,
  univ3Pool: null,
  univ3MinLiquidity: null,
  dataStreamsFeedId: null,
  payoutRoute: null,
  overrides: {},
  // T-OP-156 (owner ruling 2026-09-22, two HouseVaults at launch): this market's HouseVault, written back by
  // the broadcast's externals stage per ticker (callhouse-contracts DeployV2Batch.sh, the same node snippet
  // that writes registeredAt / registerTx below); null until then and null for ever on a market outside
  // `launchSet.markets`. `v2.contracts.houseVault` (T-OP-114) stays the ONE address VerifyV8 walks: the first
  // launch ticker's vault, and {validateMarket} refuses the two disagreeing.
  houseVault: null,
  registeredAt: null,
  registerTx: null,
});

const args = new Set(process.argv.slice(2));
const argValue = (flag) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
const CHECK_ONLY = args.has("--check");
const SKIP_CBOE = args.has("--skip-cboe");
const FEEDS_FILE = argValue("--feeds");

/*//////////////////////////////////////////////////////////////
                             HELPERS
//////////////////////////////////////////////////////////////*/

const log = (...a) => console.error(...a);

/** EIP-55 checksum without a dependency: keccak-256 over the lowercase hex, via `cast keccak`. */
async function checksum(addr) {
  const { stdout } = await execFileP("cast", ["to-check-sum-address", addr]);
  return stdout.trim();
}

/** `cast call` with a typed signature; returns the output lines with cast's `[1.2e3]` annotations stripped. */
async function call(to, sig, block, args = []) {
  const a = ["call", to, sig, ...args, "--rpc-url", RPC];
  if (block !== undefined) a.push("--block", String(block));
  const { stdout } = await execFileP("cast", a, { timeout: 30_000 });
  return stdout
    .trim()
    .split("\n")
    .map((l) => l.replace(/\s+\[[^\]]*\]\s*$/, "").trim());
}

const unquote = (s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s);

async function blockNumber() {
  const { stdout } = await execFileP("cast", ["block-number", "--rpc-url", RPC]);
  return Number(stdout.trim());
}

/** Run `fn` over `items` with at most `n` in flight. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/** `Robinhood NVDA / USD` and `Robinhood DELL-USD` both mean NVDA / DELL. */
function tickerOf(feed) {
  const m = feed.name.match(/^Robinhood\s+([A-Z0-9.]+)\s*(?:\/|-)\s*USD$/);
  return m ? m[1] : null;
}

/** The next two Fridays after `now`, as Cboe's YYMMDD. */
function nextFridays(now, count = 2) {
  const out = [];
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  while (out.length < count) {
    d.setUTCDate(d.getUTCDate() + 1);
    if (d.getUTCDay() === 5) {
      out.push(
        `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`,
      );
    }
  }
  return out;
}

/*//////////////////////////////////////////////////////////////
                              INPUTS
//////////////////////////////////////////////////////////////*/

async function loadFeeds() {
  if (FEEDS_FILE) {
    // Keep local input provenance without embedding a private machine path in the public registry.
    return { source: `local snapshot: ${path.basename(FEEDS_FILE)}`, feeds: JSON.parse(readFileSync(FEEDS_FILE, "utf8")) };
  }
  const res = await fetch(FEEDS_URL, { headers: { "user-agent": "stonkhouse-ops/1.0" } });
  if (!res.ok) throw new Error(`feed directory: HTTP ${res.status}`);
  return { source: FEEDS_URL, feeds: await res.json() };
}

function loadTokens() {
  return JSON.parse(readFileSync(TOKENS, "utf8"));
}

function loadExisting() {
  if (!existsSync(OUT)) return null;
  return JSON.parse(readFileSync(OUT, "utf8"));
}

/*//////////////////////////////////////////////////////////////
                           VERIFICATION
//////////////////////////////////////////////////////////////*/

async function verifyPair(ticker, asset, feed, block) {
  const issues = [];
  const v = { block, ok: false };
  try {
    v.feedDecimals = Number((await call(feed, "decimals()(uint8)", block))[0]);
    if (v.feedDecimals !== 8) issues.push(`feed decimals ${v.feedDecimals} != 8`);
  } catch (e) {
    issues.push(`feed decimals(): ${e.message.split("\n")[0]}`);
  }
  try {
    const [roundId, answer, , updatedAt] = await call(
      feed,
      "latestRoundData()(uint80,int256,uint256,uint256,uint80)",
      block,
    );
    v.feedRoundId = roundId;
    v.feedAnswer = answer;
    v.feedUpdatedAt = Number(updatedAt);
    v.feedAgeS = Math.floor(Date.now() / 1000) - v.feedUpdatedAt;
    if (BigInt(answer) <= 0n) issues.push(`feed answer ${answer} <= 0`);
    if (v.feedAgeS > DEFAULTS.maxPriceAgeS) issues.push(`feed age ${v.feedAgeS}s > maxPriceAge ${DEFAULTS.maxPriceAgeS}s`);
    v.spotUsd = Number(BigInt(answer)) / 1e8;
  } catch (e) {
    issues.push(`feed latestRoundData(): ${e.message.split("\n")[0]}`);
  }
  try {
    v.feedDescription = unquote((await call(feed, "description()(string)", block))[0]);
    if (!v.feedDescription.includes(ticker)) issues.push(`feed description "${v.feedDescription}" lacks ${ticker}`);
  } catch (e) {
    issues.push(`feed description(): ${e.message.split("\n")[0]}`);
  }
  try {
    v.tokenDecimals = Number((await call(asset, "decimals()(uint8)", block))[0]);
    if (v.tokenDecimals !== 18) issues.push(`token decimals ${v.tokenDecimals} != 18`);
  } catch (e) {
    issues.push(`token decimals(): ${e.message.split("\n")[0]}`);
  }
  try {
    v.tokenSymbol = unquote((await call(asset, "symbol()(string)", block))[0]);
    if (v.tokenSymbol !== ticker) issues.push(`token symbol "${v.tokenSymbol}" != ${ticker}`);
  } catch (e) {
    issues.push(`token symbol(): ${e.message.split("\n")[0]}`);
  }
  try {
    v.uiMultiplier = (await call(asset, "uiMultiplier()(uint256)", block))[0];
    if (BigInt(v.uiMultiplier) === 0n) issues.push("uiMultiplier() == 0");
  } catch (e) {
    issues.push(`token uiMultiplier(): ${e.message.split("\n")[0]}`);
  }
  try {
    v.oraclePaused = (await call(asset, "oraclePaused()(bool)", block))[0] === "true";
    if (v.oraclePaused) issues.push("oraclePaused() == true");
  } catch (e) {
    issues.push(`token oraclePaused(): ${e.message.split("\n")[0]}`);
  }
  v.issues = issues;
  v.ok = issues.length === 0;
  return v;
}

/*//////////////////////////////////////////////////////////////
                               CBOE
//////////////////////////////////////////////////////////////*/

async function probeCboe(root, spotUsd, previous) {
  const checkedAt = new Date().toISOString();
  const out = { root, url: CBOE(root), checkedAt, http: null, rows: 0, expiries: [], weekly: false, currentPrice: null, spotDivergenceBps: null, underlyingMatches: null };
  try {
    const res = await fetch(out.url, { headers: { "user-agent": "Mozilla/5.0 stonkhouse-ops/1.0" }, signal: AbortSignal.timeout(30_000) });
    out.http = res.status;
    if (!res.ok) return out;
    const json = await res.json();
    const opts = json?.data?.options ?? [];
    out.rows = opts.length;
    out.symbol = json?.data?.symbol ?? null;
    out.currentPrice = typeof json?.data?.current_price === "number" ? json.data.current_price : null;
    const exps = new Set();
    for (const o of opts) {
      const m = /^[A-Z.]+(\d{6})[CP]\d+$/.exec(o.option ?? "");
      if (m) exps.add(m[1]);
    }
    out.expiries = [...exps].sort();
    const fridays = nextFridays(new Date());
    out.weekly = fridays.every((f) => exps.has(f));
    if (out.currentPrice !== null && spotUsd) {
      out.spotDivergenceBps = Math.round((Math.abs(out.currentPrice / spotUsd - 1)) * 10_000);
      out.underlyingMatches = out.spotDivergenceBps <= DEFAULTS.maxSpotDivergenceBps;
    }
  } catch (e) {
    out.error = e.message;
    if (previous) return { ...previous, lastError: e.message, lastErrorAt: checkedAt };
  }
  return out;
}

/** vol only when the chain is weekly AND is the same underlying as the feed. */
function modeFor(cboe) {
  if (!cboe || cboe.http !== 200) return { mode: "fixed", reason: "no Cboe chain" };
  if (!cboe.weekly) return { mode: "fixed", reason: `no weekly expiries (has ${cboe.expiries.slice(0, 4).join(",")}…)` };
  if (cboe.underlyingMatches === false) {
    return { mode: "fixed", reason: `Cboe ${cboe.root} is a different instrument: current_price diverges ${cboe.spotDivergenceBps} bps from the feed` };
  }
  return { mode: "vol", reason: `weekly chain, ${cboe.rows} rows, spot divergence ${cboe.spotDivergenceBps ?? "?"} bps` };
}

/*//////////////////////////////////////////////////////////////
                         V2 VALIDATION
//////////////////////////////////////////////////////////////*/

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isAddress = (v) => typeof v === "string" && ADDRESS.test(v);
const isUint = (v) => Number.isSafeInteger(v) && v >= 0;
const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;
/** A decimal string within (0, max]: how the registry spells a big integer (§3: strikeTick, takerFeeFlat). */
const isDecimalIn = (v, max) => typeof v === "string" && DECIMAL.test(v) && BigInt(v) > 0n && BigInt(v) <= max;

function loadV2Sources() {
  return existsSync(V2_SOURCES) ? JSON.parse(readFileSync(V2_SOURCES, "utf8")) : null;
}

/** Exactly these keys. Every consumer reads fixed names, so a misspelt key would be ignored silently. */
function exactKeys(obj, keys, where, issues) {
  for (const k of keys) if (!(k in obj)) issues.push(`${where}.${k} is missing`);
  for (const k of Object.keys(obj)) if (!keys.includes(k)) issues.push(`${where}.${k} is not a known key (${keys.join(", ")})`);
}

/** An object whose every leaf is a non-negative integer, shaped like `shape`: the defaults and ladders. */
function intTree(obj, shape, where, issues, { exact }) {
  if (!isObject(obj)) {
    issues.push(`${where} must be an object`);
    return;
  }
  if (exact) exactKeys(obj, Object.keys(shape), where, issues);
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in shape)) {
      if (!exact) issues.push(`${where}.${k} is not a key of v2.defaults`);
      continue;
    }
    if (isObject(shape[k])) intTree(v, shape[k], `${where}.${k}`, issues, { exact });
    else if (!isUint(v)) issues.push(`${where}.${k} must be a non-negative integer, not ${JSON.stringify(v)}`);
  }
}

/** The top-level `v2` block. Offline; `recon` (v2-sources.json) cross-checks the periphery addresses. */
function validateV2Top(v2, recon, issues) {
  if (!isObject(v2)) {
    issues.push("v2 (top level) is missing or not an object");
    return;
  }
  exactKeys(v2, Object.keys(V2_SKELETON), "v2", issues);
  // T-OP-018. `exactKeys` already refuses the key; this names where the value lives, because the
  // contracts docs send an operator here and the generic message would send them to the skeleton next.
  // If a later row does add `uniswapV4` to V2_SKELETON (with dev.json and a recon cross-check in the
  // same commit), delete this branch and the two T-OP-018 tests in that commit: they pin the absence.
  if ("uniswapV4" in v2) {
    issues.push(
      "v2.uniswapV4 is not a registry key: the v4 PoolManager and StateView live in ops/markets/v2-sources.json contracts.v4PoolManager / contracts.v4StateView, which script/v2/DeployV2Batch.sh reads directly (see the note at V2_SKELETON.uniswapV3)",
    );
  }
  if (v2.interfaceVersion !== INTERFACE_VERSION) issues.push(`v2.interfaceVersion is ${JSON.stringify(v2.interfaceVersion)}, this builder knows ${INTERFACE_VERSION}`);
  if (v2.deployBlock !== null && !isPositiveInt(v2.deployBlock) && !isDecimalIn(v2.deployBlock, BigInt(Number.MAX_SAFE_INTEGER))) {
    issues.push("v2.deployBlock must be null or a positive block number");
  }
  if (isObject(v2.contracts)) {
    // T-OP-114: the recorded set and `sources` are exact; an external key is known only when present, and is
    // then held to the same null-or-address rule. `present` is computed once so the two loops cannot disagree.
    const present = V2_EXTERNAL_CONTRACT_NAMES.filter((k) => k in v2.contracts);
    exactKeys(v2.contracts, [...V2_CONTRACT_NAMES, ...present, "sources"], "v2.contracts", issues);
    for (const k of [...V2_CONTRACT_NAMES, ...present]) {
      if (k in v2.contracts && v2.contracts[k] !== null && !isAddress(v2.contracts[k])) issues.push(`v2.contracts.${k} must be null or an address`);
    }
    if (isObject(v2.contracts.sources)) {
      exactKeys(v2.contracts.sources, V2_SOURCE_NAMES, "v2.contracts.sources", issues);
      for (const k of V2_SOURCE_NAMES) {
        const a = v2.contracts.sources[k];
        if (a !== undefined && a !== null && !isAddress(a)) issues.push(`v2.contracts.sources.${k} must be null or an address`);
      }
    } else issues.push("v2.contracts.sources must be an object");
  } else issues.push("v2.contracts must be an object");
  // T-OP-114 (T-302): the externals' start blocks — exact over the six names, each null or a positive block
  // number judged exactly as `v2.deployBlock` is above, and COUPLED to the address: an external written back
  // under `v2.contracts.<key>` with its block still null is a half-written registry (the flywheel rule at
  // `v2.flywheel.feeSplitter`, below, is the precedent).
  if (isObject(v2.externalDeployBlocks)) {
    exactKeys(v2.externalDeployBlocks, V2_EXTERNAL_DEPLOY_BLOCK_KEYS, "v2.externalDeployBlocks", issues);
    for (const k of V2_EXTERNAL_DEPLOY_BLOCK_KEYS) {
      const b = v2.externalDeployBlocks[k];
      if (b !== undefined && b !== null && !isPositiveInt(b) && !isDecimalIn(b, BigInt(Number.MAX_SAFE_INTEGER))) {
        issues.push(`v2.externalDeployBlocks.${k} must be null or a positive block number`);
      }
      if (isAddress(v2.contracts?.[k]) && (b === undefined || b === null)) {
        issues.push(`v2.contracts.${k} is set but v2.externalDeployBlocks.${k} is null: the indexer has no block to start ${k} from (write the two back together)`);
      }
    }
  } else {
    issues.push(`v2.externalDeployBlocks must be an object of { ${V2_EXTERNAL_DEPLOY_BLOCK_KEYS.join(", ")} } start blocks (null until each external's deploy writes it)`);
  }
  if (isObject(v2.bots)) {
    exactKeys(v2.bots, V2_BOT_NAMES, "v2.bots", issues);
    for (const k of V2_BOT_NAMES) {
      if (k in v2.bots && v2.bots[k] !== null && !isAddress(v2.bots[k])) issues.push(`v2.bots.${k} must be null or an address`);
    }
  } else issues.push("v2.bots must be an object (null per bot until ops/v2/derive-bot-keys.sh writes the address)");
  if (isObject(v2.uniswapV3)) {
    exactKeys(v2.uniswapV3, Object.keys(V2_SKELETON.uniswapV3), "v2.uniswapV3", issues);
    const reconNames = { factory: "factory", swapRouter02: "router", quoterV2: "quoter" };
    for (const [k, r] of Object.entries(reconNames)) {
      const a = v2.uniswapV3[k];
      if (!isAddress(a)) {
        issues.push(`v2.uniswapV3.${k} must be an address`);
        continue;
      }
      const seen = recon?.contracts?.[r];
      if (seen && (seen.address.toLowerCase() !== a.toLowerCase() || seen.codeExists !== true)) {
        issues.push(`v2.uniswapV3.${k} ${a} is not the ${r} the F2-02 recon found with code (${seen.address})`);
      }
      // T-OP-131: the recon check above compares BYTES (lowercased); the STRING is judged here against the
      // builder's own constant, in two refusals that name different faults. `v2` is a hand-maintained root
      // key that a rebuild carries as written (assembleRegistry), so `--check` is the only thing that can
      // see a copy drift from V2_SKELETON.uniswapV3 -- and it must say which of two things is wrong:
      //   (1) same bytes, wrong case: every case-insensitive reader is happy and every strict one refuses
      //       (viem isAddress strict, this file's registry test, the contracts deploy preflight's EIP-55
      //       rule), so the message names the exact string to set;
      //   (2) different bytes: a registry may not name a different factory / router / quoter than the
      //       builder pins, whatever the recon says -- the constant is the source and the recon is the
      //       cross-check, not the other way round.
      // Both are offline; the test file breaks each on a scratch copy and watches it go red by name.
      const want = V2_SKELETON.uniswapV3[k];
      if (a.toLowerCase() !== want.toLowerCase()) {
        issues.push(`v2.uniswapV3.${k} ${a} is not the ${k} V2_SKELETON.uniswapV3 pins (${want}); the builder's constant is the source, change it there or restore the registry`);
      } else if (a !== want) {
        issues.push(`v2.uniswapV3.${k} ${a} is the right address in the wrong case; set it to exactly ${want} (its EIP-55 form, which the strict readers require)`);
      }
    }
  } else issues.push("v2.uniswapV3 must be an object");
  if (isObject(v2.fees)) {
    exactKeys(v2.fees, Object.keys(V2_SKELETON.fees), "v2.fees", issues);
    for (const [k, ceil] of Object.entries(FEE_CEIL_BPS)) {
      if (k in v2.fees && !(isUint(v2.fees[k]) && v2.fees[k] <= ceil)) issues.push(`v2.fees.${k} must be an integer in [0, ${ceil}]`);
    }
    const flat = v2.fees.takerFeeFlat;
    if ("takerFeeFlat" in v2.fees && !(flat === "0" || isDecimalIn(flat, TAKER_FEE_FLAT_CEIL))) {
      issues.push(`v2.fees.takerFeeFlat must be a decimal string of USDG base units in [0, ${TAKER_FEE_FLAT_CEIL}]`);
    }
    // INTERFACE_VERSION 8 (V3-D6, D17), the INVERSION of the v7 rule. v7 refused premium > resale,
    // because a writer could mint outside the book and resell at the resale fee. v8 closed that by
    // making `mint` callable only from an allowlisted minter, so the premium fee is the writer fee and
    // it MUST stand above the resale fee — premium <= resale is a registry that charges the writer
    // nothing on first sale while v8 charges no rent either, i.e. a protocol with no writer revenue at
    // all. A half-inverted pair of checks would accept that silently, so the message names both values.
    if (isUint(v2.fees.premiumFeeBps) && isUint(v2.fees.resaleFeeBps) && v2.fees.premiumFeeBps <= v2.fees.resaleFeeBps) {
      issues.push(
        `v2.fees.premiumFeeBps ${v2.fees.premiumFeeBps} is not above v2.fees.resaleFeeBps ${v2.fees.resaleFeeBps}: from INTERFACE_VERSION 8 the writer fee IS the premium fee, charged on the first sale of every long (mint is minter-only, V8-DESIGN §4.2), there is no rent to fall back on, and a resale fee at or above it taxes market-maker round trips instead of writers`,
      );
    }
    // INTERFACE_VERSION 8 (V3-D18), the INVERSION of the v7 rent rule. v7 refused 0; v8 refuses
    // ANYTHING BUT 0 unless the registry says `allowRent: true` out loud. The dial is still in the
    // Clearinghouse and can be switched on later under the 72 h MARKET_FEE_MANAGER lane, so the flag is
    // how that decision gets written down rather than arriving as an unexplained number in a diff.
    if (typeof v2.fees.allowRent !== "boolean") {
      issues.push(`${ALLOW_RENT_KEY} must be true or false: it is the explicit opt-in a non-zero writer rent needs in v8`);
    }
    if (!isUint(v2.fees.mintFeePpm)) {
      issues.push("v2.fees.mintFeePpm must be a non-negative integer (the rent dial; 0 everywhere in v8)");
    } else if (v2.fees.allowRent === true) {
      if (v2.fees.mintFeePpm > MINT_FEE_CEIL_PPM) {
        issues.push(`v2.fees.mintFeePpm ${v2.fees.mintFeePpm} is above MINT_FEE_CEIL_PPM (${MINT_FEE_CEIL_PPM}); Clearinghouse._checkConfig reverts CeilingExceeded`);
      }
    } else if (v2.fees.mintFeePpm !== 0) {
      issues.push(
        `v2.fees.mintFeePpm is ${v2.fees.mintFeePpm}, and v8 launches every market at 0 rent (V3-D18): the writer pays 5 % of the premium on first sale instead. Set ${ALLOW_RENT_KEY}: true in the same commit if rent is genuinely being switched back on`,
      );
    }
  } else issues.push("v2.fees must be an object");
  // INTERFACE_VERSION 8 (V8-DESIGN §6). Its own block, never a v2.contracts key: that set is closed and
  // counted, and a flywheel address there would be copied into generated code /v2/config does not expose.
  if (isObject(v2.flywheel)) {
    exactKeys(v2.flywheel, Object.keys(V2_SKELETON.flywheel), "v2.flywheel", issues);
    for (const k of ["feeSplitter", "buybackExecutor"]) {
      if (k in v2.flywheel && v2.flywheel[k] !== null && !isAddress(v2.flywheel[k])) issues.push(`v2.flywheel.${k} must be null or an address`);
    }
    if ("deployBlock" in v2.flywheel && v2.flywheel.deployBlock !== null && !isPositiveInt(v2.flywheel.deployBlock)) {
      issues.push("v2.flywheel.deployBlock must be null or a positive block number (the splitter is deployed BEFORE the core, so it is not v2.deployBlock)");
    }
    // The buyback executor is the only caller of the v4 pool; without the splitter it has nothing to
    // spend, and a splitter recorded without its deploy block leaves the indexer no start block.
    if (isAddress(v2.flywheel.buybackExecutor) && !isAddress(v2.flywheel.feeSplitter)) {
      issues.push("v2.flywheel.buybackExecutor is set while v2.flywheel.feeSplitter is null: the executor only ever spends the splitter's USDG");
    }
    if (isAddress(v2.flywheel.feeSplitter) && v2.flywheel.deployBlock === null) {
      issues.push("v2.flywheel.feeSplitter is set but v2.flywheel.deployBlock is null: the indexer has no block to start the flywheel from");
    }
  } else issues.push("v2.flywheel must be an object ({ feeSplitter, buybackExecutor, deployBlock }, null until the v8 deploy)");
  validateV2Vault(v2.vault, issues);
  intTree(v2.defaults, V2_SKELETON.defaults, "v2.defaults", issues, { exact: true });
}

/**
 * `v2.vault`: the MakerVault `Limits` tuple the deploy sets, in setLimits order (INTERFACE_VERSION 7, c21).
 * Every field is validated against the solidity width it is encoded into, because a setLimits call site that
 * drops or overflows one does not encode. maxDailyOutflow must be > 0: 0 deploys the vault frozen — the quoter
 * could cancel, close and place asks but never bid, take or replace upwards — which is a post-launch spend
 * freeze, not a deploy value.
 */
const VAULT_LIMIT_MAX = {
  maxSeriesUnits: (1n << 64n) - 1n,
  maxTotalNotional: UINT128_MAX,
  askToleranceBps: 10_000n,
  maxBidBpsOfSpot: 10_000n,
  maxOrderLifetime: (1n << 32n) - 1n,
  maxDailyOutflow: UINT128_MAX,
};
/** The two that are written as decimal strings (uint64 / uint128 base units), like takerFeeFlat and strikeTick. */
const VAULT_LIMIT_STRINGS = new Set(["maxSeriesUnits", "maxTotalNotional", "maxDailyOutflow"]);

function validateV2Vault(vault, issues) {
  if (!isObject(vault)) {
    issues.push("v2.vault must be an object (the six-field MakerVault Limits the deploy sets)");
    return;
  }
  exactKeys(vault, Object.keys(V2_SKELETON.vault), "v2.vault", issues);
  for (const [k, max] of Object.entries(VAULT_LIMIT_MAX)) {
    if (!(k in vault)) continue;
    const v = vault[k];
    if (VAULT_LIMIT_STRINGS.has(k)) {
      if (!(v === "0" || isDecimalIn(v, max))) issues.push(`v2.vault.${k} must be a decimal string in [0, ${max}]`);
    } else if (!(isUint(v) && BigInt(v) <= max)) {
      issues.push(`v2.vault.${k} must be an integer in [0, ${max}]`);
    }
  }
  if ("maxDailyOutflow" in vault && vault.maxDailyOutflow === "0") {
    issues.push("v2.vault.maxDailyOutflow must be > 0: 0 deploys the MakerVault unable to bid, take or replace upwards; a spend freeze is a setLimits call after launch, not a deploy value");
  }
}

/*//////////////////////////////////////////////////////////////
                    UNISWAP V4 POOL KEYS (v8)
//////////////////////////////////////////////////////////////*/

/**
 * `abi.encode(PoolKey)` for `PoolId.toId()`: five static 32-byte words, in PoolKey field order.
 * Returned as a 0x hex string so the caller can hash it (`cast keccak`) without a dependency.
 *
 * The pool id is what the router and the buyback executor actually pin — a v4 pool has no address —
 * so a registry that carries a `poolId` nobody recomputed is a pinned pool nobody checked. Both
 * currencies come from the registry, never from the route, which is why a route only has to spell
 * `fee` and `tickSpacing`: the pair is (asset, USDG) by definition and hooks are always zero.
 */
export function encodePoolKey({ currency0, currency1, fee, tickSpacing, hooks }) {
  const word = (v) => BigInt(v).toString(16).padStart(64, "0");
  return `0x${word(currency0)}${word(currency1)}${word(fee)}${word(tickSpacing)}${word(hooks)}`;
}

/** The two currencies of a market's route, in v4's sort order (currency0 < currency1). */
export function routeCurrencies(assetAddress, usdgAddress) {
  const [a, b] = [assetAddress.toLowerCase(), usdgAddress.toLowerCase()];
  return a < b ? { currency0: a, currency1: b } : { currency0: b, currency1: a };
}

/** keccak-256 of a hex string, via `cast` (the file's one hashing dependency, like `checksum`). */
async function keccak(hex) {
  const { stdout } = await execFileP("cast", ["keccak", hex]);
  return stdout.trim();
}

/*//////////////////////////////////////////////////////////////
                       THE `shared` BLOCK (v8)
//////////////////////////////////////////////////////////////*/

/**
 * `shared`: chain facts, the protocol's wallets, the two Safes and the token.
 *
 * INTERFACE_VERSION 8 made this block hand-maintained (SHARED_SKELETON says why), so it needs the
 * same closed-set treatment the `v2` block has had since O3-003: an unknown key here would be a
 * wallet nobody reads, and a missing one a wallet every reader resolves to `undefined`.
 */
function validateShared(registry, issues) {
  const s = registry.shared;
  if (!isObject(s)) {
    issues.push("shared is missing or not an object");
    return;
  }
  exactKeys(s, SHARED_KEYS, "shared", issues);
  if (s.chainId !== 4663) issues.push(`shared.chainId is ${JSON.stringify(s.chainId)}, not 4663`);
  for (const k of ["usdg", "clearinghouse", "seaport", "multicall3"]) {
    if (k in s && !isAddress(s[k])) issues.push(`shared.${k} must be an address (a fixed fact of chain 4663)`);
  }
  for (const k of ["admin", "guardian", "feeRecipient", "opsWallet"]) {
    if (k in s && s[k] !== null && !isAddress(s[k])) issues.push(`shared.${k} must be null or an address`);
  }
  if (isObject(s.safes)) {
    exactKeys(s.safes, SHARED_SAFE_KEYS, "shared.safes", issues);
    for (const k of SHARED_SAFE_KEYS) {
      if (k in s.safes && s.safes[k] !== null && !isAddress(s.safes[k])) issues.push(`shared.safes.${k} must be null or an address`);
    }
    // One Safe under two names is how "admin" stops meaning the Safe. `shared.admin` is the block
    // every v7-era reader already knows; `shared.safes.admin` is where a v8 reader looks for it.
    if (s.safes.admin !== s.admin) {
      issues.push(`shared.safes.admin ${JSON.stringify(s.safes.admin)} and shared.admin ${JSON.stringify(s.admin)} are the same Safe and must be written the same, null included`);
    }
    // V3-D1/D10: two Safes, same three owners, separate roles. One address for both means the
    // Treasury Safe's signatures are the Admin Safe's, and the split that holds protocol money away
    // from protocol configuration is gone.
    if (isAddress(s.safes.admin) && s.safes.admin === s.safes.treasury) {
      issues.push("shared.safes.admin and shared.safes.treasury are the same address: v8 runs two Safes so that protocol money and protocol configuration are not one signature set (V3-D1, D10)");
    }
  } else issues.push("shared.safes must be an object ({ admin, treasury }, null until the owner creates them)");
  if (isObject(s.token)) {
    exactKeys(s.token, SHARED_TOKEN_KEYS, "shared.token", issues);
    if (s.token.address !== null && !isAddress(s.token.address)) issues.push("shared.token.address must be null or an address");
    if (s.token.symbol !== null && typeof s.token.symbol !== "string") issues.push("shared.token.symbol must be null or a string");
    if (s.token.decimals !== null && !isUint(s.token.decimals)) issues.push("shared.token.decimals must be null or a non-negative integer");
    if (s.token.poolId !== null && !(typeof s.token.poolId === "string" && BYTES32.test(s.token.poolId))) {
      issues.push("shared.token.poolId must be null or a 32-byte v4 pool id");
    }
    if (isObject(s.token.poolKey)) {
      exactKeys(s.token.poolKey, POOL_KEY_KEYS, "shared.token.poolKey", issues);
      const pk = s.token.poolKey;
      for (const k of ["currency0", "currency1", "hooks"]) {
        if (k in pk && pk[k] !== null && !isAddress(pk[k])) issues.push(`shared.token.poolKey.${k} must be null or an address`);
      }
      if (pk.fee !== null && !(isUint(pk.fee) && pk.fee <= MAX_ROUTE_FEE_TIER)) issues.push(`shared.token.poolKey.fee must be null or an integer in [0, ${MAX_ROUTE_FEE_TIER}]`);
      if (pk.tickSpacing !== null && !(isPositiveInt(pk.tickSpacing) && pk.tickSpacing <= MAX_TICK_SPACING)) {
        issues.push(`shared.token.poolKey.tickSpacing must be null or an integer in [1, ${MAX_TICK_SPACING}]`);
      }
      // OWNER RULING 2026-09-21 (T-OP-012): THE BUYBACK VENUE IS PERMANENTLY THE PONS LAUNCH POOL, so
      // this key MUST name that pool's launch hook. The rule here used to be the INVERSE, and it was a
      // one-subject error rather than a design conflict: it quoted V8-DESIGN §6A, which is the PAYOUT
      // ROUTE section ("the pair is exactly (asset, USDG); hooks == address(0) only"). Routes still get
      // that rule and do not lose it -- `payoutRouteIdIssues` recomputes a route's poolId with
      // `hooks: ZERO_ADDRESS` hard-coded, so a route can never name a hooked pool.
      // The buyback key is the opposite case, and §6 says so: the executor is swappable BECAUSE the v4
      // pool and its hook are outside our control. `V4BuybackExecutor.sol:255` reverts `NoSource` when
      // `cfg.key.hooks.code.length == 0`, and `:256` requires that hook to be the PoolManager's
      // registered launch hook, off which it reads `launches(poolId).hookFeeBps` and `.creatorTaxBps`
      // for its whole fee model. A hook-fee ceiling check is meaningless on a hookless pool, which is
      // how the two sentences are known to describe two different pools.
      // POSITIVE RULE: null means "not pinned yet"; an address must be a real hook, never zero.
      if (pk.hooks !== null && pk.hooks === ZERO_ADDRESS) {
        issues.push(`shared.token.poolKey.hooks is the zero address: the buyback venue is the Pons launch pool, so this key must name that pool's launch hook -- V4BuybackExecutor reverts NoSource on a hook with no code and reads its fee model off the PoolManager's registered launch hook (V8-DESIGN §6). The zero-hooks rule is §6A's and belongs to v2.payoutRoute`);
      }
      if (isAddress(pk.currency0) && isAddress(pk.currency1) && pk.currency0.toLowerCase() >= pk.currency1.toLowerCase()) {
        issues.push("shared.token.poolKey.currency0 must sort below currency1: v4 pool keys are sorted and the id is taken over them as written");
      }
      const full = POOL_KEY_KEYS.every((k) => pk[k] !== null && pk[k] !== undefined);
      if (full !== (s.token.poolId !== null)) {
        issues.push("shared.token.poolKey and shared.token.poolId are filled in together or not at all: an id without its key cannot be rechecked, a key without its id was never computed");
      }
      if (isAddress(s.token.address) && isAddress(pk.currency0) && isAddress(pk.currency1)) {
        const pair = [pk.currency0.toLowerCase(), pk.currency1.toLowerCase()];
        if (!pair.includes(s.token.address.toLowerCase())) issues.push(`shared.token.poolKey does not hold shared.token.address ${s.token.address}`);
      }
    } else issues.push("shared.token.poolKey must be an object (the pinned hookless v4 PoolKey the buyback swaps on)");
  } else issues.push("shared.token must be an object ({ address, symbol, decimals, poolKey, poolId })");
}

/**
 * `markets[].v2.payoutRoute` (INTERFACE_VERSION 8, V8-DESIGN §6A): where the Clearinghouse's payout
 * adapter and the FeeSplitter sell this market's Stock Tokens for USDG. `null` means no route, which
 * is not a failure — the Clearinghouse pays a winning call in kind when no route clears its floor.
 *
 * This is NOT `univ3Pool`. That key is the settlement TWAP source and stays v3-only, because v4 has
 * no observation array to walk (06-QUIRKS §H). Sharing one key would have re-pointed settlement at a
 * v4 pool the moment a route was added, which is the whole reason the route gets its own.
 *
 * Offline rules here; `payoutRouteIdIssues` recomputes a v4 `poolId` from the key with `cast`.
 */
export function validatePayoutRoute(m, registry, recon, issues) {
  const t = m.ticker;
  const r = m.v2?.payoutRoute;
  if (r === null || r === undefined) {
    if (r === undefined) issues.push(`${t}: v2.payoutRoute is missing (null for no route: winning calls are then paid in Stock Tokens)`);
    return;
  }
  if (!isObject(r)) {
    issues.push(`${t}: v2.payoutRoute must be null or an object ({ venue: "v3", fee } or { venue: "v4", fee, tickSpacing, poolId })`);
    return;
  }
  const keys = PAYOUT_ROUTE_KEYS[r.venue];
  if (!keys) {
    issues.push(`${t}: v2.payoutRoute.venue ${JSON.stringify(r.venue)} is not ${Object.keys(PAYOUT_ROUTE_KEYS).join(" | ")}`);
    return;
  }
  exactKeys(r, keys, `${t}.v2.payoutRoute`, issues);
  // V2Constants.MAX_ROUTE_FEE_TIER: PayoutRouter.setRoute refuses a higher tier on either venue.
  // INTC's 1 % pool sits exactly on it. 0 is refused too: no venue has a zero static fee tier, so a 0
  // is a field somebody left empty, and on v4 it would silently mean the dynamic-fee flag's neighbour.
  if (!(isPositiveInt(r.fee) && r.fee <= MAX_ROUTE_FEE_TIER)) {
    issues.push(`${t}: v2.payoutRoute.fee ${JSON.stringify(r.fee)} must be an integer in [1, ${MAX_ROUTE_FEE_TIER}] (V2Constants.MAX_ROUTE_FEE_TIER)`);
  }
  if (r.venue === "v4") {
    if (!(isPositiveInt(r.tickSpacing) && r.tickSpacing <= MAX_TICK_SPACING)) {
      issues.push(`${t}: v2.payoutRoute.tickSpacing ${JSON.stringify(r.tickSpacing)} must be an integer in [1, ${MAX_TICK_SPACING}]`);
    }
    if (!(typeof r.poolId === "string" && BYTES32.test(r.poolId))) {
      issues.push(`${t}: v2.payoutRoute.poolId must be a 32-byte v4 pool id (a v4 pool has no address; the id IS the pin)`);
    }
  }
  // A v3 route names a fee tier, and the pool is whatever the canonical factory returns for
  // (asset, USDG, fee). If the F2-02 recon never saw a pool at that tier, the route resolves to
  // address(0) on chain and every payout falls back to in-kind without anything failing.
  if (r.venue === "v3" && isPositiveInt(r.fee)) {
    const seen = recon?.markets?.find((x) => x.ticker === t)?.pools ?? null;
    if (seen && !seen.some((p) => Number(p.fee) === r.fee)) {
      issues.push(
        `${t}: v2.payoutRoute is the v3 ${r.fee} tier, which the F2-02 recon found no pool for (${seen.map((p) => p.fee).join(", ") || "no pools at all"}); the factory would return address(0) and every payout would fall back to in kind`,
      );
    }
  }
}

/** One market row: the v1 lifecycle fields and its `v2` block. Offline. */
function validateMarket(m, registry, recon, issues) {
  const t = m.ticker;
  if (!V1_STATUSES.includes(m.status)) issues.push(`${t}: status ${JSON.stringify(m.status)} is not ${V1_STATUSES.join(" | ")}`);
  if (!V1_WAVES.includes(m.wave)) issues.push(`${t}: wave ${JSON.stringify(m.wave)} is not ${V1_WAVES.join(" | ")}`);
  if (m.status === "live" && !m.deployment?.factory) issues.push(`${t}: status live but deployment.factory is null`);
  // Superseded means the factory was never built. A deployed factory is run off (v1RunOff), never superseded.
  if (m.status === "superseded-by-v2" && m.deployment?.factory) issues.push(`${t}: status superseded-by-v2 but a factory exists; a deployed v1 market is run off (v1RunOff), not superseded`);
  // When the owner froze this v1 factory (writesHalted + depositCap 0), in unix seconds. The freeze
  // runbook writes it together with v1RunOff: true, so a date without the run-off flag, or on a row
  // with no factory, is a half-done or misplaced edit.
  if (m.v1FrozenAt !== undefined && m.v1FrozenAt !== null) {
    if (!isPositiveInt(m.v1FrozenAt)) issues.push(`${t}: v1FrozenAt must be null or unix seconds (a positive integer), not ${JSON.stringify(m.v1FrozenAt)}`);
    if (!m.deployment?.factory) issues.push(`${t}: v1FrozenAt is set but deployment.factory is null: there is no v1 factory to have frozen`);
    if (m.v1RunOff !== true) issues.push(`${t}: v1FrozenAt is set but v1RunOff is not true: a frozen factory is run off, set both together`);
  }

  const v = m.v2;
  if (!isObject(v)) {
    issues.push(`${t}: v2 block is missing or not an object`);
    return;
  }
  exactKeys(v, V2_MARKET_KEYS, `${t}.v2`, issues);
  if (!V2_STATUSES.includes(v.status)) issues.push(`${t}: v2.status ${JSON.stringify(v.status)} is not ${V2_STATUSES.join(" | ")}`);
  if (!V2_WAVES.includes(v.wave)) issues.push(`${t}: v2.wave ${JSON.stringify(v.wave)} is not ${V2_WAVES.join(" | ")}`);
  if (!isDecimalIn(v.strikeTick, (1n << 64n) - 1n) || BigInt(v.strikeTick) % PRICE_TICK !== 0n) {
    issues.push(`${t}: v2.strikeTick ${JSON.stringify(v.strikeTick)} must be a decimal string of USDG base units, > 0 and a multiple of ${PRICE_TICK}`);
  }
  if (typeof v.puts !== "boolean") issues.push(`${t}: v2.puts must be true or false`);
  // INTERFACE_VERSION 8 (V3-D18): the rent dial this market is registered with, launched at 0. v7
  // refused 0 here; v8 refuses anything else unless the registry carries the explicit opt-in. Per
  // market as well as shared, because the per-market value is what is pinned into every series and a
  // registry-wide flag with one stray market at 1500 ppm still charges that market's writers rent.
  if (!isUint(v.mintFeePpm)) {
    issues.push(`${t}: v2.mintFeePpm ${JSON.stringify(v.mintFeePpm)} must be a non-negative integer (the rent dial; 0 in v8)`);
  } else if (registry.v2?.fees?.allowRent === true) {
    if (v.mintFeePpm > MINT_FEE_CEIL_PPM) {
      issues.push(`${t}: v2.mintFeePpm ${v.mintFeePpm} is above MINT_FEE_CEIL_PPM (${MINT_FEE_CEIL_PPM}); Clearinghouse._checkConfig reverts CeilingExceeded above it`);
    }
  } else if (v.mintFeePpm !== 0) {
    issues.push(
      `${t}: v2.mintFeePpm is ${v.mintFeePpm} and v8 registers every market at 0 rent (V3-D18): the writer pays v2.fees.premiumFeeBps of the premium on first sale instead. Set ${ALLOW_RENT_KEY}: true in the same commit if rent is genuinely being switched back on`,
    );
  }
  if (v.univ3Pool !== null && !isAddress(v.univ3Pool)) issues.push(`${t}: v2.univ3Pool must be null or an address`);
  // T-599: THE SINGLE-SOURCE SET IS PINNED IN THE BUILD, not only in the suite. `node --test` already
  // froze it; `--check` did not, so a market could gain or lose its pool and the BUILD stayed green.
  // Both directions are checked, because only the pair is a guard: the first alone lets the set rot as
  // markets are wired up, the second alone lets a 34th single-source market slip in.
  if (v.univ3Pool === null && !SINGLE_SOURCE_AT_2026_09_21.has(m.ticker)) {
    issues.push(
      `${t}: a NEW single-source market. RegisterMarkets.s.sol:919-921 gives a market with no v2.univ3Pool a one-element oracle source list, so a window where the Chainlink feed is not ok leaves okCount 0 and SettlementOracle.adminResolve unbounded. Give it a univ3Pool, or add it to SINGLE_SOURCE_AT_2026_09_21 as a deliberate decision`,
    );
  }
  if (isAddress(v.univ3Pool) && SINGLE_SOURCE_AT_2026_09_21.has(m.ticker)) {
    issues.push(
      `${t}: now has a v2.univ3Pool but is still listed in SINGLE_SOURCE_AT_2026_09_21; remove it from the set so the set keeps meaning what it says`,
    );
  }
  if (v.univ3MinLiquidity !== null && !isDecimalIn(v.univ3MinLiquidity, UINT128_MAX)) {
    issues.push(`${t}: v2.univ3MinLiquidity must be null or a positive decimal string (uint128 pool liquidity)`);
  }
  // A pool without a floor would let the source trust a pool that has been drained; a floor without
  // a pool is a leftover.
  if ((v.univ3Pool === null) !== (v.univ3MinLiquidity === null)) issues.push(`${t}: v2.univ3Pool and v2.univ3MinLiquidity are set together or not at all`);
  if (v.dataStreamsFeedId !== null && !(typeof v.dataStreamsFeedId === "string" && BYTES32.test(v.dataStreamsFeedId))) {
    issues.push(`${t}: v2.dataStreamsFeedId must be null or a 32-byte hex id`);
  }
  validatePayoutRoute(m, registry, recon, issues);
  if (isObject(v.overrides)) intTree(v.overrides, registry.v2?.defaults ?? V2_SKELETON.defaults, `${t}.v2.overrides`, issues, { exact: false });
  else issues.push(`${t}: v2.overrides must be an object ({} for none)`);
  // The delay a market with one ok source waits before it finalizes on an uncorroborated candidate.
  // The 19 Chainlink-only launch markets take 3600 here (owner, 2026-09-19); those rows land in O8-10.
  // What lands now is the mechanism: the override exists, it is bounded, and a market that still has a
  // corroborating Uniswap v3 source may not carry one, because on such a market the shortened delay
  // only ever applies on the day the pool is NOT ok — which is exactly when the delay is what protects
  // settlement, and a row that lowered it there would have lowered it for the wrong reason.
  const uncorroboratedDelayS = isObject(v.overrides) && "uncorroboratedDelayS" in v.overrides
    ? v.overrides.uncorroboratedDelayS
    : registry.v2?.defaults?.uncorroboratedDelayS;
  if (isUint(uncorroboratedDelayS) && (uncorroboratedDelayS < MIN_UNCORROBORATED_DELAY_S || uncorroboratedDelayS > MAX_UNCORROBORATED_DELAY_S)) {
    issues.push(
      `${t}: uncorroboratedDelayS ${uncorroboratedDelayS} must be in [${MIN_UNCORROBORATED_DELAY_S}, ${MAX_UNCORROBORATED_DELAY_S}]: below one guardian veto window a single uncorroborated source finalizes before anyone can veto it`,
    );
  }
  if (isObject(v.overrides) && "uncorroboratedDelayS" in v.overrides && isAddress(v.univ3Pool)) {
    issues.push(
      `${t}: v2.overrides.uncorroboratedDelayS is set on a market that still has a v2.univ3Pool: the delay only ever applies when that source is not ok, so shortening it here shortens it exactly when it is doing its job. Drop the pool or drop the override`,
    );
  }
  // The spot age the oracle is registered with (RegisterMarkets passes it; 0 would mean the contract's 1 h default).
  const spotMaxAgeS = isObject(v.overrides) && "spotMaxAgeS" in v.overrides ? v.overrides.spotMaxAgeS : registry.v2?.defaults?.spotMaxAgeS;
  if (isUint(spotMaxAgeS)) {
    if (spotMaxAgeS === 0 || spotMaxAgeS > MAX_SPOT_MAX_AGE_S) issues.push(`${t}: spotMaxAgeS ${spotMaxAgeS} must be in [1, ${MAX_SPOT_MAX_AGE_S}] (SettlementOracle.MAX_SPOT_MAX_AGE; 0 is the contract's 1 h default)`);
    else if (isPositiveInt(m.feedHeartbeatS) && spotMaxAgeS < m.feedHeartbeatS + SPOT_AGE_OVER_HEARTBEAT_S) {
      issues.push(`${t}: spotMaxAgeS ${spotMaxAgeS} is under the feed heartbeat ${m.feedHeartbeatS} + ${SPOT_AGE_OVER_HEARTBEAT_S} s: spot() would revert StaleSpot whenever the feed is quiet (ops/deploy.md §15.13)`);
    }
  }
  // T-OP-156. The per-market HouseVault: null, or an address (its EIP-55 case is judged by {checksumMarketHouseVaults},
  // the same cast rule every other address in this file answers to). A vault on a market the owner did not launch
  // is refused BY NAME: `launchSet.markets` is the authoritative list (T-OP-003), and a written-back vault on any
  // other row means the externals stage deployed for the wrong market or wrote to the wrong row -- either way not
  // a registry to ship. Without a launchSet (a dev registry) any market may carry one.
  if (v.houseVault !== null && !isAddress(v.houseVault)) issues.push(`${t}: v2.houseVault must be null or an address`);
  // The zero address is what DeployHouseVault.s.sol (callhouse-contracts, T-OP-141) writes into its JSON out for a
  // vault whose createVault call was PRINTED for the Safe rather than sent (`built.vaults[i]`: "zero when the vault
  // call was printed rather than sent"; `houseVault` likewise "zero until it exists"). Copied into the registry
  // verbatim it would read as a vault that exists at 0x0 -- and pass the shape rule and the cast rule, since the
  // zero address is its own checksum. "Not yet" is spelled null here; the writer must translate, and this refusal
  // is what tells it so by name instead of letting the value through.
  if (v.houseVault === ZERO_ADDRESS) {
    issues.push(`${t}: v2.houseVault is the zero address: DeployHouseVault writes zero for a vault that is not created yet (createVault printed for the Safe); a registry spells "not yet" as null, never as 0x0`);
  }
  const launched = Array.isArray(registry?.launchSet?.markets) ? registry.launchSet.markets : null;
  if (isAddress(v.houseVault) && launched !== null && !launched.includes(t)) {
    issues.push(`${t}: v2.houseVault ${v.houseVault} is set on a market that is not in launchSet.markets (${launched.join(", ")}): only a launched market gets a HouseVault; a vault here means the externals stage wrote the wrong row`);
  }
  // The single address VerifyV8 walks (v2.contracts.houseVault, T-OP-114) is the FIRST launch ticker's vault (owner
  // ruling, option A). Both set and different is a registry that names two vaults for one market: refused by name.
  const first = launched?.[0];
  const walked = registry?.v2?.contracts?.houseVault;
  if (first === t && isAddress(v.houseVault) && isAddress(walked) && walked.toLowerCase() !== v.houseVault.toLowerCase()) {
    issues.push(`${t}: v2.houseVault ${v.houseVault} is not v2.contracts.houseVault ${walked}: the first launch ticker's vault IS the one VerifyV8 walks (owner ruling 2026-09-22, option A); write the same address in both or fix the write-back`);
  }
  if (v.registeredAt !== null && !isPositiveInt(v.registeredAt)) issues.push(`${t}: v2.registeredAt must be null or unix seconds`);
  if (v.registerTx !== null && !(typeof v.registerTx === "string" && BYTES32.test(v.registerTx))) issues.push(`${t}: v2.registerTx must be null or a transaction hash`);
  if (v.status !== "planned" && (v.registeredAt === null || v.registerTx === null)) {
    issues.push(`${t}: v2.status ${v.status} needs registeredAt and registerTx (the registration it went ${v.status} with)`);
  }
  if (v.status === "live") {
    for (const k of ["clearinghouse", "orderBook", "settlementOracle", "expiryCalendar"]) {
      if (!registry.v2?.contracts?.[k]) issues.push(`${t}: v2.status live but v2.contracts.${k} is null`);
    }
  }

  // The pool, offline, against the recon that selected it.
  if (isAddress(v.univ3Pool)) {
    const r = recon?.markets?.find((x) => x.ticker === t);
    const p = r?.pools?.find((x) => x.address.toLowerCase() === v.univ3Pool.toLowerCase());
    const want = [m.asset.toLowerCase(), registry.shared.usdg.toLowerCase()].sort().join("/");
    if (!recon) issues.push(`${t}: v2.univ3Pool is set but ops/markets/v2-sources.json is missing`);
    else if (!p) issues.push(`${t}: v2.univ3Pool ${v.univ3Pool} is not a pool the F2-02 recon found for ${t} (re-run ops/recon/r13-probe.mjs)`);
    else {
      const got = [p.token0.toLowerCase(), p.token1.toLowerCase()].sort().join("/");
      if (got !== want) issues.push(`${t}: v2.univ3Pool pair ${got} is not {asset, USDG} ${want}`);
      if (p.twap !== "usable") issues.push(`${t}: v2.univ3Pool is "${p.twap}" in the F2-02 recon; only a usable pool may be a settlement source`);
      // INTERFACE_VERSION 7, owner sign-off c10 (DECISIONS-2026-09-17 §7): the ring has to hold the whole
      // settlement window plus the snapshot grace, or one dust mint or burn per second overwrites the expiry's
      // observations before the snapshot is taken. UniV3TwapSource.setPool refuses a shallower pool
      // (UnsupportedAsset) and DeployV2Batch.sh refuses the registry row before anything is broadcast.
      if (!(isUint(p.cardinality) && p.cardinality >= MIN_POOL_OBSERVATION_CARDINALITY)) {
        issues.push(
          `${t}: v2.univ3Pool ${v.univ3Pool} has observation cardinality ${JSON.stringify(p.cardinality)} in the F2-02 recon, below MIN_POOL_OBSERVATION_CARDINALITY (${MIN_POOL_OBSERVATION_CARDINALITY}); register ${t} Chainlink-only (drop v2.univ3Pool and v2.univ3MinLiquidity, which also drops its payout route), or raise the ring with increaseObservationCardinalityNext(${MIN_POOL_OBSERVATION_CARDINALITY}) and re-run ops/recon/r13-probe.mjs`,
        );
      }
    }
  }
}

/** `registry.v2.contracts.makerVault` and the like; undefined when any step is not an object. */
function at(registry, dotted) {
  let node = registry;
  for (const key of dotted.split(".")) {
    if (!isObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

/**
 * `v2.protocolAddresses` (02-interfaces.md §3.3, O3-204). Four refusals, and a check `--check` runs
 * before any deploy reads the block:
 *
 *   MISSING    the block, a key, or — once `v2.deployBlock` says a deployment exists — the manager,
 *              the admin Safe, the guardian or the fee recipient.
 *   MALFORMED  anything that is not an address and not `null` where `null` is typed.
 *   DRIFTED    a key that has a twin and does not equal it, `null` included. This is what keeps the
 *              list honest: a contract deployed, a bot derived or the admin moved without this block
 *              following is exactly how an exclusion list comes to exclude the wrong thing.
 *   DUPLICATED one address under two keys. In v8 there is exactly one pair that may repeat
 *              (`feeRecipient` is `feeSplitter`); everything else repeating is a mistake.
 *
 * INTERFACE_VERSION 8: `distributors.user` is the only key left without a twin (it waits for F5).
 * Every other key now mirrors a block that exists, which is what O3-204 could not do yet.
 */
/**
 * Every required-when-deployed slot that is still null (O8-08A). Same switch as the mirror rule:
 * `v2.deployBlock` is the registry's own statement that a deployment exists. Before it is set every
 * one of these is legitimately null and this returns nothing — that pre-deploy state is pinned by a
 * test and must stay green.
 */
/**
 * O8-03's payout-route decision, as data rather than as prose (T-147, ops/markets/PAYOUT-ROUTES-V8.md).
 *
 * Before O8-03 every `payoutRoute` was null and "null" meant "not written yet". Now fourteen launch
 * markets carry a route and six are null ON PURPOSE — no eligible v4 pool cleared the depth, activity
 * and deviation gates — and to a completeness check those six are indistinguishable from a row somebody
 * forgot. This list is what tells them apart: post-broadcast, a launch market that is null and NOT named
 * here has been forgotten, and a market named here that suddenly HAS a route means the decision changed
 * without the document changing with it.
 *
 * These six are re-measured immediately before OWN8-06. When a re-measurement pins one of them, it moves
 * out of this list in the same commit that writes its route.
 */
export const V2_PAYOUT_ROUTE_DELIBERATELY_NULL = ["AMD", "AMZN", "CRWV", "MU", "ORCL", "SNDK"];

/** The launch set: the wave a market is in is the registry's own statement of whether it launches. */
const isLaunchMarket = (m) => m?.v2?.wave === "wave1" || m?.v2?.wave === "canary";

export function validateDeployedCompleteness(registry, issues) {
  const block = at(registry, "v2.deployBlock");
  if (block === null || block === undefined) return;
  for (const path of V2_DEPLOYED_REQUIRED_PATHS) {
    const value = at(registry, path);
    if (value === undefined) continue; // the block itself is missing; its own validator says so
    if (value === null) {
      issues.push(
        `${path} is null but v2.deployBlock is ${JSON.stringify(block)}: a registry that says a deployment exists must name every address that deployment produced`,
      );
    }
  }
  // Deliberately null is not the same as not yet written, and only this list knows the difference.
  for (const m of registry.markets ?? []) {
    if (!isLaunchMarket(m)) continue;
    const route = m.v2?.payoutRoute;
    const deliberate = V2_PAYOUT_ROUTE_DELIBERATELY_NULL.includes(m.ticker);
    if (route === null && !deliberate) {
      issues.push(
        `${m.ticker}: v2.payoutRoute is null but v2.deployBlock is ${JSON.stringify(block)} and ${m.ticker} launches: either pin a route or record it in V2_PAYOUT_ROUTE_DELIBERATELY_NULL with its reason in ops/markets/PAYOUT-ROUTES-V8.md`,
      );
    }
    if (route !== null && route !== undefined && deliberate) {
      issues.push(
        `${m.ticker}: v2.payoutRoute is set but ${m.ticker} is listed as deliberately routeless: the decision changed and ops/markets/PAYOUT-ROUTES-V8.md did not`,
      );
    }
  }
}

export function validateV2Protocol(registry, issues) {
  const block = at(registry, "v2.protocolAddresses");
  if (!isObject(block)) {
    issues.push("v2.protocolAddresses is missing or not an object (02-interfaces.md §3.3)");
    return;
  }
  exactKeys(block, V2_PROTOCOL_KEYS, "v2.protocolAddresses", issues);
  const distributors = block.distributors;
  if (isObject(distributors)) {
    exactKeys(distributors, V2_PROTOCOL_DISTRIBUTOR_KEYS, "v2.protocolAddresses.distributors", issues);
  } else {
    // Spelled from the constant rather than typed out, so widening the constant cannot leave a stale sentence.
    issues.push(`v2.protocolAddresses.distributors must be an object of { ${V2_PROTOCOL_DISTRIBUTOR_KEYS.join(", ")} }`);
  }

  /** Every leaf of the block that is present, as [key, value] with `distributors.` spelled out. */
  const entries = [];
  for (const k of V2_PROTOCOL_KEYS) {
    if (k === "distributors" || !(k in block)) continue;
    entries.push([k, block[k]]);
  }
  if (isObject(distributors)) {
    for (const k of V2_PROTOCOL_DISTRIBUTOR_KEYS) if (k in distributors) entries.push([`distributors.${k}`, distributors[k]]);
  }

  // A registry with a deploy block is a registry describing something that exists on chain. Before
  // that, every one of these is legitimately null: the Safes are created by the owner, the splitter by
  // the deploy, the guardian key by ops/v2/derive-bot-keys.sh.
  const deployed = at(registry, "v2.deployBlock") !== null && at(registry, "v2.deployBlock") !== undefined;
  for (const [key, value] of entries) {
    if (value === null) {
      if (V2_PROTOCOL_NEVER_NULL.includes(key) || (deployed && V2_PROTOCOL_DEPLOYED_NEVER_NULL.includes(key))) {
        issues.push(
          `v2.protocolAddresses.${key} is null; it mirrors ${V2_PROTOCOL_TWINS[key]}, and v2.deployBlock says this registry describes a deployment — there is no v8 deployment without it`,
        );
      }
      continue;
    }
    if (!isAddress(value)) {
      issues.push(`v2.protocolAddresses.${key} must be an address or null, not ${JSON.stringify(value)}`);
    }
  }

  for (const [key, twin] of Object.entries(V2_PROTOCOL_TWINS)) {
    const value = key.includes(".") ? (isObject(distributors) ? distributors[key.split(".")[1]] : undefined) : block[key];
    if (value === undefined) continue; // exactKeys already reported the missing key
    const want = at(registry, twin);
    if (want === undefined) continue; // the twin's own block is broken and has its own issue
    if (value !== want) {
      issues.push(
        `v2.protocolAddresses.${key} is ${JSON.stringify(value)} but ${twin} is ${JSON.stringify(want)}: the protocol set mirrors the registry exactly, null included, so that nothing deployed can be missing from it`,
      );
    }
  }

  const aliased = (a, b) => V2_PROTOCOL_ALIASES.some((pair) => pair.includes(a) && pair.includes(b));
  const seen = new Map();
  for (const [key, value] of entries) {
    if (!isAddress(value)) continue;
    const lower = value.toLowerCase();
    const first = seen.get(lower);
    if (first === undefined) {
      seen.set(lower, key);
      continue;
    }
    if (aliased(key, first)) continue;
    issues.push(
      `v2.protocolAddresses.${key} is the same address as v2.protocolAddresses.${first} (${value}); in v8 the only pair that may name one address is ${V2_PROTOCOL_ALIASES.map((p) => p.join(" = ")).join(", ")} — the two Safes, the guardian hot key, the ops wallet and every contract slot are separate on purpose`,
    );
  }
}

/**
 * `dev.json` must not be able to name a production wallet (INTERFACE_VERSION 8).
 *
 * Until v8 `ops/markets/dev.json` was a byte copy of `tier1.json` with `v2.bots` filled in, and the
 * builder rewrote its `shared` block from a constant on every rebuild — so a dev stack pointed at it
 * ran against production's admin, guardian and fee wallets, and no check said so. v8 makes `shared`
 * hand-maintained (SHARED_SKELETON) and adds this: in a registry that declares itself `_dev`, no
 * address may be one the PRODUCTION registry names as its own.
 *
 * Only the protocol's own addresses are forbidden. The chain's are not: USDG, Seaport, Multicall3,
 * the Stock Tokens, the feeds, the Uniswap deployment AND THE STONKHOUSE TOKEN are the same contracts
 * on a fork of 4663, and a devnet that refused them would be a devnet of a different chain.
 */
export function validateDevIsolation(registry, production, issues) {
  if (!isObject(registry) || !("_dev" in registry) || !isObject(production)) return;
  /** Every address the production registry calls its own, and what calls it that. */
  const owned = new Map();
  const claim = (value, label) => {
    if (isAddress(value) && !owned.has(value.toLowerCase())) owned.set(value.toLowerCase(), label);
  };
  for (const k of ["admin", "guardian", "feeRecipient", "opsWallet"]) claim(at(production, `shared.${k}`), `shared.${k}`);
  for (const k of SHARED_SAFE_KEYS) claim(at(production, `shared.safes.${k}`), `shared.safes.${k}`);
  // `shared.token.address` is deliberately NOT claimed (T-OP-108). Until v8 it was, and the rule was
  // wrong by its own doc comment: STONKHOUSE is a fixed fact of chain 4663 like `shared.usdg` -- the
  // Pons launch already minted it, the devnet is a fork of 4663 and the dev deploy path reads the
  // same token and launch pool from dev.json (`DeployV2Batch.sh:354-358`). Claiming it meant the
  // moment production pinned the real token (this row), a dev registry naming the SAME token was
  // refused, and the only way to pass --check was to point the devnet at a token that does not
  // exist. Wallets, keys and deployed protocol contracts stay claimed below: those ARE ours.
  for (const k of V2_CONTRACT_NAMES) claim(at(production, `v2.contracts.${k}`), `v2.contracts.${k}`);
  // T-OP-114: a written-back external (EarnVault, the House factory, ...) is a deployed protocol contract like
  // any other, so production claims it too. `at` answers undefined for a key the registry does not carry yet,
  // and `claim` ignores a non-address, so this is a no-op until the externals step writes one.
  for (const k of V2_EXTERNAL_CONTRACT_NAMES) claim(at(production, `v2.contracts.${k}`), `v2.contracts.${k}`);
  for (const k of V2_SOURCE_NAMES) claim(at(production, `v2.contracts.sources.${k}`), `v2.contracts.sources.${k}`);
  for (const k of V2_BOT_NAMES) claim(at(production, `v2.bots.${k}`), `v2.bots.${k}`);
  for (const k of ["feeSplitter", "buybackExecutor"]) claim(at(production, `v2.flywheel.${k}`), `v2.flywheel.${k}`);
  /**
   * PRODUCTION'S OWN PROTOCOL BLOCK (T-249). Every claim above walks a block the dev side also walks -
   * except this one, which was missing entirely, so a production address living in
   * `v2.protocolAddresses` was only ever caught THROUGH ITS TWIN somewhere else. Most keys have a twin
   * (`accessManager` mirrors `v2.contracts.accessManager`, `treasury` mirrors `shared.safes.treasury`),
   * which is why the gap was invisible: the common cases were covered by accident rather than by rule.
   *
   * The exposure is exactly the slots with NO twin - `distributors.user` and `distributors.lender`,
   * twin-less BY DESIGN because a second deployment of RewardsDistributor cannot be mirrored into a
   * closed, counted `v2.contracts` block (T-221). Measured before this change: production's
   * `distributors.lender` and `distributors.user` copied into a `_dev` registry were ACCEPTED, while
   * `distributors.maker` was REFUSED via its twin. Walking the block by its own entries, the way the
   * dev side already does, removes the dependence on twins altogether.
   */
  const productionBlock = at(production, "v2.protocolAddresses");
  if (isObject(productionBlock)) {
    for (const [k, v] of Object.entries(productionBlock)) {
      if (k === "distributors") {
        if (isObject(v)) {
          for (const [d, a] of Object.entries(v)) claim(a, `v2.protocolAddresses.distributors.${d}`);
        }
      } else claim(v, `v2.protocolAddresses.${k}`);
    }
  }
  // The v1 factories and their keeper, admin, guardian and fee wallets are production's too. A local
  // devnet deploys no v1 factory, so a dev row carrying one is a copied row, not a described one.
  for (const m of production.markets ?? []) {
    for (const k of ["factory", "implementation", "keeper", "guardian", "admin", "feeRecipient"]) {
      claim(m.deployment?.[k], `${m.ticker} deployment.${k}`);
    }
  }

  /** Every address the dev registry calls its own, under the same names. */
  const mine = [];
  const name = (value, label) => {
    if (isAddress(value)) mine.push([label, value]);
  };
  for (const k of ["admin", "guardian", "feeRecipient", "opsWallet"]) name(at(registry, `shared.${k}`), `shared.${k}`);
  for (const k of SHARED_SAFE_KEYS) name(at(registry, `shared.safes.${k}`), `shared.safes.${k}`);
  // `shared.token.address` is not named either: it is not claimed above, so naming it could only ever
  // match a production WALLET, and a token address that equals a wallet is not an isolation defect.
  for (const k of V2_CONTRACT_NAMES) name(at(registry, `v2.contracts.${k}`), `v2.contracts.${k}`);
  for (const k of V2_EXTERNAL_CONTRACT_NAMES) name(at(registry, `v2.contracts.${k}`), `v2.contracts.${k}`);
  for (const k of V2_BOT_NAMES) name(at(registry, `v2.bots.${k}`), `v2.bots.${k}`);
  for (const k of ["feeSplitter", "buybackExecutor"]) name(at(registry, `v2.flywheel.${k}`), `v2.flywheel.${k}`);
  const block = at(registry, "v2.protocolAddresses");
  if (isObject(block)) {
    for (const [k, v] of Object.entries(block)) {
      if (k === "distributors") {
        if (isObject(v)) for (const [d, a] of Object.entries(v)) name(a, `v2.protocolAddresses.distributors.${d}`);
      } else name(v, `v2.protocolAddresses.${k}`);
    }
  }
  for (const m of registry.markets ?? []) {
    for (const k of ["factory", "implementation", "keeper", "guardian", "admin", "feeRecipient"]) {
      name(m.deployment?.[k], `${m.ticker} deployment.${k}`);
    }
  }

  for (const [label, value] of mine) {
    const where = owned.get(value.toLowerCase());
    if (where === undefined) continue;
    issues.push(
      `${label} ${value} is the production registry's ${where}: a _dev registry may not name a production wallet, key or contract (ops/markets/tier1.json is production; this file describes the local devnet)`,
    );
  }
}

/** Every non-null protocol address must be written in its EIP-55 checksum form (via `cast`). */
async function checksumV2Protocol(registry) {
  const issues = [];
  const block = at(registry, "v2.protocolAddresses");
  if (!isObject(block)) return issues;
  const entries = Object.entries(block).flatMap(([k, v]) =>
    k === "distributors" ? Object.entries(isObject(v) ? v : {}).map(([d, a]) => [`distributors.${d}`, a]) : [[k, v]],
  );
  for (const [key, value] of entries) {
    if (!isAddress(value)) continue;
    const want = await checksum(value);
    if (want !== value) issues.push(`v2.protocolAddresses.${key} ${value} is not checksummed (${want})`);
  }
  return issues;
}

/**
 * One key per process (two bots on one key collide on nonces, ops/deploy.md §10): the bot addresses
 * differ from each other and from every other key the registry names.
 *
 * INTERFACE_VERSION 8: `v2.bots.guardian` and `shared.guardian` are the SAME key and must be written
 * the same. The guardian is a hot key the protocol runs (it pauses, vetoes and cancels with no delay),
 * so it belongs in `v2.bots` beside the other signers; `shared.guardian` is where every v7-era reader
 * already looks for it. Two addresses there would mean the monitor watched one guardian and the
 * runbooks rotated another.
 */
function validateV2Bots(registry, issues) {
  const bots = registry.v2?.bots;
  if (!isObject(bots)) return;
  if (bots.guardian !== registry.shared?.guardian) {
    issues.push(
      `v2.bots.guardian ${JSON.stringify(bots.guardian)} and shared.guardian ${JSON.stringify(registry.shared?.guardian)} are one hot key and must be written the same, null included`,
    );
  }
  const others = new Map();
  const name = (a, label) => { if (isAddress(a) && !others.has(a.toLowerCase())) others.set(a.toLowerCase(), label); };
  for (const k of ["admin", "feeRecipient", "opsWallet"]) name(registry.shared?.[k], `shared.${k}`);
  for (const k of SHARED_SAFE_KEYS) name(registry.shared?.safes?.[k], `shared.safes.${k}`);
  for (const m of registry.markets ?? []) name(m.deployment?.keeper, `${m.ticker} deployment.keeper`);
  const seen = new Map();
  for (const k of V2_BOT_NAMES) {
    const a = bots[k];
    if (!isAddress(a)) continue;
    const lower = a.toLowerCase();
    if (seen.has(lower)) issues.push(`v2.bots.${k} (${V2_BOT_ROLES[k]}) is the same address as v2.bots.${seen.get(lower)} (${V2_BOT_ROLES[seen.get(lower)]}): one key per process, and one key per role lane`);
    if (others.has(lower)) issues.push(`v2.bots.${k} is the same address as ${others.get(lower)}`);
    seen.set(lower, k);
  }
}

/** Every non-null bot address must be written in its EIP-55 checksum form (via `cast`). */
async function checksumV2Bots(registry) {
  const issues = [];
  const bots = registry.v2?.bots;
  if (!isObject(bots)) return issues;
  for (const k of V2_BOT_NAMES) {
    if (!isAddress(bots[k])) continue;
    const want = await checksum(bots[k]);
    if (want !== bots[k]) issues.push(`v2.bots.${k} ${bots[k]} is not checksummed (${want})`);
  }
  return issues;
}

/** The `shared` wallets and the token address, in EIP-55 form too (via `cast`). */
async function checksumShared(registry) {
  const issues = [];
  const s = registry.shared;
  if (!isObject(s)) return issues;
  const entries = [
    ...["admin", "guardian", "feeRecipient", "opsWallet"].map((k) => [`shared.${k}`, s[k]]),
    ...SHARED_SAFE_KEYS.map((k) => [`shared.safes.${k}`, isObject(s.safes) ? s.safes[k] : undefined]),
    ["shared.token.address", isObject(s.token) ? s.token.address : undefined],
  ];
  for (const [key, value] of entries) {
    if (!isAddress(value)) continue;
    const want = await checksum(value);
    if (want !== value) issues.push(`${key} ${value} is not checksummed (${want})`);
  }
  return issues;
}

/**
 * T-OP-156: every per-market HouseVault address in EIP-55 form, the same `cast` rule as {checksumShared} and
 * {checksumV2Protocol} -- one rule for every address this file judges, not a second one for this key. Exported
 * so the registry test can hand it a lowercase copy and watch it refuse (the offline validator only checks the
 * shape; `--check` is where the case is judged). Null is skipped: it is the value for every market until the
 * externals stage writes a vault back, and for ever on a market outside the launch set.
 */
export async function checksumMarketHouseVaults(registry) {
  const issues = [];
  for (const m of registry?.markets ?? []) {
    const value = m?.v2?.houseVault;
    if (!isAddress(value)) continue;
    const want = await checksum(value);
    if (want !== value) issues.push(`${m.ticker}: v2.houseVault ${value} is not checksummed (${want})`);
  }
  return issues;
}

/**
 * Every pinned Uniswap v4 pool id, recomputed from its key (INTERFACE_VERSION 8). Needs `cast`, so it
 * sits beside the checksum checks rather than inside the offline validator.
 *
 * A v4 pool has no address: `poolId = keccak256(abi.encode(PoolKey))` IS the pin, and `PayoutRouter`
 * and `V4BuybackExecutor` swap on whatever id they are given. An id that was copied from a recon run
 * but does not hash from the key beside it names a different pool — possibly a hooked one, possibly
 * someone else's — and nothing on chain would say so, because the swap would simply execute there.
 */
export async function poolIdIssues(registry) {
  const issues = [];
  const usdg = at(registry, "shared.usdg");
  const check = async (label, key, claimed) => {
    const got = await keccak(encodePoolKey(key));
    if (got.toLowerCase() !== String(claimed).toLowerCase()) {
      issues.push(`${label} is ${claimed} but keccak256(abi.encode(PoolKey)) of the key beside it is ${got}: the pinned id names a different pool`);
    }
  };
  const token = at(registry, "shared.token");
  if (isObject(token) && typeof token.poolId === "string" && BYTES32.test(token.poolId) && isObject(token.poolKey)) {
    const pk = token.poolKey;
    if (isAddress(pk.currency0) && isAddress(pk.currency1) && isUint(pk.fee) && isUint(pk.tickSpacing) && isAddress(pk.hooks)) {
      await check("shared.token.poolId", pk, token.poolId);
    }
  }
  if (!isAddress(usdg)) return issues;
  for (const m of registry.markets ?? []) {
    const r = m.v2?.payoutRoute;
    if (!isObject(r) || r.venue !== "v4" || !isAddress(m.asset)) continue;
    if (!(typeof r.poolId === "string" && BYTES32.test(r.poolId)) || !isUint(r.fee) || !isUint(r.tickSpacing)) continue;
    // The pair and the hooks are not the route's to choose: (asset, USDG) sorted, hooks address(0).
    await check(`${m.ticker}: v2.payoutRoute.poolId`, { ...routeCurrencies(m.asset, usdg), fee: r.fee, tickSpacing: r.tickSpacing, hooks: ZERO_ADDRESS }, r.poolId);
  }
  return issues;
}

/** Every v2 problem the registry has without touching the chain. */
/** The keys `launchSet` carries. Closed, like every other block the validator walks. */
export const LAUNCH_SET_KEYS = ["note", "markets"];

/**
 * The launch set: which markets a v8 launch actually deploys, named explicitly.
 *
 * WHY THIS IS NOT DERIVED FROM `wave` OR `status`, which is the whole point of the block. Those two
 * fields answer different questions and neither answers this one:
 *   - `wave` / `v2.wave` mean rollout ORDER. There are TWO of them and they disagree by design --
 *     top-level `wave` is the v1-era grouping, `v2.wave` is the v8 one -- so "which wave is the
 *     launch" has two answers and a tool picks one by accident. `v2.wave` puts NVDA in `canary` and
 *     SPCX in `wave1` alongside 18 others; the top-level field puts NVDA in `live` and SPCX in
 *     `wave2`. Neither set is {NVDA, SPCX}.
 *   - `status` is the v1 FACTORY lifecycle. 34 of 35 markets read `superseded-by-v2`; it says
 *     nothing about v8 and gates nothing in a v8 deploy.
 * So a launch tool that filters on either silently leaves SPCX out, which is the defect this block
 * removes. Adding a market to the launch set is an explicit edit here, not a side effect of moving a
 * bucket.
 *
 * WHY IT IS A ROOT KEY AND NOT A PER-MARKET FLAG: `exactKeys` is SYMMETRIC (see the note at the
 * V2_PROTOCOL_KEYS block), and it IS applied to the per-market `v2` block, so a per-market flag would
 * become REQUIRED on every market of every registry the validator walks -- including
 * `ops/markets/dev.json`, which is exactly how `distributors.lender` left that file a line short. The
 * ROOT object is not exact-keyed (`dev.json` carries `_dev` and `tier1.json` does not, and both
 * validate), so a root block is addable without touching any other registry.
 *
 * REQUIRED on a production-shaped registry and OPTIONAL elsewhere. `production` is non-null only when
 * a dev registry is being validated against production, so a null `production` is the production
 * registry itself. That keeps `dev.json` -- which is out of this row's fence -- valid untouched.
 */
export function validateLaunchSet(registry, production, issues) {
  const block = registry?.launchSet;
  if (block === undefined) {
    if (production === null) issues.push("launchSet is missing: a production registry must name its launch set explicitly");
    return;
  }
  if (!isObject(block)) {
    issues.push("launchSet must be an object of { note, markets }");
    return;
  }
  exactKeys(block, LAUNCH_SET_KEYS, "launchSet", issues);
  if (typeof block.note !== "string" || block.note.trim() === "") {
    issues.push("launchSet.note must be a non-empty string saying why the set is what it is");
  }
  const list = block.markets;
  if (!Array.isArray(list) || list.length === 0) {
    issues.push("launchSet.markets must be a non-empty array of tickers");
    return;
  }
  const known = new Set((registry?.markets ?? []).map((m) => m?.ticker));
  const seen = new Set();
  for (const ticker of list) {
    if (typeof ticker !== "string" || ticker === "") {
      issues.push(`launchSet.markets contains ${JSON.stringify(ticker)}, which is not a ticker`);
      continue;
    }
    if (seen.has(ticker)) issues.push(`launchSet.markets names ${ticker} twice`);
    seen.add(ticker);
    // The check that matters: a launch set naming a market the registry does not carry would deploy
    // nothing and read as a configured launch.
    if (!known.has(ticker)) issues.push(`launchSet.markets names ${ticker}, which is not a market in this registry`);
  }
}

export function validateV2(registry, recon, production) {
  const issues = [];
  validateShared(registry, issues);
  validateDeployedCompleteness(registry, issues);
  validateV2Top(registry.v2, recon, issues);
  validateV2Bots(registry, issues);
  validateV2Protocol(registry, issues);
  validateDevIsolation(registry, production, issues);
  validateLaunchSet(registry, production, issues);
  const tickers = new Set();
  for (const m of registry.markets) {
    if (tickers.has(m.ticker)) issues.push(`${m.ticker}: listed twice`);
    tickers.add(m.ticker);
    validateMarket(m, registry, recon, issues);
  }
  return issues;
}

/**
 * Each configured pool on chain, at the verification block: its tokens are {asset, USDG} and the
 * v3 factory returns it for its own fee tier (so it is a canonical factory pool, not a lookalike).
 * In-range liquidity under the floor is a note: harmonic-mean liquidity at settlement is the gate.
 */
async function probeV2Pools(registry, block) {
  const issues = [];
  const notes = [];
  const factory = registry.v2?.uniswapV3?.factory;
  const usdg = registry.shared.usdg.toLowerCase();
  const withPool = registry.markets.filter((m) => isAddress(m.v2?.univ3Pool));
  if (withPool.length && !isAddress(factory)) return { issues: ["v2.uniswapV3.factory is not an address: pools not probed"], notes, probed: 0 };
  await pool(withPool, 4, async (m) => {
    const p = m.v2.univ3Pool;
    try {
      const [token0] = await call(p, "token0()(address)", block);
      const [token1] = await call(p, "token1()(address)", block);
      const [fee] = await call(p, "fee()(uint24)", block);
      const [liquidity] = await call(p, "liquidity()(uint128)", block);
      const got = [token0.toLowerCase(), token1.toLowerCase()].sort().join("/");
      const want = [m.asset.toLowerCase(), usdg].sort().join("/");
      if (got !== want) issues.push(`${m.ticker}: pool ${p} on chain holds ${got}, not {asset, USDG} ${want}`);
      // INTERFACE_VERSION 6: UniV3PayoutAdapter.setRoute refuses a tier above 1 % (V2Constants.MAX_ROUTE_FEE_TIER) and
      // RegisterMarkets will not take such a pool as a TWAP source either.
      if (Number(fee) > MAX_ROUTE_FEE_TIER) issues.push(`${m.ticker}: pool ${p} fee tier ${fee} is above ${MAX_ROUTE_FEE_TIER} (1 %): no payout route or TWAP source can use it`);
      const [canonical] = await call(factory, "getPool(address,address,uint24)(address)", block, [token0, token1, fee]);
      if (canonical.toLowerCase() !== p.toLowerCase()) issues.push(`${m.ticker}: factory getPool(…, ${fee}) is ${canonical}, not ${p}`);
      if (isDecimalIn(m.v2.univ3MinLiquidity, UINT128_MAX) && BigInt(liquidity) < BigInt(m.v2.univ3MinLiquidity)) {
        notes.push(`${m.ticker}: in-range liquidity ${liquidity} is below the floor ${m.v2.univ3MinLiquidity} at block ${block}`);
      }
    } catch (e) {
      issues.push(`${m.ticker}: pool ${p}: ${e.message.split("\n")[0]}`);
    }
  });
  return { issues, notes, probed: withPool.length };
}

/*//////////////////////////////////////////////////////////////
                ROOT KEYS: CARRIED, REGENERATED, RETIRED
//////////////////////////////////////////////////////////////*/

/**
 * The root keys whose value in the registry READ a build deliberately throws away and writes afresh
 * (T-607). Each is an OUTPUT of the run, and each says why. Every root key NOT named here or in
 * RETIRED_ROOT_KEYS is an INPUT, and `rootKeyIssues` makes a rebuild carry it out exactly as it came in.
 *
 * WHY THE LIST NAMES WHAT IS DROPPED AND NOT WHAT IS KEPT. `assembleRegistry` builds the registry as a
 * CLOSED literal. It must: spreading `existing` into it would resurrect the previous run's `generatedAt`
 * and `verifiedAtBlock` and report them as this run's. So each input key survives only because somebody
 * wrote a line for it (`_dev`, `launchSet`, `shared`, `v2`), and a list of keys to keep would be one more
 * list to forget. That already nearly happened: T-OP-003's `launchSet` would have been deleted by the
 * next build, and every consumer would have gone back to a wave filter and launched twenty markets
 * instead of two. Inverting the list turns forgetting into a red build that names the key.
 *
 * Adding a key here is the claim that its old value is worthless. If a hand edit to it matters, it is
 * not an output and does not belong here.
 */
export const REGENERATED_ROOT_KEYS = Object.freeze({
  _readme: "the README constant: it describes the builder that wrote the file, so it follows the code",
  generatedAt: "the wall-clock time of this run",
  verifiedAtBlock: "the chain head this run verified every market against",
  rpc: "the endpoint this run read (RH_RPC)",
  feedsSource: "the feed directory this run fetched or was given (--feeds), and its counts",
  tokensSource: "the Stock Token list this run read, and its count",
  defaults: "the DEFAULTS constant; a market that needs another value carries it on the market",
  waves: "the WAVES constant; each market's own `wave` is the hand-maintained field",
  skipped: "the feeds this run could not pair with exactly one Stock Token",
  summary: "counts over this run's markets",
  markets:
    "rebuilt from this run's feeds and chain reads; the hand-maintained per-market fields are merged from the previous row inside the market literal, not carried as a block",
});

/**
 * Root keys removed from the registry ON PURPOSE: the value read is discarded and the build must not
 * write the key again. Empty today. This is where a key goes to be retired, so that retiring one is an
 * edit with a reason rather than a line somebody deleted.
 */
export const RETIRED_ROOT_KEYS = Object.freeze({});

/**
 * What writing `written` over `read` would lose, one issue per root key; empty when nothing is lost.
 *
 *   - a root key of `read` named in neither list must be in `written` with a deep-equal value: absent
 *     is the silent drop this guard exists for, and a different value is the same loss one level down
 *     (a hand-maintained block rewritten from a constant is how `dev.json` stayed a copy of production);
 *   - a REGENERATED key must be written, or it is a dropped key under a better name;
 *   - a RETIRED key must not be written, or the retirement is not in effect;
 *   - no key may be in both lists.
 *
 * `read` is null for a first build: there is nothing to lose, and the list checks still apply.
 */
export function rootKeyIssues(read, written, { regenerated = REGENERATED_ROOT_KEYS, retired = RETIRED_ROOT_KEYS } = {}) {
  const issues = [];
  for (const key of Object.keys(regenerated)) {
    if (Object.hasOwn(retired, key)) issues.push(`root key ${key} is in both REGENERATED_ROOT_KEYS and RETIRED_ROOT_KEYS: it is written afresh or it is gone, not both`);
    else if (!Object.hasOwn(written, key)) issues.push(`root key ${key} is in REGENERATED_ROOT_KEYS but this build did not write it: a regenerated key that is not written is a dropped one`);
  }
  for (const key of Object.keys(retired)) {
    if (!Object.hasOwn(regenerated, key) && Object.hasOwn(written, key)) {
      issues.push(`root key ${key} is in RETIRED_ROOT_KEYS but this build still writes it`);
    }
  }
  if (!isObject(read)) return issues;
  for (const key of Object.keys(read)) {
    if (Object.hasOwn(regenerated, key) || Object.hasOwn(retired, key)) continue;
    if (!Object.hasOwn(written, key)) {
      issues.push(
        `root key ${key} is in the registry read and missing from the registry about to be written: carry it in assembleRegistry, or name it in REGENERATED_ROOT_KEYS / RETIRED_ROOT_KEYS with the reason its old value can go`,
      );
    } else if (!isDeepStrictEqual(written[key], read[key])) {
      issues.push(`root key ${key} is not regenerated by this build, yet it would be written with a different value than the registry read: carry it as written`);
    }
  }
  return issues;
}

/**
 * The registry a build writes, from the registry it read (`existing`, null for a first build) and this
 * run's results. A CLOSED literal on purpose -- see REGENERATED_ROOT_KEYS for why it must not spread
 * `existing`, and `rootKeyIssues` for what stops a key nobody named here from vanishing.
 */
export function assembleRegistry(existing, { block, feedsSource, feeds, equity, tokens, skipped, markets }) {
  const failing = markets.filter((m) => !m.verification.ok);
  return {
    // Preserved as written, like the v2 blocks: what a non-production registry (supplied explicitly,
    // `--registry`) says about itself. Absent from ops/markets/tier1.json, which _readme describes.
    ...(existing && "_dev" in existing ? { _dev: existing._dev } : {}),
    // Hand-maintained: the launch set the owner named (T-OP-003). Without this line a rebuild would drop
    // it and every consumer would fall back on a wave filter -- rootKeyIssues now names it if it goes.
    ...(existing && "launchSet" in existing ? { launchSet: existing.launchSet } : {}),
    _readme: README,
    generatedAt: new Date().toISOString(),
    verifiedAtBlock: block,
    rpc: RPC,
    feedsSource: { source: feedsSource, total: feeds.length, equity: equity.length },
    tokensSource: { file: "ops/recon/R6-stock-tokens-list.json", total: tokens.length },
    shared: sharedOf(existing),
    defaults: DEFAULTS,
    waves: WAVES,
    // Hand-maintained until the v2 deploy writes addresses back; the skeleton only for a first build.
    // NOT mirrored per sub-key on purpose (T-OP-131 tried `uniswapV3` and T-607's root-key guard refused
    // the build: `v2` is carried as written or it is not). Drift in `v2.uniswapV3` is refused by `--check`
    // (`validateV2Top`) against V2_SKELETON.uniswapV3 instead, with the exact string to set.
    v2: existing && "v2" in existing ? existing.v2 : V2_SKELETON,
    skipped,
    summary: {
      markets: markets.length,
      verified: markets.length - failing.length,
      failing: failing.map((m) => m.ticker),
      vol: markets.filter((m) => m.mode === "vol").map((m) => m.ticker),
      fixed: markets.filter((m) => m.mode === "fixed").map((m) => m.ticker),
      live: markets.filter((m) => m.status === "live").map((m) => m.ticker),
    },
    markets,
  };
}

/**
 * Every key `assembleMarket` writes, classified (T-OP-023). This is the per-market twin of
 * REGENERATED_ROOT_KEYS, and it exists for the same reason: the market row is a CLOSED literal, so a
 * hand-written key the literal does not name comes out of a rebuild gone, with no message. The root
 * guard (T-607) cannot see it: `markets` is a REGENERATED root key, so the whole block is this run's
 * output as far as `rootKeyIssues` is concerned.
 *
 * WHY THE LIST NAMES EVERY KEY, both directions. At the root, naming only what is dropped works
 * because everything else is carried verbatim. Here "carried" is not one thing: `depositCapUsd` keeps
 * a hand-written null (uncapped), `strikeOtmBps` and its siblings turn a null into DEFAULTS through
 * `??`, and `modeOverride` / `notes` are written only when set. A per-field decision is the only honest
 * shape, and `marketKeyIssues` refuses what each decision refuses. The test asserts this constant and
 * the literal name the same keys, so adding a key to one without the other fails the suite, not the
 * operator.
 *
 *   regenerated  written from this run's feed, token and chain reads; the previous value is worthless
 *   carried      hand-maintained, always written: from the previous row when it has the key, else the
 *                default; `nullOk` says whether a hand-written null is a legal value or the thing the `??`
 *                would silently replace with a default -- refused loudly in that case, with the ticker
 *                and field named
 *   kept         hand-maintained and written only when the previous row HAS the key, exactly as read,
 *                null included (`"v1RunOff" in prev`): absent stays absent, and nothing is defaulted
 *   optional     hand-maintained and written only when set: null, false, "" and absent all mean "not set"
 *                and the key is legitimately absent from the rebuilt row
 *
 * Adding a key to `carried` with `nullOk: false` is the claim that null has no meaning for it and the
 * operator who wrote one meant something else. `depositCapUsd` is the precedent for the opposite:
 * null is a value there (uncapped), read with `"depositCapUsd" in prev` so it survives.
 */
export const MARKET_FIELDS = Object.freeze({
  ticker: { kind: "regenerated", why: "the feed's ticker, the row's identity" },
  name: { kind: "regenerated", why: "the Stock Token's name from the R6 list" },
  asset: { kind: "regenerated", why: "the Stock Token address, checksummed" },
  assetSymbol: { kind: "regenerated", why: "symbol() read on chain by verifyPair" },
  assetDeployBlock: { kind: "regenerated", why: "the token's deploy block from the R6 list" },
  feed: { kind: "regenerated", why: "the Chainlink proxy from the feed directory" },
  feedSvr: { kind: "regenerated", why: "the secondary proxy from the feed directory, or null" },
  feedAggregator: { kind: "regenerated", why: "the aggregator from the feed directory, or null" },
  feedName: { kind: "regenerated", why: "the feed directory's name for the feed" },
  feedDescription: { kind: "regenerated", why: "description() read on chain by verifyPair" },
  feedHeartbeatS: { kind: "regenerated", why: "the feed directory's heartbeat" },
  feedThresholdPct: { kind: "regenerated", why: "the feed directory's deviation threshold" },
  cboe: { kind: "regenerated", why: "this run's Cboe probe (--skip-cboe keeps the previous evidence, which is still this run's choice)" },
  mode: { kind: "regenerated", why: "modeOverride, else the mode the Cboe evidence decides" },
  modeReason: { kind: "regenerated", why: "why `mode` is what it is" },
  modeOverride: { kind: "optional", why: "a hand-written override; null and absent both mean no override, so a null is legitimately not written" },
  depositCapUsd: {
    kind: "carried",
    nullOk: true,
    why: "null is a VALUE here: uncapped, type(uint256).max on the live NVDA factory; read with `in prev` so it survives (the precedent for a null that is legal)",
  },
  depositCap: { kind: "regenerated", why: "depositCapUsd converted at this run's spot" },
  strikeOtmBps: { kind: "carried", nullOk: false, why: "read with ??, so a null would be replaced by DEFAULTS.strikeOtmBps silently; delete the key to take the default" },
  minAskUsdg6: { kind: "carried", nullOk: false, why: "read with ??; ops/keeper-env.sh renders it and a null has no meaning there" },
  targetDelta: { kind: "carried", nullOk: false, why: "read with ??; a vol-mode knob the keeper needs a number for" },
  priceEdgeBps: { kind: "carried", nullOk: false, why: "read with ??; same" },
  premiumMarginBps: { kind: "carried", nullOk: false, why: "read with ??; same" },
  wave: { kind: "carried", nullOk: false, why: "read with ??; a null would be replaced by the WAVES lookup, and validateMarket only sees the result" },
  status: { kind: "carried", nullOk: false, why: "read with ??; a null would become live or superseded-by-v2 from the wave, and validateMarket only sees the result" },
  v1RunOff: { kind: "kept", why: "written iff the row has it, as written (`in prev`); ops/keeper-env.sh refuses a bad value, and dropping it here would un-freeze the market" },
  v1FrozenAt: { kind: "kept", why: "written iff the row has it, null until the freeze (`in prev`); validateMarket refuses a bad one" },
  v2: { kind: "carried", nullOk: true, why: "hand-maintained as written (`in prev`), never merged key by key; validateMarket refuses a bad block, including null" },
  verification: { kind: "regenerated", why: "this run's on-chain checks" },
  deployment: { kind: "carried", nullOk: false, why: "read with ??, so a null would be replaced by the all-null skeleton silently and a written-back factory could vanish under it" },
  explorer: { kind: "regenerated", why: "explorer links derived from asset and feed" },
  notes: { kind: "optional", why: "a hand-written note, written only when non-empty; an empty string or null is legitimately not written" },
});

/**
 * What writing `written` over `read` would lose for one market, one issue per key; empty when nothing
 * is lost. The per-market analogue of `rootKeyIssues`, judged before the write like it.
 *
 *   - a key of `written` that MARKET_FIELDS does not classify is refused: the literal grew a key and
 *     nobody decided what a rebuild does with the old value;
 *   - a `regenerated` or `carried` key must be written -- absent is a dropped key under a better name;
 *   - a key of `read` that MARKET_FIELDS does not name is refused: the literal does not write it, so a
 *     rebuild would drop it silently (the T-OP-023 defect);
 *   - a `carried` key read as null with `nullOk: false` is refused: the literal would default it;
 *   - a `carried` or `kept` key must be written deep-equal to what was read (a different value is the
 *     same loss one level down), and a `kept` key absent from `read` must not be invented;
 *   - an `optional` key read as set must be written equal; read as unset it may be absent.
 *
 * `read` is undefined for a market the builder has not seen before: nothing to lose, list checks apply.
 */
export function marketKeyIssues(read, written, fields = MARKET_FIELDS) {
  const t = written?.ticker ?? read?.ticker ?? "?";
  const issues = [];
  if (!isObject(written)) return [`${t}: the market about to be written is not an object`];
  for (const key of Object.keys(written)) {
    if (!Object.hasOwn(fields, key)) {
      issues.push(`${t}: key ${key} is written by assembleMarket but MARKET_FIELDS does not classify it: say whether a rebuild regenerates or carries it`);
    }
  }
  for (const [key, f] of Object.entries(fields)) {
    if ((f.kind === "regenerated" || f.kind === "carried") && !Object.hasOwn(written, key)) {
      issues.push(`${t}: key ${key} is ${f.kind} in MARKET_FIELDS but this build did not write it: a classified key that is not written is a dropped one`);
    }
  }
  if (!isObject(read)) {
    for (const [key, f] of Object.entries(fields)) {
      if (f.kind === "kept" && Object.hasOwn(written, key)) issues.push(`${t}: ${key} is kept only when read, yet this build writes it for a market it has not seen`);
    }
    return issues;
  }
  for (const [key, f] of Object.entries(fields)) {
    if (f.kind === "kept" && !Object.hasOwn(read, key) && Object.hasOwn(written, key)) {
      issues.push(`${t}: ${key} is absent from the registry read yet this build writes it`);
    }
    if (f.kind === "optional" && !read[key] && Object.hasOwn(written, key)) {
      issues.push(`${t}: ${key} is unset in the registry read yet this build writes it`);
    }
  }
  for (const key of Object.keys(read)) {
    const f = fields[key];
    if (!f) {
      issues.push(
        `${t}: key ${key} is in the market read and missing from the market about to be written: carry it in assembleMarket and classify it in MARKET_FIELDS, or delete it from the registry with the reason its value can go`,
      );
      continue;
    }
    if (f.kind === "regenerated") continue;
    if (f.kind === "carried" || f.kind === "kept") {
      if (f.kind === "carried" && read[key] === null && !f.nullOk) {
        issues.push(`${t}: ${key} is null in the registry read, and the builder would replace it with its default silently. Delete the key to take the default, or write a value`);
      } else if (!Object.hasOwn(written, key)) {
        issues.push(`${t}: ${key} is in the market read and missing from the market about to be written: a ${f.kind} key is written as read`);
      } else if (!isDeepStrictEqual(written[key], read[key])) {
        issues.push(`${t}: ${key} is ${f.kind}, not regenerated, yet it would be written with a different value than the registry read: carry it as written`);
      }
      continue;
    }
    // optional: written when set, legitimately absent otherwise (the unset-yet-written case is above)
    if (read[key] && !isDeepStrictEqual(written[key], read[key])) {
      issues.push(`${t}: ${key} is set in the registry read and would not be written as read`);
    }
  }
  return issues;
}

/**
 * One market row, from the previous row (`prev`, undefined for a market the builder has not seen) and
 * this run's reads. A CLOSED literal on purpose, like `assembleRegistry`: spreading `prev` would carry
 * the previous run's verification and Cboe evidence and report them as this run's. `MARKET_FIELDS`
 * says what each key is and `marketKeyIssues` refuses what the closed shape would otherwise lose.
 */
export function assembleMarket(prev, { ticker, token, asset, feed, feedProxy, feedSvr, feedAggregator, verification, cboe, shared }) {
  const auto = modeFor(cboe);
  const mode = prev?.modeOverride ?? auto.mode;

  // `depositCapUsd: null` means uncapped (the live NVDA factory runs with type(uint256).max).
  const depositCapUsd = prev && "depositCapUsd" in prev ? prev.depositCapUsd : DEFAULTS.depositCapUsd;
  const spot = verification.spotUsd ?? 0;
  let depositCap;
  if (depositCapUsd === null) {
    depositCap = (2n ** 256n - 1n).toString();
  } else {
    const capTokens = spot > 0 ? Math.max(1, Math.floor(depositCapUsd / spot)) : 1;
    depositCap = (BigInt(capTokens) * 10n ** 18n).toString();
  }

  const wave = prev?.wave ?? (Object.entries(WAVES).find(([, list]) => list.includes(ticker))?.[0] ?? "wave2");
  // ADR-02 cancelled the per-market factory rollout: a market the builder has not seen before is
  // never a v1 candidate. It enters superseded, with a planned v2 block (v2MarketSkeleton).
  const status = prev?.status ?? (wave === "live" ? "live" : "superseded-by-v2");

  return {
    ticker,
    name: token.name,
    asset,
    assetSymbol: verification.tokenSymbol ?? null,
    assetDeployBlock: token.block,
    feed: feedProxy,
    feedSvr,
    feedAggregator,
    feedName: feed.name,
    feedDescription: verification.feedDescription ?? null,
    feedHeartbeatS: feed.heartbeat ?? null,
    feedThresholdPct: feed.threshold ?? null,
    cboe,
    mode,
    modeReason: prev?.modeOverride ? `override (auto: ${auto.mode}, ${auto.reason})` : auto.reason,
    ...(prev?.modeOverride ? { modeOverride: prev.modeOverride } : {}),
    depositCapUsd,
    depositCap,
    strikeOtmBps: prev?.strikeOtmBps ?? DEFAULTS.strikeOtmBps,
    minAskUsdg6: prev?.minAskUsdg6 ?? DEFAULTS.minAskUsdg6,
    targetDelta: prev?.targetDelta ?? DEFAULTS.targetDelta,
    priceEdgeBps: prev?.priceEdgeBps ?? DEFAULTS.priceEdgeBps,
    premiumMarginBps: prev?.premiumMarginBps ?? DEFAULTS.premiumMarginBps,
    wave,
    status,
    // Absent means false. Whatever was hand-written survives as written: a bad value is refused
    // loudly by ops/keeper-env.sh, where dropping it here would quietly un-freeze the market.
    ...(prev && "v1RunOff" in prev ? { v1RunOff: prev.v1RunOff } : {}),
    // Absent (or null) until the freeze. Kept as written too; validateMarket refuses a bad one.
    ...(prev && "v1FrozenAt" in prev ? { v1FrozenAt: prev.v1FrozenAt } : {}),
    // Hand-maintained as written (validateMarket says what is wrong with it); never merged key by key.
    v2: prev && "v2" in prev ? prev.v2 : v2MarketSkeleton(),
    verification,
    deployment: prev?.deployment ?? {
      factory: null,
      implementation: null,
      deployBlock: null,
      deployTx: null,
      keeper: null,
      keeperKeyIndex: null,
      guardian: shared.guardian,
      admin: shared.admin,
      feeRecipient: shared.feeRecipient,
      sourcify: null,
      configuredAt: null,
    },
    explorer: { asset: `${EXPLORER}/address/${asset}`, feed: `${EXPLORER}/address/${feedProxy}` },
    ...(prev?.notes ? { notes: prev.notes } : {}),
  };
}

/*//////////////////////////////////////////////////////////////
                               MAIN
//////////////////////////////////////////////////////////////*/

async function main() {
  const existing = loadExisting();
  // INTERFACE_VERSION 8: ops/markets/v7-legacy.json is the frozen v7 production registry, kept so the
  // v7 monitor and cranker instances have something to read during the run-off and so an audit can
  // still resolve a v7 address. This builder validates interface 8 only, and validating a frozen file
  // against rules that were inverted under it would report every v7 value as a fault. Refuse it here,
  // loudly, rather than let somebody "fix" the freeze to make a check pass.
  if (existing && "_legacy" in existing) {
    log(`${path.relative(process.cwd(), OUT)} is a FROZEN legacy registry (_legacy). This builder knows INTERFACE_VERSION ${INTERFACE_VERSION};`);
    log("it is neither rebuilt nor validated. ops/v2-env.mjs --registry <this file> still renders its service env.");
    process.exit(2);
  }
  // A registry that says `_dev` is judged against production as well as against itself: it may not
  // name a wallet, bot key or contract that ops/markets/tier1.json calls its own.
  const production = existing && "_dev" in existing && existsSync(PRODUCTION_REGISTRY) && realpathSync(PRODUCTION_REGISTRY) !== realpathSync(OUT)
    ? JSON.parse(readFileSync(PRODUCTION_REGISTRY, "utf8"))
    : null;
  const { source: feedsSource, feeds } = await loadFeeds();
  const tokens = loadTokens();
  const recon = loadV2Sources();
  const prevByTicker = new Map((existing?.markets ?? []).map((m) => [m.ticker, m]));
  // INTERFACE_VERSION 8: hand-maintained, like the v2 blocks. Only a registry that has none gets the
  // skeleton. Rewriting it from a constant is what kept dev.json a copy of production (SHARED_SKELETON).
  const shared = sharedOf(existing);

  const equity = feeds.filter((f) => f?.docs?.marketHours === "us_equities_24/5");
  log(`feeds: ${feeds.length} total, ${equity.length} tokenised-equity (us_equities_24/5)`);

  const bySymbol = new Map();
  for (const t of tokens) {
    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, []);
    bySymbol.get(t.symbol).push(t);
  }

  const block = await blockNumber();
  log(`chain 4663 head ${block} via ${RPC}`);

  const skipped = [];
  const pairs = [];
  for (const f of equity) {
    const ticker = tickerOf(f);
    if (!ticker) {
      skipped.push({ feed: f.name, why: "ticker not derivable from feed name" });
      continue;
    }
    const matches = bySymbol.get(ticker) ?? [];
    if (matches.length !== 1) {
      skipped.push({ feed: f.name, ticker, why: `${matches.length} Stock Tokens with symbol ${ticker} in R6 list` });
      continue;
    }
    pairs.push({ ticker, feed: f, token: matches[0] });
  }
  pairs.sort((a, b) => (a.ticker < b.ticker ? -1 : 1));
  log(`pairs: ${pairs.length}; skipped: ${skipped.length}`);

  const markets = await pool(pairs, 6, async ({ ticker, feed, token }) => {
    const asset = await checksum(token.token);
    const feedProxy = await checksum(feed.proxyAddress);
    const feedSvr = feed.secondaryProxyAddress ? await checksum(feed.secondaryProxyAddress) : null;
    const feedAggregator = feed.contractAddress ? await checksum(feed.contractAddress) : null;
    const prev = prevByTicker.get(ticker);

    const verification = await verifyPair(ticker, asset, feedProxy, block);
    log(`  ${ticker.padEnd(6)} ${verification.ok ? "ok  " : "FAIL"} spot=${verification.spotUsd ?? "?"} age=${verification.feedAgeS ?? "?"}s ${verification.issues.join("; ")}`);

    const cboe = SKIP_CBOE ? (prev?.cboe ?? null) : await probeCboe(ticker, verification.spotUsd, prev?.cboe);
    return assembleMarket(prev, { ticker, token, asset, feed, feedProxy, feedSvr, feedAggregator, verification, cboe, shared });
  });
  // T-OP-023: the same guard as rootKeyIssues, one level down. A hand-written per-market key the
  // literal does not name, or a null the literal would silently default, is refused before the write.
  const lostMarketKeys = markets.flatMap((m) => marketKeyIssues(prevByTicker.get(m.ticker), m));

  const failing = markets.filter((m) => !m.verification.ok);
  const registry = assembleRegistry(existing, { block, feedsSource, feeds, equity, tokens, skipped, markets });
  // T-607: every root key of the registry read comes out of this build as it went in, unless
  // REGENERATED_ROOT_KEYS or RETIRED_ROOT_KEYS says why not. Judged before anything is written,
  // because the write is the step that destroys the key.
  const lostRootKeys = rootKeyIssues(existing, registry);

  // --check judges the committed file (a registry with no v2 block must fail, not borrow the
  // skeleton); a build judges what it is about to write.
  const subject = CHECK_ONLY && existing ? existing : registry;
  const v2Issues = validateV2(subject, recon, production);
  v2Issues.push(...(await checksumV2Bots(subject)));
  v2Issues.push(...(await checksumV2Protocol(subject)));
  v2Issues.push(...(await checksumShared(subject)));
  v2Issues.push(...(await checksumMarketHouseVaults(subject)));
  v2Issues.push(...(await poolIdIssues(subject)));
  const probe = await probeV2Pools(subject, block);
  v2Issues.push(...probe.issues);
  for (const n of probe.notes) log(`  note: ${n}`);
  const v2Summary = `v2: ${subject.markets.length} market blocks, ${probe.probed} pools checked on chain at block ${block}, ${v2Issues.length} problem(s)`;

  if (CHECK_ONLY) {
    const drift = [];
    for (const m of markets) {
      const p = prevByTicker.get(m.ticker);
      if (!p) drift.push(`${m.ticker}: new`);
      else if (p.asset !== m.asset || p.feed !== m.feed) drift.push(`${m.ticker}: asset/feed changed`);
      if (!m.verification.ok) drift.push(`${m.ticker}: ${m.verification.issues.join("; ")}`);
    }
    for (const t of prevByTicker.keys()) if (!markets.some((m) => m.ticker === t)) drift.push(`${t}: gone from feed directory`);
    drift.push(...lostRootKeys, ...lostMarketKeys);
    drift.push(...v2Issues);
    if (drift.length) {
      log("DRIFT:\n  " + drift.join("\n  "));
      log(v2Summary);
      process.exit(1);
    }
    log(v2Summary);
    log("no drift");
    return;
  }

  // Unlike a failing verification or a v2 problem, which are written and then refused by the exit code,
  // a lost root key is refused BEFORE the write: writing it is the loss, and the file on disk still has it.
  if (lostRootKeys.length || lostMarketKeys.length) {
    log(`NOT WRITTEN: ${path.relative(process.cwd(), OUT)} would lose keys:\n  ` + [...lostRootKeys, ...lostMarketKeys].join("\n  "));
    process.exit(1);
  }
  mkdirSync(here, { recursive: true });
  writeFileSync(OUT, JSON.stringify(registry, null, 2) + "\n");
  log(`wrote ${path.relative(process.cwd(), OUT)}: ${markets.length} markets, ${failing.length} failing verification, ${registry.summary.fixed.length} fixed-mode (${registry.summary.fixed.join(", ")})`);
  if (skipped.length) log("skipped:", JSON.stringify(skipped, null, 1));
  log(v2Summary);
  // Written anyway, like a failing verification: the hand edits are preserved as they were, and
  // the exit code is what stops a deploy.
  if (v2Issues.length) log("v2 PROBLEMS:\n  " + v2Issues.join("\n  "));
  if (failing.length || v2Issues.length) process.exit(1);
}

// Imported (by ops/markets/build-markets.test.mjs, which calls the validators directly) this file
// must not build anything: `main()` reads the feed directory and the chain.
const isMain = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((e) => {
    log(e.stack ?? String(e));
    process.exit(1);
  });
}
