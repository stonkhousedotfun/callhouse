#!/usr/bin/env node
/**
 * ops/fixtures/api/v2/gen.mjs — writes every indexer API v2 fixture in this directory.
 *
 *   node ops/fixtures/api/v2/gen.mjs           # (re)write the fixtures, delete stale ones
 *   node ops/fixtures/api/v2/gen.mjs --check   # exit 1 if a file on disk differs or is missing/extra
 *
 * WHY A GENERATOR. The fixtures are the wire contract W2 (web) and S2 (site) build against until
 * the devnet exists, and every number in them is load-bearing: a longId that is not
 * keccak256(abi.encode(underlying, isPut, strike, expiry)) & ~1 would send a dapp to a series that
 * does not exist; a `formatted` that disagrees with `raw` would hide a decimals bug; a card whose
 * multiple does not follow ADR-12 would teach the UI a headline the contracts cannot pay. So no
 * id, no Money and no derived figure below is typed by hand. What IS typed by hand is the
 * scenario: who traded what, at which spot, when, and at what price where a human (not the
 * pricing model) chose it. Everything the indexer would derive — balances, open interest,
 * volumes, fees, rebates, payouts, wins, the leaderboard, cards — is derived here from those
 * events by the same rules as indexer/src/api/v2/, so the files are
 * internally consistent by construction. web/lib/v2/api-schema.test.ts re-checks the parts that
 * matter from the outside and runs this script with --check, so a hand edit to a JSON file is a
 * red test, not a silent drift.
 *
 * THE SCENARIO ("now" = 1789592400 = Wed 2026-09-16 21:00Z = 17:00 New York, after the close).
 * README.md in this directory has the full table. In short: NVDA (two sources) and TSLA
 * (Chainlink only), calls only; a settled ITM NVDA weekly (Fri 09-11) with wins, losses, one
 * position below the 0.10 USDG integrity floor and one holder the cranker cannot redeem; an NVDA
 * daily (09-16) waiting as an uncorroborated candidate; a TSLA daily (09-15) the guardian vetoed;
 * live books on NVDA 09-17 / 09-18 / 09-25 and TSLA 09-18; an empty TSLA 09-25 ladder; the
 * protocol MakerVault, a manual writer and an AutoRoller writer as makers.
 *
 * DELIBERATELY ABSENT: randomness and the wall clock (output must be byte-stable), any network,
 * and any dependency outside the workspace (viem resolves from web/, like the dapp's own).
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..", "..");
const require = createRequire(join(REPO, "web", "package.json"));
const { encodeAbiParameters, formatUnits, getAddress, keccak256, parseUnits, toHex } = require("viem");

// =============================================================================================
// Units, constants, helpers
// =============================================================================================

const DAY = 86_400;
const YEAR = 365 * DAY;

/** ISO → unix seconds; refuses anything that is not a whole second. */
function at(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms % 1000 !== 0) throw new Error(`bad timestamp ${iso}`);
  return ms / 1000;
}

// Prices are USDG base units per whole share; units are 0.01 share.
const UNIT = 10n ** 16n;
const UNITS_PER_SHARE = 100n;
const PRICE_TICK = 100n;
const BPS = 10_000n;
const WAD = 10n ** 18n;
const SETTLEMENT_WINDOW = 1800;
const FINALIZE_DELAY = 120;
const SNAPSHOT_GRACE = 600;
const RESOLVE_DELAY = 48 * 3600;
const MAX_TENOR = 45 * DAY;
const MIN_SERIES_LEAD = 3600;
const EXERCISE_FEE_MAX_PAYOUT_SHARE_BPS = 1000n;
const INTERFACE_VERSION = 8;
const MINT_FEE_PERIOD = 604800;
const MINT_FEE_CEIL_PPM = 5000;
const CHAIN_ID = 4663;

// The registry's v2 `fees` block, copied exactly from ops/markets/tier1.json:133-140 rather than
// read at generation time so a registry edit cannot silently rewrite the fixture wire contract:
// premium 500 bps, rent 0 ppm, resale 0 bps, taker 100000 / 1000 bps, rebate 5000 bps, exercise 25 bps.
const FEES = {
  premiumFeeBps: 500n,
  mintFeePpm: 0n,
  resaleFeeBps: 0n,
  takerFeeFlat: 100_000n,
  takerFeeCapBps: 1000n,
  makerRebateBps: 5000n,
  exerciseFeeBps: 25n,
};
const LADDER = {
  weekly: { rungs: 5, firstOtmBps: 200, stepBps: 200, cardTargetBps: 400 },
  daily: { rungs: 5, firstOtmBps: 100, stepBps: 100, cardTargetBps: 200 },
};
const UNCORROBORATED_DELAY = 21_600;

const NOW = 1_789_592_400;
if (NOW !== at("2026-09-16T21:00:00Z")) throw new Error("NOW drifted");

/** Expiries: 16:00 New York (EDT) = 20:00Z on each date. */
const EXPIRY = {
  "09-11": 1_789_156_800, // Fri, weekly — settled
  "09-15": 1_789_502_400, // Tue, daily — TSLA held
  "09-16": 1_789_588_800, // Wed, daily — NVDA candidate
  "09-17": 1_789_675_200, // Thu, daily
  "09-18": 1_789_761_600, // Fri, weekly
  "09-25": 1_790_366_400, // Fri, weekly
};
for (const [d, ts] of Object.entries(EXPIRY)) {
  if (ts !== at(`2026-${d}T20:00:00Z`)) throw new Error(`expiry ${d} is not 20:00Z`);
}

const USDG = { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6 };

const min = (a, b) => (a < b ? a : b);
const max = (a, b) => (a > b ? a : b);
const ceilDiv = (a, b) => (a + b - 1n) / b;
const rentNumerator = (s, units, ts) => units * UNIT * BigInt(s.mintFeePpm) * BigInt(Math.max(0, s.expiry - ts));
const mintRent = (s, units, ts) => ceilDiv(rentNumerator(s, units, ts), 1_000_000n * BigInt(MINT_FEE_PERIOD));
const capacity = (s, free, ts) => {
  let lo = 0n, hi = free / UNIT;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (mid * UNIT + mintRent(s, mid, ts) <= free) lo = mid; else hi = mid - 1n;
  }
  return lo;
};
const usd = (s) => parseUnits(s, 6);
const tokens = (s) => parseUnits(s, 18);
const money = (raw, decimals) => ({ raw: raw.toString(), decimals, formatted: formatUnits(raw, decimals) });
const usdg = (raw) => money(raw, 6);
/** A ratio of two positive bigints as a number rounded DOWN to 2 dp: a headline never rounds up. */
const multipleOf = (num, den) => Number((num * 100n) / den) / 100;
const sumBy = (xs, f) => xs.reduce((a, x) => a + f(x), 0n);

/** Plausible, stable, checksummed addresses and tx hashes: keccak of a label. */
const derive = (label) => getAddress(`0x${keccak256(toHex(`stonkhouse.fixtures.v2:${label}`)).slice(-40)}`);
const txHash = (label) => keccak256(toHex(`stonkhouse.fixtures.v2.tx:${label}`));

/** Long ID encoding, mirrored from ops/shared/v2/seriesId.ts: keccak256(abi.encode(...)) & ~1. */
function longIdOf(underlying, isPut, strike, expiry) {
  const encoded = encodeAbiParameters(
    [{ type: "address" }, { type: "bool" }, { type: "uint128" }, { type: "uint40" }],
    [underlying, isPut, strike, expiry],
  );
  return BigInt(keccak256(encoded)) & ~1n;
}

/**
 * Block numbers: anchored on the registry's verifiedAtBlock (64151977 at 2026-09-16T02:30:56Z),
 * advancing 4 blocks a second (4663 is a sub-second Orbit chain). Only monotonic matters.
 */
const blockAt = (ts) => 64_151_977n + (BigInt(ts) - BigInt(at("2026-09-16T02:30:56Z"))) * 4n;

// =============================================================================================
// Markets and actors
// =============================================================================================

const MARKETS = {
  NVDA: {
    ticker: "NVDA",
    name: "NVIDIA • Robinhood Token",
    underlying: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    // T-OP-099. In the owner's launch set (tier1.json launchSet: NVDA, SPCX).
    launch: true,
    strikeTick: usd("1"),
    spot: usd("215.50"),
    spotUpdatedAt: at("2026-09-16T20:05:12Z"),
    // Routed pooled market: Chainlink + Uniswap v3 sources, the default uncorroborated delay and an
    // illustrative v3 USDG conversion route. A v3 payoutRoute has only venue + fee; it does not expose
    // the settlement TWAP pool or invent a payout-pool address (build-markets.mjs:324-327).
    settlement: { sourceCount: 2, uncorroboratedDelayS: UNCORROBORATED_DELAY, route: { venue: "v3", fee: 100 } },
    baseIv: 0.42,
    // Cboe expiries listed for the root on 09-16 (tier1.json cboe.expiries): Thu 09-17 is not
    // one, so the pricing service interpolates it ("model"); 09-18 and 09-25 are "cboe".
    cboeExpiries: [EXPIRY["09-16"], EXPIRY["09-18"], EXPIRY["09-25"]],
    mvSeriesCapUnits: 400n,
    mvQuoteUnits: 250n,
  },
  TSLA: {
    ticker: "TSLA",
    name: "Tesla • Robinhood Token",
    underlying: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    // T-OP-099. Registered and live on chain in this fixture, yet NOT in the launch set: the shape a
    // `--wave wave1` broadcast would produce, and the case the app must render as deferred.
    launch: false,
    strikeTick: usd("5"),
    spot: usd("355.85"),
    spotUpdatedAt: at("2026-09-16T20:04:40Z"),
    // Single-source market: Chainlink only, the one-hour uncorroborated delay and no conversion route, so
    // winning calls pay Stock Tokens in kind.
    settlement: { sourceCount: 1, uncorroboratedDelayS: 3_600, route: null },
    baseIv: 0.55,
    cboeExpiries: [EXPIRY["09-16"], EXPIRY["09-18"], EXPIRY["09-25"]],
    mvSeriesCapUnits: 120n,
    mvQuoteUnits: 120n,
  },
};
const marketByUnderlying = new Map(Object.values(MARKETS).map((m) => [m.underlying, m]));

const CONTRACTS = {
  clearinghouse: derive("contract:Clearinghouse"),
  orderBook: derive("contract:OrderBook"),
  settlementOracle: derive("contract:SettlementOracle"),
  expiryCalendar: derive("contract:ExpiryCalendar"),
  keeperRewards: derive("contract:KeeperRewards"),
  autoRoller: derive("contract:AutoRoller"),
  payoutAdapter: derive("contract:PayoutAdapter"),
  makerVault: derive("contract:MakerVault"),
  makerRegistry: derive("contract:MakerRegistry"),
  rewardsDistributor: derive("contract:RewardsDistributor"),
  accessManager: derive("contract:AccessManager"),
  sources: { chainlink: derive("contract:ChainlinkFeedSource"), univ3: derive("contract:UniV3TwapSource"), dataStreams: null },
};

const FLYWHEEL = {
  feeSplitter: derive("contract:FeeSplitter"),
  buybackExecutor: derive("contract:V4BuybackExecutor"),
};
const SAFES = {
  admin: derive("account:safe.admin"),
  treasury: derive("account:safe.treasury"),
};
const KEYS = {
  guardian: derive("account:key.guardian"),
  pricer: derive("account:key.pricer"),
  quoter: derive("account:key.quoter"),
  cranker: derive("account:key.cranker"),
};

// Role ids, names and intended holders mirror ops/abis/v2/roles.json. `delayS` on a role is the
// chain's AccessManager grant delay (0 in this scenario); each holder's `delayS` is its chain
// execution delay. They are deliberately distinct fields even when the manifest happens to
// prescribe the same number for another purpose.
const ACCESS_ROLES = [
  { id: 0, name: "ADMIN", delayS: 0, holders: [{ address: SAFES.admin, delayS: 172_800 }] },
  { id: 1, name: "FEE_MANAGER", delayS: 0, holders: [{ address: SAFES.admin, delayS: 172_800 }] },
  { id: 2, name: "MARKET_FEE_MANAGER", delayS: 0, holders: [{ address: SAFES.admin, delayS: 259_200 }] },
  { id: 3, name: "CONFIG_ADMIN", delayS: 0, holders: [{ address: SAFES.admin, delayS: 86_400 }] },
  { id: 4, name: "TREASURY_ADMIN", delayS: 0, holders: [{ address: SAFES.admin, delayS: 86_400 }] },
  { id: 5, name: "LISTING", delayS: 0, holders: [{ address: SAFES.admin, delayS: 3_600 }] },
  { id: 6, name: "OPS_ADMIN", delayS: 0, holders: [{ address: SAFES.admin, delayS: 0 }] },
  { id: 7, name: "GUARDIAN", delayS: 0, holders: [{ address: SAFES.admin, delayS: 0 }, { address: KEYS.guardian, delayS: 0 }] },
  { id: 8, name: "PRICER", delayS: 0, holders: [{ address: KEYS.pricer, delayS: 0 }] },
  { id: 9, name: "QUOTER", delayS: 0, holders: [{ address: SAFES.admin, delayS: 0 }, { address: KEYS.quoter, delayS: 0 }] },
  { id: 10, name: "BUYBACK", delayS: 0, holders: [{ address: KEYS.cranker, delayS: 0 }] },
];

