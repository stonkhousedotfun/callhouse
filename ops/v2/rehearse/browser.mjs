/* -------------------------------------------------------------------------------------------------
 * The rehearsal's browser flows (Playwright, headless Chromium), with the injected-wallet pieces of codex's W2-14
 * harness (web/tests/acceptance/v2.acceptance.ts: BrowserWallet, connect): the page's EIP-1193 provider forwards
 * every request to the rehearsal anvil, and only the wallet's own unlocked dev account may sign.
 *
 *   openBrowser()                      one Chromium for the run
 *   writerFlow(b, ctx)                 /earn/nvda: connect, deposit, manual AskWrite, daily auto-roll strategy
 *   buyerFlow(b, ctx)                  home: connect, "Buy 0.01 share" card -> ticket -> Buy now
 *   resultsFlow(b, ctx)                /wins, /leaderboard, /pnl/<id>, the PNL image route, a winner's Portfolio
 * Each saves screenshots into out/screenshots and returns the transactions the page sent.
 * ------------------------------------------------------------------------------------------------- */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ABI, ROOT, RPC, SHOTS, WEB_URL, fail, info, pub, until, viem } from "./lib.mjs";

const { chromium } = createRequire(path.join(ROOT, "web", "package.json"))("playwright-core");
const { decodeFunctionData, getAddress, toHex } = viem;

