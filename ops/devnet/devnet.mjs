#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * ops/devnet/devnet.mjs — the bookkeeping steps of ops/devnet/up.sh, one subcommand each.
 *
 *   prepare --usdg <whole USDG>         make every anvil dev account a plain EOA again (on chain 4663
 *                                       they carry EIP-7702 delegation code), give account #0
 *                                       (DevDeploy's admin) USDG for the KeeperRewards budget, and pin
 *                                       its nonce so the contract addresses are the same on every run
 *   addresses --devdeploy <json> --fork-block <n> --start-block <n> [--fork public|custom] [--detached 0|1]
 *                                       write ops/devnet/addresses.json from DevDeploy's JSON
 *   detached --state <file>             record that the node now runs from a state dump (no fork)
 *   registry                            write ops/devnet/tier1.devnet.json: the real registry with the
 *                                       devnet's v2 contracts, deploy block, bot addresses, NVDA and TSLA
 *                                       live, and `feed` pointed at the mock feed the sources read
 *   env                                 write ops/devnet/env/<service>.env and print every block
 *   dump --out <file>                   anvil_dumpState, decoded to the JSON `anvil --load-state` reads
 *   time-floor --state <file>           after a reload: mine one block no earlier than the dump's time
 *
 * Environment: DEVNET_PORT (8546) / DEVNET_RPC, DEVNET_ADDRESSES. No private key is read or needed;
 * `env` prints anvil's PUBLIC dev keys (the "test test ... junk" mnemonic) for the bot signers,
 * derived here from that mnemonic.
 * ------------------------------------------------------------------------------------------------- */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createRequire } from "node:module";
import {
  ADDRESSES_FILE, HERE, PORT, ROLE_INDEX, ROOT, RPC, deal, devAccounts, die, loadAddresses, now, read, readJson, registry, rpc, sendRaw, viem, writeJson,
} from "./lib.mjs";

const { encodeFunctionData, getAddress, parseAbi, toHex } = viem;
/** The zero address, spelled once. */
const ZERO = "0x0000000000000000000000000000000000000000";
const require = createRequire(path.join(ROOT, "keeper", "package.json"));
const { mnemonicToAccount } = require("viem/accounts");

/** anvil's default mnemonic: public, printed by anvil itself on every start. */
const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
/** DevDeploy's admin nonce on every devnet: far above anything anvil account #0 reaches on chain 4663. */
const ADMIN_NONCE = 1_000_000;
/** Indexer placeholder for a periphery contract switched off on this devnet (see env). No code, no logs. */
const NO_CODE = "0x000000000000000000000000000000000000dead";

const REGISTRY_COPY = path.join(HERE, "tier1.devnet.json");

/**
 * The v8 closed contract key set, `V2_CONTRACT_NAMES` (ops/markets/build-markets.mjs:228-233): 11
 * names plus `sources`. `payoutAdapter` deliberately keeps its name while holding the PayoutRouter,
 * so nothing downstream learns a second key for the same slot (03-INTERFACES §4).
 *
 * DevDeploy's JSON does NOT carry them all. It writes the ten v7 names plus `houseVaultFactory` and
 * `houseVault`, and although it CONSTRUCTS the AccessManager (DevDeploy.s.sol:272) it never emits
 * it. So `accessManager` is recovered from the chain instead, and the two House keys are dropped
 * from this block rather than smuggled into a closed key set.
 */
const V2_CONTRACT_NAMES = [
  "clearinghouse", "orderBook", "settlementOracle", "expiryCalendar", "keeperRewards",
  "autoRoller", "payoutAdapter", "makerVault", "makerRegistry", "rewardsDistributor", "accessManager",
];
/** Every Managed target whose `authority()` must be the ONE manager (criterion 3, proved not assumed). */
const MANAGED_KEYS = [
  "clearinghouse", "orderBook", "settlementOracle", "expiryCalendar", "keeperRewards",
  "autoRoller", "payoutAdapter", "makerVault", "makerRegistry", "rewardsDistributor",
];
/**
 * Keys that are KNOWN not to be Managed on a devnet yet, and why. `payoutAdapter` is the v8 name for
 * the slot, but `script/v2/DevDeploy.s.sol:507` still deploys the v7 `UniV3PayoutAdapter` there,
 * which predates `Managed` and has no `authority()`. C8-10 replaces it with the `PayoutRouter`.
 *
 * This is a NAMED exception, not a blanket tolerance: any other target that fails to answer
 * `authority()` is still fatal, because that would mean a contract this devnet believes is v8 is not.
 * The distinction is the whole point -- a silent skip here would let a genuinely unmanaged core
 * contract through as if the set were fine.
 */
