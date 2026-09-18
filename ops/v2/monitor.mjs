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
 *   rent         INTERFACE_VERSION 7's writer rent: a live market whose MarketConfig.mintFeePpm is 0 (with the
 *                primary premium fee at 0 that market charges writers nothing — the runtime twin of the deploy
 *                blocker), a registry with no rate for a market, and each series' rent ledger from the chain's own
 *                logs (Minted.fee in, Closed.feeRefund out, MintFeesAccrued at settlement) not adding up
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
 *   tokens       Stock Token paused(), oraclePaused(), UIMultiplierUpdated, a staged multiplier
 *                (newUIMultiplier != uiMultiplier), isBlocked for our contracts on the token's
 *                ACCESS_CONTROLLED_REGISTRY
 *   usdg         USDG paused(), isFrozen of our contracts
 *   pools        in-range liquidity below the registry's univ3MinLiquidity (the TWAP floor)
 *   head         the L2 head timestamp more than 60 s behind the wall clock
 *   health       optional GET of each service's /health (--health name=url): cranker, mm-bot,
 *                pricer, pricing, notifier, indexer-v2, relay
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
 *   --tickers A,B           limit the feed / token / pool checks to these markets
 *   --all-markets           include `planned` v2 markets in those checks (default: live and paused)
 *   --threshold NAME=VALUE  repeatable [MONITOR_THRESHOLDS="lateS=7200,…"]; names in DEFAULTS below
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
/** OrderBook.setFeeParams schedules a change this far ahead (effectiveAt = block.timestamp + FEE_CHANGE_DELAY). */
export const FEE_CHANGE_DELAY = 86400;
/** UniV3PayoutAdapter.setRoute refuses a pool fee tier (hundredths of a bip) above this. */
export const MAX_ROUTE_FEE_TIER = 10_000;
/** INTERFACE_VERSION 7 (c05): the ceiling of MarketConfig.mintFeePpm, millionths of collateral per MINT_FEE_PERIOD. */
export const MINT_FEE_CEIL_PPM = 5_000;
/** INTERFACE_VERSION 7 (c05): rent is quoted per this much remaining life, seconds. */
export const MINT_FEE_PERIOD = 7 * 86400;
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

/** keccak256 of the V2Constants role and bounty action names (cast keccak <NAME>). */
export const ROLE_NAMES = {
  "0x0000000000000000000000000000000000000000000000000000000000000000": "DEFAULT_ADMIN_ROLE",
  "0x55435dd261a4b9b3364963f7738a7a662ad9c84396d64be3365284bb7f0a5041": "GUARDIAN_ROLE",
  "0xc6823861ee2bb2198ce6b1fd6faf4c8f44f745bc804aca4a762f67e0d507fd8a": "PRICER_ROLE",
  "0x9a04aea0a349253cc7277afafdf6ead6729a3972a47ffb40eaef2c93d4e1bfea": "QUOTER_ROLE",
};
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
  /**
   * The pins check re-reads the chain at most this often (wall-clock seconds) unless this run's log scan saw a pin or
   * wiring log (any log of the oracle, a source or the calendar; a Clearinghouse market or calendar change), the
   * creatable expiries or the series expiries changed, or the registry did. Between recomputes its findings are served
   * from the state file.
   */
  pinCheckS: 900,
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
  v2_mon_feed_round_jump: { severity: "warn", event: true, runbook: `${AL} §V29; ${IR} §1` },
  v2_mon_feed_stale: { severity: "error", runbook: `${AL} §V44; ${IR} §7` },
  v2_mon_token_paused: { severity: "error", runbook: `${AL} §V30; ${IR} §6` },
  v2_mon_oracle_paused: { severity: "warn", runbook: `${AL} §V30; ${IR} §2` },
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
  v2_mon_mint_rent: { severity: "error", runbook: `${AL} §V47; ${IR} §9` },
  v2_mon_mint_fee_zero: { severity: "error", runbook: `${AL} §V47; ${IR} §9` },
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
 *         spotOk, spot, spotUpdatedAt, delegate (false = the writer revoked the roller: nobody can cancel),
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
 *         paid, refunded, accrued (bigint), mints, zeroFeeMints, settled, complete }
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
 * INTERFACE_VERSION 7 (c05): the runtime twin of the deploy blocker (DECISIONS-2026-09-17 §11). With
 * `premiumFeeBps` 0 at launch, rent is the only writer fee there is, so a live market whose `MarketConfig.mintFeePpm`
 * is 0 charges writers nothing — and the series it creates keep that rate for their whole life.
 *
 *   x = { ticker, underlying, enabled, chainPpm (null = the market row was not read), registryPpm (null = the
 *         registry publishes none for it) }
 */
