/**
 * The MakerVault's daily outflow cap as the bot models it (INTERFACE_VERSION 7, c21).
 *
 * WHY THIS FILE EXISTS: the cap is enforced per call, so a tick that plans more bid escrow than the bucket allows
 * discovers it as a reverted `place` — gas paid, the series left unquoted. And the bucket is shared with every other
 * quoter and with the admin, so a level the bot's own calls do not explain is the only cheap signal that somebody
 * else is spending the vault's USDG. Pinned: the budget arithmetic including the credits a tick's own cancels hand
 * back, the clamp at 0 a run of cancels cannot bank, the linear refill, and that the foreign-spend check stays quiet
 * on a first look, on rounding, and on a cap that was lowered in between.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OUTFLOW_WINDOW_S } from './constants.js';
import { bidEscrowOf, budgetFor, decay, foreignSpend, project, FOREIGN_SPEND_TOLERANCE } from './outflow.js';

const CAP = 2_500_000_000n; // 2,500 USDG, the launch value (V2DeployBase LAUNCH_VAULT_MAX_DAILY_OUTFLOW)
const NOW = 1_790_000_000;

test('bidEscrowOf is OptionMath.premium: price × units / 100, the cash a bid pays out at placement', () => {
  assert.equal(bidEscrowOf(2_000_000n, 100n), 2_000_000n, '1 share at 2 USDG');
  assert.equal(bidEscrowOf(2_000_000n, 1n), 20_000n);
  assert.equal(bidEscrowOf(0n, 100n), 0n);
});

test('budgetFor: the cap less the level this tick\'s own credits cannot cancel out', () => {
  assert.equal(budgetFor({ cap: CAP, used: 0n, released: 0n }), CAP, 'an empty bucket: the whole cap');
  assert.equal(budgetFor({ cap: CAP, used: 1_000_000_000n, released: 0n }), 1_500_000_000n);
  // Every live bid is cancelled or replaced before a place runs, and the credit lands first.
  assert.equal(budgetFor({ cap: CAP, used: 1_000_000_000n, released: 400_000_000n }), 1_900_000_000n);
  assert.equal(budgetFor({ cap: CAP, used: 400_000_000n, released: 900_000_000n }), CAP, 'credits beyond the level do not bank');
  assert.equal(budgetFor({ cap: CAP, used: CAP, released: 0n }), 0n, 'a full bucket quotes no new bid');
  assert.equal(budgetFor({ cap: 0n, used: 0n, released: 500n }), 0n, 'a cap of 0 is an on-chain spend freeze');
});

test('project books charges and credits in order, clamping at 0 exactly as the vault does', () => {
  const calls = [
    { what: 'cancel', delta: -300_000_000n },
    { what: 'place', delta: 100_000_000n },
    { what: 'place', delta: 50_000_000n },
  ];
  assert.equal(project(400_000_000n, calls), 250_000_000n);
  assert.equal(project(100_000_000n, calls), 150_000_000n, 'the cancel clamps at 0, it does not bank 200 USDG');
  assert.equal(project(0n, []), 0n);
});

test('decay is the vault\'s linear refill of cap per window', () => {
  assert.equal(decay(CAP, CAP, OUTFLOW_WINDOW_S), 0n, 'a full bucket empties in exactly one window');
  assert.equal(decay(CAP, CAP, OUTFLOW_WINDOW_S / 2), CAP / 2n);
  assert.equal(decay(CAP, CAP, 2 * OUTFLOW_WINDOW_S), 0n, 'never below 0');
  assert.equal(decay(CAP, CAP, 0), CAP);
  assert.equal(decay(CAP, 0n, OUTFLOW_WINDOW_S), CAP, 'a cap of 0 refills nothing: the level is frozen');
});

test('foreignSpend: quiet on a first look and within the projection, loud when USDG the bot did not send has left', () => {
  assert.equal(foreignSpend({ observedUsed: CAP, now: NOW, cap: CAP, previous: null }), null, 'a first tick has nothing to compare with');
  const previous = { used: 1_000_000_000n, at: NOW, cap: CAP };
  // An hour later the bucket has refilled cap/24; the chain agrees within rounding.
  const refill = (CAP * 3_600n) / BigInt(OUTFLOW_WINDOW_S);
  assert.equal(foreignSpend({ observedUsed: 1_000_000_000n - refill, now: NOW + 3_600, cap: CAP, previous }), null);
  assert.equal(foreignSpend({ observedUsed: 1_000_000_000n - refill + FOREIGN_SPEND_TOLERANCE, now: NOW + 3_600, cap: CAP, previous }), null, 'rounding slack is not a page');
  const over = foreignSpend({ observedUsed: 1_000_000_000n - refill + 900_000_000n, now: NOW + 3_600, cap: CAP, previous });
  assert.equal(over, 900_000_000n, 'a 900 USDG spend nobody here made is reported whole');
  assert.equal(foreignSpend({ observedUsed: CAP, now: NOW - 1, cap: CAP, previous }), null, 'a reading older than the projection decides nothing');
});

test('a projection dated at the tick that made it, not before its sends: the vault refills from its last booked call', () => {
  // A tick that reads `outflow()` at T and places its bids over the next two minutes. The vault's bucket refills
  // from the LAST of those places, so at T + 300 it has refilled 180 s, not 300 s. Dating the projection at the read
  // (the bug this pins) assumes the larger refill and reads the honest level as a spend of the difference.
  const readAt = NOW;
  const lastSend = NOW + 120;
  const projected = 500_000_000n;
  const honestAt = (t: number) => decay(projected, CAP, t - lastSend);
  const good = foreignSpend({ observedUsed: honestAt(NOW + 300), now: NOW + 300, cap: CAP, previous: { used: projected, at: lastSend, cap: CAP } });
  assert.equal(good, null, 'dated at the last send: the honest reading passes');
  const bad = foreignSpend({ observedUsed: honestAt(NOW + 300), now: NOW + 300, cap: CAP, previous: { used: projected, at: readAt, cap: CAP } });
  assert.ok(bad !== null && bad > FOREIGN_SPEND_TOLERANCE, `dated at the read: the same honest reading pages (${bad})`);
});

test('foreignSpend uses the smaller of the two caps, so an admin lowering the cap does not read as a theft', () => {
  const previous = { used: 1_000_000_000n, at: NOW, cap: CAP };
  // The admin lowered the cap to a tenth right after the projection, so the bucket refilled at the NEW, slower rate
  // and the level stayed higher than the old cap would suggest. Assuming the smaller refill keeps the check quiet.
  const low = CAP / 10n;
  const hour = (c: bigint) => (c * 3_600n) / BigInt(OUTFLOW_WINDOW_S);
  const honest = 1_000_000_000n - hour(low);
  assert.equal(foreignSpend({ observedUsed: honest, now: NOW + 3_600, cap: low, previous }), null);
  // Had the decay assumed the OLD cap, that same honest reading would have read as a spend of the difference.
  assert.ok(honest - (1_000_000_000n - hour(CAP)) > FOREIGN_SPEND_TOLERANCE, 'the min() is what keeps this quiet');
  // The reverse (the cap was raised) needs nothing: more refill than assumed only lowers the reading.
  assert.equal(foreignSpend({ observedUsed: 1_000_000_000n - hour(CAP * 10n), now: NOW + 3_600, cap: CAP * 10n, previous }), null);
});