const NOT_MANAGED_YET = {
  payoutAdapter: "DevDeploy.s.sol:507 still deploys the v7 UniV3PayoutAdapter, which is not Managed (C8-10 replaces it with PayoutRouter)",
};

/**
 * The AccessManager, read off the chain and cross-checked. DevDeploy emits no `accessManager` key,
 * so the alternative to this is a devnet whose addresses.json has no manager at all -- which is what
 * T-126 would then have to guess at. Reading `authority()` from EVERY deployed Managed target and
 * requiring one answer is also the only thing that proves the devnet has a SINGLE manager: a second
 * one would mean a LISTING grant on one contract said nothing about another.
 */
async function accessManagerFrom(contracts) {
  const authority = parseAbi(["function authority() view returns (address)"]);
  const seen = new Map();
  for (const key of MANAGED_KEYS) {
    const address = contracts[key];
    if (!address) continue; // periphery switched off on this devnet
    let mgr;
    try {
      mgr = getAddress(await read(getAddress(address), authority, "authority"));
    } catch (error) {
      if (NOT_MANAGED_YET[key]) {
        process.stdout.write(`  WARN  ${key} at ${address} answers no authority(): ${NOT_MANAGED_YET[key]}\n`);
        continue;
      }
      die(`${key} at ${address} has no authority(): it is not Managed, so this is not a v8 contract set (${error.shortMessage ?? error.message})`);
    }
    if (mgr === ZERO) die(`${key} at ${address} reports authority() == the zero address: it is not under any manager`);
    if (!seen.has(mgr)) seen.set(mgr, []);
    seen.get(mgr).push(key);
  }
  if (seen.size === 0) die("no Managed contract was deployed: cannot recover the AccessManager");
  if (seen.size > 1) {
    const split = [...seen.entries()].map(([mgr, keys]) => `${mgr}: ${keys.join(", ")}`).join(" | ");
    die(`the devnet has ${seen.size} AccessManagers, not one -- a role grant on one contract says nothing about the others (${split})`);
  }
  const [mgr, keys] = [...seen.entries()][0];
  const code = await rpc("eth_getCode", [mgr, "latest"]);
  if (!code || code === "0x") die(`authority() is ${mgr} but there is no code there`);
  process.stdout.write(`  accessManager ${mgr} (authority() of all ${keys.length} Managed targets: ${keys.join(", ")})\n`);
  return mgr;
}
const ENV_DIR = path.join(HERE, "env");
/** The signing bots' SQLite files: under state/, which every up.sh deletes, so a fresh devnet never opens the last
 *  one's cursors, adopted orders or done-marks (the contract addresses repeat on every run). */
const STATE_DIR = path.join(HERE, "state");
const dbLines = (service) => [
  "# Under ops/devnet/state/, which every up.sh deletes: a fresh devnet starts from an empty database.",
  `KEEPER_DB_PATH=${path.join(STATE_DIR, `${service}.db`)}`,
];

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith("--")) die(`unexpected argument ${argv[i]}`, 2);
    out[argv[i].slice(2)] = argv[i + 1];
    i += 1;
  }
  return out;
}

const devKey = (index) => {
  const account = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
  return { address: account.address, key: `0x${Buffer.from(account.getHdKey().privateKey).toString("hex")}` };
};

/* ---------------------------------------------------------------------------------------------- */

async function prepare(a) {
  const acct = await devAccounts();
  // The public anvil keys are used on every chain, and on 4663 all twelve accounts carry an EIP-7702
  // delegation (code 0xef0100 || delegate). A delegated account runs that code when it receives ERC-1155
  // tokens or ETH, so a Clearinghouse mint to it reverts. The devnet wants plain EOAs.
  const delegated = [];
  for (const [role, address] of Object.entries(acct)) {
    const code = await rpc("eth_getCode", [address, "latest"]);
    if (code && code !== "0x") {
      await rpc("anvil_setCode", [address, "0x"]);
      delegated.push(role);
    }
  }
  process.stdout.write(`  cleared EIP-7702 delegation code from ${delegated.length} of ${Object.keys(acct).length} dev accounts\n`);
  const usdg = getAddress(registry().shared.usdg);
  const whole = BigInt(a.usdg ?? "20000");
  const how = await deal(usdg, acct.admin, whole * 10n ** 6n, registry().markets.map((m) => m.v2?.univ3Pool).filter(Boolean));
  await rpc("anvil_setNonce", [acct.admin, toHex(ADMIN_NONCE)]);
  process.stdout.write(`  admin ${acct.admin}: ${whole} USDG (${how}), nonce pinned at ${ADMIN_NONCE}\n`);
}

