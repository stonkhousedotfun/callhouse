/**
 * O3-405: the notifier smoke test, against a fake notifier.
 *
 * WHY THIS FILE EXISTS: a smoke test that cannot fail is worse than none — it is a green line that
 * says a broken deployment is fine. Every check in notifier-smoke.mjs is exercised twice here: once
 * against a fake that behaves like notifier/src/server.ts, where it must pass, and once against the
 * same fake with exactly that one behaviour broken, where that check and no other must fail.
 *
 * Nothing here reaches the network: the fake listens on 127.0.0.1 on a port the OS picks, and the
 * wallet is a stub (the real run signs with a throwaway viem key, which needs an install).
 *
 *   node --test ops/v2/notifier-smoke.test.mjs
 */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createECDH, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";

import {
  ALERT_THRESHOLD,
  DEFAULT_TICKER,
  FOREIGN_ORIGIN,
  READ_ONLY_CHECKS,
  UsageError,
  WRITE_CHECKS,
  format,
  parseArgs,
  runSmoke,
} from "./notifier-smoke.mjs";

const APP_ORIGIN = "https://app.example";
const BOT = "stonkhouse_alerts_bot";

/** A real 65-byte uncompressed P-256 point, the shape notifier/src/config.ts checks a VAPID key has. */
function vapidKey() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString("base64url");
}

const SIGNER = {
  address: "0x1111111111111111111111111111111111111111",
  async signMessage({ message }) {
    assert.equal(typeof message, "string");
    return `0x${"ab".repeat(65)}`;
  },
};

/**
 * A notifier that answers the way notifier/src/server.ts answers. `broken` turns exactly one
 * behaviour off; everything else stays correct.
 */