// The nonce is part of the row's identity, not decoration: AccessManager REUSES an operation id
// when the same call is rescheduled, so `id` alone repeats and `operationId:nonce` does not. The
// indexer keys its row the same way (indexer/src/v2/accessManager.ts:135-137).
const SET_DEFAULT_ORACLE_OPERATION = txHash("operation:setDefaultOracle");

const PENDING_OPERATIONS = [
  {
    key: `${SET_DEFAULT_ORACLE_OPERATION}:1`,
    id: SET_DEFAULT_ORACLE_OPERATION,
    role: "CONFIG_ADMIN",
    target: CONTRACTS.clearinghouse,
    selector: keccak256(toHex("setDefaultOracle(address)")).slice(0, 10),
    label: "Clearinghouse.setDefaultOracle(address)",
    caller: SAFES.admin,
    scheduledAt: NOW - 3_600,
    readyAt: NOW - 3_600 + 86_400,
  },
];

const A = {
  makerVault: CONTRACTS.makerVault,
  manual: derive("account:writer.manual"),
  /** writer.manual's proceeds wallet: the TakeParams.recipient of its sale into a bid. */
  manualTreasury: derive("account:writer.manual.treasury"),
  roller: derive("account:writer.roller"),
  sam: derive("account:buyer.sam"),
  ape: derive("account:buyer.ape"),
  degen: derive("account:buyer.degen"),
  lucy: derive("account:buyer.lucy"),
  otto: derive("account:buyer.otto"),
};

/**
 * Payout preferences. sam is a contract wallet that turned third-party redemption OFF, so the
 * cranker cannot push his payout and his settled long stays `claimable` — the one realistic
 * reason a position is still unredeemed five days after settlement. lucy takes payouts in kind.
 */
const PREFS = new Map([
  [A.sam, { inKind: false, toLedger: false, thirdPartyRedeem: false }],
  [A.lucy, { inKind: true, toLedger: false, thirdPartyRedeem: true }],
  [A.roller, { inKind: false, toLedger: true, thirdPartyRedeem: true }],
  [A.makerVault, { inKind: true, toLedger: true, thirdPartyRedeem: true }],
]);
const prefsOf = (a) => PREFS.get(a) ?? { inKind: false, toLedger: false, thirdPartyRedeem: true };

/** MakerRegistry tiers (effective rebate bps). */
const TIER = new Map([[A.manual, 6000n]]);
const rebateBpsOf = (maker) => TIER.get(maker) ?? FEES.makerRebateBps;

/** The AutoRoller writer's V2Types.Strategy. */
const ROLLER_STRATEGY = {
  active: true,
  weekly: true,
  smartPricing: false,
  otmBps: 450,
  askBps: 12,
  minAskBps: 5,
  maxAskBps: 50,
  maxUnits: 0n,
};

/** MakerVault quoting rule used for both historical fills and the live book (K2 owns the real one). */
const MV_ASK_MARKUP_BPS = 10_800n;
const MV_BID_MARKDOWN_BPS = 9_200n;
const MV_MIN_ASK = usd("0.25");
const MV_MIN_BID = usd("0.05");
const MV_BID_UNITS = 100n;

// =============================================================================================
// Pricing model (stands in for the pricing service: Black-Scholes, r = 0, a mild smile)
// =============================================================================================

