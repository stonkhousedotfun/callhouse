/* -------------------------------------------------------------------------------------------------
 * ops/devnet/lib.mjs — what seed.mjs, set-feed.mjs and devnet.mjs share: the viem client against the
 * local anvil, the anvil dev accounts and their devnet roles, the v2 ABIs, a checked transaction
 * helper, ERC-20 funding by storage slot (or an impersonated whale), and addresses.json.
 *
 * KEYS. Nothing here holds or reads a private key. Every transaction is `eth_sendTransaction` from
 * one of anvil's own unlocked dev accounts (the public "test test ... junk" mnemonic), and funding
 * uses anvil's cheat RPCs. The only keys that ever appear are those public dev keys, printed by
 * devnet.mjs into the bots' env blocks.
 *
 * viem is resolved from the keeper workspace package (createRequire), so ops/ needs no install of
 * its own: `pnpm install` at the repo root is the only prerequisite.
 * ------------------------------------------------------------------------------------------------- */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, "..", "..");
export const ADDRESSES_FILE = process.env.DEVNET_ADDRESSES ?? path.join(HERE, "addresses.json");
/**
 * THE DEVNET BUILDS FROM dev.json, AND NEVER FROM THE PRODUCTION REGISTRY (F8-03 criterion 2).
 * `ops/markets/dev.json` is O8-01's decoupled dev registry: the same v8 fee block, plus a `_dev`
 * marker that says out loud that this is not the launch set, and a `validateDevIsolation` check that
 * refuses any production wallet in it. Pointing this at the production file made every devnet run
 * derive its markets, fees and addresses from the file the mainnet launch uses.
 */
export const REGISTRY_FILE = path.join(ROOT, "ops", "markets", "dev.json");
export const ABI_DIR = path.join(ROOT, "ops", "abis", "v2");

const require = createRequire(path.join(ROOT, "keeper", "package.json"));
let viem;
try {
  viem = require("viem");
} catch (error) {
  process.stderr.write(
    `devnet: cannot load viem through the keeper package (${error.message}).\n` +
      "Run `pnpm install --frozen-lockfile` at the repository root first.\n",
  );
  process.exit(2);
}
export { viem };
const { createPublicClient, createWalletClient, defineChain, http, encodeFunctionData, getAddress, erc20Abi, parseAbi, pad, toHex } = viem;

export const PORT = Number(process.env.DEVNET_PORT ?? 8546);
export const RPC = process.env.DEVNET_RPC ?? `http://127.0.0.1:${PORT}`;

