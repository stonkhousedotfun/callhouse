/**
 * planWeek and priceListing in vol mode, on a deterministic synthetic options chain.
 *
 * WHY THIS FILE EXISTS: vol mode moves the strike and the ask off the vault's own arithmetic and
 * onto market data, and the vault does not care. Everything the vault checks must still hold on
 * every plan vol mode produces — the strike inside the band at the arm spot, the ask at or above
 * the fill floor with the margin, never above the strike, gross divisible by the size — and every
 * way the market data can be missing, stale or inconsistent must be a named skip, never a silent
 * fall back to the fixed rule. A reprice without fresh data must not undercut the last
 * market-based ask. Fixed mode's own numbers are pinned in policy.test.ts and are re-checked here
 * with a chain present, to show the chain changes nothing there.
 *
 * DELIBERATELY ABSENT: no RPC, no HTTP. The chain is the fixture, handed in as a VolContext.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/* ---- environment first: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-policy-vol-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
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
]) {
  delete process.env[key];
}

const { BPS } = await import('./config.js');
const {
  clampStrikeToBand,
  fillFloorUnit6,
  fillVerdict,
  planWeek,
  priceListing,
  storedFairUnit6,
  storedStrikeContext,
  strikeBand,
  withPremiumMargin,
  withPriceEdge,
} = await import('./policy.js');
const { syntheticNvdaChain } = await import('./fixtures/synthetic-chains.js');
type PolicyParams = import('./policy.js').PolicyParams;
type PlanInput = import('./policy.js').PlanInput;
type VolContext = import('./vol.js').VolContext;

/*//////////////////////////////////////////////////////////////
                              FIXTURES
//////////////////////////////////////////////////////////////*/

const LAUNCH: PolicyParams = {
  minOtmBps: 300n,
  maxOtmBps: 1200n,
  minPremiumBps: 40n,
  maxUtilizationBps: 9500n,
  protocolFeeBps: 500n,
  maxContractsCap: 50n,
};
const LOT = 1_000_000_000_000_000_000n;
const CHAIN = syntheticNvdaChain();
/** Tuesday 2026-09-15 08:30 UTC: the synthetic chain is recent enough for Monday's session. */
const NOW = Date.UTC(2026, 8, 15, 8, 30, 0) / 1000;
/** The vault's token spot beside the synthetic share close. */
const SPOT = 212_210_000n;

function ctx(overrides: Partial<VolContext> = {}): VolContext {
  return { chain: CHAIN, error: null, closeDay: '2026-09-25', nowSeconds: NOW, ...overrides };
}

/** The knobs as seams, so the file does not depend on the shell: the documented defaults, except the
 *  band buffer, pinned at 50 bps where the numbers below were derived (the 200 bps default has its
 *  own test). */
const DEFAULTS = {
  pricingMode: 'vol' as const,
  targetDelta: 0.15,
  priceEdgeBps: 1000,
  premiumMarginBps: 100,
  volMaxAgeS: 345_600,
  volMaxSpotDivergenceBps: 300,
  strikeBandBufferBps: 50,
  unitPriceOverride6: null,
};

function plan(overrides: Partial<PlanInput> = {}) {
  return planWeek({
    policy: LAUNCH,
    spotUsdg6: SPOT,
    totalAssets: 25n * LOT,
    contractsWritten: 0n,
    feesEnabled: false,
    feeBps: 15,
    vol: ctx(),
    ...DEFAULTS,
    ...overrides,
  });
}

function reason(r: { ok: true } | { ok: false; reason: string }): string {
  return r.ok ? 'ok' : r.reason;
}

/** Every gate the vault applies to this plan, re-derived from scratch. */
function assertVaultGates(p: ReturnType<typeof plan>, spot: bigint, marginBps = 100): void {
  assert.ok(p.ok, `expected a plan, got ${reason(p)}`);
  const { lo, hi } = strikeBand(spot, LAUNCH);
  assert.ok(p.strikeUsdg6 >= lo && p.strikeUsdg6 <= hi, 'Policy.strikeBand at the arm spot, both ends');
  assert.equal(p.strikeUsdg6 % 1_000_000n, 0n, 'a whole USDG');
  assert.ok(p.unitPrice6 <= p.strikeUsdg6, 'UnitPriceExceedsStrike');
  const floorUnit = fillFloorUnit6(spot, p.contracts, LAUNCH, false, 15);
  assert.ok(p.unitPrice6 >= withPremiumMargin(floorUnit, marginBps), 'at or above the fill floor with the margin');
  assert.equal(p.gross6 % p.contracts, 0n, 'gross % amount == 0');
  assert.equal(p.gross6, p.unitPrice6 * p.contracts);
  assert.equal(fillVerdict(spot, { grossUsdg6: p.gross6, amount: p.contracts, strikeUsdg6: p.strikeUsdg6 }, LAUNCH, false, 15).fillable, true, 'the fill gate passes at this spot');
}

