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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";

import {
  ABI_TEXT,
  ACTIONS,
  applyOracleHaltLogs,
  CHAINLINK_MAX_ROUND_JUMP_BPS,
  CHAINLINK_MAX_STALE,
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
  REPRICE_PAGE_DROP_BPS,
  MAX_ROUTE_FEE_BPS,
  MAX_TENOR,
  MIN_SAFE_THRESHOLD,
  MIN_SERIES_LEAD,
  OWN_KIND_EVENTS,
  PIN_EVENTS,
  PINS_DIRTY_EVENTS,
  RANK,
  ROLE_MANIFEST,
  SCAN_EVENTS,
  SOURCE_DEFAULTS,
  SPLITTER_EVENTS,
  FEE_SPLITTER_NOT_PAGED,
  UNIV3_WINDOW,
  UsageError,
  ZERO,
  applyFlywheelLogs,
  buybackClock,
  checkBuyback,
  checkManagerWiring,
  // Launch-only keys and House limits.
  applyHouseLimits,
  HOUSE_LIMIT_FIELDS,
  HOUSE_VAULT_SCAN_SIGNATURES,
  houseLimitsDirection,
  MANAGER_PUBLIC_ROLE,
  managerTargets,
  manifestRoleAt,
  publishedHolders,
  applyManagerMembership,
  checkManagerMembers,
  checkFeedExpiryGap,
  MANAGER_MEMBER_EVENTS,
  managerDelayPhase,
  checkRoute,
  checkRouteDecode,
  checkSafeThreshold,
  checkSplitter,
  checkTokenPool,
  checkTvl,
  tvlFaults,
  DAILY_WEEKDAYS,
  houseNoSeriesByDesign,
  listsDailyOnWeekday,
  loadRoleManifest,
  managerEventFindings,
  parsePayoutRoute,
  reasonText,
  SKIP_REASON_HASHES,
  HELD_RESOLVE_DELAY,
  roleDelayS,
  roleLabel,
  routeCurrencies,
  routeVenueName,
  v4PoolId,
  adminEventFindings,
  repriceFindings,
  alertPayload,
  applyScanLogs,
  checkJitFunding,
  fundingTurnedOn,
  jitFundingEventFindings,
  JIT_FUNDING_EMITTER,
  JIT_FUNDING_EVENTS,
  JIT_FUNDING_REMEDY,
  inKindPayoutFindings,
  earnPullFindings,
  earnSkimRefusedFindings,
  earnWriteOffFindings,
  otherSourcePrices,
  bandMismatch,
  intendedBandCheck,
  parseChainlinkBand,
  CHAINLINK_NO_BAND,
  bandOf,
  checkBacklog,
  checkExpiry,
  checkGuardianVeto,
  guardianBy,
  FINALIZE_DELAY,
  noteOutage,
  outagesOverlapping,
  SETTLEMENT_WINDOW,
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
  checkEventRecheck,
  checkSourceAges,
  checkSourceSwitch,
  checkSafe,
  checkStockToken,
  checkUsdg,
  checkHouseEpoch,
  checkHouseVaultState,
  HOUSE_TRACKED_PAGE,
  checkHouseBoundaryPin,
  checkHouseBoundaryLock,
  UNPINNED_BOUNDARY_HOLD,
  heldResolve,
  iso,
  checkWindowDivergence,
  expectedHouseKind,
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
  paidBounties,
  parseArgs,
  parseRegistry,
  pinTargets,
  probeTargets,
  prePinFindings,
  readFairAnswer,
  reconcile,
  formatReport,
  nextPassDelayMs,
  markDelivered,
  marketStretch,
  NYSE_FULL_HOLIDAYS,
  openMarketSeconds,
  resolvedFinding,
  revertDataOf,
  roundIdsToRead,
  runOnce,
  registryHouseVaults,
  sameAddress,
  scanEventName,
  unknownPricingReasons,
  fallbackStatePath,
  newerState,
  checkPoolWiring,
  checkUnsettledSeries,
  EXECUTOR_FEE_REFUSALS,
  PIN_REVERTS,
  witnessReading,
  WITNESS_MAX_AGE,
} from "./monitor.mjs";
import { V2_INTENDED_CHAINLINK_BANDS } from "../markets/build-markets.mjs";
import { C, FakeChain, SRC, USDG, addr, defaultRead, fakeViem, kindsOf, market, options, rawLog, revertError, tmp, transportError, viem, writeRegistry } from "./fake-chain.mjs";

/**
 * The deps of a pass against a FakeChain, on the CHAIN's clock. runOnce takes the wall clock from
 * `deps.nowMs` (monitor.mjs runOnce), and every head-lag, staleness and age check measures against it. A fixture
 * head is fixed (FakeChain defaults to 1_790_000_000), so on the real clock it fell further behind every day: once
 * it was 900 s old every whole pass added v2_mon_l2_lag, and once it was an hour old the TVL check called its own
 * balances stale, and every assertion on exact kinds went red on the calendar rather than on the code. The wall
 * clock here IS the head's time, so a pass reads the chain as live; a test that means lag moves the head itself.
 */
const onChain = (chain) => ({ viem: fakeViem(chain), nowMs: () => chain.head.timestamp * 1000 });

const U = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const ORACLE = "0x4b8c2BEFfecbdc4BeD6e6826e62093F0Cf635E78";
const CL = "0x157f589Cd9d0E4a94C9936ede3b23BEfa3017F20";
const UNI = "0x5d46388aD462fF7f92587fE4872e97668e98329d";
const E = 1_789_675_200;
const t = { ...DEFAULTS };
const kinds = (fs) => fs.map((f) => `${f.kind}/${f.severity}`).sort();

// A monitor change turned a DARK audit-trigger notice into a fault: with `auditTriggerUsdg` 0 and
// USDG actually held by the v2 contracts, `tvlFaults` now pages instead of staying silent, because
// "off with collateral in the contracts is the notice being dark exactly when it matters". Every
// fixture below that builds a registry holds USDG through `defaultRead`, so this kind is part of the
// truth of those passes and the exact-list assertions have to name it. Do NOT filter it out of
// `kindsOf` instead: filtering here is precisely the change that would hide the notice going dark in
// production, which is the condition this check exists to surface.
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

  // v9 SettlementOracle.adminResolve: a pinned expiry with no ok recorded price reverts
  // NoSource unless Held and TooEarly before expiry + 7 days. The page used to promise E + 48 h for every Held expiry.
  test("Held: when adminResolve can act follows the ok recorded prices", () => {
    assert.equal(HELD_RESOLVE_DELAY, 7 * 86_400);
    const held = (okCount) => checkExpiry(expiry({ status: "Held", candidate: cand(), now: E + 86_400, okCount }), t)[0];
    const none = held(0);
    assert.equal(none.data.resolvableAt, E + 7 * 86_400, "no ok price on a pinned expiry: only a week after expiry");
    assert.equal(none.data.okCount, 0);
    assert.match(none.message, /any price from .*no recorded source is ok.*T-SEC-B-03.*TooEarly/);
    const one = held(1);
    assert.equal(one.data.resolvableAt, E + 48 * 3600);
    assert.match(one.message, /inside maxDeviationBps of its one ok price, or inside the wider 0\.8x to 1\.25x band from /);
    const two = held(2);
    assert.equal(two.data.resolvableAt, E + 48 * 3600);
    assert.match(two.message, /inside the band of its 2 ok recorded prices/);
    // SettlementOracle._band widens for a Held expiry with ANY ok price from E + 7 d, not only one.
    assert.match(two.message, /or inside the wider 0\.8x to 1\.25x band of the lowest and highest of them from /);
    const unknown = held(null);
    assert.equal(unknown.data.resolvableAt, E + 48 * 3600, "earliest possible when the recording is unknown");
    assert.match(unknown.message, /if the resolve's own refresh records an ok price, else only from .*T-SEC-B-03/);
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

/*
 * The two operating rules for v9 both end in the GUARDIAN
 * vetoing before the expiry finalizes: a chain halt overlapping [E - 1800, E] (any market), and a pool-denied expiry (a
 * launch expiry's pool leg that did not record inside [E, E + 600]). v2_mon_guardian_veto_due names the expiry and the
 * deadline. The halt is only known from runs that saw the head lagging, so noteOutage keeps it in the state file.
 */
describe("guardian veto due", () => {
  const halt = (from, to) => ({ from, to, block: "1" });
  const veto = (over = {}) => ({ ...expiry({ now: E - 600, status: "None", candidate: null, snapshotRecordedAt: null }), launch: false, outages: [], ...over });

  test("the mirrored constants are V2Constants.sol's", () => {
    assert.equal(FINALIZE_DELAY, 120);
    assert.equal(SETTLEMENT_WINDOW, 1800);
  });

  test("noteOutage records a head lag above lagErrorS, extends the same halt, and forgets it after outageKeepS", () => {
    assert.deepEqual(noteOutage([], { headTimestamp: 1_000, headBlock: 9n, wallNow: 1_000 + 900 }, t), [], "at lagErrorS exactly: not a halt");
    const one = noteOutage([], { headTimestamp: 1_000, headBlock: 9n, wallNow: 1_901 }, t);
    assert.deepEqual(one, [{ from: 1_000, to: 1_901, block: "9" }]);
    const longer = noteOutage(one, { headTimestamp: 1_000, headBlock: 9n, wallNow: 2_500 }, t);
    assert.deepEqual(longer, [{ from: 1_000, to: 2_500, block: "9" }], "the same head is the same halt, extended");
    const resumed = noteOutage(longer, { headTimestamp: 2_600, headBlock: 10n, wallNow: 2_610 }, t);
    assert.deepEqual(resumed, longer, "a live head adds nothing and keeps what was seen");
    const second = noteOutage(resumed, { headTimestamp: 5_000, headBlock: 20n, wallNow: 6_000 }, t);
    assert.equal(second.length, 2, "a later halt is a second interval");
    assert.deepEqual(noteOutage(second, { headTimestamp: 2_500 + t.outageKeepS + 10, headBlock: 30n, wallNow: 2_500 + t.outageKeepS + 10 }, t),
      [{ from: 5_000, to: 6_000, block: "20" }], "the first halt is forgotten after outageKeepS");
  });

  test("an outage overlaps [E - 1800, E] only when it truly intersects it", () => {
    assert.equal(outagesOverlapping([halt(E - 3_000, E - 1_800)], E).length, 0, "ends at the window's start");
    assert.equal(outagesOverlapping([halt(E, E + 900)], E).length, 0, "the last block was at E: the window had blocks");
    assert.equal(outagesOverlapping([halt(E - 3_000, E - 1_799)], E).length, 1);
    assert.equal(outagesOverlapping([halt(E - 1, E + 900)], E).length, 1);
    assert.equal(outagesOverlapping([halt(E - 1_000, E - 900)], E).length, 1, "inside the window");
  });

  test("a halt overlapping the window pages the guardian with the expiry and the deadline, on any market", () => {
    const f = checkGuardianVeto(veto({ outages: [halt(E - 900, E + 300)] }));
    assert.deepEqual(kinds(f), ["v2_mon_guardian_veto_due/error"]);
    assert.equal(f[0].key, `${U.toLowerCase()}:${E}:halt`);
    assert.equal(f[0].data.ticker, "NVDA");
    assert.equal(f[0].data.expiry, E);
    assert.equal(f[0].data.finalizableAt, null, "no candidate before the first finalize");
    assert.equal(f[0].data.earliestFinalize, E + 120);
    assert.equal(f[0].data.reason, "chain-halt");
    assert.match(f[0].message, /GUARDIAN: veto\(underlying, expiry\) before its first finalize .*SEC8-12 F-2/);
    const pending = checkGuardianVeto(veto({ status: "Pending", candidate: cand(), outages: [halt(E - 900, E + 300)] }));
    assert.equal(pending[0].data.finalizableAt, cand().finalizableAt, "the candidate's finalizableAt when there is one");
  });

  test("After the lock the veto advice says to sign from the Admin Safe; before it the text is unchanged", () => {
    const before = checkGuardianVeto(veto({ outages: [halt(E - 900, E + 300)] }));
    const after = checkGuardianVeto(veto({ outages: [halt(E - 900, E + 300)], lockSeen: true }));
    assert.match(before[0].message, /\. GUARDIAN: veto\(underlying, expiry\)/);
    assert.doesNotMatch(before[0].message, /Admin Safe/);
    assert.match(after[0].message, /GUARDIAN \(the Admin Safe: after the lock the guardian key holds no GUARDIAN, owner R4; sign it from the Admin Safe\): veto\(underlying, expiry\)/);
    assert.deepEqual(after[0].data, before[0].data, "only the advice changes; the page and its data do not");
    assert.equal(after[0].key, before[0].key);
  });

  test("guardianBy names the Admin Safe only once this monitor has seen the lock", () => {
    assert.equal(guardianBy(false), "GUARDIAN");
    assert.equal(guardianBy(undefined), "GUARDIAN");
    assert.match(guardianBy(true), /^GUARDIAN \(the Admin Safe: .*owner R4; sign it from the Admin Safe\)$/);
  });

  test("a halt that does not overlap the window pages nothing (the overlap condition)", () => {
    assert.deepEqual(checkGuardianVeto(veto({ outages: [halt(E - 7_200, E - 3_600)] })), []);
    assert.deepEqual(checkGuardianVeto(veto({ outages: [halt(E + 60, E + 3_600)] })), []);
  });

  test("nothing without open interest, once Finalized, or once Held (the veto landed)", () => {
    const o = [halt(E - 900, E + 300)];
    assert.deepEqual(checkGuardianVeto(veto({ outages: o, openInterest: 0n })), []);
    assert.deepEqual(checkGuardianVeto(veto({ outages: o, status: "Finalized" })), []);
    assert.deepEqual(checkGuardianVeto(veto({ outages: o, status: "Held" })), []);
  });

  test("A launch expiry whose pool leg recorded nothing inside [E, E + 600] pages the guardian", () => {
    const denied = veto({ launch: true, now: E + 601, snapshotRecordedAt: 0, status: "Pending", candidate: cand() });
    const f = checkGuardianVeto(denied);
    assert.deepEqual(kinds(f), ["v2_mon_guardian_veto_due/error"]);
    assert.equal(f[0].key, `${U.toLowerCase()}:${E}:pool`);
    assert.equal(f[0].data.reason, "pool-leg-denied");
    assert.equal(f[0].data.finalizableAt, cand().finalizableAt);
    assert.match(f[0].message, /no Recorded event from the pool source.*B-03 operating rule/);
    assert.deepEqual(checkGuardianVeto({ ...denied, launch: false }), [], "not a launch market");
    assert.deepEqual(checkGuardianVeto({ ...denied, now: E + 600 }), [], "inside the grace");
    assert.deepEqual(checkGuardianVeto({ ...denied, snapshotRecordedAt: E + 30 }), [], "the pool recorded");
    assert.deepEqual(checkGuardianVeto({ ...denied, snapshotRecordedAt: null }), [], "not read");
    assert.deepEqual(checkGuardianVeto({ ...denied, sources: [CL] }), [], "the pool is not a source of this expiry");
    assert.deepEqual(checkGuardianVeto({ ...denied, status: "Held" }), [], "already vetoed");
  });

  // A weekend drill: both feeds silent, the page told the guardian to compare the Chainlink price
  // and unveto, but there was no Chainlink price. With no source pricing the window it must say veto now and when
  // adminResolve opens, the same timing heldResolve gives the Held page.
  test("Pool leg missed AND no Chainlink window price: veto now, adminResolve at E + 7 d, never unveto", () => {
    const denied = veto({ launch: true, now: E + 601, snapshotRecordedAt: 0, status: "Pending", candidate: cand(), chainlinkSource: CL });
    const priced = checkGuardianVeto({ ...denied, chainlinkWindowOk: true });
    assert.equal(priced[0].data.reason, "pool-leg-denied", "Chainlink prices the window: compare, then unveto or resolve");
    assert.match(priced[0].message, /compare the Chainlink price .* then unveto/);
    assert.equal(checkGuardianVeto({ ...denied, chainlinkWindowOk: null })[0].data.reason, "pool-leg-denied", "not read: the old text");
    const f = checkGuardianVeto({ ...denied, chainlinkWindowOk: false });
    assert.deepEqual(kinds(f), ["v2_mon_guardian_veto_due/error"]);
    assert.equal(f[0].key, `${U.toLowerCase()}:${E}:pool`, "the same key: one condition, better text");
    assert.equal(f[0].data.reason, "no-source-prices");
    assert.equal(f[0].data.resolvableAt, E + HELD_RESOLVE_DELAY);
    assert.equal(f[0].data.okCount, 0);
    assert.match(f[0].message, /No source prices this expiry: veto now, before finalizableAt .*; adminResolve opens at 2026-09-24T20:00:00Z \(expiry \+ 7 d\)/);
    assert.match(f[0].message, /do not unveto/);
    assert.doesNotMatch(f[0].message, /then unveto/);
    assert.equal(checkGuardianVeto({ ...denied, chainlinkWindowOk: null, okCount: 0 })[0].data.reason, "no-source-prices", "a capture that recorded no ok source");
    assert.equal(checkGuardianVeto({ ...denied, chainlinkWindowOk: null, sources: [UNI] })[0].data.reason, "no-source-prices", "the pool was the only source");
  });

  test("both rules on one expiry are two keys, so each clears on its own", () => {
    const both = checkGuardianVeto(veto({ launch: true, now: E + 601, snapshotRecordedAt: 0, outages: [halt(E - 900, E + 300)] }));
    assert.deepEqual(both.map((f) => f.key).sort(), [`${U.toLowerCase()}:${E}:halt`, `${U.toLowerCase()}:${E}:pool`]);
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

  // KeeperRewards.reward pays min(bounty(action), maxBounty) (KeeperRewards.sol:162-163): the model
  // costs what is paid, not the stored table, and a maxBounty of 0 pays nothing for any action.
  test("The runway model costs min(bounty, maxBounty), what reward() pays", () => {
    assert.deepEqual(paidBounties(bounties, 20_000n), { SNAPSHOT: 20_000n, FINALIZE: 20_000n, SETTLE: 20_000n, REDEEM: 20_000n, ROLL: 20_000n });
    assert.equal(paidBounties(bounties, null), bounties);
    // 15 USDG: 14 expiries at the stored table (1.05 USDG each), 22 at what a 0.02 USDG ceiling pays (0.66 USDG each).
    const clamped = checkRewards({ ...base, balance: 15_000_000n, maxBounty: 20_000n }, t);
    assert.equal(clamped.perExpiry, 20_000n + 40_000n + 200_000n + 400_000n);
    assert.equal(clamped.runway, 22n);
    assert.deepEqual(clamped.findings, []);
    // No maxBounty (an older KeeperRewards, or unread): the stored table, as before.
    assert.deepEqual(kinds(checkRewards({ ...base, balance: 15_000_000n, maxBounty: null }, t).findings), ["v2_mon_rewards_budget_low/warn"]);
  });

  test("maxBounty 0 pages rewards_cap: no bounty is paid although the table is set", () => {
    const zero = checkRewards({ ...base, maxBounty: 0n }, t);
    assert.deepEqual(kinds(zero.findings), ["v2_mon_rewards_cap/warn"]);
    assert.equal(zero.findings[0].key, `${base.address.toLowerCase()}:max-bounty-zero`);
    assert.match(zero.findings[0].message, /maxBounty\(\) is 0: reward\(\) pays min\(bounty, maxBounty\)/);
    assert.equal(zero.runway, null);
    // An empty table with a 0 ceiling pays nothing by design: no page.
    const none = { SNAPSHOT: 0n, FINALIZE: 0n, SETTLE: 0n, REDEEM: 0n, ROLL: 0n };
    assert.deepEqual(checkRewards({ ...base, bounties: none, maxBounty: 0n }, t).findings, []);
    // A ceiling at or above every bounty changes nothing.
    assert.deepEqual(checkRewards({ ...base, maxBounty: 1_000_000n }, t).findings, []);
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

describe("house vault epoch stall", () => {
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
    // Held exposure blocks only on a series that is NOT settled; rollEpoch redeems a settled one first (below).
    const held = checkHouseEpoch({ ...base, series: [{ ...base.series[0], settled: false, longs: 300n }] }, t);
    assert.deepEqual(held[0].data.blockers, ["NVDA call 222.50 2027-01-15T21:00:00Z is not settled", "NVDA call 222.50 2027-01-15T21:00:00Z still holds 3.00 long"]);
  });

  // HouseVault.rollEpoch runs _redeemSettled() BEFORE _requireFlat() (the order in
  // callhouse-contracts HouseVault.sol): a SETTLED tracked series the vault still holds longs or shorts of is redeemed inside
  // the roll, so it is not a refusal. Only its live orders still block (_scan counts them, and nothing cancels them).
  test("A settled series the vault still holds is redeemed by rollEpoch itself, so it is not a stall", () => {
    assert.deepEqual(checkHouseEpoch({ ...base, series: [{ ...base.series[0], longs: 300n, shorts: 200n }] }, t), []);
    const live = checkHouseEpoch({ ...base, series: [{ ...base.series[0], longs: 300n, live: 1 }] }, t);
    assert.deepEqual(kindsOf(live), ["v2_mon_house_epoch_stall/error"]);
    assert.deepEqual(live[0].data.blockers, ["NVDA call 222.50 2027-01-15T21:00:00Z still holds 1 live order"]);
  });

  test("an unfinalized boundary price is a blocker; an UNREAD one is not", () => {
    const unfinalized = checkHouseEpoch({ ...base, boundary: { finalized: false, price: 0n } }, t);
    assert.deepEqual(kindsOf(unfinalized), ["v2_mon_house_epoch_stall/error"]);
    assert.match(unfinalized[0].data.blockers[0], /settlement price is not Finalized/);
    assert.equal(unfinalized[0].data.boundaryFinalized, false);
    // null = the read failed. Paging for a condition the pass never observed is the defect this test removes.
    assert.deepEqual(checkHouseEpoch({ ...base, boundary: null }, t), []);
  });

  test("A price the oracle is already finalizing is a WARN that asks for no quoter or Safe action", () => {
    const cand = { price: 222_500_000n, disagreed: false, finalizableAt: END + 21_600 };
    const pending = { finalized: false, price: 0n, status: "Pending", candidate: cand };
    const f = checkHouseEpoch({ ...base, boundary: pending }, t);
    assert.deepEqual(kindsOf(f), ["v2_mon_house_epoch_stall/warn"]);
    assert.equal(f[0].key, `${HV.toLowerCase()}:7`, "the same alert key as the ERROR, so a later veto escalates it");
    const at = new Date((END + 21_600) * 1000).toISOString().replace(".000Z", "Z");
    assert.ok(f[0].message.includes(`finalizes at ${at} (in 4.0 h) unless the guardian vetoes it`), f[0].message);
    assert.match(f[0].message, /No quoter or Safe action is needed/);
    assert.doesNotMatch(f[0].message, /2-of-3 admin Safe/);
    assert.equal(f[0].data.selfClearing, true);
    assert.equal(f[0].data.candidateFinalizableAt, END + 21_600);
    const late = checkHouseEpoch({ ...base, now: END + 30_000, boundary: pending }, t);
    assert.match(late[0].message, /has been finalizable since .*anyone may call SettlementOracle\.finalize/);
    assert.equal(late[0].severity, "warn");
  });

  test("No candidate, a disagreed or Held one, or any series blocker keeps the ERROR and the Safe text", () => {
    const cand = { price: 222_500_000n, disagreed: false, finalizableAt: END + 21_600 };
    const cases = {
      "no candidate": { finalized: false, price: 0n, status: "Pending", candidate: null },
      "status None": { finalized: false, price: 0n, status: "None", candidate: null },
      disagreed: { finalized: false, price: 0n, status: "Pending", candidate: { ...cand, disagreed: true } },
      held: { finalized: false, price: 0n, status: "Held", candidate: cand },
      "no status read": { finalized: false, price: 0n },
    };
    for (const [name, boundary] of Object.entries(cases)) {
      const f = checkHouseEpoch({ ...base, boundary }, t);
      assert.deepEqual(kindsOf(f), ["v2_mon_house_epoch_stall/error"], name);
      assert.match(f[0].message, /2-of-3 admin Safe/, name);
    }
    const withSeries = checkHouseEpoch({ ...base, boundary: { finalized: false, price: 0n, status: "Pending", candidate: cand }, series: [{ ...base.series[0], live: 1 }] }, t);
    assert.deepEqual(kindsOf(withSeries), ["v2_mon_house_epoch_stall/error"], "a live order is not self-clearing");
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
          // A settled series' shorts are redeemed by rollEpoch itself; its live order is the blocker.
          { longId: "9", label: "NVDA put 200.00 2027-01-15T21:00:00Z", exists: true, settled: true, longs: 0n, shorts: 500n, live: 1 },
        ],
      },
      t,
    );
    assert.equal(f.length, 1);
    assert.equal(f[0].data.blockers.length, 4);
    assert.equal(f[0].data.blockers[2], "NVDA put 200.00 2027-01-15T21:00:00Z still holds 1 live order");
    assert.equal(f[0].data.trackedSeries, 2);
  });
});

// With --house / MONITOR_HOUSE_VAULTS empty the house check reported itself skipped on
// every pass, although the launch writes each House vault back into markets[].v2.house.
describe("The House vaults the registry records", () => {
  test("registryHouseVaults: daily then weekly, each address once, nothing for an empty slot", () => {
    const D = addr(0xda11);
    const W = addr(0x3eec);
    const reg = {
      markets: [
        { ticker: "nvda", v2: { house: { weekly: W, daily: D } } },
        { ticker: "SPCX", v2: { house: { weekly: null, daily: null } } },
        { ticker: "TSLA", v2: null },
        { ticker: "AMD", v2: { house: { weekly: D, daily: ZERO } } },
      ],
    };
    assert.deepEqual(registryHouseVaults(reg), [{ ticker: "NVDA", address: D }, { ticker: "NVDA", address: W }]);
    assert.deepEqual(registryHouseVaults({ markets: [] }), []);
    assert.deepEqual(registryHouseVaults(null), []);
  });

  test("the shipped registry's House vaults are the ones go-live hands the monitor as MONITOR_HOUSE_VAULTS", () => {
    const raw = JSON.parse(readFileSync(DEFAULT_REGISTRY, "utf8"));
    const reg = parseRegistry(raw, DEFAULT_REGISTRY);
    const fromRaw = [];
    for (const m of raw.markets) for (const a of [m.v2?.house?.daily, m.v2?.house?.weekly]) if (typeof a === "string" && !sameAddress(a, ZERO) && !fromRaw.some((x) => sameAddress(x, a))) fromRaw.push(a);
    assert.deepEqual(registryHouseVaults(reg).map((h) => h.address.toLowerCase()), fromRaw.map((a) => a.toLowerCase()));
  });
});

describe("The House boundary lock and the week a roll is held", () => {
  const E = 1_790_003_600;
  const HV = addr(0x4a12);
  const x = { address: HV, ticker: "NVDA", oracle: C.settlementOracle, epochId: 7n, epochEnd: E, now: E - 3600, pinnedBoundary: 0, exposed: true };
  const kinds = (f) => f.map((y) => `${y.kind}/${y.severity}`);

  test("UNPINNED_BOUNDARY_HOLD mirrors HouseVault.UNPINNED_BOUNDARY_HOLD (7 days; the contract-mirrors guard checks the value)", () => {
    assert.equal(UNPINNED_BOUNDARY_HOLD, 604_800);
  });

  test("v2_mon_house_boundary_unlocked: an exposed boundary the vault did not lock, before its end, at warn", () => {
    const f = checkHouseBoundaryLock(x);
    assert.deepEqual(kinds(f), ["v2_mon_house_boundary_unlocked/warn"], "v2_mon_house_boundary_unlocked must page before the end");
    assert.equal(f[0].key, `${HV.toLowerCase()}:${E}`);
    assert.equal(f[0].check, "house");
    assert.equal(f[0].data.heldUntil, E + UNPINNED_BOUNDARY_HOLD);
    assert.match(f[0].message, /BoundaryPinFailed/);
    assert.match(f[0].message, new RegExp(`refuse TooEarly until ${new Date((E + UNPINNED_BOUNDARY_HOLD) * 1000).toISOString().slice(0, 16)}`));
    assert.deepEqual(kinds(checkHouseBoundaryLock({ ...x, pinnedBoundary: E - 604_800 })), ["v2_mon_house_boundary_unlocked/warn"], "a lock of the PREVIOUS boundary is not this one's");
  });

  test("v2_mon_house_roll_held: from the end until end + 7 days, at error; nothing after the hold", () => {
    assert.deepEqual(kinds(checkHouseBoundaryLock({ ...x, now: E })), ["v2_mon_house_roll_held/error"], "v2_mon_house_roll_held must page at the end");
    const last = checkHouseBoundaryLock({ ...x, now: E + UNPINNED_BOUNDARY_HOLD - 1 });
    assert.deepEqual(kinds(last), ["v2_mon_house_roll_held/error"]);
    assert.match(last[0].message, /rollEpoch is HELD until/);
    assert.deepEqual(checkHouseBoundaryLock({ ...x, now: E + UNPINNED_BOUNDARY_HOLD }), [], "the hold is over: the roll goes through, and a roll that does not is the stall check's");
  });

  test("never on a locked boundary, an unexposed vault, or a value this pass did not read", () => {
    assert.deepEqual(checkHouseBoundaryLock({ ...x, pinnedBoundary: E }), [], "locked");
    assert.deepEqual(checkHouseBoundaryLock({ ...x, pinnedBoundary: E, now: E + 60 }), [], "locked, after the end");
    assert.deepEqual(checkHouseBoundaryLock({ ...x, exposed: false }), [], "nothing exposed: the first deposit pins it");
    assert.deepEqual(checkHouseBoundaryLock({ ...x, exposed: null }), [], "exposure unread");
    assert.deepEqual(checkHouseBoundaryLock({ ...x, pinnedBoundary: null }), [], "pinnedBoundary unread (a vault built before T-OP-866)");
    assert.deepEqual(checkHouseBoundaryLock({ ...x, epochEnd: 0 }), [], "no epoch yet");
  });

  test("After the lock both pages name the Admin Safe as GUARDIAN; before it the text is unchanged", () => {
    for (const [now, kind] of [[E - 3600, "v2_mon_house_boundary_unlocked"], [E, "v2_mon_house_roll_held"]]) {
      const before = checkHouseBoundaryLock({ ...x, now });
      const after = checkHouseBoundaryLock({ ...x, now, lockSeen: true });
      assert.deepEqual([before.length, after.length, before[0].kind, after[0].kind], [1, 1, kind, kind]);
      assert.match(before[0].message, /; the GUARDIAN cancels any scheduled setMarket of NVDA/, kind);
      assert.doesNotMatch(before[0].message, /Admin Safe/, kind);
      assert.match(after[0].message, /; the GUARDIAN \(the Admin Safe: after the lock the guardian key holds no GUARDIAN, owner R4; sign it from the Admin Safe\) cancels any scheduled setMarket of NVDA/, kind);
      assert.deepEqual([after[0].key, after[0].severity, after[0].data], [before[0].key, before[0].severity, before[0].data], "only the advice changes");
    }
  });
});

describe("An unpinned House boundary and a launch window's source divergence", () => {
  const E = 1_790_003_600;
  const HV = addr(0x4a11);
  const NVDA = market("NVDA", 1, { pool: addr(0x9001), floor: "1" });
  const SPCX = market("SPCX", 2, { pool: addr(0x9002), floor: "1" });
  const pin = { address: HV, ticker: "NVDA", underlying: NVDA.asset, oracle: C.settlementOracle, epochId: 7n, epochEnd: E, now: E - 1800, pinned: false, status: "None" };
  const kinds = (f) => f.map((x) => `${x.kind}/${x.severity}`);

  test("v2_mon_house_boundary_unpinned: pages from the mint cutoff E - 1800 until Finalized, never on a pin or an unread value", () => {
    const f = checkHouseBoundaryPin(pin);
    assert.deepEqual(kinds(f), ["v2_mon_house_boundary_unpinned/warn"], "v2_mon_house_boundary_unpinned must page at the mint cutoff");
    assert.equal(f[0].key, `${HV.toLowerCase()}:${E}`);
    assert.equal(f[0].check, "house");
    assert.equal(f[0].data.earliestFinalize, E + 120);
    assert.equal(f[0].data.resolvableFrom, E + 48 * 3600);
    assert.match(f[0].message, /NOT pinned/);
    assert.deepEqual(checkHouseBoundaryPin({ ...pin, now: E - 1801 }), [], "v2_mon_house_boundary_unpinned: a mint can still pin it before the cutoff");
    assert.deepEqual(checkHouseBoundaryPin({ ...pin, pinned: true }), [], "v2_mon_house_boundary_unpinned: a pinned boundary has a frozen configuration");
    assert.deepEqual(checkHouseBoundaryPin({ ...pin, now: E + 600, status: "Finalized" }), [], "v2_mon_house_boundary_unpinned: a Finalized boundary has nothing left to resolve");
    assert.deepEqual(kinds(checkHouseBoundaryPin({ ...pin, now: E + 3600, status: "Held" })), ["v2_mon_house_boundary_unpinned/warn"], "v2_mon_house_boundary_unpinned: Held and unpinned: setMarket still reaches it");
    assert.deepEqual(checkHouseBoundaryPin({ ...pin, pinned: null }), [], "an unread pin is not judged");
    assert.deepEqual(checkHouseBoundaryPin({ ...pin, status: null }), [], "an unread status is not judged");
  });

  // callhouse-contracts SettlementOracle.adminResolve: the veto-and-week gate
  // now covers an unpinned expiry too. What still reaches an unpinned boundary is SettlementOracle.setMarket, which applies
  // to every expiry not pinned and not captured (SettlementOracle.sol setMarket NatSpec, _configOf). The pinned-boundary lock closes it.
  test("The page follows the contract rule: the veto-and-week gate covers the unpinned boundary, setMarket still reaches it", () => {
    const f = checkHouseBoundaryPin(pin);
    assert.deepEqual(kinds(f), ["v2_mon_house_boundary_unpinned/warn"], "reworded, not retired");
    assert.doesNotMatch(f[0].message, /does not cover an unpinned expiry/, "T-OP-831: the gate covers it now");
    assert.doesNotMatch(f[0].message, new RegExp(`at any price from ${iso(E + 48 * 3600)}`), "no unbounded resolve from E + 48 h");
    assert.ok(f[0].message.includes(`adminResolve needs a veto (Held) and waits until ${iso(E + HELD_RESOLVE_DELAY)}, pinned or not (T-OP-831)`), f[0].message);
    assert.match(f[0].message, /CONFIG_ADMIN SettlementOracle\.setMarket for NVDA \(a MarketConfigured log\) before then changes the sources and band it settles on \(T-OP-866\)/);
    assert.match(f[0].message, /Until it is Finalized, the GUARDIAN cancels any scheduled setMarket of NVDA, and any scheduled adminResolve of this expiry/);
    // The Held page's no-price timing says the same for any expiry.
    assert.match(heldResolve({ expiry: E, okCount: 0 }).how, /an expiry with no price, pinned or not, resolves only once Held and a week after expiry \(T-SEC-B-03, T-OP-831/);
  });

  test("v2_mon_house_boundary_unpinned: a boundary with no series by design (SPCX Monday to Thursday) pages only once it fails to finalize", () => {
    const spcx = { ...pin, ticker: "SPCX", noSeriesByDesign: true };
    for (const now of [E - 1800, E, E + 120, E + 1799]) {
      assert.deepEqual(checkHouseBoundaryPin({ ...spcx, now }), [], `no page at ${now - E} s: nothing could ever pin a boundary no series is listed at, and it can still finalize`);
    }
    const f = checkHouseBoundaryPin({ ...spcx, now: E + 1800, status: "Held" });
    assert.deepEqual(kinds(f), ["v2_mon_house_boundary_unpinned/warn"], "still unpinned and not Finalized 30 min after its close: the unbounded adminResolve exposure is live");
    assert.match(f[0].message, /no series is listed at this boundary by design \(SPCX lists no daily expiries: expiriesAhead\.daily 0\)/);
    assert.doesNotMatch(f[0].message, /minting closed/);
    assert.equal(f[0].data.noSeriesByDesign, true);
    assert.deepEqual(checkHouseBoundaryPin({ ...spcx, now: E + 1800, status: "Finalized" }), [], "a Finalized boundary has nothing left to resolve");
    assert.deepEqual(checkHouseBoundaryPin({ ...spcx, now: E + 1800, pinned: true }), [], "a pinned one is covered by the gate");
    assert.deepEqual(checkHouseBoundaryPin({ ...spcx, now: E + 3600 }, { ...DEFAULTS, houseEpochStallS: 7200 }), [], "the threshold is the stall check's own houseEpochStallS");
    // A boundary that has series (the Friday one) keeps the cutoff page.
    assert.equal(checkHouseBoundaryPin({ ...spcx, noSeriesByDesign: false }).length, 1);
    assert.equal(checkHouseBoundaryPin({ ...pin, now: E - 1800 })[0].data.noSeriesByDesign, false);
  });

  test("The committed registry lists NVDA dailies on mon, wed, fri; an NVDA Tue/Thu House boundary has no series by design", () => {
    const reg = parseRegistry(JSON.parse(readFileSync(DEFAULT_REGISTRY, "utf8")), DEFAULT_REGISTRY);
    const v2 = (ticker) => reg.markets.find((m) => m.ticker === ticker)?.v2;
    assert.deepEqual(v2("NVDA").dailyWeekdays, ["mon", "wed", "fri"]);
    assert.deepEqual(v2("SPCX").dailyWeekdays, DAILY_WEEKDAYS, "SPCX takes v2.defaults");
    assert.equal(parseRegistry({ markets: [{ ticker: "X", v2: {} }] }).markets[0].v2.dailyWeekdays, null, "unknown is null, never a restriction");
    assert.throws(() => parseRegistry({ markets: [{ ticker: "X", v2: { overrides: { dailyWeekdays: ["sat"] } } }] }), /markets\[0\] \(X\)\.v2\.overrides\.dailyWeekdays must be a non-empty list of distinct weekdays \(mon, tue, wed, thu, fri\), not \["sat"\]/);
    // 16:00 New York closes, Monday 2026-09-28 .. Friday 2026-10-02.
    const close = (month, day) => Date.UTC(2026, month, day, 20, 0, 0) / 1000;
    const [mon, tue, wed, thu, fri] = [close(8, 28), close(8, 29), close(8, 30), close(9, 1), close(9, 2)];
    assert.deepEqual([mon, tue, wed, thu, fri].map((e) => listsDailyOnWeekday(v2("NVDA").dailyWeekdays, e)), [true, false, true, false, true]);
    assert.equal(listsDailyOnWeekday(null, tue), true, "not known restricts nothing");
    assert.deepEqual(houseNoSeriesByDesign(v2("NVDA"), tue, false), { noSeriesByDesign: true, byDesignReason: "lists dailies on mon, wed, fri only" });
    assert.deepEqual(houseNoSeriesByDesign(v2("NVDA"), thu, false).noSeriesByDesign, true);
    assert.deepEqual(houseNoSeriesByDesign(v2("NVDA"), wed, false), { noSeriesByDesign: false }, "a listed day keeps the cutoff page");
    assert.deepEqual(houseNoSeriesByDesign(v2("NVDA"), tue, true), { noSeriesByDesign: false }, "a series the scan saw overrides it");
    assert.deepEqual(houseNoSeriesByDesign(v2("SPCX"), tue, false), { noSeriesByDesign: true }, "SPCX: no dailies at all (T-OP-702)");
    assert.deepEqual(houseNoSeriesByDesign(null, tue, false), { noSeriesByDesign: false });
    const f = checkHouseBoundaryPin({ ...pin, ticker: "NVDA", now: E + 1800, status: "Held", ...houseNoSeriesByDesign(v2("NVDA"), tue, false) });
    assert.deepEqual(kinds(f), ["v2_mon_house_boundary_unpinned/warn"]);
    assert.match(f[0].message, /no series is listed at this boundary by design \(NVDA lists dailies on mon, wed, fri only\)/);
    assert.deepEqual(checkHouseBoundaryPin({ ...pin, ticker: "NVDA", now: E - 1800, ...houseNoSeriesByDesign(v2("NVDA"), tue, false) }), [], "no cutoff page on an unlisted Tuesday");
  });

  test("The committed registry gives SPCX no daily expiries and NVDA the default six", () => {
    const reg = parseRegistry(JSON.parse(readFileSync(DEFAULT_REGISTRY, "utf8")), DEFAULT_REGISTRY);
    const daily = (ticker) => reg.markets.find((m) => m.ticker === ticker)?.v2?.dailyExpiriesAhead;
    assert.equal(daily("SPCX"), 0, "SPCX overrides.expiriesAhead.daily is 0: its House boundaries Monday to Thursday have no series");
    assert.equal(daily("NVDA"), 6, "NVDA takes v2.defaults.expiriesAhead.daily");
    assert.equal(parseRegistry({ markets: [{ ticker: "X", v2: {} }] }).markets[0].v2.dailyExpiriesAhead, null, "unknown is null, never 0");
  });

  const win = { ticker: "NVDA", underlying: NVDA.asset, oracle: C.settlementOracle, expiry: E, status: "None", phase: "closed", maxDeviationBps: 150, feed: { ok: true, price: 100_000_000n }, reference: { ok: true, price: 101_500_000n, what: "pool" } };

  test("v2_mon_window_divergence: the oracle's own _agree rule and the expiry's own maxDeviationBps", () => {
    // SettlementOracle._agree: (hi - lo) x 10_000 <= lo x maxDeviationBps. 1.5 % of the lower price is exactly 150 bps.
    assert.deepEqual(checkWindowDivergence(win), [], "v2_mon_window_divergence: exactly at maxDeviationBps the oracle corroborates");
    assert.deepEqual(checkWindowDivergence({ ...win, feed: { ok: true, price: 101_500_000n }, reference: { ok: true, price: 100_000_000n, what: "pool" } }), [], "v2_mon_window_divergence: the rule is symmetric, over the LOWER price");
    const f = checkWindowDivergence({ ...win, reference: { ok: true, price: 101_500_001n, what: "pool" } });
    assert.deepEqual(kinds(f), ["v2_mon_window_divergence/error"], "v2_mon_window_divergence must page one unit past maxDeviationBps");
    assert.equal(f[0].key, `${NVDA.asset.toLowerCase()}:${E}`);
    assert.equal(f[0].check, "window");
    assert.equal(f[0].data.gapBps, 150);
    assert.equal(f[0].data.earliestFinalize, E + 120);
    assert.deepEqual(checkWindowDivergence({ ...win, maxDeviationBps: 200, reference: { ok: true, price: 101_900_000n, what: "pool" } }), [], "v2_mon_window_divergence: the bound is the value read, not 150");
    const bad = { ...win, reference: { ok: true, price: 110_000_000n, what: "pool" } };
    assert.equal(checkWindowDivergence(bad).length, 1);
    assert.deepEqual(checkWindowDivergence({ ...bad, status: "Finalized" }), [], "too late to veto");
    assert.deepEqual(checkWindowDivergence({ ...bad, status: "Held" }), [], "already vetoed");
    assert.deepEqual(checkWindowDivergence({ ...bad, feed: { ok: false, price: 0n } }), [], "no Chainlink window price, nothing compared");
    assert.deepEqual(checkWindowDivergence({ ...bad, reference: { ok: false, price: 0n, what: "pool" } }), [], "no reference, nothing compared");
    assert.deepEqual(checkWindowDivergence({ ...bad, feed: { ok: true, price: 0n } }), [], "a zero price is not a price");
  });

  /**
   * One House vault for NVDA with its boundary at `e` (E unless given), on a chain whose head is `now`.
   * `markets` is the registry's list; `ownOracle` is an oracle() of the vault's own, which answers the boundary's
   * pin while the published oracle reads it pinned (so a pin read on the published one pages nothing); `pinFails` makes
   * the vault oracle's settlementConfig at the boundary fail; `weekly` and `feeOwed` answer weekly() and performanceFeeOwed();
   * `fail` maps a House vault view to "transport" (a 429) or "revert" (a view the vault does not have).
   */
  function pass(dir, { now, pinned = false, status = 0, feed = [true, 100_000_000n], poolWindow = [false, 0n], poolLatest = [true, 100_000_000n, 0n], maxDev = 150, launch = null, wall = null, tracked = [], lock = null, markets = [NVDA], e = E, ownOracle = null, pinFails = false, weekly = false, feeOwed = 0n, fail = {}, publishedStatus = 0 }) {
    const registry = writeRegistry(dir, { markets });
    const chain = new FakeChain({ timestamp: now });
    const feedCalls = [];
    const vaultOracle = ownOracle ?? C.settlementOracle;
    chain.read = (address, fn, args) => {
      const a = address.toLowerCase();
      if (a === HV.toLowerCase()) {
        if (fail[fn] === "transport") throw transportError();
        if (fail[fn] === "revert") throw revertError(`the vault has no ${fn}`);
        const v = { epochEnd: e, epochId: 7n, trackedSeries: tracked, underlying: NVDA.asset, oracle: vaultOracle, weekly, performanceFeeOwed: feeOwed }[fn];
        if (v !== undefined) return v;
        // `lock` = { pinnedBoundary, supply } answers the boundary-lock views; null leaves them unanswered (pre-866).
        const l = lock === null ? {} : { pinnedBoundary: lock.pinnedBoundary, totalSupply: lock.supply, pendingDepositUsdg: 0n, pendingDepositStock: 0n };
        if (l[fn] !== undefined) return l[fn];
        // An older vault has no pinnedBoundary(). defaultRead answers it 0, so refuse it here,
        // the way the chain does: a revert (any other failure is a read that did not happen).
        if (lock === null && fn === "pinnedBoundary") throw revertError(`a pre-T-OP-866 House vault has no ${fn}`);
      }
      if (a === vaultOracle.toLowerCase() && Number(args?.[1]) === e) {
        if (fn === "settlementConfig") {
          if (pinFails) throw transportError();
          return [pinned, [SRC.chainlink, SRC.univ3], maxDev, 21600, 3600];
        }
        if (fn === "settlementInfo") return [status, status === 2 ? 222_000_000n : 0n, 0, status === 2, false, status === 2];
      }
      if (ownOracle !== null && a === C.settlementOracle.toLowerCase() && Number(args?.[1]) === e) {
        if (fn === "settlementConfig") return [true, [SRC.chainlink, SRC.univ3], maxDev, 21600, 3600];
        // The epoch stall reads the PUBLISHED oracle; `publishedStatus` (default 0, as before) and
        // `fail.publishedSettlementInfo` reach that read alone, apart from the pin reads on the vault's own oracle.
        if (fn === "settlementInfo") {
          if (fail.publishedSettlementInfo === "transport") throw transportError();
          return [publishedStatus, publishedStatus === 2 ? 222_000_000n : 0n, 0, publishedStatus === 2, false, publishedStatus === 2];
        }
      }
      if (a === SRC.chainlink.toLowerCase() && fn === "windowPrice") {
        feedCalls.push(args.map(Number));
        return feed;
      }
      if (a === SRC.univ3.toLowerCase() && fn === "windowPrice") return poolWindow;
      if (a === SRC.univ3.toLowerCase() && fn === "latest") return poolLatest;
      return defaultRead(chain, address, fn, args);
    };
    const extra = ["--house", `NVDA=${HV}`, ...(launch === null ? [] : ["--launch", launch])];
    // `wall` moves the wall clock away from the head (a warped devnet): null keeps them equal, as onChain does.
    const deps = wall === null ? onChain(chain) : { ...onChain(chain), nowMs: () => wall * 1000 };
    return runOnce(options(dir, registry, extra), deps).then((report) => ({ report, feedCalls }));
  }
  const found = (report, kind) => report.findings.filter((f) => f.kind === kind);

  test("a whole pass: the House boundary pin is read on the vault's own oracle and pages from the mint cutoff", async () => {
    const dir = tmp("monitor-592-pin-");
    // The vault's oracle() is NOT the published one, and the
    // published one reads the boundary pinned: a pin read there instead of on the vault's own oracle pages nothing.
    const OWN = addr(0x7c30);
    try {
      const before = (await pass(dir, { now: E - 1801, ownOracle: OWN })).report;
      assert.equal(before.checks.house.status, "ok");
      assert.equal(found(before, "v2_mon_house_boundary_unpinned").length, 0, "v2_mon_house_boundary_unpinned: not before the mint cutoff");
      const at = (await pass(dir, { now: E - 1800, ownOracle: OWN })).report;
      const f = found(at, "v2_mon_house_boundary_unpinned");
      assert.equal(f.length, 1, "v2_mon_house_boundary_unpinned must page at the mint cutoff, read on the vault's own oracle()");
      assert.match(f[0].message, /NOT pinned on the vault's oracle 0x0000…7c30/, "read on the vault's own oracle(), not the published 0x0000…00c3");
      assert.equal(found((await pass(dir, { now: E - 1800, ownOracle: OWN, pinned: true })).report, "v2_mon_house_boundary_unpinned").length, 0, "v2_mon_house_boundary_unpinned: pinned");
      assert.equal(found((await pass(dir, { now: E + 600, ownOracle: OWN, status: 2 })).report, "v2_mon_house_boundary_unpinned").length, 0, "v2_mon_house_boundary_unpinned: Finalized");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // runOnce reads pinnedBoundary() and the exposure views and hands them to checkHouseBoundaryLock.
  test("a whole pass: an exposed boundary the vault did not lock pages unlocked (warn) before its end and held (error) after, even when a mint pinned the expiry", async () => {
    const dir = tmp("monitor-886-lock-");
    try {
      const unlocked = (await pass(dir, { now: E - 7200, pinned: true, lock: { pinnedBoundary: 0, supply: 5n } })).report;
      const u = found(unlocked, "v2_mon_house_boundary_unlocked");
      assert.equal(u.length, 1, "v2_mon_house_boundary_unlocked must page for an exposed boundary the vault did not lock");
      assert.equal(u[0].severity, "warn");
      assert.equal(found(unlocked, "v2_mon_house_boundary_unpinned").length, 0, "the ORACLE's pin (a mint) is a different fact: that check stays quiet");
      const locked = (await pass(dir, { now: E - 7200, pinned: true, lock: { pinnedBoundary: E, supply: 5n } })).report;
      assert.equal(found(locked, "v2_mon_house_boundary_unlocked").length, 0, "v2_mon_house_boundary_unlocked: locked at epochEnd");
      const empty = (await pass(dir, { now: E - 7200, pinned: true, lock: { pinnedBoundary: 0, supply: 0n } })).report;
      assert.equal(found(empty, "v2_mon_house_boundary_unlocked").length, 0, "v2_mon_house_boundary_unlocked: nothing exposed, the first deposit pins it");
      const held = (await pass(dir, { now: E + 3600, pinned: true, status: 2, lock: { pinnedBoundary: 0, supply: 5n } })).report;
      const h = found(held, "v2_mon_house_roll_held");
      assert.equal(h.length, 1, "v2_mon_house_roll_held must page once the held boundary has ended");
      assert.equal(h[0].severity, "error");
      assert.match(h[0].message, new RegExp(`rollEpoch is HELD until ${new Date((E + UNPINNED_BOUNDARY_HOLD) * 1000).toISOString().slice(0, 16)}`), "the hold end runOnce judged");
      const old = (await pass(dir, { now: E - 7200, pinned: true })).report;
      assert.equal(found(old, "v2_mon_house_boundary_unlocked").length, 0, "a vault without pinnedBoundary() is not judged");
      // The house check's own note: the vouch read of the same view notes it too ("house pin: ..."), and that
      // note alone must not pass this line.
      assert.ok(old.notes.some((n) => /^house: NVDA pinnedBoundary\(\) could not be read/.test(n)), "and the pass says so");
      assert.equal(old.checks.house.status, "ok", "a pre-T-OP-866 vault does not make the house check incomplete");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // runOnce hands checkHouseBoundaryLock `lockSeen` from state.managerLock; a unit test
  // of the check alone stays green if that argument is dropped, so the advice is proved through a whole pass.
  test("a whole pass: once this monitor has recorded the lock, the House boundary lock's advice names the Admin Safe as GUARDIAN", async () => {
    const dir = tmp("monitor-1031-lock-advice-");
    try {
      const first = (await pass(dir, { now: E - 7200, pinned: true, lock: { pinnedBoundary: 0, supply: 5n } })).report;
      const u0 = found(first, "v2_mon_house_boundary_unlocked");
      assert.equal(u0.length, 1);
      assert.doesNotMatch(u0[0].message, /Admin Safe/, "no lock recorded: the advice is unchanged");
      const file = path.join(dir, "state.json");
      const st = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(st.managerLock, null);
      writeFileSync(file, JSON.stringify({ ...st, managerLock: { block: "900", at: E - 86_400 } }));
      const after = (await pass(dir, { now: E - 7200, pinned: true, lock: { pinnedBoundary: 0, supply: 5n } })).report;
      const u1 = found(after, "v2_mon_house_boundary_unlocked");
      assert.equal(u1.length, 1);
      assert.match(u1[0].message, /the GUARDIAN \(the Admin Safe: after the lock the guardian key holds no GUARDIAN, owner R4; sign it from the Admin Safe\) cancels/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // runOnce itself hands checkHouseVaultState the vault's trackedSeries().length; a unit test
  // of the check alone stays green if that argument is dropped, so the page is proved through a whole pass.
  test("a whole pass: a House vault tracking HOUSE_TRACKED_PAGE (38) series pages v2_mon_house_tracked_high; 37 does not", async () => {
    const dir = tmp("monitor-844-tracked-");
    try {
      const ids = (n) => Array.from({ length: n }, (_, i) => BigInt(2 * (i + 1)));
      const at = (await pass(dir, { now: E - 7200, pinned: true, tracked: ids(HOUSE_TRACKED_PAGE) })).report;
      const f = found(at, "v2_mon_house_tracked_high");
      assert.equal(f.length, 1, `v2_mon_house_tracked_high must page at ${HOUSE_TRACKED_PAGE} tracked series in a whole pass`);
      assert.match(f[0].message, new RegExp(`tracks ${HOUSE_TRACKED_PAGE} series \\(trackedSeries\\(\\)\\)`), "the count runOnce read");
      const below = (await pass(dir, { now: E - 7200, pinned: true, tracked: ids(HOUSE_TRACKED_PAGE - 1) })).report;
      assert.equal(found(below, "v2_mon_house_tracked_high").length, 0, `v2_mon_house_tracked_high: not at ${HOUSE_TRACKED_PAGE - 1}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a whole pass: the stall check reads settlementInfo as the array viem returns, so a Finalized boundary is not a blocker", async () => {
    const dir = tmp("monitor-592-stall-");
    try {
      const finalized = (await pass(dir, { now: E + 3600, pinned: true, status: 2 })).report;
      assert.equal(found(finalized, "v2_mon_house_epoch_stall").length, 0, "a flat vault whose boundary is Finalized is not stalled");
      const pending = (await pass(dir, { now: E + 3600, pinned: true, status: 1 })).report;
      const stall = found(pending, "v2_mon_house_epoch_stall");
      assert.equal(stall.length, 1, "a boundary price that is not Finalized blocks the roll");
      assert.match(stall[0].message, /settlement price is not Finalized/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The header's TIME rule: protocol conditions use the head block's timestamp. rollEpoch judges
  // TooEarly on block.timestamp, so the stall is measured against the head, not the wall clock. A fork run measured
  // the old wall-clock read on a warped v9 fork: the stall could never be raised there.
  test("a whole pass: the stall is judged on the head block's timestamp, not the wall clock", async () => {
    const dir = tmp("monitor-703-clock-");
    try {
      const warped = (await pass(dir, { now: E + 3600, pinned: true, status: 1, wall: E - 7200 })).report;
      assert.equal(found(warped, "v2_mon_house_epoch_stall").length, 1, "a chain 1 h past epochEnd is stalled even while the wall clock is before it");
      assert.match(found(warped, "v2_mon_house_epoch_stall")[0].message, /epoch 7 ended 60 min ago/, "overdue is head - epochEnd");
      const behind = (await pass(dir, { now: E + 600, pinned: true, status: 1, wall: E + 7200 })).report;
      assert.equal(found(behind, "v2_mon_house_epoch_stall").length, 0, "a head 600 s past epochEnd is under houseEpochStallS, whatever the wall clock says");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a whole pass: v2_mon_window_divergence while the window runs, against the pool's latest TWAP", async () => {
    const dir = tmp("monitor-592-running-");
    try {
      const { report, feedCalls } = await pass(dir, { now: E - 600, pinned: true, poolLatest: [true, 103_000_000n, 0n] });
      assert.equal(report.checks.window.status, "ok");
      const f = found(report, "v2_mon_window_divergence");
      assert.equal(f.length, 1, "v2_mon_window_divergence must page on a 300 bps gap while the window runs");
      assert.match(f[0].message, /the part of the window already on chain/, "the running phase");
      assert.match(f[0].message, /differ by 300 bps/);
      assert.equal(f[0].severity, "error");
      assert.equal(feedCalls.length, 1, "one Chainlink window read for the one due expiry");
      assert.deepEqual(feedCalls[0].slice(1), [E - 1800, E - 600], "the Chainlink window is [E - 1800, now]");
      const agree = (await pass(dir, { now: E - 600, pinned: true, poolLatest: [true, 101_000_000n, 0n] })).report;
      assert.equal(found(agree, "v2_mon_window_divergence").length, 0, "v2_mon_window_divergence: 100 bps is inside 150");
      const early = (await pass(dir, { now: E - 1801, pinned: true, poolLatest: [true, 103_000_000n, 0n] })).report;
      assert.equal(found(early, "v2_mon_window_divergence").length, 0, "v2_mon_window_divergence: not before the window opens");
      // SPCX is IN the registry, so --launch SPCX names a launch market and the check reaches its filter;
      // with SPCX absent it returned "skipped" before the filter and this line proved nothing.
      const other = (await pass(dir, { now: E - 600, pinned: true, poolLatest: [true, 103_000_000n, 0n], launch: "SPCX", markets: [NVDA, SPCX] })).report;
      assert.equal(other.checks.window.status, "ok", JSON.stringify(other.checks.window));
      assert.match(other.checks.window.detail, /no launch expiry inside its settlement window/, "the NVDA boundary was dropped by the launch filter, not by a skip");
      assert.equal(found(other, "v2_mon_window_divergence").length, 0, "v2_mon_window_divergence: launch markets only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a whole pass: v2_mon_window_divergence after the close compares both sources' windowPrice over [E - 1800, E]", async () => {
    const dir = tmp("monitor-592-closed-");
    try {
      const unrecorded = (await pass(dir, { now: E + 60, pinned: true, poolWindow: [false, 0n], poolLatest: [true, 110_000_000n, 0n] })).report;
      assert.equal(found(unrecorded, "v2_mon_window_divergence").length, 0, "v2_mon_window_divergence: no pool snapshot yet, nothing compared (latest is not the window)");
      assert.match(unrecorded.checks.window.detail, /pool snapshot not recorded yet/);
      const { report, feedCalls } = await pass(dir, { now: E + 60, pinned: true, poolWindow: [true, 102_000_000n] });
      const f = found(report, "v2_mon_window_divergence");
      assert.equal(f.length, 1, "v2_mon_window_divergence must page on a 200 bps gap over the closed window");
      assert.match(f[0].message, /over the whole window/, "the closed phase");
      assert.match(f[0].message, /differ by 200 bps/);
      assert.deepEqual(feedCalls[0].slice(1), [E - 1800, E], "the Chainlink window is exactly the settlement window");
      assert.equal(found((await pass(dir, { now: E + 60, pinned: true, poolWindow: [true, 102_000_000n], maxDev: 250 })).report, "v2_mon_window_divergence").length, 0, "v2_mon_window_divergence: the bound is settlementConfig's maxDeviationBps");
      assert.equal(found((await pass(dir, { now: E + 60, pinned: true, status: 2, poolWindow: [true, 102_000_000n] })).report, "v2_mon_window_divergence").length, 0, "v2_mon_window_divergence: Finalized");
      assert.equal(found((await pass(dir, { now: E + 60, pinned: true, status: 3, poolWindow: [true, 102_000_000n] })).report, "v2_mon_window_divergence").length, 0, "v2_mon_window_divergence: Held");
      assert.equal(found((await pass(dir, { now: E + 86_401, pinned: true, poolWindow: [true, 102_000_000n] })).report, "v2_mon_window_divergence").length, 0, "v2_mon_window_divergence: past windowWatchS");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A failed settlementConfig read of the boundary is unread,
  // not "not pinned" and not "pinned": the house check reports incomplete, so reconcile keeps an open
  // v2_mon_house_boundary_unpinned (only a completed check resolves). The third pass is the positive control: the same
  // alert DOES resolve once the pin is read, so "still open" is the incomplete status, not an alert that never resolves.
  test("a whole pass: a failed House boundary pin read marks the house check incomplete and never resolves the open unpinned alert", async () => {
    const dir = tmp("monitor-979-pinread-");
    const id = `v2_mon_house_boundary_unpinned:${HV.toLowerCase()}:${E}`;
    const alerts = () => Object.keys(JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")).alerts);
    try {
      const open = (await pass(dir, { now: E - 1800 })).report;
      assert.equal(found(open, "v2_mon_house_boundary_unpinned").length, 1);
      assert.ok(alerts().includes(id), "the unpinned boundary is an open alert");
      const blind = (await pass(dir, { now: E - 1700, pinFails: true })).report;
      assert.equal(blind.checks.house.status, "incomplete", JSON.stringify(blind.checks.house));
      assert.ok(blind.notes.some((n) => /^house: NVDA settlementConfig\/settlementInfo\(.*\) could not be read .*the boundary pin is not judged/.test(n)), JSON.stringify(blind.notes));
      assert.equal(found(blind, "v2_mon_house_boundary_unpinned").length, 0, "an unread pin is not judged");
      assert.ok(alerts().includes(id), "a failed pin read must not resolve the open v2_mon_house_boundary_unpinned");
      const read = (await pass(dir, { now: E - 1600, pinned: true })).report;
      assert.equal(read.checks.house.status, "ok");
      assert.ok(!alerts().includes(id), "positive control: a pin that IS read resolves it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The House check's best-effort views (oracle(), pinnedBoundary() and the exposure reads, weekly(),
  // performanceFeeOwed()) used to be noted and skipped on ANY failure, and the check still completed: a 429 on the one view
  // an open alert rests on resolved it. A read that fails other than by reverting now marks the check incomplete. Each
  // alert: open it, fail its read with a transport error (still open), then read it clean (resolved: the positive control).
  test("a whole pass: a House view that fails other than by reverting keeps the house check incomplete, so no open House alert resolves on it", async () => {
    const dir = tmp("monitor-979-lost-");
    const alerts = () => Object.keys(JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")).alerts);
    const OWN = addr(0x7c30);
    const inWeeklySlot = [{ ...NVDA, v2: { ...NVDA.v2, house: { weekly: HV, daily: null } } }];
    const cases = [
      { alert: `v2_mon_house_boundary_unlocked:${HV.toLowerCase()}:${E}`, fn: "pinnedBoundary", base: { now: E - 7200, pinned: true, lock: { pinnedBoundary: 0, supply: 5n } }, clean: { lock: { pinnedBoundary: E, supply: 5n } } },
      { alert: `v2_mon_house_boundary_unlocked:${HV.toLowerCase()}:${E}`, fn: "totalSupply", base: { now: E - 7200, pinned: true, lock: { pinnedBoundary: 0, supply: 5n } }, clean: { lock: { pinnedBoundary: E, supply: 5n } } },
      { alert: `v2_mon_house_kind_mismatch:${HV.toLowerCase()}`, fn: "weekly", base: { now: E - 7200, pinned: true, markets: inWeeklySlot, weekly: false }, clean: { weekly: true } },
      { alert: `v2_mon_house_fee_owed:${HV.toLowerCase()}:7`, fn: "performanceFeeOwed", base: { now: E - 7200, pinned: true, feeOwed: 5_000_000n }, clean: { feeOwed: 0n } },
      { alert: `v2_mon_house_boundary_unpinned:${HV.toLowerCase()}:${E}`, fn: "oracle", base: { now: E - 1800, ownOracle: OWN }, clean: { pinned: true } },
    ];
    try {
      for (const c of cases) {
        rmSync(path.join(dir, "state.json"), { force: true });
        await pass(dir, c.base);
        assert.ok(alerts().includes(c.alert), `${c.fn}: ${c.alert} is open`);
        const blind = (await pass(dir, { ...c.base, fail: { [c.fn]: "transport" } })).report;
        assert.equal(blind.checks.house.status, "incomplete", `${c.fn}: ${JSON.stringify(blind.checks.house)}`);
        assert.ok(blind.notes.some((n) => n.startsWith(`house: NVDA ${c.fn === "totalSupply" ? "totalSupply/pendingDeposit*" : `${c.fn}()`} could not be read`)), `${c.fn}: ${JSON.stringify(blind.notes)}`);
        assert.ok(alerts().includes(c.alert), `${c.fn}: a ${c.fn} read that failed must not resolve ${c.alert}`);
        const clean = (await pass(dir, { ...c.base, ...c.clean })).report;
        assert.equal(clean.checks.house.status, "ok", `${c.fn}: ${JSON.stringify(clean.checks.house)}`);
        assert.ok(!alerts().includes(c.alert), `${c.fn}: positive control, a clean read resolves ${c.alert}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The epoch stall check's boundary read (the PUBLISHED oracle's settlementInfo) failing by transport used
  // to drop the "not Finalized" blocker and complete the check, so an open v2_mon_house_epoch_stall resolved on a 429. The
  // vault runs on its own oracle here so the pin reads (which count unread on their own) stay clean and only this read fails.
  test("a whole pass: a failed boundary settlementInfo read keeps the house check incomplete and never resolves the open epoch stall", async () => {
    const dir = tmp("monitor-rv979-stall-");
    const OWN = addr(0x7c31);
    const base = { pinned: true, ownOracle: OWN };
    const stall = (a) => a.startsWith("v2_mon_house_epoch_stall");
    const alerts = () => Object.keys(JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")).alerts);
    try {
      const open = (await pass(dir, { ...base, now: E + 3600 })).report;
      assert.equal(found(open, "v2_mon_house_epoch_stall").length, 1, `a boundary that is not Finalized stalls the roll: ${JSON.stringify(open.findings.map((f) => f.kind))}`);
      assert.ok(alerts().some(stall), "the stall is an open alert");
      const blind = (await pass(dir, { ...base, now: E + 3660, fail: { publishedSettlementInfo: "transport" } })).report;
      assert.equal(blind.checks.house.status, "incomplete", JSON.stringify(blind.checks.house));
      assert.ok(blind.notes.some((n) => /^house: NVDA settlementInfo\(.*\) could not be read/.test(n)), JSON.stringify(blind.notes));
      assert.ok(alerts().some(stall), "a failed settlementInfo read must not resolve the open v2_mon_house_epoch_stall");
      const clean = (await pass(dir, { ...base, now: E + 3720, publishedStatus: 2 })).report;
      assert.equal(clean.checks.house.status, "ok", JSON.stringify(clean.checks.house));
      assert.ok(!alerts().some(stall), "positive control: a Finalized boundary that IS read resolves the stall");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The other half: a view the vault does not have REVERTS. That is noted and not judged, and the check still
  // completes (older vaults lack weekly(), performanceFeeOwed() or pinnedBoundary()).
  test("a whole pass: a House view that reverts (an older vault lacks it) is noted and not judged, and the house check completes", async () => {
    const dir = tmp("monitor-979-revert-");
    try {
      for (const fn of ["weekly", "performanceFeeOwed", "pinnedBoundary", "oracle"]) {
        const r = (await pass(dir, { now: E - 7200, pinned: true, lock: { pinnedBoundary: E, supply: 5n }, fail: { [fn]: "revert" } })).report;
        assert.equal(r.checks.house.status, "ok", `${fn}: ${JSON.stringify(r.checks.house)} ${JSON.stringify(r.notes)}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // runOnce hands checkHouseVaultState weekly(), the registry's slot for the vault (expectedHouseKind)
  // and performanceFeeOwed(). The unit tests of the check pass them in by hand; these pages are proved through a pass.
  test("a whole pass: weekly() against the registry's slot pages v2_mon_house_kind_mismatch, and a carried fee pages v2_mon_house_fee_owed", async () => {
    const dir = tmp("monitor-979-kind-");
    const inWeeklySlot = [{ ...NVDA, v2: { ...NVDA.v2, house: { weekly: HV, daily: null } } }];
    try {
      const daily = (await pass(dir, { now: E - 7200, pinned: true, markets: inWeeklySlot, weekly: false })).report;
      const k = found(daily, "v2_mon_house_kind_mismatch");
      assert.equal(k.length, 1, "a daily vault (weekly() false) named in the registry's WEEKLY slot must page");
      assert.equal(k[0].severity, "error");
      assert.equal(k[0].id, `v2_mon_house_kind_mismatch:${HV.toLowerCase()}`);
      assert.match(k[0].message, /weekly\(\) = false \(a daily vault\) but the registry names it as the weekly vault/);
      const weekly = (await pass(dir, { now: E - 7200, pinned: true, markets: inWeeklySlot, weekly: true })).report;
      assert.equal(found(weekly, "v2_mon_house_kind_mismatch").length, 0, "v2_mon_house_kind_mismatch: a weekly vault in the weekly slot");
      const unlisted = (await pass(dir, { now: E - 7200, pinned: true, weekly: true })).report;
      assert.equal(found(unlisted, "v2_mon_house_kind_mismatch").length, 0, "v2_mon_house_kind_mismatch: a vault no slot names is not judged");
      const owed = (await pass(dir, { now: E - 7200, pinned: true, feeOwed: 12_345_678n })).report;
      const f = found(owed, "v2_mon_house_fee_owed");
      assert.equal(f.length, 1, "a carried performance fee must page");
      assert.equal(f[0].severity, "warn");
      assert.equal(f[0].id, `v2_mon_house_fee_owed:${HV.toLowerCase()}:7`);
      assert.match(f[0].message, /carries 12\.34 USDG of performance fee/, "the amount runOnce read");
      assert.equal(found((await pass(dir, { now: E - 7200, pinned: true })).report, "v2_mon_house_fee_owed").length, 0, "v2_mon_house_fee_owed: nothing owed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // runOnce spreads houseNoSeriesByDesign into checkHouseBoundaryPin. NVDA lists dailies on Mon, Wed and
  // Fri only, so its daily vault's Tuesday boundary has no series by design and must not page at the mint
  // cutoff; its Wednesday boundary must. The pure houseNoSeriesByDesign tests cannot see the wiring.
  test("a whole pass: a House boundary with no series by design (NVDA on a Tuesday) does not page at the mint cutoff", async () => {
    const dir = tmp("monitor-979-bydesign-");
    const monWedFri = [{ ...NVDA, v2: { ...NVDA.v2, overrides: { dailyWeekdays: ["mon", "wed", "fri"] } } }];
    const TUE = Date.UTC(2026, 8, 29, 20) / 1000; // Tuesday 2026-09-29, 16:00 New York
    const WED = TUE + 86_400;
    try {
      const tue = (await pass(dir, { now: TUE - 1800, e: TUE, markets: monWedFri })).report;
      assert.equal(tue.checks.house.status, "ok", JSON.stringify(tue.checks.house));
      assert.equal(found(tue, "v2_mon_house_boundary_unpinned").length, 0, "no cutoff page on a Tuesday NVDA lists no dailies on");
      const late = found((await pass(dir, { now: TUE + 1800, e: TUE, status: 3, markets: monWedFri })).report, "v2_mon_house_boundary_unpinned");
      assert.equal(late.length, 1, "by design, it pages from E + houseEpochStallS instead");
      assert.match(late[0].message, /no series is listed at this boundary by design \(NVDA lists dailies on mon, wed, fri only\)/);
      const wed = (await pass(dir, { now: WED - 1800, e: WED, markets: monWedFri })).report;
      assert.equal(found(wed, "v2_mon_house_boundary_unpinned").length, 1, "a listed Wednesday keeps the cutoff page");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("v9: House vault kind and performance fee owed", () => {
  const HV = "0x9A1f2C3D4e5F60718293A4b5C6d7E8F901234567";
  const OTHER = "0x00000000000000000000000000000000000000d2";
  const reg = { markets: [{ ticker: "NVDA", v2: { house: { weekly: null, daily: HV } } }, { ticker: "SPCX", v2: { house: { weekly: OTHER, daily: null } } }, { ticker: "X", v2: null }] };
  const base = { address: HV, ticker: "NVDA", epochId: 9n, weekly: false, expectedKind: "daily", feeOwed: 0n };
  const kindsOf = (f) => f.map((x) => `${x.kind}/${x.severity}`);

  test("the registry's kind comes from markets[].v2.house, by address, case-blind", () => {
    assert.equal(expectedHouseKind(reg, HV.toLowerCase()), "daily");
    assert.equal(expectedHouseKind(reg, OTHER), "weekly");
    assert.equal(expectedHouseKind(reg, "0x00000000000000000000000000000000000000d3"), null);
    const both = { markets: [{ v2: { house: { weekly: HV, daily: null } } }, { v2: { house: { weekly: null, daily: HV } } }] };
    assert.equal(expectedHouseKind(both, HV), "conflict");
  });

  test("a daily vault in the daily slot with nothing owed is quiet", () => {
    assert.deepEqual(checkHouseVaultState(base), []);
  });

  test("weekly() against the slot: a mismatch pages error, keyed by the vault; an unread view or an unknown vault does not", () => {
    const f = checkHouseVaultState({ ...base, weekly: true });
    assert.deepEqual(kindsOf(f), ["v2_mon_house_kind_mismatch/error"]);
    assert.equal(f[0].key, HV.toLowerCase());
    assert.match(f[0].message, /weekly\(\) = true \(a weekly vault\) but the registry names it as the daily vault/);
    assert.deepEqual(checkHouseVaultState({ ...base, weekly: null }), [], "a vault with no weekly() is not judged");
    // The line above cannot see the `weekly !== null` guard: an unread weekly() in the DAILY slot reads
    // as "daily" and agrees anyway. In the WEEKLY slot, a guard-less check pages error, "a daily vault".
    assert.deepEqual(checkHouseVaultState({ ...base, weekly: null, expectedKind: "weekly" }), [], "a WEEKLY-slot vault whose weekly() is unread is not judged");
    assert.deepEqual(checkHouseVaultState({ ...base, weekly: true, expectedKind: null }), [], "a vault no slot names is not judged");
    assert.deepEqual(kindsOf(checkHouseVaultState({ ...base, expectedKind: "conflict" })), ["v2_mon_house_kind_mismatch/error"]);
  });

  test("a carried performance fee pages warn once per epoch with the amount; an unread or zero value does not", () => {
    const f = checkHouseVaultState({ ...base, feeOwed: 12_345_678n });
    assert.deepEqual(kindsOf(f), ["v2_mon_house_fee_owed/warn"]);
    assert.equal(f[0].key, `${HV.toLowerCase()}:9`);
    assert.match(f[0].message, /carries 12\.34 USDG of performance fee/);
    assert.equal(f[0].data.feeOwed, "12345678");
    assert.deepEqual(checkHouseVaultState({ ...base, feeOwed: null }), []);
  });

  test("A tracked list at HOUSE_TRACKED_PAGE (38) pages warn keyed by the vault, one below does not, an unread count is not judged", () => {
    // 40 -> 39. The keeper's HOUSE_ROLL_WORST_SERIES fell to 40 once the conversion reserve and the
    // boundary pin were both in the roll budget. 39 -> 38: One book pull's ceiling (517,936) on top brought
    // the unread-source worst case to 39, and the keeper's test holds this page strictly below it.
    assert.equal(HOUSE_TRACKED_PAGE, 38);
    const page = HOUSE_TRACKED_PAGE;
    assert.deepEqual(checkHouseVaultState({ ...base, tracked: page - 1 }), []);
    const f = checkHouseVaultState({ ...base, tracked: page });
    assert.deepEqual(kindsOf(f), ["v2_mon_house_tracked_high/warn"]);
    assert.equal(f[0].key, HV.toLowerCase(), "a condition on the vault: it resolves when the count drops");
    assert.match(f[0].message, new RegExp(`tracks ${page} series \\(trackedSeries\\(\\)\\), at or above ${page}: .* a roll fits 39 series`));
    assert.deepEqual(f[0].data, { address: HV, ticker: "NVDA", epochId: "9", tracked: page, page });
    assert.deepEqual(checkHouseVaultState({ ...base, tracked: null }), []);
    assert.deepEqual(checkHouseVaultState(base), [], "a caller that does not pass the count is not judged");
  });

  test("parseRegistry keeps each market's House slots, and the committed registry parses them", () => {
    const parsed = parseRegistry({ markets: [{ ticker: "NVDA", asset: HV, v2: { house: { weekly: null, daily: HV } } }] });
    assert.deepEqual(parsed.markets[0].v2.house, { weekly: null, daily: HV });
    assert.throws(() => parseRegistry({ markets: [{ ticker: "NVDA", v2: { house: { daily: "0xnope" } } }] }), /v2\.house\.daily/);
    const committed = parseRegistry(JSON.parse(readFileSync(DEFAULT_REGISTRY, "utf8")), DEFAULT_REGISTRY);
    for (const m of committed.markets) if (m.v2 !== null) assert.ok("weekly" in m.v2.house && "daily" in m.v2.house, m.ticker);
  });
});

/*
 * runOnce wiring that only a whole
 * pass reaches, for an expiry the log scan learned from its SeriesCreated. No House vault is watched (no --house, none in
 * the registry), so the window and feedgap checks can see the expiry only through its series.
 */
describe("Whole passes over an expiry known only from its series", () => {
  const POOL = addr(0x9001);
  const NVDA = market("NVDA", 1, { pool: POOL, floor: "1000" });
  const U = NVDA.asset;
  const FEED = NVDA.feed;
  const MAX = 93_600;
  const E = Date.UTC(2026, 8, 21, 20) / 1000; // Monday 2026-09-21, 16:00 New York
  const SERIES_CREATED = "event SeriesCreated(uint256 indexed longId, address indexed underlying, bool isPut, uint128 strike, uint40 expiry, address oracle, uint16 exerciseFeeBps, uint32 mintFeePpm)";
  const oracleAt = (a, args) => a === C.settlementOracle.toLowerCase() && Number(args?.[1]) === E;
  const found = (report, kind) => report.findings.filter((f) => f.kind === kind);

  /**
   * One NVDA series expiring at E on the published oracle (SeriesCreated at block 5000), on a chain whose head is `now`.
   * `answer(address, fn, args)` answers a read (the address lowercase) or returns undefined for defaultRead.
   */
  function seriesPass(dir, { now, answer = () => undefined, launch = "NVDA", markets = [NVDA], defaults = {} }) {
    const registry = writeRegistry(dir, { markets, defaults, deployBlock: 1000 });
    const chain = new FakeChain({ head: 20_000n, timestamp: now });
    chain.logs.push(
      rawLog(SERIES_CREATED, { longId: 0x979n << 1n, underlying: U, isPut: false, strike: 200_000_000n, expiry: E, oracle: C.settlementOracle, exerciseFeeBps: 30, mintFeePpm: 80 }, { address: C.clearinghouse, blockNumber: 5000 }),
    );
    chain.read = (address, fn, args) => {
      const v = answer(address.toLowerCase(), fn, args);
      return v === undefined ? defaultRead(chain, address, fn, args) : v;
    };
    return runOnce(options(dir, registry, launch === null ? [] : ["--launch", launch]), onChain(chain));
  }

  // The settlement check reads ChainlinkFeedSource.windowPrice(u, E - 1800, E) for a launch expiry whose pool leg
  // missed its snapshot, and the veto page follows it: no ok Chainlink price means NO source prices the expiry.
  test("a whole pass: the settlement check reads the Chainlink leg's windowPrice, so a launch expiry no source prices pages veto now, never unveto", async () => {
    const dir = tmp("monitor-979-nosource-");
    const answer = (feed) => (a, fn, args) => {
      if (a === C.clearinghouse.toLowerCase() && fn === "openInterest") return 500n;
      if (oracleAt(a, args) && fn === "settlementInfo") return [1, 0n, 0, false, false, false]; // Pending, not captured
      if (oracleAt(a, args) && fn === "settlementConfig") return [true, [SRC.chainlink, SRC.univ3], 150, 21600, 3600]; // the pool is a pinned source
      if (a === SRC.chainlink.toLowerCase() && fn === "windowPrice") return feed;
      return undefined; // snapshots(u, E).recordedAt 0: the pool leg recorded nothing
    };
    const veto = (r) => r.findings.filter((f) => f.id === `v2_mon_guardian_veto_due:${U.toLowerCase()}:${E}:pool`);
    try {
      const none = await seriesPass(dir, { now: E + 601, answer: answer([false, 0n]) });
      assert.equal(none.checks.settlement.status, "ok", JSON.stringify(none.checks.settlement));
      const f = veto(none);
      assert.equal(f.length, 1, "v2_mon_guardian_veto_due must page the launch expiry whose pool leg missed its snapshot");
      assert.match(f[0].message, /the Chainlink leg has no ok price over .* No source prices this expiry: veto now/, "the Chainlink window read not ok: no source prices it");
      assert.match(f[0].message, /do not unveto/);
      const priced = veto(await seriesPass(dir, { now: E + 601, answer: answer([true, 100_000_000n]) }));
      assert.equal(priced.length, 1);
      assert.match(priced[0].message, /settles on Chainlink alone. GUARDIAN: .* compare the Chainlink price .* then unveto/, "an ok Chainlink window keeps the compare-then-unveto text");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The window check's expiries with series (the scan), not only the watched House vaults' boundaries.
  test("a whole pass: v2_mon_window_divergence pages a launch expiry that has series and no House vault", async () => {
    const dir = tmp("monitor-979-window-");
    const answer = (a, fn, args) => {
      if (oracleAt(a, args) && fn === "settlementInfo") return [0, 0n, 0, false, false, false];
      if (oracleAt(a, args) && fn === "settlementConfig") return [true, [SRC.chainlink, SRC.univ3], 150, 21600, 3600];
      if (a === SRC.chainlink.toLowerCase() && fn === "windowPrice") return [true, 100_000_000n];
      if (a === SRC.univ3.toLowerCase() && fn === "latest") return [true, 103_000_000n, 0n];
      return undefined;
    };
    try {
      const r = await seriesPass(dir, { now: E - 600, answer });
      assert.equal(r.checks.house.status, "skipped", "no House vault: the expiry can only come from the scan");
      assert.equal(r.checks.window.status, "ok", JSON.stringify(r.checks.window));
      const f = found(r, "v2_mon_window_divergence");
      assert.deepEqual(f.map((x) => `${x.id}/${x.severity}`), [`v2_mon_window_divergence:${U.toLowerCase()}:${E}/error`], "the series expiry's 300 bps gap pages");
      assert.match(f[0].message, /differ by 300 bps/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The feedgap check's expiries with series, the same shape.
  test("a whole pass: v2_mon_feed_expiry_gap pages a launch expiry that has series and no House vault", async () => {
    const dir = tmp("monitor-979-feedgap-");
    const answer = (updatedAt) => (a, fn, args) => {
      if (a === SRC.chainlink.toLowerCase() && fn === "pinnedFeeds") return [FEED, MAX, 2000, true];
      if (a === FEED.toLowerCase() && fn === "latestRoundData") return [1n, 100_00000000n, 0n, BigInt(updatedAt), 1n];
      if (a === SRC.univ3.toLowerCase() && fn === "pinnedPools") return [POOL, false, 18, 300, true, 1000n];
      if (a === POOL.toLowerCase() && fn === "liquidity") return 10_000n;
      return undefined;
    };
    const gap = (r) => found(r, "v2_mon_feed_expiry_gap");
    try {
      const stale = await seriesPass(dir, { now: E - 3 * 3600, answer: answer(E - MAX - 60) });
      assert.equal(stale.checks.house.status, "skipped", "no House vault: the expiry can only come from the scan");
      assert.equal(stale.checks.feedgap.status, "ok", JSON.stringify(stale.checks.feedgap));
      assert.deepEqual(gap(stale).map((x) => `${x.id}/${x.severity}`), [`v2_mon_feed_expiry_gap:${U.toLowerCase()}:${E}/warn`], "the series expiry's feed has not printed since E - maxStale");
      assert.deepEqual(gap(await seriesPass(dir, { now: E - 3 * 3600, answer: answer(E - MAX) })), [], "a round inside the window's reach pages nothing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The pins check reads pinnedBands and bands and passes both, through bandOf, to checkPinnedConfig. A pin that
  // matches the registry in every other field, so the band is the only thing that can differ.
  test("a whole pass: the pins check compares the pinned Chainlink band with the source's current band and the registry's intended one", async () => {
    const intended = { minPrice: "50000000", maxPrice: "900000000" };
    const banded = [{ ...NVDA, v2: { ...NVDA.v2, chainlinkBand: intended } }];
    const defaults = { maxDeviationBps: 150, uncorroboratedDelayS: 21600, spotMaxAgeS: 90000 };
    const INTENDED = [50_000_000n, 900_000_000n];
    const OTHER = [60_000_000n, 900_000_000n];
    const answer = (pinned, current) => (a, fn, args) => {
      if (oracleAt(a, args) && fn === "settlementConfig") return [true, [SRC.chainlink, SRC.univ3], 150, 21600, 90000];
      if (a === SRC.chainlink.toLowerCase() && fn === "pinnedFeeds") return [FEED, MAX, 2000, true];
      if (a === SRC.chainlink.toLowerCase() && fn === "pinnedBands") return pinned;
      if (a === SRC.chainlink.toLowerCase() && fn === "bands") return current;
      if (a === SRC.univ3.toLowerCase() && fn === "pinnedPools") return [POOL, false, 18, 300, true, 1000n];
      return undefined;
    };
    const run = async (pinned, current) => {
      const dir = tmp("monitor-979-band-");
      try {
        return await seriesPass(dir, { now: E - 86_400, answer: answer(pinned, current), launch: null, markets: banded, defaults });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const mismatch = (r) => found(r, "v2_mon_pin_mismatch");
    const agree = await run(INTENDED, INTENDED);
    assert.equal(agree.checks.pins.status, "ok", JSON.stringify(agree.checks.pins));
    assert.deepEqual(mismatch(agree), [], "a pin equal to the registry in every field, band included, pages nothing");
    assert.match(agree.checks.pins.detail, /1 verified now/, "and is verified: the band was compared, not skipped");
    const moved = mismatch(await run(INTENDED, OTHER));
    assert.equal(moved.length, 1, "v2_mon_pin_mismatch: the source's band moved after the pin");
    assert.match(moved[0].message, /Chainlink band pinned .*, but the source's current band is .*: the expiry settles on the pinned band/);
    const wrong = mismatch(await run(OTHER, OTHER));
    assert.equal(wrong.length, 1, "v2_mon_pin_mismatch: pinned == current, both not the registry's intended band");
    assert.match(wrong[0].message, /Chainlink pinned band is .*, but the registry's intended band is .*\(v2\.chainlinkBand\)/);
    assert.doesNotMatch(wrong[0].message, /the source's current band is/, "pinned and current agree with each other");
  });

  // The pins check passes Clearinghouse.openInterest to checkPinnedConfig: an expiry with series, no pin and no
  // open interest is one nobody has minted yet (PIN ON MINT), and is not a mismatch.
  test("a whole pass: an expiry with series, no pin and open interest 0 is not minted yet, not a pin mismatch", async () => {
    const answer = (oi) => (a, fn, args) => {
      if (oracleAt(a, args) && fn === "settlementConfig") return [false, [], 0, 0, 0]; // NOT pinned
      if (a === C.clearinghouse.toLowerCase() && fn === "openInterest" && Number(args?.[1]) === E) return oi;
      return undefined;
    };
    const run = async (oi) => {
      const dir = tmp("monitor-979-unminted-");
      try {
        return await seriesPass(dir, { now: E - 86_400, answer: answer(oi), launch: null });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
    const unminted = await run(0n);
    assert.equal(unminted.checks.pins.status, "ok", JSON.stringify(unminted.checks.pins));
    assert.deepEqual(found(unminted, "v2_mon_pin_mismatch"), [], "series, no pin, open interest 0: not minted yet");
    assert.match(unminted.checks.pins.detail, /1 not minted yet, so not pinned/);
    const minted = found(await run(5n), "v2_mon_pin_mismatch");
    assert.equal(minted.length, 1, "not pinned WITH open interest pages");
    assert.match(minted[0].message, /settlementConfig reports it NOT pinned/);
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
    // so the next run continues. Reading the newest instead would step over rounds 2-6 for ever.
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
    const x = (over) => ({ ticker: "SGOV", feed: SGOV, roundId: 1n, heartbeatS: 86_400, sourceCount: 1, ...over });

    test("a heartbeat print one latency late is fine; heartbeat + 1 h of open market is an error", () => {
      const last = at("2026-09-15T00:00:10Z");
      assert.deepEqual(checkFeedStale(x({ updatedAt: last, now: at("2026-09-16T00:00:40Z") }), t), []);
      assert.deepEqual(checkFeedStale(x({ updatedAt: last, now: last + 90_000 }), t), [], "exactly the limit");
      const f = checkFeedStale(x({ updatedAt: last, now: last + 90_001 }), t);
      assert.deepEqual(kinds(f), ["v2_mon_feed_stale/error"]);
      assert.equal(f[0].key, SGOV.toLowerCase());
      assert.equal(f[0].data.openAgeS, 90_001);
      assert.equal(f[0].data.limitS, 90_000);
      assert.match(f[0].message, /no round for 25\.0 h of open market .* This is a single-source market: spot\(\) reverts StaleSpot once the round is 25 h old/);
      // The market's own spotMaxAge and maxStale, and the end rule (ChainlinkFeedSource.sol:308): windows ENDING
      // more than maxStale after the round, not "starting 26 h after".
      assert.match(f[0].message, /Settlement windows ending more than 26 h \(the feed's maxStale\) after that round have no Chainlink price/);
      const tuned = checkFeedStale(x({ updatedAt: last, now: last + 90_001, spotMaxAgeS: 7_200, maxStaleS: 100_800 }), t);
      assert.match(tuned[0].message, /once the round is 2 h old \(its spotMaxAge\)/);
      assert.match(tuned[0].message, /ending more than 28 h \(the feed's maxStale\)/);
      assert.equal(KINDS.v2_mon_feed_stale.runbook, "ops/alerts.md §V44; ops/runbooks/incident-v2.md §7");
    });

    test("dual-source, pool agreeing: the page says spot and quoting can continue on the pool witness", () => {
      const last = at("2026-09-15T00:00:10Z");
      const [f] = checkFeedStale(x({ ticker: "NVDA", sourceCount: 2, updatedAt: last, now: last + 90_001 }), t);
      assert.equal(f.data.sourceCount, 2);
      assert.match(f.message, /spot\(\) stays OK only while the pool source is OK and agrees within maxDeviationBps, for at most 4 d/);
      assert.match(f.message, /Check spot\(\) before deciding whether rolls, vault quotes and reprices stopped/);
    });

    test("dual-source, pool not ok: the page says spot is stale as soon as the pool is unavailable or disagrees", () => {
      const friday = at("2026-09-11T12:49:02Z");
      const [f] = checkFeedStale(x({ ticker: "SPCX", sourceCount: 2, updatedAt: friday, now: at("2026-09-14T00:15:01Z") }), t);
      assert.equal(f.severity, "warn");
      assert.match(f.message, /it is stale as soon as the pool is unavailable or disagrees/);
      assert.doesNotMatch(f.message, /spot\(\) stays stale until the feed prints/);
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

  test("The pool floor is the source's LIVE floor (UniV3TwapSource.setPool), the registry's only when unread", () => {
    // The owner lowered the source floor to 5: liquidity 9 passes the source's own check, so no page from the stale 10.
    assert.deepEqual(checkPool({ ticker: "NVDA", pool: UNI, liquidity: 9n, floor: 10n, sourceFloor: 5n }), []);
    // The owner raised it to 20: liquidity 15 fails the source's check although it clears the registry's 10.
    const raised = checkPool({ ticker: "NVDA", pool: UNI, liquidity: 15n, floor: 10n, sourceFloor: 20n });
    assert.deepEqual(kinds(raised), ["v2_mon_pool_liquidity_low/warn"]);
    assert.match(raised[0].message, /75% of the TWAP floor 20:/);
    assert.equal(raised[0].data.registryFloor, 10n);
    // Unread source floor: the registry's, and the message says so.
    assert.match(checkPool({ ticker: "NVDA", pool: UNI, liquidity: 9n, floor: 10n, sourceFloor: null })[0].message, /the registry's; the source's own floor was not read/);
    // A source floor of 0 means the source checks nothing: no page.
    assert.deepEqual(checkPool({ ticker: "NVDA", pool: UNI, liquidity: 0n, floor: 10n, sourceFloor: 0n }), []);
  });

  // The floor gates the window's HARMONIC-MEAN liquidity (UniV3TwapSource.sol:51-53, record()), which a thin
  // stretch dominates; the head's liquidity() alone missed a window that was thin earlier and deep again now.
  test("The floor is judged on min(head, the last 30 min's harmonic mean)", () => {
    const px = { ticker: "NVDA", pool: UNI, floor: 10n, sourceFloor: 10n };
    const thinEarlier = checkPool({ ...px, liquidity: 50n, harmonic: 9n });
    assert.deepEqual(kinds(thinEarlier), ["v2_mon_pool_liquidity_low/warn"], "deep at the head, thin over the window: record() would refuse");
    assert.match(thinEarlier[0].message, /the harmonic-mean in-range liquidity over the last 30 min \(what record\(\) gates a window closing now on\) 9, while the head has 50, is 90% of the TWAP floor 10/);
    assert.equal(thinEarlier[0].data.judged, 9n);
    // Thin at the head, deep over the window: the early warning stays (the next window will be thin if it lasts).
    const drainedNow = checkPool({ ...px, liquidity: 9n, harmonic: 50n });
    assert.deepEqual(kinds(drainedNow), ["v2_mon_pool_liquidity_low/warn"]);
    assert.match(drainedNow[0].message, /in-range liquidity 9 at the head \(the harmonic mean over the last 30 min is 50\)/);
    assert.deepEqual(checkPool({ ...px, liquidity: 10n, harmonic: 10n }), [], "both at the floor");
    // An unread harmonic mean: the head alone, as before.
    assert.deepEqual(checkPool({ ...px, liquidity: 10n, harmonic: null }), []);
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

  test("The indexer's /v2/health/house-registry 503 pages service_down naming its alert; its 200 pages nothing", () => {
    const hr = (over) => ({ name: "indexer-v2-house-registry", url: "http://indexer-v2.railway.internal:42069/v2/health/house-registry", reachable: true, httpStatus: 200, body: null, error: null, ...over });
    const unregistered = checkHealth(hr({ httpStatus: 503, body: { ok: false, alert: "HOUSE_VAULT_UNREGISTERED", message: "1 indexed House vault(s) the registry list does not name: their events are NOT indexed", mode: "registry", configured: true } }));
    assert.deepEqual(kinds(unregistered), ["v2_mon_service_down/error"]);
    assert.equal(unregistered[0].key, "indexer-v2-house-registry");
    assert.match(unregistered[0].message, /indexer-v2-house-registry \/health answered HTTP 503 \(HOUSE_VAULT_UNREGISTERED: 1 indexed House vault\(s\) the registry list does not name/);
    assert.match(checkHealth(hr({ httpStatus: 503, body: { ok: false, alert: "HOUSE_SOURCE_FACTORY_FALLBACK", message: "the House source is in factory() discovery" } }))[0].message, /\(HOUSE_SOURCE_FACTORY_FALLBACK: the House source/);
    assert.deepEqual(checkHealth(hr({ body: { ok: true, alert: null, message: null, mode: "registry", configured: true } })), []);
    assert.deepEqual(checkHealth(hr({ body: { ok: true, configured: false } })), [], "House not configured on this indexer: nothing to watch");
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
  // NVDA publishes an intended Chainlink band (parsed form); TSLA publishes none.
  { ticker: "NVDA", asset: U, feed: V6.FEED, v2: { status: "live", univ3Pool: V6.POOL, univ3MinLiquidity: 1_700_000_000_000_000_000n, overrides: {}, chainlinkBand: { minPrice: 50_000_000n, maxPrice: 900_000_000n } } },
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
    // With no source answering, adminResolve is unbounded only once Held and from E + 7 d.
    assert.match(listed[0].message, /with none of them answering, adminResolve takes any price once Held, from E \+ 7 d/);
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

  // v9 pins on the first MINT (Clearinghouse.mint, "PIN ON MINT"), so the pin logs share their transaction with
  // the Clearinghouse's Minted, not a SeriesCreated. A fork run saw every first mint page "treat the admin key as
  // compromised". Minted carries only a longId; applyScanLogs (or the config check's series() read) supplies (u, E).
  const minted = (n, s = { u: U, e: E }, from = V6.CH) => ({ ...v6log("Minted", from, { longId: 7n, writer: V6.ADMIN, longTo: V6.ADMIN, units: 1n, collateral: 1n, fee: 0n }, { transactionHash: tx(n), logIndex: 9 }), series: s });

  test("A first mint pins in its own transaction: nothing pages; a pin beside another expiry's mint still does", () => {
    assert.deepEqual(prePinFindings([oraclePin(20), feedPin(20), poolPin(20), bandPin(20), minted(20)], "100", ctx), [], "the healthy v9 first mint");
    assert.ok(PIN_EVENTS.has("Minted"));
    const other = prePinFindings([oraclePin(21), feedPin(21), minted(21, { u: U, e: E + 86_400 })], "100", ctx);
    assert.deepEqual(kinds(other), ["v2_mon_pre_pin/error"], "a mint of another expiry does not cover the pin: the moved-pointer page stays");
    assert.match(other[0].message, /SettlementConfigPinned.*without the Clearinghouse's Minted or SeriesCreated of the expiry: pinned through a moved clearinghouse pointer/);
    const foreign = prePinFindings([oraclePin(22), feedPin(22), minted(22, { u: U, e: E }, V6.ADMIN)], "100", ctx);
    assert.deepEqual(kinds(foreign), ["v2_mon_pre_pin/error"], "a Minted from anything but the Clearinghouse covers nothing");
    assert.deepEqual(prePinFindings([oraclePin(23), feedPin(23), minted(23, null)], "100", ctx), [], "a mint of a series nobody could look up vouches for its transaction");
    assert.deepEqual(kinds(prePinFindings([oraclePin(24), feedPin(24)], "100", ctx)), ["v2_mon_pre_pin/error"], "no mint, no series: pages");
  });

  // HouseVault.pinBoundary emits SettlementConfigPinned with no Clearinghouse mint. The vault is whoever
  // the registry or --house lists, matched by address and underlying(), never by a contract name.
  const HOUSE = "0x1111111111111111111111111111111111111a11";
  const houseOf = (underlying, pinnedBoundary = null) => [{ address: HOUSE, underlying, pinnedBoundary }];
  const roll = (n, from = HOUSE) => v6log("EpochRolled", from, { epochId: 1n, epochEnd: E - 86_400, price: 1n, nav: 1n, supply: 1n, sharesMinted: 0n, sharesBurned: 0n, performanceFee: 0n }, { transactionHash: tx(n), logIndex: 8 });
  const depositedNow = (n, from = HOUSE) => v6log("DepositedNow", from, { account: V6.ADMIN, usdgAmount: 1n, shares: 1n, epochId: 1n }, { transactionHash: tx(n), logIndex: 8 });
  const depositRequested = (n, from = HOUSE) => v6log("DepositRequested", from, { account: V6.ADMIN, usdgAmount: 1n, stockAmount: 0n, epochId: 1n }, { transactionHash: tx(n), logIndex: 8 });

  test("A registered House vault's roll or first deposit does not page; a pin with neither still does", () => {
    const hctx = { ...ctx, houses: houseOf(U) };
    assert.deepEqual(prePinFindings([oraclePin(30), feedPin(30), roll(30)], "100", hctx), [], "a House roll that pins the next boundary does not page");
    assert.deepEqual(prePinFindings([oraclePin(31), depositedNow(31)], "100", hctx), [], "depositNow into an empty vault does not page");
    assert.deepEqual(prePinFindings([oraclePin(32), depositRequested(32)], "100", hctx), [], "the first queued deposit does not page");
    assert.deepEqual(kinds(prePinFindings([oraclePin(33), feedPin(33)], "100", hctx)), ["v2_mon_pre_pin/error"], "no mint and no House roll or deposit still pages");
    assert.deepEqual(kinds(prePinFindings([oraclePin(34), roll(34, V6.ADMIN)], "100", hctx)), ["v2_mon_pre_pin/error"], "an unregistered contract calling pinBoundary still pages");
    assert.deepEqual(kinds(prePinFindings([oraclePin(35), roll(35)], "100", { ...ctx, houses: houseOf(V6.TSLA) })), ["v2_mon_pre_pin/error"], "a vault whose underlying() is a different market does not vouch");
    assert.deepEqual(kinds(prePinFindings([oraclePin(36), roll(36)], "100", ctx)), ["v2_mon_pre_pin/error"], "with no registry or --house list, the roll log vouches nothing");
  });

  test("pinnedBoundary() equal to the expiry vouches, and a different or unset boundary does not", () => {
    assert.deepEqual(prePinFindings([oraclePin(40)], "100", { ...ctx, houses: houseOf(U, E) }), [], "the vault's pinnedBoundary() is this expiry");
    assert.deepEqual(kinds(prePinFindings([oraclePin(41)], "100", { ...ctx, houses: houseOf(U, E + 86_400) })), ["v2_mon_pre_pin/error"], "a later boundary does not cover this expiry");
    assert.deepEqual(kinds(prePinFindings([oraclePin(42)], "100", { ...ctx, houses: houseOf(U, 0) })), ["v2_mon_pre_pin/error"], "pinnedBoundary 0 is unset");
  });

  test("applyScanLogs hands the Clearinghouse's Minted over with its series, replayed or not", () => {
    const scan = emptyState(4663, "x").scan;
    const sink = [];
    applyScanLogs(scan, [series(25), { ...minted(26), series: undefined }], v6addresses, sink);
    assert.deepEqual(sink.map((l) => l.eventName), ["SeriesCreated", "Minted"]);
    assert.deepEqual(sink[1].series.e, E);
    assert.equal(sink[1].series.u, U);
    const again = [];
    applyScanLogs(scan, [{ ...minted(26), series: undefined }], v6addresses, again);
    assert.equal(again.length, 1, "an overlap re-read still reaches prePinFindings (its rent is not counted twice)");
    const unknown = [];
    applyScanLogs(emptyState(4663, "x").scan, [{ ...minted(27), series: undefined }], v6addresses, unknown);
    assert.equal(unknown[0].series, null, "no SeriesCreated seen: unknown, for the config check to read");
  });

  // ChainlinkFeedSource.pin() logs BandPinned beside FeedPinned when the underlying has a band.
  const bandPin = (n, underlying = U, expiry = E) => v6log("BandPinned", CL, { underlying, expiry, minPrice: 50_000_000n, maxPrice: 900_000_000n }, { transactionHash: tx(n), logIndex: 4 });

  test("v9: a BandPinned is a source pin: quiet inside its series creation, pages through the allow-list", () => {
    assert.deepEqual(prePinFindings([oraclePin(10), feedPin(10), bandPin(10), series(10)], "100", ctx), []);
    const f = prePinFindings([bandPin(11, V6.TSLA)], "100", ctx);
    assert.deepEqual(kinds(f), ["v2_mon_pre_pin/error"]);
    assert.match(f[0].message, /TSLA expiry .*ChainlinkFeedSource\.BandPinned\(band 50\.00-900\.00 USDG\) without the oracle's SettlementConfigPinned/);
    assert.ok(PIN_EVENTS.has("BandPinned") && PINS_DIRTY_EVENTS.has("BandPinned") && PINS_DIRTY_EVENTS.has("BandSet"));
  });

  test("v9: applyScanLogs records a BandPinned as a source pin and hands it over", () => {
    const scan = emptyState(4663, "x").scan;
    const sink = [];
    applyScanLogs(scan, [bandPin(12, V6.TSLA, E + 2)], v6addresses, sink);
    assert.deepEqual(scan.sourcePins, { [`${V6.TSLA.toLowerCase()}:${E + 2}`]: 1 });
    assert.deepEqual(sink.map((l) => l.eventName), ["BandPinned"]);
  });

  test("v9: BandSet and UnroutedAssetRecovered page as config changes at error", () => {
    const f = configEventFindings(
      [
        v6log("BandSet", CL, { underlying: U, minPrice: 50_000_000n, maxPrice: 900_000_000n }, { blockNumber: 201n }),
        v6log("UnroutedAssetRecovered", V6.ADMIN, { asset: V6.TSLA, treasury: V6.ADMIN, amount: 7n }, { blockNumber: 202n }),
      ],
      "100",
      v6names,
    );
    assert.deepEqual(kinds(f), ["v2_mon_config_changed/error", "v2_mon_config_changed/error"]);
    assert.equal(CONFIG_EVENTS.BandSet, "error");
    assert.equal(CONFIG_EVENTS.UnroutedAssetRecovered, "error");
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
    // Creation does not pin (Clearinghouse.createSeries); the first mint does.
    assert.match(rep[0].message, /nothing can be minted on any expiry nobody has pinned yet .*mint pins the expiry first/);
    assert.match(f[0].message, /nothing of this expiry can be minted: mint pins the expiry first/);
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
    // The Clearinghouse pins in mint, not in createSeries, so the pre-pin bites the first MINT.
    assert.match(pre[0].message, /no series: a pin made outside a mint \(a pre-pin\); its first mint reverts PinMismatch/);
    assert.match(checkPinnedBy({ ...x, pinnedBy: V6.ADMIN, hasSeries: true })[0].message, /has series: someone pointed the oracle's clearinghouse elsewhere.*its next mint must confirm the pin/);
  });

  test("pinnedBy a registered House vault is quiet only while the expiry has no series", () => {
    const HOUSE = "0x1111111111111111111111111111111111111a11";
    const x = { ticker: "NVDA", underlying: U, oracle: ORACLE, expiry: E, clearinghouse: V6.CH, hasSeries: false };
    const houses = [{ address: HOUSE, underlying: U }];
    assert.deepEqual(checkPinnedBy({ ...x, pinnedBy: HOUSE, houses }), [], "House-vault boundary pin, no series");
    const series = checkPinnedBy({ ...x, pinnedBy: HOUSE, houses, hasSeries: true });
    assert.deepEqual(kinds(series), ["v2_mon_pinned_by/error"], "the same vault pin pages once a series exists");
    assert.match(series[0].message, /has series/);
    assert.deepEqual(kinds(checkPinnedBy({ ...x, pinnedBy: V6.ADMIN, houses })), ["v2_mon_pinned_by/error"], "an unregistered pinner still pages");
    assert.deepEqual(kinds(checkPinnedBy({ ...x, pinnedBy: HOUSE, houses: [{ address: HOUSE, underlying: V6.TSLA }] })), ["v2_mon_pinned_by/error"], "underlying() is a different market");
    assert.deepEqual(kinds(checkPinnedBy({ ...x, pinnedBy: HOUSE })), ["v2_mon_pinned_by/error"], "no house list: the address alone does not vouch");
  });

  test("the published configuration: registry defaults, a market's overrides, a pool or none", () => {
    const nvda = expectedPinnedConfig(v6reg, v6markets[0]);
    assert.deepEqual(nvda, { sources: [CL, UNI], maxDeviationBps: 150, uncorroboratedDelay: 21_600, spotMaxAge: 90_000, feed: V6.FEED, maxStale: 93_600, maxRoundJumpBps: 2000, pool: V6.POOL, minLiquidity: 1_700_000_000_000_000_000n, window: 300, band: { minPrice: 50_000_000n, maxPrice: 900_000_000n } });
    const tsla = expectedPinnedConfig(v6reg, v6markets[1]);
    assert.deepEqual([tsla.sources, tsla.uncorroboratedDelay, tsla.pool, tsla.band], [[CL], 3600, null, null]);
    const reg = parseRegistry(JSON.parse(readFileSync(DEFAULT_REGISTRY, "utf8")), DEFAULT_REGISTRY);
    // The shipped registry's source tuning is read, and a registry without it falls back to
    // the compiled source defaults, which contract-mirrors pins against ChainlinkFeedSource / UniV3TwapSource.
    assert.deepEqual(reg.defaults, { maxDeviationBps: 150, uncorroboratedDelayS: 21_600, spotMaxAgeS: 90_000, chainlinkMaxStaleS: 93_600, chainlinkMaxRoundJumpBps: 2000, univ3WindowS: 300 });
    assert.deepEqual(parseRegistry({ markets: [] }).defaults, { maxDeviationBps: 150, uncorroboratedDelayS: 21_600, spotMaxAgeS: 90_000, chainlinkMaxStaleS: CHAINLINK_MAX_STALE, chainlinkMaxRoundJumpBps: CHAINLINK_MAX_ROUND_JUMP_BPS, univ3WindowS: UNIV3_WINDOW });
    assert.deepEqual(SOURCE_DEFAULTS, { chainlinkMaxStaleS: 93_600, chainlinkMaxRoundJumpBps: 2000, univ3WindowS: 300 });
    assert.ok(reg.markets.every((m) => m.feedHeartbeatS === 86_400), "every registry feed has the 24 h heartbeat");
    assert.throws(() => parseRegistry({ v2: { defaults: { maxDeviationBps: "x" } }, markets: [] }), /not a non-negative integer/);
  });

  test("A pin is held to the REGISTRY's source tuning, so a published setFeed / setPool change stops paging", () => {
    // CONFIG_ADMIN moved NVDA's feed to 48 h staleness and its pool window to 600 s, and the registry published both
    // (a market override) and a new registry-wide round jump. Every new pin carries the new values.
    const m = { ...v6markets[0], v2: { ...v6markets[0].v2, overrides: { ...v6markets[0].v2.overrides, chainlinkMaxStaleS: 172_800, univ3WindowS: 600 } } };
    const reg = { ...v6reg, defaults: { ...v6reg.defaults, chainlinkMaxRoundJumpBps: 3000 } };
    const want = expectedPinnedConfig(reg, m);
    assert.deepEqual([want.maxStale, want.maxRoundJumpBps, want.window], [172_800, 3000, 600]);
    const pin = {
      ticker: "NVDA",
      underlying: U,
      expiry: E,
      oracle: ORACLE,
      publishedOracle: ORACLE,
      expected: want,
      sources: v6reg.sources,
      names: v6names,
      config: { pinned: true, sources: [CL, UNI], maxDeviationBps: 150, uncorroboratedDelay: 21_600, spotMaxAge: 90_000 },
      chainlink: { feed: V6.FEED, maxStale: 172_800, maxRoundJumpBps: 3000, pinned: true },
      univ3: { pool: V6.POOL, window: 600, pinned: true, minLiquidity: 1_700_000_000_000_000_000n },
      dataStreams: null,
    };
    assert.deepEqual(checkPinnedConfig(pin), { findings: [], verified: true, notChecked: [] });
    // The old compiled values on a new pin ARE the mismatch now: the registry says the market moved.
    const stale = checkPinnedConfig({ ...pin, chainlink: { ...pin.chainlink, maxStale: CHAINLINK_MAX_STALE, maxRoundJumpBps: CHAINLINK_MAX_ROUND_JUMP_BPS }, univ3: { ...pin.univ3, window: UNIV3_WINDOW } });
    assert.deepEqual(stale.findings[0].data.differences, ["Chainlink maxStale 93600 s instead of 172800", "Chainlink maxRoundJumpBps 2000 instead of 3000", "pool window 300 s instead of 600"]);
    // A value neither the registry nor the compiled default names still pages (the check is not loosened).
    assert.match(checkPinnedConfig({ ...pin, chainlink: { ...pin.chainlink, maxStale: 999_999 } }).findings[0].message, /Chainlink maxStale 999999 s instead of 172800/);
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
    assert.deepEqual(checkPinnedConfig(good), { findings: [], verified: true, notChecked: [] });
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
    // A market registered before the 1 h spot age was pinned: its expiries no longer match the registry.
    assert.deepEqual(checkPinnedConfig({ ...good, config: { ...good.config, spotMaxAge: 3600 } }).findings[0].data.differences, ["spotMaxAge 3600 instead of 90000"]);
    assert.match(checkPinnedConfig({ ...good, chainlink: { ...good.chainlink, pinned: false } }).findings[0].message, /ChainlinkFeedSource holds no pin/);
    assert.match(checkPinnedConfig({ ...good, config: { pinned: false, sources: [] } }).findings[0].message, /NOT pinned/);
    const foreign = checkPinnedConfig({ ...good, oracle: V6.ADMIN, config: { pinned: false, sources: [] } });
    assert.deepEqual(foreign.findings[0].data.differences.length, 1);
    assert.match(foreign.findings[0].message, /not the published SettlementOracle/);
    // A listed Data Streams source is never "verified": its feed version can still move.
    const withDs = { ...good, config: { ...good.config, sources: [CL, UNI, V6.DS] }, expected: { ...good.expected, sources: [CL, UNI, V6.DS] } };
    assert.deepEqual(checkPinnedConfig({ ...withDs, dataStreams: { pinned: true, version: 2n, currentVersion: 2n } }), { findings: [], verified: false, notChecked: [] });
    assert.match(checkPinnedConfig({ ...withDs, dataStreams: { pinned: true, version: 2n, currentVersion: 3n } }).findings[0].message, /feedVersion 2 -> 3/);
    assert.deepEqual(checkPinnedConfig({ ...good, expected: null }).findings[0].data.differences.length >= 1, true);
    // v9 pins on the first MINT: an expiry with series, no pin and no open interest is simply not minted yet
    // (a fresh v9 fork showed 12 such pages on one pass). Open interest on an unpinned expiry still pages.
    const unpinned = { ...good, config: { pinned: false, sources: [] } };
    assert.deepEqual(checkPinnedConfig({ ...unpinned, openInterest: 0n }), { findings: [], verified: false, notChecked: [], unminted: true });
    assert.match(checkPinnedConfig({ ...unpinned, openInterest: 5n }).findings[0].message, /NOT pinned/, "a position on an unpinned expiry pages");
    assert.match(checkPinnedConfig({ ...unpinned, oracle: V6.ADMIN, openInterest: 0n }).findings[0].message, /not the published SettlementOracle/, "a foreign oracle pages minted or not");
    assert.deepEqual(checkPinnedConfig({ ...good, openInterest: 0n }), { findings: [], verified: true, notChecked: [] }, "a pinned expiry is compared whatever its open interest");
  });

  test("v9: the pinned Chainlink band is held to the source's current band; an unread band compares nothing", () => {
    const good = {
      ticker: "NVDA", underlying: U, expiry: E, oracle: ORACLE, publishedOracle: ORACLE,
      expected: expectedPinnedConfig(v6reg, v6markets[0]), sources: v6reg.sources, names: v6names,
      config: { pinned: true, sources: [CL, UNI], maxDeviationBps: 150, uncorroboratedDelay: 21_600, spotMaxAge: 90_000 },
      chainlink: { feed: V6.FEED, maxStale: 93_600, maxRoundJumpBps: 2000, pinned: true },
      univ3: { pool: V6.POOL, window: 300, pinned: true, minLiquidity: 1_700_000_000_000_000_000n },
      dataStreams: null,
    };
    const band = (min, max) => ({ minPrice: min, maxPrice: max });
    const same = { ...good, chainlink: { ...good.chainlink, band: band(50_000_000n, 900_000_000n), currentBand: band(50_000_000n, 900_000_000n) } };
    assert.deepEqual(checkPinnedConfig(same), { findings: [], verified: true, notChecked: [] });
    const moved = checkPinnedConfig({ ...good, chainlink: { ...same.chainlink, currentBand: band(60_000_000n, 900_000_000n) } });
    assert.deepEqual(kinds(moved.findings), ["v2_mon_pin_mismatch/error"]);
    assert.deepEqual(moved.findings[0].data.differences, [
      "Chainlink band pinned 50.00-900.00 USDG, but the source's current band is 60.00-900.00 USDG: the expiry settles on the pinned band and its next series reverts PinMismatch",
      // The current band is also held to the registry's intended one (the fixture's 50-900).
      "Chainlink current band is 60.00-900.00 USDG, but the registry's intended band is 50.00-900.00 USDG (v2.chainlinkBand)",
    ]);
    // Pinned unbanded while the source now has a band: the same PinMismatch for its next series.
    assert.match(checkPinnedConfig({ ...good, chainlink: { ...same.chainlink, band: band(0n, 0n) } }).findings[0].message, /band pinned no band, but the source's current band is 50\.00-900\.00 USDG/);
    // A v8 source has no band views: bandOf(null read) is null and nothing is compared (no page for an unread value).
    // The current band here is the fixture's intended one, so the only unread value is the pinned band.
    assert.deepEqual(checkPinnedConfig({ ...good, chainlink: { ...good.chainlink, band: null, currentBand: band(50_000_000n, 900_000_000n) } }), { findings: [], verified: true, notChecked: [] });
    assert.equal(bandOf({ ok: false, error: "reverted" }), null);
    assert.deepEqual(bandOf({ ok: true, value: [5n, 7n] }), band(5n, 7n));
    assert.equal(bandMismatch(band(1n, 2n), null), null);
  });

  test("Pinned and current band are each held to the registry's intended band; pinned == current == wrong pages", () => {
    const band = (min, max) => ({ minPrice: min, maxPrice: max });
    const intended = band(50_000_000n, 900_000_000n);
    const wrong = band(20_000_000n, 90_000_000_000n);
    const base = {
      ticker: "NVDA", underlying: U, expiry: E, oracle: ORACLE, publishedOracle: ORACLE,
      expected: expectedPinnedConfig(v6reg, v6markets[0]), sources: v6reg.sources, names: v6names,
      config: { pinned: true, sources: [CL, UNI], maxDeviationBps: 150, uncorroboratedDelay: 21_600, spotMaxAge: 90_000 },
      chainlink: { feed: V6.FEED, maxStale: 93_600, maxRoundJumpBps: 2000, pinned: true, band: intended, currentBand: intended },
      univ3: { pool: V6.POOL, window: 300, pinned: true, minLiquidity: 1_700_000_000_000_000_000n },
      dataStreams: null,
    };
    assert.deepEqual(base.expected.band, intended, "the fixture publishes the intended band");
    assert.deepEqual(checkPinnedConfig(base), { findings: [], verified: true, notChecked: [] });
    // THE CASE THIS CHECK EXISTS FOR: a band wrong from the start. Pinned == current, so the pinned-vs-current comparison is silent.
    assert.equal(bandMismatch(wrong, wrong), null);
    const bothWrong = checkPinnedConfig({ ...base, chainlink: { ...base.chainlink, band: wrong, currentBand: wrong } });
    assert.equal(bothWrong.verified, false);
    assert.deepEqual(kinds(bothWrong.findings), ["v2_mon_pin_mismatch/error"]);
    assert.deepEqual(bothWrong.findings[0].data.differences, [
      "Chainlink pinned band is 20.00-90000.00 USDG, but the registry's intended band is 50.00-900.00 USDG (v2.chainlinkBand)",
      "Chainlink current band is 20.00-90000.00 USDG, but the registry's intended band is 50.00-900.00 USDG (v2.chainlinkBand)",
    ]);
    // Only the pinned one wrong (the source was re-banded since): two differences, pinned-vs-current and pinned-vs-intended.
    const pinnedWrong = checkPinnedConfig({ ...base, chainlink: { ...base.chainlink, band: wrong } });
    assert.deepEqual(pinnedWrong.findings[0].data.differences.length, 2);
    assert.match(pinnedWrong.findings[0].data.differences[1], /^Chainlink pinned band is 20\.00-90000\.00 USDG, but the registry's intended band is 50\.00-900\.00 USDG/);
    // Only the current one wrong: the same shape, the other way round.
    const currentWrong = checkPinnedConfig({ ...base, chainlink: { ...base.chainlink, currentBand: wrong } });
    assert.match(currentWrong.findings[0].data.differences[1], /^Chainlink current band is 20\.00-90000\.00 USDG/);
    // A pinned "no band" (0, 0) against an intended band is a difference too.
    assert.match(checkPinnedConfig({ ...base, chainlink: { ...base.chainlink, band: band(0n, 0n), currentBand: band(0n, 0n) } }).findings[0].data.differences[0], /pinned band is no band, but the registry's intended band is 50\.00-900\.00 USDG/);
  });

  test("A 'no band' marker or an unpublished band is NOT CHECKED, never a pass; an unread band compares nothing", () => {
    const band = (min, max) => ({ minPrice: min, maxPrice: max });
    const wrong = band(20_000_000n, 90_000_000_000n);
    const base = {
      ticker: "NVDA", underlying: U, expiry: E, oracle: ORACLE, publishedOracle: ORACLE,
      expected: expectedPinnedConfig(v6reg, v6markets[0]), sources: v6reg.sources, names: v6names,
      config: { pinned: true, sources: [CL, UNI], maxDeviationBps: 150, uncorroboratedDelay: 21_600, spotMaxAge: 90_000 },
      chainlink: { feed: V6.FEED, maxStale: 93_600, maxRoundJumpBps: 2000, pinned: true, band: wrong, currentBand: wrong },
      univ3: { pool: V6.POOL, window: 300, pinned: true, minLiquidity: 1_700_000_000_000_000_000n },
      dataStreams: null,
    };
    const noBand = checkPinnedConfig({ ...base, expected: { ...base.expected, band: CHAINLINK_NO_BAND } });
    assert.deepEqual(noBand.findings, []);
    assert.equal(noBand.verified, false, "NOT CHECKED is never a pass: the expiry stays unverified");
    assert.deepEqual(noBand.notChecked, [`Chainlink band NOT CHECKED: the registry marks this market "no band" (v2.chainlinkBand "none"), so there is no intended band to hold the pin to`]);
    const unpublished = checkPinnedConfig({ ...base, expected: { ...base.expected, band: null } });
    assert.equal(unpublished.verified, false);
    assert.deepEqual(unpublished.notChecked, ["Chainlink band NOT CHECKED: the registry publishes no v2.chainlinkBand for this market"]);
    // An unread value (a v8 source has no band views) compares nothing, as bandMismatch does.
    assert.deepEqual(intendedBandCheck(band(50_000_000n, 900_000_000n), null, undefined), { diffs: [], notChecked: [] });
    assert.deepEqual(intendedBandCheck(band(50_000_000n, 900_000_000n), null, wrong).diffs.length, 1);
  });

  // Every band test above moves minPrice, so bandMismatch
  // and intendedBandCheck comparing minPrice alone passed them all: a band whose UPPER bound
  // differs paged nothing. Here only maxPrice differs, above and below, and an equal maxPrice is still quiet.
  test("A band that differs only in maxPrice is a difference, above or below; an equal maxPrice is not", () => {
    const band = (min, max) => ({ minPrice: min, maxPrice: max });
    const intended = band(50_000_000n, 900_000_000n);
    const above = band(50_000_000n, 950_000_000n);
    const below = band(50_000_000n, 850_000_000n);
    assert.equal(bandMismatch(above, intended), "Chainlink band pinned 50.00-950.00 USDG, but the source's current band is 50.00-900.00 USDG: the expiry settles on the pinned band and its next series reverts PinMismatch");
    assert.match(bandMismatch(below, intended), /^Chainlink band pinned 50\.00-850\.00 USDG, but the source's current band is 50\.00-900\.00 USDG/);
    assert.equal(bandMismatch(band(50_000_000n, 900_000_000n), intended), null, "the same maxPrice (a distinct object) is no difference");
    assert.deepEqual(intendedBandCheck(intended, above, intended), { diffs: ["Chainlink pinned band is 50.00-950.00 USDG, but the registry's intended band is 50.00-900.00 USDG (v2.chainlinkBand)"], notChecked: [] });
    assert.deepEqual(intendedBandCheck(intended, intended, below), { diffs: ["Chainlink current band is 50.00-850.00 USDG, but the registry's intended band is 50.00-900.00 USDG (v2.chainlinkBand)"], notChecked: [] });
    assert.deepEqual(intendedBandCheck(intended, band(50_000_000n, 900_000_000n), band(50_000_000n, 900_000_000n)), { diffs: [], notChecked: [] });
    // The page: checkPinnedConfig reports it as v2_mon_pin_mismatch, and an equal maxPrice verifies.
    const base = {
      ticker: "NVDA", underlying: U, expiry: E, oracle: ORACLE, publishedOracle: ORACLE,
      expected: expectedPinnedConfig(v6reg, v6markets[0]), sources: v6reg.sources, names: v6names,
      config: { pinned: true, sources: [CL, UNI], maxDeviationBps: 150, uncorroboratedDelay: 21_600, spotMaxAge: 90_000 },
      chainlink: { feed: V6.FEED, maxStale: 93_600, maxRoundJumpBps: 2000, pinned: true, band: intended, currentBand: intended },
      univ3: { pool: V6.POOL, window: 300, pinned: true, minLiquidity: 1_700_000_000_000_000_000n },
      dataStreams: null,
    };
    assert.deepEqual(base.expected.band, intended, "the fixture publishes the intended band");
    assert.deepEqual(checkPinnedConfig(base), { findings: [], verified: true, notChecked: [] });
    const pinnedAbove = checkPinnedConfig({ ...base, chainlink: { ...base.chainlink, band: above } });
    assert.deepEqual(kinds(pinnedAbove.findings), ["v2_mon_pin_mismatch/error"]);
    assert.equal(pinnedAbove.verified, false);
    assert.deepEqual(pinnedAbove.findings[0].data.differences, [
      "Chainlink band pinned 50.00-950.00 USDG, but the source's current band is 50.00-900.00 USDG: the expiry settles on the pinned band and its next series reverts PinMismatch",
      "Chainlink pinned band is 50.00-950.00 USDG, but the registry's intended band is 50.00-900.00 USDG (v2.chainlinkBand)",
    ]);
  });

  test("The registry's v2.chainlinkBand parses to bigints, 'none' or null; anything else is refused by name", () => {
    assert.deepEqual(parseChainlinkBand({ minPrice: "20000000", maxPrice: "2000000000" }, "w"), { minPrice: 20_000_000n, maxPrice: 2_000_000_000n });
    assert.equal(parseChainlinkBand("none", "w"), CHAINLINK_NO_BAND);
    assert.equal(parseChainlinkBand(undefined, "w"), null);
    assert.equal(parseChainlinkBand(null, "w"), null);
    for (const bad of [{ minPrice: "0", maxPrice: "5" }, { minPrice: "5", maxPrice: "5" }, { minPrice: "9", maxPrice: "5" }, { minPrice: "x", maxPrice: "5" }, "None", 7, {}]) {
      assert.throws(() => parseChainlinkBand(bad, "markets[0] (NVDA).v2.chainlinkBand"), /markets\[0\] \(NVDA\)\.v2\.chainlinkBand/, JSON.stringify(bad));
    }
    // The committed registry: every market's band is the builder's table value (V2_INTENDED_CHAINLINK_BANDS), parsed.
    const reg = parseRegistry(JSON.parse(readFileSync(DEFAULT_REGISTRY, "utf8")), DEFAULT_REGISTRY);
    assert.ok(reg.markets.length > 0);
    for (const m of reg.markets) {
      const t = V2_INTENDED_CHAINLINK_BANDS[m.ticker];
      assert.deepEqual(m.v2.chainlinkBand, t === undefined ? CHAINLINK_NO_BAND : { minPrice: BigInt(t.minPrice), maxPrice: BigInt(t.maxPrice) }, m.ticker);
    }
  });

  test("v9: a BandSet re-opens the verified pins of its underlying only, and still pages", () => {
    const scan = emptyState(4663, "x").scan;
    const kU = `${ORACLE.toLowerCase()}:${U.toLowerCase()}:${E}`;
    const kT = `${ORACLE.toLowerCase()}:${V6.TSLA.toLowerCase()}:${E}`;
    scan.pinsVerified = { [kU]: 1, [kT]: 1 };
    const out = applyScanLogs(scan, [v6log("BandSet", CL, { underlying: U, minPrice: 1n, maxPrice: 2n })], v6addresses);
    assert.deepEqual(scan.pinsVerified, { [kT]: 1 });
    assert.deepEqual(out.map((e) => e.eventName), ["BandSet"]);
    // Not from the Chainlink source: nothing is re-opened.
    scan.pinsVerified = { [kU]: 1 };
    applyScanLogs(scan, [v6log("BandSet", V6.ADMIN, { underlying: U, minPrice: 1n, maxPrice: 2n })], v6addresses);
    assert.deepEqual(scan.pinsVerified, { [kU]: 1 });
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
/*  INTERFACE_VERSION 7 (rent, stale asks, outflow cap)                                             */
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
    // The concrete contract, which is what the registry's feeSplitter address holds. buybackCooldown()
    // is declared on FeeSplitter, not on IFeeSplitter; every IFeeSplitter view is on FeeSplitter too.
    feeSplitter: "FeeSplitter",
    // v2_mon_house_epoch_stall added a houseVault view list and named it in neither list, so
    // the guard above went red rather than let it through unchecked. It is ours, and ops/abis/v2/HouseVault.json is
    // its artifact.
    houseVault: "HouseVault",
    // The one PoolKey the buyback trades, compared with the registry's pinned shared.token.poolKey.
    buybackExecutor: "V4BuybackExecutor",
    // The EarnVault's adapter() and its adapter's withdrawable() (v2_mon_earn_pull_short).
    earnVault: "EarnVault",
    earnAdapter: "Erc4626VenueAdapter",
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

  // A view a landed contracts change added that ops/abis/v2 does not export yet, with the change that re-exports it.
  // SELF-EXPIRING: the moment the export has the view, this test fails until the entry is deleted, so the exception
  // cannot outlive the export. Only a no-argument view with one static return may be listed (nothing positional to
  // decode wrong), and the monitor must read it tolerantly. Empty for a while, and non-empty once the regen
  // exported HouseVault.pinnedBoundary().
  const NOT_EXPORTED_YET = {};
  // The point of the whole suite: monitor.mjs decodes series(), market() and limits() POSITIONALLY from these
  // strings. v7 appended a field to each of the three, and a monitor left on the v6 tuples reads the new returns
  // without failing — it just reads them wrong, so its alerts go quiet instead of firing.
  for (const [key, artifact] of Object.entries(OURS)) {
    test(`${key} views equal ${artifact}.json`, () => {
      const compiled = abiJson(artifact);
      for (const item of viem.parseAbi(ABI_TEXT[key])) {
        if (item.type !== "function") continue;
        const pending = NOT_EXPORTED_YET[key]?.[item.name];
        if (pending !== undefined) {
          assert.ok(!compiled.some((e) => e.type === "function" && e.name === item.name), `${artifact}.json now exports ${item.name}(): delete it from NOT_EXPORTED_YET (${pending.row})`);
          assert.equal(typesOf(item.inputs), "", `${key}.${item.name}: only a no-argument view may wait for the export`);
          assert.equal(typesOf(item.outputs), pending.returns, `${key}.${item.name} returns`);
          continue;
        }
        // An overloaded name (Clearinghouse has totalSupply() and totalSupply(uint256)) is matched on its
        // argument types; with no overload of those types the first of the name is compared, and fails below.
        const named = compiled.filter((e) => e.type === "function" && e.name === item.name);
        const real = named.find((e) => typesOf(e.inputs) === typesOf(item.inputs)) ?? named[0];
        assert.ok(real !== undefined, `${artifact} has no ${item.name}()`);
        assert.equal(typesOf(item.inputs), typesOf(real.inputs), `${key}.${item.name} arguments`);
        assert.equal(typesOf(item.outputs), typesOf(real.outputs), `${key}.${item.name} returns`);
      }
    });
  }

  test("every scanned event signature is one a v2 contract emits", () => {
    const emitted = new Set();
    // The concrete FeeSplitter too. UnroutedAssetRecovered (v9 recoverUnrouted) is declared on the contract,
    // not on IFeeSplitter, which is the artifact OURS reads the splitter's views from.
    for (const name of Object.values(OURS).concat(["UniV3PayoutAdapter", "RewardsDistributor", "MakerRegistry", "IBuybackExecutor", "FeeSplitter"])) {
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

/* ---------------------------------------------------------------------------------------------- */
/*  SCAN_EVENTS pinned to the exports, and to what the monitor acts on                              */
/* ---------------------------------------------------------------------------------------------- */

// The scan decodes with SCAN_EVENTS and nothing else, so an entry that drifts from the contract (renamed, re-typed,
// an argument moved into the topics) or goes missing does not fail: the log simply stops decoding, and every alert
// fed by it goes quiet. A guard-coverage review deleted Redeemed, PayoutPrefsSet,
// PulledFromVenue, BandSet and BandPinned one at a time and the whole suite stayed green. Both lists below are
// derived: the entries from SCAN_EVENTS, the events from ops/abis/v2, the names from monitor.mjs.
describe("SCAN_EVENTS matches ops/abis/v2 and decodes every event the monitor acts on", () => {
  const viem = loadViem();
  /** An input as SCAN_EVENTS writes it: type, indexed and name, tuple components named too. The names count: the
   *  monitor reads decoded args BY NAME, so two same-typed arguments swapped in the contract keep the topic and
   *  swap the values it reads (PulledFromVenue's requested and withdrawn). */
  const inputOf = (i) => `${i.type.startsWith("tuple") ? `(${(i.components ?? []).map(inputOf).join(", ")})${i.type.slice(5)}` : i.type}${i.indexed ? " indexed" : ""} ${i.name ?? ""}`.trimEnd();
  const layoutOf = (e) => `${e.name}(${e.inputs.map(inputOf).join(", ")})`;
  /** Every event every ops/abis/v2 export declares. roles.json is a manifest, not an ABI. */
  const exported = readdirSync(ABIS)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((file) => {
      const abi = JSON.parse(readFileSync(path.join(ABIS, file), "utf8"));
      return Array.isArray(abi) ? abi.filter((e) => e.type === "event").map((e) => ({ file, name: e.name, topic: viem.toEventSelector(e), layout: layoutOf(e) })) : [];
    });
  /** One line per scanned event no export declares exactly (topic, indexed and names), naming it; [] when all are. */
  const scanProblems = (signatures) => {
    const bad = [];
    for (const s of viem.parseAbi(signatures)) {
      const topic = viem.toEventSelector(s);
      const sameTopic = exported.filter((x) => x.topic === topic);
      if (sameTopic.some((x) => x.layout === layoutOf(s))) continue;
      const sameName = exported.filter((x) => x.name === s.name);
      const theirs = (sameTopic.length > 0 ? sameTopic : sameName).map((x) => `${x.file} ${x.layout}`).join("; ");
      if (sameTopic.length > 0) bad.push(`${s.name}: SCAN_EVENTS ${layoutOf(s)} has the export's topic but not its indexed/argument names: ${theirs}`);
      else if (sameName.length > 0) bad.push(`${s.name}: SCAN_EVENTS ${layoutOf(s)} (topic ${topic}) matches no export: ${theirs}`);
      else bad.push(`${s.name}: SCAN_EVENTS ${layoutOf(s)} is declared by no ops/abis/v2 export`);
    }
    return bad;
  };

  test("every SCAN_EVENTS entry is an event an ops/abis/v2 export declares: same topic, same indexed, same names", () => {
    const parsed = viem.parseAbi(SCAN_EVENTS);
    assert.ok(SCAN_EVENTS.length >= 100, `SCAN_EVENTS has only ${SCAN_EVENTS.length} entries: is this the right list?`);
    assert.equal(parsed.filter((x) => x.type === "event").length, SCAN_EVENTS.length, "every SCAN_EVENTS entry parses as one event");
    assert.ok(exported.length >= 200, `ops/abis/v2 declares only ${exported.length} events: is ABIS the right folder?`);
    assert.deepEqual(scanProblems(SCAN_EVENTS), []);
  });

  // The guard on the guard: for each entry, four drifts must each be named. A topic comparison alone sees only the
  // last two; an argument renamed or moved into the topics keeps the topic.
  test("the check names an entry whose argument is renamed or re-indexed, or that loses an argument or its name", () => {
    const sigOf = (name, inputs) => `event ${name}(${inputs.map(inputOf).join(", ")})`;
    for (const s of viem.parseAbi(SCAN_EVENTS)) {
      assert.ok(s.inputs.length > 0, `${s.name} has no arguments to drift`);
      const [first, ...rest] = s.inputs;
      const drifts = {
        "argument renamed": [s.name, sigOf(s.name, [{ ...first, name: `${first.name}Drifted` }, ...rest])],
        "argument re-indexed": [s.name, sigOf(s.name, [{ ...first, indexed: !first.indexed }, ...rest])],
        "argument dropped": [s.name, sigOf(s.name, s.inputs.slice(0, -1))],
        "event renamed": [`${s.name}Drifted`, sigOf(`${s.name}Drifted`, s.inputs)],
      };
      for (const [how, [name, sig]] of Object.entries(drifts)) {
        const bad = scanProblems([sig]);
        assert.equal(bad.length, 1, `${s.name}, ${how}, was not reported: ${sig}`);
        assert.ok(bad[0].startsWith(`${name}: `), `${s.name}, ${how}, was reported under another name: ${bad[0]}`);
      }
    }
  });

  test("every event name monitor.mjs acts on is one SCAN_EVENTS decodes, after scanEventName", async () => {
    const monitor = await import("./monitor.mjs");
    const src = readFileSync(new URL("./monitor.mjs", import.meta.url), "utf8");
    // The names the scan can hand on: each entry decoded (args stubbed by name, tuples as objects) and renamed by
    // scanEventName exactly as applyScanLogs does before anything reads eventName.
    const stub = (inputs) => Object.fromEntries(inputs.map((i) => [i.name, i.components ? stub(i.components) : 0n]));
    const decodes = new Set(viem.parseAbi(SCAN_EVENTS).map((s) => scanEventName({ eventName: s.name, args: stub(s.inputs) })));
    // The monitor's second decoder: the House vault read (runOnce, after the protocol scan) decodes
    // HOUSE_VAULT_SCAN_SIGNATURES from the registry House vaults, which are not protocol-scan addresses (so LimitsSet
    // stays out of SCAN_EVENTS: it is MakerVault's topic too). It hands on the pin events as decoded and each LimitsSet
    // only through applyHouseLimits, as HouseLimitsSet. Each name counts as that read hands it on: a raw LimitsSet
    // is not credited here, so the House read cannot cover for a SCAN_EVENTS entry the protocol scan lacks.
    const houseLog = (s) => ({ eventName: s.name, args: stub(s.inputs), address: "0x0000000000000000000000000000000000004a11", blockNumber: 1n, logIndex: 0n });
    const houseDecodes = new Set(
      viem.parseAbi(HOUSE_VAULT_SCAN_SIGNATURES).flatMap((s) => {
        const renamed = applyHouseLimits({}, [houseLog(s)]).map((e) => e.eventName);
        return renamed.length > 0 ? renamed : [s.name];
      }),
    );

    const acted = new Map();
    const add = (name, where) => acted.set(name, [...(acted.get(name) ?? []), where]);
    // 1. Every exported *_EVENTS that holds names (a Set, or an object keyed by name). Arrays of "event ..." strings
    //    are ABIs: SCAN_EVENTS is the subject, MANAGER_MEMBER_EVENTS is the manager walk's own.
    for (const [key, value] of Object.entries(monitor)) {
      if (!key.endsWith("_EVENTS") || Array.isArray(value)) continue;
      for (const name of value instanceof Set ? value : Object.keys(value)) add(name, key);
    }
    // 2. Every `new Set([...])` of names in the source, exported or not (EARN_VAULT_EVENTS is not).
    for (const m of src.matchAll(/const (\w+_EVENTS) = new Set\(\[([^\]]*)\]\)/g)) for (const n of m[2].matchAll(/"(\w+)"/g)) add(n[1], m[1]);
    // 3. Every comparison of an eventName with a name.
    for (const m of src.matchAll(/eventName\s*[!=]==\s*"(\w+)"/g)) add(m[1], "eventName ===");
    // 4. Every case of every switch on an eventName (applyScanLogs, applyFlywheelLogs), to the switch's closing brace.
    let switches = 0;
    for (const m of src.matchAll(/switch \([\w.]*eventName\) \{/g)) {
      switches += 1;
      let depth = 0;
      let end = m.index + m[0].length - 1;
      for (; end < src.length; end += 1) {
        if (src[end] === "{") depth += 1;
        else if (src[end] === "}" && --depth === 0) break;
      }
      for (const c of src.slice(m.index, end).matchAll(/case "(\w+)":/g)) add(c[1], "switch (eventName)");
    }

    // The derivation must see what it claims to: both switches, and the five events item 15 found unpinned.
    assert.ok(switches >= 2, `found ${switches} switch (eventName) blocks in monitor.mjs`);
    assert.ok(acted.size >= 50, `only ${acted.size} event names derived from monitor.mjs`);
    for (const name of ["Redeemed", "PayoutPrefsSet", "PulledFromVenue", "BandSet", "BandPinned"]) assert.ok(acted.has(name), `${name} is not among the derived names`);

    const missing = [...acted]
      .filter(([name]) => !decodes.has(name) && !houseDecodes.has(name))
      .map(([name, where]) => `${name} (${[...new Set(where)].join(", ")}): no SCAN_EVENTS entry or House vault read decodes it`);
    assert.deepEqual(missing, []);
  });

  // The checks above accept an entry that ANY export declares, so a drift in the contract that
  // really emits it is hidden by another export with the same layout: Clearinghouse's KeeperRewardsSet retyped, or
  // OrderBook's FeeRecipientSet given an argument, stayed green because other contracts still declare the old one.
  // Below, each contract the scan reads logs from is checked on its own export.
  /** Each contract runOnce's protocolAddresses scans, its export(s) (payoutAdapter is the v8 PayoutRouter or the v7
   *  adapter, PAYOUT_ROUTES_ABI), and the names applyScanLogs switches on for the events each export declares (after
   *  scanEventName; for the EarnVault only EARN_VAULT_EVENTS). A NAME PIN: an event renamed or
   *  re-typed in one contract while another scanned contract still declares the old name (AuthorityUpdated is in 14 of
   *  them, TreasurySet in 4) leaves this contract's list short, and the test below names it. The keys are derived from
   *  monitor.mjs and must match; a new decodable event must be added here on purpose. Each list sorted. */
  const EMITTER_EXPORTS = {
    clearinghouse: {
      Clearinghouse: [
        "AuthorityUpdated", "BaseUriSet", "CalendarSet", "Closed", "CreatePausedSet", "DefaultMarketFeesSet", "DefaultOracleSet", "FeeRecipientSet",
        "FeesSwept", "KeeperRewardsSet", "MarketConfigSet", "MarketRegistered", "MinRedeemPayoutSet", "MintFeesAccrued", "MintPausedSet", "Minted",
        "MinterSet", "PayoutAdapterSet", "PayoutPrefsSet", "Redeemed", "SeriesCreated", "SeriesSettled", "TransferBatch", "TransferSingle",
      ],
    },
    orderBook: {
      OrderBook: [
        "AuthorityUpdated", "DiscountModuleSet", "FeeParamsScheduled", "FeeParamsSet", "FeeRecipientSet", "FundingAllowedSet", "FundingSet", "MakerRegistrySet",
        "OwedCredited", "TradingPausedSet",
      ],
    },
    settlementOracle: {
      SettlementOracle: [
        "AuthorityUpdated", "ClearinghouseSet", "KeeperRewardsSet", "MarketConfigured", "MarketSourcesSet", "SettlementConfigPinned", "SettlementFinalized",
        "SettlementPinConfirmed", "SettlementResolved", "SettlementUnvetoed", "SettlementVetoed",
      ],
    },
    expiryCalendar: { ExpiryCalendar: ["AuthorityUpdated", "HolidaySet", "SpecialExpirySet"] },
    keeperRewards: { KeeperRewards: ["AuthorityUpdated", "BountySet", "CallerSet", "DailyCapSet", "Defunded", "MaxBountySet", "Rewarded", "TreasurySet"] },
    autoRoller: { AutoRoller: ["AuthorityUpdated", "KeeperRewardsSet", "MinRollUnitsSet", "Repriced", "Rolled", "StaleAskCancelled", "StrategyStopped"] },
    payoutAdapter: { PayoutRouter: ["AuthorityUpdated", "RouteCleared", "RouteFeeRefreshed", "RouterRouteSet"], UniV3PayoutAdapter: ["RoleAdminChanged", "RoleGranted", "RoleRevoked", "RouteSet"] },
    makerVault: { MakerVault: ["AuthorityUpdated", "LimitsSet", "PositionWithdrawn", "TreasurySet", "Withdrawn"] },
    makerRegistry: { MakerRegistry: ["AuthorityUpdated", "TierSet"] },
    rewardsDistributor: { RewardsDistributor: ["AuthorityUpdated", "Defunded", "RootSet", "TreasurySet"] },
    accessManager: {
      AccessManager: [
        "ManagerRoleAdminChanged", "ManagerRoleGranted", "ManagerRoleRevoked", "OperationCanceled", "OperationExecuted", "OperationScheduled",
        "RoleGrantDelayChanged", "RoleGuardianChanged", "RoleLabel", "TargetAdminDelayUpdated", "TargetClosed", "TargetFunctionRoleUpdated",
      ],
    },
    feeSplitter: {
      FeeSplitter: [
        "AuthorityUpdated", "BoughtBack", "BurnBpsSet", "Burned", "BuybackBalanceWrittenDown", "BuybackCapCeilingSet", "BuybackCapSet", "BuybackCooldownSet",
        "BuybackExecutorSet", "BuybackSkipped", "ConversionSlippageBpsSet", "Distributed", "DistributionSkipped", "OrderBookFeesStranded", "OrderBookSet",
        "PausedSet", "RouterSet", "SettlementOracleSet", "StonkhouseSet", "TreasurySet", "UnroutedAssetRecovered",
      ],
    },
    buybackExecutor: { V4BuybackExecutor: ["Burned"] },
    chainlink: { ChainlinkFeedSource: ["AuthorityUpdated", "BandPinned", "BandSet", "FeedPinned", "FeedSet", "OracleSet"] },
    univ3: { UniV3TwapSource: ["AuthorityUpdated", "OracleSet", "PoolPinned", "PoolSet"] },
    dataStreams: { DataStreamsSource: ["AuthorityUpdated", "DataStreamsFeedPinned", "DataStreamsFeedSet", "OracleSet"] },
    // VenueWrittenOff joined EARN_VAULT_EVENTS; one page, v2_mon_earn_venue_written_off.
    earnVault: { EarnVault: ["AdapterSet", "AuthorityUpdated", "EarnLimitsSet", "FundingEnabledSet", "PulledFromVenue", "SkimBpsSet", "Skimmed", "VenueWrittenOff"] },
  };
  /** Events a scanned contract declares under a name the scan decodes, in a layout the scan deliberately does not.
   *  SELF-EXPIRING: an entry whose event is gone, or now decodes, fails until it is deleted. */
  const NOT_DECODED = {
    "Clearinghouse.Withdrawn": "a holder taking its own ledger balance out (Clearinghouse.withdraw, msg.sender); the scanned Withdrawn is MakerVault's restricted withdraw to the treasury",
  };
  const monitorSrc = readFileSync(new URL("./monitor.mjs", import.meta.url), "utf8");
  const scanned = viem.parseAbi(SCAN_EVENTS);
  const scanLayouts = new Set(scanned.map(layoutOf));
  const argStub = (inputs) => Object.fromEntries(inputs.map((i) => [i.name, i.components ? argStub(i.components) : 0n]));
  /** The name applyScanLogs switches on for a log decoded with this layout, or null when the scan does not decode it. */
  const scanNameOfLayout = new Map(scanned.map((s) => [layoutOf(s), scanEventName({ eventName: s.name, args: argStub(s.inputs) })]));
  /** EARN_VAULT_EVENTS is not exported; read from the source like test (c) above. applyScanLogs drops every other EarnVault log. */
  const earnKept = new Set([...(monitorSrc.match(/const EARN_VAULT_EVENTS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? "").matchAll(/"(\w+)"/g)].map((m) => m[1]));
  /** The contract names of the entries that decode to an EARN_VAULT_EVENTS name (LimitsSet for EarnLimitsSet). */
  const earnRaw = new Set(scanned.filter((s) => earnKept.has(scanNameOfLayout.get(layoutOf(s)))).map((s) => s.name));
  const emittersOf = (exportsOf) => Object.entries(exportsOf).flatMap(([key, byFile]) => Object.keys(byFile).map((file) => ({ key, file, events: abiJson(file).filter((e) => e.type === "event") })));

  /** Every event name applyScanLogs acts on only when it comes from one contract: the `case "X":` groups of its switch
   *  that test isFrom(log, "<key>") (isSource = any registry source), JIT_FUNDING_EMITTER and EARN_VAULT_EVENTS. */
  const expectedFrom = () => {
    const start = monitorSrc.indexOf("export function applyScanLogs(");
    const open = monitorSrc.indexOf("switch (eventName) {", start);
    let depth = 0;
    let end = open + "switch (eventName) ".length;
    for (; end < monitorSrc.length; end += 1) {
      if (monitorSrc[end] === "{") depth += 1;
      else if (monitorSrc[end] === "}" && --depth === 0) break;
    }
    const want = [];
    for (const g of monitorSrc.slice(open, end).matchAll(/((?:case "\w+":\s*)+)([\s\S]*?)(?=case "\w+":|default:)/g)) {
      const keys = [...new Set([...g[2].matchAll(/isFrom\(log, "(\w+)"\)/g)].map((m) => m[1]))];
      if (/isSource\(log\)/.test(g[2])) keys.push("chainlink|univ3|dataStreams");
      for (const c of g[1].matchAll(/case "(\w+)":/g)) for (const key of keys) want.push({ name: c[1], key, where: key.includes("|") ? "applyScanLogs isSource" : "applyScanLogs isFrom" });
    }
    for (const [name, key] of Object.entries(JIT_FUNDING_EMITTER)) want.push({ name, key, where: "JIT_FUNDING_EMITTER" });
    for (const name of earnKept) want.push({ name, key: "earnVault", where: "EARN_VAULT_EVENTS" });
    return want;
  };

  /** One line per way a scanned contract's own export and the scan disagree, each starting "<key> <export>.<event>:". */
  const emitterProblems = (emitters) => {
    const bad = [];
    const scanNames = new Set(scanned.map((s) => s.name));
    for (const { key, file, events } of emitters) {
      for (const e of events) {
        if (!scanNames.has(e.name)) continue; // the scan decodes no event of this name from anyone
        if (key === "earnVault" && !earnRaw.has(e.name)) continue; // applyScanLogs drops it whatever it decodes as
        if (NOT_DECODED[`${file}.${e.name}`] !== undefined) continue;
        const layout = layoutOf(e);
        if (scanLayouts.has(layout)) continue;
        const theirs = scanned.filter((s) => s.name === e.name).map(layoutOf).join("; ");
        bad.push(`${key} ${file}.${e.name}: declares ${layout}; the scan decodes ${e.name} only as ${theirs}, so this contract's ${e.name} logs do not decode`);
      }
    }
    for (const { name, key, where } of expectedFrom()) {
      const from = emitters.filter((x) => key.split("|").includes(x.key));
      const makes = from.some((x) => x.events.some((e) => scanNameOfLayout.get(layoutOf(e)) === name));
      if (!makes) bad.push(`${key} ${from.map((x) => x.file).join("|")}.${name}: the monitor reads ${name} from ${key} (${where}), and no event this export declares decodes as ${name}`);
    }
    // The name pin, both ways.
    for (const { key, file, events } of emitters) {
      const decoded = new Set(events.map((e) => scanNameOfLayout.get(layoutOf(e))).filter((n) => n !== undefined && (key !== "earnVault" || earnKept.has(n))));
      const pinned = EMITTER_EXPORTS[key]?.[file] ?? [];
      for (const n of pinned) if (!decoded.has(n)) bad.push(`${key} ${file}.${n}: pinned in EMITTER_EXPORTS, and no event ${file}.json declares decodes as ${n}: renamed, re-typed or removed, so the monitor no longer sees it from this contract`);
      for (const n of [...decoded].sort()) if (!pinned.includes(n)) bad.push(`${key} ${file}.${n}: ${file}.json declares an event the scan decodes as ${n}, not pinned in EMITTER_EXPORTS.${key}.${file}`);
    }
    return bad;
  };

  test("each scanned contract's own export: every event of a name the scan decodes decodes, and each per-contract event is emitted", async () => {
    const monitor = await import("./monitor.mjs");
    // The scanned contracts, derived from runOnce's protocolAddresses: the name lists it spreads and the registry keys.
    const block = monitorSrc.match(/const protocolAddresses = \[([\s\S]*?)\]\.filter\(Boolean\)/)?.[1] ?? "";
    const keys = [];
    for (const m of block.matchAll(/\.\.\.(\w+)\.map\(/g)) {
      assert.ok(Array.isArray(monitor[m[1]]), `protocolAddresses spreads ${m[1]}, which monitor.mjs does not export as an array`);
      keys.push(...monitor[m[1]]);
    }
    for (const m of block.matchAll(/^\s*reg\.(?:sources\.)?(\w+),?\s*$/gm)) keys.push(m[1]);
    for (const k of ["clearinghouse", "orderBook", "feeSplitter", "chainlink", "earnVault"]) assert.ok(keys.includes(k), `${k} is not among the scanned contracts derived from protocolAddresses: ${keys.join(", ")}`);
    assert.deepEqual([...keys].sort(), Object.keys(EMITTER_EXPORTS).sort(), "EMITTER_EXPORTS must name exactly the contracts protocolAddresses scans");
    assert.match(monitorSrc, /if \(isFrom\(raw, "earnVault"\) && !EARN_VAULT_EVENTS\.has\(eventName\)\) continue;/, "applyScanLogs no longer drops the EarnVault's other logs: revisit the earnVault skip in emitterProblems");
    assert.ok(earnKept.has("PulledFromVenue") && earnKept.has("EarnLimitsSet"), `EARN_VAULT_EVENTS derived as ${[...earnKept].join(", ")}`);
    assert.ok(earnRaw.has("LimitsSet"), "EarnLimitsSet must map back to the contract's LimitsSet");

    const want = expectedFrom();
    assert.ok(want.length >= 30, `only ${want.length} per-contract events derived from monitor.mjs`);
    for (const [name, key] of [["Redeemed", "clearinghouse"], ["Rolled", "autoRoller"], ["Rewarded", "keeperRewards"], ["BandPinned", "chainlink|univ3|dataStreams"], ["FundingSet", "orderBook"], ["PulledFromVenue", "earnVault"]]) {
      assert.ok(want.some((w) => w.name === name && w.key === key), `${name} from ${key} is not among the derived per-contract events`);
    }

    for (const [key, byFile] of Object.entries(EMITTER_EXPORTS)) {
      for (const [file, names] of Object.entries(byFile)) assert.deepEqual(names, [...new Set(names)].sort(), `EMITTER_EXPORTS.${key}.${file}: keep each list sorted and unique`);
    }
    const emitters = emittersOf(EMITTER_EXPORTS);
    for (const [where, why] of Object.entries(NOT_DECODED)) {
      const [file, name] = where.split(".");
      const e = emitters.find((x) => x.file === file)?.events.find((x) => x.name === name);
      assert.ok(e !== undefined, `NOT_DECODED ${where}: ${file}.json no longer declares ${name}; delete the entry (${why})`);
      const as = scanNameOfLayout.get(layoutOf(e));
      const sev = as === undefined ? undefined : CONFIG_EVENTS[as];
      assert.ok(
        as === undefined,
        `NOT_DECODED ${where}: the scan now decodes it as ${as}${sev ? `, which CONFIG_EVENTS pages at ${sev}: every ${file}.${name} (${why}) would page` : ""}. Give it a name of its own in scanEventName or stop decoding it, then delete the entry`,
      );
    }
    assert.deepEqual(emitterProblems(emitters), []);
    // Every entry is some scanned contract's event, not only some export's.
    const emitted = new Set(emitters.flatMap((x) => x.events.map(layoutOf)));
    assert.deepEqual(scanned.map(layoutOf).filter((l) => !emitted.has(l)), [], "SCAN_EVENTS entries no scanned contract declares");
  });

  // The guard on the guard, with every OTHER export left as it is, so the export that hid the drift is still there.
  test("the per-contract check names a drift in one scanned contract that another contract's export would hide", () => {
    const emitters = emittersOf(EMITTER_EXPORTS);
    // Only what a drift ADDS counts, so a real drift in the exports fails the test above and not this one.
    const baseline = new Set(emitterProblems(emitters));
    const problems = (changed) => emitterProblems(changed).filter((l) => !baseline.has(l));
    const withEvent = (key, file, name, change) => {
      assert.ok(emitters.some((x) => x.key === key && x.file === file && x.events.some((e) => e.name === name)), `${file}.json no longer declares ${name}: there is nothing to drift`);
      return emitters.map((x) => (x.key === key && x.file === file ? { ...x, events: x.events.map((e) => (e.name === name ? change(e) : e)) } : x));
    };
    const expectNamed = (bad, key, file, name, how) => {
      assert.ok(bad.length > 0, `${key} ${file}.${name}, ${how}, was not reported`);
      assert.ok(bad.some((l) => l.startsWith(`${key} ${file}.${name}:`)), `${key} ${file}.${name}, ${how}, was reported under another name: ${bad.join(" | ")}`);
      assert.ok(bad.every((l) => l.split(" ")[0].split("|").includes(key)), `${key} ${file}.${name}, ${how}, also blamed another contract: ${bad.join(" | ")}`);
    };
    // Two scratch breaks.
    // bytes29: a type no scanned event uses, so a retype never lands on another layout (or back on the original).
    const retypeFirst = (e) => ({ ...e, inputs: [{ ...e.inputs[0], type: "bytes29", components: undefined }, ...e.inputs.slice(1)] });
    const addArgument = (e) => ({ ...e, inputs: [...e.inputs, { name: "drifted", type: "uint256", indexed: false }] });
    expectNamed(problems(withEvent("clearinghouse", "Clearinghouse", "KeeperRewardsSet", retypeFirst)), "clearinghouse", "Clearinghouse", "KeeperRewardsSet", "retyped");
    expectNamed(problems(withEvent("orderBook", "OrderBook", "FeeRecipientSet", addArgument)), "orderBook", "OrderBook", "FeeRecipientSet", "given an argument");
    // And every event the check covers: retyped, given an argument, its first argument renamed.
    const scanNames = new Set(scanned.map((s) => s.name));
    let covered = 0;
    for (const { key, file, events } of emitters) {
      for (const e of events) {
        if (!scanNames.has(e.name) || (key === "earnVault" && !earnRaw.has(e.name)) || NOT_DECODED[`${file}.${e.name}`] !== undefined) continue;
        covered += 1;
        const renameFirst = (x) => ({ ...x, inputs: [{ ...x.inputs[0], name: `${x.inputs[0].name}Drifted` }, ...x.inputs.slice(1)] });
        for (const [how, change] of Object.entries({ retyped: retypeFirst, "given an argument": addArgument, "first argument renamed": renameFirst })) {
          if (e.inputs.length === 0 && how !== "given an argument") continue;
          expectNamed(problems(withEvent(key, file, e.name, change)), key, file, e.name, how);
        }
      }
    }
    assert.ok(covered >= 100, `only ${covered} scanned-contract events are covered`);
    // Each pinned name renamed in its own export alone, other contracts still declaring it. The
    // first two: KeeperRewards.TreasurySet (also in 3 other contracts), OrderBook.AuthorityUpdated (13 others).
    const renamedIn = (key, file, name) =>
      emitters.map((x) => (x.key === key && x.file === file ? { ...x, events: x.events.map((e) => (scanNameOfLayout.get(layoutOf(e)) === name ? { ...e, name: `${e.name}Drifted` } : e)) } : x));
    const reported = (key, file, name) => [...baseline].some((l) => l.startsWith(`${key} ${file}.${name}:`)); // already missing: the test above names it
    for (const [key, file, name] of [["keeperRewards", "KeeperRewards", "TreasurySet"], ["orderBook", "OrderBook", "AuthorityUpdated"]]) {
      assert.ok(EMITTER_EXPORTS[key][file].includes(name), `EMITTER_EXPORTS.${key}.${file} no longer pins ${name}`);
      if (!reported(key, file, name)) expectNamed(problems(renamedIn(key, file, name)), key, file, name, "renamed");
    }
    let pinsCovered = 0;
    for (const [key, byFile] of Object.entries(EMITTER_EXPORTS)) {
      for (const [file, names] of Object.entries(byFile)) {
        for (const name of names) {
          if (reported(key, file, name)) continue;
          pinsCovered += 1;
          expectNamed(problems(renamedIn(key, file, name)), key, file, name, "renamed");
        }
      }
    }
    assert.ok(pinsCovered >= 100, `only ${pinsCovered} pinned names are covered`);
    // A per-contract event renamed in its own contract(s), still declared under the old name by other exports.
    for (const { name, key } of expectedFrom()) {
      const says = (l) => l.startsWith(`${key} `) && l.includes(`.${name}: the monitor reads ${name} from ${key}`);
      if ([...baseline].some(says)) continue; // already missing: the test above names it
      const keys = key.split("|");
      const renamed = emitters.map((x) =>
        keys.includes(x.key) ? { ...x, events: x.events.map((e) => (scanNameOfLayout.get(layoutOf(e)) === name ? { ...e, name: `${e.name}Drifted` } : e)) } : x,
      );
      const bad = problems(renamed);
      assert.ok(bad.some(says), `${name} renamed in ${key} was not reported: ${bad.join(" | ")}`);
    }
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

  // AutoRoller.cancelStale also fires on the expiry's WITNESS (source 1, the pool TWAP) when spot is
  // not ok or short of the strike (AutoRoller.cancelStale): the silent-feed nights and weekends.
  const witness = (price, updatedAt = 1_790_000_000) => ({ ok: true, price, updatedAt });
  test("A witness past the strike while spot is not ok is overtaken, and pages after rollerStaleS", () => {
    const quiet = ask({ spotOk: false, spot: 0n, witness: witness(200_000_000n) });
    const first = checkRollerAsk(quiet, t);
    assert.equal(first.stale, true);
    assert.deepEqual(first.findings, []);
    const late = checkRollerAsk({ ...quiet, since: 1_790_000_000, now: 1_790_000_060 }, t);
    assert.deepEqual(kinds(late.findings), ["v2_mon_roller_ask_overtaken/error"]);
    assert.match(late.findings[0].message, /the expiry's witness \(source 1, the pool TWAP\) 200\.00 at .*while spot is not ok/);
    assert.equal(late.findings[0].data.overtakenBy, "witness");
    assert.equal(late.findings[0].data.witnessPrice, 200_000_000n);
  });

  test("Spot short of the strike does not clear a witness past it; a witness short of it, or not ok, pages nothing", () => {
    const f = checkRollerAsk(ask({ spot: 199_000_000n, since: 1_789_999_000, witness: witness(201_000_000n) }), t).findings;
    assert.deepEqual(kinds(f), ["v2_mon_roller_ask_overtaken/error"]);
    assert.match(f[0].message, /while spot is 199\.00, short of the strike/);
    assert.deepEqual(checkRollerAsk(ask({ spot: 199_000_000n, since: 1_789_999_000, witness: witness(199_999_999n) }), t), { findings: [], stale: false });
    assert.deepEqual(checkRollerAsk(ask({ spotOk: false, spot: 0n, since: 1_789_999_000, witness: { ok: false, price: 0n, updatedAt: 0 } }), t), { findings: [], stale: false });
    // Spot is tried first, as on chain: a spot overtake reports spot, whatever the witness says.
    assert.equal(checkRollerAsk(ask({ since: 1_789_999_000, witness: witness(201_000_000n) }), t).findings[0].data.overtakenBy, "spot");
  });

  test("witnessReading applies AutoRoller._tryWitness's gates", () => {
    const now = 1_790_000_000;
    const good = { sources: [U, W], oraclePaused: false, latest: [true, 200_000_000n, BigInt(now)] };
    assert.deepEqual(witnessReading(good, now), { ok: true, price: 200_000_000n, updatedAt: now });
    const notOk = { ok: false, price: 0n, updatedAt: 0 };
    assert.deepEqual(witnessReading({ ...good, sources: [U] }, now), notOk, "no source 1");
    assert.deepEqual(witnessReading({ ...good, oraclePaused: true }, now), notOk, "issuer oracle paused");
    assert.deepEqual(witnessReading({ ...good, oraclePaused: null }, now), notOk, "oraclePaused unread counts as paused");
    assert.deepEqual(witnessReading({ ...good, latest: [false, 200_000_000n, BigInt(now)] }, now), notOk);
    assert.deepEqual(witnessReading({ ...good, latest: [true, 0n, BigInt(now)] }, now), notOk);
    assert.deepEqual(witnessReading({ ...good, latest: [true, 2n ** 128n, BigInt(now)] }, now), notOk, "above type(uint128).max");
    assert.equal(witnessReading({ ...good, latest: [true, 2n ** 128n - 1n, BigInt(now)] }, now).ok, true);
    assert.deepEqual(witnessReading({ ...good, latest: [true, 200_000_000n, BigInt(now + 1)] }, now), notOk, "stamped after now");
    assert.equal(witnessReading({ ...good, latest: [true, 200_000_000n, BigInt(now - WITNESS_MAX_AGE)] }, now).ok, true, "exactly WITNESS_MAX_AGE old counts");
    assert.deepEqual(witnessReading({ ...good, latest: [true, 200_000_000n, BigInt(now - WITNESS_MAX_AGE - 1)] }, now), notOk);
    assert.deepEqual(witnessReading(null, now), notOk);
    assert.equal(WITNESS_MAX_AGE, 1800);
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

  test("Two rent logs of one block move the watermark to the later one, so the overlap counts each once", () => {
    // The last block the run counted carries two rent logs. `life` above cannot see this: its last block has one log.
    // Were the watermark left on the block's first log ("20:1"), the next run's re-read would take 20:4 for new.
    const scan = emptyState(4663, "x").scan;
    const block20 = [
      log("Minted", CH, { longId: 84n, writer: W, longTo: W, units: 100n, collateral: 10n ** 18n, fee: 600n }, 20, 1),
      log("Closed", CH, { longId: 84n, account: W, units: 50n, collateralFreed: 10n ** 18n, feeRefund: 250n }, 20, 4),
    ];
    applyScanLogs(scan, block20, addresses);
    applyScanLogs(scan, block20, addresses); // the next run re-reads its last REORG_OVERLAP blocks
    assert.deepEqual(scan.rent["84"], { paid: "600", refunded: "250", accrued: "0", mints: 1, zeroFee: 0 });
    assert.equal(scan.rentAt, "20:4", "the watermark is the block's last counted log, not its first");
    // The skip is by (block, logIndex): a log of block 20 past the watermark, and the next block, still count.
    applyScanLogs(scan, [
      log("MintFeesAccrued", CH, { longId: 84n, asset: U, amount: 70n }, 20, 6),
      log("MintFeesAccrued", CH, { longId: 84n, asset: U, amount: 30n }, 21, 0),
    ], addresses);
    assert.deepEqual(scan.rent["84"], { paid: "600", refunded: "250", accrued: "100", mints: 1, zeroFee: 0 });
    assert.equal(scan.rentAt, "21:0");
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
    // `p`: the ask price the roll rested, kept so a Repriced can be measured against it.
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

/**
 * The alert grace: a blip that clears at once must not send a page.
 * A CONDITION pages only once it has stayed open alertGraceS; one
 * that clears first sends nothing, neither the page nor v2_mon_resolved. Events page at once; a delivered
 * condition escalates at once; a held entry is not a failed delivery.
 */
describe("Alert grace", () => {
  const f = (kind, key, check, severity, event = false) => finding(kind, key, check, `${kind} ${key}`, { n: 1n }, { severity, event });
  const run = (alerts, findings, completed, nowS, extra = {}) => reconcile(alerts, findings, { completed: new Set(completed), nowS, repeatS: 3600, eventRetentionS: 86_400, graceS: 30, ...extra });
  const deliverAll = (alerts, send, nowS) => send.forEach((s) => markDelivered(alerts, s.id, s.finding.severity, nowS));
  const usdg = f("v2_mon_usdg_paused", "u", "usdg", "error");
  const ID = "v2_mon_usdg_paused:u";

  test("a condition is held on first sight and at 29 s, and pages once as new at 30 s", () => {
    const alerts = {};
    let r = run(alerts, [usdg], ["usdg"], 1000);
    assert.deepEqual(r.send, [], "first sighting: not sent");
    assert.deepEqual(r.held.map((h) => `${h.id}/${h.openS}/${h.remainingS}`), [`${ID}/0/30`]);
    assert.equal(alerts[ID].held, true);
    assert.equal(alerts[ID].delivered, false);
    r = run(alerts, [usdg], ["usdg"], 1029);
    assert.deepEqual(r.send, [], "29 s later: still not sent");
    assert.deepEqual(r.held.map((h) => h.remainingS), [1]);
    r = run(alerts, [usdg], ["usdg"], 1030);
    assert.deepEqual(r.send.map((s) => `${s.id}/${s.reason}`), [`${ID}/new`], "30 s later: sent as new");
    assert.deepEqual(r.held, []);
    assert.equal(alerts[ID].held, undefined, "no longer held once sent");
    assert.equal(alerts[ID].firstSeen, 1000, "open since its first sighting");
    deliverAll(alerts, r.send, 1030);
    assert.deepEqual(run(alerts, [usdg], ["usdg"], 1090).send, [], "delivered: silent while open, as before");
  });

  test("a condition that clears inside the grace sends nothing: no page and no resolved", () => {
    const alerts = {};
    run(alerts, [usdg], ["usdg"], 1000);
    let r = run(alerts, [], ["usdg"], 1020);
    assert.deepEqual(r.send, []);
    assert.deepEqual(r.resolved, [], "never delivered, so nothing resolves");
    assert.equal(alerts[ID], undefined, "forgotten");
    r = run(alerts, [usdg], ["usdg"], 1040);
    assert.deepEqual(r.held.map((h) => `${h.openS}/${h.remainingS}`), ["0/30"], "back again: a fresh grace from the new sighting");
  });

  test("a held condition whose check did not complete stays held, and pages once found again past its grace", () => {
    const alerts = {};
    run(alerts, [usdg], ["usdg"], 1000);
    let r = run(alerts, [], [], 1020); // the usdg check failed: a failed read never clears an alert
    assert.deepEqual([r.send, r.resolved], [[], []]);
    assert.equal(alerts[ID].held, true);
    assert.deepEqual(r.held.map((h) => h.remainingS), [10]);
    r = run(alerts, [], [], 1045);
    assert.deepEqual(r.held.map((h) => h.remainingS), [0], "its grace has passed; it waits to be found again");
    assert.deepEqual(r.send, []);
    r = run(alerts, [usdg], ["usdg"], 1050);
    assert.deepEqual(r.send.map((s) => s.reason), ["new"]);
  });

  test("an event pages at once; a delivered condition escalates at once", () => {
    const alerts = {};
    const jump = f("v2_mon_feed_round_jump", "feed:2", "feeds", "warn", true);
    let r = run(alerts, [jump], ["feeds"], 1000);
    assert.deepEqual(r.send.map((s) => `${s.id}/${s.reason}`), ["v2_mon_feed_round_jump:feed:2/new"], "no grace for an event");
    assert.deepEqual(r.held, []);
    const lag = (severity) => f("v2_mon_l2_lag", "head", "head", severity);
    run(alerts, [lag("warn")], ["head"], 1000);
    r = run(alerts, [lag("warn")], ["head"], 1030);
    deliverAll(alerts, r.send, 1030);
    r = run(alerts, [lag("error")], ["head"], 1031);
    assert.deepEqual(r.send.map((s) => `${s.id}/${s.reason}`), ["v2_mon_l2_lag:head/escalated"], "one second later, not after another grace");
  });

  test("grace 0, or none given, keeps the original rule: new on first sight, retry while undelivered", () => {
    for (const extra of [{ graceS: 0 }, { graceS: undefined }]) {
      const alerts = {};
      let r = run(alerts, [usdg], ["usdg"], 1000, extra);
      assert.deepEqual(r.send.map((s) => s.reason), ["new"]);
      assert.deepEqual(r.held, []);
      assert.equal(alerts[ID].held, undefined);
      r = run(alerts, [usdg], ["usdg"], 1060, extra);
      assert.deepEqual(r.send.map((s) => s.reason), ["retry"]);
    }
    const alerts = {};
    const r = reconcile(alerts, [usdg], { completed: new Set(["usdg"]), nowS: 1000 });
    assert.deepEqual(r.send.map((s) => s.reason), ["new"], "a caller that passes no graceS pages rather than holds");
  });

  test("held is not a failed delivery: a held entry never retries, a delivery that failed after the grace does", () => {
    const alerts = {};
    run(alerts, [usdg], ["usdg"], 1000);
    let r = run(alerts, [usdg], ["usdg"], 1010);
    assert.deepEqual(r.send, [], "held, not \"retry\": nothing was attempted");
    r = run(alerts, [usdg], ["usdg"], 1030);
    assert.deepEqual(r.send.map((s) => s.reason), ["new"]);
    // The relay refused it: not markDelivered. That IS a delivery failure, and the next run retries it.
    r = run(alerts, [usdg], ["usdg"], 1031);
    assert.deepEqual(r.send.map((s) => s.reason), ["retry"]);
    assert.equal(alerts[ID].held, undefined);
    assert.equal(alerts[ID].delivered, false);
  });

  test("an entry from a state file written before alert grace existed (no `held`) keeps its meaning", () => {
    const alerts = { [ID]: { kind: usdg.kind, key: usdg.key, check: "usdg", severity: "error", event: false, message: usdg.message, firstSeen: 1000, lastSeen: 1000, delivered: false, sentAt: null, sentSeverity: null } };
    assert.deepEqual(run(alerts, [usdg], ["usdg"], 1001).send.map((s) => s.reason), ["retry"], "undelivered: retried at once, not held");
  });

  test("the loop wakes when the soonest grace ends, not a whole --interval later (nextPassDelayMs)", () => {
    assert.equal(nextPassDelayMs({ intervalS: 60, elapsedMs: 5000, held: [] }), 55_000, "nothing held: --interval as before");
    assert.equal(nextPassDelayMs({ intervalS: 60, elapsedMs: 5000 }), 55_000);
    assert.equal(nextPassDelayMs({ intervalS: 60, elapsedMs: 5000, held: [{ remainingS: 30 }, { remainingS: 12 }] }), 8000, "the soonest grace, plus a second, from the pass's start");
    assert.equal(nextPassDelayMs({ intervalS: 60, elapsedMs: 5000, held: [{ remainingS: 0 }] }), 55_000, "a grace already over (its check failing) is not re-run every second");
    assert.equal(nextPassDelayMs({ intervalS: 60, elapsedMs: 40_000, held: [{ remainingS: 30 }] }), 1000, "at least a second");
    assert.equal(nextPassDelayMs({ intervalS: 20, elapsedMs: 0, held: [{ remainingS: 30 }] }), 20_000, "never later than --interval");
    // End to end: held at 1000, a pass that took 3 s; the next pass (at the whole second the loop wakes) pages it.
    const alerts = {};
    const first = run(alerts, [usdg], ["usdg"], 1000);
    const wakeS = 1000 + Math.floor((3000 + nextPassDelayMs({ intervalS: 60, elapsedMs: 3000, held: first.held })) / 1000);
    assert.equal(wakeS, 1031);
    assert.deepEqual(run(alerts, [usdg], ["usdg"], wakeS).send.map((s) => s.reason), ["new"], "about 30 s after it opened, not 60");
  });

  test("main()'s loop sleeps nextPassDelayMs with the pass's held list, and a held pass is not a mute one", () => {
    const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "monitor.mjs"), "utf8");
    const main = src.slice(src.indexOf("async function main() {"), src.indexOf("process.exit(0);\n}", src.indexOf("async function main() {")));
    assert.match(main, /return \{ code: report\.exit, mute: report\.deliveryFailures > 0, held: report\.held \};/);
    assert.match(main, /const \{ code, mute, held \} = await once\(\);/);
    assert.match(main, /const wait = nextPassDelayMs\(\{ intervalS: opts\.intervalS, elapsedMs: Date\.now\(\) - started, held \}\);/);
    assert.doesNotMatch(main, /opts\.intervalS \* 1000 - \(Date\.now\(\) - started\)/, "the fixed --interval sleep is back");
  });

  test("--alert-grace-seconds and MONITOR_ALERT_GRACE_S set alertGraceS (default 30); the flag wins; bad values are refused", () => {
    assert.equal(DEFAULTS.alertGraceS, 30);
    assert.equal(parseArgs(["--rpc", "http://x"], {}).thresholds.alertGraceS, 30);
    assert.equal(parseArgs(["--rpc", "http://x"], { MONITOR_ALERT_GRACE_S: "45" }).thresholds.alertGraceS, 45);
    assert.equal(parseArgs(["--rpc", "http://x"], { MONITOR_ALERT_GRACE_S: "0" }).thresholds.alertGraceS, 0, "0 pages at once");
    assert.equal(parseArgs(["--rpc", "http://x", "--alert-grace-seconds", "0"], { MONITOR_ALERT_GRACE_S: "45" }).thresholds.alertGraceS, 0);
    assert.equal(parseArgs(["--rpc", "http://x", "--threshold", "alertGraceS=10"], {}).thresholds.alertGraceS, 10);
    assert.throws(() => parseArgs(["--rpc", "http://x", "--alert-grace-seconds", "-1"], {}), /threshold alertGraceS: not a non-negative number/);
    assert.throws(() => parseArgs(["--rpc", "http://x"], { MONITOR_ALERT_GRACE_S: "soon" }), /threshold alertGraceS: not a non-negative number/);
    assert.throws(() => parseArgs(["--rpc", "http://x", "--alert-grace-seconds"], {}), /--alert-grace-seconds needs a value/);
    assert.equal(DEFAULTS.alertGraceS, 30, "defaults are not mutated");
  });

  describe("through runOnce, with the default grace", () => {
    const relayed = async () => {
      const received = [];
      const relay = createServer((req, res) => {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          received.push(JSON.parse(body));
          res.writeHead(200).end("{}");
        });
      });
      const port = await new Promise((resolve) => relay.listen(0, "127.0.0.1", () => resolve(relay.address().port)));
      return { received, relay, env: { ALERT_WEBHOOK: `http://127.0.0.1:${port}/alert`, ALERT_WEBHOOK_TOKEN: "k".repeat(40) } };
    };
    const pausedNvda = () => {
      const dir = tmp("monitor-1089-");
      const NVDA = market("NVDA", 1);
      const registry = writeRegistry(dir, { markets: [NVDA], deployBlock: 1000 });
      const chain = new FakeChain({ head: 20_000n });
      let paused = true;
      chain.read = (address, fn, args) => (paused && fn === "paused" && address.toLowerCase() === NVDA.asset.toLowerCase() ? true : defaultRead(chain, address, fn, args));
      return { dir, registry, chain, unpause: () => (paused = false) };
    };
    const tokenPages = (received) => received.filter((b) => b.kind === "v2_mon_token_paused" || (b.kind === "v2_mon_resolved" && b.data.resolvedKind === "v2_mon_token_paused"));

    test("a paused token is held on the first pass and at +20 s, and paged once at +30 s", async () => {
      const { received, relay, env } = await relayed();
      const { dir, registry, chain } = pausedNvda();
      try {
        const opts = options(dir, registry, [], env);
        assert.equal(opts.thresholds.alertGraceS, 30);
        const r1 = await runOnce(opts, onChain(chain));
        assert.ok(kindsOf(r1).includes("v2_mon_token_paused"), "found");
        assert.ok(r1.held.some((h) => h.kind === "v2_mon_token_paused" && h.remainingS === 30), JSON.stringify(r1.held));
        assert.ok(!r1.sent.some((s) => s.kind === "v2_mon_token_paused"), "not sent on first sight");
        assert.equal(r1.deliveryFailures, 0, "a held condition is not a delivery failure (the --max-failed-passes counter does not move)");
        assert.match(formatReport(r1), /HOLD grace {5}v2_mon_token_paused:\S+ \(open 0 s; pages in 30 s if still open\)/);
        assert.deepEqual(tokenPages(received), []);
        chain.setHead(20_010n, chain.head.timestamp + 20);
        const r2 = await runOnce(opts, onChain(chain));
        assert.ok(r2.held.some((h) => h.kind === "v2_mon_token_paused" && h.remainingS === 10));
        assert.deepEqual(tokenPages(received), [], "+20 s: still nothing");
        chain.setHead(20_015n, chain.head.timestamp + 10);
        const r3 = await runOnce(opts, onChain(chain));
        assert.deepEqual(r3.sent.filter((s) => s.kind === "v2_mon_token_paused").map((s) => `${s.reason}/${s.delivered}`), ["new/true"]);
        assert.deepEqual(tokenPages(received).map((b) => b.kind), ["v2_mon_token_paused"], "+30 s: paged once");
      } finally {
        relay.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a pause that clears inside the grace sends nothing at all, and leaves nothing in the state file", async () => {
      const { received, relay, env } = await relayed();
      const { dir, registry, chain, unpause } = pausedNvda();
      try {
        const opts = options(dir, registry, [], env);
        await runOnce(opts, onChain(chain));
        unpause();
        chain.setHead(20_010n, chain.head.timestamp + 20);
        const r2 = await runOnce(opts, onChain(chain));
        assert.equal(r2.checks.tokens.status, "ok", "the check completed without it");
        assert.deepEqual(r2.held.filter((h) => h.kind === "v2_mon_token_paused"), []);
        assert.deepEqual(tokenPages(received), [], "neither the page nor v2_mon_resolved");
        const saved = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
        assert.ok(!Object.keys(saved.alerts).some((id) => id.startsWith("v2_mon_token_paused")), "forgotten");
      } finally {
        relay.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("one failed USDG paused() read sends nothing once the next pass completes", async () => {
      const { received, relay, env } = await relayed();
      const dir = tmp("monitor-1089-usdg-");
      const registry = writeRegistry(dir, { deployBlock: 1000 });
      const chain = new FakeChain({ head: 20_000n });
      let failing = true;
      chain.read = (address, fn, args) => {
        if (failing && fn === "paused" && address.toLowerCase() === USDG.toLowerCase()) throw transportError("HTTP request failed");
        return defaultRead(chain, address, fn, args);
      };
      const usdgFailed = (b) => (b.kind === "v2_mon_check_failed" && b.data?.check === "usdg") || (b.kind === "v2_mon_resolved" && b.data?.resolvedKind === "v2_mon_check_failed");
      try {
        const opts = options(dir, registry, [], env);
        const r1 = await runOnce(opts, onChain(chain));
        assert.equal(r1.checks.usdg.status, "failed", "the read failed");
        assert.ok(r1.held.some((h) => h.id === "v2_mon_check_failed:usdg"), JSON.stringify(r1.held));
        failing = false;
        chain.setHead(20_010n, chain.head.timestamp + 60); // the next --interval pass
        const r2 = await runOnce(opts, onChain(chain));
        assert.equal(r2.checks.usdg.status, "ok");
        assert.deepEqual(r2.held.filter((h) => h.id === "v2_mon_check_failed:usdg"), []);
        assert.deepEqual(received.filter(usdgFailed), [], "neither v2_mon_check_failed nor its v2_mon_resolved was sent");
      } finally {
        relay.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
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

  test("every kind's ops/alerts.md anchor is a section whose heading names it, and the index row agrees", () => {
    // v2_mon_house_epoch_stall once paged on-call to the Repriced entry instead of its own section. A body-text
    // match would not have caught that (the wrong section carried a pointer note naming the kind), so the HEADING must name it.
    const alerts = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "alerts.md"), "utf8");
    const heads = new Map([...alerts.matchAll(/^#{2,4} §(V\d+[a-z]?)\b.*$/gm)].map((m) => [m[1], m[0]]));
    assert.ok(heads.size > 60, `the section headings were read (${heads.size})`);
    const lines = alerts.split("\n");
    for (const [kind, spec] of Object.entries(KINDS)) {
      const anchors = [...spec.runbook.matchAll(/ops\/alerts\.md §(V\d+[a-z]?)/g)].map((m) => m[1]);
      assert.ok(anchors.length > 0, `${kind}: no ops/alerts.md anchor`);
      for (const a of anchors) {
        assert.ok(heads.has(a), `${kind}: ops/alerts.md has no §${a} heading`);
        assert.ok(heads.get(a).includes(`\`${kind}\``), `${kind}: runbook says §${a}, whose heading does not name it: ${heads.get(a)}`);
      }
      const rows = lines.filter((l) => l.startsWith(`| \`${kind}\` |`));
      assert.equal(rows.length, 1, `${kind}: expected one row in the monitor index of ops/alerts.md`);
      const indexed = [...rows[0].matchAll(/§(V\d+[a-z]?)/g)].map((m) => m[1]);
      for (const a of anchors) assert.ok(indexed.includes(a), `${kind}: runbook says §${a}, the index row says ${indexed.join(", ")}`);
    }
  });

  test("every v2_guardian_* kind the keeper declares has an ops/alerts.md index row and section at its severity", () => {
    // The guardian service pages through the keeper's Alerter, not this
    // monitor, so its kinds are read from keeper/src/v2/alerts.ts ALERT_SEVERITY rather than KINDS.
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const src = readFileSync(path.join(root, "keeper", "src", "v2", "alerts.ts"), "utf8");
    const start = src.indexOf("export const ALERT_SEVERITY");
    const table = src.slice(start, src.indexOf("\n};", start));
    const guardian = [...table.matchAll(/^\s+(v2_guardian_[a-z0-9_]+): '(info|warn|error)',$/gm)].map((m) => [m[1], m[2]]);
    assert.deepEqual(guardian.map(([k]) => k).sort(), [
      "v2_guardian_candidate", "v2_guardian_scale_fault", "v2_guardian_stale_round", "v2_guardian_veto_failed", "v2_guardian_vetoed",
    ], "the guardian's kinds changed: document the new one in ops/alerts.md, then update this list");
    const alerts = readFileSync(path.join(root, "ops", "alerts.md"), "utf8");
    const lines = alerts.split("\n");
    for (const [kind, severity] of guardian) {
      const rows = lines.filter((l) => l.startsWith(`| \`${kind}\` |`));
      assert.equal(rows.length, 1, `${kind}: expected one row in the v2 bot index of ops/alerts.md`);
      const cells = rows[0].split("|").map((c) => c.trim());
      assert.equal(cells[2], "guardian", `${kind}: source column`);
      assert.ok(cells[3].startsWith(severity), `${kind}: the index says '${cells[3]}', the keeper sends ${severity}`);
      const section = cells[6].match(/^§(V\d+)$/)?.[1];
      assert.ok(section, `${kind}: no § in the index row`);
      const head = alerts.match(new RegExp(`^### §${section} .*$`, "m"))?.[0];
      assert.ok(head?.includes(`\`${kind}\` (${severity})`), `${kind}: §${section}'s heading does not name it at ${severity}: ${head}`);
    }
  });

  test("Every kind the keeper declares in ALERT_SEVERITY has one v2 bot index row in ops/alerts.md, at its severity", () => {
    // Eleven kinds (ten v2_mm_* and v2_pricer_clamped) once had no row; nothing checked the whole table,
    // only the guardian's kinds (above). Read from the code, so a kind added without a row, or a row left for a kind
    // the code no longer emits, is caught here.
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const src = readFileSync(path.join(root, "keeper", "src", "v2", "alerts.ts"), "utf8");
    const start = src.indexOf("export const ALERT_SEVERITY");
    const table = src.slice(start, src.indexOf("\n};", start));
    const declared = [...table.matchAll(/^\s+(v2_[a-z0-9_]+): '(info|warn|error)',$/gm)].map((m) => [m[1], m[2]]);
    assert.ok(declared.length > 40, `ALERT_SEVERITY was read (${declared.length} kinds)`);
    const alerts = readFileSync(path.join(root, "ops", "alerts.md"), "utf8");
    const index = alerts.slice(alerts.indexOf("## Index — v2 bot kinds"), alerts.indexOf("## Index — v2 services that send no alert"));
    const rows = index.split("\n").filter((l) => /^\| `v2_[a-z0-9_]+` \|/.test(l));
    const problems = [];
    for (const [kind, severity] of declared) {
      const mine = rows.filter((l) => l.startsWith(`| \`${kind}\` |`));
      if (mine.length !== 1) problems.push(`${kind}: ${mine.length} rows in the v2 bot index`);
      else if (!mine[0].split("|")[3].trim().startsWith(severity)) problems.push(`${kind}: the index says '${mine[0].split("|")[3].trim()}', the code ${severity}`);
    }
    const declaredKinds = new Set(declared.map(([k]) => k));
    for (const row of rows) {
      const kind = row.match(/^\| `(v2_[a-z0-9_]+)` \|/)[1];
      if (!declaredKinds.has(kind)) problems.push(`${kind}: indexed, but the keeper does not declare it`);
    }
    assert.deepEqual(problems, []);
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
    // an unreachable view read as "absent" and resolve the open alert.
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
    const first = await runOnce(opts, onChain(chain));
    assert.equal(first.checks.divergence.status, "ok");
    assert.equal(first.findings.find((f) => f.kind === "v2_mon_price_divergence")?.severity, "warn");
    chain.setHead(chain.head.number + 1n, chain.head.timestamp + 60);
    const second = await runOnce(opts, onChain(chain));
    assert.equal(second.findings.find((f) => f.kind === "v2_mon_price_divergence")?.severity, "error");
    poolOk = false;
    chain.setHead(chain.head.number + 1n, chain.head.timestamp + 60);
    const missing = await runOnce(opts, onChain(chain));
    assert.equal(missing.checks.divergence.status, "incomplete");
    assert.equal(kindsOf(missing).includes("v2_mon_price_divergence"), false);
    poolOk = true;
    poolPrice = 100_500_000n;
    chain.setHead(chain.head.number + 1n, chain.head.timestamp + 60);
    const clear = await runOnce(opts, onChain(chain));
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
    // Re-derived from the registry itself: a registry change cut tier1.json to the launch set
    // (NVDA and SPCX only), and a later write-back released both live. The old pins (35 rows, NVDA
    // planned, TSLA present) described the pre-launch 35-market registry.
    assert.deepEqual(reg.markets.map((m) => m.ticker), ["NVDA", "SPCX"]);
    assert.deepEqual(reg.markets.map((m) => m.v2.status), ["live", "live"]);
    const nvda = reg.markets.find((m) => m.ticker === "NVDA");
    assert.equal(nvda.v2.univ3MinLiquidity, 1_700_000_000_000_000_000n);
    // Scope is live and paused, never planned: the same property the old NVDA-flip checked, on the rows that exist.
    const withStatus = (status) => ({ ...reg, markets: reg.markets.map((m) => (m.ticker === "SPCX" ? { ...m, v2: { ...m.v2, status } } : m)) });
    assert.deepEqual(marketsInScope(reg).map((m) => m.ticker), ["NVDA", "SPCX"]);
    assert.deepEqual(marketsInScope(withStatus("planned")).map((m) => m.ticker), ["NVDA"]);
    assert.deepEqual(marketsInScope(withStatus("paused")).map((m) => m.ticker), ["NVDA", "SPCX"]);
    assert.equal(marketsInScope(withStatus("planned"), { allMarkets: true }).length, 2);
    assert.deepEqual(marketsInScope(reg, { tickers: ["spcx"] }).map((m) => m.ticker), ["SPCX"]);
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
    // Alert grace 0: this pins delivery, dedupe and resolve on first sight on the wall clock; the grace
    // has its own tests (the alert grace suite).
    const opts = parseArgs(
      ["--once", "--rpc", "http://127.0.0.1:1", "--registry", registry, "--state", path.join(dir, "state.json"), "--health", `cranker=http://127.0.0.1:${svcPort}/good`, "--health", `notifier=http://127.0.0.1:${svcPort}/bad`, "--alert-grace-seconds", "0"],
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

  // A read that FAILS is not evidence of a reorg. Resetting on it moved adoptConfigUntil to
  // the head and adopted every admin event since the last run without a page.
  const anchorRun = async ({ anchorReadFails }) => {
    const dir = scratch("monitor-anchor-");
    const registry = writeRegistry(dir, { deployBlock: 1000 });
    const chain = new FakeChain({ head: 20_000n });
    const opts = options(dir, registry);

    await runOnce(opts, onChain(chain));
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
    const r2 = await runOnce(opts, onChain(chain));
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
    await runOnce(opts, onChain(chain));
    chain.setHead(20_100n, chain.head.timestamp + 10);
    chain.getBlockHook = (n) => ({ ...chain.blockAt(n), hash: `0x${"b".repeat(64)}` });
    const r2 = await runOnce(opts, onChain(chain));
    assert.ok(
      r2.notes.some((n) => n.includes("is not the one seen last run")),
      `notes: ${JSON.stringify(r2.notes)}`,
    );
    const s2 = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(s2.scan.adoptConfigUntil, "20100");
  });

  // Finalized on the oracle used to end the expiry for the settlement check, and the redeem
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
      // The series is HELD (500 units of long and short), so an unsettled one can matter.
      if (fn === "totalSupply" && String(address).toLowerCase() === C.clearinghouse.toLowerCase()) return 500n;
      return defaultRead(chain, address, fn, args);
    };
    const r = await runOnce(options(dir, registry), onChain(chain));
    return { r, state: JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")) };
  };

  /*
   * A weekend drill: a daily ladder of 6 series where 1 traded and 5 nobody bought. The cranker
   * settles only a series with supply (keeper/src/v2/cranker/planner.ts `!s.settled && s.longSupply > 0n`), so the 5
   * empty ones stay unsettled for ever. `settled`: the ladder indices that emitted SeriesSettled; `held`: long supply per
   * index (short supply equal); `unreadable`: indices whose totalSupply reverts.
   */
  const U_LADDER = addr(0xa001);
  const ladderRun = async ({ settled, held, unreadable = new Set() }) => {
    const dir = scratch("monitor-ladder-");
    const registry = writeRegistry(dir, { deployBlock: 1000 });
    const now = 1_790_000_000;
    const E = now - 6 * 3_600;
    const U = U_LADDER;
    const ids = [0, 1, 2, 3, 4, 5].map((i) => (0x2000n + BigInt(i)) << 1n);
    const chain = new FakeChain({ head: 20_000n, timestamp: now });
    ids.forEach((longId, i) =>
      chain.logs.push(
        rawLog(
          "event SeriesCreated(uint256 indexed longId, address indexed underlying, bool isPut, uint128 strike, uint40 expiry, address oracle, uint16 exerciseFeeBps, uint32 mintFeePpm)",
          { longId, underlying: U, isPut: false, strike: 200_000_000n + BigInt(i) * 5_000_000n, expiry: E, oracle: C.settlementOracle, exerciseFeeBps: 30, mintFeePpm: 80 },
          { address: C.clearinghouse, blockNumber: 5000 + i, logIndex: i },
        ),
      ),
    );
    for (const i of settled) {
      chain.logs.push(
        rawLog(
          "event SeriesSettled(uint256 indexed longId, uint256 settlementPrice, uint256 longPayoutPerUnit, uint256 feePerUnit, uint256 shortPayoutPerUnit)",
          { longId: ids[i], settlementPrice: 210_000_000n, longPayoutPerUnit: 0n, feePerUnit: 0n, shortPayoutPerUnit: 0n },
          { address: C.clearinghouse, blockNumber: 6000 + i },
        ),
      );
    }
    const indexOf = (id) => ids.findIndex((x) => x === (BigInt(id) & ~1n));
    chain.read = (address, fn, args) => {
      if (fn === "openInterest") return 100n; // the traded series' 100 units: open interest is left all along
      if (fn === "settlementInfo") return [2, 210_000_000n, 0, true, false, true]; // Finalized
      if (fn === "series") {
        const i = indexOf(args[0]);
        return { underlying: U, isPut: false, expiry: BigInt(E), strike: 200_000_000n, oracle: C.settlementOracle, exerciseFeeBps: 30, settled: settled.includes(i), settlementPrice: 210_000_000n, longPayoutPerUnit: 0n, feePerUnit: 0n, shortPayoutPerUnit: 0n, mintFeePpm: 80, mintFeesHeld: 0n };
      }
      if (fn === "totalSupply" && String(address).toLowerCase() === C.clearinghouse.toLowerCase()) {
        const i = indexOf(args[0]);
        if (unreadable.has(i)) throw new Error("execution reverted");
        return held[i] ?? 0n;
      }
      return defaultRead(chain, address, fn, args);
    };
    const r = await runOnce(options(dir, registry), onChain(chain));
    return { r, ids, E, state: JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")) };
  };
  const unsettledPages = (r) => r.findings.filter((f) => f.kind === "v2_mon_series_unsettled");

  test("A halt seen during an expiry's window pages the guardian, stays open after the chain resumes, and clears once Held", async () => {
    const dir = scratch("monitor-halt-");
    const registry = writeRegistry(dir, { deployBlock: 1000 });
    const haltAt = 1_790_000_000;
    const E = haltAt + 600; // window [haltAt - 1200, haltAt + 600]: the halt starts inside it
    const far = haltAt + 10_800; // window [haltAt + 9000, haltAt + 10800]: after the halt, never overlapped
    const U = addr(0xa001);
    const chain = new FakeChain({ head: 20_000n, timestamp: haltAt });
    const SERIES = "event SeriesCreated(uint256 indexed longId, address indexed underlying, bool isPut, uint128 strike, uint40 expiry, address oracle, uint16 exerciseFeeBps, uint32 mintFeePpm)";
    chain.logs.push(
      rawLog(SERIES, { longId: 0x1234n << 1n, underlying: U, isPut: false, strike: 200_000_000n, expiry: E, oracle: C.settlementOracle, exerciseFeeBps: 30, mintFeePpm: 80 }, { address: C.clearinghouse, blockNumber: 5000 }),
      rawLog(SERIES, { longId: 0x5678n << 1n, underlying: U, isPut: false, strike: 200_000_000n, expiry: far, oracle: C.settlementOracle, exerciseFeeBps: 30, mintFeePpm: 80 }, { address: C.clearinghouse, blockNumber: 5001, logIndex: 1 }),
    );
    let status = 0; // None
    chain.read = (address, fn, args) => {
      if (fn === "openInterest") return 100n;
      if (fn === "settlementInfo") return [status, 0n, 0, false, false, false];
      return defaultRead(chain, address, fn, args);
    };
    const opts = options(dir, registry);
    // The run report carries { id: "<kind>:<key>", kind, severity, message }; the key is underlying:expiry:reason.
    const vetoPages = (r) => r.findings.filter((f) => f.kind === "v2_mon_guardian_veto_due");
    const pageId = (expiry) => `v2_mon_guardian_veto_due:${U.toLowerCase()}:${expiry}:halt`;

    // The chain has stopped: the wall clock is 1,000 s past the last block, so the head lags past lagErrorS.
    const halted = await runOnce(opts, { viem: fakeViem(chain), nowMs: () => (haltAt + 1_000) * 1000 });
    assert.ok(kindsOf(halted).includes("v2_mon_l2_lag"), `findings: ${JSON.stringify(kindsOf(halted))}`);
    assert.deepEqual(vetoPages(halted).map((f) => [f.id, f.severity]), [[pageId(E), "error"]],
      "only the expiry whose window the halt overlaps, although it is still ahead of the frozen head");
    assert.match(vetoPages(halted)[0].message, new RegExp(`before its first finalize \\(anyone may call it from ${new Date((E + 120) * 1000).toISOString().slice(0, 16)}`));

    // The chain resumed past E: no lag any more, but the veto is still owed, and only now can it be sent.
    chain.setHead(20_500n, haltAt + 2_000);
    const resumed = await runOnce(opts, onChain(chain));
    assert.ok(!kindsOf(resumed).includes("v2_mon_l2_lag"));
    assert.deepEqual(vetoPages(resumed).map((f) => f.id), [pageId(E)], "the halt is remembered in the state file");

    // The guardian's veto landed: Held, and the page clears.
    status = 3;
    const vetoed = await runOnce(opts, onChain(chain));
    assert.deepEqual(vetoPages(vetoed), []);
  });

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

  test("1 traded and settled + 5 empty unsettled series: no page, and the expiry is done", async () => {
    // Control: count every SeriesCreated id again (`unsettledWithSupply` returning its input) and this pages
    // "5 of 6 series" and leaves the expiry open, as the drill measured at E+6 h and E+19.3 h.
    const { r, state } = await ladderRun({ settled: [0], held: [100n] });
    assert.deepEqual(unsettledPages(r), [], `findings: ${JSON.stringify(kindsOf(r))}`);
    assert.equal(Object.keys(state.scan.expiryDone).length, 1, "an expiry whose only unsettled series are empty is done");
  });

  test("1 traded but unsettled + 5 empty series: the page names the 1 held series", async () => {
    const { r, E, state } = await ladderRun({ settled: [], held: [100n] });
    const pages = unsettledPages(r);
    assert.equal(pages.length, 1, `findings: ${JSON.stringify(kindsOf(r))}`);
    assert.equal(pages[0].severity, "error", "the alert for a held series is unchanged: error");
    assert.match(pages[0].message, /1 of 6 series is held and still unsettled on the Clearinghouse/);
    assert.equal(pages[0].id, `v2_mon_series_unsettled:${U_LADDER.toLowerCase()}:${E}`, "one page per expiry, as before");
    assert.deepEqual(state.scan.expiryDone, {}, "the expiry stays open while a held series is unsettled");
  });

  test("A series whose supply cannot be read counts as held (fail closed) and the run says so", async () => {
    const { r, ids, state } = await ladderRun({ settled: [0], held: [100n], unreadable: new Set([3]) });
    const pages = unsettledPages(r);
    assert.equal(pages.length, 1, `findings: ${JSON.stringify(kindsOf(r))}`);
    assert.match(pages[0].message, /1 of 6 series is held and still unsettled/);
    assert.ok(r.notes.some((n) => n.includes(`Clearinghouse.totalSupply of series ${ids[3]} could not be read`)), `notes: ${JSON.stringify(r.notes)}`);
    assert.deepEqual(state.scan.expiryDone, {});
  });

  // --no-alerts saves no cursor, so maxRangesPerRun used to fix the runbooks' laptop diagnostic to
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
    return runOnce(options(dir, registry, extra), onChain(chain));
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

  // A check that dies half-way has already moved the state for the inputs it read (a feed baseline,
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
    await runOnce(opts, onChain(chain)); // baseline: aggregator A

    aggregator = addr(0xa99002); // the NVDA proxy switches phase
    chain.setHead(20_600n, chain.head.timestamp + 60);
    chain.getCodeHook = () => {
      throw transportError(); // the owner Safe's getCode times out, after both markets were read
    };
    const r2 = await runOnce(opts, onChain(chain));
    assert.equal(r2.checks.feeds.status, "failed");
    assert.ok(kindsOf(r2).includes("v2_mon_feed_aggregator_changed"), `findings: ${JSON.stringify(kindsOf(r2))}`);
  });

  // The registry's v2.status is a build-time value; the Clearinghouse is the truth about what users
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
    const r = await runOnce(options(dir, registry), onChain(chain));
    assert.ok(kindsOf(r).includes("v2_mon_token_paused"), `findings: ${JSON.stringify(kindsOf(r))}`);
    assert.ok(
      r.notes.some((n) => n.includes("AMD (registry says planned)")),
      `notes: ${JSON.stringify(r.notes)}`,
    );
  });

  // An adopted PoolSet (a first run, a reset, a lost state file) left nothing watching what the
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
    const r = await runOnce(options(dir, registry), onChain(chain));
    assert.deepEqual(kindsOf(r), [TVL_DARK, "v2_mon_pool_wiring", "v2_mon_pool_wiring"], "one for the pool, one for the floor");
    assert.equal(r.exit, 1);
  });

  // An expiry pinned before a setFeed(A -> B) still settles on A, and only B was watched.
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
    const r = await runOnce(options(dir, registry), onChain(chain));
    assert.ok(
      r.findings.some((f) => f.kind === "v2_mon_feed_access_controller" && f.message.toLowerCase().includes(OLD.toLowerCase())),
      `findings: ${JSON.stringify(r.findings.map((f) => f.kind))}`,
    );
  });

  // An event kind pages once and never again, so counting a printed line as a delivery threw it away.
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
      // Alert grace 0: this pins logging and the retry on first sight; the grace has its own tests.
      const noGrace = ["--alert-grace-seconds", "0"];
      await runOnce(options(dir, registry, noGrace), onChain(chain)); // a quiet first run sets the adoption boundary
      chain.logs.push(rawLog(ROLE_GRANTED, { role: DEFAULT_ADMIN_ROLE, account: addr(0xbad), sender: addr(0xbad) }, { address: C.clearinghouse, blockNumber: 20_050 }));
      chain.setHead(20_060n, chain.head.timestamp + 6);

      const blind = await runOnce(options(dir, registry, noGrace), onChain(chain));
      assert.deepEqual(blind.sent.map((s) => `${s.kind}/${s.delivered}/${s.logged}`), ["v2_mon_config_changed/false/true", `${TVL_DARK}/false/true`]);
      assert.equal(blind.deliveryFailures, 0, "nowhere to send is not a delivery failure");
      assert.equal(blind.exit, 1, "and must not raise the exit code to 4");

      chain.setHead(20_100n, chain.head.timestamp + 4);
      const wired = await runOnce(options(dir, registry, noGrace, { ALERT_WEBHOOK: `http://127.0.0.1:${port}/alert` }), onChain(chain));
      assert.deepEqual(
        wired.sent.map((s) => `${s.kind}/${s.reason}/${s.delivered}`),
        [`${TVL_DARK}/retry/true`, "v2_mon_config_changed/retry/true"],
      );
      assert.deepEqual(received, [TVL_DARK, "v2_mon_config_changed"]);
    } finally {
      relay.close();
    }
  });

  // The state file is the monitor's whole memory. A write that failed (EACCES on a volume without
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
      const r1 = await runOnce(opts, onChain(chain));
      assert.ok(kindsOf(r1).includes("v2_mon_state_unwritable"), `findings: ${JSON.stringify(kindsOf(r1))}`);
      assert.equal(r1.exit, 1, "an unwritable state path is an error finding, not a thrown run");

      chain.logs.push(rawLog(ROLE_GRANTED, { role: DEFAULT_ADMIN_ROLE, account: addr(0xbad), sender: addr(0xbad) }, { address: C.clearinghouse, blockNumber: 20_300 }));
      chain.setHead(20_600n, chain.head.timestamp + 60);
      await runOnce(opts, onChain(chain));
      chain.setHead(21_200n, chain.head.timestamp + 60);
      await runOnce(opts, onChain(chain));

      assert.ok(received.includes("v2_mon_config_changed"), `the RoleGranted(DEFAULT_ADMIN_ROLE) between two runs must page, not be adopted: ${JSON.stringify(received)}`);
      assert.equal(received.filter((k) => k === "v2_mon_token_paused").length, 1, `the open condition must page once, not every run: ${JSON.stringify(received)}`);
    } finally {
      chmodSync(stateDir, 0o755);
      relay.close();
    }
  });

  // On a v9 fork: chmod 0555 on the state directory gave one v2_mon_state_unwritable page plus 8
  // duplicates (the fallback started EMPTY, so every open condition paged again), and chmod 0755 never resolved it
  // (the page was open only in the fallback, and the next run read the configured file).
  test("the fallback starts from the last readable state, and a writable path again resolves the page", async () => {
    const received = [];
    const relay = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.writeHead(200).end("{}");
      });
    });
    const port = await new Promise((resolve) => relay.listen(0, "127.0.0.1", () => resolve(relay.address().port)));
    const dir = scratch("monitor-703-fallback-");
    const stateDir = path.join(dir, "data");
    mkdirSync(stateDir);
    const stateFile = path.join(stateDir, "monitor-v2.json");
    const fallback = fallbackStatePath(stateFile);
    rmSync(fallback, { force: true });
    const count = (kind) => received.filter((b) => b.kind === kind).length;
    try {
      const NVDA = market("NVDA", 1);
      const registry = writeRegistry(dir, { markets: [NVDA], deployBlock: 1000 });
      const chain = new FakeChain({ head: 20_000n });
      chain.read = (address, fn, args) => (fn === "paused" && address.toLowerCase() === NVDA.asset.toLowerCase() ? true : defaultRead(chain, address, fn, args));
      // Alert grace 0: this pins the page and its resolve on first sight; the grace has its own tests.
      const opts = parseArgs(["--once", "--rpc", "http://127.0.0.1:9", "--registry", registry, "--state", stateFile, "--alert-grace-seconds", "0"], {
        ALERT_WEBHOOK: `http://127.0.0.1:${port}/alert`,
        ALERT_WEBHOOK_TOKEN: "k".repeat(40),
      });
      await runOnce(opts, onChain(chain));
      assert.equal(count("v2_mon_token_paused"), 1, "the open condition pages once while the state file is writable");
      const pagedBefore = received.length;

      chmodSync(stateDir, 0o555);
      chain.setHead(20_600n, chain.head.timestamp + 60);
      const r1 = await runOnce(opts, onChain(chain));
      assert.equal(r1.state, fallback, "the run writes the fallback");
      assert.ok(r1.notes.some((n) => n.includes(`read from ${stateFile}`)), `the fallback is seeded from the configured file: ${JSON.stringify(r1.notes)}`);
      assert.deepEqual(received.slice(pagedBefore).map((b) => b.kind), ["v2_mon_state_unwritable"], "entering the fallback pages only the fallback itself");
      chain.setHead(21_200n, chain.head.timestamp + 60);
      await runOnce(opts, onChain(chain));
      assert.equal(count("v2_mon_state_unwritable"), 1, "and once, not every run");
      assert.equal(count("v2_mon_token_paused"), 1, "no condition already paged pages again");

      chmodSync(stateDir, 0o755);
      chain.setHead(21_800n, chain.head.timestamp + 60);
      const r3 = await runOnce(opts, onChain(chain));
      assert.equal(r3.state, stateFile, "writable again: the configured file");
      assert.ok(!kindsOf(r3).includes("v2_mon_state_unwritable"), `findings: ${JSON.stringify(kindsOf(r3))}`);
      const resolved = received.filter((b) => b.kind === "v2_mon_resolved").map((b) => b.data.resolvedKind);
      assert.deepEqual(resolved, ["v2_mon_state_unwritable"], "the page resolves once the path is writable");
      assert.equal(count("v2_mon_token_paused"), 1, "leaving the fallback re-pages nothing either");
      assert.equal(existsSync(fallback), false, "the spent fallback is removed");
      const saved = JSON.parse(readFileSync(stateFile, "utf8"));
      assert.ok(Object.keys(saved.alerts).some((id) => id.startsWith("v2_mon_token_paused")), "the configured file carries the open condition");
      assert.ok(!Object.keys(saved.alerts).some((id) => id.startsWith("v2_mon_state_unwritable")), "and not the resolved page");
    } finally {
      chmodSync(stateDir, 0o755);
      rmSync(fallback, { force: true });
      relay.close();
    }
  });

  test("newerState: the latest matching state wins; a missing, foreign or unreadable file never does; a tie is the first", () => {
    const dir = scratch("monitor-703-newer-");
    const write = (name, s) => {
      const f = path.join(dir, name);
      writeFileSync(f, typeof s === "string" ? s : JSON.stringify(s));
      return f;
    };
    const ok = (at) => ({ version: 1, chainId: 4663, fingerprint: "fp", lastRun: { at } });
    const a = write("a.json", ok(100));
    const b = write("b.json", ok(200));
    assert.equal(newerState([a, b], 4663, "fp"), b);
    assert.equal(newerState([b, a], 4663, "fp"), b);
    assert.equal(newerState([a, write("tie.json", ok(100))], 4663, "fp"), a, "a tie keeps the first (the path the run writes)");
    assert.equal(newerState([a, path.join(dir, "missing.json")], 4663, "fp"), a);
    assert.equal(newerState([path.join(dir, "missing.json"), a], 4663, "fp"), a);
    assert.equal(newerState([a, write("foreign.json", { ...ok(900), fingerprint: "other" })], 4663, "fp"), a, "another deployment's state is not newer");
    assert.equal(newerState([a, write("chain.json", { ...ok(900), chainId: 1 })], 4663, "fp"), a);
    assert.equal(newerState([a, write("junk.json", "{not json")], 4663, "fp"), a);
    const none = path.join(dir, "none.json");
    assert.equal(newerState([none, path.join(dir, "none2.json")], 4663, "fp"), none, "nothing usable: the first");
  });

  // Nothing ever left scan state. 35 markets on dailies add about 70 series a day for ever, in a file
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
    const r = await runOnce(options(dir, registry), onChain(chain));
    assert.equal(r.checks.scan.status, "ok", r.checks.scan.detail);
    assert.ok(chain.calls.maxInflightGetBlock <= 16, `${chain.calls.maxInflightGetBlock} getBlock requests in flight at once is a burst a rate-limited public RPC answers with 429s`);
    const state = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(Object.keys(state.scan.series).length, 0, "every one of these expiries is done and months old: none of it belongs in the state file");
    assert.deepEqual(state.scan.expiryDone, {}, "and no expiryDone key outlives its series");
  });

  // Delivery is one POST per alert, and the relay forwards synchronously, so a rate-limited channel
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
      // Alert grace 0: this pins the delivery order of a first-sight burst; the grace has its own tests.
      const opts = options(dir, registry, ["--alert-grace-seconds", "0"], { ALERT_WEBHOOK: `http://127.0.0.1:${port}/alert`, ALERT_WEBHOOK_TOKEN: "k".repeat(40) });
      await runOnce(opts, onChain(chain)); // first run adopts history and opens the pool conditions
      taken = 0;
      received.length = 0;
      chain.logs.push(rawLog(ROLE_GRANTED, { role: DEFAULT_ADMIN_ROLE, account: addr(0xbad), sender: addr(0xbad) }, { address: C.clearinghouse, blockNumber: 20_050 }));
      chain.setHead(20_100n, chain.head.timestamp + 10);
      const r = await runOnce(opts, onChain(chain));
      assert.ok(r.sent.length > 3, `the burst must be bigger than the channel takes: ${r.sent.length}`);
      assert.equal(received[0], "v2_mon_config_changed", `the admin-role grant must go first, not behind the warn conditions: ${JSON.stringify(received)}`);
    } finally {
      relay.close();
    }
  });

  // liquidity() was compared with the floor with no hysteresis, so a pool resting on its floor paged
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
        await runOnce(opts, onChain(chain));
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
    const r = await runOnce(options(dir, registry), onChain(chain));
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
    const r = await runOnce(options(dir, registry), onChain(chain));
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
    const r = await runOnce(options(dir, registry), onChain(chain));
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
    const r1 = await runOnce(opts, onChain(chain));
    assert.deepEqual(kindsOf(r1), [TVL_DARK], "one pass over the strike is not evidence yet: nothing pages but the dark audit trigger");
    const s1 = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.deepEqual(s1.scan.rollerStale[`${W}:${U2}`], { orderId: "7", since: now });

    chain.setHead(20_100n, now + 120);
    const r2 = await runOnce(opts, onChain(chain));
    assert.deepEqual(kindsOf(r2), ["v2_mon_roller_ask_overtaken", TVL_DARK]);
    assert.equal(r2.findings[0].severity, "error");
    assert.match(r2.findings[0].message, /NVDA \(call 200\.00, 5\.00 shares left.*at or past its strike for 2 min/);

    // The cranker cancels it: the ask is gone, the alert resolves, and the timer is dropped.
    live = false;
    chain.setHead(20_200n, now + 180);
    const r3 = await runOnce(opts, onChain(chain));
    assert.deepEqual(kindsOf(r3), [TVL_DARK], "the roller page clears; the dark audit trigger is unrelated and stays");
    const s3 = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(s3.alerts[`v2_mon_roller_ask_overtaken:${W.toLowerCase()}:${U2.toLowerCase()}`], undefined, "the condition closes when the ask is gone");
    assert.deepEqual(s3.scan.rollerStale, {});
    assert.ok(s3.scan.roller[`${W.toLowerCase()}:${U2.toLowerCase()}`] !== undefined, "the position stays tracked until its expiry is long past");
  });

  // A setMarketOracle moves the market's pointer and leaves every series already created on the oracle
  // createSeries pinned into it, which is what cancelStale reads and what the series settles on. Two series
  // under ONE underlying can therefore be judged on two different oracles in one pass. A monitor reading the
  // registry's published SettlementOracle (or the market's pointer) judges both on a price the contract does not use,
  // and never pages for the in-the-money ask left resting.
  test("Two series on one underlying with different pinned oracles are each judged on their own", async () => {
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
    await runOnce(opts, onChain(chain));
    assert.deepEqual([...new Set(asked)].sort(), [ORACLE_A.toLowerCase(), ORACLE_B.toLowerCase()].sort(), "one trySpot per pinned series oracle");
    assert.ok(!asked.includes(String(C.settlementOracle).toLowerCase()), "the registry's published oracle is not a spot source for an existing series");
    const s1 = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.deepEqual(
      Object.keys(s1.scan.rollerStale),
      [`${W1.toLowerCase()}:${U2.toLowerCase()}`],
      "only the series whose OWN oracle has overtaken it starts the clock",
    );

    chain.setHead(20_100n, now + 120);
    const r2 = await runOnce(opts, onChain(chain));
    // Only this page's findings: the rest of the pass is another check's business and not what is pinned here.
    const roller = r2.findings.filter((f) => f.kind.startsWith("v2_mon_roller"));
    assert.deepEqual(roller.map((f) => f.kind), ["v2_mon_roller_ask_overtaken"], "one page, not two and not none");
    assert.equal(roller[0].id, `v2_mon_roller_ask_overtaken:${W1.toLowerCase()}:${U2.toLowerCase()}`, "and it names the writer whose series oracle overtook it");
    assert.match(roller[0].message, /spot 210\.00/, "the price it judged on is oracle A's, the one series 84 pinned - not B's 190.00 and not the published oracle's");
  });
});

// The unit tests in "v6: pins made outside a series creation" and "v6: pins
// check" hand prePinFindings and checkPinnedBy a `houses` list built by the test. These run a whole pass, so the runOnce
// wiring those checks depend on is exercised: the House vault's own logs read beside the scan, ctx.houses, the House logs
// passed to prePinFindings, and checkPinnedBy's houses argument. The vault comes from the registry (markets[].v2.house).
describe("A whole pass vouches a registered House vault's own boundary pin, and nothing else", () => {
  const dirs = [];
  const scratch = (prefix) => {
    const d = tmp(prefix);
    dirs.push(d);
    return d;
  };
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const HOUSE = addr(0x4a11);
  const NOW = 1_790_000_000;
  const PINNED = "event SettlementConfigPinned(address indexed underlying, uint40 indexed expiry, address[] sources, uint16 maxDeviationBps, uint32 uncorroboratedDelay)";
  const ROLLED = "event EpochRolled(uint64 indexed epochId, uint40 indexed epochEnd, uint256 price, uint256 nav, uint256 supply, uint256 sharesMinted, uint256 sharesBurned, uint256 performanceFee)";
  const SERIES = "event SeriesCreated(uint256 indexed longId, address indexed underlying, bool isPut, uint128 strike, uint40 expiry, address oracle, uint16 exerciseFeeBps, uint32 mintFeePpm)";
  const ROLL_TX = `0x${"37".repeat(32)}`;
  const E = gridCloses(NOW)[0];

  /** NVDA, with HOUSE in its daily House slot when `listed`, else no House vault in the registry at all. */
  const nvda = (listed) => {
    const m = market("NVDA", 1);
    m.v2.house = { weekly: null, daily: listed ? HOUSE : null };
    return m;
  };
  /** The vault's views. pinnedBoundary() is 0, so only the same-transaction roll can vouch the pin below. */
  const houseView = (NVDA, fn) => ({ underlying: NVDA.asset, pinnedBoundary: 0, epochEnd: E, epochId: 7n, trackedSeries: [], oracle: C.settlementOracle, weekly: false, performanceFeeOwed: 0n })[fn];
  const pages = (r, kind) => r.findings.filter((f) => f.kind === kind);

  /** First pass adopts to 20,000; then ONE transaction: the oracle pins E and the vault logs its roll (rollEpoch -> _pinBoundary). */
  const prePinPass = async ({ listed }) => {
    const dir = scratch("monitor-937-prepin-");
    const NVDA = nvda(listed);
    const registry = writeRegistry(dir, { markets: [NVDA] });
    const chain = new FakeChain({ head: 20_000n, timestamp: NOW });
    chain.read = (address, fn, args) => {
      const v = sameAddress(address, HOUSE) ? houseView(NVDA, fn) : undefined;
      return v !== undefined ? v : defaultRead(chain, address, fn, args);
    };
    const opts = options(dir, registry);
    await runOnce(opts, onChain(chain));
    chain.logs.push(
      rawLog(PINNED, { underlying: NVDA.asset, expiry: E, sources: [SRC.chainlink], maxDeviationBps: 150, uncorroboratedDelay: 21_600 }, { address: C.settlementOracle, blockNumber: 20_050, logIndex: 0, tx: ROLL_TX }),
      rawLog(ROLLED, { epochId: 6n, epochEnd: E - 86_400, price: 1n, nav: 1n, supply: 1n, sharesMinted: 0n, sharesBurned: 0n, performanceFee: 0n }, { address: HOUSE, blockNumber: 20_050, logIndex: 1, tx: ROLL_TX }),
    );
    chain.setHead(20_100n, NOW + 10);
    return runOnce(opts, onChain(chain));
  };

  test("the registry's House vault rolls and pins its next boundary in one transaction: no v2_mon_pre_pin", async () => {
    const r = await prePinPass({ listed: true });
    assert.deepEqual(pages(r, "v2_mon_pre_pin"), [], `findings: ${JSON.stringify(kindsOf(r))}`);
    assert.ok(!r.notes.some((n) => n.includes("House vault roll and deposit logs could not be read")), `notes: ${JSON.stringify(r.notes)}`);
  });

  test("the same transaction with the vault dropped from the registry pages v2_mon_pre_pin (the alarm still works)", async () => {
    const r = await prePinPass({ listed: false });
    const f = pages(r, "v2_mon_pre_pin");
    assert.equal(f.length, 1, `findings: ${JSON.stringify(kindsOf(r))}`);
    assert.equal(f[0].severity, "error");
    assert.match(f[0].message, /SettlementConfigPinned/);
  });

  /** One registered NVDA market, one creatable expiry E, and SettlementOracle.pinnedBy(NVDA, E) = HOUSE. */
  const pinnedByPass = async ({ listed, series }) => {
    const dir = scratch("monitor-937-pinnedby-");
    const NVDA = nvda(listed);
    const registry = writeRegistry(dir, { markets: [NVDA] });
    const chain = new FakeChain({ head: 20_000n, timestamp: NOW });
    if (series) {
      chain.logs.push(rawLog(SERIES, { longId: 0x937n << 1n, underlying: NVDA.asset, isPut: false, strike: 200_000_000n, expiry: E, oracle: C.settlementOracle, exerciseFeeBps: 30, mintFeePpm: 80 }, { address: C.clearinghouse, blockNumber: 5000 }));
    }
    chain.read = (address, fn, args) => {
      const v = sameAddress(address, HOUSE) ? houseView(NVDA, fn) : undefined;
      if (v !== undefined) return v;
      if (fn === "market" && sameAddress(args?.[0], NVDA.asset)) return { enabled: true, mintPaused: false, strikeTick: 100n, exerciseFeeBps: 30, oracle: C.settlementOracle, mintFeePpm: 80 };
      if (fn === "isValidExpiry") return Number(args[0]) === E;
      // HouseVault._pinBoundary -> SettlementOracle.pinBoundary records the vault as the expiry's pinner.
      if (fn === "pinnedBy" && sameAddress(args?.[0], NVDA.asset) && Number(args[1]) === E) return HOUSE;
      return defaultRead(chain, address, fn, args);
    };
    return runOnce(options(dir, registry), onChain(chain));
  };

  test("pinnedBy is the registry's House vault and the expiry has no series: no v2_mon_pinned_by", async () => {
    const r = await pinnedByPass({ listed: true, series: false });
    assert.deepEqual(pages(r, "v2_mon_pinned_by"), [], `findings: ${JSON.stringify(kindsOf(r))}`);
  });

  test("pinnedBy the same address with the vault dropped from the registry pages v2_mon_pinned_by (pre-pin)", async () => {
    const r = await pinnedByPass({ listed: false, series: false });
    const f = pages(r, "v2_mon_pinned_by");
    assert.equal(f.length, 1, `findings: ${JSON.stringify(kindsOf(r))}`);
    assert.match(f[0].message, /no series: a pin made outside a mint/);
  });

  test("pinnedBy the registry's House vault on an expiry that has a series pages v2_mon_pinned_by", async () => {
    const r = await pinnedByPass({ listed: true, series: true });
    const f = pages(r, "v2_mon_pinned_by");
    assert.equal(f.length, 1, `findings: ${JSON.stringify(kindsOf(r))}`);
    assert.match(f[0].message, /has series/);
  });
});

/* -------------------------------------------------------------------------------------------------
 * The always-on loop, as a real child process.
 * ------------------------------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------------------------------
 * AutoRoller.Repriced: the PRICER lane moving a writer's ask. The contract caps each reprice to a
 * MAX_REPRICE_DROP_BPS drop so a leaked key needs several calls to reach the floor, and the contract NatSpec
 * (AutoRoller.sol:134) promises each one pages. The scan remembers the ask each roll rested and each reprice set;
 * repriceFindings judges every new reprice against the price it replaced (floor-ward step) and against the
 * registry pricer key (foreign sender), and warns the rest at a rate cap. Nothing typed in: the signature is the
 * ABI's, the cap is the contract's mirrored constant, the key is the registry's.
 * ------------------------------------------------------------------------------------------------- */
describe("AutoRoller.Repriced pages a floor-ward step and a foreign sender, warns the rest at a cap", () => {
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

  test("(a) a floor-ward step pages: the drop is at least REPRICE_PAGE_DROP_BPS (20 %); a small move does not", () => {
    // 20 % of the ask in one call (REPRICE_PAGE_DROP_BPS): the boundary, inclusive.
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
    // A maximal contract step (25 %) pages too.
    const maximal = repriced(1_875_000n, { priceBefore: "2500000" });
    assert.deepEqual(kinds(repriceFindings([maximal], "100", ctx([maximal]))), ["v2_mon_reprice_floorward/error"]);
  });

  /*
   * The pricer now steps a large drop down in several reprices. The
   * page threshold is ONE value shared with it, and the pricer's own largest step stays under it, so an honest step-down
   * never pages "revoke PRICER" while a key walking the ask down at the contract cap still does.
   */
  test("The page threshold is the keeper's REPRICE_PAGE_DROP_BPS, and the pricer's largest step does not page", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const src = readFileSync(path.join(root, "keeper", "src", "v2", "cranker", "constants.ts"), "utf8");
    const keeperConst = (name) => {
      const m = src.match(new RegExp(`export const ${name} = ([0-9_]+)n;`));
      assert.ok(m, `keeper/src/v2/cranker/constants.ts exports ${name} as a literal`);
      return Number(m[1].replaceAll("_", ""));
    };
    assert.equal(REPRICE_PAGE_DROP_BPS, keeperConst("REPRICE_PAGE_DROP_BPS"), "one threshold for the pricer and the monitor");
    assert.ok(REPRICE_PAGE_DROP_BPS < MAX_REPRICE_DROP_BPS, "the page fires before a key reaches the contract cap");
    // The pricer's largest step, priced as keeper/src/v2/pricer/planner.ts stepFloor prices it (rounded up to the tick).
    const stepBps = BigInt(keeperConst("PRICER_MAX_STEP_DROP_BPS"));
    for (const before of [2_500_000n, 3_183_100n, 1_273_300n, 999_999_900n]) {
      const raw = (before * (10_000n - stepBps) + 9_999n) / 10_000n;
      const price = ((raw + 99n) / 100n) * 100n;
      const e = repriced(price, { priceBefore: before.toString() });
      assert.deepEqual(kinds(repriceFindings([e], "100", ctx([e]))), ["v2_mon_repriced/warn"], `the pricer's step ${before} -> ${price} is not a page`);
    }
    // And no environment can move the page under the pricer's step: the old fraction is not a threshold any more.
    assert.equal("repricePageDropFraction" in DEFAULTS, false);
    assert.throws(() => parseArgs(["--once"], { RH_RPC: "http://127.0.0.1:1", MONITOR_THRESHOLDS: "repricePageDropFraction=0.5" }), (err) => err instanceof UsageError && /unknown threshold "repricePageDropFraction"/.test(err.message));
    assert.doesNotThrow(() => parseArgs(["--once"], { RH_RPC: "http://127.0.0.1:1", MONITOR_THRESHOLDS: "repriceWarnCap=5" }), "a threshold that exists still parses (positive control)");
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
 * The issuer's OraclePaused() / OracleUnpaused() LOGS on the launch tokens page v2_mon_oracle_halted
 * (error) and clear themselves. The per-poll oraclePaused() flag (v2_mon_oracle_paused, warn) cannot see a halt
 * that starts and ends between two polls; the log can. The topics are derived from the event signatures with
 * viem, never typed; the addresses come from the registry rows named by --launch, never typed.
 * ------------------------------------------------------------------------------------------------- */
describe("The launch tokens' OraclePaused() log pages and clears itself", () => {
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
    // Below the deploy block: a halt log the bounded scan must never see (the "unbounded eth_getLogs" defect).
    chain.tokenLogs.push(halted(NVDA.asset, 500));
    // A third, non-launch token halts: not the launch set, not a page.
    chain.tokenLogs.push(halted(TSLA.asset, 15_000));
    const opts = options(dir, registry, ["--launch", "NVDA,SPCX"]);

    const r1 = await runOnce(opts, onChain(chain));
    assert.ok(seen.length >= 2, `both halt events were scanned: ${JSON.stringify(seen)}`);
    assert.ok(seen.every((x) => BigInt(x.from) >= 1000n), `every halt scan starts at or above the deploy block: ${JSON.stringify(seen)}`);
    assert.ok(!kindsOf(r1).includes("v2_mon_oracle_halted"), `no page from a pre-deploy log or a third token: ${JSON.stringify(kindsOf(r1))}`);
    assert.equal(r1.checks.tokens.status, "ok");
    assert.match(r1.checks.tokens.detail, /OraclePaused\/OracleUnpaused log\(s\) for NVDA, SPCX/);

    // THE PAGE: NVDA halts between two polls of oraclePaused() (the flag reads false at both), the log is enough.
    chain.tokenLogs.push(halted(NVDA.asset, 20_100));
    chain.setHead(20_200n, chain.head.timestamp + 60);
    const r2 = await runOnce(opts, onChain(chain));
    const page = r2.findings.filter((f) => f.kind === "v2_mon_oracle_halted");
    assert.equal(page.length, 1, `one page for NVDA: ${JSON.stringify(kindsOf(r2))}`);
    assert.equal(page[0].id, `v2_mon_oracle_halted:${NVDA.asset.toLowerCase()}`, "keyed by the token, so one page per halt");
    assert.equal(page[0].severity, "error");
    assert.match(page[0].message, /NVDA OraclePaused\(\) at block 20100/);

    // Still halted next run: the same page stays open (dedupe), no second copy.
    chain.setHead(20_300n, chain.head.timestamp + 60);
    const r3 = await runOnce(opts, onChain(chain));
    assert.equal(r3.findings.filter((f) => f.kind === "v2_mon_oracle_halted").length, 1, "the halt stays reported while it lasts");

    // THE CLEAR: OracleUnpaused lands; the finding is gone and the state no longer carries the halt.
    chain.tokenLogs.push(unhalted(NVDA.asset, 20_350));
    chain.setHead(20_400n, chain.head.timestamp + 60);
    const r4 = await runOnce(opts, onChain(chain));
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
    const r = await runOnce(options(dir, registry, ["--launch", "NVDA,SPCX"]), onChain(chain));
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

  // A relay that refuses every page gives exit 4 on every pass. The loop used to ignore that and
  // run on for ever, so nothing outside the process ever learnt the monitor was mute (the runbook
  // names a failed run as the only out-of-band sign).
  // These two pin the give-up rule on passes that page at once: --alert-grace-seconds 0. With the 30 s
  // grace the first passes only HOLD the head page, so nothing is refused yet and the second test would stay alive
  // without ever reaching the delivered exit-3 pass it is named for. The grace's own loop tests follow.
  test("gives up with the pass's own exit code after --max-failed-passes passes that reached nobody", async () => {
    relayStatus = 502;
    const { output, exit } = await loop(["--interval", "5", "--max-failed-passes", "2", "--alert-grace-seconds", "0"]);
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
    const { child, output, exit } = await loop(["--interval", "5", "--max-failed-passes", "1", "--alert-grace-seconds", "0"]);
    await new Promise((r) => setTimeout(r, 7000));
    const alive = child.exitCode === null;
    child.kill("SIGTERM");
    const code = await exit;
    const out = output();
    assert.ok(alive, `the loop must still be running after two delivered exit-3 passes. Output:\n${out}`);
    assert.ok((out.match(/exit 3$/gm) ?? []).length >= 2, `at least two passes. Output:\n${out}`);
    assert.match(out, /SENT new +v2_mon_check_failed:head/, `the first pass delivered its page. Output:\n${out}`);
    assert.equal(code, 0);
  });

  // A pass that only HOLDS a condition in its grace reached nobody because it sent nothing, not because a
  // page was refused. It is not a mute pass: --max-failed-passes 1 against a refusing relay must not give up on it.
  test("a pass that only holds a condition in its alert grace is not a mute pass", async () => {
    relayStatus = 502;
    const { child, output, exit } = await loop(["--interval", "5", "--max-failed-passes", "1", "--alert-grace-seconds", "60"]);
    await new Promise((r) => setTimeout(r, 7000));
    const alive = child.exitCode === null;
    child.kill("SIGTERM");
    await exit;
    const out = output();
    assert.ok(alive, `held passes must not trip the give-up. Output:\n${out}`);
    assert.ok((out.match(/HOLD grace {5}v2_mon_check_failed:head/g) ?? []).length >= 2, `at least two passes held the head page. Output:\n${out}`);
    assert.doesNotMatch(out, /FAIL new/, "nothing was sent to be refused");
  });

  // With --interval 60 and a 3 s grace, the held head page goes out on a pass about 4 s later,
  // not 60 s later: the loop wakes when the grace ends.
  test("the loop wakes when a held condition's grace ends, not a whole --interval later", async () => {
    relayStatus = 200;
    const { child, output, exit } = await loop(["--interval", "60", "--alert-grace-seconds", "3"]);
    const t0 = Date.now();
    while (!/SENT new +v2_mon_check_failed:head/.test(output()) && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 200));
    const tookMs = Date.now() - t0;
    child.kill("SIGTERM");
    await exit;
    const out = output();
    assert.match(out, /HOLD grace {5}v2_mon_check_failed:head \(open 0 s; pages in 3 s if still open\)/, `the first pass held it. Output:\n${out}`);
    assert.match(out, /SENT new +v2_mon_check_failed:head/, `a second pass paged it. Output:\n${out}`);
    assert.ok(tookMs < 20_000, `paged ${tookMs} ms after start, well inside the 60 s --interval`);
  });
});

/* -------------------------------------------------------------------------------------------------
 * Priceability, source clocks, provider/method switches and pricer work.
 *
 * Every input here is a fixture: the bodies the pricing service and the pricer serve TODAY
 * (keeper/src/v2/pricing/server.ts, keeper/src/v2/pricer/pricer.ts state()), plus the additive pricing
 * `provenance` object no build emits yet, to prove the monitor reads it when one does and never
 * requires it. No network: the pure checks take the parsed bodies, and the one whole-pass test serves
 * them from a local http server on 127.0.0.1.
 * ------------------------------------------------------------------------------------------------- */
describe("quote readiness, per tenor", () => {
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

  test("a reason code this build does not know is NOT ready and pages on its own", () => {
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

  test("pricing provenance is read when a build serves it and never required: a degraded readiness and a stated reason are both not ready", () => {
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

  test("a zero fair is a price, a null fair is a refusal (neither is ever encoded as the other)", () => {
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

describe("source clock ages, unknown included", () => {
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

describe("provider and method switches", () => {
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

describe("The event calendar re-check read off the pricing service's /health", () => {
  test("only an overdue ticker pages, keyed on the ticker, at warn, and a missing or malformed field is not served", () => {
    const r = checkEventRecheck({
      SPCX: { recheckBy: "2026-10-15", overdue: true, coveredBy: null },
      NVDA: { recheckBy: "2026-10-15", overdue: false, coveredBy: "through" },
      TSLA: { recheckBy: "2026-10-15", overdue: "yes" },
    });
    assert.equal(r.served, true);
    assert.deepEqual(r.overdue, ["SPCX"], "only overdue === true counts");
    assert.deepEqual(r.findings.map((f) => [f.kind, f.key, f.check, f.severity, f.event]), [["v2_mon_event_recheck_overdue", "SPCX", "pricing", "warn", false]]);
    assert.deepEqual(r.findings[0].data, { ticker: "SPCX", recheckBy: "2026-10-15", coveredBy: null });
    assert.deepEqual(checkEventRecheck({}), { served: true, overdue: [], findings: [] });
    for (const absent of [undefined, null, [], "overdue"]) assert.deepEqual(checkEventRecheck(absent), { served: false, overdue: [], findings: [] }, String(absent));
  });
});

describe("the pricer is running versus the pricer is evaluating", () => {
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

describe("a whole pass against a fixture pricing service and pricer", () => {
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
      if (url.pathname === "/health") return json(200, { status: "ok", service: "callhouse-pricing", settings: { maxChainAgeS: 1800 }, chains: { NVDA: { ok: true, usable: plan.usable ?? "ok", fetchedAt: new Date().toISOString(), error: null, chainTimestamp: "2026-09-17 16:00:00", lastTradeTime: "2026-09-17 15:59:58", options: 900 } }, ...(plan.eventRecheck === undefined ? {} : { eventRecheck: plan.eventRecheck() }) });
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

  test("An overdue event-calendar re-check pages per ticker, clears when covered, and a build without the field is a note", async () => {
    const dir = scratch("monitor-pricing-recheck-");
    const registry = writeRegistry(dir, { markets: [market("NVDA", 1)] });
    const statePath = seed(dir, registry);
    const open = () => Object.keys(JSON.parse(readFileSync(statePath, "utf8")).alerts).filter((id) => id.startsWith("v2_mon_event_recheck_overdue"));
    let recheck = { NVDA: { recheckBy: "2026-10-15", overdue: true, coveredBy: null }, SPCX: { recheckBy: "2026-10-15", overdue: false, coveredBy: "event" } };
    const pricing = await pricingService({ eventRecheck: () => recheck });
    const opts = options(dir, registry, ["--pricing", pricing]);

    const r1 = await runOnce(opts);
    const ours = r1.findings.filter((f) => f.kind === "v2_mon_event_recheck_overdue");
    assert.deepEqual(ours.map((f) => f.id), ["v2_mon_event_recheck_overdue:NVDA"], "SPCX has a dated row: covered");
    assert.equal(ours[0].severity, "warn");
    assert.match(ours[0].message, /re-check day 2026-10-15 has passed/);
    assert.match(r1.checks.pricing.detail, /event calendar re-check overdue: NVDA/);
    assert.ok(!r1.notes.some((n) => /no `eventRecheck`/.test(n)), "the field is served");
    assert.deepEqual(open(), ["v2_mon_event_recheck_overdue:NVDA"], "the condition is held open in the state file");

    // A confirmed row lands: the service stops reporting NVDA overdue, and the condition closes on a completed pass.
    recheck = { NVDA: { recheckBy: "2027-01-15", overdue: false, coveredBy: "event" } };
    const r2 = await runOnce(opts);
    assert.equal(r2.checks.pricing.status, "ok");
    assert.deepEqual(r2.findings.filter((f) => f.kind === "v2_mon_event_recheck_overdue"), []);
    assert.deepEqual(open(), []);

    // An older build serves no eventRecheck: unknown, said in a note, never a silence and never a page.
    const dir2 = scratch("monitor-pricing-recheck-absent-");
    const registry2 = writeRegistry(dir2, { markets: [market("NVDA", 1)] });
    seed(dir2, registry2);
    const legacy = await pricingService({});
    const r3 = await runOnce(options(dir2, registry2, ["--pricing", legacy]));
    assert.deepEqual(r3.findings.filter((f) => f.kind === "v2_mon_event_recheck_overdue"), []);
    assert.ok(r3.notes.some((n) => /\/health carries no `eventRecheck`/.test(n)));
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
    // The count is derived, not typed (adding NEW_LISTING made "eleven" stale). What the old
    // literal protected is kept: the ids are exactly 0..N-1, the walk the contracts' access-matrix test makes
    // (V8Roles.COUNT), so a gap, a duplicate or a role that lost its id still fails here.
    const ids = Object.values(m.ids).sort((a, b) => a - b);
    assert.deepEqual(ids, ids.map((_, i) => i), `role ids are 0..${ids.length - 1} with no gap: ${JSON.stringify(m.ids)}`);
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
    const wrong = managerEventFindings([v8log("RoleGranted", { roleId: id, account: ADMIN_SAFE, delay: 3600, since: 1, newMember: true })].map((l) => ({ ...l, eventName: "ManagerRoleGranted" })), null, mctx());
    assert.equal(right.length, 1, "every grant pages, right delay or not");
    assert.doesNotMatch(right[0].message, /different clock/);
    assert.match(wrong[0].message, /different clock/);
    assert.match(wrong[0].message, /CONFIG_ADMIN/);
    // A 0 grant before this monitor has seen the lock is the launch role profile's, and says so; after the
    // lock the same grant is a different clock again. Both still page as error: every grant does.
    const zero = [v8log("RoleGranted", { roleId: id, account: ADMIN_SAFE, delay: 0, since: 1, newMember: true })].map((l) => ({ ...l, eventName: "ManagerRoleGranted" }));
    const [prelock] = managerEventFindings(zero, null, mctx());
    const [afterLock] = managerEventFindings(zero, null, mctx({ lockSeen: true }));
    assert.match(prelock.message, /launch role profile grants every lane until `stonkctl lock`/);
    assert.doesNotMatch(prelock.message, /different clock/);
    assert.match(afterLock.message, /different clock/);
    assert.deepEqual([prelock.severity, afterLock.severity], ["error", "error"]);
  });

  test("NEW_LISTING is a named zero-delay Admin Safe lane, and registerMarket / createVault resolve to it", () => {
    const m = ROLE_MANIFEST.manifest;
    const id = m.ids.NEW_LISTING;
    assert.ok(Number.isInteger(id), "the published manifest carries NEW_LISTING");
    assert.equal(roleLabel(id), `NEW_LISTING (${id})`, "named, never 'not in the manifest'");
    assert.equal(roleDelayS(id), 0, "the first-listing lane has no execution delay");
    assert.ok(m.holders.adminSafe.includes("NEW_LISTING"), "the Admin Safe is its published holder");
    // The Admin Safe granted NEW_LISTING at 0 is the manifest's own delay, before the lock and after it: it pages (every
    // grant does) but never as a different clock, and never as the launch profile's zeroed lane.
    const grant = [{ ...v8log("x", { roleId: id, account: ADMIN_SAFE, delay: 0, since: 1, newMember: true }), eventName: "ManagerRoleGranted" }];
    for (const lockSeen of [false, true]) {
      const [f] = managerEventFindings(grant, null, mctx({ lockSeen }));
      assert.match(f.message, new RegExp(`NEW_LISTING \\(${id}\\) granted to`));
      assert.doesNotMatch(f.message, /different clock|launch role profile/, `lockSeen ${lockSeen}`);
    }
    // The two moved selectors, hashed here (viem) and pinned against the values `cast` derived
    // (test/v2/InterfaceIds.t.sol). A TargetFunctionRoleUpdated to NEW_LISTING agrees with the manifest; the same
    // selector put back on LISTING is called out as not the manifest's.
    const viem = loadViem();
    const selectors = {};
    for (const [contract, fns] of Object.entries(m.targets)) {
      for (const [signature, role] of Object.entries(fns)) selectors[viem.toFunctionSelector(`function ${signature}`)] = { contract, signature, role };
    }
    const moved = [
      ["Clearinghouse", "registerMarket(address,uint64,bool)", "0x9ae621ee"],
      ["HouseVaultFactory", "createVault(address,(uint64,uint128,uint16,uint16,uint32,uint128),string,string,bool)", "0x970a66b3"],
    ];
    for (const [contract, signature, pinned] of moved) {
      assert.equal(viem.toFunctionSelector(`function ${signature}`), pinned, signature);
      assert.deepEqual(selectors[pinned], { contract, signature, role: "NEW_LISTING" });
      const moveTo = (roleId) => managerEventFindings([v8log("TargetFunctionRoleUpdated", { target: addr(0xc2), selector: pinned, roleId })], null, mctx({ selectors }))[0].message;
      assert.match(moveTo(id), new RegExp(`${contract}\\.${signature.split("(")[0]}\\(.*now needs NEW_LISTING \\(${id}\\);`), "no 'the manifest says': the lane IS the manifest's");
      assert.match(moveTo(m.ids.LISTING), /now needs LISTING \(5\) \(the manifest says NEW_LISTING\)/);
    }
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

  test("A .launchOnly pair (guardianKey's GUARDIAN) is revoked by the lock: not held after it is never a page; held after it is ONE page", () => {
    const g = (over = {}) => member({ label: "guardianKey", address: addr(0x6a), roleId: 7, roleName: "GUARDIAN", executionDelay: 0, wantDelayS: 0, launchOnly: true, ...over });
    const safeLocked = member(); // the Admin Safe's FEE_MANAGER at its manifest delay: the table reads "locked"
    const safeLaunch = member({ executionDelay: 0 });
    // after the lock: the guardian key without GUARDIAN is the planned end state, not "every call reverts"
    assert.deepEqual(checkManagerWiring({ manager: MANAGER, rows: [], members: [safeLocked, g({ isMember: false })] }), []);
    // during the launch days it holds it: no page. Before the lock
    // the pair is a published holder like any other, so a guardian key WITHOUT it pages :missing.
    const launch = checkManagerWiring({ manager: MANAGER, rows: [], members: [safeLaunch, g()] });
    assert.deepEqual(launch.map((f) => f.key.split(":").pop()), ["prelock"]);
    assert.deepEqual(checkManagerWiring({ manager: MANAGER, rows: [], members: [safeLaunch, g({ isMember: false })] }).map((f) => f.key.split(":").pop()), ["missing", "prelock"]);
    // held after the lock (the table locked, or a lock this monitor saw): ONE page for the key,
    // v2_mon_manager_launch_key (error), naming the post-lock end state and the Admin Safe. Never a second :extra page too.
    const held = checkManagerWiring({ manager: MANAGER, rows: [], members: [safeLocked, g()] });
    assert.equal(held.length, 1);
    assert.equal(held[0].kind, "v2_mon_manager_launch_key");
    assert.match(held[0].key, /:7:0x0{38}6a:launch$/);
    assert.equal(held[0].severity, "error");
    assert.match(held[0].message, /guardianKey .* still holds GUARDIAN \(7\) after the lock \(every delayed lane is at its manifest delay\)\. roles\.v8\.json lists this pair under launchOnly: the one-transaction lock revokes it and only the Admin Safe keeps the role/);
    const seen = checkManagerWiring({ manager: MANAGER, rows: [], members: [safeLaunch, g()], lock: { block: "900", at: 1_700_000_000 } });
    const seenKey = seen.filter((f) => /:7:0x0{38}6a:/.test(f.key));
    assert.deepEqual(seenKey.map((f) => f.key.split(":").pop()), ["launch"], "a lock seen and undone pages the held guardian key once");
    // control: a pair that is NOT launch-only and not held still pages :missing
    assert.match(checkManagerWiring({ manager: MANAGER, rows: [], members: [g({ launchOnly: false, isMember: false })] })[0].key, /:missing$/);
  });

  test("The published manifest's .launchOnly is loaded (empty until roles.json is re-exported)", () => {
    assert.equal(typeof ROLE_MANIFEST.manifest.launchOnly, "object");
    assert.ok(ROLE_MANIFEST.manifest.launchOnly !== null);
  });

  test("a holder that does not hold its role, and one that holds a role it should not, both page", () => {
    const missing = checkManagerWiring({ manager: MANAGER, rows: [], members: [member({ isMember: false })] });
    const extra = checkManagerWiring({ manager: MANAGER, rows: [], members: [member({ wantMember: false })] });
    assert.match(missing[0].key, /:missing$/);
    assert.match(missing[0].message, /does NOT hold/);
    assert.match(extra[0].key, /:extra$/);
  });

  test("a member whose execution delay is not the manifest's pages: the delay IS the protection", () => {
    // A wrong NON-zero delay pages whatever phase the table is in (the launch profile does not loosen this).
    const shorter = checkManagerWiring({ manager: MANAGER, rows: [], members: [member({ executionDelay: 3600 })] });
    assert.equal(shorter.length, 1);
    assert.match(shorter[0].key, /:delay$/);
    assert.equal(shorter[0].severity, "error");
    assert.match(shorter[0].message, /less time to notice and cancel/);
    // A 0 after this monitor has seen the lock is the lock undone: a :delay error, named as such.
    const undone = checkManagerWiring({ manager: MANAGER, rows: [], members: [member({ executionDelay: 0 })], lock: { block: "900", at: 1_700_000_000 } });
    assert.equal(undone.length, 1);
    assert.match(undone[0].key, /:delay$/);
    assert.equal(undone[0].severity, "error");
    assert.match(undone[0].message, /saw the planned delays at block 900 .*the lock has been undone/);
  });

  describe("The launch role profile before `stonkctl lock`", () => {
    // The Admin Safe's delayed lanes, as the manifest publishes them, plus one delay-0 lane and a hot key.
    const lanes = ["ADMIN", "FEE_MANAGER", "MARKET_FEE_MANAGER", "CONFIG_ADMIN", "TREASURY_ADMIN", "LISTING", "OPS_ADMIN"].map((name) =>
      member({ roleId: ROLE_MANIFEST.manifest.ids[name], roleName: name, wantDelayS: ROLE_MANIFEST.manifest.delaysS[name], executionDelay: ROLE_MANIFEST.manifest.delaysS[name] }),
    );
    const hot = member({ label: "pricerKey", address: addr(0xb02), roleId: ROLE_MANIFEST.manifest.ids.PRICER, roleName: "PRICER", wantDelayS: 0, executionDelay: 0 });
    const zeroed = [...lanes.map((mb) => ({ ...mb, executionDelay: 0 })), hot];
    const delayed = lanes.filter((mb) => mb.wantDelayS > 0).length;

    test("the phase is read from the chain's own table: locked, launch, mixed, unknown", () => {
      assert.ok(delayed >= 2, "the manifest must carry at least two delayed Admin Safe lanes, or mixed cannot be built");
      assert.equal(managerDelayPhase([...lanes, hot]), "locked");
      assert.equal(managerDelayPhase(zeroed), "launch");
      assert.equal(managerDelayPhase([{ ...lanes[0], executionDelay: 0 }, ...lanes.slice(1), hot]), "mixed");
      assert.equal(managerDelayPhase([hot]), "unknown", "no delayed lane read: nothing to say about the lock");
      assert.equal(managerDelayPhase([{ ...lanes[0], executionDelay: null }, { ...lanes[1], isMember: false }]), "unknown", "unread and missing members are not evidence of either side");
    });

    test("every delayed lane at 0 and no lock seen: ONE warn naming every lane, no P1 per lane", () => {
      const out = checkManagerWiring({ manager: MANAGER, rows: [], members: zeroed });
      assert.equal(out.length, 1, JSON.stringify(out.map((f) => f.key)));
      assert.equal(out[0].key, `${MANAGER.toLowerCase()}:prelock`);
      assert.equal(out[0].kind, "v2_mon_manager_wiring");
      assert.equal(out[0].severity, "warn");
      assert.equal(out[0].data.lanes.length, delayed);
      assert.deepEqual(out[0].data.lanes.map((l) => l.role), lanes.filter((mb) => mb.wantDelayS > 0).map((mb) => mb.roleName));
      assert.match(out[0].message, /launch role profile before `stonkctl lock`/);
    });

    test("the pre-lock rule never hides a WRONG non-zero delay, a mixed table, a missing or an extra holder", () => {
      // One lane at a wrong non-zero delay: the table is mixed, so every lane off its delay is a P1.
      const wrongOne = checkManagerWiring({ manager: MANAGER, rows: [], members: [{ ...zeroed[0], executionDelay: 60 }, ...zeroed.slice(1)] });
      assert.equal(wrongOne.filter((f) => f.key.endsWith(":delay")).length, delayed);
      assert.ok(wrongOne.every((f) => f.severity === "error"));
      assert.ok(wrongOne.every((f) => /MIXED/.test(f.message)));
      assert.equal(wrongOne.filter((f) => f.key.endsWith(":prelock")).length, 0);
      // Half locked: the lock is ONE transaction, so this is not the launch profile either.
      const half = checkManagerWiring({ manager: MANAGER, rows: [], members: [...lanes.slice(0, 2), ...zeroed.slice(2)] });
      assert.equal(half.filter((f) => f.key.endsWith(":delay")).length, delayed - 2);
      assert.ok(half.every((f) => f.severity === "error"));
      // A holder missing its role, or holding one it should not, still pages beside the pre-lock warn.
      const missing = checkManagerWiring({ manager: MANAGER, rows: [], members: [...zeroed, { ...hot, isMember: false }] });
      assert.deepEqual(missing.map((f) => `${f.key.split(":").pop()}/${f.severity}`).sort(), ["missing/error", "prelock/warn"]);
      const extra = checkManagerWiring({ manager: MANAGER, rows: [], members: [...zeroed, { ...hot, wantMember: false }] });
      assert.deepEqual(extra.map((f) => `${f.key.split(":").pop()}/${f.severity}`).sort(), ["extra/error", "prelock/warn"]);
      // And a moved admin or guardian is untouched by the phase.
      const admin = checkManagerWiring({ manager: MANAGER, rows: [row({ chainAdmin: 6 })], members: zeroed });
      assert.ok(admin.some((f) => f.key.endsWith(":1:admin") && f.severity === "error"));
    });

    test("after the lock was seen, the same zeroed table is a P1 per lane: the lock undone", () => {
      const out = checkManagerWiring({ manager: MANAGER, rows: [], members: zeroed, lock: { block: "1234", at: 1_700_000_000 } });
      assert.equal(out.filter((f) => f.key.endsWith(":delay")).length, delayed);
      assert.equal(out.filter((f) => f.key.endsWith(":prelock")).length, 0);
      assert.ok(out.every((f) => f.severity === "error"));
      assert.match(out[0].message, /the lock has been undone/);
      // A locked table with the lock recorded is quiet.
      assert.deepEqual(checkManagerWiring({ manager: MANAGER, rows: [], members: [...lanes, hot], lock: { block: "1234", at: 1_700_000_000 } }), []);
    });
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

  // The contract emits keccak256("<WORD>") (FeeSplitter.sol:29-36), not the word as ASCII: every fixture
  // above packs ASCII, which is why the garbled on-chain reason never showed up in a test.
  test("the reason hashes are derived, not typed: keccak256 of each word, and nothing else", () => {
    const words = ["NO_ROUTE", "NO_SPOT", "BELOW_FLOOR", "DUST", "NO_EXECUTOR", "EMPTY", "SHORT_RESERVE", "HAIRCUT"];
    const derived = Object.fromEntries(words.map((w) => [viem.keccak256(viem.toHex(w)).toLowerCase(), w]));
    assert.deepEqual({ ...SKIP_REASON_HASHES }, derived);
    // positive control on the hash itself: keccak256("") is the well-known empty hash
    assert.equal(viem.keccak256(viem.toHex("")), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  });

  test("a reason as the contract really emits it (a keccak256 hash) reads as its word, in any case", () => {
    for (const w of ["NO_ROUTE", "NO_SPOT", "BELOW_FLOOR", "DUST", "NO_EXECUTOR", "EMPTY", "SHORT_RESERVE", "HAIRCUT"]) {
      const h = viem.keccak256(viem.toHex(w));
      assert.equal(reasonText(h), w);
      assert.equal(reasonText(h.toUpperCase().replace("0X", "0x")), w);
    }
    const fly = flyState();
    applyFlywheelLogs(fly, [{ eventName: "DistributionSkipped", args: { asset: ASSET, reason: viem.keccak256(viem.toHex("BELOW_FLOOR")) }, transactionHash: `0x${"e".repeat(64)}` }], 1000, SPLITTER);
    assert.deepEqual({ ...fly.floorMisses[ASSET.toLowerCase()] }, { reason: "BELOW_FLOOR", count: 1, lastAt: 1000 });
  });

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

  // The scan re-reads its last REORG_OVERLAP blocks every run, so the same logs reach
  // applyFlywheelLogs again: one DistributionSkipped became a streak of three and paged v2_mon_splitter_floor_miss.
  test("A log re-read by the overlap is folded in once; new logs after it still count", () => {
    const at = (log, blockNumber, logIndex) => ({ ...log, blockNumber, logIndex });
    const fly = flyState();
    const one = at(skip("BELOW_FLOOR", 1), 100n, 3);
    applyFlywheelLogs(fly, [one], 1000, SPLITTER);
    applyFlywheelLogs(fly, [one], 2000, SPLITTER);
    applyFlywheelLogs(fly, [one], 3000, SPLITTER);
    assert.deepEqual({ ...fly.floorMisses[ASSET.toLowerCase()] }, { reason: "BELOW_FLOOR", count: 1, lastAt: 1000 }, "one skip, three passes: a count of one");
    assert.deepEqual(checkSplitter({ splitter: SPLITTER, now: 3000, lastDistributedAt: null, pendingSince: null, floorMisses: Object.entries(fly.floorMisses).map(([asset, f]) => ({ asset, ticker: "NVDA", ...f })) }, DEFAULTS), []);
    assert.equal(fly.at, "100:3");
    applyFlywheelLogs(fly, [one, at(skip("BELOW_FLOOR", 2), 100n, 4), at(skip("BELOW_FLOOR", 3), 101n, 0)], 4000, SPLITTER);
    assert.equal(fly.floorMisses[ASSET.toLowerCase()].count, 3, "the re-read one skipped, the two after it counted");
    assert.equal(fly.at, "101:0");
    const distributed = at({ eventName: "Distributed", args: { asset: ASSET, assetIn: 1n, usdgIn: 1n, treasuryOut: 1n, buybackAdded: 0n }, transactionHash: "0xd" }, 102n, 0);
    applyFlywheelLogs(fly, [distributed], 5000, SPLITTER);
    applyFlywheelLogs(fly, [distributed], 6000, SPLITTER);
    assert.equal(fly.lastDistributedAt, 5000, "a re-read Distributed does not move the clock either");
  });

  // The high-water mark also advances WITHIN a block
  // (applyFlywheelLogs: `here[0] === highest[0] && here[1] > highest[1]`). The test above has one log per block, so
  // deleting that clause passed it. Two skips in one transaction, re-read by the REORG_OVERLAP: without the clause
  // fly.at stays "100:3" and the second skip counts twice, the double count once seen.
  test("Two skips in one block, re-read by the overlap, count once each; fly.at is the later logIndex", () => {
    const at = (log, blockNumber, logIndex) => ({ ...log, blockNumber, logIndex });
    const A2 = addr(0xa002);
    const first = at(skip("BELOW_FLOOR", 7), 100n, 3);
    const second = at({ ...skip("BELOW_FLOOR", 7), args: { ...skip("BELOW_FLOOR", 7).args, asset: A2 } }, 100n, 4);
    const fly = flyState();
    applyFlywheelLogs(fly, [first, second], 1000, SPLITTER);
    assert.equal(fly.at, "100:4", "the mark is the later log of the block");
    applyFlywheelLogs(fly, [first, second], 2000, SPLITTER);
    assert.equal(fly.at, "100:4");
    assert.deepEqual({ ...fly.floorMisses[ASSET.toLowerCase()] }, { reason: "BELOW_FLOOR", count: 1, lastAt: 1000 });
    assert.deepEqual({ ...fly.floorMisses[A2.toLowerCase()] }, { reason: "BELOW_FLOOR", count: 1, lastAt: 1000 }, "the second log of the block is not counted again");
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

  // The splitter now names an empty balance EMPTY and a 100 % haircut HAIRCUT
  // instead of DUST. A run of either still pages (the rehearsal's splitter-floor-miss case distributes an empty
  // balance), but the floor-miss text sent the operator to the pool for both.
  test("an EMPTY or HAIRCUT run pages with its own cause, not the thin-pool text; HAIRCUT decodes from the log", () => {
    const page = (reason) =>
      checkSplitter({ splitter: SPLITTER, now: 5, lastDistributedAt: null, pendingSince: null, floorMisses: [{ asset: ASSET, ticker: "NVDA", reason, count: DEFAULTS.splitterFloorMisses, lastAt: 4 }] }, DEFAULTS)[0];
    const thinPool = /the pool is too thin/;
    assert.match(page("BELOW_FLOOR").message, thinPool, "a real floor miss keeps the floor-miss text");
    const empty = page("EMPTY");
    assert.equal(empty.kind, "v2_mon_splitter_floor_miss");
    assert.match(empty.message, /3 consecutive EMPTY skips/);
    assert.match(empty.message, /held none of this asset/);
    assert.doesNotMatch(empty.message, thinPool);
    const haircut = page("HAIRCUT");
    assert.match(haircut.message, /100 % or more/);
    assert.match(haircut.message, /FEE_MANAGER lowering setConversionSlippageBps, or CONFIG_ADMIN re-pointing the route/);
    assert.doesNotMatch(haircut.message, thinPool);
    // end to end from the log as the contract emits it (keccak256("HAIRCUT"), FeeSplitter.sol SKIP_HAIRCUT)
    const fly = flyState();
    const log = (i) => ({ eventName: "DistributionSkipped", args: { asset: ASSET, reason: viem.keccak256(viem.toHex("HAIRCUT")) }, blockNumber: 10n, logIndex: i, transactionHash: `0x${String(i).padStart(64, "d")}` });
    applyFlywheelLogs(fly, [log(0), log(1), log(2)], 1000, SPLITTER);
    assert.deepEqual({ ...fly.floorMisses[ASSET.toLowerCase()] }, { reason: "HAIRCUT", count: 3, lastAt: 1000 });
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
    const stuck = { splitter: SPLITTER, now, balance: 60_000_000n, lastBuybackAt: old, cooldownS: 300, fundedSince: null, unburned: [] };
    assert.equal(checkBuyback(stuck, DEFAULTS).length, 1);
    assert.deepEqual(checkBuyback({ ...stuck, balance: 0n }, DEFAULTS), [], "no balance, nothing to buy with");
    assert.deepEqual(checkBuyback({ ...stuck, balance: null }, DEFAULTS), [], "an unread balance is unknown, not zero and not stuck");
    assert.deepEqual(checkBuyback({ ...stuck, lastBuybackAt: now - 10 }, DEFAULTS), [], "inside the cooldown it is not stuck, it is waiting");
    assert.deepEqual(checkBuyback(stuck, { ...DEFAULTS, buybackStuckS: 0 }), []);
    // and the cooldown is the splitter's own, handed in (x.cooldownS): one second inside it is quiet
    assert.deepEqual(checkBuyback({ ...stuck, lastBuybackAt: now - 300 + 1 }, DEFAULTS), []);
  });

  test("The cooldown is FeeSplitter.buybackCooldown() read live, not the old compiled 300", () => {
    const now = 1_000_000;
    // Funded long ago, last buy 600 s ago: past the old compiled 300, inside a 900 s cooldown the ADMIN has set.
    const x = { splitter: SPLITTER, now, balance: 60_000_000n, lastBuybackAt: now - 600, cooldownS: 900,
      fundedSince: now - DEFAULTS.buybackStuckS - 1, unburned: [] };
    assert.deepEqual(checkBuyback(x, DEFAULTS), [], "inside the live cooldown it is waiting, not stuck");
    const [page] = checkBuyback({ ...x, lastBuybackAt: now - 901 }, DEFAULTS);
    assert.equal(page.kind, "v2_mon_buyback_stuck");
    assert.equal(page.data.cooldownS, 900);
    assert.match(page.message, /15m cooldown long over|15 min(ute)?s? cooldown long over|900/);
    // Unread: no cooldown is assumed (it can page at most one cooldown early), and the message says it was unread.
    const [unread] = checkBuyback({ ...x, cooldownS: null }, DEFAULTS);
    assert.equal(unread.data.cooldownS, null);
    assert.match(unread.message, /cooldown \(unread\) long over/);
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

  // This test held the PoolKey's LP fee tier to MAX_HOOK_FEE_BPS. The contract holds the HOOK's own fee to it
  // (launches(poolId).hookFeeBps, checked in V4BuybackExecutor.buy) and every fee term together to the
  // executor's maxTotalFeeBps, both read through the executor's feeBps(). The LP tier alone is one term of the total.
  const fees = (over = {}) => ({ v3: 1, v4Lp: 0, v4Protocol: 0, hook: 100, creatorTax: 100, total: 201n, ...over });
  test("A hook fee above MAX_HOOK_FEE_BPS, a total above maxTotalFeeBps, or an id that does not match its key each page", () => {
    const at = { poolId: POOL, poolKey: key, recomputedPoolId: POOL, depth: null, maxTotalFeeBps: 400 };
    assert.deepEqual(checkTokenPool({ ...at, fees: fees({ hook: MAX_HOOK_FEE_BPS, total: 400n }) }, DEFAULTS), [], "exactly at both ceilings is allowed");
    const hook = checkTokenPool({ ...at, fees: fees({ hook: MAX_HOOK_FEE_BPS + 1, total: 400n }) }, DEFAULTS);
    assert.deepEqual(kinds(hook), ["v2_mon_token_pool_fee/error"]);
    assert.match(hook[0].key, /:fee$/);
    assert.match(hook[0].message, /hook takes 301 bps .*reverts HookFeeCapExceeded/);
    const total = checkTokenPool({ ...at, fees: fees({ total: 401n }) }, DEFAULTS);
    assert.deepEqual(kinds(total), ["v2_mon_token_pool_fee/error"]);
    assert.match(total[0].key, /:total$/);
    assert.match(total[0].message, /401 bps .*above the executor's maxTotalFeeBps 400: V4BuybackExecutor.buy reverts FeeCapExceeded/);
    // The LP fee tier alone is not a hook fee: a 301 bps tier under the combined cap pages nothing (the old rule paged it).
    assert.deepEqual(checkTokenPool({ ...at, poolKey: { ...key, fee: (MAX_HOOK_FEE_BPS + 1) * 100 }, fees: fees({ v4Lp: 301, total: 400n }) }, DEFAULTS), []);
    // A fee read the executor itself refuses is a refusal of every buy.
    const refused = checkTokenPool({ ...at, fees: null, feesRefusal: "NoSource" }, DEFAULTS);
    assert.match(refused[0].key, /:refused$/);
    assert.match(refused[0].message, /feeBps\(\) reverts NoSource/);
    // v4's dynamic-fee flag in the pinned key: the executor's constructor refuses it.
    assert.match(checkTokenPool({ ...at, poolKey: { ...key, fee: 0x800000 } }, DEFAULTS)[0].key, /:dynamic$/);
    const wrongId = checkTokenPool({ poolId: POOL, poolKey: key, recomputedPoolId: `0x${"8".repeat(64)}`, depth: null }, DEFAULTS);
    assert.match(wrongId[0].message, /the only pin there is/);
  });

  // The launch pool is HOOKED by design (ops/markets/tier1.json shared.token.poolKey.hooks is non-zero, and
  // the executor's MAX_HOOK_FEE_BPS ceiling exists for it). v9 forks paged v2_mon_token_pool_fee on every pass.
  test("A hooked pinned pool pages nothing; the executor trading any other key pages", () => {
    const hookedKey = { ...key, fee: 0, tickSpacing: 200, hooks: addr(0xe5e7) };
    const executor = addr(0xe7ae);
    const base = { poolId: POOL, poolKey: hookedKey, recomputedPoolId: POOL, executor, depth: null };
    assert.deepEqual(checkTokenPool({ ...base, liveKey: null }, DEFAULTS), [], "the pinned key's hook is not a finding");
    assert.deepEqual(checkTokenPool({ ...base, liveKey: { ...hookedKey, fee: 0n, tickSpacing: 200n } }, DEFAULTS), [], "the executor trades the pinned key (viem returns numbers or bigints)");
    const otherHook = checkTokenPool({ ...base, liveKey: { ...hookedKey, hooks: addr(0xbad) } }, DEFAULTS);
    assert.deepEqual(kinds(otherHook), ["v2_mon_token_pool_fee/error"]);
    assert.equal(otherHook[0].key, `${POOL}:live`);
    assert.match(otherHook[0].message, /buyback executor .* trades a v4 pool other than the pinned STONKHOUSE pool .*hooks 0x0000000000000000000000000000000000000bad instead of 0x000000000000000000000000000000000000e5e7/);
    for (const [f, v] of [["currency0", addr(0x9)], ["currency1", addr(0x9)], ["fee", 3000], ["tickSpacing", 60]]) {
      assert.deepEqual(kinds(checkTokenPool({ ...base, liveKey: { ...hookedKey, [f]: v } }, DEFAULTS)), ["v2_mon_token_pool_fee/error"], `a different ${f}`);
    }
    // The shipped registry's pinned key is hooked, and pages nothing on its own.
    const shipped = JSON.parse(readFileSync(DEFAULT_REGISTRY, "utf8")).shared.token.poolKey;
    assert.ok(!sameAddress(shipped.hooks, ZERO), "tier1.json's STONKHOUSE pool is hooked");
    assert.deepEqual(checkTokenPool({ ...base, poolKey: shipped, liveKey: shipped }, DEFAULTS), []);
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
    // A later change CHANGED THIS LINE, and it used to assert the opposite:
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

describe("v8: every way the audit notice can go quiet", () => {
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
    // quiet; off with collateral in the contracts is the failure this check exists to prevent.
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

  test("the fault names the next action and warns against reading silence as safety", () => {
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
  // HOOKED, like the launch pool (tier1.json shared.token.poolKey), and the executor's key() answers it.
  const TOKEN_KEY8 = { currency0: addr(0x11), currency1: addr(0x12), fee: 3000, tickSpacing: 60, hooks: addr(0x14) };
  const SAFE_ADMIN = addr(0x5a1);
  const SAFE_TREASURY = addr(0x5a2);
  const ROLES = JSON.parse(readFileSync(path.join(ABIS, "roles.json"), "utf8"));
  const reverts = () => {
    const e = new Error("execution reverted");
    e.name = "ContractFunctionRevertedError";
    throw e;
  };

  /** A v8 registry: the v8 blocks the monitor reads, with everything the deploy write-back fills in. */
  function writeV8Registry(dir, { payoutRoute = { venue: "v4", fee: 3000, tickSpacing: 60, poolId: null }, mintFeePpm = 0, house = undefined } = {}) {
    const viem = loadViem();
    const key = { ...routeCurrencies(ASSET8, USDG), fee: 3000, tickSpacing: 60, hooks: ZERO };
    const route = payoutRoute === null ? null : { ...payoutRoute, poolId: payoutRoute.poolId ?? v4PoolId(viem, key) };
    const tokenKey = TOKEN_KEY8;
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
        markets: [{ ticker: "NVDA", asset: ASSET8, feed: addr(0xb001), feedAggregator: null, v2: { status: "live", univ3Pool: null, univ3MinLiquidity: null, mintFeePpm, payoutRoute: route, ...(house === undefined ? {} : { house }) } }],
      }),
    );
    return file;
  }

  /**
   * The manifest's role for a selector on a target of writeV8Registry's deployment, by the address the registry
   * publishes. Written out here rather than built with managerTargets, so a wrong mapping in the monitor cannot agree
   * with itself. A selector the target's manifest entry does not list reads ADMIN (0), the manager's default.
   */
  const TARGET8 = {
    [C.clearinghouse]: "Clearinghouse",
    [C.orderBook]: "OrderBook",
    [C.settlementOracle]: "SettlementOracle",
    [C.expiryCalendar]: "ExpiryCalendar",
    [C.keeperRewards]: "KeeperRewards",
    [C.autoRoller]: "AutoRoller",
    [C.payoutAdapter]: "PayoutRouter",
    [C.makerVault]: "MakerVault",
    [C.makerRegistry]: "MakerRegistry",
    [C.rewardsDistributor]: "RewardsDistributor",
    [SRC.chainlink]: "ChainlinkFeedSource",
    [SRC.univ3]: "UniV3TwapSource",
    [SPLITTER8]: "FeeSplitter",
    [EXEC8]: "V4BuybackExecutor",
  };
  const fnRole8 = (target, selector) => {
    const contract = Object.entries(TARGET8).find(([a]) => a.toLowerCase() === target.toLowerCase())?.[1];
    const fns = ROLES.targets[contract] ?? {};
    const sig = Object.keys(fns).find((s) => loadViem().toFunctionSelector(`function ${s}`) === selector.toLowerCase());
    return sig === undefined ? 0n : BigInt(ROLES.roles[fns[sig]]);
  };
  // The lock revokes roles.json `launchOnly` pairs (guardianKey's GUARDIAN once the file is regenerated),
  // so the healthy, locked chain does not hold them. Empty while the exported manifest predates launchOnly.
  const HOLDER8 = { adminSafe: SAFE_ADMIN, crankerKey: addr(0xb01), pricerKey: addr(0xb02), quoterKey: addr(0xb03), guardianKey: addr(0xb04) };
  const REVOKED8 = new Set(Object.entries(ROLES.launchOnly ?? {}).flatMap(([holder, names]) => names.map((n) => `${ROLES.roles[n]}:${HOLDER8[holder].toLowerCase()}`)));

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
          return REVOKED8.has(`${Number(args[0])}:${String(args[1]).toLowerCase()}`) ? [false, 0] : [true, ROLES.delaysS[roleName]];
        case "getTargetFunctionRole":
          return fnRole8(args[0], args[1]);
        default:
          break;
      }
    }
    if (a === SPLITTER8.toLowerCase()) {
      if (fn === "buybackBalance") return 0n;
      if (fn === "lastBuybackAt") return 0n;
      // The launch value, V2Constants.BUYBACK_COOLDOWN (5 min). A uint40, so viem decodes it as a number.
      if (fn === "buybackCooldown") return 300;
    }
    if (a === EXEC8.toLowerCase() && fn === "key") return { ...TOKEN_KEY8 };
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
    const r = await runOnce(options(dir, writeV8Registry(dir)), onChain(chain));
    // The wiring, not the pure functions: a check that is never called is indistinguishable from one
    // that found nothing, and the unit tests above cannot tell the difference.
    for (const name of ["manager", "safes", "flywheel", "routes", "tokenpool"]) {
      assert.equal(r.checks[name]?.status, "ok", `${name}: ${JSON.stringify(r.checks[name])}`);
    }
    // The monitor deliberately stopped this check reporting `skipped`: record() files a
    // skipped check as completed and reconcile() then DELETES the conditions it remembers, so a
    // mis-registered `shared.usdg` used to CLEAR a live audit-trigger alert instead of raising one.
    // The check now always has an opinion. Here the registry names holders that hold nothing, so the
    // opinion is a clean "ok" with no finding -- which the v8kinds assertion below still proves.
    assert.equal(r.checks.tvl.status, "ok", "the check completes with an opinion even while the trigger is off");
    // Why: this fixture holds 2,000,000 USDG with `auditTriggerUsdg` 0, and a funded
    // protocol whose audit notice is dark is a fault by design -- "off with collateral in the
    // contracts is the notice being dark exactly when it matters". So the healthy-deployment claim is
    // that it pages this ONE notice and nothing else; any other v8 kind appearing here is a regression.
    const v8kinds = kindsOf(r).filter((k) => /manager|safe_threshold|splitter|buyback|route_|mint_fee|token_pool|tvl/.test(k));
    assert.deepEqual(v8kinds, [TVL_DARK], `a healthy v8 deployment pages only the dark audit trigger: ${JSON.stringify(kindsOf(r))}`);
    // Derived from the manifest the check reads (a literal "11" went stale when NEW_LISTING was added).
    assert.match(r.checks.manager.detail, new RegExp(`^${Object.keys(ROLE_MANIFEST.manifest.ids).length} roles `));
    assert.match(r.checks.routes.detail, /NVDA v4/);
    // A healthy splitter answers every read the flywheel check makes, so none of them is noted as unread.
    assert.deepEqual(r.notes.filter((n) => n.startsWith("flywheel:")), [], `notes: ${JSON.stringify(r.notes)}`);
  });

  test("The buyback stuck check uses the cooldown FeeSplitter.buybackCooldown() answers on this pass", async () => {
    const at = new FakeChain({ head: 20_000n }).head.timestamp;
    // Funded and idle for 7 h: past the 6 h stuck window, so only the cooldown decides whether this pages.
    const idle = DEFAULTS.buybackStuckS + 3_600;
    assert.ok(idle > DEFAULTS.buybackStuckS);
    const onSplitter = (value) => (address) => (address.toLowerCase() === SPLITTER8.toLowerCase() ? value() : undefined);
    const pass = async (tag, cooldown) => {
      const dir = scratch(`monitor-v8-cooldown-${tag}-`);
      const chain = new FakeChain({ head: 20_000n });
      chain.read = v8Read(chain, {
        buybackBalance: onSplitter(() => 60_000_000n),
        lastBuybackAt: onSplitter(() => BigInt(at - idle)),
        buybackCooldown: onSplitter(cooldown),
      });
      const r = await runOnce(options(dir, writeV8Registry(dir)), onChain(chain));
      return { r, buyback: r.findings.filter((f) => f.kind.startsWith("v2_mon_buyback")) };
    };

    // 15 minutes read live: long over, so the idle balance pages, and the page carries the value that was read.
    const short = await pass("short", () => 900);
    assert.deepEqual(short.buyback.map((f) => f.kind), ["v2_mon_buyback_stuck"], JSON.stringify(short.r.findings));
    // The report keeps kind and message, not data: the value read shows as its duration in the page.
    assert.match(short.buyback[0].message, /with the 15 min cooldown long over/, "the cooldown in the page is the one FeeSplitter answered");
    assert.equal(short.r.checks.flywheel.status, "ok", JSON.stringify(short.r.checks.flywheel));

    // 8 h read live: the same 7 h idle balance is inside the cooldown, so the splitter is waiting, not stuck.
    const long = await pass("long", () => idle + 3_600);
    assert.deepEqual(long.buyback, [], `inside the live cooldown nothing pages: ${JSON.stringify(long.buyback)}`);

    // Unread: the check counts no cooldown, says so in the page, and notes why.
    const unread = await pass("unread", reverts);
    assert.deepEqual(unread.buyback.map((f) => f.kind), ["v2_mon_buyback_stuck"], JSON.stringify(unread.r.findings));
    assert.match(unread.buyback[0].message, /with the cooldown \(unread\) long over/);
    assert.ok(unread.r.notes.some((n) => n.startsWith("flywheel: FeeSplitter.buybackCooldown() could not be read")), `notes: ${JSON.stringify(unread.r.notes)}`);
  });

  // The new reads WIRED through runOnce. Each fails when runOnce stops reading the value
  // or stops handing it to the pure check (the pure checks have their own tests above).
  const onExec = (value) => (address) => (address.toLowerCase() === EXEC8.toLowerCase() ? value() : undefined);
  const v8Pass = async (over) => {
    const chain = new FakeChain({ head: 20_000n });
    chain.read = v8Read(chain, over);
    const dir = scratch("monitor-v8-796-");
    return runOnce(options(dir, writeV8Registry(dir)), onChain(chain));
  };
  const revertWith = (data) => {
    const e = new Error("execution reverted");
    e.name = "ContractFunctionRevertedError";
    e.data = data;
    throw e;
  };

  test("KeeperRewards.maxBounty() is read and passed: 0 pages rewards_cap, a KeeperRewards without it clamps nothing", async () => {
    const zero = await v8Pass({ maxBounty: () => 0n });
    const f = zero.findings.find((x) => x.kind === "v2_mon_rewards_cap");
    assert.ok(f, `kinds: ${JSON.stringify(kindsOf(zero))}`);
    assert.equal(f.id, `v2_mon_rewards_cap:${C.keeperRewards.toLowerCase()}:max-bounty-zero`);
    // An older KeeperRewards has no maxBounty() (a revert): no clamp, no page, no note.
    const old = await v8Pass({ maxBounty: () => reverts() });
    assert.ok(!old.findings.some((x) => x.kind === "v2_mon_rewards_cap"), JSON.stringify(kindsOf(old)));
    assert.ok(!old.notes.some((n) => /maxBounty/.test(n)));
  });

  test("The executor's feeBps() and maxTotalFeeBps() are read and judged; a refused feeBps() pages, an unread one is a note", async () => {
    const pool = (r) => r.findings.filter((x) => x.kind === "v2_mon_token_pool_fee").map((x) => x.id.split(":").pop()).sort();
    const hot = await v8Pass({ feeBps: onExec(() => [1, 0, 0, 301, 100, 402n]), maxTotalFeeBps: onExec(() => 400) });
    assert.deepEqual(pool(hot), ["fee", "total"], JSON.stringify(kindsOf(hot)));
    const fine = await v8Pass({ feeBps: onExec(() => [1, 0, 0, 100, 100, 201n]), maxTotalFeeBps: onExec(() => 400) });
    assert.deepEqual(pool(fine), []);
    // feeBps() reverting NoSource is the executor refusing every buy (V4BuybackExecutor._feeBps).
    const refused = await v8Pass({ feeBps: onExec(() => revertWith("0x7d19c0ff")), maxTotalFeeBps: onExec(() => 400) });
    assert.deepEqual(pool(refused), ["refused"]);
    assert.match(refused.findings.find((x) => x.id.endsWith(":refused")).message, /feeBps\(\) reverts NoSource/);
    const capped = await v8Pass({ feeBps: onExec(() => revertWith("0x20caa94a")), maxTotalFeeBps: onExec(() => 400) });
    assert.match(capped.findings.find((x) => x.id.endsWith(":refused")).message, /feeBps\(\) reverts CeilingExceeded/);
    // Anything else (an older executor with no such view, the RPC): unknown and noted, never read as fees of 0.
    const unread = await v8Pass({ feeBps: onExec(() => { throw transportError(); }) });
    assert.deepEqual(pool(unread), []);
    assert.ok(unread.notes.some((n) => /BuybackExecutor\.feeBps\(\) could not be read/.test(n)), JSON.stringify(unread.notes));
  });

  test("With no --house the house check watches the vaults the registry records", async () => {
    const dir = scratch("monitor-v8-house-");
    const HV = addr(0x4a11);
    const chain = new FakeChain({ head: 20_000n });
    chain.read = v8Read(chain);
    const r = await runOnce(options(dir, writeV8Registry(dir, { house: { weekly: null, daily: HV } })), onChain(chain));
    assert.notEqual(r.checks.house.status, "skipped", JSON.stringify(r.checks.house));
    assert.match(r.checks.house.detail, /^from the registry's markets\[\]\.v2\.house: /);
    const none = await runOnce(options(scratch("monitor-v8-house2-"), writeV8Registry(dir)), onChain(chain));
    assert.equal(none.checks.house.status, "skipped", "no --house and nothing in the registry");
    assert.match(none.checks.house.detail, /the registry records no House vault/);
  });

  test("A whole pass re-reads every manifest selector's role on its registry target and pages one the chain disagrees with", async () => {
    const dir = scratch("monitor-v8-fnrole-");
    const pause = loadViem().toFunctionSelector("function setTradingPaused(bool)");
    const chain = new FakeChain({ head: 20_000n });
    chain.read = v8Read(chain, {
      getTargetFunctionRole: (address, args) => (address.toLowerCase() === MANAGER8.toLowerCase() && args[0].toLowerCase() === C.orderBook.toLowerCase() && args[1] === pause ? MANAGER_PUBLIC_ROLE : undefined),
    });
    const r = await runOnce(options(dir, writeV8Registry(dir)), onChain(chain));
    assert.equal(r.checks.manager.status, "ok", JSON.stringify(r.checks.manager));
    const expected = Object.values(TARGET8).reduce((n, contract) => n + Object.keys(ROLES.targets[contract] ?? {}).length, 0);
    assert.match(r.checks.manager.detail, new RegExp(`; ${expected} selector roles on ${Object.keys(TARGET8).length} targets`));
    const fnPages = r.findings.filter((x) => x.kind === "v2_mon_manager_wiring" && x.id.includes(":fn:"));
    assert.deepEqual(fnPages.map((x) => x.id.split(":").slice(-3).join(":")), [`${C.orderBook.toLowerCase()}:fn:${pause}`]);
    assert.match(fnPages[0].message, /OrderBook\.setTradingPaused\(bool\) on .* needs PUBLIC_ROLE \(anyone\) on chain/);
  });

  test("A House vault's LimitsSet pages through the whole pass: error when a limit went up, warn when stricter", async () => {
    const dir = scratch("monitor-v8-house-limits-");
    const HV = addr(0x4a11);
    const SIG = HOUSE_VAULT_SCAN_SIGNATURES.find((x) => x.startsWith("event LimitsSet"));
    const L = { maxSeriesUnits: 10_000n, maxTotalNotional: 10n ** 12n, askToleranceBps: 100, maxBidBpsOfSpot: 500, maxOrderLifetime: 86_400, maxDailyOutflow: 10n ** 11n };
    const chain = new FakeChain({ head: 20_000n });
    chain.read = v8Read(chain, { limits: (address) => (address.toLowerCase() === HV.toLowerCase() ? L : undefined) });
    const opts = options(dir, writeV8Registry(dir, { house: { weekly: null, daily: HV } }));
    const limitPages = (report) => report.findings.filter((x) => x.kind === "v2_mon_config_changed" && x.message.includes(".HouseLimitsSet("));
    const first = await runOnce(opts, onChain(chain));
    assert.deepEqual(limitPages(first), [], "the first pass adopts history and reads the baseline");
    // A raise of maxDailyOutflow: only setLimits (TREASURY_ADMIN) can do that.
    chain.logs.push(rawLog(SIG, { limits: { ...L, maxDailyOutflow: L.maxDailyOutflow * 2n } }, { address: HV, blockNumber: 20_050 }));
    chain.setHead(20_100n, chain.head.timestamp + 120);
    const up = limitPages(await runOnce(opts, onChain(chain)));
    assert.deepEqual(up.map((x) => x.severity), ["error"], JSON.stringify(up.map((x) => x.message)));
    assert.match(up[0].message, /^NVDA HouseVault\.HouseLimitsSet\(.*a House vault limit went UP \(maxDailyOutflow 100000000000 -> 200000000000\)/);
    // The GUARDIAN brake: every field equal or stricter.
    chain.logs.push(rawLog(SIG, { limits: { ...L, maxSeriesUnits: 5_000n } }, { address: HV, blockNumber: 20_150 }));
    chain.setHead(20_200n, chain.head.timestamp + 120);
    const down = limitPages(await runOnce(opts, onChain(chain)));
    assert.deepEqual(down.map((x) => x.severity), ["warn"], JSON.stringify(down.map((x) => x.message)));
    assert.match(down[0].message, /maxSeriesUnits 10000 -> 5000, maxDailyOutflow 200000000000 -> 100000000000\): a change HouseVault\.tightenLimits \(GUARDIAN/);
  });

  // A House read the node makes stop short (it refuses a wide getLogs, the chunk halves,
  // and maxRangesPerRun runs out) while the protocol scan caught up: the cursor follows the protocol scan, so the blocks
  // past the House read's reach are never read. It takes no limits() baseline at the head (houseRead = hr.caughtUp),
  // and the pass names the blocks it did not read. The control is the same pass with the node answering every range.
  test("A House read that stops short takes no limits() baseline at the head and names the blocks it did not read", async () => {
    const HV = addr(0x4a11);
    const L = { maxSeriesUnits: 10_000n, maxTotalNotional: 10n ** 12n, askToleranceBps: 100, maxBidBpsOfSpot: 500, maxOrderLifetime: 86_400, maxDailyOutflow: 10n ** 11n };
    const pass = async (narrowNode) => {
      const dir = scratch("monitor-997-house-short-");
      const chain = new FakeChain({ head: 20_000n });
      let limitsReads = 0;
      chain.read = v8Read(chain, {
        limits: (address) => {
          if (address.toLowerCase() !== HV.toLowerCase()) return undefined;
          limitsReads += 1;
          return L;
        },
      });
      if (narrowNode) {
        // Only the House read passes `events`; the node refuses it more than 100 blocks at a time.
        const plain = chain.client.bind(chain);
        chain.client = () => {
          const c = plain();
          return {
            ...c,
            getLogs: async (req) => {
              if (req.events !== undefined && req.toBlock - req.fromBlock + 1n > 100n) throw new Error("query returned more than 10000 results");
              return c.getLogs(req);
            },
          };
        };
      }
      const opts = options(dir, writeV8Registry(dir, { house: { weekly: null, daily: HV } }), ["--threshold", "maxRangesPerRun=5"]);
      const report = await runOnce(opts, onChain(chain));
      return { report, limitsReads, short: report.notes.filter((n) => /House vault roll, deposit and LimitsSet logs were read to block/.test(n)) };
    };
    const whole = await pass(false);
    assert.equal(whole.report.checks.scan.status, "ok", JSON.stringify(whole.report.checks.scan));
    assert.equal(whole.limitsReads, 1, "control: a House read that reaches the head takes the vault's limits() as its baseline");
    assert.deepEqual(whole.short, []);
    const short = await pass(true);
    assert.equal(short.report.checks.scan.status, "ok", "the protocol scan itself caught up");
    assert.equal(short.limitsReads, 0, "a House read short of the head takes no baseline: blocks it did not read may hold a change");
    // The House logs keep their own cursor now, so the blocks past the read's reach go to the next run (the
    // House-cursor tests below read them there) instead of "not read again", and the House check is incomplete meanwhile.
    assert.deepEqual(short.short, [
      "scan: House vault roll, deposit and LimitsSet logs were read to block 1499 of 20000 (raise --threshold maxRangesPerRun); blocks 1500-20000 are left to the next run, and until then a boundary pin there is vouched from pinnedBoundary() only and a limit change there has not paged",
    ]);
    assert.equal(short.report.checks.house.status, "incomplete", JSON.stringify(short.report.checks.house));
    assert.match(short.report.checks.house.detail, /House vault logs in blocks 1500-20000 not read yet/);
    assert.doesNotMatch(whole.report.checks.house.detail, /House vault logs/, "control: logs read to the head leave nothing unread");
  });

  // ---------------------------------------------------------------------------------------------
  // The House vault logs (roll, deposit, LimitsSet) keep their OWN cursor,
  // state.scan.houseCursor, which moves only over the ranges the House read returned. On the shared cursor a House read
  // that failed or stopped short lost its blocks for good, so a LimitsSet there never paged. Only the House read passes
  // `events` to getLogs (the protocol scan and the manager walk pass neither, the token scans pass `event`), so failing
  // exactly those calls fails that read and nothing else.
  describe("House vault logs a failed read skipped are read on a later pass", () => {
    const HV = addr(0x4a11);
    const SIG = HOUSE_VAULT_SCAN_SIGNATURES.find((x) => x.startsWith("event LimitsSet"));
    const L = { maxSeriesUnits: 10_000n, maxTotalNotional: 10n ** 12n, askToleranceBps: 100, maxBidBpsOfSpot: 500, maxOrderLifetime: 86_400, maxDailyOutflow: 10n ** 11n };
    const limitPages = (report) => report.findings.filter((x) => x.kind === "v2_mon_config_changed" && x.message.includes(".HouseLimitsSet("));
    /**
     * A v8 chain whose House vault HV answers limits() with L. `failHouse` set makes every House getLogs throw (a 429, so
     * even the smallest chunk fails) and records the range; `houseFrom` is the first block of each pass's first House read.
     */
    function houseChain() {
      const chain = new FakeChain({ head: 20_000n });
      // HV answers every view the House check reads, with its epoch a week out, so the check is ok on a pass that reads
      // the House logs to the head and only unread logs make it incomplete.
      const hv = (value) => (address) => (address.toLowerCase() === HV.toLowerCase() ? value : undefined);
      const epochEnd = chain.head.timestamp + 7 * 86_400;
      chain.read = v8Read(chain, {
        limits: hv(L),
        epochEnd: hv(epochEnd),
        epochId: hv(1n),
        underlying: hv(ASSET8),
        oracle: hv(C.settlementOracle),
        pendingDepositUsdg: hv(0n),
        pendingDepositStock: hv(0n),
        weekly: hv(false),
        performanceFeeOwed: hv(0n),
      });
      const io = { failHouse: false, failed: [], houseFrom: [] };
      const plain = chain.client.bind(chain);
      chain.client = () => {
        const c = plain();
        let first = true;
        return {
          ...c,
          getLogs: async (req) => {
            if (req.events === undefined) return c.getLogs(req);
            if (first) io.houseFrom.push(req.fromBlock);
            first = false;
            if (io.failHouse) {
              io.failed.push(`${req.fromBlock}-${req.toBlock}`);
              throw new Error("HTTP request failed. Status: 429");
            }
            return c.getLogs(req);
          },
        };
      };
      return { chain, io };
    }
    const raise = (chain, blockNumber) => chain.logs.push(rawLog(SIG, { limits: { ...L, maxDailyOutflow: L.maxDailyOutflow * 2n } }, { address: HV, blockNumber }));
    const next = (chain, head) => chain.setHead(head, chain.head.timestamp + 120);

    test("a LimitsSet in blocks whose House read failed pages on the next pass that reads them", async () => {
      // Three passes: a quiet one (adopts history, reads the baseline), one over a raise of maxDailyOutflow at 20,050,
      // and one more. `failHouse` fails the House read of the second pass only.
      const sequence = async (failHouse) => {
        const dir = scratch("monitor-1038-failed-");
        const { chain, io } = houseChain();
        const opts = options(dir, writeV8Registry(dir, { house: { weekly: null, daily: HV } }));
        const first = await runOnce(opts, onChain(chain));
        raise(chain, 20_050);
        next(chain, 20_100n);
        io.failHouse = failHouse;
        const second = await runOnce(opts, onChain(chain));
        io.failHouse = false;
        next(chain, 20_200n);
        const third = await runOnce(opts, onChain(chain));
        return { first, second, third, io };
      };
      const control = await sequence(false);
      assert.deepEqual(limitPages(control.first), [], "the first pass adopts history and reads the baseline");
      assert.deepEqual(limitPages(control.second).map((x) => x.severity), ["error"], "control: the pass that reads the raise pages it");
      assert.deepEqual(limitPages(control.third), [], "control: and pages it once");
      assert.equal(control.second.checks.house.status, "ok", JSON.stringify(control.second.checks.house));

      const lost = await sequence(true);
      // Isolated: the House read is the only read that failed, and the protocol scan read the same blocks.
      assert.ok(lost.io.failed.length > 0, "the second pass's House read failed");
      assert.ok(lost.io.failed.every((range) => BigInt(range.split("-")[1]) <= 20_100n), `only the second pass's House read failed: ${lost.io.failed.join(", ")}`);
      assert.equal(lost.second.checks.scan.status, "ok", "the protocol scan read its blocks");
      assert.deepEqual(limitPages(lost.second), [], "the failed read saw nothing");
      // The raise pages on the next pass, which reads from the House cursor (20,000, less the reorg overlap), not from
      // the shared one (20,100). On the shared cursor it never paged.
      assert.deepEqual(limitPages(lost.third).map((x) => x.severity), ["error"], "the raise pages on the pass that reads it");
      assert.match(limitPages(lost.third)[0].message, /a House vault limit went UP \(maxDailyOutflow 100000000000 -> 200000000000\)/);
      assert.deepEqual(lost.io.houseFrom, [1000n, 19_996n, 19_996n]);
      // Meanwhile the House check is incomplete, and it is the only check the failed read changed.
      assert.deepEqual(
        Object.entries(lost.second.checks).filter(([name, c]) => c.status !== control.second.checks[name]?.status).map(([name, c]) => `${name}:${c.status}`),
        ["house:incomplete"],
      );
      assert.equal(lost.second.checks.house.status, "incomplete");
      assert.match(lost.second.checks.house.detail, /House vault logs in blocks 20001-20100 not read yet/);
      assert.ok(
        lost.second.notes.includes("scan: House vault roll, deposit and LimitsSet logs could not be read (eth_getLogs 19996-20095 failed even at 100 blocks: HTTP request failed. Status: 429); blocks 20001-20100 are left to the next run, and until then a boundary pin there is vouched from pinnedBoundary() only and a limit change there has not paged"),
        JSON.stringify(lost.second.notes.filter((n) => /House/.test(n))),
      );
      assert.doesNotMatch(lost.third.checks.house.detail, /House vault logs/, "read to the head again");
    });

    test("a House read that stops short goes on from where it stopped, and takes the baseline once it reaches the head", async () => {
      const dir = scratch("monitor-1038-short-");
      const { chain, io } = houseChain();
      let limitsReads = 0;
      const read = chain.read;
      chain.read = (address, fn, args) => {
        if (fn === "limits" && address.toLowerCase() === HV.toLowerCase()) limitsReads += 1;
        return read(address, fn, args);
      };
      // The node refuses a House getLogs wider than 100 blocks on the first pass only (a narrow node).
      let narrow = true;
      const wide = chain.client;
      chain.client = () => {
        const c = wide();
        return {
          ...c,
          getLogs: async (req) => {
            if (narrow && req.events !== undefined && req.toBlock - req.fromBlock + 1n > 100n) throw new Error("query returned more than 10000 results");
            return c.getLogs(req);
          },
        };
      };
      const opts = options(dir, writeV8Registry(dir, { house: { weekly: null, daily: HV } }), ["--threshold", "maxRangesPerRun=5"]);
      const short = await runOnce(opts, onChain(chain));
      assert.equal(short.checks.scan.status, "ok");
      assert.equal(limitsReads, 0, "no baseline short of the head");
      assert.match(short.checks.house.detail, /House vault logs in blocks 1500-20000 not read yet/);
      narrow = false;
      const rest = await runOnce(opts, onChain(chain));
      assert.equal(io.houseFrom[1], 1495n, "the next pass starts where the short read stopped (1499), less the reorg overlap");
      assert.equal(limitsReads, 1, "the pass that reaches the head takes the baseline");
      assert.doesNotMatch(rest.checks.house.detail, /House vault logs/);
    });

    test("a state file from before the House cursor loads, and its House read starts at the shared cursor", async () => {
      const dir = scratch("monitor-1038-old-state-");
      const { chain, io } = houseChain();
      const opts = options(dir, writeV8Registry(dir, { house: { weekly: null, daily: HV } }));
      await runOnce(opts, onChain(chain));
      const file = path.join(dir, "state.json");
      const saved = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(saved.scan.cursor, "20000");
      assert.equal(saved.scan.houseCursor, "20000", "a pass that reads the House logs to the head saves their cursor there");
      // What an older monitor wrote: the same state with no houseCursor.
      delete saved.scan.houseCursor;
      writeFileSync(file, JSON.stringify(saved));
      raise(chain, 20_050);
      next(chain, 20_100n);
      const r = await runOnce(opts, onChain(chain));
      assert.deepEqual(r.notes.filter((n) => n.startsWith("state:")), [], "the file loads as it is, nothing started over");
      assert.equal(io.houseFrom[1], 19_996n, "the House read starts at the shared cursor (20,000), less the reorg overlap: where it read before");
      assert.deepEqual(limitPages(r).map((x) => x.severity), ["error"]);
      assert.equal(JSON.parse(readFileSync(file, "utf8")).scan.houseCursor, "20100");
    });

    test("a House read that fails on a fresh state starts at the deploy block again", async () => {
      const dir = scratch("monitor-1038-fresh-");
      const { chain, io } = houseChain();
      const opts = options(dir, writeV8Registry(dir, { house: { weekly: null, daily: HV } }));
      io.failHouse = true;
      const first = await runOnce(opts, onChain(chain));
      assert.match(first.checks.house.detail, /House vault logs in blocks 1000-20000 not read yet/);
      assert.equal(JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")).scan.houseCursor, "999", "nothing read: the block before the deploy block");
      io.failHouse = false;
      next(chain, 20_100n);
      const second = await runOnce(opts, onChain(chain));
      assert.deepEqual(io.houseFrom, [1000n, 1000n], "from the deploy block, not from where the protocol scan got to (20,000)");
      assert.doesNotMatch(second.checks.house.detail, /House vault logs/);
    });

    test("with no House vault the House cursor follows the shared one, so a vault added later starts there", async () => {
      const dir = scratch("monitor-1038-none-");
      const { chain, io } = houseChain();
      await runOnce(options(dir, writeV8Registry(dir)), onChain(chain));
      next(chain, 20_100n);
      await runOnce(options(dir, writeV8Registry(dir)), onChain(chain));
      const saved = JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")).scan;
      assert.deepEqual([saved.cursor, saved.houseCursor], ["20100", "20100"]);
      assert.deepEqual(io.houseFrom, [], "no vault, no House read");
      next(chain, 20_200n);
      await runOnce(options(dir, writeV8Registry(dir, { house: { weekly: null, daily: HV } })), onChain(chain));
      assert.deepEqual(io.houseFrom, [20_096n], "the first House read starts at the shared cursor (20,100), less the reorg overlap");
    });

    test("with no v2 contracts there is no log scan, and the House check is not held incomplete for logs it has none to read", async () => {
      const dir = scratch("monitor-1038-predeploy-");
      const { chain, io } = houseChain();
      const file = writeV8Registry(dir);
      const raw = JSON.parse(readFileSync(file, "utf8"));
      raw.v2.contracts.clearinghouse = null;
      writeFileSync(file, JSON.stringify(raw));
      const r = await runOnce(options(dir, file, ["--house", `NVDA=${HV}`]), onChain(chain));
      assert.equal(r.checks.scan.status, "skipped", JSON.stringify(r.checks.scan));
      assert.notEqual(r.checks.house.status, "skipped", JSON.stringify(r.checks.house));
      assert.deepEqual(io.houseFrom, []);
      assert.doesNotMatch(r.checks.house.detail, /House vault logs/);
    });
  });

  test("The executor trading a pool other than the pinned hooked one pages through the whole pass", async () => {
    const dir = scratch("monitor-v8-pool-");
    const chain = new FakeChain({ head: 20_000n });
    chain.read = v8Read(chain, { key: (address) => (address.toLowerCase() === EXEC8.toLowerCase() ? { ...TOKEN_KEY8, hooks: addr(0xbad) } : undefined) });
    const r = await runOnce(options(dir, writeV8Registry(dir)), onChain(chain));
    assert.equal(r.checks.tokenpool.status, "ok");
    assert.deepEqual(kindsOf(r).filter((k) => /token_pool/.test(k)), ["v2_mon_token_pool_fee"]);
    const unread = new FakeChain({ head: 20_000n });
    unread.read = v8Read(unread, { key: (address) => (address.toLowerCase() === EXEC8.toLowerCase() ? reverts() : undefined) });
    const r2 = await runOnce(options(scratch("monitor-v8-pool2-"), writeV8Registry(dir)), onChain(unread));
    assert.equal(r2.checks.tokenpool.status, "incomplete", "an unread key() is not a matching one");
    assert.deepEqual(kindsOf(r2).filter((k) => /token_pool/.test(k)), []);
  });

  // ---------------------------------------------------------------------------------------------
  // The manager's own RoleGranted / RoleRevoked log, walked from the deploy block. The healthy pass
  // above has no manager log at all, so its `members` check is incomplete (no ADMIN grant seen) and judges nothing;
  // these give the walk a log and check what it pages.
  // ---------------------------------------------------------------------------------------------
  const GRANTED = MANAGER_MEMBER_EVENTS[0];
  const REVOKED = MANAGER_MEMBER_EVENTS[1];
  const grant = (roleId, account, blockNumber, logIndex = 0) => rawLog(GRANTED, { roleId: BigInt(roleId), account, delay: 0, since: 0, newMember: true }, { address: MANAGER8, blockNumber, logIndex });
  const revoke = (roleId, account, blockNumber, logIndex = 0) => rawLog(REVOKED, { roleId: BigInt(roleId), account }, { address: MANAGER8, blockNumber, logIndex });
  const DEPLOYER8 = addr(0xde9);
  const STRANGER = addr(0xbad);
  const PRICER_KEY = addr(0xb02);
  const unlisted = (r) => r.findings.filter((f) => f.kind === "v2_mon_manager_unlisted_member");
  /** The constructor's ADMIN grant to the deployer, and the published holders' own grants. */
  const published = () => [grant(0, DEPLOYER8, 1000, 0), grant(0, SAFE_ADMIN, 1001, 0), grant(7, addr(0xb04), 1001, 1), grant(8, PRICER_KEY, 1001, 2), grant(9, addr(0xb03), 1001, 3), grant(10, addr(0xb01), 1001, 4)];

  test("The manager's RoleGranted walk pages a member nobody published and a bot key outside its lane, and nothing else", async () => {
    const dir = scratch("monitor-652-members-");
    const chain = new FakeChain({ head: 20_000n });
    chain.read = v8Read(chain);
    chain.logs.push(...published(), grant(8, STRANGER, 5000), grant(0, PRICER_KEY, 5001));
    const r = await runOnce(options(dir, writeV8Registry(dir)), onChain(chain));
    assert.equal(r.checks.members.status, "ok", JSON.stringify(r.checks.members));
    assert.match(r.checks.members.detail, new RegExp(`deployer ${DEPLOYER8.toLowerCase()}`));
    // A report finding is { id, kind, severity, event, message }; the id is `<kind>:<manager>:<account>:<roleId>`.
    const f = unlisted(r);
    const id = (account, roleId) => `v2_mon_manager_unlisted_member:${MANAGER8.toLowerCase()}:${account.toLowerCase()}:${roleId}`;
    assert.deepEqual(f.map((x) => `${x.id}/${x.severity}`).sort(), [`${id(PRICER_KEY, 0)}/error`, `${id(STRANGER, 8)}/error`].sort());
    assert.match(f.find((x) => x.id === id(STRANGER, 8)).message, /none of the registry's Safes, its bot keys or the deployer,? holds PRICER/);
    assert.match(f.find((x) => x.id === id(PRICER_KEY, 0)).message, /v2\.bots\.pricer\), which the manifest gives PRICER and not this one, holds ADMIN/);
  });

  test("A revoked member, a member hasRole denies, and a walk with no ADMIN grant page nothing", async () => {
    const revoked = scratch("monitor-652-revoked-");
    let chain = new FakeChain({ head: 20_000n });
    chain.read = v8Read(chain);
    chain.logs.push(...published(), grant(8, STRANGER, 5000), revoke(8, STRANGER, 6000));
    let r = await runOnce(options(revoked, writeV8Registry(revoked)), onChain(chain));
    assert.equal(r.checks.members.status, "ok");
    assert.deepEqual(unlisted(r), [], "revoked: the walk keeps the LAST event per (role, account)");

    const denied = scratch("monitor-652-denied-");
    chain = new FakeChain({ head: 20_000n });
    chain.read = v8Read(chain, { hasRole: (_a, args) => (String(args[1]).toLowerCase() === STRANGER.toLowerCase() ? [false, 0] : undefined) });
    chain.logs.push(...published(), grant(8, STRANGER, 5000));
    r = await runOnce(options(denied, writeV8Registry(denied)), onChain(chain));
    assert.deepEqual(unlisted(r), [], "hasRole at the head says not a member: the walk is stale, not paged");
    assert.ok(r.notes.some((n) => /the walk is stale/.test(n)), JSON.stringify(r.notes));

    const late = scratch("monitor-652-late-");
    chain = new FakeChain({ head: 20_000n });
    chain.read = v8Read(chain);
    chain.logs.push(grant(8, STRANGER, 5000));
    r = await runOnce(options(late, writeV8Registry(late)), onChain(chain));
    assert.equal(r.checks.members.status, "incomplete", "no ADMIN grant: the manager predates the walk");
    assert.match(r.checks.members.detail, /no ADMIN grant seen since block 1000/);
    assert.deepEqual(unlisted(r), [], "an incomplete walk judges nothing");
  });

  test("The walk keeps its cursor, so a grant after the first run pages from the next run's short range", async () => {
    const dir = scratch("monitor-652-cursor-");
    const registry = writeV8Registry(dir);
    const chain = new FakeChain({ head: 20_000n });
    chain.read = v8Read(chain);
    chain.logs.push(...published());
    const first = await runOnce(options(dir, registry), onChain(chain));
    assert.equal(first.checks.members.status, "ok");
    assert.deepEqual(unlisted(first), []);
    chain.setHead(30_000n, chain.head.timestamp + 1000);
    chain.logs.push(grant(8, STRANGER, 25_000));
    const froms = [];
    chain.getLogsHook = ({ from }) => froms.push(from);
    const second = await runOnce(options(dir, registry), onChain(chain));
    assert.deepEqual(unlisted(second).map((x) => x.id), [`v2_mon_manager_unlisted_member:${MANAGER8.toLowerCase()}:${STRANGER.toLowerCase()}:8`]);
    assert.ok(froms.length > 0 && froms.every((b) => b >= 19_996n), `every range starts at the saved cursor less the reorg overlap: ${froms}`);
  });

  // ---------------------------------------------------------------------------------------------
  // The two tests below are the first in this file to run a full pass with the audit trigger
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
    return runOnce(opts, onChain(chain));
  };

  test("trigger ON and crossed: a full pass reaches checkTvl's FULL arm", async () => {
    const r = await v8TvlPass("monitor-v8-tvl-full-", TVL_TRIGGER_FULL);
    const tvl = r.findings.filter((x) => x.kind === TVL_DARK);
    assert.equal(tvl.length, 1, `exactly one audit-trigger finding: ${JSON.stringify(kindsOf(r))}`);
    // The arm, not the prose. A report finding carries `id` = `${kind}:${key}`, and `key` is what
    // checkTvl sets to "fault", "half" or "full" -- so the id IS the arm. A ":fault" here would mean
    // the pass never got past tvlFaults, which is the state this test pins.
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
    const r = await runOnce(options(dir, writeV8Registry(dir)), onChain(chain));
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
    const r = await runOnce(options(dir, writeV8Registry(dir)), onChain(chain));
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
    const r = await runOnce(options(dir, writeV8Registry(dir)), onChain(chain));
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
    const r = await runOnce(options(dir, writeV8Registry(dir)), onChain(chain));
    // A report finding carries `id` ("<kind>:<key>"), not the raw key.
    const keys = r.findings.filter((x) => x.kind === "v2_mon_route_wiring").map((f) => f.id.split(":").pop());
    assert.deepEqual(new Set(keys), new Set(["venue", "fee", "tickSpacing"]), `keys: ${JSON.stringify(keys)}`);
    assert.ok(r.findings.some((f) => /routes over v3 on chain and the registry publishes v4/.test(f.message)));
  });

  test("a manager whose delays are not the manifest's pages, one alert per member, once the lock has been seen", async () => {
    const dir = scratch("monitor-v8-mgr-");
    const chain = new FakeChain({ head: 20_000n });
    const opts = options(dir, writeV8Registry(dir));
    // Pass 1: the planned delays (the lock). Quiet, and the state records where it first saw them.
    chain.read = v8Read(chain);
    const locked = await runOnce(opts, onChain(chain));
    assert.deepEqual(locked.findings.filter((x) => x.kind === "v2_mon_manager_wiring"), []);
    assert.match(locked.checks.manager.detail, /delay table locked \(planned delays first seen at block 20000\)/);
    // Pass 2: every member back at 0.
    chain.read = v8Read(chain, { hasRole: (address) => (address.toLowerCase() === MANAGER8.toLowerCase() ? [true, 0] : undefined) });
    const r = await runOnce(opts, onChain(chain));
    const wiring = r.findings.filter((x) => x.kind === "v2_mon_manager_wiring");
    // Exactly the published (holder, role) pairs whose manifest delay is not 0 can disagree with a chain
    // that reports 0 for every member — counted from the manifest, not from a number written here.
    const expected = Object.entries(ROLES.holders).flatMap(([, roles]) => roles).filter((name) => ROLES.delaysS[name] > 0).length;
    const delayFindings = wiring.filter((f) => f.id.endsWith(":delay"));
    assert.equal(delayFindings.length, expected, `delay findings: ${JSON.stringify(delayFindings.map((f) => f.id))}`);
    assert.ok(expected > 0, "the manifest must have at least one delayed holder, or this test proves nothing");
    assert.ok(wiring.every((f) => f.severity === "error"));
    assert.match(delayFindings[0].message, /delay IS the protection/);
    assert.match(delayFindings[0].message, /the lock has been undone/);
  });

  test("A launch-profile deployment before `stonkctl lock` is ONE prelock warn on the first pass, not a P1 per lane", async () => {
    const dir = scratch("monitor-v8-prelock-");
    const chain = new FakeChain({ head: 20_000n });
    chain.read = v8Read(chain, { hasRole: (address) => (address.toLowerCase() === MANAGER8.toLowerCase() ? [true, 0] : undefined) });
    const opts = options(dir, writeV8Registry(dir));
    const expected = Object.entries(ROLES.holders).flatMap(([, roles]) => roles).filter((name) => ROLES.delaysS[name] > 0).length;
    for (const pass of [1, 2]) {
      const r = await runOnce(opts, onChain(chain));
      const wiring = r.findings.filter((x) => x.kind === "v2_mon_manager_wiring");
      assert.deepEqual(wiring.map((f) => `${f.id.split(":").pop()}/${f.severity}`), ["prelock/warn"], `pass ${pass}: ${JSON.stringify(wiring.map((f) => f.id))}`);
      // A report finding carries id, kind, severity and message; the lane count is in the message.
      assert.match(wiring[0].message, new RegExp(`every delayed lane is at 0 \\(${expected}: `));
      assert.match(r.checks.manager.detail, /delay table launch;|delay table launch$/);
      assert.equal(r.checks.manager.status, "ok");
    }
    // The lock executes: every lane at its manifest delay. Quiet, and the pre-lock warn is gone.
    chain.read = v8Read(chain);
    const after = await runOnce(opts, onChain(chain));
    assert.deepEqual(after.findings.filter((x) => x.kind === "v2_mon_manager_wiring"), []);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/*  the v8 events that reached no branch at all                                                      */
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
    // A buy may spend min(buybackCap, buybackCapCeiling) (FeeSplitter._buyback :287), so either at 0 is EMPTY.
    assert.match(empty[0].message, /the zero is buybackCap or buybackCapCeiling \(a buy may spend the smaller of the two\).*setBuybackCapCeiling ADMIN at 48 h/s);
    assert.match(empty[0].message, /setBuybackCap is FEE_MANAGER at a 48 h delay/);
    assert.equal(empty[0].data.reason, "EMPTY");

    const noexec = checkBuyback({ ...stuck, lastSkip: { reason: "NO_EXECUTOR", at: now - 60 } }, DEFAULTS);
    assert.deepEqual(kinds(noexec), ["v2_mon_buyback_skipped/error"]);
    assert.match(noexec[0].message, /setBuybackExecutor \/ setToken are TREASURY_ADMIN at a 24 h delay/);
  });

  // The same paths fed the log the chain really carries: keccak256 of the word.
  test("a real on-chain BuybackSkipped (keccak256 reason) reaches the dial-specific page", () => {
    const f = fly();
    applyFlywheelLogs(f, [{ eventName: "BuybackSkipped", args: { reason: viem.keccak256(viem.toHex("NO_EXECUTOR")) }, transactionHash: `0x${"c".repeat(64)}` }], now - 60, SPLITTER);
    assert.deepEqual(f.lastSkip, { reason: "NO_EXECUTOR", at: now - 60 });
    const [page] = checkBuyback({ ...stuck, lastSkip: f.lastSkip }, DEFAULTS);
    assert.match(page.message, /setBuybackExecutor \/ setToken are TREASURY_ADMIN at a 24 h delay/);
  });

  test("SHORT_RESERVE names the hole, not the cranker", () => {
    const [page] = checkBuyback({ ...stuck, lastSkip: { reason: "SHORT_RESERVE", at: now - 60 } }, DEFAULTS);
    assert.equal(page.kind, "v2_mon_buyback_skipped");
    assert.match(page.message, /BuybackSkipped\(SHORT_RESERVE\)/);
    assert.match(page.message, /SEC-43.*fails closed.*recovery is more USDG arriving/s);
  });

  test("the stuck page names the v9 entry point: buyback(uint256) always reverts BuybackDeadlineRequired", () => {
    const [page] = checkBuyback(stuck, DEFAULTS);
    assert.match(page.message, /buybackWithDeadline\(minTokenOut, deadline\): buyback\(uint256\) ALWAYS reverts BuybackDeadlineRequired/);
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
 * The ops-only publication packet.
 *
 * These guard the ops-only publication runbook's `publication-manifest` block, which
 * ops/go-live-v2.sh --check-public-ref reads. They live in this file for historical reasons;
 * they are about the runbook, not about monitor.mjs.
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

describe("Every FeeSplitter event is scanned and paged, or excused by name", () => {
  // The event set comes from the exported ABI, never from a list typed here. FeeSplitter.json is the concrete
  // contract, so it carries AccessManaged's AuthorityUpdated, which IFeeSplitter.json does not.
  const splitterEvents = () => abiJson("FeeSplitter").filter((e) => e.type === "event");
  /** The signature as SCAN_EVENTS writes it: indexed and names included, because both change what viem decodes. */
  const fullSig = (e) => `${e.name}(${e.inputs.map((i) => `${typeOf(i)}${i.indexed ? " indexed" : ""} ${i.name}`).join(", ")})`;

  test("the concrete ABI covers the interface's events", () => {
    const concrete = new Set(splitterEvents().map(fullSig));
    for (const e of abiJson("IFeeSplitter").filter((x) => x.type === "event")) {
      assert.ok(concrete.has(fullSig(e)), `IFeeSplitter's ${fullSig(e)} is not in FeeSplitter.json`);
    }
  });

  test("partition: each ABI event is scanned with its exact signature and has exactly one pager, or is excused", () => {
    const viem = loadViem();
    const scanned = new Set(viem.parseAbi(SCAN_EVENTS).filter((x) => x.type === "event").map(fullSig));
    const events = splitterEvents();
    assert.ok(events.length >= 16, `FeeSplitter.json has only ${events.length} events: is this the right file?`);
    const bad = [];
    for (const e of events) {
      const paged = CONFIG_EVENTS[e.name] !== undefined;
      const own = OWN_KIND_EVENTS.has(e.name);
      const excuse = FEE_SPLITTER_NOT_PAGED[e.name];
      if (excuse !== undefined) {
        if (typeof excuse !== "string" || excuse.trim() === "") bad.push(`${e.name}: excused with no reason`);
        if (paged || own) bad.push(`${e.name}: excused AND paged`);
        continue;
      }
      if (!scanned.has(fullSig(e))) bad.push(`${fullSig(e)}: not in SCAN_EVENTS, so the scan never decodes it`);
      if (!paged && !own) bad.push(`${e.name}: scanned but no severity in CONFIG_EVENTS and no kind of its own, so NOTHING pages it`);
      if (paged && own) bad.push(`${e.name}: in CONFIG_EVENTS and OWN_KIND_EVENTS, so it would page twice`);
    }
    const names = new Set(events.map((e) => e.name));
    for (const name of Object.keys(FEE_SPLITTER_NOT_PAGED)) if (!names.has(name)) bad.push(`${name}: excused, but FeeSplitter.json has no such event`);
    assert.deepEqual(bad, []);
  });

  test("severities: the stranded-fees record and every address the money flows through page as error", () => {
    for (const e of splitterEvents()) {
      if (SPLITTER_EVENTS.has(e.name)) continue;
      const s = CONFIG_EVENTS[e.name];
      assert.ok(s === "error" || s === "warn", `${e.name} has severity ${s}`);
      // An address-valued admin setting (OrderBookSet, RouterSet, ... AuthorityUpdated) moves where fees, prices or
      // authority come from; none of them may be a warn.
      if (e.inputs.length === 1 && e.inputs[0].type === "address") assert.equal(s, "error", `${e.name} sets an address`);
    }
    assert.equal(CONFIG_EVENTS.OrderBookFeesStranded, "error", "fees that will never reach the splitter are a P1 page");
  });

  test("KeeperRewards' MaxBountySet is scanned with its exact exported signature and pages as warn", () => {
    const viem = loadViem();
    const scanned = new Set(viem.parseAbi(SCAN_EVENTS).filter((x) => x.type === "event").map(fullSig));
    const e = abiJson("KeeperRewards").find((x) => x.type === "event" && x.name === "MaxBountySet");
    assert.ok(e, "KeeperRewards.json exports MaxBountySet");
    assert.ok(scanned.has(fullSig(e)), `${fullSig(e)} is not in SCAN_EVENTS`);
    assert.equal(CONFIG_EVENTS.MaxBountySet, "warn");
  });

  test("EarnVault's LimitsSet is scanned, told from MakerVault's, and pages as warn", () => {
    const viem = loadViem();
    const scanAbi = viem.parseAbi(SCAN_EVENTS);
    const scanned = new Set(scanAbi.filter((x) => x.type === "event").map(fullSig));
    const earnEv = abiJson("EarnVault").find((x) => x.type === "event" && x.name === "LimitsSet");
    const makerEv = abiJson("MakerVault").find((x) => x.type === "event" && x.name === "LimitsSet");
    assert.ok(scanned.has(fullSig(earnEv)), `${fullSig(earnEv)} is not in SCAN_EVENTS`);
    assert.ok(scanned.has(fullSig(makerEv)), "MakerVault's LimitsSet is still scanned");
    assert.equal(CONFIG_EVENTS.EarnLimitsSet, "warn");
    const EARN = "0x00000000000000000000000000000000000e4a11";
    const MAKER = "0x00000000000000000000000000000000000a4e11";
    const encode = (ev, address, limits, logIndex) => {
      const topics = viem.encodeEventTopics({ abi: [ev], eventName: "LimitsSet", args: {} });
      const data = viem.encodeAbiParameters(ev.inputs, [limits]);
      return { address, topics, data, blockNumber: 901n, transactionHash: `0x${"ef".repeat(32)}`, logIndex, blockHash: `0x${"cd".repeat(32)}`, transactionIndex: 0, removed: false };
    };
    const earnLimits = { maxSeriesUnits: 1_000n, maxOrderNotional: 50_000_000_000n, maxWrittenUnitsPerSeries: 2_000n, maxWrittenNotional: 250_000_000_000n, maxDailyOutflow: 2_500_000_000n };
    const makerLimits = { maxSeriesUnits: 10_000n, maxTotalNotional: 10n ** 12n, askToleranceBps: 100, maxBidBpsOfSpot: 500, maxOrderLifetime: 86_400, maxDailyOutflow: 10n ** 11n };
    const logs = [encode(earnEv, EARN, earnLimits, 0), encode(makerEv, MAKER, makerLimits, 1)];
    const decoded = viem.parseEventLogs({ abi: scanAbi, logs, strict: true });
    assert.equal(decoded.length, 2, "both LimitsSet logs decode through the scan's own ABI list");
    const collected = applyScanLogs({ series: {}, rentAt: null }, decoded, { earnVault: EARN });
    assert.deepEqual(collected.map((l) => l.eventName).sort(), ["EarnLimitsSet", "LimitsSet"]);
    const found = configEventFindings(collected, null, { [EARN.toLowerCase()]: "EarnVault", [MAKER.toLowerCase()]: "MakerVault" });
    const by = Object.fromEntries(found.map((f) => [f.data.event, f]));
    assert.equal(by.EarnLimitsSet.severity, "warn");
    assert.match(by.EarnLimitsSet.message, /^EarnVault\.EarnLimitsSet\(limits=.*"maxDailyOutflow":"2500000000"/);
    assert.equal(by.LimitsSet.severity, "warn", "MakerVault's LimitsSet pages as before");
  });

  test("An encoded BuybackBalanceWrittenDown decodes through the scan and pages as error naming the lowered counter", () => {
    const viem = loadViem();
    const abi = abiJson("FeeSplitter");
    const ev = abi.find((x) => x.type === "event" && x.name === "BuybackBalanceWrittenDown");
    assert.ok(ev, "FeeSplitter.json exports BuybackBalanceWrittenDown");
    assert.equal(viem.toEventSelector(ev), "0x77b3db54d02718b51059d369d8dfc3e2dace0d81e9343283d12eb7a03d468ca4", "the topic the contracts pin");
    const splitter = "0x00000000000000000000000000000000000005f1";
    const topics = viem.encodeEventTopics({ abi: [ev], eventName: "BuybackBalanceWrittenDown", args: {} });
    const data = viem.encodeAbiParameters(ev.inputs, [150_000_000n, 40_000_000n]);
    const log = { address: splitter, topics, data, blockNumber: 902n, transactionHash: `0x${"a1".repeat(32)}`, logIndex: 0, blockHash: `0x${"cd".repeat(32)}`, transactionIndex: 0, removed: false };
    const decoded = viem.parseEventLogs({ abi: viem.parseAbi(SCAN_EVENTS), logs: [log], strict: true });
    assert.deepEqual(decoded.map((l) => l.eventName), ["BuybackBalanceWrittenDown"], "the scan's own ABI list decodes it");
    const collected = applyScanLogs({ series: {}, rentAt: null }, decoded, {});
    const [page] = configEventFindings(collected, null, { [splitter]: "FeeSplitter" });
    assert.ok(page, "it pages");
    assert.equal(page.severity, "error");
    assert.match(page.message, /lowered the counter from 150\.00 to 40\.00 USDG: 110\.00 USDG of the buyback reserve/);
    // distribute and distributeAmount write the counter down too, so the page does not say a buyback did.
    assert.match(page.message, /a buyback or a fee distribution lowered the counter/);
    assert.match(page.message, /issuer burn or seizure/);
    assert.ok(!page.message.includes("compromised"), "a write-down is a loss the issuer caused, not a key compromise");
  });

  test("an encoded OrderBookFeesStranded log decodes through the scan and pages with the amount and the old book", () => {
    const viem = loadViem();
    const abi = abiJson("FeeSplitter");
    const splitter = "0x00000000000000000000000000000000000005f1";
    const oldBook = "0x0000000000000000000000000000000000000b0c";
    const encode = (eventName, args, logIndex) => {
      const ev = abi.find((x) => x.type === "event" && x.name === eventName);
      const topics = viem.encodeEventTopics({ abi: [ev], eventName, args });
      const unindexed = ev.inputs.filter((i) => !i.indexed);
      const data = viem.encodeAbiParameters(unindexed, unindexed.map((i) => args[i.name]));
      return { address: splitter, topics, data, blockNumber: 900n, transactionHash: `0x${"ab".repeat(32)}`, logIndex, blockHash: `0x${"cd".repeat(32)}`, transactionIndex: 0, removed: false };
    };
    const logs = [
      encode("OrderBookFeesStranded", { orderBook: oldBook, amount: 12_345_678n }, 0),
      encode("PausedSet", { paused: true }, 1),
      encode("AuthorityUpdated", { authority: "0x0000000000000000000000000000000000000a11" }, 2),
    ];
    const decoded = viem.parseEventLogs({ abi: viem.parseAbi(SCAN_EVENTS), logs, strict: true });
    assert.deepEqual(decoded.map((l) => l.eventName), ["OrderBookFeesStranded", "PausedSet", "AuthorityUpdated"]);
    const collected = applyScanLogs({ series: {}, rentAt: null }, decoded, {});
    assert.equal(collected.length, 3, "the scan keeps all three for the config check");
    const found = configEventFindings(collected, null, { [splitter]: "FeeSplitter" });
    const by = Object.fromEntries(found.map((f) => [f.data.event, f]));
    assert.equal(by.OrderBookFeesStranded.severity, "error");
    assert.match(by.OrderBookFeesStranded.message, /12\.34 USDG of fees stayed in the old OrderBook/);
    assert.ok(by.OrderBookFeesStranded.message.toLowerCase().includes(oldBook), "the page names the book the fees are in");
    assert.ok(!by.OrderBookFeesStranded.message.includes("compromised"), "a stranded balance is not a key compromise");
    assert.equal(by.PausedSet.severity, "warn");
    assert.match(by.PausedSet.message, /treat the key as compromised/);
    assert.equal(by.AuthorityUpdated.severity, "error");
    // Every v8 constructor emits AuthorityUpdated; at or below the adoption block it pages nothing.
    assert.deepEqual(configEventFindings(collected, 900n, {}), []);
  });
});

describe("applyManagerMembership and checkManagerMembers", () => {
  const MANAGER = addr(0xac1);
  const at = (eventName, roleId, account, blockNumber, logIndex = 0) => ({ eventName, args: { roleId: BigInt(roleId), account }, blockNumber: BigInt(blockNumber), logIndex });
  const walkOf = (logs) => applyManagerMembership({ cursor: null, members: {}, firstAdmin: null }, logs);
  const holders = { adminSafe: addr(0x5a1), treasurySafe: addr(0x5a2), guardianKey: addr(0xb04), pricerKey: addr(0xb02), quoterKey: addr(0xb03), crankerKey: addr(0xb01) };
  const check = (walk, confirmed = new Map()) => checkManagerMembers({ manager: MANAGER, walk, manifest: ROLE_MANIFEST.manifest, holders, confirmed });

  test("the last event per (role, account) wins, a replayed older log changes nothing, and firstAdmin is the earliest ADMIN grant", () => {
    const x = addr(0xbad);
    const w = walkOf([at("RoleGranted", 0, addr(0xde9), 100, 3), at("RoleGranted", 8, x, 200), at("RoleRevoked", 8, x, 300, 1)]);
    assert.equal(w.members[`8:${x.toLowerCase()}`].member, false);
    applyManagerMembership(w, [at("RoleGranted", 8, x, 200), at("RoleGranted", 0, addr(0xde8), 100, 2)]);
    assert.equal(w.members[`8:${x.toLowerCase()}`].member, false, "the overlap re-read replays the grant: still revoked");
    assert.deepEqual(w.firstAdmin, { account: addr(0xde8).toLowerCase(), block: 100, logIndex: 2 }, "an earlier ADMIN grant seen late still becomes firstAdmin");
    applyManagerMembership(w, [at("RoleGranted", 8, x, 300, 2)]);
    assert.equal(w.members[`8:${x.toLowerCase()}`].member, true, "a grant after the revoke in the same block counts");
    applyManagerMembership(w, [{ eventName: "RoleAdminChanged", args: { roleId: 8n }, blockNumber: 400n, logIndex: 0 }]);
    assert.equal(Object.keys(w.members).length, 3, "other events are ignored");
  });

  test("pages a stranger and a bot key outside its manifest lane; never the Safes, the deployer or a bot in its lane", () => {
    const w = walkOf([
      at("RoleGranted", 0, addr(0xde9), 100),
      at("RoleGranted", 0, holders.adminSafe, 101),
      at("RoleGranted", 4, holders.treasurySafe, 101, 1),
      at("RoleGranted", 7, holders.guardianKey, 101, 2),
      at("RoleGranted", 10, holders.crankerKey, 101, 3),
      at("RoleGranted", 6, addr(0xde9), 102),
      at("RoleGranted", 5, addr(0xbad), 103),
      at("RoleGranted", 0, holders.guardianKey, 104),
    ]);
    const f = check(w);
    assert.deepEqual(f.map((x) => `${x.kind}/${x.severity}/${x.data.role}/${x.data.account}`).sort(), [
      `v2_mon_manager_unlisted_member/error/ADMIN/${holders.guardianKey.toLowerCase()}`,
      `v2_mon_manager_unlisted_member/error/LISTING/${addr(0xbad).toLowerCase()}`,
    ].sort());
    assert.equal(f[0].check, "members");
    assert.deepEqual(check(w, new Map([[`5:${addr(0xbad).toLowerCase()}`, false], [`0:${holders.guardianKey.toLowerCase()}`, false]])), [], "hasRole false at the head: not paged");
    assert.match(check(w, new Map([[`5:${addr(0xbad).toLowerCase()}`, true]])).find((x) => x.data.roleId === 5).message, /still a member at the head/);
    const noDeployer = { ...w, firstAdmin: null };
    assert.ok(check(noDeployer).some((x) => x.data.account === addr(0xde9).toLowerCase()), "the deployer is known only as the walk's first ADMIN grant");
  });
});

describe("checkFeedExpiryGap", () => {
  const E = Date.UTC(2026, 8, 21, 20) / 1000; // Monday 2026-09-21, 16:00 New York
  const SAT = Date.UTC(2026, 8, 26, 16) / 1000; // Saturday 2026-09-26, 12:00 New York: the 24/5 market is closed
  const MAX = 93_600;
  const base = { ticker: "NVDA", underlying: addr(0xa001), feed: addr(0xb001), expiry: E, now: E - 3 * 3600, updatedAt: E - MAX, maxStale: MAX, pinned: true, pool: { address: addr(0x9001), liquidity: 10_000n, floor: 1000n } };
  const sev = (f) => f.map((x) => `${x.kind}/${x.severity}`);

  test("the Chainlink leg needs a round at or after E - maxStale; one second older pages", () => {
    assert.deepEqual(checkFeedExpiryGap(base), [], "a round exactly maxStale before E is still fresh at E");
    const f = checkFeedExpiryGap({ ...base, updatedAt: E - MAX - 1 });
    assert.deepEqual(sev(f), ["v2_mon_feed_expiry_gap/warn"], "open market remains before the window: a healthy feed can still print");
    assert.equal(f[0].key, `${addr(0xa001).toLowerCase()}:${E}`);
    assert.equal(f[0].check, "feedgap");
    assert.equal(f[0].data.needFrom, E - MAX);
    assert.ok(f[0].data.openLeftS > 0);
    assert.match(f[0].message, /the pinned maxStale/);
    assert.match(f[0].message, /settle on the pool alone, uncorroborated/);
  });

  test("error once the window has begun, when no open market remains, or when the pool is under twice its floor", () => {
    const old = { ...base, updatedAt: E - MAX - 60 };
    assert.deepEqual(sev(checkFeedExpiryGap({ ...old, now: E - SETTLEMENT_WINDOW })), ["v2_mon_feed_expiry_gap/error"], "the window has begun");
    const closed = checkFeedExpiryGap({ ...old, expiry: SAT, now: SAT - 7200, updatedAt: SAT - MAX - 60 });
    assert.deepEqual(sev(closed), ["v2_mon_feed_expiry_gap/error"], "the 24/5 market is closed until after the window");
    assert.equal(closed[0].data.openLeftS, 0);
    const thin = checkFeedExpiryGap({ ...old, pool: { ...base.pool, liquidity: 1999n } });
    assert.deepEqual(sev(thin), ["v2_mon_feed_expiry_gap/error"], "under twice the floor");
    assert.match(thin[0].message, /B-03/);
    assert.match(thin[0].message, /the band is unbounded: once Held, adminResolve takes any price from E \+ 7 d/, "T-SEC-B-03 / T-OP-831: not before E + 7 d");
    assert.deepEqual(sev(checkFeedExpiryGap({ ...old, pool: { ...base.pool, liquidity: 2000n } })), ["v2_mon_feed_expiry_gap/warn"], "exactly twice the floor is not thin");
    assert.match(checkFeedExpiryGap({ ...old, pool: { ...base.pool, liquidity: null } })[0].message, /could not be read/);
    assert.match(checkFeedExpiryGap({ ...old, pool: null })[0].message, /names no pool/);
    assert.match(checkFeedExpiryGap({ ...old, pinned: false })[0].message, /the market's maxStale/);
  });

  test("watched only from E - feedGapLeadS to E, and never on an unread round or maxStale", () => {
    const old = { ...base, updatedAt: E - MAX - 60 };
    assert.equal(checkFeedExpiryGap({ ...old, now: E - DEFAULTS.feedGapLeadS }).length, 1);
    assert.deepEqual(checkFeedExpiryGap({ ...old, now: E - DEFAULTS.feedGapLeadS - 1 }), [], "before the lead");
    assert.equal(checkFeedExpiryGap({ ...old, now: E }).length, 1);
    assert.deepEqual(checkFeedExpiryGap({ ...old, now: E + 1 }), [], "after E only a carried expiry with its settlement read is judged (T-OP-789)");
    assert.deepEqual(checkFeedExpiryGap({ ...old, updatedAt: 0 }), [], "no round read");
    assert.deepEqual(checkFeedExpiryGap({ ...old, maxStale: 0 }), [], "no maxStale read");
  });

  test("Passing E does not resolve the gap; it stays open until Finalized or the Chainlink leg recorded ok", () => {
    const old = { ...base, updatedAt: E - MAX - 60 };
    const pending = { finalized: false, captured: false, chainlinkOk: null };
    const at5 = checkFeedExpiryGap({ ...old, now: E + 5, settlement: pending });
    assert.deepEqual(sev(at5), ["v2_mon_feed_expiry_gap/error"], "E + 5 s, not captured: still open");
    assert.equal(at5[0].key, `${addr(0xa001).toLowerCase()}:${E}`, "the same alert, so it is never resolved and re-opened");
    assert.match(at5[0].message, /passed 5 s ago without its Chainlink leg/);
    assert.match(at5[0].message, /stays open until the expiry is Finalized/);
    assert.equal(at5[0].data.afterExpiry, true);
    const notOk = checkFeedExpiryGap({ ...old, now: E + 600, settlement: { finalized: false, captured: true, chainlinkOk: false } });
    assert.deepEqual(sev(notOk), ["v2_mon_feed_expiry_gap/error"]);
    assert.match(notOk[0].message, /the capture recorded its Chainlink leg NOT ok/);
    assert.deepEqual(checkFeedExpiryGap({ ...old, now: E + 600, settlement: { finalized: false, captured: true, chainlinkOk: true } }), [], "the leg recorded ok");
    assert.deepEqual(checkFeedExpiryGap({ ...old, now: E + 7 * 3600, settlement: { finalized: true, captured: true, chainlinkOk: false } }), [], "Finalized ends it");
    assert.deepEqual(checkFeedExpiryGap({ ...old, now: E + 5, settlement: null }), [], "no settlement read: the caller marks the pass incomplete instead");
  });
});

describe("the feedgap check in a whole pass", () => {
  const E = Date.UTC(2026, 8, 21, 20) / 1000; // Monday 2026-09-21, 16:00 New York
  const HV = addr(0x4a12);
  const POOL = addr(0x9001);
  const NVDA = market("NVDA", 1, { pool: POOL, floor: "1000" });
  const FEED = NVDA.feed;
  const MAX = 93_600;

  /** One House vault for NVDA with its boundary at E; the expiry's feed and pool pinned. */
  function pass(dir, { now, updatedAt, pinned = true, liquidity = 10_000n, launch = null, info = [0, 0n, 0, false, false, false], recorded = [[], [], [], 0], candidate = [0n, 0, false, 0] }) {
    const registry = writeRegistry(dir, { markets: [NVDA] });
    const chain = new FakeChain({ timestamp: now });
    chain.read = (address, fn, args) => {
      const a = address.toLowerCase();
      if (a === HV.toLowerCase()) {
        const v = { epochEnd: E, epochId: 7n, trackedSeries: [], underlying: NVDA.asset, oracle: C.settlementOracle, weekly: false, performanceFeeOwed: 0n }[fn];
        if (v !== undefined) return v;
      }
      if (a === C.settlementOracle.toLowerCase() && Number(args?.[1]) === E) {
        if (fn === "settlementConfig") return [true, [SRC.chainlink, SRC.univ3], 150, 21600, 3600];
        if (fn === "settlementInfo") return info;
        if (fn === "recordedSources") return recorded;
        if (fn === "candidate") return candidate;
      }
      if (a === SRC.chainlink.toLowerCase() && fn === "pinnedFeeds") return pinned ? [FEED, MAX, 2000, true] : [ZERO, 0, 0, false];
      if (a === SRC.chainlink.toLowerCase() && fn === "feeds") return [FEED, MAX, 2000];
      if (a === FEED.toLowerCase() && fn === "latestRoundData") return [1n, 100_00000000n, 0n, BigInt(updatedAt), 1n];
      if (a === SRC.univ3.toLowerCase() && fn === "pinnedPools") return [POOL, false, 18, 300, true, 1000n];
      if (a === POOL.toLowerCase() && fn === "liquidity") return liquidity;
      return defaultRead(chain, address, fn, args);
    };
    const extra = ["--house", `NVDA=${HV}`, ...(launch === null ? [] : ["--launch", launch])];
    return runOnce(options(dir, registry, extra), onChain(chain));
  }
  const gap = (r) => r.findings.filter((f) => f.kind === "v2_mon_feed_expiry_gap");

  test("pages the launch expiry whose feed has not printed since E - maxStale, on the pinned configuration", async () => {
    const dir = tmp("monitor-652-feedgap-");
    try {
      const fresh = await pass(dir, { now: E - 3 * 3600, updatedAt: E - MAX });
      assert.equal(fresh.checks.feedgap.status, "ok", JSON.stringify(fresh.checks.feedgap));
      assert.deepEqual(gap(fresh), []);
      assert.match(fresh.checks.feedgap.detail, /NVDA .*needs one from/);
      const stale = await pass(dir, { now: E - 3 * 3600, updatedAt: E - MAX - 60 });
      assert.deepEqual(gap(stale).map((f) => `${f.id}/${f.severity}`), [`v2_mon_feed_expiry_gap:${NVDA.asset.toLowerCase()}:${E}/warn`]);
      assert.match(gap(stale)[0].message, new RegExp(`the pinned maxStale.*The pool ${POOL} has 10000 in-range liquidity \\(floor 1000\\)`));
      const thin = await pass(dir, { now: E - 3 * 3600, updatedAt: E - MAX - 60, liquidity: 1500n });
      assert.deepEqual(gap(thin).map((f) => f.severity), ["error"], "the pinned pool under twice its pinned floor");
      const running = await pass(dir, { now: E - 600, updatedAt: E - MAX - 60 });
      assert.deepEqual(gap(running).map((f) => f.severity), ["error"], "the window has begun");
      const unpinned = await pass(dir, { now: E - 3 * 3600, updatedAt: E - MAX - 60, pinned: false });
      assert.match(gap(unpinned)[0]?.message ?? "", /the market's maxStale/, "unpinned: the market's feed and maxStale");
      assert.deepEqual(gap(await pass(dir, { now: E - 3 * 3600 - 1, updatedAt: E - MAX - 60 })), [], "before feedGapLeadS");
      assert.deepEqual(gap(await pass(dir, { now: E - 3 * 3600, updatedAt: E - MAX - 60, launch: "SPCX" })), [], "launch markets only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("The open gap is carried past E and kept until the expiry is Finalized, never resolved at E", async () => {
    const dir = tmp("monitor-789-feedgap-");
    const id = `v2_mon_feed_expiry_gap:${NVDA.asset.toLowerCase()}:${E}`;
    const alerts = () => Object.keys(JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")).alerts);
    try {
      const stale = { updatedAt: E - MAX - 60 };
      const open = await pass(dir, { ...stale, now: E - 600 });
      assert.deepEqual(gap(open).map((f) => `${f.id}/${f.severity}`), [`${id}/error`]);
      const at5 = await pass(dir, { ...stale, now: E + 5, info: [1, 0n, 0, false, false, false] });
      assert.equal(at5.checks.feedgap.status, "ok", JSON.stringify(at5.checks.feedgap));
      assert.deepEqual(gap(at5).map((f) => `${f.id}/${f.severity}`), [`${id}/error`], "E + 5 s: still open");
      assert.ok(alerts().includes(id), "remembered, so no resolved message goes out");
      const recordedNotOk = [[SRC.chainlink, SRC.univ3], [false, true], [0n, 222_000_000n], 150];
      const captured = await pass(dir, { ...stale, now: E + 300, info: [1, 222_000_000n, 1, false, false, true], recorded: recordedNotOk });
      assert.match(gap(captured)[0]?.message ?? "", /the capture recorded its Chainlink leg NOT ok/);
      const finalized = await pass(dir, { ...stale, now: E + 7 * 3600, info: [2, 222_000_000n, 1, false, false, true], recorded: recordedNotOk });
      assert.deepEqual(gap(finalized), [], "Finalized: the condition is over");
      assert.ok(!alerts().includes(id), "and only now is it forgotten (resolved)");
      assert.deepEqual(gap(await pass(dir, { ...stale, now: E + 5, info: [1, 0n, 0, false, false, false] })), [], "an expiry nobody had open is not picked up after E");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("The house stall warns on a pending undisputed candidate and pages ERROR without one", async () => {
    const dir = tmp("monitor-789-house-");
    const stall = (r) => r.findings.filter((f) => f.kind === "v2_mon_house_epoch_stall").map((f) => f.severity);
    try {
      const info = [1, 0n, 1, false, false, true];
      const warn = await pass(dir, { now: E + 3600, updatedAt: E - 60, info, candidate: [222_000_000n, 1, false, E + 21_600] });
      assert.deepEqual(stall(warn), ["warn"], JSON.stringify(warn.checks.house));
      assert.match(warn.findings.find((f) => f.kind === "v2_mon_house_epoch_stall").message, /No quoter or Safe action is needed/);
      const dir2 = tmp("monitor-789-house2-");
      try {
        assert.deepEqual(stall(await pass(dir2, { now: E + 3600, updatedAt: E - 60, info })), ["error"], "no candidate");
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/*
 * Two monitor gaps from the v9 rehearsals. (1) A winning call paid in stock to a holder who prefers USDG
 * (the settlement-floor protection) was paged by nothing. (2) With both price sources dead, the
 * snapshot_missed and pool_liquidity_low pages said "settles on the other source / on Chainlink alone" while
 * v2_mon_guardian_veto_due said no source prices it (a weekend drill). Each text now follows the same facts.
 */
describe("in-kind payouts and page texts that agree", () => {
  const CH = "0x2256c045245288A314048aD2d71006a564343C63";
  const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  const HOLDER = "0x1111111111111111111111111111111111111111";
  const STOCKER = "0x2222222222222222222222222222222222222222";
  const addresses = { clearinghouse: CH, usdg: USDG };
  const CALL = 1000n;
  const PUT = 2000n;
  const created = (longId, isPut, block) => ({ eventName: "SeriesCreated", address: CH, args: { longId, underlying: U, isPut, strike: 5n, expiry: E, oracle: ORACLE, mintFeePpm: 80 }, blockNumber: block, logIndex: 0 });
  const redeemed = (tokenId, holder, asset, amount, block, logIndex = 0, units = 10n) => ({
    eventName: "Redeemed", address: CH, args: { tokenId, holder, to: holder, units, asset, amount, amountInKind: amount, toLedger: false }, blockNumber: block, logIndex,
  });
  const prefs = (account, inKind, block) => ({ eventName: "PayoutPrefsSet", address: CH, args: { account, inKind, toLedger: false }, blockNumber: block, logIndex: 9 });

  test("a winning long call paid in stock to a USDG holder is tallied and collected; nothing else is", () => {
    const scan = emptyState(4663, "x").scan;
    const sink = [];
    applyScanLogs(scan, [
      created(CALL, false, 1n),
      created(PUT, true, 1n),
      prefs(STOCKER, true, 2n),
      redeemed(CALL, HOLDER, U, 1658n, 3n, 0),        // counted: long call, stock, USDG preference (never set)
      redeemed(CALL, HOLDER, USDG, 2_500_000n, 3n, 1), // converted to USDG
      redeemed(CALL, STOCKER, U, 500n, 3n, 2),        // chose stock
      redeemed(CALL | 1n, HOLDER, U, 900n, 3n, 3),    // a short call returns its stock collateral
      redeemed(PUT, HOLDER, USDG, 700n, 3n, 4),       // a put pays USDG
      redeemed(CALL, HOLDER, U, 0n, 3n, 5),           // out of the money
      redeemed(3000n, HOLDER, U, 10n, 3n, 6),         // a series the scan never saw
      { ...redeemed(CALL, HOLDER, U, 10n, 3n, 7), address: "0x9999999999999999999999999999999999999999" },
    ], addresses, null, sink);
    assert.deepEqual(scan.inKind, { [`${U.toLowerCase()}:${E}`]: { n: 1, units: "10" } });
    assert.deepEqual(scan.inKindPrefs, { [STOCKER.toLowerCase()]: 1 });
    assert.equal(sink.length, 1);
    assert.equal(sink[0].total, 1);
    assert.deepEqual(sink[0].series, { u: U, e: E });
  });

  test("a replayed overlap is not counted twice, and switching back to USDG counts again", () => {
    const scan = emptyState(4663, "x").scan;
    const first = [];
    applyScanLogs(scan, [created(CALL, false, 1n), prefs(STOCKER, true, 2n), redeemed(CALL, HOLDER, U, 1658n, 3n)], addresses, null, first);
    const again = [];
    applyScanLogs(scan, [redeemed(CALL, HOLDER, U, 1658n, 3n), prefs(STOCKER, false, 4n), redeemed(CALL, STOCKER, U, 50n, 5n)], addresses, null, again);
    assert.equal(first.length, 1);
    assert.equal(again.length, 1, "the reorg overlap re-read block 3; only block 5 is new");
    assert.equal(again[0].args.holder, STOCKER);
    assert.equal(scan.inKind[`${U.toLowerCase()}:${E}`].n, 2);
  });

  test("no USDG address in the registry: nothing is judged", () => {
    const scan = emptyState(4663, "x").scan;
    const sink = [];
    applyScanLogs(scan, [created(CALL, false, 1n), redeemed(CALL, HOLDER, U, 1658n, 3n)], { clearinghouse: CH }, null, sink);
    assert.equal(sink.length, 0);
    assert.deepEqual(scan.inKind, {});
  });

  test("one WARN event per expiry per run, keyed by the running total, naming the expiry and the count; history adopted", () => {
    const scan = emptyState(4663, "x").scan;
    const sink = [];
    applyScanLogs(scan, [created(CALL, false, 1n), redeemed(CALL, HOLDER, U, 1658n, 3n, 0, 17n), redeemed(CALL, STOCKER, U, 166n, 4n, 0, 2n)], addresses, null, sink);
    const f = inKindPayoutFindings(sink, null, { tickerOf: () => "NVDA" });
    assert.deepEqual(kinds(f), ["v2_mon_payout_in_kind/warn"]);
    assert.equal(f[0].event, true);
    assert.equal(f[0].key, `${U.toLowerCase()}:${E}:2`);
    assert.equal(f[0].data.count, 2);
    assert.equal(f[0].data.units, 19n);
    assert.match(f[0].message, /^NVDA expiry 2026-09-17T20:00:00Z: 2 winning call redemptions \(0\.19 shares\) paid in NVDA stock to holders whose payout preference is USDG \(2 for this expiry so far\)/);
    assert.match(f[0].message, /settlement-floor protection, not a loss/);
    assert.deepEqual(inKindPayoutFindings(sink, "4", { tickerOf: () => "NVDA" }), [], "at or before the adopted block: no page");
    assert.equal(inKindPayoutFindings(sink, "3", { tickerOf: () => "NVDA" })[0].data.count, 1, "only the one after it");
  });

  test("snapshot_missed says 'settles on the other sources' only when one is known to price the window", () => {
    const missed = expiry({ now: E + 601, snapshotRecordedAt: 0, status: "Pending", candidate: cand(), chainlinkSource: CL });
    const text = (over) => checkExpiry({ ...missed, ...over }, t)[0];
    const ok = text({ chainlinkWindowOk: true });
    assert.equal(ok.data.otherSourcePrices, true);
    assert.match(ok.message, /settles on the other sources alone, after the market's delay/);
    for (const dead of [{ chainlinkWindowOk: false }, { okCount: 0 }, { sources: [UNI] }]) {
      const f = text(dead);
      assert.equal(f.data.otherSourcePrices, false, JSON.stringify(dead));
      assert.match(f.message, /no source prices this expiry\. The GUARDIAN must veto it before it finalizes \(v2_mon_guardian_veto_due, ops\/alerts\.md §V68\)/);
      assert.doesNotMatch(f.message, /settles on the other sources/);
    }
    const unread = text({ chainlinkWindowOk: null });
    assert.equal(unread.data.otherSourcePrices, null);
    assert.match(unread.message, /was not read/);
    assert.doesNotMatch(unread.message, /settles on the other sources alone, after/);
    assert.equal(text({ chainlinkWindowOk: null, okCount: 1 }).data.otherSourcePrices, true, "a capture recorded an ok source that was not the pool");
  });

  test("snapshot_missed and the guardian page agree on every input", () => {
    const base = { launch: true, outages: [], now: E + 601, snapshotRecordedAt: 0, status: "Pending", candidate: cand(), chainlinkSource: CL };
    for (const over of [{ chainlinkWindowOk: true }, { chainlinkWindowOk: false }, { chainlinkWindowOk: null }, { okCount: 0 }, { sources: [UNI] }, { okCount: 2 }]) {
      const x = { ...expiry(base), ...base, ...over };
      const snap = checkExpiry(x, t).find((f) => f.kind === "v2_mon_snapshot_missed");
      const veto = checkGuardianVeto(x).find((f) => f.kind === "v2_mon_guardian_veto_due");
      assert.equal(snap.data.otherSourcePrices === false, veto.data.reason === "no-source-prices", JSON.stringify(over));
      assert.equal(otherSourcePrices(x), snap.data.otherSourcePrices);
    }
  });

  test("pool_liquidity_low says expiries settle on Chainlink alone only when Chainlink's latest price is ok", () => {
    const thin = { ticker: "NVDA", pool: UNI, liquidity: 9n, floor: 10n, sourceFloor: 10n };
    const ok = checkPool({ ...thin, chainlinkOk: true })[0];
    assert.match(ok.message, /so expiries settle on Chainlink alone after the delay and converted payouts may fall back to in kind$/);
    const dead = checkPool({ ...thin, chainlinkOk: false })[0];
    assert.equal(dead.data.chainlinkOk, false);
    assert.match(dead.message, /Chainlink's latest NVDA price is not ok either: an expiry whose window closes now has no source to settle on, and the GUARDIAN must veto it before it finalizes \(v2_mon_guardian_veto_due, ops\/alerts\.md §V68\)/);
    assert.doesNotMatch(dead.message, /settle on Chainlink alone after the delay/);
    const unread = checkPool(thin)[0];
    assert.equal(unread.data.chainlinkOk, null);
    assert.match(unread.message, /only if its feed is ok \(not read: check ChainlinkFeedSource\.latest\)/);
  });
});

/*
 * An EarnVault venue pull starved of gas reverts instead of
 * succeeding with 0 moved, so a PulledFromVenue that delivered less than it asked for is the venue itself. The monitor
 * scans the EarnVault for that one event and pages it; nothing else of the EarnVault's is decoded or paged.
 */
describe("Short EarnVault venue pulls", () => {
  const EARN = "0xf7d21652473014d1Ca0e22FF75420494cdd09164";
  const CH = "0x2256c045245288A314048aD2d71006a564343C63";
  const addresses = { clearinghouse: CH, earnVault: EARN };
  const pulled = (requested, withdrawn, block, logIndex = 0) => ({
    eventName: "PulledFromVenue", address: EARN, args: { requested, withdrawn }, blockNumber: block, logIndex, transactionHash: `0x${"ab".repeat(32)}`,
  });

  test("a short pull is collected once; a full pull, another address, and a replayed overlap are not", () => {
    const scan = emptyState(4663, "x").scan;
    const sink = [];
    const config = applyScanLogs(scan, [
      pulled(1_000_000n, 1_000_000n, 1n, 0),
      pulled(1_000_000n, 0n, 2n, 0),
      pulled(5_000_000n, 3_000_000n, 3n, 0),
      { ...pulled(1_000_000n, 0n, 3n, 1), address: CH },
      // An EarnVault log that decodes as another contract's scanned admin event is dropped, not paged. (Its
      // AuthorityUpdated, the example here before, is paged now; see the EarnVault admin-log suite below.)
      { eventName: "BurnBpsSet", address: EARN, args: { burnBps: 5000 }, blockNumber: 3n, logIndex: 2 },
    ], addresses, null, sink);
    assert.deepEqual(sink.map((l) => `${l.blockNumber}:${l.args.withdrawn}`), ["2:0", "3:3000000"]);
    assert.deepEqual(config, [], "an EarnVault log outside EARN_VAULT_EVENTS is not a config event here");
    const again = [];
    applyScanLogs(scan, [pulled(5_000_000n, 3_000_000n, 3n, 0), pulled(2_000_000n, 1n, 4n, 0)], addresses, null, again);
    assert.deepEqual(again.map((l) => `${l.blockNumber}:${l.args.withdrawn}`), ["4:1"], "the overlap re-read block 3");
  });

  test("each short pull is one event; nothing out while the venue can pay it all is an error", () => {
    const logs = [pulled(1_000_000n, 0n, 7n), pulled(5_000_000n, 3_000_000n, 8n)];
    const warm = earnPullFindings(logs, null, { vault: EARN, withdrawableNow: 2_000_000n });
    assert.deepEqual(kinds(warm), ["v2_mon_earn_pull_short/error", "v2_mon_earn_pull_short/warn"]);
    const zero = warm.find((f) => f.data.withdrawn === 0n);
    assert.equal(zero.event, true);
    assert.equal(zero.key, "7:0");
    assert.match(zero.message, /asked for 1\.00 USDG and got 0\.00\. Nothing came out of the venue: a pull starved of gas reverts since T-OP-642/);
    assert.match(zero.message, /The adapter can pay 2\.00 USDG now, at least what was asked: the venue has the cash/);
    const partial = warm.find((f) => f.data.withdrawn === 3_000_000n);
    assert.match(partial.message, /The venue paid less than asked/);
    assert.match(partial.message, /The adapter can pay 2\.00 USDG now: the venue is short of liquidity/);
    // The venue cannot pay it now, or nobody could read it: a warn either way.
    assert.deepEqual(kinds(earnPullFindings([logs[0]], null, { vault: EARN, withdrawableNow: 10n })), ["v2_mon_earn_pull_short/warn"]);
    const unread = earnPullFindings([logs[0]], null, { vault: EARN, withdrawableNow: null });
    assert.deepEqual(kinds(unread), ["v2_mon_earn_pull_short/warn"]);
    assert.match(unread[0].message, /could not be read/);
  });

  test("history before the first run is adopted; a full pull never pages", () => {
    const logs = [pulled(1_000_000n, 0n, 7n), pulled(1_000_000n, 1_000_000n, 9n)];
    assert.deepEqual(earnPullFindings([{ ...logs[0], eventName: "VenuePulledForFunding" }], null, { vault: EARN, withdrawableNow: 2_000_000n }), [], "a funding pull is not a starvation-guarded PulledFromVenue");
    assert.deepEqual(earnPullFindings(logs, "7", { vault: EARN, withdrawableNow: null }), []);
    assert.deepEqual(earnPullFindings(logs, "6", { vault: EARN, withdrawableNow: null }).length, 1);
  });

  test("RouteFeeRefreshed and OwedCredited page; SettlementPinConfirmed does not", () => {
    const router = "0x0000000000000000000000000000000000000a10";
    const book = "0x0000000000000000000000000000000000000b10";
    const oracle = "0x0000000000000000000000000000000000000c10";
    const log = (eventName, address, args) => ({
      eventName, address, args, blockNumber: 20n, logIndex: 1, transactionHash: `0x${"cd".repeat(32)}`,
    });
    const names = { [router]: "PayoutRouter", [book]: "OrderBook", [oracle]: "SettlementOracle" };
    const pages = configEventFindings([
      log("RouteFeeRefreshed", router, { asset: EARN, previousFeeBps: 1, feeBps: 30 }),
      log("OwedCredited", book, { account: EARN, amount: 1_500_000n }),
      log("SettlementPinConfirmed", oracle, { underlying: EARN, expiry: 1, previousPinner: book, pinner: oracle }),
    ], null, names);
    assert.deepEqual(pages.map((f) => f.data.event), ["RouteFeeRefreshed", "OwedCredited"]);
    assert.match(pages[0].message, /1 bps to 30 bps/);
    assert.match(pages[1].message, /1\.50 USDG/);
  });

  test("the registry's EarnVault is parsed, and a registry without one watches nothing", () => {
    const tier1 = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "markets", "tier1.json"), "utf8"));
    assert.equal(parseRegistry(tier1).earnVault, tier1.v2.contracts.earnVault);
    const none = structuredClone(tier1);
    delete none.v2.contracts.earnVault;
    assert.equal(parseRegistry(none).earnVault, null);
  });
});

/*
 * EarnVault.setAdapter, unable to read a venue, writes the venue's last known value off totalAssets (the
 * venue is replaced, or stays wired when the same adapter is set again), announced by VenueWrittenOff(adapter,
 * lastKnown). That is a realised loss to every depositor: one error page per log, raised by the scan in the chunk that
 * consumed it, so neither a failed log read, a failure later in the scan, nor a later check failing can drop it.
 */
describe("An EarnVault venue write-off pages the operator", () => {
  const EARN = "0xf7d21652473014d1Ca0e22FF75420494cdd09164";
  const OLD = addr(0xad0a1);
  const CH = "0x2256c045245288A314048aD2d71006a564343C63";
  const TX = `0x${"cd".repeat(32)}`;
  const WRITE_OFF = "event VenueWrittenOff(address indexed adapter, uint256 lastKnown)";
  const writtenOff = (lastKnown, block, logIndex = 0) => ({
    eventName: "VenueWrittenOff", address: EARN, args: { adapter: OLD, lastKnown }, blockNumber: block, logIndex, transactionHash: TX,
  });
  const pages = (report) => report.findings.filter((f) => f.kind === "v2_mon_earn_venue_written_off");
  const dirs = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  /** A deployed registry that names the EarnVault, and a first pass that adopts history up to block 20,000. */
  const adopted = async (extra = []) => {
    const dir = tmp("monitor-writeoff-");
    dirs.push(dir);
    const registry = writeRegistry(dir, { deployBlock: 1000 });
    const reg = JSON.parse(readFileSync(registry, "utf8"));
    reg.v2.contracts.earnVault = EARN;
    writeFileSync(registry, JSON.stringify(reg));
    const chain = new FakeChain({ head: 20_000n });
    const opts = options(dir, registry, extra);
    await runOnce(opts, onChain(chain));
    const state = () => JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8"));
    assert.equal(state().scan.adoptConfigUntil, "20000");
    return { chain, opts, state };
  };

  test("each write-off is one error event naming the vault, the old adapter and the amount; a zero one too; history before the first run is adopted", () => {
    const found = earnWriteOffFindings([writtenOff(12_345_678n, 7n), writtenOff(0n, 8n, 3), { ...writtenOff(1n, 9n), eventName: "AdapterSet" }], null, { vault: EARN });
    assert.deepEqual(kinds(found), ["v2_mon_earn_venue_written_off/error", "v2_mon_earn_venue_written_off/error"]);
    assert.equal(found[0].event, true);
    assert.deepEqual(found.map((f) => f.key), ["7:0", "8:3"]);
    assert.match(found[0].message, new RegExp(`^EarnVault ${EARN}: setAdapter wrote off venue ${OLD} at block 7 \\(tx ${TX}\\)`));
    assert.match(found[0].message, /Its last known value, 12\.34 USDG \(12345678 base units\), left totalAssets/);
    assert.match(found[0].message, /so the vault's total value fell by that amount and each share's value in proportion\. Find out whether the venue still holds the money, which adapter is wired now/);
    assert.deepEqual(found[0].data, { vault: EARN, adapter: OLD, lastKnown: 12_345_678n, block: 7n, tx: TX });
    assert.match(found[1].message, /0\.00 USDG \(0 base units\), left totalAssets .*last known value for the venue was already 0/);
    assert.deepEqual(earnWriteOffFindings([writtenOff(5n, 7n)], "7", { vault: EARN }), [], "at the adoption block: adopted");
    assert.equal(earnWriteOffFindings([writtenOff(5n, 8n)], "7", { vault: EARN }).length, 1, "past it: paged");
  });

  test("the scan keeps the EarnVault's write-offs once, whatever the amount; another contract's log of that name is not the vault's", () => {
    const scan = emptyState(4663, "x").scan;
    const addresses = { clearinghouse: CH, earnVault: EARN };
    const sink = [];
    applyScanLogs(scan, [writtenOff(1_000_000n, 2n), writtenOff(0n, 3n), { ...writtenOff(9n, 3n, 1), address: CH }], addresses, null, sink);
    assert.deepEqual(sink.map((l) => `${l.blockNumber}:${l.args.lastKnown}`), ["2:1000000", "3:0"]);
    const again = [];
    applyScanLogs(scan, [writtenOff(0n, 3n), writtenOff(7n, 4n)], addresses, null, again);
    assert.deepEqual(again.map((l) => `${l.blockNumber}:${l.args.lastKnown}`), ["4:7"], "the overlap re-read block 3");
  });

  test("a pass pages the write-off, from the scan, at error", async () => {
    const { chain, opts } = await adopted();
    chain.logs.push(rawLog(WRITE_OFF, { adapter: OLD, lastKnown: 2_500_000n }, { address: EARN, blockNumber: 20_050 }));
    chain.setHead(20_100n, chain.head.timestamp + 60);
    const r = await runOnce(opts, onChain(chain));
    const page = pages(r);
    assert.equal(page.length, 1, `one write-off page: ${JSON.stringify(kindsOf(r))}`);
    assert.equal(page[0].severity, "error");
    assert.equal(page[0].event, true);
    assert.match(page[0].message, new RegExp(`wrote off venue ${OLD} at block 20050`, "i"));
    assert.match(page[0].message, /2\.50 USDG \(2500000 base units\)/);
  });

  test("a failed log read pages nothing and keeps the cursor before the write-off; the next pass pages it", async () => {
    const { chain, opts, state } = await adopted();
    chain.logs.push(rawLog(WRITE_OFF, { adapter: OLD, lastKnown: 2_500_000n }, { address: EARN, blockNumber: 20_050 }));
    chain.setHead(20_100n, chain.head.timestamp + 60);
    chain.getLogsHook = ({ from, to, event }) => {
      if (event === undefined && from <= 20_050n && to >= 20_050n) throw transportError();
    };
    const failed = await runOnce(opts, onChain(chain));
    assert.equal(failed.checks.scan.status, "failed");
    assert.deepEqual(pages(failed), [], "nothing was read, so nothing is judged");
    assert.ok(BigInt(state().scan.cursor) < 20_050n, `the cursor did not move past the unread write-off: ${state().scan.cursor}`);
    chain.getLogsHook = null;
    chain.setHead(20_200n, chain.head.timestamp + 60);
    const next = await runOnce(opts, onChain(chain));
    assert.equal(pages(next).length, 1, `the next pass pages the write-off the failed read left: ${JSON.stringify(kindsOf(next))}`);
  });

  test("a scan that fails after the write-off's chunk still pages it: the page is raised with the chunk, not after the scan", async () => {
    const { chain, opts, state } = await adopted(["--threshold", "logChunkBlocks=100"]);
    chain.logs.push(rawLog(WRITE_OFF, { adapter: OLD, lastKnown: 7_000_000n }, { address: EARN, blockNumber: 20_050 }));
    chain.setHead(20_300n, chain.head.timestamp + 60);
    // The pass reads 19,996-20,095 (the write-off), then every later range fails.
    chain.getLogsHook = ({ from, event }) => {
      if (event === undefined && from > 20_095n) throw transportError();
    };
    const r = await runOnce(opts, onChain(chain));
    assert.equal(r.checks.scan.status, "failed");
    assert.equal(state().scan.cursor, "20095", "the cursor moved past the write-off's chunk");
    const page = pages(r);
    assert.equal(page.length, 1, `the consumed write-off pages although the scan failed: ${JSON.stringify(kindsOf(r))}`);
    assert.match(page[0].message, /7\.00 USDG/);
  });

  test("a config check that fails later in the same pass cannot drop the write-off the scan consumed: the scan raised it", async () => {
    // The config check pages the other payoutLogs (earnPullFindings and friends) and runs after a failed
    // scan too, so the two tests above also pass with the raise moved there. Here the scan completes and consumes the
    // write-off, then config fails: its batched House pin read (housePinsForVouch, one Multicall3 call) meets a transport
    // error. A page raised by config would go with it (run() keeps what a check pushed to `out` before it threw, never
    // the list it had not yet returned); the scan's own page survives.
    const dir = tmp("monitor-writeoff-config-");
    dirs.push(dir);
    const registry = writeRegistry(dir, { deployBlock: 1000 });
    const reg = JSON.parse(readFileSync(registry, "utf8"));
    reg.v2.contracts.earnVault = EARN;
    reg.shared.multicall3 = addr(0x3ca11);
    writeFileSync(registry, JSON.stringify(reg));
    const chain = new FakeChain({ head: 20_000n });
    const opts = options(dir, registry, ["--house", `NVDA=${addr(0x40e5e)}`]);
    const deps = {
      ...onChain(chain),
      viem: { ...fakeViem(chain), createPublicClient: () => ({ ...chain.client(), multicall: async () => { throw transportError("multicall down"); } }) },
    };
    await runOnce(opts, deps);
    assert.equal(JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")).scan.adoptConfigUntil, "20000");
    chain.logs.push(rawLog(WRITE_OFF, { adapter: OLD, lastKnown: 3_000_000n }, { address: EARN, blockNumber: 20_050 }));
    chain.setHead(20_100n, chain.head.timestamp + 60);
    const r = await runOnce(opts, deps);
    assert.equal(r.checks.scan.status, "ok", `the scan read and consumed the write-off: ${r.checks.scan.detail}`);
    assert.equal(r.checks.config.status, "failed", `config must fail in this pass, or this test proves nothing: ${r.checks.config.detail}`);
    assert.match(r.checks.config.detail, /multicall down/);
    const page = pages(r);
    assert.equal(page.length, 1, `the write-off pages although config failed after the scan: ${JSON.stringify(kindsOf(r))}`);
    assert.match(page[0].message, /3\.00 USDG \(3000000 base units\)/);
  });
});

describe("A Skimmed gain with no fee is not nothing owed", () => {
  const EARN = "0xf7d21652473014d1Ca0e22FF75420494cdd09164";
  const skimmed = (gain, fee, block, logIndex = 0) => ({
    eventName: "Skimmed", address: EARN, args: { gain, fee, highWaterMark: 1_000_000n },
    blockNumber: block, logIndex, transactionHash: `0x${"cd".repeat(32)}`,
  });

  test("only a positive gain with a zero fee is collected, and it pages once", () => {
    const scan = emptyState(4663, "x").scan;
    const sink = [];
    applyScanLogs(scan, [
      skimmed(0n, 0n, 1n, 0),
      skimmed(1_000n, 100n, 2n, 0),
      skimmed(5_000_000n, 0n, 3n, 1),
    ], { earnVault: EARN }, null, sink);
    assert.deepEqual(sink.map((l) => l.eventName), ["Skimmed"]);
    assert.equal(sink[0].args.gain, 5_000_000n);
    const pages = earnSkimRefusedFindings(sink, null, { vault: EARN });
    assert.deepEqual(kinds(pages), ["v2_mon_earn_skim_refused/warn"]);
    assert.equal(pages[0].event, true);
    assert.match(pages[0].message, /took no fee/);
    assert.deepEqual(earnSkimRefusedFindings(sink, "3", { vault: EARN }), [], "history before the first run is adopted");
  });

  // The test above hands decoded logs to applyScanLogs and earnSkimRefusedFindings directly, so it stays
  // green with the Skimmed fragment gone from SCAN_EVENTS or the finder gone from runOnce. This one sends raw logs
  // through a whole pass: either deletion leaves the second run with no page.
  test("whole pass: a raw Skimmed(gain, 0, mark) from the EarnVault after the first run pages once; a skim that took a fee, or saw no gain, does not", async () => {
    const dir = tmp("monitor-779-");
    try {
      const registry = writeRegistry(dir, { markets: [market("NVDA", 1)], deployBlock: 1000 });
      const reg = JSON.parse(readFileSync(registry, "utf8"));
      reg.v2.contracts.earnVault = EARN;
      writeFileSync(registry, JSON.stringify(reg));
      const chain = new FakeChain({ head: 20_000n });
      chain.read = (address, fn, args) => {
        if (address.toLowerCase() === EARN.toLowerCase() && fn === "fundingEnabled") return false;
        if (address.toLowerCase() === C.orderBook.toLowerCase() && fn === "fundingOf") return [false, false];
        return defaultRead(chain, address, fn, args);
      };
      const opts = options(dir, registry);
      const first = await runOnce(opts, onChain(chain));
      assert.ok(!first.findings.some((x) => x.kind === "v2_mon_earn_skim_refused"), JSON.stringify(kindsOf(first)));
      const SKIMMED = "event Skimmed(uint256 gain, uint256 fee, uint256 highWaterMark)";
      chain.logs.push(rawLog(SKIMMED, { gain: 5_000_000n, fee: 0n, highWaterMark: 1_000_000n }, { address: EARN, blockNumber: 20_050 }));
      chain.logs.push(rawLog(SKIMMED, { gain: 1_000n, fee: 100n, highWaterMark: 1_000_100n }, { address: EARN, blockNumber: 20_060 }));
      chain.logs.push(rawLog(SKIMMED, { gain: 0n, fee: 0n, highWaterMark: 1_000_100n }, { address: EARN, blockNumber: 20_070 }));
      chain.setHead(20_100n, chain.head.timestamp + 120);
      const second = await runOnce(opts, onChain(chain));
      const pages = second.findings.filter((x) => x.kind === "v2_mon_earn_skim_refused");
      assert.equal(pages.length, 1, JSON.stringify(kindsOf(second)));
      assert.equal(pages[0].severity, "warn");
      assert.match(pages[0].message, /Skimmed at block 20050 .*took no fee/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The processQueue that drains the queue runs the same skim, and reaches it with a rate
  // lowered to 0 while the queue was open, or with a fee re-measured after the mints to under one unit. Both emit
  // gain > 0, fee == 0 and move the mark: nothing is owed. The rate in force at the log decides; unknown still pages.
  const rate = (bps, block, logIndex = 0) => ({
    eventName: "SkimBpsSet", address: EARN, args: { bps }, blockNumber: block, logIndex, transactionHash: `0x${"ce".repeat(32)}`,
  });

  test("A zero-fee gain pages only when a fee was due at the rate in force at the log", () => {
    const scan = emptyState(4663, "x").scan;
    const sink = [];
    applyScanLogs(scan, [
      skimmed(9n, 0n, 1n), // no SkimBpsSet scanned yet: the rate is unknown
      rate(1000, 2n),
      skimmed(9n, 0n, 3n), // 9 * 1000 / 10000 = 0: under one unit, the mark moved
      skimmed(10n, 0n, 4n), // 10 * 1000 / 10000 = 1: a fee was due and did not leave
      rate(0, 5n),
      skimmed(5_000_000n, 0n, 6n), // zero rate: the mark moved
    ], { earnVault: EARN }, null, sink);
    assert.deepEqual(sink.map((l) => l.skimBps), [null, 1000, 1000, 0], "each collected log carries the rate in force at it");
    assert.deepEqual(scan.earnSkimBps, { [EARN.toLowerCase()]: 0 }, "tracked per vault");
    // A vault the registry replaced: its rate is not this one's.
    const other = [];
    applyScanLogs({ ...emptyState(4663, "x").scan, earnSkimBps: { "0x00000000000000000000000000000000000e0001": 1000 } },
      [skimmed(9n, 0n, 7n)], { earnVault: EARN }, null, other);
    assert.deepEqual(other.map((l) => l.skimBps), [null]);
    const pages = earnSkimRefusedFindings(sink, null, { vault: EARN });
    assert.deepEqual(pages.map((x) => x.key), ["1:0", "4:0"], "the unknown rate fails closed; the one-unit fee is owed");
    assert.equal(pages[1].data.skimBps, 1000);
    // The head's rate (given by runOnce only while no SkimBpsSet was ever scanned) judges a log with no rate of its own.
    assert.deepEqual(earnSkimRefusedFindings([sink[0]], null, { vault: EARN, skimBpsNow: 1000 }), []);
    assert.equal(earnSkimRefusedFindings([{ ...sink[0], args: { ...sink[0].args, gain: 20_000n } }], null, { vault: EARN, skimBpsNow: 1 }).length, 1);
    // A rate of its own wins over the head's.
    assert.equal(earnSkimRefusedFindings([sink[2]], null, { vault: EARN, skimBpsNow: 0 }).length, 1, "its own 1000 bps, not the head's 0");
    assert.equal(earnSkimRefusedFindings([sink[3]], null, { vault: EARN, skimBpsNow: 1000 }).length, 0, "its own 0 bps, not the head's 1000");
  });

  test("Whole pass: at the head's rate a dust drain skim does not page and a due one does; after a scanned rate change the head is not trusted", async () => {
    const dir = tmp("monitor-950-");
    try {
      const registry = writeRegistry(dir, { markets: [market("NVDA", 1)], deployBlock: 1000 });
      const reg = JSON.parse(readFileSync(registry, "utf8"));
      reg.v2.contracts.earnVault = EARN;
      writeFileSync(registry, JSON.stringify(reg));
      const chain = new FakeChain({ head: 20_000n });
      let rateReads = 0;
      chain.read = (address, fn, args) => {
        if (address.toLowerCase() === EARN.toLowerCase() && fn === "fundingEnabled") return false;
        if (address.toLowerCase() === EARN.toLowerCase() && fn === "skimBps") {
          rateReads += 1;
          return 1000;
        }
        if (address.toLowerCase() === C.orderBook.toLowerCase() && fn === "fundingOf") return [false, false];
        return defaultRead(chain, address, fn, args);
      };
      const opts = options(dir, registry);
      await runOnce(opts, onChain(chain));
      const SKIMMED = "event Skimmed(uint256 gain, uint256 fee, uint256 highWaterMark)";
      chain.logs.push(rawLog(SKIMMED, { gain: 9n, fee: 0n, highWaterMark: 1_000_001n }, { address: EARN, blockNumber: 20_050 }));
      chain.logs.push(rawLog(SKIMMED, { gain: 5_000_000n, fee: 0n, highWaterMark: 1_000_001n }, { address: EARN, blockNumber: 20_060 }));
      chain.setHead(20_100n, chain.head.timestamp + 120);
      const second = await runOnce(opts, onChain(chain));
      const pages = second.findings.filter((x) => x.kind === "v2_mon_earn_skim_refused");
      const blockOf = (x) => x.message.match(/Skimmed at block (\d+)/)?.[1];
      assert.deepEqual(pages.map(blockOf), ["20060"], JSON.stringify(kindsOf(second)));
      assert.equal(rateReads, 1, "the head's skimBps() is read once, and only because a zero-fee gain needs it");
      // A SkimBpsSet scanned AFTER the zero-fee gain: the head's rate is not the rate at that log, so it pages.
      chain.logs.push(rawLog(SKIMMED, { gain: 9n, fee: 0n, highWaterMark: 1_000_002n }, { address: EARN, blockNumber: 20_150 }));
      chain.logs.push(rawLog("event SkimBpsSet(uint16 bps)", { bps: 1 }, { address: EARN, blockNumber: 20_160 }));
      chain.setHead(20_200n, chain.head.timestamp + 120);
      const third = await runOnce(opts, onChain(chain));
      const later = third.findings.filter((x) => x.kind === "v2_mon_earn_skim_refused");
      assert.deepEqual(later.map(blockOf), ["20150"], JSON.stringify(kindsOf(third)));
      assert.equal(rateReads, 1, "no head read once a SkimBpsSet has been scanned");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/*
 * The EarnVault's venue (setAdapter -> AdapterSet(address indexed adapter), EarnVault.sol:999-1041), skim rate
 * (setSkimBps -> SkimBpsSet(uint16 bps), :804-816) and AccessManager (AccessManager.updateAuthority -> the vault's
 * AccessManaged AuthorityUpdated(address authority)) page as v2_mon_config_changed, per callhouse-contracts.
 * Until the lock-down every lane is at delay 0, so these logs are the only record of the change, and the earlier
 * EarnVault filter dropped all three (AdapterSet and SkimBpsSet were not even decoded). The EarnVault has no pause: it
 * exports no PausedSet and no pause function.
 */
describe("EarnVault venue, skim and authority changes page", () => {
  const viem = loadViem();
  const EARN = "0xf7d21652473014d1Ca0e22FF75420494cdd09164";
  const earnEvent = (name) => abiJson("EarnVault").find((x) => x.type === "event" && x.name === name);
  /** An ABI event item as the signature string SCAN_EVENTS and rawLog use: built from the export, never typed here. */
  const signature = (e) => `event ${e.name}(${e.inputs.map((i) => `${typeOf(i)}${i.indexed ? " indexed" : ""} ${i.name}`).join(", ")})`;
  const WANT = { AdapterSet: "error", SkimBpsSet: "warn", AuthorityUpdated: "error" };
  const ARGS = { AdapterSet: { adapter: addr(0xad01) }, SkimBpsSet: { bps: 1000 }, AuthorityUpdated: { authority: addr(0xa11) } };
  /** One real EarnVault log, decoded through the scan's own ABI list, kept (or not) by applyScanLogs, and judged. */
  const pages = (name) => {
    const log = rawLog(signature(earnEvent(name)), ARGS[name], { address: EARN, blockNumber: 901 });
    const decoded = viem.parseEventLogs({ abi: viem.parseAbi(SCAN_EVENTS), logs: [log], strict: true });
    assert.equal(decoded.length, 1, `${name} decodes through SCAN_EVENTS`);
    const collected = applyScanLogs(emptyState(4663, "x").scan, decoded, { earnVault: EARN });
    return configEventFindings(collected, null, { [EARN.toLowerCase()]: "EarnVault" });
  };

  test("each is scanned with the exported EarnVault signature at its severity; the EarnVault exports no PausedSet", () => {
    const scanned = new Set(viem.parseAbi(SCAN_EVENTS).filter((x) => x.type === "event").map(signature));
    for (const [name, severity] of Object.entries(WANT)) {
      const e = earnEvent(name);
      assert.ok(e, `EarnVault.json exports ${name}`);
      assert.ok(scanned.has(signature(e)), `${signature(e)} is not in SCAN_EVENTS`);
      assert.equal(CONFIG_EVENTS[name], severity, name);
    }
    // The pause named beside them has no event to page. The day the EarnVault exports one, this fails: let it through
    // EARN_VAULT_EVENTS and give it a CONFIG_EVENTS severity.
    assert.equal(earnEvent("PausedSet"), undefined, "EarnVault.json exports PausedSet now: page it");
  });

  test("EarnVault AdapterSet pages at error", () => {
    const f = pages("AdapterSet");
    assert.deepEqual(kinds(f), ["v2_mon_config_changed/error"]);
    assert.match(f[0].message, /^EarnVault\.AdapterSet\(adapter="0x0+ad01"\) in block 901/i);
  });

  test("EarnVault SkimBpsSet pages at warn", () => {
    const f = pages("SkimBpsSet");
    assert.deepEqual(kinds(f), ["v2_mon_config_changed/warn"]);
    assert.match(f[0].message, /^EarnVault\.SkimBpsSet\(bps=1000\) in block 901/);
  });

  test("EarnVault AuthorityUpdated pages at error", () => {
    const f = pages("AuthorityUpdated");
    assert.deepEqual(kinds(f), ["v2_mon_config_changed/error"]);
    assert.match(f[0].message, /^EarnVault\.AuthorityUpdated\(authority="0x0+a11"\) in block 901/i);
  });

  test("the EarnVault filter no longer hides them: a whole pass pages each change after the first run", async () => {
    const dir = tmp("monitor-883-");
    try {
      const registry = writeRegistry(dir, { markets: [market("NVDA", 1)], deployBlock: 1000 });
      const reg = JSON.parse(readFileSync(registry, "utf8"));
      reg.v2.contracts.earnVault = EARN;
      writeFileSync(registry, JSON.stringify(reg));
      const chain = new FakeChain({ head: 20_000n });
      // The constructor's AuthorityUpdated, before the first run: adopted like every earlier admin event.
      chain.logs.push(rawLog(signature(earnEvent("AuthorityUpdated")), { authority: addr(0xacce) }, { address: EARN, blockNumber: 1_500 }));
      const opts = options(dir, registry);
      const first = await runOnce(opts, onChain(chain));
      assert.equal(first.checks.scan.status, "ok", first.checks.scan.detail);
      assert.ok(!first.findings.some((x) => x.kind === "v2_mon_config_changed"), JSON.stringify(kindsOf(first)));
      chain.logs.push(rawLog(signature(earnEvent("AdapterSet")), ARGS.AdapterSet, { address: EARN, blockNumber: 20_050 }));
      chain.logs.push(rawLog(signature(earnEvent("SkimBpsSet")), ARGS.SkimBpsSet, { address: EARN, blockNumber: 20_060 }));
      chain.logs.push(rawLog(signature(earnEvent("AuthorityUpdated")), ARGS.AuthorityUpdated, { address: EARN, blockNumber: 20_070 }));
      chain.setHead(20_100n, chain.head.timestamp + 120);
      const second = await runOnce(opts, onChain(chain));
      // The run names the EarnVault by its address (contractNames has no entry for it): "<address>.<event>(<args>) ...".
      const paged = second.findings.filter((x) => x.kind === "v2_mon_config_changed");
      const byEvent = Object.fromEntries(paged.map((x) => [x.message.match(new RegExp(`^${EARN}\\.(\\w+)\\(`, "i"))?.[1], x.severity]));
      assert.deepEqual(byEvent, WANT, paged.map((x) => x.message).join(" | "));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/*
 * Pins for alert conditions that restate a contract rule and MATCH it, but had no direct test. Each cites the
 * rule in callhouse-contracts.
 */
describe("MATCH conditions pinned to the contract rule they copy", () => {
  // Clearinghouse._redeem reverts NotSettled on an unsettled series (Clearinghouse.sol:1104); settle is permissionless.
  test("series_unsettled: a held unsettled series of a finalized expiry pages from settleGraceS after expiry, not before", () => {
    const E = 1_800_000_000;
    const x = { ticker: "NVDA", underlying: U, oracle: U, expiry: E, now: E + t.settleGraceS, openInterest: 5n, unsettled: ["42"], seriesCount: 3 };
    const f = checkUnsettledSeries(x, t);
    assert.deepEqual(kinds(f), ["v2_mon_series_unsettled/error"]);
    assert.match(f[0].message, /every redeem of those series reverts NotSettled until someone calls settle\(longId\)/);
    assert.deepEqual(checkUnsettledSeries({ ...x, now: E + t.settleGraceS - 1 }, t), []);
    assert.deepEqual(checkUnsettledSeries({ ...x, unsettled: [] }, t), []);
    assert.deepEqual(checkUnsettledSeries({ ...x, openInterest: 0n }, t), []);
  });

  // UniV3TwapSource.setPool (UniV3TwapSource.sol:195-220): the pool a pinned expiry takes and its harmonic-mean floor.
  test("pool_wiring: the source's pool must be the registry's, and its floor must not be below the registry's", () => {
    const x = { ticker: "NVDA", underlying: U, source: U, registryPool: "0x00000000000000000000000000000000000000a1", registryFloor: 10n, sourcePool: "0x00000000000000000000000000000000000000A1", sourceFloor: 10n };
    assert.deepEqual(checkPoolWiring(x), [], "same pool (any case), same floor");
    assert.deepEqual(checkPoolWiring({ ...x, sourceFloor: 11n }), [], "a higher source floor is stricter, not a wiring fault");
    const moved = checkPoolWiring({ ...x, sourcePool: "0x00000000000000000000000000000000000000b2" });
    assert.deepEqual(kinds(moved), ["v2_mon_pool_wiring/error"]);
    assert.match(moved[0].key, /:pool$/);
    const low = checkPoolWiring({ ...x, sourceFloor: 9n });
    assert.deepEqual(kinds(low), ["v2_mon_pool_wiring/error"]);
    assert.match(low[0].key, /:floor$/);
    assert.deepEqual(checkPoolWiring({ ...x, sourcePool: null }), [], "no pool on the source is noted by the caller, not judged here");
  });

  // V2Errors.sol:13, :65, :74, :78. Re-derived from the error signatures, never typed from a document.
  test("PIN_REVERTS: every selector is its V2Errors signature's", () => {
    const viem = loadViem();
    const sigs = { NotAuthorized: "NotAuthorized()", NoSource: "NoSource()", PinMismatch: "PinMismatch()", SourceNotPinned: "SourceNotPinned(address,bytes4)" };
    const derived = Object.fromEntries(Object.entries(sigs).map(([name, sig]) => [viem.toFunctionSelector(sig), name]));
    assert.deepEqual(PIN_REVERTS, derived);
  });

  // V2Errors.sol:65, :71; V4BuybackExecutor._feeBps reverts exactly these.
  test("EXECUTOR_FEE_REFUSALS: NoSource and CeilingExceeded, each its V2Errors signature's selector", () => {
    const viem = loadViem();
    assert.deepEqual(EXECUTOR_FEE_REFUSALS, { [viem.toFunctionSelector("NoSource()")]: "NoSource", [viem.toFunctionSelector("CeilingExceeded()")]: "CeilingExceeded" });
  });
});

/*
 * The witness, the pool's window liquidity and the market's spotMaxAge / maxStale, WIRED
 * through a whole pass on the in-memory chain: each test fails when runOnce stops reading the value or stops handing it
 * to the pure check (checkRollerAsk, checkPool, checkFeedStale have their own tests above).
 */
describe("The new reads are wired through a whole pass", () => {
  const dirs = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const scratch = (prefix) => {
    const d = tmp(prefix);
    dirs.push(d);
    return d;
  };
  const revert = () => {
    const e = new Error("execution reverted");
    e.name = "ContractFunctionRevertedError";
    return e;
  };
  const ROLLED = "event Rolled(address indexed writer, address indexed underlying, uint256 longId, uint256 orderId, uint128 strike, uint40 expiry, uint128 price, uint64 units)";

  test("roller: an ask the pool witness shows past its strike pages while spot is not ok (AutoRoller._tryWitness)", async () => {
    const now = 1_790_000_000;
    const U2 = addr(0xa001);
    const W = addr(0xf);
    const expiry = now + 3 * 86_400;
    const overtakenPages = async (witness) => {
      const dir = scratch("monitor-796-witness-");
      const registry = writeRegistry(dir, { markets: [market("NVDA", 1)], deployBlock: 1000 });
      const chain = new FakeChain({ head: 20_000n, timestamp: now });
      chain.logs.push(rawLog(ROLLED, { writer: W, underlying: U2, longId: 84n, orderId: 7n, strike: 200_000_000n, expiry, price: 5n, units: 500n }, { address: C.autoRoller, blockNumber: 5000 }));
      chain.read = (address, fn, args) => {
        const a = address.toLowerCase();
        if (fn === "position") return [84n, 7n, expiry];
        if (fn === "getOrders") return args[0].map(() => ({ maker: W, longId: 84n, kind: 2, price: 5n, units: 500n, filled: 0n, validUntil: expiry, cancelled: false }));
        if (fn === "series") return { underlying: U2, isPut: false, expiry: BigInt(expiry), strike: 200_000_000n, oracle: C.settlementOracle, exerciseFeeBps: 30, settled: false, settlementPrice: 0n, longPayoutPerUnit: 0n, feePerUnit: 0n, shortPayoutPerUnit: 0n, mintFeePpm: 80, mintFeesHeld: 0n };
        if (fn === "trySpot") return [false, 0n, 0n]; // Chainlink silent: spot is not ok
        if (a === C.settlementOracle.toLowerCase() && fn === "settlementConfig" && Number(args[1]) === expiry) return [true, [SRC.chainlink, SRC.univ3], 150, 21600, 3600];
        const w = witness(a, fn, chain);
        return w !== undefined ? w : defaultRead(chain, address, fn, args);
      };
      const opts = options(dir, registry);
      await runOnce(opts, onChain(chain)); // the clock starts
      chain.setHead(20_100n, now + 120);
      const r = await runOnce(opts, onChain(chain));
      return r.findings.find((x) => x.kind === "v2_mon_roller_ask_overtaken") ?? null;
    };
    const pool = (price) => (a, fn, chain) => (a === SRC.univ3.toLowerCase() && fn === "latest" ? [true, price, BigInt(chain.head.timestamp)] : undefined);
    const f = await overtakenPages(pool(210_000_000n));
    assert.ok(f, "the witness path pages");
    assert.match(f.message, /the expiry's witness \(source 1, the pool TWAP\) 210\.00 .*while spot is not ok/);
    assert.equal(await overtakenPages(pool(199_000_000n)), null, "a witness short of the strike");
    // The issuer's oraclePaused() reverting counts as paused, as _tryWitness counts it.
    const pausedReverts = (a, fn, chain) => {
      if (fn === "oraclePaused") throw revert();
      return pool(210_000_000n)(a, fn, chain);
    };
    assert.equal(await overtakenPages(pausedReverts), null, "a reverting oraclePaused() is paused");
  });

  test("pools: the window's harmonic-mean liquidity under the floor pages while the head is deep; its window ends at the head", async () => {
    const POOL = addr(0x9001);
    let asked = null;
    const pass = async (observe) => {
      const dir = scratch("monitor-796-pool-");
      const registry = writeRegistry(dir, { markets: [market("NVDA", 1, { pool: POOL, floor: "1000" })], deployBlock: 1000 });
      const chain = new FakeChain({ head: 20_000n });
      chain.read = (address, fn, args) => {
        const a = address.toLowerCase();
        if (a === SRC.univ3.toLowerCase() && fn === "pools") return [POOL, false, 18, 300, 1000n];
        if (a === SRC.univ3.toLowerCase() && fn === "observeWindow") {
          asked = { args, head: chain.head.timestamp };
          return observe();
        }
        if (a === POOL.toLowerCase() && fn === "liquidity") return 10n ** 20n;
        return defaultRead(chain, address, fn, args);
      };
      return runOnce(options(dir, registry), onChain(chain));
    };
    const low = (r) => r.findings.filter((x) => x.kind === "v2_mon_pool_liquidity_low");
    const thin = await pass(() => [false, 0n, 0, 5n]);
    assert.equal(low(thin).length, 1, JSON.stringify(kindsOf(thin)));
    assert.match(low(thin)[0].message, /harmonic-mean in-range liquidity over the last 30 min \(what record\(\) gates a window closing now on\) 5, while the head has 100000000000000000000/);
    assert.match(thin.checks.pools.detail, /NVDA 0% of floor \(window mean\)/, "the detail reports the judged figure, not the head's");
    assert.equal(Number(asked.args[2]), asked.head, "the window ends at the head");
    assert.equal(Number(asked.args[2]) - Number(asked.args[1]), 1800, "and spans the settlement window");
    assert.deepEqual(low(await pass(() => [true, 1n, 0, 10n ** 20n])), [], "deep over the window and at the head");
    // No answer from the pool (all zero): the head alone, and a note that says so.
    const silent = await pass(() => [false, 0n, 0, 0n]);
    assert.deepEqual(low(silent), []);
    assert.ok(silent.notes.some((n) => /observeWindow over the last 30 min got no answer from the pool/.test(n)), JSON.stringify(silent.notes));
  });

  test("feeds: the stale page quotes the market's own spotMaxAge and maxStale from the registry", async () => {
    const E = Date.UTC(2026, 8, 21, 20) / 1000; // Monday 2026-09-21, 16:00 New York
    const dir = scratch("monitor-796-feed-");
    const NV = market("NVDA", 1); // no pool: single-source
    const registry = writeRegistry(dir, { markets: [NV], defaults: { spotMaxAgeS: 7200, chainlinkMaxStaleS: 100_800 } });
    const chain = new FakeChain({ timestamp: E + 216_000 });
    chain.read = (address, fn, args) =>
      address.toLowerCase() === NV.feed.toLowerCase() && fn === "latestRoundData" ? [1n, 100_00000000n, 0n, BigInt(E), 1n] : defaultRead(chain, address, fn, args);
    const r = await runOnce(options(dir, registry), onChain(chain));
    const f = r.findings.find((x) => x.kind === "v2_mon_feed_stale");
    assert.ok(f, JSON.stringify(kindsOf(r)));
    assert.match(f.message, /spot\(\) reverts StaleSpot once the round is 2 h old \(its spotMaxAge\)/);
    assert.match(f.message, /Settlement windows ending more than 28 h \(the feed's maxStale\) after that round/);
  });
});

/*
 * Earn just-in-time funding stays OFF until the quoteTake fix lands. The
 * switches are EarnVault.setFundingEnabled -> FundingEnabledSet(bool on), OrderBook.setFundingAllowed
 * -> FundingAllowedSet(maker, allowed) and OrderBook.setFunding -> FundingSet(maker, on)
 * in callhouse-contracts. Any of them true pages at error.
 */
describe("Earn just-in-time funding turned on pages", () => {
  const EARN = addr(0xea01);
  const MAKER = addr(0x3a4e);
  const TX = `0x${"cd".repeat(32)}`;
  const names = { [C.orderBook.toLowerCase()]: "orderBook" };
  const log = (eventName, args, { address = C.orderBook, block = 5000n, logIndex = 0 } = {}) => ({ eventName, address, args, blockNumber: block, logIndex, transactionHash: TX });
  const enabled = (on, o) => log("FundingEnabledSet", { on }, { address: EARN, ...o });
  const allowed = (v, o) => log("FundingAllowedSet", { maker: MAKER, allowed: v }, o);
  const switched = (on, o) => log("FundingSet", { maker: MAKER, on }, o);

  /*
   * The remedy is played against the contract's rules, callhouse-contracts
   * src/v2/OrderBook.sol: setFundingAllowed(maker, false) sets allowed = false AND on = false;
   * OrderBook.setFunding, which EarnVault.setBookFunding forwards to, reverts NotAuthorized unless allowed.
   * EarnVault.setFundingEnabled flips the vault's own flag only. A step is every call named in a
   * sentence that does not start "Do not", in the order written; a Safe batch runs them in that order and one revert
   * undoes all of them. Old text (revoke, then setFundingEnabled(false) and setBookFunding(false)) reverts here.
   */
  const remedySteps = (text) => {
    const flat = text.replace(/`/g, "").replace(/\s+/g, " ").trim();
    const sentences = flat.split(/(?<=\.)\s+(?=[A-Z])/);
    const steps = [];
    for (const sentence of sentences) {
      if (/^Do not\b/.test(sentence)) continue;
      for (const m of sentence.matchAll(/\b(setFundingAllowed|setBookFunding|setFundingEnabled|setFunding)\(([^)]*)\)/g)) steps.push({ fn: m[1], args: m[2] });
    }
    return { sentences, steps };
  };
  const playBatch = (steps) => {
    const st = { allowed: true, on: true, enabled: true };
    for (const { fn, args } of steps) {
      assert.match(args, /\bfalse\s*$/, `${fn}(${args}): a switch-off step must pass false`);
      if (fn === "setFundingAllowed") Object.assign(st, { allowed: false, on: false });
      else if (fn === "setBookFunding" || fn === "setFunding") {
        if (!st.allowed) return { reverted: `${fn}(false) after the revoke: OrderBook.setFunding reverts NotAuthorized (OrderBook.sol:686-687)` };
        st.on = false;
      } else if (fn === "setFundingEnabled") st.enabled = false;
    }
    return { reverted: null, st };
  };
  const checkRemedy = (label, text) => {
    const { sentences, steps } = remedySteps(text);
    assert.ok(steps.length >= 1, `${label}: no switch-off step found`);
    assert.equal(steps[0].fn, "setFundingAllowed", `${label}: the first step is the revoke`);
    assert.equal(remedySteps(sentences[0]).steps.length, 1, `${label}: the first sentence names ONE call`);
    const r = playBatch(steps);
    assert.equal(r.reverted, null, `${label}: as one Safe batch in the written order it reverts: ${r.reverted}`);
    assert.deepEqual([r.st.allowed, r.st.on], [false, false], `${label}: fundingOf(maker) must read (false, false) afterwards`);
    for (const x of sentences.filter((y) => /setBookFunding\(false\)/.test(y))) assert.match(x, /^Do not\b.*reverts/, `${label}: setBookFunding(false) is named only as the step not to add: ${x}`);
  };

  test("The switch-off remedy is ONE revoke, and as one Safe batch in its written order it cannot revert", () => {
    checkRemedy("JIT_FUNDING_REMEDY", JIT_FUNDING_REMEDY);
    assert.match(JIT_FUNDING_REMEDY, /by hand in the Safe web app from the Admin Safe, not with the repo's Safe tooling/, "owner ruling ~2:45 PM PT");
    const alerts = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "alerts.md"), "utf8");
    const v76 = alerts.slice(alerts.indexOf("\n### §V76 "));
    const para = v76.slice(v76.indexOf("→ Switch it off"), v76.indexOf("tell the owner.") + "tell the owner.".length);
    assert.ok(para.startsWith("→ Switch it off") && para.endsWith("tell the owner."), "alerts.md §V76 has its switch-off paragraph");
    checkRemedy("alerts.md §V76", para.replace(/^→ /, ""));
    assert.match(para.replace(/\s+/g, " "), /by hand in the Safe web app from the Admin Safe, not with the repo's Safe tooling/);
    // Control: the order this replaced reverts, so the checker can fail.
    const old = "Switch it off now: OrderBook.setFundingAllowed(maker, false) (CONFIG_ADMIN; it also clears the maker's own switch), and for the EarnVault setFundingEnabled(false) and setBookFunding(false) (CONFIG_ADMIN). Then find who sent the transaction";
    assert.match(String(playBatch(remedySteps(old).steps).reverted), /setBookFunding\(false\) after the revoke: OrderBook\.setFunding reverts NotAuthorized/);
    assert.throws(() => checkRemedy("old", old));
  });

  test("each switch turned ON pages v2_mon_jit_funding_on at error, naming the vault or maker, the tx and the rule it breaks", () => {
    const f = jitFundingEventFindings([enabled(true), allowed(true, { logIndex: 1 }), switched(true, { logIndex: 2 })], null, names);
    assert.deepEqual(kinds(f), ["v2_mon_jit_funding_on/error", "v2_mon_jit_funding_on/error", "v2_mon_jit_funding_on/error"]);
    assert.ok(f.every((x) => x.event === true && x.check === "funding"));
    assert.deepEqual(f.map((x) => x.key), [`${TX}:0`, `${TX}:1`, `${TX}:2`]);
    assert.match(f[0].message, new RegExp(`EarnVault ${EARN} switched its own just-in-time funding ON \\(FundingEnabledSet\\(true\\)\\) in block 5000, tx ${TX}`));
    assert.equal(f[0].data.maker, EARN);
    assert.match(f[1].message, new RegExp(`orderBook allow-listed maker ${MAKER} for just-in-time funding`));
    assert.match(f[2].message, new RegExp(`maker ${MAKER} switched its just-in-time funding ON at orderBook \\(FundingSet`));
    assert.equal(f[2].data.maker, MAKER);
    for (const x of f) {
      assert.match(x.message, /Owner order 2026-09-24 ~10:20 AM PT: Earn just-in-time funding stays OFF until the quoteTake fix/);
      assert.match(x.message, /setFundingAllowed\(maker, false\)/);
      assert.equal(x.data.transactionHash, TX);
    }
  });

  test("OFF pages no funding alert; FundingAllowedSet(false) keeps its config_changed warn, and its true is not paged twice", () => {
    assert.deepEqual(jitFundingEventFindings([enabled(false), allowed(false), switched(false)], null, names), []);
    assert.equal(fundingTurnedOn(enabled(false)), false);
    assert.equal(fundingTurnedOn(switched(true)), true);
    // configEventFindings gets every event not in OWN_KIND_EVENTS: the allow-list's false still pages there, its true does not.
    const cfg = [enabled(true), enabled(false), allowed(true), allowed(false, { logIndex: 3 }), switched(true), switched(false)].filter((e) => !OWN_KIND_EVENTS.has(e.eventName));
    const c = configEventFindings(cfg, null, names);
    assert.deepEqual(kinds(c), ["v2_mon_config_changed/warn"]);
    assert.equal(c[0].data.args.allowed, false);
    // The two switches have no CONFIG_EVENTS severity and are owned here; the allow-list keeps its severity for its false.
    assert.ok(OWN_KIND_EVENTS.has("FundingEnabledSet") && OWN_KIND_EVENTS.has("FundingSet") && !OWN_KIND_EVENTS.has("FundingAllowedSet"));
    assert.equal(CONFIG_EVENTS.FundingAllowedSet, "warn");
    assert.equal(CONFIG_EVENTS.FundingEnabledSet, undefined);
    assert.equal(CONFIG_EVENTS.FundingSet, undefined);
  });

  test("history before the first run is adopted by the event page (the state check below still sees it)", () => {
    assert.deepEqual(jitFundingEventFindings([enabled(true, { block: 5000n })], "5000", names), []);
    assert.equal(jitFundingEventFindings([enabled(true, { block: 5001n })], "5000", names).length, 1);
  });

  test("the scan keeps a funding log only from the contract that owns the switch", () => {
    const scan = emptyState(4663, "x").scan;
    const addresses = { clearinghouse: C.clearinghouse, orderBook: C.orderBook, earnVault: EARN };
    const config = applyScanLogs(scan, [
      enabled(true, { logIndex: 0 }),
      enabled(true, { address: C.clearinghouse, logIndex: 1 }),
      switched(true, { logIndex: 2 }),
      switched(true, { address: EARN, logIndex: 3 }),
      allowed(true, { logIndex: 4 }),
      allowed(true, { address: C.clearinghouse, logIndex: 5 }),
    ], addresses, null, []);
    assert.deepEqual(config.map((e) => `${e.eventName}:${e.logIndex}`), ["FundingEnabledSet:0", "FundingSet:2", "FundingAllowedSet:4"]);
    assert.deepEqual(JIT_FUNDING_EMITTER, { FundingEnabledSet: "earnVault", FundingAllowedSet: "orderBook", FundingSet: "orderBook" });
  });

  test("the switch at the head: any of the three true pages at error; all false or unread pages nothing", () => {
    assert.deepEqual(checkJitFunding({ vault: EARN, enabled: false, book: { allowed: false, on: false } }), []);
    assert.deepEqual(checkJitFunding({ vault: EARN, enabled: null, book: null }), [], "unread is noted by the caller, never judged off or on");
    const own = checkJitFunding({ vault: EARN, enabled: true, book: { allowed: false, on: false } });
    assert.deepEqual(kinds(own), ["v2_mon_jit_funding_enabled/error"]);
    assert.equal(own[0].key, EARN.toLowerCase());
    assert.equal(own[0].event, false, "a condition: it resolves when the switch is off again");
    assert.match(own[0].message, /EarnVault.fundingEnabled\(\) is true.*Owner order 2026-09-24/);
    assert.match(kinds(checkJitFunding({ vault: EARN, enabled: false, book: { allowed: true, on: false } }))[0], /jit_funding_enabled\/error/);
    assert.match(checkJitFunding({ vault: EARN, enabled: null, book: { allowed: true, on: true } })[0].message, /allowed is true .*on is true/);
  });

  test("every funding event is scanned with the exported ABI's exact signature, and every switch the monitor reads is exported", () => {
    const viem = loadViem();
    const fullSig = (e) => `${e.name}(${e.inputs.map((i) => `${typeOf(i)}${i.indexed ? " indexed" : ""} ${i.name}`).join(", ")})`;
    const scanned = new Set(viem.parseAbi(SCAN_EVENTS).filter((x) => x.type === "event").map(fullSig));
    const exported = { EarnVault: abiJson("EarnVault"), OrderBook: abiJson("OrderBook") };
    const owner = { FundingEnabledSet: "EarnVault", FundingAllowedSet: "OrderBook", FundingSet: "OrderBook" };
    for (const [name, arg] of Object.entries(JIT_FUNDING_EVENTS)) {
      const e = exported[owner[name]].find((x) => x.type === "event" && x.name === name);
      assert.ok(e, `${owner[name]}.json has no ${name}`);
      assert.ok(scanned.has(fullSig(e)), `${fullSig(e)} is not in SCAN_EVENTS`);
      assert.equal(e.inputs.find((i) => i.name === arg)?.type, "bool", `${name}.${arg} is the bool the page judges`);
    }
  });

  test("whole pass: a FundingEnabledSet(true) and a FundingSet(true) after the first run page; the switch read at the head pages", async () => {
    const dir = tmp("monitor-846-");
    try {
      const registry = writeRegistry(dir, { markets: [market("NVDA", 1)], deployBlock: 1000 });
      const reg = JSON.parse(readFileSync(registry, "utf8"));
      reg.v2.contracts.earnVault = EARN;
      writeFileSync(registry, JSON.stringify(reg));
      const chain = new FakeChain({ head: 20_000n });
      const sw = { enabled: false, book: [false, false] };
      chain.read = (address, fn, args) => {
        if (address.toLowerCase() === EARN.toLowerCase() && fn === "fundingEnabled") return sw.enabled;
        if (address.toLowerCase() === C.orderBook.toLowerCase() && fn === "fundingOf" && args[0].toLowerCase() === EARN.toLowerCase()) return sw.book;
        return defaultRead(chain, address, fn, args);
      };
      const opts = options(dir, registry);
      const first = await runOnce(opts, onChain(chain));
      assert.equal(first.checks.funding.status, "ok", first.checks.funding.detail);
      assert.ok(!first.findings.some((x) => x.kind.startsWith("v2_mon_jit_funding")), JSON.stringify(kindsOf(first)));
      chain.logs.push(rawLog("event FundingEnabledSet(bool on)", { on: true }, { address: EARN, blockNumber: 20_050 }));
      chain.logs.push(rawLog("event FundingSet(address indexed maker, bool on)", { maker: EARN, on: true }, { address: C.orderBook, blockNumber: 20_060 }));
      chain.logs.push(rawLog("event FundingSet(address indexed maker, bool on)", { maker: MAKER, on: false }, { address: C.orderBook, blockNumber: 20_070 }));
      sw.enabled = true;
      sw.book = [true, true];
      chain.setHead(20_100n, chain.head.timestamp + 120);
      const second = await runOnce(opts, onChain(chain));
      const ev = second.findings.filter((x) => x.kind === "v2_mon_jit_funding_on");
      assert.equal(ev.length, 2, JSON.stringify(kindsOf(second)));
      assert.ok(ev.every((x) => x.severity === "error" && x.event === true));
      assert.ok(ev.some((x) => /FundingEnabledSet\(true\)\) in block 20050/.test(x.message)), ev.map((x) => x.message).join(" | "));
      assert.ok(ev.some((x) => new RegExp(`maker ${EARN} switched its just-in-time funding ON .*in block 20060`, "i").test(x.message)));
      const state = second.findings.filter((x) => x.kind === "v2_mon_jit_funding_enabled");
      assert.equal(state.length, 1);
      assert.match(state[0].message, /fundingEnabled\(\) is true; .*allowed is true .*on is true/);
      // Unreadable switches are noted and the check is incomplete, never "off".
      chain.read = (address, fn, args) => (fn === "fundingEnabled" || fn === "fundingOf" ? (() => { throw transportError(); })() : defaultRead(chain, address, fn, args));
      chain.setHead(20_200n, chain.head.timestamp + 120);
      const blind = await runOnce(opts, onChain(chain));
      assert.equal(blind.checks.funding.status, "incomplete");
      assert.ok(blind.notes.some((n) => /EarnVault.fundingEnabled\(\) could not be read/.test(n)), JSON.stringify(blind.notes));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The test above fails BOTH reads at once, so the other
  // unread one keeps the check incomplete whatever the first does. Here each read fails ALONE while the other reads off:
  // an unread switch taken as off would complete the check with nothing on and resolve the open alert while the switch
  // is unknown. Each half ends with its positive control: both read off DOES resolve it.
  test("whole pass: either switch unread alone keeps the funding check incomplete and the open v2_mon_jit_funding_enabled open", async () => {
    const dir = tmp("monitor-979-funding-");
    const id = `v2_mon_jit_funding_enabled:${EARN.toLowerCase()}`;
    const alerts = () => Object.keys(JSON.parse(readFileSync(path.join(dir, "state.json"), "utf8")).alerts);
    try {
      const registry = writeRegistry(dir, { markets: [market("NVDA", 1)], deployBlock: 1000 });
      const reg = JSON.parse(readFileSync(registry, "utf8"));
      reg.v2.contracts.earnVault = EARN;
      writeFileSync(registry, JSON.stringify(reg));
      const chain = new FakeChain({ head: 20_000n });
      const sw = { enabled: false, book: [false, false] }; // "fail" makes that read throw
      chain.read = (address, fn, args) => {
        const a = address.toLowerCase();
        const answer = (v) => {
          if (v === "fail") throw transportError();
          return v;
        };
        if (a === EARN.toLowerCase() && fn === "fundingEnabled") return answer(sw.enabled);
        if (a === C.orderBook.toLowerCase() && fn === "fundingOf" && args[0].toLowerCase() === EARN.toLowerCase()) return answer(sw.book);
        return defaultRead(chain, address, fn, args);
      };
      const opts = options(dir, registry);
      const step = (enabled, book) => {
        sw.enabled = enabled;
        sw.book = book;
        chain.setHead(chain.head.number + 100n, chain.head.timestamp + 120);
        return runOnce(opts, onChain(chain));
      };
      // EarnVault's own switch.
      assert.equal((await step(true, [false, false])).checks.funding.status, "ok");
      assert.ok(alerts().includes(id), "fundingEnabled() true opens v2_mon_jit_funding_enabled");
      const ownUnread = await step("fail", [false, false]);
      assert.equal(ownUnread.checks.funding.status, "incomplete", JSON.stringify(ownUnread.checks.funding));
      assert.match(ownUnread.checks.funding.detail, /fundingEnabled unread/);
      assert.ok(alerts().includes(id), "an unread fundingEnabled() must not resolve it");
      assert.equal((await step(false, [false, false])).checks.funding.status, "ok");
      assert.ok(!alerts().includes(id), "positive control: both switches read off resolve it");
      // The OrderBook's allow-list for the vault.
      await step(false, [true, false]);
      assert.ok(alerts().includes(id), "fundingOf(EarnVault).allowed true opens it again");
      const bookUnread = await step(false, "fail");
      assert.equal(bookUnread.checks.funding.status, "incomplete", JSON.stringify(bookUnread.checks.funding));
      assert.match(bookUnread.checks.funding.detail, /OrderBook.fundingOf allowed unread on unread/);
      assert.ok(alerts().includes(id), "an unread fundingOf(EarnVault) must not resolve it");
      await step(false, [false, false]);
      assert.ok(!alerts().includes(id), "positive control: both switches read off resolve it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ------------------------------------------------------------------------------------------------ */
/*  launch-only keys after the lock, selector roles at the head, House vault limits                   */
/* ------------------------------------------------------------------------------------------------ */

describe("Launch-only keys, selector roles and House vault limits", () => {
  // contracts script/v2/roles.v8.json, byte for byte: the batch-6 shape (launchOnly, tightenLimits,
  // setHouseVaultFactory) that ops/abis/v2/roles.json gets from its regeneration.
  const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "roles-batch6.fixture.json");
  const M6 = loadRoleManifest(FIXTURE).manifest;
  const MGR = addr(0xac1);
  const SAFE = addr(0x5a1);
  const GKEY = addr(0xb04);
  const HV = addr(0x4a11);
  const ORACLE = addr(0xc3);
  const sel = (signature) => loadViem().toFunctionSelector(`function ${signature}`);
  const TIGHTEN = "tightenLimits((uint64,uint128,uint16,uint16,uint32,uint128))";
  const SET_LIMITS = "setLimits((uint64,uint128,uint16,uint16,uint32,uint128))";
  const SET_FACTORY = "setHouseVaultFactory(address)";

  test("the fixture is the batch-6 manifest: launchOnly guardianKey GUARDIAN, tightenLimits GUARDIAN, setHouseVaultFactory CONFIG_ADMIN", () => {
    assert.ok(M6 !== null, loadRoleManifest(FIXTURE).why);
    assert.deepEqual(M6.launchOnly, { guardianKey: ["GUARDIAN"] });
    assert.equal(M6.targets.HouseVault[TIGHTEN], "GUARDIAN");
    assert.equal(M6.targets.HouseVault[SET_LIMITS], "TREASURY_ADMIN");
    assert.equal(M6.targets.SettlementOracle[SET_FACTORY], "CONFIG_ADMIN");
    assert.ok(M6.holders.adminSafe.includes("GUARDIAN"), "the Admin Safe keeps GUARDIAN: it is not launch-only");
  });

  test("loadRoleManifest: no launchOnly is empty; a malformed one is UNKNOWN, as deployer-powers.mjs launchOnlyPairs refuses it", () => {
    const base = JSON.parse(readFileSync(FIXTURE, "utf8"));
    const dir = mkdtempSync(path.join(tmpdir(), "roles-954-"));
    const load = (json) => {
      const file = path.join(dir, `r${Math.random().toString(16).slice(2)}.json`);
      writeFileSync(file, JSON.stringify(json));
      return loadRoleManifest(file);
    };
    try {
      const { launchOnly: _drop, ...without } = base;
      assert.deepEqual(load(without).manifest.launchOnly, {}, "a manifest from before T-OP-824 has no launch-only pair");
      for (const [bad, why] of [
        [[], /launchOnly is not an object/],
        [{ guardianKey: "GUARDIAN" }, /launchOnly\.guardianKey is not a list/],
        [{ adminSafe: ["GUARDIAN"] }, /launchOnly\.adminSafe: the lock never revokes/],
        [{ guardianKey: ["ADMIN"] }, /launchOnly\.guardianKey lists ADMIN, which holders\.guardianKey does not give it/],
      ]) {
        const r = load({ ...base, launchOnly: bad });
        assert.equal(r.manifest, null, JSON.stringify(bad));
        assert.match(r.why, why);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("publishedHolders marks the launch-only pair and keeps a pair the lock never revokes when one address is both", () => {
    const pairs = publishedHolders(M6, { adminSafe: SAFE, guardianKey: GKEY, pricerKey: null, quoterKey: null, crankerKey: null });
    const flagged = pairs.filter((p) => p.launchOnly).map((p) => `${p.label}/${p.roleName}`);
    assert.deepEqual(flagged, ["guardianKey/GUARDIAN"]);
    assert.equal(pairs.find((p) => p.label === "adminSafe" && p.roleName === "GUARDIAN").launchOnly, false);
    const same = publishedHolders(M6, { adminSafe: SAFE, guardianKey: SAFE });
    const guardian = same.filter((p) => p.roleName === "GUARDIAN");
    assert.deepEqual(guardian.map((p) => `${p.label}/${p.launchOnly}`), ["adminSafe/false"], "the Safe's own GUARDIAN is never a launch key");
  });

  // Members as the manager check builds them: three of the Admin Safe's delayed lanes and the guardian key's GUARDIAN.
  const lane = (roleName, over = {}) => ({ label: "adminSafe", address: SAFE, roleId: M6.ids[roleName], roleName, isMember: true, executionDelay: M6.delaysS[roleName], wantMember: true, wantDelayS: M6.delaysS[roleName], launchOnly: false, ...over });
  const key = (over = {}) => ({ label: "guardianKey", address: GKEY, roleId: M6.ids.GUARDIAN, roleName: "GUARDIAN", isMember: true, executionDelay: 0, wantMember: true, wantDelayS: 0, launchOnly: true, ...over });
  const locked = [lane("ADMIN"), lane("CONFIG_ADMIN"), lane("TREASURY_ADMIN")];
  const launch = locked.map((mb) => ({ ...mb, executionDelay: 0 }));
  const launchKey = (out) => out.filter((f) => f.kind === "v2_mon_manager_launch_key");

  test("v2_mon_manager_launch_key: after the lock the guardian key still holding GUARDIAN pages error, naming the key and the role", () => {
    const out = checkManagerWiring({ manager: MGR, rows: [], members: [...locked, key()] });
    assert.deepEqual(out.map((f) => `${f.kind}/${f.severity}`), ["v2_mon_manager_launch_key/error"]);
    assert.equal(out[0].key, `${MGR.toLowerCase()}:7:${GKEY.toLowerCase()}:launch`);
    assert.match(out[0].message, new RegExp(`guardianKey \\(${GKEY}\\) still holds GUARDIAN \\(7\\) after the lock \\(every delayed lane is at its manifest delay\\)`));
    assert.match(out[0].message, new RegExp(`renounceRole\\(7, ${GKEY}\\)`));
    assert.deepEqual({ holder: out[0].data.holder, role: out[0].data.role, account: out[0].data.account }, { holder: "guardianKey", role: "GUARDIAN", account: GKEY });
    // A lock this monitor saw earlier still counts when the table reads the launch profile again (the lock undone).
    const undone = checkManagerWiring({ manager: MGR, rows: [], members: [...launch, key()], lock: { block: "900", at: 1_700_000_000 } });
    assert.equal(launchKey(undone).length, 1);
    assert.match(launchKey(undone)[0].message, /saw the planned delays at block 900/);
  });

  test("v2_mon_manager_launch_key: nothing before the lock, nothing for a key the lock revoked, nothing unread, nothing for the Admin Safe", () => {
    const before = checkManagerWiring({ manager: MGR, rows: [], members: [...launch, key()] });
    assert.deepEqual(launchKey(before), [], "before the lock the key holds GUARDIAN by design");
    assert.deepEqual(before.map((f) => f.key.split(":").pop()), ["prelock"]);
    assert.deepEqual(checkManagerWiring({ manager: MGR, rows: [], members: [...locked, key({ isMember: false })] }), [], "revoked after the lock is the planned state, not :missing");
    assert.deepEqual(checkManagerWiring({ manager: MGR, rows: [], members: [...locked, key({ isMember: null, executionDelay: null })] }), []);
    assert.deepEqual(checkManagerWiring({ manager: MGR, rows: [], members: [...locked, lane("GUARDIAN")] }), [], "the Admin Safe keeps GUARDIAN");
    // Before the lock a missing launch key is still a published holder that does not hold its role.
    const missing = checkManagerWiring({ manager: MGR, rows: [], members: [...launch, key({ isMember: false })] });
    assert.ok(missing.some((f) => f.key.endsWith(`${GKEY.toLowerCase()}:missing`)), JSON.stringify(missing.map((f) => f.key)));
  });

  test("a launch-only pair does not decide which side of the lock the delay table is on", () => {
    assert.equal(managerDelayPhase([...locked, key({ wantDelayS: 3600, executionDelay: 0 })]), "locked");
    assert.equal(managerDelayPhase([...launch, key({ wantDelayS: 3600, executionDelay: 3600 })]), "launch");
  });

  const fn = (contract, signature, chain, target) => ({ contract, target, signature, selector: sel(signature), roleName: M6.targets[contract][signature], want: M6.ids[M6.targets[contract][signature]], chain });

  test("selector roles: tightenLimits and setHouseVaultFactory are re-read at the head and a role that is not the manifest's pages", () => {
    const ok = [fn("HouseVault", TIGHTEN, 7n, HV), fn("HouseVault", SET_LIMITS, 4n, HV), fn("SettlementOracle", SET_FACTORY, 3n, ORACLE)];
    assert.deepEqual(checkManagerWiring({ manager: MGR, rows: [], members: [], functions: ok }), []);
    const bad = checkManagerWiring({ manager: MGR, rows: [], members: [], functions: [fn("HouseVault", TIGHTEN, 0n, HV), fn("HouseVault", SET_LIMITS, 4n, HV), fn("SettlementOracle", SET_FACTORY, 7n, ORACLE)] });
    assert.deepEqual(
      bad.map((f) => `${f.kind}/${f.severity}/${f.key}`),
      [`v2_mon_manager_wiring/error/${MGR.toLowerCase()}:${HV.toLowerCase()}:fn:${sel(TIGHTEN)}`, `v2_mon_manager_wiring/error/${MGR.toLowerCase()}:${ORACLE.toLowerCase()}:fn:${sel(SET_FACTORY)}`],
    );
    assert.match(bad[0].message, new RegExp(`HouseVault\\.tightenLimits\\(.*\\) on ${HV} needs ADMIN \\(0\\) on chain, and the manifest .* says GUARDIAN \\(7\\)`));
    assert.match(bad[1].message, /SettlementOracle\.setHouseVaultFactory\(address\) on .* needs GUARDIAN \(7\) on chain, and the manifest .* says CONFIG_ADMIN \(3\)/);
    const pub = checkManagerWiring({ manager: MGR, rows: [], members: [], functions: [fn("SettlementOracle", SET_FACTORY, MANAGER_PUBLIC_ROLE, ORACLE)] });
    assert.match(pub[0].message, /needs PUBLIC_ROLE \(anyone\) on chain/);
    assert.deepEqual(checkManagerWiring({ manager: MGR, rows: [], members: [], functions: [fn("HouseVault", TIGHTEN, null, HV)] }), [], "unread is judged by nothing");
  });

  test("selector roles: a House vault with no selector mapped is ONE :unmapped warn, not one error per selector", () => {
    const all = Object.keys(M6.targets.HouseVault).map((signature) => fn("HouseVault", signature, 0n, HV));
    const out = checkManagerWiring({ manager: MGR, rows: [], members: [], functions: all });
    assert.deepEqual(out.map((f) => `${f.severity}/${f.key}`), [`warn/${MGR.toLowerCase()}:${HV.toLowerCase()}:unmapped`]);
    assert.match(out[0].message, new RegExp(`HouseVault ${HV} has none of its ${all.length} manifest selectors mapped`));
    // One selector mapped and one not is a real mismatch, per selector.
    const half = checkManagerWiring({ manager: MGR, rows: [], members: [], functions: [fn("HouseVault", TIGHTEN, 7n, HV), fn("HouseVault", SET_LIMITS, 0n, HV)] });
    assert.deepEqual(half.map((f) => f.key.split(":").slice(-2).join(":")), [`fn:${sel(SET_LIMITS)}`]);
  });

  test("managerTargets: the registry's House vaults and factory are targets; a contract with no address is listed as unnamed", () => {
    const FACTORY = addr(0xf4c);
    const reg = parseRegistry({
      v2: { contracts: { ...C, houseVaultFactory: FACTORY, hedger: null } },
      markets: [{ ticker: "NVDA", asset: addr(0xa001), v2: { house: { weekly: null, daily: HV } } }],
    });
    const { targets, unnamed } = managerTargets(reg, M6);
    assert.deepEqual(targets.filter((t) => t.contract.startsWith("HouseVault")), [{ contract: "HouseVault", address: HV }, { contract: "HouseVaultFactory", address: FACTORY }]);
    assert.deepEqual(targets.find((t) => t.contract === "PayoutRouter"), { contract: "PayoutRouter", address: C.payoutAdapter });
    assert.ok(unnamed.includes("Hedger") && unnamed.includes("EarnVault"), JSON.stringify(unnamed));
  });

  test("manifestRoleAt names a selector two contracts map differently by the target's own entry", () => {
    const setOracle = sel("setOracle(address)");
    const index = {};
    const byTarget = {};
    for (const [contract, fns] of Object.entries(M6.targets)) for (const [signature, role] of Object.entries(fns)) index[sel(signature)] = { contract, signature, role };
    const SPLITTER = addr(0xf51);
    for (const [address, contract] of [[HV, "HouseVault"], [SPLITTER, "FeeSplitter"]]) {
      byTarget[address.toLowerCase()] = Object.fromEntries(Object.entries(M6.targets[contract]).map(([signature, role]) => [sel(signature), { contract, signature, role }]));
    }
    const ctx = { selectors: index, byTarget };
    assert.equal(manifestRoleAt(HV, setOracle, ctx).role, "CONFIG_ADMIN");
    assert.equal(manifestRoleAt(SPLITTER, setOracle, ctx).role, "TREASURY_ADMIN");
    assert.equal(manifestRoleAt(addr(0x999), setOracle, ctx), index[setOracle], "an address that is no known target falls back to the selector index");
  });

  // House vault limits, HouseVault.Limits field by field.
  const L = { maxSeriesUnits: 10_000n, maxTotalNotional: 10n ** 12n, askToleranceBps: 100, maxBidBpsOfSpot: 500, maxOrderLifetime: 86_400, maxDailyOutflow: 10n ** 11n };
  const str = (o) => Object.fromEntries(HOUSE_LIMIT_FIELDS.map((k) => [k, String(o[k])]));

  test("houseLimitsDirection is HouseVault.tightenLimits' rule: any looser field is a loosen, and 0 is the loosest lifetime", () => {
    assert.equal(houseLimitsDirection(null, str(L)), null);
    assert.equal(houseLimitsDirection(str(L), str(L)), "tighten", "equal is what tightenLimits allows");
    for (const k of ["maxSeriesUnits", "maxTotalNotional", "askToleranceBps", "maxBidBpsOfSpot", "maxDailyOutflow"]) {
      assert.equal(houseLimitsDirection(str(L), str({ ...L, [k]: BigInt(L[k]) + 1n })), "loosen", `${k} up`);
      assert.equal(houseLimitsDirection(str(L), str({ ...L, [k]: BigInt(L[k]) - 1n })), "tighten", `${k} down`);
    }
    assert.equal(houseLimitsDirection(str(L), str({ ...L, maxOrderLifetime: 86_401 })), "loosen");
    assert.equal(houseLimitsDirection(str(L), str({ ...L, maxOrderLifetime: 0 })), "loosen", "0 means no lifetime bound");
    assert.equal(houseLimitsDirection(str(L), str({ ...L, maxOrderLifetime: 3_600 })), "tighten");
    assert.equal(houseLimitsDirection(str({ ...L, maxOrderLifetime: 0 }), str({ ...L, maxOrderLifetime: 3_600 })), "tighten", "from no bound any bound is stricter");
  });

  const limitsLog = (limits, blockNumber, logIndex = 0, address = HV) => ({ eventName: "LimitsSet", address, args: { limits }, blockNumber: BigInt(blockNumber), logIndex, transactionHash: `0x${blockNumber.toString(16).padStart(62, "0")}${logIndex.toString(16).padStart(2, "0")}` });

  test("applyHouseLimits: each LimitsSet against the last, in chain order; a replayed or baseline-covered log is skipped", () => {
    const scan = { houseLimits: { [HV.toLowerCase()]: { limits: str(L), at: "50:*" } } };
    const up = { ...L, maxDailyOutflow: L.maxDailyOutflow + 1n };
    const down = { ...up, maxSeriesUnits: 9_000n };
    const logs = [limitsLog(down, 101, 0), limitsLog(up, 100, 3), limitsLog(L, 50, 9)];
    const out = applyHouseLimits(scan, logs);
    assert.deepEqual(out.map((e) => `${e.eventName}/${e.blockNumber}/${e.direction}`), ["HouseLimitsSet/100/loosen", "HouseLimitsSet/101/tighten"]);
    assert.deepEqual(out[0].previous, str(L));
    assert.deepEqual(scan.houseLimits[HV.toLowerCase()], { limits: str(down), at: "101:0" });
    assert.deepEqual(applyHouseLimits(scan, logs), [], "the scan's overlap re-read changes nothing");
    const OTHER = addr(0x4a12);
    const first = applyHouseLimits(scan, [limitsLog(L, 102, 0, OTHER)]);
    assert.equal(first[0].direction, null, "a vault with nothing earlier known");
  });

  test("HouseLimitsSet pages v2_mon_config_changed: error when a limit went up, warn when stricter or unknown", () => {
    const scan = { houseLimits: { [HV.toLowerCase()]: { limits: str(L), at: "50:*" } } };
    const up = { ...L, maxDailyOutflow: L.maxDailyOutflow + 1n };
    const events = [...applyHouseLimits(scan, [limitsLog(up, 100), limitsLog(L, 101)]), ...applyHouseLimits(scan, [limitsLog(L, 102, 0, addr(0x4a12))])];
    const found = configEventFindings(events, null, { [HV.toLowerCase()]: "NVDA HouseVault" });
    assert.deepEqual(found.map((f) => `${f.kind}/${f.severity}/${f.data.direction}`), ["v2_mon_config_changed/error/loosen", "v2_mon_config_changed/warn/tighten", "v2_mon_config_changed/warn/null"]);
    assert.match(found[0].message, /^NVDA HouseVault\.HouseLimitsSet\(limits=.*a House vault limit went UP \(maxDailyOutflow 100000000000 -> 100000000001\)\. Only HouseVault\.setLimits \(TREASURY_ADMIN\)/);
    assert.match(found[1].message, /every House vault limit is equal to or stricter than before \(maxDailyOutflow 100000000001 -> 100000000000\): a change HouseVault\.tightenLimits \(GUARDIAN/);
    assert.match(found[2].message, /no earlier LimitsSet or baseline read is known for this House vault/);
    assert.equal(CONFIG_EVENTS.HouseLimitsSet, "warn");
  });

  test("the House vault LimitsSet the scan reads is the exported HouseVault ABI's event", () => {
    const ev = JSON.parse(readFileSync(path.join(ABIS, "HouseVault.json"), "utf8")).find((x) => x.type === "event" && x.name === "LimitsSet");
    const scanned = loadViem().parseAbi(HOUSE_VAULT_SCAN_SIGNATURES).find((x) => x.name === "LimitsSet");
    assert.equal(loadViem().toEventSelector(scanned), loadViem().toEventSelector(ev));
    assert.deepEqual(ev.inputs[0].components.map((c) => c.name), HOUSE_LIMIT_FIELDS);
  });
});

/*
 * EarnVault prices nothing while its venue adapter cannot be read (convertToAssets
 * reverts VenueUnreadable), and setAdapter away from such a venue writes its last known value off (VenueWrittenOff).
 * The monitor pages the first as a standing condition and the second as an event, both at error. The write-off pages
 * once, under its own kind (v2_mon_earn_venue_written_off), not also as v2_mon_config_changed.
 */
import { checkEarnVenue, revertErrorName } from "./monitor.mjs";

describe("An unreadable Earn venue and its write-off page", () => {
  const EARN = addr(0xea39);
  const ADAPTER = addr(0xad39);
  const earnAbi = () => viem.parseAbi(ABI_TEXT.earnVault);
  /** What viem raises for convertToAssets reverting `errorName`, decoded against the monitor's own earnVault list. */
  const revertOf = (errorName) =>
    new viem.ContractFunctionExecutionError(
      new viem.ContractFunctionRevertedError({ abi: earnAbi(), data: viem.encodeErrorResult({ abi: earnAbi(), errorName }), functionName: "convertToAssets" }),
      { abi: earnAbi(), functionName: "convertToAssets", args: [1n], contractAddress: EARN },
    );

  test("the probe's two refusals are the exported EarnVault errors, decoded by name (VenueUnreadable() is 0x5e6660df)", () => {
    const exported = new Set(abiJson("EarnVault").filter((x) => x.type === "error").map((x) => x.name));
    assert.ok(exported.has("VenueUnreadable") && exported.has("PositionOpen"), "EarnVault.json exports both errors");
    assert.equal(viem.toFunctionSelector("VenueUnreadable()"), "0x5e6660df", "cast sig \"VenueUnreadable()\"");
    assert.equal(revertErrorName(revertOf("VenueUnreadable")), "VenueUnreadable");
    assert.equal(revertErrorName(revertOf("PositionOpen")), "PositionOpen");
    assert.equal(revertErrorName(transportError()), null);
    assert.equal(revertErrorName(null), null);
  });

  test("checkEarnVenue pages only an unreadable venue, at error", () => {
    const f = checkEarnVenue({ vault: EARN, adapter: ADAPTER, probe: "unreadable" });
    assert.deepEqual(kinds(f), ["v2_mon_earn_venue_unreadable/error"]);
    assert.equal(f[0].key, EARN.toLowerCase());
    assert.equal(f[0].check, "earnvenue");
    assert.match(f[0].message, /cannot be read, so the vault prices nothing .*processQueue serves nothing .*setAdapter, which writes the venue's last known value off \(VenueWrittenOff\)/);
    assert.deepEqual(checkEarnVenue({ vault: EARN, adapter: ADAPTER, probe: "priced" }), []);
    assert.deepEqual(checkEarnVenue({ vault: EARN, adapter: ADAPTER, probe: "position-open" }), []);
  });

  test("VenueWrittenOff is scanned with the exported signature, kept for the EarnVault, and pages once at error with its own text", () => {
    const e = abiJson("EarnVault").find((x) => x.type === "event" && x.name === "VenueWrittenOff");
    assert.ok(e, "EarnVault.json exports VenueWrittenOff");
    const sig = `event ${e.name}(${e.inputs.map((i) => `${typeOf(i)}${i.indexed ? " indexed" : ""} ${i.name}`).join(", ")})`;
    const log = rawLog(sig, { adapter: ADAPTER, lastKnown: 1_234_500_000n }, { address: EARN, blockNumber: 901 });
    const decoded = viem.parseEventLogs({ abi: viem.parseAbi(SCAN_EVENTS), logs: [log], strict: true });
    assert.equal(decoded.length, 1, "VenueWrittenOff decodes through SCAN_EVENTS");
    assert.equal(SCAN_EVENTS.filter((x) => x.startsWith("event VenueWrittenOff(")).length, 1, "scanned once");
    // One page per log: the config path never sees it, its own kind pages it.
    assert.equal(CONFIG_EVENTS.VenueWrittenOff, undefined, "a CONFIG_EVENTS severity would page it a second time as v2_mon_config_changed");
    const sink = [];
    const collected = applyScanLogs(emptyState(4663, "x").scan, decoded, { earnVault: EARN }, null, sink);
    assert.deepEqual(configEventFindings(collected, null, { [EARN.toLowerCase()]: "EarnVault" }), []);
    const f = earnWriteOffFindings(sink, null, { vault: EARN });
    assert.deepEqual(kinds(f), ["v2_mon_earn_venue_written_off/error"]);
    assert.match(f[0].message, new RegExp(`setAdapter wrote off venue ${ADAPTER} at block 901`, "i"));
    assert.match(f[0].message, /Its last known value, 1234\.50 USDG \(1234500000 base units\), left totalAssets/);
    assert.match(f[0].message, /Expected only as the planned end of a v2_mon_earn_venue_unreadable page \(T-OP-839\); otherwise treat the TREASURY_ADMIN key as compromised/);
    // A write-off of 0 is a venue drained blind, not "nothing lost": the page says its contents were unknown.
    const blind = rawLog(sig, { adapter: ADAPTER, lastKnown: 0n }, { address: EARN, blockNumber: 902 });
    const blindSink = [];
    applyScanLogs(emptyState(4663, "x").scan, viem.parseEventLogs({ abi: viem.parseAbi(SCAN_EVENTS), logs: [blind], strict: true }), { earnVault: EARN }, null, blindSink);
    const g = earnWriteOffFindings(blindSink, null, { vault: EARN });
    assert.deepEqual(kinds(g), ["v2_mon_earn_venue_written_off/error"]);
    assert.match(g[0].message, /reached 0 only by subtracting what was pulled out while the venue could not be read \(T-OP-900\), so what the venue still holds, a gain the vault never read, is unknown and no longer counted/);
  });

  test("whole pass: the head probe pages while convertToAssets reverts VenueUnreadable, and not once it answers", async () => {
    const dir = tmp("monitor-839-");
    try {
      const registry = writeRegistry(dir, { markets: [market("NVDA", 1)], deployBlock: 1000 });
      const reg = JSON.parse(readFileSync(registry, "utf8"));
      reg.v2.contracts.earnVault = EARN;
      writeFileSync(registry, JSON.stringify(reg));
      const chain = new FakeChain({ head: 20_000n });
      const v = { probe: "priced" };
      chain.read = (address, fn, args) => {
        if (address.toLowerCase() === EARN.toLowerCase() && fn === "convertToAssets") {
          if (v.probe === "unreadable") throw revertOf("VenueUnreadable");
          if (v.probe === "position-open") throw revertOf("PositionOpen");
          if (v.probe === "down") throw transportError();
          return 1n;
        }
        if (address.toLowerCase() === EARN.toLowerCase() && fn === "adapter") return ADAPTER;
        return defaultRead(chain, address, fn, args);
      };
      const opts = options(dir, registry);
      const first = await runOnce(opts, onChain(chain));
      assert.equal(first.checks.earnvenue.status, "ok", first.checks.earnvenue.detail);
      assert.ok(!kindsOf(first).includes("v2_mon_earn_venue_unreadable"));

      v.probe = "unreadable";
      chain.setHead(20_100n, chain.head.timestamp + 120);
      const broken = await runOnce(opts, onChain(chain));
      const page = broken.findings.filter((x) => x.kind === "v2_mon_earn_venue_unreadable");
      assert.equal(page.length, 1, JSON.stringify(kindsOf(broken)));
      assert.equal(page[0].severity, "error");
      assert.match(page[0].message, new RegExp(`venue adapter ${ADAPTER} cannot be read`, "i"));

      // PositionOpen is checked first by the contract: with the page open, the check keeps it (incomplete), never "fine".
      v.probe = "position-open";
      chain.setHead(20_200n, chain.head.timestamp + 120);
      const masked = await runOnce(opts, onChain(chain));
      assert.equal(masked.checks.earnvenue.status, "incomplete", masked.checks.earnvenue.detail);

      // An RPC failure is never "priced" either.
      v.probe = "down";
      chain.setHead(20_300n, chain.head.timestamp + 120);
      const blind = await runOnce(opts, onChain(chain));
      assert.equal(blind.checks.earnvenue.status, "incomplete");
      assert.ok(blind.notes.some((n) => /EarnVault.convertToAssets\(1\) failed without a reason/.test(n)), JSON.stringify(blind.notes));

      v.probe = "priced";
      chain.setHead(20_400n, chain.head.timestamp + 120);
      const back = await runOnce(opts, onChain(chain));
      assert.equal(back.checks.earnvenue.status, "ok", back.checks.earnvenue.detail);
      assert.ok(!kindsOf(back).includes("v2_mon_earn_venue_unreadable"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("with no page open, a PositionOpen answer is ok (not judged) rather than an incomplete check every pass", async () => {
    const dir = tmp("monitor-839b-");
    try {
      const registry = writeRegistry(dir, { markets: [market("NVDA", 1)], deployBlock: 1000 });
      const reg = JSON.parse(readFileSync(registry, "utf8"));
      reg.v2.contracts.earnVault = EARN;
      writeFileSync(registry, JSON.stringify(reg));
      const chain = new FakeChain({ head: 20_000n });
      chain.read = (address, fn, args) =>
        address.toLowerCase() === EARN.toLowerCase() && fn === "convertToAssets" ? (() => { throw revertOf("PositionOpen"); })() : defaultRead(chain, address, fn, args);
      const r = await runOnce(options(dir, registry), onChain(chain));
      assert.equal(r.checks.earnvenue.status, "ok", r.checks.earnvenue.detail);
      assert.match(r.checks.earnvenue.detail, /PositionOpen; the venue is not judged/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
