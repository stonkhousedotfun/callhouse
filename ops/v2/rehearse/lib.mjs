/* -------------------------------------------------------------------------------------------------
 * ops/v2/rehearse/lib.mjs — what every stage of the O2-03 fork rehearsal shares.
 *
 *   paths and ports      out/ (gitignored): state.json, ledger.json, services.json, logs/, screenshots/
 *   the chain            viem clients against the rehearsal anvil, anvil's public dev accounts by role
 *   fork control         warp, impersonate, fund (ERC-20 balance slot or whale), etch a Chainlink round feed
 *                        over a real feed proxy and push rounds, mine, dump
 *   the ledger           every transaction a stage sends: step, label, from, to, hash, gas, block, status
 *   processes            services started in their own process group (they outlive the stage that started
 *                        them), recorded with pid, port and start time; stopped by that record only
 *   waiting and HTTP     until(), getJson()
 *
 * KEYS. None. Every transaction is eth_sendTransaction from an anvil dev account (the public
 * "test test ... junk" mnemonic) or from an account impersonated on the fork (the registry's admin and
 * guardian). The bots' env carries those public dev keys only. ~/.callhouse-keys is never read.
 * ------------------------------------------------------------------------------------------------- */
import { spawn, execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..", "..");
export const OUT = process.env.REHEARSE_OUT ?? path.join(HERE, "out");
export const LOGS = path.join(OUT, "logs");
export const SHOTS = path.join(OUT, "screenshots");
export const STATE_FILE = path.join(OUT, "state.json");
export const LEDGER_FILE = path.join(OUT, "ledger.json");
export const SERVICES_FILE = path.join(OUT, "services.json");
export const REGISTRY = path.join(ROOT, "ops", "markets", "tier1.json");
export const SOURCES = path.join(ROOT, "ops", "markets", "v2-sources.json");
export const ABI_DIR = path.join(ROOT, "ops", "abis", "v2");
export const CONTRACTS_DIR = path.resolve(process.env.CONTRACTS_DIR ?? path.join(ROOT, "..", "callhouse-contracts"));
export const PUBLIC_RPC = "https://rpc.mainnet.chain.robinhood.com";

/** Ports reserved for this rehearsal (O2-03): anvil 8590-8594, services 42190-42199, web 3190. */
export const PORTS = {
  anvil: Number(process.env.REHEARSE_ANVIL_PORT ?? 8590),
  indexer: 42190,
  pricing: 42191,
  notifier: 42192,
  relay: 42193,
  telegram: 42194,
  cranker: 42195,
  mm: 42196,
  pricer: 42197,
  postgres: 42198,
  cranker2: 42199,
  web: Number(process.env.REHEARSE_WEB_PORT ?? 3190),
};
export const RPC = `http://127.0.0.1:${PORTS.anvil}`;
export const INDEXER_URL = `http://127.0.0.1:${PORTS.indexer}`;
export const PRICING_URL = `http://127.0.0.1:${PORTS.pricing}`;
export const NOTIFIER_URL = `http://127.0.0.1:${PORTS.notifier}`;
export const RELAY_URL = `http://127.0.0.1:${PORTS.relay}`;
export const TELEGRAM_URL = `http://127.0.0.1:${PORTS.telegram}`;
export const WEB_URL = `http://127.0.0.1:${PORTS.web}`;

for (const dir of [OUT, LOGS, SHOTS]) mkdirSync(dir, { recursive: true });

const require = createRequire(path.join(ROOT, "keeper", "package.json"));
export const viem = require("viem");
const { mnemonicToAccount } = require("viem/accounts");
const { createPublicClient, createWalletClient, defineChain, http, encodeFunctionData, getAddress, erc20Abi, parseAbi, pad, toHex } = viem;

export const chain = defineChain({
  id: 4663,
  name: "Stonkhouse O2-03 rehearsal (anvil fork of Robinhood Chain)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
export const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 180_000, retryCount: 2 }), pollingInterval: 250 });
export const rpc = (method, params = []) => pub.request({ method, params });

/* ---------------------------------------------------------------------------------------------- */
/*  output                                                                                         */
/* ---------------------------------------------------------------------------------------------- */