/*//////////////////////////////////////////////////////////////
                            HAPPY PATHS
//////////////////////////////////////////////////////////////*/

test('vol mode, 25 Sep: synthetic 0.15-delta strike and fair plus 10% edge pass every vault gate', () => {
  const p = plan();
  assertVaultGates(p, SPOT);
  assert.ok(p.ok);
  assert.equal(p.strikeUsdg6, 231_000_000n);
  assert.equal(p.contracts, 23n);
  assert.equal(p.floorUnit6, 848_840n, 'ceil(212.21 x 40 bps)');
  // The synthetic Black–Scholes fair exceeds the floor, so the edge sets the ask.
  assert.equal(p.unitPrice6, 1_365_843n);
  assert.equal(p.unitPrice6, withPriceEdge(1_241_675n, 1000));
  assert.equal(p.priceSource, 'vol-fair');
  assert.equal(p.gross6, 1_365_843n * 23n);

  const r = p.pricing;
  assert.equal(r.mode, 'vol');
  assert.equal(r.source, 'cboe-delayed');
  assert.equal(r.volPath, 'fresh');
  assert.equal(r.targetDelta, 0.15);
  assert.ok(r.deltaAtStrike !== null && Math.abs(r.deltaAtStrike - 0.15) < 0.01, 'synthetic delta at the armed strike');
  assert.equal(r.ivAtStrike, 0.43, 'the synthetic constant-vol recipe');
  assert.equal(r.strikeUsdg6, '231000000');
  assert.equal(r.strikeOtmBps, 885, '(231 - 212.21) / 212.21, truncated');
  assert.equal(r.deltaStrikeUsdg6, '231000000');
  assert.equal(r.strikeClamped, null);
  assert.equal(r.bandBufferBps, 50);
  assert.equal(r.fairUnit6, '1241675');
  assert.equal(r.volUnit6, '1365843');
  assert.equal(r.floorUnit6, '848840');
  assert.equal(r.marginUnit6, '857329');
  assert.equal(r.unitPrice6, '1365843');
  assert.equal(r.edgeBps, 1000);
  assert.equal(r.marginBps, 100);
  assert.equal(r.shareSpot, 212.35);
  assert.equal(r.tokenSpot, 212.21);
  assert.equal(r.spotUsdg6, '212210000');
  assert.equal(r.expiry, '2026-09-25');
  assert.equal(r.chainTimestamp, '2026-09-15 05:45:00');
  assert.equal(r.lastTradeTime, '2026-09-14T15:59:59');
  assert.doesNotThrow(() => JSON.stringify(r), 'the record is plain JSON: it is what the database stores');
});

test('vol mode, 18 Sep: with no edge the synthetic fair is below the vault floor, so the floor sets the ask', () => {
  const p = plan({ vol: ctx({ closeDay: '2026-09-18' }), priceEdgeBps: 0 });
  assertVaultGates(p, SPOT);
  assert.ok(p.ok);
  assert.equal(p.strikeUsdg6, 224_000_000n);
  assert.equal(p.pricing.fairUnit6, '852158');
  assert.equal(p.pricing.volUnit6, '852158', 'zero edge keeps the fair value');
  assert.equal(p.unitPrice6, 857_329n, 'max(857329, 852158)');
  assert.equal(p.priceSource, 'fill-floor');
  assert.equal(p.pricing.volPath, 'fresh', 'still priced on fresh data; the floor merely binds');
});

test('the knobs move what they should: a higher delta is a lower strike, a zero edge is the fair value itself', () => {
  const d25 = plan({ targetDelta: 0.25 });
  assertVaultGates(d25, SPOT);
  assert.equal((d25 as { strikeUsdg6: bigint }).strikeUsdg6, 224_000_000n, 'higher delta selects the lower synthetic strike');
  const flat = plan({ priceEdgeBps: 0 });
  assertVaultGates(flat, SPOT);
  assert.equal((flat as { unitPrice6: bigint }).unitPrice6, 1_241_675n);
  // A bigger margin can out-bid the market: the floor term wins and says so.
  const wide = plan({ premiumMarginBps: 7000 });
  assertVaultGates(wide, SPOT, 7000);
  assert.equal((wide as { unitPrice6: bigint }).unitPrice6, 1_443_028n, 'ceil(848840 x 1.7) exceeds the market ask');
  const wider = plan({ premiumMarginBps: 6000, priceEdgeBps: 500 });
  assert.equal((wider as { priceSource: string }).priceSource, 'fill-floor');
  assert.equal((wider as { unitPrice6: bigint }).unitPrice6, 1_358_144n);
});

