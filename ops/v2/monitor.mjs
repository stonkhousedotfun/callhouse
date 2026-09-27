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
 *                Clearinghouse pointer (error: not the live Clearinghouse), a pin made outside a mint or series creation
 *                (a SettlementConfigPinned without the Clearinghouse's Minted or SeriesCreated, a source pin without either),
 *                a Data Streams feed change while that source is listed anywhere
 *   fees         a pending OrderBook fee change no v2_mon_fee_scheduled alert announced (an adopted log, a lost state)
 *   pins         for every registered market and every creatable expiry E (weekday closes in [now + 1 h, now + 45 d]
 *                the Clearinghouse's calendar accepts, plus logged special expiries): SettlementOracle.pinnedBy(u, E)
 *                is 0 or the Clearinghouse, and an eth_call SettlementOracle.pin(u, E) from the Clearinghouse succeeds;
 *                for every expiry with series: pinnedBy likewise, and settlementConfig(u, E) plus the sources'
 *                pinnedFeeds / pinnedPools equal the registry's configuration (checked once: a pin never changes;
 *                an expiry with series but no open interest and no pin is not minted yet, and its first mint pins it)
 *   feeds        Chainlink proxy aggregator() / owner() changes, accessController() set, the owner
 *                Safe's nonce / threshold / owners, a round moving more than 5 % from the previous one,
 *                the oracle's feed differing from the registry's, a feed silent for its heartbeat
 *                (feedHeartbeatS) plus 1 h of open 24/5 market or since the market reopened (feed stale)
 *   tokens       Stock Token paused(), oraclePaused(), UIMultiplierUpdated, a staged multiplier; and, for the LAUNCH
 *                tokens only (--launch, default NVDA,SPCX, addresses taken from the registry rows), the issuer's
 *                OraclePaused() / OracleUnpaused() LOGS: a halt pages v2_mon_oracle_halted (error) from
 *                the event itself, so a halt that starts and ends between two polls of oraclePaused() is still
 *                seen, and the page clears itself on OracleUnpaused(). Same bounded scan as UIMultiplierUpdated.
 *                (newUIMultiplier != uiMultiplier), isBlocked for our contracts on the token's
 *                ACCESS_CONTROLLED_REGISTRY
 *   usdg         USDG paused(), isFrozen of our contracts
 *   pools        in-range liquidity below the registry's univ3MinLiquidity (the TWAP floor)
 *   divergence  calibrated per-market Chainlink versus pool TWAP band, while the 24/5 market is open
 *   window       For a --launch market's expiry with series or a --house boundary, from E - 1800 until it is
 *                Finalized or Held: the Chainlink window price against the pool TWAP by the oracle's own agreement rule
 *                and the expiry's own maxDeviationBps (v2_mon_window_divergence), so the guardian can veto first
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
 *   tokenpool    INTERFACE_VERSION 8. The STONKHOUSE v4 pool the buyback swaps in: the buyback executor's key() is
 *                the registry's pinned PoolKey (hooked by design), inside MAX_HOOK_FEE_BPS, and an id that is what
 *                its own PoolKey hashes to
 *   tvl          INTERFACE_VERSION 8. USDG locked in the v2 contracts against the owner's external-audit trigger,
 *                at half and at the whole. Off until --threshold auditTriggerUsdg is set
 *   head         the L2 head timestamp more than 60 s behind the wall clock
 *   health       optional GET of each service's /health (--health name=url): cranker, mm-bot,
 *                pricer, pricing, notifier, indexer-v2, relay
 *   pricing      PRICEABILITY, which is not process health. With --pricing: each market's chain
 *                on the pricing service's /health, each expiry it states on /surface/:ticker, and a bounded set of
 *                /fair probes on the live series the log scan already knows — daily expiries first, one market at
 *                a time, so a weekly pass can never crowd out or stand in for a failing daily. Per tenor, never
 *                aggregated. An expiry a live series settles on that the provider does not list at all is a
 *                failure of that tenor, not a silence. A reason code this build does not know counts as NOT ready
 *                and pages on its own. Source observation clocks (quote / underlying /
 *                volatility) are reported with their ages; an age this build cannot compute is UNKNOWN, never 0
 *                and never fresh, and pages only against an operator limit (--threshold quoteAgeS=…).
 *                A provider or method switch between two polls is an event of its own. With --pricer: the pricer's
 *                /state counters (ticks, the outcomes histogram) — a pricer that answers /health and evaluates
 *                nothing pages v2_mon_pricer_idle, which is a different page from v2_mon_service_down.
 *                /health's `eventRecheck`: a ticker whose ops/markets/events.json re-check day has
 *                passed with no dated row or `through` covering today pages v2_mon_event_recheck_overdue, since
 *                its event input reads `missing` and that does not halt the MM. A build without the field is
 *                reported as not serving it, never as nothing overdue.
 *                NOT SERVED YET, so not checked: the indexer's /v2/config.services and the pricing
 *                `provenance` object on /fair. Without provenance the provider, the pricing method and
 *                the quote and volatility clocks are reported "not served", never inferred from the legacy
 *                `source` field, the file's own text timestamps or receipt time.
 *
 * Every alert goes to the relay as the keepers' payload ({ source, kind, severity, message, chainId,
 * at, data }, source "callhouse-monitor", kinds v2_mon_*) and is deduped in a JSON state file: a
 * condition pages once it has stayed open --alert-grace-seconds (default 30), again only when it
 * escalates or every --repeat-hours (default 6) while it stays open, and once more (v2_mon_resolved, info)
 * when it clears. A condition that clears inside its grace (one failed read, cleared on the next pass) sends
 * nothing at all: no page and no resolved. An event (a round jump, an aggregator switch, an admin action)
 * pages at once, with no grace. A failed delivery is retried on the next run. In loop mode a pass that leaves
 * a condition waiting out its grace starts the next pass when that grace ends (plus a second), not a whole
 * --interval later, so the page goes out about 30 s after the condition opened; --once (cron) pages on the
 * first run after the grace has passed. KINDS below names each kind's runbook section.
 *
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
 *   --house TICKER=0xaddr   HouseVaults to watch for the boundary epoch stall and a boundary still unpinned
 *                           at its mint cutoff (repeatable, or a comma list;
 *                           MONITOR_HOUSE_VAULTS). None given: the vaults the registry records in
 *                           markets[].v2.house (daily, then weekly), which the launch writes back
 *                           as it creates them. The check is skipped only when neither names one.
 *   --tickers A,B           limit the feed / token / pool checks to these markets
 *   --all-markets           include `planned` v2 markets in those checks (default: live and paused)
 *   --threshold NAME=VALUE  repeatable [MONITOR_THRESHOLDS="lateS=7200,…"]; names in DEFAULTS below
 *   --launch TICKERS        [MONITOR_LAUNCH_TICKERS] default NVDA,SPCX: the markets whose Stock Token halt LOGS page
 *                           v2_mon_oracle_halted. Tickers only; the addresses come from the registry.
 *   --divergence-band TICKER=BPS repeatable [MONITOR_DIVERGENCE_BANDS="NVDA=220,…"]. No band:
 *                           check inactive. Supply only bands derived from 30 days of paired source prices;
 *                           1..299 bps keeps this alert inside the MM's 300 bps halt band.
 *   --repeat-hours H        reminder period for open conditions, 0 = never [MONITOR_REPEAT_S in seconds]
 *   --alert-grace-seconds S [MONITOR_ALERT_GRACE_S, 30; threshold alertGraceS] a CONDITION pages only once it has
 *                           stayed open this long; one that clears first sends nothing. Events are never held.
 *                           0 pages at once (the earlier behaviour).
 *   --max-failed-passes N   [MONITOR_MAX_FAILED_PASSES, 3] loop mode only: after N consecutive passes that
 *                           reached nobody (a delivery the relay refused, or a pass that threw) exit with
 *                           that pass's code, so the platform restarts the service and notifies. A pass that
 *                           exits 3 but delivered its alert does not count. 0 loops for ever; --once ignores it.
 *   --no-alerts             evaluate and print only: send nothing, leave the state file untouched
 *   --json                  print the run report as JSON instead of text
 *
 * Exit codes (--once): 0 nothing open · 1 at least one warn/error finding open (new, held in its alert
 * grace, or already paged) · 2 bad usage or configuration · 3 a check could not complete (RPC down, a read failed,
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
/** SettlementOracle.finalize reverts TooEarly before expiry + FINALIZE_DELAY (V2Constants.sol:46). */
export const FINALIZE_DELAY = 120;
/** The settlement window is [expiry - SETTLEMENT_WINDOW, expiry] (V2Constants.sol:44). */
export const SETTLEMENT_WINDOW = 1800;
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
/** INTERFACE_VERSION 7: the ceiling of MarketConfig.mintFeePpm, millionths of collateral per MINT_FEE_PERIOD. */
export const MINT_FEE_CEIL_PPM = 5_000;
/** INTERFACE_VERSION 7: rent is quoted per this much remaining life, seconds. */
export const MINT_FEE_PERIOD = 7 * 86400;

/* ---- V2Constants.sol, INTERFACE_VERSION 8 (callhouse-contracts branch v8). Re-derive on change; never re-reason. ---- */
// No BUYBACK_COOLDOWN copy. It is ADMIN-settable (FeeSplitter.setBuybackCooldown); the flywheel
// check reads FeeSplitter.buybackCooldown() live and hands it to checkBuyback as `cooldownS`.
/**
 * The most one `AutoRoller.reprice` may LOWER an ask, bps of the ask it replaces: `AutoRoller.MAX_REPRICE_DROP_BPS
 * = 2_500` (AutoRoller.sol:162). MIRRORED, not read: the ABI export at this base predates the constant and
 * has no getter for it; when `ops/abis/v2/AutoRoller.json` is re-exported this should become a one-time chain read. The
 * reprice alert measures every drop against this cap, which is the band a leaked PRICER key walks toward the floor in.
 */
export const MAX_REPRICE_DROP_BPS = 2_500;
// No BUYBACK_CAP_CEIL copy. It was exported and read by nothing (no use in this file, no import anywhere),
// and the ceiling is ADMIN-settable (FeeSplitter.buybackCapCeiling()); a dead copy of a setting is only drift.
/** One reprice lowering an ask by this many bps or more pages v2_mon_reprice_floorward.
 * SHARED with the pricer, which steps a large drop down by at most keeper PRICER_MAX_STEP_DROP_BPS (19 %), below it:
 * keeper/src/v2/cranker/constants.ts REPRICE_PAGE_DROP_BPS, pinned equal by monitor.test.mjs. Not a MONITOR_THRESHOLDS key.
 */
export const REPRICE_PAGE_DROP_BPS = 2_000;
/** The most a fee-discount module may ever take off a taker fee. `V2Constants.MAX_DISCOUNT_BPS`. */
export const MAX_DISCOUNT_BPS = 5_000;
/** The most fee the buyback's v4 pool may charge before the token pool stops being usable. `V2Constants.MAX_HOOK_FEE_BPS`. */
export const MAX_HOOK_FEE_BPS = 300;
/** IPayoutRouter.Venue as uint8: the route's venue, 0 = no route at all. */
export const ROUTE_VENUES = Object.freeze({ 0: "none", 1: "v3", 2: "v4" });
/**
 * The `hooks` of a PayoutRouter v4 route's PoolKey: those pools are hookless, so it is the zero address. Not the
 * STONKHOUSE token pool's: that one is hooked by design and its key is the registry's shared.token.poolKey.
 */
export const V4_HOOKS = ZERO;
/** v4-core LPFeeLibrary.DYNAMIC_FEE_FLAG; V4BuybackExecutor's constructor refuses a key carrying it. */
export const V4_DYNAMIC_FEE_FLAG = 0x800000;
/**
 * INTERFACE_VERSION 8: rent is switched off and stays off. Every writer fee is the OrderBook's seller fee, so a
 * non-zero `MarketConfig.mintFeePpm` on chain or in the registry is the anomaly the rent checks now look for —
 * the v7 alert (rent MISSING) is inverted, not deleted, because the field and its ledger still exist.
 */
export const V8_MINT_FEE_PPM = 0;
/** INTERFACE_VERSION 7: MakerVault.OUTFLOW_WINDOW, the leaky bucket's refill period, seconds. */
export const OUTFLOW_WINDOW = 86400;

/* ---- the source constants RegisterMarkets configures every market with (callhouse-contracts script/v2) ---- */
/** ChainlinkFeedSource.DEFAULT_MAX_STALE (26 h) and DEFAULT_MAX_ROUND_JUMP_BPS. */
export const CHAINLINK_MAX_STALE = 26 * 3600;
export const CHAINLINK_MAX_ROUND_JUMP_BPS = 2000;
/** UniV3TwapSource.DEFAULT_WINDOW, seconds. */
export const UNIV3_WINDOW = 300;
/**
 * The source tuning a pin is held to comes from the REGISTRY (`v2.defaults`, then the market's `overrides`,
 * the keys RegisterMarkets sends): CONFIG_ADMIN can change a market's with setFeed / setPool, and
 * the registry is where that change is published. The compiled defaults above are only the fallback for a registry
 * that carries none of the three (the v7 run-off registry), so a legitimate change no longer pages every new expiry
 * until the monitor's code changes.
 */
export const SOURCE_DEFAULTS = Object.freeze({ chainlinkMaxStaleS: CHAINLINK_MAX_STALE, chainlinkMaxRoundJumpBps: CHAINLINK_MAX_ROUND_JUMP_BPS, univ3WindowS: UNIV3_WINDOW });
/**
 * The registry's launch v2.defaults (keeper/src/v2/registry.ts SPEC_DEFAULTS), used when the registry has none.
 * spotMaxAgeS is the feeds' 24 h heartbeat plus 1 h, not the contract's 1 h default.
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
/**
 * The refusals V4BuybackExecutor.feeBps() (and so buy()) fails closed with: NoSource (a launch record gone or no
 * longer the token's; PIN_REVERTS' selector, not typed twice) and CeilingExceeded (a v4 protocol fee above its ceiling).
 */
export const EXECUTOR_FEE_REFUSALS = Object.freeze({
  [Object.keys(PIN_REVERTS).find((selector) => PIN_REVERTS[selector] === "NoSource")]: "NoSource",
  "0x20caa94a": "CeilingExceeded",
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
  // `.launchOnly` (roles.v8.json): holder -> the roles the one-transaction lock revokes
  // from it. Checked as contracts script/v2/deployer-powers.mjs launchOnlyPairs checks it: each role is one `.holders`
  // gives that holder, and never the Admin Safe's. Absent is empty (an older manifest); malformed is
  // UNKNOWN like the rest of the file.
  const launchOnly = {};
  if (json.launchOnly !== undefined) {
    if (json.launchOnly === null || typeof json.launchOnly !== "object" || Array.isArray(json.launchOnly)) return { manifest: null, why: `${file}: launchOnly is not an object` };
    for (const [holder, names] of Object.entries(json.launchOnly)) {
      if (!Array.isArray(names)) return { manifest: null, why: `${file}: launchOnly.${holder} is not a list of role names` };
      if (holder === "adminSafe") return { manifest: null, why: `${file}: launchOnly.adminSafe: the lock never revokes the Admin Safe's own roles` };
      for (const n of names) {
        if (!(json.holders?.[holder] ?? []).includes(n)) return { manifest: null, why: `${file}: launchOnly.${holder} lists ${n}, which holders.${holder} does not give it` };
      }
      launchOnly[holder] = [...names];
    }
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
      launchOnly,
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
  // INTERFACE_VERSION 7: AutoRoller.cancelStale pays it, at most once per rolled position per period.
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
   * A HouseVault epoch whose boundary is BLOCKED this long after epochEnd, seconds.
   * Not "the epoch is old": rollEpoch is permissionless, so an epoch past its end with nothing blocking it
   * is a crank that has not run yet, which is a different page. This one needs a refusal to exist.
   */
  houseEpochStallS: 1800,
  /**
   * How long after a launch expiry the window-divergence check keeps comparing its sources while the expiry
   * is neither Finalized nor Held, seconds. The uncorroborated delay is at most 24 h (SettlementOracle bounds), so a
   * veto is still useful up to then.
   */
  windowWatchS: 86400,
  /**
   * How long before a launch expiry the feed-gap check starts asking whether the feed's latest round is still
   * fresh enough for that expiry's window, seconds. A healthy feed prints on its 24 h heartbeat or within a minute of a
   * reopen, so a round older than E - maxStale this close to E is either a feed that stopped or one closed market away.
   */
  feedGapLeadS: 10800,
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
  /**
   * How long a chain halt the monitor saw (head lag above lagErrorS) is remembered for
   * v2_mon_guardian_veto_due. Longer than an expiry can stay unfinalized and still be worth vetoing: the
   * uncorroborated delay is at most 24 h (SettlementOracle bounds), and a Held expiry no longer pages.
   */
  outageKeepS: 8 * 86400,
  /** Log ranges: first size, and how many per run. */
  logChunkBlocks: 10000,
  maxRangesPerRun: 200,
  /** First run of the Stock Token event scan: how far back (bounded below by the registry deploy block). */
  tokenLookbackBlocks: 100000,
  /** Ordinary reprices warn individually up to this many per run; the rest fold into one summary warn. */
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
  /**
   * A CONDITION is paged only once it has stayed open this long (wall clock); one that clears first sends
   * nothing. Events page at once. 0 = page on first sight. --alert-grace-seconds / MONITOR_ALERT_GRACE_S.
   */
  alertGraceS: 30,
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
   * Operator limits on the SOURCE observation clocks, seconds; 0 = report the age, page on nothing. The
   * monitor invents no freshness bound: derive one from a measured session and set it, as with --divergence-band.
   * With a limit set, an UNKNOWN age fails it (the quote clock comes only from the pricing provenance, unserved, so `quoteAgeS`
   * pages every market). Not session-aware: a limit pages all night. On Massive `underlying` is a quote age.
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
   * Total value locked, USDG base units, that triggers the owner's external audit ($1M). The monitor pages
   * at half of it and again at it. 0 = off, and it is OFF by default for the same reason --divergence-band is: the
   * number is not the uncertain part, the DEFINITION is. "Value locked" here is the USDG the protocol's own
   * contracts hold, which is a choice this check makes and nothing else pins; shipping it on would page against
   * that choice rather than against the owner's. go-live-v2.sh sets MONITOR_THRESHOLDS to the line ops/v8/tvl-threshold.mjs
   * derives from the registry, and the launch verification pass should
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
  v2_mon_guardian_veto_due: { severity: "error", runbook: `${AL} §V68; ${IR} §1` },
  v2_mon_redeem_backlog: { severity: "warn", runbook: `${AL} §V24; ${IR} §2` },
  // A long call paid in stock to a holder whose payout preference is USDG (the settlement-floor protection).
  v2_mon_payout_in_kind: { severity: "warn", event: true, runbook: `${AL} §V74` },
  // An EarnVault venue pull that came back short; a starved pull reverts, so it is the venue.
  v2_mon_earn_pull_short: { severity: "warn", event: true, runbook: `${AL} §V75` },
  // Skimmed(gain > 0, fee == 0): the fee was not taken. A zero rate also emits this; the page says so.
  v2_mon_earn_skim_refused: { severity: "warn", event: true, runbook: `${AL} §V78` },
  // VenueWrittenOff(adapter, lastKnown): EarnVault.setAdapter could not read a venue and took its last known
  // value off totalAssets (replaced, or kept wired when re-set). A realised loss, so never a warn. One page per log.
  v2_mon_earn_venue_written_off: { severity: "error", event: true, runbook: `${AL} §V80` },
  // The EarnVault's venue adapter cannot be read, so the vault prices nothing (checkEarnVenue).
  v2_mon_earn_venue_unreadable: { severity: "error", runbook: `${AL} §V75` },
  // Earn just-in-time funding stays OFF until the quoteTake fix lands.
  // A log that turns it on (event), and the switch found on at the head (a standing condition, so an event adopted
  // before the first run, or missed, still pages).
  v2_mon_jit_funding_on: { severity: "error", event: true, runbook: `${AL} §V76` },
  v2_mon_jit_funding_enabled: { severity: "error", runbook: `${AL} §V76` },
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
  // AutoRoller.Repriced: the PRICER lane moving a writer's ask. Two pages and a rate-capped warn.
  v2_mon_reprice_floorward: { severity: "error", event: true, runbook: `${AL} §V62; ${IR} §5` },
  v2_mon_reprice_foreign_sender: { severity: "error", event: true, runbook: `${AL} §V62; ${IR} §5` },
  v2_mon_repriced: { severity: "warn", event: true, runbook: `${AL} §V62` },
  v2_mon_mint_rent: { severity: "error", runbook: `${AL} §V47; ${IR} §9` },
  v2_mon_mint_fee_zero: { severity: "error", runbook: `${AL} §V47; ${IR} §9` },
  // Priceability, NOT process health. The service-down page stays the up/down page; these say what the inputs are worth.
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
  // The MESSAGE also carries the recovery itself, because a page whose runbook section is missing is a
  // page the on-call cannot act on. An earlier anchor here named the wrong section (the Repriced entry).
  // monitor.test.mjs now holds every anchor here to a section whose heading names the kind.
  v2_mon_house_epoch_stall: { severity: "error", runbook: `${AL} §V63; ${IR} §4` },
  // A House vault whose weekly() disagrees with the registry slot that names it, and a performance fee
  // charged at a boundary that the vault's USDG could not pay (the vault carries it in performanceFeeOwed).
  v2_mon_house_kind_mismatch: { severity: "error", runbook: `${AL} §V69; ${IR} §4` },
  v2_mon_house_fee_owed: { severity: "warn", runbook: `${AL} §V69` },
  // A House boundary the oracle's veto-and-week gate does not cover, and a
  // launch expiry's Chainlink window price the pool TWAP disagrees with by more than the oracle tolerates.
  v2_mon_house_boundary_unpinned: { severity: "warn", runbook: `${AL} §V70; ${IR} §1` },
  // A boundary money is exposed to that the vault could not lock (warn: nothing priced yet, the cause
  // can still be fixed), and a roll the vault then holds a week past its end (error: queued money is stuck until then).
  v2_mon_house_boundary_unlocked: { severity: "warn", runbook: `${AL} §V70; ${IR} §1` },
  v2_mon_house_roll_held: { severity: "error", runbook: `${AL} §V70; ${IR} §4` },
  // A House vault tracking nearly as many series as one rollEpoch fits under the chain's tx cap.
  v2_mon_house_tracked_high: { severity: "warn", runbook: `${AL} §V77; ${IR} §4` },
  v2_mon_window_divergence: { severity: "error", runbook: `${AL} §V71; ${IR} §1` },
  // A launch expiry whose Chainlink leg needs a round the feed has not printed, and an AccessManager
  // member nobody published (the RoleGranted walk from the deploy block).
  v2_mon_feed_expiry_gap: { severity: "error", runbook: `${AL} §V72; ${IR} §7` },
  v2_mon_manager_unlisted_member: { severity: "error", runbook: `${AL} §V73; ${IR} §5` },
  // A roles.v8.json `.launchOnly` holder (the guardian hot key) still holding its role after the lock.
  v2_mon_manager_launch_key: { severity: "error", runbook: `${AL} §V79; ${IR} §5` },
  // The event calendar's re-check day passed with nothing dated: the ticker's event input reads missing.
  v2_mon_event_recheck_overdue: { severity: "warn", runbook: `${AL} §V67; ${IR} §10` },
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
/** Whole hours as "25 h", anything else as duration() says it. */
export const hoursText = (seconds) => (Number(seconds) > 0 && Number(seconds) % 3600 === 0 ? `${Number(seconds) / 3600} h` : duration(seconds));

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
        `${label} is HELD (vetoed) ${duration(age)} after expiry: it settles only if two sources corroborate, on unveto, or ${heldResolve(x).how}`,
        { ...base, ...heldResolve(x).data },
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
    // "Settles on the other sources" only when one of them is known to price the window.
    const other = otherSourcePrices(x);
    const then = other === true
      ? "the pool cannot vote, so this expiry settles on the other sources alone, after the market's delay"
      : other === false
        ? `the pool cannot vote and the Chainlink leg has no ok price over [${iso(x.expiry - SETTLEMENT_WINDOW)}, ${iso(x.expiry)}] either: no source prices this expiry. The ${guardianBy(x.lockSeen)} must veto it before it finalizes (v2_mon_guardian_veto_due, ${AL} §V68)`
        : "the pool cannot vote; whether the other sources price the window was not read, so this expiry settles on them alone only if one of them is ok (check the Chainlink leg's windowPrice)";
    out.push(
      finding(
        "v2_mon_snapshot_missed",
        key,
        "settlement",
        `${label}: the pool recorded nothing inside [expiry, expiry + ${SNAPSHOT_GRACE} s] (no snapshot, and no finalize or settle inside the grace, which also record since T-OP-312); ${then}`,
        { ...base, univ3Source: x.univ3Source, otherSourcePrices: other },
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
 * The chain halts the monitor has SEEN, as [from, to] intervals of seconds: `from` is the head block's
 * timestamp (no block exists after it), `to` the last wall-clock second a run still found the head that far behind.
 *
 * WHAT "OUTAGE" MEANS ON 4663, AND WHAT THIS CANNOT SEE. A halt is a head that trails the wall clock by more than
 * lagErrorS (the error threshold of v2_mon_l2_lag) at a run. That is the only chain-halt signal there is: 4663
 * publishes no sequencer-uptime feed, and a Nitro chain makes no
 * empty blocks, so a gap between two block timestamps found AFTER a restart cannot be told from a quiet chain. So a
 * halt is recorded only if a run happens during it, and one shorter than lagErrorS is not recorded at all. A stalled
 * RPC reads exactly like a halted chain (v2_mon_l2_lag says the same); its runbook's first check separates them.
 * A Chainlink DON outage on a LIVE chain is not an outage here: a push feed prints only on a 0.5 % move or its 24 h
 * heartbeat, so thirty silent minutes are a quiet market, and nothing the monitor reads can prove otherwise inside the
 * window. The one related signal is the pool leg moving away from the frozen round, v2_mon_price_divergence (warn,
 * open market, only with a calibrated band); it is not joined into this page.
 *
 * Pure: the caller stores the result in state.outages. x = { headTimestamp, headBlock, wallNow }
 */
export function noteOutage(outages, x, t = DEFAULTS) {
  const kept = (outages ?? []).filter((o) => o.to >= x.wallNow - t.outageKeepS);
  if (x.wallNow - x.headTimestamp <= t.lagErrorS) return kept;
  const open = kept.find((o) => o.from === x.headTimestamp);
  if (open) return kept.map((o) => (o === open ? { ...o, to: Math.max(o.to, x.wallNow) } : o));
  return [...kept, { from: x.headTimestamp, to: x.wallNow, block: String(x.headBlock) }];
}

/** The recorded outages that overlap an expiry's settlement window [expiry - SETTLEMENT_WINDOW, expiry]. */
export const outagesOverlapping = (outages, expiry) =>
  (outages ?? []).filter((o) => o.from < expiry && o.to > expiry - SETTLEMENT_WINDOW);

/**
 * Whether a source other than the pool prices an expiry whose pool leg missed its snapshot:
 *   false  a capture recorded no ok source (okCount 0), the Chainlink leg's windowPrice(E - SETTLEMENT_WINDOW, E) was
 *          read not ok, or Chainlink is not one of the expiry's sources;
 *   true   the Chainlink leg's windowPrice was read ok, or a capture recorded an ok source (the pool recorded nothing, so
 *          it was another one);
 *   null   not known (nothing read).
 * checkGuardianVeto's no-source-prices page and checkExpiry's snapshot_missed text both follow it, so the two agree.
 *   x = checkExpiry's x plus { chainlinkSource: address | null, chainlinkWindowOk: boolean | null }
 */
export function otherSourcePrices(x) {
  const chainlink = x.chainlinkSource ?? null;
  const chainlinkListed = chainlink !== null && x.sources.some((s) => sameAddress(s, chainlink));
  if (x.okCount === 0 || x.chainlinkWindowOk === false || (chainlink !== null && !chainlinkListed)) return false;
  if (x.chainlinkWindowOk === true || (x.okCount ?? 0) > 0) return true;
  return null;
}

/**
 * The GUARDIAN owes a veto on this expiry, under one of the two operating rules
 * for it:
 *   halt          Any market: an outage from noteOutage overlaps [expiry - SETTLEMENT_WINDOW, expiry].
 *                 Both legs can price the frozen interval and agree, so the FIRST finalize (anyone, from expiry +
 *                 FINALIZE_DELAY) settles it corroborated, skipping the delay and the veto window.
 *   pool-denied   Launch markets only (--launch): the pool is a source of the expiry and did not record
 *                 inside [expiry, expiry + SNAPSHOT_GRACE]. `snapshots(underlying, expiry).recordedAt == 0` is exactly
 *                 "no Recorded event": record() writes the snapshot and emits Recorded in the same call
 *                 (UniV3TwapSource.sol:271-273). The expiry settles on Chainlink alone once finalizableAt passes.
 * Only while a veto can still help: open interest, not Finalized, not already Held. Each rule is its own key, so
 * each opens and clears on its own. The page carries ticker, expiry and finalizableAt: the candidate's, or null
 * before the first finalize has set one, with earliestFinalize beside it.
 * The pool-denied page's next step depends on whether Chainlink prices the window: the caller reads the
 * Chainlink leg's windowPrice(u, E - SETTLEMENT_WINDOW, E) (`chainlinkWindowOk`). When it is not ok either (or a capture
 * recorded no ok source, or Chainlink is not a source of the expiry) NO source prices the expiry: comparing and
 * unvetoing would leave nothing to settle on, so the page says veto now and when adminResolve opens (heldResolve with
 * no ok price). Unknown (a read that failed) keeps the compare-then-unveto text.
 *   x = checkExpiry's x plus { launch: boolean, outages: noteOutage's list, chainlinkSource: address | null,
 *         chainlinkWindowOk: boolean | null (null = not read) }
 */
export function checkGuardianVeto(x) {
  if (x.openInterest === 0n || x.status === "Finalized" || x.status === "Held") return [];
  const out = [];
  const key = `${lc(x.underlying)}:${x.expiry}`;
  const label = `${x.ticker} expiry ${iso(x.expiry)}`;
  const finalizableAt = x.candidate === null ? null : x.candidate.finalizableAt;
  const earliestFinalize = x.expiry + FINALIZE_DELAY;
  const deadline = finalizableAt === null
    ? `its first finalize (anyone may call it from ${iso(earliestFinalize)})`
    : `finalizableAt ${iso(finalizableAt)}`;
  const base = {
    ticker: x.ticker,
    underlying: x.underlying,
    oracle: x.oracle,
    expiry: x.expiry,
    finalizableAt,
    earliestFinalize,
    status: x.status,
    openInterest: x.openInterest,
  };

  const halts = outagesOverlapping(x.outages, x.expiry);
  if (halts.length > 0) {
    const h = halts[0];
    out.push(
      finding(
        "v2_mon_guardian_veto_due",
        `${key}:halt`,
        "settlement",
        `${label}: a chain halt the monitor saw (no block after ${iso(h.from)}, still none at ${iso(h.to)}) overlaps its settlement window [${iso(x.expiry - SETTLEMENT_WINDOW)}, ${iso(x.expiry)}], so both sources can agree on the frozen price and the first finalize settles it. ${guardianBy(x.lockSeen)}: veto(underlying, expiry) before ${deadline}; after a halt it must be the first transaction for this expiry (SEC8-12 F-2 operating rule)`,
        { ...base, reason: "chain-halt", outages: halts },
      ),
    );
  }

  const poolListed = x.univ3Source !== null && x.sources.some((s) => sameAddress(s, x.univ3Source));
  if (x.launch && poolListed && x.now > x.expiry + SNAPSHOT_GRACE && x.snapshotRecordedAt === 0) {
    if (otherSourcePrices(x) === false) {
      const resolve = heldResolve({ expiry: x.expiry, okCount: 0 });
      out.push(
        finding(
          "v2_mon_guardian_veto_due",
          `${key}:pool`,
          "settlement",
          `${label}: the pool leg did not record inside [expiry, expiry + ${SNAPSHOT_GRACE} s] (no Recorded event from the pool source), and the Chainlink leg has no ok price over [${iso(x.expiry - SETTLEMENT_WINDOW)}, ${iso(x.expiry)}] either. No source prices this expiry: veto now, before ${deadline}; adminResolve opens at ${iso(resolve.data.resolvableAt)} (expiry + 7 d). ${guardianBy(x.lockSeen)}: do not unveto, there is no price to settle on; once Held it settles ${resolve.how} (B-03 operating rule)`,
          { ...base, reason: "no-source-prices", univ3Source: x.univ3Source, chainlinkWindowOk: x.chainlinkWindowOk ?? null, ...resolve.data },
        ),
      );
    } else {
      out.push(
        finding(
          "v2_mon_guardian_veto_due",
          `${key}:pool`,
          "settlement",
          `${label}: the pool leg did not record inside [expiry, expiry + ${SNAPSHOT_GRACE} s] (no Recorded event from the pool source), so this launch expiry settles on Chainlink alone. ${guardianBy(x.lockSeen)}: veto(underlying, expiry) before ${deadline}, compare the Chainlink price with the market over the window, then unveto or have CONFIG_ADMIN adminResolve (B-03 operating rule)`,
          { ...base, reason: "pool-leg-denied", univ3Source: x.univ3Source },
        ),
      );
    }
  }
  return out;
}

/**
 * An expiry the oracle has finalized whose Clearinghouse series are not all settled. Nothing else sees this:
 * the settlement check treats Finalized as the end of the expiry, and the redeem backlog only counts series
 * that emitted `SeriesSettled`. Until someone calls `settle(longId)` every holder's `redeem` reverts
 * `NotSettled`, so the expiry is finished on the oracle and frozen for its holders.
 *   x = { ticker, underlying, oracle, expiry, now, openInterest, unsettled: string[] held longIds, seriesCount }
 */
export function checkUnsettledSeries(x, t = DEFAULTS) {
  if (x.openInterest === 0n || x.unsettled.length === 0 || x.now - x.expiry < t.settleGraceS) return [];
  const age = x.now - x.expiry;
  return [
    finding(
      "v2_mon_series_unsettled",
      `${lc(x.underlying)}:${x.expiry}`,
      "settlement",
      `${x.ticker} expiry ${iso(x.expiry)} is finalized on the oracle but ${x.unsettled.length} of ${x.seriesCount} series ${x.unsettled.length === 1 ? "is" : "are"} held and still unsettled on the Clearinghouse ${duration(age)} after expiry, with open interest ${x.openInterest}: every redeem of those series reverts NotSettled until someone calls settle(longId)`,
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
  // INTERFACE_VERSION 7: a rolled position can be cancelled once per period, and only one ask per position
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
 * What KeeperRewards.reward actually pays per action: min(bounty(action), maxBounty) (KeeperRewards.sol:162-163).
 * maxBounty null = not read, or an older KeeperRewards with no maxBounty(): nothing is clamped.
 */
export function paidBounties(bounties, maxBounty) {
  if (maxBounty === null || maxBounty === undefined) return bounties;
  const ceiling = BigInt(maxBounty);
  return Object.fromEntries(Object.entries(bounties).map(([name, v]) => [name, BigInt(v) > ceiling ? ceiling : BigInt(v)]));
}

/**
 *   x = { address, balance, dailyCap, spentToday, bounties: { SNAPSHOT, FINALIZE, SETTLE, REDEEM, ROLL }, observed: { spend, expiries },
 *         maxBounty (bigint | null: null = not read, or an older KeeperRewards with no maxBounty()) }
 * Returns { findings, perExpiry, runway (expiries, or null when nothing is paid), basis }.
 * The model and the "is any bounty paid" test use what reward() pays, min(bounty, maxBounty), not the stored
 * table: a lowered maxBounty binds at payment (KeeperRewards.sol:162-163), and a maxBounty of 0 pays nothing at all.
 */
export function checkRewards(x, t = DEFAULTS) {
  const findings = [];
  const paid = paidBounties(x.bounties, x.maxBounty ?? null);
  const model = modelSpendPerExpiry(paid, t);
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
  const anyBounty = Object.values(paid).some((v) => BigInt(v) > 0n);
  const maxBounty = x.maxBounty ?? null;
  if (maxBounty !== null && BigInt(maxBounty) === 0n && Object.values(x.bounties).some((v) => BigInt(v) > 0n)) {
    findings.push(
      finding(
        "v2_mon_rewards_cap",
        `${lc(x.address)}:max-bounty-zero`,
        "rewards",
        "KeeperRewards maxBounty() is 0: reward() pays min(bounty, maxBounty), so no bounty is paid for any action although the bounty table is set. setMaxBounty is the ADMIN lane (48 h), not FEE_MANAGER",
        { address: x.address, maxBounty: BigInt(maxBounty), dailyCap: x.dailyCap },
      ),
    );
  }
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
 * INTERFACE_VERSION 7: the MakerVault's 24 h net USDG outflow bucket. `outflow()` reports what the quoter has
 * spent net since the bucket last emptied and what is left before `place(Bid)`, `replace(Bid)` and `take` revert
 * `OutflowCapExceeded`; the bucket refills linearly over OUTFLOW_WINDOW. Three conditions, one kind:
 *   cap 0            warn: a deliberate spend freeze (the kill switch). Asks, sales, cancels, closes and ledger
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
 * The kind the registry gives a House vault address: "weekly" or "daily" from markets[].v2.house,
 * "conflict" when both slots name it, null when no slot does (the vault was passed with --house and the registry does
 * not know it).
 */
export function expectedHouseKind(reg, address) {
  const kinds = new Set();
  for (const m of reg.markets) {
    if (sameAddress(m.v2?.house?.weekly, address)) kinds.add("weekly");
    if (sameAddress(m.v2?.house?.daily, address)) kinds.add("daily");
  }
  if (kinds.size === 0) return null;
  return kinds.size === 1 ? [...kinds][0] : "conflict";
}

/**
 * `v2_mon_house_tracked_high` fires at this many tracked series (`trackedSeries().length`). rollEpoch and
 * depositNow walk the whole list (~38k gas per series at the roll, contracts HouseVaultRollGas.t.sol), and the keeper
 * sizes the roll per call under the 4663 tx cap: with every series holding a converting call long and its short, the
 * boundary pin at an unread source count and one book pull's ceiling, 39 fit (keeper steps.ts
 * HOUSE_ROLL_WORST_SERIES; its test holds this below it). The MM bot's sync untracks every series that
 * holds nothing, so a count this high means that sync is not running, or the vault really holds this many series.
 */
export const HOUSE_TRACKED_PAGE = 38;

/**
 * Two HouseVault facts this check reads.
 *   KIND. weekly() is immutable and decides the epoch calendar (HouseVault.rollEpoch: calendar.nextExpiry(now, weekly)).
 *   A vault in the registry's daily slot that reports weekly (or the reverse) rolls on the other calendar, and every
 *   consumer that trusts the slot (keeper cranker and MM, indexer, web) labels it wrongly. Compared only when both the
 *   view and the registry answer: an older vault has no weekly(), and an unread value is not a mismatch.
 *   FEE OWED. The vault charges the performance fee in full at the boundary and pays what the unreserved USDG allows; the
 *   rest stays in performanceFeeOwed, excluded from NAV, and is paid first at the next boundary. PerformanceFeePaid
 *   logs that payment. Non-zero means the vault's cash was short at the boundary. One page per epoch (key vault:epochId).
 *   TRACKED. trackedSeries().length at or above HOUSE_TRACKED_PAGE; resolves when it drops below.
 *   x = { address, ticker, epochId, weekly: bool | null, expectedKind: "weekly" | "daily" | "conflict" | null,
 *         feeOwed: bigint | null, tracked?: number | null }
 */
export function checkHouseVaultState(x) {
  const out = [];
  const where = `${x.ticker} HouseVault ${shortAddr(x.address)}`;
  if (x.expectedKind === "conflict") {
    out.push(finding("v2_mon_house_kind_mismatch", lc(x.address), "house", `${where} is named in BOTH the weekly and the daily slot of the registry (markets[].v2.house): one of them is wrong, fix the registry`, { address: x.address, ticker: x.ticker, weekly: x.weekly, expectedKind: x.expectedKind }));
  } else if (x.weekly !== null && x.expectedKind !== null) {
    const kind = x.weekly ? "weekly" : "daily";
    if (kind !== x.expectedKind) {
      out.push(
        finding(
          "v2_mon_house_kind_mismatch",
          lc(x.address),
          "house",
          `${where} reports weekly() = ${x.weekly} (a ${kind} vault) but the registry names it as the ${x.expectedKind} vault: it rolls on the ${kind} calendar, and every consumer that trusts the registry slot labels and cranks it as ${x.expectedKind}`,
          { address: x.address, ticker: x.ticker, weekly: x.weekly, expectedKind: x.expectedKind },
        ),
      );
    }
  }
  if (x.feeOwed !== null && x.feeOwed > 0n) {
    out.push(
      finding(
        "v2_mon_house_fee_owed",
        `${lc(x.address)}:${x.epochId}`,
        "house",
        `${where} carries ${usdg(x.feeOwed)} USDG of performance fee it charged but could not pay at the boundary before epoch ${x.epochId} (performanceFeeOwed): its unreserved USDG was short. It is excluded from NAV and paid first at the next boundary. PerformanceFeePaid logs the payment (T-OP-817)`,
        { address: x.address, ticker: x.ticker, epochId: String(x.epochId), feeOwed: x.feeOwed.toString() },
      ),
    );
  }
  if (typeof x.tracked === "number" && x.tracked >= HOUSE_TRACKED_PAGE) {
    out.push(
      finding(
        "v2_mon_house_tracked_high",
        lc(x.address),
        "house",
        `${where} tracks ${x.tracked} series (trackedSeries()), at or above ${HOUSE_TRACKED_PAGE}: rollEpoch and depositNow walk every one, and a roll fits 39 series that each hold a converting call long and its short under the chain's per-transaction gas cap. The MM bot's sync untracks every series that holds nothing, so either that sync is not running (check the quoter bot and its QUOTER role) or the vault holds this many series. See the runbook before the next boundary`,
        { address: x.address, ticker: x.ticker, epochId: String(x.epochId), tracked: x.tracked, page: HOUSE_TRACKED_PAGE },
      ),
    );
  }
  return out;
}

/**
 * The HouseVault epoch stall. `rollEpoch` is PERMISSIONLESS and refuses in three ways
 * (HouseVault.rollEpoch): TooEarly before `epochEnd`; NotSettled while `_requireFlat` finds a tracked
 * series unsettled, longs or shorts of an unsettled one (a settled one is redeemed first), or a live order; NotSettled while the
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
 * A boundary whose ONLY blocker is a price the oracle is already finalizing is not a stall: with an
 * undisputed Pending candidate (the weekend case, both feeds silent over a close: the pool leg alone gives a candidate
 * at E + ~130 s, finalizable at E + uncorroboratedDelay) the roll goes through on its own after finalizableAt unless
 * the guardian vetoes. That warns and says no quoter or Safe action is needed. No candidate, a Held or disagreed one,
 * or any series blocker keeps the ERROR and its recovery text.
 *
 *   x = { address, ticker, epochId, epochEnd, now,
 *         boundary: { finalized, price, status?, candidate?: { price, disagreed, finalizableAt } | null } | null
 *                   (null = the price could not be read; candidate null = none, or not read),
 *         series: [{ longId, label, exists, settled, longs, shorts, live }] }
 */
export function checkHouseEpoch(x, t = DEFAULTS) {
  const overdue = x.now - x.epochEnd;
  if (overdue < t.houseEpochStallS) return [];
  const blockers = [];
  for (const s of x.series) {
    if (s.exists && !s.settled) blockers.push(`${s.label} is not settled`);
    const held = [];
    // rollEpoch redeems every SETTLED tracked series the vault still holds before it checks the vault is flat
    // (_redeemSettled, then _requireFlat, in HouseVault.rollEpoch), so a settled series' longs and
    // shorts are not a refusal. Its live orders still are: nothing in the roll cancels them.
    const redeemedByRoll = s.exists && s.settled;
    if (!redeemedByRoll && s.longs !== 0n) held.push(`${sharesOf(s.longs)} long`);
    if (!redeemedByRoll && s.shorts !== 0n) held.push(`${sharesOf(s.shorts)} short`);
    if (s.live !== 0) held.push(`${s.live} live order${s.live === 1 ? "" : "s"}`);
    if (held.length !== 0) blockers.push(`${s.label} still holds ${held.join(", ")}`);
  }
  // A boundary price that could not be READ is not a boundary price that is missing: say so and stop,
  // rather than page for a condition this pass did not observe.
  const seriesBlockers = blockers.length;
  if (x.boundary !== null && !x.boundary.finalized) {
    blockers.push(`the ${iso(x.epochEnd)} settlement price is not Finalized`);
  }
  if (blockers.length === 0) return [];
  const where = `${x.ticker} HouseVault ${shortAddr(x.address)}`;
  const c = x.boundary?.candidate ?? null;
  if (seriesBlockers === 0 && x.boundary?.status === "Pending" && c !== null && !c.disagreed && c.finalizableAt > 0) {
    const when =
      c.finalizableAt > x.now
        ? `finalizes at ${iso(c.finalizableAt)} (in ${duration(c.finalizableAt - x.now)}) unless the guardian vetoes it`
        : `has been finalizable since ${iso(c.finalizableAt)}: anyone may call SettlementOracle.finalize, and the keeper's settlement step does`;
    return [
      finding(
        "v2_mon_house_epoch_stall",
        `${lc(x.address)}:${x.epochId}`,
        "house",
        `${where} epoch ${x.epochId} ended ${duration(overdue)} ago and rollEpoch still reverts NotSettled: ${blockers.join("; ")}. This clears on its own: the oracle holds an undisputed Pending candidate ${usdg(c.price)} USDG that ${when}, and the next roll after that goes through. No quoter or Safe action is needed; queued deposits and withdrawals wait until then.`,
        {
          address: x.address,
          ticker: x.ticker,
          epochId: String(x.epochId),
          epochEnd: x.epochEnd,
          overdueS: overdue,
          blockers,
          boundaryFinalized: false,
          candidateFinalizableAt: c.finalizableAt,
          selfClearing: true,
          trackedSeries: x.series.length,
        },
        { severity: "warn" },
      ),
    ];
  }
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
 * A
 * HouseVault prices its boundary at `settlementPrice(underlying, epochEnd)` whether or not anything pinned that expiry.
 * The veto-and-week gate on an unbounded `adminResolve` covers every expiry, pinned or not (Held, then E +
 * HELD_RESOLVE_DELAY). An unpinned one still has no frozen configuration: until its sources are captured it settles on
 * the market's CURRENT one, so a CONFIG_ADMIN `setMarket` changes its sources and band. The only pin is the
 * one in `Clearinghouse.mint`, and mint refuses from E - SETTLEMENT_WINDOW (the mint cutoff), so from then on nothing can pin
 * the boundary. That is when this pages. It stays open until the boundary is Finalized (or the vault has moved to its
 * next epoch). `pinned` or `status` null means the read failed: never judged; the run notes it.
 *
 * NO SERIES BY DESIGN. A daily House vault on a market that lists no daily series (SPCX: Friday options
 * only, `expiriesAhead.daily` 0; NVDA on Tue/Thu) crosses a boundary with no series, so nothing was ever going to
 * mint and pin it: paging at the mint cutoff every such day would be a page with no action, and one the operator
 * learns to ignore. The exposure it names is real, though: it opens only if the boundary does not finalize on its
 * sources. So for such a boundary (`noSeriesByDesign`: the registry lists no dailies for the market and the scan saw
 * no series at the expiry) this pages from E + houseEpochStallS, the stall check's own threshold, while it is still not
 * Finalized. A boundary with series (the Friday one, or any market that lists dailies) pages at the cutoff as before.
 *   x = { address, ticker, underlying, oracle, epochId, epochEnd, now, pinned: boolean | null, status: string | null,
 *         noSeriesByDesign?: boolean, byDesignReason?: string (why, e.g. "lists dailies on mon, wed, fri only") }
 */
export function checkHouseBoundaryPin(x, t = DEFAULTS) {
  if (x.pinned === null || x.pinned || x.status === null || x.status === "Finalized") return [];
  const byDesign = x.noSeriesByDesign === true;
  if (x.now < (byDesign ? x.epochEnd + t.houseEpochStallS : x.epochEnd - SETTLEMENT_WINDOW)) return [];
  const where = `${x.ticker} HouseVault ${shortAddr(x.address)}`;
  const when = x.now < x.epochEnd ? `${duration(x.epochEnd - x.now)} from now` : `${duration(x.now - x.epochEnd)} ago`;
  const why = byDesign
    ? `no series is listed at this boundary by design (${x.ticker} ${x.byDesignReason ?? "lists no daily expiries: expiriesAhead.daily 0"}), so no mint pinned it, and it is still not Finalized ${duration(x.now - x.epochEnd - FINALIZE_DELAY)} after anyone could finalize it`
    : `no series of it was minted, and minting closed at ${iso(x.epochEnd - SETTLEMENT_WINDOW)}`;
  return [
    finding(
      "v2_mon_house_boundary_unpinned",
      `${lc(x.address)}:${x.epochEnd}`,
      "house",
      `${where} epoch ${x.epochId} closes at ${iso(x.epochEnd)} (${when}) and that expiry is NOT pinned on the vault's oracle ${shortAddr(x.oracle)}: ${why}. The vault prices this boundary's deposit batch, withdrawals and performance fee at that expiry's price. An unpinned expiry settles on the market's CURRENT configuration until its sources are captured, so a CONFIG_ADMIN SettlementOracle.setMarket for ${x.ticker} (a MarketConfigured log) before then changes the sources and band it settles on (T-OP-866). With no ok price, adminResolve needs a veto (Held) and waits until ${iso(x.epochEnd + HELD_RESOLVE_DELAY)}, pinned or not (T-OP-831). ACTION: get it finalized on its sources (anyone may call SettlementOracle.finalize from ${iso(x.epochEnd + FINALIZE_DELAY)}). Until it is Finalized, the ${guardianBy(x.lockSeen)} cancels any scheduled setMarket of ${x.ticker}, and any scheduled adminResolve of this expiry that is not at the market's window price.`,
      {
        address: x.address,
        ticker: x.ticker,
        underlying: x.underlying,
        oracle: x.oracle,
        epochId: String(x.epochId),
        epochEnd: x.epochEnd,
        status: x.status,
        earliestFinalize: x.epochEnd + FINALIZE_DELAY,
        resolvableFrom: x.epochEnd + RESOLVE_DELAY,
        noSeriesByDesign: byDesign,
      },
    ),
  ];
}

/**
 * For a launch expiry, from the start of
 * its settlement window until it is Finalized or Held (and at most windowWatchS after it): the Chainlink window price
 * against the pool TWAP, judged by the oracle's own agreement rule (SettlementOracle._agree:
 * |a - b| x 10_000 <= min(a, b) x maxDeviationBps) with the expiry's maxDeviationBps READ from settlementConfig. Two
 * phases, each comparing like with like as far as the chain allows:
 *   running  E - SETTLEMENT_WINDOW <= now < E: ChainlinkFeedSource.windowPrice(u, E - SETTLEMENT_WINDOW, now), the part
 *            of the window already on chain, against UniV3TwapSource.latest(u), the pool TWAP over its configured
 *            window ending now. An early warning: the two spans differ until now reaches E.
 *   closed   now >= E: windowPrice(u, E - SETTLEMENT_WINDOW, E) from both sources, which is exactly what capture reads.
 *            The pool's is the snapshot record() stored, so until it is recorded nothing is compared.
 * THE REFERENCE IS THE ORACLE'S OWN SECOND SOURCE. The registry's Data Streams feed id would be independent of both,
 * but its prices exist only as signed reports fetched with Data Streams API credentials, which the monitor does not
 * hold. So this sees a Chainlink fault only while the pool disagrees with it: a pool held within maxDeviationBps of a
 * faulty print (A012 (a)) is invisible here.
 *   x = { ticker, underlying, oracle, expiry, status, phase: "running" | "closed", maxDeviationBps,
 *         feed: { ok, price }, reference: { ok, price, what } }
 */
export function checkWindowDivergence(x) {
  if (x.status === "Finalized" || x.status === "Held") return [];
  if (!x.feed.ok || !x.reference.ok || x.feed.price <= 0n || x.reference.price <= 0n) return [];
  const [lo, hi] = x.feed.price < x.reference.price ? [x.feed.price, x.reference.price] : [x.reference.price, x.feed.price];
  if ((hi - lo) * 10_000n <= lo * BigInt(x.maxDeviationBps)) return [];
  const gapBps = Number(((hi - lo) * 10_000n) / lo);
  const span = x.phase === "running" ? `over [${iso(x.expiry - SETTLEMENT_WINDOW)}, now], the part of the window already on chain` : "over the whole window";
  return [
    finding(
      "v2_mon_window_divergence",
      `${lc(x.underlying)}:${x.expiry}`,
      "window",
      `${x.ticker} expiry ${iso(x.expiry)}: the Chainlink window price ${usdg(x.feed.price)} (${span}) and the pool TWAP ${usdg(x.reference.price)} (${x.reference.what}) differ by ${gapBps} bps, past this expiry's maxDeviationBps of ${x.maxDeviationBps}. As they stand the oracle would not corroborate them, but if the pool moves to the Chainlink price or its leg fails, the first finalize (anyone, from ${iso(x.expiry + FINALIZE_DELAY)}) can settle on Chainlink. ${guardianBy(x.lockSeen)}: check the Chainlink rounds in the window against an independent market price now, and if Chainlink is wrong, veto(underlying, expiry) before that finalize.`,
      {
        ticker: x.ticker,
        underlying: x.underlying,
        oracle: x.oracle,
        expiry: x.expiry,
        phase: x.phase,
        feedPrice: x.feed.price,
        referencePrice: x.reference.price,
        reference: x.reference.what,
        gapBps,
        maxDeviationBps: x.maxDeviationBps,
        status: x.status,
        earliestFinalize: x.expiry + FINALIZE_DELAY,
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
/*  pure checks: INTERFACE_VERSION 7 (rent, stale asks)                                            */
/* ---------------------------------------------------------------------------------------------- */

/** AutoRoller._overtaken: the spot has reached the strike, so the ask can be taken at or below intrinsic value. */
export const overtaken = (isPut, strike, spot) => (isPut ? BigInt(spot) <= BigInt(strike) : BigInt(spot) >= BigInt(strike));

/**
 * AutoRoller.WITNESS_MAX_AGE (private in AutoRoller.sol): a witness reading
 * older than this does not count for cancelStale. The witness is the pool TWAP on the launch markets, which always ends
 * at the block, so this only bounds a source whose `latest` answers with an older updatedAt.
 */
export const WITNESS_MAX_AGE = 30 * 60;

/**
 * AutoRoller._tryWitness, from what the caller read at the head: ok only when the series' pinned oracle
 * answered settlementConfig(u, expiry) with a source 1, the Stock Token's oraclePaused() answered false, and source 1's
 * latest(u) answered ok with a price in (0, 2^128) and an updatedAt no later than now and at most WITNESS_MAX_AGE old.
 *   r = { sources: address[] | null, oraclePaused: boolean | null, latest: [ok, price, updatedAt] | null } (null = unread)
 */
export function witnessReading(r, now) {
  const none = { ok: false, price: 0n, updatedAt: 0 };
  if (r === null || r === undefined || !Array.isArray(r.sources) || r.sources.length < 2 || r.oraclePaused !== false || !Array.isArray(r.latest)) return none;
  const [ok, price, updatedAt] = r.latest;
  const p = BigInt(price);
  const at = Number(updatedAt);
  if (ok !== true || p === 0n || p > 2n ** 128n - 1n || at > now || now - at > WITNESS_MAX_AGE) return none;
  return { ok: true, price: p, updatedAt: at };
}

/**
 * INTERFACE_VERSION 7: one tracked AutoRoller position at the head. `cancelStale` is permissionless and the
 * cranker calls it every tick, so a live roll-time ask whose market has reached the strike should disappear within
 * seconds. One that does not is the pre-v7 hole still open: anyone can buy it below intrinsic value at the writer's
 * expense.
 *
 *   x = { autoRoller, writer, underlying, ticker, longId, orderId, isPut, strike, expiry, remaining,
 *         spotOk, spot, spotUpdatedAt -- the trySpot of THIS SERIES' pinned oracle, the one cancelStale
 *           reads on chain and the one the series settles on, never the market's pointer or the published oracle,
 *         witness -- witnessReading() of the same oracle's source 1 for the series' expiry (null = not read),
 *         delegate (false = the writer revoked the roller: nobody can cancel),
 *         since (head time this ask was first seen overtaken, or null), now }
 *
 * Returns { findings, stale } — `stale` says whether the caller should keep (or start) the timer. The delay is
 * deliberate: a print that crosses the strike between the cranker's tick and this pass is normal.
 */
export function checkRollerAsk(x, t = DEFAULTS) {
  // cancelStale fires on spot, or, when spot is not ok or is short of the strike, on the expiry's witness
  // (AutoRoller.cancelStale). A witness-only overtake is exactly the silent-feed case (nights,
  // weekends) in which the ask is being filled below intrinsic value, so it pages the same way.
  const bySpot = x.spotOk && overtaken(x.isPut, x.strike, x.spot);
  const w = x.witness ?? null;
  const byWitness = !bySpot && w !== null && w.ok === true && overtaken(x.isPut, x.strike, w.price);
  if (!bySpot && !byWitness) return { findings: [], stale: false };
  const since = x.since ?? x.now;
  if (x.now - since < t.rollerStaleS) return { findings: [], stale: true, since };
  const revoked = x.delegate === false;
  const reading = bySpot
    ? `spot ${usdg(x.spot)} at ${iso(x.spotUpdatedAt)}`
    : `the expiry's witness (source 1, the pool TWAP) ${usdg(w.price)} at ${iso(w.updatedAt)}, while spot is ${x.spotOk ? `${usdg(x.spot)}, short of the strike` : "not ok"}`;
  return {
    stale: true,
    since,
    findings: [
      finding(
        "v2_mon_roller_ask_overtaken",
        `${lc(x.writer)}:${lc(x.underlying)}`,
        "roller",
        `AutoRoller ask ${x.orderId} for ${shortAddr(x.writer)} on ${x.ticker} (${x.isPut ? "put" : "call"} ${usdg(x.strike)}, ${sharesOf(x.remaining)} shares left, expiry ${iso(x.expiry)}) has been at or past its strike for ${duration(x.now - since)}: ${reading}. It sells below intrinsic value to whoever takes it first. ${
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
          overtakenBy: bySpot ? "spot" : "witness",
          witnessPrice: byWitness ? w.price : null,
          witnessUpdatedAt: byWitness ? w.updatedAt : null,
        },
        { severity: revoked ? "warn" : "error" },
      ),
    ],
  };
}

/**
 * INTERFACE_VERSION 7: the rent ledger of one series, from the Clearinghouse's own logs. Rent moves in exactly
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
 * INTERFACE_VERSION 7: the runtime twin of the deploy blocker. UNDER v7,
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
 * different alerts with different runbooks: routing ours through the feed kinds sent the operator to the feed runbook with a
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
    // Decimals null = the feed's decimals() could not be read. The move is a ratio and needs none; the prices
    // are shown raw rather than scaled by a guessed 8. Undefined (a caller that passes none) keeps the 8 default.
    const dec = ctx.decimals === null ? null : (ctx.decimals ?? 8);
    const prices = dec === null ? `raw ${prev.answer} -> ${cur.answer}; decimals() could not be read` : `${fixed(prev.answer, dec, 2)} -> ${fixed(cur.answer, dec, 2)}`;
    out.push(
      finding(
        "v2_mon_feed_round_jump",
        `${lc(ctx.feed)}:${cur.id}`,
        "feeds",
        `${ctx.ticker} feed round ${cur.id & ROUND_MASK} moved ${fixed(bps, 2, 2)}% from the previous round (${prices}) at ${iso(cur.updatedAt)}: a split or multiplier step, or a bad print; compare with an independent price before any settlement window that uses it`,
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
 * limit here: this is feed silence, while spot() depends on the market's source count and the pool witness after 30 min.
 *   error  more than heartbeat + feedStaleMarginS of open market without a round (2026-08-03..09-17, 35 feeds: the
 *          longest open-market gap was 24 h 30 s): the feed missed its heartbeat. Single-source spot is stale after
 *          spotMaxAge; dual-source spot stays ok up to 4 d only while the pool is ok and agrees within maxDeviationBps.
 *   warn   the market reopened (Sunday or a holiday's 20:00 New York) more than feedReopenGraceS ago and the feed has
 *          not printed since. Every feed printed within a minute of every reopen in that window; single-source spot is
 *          stale after 25 h, while dual-source spot follows the same pool-witness rule above.
 *   x = { ticker, feed, now, roundId, updatedAt, heartbeatS, sourceCount }   (updatedAt 0 = no round)
 */
export function checkFeedStale(x, t = DEFAULTS) {
  // The market's own spotMaxAge and maxStale (the registry publishes what RegisterMarkets sets, and CONFIG_ADMIN
  // can change both), never a typed-in 25 h / 26 h. x.spotMaxAgeS / x.maxStaleS, else the launch defaults.
  const spotMaxAgeS = Number(x.spotMaxAgeS ?? ORACLE_DEFAULTS.spotMaxAgeS);
  const maxStaleS = Number(x.maxStaleS ?? SOURCE_DEFAULTS.chainlinkMaxStaleS);
  const updatedAt = Number(x.updatedAt);
  const now = Number(x.now);
  if (!(updatedAt > 0) || updatedAt > now) return [];
  const key = lc(x.feed);
  const heartbeatS = Number(x.heartbeatS ?? FEED_HEARTBEAT_S);
  const openAgeS = openMarketSeconds(updatedAt, now);
  const limitS = heartbeatS + t.feedStaleMarginS;
  const data = { ticker: x.ticker, feed: x.feed, roundId: x.roundId, updatedAt, ageS: now - updatedAt, openAgeS, heartbeatS, limitS, sourceCount: Number(x.sourceCount ?? 1), spotMaxAgeS, maxStaleS };
  if (openAgeS > limitS) {
    return [
      finding(
        "v2_mon_feed_stale",
        key,
        "feeds",
        `${x.ticker} feed ${x.feed}: no round for ${duration(openAgeS)} of open market (last ${iso(updatedAt)}, ${duration(now - updatedAt)} ago), past its ${duration(heartbeatS)} heartbeat + ${duration(t.feedStaleMarginS)}: the feed is broken or stalled. ${data.sourceCount > 1 ? "This is a dual-source market: once the Chainlink print is more than 30 min old, spot() stays OK only while the pool source is OK and agrees within maxDeviationBps, for at most 4 d; it is stale as soon as the pool is unavailable or disagrees. Check spot() before deciding whether rolls, vault quotes and reprices stopped." : `This is a single-source market: spot() reverts StaleSpot once the round is ${hoursText(spotMaxAgeS)} old (its spotMaxAge), so rolls, vault quotes and reprices stop then.`} Settlement windows ending more than ${hoursText(maxStaleS)} (the feed's maxStale) after that round have no Chainlink price`,
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
          `${x.ticker} feed ${x.feed}: the 24/5 market reopened at ${iso(m.reopenedAt)} and the feed has not printed since (last round ${iso(updatedAt)}, ${duration(now - updatedAt)} ago; every feed prints within a minute of a reopen). ${data.sourceCount > 1 ? "This is a dual-source market: after 30 min, spot() remains OK only while the pool source is OK and agrees within maxDeviationBps, for at most 4 d; it is stale as soon as the pool is unavailable or disagrees. Check spot() before deciding whether quoting continues." : `This is a single-source market: spot() stays stale after ${hoursText(spotMaxAgeS)} (its spotMaxAge) until the feed prints.`}`,
          { ...data, reopenedAt: m.reopenedAt },
          { severity: "warn" },
        ),
      ];
    }
  }
  return [];
}

/**
 * A launch expiry whose Chainlink leg needs a round the feed has not printed yet. ChainlinkFeedSource
 * counts a window ok only when the round in force at `end` is no more than `maxStale` old at `end`, and the one at
 * `start` no more at `start` (contracts src/v2/oracle/ChainlinkFeedSource.sol :42-43). So with the feed's
 * latest round at U, expiry E loses its Chainlink leg unless a new round prints before the window whenever
 * U < E - maxStale. Both launch feeds were silent 49-52 h over a weekend in September 2026, about twice
 * maxStale. v2_mon_feed_stale pages a feed that missed its heartbeat in OPEN-market time and names no expiry; this names
 * the expiry it will cost, and says whether the pool leg can carry it alone.
 *
 *   x = { ticker, underlying, feed, expiry, now, updatedAt, maxStale, pinned,
 *         pool: { address, liquidity, floor } | null }   (liquidity: in-range, at the head; floor: the expiry's pinned
 *                                                         minLiquidity, else the source's; null when not read)
 *
 * Watched from `E - feedGapLeadS` to `E`. Severity: warn while open market remains before the window (a healthy feed
 * still has a chance to print, and every feed prints within a minute of a reopen); error when none remains or the
 * window has begun; error whenever the pool's in-range liquidity is under twice its floor, because then the pool leg
 * may not record ok either, and with no ok source _band is unbounded: adminResolve takes any price once Held, from E +
 * 7 d. The liquidity is the head's, not the window's: the window's is not on chain until it ends.
 *
 * Passing the expiry is when the missing leg becomes a fact, not when it clears. After E the caller passes
 * `settlement: { finalized, captured, chainlinkOk }` (chainlinkOk: the Chainlink source's recorded ok, null before
 * capture) for an expiry this check had open, and the finding stays open, at error, until the expiry is Finalized or
 * its Chainlink leg recorded ok. No `settlement` (not carried past E, or not read) finds nothing; the caller marks an
 * unread one incomplete, so the open alert is kept rather than resolved.
 */
export function checkFeedExpiryGap(x, t = DEFAULTS) {
  const expiry = Number(x.expiry);
  const now = Number(x.now);
  const updatedAt = Number(x.updatedAt);
  const maxStale = Number(x.maxStale);
  if (!(updatedAt > 0) || !(maxStale > 0) || now < expiry - t.feedGapLeadS) return [];
  const needFrom = expiry - maxStale;
  if (now > expiry) {
    const st = x.settlement ?? null;
    if (st === null || st.finalized || st.chainlinkOk === true) return [];
    const leg = st.captured ? "the capture recorded its Chainlink leg NOT ok" : "it is not captured yet, so nothing shows the leg ok";
    return [
      finding(
        "v2_mon_feed_expiry_gap",
        `${lc(x.underlying)}:${expiry}`,
        "feedgap",
        `${x.ticker} expiry ${iso(expiry)} passed ${duration(now - expiry)} ago without its Chainlink leg (the feed ${x.feed}'s latest round is ${iso(updatedAt)}): ${leg}, and the expiry is not Finalized. It settles on the pool leg alone, uncorroborated, unless the guardian vetoes the candidate; with no ok source at all the band is unbounded (B-03). This stays open until the expiry is Finalized.`,
        { ticker: x.ticker, underlying: x.underlying, feed: x.feed, expiry, updatedAt, needFrom, maxStale, pinned: x.pinned, afterExpiry: true, captured: st.captured === true, chainlinkOk: st.chainlinkOk ?? null },
        { severity: "error" },
      ),
    ];
  }
  if (updatedAt >= needFrom) return [];
  const start = expiry - SETTLEMENT_WINDOW;
  const openLeftS = now >= start ? 0 : openMarketSeconds(now, start);
  const p = x.pool;
  const thin = p !== null && p.liquidity !== null && p.floor !== null && p.liquidity < 2n * p.floor;
  const severity = openLeftS === 0 || thin ? "error" : "warn";
  const when = now >= start ? "the window has begun" : openLeftS === 0 ? `no open market remains before the window at ${iso(start)}` : `${duration(openLeftS)} of open market remain before the window at ${iso(start)}`;
  const poolLeg =
    p === null
      ? "The registry names no pool for this market, so nothing else can price it"
      : p.liquidity === null || p.floor === null
        ? `The pool ${p.address} could not be read, so whether it can carry the expiry alone is unknown`
        : thin
          ? `The pool ${p.address} has ${p.liquidity} in-range liquidity, under twice its floor ${p.floor}: its leg may not record ok either, and with no ok source the band is unbounded: once Held, adminResolve takes any price from E + 7 d (B-03). Consider a guardian veto if neither leg prints`
          : `The pool ${p.address} has ${p.liquidity} in-range liquidity (floor ${p.floor}), so the expiry would settle on the pool alone, uncorroborated`;
  return [
    finding(
      "v2_mon_feed_expiry_gap",
      `${lc(x.underlying)}:${expiry}`,
      "feedgap",
      `${x.ticker} expiry ${iso(expiry)}: the feed ${x.feed}'s latest round is ${iso(updatedAt)} (${duration(now - updatedAt)} ago), older than ${iso(needFrom)}, which is ${duration(maxStale)} (${x.pinned ? "the pinned" : "the market's"} maxStale) before the expiry. Unless the feed prints before the window, the expiry has no Chainlink leg; ${when}. ${poolLeg}`,
      { ticker: x.ticker, underlying: x.underlying, feed: x.feed, expiry, updatedAt, needFrom, maxStale, pinned: x.pinned, openLeftS, pool: p === null ? null : p.address, poolLiquidity: p?.liquidity ?? null, poolFloor: p?.floor ?? null, thin },
      { severity },
    ),
  ];
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
 * x = { ticker, pool, liquidity, harmonic, floor, sourceFloor, open, chainlinkOk } (bigints; floor null = no registry floor).
 * `open` says an alert for this pool is already open: it then takes poolHysteresisBps above the floor to
 * clear. Without that band a pool sitting on its floor pages new/resolved/new/resolved every pass — over
 * 24 h of mainnet swaps the registry floors were crossed 34 times on AAPL, 34 on GOOGL and 18 on QQQ.
 * `chainlinkOk`: ChainlinkFeedSource.latest(underlying).ok at the head (null = not read). The page says
 * expiries settle on Chainlink alone only when it is true; when false no source prices a window closing now.
 * The source's floor gates the time-weighted HARMONIC MEAN of in-range liquidity over the window
 * (UniV3TwapSource's liquidity floor), which the thinnest stretch dominates, not the head's liquidity().
 * `harmonic` is observeWindow(u, now - SETTLEMENT_WINDOW, now)'s, what record() would gate a window closing now on (null =
 * not read). The page judges min(head, harmonic): the harmonic mean is the contract's rule, and the head stays as the
 * early warning for the window that closes next (a pool drained now reaches the mean only as the window slides).
 */
export function checkPool(x, t = DEFAULTS) {
  const floor = x.sourceFloor ?? x.floor, clearAt = floor === null || !x.open ? floor : (floor * (10_000n + BigInt(t.poolHysteresisBps))) / 10_000n; // The source's LIVE floor (setPool) wins; registry only when unread
  const harmonic = x.harmonic ?? null;
  const judged = x.liquidity === null ? harmonic : harmonic === null || x.liquidity <= harmonic ? x.liquidity : harmonic;
  if (clearAt === null || judged === null || judged >= clearAt) return [];
  const basis = judged === harmonic && (x.liquidity === null || harmonic < x.liquidity)
    ? `the harmonic-mean in-range liquidity over the last ${duration(SETTLEMENT_WINDOW)} (what record() gates a window closing now on) ${harmonic}, while the head has ${x.liquidity ?? "unread"},`
    : `in-range liquidity ${x.liquidity}${harmonic === null ? "" : ` at the head (the harmonic mean over the last ${duration(SETTLEMENT_WINDOW)} is ${harmonic})`}`;
  return [
    finding(
      "v2_mon_pool_liquidity_low",
      lc(x.pool),
      "pools",
      `${x.ticker} pool ${x.pool}: ${basis} is ${floor === 0n ? "n/a" : `${(judged * 100n) / floor}%`} of the TWAP floor ${floor}${x.sourceFloor == null ? " (the registry's; the source's own floor was not read)" : ""}: a window this thin fails the source's liquidity check, so ${
        x.chainlinkOk === true
          ? "expiries settle on Chainlink alone after the delay"
          : x.chainlinkOk === false
            ? `Chainlink's latest ${x.ticker} price is not ok either: an expiry whose window closes now has no source to settle on, and the ${guardianBy(x.lockSeen)} must veto it before it finalizes (v2_mon_guardian_veto_due, ${AL} §V68)`
            : "expiries settle on Chainlink alone after the delay only if its feed is ok (not read: check ChainlinkFeedSource.latest)"
      } and converted payouts may fall back to in kind`,
      { ...x, floor, registryFloor: x.floor, clearAt, chainlinkOk: x.chainlinkOk ?? null, harmonic, judged },
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
    const status = ((s) => (s ? ` (${s})` : ""))(x.body && typeof x.body === "object" ? [x.body.status, x.body.alert, x.body.message].filter((v) => typeof v === "string").join(": ") : ""); // /v2/health/house-registry's alert
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
/*  pure checks: pricing inputs                                                           */
/* ---------------------------------------------------------------------------------------------- */

/**
 * Every refusal / quality code this build knows: the interface spec's initial reason codes, the pricing
 * service's own PricingReason union (keeper/src/v2/pricing/cboe.ts), the per-rung codes,
 * and the two the monitor itself states. The spec: "an unknown code is kept verbatim. Automation treats any unknown
 * code as not ready" — so does this file. A code is never silently dropped and never read as "fine".
 */
export const PRICING_REASONS = new Set([
  // provenance reasons: staleness and time
  "quote-stale", "quote-age-unknown", "underlying-stale", "underlying-age-unknown", "volatility-stale", "expired",
  // provenance reasons: spot and identity
  "spot-unavailable", "spot-divergence", "identity-unmapped", "identity-mismatch", "multiplier-mismatch",
  // provenance reasons: books
  "book-empty", "book-one-sided", "book-crossed", "no-quotes",
  // provenance reasons: inputs and method
  "chain-unavailable", "chain-inconsistent", "source-disagreement", "extrapolated", "event-uncertainty", "model-uncertainty",
  // provenance reasons: source and rights
  "fallback-provider", "entitlement-insufficient", "external-indicative",
  // the service's own PricingReason values the provenance list does not name, and its parameter refusals
  "unknown-ticker", "chain-stale", "spot-stale", "quotes-inconsistent", "bad-request",
  // per-rung codes
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
 * One /fair answer as the monitor reads it. 200 and 404 are ANSWERS about the market data ("no price right
 * now" is an answer); any other status is a transport or request failure and says nothing about priceability —
 * that is what --health and v2_mon_service_down are for. `provenance` is read when a build serves it and
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
  // Pricing rule: a numeric zero is a valid estimate and is never encoded as null; null always comes with a reason.
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
 * no answer states one. `provider` and `method` come only from the pricing provenance, so today they are null — the
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
 * One market's quote readiness, PER TENOR. x = {
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
    // Pricing rule: ready means readiness "ready" with NO reason at all. An unknown code, a degraded readiness and a
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
 *  a publication or ingestion time is not a source observation and must never stand in for one. */
export const SOURCE_CLOCKS = Object.freeze({ quote: "quoteAgeS", underlying: "underlyingAgeS", volatility: "volatilityAgeS" });

/**
 * Source clock ages for one market. An age this build cannot compute is `null` — UNKNOWN — never 0 and
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

/**
 * The pricing service's /health `eventRecheck` (keeper/src/v2/pricing/events.ts eventRecheckStatus): per
 * ticker with a re-check day in ops/markets/events.json, whether that New York day has passed with nothing covering
 * today. An overdue ticker's event input reads `missing`, which does not halt the MM (by design), so its short-dated
 * asks keep quoting through a report nobody looked up; this page is what says so. `served` is false when /health
 * carries no eventRecheck object (an older build, or one built without the calendar's re-check days): that
 * is unknown, reported as a note, never "nothing overdue".
 *
 * x = the /health body's `eventRecheck` value.
 */
export function checkEventRecheck(x) {
  if (x === null || typeof x !== "object" || Array.isArray(x)) return { served: false, overdue: [], findings: [] };
  const overdue = [];
  const findings = [];
  for (const ticker of Object.keys(x).sort()) {
    const s = x[ticker];
    if (s?.overdue !== true) continue;
    overdue.push(ticker);
    findings.push(
      finding(
        "v2_mon_event_recheck_overdue",
        ticker,
        "pricing",
        `${ticker}: the event calendar's re-check day ${s.recheckBy ?? "?"} has passed and no dated row or \`through\` covers today, so its event input reads missing and short-dated asks quote through any report nobody looked up (ops/markets/events.json)`,
        { ticker, recheckBy: s.recheckBy ?? null, coveredBy: s.coveredBy ?? null },
      ),
    );
  }
  return { served: true, overdue, findings };
}

/** The labels a switch is judged on. The legacy `source` is NOT a method: it is "cboe" only for the cboe-delayed
 *  provider priced from the exact listed contract and "model" for every other method, so it moves when
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
 * Is the pricer evaluating anything? (A design gap: "Nothing checks that a live market's rungs are priceable or that the
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
 * daily out of the budget — the whole point: "no weekly-only pass hides a daily failure".
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
 * settlement price, a role, or treasury money. Warn: the rest. The INTERFACE_VERSION 6
 * wiring events (DEDICATED_EVENTS) are judged by adminEventFindings and prePinFindings instead, with their own kinds.
 */
export const CONFIG_EVENTS = Object.freeze({
  RoleGranted: "error",
  RoleRevoked: "error",
  RoleAdminChanged: "error",
  MarketConfigured: "error",
  FeedSet: "error",
  // CONFIG_ADMIN set a Chainlink plausibility band: a round outside it is not ok, so a wrong band takes
  // the Chainlink leg out of every unpinned expiry (ChainlinkFeedSource.setBand).
  BandSet: "error",
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
  // KeeperRewards.reward pays min(bounty, maxBounty): the cap on every bounty, a dial like DailyCapSet.
  MaxBountySet: "warn",
  MinRollUnitsSet: "warn",
  LimitsSet: "warn",
  // EarnVault.setLimits (TREASURY_ADMIN) / tightenLimits (GUARDIAN, tighten-only).
  EarnLimitsSet: "warn",
  // A House vault's LimitsSet (applyHouseLimits): warn when every limit is equal or stricter (tightenLimits,
  // GUARDIAN, could have done it), error when any went up (setLimits, TREASURY_ADMIN, only): CONFIG_EVENT_SEVERITY.
  HouseLimitsSet: "warn",
  // EarnVault.setAdapter (TREASURY_ADMIN): the venue the vault's idle USDG is parked in. An address the money
  // goes to, so error. EarnVault.setSkimBps (TREASURY_ADMIN): the cut of realised gain, at most the compiled
  // SKIM_BPS_CEIL (1,000 bps) and paid only to the vault's immutable splitter, so a bounded dial like BurnBpsSet: warn.
  AdapterSet: "error",
  SkimBpsSet: "warn",
  // VenueWrittenOff is NOT here. It pages once, under its own kind v2_mon_earn_venue_written_off
  // (error, earnWriteOffFindings), raised by the scan; applyScanLogs never hands it to configEventFindings.
  HolidaySet: "warn",
  SpecialExpirySet: "warn",
  RootSet: "warn",
  MinRedeemPayoutSet: "warn",
  BaseUriSet: "warn",
  /* ---- INTERFACE_VERSION 8. An admin event missing from this map is an admin event NOTHING ever pages. ---- */
  // A minter can mint Clearinghouse positions; the allow-list is the whole guard.
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
  // FeeSplitter (every event of ops/abis/v2/FeeSplitter.json is scanned, with a severity here, or has a
  // kind of its own in SPLITTER_EVENTS, or is named in FEE_SPLITTER_NOT_PAGED -- monitor.test.mjs checks the
  // partition against the exported ABI). Error: an address the fees, the conversion price or the buyback flow
  // through, and fees that will never arrive. Warn: a bounded dial, and the guardian's pause.
  OrderBookSet: "error",
  RouterSet: "error",
  BuybackExecutorSet: "error",
  SettlementOracleSet: "error",
  StonkhouseSet: "error",
  // setOrderBook could not drain the old book: this much USDG of fees stays there and never reaches the splitter.
  OrderBookFeesStranded: "error",
  // TREASURY_ADMIN moved an unrouted asset's WHOLE balance out of the splitter to the treasury.
  UnroutedAssetRecovered: "error",
  // A buyback or a distribution found less USDG than buybackBalance and lowered the counter: that
  // much of the buyback reserve left the splitter by a path other than a buyback (an issuer burn or seizure) and is gone.
  BuybackBalanceWrittenDown: "error",
  // refreshRouteFee moved the cached bps and no route was set. A failed USDG payout was credited to owed.
  RouteFeeRefreshed: "warn",
  OwedCredited: "warn",
  BurnBpsSet: "warn",
  BuybackCapSet: "warn",
  // The ADMIN-settable bounds. ADMIN moved the bound on BuybackCapSet, or the gap between
  // buybacks: bounded dials, as BuybackCapSet is.
  BuybackCapCeilingSet: "warn",
  BuybackCooldownSet: "warn",
  ConversionSlippageBpsSet: "warn",
  PausedSet: "warn",
  // AccessManaged: the contract now asks a different AccessManager, which decides every restricted call on it.
  // Emitted by every v8 contract's constructor (adopted, never paged) and otherwise only by the manager itself.
  AuthorityUpdated: "error",
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
/**
 * FeeSplitter events the monitor deliberately does not page, each with the reason. Empty today: every event in
 * ops/abis/v2/FeeSplitter.json is either paged by v2_mon_config_changed (a CONFIG_EVENTS severity) or read by
 * checkSplitter / checkBuyback (SPLITTER_EVENTS). An event added to the contract and to none of the three fails
 * monitor.test.mjs by name, so it has to be put somewhere on purpose.
 */
export const FEE_SPLITTER_NOT_PAGED = Object.freeze({});

/**
 * What the on-call needs besides the arguments, for a config event that is not a plain admin setting. The
 * default text ("expected only from a planned admin action; treat the key as compromised") is wrong for these.
 */
const CONFIG_EVENT_TEXT = {
  // `e` is the HouseLimitsSet applyHouseLimits built: direction and the limits it replaced.
  HouseLimitsSet: (a, e) => {
    const next = a.limits ?? {};
    const moved = e.previous === null ? [] : HOUSE_LIMIT_FIELDS.filter((k) => String(next[k]) !== e.previous[k]).map((k) => `${k} ${e.previous[k]} -> ${next[k]}`);
    if (e.direction === "loosen")
      return `a House vault limit went UP (${moved.join(", ")}). Only HouseVault.setLimits (TREASURY_ADMIN) can do that: tightenLimits reverts CeilingExceeded on a looser field. After the lock that lane waits its planned delay and an OperationScheduled paged first (v2_mon_manager_operation); before it the Admin Safe acts at once. If nobody planned it, treat the Admin Safe as compromised`;
    if (e.direction === "tighten")
      return `every House vault limit is equal to or stricter than before (${moved.length === 0 ? "no field changed" : moved.join(", ")}): a change HouseVault.tightenLimits (GUARDIAN, zero delay: the emergency brake) or setLimits (TREASURY_ADMIN) can make. The vault quotes less; if nobody pulled the brake, find who sent it`;
    return "no earlier LimitsSet or baseline read is known for this House vault (its constructor's, or the first since this monitor started reading it), so whether a limit went up is unknown: compare its limits() with the House limits the launch set";
  },
  BuybackBalanceWrittenDown: (a) =>
    `the FeeSplitter held less USDG than its buybackBalance counter, and a buyback or a fee distribution lowered the counter from ${usdg(a.previous)} to ${usdg(a.current)} USDG: ${usdg(BigInt(a.previous) - BigInt(a.current))} USDG of the buyback reserve left the splitter by a path other than a buyback (a USDG issuer burn or seizure) and is gone. Nothing on chain restores it and no role did it through the splitter: find the USDG issuer's burn or seizure of the splitter's address before this block`,
  RouteFeeRefreshed: (a) =>
    `the payout route's cached fee moved from ${a.previousFeeBps} bps to ${a.feeBps} bps (refreshRouteFee). The route itself did not change. If nobody ran that refresh, treat the key as compromised`,
  OwedCredited: (a) =>
    `a USDG payout to ${a.account} failed and ${usdg(a.amount)} USDG was credited to its owed balance, claimable with claimOwed. The payee may be frozen, or USDG may be paused`,
  OrderBookFeesStranded: (a) =>
    `${usdg(a.amount)} USDG of fees stayed in the old OrderBook ${a.orderBook} when setOrderBook repointed the splitter, and will never reach the splitter unless they are recovered from that book. An amount of 0 means the old book could not even be asked, so the stranded sum is unknown: read the old book's owed balance for the splitter`,
};

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

/** A config event whose severity depends on the event, not only its name. */
const CONFIG_EVENT_SEVERITY = {
  HouseLimitsSet: (e) => (e.direction === "loosen" ? "error" : "warn"),
};

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
    // FundingAllowedSet(maker, true) pages as v2_mon_jit_funding_on (error) instead; its false stays here.
    if (fundingTurnedOn(e)) continue;
    if (adoptUntil !== null && BigInt(e.blockNumber) <= BigInt(adoptUntil)) continue;
    const name = names[lc(e.address)] ?? e.address;
    const text = CONFIG_EVENT_TEXT[e.eventName];
    out.push(
      finding(
        "v2_mon_config_changed",
        `${lc(e.transactionHash)}:${e.logIndex}`,
        "config",
        `${name}.${e.eventName}(${argsSummary(e.args)}) in block ${e.blockNumber}, tx ${e.transactionHash}: ${text === undefined ? "expected only from a planned admin or guardian action; if nobody owns it, treat the key as compromised" : text(e.args ?? {}, e)}`,
        { contract: name, address: e.address, event: e.eventName, args: e.args, blockNumber: e.blockNumber, transactionHash: e.transactionHash, ...(e.direction === undefined ? {} : { direction: e.direction, previous: e.previous }) },
        { severity: CONFIG_EVENT_SEVERITY[e.eventName]?.(e) ?? severity },
      ),
    );
  }
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/*  pure checks: Earn just-in-time funding stays off                                    */
/* ---------------------------------------------------------------------------------------------- */

/** The order every funding page quotes. */
export const JIT_FUNDING_ORDER =
  "Owner order 2026-09-24 ~10:20 AM PT: Earn just-in-time funding stays OFF until the quoteTake fix lands and passes review (once a maker is allow-listed the app can show a fill the trade will not do)";
/** Remedy quoted on every funding page: ONE call, setFundingAllowed(maker, false), which also clears `on` (OrderBook.sol:666-669); a later setBookFunding(false) reverts (:686). Not a launch switch name. */
export const JIT_FUNDING_REMEDY =
  "Switch it off now with ONE call: OrderBook.setFundingAllowed(maker, false) (CONFIG_ADMIN; maker = the vault or maker named above), which sets both allowed and on to false, so the book stops calling the maker. Build it by hand in the Safe web app from the Admin Safe, not with the repo's Safe tooling, which refuses funding switches on purpose (owner ruling 2026-09-24 ~2:45 PM PT). Do not add EarnVault.setBookFunding(false): after the revoke it reverts NotAuthorized (OrderBook.setFunding needs allowed), and in the same Safe batch that revert undoes the revoke. For the EarnVault's own flag, send EarnVault.setFundingEnabled(false) (CONFIG_ADMIN) as its own transaction; v2_mon_jit_funding_enabled resolves when all three read false. Then find who sent the transaction: no script, runbook or Safe batch may turn it on";

/**
 * The logs that turn just-in-time funding on, each with the argument that says so (the deployed
 * contracts):
 *   FundingEnabledSet(bool on)                      EarnVault.setFundingEnabled (EarnVault.sol:965-968): the vault's own switch;
 *   FundingAllowedSet(address indexed maker, bool allowed)  OrderBook.setFundingAllowed (OrderBook.sol:666-670): the
 *                                                   allow-list, the permission a maker needs before it can switch on;
 *   FundingSet(address indexed maker, bool on)      OrderBook.setFunding (OrderBook.sol:686-691): an allowed maker's own
 *                                                   switch (EarnVault.setBookFunding calls it for the vault).
 * `true` pages v2_mon_jit_funding_on at error. `false` is the ordered state: FundingEnabledSet(false) and FundingSet(false)
 * page nothing, and FundingAllowedSet(false) keeps the v2_mon_config_changed warn it has in CONFIG_EVENTS.
 */
export const JIT_FUNDING_EVENTS = Object.freeze({ FundingEnabledSet: "on", FundingAllowedSet: "allowed", FundingSet: "on" });
/** The address each funding event must come from: another contract's log with the same signature is not it. */
export const JIT_FUNDING_EMITTER = Object.freeze({ FundingEnabledSet: "earnVault", FundingAllowedSet: "orderBook", FundingSet: "orderBook" });

/** Does this decoded log turn funding on? */
export const fundingTurnedOn = (e) => {
  const arg = JIT_FUNDING_EVENTS[e.eventName];
  return arg !== undefined && e.args?.[arg] === true;
};

/**
 * events: decoded logs; adoptUntil and names as configEventFindings. One error page per log that turns funding
 * on, keyed by tx and log index. An event: it pages once and never resolves; v2_mon_jit_funding_enabled is the state.
 */
export function jitFundingEventFindings(events, adoptUntil, names) {
  const out = [];
  for (const e of events) {
    if (!fundingTurnedOn(e)) continue;
    if (adoptUntil !== null && BigInt(e.blockNumber) <= BigInt(adoptUntil)) continue;
    const at = names[lc(e.address)] ?? e.address;
    const maker = e.eventName === "FundingEnabledSet" ? e.address : e.args.maker;
    const what =
      e.eventName === "FundingEnabledSet"
        ? `EarnVault ${e.address} switched its own just-in-time funding ON (FundingEnabledSet(true))`
        : e.eventName === "FundingAllowedSet"
          ? `${at} allow-listed maker ${maker} for just-in-time funding (FundingAllowedSet(${maker}, true))`
          : `maker ${maker} switched its just-in-time funding ON at ${at} (FundingSet(${maker}, true))`;
    out.push(
      finding("v2_mon_jit_funding_on", `${lc(e.transactionHash)}:${e.logIndex}`, "funding", `${what} in block ${e.blockNumber}, tx ${e.transactionHash}. ${JIT_FUNDING_ORDER}. ${JIT_FUNDING_REMEDY}`, {
        contract: at,
        address: e.address,
        event: e.eventName,
        maker,
        blockNumber: e.blockNumber,
        transactionHash: e.transactionHash,
      }),
    );
  }
  return out;
}

/**
 * The switch at the head, read every pass: a FundingEnabledSet or FundingSet before the monitor's first run is
 * adopted without a page (the launch batch runs before that run), and a missed log pages nothing.
 *   x = { vault, enabled (EarnVault.fundingEnabled(), null = not read), book (OrderBook.fundingOf(vault) as
 *         { allowed, on }, null = not read) }
 * Any of the three true pages at error; it resolves when all three read false.
 */
export function checkJitFunding(x) {
  const on = [];
  if (x.enabled === true) on.push("EarnVault.fundingEnabled() is true");
  if (x.book?.allowed === true) on.push(`OrderBook.fundingOf(${x.vault}).allowed is true (the vault is allow-listed)`);
  if (x.book?.on === true) on.push(`OrderBook.fundingOf(${x.vault}).on is true (the book calls the vault to fund takes)`);
  if (on.length === 0) return [];
  return [
    finding("v2_mon_jit_funding_enabled", lc(x.vault), "funding", `EarnVault ${x.vault}: just-in-time funding is on at the head: ${on.join("; ")}. ${JIT_FUNDING_ORDER}. ${JIT_FUNDING_REMEDY}`, {
      vault: x.vault,
      enabled: x.enabled,
      allowed: x.book?.allowed ?? null,
      on: x.book?.on ?? null,
    }),
  ];
}

/**
 * The custom error a viem call error decoded against the call's ABI, anywhere in its
 * cause chain (ContractFunctionRevertedError.data.errorName), or null when there is none.
 */
export function revertErrorName(error) {
  for (let e = error, i = 0; e && i < 12; e = e.cause, i += 1) {
    if (e.data !== null && typeof e.data === "object" && typeof e.data.errorName === "string") return e.data.errorName;
  }
  return null;
}

/**
 * While the EarnVault's venue adapter cannot be read and its last known venue value is
 * not zero, or reached zero only by subtracting pulls, nothing is priced: every deposit and redeem
 * queues, processQueue serves nothing, skim takes nothing, and convertToShares / convertToAssets revert
 * VenueUnreadable(). Nothing on chain ends it except the venue reading again or TREASURY_ADMIN writing it off with
 * setAdapter (VenueWrittenOff), so it pages at error for as long as it holds.
 *   x = { vault, adapter (EarnVault.adapter(), null = not read), probe: "priced" | "unreadable" | "position-open" }
 * probe is convertToAssets(1) at the head: it answers ("priced"), or reverts VenueUnreadable ("unreadable") or
 * PositionOpen ("position-open", checked first by the contract, so the venue is not judged then).
 */
export function checkEarnVenue(x) {
  if (x.probe !== "unreadable") return [];
  return [
    finding(
      "v2_mon_earn_venue_unreadable",
      lc(x.vault),
      "earnvenue",
      `EarnVault ${x.vault}: its venue adapter ${x.adapter ?? "(adapter() unread)"} cannot be read, so the vault prices nothing (convertToAssets reverts VenueUnreadable, T-OP-838): every deposit and withdrawal queues, processQueue serves nothing and skim takes nothing until the venue reads again. If it will not recover, TREASURY_ADMIN ends the wait with EarnVault.setAdapter, which writes the venue's last known value off (VenueWrittenOff) and lowers the share price by that much; a value that reached 0 only by subtracting pulls (T-OP-900) is written off as 0, and whatever the venue still holds is given up`,
      { vault: x.vault, adapter: x.adapter },
    ),
  ];
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
  // AutoRoller.Repriced has kinds of its own (repriceFindings); configEventFindings must never page it.
  "Repriced",
]);

/**
 * Every event that has a kind of its own, so `v2_mon_config_changed` never pages it a second time. The scan
 * collects an event when it is in CONFIG_EVENTS or here; `configEventFindings` is given everything NOT here.
 * Adding an event to one of the three sets below and forgetting this one would double-page it; leaving it out of
 * all four would drop it silently, which is the failure `CONFIG_EVENTS` exists to prevent.
 */
// FundingEnabledSet and FundingSet have only jitFundingEventFindings (their false pages nothing). FundingAllowedSet
// stays in CONFIG_EVENTS for its false; configEventFindings hands its true to v2_mon_jit_funding_on.
export const OWN_KIND_EVENTS = new Set([
  ...DEDICATED_EVENTS,
  ...MANAGER_ROLE_EVENTS,
  ...MANAGER_OPERATION_EVENTS,
  ...SPLITTER_EVENTS,
  ...Object.keys(JIT_FUNDING_EVENTS).filter((n) => CONFIG_EVENTS[n] === undefined),
]);
/** The pin logs prePinFindings groups by transaction, and the Clearinghouse mint or series creation they must come with. */
export const PIN_EVENTS = new Set(["SeriesCreated", "Minted", "SettlementConfigPinned", "FeedPinned", "PoolPinned", "DataStreamsFeedPinned", "BandPinned"]);

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
            ? `the source is listed (${listed.slice(0, 8).join(", ")}${listed.length > 8 ? `, and ${listed.length - 8} more` : ""}): the change bumps feedVersion, so every pinned ${ticker} expiry whose window is not recorded yet stops being priced by it and settles on its other pinned sources alone (with none of them answering, adminResolve takes any price once Held, from E + 7 d)`
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
 * As manifestRoleOf, for a call on `target`: the target's own manifest entry when the address is a manifest
 * target the registry names (`ctx.byTarget`: lowercase address -> selector index of its contract), because one
 * selector can carry different roles on two contracts (setOracle(address): FeeSplitter TREASURY_ADMIN, HouseVault
 * CONFIG_ADMIN). Any other address falls back to the selector-only index.
 */
export function manifestRoleAt(target, selector, ctx) {
  const own = typeof target === "string" ? ctx?.byTarget?.[lc(target)] : undefined;
  if (own !== undefined && selector !== null) return own[selector] ?? null;
  return manifestRoleOf(selector, ctx?.selectors);
}

/**
 * INTERFACE_VERSION 8. Every AccessManager log, paged one for one: the manager is the only thing standing between
 * a stolen key and the whole protocol, so nothing here is adopted quietly the way a routine setter is.
 *
 *   ctx = { names (lowercase address -> contract name), manifest (ROLE_MANIFEST.manifest or null),
 *           selectors (selector -> { contract, signature, role } or null), byTarget (lowercase target
 *           address -> that contract's selector index, manifestRoleAt), now (head timestamp),
 *           lockSeen (this monitor has seen every delayed lane at its manifest delay, `state.managerLock`) }
 *
 * `adoptUntil` works exactly as it does for config events: logs at or below the first run's block were already
 * there and page nothing. An operation SCHEDULED before the first run and executed after it still pages on the
 * execution, which is the half that moves state.
 */
/**
 * AutoRoller.Repriced, the PRICER lane moving a writer's ask. The contract bounds each reprice to a
 * MAX_REPRICE_DROP_BPS drop so a leaked PRICER key needs SEVERAL calls to walk an ask to the writer's floor, and
 * AutoRoller.sol:134 promises that each of those calls pages -- this is that page. Per event (in chain order):
 *   (a) v2_mon_reprice_floorward (error): the reprice LOWERED the ask by REPRICE_PAGE_DROP_BPS (20 %) or more,
 *       i.e. drop/priceBefore >= REPRICE_PAGE_DROP_BPS / 10_000. A step that size is what a key walking to the floor
 *       sends; the honest pricer's own step is kept under it (keeper PRICER_MAX_STEP_DROP_BPS) except a band-ceiling step after a spot gap, which its host logs as 'pricer band-ceiling-step'. Needs
 *       `priceBefore`, which the scan carries from the roll's ask or the previous reprice; without it the drop is
 *       unknown and only (b)/(c) apply (the message says so).
 *   (b) v2_mon_reprice_foreign_sender (error): the transaction's `from` is not the registry's pricer key
 *       (`v2.bots.pricer`). `ctx.senders` maps tx hash -> from, read by the caller (one eth_getTransactionByHash per
 *       Repriced log, which is rare). An unknown sender (lookup failed) is reported in the warn, never assumed, and
 *       never folded into the summary below.
 *       With no pricer key in the registry this condition cannot be judged and the warn says so.
 *   (c) v2_mon_repriced (warn) for every reprice that pages nothing, individually up to `t.repriceWarnCap` per run,
 *       the rest folded into ONE summary warn so a busy pricer cannot flood the channel while a page can still
 *       be seen. Nothing here is a silence: a reprice always produces exactly one finding.
 * Keys are `${txHash}:${logIndex}` (event findings dedupe on the key), the summary is keyed on the run's last log.
 * History at or before `adoptUntil` is adopted silently, like every other admin event.
 */
export function repriceFindings(events, adoptUntil, ctx) {
  const t = ctx.t ?? DEFAULTS;
  // The floor-ward threshold is REPRICE_PAGE_DROP_BPS, shared with the pricer, and no longer a threshold key.
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
      floorward = Number(dropBps) >= REPRICE_PAGE_DROP_BPS;
    }
    // (b) the sender: judged only when both sides are known.
    const foreign = pricer !== null && from !== null && !sameAddress(from, pricer);
    if (foreign) {
      out.push(finding("v2_mon_reprice_foreign_sender", key, "config", `AutoRoller.Repriced for ${shortAddr(a.writer)} on ${ticker} in ${at} was sent by ${from}, which is NOT the registry pricer key ${pricer}: ${move}. The PRICER role is held by another key, or the registry is stale; treat the key as leaked until the sender is owned (revoke PRICER through OPS_ADMIN, delay 0)`, data));
    }
    if (floorward) {
      out.push(finding("v2_mon_reprice_floorward", key, "config", `AutoRoller.Repriced for ${shortAddr(a.writer)} on ${ticker} in ${at}: ${move}, at least ${REPRICE_PAGE_DROP_BPS / 100} % in one call (the contract cap is ${MAX_REPRICE_DROP_BPS / 100} %; the pricer's own steps stay under ${REPRICE_PAGE_DROP_BPS / 100} % except a band-ceiling step after a spot gap: first check the pricer host's log for 'pricer band-ceiling-step' at this ask). A key walking the ask to the writer's floor sends steps this size; ${foreign ? "and the sender is foreign (see v2_mon_reprice_foreign_sender)" : from === null ? "the sender could not be read" : "the sender is the registry pricer key"}. Each further step is another page; revoke PRICER through OPS_ADMIN (delay 0) before the ask is at the floor`, data));
    }
    if (!floorward && !foreign) quiet.push({ e, key, ticker, a, move, from, data });
  }
  // A reprice whose sender could not be read is NOT known to be the pricer's: folded into the summary below it
  // was counted as "none of them ... a foreign sender", a verdict nobody made. It is always its own warn, outside the cap.
  const unjudged = quiet.filter((q) => pricer !== null && q.from === null);
  const judged = quiet.filter((q) => !(pricer !== null && q.from === null));
  const shown = [...unjudged, ...judged.slice(0, cap)];
  for (const q of shown) {
    const senderNote = pricer === null ? "no pricer key in the registry, so the sender was not judged" : q.from === null ? "the sender could not be read, so a foreign sender is NOT ruled out: compare the transaction's from with the pricer key" : "sent by the registry pricer key";
    out.push(finding("v2_mon_repriced", q.key, "config", `AutoRoller.Repriced for ${shortAddr(q.a.writer)} on ${q.ticker} in block ${q.e.blockNumber}, tx ${q.e.transactionHash}: ${q.move}; ${senderNote}`, q.data));
  }
  const rest = judged.slice(cap);
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
        const hit = manifestRoleAt(a.target, sel, ctx);
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
      // A 0 before this monitor has seen the lock is what the stonkctl launch role profile grants; say so
      // (the grant still pages, every grant does) instead of calling it a different clock.
      const wrong =
        want === null || delay === want
          ? ""
          : delay === 0 && want > 0 && ctx.lockSeen !== true
            ? ` The manifest gives ${role} an execution delay of ${duration(want)}; 0 is what the stonkctl launch role profile grants every lane until \`stonkctl lock\`. Outside that window this member acts with no delay at all.`
            : ` The manifest gives ${role} an execution delay of ${duration(want)}; this grant carries ${duration(delay)}, so this member can act on a different clock from the published one.`;
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
      const hit = manifestRoleAt(a.target, sel, ctx);
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
 * Which delay table the chain holds, from the published holders of every role whose manifest delay is not 0:
 * `locked` (each at its manifest delay), `launch` (each at 0: the stonkctl launch role profile before `stonkctl lock`),
 * `mixed` (anything else; the lock is one transaction and never leaves one), `unknown` (no such lane was read).
 */
export function managerDelayPhase(members) {
  // A `.launchOnly` pair is revoked by the lock, not raised by it, so it never decides which side the table is on.
  const delayed = (members ?? []).filter((mb) => mb.launchOnly !== true && mb.isMember === true && mb.executionDelay !== null && mb.wantDelayS !== null && Number(mb.wantDelayS) > 0);
  if (delayed.length === 0) return "unknown";
  if (delayed.every((mb) => Number(mb.executionDelay) === Number(mb.wantDelayS))) return "locked";
  if (delayed.every((mb) => Number(mb.executionDelay) === 0)) return "launch";
  return "mixed";
}

/**
 * INTERFACE_VERSION 8. The manager's state against the published manifest. Events say what CHANGED; this says
 * whether what is there now is what `ops/abis/v2/roles.json` says should be there — which is the half that
 * survives a monitor restart and the half that catches a change made before the first run.
 *
 *   x = { manager, rows: [{ roleId, name, chainAdmin, chainGuardian, chainGrantDelay, wantAdmin, wantGuardian }],
 *         members: [{ label, address, roleId, roleName, isMember, executionDelay, wantMember, wantDelayS }],
 *         lock: { block, at } | null (the first run that saw the planned delays: `state.managerLock`) }
 *
 * A null chain value is UNKNOWN (the read failed) and is judged by nothing: the caller records the read failure
 * and the check goes incomplete. It is never read as 0, which would say "no delay" about a role nobody could read.
 *
 * THE LAUNCH ROLE PROFILE. The zero-delay launch (stonkctl `launch.role_profile = "launch"`)
 * deploys every published holder at delay 0, ADMIN included, and `stonkctl lock` raises every delayed lane to its
 * manifest delay in ONE Admin Safe transaction (a raise takes effect at once). So the chain's own table says which
 * side of the lock it is on ({@link managerDelayPhase}), and nothing has to be flipped or remembered: while EVERY
 * delayed lane reads 0 and this monitor has never seen the planned delays, the zeros are one `:prelock` warn, not a
 * P1 per lane. A wrong NON-ZERO delay, a mixed table, a missing or extra holder, an admin or a guardian still pages
 * as before, and once `lock` is recorded a lane back at 0 is a `:delay` error again.
 *
 * LAUNCH-ONLY HOLDERS. A member with `launchOnly: true` is a roles.v8.json `.launchOnly` pair (today the
 * guardian hot key's GUARDIAN), which the same lock transaction revokes; only the Admin Safe keeps the role. "After the
 * lock" is read from the chain as above: the delay table is `locked`, or this monitor has seen it locked (`lock`).
 * Before that the pair is a published holder like any other (a missing one pages `:missing`). After it, a pair still
 * held pages v2_mon_manager_launch_key (error), naming the key and the role, and a revoked one is the planned state.
 *
 * WHO MAY CALL WHAT. `functions` = [{ contract, target, signature, selector, roleName, want (manifest role
 * id | null), chain (getTargetFunctionRole: bigint | null = unread) }], one per manifest selector per target the
 * registry names. A mismatch pages `:fn:<selector>` (a different set of keys can call it, or nobody can). A target
 * whose EVERY selector reads ADMIN (0), the manager's default, has never been mapped at all (a House vault is born that
 * way, HouseVaultFactory.sol): one `:unmapped` warn for the target, since only the Admin Safe can call it until then.
 */
export function checkManagerWiring(x) {
  const out = [];
  const at = lc(x.manager);
  const phase = managerDelayPhase(x.members);
  const lock = x.lock ?? null;
  const locked = phase === "locked" || lock !== null;
  const prelock = [];
  for (const r of x.rows ?? []) {
    if (r.chainAdmin !== null && r.wantAdmin !== null && Number(r.chainAdmin) !== Number(r.wantAdmin)) {
      out.push(
        finding(
          "v2_mon_manager_wiring",
          `${at}:${r.roleId}:admin`,
          "manager",
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
          "manager",
          `AccessManager: ${roleLabel(r.roleId)}'s guardian is ${roleLabel(r.chainGuardian)} on chain, and the manifest says ${roleLabel(r.wantGuardian)}. The guardian is what cancels a scheduled operation in this lane before it runs`,
          { role: r.name, roleId: r.roleId, chain: Number(r.chainGuardian), manifest: Number(r.wantGuardian) },
        ),
      );
    }
  }
  for (const mb of x.members ?? []) {
    if (mb.isMember === null) continue;
    const key = `${at}:${mb.roleId}:${lc(mb.address)}`;
    if (mb.launchOnly === true && locked) {
      if (mb.isMember !== true) continue;
      const seen = phase === "locked" ? "every delayed lane is at its manifest delay" : `this monitor saw the planned delays at block ${lock.block} (${iso(Number(lock.at))})`;
      out.push(
        finding(
          "v2_mon_manager_launch_key",
          `${key}:launch`,
          "manager",
          `AccessManager: ${mb.label} (${mb.address}) still holds ${roleLabel(mb.roleId)} after the lock (${seen}). roles.v8.json lists this pair under launchOnly: the one-transaction lock revokes it and only the Admin Safe keeps the role, so this is a hot key with ${mb.roleName} powers and no Safe behind it. The key can give it up at once (AccessManager.renounceRole(${mb.roleId}, ${mb.address}), sent from the key); otherwise the Admin Safe revokes it (AccessManager.revokeRole, ADMIN). Then find out why the lock batch did not`,
          { role: mb.roleName, roleId: mb.roleId, account: mb.address, holder: mb.label, phase, lock },
        ),
      );
      continue;
    }
    if (mb.wantMember && mb.isMember !== true) {
      out.push(
        finding(
          "v2_mon_manager_wiring",
          `${key}:missing`,
          "manager",
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
          "manager",
          `AccessManager: ${mb.label} (${mb.address}) holds ${roleLabel(mb.roleId)} and the manifest does not give it that role`,
          { role: mb.roleName, roleId: mb.roleId, account: mb.address, holder: mb.label },
        ),
      );
      continue;
    }
    if (mb.isMember === true && mb.executionDelay !== null && mb.wantDelayS !== null && Number(mb.executionDelay) !== Number(mb.wantDelayS)) {
      // The launch window: every delayed lane at 0 and no lock ever seen. Collected into ONE warn below.
      if (phase === "launch" && lock === null && Number(mb.executionDelay) === 0) {
        prelock.push(mb);
        continue;
      }
      const why =
        phase === "mixed"
          ? " The table is MIXED (some delayed lanes at their manifest delay, some not): the launch role profile holds every lane at 0 and `stonkctl lock` raises them all in one transaction, so a mixed table is neither"
          : phase === "launch" && lock !== null
            ? ` Every delayed lane is back at 0, and this monitor saw the planned delays at block ${lock.block} (${iso(Number(lock.at))}): the lock has been undone`
            : "";
      out.push(
        finding(
          "v2_mon_manager_wiring",
          `${key}:delay`,
          "manager",
          `AccessManager: ${mb.label} holds ${roleLabel(mb.roleId)} with an execution delay of ${duration(Number(mb.executionDelay))}, and the manifest says ${duration(Number(mb.wantDelayS))}. The delay IS the protection: a shorter one is less time to notice and cancel, and a longer one is an emergency brake that arrives late.${why}`,
          { role: mb.roleName, roleId: mb.roleId, account: mb.address, chainDelayS: Number(mb.executionDelay), manifestDelayS: Number(mb.wantDelayS), phase },
        ),
      );
    }
  }
  if (prelock.length > 0) {
    const lanes = prelock.map((mb) => `${mb.roleName} ${duration(Number(mb.wantDelayS))}`).join(", ");
    out.push(
      finding(
        "v2_mon_manager_wiring",
        `${at}:prelock`,
        "manager",
        `AccessManager: every delayed lane is at 0 (${prelock.length}: ${lanes}), which is the stonkctl launch role profile before \`stonkctl lock\`. Until the lock the Admin Safe acts at once in every lane and no change waits out a delay; run \`stonkctl lock\` once the launch is verified. This is NOT a launch-profile deployment if nobody ran one: then every lane has lost its delay`,
        { phase, lanes: prelock.map((mb) => ({ role: mb.roleName, roleId: mb.roleId, account: mb.address, holder: mb.label, manifestDelayS: Number(mb.wantDelayS) })) },
        { severity: "warn" },
      ),
    );
  }
  const byTarget = new Map();
  for (const f of x.functions ?? []) {
    if (f.chain === null || f.want === null) continue;
    const list = byTarget.get(lc(f.target)) ?? [];
    list.push(f);
    byTarget.set(lc(f.target), list);
  }
  for (const [target, fns] of byTarget) {
    const wrong = fns.filter((f) => BigInt(f.chain) !== BigInt(f.want));
    if (wrong.length === 0) continue;
    if (fns.length > 1 && fns.every((f) => BigInt(f.chain) === 0n)) {
      out.push(
        finding(
          "v2_mon_manager_wiring",
          `${at}:${target}:unmapped`,
          "manager",
          `AccessManager: ${fns[0].contract} ${fns[0].target} has none of its ${fns.length} manifest selectors mapped (every one reads ADMIN (0), the manager's default). Nothing but the Admin Safe can call it until the Admin Safe sends its setTargetFunctionRole batch naming this address (${wrong.map((f) => f.roleName).filter((r, i, a) => a.indexOf(r) === i).join(", ")} lanes)`,
          { contract: fns[0].contract, target: fns[0].target, selectors: fns.length },
          { severity: "warn" },
        ),
      );
      continue;
    }
    for (const f of wrong) {
      const chain = BigInt(f.chain) === MANAGER_PUBLIC_ROLE ? "PUBLIC_ROLE (anyone)" : roleLabel(f.chain);
      out.push(
        finding(
          "v2_mon_manager_wiring",
          `${at}:${target}:fn:${lc(f.selector)}`,
          "manager",
          `AccessManager: ${f.contract}.${f.signature} on ${f.target} needs ${chain} on chain, and the manifest (ops/abis/v2/roles.json) says ${roleLabel(f.want)}. A different role is a different set of keys that can call it, on a different delay`,
          { contract: f.contract, target: f.target, signature: f.signature, selector: f.selector, chain: String(f.chain), manifest: Number(f.want), role: f.roleName },
        ),
      );
    }
  }
  return out;
}

/**
 * The (holder, role) pairs the manifest publishes, for the holders the registry names an address for:
 * [{ label, address, roleId, roleName, launchOnly }]. `launchOnly` marks a `.launchOnly` pair, which
 * checkManagerWiring judges by which side of the lock the chain is on. One address named by two holders keeps the
 * pair that is NOT launch-only: the lock never revokes that one.
 */
export function publishedHolders(manifest, holderAddress) {
  const wanted = new Map();
  const revokedAtLock = new Set(Object.entries(manifest.launchOnly ?? {}).flatMap(([holder, names]) => names.map((n) => `${holder}/${n}`)));
  for (const [holder, roleNames] of Object.entries(manifest.holders ?? {})) {
    const address = holderAddress[holder] ?? null;
    if (address === null) continue;
    for (const roleName of roleNames) {
      const roleId = manifest.ids[roleName];
      if (roleId === undefined) continue;
      const key = `${lc(address)}:${roleId}`;
      const launchOnly = revokedAtLock.has(`${holder}/${roleName}`);
      if (launchOnly && wanted.has(key) && wanted.get(key).launchOnly !== true) continue;
      wanted.set(key, { label: holder, address, roleId, roleName, launchOnly });
    }
  }
  return [...wanted.values()];
}

/** OpenZeppelin AccessManager's PUBLIC_ROLE, type(uint64).max: getTargetFunctionRole answers it for a function anyone may call. */
export const MANAGER_PUBLIC_ROLE = 2n ** 64n - 1n;

/**
 * The manifest's target contracts, at the addresses the registry publishes for them: [{ contract, address }].
 * `HouseVault` is every House vault the registry records (registryHouseVaults); a contract the registry names no
 * address for is listed in `unnamed` and read at nowhere, never guessed.
 */
export function managerTargets(reg, manifest) {
  const one = {
    Clearinghouse: reg.contracts?.clearinghouse,
    OrderBook: reg.contracts?.orderBook,
    SettlementOracle: reg.contracts?.settlementOracle,
    ExpiryCalendar: reg.contracts?.expiryCalendar,
    KeeperRewards: reg.contracts?.keeperRewards,
    AutoRoller: reg.contracts?.autoRoller,
    MakerVault: reg.contracts?.makerVault,
    MakerRegistry: reg.contracts?.makerRegistry,
    RewardsDistributor: reg.contracts?.rewardsDistributor,
    // INTERFACE_VERSION 8 keeps the payoutAdapter key and points it at the PayoutRouter (CONTRACT_NAMES).
    PayoutRouter: reg.contracts?.payoutAdapter,
    ChainlinkFeedSource: reg.sources?.chainlink,
    UniV3TwapSource: reg.sources?.univ3,
    DataStreamsSource: reg.sources?.dataStreams,
    FeeSplitter: reg.flywheel?.feeSplitter,
    V4BuybackExecutor: reg.flywheel?.buybackExecutor,
    EarnVault: reg.earnVault,
    HouseVaultFactory: reg.managerTargets?.houseVaultFactory,
    Hedger: reg.managerTargets?.hedger,
    RewardsDistributorLender: reg.managerTargets?.rewardsDistributorLender,
    StockVenueAdapter: reg.managerTargets?.stockVenueAdapter,
  };
  const targets = [];
  const unnamed = [];
  for (const contract of Object.keys(manifest?.targets ?? {})) {
    const addresses = contract === "HouseVault" ? registryHouseVaults(reg).map((h) => h.address) : one[contract] ? [one[contract]] : [];
    if (addresses.length === 0) unnamed.push(contract);
    for (const address of addresses) targets.push({ contract, address });
  }
  return { targets, unnamed };
}

/**
 * The AccessManager's two membership events, as their own ABI: the walk below decodes the manager's
 * log with nothing else, so AccessControl's RoleGranted(bytes32,…) (another topic) can never be read as one of these.
 */
export const MANAGER_MEMBER_EVENTS = [
  "event RoleGranted(uint64 indexed roleId, address indexed account, uint32 delay, uint48 since, bool newMember)",
  "event RoleRevoked(uint64 indexed roleId, address indexed account)",
];

/**
 * Every account the AccessManager has made a member, from its own RoleGranted / RoleRevoked log.
 * VerifyV8 and the "manager" check both ask hasRole about the holders they already know, so neither can see a grant to
 * anyone else. v2_mon_manager_role pages such a grant as an event, but only one made after the monitor's first run: the
 * first run adopts every earlier admin event without a page (adoptConfigUntil). This keeps the last event per (role,
 * account) from the deploy block on, so "who holds anything?" does not depend on when the monitor was started.
 *
 *   walk = { cursor, members: { "<roleId>:<account lowercase>": { roleId, account, member, block, logIndex } },
 *            firstAdmin: { account, block, logIndex } | null }   (state.managerMembers)
 *   logs = parseEventLogs output over MANAGER_MEMBER_EVENTS
 *
 * The walk re-reads its last REORG_OVERLAP blocks, so a log can arrive twice: an event older than the one already kept
 * for its (role, account) is skipped, which makes a replay change nothing. `firstAdmin` is the earliest ADMIN (role 0)
 * grant: AccessManager's constructor grants ADMIN to its initial admin, the deployer, before anything else can happen,
 * so a walk that saw the manager's creation always has one. None means the walk started after it.
 */
export function applyManagerMembership(walk, logs) {
  const before = (a, b) => a.block < b.block || (a.block === b.block && a.logIndex < b.logIndex);
  for (const l of logs) {
    if (l.eventName !== "RoleGranted" && l.eventName !== "RoleRevoked") continue;
    const roleId = Number(l.args.roleId);
    const account = lc(l.args.account);
    const at = { block: Number(l.blockNumber), logIndex: Number(l.logIndex) };
    const key = `${roleId}:${account}`;
    const prev = walk.members[key];
    if (prev === undefined || !before(at, prev)) walk.members[key] = { roleId, account, member: l.eventName === "RoleGranted", ...at };
    if (roleId === 0 && l.eventName === "RoleGranted" && (walk.firstAdmin === null || before(at, walk.firstAdmin))) walk.firstAdmin = { account, ...at };
  }
  return walk;
}

/**
 * The walked members against who may hold a manager role at all.
 *
 *   x = { manager, walk (applyManagerMembership), manifest (ops/abis/v2/roles.json: names, ids, holders),
 *         holders: { adminSafe, treasurySafe, guardianKey, pricerKey, quoterKey, crankerKey } (registry addresses or null),
 *         confirmed: Map "<roleId>:<account>" -> true | false | null (hasRole at the head; null = not read) }
 *
 * One kind, v2_mon_manager_unlisted_member (error), keyed `<manager>:<account>:<roleId>`, for:
 *   - a member that is none of the registry's two Safes, its four bot keys, or the deployer (the walk's first ADMIN);
 *   - a BOT key holding a role the manifest's `holders` does not give it (the pricer key holding ADMIN is exactly as
 *     bad as a stranger holding it). The Safes and the deployer are not judged per role: the Admin Safe holds most roles
 *     by design, and the deployer holds whatever the launch role profile gave it until it renounces.
 * A member the head's hasRole says is NOT one is not paged: the walk is stale (a reorg past REORG_OVERLAP), and the
 * caller notes it. A null (unread) confirmation still pages: the walk's own log is the evidence.
 *
 * A `.launchOnly` pair (the guardian key's GUARDIAN) counts as listed here on both sides of the lock: after
 * the lock the "manager" check pages it as v2_mon_manager_launch_key from hasRole at the head, which needs no walk, so
 * this check does not page the same key a second time under another kind.
 */
export function checkManagerMembers(x) {
  const out = [];
  const at = lc(x.manager);
  const names = x.manifest?.names ?? {};
  const ids = x.manifest?.ids ?? {};
  const roleName = (id) => names[id] ?? `role ${id}`;
  const safes = new Map();
  if (x.holders.adminSafe) safes.set(lc(x.holders.adminSafe), "the Admin Safe (shared.safes.admin)");
  if (x.holders.treasurySafe) safes.set(lc(x.holders.treasurySafe), "the Treasury Safe (shared.safes.treasury)");
  if (x.walk.firstAdmin) safes.set(x.walk.firstAdmin.account, "the deployer (the manager's initial admin)");
  // A bot key -> the role ids the manifest gives it (a key named twice gets both lists).
  const bots = new Map();
  for (const [label, bot] of [["guardianKey", "guardian"], ["pricerKey", "pricer"], ["quoterKey", "quoter"], ["crankerKey", "cranker"]]) {
    const address = x.holders[label];
    if (!address) continue;
    const entry = bots.get(lc(address)) ?? { what: [], roles: new Set() };
    entry.what.push(`v2.bots.${bot}`);
    for (const name of x.manifest?.holders?.[label] ?? []) if (ids[name] !== undefined) entry.roles.add(Number(ids[name]));
    bots.set(lc(address), entry);
  }
  for (const mb of Object.values(x.walk.members)) {
    if (!mb.member || safes.has(mb.account)) continue;
    const bot = bots.get(mb.account);
    if (bot !== undefined && bot.roles.has(mb.roleId)) continue;
    const key = `${mb.roleId}:${mb.account}`;
    if (x.confirmed.get(key) === false) continue;
    const who =
      bot === undefined
        ? `${mb.account}, which is none of the registry's Safes, its bot keys or the deployer,`
        : `${mb.account} (${bot.what.join(", ")}), which the manifest gives ${[...bot.roles].map(roleName).join(", ") || "no role"} and not this one,`;
    out.push(
      finding(
        "v2_mon_manager_unlisted_member",
        `${at}:${mb.account}:${mb.roleId}`,
        "members",
        `AccessManager ${x.manager}: ${who} holds ${roleName(mb.roleId)} (granted at block ${mb.block}${x.confirmed.get(key) === true ? ", still a member at the head" : ", not confirmed at the head: hasRole was not read"}). VerifyV8 and the holder check only ask about published holders, so nothing else reports this member. Revoke it unless the grant was planned, and find out who sent it`,
        { manager: x.manager, account: mb.account, roleId: mb.roleId, role: roleName(mb.roleId), grantedAtBlock: mb.block, listed: bot === undefined ? null : bot.what, confirmed: x.confirmed.get(key) ?? null },
      ),
    );
  }
  return out;
}

/** A multisig that can be moved by one signature is not a multisig. Both v8 Safes are 2-of-3. */
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
        "safes",
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
        "safes",
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
          "flywheel",
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
        "flywheel",
        `FeeSplitter: ${f.count} consecutive ${f.reason} skips converting ${f.ticker} (last ${iso(f.lastAt)}). ${FLOOR_MISS_WHY[f.reason] ?? "The conversion floor is the oracle's ok spot less the configured slippage and the route fee, so a run of misses means the route cannot fill at the oracle's price: the pool is too thin, the route fee is too high, or the route points at the wrong pool. The tokens are held, not dumped — nothing is lost while this is open, but no fee reaches the treasury or the buyback either"}`,
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
 *         returns 0 before the first buyback and 0 is not a timestamp), cooldownS (FeeSplitter.buybackCooldown(),
 *         read live, as it is settable; null = unread, judged as no cooldown), fundedSince (unix s | null),
 *         lastSkip ({ reason, at } | null = the contract has refused no buyback since the last one went through),
 *         unburned: [{ transactionHash, usdgIn, tokenOut }] }
 *
 * WHAT `lastSkip` CAN AND CANNOT TELL YOU. `BuybackSkipped` has three reasons: `EMPTY` (reserve or `buybackCap` zero),
 * `NO_EXECUTOR` (`executor` or `stonkhouse` unset) and `SHORT_RESERVE` (see SKIP_WHY at the end of this file,
 * with the v9 entry point). Everything else REVERTS -- paused, the cooldown, and an executor that refuses the
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
        "flywheel",
        `FeeSplitter emitted BoughtBack(${usdg(b.usdgIn)} USDG in, ${b.tokenOut} STONKHOUSE out) in tx ${b.transactionHash} with NO Burned in the same transaction. The published contract requires the burn to equal the token's measured total-supply delta, so either this is not that contract or the tokens bought with protocol fees are sitting somewhere instead of being burned. Nothing may report a burn that has not happened`,
        { splitter: x.splitter, transactionHash: b.transactionHash, usdgIn: b.usdgIn, tokenOut: b.tokenOut },
      ),
    );
  }
  if (t.buybackStuckS > 0 && x.balance !== null && x.balance !== undefined && BigInt(x.balance) > 0n) {
    // Ready = the cooldown since the last buy has passed. Never bought = ready now; 0 from the contract means
    // "never", and treating it as a 1970 timestamp would be the same mistake in the other direction.
    const last = buybackClock(x.lastBuybackAt);
    // The splitter's own cooldown. Unread counts as none: it can only page one cooldown early, against a
    // stuck window of hours, and the note says the read failed.
    const cooldown = x.cooldownS === null || x.cooldownS === undefined ? null : Number(x.cooldownS);
    const readyAt = last === null ? null : last + (cooldown ?? 0);
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
              ? `the reserve is ${usdg(x.balance)} USDG, so with buyback() refusing as EMPTY the zero is buybackCap or buybackCapCeiling (a buy may spend the smaller of the two): the cap dial is 0 and the flywheel is switched OFF by configuration, not by a stopped cranker. setBuybackCap is FEE_MANAGER at a 48 h delay, setBuybackCapCeiling ADMIN at 48 h`
              : (SKIP_WHY[skip.reason]?.(x) ?? `the contract refused with ${skip.reason}`);
        out.push(
          finding(
            "v2_mon_buyback_skipped",
            `${at}:skipped:${lc(skip.reason)}`,
            "flywheel",
            `FeeSplitter has ${usdg(x.balance)} USDG set aside and has bought nothing for ${duration(age)}, and the cranker IS calling: the contract emitted BuybackSkipped(${skip.reason}) ${duration(x.now - skip.at)} ago. ${why}. Do not chase the cranker for this one`,
            { splitter: x.splitter, balance: x.balance, lastBuybackAt: last, ageS: age, reason: skip.reason, skippedAgeS: x.now - skip.at },
          ),
        );
      } else {
        out.push(
          finding(
            "v2_mon_buyback_stuck",
            `${at}:stuck`,
            "flywheel",
            `FeeSplitter has ${usdg(x.balance)} USDG set aside for buybacks and has not bought back for ${duration(age)}${last === null ? " (never)" : ` (last ${iso(last)})`}, with the ${cooldown === null ? "cooldown (unread)" : `${duration(cooldown)} cooldown`} long over${skip === null ? ", and the contract has emitted no BuybackSkipped, so nothing has called buyback() and been refused" : `; the last BuybackSkipped(${skip.reason}) was ${duration(x.now - skip.at)} ago, older than the ${duration(t.buybackStuckS)} window, so the contract refused once and then nothing called again`}. buyback() needs the BUYBACK role, which the cranker key holds: check that the cranker's buyback step is running and that its minTokenOut is not refusing every quote. From v9 the entry point is buybackWithDeadline(minTokenOut, deadline): buyback(uint256) ALWAYS reverts BuybackDeadlineRequired and leaves no event, so a cranker still sending it is indistinguishable from a stopped one here too. A dry-running cranker (CRANKER_BUYBACK_DRY_RUN) sends no transaction and looks exactly like a stopped one from here`,
            { splitter: x.splitter, balance: x.balance, lastBuybackAt: last, ageS: age, cooldownS: cooldown, lastSkip: skip },
          ),
        );
      }
    }
  }
  return out;
}

/** A bytes32 `reason` as its word: SKIP_REASON_HASHES (the contract emits keccak256("<WORD>")), else its packed ASCII. */
export function reasonText(hex) {
  if (typeof hex !== "string" || !/^0x[0-9a-fA-F]*$/.test(hex)) return String(hex);
  const bytes = hex.slice(2).match(/../g) ?? [];
  const text = bytes
    .map((b) => Number.parseInt(b, 16))
    .filter((c) => c !== 0)
    .map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : "?"))
    .join("");
  return SKIP_REASON_HASHES[hex.toLowerCase()] ?? (text === "" ? hex : text);
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
 *
 * The scan re-reads its last REORG_OVERLAP blocks on every run, so a splitter log reaches this function
 * again on each pass that re-reads it. `fly.at` is the highest "<block>:<logIndex>" already folded in, and a log at or
 * below it is skipped: the rule of the rent ledger's `scan.rentAt` (applyScanLogs). A real reorg resets the whole scan
 * state, flywheel included, so a skipped log is always one whose identical twin was counted. Without it one
 * DistributionSkipped counted as a run of three and paged v2_mon_splitter_floor_miss. A log with no position (a
 * hand-built one) is always folded in.
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
  fly.at ??= null;
  const mark = fly.at === null ? null : fly.at.split(":").map(BigInt);
  let highest = mark;
  const counted = (e) => {
    if (e.blockNumber === undefined || e.blockNumber === null || e.logIndex === undefined || e.logIndex === null) return false;
    const here = [BigInt(e.blockNumber), BigInt(e.logIndex)];
    if (highest === null || here[0] > highest[0] || (here[0] === highest[0] && here[1] > highest[1])) highest = here;
    return mark !== null && (here[0] < mark[0] || (here[0] === mark[0] && here[1] <= mark[1]));
  };
  const burnedIn = new Set();
  const bought = [];
  for (const e of events) {
    if (e.eventName === "Burned") burnedIn.add(lc(e.transactionHash));
  }
  for (const e of events) {
    const a = e.args ?? {};
    if (counted(e)) continue;
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
  if (highest !== null) fly.at = `${highest[0]}:${highest[1]}`;
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
      "routes",
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
    out.push(finding("v2_mon_route_wiring", `${key}:${suffix}`, "routes", message, { ticker: x.ticker, asset: x.asset, chain: { ...x.route, venue: chainVenue }, registry: want, ...data }, { severity }));

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
 * INTERFACE_VERSION 8. The STONKHOUSE pool the buyback executes against. It is HOOKED by design: the token
 * launched on a hooked v4 pool, and the executor's `MAX_HOOK_FEE_BPS` ceiling (V4BuybackExecutor) exists because
 * a hook can take a fee out of every swap. So a hook is not a finding; a pool other than the pinned one is. The
 * executor trades ONE immutable PoolKey, `key()`, and that key must be the registry's shared.token.poolKey, field for
 * field, hook included. A different key is a different pool, whatever it charges.
 *
 *   x = { poolId (published), poolKey (the published key), recomputedPoolId (from that key, or null),
 *         liveKey (the buyback executor's key() | null = not read or no executor published), executor (its address),
 *         depth (USDG base units | null = UNKNOWN, never 0),
 *         fees (the executor's feeBps(): { v3, v4Lp, v4Protocol, hook, creatorTax, total } | null = not read),
 *         feesRefusal ("NoSource" | "CeilingExceeded" when feeBps() itself reverts, as buy() would | null),
 *         maxTotalFeeBps (the executor's cap | null = not read) }
 *
 * The depth is read from a v4 pool, which needs a PoolManager the registry does not publish yet; until it does,
 * `depth` is null and `tokenPoolMinDepth` set with an unknown depth pages, the same way an unknown source clock
 * fails a set age limit. An unknown depth is not a deep pool.
 */
export function checkTokenPool(x, t = DEFAULTS) {
  const out = [];
  const k = x.poolKey ?? {};
  const id = x.poolId ?? "(unpublished)";
  const live = x.liveKey ?? null;
  if (live !== null) {
    const diffs = [];
    for (const f of ["currency0", "currency1", "hooks"]) if (!sameAddress(live[f], k[f])) diffs.push(`${f} ${live[f]} instead of ${k[f]}`);
    for (const f of ["fee", "tickSpacing"]) if (Number(live[f]) !== Number(k[f])) diffs.push(`${f} ${live[f]} instead of ${k[f]}`);
    if (diffs.length > 0) {
      out.push(
        finding(
          "v2_mon_token_pool_fee",
          `${lc(id)}:live`,
          "tokenpool",
          `the buyback executor ${x.executor ?? ""} trades a v4 pool other than the pinned STONKHOUSE pool ${id}: its key() has ${diffs.join(", ")} (shared.token.poolKey). A different PoolKey is a different pool, with its own hook, fee and depth, so every buyback swaps somewhere the registry does not describe`,
          { poolId: x.poolId, executor: x.executor ?? null, pinned: k, live, differences: diffs },
        ),
      );
    }
  }
  // V2Constants.MAX_HOOK_FEE_BPS bounds the HOOK's own cut, launches(poolId).hookFeeBps, not the PoolKey's LP fee
  // tier; every fee term together is bounded by the executor's maxTotalFeeBps (V4BuybackExecutor.buy enforces
  // it). Both come from the executor's own feeBps(), the read buy() guards with. A breach reverts every buy, which
  // leaves no event. The static key check left is the one the executor's constructor makes: no dynamic-fee flag.
  if (k.fee !== null && k.fee !== undefined && (Number(k.fee) & V4_DYNAMIC_FEE_FLAG) !== 0) {
    out.push(
      finding(
        "v2_mon_token_pool_fee",
        `${lc(id)}:dynamic`,
        "tokenpool",
        `the STONKHOUSE pool key ${id} carries v4's dynamic-fee flag (fee ${k.fee}): V4BuybackExecutor refuses such a key (RouteRejected DYNAMIC_FEE), so no executor can be built for this pool`,
        { poolId: x.poolId, fee: Number(k.fee) },
      ),
    );
  }
  const fees = x.fees ?? null;
  if (fees !== null && Number(fees.hook) > MAX_HOOK_FEE_BPS) {
    out.push(
      finding(
        "v2_mon_token_pool_fee",
        `${lc(id)}:fee`,
        "tokenpool",
        `the STONKHOUSE pool's hook takes ${fees.hook} bps (launches(poolId).hookFeeBps), above the ${MAX_HOOK_FEE_BPS} bps V2Constants.MAX_HOOK_FEE_BPS allows: V4BuybackExecutor.buy reverts HookFeeCapExceeded, so every buyback reverts and leaves no event`,
        { poolId: x.poolId, executor: x.executor ?? null, hookBps: Number(fees.hook), maxBps: MAX_HOOK_FEE_BPS },
      ),
    );
  }
  if (fees !== null && x.maxTotalFeeBps !== null && x.maxTotalFeeBps !== undefined && BigInt(fees.total) > BigInt(x.maxTotalFeeBps)) {
    out.push(
      finding(
        "v2_mon_token_pool_fee",
        `${lc(id)}:total`,
        "tokenpool",
        `the buyback route's fee terms add up to ${fees.total} bps (v3 ${fees.v3}, v4 LP ${fees.v4Lp}, v4 protocol ${fees.v4Protocol}, hook ${fees.hook}, creator tax ${fees.creatorTax}), above the executor's maxTotalFeeBps ${x.maxTotalFeeBps}: V4BuybackExecutor.buy reverts FeeCapExceeded, so every buyback reverts and leaves no event`,
        { poolId: x.poolId, executor: x.executor ?? null, fees: Object.fromEntries(Object.entries(fees).map(([f, v]) => [f, Number(v)])), maxTotalFeeBps: Number(x.maxTotalFeeBps) },
      ),
    );
  }
  if (x.feesRefusal !== null && x.feesRefusal !== undefined) {
    out.push(
      finding(
        "v2_mon_token_pool_fee",
        `${lc(id)}:refused`,
        "tokenpool",
        `the buyback executor ${x.executor ?? ""} refuses its own fee read, feeBps() reverts ${x.feesRefusal}: buy() makes the same read first, so every buyback reverts. NoSource means the hook's launch record for this pool is gone or no longer names the token; CeilingExceeded, a v4 protocol fee above the executor's ceiling`,
        { poolId: x.poolId, executor: x.executor ?? null, refusal: x.feesRefusal },
      ),
    );
  }
  if (x.recomputedPoolId !== null && x.recomputedPoolId !== undefined && x.poolId !== null && x.poolId !== undefined && lc(x.recomputedPoolId) !== lc(x.poolId)) {
    out.push(
      finding(
        "v2_mon_token_pool_fee",
        `${lc(id)}:id`,
        "tokenpool",
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
          "tokenpool",
          `the STONKHOUSE pool's depth could not be read and --threshold tokenPoolMinDepth is set to ${usdg(t.tokenPoolMinDepth)} USDG. An unknown depth is not a deep pool: either point the monitor at a v4 PoolManager it can read, or clear the threshold`,
          { poolId: x.poolId, depth: null, minimum: String(t.tokenPoolMinDepth) },
        ),
      );
    } else if (depth < BigInt(t.tokenPoolMinDepth)) {
      out.push(
        finding(
          "v2_mon_token_pool_depth",
          `${lc(id)}:depth`,
          "tokenpool",
          `the STONKHOUSE pool holds ${usdg(depth)} USDG of usable depth, below the ${usdg(t.tokenPoolMinDepth)} USDG floor: a buyback of the per-call cap moves this pool, so the burn buys fewer tokens than the quote says`,
          { poolId: x.poolId, depth: String(depth), minimum: String(t.tokenPoolMinDepth) },
        ),
      );
    }
  }
  return out;
}

/**
 * INTERFACE_VERSION 8. The owner's external audit is triggered at $1M of value locked, so the monitor
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
 * WHAT CHANGED, AND WHY IT CONTRADICTS THE COMMENT THAT USED TO BE HERE.
 *
 * The decision above is kept: an incomplete read is UNKNOWN and no partial sum is ever compared against
 * the trigger. What was wrong was its OUTPUT. Returning `[]` made "I could not read it" and "it has not
 * crossed yet" produce the identical silence, and for THIS alert that is fatal, because the check's own
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
 * The audit-trigger fault cases: every way this notice can go quiet while looking healthy.
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
      // Owned by the tvl check, not "meta" (always completed): under "meta" any pass that did not re-find it
      // (a failed balance read, or no chain head at all) resolved it.
      "tvl",
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
      "tvl", // See tvlFaults; a pass whose balances failed kept :full open only once the tvl check owns it
      `${usdg(locked)} USDG is locked in the v8 contracts${x.parts === undefined ? "" : ` (${x.parts.map((p) => `${p.name} ${usdg(p.amount)}`).join(", ")})`}: ${full ? `at or past the ${usdg(trigger)} USDG external-audit trigger (owner decision V3-D33). The audit is due now` : `past half of the ${usdg(trigger)} USDG external-audit trigger (owner decision V3-D33). Commissioning an audit takes weeks, so this is the notice, not the deadline`}`,
      { lockedUsdg6: String(locked), triggerUsdg6: String(trigger), parts: (x.parts ?? []).map((p) => ({ name: p.name, amount: String(p.amount) })) },
      { severity: full ? "error" : "warn" },
    ),
  ];
}

/**
 * Pins made outside a mint or series creation. `logs`: this run's decoded SeriesCreated and Minted (Clearinghouse),
 * SettlementConfigPinned (SettlementOracle) and source pin logs (FeedPinned, PoolPinned, DataStreamsFeedPinned,
 * BandPinned). A Minted log carries `series: { u, e }` (applyScanLogs, from the scan's SeriesCreated, or the
 * Clearinghouse's series(longId) read by the config check), or `series: null` when neither could say.
 * From INTERFACE_VERSION 6 the Clearinghouse pins an expiry on its FIRST MINT (Clearinghouse.mint, "PIN ON MINT"), so a
 * SettlementConfigPinned(u, E) must share its transaction with the Clearinghouse's Minted of a (u, E) series, or, before
 * v6, with its SeriesCreated(u, E) (the oracle's clearinghouse pointer was moved otherwise); a source pin (u, E) with the
 * oracle's SettlementConfigPinned(u, E) or one of those two (else it went through the source's oracle allow-list). A
 * Minted of an unknown series vouches for every pin in its transaction: the Clearinghouse's mint reverts unless the
 * oracle names it as its clearinghouse, so a pointer moved elsewhere cannot pin in the same transaction as a mint that
 * succeeded. A transaction's logs always arrive in one scanned range.
 *   ctx = { names, clearinghouse, settlementOracle, markets,
 *           houses?: [{ address, underlying, pinnedBoundary }] }
 * A registered House vault (registry markets[].v2.house, or --house) calls
 * SettlementOracle.pinBoundary for its own underlying when it rolls and on the first deposit into an
 * empty vault. That emits SettlementConfigPinned with no Clearinghouse mint. Vouch that pin when the
 * same transaction carries that vault's EpochRolled, DepositRequested or DepositedNow, or when the
 * vault's pinnedBoundary() is this expiry. An address that is not on that list vouches nothing.
 */
/** Roll and first-deposit logs of a House vault. The contract emits these from the only paths that call pinBoundary. */
const HOUSE_VAULT_PIN_EVENTS = new Set(["EpochRolled", "DepositRequested", "DepositedNow"]);
const HOUSE_VAULT_PIN_SIGNATURES = [
  "event EpochRolled(uint64 indexed epochId, uint40 indexed epochEnd, uint256 price, uint256 nav, uint256 supply, uint256 sharesMinted, uint256 sharesBurned, uint256 performanceFee)",
  "event DepositRequested(address indexed account, uint256 usdgAmount, uint256 stockAmount, uint64 indexed epochId)",
  "event DepositedNow(address indexed account, uint256 usdgAmount, uint256 shares, uint64 indexed epochId)",
];

/**
 * A House vault's LimitsSet: MakerVault's shape (HouseVault.Limits), so the same topic, which is why it is read
 * from the registry's House vaults only. HouseVault emits it from its constructor, setLimits (TREASURY_ADMIN) and
 * tightenLimits (GUARDIAN, zero delay); the log does not say which, so applyHouseLimits compares it with the last one.
 */
const HOUSE_VAULT_LIMITS_SIGNATURE =
  "event LimitsSet((uint64 maxSeriesUnits, uint128 maxTotalNotional, uint16 askToleranceBps, uint16 maxBidBpsOfSpot, uint32 maxOrderLifetime, uint128 maxDailyOutflow) limits)";
/** What the scan reads from a House vault: the pin paths and its limits. */
export const HOUSE_VAULT_SCAN_SIGNATURES = [...HOUSE_VAULT_PIN_SIGNATURES, HOUSE_VAULT_LIMITS_SIGNATURE];
/** HouseVault.Limits, field by field. */
export const HOUSE_LIMIT_FIELDS = ["maxSeriesUnits", "maxTotalNotional", "askToleranceBps", "maxBidBpsOfSpot", "maxOrderLifetime", "maxDailyOutflow"];

/**
 * Which way a House vault's limits moved, by HouseVault.tightenLimits' own rule (the deployed contracts,
 * HouseVault.sol tightenLimits): "tighten" when every field is equal or stricter, a change tightenLimits (GUARDIAN)
 * could make; "loosen" when any is looser, which only setLimits (TREASURY_ADMIN) can. Stricter is a lower or equal
 * maxSeriesUnits, maxTotalNotional, askToleranceBps, maxBidBpsOfSpot and maxDailyOutflow, and a shorter
 * maxOrderLifetime, where 0 (no bound) is the loosest. null when `prev` is unknown.
 */
export function houseLimitsDirection(prev, next) {
  if (prev === null || prev === undefined) return null;
  const v = (o, k) => BigInt(o[k]);
  for (const k of ["maxSeriesUnits", "maxTotalNotional", "askToleranceBps", "maxBidBpsOfSpot", "maxDailyOutflow"]) if (v(next, k) > v(prev, k)) return "loosen";
  const was = v(prev, "maxOrderLifetime");
  const life = v(next, "maxOrderLifetime");
  if (was !== 0n && (life === 0n || life > was)) return "loosen";
  return "tighten";
}

/**
 * House vault LimitsSet logs, in chain order, against the limits last seen for each vault
 * (`scan.houseLimits`: lowercase vault -> { limits: field -> decimal string, at: "<block>:<logIndex>", or "<block>:*"
 * for a baseline read at that head }). Returns each as a HouseLimitsSet config event carrying `direction` (tighten |
 * loosen | null = nothing earlier known) and `previous`. The scan re-reads its last REORG_OVERLAP blocks: a log at or
 * before the vault's `at` was applied already and is skipped, so a replay neither pages twice nor compares a change
 * with itself.
 */
export function applyHouseLimits(scan, logs) {
  scan.houseLimits ??= {};
  const pos = (l) => [BigInt(l.blockNumber), BigInt(l.logIndex)];
  const before = (a, b) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const sorted = logs.filter((l) => l.eventName === "LimitsSet" && l.args?.limits?.maxDailyOutflow !== undefined).sort((a, b) => (before(pos(a), pos(b)) ? -1 : before(pos(b), pos(a)) ? 1 : 0));
  const out = [];
  for (const l of sorted) {
    const vault = lc(l.address);
    const seen = scan.houseLimits[vault];
    if (seen?.at) {
      const [block, index] = seen.at.split(":");
      const [lb, li] = pos(l);
      if (lb < BigInt(block) || (lb === BigInt(block) && (index === "*" || li <= BigInt(index)))) continue;
    }
    const next = Object.fromEntries(HOUSE_LIMIT_FIELDS.map((k) => [k, String(l.args.limits[k])]));
    const previous = seen?.limits ?? null;
    out.push({ ...l, eventName: "HouseLimitsSet", direction: houseLimitsDirection(previous, next), previous });
    scan.houseLimits[vault] = { limits: next, at: `${l.blockNumber}:${l.logIndex}` };
  }
  return out;
}

/** A vault on `houses` whose address and underlying() both match. The list is the registry or --house, never a name. */
function registeredHouse(houses, address, underlying) {
  if (!houses || underlying === undefined || underlying === null) return null;
  for (const h of houses) {
    if (h && sameAddress(h.address, address) && sameAddress(h.underlying, underlying)) return h;
  }
  return null;
}

/**
 * True when this oracle pin is a registered House vault's own boundary.
 * Same-transaction roll/deposit matches underlying only (EpochRolled records the closed boundary, and
 * pinBoundary freezes the next one). pinnedBoundary() matches the expiry itself, and 0 means unset.
 */
function houseVouchesOraclePin(pin, houseLogs, ctx) {
  const underlying = pin.args?.underlying;
  const expiry = Number(pin.args?.expiry);
  for (const h of houseLogs) {
    if (!HOUSE_VAULT_PIN_EVENTS.has(h.eventName)) continue;
    if (registeredHouse(ctx.houses, h.address, underlying)) return true;
  }
  if (!(expiry > 0)) return false;
  for (const h of ctx.houses ?? []) {
    if (!sameAddress(h.underlying, underlying)) continue;
    if (h.pinnedBoundary !== undefined && h.pinnedBoundary !== null && Number(h.pinnedBoundary) === expiry) return true;
  }
  return false;
}

/** What a source pin log fixed, for the pre-pin page. */
function pinArgs(l) {
  const a = l.args;
  if (l.eventName === "PoolPinned") return `pool ${a.pool}, floor ${a.minLiquidity}`;
  if (l.eventName === "FeedPinned") return `feed ${a.feed}, ${a.maxStale} s, ${a.maxRoundJumpBps} bps`;
  if (l.eventName === "BandPinned") return `band ${usdg(a.minPrice)}-${usdg(a.maxPrice)} USDG`;
  return `feedId ${a.feedId}, version ${a.version}`;
}

export function prePinFindings(logs, adoptUntil, ctx) {
  const byTx = new Map();
  const houseByTx = new Map();
  for (const l of logs) {
    if (HOUSE_VAULT_PIN_EVENTS.has(l.eventName)) {
      const tx = lc(l.transactionHash);
      if (!houseByTx.has(tx)) houseByTx.set(tx, []);
      houseByTx.get(tx).push(l);
    }
    if (!PIN_EVENTS.has(l.eventName)) continue;
    const tx = lc(l.transactionHash);
    if (!byTx.has(tx)) byTx.set(tx, []);
    byTx.get(tx).push(l);
  }
  const ue = (l) => `${lc(l.args.underlying)}:${Number(l.args.expiry)}`;
  const out = [];
  for (const group of byTx.values()) {
    const fromClearinghouse = group.filter((l) => (l.eventName === "SeriesCreated" || l.eventName === "Minted") && sameAddress(l.address, ctx.clearinghouse));
    const series = new Set(fromClearinghouse.filter((l) => l.eventName === "SeriesCreated").map(ue));
    for (const l of fromClearinghouse) if (l.eventName === "Minted" && l.series) series.add(`${lc(l.series.u)}:${Number(l.series.e)}`);
    const unknownMint = fromClearinghouse.some((l) => l.eventName === "Minted" && !l.series);
    const pinned = new Set(group.filter((l) => l.eventName === "SettlementConfigPinned" && sameAddress(l.address, ctx.settlementOracle)).map(ue));
    for (const l of group) {
      if (l.eventName === "SeriesCreated" || l.eventName === "Minted") continue;
      if (adoptUntil !== null && BigInt(l.blockNumber) <= BigInt(adoptUntil)) continue;
      const k = ue(l);
      const oraclePin = l.eventName === "SettlementConfigPinned";
      if (unknownMint || series.has(k) || (!oraclePin && pinned.has(k))) continue;
      if (oraclePin && houseVouchesOraclePin(l, houseByTx.get(lc(l.transactionHash)) ?? [], ctx)) continue;
      const a = l.args;
      const expiry = Number(a.expiry);
      const ticker = ctx.markets.find((m) => sameAddress(m.asset, a.underlying))?.ticker ?? shortAddr(a.underlying);
      const name = ctx.names[lc(l.address)] ?? l.address;
      const what = oraclePin
        ? `${name}.SettlementConfigPinned(sources [${a.sources.map((s) => ctx.names[lc(s)] ?? s).join(", ")}], ${a.maxDeviationBps} bps, ${a.uncorroboratedDelay} s) without the Clearinghouse's Minted or SeriesCreated of the expiry: pinned through a moved clearinghouse pointer; pinnedBy is not the Clearinghouse`
        : `${name}.${l.eventName === "DataStreamsFeedPinned" ? "FeedPinned" : l.eventName}(${pinArgs(l)}) without the oracle's SettlementConfigPinned or the Clearinghouse's Minted or SeriesCreated: pinned through the source's oracle allow-list`;
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
    ? `${x.ticker}: nothing can be minted on any expiry nobody has pinned yet (tried ${iso(x.expiry)}): mint pins the expiry first and SettlementOracle.pin from the Clearinghouse reverts ${why}`
    : `${x.ticker} expiry ${iso(x.expiry)}: nothing of this expiry can be minted: mint pins the expiry first and SettlementOracle.pin from the Clearinghouse reverts ${why}`;
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
  // pinBoundary sets pinnedBy to the House vault. Quiet only while that expiry has no series,
  // and only when the pinner is a registry/--house vault whose underlying() is this market.
  if (!x.hasSeries && registeredHouse(x.houses, x.pinnedBy, x.underlying)) return [];
  const tail = x.hasSeries
    ? "the expiry has series: someone pointed the oracle's clearinghouse elsewhere and pinned through it (the price cannot change, but its next mint must confirm the pin and reverts PinMismatch while the configuration differs)"
    : "the expiry has no series: a pin made outside a mint (a pre-pin); its first mint reverts PinMismatch unless the configuration then equals the pin";
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
    // The registry's (SOURCE_DEFAULTS only when it publishes none), not the compiled constant.
    maxStale: pick("chainlinkMaxStaleS") ?? SOURCE_DEFAULTS.chainlinkMaxStaleS,
    maxRoundJumpBps: pick("chainlinkMaxRoundJumpBps") ?? SOURCE_DEFAULTS.chainlinkMaxRoundJumpBps,
    pool,
    minLiquidity: m.v2?.univ3MinLiquidity ?? null,
    window: pick("univ3WindowS") ?? SOURCE_DEFAULTS.univ3WindowS,
    // { minPrice, maxPrice } (bigint), CHAINLINK_NO_BAND, or null when the registry publishes none.
    band: m.v2?.chainlinkBand ?? null,
  };
}

/**
 * An expiry with series against the registry. Returns { findings, verified } (verified: nothing differs and no source
 * whose pin can still move, the Data Streams source, is listed; a verified pin never changes again).
 *   x = { ticker, underlying, expiry, oracle (the series'), publishedOracle, expected (expectedPinnedConfig, null = not a
 *         registry market), sources: { chainlink, univ3, dataStreams } (registry addresses), names,
 *         config: { pinned, sources, maxDeviationBps, uncorroboratedDelay, spotMaxAge },
 *         chainlink: { feed, maxStale, maxRoundJumpBps, pinned, band?, currentBand? (bandOf; null = not read) } | null,
 *         univ3: { pool, minLiquidity, window, pinned } | null,
 *         dataStreams: { pinned, version, currentVersion } | null,
 *         openInterest (Clearinghouse.openInterest(u, E), bigint; undefined = not read) }
 * From INTERFACE_VERSION 6 an expiry is pinned by its first MINT, not its first series (Clearinghouse.mint,
 * "PIN ON MINT"), so an expiry on the published oracle with series, no pin and open interest 0 is one nobody has minted
 * yet: nothing settles on it and nothing is compared (`unminted`, never `verified`). Its first mint logs
 * SettlementConfigPinned, which drops the pins cache, so the next run compares it. Not pinned WITH open interest pages.
 * `notChecked` names what could not be compared (the band against an intended one the registry does not
 * publish, or a band the source did not answer). An expiry with anything not checked is never `verified`.
 */
export function checkPinnedConfig(x) {
  const diffs = [];
  const notChecked = [];
  const nameOf = (a) => x.names[lc(a)] ?? a;
  const foreign = !sameAddress(x.oracle, x.publishedOracle);
  if (!foreign && !x.config.pinned && x.openInterest !== undefined && x.openInterest !== null && BigInt(x.openInterest) === 0n) {
    return { findings: [], verified: false, notChecked: [], unminted: true };
  }
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
        // The registry publishes no band, so the pin is held to the source's CURRENT band: pin() copies
        // bands[u] and refuses a later series of the expiry unless they are still equal (ChainlinkFeedSource.pin).
        const bandDiff = bandMismatch(c.band, c.currentBand);
        if (bandDiff !== null) diffs.push(bandDiff);
        // Both against the registry's INTENDED band too, so a band wrong from the start (pinned == current,
        // both wrong) pages instead of agreeing with itself.
        const intended = intendedBandCheck(x.expected.band, c.band, c.currentBand);
        diffs.push(...intended.diffs);
        notChecked.push(...intended.notChecked);
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
  if (diffs.length === 0) return { findings: [], verified: !dsListed && notChecked.length === 0, notChecked };
  return {
    verified: false,
    notChecked,
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

/** A `bands` / `pinnedBands` read as { minPrice, maxPrice }, or null when it failed (a v8 source has neither view). */
export function bandOf(r) {
  if (r === undefined || r === null || !r.ok) return null;
  const [minPrice, maxPrice] = r.value;
  return { minPrice: BigInt(minPrice), maxPrice: BigInt(maxPrice) };
}

const bandText = (b) => (b.maxPrice === 0n ? "no band" : `${usdg(b.minPrice)}-${usdg(b.maxPrice)} USDG`);

/**
 * The pinned band against the source's current one. Null when they agree or either was not read: a read that
 * failed is not a band that differs. When they differ the expiry settles on the pinned band, and its next series
 * reverts PinMismatch at pin() (the source's band moved after the first series of the expiry).
 */
export function bandMismatch(pinned, current) {
  if (pinned === null || pinned === undefined || current === null || current === undefined) return null;
  if (pinned.minPrice === current.minPrice && pinned.maxPrice === current.maxPrice) return null;
  return `Chainlink band pinned ${bandText(pinned)}, but the source's current band is ${bandText(current)}: the expiry settles on the pinned band and its next series reverts PinMismatch`;
}

/** `v2.chainlinkBand` from the registry: { minPrice, maxPrice } as bigints, CHAINLINK_NO_BAND, or null. */
export const CHAINLINK_NO_BAND = "none";
export function parseChainlinkBand(v, where) {
  if (v === undefined || v === null) return null;
  if (v === CHAINLINK_NO_BAND) return CHAINLINK_NO_BAND;
  const min = v !== null && typeof v === "object" ? bigOrNull(v.minPrice, `${where}.minPrice`) : null;
  const max = v !== null && typeof v === "object" ? bigOrNull(v.maxPrice, `${where}.maxPrice`) : null;
  if (min === null || max === null || min <= 0n || max <= min) {
    throw new UsageError(`registry ${where}: ${JSON.stringify(v)} is neither "${CHAINLINK_NO_BAND}" nor a band { minPrice, maxPrice } with 0 < minPrice < maxPrice`);
  }
  return { minPrice: min, maxPrice: max };
}

/**
 * The pinned band and the source's current band, each against the registry's intended one. A band that
 * differs is a difference. When the registry gives nothing to compare with (it marks the market "no band", or
 * publishes no v2.chainlinkBand), the band is NOT CHECKED, never a pass. A band READ that failed compares nothing, the
 * rule {@link bandMismatch} follows: a v8 source has no band views, and an unread value is not a band that differs.
 */
export function intendedBandCheck(intended, pinned, current) {
  if (intended === CHAINLINK_NO_BAND) {
    return { diffs: [], notChecked: [`Chainlink band NOT CHECKED: the registry marks this market "no band" (v2.chainlinkBand "${CHAINLINK_NO_BAND}"), so there is no intended band to hold the pin to`] };
  }
  if (intended === null || intended === undefined) {
    return { diffs: [], notChecked: ["Chainlink band NOT CHECKED: the registry publishes no v2.chainlinkBand for this market"] };
  }
  const diffs = [];
  const notChecked = [];
  for (const [label, b] of [["pinned band", pinned], ["current band", current]]) {
    if (b === null || b === undefined) continue;
    if (b.minPrice !== intended.minPrice || b.maxPrice !== intended.maxPrice) {
      diffs.push(`Chainlink ${label} is ${bandText(b)}, but the registry's intended band is ${bandText(intended)} (v2.chainlinkBand)`);
    }
  }
  return { diffs, notChecked };
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
 *   new         first sighting of an event; a condition once it has stayed open graceS
 *   retry       seen before, never delivered (an event is retried from memory even when not re-found)
 *   escalated   severity rose above what was delivered
 *   reminder    an open condition, repeatS after its last delivery (repeatS 0: never)
 * what resolved: a remembered CONDITION whose owning check completed this run without finding
 * it again. It is forgotten; it is reported as resolved when a warn or error was delivered for it. A
 * condition whose check did not complete stays open (a failed read never clears an alert). Events
 * never resolve; they are forgotten eventRetentionS after first sight.
 * And what is `held`: a CONDITION first seen less than graceS ago is remembered with `held: true` and
 * not sent. `held` is not `delivered: false`: a held entry never takes the "retry" path, and it leaves `held` only
 * by being sent as "new" once nowS - firstSeen >= graceS. If its check completes without it first, it is forgotten
 * like any condition, and as nothing was delivered for it, nothing resolves. A held condition whose check did not
 * complete stays held. Each held entry is returned with `remainingS`, the grace still to run (0 once it has passed
 * and the condition waits to be found again). graceS omitted is 0: page on first sight, the earlier rule,
 * so a caller that forgets it pages rather than holds. runOnce passes the alertGraceS threshold (default 30).
 */
export function reconcile(alerts, findings, { completed, nowS, repeatS = DEFAULTS.repeatS, eventRetentionS = DEFAULTS.eventRetentionS, graceS = 0 }) {
  const send = [];
  const resolved = [];
  const held = [];
  const seen = new Set();
  const hold = (id, e) => held.push({ id, kind: e.kind, check: e.check, severity: e.severity, openS: nowS - e.firstSeen, remainingS: Math.max(0, e.firstSeen + graceS - nowS) });
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
      if (!f.event && graceS > 0) {
        alerts[id].held = true;
        hold(id, alerts[id]);
      } else {
        send.push({ id, finding: f, reason: "new" });
      }
      continue;
    }
    e.lastSeen = nowS;
    e.message = f.message;
    e.severity = f.severity;
    e.check = f.check;
    if (e.held === true) {
      // Waiting out its grace: never "retry" (nothing was attempted). It pages as "new" once the grace has passed.
      if (nowS - e.firstSeen >= graceS) {
        delete e.held;
        send.push({ id, finding: f, reason: "new" });
      } else {
        hold(id, e);
      }
      continue;
    }
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
    if (!completed.has(e.check)) {
      if (e.held === true) hold(id, e);
      continue;
    }
    delete alerts[id];
    if (e.delivered && RANK[e.sentSeverity ?? "info"] >= RANK.warn) resolved.push({ id, entry: e });
  }
  return { send, resolved, held };
}

/**
 * How long the --interval loop sleeps after a pass: --interval, less the time the pass took, but no later
 * than the end of the soonest grace still running (plus a second, as the dedupe clock is whole seconds), so a held
 * condition pages about graceS after it opened rather than at the next --interval. `held` is reconcile()'s list,
 * whose remainingS was measured at the pass's start. A held entry whose grace has already passed (its check did not
 * complete, so it could not be found again) does not shorten the sleep: a failing check is not re-run every second.
 * At least a second, as before.
 */
export function nextPassDelayMs({ intervalS, elapsedMs, held = [] }) {
  let targetMs = intervalS * 1000;
  for (const h of held) if (h.remainingS > 0) targetMs = Math.min(targetMs, (h.remainingS + 1) * 1000);
  return Math.max(1000, targetMs - elapsedMs);
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
  // INTERFACE_VERSION 8 keeps this key and points it at the PayoutRouter. See PAYOUT_ROUTES_ABI.
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
 * INTERFACE_VERSION 8: `markets[].v2.payoutRoute` is null (no route: winning calls are paid in
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
    // The per-market source tuning, what a pin's Chainlink and pool legs are held to.
    chainlinkMaxStaleS: intOrNull(o?.chainlinkMaxStaleS, `${where}.chainlinkMaxStaleS`),
    chainlinkMaxRoundJumpBps: intOrNull(o?.chainlinkMaxRoundJumpBps, `${where}.chainlinkMaxRoundJumpBps`),
    univ3WindowS: intOrNull(o?.univ3WindowS, `${where}.univ3WindowS`),
  });
  const d = settlementParams(v2?.defaults, "v2.defaults");
  const defaults = Object.fromEntries(Object.entries(d).map(([k, v]) => [k, v ?? ORACLE_DEFAULTS[k] ?? SOURCE_DEFAULTS[k]]));
  // INTERFACE_VERSION 7: the shared writer-rent rate, the fallback for a market without one of its own.
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
              // The intended Chainlink band (build-markets V2_INTENDED_CHAINLINK_BANDS), "none", or null (unpublished).
              chainlinkBand: parseChainlinkBand(m.v2.chainlinkBand, `${where}.v2.chainlinkBand`),
              overrides: settlementParams(m.v2.overrides, `${where}.v2.overrides`),
              // Daily closes listed (overrides.expiriesAhead.daily, else v2.defaults; null = unknown, never 0)
              // and the weekdays they list on (overrides.dailyWeekdays, else v2.defaults; null = unknown, never a restriction).
              dailyExpiriesAhead: intOrNull(m.v2.overrides?.expiriesAhead?.daily ?? v2?.defaults?.expiriesAhead?.daily,
                `${where}.v2.overrides.expiriesAhead.daily`),
              dailyWeekdays: weekdayListOrNull(m.v2.overrides?.dailyWeekdays ?? v2?.defaults?.dailyWeekdays,
                `${where}.v2.overrides.dailyWeekdays`),
              // SPCX lists no dailies and NVDA lists Mon/Wed/Fri: their daily House vaults cross boundaries with no series.
              // The market's House vaults by kind: the kind each vault must report in weekly().
              house: {
                weekly: addrOrNull(m.v2.house?.weekly, `${where}.v2.house.weekly`),
                daily: addrOrNull(m.v2.house?.daily, `${where}.v2.house.daily`),
              },
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
    // The EarnVault, watched for the logs EARN_VAULT_EVENTS names.
    earnVault: addrOrNull(v2?.contracts?.earnVault, "v2.contracts.earnVault"),
    // Manager targets that are not scan addresses: read only for getTargetFunctionRole (managerTargets).
    managerTargets: {
      houseVaultFactory: addrOrNull(v2?.contracts?.houseVaultFactory, "v2.contracts.houseVaultFactory"),
      hedger: addrOrNull(v2?.contracts?.hedger, "v2.contracts.hedger"),
      rewardsDistributorLender: addrOrNull(v2?.contracts?.rewardsDistributorLender, "v2.contracts.rewardsDistributorLender"),
      stockVenueAdapter: addrOrNull(v2?.contracts?.stockVenueAdapter, "v2.contracts.stockVenueAdapter"),
    },
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

/**
 * The House vaults the registry records, for a monitor given no --house / MONITOR_HOUSE_VAULTS: each
 * market's `v2.house.daily`, then `v2.house.weekly`, each address once, as --house entries. The launch writes each
 * vault back into its market row as it creates it (ops/v2/go-live-gating.mjs monitorHouseVaults reads the
 * same slots), so "the registry cannot name factory-created vaults" stopped being true.
 */
export function registryHouseVaults(reg) {
  const out = [];
  const seen = new Set();
  for (const m of reg?.markets ?? []) {
    for (const address of [m.v2?.house?.daily, m.v2?.house?.weekly]) {
      if (address === null || address === undefined || sameAddress(address, ZERO) || seen.has(lc(address))) continue;
      seen.add(lc(address));
      out.push({ ticker: m.ticker.toUpperCase(), address });
    }
  }
  return out;
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
       [--repeat-hours H] [--alert-grace-seconds S] [--max-failed-passes N] [--no-alerts] [--json]
see the header of ops/v2/monitor.mjs; exit 0 clean, 1 findings open, 2 usage, 3 incomplete, 4 delivery failed
in --interval mode the process exits after --max-failed-passes consecutive passes that reached nobody (default 3, 0 = never)`;

export function parseArgs(argv, env = {}) {
  const thresholds = { ...DEFAULTS };
  const divergenceBands = {};
  if (env.MONITOR_DIVERGENCE_BANDS) for (const [ticker, bps] of parseNamedList(env.MONITOR_DIVERGENCE_BANDS, "MONITOR_DIVERGENCE_BANDS")) addDivergenceBand(divergenceBands, ticker, bps);
  if (env.MONITOR_THRESHOLDS) for (const [k, v] of parseNamedList(env.MONITOR_THRESHOLDS, "MONITOR_THRESHOLDS")) applyThreshold(thresholds, k, v);
  if (env.MONITOR_REPEAT_S) applyThreshold(thresholds, "repeatS", env.MONITOR_REPEAT_S);
  if (env.MONITOR_ALERT_GRACE_S) applyThreshold(thresholds, "alertGraceS", env.MONITOR_ALERT_GRACE_S);
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
    // The launch tokens whose OraclePaused()/OracleUnpaused() logs page v2_mon_oracle_halted. Tickers,
    // resolved against the registry at run time; never addresses.
    launch: (env.MONITOR_LAUNCH_TICKERS ?? "NVDA,SPCX").split(",").map((s) => s.trim()).filter(Boolean),
    allMarkets: false,
    dryRun: false,
    json: false,
    // Always-on mode only: consecutive passes that reached nobody (a refused delivery, or a pass that threw)
    // before the process gives up and exits with that pass's code, so the platform restarts it and notifies.
    // Nothing else watches the monitor. 0 disables it.
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
      case "--alert-grace-seconds":
        applyThreshold(thresholds, "alertGraceS", value(i, a));
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
    // { block, at } of the first run that read every delayed manager lane at its manifest delay (the lock).
    managerLock: null,
    // The AccessManager's RoleGranted / RoleRevoked walk from the deploy block (applyManagerMembership).
    managerMembers: { cursor: null, members: {}, firstAdmin: null },
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
      // "<underlying>:<expiry>" -> { n, units } of winning calls paid in stock to holders who prefer USDG, and
      // the holders whose PayoutPrefsSet chose stock (lower-case address -> 1).
      inKind: {},
      inKindPrefs: {},
      // Lowercase House vault -> { limits, at }, the limits its last LimitsSet (or a baseline read) set.
      houseLimits: {},
    },
    tokens: { cursor: null, haltCursor: null, oracleHalts: {} },
    // The last provider / method / legacy-source label per market (so a switch between two polls is an
    // event, not a silence), and the pricer's last CHANGED evaluation counters with the wall second it changed.
    pricing: { sources: {}, pricer: null },
    feeds: {},
    divergenceStreaks: {},
    safes: {},
    // Chain halts seen at a run, [{ from, to, block }] (noteOutage), for v2_mon_guardian_veto_due.
    outages: [],
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

/** Where state goes while `file` cannot be written. Named for the path it stands in for, so two monitors on one host never share a fallback file. */
export function fallbackStatePath(file) {
  return path.join(tmpdir(), `monitor-fallback-${createHash("sha256").update(file).digest("hex").slice(0, 12)}.json`);
}

/**
 * Of `files`, the one holding the LATEST state for this chain and deployment (`lastRun.at`), so a run
 * reads its memory from wherever the last run left it: the configured path, or the temp-directory fallback a run
 * wrote while the configured path could not be written. A missing, unreadable or foreign file (another chain,
 * deployment or version, which loadState would discard) does not count. A tie, or nothing usable, is `files[0]`.
 */
export function newerState(files, chainId, fingerprint) {
  let best = files[0];
  let bestAt = -Infinity;
  for (const file of files) {
    let at = -Infinity;
    try {
      const s = JSON.parse(readFileSync(file, "utf8"));
      if (s.version === STATE_VERSION && s.chainId === chainId && s.fingerprint === fingerprint) at = Number(s.lastRun?.at ?? -Infinity);
    } catch {
      // missing or unreadable: not a candidate
    }
    if (at > bestAt) {
      best = file;
      bestAt = at;
    }
  }
  return best;
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
    "function totalSupply(uint256 id) view returns (uint256)",
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
    // What record() would store for [start, end], with the window's harmonic-mean liquidity (never reverts).
    "function observeWindow(address underlying, uint40 start, uint40 end) view returns (bool ok, uint256 price, int24 meanTick, uint256 harmonicLiquidity)",
    "function pinnedPools(address underlying, uint40 expiry) view returns (address pool, bool usdgIsToken0, uint8 assetDecimals, uint32 window, bool pinned, uint128 minLiquidity)",

    // The snapshot record() stored for (underlying, end); not ok before it is recorded.
    "function windowPrice(address underlying, uint40 start, uint40 end) view returns (bool ok, uint256 price)",
  ],
  chainlinkSource: [
    "function latest(address underlying) view returns (bool ok, uint256 price, uint256 updatedAt)",
    "function feeds(address underlying) view returns (address feed, uint32 maxStale, uint16 maxRoundJumpBps)",
    "function pinnedFeeds(address underlying, uint40 expiry) view returns (address feed, uint32 maxStale, uint16 maxRoundJumpBps, bool pinned)",
    // The plausibility band and its per-expiry pin; all zero means no band. A v8 source has neither view.
    "function bands(address underlying) view returns (uint128 minPrice, uint128 maxPrice)",
    "function pinnedBands(address underlying, uint40 expiry) view returns (uint128 minPrice, uint128 maxPrice)",

    // The step TWAP of the rounds in force over [start, end]; not ok while end is ahead of the block.
    "function windowPrice(address underlying, uint40 start, uint40 end) view returns (bool ok, uint256 price)",
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
    // A maker's just-in-time funding: allowed by CONFIG_ADMIN, and switched on by the maker.
    "function fundingOf(address maker) view returns (bool allowed, bool on)",
  ],
  // maxBounty() arrived with v9: reward() pays min(bounty, maxBounty). An older KeeperRewards has none.
  keeperRewards: ["function bounty(bytes32 action) view returns (uint256)", "function dailyCap() view returns (uint256)", "function spentToday() view returns (uint256)", "function maxBounty() view returns (uint256)"],
  autoRoller: ["function position(address writer, address underlying) view returns (uint256 longId, uint256 orderId, uint40 expiry)"],
  // The House vaults are FACTORY-CREATED AND PER-MARKET: passed in with --house, or else read from the registry's
  // markets[].v2.house, which the launch writes back as it creates each one (registryHouseVaults).
  houseVault: [
    "function epochEnd() view returns (uint40)",
    "function epochId() view returns (uint64)",
    "function underlying() view returns (address)",
    // The boundary pinBoundary last froze. 0 means none. Older vaults have no such view.
    "function pinnedBoundary() view returns (uint40)",
    "function oracle() view returns (address)",
    "function trackedSeries() view returns (uint256[])",
    "function exposure(uint256 longId) view returns (uint256 units, uint256 notional, (uint256 longs, uint256 shorts, uint256 bids, uint256 resale, uint256 writes, uint256 live) detail)",
    // Older vaults may have no weekly(), and older ones still no performanceFeeOwed().
    "function weekly() view returns (bool)",
    "function performanceFeeOwed() view returns (uint256)",
    // Whether money is exposed to the running boundary. pinnedBoundary() is declared above.
    "function totalSupply() view returns (uint256)",
    "function pendingDepositUsdg() view returns (uint256)",
    "function pendingDepositStock() view returns (uint256)",
    // The baseline applyHouseLimits compares a vault's first LimitsSet with.
    "function limits() view returns ((uint64 maxSeriesUnits, uint128 maxTotalNotional, uint16 askToleranceBps, uint16 maxBidBpsOfSpot, uint32 maxOrderLifetime, uint128 maxDailyOutflow))",
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
  // The EarnVault's venue adapter and what it can pay out now (earnPullFindings).
  // fundingEnabled(), the vault's own just-in-time funding switch, and skimBps() (earnSkimRefusedFindings).
  earnVault: [
    "function adapter() view returns (address)",
    "function fundingEnabled() view returns (bool)",
    "function skimBps() view returns (uint16)",
    // The probe checkEarnVenue reads, and the two refusals it tells apart by name.
    "function convertToAssets(uint256 shares) view returns (uint256)",
    "error VenueUnreadable()",
    "error PositionOpen()",
  ],
  earnAdapter: ["function withdrawable() view returns (uint256)"],
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
    // The least time between two buybacks, ADMIN-settable.
    "function buybackCooldown() view returns (uint40)",
  ],
  // V4BuybackExecutor: the one PoolKey it may trade (ops/abis/v2/V4BuybackExecutor.json).
  buybackExecutor: [
    "function key() view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks))",
    // The fee read buy() guards with, and the combined cap it enforces (V4BuybackExecutor.sol:566-576).
    "function feeBps() view returns (uint16 v3, uint16 v4Lp, uint16 v4Protocol, uint16 hook, uint16 creatorTax, uint256 total)",
    "function maxTotalFeeBps() view returns (uint16)",
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
  // A winning call paid in stock to a holder who prefers USDG (inKindPayoutFindings).
  "event Redeemed(uint256 indexed tokenId, address indexed holder, address to, uint64 units, address asset, uint256 amount, uint256 amountInKind, bool toLedger)",
  "event PayoutPrefsSet(address indexed account, bool inKind, bool toLedger)",
  // EarnVault's venue pulls. applyScanLogs drops every EarnVault log not named in EARN_VAULT_EVENTS.
  "event PulledFromVenue(uint256 requested, uint256 withdrawn)",
  // EarnVault.skim / the deposit's pre-mint skim. gain > 0 and fee == 0 is a fee not taken.
  "event Skimmed(uint256 gain, uint256 fee, uint256 highWaterMark)",
  // EarnVault.setAdapter wrote an unreadable venue's last known value off totalAssets (earnWriteOffFindings).
  "event VenueWrittenOff(address indexed adapter, uint256 lastKnown)",
  // EarnVault.setAdapter and setSkimBps (TREASURY_ADMIN), paged through CONFIG_EVENTS.
  "event AdapterSet(address indexed adapter)",
  "event SkimBpsSet(uint16 bps)",
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
  "event MaxBountySet(uint256 amount)",
  "event Defunded(address indexed to, uint256 amount)",
  "event MinRollUnitsSet(uint256 units)",
  "event LimitsSet((uint64 maxSeriesUnits, uint128 maxTotalNotional, uint16 askToleranceBps, uint16 maxBidBpsOfSpot, uint32 maxOrderLifetime, uint128 maxDailyOutflow) limits)",
  // EarnVault's own LimitsSet shares its name with MakerVault's and carries five other fields;
  // scanEventName renames it EarnLimitsSet.
  "event LimitsSet((uint64 maxSeriesUnits, uint128 maxOrderNotional, uint64 maxWrittenUnitsPerSeries, uint128 maxWrittenNotional, uint128 maxDailyOutflow) limits)",
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
  // INTERFACE_VERSION 7. Minted / Closed / MintFeesAccrued are the whole rent ledger; Rolled, StaleAskCancelled
  // and StrategyStopped are how the monitor learns which (writer, market) pairs the AutoRoller has a position for
  // None of them costs an extra eth_getLogs: the scan already fetches every log of these addresses.
  "event Minted(uint256 indexed longId, address indexed writer, address indexed longTo, uint64 units, uint256 collateral, uint256 fee)",
  "event Closed(uint256 indexed longId, address indexed account, uint64 units, uint256 collateralFreed, uint256 feeRefund)",
  "event MintFeesAccrued(uint256 indexed longId, address indexed asset, uint256 amount)",
  "event Rolled(address indexed writer, address indexed underlying, uint256 longId, uint256 orderId, uint128 strike, uint40 expiry, uint128 price, uint64 units)",
  // The PRICER lane replaced the writer's ask (ops/abis/v2/AutoRoller.json).
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
  // refreshRouteFee (cached bps only) and a failed USDG payout credited to owed.
  "event RouteFeeRefreshed(address indexed asset, uint16 previousFeeBps, uint16 feeBps)",
  "event OwedCredited(address indexed account, uint256 amount)",
  // Scanned, not paged. checkPinnedBy reads pinnedBy() at the head; a confirm is the designed second-Clearinghouse path.
  "event SettlementPinConfirmed(address indexed underlying, uint40 indexed expiry, address indexed previousPinner, address pinner)",
  // INTERFACE_VERSION 8, FeeSplitter. A burn is only ever claimed from Burned; nothing is inferred from a balance.
  "event Distributed(address indexed asset, uint256 assetIn, uint256 usdgIn, uint256 treasuryOut, uint256 buybackAdded)",
  "event DistributionSkipped(address indexed asset, bytes32 reason)",
  "event BoughtBack(uint256 usdgIn, uint256 tokenOut)",
  "event Burned(uint256 amount)",
  "event BuybackSkipped(bytes32 reason)",
  // The buyback counter written down to the USDG the splitter holds. Paged as a CONFIG_EVENTS error.
  "event BuybackBalanceWrittenDown(uint256 previous, uint256 current)",
  // The rest of ops/abis/v2/FeeSplitter.json: its admin events, the stranded-fees record, and the
  // AccessManaged authority swap (which every v8 contract emits, not only the splitter). Their severities are in
  // CONFIG_EVENTS; monitor.test.mjs derives the splitter's event set from the ABI and checks each is here.
  "event OrderBookSet(address indexed orderBook)",
  "event OrderBookFeesStranded(address indexed orderBook, uint256 amount)",
  "event RouterSet(address indexed router)",
  "event BuybackExecutorSet(address indexed executor)",
  "event SettlementOracleSet(address indexed oracle)",
  "event StonkhouseSet(address indexed token)",
  "event BurnBpsSet(uint16 burnBps)",
  "event BuybackCapSet(uint256 perCallUsdg)",
  "event BuybackCapCeilingSet(uint256 ceiling)",
  "event BuybackCooldownSet(uint40 cooldown)",
  "event ConversionSlippageBpsSet(uint16 bps)",
  "event PausedSet(bool paused)",
  "event UnroutedAssetRecovered(address indexed asset, address indexed treasury, uint256 amount)",
  "event AuthorityUpdated(address authority)",
  // INTERFACE_VERSION 8, Clearinghouse / OrderBook admin events that did not exist in v7. An admin event the scan
  // does not decode is an admin event CONFIG_EVENTS can never page. Every signature here was taken from
  // ops/abis/v2/*.json, not from a design document: setMarketFees / setMarketListing / setMarketOracle have NO
  // events of their own — they re-emit MarketConfigSet, which is already scanned.
  "event MinterSet(address indexed minter, bool allowed)",
  "event DefaultMarketFeesSet(uint16 exerciseFeeBps, uint32 mintFeePpm)",
  "event DefaultOracleSet(address indexed oracle)",
  "event DiscountModuleSet(address indexed module)",
  "event FundingAllowedSet(address indexed maker, bool allowed)",
  // The two just-in-time funding switches (FundingAllowedSet above is the allow-list): EarnVault's own, and
  // an allowed maker's at the OrderBook. Both page when true (jitFundingEventFindings).
  "event FundingEnabledSet(bool on)",
  "event FundingSet(address indexed maker, bool on)",
  "event TreasurySet(address indexed treasury)",
  "event FeesSwept(address indexed asset, address indexed to, uint256 amount)",
  "event MarketSourcesSet(address indexed underlying)",
  // ChainlinkFeedSource's plausibility band. BandSet pages (CONFIG_EVENTS); BandPinned is a source pin
  // log like FeedPinned (pin() emits it beside FeedPinned when the underlying has a band) and goes through prePinFindings.
  "event BandSet(address indexed underlying, uint128 minPrice, uint128 maxPrice)",
  "event BandPinned(address indexed underlying, uint40 indexed expiry, uint128 minPrice, uint128 maxPrice)",
];
const TOKEN_EVENTS = [
  "event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)",
  // The issuer's halt flag, as events, from the live StockToken ABI (ops/abis/StockToken.json:55-56).
  "event OraclePaused()",
  "event OracleUnpaused()",
];
/**
 * topic0 of the two halt events, DERIVED from their signatures (viem.toEventSelector = keccak256 of the
 * canonical signature), never typed in. viem is the run's (loaded lazily, or injected by a test), hence a function.
 */
export function oracleHaltTopics(viem) {
  return { paused: viem.toEventSelector("event OraclePaused()").toLowerCase(), unpaused: viem.toEventSelector("event OracleUnpaused()").toLowerCase() };
}

/**
 * Fold a batch of Stock Token logs into the open-halt map: OraclePaused() opens `halts[token]`
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
 * One v2_mon_oracle_halted (error) per launch token whose halt is open, keyed by the token so it stays
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
  "BandSet",
  "SettlementConfigPinned",
  "FeedPinned",
  "PoolPinned",
  "DataStreamsFeedPinned",
  "BandPinned",
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
  if (log.eventName === "LimitsSet" && a.limits?.maxWrittenNotional !== undefined) return "EarnLimitsSet";
  return log.eventName;
}

/**
 * Winning long calls paid in stock to holders whose payout preference is USDG (payoutPrefs.inKind false), as
 * applyScanLogs collected them: one WARN event per expiry per run that saw new ones, keyed by the expiry's running
 * total so each batch pages once. It is the settlement-floor protection, not a loss: Clearinghouse._redeem converts a
 * call payout to USDG only when the route returns at least its value at the floor price (_floorPrice, convertPayout
 * minOut) and otherwise pays the stock at full value. Logs at or before `adopt` (before the first run) do not page.
 *   logs = [{ args: Redeemed args, series: { u, e }, total, blockNumber }], ctx = { tickerOf }
 */
export function inKindPayoutFindings(logs, adopt, ctx) {
  const fresh = (l) => adopt === null || adopt === undefined || BigInt(l.blockNumber) > BigInt(adopt);
  const byExpiry = new Map();
  for (const l of logs) {
    if (l.eventName !== "Redeemed" || !fresh(l)) continue;
    const k = `${lc(l.series.u)}:${l.series.e}`;
    const g = byExpiry.get(k) ?? { u: l.series.u, e: l.series.e, n: 0, units: 0n, total: 0 };
    g.n += 1;
    g.units += BigInt(l.args.units);
    g.total = Math.max(g.total, l.total);
    byExpiry.set(k, g);
  }
  return [...byExpiry.entries()].map(([k, g]) => {
    const ticker = ctx.tickerOf(g.u);
    return finding(
      "v2_mon_payout_in_kind",
      `${k}:${g.total}`,
      "config",
      `${ticker} expiry ${iso(g.e)}: ${g.n} winning call redemption${g.n === 1 ? "" : "s"} (${sharesOf(g.units)} shares) paid in ${ticker} stock to holders whose payout preference is USDG (${g.total} for this expiry so far). This is the settlement-floor protection, not a loss: converting to USDG would have paid less than the payout's value at the settlement floor (Clearinghouse _floorPrice, convertPayout minOut), so the stock was paid at full value`,
      { ticker, underlying: g.u, expiry: g.e, count: g.n, units: g.units, totalForExpiry: g.total },
    );
  });
}

/**
 * EarnVault venue pulls that delivered less than they asked for (PulledFromVenue, collected by
 * applyScanLogs): one event each. A pull starved of gas REVERTS (StarvedCall), so a short pull is the
 * venue refusing or capping the withdrawal, not the caller's gas. An exit that needed it paid what the vault had and
 * queued the rest. `withdrawableNow` is the adapter's withdrawable() at the head (null = not read): a pull that got
 * nothing while the venue can now pay all of it is an error (the venue had the cash and still paid short); any other
 * short pull is a warn. Logs at or before `adopt` (before the first run) do not page.
 *   logs = PulledFromVenue logs, ctx = { vault, withdrawableNow: bigint | null }
 */
/**
 * Skimmed(gain, fee, highWaterMark) with gain > 0 and fee == 0. The fee did not leave the vault.
 * When the rate is above zero and the mark did not move, it is still owed (the vault could not raise it, or
 * the splitter could not receive it). A zero rate, and a gain smaller than one fee unit, emit the same
 * numbers and DO move the mark: the page says to check the mark against the share price.
 * The processQueue that drains the queue runs the same skim (EarnVault.sol:808), and a rate
 * lowered to 0 while the queue was open, or a fee re-measured after the mints to under a unit, reaches that drain
 * as exactly those two shapes. So a log whose rate is KNOWN does not page when the fee was nothing at that rate
 * (`_skimFeeOn(gain) = gain * skimBps / BPS == 0`): the vault moved the mark and nothing is owed. The rate is the
 * one applyScanLogs saw in force at the log (`l.skimBps`), else `ctx.skimBpsNow` (the head's, which runOnce gives only
 * while the scan has tracked no SkimBpsSet for this vault, so none came after the log); unknown pages, as before.
 * Logs at or before `adopt` do not page.
 */
export function earnSkimRefusedFindings(logs, adopt, ctx) {
  const fresh = (l) => adopt === null || adopt === undefined || BigInt(l.blockNumber) > BigInt(adopt);
  const rateAt = (l) => l.skimBps ?? ctx.skimBpsNow ?? null;
  const feeWasDue = (l) => rateAt(l) === null || (l.args.gain * BigInt(rateAt(l))) / 10_000n > 0n;
  return logs
    .filter((l) => l.eventName === "Skimmed" && fresh(l) && l.args.gain > 0n && l.args.fee === 0n && feeWasDue(l))
    .map((l) => finding(
      "v2_mon_earn_skim_refused",
      `${l.blockNumber}:${l.logIndex}`,
      "config",
      `EarnVault ${ctx.vault}: Skimmed at block ${l.blockNumber} (tx ${l.transactionHash}) saw gain ${usdg(l.args.gain)} and took no fee. When the rate is above zero and the mark did not move, that fee is still owed (the vault could not raise it, or the splitter could not receive it). A zero rate, or a gain smaller than one fee unit, emits the same log and moves the mark: compare highWaterMark() with the share price before treating this as unpaid`,
      { vault: ctx.vault, block: l.blockNumber, tx: l.transactionHash, gain: l.args.gain, fee: l.args.fee, highWaterMark: l.args.highWaterMark, skimBps: rateAt(l) },
      { severity: "warn" },
    ));
}

export function earnPullFindings(logs, adopt, ctx) {
  const fresh = (l) => adopt === null || adopt === undefined || BigInt(l.blockNumber) > BigInt(adopt);
  const w = ctx.withdrawableNow ?? null;
  return logs
    .filter((l) => l.eventName === "PulledFromVenue" && fresh(l) && l.args.withdrawn < l.args.requested)
    .map((l) => {
      const { requested, withdrawn } = l.args;
      const nothing = withdrawn === 0n;
      const now = w === null
        ? "The adapter's withdrawable() could not be read, so whether the venue can pay now is unknown"
        : `The adapter can pay ${usdg(w)} USDG now${w >= requested ? ", at least what was asked: the venue has the cash, so check why this pull came back short (the adapter, the venue's withdraw path)" : ": the venue is short of liquidity"}`;
      return finding(
        "v2_mon_earn_pull_short",
        `${l.blockNumber}:${l.logIndex}`,
        "config",
        `EarnVault ${ctx.vault}: a venue pull at block ${l.blockNumber} (tx ${l.transactionHash}) asked for ${usdg(requested)} USDG and got ${usdg(withdrawn)}. ${nothing ? "Nothing came out of the venue" : "The venue paid less than asked"}: a pull starved of gas reverts since T-OP-642, so this is the venue, not the caller's gas limit. An exit that needed it paid what the vault had and queued the rest (processQueue pays it when cash arrives). ${now}`,
        { vault: ctx.vault, block: l.blockNumber, tx: l.transactionHash, requested, withdrawn, withdrawableNow: w },
        { severity: nothing && w !== null && w >= requested ? "error" : "warn" },
      );
    });
}

/**
 * EarnVault.setAdapter could not read a venue's totalAssets() and wrote the venue's last known value off the
 * vault's totalAssets (`VenueWrittenOff(adapter, lastKnown)`, the adapter wired before the call; AdapterSet in the same
 * call names the one wired after: the SAME one when it was re-set, which keeps it wired). The vault's total value fell
 * by `lastKnown`, each share in proportion: a realised loss, one error each, a zero write-off too (a value
 * drained to zero blind is still a venue given up on). Raised by the scan, in the chunk that consumes the log and
 * advances the cursor, so a check that fails later in the same run cannot drop it. Logs at or before `adopt` do not page.
 *   logs = decoded logs (any names; only VenueWrittenOff counts), ctx = { vault }
 */
export function earnWriteOffFindings(logs, adopt, ctx) {
  const fresh = (l) => adopt === null || adopt === undefined || BigInt(l.blockNumber) > BigInt(adopt);
  return logs
    .filter((l) => l.eventName === "VenueWrittenOff" && fresh(l))
    .map((l) => finding(
      "v2_mon_earn_venue_written_off",
      `${l.blockNumber}:${l.logIndex}`,
      "scan",
      `EarnVault ${ctx.vault}: setAdapter wrote off venue ${l.args.adapter} at block ${l.blockNumber} (tx ${l.transactionHash}). Its last known value, ${usdg(l.args.lastKnown)} USDG (${l.args.lastKnown} base units), left totalAssets because the venue's totalAssets() could not be read, so the vault's total value fell by that amount and each share's value in proportion${l.args.lastKnown === 0n ? " (0 written off: the vault's last known value for the venue was already 0; it reached 0 only by subtracting what was pulled out while the venue could not be read (T-OP-900), so what the venue still holds, a gain the vault never read, is unknown and no longer counted)" : ""}. Find out whether the venue still holds the money, which adapter is wired now (AdapterSet in the same tx; the same one if it was re-set), and tell the owner. Deposits and withdrawals are priced again at the cash and ledger the vault can reach; anything later recovered from that venue accrues to whoever holds shares then. Expected only as the planned end of a v2_mon_earn_venue_unreadable page (T-OP-839); otherwise treat the TREASURY_ADMIN key as compromised`,
      { vault: ctx.vault, adapter: l.args.adapter, lastKnown: l.args.lastKnown, block: l.blockNumber, tx: l.transactionHash },
    ));
}

/**
 * The EarnVault logs applyScanLogs keeps; it drops every other log of the EarnVault's, so one that decodes as another
 * contract's scanned event (a PausedSet, say) pages nothing unless it is named here.
 *   PulledFromVenue    a short venue pull (earnPullFindings).
 *   FundingEnabledSet  its own just-in-time funding switch.
 *   EarnLimitsSet      its caps (TREASURY_ADMIN sets any values; GUARDIAN only tightens).
 *   AdapterSet, SkimBpsSet, AuthorityUpdated  its venue and skim rate (TREASURY_ADMIN) and the AccessManager
 *                      it answers to (ADMIN, AccessManager.updateAuthority). Always paged: until the one-transaction
 *                      lock-down every lane, ADMIN and TREASURY_ADMIN included, is held at delay 0 and the deploy key
 *                      holds ADMIN (the launch role profile), so no
 *                      OperationScheduled comes first and the vault's own log is the only record of the change.
 *   VenueWrittenOff    setAdapter wrote an unreadable venue's last known value off
 *                      totalAssets (earnWriteOffFindings, raised by the scan itself; not in CONFIG_EVENTS, so one page).
 */
const EARN_VAULT_EVENTS = new Set(["PulledFromVenue", "FundingEnabledSet", "EarnLimitsSet", "AdapterSet", "SkimBpsSet", "AuthorityUpdated", "Skimmed", "VenueWrittenOff"]);

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
export function applyScanLogs(scan, logs, addresses, pinLogs = null, payoutLogs = null) {
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
    // The EarnVault is scanned for EARN_VAULT_EVENTS alone.
    if (isFrom(raw, "earnVault") && !EARN_VAULT_EVENTS.has(eventName)) continue;
    // A funding event counts only from the contract that owns the switch.
    if (JIT_FUNDING_EMITTER[eventName] !== undefined && !isFrom(raw, JIT_FUNDING_EMITTER[eventName])) continue;
    const log = eventName === raw.eventName ? raw : { ...raw, eventName };
    const a = log.args ?? {};
    // The EarnVault's skim rate in force for the Skimmed logs after it (an assignment: replay-safe). Keyed by
    // the vault: the state fingerprint does not cover the EarnVault, so a replaced vault's rate must not judge the new one.
    if (eventName === "SkimBpsSet" && isFrom(log, "earnVault")) (scan.earnSkimBps ??= {})[lc(log.address)] = Number(a.bps);
    switch (eventName) {
      case "SeriesCreated":
        if (!isFrom(log, "clearinghouse")) break;
        // `p` is the rent rate pinned into the series at creation (INTERFACE_VERSION 7); it never changes again.
        scan.series[a.longId.toString()] = { u: a.underlying, e: Number(a.expiry), put: a.isPut, k: a.strike.toString(), o: a.oracle, p: Number(a.mintFeePpm) };
        if (pinLogs !== null) pinLogs.push(log);
        break;
      case "Minted": {
        if (!isFrom(log, "clearinghouse")) break;
        // The first mint of an expiry pins it (PIN ON MINT), so prePinFindings needs the mint beside the pin.
        if (pinLogs !== null) pinLogs.push({ ...log, series: scan.series[a.longId.toString()] ?? null });
        if (counted(log)) break;
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
        // `p`: the ask price the roll rested, so a later Repriced can be measured against what it replaced.
        scan.roller[rollerKey(a)] = { w: a.writer, u: a.underlying, e: Number(a.expiry), p: a.price.toString() };
        break;
      case "Repriced": {
        // Collected for repriceFindings with the price it replaced (`priceBefore`: the roll's ask or the
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
      case "BandPinned":
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
      case "PayoutPrefsSet":
        // The holders who chose stock. Everyone else prefers USDG, the Clearinghouse's default (inKind false).
        if (!isFrom(log, "clearinghouse")) break;
        scan.inKindPrefs ??= {};
        if (a.inKind) scan.inKindPrefs[lc(a.account)] = 1;
        else delete scan.inKindPrefs[lc(a.account)];
        break;
      case "Redeemed": {
        // A winning LONG CALL paid in stock to a holder who prefers USDG: Clearinghouse._redeem tried the USDG
        // conversion and it did not clear the settlement floor (or no route or floor price), so the stock was paid.
        // Tallied per expiry in scan.inKind; each new one goes to `payoutLogs` for inKindPayoutFindings.
        if (!isFrom(log, "clearinghouse") || counted(log)) break;
        const longId = a.tokenId & ~1n;
        const series = scan.series[longId.toString()];
        if (a.tokenId !== longId || series === undefined || series.put || a.amount === 0n) break;
        if (!addresses.usdg || sameAddress(a.asset, addresses.usdg) || scan.inKindPrefs?.[lc(a.holder)]) break;
        const tally = ((scan.inKind ??= {})[`${lc(series.u)}:${series.e}`] ??= { n: 0, units: "0" });
        tally.n += 1;
        tally.units = (BigInt(tally.units) + a.units).toString();
        if (payoutLogs !== null) payoutLogs.push({ ...log, series: { u: series.u, e: series.e }, total: tally.n });
        break;
      }
      case "PulledFromVenue":
        // A pull that delivered less than it asked for goes to `payoutLogs` for earnPullFindings.
        // VenuePulledForFunding is a different log: fund()'s top-up is not starvation-guarded,
        // so a short one can be the gas cap. It is not in SCAN_EVENTS and must not reach earnPullFindings.
        if (!isFrom(log, "earnVault") || counted(log) || a.withdrawn >= a.requested) break;
        if (payoutLogs !== null) payoutLogs.push(log);
        break;
      case "Skimmed":
        // A gain whose fee did not move. Flat skims (gain 0) and collected fees are not this page.
        if (!isFrom(log, "earnVault") || counted(log) || a.gain === 0n || a.fee !== 0n) break;
        if (payoutLogs !== null) payoutLogs.push({ ...log, skimBps: scan.earnSkimBps?.[lc(log.address)] ?? null });
        break;
      case "VenueWrittenOff":
        // Every write-off, a zero one too, goes to `payoutLogs`; the scan pages it from there
        // (earnWriteOffFindings) in the same chunk, before the cursor moves past it.
        if (!isFrom(log, "earnVault") || counted(log)) break;
        if (payoutLogs !== null) payoutLogs.push(log);
        break;
      case "SettlementFinalized":
      case "SettlementResolved":
        if (eventName === "SettlementResolved") configEvents.push(log);
        if (!isFrom(log, "settlementOracle")) break;
        scan.finalized[`${lc(a.underlying)}:${Number(a.expiry)}`] = log.blockNumber.toString();
        break;
      case "BandSet":
        // The pins check compares a pinned band with the CURRENT one, which this just moved, so an expiry
        // verified before it is compared again. Keys are "<oracle>:<underlying>:<expiry>".
        if (isSource(log)) {
          for (const k of Object.keys(scan.pinsVerified ?? {})) if (k.split(":")[1] === lc(a.underlying)) delete scan.pinsVerified[k];
        }
        configEvents.push(log);
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
  // A House vault's LimitsSet and its manager events name the vault.
  for (const h of registryHouseVaults(reg)) names[lc(h.address)] ??= `${h.ticker} HouseVault`;
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
  // The run READS the latest state it can find and WRITES where it can, which are not always one file.
  // Entering the fallback, the fallback is seeded from the configured file (still readable when only its directory
  // went read-only), so the conditions already paged do not page again (a v9 fork measured 8 duplicates without it).
  // Leaving it, the run reads the fallback if that is newer, because v2_mon_state_unwritable is open only there: read
  // from the configured file, it was never seen again and never resolved. The fallback is removed once the configured
  // file holds that state, so an old one cannot be read by a later run.
  let loadPath = statePath;
  let retireFallback = null;
  if (!opts.dryRun) {
    const configured = statePath;
    const alternative = fallbackStatePath(configured);
    const why = statePathUnwritable(configured);
    if (why !== null) {
      const why2 = statePathUnwritable(alternative);
      if (why2 === null) {
        stateFallback = { from: configured, to: alternative, why };
        statePath = alternative;
      } else {
        stateFallback = { from: configured, to: null, why, why2 };
      }
    } else if (existsSync(alternative)) {
      retireFallback = alternative;
    }
    loadPath = newerState(statePath === configured ? [configured, alternative] : [alternative, configured], chainId, fingerprint);
    if (loadPath !== statePath) notes.push(`state: read from ${loadPath}, the latest state found; this run writes ${statePath}`);
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
  const state = loadState(loadPath, chainId, fingerprint, notes);
  // A chain halt seen at this run (head lag above lagErrorS) is remembered, so v2_mon_guardian_veto_due
  // stays open after the chain resumes, which is exactly when the veto has to be sent.
  if (head !== null) state.outages = noteOutage(state.outages, { headTimestamp: head.timestamp, headBlock: head.number, wallNow }, t);

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
  // Registry markets outside `markets` whose Clearinghouse row could not be read (the scope step below): a
  // market registered on chain drops out of every check that walks `markets`, so those checks report incomplete while
  // this is non-empty rather than resolve its open alerts.
  let scopeUnread = [];
  const scopeNote = () => (scopeUnread.length === 0 ? "" : `; scope incomplete: ${scopeUnread.join(", ")} not read`);
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
    "divergence", "tokens", "usdg", "pools", "window",
    // INTERFACE_VERSION 8.
    "manager", "safes", "flywheel", "routes", "tokenpool", "tvl",
    // The manager's members and the feed gaps.
    "members", "feedgap",
    // Just-in-time funding.
    "funding",
    // The Earn venue.
    "earnvenue",
  ];
  const names = contractNames(reg);
  /**
   * INTERFACE_VERSION 8: selector -> { contract, signature, role } from the published role manifest, so an
   * OperationScheduled and a TargetFunctionRoleUpdated can be read as the function they are about. Built with
   * viem from the manifest's own signatures — a hand-written selector table here would be a second source of
   * truth for exactly the values two tasks already got wrong once (INTERFACE-CHANGES-V8 entry 2).
   */
  let managerSelectors = null;
  // The same index per target address, for a selector two contracts map to different roles (manifestRoleAt).
  let managerByTarget = null;
  if (ROLE_MANIFEST.manifest !== null) {
    managerSelectors = {};
    const byContract = {};
    for (const [contract, fns] of Object.entries(ROLE_MANIFEST.manifest.targets ?? {})) {
      byContract[contract] = {};
      for (const [signature, role] of Object.entries(fns)) {
        try {
          const sel = lc(viem.toFunctionSelector(`function ${signature}`));
          managerSelectors[sel] = { contract, signature, role };
          byContract[contract][sel] = { contract, signature, role };
        } catch (error) {
          notes.push(`roles: ${contract}.${signature} in ${ROLES_FILE} is not a signature viem can hash (${shortError(error)}); operations on it are named by selector only`);
        }
      }
    }
    managerByTarget = {};
    for (const tg of managerTargets(reg, ROLE_MANIFEST.manifest).targets) managerByTarget[lc(tg.address)] = byContract[tg.contract];
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
    // viem's multicall (allowFailure) answers a REJECTED aggregate3 batch (a 429, a dropped connection) with a
    // per-call failure carrying the transport error (viem 2.56.3 actions/public/multicall.js), so a failure is a revert
    // only when isRevert says so, as for a plain read. `revert: true` for every failure read a 429 as "no such view".
    return res.map((r) => (r.status === "success" ? { ok: true, value: r.result } : { ok: false, revert: isRevert(r.error), error: shortError(r.error) }));
  };
  // Registry vaults, or --house when the operator passed it (the house check's own rule).
  // underlying() is read from the vault; the --house ticker is a label and is not trusted.
  let cachedHousePins = null;
  const housePinsForVouch = async () => {
    if (cachedHousePins !== null) return cachedHousePins;
    const entries = opts.house.length === 0 ? registryHouseVaults(reg) : opts.house;
    const reads = await readMany(
      entries.flatMap((h) => [
        { address: h.address, abi: ABI.houseVault, functionName: "underlying" },
        { address: h.address, abi: ABI.houseVault, functionName: "pinnedBoundary" },
      ]),
    );
    const out = [];
    entries.forEach((h, i) => {
      const asset = reads[i * 2];
      const boundary = reads[i * 2 + 1];
      if (!asset?.ok) {
        notes.push(`house pin: ${h.ticker} ${shortAddr(h.address)} underlying() could not be read (${asset?.error ?? "unread"}); its boundary pin is not vouched`);
        return;
      }
      if (!boundary?.ok) notes.push(`house pin: ${h.ticker} pinnedBoundary() could not be read (${boundary.error}); only a roll or deposit in the same transaction vouches`);
      const pinnedBoundary = boundary?.ok && Number(boundary.value) > 0 ? Number(boundary.value) : null;
      out.push({ address: h.address, underlying: asset.value, pinnedBoundary });
    });
    cachedHousePins = out;
    return out;
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
      // EARN_VAULT_EVENTS only (applyScanLogs drops the rest of the EarnVault's logs).
      reg.earnVault,
    ].filter(Boolean);
    let configEvents = [];
    const pinLogs = [];
    const housePinLogs = [];
    const payoutLogs = [];
    // Which House vault logs are not read yet, for the House check; null once they are read to the head. It
    // starts unread: a scan that throws before the House read has not read them.
    let houseLogsUnread = "House vault logs not read yet (the log scan stopped before the House read)";
    let scanCaughtUp = true;
    let pinsDirty = false;
    await run("scan", async (out) => {
      if (C.clearinghouse === null) return { status: "skipped", detail: "no v2 contracts in the registry (pre-deploy)" };
      const s = state.scan;
      const deploy = reg.deployBlock ?? 0n;
      if (s.adoptConfigUntil === null) s.adoptConfigUntil = head.number.toString();
      let from = s.cursor === null ? deploy : BigInt(s.cursor) + 1n - REORG_OVERLAP;
      if (from < deploy) from = deploy;
      // The House read's own cursor (below): the last block it returned, as a decimal string. A state with none
      // (a fresh one, or an older one, whose House read followed this shared cursor) starts it where the
      // shared cursor stands before this run moves it; a fresh one at deploy - 1 ("nothing read"), so a House read that
      // fails on the first run starts there again. Not in emptyState, so a missing field and a fresh state are one case.
      s.houseCursor ??= s.cursor ?? (deploy - 1n).toString();
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
        // A Redeemed paid in anything else is paid in kind.
        usdg: reg.usdg,
        earnVault: reg.earnVault,
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
        const consumed = payoutLogs.length;
        configEvents.push(...applyScanLogs(s, decoded, addresses, pinLogs, payoutLogs));
        // A write-off pages here, with the chunk that consumed it and before the cursor moves past it: raised
        // in a later check, one that failed after the scan would drop it for good (run() keeps `out` on a failure).
        out.push(...earnWriteOffFindings(payoutLogs.slice(consumed), s.adoptConfigUntil, { vault: reg.earnVault }));
        s.cursor = end.toString();
      });
      // The House vault's roll and first deposit are not protocol-scan addresses. Read only those
      // three events, up to the block this run's protocol scan reached, so prePinFindings can see them beside the pin.
      // And its LimitsSet, which applyHouseLimits turns into HouseLimitsSet config events.
      // They go in `events`: viem's getLogs builds its topic filter from `event`/`events` only and drops a `topics`
      // field (viem 2.56.3 actions/public/getLogs.js), so a topics list here filtered nothing.
      // Over their OWN cursor, s.houseCursor, which moves only over the ranges this read returned. On the shared
      // cursor a House read that failed or stopped short lost its blocks for good, and with them any LimitsSet there;
      // now the next run reads them again. It cannot starve the other scans: the protocol scan above never waits for it
      // (the shared cursor moves with the protocol ranges whatever happens here), a failure is caught below, and a House
      // read that lags spends at most maxRangesPerRun more getLogs calls a run. It never runs ahead of the protocol scan
      // (houseTo), so a House roll is never read before the pin logs of its blocks.
      const houseEntries = opts.house.length === 0 ? registryHouseVaults(reg) : opts.house;
      const houseTo = r.caughtUp ? head.number : r.reached;
      if (houseEntries.length === 0) {
        // No vault to read, so nothing is left unread: a vault registered later starts where the protocol scan is.
        s.houseCursor = s.cursor;
      } else {
        let houseFrom = BigInt(s.houseCursor) + 1n - REORG_OVERLAP;
        if (houseFrom < deploy) houseFrom = deploy;
        if (houseFrom <= houseTo) {
          try {
            const houseAbi = parseAbi(HOUSE_VAULT_SCAN_SIGNATURES);
            const hr = await getLogsChunked(client, { address: houseEntries.map((h) => h.address), events: houseAbi }, houseFrom, houseTo, scanT, async (logs, end) => {
              const decoded = viem.parseEventLogs({ abi: houseAbi, logs, strict: false });
              housePinLogs.push(...decoded.filter((l) => HOUSE_VAULT_PIN_EVENTS.has(l.eventName)));
              configEvents.push(...applyHouseLimits(s, decoded));
              s.houseCursor = end.toString();
            });
            // Stopped short (the node made the chunk halve until maxRangesPerRun ran out). Say so, as the catch
            // below does.
            if (!hr.caughtUp) {
              notes.push(`scan: House vault roll, deposit and LimitsSet logs were read to block ${hr.reached} of ${houseTo} (raise --threshold maxRangesPerRun); blocks ${hr.reached + 1n}-${houseTo} are left to the next run, and until then a boundary pin there is vouched from pinnedBoundary() only and a limit change there has not paged`);
            }
          } catch (error) {
            notes.push(`scan: House vault roll, deposit and LimitsSet logs could not be read (${shortError(error)}); blocks ${BigInt(s.houseCursor) + 1n}-${houseTo} are left to the next run, and until then a boundary pin there is vouched from pinnedBoundary() only and a limit change there has not paged`);
          }
        }
        // A vault with no LimitsSet seen yet (registered after its constructor ran) gets its limits at the head
        // as the baseline, so its next change is judged tighten or loosen. Only once the House logs are read to the head:
        // a baseline ahead of the logs read would already contain a change the next run has not compared yet.
        if (BigInt(s.houseCursor) === head.number) {
          const unseen = houseEntries.filter((h) => s.houseLimits?.[lc(h.address)] === undefined);
          const reads = await Promise.all(unseen.map((h) => read(h.address, ABI.houseVault, "limits")));
          unseen.forEach((h, i) => {
            if (!reads[i].ok) {
              notes.push(`scan: ${h.ticker} HouseVault ${h.address} limits() could not be read (${reads[i].error}); its next LimitsSet has nothing to compare with`);
              return;
            }
            s.houseLimits ??= {};
            s.houseLimits[lc(h.address)] = { limits: Object.fromEntries(HOUSE_LIMIT_FIELDS.map((k) => [k, String(reads[i].value[k])])), at: `${head.number}:*` };
          });
        }
        houseLogsUnread = BigInt(s.houseCursor) >= head.number ? null : `House vault logs in blocks ${BigInt(s.houseCursor) + 1n}-${head.number} not read yet`;
      }
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
        // An expiry still ahead of the head is read only when a recorded halt overlaps its window. During a
        // halt the head's time stands still, so an expiry inside the halt is "ahead" of it and must not be skipped.
        if (sr.e > now && outagesOverlapping(state.outages, sr.e).length === 0) continue;
        const k = `${lc(sr.o)}:${lc(sr.u)}:${sr.e}`;
        if (!seriesOf.has(k)) seriesOf.set(k, []);
        seriesOf.get(k).push(longId);
        if (!s.expiryDone[k]) keys.set(k, sr);
      }
      const out = [];
      let finalized = 0;
      let unsettledExpiries = 0;
      // Reads the verdict needs but that are not must(): a failure is a read that did not happen, never "not
      // missed", so the check is incomplete and reconcile keeps every open settlement alert.
      let unread = 0;
      /*
       * Only a series someone holds must be settled: the cranker settles a series only while it has long
       * supply (keeper/src/v2/cranker/planner.ts `!s.settled && s.longSupply > 0n`), so an empty ladder series, one
       * nobody bought, stays unsettled for ever and nobody's redeem waits on it. Counting every SeriesCreated id paged
       * every daily expiry with untraded strikes, at error, forever (a fork run showed "5 of 6 series are still unsettled" at
       * E+19 h). Kept: an unsettled series with long OR short supply (shorts wait on settle too), and one whose
       * supply cannot be read (fail closed, with a note). Two reads per unsettled series of a finalized expiry.
       */
      const unsettledWithSupply = async (ids) => {
        const held = await Promise.all(
          ids.map(async (id) => {
            const [long, short] = await Promise.all([
              read(C.clearinghouse, ABI.clearinghouse, "totalSupply", [BigInt(id)]),
              read(C.clearinghouse, ABI.clearinghouse, "totalSupply", [BigInt(id) | 1n]),
            ]);
            if (!long.ok || !short.ok) {
              notes.push(`settlement: Clearinghouse.totalSupply of series ${id} could not be read (${long.ok ? short.error : long.error}); counted as held`);
              return true;
            }
            return long.value > 0n || short.value > 0n;
          }),
        );
        return ids.filter((_, i) => held[i]);
      };
      // The pool-denied page is for the launch markets only (--launch; tickers, the addresses from the registry).
      const launchWanted = new Set(opts.launch.map((x) => x.toUpperCase()));
      const launchAssets = new Set(reg.markets.filter((m) => launchWanted.has(m.ticker.toUpperCase()) && m.asset !== null).map((m) => lc(m.asset)));
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
          // Every deployed oracle has settlementConfig (since before the v8 deploy), so a
          // failure here is unread: judged on marketConfig TODAY, a pool pinned for this expiry but no longer listed drops out
          // of `sources`, and with it v2_mon_snapshot_missed and v2_mon_guardian_veto_due.
          if (!pinnedCfg.ok) {
            unread += 1;
            notes.push(`settlement: settlementConfig(${tickerOf(sr.u)}, ${sr.e}) could not be read (${pinnedCfg.error}); judged on today's marketConfig, and the check is incomplete`);
          }
          // snapshotRecordedAt null reads as "not missed" in checkExpiry and checkGuardianVeto: a failed snapshots()
          // read must keep an open v2_mon_guardian_veto_due, never resolve it.
          if (snap !== null && !snap.ok) {
            unread += 1;
            notes.push(`settlement: UniV3TwapSource.snapshots(${tickerOf(sr.u)}, ${sr.e}) could not be read (${snap.error}); a missed pool snapshot is not judged, and the check is incomplete`);
          }
          const sources = captured ? must(rec, "recordedSources")[0] : (pinnedRow?.[1] ?? must(cfg, "marketConfig")[0]);
          if (status === "Finalized") finalized += 1;
          const x = {
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
            okCount: captured && rec.ok ? rec.value[1].filter((v) => v === true).length : null,
            chainlinkSource: reg.sources.chainlink ?? null,
            chainlinkWindowOk: null,
          };
          // An expiry whose pool leg missed its snapshot: does Chainlink price the window? Both the
          // snapshot_missed text (any market) and the launch veto page (checkGuardianVeto) follow the answer.
          const launch = launchAssets.has(lc(sr.u));
          if (reg.sources.chainlink && now > sr.e + SNAPSHOT_GRACE && x.snapshotRecordedAt === 0 && status !== "Finalized" && openInterest !== 0n) {
            const w = await read(reg.sources.chainlink, ABI.chainlinkSource, "windowPrice", [sr.u, sr.e - SETTLEMENT_WINDOW, sr.e]);
            if (w.ok) x.chainlinkWindowOk = w.value[0] === true;
            else notes.push(`settlement: ChainlinkFeedSource.windowPrice(${tickerOf(sr.u)}, ${sr.e}) could not be read (${w.error}); a missed pool snapshot is paged with the compare-then-unveto text`);
          }
          out.push(...checkExpiry({ ...x, lockSeen: (state.managerLock ?? null) !== null }, t));
          out.push(...checkGuardianVeto({ ...x, launch, outages: state.outages, lockSeen: (state.managerLock ?? null) !== null }));
          // Finalized on the oracle is not the end of the expiry: the Clearinghouse still has to settle every
          // series before anyone can redeem. Leave the expiry open while any of its series is unsettled, or the
          // next run stops looking at it and the redeem backlog never sees it either (it follows SeriesSettled).
          const ids = seriesOf.get(k) ?? [];
          const unsettled = status === "Finalized" ? await unsettledWithSupply(ids.filter((id) => s.settled[id] === undefined)) : [];
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
        status: scanUsable && unread === 0 ? "ok" : "incomplete",
        detail: `${keys.size} past expiries read (${finalized} finalized now${unsettledExpiries > 0 ? `, ${unsettledExpiries} with unsettled series` : ""})${pruned > 0 ? `; ${pruned} finished series older than ${duration(t.seriesRetentionS)} pruned from the state` : ""}${unread > 0 ? `; ${unread} read(s) failed` : ""}`,
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
      const [balance, dailyCap, spentToday, maxBountyRead, ...bounties] = await Promise.all([
        read(reg.usdg, ABI.erc20, "balanceOf", [C.keeperRewards]),
        read(C.keeperRewards, ABI.keeperRewards, "dailyCap"),
        read(C.keeperRewards, ABI.keeperRewards, "spentToday"),
        read(C.keeperRewards, ABI.keeperRewards, "maxBounty"),
        ...Object.values(ACTIONS).map((a) => read(C.keeperRewards, ABI.keeperRewards, "bounty", [a])),
      ]);
      const table = Object.fromEntries(Object.keys(ACTIONS).map((name, i) => [name, must(bounties[i], `bounty(${name})`)]));
      // An older KeeperRewards has no maxBounty() (a revert): nothing is clamped, as before. Any
      // other failure is noted and judged unclamped too, which can only understate the runway, never overstate it.
      const maxBounty = maxBountyRead.ok ? BigInt(maxBountyRead.value) : null;
      if (!maxBountyRead.ok && !maxBountyRead.revert) notes.push(`rewards: KeeperRewards.maxBounty() could not be read (${maxBountyRead.error}); bounties are judged unclamped`);
      const s = state.scan;
      const observed = observedSpend(s.rewards, s.finalized, t.rewardsWindowExpiries);
      const r = checkRewards(
        { address: C.keeperRewards, balance: must(balance, "USDG.balanceOf(KeeperRewards)"), dailyCap: must(dailyCap, "dailyCap"), spentToday: must(spentToday, "spentToday"), bounties: table, observed, maxBounty },
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

    // ---- house vaults: the boundary epoch stall, and whether the boundary is pinned ----
    const houseBoundaries = []; // Each vault's boundary, read by the window check below
    await run("house", async () => {
      // --house / MONITOR_HOUSE_VAULTS when given, else the vaults the registry records.
      const fromRegistry = opts.house.length === 0;
      const houses = fromRegistry ? registryHouseVaults(reg) : opts.house;
      if (houses.length === 0) {
        return { status: "skipped", detail: "no --house TICKER=0xaddress given and the registry records no House vault (markets[].v2.house)" };
      }
      const out = [];
      const details = [];
      let unread = 0;
      // A best-effort view that REVERTS is one an older vault does not have: noted, never judged, and the check
      // still completes. One that fails any other way (a 429, a dropped connection) is a read that did not happen: it
      // counts as unread, so the check is incomplete and reconcile keeps every open House alert instead of resolving it.
      const lost = (r) => !r.ok && r.revert !== true;
      for (const h of houses) {
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
        // settlementInfo has six outputs, so viem returns an ARRAY (status, price, ...), as the settlement check reads it.
        // This read `info.value.status`, which is undefined on an array, so a Finalized boundary was never seen.
        const boundaryStatus = info.ok ? SETTLEMENT_STATUS[Number(info.value[0])] : null;
        const boundary = info.ok ? { finalized: boundaryStatus === "Finalized" && BigInt(info.value[1]) !== 0n, price: BigInt(info.value[1]), status: boundaryStatus, candidate: null } : null;
        if (!info.ok) notes.push(`house: ${h.ticker} settlementInfo(${iso(epochEnd)}) could not be read (${info.error})`);
        // The boundary read is the published oracle's settlementInfo, which every oracle has, so ANY failure
        // (a revert included) is a read that did not happen. Left uncounted, a null boundary dropped the "not Finalized"
        // blocker, the check completed, and a 429 resolved an open v2_mon_house_epoch_stall.
        if (!info.ok) unread += 1;
        // A Pending boundary's candidate decides whether the stall clears on its own. An unread candidate
        // stays null, which keeps the ERROR (the stall is never downgraded on a read that did not happen).
        if (boundaryStatus === "Pending" && head.timestamp - epochEnd >= t.houseEpochStallS) {
          const cand = await read(C.settlementOracle, ABI.oracle, "candidate", [asset.value, epochEnd]);
          if (cand.ok) {
            const fa = Number(cand.value[3]);
            boundary.candidate = fa === 0 ? null : { price: BigInt(cand.value[0]), disagreed: cand.value[2] === true, finalizableAt: fa };
          } else {
            notes.push(`house: ${h.ticker} candidate(${iso(epochEnd)}) could not be read (${cand.error}); the stall is judged without it`);
          }
        }
        if (seriesUnread) unread += 1;
        out.push(
          ...checkHouseEpoch(
            { address: h.address, ticker: h.ticker, epochId: id.value, epochEnd, now: head.timestamp, boundary, series },
            t,
          ),
        );
        // Whether the boundary is pinned, on the vault's OWN oracle: that is the one it prices the boundary at.
        const orc = await read(h.address, ABI.houseVault, "oracle");
        const vaultOracle = orc.ok ? orc.value : C.settlementOracle;
        if (!orc.ok) notes.push(`house: ${h.ticker} oracle() could not be read (${orc.error}); the boundary pin is read on the published oracle`);
        if (lost(orc)) unread += 1; // A pin read on the published oracle is not the vault's, and clears nothing
        const [pinCfg, pinInfo] = await Promise.all([
          read(vaultOracle, ABI.oracle, "settlementConfig", [asset.value, epochEnd]),
          read(vaultOracle, ABI.oracle, "settlementInfo", [asset.value, epochEnd]),
        ]);
        if (!pinCfg.ok || !pinInfo.ok) {
          unread += 1;
          notes.push(`house: ${h.ticker} settlementConfig/settlementInfo(${iso(epochEnd)}) could not be read (${(pinCfg.ok ? pinInfo : pinCfg).error}); the boundary pin is not judged`);
        }
        // A boundary the market lists no series at by design (no dailies; SPCX Monday to Thursday). The market
        // is found by the vault's underlying, not the --house label; a series the scan saw at the expiry overrides it.
        const houseMarket = reg.markets.find((m) => sameAddress(m.asset, asset.value));
        const seriesAtBoundary = Object.values(state.scan.series).some((sr) => sameAddress(sr.u, asset.value) && sr.e === epochEnd);
        out.push(
          ...checkHouseBoundaryPin(
            {
              address: h.address,
              ticker: h.ticker,
              underlying: asset.value,
              lockSeen: (state.managerLock ?? null) !== null,
              oracle: vaultOracle,
              epochId: id.value,
              epochEnd,
              now: head.timestamp,
              pinned: pinCfg.ok ? pinCfg.value[0] === true : null,
              status: pinInfo.ok ? (SETTLEMENT_STATUS[Number(pinInfo.value[0])] ?? "None") : null,
              // Also a boundary on a weekday the market lists no dailies on (NVDA Tue/Thu).
              ...houseNoSeriesByDesign(houseMarket?.v2 ?? null, epochEnd, seriesAtBoundary),
            },
            t,
          ),
        );
        // Whether the vault LOCKED this boundary itself (pinnedBoundary == epochEnd) before money was
        // exposed to it; rollEpoch holds a boundary it did not lock for a week past its end. An older vault
        // that has no pinnedBoundary(): noted, never judged. A failed exposure read is not judged either.
        const [pinnedB, supply, pendU, pendS] = await Promise.all([
          read(h.address, ABI.houseVault, "pinnedBoundary"),
          read(h.address, ABI.houseVault, "totalSupply"),
          read(h.address, ABI.houseVault, "pendingDepositUsdg"),
          read(h.address, ABI.houseVault, "pendingDepositStock"),
        ]);
        if (!pinnedB.ok) notes.push(`house: ${h.ticker} pinnedBoundary() could not be read (${pinnedB.error}); ${pinnedB.revert ? "a vault built before T-OP-866 has none, and its" : "not a revert, so the check is incomplete and its"} boundary lock is not judged`);
        const exposureRead = [supply, pendU, pendS].find((r) => !r.ok);
        if (pinnedB.ok && exposureRead !== undefined) notes.push(`house: ${h.ticker} totalSupply/pendingDeposit* could not be read (${exposureRead.error}); the boundary lock is not judged`);
        // The lock is judged only with every read: an open v2_mon_house_boundary_unlocked or v2_mon_house_roll_held
        // stays open on a pinnedBoundary() that failed other than by reverting, or on a failed exposure read.
        if (lost(pinnedB) || (pinnedB.ok && exposureRead !== undefined)) unread += 1;
        out.push(
          ...checkHouseBoundaryLock({
            address: h.address,
            ticker: h.ticker,
            lockSeen: (state.managerLock ?? null) !== null,
            oracle: vaultOracle,
            epochId: id.value,
            epochEnd,
            now: head.timestamp,
            pinnedBoundary: pinnedB.ok ? Number(pinnedB.value) : null,
            exposed: exposureRead !== undefined ? null : BigInt(supply.value) !== 0n || BigInt(pendU.value) !== 0n || BigInt(pendS.value) !== 0n,
          }),
        );
        houseBoundaries.push({ ticker: h.ticker, underlying: asset.value, oracle: vaultOracle, expiry: epochEnd });
        // Best effort: older vaults have neither view, and a failed read is reported, never judged.
        const [wk, owed] = await Promise.all([read(h.address, ABI.houseVault, "weekly"), read(h.address, ABI.houseVault, "performanceFeeOwed")]);
        const expectedKind = expectedHouseKind(reg, h.address);
        if (!wk.ok && expectedKind !== null) notes.push(`house: ${h.ticker} weekly() could not be read (${wk.error}); the registry's ${expectedKind} slot is not checked`);
        // Reported, never judged, and never read as "nothing wrong": an open v2_mon_house_kind_mismatch or
        // v2_mon_house_fee_owed stays open on a read that failed other than by reverting.
        if (lost(wk) && expectedKind === null) notes.push(`house: ${h.ticker} weekly() could not be read (${wk.error})`);
        if (lost(owed)) notes.push(`house: ${h.ticker} performanceFeeOwed() could not be read (${owed.error}); a carried fee is not judged`);
        if (lost(wk) || lost(owed)) unread += 1;
        out.push(...checkHouseVaultState({ address: h.address, ticker: h.ticker, epochId: id.value, weekly: wk.ok ? Boolean(wk.value) : null, expectedKind, feeOwed: owed.ok ? BigInt(owed.value) : null, tracked: ids.length }));
        details.push(`${h.ticker} epoch ${id.value} ends ${iso(epochEnd)} (${ids.length} tracked${wk.ok ? `, ${wk.value ? "weekly" : "daily"}` : ""}${owed.ok && BigInt(owed.value) > 0n ? `, fee owed ${usdg(owed.value)} USDG` : ""})`);
      }
      // House vault logs the scan has not read yet may hold a LimitsSet that has not paged: incomplete until a
      // run reads them (the House read keeps its own cursor, so one does).
      if (houseLogsUnread !== null && checks.scan?.status !== "skipped") {
        unread += 1;
        details.push(houseLogsUnread);
      }
      const origin = fromRegistry ? "from the registry's markets[].v2.house: " : "";
      return { findings: out, status: unread > 0 ? "incomplete" : "ok", detail: `${origin}${details.join(", ") || "no house vault read"}` };
    });

    // ---- a launch expiry's Chainlink window price against the pool TWAP, before it can finalize ----
    await run("window", async () => {
      const launchWanted = new Set(opts.launch.map((x) => x.toUpperCase()));
      const launchAssets = new Set(reg.markets.filter((m) => launchWanted.has(m.ticker.toUpperCase()) && m.asset !== null).map((m) => lc(m.asset)));
      if (launchAssets.size === 0) return { status: "skipped", detail: "no --launch market in the registry" };
      if (!reg.sources.chainlink || !reg.sources.univ3) return { status: "skipped", detail: "the registry names no Chainlink source or no pool source" };
      const now = head.timestamp;
      const watched = (e) => now >= e - SETTLEMENT_WINDOW && now <= e + t.windowWatchS;
      // Expiries that value held money: those with series (the log scan), and the watched House vaults' boundaries.
      const due = new Map();
      const scanned = checks.scan?.status === "ok" || checks.scan?.status === "incomplete" ? Object.values(state.scan?.series ?? {}) : [];
      for (const sr of scanned) {
        if (launchAssets.has(lc(sr.u)) && watched(sr.e)) due.set(`${lc(sr.u)}:${sr.e}`, { underlying: sr.u, expiry: sr.e, oracle: sr.o });
      }
      for (const b of houseBoundaries) {
        const k = `${lc(b.underlying)}:${b.expiry}`;
        if (launchAssets.has(lc(b.underlying)) && watched(b.expiry) && !due.has(k)) due.set(k, { underlying: b.underlying, expiry: b.expiry, oracle: b.oracle });
      }
      if (due.size === 0) return { detail: "no launch expiry inside its settlement window or waiting to finalize" };
      const out = [];
      const detail = [];
      let incomplete = false;
      for (const x of due.values()) {
        const label = `${tickerOf(x.underlying)} ${iso(x.expiry)}`;
        const [info, cfg] = await Promise.all([
          read(x.oracle, ABI.oracle, "settlementInfo", [x.underlying, x.expiry]),
          read(x.oracle, ABI.oracle, "settlementConfig", [x.underlying, x.expiry]),
        ]);
        if (!info.ok || !cfg.ok) {
          incomplete = true;
          notes.push(`window: ${label} settlementInfo/settlementConfig could not be read (${(info.ok ? cfg : info).error})`);
          continue;
        }
        const status = SETTLEMENT_STATUS[Number(info.value[0])] ?? "None";
        if (status === "Finalized" || status === "Held") {
          detail.push(`${label} ${status}`);
          continue;
        }
        const closed = now >= x.expiry;
        const start = x.expiry - SETTLEMENT_WINDOW;
        const [feed, ref] = await Promise.all([
          read(reg.sources.chainlink, ABI.chainlinkSource, "windowPrice", [x.underlying, start, closed ? x.expiry : now]),
          closed ? read(reg.sources.univ3, ABI.univ3, "windowPrice", [x.underlying, start, x.expiry]) : read(reg.sources.univ3, ABI.univ3, "latest", [x.underlying]),
        ]);
        if (!feed.ok || !ref.ok) {
          incomplete = true;
          notes.push(`window: ${label} a source could not be read (${(feed.ok ? ref : feed).error})`);
          continue;
        }
        const reference = {
          ok: ref.value[0] === true,
          price: BigInt(ref.value[1]),
          what: closed ? "the snapshot UniV3TwapSource recorded for this window" : "UniV3TwapSource.latest, the pool TWAP over its configured window ending now",
        };
        const x2 = { ticker: tickerOf(x.underlying), underlying: x.underlying, oracle: x.oracle, expiry: x.expiry, status, phase: closed ? "closed" : "running", maxDeviationBps: Number(cfg.value[2]), feed: { ok: feed.value[0] === true, price: BigInt(feed.value[1]) }, reference, lockSeen: (state.managerLock ?? null) !== null };
        out.push(...checkWindowDivergence(x2));
        if (!x2.feed.ok || !reference.ok) detail.push(`${label} ${!x2.feed.ok ? "Chainlink window not ok" : closed ? "pool snapshot not recorded yet" : "pool TWAP not ok"}: not compared`);
        else detail.push(`${label} ${x2.phase}: Chainlink ${usdg(x2.feed.price)} / pool ${usdg(reference.price)}, max ${x2.maxDeviationBps} bps`);
      }
      return { findings: out, status: incomplete ? "incomplete" : "ok", detail: detail.join("; ") };
    });

    // ---- a launch expiry whose Chainlink leg needs a round the feed has not printed ----
    await run("feedgap", async () => {
      const launchWanted = new Set(opts.launch.map((x) => x.toUpperCase()));
      const launch = reg.markets.filter((m) => launchWanted.has(m.ticker.toUpperCase()) && m.asset !== null);
      if (launch.length === 0) return { status: "skipped", detail: "no --launch market in the registry" };
      if (!reg.sources.chainlink) return { status: "skipped", detail: "the registry names no Chainlink source" };
      const now = head.timestamp;
      const ahead = (e) => now <= e && now >= e - t.feedGapLeadS;
      // The expiries that value held money, as in the window check: series from the log scan, and House boundaries.
      const due = new Map();
      const scanned = checks.scan?.status === "ok" || checks.scan?.status === "incomplete" ? Object.values(state.scan?.series ?? {}) : [];
      const marketOf = (u) => launch.find((m) => sameAddress(m.asset, u));
      for (const sr of scanned) if (marketOf(sr.u) && ahead(sr.e)) due.set(`${lc(sr.u)}:${sr.e}`, { underlying: sr.u, expiry: sr.e });
      for (const b of houseBoundaries) {
        const k = `${lc(b.underlying)}:${b.expiry}`;
        if (marketOf(b.underlying) && ahead(b.expiry) && !due.has(k)) due.set(k, { underlying: b.underlying, expiry: b.expiry });
      }
      // An expiry this check has open stays watched past E, until it is Finalized or its Chainlink leg
      // recorded ok; dropping it at E sent "resolved" the moment the missing leg became a fact.
      for (const e of Object.values(state.alerts ?? {})) {
        if (e.kind !== "v2_mon_feed_expiry_gap" || due.has(e.key)) continue;
        const [u, es] = String(e.key).split(":");
        const ex = Number(es);
        if (ex > 0 && now > ex && marketOf(u)) due.set(e.key, { underlying: u, expiry: ex });
      }
      if (due.size === 0) return { detail: `no launch expiry in the next ${duration(t.feedGapLeadS)}` };
      const out = [];
      const detail = [];
      let incomplete = false;
      for (const x of due.values()) {
        const m = marketOf(x.underlying);
        const label = `${m.ticker} ${iso(x.expiry)}`;
        // The configuration this expiry settles on: the pinned one once the first series froze it, else the market's.
        const [pf, pp] = await Promise.all([
          read(reg.sources.chainlink, ABI.chainlinkSource, "pinnedFeeds", [x.underlying, x.expiry]),
          reg.sources.univ3 ? read(reg.sources.univ3, ABI.univ3, "pinnedPools", [x.underlying, x.expiry]) : Promise.resolve(null),
        ]);
        const pinned = pf.ok && pf.value[3] === true;
        // Every deployed source has pinnedFeeds / pinnedPools (since before the v8 deploy), so a
        // failure is unread. The expiry is still judged on the market's config, but a pinned feed or maxStale that differs
        // can make the gap vanish there, so the check is incomplete and an open v2_mon_feed_expiry_gap is kept.
        if (!pf.ok) {
          incomplete = true;
          notes.push(`feedgap: ${label} ChainlinkFeedSource.pinnedFeeds could not be read (${pf.error}); judged on the market's feeds(), and the check is incomplete`);
        }
        if (pp !== null && !pp.ok) {
          incomplete = true;
          notes.push(`feedgap: ${label} UniV3TwapSource.pinnedPools could not be read (${pp.error}); the pool leg is judged on the market's pools(), and the check is incomplete`);
        }
        const cfg = pinned ? pf : await read(reg.sources.chainlink, ABI.chainlinkSource, "feeds", [x.underlying]);
        if (!cfg.ok) {
          incomplete = true;
          notes.push(`feedgap: ${label} the Chainlink source's feed configuration could not be read (${cfg.error})`);
          continue;
        }
        const feed = cfg.value[0];
        if (sameAddress(feed, ZERO)) {
          detail.push(`${label} no Chainlink feed set`);
          continue;
        }
        const latest = await read(feed, ABI.feed, "latestRoundData");
        if (!latest.ok) {
          incomplete = true;
          notes.push(`feedgap: ${label} latestRoundData on ${feed} could not be read (${latest.error})`);
          continue;
        }
        let pool = null;
        const poolPinned = pp !== null && pp.ok && pp.value[4] === true;
        const poolCfg = pp === null ? null : poolPinned ? pp : await read(reg.sources.univ3, ABI.univ3, "pools", [x.underlying]);
        if (poolCfg !== null && poolCfg.ok && !sameAddress(poolCfg.value[0], ZERO)) {
          const liq = await read(poolCfg.value[0], ABI.pool, "liquidity");
          pool = { address: poolCfg.value[0], liquidity: liq.ok ? BigInt(liq.value) : null, floor: BigInt(poolPinned ? poolCfg.value[5] : poolCfg.value[4]) };
        } else if (poolCfg !== null && !poolCfg.ok) {
          pool = { address: m.v2?.univ3Pool ?? "(unknown)", liquidity: null, floor: null };
        }
        const updatedAt = Number(latest.value[3]);
        const maxStale = Number(cfg.value[1]);
        let settlement = null;
        if (now > x.expiry) {
          const [si, rs] = await Promise.all([
            read(C.settlementOracle, ABI.oracle, "settlementInfo", [x.underlying, x.expiry]),
            read(C.settlementOracle, ABI.oracle, "recordedSources", [x.underlying, x.expiry]),
          ]);
          if (!si.ok || !rs.ok) {
            incomplete = true; // an unread settlement keeps the open alert; it is never resolved on a failed read
            notes.push(`feedgap: ${label} settlementInfo/recordedSources could not be read (${(si.ok ? rs : si).error})`);
            continue;
          }
          const captured = si.value[5] === true;
          const leg = rs.value[0].findIndex((a) => sameAddress(a, reg.sources.chainlink));
          settlement = { finalized: SETTLEMENT_STATUS[Number(si.value[0])] === "Finalized", captured, chainlinkOk: captured && leg >= 0 ? rs.value[1][leg] === true : null };
        }
        out.push(...checkFeedExpiryGap({ ticker: m.ticker, underlying: x.underlying, feed, expiry: x.expiry, now, updatedAt, maxStale, pinned, pool, settlement }, t));
        detail.push(`${label}: latest round ${duration(Math.max(0, now - updatedAt))} old, needs one from ${iso(x.expiry - maxStale)}`);
      }
      return { findings: out, status: incomplete ? "incomplete" : "ok", detail: detail.join("; ") };
    });

    // ---- every AccessManager member, walked from the deploy block ----
    await run("members", async () => {
      if (C.accessManager === null) return { status: "skipped", detail: "no accessManager in the registry" };
      if (reg.deployBlock === null) return { status: "skipped", detail: "no v2.deployBlock to walk the manager's log from" };
      const m = ROLE_MANIFEST.manifest;
      if (m === null) return { status: "incomplete", detail: `the role manifest could not be read: ${ROLE_MANIFEST.why}` };
      const w = state.managerMembers;
      // The flywheel is deployed before the core (registry v2.flywheel.deployBlock); start at the earlier of the two.
      const deploy = reg.flywheel?.deployBlock != null && reg.flywheel.deployBlock < reg.deployBlock ? reg.flywheel.deployBlock : reg.deployBlock;
      let from = w.cursor === null ? deploy : BigInt(w.cursor) + 1n - REORG_OVERLAP;
      if (from < deploy) from = deploy;
      const memberAbi = parseAbi(MANAGER_MEMBER_EVENTS);
      const walkT = opts.dryRun && t.maxRangesPerRun === DEFAULTS.maxRangesPerRun ? { ...t, maxRangesPerRun: Number.MAX_SAFE_INTEGER } : t;
      const r = await getLogsChunked(client, { address: C.accessManager }, from, head.number, walkT, async (logs, end) => {
        applyManagerMembership(w, viem.parseEventLogs({ abi: memberAbi, logs, strict: true }));
        w.cursor = end.toString();
      });
      const held = Object.values(w.members).filter((mb) => mb.member);
      const where = `${r.logs} logs over ${r.ranges} range(s) from block ${from}; ${held.length} (role, account) memberships`;
      // The positive control: the manager's constructor grants ADMIN to its initial admin, so a walk that began at or
      // before the manager's creation has seen one. Without it, grants before the walk's first block are invisible, and
      // judging would call the deployer a stranger and miss everything earlier; nothing is judged.
      if (w.firstAdmin === null) {
        if (!r.caughtUp) return { status: "incomplete", detail: `${where}; ${head.number - r.reached} blocks still to walk` };
        return { status: "incomplete", detail: `${where}; no ADMIN grant seen since block ${deploy}: the AccessManager was created before it, so earlier members are invisible and nothing is judged` };
      }
      const holders = {
        adminSafe: reg.safes.admin,
        treasurySafe: reg.safes.treasury,
        guardianKey: reg.bots?.guardian ?? null,
        pricerKey: reg.bots?.pricer ?? null,
        quoterKey: reg.bots?.quoter ?? null,
        crankerKey: reg.bots?.cranker ?? null,
      };
      // hasRole at the head for every member the rule would page, so a walk made stale by a deep reorg pages nothing.
      const suspects = checkManagerMembers({ manager: C.accessManager, walk: w, manifest: m, holders, confirmed: new Map() });
      const confirmed = new Map();
      if (suspects.length > 0) {
        const reads = await readMany(suspects.map((f) => ({ address: C.accessManager, abi: ABI.accessManager, functionName: "hasRole", args: [BigInt(f.data.roleId), f.data.account] })));
        suspects.forEach((f, i) => confirmed.set(`${f.data.roleId}:${f.data.account}`, reads[i].ok ? reads[i].value[0] === true : null));
        for (const [k, v] of confirmed) if (v === false) notes.push(`members: the walk says ${k} is a member and hasRole at the head says not; the walk is stale for it (a reorg deeper than ${REORG_OVERLAP} blocks?)`);
      }
      const findingsOut = checkManagerMembers({ manager: C.accessManager, walk: w, manifest: m, holders, confirmed });
      if (!r.caughtUp) return { findings: findingsOut, status: "incomplete", detail: `${where}; ${head.number - r.reached} blocks still to walk` };
      return { findings: findingsOut, detail: `${where}; deployer ${w.firstAdmin.account}; caught up at ${head.number}` };
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

    // ---- AutoRoller asks the market has overtaken (INTERFACE_VERSION 7) ----
    // The pairs come from the scan's Rolled logs; the chain says what each one's position is now. A pair costs one
    // position() read a pass, and only a live ask costs anything more.
    await run("roller", async () => {
      // Not SettlementOracle: every spot here comes from the series' own pinned oracle, read off the
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
      // An ask whose spot or witness read FAILED (other than by reverting, which cancelStale sees too) is not
      // "not overtaken": its clock is kept, and the check is incomplete so an open v2_mon_roller_ask_overtaken is kept.
      let unread = 0;
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
        // ORACLE. The spot that judges an ask is the one ITS SERIES pinned, `Clearinghouse.series(longId).oracle`:
        // what `cancelStale` reads on chain and what the series settles on. Never the registry's published
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
        // cancelStale's second path: the expiry's witness, read only for an ask spot does not already show
        // overtaken, exactly as the contract tries it (AutoRoller._tryWitness): settlementConfig(u, expiry) of the series'
        // pinned oracle, the Stock Token's oraclePaused(), then source 1's latest(u). A failed read is not ok, never ok.
        const witnesses = await Promise.all(
          candidates.map(async (x, i) => {
            const ser = seriesOf[i];
            if (typeof ser.oracle !== "string" || sameAddress(ser.oracle, ZERO)) return null;
            const sp = spots.get(spotKeyOf(ser.oracle, x.p.u));
            const [spotOk, spot] = sp !== undefined && sp.ok ? sp.value : [false, 0n];
            if (spotOk && overtaken(ser.isPut, ser.strike, spot)) return null;
            const cfg = await read(ser.oracle, ABI.oracle, "settlementConfig", [x.p.u, Number(ser.expiry)]);
            if (!cfg.ok) {
              // A REVERT is what _tryWitness sees too: no witness. Any other failure is unread, and the ask is not judged.
              if (cfg.revert === true) return null;
              notes.push(`roller: settlementConfig(${tickerOf(x.p.u)}, ${iso(Number(ser.expiry))}) could not be read (${cfg.error}); the witness path is not judged`);
              return { unreadWitness: true, reading: null };
            }
            const sources = [...cfg.value[1]];
            if (sources.length < 2) return witnessReading({ sources, oraclePaused: null, latest: null }, now);
            const [paused, latest] = await Promise.all([read(x.p.u, ABI.stockToken, "oraclePaused"), read(sources[1], ABI.univ3, "latest", [x.p.u])]);
            // A REVERT is what _tryWitness sees too (a reverting oraclePaused() counts as paused, as the contract
            // counts it); a read that failed any other way is unread, never a paused token or a witness that is not ok.
            const lost = [paused, latest].find((r) => !r.ok && r.revert !== true);
            if (lost !== undefined) {
              notes.push(`roller: the witness of ${tickerOf(x.p.u)} ${iso(Number(ser.expiry))} could not be read (${lost.error}); the witness path is not judged`);
              return { unreadWitness: true, reading: null };
            }
            return witnessReading({ sources, oraclePaused: paused.ok ? paused.value === true : true, latest: latest.ok ? latest.value : null }, now);
          }),
        );
        candidates.forEach((x, i) => {
          const ser = seriesOf[i];
          const sp = spots.get(spotKeyOf(ser.oracle, x.p.u));
          // A reverting trySpot is the oracle's own alarm (v2_mon_oracle_paused, v2_mon_feed_stale), not this one's:
          // cancelStale returns false without a fresh spot, and so does this check. An unpinned oracle lands here too.
          const [spotOk, spot, spotUpdatedAt] = sp !== undefined && sp.ok ? sp.value : [false, 0n, 0n];
          const spotLost = sp !== undefined && !sp.ok && sp.revert !== true;
          if (spotLost) notes.push(`roller: trySpot(${tickerOf(x.p.u)}) on ${ser.oracle} could not be read (${sp.error}); the ask is not judged on spot`);
          const unreadWitness = witnesses[i]?.unreadWitness === true;
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
              witness: unreadWitness ? null : witnesses[i],
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
          } else if (spotLost || unreadWitness) {
            unread += 1; // Not judged, so the clock is neither started nor cleared
          } else delete s.rollerStale[x.key];
          out.push(...r.findings);
        });
      }
      for (const k of Object.keys(s.rollerStale)) if (s.roller[k] === undefined) delete s.rollerStale[k];
      return {
        findings: out,
        status: scanUsable && unread === 0 ? "ok" : "incomplete",
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
            // A row that failed is not "not listed": skipped, it let FeedSet page at warn as "listed nowhere".
            // Every oracle has settlementConfig (since before the v8 deploy), so it is unread, and the catch below pages as listed.
            if (!c.ok) throw new Error(`settlementConfig(${tickerOf(x.u)}, ${x.e}): ${c.error}`);
            if (c.value[0] && c.value[1].some((a) => sameAddress(a, ds))) dataStreamsListed.push(`${tickerOf(x.u)} ${iso(x.e)} pin`);
          });
        } catch (error) {
          dataStreamsListed = null;
          notes.push(`config: where the Data Streams source is listed could not be read (${shortError(error)}): its FeedSet pages as listed`);
        }
      }
      const ctx = { names, clearinghouse: C.clearinghouse, settlementOracle: C.settlementOracle, markets: reg.markets, dataStreamsListed, houses: await housePinsForVouch() };
      // A mint pins its expiry, and prePinFindings matches the pin to the minted series' own (u, E). A Minted
      // whose SeriesCreated the scan never saw (a registry with no deployBlock) is looked up here, only where its
      // transaction also pinned something after the adopted history; a lookup that fails leaves it vouching for its tx.
      const pinTxs = new Set(pinLogs.filter((l) => l.eventName !== "SeriesCreated" && l.eventName !== "Minted" && fresh(l)).map((l) => lc(l.transactionHash)));
      const unknownMints = pinLogs.filter((l) => l.eventName === "Minted" && !l.series && pinTxs.has(lc(l.transactionHash)));
      const mintSeries = await readMany(unknownMints.map((l) => ({ address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "series", args: [l.args.longId] })));
      unknownMints.forEach((l, i) => {
        if (mintSeries[i].ok) l.series = { u: mintSeries[i].value.underlying, e: Number(mintSeries[i].value.expiry) };
        else notes.push(`config: series(${l.args.longId}) of the Minted in tx ${l.transactionHash} could not be read (${mintSeries[i].error}); that mint vouches for every pin in its transaction`);
      });
      // What the EarnVault's adapter can pay now, read only when this run saw a fresh short pull.
      const earnWithdrawableNow = async () => {
        if (!payoutLogs.some((l) => l.eventName === "PulledFromVenue" && fresh(l)) || reg.earnVault === null) return null;
        const a = await read(reg.earnVault, ABI.earnVault, "adapter");
        const w = a.ok && !sameAddress(a.value, ZERO) ? await read(a.value, ABI.earnAdapter, "withdrawable") : null;
        if (w !== null && w.ok) return w.value;
        notes.push(`config: the EarnVault adapter's withdrawable() could not be read (${a.ok ? (w === null ? "no adapter" : w.error) : a.error}); a short venue pull pages at warn`);
        return null;
      };
      // The head's skimBps() is the rate at a fresh Skimmed only while the scan has tracked no SkimBpsSet for this
      // vault (so none came after the log) and the scan reached the head. Otherwise null, and a zero-fee gain pages.
      const earnSkimBpsNow = async () => {
        if (reg.earnVault === null || !scanCaughtUp || (state.scan.earnSkimBps?.[lc(reg.earnVault)] ?? null) !== null) return null;
        if (!payoutLogs.some((l) => l.eventName === "Skimmed" && fresh(l) && l.skimBps === null)) return null;
        const r = await read(reg.earnVault, ABI.earnVault, "skimBps");
        if (r.ok) return Number(r.value);
        notes.push(`config: the EarnVault skimBps() could not be read (${r.error}); a Skimmed gain with no fee pages as still owed`);
        return null;
      };
      // The sender of each fresh Repriced, one eth_getTransactionByHash per log (the event is rare). A
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
        ...managerEventFindings(configEvents, adopt, { names, manifest: ROLE_MANIFEST.manifest, selectors: managerSelectors, byTarget: managerByTarget, now: head.timestamp, lockSeen: (state.managerLock ?? null) !== null }),
        ...prePinFindings([...pinLogs, ...housePinLogs], adopt, ctx),
        ...inKindPayoutFindings(payoutLogs, adopt, { tickerOf }),
        ...earnPullFindings(payoutLogs, adopt, { vault: reg.earnVault, withdrawableNow: await earnWithdrawableNow() }),
        ...earnSkimRefusedFindings(payoutLogs, adopt, { vault: reg.earnVault, skimBpsNow: await earnSkimBpsNow() }),
        // Every log that turns Earn just-in-time funding on pages.
        ...jitFundingEventFindings(configEvents, adopt, names),
      ];
      return {
        findings: out,
        status: partial || !scanCaughtUp ? "incomplete" : "ok",
        detail: `${configEvents.length} admin events and ${pinLogs.length} series / pin logs in the scanned range (history before block ${adopt} adopted), ${out.length} new${partial ? "; the scan failed part way: the ranges it completed are judged" : ""}`,
      };
    });

    // ---- Earn just-in-time funding is off at the head ----
    await run("funding", async () => {
      if (reg.earnVault === null) return { status: "skipped", detail: "no v2.contracts.earnVault in the registry" };
      const [enabled, book] = await Promise.all([
        read(reg.earnVault, ABI.earnVault, "fundingEnabled"),
        C.orderBook === null ? null : read(C.orderBook, ABI.orderBook, "fundingOf", [reg.earnVault]),
      ]);
      // An unread switch is unknown, never off: noted, and the check reports incomplete.
      if (!enabled.ok) notes.push(`funding: EarnVault.fundingEnabled() could not be read (${enabled.error}); its own switch is not judged`);
      if (book !== null && !book.ok) notes.push(`funding: OrderBook.fundingOf(EarnVault) could not be read (${book.error}); the book's allow-list and switch are not judged`);
      const x = {
        vault: reg.earnVault,
        enabled: enabled.ok ? enabled.value === true : null,
        book: book !== null && book.ok ? { allowed: book.value[0] === true, on: book.value[1] === true } : null,
      };
      const complete = x.enabled !== null && x.book !== null;
      return {
        findings: checkJitFunding(x),
        status: complete ? "ok" : "incomplete",
        detail: `EarnVault ${reg.earnVault}: fundingEnabled ${x.enabled ?? "unread"}, OrderBook.fundingOf allowed ${x.book?.allowed ?? "unread"} on ${x.book?.on ?? "unread"}`,
      };
    });

    // ---- the EarnVault prices, i.e. its venue adapter can be read ----
    await run("earnvenue", async () => {
      if (reg.earnVault === null) return { status: "skipped", detail: "no v2.contracts.earnVault in the registry" };
      let probe = null;
      try {
        await client.readContract({ address: reg.earnVault, abi: ABI.earnVault, functionName: "convertToAssets", args: [1n], blockNumber: head.number });
        probe = "priced";
      } catch (error) {
        const name = revertErrorName(error);
        if (name === "VenueUnreadable") probe = "unreadable";
        else if (name === "PositionOpen") probe = "position-open";
        // An unknown answer is never "priced": noted, and the check reports incomplete so an open page is kept.
        else notes.push(`earnvenue: EarnVault.convertToAssets(1) failed without a reason the monitor knows (${shortError(error)}); whether its venue can be read is not judged`);
      }
      // PositionOpen is checked first, so the venue is not judged then; an open page is kept rather than resolved.
      const pageOpen = Object.values(state.alerts).some((e) => e.kind === "v2_mon_earn_venue_unreadable");
      if (probe === null || (probe === "position-open" && pageOpen)) {
        return { status: "incomplete", detail: `EarnVault ${reg.earnVault}: convertToAssets(1) ${probe === null ? "unread" : "reverts PositionOpen"}; the venue is not judged` };
      }
      const adapter = probe === "unreadable" ? await read(reg.earnVault, ABI.earnVault, "adapter") : null;
      return {
        findings: checkEarnVenue({ vault: reg.earnVault, adapter: adapter?.ok ? adapter.value : null, probe }),
        detail: `EarnVault ${reg.earnVault}: convertToAssets(1) ${probe === "priced" ? "answers, so the venue is priced" : probe === "unreadable" ? "reverts VenueUnreadable, so nothing is priced" : "reverts PositionOpen; the venue is not judged while a position is open"}`,
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
      const pairs = publishedHolders(m, holderAddress);
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
      // getTargetFunctionRole for every manifest selector of every target the registry names. The lock below
      // is recorded from the role and holder reads alone, as before; a selector read that fails leaves only its row unknown.
      const laneUnread = unread.length;
      const { targets, unnamed } = managerTargets(reg, m);
      const fnRows = [];
      for (const tg of targets) {
        for (const [signature, roleName] of Object.entries(m.targets[tg.contract] ?? {})) {
          let selector;
          try {
            selector = lc(viem.toFunctionSelector(`function ${signature}`));
          } catch {
            continue; // noted once where managerSelectors is built
          }
          fnRows.push({ contract: tg.contract, target: tg.address, signature, selector, roleName, want: m.ids[roleName] ?? null });
        }
      }
      const fnReads = await readMany(fnRows.map((r) => ({ address: C.accessManager, abi: ABI.accessManager, functionName: "getTargetFunctionRole", args: [r.target, r.selector] })));
      const functions = fnRows.map((r, i) => {
        if (!fnReads[i].ok) unread.push(`getTargetFunctionRole(${r.contract}.${r.signature} on ${r.target})`);
        return { ...r, chain: fnReads[i].ok ? BigInt(fnReads[i].value) : null };
      });
      for (const u of unread) notes.push(`manager: ${u} could not be read; that row is unknown and judged by nothing`);
      // The lock, as this monitor saw it: the first run on this deployment (the state fingerprint) that read
      // every delayed lane at its manifest delay. After it, a lane back at 0 is a lock undone, not the launch window.
      const phase = managerDelayPhase(members);
      if (phase === "locked" && laneUnread === 0 && (state.managerLock ?? null) === null) state.managerLock = { block: head.number.toString(), at: Number(head.timestamp) };
      const lock = state.managerLock ?? null;
      return {
        findings: checkManagerWiring({ manager: C.accessManager, rows, members, lock, functions }),
        status: unread.length > 0 ? "incomplete" : "ok",
        detail: `${rows.length} roles and ${members.length} published holders checked against ops/abis/v2/roles.json; ${functions.length} selector roles on ${targets.length} targets${unnamed.length > 0 ? ` (no registry address for ${unnamed.join(", ")})` : ""}; delay table ${phase}${lock === null ? "" : ` (planned delays first seen at block ${lock.block})`}${unread.length > 0 ? `; ${unread.length} read(s) failed` : ""}`,
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
      const [balance, lastAt, cooldownRead] = await Promise.all([read(splitter, ABI.feeSplitter, "buybackBalance"), read(splitter, ABI.feeSplitter, "lastBuybackAt"), read(splitter, ABI.feeSplitter, "buybackCooldown")]);
      if (!balance.ok) notes.push(`flywheel: FeeSplitter.buybackBalance() could not be read (${balance.error}); the buyback check treats the balance as unknown and pages nothing about it`);
      if (!lastAt.ok) notes.push(`flywheel: FeeSplitter.lastBuybackAt() could not be read (${lastAt.error})`);
      if (!cooldownRead.ok) notes.push(`flywheel: FeeSplitter.buybackCooldown() could not be read (${cooldownRead.error}); the buyback check counts no cooldown`);
      // 0 from the contract means NEVER, not 1970: buybackClock maps it to null so no age is computed from it.
      const lastBuybackAt = lastAt.ok ? buybackClock(lastAt.value) : null;
      const floorMisses = Object.entries(fly.floorMisses ?? {}).map(([asset, v]) => ({ asset, ticker: tickerOf(asset), ...v }));
      const out = [
        ...checkSplitter({ splitter, now: head.timestamp, lastDistributedAt: fly.lastDistributedAt, pendingSince: fly.pendingSince, floorMisses }, t),
        ...checkBuyback({ splitter, now: head.timestamp, balance: balance.ok ? balance.value : null, lastBuybackAt, cooldownS: cooldownRead.ok ? Number(cooldownRead.value) : null, fundedSince: fly.fundedSince, lastSkip: fly.lastSkip, unburned }, t),
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
      // The pool the executor really trades: its one immutable PoolKey, against the pinned one.
      const executor = reg.flywheel?.buybackExecutor ?? null;
      const liveRead = executor === null ? null : await read(executor, ABI.buybackExecutor, "key");
      if (executor === null) notes.push("tokenpool: the registry publishes no v2.flywheel.buybackExecutor, so the pool the buyback really trades is not compared with shared.token.poolKey");
      else if (!liveRead.ok) notes.push(`tokenpool: BuybackExecutor.key() could not be read (${liveRead.error}); the pool it trades is not compared with shared.token.poolKey`);
      const liveKey = liveRead?.ok ? liveRead.value : null;
      // The executor's own fee read and cap. feeBps() FAILS CLOSED like buy(): a NoSource or CeilingExceeded
      // revert is the executor refusing every buyback. Any other failure (no such view on an older executor, the RPC) is
      // unknown and noted, never read as fees of 0.
      let fees = null;
      let feesRefusal = null;
      let maxTotalFeeBps = null;
      // A fee read that is not one of the executor's own refusals leaves the hook-fee and fee-cap findings
      // unjudged, so the check is incomplete and an open v2_mon_token_pool_fee is kept. Both views are in
      // V4BuybackExecutor's first version (before the v8 deploy), so no failure is "an older executor".
      let feesUnread = false;
      if (executor !== null) {
        try {
          const f = await client.readContract({ address: executor, abi: ABI.buybackExecutor, functionName: "feeBps", blockNumber: head.number });
          fees = { v3: f[0], v4Lp: f[1], v4Protocol: f[2], hook: f[3], creatorTax: f[4], total: f[5] };
        } catch (error) {
          const raw = (revertDataOf(error) ?? "").toLowerCase().slice(0, 10);
          feesRefusal = EXECUTOR_FEE_REFUSALS[raw] ?? null;
          if (feesRefusal === null) {
            feesUnread = true;
            notes.push(`tokenpool: BuybackExecutor.feeBps() could not be read (${shortError(error)}); the hook fee and the combined fee cap are not judged, and the check is incomplete`);
          }
        }
        const cap = await read(executor, ABI.buybackExecutor, "maxTotalFeeBps");
        if (cap.ok) maxTotalFeeBps = Number(cap.value);
        else {
          feesUnread = true;
          notes.push(`tokenpool: BuybackExecutor.maxTotalFeeBps() could not be read (${cap.error}); the combined fee cap is not judged, and the check is incomplete`);
        }
      }
      // The depth is v4 PoolManager state and the registry publishes no PoolManager, so it is UNKNOWN here rather
      // than 0. checkTokenPool pages on an unknown depth only when an operator set a floor to compare it against.
      return {
        findings: checkTokenPool({ poolId: reg.token.poolId, poolKey: key, recomputedPoolId: recomputed, liveKey, executor, depth: null, fees, feesRefusal, maxTotalFeeBps }, t),
        status: t.tokenPoolMinDepth > 0 || liveKey === null || feesUnread ? "incomplete" : "ok",
        detail: `pool ${reg.token.poolId ?? "(unpublished)"} fee ${key.fee} (${Number(key.fee) / 100} bps), tickSpacing ${key.tickSpacing}, hooks ${key.hooks}; ${liveKey === null ? "the executor's key() not read" : "the executor's key() is the pinned one unless paged"}; depth unknown (no v4 PoolManager in the registry)`,
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
      return {
        findings,
        // `ok` only when every balance and totalSupply were read. A failed read makes tvlFaults emit the
        // :fault finding and checkTvl return it INSTEAD of :full / :half, so completing on it (the old `complete ||
        // faulted`) resolved an open "the audit is due now" page on one 429. The :fault finding is still emitted, and
        // reconcile remembers it either way; the next complete run resolves what is gone.
        status: complete && supplyRead.ok ? "ok" : "incomplete",
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
      const housePins = await housePinsForVouch();
      targetList.forEach((x, i) => {
        x.pinnedBy = must(by[i], `SettlementOracle.pinnedBy(${tickerOf(x.u)}, ${x.e})`);
        out.push(...checkPinnedBy({ ticker: tickerOf(x.u), underlying: x.u, oracle: C.settlementOracle, expiry: x.e, pinnedBy: x.pinnedBy, clearinghouse: C.clearinghouse, hasSeries: x.hasSeries, houses: housePins }));
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
        // An expiry nobody has minted is not pinned yet (PIN ON MINT); open interest tells the two apart.
        idx.openInterest = calls.push({ address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "openInterest", args: [x.u, x.e] }) - 1;
        if (reg.sources.chainlink) {
          idx.chainlink = calls.push({ address: reg.sources.chainlink, abi: ABI.chainlinkSource, functionName: "pinnedFeeds", args: [x.u, x.e] }) - 1;
          // Best effort: a v8 ChainlinkFeedSource has no band views, and a failed read compares nothing.
          idx.pinnedBand = calls.push({ address: reg.sources.chainlink, abi: ABI.chainlinkSource, functionName: "pinnedBands", args: [x.u, x.e] }) - 1;
          idx.band = calls.push({ address: reg.sources.chainlink, abi: ABI.chainlinkSource, functionName: "bands", args: [x.u] }) - 1;
        }
        if (reg.sources.univ3) idx.univ3 = calls.push({ address: reg.sources.univ3, abi: ABI.univ3, functionName: "pinnedPools", args: [x.u, x.e] }) - 1;
        if (reg.sources.dataStreams) {
          idx.dataStreams = calls.push({ address: reg.sources.dataStreams, abi: ABI.dataStreamsSource, functionName: "pinnedFeeds", args: [x.u, x.e] }) - 1;
          idx.feedVersion = calls.push({ address: reg.sources.dataStreams, abi: ABI.dataStreamsSource, functionName: "feedVersion", args: [x.u] }) - 1;
        }
        plan.push({ k, x, idx });
      }
      const res = await readMany(calls);
      let verifiedNow = 0;
      let unminted = 0;
      // Band views that failed other than by reverting (a v8 source has none and reverts): nothing
      // was compared, so the expiry is not marked verified (it would never be compared again), the pass is not cached,
      // and the check is incomplete so an open band v2_mon_pin_mismatch is kept.
      let unread = 0;
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
        // Needed only to excuse an unpinned expiry, so a failed read fails the check only there.
        const openInterest = pinned ? undefined : must(res[idx.openInterest], `Clearinghouse.openInterest(${where})`);
        const r = checkPinnedConfig({
          ...base,
          config: { pinned, sources: [...sources], maxDeviationBps: Number(dev), uncorroboratedDelay: Number(delay), spotMaxAge: Number(age) },
          chainlink: cl === null ? null : { feed: cl[0], maxStale: Number(cl[1]), maxRoundJumpBps: Number(cl[2]), pinned: cl[3], band: bandOf(res[idx.pinnedBand]), currentBand: bandOf(res[idx.band]) },
          univ3: uni === null ? null : { pool: uni[0], window: Number(uni[3]), pinned: uni[4], minLiquidity: uni[5] },
          dataStreams: ds === null ? null : { pinned: ds[0], version: ds[1], currentVersion: must(res[idx.feedVersion], `DataStreamsSource.feedVersion(${where})`) },
          openInterest,
        });
        if (r.unminted) unminted += 1;
        out.push(...r.findings);
        for (const n of r.notChecked ?? []) notes.push(`pins: ${where}: ${n}`);
        const bandLost = [idx.pinnedBand, idx.band].filter((j) => j !== undefined).map((j) => res[j]).find((b) => !b.ok && b.revert !== true);
        if (bandLost !== undefined) {
          unread += 1;
          notes.push(`pins: ${where}: the Chainlink band views could not be read (${bandLost.error}); the band is not compared, and the expiry is not marked verified`);
        }
        if (r.verified && scanUsable && bandLost === undefined) {
          s.pinsVerified[k] = 1;
          verifiedNow += 1;
        }
      }

      const span = creatable.length === 0 ? "" : ` (${iso(creatable[0])} to ${iso(creatable[creatable.length - 1])})`;
      const detail = `${ours.length} registered market(s) on the published oracle, ${creatable.length} creatable expiries${span}; ${targetList.length} pinnedBy read(s), ${sims.length} pin simulation(s) from the Clearinghouse, ${plan.length} expiries with series compared with the registry (${verifiedNow} verified now, ${Object.keys(s.pinsVerified).length} in all; ${unminted} not minted yet, so not pinned)`;
      const serial = JSON.parse(JSON.stringify(out, bigintReplacer));
      if (scanUsable && unread === 0) s.pinsCache = { key, at: wallNow, block: head.number.toString(), findings: serial, detail };
      return { findings: serial, status: scanUsable && unread === 0 ? "ok" : "incomplete", detail: `${detail}${unread > 0 ? `; ${unread} band read(s) failed` : ""}` };
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
          scopeUnread = missing.filter((_, i) => !rows[i].ok).map((m) => m.ticker);
          if (scopeUnread.length > 0) {
            notes.push(`scope: Clearinghouse.market() could not be read for ${scopeUnread.join(", ")} (${rows.find((r) => !r.ok).error}); whether ${scopeUnread.length === 1 ? "it is" : "they are"} registered is unknown, so rent, feeds, divergence, tokens, pools and pricing report incomplete`);
          }
          if (added.length > 0) {
            markets = [...markets, ...added];
            notes.push(
              `scope: ${added.map((m) => `${m.ticker} (registry says ${m.v2.status})`).join(", ")} ${added.length === 1 ? "is" : "are"} registered on the Clearinghouse, so ${added.length === 1 ? "it is" : "they are"} watched anyway; update ops/markets/tier1.json`,
            );
          }
        } catch (error) {
          scopeUnread = missing.map((m) => m.ticker);
          notes.push(`scope: could not read Clearinghouse.market() for the registry's non-live markets (${shortError(error)}); scope is the registry's live and paused markets only, and the checks that walk it report incomplete`);
        }
      }
    }

    // ---- writer rent (INTERFACE_VERSION 7) ----
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
      // A row that failed is not "not registered": chainPpm null drops v2_mon_mint_fee_charged:chain, so the
      // check is incomplete and an open one is kept.
      const rowsUnread = markets.filter((_, i) => !rows[i].ok).map((m) => m.ticker);
      if (rowsUnread.length > 0) notes.push(`rent: Clearinghouse.market() could not be read for ${rowsUnread.join(", ")} (${rows.find((r) => !r.ok).error}); their rate is not judged, and the check is incomplete`);
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
      return { findings: out, status: scanUsable && rowsUnread.length === 0 && scopeUnread.length === 0 ? "ok" : "incomplete", detail: `${judged} series' rent ledgers checked; rates ${rates.join(", ")}${scopeNote()}` };
    });

    await run("feeds", async (out) => {
      if (markets.length === 0) return { status: "skipped", detail: "no market in scope" };
      const safes = new Map();
      const details = [];
      // A pinned feed whose reads failed other than by reverting is not "no aggregator()": skipped, its open
      // v2_mon_feed_access_controller resolved. It is unread, its baseline is left as it was, and the check is incomplete.
      let unread = 0;
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
        // An unread decimals() is not 8; the round-jump text then shows the raw answers and says so.
        out.push(...checkRoundJumps(rounds, { ticker: m.ticker, feed, decimals: dec.ok ? Number(dec.value) : null }, t));
        const latestRound = must(latest, "latestRoundData");
        const published = expectedPinnedConfig(reg, m); // The market's spotMaxAge and maxStale for the page text
        out.push(...checkFeedStale({ ticker: m.ticker, feed, now: head.timestamp, roundId: latestId, updatedAt: Number(latestRound[3]), heartbeatS: m.feedHeartbeatS, sourceCount: m.v2.univ3Pool === null || m.v2.univ3Pool === undefined ? 1 : 2, spotMaxAgeS: published.spotMaxAge ?? null, maxStaleS: published.maxStale ?? null }, t));
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
            if (!p.ok) {
              // Every deployed source has pinnedFeeds (since before the v8 deploy), so any failure is unread.
              unread += 1;
              notes.push(`feeds: ${m.ticker} expiry ${iso(x.e)} pinnedFeeds could not be read (${p.error}); a feed pinned for it is not checked, and the check is incomplete`);
              continue;
            }
            if (p.value[3] !== true) continue;
            const pinned = p.value[0];
            if (sameAddress(pinned, ZERO) || seen.has(lc(pinned))) continue;
            seen.add(lc(pinned));
            const [pagg, pac, pown] = await Promise.all([read(pinned, ABI.feed, "aggregator"), read(pinned, ABI.feed, "accessController"), read(pinned, ABI.feed, "owner")]);
            const plost = [pagg, pac, pown].find((r) => !r.ok && r.revert !== true);
            if (plost !== undefined) {
              unread += 1;
              notes.push(`feeds: ${m.ticker} feed ${pinned} pinned for ${iso(x.e)} could not be read (${plost.error}); its proxy checks are not made, its baseline is kept, and the check is incomplete`);
              continue;
            }
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
      return { status: unread === 0 && scopeUnread.length === 0 ? "ok" : "incomplete", detail: `${details.join("; ")}${unread > 0 ? `; ${unread} pinned-feed read(s) failed` : ""}${scopeNote()}` };
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
      return { status: incomplete || scopeUnread.length > 0 ? "incomplete" : "ok", detail: `${detail.join("; ")}${scopeNote()}` };
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
      // Keep only the event this scan asked for. A node (or the test chain) that answers with other logs
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
      // The launch tokens' OraclePaused() / OracleUnpaused() logs over a bounded range that starts
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
        status: r.caughtUp && scopeUnread.length === 0 ? "ok" : "incomplete",
        detail: `${markets.map((m) => m.ticker).join(", ")}: flags, multipliers, isBlocked of ${watched.length} contract(s) + pool; ${eventCount} UIMultiplierUpdated since block ${from}${haltNote}${scopeNote()}`,
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
      // The source's pools() and observeWindow() are unread when they fail: judged without them, a pool's
      // v2_mon_pool_wiring was not checked and its thinness was measured against the registry floor or the head alone,
      // so the check is incomplete and an open alert is kept. Every deployed UniV3TwapSource has both views.
      let unread = 0;
      for (const m of withPool) {
        const liq = must(await read(m.v2.univ3Pool, ABI.pool, "liquidity"), `${m.ticker} pool liquidity()`);
        let sourceFloor = null;
        if (reg.sources.univ3) {
          const p = await read(reg.sources.univ3, ABI.univ3, "pools", [m.asset]);
          if (!p.ok) {
            unread += 1;
            notes.push(`pools: ${m.ticker} UniV3TwapSource.pools could not be read (${p.error}); the source's pool and floor are not judged, and the check is incomplete`);
          }
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
        // The floor gates the window's harmonic-mean liquidity. observeWindow never reverts; all zero means the
        // pool did not answer (no pool on the source, or the ring does not reach back), which is unread, not 0.
        let harmonic = null;
        if (reg.sources.univ3 && sourceFloor !== null) {
          const w = await read(reg.sources.univ3, ABI.univ3, "observeWindow", [m.asset, head.timestamp - SETTLEMENT_WINDOW, head.timestamp]);
          if (w.ok && (w.value[0] === true || BigInt(w.value[3]) > 0n)) harmonic = BigInt(w.value[3]);
          else notes.push(`pools: ${m.ticker} UniV3TwapSource.observeWindow over the last ${duration(SETTLEMENT_WINDOW)} ${w.ok ? "got no answer from the pool" : `could not be read (${w.error})`}; judged on the head's liquidity() alone${w.ok ? "" : ", and the check is incomplete"}`);
          if (!w.ok) unread += 1;
        }
        const px = { ticker: m.ticker, pool: m.v2.univ3Pool, liquidity: liq, harmonic, floor: m.v2.univ3MinLiquidity, sourceFloor, open, chainlinkOk: null, lockSeen: (state.managerLock ?? null) !== null };
        // Only a thin pool needs to know whether Chainlink prices the market on its own: one read then.
        if (checkPool(px, t).length > 0 && reg.sources.chainlink) {
          const cl = await read(reg.sources.chainlink, ABI.chainlinkSource, "latest", [m.asset]);
          if (cl.ok) px.chainlinkOk = cl.value[0] === true;
          else notes.push(`pools: ${m.ticker} ChainlinkFeedSource.latest could not be read (${cl.error}); the thin-pool page does not say whether Chainlink prices the market`);
        }
        out.push(...checkPool(px, t));
        // The figure the page judges, min(head, window harmonic mean), not the head alone.
        const judgedLiq = harmonic !== null && harmonic < liq ? harmonic : liq;
        details.push(`${m.ticker} ${(sourceFloor ?? m.v2.univ3MinLiquidity) === null ? "no floor" : `${(judgedLiq * 100n) / ((sourceFloor ?? m.v2.univ3MinLiquidity) || 1n)}% of floor${harmonic !== null && harmonic < liq ? " (window mean)" : ""}`}`);
      }
      return { findings: out, status: unread === 0 && scopeUnread.length === 0 ? "ok" : "incomplete", detail: `${details.join(", ")}${unread > 0 ? `; ${unread} source read(s) failed` : ""}${scopeNote()}` };
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

  // ---- pricing inputs: priceability, source clocks, provider/method switches, pricer work ----
  //
  // Read-only GETs against what the two services serve TODAY. What they do not serve is said, not invented:
  // the indexer's /v2/config.services does not exist, and the /fair body carries no provenance
  // yet, so provider, method and the quote / volatility clocks are reported "not served" rather
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
    // The event calendar's re-check days, from the same /health read.
    const recheck = checkEventRecheck(health.body.eventRecheck);
    sink.push(...recheck.findings);
    if (!recheck.served) {
      notes.push("pricing: /health carries no `eventRecheck` (a build before T-OP-392, or one booted with no events file), so an overdue event-calendar re-check is unknown, not clear");
    } else if (recheck.overdue.length > 0) detail.push(`event calendar re-check overdue: ${recheck.overdue.join(", ")}`);
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

      // Source clocks. Only clocks a body STATES in unix seconds are used: the pricing provenance clocks when a
      // build serves them, else the legacy `asOf`, the chain's pricing clock (Cboe's underlying last trade, Massive's newest quote). /health's
      // `lastTradeTime` and `chainTimestamp` are the provider's own text in an unstated zone, so they are shown
      // verbatim and never parsed into an age — a guessed clock is exactly what the source-clock rule forbids.
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

      // An unknown age prints "unknown". It is never printed, stored or compared as 0.
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
      detail: `${readyRows.length - notReady} of ${readyRows.length} market-tenor(s) ready; ${detail.join("; ")}${scopeNote()}`,
      status: incompleteWhy === null && scopeUnread.length === 0 ? "ok" : "incomplete",
    };
  });

  // ---- dedupe and delivery ----
  const { send, resolved, held } = reconcile(state.alerts, findings, { completed, nowS: wallNow, repeatS: t.repeatS, eventRetentionS: t.eventRetentionS, graceS: t.alertGraceS });
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
      // The configured file now holds the latest state, so the fallback is spent.
      if (retireFallback !== null) {
        try {
          rmSync(retireFallback, { force: true });
        } catch (error) {
          notes.push(`state: the spent fallback ${retireFallback} could not be removed (${shortError(error)}); a later run reads it only if it is newer`);
        }
      }
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
    // Conditions waiting out --alert-grace-seconds; nothing was sent for them, and the loop wakes when
    // the soonest grace ends (nextPassDelayMs).
    held,
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
  const held = r.held ?? [];
  for (const h of held) lines.push(`  HOLD grace     ${h.id} (open ${h.openS} s; ${h.remainingS > 0 ? `pages in ${h.remainingS} s if still open` : "grace over, pages when found again"})`);
  for (const s of r.resolved) lines.push(`  ${how(s)} resolved  ${s.resolvedKind}  ${s.message}`);
  const open = r.findings.filter((f) => RANK[f.severity] >= RANK.warn).length;
  lines.push(
    `summary: ${r.findings.length} finding(s) (${open} warn/error), ${r.sent.length} alert(s) to send${held.length > 0 ? `, ${held.length} held (alert grace)` : ""}, ${r.resolved.length} resolved, ${r.incompleteChecks.length} incomplete check(s), ${r.deliveryFailures} delivery failure(s); exit ${r.exit}`,
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
      // A held condition is neither a delivery nor a failure: `mute` counts deliveryFailures only.
      return { code: report.exit, mute: report.deliveryFailures > 0, held: report.held };
    } catch (error) {
      if (error instanceof UsageError) {
        process.stderr.write(`monitor: ${error.message}\n`);
        return { code: 2, mute: true, held: [] };
      }
      process.stderr.write(`monitor: run failed: ${shortError(error)}\n`);
      return { code: 3, mute: true, held: [] };
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
    const { code, mute, held } = await once();
    if (code === 2) process.exit(2);
    // Nothing watches this process, and the relay cannot report on itself. A loop that
    // keeps running while every page is refused is silent for ever, so ride out a blip and then exit, which
    // is the one out-of-band signal there is: the platform restarts the service and notifies.
    mutePasses = mute ? mutePasses + 1 : 0;
    if (opts.maxFailedPasses > 0 && mutePasses >= opts.maxFailedPasses) {
      process.stderr.write(`monitor: ${mutePasses} consecutive passes reached nobody (exit ${code}); exiting ${code} so the platform restarts and notifies\n`);
      process.exit(code);
    }
    // A condition waiting out its alert grace brings the next pass forward to when that grace ends.
    const wait = nextPassDelayMs({ intervalS: opts.intervalS, elapsedMs: Date.now() - started, held });
    await new Promise((resolve) => {
      wake = resolve;
      setTimeout(resolve, wait);
    });
    wake = null;
  }
  process.exit(0);
}

/* ---------------------------------------------------------------------------------------------- */
/*  v9 consumer fixes. Kept at the end of the file so the line numbers the runbooks             */
/*  cite above do not move (ops/runbooks.test.mjs checks them).                                   */
/* ---------------------------------------------------------------------------------------------- */

/**
 * The FeeSplitter's `DistributionSkipped` / `BuybackSkipped` reasons are `keccak256("<WORD>")` (FeeSplitter.sol:29-36,
 * `bytes32 private constant SKIP_NO_ROUTE = keccak256("NO_ROUTE")`, the same at the v8 deploy and at the v9
 * launch), NOT the word packed as ASCII. Read as ASCII a hash is a run of `?`s, so no `reason === "NO_EXECUTOR"`
 * test ever matched a real log and every skip paged with a garbled reason. Keyed lowercase. monitor.test.mjs
 * re-derives each hash with viem.keccak256, so none is trusted as typed.
 */
export const SKIP_REASON_HASHES = Object.freeze({
  "0xf3c1ad55b46202e5ad76cf05327db5bd6de722007926f3dbbe9fca2d6e46a6ae": "NO_ROUTE",
  "0x59e12a0ce6dbb6248bf5d62040f1ec5734df4fcac164f8b640eb66467363238d": "NO_SPOT",
  "0x1790e3a471f10baff397d66f9d3bfe35d2ae801b7550232fb27e87fed4785eb3": "BELOW_FLOOR",
  "0x950520086e7c8274ba61ca256162423db9fe7aed0055d5675e2a6c6068a320bc": "DUST",
  "0xe10557e1829c1de2a93bb5f94d6b77329584f2afcfd7a303c26b4f0d69a2b25f": "NO_EXECUTOR",
  "0x95c72b3f37a9b8db28d0acac9bcb142af1c15036043bf9c5cec575e54791060c": "EMPTY",
  "0x061e10cc0e67ebc6299672407b26735613dee6dc03df62c1a30b5120029c9dfc": "SHORT_RESERVE",
  // `conversionSlippageBps + routeFeeBps` at 100 % or more, reported as DUST before.
  "0xe27302bbd66b0af70433db532554a6c12e2576081c5f061d6e3de2d2cb438631": "HAIRCUT",
});

/**
 * v2_mon_splitter_floor_miss's explanation for a run of `DistributionSkipped` reasons that are not a floor miss, keyed
 * by the word; any other reason keeps the floor-miss text. These were split out of DUST:
 *   EMPTY   FeeSplitter._distribute with nothing of the asset held (`held == 0`).
 *   HAIRCUT slippage + route fee at 100 % or more. Unreachable while setConversionSlippageBps caps slippage at
 *           MAX_PAYOUT_SLIPPAGE_CEIL_BPS (300) and PayoutRouter refuses a route above MAX_ROUTE_FEE_TIER (100 bps).
 */
export const FLOOR_MISS_WHY = Object.freeze({
  EMPTY:
    "The splitter held none of this asset when distribute was called, so there was nothing to convert: this is not a floor miss and no route or pool is at fault. distribute(asset) is permissionless, so look at who is calling it on an empty balance; nothing is lost while it continues",
  HAIRCUT:
    "The configured conversion slippage plus the route's fee is 100 % or more, so no piece of any size can convert: a configuration error, not a thin pool. The fix is FEE_MANAGER lowering setConversionSlippageBps, or CONFIG_ADMIN re-pointing the route (roles.v8.json); the tokens are held, not dumped, meanwhile",
});

/**
 * checkBuyback's explanation for a fresh `BuybackSkipped` reason beyond NO_EXECUTOR and EMPTY, keyed by the word.
 *
 * SHORT_RESERVE (FeeSplitter._buyback, v9): `buybackBalance` is a counter the splitter
 * increments, not a measured balance, and the call refuses when the USDG it actually holds is below the per-call
 * amount. From v9 the only call that reaches any of these refusals is buybackWithDeadline(minTokenOut,
 * deadline); buyback(uint256) always reverts BuybackDeadlineRequired, so a cranker still on it is eventless.
 */
export const SKIP_WHY = Object.freeze({
  SHORT_RESERVE: (x) =>
    `buybackBalance says ${usdg(x.balance)} USDG but the splitter holds less USDG than the per-call amount (SEC-43): the counter is not a measured balance, so USDG that left without passing through the splitter (an issuer burn or freeze) left the reserve unspendable. The contract fails closed and does not write the hole off; recovery is more USDG arriving, and writing it off is a treasury decision`,
});

/**
 * SettlementOracle.HELD_RESOLVE_DELAY (private, v9 SettlementOracle.sol).
 * An expiry with no ok recorded price, pinned or not, resolves only once Held and from expiry + 7 days (before
 * that adminResolve reverts NoSource / TooEarly); a Held expiry with any ok price gets a wider band from then (_band).
 */
export const HELD_RESOLVE_DELAY = 7 * 86400;

/**
 * When adminResolve can settle a Held expiry, for the `v2_mon_settlement_held` page (checkExpiry).
 *   x.okCount: recorded sources that are ok once captured; null = not captured or not read.
 * Open interest means a series exists, so the expiry is pinned: with no ok price it resolves only a week after expiry.
 */
export function heldResolve(x) {
  const ok = x.okCount ?? null;
  const early = iso(x.expiry + RESOLVE_DELAY);
  const week = iso(x.expiry + HELD_RESOLVE_DELAY);
  const how =
    ok === 0
      ? `by adminResolve at any price from ${week}: no recorded source is ok, and an expiry with no price, pinned or not, resolves only once Held and a week after expiry (T-SEC-B-03, T-OP-831; adminResolve reverts TooEarly before then)`
      : ok === 1
        ? `by adminResolve from ${early} inside maxDeviationBps of its one ok price, or inside the wider 0.8x to 1.25x band from ${week}`
        : ok === null
          ? `by adminResolve from ${early} if the resolve's own refresh records an ok price, else only from ${week} (T-SEC-B-03)`
          : `by adminResolve from ${early} inside the band of its ${ok} ok recorded prices, or inside the wider 0.8x to 1.25x band of the lowest and highest of them from ${week}`;
  return { how, data: { resolvableAt: x.expiry + (ok === 0 ? HELD_RESOLVE_DELAY : RESOLVE_DELAY), okCount: ok } };
}

/*//////////////////////////////////////////////////////////////
              DAILY WEEKDAYS (end of file, so no cited line moves)
//////////////////////////////////////////////////////////////*/

/** The registry's weekday names, in order. Mirrors keeper/src/v2/registry.ts WEEKDAYS. */
export const DAILY_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];
const UTC_DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** A `dailyWeekdays` list as the registry writes it, or null when absent. A malformed list throws, naming `where`. */
function weekdayListOrNull(value, where) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length === 0 || !value.every((d) => DAILY_WEEKDAYS.includes(d)) || new Set(value).size !== value.length) {
    throw new Error(`${where} must be a non-empty list of distinct weekdays (${DAILY_WEEKDAYS.join(", ")}), not ${JSON.stringify(value)}`);
  }
  return [...value];
}

/**
 * Whether a daily close at `expiry` may list, by the UTC day of the close (keeper/src/v2/registry.ts listsDailyOn):
 * false only on a Mon-Fri day the list leaves out. A null list (not known) restricts nothing.
 */
export function listsDailyOnWeekday(days, expiry) {
  if (days === null) return true;
  const day = UTC_DAY_NAMES[new Date(expiry * 1000).getUTCDay()];
  return !DAILY_WEEKDAYS.includes(day) || days.includes(day);
}

/**
 * Whether a House boundary has no series BY DESIGN, and why: the market lists no dailies (SPCX), or
 * the boundary's close is on a weekday it lists no dailies on (NVDA Tue/Thu). A series the scan saw at the expiry, or a
 * market the registry does not describe, is never by design.
 */
export function houseNoSeriesByDesign(v2, epochEnd, seriesAtBoundary) {
  if (seriesAtBoundary || v2 === null) return { noSeriesByDesign: false };
  if (v2.dailyExpiriesAhead === 0) return { noSeriesByDesign: true };
  if (!listsDailyOnWeekday(v2.dailyWeekdays ?? null, epochEnd)) return { noSeriesByDesign: true, byDesignReason: `lists dailies on ${v2.dailyWeekdays.join(", ")} only` };
  return { noSeriesByDesign: false };
}

/*//////////////////////////////////////////////////////////////
       THE HOUSE BOUNDARY LOCK (end of file, so no cited line moves)
//////////////////////////////////////////////////////////////*/

/**
 * HouseVault.UNPINNED_BOUNDARY_HOLD (private, HouseVault.sol): how long past its end a
 * boundary the vault did not lock before money was exposed to it waits before rollEpoch prices it
 * (TooEarly(epochEnd + UNPINNED_BOUNDARY_HOLD)). Declared in contract-mirrors.list.mjs, so a changed value goes red.
 */
export const UNPINNED_BOUNDARY_HOLD = 7 * 86400;

/**
 * A House vault freezes its boundary's settlement configuration on its oracle as the
 * epoch opens (SettlementOracle.pinBoundary; the first deposit into an empty vault too) and records it in
 * `pinnedBoundary`. The pin is best effort: a refusal (the oracle's `houseVaultFactory` unset or another factory, an
 * empty market, a source that will not pin) logs BoundaryPinFailed and the deposit or roll goes on; `setOracle` clears
 * it. A boundary money is exposed to (shares exist, or a deposit is queued) that the vault did not lock is then:
 *   - before its end: `v2_mon_house_boundary_unlocked`, WARN. Nothing is priced yet, but a CONFIG_ADMIN setMarket
 *     still reaches it, and the cause can be fixed before the next boundary;
 *   - from its end until end + UNPINNED_BOUNDARY_HOLD: `v2_mon_house_roll_held`, ERROR. rollEpoch refuses TooEarly
 *     until then, so every deposit and withdrawal queued for the boundary is stuck for up to a week, nothing can
 *     shorten it, and depositors need to be told.
 * Past the hold nothing here: the roll goes through, and a roll that still does not happen is the stall check's.
 * The existing `v2_mon_house_boundary_unpinned` is the ORACLE's view (no pin of the expiry at all, from the mint
 * cutoff); this is the VAULT's, and differs when a mint pinned the expiry but the vault's own pin failed: the
 * configuration is frozen then, yet the vault still holds its roll.
 *   x = { address, ticker, oracle, epochId, epochEnd, now, pinnedBoundary: number | null, exposed: boolean | null,
 *         lockSeen (`state.managerLock` is set, so the advice names the Admin Safe as GUARDIAN) }
 *   (null = not read: never judged)
 */
export function checkHouseBoundaryLock(x) {
  if (x.pinnedBoundary === null || x.exposed !== true || x.epochEnd === 0 || x.pinnedBoundary === x.epochEnd) return [];
  const until = x.epochEnd + UNPINNED_BOUNDARY_HOLD;
  if (x.now >= until) return [];
  const where = `${x.ticker} HouseVault ${shortAddr(x.address)}`;
  const why = `money is exposed to its boundary ${iso(x.epochEnd)} (shares, or a queued deposit) but the vault did not lock it: pinnedBoundary() is ${x.pinnedBoundary === 0 ? "0" : iso(x.pinnedBoundary)}, not epochEnd, so its own SettlementOracle.pinBoundary on ${shortAddr(x.oracle)} failed (a BoundaryPinFailed log names why: houseVaultFactory() unset or not this vault's factory, an empty market, a source that will not pin) or setOracle cleared it (T-OP-866)`;
  const data = { address: x.address, ticker: x.ticker, oracle: x.oracle, epochId: String(x.epochId), epochEnd: x.epochEnd, pinnedBoundary: x.pinnedBoundary, heldUntil: until };
  const key = `${lc(x.address)}:${x.epochEnd}`;
  if (x.now < x.epochEnd) {
    return [
      finding(
        "v2_mon_house_boundary_unlocked",
        key,
        "house",
        `${where} epoch ${x.epochId}: ${why}. Until the boundary's sources are captured a CONFIG_ADMIN SettlementOracle.setMarket for ${x.ticker} still changes what it settles on, and rollEpoch will refuse TooEarly until ${iso(until)}, a week after the close, so holders see such a change before it prices them; every deposit and withdrawal queued for this boundary waits until then. ACTION: fix the pin's cause before the next boundary (the vault pins again as that epoch opens); the ${guardianBy(x.lockSeen)} cancels any scheduled setMarket of ${x.ticker} until this boundary is rolled.`,
        data,
      ),
    ];
  }
  return [
    finding(
      "v2_mon_house_roll_held",
      key,
      "house",
      `${where} epoch ${x.epochId} ended ${duration(x.now - x.epochEnd)} ago and rollEpoch is HELD until ${iso(until)} (${duration(until - x.now)} from now): ${why}. Every deposit and withdrawal queued for this boundary is stuck until then and nothing can shorten the hold; the keeper rolls it at ${iso(until)}. ACTION: tell the depositors; the ${guardianBy(x.lockSeen)} cancels any scheduled setMarket of ${x.ticker} and any scheduled adminResolve of this expiry that is not at the market's window price until the roll; fix the pin's cause before the next boundary.`,
      data,
    ),
  ];
}

/**
 * Who acts as GUARDIAN in a page's advice. The one-transaction
 * `stonkctl lock` revokes the guardian key's GUARDIAN: after it ONLY the Admin Safe can veto, cancel or pause, so advice
 * that says "GUARDIAN: veto" must say to sign it from the Admin Safe, not with the guardian key. `lockSeen` is this
 * monitor's `state.managerLock` (it has read every delayed lane at its manifest delay); before that the text is unchanged.
 */
export function guardianBy(lockSeen) {
  return lockSeen === true ? "GUARDIAN (the Admin Safe: after the lock the guardian key holds no GUARDIAN, owner R4; sign it from the Admin Safe)" : "GUARDIAN";
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) await main();
