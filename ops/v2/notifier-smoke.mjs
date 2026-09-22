#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * ops/v2/notifier-smoke.mjs — O3-405: does a deployed notifier actually work?
 *
 * The notifier's own suite proves the code. This proves the DEPLOYMENT: that the process that
 * answers a hostname has a database, a Telegram bot, a VAPID pair and the rules engine the dapp
 * needs, and that a wallet can sign in, subscribe, read its subscriptions back and delete them.
 * It is what the operator runs after `ops/go-live-v2.sh --services notifier` and before telling
 * anyone the notifier is up.
 *
 *   node ops/v2/notifier-smoke.mjs https://notify.example            # the base URL as an argument
 *   NOTIFIER_URL=https://notify.example node ops/v2/notifier-smoke.mjs
 *   node ops/v2/notifier-smoke.mjs --url http://127.0.0.1:8791 --app-url http://127.0.0.1:3000
 *   node ops/v2/notifier-smoke.mjs --url … --read-only              # nothing is written at all
 *   node ops/v2/notifier-smoke.mjs --url … --json                   # the result as JSON
 *
 * THERE IS NO DEFAULT BASE URL, and this file names no hostname of any deployment. With neither
 * an argument nor NOTIFIER_URL the run refuses (exit 2) and says so: a smoke test that guesses its
 * target is a smoke test that one day subscribes a wallet on production because someone ran it
 * from the wrong shell. `--app-url` is optional; without it the CORS check asserts the answer's
 * shape (one fixed https origin, never `*`, never the caller's) but cannot compare it to a value.
 *
 * WHAT IT CHECKS (each is one line of output; the first failure does not stop the others)
 *   health              200, service, database ok, the breaker states, the Telegram bot, the rules
 *                       engine, and the `no-store` / `no-referrer` headers every answer carries.
 *   cors                exactly one origin is admitted, it is not `*` and not the caller's own, and
 *                       the preflight of POST /v1/subscriptions admits GET/POST/DELETE with the
 *                       `authorization` and `content-type` request headers.
 *   webpush-key         /v1/webpush/key decodes to a 65-byte uncompressed P-256 point (0x04…), the
 *                       only shape a push service accepts. A truncated or mis-pasted VAPID public
 *                       key answers 200 here and 401 forever from every push service.
 *   refusals            no credentials → 400, a forged bearer → 401 session-invalid, an unknown
 *                       route → 404, each as `{ error: { code, message } }`.
 *   session             POST /v1/challenge → an EIP-4361 message bound to the address, the nonce and
 *                       chain 4663 → signed → POST /v1/session → a token. The same nonce and
 *                       signature are then replayed and must be refused: nonces are single-use.
 *   subscription-create a telegram subscription, then the same POST again: 201 then 200, one row.
 *   subscription-list   it comes back pending, with no target (a telegram row never hands back a chat).
 *   price-alert         the already-true price alert round-trips verbatim. See below.
 *   telegram-link       GET /v1/telegram/link → https://t.me/<bot>?start=<token>, unexpired.
 *   subscription-delete DELETE → 200, it leaves the list, and deleting it again is 404.
 *
 * THE ALREADY-TRUE PRICE ALERT is `{ ticker, above: "1" }` — one millionth of a USDG per share, a
 * threshold every market this protocol lists has always been above. It is the alert that fires on
 * the next rules tick rather than at some future price, so it exercises the whole preference path
 * (validated, stored, read back) inside one run. It cannot send anything: the subscription is
 * telegram with no chat bound, so it is `pending`, and the rules engine's recipient query takes
 * `verified_at IS NOT NULL AND disabled_at IS NULL` (notifier/src/rules/store.ts) while the
 * delivery worker drops an unverified row as `subscription_inactive` (notifier/src/delivery.ts).
 * That is why this smoke can hold an always-true alert against a live notifier without paging a
 * single person. Proving that the alert is DELIVERED needs a bound chat and belongs to the
 * rehearsal (ops/v2/rehearse.sh step 3), not to a smoke test against production.
 *
 * WHAT IT WRITES. In the default mode: one telegram subscription for a throwaway wallet, upserted
 * once, then deleted; the challenge nonces those calls spend; and the Telegram link token. Nothing
 * else, no other wallet's rows, and no configuration. `--read-only` runs health, cors, webpush-key
 * and refusals only, and needs no wallet at all.
 *
 * THE WALLET is generated in memory for this run (viem `generatePrivateKey`, resolved through the
 * notifier package), never written to disk, never printed, never funded and never used again. This
 * script reads no key file and takes no key from the environment: there is nothing here for a
 * leaked shell history to give away. Neither the session token nor the Telegram start token is
 * printed — both authenticate the caller.
 *
 * Exit codes: 0 every check passed · 1 a check failed · 2 bad usage (the missing URL included).
 * Node 22+; `--read-only` needs no dependency, the write checks need viem through notifier/.
 * ------------------------------------------------------------------------------------------------- */
import { Buffer } from "node:buffer";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..", "..");

export const DEFAULT_TIMEOUT_MS = 10_000;
/** The chain the notifier binds its EIP-4361 challenge to (notifier/src/auth.ts). */
export const CHAIN_ID = 4663;
/** An origin no deployment can ever be: the CORS check sends it and must not get it back. */
export const FOREIGN_ORIGIN = "https://notifier-smoke-foreign-origin.invalid";
export const DEFAULT_TICKER = "NVDA";
/** 1 USDG base unit per whole share (0.000001 USDG): true at every price any listed market has had. */
export const ALERT_THRESHOLD = "1";
/** The read-only checks, in order. The rest need a wallet. */
export const READ_ONLY_CHECKS = ["health", "cors", "webpush-key", "refusals"];
export const WRITE_CHECKS = [
  "session", "subscription-create", "subscription-list", "price-alert", "telegram-link", "subscription-delete",
];

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const NONCE = /^[0-9a-f]{32}$/;
const DEEP_LINK = /^https:\/\/t\.me\/([A-Za-z0-9_]{4,32})\?start=(.+)$/;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

export const USAGE = [
  "usage: node ops/v2/notifier-smoke.mjs <base-url> [--app-url URL] [--ticker NVDA]",
  "                                      [--timeout SECONDS] [--read-only] [--json]",
  "",
  "  <base-url>      the notifier's origin, e.g. https://notify.example. NOTIFIER_URL does the same.",
  "                  There is no default: this script never guesses which notifier it is probing.",
  "  --app-url URL   the dapp origin CORS must admit (APP_URL does the same). Optional.",
  "  --ticker NVDA   the market the already-true price alert names.",
  "  --timeout N     seconds per request (default 10).",
  "  --read-only     health, cors, webpush-key and refusals only: nothing is written, no wallet.",
  "  --json          print the result as JSON instead of one line per check.",
].join("\n");

/* ---------------------------------------------------------------------------------------------- */
/*  arguments                                                                                      */
/* ---------------------------------------------------------------------------------------------- */

function httpOrigin(raw, what) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`${what} ${JSON.stringify(raw)} is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UsageError(`${what} ${JSON.stringify(raw)} is not http(s)`);
  }
  return url;
}

export function parseArgs(argv, env = {}) {
  let url = null;
  let appUrl = null;
  let ticker = DEFAULT_TICKER;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let readOnly = false;
  let json = false;
  let i = 0;
  const value = (flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${flag} needs a value`);
    i += 1;
    return v;
  };
  while (i < argv.length) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { help: true };
    else if (a === "--url") url = value(a);
    else if (a === "--app-url") appUrl = value(a);
    else if (a === "--ticker") ticker = value(a);
    else if (a === "--read-only") readOnly = true;
    else if (a === "--json") json = true;
    else if (a === "--timeout") {
      const seconds = Number(value(a));
      if (!Number.isFinite(seconds) || seconds <= 0) throw new UsageError("--timeout takes a number of seconds above 0");
      timeoutMs = Math.round(seconds * 1000);
    } else if (a.startsWith("-")) throw new UsageError(`unknown flag ${a} (--help)`);
    else if (url === null) url = a;
    else throw new UsageError(`unexpected argument ${JSON.stringify(a)} (--help)`);
    i += 1;
  }

  const raw = (url ?? env.NOTIFIER_URL ?? "").trim();
  if (raw === "") {
    throw new UsageError(
      "no notifier base URL. Pass it as an argument (node ops/v2/notifier-smoke.mjs https://notify.example) " +
        "or set NOTIFIER_URL.\nThere is no default and no hostname is written into this script: it must " +
        "never guess which deployment it is probing.",
    );
  }
  const base = httpOrigin(raw, "the notifier base URL");
  const app = appUrl ?? env.APP_URL ?? null;
  if (!/^[A-Z0-9.]{1,8}$/.test(ticker)) throw new UsageError(`--ticker ${JSON.stringify(ticker)} is not an upper-case registry ticker`);
  return {
    help: false,
    baseUrl: `${base.origin}${base.pathname === "/" ? "" : base.pathname.replace(/\/$/, "")}`,
    appUrl: app === null || String(app).trim() === "" ? null : httpOrigin(String(app).trim(), "--app-url").origin,
    ticker,
    timeoutMs,
    readOnly,
    json,
  };
}