/*//////////////////////////////////////////////////////////////
                              THE BAND
//////////////////////////////////////////////////////////////*/

test('clampStrikeToBand: whole USDG, buffered floor, buffered ceiling, both directions and the impossible band', () => {
  // Band at 212.21: [218.5763, 237.6752]; +50 bps buffer -> 219.6374 -> 220; ceiling 12% - 50 bps
  // = 236.6142 -> 236.
  const inside = clampStrikeToBand(225_000_000n, SPOT, LAUNCH, 50);
  assert.deepEqual(inside, { ok: true, strikeUsdg6: 225_000_000n, clamped: null, floorUsdg6: 220_000_000n, ceilingUsdg6: 236_000_000n });
  assert.deepEqual(clampStrikeToBand(214_000_000n, SPOT, LAUNCH, 50), { ok: true, strikeUsdg6: 220_000_000n, clamped: 'band-floor', floorUsdg6: 220_000_000n, ceilingUsdg6: 236_000_000n });
  assert.deepEqual(clampStrikeToBand(240_000_000n, SPOT, LAUNCH, 50), { ok: true, strikeUsdg6: 236_000_000n, clamped: 'band-ceiling', floorUsdg6: 220_000_000n, ceilingUsdg6: 236_000_000n });
  // The arm is two transactions after the plan. The raw ceiling (237) is outside the band after a
  // 28 bps drop (211.607); the buffered one survives a drop of up to 49 bps.
  assert.ok(strikeBand(211_607_000n, LAUNCH).hi < 237_000_000n, 'the old edge strike reverts StrikeAboveBand');
  assert.ok(strikeBand(211_170_000n, LAUNCH).hi >= 236_000_000n, 'the buffered ceiling does not');
  // 219 is inside the vault's own band but inside the buffer: raised.
  assert.equal((clampStrikeToBand(219_000_000n, SPOT, LAUNCH, 50) as { clamped: string }).clamped, 'band-floor');
  assert.equal((clampStrikeToBand(219_000_000n, SPOT, LAUNCH, 0) as { clamped: string | null }).clamped, null, 'no buffer: 219 >= ceil(218.58)');
  assert.deepEqual(clampStrikeToBand(225_000_000n, SPOT, LAUNCH, 1000), { ok: false }, 'a 13% floor over a 12% ceiling');
  assert.throws(() => clampStrikeToBand(225_000_000n, SPOT, LAUNCH, -1));
});

test('vol mode clamps a delta strike under the buffered band floor UP, and records it', () => {
  // The synthetic 0.40-delta strike rounds to 215, below the buffered floor at 220.
  const p = plan({ vol: ctx({ closeDay: '2026-09-18' }), targetDelta: 0.4 });
  assertVaultGates(p, SPOT);
  assert.ok(p.ok);
  assert.equal(p.strikeUsdg6, 220_000_000n);
  assert.equal(p.pricing.deltaStrikeUsdg6, '215000000');
  assert.equal(p.pricing.strikeClamped, 'band-floor');
  assert.equal(p.pricing.fairUnit6, '1541117', 'the fair value of the strike actually armed, not the delta strike');
  assert.ok(p.pricing.deltaAtStrike !== null && p.pricing.deltaAtStrike < 0.4, 'the armed delta is shown honestly');
});

test('vol mode clamps a delta strike over the band ceiling DOWN, and records it', () => {
  // A 10% ceiling less the 50 bps arm buffer: 212.21 x 1.095 = 232.37 -> 232.
  // The synthetic 0.05-delta strike lies well above it.
  const tight: PolicyParams = { ...LAUNCH, maxOtmBps: 1000n };
  const p = plan({ policy: tight, targetDelta: 0.05 });
  assert.ok(p.ok, reason(p));
  const { lo, hi } = strikeBand(SPOT, tight);
  assert.ok(p.strikeUsdg6 >= lo && p.strikeUsdg6 <= hi);
  assert.equal(p.strikeUsdg6, 232_000_000n);
  assert.equal(p.pricing.deltaStrikeUsdg6, '242000000');
  assert.equal(p.pricing.strikeClamped, 'band-ceiling');
  assert.ok(p.unitPrice6 <= p.strikeUsdg6);
  // With no room at all between the buffered floor and the ceiling: strike-outside-band.
  const none = plan({ strikeBandBufferBps: 1000 });
  assert.equal(reason(none), 'strike-outside-band');
});