/** Abramowitz-Stegun 26.2.17; pure arithmetic, so byte-stable across runs. */
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp((-x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}
const round4 = (x) => Math.round(x * 1e4) / 1e4;

/** Fair value per whole share (USDG raw), IV and delta of a call at `spot` and time `ts`; null once expired. */
function fairOf(s, spot, ts) {
  const t = (s.expiry - ts) / YEAR;
  if (t <= 0) return null;
  const S = Number(spot) / 1e6;
  const K = Number(s.strike) / 1e6;
  const iv = round4(s.market.baseIv + 0.25 * Math.abs(Math.log(K / S)));
  const v = iv * Math.sqrt(t);
  const d1 = (Math.log(S / K) + (v * v) / 2) / v;
  const price = S * normCdf(d1) - K * normCdf(d1 - v);
  return {
    fair: BigInt(Math.max(0, Math.floor(price * 1e6))),
    iv,
    delta: round4(normCdf(d1)),
    source: s.market.cboeExpiries.includes(s.expiry) ? "cboe" : "model",
  };
}
const tickUp = (p) => ceilDiv(p, PRICE_TICK) * PRICE_TICK;
const tickDown = (p) => (p / PRICE_TICK) * PRICE_TICK;
const mvAskPrice = (fair) => max(tickUp((fair * MV_ASK_MARKUP_BPS) / BPS), MV_MIN_ASK);
const mvBidPrice = (fair) => tickDown((fair * MV_BID_MARKDOWN_BPS) / BPS);

// =============================================================================================
// Series universe
// =============================================================================================

/**
 * Cranker ladders (ops/markets/tier1.json defaults): rung i strike = roundUp(spot × (1 + (first +
 * i·step) bps), strikeTick). Rungs that round to the same strike collapse, so the TSLA daily
 * ladder ($5 tick, 1 % steps ≈ $3.50) has 4 strikes, not 5. `createSpot` is the spot when the
 * cranker created the ladder; it is not on the wire.
 */
const LADDERS = [
  { ticker: "NVDA", date: "09-11", tenor: "weekly", createSpot: usd("205.65") },
  { ticker: "TSLA", date: "09-15", tenor: "daily", createSpot: usd("349.00") },
  { ticker: "NVDA", date: "09-16", tenor: "daily", createSpot: usd("212.40") },
  { ticker: "NVDA", date: "09-17", tenor: "daily", createSpot: usd("213.80") },
  { ticker: "NVDA", date: "09-18", tenor: "weekly", createSpot: usd("209.30") },
  { ticker: "TSLA", date: "09-18", tenor: "weekly", createSpot: usd("348.20") },
  { ticker: "NVDA", date: "09-25", tenor: "weekly", createSpot: usd("212.40") },
  { ticker: "TSLA", date: "09-25", tenor: "weekly", createSpot: usd("355.85"), quoted: false },
];

const SERIES = [];
const seriesByKey = new Map();

function addSeries(ticker, date, tenor, strike, extra = {}) {
  const market = MARKETS[ticker];
  const expiry = EXPIRY[date];
  if (strike % market.strikeTick !== 0n) throw new Error(`strike ${strike} off tick for ${ticker}`);
  const key = `${ticker}-${date}-${formatUnits(strike, 6)}`;
  if (seriesByKey.has(key)) return seriesByKey.get(key);
  const longId = longIdOf(market.underlying, false, strike, expiry);
  const s = {
    key,
    ticker,
    market,
    date,
    isPut: false,
    strike,
    expiry,
    tenor,
    mintCutoff: expiry - SETTLEMENT_WINDOW,
    mintFeePpm: 0,
    mintFeesHeld: 0n,
    mintFeesAccrued: 0n,
    longId,
    shortId: longId | 1n,
    quoted: true,
    settledAt: null,
    settleTx: null,
    payout: null,
    // state, advanced by the event replay below
    long: new Map(),
    escrow: new Map(),
    short: new Map(),
    supply: 0n,
    lots: new Map(), // holder -> [{ units, cost }] FIFO, cost in USDG raw incl. taker fees
    fills: [],
    ...extra,
  };
  SERIES.push(s);
  seriesByKey.set(key, s);
  return s;
}

for (const l of LADDERS) {
  const m = MARKETS[l.ticker];
  const { rungs, firstOtmBps, stepBps } = LADDER[l.tenor];
  for (let i = 0; i < rungs; i++) {
    const bps = BigInt(firstOtmBps + i * stepBps);
    const strike = ceilDiv(l.createSpot * (BPS + bps), BPS * m.strikeTick) * m.strikeTick;
    addSeries(l.ticker, l.date, l.tenor, strike, { quoted: l.quoted !== false });
  }
}

/** Looks a series up by ticker, expiry date and strike in dollars. */
function S(ticker, date, strikeDollars) {
  const s = seriesByKey.get(`${ticker}-${date}-${strikeDollars}`);
  if (!s) throw new Error(`no series ${ticker}-${date}-${strikeDollars}`);
  return s;
}

// =============================================================================================
// Oracle state per (underlying, expiry)
// =============================================================================================

const ORACLE = new Map([
  // Both NVDA sources agreed within maxDeviationBps: final at the first finalize after the delay.
  [`NVDA:${EXPIRY["09-11"]}`, { status: "Finalized", price: usd("219.40"), finalizedAt: EXPIRY["09-11"] + 125, sourceIndex: 0, corroborated: true }],
  // TSLA is Chainlink-only, so every TSLA settlement is uncorroborated. The 09-15 candidate sat
  // 4 % above the close and the guardian vetoed it: held until unveto or adminResolve.
  [
    `TSLA:${EXPIRY["09-15"]}`,
    { status: "Held", candidate: { price: usd("371.35"), sourceIndex: 0, disagreed: false, since: EXPIRY["09-15"] + FINALIZE_DELAY } },
  ],
  // The keeper missed the Uniswap snapshot window, so only Chainlink is ok: a candidate that
  // finalizes 6 h after it was first seen unless vetoed.
  [
    `NVDA:${EXPIRY["09-16"]}`,
    { status: "Pending", candidate: { price: usd("215.62"), sourceIndex: 0, disagreed: false, since: EXPIRY["09-16"] + FINALIZE_DELAY } },
  ],
]);
const oracleOf = (s) => ORACLE.get(`${s.ticker}:${s.expiry}`) ?? null;

/** Call-option settlement payout, mirrored from contract OptionMath. */
function settlementPayouts(s, price) {
  const gross = price > s.strike ? (UNIT * (price - s.strike)) / price : 0n;
  const fee = gross === 0n ? 0n : min((UNIT * FEES.exerciseFeeBps) / BPS, (gross * EXERCISE_FEE_MAX_PAYOUT_SHARE_BPS) / BPS);
  const out = { gross, long: gross - fee, fee, short: UNIT - gross };
  if (out.long + out.fee + out.short !== UNIT) throw new Error(`OptionMath identity broken for ${s.key}`);
  return out;
}

/** Stock Token amount → USDG raw at a price per whole share. */
const valueAt = (amount, price) => (amount * price) / WAD;

function statusOf(s) {
  if (s.settledAt !== null) return "settled";
  const o = oracleOf(s);
  if (NOW >= s.expiry && o?.status === "Held") return "held";
  if (NOW >= s.expiry && o?.status === "Pending") return "settling";
  if (NOW >= s.expiry) return "expired";
  if (NOW >= s.mintCutoff) return "cutoff";
  return "open";
}

// =============================================================================================
// Events: the hand-written scenario
// =============================================================================================

const ORDERS = [];
const EVENTS = [];
let seq = 0;
const push = (e) => EVENTS.push({ ...e, seq: seq++ });

function order(o) {
  const rec = { cancelledAt: null, filled: 0n, synthetic: false, ...o, id: null, n: ORDERS.length };
  if (rec.validUntil === undefined) rec.validUntil = rec.kind === "AskWrite" ? rec.series.mintCutoff : rec.series.expiry;
  ORDERS.push(rec);
  return rec;
}

/**
 * A fill against the MakerVault's quote of the moment: the price comes from the pricing model at
 * the fill's spot and time, the quote itself was placed 5 minutes earlier and replaced right
 * after, so it never shows in a book.
 */
function mvFill({ time, series, taker, units, spot, side = "ask", recipient = taker }) {
  const ts = at(time);
  const f = fairOf(series, spot, ts);
  const kind = side === "ask" ? "AskWrite" : "Bid";
  const price = side === "ask" ? mvAskPrice(f.fair) : mvBidPrice(f.fair);
  const o = order({
    maker: A.makerVault,
    series,
    kind,
    price,
    units: max(units, series.market.mvQuoteUnits),
    placedAt: ts - 300,
    synthetic: true,
  });
  o.cancelledAt = ts + 60;
  push({ ts, kind: "fill", order: o, taker, units, spot, writeToSell: side === "bid", recipient });
}

/**
 * `recipient` is the take's TakeParams.recipient (interface v4 OrderFilled.recipient): it receives
 * the longs on an ask hit and the taker's USDG proceeds on a bid hit. Default: the taker.
 */
function fill({ time, order: o, taker, units, spot, writeToSell = false, recipient = taker }) {
  push({ ts: at(time), kind: "fill", order: o, taker, units, spot, writeToSell, recipient });
}

// --- collateral --------------------------------------------------------------------------------
const deposit = (time, account, ticker, amount) =>
  push({ ts: at(time), kind: "deposit", account, asset: MARKETS[ticker].underlying, amount });
deposit("2026-09-04T18:00:00Z", A.makerVault, "NVDA", tokens("60"));
deposit("2026-09-04T18:00:00Z", A.makerVault, "TSLA", tokens("25"));
deposit("2026-09-04T19:00:00Z", A.manual, "NVDA", tokens("5"));
deposit("2026-09-04T19:00:00Z", A.manual, "TSLA", tokens("2"));
deposit("2026-09-07T16:00:00Z", A.roller, "NVDA", tokens("3.5"));

// --- the settled NVDA weekly (Fri 09-11), settlement price 219.40 --------------------------------
push({ ts: at("2026-09-10T17:00:00Z"), kind: "withdrawal", account: A.roller, asset: MARKETS.NVDA.underlying, amount: tokens("0.5") });

// AutoRoller: first roll of the week. Its strike (spot × 1.045 rounded up) is off the cranker's
// ladder, so NVDA 09-11 has a sixth, writer-created series. Units = all free collateral.
push({ ts: at("2026-09-08T13:35:00Z"), kind: "roll", writer: A.roller, ticker: "NVDA", date: "09-11", spot: usd("205.90"), key: "roller-0911" });

mvFill({ time: "2026-09-08T14:05:00Z", series: S("NVDA", "09-11", "210"), taker: A.ape, units: 50n, spot: usd("206.10") });
const manual0911 = order({ maker: A.manual, series: S("NVDA", "09-11", "210"), kind: "AskWrite", price: usd("2.10"), units: 20n, placedAt: at("2026-09-08T15:00:00Z") });
fill({ time: "2026-09-08T15:20:00Z", order: manual0911, taker: A.lucy, units: 20n, spot: usd("206.60") });
fill({ time: "2026-09-08T17:30:00Z", order: "roller-0911", taker: A.degen, units: 200n, spot: usd("206.35") });
// In v8 only an authorised minter (the OrderBook here) may call Clearinghouse.mint. The roller
// therefore writes through its book ask, buys 50 of those longs back from degen, then calls the
// still-permissionless close. The Minted event from the first fill supplies the `mint` history row.
// Pre-declare the series that the replayed roll also derives; addSeries de-duplicates it by key.
const roller0911Series = addSeries("NVDA", "09-11", "weekly", usd("216"));
const rollerBuyback0911 = order({ maker: A.degen, series: roller0911Series, kind: "AskResale", price: usd("0.30"), units: 50n, placedAt: at("2026-09-09T14:30:00Z") });
push({ ts: rollerBuyback0911.placedAt, kind: "place", order: rollerBuyback0911 });
fill({ time: "2026-09-09T14:50:00Z", order: rollerBuyback0911, taker: A.roller, units: 50n, spot: usd("207.10") });
push({ ts: at("2026-09-09T15:00:00Z"), kind: "close", account: A.roller, series: S("NVDA", "09-11", "216"), units: 50n });
mvFill({ time: "2026-09-09T14:40:00Z", series: S("NVDA", "09-11", "214"), taker: A.degen, units: 100n, spot: usd("207.20") });
mvFill({ time: "2026-09-09T16:10:00Z", series: S("NVDA", "09-11", "218"), taker: A.sam, units: 100n, spot: usd("207.05") });
// 30 units at the 0.25 minimum ask: 0.0825 USDG all in, under the 0.10 integrity floor.
mvFill({ time: "2026-09-10T13:50:00Z", series: S("NVDA", "09-11", "218"), taker: A.lucy, units: 30n, spot: usd("209.40") });
mvFill({ time: "2026-09-10T14:30:00Z", series: S("NVDA", "09-11", "223"), taker: A.otto, units: 150n, spot: usd("209.80") });
mvFill({ time: "2026-09-10T18:00:00Z", series: S("NVDA", "09-11", "227"), taker: A.ape, units: 100n, spot: usd("211.20") });

push({ ts: EXPIRY["09-11"] + 150, kind: "settleExpiry", ticker: "NVDA", date: "09-11" });

// --- Monday 09-14: second roll (redeems the 09-11 short to the ledger, cancels, places) ----------
push({ ts: at("2026-09-14T13:35:00Z"), kind: "roll", writer: A.roller, ticker: "NVDA", date: "09-18", spot: usd("216.80"), key: "roller-0918", previous: "roller-0911" });

// --- TSLA daily 09-15 (held) and NVDA daily 09-16 (candidate) ------------------------------------
mvFill({ time: "2026-09-14T15:10:00Z", series: S("TSLA", "09-15", "360"), taker: A.otto, units: 80n, spot: usd("351.20") });
mvFill({ time: "2026-09-15T14:30:00Z", series: S("NVDA", "09-16", "215"), taker: A.sam, units: 40n, spot: usd("213.10") });
mvFill({ time: "2026-09-15T15:45:00Z", series: S("NVDA", "09-16", "217"), taker: A.ape, units: 100n, spot: usd("213.60") });

// --- open weeklies and dailies ------------------------------------------------------------------
mvFill({ time: "2026-09-15T14:10:00Z", series: S("NVDA", "09-18", "218"), taker: A.ape, units: 100n, spot: usd("213.40") });
mvFill({ time: "2026-09-15T15:00:00Z", series: S("NVDA", "09-18", "222"), taker: A.sam, units: 150n, spot: usd("213.90") });
fill({ time: "2026-09-15T16:00:00Z", order: "roller-0918", taker: A.lucy, units: 60n, spot: usd("214.20") });
mvFill({ time: "2026-09-16T13:45:00Z", series: S("NVDA", "09-18", "231"), taker: A.otto, units: 300n, spot: usd("215.10") });
const apeResale = order({ maker: A.ape, series: S("NVDA", "09-18", "218"), kind: "AskResale", price: usd("2.25"), units: 40n, placedAt: at("2026-09-16T14:00:00Z") });
push({ ts: apeResale.placedAt, kind: "place", order: apeResale });
fill({ time: "2026-09-16T15:30:00Z", order: apeResale, taker: A.degen, units: 20n, spot: usd("216.40") });

mvFill({ time: "2026-09-16T18:00:00Z", series: S("NVDA", "09-17", "216"), taker: A.lucy, units: 25n, spot: usd("215.80") });
// The manual writer sells INTO the MakerVault's bid, minting from its own collateral (writeToSell),
// and has the USDG proceeds paid to its treasury wallet (TakeParams.recipient != taker).
mvFill({ time: "2026-09-16T19:00:00Z", series: S("NVDA", "09-17", "216"), taker: A.manual, units: 50n, spot: usd("215.60"), side: "bid", recipient: A.manualTreasury });

const manual0925 = order({ maker: A.manual, series: S("NVDA", "09-25", "221"), kind: "AskWrite", price: usd("3.60"), units: 100n, placedAt: at("2026-09-16T18:30:00Z") });
fill({ time: "2026-09-16T19:05:00Z", order: manual0925, taker: A.ape, units: 50n, spot: usd("215.60") });

// TSLA 09-18 K=385: the MakerVault is 80 short against a 120-unit per-series cap, so it quotes only
// 40 there. That thin level is the highest multiple on the board and must NOT be the hero card.
mvFill({ time: "2026-09-16T15:00:00Z", series: S("TSLA", "09-18", "385"), taker: A.otto, units: 80n, spot: usd("357.10") });
const manualTsla385 = order({ maker: A.manual, series: S("TSLA", "09-18", "385"), kind: "AskWrite", price: usd("0.40"), units: 40n, placedAt: at("2026-09-16T16:00:00Z") });
fill({ time: "2026-09-16T16:30:00Z", order: manualTsla385, taker: A.degen, units: 10n, spot: usd("356.90") });
mvFill({ time: "2026-09-16T17:00:00Z", series: S("TSLA", "09-18", "370"), taker: A.otto, units: 30n, spot: usd("356.40") });

// sam rests a bid under the MakerVault's.
order({ maker: A.sam, series: S("NVDA", "09-17", "219"), kind: "Bid", price: usd("0.50"), units: 100n, placedAt: at("2026-09-16T20:30:00Z") });

// =============================================================================================
// Replay
// =============================================================================================

const FREE = new Map(); // account -> asset -> bigint (Clearinghouse ledger)
const freeOf = (a, asset) => FREE.get(a)?.get(asset) ?? 0n;
function credit(a, asset, amount) {
  if (!FREE.has(a)) FREE.set(a, new Map());
  const next = freeOf(a, asset) + amount;
  if (next < 0n) throw new Error(`ledger of ${a} in ${asset} would go negative`);
  FREE.get(a).set(asset, next);
}
const bump = (map, k, d) => {
  const next = (map.get(k) ?? 0n) + d;
  if (next < 0n) throw new Error(`balance of ${k} would go negative`);
  if (next === 0n) map.delete(k);
  else map.set(k, next);
};

function addLot(s, holder, units, cost) {
  if (!s.lots.has(holder)) s.lots.set(holder, []);
  s.lots.get(holder).push({ units, cost });
}
/** FIFO: removes `units` from the holder's lots and returns their cost. */
function takeLots(s, holder, units) {
  const lots = s.lots.get(holder) ?? [];
  let left = units;
  let cost = 0n;
  while (left > 0n) {
    const lot = lots[0];
    if (!lot) throw new Error(`no cost basis left for ${holder} in ${s.key}`);
    const take = min(left, lot.units);
    const c = (lot.cost * take) / lot.units;
    lot.units -= take;
    lot.cost -= c;
    cost += c;
    left -= take;
    if (lot.units === 0n) lots.shift();
  }
  return cost;
}
const basisOf = (s, holder) => (s.lots.get(holder) ?? []).reduce((a, l) => ({ units: a.units + l.units, cost: a.cost + l.cost }), { units: 0n, cost: 0n });

const FILLS = [];
const REDEMPTIONS = [];
const ROLLS = [];
const SETTLEMENTS = [];
const LEDGER_HISTORY = []; // deposits, withdrawals, mints, closes

const ordersByKey = new Map();
let fillNo = 0;
let redeemNo = 0;

function redeem(s, holder, side, ts, tx, logIndex) {
  const p = s.payout;
  const price = oracleOf(s).price;
  const prefs = prefsOf(holder);
  const u = s.market.underlying;
  if (side === "long") {
    const units = s.long.get(holder) ?? 0n;
    if (units === 0n) return null;
    const amountInKind = units * p.long;
    const value = valueAt(amountInKind, price);
    let asset = u;
    let amount = amountInKind;
    if (value === 0n) amount = 0n;
    else if (!prefs.inKind) {
      asset = USDG.address;
      amount = (value * 9_990n) / BPS; // PayoutAdapter swap, 10 bps under the settlement-price value
    }
    const cost = takeLots(s, holder, units);
    const worth = asset === USDG.address ? amount : value;
    if (prefs.toLedger) credit(holder, asset, amount);
    bump(s.long, holder, -units);
    s.supply -= units;
    const r = { series: s, holder, side, tokenId: s.longId, units, asset, amount, amountInKind, toLedger: prefs.toLedger, ts, tx, logIndex, realisedPnl: worth - cost, feeValue: valueAt(units * p.fee, price) };
    REDEMPTIONS.push(r);
    return r;
  }
  const units = s.short.get(holder) ?? 0n;
  if (units === 0n) return null;
  const amountInKind = units * p.short;
  if (prefs.toLedger) credit(holder, u, amountInKind);
  bump(s.short, holder, -units);
  // A writing maker keeps premium − seller fee + rebate; a writeToSell taker also paid the taker fee.
  const earned = sumBy(
    s.fills.filter((f) => f.writer === holder),
    (f) => f.premium - f.sellerFee + (f.maker === holder ? f.makerRebate : -f.takerFee),
  );
  const givenUp = valueAt(units * p.gross, price);
  const r = { series: s, holder, side, tokenId: s.shortId, units, asset: u, amount: amountInKind, amountInKind, toLedger: prefs.toLedger, ts, tx, logIndex, realisedPnl: earned - givenUp, feeValue: 0n };
  REDEMPTIONS.push(r);
  return r;
}

EVENTS.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
for (const e of EVENTS) {
  if (e.ts > NOW) throw new Error(`event after now: ${JSON.stringify(e.kind)}`);
  switch (e.kind) {
    case "deposit": {
      credit(e.account, e.asset, e.amount);
      LEDGER_HISTORY.push({ ...e, tx: txHash(`deposit:${e.seq}`) });
      break;
    }
    case "withdrawal": {
      credit(e.account, e.asset, -e.amount);
      LEDGER_HISTORY.push({ ...e, tx: txHash(`withdrawal:${e.seq}`) });
      break;
    }
    case "mint": {
      const s = e.series;
      const fee = mintRent(s, e.units, e.ts);
      s.mintFeesHeld += fee;
      credit(e.account, s.market.underlying, -(e.units * UNIT + fee));
      bump(s.long, e.longTo, e.units);
      bump(s.short, e.account, e.units);
      s.supply += e.units;
      addLot(s, e.longTo, e.units, 0n);
      LEDGER_HISTORY.push({ ...e, writer: e.account, fee, tx: txHash(`mint:${e.seq}`), logIndex: 2 });
      break;
    }
    case "close": {
      const s = e.series;
      bump(s.long, e.account, -e.units);
      bump(s.short, e.account, -e.units);
      takeLots(s, e.account, e.units);
      s.supply -= e.units;
      const feeRefund = min(s.mintFeesHeld, rentNumerator(s, e.units, e.ts) / (1_000_000n * BigInt(MINT_FEE_PERIOD)));
      s.mintFeesHeld -= feeRefund;
      credit(e.account, s.market.underlying, e.units * UNIT + feeRefund);
      LEDGER_HISTORY.push({ ...e, feeRefund, tx: txHash(`close:${e.seq}`), logIndex: 2 });
      break;
    }
    case "place": {
      const o = e.order;
      if (o.kind === "AskResale") {
        bump(o.series.long, o.maker, -o.units);
        bump(o.series.escrow, o.maker, o.units);
      }
      break;
    }
    case "roll": {
      const tx = txHash(`roll:${e.key}`);
      if (e.previous) {
        const prev = ordersByKey.get(e.previous);
        const r = redeem(prev.series, e.writer, "short", e.ts, tx, 4);
        if (!r) throw new Error("roll found no short to redeem");
        prev.cancelledAt = e.ts;
      }
      const m = MARKETS[e.ticker];
      const strike = ceilDiv(e.spot * (BPS + BigInt(ROLLER_STRATEGY.otmBps)), BPS * m.strikeTick) * m.strikeTick;
      const series = addSeries(e.ticker, e.date, "weekly", strike);
      const price = tickDown((e.spot * BigInt(ROLLER_STRATEGY.askBps)) / BPS);
      const free = capacity(series, freeOf(e.writer, m.underlying), e.ts);
      const units = ROLLER_STRATEGY.maxUnits === 0n ? free : min(ROLLER_STRATEGY.maxUnits, free);
      const o = order({ maker: e.writer, series, kind: "AskWrite", price, units, placedAt: e.ts });
      ordersByKey.set(e.key, o);
      ROLLS.push({ writer: e.writer, series, order: o, price, units, ts: e.ts, tx, logIndex: 9, spot: e.spot });
      break;
    }
    case "fill": {
      const o = typeof e.order === "string" ? ordersByKey.get(e.order) : e.order;
      const s = o.series;
      if (o.maker === e.taker) throw new Error("self-fill in scenario");
      if (e.ts >= (o.kind === "AskWrite" || e.writeToSell ? s.mintCutoff : s.expiry)) throw new Error(`fill past cutoff on ${s.key}`);
      if (o.filled + e.units > o.units) throw new Error(`order overfilled on ${s.key}`);
      const premium = (o.price * e.units) / UNITS_PER_SHARE;
      const takerFee = min(FEES.takerFeeFlat, (premium * FEES.takerFeeCapBps) / BPS);
      const primary = o.kind === "AskWrite" || (o.kind === "Bid" && e.writeToSell);
      const sellerFee = (premium * (primary ? FEES.premiumFeeBps : FEES.resaleFeeBps)) / BPS;
      const makerRebate = (takerFee * rebateBpsOf(o.maker)) / BPS;
      const takerIsBuyer = o.kind !== "Bid";
      // Longs bought for another wallet would move the buyer of record (and its cost, wins and
      // history) off the taker; the scenario only redirects a seller's USDG.
      if (takerIsBuyer && e.recipient !== e.taker) throw new Error(`ask hit with a recipient on ${s.key}`);
      const fair = fairOf(s, e.spot, e.ts);
      // Integrity rule: a fill priced under 25 % of fair value would be ignored by wins; the
      // scenario should never need one.
      if (fair && o.price * 4n < fair.fair) throw new Error(`fill under 25 % of fair on ${s.key}`);
      const u = s.market.underlying;
      let writer = null;
      let realisedPnl = null;
      if (o.kind === "AskWrite") {
        const fee = mintRent(s, e.units, e.ts);
        s.mintFeesHeld += fee;
        credit(o.maker, u, -(e.units * UNIT + fee));
        bump(s.short, o.maker, e.units);
        bump(s.long, e.taker, e.units);
        s.supply += e.units;
        addLot(s, e.taker, e.units, premium + takerFee);
        writer = o.maker;
      } else if (o.kind === "AskResale") {
        bump(s.escrow, o.maker, -e.units);
        bump(s.long, e.taker, e.units);
        realisedPnl = premium - sellerFee + makerRebate - takeLots(s, o.maker, e.units);
        addLot(s, e.taker, e.units, premium + takerFee);
      } else {
        if (!e.writeToSell) throw new Error("scenario only sells into bids with writeToSell");
        const fee = mintRent(s, e.units, e.ts);
        s.mintFeesHeld += fee;
        credit(e.taker, u, -(e.units * UNIT + fee));
        bump(s.short, e.taker, e.units);
        bump(s.long, o.maker, e.units);
        s.supply += e.units;
        addLot(s, o.maker, e.units, premium);
        writer = e.taker;
      }
      o.filled += e.units;
      fillNo += 1;
      const tx = txHash(`fill:${fillNo}`);
      const logIndex = primary ? 3 : 1;
      const f = { no: fillNo, series: s, order: o, maker: o.maker, taker: e.taker, recipient: e.recipient, units: e.units, price: o.price, premium, takerFee, sellerFee, makerRebate, primary, takerIsBuyer, writer, realisedPnl, ts: e.ts, spot: e.spot, tx, logIndex };
      s.fills.push(f);
      FILLS.push(f);
      // Clearinghouse emits Minted after its two TransferSingle logs and before OrderFilled for
      // every AskWrite/writeToSell delivery. clearinghouse.ts indexes that event unconditionally,
      // and accounts.ts returns it to both the writer and longTo; a primary fill therefore yields
      // both a `fill` and a `mint` history item even though an EOA cannot mint directly in v8.
      if (primary) {
        const longTo = takerIsBuyer ? e.recipient : o.maker;
        LEDGER_HISTORY.push({
          ts: e.ts,
          kind: "mint",
          series: s,
          units: e.units,
          writer,
          longTo,
          fee: mintRent(s, e.units, e.ts),
          tx,
          logIndex: 2,
        });
      }
      break;
    }
    case "settleExpiry": {
      const o = ORACLE.get(`${e.ticker}:${EXPIRY[e.date]}`);
      if (o?.status !== "Finalized") throw new Error("settling a non-final expiry");
      const ladder = SERIES.filter((s) => s.ticker === e.ticker && s.date === e.date).sort((a, b) => (a.strike < b.strike ? -1 : 1));
      let t = e.ts;
      for (const s of ladder) {
        // The book is pruned first (escrowed longs go back to their makers), then settle, then
        // the cranker pages holders and pushes redemptions.
        if (s.escrow.size) throw new Error(`unpruned escrow on ${s.key}`);
        s.mintFeesAccrued += s.mintFeesHeld;
        s.mintFeesHeld = 0n;
        s.settledAt = t;
        s.settleTx = txHash(`settle:${s.key}`);
        s.payout = settlementPayouts(s, o.price);
        SETTLEMENTS.push({ series: s, ts: t, tx: s.settleTx, logIndex: 1 });
        t += 4;
      }
      let rt = e.ts + 60;
      for (const s of ladder) {
        for (const side of ["long", "short"]) {
          const holders = [...(side === "long" ? s.long : s.short).keys()].sort();
          for (const h of holders) {
            if (!prefsOf(h).thirdPartyRedeem) continue; // cranker may not; the holder must
            if (h === A.roller && side === "short") continue; // the AutoRoller redeems its own on the next roll
            redeemNo += 1;
            redeem(s, h, side, rt, txHash(`redeem:${redeemNo}`), 3);
            rt += 6;
          }
        }
      }
      break;
    }
    default:
      throw new Error(`unknown event ${e.kind}`);
  }
}

// Order ids: the OrderBook's global counter, in placement order.
const byPlacement = (a, b) => a.placedAt - b.placedAt || a.n - b.n;
{
  // Live MakerVault quotes, refreshed at 20:45Z after the close (they sort last).
  for (const s of SERIES) {
    if (!s.quoted || statusOf(s) !== "open") continue;
    const f = fairOf(s, s.market.spot, NOW);
    const mvShort = s.short.get(A.makerVault) ?? 0n;
    const askUnits = min(s.market.mvQuoteUnits, s.market.mvSeriesCapUnits - mvShort);
    if (askUnits > 0n) order({ maker: A.makerVault, series: s, kind: "AskWrite", price: mvAskPrice(f.fair), units: askUnits, placedAt: NOW - 900 });
    const bid = mvBidPrice(f.fair);
    if (bid >= MV_MIN_BID) order({ maker: A.makerVault, series: s, kind: "Bid", price: bid, units: MV_BID_UNITS, placedAt: NOW - 900 });
  }
}
ORDERS.sort(byPlacement);
ORDERS.forEach((o, i) => (o.id = 1001n + BigInt(i)));

const remaining = (o) => o.units - o.filled;
/** Live at NOW, as the indexer's book serves it (AskWrite needs its maker's free collateral). */
function isLive(o) {
  if (o.synthetic || o.cancelledAt !== null || remaining(o) === 0n) return false;
  if (NOW >= o.validUntil) return false;
  const status = statusOf(o.series);
  if (o.kind === "AskWrite") return status === "open" && freeOf(o.maker, o.series.market.underlying) >= remaining(o) * UNIT + mintRent(o.series, remaining(o), NOW);
  return status === "open" || status === "cutoff";
}

// =============================================================================================
// Wire objects
// =============================================================================================

const seriesRef = (s) => ({
  longId: s.longId.toString(),
  shortId: s.shortId.toString(),
  ticker: s.ticker,
  underlying: s.market.underlying,
  isPut: s.isPut,
  strike: usdg(s.strike),
  expiry: s.expiry,
  tenor: s.tenor,
  mintCutoff: s.mintCutoff,
  mintFeePpm: s.mintFeePpm,
  mintFeesHeld: money(s.mintFeesHeld, 18),
  mintFeesAccrued: money(s.mintFeesAccrued, 18),
  status: statusOf(s),
});

function levels(s, side) {
  const orders = ORDERS.filter((o) => o.series === s && isLive(o) && (side === "bids" ? o.kind === "Bid" : o.kind !== "Bid"));
  const byPrice = new Map();
  for (const o of orders) {
    if (!byPrice.has(o.price)) byPrice.set(o.price, []);
    byPrice.get(o.price).push(o);
  }
  const prices = [...byPrice.keys()].sort((a, b) => (side === "bids" ? (a > b ? -1 : 1) : a < b ? -1 : 1));
  return prices.map((p) => ({
    price: usdg(p),
    units: sumBy(byPrice.get(p), remaining).toString(),
    orders: byPrice.get(p).map((o) => ({
      orderId: o.id.toString(),
      maker: o.maker,
      units: remaining(o).toString(),
      onChainRemainingUnits: remaining(o).toString(),
      makerFreeUnits: o.kind === "AskWrite" ? capacity(o.series, freeOf(o.maker, o.series.market.underlying), NOW).toString() : null,
      makerFreeCollateral: o.kind === "AskWrite" ? money(freeOf(o.maker, o.series.market.underlying), 18) : null,
      kind: o.kind,
      validUntil: o.validUntil,
    })),
  }));
}

const BOOKS = new Map(SERIES.map((s) => [s, { bids: levels(s, "bids"), asks: levels(s, "asks") }]));
for (const [s, b] of BOOKS) {
  if (b.bids[0] && b.asks[0] && BigInt(b.bids[0].price.raw) >= BigInt(b.asks[0].price.raw)) throw new Error(`crossed book on ${s.key}`);
}

function quoteOf(s) {
  const { bids, asks } = BOOKS.get(s);
  const status = statusOf(s);
  const f = status === "open" || status === "cutoff" ? fairOf(s, s.market.spot, NOW) : null;
  const last = s.fills.at(-1);
  return {
    bestBid: bids[0]?.price ?? null,
    bestAsk: asks[0]?.price ?? null,
    bidUnits: bids[0]?.units ?? "0",
    askUnits: asks[0]?.units ?? "0",
    fair: f ? usdg(f.fair) : null,
    iv: f ? f.iv : null,
    delta: f ? f.delta : null,
    last: last ? usdg(last.price) : null,
  };
}

const openInterest = (s) => s.supply;
const volumeOf = (fills) => sumBy(fills, (f) => f.premium);
const within = (fills, seconds) => fills.filter((f) => f.ts > NOW - seconds);
/**
 * T-425. The instant every trailing window in these fixtures ends at, published as `asOf` beside the
 * figures it qualifies. It is NOW because this generator has no host clock at all -- NOW is the
 * scenario's indexed state, which is exactly what the routes anchor to via indexedHead(). It is NOT
 * a wall clock, which is the thing T-188 removed from those routes.
 *
 * KNOWN FIDELITY GAP: health.json models a 2-second indexer lag (block at NOW - 2, lagSeconds 2)
 * while `within` anchors at NOW, so these fixtures never exercise a head BEHIND the scenario clock --
 * the one case the asOf field exists to describe. Moving the anchor to NOW - 2 would re-cut every
 * window boundary in the scenario, so it is recorded rather than done here.
 */
const ASOF = NOW;

function settlementOf(s) {
  if (NOW < s.expiry) return null;
  const o = oracleOf(s);
  const base = { status: o?.status ?? "None", price: null, longPayoutPerUnit: null, feePerUnit: null, shortPayoutPerUnit: null, finalizedAt: null, settledAt: s.settledAt, sourceIndex: null, corroborated: null, candidate: null };
  if (!o) return base;
  if (o.status === "Finalized") {
    return {
      ...base,
      price: usdg(o.price),
      longPayoutPerUnit: s.payout ? money(s.payout.long, 18) : null,
      feePerUnit: s.payout ? money(s.payout.fee, 18) : null,
      shortPayoutPerUnit: s.payout ? money(s.payout.short, 18) : null,
      finalizedAt: o.finalizedAt,
      sourceIndex: o.sourceIndex,
      corroborated: o.corroborated,
    };
  }
  // Pending or Held: the candidate is public. While Held, finalizableAt is the schedule the veto
  // interrupted; an unveto restarts the delay from the unveto.
  return {
    ...base,
    candidate: {
      price: usdg(o.candidate.price),
      sourceIndex: o.candidate.sourceIndex,
      disagreed: o.candidate.disagreed,
      finalizableAt: o.candidate.since + UNCORROBORATED_DELAY,
    },
  };
}

// --- cards (ADR-12) -----------------------------------------------------------------------------
/**
 * The card's scenario price. Call: T = roundUp(K × (1 + bps/1e4), strikeTick). Put: T =
 * roundDown(K × (1 − bps/1e4), strikeTick), never below one strikeTick.
 */
function cardTargetOf(isPut, strike, cardTargetBps, tick) {
  const bps = BigInt(cardTargetBps);
  if (!isPut) return ceilDiv(strike * (BPS + bps), BPS * tick) * tick;
  return max(((strike * (BPS - bps)) / (BPS * tick)) * tick, tick);
}

/**
 * Net payout per unit at the target, in USDG base units (OptionMath at P = T). Put: gross = (K − T)
 * / 100 USDG, fee = min(collateralPerUnit × bps / 1e4, gross × 10 %) with collateralPerUnit = K /
 * 100. Call: the in-kind payout valued at T, gross = (T − K) / 100 USDG, fee = min(T × bps / 1e4 /
 * 100, gross × 10 %) — the call's UNIT × bps / 1e4 fee valued at T.
 */
function cardPayoutPerUnit(isPut, strike, target) {
  const gross = isPut ? (strike - target) / UNITS_PER_SHARE : (target - strike) / UNITS_PER_SHARE;
  const feeCap = (gross * EXERCISE_FEE_MAX_PAYOUT_SHARE_BPS) / BPS;
  const fee = isPut
    ? min(((strike / UNITS_PER_SHARE) * FEES.exerciseFeeBps) / BPS, feeCap)
    : min((target * FEES.exerciseFeeBps) / BPS / UNITS_PER_SHARE, feeCap);
  return gross - fee;
}

const takerFeeOn = (premium) => min(FEES.takerFeeFlat, (premium * FEES.takerFeeCapBps) / BPS);

/**
 * A one-share (100-unit) ticket: walk the whole ask side cheapest first, in take order, sum the
 * premium of exactly 100 units, and add ONE taker fee on that total (a single take). Null when
 * the book holds fewer than 100 ask units.
 */
function perShareOf(asks, payoutPerUnit) {
  let left = UNITS_PER_SHARE;
  let premium = 0n;
  for (const level of asks) {
    if (left === 0n) break;
    const take = min(left, BigInt(level.units));
    premium += (BigInt(level.price.raw) * take) / UNITS_PER_SHARE;
    left -= take;
  }
  if (left > 0n) return null;
  const cost = premium + takerFeeOn(premium);
  const payout = payoutPerUnit * UNITS_PER_SHARE;
  return { cost: usdg(cost), payoutAtTarget: usdg(payout), multiple: multipleOf(payout, cost) };
}

function cardOf(s) {
  const { asks } = BOOKS.get(s);
  if (statusOf(s) !== "open" || asks.length === 0) return null;
  const ask = BigInt(asks[0].price.raw);
  const premium = ask / UNITS_PER_SHARE; // one unit
  const cost = premium + takerFeeOn(premium);
  const target = cardTargetOf(s.isPut, s.strike, LADDER[s.tenor].cardTargetBps, s.market.strikeTick);
  const payout = cardPayoutPerUnit(s.isPut, s.strike, target);
  return {
    series: seriesRef(s),
    spot: usdg(s.market.spot),
    ask: usdg(ask),
    target: usdg(target),
    perUnit: { cost: usdg(cost), payoutAtTarget: usdg(payout), multiple: multipleOf(payout, cost) },
    perShare: perShareOf(asks, payout),
    maxLoss: "cost",
    unitsAvailable: asks[0].units,
    orderIds: asks[0].orders.map((o) => o.orderId),
  };
}

// --- wins (X2-03 integrity rules) ----------------------------------------------------------------
const MIN_COUNTED_COST = usd("0.10");
const POSITIONS = []; // every settled long position, counted or not
for (const s of SERIES.filter((x) => x.settledAt !== null)) {
  const price = oracleOf(s).price;
  const holders = new Set([...s.fills.filter((f) => f.takerIsBuyer).map((f) => f.taker)]);
  for (const holder of [...holders].sort()) {
    const buys = s.fills.filter((f) => f.takerIsBuyer && f.taker === holder);
    const units = sumBy(buys, (f) => f.units);
    const cost = sumBy(buys, (f) => f.premium + f.takerFee);
    const r = REDEMPTIONS.find((x) => x.series === s && x.holder === holder && x.side === "long");
    const stillHeld = s.long.get(holder) ?? 0n;
    let payout;
    if (r) payout = r.asset === USDG.address ? r.amount : valueAt(r.amountInKind, price);
    else payout = valueAt(stillHeld * s.payout.long, price);
    POSITIONS.push({
      series: s,
      holder,
      units,
      cost,
      payout,
      premium: sumBy(buys, (f) => f.premium),
      firstSpot: buys[0].spot,
      counted: cost >= MIN_COUNTED_COST && buys.every((f) => f.taker !== f.maker),
      tx: r ? r.tx : s.settleTx,
    });
  }
}
const winOf = (p) => ({
  id: `${p.series.longId}-${p.holder}`,
  holder: p.holder,
  ticker: p.series.ticker,
  series: seriesRef(p.series),
  cost: usdg(p.cost),
  payout: usdg(p.payout),
  multiple: multipleOf(p.payout, p.cost),
  settledAt: p.series.settledAt,
  tx: p.tx,
});
const WINS = POSITIONS.filter((p) => p.counted && p.payout > p.cost).sort(
  (a, b) => b.series.settledAt - a.series.settledAt || Number(b.payout * a.cost - a.payout * b.cost) || (a.holder < b.holder ? -1 : 1),
);
const profit = (p) => p.payout - p.cost;
const biggest = (ps) => (ps.length ? ps.reduce((best, p) => (profit(p) > profit(best) ? p : best)) : null);

// =============================================================================================
// Responses
// =============================================================================================

const FILES = new Map();
const put = (path, body) => {
  if (FILES.has(path)) throw new Error(`duplicate fixture ${path}`);
  FILES.set(path, `${JSON.stringify(body, null, 2)}\n`);
};

put("health.json", { status: "ok", block: blockAt(NOW - 2).toString(), lagSeconds: 2, interfaceVersion: INTERFACE_VERSION });

/**
 * /v2/services — the readiness of a service the indexer does NOT run (T-424; the route existed with no
 * fixture, which is why the coverage test was red). The scenario's pricer is up: `healthy` is true only
 * when `reason` is "ready", and `reasons` is the pricer's own closed set, empty while it is ready.
 * `lastEvaluationAt` is its last completed tick, deliberately EARLIER than `checkedAt` -- the indexer
 * asked at NOW and the pricer answered about a tick it finished 30 seconds ago. A fixture with the two
 * equal would teach a consumer that they are one timestamp.
 */
put("services.json", {
  pricer: {
    healthy: true,
    reason: "ready",
    reasons: [],
    checkedAt: NOW,
    lastEvaluationAt: NOW - 30,
  },
});

put("config.json", {
  chainId: CHAIN_ID,
  interfaceVersion: INTERFACE_VERSION,
  deployBlock: blockAt(at("2026-09-04T17:00:00Z")).toString(),
  usdg: USDG,
  contracts: CONTRACTS,
  flywheel: FLYWHEEL,
  safes: SAFES,
  access: { manager: CONTRACTS.accessManager, roles: ACCESS_ROLES },
  pendingOperations: PENDING_OPERATIONS,
  fees: {
    premiumFeeBps: Number(FEES.premiumFeeBps),
    resaleFeeBps: Number(FEES.resaleFeeBps),
    takerFeeFlat: usdg(FEES.takerFeeFlat),
    takerFeeCapBps: Number(FEES.takerFeeCapBps),
    makerRebateBps: Number(FEES.makerRebateBps),
    exerciseFeeBps: Number(FEES.exerciseFeeBps),
    mintFeePpm: Number(FEES.mintFeePpm),
    // T-OP-120 (G7): the registry's payoutAdapter is null (ops/markets/tier1.json), so no PayoutAdapterSet has
    // been indexed and the Clearinghouse slippage bound is unknown to the wire; the app uses the 300 bps ceiling.
    maxPayoutSlippageBps: null,
  },
  pendingFees: null,
  constants: {
    unit: UNIT.toString(),
    unitsPerShare: Number(UNITS_PER_SHARE),
    priceTick: Number(PRICE_TICK),
    settlementWindow: SETTLEMENT_WINDOW,
    finalizeDelay: FINALIZE_DELAY,
    snapshotGrace: SNAPSHOT_GRACE,
    resolveDelay: RESOLVE_DELAY,
    maxTenor: MAX_TENOR,
    minSeriesLead: MIN_SERIES_LEAD,
    mintFeePeriod: MINT_FEE_PERIOD,
    mintFeeCeilPpm: MINT_FEE_CEIL_PPM,
    // callhouse-contracts v8, src/v2/interfaces/V2Constants.sol:60: FEE_CHANGE_DELAY = 48 hours.
    // This is the OrderBook's fee-schedule delay, not the AccessManager FEE_MANAGER execution delay.
    feeChangeDelay: 172_800,
  },
  ladder: LADDER,
});

const bySeriesOrder = (a, b) => a.expiry - b.expiry || (a.strike < b.strike ? -1 : a.strike > b.strike ? 1 : 0);

put(
  "markets.json",
  Object.values(MARKETS).map((m) => {
    const ss = SERIES.filter((s) => s.market === m);
    const fills = FILLS.filter((f) => f.series.market === m);
    return {
      ticker: m.ticker,
      name: m.name,
      underlying: m.underlying,
      status: "live",
      launch: m.launch,
      spot: usdg(m.spot),
      spotUpdatedAt: m.spotUpdatedAt,
      strikeTick: usdg(m.strikeTick),
      puts: false,
      mintFeePpm: 0,
      settlement: m.settlement,
      expiries: [...new Set(ss.filter((s) => ["open", "cutoff"].includes(statusOf(s))).map((s) => s.expiry))].sort((a, b) => a - b),
      stats: {
        volume24h: usdg(volumeOf(within(fills, DAY))),
        premium7d: usdg(volumeOf(within(fills, 7 * DAY).filter((f) => f.primary))),
        asOf: ASOF,
        openInterestUnits: sumBy(ss.filter((s) => s.settledAt === null), openInterest).toString(),
        seriesOpen: ss.filter((s) => statusOf(s) === "open").length,
      },
    };
  }),
);

for (const m of Object.values(MARKETS)) {
  put(`markets/${m.ticker}/series.json`, {
    items: SERIES.filter((s) => s.market === m)
      .sort(bySeriesOrder)
      .map((s) => ({ series: seriesRef(s), quote: quoteOf(s), openInterestUnits: openInterest(s).toString(), volume24h: usdg(volumeOf(within(s.fills, DAY))) })),
    asOf: ASOF,
    nextCursor: null,
  });
}

const updatedBlock = blockAt(NOW).toString();
for (const s of SERIES) {
  const id = s.longId.toString();
  put(`series/${id}.json`, {
    series: seriesRef(s),
    quote: quoteOf(s),
    openInterestUnits: openInterest(s).toString(),
    volume: usdg(volumeOf(s.fills)),
    settlement: settlementOf(s),
    exerciseFeeBps: Number(FEES.exerciseFeeBps),
  });
  put(`series/${id}/book.json`, { ...BOOKS.get(s), updatedBlock, snapshotTimestamp: NOW });
  put(`series/${id}/holders.json`, {
    items: [...s.long.entries()]
      .sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : a[0] < b[0] ? -1 : 1))
      .map(([holder, units]) => ({ holder, units: units.toString() })),
    nextCursor: null,
  });
  put(`series/${id}/trades.json`, {
    items: [...s.fills].reverse().map((f) => ({
      id: `${f.tx}-${f.logIndex}`,
      ts: f.ts,
      price: usdg(f.price),
      units: f.units.toString(),
      premium: usdg(f.premium),
      takerIsBuyer: f.takerIsBuyer,
      primary: f.primary,
      taker: f.taker,
      maker: f.maker,
      tx: f.tx,
    })),
    nextCursor: null,
  });
  const f = ["open", "cutoff"].includes(statusOf(s)) ? fairOf(s, s.market.spot, NOW) : null;
  put(
    `fair/${id}.json`,
    f
      ? { fair: usdg(f.fair), iv: f.iv, delta: f.delta, source: f.source, asOf: NOW - 120 }
      : { fair: null, reason: "series is past expiry; the settlement price replaces fair value" },
  );
}