async function addresses(a) {
  if (!a.devdeploy) die("--devdeploy <DevDeploy JSON> is required", 2);
  const d = readJson(a.devdeploy);
  for (const flag of ["fork-block", "start-block"]) {
    if (!/^[1-9][0-9]*$/.test(a[flag] ?? "")) die(`--${flag} must be a block number, got ${JSON.stringify(a[flag])}`, 2);
  }
  const acct = await devAccounts();
  // The closed v8 key set, built here rather than passed through from DevDeploy: its JSON is missing
  // `accessManager` and carries two House keys that are not `v2.contracts` keys at all. A key that is
  // absent stays null (the periphery flags switch contracts off); an unexpected key is dropped.
  const contracts = { sources: d.contracts.sources ?? { chainlink: null, univ3: null, dataStreams: null } };
  for (const key of V2_CONTRACT_NAMES) contracts[key] = d.contracts[key] ?? null;
  // T-156 emits contracts.accessManager. Prefer it, but KEEP the on-chain recovery as a cross-check
  // rather than dropping it: reading authority() from every Managed target is what proves there is
  // exactly ONE manager, which an emitted address cannot tell you. A disagreement between what the
  // deploy SAYS and what the chain ANSWERS is itself a fault worth stopping on.
  const recovered = await accessManagerFrom(contracts);
  const declared = d.contracts.accessManager ? getAddress(d.contracts.accessManager) : null;
  if (declared && declared !== recovered) {
    die(`accessManager: DevDeploy emitted ${declared} but every Managed target answers authority() = ${recovered}`);
  }
  if (declared) process.stdout.write(`  accessManager: emitted value agrees with authority() on every Managed target\n`);
  contracts.accessManager = recovered;
  const dropped = Object.keys(d.contracts).filter((k) => k !== "sources" && !V2_CONTRACT_NAMES.includes(k));
  if (dropped.length) {
    process.stdout.write(`  not v2.contracts keys, kept out of the closed set: ${dropped.join(", ")}\n`);
  }
  // V8-DESIGN §6. The splitter and the buyback executor are NOT `v2.contracts` keys -- that block is
  // closed and counted -- so they live in their own block, exactly as the registry keeps them under
  // `v2.flywheel`. DevDeploy deploys NEITHER: grep the script, there is no FeeSplitter and no
  // V4BuybackExecutor in it, and the Clearinghouse and OrderBook take an EOA as feeRecipient
  // (DevDeploy.s.sol:335,346). So both stay null here, and that is REPORTED rather than passed over:
  // a null means "this devnet cannot exercise the flywheel", and T-119's ledger entry names why.
  // TWO SHAPES, ON PURPOSE. T-156 emits the flywheel NESTED at contracts.flywheel, beside sources,
  // and adds `mode`. Before it lands DevDeploy emits nothing at all. Reading only the flat keys
  // would find undefined against the new JSON and report "NOT DEPLOYED" on a devnet that HAS a
  // splitter -- a false negative indistinguishable from today's honest skip. So read the nested
  // shape first and fall back to flat: correct before and after T-156, with no flag day.
  const emitted = d.contracts.flywheel ?? {};
  const flywheel = {
    feeSplitter: emitted.feeSplitter ?? d.contracts.feeSplitter ?? null,
    buybackExecutor: emitted.buybackExecutor ?? d.contracts.buybackExecutor ?? null,
    // "bare-anvil" or "fork" (T-156). It is the DISCRIMINATOR, not decoration: a null
    // buybackExecutor is CORRECT on bare anvil, because V4BuybackExecutor reads live v4 pool state
    // and needs a registered launch hook, and is a FAULT on a fork. Gating on null alone cannot
    // tell those two apart, which is the exact silent-success shape this task kept hitting.
    mode: emitted.mode ?? null,
    burnBps: emitted.burnBps ?? null,
    deployBlock: (emitted.feeSplitter ?? d.contracts.feeSplitter) ? String(a["start-block"]) : null,
  };
  if (!flywheel.feeSplitter) {
    process.stdout.write(`  flywheel: no FeeSplitter on this devnet${flywheel.mode ? ` (mode ${flywheel.mode})` : " (DevDeploy builds none; C8-10/T-156)"}; v2.flywheel stays null\n`);
  } else if (!flywheel.buybackExecutor && flywheel.mode === "fork") {
    die("flywheel: a fork devnet reports no V4BuybackExecutor -- on a fork it can be constructed, so this is a fault, not the bare-anvil case");
  } else if (!flywheel.buybackExecutor) {
    process.stdout.write(`  flywheel: FeeSplitter ${flywheel.feeSplitter}, no V4BuybackExecutor (mode ${flywheel.mode ?? "unknown"}: correct on bare anvil, it needs live v4 pool state)\n`);
  } else {
    process.stdout.write(`  flywheel: FeeSplitter ${flywheel.feeSplitter}, V4BuybackExecutor ${flywheel.buybackExecutor} (mode ${flywheel.mode ?? "unknown"})\n`);
  }
  const out = {
    _readme:
      "Stonkhouse v2 devnet (ops/devnet/up.sh). Generated on every run and gitignored: the fork block, start block, times and seed ids change per run. " +
      "`contracts` has the shape of the registry's v2.contracts (null = not deployed on this devnet). startBlock is V2_START_BLOCK for the indexer.",
    network: "stonkhouse-devnet",
    chainId: d.chainId,
    rpc: RPC,
    port: PORT,
    fork: a.fork === "custom" ? "RH_RPC (custom endpoint, not recorded)" : "https://rpc.mainnet.chain.robinhood.com",
    forkBlock: Number(a["fork-block"]),
    startBlock: Number(a["start-block"]),
    detached: a.detached === "1",
    stateFile: null,
    createdAt: new Date().toISOString(),
    mockFeed: d.mockFeed,
    accounts: {
      ...Object.fromEntries(Object.entries(acct).map(([role, address]) => [role, address])),
      _indexes: ROLE_INDEX,
    },
    usdg: d.usdg,
    contracts,
    flywheel,
    markets: d.markets,
    roles: d.roles,
    config: d.config,
    seed: null,
  };
  writeJson(ADDRESSES_FILE, out);
  process.stdout.write(`  wrote ${path.relative(process.cwd(), ADDRESSES_FILE)} (start block ${out.startBlock})\n`);
}

