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
import { createPublicClient, decodeFunctionData, encodeAbiParameters, encodeFunctionData, formatUnits, getAddress, http, keccak256, pad, parseEventLogs, toHex,
  type Address, type Hex } from "viem";

import { clearinghouseAbi } from "../../lib/abi/v2/clearinghouse";
import { orderBookAbi } from "../../lib/abi/v2/orderBook";
import { autoRollerAbi } from "../../lib/abi/v2/autoRoller";
import { settlementOracleAbi } from "../../lib/abi/v2/settlementOracle";

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
    functionName: "supportsInterface", args: ["0xf9e1eb5d"] }), true, "browser acceptance requires v7 interface ID");
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

    // The landing card is the entry point; activation must focus the ticket for keyboard users.
    await buyerPage.goto(SITE);
    await connect(buyerPage, buyer);
    await buyerPage.getByText(/max loss/i).first().waitFor({ state: "visible" });
    const firstBuy = buyerPage.getByRole("link", { name: "Buy 0.01 share", exact: true }).first();
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
    const resaleParams = { longId: BigInt(cardId), buying: true, orderIds: [resaleId], units: 1n,
      minUnits: 1n, limitPrice: resaleOrder.price, writeToSell: false, recipient: resaleBuyer,
      deadline: Number((await chain.getBlock()).timestamp) + 300 };
    const [quotedUnits, quotedPremium, quotedFee] = await chain.readContract({ account: resaleBuyer,
      address: D.contracts.orderBook, abi: orderBookAbi, functionName: "quoteTake", args: [resaleParams] });
    assert.equal(quotedUnits, 1n, "listed resale is fillable by another wallet");
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
      assert(await action.isEnabled(), "auto-roll action is disabled on a configured devnet");
      const nRoll = writer.calls.length;
      await action.click();
      const strategyTx = await writer.signed("setStrategy", nRoll);
      assert.equal(strategyTx.to, getAddress(D.contracts.autoRoller), "strategy sent to configured AutoRoller");
      const strategy = await chain.readContract({ address: D.contracts.autoRoller, abi: autoRollerAbi,
        functionName: "strategy", args: [writer.account, nvda] });
      assert(strategy.active, "writer strategy should be active on chain");
      log("auto-roll strategy active on chain");
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
    assert(rents.length >= 2 && rents.every((event) => event.args.fee > 0n),
      "each primary fill charges its own nonzero rounded rent");
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
      const fallbackRents = parseEventLogs({ abi: clearinghouseAbi, eventName: "Minted", logs: fallbackReceipt.logs });
      assert(fallbackRents.length > 0 && fallbackRents.every((event) => event.args.fee > 0n),
        "chain fallback purchase charges nonzero writer rent");
      assert.equal(await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "balanceOf", args: [buyer.account, BigInt(target.longId)] }), beforeFallback + 1n,
      "fallback quote filled exactly one unit");
      log("indexer book outage: chain snapshot fallback bought one unit with writer rent");
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

    // Eve's seeded 1-unit ITM long was intentionally left unredeemed. Choose an
    // in-kind payout in the real Portfolio, collect it there, and reconcile the
    // wallet balance and indexed redemption with the chain receipt.
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
    log("Portfolio in-kind preference and Collect paid Stock Tokens, with indexed redemption history");

    let homeNavigationMs = 0;
    for (const theme of ["light", "dark"] as const) {
      await buyerPage.emulateMedia({ colorScheme: theme });
      const navigationStart = Date.now();
      await buyerPage.goto(SITE);
      homeNavigationMs = Date.now() - navigationStart;
      await buyerPage.getByRole("heading", { name: /money|upside/i }).waitFor({ state: "visible" });
      const ratio = await contrast(buyerPage, "#marketplace-title");
      assert(ratio >= 4.5, `${theme} hero contrast ${ratio.toFixed(2)}:1`);
      const overflow = await buyerPage.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      assert(overflow <= 1, `${theme} 390px horizontal overflow ${overflow}px`);
      const cards = await buyerPage.locator("#options article").count();
      assert(cards <= 200, `marketplace rendered ${cards} cards; page limit is 200`);
      log(`${theme}: hero contrast ${ratio.toFixed(2)}:1, mobile overflow ${overflow}px, ${cards} cards`);
    }
    const navigationResponseMs = await buyerPage.evaluate(() => {
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      return navigation ? navigation.responseEnd - navigation.startTime : null;
    });
    const responseMs = navigationResponseMs ?? homeNavigationMs;
    assert(Number.isFinite(responseMs) && responseMs < 15_000, "local home response exceeded 15s");
    log(`local home response ${responseMs.toFixed(0)}ms`);

    // V7 rent is in the collateral asset. Exercise actual Portfolio closes for a
    // one-unit call and put, then compare the native ledger and indexed history.
    const rentTemplate = await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
      functionName: "series", args: [BigInt(seriesTag("weekly2-r0").longId)] });
    const sendRentTx = async (to: Address, data: Hex) => {
      const hash = await raw("eth_sendTransaction", [{ from: writer.account, to, data }]) as Hex;
      const result = await chain.waitForTransactionReceipt({ hash });
      assert.equal(result.status, "success", "local v7 lifecycle transaction confirmed");
      return result;
    };
    const rentDenominator = 1_000_000n * 604_800n;
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
      assert(terms.mintFeePpm > 0, "rent lifecycle series pins a nonzero rate");
      const collateral = isPut ? terms.strike / 100n : 10n ** 16n;
      const deposit = collateral * 2n;
      if (await tokenBalance(asset, writer.account) < deposit) await deal(asset, writer.account, deposit * 2n);
      await sendRentTx(asset, encodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable",
        inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }] as const,
      functionName: "approve", args: [D.contracts.clearinghouse, deposit] }));
      await sendRentTx(D.contracts.clearinghouse, encodeFunctionData({ abi: clearinghouseAbi,
        functionName: "deposit", args: [asset, deposit, writer.account] }));
      const freeBeforeMint = await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "free", args: [writer.account, asset] });
      const mintedReceipt = await sendRentTx(D.contracts.clearinghouse, encodeFunctionData({ abi: clearinghouseAbi,
        functionName: "mint", args: [id, 1n, writer.account, writer.account] }));
      const minted = parseEventLogs({ abi: clearinghouseAbi, eventName: "Minted", logs: mintedReceipt.logs })[0]!;
      assert(minted, "one-unit mint emits the v7 event");
      const mintBlock = await chain.getBlock({ blockHash: mintedReceipt.blockHash });
      const mintNumerator = collateral * BigInt(terms.mintFeePpm) * (BigInt(terms.expiry) - mintBlock.timestamp);
      assert.equal(minted.args.fee, (mintNumerator + rentDenominator - 1n) / rentDenominator,
        "one-unit rent rounds up exactly once");
      assert(minted.args.fee > 0n);
      const freeAfterMint = await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "free", args: [writer.account, asset] });
      assert.equal(freeBeforeMint - freeAfterMint, collateral + minted.args.fee,
        `${isPut ? "put USDG" : "call Stock Token"} ledger debits collateral plus rent`);
      await until("v7 mint rent indexed", async () => {
        const history = await json<{ items: { kind: string; longId: string | null;
          data: { tx?: string; fee?: { raw: string; decimals: number } } }[] }>(
          `/v2/accounts/${writer.account}/history?limit=100`);
        return history.items.some((item) => item.kind === "mint" && item.longId === String(id) &&
          item.data.tx === mintedReceipt.transactionHash && item.data.fee?.raw === String(minted.args.fee) &&
          item.data.fee.decimals === decimals);
      }, 120_000);
      await until("v7 mint API free balance and held rent", () =>
        apiRentStateMatches(freeAfterMint, terms.mintFeesHeld + minted.args.fee), 120_000);
      await writerPage.goto(`${SITE}/portfolio`);
      const shortCard = writerPage.locator("article").filter({ has: writerPage.locator(`input[id="buyback-size-${id}"]`) });
      await shortCard.getByLabel("Size to close in shares").fill("0.01");
      assert.match(await shortCard.innerText(), /rent/i, "writer economics disclose native-asset rent");
      const nClose = writer.calls.length;
      await shortCard.getByRole("button", { name: "Close matched units", exact: true }).click();
      const closeTx = await writer.signed("close", nClose);
      const closedReceipt = await chain.getTransactionReceipt({ hash: closeTx.hash });
      const closed = parseEventLogs({ abi: clearinghouseAbi, eventName: "Closed", logs: closedReceipt.logs })[0]!;
      assert(closed && closed.args.longId === id && closed.args.units === 1n);
      const closeBlock = await chain.getBlock({ blockHash: closedReceipt.blockHash });
      const refund = collateral * BigInt(terms.mintFeePpm) * (BigInt(terms.expiry) - closeBlock.timestamp) / rentDenominator;
      assert.equal(closed.args.feeRefund, refund, "unused rent refund rounds down");
      assert(refund > 0n && refund <= minted.args.fee, "close refunds unused rent without paying more than charged");
      assert.equal(await chain.readContract({ address: D.contracts.clearinghouse, abi: clearinghouseAbi,
        functionName: "free", args: [writer.account, asset] }), freeAfterMint + collateral + refund,
      "Portfolio close credits collateral plus refund to the closer");
      await until("v7 close refund indexed", async () => {
        const history = await json<{ items: { kind: string; longId: string | null;
          data: { tx?: string; feeRefund?: { raw: string; decimals: number } } }[] }>(
          `/v2/accounts/${writer.account}/history?limit=100`);
        return history.items.some((item) => item.kind === "close" && item.longId === String(id) &&
          item.data.tx === closeTx.hash && item.data.feeRefund?.raw === String(refund) && item.data.feeRefund.decimals === decimals);
      }, 120_000);
      await until("v7 close API free balance and held rent", () =>
        apiRentStateMatches(freeAfterMint + collateral + refund, terms.mintFeesHeld + minted.args.fee - refund), 120_000);
      log(`${isPut ? "put USDG" : "call Stock Token"}: one-unit mint rent, browser close refund and indexed history verified`);
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

    // Schedule a real admin fee change only after all other browser trades and
    // payout flows. The change waits 24 hours; a resting weekly-two ask remains
    // open so we can prove that quote and execution use the new fee at activation.
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
    const scheduleHash = await raw("eth_sendTransaction", [{ from: D.accounts.admin, to: D.contracts.orderBook,
      data: encodeFunctionData({ abi: orderBookAbi, functionName: "setFeeParams", args: [nextFees] }) }]) as Hex;
    const scheduleReceipt = await chain.waitForTransactionReceipt({ hash: scheduleHash });
    assert.equal(scheduleReceipt.status, "success", "admin fee schedule confirmed");
    const scheduled = parseEventLogs({ abi: orderBookAbi, eventName: "FeeParamsScheduled",
      logs: scheduleReceipt.logs });
    assert.equal(scheduled.length, 1, "one fee schedule event");
    const effectiveAt = Number(scheduled[0]!.args.effectiveAt);
    const scheduleBlock = await chain.getBlock({ blockNumber: scheduleReceipt.blockNumber });
    assert.equal(effectiveAt, Number(scheduleBlock.timestamp) + 86_400, "fee change has a full 24-hour delay");
    assert(feeTarget.expiry > effectiveAt + 600, "weekly-two series remains open after activation");
    assert.deepEqual(await chain.readContract({ address: D.contracts.orderBook, abi: orderBookAbi,
      functionName: "feeParams" }), beforeFees, "scheduling did not activate fees immediately");
    const [onchainPending, onchainEffectiveAt] = await chain.readContract({ address: D.contracts.orderBook,
      abi: orderBookAbi, functionName: "pendingFeeParams" });
    assert.deepEqual(onchainPending, nextFees);
    assert.equal(Number(onchainEffectiveAt), effectiveAt);
    await until("fee schedule indexed", async () => {
      const health = await json<{ block: string }>("/v2/health");
      if (BigInt(health.block) < scheduleReceipt.blockNumber) return false;
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
    log("24-hour fee schedule indexed and visible on the trade ticket");

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
    const oldTake = { ...feeTakeBase, deadline: effectiveAt - 1 };
    const oldQuote = await chain.readContract({ account: feeTaker, address: D.contracts.orderBook,
      abi: orderBookAbi, functionName: "quoteTake", args: [oldTake] });
    assert.equal(oldQuote[0], 100n, "resting ask quotes before activation");

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
      abi: orderBookAbi, functionName: "take", args: [oldTake] }), /DeadlinePassed/,
    "a take quoted under old fees cannot execute after activation");
    const newTake = { ...feeTakeBase, deadline: Number((await chain.getBlock()).timestamp) + 300 };
    const newQuote = await chain.readContract({ account: feeTaker, address: D.contracts.orderBook,
      abi: orderBookAbi, functionName: "quoteTake", args: [newTake] });
    assert.equal(newQuote[0], oldQuote[0]);
    assert.equal(newQuote[1], oldQuote[1], "premium unchanged while the fee schedule activated");
    assert(newQuote[2] > oldQuote[2], "activated taker fee exceeds the old quote");
    const feeFillHash = await raw("eth_sendTransaction", [{ from: feeTaker, to: D.contracts.orderBook,
      data: encodeFunctionData({ abi: orderBookAbi, functionName: "take", args: [newTake] }) }]) as Hex;
    const feeFillReceipt = await chain.waitForTransactionReceipt({ hash: feeFillHash });
    assert.equal(feeFillReceipt.status, "success", "resting ask filled at the new fee");
    const feeFills = parseEventLogs({ abi: orderBookAbi, eventName: "Taken", logs: feeFillReceipt.logs });
    assert.equal(feeFills.length, 1);
    assert.equal(feeFills[0]!.args.units, newQuote[0]);
    assert.equal(feeFills[0]!.args.premium, newQuote[1]);
    assert.equal(feeFills[0]!.args.takerFee, newQuote[2], "execution charged the activated fee");
    log("fee activated: stale take rejected; a resting ask filled at the new on-chain taker fee");
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