// --- cards ---------------------------------------------------------------------------------------
const CARDS = SERIES.map(cardOf)
  .filter(Boolean)
  .sort((a, b) => b.perUnit.multiple - a.perUnit.multiple || a.series.expiry - b.series.expiry || (BigInt(a.series.strike.raw) < BigInt(b.series.strike.raw) ? -1 : 1));
const HERO_MIN_UNITS = 100n;
const hero = CARDS.find((c) => BigInt(c.unitsAvailable) >= HERO_MIN_UNITS) ?? null;
if (!hero || hero === CARDS[0]) throw new Error("scenario must pin a thin top card that the hero skips");
{
  const thin = CARDS.filter((c) => c.perShare === null).length;
  if (thin === 0 || thin * 2 >= CARDS.length) throw new Error(`scenario must pin a few (not most) cards with under 100 ask units: ${thin} of ${CARDS.length}`);
}
put("cards.json", { items: CARDS, generatedAt: NOW, nextCursor: null });
put("cards/hero.json", { card: hero, maxMultiple: hero ? hero.perUnit.multiple : null });

// --- accounts -------------------------------------------------------------------------------------
const SYMBOL = new Map([[USDG.address, "USDG"], ...Object.values(MARKETS).map((m) => [m.underlying, m.ticker])]);

