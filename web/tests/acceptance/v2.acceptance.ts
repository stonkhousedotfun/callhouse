/**
 * W2-14: browser transactions against a freshly seeded Stonkhouse v2 devnet.
 * Run `ops/devnet/up.sh` first, then `pnpm --filter @callhouse/web acceptance:v2`.
 * This starts an isolated Ponder database and a devnet-address Next build. It never
 * sends to a non-local RPC and restores the committed markets generator output.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { createPublicClient, decodeFunctionData, encodeAbiParameters, encodeFunctionData, formatUnits, getAddress, http, keccak256, pad, parseEventLogs,
  toFunctionSelector, toHex, type Address, type Hex } from "viem";

import { clearinghouseAbi } from "../../lib/abi/v2/clearinghouse";
import { orderBookAbi } from "../../lib/abi/v2/orderBook";
import { autoRollerAbi } from "../../lib/abi/v2/autoRoller";
import { settlementOracleAbi } from "../../lib/abi/v2/settlementOracle";
import { payoutAdapterAbi } from "../../lib/abi/v2/payoutAdapter";
import { accessManagerAbi } from "../../lib/abi/v2/accessManager";
import { conversionFloorBps } from "../../lib/v2/conversion";
import { formatUsdgTick, smartPricingPrices } from "../../lib/v2/smartPricing";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ROOT = resolve(WEB, "..");
const DEVNET = join(ROOT, "ops/devnet");
const OUT = mkdtempSync(join(tmpdir(), "stonkhouse-v2-acceptance-"));
const API_PORT = Number(process.env.V2_ACCEPTANCE_API_PORT ?? 42180);
const WEB_PORT = Number(process.env.V2_ACCEPTANCE_WEB_PORT ?? 3114);
const API = `http://127.0.0.1:${API_PORT}`;
const SITE = `http://127.0.0.1:${WEB_PORT}`;
const TIMEOUT = Number(process.env.V2_ACCEPTANCE_TIMEOUT_MS ?? 900_000);
const MARKET_FILE = join(WEB, "lib/markets.generated.ts");
const INDEXER_MARKET_FILE = join(ROOT, "indexer/lib/v2/marketRegistry.generated.ts");
// Mirrors TakeParams.maxTotalFee's uint128 width in contracts/src/v2/interfaces/V2Types.sol.
const MAX_UINT128 = (1n << 128n) - 1n;
// Mirrors FEE_CHANGE_DELAY in contracts/src/v2/interfaces/V2Constants.sol:60
// (`uint40 internal constant FEE_CHANGE_DELAY = 48 hours;`). INTERFACE_VERSION 8 raised it from 24 h
// (owner decision V3-D13), so OrderBook.setFeeParams records
// effectiveAt = the timestamp of the block that EXECUTED it + this. Distinct from the AccessManager's
// own FEE_MANAGER execution delay, which the admin driver waits out before the call is even sent.
const FEE_CHANGE_DELAY_S = 48 * 60 * 60;
// Mirrors type(IClearinghouse).interfaceId at INTERFACE_VERSION 8, pinned in the contracts repo at
// test/v2/InterfaceIds.t.sol:960 ("IClearinghouse 0xf9e1eb5d -> 0x9b75eeed").
const CLEARINGHOUSE_INTERFACE_ID_V8 = "0x9b75eeed";
// The v7 id the same test records as superseded; a v8 deployment must no longer answer it.
const CLEARINGHOUSE_INTERFACE_ID_V7 = "0xf9e1eb5d";
// V2Types.OrderKind: 0 Bid, 1 AskResale, 2 AskWrite. Only an AskWrite fill mints in v8.
const ASK_WRITE = 2;
// IPayoutRouter.Venue in contracts/src/v2/interfaces/IPayoutRouter.sol:41-45 — None, V3, V4.
const VENUE_V4 = 2;
// routes(address) keeps this selector across v7 -> v8 while its tuple gained `tickSpacing`
// (INTERFACE-CHANGES-V8 entry 1, "What deliberately did NOT move"), so the selector can never tell
// the two apart: the tuple is read from the regenerated ABI, never feature-detected.
const ROUTES_SELECTOR = "0xd7409659";
const erc20ApproveAbi = [{ type: "function", name: "approve", stateMutability: "nonpayable",
  inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

type Devnet = {
  chainId: number; rpc: string; startBlock: number;
  accounts: Record<string, Address>;
  contracts: { clearinghouse: Address; orderBook: Address; autoRoller: Address | null; settlementOracle: Address };
  markets: { ticker: string; underlying: Address }[];
  seed: { trade: { series: { longId: string; ticker: string; tag: string; tags: string[]; expiry: number }[];
    itm: { longId: string }; resaleOrderId: string };
    summary: { gates: string; block: string } };
};

const D = JSON.parse(readFileSync(join(DEVNET, "addresses.json"), "utf8")) as Devnet;
const RPC = D.rpc;
// Subprocess writers must use the exact node and manifest guarded by main().
// Ignore stale shell values and the helpers' default port when using another fork.
const devnetHelperEnv: NodeJS.ProcessEnv = { ...process.env, DEVNET_RPC: RPC,
  DEVNET_ADDRESSES: join(DEVNET, "addresses.json") };
const chain = createPublicClient({ transport: http(RPC), chain: { id: 4663, name: "Local fork",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } } });
const live: ChildProcess[] = [];
const pages: Page[] = [];
let originalIndexerMarkets: string | null = null;
const log = (message: string) => { console.log(`  ${message}`); };

async function raw(method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
  const body = await response.json() as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

function envFile(path: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    assert(match, `invalid generated env line: ${line}`);
    env[match[1]] = match[2];
  }
  return env;
}

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`);
  const body = await response.text();
  assert(response.ok, `${path}: ${response.status} ${body.slice(0, 300)}`);
  return JSON.parse(body) as T;
}

async function until(label: string, check: () => Promise<boolean>, timeout = 90_000,
  serviceFailure?: () => string | null): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const failure = serviceFailure?.();
    if (failure) throw new Error(`${label}: ${failure}; logs in ${OUT}`);
    try { if (await check()) return; } catch { /* service or indexer is still starting */ }
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
    child.once("error", fail); child.once("exit", done);
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

/** Only devnet's unlocked accounts may sign page transactions. */
class BrowserWallet {
  readonly calls: { name: string; to: Address; hash: Hex; status: string }[] = [];
  private authorised = false;
  constructor(readonly account: Address) {}
  async attach(context: BrowserContext) {
    await context.exposeBinding("__v2AcceptanceWallet", async (_source, method: string, params: unknown) => {
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
          const answer = await window.__v2AcceptanceWallet(req.method, req.params || []);
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
    if (["eth_requestAccounts", "wallet_requestPermissions", "eth_accounts", "eth_chainId", "wallet_getPermissions"].includes(method))
      log(`wallet ${this.account.slice(0, 6)}: ${method}`);
    if (method === "eth_requestAccounts" || method === "wallet_requestPermissions") {
      this.authorised = true;
      return method === "eth_requestAccounts" ? [this.account] : [{ parentCapability: "eth_accounts" }];
    }
    if (method === "eth_accounts") return this.authorised ? [this.account] : [];
    if (method === "wallet_getPermissions") return this.authorised ? [{ parentCapability: "eth_accounts" }] : [];
    if (method === "eth_chainId") return toHex(4663);
    if (method === "net_version") return "4663";
    if (method === "wallet_switchEthereumChain") return null;
    if (method === "eth_sendTransaction") {
      const tx = params[0] as { from?: string; to?: string; data?: Hex; input?: Hex };
      assert.equal(getAddress(tx.from!), this.account, "page requested another signing account");
      assert(tx.to, "page requested a deployment");
      const to = getAddress(tx.to);
      const hash = await raw(method, params) as Hex;
      const receipt = await chain.waitForTransactionReceipt({ hash });
      const data = tx.data ?? tx.input;
      let name = "unknown";
      if (data && data !== "0x") {
        for (const abi of [clearinghouseAbi, orderBookAbi, autoRollerAbi]) {
          try { name = decodeFunctionData({ abi, data }).functionName; break; } catch { /* another ABI */ }
        }
      }
      this.calls.push({ name, to, hash, status: receipt.status });
      assert.equal(receipt.status, "success", `${name} reverted: ${hash}`);
      return hash;
    }
    return raw(method, params);
  }
  async signed(name: string, from: number) {
    await until(`${name} wallet transaction`, async () => this.calls.slice(from).some((call) => call.name === name), 120_000);
    return this.calls.slice(from).find((call) => call.name === name)!;
  }
}

async function connect(page: Page, wallet: BrowserWallet) {
  await page.locator("header").getByRole("button", { name: "Connect", exact: true }).click();
  log(`wallet options: ${JSON.stringify(await page.locator("header").getByRole("group", { name: "Wallets" }).getByRole("button").allTextContents())}`);
  log(`injected provider: ${JSON.stringify(await page.evaluate(() => {
    const provider = (window as unknown as { ethereum?: { isMetaMask?: boolean; isCallhouseAcceptanceWallet?: boolean } }).ethereum;
    return { metaMask: Boolean(provider?.isMetaMask), acceptance: Boolean(provider?.isCallhouseAcceptanceWallet) };
  }))}`);
  await page.locator("header").getByRole("button", { name: "Phantom", exact: true }).click();
  try {
    await until("wallet connection", async () => (await page.locator("header").innerText()).toLowerCase()
      .includes(wallet.account.slice(0, 6).toLowerCase()), 20_000);
  } catch {
    throw new Error(`wallet ${wallet.account} did not connect: header=${await page.locator("header").innerText()} ` +
      `alerts=${JSON.stringify(await page.getByRole("alert").allTextContents())} ` +
      `toasts=${JSON.stringify(await page.getByRole("status").allTextContents())}`);
  }
}

async function tokenBalance(token: Address, holder: Address) {
  return chain.readContract({ address: token, abi: [{ type: "function", name: "balanceOf", stateMutability: "view",
    inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const, functionName: "balanceOf", args: [holder] });
}

/** Fund only local test wallets by locating the token's balance mapping, restoring failed probes. */
async function deal(token: Address, holder: Address, amount: bigint) {
  const bases = [BigInt("0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00"),
    ...Array.from({ length: 64 }, (_, i) => BigInt(i))];
  for (const base of bases) {
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, base]));
    const previous = await raw("eth_getStorageAt", [token, slot, "latest"]);
    await raw("anvil_setStorageAt", [token, slot, pad(toHex(amount), { size: 32 })]);
    if (await tokenBalance(token, holder) === amount) return;
    await raw("anvil_setStorageAt", [token, slot, previous]);
  }
  throw new Error(`cannot fund ${holder} on local fork`);
}

function seriesTag(tag: string) {
  const row = D.seed.trade.series.find((series) => series.ticker === "NVDA" && series.tags.includes(tag));
  assert(row, `seed missing NVDA ${tag}`);
  return row;
}

async function contrast(page: Page, selector: string) {
  // tsx injects a private __name helper into nested browser callback functions.
  // Keep this evaluated callback self-contained without nested functions.
  return page.locator(selector).first().evaluate((element) => {
    const fg = getComputedStyle(element).color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
    let parent: Element | null = element;
    let bg = [255, 255, 255];
    while (parent) {
      const style = getComputedStyle(parent);
      if (style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent") {
        bg = style.backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? bg;
        break;
      }
      parent = parent.parentElement;
    }
    const colors = [fg, bg];
    const luminance = [0, 0];
    const weights = [0.2126, 0.7152, 0.0722];
    for (let side = 0; side < 2; side++) {
      for (let channel = 0; channel < 3; channel++) {
        const s = colors[side]![channel]! / 255;
        luminance[side] += weights[channel]! * (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
      }
    }
    return (Math.max(...luminance) + 0.05) / (Math.min(...luminance) + 0.05);
  });
}

async function main() {
  assert.equal(D.chainId, 4663);
  assert.equal(D.seed.summary.gates, "passed", "run a fresh ops/devnet/up.sh first");
  const url = new URL(RPC);
  assert(["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname), "RPC must be local");
  assert.match(String(await raw("web3_clientVersion")), /anvil/i, "RPC must be anvil");
  assert.equal(await chain.getChainId(), 4663);
  assert.equal(await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
    functionName: "supportsInterface", args: [CLEARINGHOUSE_INTERFACE_ID_V8] }), true,
  "browser acceptance requires the INTERFACE_VERSION 8 Clearinghouse ID");
  assert.equal(await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
    functionName: "supportsInterface", args: [CLEARINGHOUSE_INTERFACE_ID_V7] }), false,
  "a v8 devnet must not still answer the superseded v7 Clearinghouse ID");
  log(`devnet ${RPC}; evidence ${OUT}`);