/* ---------------------------------------------------------------------------------------------- */
/*  the run                                                                                        */
/* ---------------------------------------------------------------------------------------------- */

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** ` (code: message)` when the answer carried the API's error envelope, else "". */
const errorOf = (r) =>
  isObject(r.json) && isObject(r.json.error) ? ` (${r.json.error.code}: ${r.json.error.message})` : "";

/**
 * A wallet for this run only: generated in memory, never written, never printed beyond its address,
 * never funded. viem comes through the notifier package, which already depends on it.
 */
export async function ephemeralSigner() {
  let accounts;
  try {
    accounts = createRequire(path.join(ROOT, "notifier", "package.json"))("viem/accounts");
  } catch (error) {
    throw new Error(
      `cannot load viem through the notifier package (${error.message}). Run \`pnpm install --frozen-lockfile\` ` +
        "at the repository root, or use --read-only for the checks that need no wallet.",
    );
  }
  return accounts.privateKeyToAccount(accounts.generatePrivateKey());
}

/**
 * Every check against `baseUrl`. Returns { checks: [{ name, status, detail }], passed, failed,
 * skipped }; it never throws for a failing notifier, only for a broken argument. `fetchImpl` and
 * `signer` exist for the tests.
 */
export async function runSmoke(options) {
  const {
    baseUrl,
    appUrl = null,
    ticker = DEFAULT_TICKER,
    readOnly = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    signer = null,
    now = () => Date.now(),
  } = options;
  if (typeof baseUrl !== "string" || baseUrl === "") throw new UsageError("runSmoke needs a baseUrl");

  const checks = [];
  const step = async (name, fn) => {
    try {
      checks.push({ name, status: "pass", detail: await fn() });
      return true;
    } catch (error) {
      checks.push({ name, status: "fail", detail: error.message });
      return false;
    }
  };
  const skip = (name, why) => checks.push({ name, status: "skip", detail: why });

  const request = async (method, pathname, { body, headers = {}, token } = {}) => {
    const sent = { accept: "application/json", ...headers };
    if (token !== undefined) sent.authorization = `Bearer ${token}`;
    if (body !== undefined) sent["content-type"] = "application/json";
    const response = await fetchImpl(`${baseUrl}${pathname}`, {
      method,
      headers: sent,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, headers: response.headers, json, text };
  };
  const seconds = (unix) => Math.max(0, Math.round((Number(unix) * 1000 - now()) / 1000));

  /* ---- health ---- */

  await step("health", async () => {
    const r = await request("GET", "/health");
    expect(r.status === 200, `GET /health answered ${r.status}, expected 200${errorOf(r)}`);
    expect(isObject(r.json), `GET /health did not answer JSON: ${r.text.slice(0, 120)}`);
    const body = r.json;
    expect(body.service === "callhouse-notifier", `service is ${JSON.stringify(body.service)}, expected "callhouse-notifier": this hostname is not a notifier`);
    expect(body.database === "ok", `database is ${JSON.stringify(body.database)}: the notifier cannot reach Postgres, so nothing can subscribe and nothing is delivered`);
    expect(body.status === "ok", `status is ${JSON.stringify(body.status)}`);
    expect(body.telegramBot === "ok", `telegramBot is ${JSON.stringify(body.telegramBot)}: the bot's username was never read, so no wallet can be handed a link to attach a chat`);
    expect(isObject(body.channels), `channels is ${JSON.stringify(body.channels)}, expected the per-channel breaker states`);
    const rules = isObject(body.rules) ? body.rules : {};
    expect(
      rules.status !== "failing",
      `the rules engine is failing (${rules.consecutiveFailures ?? "?"} consecutive failures, last success ${rules.lastSuccessAt ?? "never"}): no alert of any kind is being evaluated`,
    );
    expect(r.headers.get("cache-control") === "no-store", `cache-control is ${JSON.stringify(r.headers.get("cache-control"))}, expected no-store`);
    expect(r.headers.get("referrer-policy") === "no-referrer", `referrer-policy is ${JSON.stringify(r.headers.get("referrer-policy"))}, expected no-referrer (the email pages carry their token in the URL)`);
    return `status=${body.status} database=${body.database} rules=${rules.status ?? "off"} channels=${JSON.stringify(body.channels)}`;
  });

  /* ---- cors ---- */

  await step("cors", async () => {
    const r = await request("GET", "/health", { headers: { origin: FOREIGN_ORIGIN } });
    const allow = r.headers.get("access-control-allow-origin");
    expect(allow !== null, "no access-control-allow-origin on /health: the dapp's notification settings cannot read it from the browser");
    expect(allow !== "*", "access-control-allow-origin is *: any page a wallet visits could read that wallet's subscriptions with a stolen session token");
    expect(allow !== FOREIGN_ORIGIN, `access-control-allow-origin came back as the origin that asked (${FOREIGN_ORIGIN}): every origin is admitted`);
    expect(allow.startsWith("http"), `access-control-allow-origin is ${JSON.stringify(allow)}, expected one origin`);
    if (appUrl !== null) expect(allow === appUrl, `access-control-allow-origin is ${allow}; --app-url says the dapp is ${appUrl}, so the dapp cannot read this notifier`);
    const pre = await fetchImpl(`${baseUrl}/v1/subscriptions`, {
      method: "OPTIONS",
      headers: {
        origin: allow,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    expect(pre.status >= 200 && pre.status < 400, `the CORS preflight of POST /v1/subscriptions answered ${pre.status}`);
    const methods = (pre.headers.get("access-control-allow-methods") ?? "").toLowerCase();
    const allowed = (pre.headers.get("access-control-allow-headers") ?? "").toLowerCase();
    for (const m of ["get", "post", "delete"]) {
      expect(methods.includes(m), `the preflight does not admit ${m.toUpperCase()} (allow-methods: ${methods || "none"})`);
    }
    for (const h of ["authorization", "content-type"]) {
      expect(allowed.includes(h), `the preflight does not admit the ${h} request header (allow-headers: ${allowed || "none"}), so the dapp cannot send a session bearer`);
    }
    return `one origin admitted (${allow}); preflight allows ${methods} with ${allowed}`;
  });

  /* ---- webpush key ---- */

  await step("webpush-key", async () => {
    const r = await request("GET", "/v1/webpush/key");
    expect(r.status === 200, `GET /v1/webpush/key answered ${r.status}${errorOf(r)}`);
    const key = isObject(r.json) ? r.json.publicKey : undefined;
    expect(typeof key === "string" && key.length > 0, `publicKey is ${JSON.stringify(key)}`);
    expect(BASE64URL.test(key), "publicKey is not base64url: no browser will accept it as an applicationServerKey");
    const bytes = Buffer.from(key, "base64url");
    expect(bytes.length === 65, `publicKey decodes to ${bytes.length} bytes; a VAPID public key is a 65-byte uncompressed P-256 point. Every push service will answer 401 or 403 forever`);
    expect(bytes[0] === 0x04, `publicKey decodes to a point starting 0x${bytes[0].toString(16).padStart(2, "0")}, expected 0x04 (uncompressed)`);
    return `65-byte uncompressed P-256 point, ${key.length} base64url characters`;
  });

  /* ---- refusals ---- */

  await step("refusals", async () => {
    const anonymous = await request("GET", "/v1/subscriptions");
    expect(anonymous.status === 400, `GET /v1/subscriptions with no credentials answered ${anonymous.status}, expected 400: it must never list anything unauthenticated`);
    expect(anonymous.json?.error?.code === "bad-request", `its error code is ${JSON.stringify(anonymous.json?.error?.code)}, expected bad-request`);
    const forged = await request("GET", "/v1/subscriptions", {
      token: "v1.0x0000000000000000000000000000000000000000.9999999999.notavalidmac",
    });
    expect(forged.status === 401, `a forged session bearer answered ${forged.status}, expected 401${errorOf(forged)}`);
    expect(forged.json?.error?.code === "session-invalid", `its error code is ${JSON.stringify(forged.json?.error?.code)}, expected session-invalid`);
    const unknown = await request("GET", "/v1/no-such-route-smoke");
    expect(unknown.status === 404, `an unknown route answered ${unknown.status}, expected 404`);
    expect(unknown.json?.error?.code === "not-found", `its error code is ${JSON.stringify(unknown.json?.error?.code)}, expected not-found`);
    return "unauthenticated 400 bad-request; forged bearer 401 session-invalid; unknown route 404 not-found";
  });

  /* ---- the write checks ---- */

  if (readOnly) {
    for (const name of WRITE_CHECKS) skip(name, "--read-only: nothing is written and no wallet is generated");
    return summarise(checks);
  }

  let account = signer;
  if (account === null) {
    const ready = await step("signer", async () => {
      account = await ephemeralSigner();
      return `throwaway wallet ${account.address}, generated in memory for this run only`;
    });
    if (!ready) {
      for (const name of WRITE_CHECKS) skip(name, "no wallet: the write checks sign the notifier's challenge");
      return summarise(checks);
    }
  }

  const prefs = {
    strikeCross: false,
    expiry24h: false,
    expiry1h: false,
    settlement: false,
    fills: false,
    writerItmWarning: false,
    autoRoll: false,
    priceAlerts: [{ ticker, above: ALERT_THRESHOLD }],
  };
  let token;
  let subscriptionId = null;

  const signedIn = await step("session", async () => {
    const challenge = await request("POST", "/v1/challenge", { body: { address: account.address } });
    expect(challenge.status === 200, `POST /v1/challenge answered ${challenge.status}${errorOf(challenge)}`);
    const { message, nonce, expiresAt } = isObject(challenge.json) ? challenge.json : {};
    expect(typeof message === "string" && message.length > 0, "the challenge carries no message to sign");
    expect(typeof nonce === "string" && NONCE.test(nonce), `the nonce is ${JSON.stringify(nonce)}, expected 128 random bits as 32 hex characters`);
    expect(Number(expiresAt) * 1000 > now(), "the challenge is already expired: this notifier's clock is wrong");
    expect(message.includes(account.address), "the challenge message does not name the address it was issued for: a signature for it would authenticate somebody else");
    expect(message.includes(nonce), "the challenge message does not carry its own nonce");
    expect(message.includes(`Chain ID: ${CHAIN_ID}`), `the challenge message does not bind chain ${CHAIN_ID}`);
    const signature = await account.signMessage({ message });
    const session = await request("POST", "/v1/session", { body: { address: account.address, signature, nonce } });
    expect(session.status === 200, `POST /v1/session answered ${session.status}${errorOf(session)}`);
    expect(typeof session.json?.token === "string" && session.json.token.length > 0, "the session carries no token");
    expect(
      String(session.json.address).toLowerCase() === account.address.toLowerCase(),
      `the session was issued for ${session.json.address}, not the address that signed`,
    );
    expect(Number(session.json.expiresAt) * 1000 > now(), "the session is already expired");
    token = session.json.token;
    const replay = await request("POST", "/v1/session", { body: { address: account.address, signature, nonce } });
    expect(
      replay.status === 401,
      `the same nonce and signature bought a second session (${replay.status}): nonces are single-use, so a signature read from a log or a proxy must be worth nothing twice`,
    );
    return `challenge signed, session valid ${seconds(session.json.expiresAt)}s, the spent nonce is refused a second time`;
  });

  if (!signedIn) {
    for (const name of WRITE_CHECKS.slice(1)) skip(name, "no session");
    return summarise(checks);
  }

  await step("subscription-create", async () => {
    const created = await request("POST", "/v1/subscriptions", { token, body: { channel: "telegram", prefs } });
    expect(created.status === 201, `POST /v1/subscriptions answered ${created.status}${errorOf(created)}, expected 201 for a new subscription`);
    expect(typeof created.json?.id === "string" && created.json.id.length > 0, "the new subscription came back without an id");
    subscriptionId = created.json.id;
    const again = await request("POST", "/v1/subscriptions", { token, body: { channel: "telegram", prefs } });
    expect(again.status === 200, `the same POST again answered ${again.status}, expected 200: an existing subscription is updated, never duplicated`);
    expect(again.json?.id === subscriptionId, `the second POST answered id ${JSON.stringify(again.json?.id)}, not ${subscriptionId}: a wallet has one telegram subscription`);
    return `telegram subscription created (201) and re-upserted in place (200)`;
  });

  await step("subscription-list", async () => {
    expect(subscriptionId !== null, "nothing was created to list");
    const list = await request("GET", "/v1/subscriptions", { token });
    expect(list.status === 200, `GET /v1/subscriptions answered ${list.status}${errorOf(list)}`);
    expect(Array.isArray(list.json?.items), `the answer has no items array: ${list.text.slice(0, 120)}`);
    const row = list.json.items.find((x) => isObject(x) && x.id === subscriptionId);
    expect(row !== undefined, `the subscription just created (${subscriptionId}) is not in this wallet's list`);
    expect(row.channel === "telegram", `its channel is ${JSON.stringify(row.channel)}`);
    expect(row.status === "pending", `it is ${JSON.stringify(row.status)}, expected pending: no Telegram chat has been attached, and an unverified row is never a recipient`);
    expect(row.target === null, `its target is ${JSON.stringify(row.target)}: a telegram row must never hand back a chat`);
    expect(Number.isFinite(row.createdAt), `its createdAt is ${JSON.stringify(row.createdAt)}, expected unix seconds`);
    expect(row.verifiedAt === null, `its verifiedAt is ${JSON.stringify(row.verifiedAt)}: a subscription nobody confirmed must not come back verified`);
    return `${list.json.items.length} row(s) for this wallet; ${subscriptionId} is pending with no target`;
  });

  await step("price-alert", async () => {
    expect(subscriptionId !== null, "nothing was created to carry an alert");
    const list = await request("GET", "/v1/subscriptions", { token });
    const row = (Array.isArray(list.json?.items) ? list.json.items : []).find((x) => isObject(x) && x.id === subscriptionId);
    expect(row !== undefined, "the subscription is gone");
    const alerts = row.prefs?.priceAlerts;
    expect(Array.isArray(alerts) && alerts.length === 1, `prefs.priceAlerts came back as ${JSON.stringify(alerts)}, expected the one alert that was sent`);
    expect(alerts[0].ticker === ticker, `the alert names ${JSON.stringify(alerts[0].ticker)}, not ${ticker}`);
    expect(
      alerts[0].above === ALERT_THRESHOLD,
      `the alert threshold came back as ${JSON.stringify(alerts[0].above)}, not ${ALERT_THRESHOLD}: thresholds are USDG base units as an integer string and must survive the round trip exactly`,
    );
    expect(alerts[0].below === undefined || alerts[0].below === null, `the alert grew a below threshold (${JSON.stringify(alerts[0].below)}) nobody sent`);
    for (const [key, sent] of Object.entries(prefs)) {
      if (key === "priceAlerts") continue;
      expect(row.prefs?.[key] === sent, `prefs.${key} came back ${JSON.stringify(row.prefs?.[key])}, ${JSON.stringify(sent)} was sent: a toggle that does not round-trip silently turns alerts on`);
    }
    return `an already-true alert (${ticker} above ${ALERT_THRESHOLD} USDG base units) is stored verbatim and can deliver nothing: the row is pending`;
  });

  await step("telegram-link", async () => {
    const link = await request("GET", "/v1/telegram/link", { token });
    expect(
      link.status === 200,
      `GET /v1/telegram/link answered ${link.status}${errorOf(link)}${link.status === 503 ? " — the Telegram bot did not answer, so no wallet can attach a chat" : ""}`,
    );
    const deepLink = link.json?.deepLink;
    expect(typeof deepLink === "string", `deepLink is ${JSON.stringify(deepLink)}`);
    const m = DEEP_LINK.exec(deepLink);
    expect(m !== null, `deepLink ${JSON.stringify(deepLink)} is not https://t.me/<bot>?start=<token>`);
    expect(Number(link.json?.expiresAt) * 1000 > now(), "the deep link is already expired");
    // The start token attaches a chat to this wallet: it is a credential, so only the bot is printed.
    return `https://t.me/${m[1]}?start=<redacted>, valid ${seconds(link.json.expiresAt)}s`;
  });

  if (subscriptionId === null) {
    skip("subscription-delete", "nothing was created, so there is nothing to clean up");
    return summarise(checks);
  }

  await step("subscription-delete", async () => {
    const id = encodeURIComponent(subscriptionId);
    const deleted = await request("DELETE", `/v1/subscriptions/${id}`, { token });
    expect(deleted.status === 200, `DELETE /v1/subscriptions/${subscriptionId} answered ${deleted.status}${errorOf(deleted)}`);
    expect(deleted.json?.ok === true, `it answered ${JSON.stringify(deleted.json)}, expected { ok: true }`);
    const list = await request("GET", "/v1/subscriptions", { token });
    const still = (Array.isArray(list.json?.items) ? list.json.items : []).some((x) => isObject(x) && x.id === subscriptionId);
    expect(!still, `${subscriptionId} is still listed after DELETE: this smoke leaves a subscription behind on every run`);
    const twice = await request("DELETE", `/v1/subscriptions/${id}`, { token });
    expect(twice.status === 404, `deleting it a second time answered ${twice.status}, expected 404`);
    return `${subscriptionId} deleted; nothing this run created is left behind`;
  });

  return summarise(checks);
}

export function summarise(checks) {
  const count = (status) => checks.filter((c) => c.status === status).length;
  return { checks, passed: count("pass"), failed: count("fail"), skipped: count("skip") };
}

export function format(result, { json = false } = {}) {
  if (json) return `${JSON.stringify(result, null, 2)}\n`;
  const width = Math.max(...result.checks.map((c) => c.name.length));
  const lines = result.checks.map((c) => `${c.status.toUpperCase().padEnd(4)} ${c.name.padEnd(width)}  ${c.detail}`);
  lines.push(
    `${result.failed === 0 ? "NOTIFIER SMOKE PASSED" : "NOTIFIER SMOKE FAILED"}: ` +
      `${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`,
  );
  return `${lines.join("\n")}\n`;
}

/* ---------------------------------------------------------------------------------------------- */

const isMain = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2), process.env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`notifier-smoke: ${error.message}\n\n${USAGE}\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  const result = await runSmoke(args);
  process.stdout.write(format(result, { json: args.json }));
  process.exit(result.failed === 0 ? 0 : 1);
}