function positionsOf(account) {
  const longs = [];
  const shorts = [];
  for (const s of [...SERIES].sort(bySeriesOrder)) {
    const held = (s.long.get(account) ?? 0n) + (s.escrow.get(account) ?? 0n);
    if (held > 0n) {
      const { units, cost } = basisOf(s, account);
      if (units !== held) throw new Error(`cost basis out of step for ${account} in ${s.key}`);
      const avgCost = (cost * UNITS_PER_SHARE) / units;
      const f = ["open", "cutoff"].includes(statusOf(s)) ? fairOf(s, s.market.spot, NOW) : null;
      longs.push({
        series: seriesRef(s),
        units: held.toString(),
        avgCost: usdg(avgCost),
        mark: f ? usdg(f.fair) : null,
        unrealised: f ? usdg(((f.fair - avgCost) * held) / UNITS_PER_SHARE) : null,
        claimable: s.payout ? money(held * s.payout.long, 18) : null,
      });
    }
    const short = s.short.get(account) ?? 0n;
    if (short > 0n) {
      const mine = s.fills.filter((f) => f.writer === account);
      shorts.push({
        series: seriesRef(s),
        units: short.toString(),
        premiumReceived: usdg(sumBy(mine, (f) => f.premium - f.sellerFee)),
        collateralLocked: money(s.settledAt === null ? short * UNIT : 0n, 18),
        claimable: s.payout ? money(short * s.payout.short, 18) : null,
      });
    }
  }
  const orders = ORDERS.filter((o) => o.maker === account && isLive(o))
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((o) => ({ orderId: o.id.toString(), series: seriesRef(o.series), kind: o.kind, price: usdg(o.price), units: o.units.toString(), filled: o.filled.toString(), validUntil: o.validUntil }));
  const ledger = [...(FREE.get(account) ?? new Map()).entries()]
    .filter(([, v]) => v > 0n)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([asset, v]) => ({ asset, symbol: SYMBOL.get(asset), free: money(v, asset === USDG.address ? 6 : 18) }));
  const strategies = [];
  if (account === A.roller) {
    const last = ROLLS.at(-1);
    strategies.push({ ticker: "NVDA", strategy: wireStrategy(), currentSeries: seriesRef(last.series),
      orderId: last.order.id.toString(), lastStaleCancelAt: null, staleSpot: null, lastRolledAt: last.ts });
  }
  const p = prefsOf(account);
  return { longs, shorts, orders, ledger, strategies, prefs: { inKind: p.inKind, toLedger: p.toLedger } };
}