export const say = (line = "") => process.stdout.write(`${line}\n`);
export const step = (title) => say(`\n== ${title}  (${new Date().toISOString().slice(11, 19)}Z)`);
export const info = (line) => say(`  ${line}`);
export class RehearsalError extends Error {}
export function fail(message) {
  throw new RehearsalError(message);
}
/** One assertion: prints `ok` or throws with the message. Collected in state.checks for the report. */
export function expect(cond, message, stage = currentStage) {
  if (!cond) {
    recordCheck(stage, message, false);
    fail(message);
  }
  recordCheck(stage, message, true);
  say(`  ok  ${message}`);
}
let currentStage = "?";
export const setStage = (name) => {
  currentStage = name;
};
function recordCheck(stage, message, ok) {
  const s = loadState();
  s.checks ??= [];
  s.checks.push({ stage, ok, message, at: new Date().toISOString() });
  saveState(s);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const usd = (base6) => (Number(base6) / 1e6).toFixed(2);
export const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
export function nyTime(ts) {
  return new Date(Number(ts) * 1000).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
}

/* ---------------------------------------------------------------------------------------------- */
/*  files                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

export function readJson(file, fallback) {
  if (fallback !== undefined && !existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}
export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`;
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}
export const loadState = () => readJson(STATE_FILE, {});
export function saveState(s) {
  writeJson(STATE_FILE, s);
}
export function patchState(patch) {
  const s = loadState();
  Object.assign(s, patch);
  saveState(s);
  return s;
}

/* ---------------------------------------------------------------------------------------------- */
/*  accounts                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/** anvil's default mnemonic: public, printed by anvil itself on every start. */
export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";
export const ANVIL_ACCOUNTS = 20;
/**
 * Dev account index -> rehearsal role. #8/#9/#10 are the DeployV2Batch.sh --rehearse stand-ins for null
 * registry v2.bots (cranker, pricer, mmQuoter). The admin and guardian are the registry's own addresses,
 * impersonated. A second cranker key (#11) is kept for the failure drill.
 */
export const ROLE_INDEX = {
  ada: 3, // writer: manual AskWrite asks, writes into a bid (writeToSell)
  ben: 4, // writer: deposit, manual ask and the daily auto-roll strategy (browser when the web runs)
  cy: 5, // buyer: 0.01 share
  dee: 6, // buyer: 0.1 share
  eve: 7, // buyer: 1 share, lists part of it for resale
  cranker: 8,
  pricer: 9,
  mmQuoter: 10,
  cranker2: 11,
  fay: 12, // buys the resale
  gus: 13, // places the bid a writer hits by writing
  hal: 14, // buyer: TSLA (the 0.30 % pool route)
  ivy: 15, // buyer: META (Chainlink only, paid in kind)
  web: 16, // the browser buyer
  feeds: 17, // pushes the etched feeds' rounds (the rehearsal's price operator; no protocol role)
  whale: 18, // funds the MakerVault and KeeperRewards stand-in treasury
};
export const devKey = (index) => {
  const account = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });
  return { address: account.address, key: `0x${Buffer.from(account.getHdKey().privateKey).toString("hex")}` };
};
export const accountOf = (role) => devKey(ROLE_INDEX[role]).address;
/** A viem local account for a role (to sign the notifier's EIP-191 challenge). */
export const signerOf = (role) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: ROLE_INDEX[role] });
export const keyOf = (role) => devKey(ROLE_INDEX[role]).key;

