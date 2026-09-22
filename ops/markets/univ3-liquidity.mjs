/**
 * ops/markets/univ3-liquidity.mjs — integrity check and derivation for the measured UniV3
 * pool-liquidity input set (T-216-O8-UNIV3-LIQUIDITY-INPUT-SET).
 *
 *   node ops/markets/univ3-liquidity.mjs              # verify the committed dataset
 *   node ops/markets/univ3-liquidity.mjs --derive     # regenerate it from the upstream sessions file
 *   node --test ops/markets/univ3-liquidity.test.mjs
 *
 * WHAT THIS IS FOR. T-200 derives the v8 `univ3MinLiquidity` floors from this dataset. A wrong input
 * set is a pinned-constant failure by another name: the floors would be computed correctly from the
 * wrong numbers, and the consequence is silent — a market whose pool cannot meet its floor drops to
 * the 6 h settlement path instead of the TWAP path and looks like normal operation.
 *
 * SO THE DATASET IS SELF-VERIFYING. Every derived field recomputes from `perClose`:
 * `minHarmonicLiquidity` is its smallest value, `minAt` the date that value sits at, `sessions` its
 * entry count, and `failsOfSessions` how many entries fall below `floorSet`.
 *
 * THE CHECK THAT MATTERS MOST IS THE ONE FOR A MISSING ENTRY. Recomputing from `perClose` alone
 * catches a value that was ALTERED, because the recomputation disagrees. It does not reliably catch
 * a value that was DELETED: drop a non-minimum close and the minimum is still the minimum. The
 * denominator of `failsOfSessions` would move, but relying on that is relying on a side effect. So
 * every row's `perClose` key set is compared against the file's own declared `closes` list, and a
 * row missing a close is named. That is the difference between a checker that sees a wrong value and
 * one that sees an absent subject — this build has produced eleven of the latter.
 *
 * NOT THE ORIGINAL MEASUREMENT SCRIPT. The recon that produced these numbers kept a `.mjs` for every
 * step from 01 to 15; step 16 kept only its `.json`, and its `INDEX.json` documents files through 13
 * only. The script that emitted the derived file was never saved and could not be landed. `--derive`
 * below was written on 2026-09-20 for this task. It reproduces the derived file from the landed
 * upstream series, which is what "reproducible in principle" can honestly mean here — it is NOT a
 * reconstruction of the original presented as the original.
 *
 * OFFLINE BY CONSTRUCTION. No RPC, no explorer, no API. Re-MEASUREMENT (as opposed to re-derivation)
 * needs historical pool reads and therefore the owner RPC gate, which this task did not have.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DATASET = path.join(HERE, "univ3-liquidity-2026-09-17.json");
export const SESSIONS = path.join(HERE, "univ3-liquidity-sessions-2026-09-17.json");

/**
 * The tickers this snapshot measures, and the only ones it may ever speak for.
 *
 * Read from the dataset rather than written here, so the list cannot drift from the rows. Anything
 * absent is UNMEASURED and must be recorded as unmeasured — never defaulted to a floor, never
 * interpolated, never given a neighbour's value.
 */
/**
 * THE FRESHNESS GATE (T-234). The dataset records `asOf` and says in its own `snapshotWarning` that it
 * is a FROZEN snapshot which does not refresh itself - and until now nothing in this file read either
 * field. Every consumer therefore got a two-day-old number with the same confidence as a live one, and
 * the failure is silent by construction: a stale liquidity figure is a plausible liquidity figure.
 *
 * `measuredAt` surfaces the age. `requireFresh` REFUSES rather than warning, because a warning on a
 * number that is already being used is a warning nobody reads. The caller chooses the tolerance: a
 * launch gate may demand hours, a re-derivation of committed arithmetic may not care at all and can
 * pass `Infinity` deliberately rather than by omission.
 *
 * WHAT THIS DOES NOT DO, and cannot: it does not refresh anything. Re-measurement needs live UniV3
 * reads at historical blocks, which is an owner-gated network action this task does not carry. See
 * `OFFLINE-LIMITS` below for the exact list of facts that are unobtainable without it.
 */
export function measuredAt(dataset) {
  const raw = dataset?.asOf;
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error("dataset has no usable asOf: refusing to reason about the age of a measurement that will not say when it was taken");
  }
  const at = Date.parse(`${raw}T00:00:00Z`);
  if (Number.isNaN(at)) throw new Error(`dataset asOf ${raw} is not a date`);
  return at;
}

/** Age of the snapshot in whole days at `now`. Negative would mean a future asOf, which is a fault. */
export function ageInDays(dataset, now = Date.now()) {
  const age = (now - measuredAt(dataset)) / 86_400_000;
  if (age < 0) throw new Error(`dataset asOf ${dataset.asOf} is in the future relative to now: refusing`);
  return age;
}

/**
 * Refuse a snapshot older than the caller allows. `maxAgeDays: Infinity` is an explicit opt-out and is
 * the only way to skip the check - there is no default that silently permits any age, because that is
 * what the file did before this existed.
 */