function wireStrategy() {
  return { ...ROLLER_STRATEGY, maxUnits: ROLLER_STRATEGY.maxUnits.toString() };
}

const tokenMoney = (asset, v) => money(v, asset === USDG.address ? 6 : 18);

function historyOf(account) {
  const items = [];
  for (const f of FILLS) {
    if (f.taker !== account && f.maker !== account) continue;
    const role = f.taker === account ? "taker" : "maker";
    const buying = role === "taker" ? f.takerIsBuyer : !f.takerIsBuyer;
    let fee = 0n;
    if (role === "taker") fee = f.takerFee + (f.takerIsBuyer ? 0n : f.sellerFee);
    else if (!buying) fee = f.sellerFee;
    items.push({
      id: `${f.tx}-${f.logIndex}`,
      kind: "fill",
      ts: f.ts,
      longId: f.series.longId.toString(),
      series: seriesRef(f.series),
      data: {
        orderId: f.order.id.toString(),
        side: buying ? "buy" : "sell",
        role,
        counterparty: role === "taker" ? f.maker : f.taker,
        units: f.units.toString(),
        price: usdg(f.price),
        premium: usdg(f.premium),
        fee: usdg(fee),
        rebate: usdg(role === "maker" ? f.makerRebate : 0n),
        primary: f.primary,
        realisedPnl: role === "maker" && f.realisedPnl !== null ? usdg(f.realisedPnl) : null,
        tx: f.tx,
      },
    });
  }
  for (const e of LEDGER_HISTORY) {
    if (e.kind === "mint") {
      if (e.writer !== account && e.longTo !== account) continue;
    } else if (e.account !== account) continue;
    const id = `${e.tx}-${e.logIndex ?? 1}`;
    if (e.kind === "deposit" || e.kind === "withdrawal") {
      const data = { asset: e.asset, symbol: SYMBOL.get(e.asset), amount: tokenMoney(e.asset, e.amount) };
      items.push({ id, kind: e.kind, ts: e.ts, longId: null, series: null, data: e.kind === "deposit" ? { ...data, from: account, tx: e.tx } : { ...data, to: account, tx: e.tx } });
    } else if (e.kind === "mint") {
      items.push({ id, kind: "mint", ts: e.ts, longId: e.series.longId.toString(), series: seriesRef(e.series), data: { units: e.units.toString(), collateral: money(e.units * UNIT, 18), fee: money(e.fee, 18), longTo: e.longTo, tx: e.tx } });
    } else if (e.kind === "close") {
      items.push({ id, kind: "close", ts: e.ts, longId: e.series.longId.toString(), series: seriesRef(e.series), data: { units: e.units.toString(), collateralFreed: money(e.units * UNIT, 18), feeRefund: money(e.feeRefund, 18), realisedPnl: null, tx: e.tx } });
    }
  }
  for (const r of REDEMPTIONS) {
    if (r.holder !== account) continue;
    items.push({
      id: `${r.tx}-${r.logIndex}`,
      kind: "redemption",
      ts: r.ts,
      longId: r.series.longId.toString(),
      series: seriesRef(r.series),
      data: {
        side: r.side,
        tokenId: r.tokenId.toString(),
        units: r.units.toString(),
        asset: r.asset,
        amount: tokenMoney(r.asset, r.amount),
        amountInKind: money(r.amountInKind, 18),
        toLedger: r.toLedger,
        // The live indexer tracks FIFO PnL for long redemptions only. Short
        // redemption affects writer stats, but has no per-event PnL row.
        realisedPnl: r.side === "long" ? usdg(r.realisedPnl) : null,
        tx: r.tx,
      },
    });
  }
  // The live query sorts block DESC, logIndex DESC, id DESC. A minting fill emits Minted at log
  // index 2 and OrderFilled at 3 in the same transaction, so the fill must precede its mint row.
  const logIndexOf = (item) => Number(item.id.slice(item.id.lastIndexOf("-") + 1));
  items.sort((a, b) => b.ts - a.ts || logIndexOf(b) - logIndexOf(a) || (a.id < b.id ? 1 : -1));
  return { items, nextCursor: null };
}

for (const account of [A.sam, A.roller]) {
  put(`accounts/${account}/positions.json`, positionsOf(account));
  put(`accounts/${account}/history.json`, historyOf(account));
}

// --- feeds ----------------------------------------------------------------------------------------
put("feed/wins.json", { items: WINS.filter((p) => p.series.settledAt > NOW - 7 * DAY).map(winOf), nextCursor: null });

const ACTIVITY = [
  ...FILLS.map((f) => ({
    id: `${f.tx}-${f.logIndex}`,
    kind: "fill",
    ts: f.ts,
    longId: f.series.longId.toString(),
    series: seriesRef(f.series),
    // The indexer's order: taker, maker, recipient (buyer and seller are always among them).
    accounts: [...new Set([f.taker, f.maker, f.recipient])],
    data: {
      orderId: f.order.id.toString(),
      taker: f.taker,
      maker: f.maker,
      recipient: f.recipient,
      units: f.units.toString(),
      price: usdg(f.price),
      premium: usdg(f.premium),
      takerFee: usdg(f.takerFee),
      sellerFee: usdg(f.sellerFee),
      makerRebate: usdg(f.makerRebate),
      primary: f.primary,
      takerIsBuyer: f.takerIsBuyer,
      tx: f.tx,
    },
  })),
  ...SETTLEMENTS.map((x) => ({
    id: `${x.tx}-${x.logIndex}-${x.series.longId}`,
    kind: "settlement",
    ts: x.ts,
    longId: x.series.longId.toString(),
    series: seriesRef(x.series),
    accounts: [],
    data: {
      price: usdg(oracleOf(x.series).price),
      longPayoutPerUnit: money(x.series.payout.long, 18),
      feePerUnit: money(x.series.payout.fee, 18),
      shortPayoutPerUnit: money(x.series.payout.short, 18),
      tx: x.tx,
    },
  })),
  ...REDEMPTIONS.map((r) => ({
    id: `${r.tx}-${r.logIndex}`,
    kind: "redemption",
    ts: r.ts,
    longId: r.series.longId.toString(),
    series: seriesRef(r.series),
    accounts: [r.holder],
    data: {
      holder: r.holder,
      side: r.side,
      tokenId: r.tokenId.toString(),
      units: r.units.toString(),
      asset: r.asset,
      amount: tokenMoney(r.asset, r.amount),
      amountInKind: money(r.amountInKind, 18),
      settlementPrice: usdg(oracleOf(r.series).price),
      toLedger: r.toLedger,
      tx: r.tx,
    },
  })),
  ...ROLLS.map((r) => ({
    id: `${r.tx}-${r.logIndex}`,
    kind: "roll",
    ts: r.ts,
    longId: r.series.longId.toString(),
    series: seriesRef(r.series),
    accounts: [r.writer],
    data: { writer: r.writer, orderId: r.order.id.toString(), price: usdg(r.price), units: r.units.toString(), tx: r.tx },
  })),
].sort((a, b) => b.ts - a.ts || (a.id < b.id ? -1 : 1));
put("feed/activity.json", { items: ACTIVITY, nextCursor: null });

