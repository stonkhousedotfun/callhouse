/**
 * W3-402: notification settings in a real browser against the already-running LOCAL rehearsal.
 *
 * This file deliberately does not start the rehearsal, provision Postgres, or contact Telegram.
 * Its three service origins must be supplied explicitly and must resolve to loopback hosts:
 *
 *   NOTIFICATIONS_ACCEPTANCE_WEB_URL=http://127.0.0.1:<web-port>
 *   NOTIFICATIONS_ACCEPTANCE_NOTIFIER_URL=http://127.0.0.1:<notifier-port>
 *   NOTIFICATIONS_ACCEPTANCE_TELEGRAM_CONTROL_URL=http://127.0.0.1:<fake-telegram-port>
 *   NOTIFICATIONS_ACCEPTANCE_TELEGRAM_BOT_TOKEN=4663002:rehearsal-notifier-bot-token
 *
 * The run injects one EIP-1193/EIP-6963 wallet, creates exactly one signed notifier session,
 * links Telegram only through fake-telegram.mjs's control API, changes a toggle, adds and removes
 * a live NVDA price alert, and deletes the subscription. Every transition is checked in both the
 * rendered page and the notifier API; Telegram linking is also checked in the fake Bot API log.
 * Web Push is never selected or requested.
 */
import assert from "node:assert/strict";

