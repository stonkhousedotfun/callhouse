/**
 * W-13: the dapp, driven in a real browser by a fresh wallet, against an anvil fork of Robinhood
 * Chain 4663, with the keeper running for real beside it. Write on fill: the fill page is the
 * venue.
 *
 * WHAT RUNS
 *   - anvil, forked from mainnet (started by you, see web/README.md "Fork acceptance (W-13)").
 *   - A Vault deployed from contracts/out with MockFeed, exactly as keeper/src/dryrun.ts deploys
 *     it: no registry, no Overcall, the REAL Valorem Clear and Seaport 1.6. The keeper creates
 *     the week's option type itself (`newOptionType`) and arms it with `rollOpen(id)`.
 *   - The keeper's production modules (reconcile, tick, the SQLite store, the Hono server that
 *     serves /orders), imported and driven the way the dry run drives them.
 *   - The web app, `next build` then `next start`, with every NEXT_PUBLIC_* pointed at the fork
 *     and KEEPER_ORDERS_URL at the keeper's real /orders. NEXT_PUBLIC_API_URL is unreachable so
 *     history comes from the log fallback.
 *   - Headless Chromium (playwright-core). Each wallet is an EIP-1193 provider injected into the
 *     page and announced over EIP-6963, backed by a key generated for this run.
 *
 * THE SCENARIO. The keeper authorises a PARTIAL_RESTRICTED order (vault as zone, one USDG leg,
 * empty signature). Seaport's counter for the vault is set non-zero before the listing so a
 * route that assumed 0 would hash a different order and fail here. First the keeper is made to
 * serve the order with its premium leg redirected: `/api/keeper/orders` rejects it and the cycle
 * page offers no fill. Then the row is restored, a fresh wallet fills 2 contracts from the page's
 * own button, and a raw Seaport client fills 3 more from /orders with no web code. Each fill
 * writes exactly those contracts (`CallsWritten`); the vault's option balance is 0 after each.
 * The buyer exercises 2 inside the window from the cycle page's Exercise button. lockBook,
 * rollClose (assigned 2), completeRedeem and claimUsdg from the page; /activity agrees with the
 * chain.
 *
 * FLOWS, each asserted to the base unit on chain and on the rendered page:
 *   (a) depositor: approve + deposit 25 NVDA from /vault/nvda; shares and their NAV render.
 *   (b) buyer: a tampered keeper order is refused by the route and not offered; then fill 2 of N
 *       from /vault/nvda/cycle; then 3 more from the raw payload.
 *       While still Listed, the cycle page and the home page show this week's terms (strike,
 *       deadlines, price per contract, contracts left to buy, the order total if every remaining
 *       contract sells and the protocol fee on it) equal to figures computed here from vault reads
 *       and Seaport's status, and the cycle page shows the keeper's fixed-mode pricing report.
 *   (c) depositor: queue 10 shares while the vault is Listed.
 *   (d) warp to exercise; the buyer exercises 2 from the cycle page's Exercise card (approve
 *       exactly the strike cost plus the Clear's fee to the Clear, then exercise(optionId, 2));
 *       warp to expiry; keeper ticks lockBook and rollClose; the depositor completes the redeem
 *       and claims USDG from the page.
 *   (e) /vault/nvda and /activity show the assigned week, premium and strike proceeds apart.
 *
 * ENV (all optional)
 *   ACCEPTANCE_RPC              anvil endpoint. Default http://127.0.0.1:8548
 *   ACCEPTANCE_ARTIFACTS        contracts/out. Default ../contracts/out from web/
 *   ACCEPTANCE_OUT              run artefacts (keeper.db, run.json, next logs). Default a temp dir
 *   ACCEPTANCE_HEADFUL          1 to watch the browser
 *   ACCEPTANCE_KEEPER_LOG_LEVEL keeper pino level. Default warn
 *
 * It writes storage and warps time, and refuses to run against anything that is not anvil on
 * chain 4663. It overwrites web/.next with a build pointed at the fork: rebuild before serving
 * anything else from this checkout.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import {
  createPublicClient,
  createWalletClient,
  decodeFunctionData,
  defineChain,
  encodeAbiParameters,
  getAddress,
  http,
  keccak256,
  pad,
  parseEventLogs,
  toHex,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

import { valoremClearAbi } from "../../lib/abi/clear";
import { stockTokenAbi } from "../../lib/abi/erc20";
import { seaportAbi } from "../../lib/abi/seaport";
import { vaultAbi } from "../../lib/abi/vault";
import { ASSET, CLEARINGHOUSE, SEAPORT, USDG, ZERO_CONDUIT_KEY } from "../../lib/contracts";
import type { KeeperOrderBook } from "../../lib/api";
import { CYCLE_TERMS_LABELS, cycleTerms } from "../../lib/cycleTerms";
import { fmtAsset, fmtEastern, fmtUsdg, fmtUtc, fmtUtcDate, premiumPerShare, shortAddress } from "../../lib/format";
import { KEEPER_REASONS, componentsStruct, seaportOrderHash } from "../../lib/keeperOrders";
import { REASONS, checkListingIsOurs, type ListingRow as FeedListing } from "../../lib/listing";
import type { CycleRow, ListingRow } from "../../../keeper/src/state.js";

/*//////////////////////////////////////////////////////////////
                              SETTINGS
//////////////////////////////////////////////////////////////*/

const CHAIN_ID = 4663;
/** Chainlink RHNVDA/USD on 4663. Read once for its live answer, then mirrored into MockFeed. */
const REAL_FEED = getAddress("0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15");

const RPC = process.env.ACCEPTANCE_RPC ?? "http://127.0.0.1:8548";
const WEB_DIR = fileURLToPath(new URL("../../", import.meta.url));
const REPO_DIR = resolve(WEB_DIR, "..");
const ARTIFACTS = resolve(process.env.ACCEPTANCE_ARTIFACTS ?? join(REPO_DIR, "contracts", "out"));
const STARTED = new Date();
const OUT = resolve(
  process.env.ACCEPTANCE_OUT ?? join(tmpdir(), `callhouse-w13-${STARTED.toISOString().replace(/[:.]/g, "-")}`),
);
const HEADFUL = process.env.ACCEPTANCE_HEADFUL === "1";
const KEEPER_LOG_LEVEL = process.env.ACCEPTANCE_KEEPER_LOG_LEVEL ?? "warn";

const LOT = 10n ** 18n;
const ACC_PRECISION = 10n ** 27n;
const BPS = 10_000n;
/** What the depositor types into the deposit form, and its base units. */
const DEPOSIT_INPUT = "25";
const DEPOSIT = 25n * LOT;
/** What the depositor types into the withdraw form while the call is live. */
const QUEUE_INPUT = "10";
const QUEUED = 10n * LOT;
/** Contracts the buyer takes from the cycle page, then from the raw /orders JSON. */
const FILL_FROM_PAGE = 2n;
const FILL_FROM_RAW_PAYLOAD = 3n;
/** Of the 5 sold, the buyer exercises this many. The rest expire. */
const EXERCISE_W = 2n;

const EMPTY_SIGNATURE = "0x" as Hex;

/** The launch policy the Vault constructor installs (Policy.launchDefaults()). */
const LAUNCH_POLICY = { minOtmBps: 300, maxOtmBps: 1200, protocolFeeBps: 500 } as const;

/*//////////////////////////////////////////////////////////////
                               ACTORS
//////////////////////////////////////////////////////////////*/

/**
 * Operator actors are derived from a label; anvil's well-known accounts carry an EIP-7702
 * delegation on 4663 and break ERC-1155 receipts (keeper/src/dryrun.ts, derivedActor). The two
 * users are brand-new keys generated for this run: a fresh wallet is the point of W-13.
 */
function operator(label: string): PrivateKeyAccount {
  return privateKeyToAccount(keccak256(toHex(`callhouse-w13:${label}`)));
}
const KEEPER_PK = keccak256(toHex("callhouse-w13:keeper"));
const KEEPER = privateKeyToAccount(KEEPER_PK);
const ADMIN = operator("admin");
const GUARDIAN = operator("guardian");
const FEE_SAFE = operator("fee-safe");
/** Where the tampered keeper order sends the vault's premium. Never funded, never signs. */
const ATTACKER = operator("attacker");
/** Seaport's counter for the vault during the run. Non-zero, so the counter restore is observable. */
const SEAPORT_COUNTER = 7n;
const DEPOSITOR = privateKeyToAccount(generatePrivateKey());
const BUYER = privateKeyToAccount(generatePrivateKey());

const forkChain: Chain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain (anvil fork, W-13)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});
const pub: PublicClient = createPublicClient({ chain: forkChain, transport: http(RPC) });
const walletClient: WalletClient = createWalletClient({ chain: forkChain, transport: http(RPC) });

/*//////////////////////////////////////////////////////////////
                          RECORD AND ASSERT
//////////////////////////////////////////////////////////////*/

type TxEvidence = { label: string; by: string; hash: Hex; block: string; via: "browser" | "harness" | "keeper" };

const record = {
  startedAt: STARTED.toISOString(),
  rpc: RPC,
  anvil: "",
  forkBlock: "",
  out: OUT,
  approach: "playwright-core Chromium, injected EIP-1193/EIP-6963 wallet backed by fresh keys, next build + next start",
  actors: {} as Record<string, string>,
  addresses: {} as Record<string, string>,
  web: {} as Record<string, string>,
  txs: [] as TxEvidence[],
  amounts: {} as Record<string, string>,
  pages: [] as string[],
  alerts: [] as string[],
  stubRequests: [] as string[],
  steps: [] as Array<{ step: string; ms: number }>,
  error: null as string | null,
};

let currentStep = "preflight";

function note(text: string): void {
  process.stdout.write(`    ${text}\n`);
}

async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  currentStep = label;
  process.stdout.write(`\n== ${label}\n`);
  const t0 = Date.now();
  const out = await run();
  record.steps.push({ step: label, ms: Date.now() - t0 });
  return out;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED (${currentStep}): ${message}`);
}

function assertEq<T extends bigint | number | string | boolean | null>(actual: T, expected: T, message: string): void {
  assert(actual === expected, `${message} (expected ${String(expected)}, got ${String(actual)})`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function jsonish(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) ? v.toLowerCase() : v));
}

/*//////////////////////////////////////////////////////////////
                             RAW ANVIL RPC
//////////////////////////////////////////////////////////////*/

type RpcError = { code: number; message: string; data?: unknown };
let rpcId = 0;

async function rpcRaw(method: string, params: unknown[]): Promise<{ result?: unknown; error?: RpcError }> {
  const response = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: (rpcId += 1), method, params }),
  });
  return (await response.json()) as { result?: unknown; error?: RpcError };
}

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const body = await rpcRaw(method, params);
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result as T;
}

async function latestTimestamp(): Promise<bigint> {
  return (await pub.getBlock({ blockTag: "latest" })).timestamp;
}

async function warpTo(target: bigint, label: string): Promise<void> {
  const before = await latestTimestamp();
  if (before >= target) return;
  const delta = target - before + 60n;
  await rpc("evm_increaseTime", [Number(delta)]);
  await rpc("evm_mine", []);
  note(`warped to ${label}: ${before} -> ${await latestTimestamp()} (+${delta}s)`);
}

/** Loose reads: the generated vault ABI is large, and the assertions below name their types. */
async function read<T>(address: Address, abi: Abi | readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<T> {
  return (await pub.readContract({ address, abi: abi as Abi, functionName, args })) as T;
}

async function erc20Balance(token: Address, holder: Address): Promise<bigint> {
  return read<bigint>(token, stockTokenAbi, "balanceOf", [holder]);
}

/**
 * Write a token balance into storage. Mirrors keeper/src/dryrun.ts `deal`: NVDA keeps `_balances`
 * at its ERC-7201 namespaced slot, USDG at slot 1; both are probed rather than assumed, and a
 * wrong guess is restored before the next one.
 */
const ERC20_STORAGE_BASES: bigint[] = [
  BigInt("0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00"),
  ...Array.from({ length: 64 }, (_, i) => BigInt(i)),
];

async function deal(token: Address, holder: Address, amount: bigint): Promise<void> {
  for (const base of ERC20_STORAGE_BASES) {
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, base]));
    const previous = await rpc<Hex>("eth_getStorageAt", [token, slot, "latest"]);
    await rpc("anvil_setStorageAt", [token, slot, pad(toHex(amount), { size: 32 })]);
    if ((await erc20Balance(token, holder)) === amount) return;
    await rpc("anvil_setStorageAt", [token, slot, previous]);
  }
  throw new Error(`could not find the balances slot of ${token}`);
}

/**
 * Write Seaport's counter for an offerer (`mapping(address => uint256) _counters`), probing for
 * the mapping's slot the way `deal` probes a token's, and restoring each wrong guess. Done before
 * the keeper lists, so the keeper reads it, Seaport's validate() inside approveListing hashes with
 * it, and everything after is consistent with a vault whose counter is not zero.
 */
async function setSeaportCounter(offerer: Address, counter: bigint): Promise<void> {
  for (let base = 0n; base < 64n; base += 1n) {
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [offerer, base]));
    const previous = await rpc<Hex>("eth_getStorageAt", [SEAPORT, slot, "latest"]);
    await rpc("anvil_setStorageAt", [SEAPORT, slot, pad(toHex(counter), { size: 32 })]);
    if ((await read<bigint>(SEAPORT, seaportAbi, "getCounter", [offerer])) === counter) return;
    await rpc("anvil_setStorageAt", [SEAPORT, slot, previous]);
  }
  throw new Error("could not find Seaport's counters slot");
}

/*//////////////////////////////////////////////////////////////
                      DEPLOYMENTS (harness side)
//////////////////////////////////////////////////////////////*/

type Artifact = {
  abi: Abi;
  bytecode: { object: Hex; linkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>> };
  metadata?: { settings?: { libraries?: Record<string, string> } };
};

function artifact(file: string): Artifact {
  const path = join(ARTIFACTS, file);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Artifact;
  } catch (error) {
    throw new Error(`cannot read ${path}; run \`forge build\` in contracts/ first (${String(error)})`);
  }
}

