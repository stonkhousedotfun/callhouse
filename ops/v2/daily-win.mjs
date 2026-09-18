#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * ops/v2/daily-win.mjs — the daily "biggest win" post, from the indexer, dry run by default.
 *
 * Reads `/v2/stats` from the v2 indexer, takes `biggestWinDay` (or `biggestWinWeek` with
 * `--window week`), checks it qualifies, cross-checks it against `/v2/pnl/:id` (the API the share
 * page renders from), builds the post text and the links to the W2-09 share page and its generated
 * image, and prints them. Nothing is posted unless `--post` is given AND all four X credentials are
 * in the environment.
 *
 *   node ops/v2/daily-win.mjs                                   # dry run, today's biggest win
 *   node ops/v2/daily-win.mjs --window week                     # this week's instead
 *   INDEXER_URL=http://localhost:42070 node ops/v2/daily-win.mjs --window week --now 1789592400
 *                                                               # against ops/fixtures/serve-v2.mjs
 *   node ops/v2/daily-win.mjs --post                            # owner only: posts to X
 *
 * Environment: INDEXER_URL (default http://localhost:42070, the fixture server), APP_URL (default
 * https://app.stonkhouse.fun), and for --post only X_CONSUMER_KEY, X_CONSUMER_SECRET,
 * X_ACCESS_TOKEN, X_ACCESS_SECRET (OAuth 1.0a user context of the posting account). X_API_BASE
 * (default https://api.twitter.com) exists for the tests' fake server.
 *
 * QUALIFYING WIN. The indexer already drops self-fills, fills under 25 % of fair, transferred
 * positions, positions that cost under 0.10 USDG and anything that did not pay more than it cost
 * (see indexer/src/api/v2/). On top of that, a win is posted only when ALL of these hold,
 * and the run skips (exit 0, reason printed) otherwise:
 *   1. the stats field is not null;
 *   2. its series status is `settled`;
 *   3. cost >= 0.10 USDG (the indexer floor, re-checked here);
 *   4. payout >= 2 x cost, from the raw amounts (so payout > cost holds too): a 1.2x day is not
 *      worth a post;
 *   5. it settled no more than 36 h (day) / 8 days (week) before now: a stuck cache never reposts
 *      an old win;
 *   6. `/v2/pnl/:id` answers for it, so the linked receipt and image render. A 404 there is a skip.
 * Data that contradicts itself (a pnl that disagrees with the stats win, a multiple that does not
 * match cost and payout, a malformed id) is an error (exit 1), never a skip and never a post.
 *
 * THE TEXT (checkPost enforces every rule; a failure exits 1 and nothing is posted): never promises
 * returns; no APY/APR, "guaranteed", "risk-free", "tokenized"; "stock" only as "Stock Token(s)";
 * the payout always comes with its cost ("paid X USDG, and the most they could lose was X USDG");
 * includes "Most options expire worthless."; exactly one link; no @handles, no emojis; at most 280
 * weighted characters as X counts them (every URL is 23). Amounts match the share image
 * (web/components/v2/PnlText.ts): cost rounded UP to 2 dp, payout rounded DOWN, the multiple floored
 * from the raw amounts.
 *
 * CREDENTIALS are read from the environment at --post time only, used to sign one request, and never
 * printed, logged or written anywhere. Missing any of the four is a refusal (exit 1) naming the
 * missing variables. With --post the page and image URLs must answer 200 first, so a post never
 * links a 404 (the share page exists only in a NEXT_PUBLIC_V2=1 build). One POST /2/tweets, no retry:
 * a retry could double-post.
 *
 * Exit codes: 0 printed, skipped or posted · 1 error or refusal (nothing posted) · 2 bad usage.
 * Node 22+, no npm dependencies (fetch, node:crypto).
 * ------------------------------------------------------------------------------------------------- */
import { createHmac, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const DEFAULT_INDEXER_URL = "http://localhost:42070";
export const DEFAULT_APP_URL = "https://app.stonkhouse.fun";
export const DEFAULT_X_API_BASE = "https://api.twitter.com";
export const X_ENV = ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"];

export const USDG_DECIMALS = 6;
/** 0.10 USDG: the indexer's minimum position cost, re-checked. */
export const MIN_COST_RAW = 100_000n;
/** 2.00x, in hundredths. */
export const MIN_MULTIPLE_X100 = 200n;
export const MAX_AGE_SECONDS = { day: 36 * 3600, week: 8 * 86_400 };
export const DISCLAIMER = "Most options expire worthless.";
export const MAX_POST_WEIGHT = 280;
export const URL_WEIGHT = 23;

/** The share page's own id rule (web/components/v2/PnlData.ts validPnlId). */
const PNL_ID_RE = /^[A-Za-z0-9-]{1,180}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_RE = /^0x[0-9a-f]{64}$/;
const UINT_RE = /^(0|[1-9]\d*)$/;

// ---------------------------------------------------------------------------------------------
// Post copy rules
// ---------------------------------------------------------------------------------------------

/**
 * Phrases the post must never contain: scripts/copy-lint.mjs's FORBIDDEN table (which cannot be
 * imported: it lints on load) plus the ops/publish-template.md "numbers never to publish" words and
 * return promises. The test also runs copy-lint's own regexes over real posts.
 */
export const POST_FORBIDDEN = [
  { re: /\bAPY\b/i, why: "no APY" },
  { re: /\bAPR\b/i, why: "no APR" },
  { re: /annuali[sz]ed/i, why: "never annualize" },
  { re: /10\s*%\s*weekly/i, why: 'no "10% weekly"' },
  { re: /projected/i, why: "no projections" },
  { re: /guarantee/i, why: 'no "guaranteed"' },
  { re: /risk[-\s]?free/i, why: 'no "risk-free"' },
  { re: /tokeni[sz]ed/i, why: 'say "Stock Tokens", never "tokenized"' },
  { re: /backed\s+by/i, why: 'no "backed by"' },
  { re: /dividend/i, why: "no dividend claims" },
  { re: /\b(safe|stable)\b/i, why: 'no "safe" or "stable"' },
  { re: /\bpromis/i, why: "never promise returns" },
  { re: /\bearn(s|ed|ing)?\b/i, why: "never promise returns" },
  { re: /\b(can'?t|cannot|won'?t)\s+lose\b/i, why: "never promise returns" },
  { re: /\b(you|u)\s+(could|can|will)\s+(win|make|get)\b/i, why: "never promise returns" },
  { re: /\b(free|easy)\s+money\b/i, why: "never promise returns" },
  { re: /\bget\s+rich\b|\bmoon\b|\bsure\s+thing\b/i, why: "never promise returns" },
];

const URL_RE = /\bhttps?:\/\/\S+/gi;
/** A bare domain X would auto-link (and count as 23). Deliberately broad: overcounting is safe. */
const BARE_DOMAIN_RE = /(?<![\w@./-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/\S*)?/gi;
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u{FE0F}|\u{200D}|\u{20E3}/u;

/** twitter-text v3: these code points weigh 1, everything else 2. */
const LIGHT_RANGES = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

/** The post's length as X counts it: NFC, every URL (or bare domain) 23, heavy code points 2. */
export function weightedLength(text) {
  let weight = 0;
  // Each link becomes one placeholder space (so neighbours do not fuse into a new "domain"); the
  // space is counted below, hence 23 - 1 here.
  const link = () => {
    weight += URL_WEIGHT - 1;
    return " ";
  };
  const rest = text.normalize("NFC").replace(URL_RE, link).replace(BARE_DOMAIN_RE, link);
  for (const ch of rest) {
    const cp = ch.codePointAt(0);
    weight += LIGHT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2;
  }
  return weight;
}

/** Every rule the post breaks, as readable strings; [] when it is fit to post. */
export function checkPost(text) {
  const problems = [];
  if (typeof text !== "string" || text.trim() === "") return ["the post is empty"];
  const weight = weightedLength(text);
  if (weight > MAX_POST_WEIGHT) {
    problems.push(`the post is ${weight} characters as X counts them (URLs count 23); the limit is ${MAX_POST_WEIGHT}`);
  }
  if (!text.includes(DISCLAIMER)) problems.push(`the post must include "${DISCLAIMER}"`);
  for (const rule of POST_FORBIDDEN) {
    const m = text.match(rule.re);
    if (m) problems.push(`forbidden copy ${JSON.stringify(m[0])}: ${rule.why}`);
  }
  const stockless = text.replace(/\bStock Tokens?\b/g, "");
  const stock = stockless.match(/\bstocks?\b/i);
  if (stock) problems.push(`forbidden copy ${JSON.stringify(stock[0])}: the asset class is "Stock Tokens", exactly`);
  if (text.includes("@")) problems.push("no @handles (the post contains @)");
  if (EMOJI_RE.test(text)) problems.push("no emojis");
  const urls = text.match(URL_RE) ?? [];
  if (urls.length !== 1) problems.push(`the post must carry exactly one link (found ${urls.length})`);
  const pair = text.match(/\bpaid (\d+(?:\.\d+)?) USDG, and the most they could lose was (\d+(?:\.\d+)?) USDG\b/);
  if (!pair) {
    problems.push('the payoff must come with its cost: "paid X USDG, and the most they could lose was X USDG"');
  } else if (pair[1] !== pair[2]) {
    problems.push(`the max loss (${pair[2]} USDG) must equal what was paid (${pair[1]} USDG)`);
  }
  return problems;
}

export class PostCheckError extends Error {}

export function assertPost(text) {
  const problems = checkPost(text);
  if (problems.length > 0) {
    throw new PostCheckError(`post check failed, nothing posted:\n  - ${problems.join("\n  - ")}`);
  }
  return text;
}

// ---------------------------------------------------------------------------------------------
// Money and labels (the same rounding as the share image, web/components/v2/PnlText.ts)
// ---------------------------------------------------------------------------------------------

/** raw base units -> fixed `places` decimals, rounded up or down. */
export function fixedMoney(raw, decimals, places, direction) {
  const unit = 10n ** BigInt(decimals);
  const scale = 10n ** BigInt(places);
  const value = BigInt(raw) * scale;
  const rounded = direction === "up" ? (value + unit - 1n) / unit : value / unit;
  const whole = rounded / scale;
  return places === 0 ? String(whole) : `${whole}.${String(rounded % scale).padStart(places, "0")}`;
}

/** Trailing zeros off a formatted amount: "216.000" -> "216", "216.50" -> "216.5". */
export function trimAmount(formatted) {
  const [whole, fraction = ""] = String(formatted).split(".");
  const f = fraction.replace(/0+$/, "");
  return f ? `${whole}.${f}` : whole;
}

/** payout / cost floored to 2 dp, trailing zeros trimmed: "11.25", "4.5", "3". */
export function multipleLabel(costRaw, payoutRaw) {
  const hundredths = (BigInt(payoutRaw) * 100n) / BigInt(costRaw);
  return trimAmount(`${hundredths / 100n}.${String(hundredths % 100n).padStart(2, "0")}`);
}

export function expiryLabel(unixSeconds) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(unixSeconds * 1000));
}

// ---------------------------------------------------------------------------------------------
// Qualification
// ---------------------------------------------------------------------------------------------

export class DataError extends Error {}

const isMoney = (m) =>
  m !== null && typeof m === "object" && typeof m.raw === "string" && UINT_RE.test(m.raw) &&
  Number.isInteger(m.decimals) && m.decimals >= 0 && typeof m.formatted === "string";

/** Throws DataError unless `win` has the §4 Win shape this script relies on. */
export function assertWinShape(win, where) {
  const bad = (what) => {
    throw new DataError(`${where}: ${what}`);
  };
  if (win === null || typeof win !== "object") bad("not a Win object");
  if (typeof win.id !== "string" || !PNL_ID_RE.test(win.id)) bad(`id ${JSON.stringify(win.id)} is not a share-page id`);
  if (typeof win.holder !== "string" || !ADDRESS_RE.test(win.holder)) bad("holder is not an address");
  if (typeof win.ticker !== "string" || !/^[A-Z0-9.]{1,12}$/.test(win.ticker)) bad(`ticker ${JSON.stringify(win.ticker)}`);
  const s = win.series;
  if (s === null || typeof s !== "object") bad("series missing");
  if (typeof s.longId !== "string" || !UINT_RE.test(s.longId)) bad("series.longId is not a decimal id");
  if (s.ticker !== win.ticker) bad(`series.ticker ${JSON.stringify(s.ticker)} differs from ticker ${JSON.stringify(win.ticker)}`);
  if (typeof s.isPut !== "boolean") bad("series.isPut is not a boolean");
  if (!isMoney(s.strike)) bad("series.strike is not Money");
  if (!Number.isInteger(s.expiry) || s.expiry < 0) bad("series.expiry is not unix seconds");
  if (typeof s.status !== "string") bad("series.status missing");
  if (!isMoney(win.cost)) bad("cost is not Money");
  if (!isMoney(win.payout)) bad("payout is not Money");
  if (win.cost.decimals !== USDG_DECIMALS || win.payout.decimals !== USDG_DECIMALS) bad("cost and payout must be USDG (6 dp)");
  if (typeof win.multiple !== "number" || !Number.isFinite(win.multiple) || win.multiple < 0) bad("multiple is not a number");
  if (!Number.isInteger(win.settledAt) || win.settledAt < 0) bad("settledAt is not unix seconds");
  if (typeof win.tx !== "string" || !TX_RE.test(win.tx)) bad("tx is not a transaction hash");
  // The indexer keys positions by the lowercase holder (indexer/src/v2/pnl.ts positionId); the
  // fixtures use the checksummed one. Either is the same position; the link uses the id as given.
  if (win.id.toLowerCase() !== `${s.longId}-${win.holder}`.toLowerCase()) bad("id is not `${longId}-${holder}`");
  return win;
}

/**
 * The qualification rule (header, 1-5; 6 needs the network and lives in run()). Returns
 * `{ ok: true }` or `{ ok: false, reason }`; throws DataError on self-contradicting data.
 */
export function qualify(win, { window, now }) {
  const field = window === "week" ? "biggestWinWeek" : "biggestWinDay";
  if (win === null || win === undefined) return { ok: false, reason: `${field} is null: no qualifying win settled in this window` };
  assertWinShape(win, `/v2/stats ${field}`);
  if (win.series.status !== "settled") {
    return { ok: false, reason: `${win.id}: series status is ${JSON.stringify(win.series.status)}, not "settled"` };
  }
  const cost = BigInt(win.cost.raw);
  const payout = BigInt(win.payout.raw);
  if (cost < MIN_COST_RAW) {
    return { ok: false, reason: `${win.id}: cost ${trimAmount(win.cost.formatted)} USDG is under the 0.10 USDG floor` };
  }
  if (payout <= cost) {
    return { ok: false, reason: `${win.id}: payout ${trimAmount(win.payout.formatted)} USDG is not above cost ${trimAmount(win.cost.formatted)} USDG` };
  }
  // The indexer's multiple is payout / cost (6 dp, or 2 dp rounded down); anything further off is corrupt data.
  const ratio = Number((payout * 1_000_000n) / cost) / 1_000_000;
  if (Math.abs(ratio - win.multiple) > 0.01) {
    throw new DataError(`${win.id}: multiple ${win.multiple} does not match payout / cost = ${ratio}`);
  }
  if (payout * 100n < cost * MIN_MULTIPLE_X100) {
    return { ok: false, reason: `${win.id}: ${multipleLabel(cost, payout)}x is under the ${trimAmount(String(Number(MIN_MULTIPLE_X100) / 100))}x floor` };
  }
  const age = now - win.settledAt;
  if (age > MAX_AGE_SECONDS[window]) {
    return { ok: false, reason: `${win.id}: settled ${(age / 3600).toFixed(1)} h before now, older than the ${MAX_AGE_SECONDS[window] / 3600} h ${window} limit` };
  }
  return { ok: true };
}

/** The /v2/pnl/:id answer must be the same win the stats named. */
export function assertPnlMatches(win, pnl) {
  assertWinShape(pnl, `/v2/pnl/${win.id}`);
  const fields = [
    ["id", (w) => w.id],
    ["holder", (w) => w.holder.toLowerCase()],
    ["series.longId", (w) => w.series.longId],
    ["cost.raw", (w) => w.cost.raw],
    ["payout.raw", (w) => w.payout.raw],
    ["settledAt", (w) => w.settledAt],
    ["tx", (w) => w.tx],
  ];
  for (const [name, get] of fields) {
    if (get(win) !== get(pnl)) {
      throw new DataError(`/v2/pnl/${win.id} disagrees with /v2/stats on ${name}: ${JSON.stringify(get(pnl))} vs ${JSON.stringify(get(win))}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The post
// ---------------------------------------------------------------------------------------------

/** W2-09's routes: web/app/pnl/[id]/page.tsx, .../opengraph-image.tsx, web/app/api/pnl/[id]/image/route.tsx. */
export function shareUrls(appUrl, id) {
  const base = appUrl.replace(/\/+$/, "");
  const seg = encodeURIComponent(id);
  return {
    page: `${base}/pnl/${seg}`,
    image: `${base}/api/pnl/${seg}/image`,
    squareImage: `${base}/api/pnl/${seg}/image?format=square`,
    ogImage: `${base}/pnl/${seg}/opengraph-image`,
  };
}

/** Builds the post for a qualified win and runs checkPost on it (throws PostCheckError). */
export function buildPost(win, { window, appUrl = DEFAULT_APP_URL }) {
  const urls = shareUrls(appUrl, win.id);
  const lead = window === "week" ? "This week's" : "Today's";
  const option = `${win.series.ticker} $${trimAmount(win.series.strike.formatted)} ${win.series.isPut ? "put" : "call"}`;
  const cost = fixedMoney(win.cost.raw, win.cost.decimals, 2, "up");
  const payout = fixedMoney(win.payout.raw, win.payout.decimals, 2, "down");
  const multiple = multipleLabel(win.cost.raw, win.payout.raw);
  const text = [
    `${lead} biggest win on Stonkhouse: ${option}, expired ${expiryLabel(win.series.expiry)}. ` +
      `The buyer paid ${cost} USDG, and the most they could lose was ${cost} USDG. ` +
      `It settled for ${payout} USDG, ${multiple}x the cost.`,
    DISCLAIMER,
    `Receipt: ${urls.page}`,
  ].join("\n");
  assertPost(text);
  return { text, weight: weightedLength(text), urls };
}

// ---------------------------------------------------------------------------------------------
// X: OAuth 1.0a (HMAC-SHA1) and POST /2/tweets
// ---------------------------------------------------------------------------------------------

/** RFC 3986 percent-encoding, as OAuth 1.0a requires. */
export function percentEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * The RFC 5849 §3.4.1 signature base string. `params` are the form-body parameters (a JSON body is
 * not signed); query parameters are taken from `url`.
 */
export function signatureBaseString(method, url, params) {
  const u = new URL(url);
  const pairs = [];
  for (const [k, v] of u.searchParams) pairs.push([percentEncode(k), percentEncode(v)]);
  for (const [k, v] of Object.entries(params)) pairs.push([percentEncode(k), percentEncode(v)]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const normalized = pairs.map(([k, v]) => `${k}=${v}`).join("&");
  const baseUrl = `${u.protocol}//${u.host.toLowerCase()}${u.pathname}`;
  return `${method.toUpperCase()}&${percentEncode(baseUrl)}&${percentEncode(normalized)}`;
}

/** The `Authorization: OAuth ...` header value for one request. */
export function oauth1Header({ method, url, consumerKey, consumerSecret, token, tokenSecret, params = {}, nonce, timestamp }) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce ?? randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(timestamp ?? Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: "1.0",
  };
  const base = signatureBaseString(method, url, { ...params, ...oauth });
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  const signature = createHmac("sha1", key).update(base).digest("base64");
  const header = { ...oauth, oauth_signature: signature };
  return `OAuth ${Object.keys(header)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(header[k])}"`)
    .join(", ")}`;
}

/** `{ creds, missing }`: creds only when all four are non-empty. Values never leave this process's memory. */
export function readXCredentials(env) {
  const missing = X_ENV.filter((name) => typeof env[name] !== "string" || env[name].trim() === "");
  if (missing.length > 0) return { creds: null, missing };
  return {
    creds: {
      consumerKey: env.X_CONSUMER_KEY.trim(),
      consumerSecret: env.X_CONSUMER_SECRET.trim(),
      token: env.X_ACCESS_TOKEN.trim(),
      tokenSecret: env.X_ACCESS_SECRET.trim(),
    },
    missing: [],
  };
}

/** One POST /2/tweets. Returns the new post's id; throws with the API's status and body (never the header). */
export async function postToX({ apiBase, text, creds }) {
  const url = `${apiBase.replace(/\/+$/, "")}/2/tweets`;
  const authorization = oauth1Header({ method: "POST", url, ...creds });
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: authorization, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.text();
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`X answered ${res.status}: ${body.slice(0, 500)}`);
  }
  let id;
  try {
    id = JSON.parse(body)?.data?.id;
  } catch {
    id = undefined;
  }
  if (typeof id !== "string") throw new Error(`X answered ${res.status} without data.id: ${body.slice(0, 500)}`);
  return id;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE = `usage: node ops/v2/daily-win.mjs [--window day|week] [--now <unix seconds>] [--post]

  dry run by default: prints the post, the share page and image URLs, or why the day is skipped
  --window   day (default, /v2/stats biggestWinDay) or week (biggestWinWeek)
  --now      evaluate the freshness rule as of this time (default: the clock); the fixtures' now is 1789592400
  --post     post to X; needs ${X_ENV.join(", ")} in the environment
env: INDEXER_URL (default ${DEFAULT_INDEXER_URL}), APP_URL (default ${DEFAULT_APP_URL})`;

class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { window: "day", now: null, post: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].includes("=") ? [argv[i].slice(0, argv[i].indexOf("=")), argv[i].slice(argv[i].indexOf("=") + 1)] : [argv[i], undefined];
    const value = () => {
      const v = inline ?? argv[++i];
      if (v === undefined) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    if (flag === "--post" && inline === undefined) opts.post = true;
    else if (flag === "--help" || flag === "-h") opts.help = true;
    else if (flag === "--window") {
      opts.window = value();
      if (!["day", "week"].includes(opts.window)) throw new UsageError(`--window must be day or week, not ${JSON.stringify(opts.window)}`);
    } else if (flag === "--now") {
      const v = value();
      if (!/^\d{1,12}$/.test(v)) throw new UsageError(`--now must be unix seconds, not ${JSON.stringify(v)}`);
      opts.now = Number(v);
    } else throw new UsageError(`unknown argument ${JSON.stringify(argv[i])}`);
  }
  return opts;
}

async function getJson(url) {
  let res;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new Error(`GET ${url} failed: ${err.cause?.code ?? err.message}`);
  }
  const body = await res.text();
  let json = null;
  try {
    json = JSON.parse(body);
  } catch {
    if (res.ok) throw new Error(`GET ${url}: ${res.status} with a body that is not JSON`);
  }
  return { status: res.status, ok: res.ok, json };
}

async function preflight(url, wantImage) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    return `GET ${url} failed: ${err.cause?.code ?? err.message}`;
  }
  await res.arrayBuffer().catch(() => undefined);
  if (res.status !== 200) return `GET ${url} answered ${res.status}`;
  if (wantImage && !(res.headers.get("content-type") ?? "").startsWith("image/png")) {
    return `GET ${url} is not image/png (${res.headers.get("content-type")})`;
  }
  return null;
}

/** Runs the CLI; returns the exit code. `out`/`err` are line writers (console by default). */
export async function run(argv, env = process.env, out = console.log, err = console.error) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`daily-win: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    out(USAGE);
    return 0;
  }

  let creds = null;
  if (opts.post) {
    const read = readXCredentials(env);
    if (read.missing.length > 0) {
      err(`daily-win: refusing to post: ${read.missing.join(", ")} ${read.missing.length === 1 ? "is" : "are"} not set. ` +
        `--post needs all four of ${X_ENV.join(", ")} in the environment. Nothing was posted; run without --post for a dry run.`);
      return 1;
    }
    creds = read.creds;
  }

  const indexer = (env.INDEXER_URL || DEFAULT_INDEXER_URL).replace(/\/+$/, "");
  const appUrl = (env.APP_URL || DEFAULT_APP_URL).replace(/\/+$/, "");
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const field = opts.window === "week" ? "biggestWinWeek" : "biggestWinDay";

  try {
    const stats = await getJson(`${indexer}/v2/stats`);
    if (!stats.ok || stats.json === null || typeof stats.json !== "object" || !(field in stats.json)) {
      throw new Error(`GET ${indexer}/v2/stats answered ${stats.status} without ${field}`);
    }
    const win = stats.json[field];
    const verdict = qualify(win, { window: opts.window, now });
    if (!verdict.ok) {
      out(`daily-win: skip (${opts.window}): ${verdict.reason}. Nothing to post.`);
      return 0;
    }

    const pnl = await getJson(`${indexer}/v2/pnl/${encodeURIComponent(win.id)}`);
    if (pnl.status === 404) {
      out(`daily-win: skip (${opts.window}): ${win.id}: /v2/pnl answered 404, so the share page has no receipt to show. Nothing to post.`);
      return 0;
    }
    if (!pnl.ok) throw new Error(`GET ${indexer}/v2/pnl/${win.id} answered ${pnl.status}`);
    assertPnlMatches(win, pnl.json);

    const post = buildPost(win, { window: opts.window, appUrl });
    out(`daily-win: ${opts.post ? "posting" : "dry run, nothing posted"} (${opts.window}, ${field} from ${indexer})`);
    out(`win:          ${win.id}`);
    out(`page:         ${post.urls.page}`);
    out(`image:        ${post.urls.image}  (1200x630)`);
    out(`square image: ${post.urls.squareImage}  (1080x1080)`);
    out(`og image:     ${post.urls.ogImage}  (the card X unfurls from the page)`);
    out(`length:       ${post.weight}/${MAX_POST_WEIGHT} (the URL counts as ${URL_WEIGHT})`);
    out("----- post -----");
    out(post.text);
    out("----- end -----");

    if (!opts.post) {
      out(`To post it: node ops/v2/daily-win.mjs${opts.window === "week" ? " --window week" : ""} --post  (with ${X_ENV.join(", ")} set; ops/README.md)`);
      return 0;
    }

    for (const [url, image] of [[post.urls.page, false], [post.urls.image, true]]) {
      const problem = await preflight(url, image);
      if (problem) {
        err(`daily-win: refusing to post: ${problem}; the post would link a broken page. Nothing was posted.`);
        return 1;
      }
    }
    const apiBase = (env.X_API_BASE || DEFAULT_X_API_BASE).replace(/\/+$/, "");
    const id = await postToX({ apiBase, text: post.text, creds });
    out(`posted: https://x.com/i/web/status/${id}`);
    return 0;
  } catch (e) {
    if (e instanceof PostCheckError || e instanceof DataError) {
      err(`daily-win: ${e.message}`);
      return 1;
    }
    err(`daily-win: error, nothing posted: ${e.message}`);
    return 1;
  }
}

const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  process.exitCode = await run(process.argv.slice(2));
}