/* ---------------------------------------------------------------------------------------------- */
/*  ABIs                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

const v2Errors = JSON.parse(readFileSync(path.join(ABI_DIR, "V2Errors.json"), "utf8")).filter((x) => x.type === "error");
export function abiOf(name) {
  const abi = JSON.parse(readFileSync(path.join(ABI_DIR, `${name}.json`), "utf8"));
  const have = new Set(abi.filter((x) => x.type === "error").map((x) => x.name));
  return [...abi, ...v2Errors.filter((e) => !have.has(e.name))];
}
export const ABI = {
  clearinghouse: abiOf("Clearinghouse"),
  orderBook: abiOf("OrderBook"),
  oracle: abiOf("SettlementOracle"),
  calendar: abiOf("ExpiryCalendar"),
  keeperRewards: abiOf("KeeperRewards"),
  chainlink: abiOf("ChainlinkFeedSource"),
  univ3: abiOf("UniV3TwapSource"),
  autoRoller: abiOf("AutoRoller"),
  payoutAdapter: abiOf("UniV3PayoutAdapter"),
  makerVault: abiOf("MakerVault"),
  erc20: erc20Abi,
  swapRouter02: parseAbi([
    "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
    "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
  ]),
  feed: parseAbi([
    "function decimals() view returns (uint8)",
    "function description() view returns (string)",
    "function latestRoundData() view returns (uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    "function getRoundData(uint80 id) view returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  ]),
  /** src/v2/mocks/MockRoundFeed.sol, etched over the real proxy (see etchFeed). */
  mockFeed: parseAbi([
    "function push(int256 answer, uint256 updatedAt) returns (uint80 id)",
    "function roundsInPhase(uint16 phase) view returns (uint64)",
    "function phaseId() view returns (uint16)",
    "function latestRoundData() view returns (uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  ]),
  pool: parseAbi([
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() view returns (uint128)",
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function fee() view returns (uint24)",
    "function tickSpacing() view returns (int24)",
    "function observe(uint32[]) view returns (int56[], uint160[])",
    "function observations(uint256) view returns (uint32, int56, uint160, bool)",
  ]),
  token: parseAbi([
    "function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)", "function paused() view returns (bool)", "function oraclePaused() view returns (bool)",
    "function uiMultiplier() view returns (uint256)", "function owner() view returns (address)", "function balanceOf(address) view returns (uint256)",
    "function newUIMultiplier() view returns (uint256)", "function effectiveAt() view returns (uint256)", "function ACCESS_CONTROLLED_REGISTRY() view returns (address)",
    "function isFrozen(address) view returns (bool)", "function isBlocked(address) view returns (bool)",
  ]),
  multicall3: parseAbi([
    "struct Call3 { address target; bool allowFailure; bytes callData; }",
    "struct Result { bool success; bytes returnData; }",
    "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  ]),
};

/* ---------------------------------------------------------------------------------------------- */
/*  transactions and the ledger                                                                    */
/* ---------------------------------------------------------------------------------------------- */

/** A fixed gas limit, never eth_estimateGas: snapshot/finalize/settle/redeemBatch swallow an inner out-of-gas
 *  (ops/devnet/lib.mjs explains). The block gas limit is far above it. */
export const TX_GAS = 12_000_000n;

export function reason(error) {
  const reverted = error?.walk?.((e) => e instanceof viem.ContractFunctionRevertedError);
  if (reverted?.data?.errorName) return `${reverted.data.errorName}(${(reverted.data.args ?? []).map(String).join(", ")})`;
  if (reverted?.reason) return reverted.reason;
  if (reverted?.signature) return `custom error ${reverted.signature}`;
  return String(error?.shortMessage ?? error?.message ?? error).replace(/\s+/g, " ");
}

/** Fields merged into every ledger entry while set (step 4: the drill id, and sandbox: true inside an evm_snapshot). */
let ledgerTag = {};
export const setLedgerTag = (tag) => {
  ledgerTag = tag ?? {};
};

export function ledgerAppend(entries) {
  const L = readJson(LEDGER_FILE, { _readme: "O2-03 fork rehearsal: every transaction a stage sent (or a production script sent), with gas. Generated; gitignored.", entries: [] });
  L.entries.push(...entries.map((e) => ({ ...e, ...ledgerTag })));
  writeJson(LEDGER_FILE, L);
}

const wallets = new Map();
function walletOf(address) {
  const key = getAddress(address);
  if (!wallets.has(key)) wallets.set(key, createWalletClient({ account: key, chain, transport: http(RPC, { timeout: 180_000 }) }));
  return wallets.get(key);
}

/**
 * Simulate (for a decoded revert), send from an unlocked or impersonated account, mine, check the receipt,
 * record it in the ledger. `step` is the rehearsal step the transaction belongs to; `action` groups gas.
 */
export async function send(from, { address, abi, functionName, args = [], value, label, step: stepName, action, gas = TX_GAS, expectRevert = false, sendReverting = false }) {
  const what = label ?? functionName;
  let result;
  let simulatedRevert = null;
  try {
    ({ result } = await pub.simulateContract({ account: from, address, abi, functionName, args, value }));
    if (expectRevert) throw new RehearsalError(`${what} was expected to revert but simulates fine`);
  } catch (error) {
    if (error instanceof RehearsalError) throw error;
    if (!expectRevert) throw new RehearsalError(`${what} would revert: ${reason(error)}`);
    if (!sendReverting) return { reverted: true, reason: reason(error) };
    simulatedRevert = reason(error);
  }
  const hash = await walletOf(from).writeContract({ account: from, address, abi, functionName, args, value, chain, gas });
  await rpc("evm_mine").catch(() => undefined);
  const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 200, timeout: 180_000 });
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
  ledgerAppend([{
    step: stepName ?? currentStage, action: action ?? functionName, label: what, from: getAddress(from), to: getAddress(address),
    hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), block: Number(receipt.blockNumber), ts: Number(block.timestamp),
  }]);
  if (simulatedRevert !== null) {
    if (receipt.status === "success") throw new RehearsalError(`${what} was expected to revert (${simulatedRevert}) but succeeded on chain (tx ${hash})`);
    return { reverted: true, reason: simulatedRevert, receipt, hash };
  }
  if (receipt.status !== "success") throw new RehearsalError(`${what} reverted on chain (tx ${hash})`);
  return { receipt, result, hash };
}

