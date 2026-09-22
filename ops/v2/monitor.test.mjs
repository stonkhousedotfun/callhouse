/* -------------------------------------------------------------------------------------------------
 * node --test ops/v2/monitor.test.mjs
 *
 * The pure checks of ops/v2/monitor.mjs (every condition and its boundary), the dedupe rules, the
 * relay payload shape, argument and registry parsing, and one whole pass with no chain: a dead RPC,
 * two local /health servers and a local relay stand-in, run three times against one state file.
 * The chain-reading half is exercised by ops/v2/monitor-devnet.mjs on the devnet.
 * ------------------------------------------------------------------------------------------------- */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import {
  ABI_TEXT,
  ACTIONS,
  applyOracleHaltLogs,
  BUYBACK_COOLDOWN,
  CONFIG_EVENTS,
  DEDICATED_EVENTS,
  DEFAULTS,
  DEFAULT_REGISTRY,
  FEE_CHANGE_DELAY,
  KINDS,
  KIND_RE,
  MANAGER_OPERATION_EVENTS,
  MANAGER_ROLE_EVENTS,
  MAX_HOOK_FEE_BPS,
  MAX_REPRICE_DROP_BPS,
  MAX_ROUTE_FEE_BPS,
  MAX_TENOR,
  MIN_SAFE_THRESHOLD,
  MIN_SERIES_LEAD,
  OWN_KIND_EVENTS,
  PINS_DIRTY_EVENTS,
  RANK,
  ROLE_MANIFEST,
  SCAN_EVENTS,
  SPLITTER_EVENTS,
  UsageError,
  ZERO,
  applyFlywheelLogs,
  buybackClock,
  checkBuyback,
  checkManagerWiring,
  checkRoute,
  checkRouteDecode,
  checkSafeThreshold,
  checkSplitter,
  checkTokenPool,
  checkTvl,
  tvlFaults,
  loadRoleManifest,
  managerEventFindings,
  parsePayoutRoute,
  reasonText,
  roleDelayS,
  roleLabel,
  routeCurrencies,
  routeVenueName,
  v4PoolId,
  adminEventFindings,
  repriceFindings,
  alertPayload,
  applyScanLogs,
  checkBacklog,
  checkExpiry,
  checkFeedMismatch,
  checkFeedProxy,
  checkFeedStale,
  checkPriceDivergence,
  checkHeadLag,
  checkHealth,
  checkMarketOracle,
  checkMintFee,
  checkMintRent,
  checkPendingFees,
  checkPinSimulation,
  checkPricerActivity,
  checkPinnedBy,
  checkPinnedConfig,
  checkPool,
  checkQuoteReadiness,
  checkRewards,
  checkRollerAsk,
  checkRoundJumps,
  checkSourceAges,
  checkSourceSwitch,
  checkSafe,
  checkStockToken,
  checkUsdg,
  checkHouseEpoch,
  checkVault,
  checkVaultOutflow,
  closeOfDay,
  configEventFindings,
  decodePinRevert,
  emptyState,
  exitCodeFor,
  expiryTenor,
  expectedPinnedConfig,
  feeRises,
  feeScheduledFindings,
  fingerprintOf,
  finding,
  fixed,
  gridCloses,
  isRevert,
  isTradingDay,
  loadViem,
  mapLimit,
  marketsInScope,
  marketSourceLabels,
  modelSpendPerExpiry,
  multiplierEventFindings,
  oracleHaltFindings,
  oracleHaltTopics,
  observedSpend,
  parseArgs,
  parseRegistry,
  pinTargets,
  probeTargets,
  prePinFindings,
  readFairAnswer,
  reconcile,
  markDelivered,
  marketStretch,
  NYSE_FULL_HOLIDAYS,
  openMarketSeconds,
  resolvedFinding,
  revertDataOf,
  roundIdsToRead,
  runOnce,
  scanEventName,
  unknownPricingReasons,
} from "./monitor.mjs";
import { C, FakeChain, SRC, USDG, addr, defaultRead, fakeViem, kindsOf, market, options, rawLog, tmp, transportError, viem, writeRegistry } from "./fake-chain.mjs";

const U = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const ORACLE = "0x4b8c2BEFfecbdc4BeD6e6826e62093F0Cf635E78";
const CL = "0x157f589Cd9d0E4a94C9936ede3b23BEfa3017F20";
const UNI = "0x5d46388aD462fF7f92587fE4872e97668e98329d";
const E = 1_789_675_200;
const t = { ...DEFAULTS };
const kinds = (fs) => fs.map((f) => `${f.kind}/${f.severity}`).sort();

// OWN8-09 (46c3e6b5) turned a DARK audit-trigger notice into a fault: with `auditTriggerUsdg` 0 and
// USDG actually held by the v2 contracts, `tvlFaults` now pages instead of staying silent, because
// "off with collateral in the contracts is the notice being dark exactly when it matters". Every
// fixture below that builds a registry holds USDG through `defaultRead`, so this kind is part of the
// truth of those passes and the exact-list assertions have to name it. Do NOT filter it out of
// `kindsOf` instead: filtering here is precisely the change that would hide the notice going dark in
// production, which is the condition OWN8-09 exists to surface.
const TVL_DARK = "v2_mon_tvl_audit_trigger";

const expiry = (over = {}) => ({
  oracle: ORACLE,
  underlying: U,
  ticker: "NVDA",
  expiry: E,
  now: E + 7200,
  openInterest: 100n,
  status: "None",
  candidate: null,
  sources: [CL, UNI],
  univ3Source: UNI,
  snapshotRecordedAt: E + 30,
  ...over,
});
const cand = (over = {}) => ({ price: 217_160_000n, sourceIndex: 0, disagreed: false, finalizableAt: E + 120 + 21_600, ...over });

describe("settlement", () => {
  test("nothing before expiry, without open interest, or once final", () => {
    assert.deepEqual(checkExpiry(expiry({ now: E - 1 }), t), []);
    assert.deepEqual(checkExpiry(expiry({ openInterest: 0n }), t), []);
    assert.deepEqual(checkExpiry(expiry({ status: "Finalized" }), t), []);
  });

  test("None: late is an error from lateS on, not before", () => {
    assert.deepEqual(checkExpiry(expiry({ now: E + 7199 }), t), []);
    const f = checkExpiry(expiry(), t);
    assert.deepEqual(kinds(f), ["v2_mon_settlement_late/error"]);
    assert.equal(f[0].key, `${U.toLowerCase()}:${E}`);
    assert.match(f[0].message, /no candidate/);
  });

  test("Pending on a two-source market: warn while the delay runs, error once overdue", () => {
    assert.deepEqual(kinds(checkExpiry(expiry({ status: "Pending", candidate: cand() }), t)), ["v2_mon_settlement_late/warn"]);
    const c = cand({ finalizableAt: E + 3600 });
    assert.deepEqual(checkExpiry(expiry({ status: "Pending", candidate: c, now: E + 3600 + 899 }), t), []); // under lateS
    assert.deepEqual(kinds(checkExpiry(expiry({ status: "Pending", candidate: c, now: E + 7200 }), t)), ["v2_mon_settlement_late/error"]);
  });

  test("Pending on a single-source market waits its delay silently, then pages when nobody finalizes", () => {
    const single = { sources: [CL], status: "Pending", candidate: cand() };
    assert.deepEqual(checkExpiry(expiry(single), t), []);
    const overdue = expiry({ ...single, now: E + 120 + 21_600 + 900 });
    assert.deepEqual(kinds(checkExpiry(overdue, t)), ["v2_mon_settlement_late/error"]);
    assert.match(checkExpiry(overdue, t)[0].message, /nobody called finalize/);
  });

  test("a disagreeing candidate pages as its own kind (keyed by finalizableAt), not as late", () => {
    const f = checkExpiry(expiry({ status: "Pending", candidate: cand({ disagreed: true }) }), t);
    assert.deepEqual(kinds(f), ["v2_mon_sources_disagree/warn"]);
    assert.equal(f[0].key, `${U.toLowerCase()}:${E}:${E + 120 + 21_600}`);
    // before lateS it is already reported
    assert.deepEqual(kinds(checkExpiry(expiry({ now: E + 300, status: "Pending", candidate: cand({ disagreed: true }) }), t)), ["v2_mon_sources_disagree/warn"]);
  });

  test("Held pages as held and never as late", () => {
    const f = checkExpiry(expiry({ status: "Held", candidate: cand(), now: E + 86_400 }), t);
    assert.deepEqual(kinds(f), ["v2_mon_settlement_held/error"]);
    assert.equal(f[0].data.resolvableAt, E + 48 * 3600);
  });

  test("snapshot missed: an event once the grace has passed, only when the pool is a listed source and recorded nothing", () => {
    const missed = expiry({ now: E + 601, snapshotRecordedAt: 0, status: "Pending", candidate: cand() });
    const f = checkExpiry(missed, t);
    assert.deepEqual(kinds(f), ["v2_mon_snapshot_missed/warn"]);
    assert.equal(f[0].event, true);
    assert.deepEqual(checkExpiry({ ...missed, now: E + 600 }, t), []);
    assert.deepEqual(checkExpiry({ ...missed, snapshotRecordedAt: null }, t), []);
    assert.deepEqual(checkExpiry({ ...missed, sources: [CL] }, t), []);
    assert.deepEqual(checkExpiry({ ...missed, univ3Source: null }, t), []);
  });
});