  const indexerEnv: NodeJS.ProcessEnv = { ...process.env, ...envFile(join(DEVNET, "env/indexer.env")),
    PONDER_RPC_URL_4663: RPC, V2_START_BLOCK: String(D.startBlock),
    PGLITE_DIRECTORY: join(OUT, "pglite"), DATABASE_SCHEMA: "v2_acceptance", PORT: String(API_PORT) };
  for (const key of ["DATABASE_URL", "DATABASE_PRIVATE_URL", "END_BLOCK", "VAULT_ADDRESS", "VAULT", "START_BLOCK"])
    delete indexerEnv[key];
  assert(!(await fetch(`${API}/ready`).catch(() => null)), `API port ${API_PORT} is occupied`);
  const pricingEnv: NodeJS.ProcessEnv = { ...process.env, ...envFile(join(DEVNET, "env/pricing.env")), RH_RPC: RPC };
  delete pricingEnv.TSX_TSCONFIG_PATH;
  const pricingUrl = `http://127.0.0.1:${pricingEnv.PRICING_PORT}`;
  assert(!(await fetch(`${pricingUrl}/health`).catch(() => null)), `pricing port ${pricingEnv.PRICING_PORT} is occupied`);
  const pricing = service("pricing", join(ROOT, "keeper/node_modules/.bin/tsx"), ["src/v2/pricing/main.ts"], join(ROOT, "keeper"), pricingEnv);
  await until("pricing spot", async () => {
    const response = await fetch(`${pricingUrl}/surface/NVDA`);
    if (!response.ok) return false;
    const surface = await response.json() as { spot?: { raw?: string } };
    return BigInt(surface.spot?.raw ?? "0") > 0n;
  }, 120_000, () => exited(pricing, "pricing"));
  indexerEnv.PRICING_URL = pricingUrl;
  log("pricing service returned live NVDA spot");
  originalIndexerMarkets = readFileSync(INDEXER_MARKET_FILE, "utf8");
  await command("gen-v2-registry", "pnpm", ["gen:v2-registry"], join(ROOT, "indexer"),
    { ...process.env, MARKETS_REGISTRY: join(DEVNET, "tier1.devnet.json") });
  const ponder = service("ponder", join(ROOT, "indexer/node_modules/.bin/ponder"), ["start", "--schema", "v2_acceptance"], join(ROOT, "indexer"), indexerEnv);
  await until("Ponder seed sync", async () => {
    const ready = await fetch(`${API}/ready`);
    if (!ready.ok) return false;
    const health = await json<{ block: string }>("/v2/health");
    return BigInt(health.block) >= BigInt(D.seed.summary.block);
  }, TIMEOUT, () => exited(ponder, "Ponder"));
  log("Ponder reached seeded block");

  const originalMarkets = readFileSync(MARKET_FILE, "utf8");
  const webEnv: NodeJS.ProcessEnv = { ...process.env, ...envFile(join(DEVNET, "env/web.env")),
    NEXT_PUBLIC_V2: "1", NEXT_PUBLIC_API_URL: API, NEXT_PUBLIC_RPC_URL: RPC, NEXT_PUBLIC_RPC_URL_2: RPC,
    MARKETS_REGISTRY: join(DEVNET, "tier1.devnet.json") };
  try {
    await command("gen-markets", "pnpm", ["gen:markets"], WEB, webEnv);
    await command("next-build", "pnpm", ["build"], WEB, webEnv);
  } finally { writeFileSync(MARKET_FILE, originalMarkets); }
  // The seed settles two minutes after its final mock-feed round. Publish a new
  // round just before browser use so the trade UI sees a fresh live quote.
  await command("refresh-feeds", "node", [join(DEVNET, "set-feed.mjs"), "--all"], ROOT, devnetHelperEnv);
  const refreshedBlock = await chain.getBlockNumber();
  await until("Ponder feed refresh", async () => {
    const health = await json<{ block: string }>("/v2/health");
    return BigInt(health.block) >= refreshedBlock;
  });
  assert(!(await fetch(SITE).catch(() => null)), `web port ${WEB_PORT} is occupied`);
  const next = service("next-start", join(WEB, "node_modules/.bin/next"), ["start", "-p", String(WEB_PORT)], WEB, webEnv);
  await until("Next page", async () => (await fetch(SITE)).ok, 120_000, () => exited(next, "Next"));