/**
 * The order id an OrderBook.place / placeFor receipt logged. Never the simulated return value: the MM bot places orders
 * concurrently, so an id simulated before the send can belong to someone else's order by the time it is mined.
 */
export function placedOrderId(receipt, orderBook) {
  const logs = viem.parseEventLogs({ abi: ABI.orderBook, eventName: "OrderPlaced", logs: receipt.logs }).filter((l) => getAddress(l.address) === getAddress(orderBook));
  if (logs.length !== 1) fail(`expected one OrderPlaced in tx ${receipt.transactionHash}, found ${logs.length}`);
  return logs[0].args.orderId;
}

export async function read(address, abi, functionName, args = []) {
  return pub.readContract({ address, abi, functionName, args });
}

/* ---------------------------------------------------------------------------------------------- */
/*  fork control                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

export async function now() {
  return Number((await pub.getBlock({ blockTag: "latest" })).timestamp);
}

/** Next block at exactly `ts`, mined now. Never goes backwards. */
export async function warpTo(ts, why = "") {
  const current = await now();
  if (ts <= current) return current;
  await rpc("evm_setNextBlockTimestamp", [toHex(ts)]);
  await rpc("evm_mine");
  const t = await now();
  ledgerAppend([{ step: currentStage, action: "warp", label: `warp ${current} -> ${t}${why ? ` (${why})` : ""}`, from: null, to: null, hash: null, status: "fork-control", gasUsed: "0", block: Number(await pub.getBlockNumber()), ts: t }]);
  return t;
}

export async function impersonate(address) {
  await rpc("anvil_impersonateAccount", [getAddress(address)]);
  await rpc("anvil_setBalance", [getAddress(address), toHex(10n ** 20n)]);
}

/** EIP-1967 implementation, beacon and admin slots: never balance slots, and fatal to overwrite. */
export const PROXY_SLOTS = new Set([
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
]);
const PROBE = 0x5eed_0000_4663n;

/** The storage slot holding `holder`'s balance of `token` (ops/devnet/lib.mjs findBalanceSlot: the access list of
 *  balanceOf, each candidate probed and restored). null when none behaves like a plain balance. */
export async function findBalanceSlot(token, holder) {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [holder] });
  const { accessList } = await rpc("eth_createAccessList", [{ to: token, data }, "latest"]);
  const keys = accessList.filter((a) => a.address.toLowerCase() === token.toLowerCase()).flatMap((a) => a.storageKeys).filter((k) => !PROXY_SLOTS.has(k.toLowerCase()));
  for (const slot of keys.reverse()) {
    const original = (await pub.getStorageAt({ address: token, slot })) ?? pad("0x0", { size: 32 });
    await rpc("anvil_setStorageAt", [token, slot, pad(toHex(PROBE), { size: 32 })]);
    let seen = null;
    try {
      seen = await read(token, erc20Abi, "balanceOf", [holder]);
    } catch {
      // a pointer or packed flag lives here
    }
    if (seen === PROBE) return slot;
    await rpc("anvil_setStorageAt", [token, slot, pad(original, { size: 32 })]);
  }
  return null;
}

/** Set `holder`'s balance of `token` to exactly `amount` by storage (fork control, recorded in the ledger). */
export async function deal(token, holder, amount, label = "") {
  const slot = await findBalanceSlot(token, holder);
  if (slot === null) fail(`deal ${token} -> ${holder}: no balance slot found`);
  await rpc("anvil_setStorageAt", [token, slot, pad(toHex(amount), { size: 32 })]);
  const got = await read(token, erc20Abi, "balanceOf", [holder]);
  if (got !== amount) fail(`deal ${token} -> ${holder}: read back ${got}, wanted ${amount}`);
  ledgerAppend([{ step: currentStage, action: "fund", label: `fund ${label || token} ${amount} -> ${holder}`, from: null, to: getAddress(token), hash: null, status: "fork-control", gasUsed: "0", block: Number(await pub.getBlockNumber()), ts: await now() }]);
}