import { chromium, type BrowserContext, type Locator, type Page, type Request } from "playwright-core";
import { keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const CHAIN_ID = 4663;
const ADDRESS = privateKeyToAccount(keccak256(toHex(`callhouse:w3-402:${process.pid}:${Date.now()}`)));
const CHAT_ID = String(7_402_000 + (process.pid % 1_000));
const HEADFUL = process.env.NOTIFICATIONS_ACCEPTANCE_HEADFUL === "1";

function requiredLoopbackOrigin(name: string): string {
  const raw = process.env[name]?.trim();
  assert(raw, `${name} is required; W3-402 never guesses a rehearsal endpoint`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  assert(url.protocol === "http:" || url.protocol === "https:", `${name} must use http or https`);
  assert(LOOPBACK_HOSTS.has(url.hostname), `${name} must use localhost, 127.0.0.1, or [::1], not ${url.hostname}`);
  assert(url.username === "" && url.password === "", `${name} must not carry credentials`);
  assert((url.pathname === "" || url.pathname === "/") && !url.search && !url.hash, `${name} must be an origin with no path, query, or hash`);
  return url.origin;
}

const WEB_ORIGIN = requiredLoopbackOrigin("NOTIFICATIONS_ACCEPTANCE_WEB_URL");
const NOTIFIER_ORIGIN = requiredLoopbackOrigin("NOTIFICATIONS_ACCEPTANCE_NOTIFIER_URL");
const TELEGRAM_CONTROL_ORIGIN = requiredLoopbackOrigin("NOTIFICATIONS_ACCEPTANCE_TELEGRAM_CONTROL_URL");
const TELEGRAM_BOT_TOKEN = process.env.NOTIFICATIONS_ACCEPTANCE_TELEGRAM_BOT_TOKEN?.trim();
assert(TELEGRAM_BOT_TOKEN, "NOTIFICATIONS_ACCEPTANCE_TELEGRAM_BOT_TOKEN is required for the local fake Bot API");

function isLoopbackRequest(raw: string): boolean {
  const url = new URL(raw);
  return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname);
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function until<T>(label: string, probe: () => Promise<T | null>, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value !== null) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`${label} did not become true before timeout${lastError === undefined ? "" : `: ${String(lastError)}`}`);
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  assert(isLoopbackRequest(url), `refusing non-local harness request ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(8_000), ...init });
  const text = await response.text();
  assert(response.ok, `${init?.method ?? "GET"} ${url} returned ${response.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

type ProviderReply = { result?: unknown; error?: { code: number; message: string; data?: unknown } };

class AcceptanceWallet {
  authorised = false;
  signatureCount = 0;

  async attach(context: BrowserContext): Promise<void> {
    await context.exposeBinding("__notificationsAcceptanceWallet", async (_source, method: string, params: unknown) =>
      this.handle(method, Array.isArray(params) ? params : []),
    );
    await context.addInitScript({ content: injectedProviderSource() });
  }

  private async handle(method: string, params: unknown[]): Promise<ProviderReply> {
    try {
      switch (method) {
        case "eth_requestAccounts":
        case "wallet_requestPermissions":
          this.authorised = true;
          return { result: method === "eth_requestAccounts" ? [ADDRESS.address] : [{ parentCapability: "eth_accounts" }] };
        case "eth_accounts":
          return { result: this.authorised ? [ADDRESS.address] : [] };
        case "wallet_getPermissions":
          return { result: this.authorised ? [{ parentCapability: "eth_accounts" }] : [] };
        case "wallet_revokePermissions":
          this.authorised = false;
          return { result: null };
        case "eth_chainId":
          return { result: toHex(CHAIN_ID) };
        case "net_version":
          return { result: String(CHAIN_ID) };
        case "wallet_switchEthereumChain": {
          const requested = Number((params[0] as { chainId?: string } | undefined)?.chainId ?? "0");
          return requested === CHAIN_ID
            ? { result: null }
            : { error: { code: 4902, message: `chain ${requested} is not the rehearsal wallet's chain` } };
        }
        case "personal_sign": {
          const raw = params[0];
          const requestedAddress = String(params[1] ?? "").toLowerCase();
          assert.equal(requestedAddress, ADDRESS.address.toLowerCase(), "personal_sign requested for another address");
          assert(typeof raw === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(raw), "personal_sign message is not hex bytes");
          this.signatureCount += 1;
          return { result: await ADDRESS.signMessage({ message: { raw: raw as Hex } }) };
        }
        case "eth_sign": {
          const requestedAddress = String(params[0] ?? "").toLowerCase();
          const raw = params[1];
          assert.equal(requestedAddress, ADDRESS.address.toLowerCase(), "eth_sign requested for another address");
          assert(typeof raw === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(raw), "eth_sign message is not hex bytes");
          this.signatureCount += 1;
          return { result: await ADDRESS.signMessage({ message: { raw: raw as Hex } }) };
        }
        case "eth_sendTransaction":
          return { error: { code: 4100, message: "W3-402 refuses every transaction; notifications require message signing only" } };
        default:
          return { error: { code: 4200, message: `W3-402 wallet does not support ${method}` } };
      }
    } catch (error) {
      return { error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
    }
  }
}

function injectedProviderSource(): string {
  return `(() => {
  const listeners = new Map();
  const provider = {
    isMetaMask: true,
    isCallhouseNotificationsAcceptanceWallet: true,
    async request(req) {
      const out = await window.__notificationsAcceptanceWallet(req.method, req.params === undefined ? [] : req.params);
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
      uuid: "f4020000-0000-4000-8000-000000000402",
      name: "MetaMask",
      icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiLz4=",
      rdns: "io.metamask",
    }),
    provider,
  });
  const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
  window.addEventListener("eip6963:requestProvider", announce);
  announce();
})();`;
}

type RequestEvidence = { method: string; path: string; body: string | null };
type AlertPrefs = {
  strikeCross: boolean;
  expiry24h: boolean;
  expiry1h: boolean;
  settlement: boolean;
  fills: boolean;
  writerItmWarning: boolean;
  autoRoll: boolean;
  priceAlerts: Array<{ ticker: string; above?: string; below?: string }>;
};
type Subscription = { id: string; channel: string; status: string; prefs: AlertPrefs };
type TelegramMessage = { n: number; bot: string; chatId: string; text: string };

function pathOf(request: Request): string {
  const url = new URL(request.url());
  return `${url.pathname}${url.search}`;
}

async function waitForNotifierResponse(page: Page, method: string, pathname: string, action: () => Promise<void>): Promise<void> {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === NOTIFIER_ORIGIN && url.pathname === pathname && response.request().method() === method;
  });
  await action();
  const response = await responsePromise;
  assert(response.status() >= 200 && response.status() < 300, `${method} ${pathname} returned ${response.status()}`);
}

async function waitForStatus(page: Page, text: string): Promise<void> {
  await page.getByRole("status").filter({ hasText: text }).last().waitFor({ state: "visible" });
}

async function clickWhenEnabled(locator: Locator): Promise<void> {
  await until("button enabled", async () => (await locator.isEnabled()) ? true : null);
  await locator.click();
}

async function main(): Promise<void> {
  const health = await json<{ database?: string; channels?: { telegram?: string }; telegramBot?: string }>(`${NOTIFIER_ORIGIN}/health`);
  assert.equal(health.database, "ok", "notifier database is not ready");
  assert.notEqual(health.channels?.telegram, "off", "notifier Telegram channel is off");
  assert.equal(health.telegramBot, "ok", "notifier has not authenticated to the fake Telegram API");
  assert.equal((await json<{ ok?: boolean }>(`${TELEGRAM_CONTROL_ORIGIN}/health`)).ok, true, "fake Telegram control API is not ready");

  const browser = await chromium.launch({ headless: !HEADFUL });
  const context = await browser.newContext({ serviceWorkers: "block" });
  const wallet = new AcceptanceWallet();
  const blockedRemote: string[] = [];
  const requests: RequestEvidence[] = [];
  let bearerToken: string | null = null;

  await context.route("**/*", async (route) => {
    const raw = route.request().url();
    const url = new URL(raw);
    if ((url.protocol === "http:" || url.protocol === "https:") && !LOOPBACK_HOSTS.has(url.hostname)) {
      blockedRemote.push(`${route.request().method()} ${raw}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await context.routeWebSocket("**/*", (route) => {
    const raw = route.url();
    const url = new URL(raw);
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      blockedRemote.push(`WEBSOCKET ${raw}`);
      route.close();
      return;
    }
    route.connectToServer();
  });
  await wallet.attach(context);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== NOTIFIER_ORIGIN) return;
    requests.push({ method: request.method(), path: pathOf(request), body: request.postData() });
    const authorization = request.headers().authorization;
    if (authorization?.startsWith("Bearer ")) bearerToken = authorization.slice("Bearer ".length);
  });

  try {
    await page.goto(`${WEB_ORIGIN}/settings/notifications`, { waitUntil: "domcontentloaded" });
    const header = page.locator('header[data-slot="topbar"]');
    await header.getByRole("button", { name: "Connect", exact: true }).click();
    await header.getByRole("button", { name: "MetaMask", exact: true }).click();
    await page.getByRole("heading", { name: "Your channels", exact: true }).waitFor();

    const load = page.getByRole("button", { name: "Load my settings", exact: true });
    await until("notifier health enables Load my settings", async () => (await load.isEnabled()) ? true : null);
    await waitForNotifierResponse(page, "GET", "/v1/subscriptions", () => load.click());
    await waitForStatus(page, "Alert status is up to date.");
    assert.equal(wallet.signatureCount, 1, "loading settings must create exactly one wallet-signed session");
    assert(bearerToken, "browser did not use its notifier session bearer token");

    const telegramChannel = page.getByRole("button").filter({ hasText: "Receive alerts in a private chat with the Stonkhouse bot." });
    assert.match(await telegramChannel.innerText(), /Off/, "Telegram starts off for the rehearsal wallet");

    await waitForNotifierResponse(page, "GET", "/v1/telegram/link", () =>
      clickWhenEnabled(page.getByRole("button", { name: "Get Telegram link", exact: true })),
    );
    await waitForStatus(page, "Open the Telegram link below.");
    const deepLink = await page.getByRole("link", { name: "Open Telegram", exact: true }).getAttribute("href");
    assert(deepLink, "Telegram deep link was not rendered");
    const link = new URL(deepLink);
    assert.equal(link.origin, "https://t.me", "notifier returned a non-Telegram deep link");
    const startToken = link.searchParams.get("start");
    assert.match(startToken ?? "", /^[A-Za-z0-9_-]{32}$/, "Telegram start token is missing or malformed");

    await json<{ ok: true }>(`${TELEGRAM_CONTROL_ORIGIN}/_control/update`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TELEGRAM_BOT_TOKEN, text: `/start ${startToken}`, chatId: CHAT_ID }),
    });
    const bot = TELEGRAM_BOT_TOKEN.split(":", 1)[0]!;
    await until("fake Telegram records the notifier's link confirmation", async () => {
      const messages = await json<TelegramMessage[]>(`${TELEGRAM_CONTROL_ORIGIN}/_control/messages`);
      return messages.find((message) => message.bot === bot && message.chatId === CHAT_ID && /Linked to wallet/.test(message.text)) ?? null;
    }, 60_000);

    await until("rendered Telegram channel becomes active", async () => {
      const refresh = page.getByRole("button", { name: "Refresh status", exact: true });
      if (!(await refresh.isEnabled())) return null;
      await waitForNotifierResponse(page, "GET", "/v1/subscriptions", () => refresh.click());
      await waitForStatus(page, "Alert status is up to date.");
      return /On/.test(await telegramChannel.innerText()) ? true : null;
    }, 60_000);

    const readSubscriptions = async (): Promise<Subscription[]> => {
      assert(bearerToken, "notifier bearer token disappeared");
      const response = await json<{ items: Subscription[] }>(
        `${NOTIFIER_ORIGIN}/v1/subscriptions?${new URLSearchParams({ address: ADDRESS.address })}`,
        { headers: { authorization: `Bearer ${bearerToken}` } },
      );
      return response.items;
    };
    const telegramSubscription = async (): Promise<Subscription> => {
      const item = (await readSubscriptions()).find((entry) => entry.channel === "telegram");
      assert(item, "notifier API did not return the Telegram subscription");
      return item;
    };
    assert.equal((await telegramSubscription()).status, "active", "Telegram link is not active in the notifier API");

    const fills = page.getByRole("checkbox", { name: /Order fills/ });
    assert.equal(await fills.isChecked(), true, "Order fills starts enabled");
    await fills.uncheck();
    assert.equal(await fills.isChecked(), false, "rendered toggle changed before save");
    const save = page.getByRole("button", { name: "Save telegram alerts", exact: true });
    await waitForNotifierResponse(page, "POST", "/v1/subscriptions", () => clickWhenEnabled(save));
    await waitForStatus(page, "Alert preferences saved.");
    assert.equal(await fills.isChecked(), false, "rendered toggle reverted after save");
    assert.equal((await telegramSubscription()).prefs.fills, false, "notifier API did not persist the toggle change");

    await page.getByRole("button", { name: "Add alert", exact: true }).click();
    const ticker = page.getByLabel("Ticker for alert 1", { exact: true });
    await ticker.selectOption("NVDA");
    assert.equal(await ticker.inputValue(), "NVDA", "rendered price alert is not for live NVDA");
    const direction = page.getByLabel("Direction for alert 1", { exact: true });
    const price = page.getByLabel("Price for alert 1", { exact: true });
    await direction.selectOption("above");
    await price.fill("221.50");
    await waitForNotifierResponse(page, "POST", "/v1/subscriptions", () => clickWhenEnabled(save));
    await waitForStatus(page, "Alert preferences saved.");
    assert.equal(await ticker.inputValue(), "NVDA", "rendered ticker reverted after save");
    assert.equal(await direction.inputValue(), "above", "rendered direction reverted after save");
    assert.equal(await price.inputValue(), "221.50", "rendered price reverted after save");
    assert.deepEqual((await telegramSubscription()).prefs.priceAlerts, [{ ticker: "NVDA", above: "221500000" }], "notifier API did not persist the NVDA alert");

    await page.getByRole("button", { name: "Remove alert 1", exact: true }).click();
    await page.getByText("No price thresholds for this channel.", { exact: true }).waitFor();
    await waitForNotifierResponse(page, "POST", "/v1/subscriptions", () => clickWhenEnabled(save));
    await waitForStatus(page, "Alert preferences saved.");
    assert.deepEqual((await telegramSubscription()).prefs.priceAlerts, [], "notifier API did not remove the NVDA alert");

    await waitForNotifierResponse(page, "DELETE", `/v1/subscriptions/${(await telegramSubscription()).id}`, () =>
      clickWhenEnabled(page.getByRole("button", { name: "Turn off", exact: true })),
    );
    await waitForStatus(page, "Telegram alerts are off.");
    assert.match(await telegramChannel.innerText(), /Off/, "rendered Telegram channel did not turn off");
    assert.equal((await readSubscriptions()).some((item) => item.channel === "telegram"), false, "notifier API still returns the deleted Telegram subscription");

    assert.equal(wallet.signatureCount, 1, "the full flow must reuse exactly one wallet-signed notifier session");
    assert.equal(requests.filter((request) => request.method === "POST" && request.path === "/v1/challenge").length, 1, "browser created more than one challenge");
    assert.equal(requests.filter((request) => request.method === "POST" && request.path === "/v1/session").length, 1, "browser created more than one notifier session");
    assert.equal(requests.some((request) => request.path.startsWith("/v1/webpush/") || /\"channel\":\"webpush\"/.test(request.body ?? "")), false, "W3-402 exercised Web Push");
    assert.deepEqual(blockedRemote, [], `browser attempted non-local requests: ${blockedRemote.join(", ")}`);
    assert.deepEqual(pageErrors, [], `browser page errors: ${pageErrors.join(" | ")}`);

    process.stdout.write("W3-402 NOTIFICATIONS ACCEPTANCE PASSED: one session, Telegram linked via fake control, toggle + NVDA add/remove + delete verified\n");
  } finally {
    await context.close();
    await browser.close();
  }
}

await main();