/*//////////////////////////////////////////////////////////////
                           SKIP REASONS
//////////////////////////////////////////////////////////////*/

test('every way the market data can fail is a named skip, never a fall back to the fixed rule', () => {
  // The environment default is vol: no chain at all is 'vol-unavailable', not spot + 5%.
  const bare = planWeek({ policy: LAUNCH, spotUsdg6: SPOT, totalAssets: 25n * LOT, contractsWritten: 0n, feesEnabled: false, feeBps: 15 });
  assert.equal(reason(bare), 'vol-unavailable', 'KEEPER_PRICING_MODE defaults to vol');

  const failed = plan({ vol: ctx({ chain: null, error: 'timeout: no complete response within 10000 ms' }) });
  assert.equal(reason(failed), 'vol-unavailable');
  assert.equal(!failed.ok && failed.detail.error, 'timeout: no complete response within 10000 ms', 'the fetch error travels with the skip');
  assert.equal(reason(plan({ vol: null })), 'vol-unavailable');
  assert.equal(reason(plan({ vol: ctx({ nowSeconds: NOW + 4 * 86_400 }) })), 'vol-stale', 'Saturday-after-next reading Monday');
  assert.equal(reason(plan({ volMaxAgeS: 3_600 })), 'vol-stale', 'a tighter max age');
  assert.equal(reason(plan({ vol: ctx({ chain: { ...CHAIN, timestamp: '2026-09-16 05:57:42' } }) })), 'vol-inconsistent', 'a file from tomorrow');
  assert.equal(reason(plan({ vol: ctx({ closeDay: '2026-09-17' }) })), 'vol-no-expiry', 'a holiday Thursday with no Thursday listing');
  assert.equal(reason(plan({ vol: ctx({ closeDay: '2026-10-02' }) })), 'vol-no-expiry');
  const noBids = { ...CHAIN, options: CHAIN.options.map((o) => ({ ...o, bid: 0 })) };
  assert.equal(reason(plan({ vol: ctx({ chain: noBids }) })), 'vol-no-quotes');
  const diverged = plan({ spotUsdg6: 219_000_000n });
  assert.equal(reason(diverged), 'vol-spot-divergence', '219.00 token against a 212.35 share exceeds 300 bps');
  assert.equal(!diverged.ok && diverged.detail.divergenceBps, '313.2');
  assert.equal(reason(plan({ targetDelta: 0.001 })), 'vol-delta-out-of-range');
  // Quotes only between 212.5 and 217.5 on 25 Sep: the 0.40-delta target lands inside,
  // but the clamp lifts the strike to 220, past the last quote.
  const narrow = { ...CHAIN, options: CHAIN.options.filter((o) => o.strike >= 212.5 && o.strike <= 217.5) };
  const unquoted = plan({ vol: ctx({ chain: narrow }), targetDelta: 0.4 });
  assert.equal(reason(unquoted), 'vol-strike-unquoted');
  assert.equal(!unquoted.ok && unquoted.detail.strikeUsdg6, '220000000');
  // And the vault's own refusals keep their names in vol mode.
  assert.equal(reason(plan({ spotUsdg6: 0n })), 'spot-zero');
  assert.equal(reason(plan({ unitPriceOverride6: 232_000_000n })), 'premium-above-strike');
});

test('no capacity is decided before any market data is needed', () => {
  // roll.ts does not fetch for an empty vault; planWeek must not then call that 'vol-unavailable'.
  assert.equal(reason(plan({ totalAssets: 0n, vol: undefined })), 'no-capacity');
  assert.equal(reason(plan({ totalAssets: 25n * LOT, contractsWritten: 23n, vol: undefined })), 'no-capacity');
});

test('fixed mode ignores the chain entirely: the launch numbers, a fixed record', () => {
  const SEP12 = 218_297_934n;
  const p = plan({ pricingMode: 'fixed', strikeOtmBps: 500, spotUsdg6: SEP12, vol: ctx() });
  assert.ok(p.ok);
  assert.equal(p.strikeUsdg6, 229_000_000n, 'spot + 5%, exactly as policy.test.ts pins it');
  assert.equal(p.unitPrice6, 881_924n);
  assert.equal(p.priceSource, 'fill-floor');
  assert.equal(p.pricing.mode, 'fixed');
  assert.equal(p.pricing.source, null);
  assert.equal(p.pricing.fairUnit6, null);
  assert.equal(p.pricing.volPath, null);
  assert.equal(p.pricing.strikeOtmBps, 490, '(229 - 218.297934) / 218.297934, truncated');
  // No chain, a stale chain: fixed mode does not care.
  assert.equal((plan({ pricingMode: 'fixed', strikeOtmBps: 500, spotUsdg6: SEP12, vol: undefined }) as { unitPrice6: bigint }).unitPrice6, 881_924n);
  assert.equal(reason(plan({ pricingMode: 'fixed', strikeOtmBps: 1300, spotUsdg6: SEP12 })), 'strike-outside-band');
});

