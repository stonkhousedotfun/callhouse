/**
 * The factory week's pricing (solo.planSoloWeek), in both modes, on a synthetic options chain
 * and a representative Chainlink print beside it.
 *
 * WHY THIS FILE EXISTS: the first factory keeper priced every week at `max(spot × 40 bps, 1 USDG)`
 * with the 40 bps in the source and the 1 USDG as the floor. This pins what replaced it: the band
 * and the premium floor come from the factory's policy, the fixed strike rounds DOWN to a whole
 * USDG and must sit in the band, the vol strike and ask are the pooled machinery's own numbers
 * for ONE contract (231 / 1.365843 on the synthetic chain, the figures policy.vol.test.ts pins), any
 * `vol-*` reason is a skip and never a fixed fallback, KEEPER_MIN_ASK_USDG6 lifts the ask and is
 * itself capped at the strike. It also pins that solo.ts loads in a process with NO VAULT, which
 * is every new market's process.
 *
 * DELIBERATELY ABSENT: no RPC, no HTTP. The chain is the fixture handed in as a VolContext; the
 * loop (snapshot, setWeek, listFor, settle) is not driven here.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/* ---- environment first: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-solo-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
delete process.env.VAULT;
process.env.FACTORY = '0x2222222222222222222222222222222222222222';
process.env.KEEPER_MARKET = 'NVDA';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';
for (const key of [
  'KEEPER_PRICING_MODE',
  'KEEPER_TARGET_DELTA',
  'KEEPER_PRICE_EDGE_BPS',
  'KEEPER_VOL_MAX_AGE_S',
  'KEEPER_VOL_MAX_SPOT_DIVERGENCE_BPS',
  'KEEPER_STRIKE_BAND_BUFFER_BPS',
  'KEEPER_UNIT_PRICE_USDG6',
  'KEEPER_PREMIUM_MARGIN_BPS',
  'KEEPER_STRIKE_OTM_BPS',
  'KEEPER_MIN_ASK_USDG6',
  'KEEPER_VOL_ROOT',
  'KEEPER_NYSE_HOLIDAYS',
]) {
  delete process.env[key];
}

const { config } = await import('./config.js');
const { fixedStrikeDown6, planSoloWeek, weekIsCurrent, MAX_LISTS_PER_TICK } = await import('./solo.js');
const { fillFloorUnit6, strikeBand, withPremiumMargin, withPriceEdge } = await import('./policy.js');
const { syntheticNvdaChain } = await import('./fixtures/synthetic-chains.js');
type PolicyParams = import('./policy.js').PolicyParams;
type SoloPlanInput = import('./solo.js').SoloPlanInput;
type VolContext = import('./vol.js').VolContext;

/*//////////////////////////////////////////////////////////////
                              FIXTURES
//////////////////////////////////////////////////////////////*/

/** Policy.launchDefaults(): what every factory's constructor installs. */
const LAUNCH: PolicyParams = { minOtmBps: 300n, maxOtmBps: 1200n, minPremiumBps: 40n, maxUtilizationBps: 9500n, protocolFeeBps: 500n, maxContractsCap: 50n };
const CHAIN = syntheticNvdaChain();
/** Tuesday 2026-09-15 08:30 UTC: the synthetic chain carries Monday's completed session. */
const NOW = Date.UTC(2026, 8, 15, 8, 30, 0) / 1000;
/** The token spot beside the synthetic share close. */
const SPOT = 212_210_000n;

function ctx(overrides: Partial<VolContext> = {}): VolContext {
  return { chain: CHAIN, error: null, closeDay: '2026-09-25', nowSeconds: NOW, ...overrides };
}

/** Every knob as a seam, at the documented default except the band buffer (50 bps, where the
 *  pooled numbers were derived) and the min ask (the registry's 0.10 USDG, so the market figures
 *  show through; the 1 USDG config default has its own test). */