export function checkMintFee(x) {
  const out = [];
  const u = lc(x.underlying);
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

/** The feed owner Safe. `cur` = { nonce: bigint, threshold: bigint, owners: address[] }. */
export function checkSafe(prev, cur, ctx) {
  const findings = [];
  const safe = lc(ctx.safe);
  const owners = [...cur.owners].map(lc).sort();
  const next = { nonce: cur.nonce.toString(), threshold: cur.threshold.toString(), owners };
  if (prev !== undefined) {
    if (prev.nonce !== next.nonce) {
      findings.push(
        finding(
          "v2_mon_safe_nonce_changed",
          `${safe}:${next.nonce}`,
          "feeds",
          `Feed owner Safe ${ctx.safe} (owner of ${ctx.feeds.join(", ")}) executed a transaction: nonce ${prev.nonce} -> ${next.nonce}. Usually another feed; the aggregator and access-controller checks say whether ours changed`,
          { safe: ctx.safe, from: prev.nonce, to: next.nonce, feeds: ctx.feeds },
        ),
      );
    }
    if (prev.threshold !== next.threshold || prev.owners.join(",") !== owners.join(",")) {
      findings.push(
        finding(
          "v2_mon_safe_config_changed",
          `${safe}:${next.threshold}:${owners.join(",")}`,
          "feeds",
          `Feed owner Safe ${ctx.safe}: threshold ${prev.threshold} of ${prev.owners.length} -> ${next.threshold} of ${owners.length} owners`,
          { safe: ctx.safe, from: { threshold: prev.threshold, owners: prev.owners }, to: next },
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
});

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
export const DEDICATED_EVENTS = new Set(["FeeParamsScheduled", "RouteSet", "OracleSet", "ClearinghouseSet", "DataStreamsFeedSet"]);
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
 * warn: announced 24 h ahead, nothing rises. error: a fee rises or the maker rebate share falls, or the fees before
 * it are unknown (treated as a rise until someone checks).
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
        `OrderBook.setFeeParams scheduled ${describeFees(params)} from ${iso(effectiveAt)} (block ${e.blockNumber}, tx ${e.transactionHash}); ${what}. Every take from effectiveAt pays it, fills of resting orders included: makers who do not accept it cancel before then. Expected only from a planned owner change; if nobody owns it, treat the admin key as compromised`,
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
  "payoutAdapter",
  "makerVault",
  "makerRegistry",
  "rewardsDistributor",
];

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
    contracts,
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

function applyThreshold(thresholds, name, value) {
  if (!(name in DEFAULTS)) throw new UsageError(`unknown threshold "${name}" (one of: ${Object.keys(DEFAULTS).join(", ")})`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new UsageError(`threshold ${name}: not a non-negative number (${value})`);
  thresholds[name] = n;
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

export const USAGE = `usage: node ops/v2/monitor.mjs --rpc URL [--once | --interval S] [--registry FILE] [--state FILE]
       [--webhook URL] [--health name=url]... [--tickers A,B] [--all-markets] [--threshold name=value]...
       [--repeat-hours H] [--max-failed-passes N] [--no-alerts] [--json]
see the header of ops/v2/monitor.mjs; exit 0 clean, 1 findings open, 2 usage, 3 incomplete, 4 delivery failed
in --interval mode the process exits after --max-failed-passes consecutive passes that reached nobody (default 3, 0 = never)`;

export function parseArgs(argv, env = {}) {
  const thresholds = { ...DEFAULTS };
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
    tickers: null,
    allMarkets: false,
    dryRun: false,
    json: false,
    // Always-on mode only: consecutive passes that reached nobody (a refused delivery, or a pass that threw)
    // before the process gives up and exits with that pass's code, so the platform restarts it and notifies.
    // Nothing else watches the monitor (ops/alerts.md §V14). 0 disables it.
    maxFailedPasses: env.MONITOR_MAX_FAILED_PASSES ? Number(env.MONITOR_MAX_FAILED_PASSES) : 3,
    thresholds,
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
      case "--tickers":
        o.tickers = value(i, a).split(",").map((s) => s.trim()).filter(Boolean);
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
    },
    tokens: { cursor: null },
    feeds: {},
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
    return { ...fresh, ...s, scan: { ...fresh.scan, ...s.scan }, tokens: { ...fresh.tokens, ...s.tokens } };
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
    "function snapshots(address underlying, uint40 expiry) view returns (uint128 price, int24 meanTick, uint40 recordedAt)",
    "function pools(address underlying) view returns (address pool, bool usdgIsToken0, uint8 assetDecimals, uint32 window, uint128 minLiquidity)",
    "function pinnedPools(address underlying, uint40 expiry) view returns (address pool, bool usdgIsToken0, uint8 assetDecimals, uint32 window, bool pinned, uint128 minLiquidity)",
  ],
  chainlinkSource: [
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
  makerVault: [
    "function limits() view returns ((uint64 maxSeriesUnits, uint128 maxTotalNotional, uint16 askToleranceBps, uint16 maxBidBpsOfSpot, uint32 maxOrderLifetime, uint128 maxDailyOutflow))",
    "function outflow() view returns (uint256 used, uint256 available)",
    "function totalNotional() view returns (uint256)",
    "function trackedSeries() view returns (uint256[])",
    "function exposure(uint256 longId) view returns (uint256 units, uint256 notional, (uint256 longs, uint256 shorts, uint256 bids, uint256 resale, uint256 writes, uint256 live) detail)",
  ],
  erc20: ["function balanceOf(address account) view returns (uint256)"],
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
};

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
  "event StaleAskCancelled(address indexed writer, address indexed underlying, uint256 longId, uint256 orderId, uint256 spot, uint256 updatedAt)",
  "event StrategyStopped(address indexed writer, address indexed underlying)",
];
const TOKEN_EVENTS = ["event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)"];

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

/** DataStreamsSource's FeedSet(address, bytes32) and FeedPinned(..., bytes32, uint64) get names of their own. */
export function scanEventName(log) {
  const a = log.args ?? {};
  if (log.eventName === "FeedSet" && a.feedId !== undefined) return "DataStreamsFeedSet";
  if (log.eventName === "FeedPinned" && a.feedId !== undefined) return "DataStreamsFeedPinned";
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
        scan.roller[rollerKey(a)] = { w: a.writer, u: a.underlying, e: Number(a.expiry) };
        break;
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
        if (CONFIG_EVENTS[eventName] !== undefined || DEDICATED_EVENTS.has(eventName)) configEvents.push(log);
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
  const tickerOf = (address) => reg.markets.find((m) => sameAddress(m.asset, address))?.ticker ?? shortAddr(address);
  const C = reg.contracts;
  const chainChecks = ["scan", "settlement", "backlog", "rewards", "vault", "roller", "rent", "config", "fees", "pins", "feeds", "tokens", "usdg", "pools"];
  const names = contractNames(reg);

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
    const protocolAddresses = [...CONTRACT_NAMES.map((n) => C[n]), reg.sources.chainlink, reg.sources.univ3, reg.sources.dataStreams].filter(Boolean);
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
      if (C.autoRoller === null || C.orderBook === null || C.settlementOracle === null) {
        return { status: "skipped", detail: "no AutoRoller, OrderBook or SettlementOracle in the registry" };
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
      if (live.length > 0) {
        const orders = must(await read(C.orderBook, ABI.orderBook, "getOrders", [live.map((x) => x.orderId)]), "OrderBook.getOrders");
        // Cancelled, filled out or past validUntil: cancelStale returns false for all three and there is nothing to buy.
        const candidates = live.filter((x, i) => {
          const o = orders[i];
          x.order = o;
          return o !== undefined && o.cancelled !== true && BigInt(o.units) > BigInt(o.filled) && now < Number(o.validUntil);
        });
        for (const x of live) if (!candidates.includes(x)) delete s.rollerStale[x.key];
        const assets = [...new Map(candidates.map((x) => [lc(x.p.u), x.p.u])).values()];
        const [spotRows, seriesRows, delegateRows] = await Promise.all([
          readMany(assets.map((u) => ({ address: C.settlementOracle, abi: ABI.oracle, functionName: "trySpot", args: [u] }))),
          readMany(candidates.map((x) => ({ address: C.clearinghouse, abi: ABI.clearinghouse, functionName: "series", args: [x.longId] }))),
          readMany(candidates.map((x) => ({ address: C.orderBook, abi: ABI.orderBook, functionName: "isDelegate", args: [x.p.w, C.autoRoller] }))),
        ]);
        const spots = new Map(assets.map((u, i) => [lc(u), spotRows[i]]));
        candidates.forEach((x, i) => {
          const ser = must(seriesRows[i], `series(${x.longId})`);
          const sp = spots.get(lc(x.p.u));
          // A reverting trySpot is the oracle's own alarm (v2_mon_oracle_paused, v2_mon_feed_stale), not this one's:
          // cancelStale returns false without a fresh spot, and so does this check.
          const [spotOk, spot, spotUpdatedAt] = sp.ok ? sp.value : [false, 0n, 0n];
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
        detail: `${pairs.length} rolled position(s), ${live.length} with a live ask, ${overtakenNow} at or past the strike`,
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
      const out = [
        ...configEventFindings(
          configEvents.filter((e) => !DEDICATED_EVENTS.has(e.eventName)),
          adopt,
          names,
        ),
        ...feeScheduledFindings(schedules, adopt),
        ...adminEventFindings(configEvents, adopt, ctx),
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
      const r = await getLogsChunked(client, { address: markets.map((m) => m.asset), event: tokenAbi[0] }, from, head.number, t, async (logs, end) => {
        const events = logs.map((log) => ({
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
      return {
        status: r.caughtUp ? "ok" : "incomplete",
        detail: `${markets.map((m) => m.ticker).join(", ")}: flags, multipliers, isBlocked of ${watched.length} contract(s) + pool; ${eventCount} UIMultiplierUpdated since block ${from}`,
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