export function requireFresh(dataset, { now = Date.now(), maxAgeDays } = {}) {
  if (maxAgeDays === undefined) {
    throw new Error("requireFresh needs an explicit maxAgeDays: omitting it is how a stale snapshot passes for a fresh one");
  }
  const age = ageInDays(dataset, now);
  if (age > maxAgeDays) {
    throw new Error(
      `dataset was measured ${age.toFixed(1)} day(s) ago (asOf ${dataset.asOf}) and the caller allows ${maxAgeDays}: ` +
        "REFUSING. This file cannot refresh itself - re-measurement needs live UniV3 reads at historical blocks, " +
        "which is an owner-gated network action. See OFFLINE_LIMITS in this module for what a refresh requires.",
    );
  }
  return age;
}

/**
 * The facts this tool CANNOT obtain offline, each with what it would take, so a launch pass can run
 * them in one sitting rather than rediscovering the shape. Exported as data so it can be printed and
 * asserted against rather than living in a comment that drifts.
 */
export const OFFLINE_LIMITS = [
  {
    fact: "current in-range liquidity per pool",
    why: "the committed dataset is a frozen snapshot of 11 closes ending at its asOf; nothing in it describes today",
    needs: "an RPC endpoint for chain 4663, a block number, and the owner's per-task network gate",
  },
  {
    fact: "time-weighted harmonic liquidity for any close after the snapshot window",
    why: "reconstruction reads observe() where the observation ring still reaches and Swap logs elsewhere; both are chain reads",
    needs: "the same RPC endpoint plus the historical blocks bracketing each close",
  },
  {
    fact: "price impact at a given trade size",
    why: "impact needs tick-level liquidity distribution; the snapshot carries aggregate figures only, so it cannot be computed from what is committed at any precision",
    needs: "a live pool read of the tick bitmap, or a quoter call, both network actions",
  },
  {
    fact: "whether a pool's observation cardinality has grown since the snapshot",
    why: "cardinality changes when anyone pays to grow it, and the snapshot records the value at asOf only",
    needs: "an RPC read of slot0 per pool",
  },
];

export function measuredTickers(dataset) {
  return dataset.coverage.measured;
}

/** `true` when this market has a measured series; `false` means UNMEASURED, which is not a zero. */
export function isMeasured(dataset, ticker) {
  return measuredTickers(dataset).includes(ticker);
}

const asBig = (v) => BigInt(v);

/** Recompute every derived field of one row from its own `perClose` and `floorSet`. */
export function recompute(row) {
  const entries = Object.entries(row.perClose);
  let minAt = null;
  let min = null;
  for (const [date, value] of entries) {
    const v = asBig(value);
    // Strictly-less keeps the FIRST date of a tie, matching the recon's own ordering.
    if (min === null || v < min) {
      min = v;
      minAt = date;
    }
  }
  const floor = asBig(row.floorSet);
  const fails = entries.filter(([, v]) => asBig(v) < floor).length;
  return {
    minHarmonicLiquidity: min === null ? null : min.toString(),
    minAt,
    sessions: entries.length,
    failsOfSessions: `${fails}/${entries.length}`,
  };
}

/**
 * Every disagreement in the dataset, as `{ ticker, field, expected, actual }`.
 *
 * An empty array is the green. It is only meaningful because the reds below are reachable: a checker
 * that cannot fail is indistinguishable from one that cannot see its input.
 */
export function verify(dataset) {
  const problems = [];
  const closes = dataset.closes;

  if (!Array.isArray(closes) || closes.length === 0) {
    problems.push({ ticker: "(file)", field: "closes", expected: "a non-empty list of close dates", actual: JSON.stringify(closes) });
    return problems; // Without the declared closes there is no subject to check rows against.
  }
  if (!Array.isArray(dataset.rows) || dataset.rows.length === 0) {
    problems.push({ ticker: "(file)", field: "rows", expected: "at least one row", actual: String(dataset.rows?.length) });
    return problems;
  }
  if (dataset.rows.length !== dataset.coverage.measuredCount) {
    problems.push({ ticker: "(file)", field: "coverage.measuredCount", expected: String(dataset.rows.length), actual: String(dataset.coverage.measuredCount) });
  }

  for (const row of dataset.rows) {
    const t = row.ticker;

    // THE MISSING-ENTRY CHECK. Recomputation alone would not catch a deleted non-minimum close.
    const have = Object.keys(row.perClose);
    for (const date of closes) {
      if (!have.includes(date)) {
        problems.push({ ticker: t, field: `perClose.${date}`, expected: "a measured value at this close", actual: "MISSING" });
      }
    }
    for (const date of have) {
      if (!closes.includes(date)) {
        problems.push({ ticker: t, field: `perClose.${date}`, expected: "a date in the file's declared closes", actual: "UNDECLARED" });
      }
    }

    const got = recompute(row);
    for (const field of ["minHarmonicLiquidity", "minAt", "sessions", "failsOfSessions"]) {
      if (String(row[field]) !== String(got[field])) {
        problems.push({ ticker: t, field, expected: String(got[field]), actual: String(row[field]) });
      }
    }

    if (!measuredTickers(dataset).includes(t)) {
      problems.push({ ticker: t, field: "coverage.measured", expected: "the ticker to be listed as measured", actual: "absent" });
    }
  }

  return problems;
}