// The calendar API returns every day in the requested range, including ordinary weekdays: the
// route's default, today through today + 30. A day index is floor(unix / 86400) of that New York
// date's 16:00 close, which is the same UTC date.
const CALENDAR_FROM = Math.floor(NOW / DAY);
/**
 * ExpiryCalendar holidays in that range. There is no NYSE holiday between 09-16 and 10-16, so the
 * scenario sets a hypothetical closure on Mon 09-21 (the Monday after the NVDA 09-18 weekly, when
 * the roller's next roll would be due): a fixture must carry a holiday, and this one moves the
 * roll's due date to Tue 09-22. No series expires on it.
 */
const CALENDAR_HOLIDAYS = new Set([Math.floor(at("2026-09-21T20:00:00Z") / DAY)]);
const CALENDAR = Array.from({ length: 31 }, (_, offset) => {
  const dayIndex = CALENDAR_FROM + offset;
  const weekday = new Date(dayIndex * DAY * 1000).getUTCDay();
  const isHoliday = CALENDAR_HOLIDAYS.has(dayIndex);
  return { dayIndex, isHoliday, isSessionDay: weekday !== 0 && weekday !== 6 && !isHoliday };
});
put("calendar/holidays.json", { items: CALENDAR });

{
  const last = ROLLS.at(-1);
  put("strategies.json", {
    items: [
      {
        writer: A.roller,
        underlying: MARKETS.NVDA.underlying,
        ticker: "NVDA",
        strategy: wireStrategy(),
        currentLongId: last.series.longId.toString(),
        orderId: last.order.id.toString(),
        expiry: last.series.expiry,
        lastStaleCancelAt: null, staleSpot: null, lastRolledAt: last.ts,
      },
    ],
    nextCursor: null,
  });
}

// --- leaderboard: metric=multiple, window=week (the defaults) ------------------------------------
{
  const counted = POSITIONS.filter((p) => p.counted && p.series.settledAt > NOW - 7 * DAY);
  const rows = [];
  for (const holder of [...new Set(counted.map((p) => p.holder))].sort()) {
    const mine = counted.filter((p) => p.holder === holder);
    const wins = mine.filter((p) => p.payout > p.cost);
    if (wins.length === 0) continue; // `best` is a Win: a holder with no win is not ranked
    const best = wins.reduce((b, p) => (p.payout * b.cost > b.payout * p.cost ? p : b));
    rows.push({ holder, value: multipleOf(sumBy(mine, (p) => p.payout), sumBy(mine, (p) => p.cost)), wins: wins.length, losses: mine.length - wins.length, best: winOf(best) });
  }
  rows.sort((a, b) => b.value - a.value || (a.holder < b.holder ? -1 : 1));
  put("leaderboard.json", { metric: "multiple", window: "week", items: rows.map((r, i) => ({ rank: i + 1, ...r })), nextCursor: null });
}

for (const p of WINS) {
  const w = winOf(p);
  put(`pnl/${w.id}.json`, {
    ...w,
    units: p.units.toString(),
    entryPrice: usdg((p.premium * UNITS_PER_SHARE) / p.units),
    // A fully closed resale position may have a verified win before its series
    // settles. These fixtures are settled, but the frozen response permits null.
    settlementPrice: p.series.settledAt === null ? null : usdg(oracleOf(p.series).price),
    spotAtEntry: usdg(p.firstSpot),
  });
}

{
  const exerciseFees = sumBy(REDEMPTIONS, (r) => r.feeValue);
  const winsDay = WINS.filter((p) => p.series.settledAt > NOW - DAY);
  const winsWeek = WINS.filter((p) => p.series.settledAt > NOW - 7 * DAY);
  const receivers = new Set(FILLS.map((f) => (f.takerIsBuyer ? f.taker : f.maker)));
  put("stats.json", {
    asOf: ASOF,
    volume24h: usdg(volumeOf(within(FILLS, DAY))),
    volumeAll: usdg(volumeOf(FILLS)),
    premiumAll: usdg(volumeOf(FILLS.filter((f) => f.primary))),
    feesAll: usdg(sumBy(FILLS, (f) => f.sellerFee + f.takerFee - f.makerRebate) + exerciseFees),
    contractsFilled: sumBy(FILLS, (f) => f.units).toString(),
    holders: receivers.size,
    biggestWinDay: biggest(winsDay) ? winOf(biggest(winsDay)) : null,
    biggestWinWeek: biggest(winsWeek) ? winOf(biggest(winsWeek)) : null,
  });
}

// --- v8 administration + flywheel --------------------------------------------------------------
const FLYWHEEL_DISTRIBUTIONS = [
  {
    id: `${txHash("flywheel:distribution:usdg")}-0`,
    asset: USDG.address,
    symbol: USDG.symbol,
    decimals: USDG.decimals,
    assetInRaw: usd("12.5").toString(),
    usdgInRaw: usd("12.5").toString(),
    treasuryOutRaw: usd("6.25").toString(),
    buybackAddedRaw: usd("6.25").toString(),
    ts: NOW - 7_200,
    tx: txHash("flywheel:distribution:usdg"),
  },
  {
    id: `${txHash("flywheel:distribution:nvda")}-0`,
    asset: MARKETS.NVDA.underlying,
    symbol: MARKETS.NVDA.ticker,
    decimals: 18,
    assetInRaw: tokens("0.08").toString(),
    usdgInRaw: usd("17").toString(),
    treasuryOutRaw: usd("8.5").toString(),
    buybackAddedRaw: usd("8.5").toString(),
    ts: NOW - 10_800,
    tx: txHash("flywheel:distribution:nvda"),
  },
];
put("flywheel.json", {
  configured: true,
  splitter: FLYWHEEL.feeSplitter,
  tokenAddress: derive("token:STONKHOUSE"),
  tokenDecimals: 18,
  burnedTotal: tokens("1250").toString(),
  burned7d: tokens("250").toString(),
  // Revenue is grouped in the native asset actually received; unsold Stock Tokens are not
  // silently valued as USDG. `held` separately exposes what the splitter has not converted.
  revenue7d: [
    { asset: USDG.address, symbol: USDG.symbol, decimals: USDG.decimals, amountRaw: usd("12.5").toString() },
    { asset: MARKETS.NVDA.underlying, symbol: MARKETS.NVDA.ticker, decimals: 18, amountRaw: tokens("0.08").toString() },
  ],
  held: [
    { asset: MARKETS.NVDA.underlying, symbol: MARKETS.NVDA.ticker, decimals: 18, amountRaw: tokens("0.03").toString() },
  ],
  lastDistribution: FLYWHEEL_DISTRIBUTIONS[0],
  distributions: FLYWHEEL_DISTRIBUTIONS,
});

// Lending vault at /v2/earn. skimmed is null (no skim observed) vs deposited "0" would be a
// measured empty book; lastAdapterMove.delivered is null (move not reported), not zero.
put("earn.json", {
  configured: true,
  vaults: [
    {
      vault: derive("contract:EarnVault"),
      asset: USDG.address,
      adapter: null,
      paused: false,
      sharesSupply: tokens("100").toString(),
      deposited: usd("1000").toString(),
      skimmed: null,
      queue: { depth: 1, oldestRequestedAt: NOW - 3_600 },
      lastAdapterMove: {
        adapter: null,
        direction: "pull",
        requested: usd("50").toString(),
        delivered: null,
        ts: NOW - 1_800,
        tx: txHash("earn:adapter:pull"),
      },
    },
  ],
});

// House vault tape. Epochs are Friday 20:00Z settlement to the next Friday (P8-06).
// The running epoch (09-11 → 09-18, NOW is Wed 09-16) has nav: null — never 0, never omitted.
// 09-04 → 09-11 is a published LOSING epoch (resultUsdg negative).
{
  const week = 7 * DAY;
  const runningStart = EXPIRY["09-11"];
  const runningEnd = EXPIRY["09-18"];
  const lostStart = runningStart - week;
  const lostEnd = runningStart;
  const running = {
    id: String(runningStart),
    start: runningStart,
    end: runningEnd,
    nav: null,
    resultUsdg: null,
  };
  const lost = {
    id: String(lostStart),
    start: lostStart,
    end: lostEnd,
    nav: {
      epoch: String(lostStart),
      at: lostEnd,
      usdg: usdg(usd("800")),
      stockUnits: tokens("40").toString(),
      settlementPrice: usdg(usd("215.50")),
      navUsdg: usdg(usd("9420")),
    },
    resultUsdg: money(-usd("180"), 6),
  };
  const nvdaVault = derive("contract:HouseVault.NVDA");
  const tslaVault = derive("contract:HouseVault.TSLA");
  put("house.json", {
    items: [
      { market: "NVDA", vault: nvdaVault, currentEpoch: running, sharesSupply: tokens("1000").toString() },
      { market: "TSLA", vault: tslaVault, currentEpoch: running, sharesSupply: tokens("250").toString() },
    ],
    nextCursor: null,
  });
  put("house/NVDA.json", {
    market: "NVDA",
    vault: nvdaVault,
    currentEpoch: running,
    epochs: [lost, running],
    shares: null,
    queue: [
      {
        kind: "withdraw",
        account: A.sam,
        assets: null,
        shares: tokens("10").toString(),
        requestedAt: NOW - 7_200,
      },
    ],
  });
}

put("admin/operations.json", {
  items: PENDING_OPERATIONS.map((operation) => ({ ...operation, status: "pending" })),
  nextCursor: null,
});