function detached(a) {
  const A = loadAddresses();
  A.detached = true;
  A.stateFile = a.state ? path.relative(ROOT, path.resolve(a.state)) : null;
  writeJson(ADDRESSES_FILE, A);
}

function registryCopy() {
  const A = loadAddresses();
  const reg = registry();
  const acct = A.accounts;
  reg._readme = `DEVNET COPY of ops/markets/dev.json written by ops/devnet/devnet.mjs registry for the anvil devnet at ${A.rpc}. Never commit, never deploy from it.`;
  reg.v2.deployBlock = String(A.startBlock);
  reg.v2.contracts = A.contracts;
  // INTERFACE_VERSION 8 (build-markets.mjs:244): the bot set is cranker, pricer, quoter, guardian.
  // `mmQuoter` is gone as a name, and the guardian joined because it is a hot key the protocol runs.
  reg.v2.bots = { cranker: acct.cranker, pricer: acct.pricer, quoter: acct.quoter, guardian: acct.guardian };
  // V8-DESIGN §6. The splitter and the buyback executor are NOT v2.contracts keys -- that block is
  // closed and counted -- and the flywheel carries its own deploy block because the splitter is
  // constructed BEFORE the core (it is the core's fee recipient), so its first event can precede
  // v2.deployBlock. On a devnet both are deployed in the same run, so the block is the same one.
  reg.v2.flywheel = {
    feeSplitter: A.flywheel?.feeSplitter ?? null,
    buybackExecutor: A.flywheel?.buybackExecutor ?? null,
    deployBlock: A.flywheel?.deployBlock ?? null,
  };
  // O3-204 (02-interfaces.md §3.3): the protocol set — what scoring flags `protocol` and what
  // maker-epoch.mjs never allocates to a maker. It is rewritten here for the same reason
  // v2.contracts and v2.bots are: left as the production registry wrote it, this copy's exclusion
  // list would name the production admin, guardian and fee wallets on a chain where anvil's dev
  // accounts hold those roles, and the devnet's own admin would be scored as an ordinary maker.
  // `shared.*` is deliberately left alone, so the twin equalities §3.3 checks do not hold in this
  // copy; that is fine and deliberate — the copy is gitignored, is never deployed from, and is
  // never the subject of `build-markets.mjs --check`, which runs on the committed registries.
  // The v8 key set is V2_PROTOCOL_KEYS (build-markets.mjs:264-267): fourteen keys, `quoter` where v7
  // said `mmQuoter`, and `accessManager`. feeSplitter, buybackExecutor and treasury were hard-coded
  // null here, which meant the devnet's own flywheel and treasury addresses were scored as ordinary
  // maker wallets by anything reading this copy's exclusion list.
  reg.v2.protocolAddresses = {
    accessManager: A.contracts.accessManager ?? null,
    makerVault: A.contracts.makerVault ?? null,
    autoRoller: A.contracts.autoRoller ?? null,
    admin: acct.adminSafe ?? acct.admin,
    guardian: acct.guardian,
    feeRecipient: acct.feeRecipient,
    opsWallet: null,
    cranker: acct.cranker,
    pricer: acct.pricer,
    quoter: acct.quoter,
    feeSplitter: A.flywheel?.feeSplitter ?? null,
    buybackExecutor: A.flywheel?.buybackExecutor ?? null,
    treasury: acct.treasurySafe ?? null,
    distributors: { maker: A.contracts.rewardsDistributor ?? null, user: null },
  };
  for (const m of A.markets) {
    const row = reg.markets.find((x) => getAddress(x.asset) === getAddress(m.underlying));
    if (!row) die(`${m.ticker} (${m.underlying}) is not in the registry`);
    row.v2.status = "live";
    row.v2.registeredAt = A.startBlock;
    // The devnet's oracle settles TSLA on Chainlink alone (plan F2-04): no pool for the bots to snapshot.
    row.v2.univ3Pool = m.pool ?? null;
    row.v2.univ3MinLiquidity = m.pool ? row.v2.univ3MinLiquidity : null;
    // The pricing service reads spot from `feed`: on a mock-feed devnet that is the mock set-feed.mjs drives.
    row.feed = m.feed;
  }
  writeJson(REGISTRY_COPY, reg);
  process.stdout.write(`  wrote ${path.relative(process.cwd(), REGISTRY_COPY)} (NVDA, TSLA live; v2.contracts from the devnet)\n`);
}