/**
 * Regenerate the derived rows from the upstream session series.
 *
 * Written 2026-09-20 for T-216-O8-UNIV3-LIQUIDITY-INPUT-SET. This is NOT the recon's own step-16
 * script, which was never saved — see the header. It exists so the derived file is reproducible
 * offline from a landed input rather than being a number nobody can re-obtain.
 */
export function deriveRows(sessions, previous) {
  const prior = new Map((previous?.rows ?? []).map((r) => [r.ticker, r]));
  return sessions.rows.map((r) => {
    const perClose = {};
    for (const [date, s] of Object.entries(r.series)) {
      if (s?.ok) perClose[date] = s.harmonicLiquidity;
    }
    const base = { ticker: r.ticker, pool: r.pool, floorSet: r.univ3MinLiquidity, perClose };
    const derived = recompute(base);
    const before = prior.get(r.ticker);
    return {
      ticker: base.ticker,
      pool: base.pool,
      floorSet: base.floorSet,
      sessions: derived.sessions,
      minHarmonicLiquidity: derived.minHarmonicLiquidity,
      minAt: derived.minAt,
      failsOfSessions: derived.failsOfSessions,
      // Recon working values. They are not recomputable from perClose alone, so they are carried
      // through verbatim rather than invented; a derive run that cannot find them says so.
      reDerivedAt250kUsdg: before?.reDerivedAt250kUsdg ?? null,
      suggestedHalfOfMin: before?.suggestedHalfOfMin ?? null,
      perClose,
    };
  });
}

function main(argv) {
  const dataset = JSON.parse(readFileSync(DATASET, "utf8"));

  if (argv.includes("--offline-limits")) {
    console.log("univ3-liquidity: facts this tool CANNOT obtain offline, and what each needs:");
    for (const limit of OFFLINE_LIMITS) {
      console.log(`  ${limit.fact}`);
      console.log(`    why:   ${limit.why}`);
      console.log(`    needs: ${limit.needs}`);
    }
    return 0;
  }

  if (argv.includes("--derive")) {
    const sessions = JSON.parse(readFileSync(SESSIONS, "utf8"));
    const rows = deriveRows(sessions, dataset);
    const next = { ...dataset, rows };
    const same = JSON.stringify(rows) === JSON.stringify(dataset.rows);
    if (argv.includes("--write")) {
      writeFileSync(DATASET, JSON.stringify(next, null, 2) + "\n");
      console.log(`univ3-liquidity: wrote ${path.relative(process.cwd(), DATASET)}`);
      return 0;
    }
    console.log(`univ3-liquidity: derived ${rows.length} row(s) from the upstream series.`);
    console.log(same ? "  MATCHES the committed dataset exactly." : "  DIFFERS from the committed dataset — inspect before writing.");
    return same ? 0 : 1;
  }

  // --max-age-days <n> makes the caller state its tolerance; without it the age is REPORTED but not
  // enforced, because `verify` checks committed arithmetic, which is true whatever the snapshot's age.
  const maxAgeIndex = argv.indexOf("--max-age-days");
  if (maxAgeIndex !== -1) {
    const value = Number(argv[maxAgeIndex + 1]);
    if (!Number.isFinite(value) || value < 0) {
      console.error("univ3-liquidity: --max-age-days needs a non-negative number of days");
      return 1;
    }
    try {
      requireFresh(dataset, { maxAgeDays: value });
    } catch (error) {
      console.error(`univ3-liquidity: ${error.message}`);
      return 1;
    }
  }

  const problems = verify(dataset);
  if (problems.length === 0) {
    console.log(`univ3-liquidity: OK — ${dataset.rows.length} rows, ${dataset.closes.length} closes, every derived field recomputes.`);
    // Always printed, never inferred: a reader who sees only OK would take the numbers as current.
    console.log(`  MEASURED ${ageInDays(dataset).toFixed(1)} DAY(S) AGO (asOf ${dataset.asOf}) — this file cannot refresh itself.`);
    console.log(`  ${OFFLINE_LIMITS.length} fact(s) require a live read and an owner gate; run with --offline-limits to list them.`);
    console.log(`  measured: ${measuredTickers(dataset).join(", ")}`);
    console.log("  every other market is UNMEASURED and must be recorded as such.");
    return 0;
  }
  console.error(`univ3-liquidity: FAILED — ${problems.length} problem(s).`);
  for (const p of problems) console.error(`  ${p.ticker}  ${p.field}: expected ${p.expected}, found ${p.actual}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