  // A browser attempt changes orders and allowances. Refuse a second attempt
  // against the same seed, even when the first attempt failed mid-transaction.
  try {
    writeFileSync(join(DEVNET, "state/v2-acceptance-used"), `${D.seed.summary.block}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("this devnet already ran browser acceptance; rerun ops/devnet/up.sh for a fresh seed");
    throw error;
  }

  const browser = await chromium.launch({ headless: process.env.V2_ACCEPTANCE_HEADFUL !== "1" });
  try {
    const pageErrors: string[] = [];
    const watchPage = (page: Page) => {
      page.on("pageerror", (error) => {
        const detail = `${page.url()}: ${error.message}`;
        pageErrors.push(detail);
        log(`page error: ${detail}`);
      });
      page.on("console", (message) => { if (message.type() === "error") log(`browser console: ${message.text()}`); });
    };
    const buyer = new BrowserWallet(D.accounts.spare);
    const writer = new BrowserWallet(D.accounts.ben);
    const buyerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const writerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await buyer.attach(buyerContext); await writer.attach(writerContext);
    const buyerPage = await buyerContext.newPage();
    const writerPage = await writerContext.newPage();
    for (const page of [buyerPage, writerPage]) watchPage(page);
    pages.push(buyerPage, writerPage);
    // The seed has warped past the first expiry. Browser deadlines and quote clocks
    // must track the fork's timestamp, not the host's earlier wall clock.
    const chainNow = new Date(Number((await chain.getBlock()).timestamp) * 1000);
    await buyerPage.clock.setFixedTime(chainNow);
    await writerPage.clock.setFixedTime(chainNow);
    const usdg = getAddress((await json<{ usdg: { address: string } }>("/v2/config")).usdg.address);
    const nvda = D.markets.find((market) => market.ticker === "NVDA")!.underlying;
    await deal(usdg, buyer.account, 10_000n * 10n ** 6n);
    if (await tokenBalance(nvda, writer.account) < 10n ** 18n) await deal(nvda, writer.account, 2n * 10n ** 18n);

    // The market search popup participates in the tab order. Moving focus into its
    // footer must not unmount it; moving onward must close it without losing focus.
    await buyerPage.goto(SITE);
    const marketSearch = buyerPage.getByRole("combobox", { name: "Search markets" });
    await marketSearch.focus();
    const browseMarkets = buyerPage.getByRole("link", { name: "Browse all markets" });
    await browseMarkets.waitFor({ state: "visible" });
    await buyerPage.keyboard.press("Tab");
    assert(await browseMarkets.evaluate((element) => element === document.activeElement),
      "Tab from market search reaches Browse all markets");
    await buyerPage.keyboard.press("Tab");
    const connectButton = buyerPage.locator("header").getByRole("button", { name: "Connect", exact: true });
    await until("market search exits without focus loss", async () =>
      await connectButton.evaluate((element) => element === document.activeElement), 10_000);
    await browseMarkets.waitFor({ state: "hidden" });
    log("market search tabs through Browse all markets and onward without focus loss");

    // A pointer press on the footer link must not let the search input's blur close the popup
    // before the click lands (WebKit does not focus a link on mousedown); the click navigates.
    await marketSearch.focus();
    await browseMarkets.waitFor({ state: "visible" });
    await browseMarkets.click();
    await buyerPage.waitForURL(/\/markets(?:[?#]|$)/, { timeout: 30_000 });
    log("a pointer press on Browse all markets opens the directory");
    await buyerPage.goto(SITE);

    // The landing card is the entry point; activation must focus the ticket for keyboard users.
    await connect(buyerPage, buyer);
    await buyerPage.getByText(/max loss/i).first().waitFor({ state: "visible" });
    const firstBuy = buyerPage.getByRole("link", { name: "Buy 0.01 shares", exact: true }).first();
    await firstBuy.waitFor({ state: "visible", timeout: 60_000 });
    await firstBuy.focus(); await buyerPage.keyboard.press("Enter");
    await buyerPage.locator("#ticket-shares").waitFor({ state: "visible" });
    await until("keyboard card entry focuses trade size", async () =>
      await buyerPage.evaluate(() => document.activeElement?.id === "ticket-shares"), 10_000);
    const slider = buyerPage.getByRole("slider", { name: /price at expiry/ });
    await slider.focus(); await buyerPage.keyboard.press("Home");
    const minimum = await slider.getAttribute("aria-valuenow");
    await buyerPage.keyboard.press("ArrowRight");
    assert.notEqual(await slider.getAttribute("aria-valuenow"), minimum, "slider arrow key changes target price");
    assert.match(await slider.getAttribute("aria-valuetext") ?? "", /Max loss:/, "slider announces max loss");
    const cardId = new URL(buyerPage.url()).pathname.split("/")[2]!;
    const beforeTiny = await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
      functionName: "balanceOf", args: [buyer.account, BigInt(cardId)] });
    const nTiny = buyer.calls.length;
    await buyerPage.locator("#ticket").getByRole("button", { name: "Buy now", exact: true }).last().focus();
    await buyerPage.keyboard.press("Enter");
    await buyer.signed("take", nTiny);
    assert.equal(await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
      functionName: "balanceOf", args: [buyer.account, BigInt(cardId)] }), beforeTiny + 1n, "card buy minted 0.01 share");
    log("card → keyboard ticket → 0.01 share buy confirmed on chain");

    // A bid must rest in the book, then a long can be listed for resale from Portfolio.
    await buyerPage.locator("#ticket").getByRole("button", { name: "Place a bid" }).click();
    await buyerPage.getByLabel("Your bid price per share (USDG)").fill("0.0001");
    const nBid = buyer.calls.length;
    await buyerPage.locator("#ticket").getByRole("button", { name: "Place bid", exact: true }).click();
    const bidTx = await buyer.signed("place", nBid);
    const bidEvents = parseEventLogs({ abi: orderBookAbi, eventName: "OrderPlaced",
      logs: (await chain.getTransactionReceipt({ hash: bidTx.hash })).logs });
    assert.equal(bidEvents[0]?.args.kind, 0, "ticket created a bid");
    assert.equal(bidEvents[0]?.args.maker.toLowerCase(), buyer.account.toLowerCase());
    assert.equal(bidEvents[0]?.args.longId, BigInt(cardId));
    log("bid placed from trade ticket");

    await until("buy indexed", async () => {
      const positions = await json<{ longs: { series: { longId: string } }[] }>(`/v2/accounts/${buyer.account}/positions`);
      return positions.longs.some((item) => item.series.longId === cardId);
    }, 120_000);
    await buyerPage.goto(`${SITE}/portfolio`);
    await buyerPage.getByRole("heading", { name: "Portfolio" }).waitFor();
    const longCard = buyerPage.locator("article").filter({ has: buyerPage.locator(`input[id="sell-size-${cardId}"]`) });
    await longCard.getByRole("button", { name: "List for sale" }).click();
    await longCard.getByLabel("Ask price per share (USDG)").fill("100");
    const nResale = buyer.calls.length;
    await longCard.getByRole("button", { name: "Sell crossing bids and list remainder" }).click();
    const resaleTx = await buyer.signed("place", nResale);
    const resaleEvents = parseEventLogs({ abi: orderBookAbi, eventName: "OrderPlaced",
      logs: (await chain.getTransactionReceipt({ hash: resaleTx.hash })).logs });
    assert.equal(resaleEvents[0]?.args.kind, 1, "Portfolio created an AskResale");
    assert.equal(resaleEvents[0]?.args.maker.toLowerCase(), buyer.account.toLowerCase());
    assert.equal(resaleEvents[0]?.args.longId, BigInt(cardId));
    assert.equal(resaleEvents[0]?.args.units, 1n);
    log("0.01 share listed for resale from Portfolio");

    // Fill that escrowed long from a different seeded wallet. The browser already
    // exercised the listing path; this verifies actual resale delivery, USDG net
    // proceeds, the indexed fill and removal of the completed ask.
    const resaleId = resaleEvents[0]!.args.orderId;
    const [resaleOrder] = await chain.readContract({ address: D.contracts.orderBook, abi: orderBookAbi,
      functionName: "getOrders", args: [[resaleId]] });
    assert(resaleOrder && resaleOrder.kind === 1 && resaleOrder.filled === 0n);
    const resaleBuyer = D.accounts.dee;
    const [sellerUsdgBefore, resaleBuyerUsdgBefore, buyerLongBefore, escrowBefore] = await Promise.all([
      tokenBalance(usdg, buyer.account), tokenBalance(usdg, resaleBuyer),
      chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "balanceOf", args: [resaleBuyer, BigInt(cardId)] }),
      chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "balanceOf", args: [D.contracts.orderBook, BigInt(cardId)] }),
    ]);
    const resaleQuoteParams = { longId: BigInt(cardId), buying: true, orderIds: [resaleId], units: 1n,
      minUnits: 1n, limitPrice: resaleOrder.price, writeToSell: false, recipient: resaleBuyer,
      deadline: Number((await chain.getBlock()).timestamp) + 300, maxTotalFee: MAX_UINT128 };
    const [quotedUnits, quotedPremium, quotedFee, quotedSellerFees] = await chain.readContract({ account: resaleBuyer,
      address: D.contracts.orderBook, abi: orderBookAbi, functionName: "quoteTake", args: [resaleQuoteParams] });
    assert.equal(quotedUnits, 1n, "listed resale is fillable by another wallet");
    const resaleParams = { ...resaleQuoteParams, maxTotalFee: quotedFee + quotedSellerFees };
    const resaleFillHash = await raw("eth_sendTransaction", [{ from: resaleBuyer, to: D.contracts.orderBook,
      data: encodeFunctionData({ abi: orderBookAbi, functionName: "take", args: [resaleParams] }) }]) as Hex;
    const resaleFillReceipt = await chain.waitForTransactionReceipt({ hash: resaleFillHash });
    assert.equal(resaleFillReceipt.status, "success", "resale take confirmed");
    const resaleFills = parseEventLogs({ abi: orderBookAbi, eventName: "OrderFilled", logs: resaleFillReceipt.logs });
    const resaleFill = resaleFills.find((fill) => fill.args.orderId === resaleId);
    assert(resaleFill && !resaleFill.args.primary && resaleFill.args.takerIsBuyer,
      "the take consumed the AskResale rather than minting a new long");
    assert.equal(resaleFill.args.premium, quotedPremium);
    assert.equal(await tokenBalance(usdg, buyer.account) - sellerUsdgBefore,
      resaleFill.args.premium - resaleFill.args.sellerFee + resaleFill.args.makerRebate,
      "resale seller received premium less resale fee plus maker rebate");
    assert.equal(resaleBuyerUsdgBefore - await tokenBalance(usdg, resaleBuyer), quotedPremium + quotedFee,
      "resale buyer paid premium and taker fee");
    assert.equal(await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
      functionName: "balanceOf", args: [resaleBuyer, BigInt(cardId)] }), buyerLongBefore + 1n,
    "resale buyer received the escrowed long");
    assert.equal(await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
      functionName: "balanceOf", args: [D.contracts.orderBook, BigInt(cardId)] }), escrowBefore - 1n,
    "OrderBook released the escrowed long");
    const [filledResaleOrder] = await chain.readContract({ address: D.contracts.orderBook, abi: orderBookAbi,
      functionName: "getOrders", args: [[resaleId]] });
    assert.equal(filledResaleOrder?.filled, 1n, "resale order filled completely");
    await until("resale indexed", async () => {
      const history = await json<{ items: { kind: string; longId: string | null;
        data: { orderId?: string; side?: string; primary?: boolean; tx?: string } }[] }>(
          `/v2/accounts/${buyer.account}/history?limit=100`);
      const positions = await json<{ orders: { orderId: string }[] }>(`/v2/accounts/${buyer.account}/positions`);
      return history.items.some((item) => item.kind === "fill" && item.longId === cardId &&
        item.data.orderId === String(resaleId) && item.data.side === "sell" && !item.data.primary &&
        item.data.tx?.toLowerCase() === resaleFillHash.toLowerCase()) &&
        !positions.orders.some((order) => order.orderId === String(resaleId));
    }, 120_000);
    log("resale filled: long delivered, seller net USDG and indexed history verified");

    // A writer deposits collateral and posts a cheaper 0.40-share AskWrite. The next
    // one-share buy must consume this level and an existing seeded level.
    const target = seriesTag("weekly1-r0");
    await writerPage.goto(`${SITE}/earn/nvda`);
    await connect(writerPage, writer);
    const freeBefore = await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
      functionName: "free", args: [writer.account, nvda] });
    await writerPage.locator("#writer-deposit").fill("1");
    const nDeposit = writer.calls.length;
    await writerPage.getByRole("region", { name: "Writer balance" }).getByRole("button", { name: "Deposit" }).click();
    await writer.signed("deposit", nDeposit);
    assert.equal(await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
      functionName: "free", args: [writer.account, nvda] }), freeBefore + 10n ** 18n, "writer collateral credited");
    const ask = writerPage.getByRole("region", { name: "Manual ask" });
    await ask.getByLabel("Expiry").selectOption(String(target.expiry));
    await ask.getByLabel("Strike").selectOption(target.longId);
    await ask.getByLabel("Size in shares").fill("0.40");
    await ask.getByLabel("Your price / share · USDG").fill("0.0001");
    const nAsk = writer.calls.length;
    await ask.getByRole("button", { name: "Place AskWrite order" }).click();
    await writer.signed("place", nAsk);
    log("writer deposit and manual AskWrite confirmed on chain");

    if (D.contracts.autoRoller) {
      const roll = writerPage.getByRole("region", { name: "Auto-roll strategy" });
      const action = roll.getByRole("button", { name: /Enable auto-roll|Update strategy/ });
      await action.waitFor({ state: "visible" });
      const saved = roll.getByRole("button", { name: "Load saved strategy into form" });
      if (await saved.isVisible()) await saved.click();
      const [strategySpotOk, strategySpot] = await chain.readContract({ address: D.contracts.settlementOracle,
        abi: settlementOracleAbi, functionName: "trySpot", args: [nvda] });
      assert(strategySpotOk, "smart-pricing acceptance has a fresh oracle spot");
      const bandPrices = smartPricingPrices(strategySpot, { askBps: 300, minAskBps: 25, maxAskBps: 300 });
      assert(bandPrices, "smart-pricing acceptance band has valid USDG ticks");
      const startingAsk = roll.getByLabel("Starting ask · USDG / share");
      await startingAsk.fill(formatUsdgTick(bandPrices.start));
      await startingAsk.blur();
      const smartPricing = roll.getByRole("checkbox", { name: "Smart pricing within my limits" });
      if (!await smartPricing.isChecked()) await smartPricing.check();
      const minimumAsk = roll.getByLabel("Minimum ask · USDG / share");
      await minimumAsk.fill(formatUsdgTick(bandPrices.min));
      await minimumAsk.blur();
      const maximumAsk = roll.getByLabel("Maximum ask · USDG / share");
      await maximumAsk.fill(formatUsdgTick(bandPrices.max));
      await maximumAsk.blur();
      assert(await action.isEnabled(), "auto-roll action is disabled on a configured devnet");
      const nRoll = writer.calls.length;
      await action.click();
      const strategyTx = await writer.signed("setStrategy", nRoll);
      assert.equal(strategyTx.to, getAddress(D.contracts.autoRoller), "strategy sent to configured AutoRoller");
      const strategy = await chain.readContract({ address: D.contracts.autoRoller, abi: autoRollerAbi,
        functionName: "strategy", args: [writer.account, nvda] });
      assert(strategy.active, "writer strategy should be active on chain");
      assert(strategy.smartPricing, "writer strategy should opt into smart pricing on chain");
      assert.equal(Number(strategy.askBps), 300, "writer strategy starts at the selected ceiling");
      assert.equal(Number(strategy.minAskBps), 25, "writer strategy saves the selected floor");
      assert.equal(Number(strategy.maxAskBps), 300, "writer strategy saves the selected ceiling");
      log("auto-roll strategy and editable smart-pricing band active on chain");
    } else {
      assert.equal(process.env.V2_ACCEPTANCE_ALLOW_MISSING_ROLLER, "1",
        "AutoRoller missing: use Claude's periphery devnet commit; interim core-only runs require explicit override");
      log("interim core-only run: AutoRoller not deployed");
    }

    await until("new ask indexed", async () => {
      const book = await json<{ asks: { price: { raw: string }; orders: { orderId: string; units: string }[] }[] }>(
        `/v2/series/${target.longId}/book?depth=20`);
      return book.asks.some((level) => level.price.raw === "100" && level.orders.some((order) => Number(order.units) >= 40));
    }, 120_000);
    await buyerPage.goto(`${SITE}/nvda/${target.longId}?buy=1&shares=1`);
    await buyerPage.locator("#ticket-shares").waitFor({ state: "visible" });
    await buyerPage.locator("#ticket-shares").fill("1");
    const nFull = buyer.calls.length;
    await buyerPage.locator("#ticket").getByRole("button", { name: "Buy now", exact: true }).last().click();
    const full = await buyer.signed("take", nFull);
    const receipt = await chain.getTransactionReceipt({ hash: full.hash });
    const fills = parseEventLogs({ abi: orderBookAbi, eventName: "OrderFilled", logs: receipt.logs });
    const rents = parseEventLogs({ abi: clearinghouseAbi, eventName: "Minted", logs: receipt.logs });
    // 06-QUIRKS.md B.7: the book's two `mint` calls sit inside `try … {gas: 500_000}`, so a mint that
    // reverts is a SILENT SKIP that still returns a green receipt. Every take whose units come from a
    // fresh mint therefore asserts the Minted events and the minted unit count, never the status.
    const primaryFills = fills.filter((fill) => fill.args.primary);
    assert(primaryFills.length >= 2, "the one-share buy crossed at least two minting AskWrite levels");
    assert.equal(rents.length, primaryFills.length,
      "every primary fill emitted its own Minted event; a skipped mint would drop one");
    assert.equal(rents.reduce((sum, event) => sum + event.args.units, 0n),
      primaryFills.reduce((sum, fill) => sum + fill.args.units, 0n),
      "minted units equal the units the primary fills reported");
    // INVERTED for v8 (was `event.args.fee > 0n`): X8-05's devnet seeds premium 500 / rent 0, so a
    // primary fill charges no collateral rent. Asserted rather than deleted, so a devnet that
    // accidentally re-enables rent still fails here.
    assert(rents.every((event) => event.args.fee === 0n), "a v8 primary fill charges no collateral rent");
    assert.equal(fills.reduce((sum, fill) => sum + fill.args.units, 0n), 100n, "full share filled");
    assert(new Set(fills.map((fill) => fill.args.orderId.toString())).size >= 2, "buy crossed two orders");
    assert(new Set(fills.map((fill) => fill.args.price.toString())).size >= 2, "buy crossed two price levels");
    assert.equal(await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
      functionName: "balanceOf", args: [buyer.account, BigInt(target.longId)] }) > 0n, true);
    log("one-share buy crossed multiple ask levels");

    // Force the browser to rebuild the book from one chain snapshot, including
    // writer rent. A hard navigation clears the previous page's query cache.
    const bookRoute = `**/v2/series/${target.longId}/book*`;
    let blockedBookRequests = 0;
    await buyerPage.route(bookRoute, async (route) => {
      blockedBookRequests++;
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"acceptance outage"}' });
    });
    try {
      const beforeFallback = await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "balanceOf", args: [buyer.account, BigInt(target.longId)] });
      await buyerPage.goto(`${SITE}/nvda/${target.longId}?buy=1&shares=0.01`);
      await buyerPage.getByText("Indexer book unavailable.", { exact: false }).waitFor({ state: "visible" });
      assert(blockedBookRequests > 0, "fallback acceptance must actually interrupt the API book");
      await buyerPage.locator("#ticket-shares").fill("0.01");
      const nFallback = buyer.calls.length;
      await buyerPage.locator("#ticket").getByRole("button", { name: "Buy now", exact: true }).last().click();
      const fallback = await buyer.signed("take", nFallback);
      const fallbackReceipt = await chain.getTransactionReceipt({ hash: fallback.hash });
      const fallbackFills = parseEventLogs({ abi: orderBookAbi, eventName: "OrderFilled", logs: fallbackReceipt.logs });
      const fallbackRents = parseEventLogs({ abi: clearinghouseAbi, eventName: "Minted", logs: fallbackReceipt.logs });
      // 06-QUIRKS.md B.7 again: prove the mint by its event and its unit count, not by the receipt.
      assert(fallbackRents.length > 0, "the chain-snapshot fallback bought from a minting AskWrite");
      assert.equal(fallbackRents.length, fallbackFills.filter((fill) => fill.args.primary).length,
        "every primary fallback fill emitted its own Minted event");
      assert.equal(fallbackRents.reduce((sum, event) => sum + event.args.units, 0n), 1n,
        "the chain-snapshot fallback minted exactly one unit");
      // INVERTED for v8 (was `event.args.fee > 0n`).
      assert(fallbackRents.every((event) => event.args.fee === 0n),
        "a chain-snapshot fallback purchase charges no writer rent in v8");
      assert.equal(await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "balanceOf", args: [buyer.account, BigInt(target.longId)] }), beforeFallback + 1n,
      "fallback quote filled exactly one unit");
      log("indexer book outage: chain snapshot fallback minted one unit at zero rent");
    } finally { await buyerPage.unroute(bookRoute); }

    // The seeded in-the-money call has already warped, settled and paid out; the
    // portfolio History and share page must render that on-chain redemption.
    const winner = new BrowserWallet(D.accounts.cy);
    const winnerContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await winner.attach(winnerContext);
    const winnerPage = await winnerContext.newPage(); watchPage(winnerPage); pages.push(winnerPage);
    await winnerPage.clock.setFixedTime(chainNow);
    const itmId = D.seed.trade.itm.longId;
    const settled = await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
      functionName: "series", args: [BigInt(itmId)] });
    assert(settled.settled && settled.longPayoutPerUnit > 0n, "seeded ITM call settled with payout on chain");
    const itmLabel = `NVDA $${formatUnits(settled.strike, 6)}`;
    const history = await json<{ items: { kind: string; longId: string | null;
      data: { amount?: { raw: string } } }[] }>(`/v2/accounts/${winner.account}/history?limit=100`);
    assert(history.items.some((item) => item.kind === "redemption" && item.longId === itmId &&
      BigInt(item.data.amount?.raw ?? "0") > 0n), "winner history has positive ITM redemption");
    assert(history.items.some((item) => item.kind === "redemption" &&
      BigInt(item.data.amount?.raw ?? "1") === 0n), "winner history has a worthless redemption");
    await winnerPage.goto(`${SITE}/portfolio`); await connect(winnerPage, winner);
    await winnerPage.getByRole("button", { name: "History" }).click();
    const redemption = winnerPage.locator("article").filter({ hasText: /redemption/i }).filter({ hasText: itmLabel });
    await redemption.getByText("Paid", { exact: true }).waitFor({ state: "visible", timeout: 60_000 });
    await winnerPage.getByText("Expired without payout", { exact: true }).waitFor({ state: "visible" });
    const pnlId = `${itmId}-${winner.account.toLowerCase()}`;
    const pnl = await json<{ holder: string; series: { longId: string }; payout: { raw: string };
      settlementPrice: { raw: string } }>(`/v2/pnl/${pnlId}`);
    assert.equal(pnl.holder.toLowerCase(), winner.account.toLowerCase());
    assert.equal(pnl.series.longId, itmId);
    assert(BigInt(pnl.payout.raw) > 0n, "share receipt has positive payout");
    assert.equal(pnl.settlementPrice.raw, String(settled.settlementPrice));
    await winnerPage.goto(`${SITE}/pnl/${pnlId}`);
    await winnerPage.getByText("Paid → value received", { exact: true }).waitFor({ state: "visible" });
    await winnerPage.getByText(winner.account, { exact: true }).waitFor({ state: "visible" });
    log("settled payout visible in Portfolio; share page rendered");

    // The v8 payout route, read BY FIELD from the regenerated ABI. INTERFACE-CHANGES-V8 entry 1
    // ("What deliberately did NOT move") records that routes(address) keeps selector 0xd7409659
    // while its tuple gained `tickSpacing`, so the selector cannot tell a v7 adapter from a v8
    // router. Deriving the selector from the regenerated ABI and then checking the tuple's fields is
    // the proof that this file re-generated rather than feature-detected.
    const routesAbi = payoutAdapterAbi.find((item) => item.type === "function" && item.name === "routes") as
      { name: string; inputs: readonly { type: string }[];
        outputs: readonly { components?: readonly { name: string }[] }[] } | undefined;
    assert(routesAbi, "the regenerated PayoutRouter ABI still exports routes()");
    assert.equal(toFunctionSelector(`routes(${routesAbi.inputs.map((input) => input.type).join(",")})`),
      ROUTES_SELECTOR, "routes() keeps its v7 selector in v8, which is why it must never be feature-detected");
    assert.deepEqual(routesAbi.outputs[0]?.components?.map((field) => field.name),
      ["venue", "fee", "tickSpacing", "v3Pool", "feeBps"],
      "the v8 Route tuple is read by field from the regenerated ABI, not positionally from the v7 one");
    const payoutRouter = await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
      functionName: "payoutAdapter" });
    assert.notEqual(payoutRouter, "0x0000000000000000000000000000000000000000",
      "a v8 devnet configures a PayoutRouter so winning calls can be paid in USDG");
    const nvdaRoute = await chain.readContract({ address: payoutRouter, abi: payoutAdapterAbi,
      functionName: "routes", args: [nvda] });
    assert.equal(nvdaRoute.venue, VENUE_V4, "NVDA converts to USDG over a Uniswap v4 route in v8");
    assert.notEqual(nvdaRoute.tickSpacing, 0, "the v4 PoolKey leg carries the tuple's new tick spacing");
    const [routeFeeBps, payoutSlippageBps] = await Promise.all([
      chain.readContract({ address: payoutRouter, abi: payoutAdapterAbi, functionName: "routeFeeBps", args: [nvda] }),
      chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi, functionName: "maxPayoutSlippageBps" }),
    ]);
    const expectedFloorBps = conversionFloorBps(Number(payoutSlippageBps), Number(routeFeeBps));

    // Redeem that route to USDG in the browser, on the default payout preference. X8-05's seed must
    // leave one settled ITM long unredeemed for a wallet other than Eve's, the same way
    // ops/devnet/seed.mjs already skips Eve in its redeemBatch pass so the in-kind Collect below has
    // a unit to spend.
    let usdgCollectorAccount: Address | null = null;
    for (const [name, account] of Object.entries(D.accounts) as [string, Address][]) {
      if (name === "eve") continue;
      const balance = await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "balanceOf", args: [account, BigInt(itmId)] });
      if (balance > 0n) { usdgCollectorAccount = account; break; }
    }
    assert(usdgCollectorAccount, "seed must leave one settled ITM long unredeemed for a wallet other than Eve's, " +
      "so the browser can redeem it to USDG over the v4 route (X8-05, ops/devnet/seed.mjs redeemBatch)");
    const usdgCollector = new BrowserWallet(usdgCollectorAccount);
    const usdgCollectorContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await usdgCollector.attach(usdgCollectorContext);
    const usdgCollectorPage = await usdgCollectorContext.newPage();
    watchPage(usdgCollectorPage); pages.push(usdgCollectorPage);
    await usdgCollectorPage.clock.setFixedTime(chainNow);
    const usdgBefore = await tokenBalance(usdg, usdgCollector.account);
    await usdgCollectorPage.goto(`${SITE}/portfolio`); await connect(usdgCollectorPage, usdgCollector);
    const usdgChoice = usdgCollectorPage.getByRole("button", { name: "USDG (default)", exact: true });
    await usdgChoice.waitFor({ state: "visible", timeout: 60_000 });
    assert.equal(await usdgChoice.getAttribute("aria-pressed"), "true",
      "USDG over the route is the default payout preference in v8");
    // The route preview the long card renders, from the same floor the chain reports.
    const floorCopy = usdgCollectorPage.getByText(/conversion floor is/i).first();
    await floorCopy.waitFor({ state: "visible", timeout: 60_000 });
    assert.match(await floorCopy.innerText(), new RegExp(`${(expectedFloorBps / 100).toFixed(2)}%`),
      "the long card previews the v4 route's conversion floor, including its route fee");
    const usdgCard = usdgCollectorPage.locator("article").filter({ hasText: "Long position" })
      .filter({ hasText: itmLabel });
    const usdgCollectButton = usdgCard.getByRole("button", { name: "Collect", exact: true });
    await usdgCollectButton.waitFor({ state: "visible", timeout: 60_000 });
    const nUsdgCollect = usdgCollector.calls.length;
    await usdgCollectButton.click();
    const usdgCollectTx = await usdgCollector.signed("redeem", nUsdgCollect);
    const usdgCollectReceipt = await chain.getTransactionReceipt({ hash: usdgCollectTx.hash });
    const converted = parseEventLogs({ abi: clearinghouseAbi, eventName: "Redeemed", logs: usdgCollectReceipt.logs })
      .find((event) => event.args.tokenId === BigInt(itmId) &&
        event.args.holder.toLowerCase() === usdgCollector.account.toLowerCase());
    assert(converted && converted.args.amount > 0n, "the browser Collect emitted a positive redemption");
    assert.equal(getAddress(converted.args.asset), getAddress(usdg),
      "the default preference paid USDG, converted over the v4 route");
    assert(converted.args.amountInKind > 0n && converted.args.amount !== converted.args.amountInKind,
      "a converted payout reports both the USDG paid and the in-kind amount it replaced");
    assert.equal(await tokenBalance(usdg, usdgCollector.account) - usdgBefore, converted.args.amount,
      "the USDG payout reached the collector wallet");
    await until("USDG Collect indexed", async () => {
      const history = await json<{ items: { kind: string; longId: string | null;
        data: { asset?: string; amount?: { raw: string }; tx?: string } }[] }>(
          `/v2/accounts/${usdgCollector.account}/history?limit=100`);
      return history.items.some((item) => item.kind === "redemption" && item.longId === itmId &&
        item.data.tx?.toLowerCase() === usdgCollectTx.hash.toLowerCase() &&
        item.data.asset?.toLowerCase() === usdg.toLowerCase() &&
        BigInt(item.data.amount?.raw ?? "0") === converted.args.amount);
    }, 120_000);
    log("Portfolio Collect redeemed to USDG over the v4 route with the previewed conversion floor");

    // Eve's seeded 1-unit ITM long was intentionally left unredeemed. Choose the IN-KIND FALLBACK in
    // the real Portfolio -- the payout a holder gets when conversion is refused or fails -- collect
    // it there, and reconcile the wallet balance and indexed redemption with the chain receipt.
    const collector = new BrowserWallet(D.accounts.eve);
    const collectorContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await collector.attach(collectorContext);
    const collectorPage = await collectorContext.newPage(); watchPage(collectorPage); pages.push(collectorPage);
    await collectorPage.clock.setFixedTime(chainNow);
    const collectId = BigInt(itmId);
    assert.equal(await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
      functionName: "balanceOf", args: [collector.account, collectId] }), 1n,
    "seed must reserve Eve's winning long for browser Collect");
    const stockBefore = await tokenBalance(nvda, collector.account);
    await collectorPage.goto(`${SITE}/portfolio`); await connect(collectorPage, collector);
    const stockChoice = collectorPage.getByRole("button", { name: "Stock Tokens", exact: true });
    await stockChoice.waitFor({ state: "visible" });
    const nPreference = collector.calls.length;
    await stockChoice.click();
    await collector.signed("setPayoutInKind", nPreference);
    await until("in-kind preference indexed", async () => {
      const positions = await json<{ prefs: { inKind: boolean } }>(`/v2/accounts/${collector.account}/positions`);
      return positions.prefs.inKind;
    }, 120_000);
    await collectorPage.reload();
    const collectCard = collectorPage.locator("article").filter({ hasText: "Long position" })
      .filter({ hasText: itmLabel });
    const collectButton = collectCard.getByRole("button", { name: "Collect", exact: true });
    await collectButton.waitFor({ state: "visible", timeout: 60_000 });
    assert(await collectButton.isEnabled(), "settled winning long can be collected from Portfolio");
    const nCollect = collector.calls.length;
    await collectButton.click();
    const collectTx = await collector.signed("redeem", nCollect);
    const collectReceipt = await chain.getTransactionReceipt({ hash: collectTx.hash });
    const redemptions = parseEventLogs({ abi: clearinghouseAbi, eventName: "Redeemed", logs: collectReceipt.logs });
    const collected = redemptions.find((event) => event.args.tokenId === collectId &&
      event.args.holder.toLowerCase() === collector.account.toLowerCase());
    assert(collected && collected.args.amount > 0n, "Portfolio Collect emitted a positive redemption");
    assert.equal(getAddress(collected.args.asset), getAddress(nvda), "in-kind Collect paid Stock Tokens");
    assert.equal(collected.args.units, 1n);
    assert.equal(collected.args.amount, collected.args.amountInKind);
    assert.equal(await tokenBalance(nvda, collector.account) - stockBefore, collected.args.amount,
      "in-kind payout reached the collector wallet");
    assert.equal(await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
      functionName: "balanceOf", args: [collector.account, collectId] }), 0n,
    "Collect burned the winning long once");
    await until("in-kind Collect indexed", async () => {
      const history = await json<{ items: { kind: string; longId: string | null;
        data: { asset?: string; amount?: { raw: string }; tx?: string } }[] }>(
          `/v2/accounts/${collector.account}/history?limit=100`);
      const positions = await json<{ longs: { series: { longId: string } }[] }>(
        `/v2/accounts/${collector.account}/positions`);
      return history.items.some((item) => item.kind === "redemption" && item.longId === itmId &&
        item.data.tx?.toLowerCase() === collectTx.hash.toLowerCase() &&
        item.data.asset?.toLowerCase() === nvda.toLowerCase() &&
        BigInt(item.data.amount?.raw ?? "0") === collected.args.amount) &&
        !positions.longs.some((position) => position.series.longId === itmId);
    }, 120_000);
    await collectorPage.goto(`${SITE}/portfolio`);
    await collectorPage.getByRole("button", { name: "History" }).click();
    await collectorPage.locator("article").filter({ hasText: /redemption/i })
      .filter({ hasText: itmLabel }).getByText("Paid", { exact: true }).waitFor({ state: "visible" });
    log("Portfolio in-kind fallback: Collect paid Stock Tokens, with indexed redemption history");

    // Accessibility and performance, in both themes, over every v8 surface this run exercises: the
    // marketplace, the trade ticket and the Portfolio. The last two are where the v4 route preview
    // (ConversionFloor, Portfolio.tsx:180 and TradeTicket.tsx:250) and the pending-fee /
    // pending-admin-operation notices render. Add W8-02's trust and fees page to this list when it
    // lands; the loop then covers it with no other change.
    const themedPages = [
      { label: "home", url: SITE, heading: "#marketplace-title" },
      { label: "trade ticket", url: `${SITE}/nvda/${target.longId}?buy=1&shares=0.01`, heading: "h1" },
      { label: "portfolio", url: `${SITE}/portfolio`, heading: "h1" },
    ] as const;
    let homeNavigationMs = 0;
    let homeResponseMs: number | null = null;
    for (const theme of ["light", "dark"] as const) {
      await buyerPage.emulateMedia({ colorScheme: theme });
      for (const surface of themedPages) {
        const navigationStart = Date.now();
        await buyerPage.goto(surface.url);
        if (surface.label === "home") {
          homeNavigationMs = Date.now() - navigationStart;
          await buyerPage.getByRole("heading", { name: /money|upside/i }).waitFor({ state: "visible" });
          homeResponseMs = await buyerPage.evaluate(() => {
            const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
            return navigation ? navigation.responseEnd - navigation.startTime : null;
          });
        } else {
          await buyerPage.locator("h1").first().waitFor({ state: "visible", timeout: 60_000 });
        }
        const ratio = await contrast(buyerPage, surface.heading);
        assert(ratio >= 4.5, `${theme} ${surface.label} heading contrast ${ratio.toFixed(2)}:1`);
        const overflow = await buyerPage.evaluate(() => document.documentElement.scrollWidth - innerWidth);
        assert(overflow <= 1, `${theme} ${surface.label} 390px horizontal overflow ${overflow}px`);
        if (surface.label === "home") {
          const cards = await buyerPage.locator("#options article").count();
          assert(cards <= 200, `marketplace rendered ${cards} cards; page limit is 200`);
          log(`${theme} home: hero contrast ${ratio.toFixed(2)}:1, mobile overflow ${overflow}px, ${cards} cards`);
        } else {
          log(`${theme} ${surface.label}: heading contrast ${ratio.toFixed(2)}:1, mobile overflow ${overflow}px`);
        }
      }
    }
    const responseMs = homeResponseMs ?? homeNavigationMs;
    assert(Number.isFinite(responseMs) && responseMs < 15_000, "local home response exceeded 15s");
    log(`local home response ${responseMs.toFixed(0)}ms`);

    // v8 mint lifecycle. Two inversions of the v7 block that stood here:
    //   (1) the Clearinghouse no longer mints for an EOA — `if (!isMinter[msg.sender]) revert
    //       V2Errors.NotMinter();`, and DevDeploy allowlists only the book
    //       (`d.clearinghouse.setMinter(address(d.orderBook), true)`). The direct mint is therefore
    //       asserted to REVERT and the same matched position is acquired through an AskWrite fill.
    //   (2) rent is 0 (X8-05 seeds premium 500 / rent 0). Every rent assertion is inverted to zero
    //       rather than deleted, so a devnet that accidentally re-enables rent still fails here.
    // The browser-driven Portfolio close below is unchanged and is the only browser proof of a close.
    const rentTemplate = await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
      functionName: "series", args: [BigInt(seriesTag("weekly2-r0").longId)] });
    const sendRentTx = async (to: Address, data: Hex) => {
      const hash = await raw("eth_sendTransaction", [{ from: writer.account, to, data }]) as Hex;
      const result = await chain.waitForTransactionReceipt({ hash });
      assert.equal(result.status, "success", "local v8 lifecycle transaction confirmed");
      return result;
    };
    const sendFrom = async (from: Address, to: Address, data: Hex, label: string) => {
      const hash = await raw("eth_sendTransaction", [{ from, to, data }]) as Hex;
      const result = await chain.waitForTransactionReceipt({ hash });
      assert.equal(result.status, "success", `${label} confirmed`);
      return result;
    };
    // A third wallet fills the writer's AskWrite with `recipient` set to the writer, so the fresh long
    // and the writer's short land together and the matched close below is the same close v7 proved.
    // OrderBook: "buying, AskWrite: Clearinghouse.mint(longId, units, maker, recipient)".
    const lifecycleTaker = D.accounts.dee;
    for (const isPut of [false, true]) {
      const asset = isPut ? usdg : nvda;
      const decimals = isPut ? 6 : 18;
      const id = await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "longIdOf", args: [nvda, isPut, rentTemplate.strike, rentTemplate.expiry] });
      await sendRentTx(D.contracts.clearinghouse, encodeFunctionData({ abi: clearinghouseAbi,
        functionName: "createSeries", args: [nvda, isPut, rentTemplate.strike, rentTemplate.expiry] }));
      const terms = await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "series", args: [id] });
      const apiRentStateMatches = async (expectedFree: bigint, expectedHeld: bigint) => {
        const [positions, detail] = await Promise.all([
          json<{ ledger: { asset: string; free: { raw: string; decimals: number } }[] }>(
            `/v2/accounts/${writer.account}/positions`),
          json<{ series: { mintFeesHeld: { raw: string; decimals: number } } }>(`/v2/series/${id}`),
        ]);
        const ledger = positions.ledger.find((row) => row.asset.toLowerCase() === asset.toLowerCase());
        return ledger?.free.raw === String(expectedFree) && ledger.free.decimals === decimals &&
          detail.series.mintFeesHeld.raw === String(expectedHeld) && detail.series.mintFeesHeld.decimals === decimals;
      };
      // INVERTED (was `assert(terms.mintFeePpm > 0, "rent lifecycle series pins a nonzero rate")`).
      assert.equal(terms.mintFeePpm, 0, "a v8 series carries no collateral rent rate");
      const heldBefore = terms.mintFeesHeld;
      // INVERTED: nothing is ever held for a v8 series, so the starting point is zero and stays zero.
      assert.equal(heldBefore, 0n, "a fresh v8 series holds no rent");
      const collateral = isPut ? terms.strike / 100n : 10n ** 16n;
      const deposit = collateral * 2n;
      if (await tokenBalance(asset, writer.account) < deposit) await deal(asset, writer.account, deposit * 2n);
      await sendRentTx(asset, encodeFunctionData({ abi: erc20ApproveAbi,
        functionName: "approve", args: [D.contracts.clearinghouse, deposit] }));
      await sendRentTx(D.contracts.clearinghouse, encodeFunctionData({ abi: clearinghouseAbi,
        functionName: "deposit", args: [asset, deposit, writer.account] }));
      const freeBeforeMint = await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "free", args: [writer.account, asset] });

      // INVERTED: the v7 block sent `mint(id, 1n, writer, writer)` straight from the writer EOA here.
      // In v8 that path is closed, and the allowlist is an in-contract mapping, not a manager role.
      assert.equal(await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "isMinter", args: [writer.account] }), false, "no EOA is on the v8 minter allowlist");
      assert.equal(await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "isMinter", args: [D.contracts.orderBook] }), true, "the OrderBook is the v8 minter");
      await assert.rejects(chain.simulateContract({ account: writer.account, address: D.contracts.clearinghouse,
        abi: clearinghouseAbi, functionName: "mint", args: [id, 1n, writer.account, writer.account] }),
      /NotMinter/, "a direct Clearinghouse.mint from an EOA reverts NotMinter in v8");

      // One tick per share (priceTick 100, unitsPerShare 100), so one unit costs one raw USDG of premium.
      const askPrice = 100n;
      const placedReceipt = await sendRentTx(D.contracts.orderBook, encodeFunctionData({ abi: orderBookAbi,
        functionName: "place", args: [id, ASK_WRITE, askPrice, 1n, terms.expiry] }));
      const placed = parseEventLogs({ abi: orderBookAbi, eventName: "OrderPlaced", logs: placedReceipt.logs })[0]!;
      assert(placed && placed.args.kind === ASK_WRITE && placed.args.units === 1n,
        "the writer posted a one-unit AskWrite for the lifecycle series");
      const lifecycleQuoteParams = { longId: id, buying: true, orderIds: [placed.args.orderId], units: 1n,
        minUnits: 1n, limitPrice: askPrice, writeToSell: false, recipient: writer.account,
        deadline: Number((await chain.getBlock()).timestamp) + 300, maxTotalFee: MAX_UINT128 };
      const lifecycleQuote = await chain.readContract({ account: lifecycleTaker, address: D.contracts.orderBook,
        abi: orderBookAbi, functionName: "quoteTake", args: [lifecycleQuoteParams] });
      assert.equal(lifecycleQuote[0], 1n, "the writer's AskWrite quotes one fillable unit");
      const lifecycleCost = lifecycleQuote[1] + lifecycleQuote[2] + lifecycleQuote[3];
      if (await tokenBalance(usdg, lifecycleTaker) < lifecycleCost) await deal(usdg, lifecycleTaker, lifecycleCost + 10n ** 9n);
      await sendFrom(lifecycleTaker, usdg, encodeFunctionData({ abi: erc20ApproveAbi,
        functionName: "approve", args: [D.contracts.orderBook, lifecycleCost] }), "lifecycle taker USDG approval");
      const mintedReceipt = await sendFrom(lifecycleTaker, D.contracts.orderBook,
        encodeFunctionData({ abi: orderBookAbi, functionName: "take",
          args: [{ ...lifecycleQuoteParams, maxTotalFee: lifecycleQuote[2] + lifecycleQuote[3] }] }),
        "lifecycle AskWrite fill");
      // 06-QUIRKS.md B.7: the book's mint sits inside `try … {gas: 500_000}`. A reverted mint is a
      // silent skip on a green receipt, so the Minted event and its unit count are the only proof.
      const lifecycleFills = parseEventLogs({ abi: orderBookAbi, eventName: "OrderFilled", logs: mintedReceipt.logs });
      const minted = parseEventLogs({ abi: clearinghouseAbi, eventName: "Minted", logs: mintedReceipt.logs })[0]!;
      assert(minted, "the AskWrite fill minted; a silently skipped mint leaves no Minted log behind");
      assert.equal(lifecycleFills.length, 1, "exactly the writer's AskWrite was consumed");
      assert.equal(lifecycleFills[0]!.args.primary, true, "the fill minted rather than moving inventory");
      assert.equal(minted.args.units, 1n, "the fill minted exactly one unit");
      assert.equal(minted.args.units, lifecycleFills[0]!.args.units, "minted units equal the filled units");
      assert.equal(minted.args.longId, id);
      assert.equal(minted.args.writer.toLowerCase(), writer.account.toLowerCase(), "the maker carries the short");
      assert.equal(minted.args.longTo.toLowerCase(), writer.account.toLowerCase(),
        "the fresh long was delivered to the writer, so the close below closes matched units");
      // INVERTED (was the round-up equality plus `minted.args.fee > 0n`): rent is 0 in v8.
      assert.equal(minted.args.fee, 0n, "a v8 mint charges no rent");
      const freeAfterMint = await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "free", args: [writer.account, asset] });
      // INVERTED (was `collateral + minted.args.fee`): the ledger debits collateral and nothing else.
      assert.equal(freeBeforeMint - freeAfterMint, collateral,
        `${isPut ? "put USDG" : "call Stock Token"} ledger debits collateral and no rent`);
      // INVERTED: mintFeesHeld does not move across a v8 mint.
      assert.equal((await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "series", args: [id] })).mintFeesHeld, heldBefore, "a v8 mint holds no rent");
      await until("v8 mint indexed at zero rent", async () => {
        const history = await json<{ items: { kind: string; longId: string | null;
          data: { tx?: string; fee?: { raw: string; decimals: number } } }[] }>(
          `/v2/accounts/${writer.account}/history?limit=100`);
        return history.items.some((item) => item.kind === "mint" && item.longId === String(id) &&
          item.data.tx === mintedReceipt.transactionHash && item.data.fee?.raw === "0" &&
          item.data.fee.decimals === decimals);
      }, 120_000);
      await until("v8 mint API free balance and held rent", () =>
        apiRentStateMatches(freeAfterMint, heldBefore), 120_000);
      await writerPage.goto(`${SITE}/portfolio`);
      const shortCard = writerPage.locator("article").filter({ has: writerPage.locator(`input[id="buyback-size-${id}"]`) });
      await shortCard.getByLabel("Size to close in shares").fill("0.01");
      // INVERTED (was `assert.match(..., /rent/i, "writer economics disclose native-asset rent")`).
      // Word-bounded on purpose: the unbounded /rent/i this replaces also matches "current".
      assert.doesNotMatch(await shortCard.innerText(), /\brent\b/i, "v8 writer economics disclose no rent");
      const nClose = writer.calls.length;
      await shortCard.getByRole("button", { name: "Close matched units", exact: true }).click();
      const closeTx = await writer.signed("close", nClose);
      const closedReceipt = await chain.getTransactionReceipt({ hash: closeTx.hash });
      const closed = parseEventLogs({ abi: clearinghouseAbi, eventName: "Closed", logs: closedReceipt.logs })[0]!;
      assert(closed && closed.args.longId === id && closed.args.units === 1n);
      // INVERTED (was the pro-rata refund equality plus `refund > 0n && refund <= minted.args.fee`):
      // nothing was charged, so nothing is refunded.
      assert.equal(closed.args.feeRefund, 0n, "a v8 close refunds no rent, because none was charged");
      assert.equal(await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "free", args: [writer.account, asset] }), freeAfterMint + collateral,
      "Portfolio close credits collateral, and only collateral, to the closer");
      await until("v8 close indexed at zero refund", async () => {
        const history = await json<{ items: { kind: string; longId: string | null;
          data: { tx?: string; feeRefund?: { raw: string; decimals: number } } }[] }>(
          `/v2/accounts/${writer.account}/history?limit=100`);
        return history.items.some((item) => item.kind === "close" && item.longId === String(id) &&
          item.data.tx === closeTx.hash && item.data.feeRefund?.raw === "0" && item.data.feeRefund.decimals === decimals);
      }, 120_000);
      // INVERTED: held rent is unchanged across the whole lifecycle, not drawn down by a refund.
      await until("v8 close API free balance and held rent", () =>
        apiRentStateMatches(freeAfterMint + collateral, heldBefore), 120_000);
      log(`${isPut ? "put USDG" : "call Stock Token"}: EOA mint refused, AskWrite fill minted at zero rent, browser close verified`);
    }

    // A seeded active strategy keeps its period after a permissionless stale cancel.
    if (D.contracts.autoRoller) {
      const roller = D.contracts.autoRoller;
      const position = await chain.readContract({ address: roller, abi: autoRollerAbi,
        functionName: "position", args: [writer.account, nvda] });
      assert(position[1] > 0n, "seeded strategy has a tracked ask for stale cancellation");
      const series = await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "series", args: [position[0]] });
      const [spotOk, originalSpot] = await chain.readContract({ address: D.contracts.settlementOracle,
        abi: settlementOracleAbi, functionName: "trySpot", args: [nvda] });
      assert(spotOk && originalSpot > 0n, "stale-cancel fixture begins with an acceptable spot");
      const moveSpot = async (from: bigint, target: bigint) => {
        let current = from;
        for (let step = 0; current !== target && step < 32; step++) {
          current = target > current ? (target < current * 11n / 10n ? target : current * 11n / 10n)
            : (target > current * 9n / 10n ? target : current * 9n / 10n);
          await command(`v7-feed-${step}`, "node", [join(DEVNET, "set-feed.mjs"), "NVDA", "--price", formatUnits(current, 6)], ROOT, devnetHelperEnv);
        }
        assert.equal(current, target, "mock feed reached intended price with bounded jumps");
      };
      await moveSpot(originalSpot, series.strike);
      const cancelHash = await raw("eth_sendTransaction", [{ from: D.accounts.dee, to: roller,
        data: encodeFunctionData({ abi: autoRollerAbi, functionName: "cancelStale", args: [writer.account, nvda] }) }]) as Hex;
      const cancelledReceipt = await chain.waitForTransactionReceipt({ hash: cancelHash });
      assert.equal(cancelledReceipt.status, "success");
      const stale = parseEventLogs({ abi: autoRollerAbi, eventName: "StaleAskCancelled", logs: cancelledReceipt.logs })[0]!;
      const orderCancel = parseEventLogs({ abi: orderBookAbi, eventName: "OrderCancelled", logs: cancelledReceipt.logs })[0]!;
      assert(stale && orderCancel && orderCancel.logIndex < stale.logIndex, "OrderCancelled precedes StaleAskCancelled");
      const after = await chain.readContract({ address: roller, abi: autoRollerAbi,
        functionName: "position", args: [writer.account, nvda] });
      assert.deepEqual(after, [position[0], 0n, position[2]], "stale cancel retains the current period");
      await until("stale strategy indexed", async () => {
        const state = await json<{ strategies: { orderId: string | null; currentSeries: { longId: string } | null;
          strategy: { active: boolean }; lastStaleCancelAt: number | null; staleSpot: { raw: string } | null }[] }>(
            `/v2/accounts/${writer.account}/positions`);
        return state.strategies.some((entry) => entry.orderId === null && entry.currentSeries?.longId === String(position[0]) &&
          entry.strategy.active && entry.lastStaleCancelAt !== null && entry.staleSpot?.raw === String(stale.args.spot));
      }, 120_000);
      await writerPage.goto(`${SITE}/earn/nvda`);
      await writerPage.getByText(/Ask withdrawn/i).first().waitFor({ state: "visible", timeout: 60_000 });
      await moveSpot(series.strike, originalSpot);
      log("permissionless stale cancel indexed; writer sees withdrawn ask with current period retained");
    }

    // Schedule a real admin fee change only after all other browser trades and payout flows. The
    // change waits FEE_CHANGE_DELAY_S -- 48 hours in v8, not the 24 the v7 drill assumed -- so a
    // resting weekly-two ask has to stay open two days longer for the quote and the execution at
    // activation to prove anything at all.
    const feeTarget = seriesTag("weekly2-r0");
    const beforeFees = await chain.readContract({ address: D.contracts.orderBook, abi: orderBookAbi,
      functionName: "feeParams" });
    const nextFees = { ...beforeFees, premiumFeeBps: beforeFees.premiumFeeBps + 100,
      resaleFeeBps: beforeFees.resaleFeeBps + 100, takerFeeFlat: 1_000_000 };
    assert(nextFees.premiumFeeBps <= 1000 && nextFees.resaleFeeBps <= 1000 &&
      beforeFees.takerFeeFlat < nextFees.takerFeeFlat, "seed fees leave room for an increased schedule");
    const beforeConfig = await json<{ fees: { premiumFeeBps: number }; pendingFees: unknown }>("/v2/config");
    assert.equal(beforeConfig.pendingFees, null, "fresh acceptance fork has no pending fee change");
    assert.equal(beforeConfig.fees.premiumFeeBps, beforeFees.premiumFeeBps);
    // INVERTED: the v7 drill sent setFeeParams as a bare eth_sendTransaction from D.accounts.admin.
    // Under v8 AccessManager delays that is schedule -> warp -> execute as the impersonated Admin
    // Safe, and 06-QUIRKS.md D.8 says every devnet, rehearsal and acceptance script goes through the
    // one admin driver F8-03 landed, which reads the role and the delay from ops/abis/v2/roles.json
    // and never writes either down. Field order mirrors V2Types.FeeParams in the OrderBook ABI --
    // the order roles.json spells as setFeeParams((uint16,uint16,uint32,uint16,uint16)).
    const nextFeeArgs = [nextFees.premiumFeeBps, nextFees.resaleFeeBps, nextFees.takerFeeFlat,
      nextFees.takerFeeCapBps, nextFees.makerRebateBps];
    const feeScheduleFrom = await chain.getBlockNumber();
    await command("devnet-admin-setFeeParams", "node", [join(ROOT, "ops/v2/devnet-admin.mjs"), "OrderBook",
      "setFeeParams((uint16,uint16,uint32,uint16,uint16))", JSON.stringify(nextFeeArgs)], ROOT, devnetHelperEnv);
    // The driver prints its transactions but returns nothing to this process, so the schedule is
    // read back from the chain: exactly one FeeParamsScheduled since the driver started.
    const scheduled = await chain.getContractEvents({ address: D.contracts.orderBook, abi: orderBookAbi,
      eventName: "FeeParamsScheduled", fromBlock: feeScheduleFrom + 1n, toBlock: "latest" });
    assert.equal(scheduled.length, 1, "the admin driver scheduled exactly one fee change");
    const effectiveAt = Number(scheduled[0]!.args.effectiveAt);
    const scheduleBlock = await chain.getBlock({ blockNumber: scheduled[0]!.blockNumber });
    assert.equal(effectiveAt, Number(scheduleBlock.timestamp) + FEE_CHANGE_DELAY_S,
      "the fee change carries the full FEE_CHANGE_DELAY from the block that executed it");
    // Moved out with the delay: `effectiveAt` is now two days past the executing block, not one, so
    // a weekly series has to outlive a 48 h activation or the drill silently picks a dead series.
    assert(feeTarget.expiry > effectiveAt + 600,
      "weekly-two series remains open past the 48 h fee activation, with slack for interval mining");
    assert.deepEqual(await chain.readContract({ address: D.contracts.orderBook, abi: orderBookAbi,
      functionName: "feeParams" }), beforeFees, "scheduling did not activate fees immediately");
    const [onchainPending, onchainEffectiveAt] = await chain.readContract({ address: D.contracts.orderBook,
      abi: orderBookAbi, functionName: "pendingFeeParams" });
    assert.deepEqual(onchainPending, nextFees);
    assert.equal(Number(onchainEffectiveAt), effectiveAt);
    await until("fee schedule indexed", async () => {
      const health = await json<{ block: string }>("/v2/health");
      if (BigInt(health.block) < scheduled[0]!.blockNumber) return false;
      const config = await json<{ fees: { premiumFeeBps: number }; pendingFees: null | {
        premiumFeeBps: number; resaleFeeBps: number; takerFeeFlat: { raw: string };
        takerFeeCapBps: number; makerRebateBps: number; effectiveAt: number } }>("/v2/config");
      return config.fees.premiumFeeBps === beforeFees.premiumFeeBps &&
        config.pendingFees?.effectiveAt === effectiveAt &&
        config.pendingFees.premiumFeeBps === nextFees.premiumFeeBps &&
        config.pendingFees.resaleFeeBps === nextFees.resaleFeeBps &&
        config.pendingFees.takerFeeFlat.raw === String(nextFees.takerFeeFlat) &&
        config.pendingFees.takerFeeCapBps === nextFees.takerFeeCapBps &&
        config.pendingFees.makerRebateBps === nextFees.makerRebateBps;
    }, 120_000);
    await buyerPage.goto(`${SITE}/nvda/${feeTarget.longId}?buy=1&shares=1`);
    const feeNotice = buyerPage.getByRole("status").filter({ hasText: "Fee change scheduled" });
    await feeNotice.waitFor({ state: "visible", timeout: 60_000 });
    assert.match(await feeNotice.innerText(), /Scheduled taker fee:/);
    assert.equal(await feeNotice.locator("time").getAttribute("datetime"),
      new Date(effectiveAt * 1000).toISOString(), "ticket announces the on-chain activation time");

    // The pending-ADMIN-OPERATION notice, beside the pending-FEE notice above. They are two
    // different clocks and both must render their on-chain instant in <time datetime>: the fee
    // notice counts the OrderBook's own FEE_CHANGE_DELAY after a change was scheduled; this one
    // counts an AccessManager operation's execution delay (roles.json delaysS) before the call is
    // even sent. The waiting operation comes from the devnet, not from this file: the admin driver
    // performs schedule -> warp -> execute in a single invocation (ops/v2/lib/admin.mjs adminCall)
    // and so cannot leave one waiting, and 06-QUIRKS.md D.8 forbids hand-rolling `schedule` here.
    // X8-05's devnet leaves one scheduled and unexecuted; W8-02 renders the notice.
    const adminConfig = await json<{ contracts: { accessManager: string | null };
      pendingOperations?: { id: string; label: string; role: string; target: string; selector: string;
        caller: string; scheduledAt: number; readyAt: number }[] }>("/v2/config");
    const pendingOperations = adminConfig.pendingOperations ?? [];
    assert(pendingOperations.length > 0,
      "the devnet must leave one AccessManager operation scheduled and unexecuted so the " +
      "pending-admin-operation notice has something to announce (X8-05; the admin driver schedules, " +
      "warps and executes in one call and cannot leave one waiting)");
    const pendingOperation = pendingOperations[0]!;
    assert(adminConfig.contracts.accessManager, "a v8 devnet publishes its AccessManager in /v2/config");
    // The ETA is checked against the manager's own getSchedule, never against the API alone.
    const onchainReadyAt = Number(await chain.readContract({ address: getAddress(adminConfig.contracts.accessManager),
      abi: accessManagerAbi, functionName: "getSchedule", args: [pendingOperation.id as Hex] }));
    assert.equal(onchainReadyAt, pendingOperation.readyAt,
      "the API's pending-operation ETA is the manager's own getSchedule");
    assert(onchainReadyAt > Number((await chain.getBlock()).timestamp),
      "the announced operation is still waiting out its execution delay");
    const adminNotice = buyerPage.getByRole("status").filter({ hasText: "Admin change scheduled" });
    await adminNotice.waitFor({ state: "visible", timeout: 60_000 });
    assert((await adminNotice.innerText()).includes(pendingOperation.label),
      "the notice names the scheduled action the API reports");
    assert.equal(await adminNotice.locator("time").getAttribute("datetime"),
      new Date(onchainReadyAt * 1000).toISOString(),
      "the pending-admin notice announces the manager's own activation instant");
    log("48-hour fee schedule and a pending admin operation both announced with their on-chain instants");

    const [feeOrderIds] = await chain.readContract({ address: D.contracts.orderBook, abi: orderBookAbi,
      functionName: "ordersOfSeries", args: [BigInt(feeTarget.longId), 0n, 100n] });
    const feeOrders = await chain.readContract({ address: D.contracts.orderBook, abi: orderBookAbi,
      functionName: "getOrders", args: [feeOrderIds] });
    const feeAskIndex = feeOrders.findIndex((order) => order.kind === 2 && !order.cancelled &&
      order.units - order.filled >= 100n && Number(order.validUntil) > effectiveAt + 600);
    assert(feeAskIndex >= 0, "weekly-two seeded AskWrite remains available across fee activation");
    const feeAsk = feeOrders[feeAskIndex]!;
    const feeTaker = D.accounts.dee;
    const feeTakeBase = { longId: BigInt(feeTarget.longId), buying: true, orderIds: [feeOrderIds[feeAskIndex]!],
      units: 100n, minUnits: 100n, limitPrice: feeAsk.price, writeToSell: false, recipient: feeTaker };
    const oldQuoteParams = { ...feeTakeBase, deadline: effectiveAt + 300, maxTotalFee: MAX_UINT128 };
    const oldQuote = await chain.readContract({ account: feeTaker, address: D.contracts.orderBook,
      abi: orderBookAbi, functionName: "quoteTake", args: [oldQuoteParams] });
    assert.equal(oldQuote[0], 100n, "resting ask quotes before activation");
    const oldTake = { ...oldQuoteParams, maxTotalFee: oldQuote[2] + oldQuote[3] };

    // Keep a generous margin before the boundary so interval mining cannot race
    // the pre-activation assertion; then cross it with local Anvil time travel.
    const untilBefore = effectiveAt - 120 - Number((await chain.getBlock()).timestamp);
    assert(untilBefore > 0, "fee activation is still in the future");
    await raw("evm_increaseTime", [untilBefore]); await raw("evm_mine");
    assert(Number((await chain.getBlock()).timestamp) < effectiveAt, "old fee remains before boundary");
    assert.deepEqual(await chain.readContract({ address: D.contracts.orderBook, abi: orderBookAbi,
      functionName: "feeParams" }), beforeFees);
    const untilActive = effectiveAt - Number((await chain.getBlock()).timestamp);
    await raw("evm_increaseTime", [untilActive]); await raw("evm_mine");
    const activationBlock = await chain.getBlock();
    assert(Number(activationBlock.timestamp) >= effectiveAt, "fork crossed fee activation boundary");
    assert.deepEqual(await chain.readContract({ address: D.contracts.orderBook, abi: orderBookAbi,
      functionName: "feeParams" }), nextFees, "on-chain fees activate at the boundary");
    const [expiredPending, expiredAt] = await chain.readContract({ address: D.contracts.orderBook,
      abi: orderBookAbi, functionName: "pendingFeeParams" });
    assert.equal(Number(expiredAt), 0, "activated schedule is no longer pending on chain");
    assert.equal(expiredPending.takerFeeFlat, 0);
    await until("fee activation indexed", async () => {
      const health = await json<{ block: string }>("/v2/health");
      if (BigInt(health.block) < activationBlock.number) return false;
      const config = await json<{ fees: { premiumFeeBps: number; resaleFeeBps: number;
        takerFeeFlat: { raw: string } }; pendingFees: unknown }>("/v2/config");
      return config.pendingFees === null && config.fees.premiumFeeBps === nextFees.premiumFeeBps &&
        config.fees.resaleFeeBps === nextFees.resaleFeeBps &&
        config.fees.takerFeeFlat.raw === String(nextFees.takerFeeFlat);
    }, 120_000);
    await assert.rejects(chain.simulateContract({ account: feeTaker, address: D.contracts.orderBook,
      abi: orderBookAbi, functionName: "take", args: [oldTake] }), /FeeAboveMax/,
    "an exact fee cap rejects a take after fees increase");
    const newQuoteParams = { ...feeTakeBase, deadline: Number((await chain.getBlock()).timestamp) + 300,
      maxTotalFee: MAX_UINT128 };
    const newQuote = await chain.readContract({ account: feeTaker, address: D.contracts.orderBook,
      abi: orderBookAbi, functionName: "quoteTake", args: [newQuoteParams] });
    assert.equal(newQuote[0], oldQuote[0]);
    assert.equal(newQuote[1], oldQuote[1], "premium unchanged while the fee schedule activated");
    assert(newQuote[2] > oldQuote[2], "activated taker fee exceeds the old quote");
    const newTake = { ...newQuoteParams, maxTotalFee: newQuote[2] + newQuote[3] };
    const feeFillHash = await raw("eth_sendTransaction", [{ from: feeTaker, to: D.contracts.orderBook,
      data: encodeFunctionData({ abi: orderBookAbi, functionName: "take", args: [newTake] }) }]) as Hex;
    const feeFillReceipt = await chain.waitForTransactionReceipt({ hash: feeFillHash });
    assert.equal(feeFillReceipt.status, "success", "resting ask filled at the new fee");
    const feeFills = parseEventLogs({ abi: orderBookAbi, eventName: "Taken", logs: feeFillReceipt.logs });
    assert.equal(feeFills.length, 1);
    assert.equal(feeFills[0]!.args.units, newQuote[0]);
    assert.equal(feeFills[0]!.args.premium, newQuote[1]);
    assert.equal(feeFills[0]!.args.takerFee, newQuote[2], "execution charged the activated fee");
    log("fee activated: stale cap rejected; a resting ask filled at the new on-chain taker fee");
    assert.deepEqual(pageErrors, [], "uncaught browser errors must fail v2 acceptance");
    console.log("V2 FORK ACCEPTANCE PASSED");
  } catch (error) {
    for (const [index, page] of pages.entries()) {
      try { await page.screenshot({ path: join(OUT, `failure-${index}.png`), fullPage: true }); } catch { /* page unavailable */ }
    }
    throw error;
  } finally { await browser.close(); }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await Promise.all(live.map((child) => new Promise<void>((done) => {
    if (child.exitCode !== null) return done();
    child.once("exit", () => done());
    child.kill("SIGTERM");
    setTimeout(done, 5000).unref();
  })));
  if (originalIndexerMarkets !== null) writeFileSync(INDEXER_MARKET_FILE, originalIndexerMarkets);
  console.log(`Evidence: ${OUT}`);
});