test('a manual override in vol mode can only raise the ask, and never arms or lists without market data', () => {
  const high = plan({ unitPriceOverride6: 2_000_000n });
  assert.ok(high.ok);
  assert.equal(high.unitPrice6, 2_000_000n);
  assert.equal(high.priceSource, 'manual-override');
  assert.equal(high.pricing.fairUnit6, '1241675', 'the synthetic market figures are still recorded beside it');
  // The override cannot undercut the bare floor, margin, or market-based ask.
  for (const override of [20n, 850_000n, 1_365_842n]) {
    const low = plan({ unitPriceOverride6: override });
    assert.ok(low.ok);
    assert.equal(low.unitPrice6, 1_365_843n, `override ${override} is lifted to max(margin, fair with the edge)`);
    assert.equal(low.priceSource, 'vol-fair');
  }
  // A strike the market does not quote is a skip with or without an override (the same unquoted
  // chain as the skip-reason test).
  const narrow = { ...CHAIN, options: CHAIN.options.filter((o) => o.strike >= 212.5 && o.strike <= 217.5) };
  assert.equal(reason(plan({ vol: ctx({ chain: narrow }), targetDelta: 0.4, unitPriceOverride6: 900_000n })), 'vol-strike-unquoted');
  assert.equal(reason(plan({ vol: ctx({ chain: null, error: 'down' }), unitPriceOverride6: 900_000n })), 'vol-unavailable');
  // A reprice with the feed dark and an override: still floored at the previous market-based ask...
  const dark = reprice({ vol: ctx({ chain: null, error: 'down' }), unitPriceOverride6: 900_000n });
  assert.ok(dark.ok);
  assert.equal(dark.unitPrice6, 1_365_843n);
  assert.equal(dark.priceSource, 'vol-previous-fair');
  // ...and refused with no fair value at all, rather than listed at the override.
  assert.equal(reason(reprice({ vol: ctx({ chain: null, error: 'down' }), previousFairUnit6: null, unitPriceOverride6: 900_000n })), 'vol-unavailable');
  // Fixed mode is unchanged: the override replaces the price, lifted to the bare floor.
  const fixedLow = plan({ pricingMode: 'fixed', strikeOtmBps: 500, unitPriceOverride6: 20n });
  assert.ok(fixedLow.ok);
  assert.equal(fixedLow.unitPrice6, 848_840n);
  assert.equal(fixedLow.priceSource, 'manual-override');
});

/*//////////////////////////////////////////////////////////////
                             REPRICES
//////////////////////////////////////////////////////////////*/

const ARMED = 231_000_000n;

function reprice(overrides: Partial<Parameters<typeof priceListing>[0]> = {}) {
  return priceListing({
    policy: LAUNCH,
    spotUsdg6: SPOT,
    strikeUsdg6: ARMED,
    contracts: 16n,
    feesEnabled: false,
    feeBps: 15,
    vol: ctx(),
    previousFairUnit6: 1_241_675n,
    strikeContext: { targetDelta: 0.15, deltaStrikeUsdg6: '231000000', strikeClamped: null, bandBufferBps: 50 },
    pricingMode: 'vol',
    priceEdgeBps: 1000,
    premiumMarginBps: 100,
    volMaxAgeS: 345_600,
    volMaxSpotDivergenceBps: 300,
    unitPriceOverride6: null,
    ...overrides,
  });
}

test('a reprice with fresh data uses the same formula at the armed strike, after a rally', () => {
  // Spot up 1%: the token strike maps to a lower share strike, the fair value rises.
  const rallied = 214_330_000n;
  const p = reprice({ spotUsdg6: rallied });
  assert.ok(p.ok, reason(p));
  assert.equal(p.pricing.volPath, 'fresh');
  assert.equal(p.priceSource, 'vol-fair');
  assert.ok(p.fairUnit6 !== null && p.fairUnit6 > 1_241_675n, 'a higher fair value at a higher spot');
  assert.equal(p.unitPrice6, withPriceEdge(p.fairUnit6, 1000));
  assert.ok(p.unitPrice6 >= withPremiumMargin(fillFloorUnit6(rallied, 16n, LAUNCH, false, 15), 100));
  assert.equal(p.pricing.strikeClamped, null, 'the arm’s strike context is carried');
  assert.equal(p.pricing.deltaStrikeUsdg6, '231000000');
  assert.equal(p.pricing.strikeUsdg6, '231000000');
});