function envBlocks() {
  const A = loadAddresses();
  const c = A.contracts;
  const rpcUrl = `http://127.0.0.1:${A.port}`;
  const indexer = "http://127.0.0.1:42069";
  const pricing = "http://127.0.0.1:8790";
  const notifier = "http://127.0.0.1:8791";
  const reg = REGISTRY_COPY;
  const orEmpty = (v, why) =>
    v
      ? [`# ${why.task} on this devnet (also v2.contracts in the registry copy)`, `${why.name}=${v}`]
      : [`# ${why.name}: ${why.task} switched off on this devnet (${why.flag}=0); a mode that needs it refuses to boot`, `${why.name}=`];
  const indexerPeriphery = (v, name, task, flag) =>
    v
      ? [`${name}=${v}`]
      : [
          `# ${name}: ${task} switched off on this devnet (${flag}=0). The indexer requires all five v2 addresses once`,
          "# V2_CLEARINGHOUSE is set, so this is a code-less placeholder: it emits no logs and nothing reads it.",
          `${name}=${NO_CODE}`,
        ];
  const key = (role) => devKey(ROLE_INDEX[role]);
  const header = (service, about) => [`# ops/devnet/env/${service}.env — ${about}.`, "# GENERATED by ops/devnet/devnet.mjs env for the local anvil devnet. Public anvil dev keys only. Never commit.", ""];

  const blocks = {
    indexer: [
      ...header("indexer", "the v2 indexer (Ponder) against the devnet: `pnpm --filter @callhouse/indexer dev`"),
      `PONDER_RPC_URL_4663=${rpcUrl}`,
      `V2_CLEARINGHOUSE=${c.clearinghouse}`,
      `V2_ORDER_BOOK=${c.orderBook}`,
      `V2_SETTLEMENT_ORACLE=${c.settlementOracle}`,
      ...indexerPeriphery(c.autoRoller, "V2_AUTO_ROLLER", "the AutoRoller", "DEV_AUTO_ROLLER"),
      ...indexerPeriphery(c.makerRegistry, "V2_MAKER_REGISTRY", "the MakerRegistry", "DEV_MAKER_SUITE"),
      `V2_EXPIRY_CALENDAR=${c.expiryCalendar}`,
      `V2_KEEPER_REWARDS=${c.keeperRewards}`,
      `V2_START_BLOCK=${A.startBlock}`,
      `PRICING_URL=${pricing}`,
      "# A throwaway local database; unset it to use DATABASE_URL (Postgres) instead.",
      "PGLITE_DIRECTORY=.ponder/devnet",
      "PORT=42069",
    ],
    cranker: [
      ...header("cranker", "keeper V2_MODE=cranker against the devnet"),
      "V2_MODE=cranker",
      `RH_RPC=${rpcUrl}`,
      "CHAIN_ID=4663",
      `# anvil dev account #${ROLE_INDEX.cranker} (${key("cranker").address}): a public key from anvil's default mnemonic`,
      `CRANKER_PK=${key("cranker").key}`,
      `V2_REGISTRY_PATH=${reg}`,
      ...orEmpty(c.autoRoller, { name: "V2_AUTO_ROLLER", task: "the AutoRoller", flag: "DEV_AUTO_ROLLER" }),
      `INDEXER_URL=${indexer}`,
      "CRANKER_PORT=8792",
      ...dbLines("cranker"),
      "POLL_INTERVAL_MS=5000",
    ],
    pricing: [
      ...header("pricing", "keeper V2_MODE=pricing against the devnet (spot from the mock feed named in the registry copy)"),
      "V2_MODE=pricing",
      `RH_RPC=${rpcUrl}`,
      `V2_REGISTRY_PATH=${reg}`,
      "PRICING_PORT=8790",
    ],
    "mm-bot": [
      ...header("mm-bot", "keeper V2_MODE=mm against the devnet"),
      "V2_MODE=mm",
      `RH_RPC=${rpcUrl}`,
      "CHAIN_ID=4663",
      `# anvil dev account #${ROLE_INDEX.quoter} (${key("quoter").address}): public dev key`,
      `MM_QUOTER_PK=${key("quoter").key}`,
      ...orEmpty(c.makerVault, { name: "MAKER_VAULT", task: "the MakerVault", flag: "DEV_MAKER_SUITE" }),
      `V2_REGISTRY_PATH=${reg}`,
      `PRICING_URL=${pricing}`,
      `INDEXER_URL=${indexer}`,
      "MM_PORT=8793",
      ...dbLines("mm-bot"),
      "# The kill switch's bearer token (POST /kill, POST /resume). A PUBLIC devnet value, like the dev keys: never use it elsewhere.",
      "MM_KILL_TOKEN=devnet-kill-token-public-not-a-secret-0000",
    ],
    pricer: [
      ...header("pricer", "keeper V2_MODE=pricer against the devnet"),
      "V2_MODE=pricer",
      `RH_RPC=${rpcUrl}`,
      "CHAIN_ID=4663",
      `# anvil dev account #${ROLE_INDEX.pricer} (${key("pricer").address}): public dev key`,
      `PRICER_PK=${key("pricer").key}`,
      ...orEmpty(c.autoRoller, { name: "V2_AUTO_ROLLER", task: "the AutoRoller", flag: "DEV_AUTO_ROLLER" }),
      `V2_REGISTRY_PATH=${reg}`,
      `PRICING_URL=${pricing}`,
      `INDEXER_URL=${indexer}`,
      "PRICER_PORT=8794",
      ...dbLines("pricer"),
    ],
    notifier: [
      ...header("notifier", "the notifier against the devnet indexer (needs a local Postgres)"),
      "DATABASE_URL=postgres://localhost:5432/notifier",
      `INDEXER_URL=${indexer}`,
      `RH_RPC=${rpcUrl}`,
      "APP_URL=http://localhost:3000",
      "VAPID_SUBJECT=mailto:devnet@localhost",
      "PORT=8791",
      "RULES_POLL_S=5",
      "# Local secrets you generate yourself (never commit them):",
      "#   NOTIFIER_DATA_KEY=$(openssl rand -hex 32)",
      "#   TELEGRAM_BOT_TOKEN=<a test bot from @BotFather>",
      "#   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY from `npx web-push generate-vapid-keys`",
    ],
    web: [
      ...header("web", "the dapp against the devnet (addresses are compiled from the registry copy, not env)"),
      "NEXT_PUBLIC_V2=1",
      `NEXT_PUBLIC_API_URL=${indexer}`,
      `NEXT_PUBLIC_NOTIFIER_URL=${notifier}`,
      `NEXT_PUBLIC_RPC_URL=${rpcUrl}`,
      "NEXT_PUBLIC_CHAIN_ID=4663",
      "# Then compile the devnet addresses in (a REHEARSAL build; do not commit web/lib/markets.generated.ts):",
      `#   MARKETS_REGISTRY=${reg} pnpm --filter @callhouse/web gen:markets`,
    ],
  };
  mkdirSync(ENV_DIR, { recursive: true });
  for (const [name, lines] of Object.entries(blocks)) {
    const text = `${lines.join("\n")}\n`;
    writeFileSync(path.join(ENV_DIR, `${name}.env`), text);
    process.stdout.write(`\n----- ${name} (ops/devnet/env/${name}.env) -----\n${lines.slice(3).join("\n")}\n`);
  }
}