describe("redeem backlog", () => {
  const base = {
    longId: "42",
    ticker: "NVDA",
    isPut: false,
    strike: 205_000_000n,
    expiry: E,
    settledAt: E + 130,
    now: E + 130 + 21_600,
    long: { perUnit: 1n, holders: 0, units: 0n },
    short: { perUnit: 1n, holders: 0, units: 0n },
    bookUnits: 0n,
    optedOut: 0,
  };
  test("nothing before backlogS, nothing when drained", () => {
    assert.deepEqual(checkBacklog({ ...base, now: base.now - 1, long: { perUnit: 1n, holders: 2, units: 110n } }, t), []);
    assert.deepEqual(checkBacklog(base, t), []);
    assert.deepEqual(checkBacklog({ ...base, settledAt: null }, t), []);
  });
  test("holders or book escrow left page once per series", () => {
    const f = checkBacklog({ ...base, long: { perUnit: 1n, holders: 2, units: 110n } }, t);
    assert.deepEqual(kinds(f), ["v2_mon_redeem_backlog/warn"]);
    assert.equal(f[0].key, "42");
    assert.match(f[0].message, /2 long and 0 short holder\(s\) \(1\.10 long/);
    const book = checkBacklog({ ...base, bookUnits: 150n }, t);
    assert.match(book[0].message, /escrows 1\.50 long shares \(prune before redeem\)/);
  });
});

describe("rewards", () => {
  const bounties = { SNAPSHOT: 50_000n, FINALIZE: 50_000n, SETTLE: 50_000n, REDEEM: 20_000n, ROLL: 50_000n };
  const base = { address: "0xE06483EB1abdD00101d53c5b1Fd96D6bd08a06C0", balance: 1_000_000_000n, dailyCap: 100_000_000n, spentToday: 0n, bounties, observed: { spend: 0n, expiries: 0 } };

  test("the model: one snapshot, two finalizes, 10 settles, 20 redeems, no rolls", () => {
    assert.equal(modelSpendPerExpiry(bounties, t), 50_000n + 100_000n + 500_000n + 400_000n);
  });

  test("observed spend reads the newest window of finalized expiries", () => {
    const rewards = { "100:0": "10", "150:1": "20", "200:3": "30", "250:0": "40" };
    const finalized = { a: "90", b: "160", c: "240" };
    assert.deepEqual(observedSpend(rewards, finalized, 2), { spend: 70n, expiries: 2, fromBlock: 160n });
    assert.deepEqual(observedSpend(rewards, {}, 20), { spend: 0n, expiries: 0, fromBlock: null });
  });

  test("runway under N expiries pages; model until enough history, then observed", () => {
    assert.deepEqual(checkRewards(base, t).findings, []);
    const low = checkRewards({ ...base, balance: 1_000_000n }, t);
    assert.deepEqual(kinds(low.findings), ["v2_mon_rewards_budget_low/warn"]);
    assert.equal(low.runway, 0n);
    assert.match(low.basis, /bounty table/);
    const observed = checkRewards({ ...base, balance: 10_000_000n, observed: { spend: 3_000_000n, expiries: 3 } }, t);
    assert.equal(observed.perExpiry, 1_000_000n);
    assert.equal(observed.runway, 10n);
    assert.match(observed.basis, /observed/);
  });

  test("daily cap at 0 or reached; no budget finding when nothing is paid", () => {
    assert.deepEqual(kinds(checkRewards({ ...base, dailyCap: 0n }, t).findings), ["v2_mon_rewards_cap/warn"]);
    assert.deepEqual(kinds(checkRewards({ ...base, spentToday: 100_000_000n }, t).findings), ["v2_mon_rewards_cap/warn"]);
    const none = { SNAPSHOT: 0n, FINALIZE: 0n, SETTLE: 0n, REDEEM: 0n, ROLL: 0n };
    assert.deepEqual(checkRewards({ ...base, balance: 0n, dailyCap: 0n, bounties: none }, t).findings, []);
  });
});

describe("maker vault", () => {
  const base = {
    address: "0xbc7dcd2B9603981452a9841040308640590274EB",
    limits: { maxSeriesUnits: 10_000n, maxTotalNotional: 250_000_000_000n },
    totalNotional: 1_000_000_000n,
    series: [{ longId: "7", label: "NVDA call 222.50", units: 800n, live: 2 }],
    usdgAvailable: 100_000_000_000n,
    tokens: [{ ticker: "NVDA", token: U, available: 100n * 10n ** 18n }],
  };
  test("clean below the thresholds", () => assert.deepEqual(checkVault(base, t), []));
  test("utilisation at 90 % and the live-order count", () => {
    const f = checkVault({ ...base, totalNotional: 225_000_000_000n, series: [{ longId: "7", label: "x", units: 9_000n, live: 15 }] }, t);
    assert.deepEqual(f.map((x) => x.key.split(":").slice(1, 2)[0]).sort(), ["orders", "total", "units"]);
    assert.deepEqual(checkVault({ ...base, totalNotional: 224_999_999_999n, series: [{ longId: "7", label: "x", units: 8_999n, live: 14 }] }, t), []);
  });
  test("inventory floors", () => {
    const f = checkVault({ ...base, usdgAvailable: 99_999_999n, tokens: [{ ticker: "NVDA", token: U, available: 10n ** 18n - 1n }] }, t);
    assert.deepEqual(kinds(f), ["v2_mon_vault_inventory_low/warn", "v2_mon_vault_inventory_low/warn"]);
  });
});

describe("house vault epoch stall (SEC-14)", () => {
  const HV = "0x9A1f2C3D4e5F60718293A4b5C6d7E8F901234567";
  // epochEnd is in the past by two hours; the default houseEpochStallS is 1800.
  const END = 1_800_000_000;
  const base = {
    address: HV,
    ticker: "NVDA",
    epochId: 7n,
    epochEnd: END,
    now: END + 7200,
    boundary: { finalized: true, price: 222_500_000n },
    series: [{ longId: "7", label: "NVDA call 222.50 2027-01-15T21:00:00Z", exists: true, settled: true, longs: 0n, shorts: 0n, live: 0 }],
  };
  const kindsOf = (f) => f.map((x) => `${x.kind}/${x.severity}`);

  test("a flat, priced, rollable boundary is not a stall", () => assert.deepEqual(checkHouseEpoch(base, t), []));

  test("a healthy long epoch that has not ended is never a stall", () =>
    assert.deepEqual(
      checkHouseEpoch({ ...base, now: END - 1, series: [{ ...base.series[0], settled: false, live: 3 }] }, t),
      [],
    ));

  test("past epochEnd but inside the grace window stays quiet", () =>
    assert.deepEqual(checkHouseEpoch({ ...base, now: END + 1799, series: [{ ...base.series[0], settled: false }] }, t), []));

  test("an unsettled tracked series past the grace window fires once, with the recovery in the message", () => {
    const f = checkHouseEpoch({ ...base, series: [{ ...base.series[0], settled: false }] }, t);
    assert.deepEqual(kindsOf(f), ["v2_mon_house_epoch_stall/error"]);
    assert.equal(f[0].key, `${HV.toLowerCase()}:7`);
    assert.match(f[0].message, /is not settled/);
    assert.match(f[0].message, /RECOVERY: cancel the live orders/);
    assert.match(f[0].message, /2-of-3 admin Safe/);
    assert.equal(f[0].data.overdueS, 7200);
    assert.deepEqual(f[0].data.blockers, ["NVDA call 222.50 2027-01-15T21:00:00Z is not settled"]);
  });

  test("a live order alone is a stall, and so is held exposure", () => {
    const live = checkHouseEpoch({ ...base, series: [{ ...base.series[0], live: 2 }] }, t);
    assert.deepEqual(kindsOf(live), ["v2_mon_house_epoch_stall/error"]);
    assert.match(live[0].data.blockers[0], /still holds 2 live orders/);
    const held = checkHouseEpoch({ ...base, series: [{ ...base.series[0], longs: 300n }] }, t);
    assert.match(held[0].data.blockers[0], /still holds 3.00 long/);
  });

  test("an unfinalized boundary price is a blocker; an UNREAD one is not", () => {
    const unfinalized = checkHouseEpoch({ ...base, boundary: { finalized: false, price: 0n } }, t);
    assert.deepEqual(kindsOf(unfinalized), ["v2_mon_house_epoch_stall/error"]);
    assert.match(unfinalized[0].data.blockers[0], /settlement price is not Finalized/);
    assert.equal(unfinalized[0].data.boundaryFinalized, false);
    // null = the read failed. Paging for a condition the pass never observed is the defect this row removes.
    assert.deepEqual(checkHouseEpoch({ ...base, boundary: null }, t), []);
  });

  test("a series the Clearinghouse does not know is not counted as unsettled", () =>
    assert.deepEqual(checkHouseEpoch({ ...base, series: [{ ...base.series[0], exists: false, settled: false }] }, t), []));

  test("every blocker on one vault is one finding, not three pages", () => {
    const f = checkHouseEpoch(
      {
        ...base,
        boundary: { finalized: false, price: 0n },
        series: [
          { ...base.series[0], settled: false, live: 1 },
          { longId: "9", label: "NVDA put 200.00 2027-01-15T21:00:00Z", exists: true, settled: true, longs: 0n, shorts: 500n, live: 0 },
        ],
      },
      t,
    );
    assert.equal(f.length, 1);
    assert.equal(f[0].data.blockers.length, 4);
    assert.equal(f[0].data.trackedSeries, 2);
  });
});

describe("feeds", () => {
  const FEED = "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15";
  const AGG = "0xC9d16E4f2569b9E3ea0468fD85844953713DC2a2";
  const AGG2 = "0x1111111111111111111111111111111111111111";
  const SAFE = "0xeE27D5Ae494300902D90454e8630A3F1C68c9C52";
  const ctx = { ticker: "NVDA", feed: FEED, registryAggregator: AGG };
  const cur = { aggregator: AGG, accessController: "0x0000000000000000000000000000000000000000", owner: SAFE };

  test("first sight: the registry's feedAggregator is the baseline", () => {
    assert.deepEqual(checkFeedProxy(undefined, cur, ctx).findings, []);
    const f = checkFeedProxy(undefined, { ...cur, aggregator: AGG2 }, ctx).findings;
    assert.deepEqual(kinds(f), ["v2_mon_feed_aggregator_changed/warn"]);
    assert.match(f[0].message, /registry's feedAggregator/);
    assert.deepEqual(checkFeedProxy(undefined, { ...cur, aggregator: AGG2 }, { ...ctx, registryAggregator: null }).findings, []);
  });

  test("changes against the stored baseline; access controller set is an error condition", () => {
    const prev = { aggregator: AGG, owner: SAFE, lastRoundId: "5" };
    const r = checkFeedProxy(prev, { aggregator: AGG2, accessController: AGG2, owner: AGG2 }, ctx);
    assert.deepEqual(kinds(r.findings), ["v2_mon_feed_access_controller/error", "v2_mon_feed_aggregator_changed/warn", "v2_mon_feed_owner_changed/warn"]);
    assert.deepEqual(r.baseline, { aggregator: AGG2, owner: AGG2, lastRoundId: "5" });
    assert.equal(r.findings.find((x) => x.kind === "v2_mon_feed_aggregator_changed").key, `${FEED.toLowerCase()}:${AGG2.toLowerCase()}`);
  });

  test("the oracle's feed differs from the registry's", () => {
    assert.deepEqual(checkFeedMismatch({ ticker: "NVDA", underlying: U, sourceFeed: FEED, registryFeed: FEED.toLowerCase() }), []);
    assert.deepEqual(kinds(checkFeedMismatch({ ticker: "NVDA", underlying: U, sourceFeed: AGG2, registryFeed: FEED })), ["v2_mon_feed_mismatch/error"]);
  });

  test("Safe: nonce is info, threshold and owners warn, first sight is silent", () => {
    const owners = [AGG, AGG2];
    const first = checkSafe(undefined, { nonce: 19n, threshold: 4n, owners }, { safe: SAFE, feeds: ["NVDA"] });
    assert.deepEqual(first.findings, []);
    const nonce = checkSafe(first.baseline, { nonce: 20n, threshold: 4n, owners: [...owners].reverse() }, { safe: SAFE, feeds: ["NVDA"] });
    assert.deepEqual(kinds(nonce.findings), ["v2_mon_safe_nonce_changed/info"]);
    const cfg = checkSafe(nonce.baseline, { nonce: 20n, threshold: 3n, owners }, { safe: SAFE, feeds: ["NVDA"] });
    assert.deepEqual(kinds(cfg.findings), ["v2_mon_safe_config_changed/warn"]);
  });

  test("round ids to read", () => {
    const P = 1n << 64n;
    const L = P | 10n;
    assert.deepEqual(roundIdsToRead(L, null, 24), [P | 9n, L]);
    assert.deepEqual(roundIdsToRead(L, L.toString(), 24), [L]);
    assert.deepEqual(roundIdsToRead(L, (P | 7n).toString(), 24), [P | 7n, P | 8n, P | 9n, L]);
    // more than max new rounds: the OLDEST are read, and the caller's baseline stops at the last id here,
    // so the next run continues. Reading the newest instead would step over rounds 2-6 for ever (ops-c28).
    assert.deepEqual(roundIdsToRead(L, (P | 1n).toString(), 3), [P | 1n, P | 2n, P | 3n, P | 4n]);
    assert.deepEqual(roundIdsToRead((2n * P) | 2n, (P | 9n).toString(), 24), [(2n * P) | 1n, (2n * P) | 2n]);
    assert.deepEqual(roundIdsToRead(P | 1n, null, 24), [P | 1n]);
  });

  test("a jump over 5 % between consecutive rounds is one event per round", () => {
    const P = 1n << 64n;
    const r = (a, answer) => ({ id: P | a, answer, updatedAt: E });
    const ctxJ = { ticker: "NVDA", feed: FEED, decimals: 8 };
    assert.deepEqual(checkRoundJumps([r(1n, 100_00000000n), r(2n, 105_00000000n)], ctxJ, t), []); // exactly 500 bps
    const f = checkRoundJumps([r(1n, 100_00000000n), r(2n, 105_01000000n), r(3n, 105_01000000n)], ctxJ, t);
    assert.deepEqual(kinds(f), ["v2_mon_feed_round_jump/warn"]);
    assert.equal(f[0].key, `${FEED.toLowerCase()}:${P | 2n}`);
    assert.match(f[0].message, /moved 5\.01% .*100\.00 -> 105\.01/);
    assert.deepEqual(checkRoundJumps([r(1n, null), r(2n, 200_00000000n)], ctxJ, t), []);
    assert.deepEqual(checkRoundJumps([r(1n, 100_00000000n), r(3n, 200_00000000n)], ctxJ, t), []);
    assert.equal(checkRoundJumps([r(1n, 100_00000000n), r(2n, 90_00000000n)], ctxJ, t).length, 1);
  });

  const at = (iso) => Date.parse(iso) / 1000;

  test("open 24/5 market time: weekends and full NYSE holidays count nothing, DST moves the evening", () => {
    // Friday 19:00 New York (EDT) to Monday 00:00:30Z: one hour on Friday, 30 s after Sunday 20:00.
    assert.equal(openMarketSeconds(at("2026-09-11T23:00:00Z"), at("2026-09-14T00:00:30Z")), 3630);
    assert.equal(openMarketSeconds(at("2026-09-12T12:00:00Z"), at("2026-09-13T23:59:59Z")), 0);
    // Labor Day 2026-09-07: closed from Friday 20:00 to Monday 20:00 (Tuesday 00:00Z).
    assert.equal(openMarketSeconds(at("2026-09-04T00:00:00Z"), at("2026-09-08T00:01:00Z")), 86_460);
    // After the 2026-11-01 DST change the evening is 01:00Z.
    assert.equal(openMarketSeconds(at("2026-11-01T12:00:00Z"), at("2026-11-02T01:00:10Z")), 10);
    assert.equal(openMarketSeconds(at("2026-09-15T00:00:00Z"), at("2026-09-15T00:00:00Z")), 0);
    assert.equal(isTradingDay(at("2026-09-07T00:00:00Z") / 86_400), false);
    assert.equal(isTradingDay(at("2026-09-08T00:00:00Z") / 86_400), true);
  });

  test("the market stretch: open since the last reopen, or closed", () => {
    assert.deepEqual(marketStretch(at("2026-09-14T13:30:00Z")), { open: true, reopenedAt: at("2026-09-14T00:00:00Z") });
    assert.deepEqual(marketStretch(at("2026-09-11T23:59:59Z")), { open: true, reopenedAt: at("2026-09-08T00:00:00Z") }, "Labor Day week reopened on Tuesday 00:00Z");
    assert.deepEqual(marketStretch(at("2026-09-12T00:00:00Z")), { open: false, reopenedAt: null });
    assert.deepEqual(marketStretch(at("2026-09-07T12:00:00Z")), { open: false, reopenedAt: null });
    assert.deepEqual(marketStretch(at("2026-11-02T00:30:00Z")), { open: false, reopenedAt: null }, "Sunday 19:30 EST");
    assert.deepEqual(marketStretch(at("2026-11-02T01:00:01Z")), { open: true, reopenedAt: at("2026-11-02T01:00:00Z") });
  });

  test("the holiday table is ops/markets/v2-sources.json's full days", () => {
    const recon = JSON.parse(readFileSync(new URL("../markets/v2-sources.json", import.meta.url), "utf8"));
    const days = Object.values(recon.nyseHolidays).flatMap((y) => y.fullDays.map((d) => d.date));
    assert.deepEqual([...NYSE_FULL_HOLIDAYS], days);
  });

  describe("feed stale: heartbeat + margin in open-market time, and the reopen print", () => {
    const SGOV = "0xa0DF4ee0fFf975306345875E3548Fcc519577A11";
    const x = (over) => ({ ticker: "SGOV", feed: SGOV, roundId: 1n, heartbeatS: 86_400, ...over });

    test("a heartbeat print one latency late is fine; heartbeat + 1 h of open market is an error", () => {
      const last = at("2026-09-15T00:00:10Z");
      assert.deepEqual(checkFeedStale(x({ updatedAt: last, now: at("2026-09-16T00:00:40Z") }), t), []);
      assert.deepEqual(checkFeedStale(x({ updatedAt: last, now: last + 90_000 }), t), [], "exactly the limit");
      const f = checkFeedStale(x({ updatedAt: last, now: last + 90_001 }), t);
      assert.deepEqual(kinds(f), ["v2_mon_feed_stale/error"]);
      assert.equal(f[0].key, SGOV.toLowerCase());
      assert.equal(f[0].data.openAgeS, 90_001);
      assert.equal(f[0].data.limitS, 90_000);
      assert.match(f[0].message, /no round for 25\.0 h of open market .* past its 24\.0 h heartbeat \+ 60 min: the feed is broken or stalled\. spot\(\) reverts StaleSpot/);
      assert.equal(KINDS.v2_mon_feed_stale.runbook, "ops/alerts.md §V44; ops/runbooks/incident-v2.md §7");
    });

    test("measured gaps do not page: SGOV across Labor Day (96 h wall, 24 h open), a 24 h + 27 s SPY heartbeat", () => {
      // 2026-09-04T00:01:54Z -> 2026-09-08T00:00:37Z, probed one second before the next round.
      assert.deepEqual(checkFeedStale(x({ updatedAt: at("2026-09-04T00:01:54Z"), now: at("2026-09-08T00:00:36Z") }), t), []);
      assert.deepEqual(checkFeedStale(x({ ticker: "SPY", updatedAt: at("2026-08-13T13:46:29Z"), now: at("2026-08-14T13:46:55Z") }), t), []);
      // A weekend: Friday's last print stays silent all Saturday and Sunday without a finding.
      assert.deepEqual(checkFeedStale(x({ ticker: "QQQ", updatedAt: at("2026-09-11T12:49:02Z"), now: at("2026-09-13T23:59:00Z") }), t), []);
    });

    test("no print since the reopen: warn after the grace, not before; a missed heartbeat escalates to error", () => {
      const friday = at("2026-09-11T12:49:02Z");
      assert.deepEqual(checkFeedStale(x({ updatedAt: friday, now: at("2026-09-14T00:15:00Z") }), t), [], "inside the 15 min grace");
      const w = checkFeedStale(x({ updatedAt: friday, now: at("2026-09-14T00:15:01Z") }), t);
      assert.deepEqual(kinds(w), ["v2_mon_feed_stale/warn"]);
      assert.equal(w[0].data.reopenedAt, at("2026-09-14T00:00:00Z"));
      assert.match(w[0].message, /reopened at 2026-09-14T00:00:00Z and the feed has not printed since/);
      assert.deepEqual(checkFeedStale(x({ updatedAt: at("2026-09-14T00:00:25Z"), now: at("2026-09-14T13:30:00Z") }), t), [], "the reopen print");
      assert.deepEqual(checkFeedStale(x({ updatedAt: friday, now: at("2026-09-14T00:15:01Z") }), { ...t, feedReopenGraceS: 0 }), [], "grace 0: off");
      // Friday 12:49Z + 11.2 h on Friday + 13.8 h from Sunday 20:00 = 25 h of open market on Monday 13:49Z.
      assert.deepEqual(kinds(checkFeedStale(x({ updatedAt: friday, now: at("2026-09-14T13:50:00Z") }), t)), ["v2_mon_feed_stale/error"]);
    });

    test("no round, a round from the future, a registry without a heartbeat", () => {
      assert.deepEqual(checkFeedStale(x({ updatedAt: 0, now: at("2026-09-16T00:00:00Z") }), t), []);
      assert.deepEqual(checkFeedStale(x({ updatedAt: at("2026-09-16T00:00:01Z"), now: at("2026-09-16T00:00:00Z") }), t), []);
      const last = at("2026-09-15T00:00:10Z");
      assert.deepEqual(kinds(checkFeedStale(x({ heartbeatS: null, updatedAt: last, now: last + 90_001 }), t)), ["v2_mon_feed_stale/error"]);
      assert.deepEqual(checkFeedStale(x({ heartbeatS: 172_800, updatedAt: last, now: last + 90_001 }), t), [], "a 48 h heartbeat");
    });
  });
});

describe("Stock Tokens, USDG, pools, head, services", () => {
  const token = { ticker: "NVDA", token: U, now: E, paused: false, oraclePaused: false, uiMultiplier: 10n ** 18n, newUIMultiplier: 10n ** 18n, effectiveAt: E - 100, blocked: [] };
  test("token flags, staged multiplier and blocklist", () => {
    assert.deepEqual(checkStockToken(token), []);
    assert.deepEqual(kinds(checkStockToken({ ...token, paused: true, oraclePaused: true })), ["v2_mon_oracle_paused/warn", "v2_mon_token_paused/error"]);
    const staged = checkStockToken({ ...token, newUIMultiplier: 2n * 10n ** 18n, effectiveAt: E + 3600 });
    assert.deepEqual(kinds(staged), ["v2_mon_multiplier_staged/warn"]);
    assert.match(staged[0].message, /step up: .* at 2026-.*in 60 min/);
    assert.deepEqual(checkStockToken({ ...token, newUIMultiplier: 0n }), []);
    assert.deepEqual(checkStockToken({ ...token, oraclePaused: null, uiMultiplier: null }), []);
    const blocked = checkStockToken({
      ...token,
      blocked: [
        { name: "clearinghouse", address: ORACLE, blocked: true },
        { name: "makerVault", address: CL, blocked: true },
        { name: "pool", address: UNI, blocked: false },
      ],
    });
    assert.deepEqual(kinds(blocked), ["v2_mon_token_blocked/error", "v2_mon_token_blocked/warn"]);
  });

  test("UIMultiplierUpdated: a decrease is an error", () => {
    const e = { ticker: "NVDA", token: U, oldMultiplier: 10n ** 18n, newMultiplier: 5n * 10n ** 17n, effectiveAt: E, blockNumber: 5n, transactionHash: "0xAB", logIndex: 3 };
    assert.deepEqual(kinds(multiplierEventFindings([e, { ...e, newMultiplier: 2n * 10n ** 18n, logIndex: 4 }])), ["v2_mon_multiplier_updated/error", "v2_mon_multiplier_updated/warn"]);
    assert.equal(multiplierEventFindings([e])[0].key, "0xab:3");
  });

  test("USDG pause and freezes", () => {
    const f = checkUsdg({
      usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      paused: true,
      frozen: [
        { name: "orderBook", address: CL, frozen: true },
        { name: "keeperRewards", address: UNI, frozen: true },
        { name: "clearinghouse", address: ORACLE, frozen: false },
      ],
    });
    assert.deepEqual(kinds(f), ["v2_mon_usdg_frozen/error", "v2_mon_usdg_frozen/warn", "v2_mon_usdg_paused/error"]);
    assert.deepEqual(checkUsdg({ usdg: CL, paused: false, frozen: [] }), []);
  });

  test("pool liquidity floor", () => {
    assert.deepEqual(checkPool({ ticker: "NVDA", pool: UNI, liquidity: 10n, floor: 10n, sourceFloor: null }), []);
    assert.deepEqual(kinds(checkPool({ ticker: "NVDA", pool: UNI, liquidity: 9n, floor: 10n, sourceFloor: null })), ["v2_mon_pool_liquidity_low/warn"]);
    assert.deepEqual(checkPool({ ticker: "NVDA", pool: UNI, liquidity: 9n, floor: null, sourceFloor: null }), []);
  });

  test("head lag bands; a head ahead of the wall clock (a warped devnet) is fine", () => {
    assert.deepEqual(checkHeadLag({ headBlock: 1n, headTimestamp: E, wallNow: E + 60 }, t), []);
    assert.deepEqual(kinds(checkHeadLag({ headBlock: 1n, headTimestamp: E, wallNow: E + 61 }, t)), ["v2_mon_l2_lag/warn"]);
    assert.deepEqual(kinds(checkHeadLag({ headBlock: 1n, headTimestamp: E, wallNow: E + 901 }, t)), ["v2_mon_l2_lag/error"]);
    assert.deepEqual(checkHeadLag({ headBlock: 1n, headTimestamp: E + 40_000, wallNow: E }, t), []);
  });

  test("health answers", () => {
    const h = (over) => ({ name: "notifier", url: "http://x/health", reachable: true, httpStatus: 200, body: null, error: null, ...over });
    assert.deepEqual(checkHealth(h({})), []);
    assert.deepEqual(checkHealth(h({ body: { status: "ok", database: "ok", channels: { telegram: "closed", email: "off" }, rules: { status: "ok" } } })), []);
    assert.deepEqual(checkHealth(h({ body: { status: "starting" } })), []);
    assert.deepEqual(kinds(checkHealth(h({ reachable: false, httpStatus: null, error: "ECONNREFUSED" }))), ["v2_mon_service_down/error"]);
    assert.match(checkHealth(h({ httpStatus: 503, body: { status: "wedged" } }))[0].message, /HTTP 503 \(wedged\)/);
    const degraded = checkHealth(h({ body: { status: "degraded", database: "unavailable", channels: { telegram: "open" }, rules: { status: "failing", consecutiveFailures: 4 } } }));
    assert.deepEqual(kinds(degraded), ["v2_mon_service_degraded/warn"]);
    assert.match(degraded[0].message, /status degraded, database unavailable, rules engine failing \(4 polls\), telegram breaker open/);
  });
});

describe("admin actions and the log scan", () => {
  const CH = "0x2256c045245288A314048aD2d71006a564343C63";
  const KR = "0xE06483EB1abdD00101d53c5b1Fd96D6bd08a06C0";
  const names = { [CH.toLowerCase()]: "clearinghouse", [ORACLE.toLowerCase()]: "settlementOracle" };
  const ev = (eventName, blockNumber, args = {}, address = CH) => ({ eventName, address, args, blockNumber: BigInt(blockNumber), transactionHash: `0x${String(blockNumber).padStart(64, "0")}`, logIndex: 1 });

  test("history up to the first run is adopted; later events page with their severity", () => {
    const events = [
      ev("RoleGranted", 100, { role: "0x55435dd261a4b9b3364963f7738a7a662ad9c84396d64be3365284bb7f0a5041", account: KR, sender: KR }),
      ev("RoleGranted", 201, { role: "0x55435dd261a4b9b3364963f7738a7a662ad9c84396d64be3365284bb7f0a5041", account: KR, sender: KR }),
      ev("TradingPausedSet", 202, { paused: true }),
      ev("SeriesCreated", 203),
    ];
    const f = configEventFindings(events, "200", names);
    assert.deepEqual(kinds(f), ["v2_mon_config_changed/error", "v2_mon_config_changed/warn"]);
    assert.match(f[0].message, /clearinghouse\.RoleGranted\(role=GUARDIAN_ROLE/);
    assert.equal(f[0].event, true);
    for (const s of Object.values(CONFIG_EVENTS)) assert.ok(s === "warn" || s === "error");
  });

  test("applyScanLogs keeps series, holders, settlements, finalizations, bounties; only from our contracts", () => {
    const scan = emptyState(4663, "x").scan;
    const long = 1000n;
    const other = "0x9999999999999999999999999999999999999999";
    scan.drained[long.toString()] = true;
    const logs = [
      { eventName: "SeriesCreated", address: CH, args: { longId: long, underlying: U, isPut: false, strike: 5n, expiry: E, oracle: ORACLE, mintFeePpm: 80 }, blockNumber: 1n, logIndex: 0 },
      { eventName: "SeriesCreated", address: other, args: { longId: 2n, underlying: U, isPut: false, strike: 5n, expiry: E, oracle: ORACLE, mintFeePpm: 80 }, blockNumber: 1n, logIndex: 1 },
      { eventName: "TransferSingle", address: CH, args: { to: KR, id: long | 1n }, blockNumber: 2n, logIndex: 0 },
      { eventName: "TransferBatch", address: CH, args: { to: ORACLE, ids: [long, long | 1n] }, blockNumber: 2n, logIndex: 1 },
      { eventName: "TransferSingle", address: CH, args: { to: "0x0000000000000000000000000000000000000000", id: long }, blockNumber: 2n, logIndex: 2 },
      { eventName: "SeriesSettled", address: CH, args: { longId: long }, blockNumber: 3n, logIndex: 0 },
      { eventName: "SettlementFinalized", address: ORACLE, args: { underlying: U, expiry: E }, blockNumber: 3n, logIndex: 1 },
      { eventName: "Rewarded", address: KR, args: { amount: 50_000n }, blockNumber: 3n, logIndex: 2 },
      { eventName: "Rewarded", address: other, args: { amount: 9n }, blockNumber: 3n, logIndex: 3 },
      { eventName: "FeedSet", address: CL, args: {}, blockNumber: 4n, logIndex: 0 },
    ];
    const config = applyScanLogs(scan, logs, { clearinghouse: CH, settlementOracle: ORACLE, keeperRewards: KR });
    assert.deepEqual(Object.keys(scan.series), ["1000"]);
    assert.deepEqual(scan.series["1000"], { u: U, e: E, put: false, k: "5", o: ORACLE, p: 80 });
    assert.deepEqual(scan.holders, { 1001: { [KR.toLowerCase()]: 1, [ORACLE.toLowerCase()]: 1 }, 1000: { [ORACLE.toLowerCase()]: 1 } });
    assert.equal(scan.drained["1000"], undefined);
    assert.deepEqual(scan.settled, { 1000: { block: "3", at: null } });
    assert.deepEqual(scan.finalized, { [`${U.toLowerCase()}:${E}`]: "3" });
    assert.deepEqual(scan.rewards, { "3:2": "50000" });
    assert.deepEqual(config.map((c) => c.eventName), ["FeedSet"]);
  });
});

/* ---------------------------------------------------------------------------------------------- */
/*  INTERFACE_VERSION 6                                                                            */
/* ---------------------------------------------------------------------------------------------- */

const V6 = {
  CH: "0x2256c045245288A314048aD2d71006a564343C63",
  BOOK: "0x7bA861bC1ffC9b078dC2b74D7E83ac1E1327C5b0",
  ADAPTER: "0x8Ad3945Bc4FEbeA9f41Ea80f672547a763Bef5aA",
  CAL: "0x1111111111111111111111111111111111111c01",
  DS: "0x1111111111111111111111111111111111111d05",
  ADMIN: "0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b",
  POOL: "0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3",
  TSLA: "0x322f0929C4625Ed5BaD873C95208D54E1C003B2d",
  FEED: "0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15",
};
const v6names = {
  [V6.CH.toLowerCase()]: "clearinghouse",
  [ORACLE.toLowerCase()]: "settlementOracle",
  [CL.toLowerCase()]: "ChainlinkFeedSource",
  [UNI.toLowerCase()]: "UniV3TwapSource",
  [V6.DS.toLowerCase()]: "DataStreamsSource",
  [V6.ADAPTER.toLowerCase()]: "payoutAdapter",
  [V6.BOOK.toLowerCase()]: "orderBook",
};
const v6markets = [
  { ticker: "NVDA", asset: U, feed: V6.FEED, v2: { status: "live", univ3Pool: V6.POOL, univ3MinLiquidity: 1_700_000_000_000_000_000n, overrides: {} } },
  { ticker: "TSLA", asset: V6.TSLA, feed: CL, v2: { status: "live", univ3Pool: null, univ3MinLiquidity: null, overrides: { uncorroboratedDelayS: 3600 } } },
];
const v6reg = {
  contracts: { clearinghouse: V6.CH, settlementOracle: ORACLE, orderBook: V6.BOOK },
  sources: { chainlink: CL, univ3: UNI, dataStreams: V6.DS },
  defaults: { maxDeviationBps: 150, uncorroboratedDelayS: 21600, spotMaxAgeS: 90000 },
  markets: v6markets,
};
let v6tx = 0;
const v6log = (eventName, address, args, over = {}) => {
  v6tx += 1;
  return { eventName, address, args, blockNumber: 500n, transactionHash: `0x${String(v6tx).padStart(64, "0")}`, logIndex: 0, ...over };
};
const FEES = { premiumFeeBps: 500, resaleFeeBps: 0, takerFeeFlat: 100_000, takerFeeCapBps: 1000, makerRebateBps: 5000 };
const v6addresses = { clearinghouse: V6.CH, settlementOracle: ORACLE, keeperRewards: null, orderBook: V6.BOOK, expiryCalendar: V6.CAL, chainlink: CL, univ3: UNI, dataStreams: V6.DS };

describe("v6: fee schedule", () => {
  test("a rise is any fee up or the maker rebate share down", () => {
    assert.deepEqual(feeRises(FEES, FEES), []);
    assert.deepEqual(feeRises(FEES, { ...FEES, premiumFeeBps: 400, makerRebateBps: 6000 }), []);
    assert.deepEqual(feeRises(FEES, { ...FEES, takerFeeFlat: 100_001, makerRebateBps: 4999 }), [
      { field: "takerFeeFlat", from: 100_000, to: 100_001 },
      { field: "makerRebateBps", from: 5000, to: 4999 },
    ]);
  });

  test("the log replay gives each schedule the fees in effect when it was scheduled, idempotently", () => {
    const scan = emptyState(4663, "x").scan;
    // Written in terms of the constant, not of 86,400: INTERFACE_VERSION 8 doubled FEE_CHANGE_DELAY, and a replay
    // test with the old number baked in stops exercising "a change already due when the next is scheduled" and
    // passes anyway, reporting nothing.
    const at = (t) => BigInt(t + FEE_CHANGE_DELAY);
    const afterDue = FEE_CHANGE_DELAY + 3600;
    const A = { ...FEES, premiumFeeBps: 600 };
    const B = { ...FEES, premiumFeeBps: 700 };
    const Cf = { ...FEES, premiumFeeBps: 300 };
    const ctor = v6log("FeeParamsSet", V6.BOOK, { params: FEES });
    const sA = v6log("FeeParamsScheduled", V6.BOOK, { params: A, effectiveAt: at(1000) });
    const sB = v6log("FeeParamsScheduled", V6.BOOK, { params: B, effectiveAt: at(2000) }); // replaces A before it is due
    const sC = v6log("FeeParamsScheduled", V6.BOOK, { params: Cf, effectiveAt: at(2000 + afterDue) }); // after B is due
    const out = applyScanLogs(scan, [ctor, sA, sB, sC], v6addresses);
    const before = out.filter((e) => e.eventName === "FeeParamsScheduled").map((e) => e.feesBefore.premiumFeeBps);
    assert.deepEqual(before, [500, 500, 700]);
    assert.deepEqual(scan.fees, { current: B, pending: Cf, effectiveAt: 2000 + afterDue + FEE_CHANGE_DELAY });
    const again = applyScanLogs(scan, [sC], v6addresses); // the reorg overlap re-reads the last blocks
    assert.equal(again[0].feesBefore.premiumFeeBps, 700);
    const blind = applyScanLogs(emptyState(4663, "x").scan, [sA], v6addresses);
    assert.equal(blind[0].feesBefore, null, "no constructor log seen: unknown");
    assert.equal(applyScanLogs(emptyState(4663, "x").scan, [{ ...sA, address: CL }], v6addresses).length, 0, "only the registry OrderBook");
  });

  test("scheduled: warn when nothing rises, error on a rise or an unknown baseline; adopted history is silent", () => {
    const e = (params, feesBefore, over = {}) => ({ ...v6log("FeeParamsScheduled", V6.BOOK, { params, effectiveAt: E }), feesBefore, ...over });
    const lower = feeScheduledFindings([e({ ...FEES, premiumFeeBps: 400 }, FEES)], "100");
    assert.deepEqual(kinds(lower), ["v2_mon_fee_scheduled/warn"]);
    assert.equal(lower[0].event, true);
    assert.match(lower[0].message, /seller fee 4\.00 %.*from 2026-09-17T20:00:00Z.*nothing rises/);
    assert.equal(lower[0].data.effectiveAt, E);
    const rise = feeScheduledFindings([e({ ...FEES, takerFeeCapBps: 1000, premiumFeeBps: 1000 }, FEES)], "100");
    assert.deepEqual(kinds(rise), ["v2_mon_fee_scheduled/error"]);
    assert.match(rise[0].message, /RAISES premiumFeeBps 500 -> 1000/);
    assert.deepEqual(kinds(feeScheduledFindings([e(FEES, null)], "100")), ["v2_mon_fee_scheduled/error"]);
    assert.match(feeScheduledFindings([e(FEES, FEES)], "100")[0].message, /cancels any pending change/);
    assert.deepEqual(feeScheduledFindings([e(FEES, null, { blockNumber: 100n })], "100"), []);
  });

  test("pending at the head pages only when no alert announced it", () => {
    const x = { orderBook: V6.BOOK, now: E - 3600, current: FEES, pending: { ...FEES, resaleFeeBps: 100 }, effectiveAt: E, announced: false };
    assert.deepEqual(checkPendingFees({ ...x, effectiveAt: 0 }), []);
    assert.deepEqual(checkPendingFees({ ...x, announced: true }), []);
    const f = checkPendingFees(x);
    assert.deepEqual(kinds(f), ["v2_mon_fee_change_pending/error"]);
    assert.equal(f[0].key, `${V6.BOOK.toLowerCase()}:${E}`);
    assert.match(f[0].message, /in 60 min.*RAISES resaleFeeBps 0 -> 100/);
    assert.deepEqual(kinds(checkPendingFees({ ...x, pending: { ...FEES, resaleFeeBps: 0, premiumFeeBps: 1 } })), ["v2_mon_fee_change_pending/warn"]);
  });
});

describe("v6: wiring events", () => {
  const ctx = { names: v6names, clearinghouse: V6.CH, settlementOracle: ORACLE, markets: v6markets, dataStreamsListed: [] };
  const one = (log, over = {}) => adminEventFindings([log], "100", { ...ctx, ...over });

  test("RouteSet: the registry pool warns; another pool, a market without pool, an unknown asset or a tier above 10000 page", () => {
    const route = (asset, pool, fee) => v6log("RouteSet", V6.ADAPTER, { asset, pool, fee });
    assert.deepEqual(kinds(one(route(U, V6.POOL, 500))), ["v2_mon_route_changed/warn"]);
    assert.match(one(route(U, V6.POOL, 500))[0].message, /payoutAdapter\.RouteSet\(NVDA, .*registry pool at fee tier 500 \(5 bps/);
    assert.deepEqual(kinds(one(route(U, UNI, 3000))), ["v2_mon_route_changed/error"]);
    assert.deepEqual(kinds(one(route(V6.TSLA, UNI, 3000))), ["v2_mon_route_changed/error"]);
    assert.deepEqual(kinds(one(route(V6.ADMIN, UNI, 3000))), ["v2_mon_route_changed/error"]);
    const tier = one(route(U, V6.POOL, 10_001));
    assert.deepEqual(kinds(tier), ["v2_mon_route_changed/error"]);
    assert.match(tier[0].message, /above 10000/);
    assert.deepEqual(kinds(one(route(U, V6.POOL, 10_000))), ["v2_mon_route_changed/warn"]);
    const cleared = one(route(U, "0x0000000000000000000000000000000000000000", 0));
    assert.deepEqual(kinds(cleared), ["v2_mon_route_changed/warn"]);
    assert.match(cleared[0].message, /paid in kind/);
  });

  test("OracleSet: anything but the published oracle allowed, or it removed, pages", () => {
    const set = (oracle, allowed) => v6log("OracleSet", CL, { oracle, allowed });
    assert.deepEqual(kinds(one(set(V6.ADMIN, true))), ["v2_mon_oracle_allowlist/error"]);
    assert.match(one(set(V6.ADMIN, true))[0].message, /ChainlinkFeedSource\.OracleSet.*pre-pin/);
    assert.deepEqual(kinds(one(set(ORACLE, false))), ["v2_mon_oracle_allowlist/error"]);
    assert.match(one(set(ORACLE, false))[0].message, /SourceNotPinned\(ChainlinkFeedSource, NotAuthorized\)/);
    assert.deepEqual(kinds(one(set(ORACLE, true))), ["v2_mon_oracle_allowlist/warn"]);
    assert.deepEqual(kinds(one(set(V6.ADMIN, false))), ["v2_mon_oracle_allowlist/warn"]);
  });

  test("ClearinghouseSet on the oracle: anything but the live Clearinghouse pages", () => {
    assert.deepEqual(kinds(one(v6log("ClearinghouseSet", ORACLE, { clearinghouse: V6.ADMIN }))), ["v2_mon_oracle_clearinghouse/error"]);
    assert.deepEqual(kinds(one(v6log("ClearinghouseSet", ORACLE, { clearinghouse: V6.CH }))), ["v2_mon_oracle_clearinghouse/warn"]);
    assert.deepEqual(kinds(one(v6log("ClearinghouseSet", CL, { clearinghouse: V6.ADMIN }))), ["v2_mon_oracle_clearinghouse/warn"]);
  });

  test("Data Streams FeedSet: pages while the source is listed anywhere or where is unknown", () => {
    const log = v6log("DataStreamsFeedSet", V6.DS, { underlying: U, feedId: `0x000b${"ab".repeat(30)}` });
    assert.deepEqual(kinds(one(log)), ["v2_mon_data_streams_feed/warn"]);
    const listed = one(log, { dataStreamsListed: ["NVDA market list"] });
    assert.deepEqual(kinds(listed), ["v2_mon_data_streams_feed/error"]);
    assert.match(listed[0].message, /listed \(NVDA market list\).*feedVersion/);
    assert.deepEqual(kinds(one(log, { dataStreamsListed: null })), ["v2_mon_data_streams_feed/error"]);
  });

  test("adopted history is silent; the generic table no longer carries the dedicated events; vetoes and resolutions page", () => {
    assert.deepEqual(adminEventFindings([v6log("OracleSet", CL, { oracle: V6.ADMIN, allowed: true }, { blockNumber: 100n })], "100", ctx), []);
    for (const name of DEDICATED_EVENTS) assert.equal(CONFIG_EVENTS[name], undefined, name);
    assert.equal(CONFIG_EVENTS.SettlementResolved, "error");
    assert.equal(CONFIG_EVENTS.SettlementVetoed, "warn");
    assert.equal(CONFIG_EVENTS.SettlementUnvetoed, "warn");
    const scan = emptyState(4663, "x").scan;
    const logs = [
      v6log("RouteSet", V6.ADAPTER, { asset: U, pool: V6.POOL, fee: 500 }),
      v6log("FeedSet", V6.DS, { underlying: U, feedId: `0x000b${"ab".repeat(30)}` }),
      v6log("FeedSet", CL, { underlying: U, feed: V6.FEED, maxStale: 93_600, maxRoundJumpBps: 2000 }),
      v6log("SettlementResolved", ORACLE, { underlying: U, expiry: E, price: 5n }),
      v6log("SpecialExpirySet", V6.CAL, { ts: E + 3600, allowed: true }),
    ];
    const out = applyScanLogs(scan, logs, v6addresses);
    assert.deepEqual(out.map((e) => e.eventName), ["RouteSet", "DataStreamsFeedSet", "FeedSet", "SettlementResolved", "SpecialExpirySet"]);
    assert.equal(scanEventName(logs[1]), "DataStreamsFeedSet");
    assert.deepEqual(scan.special, { [E + 3600]: 1 });
    assert.deepEqual(scan.finalized, { [`${U.toLowerCase()}:${E}`]: "500" });
    applyScanLogs(scan, [v6log("SpecialExpirySet", V6.CAL, { ts: E + 3600, allowed: false })], v6addresses);
    assert.deepEqual(scan.special, {});
    const generic = configEventFindings(out.filter((e) => !DEDICATED_EVENTS.has(e.eventName)), "100", v6names);
    assert.deepEqual(generic.map((f) => f.data.event), ["FeedSet", "SettlementResolved", "SpecialExpirySet"]);
    for (const name of ["OracleSet", "ClearinghouseSet", "SettlementConfigPinned", "FeedPinned", "PoolPinned", "MarketConfigured"]) assert.ok(PINS_DIRTY_EVENTS.has(name));
  });
});

describe("v6: pins made outside a series creation", () => {
  const ctx = { names: v6names, clearinghouse: V6.CH, settlementOracle: ORACLE, markets: v6markets };
  const tx = (n) => `0x${String(9000 + n).padStart(64, "0")}`;
  const series = (n, underlying = U, expiry = E) => v6log("SeriesCreated", V6.CH, { longId: 7n, underlying, expiry, isPut: false, strike: 5n, oracle: ORACLE }, { transactionHash: tx(n), logIndex: 9 });
  const oraclePin = (n, underlying = U, expiry = E) => v6log("SettlementConfigPinned", ORACLE, { underlying, expiry, sources: [CL, UNI], maxDeviationBps: 150, uncorroboratedDelay: 21_600 }, { transactionHash: tx(n), logIndex: 1 });
  const feedPin = (n, underlying = U, expiry = E) => v6log("FeedPinned", CL, { underlying, expiry, feed: V6.FEED, maxStale: 93_600, maxRoundJumpBps: 2000 }, { transactionHash: tx(n), logIndex: 2 });
  const poolPin = (n, underlying = U, expiry = E) => v6log("PoolPinned", UNI, { underlying, expiry, pool: V6.POOL, minLiquidity: 5n }, { transactionHash: tx(n), logIndex: 3 });

  test("a first series pins everything in its own transaction: nothing pages", () => {
    assert.deepEqual(prePinFindings([oraclePin(1), feedPin(1), poolPin(1), series(1)], "100", ctx), []);
    assert.deepEqual(prePinFindings([series(2)], "100", ctx), [], "a later series of the expiry logs no pin");
  });

  test("an oracle pin without its SeriesCreated pages once (its source pins ride along)", () => {
    const f = prePinFindings([oraclePin(3), feedPin(3), poolPin(3)], "100", ctx);
    assert.deepEqual(kinds(f), ["v2_mon_pre_pin/error"]);
    assert.equal(f[0].event, true);
    assert.equal(f[0].key, `${tx(3)}:1`);
    assert.match(f[0].message, /NVDA expiry 2026-09-17T20:00:00Z: settlementOracle\.SettlementConfigPinned\(sources \[ChainlinkFeedSource, UniV3TwapSource\].*moved clearinghouse pointer/);
    const other = prePinFindings([oraclePin(4, U, E + 86_400), series(4)], "100", ctx);
    assert.deepEqual(kinds(other), ["v2_mon_pre_pin/error"], "a SeriesCreated of another expiry does not cover it");
  });

  test("a source pin through the allow-list pages; history before the first run does not", () => {
    const f = prePinFindings([feedPin(5, V6.TSLA)], "100", ctx);
    assert.deepEqual(kinds(f), ["v2_mon_pre_pin/error"]);
    assert.match(f[0].message, /TSLA expiry .*ChainlinkFeedSource\.FeedPinned\(feed .*allow-list/);
    const ds = v6log("DataStreamsFeedPinned", V6.DS, { underlying: U, expiry: E, feedId: `0x000b${"ab".repeat(30)}`, version: 2n }, { transactionHash: tx(6) });
    assert.match(prePinFindings([ds], "100", ctx)[0].message, /DataStreamsSource\.FeedPinned\(feedId 0x000b.*version 2\)/);
    assert.deepEqual(prePinFindings([feedPin(7, V6.TSLA, E)].map((l) => ({ ...l, blockNumber: 99n })), "100", ctx), []);
  });

  test("applyScanLogs remembers source pins and hands the pin logs over", () => {
    const scan = emptyState(4663, "x").scan;
    const sink = [];
    const logs = [oraclePin(8), feedPin(8), poolPin(8), series(8), feedPin(9, V6.TSLA, E + 1), { ...poolPin(9), address: V6.ADMIN }];
    applyScanLogs(scan, logs, v6addresses, sink);
    assert.deepEqual(scan.sourcePins, { [`${U.toLowerCase()}:${E}`]: 1, [`${V6.TSLA.toLowerCase()}:${E + 1}`]: 1 });
    assert.deepEqual(sink.map((l) => l.eventName), ["SettlementConfigPinned", "FeedPinned", "PoolPinned", "SeriesCreated", "FeedPinned"]);
    assert.equal(Object.keys(scan.series).length, 1);
  });
});

describe("v6: pins check", () => {
  test("the calendar's closes: 20:00 UTC in EDT, 21:00 UTC in EST, switching on the DST Sundays", () => {
    assert.equal(closeOfDay(Math.floor(E / 86_400)), E); // Thursday 2026-09-17, EDT
    assert.equal(closeOfDay(Date.UTC(2027, 0, 15) / 86_400_000), Date.UTC(2027, 0, 15, 21) / 1000);
    assert.equal(closeOfDay(Date.UTC(2026, 2, 6) / 86_400_000), Date.UTC(2026, 2, 6, 21) / 1000); // Friday before the switch
    assert.equal(closeOfDay(Date.UTC(2026, 2, 8) / 86_400_000), Date.UTC(2026, 2, 8, 20) / 1000); // second Sunday of March
    assert.equal(closeOfDay(Date.UTC(2026, 10, 1) / 86_400_000), Date.UTC(2026, 10, 1, 21) / 1000); // first Sunday of November
    assert.equal(closeOfDay(Date.UTC(2026, 9, 30) / 86_400_000), Date.UTC(2026, 9, 30, 20) / 1000);
  });

  test("creatable grid: weekday closes inside [now + 1 h, now + 45 d]", () => {
    const now = E - 3600; // exactly one hour before a close: it is creatable
    const g = gridCloses(now);
    assert.equal(g[0], E);
    assert.ok(g.every((ts) => ts >= now + MIN_SERIES_LEAD && ts <= now + MAX_TENOR));
    assert.ok(g.every((ts) => (Math.floor(ts / 86_400) + 3) % 7 < 5));
    assert.equal(gridCloses(now + 1)[0], E + 86_400);
    assert.ok(g.length >= 31 && g.length <= 33, `${g.length} closes`);
  });

  test("simulation targets: one for every expiry nobody pinned, one each for the rest, none for the Clearinghouse's", () => {
    const es = [E, E + 86_400, E + 2 * 86_400, E + 3 * 86_400, E + 4 * 86_400];
    const by = new Map([
      [E, V6.CH],
      [E + 2 * 86_400, V6.ADMIN],
    ]);
    const src = new Set([E + 3 * 86_400]);
    assert.deepEqual(pinTargets(es, by, src, V6.CH), { representative: E + 86_400, individual: [E + 2 * 86_400, E + 3 * 86_400] });
    assert.deepEqual(pinTargets([E], new Map([[E, V6.CH]]), new Set(), V6.CH), { representative: null, individual: [] });
  });

  test("pin reverts decode, including SourceNotPinned's source and reason", () => {
    assert.deepEqual(decodePinRevert("0xea8e4eb5"), { name: "NotAuthorized", selector: "0xea8e4eb5", source: null, reason: null, reasonSelector: null });
    const raw = `0xf54720df${CL.slice(2).toLowerCase().padStart(64, "0")}52e8e6d6${"0".repeat(56)}`;
    assert.deepEqual(decodePinRevert(raw), { name: "SourceNotPinned", selector: "0xf54720df", source: CL.toLowerCase(), reason: "PinMismatch", reasonSelector: "0x52e8e6d6" });
    assert.equal(decodePinRevert("0x12345678").name, null);
    assert.equal(decodePinRevert(null).selector, null);
    const f = checkPinSimulation({ ticker: "NVDA", underlying: U, oracle: ORACLE, expiry: E, representative: false, ok: false, revert: decodePinRevert(raw), names: v6names });
    assert.deepEqual(kinds(f), ["v2_mon_pin_blocked/error"]);
    assert.equal(f[0].key, `${U.toLowerCase()}:${E}`);
    assert.match(f[0].message, /SourceNotPinned\(ChainlinkFeedSource, PinMismatch\): ChainlinkFeedSource holds a pin of the expiry/);
    const rep = checkPinSimulation({ ticker: "NVDA", underlying: U, oracle: ORACLE, expiry: E, representative: true, ok: false, revert: decodePinRevert("0xea8e4eb5"), names: v6names });
    assert.equal(rep[0].key, `${U.toLowerCase()}:unpinned`);
    assert.match(rep[0].message, /any expiry nobody has pinned yet.*NotAuthorized/);
    const noData = `0xf54720df${CL.slice(2).toLowerCase().padStart(64, "0")}${"0".repeat(64)}`;
    assert.match(checkPinSimulation({ ...{ ticker: "NVDA", underlying: U, oracle: ORACLE, expiry: E, representative: true, names: v6names }, ok: false, revert: decodePinRevert(noData) })[0].message, /0x00000000.*no code/);
    assert.deepEqual(checkPinSimulation({ ticker: "NVDA", underlying: U, oracle: ORACLE, expiry: E, representative: true, ok: true, revert: null, names: v6names }), []);
  });

  test("pinnedBy must be zero or the Clearinghouse", () => {
    const x = { ticker: "NVDA", underlying: U, oracle: ORACLE, expiry: E, clearinghouse: V6.CH, hasSeries: false };
    assert.deepEqual(checkPinnedBy({ ...x, pinnedBy: "0x0000000000000000000000000000000000000000" }), []);
    assert.deepEqual(checkPinnedBy({ ...x, pinnedBy: V6.CH.toLowerCase() }), []);
    const pre = checkPinnedBy({ ...x, pinnedBy: V6.ADMIN });
    assert.deepEqual(kinds(pre), ["v2_mon_pinned_by/error"]);
    assert.match(pre[0].message, /no series: a pin made outside a series creation/);
    assert.match(checkPinnedBy({ ...x, pinnedBy: V6.ADMIN, hasSeries: true })[0].message, /has series: someone pointed the oracle's clearinghouse elsewhere/);
  });

  test("the published configuration: registry defaults, a market's overrides, a pool or none", () => {
    const nvda = expectedPinnedConfig(v6reg, v6markets[0]);
    assert.deepEqual(nvda, { sources: [CL, UNI], maxDeviationBps: 150, uncorroboratedDelay: 21_600, spotMaxAge: 90_000, feed: V6.FEED, maxStale: 93_600, maxRoundJumpBps: 2000, pool: V6.POOL, minLiquidity: 1_700_000_000_000_000_000n, window: 300 });
    const tsla = expectedPinnedConfig(v6reg, v6markets[1]);
    assert.deepEqual([tsla.sources, tsla.uncorroboratedDelay, tsla.pool], [[CL], 3600, null]);
    const reg = parseRegistry(JSON.parse(readFileSync(DEFAULT_REGISTRY, "utf8")), DEFAULT_REGISTRY);
    assert.deepEqual(reg.defaults, { maxDeviationBps: 150, uncorroboratedDelayS: 21_600, spotMaxAgeS: 90_000 });
    assert.deepEqual(parseRegistry({ markets: [] }).defaults, { maxDeviationBps: 150, uncorroboratedDelayS: 21_600, spotMaxAgeS: 90_000 });
    assert.ok(reg.markets.every((m) => m.feedHeartbeatS === 86_400), "every registry feed has the 24 h heartbeat");
    assert.throws(() => parseRegistry({ v2: { defaults: { maxDeviationBps: "x" } }, markets: [] }), /not a non-negative integer/);
  });

  test("an expiry with series against the registry: every difference named, verified only when it all matches", () => {
    const good = {
      ticker: "NVDA",
      underlying: U,
      expiry: E,
      oracle: ORACLE,
      publishedOracle: ORACLE,
      expected: expectedPinnedConfig(v6reg, v6markets[0]),
      sources: v6reg.sources,
      names: v6names,
      config: { pinned: true, sources: [CL, UNI], maxDeviationBps: 150, uncorroboratedDelay: 21_600, spotMaxAge: 90_000 },
      chainlink: { feed: V6.FEED, maxStale: 93_600, maxRoundJumpBps: 2000, pinned: true },
      univ3: { pool: V6.POOL, window: 300, pinned: true, minLiquidity: 1_700_000_000_000_000_000n },
      dataStreams: { pinned: false, version: 0n, currentVersion: 1n },
    };
    assert.deepEqual(checkPinnedConfig(good), { findings: [], verified: true });
    const bad = checkPinnedConfig({
      ...good,
      config: { ...good.config, maxDeviationBps: 200, uncorroboratedDelay: 1800 },
      chainlink: { ...good.chainlink, feed: CL, maxStale: 3600 },
      univ3: { ...good.univ3, minLiquidity: 0n },
    });
    assert.equal(bad.verified, false);
    assert.deepEqual(kinds(bad.findings), ["v2_mon_pin_mismatch/error"]);
    assert.equal(bad.findings[0].key, `${U.toLowerCase()}:${E}`);
    assert.deepEqual(bad.findings[0].data.differences, [
      "maxDeviationBps 200 instead of 150",
      "uncorroboratedDelay 1800 instead of 21600",
      `Chainlink feed ${CL} instead of ${V6.FEED}`,
      "Chainlink maxStale 3600 s instead of 93600",
      "pool floor 0 instead of 1700000000000000000",
    ]);
    assert.match(checkPinnedConfig({ ...good, config: { ...good.config, sources: [CL, V6.ADMIN] } }).findings[0].message, /sources \[ChainlinkFeedSource, 0xEb82.*\] instead of \[ChainlinkFeedSource, UniV3TwapSource\]/);
    // A market registered before §15.13 pinned the 1 h spot age: its expiries no longer match the registry.
    assert.deepEqual(checkPinnedConfig({ ...good, config: { ...good.config, spotMaxAge: 3600 } }).findings[0].data.differences, ["spotMaxAge 3600 instead of 90000"]);
    assert.match(checkPinnedConfig({ ...good, chainlink: { ...good.chainlink, pinned: false } }).findings[0].message, /ChainlinkFeedSource holds no pin/);
    assert.match(checkPinnedConfig({ ...good, config: { pinned: false, sources: [] } }).findings[0].message, /NOT pinned/);
    const foreign = checkPinnedConfig({ ...good, oracle: V6.ADMIN, config: { pinned: false, sources: [] } });
    assert.deepEqual(foreign.findings[0].data.differences.length, 1);
    assert.match(foreign.findings[0].message, /not the published SettlementOracle/);
    // A listed Data Streams source is never "verified": its feed version can still move.
    const withDs = { ...good, config: { ...good.config, sources: [CL, UNI, V6.DS] }, expected: { ...good.expected, sources: [CL, UNI, V6.DS] } };
    assert.deepEqual(checkPinnedConfig({ ...withDs, dataStreams: { pinned: true, version: 2n, currentVersion: 2n } }), { findings: [], verified: false });
    assert.match(checkPinnedConfig({ ...withDs, dataStreams: { pinned: true, version: 2n, currentVersion: 3n } }).findings[0].message, /feedVersion 2 -> 3/);
    assert.deepEqual(checkPinnedConfig({ ...good, expected: null }).findings[0].data.differences.length >= 1, true);
  });

  test("a market row pointing new series at another oracle", () => {
    assert.deepEqual(checkMarketOracle({ ticker: "NVDA", underlying: U, oracle: ORACLE.toLowerCase(), publishedOracle: ORACLE }), []);
    const f = checkMarketOracle({ ticker: "NVDA", underlying: U, oracle: V6.ADMIN, publishedOracle: ORACLE });
    assert.deepEqual(kinds(f), ["v2_mon_pin_mismatch/error"]);
    assert.equal(f[0].key, `${U.toLowerCase()}:market-oracle`);
  });

  test("helpers: revert data from a cause chain, bounded concurrency in order", async () => {
    assert.equal(revertDataOf({ cause: { cause: { data: "0xea8e4eb5" } } }), "0xea8e4eb5");
    assert.equal(revertDataOf({ data: { data: "0x52e8e6d6" } }), "0x52e8e6d6");
    assert.equal(revertDataOf(new Error("HTTP 429")), undefined);
    let running = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (x) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, x));
      running -= 1;
      return x * 10;
    });
    assert.deepEqual(out, [50, 10, 40, 20, 30]);
    assert.equal(peak, 2);
  });

  test("the scanned v6 events carry the topics the contracts emit", () => {
    const viem = loadViem();
    const topic = (sig) => viem.toEventSelector(sig);
    const src = readFileSync(new URL("./monitor.mjs", import.meta.url), "utf8");
    const expected = {
      "FeeParamsScheduled((uint16 premiumFeeBps, uint16 resaleFeeBps, uint32 takerFeeFlat, uint16 takerFeeCapBps, uint16 makerRebateBps) params, uint40 effectiveAt)": "0x06b4ad3a314cd5daa77af21ed07d493ede4c33c94bb41712a2795c3aa9189f54",
      "SettlementConfigPinned(address indexed underlying, uint40 indexed expiry, address[] sources, uint16 maxDeviationBps, uint32 uncorroboratedDelay)": "0x0f5665a813c1eb146df6e986b55707c10b6a66f14f3e23a39ca428cee92808eb",
      "FeedPinned(address indexed underlying, uint40 indexed expiry, address feed, uint32 maxStale, uint16 maxRoundJumpBps)": "0x69629c675489e2a1dd8502ac55b3def842ef6395a83ffd2042b3d210d767a769",
      "OracleSet(address indexed oracle, bool allowed)": "0x52934308d2c8dc32de080d8be177ae8a48054436e2f01112e0a04d9a639f1aaa",
      "PoolPinned(address indexed underlying, uint40 indexed expiry, address pool, uint128 minLiquidity)": "0x96acc5b460b0f3738646a4d5e9e2f2be261fcb5350f4df9760e4bfd6ed607f53",
      "FeedPinned(address indexed underlying, uint40 indexed expiry, bytes32 feedId, uint64 version)": "0x24b36cb7f9f181d025106d98bd41f8ae949eb632b6e1be39e8e407a6f8bb3059",
    };
    for (const [sig, t0] of Object.entries(expected)) {
      assert.ok(src.includes(`"event ${sig}"`), `SCAN_EVENTS has ${sig}`);
      assert.equal(topic(`event ${sig}`), t0, sig);
    }
    for (const [sel, name] of Object.entries({ "0xea8e4eb5": "NotAuthorized()", "0x7d19c0ff": "NoSource()", "0x52e8e6d6": "PinMismatch()", "0xf54720df": "SourceNotPinned(address,bytes4)" })) {
      assert.equal(viem.toFunctionSelector(name), sel);
    }
  });
});

/* ---------------------------------------------------------------------------------------------- */
/*  INTERFACE_VERSION 7 (c05 rent, c16 stale asks, c21 outflow cap)                                 */
/* ---------------------------------------------------------------------------------------------- */

const ABIS = path.join(fileURLToPath(new URL("../..", import.meta.url)), "ops", "abis", "v2");
const abiJson = (name) => JSON.parse(readFileSync(path.join(ABIS, `${name}.json`), "utf8"));
/** The canonical type list of an ABI item's inputs or outputs: tuples flattened the way a signature writes them. */
const typeOf = (i) => (i.type.startsWith("tuple") ? `(${(i.components ?? []).map(typeOf).join(",")})${i.type.slice(5)}` : i.type);
const typesOf = (items) => (items ?? []).map(typeOf).join(",");
const sigOf = (e) => `${e.name}(${typesOf(e.inputs)})`;

describe("v7 + v8: the hand-written ABIs match the exported ones", () => {
  const viem = loadViem();
  // Which compiled ABI each hand-written view list belongs to. The rest are listed in THEIRS below.
  const OURS = {
    clearinghouse: "Clearinghouse",
    clearinghouseConfig: "Clearinghouse",
    oracle: "SettlementOracle",
    univ3: "UniV3TwapSource",
    chainlinkSource: "ChainlinkFeedSource",
    dataStreamsSource: "DataStreamsSource",
    calendar: "ExpiryCalendar",
    orderBook: "OrderBook",
    keeperRewards: "KeeperRewards",
    autoRoller: "AutoRoller",
    makerVault: "MakerVault",
    // INTERFACE_VERSION 8.
    accessManager: "AccessManager",
    payoutRouter: "IPayoutRouter",
    payoutAdapter: "UniV3PayoutAdapter",
    feeSplitter: "IFeeSplitter",
  };
  // Third-party contracts with no artifact of ours: ERC-20, USDG, the Stock Token and its registry, the Chainlink
  // proxy, the Safe, a raw pool.
  const THEIRS = ["erc20", "usdg", "stockToken", "stockRegistry", "feed", "safe", "pool"];

  // The guard on the guard. The loop below only checks the keys OURS names, so ADDING a view list to ABI_TEXT and
  // forgetting to name it here checks nothing at all and the suite stays green — the permissive direction. This
  // fails the moment a key belongs to neither list.
  test("every hand-written view list is either checked against an artifact or declared third-party", () => {
    const declared = new Set([...Object.keys(OURS), ...THEIRS]);
    const undeclared = Object.keys(ABI_TEXT).filter((k) => !declared.has(k));
    assert.deepEqual(undeclared, [], "ABI_TEXT keys checked by nothing");
  });

  // The point of the whole suite: monitor.mjs decodes series(), market() and limits() POSITIONALLY from these
  // strings. v7 appended a field to each of the three, and a monitor left on the v6 tuples reads the new returns
  // without failing — it just reads them wrong, so its alerts go quiet instead of firing.
  for (const [key, artifact] of Object.entries(OURS)) {
    test(`${key} views equal ${artifact}.json`, () => {
      const compiled = abiJson(artifact);
      for (const item of viem.parseAbi(ABI_TEXT[key])) {
        if (item.type !== "function") continue;
        const real = compiled.find((e) => e.type === "function" && e.name === item.name);
        assert.ok(real !== undefined, `${artifact} has no ${item.name}()`);
        assert.equal(typesOf(item.inputs), typesOf(real.inputs), `${key}.${item.name} arguments`);
        assert.equal(typesOf(item.outputs), typesOf(real.outputs), `${key}.${item.name} returns`);
      }
    });
  }

  test("every scanned event signature is one a v2 contract emits", () => {
    const emitted = new Set();
    for (const name of Object.values(OURS).concat(["UniV3PayoutAdapter", "RewardsDistributor", "MakerRegistry", "IBuybackExecutor"])) {
      for (const e of abiJson(name)) if (e.type === "event") emitted.add(sigOf(e));
    }
    for (const item of viem.parseAbi(SCAN_EVENTS)) {
      assert.ok(emitted.has(sigOf(item)), `no v2 contract emits ${sigOf(item)}`);
    }
  });

  // THE ONE THAT CANNOT BE FELT. IPayoutRouter.routes and UniV3PayoutAdapter.routes are the SAME selector with
  // different returns, so decoding the router's answer with the adapter's list succeeds and reads the venue enum
  // as an address. Pinned here from the exports, both halves: the selectors must be equal AND the returns must
  // not be — if a later change made the tuples agree this test would be pointless and would say so.
  test("v8: routes(address) is one selector with two different return tuples", () => {
    const routerRoutes = abiJson("IPayoutRouter").find((e) => e.type === "function" && e.name === "routes");
    const adapterRoutes = abiJson("UniV3PayoutAdapter").find((e) => e.type === "function" && e.name === "routes");
    assert.ok(routerRoutes && adapterRoutes, "both artifacts must declare routes()");
    const sel = (e) => viem.toFunctionSelector(`function ${sigOf(e)}`);
    assert.equal(sel(routerRoutes), "0xd7409659", "IPayoutRouter.routes selector");
    assert.equal(sel(adapterRoutes), "0xd7409659", "UniV3PayoutAdapter.routes selector");
    assert.notEqual(typesOf(routerRoutes.outputs), typesOf(adapterRoutes.outputs), "the collision is only dangerous while the tuples differ");
    assert.equal(typesOf(routerRoutes.outputs), "(uint8,uint24,int24,address,uint16)");
    assert.equal(typesOf(adapterRoutes.outputs), "address,uint24");
    // And the monitor's two hand-written lists must be the two shapes, not two copies of one.
    const hand = (key) => typesOf(viem.parseAbi(ABI_TEXT[key]).find((i) => i.type === "function" && i.name === "routes").outputs);
    assert.equal(hand("payoutRouter"), typesOf(routerRoutes.outputs));
    assert.equal(hand("payoutAdapter"), typesOf(adapterRoutes.outputs));
  });

  test("v8: the manager, router and splitter topics match the pinned contract events", () => {
    const topic = (sig) => viem.toEventSelector(sig);
    const src = readFileSync(new URL("./monitor.mjs", import.meta.url), "utf8");
    const expected = {
      "OperationScheduled(bytes32 indexed operationId, uint32 indexed nonce, uint48 schedule, address caller, address target, bytes data)":
        "0x82a2da5dee54ea8021c6545b4444620291e07ee83be6dd57edb175062715f3b4",
      "OperationExecuted(bytes32 indexed operationId, uint32 indexed nonce)": "0x76a2a46953689d4861a5d3f6ed883ad7e6af674a21f8e162707159fc9dde614d",
      "OperationCanceled(bytes32 indexed operationId, uint32 indexed nonce)": "0xbd9ac67a6e2f6463b80927326310338bcbb4bdb7936ce1365ea3e01067e7b9f7",
      "RoleGranted(uint64 indexed roleId, address indexed account, uint32 delay, uint48 since, bool newMember)":
        "0xf98448b987f1428e0e230e1f3c6e2ce15b5693eaf31827fbd0b1ec4b424ae7cf",
      "RoleRevoked(uint64 indexed roleId, address indexed account)": "0xf229baa593af28c41b1d16b748cd7688f0c83aaf92d4be41c44005defe84c166",
      "RoleAdminChanged(uint64 indexed roleId, uint64 indexed admin)": "0x1fd6dd7631312dfac2205b52913f99de03b4d7e381d5d27d3dbfe0713e6e6340",
      "RoleGuardianChanged(uint64 indexed roleId, uint64 indexed guardian)": "0x7a8059630b897b5de4c08ade69f8b90c3ead1f8596d62d10b6c4d14a0afb4ae2",
      "RoleGrantDelayChanged(uint64 indexed roleId, uint32 delay, uint48 since)": "0xfeb69018ee8b8fd50ea86348f1267d07673379f72cffdeccec63853ee8ce8b48",
      "TargetFunctionRoleUpdated(address indexed target, bytes4 selector, uint64 indexed roleId)":
        "0x9ea6790c7dadfd01c9f8b9762b3682607af2c7e79e05a9f9fdf5580dde949151",
      "TargetAdminDelayUpdated(address indexed target, uint32 delay, uint48 since)": "0xa56b76017453f399ec2327ba00375dbfb1fd070ff854341ad6191e6a2e2de19c",
      "TargetClosed(address indexed target, bool closed)": "0x90d4e7bb7e5d933792b3562e1741306f8be94837e1348dacef9b6f1df56eb138",
      "RouteSet(address indexed asset, uint8 venue, bytes32 poolId, uint24 fee, uint16 feeBps)": "0xadc0c7d7edaf45c70c9c1135c172efd179926c663b67dca1e2b568c73670d447",
      "RouteCleared(address indexed asset)": "0xf13e05d9cb53ed68362bc7ee84fb0c6c651d6493c29a2a2847c4926aeed3258b",
      "Distributed(address indexed asset, uint256 assetIn, uint256 usdgIn, uint256 treasuryOut, uint256 buybackAdded)":
        "0xac34a64bfd07da55a58f5cdd4ef06f701da1d29b4164e748c52efa857fa4810a",
      "DistributionSkipped(address indexed asset, bytes32 reason)": "0x909c9a749e25b695e78c231c84211fe590416c4ad5904132283c15b2d911f10c",
      "BoughtBack(uint256 usdgIn, uint256 tokenOut)": "0x15b90a6a755d5ed0f929f1f40375d58183388d8d9e2f8e9a2efa93043e70f6de",
      "Burned(uint256 amount)": "0xd83c63197e8e676d80ab0122beba9a9d20f3828839e9a1d6fe81d242e9cd7e6e",
      "MinterSet(address indexed minter, bool allowed)": "0x583b0aa0e528532caf4b907c11d7a8158a122fe2a6fb80cd9b09776ebea8d92d",
      "DefaultMarketFeesSet(uint16 exerciseFeeBps, uint32 mintFeePpm)": "0xa20eb2fd8695b7b27879d7fb19174625c3f42b8167d57c41bebeb8795f98bba3",
      "DiscountModuleSet(address indexed module)": "0x43fab025147db74d6b090f20292d9d2228109b30e23de9f14d9b53c473093b52",
      "TreasurySet(address indexed treasury)": "0x3c864541ef71378c6229510ed90f376565ee42d9c5e0904a984a9e863e6db44f",
      "FeesSwept(address indexed asset, address indexed to, uint256 amount)": "0x244e51bc38c1452fa8aaf487bcb4bca36c2baa3a5fbdb776b1eabd8dc6d277cd",
    };
    for (const [sig, t0] of Object.entries(expected)) {
      assert.ok(src.includes(`"event ${sig}"`), `SCAN_EVENTS has ${sig}`);
      assert.equal(topic(`event ${sig}`), t0, sig);
    }
    // AccessControl's RoleGranted and the manager's share a NAME and nothing else. If these ever matched, every
    // manager role change would be read as a bytes32 role hash and named after the wrong role.
    assert.notEqual(
      topic("event RoleGranted(uint64 indexed roleId, address indexed account, uint32 delay, uint48 since, bool newMember)"),
      topic("event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)"),
    );
  });

  test("the v7 topics and the CANCEL_STALE action match the pinned contract events", () => {
    const topic = (sig) => viem.toEventSelector(sig);
    const src = readFileSync(new URL("./monitor.mjs", import.meta.url), "utf8");
    const expected = {
      "SeriesCreated(uint256 indexed longId, address indexed underlying, bool isPut, uint128 strike, uint40 expiry, address oracle, uint16 exerciseFeeBps, uint32 mintFeePpm)":
        "0xed90937236a5c12f4e39a0ccb003b3b4d84470457df12240e681b3b525e10515",
      "Minted(uint256 indexed longId, address indexed writer, address indexed longTo, uint64 units, uint256 collateral, uint256 fee)":
        "0x89b7f2e14bc7bca4f2fd443683827b62e46c6f22ac4145d38f930082a62fcab5",
      "Closed(uint256 indexed longId, address indexed account, uint64 units, uint256 collateralFreed, uint256 feeRefund)":
        "0x895110f6bb596a7019986496b866a4cebf45e0d53ff8946c952974d456540381",
      "MintFeesAccrued(uint256 indexed longId, address indexed asset, uint256 amount)": "0x7370e99169ee22a18273e3ff9c18124c7a0019b6f23db1f73cb86777d2b245fb",
      "StaleAskCancelled(address indexed writer, address indexed underlying, uint256 longId, uint256 orderId, uint256 spot, uint256 updatedAt)":
        "0xcebe2d1e4742352b05b507fd5e0c0df36f9521884bd871d344cb9969b15ff942",
      "LimitsSet((uint64 maxSeriesUnits, uint128 maxTotalNotional, uint16 askToleranceBps, uint16 maxBidBpsOfSpot, uint32 maxOrderLifetime, uint128 maxDailyOutflow) limits)":
        "0x7a591068b05ad6b1421ee8724ea1c282ebc7abaf323518b0cfd55b97d6fb8d98",
      "MarketRegistered(address indexed underlying, (bool enabled, bool mintPaused, uint64 strikeTick, uint16 exerciseFeeBps, address oracle, uint32 mintFeePpm) config)":
        "0x9ffefa3e10b786e4dc202bedcdb98708c0feff476372922f9343e2f0c6010100",
      "MarketConfigSet(address indexed underlying, (bool enabled, bool mintPaused, uint64 strikeTick, uint16 exerciseFeeBps, address oracle, uint32 mintFeePpm) config)":
        "0x52cc1e23344c6f013d28b8fb05397e8f657e760f6610261c48d84c70161ca366",
    };
    for (const [sig, t0] of Object.entries(expected)) {
      assert.ok(src.includes(`"event ${sig}"`), `SCAN_EVENTS has ${sig}`);
      assert.equal(topic(`event ${sig}`), t0, sig);
    }
    assert.equal(ACTIONS.CANCEL_STALE, viem.keccak256(viem.toHex("CANCEL_STALE")));
    assert.equal(ACTIONS.CANCEL_STALE, "0x7bf1982cc047ace888325e61ec5f1e6f173a1d0d7f3d38fc1a42c4776bd35d2b");
  });
});

describe("v7: the MakerVault outflow cap (c21)", () => {
  const V = "0x00000000000000000000000000000000000000c8";
  const cap = 2_500_000_000n;
  const at = (used) => checkVaultOutflow({ address: V, limits: { maxDailyOutflow: cap }, outflow: { used, available: cap - used } }, t);

  test("quiet below half the cap; warn at half; error at 90 %", () => {
    assert.deepEqual(at(0n), []);
    assert.deepEqual(kinds(at(cap / 2n - 1n)), []);
    assert.deepEqual(kinds(at(cap / 2n)), ["v2_mon_vault_outflow/warn"]);
    assert.deepEqual(kinds(at((cap * 89n) / 100n)), ["v2_mon_vault_outflow/warn"]);
    assert.deepEqual(kinds(at((cap * 90n) / 100n)), ["v2_mon_vault_outflow/error"]);
    // One key, so a bucket that fills escalates the open alert instead of opening a second one.
    assert.equal(at(cap / 2n)[0].key, at(cap)[0].key);
    assert.match(at(cap)[0].message, /revoke QUOTER_ROLE/);
  });

  test("a cap of 0 is the spend freeze, and says so", () => {
    const f = checkVaultOutflow({ address: V, limits: { maxDailyOutflow: 0n }, outflow: { used: 0n, available: 0n } }, t);
    assert.deepEqual(kinds(f), ["v2_mon_vault_outflow/warn"]);
    assert.match(f[0].message, /all SIX fields/);
    assert.notEqual(f[0].key, at(cap)[0].key, "the freeze is its own condition, not a full bucket");
  });

  test("a vault whose outflow() was not read is not judged, and checkVault carries the finding", () => {
    assert.deepEqual(checkVaultOutflow({ address: V, limits: { maxDailyOutflow: cap }, outflow: null }, t), []);
    const base = { address: V, limits: { maxSeriesUnits: 10n ** 9n, maxTotalNotional: 10n ** 15n, maxDailyOutflow: cap }, totalNotional: 0n, series: [], usdgAvailable: 10n ** 12n, tokens: [] };
    assert.deepEqual(kinds(checkVault({ ...base, outflow: { used: cap, available: 0n } }, t)), ["v2_mon_vault_outflow/error"]);
    assert.deepEqual(kinds(checkVault({ ...base, outflow: { used: 0n, available: cap } }, t)), []);
  });

  test("the bounty model pays at most one CANCEL_STALE per ROLL", () => {
    const bounties = { SNAPSHOT: 0n, FINALIZE: 0n, SETTLE: 0n, REDEEM: 0n, ROLL: 50_000n, CANCEL_STALE: 20_000n };
    assert.equal(modelSpendPerExpiry(bounties, { ...t, modelRollsPerExpiry: 0 }), 0n);
    assert.equal(modelSpendPerExpiry(bounties, { ...t, modelRollsPerExpiry: 4 }), 280_000n);
  });
});

describe("v7: an AutoRoller ask the market overtook (c16)", () => {
  const W = "0x000000000000000000000000000000000000000f";
  const ask = (over = {}) => ({
    autoRoller: C.autoRoller,
    writer: W,
    underlying: U,
    ticker: "NVDA",
    longId: 42n,
    orderId: 7n,
    isPut: false,
    strike: 200_000_000n,
    expiry: 1_790_500_000,
    remaining: 500n,
    spotOk: true,
    spot: 210_000_000n,
    spotUpdatedAt: 1_790_000_000,
    delegate: true,
    since: null,
    now: 1_790_000_000,
    ...over,
  });

  test("out of the money, or without an ok spot, is not stale", () => {
    assert.deepEqual(checkRollerAsk(ask({ spot: 199_999_999n }), t), { findings: [], stale: false });
    assert.deepEqual(checkRollerAsk(ask({ spotOk: false, spot: 0n }), t), { findings: [], stale: false }, "cancelStale needs a fresh spot too");
  });

  test("exactly at the strike starts the clock, and only rollerStaleS later does it page", () => {
    const first = checkRollerAsk(ask({ spot: 200_000_000n }), t);
    assert.equal(first.stale, true);
    assert.deepEqual(first.findings, [], "one pass is not evidence: a print can cross between cranker ticks");
    assert.equal(first.since, 1_790_000_000);
    const soon = checkRollerAsk(ask({ since: 1_790_000_000, now: 1_790_000_059 }), t);
    assert.deepEqual(soon.findings, []);
    const late = checkRollerAsk(ask({ since: 1_790_000_000, now: 1_790_000_060 }), t);
    assert.deepEqual(kinds(late.findings), ["v2_mon_roller_ask_overtaken/error"]);
    assert.match(late.findings[0].message, /cancelStale\(writer, underlying\) is permissionless/);
    assert.equal(late.findings[0].data.sinceS, 60);
  });

  test("a put is overtaken from the other side", () => {
    const put = { isPut: true, strike: 200_000_000n, since: 1_789_999_000 };
    assert.deepEqual(checkRollerAsk(ask({ ...put, spot: 200_000_001n }), t).findings, []);
    assert.deepEqual(kinds(checkRollerAsk(ask({ ...put, spot: 200_000_000n }), t).findings), ["v2_mon_roller_ask_overtaken/error"]);
  });

  test("a revoked delegate is the writer's own problem: warn, and say nobody else can cancel it", () => {
    const f = checkRollerAsk(ask({ since: 1_789_999_000, delegate: false }), t).findings;
    assert.deepEqual(kinds(f), ["v2_mon_roller_ask_overtaken/warn"]);
    assert.match(f[0].message, /reverts NotAuthorized/);
  });
});

describe("v7: writer rent (c05)", () => {
  const led = (over = {}) => ({
    longId: "84",
    label: "NVDA call 200.00 2026-10-02T20:00:00Z",
    ppm: 80,
    marketPpm: 80,
    paid: 1000n,
    refunded: 300n,
    accrued: 700n,
    mints: 4,
    zeroFeeMints: 0,
    settled: true,
    complete: true,
    ...over,
  });

  test("a settled series whose three log kinds agree says nothing", () => {
    assert.deepEqual(checkMintRent(led()), []);
    assert.deepEqual(checkMintRent(led({ settled: false, accrued: 0n })), [], "held rent is not accrued until settlement");
  });

  test("an accrual that is not charges minus refunds pages", () => {
    const f = checkMintRent(led({ accrued: 690n }));
    assert.deepEqual(kinds(f), ["v2_mon_mint_rent/error"]);
    assert.equal(f[0].data.expected, 700n);
    assert.match(f[0].message, /a v6 ABI against a v7 deployment/);
    // Settling with nothing accrued although rent was charged and not refunded is the same defect.
    assert.deepEqual(kinds(checkMintRent(led({ accrued: 0n }))), ["v2_mon_mint_rent/error"]);
  });

  test("a rent-bearing series that charged a mint nothing pages", () => {
    const f = checkMintRent(led({ zeroFeeMints: 1 }));
    assert.deepEqual(kinds(f), ["v2_mon_mint_rent/error"]);
    assert.match(f[0].message, /rounds the charge UP/);
    assert.deepEqual(checkMintRent(led({ ppm: 0, marketPpm: 0, paid: 0n, refunded: 0n, accrued: 0n, zeroFeeMints: 4 })), [], "a 0 ppm series charging nothing is right");
  });

  test("a series pinned at 0 on a market that now charges is free until it expires", () => {
    const f = checkMintRent(led({ ppm: 0, marketPpm: 80, paid: 0n, refunded: 0n, accrued: 0n, zeroFeeMints: 4, settled: false }));
    assert.deepEqual(kinds(f), ["v2_mon_mint_rent/warn"]);
    assert.match(f[0].message, /pinned at creation and never changes/);
    assert.deepEqual(checkMintRent(led({ ppm: 0, marketPpm: null, paid: 0n, refunded: 0n, accrued: 0n, settled: false })), [], "an unregistered market proves nothing");
  });

  test("a ledger the scan did not follow from the start is not judged", () => {
    assert.deepEqual(checkMintRent(led({ accrued: 1n, complete: false })), []);
  });

  test("zero rent on a live market is the deploy blocker's runtime twin", () => {
    const base = { ticker: "NVDA", underlying: U, enabled: true, chainPpm: 80, registryPpm: 80 };
    assert.deepEqual(checkMintFee(base), []);
    const chainZero = checkMintFee({ ...base, chainPpm: 0 });
    assert.deepEqual(kinds(chainZero), ["v2_mon_mint_fee_zero/error"]);
    assert.match(chainZero[0].message, /charges writers nothing/);
    assert.deepEqual(kinds(checkMintFee({ ...base, enabled: false, chainPpm: 0 })), [], "a disabled market writes nothing to charge for");
    const regZero = checkMintFee({ ...base, registryPpm: null });
    assert.deepEqual(kinds(regZero), ["v2_mon_mint_fee_zero/error"]);
    assert.match(regZero[0].message, /tier1\.json/);
    assert.deepEqual(kinds(checkMintFee({ ticker: "NVDA", underlying: U, enabled: false, chainPpm: null, registryPpm: 0 })), ["v2_mon_mint_fee_zero/error"]);
    assert.equal(chainZero[0].key, `${U.toLowerCase()}:chain`);
    assert.equal(regZero[0].key, `${U.toLowerCase()}:registry`);
  });

  test("the registry resolves a market's rate over the shared one, and both may be absent", () => {
    const reg = parseRegistry({
      shared: { chainId: 4663 },
      v2: { fees: { mintFeePpm: 80 }, contracts: {} },
      markets: [
        { ticker: "NVDA", asset: U, v2: { status: "live", mintFeePpm: 1500 } },
        { ticker: "SPY", asset: addr(0xa002), v2: { status: "live" } },
      ],
    });
    assert.equal(reg.markets[0].v2.mintFeePpm, 1500, "the market's own rate wins, as RegisterMarkets does it");
    assert.equal(reg.markets[1].v2.mintFeePpm, 80, "otherwise the shared fallback");
    const none = parseRegistry({ shared: {}, v2: { contracts: {} }, markets: [{ ticker: "NVDA", asset: U, v2: { status: "live" } }] });
    assert.equal(none.markets[0].v2.mintFeePpm, null);
  });
});

describe("v7: the scan's rent ledger and roller positions", () => {
  const CH = "0x2256c045245288A314048aD2d71006a564343C63";
  const AR = C.autoRoller;
  const W = "0x000000000000000000000000000000000000000f";
  const addresses = { clearinghouse: CH, autoRoller: AR };
  const log = (eventName, address, args, blockNumber, logIndex) => ({ eventName, address, args, blockNumber: BigInt(blockNumber), logIndex, transactionHash: `0x${String(blockNumber).padStart(64, "0")}` });
  const life = [
    log("SeriesCreated", CH, { longId: 84n, underlying: U, isPut: false, strike: 5n, expiry: E, oracle: ORACLE, mintFeePpm: 80 }, 10, 0),
    log("Minted", CH, { longId: 84n, writer: W, longTo: W, units: 100n, collateral: 10n ** 18n, fee: 600n }, 11, 0),
    log("Minted", CH, { longId: 84n, writer: W, longTo: W, units: 100n, collateral: 10n ** 18n, fee: 400n }, 11, 3),
    log("Closed", CH, { longId: 84n, account: W, units: 50n, collateralFreed: 10n ** 18n, feeRefund: 300n }, 12, 1),
    log("MintFeesAccrued", CH, { longId: 84n, asset: U, amount: 700n }, 13, 2),
  ];

  test("Minted, Closed and MintFeesAccrued are the whole ledger, and the series' pinned rate is kept", () => {
    const scan = emptyState(4663, "x").scan;
    applyScanLogs(scan, life, addresses);
    assert.equal(scan.series["84"].p, 80);
    assert.deepEqual(scan.rent["84"], { paid: "1000", refunded: "300", accrued: "700", mints: 2, zeroFee: 0 });
    assert.equal(scan.rentAt, "13:2");
  });

  test("the reorg overlap replays logs, and the sums must not count them twice", () => {
    const scan = emptyState(4663, "x").scan;
    applyScanLogs(scan, life, addresses);
    applyScanLogs(scan, life, addresses); // the next run re-reads its last REORG_OVERLAP blocks
    assert.deepEqual(scan.rent["84"], { paid: "1000", refunded: "300", accrued: "700", mints: 2, zeroFee: 0 });
    // A genuinely new log past the watermark still counts.
    applyScanLogs(scan, [log("Minted", CH, { longId: 84n, writer: W, longTo: W, units: 1n, collateral: 1n, fee: 0n }, 14, 0)], addresses);
    assert.deepEqual(scan.rent["84"], { paid: "1000", refunded: "300", accrued: "700", mints: 3, zeroFee: 1 });
  });

  test("rent from another contract at the same address space is ignored", () => {
    const scan = emptyState(4663, "x").scan;
    applyScanLogs(scan, [log("Minted", "0x9999999999999999999999999999999999999999", { longId: 84n, writer: W, longTo: W, units: 1n, collateral: 1n, fee: 9n }, 11, 0)], addresses);
    assert.deepEqual(scan.rent, {});
  });

  test("Rolled opens a roller pair, StrategyStopped closes it, StaleAskCancelled keeps it", () => {
    const scan = emptyState(4663, "x").scan;
    const key = `${W.toLowerCase()}:${U.toLowerCase()}`;
    applyScanLogs(scan, [log("Rolled", AR, { writer: W, underlying: U, longId: 84n, orderId: 7n, strike: 5n, expiry: E, price: 1n, units: 100n }, 20, 0)], addresses);
    // `p`: the ask price the roll rested, kept so a Repriced can be measured against it (T-OP-090).
    assert.deepEqual(scan.roller[key], { w: W, u: U, e: E, p: "1" });
    applyScanLogs(scan, [log("StaleAskCancelled", AR, { writer: W, underlying: U, longId: 84n, orderId: 7n, spot: 6n, updatedAt: 1n }, 21, 0)], addresses);
    assert.deepEqual(scan.roller[key], { w: W, u: U, e: E, p: "1" }, "the position survives its ask");
    applyScanLogs(scan, [log("StrategyStopped", AR, { writer: W, underlying: U }, 22, 0)], addresses);
    assert.equal(scan.roller[key], undefined);
    // Another contract's Rolled is not ours.
    applyScanLogs(scan, [log("Rolled", CH, { writer: W, underlying: U, longId: 84n, orderId: 7n, strike: 5n, expiry: E, price: 1n, units: 100n }, 23, 0)], addresses);
    assert.deepEqual(scan.roller, {});
  });
});

describe("dedupe", () => {
  const f = (kind, key, check, severity, event = false) => finding(kind, key, check, `${kind} ${key}`, { n: 1n }, { severity, event });
  const run = (alerts, findings, completed, nowS, extra = {}) => reconcile(alerts, findings, { completed: new Set(completed), nowS, repeatS: 3600, eventRetentionS: 86_400, ...extra });
  const deliverAll = (alerts, send, nowS) => send.forEach((s) => markDelivered(alerts, s.id, s.finding.severity, nowS));

  test("new once, silent while open, a reminder after repeatS, escalation at once", () => {
    const alerts = {};
    const usdg = f("v2_mon_usdg_paused", "u", "usdg", "error");
    const lag = f("v2_mon_l2_lag", "head", "head", "warn");
    let r = run(alerts, [usdg, lag], ["usdg", "head"], 1000);
    assert.deepEqual(r.send.map((s) => s.reason), ["new", "new"]);
    deliverAll(alerts, r.send, 1000);
    r = run(alerts, [usdg, lag], ["usdg", "head"], 1060);
    assert.deepEqual(r.send, []);
    r = run(alerts, [usdg, f("v2_mon_l2_lag", "head", "head", "error")], ["usdg", "head"], 1120);
    assert.deepEqual(r.send.map((s) => `${s.id}/${s.reason}`), ["v2_mon_l2_lag:head/escalated"]);
    deliverAll(alerts, r.send, 1120);
    r = run(alerts, [usdg, f("v2_mon_l2_lag", "head", "head", "error")], ["usdg", "head"], 4600);
    assert.deepEqual(r.send.map((s) => `${s.id}/${s.reason}`), ["v2_mon_usdg_paused:u/reminder"]);
    r = run(alerts, [usdg], ["usdg", "head"], 4601, { repeatS: 0 });
    assert.deepEqual(r.send, []);
  });

  test("an undelivered condition is retried while it holds", () => {
    const alerts = {};
    const usdg = f("v2_mon_usdg_paused", "u", "usdg", "error");
    run(alerts, [usdg], ["usdg"], 1000);
    assert.deepEqual(run(alerts, [usdg], ["usdg"], 1060).send.map((s) => s.reason), ["retry"]);
  });

  test("a condition resolves only when its check completed; info-only conditions resolve silently", () => {
    const alerts = {};
    const usdg = f("v2_mon_usdg_paused", "u", "usdg", "error");
    const nonce = f("v2_mon_safe_nonce_changed", "s:1", "feeds", "info", true);
    const info = f("v2_mon_service_degraded", "x", "health", "info");
    deliverAll(alerts, run(alerts, [usdg, nonce, info], ["usdg", "feeds", "health"], 1000).send, 1000);
    let r = run(alerts, [], ["feeds"], 1060); // usdg and health checks failed this run
    assert.deepEqual(r.resolved, []);
    assert.ok(alerts["v2_mon_usdg_paused:u"]);
    r = run(alerts, [], ["usdg", "health", "feeds"], 1120);
    assert.deepEqual(r.resolved.map((x) => x.id), ["v2_mon_usdg_paused:u"]);
    assert.equal(alerts["v2_mon_service_degraded:x"], undefined);
    assert.ok(alerts["v2_mon_safe_nonce_changed:s:1"], "events do not resolve");
    const rf = resolvedFinding(r.resolved[0].entry, 1120);
    assert.equal(rf.kind, "v2_mon_resolved");
    assert.equal(rf.severity, "info");
    assert.equal(rf.data.resolvedKind, "v2_mon_usdg_paused");
    run(alerts, [], ["feeds"], 1000 + 86_400);
    assert.equal(alerts["v2_mon_safe_nonce_changed:s:1"], undefined, "events are forgotten after the retention");
  });

  test("an undelivered event is retried from memory even when not found again", () => {
    const alerts = {};
    const jump = f("v2_mon_feed_round_jump", "feed:2", "feeds", "warn", true);
    run(alerts, [jump], ["feeds"], 1000);
    const r = run(alerts, [], ["feeds"], 1060);
    assert.deepEqual(r.send.map((s) => `${s.id}/${s.reason}`), ["v2_mon_feed_round_jump:feed:2/retry"]);
    assert.equal(r.send[0].finding.message, jump.message);
    deliverAll(alerts, r.send, 1060);
    assert.deepEqual(run(alerts, [], ["feeds"], 1120).send, []);
  });
});

describe("payload, kinds, exit codes", () => {
  test("every kind is a relay identifier with a severity and a runbook", () => {
    for (const [kind, spec] of Object.entries(KINDS)) {
      assert.match(kind, KIND_RE);
      assert.ok(kind.startsWith("v2_mon_"));
      assert.ok(RANK[spec.severity] !== undefined);
      assert.match(spec.runbook, /ops\/alerts\.md §V\d+/);
    }
    assert.equal(Object.keys(ACTIONS).length, 6, "INTERFACE_VERSION 7 added CANCEL_STALE");
  });

  test("the payload is the keeper shape the relay accepts", () => {
    const fd = finding("v2_mon_usdg_paused", "0xabc", "usdg", "USDG paused", { usdg: "0xabc", big: 10n ** 30n });
    const p = alertPayload(fd, { chainId: 4663, nowMs: Date.UTC(2026, 8, 17), reason: "new" });
    assert.deepEqual(Object.keys(p).sort(), ["at", "chainId", "data", "kind", "message", "severity", "source"]);
    assert.equal(p.source, "callhouse-monitor");
    assert.equal(p.at, "2026-09-17T00:00:00.000Z");
    assert.equal(p.data.big, "1000000000000000000000000000000");
    assert.equal(p.data.key, "0xabc");
    assert.match(p.data.runbook, /§V33/);
    assert.doesNotThrow(() => JSON.stringify(p));
    assert.match(alertPayload(fd, { chainId: 4663, nowMs: 0, reason: "reminder" }).message, /^still open: /);
  });

  test("exit code precedence 4 > 3 > 1 > 0; info does not count", () => {
    const warn = [finding("v2_mon_l2_lag", "h", "head", "m")];
    const info = [finding("v2_mon_safe_nonce_changed", "s", "feeds", "m")];
    assert.equal(exitCodeFor({ findings: [], deliveryFailures: 0, incompleteChecks: 0 }), 0);
    assert.equal(exitCodeFor({ findings: info, deliveryFailures: 0, incompleteChecks: 0 }), 0);
    assert.equal(exitCodeFor({ findings: warn, deliveryFailures: 0, incompleteChecks: 0 }), 1);
    assert.equal(exitCodeFor({ findings: warn, deliveryFailures: 0, incompleteChecks: 1 }), 3);
    assert.equal(exitCodeFor({ findings: warn, deliveryFailures: 1, incompleteChecks: 1 }), 4);
  });

  test("a -32603 node error is a transport failure, not a revert", () => {
    // viem wraps it in a ContractFunctionRevertedError whose reason is the node's message, which used to make
    // an unreachable view read as "absent" and resolve the open alert (ops-c27).
    const named = (name, extra = {}) => Object.assign(new Error(name), { name, ...extra });
    const internal = named("ContractFunctionExecutionError", {
      shortMessage: 'The contract function "oraclePaused" reverted with the following reason:\ninternal error',
      cause: named("ContractFunctionRevertedError", { reason: "internal error", cause: named("InternalRpcError", { code: -32603, cause: named("RpcRequestError", { code: -32603 }) }) }),
    });
    assert.equal(isRevert(internal), false);
    assert.equal(isRevert(named("ContractFunctionRevertedError", { data: { data: "0x1234abcd" } })), true, "a revert with data is a revert");
    assert.equal(isRevert(named("ContractFunctionZeroDataError")), true, "no code at the address is an answer");
    assert.equal(isRevert(named("HttpRequestError", { shortMessage: "HTTP request failed. Status: 429" })), false);
  });

  test("fixed-point formatting", () => {
    assert.equal(fixed(217_159_827n, 6, 2), "217.15");
    assert.equal(fixed(-5n, 2, 2), "-0.05");
    assert.equal(fixed(10n ** 18n, 18, 0), "1");
  });
});

test("price divergence: calibrated band is strict, escalates on a second head, then clears", () => {
  const base = {
    ticker: "NVDA", underlying: addr(0xa001), chainlinkSource: SRC.chainlink, poolSource: SRC.univ3,
    feedPrice: 100_000_000n, poolPrice: 102_000_000n, bandBps: 200, head: 10n,
  };
  assert.deepEqual(checkPriceDivergence(base), { findings: [], streak: null }, "exact band is quiet");
  const first = checkPriceDivergence({ ...base, poolPrice: 102_500_000n });
  assert.equal(first.findings[0].severity, "warn");
  assert.equal(first.findings[0].data.gapBps, 250);
  assert.deepEqual(first.streak, { head: "10", count: 1 });
  assert.equal(checkPriceDivergence({ ...base, poolPrice: 102_500_000n }, first.streak).findings[0].severity, "warn", "same head is not a second pass");
  const second = checkPriceDivergence({ ...base, poolPrice: 102_500_000n, head: 11n }, first.streak);
  assert.equal(second.findings[0].severity, "error");
  assert.equal(second.findings[0].data.passes, 2);
  assert.deepEqual(checkPriceDivergence({ ...base, poolPrice: 101_000_000n, head: 12n }, second.streak), { findings: [], streak: null });
  assert.deepEqual(checkPriceDivergence({ ...base, feedPrice: 0n }, second.streak), { findings: [], streak: null });
});

test("price divergence pass reads both sources, persists streak, and never pages on an unavailable pool", async () => {
  const dir = tmp("monitor-divergence-");
  try {
    const nvda = market("NVDA", 1, { pool: addr(0x9001), floor: "1" });
    const registry = writeRegistry(dir, { markets: [nvda] });
    const chain = new FakeChain({ timestamp: Date.UTC(2026, 8, 21, 15) / 1000 });
    let poolOk = true;
    let poolPrice = 102_500_000n;
    chain.read = (address, fn, args) => {
      if (fn === "latest" && address.toLowerCase() === SRC.chainlink.toLowerCase()) return [true, 100_000_000n, BigInt(chain.head.timestamp)];
      if (fn === "latest" && address.toLowerCase() === SRC.univ3.toLowerCase()) return [poolOk, poolOk ? poolPrice : 0n, BigInt(chain.head.timestamp)];
      return defaultRead(chain, address, fn, args);
    };
    const opts = options(dir, registry, [], { MONITOR_DIVERGENCE_BANDS: "NVDA=200" });
    const first = await runOnce(opts, { viem: fakeViem(chain) });
    assert.equal(first.checks.divergence.status, "ok");
    assert.equal(first.findings.find((f) => f.kind === "v2_mon_price_divergence")?.severity, "warn");
    chain.setHead(chain.head.number + 1n, chain.head.timestamp + 60);
    const second = await runOnce(opts, { viem: fakeViem(chain) });
    assert.equal(second.findings.find((f) => f.kind === "v2_mon_price_divergence")?.severity, "error");
    poolOk = false;
    chain.setHead(chain.head.number + 1n, chain.head.timestamp + 60);
    const missing = await runOnce(opts, { viem: fakeViem(chain) });
    assert.equal(missing.checks.divergence.status, "incomplete");
    assert.equal(kindsOf(missing).includes("v2_mon_price_divergence"), false);
    poolOk = true;
    poolPrice = 100_500_000n;
    chain.setHead(chain.head.number + 1n, chain.head.timestamp + 60);
    const clear = await runOnce(opts, { viem: fakeViem(chain) });
    assert.equal(clear.checks.divergence.status, "ok");
    assert.equal(kindsOf(clear).includes("v2_mon_price_divergence"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("arguments and registry", () => {
  test("rpc required; thresholds, health, tickers; the token only from the environment", () => {
    assert.throws(() => parseArgs([], {}), UsageError);
    const o = parseArgs(
      ["--once", "--rpc", "http://127.0.0.1:8546", "--threshold", "lateS=60,roundJumpBps=100", "--health", "relay=http://127.0.0.1:1/health", "--tickers", "nvda,TSLA", "--repeat-hours", "0"],
      { MONITOR_HEALTH: "cranker=http://cranker.railway.internal:8792/health", ALERT_WEBHOOK: "http://relay/alert", ALERT_WEBHOOK_TOKEN: "t".repeat(32), MONITOR_THRESHOLDS: "backlogS=10" },
    );
    assert.equal(o.once, true);
    assert.equal(o.thresholds.lateS, 60);
    assert.equal(o.thresholds.roundJumpBps, 100);
    assert.equal(o.thresholds.backlogS, 10);
    assert.equal(o.thresholds.repeatS, 0);
    assert.deepEqual(o.health.map((h) => h.name), ["cranker", "relay"]);
    assert.deepEqual(o.tickers, ["nvda", "TSLA"]);
    assert.equal(o.token, "t".repeat(32));
    assert.equal(DEFAULTS.lateS, 7200, "defaults are not mutated");
    assert.deepEqual(parseArgs(["--rpc", "http://x", "--divergence-band", "tsla=240"], { MONITOR_DIVERGENCE_BANDS: "NVDA=210" }).divergenceBands, { NVDA: 210, TSLA: 240 });
    assert.deepEqual(parseArgs(["--rpc", "http://x"], {}).divergenceBands, {}, "un-calibrated markets stay inactive");
    assert.throws(() => parseArgs(["--rpc", "http://x", "--divergence-band", "NVDA=300"], {}), /1\.\.299/);
    assert.throws(() => parseArgs(["--rpc", "http://x"], { MONITOR_DIVERGENCE_BANDS: "NVDA=200,nvda=210" }), /duplicate/);
    assert.throws(() => parseArgs(["--rpc", "http://x", "--token", "abc"], {}), /unknown argument --token/);
    assert.throws(() => parseArgs(["--rpc", "http://x", "--threshold", "nope=1"], {}), /unknown threshold/);
    assert.throws(() => parseArgs(["--rpc", "ftp://x"], {}), /http/);
    assert.throws(() => parseArgs(["--rpc", "http://x", "--interval", "1"], {}), /interval/);
    assert.equal(parseArgs(["--rpc", "http://x"], {}).maxFailedPasses, 3);
    assert.equal(parseArgs(["--rpc", "http://x"], { MONITOR_MAX_FAILED_PASSES: "10" }).maxFailedPasses, 10);
    assert.equal(parseArgs(["--rpc", "http://x", "--max-failed-passes", "0"], {}).maxFailedPasses, 0);
    assert.throws(() => parseArgs(["--rpc", "http://x", "--max-failed-passes", "-1"], {}), /max-failed-passes/);
    assert.throws(() => parseArgs(["--rpc", "http://x"], { MONITOR_MAX_FAILED_PASSES: "soon" }), /max-failed-passes/);
    assert.equal(parseArgs(["--help"], {}).help, true);
  });

  test("the committed registry parses; scope is live and paused v2 markets unless asked", () => {
    const reg = parseRegistry(JSON.parse(readFileSync(DEFAULT_REGISTRY, "utf8")), DEFAULT_REGISTRY);
    assert.equal(reg.chainId, 4663);
    assert.equal(reg.markets.length, 35);
    const nvda = reg.markets.find((m) => m.ticker === "NVDA");
    assert.equal(nvda.v2.univ3MinLiquidity, 1_700_000_000_000_000_000n);
    const live = { ...reg, markets: reg.markets.map((m) => (m.ticker === "NVDA" ? { ...m, v2: { ...m.v2, status: "live" } } : m)) };
    assert.deepEqual(marketsInScope(live).map((m) => m.ticker), ["NVDA"]);
    assert.equal(marketsInScope(reg, { allMarkets: true }).length, 35);
    assert.deepEqual(marketsInScope(reg, { tickers: ["tsla"] }).map((m) => m.ticker), ["TSLA"]);
    assert.throws(() => parseRegistry({ markets: [{ ticker: "X", asset: "0x12" }] }), /not an address/);
  });
});

describe("one pass without a chain", () => {
  let dir;
  let relay;
  let services;
  const received = [];
  let badStatus = 503;
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "monitor-test-"));
    relay = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        if (req.headers.authorization !== `Bearer ${"k".repeat(40)}`) {
          res.writeHead(401).end();
          return;
        }
        received.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      });
    });
    services = createServer((req, res) => {
      if (req.url === "/good") res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
      else res.writeHead(badStatus, { "content-type": "application/json" }).end(JSON.stringify({ status: badStatus === 200 ? "ok" : "wedged" }));
    });
  });
  after(() => {
    relay.close();
    services.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a dead RPC (port 1) pages check_failed, health pages, dedupe holds across runs, recovery resolves", async () => {
    const relayPort = await listen(relay);
    const svcPort = await listen(services);
    const registry = path.join(dir, "registry.json");
    writeFileSync(registry, JSON.stringify({ shared: { chainId: 4663 }, v2: { contracts: {} }, markets: [] }));
    const opts = parseArgs(
      ["--once", "--rpc", "http://127.0.0.1:1", "--registry", registry, "--state", path.join(dir, "state.json"), "--health", `cranker=http://127.0.0.1:${svcPort}/good`, "--health", `notifier=http://127.0.0.1:${svcPort}/bad`],
      { ALERT_WEBHOOK: `http://127.0.0.1:${relayPort}/alert`, ALERT_WEBHOOK_TOKEN: "k".repeat(40) },
    );

    const r1 = await runOnce(opts);
    assert.equal(r1.exit, 3);
    assert.deepEqual(r1.sent.map((s) => `${s.kind}/${s.severity}/${s.reason}/${s.delivered}`).sort(), ["v2_mon_check_failed/error/new/true", "v2_mon_service_down/error/new/true"]);
    assert.equal(received.length, 2);
    for (const p of received) {
      assert.equal(p.source, "callhouse-monitor");
      assert.equal(p.chainId, 4663);
      assert.match(p.kind, KIND_RE);
    }
    assert.equal(r1.checks.settlement.status, "incomplete");
    assert.equal(r1.checks.health.status, "ok");

    const r2 = await runOnce(opts);
    assert.equal(r2.exit, 3);
    assert.deepEqual(r2.sent, []);
    assert.equal(received.length, 2);

    badStatus = 200;
    const r3 = await runOnce(opts);
    assert.deepEqual(r3.sent, []);
    assert.deepEqual(r3.resolved.map((x) => `${x.resolvedKind}/${x.delivered}`), ["v2_mon_service_down/true"]);
    assert.equal(received.length, 3);
    assert.equal(received[2].kind, "v2_mon_resolved");
    const state = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.deepEqual(Object.keys(state.alerts), ["v2_mon_check_failed:head"]);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Whole passes against an in-memory chain (ops/v2/fake-chain.mjs). Every check, the log decoding, the
 * dedupe and the state file are the real ones; only the RPC client is replaced. Regression cover for
 * the ops sweep findings retained in the development review record.
 * ------------------------------------------------------------------------------------------------- */
describe("a pass against an in-memory chain", () => {
  const ROLE_GRANTED = "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)";
  const DEFAULT_ADMIN_ROLE = `0x${"00".repeat(32)}`;
  const dirs = [];
  const scratch = (prefix) => {
    const d = tmp(prefix);
    dirs.push(d);
    return d;
  };
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  // ops-c19: a read that FAILS is not evidence of a reorg. Resetting on it moved adoptConfigUntil to
  // the head and adopted every admin event since the last run without a page.
  const anchorRun = async ({ anchorReadFails }) => {
    const dir = scratch("monitor-anchor-");
    const registry = writeRegistry(dir, { deployBlock: 1000 });
    const chain = new FakeChain({ head: 20_000n });
    const opts = options(dir, registry);

    await runOnce(opts, { viem: fakeViem(chain) });
    const s1 = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(s1.anchor.block, "20000");
    assert.equal(s1.scan.adoptConfigUntil, "20000");
    s1.feeds = { [addr(0xb001)]: { aggregator: addr(0xf00), owner: addr(0x5afe), lastRoundId: "18446744073709551716" } };
    writeFileSync(path.join(dir, "state.json"), JSON.stringify(s1));

    chain.logs.push(rawLog(ROLE_GRANTED, { role: DEFAULT_ADMIN_ROLE, account: addr(0xbad), sender: addr(0xbad) }, { address: C.clearinghouse, blockNumber: 20_050 }));
    chain.setHead(20_100n, chain.head.timestamp + 10);
    if (anchorReadFails) {
      chain.getBlockHook = (n) => {
        if (n === 20_000n) throw transportError();
        return chain.blockAt(n);
      };
    }
    const r2 = await runOnce(opts, { viem: fakeViem(chain) });
    return { r2, s2: JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")) };
  };

  test("a readable anchor block pages the admin-role grant found since the last run", async () => {
    const { r2 } = await anchorRun({ anchorReadFails: false });
    assert.deepEqual(kindsOf(r2), ["v2_mon_config_changed", TVL_DARK]);
  });

  test("a 429 on the anchor read keeps the scan state: nothing is adopted and no baseline is wiped", async () => {
    const { r2, s2 } = await anchorRun({ anchorReadFails: true });
    assert.deepEqual(kindsOf(r2), ["v2_mon_config_changed", TVL_DARK], "the RoleGranted must still page");
    assert.equal(s2.scan.adoptConfigUntil, "20000", "the adoption boundary must not jump to the head");
    assert.equal(Object.keys(s2.feeds).length, 1, "feed baselines must survive a failed anchor read");
    assert.ok(
      r2.notes.some((n) => n.includes("could not be read")),
      `notes: ${JSON.stringify(r2.notes)}`,
    );
  });

  test("an anchor block that reads back with another hash still resets the scan state", async () => {
    const dir = scratch("monitor-reorg-");
    const registry = writeRegistry(dir, { deployBlock: 1000 });
    const chain = new FakeChain({ head: 20_000n });
    const opts = options(dir, registry);
    await runOnce(opts, { viem: fakeViem(chain) });
    chain.setHead(20_100n, chain.head.timestamp + 10);
    chain.getBlockHook = (n) => ({ ...chain.blockAt(n), hash: `0x${"b".repeat(64)}` });
    const r2 = await runOnce(opts, { viem: fakeViem(chain) });
    assert.ok(
      r2.notes.some((n) => n.includes("is not the one seen last run")),
      `notes: ${JSON.stringify(r2.notes)}`,
    );
    const s2 = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(s2.scan.adoptConfigUntil, "20100");
  });

  // ops-c21: Finalized on the oracle used to end the expiry for the settlement check, and the redeem
  // backlog only follows SeriesSettled, so a finalized expiry whose series were never settled fell
  // between the two and paged nothing while every holder's redeem reverted NotSettled.
  const finalizedRun = async ({ settledLog }) => {
    const dir = scratch("monitor-unsettled-");
    const registry = writeRegistry(dir, { deployBlock: 1000 });
    const now = 1_790_000_000;
    const E = now - 2 * 86_400;
    const U = addr(0xa001);
    const longId = 0x1234n << 1n;
    const chain = new FakeChain({ head: 20_000n, timestamp: now });
    chain.logs.push(
      rawLog(
        "event SeriesCreated(uint256 indexed longId, address indexed underlying, bool isPut, uint128 strike, uint40 expiry, address oracle, uint16 exerciseFeeBps, uint32 mintFeePpm)",
        { longId, underlying: U, isPut: false, strike: 200_000_000n, expiry: E, oracle: C.settlementOracle, exerciseFeeBps: 30, mintFeePpm: 80 },
        { address: C.clearinghouse, blockNumber: 5000 },
      ),
    );
    if (settledLog) {
      chain.logs.push(
        rawLog(
          "event SeriesSettled(uint256 indexed longId, uint256 settlementPrice, uint256 longPayoutPerUnit, uint256 feePerUnit, uint256 shortPayoutPerUnit)",
          { longId, settlementPrice: 210_000_000n, longPayoutPerUnit: 0n, feePerUnit: 0n, shortPayoutPerUnit: 0n },
          { address: C.clearinghouse, blockNumber: 5001 },
        ),
      );
    }
    chain.read = (address, fn, args) => {
      if (fn === "openInterest") return 500n;
      if (fn === "settlementInfo") return [2, 210_000_000n, 0, true, false, true]; // Finalized
      if (fn === "series") return { underlying: U, isPut: false, expiry: BigInt(E), strike: 200_000_000n, oracle: C.settlementOracle, exerciseFeeBps: 30, settled: settledLog, settlementPrice: 210_000_000n, longPayoutPerUnit: 0n, feePerUnit: 0n, shortPayoutPerUnit: 0n, mintFeePpm: 80, mintFeesHeld: 0n };
      return defaultRead(chain, address, fn, args);
    };
    const r = await runOnce(options(dir, registry), { viem: fakeViem(chain) });
    return { r, state: JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")) };
  };

  test("a finalized expiry whose series are still unsettled pages and stays open", async () => {
    const { r, state } = await finalizedRun({ settledLog: false });
    assert.ok(kindsOf(r).includes("v2_mon_series_unsettled"), `findings: ${JSON.stringify(kindsOf(r))}`);
    assert.deepEqual(state.scan.expiryDone, {}, "the expiry must not be marked done while a series is unsettled");
    assert.equal(r.exit, 1);
  });

  test("a finalized expiry whose series all settled is done and pages nothing about settlement", async () => {
    const { r, state } = await finalizedRun({ settledLog: true });
    assert.ok(!kindsOf(r).includes("v2_mon_series_unsettled"), `findings: ${JSON.stringify(kindsOf(r))}`);
    assert.equal(Object.keys(state.scan.expiryDone).length, 1);
  });

  // ops-c37: --no-alerts saves no cursor, so maxRangesPerRun used to fix the runbooks' laptop diagnostic to
  // a window of deployBlock + 200 x 10,000 blocks (about 56 h of this chain) and report "nothing late"
  // about every series created after it, while its own output said the next run would continue.
  const lateAfterWindow = async (extra) => {
    const dir = scratch("monitor-window-");
    const registry = writeRegistry(dir, { deployBlock: 1000 });
    const now = 1_790_000_000;
    const chain = new FakeChain({ head: 5_001_000n, timestamp: now });
    chain.logs.push(
      rawLog(
        "event SeriesCreated(uint256 indexed longId, address indexed underlying, bool isPut, uint128 strike, uint40 expiry, address oracle, uint16 exerciseFeeBps, uint32 mintFeePpm)",
        { longId: 2n, underlying: addr(0xa001), isPut: false, strike: 1n, expiry: now - 3 * 3600, oracle: C.settlementOracle, exerciseFeeBps: 30, mintFeePpm: 80 },
        { address: C.clearinghouse, blockNumber: 3_501_000 },
      ),
    );
    chain.read = (address, fn, args) => {
      if (fn === "openInterest") return 100n;
      if (fn === "settlementInfo") return [0, 0n, 0, false, false, false];
      return defaultRead(chain, address, fn, args);
    };
    return runOnce(options(dir, registry, extra), { viem: fakeViem(chain) });
  };

  test("--no-alerts scans to the head, so a series created past the per-run window is seen", async () => {
    const r = await lateAfterWindow(["--no-alerts"]);
    assert.equal(r.checks.scan.status, "ok", r.checks.scan.detail);
    assert.ok(kindsOf(r).includes("v2_mon_settlement_late"), `findings: ${JSON.stringify(kindsOf(r))}`);
  });

  test("--no-alerts with an explicit maxRangesPerRun keeps the cap and says nothing continues it", async () => {
    const r = await lateAfterWindow(["--no-alerts", "--threshold", "maxRangesPerRun=10"]);
    assert.equal(r.checks.scan.status, "incomplete");
    assert.match(r.checks.scan.detail, /no run continues this one/);
    assert.equal(r.state, null, "a dry run saves no state");
  });

  // ops-c20: a check that dies half-way has already moved the state for the inputs it read (a feed baseline,
  // the tokens cursor), so its findings used to be lost for good when run() dropped them.
  test("a feed aggregator switch found before a later read throws is still paged", async () => {
    const dir = scratch("monitor-partial-");
    const NVDA = market("NVDA", 1);
    const TSLA = market("TSLA", 2);
    const registry = writeRegistry(dir, { markets: [NVDA, TSLA] });
    const chain = new FakeChain({ head: 20_000n });
    let aggregator = addr(0xa99001);
    chain.read = (address, fn, args) => {
      if (fn === "feeds") return [args[0].toLowerCase() === NVDA.asset.toLowerCase() ? NVDA.feed : TSLA.feed, 93_600, 2000];
      if (fn === "aggregator" && address.toLowerCase() === NVDA.feed.toLowerCase()) return aggregator;
      return defaultRead(chain, address, fn, args);
    };
    const opts = options(dir, registry);
    await runOnce(opts, { viem: fakeViem(chain) }); // baseline: aggregator A

    aggregator = addr(0xa99002); // the NVDA proxy switches phase
    chain.setHead(20_600n, chain.head.timestamp + 60);
    chain.getCodeHook = () => {
      throw transportError(); // the owner Safe's getCode times out, after both markets were read
    };
    const r2 = await runOnce(opts, { viem: fakeViem(chain) });
    assert.equal(r2.checks.feeds.status, "failed");
    assert.ok(kindsOf(r2).includes("v2_mon_feed_aggregator_changed"), `findings: ${JSON.stringify(kindsOf(r2))}`);
  });

  // ops-c25: the registry's v2.status is a build-time value; the Clearinghouse is the truth about what users
  // can trade. A market registered on chain while the registry still says `planned` was watched by nothing.
  test("a market registered on the Clearinghouse is watched although the registry says planned", async () => {
    const dir = scratch("monitor-scope-");
    const AMD = market("AMD", 3, { status: "planned" });
    const registry = writeRegistry(dir, { markets: [AMD] });
    const chain = new FakeChain({ head: 20_000n });
    chain.read = (address, fn, args) => {
      if (fn === "market") return { enabled: true, mintPaused: false, strikeTick: 100n, exerciseFeeBps: 30, oracle: C.settlementOracle, mintFeePpm: 80 };
      if (fn === "paused" && address.toLowerCase() === AMD.asset.toLowerCase()) return true;
      return defaultRead(chain, address, fn, args);
    };
    const r = await runOnce(options(dir, registry), { viem: fakeViem(chain) });
    assert.ok(kindsOf(r).includes("v2_mon_token_paused"), `findings: ${JSON.stringify(kindsOf(r))}`);
    assert.ok(
      r.notes.some((n) => n.includes("AMD (registry says planned)")),
      `notes: ${JSON.stringify(r.notes)}`,
    );
  });

  // ops-c41: an adopted PoolSet (a first run, a reset, a lost state file) left nothing watching what the
  // settlement source is actually wired to; a different pool and a zero floor were only a note, exit 0.
  test("a UniV3 source wired to another pool, with a floor under the registry's, pages", async () => {
    const dir = scratch("monitor-poolwiring-");
    const NVDA = market("NVDA", 1, { pool: addr(0x9001), floor: "1000" });
    const registry = writeRegistry(dir, { markets: [NVDA] });
    const chain = new FakeChain({ head: 20_000n });
    chain.read = (address, fn, args) => {
      if (fn === "pools" && address.toLowerCase() === SRC.univ3.toLowerCase()) return [addr(0x9bad), true, 18, 300, 0n];
      return defaultRead(chain, address, fn, args);
    };
    const r = await runOnce(options(dir, registry), { viem: fakeViem(chain) });
    assert.deepEqual(kindsOf(r), [TVL_DARK, "v2_mon_pool_wiring", "v2_mon_pool_wiring"], "one for the pool, one for the floor");
    assert.equal(r.exit, 1);
  });

  // ops-c26: an expiry pinned before a setFeed(A -> B) still settles on A, and only B was watched.
  test("the old feed an open expiry is still pinned to is watched too", async () => {
    const dir = scratch("monitor-pinnedfeed-");
    const NVDA = market("NVDA", 1);
    const OLD = addr(0xfeed0a);
    const registry = writeRegistry(dir, { markets: [NVDA] });
    const now = 1_790_000_000;
    const E = now + 20 * 86_400;
    const chain = new FakeChain({ head: 20_000n, timestamp: now });
    chain.logs.push(
      rawLog(
        "event SeriesCreated(uint256 indexed longId, address indexed underlying, bool isPut, uint128 strike, uint40 expiry, address oracle, uint16 exerciseFeeBps, uint32 mintFeePpm)",
        { longId: 2n, underlying: NVDA.asset, isPut: false, strike: 1n, expiry: E, oracle: C.settlementOracle, exerciseFeeBps: 30, mintFeePpm: 80 },
        { address: C.clearinghouse, blockNumber: 5000 },
      ),
    );
    chain.read = (address, fn, args) => {
      const a = address.toLowerCase();
      if (fn === "feeds") return [NVDA.feed, 93_600, 2000];
      if (fn === "pinnedFeeds" && a === SRC.chainlink.toLowerCase()) return [OLD, 93_600, 2000, true];
      if (fn === "accessController" && a === OLD.toLowerCase()) return addr(0xacc355);
      return defaultRead(chain, address, fn, args);
    };
    const r = await runOnce(options(dir, registry), { viem: fakeViem(chain) });
    assert.ok(
      r.findings.some((f) => f.kind === "v2_mon_feed_access_controller" && f.message.toLowerCase().includes(OLD.toLowerCase())),
      `findings: ${JSON.stringify(r.findings.map((f) => f.kind))}`,
    );
  });

  // ops-c30: an event kind pages once and never again, so counting a printed line as a delivery threw it away.
  test("with no webhook an alert is logged, not counted as delivered, and is sent once one is configured", async () => {
    const received = [];
    const relay = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        received.push(JSON.parse(body).kind);
        res.writeHead(200).end("{}");
      });
    });
    const port = await new Promise((resolve) => relay.listen(0, "127.0.0.1", () => resolve(relay.address().port)));
    try {
      const dir = scratch("monitor-nowebhook-");
      const registry = writeRegistry(dir, { deployBlock: 1000 });
      const chain = new FakeChain({ head: 20_000n });
      await runOnce(options(dir, registry), { viem: fakeViem(chain) }); // a quiet first run sets the adoption boundary
      chain.logs.push(rawLog(ROLE_GRANTED, { role: DEFAULT_ADMIN_ROLE, account: addr(0xbad), sender: addr(0xbad) }, { address: C.clearinghouse, blockNumber: 20_050 }));
      chain.setHead(20_060n, chain.head.timestamp + 6);

      const blind = await runOnce(options(dir, registry), { viem: fakeViem(chain) });
      assert.deepEqual(blind.sent.map((s) => `${s.kind}/${s.delivered}/${s.logged}`), ["v2_mon_config_changed/false/true", `${TVL_DARK}/false/true`]);
      assert.equal(blind.deliveryFailures, 0, "nowhere to send is not a delivery failure");
      assert.equal(blind.exit, 1, "and must not raise the exit code to 4");

      chain.setHead(20_100n, chain.head.timestamp + 4);
      const wired = await runOnce(options(dir, registry, [], { ALERT_WEBHOOK: `http://127.0.0.1:${port}/alert` }), { viem: fakeViem(chain) });
      assert.deepEqual(
        wired.sent.map((s) => `${s.kind}/${s.reason}/${s.delivered}`),
        [`${TVL_DARK}/retry/true`, "v2_mon_config_changed/retry/true"],
      );
      assert.deepEqual(received, [TVL_DARK, "v2_mon_config_changed"]);
    } finally {
      relay.close();
    }
  });

  // ops-c38: the state file is the monitor's whole memory. A write that failed (EACCES on a volume without
  // RAILWAY_RUN_UID=0) used to throw AFTER the pages went out: the loop carried on, every run started empty,
  // open conditions paged again and again, and every admin event BETWEEN two runs was adopted in silence.
  test("a state file it cannot write is paged, and the runs still share one memory", async () => {
    const received = [];
    const relay = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        received.push(JSON.parse(body).kind);
        res.writeHead(200).end("{}");
      });
    });
    const port = await new Promise((resolve) => relay.listen(0, "127.0.0.1", () => resolve(relay.address().port)));
    const dir = scratch("monitor-nostate-");
    const stateDir = path.join(dir, "data");
    mkdirSync(stateDir);
    try {
      const NVDA = market("NVDA", 1);
      const registry = writeRegistry(dir, { markets: [NVDA], deployBlock: 1000 });
      const chain = new FakeChain({ head: 20_000n });
      chain.read = (address, fn, args) => (fn === "paused" && address.toLowerCase() === NVDA.asset.toLowerCase() ? true : defaultRead(chain, address, fn, args));
      const opts = parseArgs(["--once", "--rpc", "http://127.0.0.1:9", "--registry", registry, "--state", path.join(stateDir, "monitor-v2.json")], {
        ALERT_WEBHOOK: `http://127.0.0.1:${port}/alert`,
        ALERT_WEBHOOK_TOKEN: "k".repeat(40),
      });
      chmodSync(stateDir, 0o555); // the volume mount the node user cannot write
      const r1 = await runOnce(opts, { viem: fakeViem(chain) });
      assert.ok(kindsOf(r1).includes("v2_mon_state_unwritable"), `findings: ${JSON.stringify(kindsOf(r1))}`);
      assert.equal(r1.exit, 1, "an unwritable state path is an error finding, not a thrown run");

      chain.logs.push(rawLog(ROLE_GRANTED, { role: DEFAULT_ADMIN_ROLE, account: addr(0xbad), sender: addr(0xbad) }, { address: C.clearinghouse, blockNumber: 20_300 }));
      chain.setHead(20_600n, chain.head.timestamp + 60);
      await runOnce(opts, { viem: fakeViem(chain) });
      chain.setHead(21_200n, chain.head.timestamp + 60);
      await runOnce(opts, { viem: fakeViem(chain) });

      assert.ok(received.includes("v2_mon_config_changed"), `the RoleGranted(DEFAULT_ADMIN_ROLE) between two runs must page, not be adopted: ${JSON.stringify(received)}`);
      assert.equal(received.filter((k) => k === "v2_mon_token_paused").length, 1, `the open condition must page once, not every run: ${JSON.stringify(received)}`);
    } finally {
      chmodSync(stateDir, 0o755);
      relay.close();
    }
  });

  // ops-c29: nothing ever left scan state. 35 markets on dailies add about 70 series a day for ever, in a file
  // rewritten in full every run and re-read into one getBlock per settled series after any reset.
  test("series of expiries long done are pruned, and the backlog reads are paced", async () => {
    const dir = scratch("monitor-prune-");
    const registry = writeRegistry(dir, { deployBlock: 1000 });
    const now = 1_790_000_000;
    const chain = new FakeChain({ head: 20_000n, timestamp: now });
    const SERIES_CREATED = "event SeriesCreated(uint256 indexed longId, address indexed underlying, bool isPut, uint128 strike, uint40 expiry, address oracle, uint16 exerciseFeeBps, uint32 mintFeePpm)";
    const SERIES_SETTLED = "event SeriesSettled(uint256 indexed longId, uint256 settlementPrice, uint256 longPayoutPerUnit, uint256 feePerUnit, uint256 shortPayoutPerUnit)";
    for (let i = 0; i < 400; i += 1) {
      const E = now - (60 + (i % 120)) * 86_400; // every expiry is months past, all finalized and settled
      const longId = BigInt(i + 1) << 1n;
      chain.logs.push(rawLog(SERIES_CREATED, { longId, underlying: addr(0xa001), isPut: false, strike: BigInt(i), expiry: E, oracle: C.settlementOracle, exerciseFeeBps: 30, mintFeePpm: 80 }, { address: C.clearinghouse, blockNumber: 2000 + i }));
      chain.logs.push(rawLog(SERIES_SETTLED, { longId, settlementPrice: 1n, longPayoutPerUnit: 0n, feePerUnit: 0n, shortPayoutPerUnit: 0n }, { address: C.clearinghouse, blockNumber: 2000 + i, logIndex: 1 }));
    }
    const r = await runOnce(options(dir, registry), { viem: fakeViem(chain) });
    assert.equal(r.checks.scan.status, "ok", r.checks.scan.detail);
    assert.ok(chain.calls.maxInflightGetBlock <= 16, `${chain.calls.maxInflightGetBlock} getBlock requests in flight at once is a burst a rate-limited public RPC answers with 429s`);
    const state = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(Object.keys(state.scan.series).length, 0, "every one of these expiries is done and months old: none of it belongs in the state file");
    assert.deepEqual(state.scan.expiryDone, {}, "and no expiryDone key outlives its series");
  });

  // ops-c39: delivery is one POST per alert, and the relay forwards synchronously, so a rate-limited channel
  // takes only the first few of a burst. In check order an admin-key grant waited behind every warn condition.
  test("the worst alert of a burst is delivered first", async () => {
    let taken = 0;
    const received = [];
    const relay = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        if (taken >= 3) return void res.writeHead(502).end('{"ok":false}'); // a Discord burst limit, seen by the relay as every target refusing
        taken += 1;
        received.push(JSON.parse(body).kind);
        res.writeHead(200).end("{}");
      });
    });
    const port = await new Promise((resolve) => relay.listen(0, "127.0.0.1", () => resolve(relay.address().port)));
    try {
      const dir = scratch("monitor-burst-");
      const markets = [];
      for (let i = 1; i <= 12; i += 1) markets.push(market(`T${i}`, i, { pool: addr(0x9000 + i), floor: "1000" }));
      const registry = writeRegistry(dir, { markets, deployBlock: 1000 });
      const chain = new FakeChain({ head: 20_000n });
      chain.read = (address, fn, args) => (fn === "liquidity" ? 10n : defaultRead(chain, address, fn, args)); // every pool under its floor: 12 warns
      const opts = options(dir, registry, [], { ALERT_WEBHOOK: `http://127.0.0.1:${port}/alert`, ALERT_WEBHOOK_TOKEN: "k".repeat(40) });
      await runOnce(opts, { viem: fakeViem(chain) }); // first run adopts history and opens the pool conditions
      taken = 0;
      received.length = 0;
      chain.logs.push(rawLog(ROLE_GRANTED, { role: DEFAULT_ADMIN_ROLE, account: addr(0xbad), sender: addr(0xbad) }, { address: C.clearinghouse, blockNumber: 20_050 }));
      chain.setHead(20_100n, chain.head.timestamp + 10);
      const r = await runOnce(opts, { viem: fakeViem(chain) });
      assert.ok(r.sent.length > 3, `the burst must be bigger than the channel takes: ${r.sent.length}`);
      assert.equal(received[0], "v2_mon_config_changed", `the admin-role grant must go first, not behind the warn conditions: ${JSON.stringify(received)}`);
    } finally {
      relay.close();
    }
  });

  // ops-c40: liquidity() was compared with the floor with no hysteresis, so a pool resting on its floor paged
  // open/resolved/open/resolved. Mainnet swaps crossed the registry floors 34 times in 24 h on AAPL.
  test("a pool wobbling around its floor pages once, not once a pass", async () => {
    const received = [];
    const relay = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        received.push(JSON.parse(body).kind);
        res.writeHead(200).end("{}");
      });
    });
    const port = await new Promise((resolve) => relay.listen(0, "127.0.0.1", () => resolve(relay.address().port)));
    try {
      const dir = scratch("monitor-hysteresis-");
      const AAPL = market("AAPL", 1, { pool: addr(0x9001), floor: "1000" });
      const registry = writeRegistry(dir, { markets: [AAPL], deployBlock: 1000 });
      const chain = new FakeChain({ head: 20_000n });
      const wobble = [990n, 1010n, 995n, 1005n];
      let i = 0;
      chain.read = (address, fn, args) => (fn === "liquidity" ? wobble[i] : defaultRead(chain, address, fn, args));
      const opts = options(dir, registry, [], { ALERT_WEBHOOK: `http://127.0.0.1:${port}/alert`, ALERT_WEBHOOK_TOKEN: "k".repeat(40) });
      for (; i < wobble.length; i += 1) {
        await runOnce(opts, { viem: fakeViem(chain) });
        chain.setHead(chain.head.number + 600n, chain.head.timestamp + 60);
      }
      assert.deepEqual(received, [TVL_DARK, "v2_mon_pool_liquidity_low"], `one pool ±1 % around its floor over four passes: ${JSON.stringify(received)}`);
      const state = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
      assert.ok(state.alerts[`v2_mon_pool_liquidity_low:${addr(0x9001)}`] !== undefined, "and the condition stays open until liquidity clears the band");
    } finally {
      relay.close();
    }
  });

  /* ---- INTERFACE_VERSION 7, through the whole pass ---- */

  test("a MakerVault near its 24 h outflow cap pages from the vault check", async () => {
    const dir = scratch("monitor-outflow-");
    const registry = writeRegistry(dir, { deployBlock: 1000 });
    const chain = new FakeChain({ head: 20_000n });
    chain.read = (address, fn, args) => (fn === "outflow" ? [2_400_000_000n, 100_000_000n] : defaultRead(chain, address, fn, args));
    const r = await runOnce(options(dir, registry), { viem: fakeViem(chain) });
    assert.deepEqual(kindsOf(r), ["v2_mon_vault_outflow", TVL_DARK]);
    assert.equal(r.findings[0].severity, "error");
    assert.match(r.checks.vault.detail, /24 h outflow 2400\.00 used of 2500\.00/);
  });

  test("a live market registered with no writer rent pages", async () => {
    const dir = scratch("monitor-rent-zero-");
    const NVDA = market("NVDA", 1);
    const registry = writeRegistry(dir, { markets: [NVDA], deployBlock: 1000 });
    const chain = new FakeChain({ head: 20_000n });
    chain.read = (address, fn, args) => {
      if (fn === "market") return { enabled: true, mintPaused: false, strikeTick: 100n, exerciseFeeBps: 30, oracle: C.settlementOracle, mintFeePpm: 0 };
      return defaultRead(chain, address, fn, args);
    };
    const r = await runOnce(options(dir, registry), { viem: fakeViem(chain) });
    assert.ok(kindsOf(r).includes("v2_mon_mint_fee_zero"), `kinds: ${JSON.stringify(kindsOf(r))}`);
    const f = r.findings.find((x) => x.kind === "v2_mon_mint_fee_zero");
    assert.match(f.message, /80 ppm/, "the registry's own rate is quoted back in the alert");
    assert.match(r.checks.rent.detail, /NVDA 0 ppm/);
  });

  test("a settled series whose rent does not add up pages from the logs alone", async () => {
    const dir = scratch("monitor-rent-ledger-");
    const registry = writeRegistry(dir, { deployBlock: 1000 });
    const now = 1_790_000_000;
    const U2 = addr(0xa001);
    const longId = 84n;
    const chain = new FakeChain({ head: 20_000n, timestamp: now });
    const at = (n, i) => ({ address: C.clearinghouse, blockNumber: 5000 + n, logIndex: i });
    chain.logs.push(
      rawLog(
        "event SeriesCreated(uint256 indexed longId, address indexed underlying, bool isPut, uint128 strike, uint40 expiry, address oracle, uint16 exerciseFeeBps, uint32 mintFeePpm)",
        { longId, underlying: U2, isPut: false, strike: 1n, expiry: now - 3 * 86_400, oracle: C.settlementOracle, exerciseFeeBps: 30, mintFeePpm: 80 },
        at(0, 0),
      ),
      rawLog("event Minted(uint256 indexed longId, address indexed writer, address indexed longTo, uint64 units, uint256 collateral, uint256 fee)", { longId, writer: addr(0xf), longTo: addr(0xf), units: 100n, collateral: 10n ** 18n, fee: 1000n }, at(1, 0)),
      rawLog("event Closed(uint256 indexed longId, address indexed account, uint64 units, uint256 collateralFreed, uint256 feeRefund)", { longId, account: addr(0xf), units: 50n, collateralFreed: 10n ** 18n, feeRefund: 300n }, at(2, 0)),
      // The treasury took 690, not the 700 the charges and refunds leave behind.
      rawLog("event MintFeesAccrued(uint256 indexed longId, address indexed asset, uint256 amount)", { longId, asset: U2, amount: 690n }, at(3, 0)),
      rawLog("event SeriesSettled(uint256 indexed longId, uint256 settlementPrice, uint256 longPayoutPerUnit, uint256 feePerUnit, uint256 shortPayoutPerUnit)", { longId, settlementPrice: 1n, longPayoutPerUnit: 0n, feePerUnit: 0n, shortPayoutPerUnit: 0n }, at(3, 1)),
    );
    const r = await runOnce(options(dir, registry), { viem: fakeViem(chain) });
    assert.ok(kindsOf(r).includes("v2_mon_mint_rent"), `kinds: ${JSON.stringify(kindsOf(r))}`);
    const f = r.findings.find((x) => x.kind === "v2_mon_mint_rent");
    assert.equal(f.severity, "error");
    assert.match(f.message, /accrued 690 base units of writer rent, but its logs charged 1000 and refunded 300 \(expected 700\)/);
  });

  test("a roller ask the market overtook pages on the pass after the clock starts, and clears when it is cancelled", async () => {
    const dir = scratch("monitor-roller-");
    const registry = writeRegistry(dir, { markets: [market("NVDA", 1)], deployBlock: 1000 });
    const now = 1_790_000_000;
    const U2 = addr(0xa001);
    const W = addr(0xf);
    const expiry = now + 3 * 86_400;
    const chain = new FakeChain({ head: 20_000n, timestamp: now });
    chain.logs.push(
      rawLog("event Rolled(address indexed writer, address indexed underlying, uint256 longId, uint256 orderId, uint128 strike, uint40 expiry, uint128 price, uint64 units)", { writer: W, underlying: U2, longId: 84n, orderId: 7n, strike: 200_000_000n, expiry, price: 5n, units: 500n }, {
        address: C.autoRoller,
        blockNumber: 5000,
      }),
    );
    let live = true;
    chain.read = (address, fn, args) => {
      switch (fn) {
        case "position":
          return live ? [84n, 7n, expiry] : [84n, 0n, expiry];
        case "getOrders":
          return args[0].map(() => ({ maker: W, longId: 84n, kind: 2, price: 5n, units: 500n, filled: 0n, validUntil: expiry, cancelled: false }));
        case "series":
          return { underlying: U2, isPut: false, expiry: BigInt(expiry), strike: 200_000_000n, oracle: C.settlementOracle, exerciseFeeBps: 30, settled: false, settlementPrice: 0n, longPayoutPerUnit: 0n, feePerUnit: 0n, shortPayoutPerUnit: 0n, mintFeePpm: 80, mintFeesHeld: 0n };
        case "trySpot":
          return [true, 210_000_000n, BigInt(chain.head.timestamp)];
        default:
          return defaultRead(chain, address, fn, args);
      }
    };
    const opts = options(dir, registry);
    const r1 = await runOnce(opts, { viem: fakeViem(chain) });
    assert.deepEqual(kindsOf(r1), [TVL_DARK], "one pass over the strike is not evidence yet: nothing pages but the dark audit trigger");
    const s1 = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.deepEqual(s1.scan.rollerStale[`${W}:${U2}`], { orderId: "7", since: now });

    chain.setHead(20_100n, now + 120);
    const r2 = await runOnce(opts, { viem: fakeViem(chain) });
    assert.deepEqual(kindsOf(r2), ["v2_mon_roller_ask_overtaken", TVL_DARK]);
    assert.equal(r2.findings[0].severity, "error");
    assert.match(r2.findings[0].message, /NVDA \(call 200\.00, 5\.00 shares left.*at or past its strike for 2 min/);

    // The cranker cancels it: the ask is gone, the alert resolves, and the timer is dropped.
    live = false;
    chain.setHead(20_200n, now + 180);
    const r3 = await runOnce(opts, { viem: fakeViem(chain) });
    assert.deepEqual(kindsOf(r3), [TVL_DARK], "the roller page clears; the dark audit trigger is unrelated and stays");
    const s3 = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(s3.alerts[`v2_mon_roller_ask_overtaken:${W.toLowerCase()}:${U2.toLowerCase()}`], undefined, "the condition closes when the ask is gone");
    assert.deepEqual(s3.scan.rollerStale, {});
    assert.ok(s3.scan.roller[`${W.toLowerCase()}:${U2.toLowerCase()}`] !== undefined, "the position stays tracked until its expiry is long past");
  });

  // T-437. A setMarketOracle moves the market's pointer and leaves every series already created on the oracle
  // createSeries pinned into it, which is what cancelStale reads (T-310) and what the series settles on. Two series
  // under ONE underlying can therefore be judged on two different oracles in one pass. A monitor reading the
  // registry's published SettlementOracle (or the market's pointer) judges both on a price the contract does not use,
  // and never pages for the in-the-money ask left resting.
  test("T-437: two series on one underlying with different pinned oracles are each judged on their own", async () => {
    const dir = scratch("monitor-roller-oracles-");
    const registry = writeRegistry(dir, { markets: [market("NVDA", 1)], deployBlock: 1000 });
    const now = 1_790_000_000;
    const U2 = addr(0xa001);
    const W1 = addr(0xf1);
    const W2 = addr(0xf2);
    const ORACLE_A = addr(0x0ec1);
    const ORACLE_B = addr(0x0ec2);
    const expiry = now + 3 * 86_400;
    const ROLLED =
      "event Rolled(address indexed writer, address indexed underlying, uint256 longId, uint256 orderId, uint128 strike, uint40 expiry, uint128 price, uint64 units)";
    const chain = new FakeChain({ head: 20_000n, timestamp: now });
    [
      [W1, 84n, 7n, 0],
      [W2, 85n, 8n, 1],
    ].forEach(([w, longId, orderId, logIndex]) => {
      chain.logs.push(
        rawLog(ROLLED, { writer: w, underlying: U2, longId, orderId, strike: 200_000_000n, expiry, price: 5n, units: 500n }, { address: C.autoRoller, blockNumber: 5000, logIndex }),
      );
    });

    /** Every oracle address a trySpot was sent to, lower-case. */
    const asked = [];
    chain.read = (address, fn, args) => {
      switch (fn) {
        case "position":
          return String(args[0]).toLowerCase() === W1.toLowerCase() ? [84n, 7n, expiry] : [85n, 8n, expiry];
        case "getOrders":
          return args[0].map((id) => ({ maker: id === 7n ? W1 : W2, longId: id === 7n ? 84n : 85n, kind: 2, price: 5n, units: 500n, filled: 0n, validUntil: expiry, cancelled: false }));
        case "series":
          return {
            underlying: U2,
            isPut: false,
            expiry: BigInt(expiry),
            strike: 200_000_000n,
            // Series 84 kept oracle A; series 85 was created later on oracle B. Neither is the published one.
            oracle: args[0] === 84n ? ORACLE_A : ORACLE_B,
            exerciseFeeBps: 30,
            settled: false,
            settlementPrice: 0n,
            longPayoutPerUnit: 0n,
            feePerUnit: 0n,
            shortPayoutPerUnit: 0n,
            mintFeePpm: 80,
            mintFeesHeld: 0n,
          };
        case "trySpot": {
          const who = String(address).toLowerCase();
          asked.push(who);
          // A is past the 200.00 strike, B is short of it. Anything else - the published oracle, the market's
          // pointer - answers short too, so reading one of those pages for neither writer.
          return [true, who === ORACLE_A.toLowerCase() ? 210_000_000n : 190_000_000n, BigInt(chain.head.timestamp)];
        }
        default:
          return defaultRead(chain, address, fn, args);
      }
    };

    const opts = options(dir, registry);
    await runOnce(opts, { viem: fakeViem(chain) });
    assert.deepEqual([...new Set(asked)].sort(), [ORACLE_A.toLowerCase(), ORACLE_B.toLowerCase()].sort(), "one trySpot per pinned series oracle");
    assert.ok(!asked.includes(String(C.settlementOracle).toLowerCase()), "the registry's published oracle is not a spot source for an existing series");
    const s1 = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.deepEqual(
      Object.keys(s1.scan.rollerStale),
      [`${W1.toLowerCase()}:${U2.toLowerCase()}`],
      "only the series whose OWN oracle has overtaken it starts the clock",
    );

    chain.setHead(20_100n, now + 120);
    const r2 = await runOnce(opts, { viem: fakeViem(chain) });
    // Only this page's findings: the rest of the pass is another check's business and not what is pinned here.
    const roller = r2.findings.filter((f) => f.kind.startsWith("v2_mon_roller"));
    assert.deepEqual(roller.map((f) => f.kind), ["v2_mon_roller_ask_overtaken"], "one page, not two and not none");
    assert.equal(roller[0].id, `v2_mon_roller_ask_overtaken:${W1.toLowerCase()}:${U2.toLowerCase()}`, "and it names the writer whose series oracle overtook it");
    assert.match(roller[0].message, /spot 210\.00/, "the price it judged on is oracle A's, the one series 84 pinned - not B's 190.00 and not the published oracle's");
  });
});

