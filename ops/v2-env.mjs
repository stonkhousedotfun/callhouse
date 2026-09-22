#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * ops/v2-env.mjs — one environment file per v2 service, from the market registry.
 *
 * Renders ops/v2/env/<service>.env for the six v2 processes: indexer-v2, cranker, pricing, mm-bot,
 * pricer and notifier. Each file is that service's whole PUBLIC environment, in the variable names
 * of the v2 service configuration: contract addresses and the start block
 * from the registry's top-level `v2` block (ops/markets/tier1.json), ports, Railway private-network
 * URLs between the services, the public RPCs, the registry path inside the image.
 * ops/go-live-v2.sh sets them on Railway (ops/deploy.md §15); the files are committed so a
 * reviewer sees every value before it is set.
 *
 * NO SECRET IS EVER WRITTEN. Every secret a service needs appears as a comment naming it and where
 * it comes from (`# CRANKER_PK=<secret: ...>`), never as an assignment. The renderer refuses to
 * emit an assignment for any name in SECRETS, so a later edit cannot slip a key line in: a bot key
 * in a committed file is a key published.
 *
 * WHY GENERATED. Six services times a dozen addresses is where a hand-copied address goes stale:
 * the v2 deploy writes the addresses back into the registry once, and this renders them
 * everywhere. A contract not recorded in this registry (null) renders as an EMPTY value with a
 * comment, so a service booted on the file refuses to start and names the variable, rather
 * than running against a guessed address. `--check` is the gate that keeps files and registry equal.
 *
 * DETERMINISTIC. The files carry no timestamp and nothing from the registry's generatedAt: a
 * registry rebuild that does not touch the v2 block leaves them byte-identical, and --check
 * compares bytes.
 *
 *   node ops/v2-env.mjs                          # render all six into ops/v2/env/
 *   node ops/v2-env.mjs --check                  # exit 1 if any file is missing, differs, or is stale
 *   node ops/v2-env.mjs --services cranker,pricing
 *   node ops/v2-env.mjs --registry R --out D     # render another registry (a fork rehearsal copy) into D
 *
 * Node 22+, no npm dependencies (it runs from a bare checkout, like ops/keeper-env.sh).
 * ------------------------------------------------------------------------------------------------- */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY = path.join(HERE, "markets", "tier1.json");
const OUT_DIR = path.join(HERE, "v2", "env");

/** Chain-wide public values, the same the v1 keeper files carry (ops/keeper-env.sh). */
const MAINNET_RPC_PRIMARY = "https://rpc.mainnet.chain.robinhood.com";
const MAINNET_RPC_BACKUP = "https://robinhood-rpc.publicnode.com";
const LOCAL_DEVNET_RPC = "http://127.0.0.1:8546";
const RELAY_ALERT_URL = "http://relay.railway.internal:8080/alert";
let APP_URL = "https://app.stonkhouse.fun";
/** Comment-only hostname interpolated into notifier.env. Never a live assignment (O3-401 / O8-05). */
let NOTIFIER_PUBLIC_URL = "https://notify.stonkhouse.fun";

/**
 * Ports: 8787 is the v1 keeper, 8790 pricing and 8791 the notifier,
 * 8792-8794 the three signing bot modes (keeper/src/v2/config.ts CRANKER_PORT, MM_PORT,
 * PRICER_PORT and their defaults), 42069 Ponder's default. Railway probes $PORT, so each service
 * also gets PORT equal to its own port (the v1 keeper convention: KEEPER_PORT == PORT).
 */
const PORTS = { pricing: 8790, notifier: 8791, cranker: 8792, mm: 8793, pricer: 8794, indexer: 42069 };

/** Railway private networking: <service>.railway.internal, on the target service's port. */
const INDEXER_URL = `http://indexer-v2.railway.internal:${PORTS.indexer}`;
const PRICING_URL = `http://pricing.railway.internal:${PORTS.pricing}`;

/**
 * Where the registry lands inside the keeper image. Its runner stage installs the package at /app
 * (dist/ at /app/dist), so the keeper's default ../ops/markets/tier1.json would resolve to
 * /ops/markets/tier1.json: the path is set explicitly. keeper/Dockerfile copies
 * ops/markets/<V2_REGISTRY_FILE> (default tier1.json) to the same basename under /app/ops/markets,
 * so the rendered path follows the registry this run read. A separate private development
 * registry must be supplied explicitly; production defaults to tier1.json. ops/deploy.md §15.2.
 */
const registryPathInImage = () => `/app/ops/markets/${path.basename(registryFile)}`;

/** The signing bots' SQLite journals (sent transactions, alert cooldowns), one per service volume at /data. */
const dbPath = (service) => `/data/${service}.db`;

/**
 * The cranker's tuning keys and their defaults (keeper/src/v2/config.ts crankerTuningFields). Rendered
 * as comments, not values: the defaults are right for chain 4663, and a value copied here would stop
 * following a changed default. Set one on Railway only to change it.
 */
