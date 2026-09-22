/**
 * ops/markets/univ3-liquidity.test.mjs — T-216-O8-UNIV3-LIQUIDITY-INPUT-SET.
 *
 *   node --test ops/markets/univ3-liquidity.test.mjs
 *
 * The green — all 13 rows reconcile — is the easy half and proves almost nothing on its own. What
 * these tests are really for is the two reds the task contract names: an ALTERED perClose value and
 * a DELETED perClose entry must each be caught, by ticker. A checker that sees the first and not the
 * second is the defect class this build has hit eleven times, and it is the likelier of the two to
 * ship, because recomputing from `perClose` catches a wrong number for free while a missing one
 * quietly shrinks the thing being recomputed over.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DATASET,
  OFFLINE_LIMITS,
  SESSIONS,
  ageInDays,
  deriveRows,
  isMeasured,
  measuredAt,
  measuredTickers,
  recompute,
  requireFresh,
  verify,
} from "./univ3-liquidity.mjs";

const load = () => JSON.parse(readFileSync(DATASET, "utf8"));
const loadSessions = () => JSON.parse(readFileSync(SESSIONS, "utf8"));

const EXPECTED = ["AAPL", "AMZN", "CRCL", "GME", "GOOGL", "MSFT", "MU", "NVDA", "QQQ", "SGOV", "SPCX", "TSLA", "USO"];

test("GREEN: the committed dataset reconciles completely", () => {
  assert.deepEqual(verify(load()), []);
});

test("coverage is exactly the 13 measured tickers, by name", () => {
  const d = load();
  assert.deepEqual(measuredTickers(d).slice().sort(), EXPECTED.slice().sort());
  assert.equal(d.rows.length, 13);
  assert.deepEqual(d.rows.map((r) => r.ticker).slice().sort(), EXPECTED.slice().sort());
});

test("a market outside the list is UNMEASURED, which is not a zero and not a default", () => {
  const d = load();
  for (const t of EXPECTED) assert.equal(isMeasured(d, t), true);
  // Every other Tier-1 market OWN8-06 might register.
  for (const t of ["AMD", "CRWV", "ORCL", "SNDK", "META", "NFLX"]) {
    assert.equal(isMeasured(d, t), false, `${t} must be unmeasured`);
  }
});

test("RED 1 — an ALTERED perClose value is caught, naming the ticker", () => {
  const d = load();
  const row = d.rows.find((r) => r.ticker === "AAPL");
  const date = row.minAt;
  // Raise the minimum close above the floor: the minimum, its date and the fails count all move.
  row.perClose[date] = (BigInt(row.floorSet) * 10n).toString();

  const problems = verify(d);
  assert.ok(problems.length > 0, "an altered value must not pass");
  assert.ok(problems.every((p) => p.ticker === "AAPL"), "only the altered row may be implicated");
  const fields = problems.map((p) => p.field);
  assert.ok(fields.includes("minHarmonicLiquidity"));
  assert.ok(fields.includes("minAt"));
  assert.ok(fields.includes("failsOfSessions"));
});

test("RED 2 — a DELETED perClose entry is caught, naming the ticker and the close", () => {
  const d = load();
  const row = d.rows.find((r) => r.ticker === "TSLA");
  // Deliberately delete a NON-minimum close. This is the case recomputation alone would miss:
  // the smallest value is still the smallest, so min and minAt are unchanged.
  const victim = Object.keys(row.perClose).find((k) => k !== row.minAt);
  assert.ok(victim, "fixture must have a non-minimum close or this test proves nothing");
  const before = recompute(row);
  delete row.perClose[victim];
  const after = recompute(row);
  assert.equal(after.minHarmonicLiquidity, before.minHarmonicLiquidity, "precondition: the minimum did not move");
  assert.equal(after.minAt, before.minAt, "precondition: the minimum's date did not move");

  const problems = verify(d);
  assert.ok(problems.length > 0, "a deleted close must not pass");
  assert.ok(problems.every((p) => p.ticker === "TSLA"));
  const missing = problems.find((p) => p.field === `perClose.${victim}`);
  assert.ok(missing, `the missing close ${victim} must be named`);
  assert.equal(missing.actual, "MISSING");
});

test("RED 2b — deleting a close is caught even when the fails COUNT is unchanged", () => {
  // The denominator of failsOfSessions moves when an entry is deleted, so that field would flag it
  // as a side effect. This pins that the explicit presence check is doing the work, not luck:
  // the perClose.<date> MISSING problem must be present independently.
  const d = load();
  const row = d.rows.find((r) => r.ticker === "GOOGL");
  const victim = Object.keys(row.perClose).find((k) => k !== row.minAt);
  delete row.perClose[victim];
  const problems = verify(d).filter((p) => p.ticker === "GOOGL");
  assert.ok(problems.some((p) => p.field === `perClose.${victim}` && p.actual === "MISSING"));
});

test("RED 3 — an undeclared extra close is caught too", () => {
  const d = load();
  d.rows.find((r) => r.ticker === "MU").perClose["2026-09-18"] = "1";
  const problems = verify(d).filter((p) => p.ticker === "MU");
  assert.ok(problems.some((p) => p.field === "perClose.2026-09-18" && p.actual === "UNDECLARED"));
});

test("RED 4 — an emptied closes list refuses rather than passing every row vacuously", () => {
  // With no declared closes there is no subject, and a per-row loop over an empty list would
  // silently approve everything. The checker must stop instead.
  const d = load();
  d.closes = [];
  const problems = verify(d);
  assert.ok(problems.length > 0);
  assert.equal(problems[0].field, "closes");
});

test("recompute mirrors the data rather than restating it", () => {
  for (const row of load().rows) {
    const got = recompute(row);
    assert.equal(got.minHarmonicLiquidity, row.minHarmonicLiquidity, row.ticker);
    assert.equal(got.minAt, row.minAt, row.ticker);
    assert.equal(got.sessions, row.sessions, row.ticker);
    assert.equal(got.failsOfSessions, row.failsOfSessions, row.ticker);
    // The fails count is decided by floorSet, so it must actually reference it.
    const fails = Number(row.failsOfSessions.split("/")[0]);
    const below = Object.values(row.perClose).filter((v) => BigInt(v) < BigInt(row.floorSet)).length;
    assert.equal(fails, below, row.ticker);
  }
});

test("the dataset carries its own provenance and says it is a snapshot", () => {
  const d = load();
  assert.equal(d.asOf, "2026-09-17");
  assert.equal(d.isSnapshot, true);
  assert.match(d.snapshotWarning, /DOES NOT REFRESH ITSELF/);
  assert.match(d.snapshotWarning, /owner RPC gate/);
  assert.match(d.source.recon, /VENUE-RECON-2026-09-17\.md section 5\.1/);
  assert.ok(d.source.originalPath.endsWith("16-minliquidity.json"));
  assert.match(d.source.originalSha256, /^[0-9a-f]{64}$/);
  assert.equal(d.closes.length, 11);
  assert.equal(d.closes[0], "2026-09-17");
  assert.equal(d.closes.at(-1), "2026-09-02");
  // The missing original script is disclosed in the file, not only in a commit message.
  assert.match(d.source.producingScript, /NOT PRESERVED/);
  assert.equal(d.source.networkCallsMade, "NONE. This file was assembled offline from files that already existed.");
});

test("the derivation reproduces the committed rows exactly from the landed upstream series", () => {
  const d = load();
  const rows = deriveRows(loadSessions(), d);
  assert.deepEqual(rows, d.rows);
});

test("the derivation reads the upstream series rather than echoing the dataset back", () => {
  // Without this, deriveRows could pass by copying `previous` and the reproduction would be circular.
  const sessions = loadSessions();
  const victim = sessions.rows.find((r) => r.ticker === "NVDA");
  const date = Object.keys(victim.series).find((k) => victim.series[k]?.ok);
  victim.series[date].harmonicLiquidity = "1";
  const rows = deriveRows(sessions, load());
  const nvda = rows.find((r) => r.ticker === "NVDA");
  assert.equal(nvda.perClose[date], "1", "a change upstream must appear downstream");
  assert.equal(nvda.minHarmonicLiquidity, "1");
  assert.equal(nvda.minAt, date);
});

test("floors are NOT derived here and the registry is NOT touched", () => {
  // T-200 owns the floors. This row lands data only, and `floorSet` is the value the registry
  // already carried at recon time — context for the fails count, never a recommendation.
  const d = load();
  const src = readFileSync(new URL("./univ3-liquidity.mjs", import.meta.url), "utf8");
  assert.ok(!src.includes("tier1.json"), "the input-set tooling must not reference the registry");
  assert.match(d._readme, /does NOT derive floors/);
  assert.match(d.fields.floorSet, /NOT a recommendation/);
});

/*//////////////////////////////////////////////////////////////
        THE FRESHNESS GATE (T-234) — staleness must be VISIBLE