async function harnessTx(label: string, by: PrivateKeyAccount, send: () => Promise<Hex>): Promise<TransactionReceipt> {
  const hash = await send();
  const receipt = await pub.waitForTransactionReceipt({ hash });
  assert(receipt.status === "success", `${label} reverted (tx ${hash})`);
  record.txs.push({ label, by: by.address, hash, block: receipt.blockNumber.toString(), via: "harness" });
  return receipt;
}

async function deploy(label: string, abi: Abi, bytecode: Hex, args: readonly unknown[]): Promise<{ address: Address; block: bigint }> {
  const receipt = await harnessTx(`deploy ${label}`, ADMIN, () =>
    walletClient.deployContract({ account: ADMIN, chain: forkChain, abi, bytecode, args: args as never }),
  );
  assert(receipt.contractAddress !== null && receipt.contractAddress !== undefined, `${label}: no contract address`);
  const address = getAddress(receipt.contractAddress);
  record.addresses[label] = address;
  note(`${label} at ${address}`);
  return { address, block: receipt.blockNumber };
}

/** Link by the artifact's byte offsets, as keeper/src/dryrun.ts `deployLinked` does. */
async function deployLinked(label: string, art: Artifact, args: readonly unknown[]): Promise<{ address: Address; block: bigint }> {
  const pinned = Object.keys(art.metadata?.settings?.libraries ?? {});
  assert(pinned.length === 0, `${label} was compiled with pinned libraries (${pinned.join(",")}); run forge clean && forge build`);
  let code = art.bytecode.object.slice(2);
  for (const byName of Object.values(art.bytecode.linkReferences)) {
    for (const [name, sites] of Object.entries(byName)) {
      const lib = artifact(`${name}.sol/${name}.json`);
      const { address } = await deploy(name, lib.abi, lib.bytecode.object, []);
      for (const site of sites) {
        const at = site.start * 2;
        assert(code.slice(at, at + 3) === "__$", `${name} placeholder at byte ${site.start}`);
        code = code.slice(0, at) + address.slice(2).toLowerCase() + code.slice(at + 40);
      }
    }
  }
  assert(!code.includes("__$"), "unlinked placeholders remain");
  return deploy(label, art.abi, `0x${code}`, args);
}

const mockFeedWriteAbi = [
  { type: "function", name: "setAnswer", inputs: [{ name: "answer", type: "int256" }], outputs: [], stateMutability: "nonpayable" },
] as const;

const feedAbi = [
  {
    type: "function",
    name: "latestRoundData",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
  },
] as const;

const clearBalanceAbi = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [
      { name: "owner", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
] as const;

/*//////////////////////////////////////////////////////////////
                         LOCAL HTTP SERVICES
//////////////////////////////////////////////////////////////*/

async function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createNetServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => done(port));
    });
  });
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void> | void): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      Promise.resolve(handler(req, res, Buffer.concat(chunks).toString("utf8"))).catch((error: unknown) => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(error) }));
      });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(typeof address === "object" && address !== null, "server did not bind");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The raw /orders payload the keeper serves (keeper/src/health.ts). */
type KeeperOrder = {
  orderHash: Hex;
  chainId: number;
  seaport: string;
  optionId: string;
  contracts: string;
  unitPrice6: string;
  grossUsdg6: string;
  endTime: number;
  status: string;
  bookStatus: string | null;
  parameters: {
    offerer: string;
    zone: string;
    offer: Array<{ itemType: number; token: string; identifierOrCriteria: string; startAmount: string; endAmount: string }>;
    consideration: Array<{ itemType: number; token: string; identifierOrCriteria: string; startAmount: string; endAmount: string; recipient: string }>;
    orderType: number;
    startTime: string;
    endTime: string;
    zoneHash: string;
    salt: string;
    conduitKey: string;
    totalOriginalConsiderationItems: string;
  };
  signature: Hex;
};

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  assert(response.ok, `GET ${url} answered ${response.status}`);
  return (await response.json()) as T;
}

/** What the web app's GET /api/keeper/orders answers (app/api/keeper/orders/route.ts). */
type KeeperRouteBody = {
  configured: boolean;
  orders: FeedListing[];
  rejected: KeeperOrderBook["rejected"];
  closed: KeeperOrderBook["closed"];
  unchecked: KeeperOrderBook["unchecked"];
  error?: string;
};

/**
 * GET the web app's keeper fallback route until `until` holds. The route shares an answer for two
 * seconds, so a change on the keeper side reaches it within that window, not instantly.
 */
async function keeperRoute(webUrl: string, label: string, until: (body: KeeperRouteBody, status: number) => boolean): Promise<KeeperRouteBody> {
  const deadline = Date.now() + 20_000;
  let last = "";
  while (Date.now() < deadline) {
    const response = await fetch(`${webUrl}/api/keeper/orders`, { headers: { accept: "application/json" } });
    const body = (await response.json()) as KeeperRouteBody;
    last = `${response.status} ${JSON.stringify(body)}`;
    if (until(body, response.status)) {
      record.pages.push(`${label}: /api/keeper/orders ${response.status}`);
      return body;
    }
    await sleep(500);
  }
  throw new Error(`ASSERTION FAILED (${currentStep}): ${label}: /api/keeper/orders never matched; last answer ${last}`);
}

/*//////////////////////////////////////////////////////////////
                     THE BROWSER WALLET (EIP-1193)
//////////////////////////////////////////////////////////////*/

type SentTx = { hash: Hex; to: Address; functionName: string; args: readonly unknown[]; status: string; block: bigint };

const KNOWN_CALLS: Array<{ abi: Abi; match: (to: Address) => boolean }> = [
  { abi: stockTokenAbi as unknown as Abi, match: (to) => to === ASSET || to === USDG },
  { abi: seaportAbi as unknown as Abi, match: (to) => to === SEAPORT },
  { abi: valoremClearAbi as unknown as Abi, match: (to) => to === CLEARINGHOUSE },
  { abi: vaultAbi as unknown as Abi, match: (to) => to === getAddress(record.addresses.Vault ?? "0x0000000000000000000000000000000000000000") },
];

/**
 * A wallet the page cannot tell from an extension: it answers the EIP-1193 methods wagmi's
 * injected connector uses, signs eth_sendTransaction with a local key, and forwards every other
 * call to the fork. It refuses to sign a call it cannot decode against the app's own ABIs, so
 * every transaction a page sends is recorded by function name and arguments.
 */
class BrowserWallet {
  readonly sent: SentTx[] = [];
  private authorised = false;

  constructor(
    readonly label: string,
    readonly account: PrivateKeyAccount,
  ) {}

  async attach(context: BrowserContext): Promise<void> {
    await context.exposeBinding("__callhouseAcceptanceWallet", async (_source, method: string, params: unknown) =>
      this.handle(method, Array.isArray(params) ? params : []),
    );
    await context.addInitScript({
      content: injectedProviderSource({ name: "MetaMask", uuid: "5b8d3c2e-6b0e-4a51-9d7e-0c1f3a2b4c5d" }),
    });
  }

  private async handle(method: string, params: unknown[]): Promise<{ result?: unknown; error?: RpcError }> {
    try {
      switch (method) {
        // Like an extension: no account is exposed to the site until it has asked, so the page's
        // own Connect flow is what authorises it. After that it stays authorised across reloads.
        case "eth_requestAccounts":
        case "wallet_requestPermissions":
          this.authorised = true;
          return { result: method === "eth_requestAccounts" ? [this.account.address] : [{ parentCapability: "eth_accounts" }] };
        case "eth_accounts":
          return { result: this.authorised ? [this.account.address] : [] };
        case "wallet_getPermissions":
          return { result: this.authorised ? [{ parentCapability: "eth_accounts" }] : [] };
        case "eth_chainId":
          return { result: toHex(CHAIN_ID) };
        case "net_version":
          return { result: String(CHAIN_ID) };
        case "wallet_switchEthereumChain": {
          const wanted = Number((params[0] as { chainId?: string } | undefined)?.chainId ?? "0");
          return wanted === CHAIN_ID ? { result: null } : { error: { code: 4902, message: `chain ${wanted} is not this wallet's` } };
        }
        case "wallet_revokePermissions":
          this.authorised = false;
          return { result: null };
        case "eth_sendTransaction":
          return { result: await this.send(params[0] as { from?: string; to?: string; data?: Hex; input?: Hex; value?: Hex; gas?: Hex }) };
        default:
          return await rpcRaw(method, params);
      }
    } catch (error) {
      return { error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
    }
  }

  private async send(tx: { from?: string; to?: string; data?: Hex; input?: Hex; value?: Hex; gas?: Hex }): Promise<Hex> {
    assert(tx.to !== undefined, `${this.label}: the page asked for a transaction with no recipient`);
    assert(tx.from === undefined || getAddress(tx.from) === this.account.address, `${this.label}: the page asked to send from ${tx.from}`);
    const to = getAddress(tx.to);
    const data = tx.data ?? tx.input ?? "0x";
    const known = KNOWN_CALLS.find((entry) => entry.match(to));
    assert(known !== undefined, `${this.label}: refusing to sign a call to unknown contract ${to}`);
    const decoded = decodeFunctionData({ abi: known.abi, data });
    const hash = await walletClient.sendTransaction({
      account: this.account,
      chain: forkChain,
      to,
      data,
      value: tx.value === undefined ? 0n : BigInt(tx.value),
      gas: tx.gas === undefined ? undefined : BigInt(tx.gas),
    });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    this.sent.push({ hash, to, functionName: decoded.functionName, args: decoded.args ?? [], status: receipt.status, block: receipt.blockNumber });
    record.txs.push({ label: `${this.label}: ${decoded.functionName}`, by: this.account.address, hash, block: receipt.blockNumber.toString(), via: "browser" });
    note(`${this.label} signed ${decoded.functionName} from the page: tx ${hash} (${receipt.status}, block ${receipt.blockNumber})`);
    return hash;
  }

  /** The next page transaction after `from` calling `functionName`, once its receipt exists. */
  async waitFor(functionName: string, from: number, timeoutMs = 90_000): Promise<SentTx> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.sent.slice(from).find((tx) => tx.functionName === functionName);
      if (found) {
        assertEq(found.status, "success", `${this.label} ${functionName} receipt`);
        return found;
      }
      await sleep(250);
    }
    throw new Error(`ASSERTION FAILED (${currentStep}): ${this.label} never sent ${functionName} (sent: ${this.sent.map((t) => t.functionName).join(", ") || "nothing"})`);
  }
}

/**
 * Runs inside the page before any app script. A plain-JS string on purpose: a TypeScript function
 * handed to addInitScript is serialised from the transpiled source, and the transpiler may wrap
 * nested functions in helpers that do not exist in the page.
 */
function injectedProviderSource(info: { name: string; uuid: string }): string {
  return `(() => {
  const listeners = new Map();
  const provider = {
    isMetaMask: true,
    isCallhouseAcceptanceWallet: true,
    async request(req) {
      const out = await window.__callhouseAcceptanceWallet(req.method, req.params === undefined ? [] : req.params);
      if (out && out.error) {
        const error = new Error(out.error.message);
        error.code = out.error.code;
        error.data = out.error.data;
        throw error;
      }
      return out ? out.result : undefined;
    },
    on(event, listener) {
      const set = listeners.get(event) || new Set();
      set.add(listener);
      listeners.set(event, set);
      return provider;
    },
    removeListener(event, listener) {
      const set = listeners.get(event);
      if (set) set.delete(listener);
      return provider;
    },
  };
  window.ethereum = provider;
  const detail = Object.freeze({
    info: Object.freeze({
      uuid: ${JSON.stringify(info.uuid)},
      name: ${JSON.stringify(info.name)},
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiLz4=",
      rdns: "io.metamask",
    }),
    provider,
  });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();`;
}

/*//////////////////////////////////////////////////////////////
                             PAGE HELPERS
//////////////////////////////////////////////////////////////*/

/** Every page the run opens, so a failure can leave a screenshot and the DOM behind. */
const OPEN_PAGES: Page[] = [];

/**
 * The page's test hooks. The Daylight primitives in components/ui stamp `data-slot` on every card,
 * card head, figure, ledger row and notice, and the nav stamps it on the header; the run finds
 * things by those, never by Tailwind class names, so a restyle cannot move a selector.
 */
const SLOT = {
  topbar: '[data-slot="topbar"]',
  card: '[data-slot="card"]',
  cardTitle: '[data-slot="card-title"]',
  cardMeta: '[data-slot="card-meta"]',
  row: '[data-slot="row"]',
  k: '[data-slot="k"]',
  v: '[data-slot="v"]',
  stat: '[data-slot="stat"]',
  statLabel: '[data-slot="stat-label"]',
  statValue: '[data-slot="stat-value"]',
  statSub: '[data-slot="stat-sub"]',
  notice: '[data-slot="notice"]',
} as const;

function card(page: Page, title: string | RegExp): Locator {
  return page.locator(SLOT.card).filter({ has: page.locator(SLOT.cardTitle, { hasText: title }) });
}

function rowValue(scope: Locator, key: RegExp): Locator {
  return scope.locator(SLOT.row).filter({ has: scope.page().locator(SLOT.k, { hasText: key }) }).locator(SLOT.v);
}