/* -------------------------------------------------------------------------------------------------
 * The always-on loop, as a real child process.
 * ------------------------------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------------------------------
 * T-OP-090. AutoRoller.Repriced: the PRICER lane moving a writer's ask. T-OP-063 capped each reprice to a
 * MAX_REPRICE_DROP_BPS drop so a leaked key needs several calls to reach the floor, and the contract NatSpec
 * (AutoRoller.sol:134) promises each one pages. The scan remembers the ask each roll rested and each reprice set;
 * repriceFindings judges every new reprice against the price it replaced (floor-ward step) and against the
 * registry pricer key (foreign sender), and warns the rest at a rate cap. Nothing typed in: the signature is the
 * ABI's, the cap is the contract's mirrored constant, the key is the registry's.
 * ------------------------------------------------------------------------------------------------- */
describe("T-OP-090: AutoRoller.Repriced pages a floor-ward step and a foreign sender, warns the rest at a cap", () => {
  const ROLLER = "0x1111111111111111111111111111111111111a07";
  const PRICER = "0x00000000000000000000000000000000000000c1";
  const OTHER = "0x00000000000000000000000000000000000000c2";
  const WRITER = "0x00000000000000000000000000000000000000d1";
  const addresses = { ...v6addresses, autoRoller: ROLLER };
  const tickerOf = (a) => (a.toLowerCase() === U.toLowerCase() ? "NVDA" : "OTHER");
  let n = 0;
  const log = (eventName, args, over = {}) => {
    n += 1;
    return { eventName, address: ROLLER, args, blockNumber: 1000n + BigInt(n), transactionHash: `0x${String(0xa000 + n).padStart(64, "0")}`, logIndex: 0, ...over };
  };
  const rolled = (price) => log("Rolled", { writer: WRITER, underlying: U, longId: 7n, orderId: 100n, strike: 230_000_000n, expiry: 1_800_000_000n, price, units: 10n });
  const repriced = (price, over = {}) => log("Repriced", { writer: WRITER, underlying: U, oldOrderId: 100n, newOrderId: 101n, price }, over);
  const senderOf = (events, from) => new Map(events.map((e) => [e.transactionHash.toLowerCase(), from]));
  const ctx = (events, from = PRICER, over = {}) => ({ t: DEFAULTS, pricerKey: PRICER, senders: senderOf(events, from), tickerOf, ...over });
  const fresh = () => ({ series: {}, expiryDone: {}, rentAt: null });

  test("the scan signature is the ABI's Repriced, and the cap mirrors AutoRoller.MAX_REPRICE_DROP_BPS", () => {
    const abi = JSON.parse(readFileSync(path.join(ABIS, "AutoRoller.json"), "utf8"));
    const ev = abi.find((x) => x.type === "event" && x.name === "Repriced");
    const sig = `Repriced(${ev.inputs.map((i) => `${i.type}${i.indexed ? " indexed" : ""} ${i.name}`).join(", ")})`;
    assert.ok(SCAN_EVENTS.includes(`event ${sig}`), `SCAN_EVENTS carries the ABI's ${sig}`);
    assert.ok(DEDICATED_EVENTS.has("Repriced"), "Repriced has its own kinds, so v2_mon_config_changed never pages it");
    assert.equal(MAX_REPRICE_DROP_BPS, 2_500);
  });

  test("fold: a roll remembers the ask, a reprice is collected with the price it replaced and then remembers its own", () => {
    const scan = fresh();
    const r1 = repriced(2_000_000n);
    const out = applyScanLogs(scan, [rolled(2_500_000n), r1], addresses);
    assert.equal(out.length, 1);
    assert.equal(out[0].eventName, "Repriced");
    assert.equal(out[0].priceBefore, "2500000", "the roll's ask is what the reprice replaced");
    assert.equal(scan.roller[`${WRITER.toLowerCase()}:${U.toLowerCase()}`].p, "2000000", "the reprice is now the remembered ask");
    const r2 = repriced(1_900_000n);
    assert.equal(applyScanLogs(scan, [r2], addresses)[0].priceBefore, "2000000", "the second reprice sees the first");
    // The REORG_OVERLAP replay of an already-counted log neither re-collects it nor moves the remembered ask.
    assert.deepEqual(applyScanLogs(scan, [r2], addresses), []);
    assert.equal(scan.roller[`${WRITER.toLowerCase()}:${U.toLowerCase()}`].p, "1900000");
    // A reprice for a position the scan never saw rolled is collected with no prior price.
    const orphan = log("Repriced", { writer: OTHER, underlying: U, oldOrderId: 5n, newOrderId: 6n, price: 1_000_000n });
    assert.equal(applyScanLogs(scan, [orphan], addresses)[0].priceBefore, null);
    // Not from the AutoRoller: ignored.
    assert.deepEqual(applyScanLogs(fresh(), [repriced(1n, { address: V6.BOOK })], addresses), []);
  });

  test("(a) a floor-ward step pages: the drop is at least the fraction of the per-call cap; a small move does not", () => {
    // 20 % of the ask in one call = 0.8 x the 25 % cap: the boundary, inclusive.
    const step = repriced(2_000_000n, { priceBefore: "2500000" });
    const out = repriceFindings([step], "100", ctx([step]));
    assert.deepEqual(kinds(out), ["v2_mon_reprice_floorward/error"]);
    assert.equal(out[0].event, true);
    assert.equal(out[0].key, `${step.transactionHash.toLowerCase()}:0`);
    assert.match(out[0].message, /2\.50 -> 2\.00 \(-20 %\).*sender is the registry pricer key/);
    // Just under the boundary: an ordinary warn.
    const small = repriced(2_000_001n, { priceBefore: "2500000" });
    assert.deepEqual(kinds(repriceFindings([small], "100", ctx([small]))), ["v2_mon_repriced/warn"]);
    // A raise is never floor-ward.
    const up = repriced(2_600_000n, { priceBefore: "2500000" });
    assert.deepEqual(kinds(repriceFindings([up], "100", ctx([up]))), ["v2_mon_repriced/warn"]);
    // No prior price: the drop cannot be judged, the warn says so.
    const unknown = repriced(1n, { priceBefore: null });
    const u = repriceFindings([unknown], "100", ctx([unknown]));
    assert.deepEqual(kinds(u), ["v2_mon_repriced/warn"]);
    assert.match(u[0].message, /ask the scan never saw/);
    // The fraction is a threshold: at 1 only a maximal (25 %) step pages.
    assert.deepEqual(kinds(repriceFindings([step], "100", ctx([step], PRICER, { t: { ...DEFAULTS, repricePageDropFraction: 1 } }))), ["v2_mon_repriced/warn"]);
    const maximal = repriced(1_875_000n, { priceBefore: "2500000" });
    assert.deepEqual(kinds(repriceFindings([maximal], "100", ctx([maximal], PRICER, { t: { ...DEFAULTS, repricePageDropFraction: 1 } }))), ["v2_mon_reprice_floorward/error"]);
  });

  test("(b) a foreign sender pages, with or without a floor-ward step; an unknown sender or no pricer key is said, not assumed", () => {
    const e = repriced(2_490_000n, { priceBefore: "2500000" });
    const out = repriceFindings([e], "100", ctx([e], OTHER));
    assert.deepEqual(kinds(out), ["v2_mon_reprice_foreign_sender/error"]);
    assert.match(out[0].message, new RegExp(`sent by ${OTHER}, which is NOT the registry pricer key ${PRICER}`));
    assert.equal(out[0].data.sender, OTHER);
    // Both at once: two pages, one key each.
    const both = repriced(1_900_000n, { priceBefore: "2500000" });
    const two = repriceFindings([both], "100", ctx([both], OTHER));
    assert.deepEqual(kinds(two), ["v2_mon_reprice_floorward/error", "v2_mon_reprice_foreign_sender/error"]);
    assert.match(two.find((f) => f.kind === "v2_mon_reprice_floorward").message, /sender is foreign/);
    // Sender lookup failed: not foreign, and the warn says the sender could not be read.
    const unread = repriceFindings([e], "100", ctx([e], null));
    assert.deepEqual(kinds(unread), ["v2_mon_repriced/warn"]);
    assert.match(unread[0].message, /sender could not be read/);
    // No pricer key in the registry: the condition is not judged.
    const nokey = repriceFindings([e], "100", ctx([e], OTHER, { pricerKey: null }));
    assert.deepEqual(kinds(nokey), ["v2_mon_repriced/warn"]);
    assert.match(nokey[0].message, /no pricer key in the registry/);
  });

  test("(c) a normal pricer reprice is quiet: one warn, no page; adopted history is silent", () => {
    const e = repriced(2_480_000n, { priceBefore: "2500000" });
    const out = repriceFindings([e], "100", ctx([e]));
    assert.deepEqual(kinds(out), ["v2_mon_repriced/warn"]);
    assert.match(out[0].message, /2\.50 -> 2\.48 \(-0\.8 %\); sent by the registry pricer key/);
    assert.deepEqual(repriceFindings([repriced(2_480_000n, { priceBefore: "2500000", blockNumber: 100n })], "100", ctx([e])), [], "at or before adoptUntil is adopted");
  });

  test("the warn is rate-capped: repriceWarnCap individually, then one summary; pages are never capped", () => {
    const events = [];
    for (let i = 0; i < 6; i++) events.push(repriced(2_490_000n - BigInt(i), { priceBefore: "2500000" }));
    const out = repriceFindings(events, "100", ctx(events));
    const warns = out.filter((f) => f.kind === "v2_mon_repriced");
    assert.equal(warns.length, DEFAULTS.repriceWarnCap + 1, "cap individual warns plus one summary");
    const summary = warns[warns.length - 1];
    assert.match(summary.message, /3 more AutoRoller\.Repriced in this run \(NVDA\).*capped at 3 per run/);
    assert.equal(summary.data.count, 3);
    assert.ok(summary.key.endsWith(":summary"));
    // Six floor-ward steps: six pages, no cap.
    const steps = events.map((e) => ({ ...e, args: { ...e.args, price: 1_900_000n } }));
    assert.equal(repriceFindings(steps, "100", ctx(steps)).filter((f) => f.kind === "v2_mon_reprice_floorward").length, 6);
    // The cap is a threshold.
    assert.equal(repriceFindings(events, "100", ctx(events, PRICER, { t: { ...DEFAULTS, repriceWarnCap: 10 } })).length, 6);
  });
});

