/**
 * univ3MinLiquidity floors for the v8 registry (T-200-O8-UNIV3-LIQUIDITY-FLOORS).
 *
 * THE FORMULA IS MIRRORED FROM ops/markets/README.md, NOT RE-DERIVED. The README is the authority:
 *
 *     univ3MinLiquidity = floor(liquidity x 250,000 / usdgDepth), rounded DOWN to two significant figures
 *
 * "the in-range liquidity at which the pool's USDG balance would sit exactly at the recon's
 * 250,000-USDG usable threshold". It enforces the rule that made the pool usable, in the unit the
 * contract checks. A different statistic would silently disagree with the two markets already set.
 *
 * WHAT THIS MODULE DOES NOT DO, and each is a decision rather than an omission:
 *   - It does not set a floor for a market whose pool cannot be used. The contract requires
 *     MIN_POOL_OBSERVATION_CARDINALITY = 2401 observation slots; a pool below that is refused by
 *     UniV3TwapSource.setPool whatever its depth, so a floor for it would be a number with no
 *     subject. `qualifies()` is that test and it is deliberately separate from the arithmetic.
 *   - It does not take a floor from one session's minimum, and it does not copy the input set's
 *     `suggestedHalfOfMin` or `reDerivedAt250kUsdg`. T-216-O8's author established that neither is
 *     recomputable from `perClose` and that nothing verifies them.
 *   - It does not interpolate, default, or carry a neighbour's value to an unmeasured market. The
 *     input set's own coverage rule forbids it: exactly 13 tickers are measured and every other
 *     market is unmeasured, which is a state, not a missing number.
 *
 * THE DIRECTION OF THE ERROR IS THE THING TO UNDERSTAND. The scaling assumes the positions' shape
 * does not change, so a floor is an estimate. Set it too HIGH and the pool's own measured liquidity
 * falls under it, the Uniswap source reports not-ok, and settlement drops to Chainlink alone -
 * uncorroborated and delayed - while looking like normal operation. That is why `report()` prints
 * how close each market sits to its floor rather than only whether it passes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARKETS = path.join(HERE, "..", "markets");

export const DATASET = path.join(MARKETS, "univ3-liquidity-2026-09-17.json");
export const SESSIONS = path.join(MARKETS, "univ3-liquidity-sessions-2026-09-17.json");
export const REGISTRY = path.join(MARKETS, "tier1.json");

/** The contract's gate (UniV3TwapSource / MIN_POOL_OBSERVATION_CARDINALITY). Mirrored, not chosen. */
export const MIN_POOL_OBSERVATION_CARDINALITY = 2401;

/** The recon's usable-pool threshold, in whole USDG. The README's formula is stated against it. */
export const USABLE_USDG_THRESHOLD = 250_000;

export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/**
 * Round DOWN to two significant figures, as the README specifies. Down, never nearest: rounding a
 * floor up moves it toward the failure direction described in this file's header.
 */
export function twoSignificantFiguresDown(value) {
  const n = BigInt(value);
  if (n <= 0n) return 0n;
  const digits = n.toString().length;
  if (digits <= 2) return n;
  const scale = 10n ** BigInt(digits - 2);
  return (n / scale) * scale;
}

/**
 * The README's formula, and nothing more. `liquidity` and `usdgDepth` are the pool's observed pair;
 * the caller decides which liquidity reading to supply and must say which it used.
 */
export function floorFrom(liquidity, usdgDepthUsdg) {
  const l = BigInt(liquidity);
  const depth = Number(usdgDepthUsdg);
  if (!Number.isFinite(depth) || depth <= 0) {
    throw new Error(`usdgDepth must be a positive number of USDG, received ${usdgDepthUsdg}`);
  }
  // Scale in integer space: multiply first, then divide, so the floor is taken once and at the end.
  const scaled = (l * BigInt(USABLE_USDG_THRESHOLD) * 1_000_000n) / BigInt(Math.round(depth * 1_000_000));
  return twoSignificantFiguresDown(scaled);
}

