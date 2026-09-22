/* -------------------------------------------------------------------------------------------------
 * node --test ops/v2/daily-win.test.mjs
 *
 * The daily "biggest win" post against the real fixture server (ops/fixtures/serve-v2.mjs on a free
 * port) and in-process fakes for the indexer, the web app and the X API. Every CLI run gets a clean
 * environment built here: nothing is inherited from the shell, so real X credentials in the
 * caller's environment can never reach a child, and X_API_BASE always points at a local fake. The
 * credentials used are obviously fake strings; the OAuth vector is the example from X's own
 * "Creating a signature" documentation, not an account.
 * ------------------------------------------------------------------------------------------------- */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  DISCLAIMER,
  DataError,
  PostCheckError,
  X_ENV,
  assertPost,
  buildPost,
  checkPost,
  oauth1Header,
  percentEncode,
  qualify,
  readXCredentials,
  signatureBaseString,
  weightedLength,
} from "./daily-win.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SCRIPT = join(HERE, "daily-win.mjs");
const FIXTURES = join(REPO, "ops", "fixtures", "api", "v2");
const readJson = (...p) => JSON.parse(readFileSync(join(FIXTURES, ...p), "utf8"));

/** The fixture scenario's "now" (ops/fixtures/api/v2/README.md). */
const FIXTURE_NOW = 1789592400;
const STATS = readJson("stats.json");
const WEEK_WIN = STATS.biggestWinWeek;
const WEEK_ID = "109733135889116194008703981926101410916763203979514320802443652863493208496976-0x83daA58d0a8d82D7b971338a03AA2f99bfADf4F8";
const WEEK_PNL = readJson("pnl", `${WEEK_ID}.json`);
const ALL_WINS = readJson("feed", "wins.json").items;

const expectedWeekPost = (appUrl) =>
  "This week's biggest win on Stonkhouse: NVDA $214 call, expired Sep 11, 2026. The buyer paid 0.75 USDG, " +
  "and the most they could lose was 0.75 USDG. It settled for 4.85 USDG, 6.54x the cost.\n" +
  "Most options expire worthless.\n" +
  `Receipt: ${appUrl}/pnl/${WEEK_ID}`;

const FAKE_CREDS = {
  X_CONSUMER_KEY: "fake-consumer-key-for-tests",
  X_CONSUMER_SECRET: "fake-consumer-secret-for-tests",
  X_ACCESS_TOKEN: "fake-access-token-for-tests",
  X_ACCESS_SECRET: "fake-access-secret-for-tests",
};
const FAKE_TWEET_ID = "1900000000000000001";

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

let fixtureUrl;
let fixtureProc;