async function raw(method, params = []) {
  const response = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** W2-14's BrowserWallet: an injected provider (EIP-1193 + EIP-6963 announce) backed by one unlocked dev account. */
export class BrowserWallet {
  constructor(account, label) {
    this.account = getAddress(account);
    this.label = label;
    this.calls = [];
    this.authorised = false;
  }
  async attach(context) {
    await context.exposeBinding("__v2AcceptanceWallet", async (_source, method, params) => {
      try {
        return { result: await this.request(method, Array.isArray(params) ? params : []) };
      } catch (error) {
        return { error: { code: -32603, message: String(error?.message ?? error) } };
      }
    });
    await context.addInitScript({ content: `(() => {
      const listeners = new Map();
      const provider = {
        isMetaMask: true, isPhantom: true, isCallhouseAcceptanceWallet: true,
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
  async request(method, params) {
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
      const tx = params[0];
      if (getAddress(tx.from) !== this.account) throw new Error("page requested another signing account");
      if (!tx.to) throw new Error("page requested a deployment");
      const hash = await raw(method, params);
      const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 250, timeout: 120_000 });
      const data = tx.data ?? tx.input;
      let name = "unknown";
      if (data && data !== "0x") {
        for (const abi of [ABI.clearinghouse, ABI.orderBook, ABI.autoRoller, ABI.erc20]) {
          try {
            name = decodeFunctionData({ abi, data }).functionName;
            break;
          } catch {
            /* another ABI */
          }
        }
      }
      this.calls.push({ name, to: getAddress(tx.to), hash, status: receipt.status, gasUsed: receipt.gasUsed.toString(), block: Number(receipt.blockNumber) });
      if (receipt.status !== "success") throw new Error(`${name} reverted: ${hash}`);
      return hash;
    }
    return raw(method, params);
  }
  async signed(name, from, timeoutMs = 120_000) {
    await until(`${this.label}: ${name} wallet transaction`, async () => this.calls.slice(from).some((c) => c.name === name), { timeoutMs, intervalMs: 500 });
    return this.calls.slice(from).find((c) => c.name === name);
  }
}

export async function openBrowser() {
  return chromium.launch({ headless: process.env.REHEARSE_HEADFUL !== "1" });
}

async function newPage(browser, wallet, { mobile = false } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  await wallet.attach(context);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`${page.url()}: ${e.message}`));
  // The fork's clock runs ahead of the host after warps: deadlines and countdowns in the page follow the chain.
  await page.clock.setFixedTime(new Date(Number((await pub.getBlock()).timestamp) * 1000));
  return { context, page, errors };
}

async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  info(`screenshot ${path.relative(ROOT, file)}`);
  return file;
}

/** W2-14's connect: header Connect -> Phantom (the injected provider), until the header shows the account. */
async function connect(page, wallet) {
  await page.locator("header").getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator("header").getByRole("button", { name: "Phantom", exact: true }).click();
  await until(`${wallet.label} wallet connection`, async () => (await page.locator("header").innerText()).toLowerCase().includes(wallet.account.slice(0, 6).toLowerCase()), { timeoutMs: 30_000, intervalMs: 500 });
}

/**
 * Writer on /earn/nvda: deposit `depositShares` NVDA, a manual AskWrite (`ask`: expiry, longId, shares, price in
 * USDG per share), and a DAILY auto-roll strategy (`roll`: otmBps, askBps, maxShares, minAskBps, maxAskBps).
 */
export async function writerFlow(browser, { wallet, depositShares, ask, roll }) {
  const { page, errors } = await newPage(browser, wallet);
  await page.goto(`${WEB_URL}/earn/nvda`);
  await connect(page, wallet);
  await shot(page, "3-writer-1-earn-connected");
  await page.locator("#writer-deposit").fill(String(depositShares));
  let n = wallet.calls.length;
  await page.getByRole("region", { name: "Writer balance" }).getByRole("button", { name: "Deposit" }).click();
  const deposit = await wallet.signed("deposit", n);
  await shot(page, "3-writer-2-deposited");
  const region = page.getByRole("region", { name: "Manual ask" });
  await region.getByLabel("Expiry").selectOption(String(ask.expiry));
  await region.getByLabel("Strike").selectOption(ask.longId);
  await region.getByLabel("Size in shares").fill(ask.shares);
  await region.getByLabel("Your price / share · USDG").fill(ask.price);
  n = wallet.calls.length;
  await region.getByRole("button", { name: "Place AskWrite order" }).click();
  const place = await wallet.signed("place", n);
  await shot(page, "3-writer-3-manual-ask");
  const r = page.getByRole("region", { name: "Auto-roll strategy" });
  const action = r.getByRole("button", { name: /Enable auto-roll|Update strategy/ });
  await action.waitFor({ state: "visible", timeout: 60_000 });
  await r.getByLabel("Cycle").selectOption("daily");
  await r.getByLabel("Strike above spot · bps").fill(String(roll.otmBps));
  await r.getByLabel("Ask · bps of spot").fill(String(roll.askBps));
  await r.getByLabel("Max size · shares").fill(String(roll.maxShares));
  const smart = r.getByLabel("Smart pricing within my limits");
  if (!(await smart.isChecked())) await smart.check();
  await r.getByLabel("Minimum ask · bps").fill(String(roll.minAskBps));
  await r.getByLabel("Maximum ask · bps").fill(String(roll.maxAskBps));
  await shot(page, "3-writer-4-auto-roll-form");
  n = wallet.calls.length;
  await action.click();
  const strategy = await wallet.signed("setStrategy", n, 240_000);
  await shot(page, "3-writer-5-auto-roll-enabled");
  await page.context().close();
  if (errors.length) fail(`writer page errors: ${errors.join("; ")}`);
  return { deposit, place, strategy, calls: wallet.calls };
}

/** Why a ticket stopped a trade, from the page's own notice. */
async function stopReason(page) {
  const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
  const m = /Trade stopped\s*(.{0,200})/.exec(text);
  return m ? m[1].trim() : `no notice; ticket reads: ${text.slice(0, 200)}`;
}

/**
 * "Buy now" on an open ticket until the wallet is asked to sign a take. The ticket rechecks its selected asks on
 * chain and stops the trade when one changed — the MM bot replaces its quotes every tick, so an ask the page chose
 * seconds earlier can be gone — and then refreshes its own quote, which the next attempt buys.
 */
async function buyFromTicket(page, wallet, stoppedShot, attempts = 3) {
  const from = wallet.calls.length;
  const button = page.locator("#ticket").getByRole("button", { name: "Buy now", exact: true }).last();
  let stopped = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await button.click();
    const take = await wallet.signed("take", from, 45_000).catch(() => null);
    if (take) return take;
    stopped = await stopReason(page);
    info(`buy attempt ${attempt} of ${attempts}: the ticket sent no take (${stopped}); trying the quote it refreshed`);
    await page.waitForTimeout(5_000);
  }
  await shot(page, stoppedShot);
  return fail(`ticket sent no take in ${attempts} attempts (${stopped})`);
}

/**
 * Buyer on the home page: the first "Buy 0.01 share" card, keyboard into the ticket, Buy now.
 *
 * The page is opened with the feeds as they stand — on 4663 the round in force is normally hours old — so a card that
 * offers the buy here is evidence that the cards judge a quote against the oracle's spot age. When no card offers it,
 * `onStale()` (the price operator printing a round, W2-14's workaround) runs, the page reloads and the flow records
 * what the cards said. Returns { natural, notice, longId, take, calls }.
 */
export async function buyerFlow(browser, { wallet, onStale }) {
  const { page, errors } = await newPage(browser, wallet, { mobile: true });
  await page.goto(WEB_URL);
  await connect(page, wallet);
  await page.getByText(/max loss/i).first().waitFor({ state: "visible", timeout: 60_000 });
  await shot(page, "3-buyer-1-home-cards");
  const cardOf = () => page.getByRole("link", { name: "Buy 0.01 share", exact: true }).first();
  let card = cardOf();
  let natural = await card.waitFor({ state: "visible", timeout: 45_000 }).then(() => true, () => false);
  let notice = null;
  if (!natural) {
    const text = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    notice = /Quote is stale/.test(text) ? "Quote is stale. Refreshing before a trade." : text.slice(0, 300);
    info(`home cards: no "Buy 0.01 share" with the feed as it stands ("${notice}") — printing a round and reloading`);
    await shot(page, "3-buyer-1b-cards-not-buyable");
    if (!onStale) fail('buyer page: no "Buy 0.01 share" card and no onStale workaround');
    await onStale();
    await page.reload();
    await page.getByText(/max loss/i).first().waitFor({ state: "visible", timeout: 60_000 });
    card = cardOf();
    await card.waitFor({ state: "visible", timeout: 60_000 });
    await shot(page, "3-buyer-1-home-cards");
  }
  await card.focus();
  await page.keyboard.press("Enter");
  await page.locator("#ticket-shares").waitFor({ state: "visible", timeout: 60_000 });
  const longId = new URL(page.url()).pathname.split("/")[2];
  await shot(page, "3-buyer-2-ticket");
  const take = await buyFromTicket(page, wallet, "3-buyer-3-buy-stopped");
  await shot(page, "3-buyer-3-bought");
  await page.context().close();
  if (errors.length) fail(`buyer page errors: ${errors.join("; ")}`);
  return { longId, take, calls: wallet.calls, natural, notice };
}

/**
 * Step 4's indexer-down drill on a series page (/<ticker>/<longId>): the page loads with the indexer up; `stopIndexer()`
 * then stops Ponder for real, and the page must rebuild the book from on-chain orders and still buy 0.01 share.
 *
 * When the ticket keeps Buy disabled with the indexer down (a web issue: its live spot comes only from /v2/markets), the
 * flow records that, then applies the HARNESS WORKAROUND so the on-chain-book buy path is still exercised end to end:
 * the browser alone gets a /v2/markets answer (the response captured while the indexer was up, `marketsJson`) and every
 * other indexer request still fails (the port is closed). Returns { natural, issue, take, shots }.
 */
export async function outageBuyFlow(browser, { wallet, ticker, longId, indexerUrl, marketsJson, stopIndexer }) {
  const { context, page, errors } = await newPage(browser, wallet);
  const shots = [];
  let mode = "live";
  const origin = new URL(indexerUrl).origin;
  await context.route(`${origin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (mode === "markets-only" && url.pathname === "/v2/markets") {
      await route.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(marketsJson) });
      return;
    }
    await route.continue().catch(() => undefined);
  });
  await page.goto(`${WEB_URL}/${ticker.toLowerCase()}/${longId}`);
  await connect(page, wallet);
  const buy = page.locator("#ticket").getByRole("button", { name: "Buy now", exact: true }).last();
  await buy.waitFor({ state: "visible", timeout: 90_000 });
  const enabledWithin = async (ms) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await buy.isEnabled().catch(() => false)) return true;
      await page.waitForTimeout(1_000);
    }
    return false;
  };
  if (!(await enabledWithin(90_000))) fail("indexer-down drill: Buy now is not enabled even with the indexer up");
  shots.push(await shot(page, "4-indexer-down-1-series-live"));

  await stopIndexer();
  mode = "down";
  await until("the series page rebuilds the book from on-chain orders", async () => {
    const text = await page.locator("body").innerText();
    return /rebuilt on chain/.test(text) && /Indexer book unavailable/.test(text);
  }, { timeoutMs: 120_000, intervalMs: 1_000 });
  shots.push(await shot(page, "4-indexer-down-2-book-rebuilt-on-chain"));

  // Give every indexer query (15 s refetch, three retries) time to fail before judging the ticket.
  const natural = await enabledWithin(45_000);
  let issue = null;
  if (!natural) {
    const text = await page.locator("body").innerText();
    issue = /Live spot is unavailable/.test(text)
      ? "with the indexer down the ticket keeps Buy disabled: 'Live spot is unavailable for this market. New buys and bids are paused until the feed recovers.' (spot comes only from /v2/markets although SettlementOracle.trySpot is ok on chain)"
      : `with the indexer down the ticket keeps Buy disabled (no spot notice; page text: ${text.replace(/\s+/g, " ").slice(0, 300)})`;
    shots.push(await shot(page, "4-indexer-down-3-buy-disabled"));
    mode = "markets-only";
    if (!(await enabledWithin(90_000))) fail("indexer-down drill: Buy now stays disabled even with /v2/markets answered (workaround)");
  }
  // The page's clock was fixed at chain time when it opened; the ticket's take deadline is measured from it.
  await page.clock.setFixedTime(new Date(Number((await pub.getBlock()).timestamp) * 1000));
  await page.waitForTimeout(1_500);
  const take = await buyFromTicket(page, wallet, "4-indexer-down-4-buy-stopped");
  await page.waitForTimeout(1_500);
  shots.push(await shot(page, "4-indexer-down-4-bought-on-chain-book"));
  await context.close();
  return { natural, issue, take, shots, pageErrors: errors };
}

