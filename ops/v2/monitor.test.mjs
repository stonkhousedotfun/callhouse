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
  CONFIG_EVENTS,
  DEDICATED_EVENTS,
  DEFAULTS,
  DEFAULT_REGISTRY,
  KINDS,
  KIND_RE,
  MAX_TENOR,
  MIN_SERIES_LEAD,
  PINS_DIRTY_EVENTS,
  RANK,
  SCAN_EVENTS,
  UsageError,
  adminEventFindings,
  alertPayload,
  applyScanLogs,
  checkBacklog,
  checkExpiry,
  checkFeedMismatch,
  checkFeedProxy,
  checkFeedStale,
  checkHeadLag,
  checkHealth,
  checkMarketOracle,
  checkMintFee,
  checkMintRent,
  checkPendingFees,
  checkPinSimulation,
  checkPinnedBy,
  checkPinnedConfig,
  checkPool,
  checkRewards,
  checkRollerAsk,
  checkRoundJumps,
  checkSafe,
  checkStockToken,
  checkUsdg,
  checkVault,
  checkVaultOutflow,
  closeOfDay,
  configEventFindings,
  decodePinRevert,
  emptyState,
  exitCodeFor,
  expectedPinnedConfig,
  feeRises,
  feeScheduledFindings,
  finding,
  fixed,
  gridCloses,
  isRevert,
  isTradingDay,
  loadViem,
  mapLimit,
  marketsInScope,
  modelSpendPerExpiry,
  multiplierEventFindings,
  observedSpend,
  parseArgs,
  parseRegistry,
  pinTargets,
  prePinFindings,
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
} from "./monitor.mjs";
import { C, FakeChain, SRC, addr, defaultRead, fakeViem, kindsOf, market, options, rawLog, tmp, transportError, writeRegistry } from "./fake-chain.mjs";

const U = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const ORACLE = "0x4b8c2BEFfecbdc4BeD6e6826e62093F0Cf635E78";
const CL = "0x157f589Cd9d0E4a94C9936ede3b23BEfa3017F20";
const UNI = "0x5d46388aD462fF7f92587fE4872e97668e98329d";
const E = 1_789_675_200;
const t = { ...DEFAULTS };
const kinds = (fs) => fs.map((f) => `${f.kind}/${f.severity}`).sort();

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
    const at = (t) => BigInt(t + 86_400);
    const A = { ...FEES, premiumFeeBps: 600 };
    const B = { ...FEES, premiumFeeBps: 700 };
    const Cf = { ...FEES, premiumFeeBps: 300 };
    const ctor = v6log("FeeParamsSet", V6.BOOK, { params: FEES });
    const sA = v6log("FeeParamsScheduled", V6.BOOK, { params: A, effectiveAt: at(1000) });
    const sB = v6log("FeeParamsScheduled", V6.BOOK, { params: B, effectiveAt: at(2000) }); // replaces A before it is due
    const sC = v6log("FeeParamsScheduled", V6.BOOK, { params: Cf, effectiveAt: at(2000 + 90_000) }); // after B is due
    const out = applyScanLogs(scan, [ctor, sA, sB, sC], v6addresses);
    const before = out.filter((e) => e.eventName === "FeeParamsScheduled").map((e) => e.feesBefore.premiumFeeBps);
    assert.deepEqual(before, [500, 500, 700]);
    assert.deepEqual(scan.fees, { current: B, pending: Cf, effectiveAt: 2000 + 90_000 + 86_400 });
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