/* -------------------------------------------------------------------------------------------------
 * T-OP-083. The issuer's OraclePaused() / OracleUnpaused() LOGS on the launch tokens page v2_mon_oracle_halted
 * (error) and clear themselves. The per-poll oraclePaused() flag (v2_mon_oracle_paused, warn) cannot see a halt
 * that starts and ends between two polls; the log can. The topics are derived from the event signatures with
 * viem, never typed; the addresses come from the registry rows named by --launch, never typed.
 * ------------------------------------------------------------------------------------------------- */
describe("T-OP-083: the launch tokens' OraclePaused() log pages and clears itself", () => {
  const dirs = [];
  const scratch = (prefix) => {
    const d = tmp(prefix);
    dirs.push(d);
    return d;
  };
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const topics = oracleHaltTopics(viem);
  const halted = (token, blockNumber, logIndex = 0) => rawLog("event OraclePaused()", {}, { address: token, blockNumber, logIndex });
  const unhalted = (token, blockNumber, logIndex = 0) => rawLog("event OracleUnpaused()", {}, { address: token, blockNumber, logIndex });
  const tickerOf = (a) => (a.toLowerCase() === addr(0xa1).toLowerCase() ? "NVDA" : a.toLowerCase() === addr(0xa2).toLowerCase() ? "SPCX" : "OTHER");

  test("the topics are the keccak of the two IOraclePausable signatures", () => {
    // Re-derived, and pinned to what ops/abis/StockToken.json records as _topic0 for the same two events.
    assert.equal(topics.paused, "0xe28b7053f432ae5400c6168140cbe15638399715519a0a39b16b505fb9fc9d9a");
    assert.equal(topics.unpaused, "0xa274116fec684497d55e11cc9516edaa8d206c8b5f84c4603e32572c37f8e6dd");
    assert.equal(topics.paused, viem.keccak256(viem.toHex("OraclePaused()")));
  });

  test("fold: OraclePaused opens, OracleUnpaused closes, chain order wins over arrival order, replay is idempotent", () => {
    const nvda = addr(0xa1);
    const halts = {};
    // Arrival order reversed on purpose: the unpause at block 120 arrives before the pause at block 100.
    applyOracleHaltLogs(halts, [unhalted(nvda, 120), halted(nvda, 100)], tickerOf, topics);
    assert.deepEqual(halts, {}, "pause then unpause, in chain order, leaves no halt open");
    applyOracleHaltLogs(halts, [halted(nvda, 130)], tickerOf, topics);
    assert.equal(halts[nvda.toLowerCase()].block, "130");
    assert.equal(halts[nvda.toLowerCase()].ticker, "NVDA");
    applyOracleHaltLogs(halts, [halted(nvda, 130)], tickerOf, topics); // the REORG_OVERLAP replay
    assert.equal(halts[nvda.toLowerCase()].block, "130", "a replayed pause changes nothing");
    // A log with a foreign topic on the same address (the fake chain returns every log for an address) is ignored.
    const other = rawLog("event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)", { oldMultiplier: 1n, newMultiplier: 2n, effectiveAtTimestamp: 3n }, { address: nvda, blockNumber: 140 });
    applyOracleHaltLogs(halts, [other], tickerOf, topics);
    assert.equal(halts[nvda.toLowerCase()].block, "130");
  });

  test("findings: one error per launch token with an open halt; a non-launch token's halt is kept but never paged", () => {
    const nvda = addr(0xa1);
    const tsla = addr(0xa3);
    const halts = applyOracleHaltLogs({}, [halted(nvda, 100), halted(tsla, 101)], tickerOf, topics);
    const out = oracleHaltFindings(halts, [nvda]);
    assert.deepEqual(out.map((f) => [f.kind, f.severity, f.key]), [["v2_mon_oracle_halted", "error", nvda.toLowerCase()]]);
    assert.match(out[0].message, /NVDA OraclePaused\(\) at block 100/);
    assert.match(out[0].message, /veto a pool-only candidate/);
    assert.deepEqual(oracleHaltFindings(applyOracleHaltLogs(halts, [unhalted(nvda, 102)], tickerOf, topics), [nvda]), [], "clears on OracleUnpaused");
  });

  test("a pass: fires on the NVDA log, clears on the unpause, ignores a third token, and never scans below the deploy block", async () => {
    const dir = scratch("monitor-halt-");
    const NVDA = market("NVDA", 1);
    const SPCX = market("SPCX", 2);
    const TSLA = market("TSLA", 3);
    const registry = writeRegistry(dir, { markets: [NVDA, SPCX, TSLA], deployBlock: 1000 });
    const chain = new FakeChain({ head: 20_000n });
    const seen = [];
    chain.getLogsHook = ({ from, event }) => {
      if (event?.name === "OraclePaused" || event?.name === "OracleUnpaused") seen.push({ name: event.name, from: from.toString() });
    };
    // Below the deploy block: a halt log the bounded scan must never see (the "unbounded eth_getLogs" defect T-OP-009 is about).
    chain.tokenLogs.push(halted(NVDA.asset, 500));
    // A third, non-launch token halts: not the launch set, not a page.
    chain.tokenLogs.push(halted(TSLA.asset, 15_000));
    const opts = options(dir, registry, ["--launch", "NVDA,SPCX"]);

    const r1 = await runOnce(opts, { viem: fakeViem(chain) });
    assert.ok(seen.length >= 2, `both halt events were scanned: ${JSON.stringify(seen)}`);
    assert.ok(seen.every((x) => BigInt(x.from) >= 1000n), `every halt scan starts at or above the deploy block: ${JSON.stringify(seen)}`);
    assert.ok(!kindsOf(r1).includes("v2_mon_oracle_halted"), `no page from a pre-deploy log or a third token: ${JSON.stringify(kindsOf(r1))}`);
    assert.equal(r1.checks.tokens.status, "ok");
    assert.match(r1.checks.tokens.detail, /OraclePaused\/OracleUnpaused log\(s\) for NVDA, SPCX/);

    // THE PAGE: NVDA halts between two polls of oraclePaused() (the flag reads false at both), the log is enough.
    chain.tokenLogs.push(halted(NVDA.asset, 20_100));
    chain.setHead(20_200n, chain.head.timestamp + 60);
    const r2 = await runOnce(opts, { viem: fakeViem(chain) });
    const page = r2.findings.filter((f) => f.kind === "v2_mon_oracle_halted");
    assert.equal(page.length, 1, `one page for NVDA: ${JSON.stringify(kindsOf(r2))}`);
    assert.equal(page[0].id, `v2_mon_oracle_halted:${NVDA.asset.toLowerCase()}`, "keyed by the token, so one page per halt");
    assert.equal(page[0].severity, "error");
    assert.match(page[0].message, /NVDA OraclePaused\(\) at block 20100/);

    // Still halted next run: the same page stays open (dedupe), no second copy.
    chain.setHead(20_300n, chain.head.timestamp + 60);
    const r3 = await runOnce(opts, { viem: fakeViem(chain) });
    assert.equal(r3.findings.filter((f) => f.kind === "v2_mon_oracle_halted").length, 1, "the halt stays reported while it lasts");

    // THE CLEAR: OracleUnpaused lands; the finding is gone and the state no longer carries the halt.
    chain.tokenLogs.push(unhalted(NVDA.asset, 20_350));
    chain.setHead(20_400n, chain.head.timestamp + 60);
    const r4 = await runOnce(opts, { viem: fakeViem(chain) });
    assert.ok(!kindsOf(r4).includes("v2_mon_oracle_halted"), `cleared: ${JSON.stringify(kindsOf(r4))}`);
    const state = JSON.parse(readFileSync(opts.state, "utf8"));
    assert.equal(state.alerts[`v2_mon_oracle_halted:${NVDA.asset.toLowerCase()}`], undefined, "the open page is gone from the dedupe store (it resolves)");
    assert.deepEqual(state.tokens.oracleHalts, {}, "no halt left in state");
    assert.equal(state.tokens.haltCursor, "20400", "the halt cursor reached the head");
  });

  test("a launch ticker the registry does not carry is named, not guessed", async () => {
    const dir = scratch("monitor-halt-missing-");
    const NVDA = market("NVDA", 1);
    const registry = writeRegistry(dir, { markets: [NVDA], deployBlock: 1000 });
    const chain = new FakeChain({ head: 20_000n });
    const r = await runOnce(options(dir, registry, ["--launch", "NVDA,SPCX"]), { viem: fakeViem(chain) });
    assert.equal(r.checks.tokens.status, "ok");
    assert.match(r.checks.tokens.detail, /not in the registry: SPCX/);
  });
});