export const chain = defineChain({
  id: 4663,
  name: "Stonkhouse devnet (anvil fork of Robinhood Chain)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

export const pub = createPublicClient({ chain, transport: http(RPC, { timeout: 120_000 }), pollingInterval: 100 });
const wallets = new Map();
export function walletOf(address) {
  const key = getAddress(address);
  if (!wallets.has(key)) wallets.set(key, createWalletClient({ account: key, chain, transport: http(RPC, { timeout: 120_000 }) }));
  return wallets.get(key);
}

export const rpc = (method, params = []) => pub.request({ method, params });

/* ---------------------------------------------------------------------------------------------- */
/*  accounts                                                                                       */
/* ---------------------------------------------------------------------------------------------- */

/**
 * anvil dev account index -> devnet role. up.sh starts anvil with `--accounts 12`.
 * 0-2 hold the protocol roles DevDeploy grants; 3-7 are the five seeded dev wallets (two writers,
 * three buyers); 8-10 are the bot signers the env blocks name; 11 is left clean for test harnesses.
 */
export const ROLE_INDEX = {
  admin: 0,
  guardian: 1,
  feeRecipient: 2,
  ada: 3, // writer: write-on-fill asks on both markets, most of the collateral
  ben: 4, // writer: second price level, a bid, sells into a bid by minting
  cy: 5, // buyer: 1-unit and 100-unit buys, bids
  dee: 6, // buyer: 10-unit buys, a bid
  eve: 7, // buyer: 100- and 350-unit buys, sells into a bid, lists the resale ask
  cranker: 8,
  pricer: 9,
  // INTERFACE_VERSION 8 (build-markets.mjs:244): `mmQuoter` is now `quoter` -- the role is QUOTER on
  // the AccessManager rather than a vault role -- and `guardian` is a bot key the protocol runs. The
  // guardian keeps index 1, which it already had, so only this name changes here.
  quoter: 10,
  // ops/markets/dev.json names #11 "treasury Safe stand-in" and says it matches this table. It is the
  // address money may leave to, so it is a principal, not a spare.
  treasurySafe: 11,
};
export const WALLETS = ["ada", "ben", "cy", "dee", "eve"];

export async function devAccounts() {
  const list = await rpc("eth_accounts");
  if (list.length < 12) throw new Error(`anvil exposes ${list.length} dev accounts; start it with --accounts 12 (up.sh does)`);
  const out = {};
  for (const [role, i] of Object.entries(ROLE_INDEX)) out[role] = getAddress(list[i]);
  return out;
}

/* ---------------------------------------------------------------------------------------------- */
/*  ABIs                                                                                           */
/* ---------------------------------------------------------------------------------------------- */

/** The callhouse-contracts checkout up.sh deployed from (its forge artifacts back abiOf's fallback). */
export const CONTRACTS_DIR = path.resolve(process.env.CONTRACTS_DIR ?? path.join(ROOT, "..", "callhouse-contracts"));

const v2Errors = JSON.parse(readFileSync(path.join(ABI_DIR, "V2Errors.json"), "utf8")).filter((x) => x.type === "error");
/**
 * A v2 ABI with the shared V2Errors merged in, so reverts decode by name: the published ops/abis/v2/<name>.json,
 * or, for a newly added contract whose export has not landed in this checkout yet, the forge artifact
 * up.sh just built under CONTRACTS_DIR. Release evidence requires the committed ABI export to match.
 */
export function abiOf(name) {
  const published = path.join(ABI_DIR, `${name}.json`);
  let abi;
  if (existsSync(published)) {
    abi = JSON.parse(readFileSync(published, "utf8"));
  } else {
    const artifact = path.join(CONTRACTS_DIR, "out", `${name}.sol`, `${name}.json`);
    if (!existsSync(artifact)) {
      throw new Error(`no ABI for ${name}: not in ops/abis/v2 and no forge artifact at ${artifact} (set CONTRACTS_DIR and run forge build there)`);
    }
    abi = JSON.parse(readFileSync(artifact, "utf8")).abi;
  }
  const have = new Set(abi.filter((x) => x.type === "error").map((x) => x.name));
  return [...abi, ...v2Errors.filter((e) => !have.has(e.name))];
}
const lazyAbi = new Map();
const lazy = (name) => {
  if (!lazyAbi.has(name)) lazyAbi.set(name, abiOf(name));
  return lazyAbi.get(name);
};
export const ABI = {
  /* periphery (loaded on first use, so a devnet without them never needs their artifacts) */
  get autoRoller() {
    return lazy("AutoRoller");
  },
  get payoutAdapter() {
    // v8 (C8-06/T-69): the logical payoutAdapter key names the PayoutRouter; IPayoutRouter.json stands in
    // until the concrete artifact is exported. The v7 UniV3PayoutAdapter ABI must NOT be used: its
    // routes(address) shares selector 0xd7409659 with the router but returns (address pool, uint24 fee).
    return lazy("IPayoutRouter");
  },
  get makerVault() {
    return lazy("MakerVault");
  },
  get makerRegistry() {
    return lazy("MakerRegistry");
  },
  get rewardsDistributor() {
    return lazy("RewardsDistributor");
  },
  /**
   * v8 additions. The AccessManager is OpenZeppelin's and is exported, so it resolves from
   * ops/abis/v2. The FeeSplitter and the V4 buyback executor are NOT: `script/v2/abi-manifest.txt`
   * does not name the concrete contracts and `export-abis.sh` removes what the manifest does not
   * name (T-78), so only the I-prefixed interfaces are published. abiOf() therefore falls through to
   * the forge artifact under CONTRACTS_DIR for those two. That fallback is the documented path, not
   * a workaround, and no ABI is hand-written here: if neither source has it, abiOf throws with both
   * paths named, which is a report.
   */
  get accessManager() {
    return lazy("AccessManager");
  },
  get feeSplitter() {
    return lazy("FeeSplitter");
  },
  get buybackExecutor() {
    return lazy("V4BuybackExecutor");
  },
  /** Uniswap SwapRouter02 exactInputSingle (IV3SwapRouter: no deadline field, selector 0x04e45aaf). */
  swapRouter02: parseAbi([
    "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
    "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
    "function factory() view returns (address)",
  ]),
  clearinghouse: abiOf("Clearinghouse"),
  orderBook: abiOf("OrderBook"),
  oracle: abiOf("SettlementOracle"),
  calendar: abiOf("ExpiryCalendar"),
  keeperRewards: abiOf("KeeperRewards"),
  chainlink: abiOf("ChainlinkFeedSource"),
  univ3: abiOf("UniV3TwapSource"),
  erc20: erc20Abi,
  /** src/v2/mocks/MockRoundFeed.sol (a test mock: not in the published ABI set). */
  mockFeed: parseAbi([
    "function push(int256 answer, uint256 updatedAt) returns (uint80 id)",
    "function latestRoundData() view returns (uint80 id, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    "function getRoundData(uint80 id) view returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    "function roundsInPhase(uint16 phase) view returns (uint64)",
    "function phaseId() view returns (uint16)",
    "function decimals() view returns (uint8)",
    "function description() view returns (string)",
  ]),
  multicall3: parseAbi([
    "struct Call3 { address target; bool allowFailure; bytes callData; }",
    "struct Result { bool success; bytes returnData; }",
    "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  ]),
};

/* ---------------------------------------------------------------------------------------------- */
/*  transactions                                                                                   */
/* ---------------------------------------------------------------------------------------------- */

/** Gas limit of every devnet transaction (see send). The fork's block gas limit is far above it. */
export const TX_GAS = 12_000_000n;

let sent = 0;
export const sentCount = () => sent;

export function reason(error) {
  const reverted = error?.walk?.((e) => e instanceof viem.ContractFunctionRevertedError);
  if (reverted?.data?.errorName) return `${reverted.data.errorName}(${(reverted.data.args ?? []).map(String).join(", ")})`;
  if (reverted?.reason) return reverted.reason;
  return error?.shortMessage ?? error?.message ?? String(error);
}

/**
 * Simulate (for a decoded revert), send from an unlocked dev account, mine at once, check the
 * receipt. Returns { receipt, result } where result is the simulated return value.
 */
export async function send(from, { address, abi, functionName, args = [], value, label }) {
  const what = label ?? `${functionName}`;
  let result;
  try {
    ({ result } = await pub.simulateContract({ account: from, address, abi, functionName, args, value }));
  } catch (error) {
    throw new Error(`${what} would revert: ${reason(error)}`);
  }
  // A FIXED gas limit, never eth_estimateGas: SettlementOracle.snapshot/finalize, Clearinghouse.settle and
  // redeemBatch call sources and holders through raw calls / try-catch that swallow an inner out-of-gas,
  // so the smallest gas at which the OUTER call succeeds is one where the inner call silently did nothing
  // (a snapshot that records no pool price). Keepers must not trust estimateGas for these either.
  const hash = await walletOf(from).writeContract({ account: from, address, abi, functionName, args, value, chain, gas: TX_GAS });
  await rpc("evm_mine");
  const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${what} reverted on chain (tx ${hash})`);
  sent += 1;
  return { receipt, result, hash };
}

/**
 * A view call. `account` matters for any view that reads `msg.sender` -- `OrderBook.quoteTake` does,
 * to apply the caller's own discount -- and without it viem sends the call from the zero address, so
 * the quote would be a different caller's quote than the take.
 */
export async function read(address, abi, functionName, args = [], account) {
  return pub.readContract(account ? { address, abi, functionName, args, account } : { address, abi, functionName, args });
}

/**
 * Send a raw transaction and WAIT for it to be mined. The devnet anvil runs with `--block-time 1`
 * (up.sh:175), so nothing is mined on submission: reading a receipt, or reading back the state a
 * transaction was meant to change, immediately after `eth_sendTransaction` sees the chain as it was
 * BEFORE the call. Returns the receipt.
 */
export async function sendRaw(tx, label) {
  const hash = await rpc("eth_sendTransaction", [tx]);
  const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`${label ?? "transaction"} reverted (${hash})`);
  return receipt;
}

export async function now() {
  const b = await pub.getBlock({ blockTag: "latest" });
  return Number(b.timestamp);
}

/** Next block at exactly `ts` (unix seconds), mined now. Refuses to go backwards. */
export async function warpTo(ts) {
  const current = await now();
  if (ts <= current) return current;
  await rpc("evm_setNextBlockTimestamp", [toHex(ts)]);
  await rpc("evm_mine");
  return now();
}

/* ---------------------------------------------------------------------------------------------- */
/*  funding                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

/** Small enough for a balance packed into 64 bits beside flags; unlikely to be any real balance. */
const PROBE = 0x5eed_0000_4663n;

/**
 * The storage slot holding `holder`'s balance on `token`, found without assuming a layout:
 * eth_createAccessList of balanceOf(holder) lists every slot the call reads (proxies and
 * namespaced storage included); each candidate is set to a probe value and kept only if balanceOf
 * returns exactly that. Everything else is restored. null when no slot behaves like a plain balance.
 */
export async function findBalanceSlot(token, holder) {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [holder] });
  const { accessList } = await rpc("eth_createAccessList", [{ to: token, data }, "latest"]);
  const keys = accessList
    .filter((a) => a.address.toLowerCase() === token.toLowerCase())
    .flatMap((a) => a.storageKeys)
    .filter((k) => !PROXY_SLOTS.has(k.toLowerCase()));
  for (const slot of keys.reverse()) {
    const original = (await pub.getStorageAt({ address: token, slot })) ?? pad("0x0", { size: 32 });
    await rpc("anvil_setStorageAt", [token, slot, pad(toHex(PROBE), { size: 32 })]);
    let seen = null;
    try {
      seen = await read(token, erc20Abi, "balanceOf", [holder]);
    } catch {
      // the probe broke the call (a pointer or a packed flag lives here): not a balance slot
    }
    if (seen === PROBE) return slot;
    await rpc("anvil_setStorageAt", [token, slot, pad(original, { size: 32 })]);
  }
  return null;
}

/** EIP-1967 implementation, beacon and admin slots: never balance slots, and fatal to overwrite. */
const PROXY_SLOTS = new Set([
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
]);

/**
 * Set `holder`'s balance of `token` to exactly `amount` (base units). Storage first; if no balance
 * slot is found, transfer the difference from the first `whales` entry that holds enough, impersonated.
 * Returns how it was done.
 */
export async function deal(token, holder, amount, whales = []) {
  const slot = await findBalanceSlot(token, holder);
  if (slot !== null) {
    await rpc("anvil_setStorageAt", [token, slot, pad(toHex(amount), { size: 32 })]);
    const got = await read(token, erc20Abi, "balanceOf", [holder]);
    if (got !== amount) throw new Error(`deal ${token} -> ${holder}: storage write read back ${got}, wanted ${amount}`);
    return "storage";
  }
  const have = await read(token, erc20Abi, "balanceOf", [holder]);
  if (have >= amount) return "already";
  const need = amount - have;
  for (const whale of whales) {
    const bal = await read(token, erc20Abi, "balanceOf", [whale]);
    if (bal < need) continue;
    await rpc("anvil_impersonateAccount", [whale]);
    await rpc("anvil_setBalance", [whale, toHex(10n ** 18n)]);
    try {
      await send(whale, { address: token, abi: erc20Abi, functionName: "transfer", args: [holder, need], label: `whale transfer ${token}` });
    } finally {
      await rpc("anvil_stopImpersonatingAccount", [whale]);
    }
    return "whale";
  }
  throw new Error(`deal ${token} -> ${holder}: no balance slot found and no whale holds ${need}`);
}

/* ---------------------------------------------------------------------------------------------- */
/*  files                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

export function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Atomic JSON write (tmp + rename), 2-space indent, trailing newline. BigInts as decimal strings. */
export function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`;
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
}

export function loadAddresses() {
  if (!existsSync(ADDRESSES_FILE)) throw new Error(`${ADDRESSES_FILE} not found: run ops/devnet/up.sh first`);
  return readJson(ADDRESSES_FILE);
}

export function registry() {
  return readJson(REGISTRY_FILE);
}

/* ---------------------------------------------------------------------------------------------- */
/*  formatting                                                                                     */
/* ---------------------------------------------------------------------------------------------- */

export const usd = (base6) => (Number(base6) / 1e6).toFixed(2);
export function nyTime(ts) {
  return new Date(ts * 1000).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
}
export function die(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}