const DEFAULTS = {
  targetDelta: 0.15,
  priceEdgeBps: 1000,
  premiumMarginBps: 100,
  strikeOtmBps: 500,
  minAskUsdg6: 100_000n,
  volMaxAgeS: 345_600,
  volMaxSpotDivergenceBps: 300,
  strikeBandBufferBps: 50,
  unitPriceOverride6: null,
};

function plan(overrides: Partial<SoloPlanInput> = {}) {
  return planSoloWeek({ policy: LAUNCH, spotUsdg6: SPOT, feesEnabled: false, feeBps: 15, pricingMode: 'vol', vol: ctx(), ...DEFAULTS, ...overrides });
}

function reason(r: { ok: true } | { ok: false; reason: string }): string {
  return r.ok ? 'ok' : r.reason;
}

/** Every gate the factory and its accounts apply: setWeek's AskAboveStrike, ValoremLib.open's
 *  band check at the list, and the fill floor for one lot at the fill. */
function assertFactoryGates(p: ReturnType<typeof plan>, spot: bigint, marginBps = 100): void {
  assert.ok(p.ok, `expected a plan, got ${reason(p)}`);
  const { lo, hi } = strikeBand(spot, LAUNCH);
  assert.ok(p.strikeUsdg6 >= lo && p.strikeUsdg6 <= hi, 'Policy.checkStrike at the list spot');
  assert.equal(p.strikeUsdg6 % 1_000_000n, 0n, 'a whole USDG');
  assert.ok(p.askUsdg6 > 0n && p.askUsdg6 <= p.strikeUsdg6, 'setWeek: askUsdg != 0 and ask <= strike');
  assert.ok(p.askUsdg6 >= withPremiumMargin(fillFloorUnit6(spot, 1n, LAUNCH, false, 15), marginBps), 'the fill floor for one lot with the margin');
  assert.equal(p.pricing.unitPrice6, p.askUsdg6.toString(), 'the record carries the ask actually set');
  assert.equal(p.pricing.strikeUsdg6, p.strikeUsdg6.toString());
}

/*//////////////////////////////////////////////////////////////
                             FIXED MODE
//////////////////////////////////////////////////////////////*/

test('the process has no VAULT and solo.ts still loads: the factory-only keeper', () => {
  assert.equal(config.VAULT, undefined);
  assert.equal(config.FACTORY, '0x2222222222222222222222222222222222222222');
  assert.equal(config.KEEPER_MIN_ASK_USDG6, 1_000_000n);
  assert.equal(MAX_LISTS_PER_TICK, 25);
});

test('fixedStrikeDown6 rounds DOWN to a whole USDG: 212.21 + 5% = 222.82 -> 222', () => {
  assert.equal(fixedStrikeDown6(SPOT, 500), 222_000_000n);
  assert.equal(fixedStrikeDown6(212_210_000n, 0), 212_000_000n);
  assert.equal(fixedStrikeDown6(999_999n, 0), 0n, 'under one USDG there is no whole-USDG strike');
  assert.equal(fixedStrikeDown6(21_424_999n, 500), 22_000_000n, 'GME at 21.42: 22.50 -> 22');
});

test('fixed mode: strike 222 (down), ask = the one-lot fill floor with the margin, nothing from the chain', () => {
  const p = plan({ pricingMode: 'fixed', vol: null });
  assertFactoryGates(p, SPOT);
  assert.ok(p.ok);
  assert.equal(p.strikeUsdg6, 222_000_000n);
  assert.equal(p.pricing.floorUnit6, '848840', 'ceil(212.21 x 40 bps)');
  assert.equal(p.pricing.marginUnit6, '857329', 'ceil(848840 x 1.01)');
  assert.equal(p.askUsdg6, 857_329n);
  assert.equal(p.pricing.priceSource, 'fill-floor');
  assert.equal(p.pricing.mode, 'fixed');
  assert.equal(p.pricing.source, null, 'nothing touches Cboe in fixed mode');
  assert.equal(p.pricing.fairUnit6, null);
  assert.equal(p.cappedAtStrike, false);
  assert.equal(p.pricing.strikeOtmBps, 461, '(222 - 212.21) / 212.21, truncated');
  // A chain handed in anyway changes nothing.
  const withChain = plan({ pricingMode: 'fixed' });
  assert.ok(withChain.ok && withChain.strikeUsdg6 === 222_000_000n && withChain.askUsdg6 === 857_329n);
});