// T-518 checked the O3-405 suspicion against this suite: "a lot of machinery that has never been
// executed once". It has now been executed. At c0c5c6a0af5694673495c63e264c9585ab854f0a: 27 tests,
// 27 pass, 0 fail. The suite needs nothing to run it - the fake listens on 127.0.0.1 on an OS-picked
// port and reaches no network - so the author's reason for never running it no longer holds.
// THE GREEN IS LOAD-BEARING, AND THAT IS THE POINT RATHER THAN THE PASS COUNT. Neutering the `broken`
// argument below (making it always {}) reds 18 of the 27, because 18 of these tests exist only to
// assert that one injected break fails one check. A suite built almost entirely from negative
// controls cannot pass vacuously: if the injection stopped working, those tests would fail rather
// than quietly agree. Nothing was fixed, because nothing was broken.
function fakeNotifier(broken = {}) {
  const state = {
    nonces: new Map(),
    sessions: new Map(),
    subscriptions: new Map(),
    publicKey: broken.shortVapid === true ? vapidKey().slice(0, 40) : vapidKey(),
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, body, headers = {}) => {
      const origin = broken.echoOrigin === true ? (req.headers.origin ?? APP_ORIGIN) : broken.wildcardCors === true ? "*" : APP_ORIGIN;
      res.writeHead(status, {
        "content-type": "application/json",
        "cache-control": broken.cacheable === true ? "public, max-age=60" : "no-store",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
        ...(broken.noCors === true ? {} : { "access-control-allow-origin": origin }),
        ...headers,
      });
      res.end(body === null ? "" : JSON.stringify(body));
    };
    const fail = (status, code, message) => send(status, { error: { code, message } });
    const bearer = () => {
      const header = req.headers.authorization ?? "";
      return header.startsWith("Bearer ") ? header.slice(7) : null;
    };
    /** null = not authenticated; the caller answers 400 or 401 as server.ts does. */
    const session = () => {
      const token = bearer();
      if (token === null) return { ok: false, status: 400, code: "bad-request", message: "address, signature and nonce, or a session bearer" };
      const address = state.sessions.get(token);
      if (address === undefined) return { ok: false, status: 401, code: "session-invalid", message: "the session is invalid or has expired" };
      return { ok: true, address };
    };
    const body = [];
    req.on("data", (chunk) => body.push(chunk));
    req.on("end", () => {
      let json = null;
      try {
        json = JSON.parse(Buffer.concat(body).toString("utf8"));
      } catch {
        json = null;
      }
      const soon = Math.floor(Date.now() / 1000) + 600;

      if (req.method === "OPTIONS") {
        return send(
          204,
          null,
          broken.preflightWithoutAuthHeader === true
            ? { "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "content-type" }
            : { "access-control-allow-methods": "GET,POST,DELETE,OPTIONS", "access-control-allow-headers": "content-type,authorization" },
        );
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return send(200, {
          status: broken.databaseDown === true ? "degraded" : "ok",
          service: "callhouse-notifier",
          database: broken.databaseDown === true ? "unavailable" : "ok",
          channels: { telegram: "closed", webpush: "closed", email: "off" },
          telegramBot: broken.telegramDown === true ? "unknown" : "ok",
          rules: broken.rulesFailing === true
            ? { status: "failing", lastSuccessAt: null, consecutiveFailures: 9 }
            : { status: "ok", lastSuccessAt: Math.floor(Date.now() / 1000), consecutiveFailures: 0 },
        });
      }
      if (req.method === "GET" && url.pathname === "/v1/webpush/key") return send(200, { publicKey: state.publicKey });

      if (req.method === "POST" && url.pathname === "/v1/challenge") {
        const address = String(json?.address ?? "");
        const nonce = randomBytes(16).toString("hex");
        const message =
          `app.example wants you to sign in with your Ethereum account:\n${address}\n\n` +
          `Stonkhouse alerts.\n\nURI: ${APP_ORIGIN}\nVersion: 1\nChain ID: 4663\nNonce: ${nonce}\n` +
          `Issued At: ${new Date().toISOString()}\nExpiration Time: ${new Date(soon * 1000).toISOString()}`;
        state.nonces.set(nonce, address);
        return send(200, { message, nonce, expiresAt: soon });
      }
      if (req.method === "POST" && url.pathname === "/v1/session") {
        const nonce = String(json?.nonce ?? "");
        const address = state.nonces.get(nonce);
        if (address === undefined) return fail(401, "nonce-invalid", "the challenge has expired or was already used");
        if (broken.nonceReplayable !== true) state.nonces.delete(nonce);
        const token = `v1.${address}.${soon}.${randomBytes(32).toString("base64url")}`;
        state.sessions.set(token, address);
        return send(200, { token, address, expiresAt: soon });
      }
      if (url.pathname === "/v1/subscriptions" && req.method === "POST") {
        const who = session();
        if (!who.ok) return fail(who.status, who.code, who.message);
        const prefs = { ...(json?.prefs ?? {}) };
        if (broken.dropsPriceAlert === true) prefs.priceAlerts = [];
        const existing = [...state.subscriptions.values()].find((s) => s.address === who.address && s.channel === "telegram");
        if (existing !== undefined && broken.duplicateOnUpsert !== true) {
          existing.prefs = prefs;
          return send(200, { id: existing.id });
        }
        const id = `sub_${state.subscriptions.size + 1}`;
        state.subscriptions.set(id, { id, address: who.address, channel: "telegram", prefs, createdAt: Math.floor(Date.now() / 1000) });
        return send(201, { id });
      }
      if (url.pathname === "/v1/subscriptions" && req.method === "GET") {
        const who = session();
        if (!who.ok && broken.listsWithoutCredentials !== true) return fail(who.status, who.code, who.message);
        const items = [...state.subscriptions.values()]
          .filter((s) => who.ok === false || s.address === who.address)
          .map((s) => ({
            id: s.id,
            channel: s.channel,
            status: broken.unverifiedLooksActive === true ? "active" : "pending",
            target: broken.leaksTelegramTarget === true ? "12345678" : null,
            prefs: s.prefs,
            createdAt: s.createdAt,
            verifiedAt: broken.unverifiedLooksActive === true ? s.createdAt : null,
            disabledAt: null,
            disabledReason: null,
          }));
        return send(200, { items });
      }
      if (url.pathname.startsWith("/v1/subscriptions/") && req.method === "DELETE") {
        const who = session();
        if (!who.ok) return fail(who.status, who.code, who.message);
        const id = decodeURIComponent(url.pathname.slice("/v1/subscriptions/".length));
        const row = state.subscriptions.get(id);
        if (row === undefined || row.address !== who.address) return fail(404, "not-found", "no such subscription for this address");
        if (broken.deleteKeepsRow !== true) state.subscriptions.delete(id);
        return send(200, { ok: true });
      }
      if (req.method === "GET" && url.pathname === "/v1/telegram/link") {
        const who = session();
        if (!who.ok) return fail(who.status, who.code, who.message);
        if (broken.telegramLinkUnavailable === true) return fail(503, "channel-unavailable", "the Telegram bot is not reachable right now");
        return send(200, { deepLink: `https://t.me/${BOT}?start=${randomBytes(16).toString("base64url")}`, expiresAt: soon });
      }
      if (broken.unknownRouteIs200 === true) return send(200, { ok: true });
      return fail(404, "not-found", "no such route");
    });
  });
  return server;
}