describe("the --interval loop", () => {
  const MONITOR = fileURLToPath(new URL("./monitor.mjs", import.meta.url));
  let dir;
  let relay;
  let relayStatus = 502;
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), "monitor-loop-"));
    relay = createServer((req, res) => {
      req.resume();
      req.on("end", () => res.writeHead(relayStatus, { "content-type": "application/json" }).end(relayStatus === 200 ? '{"ok":true}' : '{"ok":false,"error":"all targets refused"}'));
    });
  });
  after(() => {
    relay.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const loop = async (args) => {
    const relayPort = relay.listening ? relay.address().port : await listen(relay);
    const registry = path.join(dir, "registry.json");
    writeFileSync(registry, JSON.stringify({ shared: { chainId: 4663 }, v2: { contracts: {} }, markets: [] }));
    const child = spawn(process.execPath, [MONITOR, "--rpc", "http://127.0.0.1:1", "--registry", registry, "--state", path.join(dir, `state-${args.join("")}.json`), ...args], {
      env: { ...process.env, ALERT_WEBHOOK: `http://127.0.0.1:${relayPort}/alert` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    return { child, output: () => out, exit: new Promise((resolve) => child.on("exit", (c) => resolve(c))) };
  };

  // ops-c05: a relay that refuses every page gives exit 4 on every pass. The loop used to ignore that and
  // run on for ever, so nothing outside the process ever learnt the monitor was mute (ops/alerts.md §V14
  // names a failed run as the only out-of-band sign).
  test("gives up with the pass's own exit code after --max-failed-passes passes that reached nobody", async () => {
    relayStatus = 502;
    const { output, exit } = await loop(["--interval", "5", "--max-failed-passes", "2"]);
    const code = await exit;
    const out = output();
    assert.equal(code, 4, `the loop must exit 4, not run on. Output:\n${out}`);
    assert.equal((out.match(/exit 4$/gm) ?? []).length, 2, `exactly two passes before giving up. Output:\n${out}`);
    assert.match(out, /2 consecutive passes reached nobody \(exit 4\)/);
  });

  // The other half: the first runs after a deploy exit 3 while the log scan catches up, but they do page.
  // Those must never trip the give-up, or the service would crash-loop through its own first scan.
  test("passes that exit 3 but delivered their alert do not count", async () => {
    relayStatus = 200;
    const { child, output, exit } = await loop(["--interval", "5", "--max-failed-passes", "1"]);
    await new Promise((r) => setTimeout(r, 7000));
    const alive = child.exitCode === null;
    child.kill("SIGTERM");
    const code = await exit;
    const out = output();
    assert.ok(alive, `the loop must still be running after two delivered exit-3 passes. Output:\n${out}`);
    assert.ok((out.match(/exit 3$/gm) ?? []).length >= 2, `at least two passes. Output:\n${out}`);
    assert.equal(code, 0);
  });
});

/* -------------------------------------------------------------------------------------------------
 * F3 O3-304: priceability, source clocks, provider/method switches and pricer work.
 *
 * Every input here is a fixture: the bodies the pricing service and the pricer serve TODAY
 * (keeper/src/v2/pricing/server.ts, keeper/src/v2/pricer/pricer.ts state()), plus the additive §5.1
 * `provenance` object no build emits yet, to prove the monitor reads it when one does and never
 * requires it. No network: the pure checks take the parsed bodies, and the one whole-pass test serves
 * them from a local http server on 127.0.0.1.
 * ------------------------------------------------------------------------------------------------- */
describe("F3: quote readiness, per tenor (O3-304)", () => {
  // A Thursday close is a daily; the Friday that ends its week is that week's weekly.
  const DAILY = closeOfDay(Math.floor(Date.UTC(2026, 8, 17) / 86_400_000));
  const DAILY2 = closeOfDay(Math.floor(Date.UTC(2026, 8, 16) / 86_400_000));
  const WEEKLY = closeOfDay(Math.floor(Date.UTC(2026, 8, 18) / 86_400_000));
  const NEXT_WEEKLY = closeOfDay(Math.floor(Date.UTC(2026, 8, 25) / 86_400_000));

  const ok = (expiry) => ({ expiry, status: "ok" });
  const probe = (expiry, over = {}) =>
    readFairAnswer(200, { fair: { raw: "120000", decimals: 6, formatted: "0.12" }, source: "cboe", spot: { raw: "1", decimals: 6, formatted: "0" }, asOf: expiry - 3600, ...over });
  const withSeries = (p, expiry, side = "call") => ({ ...p, expiry, side, strike: "231.00" });

  const market = (over = {}) => ({
    ticker: "NVDA",
    chain: { named: true, usable: "ok", error: null },
    surface: { ok: true, reason: null, expiries: [ok(DAILY), ok(WEEKLY), ok(NEXT_WEEKLY)] },
    seriesExpiries: [DAILY, WEEKLY],
    probes: [withSeries(probe(DAILY), DAILY), withSeries(probe(WEEKLY), WEEKLY)],
    ...over,
  });

  test("every expiry and every probed series priceable: nothing pages, and both tenors report ready", () => {
    const r = checkQuoteReadiness(market());
    assert.deepEqual(r.findings, []);
    assert.deepEqual(
      r.rows.map((x) => `${x.tenor}/${x.ready}`).sort(),
      ["daily/true", "weekly/true"],
    );
  });

  test("a daily that fails while the weeklies pass pages under its OWN key; the weekly stays silent", () => {
    const r = checkQuoteReadiness(
      market({
        surface: { ok: true, reason: null, expiries: [{ expiry: DAILY, status: "no-quotes" }, ok(WEEKLY), ok(NEXT_WEEKLY)] },
      }),
    );
    assert.deepEqual(
      r.findings.map((f) => `${f.kind}:${f.key}`),
      ["v2_mon_quote_unready:NVDA:daily"],
      "the weekly must not page and must not absorb the daily",
    );
    assert.match(r.findings[0].message, /another tenor pricing does not make it ready/);
    assert.deepEqual(r.findings[0].data.reasons, ["no-quotes"]);
    const rows = Object.fromEntries(r.rows.map((x) => [x.tenor, x.ready]));
    assert.deepEqual(rows, { daily: false, weekly: true }, "a weekly pass is never a market pass");
  });

  test("a daily expiry a live series settles on that the provider does not list at all is that tenor's failure, not a silence", () => {
    const r = checkQuoteReadiness(
      market({
        // The provider lists only the weeklies; the daily the series settles on is simply absent.
        surface: { ok: true, reason: null, expiries: [ok(WEEKLY), ok(NEXT_WEEKLY)] },
        seriesExpiries: [DAILY, WEEKLY],
        probes: [withSeries(probe(WEEKLY), WEEKLY)],
      }),
    );
    assert.deepEqual(r.findings.map((f) => f.key), ["NVDA:daily"]);
    assert.deepEqual(r.findings[0].data.reasons, ["expiry-not-listed"]);
    assert.match(r.findings[0].data.failing[0], /a live series settles on it/);
  });

  test("a reason code this build does not know is NOT ready and pages on its own (§5.1)", () => {
    const r = checkQuoteReadiness(
      market({
        probes: [withSeries(probe(DAILY, { fair: null, reason: "vendor-rate-limited" }), DAILY), withSeries(probe(WEEKLY), WEEKLY)],
      }),
    );
    assert.deepEqual(r.findings.map((f) => f.kind).sort(), ["v2_mon_pricing_reason_unknown", "v2_mon_quote_unready"]);
    const unknown = r.findings.find((f) => f.kind === "v2_mon_pricing_reason_unknown");
    assert.deepEqual(unknown.data.codes, ["vendor-rate-limited"]);
    assert.equal(r.rows.find((x) => x.tenor === "daily").ready, false, "an unknown code counts as not ready");
    assert.deepEqual(unknownPricingReasons(["no-quotes", "quote-age-unknown", "made-up"]), ["made-up"]);
  });

  test("§5.1 provenance is read when a build serves it and never required: a degraded readiness and a stated reason are both not ready", () => {
    const degraded = withSeries(
      probe(DAILY, { provenance: { provider: "cboe-delayed", method: "extrapolated", quality: { readiness: "degraded", reasons: ["quote-age-unknown", "extrapolated"] } } }),
      DAILY,
    );
    const r = checkQuoteReadiness(market({ probes: [degraded, withSeries(probe(WEEKLY), WEEKLY)] }));
    assert.deepEqual(r.findings.map((f) => f.key), ["NVDA:daily"]);
    assert.deepEqual(r.findings[0].data.reasons, ["quote-age-unknown", "extrapolated"]);
    // The same body without provenance is judged on the legacy fields alone and passes.
    assert.deepEqual(checkQuoteReadiness(market()).findings, []);
  });

  test("a zero fair is a price, a null fair is a refusal (§5.1: neither is ever encoded as the other)", () => {
    const zero = readFairAnswer(200, { fair: { raw: "0", decimals: 6, formatted: "0" }, source: "model", asOf: DAILY });
    assert.equal(zero.answered, true);
    assert.equal(zero.ok, true, "a zero estimate is an estimate");
    const none = readFairAnswer(200, { fair: null, reason: "no-quotes", detail: {} });
    assert.deepEqual([none.answered, none.ok, none.reason], [true, false, "no-quotes"]);
    const unknownTicker = readFairAnswer(404, { fair: null, reason: "unknown-ticker" });
    assert.equal(unknownTicker.answered, true, "404 unknown-ticker is an answer about the data");
    for (const status of [400, 500, 502, 0]) {
      assert.equal(readFairAnswer(status, { fair: null, reason: "internal-error" }).answered, false, `HTTP ${status} says nothing about priceability`);
    }
    assert.equal(readFairAnswer(200, null).answered, false, "a body that is not JSON is not an answer");
  });

  test("a chain the service refuses refuses every series of that market, whatever /health's process status says", () => {
    const r = checkQuoteReadiness(market({ chain: { named: true, usable: "chain-stale", error: null } }));
    assert.deepEqual(r.findings.map((f) => `${f.kind}:${f.key}`), ["v2_mon_quote_unready:NVDA"]);
    assert.equal(r.findings[0].data.scope, "market");
    assert.match(r.findings[0].message, /whatever the process's \/health says/);
    const missing = checkQuoteReadiness(market({ chain: { named: false, usable: "ok", error: null } }));
    assert.equal(missing.findings[0].data.reason, "unknown-ticker");
  });

  test("a transport failure on a probe is never priceability: it is left out of the readiness count", () => {
    const dead = { ...readFairAnswer(0, null), expiry: DAILY, side: "call", strike: "231.00" };
    const r = checkQuoteReadiness(market({ probes: [dead, withSeries(probe(WEEKLY), WEEKLY)] }));
    assert.deepEqual(r.findings, [], "a probe that never reached the service does not make a series unready");
    assert.equal(r.rows.find((x) => x.tenor === "daily").series, 0);
  });

  test("the tenor of a close: the last session of its Monday-Friday week is the weekly", () => {
    assert.equal(expiryTenor(WEEKLY), "weekly", "Friday 18 September 2026");
    assert.equal(expiryTenor(DAILY), "daily", "Thursday 17 September 2026");
    assert.equal(expiryTenor(DAILY2), "daily", "Wednesday 16 September 2026");
    // Thanksgiving week 2026: the NYSE shuts Thursday 26 November, so Friday still ends the week.
    const thanksgiving = closeOfDay(Math.floor(Date.UTC(2026, 10, 26) / 86_400_000));
    assert.equal(expiryTenor(thanksgiving), "daily", "a full holiday is never a weekly");
    assert.equal(expiryTenor(closeOfDay(Math.floor(Date.UTC(2026, 10, 27) / 86_400_000))), "weekly");
    // Good Friday 2026 (3 April) is shut, so Thursday 2 April ends that week.
    assert.equal(expiryTenor(closeOfDay(Math.floor(Date.UTC(2026, 3, 2) / 86_400_000))), "weekly");
  });

  test("probes are bounded, daily-first and round-robin, so one market's weeklies cannot crowd out another's daily", () => {
    const series = [
      { longId: "1", ticker: "NVDA", expiry: NEXT_WEEKLY, side: "call", strike: "300000000" },
      { longId: "2", ticker: "NVDA", expiry: WEEKLY, side: "call", strike: "200000000" },
      { longId: "3", ticker: "NVDA", expiry: DAILY, side: "call", strike: "100000000" },
      { longId: "4", ticker: "TSLA", expiry: WEEKLY, side: "put", strike: "400000000" },
      { longId: "5", ticker: "TSLA", expiry: DAILY, side: "call", strike: "500000000" },
      { longId: "6", ticker: "TSLA", expiry: DAILY2, side: "call", strike: "600000000" },
    ];
    const now = DAILY2 - 86_400;
    assert.deepEqual(
      probeTargets(series, now, 2).map((s) => `${s.ticker}/${s.tenor}/${s.longId}`),
      ["NVDA/daily/3", "TSLA/daily/6"],
      "with a budget of two, both markets get their nearest daily",
    );
    assert.deepEqual(probeTargets(series, now, 4).map((s) => s.longId), ["3", "6", "2", "5"]);
    assert.deepEqual(probeTargets(series, now, 99).length, 6);
    assert.deepEqual(probeTargets(series, now, 0), []);
    // An expired series is never probed: /fair would refuse it `expired` and teach nobody anything.
    assert.deepEqual(probeTargets(series, NEXT_WEEKLY, 99), []);
  });
});

describe("F3: source clock ages, unknown included (O3-304, D5)", () => {
  const now = 1_789_675_200;
  const ages = (clocks, over = {}) => checkSourceAges({ ticker: "NVDA", now, clocks }, { ...DEFAULTS, ...over });

  test("an age this build cannot compute is null — UNKNOWN — and is never reported as 0", () => {
    const r = ages({ quote: null, underlying: now - 400, volatility: null, published: null });
    assert.deepEqual(r.ages, { quoteS: null, underlyingS: 400, volatilityS: null, publishedS: null });
    assert.deepEqual(r.findings, [], "with no operator limit the ages are reported and nothing pages");
  });

  test("with a limit set, an UNKNOWN age fails it: an unknown age is not fresh", () => {
    const r = ages({ quote: null, underlying: now - 400, volatility: null, published: null }, { quoteAgeS: 1800 });
    assert.deepEqual(r.findings.map((f) => `${f.kind}:${f.key}`), ["v2_mon_source_age:NVDA:quote"]);
    assert.match(r.findings[0].message, /UNKNOWN .* an unknown age is not fresh and is never 0/);
    assert.deepEqual(r.findings[0].data, { ticker: "NVDA", clock: "quote", observedAt: null, ageSeconds: null, limitSeconds: 1800 });
  });

  test("a stale observation pages; one inside the limit does not; the publication clock never pages", () => {
    const limits = { quoteAgeS: 1800, underlyingAgeS: 1800, volatilityAgeS: 1800 };
    const fresh = ages({ quote: now - 10, underlying: now - 1800, volatility: now - 1, published: now - 999_999 }, limits);
    assert.deepEqual(fresh.findings, [], "exactly at the limit is inside it, and publication time is not a source observation");
    const stale = ages({ quote: now - 1801, underlying: now - 10, volatility: now - 10, published: now }, limits);
    assert.deepEqual(stale.findings.map((f) => f.key), ["NVDA:quote"]);
    assert.equal(stale.findings[0].data.ageSeconds, 1801);
    assert.match(stale.findings[0].message, /a refetch advances ingestion time only and never this one/);
  });

  test("a clock stamped in the future is clamped to 0 age, never a negative one", () => {
    assert.equal(ages({ quote: now + 600, underlying: null, volatility: null, published: null }).ages.quoteS, 0);
  });
});

describe("F3: provider and method switches (O3-304)", () => {
  const labels = (over = {}) => ({ provider: null, method: null, source: "cboe", ...over });

  test("the first poll of a market cannot be a switch", () => {
    assert.deepEqual(checkSourceSwitch({ key: "NVDA", label: "NVDA", previous: null, current: labels() }), []);
  });

  test("a provider switch between two polls is a warn event, keyed on the transition", () => {
    const f = checkSourceSwitch({
      key: "NVDA",
      label: "NVDA",
      previous: labels({ provider: "cboe-delayed", method: "listed" }),
      current: labels({ provider: "massive-opra", method: "listed" }),
    });
    assert.deepEqual(f.map((x) => `${x.kind}/${x.severity}/${x.key}`), ["v2_mon_source_switch/warn/NVDA:provider:cboe-delayed>massive-opra"]);
    assert.equal(f[0].event, true, "a switch pages once per transition, not every pass");
    assert.match(f[0].message, /calibrated on the old one/);
  });

  test("a method switch listed -> modeled is its own event", () => {
    const f = checkSourceSwitch({
      key: "NVDA",
      label: "NVDA",
      previous: labels({ provider: "cboe-delayed", method: "listed" }),
      current: labels({ provider: "cboe-delayed", method: "modeled" }),
    });
    assert.deepEqual(f.map((x) => x.data.field), ["method"]);
    assert.deepEqual([f[0].data.from, f[0].data.to], ["listed", "modeled"]);
  });

  test("today's observable switch is the legacy `source` label: cboe (exact listed contract) -> model", () => {
    const f = checkSourceSwitch({ key: "NVDA", label: "NVDA", previous: labels({ source: "cboe" }), current: labels({ source: "model" }) });
    assert.deepEqual(f.map((x) => `${x.data.field}/${x.severity}`), ["source/warn"]);
    assert.match(f[0].message, /cboe = the cboe-delayed provider on an exact listed contract/);
  });

  test("a label appearing or disappearing is info, not a false provider change", () => {
    const appears = checkSourceSwitch({ key: "NVDA", label: "NVDA", previous: labels(), current: labels({ provider: "cboe-delayed" }) });
    assert.deepEqual(appears.map((x) => x.severity), ["info"]);
    assert.match(appears[0].message, /nothing stated one before/);
    const gone = checkSourceSwitch({ key: "NVDA", label: "NVDA", previous: labels({ provider: "cboe-delayed" }), current: labels() });
    assert.deepEqual(gone.map((x) => x.severity), ["info"]);
    assert.match(gone[0].message, /is not evidence of the old one/);
  });

  test("one label per market: the common value, or `mixed` when two probed series disagree", () => {
    const a = readFairAnswer(200, { fair: { raw: "1" }, source: "cboe", asOf: 1 });
    const b = readFairAnswer(200, { fair: { raw: "1" }, source: "model", asOf: 1 });
    const dead = readFairAnswer(0, null);
    assert.deepEqual(marketSourceLabels([a, a]), { provider: null, method: null, source: "cboe" });
    assert.deepEqual(marketSourceLabels([a, b]).source, "mixed");
    assert.deepEqual(marketSourceLabels([dead]), { provider: null, method: null, source: null }, "a failed probe states nothing");
  });
});

describe("F3: the pricer is running versus the pricer is evaluating (O3-304)", () => {
  const now = 1_789_675_200;
  const body = (over = {}) => ({
    mode: "pricer",
    ticks: 40,
    lastTickAt: new Date((now - 30) * 1000).toISOString(),
    sessionOpen: true,
    hasRole: true,
    strategies: 3,
    outcomes: { repriced: 5, "not-due": 100, "fair-unavailable": 2 },
    ...over,
  });
  const act = (over = {}, previous = null, t = DEFAULTS) => checkPricerActivity({ answered: true, body: body(over), now, previous }, t);

  test("a pricer whose counters moved since the last poll is active", () => {
    const first = act();
    assert.deepEqual(first.findings, []);
    assert.deepEqual(first.seen, { evaluations: 107, ticks: 40, at: now });
    assert.equal(first.activity.evaluations, 107, "an evaluation is one pair on one tick: the outcomes histogram");
    const moved = act({ ticks: 41, outcomes: { repriced: 6, "not-due": 100, "fair-unavailable": 2 } }, { evaluations: 107, ticks: 40, at: now - 5000 });
    assert.deepEqual(moved.findings, []);
    assert.equal(moved.seen.at, now, "the window restarts the moment it evaluates anything");
  });

  test("a pricer that answers but has evaluated nothing for the window pages v2_mon_pricer_idle", () => {
    const idle = act({}, { evaluations: 107, ticks: 40, at: now - 1000 });
    assert.deepEqual(idle.findings.map((f) => `${f.kind}/${f.severity}/${f.key}`), ["v2_mon_pricer_idle/warn/pricer"]);
    assert.equal(idle.findings[0].data.idleSeconds, 1000);
    assert.equal(idle.findings[0].data.evaluations, 107);
    assert.match(idle.findings[0].message, /Asks already placed keep their last price while it is stopped/);
    assert.deepEqual(idle.seen, { evaluations: 107, ticks: 40, at: now - 1000 }, "the stored mark is not moved by a poll that saw nothing");
  });

  test("a tick clock that is stale on its own face is idle too, and an unknown one is never read as 0", () => {
    const stale = act({ lastTickAt: new Date((now - 4000) * 1000).toISOString() }, { evaluations: 107, ticks: 40, at: now - 5 });
    assert.deepEqual(stale.findings.map((f) => f.kind), ["v2_mon_pricer_idle"]);
    assert.equal(stale.findings[0].data.tickAgeSeconds, 4000);
    const unknown = act({ lastTickAt: null }, { evaluations: 107, ticks: 40, at: now - 1000 });
    assert.equal(unknown.findings[0].data.lastTickAt, null);
    assert.match(unknown.findings[0].message, /UNKNOWN time .* an unknown age is not 0/);
  });

  test("outside the 24/5 session the pricer is meant to do nothing, so the window restarts instead of paging", () => {
    const closed = act({ sessionOpen: false }, { evaluations: 107, ticks: 40, at: now - 100_000 });
    assert.deepEqual(closed.findings, []);
    assert.equal(closed.seen.at, now);
  });

  test("no strategy to reprice is not idle: the loop is running and there is nothing to evaluate", () => {
    const quiet = act({ strategies: 0, ticks: 41, outcomes: {} }, { evaluations: 0, ticks: 40, at: now - 100_000 });
    assert.deepEqual(quiet.findings, [], "the tick counter moved, so the pricer is working");
    assert.equal(quiet.activity.evaluations, 0);
  });

  test("pricerIdleS 0 turns the alert off; a pricer that never answered leaves the stored mark alone", () => {
    assert.deepEqual(act({}, { evaluations: 107, ticks: 40, at: now - 100_000 }, { ...DEFAULTS, pricerIdleS: 0 }).findings, []);
    const down = checkPricerActivity({ answered: false, body: null, now, previous: { evaluations: 107, ticks: 40, at: now - 100_000 } }, DEFAULTS);
    assert.deepEqual(down, { activity: null, seen: null, findings: [] }, "a dead process is v2_mon_service_down, never this page");
  });
});

describe("F3: a whole pass against a fixture pricing service and pricer (O3-304)", () => {
  const dirs = [];
  const servers = [];
  after(() => {
    for (const s of servers) s.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const scratch = (prefix) => {
    const d = tmp(prefix);
    dirs.push(d);
    return d;
  };
  const listen = (handler) =>
    new Promise((resolve) => {
      const server = createServer(handler);
      servers.push(server);
      server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
    });

  // A whole pass judges series against the WALL clock (an expired series is never probed), so the two
  // fixture series sit in the next trading week: the week's last session is its weekly, the one before a daily.
  const [DAILY, WEEKLY] = (() => {
    let day = Math.floor(Date.now() / 86_400_000) + 2;
    while (!(isTradingDay(day) && expiryTenor(closeOfDay(day)) === "weekly")) day += 1;
    let daily = day - 1;
    while (!isTradingDay(daily)) daily -= 1;
    return [closeOfDay(daily), closeOfDay(day)];
  })();
  const NVDA = addr(0xa001);

  /** A state file the pass will load: the log scan's own record of two live series, one per tenor. */
  const seed = (dir, registry, chainId = 4663) => {
    const reg = parseRegistry(JSON.parse(readFileSync(registry, "utf8")), registry);
    const file = path.join(dir, "state.json");
    writeFileSync(
      file,
      JSON.stringify({
        ...emptyState(chainId, fingerprintOf(reg, chainId)),
        scan: {
          ...emptyState(chainId, fingerprintOf(reg, chainId)).scan,
          series: {
            10: { u: NVDA, e: DAILY, put: false, k: "231000000", o: addr(0xc001), p: 80 },
            12: { u: NVDA, e: WEEKLY, put: false, k: "235000000", o: addr(0xc001), p: 80 },
          },
        },
      }),
    );
    return file;
  };

  /** The pricing service, answering from fixtures. `plan` decides what each series and expiry says. */
  const pricingService = (plan) =>
    listen((req, res) => {
      const url = new URL(req.url, "http://x");
      const json = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (url.pathname === "/health") return json(200, { status: "ok", service: "callhouse-pricing", settings: { maxChainAgeS: 1800 }, chains: { NVDA: { ok: true, usable: plan.usable ?? "ok", fetchedAt: new Date().toISOString(), error: null, chainTimestamp: "2026-09-17 16:00:00", lastTradeTime: "2026-09-17 15:59:58", options: 900 } } });
      if (url.pathname === "/surface/NVDA") return json(200, { ticker: "NVDA", expiries: (plan.expiries ?? [DAILY, WEEKLY]).map((e) => ({ expiry: e, status: plan.status?.[e] ?? "ok", strikes: [] })) });
      if (url.pathname === "/fair") {
        const expiry = Number(url.searchParams.get("expiry"));
        const refusal = plan.refuse?.[expiry];
        if (refusal !== undefined) return json(200, { fair: null, reason: refusal, detail: {} });
        return json(200, { fair: { raw: "120000", decimals: 6, formatted: "0.12" }, iv: 0.4, delta: 0.2, source: plan.source ?? "cboe", spot: { raw: "231000000", decimals: 6, formatted: "231" }, asOf: plan.asOf ?? Math.floor(Date.now() / 1000) - 120 });
      }
      return json(404, { reason: "not-found" });
    });

  const pricerService = (state) =>
    listen((req, res) => {
      if (req.url !== "/state") return res.writeHead(404).end("{}");
      if (state() === null) return res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: "no state yet; the first tick has not completed", mode: "pricer" }));
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(state()));
    });

  test("all ready: the pass is clean, both tenors report ready, and the labels are remembered for the next poll", async () => {
    const dir = scratch("monitor-pricing-ok-");
    const registry = writeRegistry(dir, { markets: [market("NVDA", 1)] });
    const statePath = seed(dir, registry);
    const pricing = await pricingService({});
    const opts = options(dir, registry, ["--pricing", pricing]);
    const r = await runOnce(opts);
    assert.deepEqual(kindsOf(r).filter((k) => k.startsWith("v2_mon_quote") || k.startsWith("v2_mon_source") || k.startsWith("v2_mon_pricing")), []);
    assert.equal(r.checks.pricing.status, "ok");
    assert.match(r.checks.pricing.detail, /2 of 2 market-tenor\(s\) ready/);
    assert.match(r.checks.pricing.detail, /daily ready, weekly ready/);
    // The quote and volatility clocks are not served today: they print "unknown", never "0 s".
    assert.match(r.checks.pricing.detail, /ages quote unknown .* vol unknown/);
    assert.ok(r.notes.some((n) => /\/v2\/config\.services \(X3-301/.test(n)), "the pass says what the API does not serve yet");
    assert.ok(r.notes.some((n) => /no \/fair answer carried §5\.1 `provenance`/.test(n)));
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.deepEqual(state.pricing.sources.NVDA.source, "cboe");
    assert.equal(state.pricing.sources.NVDA.provider, null, "the provider is not served, so none is stored");
  });

  test("a daily refused while the weekly prices pages the daily alone, and an unknown code pages beside it", async () => {
    const dir = scratch("monitor-pricing-daily-");
    const registry = writeRegistry(dir, { markets: [market("NVDA", 1)] });
    seed(dir, registry);
    const pricing = await pricingService({ refuse: { [DAILY]: "vendor-rate-limited" } });
    const r = await runOnce(options(dir, registry, ["--pricing", pricing]));
    const ours = r.findings.filter((f) => f.kind.startsWith("v2_mon_quote") || f.kind.startsWith("v2_mon_pricing"));
    assert.deepEqual(ours.map((f) => f.id).sort(), ["v2_mon_pricing_reason_unknown:NVDA", "v2_mon_quote_unready:NVDA:daily"]);
    assert.match(r.checks.pricing.detail, /daily NOT ready \(0\/1 expiries, 1\/1 series\), weekly ready/);
  });

  test("a service that is down and a series that is not ready are two different alerts", async () => {
    const dir = scratch("monitor-pricing-down-");
    const registry = writeRegistry(dir, { markets: [market("NVDA", 1)] });
    seed(dir, registry);
    const pricing = await pricingService({ usable: "chain-stale" });
    // The same process answers /health for the health check and refuses every price for the pricing check.
    const r = await runOnce(options(dir, registry, ["--pricing", pricing, "--health", `pricing=${pricing}/nope`]));
    const ours = r.findings.filter((f) => f.kind === "v2_mon_service_down" || f.kind === "v2_mon_quote_unready");
    assert.deepEqual(ours.map((f) => f.id).sort(), ["v2_mon_quote_unready:NVDA", "v2_mon_service_down:pricing"]);
    assert.notEqual(ours[0].kind, ours[1].kind, "process health and priceability never share a page");
  });

  test("a legacy `source` switch between two passes is an event of its own", async () => {
    const dir = scratch("monitor-pricing-switch-");
    const registry = writeRegistry(dir, { markets: [market("NVDA", 1)] });
    seed(dir, registry);
    let source = "cboe";
    const pricing = await listen((req, res) => {
      const url = new URL(req.url, "http://x");
      const json = (status, body) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      if (url.pathname === "/health") return json(200, { status: "ok", settings: { maxChainAgeS: 1800 }, chains: { NVDA: { ok: true, usable: "ok", error: null, chainTimestamp: "t", lastTradeTime: "t" } } });
      if (url.pathname === "/surface/NVDA") return json(200, { expiries: [DAILY, WEEKLY].map((e) => ({ expiry: e, status: "ok" })) });
      return json(200, { fair: { raw: "120000", decimals: 6, formatted: "0.12" }, source, spot: { raw: "1", decimals: 6, formatted: "0" }, asOf: Math.floor(Date.now() / 1000) - 60 });
    });
    const opts = options(dir, registry, ["--pricing", pricing]);
    const first = await runOnce(opts);
    assert.deepEqual(kindsOf(first).filter((k) => k === "v2_mon_source_switch"), [], "the first poll has nothing to compare to");
    source = "model";
    const second = await runOnce(opts);
    const switched = second.findings.filter((f) => f.kind === "v2_mon_source_switch");
    assert.deepEqual(switched.map((f) => f.id), ["v2_mon_source_switch:NVDA:source:cboe>model"]);
    assert.equal(switched[0].severity, "warn");
    const third = await runOnce(opts);
    assert.deepEqual(third.findings.filter((f) => f.kind === "v2_mon_source_switch"), [], "the switch is not re-found while the label sits still");
    // With no webhook the first send was only printed, so it is retried — never raised a second time as new.
    assert.deepEqual(third.sent.filter((s) => s.kind === "v2_mon_source_switch").map((s) => s.reason), ["retry"]);
  });

  test("an idle pricer pages while a working one does not, and neither is the /health page", async () => {
    const dir = scratch("monitor-pricer-idle-");
    const registry = writeRegistry(dir, { markets: [market("NVDA", 1)] });
    seed(dir, registry);
    let ticks = 40;
    const pricer = await pricerService(() => ({
      mode: "pricer",
      ticks,
      lastTickAt: new Date().toISOString(),
      sessionOpen: true,
      hasRole: true,
      strategies: 2,
      outcomes: { repriced: ticks },
    }));
    const opts = options(dir, registry, ["--pricer", pricer, "--threshold", "pricerIdleS=1"]);
    const first = await runOnce(opts);
    assert.deepEqual(kindsOf(first).filter((k) => k === "v2_mon_pricer_idle"), [], "the first poll only records the counters");
    ticks += 1;
    const working = await runOnce(opts);
    assert.deepEqual(kindsOf(working).filter((k) => k === "v2_mon_pricer_idle"), []);
    assert.match(working.checks.pricing.detail, /pricer 41 tick\(s\), 41 evaluation\(s\), 2 strategies/);
    await new Promise((r) => setTimeout(r, 1100));
    const idle = await runOnce(opts); // counters frozen
    assert.deepEqual(idle.findings.filter((f) => f.kind === "v2_mon_pricer_idle").map((f) => f.id), ["v2_mon_pricer_idle:pricer"]);
    assert.match(idle.checks.pricing.detail, /no --pricing: priceability unchecked/);
  });

  test("a pricer that has not finished a tick answers 503; that is process health, so the check goes incomplete and pages nothing", async () => {
    const dir = scratch("monitor-pricer-503-");
    const registry = writeRegistry(dir, { markets: [market("NVDA", 1)] });
    seed(dir, registry);
    const pricer = await pricerService(() => null);
    const r = await runOnce(options(dir, registry, ["--pricer", pricer]));
    assert.deepEqual(kindsOf(r).filter((k) => k === "v2_mon_pricer_idle"), []);
    assert.equal(r.checks.pricing.status, "incomplete");
    assert.match(r.checks.pricing.detail, /no tick completed yet/);
  });

  test("with neither flag the check is skipped, and every alert name the monitor can emit is documented", () => {
    const dir = scratch("monitor-pricing-off-");
    const registry = writeRegistry(dir, { markets: [market("NVDA", 1)] });
    const opts = options(dir, registry);
    assert.equal(opts.pricing, null);
    assert.equal(opts.pricer, null);
    // ops/runbooks.test.mjs checks the runbook direction; this is the catalogue direction.
    const alerts = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "alerts.md"), "utf8");
    for (const kind of Object.keys(KINDS)) assert.ok(alerts.includes(`\`${kind}\``), `${kind} has no ops/alerts.md entry`);
    for (const kind of ["v2_mon_quote_unready", "v2_mon_pricing_reason_unknown", "v2_mon_source_age", "v2_mon_source_switch", "v2_mon_pricer_idle"]) {
      assert.ok(KINDS[kind] !== undefined && KINDS[kind].runbook.includes("§V"), `${kind} needs a runbook anchor`);
    }
  });

  test("the pricing base url is validated, and the flags are the ones the runbooks may pass", () => {
    const dir = scratch("monitor-pricing-args-");
    const registry = writeRegistry(dir, { markets: [] });
    assert.throws(() => options(dir, registry, ["--pricing", "ftp://nope"]), UsageError);
    assert.throws(() => options(dir, registry, ["--pricer", "not a url"]), UsageError);
    assert.equal(options(dir, registry, ["--pricing", "http://p:8790/"]).pricing, "http://p:8790", "a trailing slash is stripped: the monitor appends its own paths");
    assert.equal(options(dir, registry, [], { MONITOR_PRICING_URL: "http://p:8790", MONITOR_PRICER_URL: "http://q:8792" }).pricer, "http://q:8792");
  });
});

/* ---------------------------------------------------------------------------------------------- */
/*  INTERFACE_VERSION 8: the manager, the Safes, the flywheel, v4 routes, the inverted rent alert  */
/* ---------------------------------------------------------------------------------------------- */

const MANAGER = addr(0xac1);
const SPLITTER = addr(0xf51);
const ADMIN_SAFE = addr(0x5a1);
const ASSET = addr(0xa001);

let v8tx = 0;
const v8log = (eventName, args, over = {}) => {
  v8tx += 1;
  return { eventName, args, blockNumber: 900n, transactionHash: `0x${String(v8tx).padStart(64, "a")}`, logIndex: 0, ...over };
};
const mctx = (over = {}) => ({ names: { [MANAGER.toLowerCase()]: "accessManager", [ADMIN_SAFE.toLowerCase()]: "adminSafe" }, manifest: ROLE_MANIFEST.manifest, selectors: null, now: 1_700_000_000, ...over });

describe("v8: the role manifest is read, not transcribed", () => {
  test("ops/abis/v2/roles.json is the source of the ids, delays and admins", () => {
    const m = ROLE_MANIFEST.manifest;
    assert.equal(ROLE_MANIFEST.why, null, "the manifest beside the ABIs must be readable");
    assert.equal(m.interfaceVersion, 8);
    // Spot-checked against the file, not against a copy of it in this test: read it here too.
    const onDisk = JSON.parse(readFileSync(path.join(ABIS, "roles.json"), "utf8"));
    assert.deepEqual(m.ids, onDisk.roles);
    assert.deepEqual(m.delaysS, onDisk.delaysS);
    assert.equal(Object.keys(m.ids).length, 11, "eleven roles");
    assert.equal(roleLabel(7), "GUARDIAN (7)");
    assert.equal(roleDelayS(m.ids.MARKET_FEE_MANAGER), onDisk.delaysS.MARKET_FEE_MANAGER);
  });

  test("an unknown id is named unknown and has no delay; it is never folded into ADMIN or 0", () => {
    assert.match(roleLabel(99), /^role 99 \(not in the manifest\)$/);
    assert.equal(roleDelayS(99), null, "an unknown role's delay is unknown, not 0");
  });

  test("a manifest that cannot be read leaves the monitor watching, not blind", () => {
    const missing = loadRoleManifest(path.join(tmpdir(), "no-such-roles-file.json"));
    assert.equal(missing.manifest, null);
    assert.match(missing.why, /no-such-roles-file/);
    assert.match(roleLabel(3, null), /^role 3 /, "roles still page, by id");
  });

  test("a manifest with two names on one id is refused rather than silently collapsed", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "roles-dup-")), "roles.json");
    writeFileSync(file, JSON.stringify({ interfaceVersion: 8, roles: { ADMIN: 0, IMPOSTOR: 0 } }));
    const r = loadRoleManifest(file);
    assert.equal(r.manifest, null);
    assert.match(r.why, /are both 0/);
  });
});

