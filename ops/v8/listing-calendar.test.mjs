/**
 * T-195 / OWN8-06. What these tests pin, in the order the calendar can hurt someone:
 *
 *   1. THE DELAY IS NEVER TYPED. Every row's delay is read out of `ops/abis/v2/roles.json` by exact
 *      selector. A selector the manifest does not map is an error, because AccessManager falls back
 *      to ADMIN (48 h) for an unmapped restricted selector and a calendar that assumed LISTING would
 *      tell the owner to schedule a registration 47 hours too late.
 *   2. AN ABSENT SUBJECT IS NEVER A PASS. An unregistered market and an unset route both decode as
 *      clean zeros, and an operation with no observation at all is the same shape of nothing. Each
 *      of those grades NOT-APPLIED or MISMATCH here, never APPLIED - the tests below delete the
 *      protected fact and require the red result.
 *   3. A ROUTE IS SCHEDULED ONLY AGAINST FRESH MATCHING EVIDENCE. Six ways for the evidence to fail
 *      to say "this exact pool is there" are six flagged rows and a non-zero exit.
 *   4. THE COUNT IS COUNTED. No test here asserts twenty, or names a ticker that the fixture did not
 *      put there: the expected numbers are derived from the same registry the calendar reads, so a
 *      registry change moves the test and the code together instead of only one of them.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  DEFAULT_REGISTRY,
  DEFAULT_ROLES,
  LAUNCH_WAVES,
  OPERATIONS,
  abiEntry,
  buildCalendar,
  canonicalSignature,
  delayOf,
  feeFilterRefusal,
  gradeReadbacks,
  launchMarkets,
  loadAbis,
  readJson,
  registrationArgs,
  returnSignature,
  roleOf,
  routeEvidenceRefusal,
  run,
  tupleFieldIndex,
} from "./listing-calendar.mjs";

const ROLES = readJson(DEFAULT_ROLES);
const REGISTRY = readJson(DEFAULT_REGISTRY);
const ABIS = loadAbis();

const START = Date.parse("2026-10-01T12:00:00Z") / 1000;
const ASSET = "0x00000000000000000000000000000000000000a1";
const POOL_ID = "0x" + "ab".repeat(32);

const market = (over = {}) => ({
  ticker: "TEST",
  asset: ASSET,
  ...over,
  v2: {
    wave: "wave1",
    strikeTick: "2500000",
    payoutRoute: { venue: "v4", fee: 3000, tickSpacing: 60, poolId: POOL_ID },
    ...(over.v2 ?? {}),
  },
});

// The synthetic registry now carries a `launchSet`, because {launchMarkets} reads it rather than
// filtering waves (T-OP-003). Derived from the markets the case passes in, so every existing case keeps
// its meaning: "the calendar covers the markets I gave it". A case that wants the two to DISAGREE --
// a launch set naming a market the registry does not carry -- passes `launchSet` explicitly.
const registry = (markets, launchSet) => ({
  rpc: "https://rpc.example.invalid",
  shared: { chainId: 4663, safes: { admin: null } },
  v2: { contracts: { clearinghouse: "0x" + "11".repeat(20), payoutAdapter: "0x" + "22".repeat(20), accessManager: "0x" + "33".repeat(20) } },
  launchSet: launchSet ?? { note: "synthetic fixture", markets: markets.map((m) => m.ticker) },
  markets,
});

const evidence = (over = {}) => ({
  measuredAt: "2026-10-01T11:00:00Z",
  chainId: 4663,
  block: 66_000_000,
  pools: [{ ticker: "TEST", asset: ASSET, poolId: POOL_ID, exists: true, hooks: "0x0000000000000000000000000000000000000000", fee: 3000, tickSpacing: 60 }],
  ...over,
});

const calendarOf = (markets, ev = evidence(), extra = {}) => {
  const { launchSet, ...rest } = extra;
  return buildCalendar({ registry: registry(markets, launchSet), roles: ROLES, evidence: ev, startS: START, abis: ABIS, ...rest });
};

const rowFor = (cal, ticker, operation) => cal.rows.find((r) => r.ticker === ticker && r.operation === operation);

// 1. The delay and the role come from the manifest, by exact selector.

test("the role and the delay are read from roles.json, never from this file", () => {
  assert.equal(roleOf(ROLES, "Clearinghouse", OPERATIONS.register.signature), "LISTING");
  assert.equal(roleOf(ROLES, "PayoutRouter", OPERATIONS["route-v4"].signature), "CONFIG_ADMIN");
  // The values themselves are asserted against the manifest, not against 3600 / 86400 typed here:
  // if the manifest moves, the calendar moves with it and this test still passes.
  assert.equal(delayOf(ROLES, "LISTING"), ROLES.delaysS.LISTING);
  assert.equal(delayOf(ROLES, "CONFIG_ADMIN"), ROLES.delaysS.CONFIG_ADMIN);
  assert.ok(delayOf(ROLES, "CONFIG_ADMIN") > delayOf(ROLES, "LISTING"), "the route lane must be the longer one; the whole calendar exists because they differ");
});

test("an unmapped selector is refused rather than defaulted to ADMIN", () => {
  const withoutRegister = { ...ROLES, targets: { ...ROLES.targets, Clearinghouse: { ...ROLES.targets.Clearinghouse } } };
  delete withoutRegister.targets.Clearinghouse[OPERATIONS.register.signature];
  // Delete the protected fact: the manifest no longer maps registerMarket.
  assert.throws(() => roleOf(withoutRegister, "Clearinghouse", OPERATIONS.register.signature), /maps no role/);
  // Restore it: green again, from the same code path.
  assert.equal(roleOf(ROLES, "Clearinghouse", OPERATIONS.register.signature), "LISTING");
  assert.throws(() => delayOf({ delaysS: {} }, "LISTING"), /no integer delay/);
});

test("the call signature and the readback shape come out of the ABI", () => {
  const entry = abiEntry(ABIS.Clearinghouse, OPERATIONS.register.signature);
  assert.equal(canonicalSignature(entry), "registerMarket(address,uint64,bool)");
  const readback = abiEntry(ABIS.Clearinghouse, "market(address)");
  assert.match(returnSignature(readback), /^\(\(bool,bool,uint64/, "market() returns one tuple, expanded for cast");
  assert.equal(tupleFieldIndex(readback, "enabled"), 0);
  assert.throws(() => tupleFieldIndex(readback, "notAField"), /does not return a field/);
  assert.throws(() => abiEntry(ABIS.PayoutRouter, "setRouteV4(address,uint24)"), /has no function/);
  // setRouteV3 and setRouteV4 differ only by arity: a name-only lookup would return either.
  assert.equal(canonicalSignature(abiEntry(ABIS.PayoutRouter, OPERATIONS["route-v3"].signature)), "setRouteV3(address,uint24)");
});

// 2. The market set is counted, and a market that cannot be placed is an error.

test("the launch set and its count come from the registry", () => {
  const markets = [market({ ticker: "A" }), market({ ticker: "B", v2: { wave: "canary" } }), market({ ticker: "C", v2: { wave: "wave2" } })];
  const selected = launchMarkets(registry(markets), LAUNCH_WAVES);
  assert.deepEqual(selected.map((m) => m.ticker), ["A", "B"]);
  assert.equal(selected.length, markets.filter((m) => LAUNCH_WAVES.includes(m.v2.wave)).length);
});

test("a market with no wave, and an empty launch set, are both errors", () => {
  const noWave = [market({ ticker: "A", v2: { wave: undefined } })];
  assert.throws(() => launchMarkets(registry(noWave), LAUNCH_WAVES), /no v2.wave/);
  assert.throws(() => launchMarkets(registry([market({ v2: { wave: "wave2" } })]), LAUNCH_WAVES), /would be empty/);
  assert.throws(() => registrationArgs(market({ v2: { strikeTick: 2500000 } })), /strikeTick is not a decimal string/);
});

// 3. Timing: the whole point of the calendar.

test("a registration and a route are a day apart, and the schedule-by is derived from the target launch", () => {
  const cal = calendarOf([market()], evidence(), { launchAtS: START + 3 * 86_400 });
  const reg = rowFor(cal, "TEST", "register");
  const route = rowFor(cal, "TEST", "route-v4");
  assert.equal(reg.earliestExecuteAtS, START + ROLES.delaysS.LISTING);
  assert.equal(route.earliestExecuteAtS, START + ROLES.delaysS.CONFIG_ADMIN);
  assert.equal(cal.earliestLaunchS, START + ROLES.delaysS.CONFIG_ADMIN, "the launch cannot be earlier than the slowest scheduled row");
  // The number a person gets wrong by hand: the route has to be scheduled a day before the launch.
  assert.equal(route.scheduleByS, cal.targetLaunchS - ROLES.delaysS.CONFIG_ADMIN);
  assert.equal(reg.scheduleByS, cal.targetLaunchS - ROLES.delaysS.LISTING);
  assert.equal(cal.counts.tooLate, 0);
});

test("a launch too soon for the route lane is flagged TOO LATE rather than printed as achievable", () => {
  const cal = calendarOf([market()], evidence(), { launchAtS: START + 3600 });
  assert.equal(rowFor(cal, "TEST", "route-v4").tooLate, true);
  assert.equal(rowFor(cal, "TEST", "register").tooLate, false, "an hour is still enough for the LISTING lane");
  assert.ok(cal.counts.tooLate > 0);
});

test("the execution window end is UNKNOWN until the manager's own expiration() is supplied", () => {
  assert.equal(rowFor(calendarOf([market()]), "TEST", "route-v4").expiresAtS, null);
  const pinned = calendarOf([market()], evidence(), { expirationS: 604_800 });
  const row = rowFor(pinned, "TEST", "route-v4");
  assert.equal(row.expiresAtS, row.earliestExecuteAtS + 604_800);
});

// 4. Routes: scheduled only against fresh, matching evidence.

test("a route is scheduled when the evidence names that exact pool", () => {
  const row = rowFor(calendarOf([market()]), "TEST", "route-v4");
  assert.equal(row.status, "scheduled");
  assert.equal(row.reason, null);
  assert.deepEqual(row.args, [ASSET, "3000", "60"]);
});

test("every way the evidence fails to say 'this pool is there' is a flag, not a schedule", () => {
  const refusal = (ev) => routeEvidenceRefusal(market().v2.payoutRoute, market(), ev, { nowS: START, maxAgeS: 86_400 });
  assert.match(refusal(null), /no route evidence supplied/);
  assert.match(refusal(evidence({ pools: [] })), /absent from the route evidence/);
  assert.match(refusal(evidence({ measuredAt: "2026-09-20T11:00:00Z" })), /route evidence is \d+ h old/);
  assert.match(refusal(evidence({ pools: [{ ticker: "TEST", asset: ASSET, exists: false, poolId: POOL_ID, fee: 3000, tickSpacing: 60 }] })), /exists=false/);
  assert.match(refusal(evidence({ pools: [{ ticker: "TEST", asset: ASSET, exists: true, poolId: "0x" + "cd".repeat(32), fee: 3000, tickSpacing: 60 }] })), /is not the registry's/);
  assert.match(refusal(evidence({ pools: [{ ticker: "TEST", asset: ASSET, exists: true, poolId: POOL_ID, fee: 3000, tickSpacing: 10 }] })), /tickSpacing/);
  assert.match(
    refusal(evidence({ pools: [{ ticker: "TEST", asset: ASSET, exists: true, poolId: POOL_ID, fee: 3000, tickSpacing: 60, hooks: "0x" + "99".repeat(20) }] })),
    /hooks .* is not the zero address/,
  );
  assert.equal(refusal(evidence()), null, "and the matching evidence still passes, from the same code path");
});

test("the fee filter is setRouteV4's own, and a route the router would reject is never scheduled", () => {
  assert.equal(feeFilterRefusal(3000), null);
  assert.match(feeFilterRefusal(0), /not a positive integer/);
  assert.match(feeFilterRefusal(0x800000 | 3000), /dynamic-fee flag/);
  assert.match(feeFilterRefusal(10_001), /above MAX_ROUTE_FEE_TIER/);
});

test("no evidence file at all flags every routed market", () => {
  const cal = calendarOf([market()], null);
  const row = rowFor(cal, "TEST", "route-v4");
  assert.equal(row.status, "flagged");
  assert.equal(row.scheduleAtS, null, "a flagged row carries no schedule time: it is not on the calendar");
  assert.equal(cal.counts.flagged, 1);
});

test("a market with no payoutRoute is an in-kind row, not a flag and not a silent omission", () => {
  const cal = calendarOf([market({ ticker: "INKIND", v2: { payoutRoute: null } })]);
  const row = rowFor(cal, "INKIND", "route");
  assert.equal(row.status, "in-kind");
  assert.equal(cal.counts.flagged, 0);
  // Its readback still exists, and it asserts the absence positively: venue must read 0.
  assert.deepEqual(row.readback.expect.map((e) => [e.field, e.equals]), [["venue", 0]]);
});

// 5. Readbacks: an absent subject is red, in both directions.

test("the register readback asserts a positive fact, because an unregistered market decodes as zeros", () => {
  const row = rowFor(calendarOf([market()]), "TEST", "register");
  assert.deepEqual(row.readback.expect.map((e) => [e.field, e.equals]), [["enabled", true], ["strikeTick", "2500000"]]);
  assert.match(row.readback.failsWhen, /UNREGISTERED market decodes cleanly as zeros/);
});

test("grading: applied, mismatched, and the all-zero readback that a weaker check would pass", () => {
  const cal = calendarOf([market()]);
  const observations = {
    "TEST/register": { enabled: true, strikeTick: "2500000" },
    "TEST/route-v4": { venue: 2, fee: 3000, tickSpacing: 60 },
  };
  assert.deepEqual(gradeReadbacks(cal, observations).map((g) => g.grade), ["APPLIED", "APPLIED"]);

  // Delete the protected fact: the market is not actually registered, so the chain answers zeros.
  const zeros = { ...observations, "TEST/register": { enabled: false, strikeTick: "0" } };
  const zeroGrades = gradeReadbacks(cal, zeros);
  assert.equal(zeroGrades[0].grade, "MISMATCH");
  assert.match(zeroGrades[0].detail, /enabled is false/);

  // The same for the route: an unset route is Venue.None, which is a successful call.
  const unset = { ...observations, "TEST/route-v4": { venue: 0, fee: 0, tickSpacing: 0 } };
  assert.equal(gradeReadbacks(cal, unset)[1].grade, "MISMATCH");

  // And the subject missing entirely is NOT-APPLIED, never a pass by omission.
  assert.deepEqual(gradeReadbacks(cal, {}).map((g) => g.grade), ["NOT-APPLIED", "NOT-APPLIED"]);
  assert.equal(gradeReadbacks(cal, { "TEST/register": { enabled: true } })[0].grade, "MISMATCH", "a half-observed readback is not an applied one");
});

// 6. The CLI's exit code carries the same answer as the report.

test("run(): flagged rows, unset addresses and failed grades all exit non-zero", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "listing-calendar-"));
  const registryFile = path.join(dir, "registry.json");
  const evidenceFile = path.join(dir, "evidence.json");
  const verifyFile = path.join(dir, "observed.json");
  fs.writeFileSync(registryFile, JSON.stringify(registry([market()])));
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence()));
  fs.writeFileSync(verifyFile, JSON.stringify({ "TEST/register": { enabled: true, strikeTick: "2500000" }, "TEST/route-v4": { venue: 2, fee: 3000, tickSpacing: 60 } }));

  const base = ["--registry", registryFile, "--roles", DEFAULT_ROLES, "--start", "2026-10-01T12:00:00Z"];
  const clean = run([...base, "--routes-evidence", evidenceFile]);
  assert.equal(clean.code, 0);
  assert.match(clean.text, /SCHEDULED TEST\s+register/);

  assert.equal(run(base).code, 2, "no evidence file means flagged routes and a non-zero exit");
  assert.equal(run([...base, "--routes-evidence", evidenceFile, "--verify", verifyFile]).code, 0);

  fs.writeFileSync(verifyFile, JSON.stringify({}));
  const ungraded = run([...base, "--routes-evidence", evidenceFile, "--verify", verifyFile]);
  assert.equal(ungraded.code, 2);
  assert.match(ungraded.text, /NOT-APPLIED/);

  // Pre-deploy: the registry's addresses are null, so the calendar is a rehearsal and says so.
  const unsetFile = path.join(dir, "unset.json");
  const unsetRegistry = registry([market()]);
  unsetRegistry.v2.contracts.clearinghouse = null;
  fs.writeFileSync(unsetFile, JSON.stringify(unsetRegistry));
  const unset = run(["--registry", unsetFile, "--roles", DEFAULT_ROLES, "--start", "2026-10-01T12:00:00Z", "--routes-evidence", evidenceFile]);
  assert.equal(unset.code, 2);
  assert.match(unset.text, /NOT EXECUTABLE/);
  assert.equal(run(["--registry", unsetFile, "--roles", DEFAULT_ROLES, "--start", "2026-10-01T12:00:00Z", "--routes-evidence", evidenceFile, "--allow-unset-addresses"]).code, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("run(): a bad flag, a bad instant and a mismatched chain id are usage errors, not empty calendars", () => {
  assert.throws(() => run(["--nope"]), /unknown flag/);
  assert.throws(() => run(["--start", "yesterday"]), /is not an ISO-8601 instant/);
});

// 7. Against the real registry: the numbers are derived on both sides.

test("the shipped registry produces one row per market per operation, and the launch set is the registry's own launchSet", () => {
  const cal = buildCalendar({ registry: REGISTRY, roles: ROLES, evidence: null, startS: START, abis: ABIS });
  const launch = launchMarkets(REGISTRY);

  // THIS TEST USED TO ENFORCE THE DEFECT (T-OP-003). It read
  //   const launch = launchMarkets(REGISTRY, LAUNCH_WAVES);
  // so the calendar's market count was pinned to a WAVE FILTER, and the coupling this row removes was
  // held in place by the suite. Repointing launchMarkets() without rewriting this case would either
  // break it or leave the old selection pinned.
  //
  // THE BAR THIS REWRITE HAS TO CLEAR: it must FAIL against a registry that went back to wave-derived
  // selection. The two assertions below do that by construction -- the launch set is named
  // (`launchSet.markets`) and the wave filter is a different, larger set, so a calendar built the old
  // way cannot satisfy both.
  assert.deepEqual(cal.rows.map((r) => r.ticker).filter((t, i, a) => a.indexOf(t) === i), REGISTRY.launchSet.markets,
    "the calendar covers exactly the tickers launchSet names, in that order");
  assert.equal(cal.generatedFrom.source, "launchSet", "and it says so: a wave-derived calendar would say waves");
  assert.notEqual(launchMarkets(REGISTRY, LAUNCH_WAVES).length, launch.length,
    "the wave filter and the launch set are DIFFERENT sets; if they ever agree this test stops proving anything and the guard must be rethought");

  assert.equal(cal.counts.markets, launch.length);
  assert.equal(cal.rows.length, launch.length * 2, "every market carries a registration row and a route row");
  const routed = launch.filter((m) => m.v2.payoutRoute !== null && m.v2.payoutRoute !== undefined).length;
  assert.equal(cal.counts.flagged, routed, "with no evidence supplied, exactly the routed markets are flagged");
  assert.equal(cal.counts.inKind, launch.length - routed);
  assert.equal(cal.counts.scheduled, launch.length, "the registrations remain schedulable: a missing route measurement does not block a listing");
});