const CRANKER_TUNING = [
  ["POLL_INTERVAL_MS", "60000", "poll interval; the cranker also wakes itself at each expiry"],
  ["CRANKER_MAX_TX_PER_STEP", "50", "transactions per step per tick"],
  ["CRANKER_TX_GAS_CAP", "8000000", "gas limit ceiling of one batched transaction"],
  ["CRANKER_LOG_CHUNK_BLOCKS", "50000", "eth_getLogs range of the log index"],
  ["CRANKER_LOG_CHUNKS_PER_TICK", "40", "log ranges scanned per tick while catching up"],
  ["CRANKER_ZERO_PAYOUT_MAX_GAS_PRICE_WEI", "0", "burn zero-payout balances at or below this gas price (0 = never)"],
  ["CRANKER_REDEEM_BACKLOG_S", "3600", "v2_redeem_backlog after this long past settlement"],
  ["CRANKER_NO_SOURCE_ALERT_S", "3600", "v2_settle_stuck when no source prices an expiry this long"],
  ["CRANKER_PENDING_STUCK_S", "1800", "v2_settle_stuck when a candidate is this long past finalizableAt"],
  ["CRANKER_SWEEP_INTERVAL_S", "604800", "sweepFees per asset at most this often"],
  ["CRANKER_INDEXER_TIMEOUT_MS", "5000", "one indexer request"],
  ["CRANKER_FLYWHEEL_ENABLED", "0", "the flywheel step (claim, distribute, buyback); off until the flywheel is deployed"],
  ["CRANKER_FLYWHEEL_INTERVAL_S", "3600", "one flywheel pass at most this often; floor 300 s, the compiled BUYBACK_COOLDOWN"],
  ["CRANKER_BUYBACK_TOLERANCE_BPS", "50", "how far below the fresh quote minTokenOut is set; never 0"],
  ["CRANKER_BUYBACK_DRY_RUN", "0", "probe the buyback and report it, never send it, while the rest of the cranker runs live"],
  ["KEEPER_BOOT_RETRY_MS", "300000", "retry an unreadable chain this long at boot before exiting 1 (the health server is up meanwhile)"],
];

/**
 * The MM bot's quoting and risk keys and their defaults (keeper/src/v2/config.ts mmTuningFields), rendered as comments
 * like the cranker's. Prices and notional are USDG base units (6 dp), sizes 0.01-share units, rates bps. The canary
 * runbook (O2-04) sets the conservative ones on Railway; the vault's own on-chain limits bind whatever is set here.
 */
const MM_TUNING = [
  ["POLL_INTERVAL_MS", "60000", "tick interval"],
  ["MM_MARKETS", "", "comma-separated tickers to quote; unset = every live v2 market"],
  ["MM_MAX_SERIES", "40", "series quoted at once, nearest the money first"],
  ["MM_MAX_SERIES_PER_MARKET", "10", "series quoted per market"],
  ["MM_HALF_SPREAD_BPS", "500", "half spread as bps of fair"],
  ["MM_MIN_HALF_SPREAD_USDG6", "20000", "half spread floor per share"],
  ["MM_EXPIRY_WIDEN_S", "14400", "widen the spread from this long before expiry"],
  ["MM_EXPIRY_WIDEN_BPS", "20000", "extra half spread at the pull time (20000 = 3x)"],
  ["MM_PULL_MINUTES", "15", "pull every quote this long before the mint cutoff (expiry - 30 min)"],
  ["MM_QUOTE_OFF_HOURS", "0", "1 = quote outside the regular session"],
  ["MM_FAIR_MAX_AGE_S", "1800", "oldest /fair asOf quoted on in the session"],
  ["MM_FAIR_MAX_AGE_OFF_HOURS_S", "345600", "oldest /fair asOf quoted on outside the session"],
  ["MM_BID_UNITS", "100", "bid size (0 = no bids)"],
  ["MM_ASK_UNITS", "100", "ask size: inventory resale first, AskWrite for the rest (0 = no asks)"],
  ["MM_SKEW_BPS_PER_DELTA_SHARE", "10", "inventory skew: spot bps per share of net delta, times the series delta"],
  ["MM_MAX_SKEW_BPS", "1000", "skew cap as bps of fair"],
  ["MM_REQUOTE_BPS", "300", "replace a live quote only when its target moved more than this"],
  ["MM_RESIZE_BPS", "5000", "replace a partly filled quote when under this share of its size"],
  ["MM_MAX_SERIES_UNITS", "0", "bot cap on worst-case units per series (0 = the vault limit alone)"],
  ["MM_MAX_TOTAL_NOTIONAL_USDG6", "0", "bot cap on total notional (0 = the vault limit alone)"],
  ["MM_DAILY_LOSS_LIMIT_USDG6", "1000000000", "realised loss per UTC day that pulls every quote until the next day"],
  ["MM_DELTA_ALERT_SHARES", "50", "v2_mm_delta above this net delta per market (0 = never)"],
  ["MM_MAX_TX_PER_TICK", "60", "vault transactions per tick"],
  ["MM_SYNC_INTERVAL_S", "900", "MakerVault.sync of stale stored exposure at most this often"],
  ["MM_PRICING_TIMEOUT_MS", "5000", "one /fair request"],
  ["MM_DEPOSIT_TOKENS", "1", "move Stock Tokens idle in the vault wallet into its Clearinghouse ledger"],
  ["MM_MAX_QUOTE_LIFETIME_S", "1800", "longest validUntil a new quote gets (0 = the pull time, the close and the vault cap alone): what a dead bot leaves fillable"],
  ["MM_FAIR_SPOT_TOLERANCE_BPS", "300", "halt a series fair-spot-mismatch when /fair spot differs from the oracle feed by more than this (0 = unchecked)"],
  ["KEEPER_BOOT_RETRY_MS", "300000", "retry an unreadable chain this long at boot before exiting 1 (the health server is up meanwhile)"],
];