describe("v8: AccessManager events", () => {
  test("a scheduled operation names the function, the role and the guardian that can cancel it", () => {
    const selectors = { "0xdeadbeef": { contract: "OrderBook", signature: "setFeeParams((uint16,uint16,uint32,uint16,uint16))", role: "FEE_MANAGER" } };
    const out = managerEventFindings(
      [v8log("OperationScheduled", { operationId: "0x11", nonce: 1, schedule: 1_700_086_400, caller: ADMIN_SAFE, target: addr(0xc2), data: "0xdeadbeef0000" })],
      null,
      mctx({ selectors }),
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "v2_mon_manager_operation");
    assert.equal(out[0].severity, "error");
    assert.match(out[0].message, /OrderBook\.setFeeParams/);
    assert.match(out[0].message, /FEE_MANAGER/);
    assert.match(out[0].message, /GUARDIAN role can cancel it/, "roles.json roleGuardian says GUARDIAN guards FEE_MANAGER");
    assert.match(out[0].message, /expires one week/);
  });

  test("a selector the manifest does not carry is said to be unknown, and said to belong to ADMIN", () => {
    const out = managerEventFindings(
      [v8log("OperationScheduled", { operationId: "0x12", nonce: 1, schedule: 1_700_086_400, caller: ADMIN_SAFE, target: addr(0xc2), data: "0xfeedface0000" })],
      null,
      mctx({ selectors: {} }),
    );
    assert.match(out[0].message, /0xfeedface/);
    assert.match(out[0].message, /not in the role manifest/);
    assert.match(out[0].message, /belongs to ADMIN/);
  });

  test("executed pages error and cancelled pages warn: a cancel is the brake, a run is the change", () => {
    const [exec] = managerEventFindings([v8log("OperationExecuted", { operationId: "0x13", nonce: 1 })], null, mctx());
    const [cancel] = managerEventFindings([v8log("OperationCanceled", { operationId: "0x14", nonce: 1 })], null, mctx());
    assert.equal(exec.severity, "error");
    assert.equal(cancel.severity, "warn");
    assert.equal(exec.kind, "v2_mon_manager_operation");
    assert.equal(cancel.kind, "v2_mon_manager_operation");
  });

  test("a grant whose execution delay is not the manifest's says so by name", () => {
    const id = ROLE_MANIFEST.manifest.ids.CONFIG_ADMIN;
    const want = ROLE_MANIFEST.manifest.delaysS.CONFIG_ADMIN;
    const right = managerEventFindings([v8log("RoleGranted", { roleId: id, account: ADMIN_SAFE, delay: want, since: 1, newMember: true })].map((l) => ({ ...l, eventName: "ManagerRoleGranted" })), null, mctx());
    const wrong = managerEventFindings([v8log("RoleGranted", { roleId: id, account: ADMIN_SAFE, delay: 0, since: 1, newMember: true })].map((l) => ({ ...l, eventName: "ManagerRoleGranted" })), null, mctx());
    assert.equal(right.length, 1, "every grant pages, right delay or not");
    assert.doesNotMatch(right[0].message, /different clock/);
    assert.match(wrong[0].message, /different clock/);
    assert.match(wrong[0].message, /CONFIG_ADMIN/);
  });

  test("a re-grant is not nothing: it changes the delay, and the message says so", () => {
    const [f] = managerEventFindings([{ ...v8log("x", { roleId: 1, account: ADMIN_SAFE, delay: 60, since: 1, newMember: false }), eventName: "ManagerRoleGranted" }], null, mctx());
    assert.match(f.message, /re-grant CHANGES the delay/);
  });

  test("every manager role and target event pages, and RoleLabel is the only cosmetic one", () => {
    const events = [
      { eventName: "ManagerRoleRevoked", args: { roleId: 8, account: addr(0xbad) } },
      { eventName: "ManagerRoleAdminChanged", args: { roleId: 8, admin: 0 } },
      { eventName: "RoleGuardianChanged", args: { roleId: 1, guardian: 0 } },
      { eventName: "RoleGrantDelayChanged", args: { roleId: 1, delay: 3600, since: 1 } },
      { eventName: "TargetFunctionRoleUpdated", args: { target: addr(0xc2), selector: "0xaabbccdd", roleId: 6 } },
      { eventName: "TargetAdminDelayUpdated", args: { target: addr(0xc2), delay: 3600, since: 1 } },
      { eventName: "TargetClosed", args: { target: addr(0xc2), closed: true } },
      { eventName: "RoleLabel", args: { roleId: 1, label: "fees" } },
    ].map((e, i) => v8log(e.eventName, e.args, { logIndex: i }));
    const out = managerEventFindings(events, null, mctx());
    assert.equal(out.length, events.length, "every one of them pages");
    assert.deepEqual(new Set(out.map((f) => f.kind)), new Set(["v2_mon_manager_role"]));
    const bySeverity = Object.fromEntries(out.map((f, i) => [events[i].eventName, f.severity]));
    assert.equal(bySeverity.RoleLabel, "warn");
    for (const [name, sev] of Object.entries(bySeverity)) if (name !== "RoleLabel") assert.equal(sev, "error", name);
    assert.match(out[6].message, /CLOSED/);
  });

  test("AccessControl's bytes32 RoleGranted is NOT a manager event, and the manager's is not a config event", () => {
    // The trap this whole rename exists for: same name, different topic, different meaning.
    const accessControl = v8log("RoleGranted", { role: `0x${"0".repeat(64)}`, account: addr(0xbad), sender: addr(0xbad) });
    assert.deepEqual(managerEventFindings([accessControl], null, mctx()), [], "a bytes32 grant is not a manager grant");
    assert.equal(scanEventName(accessControl), "RoleGranted", "and it keeps its own name");
    const manager = { eventName: "RoleGranted", args: { roleId: 0, account: addr(0xbad), delay: 0, since: 1, newMember: true } };
    assert.equal(scanEventName(manager), "ManagerRoleGranted");
    assert.equal(scanEventName({ eventName: "RoleRevoked", args: { roleId: 0, account: addr(0xbad) } }), "ManagerRoleRevoked");
    assert.equal(scanEventName({ eventName: "RoleAdminChanged", args: { roleId: 0, admin: 1 } }), "ManagerRoleAdminChanged");
    assert.equal(scanEventName({ eventName: "RouteSet", args: { asset: ASSET, venue: 1, poolId: "0x00", fee: 3000, feeBps: 30 } }), "RouterRouteSet");
    assert.equal(scanEventName({ eventName: "RouteSet", args: { asset: ASSET, pool: addr(0x1), fee: 3000 } }), "RouteSet", "the v7 adapter's keeps its name");
  });

  test("history before the first run is adopted, as it is for every other admin event", () => {
    const e = v8log("ManagerRoleGranted", { roleId: 0, account: addr(0xbad), delay: 0, since: 1, newMember: true }, { blockNumber: 500n });
    assert.deepEqual(managerEventFindings([e], 600n, mctx()), []);
    assert.equal(managerEventFindings([e], 400n, mctx()).length, 1);
  });

  test("no manager event can be paged twice: every one is in OWN_KIND_EVENTS", () => {
    // configEventFindings is handed everything NOT in OWN_KIND_EVENTS. Declaring an event's severity in
    // CONFIG_EVENTS and forgetting this set would page it under two kinds; leaving it out of both would
    // drop it silently. Both directions are checked here.
    for (const name of [...MANAGER_ROLE_EVENTS, ...MANAGER_OPERATION_EVENTS, ...SPLITTER_EVENTS, ...DEDICATED_EVENTS]) {
      assert.ok(OWN_KIND_EVENTS.has(name), `${name} would be paged by configEventFindings as well`);
    }
    const manager = [...MANAGER_ROLE_EVENTS, ...MANAGER_OPERATION_EVENTS];
    const dropped = manager.filter((n) => CONFIG_EVENTS[n] === undefined && !OWN_KIND_EVENTS.has(n));
    assert.deepEqual(dropped, [], "an event in neither list is never collected by the scan at all");
  });
});

