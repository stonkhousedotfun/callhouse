/**
 * The Chainlink read, pinned to Policy.normalizeSpot and ValoremLib.spotUsdg.
 *
 * WHY THIS FILE EXISTS: a factory market's accounts normalise the feed themselves at every list
 * and every fill, and the keeper must land on the same integer or its strike sits a base unit off
 * the band it computed. The rules pinned here: 8 dp to 6 dp is integer division (21192474816 ->
 * 211924748, the fraction dropped, never rounded), 18 dp divides by 1e12, 6 dp is the identity,
 * 4 dp multiplies up, a zero or negative answer is SpotZero, a round older than maxPriceAge at the
 * head block's clock is StalePrice, and a round id of 0 is refused by the keeper alone.
 *
 * DELIBERATELY ABSENT: no RPC. Only the pure half is tested; readFeedSpot is a two-call wrapper.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

/* ---- environment first: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-feed-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
process.env.FACTORY = '0x2222222222222222222222222222222222222222';
delete process.env.VAULT;
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';

const { FeedError, feedSpotFromRound, normalizeSpot } = await import('./feed.js');

/** The NVDA proxy's print at the registry's verifiedAtBlock 64151977 (tier1.json). */
const NVDA_ANSWER = 21_192_474_816n;
const NVDA_UPDATED_AT = 1_789_483_955n;
const NVDA_ROUND = 18_446_744_073_709_552_655n;
const MAX_AGE = 345_600;

test('normalizeSpot: 8 dp -> 6 dp is integer division; the real NVDA print lands on 211.924748', () => {
  assert.equal(normalizeSpot(NVDA_ANSWER, 8), 211_924_748n);
  assert.equal(normalizeSpot(21_192_474_899n, 8), 211_924_748n, 'the dropped fraction never rounds up');
  assert.equal(normalizeSpot(100n, 8), 1n);
  assert.equal(normalizeSpot(35_803_999_999n, 8), 358_039_999n, 'TSLA at the same block');
});

test('normalizeSpot: 18 dp divides by 1e12, 6 dp is the identity, 4 dp multiplies by 100', () => {
  assert.equal(normalizeSpot(211_924_748_160_000_000_000n, 18), 211_924_748n);
  assert.equal(normalizeSpot(211_924_748n, 6), 211_924_748n);
  assert.equal(normalizeSpot(2_119_247n, 4), 211_924_700n);
  assert.equal(normalizeSpot(1n, 4), 100n);
  assert.equal(normalizeSpot(1n, 0), 1_000_000n, 'a whole-dollar feed');
});

test('normalizeSpot: zero and negative answers are SpotZero, and so is a print under one base unit', () => {
  assert.throws(() => normalizeSpot(0n, 8), (e: unknown) => e instanceof FeedError && e.code === 'not-positive');
  assert.throws(() => normalizeSpot(-21_192_474_816n, 8), (e: unknown) => e instanceof FeedError && e.code === 'not-positive');
  assert.throws(() => normalizeSpot(99n, 8), (e: unknown) => e instanceof FeedError && e.code === 'normalises-to-zero');
  assert.throws(() => normalizeSpot(1n, 78), RangeError);
});

test('feedSpotFromRound: a fresh round gives the spot, its age and its round id', () => {
  const now = Number(NVDA_UPDATED_AT) + 41_881;
  const spot = feedSpotFromRound({ roundId: NVDA_ROUND, answer: NVDA_ANSWER, updatedAt: NVDA_UPDATED_AT }, 8, MAX_AGE, now);
  assert.equal(spot.spotUsdg6, 211_924_748n);
  assert.equal(spot.ageS, 41_881, 'the registry recorded feedAgeS 41881 at that block');
  assert.equal(spot.updatedAt, Number(NVDA_UPDATED_AT));
  assert.equal(spot.roundId, NVDA_ROUND);
  assert.equal(spot.answer, NVDA_ANSWER);
  assert.equal(spot.decimals, 8);
});

test('feedSpotFromRound: stale is `now - updatedAt > maxAge`, inclusive at the limit like StalePrice', () => {
  const at = Number(NVDA_UPDATED_AT);
  const round = { roundId: NVDA_ROUND, answer: NVDA_ANSWER, updatedAt: NVDA_UPDATED_AT };
  assert.equal(feedSpotFromRound(round, 8, MAX_AGE, at + MAX_AGE).ageS, MAX_AGE, 'exactly maxAge old is still accepted');
  assert.throws(() => feedSpotFromRound(round, 8, MAX_AGE, at + MAX_AGE + 1), (e: unknown) => e instanceof FeedError && e.code === 'stale');
  assert.equal(feedSpotFromRound(round, 8, MAX_AGE, at - 5).ageS, 0, 'a lagging head block reads as age 0, not as a negative age');
});

test('feedSpotFromRound: a zero or negative answer and a round id of 0 are refused before the age', () => {
  const now = Number(NVDA_UPDATED_AT) + 10;
  assert.throws(
    () => feedSpotFromRound({ roundId: NVDA_ROUND, answer: 0n, updatedAt: NVDA_UPDATED_AT }, 8, MAX_AGE, now),
    (e: unknown) => e instanceof FeedError && e.code === 'not-positive',
  );
  assert.throws(
    () => feedSpotFromRound({ roundId: NVDA_ROUND, answer: -1n, updatedAt: NVDA_UPDATED_AT }, 8, MAX_AGE, now),
    (e: unknown) => e instanceof FeedError && e.code === 'not-positive',
  );
  assert.throws(
    () => feedSpotFromRound({ roundId: 0n, answer: NVDA_ANSWER, updatedAt: NVDA_UPDATED_AT }, 8, MAX_AGE, now),
    (e: unknown) => e instanceof FeedError && e.code === 'round-zero',
  );
});