/**
 * The pricer's tuning keys and their defaults (keeper/src/v2/config.ts pricerTuningFields), rendered as
 * comments for the same reason as CRANKER_TUNING. PRICER_EDGE_BPS is the one an owner is most likely to set.
 */
const PRICER_TUNING = [
  ["POLL_INTERVAL_MS", "60000", "poll interval: how soon after a roll the new ask is priced"],
  ["PRICER_EDGE_BPS", "500", "target = fair x (1 + edge), then clamped to the strategy band; -5000..10000"],
  ["PRICER_REPRICE_THRESHOLD_BPS", "1000", "reprice only when the target differs from the live ask by more than this"],
  ["PRICER_MIN_INTERVAL_S", "1800", "evaluate a position right after its roll, then at most this often"],
  ["PRICER_REPRICE_OFF_HOURS", "0", "1 = allow repricing outside the regular session"],
  ["PRICER_MAX_TX_PER_TICK", "50", "reprice transactions per tick"],
  ["PRICER_HTTP_TIMEOUT_MS", "5000", "one pricing-service or indexer request"],
  ["PRICER_FAIR_ALERT_S", "7200", "v2_pricer_fair_unavailable after a live ask has had no fair value this long"],
  ["PRICER_LOG_CHUNK_BLOCKS", "50000", "eth_getLogs range of the StrategySet scan"],
  ["PRICER_LOG_CHUNKS_PER_TICK", "40", "log ranges scanned per tick while catching up"],
  ["KEEPER_BOOT_RETRY_MS", "300000", "retry an unreadable chain this long at boot before exiting 1 (the health server is up meanwhile)"],
];

/** Names that must never be assigned in a rendered file. */
const SECRETS = new Set([
  "CRANKER_PK", "MM_QUOTER_PK", "MM_KILL_TOKEN", "PRICER_PK", "DATABASE_URL", "PONDER_RPC_URL_4663", "NOTIFIER_DATA_KEY",
  "TELEGRAM_BOT_TOKEN", "VAPID_PRIVATE_KEY", "SMTP_URL", "ALERT_WEBHOOK_TOKEN",
]);

/* ---------------------------------------------------------------------------------------------- */
/*  arguments                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

const argv = process.argv.slice(2);
let check = false;
let only = null;
let outDir = OUT_DIR;
let registryFile = REGISTRY;
let rpcOverride = null;
let rpcBackupOverride = null;
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--check") check = true;
  else if (a === "--services") only = new Set((argv[++i] || die("--services needs a comma-separated list")).split(",").filter(Boolean));
  else if (a === "--out") outDir = path.resolve(argv[++i] || die("--out needs a directory"));
  else if (a === "--registry") registryFile = path.resolve(argv[++i] || die("--registry needs a file"));
  else if (a === "--rpc") rpcOverride = argv[++i] || die("--rpc needs a URL");
  else if (a === "--rpc-backup") rpcBackupOverride = argv[++i] || die("--rpc-backup needs a URL");
  else if (a === "-h" || a === "--help") {
    process.stdout.write("usage: node ops/v2-env.mjs [--check] [--services a,b] [--out DIR] [--registry FILE] [--rpc URL] [--rpc-backup URL]\n");
    process.exit(0);
  } else die(`unknown argument: ${a}`);
}
if (path.basename(registryFile) === "dev.json") {
  APP_URL = "https://dev.app.stonkhouse.fun";
  NOTIFIER_PUBLIC_URL = "https://<approved-dev-notifier-domain>";
}

function die(message) {
  process.stderr.write(`v2-env: ${message}\n`);
  process.exit(2);
}

/* ---------------------------------------------------------------------------------------------- */
/*  the registry                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

const registry = JSON.parse(readFileSync(registryFile, "utf8"));
const v2 = registry.v2;
const localDevRegistry = Object.hasOwn(registry, "_dev");
const rpcPrimary = rpcOverride ?? (localDevRegistry ? LOCAL_DEVNET_RPC : MAINNET_RPC_PRIMARY);
const rpcBackup = rpcOverride === null
  ? (localDevRegistry ? null : MAINNET_RPC_BACKUP)
  : rpcBackupOverride;
if (rpcBackupOverride !== null && rpcOverride === null) die("--rpc-backup requires --rpc");
const isLoopbackRpc = (value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:")
      && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1");
  } catch {
    return false;
  }
};
if (localDevRegistry) {
  for (const [label, value] of [["RPC", rpcPrimary], ["backup RPC", rpcBackup]]) {
    if (value !== null && !isLoopbackRpc(value)) {
      die(`refusing local-only registry ${registryFile} with non-local ${label} ${value}`);
    }
  }
}
// ops/markets/build-markets.mjs --check validates the block in full; this refuses only what would
// render a wrong file.
if (!v2 || typeof v2 !== "object") die(`${registryFile} has no top-level v2 block`);
if (!v2.contracts || typeof v2.contracts !== "object") die("registry v2.contracts is missing");
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
for (const [k, a] of Object.entries(v2.contracts)) {
  if (k === "sources") continue;
  if (a !== null && !ADDRESS.test(a)) die(`registry v2.contracts.${k} is neither null nor an address`);
}
if (!(v2.deployBlock === null || /^[1-9][0-9]*$/.test(String(v2.deployBlock)))) die("registry v2.deployBlock is neither null nor a block number");

/* ---------------------------------------------------------------------------------------------- */
/*  line helpers                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

const set = (name, value) => {
  if (SECRETS.has(name)) die(`refusing to render a value for secret ${name}`);
  return `${name}=${value}`;
};
const secret = (name, source) => `# ${name}=<secret: ${source}; set on Railway, never in this file>`;

/** A contract address from registry v2.contracts, or an empty value that says why. */
function contract(name, key) {
  const a = v2.contracts[key];
  if (a) return [`# registry v2.contracts.${key}`, set(name, a)];
  return [`# v2.contracts.${key} is null in the registry: no production address configured. Populate only after owner publication and verification; re-run ops/v2-env.mjs.`, set(name, "")];
}