describe("v8: the manager's state against the manifest", () => {
  const row = (over = {}) => ({ roleId: 1, name: "FEE_MANAGER", chainAdmin: 0, chainGuardian: 7, wantAdmin: 0, wantGuardian: 7, ...over });
  const member = (over = {}) => ({ label: "adminSafe", address: ADMIN_SAFE, roleId: 1, roleName: "FEE_MANAGER", isMember: true, executionDelay: 172800, wantMember: true, wantDelayS: 172800, ...over });

  test("a manager that matches the manifest pages nothing", () => {
    assert.deepEqual(checkManagerWiring({ manager: MANAGER, rows: [row()], members: [member()] }), []);
  });

  test("a moved role admin or guardian pages, and says which is which", () => {
    const admin = checkManagerWiring({ manager: MANAGER, rows: [row({ chainAdmin: 6 })], members: [] });
    const guard = checkManagerWiring({ manager: MANAGER, rows: [row({ chainGuardian: 0 })], members: [] });
    assert.equal(admin.length, 1);
    assert.match(admin[0].key, /:1:admin$/);
    assert.match(admin[0].message, /OPS_ADMIN \(6\) on chain/);
    assert.match(guard[0].key, /:1:guardian$/);
    assert.match(guard[0].message, /guardian/);
  });

  test("a holder that does not hold its role, and one that holds a role it should not, both page", () => {
    const missing = checkManagerWiring({ manager: MANAGER, rows: [], members: [member({ isMember: false })] });
    const extra = checkManagerWiring({ manager: MANAGER, rows: [], members: [member({ wantMember: false })] });
    assert.match(missing[0].key, /:missing$/);
    assert.match(missing[0].message, /does NOT hold/);
    assert.match(extra[0].key, /:extra$/);
  });

  test("a member whose execution delay is not the manifest's pages: the delay IS the protection", () => {
    const shorter = checkManagerWiring({ manager: MANAGER, rows: [], members: [member({ executionDelay: 0 })] });
    assert.equal(shorter.length, 1);
    assert.match(shorter[0].key, /:delay$/);
    assert.match(shorter[0].message, /less time to notice and cancel/);
  });

  test("a read that failed is unknown and is judged by nothing, in every column", () => {
    assert.deepEqual(checkManagerWiring({ manager: MANAGER, rows: [row({ chainAdmin: null, chainGuardian: null })], members: [member({ isMember: null, executionDelay: null })] }), []);
    // and specifically: a null delay on a real member is not read as 0
    assert.deepEqual(checkManagerWiring({ manager: MANAGER, rows: [], members: [member({ executionDelay: null })] }), []);
  });
});

describe("v8: a Safe that is already wrong", () => {
  test("2 of 3 is quiet; 1 of 3 pages WITH NO HISTORY AT ALL", () => {
    assert.deepEqual(checkSafeThreshold({ safe: ADMIN_SAFE, label: "Admin Safe", threshold: 2n, owners: 3 }), []);
    const one = checkSafeThreshold({ safe: ADMIN_SAFE, label: "Admin Safe", threshold: 1n, owners: 3 });
    assert.equal(one.length, 1);
    assert.equal(one[0].kind, "v2_mon_safe_threshold");
    assert.equal(one[0].severity, "error");
    assert.match(one[0].message, /One key now moves everything/);
    // The point of the check: checkSafe, the change detector, sees nothing here — there is no baseline.
    assert.deepEqual(checkSafe(undefined, { nonce: 1n, threshold: 1n, owners: [addr(1), addr(2), addr(3)] }, { safe: ADMIN_SAFE, label: "Admin Safe", feeds: [] }).findings, []);
  });

  test("a threshold above the owner count is a Safe nothing can ever execute from", () => {
    const out = checkSafeThreshold({ safe: ADMIN_SAFE, label: "Treasury Safe", threshold: 4n, owners: 3 });
    assert.equal(out.length, 1);
    assert.match(out[0].key, /:unreachable$/);
    assert.match(out[0].message, /no transaction can ever be executed/);
  });

  test("a Safe that could not be read is unknown, not healthy", () => {
    assert.deepEqual(checkSafeThreshold({ safe: ADMIN_SAFE, label: "Admin Safe", threshold: null, owners: null }), []);
  });

  test("checkSafe carries a label, so the protocol Safes do not page as the feed owner's", () => {
    const prev = checkSafe(undefined, { nonce: 1n, threshold: 2n, owners: [addr(1), addr(2)] }, { safe: ADMIN_SAFE, label: "Admin Safe", feeds: ["Admin Safe"] }).baseline;
    const [f] = checkSafe(prev, { nonce: 1n, threshold: 1n, owners: [addr(1), addr(2)] }, { safe: ADMIN_SAFE, label: "Admin Safe", feeds: ["Admin Safe"] }).findings;
    assert.match(f.message, /^Admin Safe /);
    const [g] = checkSafe(prev, { nonce: 1n, threshold: 1n, owners: [addr(1), addr(2)] }, { safe: ADMIN_SAFE, feeds: ["NVDA"] }).findings;
    assert.match(g.message, /^Feed owner Safe /, "the default is unchanged for the feed Safes");
  });
});

describe("v8: the fee splitter and the buyback", () => {
  const flyState = () => ({ lastDistributedAt: null, pendingSince: null, floorMisses: {}, lastBoughtBackAt: null, fundedSince: null });
  const skip = (reason, at = 0) => ({ eventName: "DistributionSkipped", args: { asset: ASSET, reason: `0x${Buffer.from(reason).toString("hex").padEnd(64, "0")}` }, transactionHash: `0x${String(at).padStart(64, "b")}` });

  test("a bytes32 reason reads as the word the contract packed into it", () => {
    assert.equal(reasonText(`0x${Buffer.from("BELOW_FLOOR").toString("hex").padEnd(64, "0")}`), "BELOW_FLOOR");
    assert.equal(reasonText("0x"), "0x", "an empty reason stays what it was, rather than becoming an empty word");
  });

  test("consecutive skips of one reason build a streak; a distribution clears it", () => {
    const fly = flyState();
    applyFlywheelLogs(fly, [skip("BELOW_FLOOR", 1)], 1000, SPLITTER);
    applyFlywheelLogs(fly, [skip("BELOW_FLOOR", 2)], 2000, SPLITTER);
    assert.equal(fly.floorMisses[ASSET.toLowerCase()].count, 2);
    assert.equal(fly.pendingSince, 1000, "the clock starts at the first evidence, not the last");
    applyFlywheelLogs(fly, [skip("NO_SPOT", 3)], 3000, SPLITTER);
    assert.deepEqual({ ...fly.floorMisses[ASSET.toLowerCase()] }, { reason: "NO_SPOT", count: 1, lastAt: 3000 }, "a different reason is a different streak");
    applyFlywheelLogs(fly, [{ eventName: "Distributed", args: { asset: ASSET, assetIn: 1n, usdgIn: 1n, treasuryOut: 1n, buybackAdded: 0n }, transactionHash: "0xd" }], 4000, SPLITTER);
    assert.equal(fly.floorMisses[ASSET.toLowerCase()], undefined);
    assert.equal(fly.pendingSince, null);
    assert.equal(fly.lastDistributedAt, 4000);
  });

  test("fees only start the clock when they land ON the splitter", () => {
    const mine = flyState();
    const theirs = flyState();
    const swept = (to) => ({ eventName: "FeesSwept", args: { asset: ASSET, to, amount: 5n }, transactionHash: "0xf" });
    applyFlywheelLogs(mine, [swept(SPLITTER)], 100, SPLITTER);
    applyFlywheelLogs(theirs, [swept(addr(0xdead))], 100, SPLITTER);
    assert.equal(mine.pendingSince, 100);
    assert.equal(theirs.pendingSince, null);
  });

  test("a BoughtBack with no Burned in its transaction is returned; one with a Burned is not", () => {
    const fly = flyState();
    const bought = (tx) => ({ eventName: "BoughtBack", args: { usdgIn: 50_000_000n, tokenOut: 10n }, transactionHash: tx });
    const burned = (tx) => ({ eventName: "Burned", args: { amount: 10n }, transactionHash: tx });
    assert.deepEqual(applyFlywheelLogs(fly, [bought("0x1"), burned("0x1")], 10, SPLITTER), [], "the honest case");
    const bad = applyFlywheelLogs(flyState(), [bought("0x2")], 10, SPLITTER);
    assert.equal(bad.length, 1);
    const out = checkBuyback({ splitter: SPLITTER, now: 10, balance: 0n, lastBuybackAt: null, fundedSince: null, unburned: bad }, DEFAULTS);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "v2_mon_buyback_unburned");
    assert.equal(out[0].severity, "error");
    assert.match(out[0].message, /NO Burned in the same transaction/);
  });

  test("idle: fees waiting past the threshold page, and a threshold of 0 turns it off", () => {
    const x = { splitter: SPLITTER, now: 100_000, lastDistributedAt: null, pendingSince: 10_000, floorMisses: [] };
    assert.deepEqual(checkSplitter({ ...x, now: 10_000 + DEFAULTS.splitterIdleS }, DEFAULTS), [], "exactly at the limit is not past it");
    const late = checkSplitter({ ...x, now: 10_000 + DEFAULTS.splitterIdleS + 1 }, DEFAULTS);
    assert.equal(late.length, 1);
    assert.equal(late[0].kind, "v2_mon_splitter_idle");
    assert.match(late[0].message, /permissionless/);
    assert.deepEqual(checkSplitter(x, { ...DEFAULTS, splitterIdleS: 0 }), []);
    assert.deepEqual(checkSplitter({ ...x, pendingSince: null }, DEFAULTS), [], "nothing waiting is not late");
  });

  test("a floor-miss streak pages only once it is a streak, and names the reason", () => {
    const at = (count) => checkSplitter({ splitter: SPLITTER, now: 5, lastDistributedAt: null, pendingSince: null, floorMisses: [{ asset: ASSET, ticker: "NVDA", reason: "BELOW_FLOOR", count, lastAt: 4 }] }, DEFAULTS);
    assert.deepEqual(at(DEFAULTS.splitterFloorMisses - 1), []);
    const out = at(DEFAULTS.splitterFloorMisses);
    assert.equal(out[0].kind, "v2_mon_splitter_floor_miss");
    assert.match(out[0].message, /BELOW_FLOOR/);
    assert.match(out[0].message, /held, not dumped/);
  });

  test("lastBuybackAt 0 is NEVER, and an age is never measured from it", () => {
    // The contract returns 0 before the first buyback. Read as a timestamp it is 1970, and the age
    // becomes fifty-five years: the splitter pages "stuck" with an absurd number that buries the real
    // signal. Both the mapping and what the alert then says are pinned here.
    assert.equal(buybackClock(0), null);
    assert.equal(buybackClock(0n), null);
    assert.equal(buybackClock(null), null);
    assert.equal(buybackClock(1_700_000_000), 1_700_000_000);

    const now = 1_000_000;
    const raw0 = checkBuyback({ splitter: SPLITTER, now, balance: 60_000_000n, lastBuybackAt: 0, fundedSince: now - DEFAULTS.buybackStuckS - 1, unburned: [] }, DEFAULTS);
    assert.equal(raw0.length, 1);
    assert.equal(raw0[0].kind, "v2_mon_buyback_stuck");
    assert.match(raw0[0].message, /\(never\)/);
    assert.doesNotMatch(raw0[0].message, /1970/);
    assert.equal(raw0[0].data.lastBuybackAt, null, "and the payload carries unknown, not 0");
    // The age must come from when the balance was funded, not from the epoch.
    assert.equal(raw0[0].data.ageS, DEFAULTS.buybackStuckS + 1);
  });

  test("stuck needs a balance, a passed cooldown and the age; each one alone is quiet", () => {
    const now = 1_000_000;
    const old = now - DEFAULTS.buybackStuckS - 1;
    const stuck = { splitter: SPLITTER, now, balance: 60_000_000n, lastBuybackAt: old, fundedSince: null, unburned: [] };
    assert.equal(checkBuyback(stuck, DEFAULTS).length, 1);
    assert.deepEqual(checkBuyback({ ...stuck, balance: 0n }, DEFAULTS), [], "no balance, nothing to buy with");
    assert.deepEqual(checkBuyback({ ...stuck, balance: null }, DEFAULTS), [], "an unread balance is unknown, not zero and not stuck");
    assert.deepEqual(checkBuyback({ ...stuck, lastBuybackAt: now - 10 }, DEFAULTS), [], "inside the cooldown it is not stuck, it is waiting");
    assert.deepEqual(checkBuyback(stuck, { ...DEFAULTS, buybackStuckS: 0 }), []);
    // and the cooldown itself is the compiled one, not a number written here twice
    assert.deepEqual(checkBuyback({ ...stuck, lastBuybackAt: now - BUYBACK_COOLDOWN + 1 }, DEFAULTS), []);
  });
});

describe("v8: payout routes, and the selector they share", () => {
  const routerRoute = (over = {}) => ({ venue: 2, fee: 3000, tickSpacing: 60, v3Pool: ZERO, feeBps: 30, ...over });

  test("a route that matches the registry pages nothing", () => {
    const want = { venue: "v4", fee: 3000, tickSpacing: 60, poolId: `0x${"5".repeat(64)}` };
    assert.deepEqual(checkRoute({ ticker: "NVDA", asset: ASSET, route: routerRoute(), registryRoute: want, poolId: want.poolId }), []);
  });

  test("venue, fee and tick spacing mismatches each page under their own key", () => {
    const want = { venue: "v4", fee: 3000, tickSpacing: 60, poolId: null };
    const keys = (route) => checkRoute({ ticker: "NVDA", asset: ASSET, route, registryRoute: want, poolId: null }).map((f) => f.key.split(":").pop());
    assert.deepEqual(keys(routerRoute({ venue: 1 })), ["venue"]);
    assert.deepEqual(keys(routerRoute({ fee: 500 })), ["fee"]);
    assert.deepEqual(keys(routerRoute({ tickSpacing: 10 })), ["tickSpacing"]);
  });

  test("a registry pool id that is not what its own key hashes to pages: for v4 the id IS the pin", () => {
    const want = { venue: "v4", fee: 3000, tickSpacing: 60, poolId: `0x${"1".repeat(64)}` };
    const out = checkRoute({ ticker: "NVDA", asset: ASSET, route: routerRoute(), registryRoute: want, poolId: `0x${"2".repeat(64)}` });
    assert.equal(out.length, 1);
    assert.match(out[0].key, /:poolId$/);
    assert.match(out[0].message, /the id IS the pin/);
  });

  test("no route on chain with one published, and one on chain with none published, are different alerts", () => {
    const missing = checkRoute({ ticker: "NVDA", asset: ASSET, route: routerRoute({ venue: 0, fee: 0, tickSpacing: 0, feeBps: 0 }), registryRoute: { venue: "v3", fee: 3000, tickSpacing: null, poolId: null }, poolId: null });
    assert.match(missing[0].key, /:missing$/);
    assert.match(missing[0].message, /paid in Stock Tokens/);
    const extra = checkRoute({ ticker: "NVDA", asset: ASSET, route: routerRoute(), registryRoute: null, poolId: null });
    assert.match(extra[0].key, /:unpublished$/);
    // and the genuinely quiet case: no route published, none on chain
    assert.deepEqual(checkRoute({ ticker: "NVDA", asset: ASSET, route: routerRoute({ venue: 0 }), registryRoute: null, poolId: null }), []);
  });

  test("a fee tier above the ceiling, and a cached fee above what the floor counts", () => {
    const want = { venue: "v3", fee: 20_000, tickSpacing: null, poolId: null };
    const tier = checkRoute({ ticker: "NVDA", asset: ASSET, route: routerRoute({ venue: 1, fee: 20_000, feeBps: 200 }), registryRoute: want, poolId: null });
    const keys = tier.map((f) => f.key.split(":").pop());
    assert.ok(keys.includes("tier"), "above MAX_ROUTE_FEE_TIER");
    assert.ok(keys.includes("feeBps"), `above MAX_ROUTE_FEE_BPS (${MAX_ROUTE_FEE_BPS})`);
    assert.equal(tier.find((f) => f.key.endsWith("feeBps")).severity, "warn");
  });

  test("an unread route is judged by nothing", () => {
    assert.deepEqual(checkRoute({ ticker: "NVDA", asset: ASSET, route: null, registryRoute: { venue: "v3", fee: 3000, tickSpacing: null, poolId: null }, poolId: null }), []);
  });

  test("the decode guard fires in BOTH directions and is silent when they agree", () => {
    assert.deepEqual(checkRouteDecode({ address: addr(0xc7), interfaceVersion: 8, isAdapter: false }), [], "v8 registry, router deployed");
    assert.deepEqual(checkRouteDecode({ address: addr(0xc7), interfaceVersion: 7, isAdapter: true }), [], "v7 registry, adapter deployed");
    const v8OnAdapter = checkRouteDecode({ address: addr(0xc7), interfaceVersion: 8, isAdapter: true });
    const v7OnRouter = checkRouteDecode({ address: addr(0xc7), interfaceVersion: 7, isAdapter: false });
    assert.equal(v8OnAdapter.length, 1);
    assert.equal(v7OnRouter.length, 1);
    for (const [f] of [v8OnAdapter, v7OnRouter]) {
      assert.equal(f.kind, "v2_mon_route_decode");
      assert.equal(f.severity, "error");
      assert.match(f.message, /0xd7409659/, "the message names the selector both shapes share");
    }
    assert.match(v8OnAdapter[0].message, /without reverting/);
    // A probe that failed is unknown: it must not be read as "it is the router".
    assert.deepEqual(checkRouteDecode({ address: addr(0xc7), interfaceVersion: 8, isAdapter: null }), []);
  });

  test("the v4 pool id is the keccak of the key, currencies in sort order", () => {
    const viem = loadViem();
    const { currency0, currency1 } = routeCurrencies(ASSET, USDG);
    assert.ok(currency0 < currency1, "v4 sorts the currencies");
    assert.deepEqual(routeCurrencies(USDG, ASSET), { currency0, currency1 }, "and the order does not depend on the arguments' order");
    const id = v4PoolId(viem, { currency0, currency1, fee: 3000, tickSpacing: 60, hooks: ZERO });
    // Computed the other way round, from viem's own encoder rather than from the same word() helper.
    const encoded = viem.encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [currency0, currency1, 3000, 60, ZERO],
    );
    assert.equal(id, viem.keccak256(encoded));
  });

  test("the venue enum names what it knows and refuses to fold what it does not into none", () => {
    assert.equal(routeVenueName(0), "none");
    assert.equal(routeVenueName(1), "v3");
    assert.equal(routeVenueName(2), "v4");
    assert.match(routeVenueName(9), /not in IPayoutRouter.Venue/);
    assert.equal(routeVenueName(null), null);
  });

  test("parsePayoutRoute takes the two published shapes and refuses anything else", () => {
    assert.equal(parsePayoutRoute(null, "x"), null);
    assert.deepEqual(parsePayoutRoute({ venue: "v3", fee: 3000 }, "x"), { venue: "v3", fee: 3000, tickSpacing: null, poolId: null });
    assert.throws(() => parsePayoutRoute({ venue: "v5", fee: 1 }, "x"), /is not v3 \| v4/);
    assert.throws(() => parsePayoutRoute({ venue: "v4", fee: 1, tickSpacing: 60, poolId: "0x1234" }, "x"), /32-byte v4 pool id/);
  });
});

describe("v8: the STONKHOUSE pool and the audit trigger", () => {
  const key = { currency0: addr(0x1), currency1: addr(0x2), fee: 3000, tickSpacing: 60, hooks: ZERO };
  const POOL = `0x${"7".repeat(64)}`;

  test("a hookless pool inside the fee ceiling, with a matching id, pages nothing", () => {
    assert.deepEqual(checkTokenPool({ poolId: POOL, poolKey: key, recomputedPoolId: POOL, depth: null }, DEFAULTS), []);
  });

  test("a hook, a fee above the ceiling, or an id that does not match its key each page", () => {
    const hooked = checkTokenPool({ poolId: POOL, poolKey: { ...key, hooks: addr(0xbad) }, recomputedPoolId: POOL, depth: null }, DEFAULTS);
    assert.match(hooked[0].message, /HOOKLESS/);
    const fat = checkTokenPool({ poolId: POOL, poolKey: { ...key, fee: (MAX_HOOK_FEE_BPS + 1) * 100 }, recomputedPoolId: POOL, depth: null }, DEFAULTS);
    assert.equal(fat.length, 1);
    assert.match(fat[0].key, /:fee$/);
    assert.deepEqual(checkTokenPool({ poolId: POOL, poolKey: { ...key, fee: MAX_HOOK_FEE_BPS * 100 }, recomputedPoolId: POOL, depth: null }, DEFAULTS), [], "exactly at the ceiling is allowed");
    const wrongId = checkTokenPool({ poolId: POOL, poolKey: key, recomputedPoolId: `0x${"8".repeat(64)}`, depth: null }, DEFAULTS);
    assert.match(wrongId[0].message, /the only pin there is/);
  });

  test("an unknown depth fails a set floor, and pages nothing when no floor is set", () => {
    assert.deepEqual(checkTokenPool({ poolId: POOL, poolKey: key, recomputedPoolId: POOL, depth: null }, DEFAULTS), [], "off by default");
    const t2 = { ...DEFAULTS, tokenPoolMinDepth: 1_000_000 };
    const unknown = checkTokenPool({ poolId: POOL, poolKey: key, recomputedPoolId: POOL, depth: null }, t2);
    assert.equal(unknown[0].kind, "v2_mon_token_pool_depth");
    assert.match(unknown[0].message, /An unknown depth is not a deep pool/);
    assert.deepEqual(checkTokenPool({ poolId: POOL, poolKey: key, recomputedPoolId: POOL, depth: 1_000_000n }, t2), [], "exactly at the floor is not below it");
    assert.equal(checkTokenPool({ poolId: POOL, poolKey: key, recomputedPoolId: POOL, depth: 999_999n }, t2).length, 1);
  });

  test("the audit trigger pages at half and again at the trigger, and never on a partial sum", () => {
    const t2 = { ...DEFAULTS, auditTriggerUsdg: 1_000_000_000_000 };
    const at = (locked) => checkTvl(
      { locked, parts: [{ name: "clearinghouse", amount: locked ?? 0n }], usdgTotalSupply: 10n ** 12n, headAgeS: 0, holdersFound: 2, holdersExpected: 2 },
      t2,
    );
    assert.deepEqual(at(499_999_999_999n), []);
    const half = at(500_000_000_000n);
    assert.equal(half[0].severity, "warn");
    assert.equal(half[0].key, "half");
    assert.match(half[0].message, /the notice, not the deadline/);
    const full = at(1_000_000_000_000n);
    assert.equal(full[0].severity, "error");
    assert.equal(full[0].key, "full");
    // OWN8-09 CHANGED THIS LINE, and it used to assert the opposite:
    //   assert.deepEqual(at(null), [], "a TVL that could not be summed is unknown, never a partial total")
    // The half of it that was right is kept — `locked` is still null on an incomplete read and no
    // partial sum is ever compared against the trigger. What was wrong was the OUTPUT: returning []
    // made "could not read it" and "has not crossed yet" produce the identical silence, and silence is
    // the only thing the owner ever sees from this alert. It now pages a fault instead.
    const unknown = at(null);
    assert.equal(unknown.length, 1, "an unsummable TVL must page, not go quiet");
    assert.equal(unknown[0].key, "fault");
    assert.equal(unknown[0].severity, "error");
    assert.match(unknown[0].message, /UNKNOWN/);
    assert.deepEqual(unknown[0].data.lockedUsdg6, null, "and it still refuses to publish a partial total");

    assert.deepEqual(checkTvl({ locked: 0n, parts: [], usdgTotalSupply: 1n }, DEFAULTS), [],
      "off by default, with nothing locked, stays silent: an empty protocol needs no audit notice");
  });
});