test('a reprice without fresh data never drops below the last market-based ask', () => {
  for (const [vol, why] of [
    [ctx({ chain: null, error: 'network: fetch failed' }), 'vol-unavailable'],
    [ctx({ nowSeconds: NOW + 5 * 86_400 }), 'vol-stale'],
    [ctx({ closeDay: '2026-10-02' }), 'vol-no-expiry'],
  ] as const) {
    const p = reprice({ vol });
    assert.ok(p.ok, `${why}: ${reason(p)}`);
    assert.equal(p.unitPrice6, 1_365_843n, `${why}: ceil(1241675 x 1.1), the ask the arm listed at`);
    assert.equal(p.priceSource, 'vol-previous-fair');
    assert.equal(p.pricing.volPath, 'previous-fair');
    assert.equal(p.pricing.volUnavailableReason, why);
    assert.equal(p.pricing.fairUnit6, '1241675', 'carried, so a second fallback carries it again');
    assert.equal(p.pricing.expiry, null, 'no market figures are invented for a fetch that did not happen');
  }
  // The floor still wins when it is higher: a big rally with the feed dark.
  const rally = reprice({ vol: ctx({ chain: null, error: 'down' }), spotUsdg6: 350_000_000n, strikeUsdg6: 380_000_000n });
  assert.ok(rally.ok);
  assert.equal(rally.unitPrice6, withPremiumMargin(1_400_000n, 100), '350 x 40 bps with margin exceeds the previous ask');
  assert.equal(rally.priceSource, 'fill-floor');
  assert.equal(rally.pricing.volPath, 'previous-fair');
  // Neither fresh data nor a previous fair value: refused, with the data's reason.
  assert.equal(reason(reprice({ vol: ctx({ chain: null, error: 'down' }), previousFairUnit6: null })), 'vol-unavailable');
  assert.equal(reason(reprice({ vol: ctx({ nowSeconds: NOW + 5 * 86_400 }), previousFairUnit6: null })), 'vol-stale');
  assert.equal(reason(reprice({ vol: ctx({ chain: null, error: 'down' }), previousFairUnit6: 0n })), 'vol-unavailable', 'a zero is not a price');
  // The previous-fair ask is still capped by the strike.
  assert.equal(reason(reprice({ vol: ctx({ chain: null, error: 'down' }), previousFairUnit6: 300_000_000n })), 'premium-above-strike');
});

test('stored records: the fair value and the strike context read back, garbage reads as nothing', () => {
  const p = plan();
  assert.ok(p.ok);
  const json = JSON.stringify(p.pricing);
  assert.equal(storedFairUnit6(json), 1_241_675n);
  assert.deepEqual(storedStrikeContext(json), { targetDelta: 0.15, deltaStrikeUsdg6: '231000000', strikeClamped: null, bandBufferBps: 50 });
  for (const bad of [null, undefined, '', 'not json', '[]', '{"fairUnit6": 860864}', '{"fairUnit6": "-5"}', '{"fairUnit6": "0"}', '{"fairUnit6": "1e9"}']) {
    assert.equal(storedFairUnit6(bad), null, `refuses ${String(bad)}`);
  }
  assert.equal(storedStrikeContext('not json'), undefined);
  assert.deepEqual(storedStrikeContext('{"strikeClamped": "sideways", "targetDelta": "0.15"}'), { targetDelta: null, deltaStrikeUsdg6: null, strikeClamped: null, bandBufferBps: null });
  assert.equal(withPriceEdge(655_415n, 1000), 720_957n, 'rounded up');
  assert.equal(withPriceEdge(860_000n, 1000), 946_000n, 'exact stays exact');
  assert.throws(() => withPriceEdge(1n, -1));
  assert.equal(BPS, 10_000n);
});

/*//////////////////////////////////////////////////////////////
                    BROKEN CHAINS AND THE BAND BUFFER
//////////////////////////////////////////////////////////////*/

/** The fixture with the calls of `day` rewritten by `edit` (return null to leave a row as is). */
function editCalls(day: string, edit: (o: (typeof CHAIN.options)[number]) => Partial<(typeof CHAIN.options)[number]> | null) {
  return { ...CHAIN, options: CHAIN.options.map((o) => (o.type === 'C' && o.expiry === day ? { ...o, ...(edit(o) ?? {}) } : o)) };
}