/** Starts the fake, runs the smoke against it, stops the fake. */
async function smoke(broken = {}, options = {}) {
  const server = fakeNotifier(broken);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    return await runSmoke({ baseUrl: `http://127.0.0.1:${port}`, signer: SIGNER, ...options });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const check = (result, name) => result.checks.find((c) => c.name === name);
const failedNames = (result) => result.checks.filter((c) => c.status === "fail").map((c) => c.name);

/**
 * `broken` must make exactly `name` fail. Written this way on purpose: a guard that is deleted from
 * notifier-smoke.mjs turns this into "0 checks failed", and a guard that is too broad turns it into
 * a second name in the list.
 */
async function onlyFails(name, broken, options = {}) {
  const result = await smoke(broken, options);
  assert.deepEqual(failedNames(result), [name], `${JSON.stringify(broken)} should fail ${name} and nothing else`);
  return check(result, name);
}

/* ------------------------------------------------------------------ arguments */

test("no base URL is refused, and nothing is defaulted", () => {
  assert.throws(() => parseArgs([], {}), (error) => {
    assert.ok(error instanceof UsageError);
    assert.match(error.message, /no notifier base URL/);
    assert.match(error.message, /no default/);
    return true;
  });
  assert.throws(() => parseArgs([], { NOTIFIER_URL: "   " }), UsageError);
  assert.throws(() => parseArgs(["--url", "notaurl"], {}), UsageError);
  assert.throws(() => parseArgs(["ftp://notify.example"], {}), UsageError);
  assert.throws(() => parseArgs(["--url"], {}), UsageError);
  assert.throws(() => parseArgs(["https://a.example", "https://b.example"], {}), UsageError);
  assert.throws(() => parseArgs(["--frobnicate"], {}), UsageError);
});

test("no hostname of any deployment is written into the script", () => {
  const source = readFileSync(new URL("./notifier-smoke.mjs", import.meta.url), "utf8");
  for (const host of ["notify.stonkhouse.fun", "app.stonkhouse.fun", "dev.app.stonkhouse.fun", "railway.internal"]) {
    assert.equal(source.includes(host), false, `notifier-smoke.mjs names ${host}: it would one day be the default`);
  }
});

test("the base URL comes from the argument, --url or NOTIFIER_URL, trailing slash trimmed", () => {
  assert.equal(parseArgs(["https://notify.example/"], {}).baseUrl, "https://notify.example");
  assert.equal(parseArgs(["--url", "https://notify.example"], {}).baseUrl, "https://notify.example");
  assert.equal(parseArgs([], { NOTIFIER_URL: "https://notify.example" }).baseUrl, "https://notify.example");
  assert.equal(parseArgs(["https://a.example"], { NOTIFIER_URL: "https://b.example" }).baseUrl, "https://a.example");
  assert.equal(parseArgs(["https://notify.example"], {}).appUrl, null);
  assert.equal(parseArgs(["https://notify.example"], { APP_URL: "https://app.example/" }).appUrl, "https://app.example");
  assert.equal(parseArgs(["https://notify.example", "--read-only"], {}).readOnly, true);
  assert.equal(parseArgs(["https://notify.example", "--timeout", "2"], {}).timeoutMs, 2000);
  assert.throws(() => parseArgs(["https://notify.example", "--timeout", "0"], {}), UsageError);
  assert.throws(() => parseArgs(["https://notify.example", "--ticker", "nvda"], {}), UsageError);
  assert.equal(parseArgs(["https://notify.example", "--help"], {}).help, true);
});

/* ------------------------------------------------------------------ the happy path */

test("a healthy notifier passes every check and leaves nothing behind", async () => {
  const result = await smoke({}, { appUrl: APP_ORIGIN });
  assert.deepEqual(failedNames(result), []);
  assert.deepEqual(
    result.checks.map((c) => c.name),
    [...READ_ONLY_CHECKS, ...WRITE_CHECKS],
  );
  assert.equal(result.skipped, 0);
  assert.equal(result.passed, READ_ONLY_CHECKS.length + WRITE_CHECKS.length);
  assert.match(check(result, "subscription-delete").detail, /nothing this run created is left behind/);
  assert.match(format(result).trim(), /NOTIFIER SMOKE PASSED/);
});

test("--read-only runs the four checks that write nothing and skips the rest", async () => {
  const result = await smoke({}, { readOnly: true });
  assert.deepEqual(failedNames(result), []);
  assert.deepEqual(result.checks.filter((c) => c.status === "pass").map((c) => c.name), READ_ONLY_CHECKS);
  assert.deepEqual(result.checks.filter((c) => c.status === "skip").map((c) => c.name), WRITE_CHECKS);
});

test("nothing the run prints authenticates anybody", async () => {
  const result = await smoke({}, { appUrl: APP_ORIGIN });
  const printed = format(result);
  assert.match(printed, /start=<redacted>/);
  assert.equal(/start=[A-Za-z0-9_-]{8,}/.test(printed), false, "the Telegram start token was printed");
  assert.equal(/v1\.0x[0-9a-fA-F]{40}\.\d+\./.test(printed), false, "a session token was printed");
});

/* ------------------------------------------------------------------ one broken behaviour each */

test("a notifier that cannot reach Postgres fails health", async () => {
  const failure = await onlyFails("health", { databaseDown: true });
  assert.match(failure.detail, /database is "unavailable"/);
});

test("a Telegram bot that never answered getMe fails health", async () => {
  await onlyFails("health", { telegramDown: true });
});

test("a failing rules engine fails health", async () => {
  const failure = await onlyFails("health", { rulesFailing: true });
  assert.match(failure.detail, /rules engine is failing/);
});

test("a cacheable answer fails health", async () => {
  await onlyFails("health", { cacheable: true });
});

test("access-control-allow-origin: * fails cors", async () => {
  const failure = await onlyFails("cors", { wildcardCors: true });
  assert.match(failure.detail, /\*/);
});

test("a notifier that echoes the caller's origin fails cors", async () => {
  const failure = await onlyFails("cors", { echoOrigin: true });
  assert.match(failure.detail, new RegExp(FOREIGN_ORIGIN.replace(/[.]/g, "\\.")));
});

test("no CORS headers at all fails cors", async () => {
  await onlyFails("cors", { noCors: true });
});

test("a preflight that does not admit the authorization header fails cors", async () => {
  const failure = await onlyFails("cors", { preflightWithoutAuthHeader: true });
  assert.match(failure.detail, /authorization/);
});

test("an origin that is not the dapp's fails cors when --app-url says so", async () => {
  const result = await smoke({}, { appUrl: "https://other.example" });
  assert.deepEqual(failedNames(result), ["cors"]);
  assert.match(check(result, "cors").detail, /other\.example/);
});

test("a truncated VAPID public key fails webpush-key", async () => {
  const failure = await onlyFails("webpush-key", { shortVapid: true });
  assert.match(failure.detail, /65/);
});

test("listing subscriptions without credentials fails refusals", async () => {
  const failure = await onlyFails("refusals", { listsWithoutCredentials: true });
  assert.match(failure.detail, /no credentials/);
});

test("an unknown route that answers 200 fails refusals", async () => {
  await onlyFails("refusals", { unknownRouteIs200: true });
});

test("a replayable nonce fails session", async () => {
  const result = await smoke({ nonceReplayable: true });
  assert.deepEqual(failedNames(result), ["session"]);
  assert.match(check(result, "session").detail, /single-use/);
  for (const name of WRITE_CHECKS.slice(1)) assert.equal(check(result, name).status, "skip");
});

test("a second row for the same wallet fails subscription-create", async () => {
  const failure = await onlyFails("subscription-create", { duplicateOnUpsert: true });
  assert.match(failure.detail, /expected 200|one telegram subscription/);
});

test("an unverified subscription presented as active fails subscription-list", async () => {
  const failure = await onlyFails("subscription-list", { unverifiedLooksActive: true });
  assert.match(failure.detail, /pending/);
});

test("a telegram row that hands back a chat fails subscription-list", async () => {
  const failure = await onlyFails("subscription-list", { leaksTelegramTarget: true });
  assert.match(failure.detail, /target/);
});

test("a dropped price alert fails price-alert", async () => {
  const failure = await onlyFails("price-alert", { dropsPriceAlert: true });
  assert.match(failure.detail, /priceAlerts/);
  assert.match(failure.detail, /\[\]/);
});

test("the already-true alert is the one that is sent and read back", async () => {
  const result = await smoke({});
  const detail = check(result, "price-alert").detail;
  assert.match(detail, new RegExp(`${DEFAULT_TICKER} above ${ALERT_THRESHOLD} USDG base units`));
  assert.match(detail, /can deliver nothing/);
});

test("an unreachable Telegram bot fails telegram-link", async () => {
  const failure = await onlyFails("telegram-link", { telegramLinkUnavailable: true });
  assert.match(failure.detail, /503/);
});

test("a DELETE that leaves the row behind fails subscription-delete", async () => {
  const failure = await onlyFails("subscription-delete", { deleteKeepsRow: true });
  assert.match(failure.detail, /still listed/);
});

test("a notifier that is not listening fails every check instead of throwing", async () => {
  const result = await runSmoke({ baseUrl: "http://127.0.0.1:1", signer: SIGNER, timeoutMs: 1500 });
  assert.equal(result.passed, 0);
  assert.deepEqual(failedNames(result), READ_ONLY_CHECKS.concat(["session"]));
  assert.equal(result.skipped, WRITE_CHECKS.length - 1);
});