/** Read-only pages after settlement, plus the PNL image route's bytes. */
export async function resultsFlow(browser, { winner, pnlId }) {
  const { page, errors } = await newPage(browser, winner);
  const shots = [];
  await page.goto(`${WEB_URL}/wins`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  shots.push(await shot(page, "3-results-1-wins"));
  await page.goto(`${WEB_URL}/leaderboard`);
  await page.waitForLoadState("networkidle").catch(() => undefined);
  shots.push(await shot(page, "3-results-2-leaderboard"));
  await page.goto(`${WEB_URL}/pnl/${pnlId}`);
  await page.getByText("Paid → value received", { exact: true }).waitFor({ state: "visible", timeout: 60_000 }).catch(() => undefined);
  shots.push(await shot(page, "3-results-3-pnl-page"));
  const image = await fetch(`${WEB_URL}/api/pnl/${pnlId}/image`);
  const bytes = Buffer.from(await image.arrayBuffer());
  const imageFile = path.join(SHOTS, "3-results-4-pnl-image.png");
  writeFileSync(imageFile, bytes);
  info(`PNL image ${image.status} ${image.headers.get("content-type")} ${bytes.length} bytes -> ${path.relative(ROOT, imageFile)}`);
  await page.goto(`${WEB_URL}/portfolio`);
  await connect(page, winner);
  await page.getByRole("button", { name: "History" }).click().catch(() => undefined);
  await page.waitForTimeout(2_000);
  shots.push(await shot(page, "3-results-5-winner-portfolio-history"));
  await page.context().close();
  return { shots, image: { status: image.status, contentType: image.headers.get("content-type"), bytes: bytes.length, file: imageFile, png: bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }, errors };
}