async function dump(a) {
  if (!a.out) die("--out <file> is required", 2);
  const hex = await rpc("anvil_dumpState");
  const json = gunzipSync(Buffer.from(hex.replace(/^0x/, ""), "hex"));
  mkdirSync(path.dirname(path.resolve(a.out)), { recursive: true });
  writeFileSync(a.out, json);
  const state = JSON.parse(json.toString("utf8"));
  process.stdout.write(`  dumped ${Object.keys(state.accounts).length} accounts, ${state.blocks?.length ?? 0} blocks, best block ${state.best_block_number} -> ${a.out}\n`);
}

async function timeFloor(a) {
  const state = JSON.parse(readFileSync(a.state, "utf8"));
  const dumped = Number(BigInt(state.block.timestamp));
  const current = await now();
  if (current >= dumped) {
    process.stdout.write(`  chain time ${current} >= dumped ${dumped}\n`);
    return;
  }
  await rpc("evm_setNextBlockTimestamp", [toHex(dumped + 1)]);
  await rpc("evm_mine");
  process.stdout.write(`  chain time restored to ${dumped + 1} (the reload started at ${current})\n`);
}

/* ---------------------------------------------------------------------------------------------- */
/*  the test Safe and the role handover                                                            */
/* ---------------------------------------------------------------------------------------------- */

