/**
 * T-200. The floors module: the README's formula, the contract's cardinality gate, and the
 * reporting that makes a too-high floor visible before it silently removes corroboration.
 *
 * WHAT THESE PIN, in the order they matter:
 *   - the rounding is DOWN to two significant figures, because rounding a floor UP moves it toward
 *     the failure direction (the pool falls under its own floor and settlement drops to Chainlink
 *     alone while looking like normal operation);
 *   - a pool below MIN_POOL_OBSERVATION_CARDINALITY does not get a floor at all, whatever its depth;
 *   - an unmeasured market is never given a number.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MIN_POOL_OBSERVATION_CARDINALITY,
  USABLE_USDG_THRESHOLD,
  assess,
  floorFrom,
  qualifies,
  twoSignificantFiguresDown,
} from "./liquidity-floors.mjs";

test("two significant figures, rounded DOWN and never to nearest", () => {
  assert.equal(twoSignificantFiguresDown(1_799_999n), 1_700_000n, "1.79e6 must not round up to 1.8e6");
  assert.equal(twoSignificantFiguresDown(6_288_573_140_048_891_904n), 6_200_000_000_000_000_000n);
  assert.equal(twoSignificantFiguresDown(42n), 42n, "two digits are already two significant figures");
  assert.equal(twoSignificantFiguresDown(0n), 0n);
});

test("the formula is the README's: liquidity scaled to the 250,000 USDG threshold", () => {
  // A pool holding exactly the threshold keeps its own liquidity as the floor.
  assert.equal(floorFrom(1_000_000_000_000_000_000n, USABLE_USDG_THRESHOLD), 1_000_000_000_000_000_000n);
  // Twice the threshold halves it: the same rule, in the unit the contract checks.
  assert.equal(floorFrom(1_000_000_000_000_000_000n, USABLE_USDG_THRESHOLD * 2), 500_000_000_000_000_000n);
  assert.throws(() => floorFrom(1n, 0), /positive number of USDG/);
});

/**
 * The gate that is NOT arithmetic. A deep pool the contract refuses cannot carry a floor: the number
 * would assert a usability the chain does not have.
 */
test("cardinality below the contract's minimum refuses the pool however deep it is", () => {
  const deepButShallowRing = { card: MIN_POOL_OBSERVATION_CARDINALITY - 1, quoteUsd: 10_000_000, observe1800Now: true, corroborationFails: 0, growSlotsTo2401: 601 };
  const verdict = qualifies(deepButShallowRing);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reasons.join(" "), /observation cardinality/);

  const thin = { card: 6000, quoteUsd: USABLE_USDG_THRESHOLD - 1, observe1800Now: true, corroborationFails: 0 };
  assert.equal(qualifies(thin).ok, false, "a qualifying ring does not rescue a pool below the usable threshold");

  const ok = { card: 6000, quoteUsd: 3_000_000, observe1800Now: true, corroborationFails: 0 };
  assert.equal(qualifies(ok).ok, true);
});

/**
 * The measured answer, asserted against the committed input set rather than described. If a future
 * input set promotes a pool past 2401, this test changes and that change is the decision.
 */
test("against the committed input set, exactly the two markets with a promoted ring qualify", () => {
  const rows = assess();
  const qualifying = rows.filter((r) => r.qualifies).map((r) => r.ticker).sort();
  assert.deepEqual(qualifying, ["NVDA", "SPCX"]);
  const refused = rows.filter((r) => !r.qualifies);
  assert.equal(refused.length, 11);
  assert.ok(
    refused.every((r) => r.reasons.some((reason) => reason.includes("observation cardinality"))),
    "every refusal in this input set is the cardinality gate, not depth and not corroboration",
  );
  assert.ok(refused.every((r) => r.currentFloor === null), "a refused market must not carry a floor");
});

/**
 * THE THING THIS ROW EXISTS TO SURFACE. SPCX's measured minimum sits just above its floor, so a
 * modest change in the positions' shape puts the pool under its own floor - at which point the
 * Uniswap source reports not-ok and settlement silently falls back to Chainlink alone.
 */
test("headroom is reported per market, and SPCX is the one sitting close to its floor", () => {
  const rows = assess();
  const byTicker = Object.fromEntries(rows.map((r) => [r.ticker, r]));
  assert.ok(byTicker.SPCX.measuredMinimumVsFloorPct < 110, `SPCX headroom is ${byTicker.SPCX.measuredMinimumVsFloorPct}%`);
  assert.ok(byTicker.NVDA.measuredMinimumVsFloorPct > 300, `NVDA headroom is ${byTicker.NVDA.measuredMinimumVsFloorPct}%`);
  assert.equal(byTicker.SPCX.sessionsBelowCurrentFloor, 0, "it has not actually failed a session yet");
});

test("unmeasured markets are absent rather than defaulted", () => {
  const rows = assess();
  const tickers = new Set(rows.map((r) => r.ticker));
  for (const unmeasured of ["CRWV", "ORCL"]) {
    assert.equal(tickers.has(unmeasured), false, `${unmeasured} has no pool and must not appear with a number`);
  }
});