/**
 * INTERFACE_VERSION 8 blocks, rendered ONLY for a registry that has them.
 *
 * `ops/markets/v7-legacy.json` is the frozen v7 production registry the run-off services read
 * (ops/markets/README.md). It has no `v2.flywheel`, no `shared.safes` and no `shared.token`, so
 * every v8 line below is omitted for it and the v7 service env renders exactly as it did before
 * this file learned about v8 — which is the acceptance for O8-01 and the reason these are guarded
 * on the block being present rather than on a flag somebody has to remember to pass.
 */
const isV8 = Number(v2.interfaceVersion) >= 8;
const flywheel = registry.v2?.flywheel ?? {};
const safes = registry.shared?.safes ?? {};
const token = registry.shared?.token ?? {};

/** One `registry <path>` address line, or an empty value naming the path that is still null. */
function fromRegistry(name, dotted, value) {
  if (value) return [`# registry ${dotted}`, set(name, value)];
  return [`# ${dotted} is null in the registry: no production address configured. Populate only after owner publication and verification; re-run ops/v2-env.mjs.`, set(name, "")];
}

/** The AccessManager: every privileged call on every v8 target resolves through it. */
const accessManager = () => (isV8 ? [
  "# ---- access control (v8: one AccessManager, V8-DESIGN §2) ----",
  "# Roles, delays and the selector map are ops/abis/v2/roles.json, exported with the ABIs.",
  ...contract("V2_ACCESS_MANAGER", "accessManager"),
] : []);

/** The flywheel: splitter, buyback executor and the block the splitter was deployed at. */
const flywheelEnv = () => (isV8 ? [
  "# ---- flywheel (v8: 50 % buyback and burn, 50 % Treasury Safe; V8-DESIGN §6) ----",
  ...fromRegistry("V2_FEE_SPLITTER", "v2.flywheel.feeSplitter", flywheel.feeSplitter),
  ...fromRegistry("V2_BUYBACK_EXECUTOR", "v2.flywheel.buybackExecutor", flywheel.buybackExecutor),
] : []);

/** STONKHOUSE, for anything that reports burned supply or the buyback's own pool. */
const tokenEnv = () => (isV8 ? [
  "# ---- token (v8: the only thing ever burned; Stock Token fees are sold for USDG first) ----",
  ...fromRegistry("V2_TOKEN", "shared.token.address", token.address),
  token.decimals === null || token.decimals === undefined
    ? "# shared.token.decimals is null in the registry: no production value configured."
    : "# registry shared.token.decimals",
  set("V2_TOKEN_DECIMALS", token.decimals === null || token.decimals === undefined ? "" : String(token.decimals)),
] : []);

/**
 * The five indexer inputs for the v8 lending and House periphery (indexer/lib/env.ts V2_EARN_VAULT,
 * V2_ZAP_HELPER, V2_HOUSE_VAULT_FACTORY, V2_EARN_START_BLOCK, V2_HOUSE_START_BLOCK).
 *
 * THE REGISTRY HAS NO SLOT FOR ANY OF THEM, deliberately: EarnVault and StockZap are override-only
 * (T-401 design B, web/lib/v2/config.ts), and build-markets.mjs records why EarnVault and the
 * per-market House vaults are not protocol keys (T-232). So there is nothing to render a value from.
 *
 * They are named, never omitted: a file that simply lacked them is how a go-live indexer came to
 * index no Earn, Zap or House contract with nothing anywhere saying so. They are COMMENTS rather than
 * empty assignments because go-live-v2.sh refuses a service whose env renders any empty value, and
 * with no registry slot an empty value could never be filled, so indexer-v2 could never go live.
 */
