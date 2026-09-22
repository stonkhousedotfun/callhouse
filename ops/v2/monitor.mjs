#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * ops/v2/monitor.mjs — the v2 external monitor: the conditions no bot emits.
 *
 * The cranker, MM bot and pricer page about their own work (keeper/src/v2/alerts.ts). Nothing pages
 * when they are down, and nothing watches the third parties v2 settles against. This script does,
 * from the registry (ops/markets/tier1.json v2 blocks) and the chain alone:
 *
 *   settlement   an expiry with open interest not finalized 2 h after expiry; a disagreeing-source
 *                candidate; a held (vetoed) expiry; a pool snapshot missed
 *   backlog      redeemable holders (or book escrow) of a settled series left 6 h after settlement
 *   rewards      KeeperRewards budget below N expiries of spend; the daily cap at 0 or reached
 *   vault        MakerVault limits near their caps; USDG / Stock Token inventory under a floor; the 24 h net USDG
 *                outflow bucket half used (warn), nearly full (error) or frozen at a cap of 0
 *   roller       a tracked AutoRoller ask the market has overtaken (an ok spot at or past its strike) still live
 *                after rollerStaleS: cancelStale is permissionless and the cranker runs it every tick, so it should
 *                be gone. Warn instead of error when the writer revoked the roller's delegate: nobody else can cancel
 *   rent         writer rent, read in whichever direction the registry's v2.interfaceVersion calls for. Under 7 it
 *                is the only writer fee there is, so 0 is the alarm: a live market whose MarketConfig.mintFeePpm is
 *                0, or a registry with no rate. Under 8 the OrderBook's seller fee replaced it and rent is switched
 *                off, so THE ALERT IS INVERTED — a non-zero rate on a market, in the registry, or pinned into a
 *                live series is the alarm. Both live here because the same binary also watches the frozen v7
 *                run-off deployment through ops/markets/v7-legacy.json. Either way each series' rent ledger from
 *                the chain's own logs (Minted.fee in, Closed.feeRefund out, MintFeesAccrued at settlement) must add up
 *   config       admin actions on our contracts (role, source, fee, limit and treasury changes, vetoes, unvetoes
 *                and admin resolutions); history before the first run is adopted, not paged. INTERFACE_VERSION 6
 *                wiring has kinds of its own: a scheduled fee change (error when a fee rises or the maker rebate
 *                falls), a payout route (error: tier above 10000 or not the registry pool), a source's oracle
 *                allow-list (error: anything but the published oracle allowed, or it removed), the oracle's
 *                Clearinghouse pointer (error: not the live Clearinghouse), a pin made outside a series creation
 *                (a SettlementConfigPinned without the Clearinghouse's SeriesCreated, a source pin without either),
 *                a Data Streams feed change while that source is listed anywhere
 *   fees         a pending OrderBook fee change no v2_mon_fee_scheduled alert announced (an adopted log, a lost state)
 *   pins         for every registered market and every creatable expiry E (weekday closes in [now + 1 h, now + 45 d]
 *                the Clearinghouse's calendar accepts, plus logged special expiries): SettlementOracle.pinnedBy(u, E)
 *                is 0 or the Clearinghouse, and an eth_call SettlementOracle.pin(u, E) from the Clearinghouse succeeds;
 *                for every expiry with series: pinnedBy likewise, and settlementConfig(u, E) plus the sources'
 *                pinnedFeeds / pinnedPools equal the registry's configuration (checked once: a pin never changes)
 *   feeds        Chainlink proxy aggregator() / owner() changes, accessController() set, the owner
 *                Safe's nonce / threshold / owners, a round moving more than 5 % from the previous one,
 *                the oracle's feed differing from the registry's, a feed silent for its heartbeat
 *                (feedHeartbeatS) plus 1 h of open 24/5 market or since the market reopened (feed stale)
 *   tokens       Stock Token paused(), oraclePaused(), UIMultiplierUpdated, a staged multiplier; and, for the LAUNCH
 *                tokens only (--launch, default NVDA,SPCX, addresses taken from the registry rows), the issuer's
 *                OraclePaused() / OracleUnpaused() LOGS (T-OP-083): a halt pages v2_mon_oracle_halted (error) from
 *                the event itself, so a halt that starts and ends between two polls of oraclePaused() is still
 *                seen, and the page clears itself on OracleUnpaused(). Same bounded scan as UIMultiplierUpdated.
 *                (newUIMultiplier != uiMultiplier), isBlocked for our contracts on the token's
 *                ACCESS_CONTROLLED_REGISTRY
 *   usdg         USDG paused(), isFrozen of our contracts
 *   pools        in-range liquidity below the registry's univ3MinLiquidity (the TWAP floor)
 *   divergence  calibrated per-market Chainlink versus pool TWAP band, while the 24/5 market is open
 *   manager      INTERFACE_VERSION 8. Every AccessManager log, one for one: an operation scheduled, executed or
 *                cancelled (with the function and role the published manifest gives its selector), and every role
 *                or target change — RoleGranted(uint64,…), RoleRevoked, RoleAdminChanged, RoleGuardianChanged,
 *                RoleGrantDelayChanged, TargetFunctionRoleUpdated, TargetAdminDelayUpdated, TargetClosed. These
 *                are NOT AccessControl's bytes32 events, which share three of those names and page under config.
 *                Then the manager's STATE against ops/abis/v2/roles.json: each role's admin and guardian, and each
 *                published holder's membership and execution delay
 *   safes        INTERFACE_VERSION 8. The protocol's own Admin and Treasury Safes: the change detector of `feeds`,
 *                plus an ABSOLUTE floor that needs no history — fewer than 2 signatures, or more than there are
 *                owners. A Safe that was already 1-of-3 before the monitor ever ran is the case a change detector
 *                can never see
 *   flywheel     INTERFACE_VERSION 8. The FeeSplitter: fees waiting with no Distributed, a run of DistributionSkipped
 *                with one reason (BELOW_FLOOR, NO_ROUTE, NO_SPOT, DUST), a buyback balance nothing is spending past
 *                the compiled cooldown, and a BoughtBack with no Burned in its transaction. Nothing here claims a
 *                burn or a split that has not happened: every statement comes from a log, never from a balance
 *   routes       INTERFACE_VERSION 8. Each market's PayoutRouter route against the registry's payoutRoute — venue,
 *                fee tier, v4 tick spacing, and a pinned v4 pool id recomputed from its own key. routes(address) is
 *                ONE selector (0xd7409659) with TWO return tuples, and the wrong one decodes without reverting, so
 *                the contract is identified before anything is decoded and a disagreement stops the check
 *   tokenpool    INTERFACE_VERSION 8. The STONKHOUSE v4 pool the buyback swaps in: hookless, inside
 *                MAX_HOOK_FEE_BPS, and an id that is what its own PoolKey hashes to
 *   tvl          INTERFACE_VERSION 8. USDG locked in the v2 contracts against the owner's external-audit trigger,
 *                at half and at the whole. Off until --threshold auditTriggerUsdg is set
 *   head         the L2 head timestamp more than 60 s behind the wall clock
 *   health       optional GET of each service's /health (--health name=url): cranker, mm-bot,
 *                pricer, pricing, notifier, indexer-v2, relay
 *   pricing      PRICEABILITY, which is not process health (F3 D6, O3-304). With --pricing: each market's chain
 *                on the pricing service's /health, each expiry it states on /surface/:ticker, and a bounded set of
 *                /fair probes on the live series the log scan already knows — daily expiries first, one market at
 *                a time, so a weekly pass can never crowd out or stand in for a failing daily. Per tenor, never
 *                aggregated. An expiry a live series settles on that the provider does not list at all is a
 *                failure of that tenor, not a silence. A reason code this build does not know counts as NOT ready
 *                (02-interfaces.md §5.1) and pages on its own. Source observation clocks (quote / underlying /
 *                volatility) are reported with their ages; an age this build cannot compute is UNKNOWN, never 0
 *                and never fresh (F3 D5), and pages only against an operator limit (--threshold quoteAgeS=…).
 *                A provider or method switch between two polls is an event of its own. With --pricer: the pricer's
 *                /state counters (ticks, the outcomes histogram) — a pricer that answers /health and evaluates
 *                nothing pages v2_mon_pricer_idle, which is a different page from v2_mon_service_down.
 *                NOT SERVED YET, so not checked: the indexer's /v2/config.services (X3-301) and the §5.1
 *                `provenance` object on /fair (X3-302). Without provenance the provider, the pricing method and
 *                the quote and volatility clocks are reported "not served", never inferred from the legacy
 *                `source` field, the file's own text timestamps or receipt time.
 *
 * Every alert goes to the relay as the keepers' payload ({ source, kind, severity, message, chainId,
 * at, data }, source "callhouse-monitor", kinds v2_mon_*) and is deduped in a JSON state file: a
 * condition pages once when it opens, again only when it escalates or every --repeat-hours (default 6)
 * while it stays open, and once more (v2_mon_resolved, info) when it clears. An event (a round jump, an
 * aggregator switch, an admin action) pages once. A failed delivery is retried on the next run.
 * ops/alerts.md "v2" has every kind with its first three checks; ops/runbooks/incident-v2.md the
 * responses.
 *
 *   node ops/v2/monitor.mjs --once --rpc $RH_RPC                         one pass, exit code (cron)
 *   node ops/v2/monitor.mjs --rpc $RH_RPC --interval 60                  loop (an always-on service)
 *   node ops/v2/monitor.mjs --once --rpc http://127.0.0.1:8546 --registry ops/devnet/tier1.devnet.json
 *   node ops/v2/monitor.mjs --once --rpc $RH_RPC --all-markets --no-alerts --json    read-only look
 *
 * Options (environment in brackets):
 *   --rpc URL               [RH_RPC] required. Reads only; nothing here signs or sends a transaction.
 *   --registry FILE         [MONITOR_REGISTRY, V2_REGISTRY_PATH] default ops/markets/tier1.json
 *   --state FILE            [MONITOR_STATE_PATH] default ops/v2/state/monitor-<chain>-<clearinghouse>.json
 *                           (gitignored). On Railway put it on the volume: /data/monitor-v2.json.
 *   --once                  one pass and exit; otherwise loop every --interval seconds [MONITOR_INTERVAL_S, 60]
 *   --webhook URL           [ALERT_WEBHOOK] the relay's /alert; the bearer token is read from
 *                           ALERT_WEBHOOK_TOKEN only, never from the command line. No webhook: alerts are
 *                           printed (LOG) and stay undelivered in the state file, so the first run with a
 *                           webhook sends them. Printing is not a delivery failure: the exit code is unchanged.
 *   --health NAME=URL       repeatable [MONITOR_HEALTH="cranker=http://…/health,notifier=…"]
 *   --pricing URL           [MONITOR_PRICING_URL] the pricing service's BASE url (not /health): read-only GETs of
 *                           /health, /surface/:ticker and /fair. Absent: the priceability half is skipped.
 *   --pricer URL            [MONITOR_PRICER_URL] the pricer's BASE url; its /state counters only. Absent: the
 *                           pricer-idle half is skipped. Neither flag can make either service act.
 *   --house TICKER=0xaddr   HouseVaults to watch for the SEC-14 boundary stall (repeatable, or a comma list;
 *                           MONITOR_HOUSE_VAULTS). They are factory-created per market, so the registry
 *                           names none of them and the check is skipped when none is given.
 *   --tickers A,B           limit the feed / token / pool checks to these markets
 *   --all-markets           include `planned` v2 markets in those checks (default: live and paused)
 *   --threshold NAME=VALUE  repeatable [MONITOR_THRESHOLDS="lateS=7200,…"]; names in DEFAULTS below
 *   --launch TICKERS        [MONITOR_LAUNCH_TICKERS] default NVDA,SPCX: the markets whose Stock Token halt LOGS page
 *                           v2_mon_oracle_halted (T-OP-083). Tickers only; the addresses come from the registry.
 *   --divergence-band TICKER=BPS repeatable [MONITOR_DIVERGENCE_BANDS="NVDA=220,…"]. No band:
 *                           check inactive. Supply only bands derived from 30 days of paired source prices;
 *                           1..299 bps keeps this alert inside the MM's 300 bps halt band.
 *   --repeat-hours H        reminder period for open conditions, 0 = never [MONITOR_REPEAT_S in seconds]
 *   --max-failed-passes N   [MONITOR_MAX_FAILED_PASSES, 3] loop mode only: after N consecutive passes that
 *                           reached nobody (a delivery the relay refused, or a pass that threw) exit with
 *                           that pass's code, so the platform restarts the service and notifies. A pass that
 *                           exits 3 but delivered its alert does not count. 0 loops for ever; --once ignores it.
 *   --no-alerts             evaluate and print only: send nothing, leave the state file untouched
 *   --json                  print the run report as JSON instead of text
 *
 * Exit codes (--once): 0 nothing open · 1 at least one warn/error finding open (new or already
 * paged) · 2 bad usage or configuration · 3 a check could not complete (RPC down, a read failed,
 * the log scan still catching up) · 4 an alert could not be delivered. The highest applicable
 * of 4 > 3 > 1 wins; 2 stops before any check.
 *
 * TIME. Protocol conditions use the head block's timestamp (a warped devnet is judged in its own
 * time); only the head-lag check and the dedupe bookkeeping use the wall clock.
 *
 * PINS RPC COST. Pin simulations cannot go through Multicall3 (it would be msg.sender, not the Clearinghouse), so
 * they are bounded instead: every expiry nobody pinned gives the same answer for a market (the oracle and the sources
 * read only their current configuration, allow-list and pointer for it), so ONE simulation per enabled market covers
 * them all, plus one per expiry pinned some other way (pinnedBy not 0 or the Clearinghouse, or a source pin log with no
 * oracle pin), at most PIN_SIMULATION_CONCURRENCY (4) at once. The views (Clearinghouse market rows and calendar,
 * isValidExpiry of ~33 closes, pinnedBy of markets x creatable expiries plus expiries with series, the pinned
 * configuration of expiries with series not verified yet) go through Multicall3 at PIN_MULTICALL_BYTES (65,536 bytes,
 * ~250 calls) per eth_call: 35 markets x 33 expiries is about 6 eth_calls. An expiry with series that matched the
 * registry once is never read again (state `pinsVerified`). The whole check is re-read at most every `pinCheckS`
 * (900 s) and served from the state file in between, unless the log scan saw a pin or wiring log (PINS_DIRTY_EVENTS)
 * or the creatable expiries, the expiries with series or the registry changed. So at 35 live markets a steady pass
 * costs no RPC, and a re-read about 45 eth_calls.
 *
 * INTERFACE_VERSION 8. Two things this file now depends on that are not the chain:
 *   - ops/abis/v2/roles.json, the role manifest the ABI export copies beside the ABIs. Role ids, names,
 *     execution delays, role admins, role guardians and the selector -> role map are READ from it, never
 *     transcribed here. If it cannot be read, roles page by id and the manager wiring check is skipped and
 *     says so: unknown, not empty.
 *   - the registry's v2.interfaceVersion, which decides which way the rent alert reads and which
 *     routes(address) tuple the payout contract has. A registry that publishes none leaves both unknown;
 *     neither is guessed.
 * THE ROUTES COLLISION is the sharpest ABI trap in the codebase: IPayoutRouter.routes(address) and
 * UniV3PayoutAdapter.routes(address) are the same selector 0xd7409659 with different return tuples, and
 * v2.contracts.payoutAdapter names the router from interface 8 and the adapter before it. Decoding one
 * with the other's shape SUCCEEDS and reads the venue enum as an address. The `routes` check therefore
 * identifies the contract first (only the adapter answers factory()) and refuses to decode on a
 * disagreement; monitor.test.mjs pins both the shared selector and the differing tuples.
 *
 * Node 22+. No dependency but viem, resolved from the keeper workspace package (createRequire), so a
 * repository checkout after `pnpm install` or the keeper image (/app/node_modules) both run it.
 * ------------------------------------------------------------------------------------------------- */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");
export const DEFAULT_REGISTRY = path.join(ROOT, "ops", "markets", "tier1.json");
export const DEFAULT_STATE_DIR = path.join(HERE, "state");
export const SOURCE = "callhouse-monitor";
export const STATE_VERSION = 1;

export const ZERO = "0x0000000000000000000000000000000000000000";
/** The relay's kind rule (relay/src/payload.ts): anything else is a 400 and never arrives. */
export const KIND_RE = /^[a-z][a-z0-9_]{0,63}$/;

/* ---- V2Constants.sol ---- */
export const SNAPSHOT_GRACE = 600;
export const RESOLVE_DELAY = 48 * 3600;
export const SETTLEMENT_STATUS = ["None", "Pending", "Finalized", "Held"];
export const MAX_LIVE_ORDERS_PER_SERIES = 16;
/** createSeries accepts expiries in [now + MIN_SERIES_LEAD, now + MAX_TENOR]. */
export const MIN_SERIES_LEAD = 3600;
export const MAX_TENOR = 45 * 86400;
/**
 * OrderBook.setFeeParams schedules a change this far ahead (effectiveAt = block.timestamp + FEE_CHANGE_DELAY).
 * INTERFACE_VERSION 8 raised it from 24 h to 48 h: `V2Constants.FEE_CHANGE_DELAY = 48 hours`. It is the OrderBook's
 * own compiled constant, NOT the manager's FEE_MANAGER execution delay — the two happen to be the same 48 h today
 * and a change to either must be read from its own source, never inferred from the other.
 */
export const FEE_CHANGE_DELAY = 172800;
/** PayoutRouter (v7: UniV3PayoutAdapter) refuses a pool fee tier (hundredths of a bip) above this. */
export const MAX_ROUTE_FEE_TIER = 10_000;
/** The most of a route's fee the Clearinghouse counts into a conversion floor, bps. `V2Constants.MAX_ROUTE_FEE_BPS`. */
export const MAX_ROUTE_FEE_BPS = 100;
/** INTERFACE_VERSION 7 (c05): the ceiling of MarketConfig.mintFeePpm, millionths of collateral per MINT_FEE_PERIOD. */
export const MINT_FEE_CEIL_PPM = 5_000;
/** INTERFACE_VERSION 7 (c05): rent is quoted per this much remaining life, seconds. */
export const MINT_FEE_PERIOD = 7 * 86400;

/* ---- V2Constants.sol, INTERFACE_VERSION 8 (callhouse-contracts branch v8). Re-derive on change; never re-reason. ---- */
/** FeeSplitter.buyback refuses a second buy inside this. `V2Constants.BUYBACK_COOLDOWN = 5 minutes`. */
export const BUYBACK_COOLDOWN = 300;
/**
 * T-OP-090. The most one `AutoRoller.reprice` may LOWER an ask, bps of the ask it replaces: `AutoRoller.MAX_REPRICE_DROP_BPS
 * = 2_500` (AutoRoller.sol:138, T-OP-063 / SEC-13). MIRRORED, not read: the ABI export at this base predates T-OP-063 and
 * has no getter for it; when `ops/abis/v2/AutoRoller.json` is re-exported this should become a one-time chain read. The
 * reprice alert measures every drop against this cap, which is the band a leaked PRICER key walks toward the floor in.
 */
export const MAX_REPRICE_DROP_BPS = 2_500;
/** The ceiling setBuybackCap accepts, USDG base units (1,000 USDG). `V2Constants.BUYBACK_CAP_CEIL`. */
export const BUYBACK_CAP_CEIL = 1_000_000_000n;
/** The most a fee-discount module may ever take off a taker fee. `V2Constants.MAX_DISCOUNT_BPS`. */
export const MAX_DISCOUNT_BPS = 5_000;
/** The most LP fee a hookless v4 pool may charge before the token pool stops being usable. `V2Constants.MAX_HOOK_FEE_BPS`. */
export const MAX_HOOK_FEE_BPS = 300;
/** IPayoutRouter.Venue as uint8: the route's venue, 0 = no route at all. */
export const ROUTE_VENUES = Object.freeze({ 0: "none", 1: "v3", 2: "v4" });
/** The v4 PoolKey the registry pins and the token pool use: hookless, so `hooks` is the zero address. */
export const V4_HOOKS = ZERO;
/**
 * INTERFACE_VERSION 8: rent is switched off and stays off. Every writer fee is the OrderBook's seller fee, so a
 * non-zero `MarketConfig.mintFeePpm` on chain or in the registry is the anomaly the rent checks now look for —
 * the v7 alert (rent MISSING) is inverted, not deleted, because the field and its ledger still exist.
 */
export const V8_MINT_FEE_PPM = 0;
/** INTERFACE_VERSION 7 (c21): MakerVault.OUTFLOW_WINDOW, the leaky bucket's refill period, seconds. */
export const OUTFLOW_WINDOW = 86400;

/* ---- the source constants RegisterMarkets configures every market with (callhouse-contracts script/v2) ---- */
/** ChainlinkFeedSource.DEFAULT_MAX_STALE (26 h) and DEFAULT_MAX_ROUND_JUMP_BPS. */
export const CHAINLINK_MAX_STALE = 26 * 3600;
export const CHAINLINK_MAX_ROUND_JUMP_BPS = 2000;
/** UniV3TwapSource.DEFAULT_WINDOW, seconds. */
export const UNIV3_WINDOW = 300;
/**
 * The registry's launch v2.defaults (keeper/src/v2/registry.ts SPEC_DEFAULTS), used when the registry has none.
 * spotMaxAgeS is the feeds' 24 h heartbeat plus 1 h (ops/deploy.md §15.13), not the contract's 1 h default.
 */
export const ORACLE_DEFAULTS = Object.freeze({ maxDeviationBps: 150, uncorroboratedDelayS: 21600, spotMaxAgeS: 90000 });
/** A registry market without feedHeartbeatS: the Robinhood Chain equity feeds' heartbeat, seconds. */
export const FEED_HEARTBEAT_S = 86400;

/** Revert selectors a Clearinghouse pin can meet (V2Errors, INTERFACE_VERSION 6). */
export const PIN_REVERTS = Object.freeze({
  "0xea8e4eb5": "NotAuthorized",
  "0x7d19c0ff": "NoSource",
  "0x52e8e6d6": "PinMismatch",
  "0xf54720df": "SourceNotPinned",
});
/** Calldata bytes per Multicall3 eth_call (viem's batchSize) in the pins check's bulk reads: about 250 calls each. */
export const PIN_MULTICALL_BYTES = 65_536;
/** Pin simulations (eth_call from the Clearinghouse; Multicall3 cannot keep msg.sender) sent at once. */
export const PIN_SIMULATION_CONCURRENCY = 4;

/**
 * keccak256 of the V2Constants role names (cast keccak <NAME>). INTERFACE_VERSION 8 moved every core role to the
 * AccessManager's uint64 ids, but AccessControl has NOT gone away: the contracts that have not migrated (the v7
 * payout adapter of a run-off deployment, RewardsDistributor, MakerRegistry) still emit
 * `RoleGranted(bytes32,address,address)`. This map names those; MANAGER_ROLES names the manager's.
 */
export const ROLE_NAMES = {
  "0x0000000000000000000000000000000000000000000000000000000000000000": "DEFAULT_ADMIN_ROLE",
  "0x55435dd261a4b9b3364963f7738a7a662ad9c84396d64be3365284bb7f0a5041": "GUARDIAN_ROLE",
  "0xc6823861ee2bb2198ce6b1fd6faf4c8f44f745bc804aca4a762f67e0d507fd8a": "PRICER_ROLE",
  "0x9a04aea0a349253cc7277afafdf6ead6729a3972a47ffb40eaef2c93d4e1bfea": "QUOTER_ROLE",
};

/** The role manifest the ABI export copies beside the ABIs; `script/v2/roles.v8.json` in the contracts repo. */
export const ROLES_FILE = path.join(ROOT, "ops", "abis", "v2", "roles.json");

/**
 * The manager's role manifest, READ from `ops/abis/v2/roles.json` rather than transcribed: ids, execution delays,
 * role admins, role guardians and the selector -> role map are all published there by `export-abis.sh`, and a copy
 * kept here would be a second source of truth that drifts silently.
 *
 * A missing or malformed file is UNKNOWN, never empty: `manifest` is null, every role still pages under the name
 * `role <id>`, and the caller reports the reason. A monitor that cannot name a role must still watch it.
 */
export function loadRoleManifest(file = ROLES_FILE) {
  let json;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { manifest: null, why: `${file}: ${shortError(error)}` };
  }
  if (json === null || typeof json !== "object" || json.roles === null || typeof json.roles !== "object") {
    return { manifest: null, why: `${file}: no roles object` };
  }
  const byId = new Map();
  for (const [name, id] of Object.entries(json.roles)) {
    if (!Number.isInteger(id) || id < 0) return { manifest: null, why: `${file}: role ${name} has id ${JSON.stringify(id)}` };
    if (byId.has(id)) return { manifest: null, why: `${file}: ids ${byId.get(id)} and ${name} are both ${id}` };
    byId.set(id, name);
  }
  return {
    manifest: {
      interfaceVersion: json.interfaceVersion ?? null,
      names: Object.fromEntries(byId),
      ids: { ...json.roles },
      delaysS: { ...(json.delaysS ?? {}) },
      roleAdmin: { ...(json.roleAdmin ?? {}) },
      roleGuardian: { ...(json.roleGuardian ?? {}) },
      holders: { ...(json.holders ?? {}) },
      targets: { ...(json.targets ?? {}) },
    },
    why: null,
  };
}

export const ROLE_MANIFEST = loadRoleManifest();

/** A manager role id as text. Unknown is named as unknown: an id the manifest does not carry is never silently "0". */
export function roleLabel(id, manifest = ROLE_MANIFEST.manifest) {
  const n = Number(id);
  const name = manifest?.names?.[n];
  return name === undefined ? `role ${n} (not in the manifest)` : `${name} (${n})`;
}

/** The manifest's execution delay for a role id, seconds; null when the manifest cannot say. */
export function roleDelayS(id, manifest = ROLE_MANIFEST.manifest) {
  const name = manifest?.names?.[Number(id)];
  if (name === undefined) return null;
  const d = manifest?.delaysS?.[name];
  return Number.isInteger(d) ? d : null;
}
export const ACTIONS = {
  SNAPSHOT: "0xa3548cb41722f35dc925d06d6a7fb44dc6b34b70c8f0e9d134b50f42698c822f",
  FINALIZE: "0x14d00b81931cb7dafec4a36b54eb00dd0a0bea1e838291d99ae988b8cec83ef5",
  SETTLE: "0x42e3283af0579cd1c1fcfe5f14d3188f10bda0c1f13be9b91c7157b02c760aed",
  REDEEM: "0xeba135a74248c737f901cbd8d0f53e729a3f212e734748c2e0d8d39096125e5c",
  ROLL: "0xa08b38e7ae4db51c941353eca31fa1ca88b67dc4a90f5b2e4faac6e4a7f51561",
  // INTERFACE_VERSION 7 (c16): AutoRoller.cancelStale pays it, at most once per rolled position per period.
  CANCEL_STALE: "0x7bf1982cc047ace888325e61ec5f1e6f173a1d0d7f3d38fc1a42c4776bd35d2b",
};

/** Thresholds; override with --threshold name=value or MONITOR_THRESHOLDS. Seconds unless named otherwise. */
export const DEFAULTS = Object.freeze({
  /** An expiry with open interest still not finalized this long after expiry. */
  lateS: 7200,
  /** A Pending candidate this long past finalizableAt: nobody called finalize. */
  overdueGraceS: 900,
  /** An expiry finalized on the oracle whose Clearinghouse series are still unsettled this long after expiry. */
  settleGraceS: 3600,
  /** Redeemable holders left this long after settlement. */
  backlogS: 21600,
  /** Page when the KeeperRewards balance covers fewer expiries than this. */
  rewardsMinExpiries: 20,
  /** Observed spend per expiry is averaged over the most recent this-many finalized expiries… */
  rewardsWindowExpiries: 20,
  /** …once at least this many are known; before that a model from the bounty table is used. */
  rewardsMinObserved: 3,
  /** The model: per expiry one SNAPSHOT, two FINALIZE, this many SETTLE, REDEEM and ROLL bounties. */
  modelSettlesPerExpiry: 10,
  modelRedeemsPerExpiry: 20,
  modelRollsPerExpiry: 0,
  /** MakerVault utilisation (units per series, total notional, live orders per series) that pages, percent. */
  vaultLimitPct: 90,
  /** MakerVault 24 h net USDG outflow used, as a percent of Limits.maxDailyOutflow: warn above, error above. */
  vaultOutflowWarnPct: 50,
  vaultOutflowErrorPct: 90,
  /** A tracked AutoRoller ask at or past its strike on an ok spot for this long, seconds: cancelStale is not running. */
  rollerStaleS: 60,
  /** MakerVault USDG available (wallet + Clearinghouse free ledger) below this, whole USDG. */
  vaultMinUsdg: 100,
  /** MakerVault Stock Token available below this, whole shares, per underlying it quotes. */
  vaultMinShares: 1,
  /**
   * A HouseVault epoch whose boundary is BLOCKED this long after epochEnd, seconds (SEC-14).
   * Not "the epoch is old": rollEpoch is permissionless, so an epoch past its end with nothing blocking it
   * is a crank that has not run yet, which is a different page. This one needs a refusal to exist.
   */
  houseEpochStallS: 1800,
  /** A Chainlink round moving more than this from the previous round, bps. */
  roundJumpBps: 500,
  /** A feed without a round for its heartbeat plus this much OPEN-market time is broken (v2_mon_feed_stale, error). */
  feedStaleMarginS: 3600,
  /** The 24/5 market reopened this long ago and a feed has not printed since (v2_mon_feed_stale, warn); 0 = never. */
  feedReopenGraceS: 900,
  /** Rounds read per feed per run when catching up. */
  maxRoundsPerRun: 24,
  /** Head timestamp behind the wall clock: warn above, error above. */
  lagWarnS: 60,
  lagErrorS: 900,
  /** Log ranges: first size, and how many per run. */
  logChunkBlocks: 10000,
  maxRangesPerRun: 200,
  /** First run of the Stock Token event scan: how far back (bounded below by the registry deploy block). */
  tokenLookbackBlocks: 100000,
  /**
   * T-OP-090. A reprice that lowers an ask by at least this fraction of the per-call cap (MAX_REPRICE_DROP_BPS) pages
   * v2_mon_reprice_floorward: 0.8 means a drop of 20 % or more of the ask in one call. 1 pages only a maximal step.
   */
  repricePageDropFraction: 0.8,
  /** T-OP-090. Ordinary reprices warn individually up to this many per run; the rest fold into one summary warn. */
  repriceWarnCap: 3,
  /** Event alerts are remembered (deduped) this long. */
  eventRetentionS: 30 * 86400,
  /** Series of a finished expiry are dropped from the state file this long after that expiry. */
  seriesRetentionS: 45 * 86400,
  /** An open pool_liquidity_low resolves only once liquidity is this far above the floor again, bps. */
  poolHysteresisBps: 1000,
  /** Chain reads the backlog check runs at once (a public RPC rate-limits a burst). */
  readConcurrency: 8,
  /** Resolved notices kept for the next run when the relay refuses them; past this they are dropped with a note. */
  maxPendingResolved: 500,
  /** Reminder period for an open condition; 0 = never. */
  repeatS: 21600,
  healthTimeoutMs: 5000,
  /** Deadline for one pricing-service or pricer read (/health, /surface/:ticker, /fair, /state). */
  pricingTimeoutMs: 8000,
  /** At most this many /fair probes per pass, spread daily-first and one market at a time; 0 = no per-series probe. */
  pricingProbes: 24,
  /** How many of those probes are in flight at once. */
  pricingConcurrency: 4,
  /** The pricer has evaluated no pair for this long (wall clock) while the 24/5 session is open; 0 = never page. */
  pricerIdleS: 900,
  /**
   * Operator limits on the SOURCE observation clocks (F3 D5), seconds; 0 = report the age, page on nothing. The
   * monitor invents no freshness bound: derive one from a measured session and set it, as with --divergence-band.
   * With a limit set, an UNKNOWN age fails it — an unknown age is not fresh (the delayed Cboe file states no
   * option quote time at all, so `quoteAgeS` set to anything pages for every market until a source supplies one).
   */
  quoteAgeS: 0,
  underlyingAgeS: 0,
  volatilityAgeS: 0,
  /**
   * The pins check re-reads the chain at most this often (wall-clock seconds) unless this run's log scan saw a pin or
   * wiring log (any log of the oracle, a source or the calendar; a Clearinghouse market or calendar change), the
   * creatable expiries or the series expiries changed, or the registry did. Between recomputes its findings are served
   * from the state file.
   */
  pinCheckS: 900,
  /* ---- INTERFACE_VERSION 8 ---- */
  /**
   * The splitter holds a converted balance and nothing distributes it: seconds since the last Distributed with
   * fees sitting there. 0 = never page. Fees arrive when a take settles, so a quiet market is not late; the check
   * only counts from the FeesSwept / Distributed evidence it actually saw.
   */
  splitterIdleS: 86400,
  /** Consecutive BELOW_FLOOR skips for one asset before the conversion floor is treated as unreachable. */
  splitterFloorMisses: 3,
  /**
   * The buyback balance has been above the per-call cap, with the cooldown long over, for this long and no
   * BoughtBack: the BUYBACK role is not being cranked. 0 = never page.
   */
  buybackStuckS: 21600,
  /** The token pool's usable depth floor, USDG base units; 0 = report the depth and page on nothing. */
  tokenPoolMinDepth: 0,
  /**
   * Total value locked, USDG base units, that triggers the owner's external audit (V3-D33: $1M). The monitor pages
   * at half of it and again at it. 0 = off, and it is OFF by default for the same reason --divergence-band is: the
   * number is not the uncertain part, the DEFINITION is. "Value locked" here is the USDG the protocol's own
   * contracts hold, which is a choice this task made and no owner decision pins; shipping it on would page against
   * that choice rather than against the owner's. The production env sets
   * `--threshold auditTriggerUsdg=1000000000000` (see ops/alerts.md §V61), and the launch verification pass should
   * confirm both the figure and what it counts.
   */
  auditTriggerUsdg: 0,
  /**
   * How old the chain head may be before a TVL reading is a FAULT rather than a number, in seconds.
   * There was no staleness concept here at all: a monitor reading balances at a head an hour behind
   * would compare a stale total against the trigger and page LATE, and for an alert whose premise is
   * that nobody is watching the number, late and never are the same outcome. Mirrors MAX_TVL_AGE_S in
   * ops/v8/tvl-threshold.mjs, and monitor.test.mjs binds the two so they cannot drift apart.
   */
  tvlMaxAgeS: 3600,
});

/* ---------------------------------------------------------------------------------------------- */
/*  kinds                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

const AL = "ops/alerts.md";
const IR = "ops/runbooks/incident-v2.md";

/**
 * Every kind this script sends: default severity, whether it is an event (pages once, never resolves)
 * and where to go. A finding may raise or lower its own severity (checks say when).
 */
export const KINDS = Object.freeze({
  v2_mon_settlement_late: { severity: "error", runbook: `${AL} §V20; ${IR} §2` },
  v2_mon_sources_disagree: { severity: "warn", runbook: `${AL} §V21; ${IR} §1` },
  v2_mon_settlement_held: { severity: "error", runbook: `${AL} §V22; ${IR} §1, §2` },
  v2_mon_series_unsettled: { severity: "error", runbook: `${AL} §V20a; ${IR} §2` },
  v2_mon_snapshot_missed: { severity: "warn", event: true, runbook: `${AL} §V23; ${IR} §2` },
  v2_mon_redeem_backlog: { severity: "warn", runbook: `${AL} §V24; ${IR} §2` },
  v2_mon_rewards_budget_low: { severity: "warn", runbook: `${AL} §V25` },
  v2_mon_rewards_cap: { severity: "warn", runbook: `${AL} §V25` },
  v2_mon_vault_limit: { severity: "warn", runbook: `${AL} §V26; ${IR} §4` },
  v2_mon_vault_inventory_low: { severity: "warn", runbook: `${AL} §V26` },
  v2_mon_vault_outflow: { severity: "warn", runbook: `${AL} §V45; ${IR} §4c` },
  v2_mon_config_changed: { severity: "warn", event: true, runbook: `${AL} §V27; ${IR} §5` },
  v2_mon_feed_mismatch: { severity: "error", runbook: `${AL} §V28; ${IR} §5` },
  v2_mon_feed_aggregator_changed: { severity: "warn", event: true, runbook: `${AL} §V28; ${IR} §1` },
  v2_mon_feed_access_controller: { severity: "error", runbook: `${AL} §V28; ${IR} §2` },
  v2_mon_feed_owner_changed: { severity: "warn", event: true, runbook: `${AL} §V28` },
  v2_mon_safe_nonce_changed: { severity: "info", event: true, runbook: `${AL} §V28` },
  v2_mon_safe_config_changed: { severity: "warn", event: true, runbook: `${AL} §V28` },
  v2_mon_protocol_safe_nonce_changed: { severity: "info", event: true, runbook: `${AL} §V55; ${IR} §5` },
  v2_mon_protocol_safe_config_changed: { severity: "error", event: true, runbook: `${AL} §V55; ${IR} §5` },
  v2_mon_feed_round_jump: { severity: "warn", event: true, runbook: `${AL} §V29; ${IR} §1` },
  v2_mon_feed_stale: { severity: "error", runbook: `${AL} §V44; ${IR} §7` },
  v2_mon_price_divergence: { severity: "warn", runbook: `${AL} §V48; ${IR} §7` },
  v2_mon_token_paused: { severity: "error", runbook: `${AL} §V30; ${IR} §6` },
  v2_mon_oracle_paused: { severity: "warn", runbook: `${AL} §V30; ${IR} §2` },
  v2_mon_oracle_halted: { severity: "error", runbook: `${AL} §V30a; ${IR} §2` },
  v2_mon_multiplier_updated: { severity: "warn", event: true, runbook: `${AL} §V31; ${IR} §1` },
  v2_mon_multiplier_staged: { severity: "warn", runbook: `${AL} §V31; ${IR} §1` },
  v2_mon_token_blocked: { severity: "error", runbook: `${AL} §V32; ${IR} §6` },
  v2_mon_usdg_paused: { severity: "error", runbook: `${AL} §V33; ${IR} §6` },
  v2_mon_usdg_frozen: { severity: "error", runbook: `${AL} §V33; ${IR} §6` },
  v2_mon_pool_liquidity_low: { severity: "warn", runbook: `${AL} §V34; ${IR} §3` },
  v2_mon_pool_wiring: { severity: "error", runbook: `${AL} §V34a; ${IR} §3, §5` },
  v2_mon_l2_lag: { severity: "warn", runbook: `${AL} §V35; ops/runbooks/incident.md §7` },
  v2_mon_service_down: { severity: "error", runbook: `${AL} §V36` },
  v2_mon_service_degraded: { severity: "warn", runbook: `${AL} §V36` },
  v2_mon_check_failed: { severity: "warn", runbook: `${AL} §V37` },
  v2_mon_state_unwritable: { severity: "error", runbook: `${AL} §V37a` },
  v2_mon_resolved: { severity: "info", runbook: `${AL} §V37` },
  v2_mon_fee_scheduled: { severity: "warn", event: true, runbook: `${AL} §V38; ${IR} §5b` },
  v2_mon_fee_change_pending: { severity: "warn", runbook: `${AL} §V38; ${IR} §5b` },
  v2_mon_route_changed: { severity: "warn", event: true, runbook: `${AL} §V39; ${IR} §3, §5` },
  v2_mon_oracle_allowlist: { severity: "error", event: true, runbook: `${AL} §V40; ${IR} §5a` },
  v2_mon_oracle_clearinghouse: { severity: "error", event: true, runbook: `${AL} §V40; ${IR} §5a` },
  v2_mon_pre_pin: { severity: "error", event: true, runbook: `${AL} §V41; ${IR} §5a` },
  v2_mon_data_streams_feed: { severity: "error", event: true, runbook: `${AL} §V42; ${IR} §5` },
  v2_mon_pin_blocked: { severity: "error", runbook: `${AL} §V43; ${IR} §5a` },
  v2_mon_pinned_by: { severity: "error", runbook: `${AL} §V43; ${IR} §5a` },
  v2_mon_pin_mismatch: { severity: "error", runbook: `${AL} §V43; ${IR} §5, §5a` },
  // INTERFACE_VERSION 7
  v2_mon_roller_ask_overtaken: { severity: "error", runbook: `${AL} §V46; ${IR} §8` },
  // T-OP-090. AutoRoller.Repriced: the PRICER lane moving a writer's ask. Two pages and a rate-capped warn.
  v2_mon_reprice_floorward: { severity: "error", event: true, runbook: `${AL} §V62; ${IR} §5` },
  v2_mon_reprice_foreign_sender: { severity: "error", event: true, runbook: `${AL} §V62; ${IR} §5` },
  v2_mon_repriced: { severity: "warn", event: true, runbook: `${AL} §V62` },
  v2_mon_mint_rent: { severity: "error", runbook: `${AL} §V47; ${IR} §9` },
  v2_mon_mint_fee_zero: { severity: "error", runbook: `${AL} §V47; ${IR} §9` },
  // F3 O3-304: priceability, NOT process health. §V36 stays the up/down page; these say what the inputs are worth.
  v2_mon_quote_unready: { severity: "warn", runbook: `${AL} §V49; ${IR} §10` },
  v2_mon_pricing_reason_unknown: { severity: "warn", runbook: `${AL} §V49; ${IR} §10` },
  v2_mon_source_age: { severity: "warn", runbook: `${AL} §V50; ${IR} §10` },
  v2_mon_source_switch: { severity: "warn", event: true, runbook: `${AL} §V50; ${IR} §10` },
  v2_mon_pricer_idle: { severity: "warn", runbook: `${AL} §V51; ${IR} §10` },
  // INTERFACE_VERSION 8: the AccessManager, the Safes, the flywheel, v4 routes and the inverted rent alert.
  v2_mon_manager_operation: { severity: "error", event: true, runbook: `${AL} §V52; ${IR} §5` },
  v2_mon_manager_role: { severity: "error", event: true, runbook: `${AL} §V53; ${IR} §5` },
  v2_mon_manager_wiring: { severity: "error", runbook: `${AL} §V54; ${IR} §5` },
  v2_mon_safe_threshold: { severity: "error", runbook: `${AL} §V55; ${IR} §5` },
  v2_mon_splitter_idle: { severity: "warn", runbook: `${AL} §V56; ${IR} §3` },
  v2_mon_splitter_floor_miss: { severity: "error", runbook: `${AL} §V56; ${IR} §3` },
  v2_mon_buyback_stuck: { severity: "warn", runbook: `${AL} §V57` },
  v2_mon_buyback_skipped: { severity: "error", runbook: `${AL} §V57` },
  v2_mon_buyback_unburned: { severity: "error", runbook: `${AL} §V57` },
  v2_mon_route_wiring: { severity: "error", runbook: `${AL} §V58; ${IR} §3, §5` },
  v2_mon_route_decode: { severity: "error", runbook: `${AL} §V58; ${IR} §3` },
  v2_mon_mint_fee_charged: { severity: "error", runbook: `${AL} §V59; ${IR} §9` },
  v2_mon_token_pool_fee: { severity: "error", runbook: `${AL} §V60` },
  v2_mon_token_pool_depth: { severity: "warn", runbook: `${AL} §V60` },
  v2_mon_tvl_audit_trigger: { severity: "warn", runbook: `${AL} §V61` },
  // SEC-14. §V62 does not exist in ops/runbooks/alerts.md yet: that file is outside this row's fence and
  // the entry is a follow-up. The MESSAGE therefore carries the recovery itself, because a page whose
  // runbook section is missing is a page the on-call cannot act on.
  v2_mon_house_epoch_stall: { severity: "error", runbook: `${AL} §V62; ${IR} §4` },
});

export const RANK = Object.freeze({ info: 0, warn: 1, error: 2 });

export class UsageError extends Error {}

/** A finding: one condition or event, identified by kind + key. `check` names the check that owns it. */
export function finding(kind, key, check, message, data = {}, options = {}) {
  const spec = KINDS[kind];
  if (spec === undefined) throw new Error(`unknown monitor kind ${kind}`);
  const severity = options.severity ?? spec.severity;
  if (RANK[severity] === undefined) throw new Error(`bad severity ${severity}`);
  return { kind, key: String(key), check, severity, event: options.event ?? spec.event === true, message, data };
}

/* ---------------------------------------------------------------------------------------------- */
/*  formatting                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

const lc = (a) => String(a).toLowerCase();
export const sameAddress = (a, b) => a != null && b != null && lc(a) === lc(b);
export const shortAddr = (a) => (typeof a === "string" && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a));

/** A fixed-point bigint as a decimal string with `dp` digits (rounded down). */
export function fixed(raw, decimals, dp) {
  const v = BigInt(raw);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").slice(0, dp);
  return `${neg ? "-" : ""}${whole}${dp > 0 ? `.${frac.padEnd(dp, "0")}` : ""}`;
}
export const usdg = (raw) => fixed(raw, 6, 2);
/** 0.01-share units as shares. */
export const sharesOf = (units) => fixed(units, 2, 2);
export const iso = (ts) => new Date(Number(ts) * 1000).toISOString().replace(".000Z", "Z");
export function duration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds)));
  if (s < 120) return `${s} s`;
  if (s < 7200) return `${Math.floor(s / 60)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
}
export const bigintReplacer = (_key, value) => (typeof value === "bigint" ? value.toString() : value);

/* ---------------------------------------------------------------------------------------------- */
/*  pure checks: settlement                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/**
 * One (underlying, expiry) of one oracle, read at the head.
 *   x = { oracle, underlying, ticker, expiry, now, openInterest: bigint, status: "None"|"Pending"|"Finalized"|"Held",
 *         candidate: { price: bigint, sourceIndex, disagreed, finalizableAt } | null,
 *         sources: address[] (captured list once captured, else the market's configured list),
 *         univ3Source: address | null, snapshotRecordedAt: number | null (null = not read) }
 *
 * LATE (settlement not finalized lateS after expiry) is judged by what the delay means:
 *   status None                         error: no candidate at all (no source prices the window, or nobody calls finalize)
 *   Pending past finalizableAt + grace  error: finalizable and nobody called finalize (cranker down)
 *   Pending, 2+ sources, not disagreed  warn: corroboration failed; the candidate finalizes at finalizableAt unless vetoed
 *   Pending, one source                 nothing: a single-source market waits out its delay by design
 * Held and disagreeing expiries page as their own kinds, not as late.
 */
export function checkExpiry(x, t = DEFAULTS) {
  const out = [];
  if (x.now < x.expiry || x.openInterest === 0n || x.status === "Finalized") return out;
  const key = `${lc(x.underlying)}:${x.expiry}`;
  const label = `${x.ticker} expiry ${iso(x.expiry)}`;
  const age = x.now - x.expiry;
  const c = x.candidate;
  const candidate = c === null ? null : { price: c.price, sourceIndex: c.sourceIndex, disagreed: c.disagreed, finalizableAt: c.finalizableAt };
  const base = {
    ticker: x.ticker,
    underlying: x.underlying,
    expiry: x.expiry,
    oracle: x.oracle,
    status: x.status,
    openInterest: x.openInterest,
    secondsSinceExpiry: age,
    sources: x.sources,
    candidate,
  };

  if (x.status === "Held") {
    out.push(
      finding(
        "v2_mon_settlement_held",
        key,
        "settlement",
        `${label} is HELD (vetoed) ${duration(age)} after expiry: it settles only if two sources corroborate, on unveto, or by adminResolve from ${iso(x.expiry + RESOLVE_DELAY)}`,
        { ...base, resolvableAt: x.expiry + RESOLVE_DELAY },
      ),
    );
  }

  if (x.status === "Pending" && c !== null && c.disagreed) {
    out.push(
      finding(
        "v2_mon_sources_disagree",
        `${key}:${c.finalizableAt}`,
        "settlement",
        `${label}: the sources disagree; candidate ${usdg(c.price)} USDG from source ${c.sourceIndex} finalizes at ${iso(c.finalizableAt)} (in ${duration(c.finalizableAt - x.now)}) unless the guardian vetoes it`,
        base,
      ),
    );
  }

  const poolListed = x.univ3Source !== null && x.sources.some((s) => sameAddress(s, x.univ3Source));
  if (poolListed && x.now > x.expiry + SNAPSHOT_GRACE && x.snapshotRecordedAt === 0) {
    out.push(
      finding(
        "v2_mon_snapshot_missed",
        key,
        "settlement",
        `${label}: no pool snapshot inside [expiry, expiry + ${SNAPSHOT_GRACE} s]; the pool cannot vote, so this expiry settles on the other sources alone, after the market's delay`,
        { ...base, univ3Source: x.univ3Source },
      ),
    );
  }

  if (age >= t.lateS && x.status !== "Held") {
    if (x.status === "None" || (x.status === "Pending" && c === null)) {
      out.push(
        finding(
          "v2_mon_settlement_late",
          key,
          "settlement",
          `${label} is not finalized ${duration(age)} after expiry and has no candidate: no source prices the window, or nobody called finalize`,
          base,
          { severity: "error" },
        ),
      );
    } else if (x.status === "Pending") {
      if (x.now >= c.finalizableAt + t.overdueGraceS) {
        out.push(
          finding(
            "v2_mon_settlement_late",
            key,
            "settlement",
            `${label} has been finalizable since ${iso(c.finalizableAt)} (${duration(x.now - c.finalizableAt)}) and is still Pending: nobody called finalize`,
            base,
            { severity: "error" },
          ),
        );
      } else if (!c.disagreed && x.sources.length >= 2) {
        out.push(
          finding(
            "v2_mon_settlement_late",
            key,
            "settlement",
            `${label} is not corroborated ${duration(age)} after expiry: candidate ${usdg(c.price)} USDG from source ${c.sourceIndex} of ${x.sources.length} finalizes at ${iso(c.finalizableAt)} unless vetoed; compare it with an independent close`,
            base,
            { severity: "warn" },
          ),
        );
      }
    }
  }
  return out;
}

/**
 * An expiry the oracle has finalized whose Clearinghouse series are not all settled. Nothing else sees this:
 * the settlement check treats Finalized as the end of the expiry, and the redeem backlog only counts series
 * that emitted `SeriesSettled`. Until someone calls `settle(longId)` every holder's `redeem` reverts
 * `NotSettled`, so the expiry is finished on the oracle and frozen for its holders.
 *   x = { ticker, underlying, oracle, expiry, now, openInterest, unsettled: string[] longIds, seriesCount }
 */
export function checkUnsettledSeries(x, t = DEFAULTS) {
  if (x.openInterest === 0n || x.unsettled.length === 0 || x.now - x.expiry < t.settleGraceS) return [];
  const age = x.now - x.expiry;
  return [
    finding(
      "v2_mon_series_unsettled",
      `${lc(x.underlying)}:${x.expiry}`,
      "settlement",
      `${x.ticker} expiry ${iso(x.expiry)} is finalized on the oracle but ${x.unsettled.length} of ${x.seriesCount} series ${x.unsettled.length === 1 ? "is" : "are"} still unsettled on the Clearinghouse ${duration(age)} after expiry, with open interest ${x.openInterest}: every redeem of those series reverts NotSettled until someone calls settle(longId)`,
      { ticker: x.ticker, underlying: x.underlying, expiry: x.expiry, oracle: x.oracle, openInterest: x.openInterest, secondsSinceExpiry: age, unsettled: x.unsettled, seriesCount: x.seriesCount },
      { severity: "error" },
    ),
  ];
}

/**
 * A settled series, `backlogS` or more after settlement.
 *   x = { longId, ticker, isPut, strike, expiry, settledAt, now,
 *         long: { perUnit, holders, units }, short: { perUnit, holders, units },
 *         bookUnits, optedOut }
 * holders/units count only holders the cranker can redeem: a non-zero balance, third-party redemption
 * allowed, a non-zero payout per unit on that side. The book's escrow counts separately: the book opts
 * out of third-party redemption, so a long it still escrows means prune did not run.
 */
export function checkBacklog(x, t = DEFAULTS) {
  if (x.settledAt === null || x.now - x.settledAt < t.backlogS) return [];
  const holders = x.long.holders + x.short.holders;
  if (holders === 0 && x.bookUnits === 0n) return [];
  const label = `${x.ticker} ${x.isPut ? "put" : "call"} ${usdg(x.strike)} ${iso(x.expiry)}`;
  const parts = [];
  if (holders > 0) {
    parts.push(
      `${x.long.holders} long and ${x.short.holders} short holder(s) (${sharesOf(x.long.units)} long, ${sharesOf(x.short.units)} short shares) are still unredeemed`,
    );
  }
  if (x.bookUnits > 0n) parts.push(`the OrderBook still escrows ${sharesOf(x.bookUnits)} long shares (prune before redeem)`);
  return [
    finding("v2_mon_redeem_backlog", x.longId, "backlog", `${label}: ${parts.join("; ")} ${duration(x.now - x.settledAt)} after settlement`, {
      longId: x.longId,
      ticker: x.ticker,
      expiry: x.expiry,
      settledAt: x.settledAt,
      long: x.long,
      short: x.short,
      bookUnits: x.bookUnits,
      optedOut: x.optedOut,
    }),
  ];
}

/* ---------------------------------------------------------------------------------------------- */
/*  pure checks: rewards, vault                                                                    */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Observed bounty spend per finalized expiry: the most recent `window` SettlementFinalized /
 * SettlementResolved blocks, and every Rewarded amount from the oldest of them on.
 *   rewards: { "<block>:<logIndex>": "<amount>" }, finalized: { "<underlying>:<expiry>": "<block>" }
 */
export function observedSpend(rewards, finalized, window) {
  const blocks = Object.values(finalized)
    .map((b) => BigInt(b))
    .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0))
    .slice(0, window);
  if (blocks.length === 0) return { spend: 0n, expiries: 0, fromBlock: null };
  const fromBlock = blocks[blocks.length - 1];
  let spend = 0n;
  for (const [id, amount] of Object.entries(rewards)) {
    if (BigInt(id.split(":")[0]) >= fromBlock) spend += BigInt(amount);
  }
  return { spend, expiries: blocks.length, fromBlock };
}

export function modelSpendPerExpiry(bounties, t = DEFAULTS) {
  const b = (name) => BigInt(bounties[name] ?? 0n);
  // INTERFACE_VERSION 7 (c16): a rolled position can be cancelled once per period, and only one ask per position
  // exists, so the worst case is one CANCEL_STALE per ROLL.
  return (
    b("SNAPSHOT") +
    2n * b("FINALIZE") +
    BigInt(t.modelSettlesPerExpiry) * b("SETTLE") +
    BigInt(t.modelRedeemsPerExpiry) * b("REDEEM") +
    BigInt(t.modelRollsPerExpiry) * (b("ROLL") + b("CANCEL_STALE"))
  );
}

/**
 *   x = { address, balance, dailyCap, spentToday, bounties: { SNAPSHOT, FINALIZE, SETTLE, REDEEM, ROLL }, observed: { spend, expiries } }
 * Returns { findings, perExpiry, runway (expiries, or null when nothing is paid), basis }.
 */
export function checkRewards(x, t = DEFAULTS) {
  const findings = [];
  const model = modelSpendPerExpiry(x.bounties, t);
  const useObserved = x.observed.expiries >= t.rewardsMinObserved && x.observed.spend > 0n;
  const perExpiry = useObserved ? (x.observed.spend + BigInt(x.observed.expiries) - 1n) / BigInt(x.observed.expiries) : model;
  const basis = useObserved ? `observed over the last ${x.observed.expiries} finalized expiries` : "the bounty table (no spend history yet)";
  const runway = perExpiry === 0n ? null : x.balance / perExpiry;
  if (runway !== null && runway < BigInt(t.rewardsMinExpiries)) {
    findings.push(
      finding(
        "v2_mon_rewards_budget_low",
        lc(x.address),
        "rewards",
        `KeeperRewards holds ${usdg(x.balance)} USDG, about ${runway} expiries of bounties at ${usdg(perExpiry)} USDG per expiry (${basis}); fund it before it reaches 0 (fewer than ${t.rewardsMinExpiries})`,
        { address: x.address, balance: x.balance, perExpiry, runwayExpiries: runway, basis, model },
      ),
    );
  }
  const anyBounty = Object.values(x.bounties).some((v) => BigInt(v) > 0n);
  if (anyBounty && x.dailyCap === 0n) {
    findings.push(
      finding("v2_mon_rewards_cap", `${lc(x.address)}:cap-zero`, "rewards", "KeeperRewards dailyCap() is 0: no bounty is paid until the admin sets it", {
        address: x.address,
        dailyCap: x.dailyCap,
      }),
    );
  } else if (x.dailyCap > 0n && x.spentToday >= x.dailyCap) {
    findings.push(
      finding(
        "v2_mon_rewards_cap",
        `${lc(x.address)}:cap-reached`,
        "rewards",
        `KeeperRewards spent ${usdg(x.spentToday)} of its ${usdg(x.dailyCap)} USDG rolling daily cap: bounties pay nothing until capacity returns (24-30 h after each payment)`,
        { address: x.address, dailyCap: x.dailyCap, spentToday: x.spentToday },
      ),
    );
  }
  return { findings, perExpiry, runway, basis };
}

const atLeastPct = (value, limit, pct) => limit > 0n && value * 100n >= limit * BigInt(pct);

/**
 * INTERFACE_VERSION 7 (c21): the MakerVault's 24 h net USDG outflow bucket. `outflow()` reports what the quoter has
 * spent net since the bucket last emptied and what is left before `place(Bid)`, `replace(Bid)` and `take` revert
 * `OutflowCapExceeded`; the bucket refills linearly over OUTFLOW_WINDOW. Three conditions, one kind:
 *   cap 0            warn: a deliberate spend freeze (the §4c kill switch). Asks, sales, cancels, closes and ledger
 *                    moves still work, so nothing else shows it; it pages so nobody leaves it on by accident.
 *   used >= 50 %     warn: the bot is spending unusually fast, or something else holds the quoter key.
 *   used >= 90 %     error: bids and buying takes are about to revert; quoting goes one-sided.
 * Only the last condition needs the operator now, but all three are the same number, so one key keeps the dedupe
 * honest: the alert escalates from warn to error as the bucket fills instead of paging twice.
 */
export function checkVaultOutflow(x, t = DEFAULTS) {
  if (x.outflow === null || x.outflow === undefined) return [];
  const cap = BigInt(x.limits.maxDailyOutflow ?? 0n);
  const used = BigInt(x.outflow.used);
  const available = BigInt(x.outflow.available);
  const v = lc(x.address);
  if (cap === 0n) {
    return [
      finding(
        "v2_mon_vault_outflow",
        `${v}:frozen`,
        "vault",
        `MakerVault Limits.maxDailyOutflow is 0: every quoter bid, buying take and replace-up reverts OutflowCapExceeded. Asks, sales, cancels, closes and ledger moves still work, so this is the spend freeze of incident-v2.md §4c, not an outage. If nobody meant to freeze spending, restore the cap with setLimits (all SIX fields)`,
        { address: x.address, cap, used, available },
      ),
    ];
  }
  if (!atLeastPct(used, cap, t.vaultOutflowWarnPct)) return [];
  const pctUsed = (used * 100n) / cap;
  const error = atLeastPct(used, cap, t.vaultOutflowErrorPct);
  return [
    finding(
      "v2_mon_vault_outflow",
      `${v}:outflow`,
      "vault",
      `MakerVault has paid out ${usdg(used)} USDG net through quoter calls, ${pctUsed}% of its ${usdg(cap)} USDG 24 h cap (${usdg(available)} left${error ? "; bids and buying takes revert OutflowCapExceeded once it is gone" : ""}). The bucket refills over ${duration(OUTFLOW_WINDOW)}. Compare it with the mm-bot's own /state: if the bot did not spend it, the quoter key is not only ours — revoke QUOTER_ROLE (incident-v2.md §4c)`,
      { address: x.address, cap, used, available, percentUsed: Number(pctUsed) },
      { severity: error ? "error" : "warn" },
    ),
  ];
}

/**
 * SEC-14, the HouseVault epoch stall. `rollEpoch` is PERMISSIONLESS and refuses in three ways
 * (HouseVault.sol:539-546): TooEarly before `epochEnd`; NotSettled while `_requireFlat` (:701-711) finds a
 * tracked series still unsettled or still holding longs, shorts or a live order; and NotSettled while the
 * boundary settlement price is not Finalized. A blocked boundary emits NOTHING -- there is no failed-roll
 * event, because the roll is never sent -- so the vault simply sits past its epoch end with deposits and
 * withdrawals queued behind it, and the recovery is a QUOTER-role `cancel`/`close`/`sync`
 * (HouseVault.sol:844, :891, :902), which for an idle quoter means the 2-of-3 admin Safe.
 *
 * WHAT THIS DOES NOT FIRE ON, deliberately. Not epoch age: an epoch that is merely long is healthy, and a
 * vault that is past `epochEnd` with nothing blocking it is a crank that has not run yet (its own page).
 * This fires only when a REFUSAL exists -- the same three conditions the contract checks, read rather than
 * guessed -- because a monitor that pages on every long epoch is muted within a week.
 *
 *   x = { address, ticker, epochId, epochEnd, now,
 *         boundary: { finalized, price } | null (null = the price could not be read),
 *         series: [{ longId, label, exists, settled, longs, shorts, live }] }
 */
export function checkHouseEpoch(x, t = DEFAULTS) {
  const overdue = x.now - x.epochEnd;
  if (overdue < t.houseEpochStallS) return [];
  const blockers = [];
  for (const s of x.series) {
    if (s.exists && !s.settled) blockers.push(`${s.label} is not settled`);
    const held = [];
    if (s.longs !== 0n) held.push(`${sharesOf(s.longs)} long`);
    if (s.shorts !== 0n) held.push(`${sharesOf(s.shorts)} short`);
    if (s.live !== 0) held.push(`${s.live} live order${s.live === 1 ? "" : "s"}`);
    if (held.length !== 0) blockers.push(`${s.label} still holds ${held.join(", ")}`);
  }
  // A boundary price that could not be READ is not a boundary price that is missing: say so and stop,
  // rather than page for a condition this pass did not observe.
  if (x.boundary !== null && !x.boundary.finalized) {
    blockers.push(`the ${iso(x.epochEnd)} settlement price is not Finalized`);
  }
  if (blockers.length === 0) return [];
  const where = `${x.ticker} HouseVault ${shortAddr(x.address)}`;
  return [
    finding(
      "v2_mon_house_epoch_stall",
      `${lc(x.address)}:${x.epochId}`,
      "house",
      `${where} epoch ${x.epochId} ended ${duration(overdue)} ago and rollEpoch still reverts NotSettled: ${blockers.join("; ")}. Deposits and withdrawals queued for this boundary are stuck behind it. RECOVERY: cancel the live orders and close or settle the exposure with the QUOTER role (HouseVault.cancel / close / sync); anyone may call Clearinghouse.settle and OrderBook.prune for an expired series, which is the cheapest half. If the quoter is not answering, this is a 2-of-3 admin Safe action, so start that signature round now rather than after the next page.`,
      {
        address: x.address,
        ticker: x.ticker,
        epochId: String(x.epochId),
        epochEnd: x.epochEnd,
        overdueS: overdue,
        blockers,
        boundaryFinalized: x.boundary === null ? null : x.boundary.finalized,
        trackedSeries: x.series.length,
      },
    ),
  ];
}

/**
 *   x = { address, limits: { maxSeriesUnits, maxTotalNotional, maxDailyOutflow }, totalNotional,
 *         series: [{ longId, label, units, live }], usdgAvailable, tokens: [{ ticker, token, available }],
 *         outflow: { used, available } | null (INTERFACE_VERSION 7; null = not read) }
 */
export function checkVault(x, t = DEFAULTS) {
  const out = [];
  const v = lc(x.address);
  const pct = t.vaultLimitPct;
  out.push(...checkVaultOutflow(x, t));
  if (atLeastPct(x.totalNotional, x.limits.maxTotalNotional, pct)) {
    out.push(
      finding(
        "v2_mon_vault_limit",
        `${v}:total`,
        "vault",
        `MakerVault total notional ${usdg(x.totalNotional)} USDG is at ${(x.totalNotional * 100n) / x.limits.maxTotalNotional}% of maxTotalNotional ${usdg(x.limits.maxTotalNotional)}: quotes that grow exposure start reverting CeilingExceeded`,
        { address: x.address, totalNotional: x.totalNotional, maxTotalNotional: x.limits.maxTotalNotional },
      ),
    );
  }
  const liveCap = Math.ceil((MAX_LIVE_ORDERS_PER_SERIES * pct) / 100);
  for (const s of x.series) {
    if (atLeastPct(s.units, x.limits.maxSeriesUnits, pct)) {
      out.push(
        finding(
          "v2_mon_vault_limit",
          `${v}:units:${s.longId}`,
          "vault",
          `MakerVault exposure on ${s.label} is ${sharesOf(s.units)} shares, ${(s.units * 100n) / x.limits.maxSeriesUnits}% of maxSeriesUnits (${sharesOf(x.limits.maxSeriesUnits)})`,
          { address: x.address, longId: s.longId, units: s.units, maxSeriesUnits: x.limits.maxSeriesUnits },
        ),
      );
    }
    if (s.live >= liveCap) {
      out.push(
        finding(
          "v2_mon_vault_limit",
          `${v}:orders:${s.longId}`,
          "vault",
          `MakerVault has ${s.live} live orders on ${s.label} (the contract allows ${MAX_LIVE_ORDERS_PER_SERIES})`,
          { address: x.address, longId: s.longId, live: s.live },
        ),
      );
    }
  }
  const minUsdg = BigInt(t.vaultMinUsdg) * 10n ** 6n;
  if (x.usdgAvailable < minUsdg) {
    out.push(
      finding(
        "v2_mon_vault_inventory_low",
        `${v}:usdg`,
        "vault",
        `MakerVault has ${usdg(x.usdgAvailable)} USDG available (wallet + free Clearinghouse ledger), under ${t.vaultMinUsdg}: bids and put quotes stop`,
        { address: x.address, available: x.usdgAvailable, floor: minUsdg },
      ),
    );
  }
  const minWei = BigInt(t.vaultMinShares) * 10n ** 18n;
  for (const tk of x.tokens) {
    if (tk.available < minWei) {
      out.push(
        finding(
          "v2_mon_vault_inventory_low",
          `${v}:token:${lc(tk.token)}`,
          "vault",
          `MakerVault has ${fixed(tk.available, 18, 4)} ${tk.ticker} available (wallet + free Clearinghouse ledger) on a market it quotes, under ${t.vaultMinShares}: call asks stop`,
          { address: x.address, ticker: tk.ticker, token: tk.token, available: tk.available, floor: minWei },
        ),
      );
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/*  pure checks: INTERFACE_VERSION 7 (c05 rent, c16 stale asks)                                    */
/* ---------------------------------------------------------------------------------------------- */

/** AutoRoller._overtaken: the spot has reached the strike, so the ask can be taken at or below intrinsic value. */
export const overtaken = (isPut, strike, spot) => (isPut ? BigInt(spot) <= BigInt(strike) : BigInt(spot) >= BigInt(strike));

/**
 * INTERFACE_VERSION 7 (c16): one tracked AutoRoller position at the head. `cancelStale` is permissionless and the
 * cranker calls it every tick, so a live roll-time ask whose market has reached the strike should disappear within
 * seconds. One that does not is the pre-v7 hole still open: anyone can buy it below intrinsic value at the writer's
 * expense.
 *
 *   x = { autoRoller, writer, underlying, ticker, longId, orderId, isPut, strike, expiry, remaining,
 *         spotOk, spot, spotUpdatedAt -- the trySpot of THIS SERIES' pinned oracle (T-437), the one cancelStale
 *           reads on chain and the one the series settles on, never the market's pointer or the published oracle,
 *         delegate (false = the writer revoked the roller: nobody can cancel),
 *         since (head time this ask was first seen overtaken, or null), now }
 *
 * Returns { findings, stale } — `stale` says whether the caller should keep (or start) the timer. The delay is
 * deliberate: a print that crosses the strike between the cranker's tick and this pass is normal.
 */
export function checkRollerAsk(x, t = DEFAULTS) {
  if (!x.spotOk || !overtaken(x.isPut, x.strike, x.spot)) return { findings: [], stale: false };
  const since = x.since ?? x.now;
  if (x.now - since < t.rollerStaleS) return { findings: [], stale: true, since };
  const revoked = x.delegate === false;
  return {
    stale: true,
    since,
    findings: [
      finding(
        "v2_mon_roller_ask_overtaken",
        `${lc(x.writer)}:${lc(x.underlying)}`,
        "roller",
        `AutoRoller ask ${x.orderId} for ${shortAddr(x.writer)} on ${x.ticker} (${x.isPut ? "put" : "call"} ${usdg(x.strike)}, ${sharesOf(x.remaining)} shares left, expiry ${iso(x.expiry)}) has been at or past its strike for ${duration(x.now - since)}: spot ${usdg(x.spot)} at ${iso(x.spotUpdatedAt)}. It sells below intrinsic value to whoever takes it first. ${
          revoked
            ? "The writer revoked the roller's OrderBook delegate, so cancelStale reverts NotAuthorized and nobody but the writer can withdraw it: this is the writer's own position to fix"
            : "cancelStale(writer, underlying) is permissionless and the cranker runs it every tick — check that the cranker is up and that its stale step is not erroring"
        }`,
        {
          autoRoller: x.autoRoller,
          writer: x.writer,
          underlying: x.underlying,
          ticker: x.ticker,
          longId: String(x.longId),
          orderId: String(x.orderId),
          isPut: x.isPut,
          strike: x.strike,
          spot: x.spot,
          spotUpdatedAt: x.spotUpdatedAt,
          remaining: x.remaining,
          expiry: x.expiry,
          sinceS: x.now - since,
          delegate: x.delegate,
        },
        { severity: revoked ? "warn" : "error" },
      ),
    ],
  };
}

/**
 * INTERFACE_VERSION 7 (c05): the rent ledger of one series, from the Clearinghouse's own logs. Rent moves in exactly
 * three places — `Minted.fee` in, `Closed.feeRefund` out, `MintFeesAccrued.amount` to the treasury at settlement — so
 * the logs of a series the scan has followed since its `SeriesCreated` are the expectation, with no chain read and no
 * arithmetic of our own to drift from the contract's.
 *
 *   x = { longId, label, ppm (pinned at creation), marketPpm (the market's rate now, null = unknown),
 *         paid, refunded, accrued (bigint), mints, zeroFeeMints, settled, complete,
 *         interfaceVersion (the registry's; null = unknown, and then only the v7 reading applies) }
 *
 * `complete` = the scan saw the series created, so the sums are the whole life. Without it nothing is judged: a
 * partial ledger is not evidence.
 */
export function checkMintRent(x) {
  if (!x.complete) return [];
  const out = [];
  const held = BigInt(x.paid) - BigInt(x.refunded);
  if (x.settled && BigInt(x.accrued) !== held) {
    out.push(
      finding(
        "v2_mon_mint_rent",
        `${x.longId}:accrual`,
        "rent",
        `${x.label} settled having accrued ${x.accrued} base units of writer rent, but its logs charged ${x.paid} and refunded ${x.refunded} (expected ${held}). Every base unit of rent moves through Minted.fee, Closed.feeRefund and MintFeesAccrued, so the three cannot disagree unless the monitor is decoding a different Clearinghouse than it thinks (a v6 ABI against a v7 deployment reads these fields as absent) or the ledger is wrong`,
        { longId: x.longId, paid: x.paid, refunded: x.refunded, accrued: x.accrued, expected: held, mintFeePpm: x.ppm },
      ),
    );
  }
  // INTERFACE_VERSION 8 INVERTS THIS CHECK. Rent is switched off and stays off, so the anomaly is a series that
  // charges it, not one that does not. The rate is pinned at creation and never changes, so a single such series
  // charges its writer for its whole life and no later setting fixes it.
  if (x.interfaceVersion !== null && x.interfaceVersion !== undefined && Number(x.interfaceVersion) >= 8) {
    if (x.ppm > V8_MINT_FEE_PPM) {
      out.push(
        finding(
          "v2_mon_mint_fee_charged",
          `${x.longId}:series`,
          "rent",
          `${x.label} is pinned at ${x.ppm} ppm of collateral per ${duration(MINT_FEE_PERIOD)} of writer rent, and INTERFACE_VERSION 8 charges no rent at all (the seller fee replaced it). A series' rate is pinned at creation and never changes, so every unit written into this one is charged for its whole life; only new series would pick up a corrected market rate. ${x.paid} base units have been charged so far`,
          { longId: x.longId, mintFeePpm: x.ppm, paid: x.paid, refunded: x.refunded, interfaceVersion: Number(x.interfaceVersion) },
        ),
      );
    }
    return out;
  }
  if (x.ppm > 0 && x.zeroFeeMints > 0) {
    out.push(
      finding(
        "v2_mon_mint_rent",
        `${x.longId}:free-mint`,
        "rent",
        `${x.label} is pinned at ${x.ppm} ppm of collateral per ${duration(MINT_FEE_PERIOD)}, and ${x.zeroFeeMints} of its ${x.mints} mints charged no rent at all. mint() rounds the charge UP, so a non-zero rate on a series with time left cannot produce a zero fee: writers are getting collateral for free`,
        { longId: x.longId, mintFeePpm: x.ppm, mints: x.mints, zeroFeeMints: x.zeroFeeMints, paid: x.paid },
      ),
    );
  }
  if (x.ppm === 0 && x.marketPpm !== null && x.marketPpm > 0 && !x.settled) {
    out.push(
      finding(
        "v2_mon_mint_rent",
        `${x.longId}:zero-rate`,
        "rent",
        `${x.label} was created when its market charged no writer rent and keeps 0 ppm until it expires, while the market now charges ${x.marketPpm} ppm. A series' rate is pinned at creation and never changes, so every unit written into this one is free; only new series pick the rate up`,
        { longId: x.longId, mintFeePpm: x.ppm, marketMintFeePpm: x.marketPpm },
        { severity: "warn" },
      ),
    );
  }
  return out;
}

/**
 * INTERFACE_VERSION 7 (c05): the runtime twin of the deploy blocker (DECISIONS-2026-09-17 §11). UNDER v7,
 * and only under v7, `premiumFeeBps` was 0 at launch, so rent was the only writer fee there was: a live market
 * whose `MarketConfig.mintFeePpm` is 0 charged writers nothing — and the series it creates keep that rate for
 * their whole life. THIS IS NOT TODAY'S VALUE. v8 launches `premiumFeeBps` at 500 — 5 % of the premium on first
 * sale (`callhouse-contracts` `script/v2/fixtures/registry-v8.json:140`, asserted in
 * `test/v2/unit/DeployV2Preflight.t.sol:227` "v8: 5% of the premium on first sale"), and
 * `script/v2/DeployV2Batch.sh:325` refuses a non-zero `mintFeePpm` on a v8 broadcast outright. Read the
 * sentence above as history for the frozen v7 run-off registry, never as the fee a v8 writer pays.
 *
 *   x = { ticker, underlying, enabled, chainPpm (null = the market row was not read), registryPpm (null = the
 *         registry publishes none for it), interfaceVersion (the registry's; null = unknown), allowRent }
 *
 * INTERFACE_VERSION 8 inverts it: rent is gone, so a non-zero rate is the alert. See the branch below.
 */
export function checkMintFee(x) {
  const out = [];
  const u = lc(x.underlying);
  // INTERFACE_VERSION 8: THE ALERT IS INVERTED. v7 paged because a market charged NO rent (rent was the only
  // writer fee there was). v8 replaced rent with the OrderBook's 5 % seller fee and switched rent off, so the
  // alert fires when rent IS charged. The v7 branch below is kept, not deleted, because the monitor also runs
  // against the frozen v7 registry for the run-off deployment (ops/markets/v7-legacy.json) — which is why this
  // reads the registry's interface version rather than assuming one.
  if (x.interfaceVersion !== null && x.interfaceVersion !== undefined && Number(x.interfaceVersion) >= 8) {
    if (x.chainPpm !== null && x.chainPpm > V8_MINT_FEE_PPM) {
      out.push(
        finding(
          "v2_mon_mint_fee_charged",
          `${u}:chain`,
          "rent",
          `${x.ticker} is registered on the Clearinghouse with mintFeePpm ${x.chainPpm}, and INTERFACE_VERSION 8 charges no writer rent: the writer fee is the OrderBook's seller fee on the first sale. Every series created while this is non-zero is PINNED at that rate for its whole life, so the longer it stands the more series carry it. setMarketFees(underlying, exerciseFeeBps, 0) is the MARKET_FEE_MANAGER lane (72 h), so a fix is not instant${x.enabled ? "" : " (this market is not enabled yet, so no series can be created at this rate until it is)"}`,
          { ticker: x.ticker, underlying: x.underlying, chainPpm: x.chainPpm, registryPpm: x.registryPpm, interfaceVersion: Number(x.interfaceVersion) },
          { severity: x.enabled ? "error" : "warn" },
        ),
      );
    }
    if (x.registryPpm !== null && x.registryPpm > V8_MINT_FEE_PPM) {
      out.push(
        finding(
          "v2_mon_mint_fee_charged",
          `${u}:registry`,
          "rent",
          `${x.ticker} publishes writer rent of ${x.registryPpm} ppm in the registry the monitor is running against (markets[].v2.mintFeePpm, falling back to v2.fees.mintFeePpm) while it declares interfaceVersion 8, which charges none${x.allowRent ? " — and v2.fees.allowRent is true, so the registry gate let it through on purpose" : ". build-markets.mjs --check refuses this; a registry the monitor sees but that gate never saw is how it gets here"}. A deploy or a re-registration from this registry would charge rent on chain`,
          { ticker: x.ticker, underlying: x.underlying, chainPpm: x.chainPpm, registryPpm: x.registryPpm, allowRent: x.allowRent === true },
        ),
      );
    }
    return out;
  }
  if (x.enabled && x.chainPpm === 0) {
    out.push(
      finding(
        "v2_mon_mint_fee_zero",
        `${u}:chain`,
        "rent",
        `${x.ticker} is enabled on the Clearinghouse with mintFeePpm 0: with the primary premium fee at 0 this market charges writers nothing, and every series created while it stays 0 is free for its whole life. setMarketConfig with the registry's rate (${x.registryPpm === null ? "the registry publishes none either" : `${x.registryPpm} ppm`}); it reaches series created afterwards only`,
        { ticker: x.ticker, underlying: x.underlying, chainPpm: x.chainPpm, registryPpm: x.registryPpm },
      ),
    );
  }
  if (x.registryPpm === null || x.registryPpm === 0) {
    out.push(
      finding(
        "v2_mon_mint_fee_zero",
        `${u}:registry`,
        "rent",
        `${x.ticker} has no writer rent in ops/markets/tier1.json (markets[].v2.mintFeePpm, falling back to v2.fees.mintFeePpm): a deploy or a re-registration from this registry would charge its writers nothing. Confirm the owner-approved market rate and re-run build-markets.mjs --check`,
        { ticker: x.ticker, underlying: x.underlying, chainPpm: x.chainPpm, registryPpm: x.registryPpm },
      ),
    );
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/*  pure checks: feeds                                                                             */
/* ---------------------------------------------------------------------------------------------- */

export function checkFeedMismatch(x) {
  if (x.sourceFeed === null || x.registryFeed === null || sameAddress(x.sourceFeed, x.registryFeed)) return [];
  return [
    finding(
      "v2_mon_feed_mismatch",
      lc(x.underlying),
      "feeds",
      `${x.ticker}: ChainlinkFeedSource prices from ${x.sourceFeed}, the registry names ${x.registryFeed}: setFeed changed it; if nobody planned that, the admin key chose this market's settlement feed`,
      x,
    ),
  ];
}

/**
 * A Chainlink proxy against its baseline. `prev` = { aggregator, owner, lastRoundId } from the state,
 * or undefined on first sight, when the registry's recorded feedAggregator (if any) is the baseline.
 *   cur = { aggregator, accessController, owner } (null = not readable)
 */
export function checkFeedProxy(prev, cur, ctx) {
  const findings = [];
  const feed = lc(ctx.feed);
  const expected = prev?.aggregator ?? ctx.registryAggregator ?? null;
  if (cur.aggregator !== null && expected !== null && !sameAddress(expected, cur.aggregator)) {
    const from = prev?.aggregator ? expected : `${expected} (the registry's feedAggregator)`;
    findings.push(
      finding(
        "v2_mon_feed_aggregator_changed",
        `${feed}:${lc(cur.aggregator)}`,
        "feeds",
        `${ctx.ticker} feed ${ctx.feed}: aggregator() changed from ${from} to ${cur.aggregator}, a new phase. A Chainlink walk never crosses a phase: a settlement window that straddles the switch has no Chainlink price`,
        { ticker: ctx.ticker, feed: ctx.feed, from: expected, to: cur.aggregator },
      ),
    );
  }
  if (cur.accessController !== null && !sameAddress(cur.accessController, ZERO)) {
    findings.push(
      finding(
        "v2_mon_feed_access_controller",
        feed,
        "feeds",
        `${ctx.ticker} feed ${ctx.feed}: accessController() is ${cur.accessController}, not zero: the feed owner can now refuse reads, and a refused read is no Chainlink price and no spot`,
        { ticker: ctx.ticker, feed: ctx.feed, accessController: cur.accessController },
      ),
    );
  }
  if (prev?.owner && cur.owner !== null && !sameAddress(prev.owner, cur.owner)) {
    findings.push(
      finding(
        "v2_mon_feed_owner_changed",
        `${feed}:${lc(cur.owner)}`,
        "feeds",
        `${ctx.ticker} feed ${ctx.feed}: owner() changed from ${prev.owner} to ${cur.owner}`,
        { ticker: ctx.ticker, feed: ctx.feed, from: prev.owner, to: cur.owner },
      ),
    );
  }
  return {
    findings,
    baseline: {
      aggregator: cur.aggregator ?? prev?.aggregator ?? null,
      owner: cur.owner ?? prev?.owner ?? null,
      lastRoundId: prev?.lastRoundId ?? null,
    },
  };
}

/**
 * A Safe this monitor watches: the Chainlink feed owner Safe, and from INTERFACE_VERSION 8 the protocol's own
 * Admin and Treasury Safes. `cur` = { nonce: bigint, threshold: bigint, owners: address[] }.
 *   ctx = { safe, feeds: string[] (what this Safe controls), label ("Feed owner Safe" when absent),
 *           protocol: true for one of OUR Safes }
 *
 * `protocol` decides the KIND, not just the wording. A third-party feed owner Safe and our own Admin Safe are
 * different alerts with different runbooks: routing ours through the feed kinds sent the operator to §V28 with a
 * body reading "Usually another feed", for a change to the multisig that controls this protocol. The label alone
 * could not fix that, because the group and the runbook come from the kind.
 *
 * This is a CHANGE detector and only a change detector: with no baseline it says nothing, which is right for a
 * third-party Safe whose correct threshold we do not publish, and is not enough for our own. checkSafeThreshold
 * is the absolute floor that fires with no history.
 */
export function checkSafe(prev, cur, ctx) {
  const findings = [];
  const safe = lc(ctx.safe);
  const ours = ctx.protocol === true;
  const label = ctx.label ?? "Feed owner Safe";
  const group = ours ? "config" : "feeds";
  const controls = (ctx.feeds ?? []).length > 0 ? ` (${ctx.feeds.join(", ")})` : "";
  const owners = [...cur.owners].map(lc).sort();
  const next = { nonce: cur.nonce.toString(), threshold: cur.threshold.toString(), owners };
  if (prev !== undefined) {
    if (prev.nonce !== next.nonce) {
      findings.push(
        finding(
          ours ? "v2_mon_protocol_safe_nonce_changed" : "v2_mon_safe_nonce_changed",
          `${safe}:${next.nonce}`,
          group,
          ours
            ? `${label} ${ctx.safe} executed a transaction: nonce ${prev.nonce} -> ${next.nonce}. This is OUR multisig, so whatever it did is an admin action on this protocol: the AccessManager and config checks say what landed, and if nobody owns it, treat the Safe's signers as compromised`
            : `${label} ${ctx.safe}${controls} executed a transaction: nonce ${prev.nonce} -> ${next.nonce}. Usually another feed; the aggregator and access-controller checks say whether ours changed`,
          { safe: ctx.safe, from: prev.nonce, to: next.nonce, feeds: ctx.feeds, protocol: ours },
        ),
      );
    }
    if (prev.threshold !== next.threshold || prev.owners.join(",") !== owners.join(",")) {
      findings.push(
        finding(
          ours ? "v2_mon_protocol_safe_config_changed" : "v2_mon_safe_config_changed",
          `${safe}:${next.threshold}:${owners.join(",")}`,
          group,
          ours
            ? `${label} ${ctx.safe}: threshold ${prev.threshold} of ${prev.owners.length} -> ${next.threshold} of ${owners.length} owners. Changing who signs for this protocol, or how many of them are needed, is not a routine operation: it should match a decision somebody can name`
            : `${label} ${ctx.safe}: threshold ${prev.threshold} of ${prev.owners.length} -> ${next.threshold} of ${owners.length} owners`,
          { safe: ctx.safe, from: { threshold: prev.threshold, owners: prev.owners }, to: next, protocol: ours },
        ),
      );
    }
  }
  return { findings, baseline: next };
}

const ROUND_MASK = (1n << 64n) - 1n;

/**
 * Round ids to read, ascending, for the jump check: the new rounds since `lastSeenId` in the latest
 * phase plus the one before them (at most `max` + 1), or just [latest-1, latest] on first sight. A
 * phase change starts over inside the new phase (rounds never compare across phases).
 *
 * When more than `max` rounds arrived since the last run, the OLDEST are read, not the newest: the caller
 * only advances its baseline to the last id returned here, so the rest are read next run. Reading the newest
 * instead would step over the middle for ever, and a bad print there would never be compared.
 */
export function roundIdsToRead(latestId, lastSeenId, max) {
  const latest = BigInt(latestId);
  const phase = latest >> 64n;
  const agg = latest & ROUND_MASK;
  let from = agg - 1n;
  if (lastSeenId !== null && lastSeenId !== undefined) {
    const seen = BigInt(lastSeenId);
    const seenAgg = seen & ROUND_MASK;
    if (seen >> 64n === phase) from = seenAgg < agg ? seenAgg : agg;
  }
  if (from < 1n) from = 1n;
  const to = agg - from > BigInt(max) ? from + BigInt(max) : agg;
  const ids = [];
  for (let a = from; a <= to; a += 1n) ids.push((phase << 64n) | a);
  return ids;
}

/** rounds: ascending [{ id, answer, updatedAt }] (answer null = unreadable). One event per jumping round. */
export function checkRoundJumps(rounds, ctx, t = DEFAULTS) {
  const out = [];
  for (let i = 1; i < rounds.length; i += 1) {
    const prev = rounds[i - 1];
    const cur = rounds[i];
    if (prev.answer === null || cur.answer === null || prev.answer <= 0n || cur.answer <= 0n) continue;
    if (cur.id !== prev.id + 1n) continue;
    const diff = cur.answer > prev.answer ? cur.answer - prev.answer : prev.answer - cur.answer;
    const bps = (diff * 10_000n) / prev.answer;
    if (bps <= BigInt(t.roundJumpBps)) continue;
    const dec = ctx.decimals ?? 8;
    out.push(
      finding(
        "v2_mon_feed_round_jump",
        `${lc(ctx.feed)}:${cur.id}`,
        "feeds",
        `${ctx.ticker} feed round ${cur.id & ROUND_MASK} moved ${fixed(bps, 2, 2)}% from the previous round (${fixed(prev.answer, dec, 2)} -> ${fixed(cur.answer, dec, 2)}) at ${iso(cur.updatedAt)}: a split or multiplier step, or a bad print; compare with an independent price before any settlement window that uses it`,
        { ticker: ctx.ticker, feed: ctx.feed, roundId: cur.id, previous: prev.answer, answer: cur.answer, bps, updatedAt: cur.updatedAt },
      ),
    );
  }
  return out;
}

/**
 * A feed's latest round against its heartbeat. The Robinhood Chain equity feeds print on a feedThresholdPct move or
 * every feedHeartbeatS while the 24/5 market is open, never over a weekend or a full NYSE holiday, so the age that
 * says "broken" is OPEN-market time (openMarketSeconds), not wall time. SettlementOracle.spotMaxAge (25 h) is not the
 * limit here: a feed can break long before spot() notices, and spot() is stale every weekend while nothing is wrong.
 *   error  more than heartbeat + feedStaleMarginS of open market without a round (2026-08-03..09-17, 35 feeds: the
 *          longest open-market gap was 24 h 30 s): the feed missed its heartbeat. spot() reverts once the round is
 *          spotMaxAge old; a settlement window has no Chainlink price once its round in force is maxStale (26 h) old.
 *   warn   the market reopened (Sunday or a holiday's 20:00 New York) more than feedReopenGraceS ago and the feed has
 *          not printed since. Every feed printed within a minute of every reopen in that window; without that print the
 *          round in force is Friday's, and spot() stays stale into the regular session.
 *   x = { ticker, feed, now, roundId, updatedAt, heartbeatS }   (updatedAt 0 = no round)
 */
export function checkFeedStale(x, t = DEFAULTS) {
  const updatedAt = Number(x.updatedAt);
  const now = Number(x.now);
  if (!(updatedAt > 0) || updatedAt > now) return [];
  const key = lc(x.feed);
  const heartbeatS = Number(x.heartbeatS ?? FEED_HEARTBEAT_S);
  const openAgeS = openMarketSeconds(updatedAt, now);
  const limitS = heartbeatS + t.feedStaleMarginS;
  const data = { ticker: x.ticker, feed: x.feed, roundId: x.roundId, updatedAt, ageS: now - updatedAt, openAgeS, heartbeatS, limitS };
  if (openAgeS > limitS) {
    return [
      finding(
        "v2_mon_feed_stale",
        key,
        "feeds",
        `${x.ticker} feed ${x.feed}: no round for ${duration(openAgeS)} of open market (last ${iso(updatedAt)}, ${duration(now - updatedAt)} ago), past its ${duration(heartbeatS)} heartbeat + ${duration(t.feedStaleMarginS)}: the feed is broken or stalled. spot() reverts StaleSpot (rolls, vault quotes and reprices stop) and settlement windows starting 26 h after that round have no Chainlink price`,
        data,
      ),
    ];
  }
  if (t.feedReopenGraceS > 0) {
    const m = marketStretch(now);
    if (m.open && updatedAt < m.reopenedAt && now - m.reopenedAt > t.feedReopenGraceS) {
      return [
        finding(
          "v2_mon_feed_stale",
          key,
          "feeds",
          `${x.ticker} feed ${x.feed}: the 24/5 market reopened at ${iso(m.reopenedAt)} and the feed has not printed since (last round ${iso(updatedAt)}, ${duration(now - updatedAt)} ago; every feed prints within a minute of a reopen). The round in force is from before the closure: spot() stays stale until the feed prints`,
          { ...data, reopenedAt: m.reopenedAt },
          { severity: "warn" },
        ),
      ];
    }
  }
  return [];
}

/** Paired, healthy source prices at one pinned head. One breach warns; a second distinct pass escalates. */
export function checkPriceDivergence(x, previous = null) {
  const { ticker, underlying, chainlinkSource, poolSource, feedPrice, poolPrice, bandBps, head } = x;
  if (feedPrice <= 0n || poolPrice <= 0n) return { findings: [], streak: null };
  const gap = feedPrice > poolPrice ? feedPrice - poolPrice : poolPrice - feedPrice;
  const gapBps = Number((gap * 10_000n) / feedPrice);
  if (gap * 10_000n <= feedPrice * BigInt(bandBps)) return { findings: [], streak: null };
  const count = previous !== null && previous.head !== String(head) ? Math.min(previous.count + 1, 2) : (previous?.count ?? 1);
  return {
    streak: { head: String(head), count },
    findings: [finding(
      "v2_mon_price_divergence", lc(underlying), "divergence",
      `${ticker}: Chainlink ${usdg(feedPrice)} and pool TWAP ${usdg(poolPrice)} differ by ${gapBps} bps, past the calibrated ${bandBps} bps band${count >= 2 ? " for two passes" : ""}. Check the feed round against an independent market price before pausing writes`,
      { ticker, underlying, chainlinkSource, poolSource, feedPrice, poolPrice, gapBps, bandBps, passes: count },
      { severity: count >= 2 ? "error" : "warn" },
    )],
  };
}

/* ---------------------------------------------------------------------------------------------- */
/*  pure checks: Stock Tokens, USDG, pools, head, services                                         */
/* ---------------------------------------------------------------------------------------------- */

/**
 *   x = { ticker, token, now, paused, oraclePaused (null = no such function), uiMultiplier, newUIMultiplier,
 *         effectiveAt (null = unreadable), blocked: [{ name, address, blocked }] }
 */
export function checkStockToken(x) {
  const out = [];
  const tk = lc(x.token);
  if (x.paused === true) {
    out.push(
      finding("v2_mon_token_paused", tk, "tokens", `${x.ticker} Stock Token paused() is true: deposits, withdrawals, in-kind payouts and conversions of ${x.ticker} stop; redemptions credit the ledger`, {
        ticker: x.ticker,
        token: x.token,
      }),
    );
  }
  if (x.oraclePaused === true) {
    out.push(
      finding(
        "v2_mon_oracle_paused",
        tk,
        "tokens",
        `${x.ticker} oraclePaused() is true: the Chainlink source and spot fail closed (rolls and vault quoting stop; a settlement captured now rests on the pool alone as a delayed candidate)`,
        { ticker: x.ticker, token: x.token },
      ),
    );
  }
  if (x.uiMultiplier !== null && x.newUIMultiplier !== null && x.newUIMultiplier !== 0n && x.newUIMultiplier !== x.uiMultiplier) {
    const direction = x.newUIMultiplier < x.uiMultiplier ? "DOWN" : "up";
    const when = x.effectiveAt === null ? "at an unknown time" : x.effectiveAt > x.now ? `at ${iso(x.effectiveAt)} (in ${duration(x.effectiveAt - x.now)})` : `since ${iso(x.effectiveAt)}`;
    out.push(
      finding(
        "v2_mon_multiplier_staged",
        `${tk}:${x.newUIMultiplier}:${x.effectiveAt ?? "?"}`,
        "tokens",
        `${x.ticker} has a staged multiplier step ${direction}: uiMultiplier ${fixed(x.uiMultiplier, 18, 6)} -> newUIMultiplier ${fixed(x.newUIMultiplier, 18, 6)} ${when}. The feed can lag the step by its heartbeat; watch the settlement windows around it`,
        { ticker: x.ticker, token: x.token, uiMultiplier: x.uiMultiplier, newUIMultiplier: x.newUIMultiplier, effectiveAt: x.effectiveAt },
      ),
    );
  }
  for (const b of x.blocked) {
    if (b.blocked !== true) continue;
    out.push(
      finding(
        "v2_mon_token_blocked",
        `${tk}:${lc(b.address)}`,
        "tokens",
        `${x.ticker} access registry isBlocked(${b.name} ${b.address}) is true: ${b.name} can neither send nor receive ${x.ticker}`,
        { ticker: x.ticker, token: x.token, contract: b.name, address: b.address },
        { severity: b.name === "clearinghouse" ? "error" : "warn" },
      ),
    );
  }
  return out;
}

/** UIMultiplierUpdated logs: [{ ticker, token, oldMultiplier, newMultiplier, effectiveAt, blockNumber, transactionHash, logIndex }]. */
export function multiplierEventFindings(events) {
  return events.map((e) =>
    finding(
      "v2_mon_multiplier_updated",
      `${lc(e.transactionHash)}:${e.logIndex}`,
      "tokens",
      `${e.ticker} UIMultiplierUpdated ${fixed(e.oldMultiplier, 18, 6)} -> ${fixed(e.newMultiplier, 18, 6)} effective ${iso(e.effectiveAt)} (block ${e.blockNumber})${e.newMultiplier < e.oldMultiplier ? ": a DECREASE" : ""}`,
      { ticker: e.ticker, token: e.token, oldMultiplier: e.oldMultiplier, newMultiplier: e.newMultiplier, effectiveAt: e.effectiveAt, blockNumber: e.blockNumber, transactionHash: e.transactionHash },
      { severity: e.newMultiplier < e.oldMultiplier ? "error" : "warn" },
    ),
  );
}

/** Contracts whose USDG freeze pages as error (collateral and escrow); the rest warn. */
export const USDG_CRITICAL = new Set(["clearinghouse", "orderBook"]);

/** x = { usdg, paused, frozen: [{ name, address, frozen }] } */
export function checkUsdg(x) {
  const out = [];
  if (x.paused === true) {
    out.push(
      finding(
        "v2_mon_usdg_paused",
        lc(x.usdg),
        "usdg",
        "USDG paused() is true: every USDG transfer reverts. Takes stop, redemptions credit the ledger, bounties pay nothing, the book credits owed",
        { usdg: x.usdg },
      ),
    );
  }
  for (const f of x.frozen) {
    if (f.frozen !== true) continue;
    out.push(
      finding(
        "v2_mon_usdg_frozen",
        lc(f.address),
        "usdg",
        `USDG isFrozen(${f.name} ${f.address}) is true: ${f.name} can neither send nor receive USDG`,
        { contract: f.name, address: f.address },
        { severity: USDG_CRITICAL.has(f.name) ? "error" : "warn" },
      ),
    );
  }
  return out;
}

/**
 * What the UniV3 settlement source is actually wired to for a market, against the registry.
 *   x = { ticker, underlying, source, registryPool, registryFloor, sourcePool, sourceFloor }
 * A source pointing at another pool, or carrying a floor below the registry's, decides settlements and payout
 * routes on its own values: an adopted PoolSet (a first run, a reset, a lost state file) leaves nothing else
 * watching it. `sourcePool` null = the source has no pool for this market.
 */
export function checkPoolWiring(x) {
  const out = [];
  if (x.sourcePool !== null && !sameAddress(x.sourcePool, x.registryPool)) {
    out.push(
      finding(
        "v2_mon_pool_wiring",
        `${lc(x.underlying)}:pool`,
        "pools",
        `${x.ticker}: UniV3TwapSource prices from pool ${x.sourcePool}, the registry names ${x.registryPool}. Every expiry pinned from now on takes the source's pool, and the payout route follows it; if nobody owns the change, treat the admin key as compromised`,
        x,
        { severity: "error" },
      ),
    );
  }
  if (x.sourcePool !== null && x.registryFloor !== null && x.sourceFloor !== null && x.sourceFloor < x.registryFloor) {
    out.push(
      finding(
        "v2_mon_pool_wiring",
        `${lc(x.underlying)}:floor`,
        "pools",
        `${x.ticker}: UniV3TwapSource holds a minimum liquidity of ${x.sourceFloor} for pool ${x.sourcePool}, below the registry's ${x.registryFloor}${x.sourceFloor === 0n ? " (0: the window is never rejected for thinness)" : ""}: a window the registry calls too thin still votes on the settlement price`,
        x,
        { severity: "error" },
      ),
    );
  }
  return out;
}

/**
 * x = { ticker, pool, liquidity, floor, sourceFloor, open } (bigints; floor null = no registry floor).
 * `open` says an alert for this pool is already open: it then takes poolHysteresisBps above the floor to
 * clear. Without that band a pool sitting on its floor pages new/resolved/new/resolved every pass — over
 * 24 h of mainnet swaps the registry floors were crossed 34 times on AAPL, 34 on GOOGL and 18 on QQQ.
 */
export function checkPool(x, t = DEFAULTS) {
  const clearAt = x.floor === null || !x.open ? x.floor : (x.floor * (10_000n + BigInt(t.poolHysteresisBps))) / 10_000n;
  if (clearAt === null || x.liquidity === null || x.liquidity >= clearAt) return [];
  return [
    finding(
      "v2_mon_pool_liquidity_low",
      lc(x.pool),
      "pools",
      `${x.ticker} pool ${x.pool}: in-range liquidity ${x.liquidity} is ${x.floor === 0n ? "n/a" : `${(x.liquidity * 100n) / x.floor}%`} of the TWAP floor ${x.floor}: a window this thin fails the source's liquidity check, so expiries settle on Chainlink alone after the delay and converted payouts may fall back to in kind`,
      { ...x, clearAt },
    ),
  ];
}

/** x = { headBlock, headTimestamp, wallNow } */
export function checkHeadLag(x, t = DEFAULTS) {
  const lag = x.wallNow - x.headTimestamp;
  if (lag <= t.lagWarnS) return [];
  return [
    finding(
      "v2_mon_l2_lag",
      "head",
      "head",
      `the L2 head (block ${x.headBlock}, ${iso(x.headTimestamp)}) is ${duration(lag)} behind the wall clock: the sequencer or this RPC is stalled; nothing settles, pays or rolls without blocks`,
      { headBlock: x.headBlock, headTimestamp: x.headTimestamp, lagSeconds: lag },
      { severity: lag > t.lagErrorS ? "error" : "warn" },
    ),
  ];
}

const HEALTHY_STATES = new Set(["ok", "starting"]);

/**
 * One /health answer. x = { name, url, reachable, httpStatus, body, error }. Understands the keeper v2
 * modes and pricing (status ok|starting|degraded, 503 wedged), the notifier (database, channels
 * breaker, rules), the relay and Ponder (status or a bare 200).
 */
export function checkHealth(x) {
  if (!x.reachable) {
    return [finding("v2_mon_service_down", x.name, "health", `${x.name} /health did not answer (${x.error ?? "unreachable"})`, { name: x.name, error: x.error })];
  }
  if (x.httpStatus < 200 || x.httpStatus >= 300) {
    const status = x.body && typeof x.body === "object" && typeof x.body.status === "string" ? ` (${x.body.status})` : "";
    return [finding("v2_mon_service_down", x.name, "health", `${x.name} /health answered HTTP ${x.httpStatus}${status}`, { name: x.name, httpStatus: x.httpStatus, body: x.body })];
  }
  const reasons = [];
  const b = x.body && typeof x.body === "object" ? x.body : null;
  if (b !== null) {
    if (typeof b.status === "string" && !HEALTHY_STATES.has(b.status)) reasons.push(`status ${b.status}`);
    if (typeof b.database === "string" && b.database !== "ok") reasons.push(`database ${b.database}`);
    if (b.rules && typeof b.rules === "object" && b.rules.status === "failing") reasons.push(`rules engine failing (${b.rules.consecutiveFailures ?? "?"} polls)`);
    if (b.channels && typeof b.channels === "object") {
      for (const [channel, state] of Object.entries(b.channels)) if (state === "open") reasons.push(`${channel} breaker open`);
    }
  }
  if (reasons.length === 0) return [];
  return [finding("v2_mon_service_degraded", x.name, "health", `${x.name} is degraded: ${reasons.join(", ")}`, { name: x.name, reasons, body: b })];
}

/* ---------------------------------------------------------------------------------------------- */
/*  pure checks: pricing inputs (O3-304)                                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Every refusal / quality code this build knows: 02-interfaces.md §5.1's initial reason codes, the pricing
 * service's own PricingReason union (keeper/src/v2/pricing/cboe.ts), the per-rung codes K3-303 and K3-312 add,
 * and the two the monitor itself states. §5.1: "an unknown code is kept verbatim. Automation treats any unknown
 * code as not ready" — so does this file. A code is never silently dropped and never read as "fine".
 */
export const PRICING_REASONS = new Set([
  // §5.1 staleness and time
  "quote-stale", "quote-age-unknown", "underlying-stale", "underlying-age-unknown", "volatility-stale", "expired",
  // §5.1 spot and identity
  "spot-unavailable", "spot-divergence", "identity-unmapped", "identity-mismatch", "multiplier-mismatch",
  // §5.1 books
  "book-empty", "book-one-sided", "book-crossed", "no-quotes",
  // §5.1 inputs and method
  "chain-unavailable", "chain-inconsistent", "source-disagreement", "extrapolated", "event-uncertainty", "model-uncertainty",
  // §5.1 source and rights
  "fallback-provider", "entitlement-insufficient", "external-indicative",
  // the service's own PricingReason values §5.1 does not list, and its parameter refusals
  "unknown-ticker", "chain-stale", "spot-stale", "quotes-inconsistent", "bad-request",
  // K3-303 / K3-312 per-rung codes
  "early-close", "clock-early-close",
  // the monitor's own: the pricing service lists no such expiry, while a live series settles on it
  "expiry-not-listed",
]);

/** The codes in `reasons` this build does not know. Not a rejection of the code: a statement that nothing here can judge it. */
export function unknownPricingReasons(reasons) {
  const out = [];
  for (const raw of reasons ?? []) {
    const code = String(raw);
    if (!PRICING_REASONS.has(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

/**
 * The tenor of a 16:00 New York weekday close: the last session of its Monday-Friday week is that week's
 * weekly, every other session a daily (the same rule as keeper/src/v2/pricing/coverage.ts localNextExpiry).
 * A close the 24/5 calendar does not trade is reported `daily`, so it can never be counted as a weekly pass.
 */
export function expiryTenor(expiry, holidays = HOLIDAY_DAYS) {
  const day = Math.floor(Number(expiry) / DAY_S);
  if (!isTradingDay(day, holidays)) return "daily";
  for (let later = day + 1; (later + 3) % 7 < 5; later += 1) if (isTradingDay(later, holidays)) return "daily";
  return "weekly";
}

/**
 * One /fair answer as the monitor reads it. 200 and 404 are ANSWERS about the market data (§5: "no price right
 * now" is an answer); any other status is a transport or request failure and says nothing about priceability —
 * that is what --health and v2_mon_service_down are for. `provenance` (§5.1) is read when a build serves it and
 * is never required: without it a series is judged on the legacy body alone, and the clocks it would carry stay
 * unknown rather than being invented from receipt time.
 */
export function readFairAnswer(status, body) {
  const b = body !== null && typeof body === "object" ? body : null;
  const base = { answered: false, ok: false, reason: null, source: null, provider: null, method: null, readiness: null, reasons: [], asOf: null, clocks: null, servesProvenance: false };
  if ((status !== 200 && status !== 404) || b === null) {
    return { ...base, reason: typeof b?.reason === "string" ? b.reason : `http-${status}` };
  }
  const p = b.provenance !== null && typeof b.provenance === "object" ? b.provenance : null;
  const q = p !== null && p.quality !== null && typeof p.quality === "object" ? p.quality : null;
  // §5.1: a numeric zero is a valid estimate and is never encoded as null; null always comes with a reason.
  const priced = b.fair !== null && b.fair !== undefined;
  return {
    answered: true,
    ok: priced,
    reason: priced ? null : typeof b.reason === "string" ? b.reason : "no-reason",
    source: typeof b.source === "string" ? b.source : null,
    provider: typeof p?.provider === "string" ? p.provider : null,
    method: typeof p?.method === "string" ? p.method : null,
    readiness: typeof q?.readiness === "string" ? q.readiness : null,
    reasons: Array.isArray(q?.reasons) ? q.reasons.map(String) : [],
    asOf: typeof b.asOf === "number" ? b.asOf : null,
    clocks: p !== null && p.clocks !== null && typeof p.clocks === "object" ? p.clocks : null,
    servesProvenance: p !== null,
  };
}

/**
 * One label per market from its /fair answers: the common value, "mixed" when two answers disagree, null when
 * no answer states one. `provider` and `method` come only from §5.1 provenance, so today they are null — the
 * monitor says "not served" instead of naming a provider the body never named.
 */
export function marketSourceLabels(answers) {
  const out = {};
  for (const field of ["provider", "method", "source"]) {
    const values = [...new Set((answers ?? []).filter((a) => a.answered === true && a[field] != null).map((a) => a[field]))];
    out[field] = values.length === 0 ? null : values.length === 1 ? values[0] : "mixed";
  }
  return out;
}

/**
 * One market's quote readiness, PER TENOR (F3 D6, D9). x = {
 *   ticker,
 *   chain:   { named, usable, error } | null           the pricing /health row for this ticker; null: not read
 *   surface: { ok, reason, expiries: [{ expiry, status }] } | null   /surface/:ticker; null: not read
 *   seriesExpiries: number[]                           expiries this market has live series on, from the chain
 *   probes:  [{ expiry, side, strike, ...readFairAnswer }]
 * }
 *
 * A tenor is judged on its own and never borrows another's result: a market whose weeklies price and whose
 * dailies do not is not ready, and its daily failure pages under its own key. Process health never appears
 * here — a healthy pricing process with an unpriceable daily is exactly the condition this check exists for.
 */
export function checkQuoteReadiness(x) {
  const findings = [];
  const ticker = x.ticker;
  const seen = [];
  const note = (code) => {
    const c = String(code);
    if (!seen.includes(c)) seen.push(c);
    return c;
  };

  const chain = x.chain ?? null;
  let marketReason = null;
  if (chain !== null && chain.named !== true) marketReason = "unknown-ticker";
  else if (chain !== null && typeof chain.usable === "string" && chain.usable !== "ok") marketReason = chain.usable;
  if (marketReason !== null) {
    note(marketReason);
    findings.push(
      finding(
        "v2_mon_quote_unready",
        ticker,
        "pricing",
        `${ticker}: the pricing service refuses every estimate of this market (${marketReason}); no series of it is priceable, whatever the process's /health says`,
        { ticker, scope: "market", reason: marketReason, error: chain.error ?? null },
      ),
    );
  }
  if (x.surface !== null && x.surface !== undefined && x.surface.ok === false) {
    const reason = note(x.surface.reason ?? "no-reason");
    if (marketReason === null) {
      findings.push(
        finding("v2_mon_quote_unready", ticker, "pricing", `${ticker}: /surface named no expiry (${reason}), so no expiry of this market is known to be priceable`, {
          ticker,
          scope: "market",
          reason,
        }),
      );
    }
  }

  const rows = new Map();
  const rowOf = (tenor) => {
    let r = rows.get(tenor);
    if (r === undefined) {
      r = { ticker, tenor, expiries: 0, expiriesNotReady: 0, series: 0, seriesNotReady: 0, reasons: [], failing: [], ready: true };
      rows.set(tenor, r);
    }
    return r;
  };
  const blame = (row, code) => {
    const c = note(code);
    if (!row.reasons.includes(c)) row.reasons.push(c);
  };

  const stated = new Map();
  const surfaceRead = x.surface != null && x.surface.ok === true;
  if (surfaceRead) for (const e of x.surface.expiries ?? []) stated.set(Number(e.expiry), String(e.status ?? "no-status"));
  for (const [expiry, status] of stated) {
    const row = rowOf(expiryTenor(expiry));
    row.expiries += 1;
    if (status === "ok") continue;
    row.expiriesNotReady += 1;
    blame(row, status);
    row.failing.push(`${iso(expiry)} ${status}`);
  }
  // An expiry a live series settles on that the provider does not list at all is a FAILURE of that expiry's
  // tenor, not a silence: it is the shape "the daily is missing while the weeklies price" takes in the data.
  if (surfaceRead) {
    for (const raw of x.seriesExpiries ?? []) {
      const expiry = Number(raw);
      if (stated.has(expiry)) continue;
      const row = rowOf(expiryTenor(expiry));
      row.expiries += 1;
      row.expiriesNotReady += 1;
      blame(row, "expiry-not-listed");
      row.failing.push(`${iso(expiry)} expiry-not-listed (a live series settles on it)`);
    }
  }

  for (const p of x.probes ?? []) {
    if (p.answered !== true) continue; // a transport failure is process health, never priceability
    const row = rowOf(expiryTenor(p.expiry));
    row.series += 1;
    const reasons = Array.isArray(p.reasons) ? p.reasons.map(String) : [];
    const unknown = unknownPricingReasons(reasons);
    const readiness = typeof p.readiness === "string" ? p.readiness : null;
    // §5.1: ready means readiness "ready" with NO reason at all. An unknown code, a degraded readiness and a
    // null fair are each not ready; a fair of zero is a price, so it is not counted unready for being zero.
    const notReady = p.ok !== true || reasons.length > 0 || unknown.length > 0 || (readiness !== null && readiness !== "ready");
    if (!notReady) continue;
    row.seriesNotReady += 1;
    for (const c of reasons) blame(row, c);
    if (p.ok !== true) blame(row, p.reason ?? "no-reason");
    const why = p.ok !== true ? p.reason ?? "no-reason" : reasons.length > 0 ? reasons.join(",") : `readiness ${readiness}`;
    row.failing.push(`${iso(p.expiry)} ${p.side} ${p.strike} ${why}`);
  }

  // "daily" sorts before "weekly": the tenor most likely to fail is read first, as in the coverage report.
  for (const row of [...rows.values()].sort((a, b) => (a.tenor < b.tenor ? -1 : a.tenor > b.tenor ? 1 : 0))) {
    row.ready = row.expiriesNotReady === 0 && row.seriesNotReady === 0;
    if (row.ready || marketReason !== null) continue;
    const parts = [];
    if (row.expiriesNotReady > 0) parts.push(`${row.expiriesNotReady} of ${row.expiries} ${row.tenor} expir${row.expiries === 1 ? "y" : "ies"}`);
    if (row.seriesNotReady > 0) parts.push(`${row.seriesNotReady} of ${row.series} probed ${row.tenor} series`);
    const shown = row.failing.slice(0, 3).join("; ");
    findings.push(
      finding(
        "v2_mon_quote_unready",
        `${ticker}:${row.tenor}`,
        "pricing",
        `${ticker} ${row.tenor}: ${parts.join(" and ")} cannot be priced (${row.reasons.join(", ")}): ${shown}${row.failing.length > 3 ? `, +${row.failing.length - 3} more` : ""}. This tenor is judged on its own; another tenor pricing does not make it ready`,
        {
          ticker,
          scope: "tenor",
          tenor: row.tenor,
          expiries: row.expiries,
          expiriesNotReady: row.expiriesNotReady,
          series: row.series,
          seriesNotReady: row.seriesNotReady,
          reasons: row.reasons,
          failing: row.failing,
        },
      ),
    );
  }

  const unknown = unknownPricingReasons(seen);
  if (unknown.length > 0) {
    findings.push(
      finding(
        "v2_mon_pricing_reason_unknown",
        ticker,
        "pricing",
        `${ticker}: the pricing service stated reason code(s) this monitor does not know (${unknown.join(", ")}). 02-interfaces.md §5.1 keeps an unknown code verbatim and has automation treat it as NOT ready, so every expiry or series carrying one is counted unready above; add the code here once its meaning is agreed`,
        { ticker, codes: unknown, knownCodes: PRICING_REASONS.size },
      ),
    );
  }
  return { rows: [...rows.values()], findings };
}

/** The clocks a source-age limit can be set on, and the threshold that sets it. `published` is reported, never paged:
 *  a publication or ingestion time is not a source observation (F3 D5) and must never stand in for one. */
export const SOURCE_CLOCKS = Object.freeze({ quote: "quoteAgeS", underlying: "underlyingAgeS", volatility: "volatilityAgeS" });

/**
 * Source clock ages for one market (F3 D5). An age this build cannot compute is `null` — UNKNOWN — never 0 and
 * never fresh. The limits are operator policy: 0 means "report the age, page on nothing", because the monitor
 * does not invent a freshness bound, and the service already refuses a chain past its own `maxChainAgeS` (that
 * arrives as a readiness reason, not here). With a limit set, an unknown age fails it: it cannot be shown to meet it.
 *
 * x = { ticker, now, clocks: { quote, underlying, volatility, published } } — unix seconds, or null for unknown.
 */
export function checkSourceAges(x, t = DEFAULTS) {
  const findings = [];
  const ages = {};
  const now = Number(x.now);
  const at = (name) => {
    const v = x.clocks?.[name];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };
  for (const name of ["quote", "underlying", "volatility", "published"]) {
    const observed = at(name);
    ages[`${name}S`] = observed === null ? null : Math.max(0, now - observed);
  }
  for (const [name, threshold] of Object.entries(SOURCE_CLOCKS)) {
    const limit = Number(t[threshold] ?? 0);
    if (!(limit > 0)) continue;
    const age = ages[`${name}S`];
    if (age === null) {
      findings.push(
        finding(
          "v2_mon_source_age",
          `${x.ticker}:${name}`,
          "pricing",
          `${x.ticker}: the ${name} observation time is UNKNOWN (the source states none), so its age cannot be shown to be within the ${limit} s limit — an unknown age is not fresh and is never 0 (F3 D5)`,
          { ticker: x.ticker, clock: name, observedAt: null, ageSeconds: null, limitSeconds: limit },
        ),
      );
    } else if (age > limit) {
      findings.push(
        finding(
          "v2_mon_source_age",
          `${x.ticker}:${name}`,
          "pricing",
          `${x.ticker}: the ${name} observation is ${duration(age)} old (${iso(at(name))}), past the ${limit} s limit; a refetch advances ingestion time only and never this one`,
          { ticker: x.ticker, clock: name, observedAt: at(name), ageSeconds: age, limitSeconds: limit },
        ),
      );
    }
  }
  return { ages, findings };
}

/** The labels a switch is judged on. The legacy `source` is NOT a method: it is "cboe" only for the cboe-delayed
 *  provider priced from the exact listed contract and "model" for every other method (§5.1), so it moves when
 *  either the provider or the method does — which is why it is watched on its own until provenance ships. */
export const SOURCE_LABELS = Object.freeze({
  provider: "data provider",
  method: "pricing method",
  source: "legacy `source` label (cboe = the cboe-delayed provider on an exact listed contract; model = every other method)",
});

/**
 * A provider or method switch between two polls: an event, paged once per transition. x = { key, label,
 * previous, current }, each of previous/current { provider, method, source } with null for "not stated".
 * A label that appears or disappears is info (the contract moved); a label that changes from one stated value
 * to another is a warn: every estimate now comes from a different input, calibrated on the old one.
 */
export function checkSourceSwitch(x) {
  const findings = [];
  const prev = x.previous ?? null;
  if (prev === null) return findings;
  for (const [field, what] of Object.entries(SOURCE_LABELS)) {
    const from = prev[field] ?? null;
    const to = x.current?.[field] ?? null;
    if (from === to) continue;
    const both = from !== null && to !== null;
    findings.push(
      finding(
        "v2_mon_source_switch",
        `${x.key}:${field}:${from ?? "none"}>${to ?? "none"}`,
        "pricing",
        both
          ? `${x.label}: the ${what} changed ${from} -> ${to} between two polls; every estimate of this market now comes from a different input, and the edge and spreads were calibrated on the old one`
          : to === null
            ? `${x.label}: the ${what} is no longer stated (it was ${from}); an unlabelled input is not evidence of the old one`
            : `${x.label}: the ${what} is now stated as ${to} (nothing stated one before)`,
        { key: x.key, field, from, to },
        { severity: both ? "warn" : "info" },
      ),
    );
  }
  return findings;
}

/**
 * Is the pricer evaluating anything? (F3 §1: "Nothing checks that a live market's rungs are priceable or that the
 * pricer is actually evaluating.") Fed by the pricer's own /state counters: `ticks` and the `outcomes` histogram,
 * one entry per pair per tick. x = { answered, body, now, previous: { evaluations, ticks, at } | null }.
 *
 * NOT a process check. A pricer that does not answer leaves this alone and is v2_mon_service_down's business, so a
 * dead process and a running-but-idle one are two different pages. Outside the 24/5 session the pricer deliberately
 * does nothing, so the window restarts instead of paging every night and weekend. `strategies: 0` is not idle: the
 * loop is running and there is nothing to reprice. Returns { activity, seen, findings }; `seen` is what to store,
 * null meaning "leave the stored record alone".
 */
export function checkPricerActivity(x, t = DEFAULTS) {
  if (x.answered !== true || x.body === null || typeof x.body !== "object") return { activity: null, seen: null, findings: [] };
  const b = x.body;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const outcomes = b.outcomes !== null && typeof b.outcomes === "object" ? b.outcomes : {};
  const evaluations = Object.values(outcomes).reduce((a, v) => a + (num(v) ?? 0), 0);
  const ticks = num(b.ticks) ?? 0;
  const parsed = typeof b.lastTickAt === "string" ? Math.floor(Date.parse(b.lastTickAt) / 1000) : NaN;
  const lastTickAt = Number.isFinite(parsed) ? parsed : null;
  const strategies = num(b.strategies);
  const sessionOpen = typeof b.sessionOpen === "boolean" ? b.sessionOpen : null;
  const now = Number(x.now);
  const activity = { evaluations, ticks, lastTickAt, strategies, sessionOpen, hasRole: typeof b.hasRole === "boolean" ? b.hasRole : null };
  const prev = x.previous ?? null;
  const moved = prev === null || num(prev.evaluations) !== evaluations || num(prev.ticks) !== ticks;
  const seen = moved || sessionOpen === false ? { evaluations, ticks, at: now } : prev;
  const window = Number(t.pricerIdleS ?? 0);
  if (!(window > 0) || sessionOpen === false || prev === null) return { activity, seen, findings: [] };
  const stillS = Math.max(0, now - Number(seen.at));
  const tickAgeS = lastTickAt === null ? null : Math.max(0, now - lastTickAt);
  if (stillS < window && !(tickAgeS !== null && tickAgeS >= window)) return { activity, seen, findings: [] };
  const lastText = lastTickAt === null ? "at an UNKNOWN time (the body states no lastTickAt, and an unknown age is not 0)" : `${duration(tickAgeS)} ago (${iso(lastTickAt)})`;
  return {
    activity,
    seen,
    findings: [
      finding(
        "v2_mon_pricer_idle",
        "pricer",
        "pricing",
        `the pricer has evaluated nothing for ${duration(stillS)} (window ${window} s): ${ticks} tick(s) and ${evaluations} pair evaluation(s) since it started, unchanged since ${iso(seen.at)}, last tick ${lastText}, ${strategies === null ? "an unknown number of" : strategies} smart-pricing strateg${strategies === 1 ? "y" : "ies"} to reprice. The process may still answer /health: this is about work done, not liveness. Asks already placed keep their last price while it is stopped — nothing cancels them`,
        { idleSeconds: stillS, windowSeconds: window, ticks, evaluations, lastTickAt, tickAgeSeconds: tickAgeS, strategies, sessionOpen, hasRole: activity.hasRole },
      ),
    ],
  };
}

/**
 * The live series to ask /fair about this pass, bounded by `max`. Daily before weekly and nearest expiry first
 * within a market, then one market at a time, so a market with many weeklies can never crowd another market's
 * daily out of the budget — the whole point of F3 D9's "no weekly-only pass hides a daily failure".
 * series: [{ longId, ticker, expiry, side, strike }] (strike a decimal string of USDG base units).
 */
export function probeTargets(series, now, max) {
  const byTicker = new Map();
  for (const s of series ?? []) {
    if (Number(s.expiry) <= Number(now)) continue;
    const list = byTicker.get(s.ticker) ?? [];
    list.push({ ...s, tenor: expiryTenor(s.expiry) });
    byTicker.set(s.ticker, list);
  }
  const rank = (a) => (a.tenor === "daily" ? 0 : 1);
  for (const list of byTicker.values()) {
    list.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        Number(a.expiry) - Number(b.expiry) ||
        (BigInt(a.strike) < BigInt(b.strike) ? -1 : BigInt(a.strike) > BigInt(b.strike) ? 1 : 0) ||
        (a.side < b.side ? -1 : a.side > b.side ? 1 : 0),
    );
  }
  const lists = [...byTicker.values()];
  const out = [];
  for (let i = 0; out.length < Number(max); i += 1) {
    let took = false;
    for (const list of lists) {
      if (i >= list.length) continue;
      out.push(list[i]);
      took = true;
      if (out.length >= Number(max)) break;
    }
    if (!took) break;
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/*  pure checks: admin actions                                                                     */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Admin (and guardian pause, veto) events on our contracts and their severity. Error: what can move a
 * settlement price, a role, or treasury money (V2-ARCHITECTURE §2.2). Warn: the rest. The INTERFACE_VERSION 6
 * wiring events (DEDICATED_EVENTS) are judged by adminEventFindings and prePinFindings instead, with their own kinds.
 */
export const CONFIG_EVENTS = Object.freeze({
  RoleGranted: "error",
  RoleRevoked: "error",
  RoleAdminChanged: "error",
  MarketConfigured: "error",
  FeedSet: "error",
  PoolSet: "error",
  MarketConfigSet: "error",
  CalendarSet: "error",
  PayoutAdapterSet: "error",
  FeeRecipientSet: "error",
  CallerSet: "error",
  Defunded: "error",
  Withdrawn: "error",
  PositionWithdrawn: "error",
  SettlementResolved: "error",
  SettlementVetoed: "warn",
  SettlementUnvetoed: "warn",
  MarketRegistered: "warn",
  KeeperRewardsSet: "warn",
  FeeParamsSet: "warn",
  MakerRegistrySet: "warn",
  TierSet: "warn",
  TradingPausedSet: "warn",
  CreatePausedSet: "warn",
  MintPausedSet: "warn",
  BountySet: "warn",
  DailyCapSet: "warn",
  MinRollUnitsSet: "warn",
  LimitsSet: "warn",
  HolidaySet: "warn",
  SpecialExpirySet: "warn",
  RootSet: "warn",
  MinRedeemPayoutSet: "warn",
  BaseUriSet: "warn",
  /* ---- INTERFACE_VERSION 8. An admin event missing from this map is an admin event NOTHING ever pages. ---- */
  // A minter can mint Clearinghouse positions; the allow-list is the whole guard (06-QUIRKS §B7).
  MinterSet: "error",
  // The 72 h MARKET_FEE_MANAGER lane: the exercise fee and the rent dial for every market without its own.
  DefaultMarketFeesSet: "error",
  DefaultOracleSet: "error",
  // A discount module can take up to MAX_DISCOUNT_BPS of the taker fee.
  DiscountModuleSet: "error",
  FundingAllowedSet: "warn",
  MarketSourcesSet: "error",
  // Where a contract's money goes.
  TreasurySet: "error",
  // The manager's own lifecycle. Every one is paged; the severities live in managerEventFindings.
  ManagerRoleGranted: "error",
  ManagerRoleRevoked: "error",
  ManagerRoleAdminChanged: "error",
  RoleGuardianChanged: "error",
  RoleGrantDelayChanged: "error",
  RoleLabel: "warn",
  TargetFunctionRoleUpdated: "error",
  TargetAdminDelayUpdated: "error",
  TargetClosed: "error",
  OperationScheduled: "error",
  OperationExecuted: "error",
  OperationCanceled: "warn",
});

/** The manager events managerEventFindings owns; they are paged under their own kinds, not v2_mon_config_changed. */
export const MANAGER_ROLE_EVENTS = new Set([
  "ManagerRoleGranted",
  "ManagerRoleRevoked",
  "ManagerRoleAdminChanged",
  "RoleGuardianChanged",
  "RoleGrantDelayChanged",
  "RoleLabel",
  "TargetFunctionRoleUpdated",
  "TargetAdminDelayUpdated",
  "TargetClosed",
]);
export const MANAGER_OPERATION_EVENTS = new Set(["OperationScheduled", "OperationExecuted", "OperationCanceled"]);
/** The splitter's own log, read by checkSplitter / checkBuyback rather than paged one event at a time. */
export const SPLITTER_EVENTS = new Set(["Distributed", "DistributionSkipped", "BoughtBack", "Burned", "BuybackSkipped"]);

function argsSummary(args) {
  if (args === null || typeof args !== "object") return "";
  const entries = Array.isArray(args) ? args.map((v, i) => [String(i), v]) : Object.entries(args);
  const text = entries
    .map(([k, v]) => {
      let s = JSON.stringify(v, bigintReplacer);
      if (typeof v === "string" && ROLE_NAMES[lc(v)]) s = ROLE_NAMES[lc(v)];
      return `${k}=${s}`;
    })
    .join(", ");
  return text.length > 400 ? `${text.slice(0, 397)}...` : text;
}

/**
 * events: decoded logs [{ eventName, address, args, blockNumber, transactionHash, logIndex }];
 * adoptUntil: events at or below this block were there before the first run and page nothing;
 * names: lowercase address -> contract name.
 */
export function configEventFindings(events, adoptUntil, names) {
  const out = [];
  for (const e of events) {
    const severity = CONFIG_EVENTS[e.eventName];
    if (severity === undefined) continue;
    if (adoptUntil !== null && BigInt(e.blockNumber) <= BigInt(adoptUntil)) continue;
    const name = names[lc(e.address)] ?? e.address;
    out.push(
      finding(
        "v2_mon_config_changed",
        `${lc(e.transactionHash)}:${e.logIndex}`,
        "config",
        `${name}.${e.eventName}(${argsSummary(e.args)}) in block ${e.blockNumber}, tx ${e.transactionHash}: expected only from a planned admin or guardian action; if nobody owns it, treat the key as compromised`,
        { contract: name, address: e.address, event: e.eventName, args: e.args, blockNumber: e.blockNumber, transactionHash: e.transactionHash },
        { severity },
      ),
    );
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/*  pure checks: INTERFACE_VERSION 6 wiring (fee schedule, routes, allow-lists, pins)              */
/* ---------------------------------------------------------------------------------------------- */

/** Admin events judged by adminEventFindings / feeScheduledFindings (their own kinds), not configEventFindings. */
export const DEDICATED_EVENTS = new Set([
  "FeeParamsScheduled",
  "RouteSet",
  "OracleSet",
  "ClearinghouseSet",
  "DataStreamsFeedSet",
  // INTERFACE_VERSION 8: the PayoutRouter's own five-field RouteSet and its clear.
  "RouterRouteSet",
  "RouteCleared",
  // T-OP-090. AutoRoller.Repriced has kinds of its own (repriceFindings); configEventFindings must never page it.
  "Repriced",
]);

/**
 * Every event that has a kind of its own, so `v2_mon_config_changed` never pages it a second time. The scan
 * collects an event when it is in CONFIG_EVENTS or here; `configEventFindings` is given everything NOT here.
 * Adding an event to one of the three sets below and forgetting this one would double-page it; leaving it out of
 * all four would drop it silently, which is the failure `CONFIG_EVENTS` exists to prevent.
 */
export const OWN_KIND_EVENTS = new Set([...DEDICATED_EVENTS, ...MANAGER_ROLE_EVENTS, ...MANAGER_OPERATION_EVENTS, ...SPLITTER_EVENTS]);
/** The pin logs prePinFindings groups by transaction, and the series creation they must come with. */
export const PIN_EVENTS = new Set(["SeriesCreated", "SettlementConfigPinned", "FeedPinned", "PoolPinned", "DataStreamsFeedPinned"]);

export const FEE_FIELDS = ["premiumFeeBps", "resaleFeeBps", "takerFeeFlat", "takerFeeCapBps", "makerRebateBps"];

/** A FeeParams tuple (viem's object or an array, any integer type) as plain numbers; null stays null. */
export function feeParamsOf(p) {
  if (p === null || p === undefined) return null;
  return Object.fromEntries(FEE_FIELDS.map((name, i) => [name, Number(Array.isArray(p) ? p[i] : p[name])]));
}
export const sameFees = (a, b) => a !== null && b !== null && FEE_FIELDS.every((k) => Number(a[k]) === Number(b[k]));
const pctOfBps = (bps) => `${fixed(BigInt(bps), 2, 2)} %`;
export const describeFees = (f) =>
  `seller fee ${pctOfBps(f.premiumFeeBps)}, resale fee ${pctOfBps(f.resaleFeeBps)}, taker fee ${usdg(BigInt(f.takerFeeFlat))} USDG capped at ${pctOfBps(f.takerFeeCapBps)} of premium, maker rebate ${pctOfBps(f.makerRebateBps)} of the taker fee`;

/** What a change makes worse: a fee up, or the makers' rebate share down. [{ field, from, to }] */
export function feeRises(before, after) {
  const out = [];
  for (const field of FEE_FIELDS) {
    const from = Number(before[field]);
    const to = Number(after[field]);
    if (field === "makerRebateBps" ? to < from : to > from) out.push({ field, from, to });
  }
  return out;
}
const risesText = (rises) => rises.map((r) => `${r.field} ${r.from} -> ${r.to}`).join(", ");

/**
 * FeeParamsScheduled logs of the OrderBook since the first run: [{ address, args: { params, effectiveAt }, feesBefore,
 * blockNumber, transactionHash, logIndex }], `feesBefore` being the fees in effect when the change was scheduled (the
 * log replay of applyScanLogs, or feeParams() read at the block before; null = unknown).
 * warn: announced FEE_CHANGE_DELAY ahead (48 h from INTERFACE_VERSION 8, 24 h before it), nothing rises. error: a
 * fee rises or the maker rebate share falls, or the fees before it are unknown (treated as a rise until someone
 * checks). The notice period is quoted from the constant, never written out: it changed once already.
 */
export function feeScheduledFindings(events, adoptUntil) {
  const out = [];
  for (const e of events) {
    if (adoptUntil !== null && BigInt(e.blockNumber) <= BigInt(adoptUntil)) continue;
    const params = feeParamsOf(e.args.params);
    const effectiveAt = Number(e.args.effectiveAt);
    const before = feeParamsOf(e.feesBefore);
    const rises = before === null ? null : feeRises(before, params);
    let what;
    if (before === null) what = "the fees in effect before it could not be established: treat it as a rise until checked";
    else if (sameFees(before, params)) what = "these are the fees in effect: it cancels any pending change";
    else if (rises.length > 0) what = `it RAISES ${risesText(rises)} (in effect now: ${describeFees(before)})`;
    else what = `nothing rises (in effect now: ${describeFees(before)})`;
    out.push(
      finding(
        "v2_mon_fee_scheduled",
        `${lc(e.transactionHash)}:${e.logIndex}`,
        "config",
        `OrderBook.setFeeParams scheduled ${describeFees(params)} from ${iso(effectiveAt)}, ${duration(FEE_CHANGE_DELAY)} after it was scheduled (block ${e.blockNumber}, tx ${e.transactionHash}); ${what}. Every take from effectiveAt pays it, fills of resting orders included: makers who do not accept it cancel before then. Expected only from a planned owner change; if nobody owns it, treat the admin key as compromised`,
        { orderBook: e.address, params, effectiveAt, before, rises, blockNumber: e.blockNumber, transactionHash: e.transactionHash },
        { severity: before === null || rises.length > 0 ? "error" : "warn" },
      ),
    );
  }
  return out;
}

/**
 * The OrderBook's pending fee change read at the head, when no v2_mon_fee_scheduled alert announced it (its log was
 * adopted on a first run, or the state file was lost). x = { orderBook, now, current, pending, effectiveAt (0 = none),
 * announced }. warn; error when a fee rises.
 */
export function checkPendingFees(x) {
  if (!x.effectiveAt || x.announced) return [];
  const rises = feeRises(x.current, x.pending);
  return [
    finding(
      "v2_mon_fee_change_pending",
      `${lc(x.orderBook)}:${x.effectiveAt}`,
      "fees",
      `OrderBook has a fee change pending that no monitor alert announced: ${describeFees(x.pending)} from ${iso(x.effectiveAt)} (in ${duration(x.effectiveAt - x.now)}); in effect now: ${describeFees(x.current)}${rises.length > 0 ? `; it RAISES ${risesText(rises)}` : ""}. Find its FeeParamsScheduled log: if nobody owns it, treat the admin key as compromised`,
      { orderBook: x.orderBook, effectiveAt: x.effectiveAt, current: x.current, pending: x.pending, rises },
      { severity: rises.length > 0 ? "error" : "warn" },
    ),
  ];
}

/**
 * RouteSet (UniV3PayoutAdapter), OracleSet (the sources' pin allow-lists), ClearinghouseSet (SettlementOracle) and
 * DataStreamsFeedSet since the first run.
 *   ctx = { names, clearinghouse, settlementOracle, markets (parseRegistry's), dataStreamsListed: string[] | null }
 * `dataStreamsListed` names where the Data Streams source is listed (market lists, pinned expiries with series); null
 * when it could not be read, which pages as if listed.
 */
export function adminEventFindings(events, adoptUntil, ctx) {
  const out = [];
  for (const e of events) {
    if (!DEDICATED_EVENTS.has(e.eventName) || e.eventName === "FeeParamsScheduled") continue;
    if (adoptUntil !== null && BigInt(e.blockNumber) <= BigInt(adoptUntil)) continue;
    const name = ctx.names[lc(e.address)] ?? e.address;
    const a = e.args ?? {};
    const at = `block ${e.blockNumber}, tx ${e.transactionHash}`;
    const key = `${lc(e.transactionHash)}:${e.logIndex}`;
    const data = { contract: name, address: e.address, event: e.eventName, args: a, blockNumber: e.blockNumber, transactionHash: e.transactionHash };
    const unowned = "if nobody owns it, treat the admin key as compromised";
    if (e.eventName === "RouteSet") {
      const fee = Number(a.fee);
      const m = ctx.markets.find((x) => sameAddress(x.asset, a.asset));
      const ticker = m?.ticker ?? shortAddr(a.asset);
      const registryPool = m?.v2?.univ3Pool ?? null;
      let severity = "error";
      let why;
      if (fee > MAX_ROUTE_FEE_TIER) {
        why = `fee tier ${fee} is above ${MAX_ROUTE_FEE_TIER} (1 %): the Clearinghouse counts at most 100 bps of a route's fee, so every conversion misses its floor and pays in kind (UniV3PayoutAdapter refuses this tier: the emitting contract is not the published adapter's code)`;
      } else if (sameAddress(a.pool, ZERO) && fee === 0) {
        severity = "warn";
        why = registryPool ? `route cleared: every in-the-money ${ticker} call long is paid in kind until the route is set again` : `route cleared (the registry lists no pool for ${ticker})`;
      } else if (m === undefined) {
        why = `${a.asset} is not a registry market`;
      } else if (registryPool === null) {
        why = `the registry lists no pool for ${ticker}: its conversions now sell through ${a.pool}`;
      } else if (!sameAddress(a.pool, registryPool)) {
        why = `the registry pool is ${registryPool}: conversions now sell through another pool, and its fee tier (${Math.ceil(fee / 100)} bps) moves the market's conversion floor`;
      } else {
        severity = "warn";
        why = `the registry pool at fee tier ${fee} (${Math.ceil(fee / 100)} bps added to the conversion slippage bound)`;
      }
      out.push(finding("v2_mon_route_changed", key, "config", `${name}.RouteSet(${ticker}, pool ${a.pool}, fee ${fee}) in ${at}: ${why}; ${unowned}`, { ...data, ticker, registryPool }, { severity }));
    } else if (e.eventName === "RouterRouteSet") {
      // INTERFACE_VERSION 8. The PayoutRouter's own five-field RouteSet, renamed by scanEventName so it does not
      // collide with the v7 adapter's three-field one. It is in DEDICATED_EVENTS, so configEventFindings will not
      // page it: if this branch is missing the event is decoded, gated in, matched by nothing and dropped.
      const fee = Number(a.fee);
      const feeBps = Number(a.feeBps);
      const venue = routeVenueName(a.venue);
      const m = ctx.markets.find((x) => sameAddress(x.asset, a.asset));
      const ticker = m?.ticker ?? shortAddr(a.asset);
      const want = m?.v2?.payoutRoute ?? null;
      let severity = "error";
      let why;
      if (Number(a.venue) === 0) {
        // Venue `none` set through setRoute rather than clearRoute: the same outcome as RouteCleared.
        severity = want === null ? "warn" : "error";
        why =
          want === null
            ? `route set to venue none, and the registry publishes no route for ${ticker} either: in-the-money calls are paid in Stock Tokens, which is what the registry already says`
            : `route set to venue none while the registry publishes a ${want.venue} route (fee ${want.fee}): every in-the-money ${ticker} call long is paid in Stock Tokens instead of USDG until a route is set again`;
      } else if (fee > MAX_ROUTE_FEE_TIER) {
        why = `fee tier ${fee} is above ${MAX_ROUTE_FEE_TIER} (1 %): the Clearinghouse counts at most ${MAX_ROUTE_FEE_BPS} bps of a route's fee, so every conversion misses its floor and pays in kind`;
      } else if (m === undefined) {
        why = `${a.asset} is not a registry market`;
      } else if (want === null) {
        why = `the registry publishes no payout route for ${ticker}: its conversions now sell over ${venue} at fee tier ${fee}, a venue no reviewed registry names`;
      } else if (venue !== want.venue) {
        why = `the registry publishes ${want.venue} and the route is now ${venue}. The two venues price differently and the conversion floor is computed from the oracle either way, so this is a wiring change, not a market move`;
      } else if (fee !== Number(want.fee)) {
        why = `the registry publishes fee tier ${want.fee} and the route is now ${fee} (${Math.ceil(fee / 100)} bps against ${Math.ceil(Number(want.fee) / 100)} bps): a different tier is a different pool`;
      } else if (want.venue === "v4" && want.tickSpacing !== null && Number(a.tickSpacing ?? want.tickSpacing) !== Number(want.tickSpacing)) {
        why = `the registry publishes tickSpacing ${want.tickSpacing}: with the same currencies and fee, a different tickSpacing is a different pool id`;
      } else if (want.venue === "v4" && want.poolId !== null && a.poolId !== undefined && lc(a.poolId) !== lc(want.poolId)) {
        why = `the pool id set on chain (${a.poolId}) is not the one the registry pins (${want.poolId}). A v4 pool has no address, so the id IS the pin — nothing else would catch this`;
      } else if (feeBps > MAX_ROUTE_FEE_BPS) {
        severity = "warn";
        why = `the registry route, but its cached fee is ${feeBps} bps and the Clearinghouse counts at most ${MAX_ROUTE_FEE_BPS}: the floor is computed as if the route were cheaper than it is`;
      } else {
        severity = "warn";
        why = `the registry route: ${venue} at fee tier ${fee} (${feeBps} bps added to the conversion slippage bound)`;
      }
      out.push(
        finding(
          "v2_mon_route_changed",
          key,
          "config",
          `${name}.RouteSet(${ticker}, venue ${venue}, fee ${fee}, ${feeBps} bps) in ${at}: ${why}; ${unowned}`,
          { ...data, ticker, registryRoute: want, venue },
          { severity },
        ),
      );
    } else if (e.eventName === "RouteCleared") {
      // INTERFACE_VERSION 8. THE CASE WITH NO OTHER COVERAGE AT ALL. checkRoute only compares a route the registry
      // publishes (`if (want === null) { if venue !== 0 page unpublished }`), so for a market with no published
      // payoutRoute a cleared route is indistinguishable from the steady state and the periodic check is silent
      // for ever. clearRoute is a delay-0 guardian action, so the AccessManager writes no OperationScheduled or
      // OperationExecuted either: this event is the only trace there is.
      const m = ctx.markets.find((x) => sameAddress(x.asset, a.asset));
      const ticker = m?.ticker ?? shortAddr(a.asset);
      const want = m?.v2?.payoutRoute ?? null;
      const severity = want === null ? "warn" : "error";
      const why =
        want === null
          ? `the registry publishes no payout route for ${ticker}, so the periodic route check cannot see this: it only compares a published route, and a cleared route on an unpublished market looks exactly like the steady state. This event is the only record that it happened`
          : `the registry publishes a ${want.venue} route (fee ${want.fee}): every in-the-money ${ticker} call long is now paid in Stock Tokens instead of USDG until the route is set again — safe, and not what the registry says is meant to happen`;
      out.push(
        finding(
          "v2_mon_route_changed",
          key,
          "config",
          `${name}.RouteCleared(${ticker}) in ${at}: ${why}; ${unowned}`,
          { ...data, ticker, registryRoute: want },
          { severity },
        ),
      );
    } else if (e.eventName === "OracleSet") {
      const live = ctx.settlementOracle !== null && sameAddress(a.oracle, ctx.settlementOracle);
      let severity = "warn";
      let why;
      if (a.allowed === true && !live) {
        severity = "error";
        why = `${a.oracle} is not the published SettlementOracle: it can now pin ${name}'s configuration of any expiry before that expiry's first series (a pre-pin), and a pre-pin that differs from the configuration at creation blocks every series of the expiry`;
      } else if (a.allowed !== true && live) {
        severity = "error";
        why = `the published SettlementOracle can no longer pin ${name}: every first series of an expiry on a market that lists ${name} reverts SourceNotPinned(${name}, NotAuthorized)`;
      } else {
        why = a.allowed === true ? "the published SettlementOracle allowed (the deploy wiring or a restore)" : `${a.oracle} (not the published SettlementOracle) removed from the allow-list`;
      }
      out.push(finding("v2_mon_oracle_allowlist", key, "config", `${name}.OracleSet(${a.oracle}, ${a.allowed}) in ${at}: ${why}; ${unowned}`, data, { severity }));
    } else if (e.eventName === "ClearinghouseSet") {
      const isOracle = ctx.settlementOracle !== null && sameAddress(e.address, ctx.settlementOracle);
      const live = ctx.clearinghouse !== null && sameAddress(a.clearinghouse, ctx.clearinghouse);
      const severity = live || !isOracle ? "warn" : "error";
      const why = !isOracle
        ? "not the published SettlementOracle"
        : live
          ? "the live Clearinghouse (the deploy wiring or a restore)"
          : `not the live Clearinghouse ${ctx.clearinghouse}: series creation reverts NotAuthorized on every market of this oracle, and ${a.clearinghouse} can pin any expiry before its first series (a pre-pin) or move pinnedBy of an expiry that has series`;
      out.push(finding("v2_mon_oracle_clearinghouse", key, "config", `${name}.ClearinghouseSet(${a.clearinghouse}) in ${at}: ${why}; ${unowned}`, data, { severity }));
    } else if (e.eventName === "DataStreamsFeedSet") {
      const m = ctx.markets.find((x) => sameAddress(x.asset, a.underlying));
      const ticker = m?.ticker ?? shortAddr(a.underlying);
      const listed = ctx.dataStreamsListed;
      const severity = listed === null || listed.length > 0 ? "error" : "warn";
      const why =
        listed === null
          ? "where the source is listed could not be read: treat it as listed"
          : listed.length > 0
            ? `the source is listed (${listed.slice(0, 8).join(", ")}${listed.length > 8 ? `, and ${listed.length - 8} more` : ""}): the change bumps feedVersion, so every pinned ${ticker} expiry whose window is not recorded yet stops being priced by it and settles on its other pinned sources alone (with none of them answering, adminResolve takes any price from E + 48 h)`
            : "the source is listed nowhere (no market list, no pinned expiry with series): no settlement reads it";
      out.push(finding("v2_mon_data_streams_feed", key, "config", `${name}.FeedSet(${ticker}, feedId ${a.feedId}) in ${at}: ${why}; ${unowned}`, { ...data, ticker, listed }, { severity }));
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/*  pure checks: INTERFACE_VERSION 8 (the manager, the Safes, the flywheel, v4 routes)             */
/* ---------------------------------------------------------------------------------------------- */

/** The first four bytes of an operation's calldata, or null when there are not four. */
export function selectorOf(data) {
  const hex = typeof data === "string" ? data : "";
  return /^0x[0-9a-fA-F]{8}/.test(hex) ? hex.slice(0, 10).toLowerCase() : null;
}

/**
 * Which manifest role a target selector belongs to, as `<Contract>.<signature> -> ROLE`. The manifest lists
 * signatures, not selectors, so the caller passes the selector -> signature index it built with viem; without one
 * the answer is unknown, never a guess.
 *   index: { "<selector>": { contract, signature, role } }
 */
export function manifestRoleOf(selector, index) {
  if (selector === null || index === null || index === undefined) return null;
  return index[selector] ?? null;
}

/**
 * INTERFACE_VERSION 8. Every AccessManager log, paged one for one: the manager is the only thing standing between
 * a stolen key and the whole protocol, so nothing here is adopted quietly the way a routine setter is.
 *
 *   ctx = { names (lowercase address -> contract name), manifest (ROLE_MANIFEST.manifest or null),
 *           selectors (selector -> { contract, signature, role } or null), now (head timestamp) }
 *
 * `adoptUntil` works exactly as it does for config events: logs at or below the first run's block were already
 * there and page nothing. An operation SCHEDULED before the first run and executed after it still pages on the
 * execution, which is the half that moves state.
 */
/**
 * T-OP-090. AutoRoller.Repriced, the PRICER lane moving a writer's ask. T-OP-063 bounded each reprice to a
 * MAX_REPRICE_DROP_BPS drop so a leaked PRICER key needs SEVERAL calls to walk an ask to the writer's floor, and
 * AutoRoller.sol:134 promises that each of those calls pages -- this is that page. Per event (in chain order):
 *   (a) v2_mon_reprice_floorward (error): the reprice LOWERED the ask by at least `t.repricePageDropFraction` of the
 *       per-call cap, i.e. drop/priceBefore >= fraction x MAX_REPRICE_DROP_BPS / 10_000. A maximal step is what a key
 *       walking to the floor sends; an honest pricer following the market moves by small fractions. Needs
 *       `priceBefore`, which the scan carries from the roll's ask or the previous reprice; without it the drop is
 *       unknown and only (b)/(c) apply (the message says so).
 *   (b) v2_mon_reprice_foreign_sender (error): the transaction's `from` is not the registry's pricer key
 *       (`v2.bots.pricer`). `ctx.senders` maps tx hash -> from, read by the caller (one eth_getTransactionByHash per
 *       Repriced log, which is rare). An unknown sender (lookup failed) is reported in the warn, never assumed.
 *       With no pricer key in the registry this condition cannot be judged and the warn says so.
 *   (c) v2_mon_repriced (warn) for every reprice that pages nothing, individually up to `t.repriceWarnCap` per run,
 *       the rest folded into ONE summary warn so a busy pricer cannot flood the channel while a page can still
 *       be seen. Nothing here is a silence: a reprice always produces exactly one finding.
 * Keys are `${txHash}:${logIndex}` (event findings dedupe on the key), the summary is keyed on the run's last log.
 * History at or before `adoptUntil` is adopted silently, like every other admin event.
 */
export function repriceFindings(events, adoptUntil, ctx) {
  const t = ctx.t ?? DEFAULTS;
  const fraction = Number(t.repricePageDropFraction ?? DEFAULTS.repricePageDropFraction);
  const cap = Number(t.repriceWarnCap ?? DEFAULTS.repriceWarnCap);
  const pricer = ctx.pricerKey ?? null;
  const senders = ctx.senders ?? new Map();
  const tickerOf = ctx.tickerOf ?? ((u) => shortAddr(u));
  const out = [];
  const quiet = [];
  const ordered = events
    .filter((e) => e.eventName === "Repriced")
    .filter((e) => adoptUntil === null || BigInt(e.blockNumber) > BigInt(adoptUntil))
    .sort((a, b) => (a.blockNumber === b.blockNumber ? Number(a.logIndex) - Number(b.logIndex) : BigInt(a.blockNumber) < BigInt(b.blockNumber) ? -1 : 1));
  for (const e of ordered) {
    const a = e.args ?? {};
    const key = `${lc(e.transactionHash)}:${e.logIndex}`;
    const ticker = tickerOf(a.underlying);
    const price = BigInt(a.price);
    const before = e.priceBefore === null || e.priceBefore === undefined ? null : BigInt(e.priceBefore);
    const from = senders.get(lc(e.transactionHash)) ?? null;
    const at = `block ${e.blockNumber}, tx ${e.transactionHash}`;
    const move = before === null ? "from an ask the scan never saw" : before === price ? "unchanged" : before > price ? `${usdg(before)} -> ${usdg(price)} (-${Number(((before - price) * 10_000n) / before) / 100} %)` : `${usdg(before)} -> ${usdg(price)} (up)`;
    const data = { writer: a.writer, underlying: a.underlying, ticker, oldOrderId: a.oldOrderId.toString(), newOrderId: a.newOrderId.toString(), price: price.toString(), priceBefore: before === null ? null : before.toString(), sender: from, pricerKey: pricer, blockNumber: e.blockNumber, transactionHash: e.transactionHash };
    // (a) the floor-ward step: measured against the cap the contract enforces, never against a typed-in number.
    let floorward = false;
    if (before !== null && before > price) {
      const dropBps = ((before - price) * 10_000n) / before;
      floorward = Number(dropBps) >= fraction * MAX_REPRICE_DROP_BPS;
    }
    // (b) the sender: judged only when both sides are known.
    const foreign = pricer !== null && from !== null && !sameAddress(from, pricer);
    if (foreign) {
      out.push(finding("v2_mon_reprice_foreign_sender", key, "config", `AutoRoller.Repriced for ${shortAddr(a.writer)} on ${ticker} in ${at} was sent by ${from}, which is NOT the registry pricer key ${pricer}: ${move}. The PRICER role is held by another key, or the registry is stale; treat the key as leaked until the sender is owned (revoke PRICER through OPS_ADMIN, delay 0)`, data));
    }
    if (floorward) {
      out.push(finding("v2_mon_reprice_floorward", key, "config", `AutoRoller.Repriced for ${shortAddr(a.writer)} on ${ticker} in ${at}: ${move}, at least ${Math.round(fraction * 100)} % of the per-call cap (${MAX_REPRICE_DROP_BPS / 100} %). A key walking the ask to the writer's floor sends steps this size; ${foreign ? "and the sender is foreign (see v2_mon_reprice_foreign_sender)" : from === null ? "the sender could not be read" : "the sender is the registry pricer key"}. Each further step is another page; revoke PRICER through OPS_ADMIN (delay 0) before the ask is at the floor`, data));
    }
    if (!floorward && !foreign) quiet.push({ e, key, ticker, a, move, from, data });
  }
  const shown = quiet.slice(0, cap);
  for (const q of shown) {
    const senderNote = pricer === null ? "no pricer key in the registry, so the sender was not judged" : q.from === null ? "the sender could not be read" : "sent by the registry pricer key";
    out.push(finding("v2_mon_repriced", q.key, "config", `AutoRoller.Repriced for ${shortAddr(q.a.writer)} on ${q.ticker} in block ${q.e.blockNumber}, tx ${q.e.transactionHash}: ${q.move}; ${senderNote}`, q.data));
  }
  const rest = quiet.slice(cap);
  if (rest.length > 0) {
    const last = rest[rest.length - 1];
    out.push(finding("v2_mon_repriced", `${last.key}:summary`, "config", `${rest.length} more AutoRoller.Repriced in this run (${[...new Set(rest.map((q) => q.ticker))].join(", ")}), none of them a floor-ward step or a foreign sender; individual warns capped at ${cap} per run (--threshold repriceWarnCap)`, { count: rest.length, first: rest[0].key, last: last.key, cap }));
  }
  return out;
}

export function managerEventFindings(events, adoptUntil, ctx) {
  const out = [];
  const m = ctx.manifest ?? null;
  const who = (a) => {
    const name = ctx.names?.[lc(a)];
    return name === undefined ? a : `${name} ${shortAddr(a)}`;
  };
  for (const e of events) {
    const isOperation = MANAGER_OPERATION_EVENTS.has(e.eventName);
    if (!isOperation && !MANAGER_ROLE_EVENTS.has(e.eventName)) continue;
    if (adoptUntil !== null && BigInt(e.blockNumber) <= BigInt(adoptUntil)) continue;
    const a = e.args ?? {};
    const at = `block ${e.blockNumber}, tx ${e.transactionHash}`;
    const key = `${lc(e.transactionHash)}:${e.logIndex}`;
    const unowned = "if nobody owns it, treat the Admin Safe as compromised";
    const data = { event: e.eventName, args: a, blockNumber: e.blockNumber, transactionHash: e.transactionHash };

    if (isOperation) {
      const nonce = Number(a.nonce);
      let severity = e.eventName === "OperationCanceled" ? "warn" : "error";
      let why;
      if (e.eventName === "OperationScheduled") {
        const sel = selectorOf(a.data);
        const hit = manifestRoleOf(sel, ctx.selectors);
        const when = Number(a.schedule);
        const what = hit === null ? `selector ${sel ?? "(no calldata)"} (not in the role manifest: it belongs to ADMIN unless the manifest is stale)` : `${hit.contract}.${hit.signature} (${hit.role})`;
        const guard = hit === null || m === null ? "" : m.roleGuardian?.[hit.role] === undefined ? `; ${hit.role} has no guardian, so only its own admin can cancel this` : `; the ${m.roleGuardian[hit.role]} role can cancel it until then`;
        why = `${who(a.caller)} scheduled ${what} on ${who(a.target)}, executable from ${iso(when)}${ctx.now === null || ctx.now === undefined ? "" : ` (in ${duration(when - ctx.now)})`}${guard}. A scheduled operation expires one week after it becomes executable`;
      } else if (e.eventName === "OperationExecuted") {
        why = "a scheduled operation ran: the state it changes has changed now, not when it was scheduled";
      } else {
        why = "a scheduled operation was cancelled. If the guardian did it this is the brake working; if it was not the guardian, something cancelled a planned change";
      }
      out.push(finding("v2_mon_manager_operation", key, "config", `AccessManager.${e.eventName}(${a.operationId}, nonce ${nonce}) in ${at}: ${why}; ${unowned}`, { ...data, operationId: a.operationId, nonce }, { severity }));
      continue;
    }

    let severity = e.eventName === "RoleLabel" ? "warn" : "error";
    let why;
    const role = a.roleId === undefined ? null : roleLabel(a.roleId, m);
    if (e.eventName === "ManagerRoleGranted") {
      const delay = Number(a.delay);
      const want = a.roleId === undefined ? null : roleDelayS(a.roleId, m);
      const wrong = want !== null && delay !== want ? ` The manifest gives ${role} an execution delay of ${duration(want)}; this grant carries ${duration(delay)}, so this member can act on a different clock from the published one.` : "";
      why = `${role} granted to ${who(a.account)} with an execution delay of ${duration(delay)} from ${iso(Number(a.since))}, ${a.newMember === true ? "a new member" : "an existing member re-granted (a re-grant CHANGES the delay; a reduction only takes effect after the difference has elapsed)"}.${wrong}`;
    } else if (e.eventName === "ManagerRoleRevoked") {
      why = `${role} revoked from ${who(a.account)}. If this was the last holder of a role something depends on, that lane is now dead rather than merely delayed`;
    } else if (e.eventName === "ManagerRoleAdminChanged") {
      const want = m?.roleAdmin?.[m?.names?.[Number(a.roleId)]];
      const admin = roleLabel(a.admin, m);
      why = `the role that may grant and revoke ${role} is now ${admin}${want === undefined ? "" : ` (the manifest says ${want})`}`;
    } else if (e.eventName === "RoleGuardianChanged") {
      const want = m?.roleGuardian?.[m?.names?.[Number(a.roleId)]];
      why = `the role that may cancel ${role}'s scheduled operations is now ${roleLabel(a.guardian, m)}${want === undefined ? "" : ` (the manifest says ${want})`}. A brake that moved is a brake nobody is holding`;
    } else if (e.eventName === "RoleGrantDelayChanged") {
      why = `the delay before a ${role} grant takes effect is now ${duration(Number(a.delay))}, from ${iso(Number(a.since))}`;
    } else if (e.eventName === "RoleLabel") {
      why = `${role} was labelled ${JSON.stringify(a.label)}. Labels are cosmetic; the id is what the manifest pins`;
    } else if (e.eventName === "TargetFunctionRoleUpdated") {
      const sel = typeof a.selector === "string" ? lc(a.selector) : null;
      const hit = manifestRoleOf(sel, ctx.selectors);
      why = `${who(a.target)} ${hit === null ? `selector ${sel ?? "(unknown)"}` : `${hit.contract}.${hit.signature}`} now needs ${role}${hit === null ? " (this selector is not in the role manifest)" : hit.role === m?.names?.[Number(a.roleId)] ? "" : ` (the manifest says ${hit.role})`}`;
    } else if (e.eventName === "TargetAdminDelayUpdated") {
      why = `${who(a.target)}'s own admin delay is now ${duration(Number(a.delay))} from ${iso(Number(a.since))}`;
    } else {
      why = `${who(a.target)} is ${a.closed === true ? "CLOSED: every restricted call on it reverts" : "open again"}`;
    }
    out.push(finding("v2_mon_manager_role", key, "config", `AccessManager.${e.eventName} in ${at}: ${why}; ${unowned}`, data, { severity }));
  }
  return out;
}

/**
 * INTERFACE_VERSION 8. The manager's state against the published manifest. Events say what CHANGED; this says
 * whether what is there now is what `ops/abis/v2/roles.json` says should be there — which is the half that
 * survives a monitor restart and the half that catches a change made before the first run.
 *
 *   x = { manager, rows: [{ roleId, name, chainAdmin, chainGuardian, chainGrantDelay, wantAdmin, wantGuardian }],
 *         members: [{ label, address, roleId, roleName, isMember, executionDelay, wantMember, wantDelayS }] }
 *
 * A null chain value is UNKNOWN (the read failed) and is judged by nothing: the caller records the read failure
 * and the check goes incomplete. It is never read as 0, which would say "no delay" about a role nobody could read.
 */
export function checkManagerWiring(x) {
  const out = [];
  const at = lc(x.manager);
  for (const r of x.rows ?? []) {
    if (r.chainAdmin !== null && r.wantAdmin !== null && Number(r.chainAdmin) !== Number(r.wantAdmin)) {
      out.push(
        finding(
          "v2_mon_manager_wiring",
          `${at}:${r.roleId}:admin`,
          "config",
          `AccessManager: ${roleLabel(r.roleId)}'s admin role is ${roleLabel(r.chainAdmin)} on chain, and the manifest (ops/abis/v2/roles.json) says ${roleLabel(r.wantAdmin)}. Whoever holds the admin role can grant this one to anybody`,
          { role: r.name, roleId: r.roleId, chain: Number(r.chainAdmin), manifest: Number(r.wantAdmin) },
        ),
      );
    }
    if (r.chainGuardian !== null && r.wantGuardian !== null && Number(r.chainGuardian) !== Number(r.wantGuardian)) {
      out.push(
        finding(
          "v2_mon_manager_wiring",
          `${at}:${r.roleId}:guardian`,
          "config",
          `AccessManager: ${roleLabel(r.roleId)}'s guardian is ${roleLabel(r.chainGuardian)} on chain, and the manifest says ${roleLabel(r.wantGuardian)}. The guardian is what cancels a scheduled operation in this lane before it runs`,
          { role: r.name, roleId: r.roleId, chain: Number(r.chainGuardian), manifest: Number(r.wantGuardian) },
        ),
      );
    }
  }
  for (const mb of x.members ?? []) {
    if (mb.isMember === null) continue;
    const key = `${at}:${mb.roleId}:${lc(mb.address)}`;
    if (mb.wantMember && mb.isMember !== true) {
      out.push(
        finding(
          "v2_mon_manager_wiring",
          `${key}:missing`,
          "config",
          `AccessManager: ${mb.label} (${mb.address}) does NOT hold ${roleLabel(mb.roleId)}, which the manifest gives it. Every call that needs this role reverts until it is granted`,
          { role: mb.roleName, roleId: mb.roleId, account: mb.address, holder: mb.label },
        ),
      );
      continue;
    }
    if (!mb.wantMember && mb.isMember === true) {
      out.push(
        finding(
          "v2_mon_manager_wiring",
          `${key}:extra`,
          "config",
          `AccessManager: ${mb.label} (${mb.address}) holds ${roleLabel(mb.roleId)} and the manifest does not give it that role`,
          { role: mb.roleName, roleId: mb.roleId, account: mb.address, holder: mb.label },
        ),
      );
      continue;
    }
    if (mb.isMember === true && mb.executionDelay !== null && mb.wantDelayS !== null && Number(mb.executionDelay) !== Number(mb.wantDelayS)) {
      out.push(
        finding(
          "v2_mon_manager_wiring",
          `${key}:delay`,
          "config",
          `AccessManager: ${mb.label} holds ${roleLabel(mb.roleId)} with an execution delay of ${duration(Number(mb.executionDelay))}, and the manifest says ${duration(Number(mb.wantDelayS))}. The delay IS the protection: a shorter one is less time to notice and cancel, and a longer one is an emergency brake that arrives late`,
          { role: mb.roleName, roleId: mb.roleId, account: mb.address, chainDelayS: Number(mb.executionDelay), manifestDelayS: Number(mb.wantDelayS) },
        ),
      );
    }
  }
  return out;
}

/** A multisig that can be moved by one signature is not a multisig. Both v8 Safes are 2-of-3 (V3-D34). */
export const MIN_SAFE_THRESHOLD = 2;

/**
 * INTERFACE_VERSION 8. An ABSOLUTE floor on a Safe, judged on its own and not against a remembered baseline:
 * `checkSafe` pages when a threshold CHANGES, which says nothing on the first run of a fresh monitor, after a
 * state reset, or about a Safe that was already 1-of-3 when the monitor was first pointed at it. That is the whole
 * failure this exists for, so it must fire with no history at all.
 *
 *   x = { safe, label, threshold (bigint|number|null = unread), owners (number|null = unread) }
 */
export function checkSafeThreshold(x) {
  if (x.threshold === null || x.threshold === undefined) return [];
  const threshold = Number(x.threshold);
  const owners = x.owners === null || x.owners === undefined ? null : Number(x.owners);
  const out = [];
  if (threshold < MIN_SAFE_THRESHOLD) {
    out.push(
      finding(
        "v2_mon_safe_threshold",
        `${lc(x.safe)}:below`,
        "config",
        `${x.label} ${x.safe} needs ${threshold} signature${threshold === 1 ? "" : "s"}${owners === null ? "" : ` of ${owners} owner${owners === 1 ? "" : "s"}`}, below the ${MIN_SAFE_THRESHOLD} of 3 this deployment is meant to run on (V3-D34). One key now moves everything this Safe holds`,
        { safe: x.safe, label: x.label, threshold, owners, minimum: MIN_SAFE_THRESHOLD },
      ),
    );
  }
  if (owners !== null && threshold > owners) {
    out.push(
      finding(
        "v2_mon_safe_threshold",
        `${lc(x.safe)}:unreachable`,
        "config",
        `${x.label} ${x.safe} needs ${threshold} signatures and has ${owners} owner${owners === 1 ? "" : "s"}: no transaction can ever be executed from it`,
        { safe: x.safe, label: x.label, threshold, owners },
      ),
    );
  }
  return out;
}

/**
 * INTERFACE_VERSION 8. The fee splitter's conversion lane.
 *
 *   x = { splitter, now, lastDistributedAt (unix s | null = never seen), pendingSince (unix s | null = nothing is
 *         waiting), floorMisses: [{ asset, ticker, count, lastAt, reason }] }
 *
 * `pendingSince` is the first moment the scan SAW fees arrive at the splitter (a FeesSwept, or a
 * DistributionSkipped) with no Distributed after it. It is evidence, not a balance: this check never claims a
 * split that has not happened, and it never claims one that has.
 */
export function checkSplitter(x, t = DEFAULTS) {
  const out = [];
  const at = lc(x.splitter);
  if (t.splitterIdleS > 0 && x.pendingSince !== null && x.pendingSince !== undefined) {
    const age = x.now - x.pendingSince;
    if (age > t.splitterIdleS) {
      out.push(
        finding(
          "v2_mon_splitter_idle",
          `${at}:idle`,
          "fees",
          `FeeSplitter ${shortAddr(x.splitter)} has had fees waiting since ${iso(x.pendingSince)} (${duration(age)}) and has emitted no Distributed since${x.lastDistributedAt === null ? " (none ever)" : ` ${iso(x.lastDistributedAt)}`}. distribute(asset) is permissionless, so nothing needs a role to fix this: either the cranker's distribute step is not running, or every attempt is being refused (look for DistributionSkipped and its reason)`,
          { splitter: x.splitter, pendingSince: x.pendingSince, ageS: age, lastDistributedAt: x.lastDistributedAt },
        ),
      );
    }
  }
  for (const f of x.floorMisses ?? []) {
    if (f.count < t.splitterFloorMisses) continue;
    out.push(
      finding(
        "v2_mon_splitter_floor_miss",
        `${at}:${lc(f.asset)}`,
        "fees",
        `FeeSplitter: ${f.count} consecutive ${f.reason} skips converting ${f.ticker} (last ${iso(f.lastAt)}). The conversion floor is the oracle's ok spot less the configured slippage and the route fee, so a run of misses means the route cannot fill at the oracle's price: the pool is too thin, the route fee is too high, or the route points at the wrong pool. The tokens are held, not dumped — nothing is lost while this is open, but no fee reaches the treasury or the buyback either`,
        { splitter: x.splitter, asset: f.asset, ticker: f.ticker, reason: f.reason, count: f.count, lastAt: f.lastAt },
      ),
    );
  }
  return out;
}

/**
 * INTERFACE_VERSION 8. The buyback half of the flywheel.
 *
 *   x = { splitter, now, balance (bigint | null = unread), lastBuybackAt (unix s | null = NEVER; the contract
 *         returns 0 before the first buyback and 0 is not a timestamp), fundedSince (unix s | null),
 *         lastSkip ({ reason, at } | null = the contract has refused no buyback since the last one went through),
 *         unburned: [{ transactionHash, usdgIn, tokenOut }] }
 *
 * WHAT `lastSkip` CAN AND CANNOT TELL YOU. `FeeSplitter.buyback` emits `BuybackSkipped` for exactly two reasons:
 * `EMPTY` when the reserve or `buybackCap` is zero, and `NO_EXECUTOR` when `executor` or `stonkhouse` is unset
 * (FeeSplitter.sol:149, :159). Everything else REVERTS -- paused, the cooldown, and an executor that refuses the
 * quote -- so it leaves no event at all. The cranker's own refusals (an unquotable route, a zero `minTokenOut`,
 * `CRANKER_BUYBACK_DRY_RUN`) send no transaction and are therefore INVISIBLE here: a silent cranker and a
 * dry-running cranker look identical from the chain. This check says which of the two it can distinguish and does
 * not pretend to the other.
 *
 * `unburned` is a BoughtBack with no Burned in the same transaction. `buyback` requires the burn to equal the
 * token's measured total-supply delta, so this cannot happen against the published contract — which is exactly
 * why it is worth paging: it means the address emitting BoughtBack is not that contract.
 */
export function checkBuyback(x, t = DEFAULTS) {
  const out = [];
  const at = lc(x.splitter);
  for (const b of x.unburned ?? []) {
    out.push(
      finding(
        "v2_mon_buyback_unburned",
        `${lc(b.transactionHash)}:bought`,
        "fees",
        `FeeSplitter emitted BoughtBack(${usdg(b.usdgIn)} USDG in, ${b.tokenOut} STONKHOUSE out) in tx ${b.transactionHash} with NO Burned in the same transaction. The published contract requires the burn to equal the token's measured total-supply delta, so either this is not that contract or the tokens bought with protocol fees are sitting somewhere instead of being burned. Nothing may report a burn that has not happened`,
        { splitter: x.splitter, transactionHash: b.transactionHash, usdgIn: b.usdgIn, tokenOut: b.tokenOut },
      ),
    );
  }
  if (t.buybackStuckS > 0 && x.balance !== null && x.balance !== undefined && BigInt(x.balance) > 0n) {
    // Ready = the cooldown since the last buy has passed. Never bought = ready now; 0 from the contract means
    // "never", and treating it as a 1970 timestamp would be the same mistake in the other direction.
    const last = buybackClock(x.lastBuybackAt);
    const readyAt = last === null ? null : last + BUYBACK_COOLDOWN;
    // THE CLOCK IS WHEN THIS BALANCE WAS FUNDED, not when the previous buyback happened. Ageing a fresh balance
    // from the last buy makes the page lag by the whole gap between them, which is conservative in the wrong
    // place: the longer the flywheel ran healthily, the later it reports the first failure.
    const since = x.fundedSince ?? last ?? null;
    const age = since === null ? null : x.now - since;
    if ((readyAt === null || x.now >= readyAt) && age !== null && age > t.buybackStuckS) {
      const skip = x.lastSkip ?? null;
      // Only a refusal inside the window explains THIS idle balance. An older one means the contract refused
      // once, the cranker then stopped calling, and "stuck" is still the right page.
      const fresh = skip !== null && skip.at !== null && skip.at !== undefined && x.now - skip.at <= t.buybackStuckS;
      if (fresh) {
        const why =
          skip.reason === "NO_EXECUTOR"
            ? "FeeSplitter.executor or FeeSplitter.stonkhouse is address(0), so buyback() returns without buying. This is deploy wiring, not a stopped bot: setBuybackExecutor / setToken are TREASURY_ADMIN at a 24 h delay, so the fix has to be scheduled"
            : skip.reason === "EMPTY"
              ? `the reserve is ${usdg(x.balance)} USDG, so with buyback() refusing as EMPTY the zero is buybackCap: the cap dial is 0 and the flywheel is switched OFF by configuration, not by a stopped cranker. setBuybackCap is FEE_MANAGER at a 48 h delay`
              : `the contract refused with ${skip.reason}`;
        out.push(
          finding(
            "v2_mon_buyback_skipped",
            `${at}:skipped:${lc(skip.reason)}`,
            "fees",
            `FeeSplitter has ${usdg(x.balance)} USDG set aside and has bought nothing for ${duration(age)}, and the cranker IS calling: the contract emitted BuybackSkipped(${skip.reason}) ${duration(x.now - skip.at)} ago. ${why}. Do not chase the cranker for this one`,
            { splitter: x.splitter, balance: x.balance, lastBuybackAt: last, ageS: age, reason: skip.reason, skippedAgeS: x.now - skip.at },
          ),
        );
      } else {
        out.push(
          finding(
            "v2_mon_buyback_stuck",
            `${at}:stuck`,
            "fees",
            `FeeSplitter has ${usdg(x.balance)} USDG set aside for buybacks and has not bought back for ${duration(age)}${last === null ? " (never)" : ` (last ${iso(last)})`}, with the ${duration(BUYBACK_COOLDOWN)} cooldown long over${skip === null ? ", and the contract has emitted no BuybackSkipped, so nothing has called buyback() and been refused" : `; the last BuybackSkipped(${skip.reason}) was ${duration(x.now - skip.at)} ago, older than the ${duration(t.buybackStuckS)} window, so the contract refused once and then nothing called again`}. buyback() needs the BUYBACK role, which the cranker key holds: check that the cranker's buyback step is running and that its minTokenOut is not refusing every quote. A dry-running cranker (CRANKER_BUYBACK_DRY_RUN) sends no transaction and looks exactly like a stopped one from here`,
            { splitter: x.splitter, balance: x.balance, lastBuybackAt: last, ageS: age, cooldownS: BUYBACK_COOLDOWN, lastSkip: skip },
          ),
        );
      }
    }
  }
  return out;
}

/** A bytes32 `reason` as the ASCII the contracts pack into it (NO_ROUTE, NO_SPOT, BELOW_FLOOR, DUST). */
export function reasonText(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]*$/.test(hex)) return String(hex);
  const bytes = hex.slice(2).match(/../g) ?? [];
  const text = bytes
    .map((b) => Number.parseInt(b, 16))
    .filter((c) => c !== 0)
    .map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : "?"))
    .join("");
  return text === "" ? hex : text;
}

/**
 * INTERFACE_VERSION 8. Fold this run's splitter logs into the remembered flywheel state (pure; exported for tests).
 *
 * The clock is `nowS`, the head timestamp of the run that SAW the log, not the log's own block time: the scan
 * decodes logs, and a log carries a block number rather than a timestamp. Every message built from this state
 * therefore says "first seen", and the ages it reports are ages since the monitor saw the evidence. That is a
 * weaker statement than the block time would be and it is the true one.
 *
 * Returns the BoughtBack logs with no Burned in the same transaction, which is the one thing that cannot wait for
 * a threshold: nothing may report a burn that has not happened.
 */
export function applyFlywheelLogs(fly, events, nowS, splitter) {
  fly.lastDistributedAt ??= null;
  fly.pendingSince ??= null;
  fly.floorMisses ??= {};
  fly.lastBoughtBackAt ??= null;
  fly.fundedSince ??= null;
  // The contract's own reason for refusing a buyback. Without this, `BuybackSkipped` is decoded, reaches this
  // switch and falls out of `default`, and `checkBuyback` pages "stuck" with the remedy text for a cranker that
  // is NOT running against a cranker that is running and being refused.
  fly.lastSkip ??= null;
  const burnedIn = new Set();
  const bought = [];
  for (const e of events) {
    if (e.eventName === "Burned") burnedIn.add(lc(e.transactionHash));
  }
  for (const e of events) {
    const a = e.args ?? {};
    switch (e.eventName) {
      case "FeesSwept":
        // Fees only start a clock when they land ON the splitter; a sweep to any other recipient is not its business.
        if (splitter !== null && sameAddress(a.to, splitter)) fly.pendingSince ??= nowS;
        break;
      case "Distributed":
        fly.lastDistributedAt = nowS;
        fly.pendingSince = null;
        delete fly.floorMisses[lc(a.asset)];
        if (BigInt(a.buybackAdded ?? 0n) > 0n) fly.fundedSince ??= nowS;
        break;
      case "DistributionSkipped": {
        const key = lc(a.asset);
        const reason = reasonText(a.reason);
        fly.pendingSince ??= nowS;
        const prev = fly.floorMisses[key];
        fly.floorMisses[key] = prev !== undefined && prev.reason === reason ? { reason, count: prev.count + 1, lastAt: nowS } : { reason, count: 1, lastAt: nowS };
        break;
      }
      case "BoughtBack":
        fly.lastBoughtBackAt = nowS;
        fly.fundedSince = null;
        // A buy that went through answers every refusal before it; keeping the skip would age a resolved one.
        fly.lastSkip = null;
        if (!burnedIn.has(lc(e.transactionHash))) bought.push({ transactionHash: e.transactionHash, usdgIn: a.usdgIn, tokenOut: a.tokenOut });
        break;
      case "BuybackSkipped":
        fly.lastSkip = { reason: reasonText(a.reason), at: nowS };
        break;
      default:
        break;
    }
  }
  return bought;
}

/**
 * `FeeSplitter.lastBuybackAt()` is a uint40 that is **0 before the first buyback**, not a 1970 timestamp.
 * Mapping it is a function of its own, and tested as one, because getting it wrong is silent in the worst
 * direction: an age measured from 0 is fifty-five years, so a splitter that has simply never bought back
 * pages as "stuck since 1970" and the real signal is buried under an absurd one.
 */
export function buybackClock(raw) {
  if (raw === null || raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** IPayoutRouter.Venue as text; an id the enum does not have is named as unknown rather than folded into "none". */
export function routeVenueName(v) {
  if (v === null || v === undefined) return null;
  return ROUTE_VENUES[Number(v)] ?? `venue ${Number(v)} (not in IPayoutRouter.Venue)`;
}

/**
 * `keccak256(abi.encode(PoolKey))`, the v4 pool id, computed the way `build-markets.mjs encodePoolKey` does: five
 * 32-byte words, currencies in v4's sort order. `viem` is passed in rather than imported so this stays pure.
 */
export function v4PoolId(viem, { currency0, currency1, fee, tickSpacing, hooks }) {
  const word = (v) => BigInt(v).toString(16).padStart(64, "0");
  return viem.keccak256(`0x${word(currency0)}${word(currency1)}${word(fee)}${word(tickSpacing)}${word(hooks)}`);
}

/** The two currencies of a route, in v4's sort order (currency0 < currency1). */
export function routeCurrencies(asset, usdgAddress) {
  const [a, b] = [lc(asset), lc(usdgAddress)];
  return a < b ? { currency0: a, currency1: b } : { currency0: b, currency1: a };
}

/**
 * INTERFACE_VERSION 8. THE `routes(address)` COLLISION, fail-closed.
 *
 * `IPayoutRouter.routes` and `UniV3PayoutAdapter.routes` are the same selector (0xd7409659) with different return
 * tuples, and `v2.contracts.payoutAdapter` names the router from interface 8 and the adapter before it. Decoding a
 * router answer with the adapter's list succeeds and reads the venue enum as the pool address: no revert, no error,
 * a wrong address in every route alert. So the address is IDENTIFIED before it is decoded — the adapter answers
 * `factory()` and the router does not — and a disagreement stops the route reads rather than guessing.
 *
 *   x = { address, interfaceVersion (number|null), isAdapter (true | false | null = the probe itself failed) }
 */
export function checkRouteDecode(x) {
  if (x.isAdapter === null || x.isAdapter === undefined || x.interfaceVersion === null || x.interfaceVersion === undefined) return [];
  const wantAdapter = Number(x.interfaceVersion) < 8;
  if (x.isAdapter === wantAdapter) return [];
  return [
    finding(
      "v2_mon_route_decode",
      `${lc(x.address)}:shape`,
      "config",
      x.isAdapter
        ? `the registry says interface ${x.interfaceVersion} and v2.contracts.payoutAdapter ${x.address} answers factory(), so it is the v7 UniV3PayoutAdapter and not the PayoutRouter. Its routes(address) returns (address pool, uint24 fee) where the router returns one (uint8 venue, uint24 fee, int24 tickSpacing, address v3Pool, uint16 feeBps) struct — the selector is the SAME 0xd7409659, so the wrong one decodes without reverting and reads the venue enum as a pool address. Route checks are stopped until the registry and the chain agree`
        : `the registry says interface ${x.interfaceVersion} and v2.contracts.payoutAdapter ${x.address} does not answer factory(), so it is not the v7 UniV3PayoutAdapter the registry describes. routes(address) shares selector 0xd7409659 between the two shapes and the wrong one decodes silently, so route checks are stopped until the registry and the chain agree`,
      { address: x.address, interfaceVersion: Number(x.interfaceVersion), isAdapter: x.isAdapter },
    ),
  ];
}

/**
 * INTERFACE_VERSION 8. A market's route on chain against the one the registry publishes.
 *
 *   x = { ticker, asset, route (the decoded router struct: { venue, fee, tickSpacing, v3Pool, feeBps }, or null
 *         when the read failed), registryRoute (parsePayoutRoute's shape, or null for "no route published"),
 *         poolId (the v4 pool id recomputed from the registry's own key, or null) }
 *
 * A failed read is unknown and judged by nothing. "No route" is a real, published state (winning calls are paid
 * in kind), so it is compared, not skipped.
 */
export function checkRoute(x) {
  if (x.route === null || x.route === undefined) return [];
  const out = [];
  const key = `${lc(x.asset)}`;
  const chainVenue = routeVenueName(x.route.venue);
  const want = x.registryRoute;
  const page = (suffix, message, data, severity = "error") =>
    out.push(finding("v2_mon_route_wiring", `${key}:${suffix}`, "config", message, { ticker: x.ticker, asset: x.asset, chain: { ...x.route, venue: chainVenue }, registry: want, ...data }, { severity }));

  if (want === null) {
    if (Number(x.route.venue) !== 0) {
      page(
        "unpublished",
        `${x.ticker} has a ${chainVenue} payout route on chain (fee ${x.route.fee}, ${Math.ceil(Number(x.route.fee) / 100)} bps) and ops/markets/tier1.json publishes none. Every in-the-money call of this market is being converted through a venue no reviewed registry names`,
        {},
      );
    }
    return out;
  }
  if (Number(x.route.venue) === 0) {
    page(
      "missing",
      `${x.ticker} has NO payout route on chain and the registry publishes a ${want.venue} route (fee ${want.fee}). Every in-the-money call long is paid in Stock Tokens instead of USDG until the route is set — which is safe, and is not what the registry says is meant to happen`,
      {},
    );
    return out;
  }
  if (chainVenue !== want.venue) {
    page("venue", `${x.ticker} routes over ${chainVenue} on chain and the registry publishes ${want.venue}. The two venues price differently and the conversion floor is computed from the oracle either way, so the mismatch is a wiring error, not a market move`, {});
  }
  if (Number(x.route.fee) !== Number(want.fee)) {
    page("fee", `${x.ticker}'s route fee tier is ${x.route.fee} on chain and ${want.fee} in the registry (${Math.ceil(Number(x.route.fee) / 100)} bps against ${Math.ceil(Number(want.fee) / 100)} bps): a different tier is a different pool`, {});
  }
  if (want.venue === "v4" && want.tickSpacing !== null && Number(x.route.tickSpacing) !== Number(want.tickSpacing)) {
    page("tickSpacing", `${x.ticker}'s v4 route has tickSpacing ${x.route.tickSpacing} on chain and ${want.tickSpacing} in the registry: with the same currencies and fee, a different tickSpacing is a different pool id${x.poolId === null ? "" : ` (the registry's key hashes to ${x.poolId})`}`, { registryPoolId: want.poolId, recomputedPoolId: x.poolId });
  }
  if (want.venue === "v4" && x.poolId !== null && want.poolId !== null && lc(x.poolId) !== lc(want.poolId)) {
    page(
      "poolId",
      `${x.ticker}: the v4 pool id the registry pins (${want.poolId}) is not the one its own PoolKey hashes to (${x.poolId}). One of the two is wrong, and a v4 pool has no address, so the id IS the pin — nothing else would catch this`,
      { registryPoolId: want.poolId, recomputedPoolId: x.poolId },
    );
  }
  if (Number(x.route.fee) > MAX_ROUTE_FEE_TIER) {
    page("tier", `${x.ticker}'s route fee tier ${x.route.fee} is above ${MAX_ROUTE_FEE_TIER} (1 %): the Clearinghouse counts at most ${MAX_ROUTE_FEE_BPS} bps of a route's fee, so every conversion misses its floor and pays in kind`, {});
  }
  if (Number(x.route.feeBps) > MAX_ROUTE_FEE_BPS) {
    page(
      "feeBps",
      `${x.ticker}'s cached route fee is ${x.route.feeBps} bps and the Clearinghouse counts at most ${MAX_ROUTE_FEE_BPS}: the floor is computed as if the route were cheaper than it is, so a conversion that just clears the floor still leaves the holder short`,
      {},
      "warn",
    );
  }
  return out;
}

/**
 * INTERFACE_VERSION 8. The STONKHOUSE pool the buyback executes against: hookless by design, because a hook can
 * take a fee out of every swap and `V2Constants.MAX_HOOK_FEE_BPS` is what the design will tolerate.
 *
 *   x = { poolId (published), poolKey (the published key), recomputedPoolId (from that key, or null),
 *         depth (USDG base units | null = UNKNOWN, never 0) }
 *
 * The depth is read from a v4 pool, which needs a PoolManager the registry does not publish yet; until it does,
 * `depth` is null and `tokenPoolMinDepth` set with an unknown depth pages, the same way an unknown source clock
 * fails a set age limit. An unknown depth is not a deep pool.
 */
export function checkTokenPool(x, t = DEFAULTS) {
  const out = [];
  const k = x.poolKey ?? {};
  const id = x.poolId ?? "(unpublished)";
  if (k.hooks !== null && k.hooks !== undefined && !sameAddress(k.hooks, ZERO)) {
    out.push(
      finding(
        "v2_mon_token_pool_fee",
        `${lc(id)}:hooks`,
        "config",
        `the STONKHOUSE pool ${id} is published with the hook ${k.hooks}. The design pins a HOOKLESS pool precisely so no contract can take a cut of, or reorder, a buyback swap; a hooked pool is a different pool with a different id`,
        { poolId: x.poolId, hooks: k.hooks },
      ),
    );
  }
  if (k.fee !== null && k.fee !== undefined && Number(k.fee) / 100 > MAX_HOOK_FEE_BPS) {
    out.push(
      finding(
        "v2_mon_token_pool_fee",
        `${lc(id)}:fee`,
        "config",
        `the STONKHOUSE pool ${id} charges ${Number(k.fee) / 100} bps (fee tier ${k.fee}), above the ${MAX_HOOK_FEE_BPS} bps V2Constants.MAX_HOOK_FEE_BPS allows: that much comes off every buyback before a single token is burned`,
        { poolId: x.poolId, fee: Number(k.fee), maxBps: MAX_HOOK_FEE_BPS },
      ),
    );
  }
  if (x.recomputedPoolId !== null && x.recomputedPoolId !== undefined && x.poolId !== null && x.poolId !== undefined && lc(x.recomputedPoolId) !== lc(x.poolId)) {
    out.push(
      finding(
        "v2_mon_token_pool_fee",
        `${lc(id)}:id`,
        "config",
        `the STONKHOUSE pool id published in shared.token.poolId (${x.poolId}) is not the one shared.token.poolKey hashes to (${x.recomputedPoolId}). A v4 pool has no address, so the id is the only pin there is`,
        { poolId: x.poolId, recomputed: x.recomputedPoolId },
      ),
    );
  }
  if (t.tokenPoolMinDepth > 0) {
    const depth = x.depth === null || x.depth === undefined ? null : BigInt(x.depth);
    if (depth === null) {
      out.push(
        finding(
          "v2_mon_token_pool_depth",
          `${lc(id)}:depth`,
          "config",
          `the STONKHOUSE pool's depth could not be read and --threshold tokenPoolMinDepth is set to ${usdg(t.tokenPoolMinDepth)} USDG. An unknown depth is not a deep pool: either point the monitor at a v4 PoolManager it can read, or clear the threshold`,
          { poolId: x.poolId, depth: null, minimum: String(t.tokenPoolMinDepth) },
        ),
      );
    } else if (depth < BigInt(t.tokenPoolMinDepth)) {
      out.push(
        finding(
          "v2_mon_token_pool_depth",
          `${lc(id)}:depth`,
          "config",
          `the STONKHOUSE pool holds ${usdg(depth)} USDG of usable depth, below the ${usdg(t.tokenPoolMinDepth)} USDG floor: a buyback of the per-call cap moves this pool, so the burn buys fewer tokens than the quote says`,
          { poolId: x.poolId, depth: String(depth), minimum: String(t.tokenPoolMinDepth) },
        ),
      );
    }
  }
  return out;
}

/**
 * INTERFACE_VERSION 8. The owner's external audit is triggered at $1M of value locked (V3-D33), so the monitor
 * says when that is coming rather than when it has passed.
 *
 *   x = { locked (bigint | null = UNKNOWN, because a partial sum presented as a total is worse than no number),
 *         parts: [{ name, amount }],
 *         usdgTotalSupply (bigint | null), headAgeS (number | null),
 *         holdersFound (number), holdersExpected (number) }
 *
 * `locked` is the USDG the protocol's own contracts hold. If ANY part could not be read the caller passes null:
 * a TVL that silently omits the vault would page late, which is the one thing this alert must not do.
 *
 * WHAT CHANGED IN OWN8-09, AND WHY IT CONTRADICTS THE COMMENT THAT USED TO BE HERE.
 *
 * The decision above is kept: an incomplete read is UNKNOWN and no partial sum is ever compared against
 * the trigger. What was wrong was its OUTPUT. Returning `[]` made "I could not read it" and "it has not
 * crossed yet" produce the identical silence, and for THIS alert that is fatal, because the row's own
 * premise is that the owner cannot watch the number: silence is the only thing they ever see, so both
 * states look like safety. So an unknown TVL now pages a FAULT. No partial sum, and no silence.
 *
 * FOUR THINGS FAULT, all under key `fault` so they page once and resolve together:
 *   - the sum could not be completed (`locked` null);
 *   - USDG has no code or no supply, which is what a MIS-REGISTERED address looks like: `balanceOf`
 *     answers 0 for every holder, so the total reads as a genuine, comfortable zero. This is the
 *     discriminator between "the protocol holds nothing" and "we are asking the wrong contract", and
 *     without it a wrong `shared.usdg` silently CLEARS the notice instead of raising it;
 *   - the chain head is older than `tvlMaxAgeS`, so the balances are stale;
 *   - fewer holders were found than the registry should name, so the sum pages LATE by construction.
 *
 * AND ONE MORE, which is the "dark in every shipped configuration" defect: if the trigger is OFF while
 * the protocol demonstrably HOLDS value, that is a fault too. Off with nothing locked is legitimate and
 * stays silent; off with collateral in the contracts is the notice being dark exactly when it matters.
 */
/**
 * The OWN8-09 fault cases: every way this notice can go quiet while looking healthy.
 *
 * One `fault` key rather than four kinds, deliberately. `alertId` is `kind:key`, so one key means one
 * page and one resolution no matter how many of these are true at once — and every one of them has the
 * same operator action, which is "the audit notice is not measuring anything; fix its input". The
 * reasons are all listed in the message, so nothing is lost by sharing the key.
 */
export function tvlFaults(x, t = DEFAULTS) {
  const reasons = [];
  const known = x.locked !== null && x.locked !== undefined;

  if (t.auditTriggerUsdg > 0) {
    if (!known) {
      reasons.push("the USDG balance of at least one protocol contract could not be read, so the total is "
        + "UNKNOWN. A partial sum is never compared against the trigger, so this reads as nothing at all "
        + "unless it pages");
    }
    // A wrong `shared.usdg` is the dangerous case: balanceOf answers 0 for every holder, the total looks
    // like a comfortable zero, and record()/reconcile() would CLEAR a real alert rather than raise one.
    if (x.usdgTotalSupply === null || x.usdgTotalSupply === undefined) {
      reasons.push("USDG's totalSupply could not be read: shared.usdg may not be a token contract on this "
        + "chain, in which case every balanceOf answers 0 and the total reads as a safe zero");
    } else if (BigInt(x.usdgTotalSupply) === 0n) {
      reasons.push("USDG reports a totalSupply of 0: shared.usdg is almost certainly the wrong address, and "
        + "a wrong address makes this notice read zero forever");
    }
    if (x.headAgeS !== null && x.headAgeS !== undefined && Number(x.headAgeS) > t.tvlMaxAgeS) {
      reasons.push(`the chain head is ${Math.round(Number(x.headAgeS))} s old, past the ${t.tvlMaxAgeS} s limit: `
        + "these balances are stale, and a stale total pages LATE");
    }
    if (Number(x.holdersExpected ?? 0) > 0 && Number(x.holdersFound ?? 0) < Number(x.holdersExpected)) {
      reasons.push(`only ${x.holdersFound} of ${x.holdersExpected} value-holding contracts are in the registry, `
        + "so the sum is structurally short and crosses the trigger later than the protocol does");
    }
  } else if (known && BigInt(x.locked) > 0n) {
    // The "dark in every shipped configuration" case. Off with nothing locked is legitimate and silent.
    reasons.push(`the audit trigger is OFF (auditTriggerUsdg 0) while the protocol holds ${usdg(BigInt(x.locked))} `
      + "USDG. Off is a valid choice for an empty protocol; it is not a valid choice for a funded one, and "
      + "nothing else would ever tell the owner this notice is dark");
  }

  if (reasons.length === 0) return [];
  return [
    finding(
      "v2_mon_tvl_audit_trigger",
      "fault",
      "meta",
      `the OWN8-09 external-audit notice cannot measure value locked, so it would stay silent whether or not `
      + `the ${usdg(BigInt(t.auditTriggerUsdg || 0))} USDG trigger had been crossed: ${reasons.join("; ")}. `
      + "Next: run `node ops/v8/tvl-threshold.mjs --registry <registry>` to derive the trigger and the holder "
      + "set it should be measured over, then fix the registry or the monitor's --threshold. Do not read the "
      + "absence of an OWN8-09 page as evidence that TVL is below $1M (owner decision V3-D33)",
      {
        reasons,
        lockedUsdg6: known ? String(x.locked) : null,
        triggerUsdg6: String(t.auditTriggerUsdg),
        usdgTotalSupply: x.usdgTotalSupply === null || x.usdgTotalSupply === undefined ? null : String(x.usdgTotalSupply),
        headAgeS: x.headAgeS ?? null,
        holdersFound: x.holdersFound ?? null,
        holdersExpected: x.holdersExpected ?? null,
      },
      { severity: "error" },
    ),
  ];
}

export function checkTvl(x, t = DEFAULTS) {
  const faults = tvlFaults(x, t);
  if (faults.length > 0) return faults;
  if (t.auditTriggerUsdg <= 0 || x.locked === null || x.locked === undefined) return [];
  const locked = BigInt(x.locked);
  const trigger = BigInt(t.auditTriggerUsdg);
  const half = trigger / 2n;
  if (locked < half) return [];
  const full = locked >= trigger;
  return [
    finding(
      "v2_mon_tvl_audit_trigger",
      full ? "full" : "half",
      "meta",
      `${usdg(locked)} USDG is locked in the v8 contracts${x.parts === undefined ? "" : ` (${x.parts.map((p) => `${p.name} ${usdg(p.amount)}`).join(", ")})`}: ${full ? `at or past the ${usdg(trigger)} USDG external-audit trigger (owner decision V3-D33). The audit is due now` : `past half of the ${usdg(trigger)} USDG external-audit trigger (owner decision V3-D33). Commissioning an audit takes weeks, so this is the notice, not the deadline`}`,
      { lockedUsdg6: String(locked), triggerUsdg6: String(trigger), parts: (x.parts ?? []).map((p) => ({ name: p.name, amount: String(p.amount) })) },
      { severity: full ? "error" : "warn" },
    ),
  ];
}

/**
 * Pins made outside a series creation. `logs`: this run's decoded SeriesCreated (Clearinghouse), SettlementConfigPinned
 * (SettlementOracle) and source pin logs (FeedPinned, PoolPinned, DataStreamsFeedPinned). A SettlementConfigPinned(u, E)
 * must share its transaction with the Clearinghouse's SeriesCreated(u, E) (the oracle's clearinghouse pointer was moved
 * otherwise); a source pin (u, E) with the oracle's SettlementConfigPinned(u, E) or that SeriesCreated (else it went
 * through the source's oracle allow-list). A transaction's logs always arrive in one scanned range.
 *   ctx = { names, clearinghouse, settlementOracle, markets }
 */
export function prePinFindings(logs, adoptUntil, ctx) {
  const byTx = new Map();
  for (const l of logs) {
    if (!PIN_EVENTS.has(l.eventName)) continue;
    const tx = lc(l.transactionHash);
    if (!byTx.has(tx)) byTx.set(tx, []);
    byTx.get(tx).push(l);
  }
  const ue = (l) => `${lc(l.args.underlying)}:${Number(l.args.expiry)}`;
  const out = [];
  for (const group of byTx.values()) {
    const series = new Set(group.filter((l) => l.eventName === "SeriesCreated" && sameAddress(l.address, ctx.clearinghouse)).map(ue));
    const pinned = new Set(group.filter((l) => l.eventName === "SettlementConfigPinned" && sameAddress(l.address, ctx.settlementOracle)).map(ue));
    for (const l of group) {
      if (l.eventName === "SeriesCreated") continue;
      if (adoptUntil !== null && BigInt(l.blockNumber) <= BigInt(adoptUntil)) continue;
      const k = ue(l);
      const oraclePin = l.eventName === "SettlementConfigPinned";
      if (series.has(k) || (!oraclePin && pinned.has(k))) continue;
      const a = l.args;
      const expiry = Number(a.expiry);
      const ticker = ctx.markets.find((m) => sameAddress(m.asset, a.underlying))?.ticker ?? shortAddr(a.underlying);
      const name = ctx.names[lc(l.address)] ?? l.address;
      const what = oraclePin
        ? `${name}.SettlementConfigPinned(sources [${a.sources.map((s) => ctx.names[lc(s)] ?? s).join(", ")}], ${a.maxDeviationBps} bps, ${a.uncorroboratedDelay} s) without the Clearinghouse's SeriesCreated: pinned through a moved clearinghouse pointer; pinnedBy is not the Clearinghouse`
        : `${name}.${l.eventName === "DataStreamsFeedPinned" ? "FeedPinned" : l.eventName}(${l.eventName === "PoolPinned" ? `pool ${a.pool}, floor ${a.minLiquidity}` : l.eventName === "FeedPinned" ? `feed ${a.feed}, ${a.maxStale} s, ${a.maxRoundJumpBps} bps` : `feedId ${a.feedId}, version ${a.version}`}) without the oracle's SettlementConfigPinned or a SeriesCreated: pinned through the source's oracle allow-list`;
      out.push(
        finding(
          "v2_mon_pre_pin",
          `${lc(l.transactionHash)}:${l.logIndex}`,
          "config",
          `${ticker} expiry ${iso(expiry)}: ${what} (block ${l.blockNumber}, tx ${l.transactionHash}). A pre-pin blocks every series of that expiry (PinMismatch / SourceNotPinned(source, PinMismatch)) unless its configuration is the current one when the series is created; the pins check shows whether it does. Nobody plans this: treat the admin key as compromised`,
          { contract: name, address: l.address, event: l.eventName, ticker, underlying: a.underlying, expiry, args: a, blockNumber: l.blockNumber, transactionHash: l.transactionHash },
        ),
      );
    }
  }
  return out;
}

export const DAY_S = 86400;

/** ExpiryCalendar.closeOf: 16:00 New York of the date with this day index (US DST rule since 2007), unix seconds. */
export function closeOfDay(day) {
  const year = new Date(day * DAY_S * 1000).getUTCFullYear();
  const march1 = Date.UTC(year, 2, 1) / (DAY_S * 1000);
  const dstStart = march1 + ((7 - ((march1 + 4) % 7)) % 7) + 7;
  const november1 = Date.UTC(year, 10, 1) / (DAY_S * 1000);
  const dstEnd = november1 + ((7 - ((november1 + 4) % 7)) % 7);
  return day * DAY_S + (day >= dstStart && day < dstEnd ? 20 * 3600 : 21 * 3600);
}

/**
 * Full-day NYSE closures, as ops/markets/v2-sources.json `nyseHolidays.<year>.fullDays` lists them (the ExpiryCalendar's
 * seed; monitor.test.mjs checks the two agree). The 24/5 equity feeds do not print on them. Early closes are normal days.
 */
export const NYSE_FULL_HOLIDAYS = Object.freeze([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04", "2028-09-04", "2028-11-23", "2028-12-25",
]);
const HOLIDAY_DAYS = new Set(NYSE_FULL_HOLIDAYS.map((d) => Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10))) / (DAY_S * 1000)));

/** 20:00 New York of the date with this day index, unix seconds: the evening the next date's 24/5 session opens. */
export const eveningOfDay = (day) => closeOfDay(day) + 4 * 3600;

/** A 24/5 trading date: a weekday that is not a full NYSE holiday. */
export const isTradingDay = (day, holidays = HOLIDAY_DAYS) => (day + 3) % 7 < 5 && !holidays.has(day);

/**
 * Seconds of open 24/5 market in (from, to]. Trading date D's session runs from 20:00 New York of the day before to
 * 20:00 New York of D, so the market is closed from Friday 20:00 to Sunday 20:00 and from the evening before a full
 * holiday to the holiday's evening. Counts at most the last 60 days (a longer silence is broken either way).
 */
export function openMarketSeconds(from, to, holidays = HOLIDAY_DAYS) {
  const start = Math.max(Number(from), Number(to) - 60 * DAY_S);
  const end = Number(to);
  if (!(end > start)) return 0;
  let total = 0;
  for (let day = Math.floor(start / DAY_S) - 1; day <= Math.floor(end / DAY_S) + 1; day += 1) {
    if (!isTradingDay(day, holidays)) continue;
    const a = Math.max(start, eveningOfDay(day - 1));
    const b = Math.min(end, eveningOfDay(day));
    if (b > a) total += b - a;
  }
  return total;
}

/** The 24/5 market at `now`: open, and since when it has been open without a break (the last reopen), or closed. */
export function marketStretch(now, holidays = HOLIDAY_DAYS) {
  let day = Math.floor(now / DAY_S);
  if (now < eveningOfDay(day - 1)) day -= 1;
  if (!isTradingDay(day, holidays)) return { open: false, reopenedAt: null };
  let first = day;
  while (isTradingDay(first - 1, holidays) && day - first < 30) first -= 1;
  return { open: true, reopenedAt: eveningOfDay(first - 1) };
}

/** Weekday closes a series could be created for now, [now + MIN_SERIES_LEAD, now + MAX_TENOR]; holidays are the calendar's. */
export function gridCloses(now) {
  const from = now + MIN_SERIES_LEAD;
  const to = now + MAX_TENOR;
  const out = [];
  for (let day = Math.floor(from / DAY_S) - 1; day <= Math.floor(to / DAY_S) + 1; day += 1) {
    if ((day + 3) % 7 >= 5) continue;
    const ts = closeOfDay(day);
    if (ts >= from && ts <= to) out.push(ts);
  }
  return out;
}

/**
 * Which expiries of one market the Clearinghouse's pin must be simulated for. Every expiry nobody pinned (pinnedBy 0,
 * no source pin log) gives the same answer, whatever the expiry: the oracle and each source read only their current
 * configuration, allow-list and pointer for it. So one of them (the earliest) stands for all; an expiry pinned by an
 * account other than the Clearinghouse, or with a source pin and no oracle pin, is tried on its own. An expiry the
 * Clearinghouse pinned needs nothing: its next pin returns at once.
 *   expiries ascending; pinnedBy: Map expiry -> address; sourcePinned: Set of expiries
 */
export function pinTargets(expiries, pinnedBy, sourcePinned, clearinghouse) {
  const individual = [];
  let representative = null;
  for (const e of expiries) {
    const by = pinnedBy.get(e) ?? ZERO;
    if (sameAddress(by, ZERO)) {
      if (sourcePinned.has(e)) individual.push(e);
      else if (representative === null) representative = e;
    } else if (!sameAddress(by, clearinghouse)) {
      individual.push(e);
    }
  }
  return { representative, individual };
}

/** Revert data of a pin (hex) as { name, selector, source, reason, reasonSelector }; name null when unknown. */
export function decodePinRevert(raw) {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]*$/.test(raw) || raw.length < 10) return { name: null, selector: null, source: null, reason: null, reasonSelector: null };
  const hex = raw.toLowerCase();
  const selector = hex.slice(0, 10);
  const name = PIN_REVERTS[selector] ?? null;
  if (name !== "SourceNotPinned" || hex.length < 10 + 128) return { name, selector, source: null, reason: null, reasonSelector: null };
  const source = `0x${hex.slice(10 + 24, 10 + 64)}`;
  const reasonSelector = `0x${hex.slice(10 + 64, 10 + 72)}`;
  return { name, selector, source, reason: PIN_REVERTS[reasonSelector] ?? null, reasonSelector };
}

export function pinRevertText(d, names = {}) {
  const src = d.source === null ? "a source" : (names[lc(d.source)] ?? d.source);
  switch (d.name) {
    case "NotAuthorized":
      return "NotAuthorized: the oracle's clearinghouse() is not this Clearinghouse";
    case "NoSource":
      return "NoSource: the oracle has no source list for the market";
    case "PinMismatch":
      return "PinMismatch: the expiry was pinned outside a series creation, and that pin is not the market's current configuration";
    case "SourceNotPinned":
      if (d.reason === "NotAuthorized") return `SourceNotPinned(${src}, NotAuthorized): ${src} does not allow-list the oracle`;
      if (d.reason === "NoSource") return `SourceNotPinned(${src}, NoSource): ${src} has no configuration for the market`;
      if (d.reason === "PinMismatch") return `SourceNotPinned(${src}, PinMismatch): ${src} holds a pin of the expiry that is not its current configuration (a pre-pin)`;
      if (d.reasonSelector === "0x00000000" || d.reasonSelector === null) return `SourceNotPinned(${src}, 0x00000000): ${src} has no code, ran out of gas, or did not answer the pin selector`;
      return `SourceNotPinned(${src}, ${d.reasonSelector})`;
    default:
      return d.selector === null ? "a revert without data" : `an unknown error ${d.selector}`;
  }
}

/**
 * One Clearinghouse pin simulation. x = { ticker, underlying, oracle, expiry, representative, ok, revert (decodePinRevert), names }
 * Keyed per market for the representative (it moves every day), per expiry otherwise.
 */
export function checkPinSimulation(x) {
  if (x.ok) return [];
  const why = pinRevertText(x.revert, x.names);
  const message = x.representative
    ? `${x.ticker}: no series can be created on any expiry nobody has pinned yet (tried ${iso(x.expiry)}): SettlementOracle.pin from the Clearinghouse reverts ${why}`
    : `${x.ticker} expiry ${iso(x.expiry)}: no series of this expiry can be created: SettlementOracle.pin from the Clearinghouse reverts ${why}`;
  return [
    finding("v2_mon_pin_blocked", `${lc(x.underlying)}:${x.representative ? "unpinned" : x.expiry}`, "pins", message, {
      ticker: x.ticker,
      underlying: x.underlying,
      oracle: x.oracle,
      expiry: x.expiry,
      representative: x.representative,
      revert: x.revert,
    }),
  ];
}

/** x = { ticker, underlying, oracle, expiry, pinnedBy, clearinghouse, hasSeries } */
export function checkPinnedBy(x) {
  if (sameAddress(x.pinnedBy, ZERO) || sameAddress(x.pinnedBy, x.clearinghouse)) return [];
  const tail = x.hasSeries
    ? "the expiry has series: someone pointed the oracle's clearinghouse elsewhere and pinned through it (the price cannot change, but its next series must confirm the pin and reverts PinMismatch while the configuration differs)"
    : "the expiry has no series: a pin made outside a series creation (a pre-pin); its first series reverts PinMismatch unless the configuration at creation equals the pin";
  return [
    finding(
      "v2_mon_pinned_by",
      `${lc(x.underlying)}:${x.expiry}`,
      "pins",
      `${x.ticker} expiry ${iso(x.expiry)}: pinnedBy is ${x.pinnedBy}, not the Clearinghouse ${x.clearinghouse}; ${tail}`,
      { ticker: x.ticker, underlying: x.underlying, oracle: x.oracle, expiry: x.expiry, pinnedBy: x.pinnedBy, hasSeries: x.hasSeries },
    ),
  ];
}

/** The pinned configuration the registry publishes for a market (what RegisterMarkets configures). */
export function expectedPinnedConfig(reg, m) {
  const o = m.v2?.overrides ?? {};
  const pick = (k) => (o[k] === null || o[k] === undefined ? reg.defaults[k] : o[k]);
  const pool = m.v2?.univ3Pool ?? null;
  return {
    sources: [reg.sources.chainlink, ...(pool === null ? [] : [reg.sources.univ3])],
    maxDeviationBps: pick("maxDeviationBps"),
    uncorroboratedDelay: pick("uncorroboratedDelayS"),
    spotMaxAge: pick("spotMaxAgeS"),
    feed: m.feed,
    maxStale: CHAINLINK_MAX_STALE,
    maxRoundJumpBps: CHAINLINK_MAX_ROUND_JUMP_BPS,
    pool,
    minLiquidity: m.v2?.univ3MinLiquidity ?? null,
    window: UNIV3_WINDOW,
  };
}

/**
 * An expiry with series against the registry. Returns { findings, verified } (verified: nothing differs and no source
 * whose pin can still move, the Data Streams source, is listed; a verified pin never changes again).
 *   x = { ticker, underlying, expiry, oracle (the series'), publishedOracle, expected (expectedPinnedConfig, null = not a
 *         registry market), sources: { chainlink, univ3, dataStreams } (registry addresses), names,
 *         config: { pinned, sources, maxDeviationBps, uncorroboratedDelay, spotMaxAge },
 *         chainlink: { feed, maxStale, maxRoundJumpBps, pinned } | null, univ3: { pool, minLiquidity, window, pinned } | null,
 *         dataStreams: { pinned, version, currentVersion } | null }
 */
export function checkPinnedConfig(x) {
  const diffs = [];
  const nameOf = (a) => x.names[lc(a)] ?? a;
  const foreign = !sameAddress(x.oracle, x.publishedOracle);
  if (foreign) diffs.push(`its series settle on oracle ${x.oracle}, not the published SettlementOracle ${x.publishedOracle} (its pin is not read)`);
  if (x.expected === null) diffs.push(`${x.underlying} is not a registry market`);
  const listed = (addr) => addr !== null && x.config.pinned && x.config.sources.some((s) => sameAddress(s, addr));
  if (foreign) {
    // nothing of that oracle is compared
  } else if (!x.config.pinned) {
    diffs.push("settlementConfig reports it NOT pinned: it settles on whatever the market's configuration is when it is captured");
  } else if (x.expected !== null) {
    const got = x.config.sources.map(lc).join(",");
    const want = x.expected.sources.map((s) => lc(s ?? ZERO)).join(",");
    if (got !== want) diffs.push(`sources [${x.config.sources.map(nameOf).join(", ")}] instead of [${x.expected.sources.map((s) => (s === null ? "?" : nameOf(s))).join(", ")}]`);
    for (const [field, want] of [
      ["maxDeviationBps", x.expected.maxDeviationBps],
      ["uncorroboratedDelay", x.expected.uncorroboratedDelay],
      ["spotMaxAge", x.expected.spotMaxAge],
    ]) {
      if (Number(x.config[field]) !== Number(want)) diffs.push(`${field} ${x.config[field]} instead of ${want}`);
    }
    if (listed(x.sources.chainlink)) {
      const c = x.chainlink;
      if (c === null || !c.pinned) diffs.push("ChainlinkFeedSource holds no pin of the expiry");
      else {
        if (!sameAddress(c.feed, x.expected.feed)) diffs.push(`Chainlink feed ${c.feed} instead of ${x.expected.feed}`);
        if (Number(c.maxStale) !== x.expected.maxStale) diffs.push(`Chainlink maxStale ${c.maxStale} s instead of ${x.expected.maxStale}`);
        if (Number(c.maxRoundJumpBps) !== x.expected.maxRoundJumpBps) diffs.push(`Chainlink maxRoundJumpBps ${c.maxRoundJumpBps} instead of ${x.expected.maxRoundJumpBps}`);
      }
    }
    if (listed(x.sources.univ3)) {
      const u = x.univ3;
      if (u === null || !u.pinned) diffs.push("UniV3TwapSource holds no pin of the expiry");
      else {
        if (!sameAddress(u.pool, x.expected.pool ?? ZERO)) diffs.push(`pool ${u.pool} instead of ${x.expected.pool}`);
        if (x.expected.minLiquidity !== null && BigInt(u.minLiquidity) !== BigInt(x.expected.minLiquidity)) diffs.push(`pool floor ${u.minLiquidity} instead of ${x.expected.minLiquidity}`);
        if (Number(u.window) !== x.expected.window) diffs.push(`pool window ${u.window} s instead of ${x.expected.window}`);
      }
    }
  }
  const dsListed = listed(x.sources.dataStreams);
  if (dsListed) {
    const d = x.dataStreams;
    if (d === null || !d.pinned) diffs.push("DataStreamsSource holds no pin of the expiry");
    else if (BigInt(d.version) !== BigInt(d.currentVersion)) diffs.push(`the Data Streams feed changed after the pin (feedVersion ${d.version} -> ${d.currentVersion}): that source no longer prices the expiry unless it recorded the window`);
  }
  if (diffs.length === 0) return { findings: [], verified: !dsListed };
  return {
    verified: false,
    findings: [
      finding(
        "v2_mon_pin_mismatch",
        `${lc(x.underlying)}:${x.expiry}`,
        "pins",
        `${x.ticker} expiry ${iso(x.expiry)} has series pinned to a configuration the registry does not publish: ${diffs.join("; ")}. Its series settle on this pin and nobody can change it now`,
        { ticker: x.ticker, underlying: x.underlying, oracle: x.oracle, expiry: x.expiry, differences: diffs, config: x.config, chainlink: x.chainlink, univ3: x.univ3, dataStreams: x.dataStreams },
      ),
    ],
  };
}

/** A registered market whose Clearinghouse row points NEW series at an oracle that is not the published one. */
export function checkMarketOracle(x) {
  if (sameAddress(x.oracle, x.publishedOracle)) return [];
  return [
    finding(
      "v2_mon_pin_mismatch",
      `${lc(x.underlying)}:market-oracle`,
      "pins",
      `${x.ticker}: the Clearinghouse's market row points new series at oracle ${x.oracle}, not the published SettlementOracle ${x.publishedOracle}; every series created from now on settles there`,
      { ticker: x.ticker, underlying: x.underlying, oracle: x.oracle, publishedOracle: x.publishedOracle },
    ),
  ];
}

/* ---------------------------------------------------------------------------------------------- */
/*  dedupe                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

export const alertId = (f) => `${f.kind}:${f.key}`;

/**
 * Merge this run's findings into the remembered alerts (mutates `alerts`). Returns what to send:
 *   new         first sighting
 *   retry       seen before, never delivered (an event is retried from memory even when not re-found)
 *   escalated   severity rose above what was delivered
 *   reminder    an open condition, repeatS after its last delivery (repeatS 0: never)
 * and what resolved: a remembered CONDITION whose owning check completed this run without finding
 * it again. It is forgotten; it is reported as resolved when a warn or error was delivered for it. A
 * condition whose check did not complete stays open (a failed read never clears an alert). Events
 * never resolve; they are forgotten eventRetentionS after first sight.
 */
export function reconcile(alerts, findings, { completed, nowS, repeatS = DEFAULTS.repeatS, eventRetentionS = DEFAULTS.eventRetentionS }) {
  const send = [];
  const resolved = [];
  const seen = new Set();
  for (const f of findings) {
    const id = alertId(f);
    if (seen.has(id)) continue;
    seen.add(id);
    const e = alerts[id];
    if (e === undefined) {
      alerts[id] = {
        kind: f.kind,
        key: f.key,
        check: f.check,
        severity: f.severity,
        event: f.event,
        message: f.message,
        data: f.event ? f.data : undefined,
        firstSeen: nowS,
        lastSeen: nowS,
        delivered: false,
        sentAt: null,
        sentSeverity: null,
      };
      send.push({ id, finding: f, reason: "new" });
      continue;
    }
    e.lastSeen = nowS;
    e.message = f.message;
    e.severity = f.severity;
    e.check = f.check;
    if (!e.delivered) send.push({ id, finding: f, reason: "retry" });
    else if (RANK[f.severity] > RANK[e.sentSeverity ?? "info"]) send.push({ id, finding: f, reason: "escalated" });
    else if (!e.event && repeatS > 0 && nowS - e.sentAt >= repeatS) send.push({ id, finding: f, reason: "reminder" });
  }
  for (const [id, e] of Object.entries(alerts)) {
    if (seen.has(id)) continue;
    if (e.event) {
      if (!e.delivered) {
        send.push({ id, finding: { kind: e.kind, key: e.key, check: e.check, severity: e.severity, event: true, message: e.message, data: e.data ?? {} }, reason: "retry" });
      } else if (nowS - e.firstSeen >= eventRetentionS) {
        delete alerts[id];
      }
      continue;
    }
    if (!completed.has(e.check)) continue;
    delete alerts[id];
    if (e.delivered && RANK[e.sentSeverity ?? "info"] >= RANK.warn) resolved.push({ id, entry: e });
  }
  return { send, resolved };
}

export function markDelivered(alerts, id, severity, nowS) {
  const e = alerts[id];
  if (e === undefined) return;
  e.delivered = true;
  e.sentAt = nowS;
  e.sentSeverity = severity;
}

/** The v2_mon_resolved notification for a forgotten condition. */
export function resolvedFinding(entry, nowS) {
  return finding(
    "v2_mon_resolved",
    `${entry.kind}:${entry.key}`,
    "meta",
    `resolved: ${entry.message}`,
    { resolvedKind: entry.kind, key: entry.key, openedAt: entry.firstSeen, openFor: nowS - entry.firstSeen, severity: entry.sentSeverity },
  );
}

/** The relay payload (relay/src/payload.ts), keeper shape. */
export function alertPayload(f, { chainId, nowMs, reason }) {
  if (!KIND_RE.test(f.kind)) throw new Error(`kind ${f.kind} is not a relay identifier`);
  const spec = KINDS[f.kind];
  const prefix = reason === "reminder" ? "still open: " : reason === "escalated" ? "escalated: " : "";
  return {
    source: SOURCE,
    kind: f.kind,
    severity: f.severity,
    message: `${prefix}${f.message}`,
    chainId,
    at: new Date(nowMs).toISOString(),
    data: JSON.parse(JSON.stringify({ key: f.key, reason, runbook: spec?.runbook ?? null, ...f.data }, bigintReplacer)),
  };
}

export function exitCodeFor({ findings, deliveryFailures, incompleteChecks }) {
  if (deliveryFailures > 0) return 4;
  if (incompleteChecks > 0) return 3;
  if (findings.some((f) => RANK[f.severity] >= RANK.warn)) return 1;
  return 0;
}

/* ---------------------------------------------------------------------------------------------- */
/*  registry, arguments, state                                                                     */
/* ---------------------------------------------------------------------------------------------- */

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const addrOrNull = (v, where) => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !ADDRESS_RE.test(v)) throw new UsageError(`registry ${where}: not an address (${JSON.stringify(v)})`);
  return v;
};
const bigOrNull = (v, where) => {
  if (v === null || v === undefined || v === "") return null;
  if (!/^\d+$/.test(String(v))) throw new UsageError(`registry ${where}: not a non-negative integer (${JSON.stringify(v)})`);
  return BigInt(v);
};

export const CONTRACT_NAMES = [
  "clearinghouse",
  "orderBook",
  "settlementOracle",
  "expiryCalendar",
  "keeperRewards",
  "autoRoller",
  // INTERFACE_VERSION 8 keeps this key and points it at the PayoutRouter (V8-DESIGN §6A). See PAYOUT_ROUTES_ABI.
  "payoutAdapter",
  "makerVault",
  "makerRegistry",
  "rewardsDistributor",
  // INTERFACE_VERSION 8.
  "accessManager",
];

/** `v2.flywheel` (INTERFACE_VERSION 8): the fee splitter and the buyback executor, null until the deploy write-back. */
export const FLYWHEEL_NAMES = ["feeSplitter", "buybackExecutor"];

/**
 * INTERFACE_VERSION 8 (03-INTERFACES §4): `markets[].v2.payoutRoute` is null (no route: winning calls are paid in
 * Stock Tokens), `{ venue: "v3", fee }` or `{ venue: "v4", fee, tickSpacing, poolId }`. Shape errors are the
 * registry gate's business (`build-markets.mjs --check`); the monitor only refuses what it cannot compare.
 */
export function parsePayoutRoute(r, where) {
  if (r === null || r === undefined) return null;
  if (typeof r !== "object" || Array.isArray(r)) throw new UsageError(`registry ${where}: not null and not an object`);
  const venue = String(r.venue);
  if (venue !== "v3" && venue !== "v4") throw new UsageError(`registry ${where}.venue: ${JSON.stringify(r.venue)} is not v3 | v4`);
  const int = (v, k) => {
    if (!Number.isInteger(v)) throw new UsageError(`registry ${where}.${k}: not an integer (${JSON.stringify(v)})`);
    return v;
  };
  if (venue === "v3") return { venue, fee: int(r.fee, "fee"), tickSpacing: null, poolId: null };
  const poolId = typeof r.poolId === "string" && /^0x[0-9a-fA-F]{64}$/.test(r.poolId) ? r.poolId : null;
  if (poolId === null) throw new UsageError(`registry ${where}.poolId: not a 32-byte v4 pool id (${JSON.stringify(r.poolId)})`);
  return { venue, fee: int(r.fee, "fee"), tickSpacing: int(r.tickSpacing, "tickSpacing"), poolId };
}

/** The parts of ops/markets/tier1.json the monitor reads. Strict about what it uses, silent about the rest. */
export function parseRegistry(json, file = "(memory)") {
  if (json === null || typeof json !== "object") throw new UsageError(`${file}: not a JSON object`);
  const shared = json.shared ?? {};
  const v2 = json.v2 ?? null;
  const contracts = {};
  for (const name of CONTRACT_NAMES) contracts[name] = addrOrNull(v2?.contracts?.[name], `v2.contracts.${name}`);
  const sources = {
    chainlink: addrOrNull(v2?.contracts?.sources?.chainlink, "v2.contracts.sources.chainlink"),
    univ3: addrOrNull(v2?.contracts?.sources?.univ3, "v2.contracts.sources.univ3"),
    dataStreams: addrOrNull(v2?.contracts?.sources?.dataStreams, "v2.contracts.sources.dataStreams"),
  };
  if (!Array.isArray(json.markets)) throw new UsageError(`${file}: no markets array`);
  const intOrNull = (v, where) => (bigOrNull(v, where) === null ? null : Number(v));
  const settlementParams = (o, where) => ({
    maxDeviationBps: intOrNull(o?.maxDeviationBps, `${where}.maxDeviationBps`),
    uncorroboratedDelayS: intOrNull(o?.uncorroboratedDelayS, `${where}.uncorroboratedDelayS`),
    spotMaxAgeS: intOrNull(o?.spotMaxAgeS, `${where}.spotMaxAgeS`),
  });
  const d = settlementParams(v2?.defaults, "v2.defaults");
  const defaults = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v ?? ORACLE_DEFAULTS[k]]));
  // INTERFACE_VERSION 7 (c05): the shared writer-rent rate, the fallback for a market without one of its own.
  const sharedMintFeePpm = intOrNull(v2?.fees?.mintFeePpm, "v2.fees.mintFeePpm");
  // INTERFACE_VERSION 8. `allowRent` gates what the REGISTRY may publish, not what the chain charges; the rent
  // checks compare the two and never assume one from the other.
  const allowRent = v2?.fees?.allowRent === true;
  // INTERFACE_VERSION 8: the hot keys the role manifest gives roles to. Null = the registry does not name it yet,
  // which is unknown and is never read as "nobody holds that role".
  const bots = {
    cranker: addrOrNull(v2?.bots?.cranker, "v2.bots.cranker"),
    pricer: addrOrNull(v2?.bots?.pricer, "v2.bots.pricer"),
    quoter: addrOrNull(v2?.bots?.quoter, "v2.bots.quoter"),
    guardian: addrOrNull(v2?.bots?.guardian, "v2.bots.guardian"),
  };
  const flywheel = {};
  for (const name of FLYWHEEL_NAMES) flywheel[name] = addrOrNull(v2?.flywheel?.[name], `v2.flywheel.${name}`);
  flywheel.deployBlock = bigOrNull(v2?.flywheel?.deployBlock, "v2.flywheel.deployBlock");
  const safes = {
    admin: addrOrNull(shared.safes?.admin, "shared.safes.admin"),
    treasury: addrOrNull(shared.safes?.treasury, "shared.safes.treasury"),
  };
  const tokenKey = shared.token?.poolKey ?? {};
  const token = {
    address: addrOrNull(shared.token?.address, "shared.token.address"),
    symbol: shared.token?.symbol === undefined || shared.token?.symbol === null ? null : String(shared.token.symbol),
    decimals: intOrNull(shared.token?.decimals, "shared.token.decimals"),
    poolKey: {
      currency0: addrOrNull(tokenKey.currency0, "shared.token.poolKey.currency0"),
      currency1: addrOrNull(tokenKey.currency1, "shared.token.poolKey.currency1"),
      fee: intOrNull(tokenKey.fee, "shared.token.poolKey.fee"),
      tickSpacing: intOrNull(tokenKey.tickSpacing, "shared.token.poolKey.tickSpacing"),
      hooks: addrOrNull(tokenKey.hooks, "shared.token.poolKey.hooks"),
    },
    poolId:
      shared.token?.poolId === null || shared.token?.poolId === undefined
        ? null
        : /^0x[0-9a-fA-F]{64}$/.test(String(shared.token.poolId))
          ? String(shared.token.poolId)
          : (() => {
              throw new UsageError(`registry shared.token.poolId: not a 32-byte v4 pool id (${JSON.stringify(shared.token.poolId)})`);
            })(),
  };
  const markets = json.markets.map((m, i) => {
    const where = `markets[${i}] (${m?.ticker ?? "?"})`;
    return {
      ticker: String(m.ticker),
      asset: addrOrNull(m.asset, `${where}.asset`),
      feed: addrOrNull(m.feed, `${where}.feed`),
      feedAggregator: addrOrNull(m.feedAggregator, `${where}.feedAggregator`),
      feedHeartbeatS: intOrNull(m.feedHeartbeatS, `${where}.feedHeartbeatS`),
      v2:
        m.v2 && typeof m.v2 === "object"
          ? {
              status: String(m.v2.status ?? "planned"),
              univ3Pool: addrOrNull(m.v2.univ3Pool, `${where}.v2.univ3Pool`),
              univ3MinLiquidity: bigOrNull(m.v2.univ3MinLiquidity, `${where}.v2.univ3MinLiquidity`),
              // RegisterMarkets' own precedence: the market's rate, else the shared one, else none.
              mintFeePpm: intOrNull(m.v2.mintFeePpm, `${where}.v2.mintFeePpm`) ?? sharedMintFeePpm,
              // INTERFACE_VERSION 8: where the Clearinghouse's payout converts this market's Stock Token.
              payoutRoute: parsePayoutRoute(m.v2.payoutRoute, `${where}.v2.payoutRoute`),
              overrides: settlementParams(m.v2.overrides, `${where}.v2.overrides`),
            }
          : null,
    };
  });
  return {
    file,
    chainId: shared.chainId === undefined || shared.chainId === null ? null : Number(shared.chainId),
    usdg: addrOrNull(shared.usdg, "shared.usdg"),
    multicall3: addrOrNull(shared.multicall3, "shared.multicall3"),
    deployBlock: bigOrNull(v2?.deployBlock, "v2.deployBlock"),
    // INTERFACE_VERSION 8. null when the registry publishes none: unknown, never "7" and never "8".
    interfaceVersion: intOrNull(v2?.interfaceVersion, "v2.interfaceVersion"),
    allowRent,
    contracts,
    bots,
    flywheel,
    safes,
    token,
    sources,
    defaults,
    markets,
  };
}

/** The markets whose feeds, tokens and pools are watched. */
export function marketsInScope(reg, { tickers = null, allMarkets = false } = {}) {
  const wanted = tickers === null ? null : new Set(tickers.map((t) => t.toUpperCase()));
  return reg.markets.filter((m) => {
    if (m.v2 === null || m.asset === null) return false;
    if (wanted !== null) return wanted.has(m.ticker.toUpperCase());
    return allMarkets || m.v2.status === "live" || m.v2.status === "paused";
  });
}

function parseNamedList(text, what) {
  const out = [];
  if (!text) return out;
  for (const part of String(text).split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = part.indexOf("=");
    if (eq <= 0) throw new UsageError(`${what}: expected name=value, got "${part}"`);
    out.push([part.slice(0, eq).trim(), part.slice(eq + 1).trim()]);
  }
  return out;
}

function addDivergenceBand(bands, ticker, value) {
  const name = ticker.toUpperCase();
  const bps = Number(value);
  if (!/^[A-Z][A-Z0-9.]{0,15}$/.test(name) || !Number.isInteger(bps) || bps < 1 || bps >= 300)
    throw new UsageError(`divergence band ${ticker}=${value}: expected TICKER=1..299 bps`);
  if (bands[name] !== undefined) throw new UsageError(`divergence band ${name}: duplicate`);
  bands[name] = bps;
}

function applyThreshold(thresholds, name, value) {
  if (!(name in DEFAULTS)) throw new UsageError(`unknown threshold "${name}" (one of: ${Object.keys(DEFAULTS).join(", ")})`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`threshold ${name}: not a non-negative number (${value})`);
  thresholds[name] = n;
}

/** A --house TICKER=0xaddress pair. The ticker is a label only: nothing is looked up by it. */
function houseEntry(name, address) {
  if (!/^[A-Z0-9.-]{1,12}$/i.test(name)) throw new UsageError(`--house: bad ticker "${name}"`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new UsageError(`--house ${name}: not an address`);
  return { ticker: name.toUpperCase(), address };
}

function healthEntry(name, url) {
  if (!/^[a-z0-9][a-z0-9_.-]{0,40}$/i.test(name)) throw new UsageError(`--health: bad service name "${name}"`);
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not http");
  } catch {
    throw new UsageError(`--health ${name}: not an http(s) URL`);
  }
  return { name, url };
}

/** A service's base URL (no path of its own; the monitor appends /health, /surface/:ticker, /fair, /state). */
function baseUrl(flag, url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("not http");
  } catch {
    throw new UsageError(`${flag}: not an http(s) URL`);
  }
  return String(url).replace(/\/+$/, "");
}

export const USAGE = `usage: node ops/v2/monitor.mjs --rpc URL [--once | --interval S] [--registry FILE] [--state FILE]
       [--webhook URL] [--health name=url]... [--house TICKER=0xaddr]... [--tickers A,B] [--all-markets] [--threshold name=value]...
       [--divergence-band TICKER=BPS]... [--pricing URL] [--pricer URL]
       [--repeat-hours H] [--max-failed-passes N] [--no-alerts] [--json]
see the header of ops/v2/monitor.mjs; exit 0 clean, 1 findings open, 2 usage, 3 incomplete, 4 delivery failed
in --interval mode the process exits after --max-failed-passes consecutive passes that reached nobody (default 3, 0 = never)`;

export function parseArgs(argv, env = {}) {
  const thresholds = { ...DEFAULTS };
  const divergenceBands = {};
  if (env.MONITOR_DIVERGENCE_BANDS) for (const [ticker, bps] of parseNamedList(env.MONITOR_DIVERGENCE_BANDS, "MONITOR_DIVERGENCE_BANDS")) addDivergenceBand(divergenceBands, ticker, bps);
  if (env.MONITOR_THRESHOLDS) for (const [k, v] of parseNamedList(env.MONITOR_THRESHOLDS, "MONITOR_THRESHOLDS")) applyThreshold(thresholds, k, v);
  if (env.MONITOR_REPEAT_S) applyThreshold(thresholds, "repeatS", env.MONITOR_REPEAT_S);
  const o = {
    help: false,
    once: false,
    intervalS: env.MONITOR_INTERVAL_S ? Number(env.MONITOR_INTERVAL_S) : 60,
    rpc: env.RH_RPC || null,
    registry: env.MONITOR_REGISTRY || env.V2_REGISTRY_PATH || DEFAULT_REGISTRY,
    state: env.MONITOR_STATE_PATH || null,
    webhook: env.ALERT_WEBHOOK || null,
    token: env.ALERT_WEBHOOK_TOKEN || null,
    health: parseNamedList(env.MONITOR_HEALTH, "MONITOR_HEALTH").map(([n, u]) => healthEntry(n, u)),
    // The pricing service's and the pricer's BASE urls (not /health): the pricing check appends its own paths.
    // Absent: the check is skipped whole. They are read-only GETs; nothing here can make either service act.
    pricing: env.MONITOR_PRICING_URL ? baseUrl("MONITOR_PRICING_URL", env.MONITOR_PRICING_URL) : null,
    pricer: env.MONITOR_PRICER_URL ? baseUrl("MONITOR_PRICER_URL", env.MONITOR_PRICER_URL) : null,
    // HouseVaults, as TICKER=0xaddress pairs. They are factory-created per market and the registry cannot
    // name them (build-markets.mjs, WHY THERE IS NO houseVault KEY), so the check is skipped when none is given.
    house: parseNamedList(env.MONITOR_HOUSE_VAULTS, "MONITOR_HOUSE_VAULTS").map(([n, a]) => houseEntry(n, a)),
    tickers: null,
    // T-OP-083. The launch tokens whose OraclePaused()/OracleUnpaused() logs page v2_mon_oracle_halted. Tickers,
    // resolved against the registry at run time; never addresses.
    launch: (env.MONITOR_LAUNCH_TICKERS ?? "NVDA,SPCX").split(",").map((s) => s.trim()).filter(Boolean),
    allMarkets: false,
    dryRun: false,
    json: false,
    // Always-on mode only: consecutive passes that reached nobody (a refused delivery, or a pass that threw)
    // before the process gives up and exits with that pass's code, so the platform restarts it and notifies.
    // Nothing else watches the monitor (ops/alerts.md §V14). 0 disables it.
    maxFailedPasses: env.MONITOR_MAX_FAILED_PASSES ? Number(env.MONITOR_MAX_FAILED_PASSES) : 3,
    thresholds,
    divergenceBands,
  };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        o.help = true;
        break;
      case "--once":
        o.once = true;
        break;
      case "--interval":
        o.intervalS = Number(value(i, a));
        i += 1;
        break;
      case "--max-failed-passes":
        o.maxFailedPasses = Number(value(i, a));
        i += 1;
        break;
      case "--rpc":
        o.rpc = value(i, a);
        i += 1;
        break;
      case "--registry":
        o.registry = value(i, a);
        i += 1;
        break;
      case "--state":
        o.state = value(i, a);
        i += 1;
        break;
      case "--webhook":
        o.webhook = value(i, a);
        i += 1;
        break;
      case "--health": {
        const [[n, u]] = parseNamedList(value(i, a), "--health");
        o.health.push(healthEntry(n, u));
        i += 1;
        break;
      }
      case "--pricing":
        o.pricing = baseUrl(a, value(i, a));
        i += 1;
        break;
      case "--pricer":
        o.pricer = baseUrl(a, value(i, a));
        i += 1;
        break;
      case "--house": {
        for (const [n, addr] of parseNamedList(value(i, a), "--house")) o.house.push(houseEntry(n, addr));
        i += 1;
        break;
      }
      case "--tickers":
        o.tickers = value(i, a).split(",").map((s) => s.trim()).filter(Boolean);
        i += 1;
        break;
      case "--launch":
        o.launch = value(i, a).split(",").map((s) => s.trim()).filter(Boolean);
        i += 1;
        break;
      case "--all-markets":
        o.allMarkets = true;
        break;
      case "--threshold": {
        for (const [k, v] of parseNamedList(value(i, a), "--threshold")) applyThreshold(thresholds, k, v);
        i += 1;
        break;
      }
      case "--divergence-band": {
        for (const [ticker, bps] of parseNamedList(value(i, a), a)) addDivergenceBand(divergenceBands, ticker, bps);
        i += 1;
        break;
      }
      case "--repeat-hours":
        applyThreshold(thresholds, "repeatS", Number(value(i, a)) * 3600);
        i += 1;
        break;
      case "--no-alerts":
        o.dryRun = true;
        break;
      case "--json":
        o.json = true;
        break;
      default:
        throw new UsageError(`unknown argument ${a}`);
    }
  }
  if (o.help) return o;
  if (!o.rpc) throw new UsageError("--rpc (or RH_RPC) is required");
  try {
    const u = new URL(o.rpc);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
  } catch {
    throw new UsageError("--rpc: not an http(s) URL");
  }
  if (!Number.isFinite(o.intervalS) || o.intervalS < 5) throw new UsageError("--interval: at least 5 seconds");
  if (!Number.isInteger(o.maxFailedPasses) || o.maxFailedPasses < 0) throw new UsageError("--max-failed-passes / MONITOR_MAX_FAILED_PASSES: a whole number of passes, 0 to never give up");
  if (o.webhook !== null) {
    try {
      const u = new URL(o.webhook);
      if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
    } catch {
      throw new UsageError("ALERT_WEBHOOK / --webhook: not an http(s) URL (value not shown)");
    }
  }
  return o;
}

export function emptyState(chainId, fingerprint) {
  return {
    version: STATE_VERSION,
    chainId,
    fingerprint,
    anchor: null,
    scan: {
      cursor: null,
      adoptConfigUntil: null,
      series: {},
      holders: {},
      settled: {},
      drained: {},
      expiryDone: {},
      finalized: {},
      rewards: {},
      // INTERFACE_VERSION 6: "<underlying>:<expiry>" -> 1 for every source pin log (FeedPinned, PoolPinned), the fee
      // schedule replay, the calendar's special expiries, the pins check's verified expiries and its cache.
      sourcePins: {},
      fees: { current: null, pending: null, effectiveAt: null },
      special: {},
      pinsVerified: {},
      pinsCache: null,
      // INTERFACE_VERSION 7: the per-series rent ledger and the highest log position counted into it (the scan
      // re-reads its last blocks), the AutoRoller positions to read at the head, and how long each of their asks has
      // been at or past its strike.
      rent: {},
      rentAt: null,
      roller: {},
      rollerStale: {},
      // INTERFACE_VERSION 8: what the fee splitter's own log has shown, stamped with the head timestamp of the run
      // that saw it (a decoded log carries a block number, not a time).
      flywheel: { lastDistributedAt: null, pendingSince: null, floorMisses: {}, lastBoughtBackAt: null, fundedSince: null },
    },
    tokens: { cursor: null, haltCursor: null, oracleHalts: {} },
    // F3 O3-304: the last provider / method / legacy-source label per market (so a switch between two polls is an
    // event, not a silence), and the pricer's last CHANGED evaluation counters with the wall second it changed.
    pricing: { sources: {}, pricer: null },
    feeds: {},
    divergenceStreaks: {},
    safes: {},
    alerts: {},
    pendingResolved: [],
    lastRun: null,
  };
}

export const fingerprintOf = (reg, chainId) => `${chainId}|${lc(reg.contracts.clearinghouse ?? "predeploy")}|${reg.deployBlock ?? "none"}`;

export function defaultStatePath(reg, chainId) {
  const tag = reg.contracts.clearinghouse ? lc(reg.contracts.clearinghouse).slice(2, 10) : "predeploy";
  return path.join(DEFAULT_STATE_DIR, `monitor-${chainId}-${tag}.json`);
}

function loadState(file, chainId, fingerprint, notes) {
  if (!existsSync(file)) return emptyState(chainId, fingerprint);
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    if (s.version !== STATE_VERSION || s.chainId !== chainId || s.fingerprint !== fingerprint) {
      notes.push("state: written for another chain, deployment or version; starting over");
      return emptyState(chainId, fingerprint);
    }
    const fresh = emptyState(chainId, fingerprint);
    return { ...fresh, ...s, scan: { ...fresh.scan, ...s.scan }, tokens: { ...fresh.tokens, ...s.tokens }, pricing: { ...fresh.pricing, ...s.pricing } };
  } catch (error) {
    notes.push(`state: unreadable (${String(error.message).slice(0, 120)}); starting over`);
    return emptyState(chainId, fingerprint);
  }
}

function saveState(file, state) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, bigintReplacer)}\n`);
  renameSync(tmp, file);
}

/** null when a state file can be written at `file`, else why not. Creates the directory if it can. */
export function statePathUnwritable(file) {
  const probe = `${file}.probe`;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return null;
  } catch (error) {
    try {
      rmSync(probe, { force: true });
    } catch {
      // nothing to clean up
    }
    return shortError(error);
  }
}

/* ---------------------------------------------------------------------------------------------- */
/*  chain                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

export function loadViem() {
  const candidates = [process.env.MONITOR_VIEM_FROM, path.join(ROOT, "keeper", "package.json"), path.join(ROOT, "package.json"), path.join(HERE, "package.json")].filter(Boolean);
  for (const c of candidates) {
    try {
      return createRequire(c)("viem");
    } catch {
      // next candidate
    }
  }
  throw new UsageError("cannot load viem: run `pnpm install --frozen-lockfile` at the repository root (viem comes from the keeper package), or set MONITOR_VIEM_FROM");
}

/**
 * The hand-written views. These tuples are POSITIONAL: viem decodes by order and type, not by name, so a field
 * inserted into a struct here (or in the contracts) silently returns the wrong value rather than failing — the reason
 * INTERFACE_VERSION 7 APPENDED `Series.mintFeePpm` / `mintFeesHeld`, `MarketConfig.mintFeePpm` and
 * `Limits.maxDailyOutflow` instead of packing them. Every tuple below must stay field for field
 * equal to ops/abis/v2/*.json; `node --test ops/v2/monitor.test.mjs` compares them against the exported ABIs.
 */
export const ABI_TEXT = {
  clearinghouse: [
    "function openInterest(address underlying, uint40 expiry) view returns (uint256)",
    "function series(uint256 longId) view returns ((address underlying, bool isPut, uint40 expiry, uint128 strike, address oracle, uint16 exerciseFeeBps, bool settled, uint128 settlementPrice, uint128 longPayoutPerUnit, uint128 feePerUnit, uint128 shortPayoutPerUnit, uint32 mintFeePpm, uint128 mintFeesHeld))",
    "function balanceOf(address account, uint256 id) view returns (uint256)",
    "function thirdPartyRedeemAllowed(address account) view returns (bool)",
    "function free(address account, address asset) view returns (uint256)",
    "function mintFee(uint256 longId, uint64 units) view returns (uint256 fee)",
  ],
  oracle: [
    "function settlementInfo(address underlying, uint40 expiry) view returns (uint8 status, uint256 price, uint8 sourceIndex, bool corroborated, bool resolved, bool captured)",
    "function candidate(address underlying, uint40 expiry) view returns (uint256 price, uint8 sourceIndex, bool disagreed, uint40 finalizableAt)",
    "function recordedSources(address underlying, uint40 expiry) view returns (address[] sources, bool[] ok, uint256[] prices, uint16 maxDeviationBps)",
    "function marketConfig(address underlying) view returns (address[] sources, uint16 maxDeviationBps, uint32 uncorroboratedDelay, uint32 spotMaxAge)",
    "function settlementConfig(address underlying, uint40 expiry) view returns (bool pinned, address[] sources, uint16 maxDeviationBps, uint32 uncorroboratedDelay, uint32 spotMaxAge)",
    "function pinnedBy(address underlying, uint40 expiry) view returns (address)",
    "function pin(address underlying, uint40 expiry)",
    "function trySpot(address underlying) view returns (bool ok, uint256 price, uint256 updatedAt)",
  ],
  univ3: [
    "function latest(address underlying) view returns (bool ok, uint256 price, uint256 updatedAt)",
    "function snapshots(address underlying, uint40 expiry) view returns (uint128 price, int24 meanTick, uint40 recordedAt)",
    "function pools(address underlying) view returns (address pool, bool usdgIsToken0, uint8 assetDecimals, uint32 window, uint128 minLiquidity)",
    "function pinnedPools(address underlying, uint40 expiry) view returns (address pool, bool usdgIsToken0, uint8 assetDecimals, uint32 window, bool pinned, uint128 minLiquidity)",
  ],
  chainlinkSource: [
    "function latest(address underlying) view returns (bool ok, uint256 price, uint256 updatedAt)",
    "function feeds(address underlying) view returns (address feed, uint32 maxStale, uint16 maxRoundJumpBps)",
    "function pinnedFeeds(address underlying, uint40 expiry) view returns (address feed, uint32 maxStale, uint16 maxRoundJumpBps, bool pinned)",
  ],
  dataStreamsSource: [
    "function pinnedFeeds(address underlying, uint40 expiry) view returns (bool pinned, uint64 version)",
    "function feedVersion(address underlying) view returns (uint64)",
  ],
  clearinghouseConfig: [
    "function market(address underlying) view returns ((bool enabled, bool mintPaused, uint64 strikeTick, uint16 exerciseFeeBps, address oracle, uint32 mintFeePpm))",
    "function calendar() view returns (address)",
  ],
  calendar: ["function isValidExpiry(uint40 ts) view returns (bool)"],
  orderBook: [
    "function feeParams() view returns ((uint16 premiumFeeBps, uint16 resaleFeeBps, uint32 takerFeeFlat, uint16 takerFeeCapBps, uint16 makerRebateBps))",
    "function pendingFeeParams() view returns ((uint16 premiumFeeBps, uint16 resaleFeeBps, uint32 takerFeeFlat, uint16 takerFeeCapBps, uint16 makerRebateBps) params, uint40 effectiveAt)",
    "function getOrders(uint256[] orderIds) view returns ((address maker, uint256 longId, uint8 kind, uint128 price, uint64 units, uint64 filled, uint40 validUntil, bool cancelled)[] orders)",
    "function isDelegate(address maker, address delegate) view returns (bool)",
  ],
  keeperRewards: ["function bounty(bytes32 action) view returns (uint256)", "function dailyCap() view returns (uint256)", "function spentToday() view returns (uint256)"],
  autoRoller: ["function position(address writer, address underlying) view returns (uint256 longId, uint256 orderId, uint40 expiry)"],
  // The House vaults are FACTORY-CREATED AND PER-MARKET, so the registry names none of them (build-markets.mjs
  // explains why no key can exist) and they are passed in with --house instead.
  houseVault: [
    "function epochEnd() view returns (uint40)",
    "function epochId() view returns (uint64)",
    "function underlying() view returns (address)",
    "function oracle() view returns (address)",
    "function trackedSeries() view returns (uint256[])",
    "function exposure(uint256 longId) view returns (uint256 units, uint256 notional, (uint256 longs, uint256 shorts, uint256 bids, uint256 resale, uint256 writes, uint256 live) detail)",
  ],
  makerVault: [
    "function limits() view returns ((uint64 maxSeriesUnits, uint128 maxTotalNotional, uint16 askToleranceBps, uint16 maxBidBpsOfSpot, uint32 maxOrderLifetime, uint128 maxDailyOutflow))",
    "function outflow() view returns (uint256 used, uint256 available)",
    "function totalNotional() view returns (uint256)",
    "function trackedSeries() view returns (uint256[])",
    "function exposure(uint256 longId) view returns (uint256 units, uint256 notional, (uint256 longs, uint256 shorts, uint256 bids, uint256 resale, uint256 writes, uint256 live) detail)",
  ],
  erc20: ["function balanceOf(address account) view returns (uint256)", "function totalSupply() view returns (uint256)"],
  usdg: ["function paused() view returns (bool)", "function isFrozen(address account) view returns (bool)"],
  stockToken: [
    "function paused() view returns (bool)",
    "function oraclePaused() view returns (bool)",
    "function uiMultiplier() view returns (uint256)",
    "function newUIMultiplier() view returns (uint256)",
    "function effectiveAt() view returns (uint256)",
    "function ACCESS_CONTROLLED_REGISTRY() view returns (address)",
  ],
  stockRegistry: ["function isBlocked(address account) view returns (bool)"],
  feed: [
    "function aggregator() view returns (address)",
    "function accessController() view returns (address)",
    "function owner() view returns (address)",
    "function decimals() view returns (uint8)",
    "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    "function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  ],
  safe: ["function nonce() view returns (uint256)", "function getThreshold() view returns (uint256)", "function getOwners() view returns (address[])"],
  pool: ["function liquidity() view returns (uint128)"],
  /* ---- INTERFACE_VERSION 8 ---- */
  accessManager: [
    "function ADMIN_ROLE() view returns (uint64)",
    "function PUBLIC_ROLE() view returns (uint64)",
    "function expiration() view returns (uint32)",
    "function minSetback() view returns (uint32)",
    "function getAccess(uint64 roleId, address account) view returns (uint48 since, uint32 currentDelay, uint32 pendingDelay, uint48 effect)",
    "function hasRole(uint64 roleId, address account) view returns (bool isMember, uint32 executionDelay)",
    "function getRoleAdmin(uint64 roleId) view returns (uint64)",
    "function getRoleGuardian(uint64 roleId) view returns (uint64)",
    "function getRoleGrantDelay(uint64 roleId) view returns (uint32)",
    "function getTargetFunctionRole(address target, bytes4 selector) view returns (uint64)",
    "function getTargetAdminDelay(address target) view returns (uint32)",
    "function isTargetClosed(address target) view returns (bool)",
    "function getSchedule(bytes32 id) view returns (uint48)",
    "function getNonce(bytes32 id) view returns (uint32)",
  ],
  /**
   * THE `routes(address)` COLLISION. `IPayoutRouter.routes` and `UniV3PayoutAdapter.routes` are BOTH selector
   * 0xd7409659 and return DIFFERENT tuples: the router one struct `(uint8,uint24,int24,address,uint16)`, the adapter
   * two words `(address,uint24)`. Decoding a router answer with the adapter list SUCCEEDS and reads the venue enum
   * as the pool address — no revert, no error, just a wrong address in an alert. `v2.contracts.payoutAdapter` names
   * the router from INTERFACE_VERSION 8 on and the adapter before it, so which list is used is decided by
   * `payoutRoutesAbi()` from the registry's interface version and CONFIRMED on chain before anything is decoded.
   */
  payoutRouter: [
    "function routes(address asset) view returns ((uint8 venue, uint24 fee, int24 tickSpacing, address v3Pool, uint16 feeBps))",
    "function routeFeeBps(address asset) view returns (uint16 feeBps)",
  ],
  payoutAdapter: [
    "function routes(address asset) view returns (address pool, uint24 fee)",
    "function routeFeeBps(address asset) view returns (uint16 feeBps)",
    // The adapter has it and the router does not: the discriminator payoutRoutesAbi() probes with.
    "function factory() view returns (address)",
  ],
  feeSplitter: [
    "function treasury() view returns (address)",
    "function buybackBalance() view returns (uint256)",
    "function lastBuybackAt() view returns (uint40)",
  ],
};

/** The two `routes(address)` shapes, by name, so a test can pin that they really do share one selector. */
export const PAYOUT_ROUTES_ABI = Object.freeze({ 8: "payoutRouter", 7: "payoutAdapter" });

/** Everything the protocol log scan decodes: lifecycle events, bounties, and the admin actions of CONFIG_EVENTS. */
export const SCAN_EVENTS = [
  "event SeriesCreated(uint256 indexed longId, address indexed underlying, bool isPut, uint128 strike, uint40 expiry, address oracle, uint16 exerciseFeeBps, uint32 mintFeePpm)",
  "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
  "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
  "event SeriesSettled(uint256 indexed longId, uint256 settlementPrice, uint256 longPayoutPerUnit, uint256 feePerUnit, uint256 shortPayoutPerUnit)",
  "event SettlementFinalized(address indexed underlying, uint40 indexed expiry, uint256 price, uint8 sourceIndex, bool corroborated)",
  "event SettlementResolved(address indexed underlying, uint40 indexed expiry, uint256 price)",
  "event Rewarded(address indexed keeper, bytes32 indexed action, uint256 amount)",
  "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  "event RoleAdminChanged(bytes32 indexed role, bytes32 indexed previousAdminRole, bytes32 indexed newAdminRole)",
  "event MarketConfigured(address indexed underlying, address[] sources, uint16 maxDeviationBps, uint32 uncorroboratedDelay, uint32 spotMaxAge)",
  "event ClearinghouseSet(address indexed clearinghouse)",
  "event KeeperRewardsSet(address indexed keeperRewards)",
  "event FeedSet(address indexed underlying, address indexed feed, uint32 maxStale, uint16 maxRoundJumpBps)",
  "event PoolSet(address indexed underlying, address indexed pool, bool usdgIsToken0, uint128 minLiquidity, uint32 window)",
  "event MarketRegistered(address indexed underlying, (bool enabled, bool mintPaused, uint64 strikeTick, uint16 exerciseFeeBps, address oracle, uint32 mintFeePpm) config)",
  "event MarketConfigSet(address indexed underlying, (bool enabled, bool mintPaused, uint64 strikeTick, uint16 exerciseFeeBps, address oracle, uint32 mintFeePpm) config)",
  "event CalendarSet(address indexed calendar)",
  "event FeeRecipientSet(address indexed recipient)",
  "event PayoutAdapterSet(address indexed adapter, uint16 maxSlippageBps)",
  "event MinRedeemPayoutSet(uint256 amount)",
  "event BaseUriSet(string baseUri)",
  "event CreatePausedSet(bool paused)",
  "event MintPausedSet(address indexed underlying, bool paused)",
  "event FeeParamsSet((uint16 premiumFeeBps, uint16 resaleFeeBps, uint32 takerFeeFlat, uint16 takerFeeCapBps, uint16 makerRebateBps) params)",
  "event MakerRegistrySet(address indexed registry)",
  "event TradingPausedSet(bool paused)",
  "event BountySet(bytes32 indexed action, uint256 amount)",
  "event CallerSet(address indexed caller, bool registered)",
  "event DailyCapSet(uint256 amount)",
  "event Defunded(address indexed to, uint256 amount)",
  "event MinRollUnitsSet(uint256 units)",
  "event LimitsSet((uint64 maxSeriesUnits, uint128 maxTotalNotional, uint16 askToleranceBps, uint16 maxBidBpsOfSpot, uint32 maxOrderLifetime, uint128 maxDailyOutflow) limits)",
  "event Withdrawn(address indexed asset, address indexed to, uint256 amount)",
  "event PositionWithdrawn(uint256 indexed tokenId, address indexed to, uint256 units)",
  "event HolidaySet(uint32 indexed dayIndex, bool isHoliday)",
  "event SpecialExpirySet(uint40 indexed ts, bool allowed)",
  "event RouteSet(address indexed asset, address indexed pool, uint24 fee)",
  "event RootSet(uint256 indexed epoch, bytes32 root, uint256 total)",
  "event TierSet(address indexed maker, uint16 rebateBps)",
  "event SettlementVetoed(address indexed underlying, uint40 indexed expiry)",
  "event SettlementUnvetoed(address indexed underlying, uint40 indexed expiry, uint40 finalizableAt)",
  // INTERFACE_VERSION 6
  "event FeeParamsScheduled((uint16 premiumFeeBps, uint16 resaleFeeBps, uint32 takerFeeFlat, uint16 takerFeeCapBps, uint16 makerRebateBps) params, uint40 effectiveAt)",
  "event OracleSet(address indexed oracle, bool allowed)",
  "event SettlementConfigPinned(address indexed underlying, uint40 indexed expiry, address[] sources, uint16 maxDeviationBps, uint32 uncorroboratedDelay)",
  "event FeedPinned(address indexed underlying, uint40 indexed expiry, address feed, uint32 maxStale, uint16 maxRoundJumpBps)",
  "event PoolPinned(address indexed underlying, uint40 indexed expiry, address pool, uint128 minLiquidity)",
  // DataStreamsSource's FeedSet / FeedPinned share a name with ChainlinkFeedSource's; applyScanLogs renames them
  // DataStreamsFeedSet / DataStreamsFeedPinned.
  "event FeedSet(address indexed underlying, bytes32 indexed feedId)",
  "event FeedPinned(address indexed underlying, uint40 indexed expiry, bytes32 feedId, uint64 version)",
  // INTERFACE_VERSION 7. Minted / Closed / MintFeesAccrued are the whole rent ledger (c05); Rolled, StaleAskCancelled
  // and StrategyStopped are how the monitor learns which (writer, market) pairs the AutoRoller has a position for
  // (c16). None of them costs an extra eth_getLogs: the scan already fetches every log of these addresses.
  "event Minted(uint256 indexed longId, address indexed writer, address indexed longTo, uint64 units, uint256 collateral, uint256 fee)",
  "event Closed(uint256 indexed longId, address indexed account, uint64 units, uint256 collateralFreed, uint256 feeRefund)",
  "event MintFeesAccrued(uint256 indexed longId, address indexed asset, uint256 amount)",
  "event Rolled(address indexed writer, address indexed underlying, uint256 longId, uint256 orderId, uint128 strike, uint40 expiry, uint128 price, uint64 units)",
  // T-OP-090. The PRICER lane replaced the writer's ask (ops/abis/v2/AutoRoller.json; the event is unchanged by T-OP-063).
  "event Repriced(address indexed writer, address indexed underlying, uint256 oldOrderId, uint256 newOrderId, uint128 price)",
  "event StaleAskCancelled(address indexed writer, address indexed underlying, uint256 longId, uint256 orderId, uint256 spot, uint256 updatedAt)",
  "event StrategyStopped(address indexed writer, address indexed underlying)",
  // INTERFACE_VERSION 8, AccessManager. RoleGranted / RoleRevoked / RoleAdminChanged share their NAMES with
  // AccessControl's above and have different topics and different arguments; scanEventName gives them names of
  // their own (ManagerRoleGranted, ...) so nothing can confuse a uint64 role id with a bytes32 role hash.
  "event OperationScheduled(bytes32 indexed operationId, uint32 indexed nonce, uint48 schedule, address caller, address target, bytes data)",
  "event OperationExecuted(bytes32 indexed operationId, uint32 indexed nonce)",
  "event OperationCanceled(bytes32 indexed operationId, uint32 indexed nonce)",
  "event RoleGranted(uint64 indexed roleId, address indexed account, uint32 delay, uint48 since, bool newMember)",
  "event RoleRevoked(uint64 indexed roleId, address indexed account)",
  "event RoleAdminChanged(uint64 indexed roleId, uint64 indexed admin)",
  "event RoleGuardianChanged(uint64 indexed roleId, uint64 indexed guardian)",
  "event RoleGrantDelayChanged(uint64 indexed roleId, uint32 delay, uint48 since)",
  "event RoleLabel(uint64 indexed roleId, string label)",
  "event TargetFunctionRoleUpdated(address indexed target, bytes4 selector, uint64 indexed roleId)",
  "event TargetAdminDelayUpdated(address indexed target, uint32 delay, uint48 since)",
  "event TargetClosed(address indexed target, bool closed)",
  // INTERFACE_VERSION 8, PayoutRouter. Its RouteSet shares its name with the v7 adapter's three-field one and
  // carries five fields; scanEventName renames it RouterRouteSet.
  "event RouteSet(address indexed asset, uint8 venue, bytes32 poolId, uint24 fee, uint16 feeBps)",
  "event RouteCleared(address indexed asset)",
  // INTERFACE_VERSION 8, FeeSplitter. A burn is only ever claimed from Burned; nothing is inferred from a balance.
  "event Distributed(address indexed asset, uint256 assetIn, uint256 usdgIn, uint256 treasuryOut, uint256 buybackAdded)",
  "event DistributionSkipped(address indexed asset, bytes32 reason)",
  "event BoughtBack(uint256 usdgIn, uint256 tokenOut)",
  "event Burned(uint256 amount)",
  "event BuybackSkipped(bytes32 reason)",
  // INTERFACE_VERSION 8, Clearinghouse / OrderBook admin events that did not exist in v7. An admin event the scan
  // does not decode is an admin event CONFIG_EVENTS can never page. Every signature here was taken from
  // ops/abis/v2/*.json, not from a design document: setMarketFees / setMarketListing / setMarketOracle have NO
  // events of their own — they re-emit MarketConfigSet, which is already scanned.
  "event MinterSet(address indexed minter, bool allowed)",
  "event DefaultMarketFeesSet(uint16 exerciseFeeBps, uint32 mintFeePpm)",
  "event DefaultOracleSet(address indexed oracle)",
  "event DiscountModuleSet(address indexed module)",
  "event FundingAllowedSet(address indexed maker, bool allowed)",
  "event TreasurySet(address indexed treasury)",
  "event FeesSwept(address indexed asset, address indexed to, uint256 amount)",
  "event MarketSourcesSet(address indexed underlying)",
];
const TOKEN_EVENTS = [
  "event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)",
  // T-OP-083. IOraclePausable (contracts src/interfaces/IOraclePausable.sol): the issuer's halt flag, as events.
  "event OraclePaused()",
  "event OracleUnpaused()",
];
/**
 * T-OP-083. topic0 of the two halt events, DERIVED from their signatures (viem.toEventSelector = keccak256 of the
 * canonical signature), never typed in. viem is the run's (loaded lazily, or injected by a test), hence a function.
 */
export function oracleHaltTopics(viem) {
  return { paused: viem.toEventSelector("event OraclePaused()").toLowerCase(), unpaused: viem.toEventSelector("event OracleUnpaused()").toLowerCase() };
}

/**
 * T-OP-083. Fold a batch of Stock Token logs into the open-halt map: OraclePaused() opens `halts[token]`
 * (first sighting wins, so a replayed range changes nothing), OracleUnpaused() closes it. Logs are applied in
 * chain order (block, then logIndex) whatever order the node returned them in, and are classified by topic0 so
 * a batch that carries other token events (the fake chain returns every log for an address) is harmless.
 *   halts: { [tokenLowercase]: { ticker, token, block, transactionHash } }
 * Returns the same object, mutated, so a caller can persist it as state.
 */
export function applyOracleHaltLogs(halts, logs, tickerOf, topics) {
  const ordered = [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  for (const log of ordered) {
    const topic = (log.topics?.[0] ?? "").toLowerCase();
    const key = log.address.toLowerCase();
    if (topic === topics.paused) {
      if (halts[key] === undefined) halts[key] = { ticker: tickerOf(log.address), token: log.address, block: log.blockNumber.toString(), transactionHash: log.transactionHash };
    } else if (topic === topics.unpaused) {
      delete halts[key];
    }
  }
  return halts;
}

/**
 * T-OP-083. One v2_mon_oracle_halted (error) per launch token whose halt is open, keyed by the token so it stays
 * one page while the halt lasts and clears (v2_mon_resolved) the run after OracleUnpaused() lands. `launch` is
 * the set of launch token addresses; a halt recorded for any other token is kept in state but never paged.
 */
export function oracleHaltFindings(halts, launch) {
  const want = new Set(launch.map((a) => a.toLowerCase()));
  const out = [];
  for (const [key, h] of Object.entries(halts)) {
    if (!want.has(key)) continue;
    out.push(
      finding(
        "v2_mon_oracle_halted",
        key,
        "tokens",
        `${h.ticker} OraclePaused() at block ${h.block} (${h.transactionHash}): the issuer halted the price oracle; the Chainlink source and spot fail closed, the pool keeps trading, and a settlement window inside the halt records the pool alone -- watch every expiry inside the halt and veto a pool-only candidate before its uncorroboratedDelay (ops/alerts.md §V30a)`,
        { ticker: h.ticker, token: h.token, block: h.block, transactionHash: h.transactionHash },
      ),
    );
  }
  return out;
}

/** A revert or "no such function" (as opposed to a transport failure). */
export function isRevert(error) {
  // viem wraps a JSON-RPC -32603 ("internal error", what a rate-limited or half-broken node answers) in a
  // ContractFunctionRevertedError whose reason is the node's message. Read as a revert it turns an
  // unreachable view into "the function is absent", which reads as a flag being off and resolves open
  // alerts. A real revert carries revert data, or returns no data at all.
  let internal = false;
  let data = false;
  for (let e = error, i = 0; e && i < 12; e = e.cause, i += 1) {
    if ((e.name ?? "") === "InternalRpcError" || e.code === -32603) internal = true;
    const d = e.data !== null && typeof e.data === "object" ? e.data.data : e.data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]*$/.test(d)) data = true;
    if ((e.name ?? "") === "ContractFunctionZeroDataError") data = true;
  }
  if (internal && !data) return false;
  for (let e = error, i = 0; e && i < 12; e = e.cause, i += 1) {
    const name = e.name ?? "";
    if (name === "ContractFunctionRevertedError" || name === "ContractFunctionZeroDataError" || name === "RawContractError") return true;
    const text = `${e.shortMessage ?? ""} ${e.details ?? ""}`;
    if (/execution reverted|returned no data|reverted/i.test(text)) return true;
  }
  return false;
}

/** The revert data (hex) anywhere in a viem error's cause chain, or undefined. */
export function revertDataOf(error) {
  for (let e = error, i = 0; e && i < 12; e = e.cause, i += 1) {
    const d = e.data !== null && typeof e.data === "object" ? e.data.data : e.data;
    if (typeof d === "string" && /^0x[0-9a-fA-F]*$/.test(d)) return d;
  }
  return undefined;
}

/** fn over items, at most `limit` at once, results in order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Logs that can change what a Clearinghouse pin does, or which expiries it applies to: they invalidate the pins cache. */
export const PINS_DIRTY_EVENTS = new Set([
  "MarketConfigured",
  "ClearinghouseSet",
  "OracleSet",
  "FeedSet",
  "PoolSet",
  "DataStreamsFeedSet",
  "SettlementConfigPinned",
  "FeedPinned",
  "PoolPinned",
  "DataStreamsFeedPinned",
  "HolidaySet",
  "SpecialExpirySet",
  "MarketRegistered",
  "MarketConfigSet",
  "CalendarSet",
]);

export function shortError(error) {
  const lines = String(error?.shortMessage ?? error?.message ?? error)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  // viem puts the revert selector on the line after "...reverted with the following signature:".
  const text = lines.length > 1 && lines[0].endsWith(":") ? `${lines[0]} ${lines[1]}` : (lines[0] ?? "");
  return text.replace(/https?:\/\/\S+/g, "<url>").slice(0, 240);
}

/**
 * Events whose NAME is shared by two contracts get a name of their own here, because everything downstream
 * (CONFIG_EVENTS, DEDICATED_EVENTS, the state keys) is keyed by name and would otherwise treat two different
 * events as one. viem still decodes each by topic, so the arguments are the right ones; only the label is ours.
 *
 * - DataStreamsSource's FeedSet(address, bytes32) / FeedPinned(..., bytes32, uint64) against ChainlinkFeedSource's.
 * - INTERFACE_VERSION 8: the AccessManager's RoleGranted(uint64, ...) / RoleRevoked(uint64, ...) /
 *   RoleAdminChanged(uint64, uint64) against AccessControl's bytes32 forms. A uint64 role id read as a bytes32 role
 *   hash would name the wrong role in an alert and page nothing at all for the right one.
 * - INTERFACE_VERSION 8: the PayoutRouter's five-field RouteSet against the v7 adapter's three-field one.
 */
export function scanEventName(log) {
  const a = log.args ?? {};
  if (log.eventName === "FeedSet" && a.feedId !== undefined) return "DataStreamsFeedSet";
  if (log.eventName === "FeedPinned" && a.feedId !== undefined) return "DataStreamsFeedPinned";
  if (a.roleId !== undefined) {
    if (log.eventName === "RoleGranted") return "ManagerRoleGranted";
    if (log.eventName === "RoleRevoked") return "ManagerRoleRevoked";
    if (log.eventName === "RoleAdminChanged") return "ManagerRoleAdminChanged";
  }
  if (log.eventName === "RouteSet" && a.venue !== undefined) return "RouterRouteSet";
  return log.eventName;
}

/**
 * Apply decoded protocol logs to the scan state (pure; exported for tests). Returns the admin events seen (CONFIG_EVENTS
 * and DEDICATED_EVENTS; a FeeParamsScheduled carries `feesBefore`, the fees in effect when it was scheduled, replayed
 * from the OrderBook's FeeParamsSet and FeeParamsScheduled logs: null when the replay has not seen the constructor's
 * FeeParamsSet). The pin logs and the Clearinghouse's SeriesCreated also go to `pinLogs` when given (prePinFindings).
 * `addresses`: clearinghouse, settlementOracle, keeperRewards, orderBook, autoRoller, expiryCalendar and the registry
 * sources chainlink, univ3, dataStreams (null = absent).
 *
 * The scan re-reads its last REORG_OVERLAP blocks every run, so everything here must be idempotent under replay:
 * assignments and sets are, sums are not. `scan.rentAt` is the highest "<block>:<logIndex>" the rent sums have
 * already counted, and a log at or below it is skipped. A real reorg resets the whole scan state (the anchor check),
 * so a skipped log is always one whose identical twin was counted.
 */
export function applyScanLogs(scan, logs, addresses, pinLogs = null) {
  const configEvents = [];
  const isFrom = (log, name) => addresses[name] !== null && addresses[name] !== undefined && sameAddress(log.address, addresses[name]);
  const isSource = (log) => isFrom(log, "chainlink") || isFrom(log, "univ3") || isFrom(log, "dataStreams");
  scan.sourcePins ??= {};
  scan.special ??= {};
  scan.fees ??= { current: null, pending: null, effectiveAt: null };
  scan.rent ??= {};
  scan.roller ??= {};
  const mark = scan.rentAt === null || scan.rentAt === undefined ? null : scan.rentAt.split(":").map(BigInt);
  let highest = mark;
  const counted = (log) => {
    const here = [BigInt(log.blockNumber), BigInt(log.logIndex)];
    if (highest === null || here[0] > highest[0] || (here[0] === highest[0] && here[1] > highest[1])) highest = here;
    return mark !== null && (here[0] < mark[0] || (here[0] === mark[0] && here[1] <= mark[1]));
  };
  /** The rent ledger of one series: base units charged, refunded and accrued, all of one collateral asset. */
  const rentOf = (longId) => (scan.rent[longId.toString()] ??= { paid: "0", refunded: "0", accrued: "0", mints: 0, zeroFee: 0 });
  const rollerKey = (a) => `${lc(a.writer)}:${lc(a.underlying)}`;
  for (const raw of logs) {
    const eventName = scanEventName(raw);
    const log = eventName === raw.eventName ? raw : { ...raw, eventName };
    const a = log.args ?? {};
    switch (eventName) {
      case "SeriesCreated":
        if (!isFrom(log, "clearinghouse")) break;
        // `p` is the rent rate pinned into the series at creation (INTERFACE_VERSION 7); it never changes again.
        scan.series[a.longId.toString()] = { u: a.underlying, e: Number(a.expiry), put: a.isPut, k: a.strike.toString(), o: a.oracle, p: Number(a.mintFeePpm) };
        if (pinLogs !== null) pinLogs.push(log);
        break;
      case "Minted": {
        if (!isFrom(log, "clearinghouse") || counted(log)) break;
        const r = rentOf(a.longId);
        r.paid = (BigInt(r.paid) + a.fee).toString();
        r.mints += 1;
        if (a.fee === 0n) r.zeroFee += 1;
        break;
      }
      case "Closed": {
        if (!isFrom(log, "clearinghouse") || counted(log)) break;
        const r = rentOf(a.longId);
        r.refunded = (BigInt(r.refunded) + a.feeRefund).toString();
        break;
      }
      case "MintFeesAccrued": {
        if (!isFrom(log, "clearinghouse") || counted(log)) break;
        const r = rentOf(a.longId);
        r.accrued = (BigInt(r.accrued) + a.amount).toString();
        break;
      }
      case "Rolled":
        if (!isFrom(log, "autoRoller")) break;
        // `p`: the ask price the roll rested, so a later Repriced can be measured against what it replaced (T-OP-090).
        scan.roller[rollerKey(a)] = { w: a.writer, u: a.underlying, e: Number(a.expiry), p: a.price.toString() };
        break;
      case "Repriced": {
        // T-OP-090. Collected for repriceFindings with the price it replaced (`priceBefore`: the roll's ask or the
        // previous reprice; null when the scan never saw either, e.g. a position rolled before the scan's first block).
        // `counted` keeps a replayed overlap from moving the remembered price twice and from being paged twice.
        if (!isFrom(log, "autoRoller") || counted(log)) break;
        const r = scan.roller[rollerKey(a)] ??= { w: a.writer, u: a.underlying, e: 0 };
        configEvents.push({ ...log, priceBefore: r.p === undefined ? null : r.p });
        r.p = a.price.toString();
        break;
      }
      case "StaleAskCancelled":
        // The ask is gone; the position (longId, expiry) stays, so the pair is still worth reading at the head.
        if (isFrom(log, "autoRoller")) scan.roller[rollerKey(a)] ??= { w: a.writer, u: a.underlying, e: 0 };
        break;
      case "StrategyStopped":
        if (isFrom(log, "autoRoller")) delete scan.roller[rollerKey(a)];
        break;
      case "SettlementConfigPinned":
        if (isFrom(log, "settlementOracle") && pinLogs !== null) pinLogs.push(log);
        break;
      case "FeedPinned":
      case "PoolPinned":
      case "DataStreamsFeedPinned":
        if (!isSource(log)) break;
        scan.sourcePins[`${lc(a.underlying)}:${Number(a.expiry)}`] = 1;
        if (pinLogs !== null) pinLogs.push(log);
        break;
      case "SpecialExpirySet":
        if (isFrom(log, "expiryCalendar")) {
          if (a.allowed) scan.special[Number(a.ts)] = 1;
          else delete scan.special[Number(a.ts)];
        }
        configEvents.push(log);
        break;
      case "FeeParamsSet":
        if (isFrom(log, "orderBook")) scan.fees = { current: feeParamsOf(a.params), pending: null, effectiveAt: null };
        configEvents.push(log);
        break;
      case "FeeParamsScheduled": {
        if (!isFrom(log, "orderBook")) break;
        const f = scan.fees;
        const scheduledAt = Number(a.effectiveAt) - FEE_CHANGE_DELAY;
        // A change already due when the next one is scheduled became the fees in effect (OrderBook.setFeeParams).
        if (f.pending !== null && f.effectiveAt !== null && scheduledAt >= f.effectiveAt) f.current = f.pending;
        configEvents.push({ ...log, feesBefore: f.current });
        f.pending = feeParamsOf(a.params);
        f.effectiveAt = Number(a.effectiveAt);
        break;
      }
      case "TransferSingle":
      case "TransferBatch": {
        if (!isFrom(log, "clearinghouse") || sameAddress(a.to, ZERO)) break;
        const ids = log.eventName === "TransferSingle" ? [a.id] : a.ids;
        for (const id of ids) {
          const k = id.toString();
          (scan.holders[k] ??= {})[lc(a.to)] = 1;
          delete scan.drained[(id & ~1n).toString()];
        }
        break;
      }
      case "SeriesSettled":
        if (!isFrom(log, "clearinghouse")) break;
        scan.settled[a.longId.toString()] ??= { block: log.blockNumber.toString(), at: null };
        break;
      case "SettlementFinalized":
      case "SettlementResolved":
        if (eventName === "SettlementResolved") configEvents.push(log);
        if (!isFrom(log, "settlementOracle")) break;
        scan.finalized[`${lc(a.underlying)}:${Number(a.expiry)}`] = log.blockNumber.toString();
        break;
      case "Rewarded":
        if (!isFrom(log, "keeperRewards")) break;
        scan.rewards[`${log.blockNumber}:${log.logIndex}`] = a.amount.toString();
        break;
      default:
        if (CONFIG_EVENTS[eventName] !== undefined || OWN_KIND_EVENTS.has(eventName)) configEvents.push(log);
    }
  }
  if (highest !== null) scan.rentAt = `${highest[0]}:${highest[1]}`;
  return configEvents;
}

/* ---------------------------------------------------------------------------------------------- */
/*  one pass                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

const REORG_OVERLAP = 5n;
const MIN_CHUNK = 100n;

async function getLogsChunked(client, request, from, to, t, onRange) {
  let chunk = BigInt(t.logChunkBlocks);
  let start = from;
  let ranges = 0;
  let logs = 0;
  while (start <= to && ranges < t.maxRangesPerRun) {
    const end = start + chunk - 1n > to ? to : start + chunk - 1n;
    let batch;
    try {
      batch = await client.getLogs({ ...request, fromBlock: start, toBlock: end });
    } catch (error) {
      if (chunk > MIN_CHUNK) {
        chunk = chunk / 2n < MIN_CHUNK ? MIN_CHUNK : chunk / 2n;
        continue;
      }
      throw new Error(`eth_getLogs ${start}-${end} failed even at ${MIN_CHUNK} blocks: ${shortError(error)}`);
    }
    await onRange(batch, end);
    ranges += 1;
    logs += batch.length;
    start = end + 1n;
  }
  return { ranges, logs, caughtUp: start > to, reached: start - 1n };
}

function contractNames(reg) {
  const names = {};
  for (const n of CONTRACT_NAMES) if (reg.contracts[n]) names[lc(reg.contracts[n])] = n;
  for (const n of FLYWHEEL_NAMES) if (reg.flywheel?.[n]) names[lc(reg.flywheel[n])] = n;
  if (reg.safes?.admin) names[lc(reg.safes.admin)] = "adminSafe";
  if (reg.safes?.treasury) names[lc(reg.safes.treasury)] = "treasurySafe";
  if (reg.sources.chainlink) names[lc(reg.sources.chainlink)] = "ChainlinkFeedSource";
  if (reg.sources.univ3) names[lc(reg.sources.univ3)] = "UniV3TwapSource";
  if (reg.sources.dataStreams) names[lc(reg.sources.dataStreams)] = "DataStreamsSource";
  return names;
}

/**
 * One pass over every check. Returns the report; the caller prints it and exits. `deps.fetch` and
 * `deps.nowMs` are seams for tests.
 */
export async function runOnce(opts, deps = {}) {
  const viem = deps.viem ?? loadViem();
  const fetchImpl = deps.fetch ?? fetch;
  const wallNowMs = (deps.nowMs ?? Date.now)();
  const wallNow = Math.floor(wallNowMs / 1000);
  const t = opts.thresholds;
  const notes = [];

  let reg;
  try {
    reg = parseRegistry(JSON.parse(readFileSync(opts.registry, "utf8")), opts.registry);
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`cannot read the registry ${opts.registry}: ${shortError(error)}`);
  }
  const { createPublicClient, defineChain, http, parseAbi } = viem;
  const ABI = Object.fromEntries(Object.entries(ABI_TEXT).map(([k, v]) => [k, parseAbi(v)]));
  const scanAbi = parseAbi(SCAN_EVENTS);
  const tokenAbi = parseAbi(TOKEN_EVENTS);

  const findings = [];
  const completed = new Set(["meta"]);
  const checks = {};
  const incomplete = [];
  const record = (name, status, detail) => {
    checks[name] = { status, detail };
    if (status === "ok" || status === "skipped") completed.add(name);
    if (status === "failed" || status === "incomplete") incomplete.push(name);
  };
  // `fn` is handed a sink for findings it has already established. A check that dies half-way has usually
  // advanced state for the inputs it did read (a feed baseline, the tokens cursor), so the next run will not
  // look at them again: dropping those findings loses them for good. Whatever is in the sink is reported
  // whether the check finishes or throws.
  const run = async (name, fn) => {
    const out = [];
    try {
      const r = (await fn(out)) ?? {};
      if (r.findings) out.push(...r.findings);
      findings.push(...out);
      record(name, r.status ?? "ok", r.detail ?? "");
    } catch (error) {
      findings.push(...out);
      record(name, "failed", shortError(error));
      findings.push(
        finding("v2_mon_check_failed", name, "meta", `monitor check "${name}" could not complete: ${shortError(error)}`, { check: name }, { severity: name === "head" ? "error" : "warn" }),
      );
    }
  };

  // ---- client and head (a dead RPC still lets the health checks and the relay work) ----
  const transportClient = createPublicClient({ transport: http(opts.rpc, { timeout: 30_000, retryCount: 2 }) });
  let chainId = reg.chainId;
  let head = null;
  let client = transportClient;
  let multicallOk = false;
  await run("head", async () => {
    const id = await transportClient.getChainId();
    if (reg.chainId !== null && id !== reg.chainId) throw new UsageError(`the RPC serves chain ${id}, the registry is chain ${reg.chainId}`);
    chainId = id;
    const block = await transportClient.getBlock({ blockTag: "latest" });
    head = { number: block.number, hash: block.hash, timestamp: Number(block.timestamp) };
    let multicall = false;
    if (reg.multicall3) {
      const code = await transportClient.getCode({ address: reg.multicall3 });
      multicall = code !== undefined && code !== "0x";
    }
    multicallOk = multicall;
    const chain = defineChain({
      id,
      name: `chain-${id}`,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [opts.rpc] } },
      contracts: multicall ? { multicall3: { address: reg.multicall3 } } : {},
    });
    client = createPublicClient({ chain, transport: http(opts.rpc, { timeout: 30_000, retryCount: 2 }), batch: multicall ? { multicall: { batchSize: 2048, wait: 0 } } : undefined });
    return {
      findings: checkHeadLag({ headBlock: block.number, headTimestamp: head.timestamp, wallNow }, t),
      detail: `block ${head.number} at ${iso(head.timestamp)} (wall clock ${wallNow - head.timestamp >= 0 ? "+" : ""}${wallNow - head.timestamp} s)${multicall ? "" : ", no Multicall3: plain calls"}`,
    };
  });
  if (checks.head?.status === "failed" && checks.head.detail.includes("the registry is chain")) throw new UsageError(checks.head.detail);

  const fingerprint = fingerprintOf(reg, chainId);
  // A state file that cannot be written is the worst failure this script has: every run then starts empty,
  // re-pages every open condition and adopts, without a word, every admin event since the last run. Probe the
  // path before doing any work, fall back to the temp directory so at least the runs of one container share a
  // memory, and page about it. (EACCES on a volume without RAILWAY_RUN_UID=0 is the way this happens.)
  let statePath = opts.state ?? defaultStatePath(reg, chainId);
  let stateFallback = null;
  if (!opts.dryRun) {
    const why = statePathUnwritable(statePath);
    if (why !== null) {
      // Named for the path it stands in for, so two monitors on one host never share a fallback file.
      const alternative = path.join(tmpdir(), `monitor-fallback-${createHash("sha256").update(statePath).digest("hex").slice(0, 12)}.json`);
      const why2 = statePathUnwritable(alternative);
      if (why2 === null) {
        stateFallback = { from: statePath, to: alternative, why };
        statePath = alternative;
      } else {
        stateFallback = { from: statePath, to: null, why, why2 };
      }
    }
  }
  if (stateFallback !== null) {
    findings.push(
      finding(
        "v2_mon_state_unwritable",
        stateFallback.from,
        "meta",
        stateFallback.to === null
          ? `the monitor cannot write its state file (${stateFallback.from}: ${stateFallback.why}), and neither can it write to ${tmpdir()} (${stateFallback.why2}): every run starts empty, so every open condition pages again and every admin event between two runs is adopted without a page`
          : `the monitor cannot write its state file (${stateFallback.from}: ${stateFallback.why}); it is keeping state in ${stateFallback.to} instead, which a redeploy wipes`,
        { path: stateFallback.from, using: stateFallback.to, reason: stateFallback.why },
      ),
    );
  }
  const state = loadState(statePath, chainId, fingerprint, notes);

  const read = async (address, abi, functionName, args = []) => {
    try {
      return { ok: true, value: await client.readContract({ address, abi, functionName, args, blockNumber: head.number }) };
    } catch (error) {
      return { ok: false, revert: isRevert(error), error: shortError(error) };
    }
  };
  const must = (r, what) => {
    if (!r.ok) throw new Error(`${what}: ${r.error}`);
    return r.value;
  };
  let markets = marketsInScope(reg, { tickers: opts.tickers, allMarkets: opts.allMarkets });
  const divergenceBands = opts.divergenceBands ?? {};
  for (const ticker of Object.keys(divergenceBands)) {
    const market = reg.markets.find((m) => m.ticker.toUpperCase() === ticker);
    if (!market || !market.v2?.univ3Pool || !reg.sources.chainlink || !reg.sources.univ3)
      throw new UsageError(`divergence band ${ticker}: market needs a registry pool and both deployed price sources`);
  }
  const tickerOf = (address) => reg.markets.find((m) => sameAddress(m.asset, address))?.ticker ?? shortAddr(address);
  const C = reg.contracts;
  // prettier-ignore
  const chainChecks = [
    "scan", "settlement", "backlog", "rewards", "vault", "roller", "rent", "config", "fees", "pins", "feeds",
    "divergence", "tokens", "usdg", "pools",
    // INTERFACE_VERSION 8.
    "manager", "safes", "flywheel", "routes", "tokenpool", "tvl",
  ];
  const names = contractNames(reg);
  /**
   * INTERFACE_VERSION 8: selector -> { contract, signature, role } from the published role manifest, so an
   * OperationScheduled and a TargetFunctionRoleUpdated can be read as the function they are about. Built with
   * viem from the manifest's own signatures — a hand-written selector table here would be a second source of
   * truth for exactly the values two tasks already got wrong once (INTERFACE-CHANGES-V8 entry 2).
   */
  let managerSelectors = null;
  if (ROLE_MANIFEST.manifest !== null) {
    managerSelectors = {};
    for (const [contract, fns] of Object.entries(ROLE_MANIFEST.manifest.targets ?? {})) {
      for (const [signature, role] of Object.entries(fns)) {
        try {
          managerSelectors[lc(viem.toFunctionSelector(`function ${signature}`))] = { contract, signature, role };
        } catch (error) {
          notes.push(`roles: ${contract}.${signature} in ${ROLES_FILE} is not a signature viem can hash (${shortError(error)}); operations on it are named by selector only`);
        }
      }
    }
  } else {
    notes.push(`roles: the manager role manifest could not be read (${ROLE_MANIFEST.why}); roles page by id and the manager wiring check is skipped`);
  }

  /** Many views at the head in few eth_calls (Multicall3 aggregate3, PIN_MULTICALL_BYTES of calldata each); plain calls without it. */
  const readMany = async (calls) => {
    if (calls.length === 0) return [];
    if (!multicallOk) return mapLimit(calls, 8, (c) => read(c.address, c.abi, c.functionName, c.args ?? []));
    const res = await client.multicall({
      contracts: calls.map(({ address, abi, functionName, args }) => ({ address, abi, functionName, args })),
      allowFailure: true,
      blockNumber: head.number,
      batchSize: PIN_MULTICALL_BYTES,
      multicallAddress: reg.multicall3,
    });
    return res.map((r) => (r.status === "success" ? { ok: true, value: r.result } : { ok: false, revert: true, error: shortError(r.error) }));
  };
  /** SettlementOracle.pin(underlying, expiry) simulated as the Clearinghouse (eth_call from its address; nothing is sent). */
  const simulatePin = async (oracle, underlying, expiry) => {
    const data = viem.encodeFunctionData({ abi: ABI.oracle, functionName: "pin", args: [underlying, expiry] });
    try {
      await transportClient.call({ account: C.clearinghouse, to: oracle, data, blockNumber: head.number });
      return { ok: true, revert: null };
    } catch (error) {
      const raw = revertDataOf(error);
      if (raw === undefined && !isRevert(error)) throw new Error(`eth_call pin(${tickerOf(underlying)}, ${expiry}) from the Clearinghouse: ${shortError(error)}`);
      return { ok: false, revert: decodePinRevert(raw ?? null) };
    }
  };
  /** Expiries that have series and are not settled-and-done: "<oracle>:<underlying>:<expiry>" -> { o, u, e }. */
  const seriesExpiries = () => {
    const out = new Map();
    for (const sr of Object.values(state.scan.series)) {
      const k = `${lc(sr.o)}:${lc(sr.u)}:${sr.e}`;
      if (!state.scan.expiryDone[k]) out.set(k, { o: sr.o, u: sr.u, e: sr.e });
    }
    return out;
  };

  if (head === null) {
    for (const name of chainChecks) record(name, "incomplete", "no chain head");
  } else {
    // ---- anchor: the same chain as last time? ----
    // Three verdicts, not two. A read that FAILS is not evidence of a reorg: resetting on it moves
    // adoptConfigUntil to the head, so every admin event since the last run (RoleGranted, FeedSet, PoolSet)
    // is adopted without a page, and the feed and Safe baselines are wiped. One 429 from a public RPC on this
    // single read is enough. Reset only when the anchor block was read and says another chain.
    if (state.anchor !== null) {
      let verdict = "same"; // "same" | "changed" | "unknown"
      let why = "";
      try {
        if (BigInt(state.anchor.block) <= head.number) {
          const b = await client.getBlock({ blockNumber: BigInt(state.anchor.block) });
          if (b.hash !== state.anchor.hash) {
            verdict = "changed";
            why = "another hash";
          }
        } else {
          verdict = "changed";
          why = `the head is block ${head.number}, below it`;
        }
      } catch (error) {
        verdict = "unknown";
        why = shortError(error);
      }
      if (verdict === "changed") {
        notes.push(`state: block ${state.anchor.block} is not the one seen last run (${why}: reorg, a restarted devnet, or another node); scan state reset, open alerts kept`);
        const keep = state.alerts;
        Object.assign(state, emptyState(chainId, fingerprint), { alerts: keep });
      } else if (verdict === "unknown") {
        notes.push(
          `state: block ${state.anchor.block} could not be read (${why}); the chain is assumed unchanged, scan state kept. Nothing is adopted on a failed read — if this repeats, check the RPC`,
        );
      }
    }

    // ---- protocol log scan ----
    const protocolAddresses = [
      ...CONTRACT_NAMES.map((n) => C[n]),
      // INTERFACE_VERSION 8: the flywheel's own logs. Without them the splitter and buyback checks have no evidence
      // and would have to infer a burn from a balance, which is exactly what they must never do.
      ...FLYWHEEL_NAMES.map((n) => reg.flywheel?.[n] ?? null),
      reg.sources.chainlink,
      reg.sources.univ3,
      reg.sources.dataStreams,
    ].filter(Boolean);
    let configEvents = [];
    const pinLogs = [];
    let scanCaughtUp = true;
    let pinsDirty = false;
    await run("scan", async () => {
      if (C.clearinghouse === null) return { status: "skipped", detail: "no v2 contracts in the registry (pre-deploy)" };
      const s = state.scan;
      const deploy = reg.deployBlock ?? 0n;
      if (s.adoptConfigUntil === null) s.adoptConfigUntil = head.number.toString();
      let from = s.cursor === null ? deploy : BigInt(s.cursor) + 1n - REORG_OVERLAP;
      if (from < deploy) from = deploy;
      const addresses = {
        clearinghouse: C.clearinghouse,
        settlementOracle: C.settlementOracle,
        keeperRewards: C.keeperRewards,
        orderBook: C.orderBook,
        autoRoller: C.autoRoller,
        expiryCalendar: C.expiryCalendar,
        chainlink: reg.sources.chainlink,
        univ3: reg.sources.univ3,
        dataStreams: reg.sources.dataStreams,
        // INTERFACE_VERSION 8.
        accessManager: C.accessManager,
        payoutAdapter: C.payoutAdapter,
        feeSplitter: reg.flywheel?.feeSplitter ?? null,
        buybackExecutor: reg.flywheel?.buybackExecutor ?? null,
      };
      // maxRangesPerRun bounds a run that will save its cursor and continue next time. --no-alerts saves
      // nothing, so there is no next run: capping it there leaves the laptop diagnostic reading a fixed
      // window after the deploy block (200 x 10,000 blocks is about 56 h of this chain) and reporting
      // "nothing late" about every series created after it. Scan to the head unless the operator capped it.
      const scanT = opts.dryRun && t.maxRangesPerRun === DEFAULTS.maxRangesPerRun ? { ...t, maxRangesPerRun: Number.MAX_SAFE_INTEGER } : t;
      const r = await getLogsChunked(client, { address: protocolAddresses }, from, head.number, scanT, async (logs, end) => {
        const decoded = viem.parseEventLogs({ abi: scanAbi, logs, strict: true });
        if (decoded.some((l) => PINS_DIRTY_EVENTS.has(l.eventName))) {
          // Dropped at once, not at the pins check: a run whose pins check fails must not leave the next run a cache
          // older than logs the cursor has already moved past.
          pinsDirty = true;
          s.pinsCache = null;
        }
        configEvents.push(...applyScanLogs(s, decoded, addresses, pinLogs));
        s.cursor = end.toString();
      });
      scanCaughtUp = r.caughtUp;
      const detail = `${r.logs} logs over ${r.ranges} range(s) from block ${from}; ${Object.keys(s.series).length} series known`;
      if (!r.caughtUp) {
        const next = opts.dryRun ? "--no-alerts saves no cursor, so no run continues this one: raise --threshold maxRangesPerRun, or drop --no-alerts to keep a cursor" : "next run continues";
        return { status: "incomplete", detail: `${detail}; ${head.number - r.reached} blocks still to scan (${next})` };
      }
      return { detail: `${detail}; caught up at ${head.number}` };
    });
    const scanUsable = checks.scan.status === "ok";
    const needsScan = () => {
      if (checks.scan.status === "skipped") return { status: "skipped", detail: "no v2 contracts" };
      if (checks.scan.status === "failed") throw new Error("the log scan failed");
      return null;
    };

    // ---- settlement ----
    await run("settlement", async () => {
      const skip = needsScan();
      if (skip) return skip;
      const s = state.scan;
      const now = head.timestamp;
      const keys = new Map();
      const seriesOf = new Map(); // expiry key -> the longIds the Clearinghouse created for it
      for (const [longId, sr] of Object.entries(s.series)) {
        if (sr.e > now) continue;
        const k = `${lc(sr.o)}:${lc(sr.u)}:${sr.e}`;
        if (!seriesOf.has(k)) seriesOf.set(k, []);
        seriesOf.get(k).push(longId);
        if (!s.expiryDone[k]) keys.set(k, sr);
      }
      const out = [];
      let finalized = 0;
      let unsettledExpiries = 0;
      await Promise.all(
        [...keys].map(async ([k, sr]) => {
          const [oi, info, cand, rec, cfg, pinnedCfg, snap] = await Promise.all([
            read(C.clearinghouse, ABI.clearinghouse, "openInterest", [sr.u, sr.e]),
            read(sr.o, ABI.oracle, "settlementInfo", [sr.u, sr.e]),
            read(sr.o, ABI.oracle, "candidate", [sr.u, sr.e]),
            read(sr.o, ABI.oracle, "recordedSources", [sr.u, sr.e]),
            read(sr.o, ABI.oracle, "marketConfig", [sr.u]),
            read(sr.o, ABI.oracle, "settlementConfig", [sr.u, sr.e]),
            reg.sources.univ3 ? read(reg.sources.univ3, ABI.univ3, "snapshots", [sr.u, sr.e]) : Promise.resolve(null),
          ]);
          const openInterest = must(oi, `openInterest(${tickerOf(sr.u)}, ${sr.e})`);
          const [statusIndex, , , , , captured] = must(info, `settlementInfo(${tickerOf(sr.u)}, ${sr.e})`);
          const status = SETTLEMENT_STATUS[Number(statusIndex)] ?? "None";
          const c = must(cand, `candidate(${tickerOf(sr.u)}, ${sr.e})`);
          // Before capture the expiry settles on the list PINNED for it, which the first series froze, not on the
          // market's list today: judging the missed snapshot against marketConfig missed a lost pool vote after a
          // later setMarket, and pages a false one when a source was added after the pin.
          const pinnedRow = pinnedCfg.ok && pinnedCfg.value[0] === true ? pinnedCfg.value : null;
          const sources = captured ? must(rec, "recordedSources")[0] : (pinnedRow?.[1] ?? must(cfg, "marketConfig")[0]);
          if (status === "Finalized") finalized += 1;
          out.push(
            ...checkExpiry(
              {
                oracle: sr.o,
                underlying: sr.u,
                ticker: tickerOf(sr.u),
                expiry: sr.e,
                now,
                openInterest,
                status,
                candidate: Number(c[3]) === 0 ? null : { price: c[0], sourceIndex: Number(c[1]), disagreed: c[2], finalizableAt: Number(c[3]) },
                sources: [...sources],
                univ3Source: reg.sources.univ3,
                snapshotRecordedAt: snap === null ? null : snap.ok ? Number(snap.value[2]) : null,
              },
              t,
            ),
          );
          // Finalized on the oracle is not the end of the expiry: the Clearinghouse still has to settle every
          // series before anyone can redeem. Leave the expiry open while any of its series is unsettled, or the
          // next run stops looking at it and the redeem backlog never sees it either (it follows SeriesSettled).
          const ids = seriesOf.get(k) ?? [];
          const unsettled = ids.filter((id) => s.settled[id] === undefined);
          if (status === "Finalized" && unsettled.length > 0) {
            unsettledExpiries += 1;
            out.push(...checkUnsettledSeries({ ticker: tickerOf(sr.u), underlying: sr.u, oracle: sr.o, expiry: sr.e, now, openInterest, unsettled, seriesCount: ids.length }, t));
          }
          if (scanUsable && ((status === "Finalized" && unsettled.length === 0) || openInterest === 0n)) s.expiryDone[k] = true;
        }),
      );
      // Nothing used to leave this state. 35 markets on dailies add about 70 series a day for ever: a file that
      // grows without bound, rewritten in full every run, and re-read into a getBlock per settled series after
      // any reset. An expiry done and older than seriesRetentionS has nothing left to say.
      let pruned = 0;
      for (const [longId, sr] of Object.entries(s.series)) {
        const k = `${lc(sr.o)}:${lc(sr.u)}:${sr.e}`;
        if (!s.expiryDone[k] || now - sr.e < t.seriesRetentionS) continue;
        const shortId = (BigInt(longId) | 1n).toString();
        delete s.series[longId];
        delete s.settled[longId];
        delete s.drained[longId];
        delete s.holders[longId];
        delete s.holders[shortId];
        pruned += 1;
      }
      const live = new Set(Object.values(s.series).map((sr) => `${lc(sr.o)}:${lc(sr.u)}:${sr.e}`));
      for (const k of Object.keys(s.expiryDone)) if (!live.has(k)) delete s.expiryDone[k];

      return {
        findings: out,
        status: scanUsable ? "ok" : "incomplete",
        detail: `${keys.size} past expiries read (${finalized} finalized now${unsettledExpiries > 0 ? `, ${unsettledExpiries} with unsettled series` : ""})${pruned > 0 ? `; ${pruned} finished series older than ${duration(t.seriesRetentionS)} pruned from the state` : ""}`,
      };
    });

    // ---- redeem backlog ----
    await run("backlog", async () => {
      const skip = needsScan();
      if (skip) return skip;
      const s = state.scan;
      const now = head.timestamp;
      const pendingAt = Object.entries(s.settled).filter(([id, v]) => !s.drained[id] && v.at === null);
      // Paced: a first run, or one after a reset, has one of these per settled series ever seen. Firing them
      // all at once is a burst a rate-limited public RPC answers with 429s.
      await mapLimit(pendingAt, t.readConcurrency, async ([, v]) => {
        const b = await client.getBlock({ blockNumber: BigInt(v.block) });
        v.at = Number(b.timestamp);
      });
      const due = Object.entries(s.settled).filter(([id, v]) => !s.drained[id] && v.at !== null && now - v.at >= t.backlogS);
      const out = [];
      let open = 0;
      await Promise.all(
        due.map(async ([longIdText, v]) => {
          const longId = BigInt(longIdText);
          const shortId = longId | 1n;
          const ser = must(await read(C.clearinghouse, ABI.clearinghouse, "series", [longId]), `series(${longIdText.slice(0, 12)}…)`);
          const side = async (tokenId, perUnit) => {
            const res = { perUnit, holders: 0, units: 0n, optedOut: 0 };
            if (perUnit === 0n) return res;
            const holders = Object.keys(s.holders[tokenId.toString()] ?? {}).filter((h) => !sameAddress(h, C.orderBook) && !sameAddress(h, C.clearinghouse));
            await Promise.all(
              holders.map(async (h) => {
                const bal = must(await read(C.clearinghouse, ABI.clearinghouse, "balanceOf", [h, tokenId]), "balanceOf");
                if (bal === 0n) return;
                const allowed = must(await read(C.clearinghouse, ABI.clearinghouse, "thirdPartyRedeemAllowed", [h]), "thirdPartyRedeemAllowed");
                if (!allowed) res.optedOut += 1;
                else {
                  res.holders += 1;
                  res.units += bal;
                }
              }),
            );
            return res;
          };
          const [long, short] = await Promise.all([side(longId, ser.longPayoutPerUnit), side(shortId, ser.shortPayoutPerUnit)]);
          const bookUnits = C.orderBook ? must(await read(C.clearinghouse, ABI.clearinghouse, "balanceOf", [C.orderBook, longId]), "balanceOf(book)") : 0n;
          const f = checkBacklog(
            {
              longId: longIdText,
              ticker: tickerOf(ser.underlying),
              isPut: ser.isPut,
              strike: ser.strike,
              expiry: Number(ser.expiry),
              settledAt: v.at,
              now,
              long: { perUnit: long.perUnit, holders: long.holders, units: long.units },
              short: { perUnit: short.perUnit, holders: short.holders, units: short.units },
              bookUnits,
              optedOut: long.optedOut + short.optedOut,
            },
            t,
          );
          if (f.length > 0) {
            open += 1;
            out.push(...f);
          } else if (scanUsable) {
            s.drained[longIdText] = true;
            delete s.holders[longIdText];
            delete s.holders[shortId.toString()];
          }
        }),
      );
      return { findings: out, status: scanUsable ? "ok" : "incomplete", detail: `${due.length} settled series past ${duration(t.backlogS)} checked, ${open} with a backlog` };
    });

    // ---- rewards ----
    await run("rewards", async () => {
      if (C.keeperRewards === null || reg.usdg === null) return { status: "skipped", detail: "no KeeperRewards in the registry" };
      const skip = needsScan();
      if (skip) return skip;
      const [balance, dailyCap, spentToday, ...bounties] = await Promise.all([
        read(reg.usdg, ABI.erc20, "balanceOf", [C.keeperRewards]),
        read(C.keeperRewards, ABI.keeperRewards, "dailyCap"),
        read(C.keeperRewards, ABI.keeperRewards, "spentToday"),
        ...Object.values(ACTIONS).map((a) => read(C.keeperRewards, ABI.keeperRewards, "bounty", [a])),
      ]);
      const table = Object.fromEntries(Object.keys(ACTIONS).map((name, i) => [name, must(bounties[i], `bounty(${name})`)]));
      const s = state.scan;
      const observed = observedSpend(s.rewards, s.finalized, t.rewardsWindowExpiries);
      const r = checkRewards(
        { address: C.keeperRewards, balance: must(balance, "USDG.balanceOf(KeeperRewards)"), dailyCap: must(dailyCap, "dailyCap"), spentToday: must(spentToday, "spentToday"), bounties: table, observed },
        t,
      );
      // Trim what no future estimate reads: finalized beyond the window, rewards older than its oldest block.
      const blocks = Object.entries(s.finalized).sort((a, b) => (BigInt(a[1]) > BigInt(b[1]) ? -1 : 1));
      for (const [k] of blocks.slice(Math.max(t.rewardsWindowExpiries, 1) * 2)) delete s.finalized[k];
      if (observed.fromBlock !== null && observed.expiries >= t.rewardsWindowExpiries) {
        for (const id of Object.keys(s.rewards)) if (BigInt(id.split(":")[0]) < observed.fromBlock) delete s.rewards[id];
      }
      return {
        findings: r.findings,
        status: scanUsable ? "ok" : "incomplete",
        detail: `balance ${usdg(must(balance, "balance"))} USDG, ${usdg(r.perExpiry)} per expiry (${r.basis}), runway ${r.runway === null ? "n/a" : `${r.runway} expiries`}`,
      };
    });

    // ---- house vaults: the SEC-14 boundary stall ----
    await run("house", async () => {
      if (opts.house.length === 0) {
        return { status: "skipped", detail: "no --house TICKER=0xaddress given (the registry cannot name factory-created vaults)" };
      }
      const out = [];
      const details = [];
      let unread = 0;
      for (const h of opts.house) {
        const [end, id, tracked, asset] = await Promise.all([
          read(h.address, ABI.houseVault, "epochEnd"),
          read(h.address, ABI.houseVault, "epochId"),
          read(h.address, ABI.houseVault, "trackedSeries"),
          read(h.address, ABI.houseVault, "underlying"),
        ]);
        if (!end.ok || !id.ok || !tracked.ok || !asset.ok) {
          unread += 1;
          notes.push(`house: ${h.ticker} ${shortAddr(h.address)} could not be read (${[end, id, tracked, asset].find((r) => !r.ok).error})`);
          continue;
        }
        const epochEnd = Number(end.value);
        const ids = tracked.value;
        const series = [];
        let seriesUnread = false;
        await Promise.all(
          ids.map(async (longId) => {
            const [exp, ser] = await Promise.all([
              read(h.address, ABI.houseVault, "exposure", [longId]),
              read(C.clearinghouse, ABI.clearinghouse, "series", [longId]),
            ]);
            if (!exp.ok || !ser.ok) {
              seriesUnread = true;
              notes.push(`house: ${h.ticker} series ${longId} could not be read (${(exp.ok ? ser : exp).error})`);
              return;
            }
            const [, , detail] = exp.value;
            const sr = ser.value;
            series.push({
              longId: longId.toString(),
              label: `${tickerOf(sr.underlying)} ${sr.isPut ? "put" : "call"} ${usdg(sr.strike)} ${iso(Number(sr.expiry))}`,
              exists: !sameAddress(sr.underlying, ZERO),
              settled: sr.settled,
              longs: BigInt(detail.longs),
              shorts: BigInt(detail.shorts),
              live: Number(detail.live),
            });
          }),
        );
        // An UNREAD boundary price is not an unfinalized one. `null` keeps that half out of the blocker list
        // instead of paging for a condition this pass never observed (the false-green shape, inverted).
        const info = await read(C.settlementOracle, ABI.oracle, "settlementInfo", [asset.value, epochEnd]);
        const boundary = info.ok ? { finalized: SETTLEMENT_STATUS[Number(info.value.status)] === "Finalized" && BigInt(info.value.price) !== 0n, price: BigInt(info.value.price) } : null;
        if (!info.ok) notes.push(`house: ${h.ticker} settlementInfo(${iso(epochEnd)}) could not be read (${info.error})`);
        if (seriesUnread) unread += 1;
        out.push(
          ...checkHouseEpoch(
            { address: h.address, ticker: h.ticker, epochId: id.value, epochEnd, now: wallNow, boundary, series },
            t,
          ),
        );
        details.push(`${h.ticker} epoch ${id.value} ends ${iso(epochEnd)} (${ids.length} tracked)`);
      }
      return { findings: out, status: unread > 0 ? "incomplete" : "ok", detail: details.join(", ") || "no house vault read" };
    });

    // ---- maker vault ----
    await run("vault", async () => {
      if (C.makerVault === null) return { status: "skipped", detail: "no MakerVault in the registry" };
      const v = C.makerVault;
      const [limits, total, tracked, flow] = await Promise.all([
        read(v, ABI.makerVault, "limits"),
        read(v, ABI.makerVault, "totalNotional"),
        read(v, ABI.makerVault, "trackedSeries"),
        read(v, ABI.makerVault, "outflow"),
      ]);
      const lim = must(limits, "limits()");
      const ids = must(tracked, "trackedSeries()");
      const [flowUsed, flowAvailable] = must(flow, "outflow()");
      const series = [];
      const underlyings = new Map();
      await Promise.all(
        ids.map(async (id) => {
          const [exp, ser] = await Promise.all([read(v, ABI.makerVault, "exposure", [id]), read(C.clearinghouse, ABI.clearinghouse, "series", [id])]);
          const [units, , detail] = must(exp, "exposure");
          const sr = must(ser, "series");
          underlyings.set(lc(sr.underlying), sr.underlying);
          series.push({ longId: id.toString(), label: `${tickerOf(sr.underlying)} ${sr.isPut ? "put" : "call"} ${usdg(sr.strike)} ${iso(Number(sr.expiry))}`, units, live: Number(detail.live) });
        }),
      );
      const available = async (asset) => {
        const [wallet, ledger] = await Promise.all([read(asset, ABI.erc20, "balanceOf", [v]), read(C.clearinghouse, ABI.clearinghouse, "free", [v, asset])]);
        return must(wallet, "balanceOf(vault)") + must(ledger, "free(vault)");
      };
      const usdgAvailable = reg.usdg ? await available(reg.usdg) : 0n;
      const tokens = [];
      for (const asset of underlyings.values()) tokens.push({ ticker: tickerOf(asset), token: asset, available: await available(asset) });
      const out = checkVault(
        {
          address: v,
          limits: { maxSeriesUnits: BigInt(lim.maxSeriesUnits), maxTotalNotional: BigInt(lim.maxTotalNotional), maxDailyOutflow: BigInt(lim.maxDailyOutflow) },
          totalNotional: must(total, "totalNotional"),
          series,
          usdgAvailable,
          tokens,
          outflow: { used: flowUsed, available: flowAvailable },
        },
        t,
      );
      return {
        findings: out,
        detail: `${ids.length} tracked series, total notional ${usdg(must(total, "totalNotional"))} of ${usdg(lim.maxTotalNotional)} USDG, ${usdg(usdgAvailable)} USDG available, 24 h outflow ${usdg(flowUsed)} used of ${usdg(lim.maxDailyOutflow)} (${usdg(flowAvailable)} left)`,
      };
    });

    // ---- AutoRoller asks the market has overtaken (INTERFACE_VERSION 7, c16) ----
    // The pairs come from the scan's Rolled logs; the chain says what each one's position is now. A pair costs one
    // position() read a pass, and only a live ask costs anything more.
    await run("roller", async () => {
      // Not SettlementOracle: since T-437 every spot here comes from the series' own pinned oracle, read off the
      // Clearinghouse, so the registry's published oracle is not an input to this page and must not gate it.
      if (C.autoRoller === null || C.orderBook === null || C.clearinghouse === null) {
        return { status: "skipped", detail: "no AutoRoller, OrderBook or Clearinghouse in the registry" };
      }
      const skip = needsScan();
      if (skip) return skip;
      const s = state.scan;
      const now = head.timestamp;
      s.rollerStale ??= {};
      const pairs = Object.entries(s.roller ?? {});
      if (pairs.length === 0) return { status: scanUsable ? "ok" : "incomplete", detail: "no AutoRoller position has been rolled yet" };
      const positions = await readMany(pairs.map(([, p]) => ({ address: C.autoRoller, abi: ABI.autoRoller, functionName: "position", args: [p.w, p.u] })));
      const live = [];
      pairs.forEach(([key, p], i) => {
        const [longId, orderId, expiry] = must(positions[i], `AutoRoller.position(${shortAddr(p.w)}, ${tickerOf(p.u)})`);
        const exp = Number(expiry);
        p.e = exp;
        if (orderId === 0n || now >= exp) {
          delete s.rollerStale[key];
          // A position with no ask and an expiry long past is finished: stop reading it every pass.
          if (orderId === 0n && (exp === 0 || now - exp >= t.seriesRetentionS)) delete s.roller[key];
          return;
        }
        live.push({ key, p, longId, orderId, expiry: exp });
      });
      const out = [];
      let overtakenNow = 0;
      let oraclesUsed = 0;
      if (live.length > 0) {
        const orders = must(await read(C.orderBook, ABI.orderBook, "getOrders", [live.map((x) => x.orderId)]), "OrderBook.getOrders");
        // Cancelled, filled out or past validUntil: cancelStale returns false for all three and there is nothing to buy.
        const candidates = live.filter((x, i) => {
          const o = orders[i];
          x.order = o;
          return o !== undefined && o.cancelled !== true && BigInt(o.units) > BigInt(o.filled) && now < Number(o.validUntil);
        });
        for (const x of live) if (!candidates.includes(x)) delete s.rollerStale[x.key];
        const [seriesRows, delegateRows] = await Promise.all([
          readMany(candidates.map((x) => ({ address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "series", args: [x.longId] }))),
          readMany(candidates.map((x) => ({ address: C.orderBook, abi: ABI.orderBook, functionName: "isDelegate", args: [x.p.w, C.autoRoller] }))),
        ]);
        // ORACLE (T-437). The spot that judges an ask is the one ITS SERIES pinned, `Clearinghouse.series(longId).oracle`:
        // what `cancelStale` reads on chain since T-310 and what the series settles on. Never the registry's published
        // SettlementOracle and never `market(u).oracle` - a `setMarketOracle` moves the market's pointer and leaves every
        // series already created on its old oracle, so a mirror reading either judges "not overtaken" on a price the
        // contract does not use and never pages for the in-the-money ask left resting. Two series under one underlying can
        // therefore be judged on two oracles in one pass, so spots key on (oracle, underlying) rather than underlying.
        const seriesOf = candidates.map((x, i) => must(seriesRows[i], `series(${x.longId})`));
        const spotKeyOf = (oracle, underlying) => `${lc(oracle)}:${lc(underlying)}`;
        const spotReads = [
          ...new Map(
            candidates.flatMap((x, i) => {
              const o = seriesOf[i].oracle;
              // A series with no pinned oracle has no price anyone could judge it on: no spot is read from any oracle.
              return typeof o !== "string" || sameAddress(o, ZERO) ? [] : [[spotKeyOf(o, x.p.u), { oracle: o, underlying: x.p.u }]];
            }),
          ).values(),
        ];
        const spotRows = spotReads.length === 0 ? [] : await readMany(spotReads.map((r) => ({ address: r.oracle, abi: ABI.oracle, functionName: "trySpot", args: [r.underlying] })));
        const spots = new Map(spotReads.map((r, i) => [spotKeyOf(r.oracle, r.underlying), spotRows[i]]));
        oraclesUsed = new Set(spotReads.map((r) => lc(r.oracle))).size;
        candidates.forEach((x, i) => {
          const ser = seriesOf[i];
          const sp = spots.get(spotKeyOf(ser.oracle, x.p.u));
          // A reverting trySpot is the oracle's own alarm (v2_mon_oracle_paused, v2_mon_feed_stale), not this one's:
          // cancelStale returns false without a fresh spot, and so does this check. An unpinned oracle lands here too.
          const [spotOk, spot, spotUpdatedAt] = sp !== undefined && sp.ok ? sp.value : [false, 0n, 0n];
          const prev = s.rollerStale[x.key];
          const r = checkRollerAsk(
            {
              autoRoller: C.autoRoller,
              writer: x.p.w,
              underlying: x.p.u,
              ticker: tickerOf(x.p.u),
              longId: x.longId,
              orderId: x.orderId,
              isPut: ser.isPut,
              strike: ser.strike,
              expiry: x.expiry,
              remaining: BigInt(x.order.units) - BigInt(x.order.filled),
              spotOk,
              spot,
              spotUpdatedAt: Number(spotUpdatedAt),
              delegate: delegateRows[i].ok ? delegateRows[i].value : null,
              // A new order id is a new ask: the clock starts again, not where the last one left off.
              since: prev !== undefined && prev.orderId === x.orderId.toString() ? prev.since : null,
              now,
            },
            t,
          );
          if (r.stale) {
            overtakenNow += 1;
            s.rollerStale[x.key] = { orderId: x.orderId.toString(), since: r.since };
          } else delete s.rollerStale[x.key];
          out.push(...r.findings);
        });
      }
      for (const k of Object.keys(s.rollerStale)) if (s.roller[k] === undefined) delete s.rollerStale[k];
      return {
        findings: out,
        status: scanUsable ? "ok" : "incomplete",
        detail: `${pairs.length} rolled position(s), ${live.length} with a live ask, ${overtakenNow} at or past the strike, judged on ${oraclesUsed} pinned series oracle(s)`,
      };
    });

    // ---- admin actions ----
    // A failed scan still judges the logs of the ranges it completed: the cursor moved past them, so they would never be
    // seen again. For the same reason nothing below throws on a read: an unreadable input pages at the worse severity.
    await run("config", async () => {
      if (checks.scan.status === "skipped") return { status: "skipped", detail: "no v2 contracts" };
      const partial = checks.scan.status === "failed";
      const adopt = state.scan.adoptConfigUntil;
      const fresh = (e) => adopt === null || BigInt(e.blockNumber) > BigInt(adopt);
      const schedules = configEvents.filter((e) => e.eventName === "FeeParamsScheduled");
      for (const e of schedules) {
        if (e.feesBefore !== null || !fresh(e)) continue;
        try {
          e.feesBefore = await client.readContract({ address: e.address, abi: ABI.orderBook, functionName: "feeParams", blockNumber: BigInt(e.blockNumber) - 1n });
        } catch (error) {
          notes.push(`config: the fees in effect before block ${e.blockNumber} are unknown (the log replay has not seen the OrderBook's constructor, and feeParams() at the block before failed: ${shortError(error)}); the schedule pages as a rise`);
        }
      }
      let dataStreamsListed = [];
      if (reg.sources.dataStreams !== null && configEvents.some((e) => e.eventName === "DataStreamsFeedSet" && fresh(e))) {
        try {
          const ds = reg.sources.dataStreams;
          const withAsset = reg.markets.filter((m) => m.asset !== null);
          const lists = await readMany(withAsset.map((m) => ({ address: C.settlementOracle, abi: ABI.oracle, functionName: "marketConfig", args: [m.asset] })));
          withAsset.forEach((m, i) => {
            if (must(lists[i], `marketConfig(${m.ticker})`)[0].some((a) => sameAddress(a, ds))) dataStreamsListed.push(`${m.ticker} market list`);
          });
          const pinned = [...seriesExpiries().values()];
          const configs = await readMany(pinned.map((x) => ({ address: x.o, abi: ABI.oracle, functionName: "settlementConfig", args: [x.u, x.e] })));
          pinned.forEach((x, i) => {
            const c = configs[i];
            if (c.ok && c.value[0] && c.value[1].some((a) => sameAddress(a, ds))) dataStreamsListed.push(`${tickerOf(x.u)} ${iso(x.e)} pin`);
          });
        } catch (error) {
          dataStreamsListed = null;
          notes.push(`config: where the Data Streams source is listed could not be read (${shortError(error)}): its FeedSet pages as listed`);
        }
      }
      const ctx = { names, clearinghouse: C.clearinghouse, settlementOracle: C.settlementOracle, markets: reg.markets, dataStreamsListed };
      // T-OP-090. The sender of each fresh Repriced, one eth_getTransactionByHash per log (the event is rare). A
      // failed read leaves the sender unknown and the finding says so; it never blocks the other admin findings.
      const senders = new Map();
      for (const e of configEvents.filter((x) => x.eventName === "Repriced" && fresh(x))) {
        const h = lc(e.transactionHash);
        if (senders.has(h)) continue;
        try {
          const tx = await client.getTransaction({ hash: e.transactionHash });
          senders.set(h, tx?.from ?? null);
        } catch (error) {
          notes.push(`config: the sender of Repriced tx ${e.transactionHash} could not be read (${shortError(error)})`);
          senders.set(h, null);
        }
      }
      const out = [
        ...configEventFindings(
          configEvents.filter((e) => !OWN_KIND_EVENTS.has(e.eventName)),
          adopt,
          names,
        ),
        ...repriceFindings(configEvents, adopt, { t, pricerKey: reg.bots?.pricer ?? null, senders, tickerOf }),
        ...feeScheduledFindings(schedules, adopt),
        ...adminEventFindings(configEvents, adopt, ctx),
        // INTERFACE_VERSION 8: every AccessManager log, paged one for one under its own two kinds.
        ...managerEventFindings(configEvents, adopt, { names, manifest: ROLE_MANIFEST.manifest, selectors: managerSelectors, now: head.timestamp }),
        ...prePinFindings(pinLogs, adopt, ctx),
      ];
      return {
        findings: out,
        status: partial || !scanCaughtUp ? "incomplete" : "ok",
        detail: `${configEvents.length} admin events and ${pinLogs.length} series / pin logs in the scanned range (history before block ${adopt} adopted), ${out.length} new${partial ? "; the scan failed part way: the ranges it completed are judged" : ""}`,
      };
    });

    // ---- the OrderBook's fee schedule ----
    await run("fees", async () => {
      if (C.orderBook === null) return { status: "skipped", detail: "no OrderBook in the registry" };
      const [cur, pend] = await Promise.all([read(C.orderBook, ABI.orderBook, "feeParams"), read(C.orderBook, ABI.orderBook, "pendingFeeParams")]);
      const current = feeParamsOf(must(cur, "OrderBook.feeParams()"));
      const [params, at] = must(pend, "OrderBook.pendingFeeParams()");
      const effectiveAt = Number(at);
      if (effectiveAt === 0) return { detail: `in effect: ${describeFees(current)}; no change pending` };
      const pending = feeParamsOf(params);
      const announces = (kind, data) => kind === "v2_mon_fee_scheduled" && Number(data?.effectiveAt) === effectiveAt && sameFees(feeParamsOf(data?.params), pending);
      const announced = findings.some((f) => announces(f.kind, f.data)) || Object.values(state.alerts).some((e) => announces(e.kind, e.data));
      return {
        findings: checkPendingFees({ orderBook: C.orderBook, now: head.timestamp, current, pending, effectiveAt, announced }),
        detail: `in effect: ${describeFees(current)}; pending from ${iso(effectiveAt)}: ${describeFees(pending)}${announced ? " (announced by v2_mon_fee_scheduled)" : ""}`,
      };
    });


    /* ---- INTERFACE_VERSION 8: the AccessManager's state against the published manifest ---- */
    await run("manager", async () => {
      if (C.accessManager === null) return { status: "skipped", detail: "no accessManager in the registry" };
      const m = ROLE_MANIFEST.manifest;
      if (m === null) return { status: "incomplete", detail: `the role manifest could not be read: ${ROLE_MANIFEST.why}` };
      const ids = Object.entries(m.names).map(([id, name]) => ({ roleId: Number(id), name }));
      const unread = [];
      const rowReads = await readMany(
        ids.flatMap((r) => [
          { address: C.accessManager, abi: ABI.accessManager, functionName: "getRoleAdmin", args: [BigInt(r.roleId)] },
          { address: C.accessManager, abi: ABI.accessManager, functionName: "getRoleGuardian", args: [BigInt(r.roleId)] },
        ]),
      );
      const rows = ids.map((r, i) => {
        const admin = rowReads[i * 2];
        const guardian = rowReads[i * 2 + 1];
        if (!admin.ok) unread.push(`getRoleAdmin(${r.name})`);
        if (!guardian.ok) unread.push(`getRoleGuardian(${r.name})`);
        // A role with no entry in roleAdmin / roleGuardian defaults to ADMIN (0) in AccessManager itself, so the
        // manifest's silence is a statement, not a gap.
        const wantAdminName = m.roleAdmin?.[r.name];
        const wantGuardianName = m.roleGuardian?.[r.name];
        return {
          roleId: r.roleId,
          name: r.name,
          chainAdmin: admin.ok ? Number(admin.value) : null,
          chainGuardian: guardian.ok ? Number(guardian.value) : null,
          wantAdmin: wantAdminName === undefined ? (m.ids.ADMIN ?? 0) : (m.ids[wantAdminName] ?? null),
          wantGuardian: wantGuardianName === undefined ? (m.ids.ADMIN ?? 0) : (m.ids[wantGuardianName] ?? null),
        };
      });

      // The holders the registry actually publishes an address for. A holder the registry does not name yet is
      // not "held by nobody": it is unknown, and it is left out rather than paged as missing.
      const holderAddress = {
        adminSafe: reg.safes.admin,
        guardianKey: reg.bots?.guardian ?? null,
        pricerKey: reg.bots?.pricer ?? null,
        quoterKey: reg.bots?.quoter ?? null,
        crankerKey: reg.bots?.cranker ?? null,
      };
      const wanted = new Map();
      for (const [holder, roleNames] of Object.entries(m.holders ?? {})) {
        const address = holderAddress[holder] ?? null;
        if (address === null) continue;
        for (const roleName of roleNames) {
          const roleId = m.ids[roleName];
          if (roleId === undefined) continue;
          wanted.set(`${lc(address)}:${roleId}`, { label: holder, address, roleId, roleName });
        }
      }
      const pairs = [...wanted.values()];
      const access = pairs.length === 0 ? [] : await readMany(pairs.map((x) => ({ address: C.accessManager, abi: ABI.accessManager, functionName: "hasRole", args: [BigInt(x.roleId), x.address] })));
      const members = pairs.map((x, i) => {
        const r = access[i];
        if (!r.ok) unread.push(`hasRole(${x.roleName}, ${x.label})`);
        return {
          ...x,
          isMember: r.ok ? r.value[0] === true : null,
          executionDelay: r.ok ? Number(r.value[1]) : null,
          wantMember: true,
          wantDelayS: roleDelayS(x.roleId, m),
        };
      });
      for (const u of unread) notes.push(`manager: ${u} could not be read; that row is unknown and judged by nothing`);
      return {
        findings: checkManagerWiring({ manager: C.accessManager, rows, members }),
        status: unread.length > 0 ? "incomplete" : "ok",
        detail: `${rows.length} roles and ${members.length} published holders checked against ops/abis/v2/roles.json${unread.length > 0 ? `; ${unread.length} read(s) failed` : ""}`,
      };
    });

    /* ---- INTERFACE_VERSION 8: the protocol's own Safes ---- */
    await run("safes", async () => {
      const entries = [
        { key: "admin", address: reg.safes.admin, label: "Admin Safe" },
        { key: "treasury", address: reg.safes.treasury, label: "Treasury Safe" },
      ].filter((e) => e.address !== null);
      if (entries.length === 0) return { status: "skipped", detail: "the registry names no v8 Safes yet" };
      const out = [];
      const details = [];
      let incomplete = false;
      for (const e of entries) {
        const code = await client.getCode({ address: e.address, blockNumber: head.number });
        if (code === undefined || code === "0x") {
          incomplete = true;
          notes.push(`safes: ${e.label} ${e.address} has no code: it is an EOA or not deployed yet, and a one-key "multisig" is exactly what this check exists to find. Checked as unknown, not as healthy`);
          continue;
        }
        const [nonce, threshold, owners] = await Promise.all([read(e.address, ABI.safe, "nonce"), read(e.address, ABI.safe, "getThreshold"), read(e.address, ABI.safe, "getOwners")]);
        if (!threshold.ok || !owners.ok || !nonce.ok) {
          incomplete = true;
          notes.push(`safes: ${e.label} ${e.address} does not answer nonce/getThreshold/getOwners: not a Safe. Checked as unknown`);
          continue;
        }
        // The absolute floor first: it needs no history, so it fires on the very first run against a Safe that is
        // ALREADY 1-of-3 — the case a change-detector can never see.
        out.push(...checkSafeThreshold({ safe: e.address, label: e.label, threshold: threshold.value, owners: owners.value.length }));
        const r = checkSafe(state.safes[lc(e.address)], { nonce: nonce.value, threshold: threshold.value, owners: owners.value }, { safe: e.address, label: e.label, feeds: [], protocol: true });
        out.push(...r.findings);
        state.safes[lc(e.address)] = r.baseline;
        details.push(`${e.label} ${shortAddr(e.address)} ${threshold.value} of ${owners.value.length}, nonce ${nonce.value}`);
      }
      return { findings: out, status: incomplete ? "incomplete" : "ok", detail: details.join("; ") || "no Safe could be read" };
    });

    /* ---- INTERFACE_VERSION 8: the fee splitter and the buyback ---- */
    await run("flywheel", async () => {
      const splitter = reg.flywheel?.feeSplitter ?? null;
      if (splitter === null) return { status: "skipped", detail: "no v2.flywheel.feeSplitter in the registry" };
      const skip = needsScan();
      if (skip) return skip;
      const fly = (state.scan.flywheel ??= { lastDistributedAt: null, pendingSince: null, floorMisses: {}, lastBoughtBackAt: null, fundedSince: null, lastSkip: null });
      const unburned = applyFlywheelLogs(fly, configEvents, head.timestamp, splitter);
      const [balance, lastAt] = await Promise.all([read(splitter, ABI.feeSplitter, "buybackBalance"), read(splitter, ABI.feeSplitter, "lastBuybackAt")]);
      if (!balance.ok) notes.push(`flywheel: FeeSplitter.buybackBalance() could not be read (${balance.error}); the buyback check treats the balance as unknown and pages nothing about it`);
      if (!lastAt.ok) notes.push(`flywheel: FeeSplitter.lastBuybackAt() could not be read (${lastAt.error})`);
      // 0 from the contract means NEVER, not 1970: buybackClock maps it to null so no age is computed from it.
      const lastBuybackAt = lastAt.ok ? buybackClock(lastAt.value) : null;
      const floorMisses = Object.entries(fly.floorMisses ?? {}).map(([asset, v]) => ({ asset, ticker: tickerOf(asset), ...v }));
      const out = [
        ...checkSplitter({ splitter, now: head.timestamp, lastDistributedAt: fly.lastDistributedAt, pendingSince: fly.pendingSince, floorMisses }, t),
        ...checkBuyback({ splitter, now: head.timestamp, balance: balance.ok ? balance.value : null, lastBuybackAt, fundedSince: fly.fundedSince, lastSkip: fly.lastSkip, unburned }, t),
      ];
      return {
        findings: out,
        status: balance.ok && lastAt.ok && scanUsable ? "ok" : "incomplete",
        detail: `buyback balance ${balance.ok ? `${usdg(balance.value)} USDG` : "unknown"}, last buyback ${lastBuybackAt === null ? "never" : iso(lastBuybackAt)}, ${floorMisses.length} asset(s) with a skip streak`,
      };
    });

    /* ---- INTERFACE_VERSION 8: payout routes, v3 or v4, decoded with the shape the chain actually has ---- */
    await run("routes", async () => {
      if (C.payoutAdapter === null) return { status: "skipped", detail: "no payoutAdapter in the registry" };
      if (reg.interfaceVersion === null) return { status: "incomplete", detail: "the registry publishes no v2.interfaceVersion, so which routes() shape to decode is unknown" };
      // Before INTERFACE_VERSION 8 there is no route STATE to read: the v7 adapter's routes are judged from its
      // RouteSet logs (v2_mon_route_changed), so nothing here decodes anything and the collision cannot arise.
      // The guard below therefore lives where the decode does, not one step earlier.
      if (reg.interfaceVersion < 8) return { status: "skipped", detail: `interface ${reg.interfaceVersion}: the v7 adapter's routes are judged by RouteSet events (v2_mon_route_changed)` };
      // routes(address) is ONE selector with TWO return tuples (see ABI_TEXT.payoutRouter). Identify before
      // decoding: only the v7 adapter answers factory().
      const probe = await read(C.payoutAdapter, ABI.payoutAdapter, "factory");
      const isAdapter = probe.ok ? true : probe.revert ? false : null;
      if (isAdapter === null) {
        notes.push(`routes: ${C.payoutAdapter} did not answer factory() and did not revert either (${probe.error}); which routes() shape it has is unknown, so no route was decoded`);
        return { status: "incomplete", detail: "the payout contract could not be identified; nothing decoded" };
      }
      const decodeFindings = checkRouteDecode({ address: C.payoutAdapter, interfaceVersion: reg.interfaceVersion, isAdapter });
      if (decodeFindings.length > 0) {
        // Fail closed. Decoding with the wrong list does not revert, it lies.
        return { findings: decodeFindings, status: "incomplete", detail: "the registry's interface version and the deployed payout contract disagree; no route decoded" };
      }
      const withAsset = markets.filter((m) => m.asset !== null);
      if (withAsset.length === 0) return { status: "skipped", detail: "no market in scope" };
      const reads = await readMany(withAsset.map((m) => ({ address: C.payoutAdapter, abi: ABI.payoutRouter, functionName: "routes", args: [m.asset] })));
      const out = [];
      const details = [];
      let unread = 0;
      withAsset.forEach((m, i) => {
        const r = reads[i];
        if (!r.ok) {
          unread += 1;
          notes.push(`routes: PayoutRouter.routes(${m.ticker}) could not be read (${r.error}); that route is unknown and judged by nothing`);
          return;
        }
        const want = m.v2?.payoutRoute ?? null;
        let poolId = null;
        if (want !== null && want.venue === "v4" && reg.usdg !== null) {
          poolId = v4PoolId(viem, { ...routeCurrencies(m.asset, reg.usdg), fee: want.fee, tickSpacing: want.tickSpacing, hooks: V4_HOOKS });
        }
        out.push(...checkRoute({ ticker: m.ticker, asset: m.asset, route: r.value, registryRoute: want, poolId }));
        details.push(`${m.ticker} ${routeVenueName(r.value.venue)}${Number(r.value.venue) === 0 ? "" : ` fee ${r.value.fee} (${r.value.feeBps} bps)`}`);
      });
      return { findings: out, status: unread > 0 ? "incomplete" : "ok", detail: details.join(", ") || "no route read" };
    });

    /* ---- INTERFACE_VERSION 8: the STONKHOUSE pool the buyback swaps in ---- */
    await run("tokenpool", async () => {
      const key = reg.token?.poolKey ?? null;
      const published = key !== null && key.currency0 !== null && key.currency1 !== null && key.fee !== null && key.tickSpacing !== null && key.hooks !== null;
      if (!published) return { status: "skipped", detail: "the registry publishes no complete shared.token.poolKey yet" };
      const recomputed = v4PoolId(viem, key);
      // The depth is v4 PoolManager state and the registry publishes no PoolManager, so it is UNKNOWN here rather
      // than 0. checkTokenPool pages on an unknown depth only when an operator set a floor to compare it against.
      return {
        findings: checkTokenPool({ poolId: reg.token.poolId, poolKey: key, recomputedPoolId: recomputed, depth: null }, t),
        status: t.tokenPoolMinDepth > 0 ? "incomplete" : "ok",
        detail: `pool ${reg.token.poolId ?? "(unpublished)"} fee ${key.fee} (${Number(key.fee) / 100} bps), tickSpacing ${key.tickSpacing}, hooks ${key.hooks}; depth unknown (no v4 PoolManager in the registry)`,
      };
    });

    /* ---- INTERFACE_VERSION 8: value locked against the owner's audit trigger ---- */
    await run("tvl", async () => {
      // WHY THESE ARE NOT `skipped` ANY MORE. record() puts a skipped check into `completed`, and
      // reconcile() DELETES remembered conditions whose check completed — so a mis-registered
      // `shared.usdg` used to silently CLEAR a live audit-trigger alert instead of raising one. The
      // check now completes with a fault finding rather than opting out of having an opinion.
      const expected = ["clearinghouse", "makerVault"];
      const held = [
        { name: "clearinghouse", address: C.clearinghouse },
        { name: "makerVault", address: C.makerVault },
      ].filter((x) => x.address !== null);

      // Nothing deployed and the notice off is the one genuinely empty case: pre-deploy, and silent.
      if (held.length === 0 && t.auditTriggerUsdg <= 0) {
        return { status: "skipped", detail: "no v2 contracts in the registry and auditTriggerUsdg 0: the audit-trigger notice is off" };
      }
      const faultOnly = (detail, x) => ({ findings: tvlFaults(x, t), status: "ok", detail });
      if (reg.usdg === null) {
        return faultOnly("no shared.usdg in the registry: value locked cannot be measured",
          { locked: null, parts: [], usdgTotalSupply: null, headAgeS: null, holdersFound: held.length, holdersExpected: expected.length });
      }
      if (held.length === 0) {
        return faultOnly(`a ${usdg(t.auditTriggerUsdg)} USDG trigger is set but the registry names none of ${expected.join(", ")}`,
          { locked: null, parts: [], usdgTotalSupply: null, headAgeS: null, holdersFound: 0, holdersExpected: expected.length });
      }

      const reads = await readMany([
        ...held.map((x) => ({ address: reg.usdg, abi: ABI.erc20, functionName: "balanceOf", args: [x.address] })),
        { address: reg.usdg, abi: ABI.erc20, functionName: "totalSupply", args: [] },
      ]);
      const supplyRead = reads[held.length];
      const parts = [];
      let total = 0n;
      let complete = true;
      held.forEach((x, i) => {
        if (!reads[i].ok) {
          complete = false;
          notes.push(`tvl: the USDG balance of ${x.name} could not be read (${reads[i].error})`);
          return;
        }
        parts.push({ name: x.name, amount: reads[i].value });
        total += BigInt(reads[i].value);
      });
      if (!supplyRead.ok) notes.push(`tvl: USDG totalSupply could not be read (${supplyRead.error})`);
      // A partial sum reported as a total pages LATE, which is the one thing this notice must not do.
      const locked = complete ? total : null;
      const x = {
        locked,
        parts,
        usdgTotalSupply: supplyRead.ok ? BigInt(supplyRead.value) : null,
        headAgeS: head === null ? null : wallNow - head.timestamp,
        holdersFound: held.length,
        holdersExpected: expected.length,
      };
      const findings = checkTvl(x, t);
      const faulted = findings.some((f) => f.key === "fault");
      return {
        findings,
        // `incomplete` is still honest about the read, but a fault is an OPINION, and record() must
        // keep the check in `completed` so reconcile can remember and later resolve that opinion.
        status: complete || faulted ? "ok" : "incomplete",
        detail: complete
          ? `${usdg(total)} USDG locked (${parts.map((p) => `${p.name} ${usdg(p.amount)}`).join(", ")}) against a ${t.auditTriggerUsdg > 0 ? `${usdg(t.auditTriggerUsdg)} USDG trigger` : "trigger that is OFF"}`
          : "unknown: at least one balance could not be read",
      };
    });

    // ---- pins: can the next series pin, who pinned, and is every expiry with series pinned as the registry says ----
    await run("pins", async () => {
      if (C.clearinghouse === null || C.settlementOracle === null) return { status: "skipped", detail: "no Clearinghouse or SettlementOracle in the registry" };
      const skip = needsScan();
      if (skip) return skip;
      const s = state.scan;
      const now = head.timestamp;
      for (const k of Object.keys(s.sourcePins)) if (Number(k.split(":")[1]) < now) delete s.sourcePins[k];
      for (const k of Object.keys(s.special)) if (Number(k) < now) delete s.special[k];
      const withSeries = seriesExpiries();
      for (const k of Object.keys(s.pinsVerified)) if (!withSeries.has(k)) delete s.pinsVerified[k];
      const closes = [...new Set([...gridCloses(now), ...Object.keys(s.special).map(Number).filter((ts) => ts >= now + MIN_SERIES_LEAD && ts <= now + MAX_TENOR)])].sort((a, b) => a - b);
      const wanted = opts.tickers === null ? null : new Set(opts.tickers.map((x) => x.toUpperCase()));
      const scope = reg.markets.filter((m) => m.asset !== null && (wanted === null || wanted.has(m.ticker.toUpperCase())));

      const key = createHash("sha256")
        .update(
          JSON.stringify(
            { closes, withSeries: [...withSeries.keys()].sort(), scope: scope.map((m) => [m.asset, m.feed, m.v2]), defaults: reg.defaults, contracts: C, sources: reg.sources },
            bigintReplacer,
          ),
        )
        .digest("hex");
      const cache = s.pinsCache;
      if (!pinsDirty && scanUsable && cache !== null && cache.key === key && wallNow - cache.at < t.pinCheckS) {
        return {
          findings: cache.findings,
          detail: `${cache.detail}; served from block ${cache.block}'s reads, ${wallNow - cache.at} s old (re-read on a pin or wiring log, new expiries or registry values, or after ${t.pinCheckS} s)`,
        };
      }
      s.pinsCache = null;

      const out = [];
      const rows = await readMany([
        { address: C.clearinghouse, abi: ABI.clearinghouseConfig, functionName: "calendar" },
        ...scope.map((m) => ({ address: C.clearinghouse, abi: ABI.clearinghouseConfig, functionName: "market", args: [m.asset] })),
      ]);
      const calendar = must(rows[0], "Clearinghouse.calendar()");
      const registered = [];
      scope.forEach((m, i) => {
        const row = must(rows[i + 1], `Clearinghouse.market(${m.ticker})`);
        if (BigInt(row.strikeTick) === 0n) return;
        registered.push({ m, row });
        out.push(...checkMarketOracle({ ticker: m.ticker, underlying: m.asset, oracle: row.oracle, publishedOracle: C.settlementOracle }));
      });
      const ours = registered.filter(({ row }) => sameAddress(row.oracle, C.settlementOracle));
      const valid = ours.length === 0 ? [] : await readMany(closes.map((ts) => ({ address: calendar, abi: ABI.calendar, functionName: "isValidExpiry", args: [ts] })));
      const creatable = ours.length === 0 ? [] : closes.filter((ts, i) => must(valid[i], `ExpiryCalendar.isValidExpiry(${ts})`) === true);

      // pinnedBy of every (market, creatable expiry) and every expiry with series on the published oracle.
      const targets = new Map();
      const addTarget = (u, e, hasSeries) => {
        const k = `${lc(u)}:${e}`;
        const cur = targets.get(k);
        if (cur !== undefined) cur.hasSeries ||= hasSeries;
        else targets.set(k, { u, e, hasSeries, pinnedBy: ZERO });
      };
      for (const { m } of ours) for (const e of creatable) addTarget(m.asset, e, false);
      for (const x of withSeries.values()) if (sameAddress(x.o, C.settlementOracle)) addTarget(x.u, x.e, true);
      const targetList = [...targets.values()];
      const by = await readMany(targetList.map((x) => ({ address: C.settlementOracle, abi: ABI.oracle, functionName: "pinnedBy", args: [x.u, x.e] })));
      targetList.forEach((x, i) => {
        x.pinnedBy = must(by[i], `SettlementOracle.pinnedBy(${tickerOf(x.u)}, ${x.e})`);
        out.push(...checkPinnedBy({ ticker: tickerOf(x.u), underlying: x.u, oracle: C.settlementOracle, expiry: x.e, pinnedBy: x.pinnedBy, clearinghouse: C.clearinghouse, hasSeries: x.hasSeries }));
      });

      // One Clearinghouse pin per enabled market for the expiries nobody pinned, one per expiry pinned some other way.
      const sims = [];
      for (const { m, row } of ours) {
        if (!row.enabled) continue;
        const pinnedBy = new Map(creatable.map((e) => [e, targets.get(`${lc(m.asset)}:${e}`).pinnedBy]));
        const sourcePinned = new Set(creatable.filter((e) => s.sourcePins[`${lc(m.asset)}:${e}`]));
        const { representative, individual } = pinTargets(creatable, pinnedBy, sourcePinned, C.clearinghouse);
        if (representative !== null) sims.push({ m, expiry: representative, representative: true });
        for (const e of individual) sims.push({ m, expiry: e, representative: false });
      }
      const results = await mapLimit(sims, PIN_SIMULATION_CONCURRENCY, (x) => simulatePin(C.settlementOracle, x.m.asset, x.expiry));
      sims.forEach((x, i) => {
        out.push(...checkPinSimulation({ ticker: x.m.ticker, underlying: x.m.asset, oracle: C.settlementOracle, expiry: x.expiry, representative: x.representative, ok: results[i].ok, revert: results[i].revert, names }));
      });

      // Every expiry with series, once, against the registry (a pin never changes; Data Streams' version can).
      const calls = [];
      const plan = [];
      for (const [k, x] of withSeries) {
        if (s.pinsVerified[k]) continue;
        if (!sameAddress(x.o, C.settlementOracle)) {
          plan.push({ k, x, idx: null });
          continue;
        }
        const idx = { config: calls.push({ address: x.o, abi: ABI.oracle, functionName: "settlementConfig", args: [x.u, x.e] }) - 1 };
        if (reg.sources.chainlink) idx.chainlink = calls.push({ address: reg.sources.chainlink, abi: ABI.chainlinkSource, functionName: "pinnedFeeds", args: [x.u, x.e] }) - 1;
        if (reg.sources.univ3) idx.univ3 = calls.push({ address: reg.sources.univ3, abi: ABI.univ3, functionName: "pinnedPools", args: [x.u, x.e] }) - 1;
        if (reg.sources.dataStreams) {
          idx.dataStreams = calls.push({ address: reg.sources.dataStreams, abi: ABI.dataStreamsSource, functionName: "pinnedFeeds", args: [x.u, x.e] }) - 1;
          idx.feedVersion = calls.push({ address: reg.sources.dataStreams, abi: ABI.dataStreamsSource, functionName: "feedVersion", args: [x.u] }) - 1;
        }
        plan.push({ k, x, idx });
      }
      const res = await readMany(calls);
      let verifiedNow = 0;
      for (const { k, x, idx } of plan) {
        const m = reg.markets.find((mm) => sameAddress(mm.asset, x.u)) ?? null;
        const base = { ticker: tickerOf(x.u), underlying: x.u, expiry: x.e, oracle: x.o, publishedOracle: C.settlementOracle, expected: m === null ? null : expectedPinnedConfig(reg, m), sources: reg.sources, names };
        if (idx === null) {
          out.push(...checkPinnedConfig({ ...base, config: { pinned: false, sources: [] }, chainlink: null, univ3: null, dataStreams: null }).findings);
          continue;
        }
        const where = `${tickerOf(x.u)} ${x.e}`;
        const [pinned, sources, dev, delay, age] = must(res[idx.config], `settlementConfig(${where})`);
        const cl = idx.chainlink === undefined ? null : must(res[idx.chainlink], `ChainlinkFeedSource.pinnedFeeds(${where})`);
        const uni = idx.univ3 === undefined ? null : must(res[idx.univ3], `UniV3TwapSource.pinnedPools(${where})`);
        const ds = idx.dataStreams === undefined ? null : must(res[idx.dataStreams], `DataStreamsSource.pinnedFeeds(${where})`);
        const r = checkPinnedConfig({
          ...base,
          config: { pinned, sources: [...sources], maxDeviationBps: Number(dev), uncorroboratedDelay: Number(delay), spotMaxAge: Number(age) },
          chainlink: cl === null ? null : { feed: cl[0], maxStale: Number(cl[1]), maxRoundJumpBps: Number(cl[2]), pinned: cl[3] },
          univ3: uni === null ? null : { pool: uni[0], window: Number(uni[3]), pinned: uni[4], minLiquidity: uni[5] },
          dataStreams: ds === null ? null : { pinned: ds[0], version: ds[1], currentVersion: must(res[idx.feedVersion], `DataStreamsSource.feedVersion(${where})`) },
        });
        out.push(...r.findings);
        if (r.verified && scanUsable) {
          s.pinsVerified[k] = 1;
          verifiedNow += 1;
        }
      }

      const span = creatable.length === 0 ? "" : ` (${iso(creatable[0])} to ${iso(creatable[creatable.length - 1])})`;
      const detail = `${ours.length} registered market(s) on the published oracle, ${creatable.length} creatable expiries${span}; ${targetList.length} pinnedBy read(s), ${sims.length} pin simulation(s) from the Clearinghouse, ${plan.length} expiries with series compared with the registry (${verifiedNow} verified now, ${Object.keys(s.pinsVerified).length} in all)`;
      const serial = JSON.parse(JSON.stringify(out, bigintReplacer));
      if (scanUsable) s.pinsCache = { key, at: wallNow, block: head.number.toString(), findings: serial, detail };
      return { findings: serial, status: scanUsable ? "ok" : "incomplete", detail };
    });

    // ---- feeds ----
    // Scope is the registry's `live` and `paused` markets, but the chain is the truth: a market registered on
    // the Clearinghouse while the baked registry still says `planned` is open to users, and the feeds, tokens
    // and pools checks used to report "no market in scope" for it. Add it, and say the registry is behind.
    if (!opts.allMarkets && opts.tickers === null && C.clearinghouse !== null) {
      const missing = reg.markets.filter((m) => m.asset !== null && m.v2 !== null && !markets.includes(m));
      if (missing.length > 0) {
        try {
          const rows = await readMany(missing.map((m) => ({ address: C.clearinghouse, abi: ABI.clearinghouseConfig, functionName: "market", args: [m.asset] })));
          const added = missing.filter((m, i) => rows[i].ok && BigInt(rows[i].value.strikeTick) !== 0n);
          if (added.length > 0) {
            markets = [...markets, ...added];
            notes.push(
              `scope: ${added.map((m) => `${m.ticker} (registry says ${m.v2.status})`).join(", ")} ${added.length === 1 ? "is" : "are"} registered on the Clearinghouse, so ${added.length === 1 ? "it is" : "they are"} watched anyway; update ops/markets/tier1.json`,
            );
          }
        } catch (error) {
          notes.push(`scope: could not read Clearinghouse.market() for the registry's non-live markets (${shortError(error)}); scope is the registry's live and paused markets only`);
        }
      }
    }

    // ---- writer rent (INTERFACE_VERSION 7, c05) ----
    // Two things: the rate each market charges now, and whether the rent already charged adds up. The second needs no
    // chain read at all — Minted.fee in, Closed.feeRefund out, MintFeesAccrued to the treasury is the whole ledger.
    await run("rent", async () => {
      if (C.clearinghouse === null) return { status: "skipped", detail: "no Clearinghouse in the registry" };
      const skip = needsScan();
      if (skip) return skip;
      const s = state.scan;
      const out = [];
      const marketPpm = new Map();
      const rows = markets.length === 0 ? [] : await readMany(markets.map((m) => ({ address: C.clearinghouse, abi: ABI.clearinghouseConfig, functionName: "market", args: [m.asset] })));
      markets.forEach((m, i) => {
        const r = rows[i];
        const row = r.ok && BigInt(r.value.strikeTick) !== 0n ? r.value : null;
        if (row !== null) marketPpm.set(lc(m.asset), Number(row.mintFeePpm));
        out.push(
          ...checkMintFee({
            ticker: m.ticker,
            underlying: m.asset,
            enabled: row !== null && row.enabled === true,
            chainPpm: row === null ? null : Number(row.mintFeePpm),
            registryPpm: m.v2?.mintFeePpm ?? null,
            interfaceVersion: reg.interfaceVersion,
            allowRent: reg.allowRent,
          }),
        );
      });
      let judged = 0;
      for (const [longId, r] of Object.entries(s.rent ?? {})) {
        const sr = s.series[longId];
        // No SeriesCreated in the scan (or one recorded before the rate was tracked): the sums are not the whole life.
        if (sr === undefined || typeof sr.p !== "number") continue;
        judged += 1;
        out.push(
          ...checkMintRent({
            longId,
            label: `${tickerOf(sr.u)} ${sr.put ? "put" : "call"} ${usdg(sr.k)} ${iso(sr.e)}`,
            ppm: sr.p,
            marketPpm: marketPpm.has(lc(sr.u)) ? marketPpm.get(lc(sr.u)) : null,
            paid: BigInt(r.paid),
            refunded: BigInt(r.refunded),
            accrued: BigInt(r.accrued),
            mints: r.mints,
            zeroFeeMints: r.zeroFee,
            settled: s.settled[longId] !== undefined,
            complete: true,
            interfaceVersion: reg.interfaceVersion,
          }),
        );
      }
      // The ledger of a series lives and dies with the series row the settlement check prunes.
      for (const longId of Object.keys(s.rent ?? {})) if (s.series[longId] === undefined && s.settled[longId] === undefined) delete s.rent[longId];
      const rates = markets.map((m) => `${m.ticker} ${marketPpm.has(lc(m.asset)) ? `${marketPpm.get(lc(m.asset))} ppm` : "not registered"}`);
      return { findings: out, status: scanUsable ? "ok" : "incomplete", detail: `${judged} series' rent ledgers checked; rates ${rates.join(", ")}` };
    });

    await run("feeds", async (out) => {
      if (markets.length === 0) return { status: "skipped", detail: "no market in scope" };
      const safes = new Map();
      const details = [];
      for (const m of markets) {
        let sourceFeed = null;
        if (reg.sources.chainlink) {
          const f = await read(reg.sources.chainlink, ABI.chainlinkSource, "feeds", [m.asset]);
          sourceFeed = must(f, `feeds(${m.ticker})`)[0];
          if (sameAddress(sourceFeed, ZERO)) sourceFeed = null;
        }
        if (sourceFeed !== null) out.push(...checkFeedMismatch({ ticker: m.ticker, underlying: m.asset, sourceFeed, registryFeed: m.feed }));
        const feed = sourceFeed ?? m.feed;
        if (feed === null) {
          details.push(`${m.ticker} no feed`);
          continue;
        }
        const [agg, ac, own, latest, dec] = await Promise.all([
          read(feed, ABI.feed, "aggregator"),
          read(feed, ABI.feed, "accessController"),
          read(feed, ABI.feed, "owner"),
          read(feed, ABI.feed, "latestRoundData"),
          read(feed, ABI.feed, "decimals"),
        ]);
        for (const r of [agg, ac, own]) if (!r.ok && !r.revert) throw new Error(`${m.ticker} feed read: ${r.error}`);
        const prev = state.feeds[lc(feed)];
        let baseline = { aggregator: prev?.aggregator ?? null, owner: prev?.owner ?? null, lastRoundId: prev?.lastRoundId ?? null };
        if (agg.ok) {
          const r = checkFeedProxy(
            prev,
            { aggregator: agg.value, accessController: ac.ok ? ac.value : null, owner: own.ok ? own.value : null },
            { ticker: m.ticker, feed, registryAggregator: sameAddress(feed, m.feed) ? m.feedAggregator : null },
          );
          out.push(...r.findings);
          baseline = r.baseline;
          if (own.ok && !sameAddress(own.value, ZERO)) {
            const entry = safes.get(lc(own.value)) ?? { safe: own.value, feeds: [] };
            entry.feeds.push(`${m.ticker} ${shortAddr(feed)}`);
            safes.set(lc(own.value), entry);
          }
        } else {
          notes.push(`feeds: ${m.ticker} ${feed} has no aggregator() (not a Chainlink proxy, e.g. a devnet mock): proxy and Safe checks skipped`);
        }
        const [latestId] = must(latest, `${m.ticker} latestRoundData`);
        const ids = roundIdsToRead(latestId, baseline.lastRoundId, t.maxRoundsPerRun);
        const rounds = await Promise.all(
          ids.map(async (id) => {
            if (id === latestId) return { id, answer: must(latest, "latestRoundData")[1], updatedAt: Number(must(latest, "latestRoundData")[3]) };
            const r = await read(feed, ABI.feed, "getRoundData", [id]);
            // A read that FAILED is not an empty round: both comparisons round it would take part in are
            // skipped, so the baseline must not move past it or that print is never compared again.
            if (!r.ok && !r.revert) return { id, answer: null, updatedAt: 0, unread: true };
            if (!r.ok || r.value[3] === 0n) return { id, answer: null, updatedAt: 0 };
            return { id, answer: r.value[1], updatedAt: Number(r.value[3]) };
          }),
        );
        out.push(...checkRoundJumps(rounds, { ticker: m.ticker, feed, decimals: dec.ok ? Number(dec.value) : 8 }, t));
        const latestRound = must(latest, "latestRoundData");
        out.push(...checkFeedStale({ ticker: m.ticker, feed, now: head.timestamp, roundId: latestId, updatedAt: Number(latestRound[3]), heartbeatS: m.feedHeartbeatS }, t));
        const firstUnread = rounds.findIndex((r) => r.unread);
        const lastId = ids[ids.length - 1];
        if (firstUnread === -1) baseline.lastRoundId = lastId.toString();
        else if (firstUnread > 0) baseline.lastRoundId = ids[firstUnread - 1].toString();
        if (firstUnread !== -1) notes.push(`feeds: ${m.ticker} round ${rounds[firstUnread].id & ROUND_MASK} could not be read; the baseline stays at ${baseline.lastRoundId ?? "none"} and the next run reads it again`);
        else if (lastId !== latestId) notes.push(`feeds: ${m.ticker} is catching up on rounds, ${(latestId & ROUND_MASK) - (lastId & ROUND_MASK)} still to read after this run (--threshold maxRoundsPerRun raises the pace)`);
        state.feeds[lc(feed)] = baseline;
        details.push(`${m.ticker} ${agg.ok ? "proxy" : "no proxy"}, ${ids.length - 1} round step(s), last round ${duration(Math.max(0, head.timestamp - Number(latestRound[3])))} old`);

        // An expiry pinned before a setFeed(A -> B) still settles on A, so A has to be watched as well: an access
        // controller or an aggregator switch on it decides that expiry's price, and nothing else looks at it.
        if (reg.sources.chainlink) {
          const open = [...seriesExpiries().values()].filter((x) => sameAddress(x.u, m.asset));
          const seen = new Set([lc(feed)]);
          for (const x of open) {
            const p = await read(reg.sources.chainlink, ABI.chainlinkSource, "pinnedFeeds", [m.asset, x.e]);
            if (!p.ok || p.value[3] !== true) continue;
            const pinned = p.value[0];
            if (sameAddress(pinned, ZERO) || seen.has(lc(pinned))) continue;
            seen.add(lc(pinned));
            const [pagg, pac, pown] = await Promise.all([read(pinned, ABI.feed, "aggregator"), read(pinned, ABI.feed, "accessController"), read(pinned, ABI.feed, "owner")]);
            if (!pagg.ok) {
              notes.push(`feeds: ${m.ticker} expiry ${iso(x.e)} is pinned to ${pinned}, which has no aggregator(): proxy checks skipped for it`);
              continue;
            }
            const r = checkFeedProxy(state.feeds[lc(pinned)], { aggregator: pagg.value, accessController: pac.ok ? pac.value : null, owner: pown.ok ? pown.value : null }, { ticker: `${m.ticker} (pinned for ${iso(x.e)})`, feed: pinned, registryAggregator: null });
            out.push(...r.findings);
            state.feeds[lc(pinned)] = { ...r.baseline, lastRoundId: state.feeds[lc(pinned)]?.lastRoundId ?? null };
            if (pown.ok && !sameAddress(pown.value, ZERO)) {
              const entry = safes.get(lc(pown.value)) ?? { safe: pown.value, feeds: [] };
              entry.feeds.push(`${m.ticker} ${shortAddr(pinned)} (pinned)`);
              safes.set(lc(pown.value), entry);
            }
            details.push(`${m.ticker} pinned feed ${shortAddr(pinned)} for ${iso(x.e)}`);
          }
        }
      }
      for (const entry of safes.values()) {
        const code = await client.getCode({ address: entry.safe, blockNumber: head.number });
        if (code === undefined || code === "0x") {
          notes.push(`feeds: feed owner ${entry.safe} has no code (an EOA or a detached devnet): Safe checks skipped`);
          continue;
        }
        const [nonce, threshold, owners] = await Promise.all([read(entry.safe, ABI.safe, "nonce"), read(entry.safe, ABI.safe, "getThreshold"), read(entry.safe, ABI.safe, "getOwners")]);
        if (!nonce.ok || !threshold.ok || !owners.ok) {
          notes.push(`feeds: feed owner ${entry.safe} does not answer nonce/getThreshold/getOwners: not a Safe; Safe checks skipped`);
          continue;
        }
        const r = checkSafe(state.safes[lc(entry.safe)], { nonce: nonce.value, threshold: threshold.value, owners: owners.value }, { safe: entry.safe, feeds: entry.feeds });
        out.push(...r.findings);
        state.safes[lc(entry.safe)] = r.baseline;
        details.push(`Safe ${shortAddr(entry.safe)} nonce ${nonce.value} (${threshold.value} of ${owners.value.length})`);
      }
      return { detail: details.join("; ") };
    });

    // Independent pool TWAP catches a stalled feed before the MM's 300 bps refusal. Bands must be
    // calibrated from 30 days of paired readings and are deliberately absent from the default env.
    await run("divergence", async (out) => {
      const watched = markets.filter((m) => divergenceBands[m.ticker.toUpperCase()] !== undefined);
      if (watched.length === 0) return { status: "skipped", detail: "no calibrated in-scope market bands" };
      if (!marketStretch(head.timestamp).open) {
        for (const m of watched) delete state.divergenceStreaks[lc(m.asset)];
        return { detail: "24/5 market closed" };
      }
      const detail = [];
      let incomplete = false;
      for (const m of watched) {
        const key = lc(m.asset);
        const [feed, pool] = await Promise.all([
          read(reg.sources.chainlink, ABI.chainlinkSource, "latest", [m.asset]),
          read(reg.sources.univ3, ABI.univ3, "latest", [m.asset]),
        ]);
        if (!feed.ok || !pool.ok || !feed.value[0] || !pool.value[0] || feed.value[1] <= 0n || pool.value[1] <= 0n || Number(feed.value[2]) > head.timestamp) {
          delete state.divergenceStreaks[key];
          incomplete = true;
          detail.push(`${m.ticker} paired source price unavailable`);
          continue;
        }
        const result = checkPriceDivergence({
          ticker: m.ticker, underlying: m.asset, chainlinkSource: reg.sources.chainlink,
          poolSource: reg.sources.univ3, feedPrice: feed.value[1], poolPrice: pool.value[1],
          bandBps: divergenceBands[m.ticker.toUpperCase()], head: head.number,
        }, state.divergenceStreaks[key] ?? null);
        if (result.streak === null) delete state.divergenceStreaks[key];
        else state.divergenceStreaks[key] = result.streak;
        out.push(...result.findings);
        detail.push(`${m.ticker} ${usdg(feed.value[1])} feed / ${usdg(pool.value[1])} pool, band ${divergenceBands[m.ticker.toUpperCase()]} bps`);
      }
      return { status: incomplete ? "incomplete" : "ok", detail: detail.join("; ") };
    });

    // ---- Stock Tokens ----
    await run("tokens", async (out) => {
      if (markets.length === 0) return { status: "skipped", detail: "no market in scope" };
      const watched = [
        ["clearinghouse", C.clearinghouse],
        ["makerVault", C.makerVault],
        ["payoutAdapter", C.payoutAdapter],
      ].filter(([, a]) => a !== null);
      for (const m of markets) {
        const [paused, oraclePaused, ui, next, eff, acr] = await Promise.all(ABI_TEXT.stockToken.map((_, i) => read(m.asset, ABI.stockToken, ["paused", "oraclePaused", "uiMultiplier", "newUIMultiplier", "effectiveAt", "ACCESS_CONTROLLED_REGISTRY"][i])));
        const blocked = [];
        const registry = must(acr, `${m.ticker} ACCESS_CONTROLLED_REGISTRY()`);
        const targets = [...watched, ...(m.v2.univ3Pool ? [["pool", m.v2.univ3Pool]] : [])];
        await Promise.all(
          targets.map(async ([name, address]) => {
            blocked.push({ name, address, blocked: must(await read(registry, ABI.stockRegistry, "isBlocked", [address]), `${m.ticker} isBlocked(${name})`) });
          }),
        );
        const opt = (r, what) => {
          if (r.ok) return r.value;
          if (r.revert) return null;
          throw new Error(`${m.ticker} ${what}: ${r.error}`);
        };
        out.push(
          ...checkStockToken({
            ticker: m.ticker,
            token: m.asset,
            now: head.timestamp,
            paused: must(paused, `${m.ticker} paused()`),
            oraclePaused: opt(oraclePaused, "oraclePaused()"),
            uiMultiplier: opt(ui, "uiMultiplier()"),
            newUIMultiplier: opt(next, "newUIMultiplier()"),
            effectiveAt: opt(eff, "effectiveAt()") === null ? null : Number(eff.value),
            blocked,
          }),
        );
      }
      // UIMultiplierUpdated since the last run (first run: the lookback, never before the v2 deploy block).
      let from;
      if (state.tokens.cursor === null) {
        from = head.number > BigInt(t.tokenLookbackBlocks) ? head.number - BigInt(t.tokenLookbackBlocks) : 0n;
        if (reg.deployBlock !== null && from < reg.deployBlock) from = reg.deployBlock;
      } else {
        from = BigInt(state.tokens.cursor) + 1n - REORG_OVERLAP;
      }
      // Judged range by range, not at the end: the cursor moves with each range, so a later range that throws
      // must not take the findings of the ranges already read with it.
      let eventCount = 0;
      // T-OP-083: keep only the event this scan asked for. A node (or the test chain) that answers with other logs
      // for the same addresses must not take the whole tokens check down on `log.args` of a foreign event.
      const multiplierTopic = viem.toEventSelector(TOKEN_EVENTS[0]).toLowerCase();
      const r = await getLogsChunked(client, { address: markets.map((m) => m.asset), event: tokenAbi[0] }, from, head.number, t, async (logs, end) => {
        const events = logs.filter((log) => (log.topics?.[0] ?? "").toLowerCase() === multiplierTopic && log.args !== undefined).map((log) => ({
          ticker: tickerOf(log.address),
          token: log.address,
          oldMultiplier: log.args.oldMultiplier,
          newMultiplier: log.args.newMultiplier,
          effectiveAt: Number(log.args.effectiveAtTimestamp),
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
        }));
        eventCount += events.length;
        out.push(...multiplierEventFindings(events));
        state.tokens.cursor = end.toString();
      });
      // T-OP-083. The launch tokens' OraclePaused() / OracleUnpaused() logs over a bounded range that starts
      // where the multiplier scan's does (`from`: the lookback, never below the registry deploy block): the addresses are the
      // registry rows for --launch, so nothing is typed in here; a launch ticker the registry does not carry is
      // reported in `detail` rather than guessed. Two scans because the event filter is one event per request;
      // both batches are folded in chain order by topic, so a batch that carries other logs is harmless.
      const launchWanted = new Set(opts.launch.map((x) => x.toUpperCase()));
      const launchRows = reg.markets.filter((m) => launchWanted.has(m.ticker.toUpperCase()) && m.asset !== null);
      const launchMissing = [...launchWanted].filter((tk) => !launchRows.some((m) => m.ticker.toUpperCase() === tk));
      const launchTokens = launchRows.map((m) => m.asset);
      let haltLogs = 0;
      if (launchTokens.length > 0) {
        // Its own cursor, so a halt log is never lost to a failure in the OTHER scan: the multiplier cursor above
        // moves range by range, but this one moves only after BOTH event scans have covered a block, and the
        // logs are folded only up to that block. A run that throws half-way re-reads the range next time, and
        // the fold is idempotent under replay (first sighting wins, unpause deletes).
        const topics = oracleHaltTopics(viem);
        const halts = state.tokens.oracleHalts ?? (state.tokens.oracleHalts = {});
        const haltFrom = state.tokens.haltCursor === null || state.tokens.haltCursor === undefined ? from : BigInt(state.tokens.haltCursor) + 1n - REORG_OVERLAP;
        const to = head.number;
        if (haltFrom <= to) {
          const collected = [];
          let reached = to;
          for (const ev of [tokenAbi[1], tokenAbi[2]]) {
            const hr = await getLogsChunked(client, { address: launchTokens, event: ev }, haltFrom, to, t, async (logs) => {
              collected.push(...logs);
            });
            if (hr.reached < reached) reached = hr.reached;
          }
          const inRange = collected.filter((log) => log.blockNumber <= reached);
          haltLogs = inRange.length;
          applyOracleHaltLogs(halts, inRange, tickerOf, topics);
          state.tokens.haltCursor = reached.toString();
        }
        out.push(...oracleHaltFindings(halts, launchTokens));
      }
      const haltNote = launchTokens.length === 0 ? "; no launch token in the registry, halt logs not scanned" : `; ${haltLogs} OraclePaused/OracleUnpaused log(s) for ${launchRows.map((m) => m.ticker).join(", ")}${launchMissing.length ? ` (not in the registry: ${launchMissing.join(", ")})` : ""}`;
      return {
        status: r.caughtUp ? "ok" : "incomplete",
        detail: `${markets.map((m) => m.ticker).join(", ")}: flags, multipliers, isBlocked of ${watched.length} contract(s) + pool; ${eventCount} UIMultiplierUpdated since block ${from}${haltNote}`,
      };
    });

    // ---- USDG ----
    await run("usdg", async () => {
      if (reg.usdg === null) return { status: "skipped", detail: "no shared.usdg in the registry" };
      const targets = ["clearinghouse", "orderBook", "keeperRewards", "autoRoller", "payoutAdapter", "makerVault", "rewardsDistributor"].filter((n) => C[n] !== null);
      const [paused, ...frozen] = await Promise.all([read(reg.usdg, ABI.usdg, "paused"), ...targets.map((n) => read(reg.usdg, ABI.usdg, "isFrozen", [C[n]]))]);
      const out = checkUsdg({ usdg: reg.usdg, paused: must(paused, "USDG paused()"), frozen: targets.map((n, i) => ({ name: n, address: C[n], frozen: must(frozen[i], `USDG isFrozen(${n})`) })) });
      return { findings: out, detail: `paused ${paused.value}; isFrozen of ${targets.length} contract(s)` };
    });

    // ---- pools ----
    await run("pools", async () => {
      const withPool = markets.filter((m) => m.v2.univ3Pool !== null);
      if (withPool.length === 0) return { status: "skipped", detail: "no market in scope has a pool" };
      const out = [];
      const details = [];
      for (const m of withPool) {
        const liq = must(await read(m.v2.univ3Pool, ABI.pool, "liquidity"), `${m.ticker} pool liquidity()`);
        let sourceFloor = null;
        if (reg.sources.univ3) {
          const p = await read(reg.sources.univ3, ABI.univ3, "pools", [m.asset]);
          if (p.ok && !sameAddress(p.value[0], ZERO)) {
            sourceFloor = p.value[4];
            out.push(
              ...checkPoolWiring({
                ticker: m.ticker,
                underlying: m.asset,
                source: reg.sources.univ3,
                registryPool: m.v2.univ3Pool,
                registryFloor: m.v2.univ3MinLiquidity,
                sourcePool: p.value[0],
                sourceFloor,
              }),
            );
          } else if (p.ok) {
            notes.push(`pools: ${m.ticker} UniV3TwapSource has no pool; the registry names ${m.v2.univ3Pool}, so the pool cannot vote on any expiry pinned from now on`);
          }
        }
        const open = state.alerts[`v2_mon_pool_liquidity_low:${lc(m.v2.univ3Pool)}`] !== undefined;
        out.push(...checkPool({ ticker: m.ticker, pool: m.v2.univ3Pool, liquidity: liq, floor: m.v2.univ3MinLiquidity, sourceFloor, open }, t));
        details.push(`${m.ticker} ${m.v2.univ3MinLiquidity === null ? "no floor" : `${(liq * 100n) / (m.v2.univ3MinLiquidity || 1n)}% of floor`}`);
      }
      return { findings: out, detail: details.join(", ") };
    });
  }

  // ---- services ----
  await run("health", async () => {
    if (opts.health.length === 0) return { status: "skipped", detail: "no --health targets" };
    const out = [];
    await Promise.all(
      opts.health.map(async ({ name, url }) => {
        let result;
        try {
          const response = await fetchImpl(url, { signal: AbortSignal.timeout(t.healthTimeoutMs) });
          let body = null;
          try {
            body = JSON.parse(await response.text());
          } catch {
            body = null;
          }
          result = { name, url, reachable: true, httpStatus: response.status, body, error: null };
        } catch (error) {
          result = { name, url, reachable: false, httpStatus: null, body: null, error: shortError(error) };
        }
        out.push(...checkHealth(result));
      }),
    );
    return { findings: out, detail: opts.health.map((h) => h.name).join(", ") };
  });

  // ---- pricing inputs: priceability, source clocks, provider/method switches, pricer work (O3-304) ----
  //
  // Read-only GETs against what the two services serve TODAY. What they do not serve is said, not invented:
  // the indexer's /v2/config.services (X3-301) does not exist, and the /fair body carries no §5.1 provenance
  // until X3-302 ships, so provider, method and the quote / volatility clocks are reported "not served" rather
  // than guessed from the legacy `source` field or from receipt time.
  await run("pricing", async (sink) => {
    if (opts.pricing === null && opts.pricer === null) return { status: "skipped", detail: "no --pricing / --pricer target" };
    state.pricing ??= { sources: {}, pricer: null };
    state.pricing.sources ??= {};
    const detail = [];
    let incompleteWhy = null;
    const getJson = async (url) => {
      try {
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(t.pricingTimeoutMs) });
        let body = null;
        try {
          body = JSON.parse(await response.text());
        } catch {
          body = null;
        }
        return { status: response.status, body, error: null };
      } catch (error) {
        return { status: 0, body: null, error: shortError(error) };
      }
    };

    // ---- the pricer: is it evaluating? (its /state, never its /health) ----
    if (opts.pricer !== null) {
      const r = await getJson(`${opts.pricer}/state`);
      const answered = r.status === 200 && r.body !== null && typeof r.body === "object";
      const out = checkPricerActivity({ answered, body: answered ? r.body : null, now: wallNow, previous: state.pricing.pricer ?? null }, t);
      if (out.seen !== null) state.pricing.pricer = out.seen;
      sink.push(...out.findings);
      if (!answered) {
        // A pricer that does not answer is v2_mon_service_down's condition (--health pricer=…/health), not this
        // check's: the two must never be one page. The evaluation window is left where it was.
        detail.push(`pricer /state ${r.error ?? `HTTP ${r.status}`}${r.status === 503 ? " (no tick completed yet)" : ""}`);
        incompleteWhy ??= `pricer /state: ${r.error ?? `HTTP ${r.status}`}`;
      } else {
        const a = out.activity;
        detail.push(
          `pricer ${a.ticks} tick(s), ${a.evaluations} evaluation(s), ${a.strategies ?? "?"} strateg${a.strategies === 1 ? "y" : "ies"}, last tick ${a.lastTickAt === null ? "unknown" : `${duration(Math.max(0, wallNow - a.lastTickAt))} ago`}, session ${a.sessionOpen === null ? "unknown" : a.sessionOpen ? "open" : "closed"}, role ${a.hasRole === null ? "unread" : a.hasRole}`,
        );
      }
    }

    if (opts.pricing === null) return { findings: [], detail: `${detail.join("; ")} (no --pricing: priceability unchecked)`, status: incompleteWhy === null ? "ok" : "incomplete" };

    // ---- the pricing service ----
    const health = await getJson(`${opts.pricing}/health`);
    if (health.status !== 200 || health.body === null || typeof health.body !== "object") {
      detail.push(`pricing /health ${health.error ?? `HTTP ${health.status}`}: priceability is unknown this pass`);
      return { findings: [], detail: detail.join("; "), status: "incomplete" };
    }
    const chains = health.body.chains !== null && typeof health.body.chains === "object" ? health.body.chains : {};
    const serviceLimit = Number(health.body.settings?.maxChainAgeS);
    notes.push(
      `pricing: per-service status comes from the pricing service's own /health — the indexer's /v2/config.services (X3-301, 02-interfaces.md §5.1) is not served yet, and a build without it means "unknown", not "healthy"`,
    );

    // Live series per market, from the log scan's own record: underlying, expiry, side and strike are what
    // /fair takes. A settled or expired series is dropped; the rest are probed daily-first, one market at a time.
    const tickerFor = new Map(markets.map((m) => [lc(m.asset), m.ticker]));
    const live = [];
    const expiriesOf = new Map();
    for (const [longId, sr] of Object.entries(state.scan.series)) {
      const ticker = tickerFor.get(lc(sr.u));
      if (ticker === undefined || Number(sr.e) <= wallNow) continue;
      live.push({ longId, ticker, expiry: Number(sr.e), side: sr.put ? "put" : "call", strike: String(sr.k) });
      if (!expiriesOf.has(ticker)) expiriesOf.set(ticker, new Set());
      expiriesOf.get(ticker).add(Number(sr.e));
    }
    const targets = probeTargets(live, wallNow, t.pricingProbes);
    const probesOf = new Map(markets.map((m) => [m.ticker, []]));
    let probeFailures = 0;
    await mapLimit(targets, Math.max(1, Number(t.pricingConcurrency)), async (s) => {
      const url = `${opts.pricing}/fair?ticker=${encodeURIComponent(s.ticker)}&strike=${s.strike}&expiry=${s.expiry}&type=${s.side}`;
      const r = await getJson(url);
      const answer = readFairAnswer(r.status, r.body);
      if (!answer.answered) {
        probeFailures += 1;
        incompleteWhy ??= `/fair ${s.ticker}: ${r.error ?? answer.reason}`;
      }
      probesOf.get(s.ticker)?.push({ ...answer, longId: s.longId, expiry: s.expiry, side: s.side, strike: fixed(BigInt(s.strike), 6, 2) });
    });
    if (probeFailures > 0) detail.push(`${probeFailures} of ${targets.length} /fair probe(s) failed at transport level`);

    // One /surface per market, paced: twenty of them in series at the 8 s timeout would outlast a 60 s interval.
    const surfaces = new Map();
    await mapLimit(markets, Math.max(1, Number(t.pricingConcurrency)), async (m) => {
      const r = await getJson(`${opts.pricing}/surface/${encodeURIComponent(m.ticker)}`);
      if (r.status !== 200 && r.status !== 404) {
        incompleteWhy ??= `/surface/${m.ticker}: ${r.error ?? `HTTP ${r.status}`}`;
        return;
      }
      const b = r.body !== null && typeof r.body === "object" ? r.body : {};
      surfaces.set(
        m.ticker,
        Array.isArray(b.expiries)
          ? { ok: true, reason: null, expiries: b.expiries.map((e) => ({ expiry: Number(e.expiry), status: String(e.status ?? "no-status") })) }
          : { ok: false, reason: typeof b.reason === "string" ? b.reason : "no-reason", expiries: [] },
      );
    });

    let servedProvenance = 0;
    const readyRows = [];
    for (const m of markets) {
      const ticker = m.ticker;
      const row = chains[ticker];
      const chain = { named: row !== undefined && row !== null, usable: typeof row?.usable === "string" ? row.usable : "ok", error: row?.error ?? null };
      const surface = surfaces.get(ticker) ?? null;
      const probes = probesOf.get(ticker) ?? [];
      for (const p of probes) if (p.servesProvenance) servedProvenance += 1;

      const readiness = checkQuoteReadiness({ ticker, chain, surface, seriesExpiries: [...(expiriesOf.get(ticker) ?? [])], probes });
      sink.push(...readiness.findings);
      readyRows.push(...readiness.rows);

      // Source clocks. Only clocks a body STATES in unix seconds are used: the §5.1 provenance clocks when a
      // build serves them, else the legacy `asOf` (the underlying's last trade, fair.ts:234-240). /health's
      // `lastTradeTime` and `chainTimestamp` are the provider's own text in an unstated zone, so they are shown
      // verbatim and never parsed into an age — a guessed clock is exactly what F3 D5 forbids.
      const oldest = (pick) => {
        const values = probes.filter((p) => p.answered).map(pick).filter((v) => typeof v === "number" && Number.isFinite(v));
        return values.length === 0 ? null : Math.min(...values);
      };
      const clocks = {
        quote: oldest((p) => p.clocks?.quoteObservedAt),
        underlying: oldest((p) => (typeof p.clocks?.underlyingObservedAt === "number" ? p.clocks.underlyingObservedAt : p.asOf)),
        volatility: oldest((p) => p.clocks?.volatilityObservedAt),
        published: oldest((p) => p.clocks?.publishedAt),
      };
      const aged = checkSourceAges({ ticker, now: wallNow, clocks }, t);
      sink.push(...aged.findings);

      // Provider / method switches, per market: the common label of its probes, "mixed" when they disagree.
      if (probes.some((p) => p.answered)) {
        const current = marketSourceLabels(probes);
        sink.push(...checkSourceSwitch({ key: ticker, label: ticker, previous: state.pricing.sources[ticker] ?? null, current }));
        state.pricing.sources[ticker] = { ...current, at: wallNow };
      }

      // An unknown age prints "unknown". It is never printed, stored or compared as 0 (F3 D5).
      const show = (v) => (v === null ? "unknown" : `${v} s`);
      const tenors = readiness.rows.map((r) => `${r.tenor} ${r.ready ? "ready" : `NOT ready (${r.expiriesNotReady}/${r.expiries} expiries, ${r.seriesNotReady}/${r.series} series)`}`);
      detail.push(
        `${ticker} chain ${chain.named ? chain.usable : "not carried"}${tenors.length === 0 ? "" : `, ${tenors.join(", ")}`}, ages quote ${show(aged.ages.quoteS)} / underlying ${show(aged.ages.underlyingS)} / vol ${show(aged.ages.volatilityS)}, source states published "${row?.chainTimestamp ?? "?"}" and last trade "${row?.lastTradeTime ?? "?"}" (provider text, unparsed)`,
      );
    }

    if (targets.length > 0 && servedProvenance === 0) {
      notes.push(
        `pricing: no /fair answer carried §5.1 \`provenance\` (X3-302 has not shipped), so per-series readiness here is the legacy body alone — a fair value, or a refusal reason. The provider and the pricing method are NOT served: only the legacy \`source\` label (cboe = the cboe-delayed provider on an exact listed contract, model = every other method) is watched for a switch, and the quote and volatility observation times are unknown, never 0 (F3 D5)`,
      );
    }
    if (targets.length === 0) detail.push("no live unexpired series to probe");
    if (Number.isFinite(serviceLimit)) {
      detail.push(`service maxChainAgeS ${serviceLimit} s`);
      if (!(Number(t.quoteAgeS) > 0) && !(Number(t.underlyingAgeS) > 0) && !(Number(t.volatilityAgeS) > 0)) {
        notes.push(
          `pricing: no source-age limit is set (--threshold quoteAgeS=… / underlyingAgeS=… / volatilityAgeS=…), so ages are reported and nothing pages on them. The service refuses a chain past its own maxChainAgeS (${serviceLimit} s) already; a stricter operator limit is a policy decision (F3 D5), derived from a measured session, not from this run`,
        );
      }
    }
    const notReady = readyRows.filter((r) => !r.ready).length;
    if (incompleteWhy !== null) detail.push(`incomplete: ${incompleteWhy}`);
    return {
      findings: [],
      detail: `${readyRows.length - notReady} of ${readyRows.length} market-tenor(s) ready; ${detail.join("; ")}`,
      status: incompleteWhy === null ? "ok" : "incomplete",
    };
  });

  // ---- dedupe and delivery ----
  const { send, resolved } = reconcile(state.alerts, findings, { completed, nowS: wallNow, repeatS: t.repeatS, eventRetentionS: t.eventRetentionS });
  const sent = [];
  let deliveryFailures = 0;
  const deliver = async (payload) => {
    if (opts.dryRun) return { ok: false, skipped: true };
    // No webhook: the alert is printed and nothing else. It is NOT marked delivered — an event kind pages
    // once and never again, so counting a printed line as delivery discards it, and a monitor started with a
    // misnamed ALERT_WEBHOOK would consume every admin event before anyone noticed. It is not a delivery
    // failure either (there was nowhere to send), so it does not raise the exit code; the next run with a
    // webhook configured sends it as a retry.
    if (opts.webhook === null) return { ok: false, logged: true };
    try {
      const headers = { "content-type": "application/json" };
      if (opts.token) headers.authorization = `Bearer ${opts.token}`;
      const response = await fetchImpl(opts.webhook, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(10_000) });
      return response.ok ? { ok: true, status: response.status } : { ok: false, status: response.status, error: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, error: shortError(error) };
    }
  };
  // Worst first. Delivery is one POST per alert and the relay forwards synchronously, so a channel that
  // rate-limits takes only the first few of a burst: in check order an admin-key grant waited behind forty
  // warn conditions, one run per attempt.
  send.sort((a, b) => RANK[b.finding.severity] - RANK[a.finding.severity]);
  for (const item of send) {
    const payload = alertPayload(item.finding, { chainId, nowMs: wallNowMs, reason: item.reason });
    const r = await deliver(payload);
    if (r.ok) markDelivered(state.alerts, item.id, item.finding.severity, wallNow);
    else if (!r.skipped && !r.logged) deliveryFailures += 1;
    sent.push({ id: item.id, kind: payload.kind, severity: payload.severity, reason: item.reason, delivered: r.ok, skipped: r.skipped === true, logged: r.logged === true, error: r.error ?? null, message: payload.message });
  }
  const resolvedOut = [];
  let droppedResolved = 0;
  const queue = [...(state.pendingResolved ?? []), ...resolved.map((r) => resolvedFinding(r.entry, wallNow))];
  state.pendingResolved = [];
  for (const f of queue) {
    const payload = alertPayload(f, { chainId, nowMs: wallNowMs, reason: "resolved" });
    const r = await deliver(payload);
    if (!r.ok && !r.skipped) {
      if (!r.logged) deliveryFailures += 1;
      if (state.pendingResolved.length < t.maxPendingResolved) state.pendingResolved.push(f);
      else droppedResolved += 1;
    }
    resolvedOut.push({ id: alertId(f), resolvedKind: f.data.resolvedKind, delivered: r.ok, skipped: r.skipped === true, logged: r.logged === true, message: payload.message });
  }
  if (droppedResolved > 0) {
    notes.push(`delivery: ${droppedResolved} resolved notice(s) dropped after the queue reached ${t.maxPendingResolved}; the conditions ARE resolved, only the notices are gone (--threshold maxPendingResolved raises it)`);
  }

  let exit = exitCodeFor({ findings, deliveryFailures, incompleteChecks: incomplete.length });
  if (head !== null) state.anchor = { block: head.number.toString(), hash: head.hash };
  state.lastRun = { at: wallNow, head: head?.number?.toString() ?? null, exit };
  // The save must not throw: it runs after every page has been POSTed, so a throw here used to lose the
  // whole report (main() prints "run failed", exit 3) while the alerts were already on their way — and the
  // next run, starting empty, re-sent every one of them. A write that fails now says so and raises the exit.
  if (!opts.dryRun) {
    try {
      saveState(statePath, state);
    } catch (error) {
      notes.push(`state: ${statePath} could not be written (${shortError(error)}); the next run starts empty, so open conditions page again and admin events since this run are adopted without a page`);
      incomplete.push("state");
      exit = exitCodeFor({ findings, deliveryFailures, incompleteChecks: incomplete.length });
    }
  }

  return {
    chainId,
    registry: opts.registry,
    state: opts.dryRun ? null : statePath,
    head: head === null ? null : { number: head.number.toString(), timestamp: head.timestamp, lagSeconds: wallNow - head.timestamp },
    webhook: opts.dryRun ? "disabled (--no-alerts)" : opts.webhook === null ? "none (printed only)" : "configured",
    checks,
    findings: findings.map((f) => ({ id: alertId(f), kind: f.kind, severity: f.severity, event: f.event, message: f.message })),
    sent,
    resolved: resolvedOut,
    notes,
    deliveryFailures,
    incompleteChecks: incomplete,
    exit,
  };
}

export function formatReport(r) {
  const lines = [];
  const head = r.head === null ? "no head" : `head ${r.head.number} (${iso(r.head.timestamp)}, wall clock ${r.head.lagSeconds >= 0 ? "+" : ""}${r.head.lagSeconds} s)`;
  lines.push(`monitor v2  chain ${r.chainId}  ${head}  registry ${r.registry}  alerts ${r.webhook}`);
  for (const [name, c] of Object.entries(r.checks)) lines.push(`  [${c.status.padEnd(10)}] ${name.padEnd(10)} ${c.detail}`);
  for (const n of r.notes) lines.push(`  note: ${n}`);
  for (const f of r.findings) lines.push(`  FIND ${f.severity.padEnd(5)} ${f.kind}  ${f.message}`);
  const how = (s) => (s.skipped ? "DRY " : s.delivered ? "SENT" : s.logged ? "LOG " : "FAIL");
  for (const s of r.sent) lines.push(`  ${how(s)} ${s.reason.padEnd(9)} ${s.id}${s.error ? ` (${s.error})` : ""}`);
  for (const s of r.resolved) lines.push(`  ${how(s)} resolved  ${s.resolvedKind}  ${s.message}`);
  const open = r.findings.filter((f) => RANK[f.severity] >= RANK.warn).length;
  lines.push(
    `summary: ${r.findings.length} finding(s) (${open} warn/error), ${r.sent.length} alert(s) to send, ${r.resolved.length} resolved, ${r.incompleteChecks.length} incomplete check(s), ${r.deliveryFailures} delivery failure(s); exit ${r.exit}`,
  );
  return lines.join("\n");
}

/* ---------------------------------------------------------------------------------------------- */
/*  main                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2), process.env);
  } catch (error) {
    process.stderr.write(`monitor: ${error.message}\n${USAGE}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const print = (report) => process.stdout.write(`${opts.json ? JSON.stringify(report, bigintReplacer, 2) : formatReport(report)}\n`);
  // `mute` is the pass that reached nobody: a delivery the relay refused, or a pass that threw before it
  // could send anything. An exit 3 whose check_failed alert WAS delivered is not mute; the first runs after
  // a deploy legitimately exit 3 for as long as the log scan is catching up, and those must not give up.
  const once = async () => {
    try {
      const report = await runOnce(opts);
      print(report);
      return { code: report.exit, mute: report.deliveryFailures > 0 };
    } catch (error) {
      if (error instanceof UsageError) {
        process.stderr.write(`monitor: ${error.message}\n`);
        return { code: 2, mute: true };
      }
      process.stderr.write(`monitor: run failed: ${shortError(error)}\n`);
      return { code: 3, mute: true };
    }
  };
  if (opts.once) process.exit((await once()).code);

  let stopping = false;
  let wake = null;
  const stop = () => {
    stopping = true;
    if (wake) wake();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  let mutePasses = 0;
  while (!stopping) {
    const started = Date.now();
    const { code, mute } = await once();
    if (code === 2) process.exit(2);
    // Nothing watches this process, and the relay cannot report on itself (ops/alerts.md §V14). A loop that
    // keeps running while every page is refused is silent for ever, so ride out a blip and then exit, which
    // is the one out-of-band signal there is: the platform restarts the service and notifies.
    mutePasses = mute ? mutePasses + 1 : 0;
    if (opts.maxFailedPasses > 0 && mutePasses >= opts.maxFailedPasses) {
      process.stderr.write(`monitor: ${mutePasses} consecutive passes reached nobody (exit ${code}); exiting ${code} so the platform restarts and notifies\n`);
      process.exit(code);
    }
    const wait = Math.max(1000, opts.intervalS * 1000 - (Date.now() - started));
    await new Promise((resolve) => {
      wake = resolve;
      setTimeout(resolve, wait);
    });
    wake = null;
  }
  process.exit(0);
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) await main();