test('fixed mode: the factory policy sets the band and the floor, not the source', () => {
  // A tighter policy: 4%-8% band, 60 bps floor. The 5% strike still fits; the floor moves.
  const tight: PolicyParams = { ...LAUNCH, minOtmBps: 400n, maxOtmBps: 800n, minPremiumBps: 60n };
  const p = plan({ pricingMode: 'fixed', vol: null, policy: tight });
  assert.ok(p.ok, reason(p));
  assert.equal(p.strikeUsdg6, 222_000_000n);
  assert.equal(p.pricing.floorUnit6, '1273260', 'ceil(212.21 x 60 bps)');
  assert.equal(p.askUsdg6, 1_285_993n, 'ceil(1273260 x 1.01)');
  // A band the rounded-down strike misses: 5% down to 222 is +4.61%, under a 5% floor.
  const above: PolicyParams = { ...LAUNCH, minOtmBps: 500n };
  const skipped = plan({ pricingMode: 'fixed', vol: null, policy: above });
  assert.equal(reason(skipped), 'strike-outside-band');
  assert.ok(!skipped.ok && skipped.detail.strikeUsdg6 === '222000000' && skipped.detail.minOtmBps === '500');
});

test('fixed mode: a low-priced token whose whole-USDG strike falls under the band floor is skipped, not armed', () => {
  // GME at 21.42: 5% is 22.50, rounded down 22 = +2.68%, under the 3% floor (band low 22.067748).
  const p = plan({ pricingMode: 'fixed', vol: null, spotUsdg6: 21_424_999n });
  assert.equal(reason(p), 'strike-outside-band');
  assert.ok(!p.ok);
  assert.equal(p.detail.strikeUsdg6, '22000000');
  assert.equal(p.detail.bandLowUsdg6, '22067748');
  // 7% clears it: 22.92 -> 22 still under; 8%: 23.13 -> 23 = +7.35%, inside.
  const eight = plan({ pricingMode: 'fixed', vol: null, spotUsdg6: 21_424_999n, strikeOtmBps: 800 });
  assert.ok(eight.ok, reason(eight));
  assert.equal(eight.strikeUsdg6, 23_000_000n);
  // A spot under one USDG has no whole-USDG strike at all.
  assert.equal(reason(plan({ pricingMode: 'fixed', vol: null, spotUsdg6: 500_000n })), 'strike-outside-band');
  assert.equal(reason(plan({ pricingMode: 'fixed', vol: null, spotUsdg6: 0n })), 'spot-zero');
});

test('KEEPER_MIN_ASK_USDG6 lifts the ask (min-ask) and the config default of 1 USDG is what the live NVDA keeper set', () => {
  const lifted = plan({ pricingMode: 'fixed', vol: null, minAskUsdg6: 1_000_000n });
  assert.ok(lifted.ok);
  assert.equal(lifted.askUsdg6, 1_000_000n);
  assert.equal(lifted.pricing.priceSource, 'min-ask');
  assert.equal(lifted.pricing.unitPrice6, '1000000');
  assert.equal(lifted.pricing.marginUnit6, '857329', 'the floor with the margin is still recorded');
  // The environment's default, read when the seam is absent.
  const fromEnv = plan({ pricingMode: 'fixed', vol: null, minAskUsdg6: undefined });
  assert.ok(fromEnv.ok && fromEnv.askUsdg6 === 1_000_000n && fromEnv.pricing.priceSource === 'min-ask');
  // Below the floor the min ask does nothing.
  const below = plan({ pricingMode: 'fixed', vol: null, minAskUsdg6: 1n });
  assert.ok(below.ok && below.askUsdg6 === 857_329n && below.pricing.priceSource === 'fill-floor');
  const off = plan({ pricingMode: 'fixed', vol: null, minAskUsdg6: 0n });
  assert.ok(off.ok && off.askUsdg6 === 857_329n);
});