test('a gapped strike grid is refused, not interpolated across: the strike is fixed for the week', () => {
  // Bids pulled from every 25 Sep call between 216 and 239: the old rule bracketed 215/240 and armed
  // 232 at an ask of 1.25 against listed mids of 0.43/0.32 there.
  const holed = editCalls('2026-09-25', (o) => (o.strike >= 216 && o.strike <= 239 ? { bid: 0 } : null));
  const p = plan({ vol: ctx({ chain: holed }) });
  assert.equal(reason(p), 'vol-inconsistent');
  assert.match(!p.ok ? p.detail.why ?? '' : '', /too far apart/);
  const wider = editCalls('2026-09-25', (o) => (o.strike >= 201 && o.strike <= 249 ? { bid: 0 } : null));
  assert.equal(reason(plan({ vol: ctx({ chain: wider }) })), 'vol-inconsistent');
  // One missing quote (a 5 USD bracket) still prices.
  const one = editCalls('2026-09-25', (o) => (o.strike === 225 ? { bid: 0 } : null));
  assertVaultGates(plan({ vol: ctx({ chain: one }) }), SPOT);
});

test('quotes that are arbitrageable around the bracket are refused: an inverted quote, a non-convex one', () => {
  // The target lies in the 230/232.5 bracket. A 232.5 bid above 230's ask is a credit call spread.
  const inverted = editCalls('2026-09-25', (o) => (o.strike === 232.5 ? { bid: 4.9, ask: 5.1 } : null));
  const p = plan({ vol: ctx({ chain: inverted }) });
  assert.equal(reason(p), 'vol-inconsistent');
  assert.match(!p.ok ? p.detail.why ?? '' : '', /bid above a lower strike/);
  // 230 at 1.60/1.62: below 227.5's ask (1.80), but above the 227.5/232.5 chord (1.445).
  const bulge = editCalls('2026-09-25', (o) => (o.strike === 230 ? { bid: 1.6, ask: 1.62 } : null));
  const b = plan({ vol: ctx({ chain: bulge }) });
  assert.equal(reason(b), 'vol-inconsistent');
  assert.match(!b.ok ? b.detail.why ?? '' : '', /convex/);
  // A reprice on such a chain does not take its fair value: it falls back to the last market-based one.
  const r = reprice({ vol: ctx({ chain: inverted }) });
  assert.ok(r.ok, reason(r));
  assert.equal(r.unitPrice6, 1_365_843n);
  assert.equal(r.pricing.volPath, 'previous-fair');
  assert.equal(r.pricing.volUnavailableReason, 'vol-inconsistent');
});

test('one corrupt in-the-money delta does not hand the strike to the first bracket', () => {
  // 210's high synthetic delta -> 0.12, then 212.5 climbs back above the target.
  const corrupt = editCalls('2026-09-25', (o) => (o.strike === 210 ? { delta: 0.12 } : null));
  const p = plan({ vol: ctx({ chain: corrupt }) });
  assert.equal(reason(p), 'vol-inconsistent');
  assert.match(!p.ok ? p.detail.why ?? '' : '', /climbs back above the target/);
});

test('an unclamped strike whose delta is far from the target is refused', () => {
  // A steep synthetic bracket can round to a whole-dollar armed strike whose interpolated delta
  // is more than 0.05 away from the requested delta. That must be a skip, not a guessed strike.
  const rows: Array<[number, number, number]> = [
    [212.5, 0.7, 5.6],
    [215, 0.6, 4.0],
    [217.5, 0.5, 2.6],
    [220, 0.5, 1.5],
    [222.5, 0.05, 0.7],
    [225, 0.04, 0.45],
    [227.5, 0.03, 0.3],
  ];
  const steep = {
    ...CHAIN,
    options: rows.map(([strike, delta, mid]) => ({
      symbol: `NVDA260925C${String(strike * 1000).padStart(8, '0')}`,
      expiry: '2026-09-25',
      type: 'C' as const,
      strike,
      bid: mid - 0.01,
      ask: mid + 0.01,
      iv: 0.3,
      delta,
    })),
  };
  const far = plan({ vol: ctx({ chain: steep }), targetDelta: 0.24 });
  assert.equal(reason(far), 'vol-inconsistent');
  assert.match(!far.ok ? far.detail.why ?? '' : '', /far from the target/);
  // A nearby target whose armed delta remains within tolerance still gets a plan.
  const near = plan({ vol: ctx({ chain: steep }), targetDelta: 0.3 });
  assertVaultGates(near, SPOT);
  assert.ok(near.ok && near.pricing.deltaAtStrike !== null && Math.abs(near.pricing.deltaAtStrike - 0.3) <= 0.05);
});

