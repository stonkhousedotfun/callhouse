/**
 * An old spot the oracle accepts: what the MM bot and the pricer do with it.
 *
 * WHY THIS FILE EXISTS: the registry's spotMaxAgeS is 90000 s (the feeds' 24 h heartbeat plus 1 h, ops/deploy.md
 * §15.13), so SettlementOracle.trySpot is ok on a print up to 25 h old: a quiet feed's last print, the previous
 * session's print at the open, or a stalled feed's. trySpot alone (the MM's spot-stale halt, the pricer's planCheck)
 * cannot tell those apart. Neither bot quotes on trySpot alone: every quote and every reprice needs a /fair answer, and
 * the pricing service refuses one when the same feed's print is more than maxSpotDivergenceBps (300) from Cboe's
 * spot. The tests chain the real pieces, with no network: PricingService.fair on the NVDA fixture chain with an
 * injected feed round -> the /fair body (server.ts fairResponse) -> JSON -> the MM's parseFairResponse -> planTick,
 * and the pricer's parseFairBody. They pin:
 *   - a 23.9 h old print that agrees with Cboe is accepted on chain and quoted (age alone is not an error);
 *   - the same print 3.3 % from Cboe is refused `spot-divergence`, the MM halts the series `fair-unavailable` and
 *     cancels its live quotes, and the pricer reads no fair value (pricer.ts leaves the ask alone);
 *   - the known gap: a stalled print inside the 300 bps band is still quoted. The runbook's divergence alert covers
 *     it (ops/deploy.md §15.13), not the bots.
 * DELIBERATELY ABSENT: the chain (the oracle rule `now - updatedAt <= spotMaxAge` is restated below) and HTTP.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address } from 'viem';
import { syntheticNvdaChain } from '../fixtures/synthetic-chains.js';
import type { FairInput, LiveOrder } from './mm/engine.js';
import { parseFairResponse } from './mm/pricing-client.js';
import { planTick, type MmPlanParams, type SeriesView, type TickInput } from './mm/planner.js';
import { parseFairBody } from './pricer/fair-client.js';
import { PricingService, type FairRequest } from './pricing/fair.js';
import type { PricingMarket } from './pricing/markets.js';
import { fairResponse } from './pricing/server.js';
import type { FeedRound } from './pricing/spot.js';
import { SPEC_DEFAULTS } from './registry.js';

/** The fixture as a download 31 s after the close would date it (the file itself was fetched the next morning). */
const NVDA_CHAIN = { ...syntheticNvdaChain(), timestamp: '2026-09-14 20:00:30' };
/** The chain's last trade, 2026-09-14 16:00 New York; synthetic `current_price` is 212.35. */
const AS_OF = Date.UTC(2026, 8, 14, 19, 59, 59) / 1000;
const NOW = AS_OF + 60;
const NVDA: Address = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const FEED: Address = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15';
const EXPIRY = Date.UTC(2026, 8, 18, 20) / 1000;
const STRIKE = 220_000_000n;
/** 23.9 h before NOW: the previous session's print, inside 90000 s. */
const OLD = NOW - 86_000;

const round = (answer8dp: bigint, updatedAt: number): FeedRound => ({ roundId: 18_446_744_073_709_552_249n, answer: answer8dp, updatedAt: BigInt(updatedAt), decimals: 8 });

/** SettlementOracle._spot's age rule (78d7f0d L819): stale when `now - updatedAt > spotMaxAge`. */
const onChainFresh = (updatedAt: number, spotMaxAgeS: number) => !(NOW - updatedAt > spotMaxAgeS);

async function fairBody(feedRound: FeedRound): Promise<{ status: number; body: unknown }> {
  const markets: ReadonlyMap<string, PricingMarket> = new Map([['NVDA', { ticker: 'NVDA', feed: FEED, cboe: { root: 'NVDA', url: 'https://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json' } }]]);
  const service = new PricingService({ markets, nowMs: () => NOW * 1000, spotReader: async () => feedRound, chains: { fetchChain: async () => NVDA_CHAIN } });
  const request: FairRequest = { ticker: 'NVDA', strikeUsdg6: STRIKE, expiry: EXPIRY, type: 'call' };
  const { status, body } = fairResponse(await service.fair(request));
  // What crosses the private network.
  return { status, body: JSON.parse(JSON.stringify(body)) };
}

const PARAMS: MmPlanParams = {
  halfSpreadBps: 500,
  minHalfSpreadUsdg6: 20_000n,
  expiryWidenS: 14_400,
  expiryWidenBps: 20_000,
  pullMinutes: 15,
  quoteOffHours: false,
  fairMaxAgeS: 1_800,
  fairMaxAgeOffHoursS: 345_600,
  skewBpsPerDeltaShare: 10,
  maxSkewBps: 1_000,
  requoteBps: 300,
  resizeBps: 5_000,
  fairSpotToleranceBps: 300,
  maxSeries: 40,
  maxSeriesPerMarket: 10,
  bidUnits: 100n,
  askUnits: 100n,
  maxSeriesUnits: 0n,
  maxTotalNotionalUsdg6: 0n,
  deltaAlertShares: 50,
  syncIntervalS: 900,
  depositTokens: true,
  maxQuoteLifetimeS: 1_800,
};

const LIVE: LiveOrder[] = [
  { id: 7n, kind: 'Bid', price: 1_000_000n, units: 100n, filled: 0n, validUntil: NOW + 1_200, cancelled: false },
  { id: 8n, kind: 'AskWrite', price: 1_400_000n, units: 100n, filled: 0n, validUntil: NOW + 1_200, cancelled: false },
];