//////////////////////////////////////////////////////////////*/

/**
 * The dataset has always carried `asOf` and a snapshotWarning saying it does not refresh itself, and
 * nothing in the module read either. So every consumer received a frozen number with the same
 * confidence as a live one, and that failure is silent by construction: a stale liquidity figure is a
 * plausible liquidity figure. These pin the refusal, not a warning.
 */
const AS_OF = Date.parse("2026-09-17T00:00:00Z");
const DAYS = 86_400_000;

test("a caller that does not state a tolerance is REFUSED, because omission is how stale passes for fresh", () => {
  assert.throws(() => requireFresh(load()), /explicit maxAgeDays/);
});

test("a snapshot older than the caller allows is REFUSED, and the message says what a refresh needs", () => {
  const dataset = load();
  assert.throws(
    () => requireFresh(dataset, { now: AS_OF + 4 * DAYS, maxAgeDays: 1 }),
    (error) => /REFUSING/.test(error.message) && /owner-gated network action/.test(error.message),
  );
});

test("inside the tolerance it passes and returns the age rather than a bare boolean", () => {
  const age = requireFresh(load(), { now: AS_OF + 2 * DAYS, maxAgeDays: 3 });
  assert.equal(Math.round(age), 2);
});

test("Infinity is an EXPLICIT opt-out: re-deriving committed arithmetic does not care about age", () => {
  assert.equal(Math.round(requireFresh(load(), { now: AS_OF + 999 * DAYS, maxAgeDays: Infinity })), 999);
});