test('a corrupt number in the chain is a named skip, never an exception out of the tick', () => {
  // bid = ask = 1.7e308: finite, but the mid is Infinity. The row is not a quote.
  const huge = editCalls('2026-09-25', (o) => (o.strike === 230 ? { bid: 1.7e308, ask: 1.7e308 } : null));
  assert.doesNotThrow(() => plan({ vol: ctx({ chain: huge }) }));
  const p = plan({ vol: ctx({ chain: huge }) });
  assertVaultGates(p, SPOT);
  assert.equal((p as { pricing: { strikeUsdg6: string } }).pricing.strikeUsdg6, '231000000', 'priced from valid neighbouring quotes instead');
  assert.doesNotThrow(() => reprice({ vol: ctx({ chain: huge }) }));
  // Anything the checks did not anticipate is caught and named.
  const exploding = {
    ...CHAIN,
    get options(): typeof CHAIN.options {
      throw new Error('boom');
    },
  };
  assert.equal(reason(plan({ vol: ctx({ chain: exploding }) })), 'vol-inconsistent');
  const r = reprice({ vol: ctx({ chain: exploding }) });
  assert.ok(r.ok);
  assert.equal(r.pricing.volPath, 'previous-fair');
});

test('a wide quote at the strike does not set the fair value', () => {
  // A wide 225 quote lies in the short-expiry pricing bracket and must be ignored.
  const wide = editCalls('2026-09-18', (o) => (o.strike === 225 ? { bid: 0.01, ask: 0.11 } : null));
  const p = plan({ vol: ctx({ chain: wide, closeDay: '2026-09-18' }) });
  assertVaultGates(p, SPOT);
  assert.ok(p.ok);
  assert.ok(BigInt(p.pricing.fairUnit6 ?? '0') > 500_000n, `fair ${p.pricing.fairUnit6} comes from valid neighbours, not the 0.06 mid`);
});

test('a chain that missed the latest completed session is stale, even inside the four-day limit', () => {
  // Thursday 17 Sep 10:00 ET, reading Monday's close: 66 h old, but Tuesday and Wednesday closed.
  const thursday = Date.UTC(2026, 8, 17, 14, 0, 0) / 1000;
  const p = plan({ vol: ctx({ closeDay: '2026-09-18', nowSeconds: thursday }) });
  assert.equal(reason(p), 'vol-stale');
  assert.match(!p.ok ? p.detail.why ?? '' : '', /latest completed NYSE session/);
  // Tuesday 04:30 ET, the fixture's own morning after: Monday's close is the latest settled session.
  assertVaultGates(plan({ vol: ctx({ closeDay: '2026-09-18' }) }), SPOT);
});

test('the default band buffer (200 bps) leaves a short expiry the rally room the fixed rule has', () => {
  // 18 Sep: the synthetic 0.25-delta strike is near 220. At 50 bps the week goes unfillable
  // (StrikeBelowBand, which no reprice fixes) on a 65 bps rally.
  const tight = plan({ vol: ctx({ closeDay: '2026-09-18' }), targetDelta: 0.25 });
  assert.ok(tight.ok);
  assert.equal(tight.strikeUsdg6, 220_000_000n);
  const listing = (s: bigint, p: typeof tight & { ok: true }) => ({ grossUsdg6: p.gross6, amount: p.contracts, strikeUsdg6: s });
  const at = (spot: bigint, p: typeof tight & { ok: true }) => fillVerdict(spot, listing(p.strikeUsdg6, p), LAUNCH, false, 15);
  const r65 = at(213_600_000n, tight);
  assert.equal(!r65.fillable && r65.reason, 'strike-below-band');

  const roomy = plan({ vol: ctx({ closeDay: '2026-09-18' }), targetDelta: 0.25, strikeBandBufferBps: undefined });
  assertVaultGates(roomy, SPOT);
  assert.ok(roomy.ok);
  assert.equal(roomy.pricing.bandBufferBps, 200, 'the environment default');
  assert.equal(roomy.strikeUsdg6, 223_000_000n, 'ceil(212.21 x 1.05)');
  assert.equal(roomy.pricing.strikeClamped, 'band-floor');
  assert.equal(roomy.pricing.deltaStrikeUsdg6, '219000000', 'the delta strike is still shown');
  for (const spot of [213_600_000n, 215_000_000n, 216_400_000n]) {
    const v = at(spot, roomy);
    assert.ok(v.fillable || v.reason !== 'strike-below-band', `no StrikeBelowBand at ${spot}`);
  }
  const past = at(216_600_000n, roomy);
  assert.equal(!past.fillable && past.reason, 'strike-below-band', 'past ~+200 bps');
});