test('the min ask is capped at the strike: setWeek reverts AskAboveStrike otherwise', () => {
  // A 1 USDG token with a 0%-band policy: strike 1, floor with margin ~0.004, min ask 1.5 -> 1.
  const flat: PolicyParams = { ...LAUNCH, minOtmBps: 0n };
  const p = plan({ pricingMode: 'fixed', vol: null, policy: flat, spotUsdg6: 1_000_000n, strikeOtmBps: 0, minAskUsdg6: 1_500_000n });
  assert.ok(p.ok, reason(p));
  assert.equal(p.strikeUsdg6, 1_000_000n);
  assert.equal(p.askUsdg6, 1_000_000n);
  assert.equal(p.cappedAtStrike, true);
  assert.equal(p.pricing.priceSource, 'min-ask');
  assert.equal(p.pricing.unitPrice6, '1000000');
});

test('fixed mode: a manual override replaces the ask (lifted to the floor), then the min ask and the cap apply', () => {
  const over = plan({ pricingMode: 'fixed', vol: null, unitPriceOverride6: 2_000_000n });
  assert.ok(over.ok && over.askUsdg6 === 2_000_000n && over.pricing.priceSource === 'manual-override');
  const under = plan({ pricingMode: 'fixed', vol: null, unitPriceOverride6: 10n });
  assert.ok(under.ok && under.askUsdg6 === 848_840n, 'lifted to the bare fill floor, as priceListing does');
  const underMin = plan({ pricingMode: 'fixed', vol: null, unitPriceOverride6: 10n, minAskUsdg6: 900_000n });
  assert.ok(underMin.ok && underMin.askUsdg6 === 900_000n && underMin.pricing.priceSource === 'min-ask');
});

/*//////////////////////////////////////////////////////////////
                              VOL MODE
//////////////////////////////////////////////////////////////*/

test('vol mode, 25 Sep: synthetic 0.15-delta strike and fair plus 10% edge for ONE lot', () => {
  const p = plan();
  assertFactoryGates(p, SPOT);
  assert.ok(p.ok);
  assert.equal(p.strikeUsdg6, 231_000_000n);
  assert.equal(p.pricing.fairUnit6, '1241675');
  assert.equal(p.pricing.volUnit6, '1365843');
  assert.equal(p.askUsdg6, 1_365_843n);
  assert.equal(p.askUsdg6, withPriceEdge(1_241_675n, 1000));
  assert.equal(p.pricing.priceSource, 'vol-fair');
  assert.equal(p.pricing.volPath, 'fresh');
  assert.equal(p.pricing.source, 'cboe-delayed');
  assert.equal(p.pricing.expiry, '2026-09-25');
  assert.equal(p.pricing.strikeClamped, null);
  assert.equal(p.pricing.targetDelta, 0.15);
  assert.ok(p.pricing.deltaAtStrike !== null && Math.abs(p.pricing.deltaAtStrike - 0.15) <= 0.05);
  assert.equal(p.pricing.floorUnit6, '848840');
  assert.equal(p.cappedAtStrike, false);
});