/**
 * CHAINLINK FEEDS ON A FORK. The live RHxxx/USD proxies print only on a 0.5 % move or a 24 h heartbeat and their
 * OCR aggregators accept only signed reports, so after a warp nothing on the fork can print a round. The rehearsal
 * etches src/v2/mocks/MockRoundFeed.sol's runtime over the PROXY address the registry names (ChainlinkFeedSource
 * reads that address, and pins it), then writes the mock's storage so it continues the real feed: the proxy's
 * decimals and description, its current phase id, the aggregator round number of the latest real round, and the
 * last real rounds copied at their real ids. From then on `push(answer, updatedAt)` prints the next round of the
 * same phase. MockRoundFeed layout: slot 0 decimals (uint8), 1 description (string), 2 phaseId (uint16) | reverts
 * (bool) | historyFloor (uint80), 3 roundsInPhase (mapping uint16 => uint64), 4 _rounds (mapping uint80 =>
 * (int192 answer, uint64 updatedAt) in one slot).
 */
export async function etchFeed(feedAddress, history, runtime) {
  const feed = getAddress(feedAddress);
  const { decimals, description, rounds } = history;
  const latestId = BigInt(rounds[0].id);
  const phase = latestId >> 64n;
  const n = latestId & ((1n << 64n) - 1n);
  await rpc("anvil_setCode", [feed, runtime]);
  const set = (slot, value) => rpc("anvil_setStorageAt", [feed, pad(toHex(slot), { size: 32 }), pad(toHex(value), { size: 32 })]);
  const setRaw = (slot, word) => rpc("anvil_setStorageAt", [feed, slot, word]);
  // clear the proxy's own low slots first (owner, pending owner, current phase, ...)
  for (let i = 0n; i < 8n; i += 1n) await set(i, 0n);
  await set(0n, BigInt(decimals));
  const desc = Buffer.from(description, "utf8");
  if (desc.length > 31) fail(`feed ${feed}: description longer than 31 bytes: ${description}`);
  const word = Buffer.alloc(32);
  desc.copy(word, 0);
  word[31] = desc.length * 2;
  await setRaw(pad(toHex(1n), { size: 32 }), `0x${word.toString("hex")}`);
  await set(2n, phase);
  const keccakMapping = (key, slot) => viem.keccak256(viem.encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [key, slot]));
  await setRaw(keccakMapping(phase, 3n), pad(toHex(n), { size: 32 }));
  const INT192 = 1n << 192n;
  for (const r of rounds) {
    const answer = BigInt(r.answer);
    const packed = ((BigInt(r.updatedAt) << 192n) | ((answer + INT192) % INT192)) & ((1n << 256n) - 1n);
    await setRaw(keccakMapping(BigInt(r.id), 4n), pad(toHex(packed), { size: 32 }));
  }
  const [id, answer, , updatedAt] = await read(feed, ABI.feed, "latestRoundData");
  if (id !== latestId || answer !== BigInt(rounds[0].answer) || updatedAt !== BigInt(rounds[0].updatedAt)) {
    fail(`etched feed ${feed} does not answer the copied latest round (got ${id} ${answer} ${updatedAt})`);
  }
  ledgerAppend([{ step: currentStage, action: "etch-feed", label: `etch MockRoundFeed over ${description} ${feed} (phase ${phase}, round ${n}, ${rounds.length} rounds copied)`, from: null, to: feed, hash: null, status: "fork-control", gasUsed: "0", block: Number(await pub.getBlockNumber()), ts: await now() }]);
}

/** Print a round on an etched feed (8-dp answer), from the rehearsal's price operator. */
export async function pushRound(feed, answer8, updatedAt, label) {
  return send(accountOf("feeds"), { address: feed, abi: ABI.mockFeed, functionName: "push", args: [answer8, BigInt(updatedAt)], label: `push ${label}`, action: "feed-round" });
}

/* ---------------------------------------------------------------------------------------------- */
/*  processes                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

const processStart = (pid) => {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="]).toString().trim().replace(/\s+/g, " ");
  } catch {
    return "";
  }
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const loadServices = () => readJson(SERVICES_FILE, {});

/**
 * Start `cmd args` in its own session and process group (detached, stdin /dev/null, output to logs/<name>.log), so it
 * outlives the stage that started it; recorded in services.json with pid, port and process start time.
 */