/**
 * Whether a measured pool can carry a floor at all. Depth alone is not enough: a pool the contract
 * refuses cannot be the subject of a floor, and recording one would assert a usability the chain
 * does not have.
 */
export function qualifies(row) {
  const reasons = [];
  const card = Number(row.card ?? 0);
  if (card < MIN_POOL_OBSERVATION_CARDINALITY) {
    reasons.push(
      `observation cardinality ${card} is below the contract's ${MIN_POOL_OBSERVATION_CARDINALITY}; ` +
        `${row.growSlotsTo2401 ?? "?"} slots short` +
        (row.growCostEth == null ? "" : `, ~${row.growCostEth} ETH to buy`),
    );
  }
  if (Number(row.quoteUsd ?? 0) < USABLE_USDG_THRESHOLD) {
    reasons.push(`USDG depth ${Math.round(Number(row.quoteUsd ?? 0))} is below the ${USABLE_USDG_THRESHOLD} usable threshold`);
  }
  if (row.observe1800Now !== true) reasons.push("the ring does not reach the 1800 s settlement window");
  if (Number(row.corroborationFails ?? 0) > 0) reasons.push(`${row.corroborationFails} corroboration failures against Chainlink`);
  return { ok: reasons.length === 0, reasons };
}

/**
 * One row per MEASURED ticker: whether it qualifies, and if so what the floor would be from the
 * measured statistic the contract actually gates. Markets absent from the input set are not
 * included at all - unmeasured is a state, not a zero.
 */
export function assess({ sessions = readJson(SESSIONS), registry = readJson(REGISTRY) } = {}) {
  const current = new Map(registry.markets.map((m) => [m.ticker, m.v2 ?? {}]));
  return sessions.rows
    .filter((row) => row.role === "registry")
    .map((row) => {
      const gate = qualifies(row);
      const set = current.get(row.ticker)?.univ3MinLiquidity ?? null;
      const minHarmonic = row.minHarmonicLiquidity == null ? null : BigInt(row.minHarmonicLiquidity);
      // What the floor would be if derived from the measured harmonic minimum rather than from an
      // instantaneous reading. Reported, never written: see the reproducibility note in report().
      const fromMeasured = minHarmonic === null ? null : floorFrom(minHarmonic, row.quoteUsd);
      const headroomPct =
        set === null || minHarmonic === null || BigInt(set) === 0n
          ? null
          : Number((minHarmonic * 1000n) / BigInt(set)) / 10;
      return {
        ticker: row.ticker,
        pool: row.pool,
        qualifies: gate.ok,
        reasons: gate.reasons,
        usdgDepth: row.quoteUsd,
        cardinality: row.card,
        currentFloor: set,
        minHarmonicLiquidity: minHarmonic === null ? null : minHarmonic.toString(),
        floorFromMeasuredMinimum: fromMeasured === null ? null : fromMeasured.toString(),
        /** How far the measured minimum sits above the floor the registry carries, as a percentage. */
        measuredMinimumVsFloorPct: headroomPct,
        sessionsBelowCurrentFloor: row.minLiqFails ?? null,
      };
    });
}

/** Human-readable assessment, for the evidence block and for O2-07's per-market revisit. */
export function report(rows = assess()) {
  const lines = [];
  const ok = rows.filter((r) => r.qualifies);
  const no = rows.filter((r) => !r.qualifies);
  lines.push(`measured registry markets: ${rows.length}; qualifying today: ${ok.length}; refused: ${no.length}`);
  for (const r of ok) {
    lines.push(
      `  QUALIFIES ${r.ticker} pool ${r.pool} depth ${Math.round(Number(r.usdgDepth))} USDG card ${r.cardinality} ` +
        `floor ${r.currentFloor ?? "UNSET"} measuredMin ${r.minHarmonicLiquidity} ` +
        `(measured minimum is ${r.measuredMinimumVsFloorPct ?? "?"}% of the floor; ${r.sessionsBelowCurrentFloor} sessions below it)`,
    );
  }
  for (const r of no) {
    lines.push(`  REFUSED   ${r.ticker}: ${r.reasons.join("; ")}`);
  }
  return lines.join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(report());
}