/**
 * A contract with no behaviour: runtime `60006000fd` = PUSH1 0 PUSH1 0 REVERT, so any call to it
 * reverts. That is deliberate. The devnet Safe exists to satisfy ONE property -- that the addresses
 * holding roles 0-6 are CONTRACTS, not keys, which is the rule a real Safe exists to keep -- and it
 * sends its transactions through anvil impersonation, which needs no code to run. Giving it a
 * working `execTransaction` would make it look like a Safe without being one, and the first person
 * to trust that would be wrong. `ops/v2/devnet-admin.mjs` drives it by impersonation.
 */
const SAFE_INITCODE = "0x6460006000fd6000526005601bf3";
const SAFE_RUNTIME = "0x60006000fd";

/** OpenZeppelin AccessManager, the three functions the handover needs. */
const MANAGER_ABI = [
  "function grantRole(uint64 roleId, address account, uint32 executionDelay)",
  "function revokeRole(uint64 roleId, address account)",
  "function hasRole(uint64 roleId, address account) view returns (bool isMember, uint32 executionDelay)",
];

/** The manifest, read at run time. No role id and no delay is written down in this file. */
function rolesManifest() {
  const file = path.join(ROOT, "ops", "abis", "v2", "roles.json");
  const m = readJson(file);
  if (!m.roles || !m.delaysS) die(`${file} has no roles/delaysS block`);
  for (const [name, id] of Object.entries(m.roles)) {
    if (!Number.isInteger(id)) die(`roles.json role ${name} has a non-integer id ${JSON.stringify(id)}`);
    if (!Number.isInteger(m.delaysS[name])) die(`roles.json has no integer delaysS for ${name}`);
  }
  return m;
}

/**
 * Hand every role the devnet's admin EOA holds to a test Safe, at the delay the manifest names, and
 * then take them off the EOA.
 *
 * WHY THIS STEP EXISTS AT ALL. `DevDeploy.s.sol:471-477` grants LISTING, MARKET_FEE_MANAGER,
 * CONFIG_ADMIN, TREASURY_ADMIN, OPS_ADMIN and GUARDIAN to the admin EOA at delay **0**, and that
 * file is in callhouse-contracts, which this task may not touch. So a devnet straight out of
 * DevDeploy has a bare key holding every privileged role with no delay -- the exact arrangement v8
 * exists to end. This step is the devnet's equivalent of the mainnet hand-over.
 *
 * ORDER MATTERS AND IS NOT ARBITRARY: grant the Safe everything FIRST, revoke the EOA's ADMIN LAST.
 * The EOA's ADMIN membership is what authorises every call here; revoking it earlier would lock the
 * devnet out of its own manager with no way back.
 */