test('vol mode: a min ask above the synthetic market ask binds; the 1 USDG default does not', () => {
  const defaultMin = plan({ minAskUsdg6: 1_000_000n });
  assert.ok(defaultMin.ok);
  assert.equal(defaultMin.askUsdg6, 1_365_843n);
  assert.equal(defaultMin.pricing.priceSource, 'vol-fair');
  const p = plan({ minAskUsdg6: 1_500_000n });
  assert.ok(p.ok);
  assert.equal(p.askUsdg6, 1_500_000n);
  assert.equal(p.pricing.priceSource, 'min-ask');
  assert.equal(p.pricing.fairUnit6, '1241675', 'the synthetic market figure is still recorded');
});

test('vol mode: the 200 bps band buffer clamps a 0.30-delta strike up to the buffered floor (223)', () => {
  const p = plan({ strikeBandBufferBps: 200, targetDelta: 0.30 });
  assert.ok(p.ok, reason(p));
  assert.ok(BigInt(p.pricing.deltaStrikeUsdg6 ?? '0') < 223_000_000n, 'the synthetic delta strike is below the buffered floor');
  assert.equal(p.strikeUsdg6, 223_000_000n, 'the buffered floor: ceil(212.21 x (1 + 300 + 200 bps)) = ceil(222.8205) = 223');
  assert.equal(p.pricing.strikeClamped, 'band-floor');
  assert.equal(p.pricing.bandBufferBps, 200);
  assertFactoryGates(p, SPOT);
});

test('vol mode: every vol-* reason skips the week and never falls back to fixed', () => {
  assert.equal(reason(plan({ vol: null })), 'vol-unavailable');
  assert.equal(reason(plan({ vol: ctx({ chain: null, error: 'timeout: no complete response' }) })), 'vol-unavailable');
  assert.equal(reason(plan({ vol: ctx({ nowSeconds: NOW + 30 * 86_400 }) })), 'vol-stale');
  assert.equal(reason(plan({ vol: ctx({ closeDay: '2026-09-24' }) })), 'vol-no-expiry', 'a Thursday the chain does not list');
  assert.equal(reason(plan({ spotUsdg6: 250_000_000n })), 'vol-spot-divergence', 'the token spot is 18% off the share spot');
  assert.equal(reason(plan({ targetDelta: 0.001 })), 'vol-delta-out-of-range', 'no usable quote that far out');
  const wrongRoot = plan({ vol: ctx({ chain: { ...CHAIN, root: 'TSLA' } }) });
  assert.equal(reason(wrongRoot), 'vol-inconsistent');
  // None of them is a fixed-rule strike.
  for (const r of [plan({ vol: null }), plan({ vol: ctx({ nowSeconds: NOW + 30 * 86_400 }) })]) {
    assert.ok(!r.ok);
    assert.ok(!('strikeUsdg6' in r), 'a skip carries no strike');
  }
});

test('vol mode: the strike must pass the band at the list spot even after the clamp, and a strike deep in the money is premium-above-strike', () => {
  // A band too narrow for any whole USDG: 3.00%-3.05% of 212.21 is [218.5763, 218.6824].
  const narrow: PolicyParams = { ...LAUNCH, maxOtmBps: 305n };
  const p = plan({ policy: narrow, strikeBandBufferBps: 0 });
  assert.equal(reason(p), 'strike-outside-band');
  assert.ok(!p.ok && p.detail.why === 'the buffered band holds no whole USDG');
});

test('weekIsCurrent: no week, or a week past its base expiry, means setWeek', () => {
  const week = { id: 3, strikeUsdg6: 225_000_000n, exerciseTs: NOW + 3 * 86_400, baseExpiryTs: NOW + 4 * 86_400, askUsdg6: 946_951n };
  assert.equal(weekIsCurrent(week, NOW), true);
  assert.equal(weekIsCurrent(week, NOW + 4 * 86_400 - 1), true, 'the exercise window is still the current week');
  assert.equal(weekIsCurrent(week, NOW + 4 * 86_400), false, 'at base expiry the next week is due');
  assert.equal(weekIsCurrent({ ...week, id: 0 }, NOW), false, 'a factory that has never had a week');
});