const PERIPHERY_UNREGISTERED = [
  ["V2_EARN_VAULT", "the EarnVault (lending vault) address; unset = the indexer does not index EarnVault"],
  ["V2_ZAP_HELPER", "the StockZap address; unset = the indexer does not index StockZap"],
  ["V2_EARN_START_BLOCK", "EarnVault's deploy block; required with V2_EARN_VAULT or V2_ZAP_HELPER and refused without them"],
  ["V2_HOUSE_VAULT_FACTORY", "the HouseVaultFactory address; unset = the indexer does not index House vaults"],
  ["V2_HOUSE_START_BLOCK", "the factory's deploy block; required with V2_HOUSE_VAULT_FACTORY and refused without it"],
];
const peripheryEnv = () => [
  "# ---- Earn, Zap and House (v8 periphery; NOT in the registry) ----",
  "# The registry has no slot for these (T-401 design B), so nothing here can render a value. Until they are",
  "# set on Railway from the verified deploy output, this indexer does NOT index Earn, Zap or House.",
  ...PERIPHERY_UNREGISTERED.map(([name, what]) =>
    `# ${name}=<not in the registry: ${what}; set on Railway from the verified deploy output>`),
];

const rpc = () => [
  set("RH_RPC", rpcPrimary),
  ...(rpcBackup === null ? [] : [set("RH_RPC_2", rpcBackup)]),
];
const registryPath = () => [
  "# The market registry baked into the image (ops/deploy.md §15.2); markets and contract addresses come from it.",
  "# Absolute: the keeper default ../ops/markets/tier1.json resolves against /app, the package root in the image.",
  set("V2_REGISTRY_PATH", registryPathInImage()),
];
const journal = (service) => [
  "# SQLite journal of sent transactions and alert cooldowns, on the service's volume mounted at /data.",
  set("KEEPER_DB_PATH", dbPath(service)),
];
/**
 * Where a signing bot's key comes from, as a comment: never a value.
 *
 * v8 keys live in ~/.callhouse-keys/v8/, NOT ~/.callhouse-keys/v2/. v7 derived indices 50-52 into
 * v2/cranker.env and v2/pricer.env, and derive-bot-keys.sh refuses to overwrite a key file, so on any
 * machine that ran v7 a v8 line naming that directory points at a v7 key and the v8 derivation dies.
 * A v7 registry (ops/markets/v7-legacy.json) keeps the directory it always had.
 *
 * A local dev registry (`_dev`, ops/markets/dev.json) names no production mnemonic index at all
 * (06-QUIRKS §G and its own `_dev` note): its bots are anvil's public dev accounts, the addresses in
 * its v2.bots, whose keys `node ops/devnet/devnet.mjs env` prints.
 */
const botKey = (name, bot, index, what) => localDevRegistry
  ? secret(name, `anvil dev account ops/devnet/lib.mjs ROLE_INDEX.${bot} (address in registry v2.bots.${bot}), a public key from anvil's "test test ... junk" mnemonic that \`node ops/devnet/devnet.mjs env\` prints; never a production mnemonic index; ${what}`)
  : secret(name, `~/.callhouse-keys/${isV8 ? "v8" : "v2"}/${bot}.env from ops/v2/derive-bot-keys.sh (ops mnemonic index ${index}; address in registry v2.bots.${bot}); ${what}`);
const alerts = () => [
  "# Alerts to the relay over Railway's private network (the v1 keeper's names).",
  set("ALERT_WEBHOOK", RELAY_ALERT_URL),
  secret("ALERT_WEBHOOK_TOKEN", "${{relay.RELAY_TOKEN}} reference variable"),
];
const port = (envName, value) => [
  ...(envName ? [set(envName, value)] : []),
  "# Railway probes $PORT: keep it equal to the service's own port.",
  set("PORT", value),
];

