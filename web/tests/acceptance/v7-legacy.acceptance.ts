/**
 * W8-04: browser exits against a prepared local fork of the frozen v7 deployment.
 *
 * Required configuration:
 *   V7_ACCEPTANCE_RPC_URL       local Anvil fork on chain 4663
 *   NEXT_PUBLIC_V7_API_URL     dedicated local v7 indexer for that fork
 *   V7_ACCEPTANCE_ACCOUNT      account seeded with all four exit fixtures
 *
 * The fork and indexer are deliberately external to this entry point. Unlike the v8
 * devnet, they preserve the deployed v7 code and indexed history. This script refuses
 * remote services, builds /v7 with the dedicated indexer URL, and never imports a v8 ABI.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import {
  createPublicClient,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionData,
  getAddress,
  http,
  toHex,
  type Address,
  type Hex,
} from "viem";

import { V7_DEPLOYMENT } from "../../lib/v7/config";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = mkdtempSync(join(tmpdir(), "stonkhouse-v7-acceptance-"));
const WEB_PORT = Number(process.env.V7_ACCEPTANCE_WEB_PORT ?? 3117);
const SITE = `http://127.0.0.1:${WEB_PORT}`;
const TIMEOUT = Number(process.env.V7_ACCEPTANCE_TIMEOUT_MS ?? 120_000);
const NEXT_ENV_FILE = join(WEB, "next-env.d.ts");
const V8_API_TRIPWIRE = "http://127.0.0.1:9/v8-must-not-be-read";

function required(name: string): string {
  const value = process.env[name]?.trim();
  assert(value, `${name} is required`);
  return value;
}

const RPC = required("V7_ACCEPTANCE_RPC_URL").replace(/\/+$/, "");
// web/lib/v7/config.ts reads this exact setting and intentionally has no v8 fallback.
const V7_API = required("NEXT_PUBLIC_V7_API_URL").replace(/\/+$/, "");
const ACCOUNT = getAddress(required("V7_ACCEPTANCE_ACCOUNT"));
const chain = createPublicClient({ transport: http(RPC) });
const live: ChildProcess[] = [];
const pages: Page[] = [];
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const log = (message: string) => console.log(`  ${message}`);

// Frozen exit subset copied from the deployed v7 source 1b087550cfc92fd1878e5f1c0feaabaa91dc415f:
// src/v2/interfaces/IClearinghouse.sol:161-166,236-243,259-270. The redeem return tuple is
// intentionally v7's (uint256 paid, bool inUsdg), not the regenerated v8 interface.
const v7ClearinghouseExitAbi = [
  { type: "function", name: "close", stateMutability: "nonpayable",
    inputs: [{ name: "longId", type: "uint256" }, { name: "units", type: "uint64" }], outputs: [] },
  { type: "function", name: "redeem", stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }, { name: "holder", type: "address" }],
    outputs: [{ name: "paid", type: "uint256" }, { name: "inUsdg", type: "bool" }] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable",
    inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" },
      { name: "to", type: "address" }], outputs: [] },
] as const;

// Frozen ledger view from the same deployed source, src/v2/interfaces/IClearinghouse.sol:172 (Clearinghouse.sol:144).
// The page withdraws exactly this balance, so the harness reads it on the fork rather than trusting a snapshot.
const v7LedgerViewAbi = [
  { type: "function", name: "free", stateMutability: "view",
    inputs: [{ name: "account", type: "address" }, { name: "asset", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
] as const;

// Frozen exit subset from the same deployed source, src/v2/interfaces/IOrderBook.sol:78-82.
const v7OrderBookExitAbi = [
  { type: "function", name: "cancel", stateMutability: "nonpayable",
    inputs: [{ name: "orderIds", type: "uint256[]" }], outputs: [] },
] as const;

// Positive freeze probe from deployed v7 Clearinghouse.sol:472-479. FreezeV7 disables every
// registered market, so an otherwise direct mint must revert with MarketDisabled().
const v7NewRiskProbeAbi = [
  { type: "error", name: "MarketDisabled", inputs: [] },
  { type: "function", name: "mint", stateMutability: "nonpayable",
    inputs: [{ name: "longId", type: "uint256" }, { name: "units", type: "uint64" },
      { name: "writer", type: "address" }, { name: "longTo", type: "address" }], outputs: [] },
] as const;

// Deployed v7 source 1b087550:src/v2/interfaces/V2Constants.sol:55-57. V8 raised this to 48 h.
const V7_FEE_CHANGE_DELAY_S = 24 * 60 * 60;

type Money = { raw: string; formatted: string };
type Series = { longId: string; status: "open" | "cutoff" | "expired" | "settling" | "held" | "settled" };
type LongPosition = { series: Series; units: string; claimable: Money | null };
type ShortPosition = { series: Series; units: string };
type RestingOrder = { orderId: string; units: string; filled: string };
type LedgerRow = { asset: Address; symbol: string; free: Money };
type Positions = {
  longs: LongPosition[];
  shorts: ShortPosition[];
  orders: RestingOrder[];
  ledger: LedgerRow[];
};
type RpcEnvelope = { result?: unknown; error?: { code: number; message: string; data?: unknown } };
type CapturedCall = { name: string; to: Address; args: readonly unknown[]; hash: Hex; status: string };

async function rpcEnvelope(method: string, params: unknown[] = []): Promise<RpcEnvelope> {
  const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
  assert(response.ok, `${method}: HTTP ${response.status}`);
  return response.json() as Promise<RpcEnvelope>;
}

async function raw(method: string, params: unknown[] = []): Promise<unknown> {
  const body = await rpcEnvelope(method, params);
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${V7_API}${path}`);
  const body = await response.text();
  assert(response.ok, `${path}: ${response.status} ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}

async function until(label: string, check: () => Promise<boolean>, timeout = TIMEOUT,
  serviceFailure?: () => string | null): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const failure = serviceFailure?.();
    if (failure) throw new Error(`${label}: ${failure}; logs in ${OUT}`);
    try { if (await check()) return; } catch { /* the service or indexer is still catching up */ }
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}; logs in ${OUT}`);
}

async function command(label: string, cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const path = join(OUT, `${label}.log`);
  const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let tail = "";
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-8_000);
    appendFileSync(path, chunk);
  });
  const code = await new Promise<number | null>((done, fail) => {
    child.once("error", fail);
    child.once("exit", done);
  });
  assert.equal(code, 0, `${label} failed: ${tail}`);
  log(`${label} passed`);
}

function service(label: string, cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): ChildProcess {
  const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) =>
    appendFileSync(join(OUT, `${label}.log`), chunk));
  live.push(child);
  return child;
}

function exited(child: ChildProcess, label: string): string | null {
  if (child.exitCode === null && child.signalCode === null) return null;
  return `${label} exited with ${child.signalCode ?? `code ${child.exitCode}`}`;
}

function decodeExitCall(to: Address, data: Hex): { name: string; args: readonly unknown[] } {
  if (to === V7_DEPLOYMENT.contracts.clearinghouse) {
    const decoded = decodeFunctionData({ abi: v7ClearinghouseExitAbi, data });
    return { name: decoded.functionName, args: decoded.args ?? [] };
  }
  if (to === V7_DEPLOYMENT.contracts.orderBook) {
    const decoded = decodeFunctionData({ abi: v7OrderBookExitAbi, data });
    return { name: decoded.functionName, args: decoded.args ?? [] };
  }
  throw new Error(`legacy page requested a transaction to non-v7 target ${to}`);
}

class BrowserWallet {
  readonly calls: CapturedCall[] = [];
  private authorised = false;
  constructor(readonly account: Address) {}

  async attach(context: BrowserContext) {
    await context.exposeBinding("__v7AcceptanceWallet", async (_source, method: string, params: unknown) => {
      try { return { result: await this.request(method, Array.isArray(params) ? params : []) }; }
      catch (error) { return { error: { code: -32603, message: String(error) } }; }
    });
    await context.addInitScript({ content: `(() => {
      const listeners = new Map();
      const provider = {
        isMetaMask: true,
        isPhantom: true,
        isCallhouseAcceptanceWallet: true,
        async request(req) {
          const answer = await window.__v7AcceptanceWallet(req.method, req.params || []);
          if (answer.error) { const error = new Error(answer.error.message); error.code = answer.error.code; throw error; }
          return answer.result;
        },
        on(event, callback) { const set = listeners.get(event) || new Set(); set.add(callback); listeners.set(event, set); return provider; },
        removeListener(event, callback) { listeners.get(event)?.delete(callback); return provider; }
      };
      window.ethereum = provider;
      window.phantom = { ethereum: provider };
      const detail = Object.freeze({ info: Object.freeze({ uuid: "5b8d3c2e-6b0e-4a51-9d7e-0c1f3a2b4c5d",
        name: "MetaMask", icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiLz4=", rdns: "io.metamask" }), provider });
      const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
      window.addEventListener("eip6963:requestProvider", announce); announce();
    })();` });
  }

  private async request(method: string, params: unknown[]) {
    if (method === "eth_requestAccounts" || method === "wallet_requestPermissions") {
      this.authorised = true;
      return method === "eth_requestAccounts" ? [this.account] : [{ parentCapability: "eth_accounts" }];
    }
    if (method === "eth_accounts") return this.authorised ? [this.account] : [];
    if (method === "wallet_getPermissions") return this.authorised ? [{ parentCapability: "eth_accounts" }] : [];
    if (method === "eth_chainId") return toHex(4663);
    if (method === "net_version") return "4663";
    if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
    if (method === "eth_sendTransaction") {
      const tx = params[0] as { from?: string; to?: string; data?: Hex; input?: Hex };
      assert.equal(getAddress(tx.from!), this.account, "page requested another signing account");
      assert(tx.to, "page requested a deployment");
      const to = getAddress(tx.to);
      const data = tx.data ?? tx.input;
      assert(data && data !== "0x", "page requested an undecodable v7 write");
      const decoded = decodeExitCall(to, data);
      const hash = await raw(method, params) as Hex;
      const receipt = await chain.waitForTransactionReceipt({ hash });
      this.calls.push({ ...decoded, to, hash, status: receipt.status });
      assert.equal(receipt.status, "success", `${decoded.name} reverted: ${hash}`);
      return hash;
    }
    return raw(method, params);
  }

  async signed(name: string, from: number): Promise<CapturedCall> {
    await until(`${name} wallet transaction`, async () => this.calls.slice(from).some((call) => call.name === name));
    return this.calls.slice(from).find((call) => call.name === name)!;
  }
}

async function connect(page: Page, wallet: BrowserWallet) {
  await page.locator("header").getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("header").getByRole("button", { name: "Phantom", exact: true }).click();
  await until("wallet connection", async () => (await page.locator("header").innerText()).toLowerCase()
    .includes(wallet.account.slice(0, 6).toLowerCase()), 20_000);
}

function minimum(left: string, right: string): bigint {
  return BigInt(left) < BigInt(right) ? BigInt(left) : BigInt(right);
}

function chainFree(asset: Address): Promise<bigint> {
  return chain.readContract({ address: V7_DEPLOYMENT.contracts.clearinghouse, abi: v7LedgerViewAbi,
    functionName: "free", args: [ACCOUNT, asset] });
}

function findHex(value: unknown): Hex | null {
  if (typeof value === "string" && /^0x[0-9a-fA-F]{8,}$/.test(value)) return value as Hex;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findHex(item);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findHex(item);
      if (found) return found;
    }
  }
  return null;
}

async function main() {
  assert(Number.isInteger(WEB_PORT) && WEB_PORT > 0, "V7_ACCEPTANCE_WEB_PORT must be a port");
  for (const [label, value] of [["RPC", RPC], ["v7 indexer", V7_API]] as const) {
    const url = new URL(value);
    assert(["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname), `${label} must be local`);
  }
  assert.match(String(await raw("web3_clientVersion")), /anvil/i, "v7 RPC must be Anvil");
  assert.equal(await chain.getChainId(), 4663, "v7 fork must retain Robinhood Chain id 4663");
  assert((await chain.getBlockNumber()) >= BigInt(V7_DEPLOYMENT.deployBlock), "fork predates the frozen v7 deployment");
  const clearinghouseCode = await chain.getBytecode({ address: V7_DEPLOYMENT.contracts.clearinghouse });
  const orderBookCode = await chain.getBytecode({ address: V7_DEPLOYMENT.contracts.orderBook });
  assert(clearinghouseCode && clearinghouseCode !== "0x", "frozen v7 Clearinghouse is not reachable on the fork");
  assert(orderBookCode && orderBookCode !== "0x", "frozen v7 OrderBook is not reachable on the fork");
  assert.equal(V7_FEE_CHANGE_DELAY_S, 86_400, "v7 fee delay must remain 24 hours");
  log(`frozen v7 fork ${RPC}; fee delay ${V7_FEE_CHANGE_DELAY_S}s; evidence ${OUT}`);

  const positionsPath = `/v2/accounts/${encodeURIComponent(ACCOUNT)}/positions`;
  const initial = await json<Positions>(positionsPath);
  const redeemable = initial.longs.find((position) => position.series.status === "settled" || position.claimable !== null);
  assert(redeemable, "v7 fixture needs a redeemable long");
  // The pre-run snapshot stays valid for redeem and close: the indexer reports `claimable` only on a settled
  // series (indexer/src/api/v2/accounts.ts:106), so `redeemable` is settled while `matched` is not, and the
  // redeem cannot touch the pair. It is NOT valid for the ledger; see the withdraw step.
  const matched = initial.shorts.map((short) => ({
    short,
    long: initial.longs.find((candidate) => candidate.series.longId === short.series.longId),
  })).find((pair) => pair.long && pair.short.series.status !== "settled" && minimum(pair.long.units, pair.short.units) > 0n);
  assert(matched && matched.long, "v7 fixture needs a non-settled matched long/short pair");
  const matchedLong = matched.long;
  const matchedShort = matched.short;
  const order = initial.orders.find((candidate) => BigInt(candidate.units) > BigInt(candidate.filled));
  assert(order, "v7 fixture needs a resting order");
  const ledger = initial.ledger.find((candidate) => BigInt(candidate.free.raw) > 0n);
  assert(ledger, "v7 fixture needs a positive free ledger balance");

  let impersonating = false;
  await raw("anvil_impersonateAccount", [ACCOUNT]);
  impersonating = true;
  await raw("anvil_setBalance", [ACCOUNT, toHex(10n ** 20n)]);

  // Contract-level positive proof: v7 code is reachable, but its freeze rejects a direct risk-opening mint.
  const mintData = encodeFunctionData({ abi: v7NewRiskProbeAbi, functionName: "mint",
    args: [BigInt(matchedLong.series.longId), 1n, ACCOUNT, ACCOUNT] });
  const rejectedMint = await rpcEnvelope("eth_call", [{ from: ACCOUNT,
    to: V7_DEPLOYMENT.contracts.clearinghouse, data: mintData }, "latest"]);
  assert(rejectedMint.error, "direct v7 mint unexpectedly succeeded on the frozen deployment");
  const revertData = findHex(rejectedMint.error);
  assert(revertData, `direct v7 mint omitted revert data: ${JSON.stringify(rejectedMint.error)}`);
  const marketDisabled = encodeErrorResult({ abi: v7NewRiskProbeAbi, errorName: "MarketDisabled" });
  assert.equal(revertData.slice(0, 10).toLowerCase(), marketDisabled.toLowerCase(),
    `direct v7 mint did not reject with MarketDisabled(): ${revertData}`);
  log("direct v7 mint rejected with MarketDisabled()");

  const webEnv: NodeJS.ProcessEnv = { ...process.env,
    NEXT_PUBLIC_V2: "1",
    NEXT_PUBLIC_V7_API_URL: V7_API,
    NEXT_PUBLIC_API_URL: V8_API_TRIPWIRE,
    NEXT_PUBLIC_RPC_URL: RPC,
    NEXT_PUBLIC_RPC_URL_2: RPC,
    NEXT_PUBLIC_CHAIN_ID: "4663",
  };
  assert(!(await fetch(SITE).catch(() => null)), `web port ${WEB_PORT} is occupied`);
  const originalNextEnv = readFileSync(NEXT_ENV_FILE, "utf8");
  try {
    await command("next-build", "pnpm", ["build"], WEB, webEnv);
  } finally {
    writeFileSync(NEXT_ENV_FILE, originalNextEnv);
  }
  const next = service("next-start", join(WEB, "node_modules/.bin/next"), ["start", "-p", String(WEB_PORT)], WEB, webEnv);
  await until("v7 page", async () => (await fetch(`${SITE}/v7`)).ok, TIMEOUT, () => exited(next, "Next"));

  const browser = await chromium.launch({ headless: process.env.V7_ACCEPTANCE_HEADFUL !== "1" });
  try {
    const pageErrors: string[] = [];
    const requestedUrls: string[] = [];
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const wallet = new BrowserWallet(ACCOUNT);
    await wallet.attach(context);
    const page = await context.newPage();
    pages.push(page);
    page.setDefaultTimeout(TIMEOUT);
    page.on("pageerror", (error) => pageErrors.push(`${page.url()}: ${error.message}`));
    page.on("request", (request) => requestedUrls.push(request.url()));
    await page.goto(`${SITE}/v7`);
    await page.getByRole("heading", { name: "Wind down your v7 positions." }).waitFor();
    await connect(page, wallet);
    await page.getByRole("button", { name: "Redeem v7 long" }).first().waitFor();

    const main = page.locator("main");
    const interactiveLabels = [
      ...await main.getByRole("button").allTextContents(),
      ...await main.getByRole("link").allTextContents(),
    ].join("\n");
    assert.doesNotMatch(interactiveLabels, /\b(?:mint|buy|write|place order|open (?:new )?(?:position|risk))\b/i,
      "legacy route exposed a control that can open v7 risk");

    let from = wallet.calls.length;
    await page.getByRole("button", { name: "Redeem v7 long" }).first().click();
    const redeem = await wallet.signed("redeem", from);
    assert.equal(redeem.to, V7_DEPLOYMENT.contracts.clearinghouse);
    assert.equal(redeem.args[0], BigInt(redeemable.series.longId));
    assert.equal(getAddress(String(redeem.args[1])), ACCOUNT);

    from = wallet.calls.length;
    await page.getByRole("button", { name: "Close matched pair" }).first().click();
    const close = await wallet.signed("close", from);
    assert.equal(close.to, V7_DEPLOYMENT.contracts.clearinghouse);
    assert.equal(close.args[0], BigInt(matchedLong.series.longId));
    assert.equal(close.args[1], minimum(matchedLong.units, matchedShort.units));

    from = wallet.calls.length;
    await page.getByRole("button", { name: "Cancel order" }).first().click();
    const cancel = await wallet.signed("cancel", from);
    assert.equal(cancel.to, V7_DEPLOYMENT.contracts.orderBook);
    assert.deepEqual(cancel.args[0], [BigInt(order.orderId)]);

    // The fourth click cannot be checked against `initial`. The v7 indexer serves `ledger[].free` LIVE from the
    // chain (indexer/src/api/v2/accounts.ts:130 readFree, in the image since c7f7fe88), the page withdraws whatever
    // that reports (web/components/v7/RunoffPortfolio.tsx:84,91) and re-fetches after every confirmed write
    // before its buttons re-enable (RunoffPortfolio.tsx:127-133), while the deployed v7 `close` always credits
    // `free[msg.sender][asset] += freed + refund` (Clearinghouse.sol:551) and a to-ledger redeem credits too
    // (:971, :977). So when the withdraw asset is the pair's collateral asset the page correctly withdraws MORE
    // than the pre-run figure, and the old `BigInt(ledger.free.raw)` expectation was red on a correct page
    // and green only while the indexer's chain read fell back to a stale row. Read the fork instead.
    from = wallet.calls.length;
    const asset = getAddress(ledger.asset);
    const expectedFree = await chainFree(asset);
    assert(expectedFree > 0n, `v7 free ${ledger.symbol} balance was emptied before the withdraw click`);
    let shown: LedgerRow | undefined;
    await until(`v7 indexer reporting the live ${ledger.symbol} balance`, async () => {
      shown = (await json<Positions>(positionsPath)).ledger.find((row) => getAddress(row.asset) === asset);
      return shown !== undefined && BigInt(shown.free.raw) === expectedFree;
    });
    await until(`/v7 showing the live ${ledger.symbol} balance`, async () =>
      (await main.innerText()).includes(`${shown!.free.formatted} ${shown!.symbol}`));
    await page.getByRole("button", { name: `Withdraw ${ledger.symbol}` }).first().click();
    const withdraw = await wallet.signed("withdraw", from);
    assert.equal(withdraw.to, V7_DEPLOYMENT.contracts.clearinghouse);
    assert.equal(getAddress(String(withdraw.args[0])), asset);
    assert.equal(withdraw.args[1], expectedFree, "page withdrew something other than the whole live v7 free balance");
    assert.equal(getAddress(String(withdraw.args[2])), ACCOUNT);
    assert.equal(await chainFree(asset), 0n, `withdraw left a v7 free ${ledger.symbol} balance on the fork`);

    assert.deepEqual(wallet.calls.map((call) => call.name), ["redeem", "close", "cancel", "withdraw"]);
    assert(requestedUrls.some((url) => url.startsWith(`${V7_API}${positionsPath}`)),
      "legacy route never read the configured v7 indexer");
    assert(!requestedUrls.some((url) => url.startsWith(V8_API_TRIPWIRE)),
      "legacy route attempted to read the v8 API fallback tripwire");
    assert.deepEqual(pageErrors, [], `browser errors: ${pageErrors.join("\n")}`);
    log("browser redeemed, closed, cancelled, and withdrew through /v7");
  } catch (error) {
    for (let index = 0; index < pages.length; index++) {
      const page = pages[index]!;
      if (!page.isClosed()) await page.screenshot({ path: join(OUT, `failure-${index}.png`), fullPage: true }).catch(() => {});
    }
    throw error;
  } finally {
    await browser.close();
  }

  if (impersonating) await raw("anvil_stopImpersonatingAccount", [ACCOUNT]);
  log(`PASS; evidence ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await raw("anvil_stopImpersonatingAccount", [ACCOUNT]).catch(() => {});
  for (const child of live.reverse()) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
});