// --- makers: weekly epochs from Monday 00:00Z; quoting-quality figures are fixture constants -------
// Epoch id (02-interfaces §1.9): whole weeks since Monday 1970-01-05 00:00Z, i.e. floor((t - 345600) / 604800).
// Unix time 0 was a Thursday, so floor(t / 604800) would roll over on Thursdays; for a Monday start the two agree.
const MONDAY_EPOCH_OFFSET = 345_600;
const WEEK = 604_800;
const epochIdOf = (t) => Math.floor((t - MONDAY_EPOCH_OFFSET) / WEEK);
{
  // The epoch publishes the scoring policy its figures were produced under (X3-201). The values are the
  // OQ-14 placeholders from indexer/lib/v2/makerScoring.ts MAKER_SCORING_POLICY, mirrored here rather than
  // chosen: 1000 bps with a 0.02 USDG floor. They are NOT approved for funded use.
  const MAKER_BAND = { bps: 1000, minUsdg: usdg(20_000n) };
  const epochAt = (iso) => ({ id: epochIdOf(at(iso)), start: at(iso), end: at(iso) + WEEK, band: MAKER_BAND });
  const EPOCHS = [epochAt("2026-09-07T00:00:00Z"), epochAt("2026-09-14T00:00:00Z")];
  const [E1, E2] = EPOCHS.map((e) => e.id);
  // X8-312. WHICH BENCHMARK THESE FIGURES CAME FROM, MIRRORED FROM THE PRODUCER, NOT RETYPED.
  // A fixture that states a policy number of its own would agree with itself forever while the
  // indexer moved underneath it, which is the exact failure this field exists to make impossible.
  // So read the constant out of the source that defines it and fail generation if it is not there.
  const POLICY_SOURCE = "indexer/lib/v2/makerScoring.ts";
  const BENCHMARK_POLICY = (() => {
    const text = readFileSync(join(REPO, POLICY_SOURCE), "utf8");
    const match = /export const MAKER_BENCHMARK_POLICY = (\d+);/.exec(text);
    if (match === null) throw new Error(`cannot read MAKER_BENCHMARK_POLICY from ${POLICY_SOURCE}`);
    return Number(match[1]);
  })();
  // Not derivable from events (they come from the indexer's book sampling): stated here.
  //
  // `samples` is stated for the same reason, and it is the point of X8-312: absent (no quote on
  // either side) and valid (quoted and measured, possibly at zero) are DIFFERENT FACTS about a
  // maker, and a score alone cannot tell them apart. `manual` in E1 is the mostly-absent maker;
  // `roller` in E1 quoted four times as often for a score only 4.2 points higher, and the counts
  // are the only place that difference is visible. missingReference (quoted, but no chain
  // reference existed to measure against) is deliberately non-zero for some maker-epochs and zero
  // for others, because a consumer that treats it as always-zero is the bug.
  const QUALITY = new Map([
    [A.makerVault, {
      [E1]: { uptimePct: 98.7, avgSpreadBps: 1510, depthWithin100bps: "1850", depthInBand: "2600", score: 88.1, samples: { absent: 12, valid: 988, missingReference: 8 } },
      [E2]: { uptimePct: 99.4, avgSpreadBps: 1480, depthWithin100bps: "2240", depthInBand: "3100", score: 91.6, samples: { absent: 6, valid: 994, missingReference: 0 } },
    }],
    [A.manual, {
      [E1]: { uptimePct: 12.5, avgSpreadBps: null, depthWithin100bps: "0", depthInBand: "0", score: 9.8, samples: { absent: 850, valid: 150, missingReference: 0 } },
      [E2]: { uptimePct: 31.0, avgSpreadBps: null, depthWithin100bps: "50", depthInBand: "420", score: 24.3, samples: { absent: 650, valid: 350, missingReference: 24 } },
    }],
    [A.roller, {
      [E1]: { uptimePct: 71.2, avgSpreadBps: null, depthWithin100bps: "0", depthInBand: "180", score: 14.0, samples: { absent: 250, valid: 750, missingReference: 40 } },
      [E2]: { uptimePct: 96.5, avgSpreadBps: null, depthWithin100bps: "0", depthInBand: "240", score: 17.2, samples: { absent: 25, valid: 975, missingReference: 5 } },
    }],
  ]);
  const statsFor = (maker, epoch) => {
    const fills = FILLS.filter((f) => f.maker === maker && f.ts >= epoch.start && f.ts < epoch.end);
    const q = QUALITY.get(maker)[epoch.id];
    return {
      benchmarkPolicy: BENCHMARK_POLICY,
      samples: q.samples,
      uptimePct: q.uptimePct,
      avgSpreadBps: q.avgSpreadBps,
      depthWithin100bps: q.depthWithin100bps,
      depthInBand: q.depthInBand,
      fills: fills.length,
      volume: usdg(volumeOf(fills)),
      rebates: usdg(sumBy(fills, (f) => f.makerRebate)),
      score: q.score,
    };
  };
  // Pins on the stated counts, so they cannot be arbitrary. uptime is the two-sided share of
  // absent + valid (indexer/lib/v2/makerScoring.ts advanceMakerEpoch), and a maker cannot be
  // two-sided on a tick it did not quote, so uptimePct can never exceed the valid share.
  // missingReference is outside that denominator on purpose: a missing benchmark is not downtime.
  for (const [maker, byEpoch] of QUALITY) {
    for (const [id, q] of Object.entries(byEpoch)) {
      const scored = q.samples.absent + q.samples.valid;
      if (scored === 0) throw new Error(`scenario pin failed: maker ${maker} epoch ${id} has no scored sample`);
      if (q.uptimePct > (100 * q.samples.valid) / scored) {
        throw new Error(`scenario pin failed: maker ${maker} epoch ${id} uptime ${q.uptimePct}% exceeds its valid share`);
      }
    }
  }
  // The 1000 bps band strictly CONTAINS the 100 bps one, so every order counted in depthWithin100bps is
  // also counted in depthInBand. A fixture where the band figure is the smaller one would teach a consumer
  // that the two are interchangeable, which is exactly what D10 forbids.
  for (const [maker, byEpoch] of QUALITY) {
    for (const [id, q] of Object.entries(byEpoch)) {
      if (BigInt(q.depthInBand) < BigInt(q.depthWithin100bps)) {
        throw new Error(`scenario pin failed: maker ${maker} epoch ${id} has depthInBand below depthWithin100bps`);
      }
    }
  }
  {
    // /v2/services: `healthy` is true ONLY for reason "ready" (schema.ts pricerServiceSchema), and the
    // reasons list is empty while ready. A fixture that broke either would teach a consumer to read
    // `reason` when `healthy` alone is meant to be fail-closed.
    const services = JSON.parse(FILES.get("services.json"));
    if (services.pricer.healthy !== (services.pricer.reason === "ready")) {
      throw new Error("scenario pin failed: /v2/services healthy disagrees with its reason");
    }
    if (services.pricer.reason === "ready" && services.pricer.reasons.length !== 0) {
      throw new Error("scenario pin failed: a ready pricer carries failure reasons");
    }
    if (!(services.pricer.lastEvaluationAt < services.pricer.checkedAt)) {
      throw new Error("scenario pin failed: /v2/services lastEvaluationAt is not earlier than checkedAt");
    }
  }
  {
    const all = [...QUALITY.values()].flatMap((byEpoch) => Object.values(byEpoch));
    if (!all.some((q) => q.samples.missingReference > 0)) throw new Error("scenario pin failed: no maker-epoch has a missing reference");
    if (!all.some((q) => q.samples.missingReference === 0)) throw new Error("scenario pin failed: every maker-epoch has a missing reference");
    // The X8-312 contrast itself: two makers whose scores are close while their absence is not.
    const absent = QUALITY.get(A.manual)[E1].samples.absent;
    const quoted = QUALITY.get(A.roller)[E1].samples.absent;
    if (!(absent > quoted * 3)) throw new Error("scenario pin failed: no absent-vs-quoted contrast in E1");
  }
  const current = EPOCHS.find((e) => e.start <= NOW && NOW < e.end);
  const makers = [...QUALITY.keys()];
  put("makers.json", {
    epoch: current,
    items: makers
      .map((maker) => ({ maker, tierBps: Number(rebateBpsOf(maker)), ...statsFor(maker, current) }))
      .sort((a, b) => b.score - a.score),
    nextCursor: null,
  });
  for (const maker of makers) {
    put(`makers/${maker}.json`, {
      maker,
      tierBps: Number(rebateBpsOf(maker)),
      epochs: [...EPOCHS].reverse().map((epoch) => ({ epoch, ...statsFor(maker, epoch) })),
    });
  }
}

// --- rewards: funding is per distributor; entitlement and claims are per posted epoch ---------
{
  const epochId = epochIdOf(at("2026-09-14T00:00:00Z"));
  const root = txHash("reward-root:maker:2958");
  put("rewards/epochs.json", {
    program: "maker",
    distributors: [{
      distributor: CONTRACTS.rewardsDistributor,
      funded: usdg(100_000_000n),
      defunded: usdg(5_000_000n),
      balance: usdg(75_000_000n),
    }],
    items: [{
      distributor: CONTRACTS.rewardsDistributor,
      epochId,
      root,
      total: usdg(25_000_000n),
      claimed: usdg(20_000_000n),
    }],
    nextCursor: null,
  });
  put(`rewards/${A.sam}/claims.json`, {
    address: A.sam,
    items: [{
      program: "maker",
      distributor: CONTRACTS.rewardsDistributor,
      epochId,
      index: 0,
      amount: usdg(20_000_000n),
      claimed: true,
      tx: txHash("reward-claim:maker:2958:0"),
    }],
    nextCursor: null,
  });
}

// --- protocol MakerVault: live wallet/ledger state and risk controls ---------------------------
{
  const liveOrders = ORDERS.filter((order) => order.maker === A.makerVault && isLive(order));
  const tracked = [...new Map(liveOrders.map((order) => [order.series.longId, order.series])).values()];
  const assets = [USDG, ...[...new Map(tracked.map((series) => [
    series.market.underlying,
    { address: series.market.underlying, symbol: series.market.ticker, decimals: 18 },
  ])).values()]];
  const walletOf = (asset) => asset.address === USDG.address ? usd("12")
    : asset.symbol === "NVDA" ? tokens("2") : 0n;
  put("vault.json", {
    vault: A.makerVault,
    protocol: true,
    balances: {
      wallet: assets.map((asset) => ({
        asset: asset.address, symbol: asset.symbol, free: money(walletOf(asset), asset.decimals),
      })).sort((left, right) => left.symbol.localeCompare(right.symbol)),
      ledger: assets.map((asset) => ({
        asset: asset.address, symbol: asset.symbol,
        free: money(freeOf(A.makerVault, asset.address), asset.decimals),
      })).sort((left, right) => left.symbol.localeCompare(right.symbol)),
    },
    limits: {
      maxSeriesUnits: "10000",
      maxTotalNotional: usd("250000").toString(),
      askToleranceBps: 100,
      maxBidBpsOfSpot: 1000,
      maxOrderLifetime: 3600,
      maxDailyOutflow: usd("2500").toString(),
    },
    outflow: { used: usdg(usd("500")), cap: usdg(usd("2500")) },
    liveOrderCount: liveOrders.length,
    trackedSeries: tracked.map((series) => series.longId.toString()),
  });
}

// =============================================================================================
// Scenario pins: fail generation rather than publish a fixture set that lost its point
// =============================================================================================

{
  const expect = (cond, what) => {
    if (!cond) throw new Error(`scenario pin failed: ${what}`);
  };
  const statuses = (ticker, date) => [...new Set(SERIES.filter((s) => s.ticker === ticker && s.date === date).map(statusOf))];
  expect(statuses("NVDA", "09-11").join() === "settled", "NVDA 09-11 settled");
  expect(statuses("NVDA", "09-16").join() === "settling", "NVDA 09-16 settling");
  expect(statuses("TSLA", "09-15").join() === "held", "TSLA 09-15 held");
  for (const [t, d] of [["NVDA", "09-17"], ["NVDA", "09-18"], ["NVDA", "09-25"], ["TSLA", "09-18"], ["TSLA", "09-25"]]) {
    expect(statuses(t, d).join() === "open", `${t} ${d} open`);
  }
  expect(SERIES.filter((s) => s.ticker === "TSLA" && s.date === "09-25").every((s) => BOOKS.get(s).bids.length + BOOKS.get(s).asks.length === 0), "TSLA 09-25 books empty");
  const settledPositions = POSITIONS.filter((p) => p.series.date === "09-11");
  expect(settledPositions.some((p) => p.counted && p.payout > p.cost), "a counted win");
  expect(settledPositions.some((p) => p.counted && p.payout <= p.cost), "a counted loss");
  expect(settledPositions.some((p) => !p.counted), "a position under the 0.10 USDG floor");
  expect(settledPositions.some((p) => (p.series.long.get(p.holder) ?? 0n) > 0n), "an unredeemed (claimable) holder");
  expect(REDEMPTIONS.some((r) => r.realisedPnl < 0n), "a negative realised PnL");
  expect(FILLS.some((f) => !f.takerIsBuyer && f.recipient !== f.taker && f.recipient !== f.maker), "a sale into a bid paid to a third wallet");
  expect(CALENDAR.some((d) => d.isHoliday && !d.isSessionDay), "a calendar holiday");
  expect(SERIES.every((s) => !CALENDAR_HOLIDAYS.has(Math.floor(s.expiry / DAY))), "no series expires on a holiday");
  expect(ROLLS.at(-1).ts < ROLLS.at(-1).series.expiry, "the roller's last roll precedes its series' expiry");
  for (const [a, assets] of FREE) for (const [asset, v] of assets) expect(v >= 0n, `ledger ${a} ${asset}`);
}

// =============================================================================================
// Write or check
// =============================================================================================

function existingJson(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) existingJson(p, acc);
    else if (name.endsWith(".json")) acc.push(relative(HERE, p).split(sep).join("/"));
  }
  return acc;
}

const onDisk = existingJson(HERE);
if (process.argv.includes("--check")) {
  const problems = [];
  for (const [path, body] of FILES) {
    let current = null;
    try {
      current = readFileSync(join(HERE, path), "utf8");
    } catch {
      problems.push(`missing  ${path}`);
      continue;
    }
    if (current !== body) problems.push(`differs  ${path}`);
  }
  for (const path of onDisk) if (!FILES.has(path)) problems.push(`extra    ${path}`);
  if (problems.length) {
    console.error(`fixtures drifted from gen.mjs (${problems.length}):\n  ${problems.join("\n  ")}\nrun: node ops/fixtures/api/v2/gen.mjs`);
    process.exit(1);
  }
  console.log(`fixtures OK — ${FILES.size} files match gen.mjs`);
} else {
  for (const path of onDisk) if (!FILES.has(path)) rmSync(join(HERE, path));
  for (const [path, body] of FILES) {
    mkdirSync(dirname(join(HERE, path)), { recursive: true });
    writeFileSync(join(HERE, path), body);
  }
  console.log(
    `wrote ${FILES.size} fixtures — ${SERIES.length} series, ${FILLS.length} fills, ${REDEMPTIONS.length} redemptions, ${WINS.length} wins, ${CARDS.length} cards; hero ${hero.series.ticker} ${hero.series.strike.formatted} ×${hero.perUnit.multiple}`,
  );
}