test("a dataset that will not say when it was measured is refused rather than treated as fresh", () => {
  const dataset = load();
  delete dataset.asOf;
  assert.throws(() => measuredAt(dataset), /no usable asOf/);
  const malformed = { ...load(), asOf: "last Tuesday" };
  assert.throws(() => measuredAt(malformed), /no usable asOf/);
});

test("an asOf in the future is a fault, not a very fresh measurement", () => {
  assert.throws(() => ageInDays(load(), AS_OF - 1 * DAYS), /in the future/);
});

/**
 * The offline limits are DATA rather than a comment, so a launch pass can assert against them and a
 * drifting comment cannot quietly become wrong. Each entry must say what it needs, or it is a
 * complaint rather than an instruction.
 */
test("every offline limit names the fact, the reason and what obtaining it requires", () => {
  assert.ok(OFFLINE_LIMITS.length >= 4);
  for (const limit of OFFLINE_LIMITS) {
    for (const field of ["fact", "why", "needs"]) {
      assert.equal(typeof limit[field], "string", `${limit.fact}: ${field}`);
      assert.ok(limit[field].length > 20, `${limit.fact}: ${field} is too short to act on`);
    }
  }
  assert.ok(
    OFFLINE_LIMITS.every((limit) => /RPC|network|gate|read/i.test(limit.needs)),
    "a limit that does not name a network action is not an offline limit",
  );
});