/** One MM tick on one NVDA series, the oracle's spot being `spot` (trySpot ok when `fresh`), with this /fair answer. */
function tick(spot: bigint, fresh: boolean, fair: FairInput) {
  const view: SeriesView = {
    info: { longId: 1n, underlying: NVDA, isPut: false, strike: STRIKE, expiry: EXPIRY },
    ticker: 'NVDA',
    settled: false,
    spotFresh: fresh,
    spot: fresh ? spot : null,
    exposure: { longs: 0n, shorts: 0n, bids: 100n, resale: 0n, writes: 100n, live: 2n },
    seriesNotional: 0n,
    askFloor: fresh ? 0n : null,
    bidCap: fresh ? spot / 10n : null,
    collateralAsset: NVDA,
    collateralPerUnit: 10n ** 16n,
    mintFeePpm: 80,
    orders: LIVE,
  };
  const input: TickInput = {
    now: NOW,
    // A regular session, so the session halt is not what decides (the pure planner takes the clock it is given).
    sessionOpen: true,
    sessionClose: NOW + 3_600,
    killed: false,
    lossStop: { day: Math.floor(NOW / 86_400), realised: 0n, limit: 1_000_000_000n, tripped: false },
    lastSync: NOW - 60,
    vault: {
      isQuoter: true,
      tradingPaused: false,
      limits: { maxSeriesUnits: 10_000n, maxTotalNotional: 250_000_000_000n, askToleranceBps: 100, maxBidBpsOfSpot: 1_000, maxOrderLifetime: 0, maxDailyOutflow: 2_500_000_000n },
      outflow: { used: 0n, available: 2_500_000_000n },
      totalNotional: 0n,
      usdgWallet: 100_000_000_000n,
      owed: 0n,
      freeCollateral: new Map([[NVDA, 100n * 10n ** 18n]]),
      walletTokens: new Map([[NVDA, 0n]]),
      tracked: [],
    },
    markets: new Map([[NVDA, { underlying: NVDA, ticker: 'NVDA', enabled: true, mintPaused: false, spot: fresh ? spot : null }]]),
    series: [view],
    fairs: new Map([['1', fair]]),
    params: PARAMS,
    refreshS: 600,
  };
  return planTick(input);
}

test('the oracle accepts a print a heartbeat old at spotMaxAgeS 90000; at the old 3600 it did not', () => {
  assert.equal(SPEC_DEFAULTS.spotMaxAgeS, 90_000);
  assert.equal(onChainFresh(OLD, SPEC_DEFAULTS.spotMaxAgeS), true);
  assert.equal(onChainFresh(NOW - 86_430, SPEC_DEFAULTS.spotMaxAgeS), true, 'the longest measured heartbeat gap');
  assert.equal(onChainFresh(NOW - 90_001, SPEC_DEFAULTS.spotMaxAgeS), false);
  assert.equal(onChainFresh(OLD, 3_600), false);
});

test('an old print that agrees with Cboe is priced and quoted: age alone refuses nothing below the service limit', async () => {
  // 212.21 per token: Cboe's 212.0404 times the ~8 bps multiplier.
  const { status, body } = await fairBody(round(21_221_000_000n, OLD));
  const fair = parseFairResponse(status, body);
  assert.ok(fair.ok, JSON.stringify(body));
  assert.equal(fair.spot, 212_210_000n);
  const plan = tick(212_210_000n, onChainFresh(OLD, SPEC_DEFAULTS.spotMaxAgeS), fair);
  assert.equal(plan.series[0]!.halt, null);
  assert.notEqual(plan.series[0]!.prices, null);
  assert.ok(parseFairBody(status, body).ok, 'the pricer gets the same fair value');
});

test('an old print 3.3 % from Cboe: /fair refuses spot-divergence, the MM halts and cancels, the pricer has no fair value', async () => {
  const answer = 21_900_000_000n; // 219.00 per token, 328 bps from 212.0404
  const { status, body } = await fairBody(round(answer, OLD));
  assert.equal(status, 200);
  assert.equal((body as { reason: string }).reason, 'spot-divergence');
  assert.equal((body as { detail: { maxDivergenceBps: string } }).detail.maxDivergenceBps, '300');

  const fair = parseFairResponse(status, body);
  assert.deepEqual(fair, { ok: false, reason: 'spot-divergence' });
  // trySpot is ok on chain: the spot-stale halt does not fire, the fair value does.
  const plan = tick(219_000_000n, onChainFresh(OLD, SPEC_DEFAULTS.spotMaxAgeS), fair);
  assert.deepEqual(plan.series[0]!.halt, { halt: 'fair-unavailable', detail: 'spot-divergence' });
  assert.equal(plan.series[0]!.prices, null);
  assert.deepEqual(plan.txs.filter((t) => t.type !== 'cancel'), [], 'nothing placed or replaced');
  const cancels = plan.txs.flatMap((t) => (t.type === 'cancel' ? t.orderIds : []));
  assert.deepEqual(cancels, [7n, 8n], 'both live quotes pulled');

  // The pricer (pricer.ts: a !ok answer is outcome fair-unavailable, no reprice sent).
  assert.deepEqual(parseFairBody(status, body), { ok: false, reason: 'spot-divergence' });
});

test('the gap the runbook covers: a stalled print 1.5 % from Cboe, inside maxSpotDivergenceBps, is still priced and quoted', async () => {
  const answer = 21_540_000_000n; // 215.40 per token, 158 bps from 212.0404
  const { status, body } = await fairBody(round(answer, OLD));
  const fair = parseFairResponse(status, body);
  assert.ok(fair.ok, JSON.stringify(body));
  const plan = tick(215_400_000n, onChainFresh(OLD, SPEC_DEFAULTS.spotMaxAgeS), fair);
  assert.equal(plan.series[0]!.halt, null, 'no bot-side guard between the 0.5 % feed threshold and 300 bps');
});