before(async () => {
  fixtureProc = spawn(process.execPath, [join(REPO, "ops", "fixtures", "serve-v2.mjs"), "--port", "0"], {
    env: { PATH: process.env.PATH ?? "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  fixtureUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`fixture server did not start: ${buf}`)), 10_000);
    fixtureProc.stdout.on("data", (chunk) => {
      buf += chunk;
      const m = buf.match(/http:\/\/localhost:(\d+)\/v2/);
      if (m) {
        clearTimeout(timer);
        resolve(`http://localhost:${m[1]}`);
      }
    });
    fixtureProc.on("exit", (code) => reject(new Error(`fixture server exited ${code}: ${buf}`)));
  });
});

after(() => {
  fixtureProc?.kill();
});

/**
 * One in-process HTTP server. `routes` maps "METHOD /path" (exact, query string stripped) or
 * "METHOD /prefix*" to [status, body, contentType?]. Unmatched requests are 404. Every request is
 * recorded with its headers and body.
 */
async function startFake(routes) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const path = (req.url ?? "/").split("?")[0];
      requests.push({ method: req.method, url: req.url, path, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      const key = `${req.method} ${path}`;
      const hit = routes[key] ??
        Object.entries(routes).find(([k]) => k.endsWith("*") && key.startsWith(k.slice(0, -1)))?.[1];
      const [status, body, type] = hit ?? [404, { error: { code: "not_found", message: key } }];
      const text = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      res.writeHead(status, { "Content-Type": type ?? "application/json" });
      res.end(text);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A fake web app + X API: the share page, its image and POST /2/tweets. */
const appAndXRoutes = (overrides = {}) => ({
  "GET /pnl/*": [200, "<html>receipt</html>", "text/html"],
  "GET /api/pnl/*": [200, Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png"],
  "POST /2/tweets": [201, { data: { id: FAKE_TWEET_ID, text: "ignored" } }],
  ...overrides,
});

/** Runs the CLI in a clean environment (nothing inherited but PATH). */
function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`daily-win timed out\n${stdout}\n${stderr}`));
    }, 30_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const postBlock = (stdout) => {
  const m = stdout.match(/----- post -----\n([\s\S]*?)\n----- end -----/);
  return m ? m[1] : null;
};

const assertNoCredentialsIn = (...outputs) => {
  for (const value of Object.values(FAKE_CREDS)) {
    for (const out of outputs) assert.ok(!out.includes(value), "a credential value was printed");
  }
};

/** A Win with new amounts and a consistent multiple. */
function withAmounts(win, costRaw, payoutRaw) {
  const fmt = (raw) => {
    const s = String(raw).padStart(7, "0");
    const f = `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, "");
    return f === "" ? "0" : f;
  };
  return {
    ...win,
    cost: { raw: String(costRaw), decimals: 6, formatted: fmt(costRaw) },
    payout: { raw: String(payoutRaw), decimals: 6, formatted: fmt(payoutRaw) },
    multiple: Number((BigInt(payoutRaw) * 100n) / BigInt(costRaw)) / 100,
  };
}

// ---------------------------------------------------------------------------------------------
// Dry run and skips
// ---------------------------------------------------------------------------------------------

describe("dry run against the fixture server", () => {
  test("prints the week's post, the share page and the generated image URLs, and posts nothing", async () => {
    const x = await startFake(appAndXRoutes());
    try {
      const r = await runCli(["--window", "week", "--now", String(FIXTURE_NOW)], {
        INDEXER_URL: fixtureUrl,
        X_API_BASE: x.url,
        ...FAKE_CREDS, // present, but no --post: must still post nothing
      });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(postBlock(r.stdout), expectedWeekPost("https://app.stonkhouse.fun"));
      assert.match(r.stdout, /dry run, nothing posted/);
      assert.ok(r.stdout.includes(`page:         https://app.stonkhouse.fun/pnl/${WEEK_ID}\n`));
      assert.ok(r.stdout.includes(`image:        https://app.stonkhouse.fun/api/pnl/${WEEK_ID}/image `));
      assert.ok(r.stdout.includes(`https://app.stonkhouse.fun/api/pnl/${WEEK_ID}/image?format=square`));
      assert.ok(r.stdout.includes(`https://app.stonkhouse.fun/pnl/${WEEK_ID}/opengraph-image`));
      // All ASCII: weight = characters - URL length + 23.
      const text = expectedWeekPost("https://app.stonkhouse.fun");
      const weight = text.length - `https://app.stonkhouse.fun/pnl/${WEEK_ID}`.length + 23;
      assert.ok(r.stdout.includes(`length:       ${weight}/280`));
      assert.equal(x.requests.length, 0);
      assertNoCredentialsIn(r.stdout, r.stderr);
    } finally {
      await x.close();
    }
  });

  test("skips with a reason, exit 0, when biggestWinDay is null (the fixture day)", async () => {
    const r = await runCli([], { INDEXER_URL: fixtureUrl, X_API_BASE: "http://127.0.0.1:9" });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /skip \(day\): biggestWinDay is null/);
    assert.equal(postBlock(r.stdout), null);
  });

  test("skips when /v2/pnl/:id has no receipt for the win", async () => {
    const win = { ...WEEK_WIN };
    const indexer = await startFake({ "GET /v2/stats": [200, { ...STATS, biggestWinDay: win }] });
    try {
      const r = await runCli(["--now", String(win.settledAt + 3600)], { INDEXER_URL: indexer.url, X_API_BASE: "http://127.0.0.1:9" });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /skip \(day\): .*\/v2\/pnl answered 404/);
      assert.equal(postBlock(r.stdout), null);
    } finally {
      await indexer.close();
    }
  });

  test("a /v2/pnl that disagrees with /v2/stats is an error, not a post", async () => {
    const indexer = await startFake({
      "GET /v2/stats": [200, { ...STATS, biggestWinDay: WEEK_WIN }],
      [`GET /v2/pnl/${WEEK_ID}`]: [200, { ...WEEK_PNL, tx: `0x${"ab".repeat(32)}` }],
    });
    try {
      const r = await runCli(["--now", String(WEEK_WIN.settledAt + 3600)], { INDEXER_URL: indexer.url, X_API_BASE: "http://127.0.0.1:9" });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /disagrees with \/v2\/stats on tx/);
      assert.equal(postBlock(r.stdout), null);
    } finally {
      await indexer.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Qualification
// ---------------------------------------------------------------------------------------------

describe("qualification rule", () => {
  const at = { window: "week", now: FIXTURE_NOW };

  test("the fixture week win qualifies", () => {
    assert.deepEqual(qualify(WEEK_WIN, at), { ok: true });
  });

  test("the indexer's lowercase-holder id is the same position", () => {
    const win = { ...WEEK_WIN, id: WEEK_ID.toLowerCase() };
    assert.deepEqual(qualify(win, at), { ok: true });
  });

  test("null, unsettled, under 0.10 USDG, payout not above cost, under 2x and stale all skip", () => {
    const skip = (win, opts = at) => {
      const v = qualify(win, opts);
      assert.equal(v.ok, false);
      return v.reason;
    };
    assert.match(skip(null, { window: "day", now: FIXTURE_NOW }), /biggestWinDay is null/);
    assert.match(skip(null, at), /biggestWinWeek is null/);
    assert.match(skip({ ...WEEK_WIN, series: { ...WEEK_WIN.series, status: "held" } }), /not "settled"/);
    assert.match(skip(withAmounts(WEEK_WIN, 99_999, 999_990)), /under the 0.10 USDG floor/);
    assert.deepEqual(qualify(withAmounts(WEEK_WIN, 100_000, 200_000), at), { ok: true });
    assert.match(skip(withAmounts(WEEK_WIN, 500_000, 500_000)), /not above cost/);
    assert.match(skip(withAmounts(WEEK_WIN, 500_000, 999_999)), /1\.99x is under the 2x floor/);
    assert.match(skip(WEEK_WIN, { window: "week", now: WEEK_WIN.settledAt + 8 * 86_400 + 1 }), /older than the 192 h week limit/);
    assert.deepEqual(qualify(WEEK_WIN, { window: "week", now: WEEK_WIN.settledAt + 8 * 86_400 }), { ok: true });
    assert.match(skip(WEEK_WIN, { window: "day", now: WEEK_WIN.settledAt + 36 * 3600 + 1 }), /older than the 36 h day limit/);
    assert.deepEqual(qualify(WEEK_WIN, { window: "day", now: WEEK_WIN.settledAt + 36 * 3600 }), { ok: true });
  });

  test("self-contradicting data throws instead of skipping", () => {
    assert.throws(() => qualify({ ...WEEK_WIN, multiple: 20 }, at), DataError);
    assert.throws(() => qualify({ ...WEEK_WIN, id: `1-${WEEK_WIN.holder}` }, at), DataError);
    assert.throws(() => qualify({ ...WEEK_WIN, id: `${WEEK_ID}/../x` }, at), DataError);
    assert.throws(() => qualify({ ...WEEK_WIN, cost: { ...WEEK_WIN.cost, decimals: 18 } }, at), DataError);
  });
});

// ---------------------------------------------------------------------------------------------
// Copy rules and the 280 limit
// ---------------------------------------------------------------------------------------------

describe("post copy", () => {
  /**
   * The forbidden-copy rules, INLINED. They were read out of scripts/copy-lint.mjs until that
   * script was removed on 2026-09-21 by owner instruction. This is now the only copy in this
   * file's reach, so it cannot drift from an upstream that no longer exists - and nothing
   * outside this test checks post copy any more.
   */
  function copyLintForbidden() {
    return [
      /\bAPY\b/i,
      /\bAPR\b/i,
      /10\s*%\s*weekly/i,
      /projected\s+(yield|return|apy|income)/i,
      /annuali[sz]ed/i,
      /backed\s+by\s+nvidia/i,
      /dividend\s+paid\s+(in\s+cash\s+)?by\s+nvidia/i,
      /guaranteed\s+(yield|return|premium)/i,
      /\bguaranteed\b/i,
      /risk[-\s]?free/i,
      /\bcan['\u2019]?t\s+lose\b/i,
      /\bfree\s+money\b/i,
    ];
  }

  const posts = ALL_WINS.flatMap((win) =>
    ["day", "week"].map((window) => buildPost(win, { window, appUrl: "https://app.stonkhouse.fun" }).text),
  );
  const good = buildPost(WEEK_WIN, { window: "week", appUrl: "https://app.stonkhouse.fun" }).text;

  test("every fixture win's post passes copy-lint's FORBIDDEN table and the post rules", () => {
    const forbidden = copyLintForbidden();
    assert.equal(posts.length, 10);
    for (const text of posts) {
      for (const re of forbidden) assert.doesNotMatch(text, re);
      for (const re of [/guarantee/i, /risk[-\s]?free/i, /\bAP[YR]\b/i, /tokeni[sz]ed/i, /@/, /\p{Extended_Pictographic}/u]) {
        assert.doesNotMatch(text, re);
      }
      assert.ok(text.includes(DISCLAIMER));
      assert.match(text, /The buyer paid (\d+\.\d\d) USDG, and the most they could lose was \1 USDG\./);
      assert.deepEqual(checkPost(text), []);
      assert.ok(weightedLength(text) <= 280);
    }
  });

  test("checkPost names each broken rule", () => {
    assert.equal(good, expectedWeekPost("https://app.stonkhouse.fun"));
    assert.deepEqual(checkPost(good), []);
    const broken = (text, pattern) => {
      const problems = checkPost(text);
      assert.ok(problems.some((p) => pattern.test(p)), `${pattern} not in ${JSON.stringify(problems)}`);
    };
    broken(good.replace(DISCLAIMER, ""), /Most options expire worthless/);
    broken(good.replace("the cost.", "the cost, guaranteed."), /guaranteed/);
    broken(good.replace("the cost.", "the cost. Risk-free."), /risk-free/i);
    broken(good.replace("the cost.", "the cost. 900% APY."), /APY/);
    broken(good.replace("the cost.", "the cost. Only on tokenized stocks."), /tokenized/);
    broken(good.replace("NVDA $216 call", "NVDA stock call"), /Stock Tokens/);
    broken(good.replace("the cost.", "the cost. You could win next."), /never promise returns/);
    broken(good.replace("Stonkhouse:", "@stonkhousefun:"), /@handles/);
    broken(good.replace("the cost.", "the cost. \u{1F680}"), /emojis/);
    broken(good.replace("most they could lose was 0.55", "most they could lose was 0.54"), /must equal what was paid/);
    broken(good.replace(", and the most they could lose was 0.55 USDG", ""), /payoff must come with its cost/);
    broken(good.replace("Receipt: ", "Receipt: https://example.org/x and "), /exactly one link/);
    assert.deepEqual(checkPost(good.replace("NVDA $216 call", "NVDA Stock Token $216 call")), []);
  });

  test("weights as X does: every URL is 23, heavy code points 2", () => {
    assert.equal(weightedLength(`abc https://app.stonkhouse.fun/pnl/${WEEK_ID}`), 4 + 23);
    assert.equal(weightedLength("see stonkhouse.fun now"), 4 + 23 + 4);
    assert.equal(weightedLength("日本"), 4);
    assert.equal(weightedLength("café —"), 6);
  });

  test("280 is the hard limit, enforced loudly", () => {
    const w = weightedLength(good);
    const at280 = good.replace("the cost.", `the cost.${" z".repeat((280 - w) / 2)}${(280 - w) % 2 ? "z" : ""}`);
    assert.equal(weightedLength(at280), 280);
    assert.deepEqual(checkPost(at280), []);
    const at281 = at280.replace("the cost.", "the cost.z");
    assert.equal(weightedLength(at281), 281);
    assert.ok(checkPost(at281).some((p) => /281 characters .* limit is 280/.test(p)));
    assert.throws(() => assertPost(at281), (e) => e instanceof PostCheckError && /281 characters/.test(e.message));
  });

  test("an overlong post exits 1 and nothing reaches X, even with --post and credentials", async () => {
    const huge = "9".repeat(200);
    const win = { ...WEEK_WIN, series: { ...WEEK_WIN.series, strike: { raw: `${huge}000000`, decimals: 6, formatted: huge } } };
    const indexer = await startFake({
      "GET /v2/stats": [200, { ...STATS, biggestWinDay: win }],
      [`GET /v2/pnl/${WEEK_ID}`]: [200, { ...WEEK_PNL, series: win.series }],
    });
    const x = await startFake(appAndXRoutes());
    try {
      const r = await runCli(["--post", "--now", String(win.settledAt + 60)], {
        INDEXER_URL: indexer.url,
        APP_URL: x.url,
        X_API_BASE: x.url,
        ...FAKE_CREDS,
      });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /post check failed, nothing posted/);
      assert.match(r.stderr, /limit is 280/);
      assert.equal(postBlock(r.stdout), null);
      assert.equal(x.requests.length, 0);
      assertNoCredentialsIn(r.stdout, r.stderr);
    } finally {
      await indexer.close();
      await x.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// OAuth 1.0a
// ---------------------------------------------------------------------------------------------

describe("OAuth 1.0a HMAC-SHA1", () => {
  // X developer docs, "Creating a signature": published example values, not an account.
  const DOC = {
    consumerKey: "xvz1evFS4wEEPTGEFPHBog",
    consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
    token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
    tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
    nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
    timestamp: 1318622958,
  };
  const STATUS = "Hello Ladies + Gentlemen, a signed OAuth request!";

  test("percent-encodes per RFC 3986", () => {
    assert.equal(percentEncode(STATUS), "Hello%20Ladies%20%2B%20Gentlemen%2C%20a%20signed%20OAuth%20request%21");
    assert.equal(percentEncode("*'()~-._"), "%2A%27%28%29~-._");
  });

  test("reproduces the documented base string, signature and header", () => {
    const oauth = {
      oauth_consumer_key: DOC.consumerKey,
      oauth_nonce: DOC.nonce,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: String(DOC.timestamp),
      oauth_token: DOC.token,
      oauth_version: "1.0",
    };
    assert.equal(
      signatureBaseString("POST", "https://api.twitter.com/1.1/statuses/update.json", { include_entities: "true", status: STATUS, ...oauth }),
      "POST&https%3A%2F%2Fapi.twitter.com%2F1.1%2Fstatuses%2Fupdate.json&include_entities%3Dtrue%26oauth_consumer_key%3Dxvz1evFS4wEEPTGEFPHBog%26oauth_nonce%3DkYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1318622958%26oauth_token%3D370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb%26oauth_version%3D1.0%26status%3DHello%2520Ladies%2520%252B%2520Gentlemen%252C%2520a%2520signed%2520OAuth%2520request%2521",
    );
    const expected =
      'OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", ' +
      'oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", ' +
      'oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1.0"';
    const url = "https://api.twitter.com/1.1/statuses/update.json";
    assert.equal(oauth1Header({ method: "POST", url, params: { include_entities: "true", status: STATUS }, ...DOC }), expected);
    // Query parameters in the URL are signed the same as body parameters.
    assert.equal(oauth1Header({ method: "POST", url: `${url}?include_entities=true`, params: { status: STATUS }, ...DOC }), expected);
    // The v1 URL of the same docs gives their other published signature.
    assert.match(
      oauth1Header({ method: "POST", url: "https://api.twitter.com/1/statuses/update.json", params: { include_entities: "true", status: STATUS }, ...DOC }),
      /oauth_signature="tnnArxj06cWHq44gCs1OSKk%2FjLY%3D"/,
    );
  });

  test("header shape: seven sorted, quoted, encoded oauth_ parameters; a fresh nonce each call", () => {
    const creds = { consumerKey: "consumer-key-value", consumerSecret: "consumer-secret-value", token: "token-value", tokenSecret: "token-secret-value" };
    const a = oauth1Header({ method: "POST", url: "https://api.twitter.com/2/tweets", ...creds });
    const b = oauth1Header({ method: "POST", url: "https://api.twitter.com/2/tweets", ...creds });
    const keys = [...a.matchAll(/(oauth_[a-z_]+)="[^"]*"/g)].map((m) => m[1]);
    assert.match(a, /^OAuth oauth_[a-z_]+="[^"]*"(, oauth_[a-z_]+="[^"]*"){6}$/);
    assert.deepEqual(keys, ["oauth_consumer_key", "oauth_nonce", "oauth_signature", "oauth_signature_method", "oauth_timestamp", "oauth_token", "oauth_version"]);
    assert.match(a, /oauth_nonce="[0-9a-f]{32}"/);
    assert.match(a, /oauth_signature="[A-Za-z0-9%]{28,}"/);
    assert.notEqual(a.match(/oauth_nonce="([^"]+)"/)[1], b.match(/oauth_nonce="([^"]+)"/)[1]);
    // The secrets sign; they are never sent.
    assert.ok(!a.includes(creds.consumerSecret) && !a.includes(creds.tokenSecret));
  });

  test("credentials: all four, non-empty, or a list of what is missing", () => {
    assert.deepEqual(readXCredentials({}).missing, X_ENV);
    assert.deepEqual(readXCredentials({ ...FAKE_CREDS, X_ACCESS_SECRET: " " }).missing, ["X_ACCESS_SECRET"]);
    const { creds, missing } = readXCredentials(FAKE_CREDS);
    assert.deepEqual(missing, []);
    assert.deepEqual(creds, {
      consumerKey: FAKE_CREDS.X_CONSUMER_KEY,
      consumerSecret: FAKE_CREDS.X_CONSUMER_SECRET,
      token: FAKE_CREDS.X_ACCESS_TOKEN,
      tokenSecret: FAKE_CREDS.X_ACCESS_SECRET,
    });
  });
});

// ---------------------------------------------------------------------------------------------
// --post
// ---------------------------------------------------------------------------------------------

describe("--post", () => {
  const weekArgs = ["--window", "week", "--now", String(FIXTURE_NOW), "--post"];

  test("refuses without credentials, names what is missing, contacts nothing", async () => {
    const x = await startFake(appAndXRoutes());
    try {
      const none = await runCli(weekArgs, { INDEXER_URL: fixtureUrl, APP_URL: x.url, X_API_BASE: x.url });
      assert.equal(none.code, 1);
      assert.match(none.stderr, /refusing to post: X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET are not set/);
      assert.match(none.stderr, /Nothing was posted/);

      const { X_ACCESS_SECRET: _omit, ...three } = FAKE_CREDS;
      const partial = await runCli(weekArgs, { INDEXER_URL: fixtureUrl, APP_URL: x.url, X_API_BASE: x.url, ...three });
      assert.equal(partial.code, 1);
      assert.match(partial.stderr, /refusing to post: X_ACCESS_SECRET is not set/);
      assert.equal(postBlock(partial.stdout), null);
      assertNoCredentialsIn(none.stdout, none.stderr, partial.stdout, partial.stderr);
      assert.equal(x.requests.length, 0);
    } finally {
      await x.close();
    }
  });

  test("checks the page and image, then sends exactly one signed POST /2/tweets with the post", async () => {
    const x = await startFake(appAndXRoutes());
    try {
      const r = await runCli(weekArgs, { INDEXER_URL: fixtureUrl, APP_URL: x.url, X_API_BASE: x.url, ...FAKE_CREDS });
      assert.equal(r.code, 0, r.stderr);
      const text = expectedWeekPost(x.url);
      assert.equal(postBlock(r.stdout), text);
      assert.match(r.stdout, new RegExp(`posted: https://x\\.com/i/web/status/${FAKE_TWEET_ID}`));
      assertNoCredentialsIn(r.stdout, r.stderr);

      assert.deepEqual(x.requests.map((q) => `${q.method} ${q.url}`), [
        `GET /pnl/${WEEK_ID}`,
        `GET /api/pnl/${WEEK_ID}/image`,
        "POST /2/tweets",
      ]);
      const post = x.requests[2];
      assert.equal(post.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(post.body), { text });

      const auth = post.headers.authorization;
      assert.match(auth, /^OAuth oauth_[a-z_]+="[^"]*"(, oauth_[a-z_]+="[^"]*"){6}$/);
      const params = Object.fromEntries([...auth.matchAll(/(oauth_[a-z_]+)="([^"]*)"/g)].map((m) => [m[1], decodeURIComponent(m[2])]));
      assert.equal(params.oauth_consumer_key, FAKE_CREDS.X_CONSUMER_KEY);
      assert.equal(params.oauth_token, FAKE_CREDS.X_ACCESS_TOKEN);
      assert.equal(params.oauth_signature_method, "HMAC-SHA1");
      assert.equal(params.oauth_version, "1.0");
      assert.ok(Math.abs(Number(params.oauth_timestamp) - Date.now() / 1000) < 300, "the OAuth timestamp is the clock, not --now");
      // The server side of the check: re-sign with the secrets and the request's own nonce and timestamp.
      assert.equal(
        auth,
        oauth1Header({
          method: "POST",
          url: `${x.url}/2/tweets`,
          consumerKey: FAKE_CREDS.X_CONSUMER_KEY,
          consumerSecret: FAKE_CREDS.X_CONSUMER_SECRET,
          token: FAKE_CREDS.X_ACCESS_TOKEN,
          tokenSecret: FAKE_CREDS.X_ACCESS_SECRET,
          nonce: params.oauth_nonce,
          timestamp: Number(params.oauth_timestamp),
        }),
      );
      assert.ok(!auth.includes(FAKE_CREDS.X_CONSUMER_SECRET) && !auth.includes(FAKE_CREDS.X_ACCESS_SECRET));
    } finally {
      await x.close();
    }
  });

  test("refuses when the share page does not answer 200", async () => {
    const x = await startFake(appAndXRoutes({ "GET /pnl/*": [404, "not found", "text/html"] }));
    try {
      const r = await runCli(weekArgs, { INDEXER_URL: fixtureUrl, APP_URL: x.url, X_API_BASE: x.url, ...FAKE_CREDS });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /refusing to post: GET .*\/pnl\/.* answered 404/);
      assert.equal(x.requests.filter((q) => q.method === "POST").length, 0);
    } finally {
      await x.close();
    }
  });

  test("an X error exits 1 after one attempt, no retry", async () => {
    const x = await startFake(appAndXRoutes({
      "POST /2/tweets": [403, { detail: "You are not allowed to create a Tweet with duplicate content.", status: 403 }],
    }));
    try {
      const r = await runCli(weekArgs, { INDEXER_URL: fixtureUrl, APP_URL: x.url, X_API_BASE: x.url, ...FAKE_CREDS });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /X answered 403: .*duplicate content/);
      assert.doesNotMatch(r.stdout, /posted:/);
      assert.equal(x.requests.filter((q) => q.method === "POST").length, 1);
      assertNoCredentialsIn(r.stdout, r.stderr);
    } finally {
      await x.close();
    }
  });
});