export function startService(name, cmd, args, { cwd = ROOT, env = {}, port = null, inheritEnv = true } = {}) {
  const services = loadServices();
  if (services[name] && alive(services[name].pid) && processStart(services[name].pid) === services[name].started) {
    fail(`service ${name} is already running (pid ${services[name].pid}); stop it first (ops/v2/rehearse/stop.mjs)`);
  }
  const log = path.join(LOGS, `${name}.log`);
  const fd = openSync(log, "a");
  const child = spawn(cmd, args, { cwd, env: { ...(inheritEnv ? process.env : { PATH: process.env.PATH, HOME: process.env.HOME }), ...env }, detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  child.unref();
  if (!child.pid) fail(`could not start ${name}`);
  services[name] = { pid: child.pid, port, cmd: [cmd, ...args].join(" "), cwd, log, started: processStart(child.pid), at: new Date().toISOString() };
  writeJson(SERVICES_FILE, services);
  return services[name];
}

/** SIGSTOP / SIGCONT / SIGKILL a recorded service's process group (only a pid whose start time matches). false when not running. */
export function signalService(name, signal) {
  const s = loadServices()[name];
  if (!s || !alive(s.pid) || processStart(s.pid) !== s.started) return false;
  try {
    process.kill(-s.pid, signal);
  } catch {
    process.kill(s.pid, signal);
  }
  return true;
}

export const serviceRunning = (name) => {
  const s = loadServices()[name];
  return Boolean(s && alive(s.pid) && processStart(s.pid) === s.started);
};

export function serviceExited(name) {
  const s = loadServices()[name];
  if (!s) return `${name} was never started`;
  return alive(s.pid) ? null : `${name} (pid ${s.pid}) exited; log ${s.log}`;
}

/** Stop one recorded service: TERM its process group, KILL after 8 s. Only a pid whose start time matches. */
export async function stopService(name) {
  const services = loadServices();
  const s = services[name];
  if (!s) return false;
  if (alive(s.pid) && processStart(s.pid) === s.started) {
    try {
      process.kill(-s.pid, "SIGTERM");
    } catch {
      try {
        process.kill(s.pid, "SIGTERM");
      } catch {
        /* gone */
      }
    }
    try {
      process.kill(-s.pid, "SIGCONT"); // a frozen (SIGSTOP) group cannot act on SIGTERM until it runs again
    } catch {
      /* gone */
    }
    for (let i = 0; i < 80 && alive(s.pid); i += 1) await sleep(100);
    if (alive(s.pid)) {
      try {
        process.kill(-s.pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }
  }
  delete services[name];
  writeJson(SERVICES_FILE, services);
  return true;
}

export async function stopAll({ except = [] } = {}) {
  // reverse start order (the web and the bots before the indexer and Postgres), anvil last
  const names = Object.keys(loadServices()).filter((n) => !except.includes(n)).reverse();
  names.sort((a, b) => (a === "anvil") - (b === "anvil"));
  for (const n of names) {
    await stopService(n);
    say(`  stopped ${n}`);
  }
}

/* ---------------------------------------------------------------------------------------------- */
/*  waiting and HTTP                                                                               */
/* ---------------------------------------------------------------------------------------------- */

export async function until(label, check, { timeoutMs = 120_000, intervalMs = 1_000, service } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    if (service) {
      const exited = [service].flat().map(serviceExited).find(Boolean);
      if (exited) fail(`${label}: ${exited}`);
    }
    try {
      const v = await check();
      if (v) return v;
    } catch (error) {
      last = error;
    }
    await sleep(intervalMs);
  }
  fail(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${label}${last ? ` (last error: ${last.message ?? last})` : ""}`);
}

export async function getJson(url, { timeoutMs = 15_000 } = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url}: ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export async function portFree(port) {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

export function envFile(file) {
  const env = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** The rehearsal's markets (state.markets), by ticker, with checksummed addresses. */
export function markets() {
  const s = loadState();
  if (!s.markets) fail("state.json has no markets: run step 1 first");
  return s.markets;
}
export function contracts() {
  const s = loadState();
  if (!s.contracts) fail("state.json has no contracts: run step 1 first");
  return s.contracts;
}
export { getAddress, toHex, pad, encodeFunctionData, parseAbi };