async function safe() {
  const A = loadAddresses();
  const manager = A.contracts?.accessManager;
  if (!manager) die("addresses.json has no contracts.accessManager: run `devnet.mjs addresses` first");
  const acct = await devAccounts();
  const admin = getAddress(acct.admin);
  const abi = parseAbi(MANAGER_ABI);
  const manifest = rolesManifest();

  // 1. the Safe: a real deployment, so the address is one the chain chose.
  const receipt = await sendRaw({ from: admin, data: SAFE_INITCODE }, "the Safe deployment");
  const safeAddress = receipt?.contractAddress && getAddress(receipt.contractAddress);
  if (!safeAddress) die(`the Safe deployment left no contractAddress (tx ${receipt?.transactionHash})`);
  const code = await rpc("eth_getCode", [safeAddress, "latest"]);
  if (code !== SAFE_RUNTIME) die(`the Safe at ${safeAddress} has code ${code}, expected ${SAFE_RUNTIME}`);
  await rpc("anvil_setBalance", [safeAddress, toHex(10n ** 20n)]);
  await rpc("anvil_impersonateAccount", [safeAddress]);
  process.stdout.write(`  test Safe ${safeAddress}: ${code.length / 2 - 1} bytes of code, impersonated, funded\n`);

  // 2. every role the manifest names, at the manifest's own delay. A role the EOA does not hold is
  //    still granted to the Safe: the Safe is the admin principal, and DevDeploy grants a subset.
  const granted = [];
  for (const [name, id] of Object.entries(manifest.roles)) {
    const delay = manifest.delaysS[name];
    await sendRaw({
      from: admin,
      to: manager,
      data: encodeFunctionData({ abi, functionName: "grantRole", args: [BigInt(id), safeAddress, delay] }),
    }, `grantRole ${name} to the Safe`);
    const [isMember, executionDelay] = await read(manager, abi, "hasRole", [BigInt(id), safeAddress]);
    if (!isMember) die(`${name}: the Safe is not a member after grantRole`);
    if (Number(executionDelay) !== delay) {
      die(`${name}: the Safe's execution delay is ${executionDelay}s, the manifest says ${delay}s -- a delay this script invented would be the whole point of the handover lost`);
    }
    granted.push(`${name}=${delay}s`);
  }
  process.stdout.write(`  roles on the Safe at the manifest's delays: ${granted.join(", ")}\n`);

  // 3. the EOA comes off every DELAYED role (ids 0-6). The delay-0 bot roles stay where DevDeploy put
  //    them -- GUARDIAN, PRICER, QUOTER and BUYBACK are hot keys the protocol runs on purpose -- and
  //    ADMIN is revoked last because it is what authorises these calls.
  const delayed = Object.entries(manifest.roles).filter(([name]) => manifest.delaysS[name] > 0);
  const ordered = [...delayed.filter(([n]) => n !== "ADMIN"), ...delayed.filter(([n]) => n === "ADMIN")];
  const revoked = [];
  for (const [name, id] of ordered) {
    const [was] = await read(manager, abi, "hasRole", [BigInt(id), admin]);
    if (!was) continue;
    await sendRaw({
      from: admin,
      to: manager,
      data: encodeFunctionData({ abi, functionName: "revokeRole", args: [BigInt(id), admin] }),
    }, `revokeRole ${name} from the admin EOA`);
    const [still] = await read(manager, abi, "hasRole", [BigInt(id), admin]);
    if (still) die(`${name}: the admin EOA is still a member after revokeRole`);
    revoked.push(name);
  }
  process.stdout.write(`  admin EOA ${admin} revoked from ${revoked.length ? revoked.join(", ") : "nothing (it held no delayed role)"}\n`);

  // 4. the proof, not the intention: no EOA is left in any delayed role.
  for (const [name, id] of delayed) {
    for (const [role, address] of Object.entries(acct)) {
      if (role === "_indexes") continue;
      const [isMember] = await read(manager, abi, "hasRole", [BigInt(id), getAddress(address)]);
      if (isMember) die(`${name} is still held by the EOA ${role} (${address}): roles 0-6 must be the Safe alone`);
    }
  }
  process.stdout.write(`  checked: none of the ${delayed.length} delayed roles is held by any anvil EOA\n`);

  A.accounts.adminSafe = safeAddress;
  writeJson(ADDRESSES_FILE, A);
  process.stdout.write(`  wrote accounts.adminSafe (ops/v2/devnet-admin.mjs resolves --safe from it)\n`);
}

const [cmd, ...rest] = process.argv.slice(2);
const a = args(rest);
const commands = { prepare, addresses, safe, detached, registry: registryCopy, env: envBlocks, dump, "time-floor": timeFloor };
if (!commands[cmd]) die(`usage: node ops/devnet/devnet.mjs ${Object.keys(commands).join("|")} [--flags]`, 2);
try {
  await commands[cmd](a);
} catch (error) {
  die(`devnet ${cmd} failed: ${error.stack ?? error.message}`);
}