describe("v7: the hand-written ABIs match the exported ones", () => {
  const viem = loadViem();
  // Which compiled ABI each hand-written view list belongs to. The rest (ERC-20, USDG, the Stock Token, the
  // Chainlink proxy, the Safe, the pool) are third-party contracts with no artifact of ours.
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
  };

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
    for (const name of Object.values(OURS).concat(["UniV3PayoutAdapter", "RewardsDistributor", "MakerRegistry"])) {
      for (const e of abiJson(name)) if (e.type === "event") emitted.add(sigOf(e));
    }
    for (const item of viem.parseAbi(SCAN_EVENTS)) {
      assert.ok(emitted.has(sigOf(item)), `no v2 contract emits ${sigOf(item)}`);
    }
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
    assert.deepEqual(scan.roller[key], { w: W, u: U, e: E });
    applyScanLogs(scan, [log("StaleAskCancelled", AR, { writer: W, underlying: U, longId: 84n, orderId: 7n, spot: 6n, updatedAt: 1n }, 21, 0)], addresses);
    assert.deepEqual(scan.roller[key], { w: W, u: U, e: E }, "the position survives its ask");
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
    assert.deepEqual(kindsOf(r2), ["v2_mon_config_changed"]);
  });

  test("a 429 on the anchor read keeps the scan state: nothing is adopted and no baseline is wiped", async () => {
    const { r2, s2 } = await anchorRun({ anchorReadFails: true });
    assert.deepEqual(kindsOf(r2), ["v2_mon_config_changed"], "the RoleGranted must still page");
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
    assert.deepEqual(kindsOf(r), ["v2_mon_pool_wiring", "v2_mon_pool_wiring"], "one for the pool, one for the floor");
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
      assert.deepEqual(blind.sent.map((s) => `${s.kind}/${s.delivered}/${s.logged}`), ["v2_mon_config_changed/false/true"]);
      assert.equal(blind.deliveryFailures, 0, "nowhere to send is not a delivery failure");
      assert.equal(blind.exit, 1, "and must not raise the exit code to 4");

      chain.setHead(20_100n, chain.head.timestamp + 4);
      const wired = await runOnce(options(dir, registry, [], { ALERT_WEBHOOK: `http://127.0.0.1:${port}/alert` }), { viem: fakeViem(chain) });
      assert.deepEqual(
        wired.sent.map((s) => `${s.kind}/${s.reason}/${s.delivered}`),
        ["v2_mon_config_changed/retry/true"],
      );
      assert.deepEqual(received, ["v2_mon_config_changed"]);
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
      assert.deepEqual(received, ["v2_mon_pool_liquidity_low"], `one pool ±1 % around its floor over four passes: ${JSON.stringify(received)}`);
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
    assert.deepEqual(kindsOf(r), ["v2_mon_vault_outflow"]);
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
    assert.deepEqual(kindsOf(r1), [], "one pass over the strike is not evidence yet");
    const s1 = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.deepEqual(s1.scan.rollerStale[`${W}:${U2}`], { orderId: "7", since: now });

    chain.setHead(20_100n, now + 120);
    const r2 = await runOnce(opts, { viem: fakeViem(chain) });
    assert.deepEqual(kindsOf(r2), ["v2_mon_roller_ask_overtaken"]);
    assert.equal(r2.findings[0].severity, "error");
    assert.match(r2.findings[0].message, /NVDA \(call 200\.00, 5\.00 shares left.*at or past its strike for 2 min/);

    // The cranker cancels it: the ask is gone, the alert resolves, and the timer is dropped.
    live = false;
    chain.setHead(20_200n, now + 180);
    const r3 = await runOnce(opts, { viem: fakeViem(chain) });
    assert.deepEqual(kindsOf(r3), []);
    const s3 = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(s3.alerts[`v2_mon_roller_ask_overtaken:${W.toLowerCase()}:${U2.toLowerCase()}`], undefined, "the condition closes when the ask is gone");
    assert.deepEqual(s3.scan.rollerStale, {});
    assert.ok(s3.scan.roller[`${W.toLowerCase()}:${U2.toLowerCase()}`] !== undefined, "the position stays tracked until its expiry is long past");
  });
});

/* -------------------------------------------------------------------------------------------------
 * The always-on loop, as a real child process.
 * ------------------------------------------------------------------------------------------------- */
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