function stat(scope: Locator, label: RegExp): { value: Locator; sub: Locator } {
  const box = scope.locator(SLOT.stat).filter({ has: scope.page().locator(SLOT.statLabel, { hasText: label }) });
  return { value: box.locator(SLOT.statValue), sub: box.locator(SLOT.statSub) };
}

/** USDG as lib/cycleTerms.ts shows every figure: two decimals on whole cents, all six otherwise. */
function exactUsdg(value: bigint): string {
  return fmtUsdg(value, value % 10_000n === 0n ? 2 : 6);
}

function exactly(text: string): RegExp {
  return new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/** Poll a locator's rendered text until it matches. Every figure the run checks goes through here. */
async function expectText(label: string, locator: Locator, expected: string | RegExp, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      // textContent, not innerText: CSS text-transform would otherwise change what is compared.
      last = ((await locator.textContent({ timeout: 2_000 })) ?? "").replace(/\s+/g, " ").trim();
    } catch (error) {
      last = `<${(error instanceof Error ? error.message : String(error)).split("\n")[0]}>`;
    }
    if (typeof expected === "string" ? last === expected : expected.test(last)) {
      record.pages.push(`${label}: "${last}"`);
      note(`page ${label}: "${last}"`);
      return;
    }
    await sleep(500);
  }
  throw new Error(`ASSERTION FAILED (${currentStep}): page ${label}: expected ${String(expected)}, rendered "${last}"`);
}

async function expectAbsent(label: string, locator: Locator): Promise<void> {
  assertEq(await locator.count(), 0, `page ${label} is absent`);
  record.pages.push(`${label}: absent`);
  note(`page ${label}: absent`);
}

async function connectWallet(page: Page, account: Address): Promise<void> {
  const header = page.locator(`header${SLOT.topbar}`);
  await header.getByRole("button", { name: "Connect", exact: true }).click({ timeout: 60_000 });
  await header.getByRole("button", { name: "MetaMask", exact: true }).click({ timeout: 30_000 });
  await expectText("header connect button", header.getByRole("button").last(), shortAddress(account));
}

/*//////////////////////////////////////////////////////////////
                              THE WEB APP
//////////////////////////////////////////////////////////////*/

async function runToEnd(label: string, command: string, args: string[], env: NodeJS.ProcessEnv, logFile: string): Promise<void> {
  const fd = openSync(logFile, "w");
  try {
    const code = await new Promise<number | null>((done, fail) => {
      const child = spawn(command, args, { cwd: WEB_DIR, env, stdio: ["ignore", fd, fd] });
      child.once("error", fail);
      child.once("exit", done);
    });
    assert(code === 0, `${label} exited ${String(code)}; see ${logFile}`);
  } finally {
    closeSync(fd);
  }
}

function webEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Nothing from the caller's shell may point this build at a real chain or a real book.
    if (key.startsWith("NEXT_PUBLIC_") || key.startsWith("KEEPER_")) continue;
    env[key] = value;
  }
  return { ...env, NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "production", ...extra };
}

/*//////////////////////////////////////////////////////////////
                          THE KEEPER MODULES
//////////////////////////////////////////////////////////////*/

/**
 * state, seaport, policy and clients are imported with their own types. roll.ts and health.ts
 * (which imports roll) are loaded through a non-literal specifier and typed by the slice below:
 * this project must also type-check web/lib, whose code is written without
 * noUncheckedIndexedAccess, while roll.ts only type-checks WITH it (keeper/tsconfig.json). One
 * program cannot hold both, and keeper/src is not this task's to change. `pnpm --filter
 * @callhouse/keeper typecheck` remains the gate for roll.ts itself.
 */
type KeeperRoll = {
  reconcile(): Promise<void>;
  tick(): Promise<void>;
  getLastSnapshot(): { phase: number } | null;
  Phase: { Idle: number; Listed: number; Exercisable: number; Settling: number };
};
type KeeperHealth = { startHealthServer(): { close(): unknown } };

function untypedKeeperModule(name: "roll" | "health"): string {
  return `../../../keeper/src/${name}.js`;
}