/* ---------------------------------------------------------------------------------------------- */
/*  the services                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

const SERVICES = [
  {
    name: "indexer-v2",
    about: "the v2 indexer (Ponder): events of the v2 contracts, API /v2/*",
    lines: () => [
      "# ---- v2 contracts (registry v2.contracts) ----",
      ...contract("V2_CLEARINGHOUSE", "clearinghouse"),
      ...contract("V2_ORDER_BOOK", "orderBook"),
      ...contract("V2_SETTLEMENT_ORACLE", "settlementOracle"),
      ...contract("V2_AUTO_ROLLER", "autoRoller"),
      ...contract("V2_MAKER_REGISTRY", "makerRegistry"),
      "# Optional sources the indexer also reads (calendar holidays, bounty payments); not in §7's list.",
      ...contract("V2_EXPIRY_CALENDAR", "expiryCalendar"),
      ...contract("V2_KEEPER_REWARDS", "keeperRewards"),
      ...contract("V2_MAKER_VAULT", "makerVault"),
      ...contract("V2_REWARDS_DISTRIBUTOR", "rewardsDistributor"),
      ...(isV8 ? [
        "# v8: RouteSet / RouteCleared, so /v2/markets[].settlement.route follows the chain, not the registry.",
        ...contract("V2_PAYOUT_ROUTER", "payoutAdapter"),
      ] : []),
      v2.deployBlock === null
        ? "# v2.deployBlock is null in the registry: no production block configured. Populate only after owner publication and verification; re-run ops/v2-env.mjs."
        : "# registry v2.deployBlock",
      set("V2_START_BLOCK", v2.deployBlock === null ? "" : String(v2.deployBlock)),
      "",
      ...accessManager(),
      ...(isV8 ? [
        "# /v2/config access block and /v2/admin/operations: role grants, delays and every scheduled,",
        "# executed or cancelled operation come from this contract's events.",
        "",
        ...flywheelEnv(),
        // lib/env.ts treats these as a pair. A token deployed before the splitter must not
        // accidentally activate the flywheel source; once the splitter exists, a missing token
        // address is intentionally an empty value that makes the indexer refuse to boot.
        ...(flywheel.feeSplitter
          ? fromRegistry("V2_FLYWHEEL_TOKEN_ADDRESS", "shared.token.address", token.address)
          : ["# V2_FLYWHEEL_TOKEN_ADDRESS is inactive until v2.flywheel.feeSplitter is populated.",
            set("V2_FLYWHEEL_TOKEN_ADDRESS", "")]),
        "# The splitter is constructed BEFORE the core (it is the core's fee recipient), so its first",
        "# event can precede V2_START_BLOCK: /v2/flywheel indexes from its own block.",
        flywheel.deployBlock === null || flywheel.deployBlock === undefined
          ? "# v2.flywheel.deployBlock is null in the registry: no production block configured."
          : "# registry v2.flywheel.deployBlock",
        set("V2_FLYWHEEL_START_BLOCK", flywheel.deployBlock === null || flywheel.deployBlock === undefined ? "" : String(flywheel.deployBlock)),
        "",
        ...tokenEnv(),
        "",
        "# ---- Safes (v8: reported by /v2/config, watched by the monitor) ----",
        ...fromRegistry("V2_ADMIN_SAFE", "shared.safes.admin", safes.admin),
        ...fromRegistry("V2_TREASURY_SAFE", "shared.safes.treasury", safes.treasury),
        "",
        ...peripheryEnv(),
        "",
      ] : []),
      "# ---- services ----",
      "# /v2/fair/:longId is proxied from the pricing service.",
      set("PRICING_URL", PRICING_URL),
      "",
      "# ---- database and chain ----",
      secret("DATABASE_URL", "${{Postgres.DATABASE_URL}} reference variable (shared Postgres)"),
      "# DATABASE_SCHEMA stays UNSET: the image indexes into a schema named after RAILWAY_DEPLOYMENT_ID, one per",
      "# deploy (ops/deploy.md §11.3; a fixed name crash-loops the second deploy). This is the stable name Ponder",
      "# keeps views of the live deployment's tables under, beside v1's, for anyone querying Postgres directly.",
      set("DATABASE_VIEWS_SCHEMA", "callhouse_v2"),
      secret("PONDER_RPC_URL_4663", "the archive RPC URL, which carries the provider's API key"),
      "",
      "# ---- process ----",
      ...port(null, PORTS.indexer),
    ],
  },
  {
    name: "cranker",
    about: "keeper V2_MODE=cranker: series ladders, snapshot, finalize, settle, redeem, roll, prune",
    lines: () => [
      set("V2_MODE", "cranker"),
      "",
      "# ---- chain and key ----",
      ...rpc(),
      ...(isV8
        ? [botKey("CRANKER_PK", "cranker", 60, "holds BUYBACK on the FeeSplitter (it cranks buyback(minTokenOut)); every lifecycle call it makes is permissionless, and it earns capped bounties")]
        : [botKey("CRANKER_PK", "cranker", 50, "holds no role, earns capped bounties")]),
      "",
      "# ---- registry and services ----",
      ...registryPath(),
      "# Optional: holder and strategy lists also come from the cranker's own log index, which it uses alone while this is down.",
      set("INDEXER_URL", INDEXER_URL),
      "# V2_AUTO_ROLLER comes from the registry and is optional here: without it the rolls step is skipped.",
      "",
      ...(isV8 ? [
        ...flywheelEnv(),
        "# The distribute and buyback steps. With V2_FEE_SPLITTER empty the cranker runs every other",
        "# step and skips these, which is what it does before the flywheel is deployed.",
        "",
      ] : []),
      "# ---- process ----",
      ...port("CRANKER_PORT", PORTS.cranker),
      ...journal("cranker"),
      ...alerts(),
      "",
      "# ---- tuning (keeper/src/v2/config.ts crankerTuningFields); unset = the default shown ----",
      ...CRANKER_TUNING.map(([name, value, what]) => `# ${name}=${value}  ${what}`),
    ],
  },
  {
    name: "pricing",
    about: "keeper V2_MODE=pricing: fair value and IV surface over HTTP; holds no key, sends no transaction",
    lines: () => [
      set("V2_MODE", "pricing"),
      "",
      "# ---- chain ----",
      "# The Stock Token feeds (spot) are read here.",
      ...rpc(),
      "",
      "# ---- registry ----",
      ...registryPath(),
      "",
      "# ---- session clock (keeper/src/v2/pricing/main.ts); unset = the default shown ----",
      "# PRICING_NYSE_HOLIDAYS=  comma-separated YYYY-MM-DD full-day NYSE closures, replacing keeper/src/calendar.ts's",
      "#   built-in table; set it the year the table runs out, or for an unscheduled closure (a session the",
      "#   service still thinks is open prices on a spot nobody is printing)",
      "",
      "# ---- process ----",
      "# PRICING_PORT, not PORT, is the service's own setting (keeper/src/v2/pricing/main.ts).",
      ...port("PRICING_PORT", PORTS.pricing),
    ],
  },
  {
    name: "mm-bot",
    about: "keeper V2_MODE=mm: quotes both sides through MakerVault",
    lines: () => [
      set("V2_MODE", "mm"),
      "",
      "# ---- chain and key ----",
      ...rpc(),
      ...(isV8
        ? [botKey("MM_QUOTER_PK", "quoter", 62, "QUOTER on the manager: the ten MakerVault quoter functions, cannot withdraw")]
        : [botKey("MM_QUOTER_PK", "mmQuoter", 52, "QUOTER_ROLE only, cannot withdraw")]),
      "",
      "# ---- vault, registry and services ----",
      // MAKER_VAULT is deliberately NOT rendered. The vault is the one contract this bot moves
      // inventory through, and it comes from the baked registry, like every other v2 address here. A
      // Railway MAKER_VAULT left from an earlier release no longer quotes through the replaced vault:
      // since keeper/src/v2/config.ts refuses an address that disagrees with the registry in the image,
      // it stops the bot at boot instead. That is the safe outcome and still the wrong one to plan for
      // — a release halted on a variable nobody meant to keep. So it is not set here at all.
      "# MAKER_VAULT is NOT set: the vault address comes from v2.contracts.makerVault in the registry",
      "# baked into the image, and a MakerVault redeploy reaches this bot as a rebuild of that registry.",
      "# A Railway MAKER_VAULT that disagrees with it does not win: the bot refuses to boot and names",
      "# both addresses (keeper/src/v2/config.ts), which stops the release until someone deletes the",
      "# variable. Set it only to point a bot at a vault the registry does not name (a devnet), and add",
      "# V2_CONTRACTS_FROM_ENV=1 only when the registry names another on purpose.",
      ...registryPath(),
      set("PRICING_URL", PRICING_URL),
      "# Accepted and unused: the MM bot reads series, orders and fills from the chain.",
      set("INDEXER_URL", INDEXER_URL),
      "",
      "# ---- kill switch ----",
      "# POST http://mm-bot.railway.internal:8793/kill with Authorization: Bearer <token> cancels every vault order and",
      "# stops quoting (kept across restarts) until POST /resume with the same header.",
      secret("MM_KILL_TOKEN", "openssl rand -hex 32, at least 32 characters; the bot refuses to boot without it"),
      "",
      "# ---- process ----",
      "# Private networking only: mm-bot never gets a public domain (/kill lives on this port).",
      ...port("MM_PORT", PORTS.mm),
      ...journal("mm-bot"),
      ...alerts(),
      "",
      "# ---- quoting and risk (keeper/src/v2/config.ts mmTuningFields); unset = the default shown ----",
      ...MM_TUNING.map(([name, value, what]) => `# ${name}=${value}  ${what}`),
    ],
  },
  {
    name: "pricer",
    about: "keeper V2_MODE=pricer: reprices smart-pricing auto-roll asks",
    lines: () => [
      set("V2_MODE", "pricer"),
      "",
      "# ---- chain and key ----",
      ...rpc(),
      ...(isV8
        ? [botKey("PRICER_PK", "pricer", 61, "PRICER on the manager: AutoRoller.reprice")]
        : [botKey("PRICER_PK", "pricer", 51, "PRICER_ROLE on AutoRoller")]),
      "",
      "# ---- registry and services ----",
      ...registryPath(),
      "# Fair values come from here; without one the pricer leaves every ask alone.",
      set("PRICING_URL", PRICING_URL),
      "# Optional: the strategy list also comes from the pricer's own StrategySet scan, which it uses alone while this is down.",
      set("INDEXER_URL", INDEXER_URL),
      "",
      "# ---- process ----",
      ...port("PRICER_PORT", PORTS.pricer),
      ...journal("pricer"),
      ...alerts(),
      "",
      "# ---- tuning (keeper/src/v2/config.ts pricerTuningFields); unset = the default shown ----",
      ...PRICER_TUNING.map(([name, value, what]) => `# ${name}=${value}  ${what}`),
    ],
  },
  {
    name: "notifier",
    about: "user notifications: subscriptions API and delivery (Telegram, Web Push, email)",
    lines: () => [
      "# ---- services and chain ----",
      "# The rules engine polls /v2/feed/activity here.",
      set("INDEXER_URL", INDEXER_URL),
      "# Used only to verify smart-wallet signatures (ERC-1271 / ERC-6492).",
      set("RH_RPC", rpcPrimary),
      "# The dapp origin: every message links into it and it is the only origin CORS admits.",
      set("APP_URL", APP_URL),
      "",
      "# ---- storage ----",
      secret("DATABASE_URL", "${{Postgres.DATABASE_URL}} reference variable (shared Postgres, schema notifier)"),
      secret("NOTIFIER_DATA_KEY", "32 bytes hex, `openssl rand -hex 32`, encrypts stored targets; losing it orphans them"),
      "",
      "# ---- channels ----",
      secret("TELEGRAM_BOT_TOKEN", "from @BotFather; the bot long-polls, so no webhook on it and ONE replica"),
      "# TELEGRAM_API_BASE is optional (default https://api.telegram.org); tests only.",
      "# VAPID_PUBLIC_KEY=<set on Railway: generated together with VAPID_PRIVATE_KEY; public once generated>",
      secret("VAPID_PRIVATE_KEY", "generated with the public key (web-push generate-vapid-keys)"),
      "# VAPID_SUBJECT stays unset: it defaults to APP_URL, which is https (required only for an http APP_URL).",
      secret("SMTP_URL", "optional; smtp(s)://user:pass@host; unset turns the email channel off"),
      "# With SMTP_URL only (the notifier refuses either without it): EMAIL_FROM=<sender address> and",
      `# NOTIFIER_PUBLIC_URL=${NOTIFIER_PUBLIC_URL} (the opt-in and unsubscribe links point there).`,
      "",
      "# ---- process ----",
      ...port(null, PORTS.notifier),
    ],
  },
];

function render(service) {
  const lines = [
    `# ${path.relative(path.join(HERE, ".."), path.join(outDir, `${service.name}.env`))} — ${service.about}.`,
    // Both paths are the ones this run actually used, so a --registry/--out render says so on its own first lines.
    `# GENERATED by ops/v2-env.mjs from ${path.relative(path.join(HERE, ".."), registryFile)} (v2 interface version ${v2.interfaceVersion}). Do not edit by hand:`,
    "# change the registry (or the renderer) and re-run; `node ops/v2-env.mjs --check` is the gate.",
    "# Public values only. Every secret this service needs is a comment below, never a value.",
    "",
    ...service.lines(),
  ];
  const text = `${lines.join("\n")}\n`;
  // O3-401 / O8-05: notifier/src/config.ts refuses EMAIL_FROM or NOTIFIER_PUBLIC_URL without
  // SMTP_URL. These stay comments. A live assignment here would crash-loop every go-live.
  if (/(?:^|\n)(?:NOTIFIER_PUBLIC_URL|EMAIL_FROM)=/m.test(text)) {
    die("NOTIFIER_PUBLIC_URL and EMAIL_FROM must stay comments (O3-401/O8-05): the notifier refuses either without SMTP_URL");
  }
  return text;
}

/* ---------------------------------------------------------------------------------------------- */
/*  main                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

if (only) for (const s of only) if (!SERVICES.some((x) => x.name === s)) die(`unknown service ${s} (${SERVICES.map((x) => x.name).join(", ")})`);
const selected = SERVICES.filter((s) => !only || only.has(s.name));
const wanted = new Map(selected.map((s) => [`${s.name}.env`, render(s)]));
const rel = (f) => path.relative(process.cwd(), f);

if (check) {
  const problems = [];
  for (const [name, text] of wanted) {
    const file = path.join(outDir, name);
    if (!existsSync(file)) {
      problems.push(`${rel(file)} is missing`);
      continue;
    }
    const committed = readFileSync(file, "utf8");
    if (committed !== text) {
      const a = committed.split("\n");
      const b = text.split("\n");
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
      problems.push(`${rel(file)} differs at line ${i + 1}: committed "${a[i] ?? "(end)"}" vs registry "${b[i] ?? "(end)"}"`);
    }
  }
  if (!only && existsSync(outDir)) {
    for (const name of readdirSync(outDir)) {
      if (name.endsWith(".env") && !wanted.has(name)) problems.push(`${rel(path.join(outDir, name))} is not a v2 service this renders (stale; delete it)`);
    }
  }
  if (problems.length) {
    process.stderr.write(`v2-env --check: ${problems.length} problem(s)\n  ${problems.join("\n  ")}\nRe-run node ops/v2-env.mjs and commit the result.\n`);
    process.exit(1);
  }
  process.stdout.write(`v2-env --check: ${wanted.size} file(s) match the registry (v2 interface version ${v2.interfaceVersion})\n`);
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
let written = 0;
for (const [name, text] of wanted) {
  const file = path.join(outDir, name);
  if (existsSync(file) && readFileSync(file, "utf8") === text) continue;
  writeFileSync(file, text);
  written += 1;
  process.stdout.write(`written  ${rel(file)}\n`);
}
process.stdout.write(`v2-env: ${written} written, ${wanted.size - written} unchanged, ${wanted.size} service(s)\n`);