describe("v8 OWN8-09: every way the audit notice can go quiet", () => {
  // The defect this closes is not a wrong number. It is that the alert's ONLY output is silence, so a
  // notice that has stopped measuring anything is indistinguishable from a protocol below $1M.
  const ON = { ...DEFAULTS, auditTriggerUsdg: 1_000_000_000_000 };
  const healthy = {
    locked: 1n, parts: [{ name: "clearinghouse", amount: 1n }],
    usdgTotalSupply: 10n ** 12n, headAgeS: 0, holdersFound: 2, holdersExpected: 2,
  };
  const faultOf = (over, t = ON) => tvlFaults({ ...healthy, ...over }, t);

  test("the healthy shape faults on nothing — the GREEN control", () => {
    // Asserted first: a fault detector that fires on everything is worth no more than one that never does.
    assert.deepEqual(faultOf({}), []);
    assert.deepEqual(tvlFaults({ ...healthy, locked: 0n }, ON), [], "a genuine zero under a live trigger is not a fault");
  });

  test("an unreadable total faults instead of going silent", () => {
    const f = faultOf({ locked: null });
    assert.equal(f.length, 1);
    assert.equal(f[0].key, "fault");
    assert.match(f[0].data.reasons.join(" "), /could not be read/);
  });

  test("a MIS-REGISTERED USDG faults, and that is the case a balance sum cannot see", () => {
    // The dangerous one. A wrong shared.usdg answers balanceOf 0 for every holder, so the total is a
    // comfortable zero, the check completes, and reconcile() DELETES any live alert. totalSupply is
    // the discriminator between "the protocol holds nothing" and "we are asking the wrong contract".
    for (const supply of [null, undefined, 0n]) {
      const f = faultOf({ locked: 0n, usdgTotalSupply: supply });
      assert.equal(f.length, 1, `supply ${String(supply)}`);
      assert.match(f[0].data.reasons.join(" "), /totalSupply|wrong address/);
    }
    assert.deepEqual(faultOf({ locked: 0n, usdgTotalSupply: 1n }), [],
      "a live token holding nothing is NOT a fault, or every pre-launch run pages");
  });

  test("a stale head faults: a stale total pages late, and late equals never here", () => {
    assert.deepEqual(faultOf({ headAgeS: ON.tvlMaxAgeS }), [], "exactly at the limit is not past it");
    const f = faultOf({ headAgeS: ON.tvlMaxAgeS + 1 });
    assert.equal(f.length, 1);
    assert.match(f[0].data.reasons.join(" "), /stale/);
  });

  test("a short holder set faults: the sum is structurally late", () => {
    const f = faultOf({ holdersFound: 1, holdersExpected: 2 });
    assert.equal(f.length, 1);
    assert.match(f[0].data.reasons.join(" "), /1 of 2/);
  });

  test("the trigger being OFF while the protocol HOLDS value is the dark-notice fault", () => {
    // auditTriggerUsdg is 0 in DEFAULTS, no registry carries it and MONITOR_THRESHOLDS is in no env
    // file, so the notice ships dark. Off with an empty protocol is a legitimate choice and stays
    // quiet; off with collateral in the contracts is the failure OWN8-09 exists to prevent.
    assert.deepEqual(tvlFaults({ ...healthy, locked: 0n }, DEFAULTS), [], "off and empty is silent");
    const f = tvlFaults({ ...healthy, locked: 500_000_000_000n }, DEFAULTS);
    assert.equal(f.length, 1);
    assert.match(f[0].data.reasons.join(" "), /is OFF/);
    assert.deepEqual(tvlFaults({ ...healthy, locked: null }, DEFAULTS), [],
      "off and unknown stays silent too: an off notice owes no reading");
  });

  test("several faults at once are ONE page with every reason named", () => {
    // alertId is kind:key, so one key is one page and one resolution. Sharing the key loses nothing
    // because every one of these has the same operator action.
    const f = faultOf({ locked: null, usdgTotalSupply: 0n, headAgeS: 99_999, holdersFound: 1, holdersExpected: 2 });
    assert.equal(f.length, 1, "one finding, not four");
    assert.equal(f[0].data.reasons.length, 4, "and all four reasons are named in it");
  });

  test("the fault names OWN8-09's next action and warns against reading silence as safety", () => {
    const f = faultOf({ locked: null })[0];
    assert.match(f.message, /ops\/v8\/tvl-threshold\.mjs/, "it must name the tool that derives the trigger");
    assert.match(f.message, /Do not read the absence of an OWN8-09 page/);
    assert.match(f.message, /V3-D33/);
  });

  test("a fault still resolves: the same shape without the fault produces nothing", () => {
    // If a fault could never clear it would be an event, not a condition, and would page forever.
    assert.equal(faultOf({ locked: null }).length, 1);
    assert.deepEqual(faultOf({}), []);
  });
});

describe("v8: the rent alert, inverted, in both directions", () => {
  const market8 = (over = {}) => ({ ticker: "NVDA", underlying: ASSET, enabled: true, chainPpm: 0, registryPpm: 0, interfaceVersion: 8, allowRent: false, ...over });
  const market7 = (over = {}) => ({ ticker: "NVDA", underlying: ASSET, enabled: true, chainPpm: 80, registryPpm: 80, interfaceVersion: 7, ...over });

  test("v8 healthy: rent 0 on chain and 0 in the registry pages NOTHING", () => {
    // Under v7 this exact market pages twice. If the branch were ever written with the v7 comparison,
    // this assertion is what fails.
    assert.deepEqual(checkMintFee(market8()), []);
  });

  test("v8: rent charged on chain pages, error while the market is enabled and warn before", () => {
    const on = checkMintFee(market8({ chainPpm: 80 }));
    assert.equal(on.length, 1);
    assert.equal(on[0].kind, "v2_mon_mint_fee_charged");
    assert.equal(on[0].severity, "error");
    assert.match(on[0].key, /:chain$/);
    assert.match(on[0].message, /PINNED at that rate for its whole life/);
    assert.match(on[0].message, /72 h/, "the fix is the MARKET_FEE_MANAGER lane, and it is not instant");
    const notYet = checkMintFee(market8({ chainPpm: 80, enabled: false }));
    assert.equal(notYet[0].severity, "warn");
  });

  test("v8: a registry that publishes rent pages too, and says whether allowRent let it through", () => {
    const plain = checkMintFee(market8({ registryPpm: 40 }));
    assert.equal(plain.length, 1);
    assert.match(plain[0].key, /:registry$/);
    assert.match(plain[0].message, /build-markets.mjs --check refuses this/);
    const allowed = checkMintFee(market8({ registryPpm: 40, allowRent: true }));
    assert.match(allowed[0].message, /allowRent is true/);
  });

  test("v7 is untouched: the run-off deployment still pages when rent is MISSING", () => {
    assert.deepEqual(checkMintFee(market7()), [], "a healthy v7 market");
    const zero = checkMintFee(market7({ chainPpm: 0, registryPpm: 0 }));
    assert.equal(zero.length, 2);
    assert.deepEqual(new Set(zero.map((f) => f.kind)), new Set(["v2_mon_mint_fee_zero"]));
  });

  test("an unknown interface version keeps the v7 reading rather than guessing v8", () => {
    const unknown = checkMintFee({ ...market7(), interfaceVersion: null });
    assert.deepEqual(unknown, [], "v7 healthy rows stay quiet");
    assert.equal(checkMintFee({ ...market7(), interfaceVersion: null, chainPpm: 0 }).length, 1);
  });

  test("v8: a series pinned at a non-zero rate pages, and one at zero does not", () => {
    const base = { longId: "1", label: "NVDA call", ppm: 0, marketPpm: 0, paid: 0n, refunded: 0n, accrued: 0n, mints: 3, zeroFeeMints: 3, settled: false, complete: true, interfaceVersion: 8 };
    assert.deepEqual(checkMintRent(base), [], "v8 healthy: no rent charged, no alert");
    const charged = checkMintRent({ ...base, ppm: 80, paid: 500n, accrued: 500n });
    assert.equal(charged.length, 1);
    assert.equal(charged[0].kind, "v2_mon_mint_fee_charged");
    assert.match(charged[0].key, /:series$/);
    assert.match(charged[0].message, /pinned at creation and never changes/);
    // the v7 free-mint reading must NOT fire under v8: those keys belong to the other branch
    assert.equal(charged.filter((f) => f.kind === "v2_mon_mint_rent").length, 0);
  });

  test("v7 rent ledger checks are unchanged", () => {
    const v7 = { longId: "1", label: "NVDA call", ppm: 80, marketPpm: 80, paid: 0n, refunded: 0n, accrued: 0n, mints: 3, zeroFeeMints: 3, settled: false, complete: true, interfaceVersion: 7 };
    const out = checkMintRent(v7);
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "v2_mon_mint_rent");
    assert.match(out[0].key, /:free-mint$/);
  });
});

describe("v8: a whole pass against an in-memory v8 deployment", () => {
  const scratch = (prefix) => {
    const dir = mkdtempSync(path.join(tmpdir(), prefix));
    after(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  const ASSET8 = addr(0xa001);
  const MANAGER8 = addr(0xac1);
  const SPLITTER8 = addr(0xf51);
  const EXEC8 = addr(0xf52);
  const SAFE_ADMIN = addr(0x5a1);
  const SAFE_TREASURY = addr(0x5a2);
  const ROLES = JSON.parse(readFileSync(path.join(ABIS, "roles.json"), "utf8"));
  const reverts = () => {
    const e = new Error("execution reverted");
    e.name = "ContractFunctionRevertedError";
    throw e;
  };

  /** A v8 registry: the v8 blocks the monitor reads, with everything the deploy write-back fills in. */
  function writeV8Registry(dir, { payoutRoute = { venue: "v4", fee: 3000, tickSpacing: 60, poolId: null }, mintFeePpm = 0 } = {}) {
    const viem = loadViem();
    const key = { ...routeCurrencies(ASSET8, USDG), fee: 3000, tickSpacing: 60, hooks: ZERO };
    const route = payoutRoute === null ? null : { ...payoutRoute, poolId: payoutRoute.poolId ?? v4PoolId(viem, key) };
    const tokenKey = { currency0: addr(0x11), currency1: addr(0x12), fee: 3000, tickSpacing: 60, hooks: ZERO };
    const file = path.join(dir, "registry-v8.json");
    writeFileSync(
      file,
      JSON.stringify({
        shared: {
          chainId: 4663,
          usdg: USDG,
          multicall3: null,
          safes: { admin: SAFE_ADMIN, treasury: SAFE_TREASURY },
          token: { address: addr(0x13), symbol: "STONK", decimals: 18, poolKey: tokenKey, poolId: v4PoolId(viem, tokenKey) },
        },
        v2: {
          interfaceVersion: 8,
          deployBlock: 1000,
          defaults: {},
          fees: { mintFeePpm: 0, allowRent: false },
          contracts: { ...C, accessManager: MANAGER8, sources: { ...SRC, dataStreams: null } },
          bots: { cranker: addr(0xb01), pricer: addr(0xb02), quoter: addr(0xb03), guardian: addr(0xb04) },
          flywheel: { feeSplitter: SPLITTER8, buybackExecutor: EXEC8, deployBlock: 1000 },
        },
        markets: [{ ticker: "NVDA", asset: ASSET8, feed: addr(0xb001), feedAggregator: null, v2: { status: "live", univ3Pool: null, univ3MinLiquidity: null, mintFeePpm, payoutRoute: route } }],
      }),
    );
    return file;
  }

  /** A healthy v8 chain: the manifest's roles wired as published, both Safes 2-of-3, a matching route. */
  const v8Read = (chain, over = {}) => (address, fn, args) => {
    const a = address.toLowerCase();
    if (over[fn] !== undefined) {
      const r = over[fn](address, args);
      if (r !== undefined) return r;
    }
    if (a === MANAGER8.toLowerCase()) {
      const roleName = Object.entries(ROLES.roles).find(([, id]) => id === Number(args[0]))?.[0];
      switch (fn) {
        case "getRoleAdmin":
          return BigInt(ROLES.roles[ROLES.roleAdmin[roleName] ?? "ADMIN"]);
        case "getRoleGuardian":
          return BigInt(ROLES.roles[ROLES.roleGuardian[roleName] ?? "ADMIN"]);
        case "hasRole":
          return [true, ROLES.delaysS[roleName]];
        default:
          break;
      }
    }
    if (a === SPLITTER8.toLowerCase()) {
      if (fn === "buybackBalance") return 0n;
      if (fn === "lastBuybackAt") return 0n;
    }
    if (a === C.payoutAdapter.toLowerCase()) {
      if (fn === "factory") reverts(); // the router has no factory(): this is what identifies it
      if (fn === "routes") return { venue: 2, fee: 3000, tickSpacing: 60, v3Pool: ZERO, feeBps: 30 };
    }
    if (a === SAFE_ADMIN.toLowerCase() || a === SAFE_TREASURY.toLowerCase()) {
      if (fn === "getOwners") return [addr(1), addr(2), addr(3)];
      if (fn === "getThreshold") return 2n;
    }
    return defaultRead(chain, address, fn, args);
  };

  test("every v8 check actually runs, and a healthy v8 deployment pages none of them", async () => {
    const dir = scratch("monitor-v8-ok-");
    const chain = new FakeChain({ head: 20_000n });
    chain.read = v8Read(chain);
    const r = await runOnce(options(dir, writeV8Registry(dir)), { viem: fakeViem(chain) });
    // The wiring, not the pure functions: a check that is never called is indistinguishable from one
    // that found nothing, and the unit tests above cannot tell the difference.
    for (const name of ["manager", "safes", "flywheel", "routes", "tokenpool"]) {
      assert.equal(r.checks[name]?.status, "ok", `${name}: ${JSON.stringify(r.checks[name])}`);
    }
    // OWN8-09 (46c3e6b5) deliberately stopped this check reporting `skipped`: record() files a
    // skipped check as completed and reconcile() then DELETES the conditions it remembers, so a
    // mis-registered `shared.usdg` used to CLEAR a live audit-trigger alert instead of raising one.
    // The check now always has an opinion. Here the registry names holders that hold nothing, so the
    // opinion is a clean "ok" with no finding -- which the v8kinds assertion below still proves.
    assert.equal(r.checks.tvl.status, "ok", "the check completes with an opinion even while the trigger is off");
    // OWN8-09 (46c3e6b5): this fixture holds 2,000,000 USDG with `auditTriggerUsdg` 0, and a funded
    // protocol whose audit notice is dark is a fault by design -- "off with collateral in the
    // contracts is the notice being dark exactly when it matters". So the healthy-deployment claim is
    // that it pages this ONE notice and nothing else; any other v8 kind appearing here is a regression.
    const v8kinds = kindsOf(r).filter((k) => /manager|safe_threshold|splitter|buyback|route_|mint_fee|token_pool|tvl/.test(k));
    assert.deepEqual(v8kinds, [TVL_DARK], `a healthy v8 deployment pages only the dark audit trigger: ${JSON.stringify(kindsOf(r))}`);
    assert.match(r.checks.manager.detail, /11 roles/);
    assert.match(r.checks.routes.detail, /NVDA v4/);
  });

  // ---------------------------------------------------------------------------------------------
  // T-491. The two tests below are the first in this file to run a full pass with the audit trigger
  // ON. Until fake-chain answered totalSupply, they could not exist: the trigger-on branch of
  // tvlFaults pushed "USDG's totalSupply could not be read", checkTvl returns on any fault, and the
  // half and full arms were unreachable end to end. The unit tests elsewhere in this file call
  // checkTvl directly and so never exercised the wiring that feeds it.
  //
  // The arithmetic, which is not obvious from the source: fake-chain keys balanceOf on the TOKEN
  // address, so BOTH holders the v8 registry names (clearinghouse, makerVault) read as holding
  // USDG_BALANCE. Locked is therefore 2,000,000 USDG in every v8 fixture, and the trigger chosen
  // here is what selects the arm:
  //     trigger <= 2,000,000            -> full
  //     2,000,000 < trigger <= 4,000,000 -> half   (locked >= trigger/2, locked < trigger)
  //     trigger > 4,000,000             -> neither
  const TVL_TRIGGER_FULL = "1000000000000"; // 1,000,000 USDG, below the 2,000,000 locked
  const TVL_TRIGGER_HALF = "3000000000000"; // 3,000,000 USDG: half is 1,500,000, locked sits between

  const v8TvlPass = async (prefix, trigger) => {
    const dir = scratch(prefix);
    const chain = new FakeChain({ head: 20_000n });
    chain.read = v8Read(chain);
    const opts = options(dir, writeV8Registry(dir), ["--threshold", `auditTriggerUsdg=${trigger}`]);
    return runOnce(opts, { viem: fakeViem(chain) });
  };

  test("trigger ON and crossed: a full pass reaches checkTvl's FULL arm", async () => {
    const r = await v8TvlPass("monitor-v8-tvl-full-", TVL_TRIGGER_FULL);
    const tvl = r.findings.filter((x) => x.kind === TVL_DARK);
    assert.equal(tvl.length, 1, `exactly one audit-trigger finding: ${JSON.stringify(kindsOf(r))}`);
    // The arm, not the prose. A report finding carries `id` = `${kind}:${key}`, and `key` is what
    // checkTvl sets to "fault", "half" or "full" -- so the id IS the arm. A ":fault" here would mean
    // the pass never got past tvlFaults, which is the state this row fixed.
    assert.equal(tvl[0].id, `${TVL_DARK}:full`, `not the full arm: ${tvl[0].message}`);
    assert.equal(tvl[0].severity, "error");
    // The sum reached the arm intact. The wiring totals the balances and decides `complete` BEFORE
    // checkTvl is called, so a fault skips the arm, never the sum -- detail proves the total the arm
    // actually saw, and 2,000,000 is USDG_BALANCE times the two holders this registry names.
    assert.equal(r.checks.tvl.status, "ok");
    assert.match(r.checks.tvl.detail, /^2000000\.00 USDG locked \(clearinghouse 1000000\.00, makerVault 1000000\.00\) against a 1000000\.00 USDG trigger$/);
  });

  test("trigger ON and half crossed: the same pass reaches the HALF arm instead", async () => {
    const r = await v8TvlPass("monitor-v8-tvl-half-", TVL_TRIGGER_HALF);
    const tvl = r.findings.filter((x) => x.kind === TVL_DARK);
    assert.equal(tvl.length, 1, `exactly one audit-trigger finding: ${JSON.stringify(kindsOf(r))}`);
    assert.equal(tvl[0].id, `${TVL_DARK}:half`, `not the half arm: ${tvl[0].message}`);
    assert.equal(tvl[0].severity, "warn");
    assert.equal(r.checks.tvl.status, "ok");
    assert.match(r.checks.tvl.detail, /^2000000\.00 USDG locked \(clearinghouse 1000000\.00, makerVault 1000000\.00\) against a 3000000\.00 USDG trigger$/);
  });

  test("a 1-of-3 Admin Safe pages on the FIRST pass, with no baseline to compare against", async () => {
    const dir = scratch("monitor-v8-safe-");
    const chain = new FakeChain({ head: 20_000n });
    chain.read = v8Read(chain, { getThreshold: (address) => (address.toLowerCase() === SAFE_ADMIN.toLowerCase() ? 1n : undefined) });
    const r = await runOnce(options(dir, writeV8Registry(dir)), { viem: fakeViem(chain) });
    const f = r.findings.filter((x) => x.kind === "v2_mon_safe_threshold");
    assert.equal(f.length, 1, `findings: ${JSON.stringify(kindsOf(r))}`);
    assert.match(f[0].message, /Admin Safe/);
    assert.equal(f[0].severity, "error");
  });

  test("rent charged on a v8 chain pages the INVERTED alert, and the same market on v7 does not", async () => {
    const dir = scratch("monitor-v8-rent-");
    const chain = new FakeChain({ head: 20_000n });
    chain.read = v8Read(chain, {
      market: (address) => (address.toLowerCase() === C.clearinghouse.toLowerCase() ? { enabled: true, mintPaused: false, strikeTick: 100n, exerciseFeeBps: 25, oracle: C.settlementOracle, mintFeePpm: 80 } : undefined),
    });
    const r = await runOnce(options(dir, writeV8Registry(dir)), { viem: fakeViem(chain) });
    const charged = r.findings.filter((x) => x.kind === "v2_mon_mint_fee_charged");
    assert.equal(charged.length, 1, `findings: ${JSON.stringify(kindsOf(r))}`);
    assert.match(charged[0].message, /INTERFACE_VERSION 8 charges no writer rent/);
    assert.equal(kindsOf(r).filter((k) => k === "v2_mon_mint_fee_zero").length, 0, "the v7 alert must not fire on a v8 registry");
  });

  test("a payout contract of the wrong shape stops the route check instead of decoding it", async () => {
    const dir = scratch("monitor-v8-decode-");
    const chain = new FakeChain({ head: 20_000n });
    // The v7 adapter standing where interface 8 says the router is: it answers factory().
    chain.read = v8Read(chain, {
      factory: (address) => (address.toLowerCase() === C.payoutAdapter.toLowerCase() ? addr(0xfac) : undefined),
      routes: (address) => (address.toLowerCase() === C.payoutAdapter.toLowerCase() ? [addr(0x999), 3000] : undefined),
    });
    const r = await runOnce(options(dir, writeV8Registry(dir)), { viem: fakeViem(chain) });
    const decode = r.findings.filter((x) => x.kind === "v2_mon_route_decode");
    assert.equal(decode.length, 1, `findings: ${JSON.stringify(kindsOf(r))}`);
    assert.equal(r.checks.routes.status, "incomplete");
    assert.match(r.checks.routes.detail, /no route decoded/);
    // And crucially: nothing was decoded, so no route alert carries a venue-as-address.
    assert.deepEqual(r.findings.filter((x) => x.kind === "v2_mon_route_wiring"), []);
  });

  test("a route the registry does not match pages under its own key", async () => {
    const dir = scratch("monitor-v8-route-");
    const chain = new FakeChain({ head: 20_000n });
    chain.read = v8Read(chain, { routes: (address) => (address.toLowerCase() === C.payoutAdapter.toLowerCase() ? { venue: 1, fee: 500, tickSpacing: 0, v3Pool: addr(0x777), feeBps: 5 } : undefined) });
    const r = await runOnce(options(dir, writeV8Registry(dir)), { viem: fakeViem(chain) });
    // A report finding carries `id` ("<kind>:<key>"), not the raw key.
    const keys = r.findings.filter((x) => x.kind === "v2_mon_route_wiring").map((f) => f.id.split(":").pop());
    assert.deepEqual(new Set(keys), new Set(["venue", "fee", "tickSpacing"]), `keys: ${JSON.stringify(keys)}`);
    assert.ok(r.findings.some((f) => /routes over v3 on chain and the registry publishes v4/.test(f.message)));
  });

  test("a manager whose delays are not the manifest's pages, one alert per member", async () => {
    const dir = scratch("monitor-v8-mgr-");
    const chain = new FakeChain({ head: 20_000n });
    chain.read = v8Read(chain, { hasRole: (address) => (address.toLowerCase() === MANAGER8.toLowerCase() ? [true, 0] : undefined) });
    const r = await runOnce(options(dir, writeV8Registry(dir)), { viem: fakeViem(chain) });
    const wiring = r.findings.filter((x) => x.kind === "v2_mon_manager_wiring");
    // Exactly the published (holder, role) pairs whose manifest delay is not 0 can disagree with a chain
    // that reports 0 for every member — counted from the manifest, not from a number written here.
    const expected = Object.entries(ROLES.holders).flatMap(([, roles]) => roles).filter((name) => ROLES.delaysS[name] > 0).length;
    const delayFindings = wiring.filter((f) => f.id.endsWith(":delay"));
    assert.equal(delayFindings.length, expected, `delay findings: ${JSON.stringify(delayFindings.map((f) => f.id))}`);
    assert.ok(expected > 0, "the manifest must have at least one delayed holder, or this test proves nothing");
    assert.ok(wiring.every((f) => f.severity === "error"));
    assert.match(delayFindings[0].message, /delay IS the protection/);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/*  T-180: the v8 events that reached no branch at all                                               */
/* ------------------------------------------------------------------------------------------------ */

describe("v8: PayoutRouter route events", () => {
  const ROUTER = addr(0x0ce);
  const names = { [ROUTER.toLowerCase()]: "payoutRouter" };
  // NVDA publishes a v3 route; TSLA publishes NONE. TSLA is the case with no steady-state coverage at
  // all: checkRoute only compares a published route, so for TSLA a clear is indistinguishable from the
  // steady state and these events are the only record that anything happened.
  const markets = [
    { ticker: "NVDA", asset: U, v2: { payoutRoute: { venue: "v3", fee: 500, tickSpacing: null, poolId: null } } },
    { ticker: "TSLA", asset: V6.TSLA, v2: { payoutRoute: null } },
  ];
  const ctx = { names, clearinghouse: V6.CH, settlementOracle: ORACLE, markets, dataStreamsListed: [] };
  const one = (log) => adminEventFindings([log], "100", ctx);
  const routerSet = (asset, over = {}) =>
    v6log("RouterRouteSet", ROUTER, { asset, venue: 1, poolId: `0x${"0".repeat(64)}`, fee: 500, feeBps: 5, ...over });
  const cleared = (asset) => v6log("RouteCleared", ROUTER, { asset });

  test("a RouterRouteSet that matches the registry warns, and every disagreement pages error", () => {
    assert.deepEqual(kinds(one(routerSet(U))), ["v2_mon_route_changed/warn"]);
    assert.match(one(routerSet(U))[0].message, /payoutRouter\.RouteSet\(NVDA, venue v3, fee 500, 5 bps\).*registry route/);
    // venue, fee tier, and the ceiling the Clearinghouse can count
    assert.deepEqual(kinds(one(routerSet(U, { venue: 2 }))), ["v2_mon_route_changed/error"]);
    assert.match(one(routerSet(U, { venue: 2 }))[0].message, /registry publishes v3 and the route is now v4/);
    assert.deepEqual(kinds(one(routerSet(U, { fee: 3000 }))), ["v2_mon_route_changed/error"]);
    assert.deepEqual(kinds(one(routerSet(U, { fee: 10_001 }))), ["v2_mon_route_changed/error"]);
    assert.match(one(routerSet(U, { fee: 10_001 }))[0].message, /above 10000/);
    // an asset the registry does not list, and one it lists with no route
    assert.deepEqual(kinds(one(routerSet(V6.ADMIN))), ["v2_mon_route_changed/error"]);
    assert.deepEqual(kinds(one(routerSet(V6.TSLA))), ["v2_mon_route_changed/error"]);
    assert.match(one(routerSet(V6.TSLA))[0].message, /publishes no payout route for TSLA/);
    // a cached fee the Clearinghouse cannot fully count is a warn, not silence
    assert.deepEqual(kinds(one(routerSet(U, { feeBps: 250 }))), ["v2_mon_route_changed/warn"]);
    assert.match(one(routerSet(U, { feeBps: 250 }))[0].message, /counts at most 100/);
  });

  test("venue none through setRoute is the same outcome as a clear, and is judged the same way", () => {
    assert.deepEqual(kinds(one(routerSet(U, { venue: 0 }))), ["v2_mon_route_changed/error"]);
    assert.match(one(routerSet(U, { venue: 0 }))[0].message, /paid in Stock Tokens instead of USDG/);
    assert.deepEqual(kinds(one(routerSet(V6.TSLA, { venue: 0 }))), ["v2_mon_route_changed/warn"]);
  });

  test("RouteCleared pages for BOTH markets, and the unpublished one is the whole point", () => {
    const published = one(cleared(U));
    assert.deepEqual(kinds(published), ["v2_mon_route_changed/error"]);
    assert.match(published[0].message, /payoutRouter\.RouteCleared\(NVDA\).*paid in Stock Tokens instead of USDG/);

    // THE CASE WITH NO OTHER COVERAGE. The periodic checkRoute is silent here by design — assert that,
    // so this test fails if someone ever decides the event branch is redundant.
    assert.deepEqual(checkRoute({ ticker: "TSLA", asset: V6.TSLA, route: { venue: 0, fee: 0, tickSpacing: 0, feeBps: 0 }, registryRoute: null, poolId: null }), [],
      "checkRoute says nothing about a cleared route on a market with no published route: the event branch is the only coverage");
    const unpublished = one(cleared(V6.TSLA));
    assert.deepEqual(kinds(unpublished), ["v2_mon_route_changed/warn"]);
    assert.match(unpublished[0].message, /only record that it happened/);
  });

  test("both v8 names stay in DEDICATED_EVENTS, so the catch-all never double-pages them", () => {
    assert.ok(DEDICATED_EVENTS.has("RouterRouteSet") && DEDICATED_EVENTS.has("RouteCleared"));
    assert.equal(CONFIG_EVENTS.RouterRouteSet, undefined);
    assert.equal(CONFIG_EVENTS.RouteCleared, undefined);
    assert.deepEqual(configEventFindings([routerSet(U), cleared(U)], "100", names), [],
      "configEventFindings must stay silent: these have a kind of their own");
  });
});

describe("v8: a refused buyback is not a stuck one", () => {
  const now = 1_800_000_000;
  const fly = () => ({ lastDistributedAt: null, pendingSince: null, floorMisses: {}, lastBoughtBackAt: null, fundedSince: null, lastSkip: null });
  const skipLog = (reason) => ({ eventName: "BuybackSkipped", args: { reason: `0x${Buffer.from(reason).toString("hex").padEnd(64, "0")}` }, transactionHash: `0x${"c".repeat(64)}` });
  const stuck = { splitter: SPLITTER, now, balance: 60_000_000n, lastBuybackAt: null, fundedSince: now - DEFAULTS.buybackStuckS - 1, lastSkip: null, unburned: [] };

  test("applyFlywheelLogs REMEMBERS BuybackSkipped instead of dropping it", () => {
    const f = fly();
    applyFlywheelLogs(f, [skipLog("EMPTY")], now, SPLITTER);
    assert.deepEqual(f.lastSkip, { reason: "EMPTY", at: now });
    // a buy that went through answers every refusal before it
    applyFlywheelLogs(f, [{ eventName: "BoughtBack", args: { usdgIn: 1n, tokenOut: 1n }, transactionHash: `0x${"d".repeat(64)}` }, { eventName: "Burned", args: { amount: 1n }, transactionHash: `0x${"d".repeat(64)}` }], now + 1, SPLITTER);
    assert.equal(f.lastSkip, null);
  });

  test("a fresh skip re-aims the page at the dial, and names the right operation", () => {
    const empty = checkBuyback({ ...stuck, lastSkip: { reason: "EMPTY", at: now - 60 } }, DEFAULTS);
    assert.deepEqual(kinds(empty), ["v2_mon_buyback_skipped/error"]);
    assert.match(empty[0].message, /the zero is buybackCap.*switched OFF by configuration.*Do not chase the cranker/s);
    assert.match(empty[0].message, /setBuybackCap is FEE_MANAGER at a 48 h delay/);
    assert.equal(empty[0].data.reason, "EMPTY");

    const noexec = checkBuyback({ ...stuck, lastSkip: { reason: "NO_EXECUTOR", at: now - 60 } }, DEFAULTS);
    assert.deepEqual(kinds(noexec), ["v2_mon_buyback_skipped/error"]);
    assert.match(noexec[0].message, /setBuybackExecutor \/ setToken are TREASURY_ADMIN at a 24 h delay/);
  });

  test("a STALE skip is still stuck: the contract refused once and then nothing called again", () => {
    const old = checkBuyback({ ...stuck, lastSkip: { reason: "EMPTY", at: now - DEFAULTS.buybackStuckS - 1 } }, DEFAULTS);
    assert.deepEqual(kinds(old), ["v2_mon_buyback_stuck/warn"]);
    assert.match(old[0].message, /older than the .* window, so the contract refused once and then nothing called again/);
    // and with no skip at all, the page says so rather than implying coverage it does not have
    const none = checkBuyback(stuck, DEFAULTS);
    assert.deepEqual(kinds(none), ["v2_mon_buyback_stuck/warn"]);
    assert.match(none[0].message, /emitted no BuybackSkipped, so nothing has called buyback\(\)/);
    assert.match(none[0].message, /dry-running cranker .* looks exactly like a stopped one from here/);
  });

  test("the stuck clock ages from when THIS balance was funded, not from the previous buyback", () => {
    // Funded 7 h ago, last bought 1 h ago. Ageing from the buyback gives 1 h and says nothing; ageing
    // from the funding gives 7 h, past the 6 h threshold, and pages.
    const x = { splitter: SPLITTER, now, balance: 60_000_000n, lastBuybackAt: now - 3600, fundedSince: now - 25_200, lastSkip: null, unburned: [] };
    const out = checkBuyback(x, DEFAULTS);
    assert.deepEqual(kinds(out), ["v2_mon_buyback_stuck/warn"]);
    assert.equal(out[0].data.ageS, 25_200, "the age is measured from fundedSince");
    // fundedSince unknown falls back to the last buyback rather than inventing an age
    assert.deepEqual(checkBuyback({ ...x, fundedSince: null }, DEFAULTS), [], "1 h since the last buy is not stuck");
  });
});

describe("v8: our own Safes are not the feed owner's", () => {
  const owners = [addr(1), addr(2), addr(3)];
  const base = (ctx) => checkSafe(undefined, { nonce: 1n, threshold: 2n, owners }, ctx).baseline;

  test("a protocol Safe pages under its own kinds, group and runbook", () => {
    const ctx = { safe: ADMIN_SAFE, label: "Admin Safe", feeds: [], protocol: true };
    const prev = base(ctx);
    const nonce = checkSafe(prev, { nonce: 2n, threshold: 2n, owners }, ctx).findings;
    assert.deepEqual(kinds(nonce), ["v2_mon_protocol_safe_nonce_changed/info"]);
    assert.equal(nonce[0].check, "config", "not the feeds group");
    assert.match(nonce[0].message, /This is OUR multisig/);
    assert.ok(!/Usually another feed/.test(nonce[0].message), "the feed body must not reach our Safes");

    const cfg = checkSafe(prev, { nonce: 1n, threshold: 1n, owners }, ctx).findings;
    assert.deepEqual(kinds(cfg), ["v2_mon_protocol_safe_config_changed/error"]);
    assert.equal(cfg[0].check, "config");
    assert.match(cfg[0].message, /Changing who signs for this protocol/);
    assert.ok(KINDS.v2_mon_protocol_safe_config_changed.runbook.includes("§V55"));
  });

  test("the feed owner Safe is unchanged: same kinds, same group, same body", () => {
    const ctx = { safe: ADMIN_SAFE, feeds: ["NVDA"] };
    const prev = base(ctx);
    const nonce = checkSafe(prev, { nonce: 2n, threshold: 2n, owners }, ctx).findings;
    assert.deepEqual(kinds(nonce), ["v2_mon_safe_nonce_changed/info"]);
    assert.equal(nonce[0].check, "feeds");
    assert.match(nonce[0].message, /^Feed owner Safe .* \(NVDA\) executed a transaction.*Usually another feed/);
    const cfg = checkSafe(prev, { nonce: 1n, threshold: 1n, owners }, ctx).findings;
    assert.deepEqual(kinds(cfg), ["v2_mon_safe_config_changed/warn"]);
    assert.equal(cfg[0].check, "feeds");
  });
});

/* -------------------------------------------------------------------------------------------------
 * T-239: the ops-only publication packet.
 *
 * These guard ops/runbooks/ops-only-publication.md's `publication-manifest` block, which
 * ops/go-live-v2.sh --check-public-ref reads. They live in this file because T-239's scope names it
 * and no other test file; they are about the runbook, not about monitor.mjs.
 * ---------------------------------------------------------------------------------------------- */
describe("ops-only publication manifest", () => {
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const RUNBOOK = path.join(REPO_ROOT, "ops", "runbooks", "ops-only-publication.md");

  /** The same block the shell gate parses, parsed the same way. */
  const manifest = () => {
    const block = readFileSync(RUNBOOK, "utf8").match(/```publication-manifest\n([\s\S]*?)```/);
    assert.ok(block, "ops-only-publication.md has no ```publication-manifest block");
    const lists = {};
    for (const line of block[1].split("\n")) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const at = line.indexOf(":");
      assert.ok(at > 0, `malformed manifest line: ${JSON.stringify(line)}`);
      lists[line.slice(0, at).trim()] = line.slice(at + 1).trim().split(/\s+/).filter(Boolean);
    }
    return lists;
  };

  test("the block parses and carries a core list and a monitor list", () => {
    const lists = manifest();
    assert.ok(Array.isArray(lists.core) && lists.core.length > 0, "core: is missing or empty");
    assert.ok(Array.isArray(lists.monitor) && lists.monitor.length > 0, "monitor: is missing or empty");
  });

  test("EVERY PATH THE PACKET NAMES EXISTS IN THIS REPOSITORY", () => {
    // A packet that names a file nobody has cannot be published, and the shell gate would report it
    // as "absent from the public ref" -- which reads as "not published yet" when the truth is
    // "does not exist anywhere". This is the check that tells those two apart.
    const lists = manifest();
    const missing = [];
    for (const [name, paths] of Object.entries(lists)) {
      for (const rel of paths) {
        try {
          readFileSync(path.join(REPO_ROOT, rel));
        } catch {
          missing.push(`${name}: ${rel}`);
        }
      }
    }
    assert.deepEqual(missing, [], `the packet names paths that do not exist here: ${missing.join(", ")}`);
  });

  test("the manifest names no secret-bearing path", () => {
    // The runbook's own rule: no ops/v2/env-dev/*, no bot key files, no .env carrying a value.
    const offending = Object.values(manifest())
      .flat()
      .filter((rel) => /(^|\/)\.env$|env-dev|\.callhouse-keys|\.key$|secret/i.test(rel));
    assert.deepEqual(offending, [], `the packet would publish secret-bearing paths: ${offending.join(", ")}`);
  });
});