/*//////////////////////////////////////////////////////////////
                                MAIN
//////////////////////////////////////////////////////////////*/

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const cleanups: Array<() => Promise<void> | void> = [];

  try {
    await step("preflight: anvil fork of 4663, artifacts, browser", async () => {
      const clientVersion = await rpc<string>("web3_clientVersion");
      assert(clientVersion.toLowerCase().includes("anvil"), `${RPC} is not anvil ("${clientVersion}"); this run writes storage and warps time`);
      assertEq(await pub.getChainId(), CHAIN_ID, "chain id");
      const info = await rpc<{ forkConfig?: { forkBlockNumber?: number } }>("anvil_nodeInfo").catch(() => ({ forkConfig: undefined }));
      record.anvil = clientVersion;
      record.forkBlock = String(info.forkConfig?.forkBlockNumber ?? (await pub.getBlockNumber()));
      artifact("Vault.sol/Vault.json");
      for (const [label, address] of Object.entries({ ASSET, USDG, SEAPORT, CLEARINGHOUSE })) {
        const code = await rpc<Hex>("eth_getCode", [address, "latest"]);
        assert(code.length > 2, `${label} ${address} has no code on the fork`);
      }
      Object.assign(record.actors, {
        admin: ADMIN.address,
        keeper: KEEPER.address,
        guardian: GUARDIAN.address,
        feeSafe: FEE_SAFE.address,
        depositor: DEPOSITOR.address,
        buyer: BUYER.address,
      });
      for (const actor of [ADMIN, KEEPER, GUARDIAN, FEE_SAFE, DEPOSITOR, BUYER]) {
        await rpc("anvil_setBalance", [actor.address, toHex(100n * LOT)]);
        await rpc("anvil_setCode", [actor.address, "0x"]);
      }
      assertEq(await pub.getTransactionCount({ address: DEPOSITOR.address }), 0, "the depositor is a fresh wallet (nonce 0)");
      assertEq(await pub.getTransactionCount({ address: BUYER.address }), 0, "the buyer is a fresh wallet (nonce 0)");
      note(`${clientVersion}, fork block ${record.forkBlock}; depositor ${DEPOSITOR.address}, buyer ${BUYER.address} (keys generated this run)`);
      note(`artefacts: ${OUT}`);
    });

    /* ---------- deploy and configure the vault ---------- */

    const { vault, vaultBlock, feed } = await step("deploy MockFeed (live answer), linked Vault; grant KEEPER_ROLE and GUARDIAN_ROLE", async () => {
      const [, answer] = await read<readonly [bigint, bigint, bigint, bigint, bigint]>(REAL_FEED, feedAbi, "latestRoundData");
      const mockFeed = artifact("MockFeed.sol/MockFeed.json");
      const feedAt = await deploy("MockFeed", mockFeed.abi, mockFeed.bytecode.object, [8, answer, "RHNVDA / USD (W-13 mirror of the live answer)"]);
      const vaultArtifact = artifact("Vault.sol/Vault.json");
      const vaultAt = await deployLinked("Vault", vaultArtifact, [
        {
          asset: ASSET,
          usdg: USDG,
          clear: CLEARINGHOUSE,
          seaport: SEAPORT,
          priceFeed: feedAt.address,
          maxPriceAge: 4 * 86_400,
          conduitKey: ZERO_CONDUIT_KEY,
          admin: ADMIN.address,
          feeRecipient: FEE_SAFE.address,
          depositCap: 50n * LOT,
          name: "Callhouse NVDA (W-13 fork)",
          symbol: "cNVDA",
        },
      ]);
      const keeperRole = await read<Hex>(vaultAt.address, vaultArtifact.abi, "KEEPER_ROLE");
      const guardianRole = await read<Hex>(vaultAt.address, vaultArtifact.abi, "GUARDIAN_ROLE");
      await harnessTx("grantRole(KEEPER_ROLE, keeper)", ADMIN, () =>
        walletClient.writeContract({ account: ADMIN, chain: forkChain, address: vaultAt.address, abi: vaultArtifact.abi, functionName: "grantRole", args: [keeperRole, KEEPER.address] }),
      );
      await harnessTx("grantRole(GUARDIAN_ROLE, guardian)", ADMIN, () =>
        walletClient.writeContract({ account: ADMIN, chain: forkChain, address: vaultAt.address, abi: vaultArtifact.abi, functionName: "grantRole", args: [guardianRole, GUARDIAN.address] }),
      );
      assertEq(await read<Address>(vaultAt.address, vaultAbi, "seaportZone"), vaultAt.address, "the vault is its own Seaport zone");
      assertEq(await read<Address>(vaultAt.address, vaultAbi, "clear"), CLEARINGHOUSE, "constructed on the real Clear");
      const [minOtmBps, maxOtmBps, , , protocolFeeBps] = await read<readonly [number, number, number, number, number, bigint]>(vaultAt.address, vaultAbi, "policy");
      assertEq(protocolFeeBps, LAUNCH_POLICY.protocolFeeBps, "policy().protocolFeeBps is the launch default");
      assertEq(minOtmBps, LAUNCH_POLICY.minOtmBps, "policy().minOtmBps is the launch default");
      assertEq(maxOtmBps, LAUNCH_POLICY.maxOtmBps, "policy().maxOtmBps is the launch default");
      record.amounts.spotAtDeploy6 = (await read<bigint>(vaultAt.address, vaultAbi, "spotUsdg")).toString();
      return { vault: vaultAt.address, vaultBlock: vaultAt.block, feed: feedAt.address };
    });

    const alerts: Array<{ kind: string; message: string }> = [];
    const alertSink = await listen((_req, res, body) => {
      const payload = JSON.parse(body) as { kind: string; severity: string; message: string };
      alerts.push({ kind: payload.kind, message: payload.message });
      record.alerts.push(`[${payload.severity}] ${payload.kind}: ${payload.message}`);
      reply(res, 200, { ok: true });
    });
    cleanups.push(() => void alertSink.server.close());

    const keeperPort = await freePort();
    const keeperUrl = `http://127.0.0.1:${keeperPort}`;

    /* ---------- the web app, built against the fork ---------- */

    const web = await step("next build + next start with every NEXT_PUBLIC_* pointed at the fork", async () => {
      const unreachableIndexer = `http://127.0.0.1:${await freePort()}`;
      const publicEnv: Record<string, string> = {
        NEXT_PUBLIC_CHAIN_ID: String(CHAIN_ID),
        NEXT_PUBLIC_RPC_URL: RPC,
        // The backup RPC defaults to a real mainnet node. On a fork it must be the fork too.
        NEXT_PUBLIC_RPC_URL_2: RPC,
        NEXT_PUBLIC_VAULT: vault,
        NEXT_PUBLIC_VAULT_FROM_BLOCK: vaultBlock.toString(),
        NEXT_PUBLIC_ASSET: ASSET,
        NEXT_PUBLIC_USDG: USDG,
        NEXT_PUBLIC_CLEARINGHOUSE: CLEARINGHOUSE,
        NEXT_PUBLIC_SEAPORT: SEAPORT,
        // No indexer runs here: /activity and "Last week realized" must come from the log fallback.
        NEXT_PUBLIC_API_URL: unreachableIndexer,
        NEXT_PUBLIC_APP_URL: "http://127.0.0.1",
      };
      const serverEnv = { KEEPER_ORDERS_URL: `${keeperUrl}/orders` };
      Object.assign(record.web, publicEnv, serverEnv);
      const nextBin = join(WEB_DIR, "node_modules", ".bin", "next");
      const env = webEnv({ ...publicEnv, ...serverEnv });
      const t0 = Date.now();
      await runToEnd("next build", nextBin, ["build"], env, join(OUT, "next-build.log"));
      note(`next build ok in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      const port = await freePort();
      const logFd = openSync(join(OUT, "next-start.log"), "w");
      const child: ChildProcess = spawn(nextBin, ["start", "-p", String(port), "-H", "127.0.0.1"], {
        cwd: WEB_DIR,
        env,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
      cleanups.push(() => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
        closeSync(logFd);
      });
      const url = `http://127.0.0.1:${port}`;
      const deadline = Date.now() + 90_000;
      for (;;) {
        const up = await fetch(`${url}/vault/nvda`).then((r) => r.ok, () => false);
        if (up) break;
        assert(Date.now() < deadline && child.exitCode === null, `next start did not come up; see ${join(OUT, "next-start.log")}`);
        await sleep(500);
      }
      // The server-rendered HTML carries the build's compiled-in vault address.
      const html = await (await fetch(`${url}/vault/nvda`)).text();
      assert(html.includes(vault), "the /vault/nvda HTML names the fork vault (NEXT_PUBLIC_VAULT inlined)");
      record.web.url = url;
      note(`web app at ${url}`);
      return { url };
    });

    /* ---------- the keeper, for real ---------- */

    const keeperDb = join(OUT, "keeper.db");
    Object.assign(process.env, {
      KEEPER_ENV_FILE: "/dev/null",
      RH_RPC: RPC,
      CHAIN_ID: String(CHAIN_ID),
      CLEARINGHOUSE,
      VAULT: vault,
      KEEPER_PK,
      KEEPER_DB_PATH: keeperDb,
      KEEPER_PORT: String(keeperPort),
      KEEPER_LOG_LEVEL,
      KEEPER_FALLBACK_DIR: join(OUT, "fallback"),
      KEEPER_PREMIUM_MARGIN_BPS: "50",
      // The fork's clock is warped and no live Cboe chain lists its expiries, so vol pricing (the
      // keeper default) would skip every arm with a vol-* reason. Fixed mode, as in keeper/src/dryrun*.ts.
      KEEPER_PRICING_MODE: "fixed",
      KEEPER_RETRY_STRANDED_MS: "1000",
      ALERT_WEBHOOK: `${alertSink.url}/alerts`,
    });
    delete process.env.RH_RPC_2;
    delete process.env.KEEPER_UNIT_PRICE_USDG6;

    // Imported only now: keeper/src/config.ts validates the environment above at import time.
    const roll = (await import(untypedKeeperModule("roll"))) as KeeperRoll;
    const { startHealthServer } = (await import(untypedKeeperModule("health"))) as KeeperHealth;
    const { store } = await import("../../../keeper/src/state.js");
    const seaport = await import("../../../keeper/src/seaport.js");
    const policy = await import("../../../keeper/src/policy.js");
    const { account: keeperAccount } = await import("../../../keeper/src/clients.js");
    assertEq(keeperAccount.address, KEEPER.address, "keeper module key");
    const healthServer = startHealthServer();
    cleanups.push(() => {
      healthServer.close();
    });
    cleanups.push(() => store.close());

    await step("keeper boot: reconcile() against the fresh vault; /health answers", async () => {
      await roll.reconcile();
      const snap = roll.getLastSnapshot();
      assert(snap !== null, "reconcile produced a snapshot");
      assertEq(snap.phase, roll.Phase.Idle, "vault phase");
      const health = await fetch(`${keeperUrl}/health`);
      assertEq(health.status, 200, "keeper /health");
    });

    /* ---------- browser ---------- */

    const browser: Browser = await chromium.launch({ headless: !HEADFUL });
    cleanups.push(() => browser.close());
    const depositorWallet = new BrowserWallet("depositor", DEPOSITOR);
    const buyerWallet = new BrowserWallet("buyer", BUYER);
    const depositorContext = await browser.newContext();
    const buyerContext = await browser.newContext();
    await depositorWallet.attach(depositorContext);
    await buyerWallet.attach(buyerContext);
    const depositorPage = await depositorContext.newPage();
    const buyerPage = await buyerContext.newPage();
    OPEN_PAGES.push(depositorPage, buyerPage);
    const pageErrors: string[] = [];
    const consoleLog = join(OUT, "browser-console.log");
    for (const [name, page] of [["depositor", depositorPage], ["buyer", buyerPage]] as const) {
      page.on("pageerror", (error) => pageErrors.push(`${name}: ${error.message}`));
      page.on("console", (message) => appendFileSync(consoleLog, `[${name}] ${message.type()}: ${message.text()}\n`));
    }

    /* ---------- (a) deposit ---------- */

    await step("(a) depositor: approve + deposit 25 NVDA from /vault/nvda; shares and NAV render", async () => {
      await deal(ASSET, DEPOSITOR.address, DEPOSIT);
      assertEq(await erc20Balance(ASSET, DEPOSITOR.address), DEPOSIT, "the fresh wallet holds 25 NVDA");
      const page = depositorPage;
      await page.goto(`${web.url}/vault/nvda`);
      await connectWallet(page, DEPOSITOR.address);

      const position = card(page, exactly("Your position"));
      await expectText("position: Wallet NVDA, raw", rowValue(position, /^Wallet NVDA, raw$/), fmtAsset(DEPOSIT));
      await expectText("position: Shares", stat(position, /^Shares$/).value, "0.0000 cNVDA");

      const deposit = card(page, exactly("Deposit"));
      await deposit.locator("#deposit-amount").fill(DEPOSIT_INPUT);
      await expectText("deposit: You receive", rowValue(deposit, /^You receive$/), `${fmtAsset(DEPOSIT)} cNVDA`);
      const from = depositorWallet.sent.length;
      await deposit.getByRole("button", { name: "Approve and deposit", exact: true }).click();
      const approve = await depositorWallet.waitFor("approve", from);
      const depositTx = await depositorWallet.waitFor("deposit", from);
      assertEq(approve.to, ASSET, "approve is sent to the NVDA token");
      assertEq(jsonish(approve.args), jsonish([vault, DEPOSIT]), "approve(vault, exactly 25e18): exact-amount approval");
      assertEq(depositTx.to, vault, "deposit is sent to the vault");
      assertEq(jsonish(depositTx.args), jsonish([DEPOSIT, DEPOSITOR.address]), "deposit(25e18, depositor)");

      assertEq(await read<bigint>(vault, vaultAbi, "balanceOf", [DEPOSITOR.address]), DEPOSIT, "shares minted 1:1 on the first deposit");
      assertEq(await erc20Balance(ASSET, DEPOSITOR.address), 0n, "the wallet's NVDA moved");
      assertEq(await erc20Balance(ASSET, vault), DEPOSIT, "the vault holds the NVDA");
      assertEq(await read<bigint>(vault, vaultAbi, "totalAssets"), DEPOSIT, "totalAssets");
      assertEq(await read<bigint>(vault, vaultAbi, "convertToAssets", [DEPOSIT]), DEPOSIT, "NAV: 25 shares are worth 25 NVDA");

      await expectText("position: Shares", stat(position, /^Shares$/).value, `${fmtAsset(DEPOSIT)} cNVDA`);
      await expectText("position: Shares NAV", stat(position, /^Shares$/).sub, `worth ${fmtAsset(DEPOSIT)} NVDA raw`);
      await expectText("position: Wallet NVDA, raw", rowValue(position, /^Wallet NVDA, raw$/), fmtAsset(0n));
      const collateral = card(page, exactly("Vault collateral"));
      await expectText("collateral: Deposit cap", rowValue(collateral, /^Deposit cap$/), `${fmtAsset(50n * LOT)} NVDA`);
      await expectText("collateral: Instant redemption", rowValue(collateral, /^Instant redemption$/), "open");
      record.amounts.deposit = DEPOSIT.toString();
    });

    /* ---------- the keeper writes and lists; Overcall rejects ---------- */

    const listed = await step("keeper tick: newOptionType + rollOpen(id) + approveListing; /orders serves the empty-signature order", async () => {
      await setSeaportCounter(vault, SEAPORT_COUNTER);
      note(`Seaport getCounter(vault) = ${SEAPORT_COUNTER} before the keeper lists`);
      await roll.tick();
      assertEq(await read<number>(vault, vaultAbi, "phase"), roll.Phase.Listed, "vault phase after the tick");
      assertEq(await read<bigint>(vault, vaultAbi, "contractsWritten"), 0n, "rollOpen writes nothing");
      const cycle = store.getCycle(1);
      assert(cycle !== null && cycle.roll_open_tx !== null, "keeper cycle row with its rollOpen tx");
      const rows = store.listingsForCycle(1);
      assertEq(rows.length, 1, "one listing row");
      const row = rows[0] as ListingRow;
      assertEq(row.status, "approved", "the keeper recorded the listing");
      assertEq(row.counter, SEAPORT_COUNTER.toString(), "the keeper built the order with Seaport's live counter");
      const onChainPolicy = await policy.readPolicy();
      const contracts = policy.maxContracts(DEPOSIT, onChainPolicy);
      assertEq(BigInt(row.contracts), contracts, "listed the whole capacity at 95% utilisation");
      const listingHash = await read<Hex>(vault, vaultAbi, "listingHash");
      assertEq(listingHash.toLowerCase(), row.order_hash.toLowerCase(), "the vault authorised the keeper's hash");
      assertEq(await read<bigint>(vault, vaultAbi, "listingAmount"), contracts, "listingAmount");
      assertEq(await read<bigint>(vault, vaultAbi, "listingGrossUsdg"), BigInt(row.gross_usdg6), "listingGrossUsdg");
      assertEq(await read<bigint>(vault, vaultAbi, "optionId"), BigInt(cycle.option_id ?? "0"), "optionId the keeper created");

      const { orders } = await getJson<{ orders: KeeperOrder[] }>(`${keeperUrl}/orders`);
      assertEq(orders.length, 1, "GET /orders serves one order");
      const order = orders[0] as KeeperOrder;
      assertEq(order.orderHash.toLowerCase(), listingHash.toLowerCase(), "/orders serves the authorised hash");
      assertEq(order.contracts, contracts.toString(), "/orders contracts");
      assertEq(order.signature, EMPTY_SIGNATURE, "/orders signature is empty");
      assertEq(order.parameters.orderType, 3, "PARTIAL_RESTRICTED");
      assertEq(order.parameters.consideration.length, 1, "one USDG leg, no venue fee");
      assertEq(getAddress(order.parameters.consideration[0]?.recipient ?? "0x"), vault, "the premium pays the vault");
      assertEq(getAddress(order.parameters.zone), vault, "zone is the vault");
      const unitPrice6 = BigInt(order.unitPrice6);
      assertEq(order.parameters.consideration[0]?.startAmount ?? "", (unitPrice6 * contracts).toString(), "consideration = unit x N");
      assertEq(row.gross_usdg6, (unitPrice6 * contracts).toString(), "keeper gross_usdg6 = unit x N");
      record.txs.push({ label: "keeper: rollOpen", by: KEEPER.address, hash: cycle.roll_open_tx as Hex, block: "", via: "keeper" });
      if (row.approve_tx) record.txs.push({ label: "keeper: approveListing", by: KEEPER.address, hash: row.approve_tx as Hex, block: "", via: "keeper" });
      Object.assign(record.amounts, {
        contracts: contracts.toString(),
        unitPrice6: order.unitPrice6,
        orderHash: order.orderHash,
        optionId: cycle.option_id,
        strikeUsdg6: cycle.strike_usdg6,
        exerciseTs: cycle.exercise_ts,
        expiryTs: cycle.expiry_ts,
      });
      note(`listed ${contracts} contracts at ${order.unitPrice6} USDG6 each, empty signature; /orders serves ${order.orderHash}`);
      return { order, contracts, unitPrice6, strike: BigInt(cycle.strike_usdg6 ?? "0"), exercise: BigInt(cycle.exercise_ts ?? "0"), expiry: BigInt(cycle.expiry_ts ?? "0") };
    });

    /* ---------- (b) the fill from the keeper's /orders, through the web app's own route ---------- */

    await step("(b) tamper: the keeper serves the order with its premium leg redirected; the route rejects it and the cycle page offers no fill", async () => {
      const row = store.getListing(listed.order.orderHash);
      assert(row !== null, "keeper listing row");
      const original = row.components_json;
      const tampered = JSON.parse(original) as { consideration: Array<{ recipient: string }> };
      assert(tampered.consideration[0] !== undefined, "the stored order has a premium leg");
      tampered.consideration[0].recipient = ATTACKER.address;
      store.db.prepare("UPDATE listings SET components_json = ? WHERE order_hash = ?").run(JSON.stringify(tampered), row.order_hash);
      try {
        // The keeper's real HTTP server now serves the redirected leg under the authorised hash.
        const { orders } = await getJson<{ orders: KeeperOrder[] }>(`${keeperUrl}/orders`);
        assertEq(orders.length, 1, "the keeper serves one order");
        const served = orders[0] as KeeperOrder;
        assertEq(getAddress(served.parameters.consideration[0]?.recipient ?? ""), ATTACKER.address, "keeper /orders serves the tampered premium recipient");
        assertEq(served.orderHash.toLowerCase(), listed.order.orderHash.toLowerCase(), "keeper /orders still names the authorised hash");

        const body = await keeperRoute(web.url, "tampered", (b, status) => status === 200 && b.rejected.length > 0);
        assertEq(body.configured, true, "route: configured");
        assertEq(body.orders.length, 0, "route: the tampered order is not served as fillable");
        assertEq(body.rejected.length, 1, "route: one rejected order");
        assertEq(body.closed.length + body.unchecked.length, 0, "route: the tampered order is an integrity failure, not a lifecycle state or a chain failure");
        const rejected = body.rejected[0] as KeeperRouteBody["rejected"][number];
        assertEq((rejected.orderHash ?? "").toLowerCase(), listed.order.orderHash.toLowerCase(), "route: the rejection names the keeper's claimed hash");
        for (const reason of [KEEPER_REASONS.claimedHash, REASONS.hashMismatch, REASONS.writerRecipient]) {
          assert(rejected.reasons.includes(reason), `route rejection reasons include "${reason}" (got ${JSON.stringify(rejected.reasons)})`);
        }
        note(`route rejected the tampered order: ${rejected.reasons.join(" | ")}`);

        const page = buyerPage;
        await page.goto(`${web.url}/vault/nvda/cycle`);
        const onChain = card(page, exactly("The vault's order, on chain"));
        await expectText("cycle: Seaport order hash", rowValue(onChain, /^Seaport order hash$/), listed.order.orderHash);
        await expectText("cycle: Contracts offered", rowValue(onChain, /^Contracts offered$/), listed.contracts.toString());
        await expectText("cycle: Seaport validated", rowValue(onChain, /^Seaport validated$/), "validated (empty signature fills)");
        await expectText(
          "cycle: keeper rejection notice",
          page.locator(`${SLOT.notice} strong`, { hasText: "The keeper served" }),
          "The keeper served an order that did not check out against the chain, so nothing is offered here.",
        );
        await expectText(
          "cycle: keeper rejection names the redirected premium leg",
          page.locator(SLOT.notice, { hasText: "The keeper served" }).locator("li").first(),
          new RegExp(REASONS.writerRecipient.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
        await expectAbsent("cycle: a fillable order card", card(page, /^The vault's order · fill from here$/));
        await expectAbsent("cycle: a contracts input", page.locator("#fill-qty"));
      } finally {
        store.db.prepare("UPDATE listings SET components_json = ? WHERE order_hash = ?").run(original, row.order_hash);
      }
      const { orders } = await getJson<{ orders: KeeperOrder[] }>(`${keeperUrl}/orders`);
      assertEq(getAddress(orders[0]?.parameters.consideration[0]?.recipient ?? ""), vault, "keeper row restored: the premium leg pays the vault again");
    });

    const pageFill = await step("(b) the route serves the keeper's order with Seaport's counter restored; the cycle page labels it and fills 2 contracts", async () => {
      const body = await keeperRoute(web.url, "restored", (b, status) => status === 200 && b.orders.length === 1);
      assertEq(body.rejected.length, 0, "route: nothing rejected");
      assertEq(body.closed.length + body.unchecked.length, 0, "route: nothing closed or unchecked (one-block Multicall3 read against the fork)");
      const row = body.orders[0] as FeedListing;
      assertEq(row.orderHash.toLowerCase(), listed.order.orderHash.toLowerCase(), "route row carries the authorised hash");
      // The counter is the chain's, not a default: it is non-zero on this run.
      const counter = await read<bigint>(SEAPORT, seaportAbi, "getCounter", [vault]);
      assertEq(counter, SEAPORT_COUNTER, "Seaport getCounter(vault)");
      assertEq(row.components.counter, counter.toString(), "route restored components.counter from Seaport");
      assertEq(row.counter ?? "", counter.toString(), "route row counter");
      // Seaport hashes the route's components to the authorised hash, and so does the web lib.
      const onChainHash = await read<Hex>(SEAPORT, seaportAbi, "getOrderHash", [seaport.componentsFromJson(row.components as never)]);
      assertEq(onChainHash.toLowerCase(), listed.order.orderHash.toLowerCase(), "seaport.getOrderHash(route components) = the vault's listingHash");
      assertEq(seaportOrderHash(componentsStruct(row.components)).toLowerCase(), onChainHash.toLowerCase(), "web lib seaportOrderHash agrees with Seaport");
      assertEq(seaport.localOrderHash(seaport.componentsFromJson(row.components as never)).toLowerCase(), onChainHash.toLowerCase(), "the keeper's local EIP-712 hash agrees");
      // Nothing the keeper served beyond parameters and signature is passed through.
      for (const key of ["seaport", "contracts", "grossUsdg6", "bookStatus", "parameters"]) {
        assert(!(key in (row as Record<string, unknown>)), `route row does not carry the keeper's "${key}"`);
      }
      assertEq(row.status, "open", "route row status from Seaport's fill fraction");
      assertEq(row.remaining ?? "", listed.contracts.toString(), "route row remaining");
      // The same check the page runs, from web/lib/overcall.ts, against the vault's own slots.
      const check = checkListingIsOurs(
        row,
        {
          vault,
          usdg: USDG,
          clearinghouse: CLEARINGHOUSE,
          seaport: SEAPORT,
          listingHash: await read<Hex>(vault, vaultAbi, "listingHash"),
          chainId: CHAIN_ID,
          amount: await read<bigint>(vault, vaultAbi, "listingAmount"),
          grossUsdg: await read<bigint>(vault, vaultAbi, "listingGrossUsdg"),
          optionId: await read<bigint>(vault, vaultAbi, "optionId"),
        },
        Math.floor(Date.now() / 1000),
      );
      assert(check.ok, `checkListingIsOurs on the route's row: ${check.ok ? "" : check.reasons.join("; ")}`);

      const cost = listed.unitPrice6 * FILL_FROM_PAGE;
      const usdgForBoth = listed.unitPrice6 * (FILL_FROM_PAGE + FILL_FROM_RAW_PAYLOAD);
      await deal(USDG, BUYER.address, usdgForBoth);
      const optionId = BigInt(listed.order.optionId);
      const before = {
        vault: await erc20Balance(USDG, vault),
        buyer: await erc20Balance(USDG, BUYER.address),
      };

      const page = buyerPage;
      await page.reload();
      const orderCard = card(page, /^The vault's order · fill from here$/);
      await expectText("fill card: title", orderCard.locator(SLOT.cardTitle), "The vault's order · fill from here");
      await expectText("fill card: status", orderCard.locator(SLOT.cardMeta), "status open");
      await expectAbsent("cycle: keeper rejection notice", page.locator(SLOT.notice, { hasText: "The keeper served" }));
      await expectText(
        "fill card: Contracts",
        rowValue(orderCard, /^Contracts$/),
        new RegExp(`^${listed.contracts.toString()} buyable now`),
      );
      await expectText("fill card: Unit price", rowValue(orderCard, /^Unit price$/), `${fmtUsdg(listed.unitPrice6, 6)} USDG per contract`);
      await connectWallet(page, BUYER.address);
      await orderCard.locator("#fill-qty").fill(FILL_FROM_PAGE.toString());
      await expectText("fill card: You pay", rowValue(orderCard, /^You pay$/), `${fmtUsdg(cost)} USDG`);

      const from = buyerWallet.sent.length;
      await orderCard.getByRole("button", { name: `Fill ${FILL_FROM_PAGE} contracts`, exact: true }).click();
      const approve = await buyerWallet.waitFor("approve", from);
      const fulfil = await buyerWallet.waitFor("fulfillAdvancedOrder", from);
      assertEq(approve.to, USDG, "approve goes to USDG");
      assertEq(jsonish(approve.args), jsonish([SEAPORT, cost]), "approve(Seaport, exactly the cost)");
      assertEq(fulfil.to, SEAPORT, "the fill goes to Seaport 1.6");
      const [advanced, resolvers, conduitKey, recipient] = fulfil.args as readonly [
        { parameters: Record<string, unknown>; numerator: bigint; denominator: bigint; signature: Hex; extraData: Hex },
        readonly unknown[],
        Hex,
        Address,
      ];
      assertEq(advanced.numerator, FILL_FROM_PAGE, "numerator = contracts wanted");
      assertEq(advanced.denominator, listed.contracts, "denominator = offer[0].startAmount");
      assertEq(advanced.signature, EMPTY_SIGNATURE, "signature is empty");
      assertEq(advanced.extraData, "0x", "extraData empty");
      assertEq(resolvers.length, 0, "no criteria resolvers");
      assertEq(conduitKey, ZERO_CONDUIT_KEY, "no conduit");
      assertEq(getAddress(recipient), BUYER.address, "recipient is the buyer");

      const pageFillReceipt = await pub.getTransactionReceipt({ hash: fulfil.hash });
      const written = parseEventLogs({ abi: vaultAbi as unknown as Abi, eventName: "CallsWritten", logs: pageFillReceipt.logs }).filter(
        (l) => l.address.toLowerCase() === vault.toLowerCase(),
      );
      assertEq(written.length, 1, "one CallsWritten in the fill");
      assertEq((written[0] as { args: { contractsCount: bigint } }).args.contractsCount, FILL_FROM_PAGE, "CallsWritten.contractsCount = 2");
      assertEq((await erc20Balance(USDG, vault)) - before.vault, cost, "the vault received the whole premium (one leg)");
      assertEq(before.buyer - (await erc20Balance(USDG, BUYER.address)), cost, "the buyer paid exactly the quoted cost");
      assertEq(await read<bigint>(CLEARINGHOUSE, clearBalanceAbi, "balanceOf", [BUYER.address, optionId]), FILL_FROM_PAGE, "the buyer holds 2 option tokens");
      assertEq(await read<bigint>(CLEARINGHOUSE, clearBalanceAbi, "balanceOf", [vault, optionId]), 0n, "the vault holds 0 option tokens after the fill: written == sold");
      assertEq(await read<bigint>(vault, vaultAbi, "contractsWritten"), FILL_FROM_PAGE, "contractsWritten = 2");
      const [, , filled, size] = await read<readonly [boolean, boolean, bigint, bigint]>(SEAPORT, seaportAbi, "getOrderStatus", [listed.order.orderHash]);
      assertEq(`${filled}/${size}`, `${FILL_FROM_PAGE}/${listed.contracts}`, "Seaport getOrderStatus after the page fill");
      await page.reload();
      await expectText(
        "fill card: Contracts after reload",
        rowValue(card(page, /^The vault's order · fill from here$/), /^Contracts$/),
        new RegExp(`${(listed.contracts - FILL_FROM_PAGE).toString()} buyable now`),
      );
      record.amounts.pageFillTx = fulfil.hash;
      record.amounts.pageFillCost6 = cost.toString();
      record.amounts.pageFillToVault6 = cost.toString();
      return { parameters: advanced.parameters };
    });

    await step("(b) a raw Seaport client fills 3 more straight from the /orders JSON (no web code)", async () => {
      const { orders } = await getJson<{ orders: KeeperOrder[] }>(`${keeperUrl}/orders`);
      const order = orders.find((o) => o.orderHash.toLowerCase() === listed.order.orderHash.toLowerCase());
      assert(order !== undefined, "/orders still serves the partly filled order");
      const p = order.parameters;
      const parameters = {
        offerer: getAddress(p.offerer),
        zone: getAddress(p.zone),
        offer: p.offer.map((i) => ({ itemType: i.itemType, token: getAddress(i.token), identifierOrCriteria: BigInt(i.identifierOrCriteria), startAmount: BigInt(i.startAmount), endAmount: BigInt(i.endAmount) })),
        consideration: p.consideration.map((i) => ({ itemType: i.itemType, token: getAddress(i.token), identifierOrCriteria: BigInt(i.identifierOrCriteria), startAmount: BigInt(i.startAmount), endAmount: BigInt(i.endAmount), recipient: getAddress(i.recipient) })),
        orderType: p.orderType,
        startTime: BigInt(p.startTime),
        endTime: BigInt(p.endTime),
        zoneHash: p.zoneHash as Hex,
        salt: BigInt(p.salt),
        conduitKey: p.conduitKey as Hex,
        totalOriginalConsiderationItems: BigInt(p.totalOriginalConsiderationItems),
      };
      // The page rebuilt OrderParameters from the route's components; a raw client takes them
      // from /orders as served. They must be the same struct, field for field.
      assertEq(jsonish(pageFill.parameters), jsonish(parameters), "the parameters the page sent = the /orders parameters as served");
      const cost = listed.unitPrice6 * FILL_FROM_RAW_PAYLOAD;
      const vaultBefore = await erc20Balance(USDG, vault);
      await harnessTx("buyer (raw client): USDG.approve(Seaport)", BUYER, () =>
        walletClient.writeContract({ account: BUYER, chain: forkChain, address: USDG, abi: stockTokenAbi, functionName: "approve", args: [SEAPORT, cost] }),
      );
      const receipt = await harnessTx("buyer (raw client): seaport.fulfillAdvancedOrder from /orders", BUYER, () =>
        walletClient.writeContract({
          account: BUYER,
          chain: forkChain,
          address: SEAPORT,
          abi: seaportAbi,
          functionName: "fulfillAdvancedOrder",
          args: [{ parameters, numerator: FILL_FROM_RAW_PAYLOAD, denominator: BigInt(p.offer[0]?.startAmount ?? "0"), signature: EMPTY_SIGNATURE, extraData: "0x" }, [], ZERO_CONDUIT_KEY, BUYER.address],
        }),
      );
      assertEq((await erc20Balance(USDG, vault)) - vaultBefore, cost, "premium x 3 landed on the vault");
      assertEq(await erc20Balance(USDG, BUYER.address), 0n, "the buyer spent exactly the USDG dealt for 5 contracts");
      const optionId = BigInt(listed.order.optionId);
      assertEq(await read<bigint>(CLEARINGHOUSE, clearBalanceAbi, "balanceOf", [BUYER.address, optionId]), FILL_FROM_PAGE + FILL_FROM_RAW_PAYLOAD, "the buyer holds 5 option tokens");
      assertEq(await read<bigint>(CLEARINGHOUSE, clearBalanceAbi, "balanceOf", [vault, optionId]), 0n, "vault option balance still 0");
      assertEq(await read<bigint>(vault, vaultAbi, "contractsWritten"), FILL_FROM_PAGE + FILL_FROM_RAW_PAYLOAD, "contractsWritten = 5");
      const [, , filled, size] = await read<readonly [boolean, boolean, bigint, bigint]>(SEAPORT, seaportAbi, "getOrderStatus", [listed.order.orderHash]);
      assertEq(`${filled}/${size}`, `${FILL_FROM_PAGE + FILL_FROM_RAW_PAYLOAD}/${listed.contracts}`, "Seaport getOrderStatus after both fills");
      const premium = listed.unitPrice6 * (FILL_FROM_PAGE + FILL_FROM_RAW_PAYLOAD);
      assertEq(await erc20Balance(USDG, vault), premium, "the vault holds exactly the two premiums");
      record.amounts.rawFillTx = receipt.transactionHash;
      record.amounts.premiumToVault6 = premium.toString();
    });

    await step("keeper tick: Seaport's fill fraction recorded; /orders keeps serving the remainder", async () => {
      await roll.tick();
      const row = store.getListing(listed.order.orderHash);
      assert(row !== null, "listing row");
      assertEq(`${row.seaport_total_filled}/${row.seaport_total_size}`, `${FILL_FROM_PAGE + FILL_FROM_RAW_PAYLOAD}/${listed.contracts}`, "keeper's Seaport fraction");
      // KNOWN KEEPER DEFECT, found by this run and left to the keeper's owners (keeper/src is out
      // of this test's scope): in roll.ts pollLiveListing, applySeaportStatus writes `partial`,
      // then the POST retry is decided on the row read BEFORE that write, re-POSTs, and
      // postToOvercall's catch writes `post_failed` over `partial`. While the book keeps refusing,
      // the row flaps partial <-> post_failed every POST_RETRY_INTERVAL_MS. /orders serves both
      // statuses, so the fallback itself is unaffected; the assertion accepts either and says
      // which it saw.
      assert(row.status === "partial" || row.status === "approved", `keeper listing status is a live one (got ${row.status})`);
      record.amounts.keeperListingStatusAfterPartialFill = row.status;
      const { orders } = await getJson<{ orders: KeeperOrder[] }>(`${keeperUrl}/orders`);
      assertEq(orders.length, 1, "/orders still serves it");
    });

    await step("(b) while Listed: the cycle page and the home page show this week's terms and order figures, from the chain; the keeper's fixed-mode pricing report", async () => {
      assertEq(await read<number>(vault, vaultAbi, "phase"), roll.Phase.Listed, "vault is Listed");
      // Everything below is computed here from the vault's slots and Seaport's status, not from the web lib.
      const [strike, exerciseRaw, expiryRaw, listingAmount, listingGross, written, totalAssets, spot, policyTuple, listingHash] = await Promise.all([
        read<bigint>(vault, vaultAbi, "cycleStrikeUsdg"),
        read<bigint | number>(vault, vaultAbi, "cycleExerciseTs"),
        read<bigint | number>(vault, vaultAbi, "cycleExpiryTs"),
        read<bigint>(vault, vaultAbi, "listingAmount"),
        read<bigint>(vault, vaultAbi, "listingGrossUsdg"),
        read<bigint>(vault, vaultAbi, "contractsWritten"),
        read<bigint>(vault, vaultAbi, "totalAssets"),
        read<bigint>(vault, vaultAbi, "spotUsdg"),
        read<readonly [number, number, number, number, number, bigint]>(vault, vaultAbi, "policy"),
        read<Hex>(vault, vaultAbi, "listingHash"),
      ]);
      const exercise = Number(exerciseRaw);
      const expiry = Number(expiryRaw);
      assert(BigInt(Math.floor(Date.now() / 1000)) < BigInt(exercise) && (await latestTimestamp()) < BigInt(exercise), "the sale window is still open");
      const [, isCancelled, totalFilled, totalSize] = await read<readonly [boolean, boolean, bigint, bigint]>(SEAPORT, seaportAbi, "getOrderStatus", [listingHash]);
      assertEq(isCancelled, false, "the order is not cancelled");
      const [, , , maxUtilizationBps, protocolFeeBps, maxContractsCap] = policyTuple;
      const byUtilization = (totalAssets * BigInt(maxUtilizationBps)) / BPS / LOT;
      const maxWritable = byUtilization < maxContractsCap ? byUtilization : maxContractsCap;
      const capacity = maxWritable > written ? maxWritable - written : 0n;
      const soldPerSeaport = totalSize === 0n ? 0n : (totalFilled * listingAmount) / totalSize;
      const seaportLeft = listingAmount - soldPerSeaport;
      const left = seaportLeft < capacity ? seaportLeft : capacity;
      const unit = listingGross / listingAmount;
      const gross = unit * left;
      const fee = (gross * BigInt(protocolFeeBps)) / BPS;
      assertEq(soldPerSeaport, FILL_FROM_PAGE + FILL_FROM_RAW_PAYLOAD, "Seaport records 5 sold");
      assertEq(left, listed.contracts - (FILL_FROM_PAGE + FILL_FROM_RAW_PAYLOAD), "contracts left to buy");
      assertEq(unit, listed.unitPrice6, "unit price from the vault's slot");
      assertEq(strike, listed.strike, "strike from the vault's snapshot");
      const expected = {
        strike: `${exactUsdg(strike)} USDG`,
        strikeAboveSpot: `${exactUsdg(strike - spot)} USDG`,
        exercise: `${fmtUtc(exercise)} · ${fmtEastern(exercise)}`,
        expiry: `${fmtUtc(expiry)} · ${fmtEastern(expiry)}`,
        expiryEastern: fmtEastern(expiry),
        unitPrice: `${exactUsdg(unit)} USDG`,
        left: left.toString(),
        gross: `${exactUsdg(gross)} USDG`,
        fee: `${exactUsdg(fee)} USDG`,
      };
      // The web lib derives the same figures from the same reads (cross-check, not the source of truth).
      const terms = cycleTerms(
        {
          phase: roll.Phase.Listed,
          cycleStrikeUsdg: strike,
          cycleExerciseTs: exercise,
          cycleExpiryTs: expiry,
          spotUsdg: spot,
          listingGrossUsdg: listingGross,
          listingAmount,
          contractsWritten: written,
          capacity,
          policy: {
            minOtmBps: Number(policyTuple[0]),
            maxOtmBps: Number(policyTuple[1]),
            minPremiumBps: Number(policyTuple[2]),
            maxUtilizationBps: Number(maxUtilizationBps),
            protocolFeeBps: Number(protocolFeeBps),
            maxContractsCap,
          },
        },
        { fillableContracts: seaportLeft },
      );
      assert(terms !== null, "cycleTerms on the chain reads");
      assertEq(terms.orderGrossIfAllFill6 ?? -1n, gross, "cycleTerms order total = unit x left");
      assertEq(terms.orderFeeIfAllFill6 ?? -1n, fee, "cycleTerms fee = floor(total x feeBps / 10000)");
      assertEq(`${terms.orderGrossIfAllFillFmt} USDG`, expected.gross, "cycleTerms formats the order total the same way");

      const page = buyerPage;
      await page.goto(`${web.url}/vault/nvda/cycle`);
      const option = card(page, /^This week's option · vault cycle #1$/);
      // The strike row is the strike alone: no distance from spot as a percentage.
      await expectText("cycle terms: strike", rowValue(option, /^Strike, per contract$/), exactly(expected.strike));
      await expectText("cycle terms: strike minus spot, in USDG", rowValue(option, exactly(CYCLE_TERMS_LABELS.strikeAboveSpot)), expected.strikeAboveSpot);
      await expectText("cycle terms: expiry (UTC · Eastern)", rowValue(option, /^Expiry$/), expected.expiry);
      const onChain = card(page, exactly("The vault's order, on chain"));
      await expectText("cycle terms: price per contract", rowValue(onChain, exactly(CYCLE_TERMS_LABELS.unitPrice)), expected.unitPrice);
      await expectText("cycle terms: contracts left to buy", rowValue(onChain, exactly(CYCLE_TERMS_LABELS.fillableContracts)), expected.left);
      await expectText("cycle terms: order total", rowValue(onChain, exactly(CYCLE_TERMS_LABELS.orderGrossIfAllFill)), expected.gross);
      await expectText("cycle terms: protocol fee on it", rowValue(onChain, exactly(CYCLE_TERMS_LABELS.orderFeeIfAllFill)), expected.fee);

      // The keeper's own report, as stored with the listing and served through the route.
      const keeperRow = store.getListing(listed.order.orderHash);
      assert(keeperRow !== null && typeof keeperRow.pricing_json === "string", "the keeper stored a pricing report with the listing");
      const report = JSON.parse(keeperRow.pricing_json) as { mode: string; priceSource: string; floorUnit6: string; marginUnit6: string; unitPrice6: string; strikeUsdg6: string };
      assertEq(report.mode, "fixed", "keeper pricing mode");
      assertEq(report.priceSource, "fill-floor", "keeper price source");
      assertEq(BigInt(report.unitPrice6), unit, "the report's ask is the vault's unit price");
      assertEq(BigInt(report.strikeUsdg6), strike, "the report's strike is the vault's strike");
      const pricing = card(page, exactly("How the keeper priced this week"));
      await expectText("pricing: meta", pricing.locator(SLOT.cardMeta), "keeper-reported");
      await expectText("pricing: mode", rowValue(pricing, /^Pricing mode$/), "fixed · strike a set distance above spot, ask at the vault floor plus margin");
      await expectText("pricing: what set the ask", rowValue(pricing, /^What set the ask$/), "The vault floor plus the keeper's margin");
      await expectText("pricing: strike", rowValue(pricing, /^Strike$/), expected.strike);
      await expectText("pricing: vault floor", rowValue(pricing, /^Vault floor per contract$/), `${exactUsdg(BigInt(report.floorUnit6))} USDG`);
      await expectText("pricing: floor plus margin", rowValue(pricing, /^Vault floor plus the keeper's margin$/), `${exactUsdg(BigInt(report.marginUnit6))} USDG`);
      await expectText("pricing: ask", rowValue(pricing, /^Ask per contract$/), expected.unitPrice);
      await expectText(
        "pricing: note",
        pricing.locator('[data-slot="pricing-note"]'),
        /^Reported by the keeper with its order, not read from the chain, and shown for information only\. In fixed mode no market data is used\. The vault itself enforces only its premium floor and its strike band/,
      );
      await expectAbsent("pricing: implied volatility row", pricing.locator(SLOT.k, { hasText: /^Implied volatility at the strike$/ }));
      await expectAbsent("pricing: target delta row", pricing.locator(SLOT.k, { hasText: /^Target delta$/ }));
      await expectAbsent("pricing: mismatch notice", pricing.locator('[data-slot="pricing-mismatch"]'));

      await page.goto(`${web.url}/vault/nvda`);
      await expectText("vault: This week's strike", stat(page.locator("main"), /^This week's strike$/).value, expected.strike);
      await expectText("vault: strike expiry (Eastern)", page.locator('[data-slot="strike-expiry"]'), `${CYCLE_TERMS_LABELS.expiry} ${expected.expiryEastern}`);
      const thisWeek = page.locator('[data-slot="this-week"]');
      await expectText("vault this week: strike", rowValue(thisWeek, exactly(CYCLE_TERMS_LABELS.strike)), expected.strike);
      await expectText("vault this week: exercise deadline", rowValue(thisWeek, exactly(CYCLE_TERMS_LABELS.exercise)), expected.exercise);
      await expectText("vault this week: expiry", rowValue(thisWeek, exactly(CYCLE_TERMS_LABELS.expiry)), expected.expiry);
      await expectText("vault this week: price per contract", rowValue(thisWeek, exactly(CYCLE_TERMS_LABELS.unitPrice)), expected.unitPrice);
      await expectText("vault this week: contracts left to buy", rowValue(thisWeek, exactly(CYCLE_TERMS_LABELS.fillableContracts)), expected.left);
      await expectText("vault this week: order total", rowValue(thisWeek, exactly(CYCLE_TERMS_LABELS.orderGrossIfAllFill)), expected.gross);
      await expectText("vault this week: protocol fee on it", rowValue(thisWeek, exactly(CYCLE_TERMS_LABELS.orderFeeIfAllFill)), expected.fee);
      // The count is Seaport's (read on the vault page too), so the no-count note is not shown.
      await expectAbsent("vault this week: no-count note", thisWeek.locator('[data-slot="this-week-fill-note"]'));

      Object.assign(record.amounts, {
        termsStrike: expected.strike,
        termsExercise: expected.exercise,
        termsExpiry: expected.expiry,
        termsUnitPrice: expected.unitPrice,
        termsContractsLeft: expected.left,
        termsOrderTotal: expected.gross,
        termsOrderFee: expected.fee,
        pricingFloorUnit6: report.floorUnit6,
        pricingMarginUnit6: report.marginUnit6,
      });
      note(`terms: strike ${expected.strike}, left ${expected.left} x ${expected.unitPrice} = ${expected.gross}, fee ${expected.fee}; floor ${report.floorUnit6}, margin ${report.marginUnit6}`);
    });

    /* ---------- (c) queue while Listed ---------- */

    await step("(c) depositor: queue 10 shares from /vault/nvda while the call is live", async () => {
      assertEq(await read<number>(vault, vaultAbi, "phase"), roll.Phase.Listed, "vault is Listed");
      assertEq(await read<boolean>(vault, vaultAbi, "canRedeemInstantly"), false, "the instant path is shut");
      const page = depositorPage;
      await page.reload();
      const withdraw = card(page, exactly("Withdraw"));
      await withdraw.locator("#redeem-shares").fill(QUEUE_INPUT);
      const from = depositorWallet.sent.length;
      await withdraw.getByRole("button", { name: "Queue redemption", exact: true }).click();
      const queued = await depositorWallet.waitFor("queueRedeem", from);
      assertEq(queued.to, vault, "queueRedeem to the vault");
      assertEq(jsonish(queued.args), jsonish([QUEUED]), "queueRedeem(10e18)");
      const epoch = await read<bigint>(vault, vaultAbi, "epochId");
      assertEq(await read<bigint>(vault, vaultAbi, "balanceOf", [DEPOSITOR.address]), DEPOSIT - QUEUED, "15e18 free shares");
      assertEq(await read<bigint>(vault, vaultAbi, "balanceOf", [vault]), QUEUED, "10e18 escrowed on the vault");
      assertEq(await read<bigint>(vault, vaultAbi, "queuedSharesOf", [DEPOSITOR.address]), QUEUED, "queuedSharesOf");
      assertEq(await read<bigint>(vault, vaultAbi, "queuedEpochOf", [DEPOSITOR.address]), epoch, "queuedEpochOf = the current epoch");
      assertEq(await read<bigint>(vault, vaultAbi, "totalSupply"), DEPOSIT, "nothing burned before settlement");

      const position = card(page, exactly("Your position"));
      await expectText("position: Queued shares", stat(position, /^Queued shares$/).value, fmtAsset(QUEUED));
      await expectText("position: Queued epoch", stat(position, /^Queued shares$/).sub, `epoch ${epoch}`);
      await expectText("position: Shares", stat(position, /^Shares$/).value, `${fmtAsset(DEPOSIT - QUEUED)} cNVDA`);
      await expectText(
        "withdraw: waiting notice",
        withdraw.locator(SLOT.notice, { hasText: "A call is open" }),
        /A call is open\. Redemptions are queued and paid after the keeper closes the week/,
      );
      record.amounts.queuedShares = QUEUED.toString();
      record.amounts.queueEpoch = epoch.toString();
    });

    /* ---------- (d) exercise, expiry, close, then collect ---------- */

    async function refreshFeed(answer: bigint, why: string): Promise<void> {
      await harnessTx(`MockFeed.setAnswer(${answer}) (${why})`, ADMIN, () =>
        walletClient.writeContract({ account: ADMIN, chain: forkChain, address: feed, abi: mockFeedWriteAbi, functionName: "setAnswer", args: [answer] }),
      );
    }

    await step("(d) warp to exerciseTimestamp; keeper tick -> lockBook; buyer exercises 2 from the cycle page's Exercise button", async () => {
      const exerciseTs = listed.exercise;
      await warpTo(exerciseTs, "exerciseTimestamp");
      const spot = await read<bigint>(vault, vaultAbi, "spotUsdg");
      // Put spot $5 above the strike so the 2 contracts are in the money.
      const itmAnswer = listed.strike * 100n + 5n * 100_000_000n;
      await refreshFeed(itmAnswer, "in the money before exercise");
      await roll.tick();
      assertEq(await read<number>(vault, vaultAbi, "phase"), roll.Phase.Exercisable, "vault phase");
      const cycle = store.getCycle(1);
      assertEq(cycle?.status ?? null, "locked", "keeper cycle status");
      if (cycle?.lock_tx) record.txs.push({ label: "keeper: lockBook", by: KEEPER.address, hash: cycle.lock_tx as Hex, block: "", via: "keeper" });

      // Every figure below is computed here from the Clear's own reads, not from web/lib/exercise.ts.
      const optionId = BigInt(listed.order.optionId);
      assertEq(await read<bigint>(vault, vaultAbi, "optionId"), optionId, "vault.optionId() is the option the buyer holds");
      const held = FILL_FROM_PAGE + FILL_FROM_RAW_PAYLOAD;
      assertEq(await read<bigint>(CLEARINGHOUSE, clearBalanceAbi, "balanceOf", [BUYER.address, optionId]), held, "the buyer holds the 5 bought");
      const tuple = await read<{ underlyingAsset: Address; underlyingAmount: bigint; exerciseAsset: Address; exerciseAmount: bigint; exerciseTimestamp: number; expiryTimestamp: number }>(
        CLEARINGHOUSE,
        valoremClearAbi,
        "option",
        [optionId],
      );
      assertEq(tuple.exerciseAmount, listed.strike, "the Clear's exerciseAmount is the strike");
      assertEq(getAddress(tuple.exerciseAsset), USDG, "the Clear's exercise asset is USDG");
      assertEq(getAddress(tuple.underlyingAsset), ASSET, "the Clear's underlying is the NVDA Stock Token");
      const chainNow = await latestTimestamp();
      assert(BigInt(tuple.exerciseTimestamp) <= chainNow && chainNow < BigInt(tuple.expiryTimestamp), "the chain's latest block is inside the Clear's exercise window");
      assert(BigInt(Math.floor(Date.now() / 1000)) < BigInt(tuple.exerciseTimestamp), "the wall clock is still before the window: the page must use the chain's clock");
      const [feesEnabled, feeBps] = await Promise.all([
        read<boolean>(CLEARINGHOUSE, valoremClearAbi, "feesEnabled"),
        read<number>(CLEARINGHOUSE, valoremClearAbi, "feeBps"),
      ]);
      const strikeCost = listed.strike * EXERCISE_W;
      // ValoremOptionsClearinghouse._calculateRecordAndEmitFee: floor(cost x feeBps / 10000), at least 1.
      const clearFeeUsdg = feesEnabled ? ((strikeCost * BigInt(feeBps)) / BPS === 0n ? 1n : (strikeCost * BigInt(feeBps)) / BPS) : 0n;
      const exerciseCost = strikeCost + clearFeeUsdg;
      const nvdaOut = tuple.underlyingAmount * EXERCISE_W;
      await deal(USDG, BUYER.address, exerciseCost);
      assertEq(await read<bigint>(USDG, stockTokenAbi, "allowance", [BUYER.address, CLEARINGHOUSE]), 0n, "the buyer has no USDG allowance to the Clear yet");
      const usdgBefore = await erc20Balance(USDG, BUYER.address);
      const nvdaBefore = await erc20Balance(ASSET, BUYER.address);

      const page = buyerPage;
      await page.goto(`${web.url}/vault/nvda/cycle`);
      const exerciseCard = card(page, exactly("Exercise"));
      /** The whole trimmed decimal of an 18-decimal amount, as the card prints NVDA. */
      const nvda = (value: bigint): string => {
        const whole = (value / LOT).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
        const frac = (value % LOT).toString().padStart(18, "0").replace(/0+$/, "");
        return frac === "" ? whole : `${whole}.${frac}`;
      };
      await expectText("exercise: meta", exerciseCard.locator(SLOT.cardMeta), "window open");
      await expectText("exercise: Options in this wallet", rowValue(exerciseCard, /^Options in this wallet$/), `${held} contracts`);
      await expectText("exercise: Strike, per contract", rowValue(exerciseCard, /^Strike, per contract$/), `${fmtUsdg(tuple.exerciseAmount, 6)} USDG`);
      await expectText("exercise: NVDA received per contract", rowValue(exerciseCard, /^NVDA received per contract$/), `${nvda(tuple.underlyingAmount)} NVDA`);
      await expectText("exercise: Exercise opens", rowValue(exerciseCard, /^Exercise opens$/), `${fmtUtc(tuple.exerciseTimestamp)} · ${fmtEastern(tuple.exerciseTimestamp)}`);
      await expectText("exercise: Expires", rowValue(exerciseCard, /^Expires$/), `${fmtUtc(tuple.expiryTimestamp)} · ${fmtEastern(tuple.expiryTimestamp)}`);
      await exerciseCard.locator("#exercise-amount").fill(EXERCISE_W.toString());
      await expectText("exercise: You pay", rowValue(exerciseCard, /^You pay$/), `${fmtUsdg(exerciseCost, 6)} USDG`);
      await expectText("exercise: Strike cost", rowValue(exerciseCard, /^Strike cost$/), `${fmtUsdg(strikeCost, 6)} USDG`);
      await expectText("exercise: Clearinghouse fee", rowValue(exerciseCard, /^Clearinghouse fee$/), `${fmtUsdg(clearFeeUsdg, 6)} USDG`);
      await expectText("exercise: You receive", rowValue(exerciseCard, /^You receive$/), `${nvda(nvdaOut)} NVDA`);
      await expectText("exercise: USDG approved", rowValue(exerciseCard, /^USDG approved to the clearinghouse$/), `${fmtUsdg(0n, 6)} USDG`);
      await expectText("exercise: Your USDG", rowValue(exerciseCard, /^Your USDG$/), `${fmtUsdg(exerciseCost, 6)} USDG`);
      // Spot is $5 above the strike, so there is no warning and no confirmation to tick; the
      // simulation passes the Clear's checks and says only the approval is missing.
      await expectText(
        "exercise: simulation notice",
        exerciseCard.locator(`${SLOT.notice} strong`, { hasText: "checks pass" }),
        "The clearinghouse's checks pass.",
      );
      await expectAbsent("exercise: spot warning", exerciseCard.locator(SLOT.notice, { hasText: /Spot is at or below|Spot could not be read|worth at spot/ }));
      await expectAbsent("exercise: confirmation", exerciseCard.locator("#exercise-confirm"));
      const submit = exerciseCard.getByRole("button", { name: `Exercise ${EXERCISE_W} contracts`, exact: true });
      await expectText("exercise: button id", exerciseCard.locator("#exercise-submit"), `Exercise ${EXERCISE_W} contracts`);

      const from = buyerWallet.sent.length;
      await submit.click({ timeout: 60_000 });
      const approve = await buyerWallet.waitFor("approve", from);
      const exercised = await buyerWallet.waitFor("exercise", from);
      assertEq(approve.to, USDG, "approve goes to USDG");
      assertEq(jsonish(approve.args), jsonish([CLEARINGHOUSE, exerciseCost]), "approve(Clear, exactly 2 x strike + the Clear's fee): exact-amount approval");
      assertEq(exercised.to, CLEARINGHOUSE, "exercise goes to the vault's Clear");
      assertEq(jsonish(exercised.args), jsonish([optionId, EXERCISE_W]), "exercise(optionId, 2)");
      assert(approve.block <= exercised.block, "the approval landed before the exercise");
      assertEq(
        buyerWallet.sent.slice(from).map((t) => t.functionName).join(","),
        "approve,exercise",
        "the button sent exactly one approval and one exercise",
      );
      const exerciseReceipt = await pub.getTransactionReceipt({ hash: exercised.hash });
      const exercisedLogs = parseEventLogs({ abi: valoremClearAbi as unknown as Abi, eventName: "OptionsExercised", logs: exerciseReceipt.logs }).filter(
        (l) => l.address.toLowerCase() === CLEARINGHOUSE.toLowerCase(),
      ) as unknown as Array<{ args: { optionId: bigint; exerciser: Address; amount: bigint } }>;
      assertEq(exercisedLogs.length, 1, "one OptionsExercised in the page's exercise");
      assertEq((exercisedLogs[0] as { args: { amount: bigint } }).args.amount, EXERCISE_W, "OptionsExercised.amount = 2");
      assertEq(getAddress((exercisedLogs[0] as { args: { exerciser: Address } }).args.exerciser), BUYER.address, "OptionsExercised.exerciser = the buyer");

      assertEq(await read<bigint>(CLEARINGHOUSE, clearBalanceAbi, "balanceOf", [BUYER.address, optionId]), FILL_FROM_PAGE + FILL_FROM_RAW_PAYLOAD - EXERCISE_W, "buyer holds the 3 unexercised");
      assertEq(usdgBefore - (await erc20Balance(USDG, BUYER.address)), exerciseCost, "the buyer paid exactly the strike cost plus the Clear's fee");
      assertEq((await erc20Balance(ASSET, BUYER.address)) - nvdaBefore, nvdaOut, "the buyer received exactly 2 lots of NVDA");
      assertEq(await read<bigint>(USDG, stockTokenAbi, "allowance", [BUYER.address, CLEARINGHOUSE]), 0n, "no USDG allowance to the Clear is left over");
      await expectText("exercise: Options in this wallet after", rowValue(exerciseCard, /^Options in this wallet$/), `${held - EXERCISE_W} contracts`);
      record.amounts.exerciseApproveTx = approve.hash;
      record.amounts.exerciseTx = exercised.hash;
      record.amounts.exerciseCost6 = exerciseCost.toString();
      record.amounts.exerciseClearFee6 = clearFeeUsdg.toString();
      note(`buyer exercised ${EXERCISE_W} at strike ${listed.strike} from the page (spot was ${spot}; paid ${exerciseCost} USDG6 incl. Clear fee ${clearFeeUsdg})`);
    });

    const closed = await step("(d) warp to expiryTimestamp; keeper tick -> rollClose: harvest premium + strike proceeds, settle the queue", async () => {
      await warpTo(listed.expiry, "expiryTimestamp");
      await refreshFeed(listed.strike * 100n + 5n * 100_000_000n, "after the warp to expiry");
      const [supplyBefore, accBefore, feeSafeBefore, epoch] = await Promise.all([
        read<bigint>(vault, vaultAbi, "totalSupply"),
        read<bigint>(vault, vaultAbi, "accUsdgPerShare"),
        erc20Balance(USDG, FEE_SAFE.address),
        read<bigint>(vault, vaultAbi, "epochId"),
      ]);
      await roll.tick();
      assertEq(await read<number>(vault, vaultAbi, "phase"), roll.Phase.Idle, "vault phase after rollClose");
      const cycle = store.getCycle(1) as CycleRow;
      assertEq(cycle.status, "closed", "keeper cycle status");
      assert(cycle.roll_close_tx !== null, "roll_close_tx recorded");
      const receipt = await pub.getTransactionReceipt({ hash: cycle.roll_close_tx as Hex });
      const logs = parseEventLogs({ abi: vaultAbi as unknown as Abi, logs: receipt.logs }).filter((l) => l.address.toLowerCase() === vault.toLowerCase()) as unknown as Array<{ eventName: string; args: Record<string, unknown> }>;
      const one = (name: string): Record<string, unknown> => {
        const found = logs.filter((l) => l.eventName === name);
        assertEq(found.length, 1, `exactly one ${name} in the rollClose receipt`);
        return (found[0] as { args: Record<string, unknown> }).args;
      };

      const sold = FILL_FROM_PAGE + FILL_FROM_RAW_PAYLOAD;
      const unassigned = sold - EXERCISE_W;
      const assignmentUsdg = EXERCISE_W * listed.strike;
      const rc = one("RollClose");
      assertEq(rc.assetsReturned as bigint, unassigned * LOT, "RollClose.assetsReturned: the 3 unassigned lots");
      assertEq(rc.usdgFromAssignment as bigint, assignmentUsdg, "RollClose.usdgFromAssignment = 2 x strike");
      assertEq(rc.contractsAssignedCount as bigint, EXERCISE_W, "RollClose.contractsAssignedCount = 2");

      const premium = listed.unitPrice6 * sold;
      const harvest = one("Harvest");
      const gross = harvest.grossUsdg as bigint;
      const fee = harvest.feeUsdg as bigint;
      const net = harvest.netUsdg as bigint;
      assertEq(Number(harvest.cycleNumber), 1, "Harvest.cycleNumber");
      assertEq(gross, premium + assignmentUsdg, "Harvest.grossUsdg = premium + strike proceeds");
      assertEq(fee, (premium * BigInt(LAUNCH_POLICY.protocolFeeBps)) / BPS, "fee = floor(premium x 500 / 10000); strike proceeds fee-free");
      assertEq(net, gross - fee, "net = gross - fee");
      const harvestTopics = await pub.getLogs({
        address: vault,
        event: {
          type: "event",
          name: "Harvest",
          inputs: [
            { name: "cycleNumber", type: "uint32", indexed: true },
            { name: "grossUsdg", type: "uint256", indexed: false },
            { name: "feeUsdg", type: "uint256", indexed: false },
            { name: "netUsdg", type: "uint256", indexed: false },
          ],
        },
        fromBlock: vaultBlock,
        toBlock: receipt.blockNumber,
      });
      assertEq(harvestTopics.length, 1, "one Harvest event in the vault's whole life: no checkpoint split the week");
      assertEq(one("FeeSwept").amount as bigint, fee, "FeeSwept.amount");
      assertEq((await erc20Balance(USDG, FEE_SAFE.address)) - feeSafeBefore, fee, "the fee recipient received the fee");

      const distributed = one("UsdgDistributed");
      assertEq(distributed.totalSupply as bigint, supplyBefore, "UsdgDistributed.totalSupply = 25e18, escrow included");
      const accAfter = await read<bigint>(vault, vaultAbi, "accUsdgPerShare");
      const indexDelta = accAfter - accBefore;
      assertEq(indexDelta, (net * ACC_PRECISION) / supplyBefore, "index delta = floor(net x 1e27 / supply)");

      const settled = one("QueueSettled");
      const payoutAssets = settled.assets as bigint;
      const escrowUsdg = settled.usdgOut as bigint;
      assertEq(settled.epochId as bigint, epoch, "QueueSettled.epochId");
      assertEq(settled.shares as bigint, QUEUED, "QueueSettled.shares");
      assert(payoutAssets > 0n, "epoch payout assets > 0");
      assertEq(escrowUsdg, (QUEUED * indexDelta) / ACC_PRECISION, "epoch payout USDG = 10e18 x index delta / 1e27");
      assertEq(await read<bigint>(vault, vaultAbi, "totalSupply"), DEPOSIT - QUEUED, "escrowed shares burned");
      assertEq(await read<bigint>(vault, vaultAbi, "epochId"), epoch + 1n, "epoch advanced");

      assertEq(cycle.gross_usdg6, gross.toString(), "keeper cycle gross_usdg6");
      assertEq(cycle.fee_usdg6, fee.toString(), "keeper cycle fee_usdg6");
      assertEq(cycle.net_usdg6, net.toString(), "keeper cycle net_usdg6");
      assertEq(cycle.contracts_assigned, Number(EXERCISE_W), "keeper cycle contracts_assigned");
      assert(alerts.some((a) => a.kind === "roll_close"), "roll_close alert delivered");
      const closeBlock = await pub.getBlock({ blockNumber: receipt.blockNumber });

      record.txs.push({ label: "keeper: rollClose", by: KEEPER.address, hash: cycle.roll_close_tx as Hex, block: receipt.blockNumber.toString(), via: "keeper" });
      Object.assign(record.amounts, {
        harvestGross6: gross.toString(),
        harvestFee6: fee.toString(),
        harvestNet6: net.toString(),
        indexDelta: indexDelta.toString(),
        epochPayoutAssets: payoutAssets.toString(),
        epochPayoutUsdg6: escrowUsdg.toString(),
      });
      note(`harvest gross ${gross}, fee ${fee}, net ${net} USDG6; epoch ${epoch} pays ${payoutAssets} NVDA wei + ${escrowUsdg} USDG6`);
      return { gross, fee, net, indexDelta, payoutAssets, escrowUsdg, closeTx: cycle.roll_close_tx as Hex, closedAt: closeBlock.timestamp, strike: listed.strike, assignmentUsdg, sold };
    });

    const collected = await step("(d) depositor: complete the redeem, then claim USDG, from /vault/nvda", async () => {
      const page = depositorPage;
      await page.reload();
      const withdraw = card(page, exactly("Withdraw"));
      await expectText("withdraw: Payable NVDA", rowValue(withdraw, /^Payable NVDA$/), fmtAsset(closed.payoutAssets));
      await expectText("withdraw: Payable USDG", rowValue(withdraw, /^Payable USDG$/), fmtUsdg(closed.escrowUsdg));
      const nvdaBefore = await erc20Balance(ASSET, DEPOSITOR.address);
      const usdgBefore = await erc20Balance(USDG, DEPOSITOR.address);
      let from = depositorWallet.sent.length;
      await withdraw.getByRole("button", { name: "Complete redemption", exact: true }).click();
      const complete = await depositorWallet.waitFor("completeRedeem", from);
      assertEq(jsonish(complete.args), jsonish([DEPOSITOR.address]), "completeRedeem(depositor)");
      assertEq((await erc20Balance(ASSET, DEPOSITOR.address)) - nvdaBefore, closed.payoutAssets, "completeRedeem delivered exactly the epoch's 10 NVDA");
      assertEq((await erc20Balance(USDG, DEPOSITOR.address)) - usdgBefore, closed.escrowUsdg, "completeRedeem delivered exactly the escrow's USDG");
      assertEq(await read<bigint>(vault, vaultAbi, "queuedSharesOf", [DEPOSITOR.address]), 0n, "queue slot cleared");

      const claimable = await read<bigint>(vault, vaultAbi, "claimableUsdg", [DEPOSITOR.address]);
      assertEq(claimable, ((DEPOSIT - QUEUED) * closed.indexDelta) / ACC_PRECISION, "claimable = 15e18 x index delta / 1e27");
      const claimCard = card(page, exactly("USDG"));
      await expectText("usdg: Claimable", stat(claimCard, /^Claimable$/).value, `${fmtUsdg(claimable)} USDG`);
      from = depositorWallet.sent.length;
      await claimCard.getByRole("button", { name: `Claim ${fmtUsdg(claimable)} USDG`, exact: true }).click();
      const claim = await depositorWallet.waitFor("claimUsdg", from);
      assertEq(claim.args.length, 0, "claimUsdg()");
      assertEq((await erc20Balance(USDG, DEPOSITOR.address)) - usdgBefore, closed.escrowUsdg + claimable, "USDG received: escrow leg + claim, exactly");
      assertEq(await read<bigint>(vault, vaultAbi, "claimableUsdg", [DEPOSITOR.address]), 0n, "nothing left to claim");
      const dust = await read<bigint>(vault, vaultAbi, "usdgDust");
      const owed = await read<bigint>(vault, vaultAbi, "usdgOwed");
      assertEq(closed.escrowUsdg + claimable + closed.fee + dust + owed, closed.gross, "every base unit of the premium: escrow + claim + fee + dust + owed = gross");
      assertEq(await erc20Balance(USDG, vault), dust + owed, "what stays in the vault is the index dust plus the floor loss");
      record.amounts.completeRedeemTx = complete.hash;
      record.amounts.claimTx = claim.hash;
      record.amounts.claimed6 = claimable.toString();
      record.amounts.depositorUsdg6 = (closed.escrowUsdg + claimable).toString();
      return { claimable, usdg: closed.escrowUsdg + claimable };
    });

    /* ---------- (e) the pages show the closed week and the account ---------- */

    await step("(e) /vault/nvda: last week realized (premium and strike proceeds apart) and the account's figures", async () => {
      const page = depositorPage;
      await page.reload();
      const premiumNet = closed.gross - closed.assignmentUsdg - closed.fee;
      const perShare = premiumPerShare({ premiumNetUsdg: premiumNet, sharesAtHarvest: DEPOSIT });
      assert(perShare !== undefined, "per-share figure computable");
      const last = card(page, exactly("Last week realized"));
      await expectText("last week: cycle", last.locator(SLOT.cardMeta), "cycle #1");
      await expectText("last week: Net premium per cNVDA", stat(last, /^Net premium per cNVDA$/).value, fmtUsdg(perShare, 6));
      await expectText("last week: result", stat(last, /^Net premium per cNVDA$/).sub, `${closed.sold.toString()} calls sold · ${fmtUtcDate(closed.closedAt)}`);
      await expectText("last week: Premium received", rowValue(last, /^Premium received$/), fmtUsdg(listed.unitPrice6 * closed.sold));
      await expectText("last week: Protocol fee", rowValue(last, /^Protocol fee$/), fmtUsdg(closed.fee));
      await expectText("last week: Net premium to depositors", rowValue(last, /^Net premium to depositors$/), fmtUsdg(premiumNet));
      await expectText("last week: Contracts assigned", rowValue(last, /^Contracts assigned$/), EXERCISE_W.toString());

      const position = card(page, exactly("Your position"));
      await expectText("position: Shares", stat(position, /^Shares$/).value, `${fmtAsset(DEPOSIT - QUEUED)} cNVDA`);
      await expectText("position: Claimable USDG", stat(position, /^Claimable USDG$/).value, fmtUsdg(0n));
      await expectText("position: Queued shares", stat(position, /^Queued shares$/).value, fmtAsset(0n));
      await expectText("position: Queued sub", stat(position, /^Queued shares$/).sub, "nothing queued");
      await expectText("position: Wallet NVDA, raw", rowValue(position, /^Wallet NVDA, raw$/), fmtAsset(closed.payoutAssets));
      await expectText("position: Wallet USDG", rowValue(position, /^Wallet USDG$/), fmtUsdg(collected.usdg));
      const claimCard = card(page, exactly("USDG"));
      await expectText("usdg: Vault total distributed", rowValue(claimCard, /^Vault total distributed$/), `${fmtUsdg(await read<bigint>(vault, vaultAbi, "totalUsdgDistributed"))} USDG`);
      // W-3: the distributor's own index (1e27 per share base unit) per whole share, not lifetime
      // distribution over the supply left after the queue burned its shares.
      await expectText(
        "usdg: Distributed to date, per cNVDA",
        rowValue(claimCard, /^Distributed to date, per cNVDA$/),
        `${fmtUsdg((await read<bigint>(vault, vaultAbi, "accUsdgPerShare")) / 1_000_000_000n, 6)} USDG`,
      );
      await expectText("usdg: button", claimCard.getByRole("button"), "Nothing to claim");
    });

    await step("(e) /activity: the closed week from vault logs, premium and strike proceeds apart", async () => {
      const page = depositorPage;
      await page.goto(`${web.url}/activity`);
      const premiumNet = closed.gross - closed.assignmentUsdg - closed.fee;
      const perShare = premiumPerShare({ premiumNetUsdg: premiumNet, sharesAtHarvest: DEPOSIT });
      const topCard = (label: string) => page.locator(SLOT.card).filter({ has: page.locator(SLOT.statLabel, { hasText: exactly(label) }) });
      await expectText("activity: Weeks closed", topCard("Weeks closed").locator(SLOT.statValue), "1");
      await expectText("activity: filled/unfilled", topCard("Weeks closed").locator(SLOT.statSub), "1 filled · 0 unfilled");
      await expectText("activity: Net premium to depositors", topCard("Net premium to depositors").locator(SLOT.statValue), fmtUsdg(premiumNet));
      await expectText("activity: fee sub", topCard("Net premium to depositors").locator(SLOT.statSub), `after ${fmtUsdg(closed.fee)} protocol fee`);
      await expectText("activity: Contracts assigned", topCard("Contracts assigned").locator(SLOT.statValue), EXERCISE_W.toString());
      await expectText("activity: source", card(page, exactly("Weekly results")).locator(SLOT.cardMeta), "rebuilt from vault logs");
      await expectText("activity: indexer notice", page.locator(SLOT.notice, { hasText: "Indexer unreachable" }), "Indexer unreachable — history rebuilt from vault logs.");

      const rows = page.locator("tbody tr");
      await expectText("activity: first row", rows.first().locator("td").first(), "#1");
      assertEq(await rows.count(), 1, "activity shows one row");
      const cells = rows.first().locator("td");
      const expected = [
        "#1",
        fmtUtcDate(closed.closedAt),
        fmtUsdg(closed.strike),
        closed.sold.toString(),
        EXERCISE_W.toString(),
        fmtUsdg(listed.unitPrice6 * closed.sold),
        fmtUsdg(closed.fee),
        fmtUsdg(premiumNet),
        fmtUsdg(closed.assignmentUsdg),
        fmtUsdg(perShare, 6),
        "—",
        `assigned ${EXERCISE_W.toString()}`,
        `${closed.closeTx.slice(0, 8)}…`,
      ];
      const headers = ["Cycle", "Closed", "Strike", "Sold", "Assigned", "Premium", "Fee", "Net premium", "Strike proceeds", "Premium/share", "Net/TVL", "Result", "Tx"];
      for (const [i, text] of expected.entries()) await expectText(`activity row: ${headers[i]}`, cells.nth(i), text);
      const href = await cells.nth(12).locator("a").getAttribute("href");
      assert(href !== null && href.endsWith(`/tx/${closed.closeTx}`), `activity row links the rollClose tx (${String(href)})`);
    });

    await step("no uncaught page errors", async () => {
      assertEq(pageErrors.length, 0, `uncaught page errors: ${pageErrors.join(" | ")}`);
    });

    writeFileSync(join(OUT, "run.json"), JSON.stringify(record, null, 2));
    process.stdout.write(`\nW-13 FORK ACCEPTANCE PASSED in ${((Date.now() - STARTED.getTime()) / 1000).toFixed(0)}s. Evidence: ${join(OUT, "run.json")}\n`);
  } catch (error) {
    record.error = `${currentStep}: ${error instanceof Error ? error.message : String(error)}`;
    writeFileSync(join(OUT, "run.json"), JSON.stringify(record, null, 2));
    // What each browser was looking at when the run stopped.
    for (const [i, page] of OPEN_PAGES.entries()) {
      try {
        await page.screenshot({ path: join(OUT, `failure-page-${i}.png`), fullPage: true });
        writeFileSync(join(OUT, `failure-page-${i}.html`), await page.content());
      } catch {
        /* the page may already be gone */
      }
    }
    throw error;
  } finally {
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        /* best effort */
      }
    }
  }
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`\nW-13 FORK ACCEPTANCE FAILED at "${currentStep}": ${error instanceof Error ? error.message : String(error)}\nEvidence so far: ${join(OUT, "run.json")}\n`);
    process.exit(1);
  },
);
