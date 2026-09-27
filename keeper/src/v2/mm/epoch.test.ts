/**
 * Pure epoch-window predicates. epochEnd is a value passed in, never computed here.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { epochSelectable, flatForRoll, windDownAction, type EpochView } from './epoch.js';

const EPOCH: EpochView = { epochEnd: 1_790_000_000, index: 3, rollDue: false };
const INSIDE = { expiry: EPOCH.epochEnd };
const OUTSIDE = { expiry: EPOCH.epochEnd + 1 };
const NOW = EPOCH.epochEnd - 86_400;
const WIND = 600;

test('epoch === null is unrestricted: today\'s behaviour, whatever the expiry and now', () => {
  assert.equal(epochSelectable(OUTSIDE, null, NOW, WIND), 'ok');
  assert.equal(epochSelectable(INSIDE, null, EPOCH.epochEnd + 10_000, WIND), 'ok');
  assert.equal(epochSelectable(INSIDE, null, EPOCH.epochEnd - 1, 0), 'ok');
});

test('a series with expiry > epochEnd is epoch-outside, even inside the wind-down lead', () => {
  assert.equal(epochSelectable(OUTSIDE, EPOCH, NOW, WIND), 'epoch-outside');
  assert.equal(epochSelectable(OUTSIDE, EPOCH, EPOCH.epochEnd - 1, WIND), 'epoch-outside');
  assert.equal(epochSelectable(INSIDE, EPOCH, NOW, WIND), 'ok');
  assert.equal(epochSelectable({ expiry: EPOCH.epochEnd }, EPOCH, NOW, WIND), 'ok');
});

test('now >= epochEnd - windDownS is epoch-winddown for a series still inside the epoch', () => {
  assert.equal(epochSelectable(INSIDE, EPOCH, EPOCH.epochEnd - WIND, WIND), 'epoch-winddown');
  assert.equal(epochSelectable(INSIDE, EPOCH, EPOCH.epochEnd - WIND - 1, WIND), 'ok');
  assert.equal(epochSelectable(INSIDE, EPOCH, EPOCH.epochEnd - 1, WIND), 'epoch-winddown');
});

test('a view that carries its own windDownS uses it instead of the process-wide lead, both ways', () => {
  const daily: EpochView = { ...EPOCH, kind: 'daily', windDownS: 1_800 };
  const weekly: EpochView = { ...EPOCH, kind: 'weekly', windDownS: 14_400 };
  // One hour before the boundary, with a process-wide 4 h lead: the daily vault still quotes, the weekly one does not.
  const hourBefore = EPOCH.epochEnd - 3_600;
  assert.equal(epochSelectable(INSIDE, daily, hourBefore, 14_400), 'ok');
  assert.equal(epochSelectable(INSIDE, weekly, hourBefore, 14_400), 'epoch-winddown');
  // The daily lead is exact at its edge.
  assert.equal(epochSelectable(INSIDE, daily, EPOCH.epochEnd - 1_800, 14_400), 'epoch-winddown');
  assert.equal(epochSelectable(INSIDE, daily, EPOCH.epochEnd - 1_801, 14_400), 'ok');
  // And it wins in the other direction too: a vault lead LONGER than the process-wide one is honoured.
  assert.equal(epochSelectable(INSIDE, weekly, hourBefore, 600), 'epoch-winddown');
  // No windDownS on the view: the process-wide argument, exactly as before.
  assert.equal(epochSelectable(INSIDE, EPOCH, hourBefore, 600), 'ok');
});

test('a windingDown vault is epoch-winddown at ANY time inside the epoch, not only in its lead', () => {
  const retiring: EpochView = { ...EPOCH, kind: 'weekly', windDownS: 14_400, windingDown: true };
  // A full day before the boundary, far outside the 4 h lead: an ordinary weekly vault quotes, a retiring one does not.
  assert.equal(epochSelectable(INSIDE, { ...retiring, windingDown: false }, NOW, 14_400), 'ok');
  assert.equal(epochSelectable(INSIDE, retiring, NOW, 14_400), 'epoch-winddown');
  // At the very start of the epoch, and with a zero lead everywhere, it is still wind-down.
  assert.equal(epochSelectable(INSIDE, { ...retiring, windDownS: 0 }, EPOCH.epochEnd - 7 * 86_400, 0), 'epoch-winddown');
  // A series expiring past epochEnd stays epoch-outside: the retirement never widens what the vault may hold.
  assert.equal(epochSelectable(OUTSIDE, retiring, NOW, 14_400), 'epoch-outside');
  // Absent = false: the earlier behaviour.
  assert.equal(epochSelectable(INSIDE, { ...EPOCH, windDownS: 14_400 }, NOW, 14_400), 'ok');
});

test('windDownAction: bid and AskWrite off; AskResale only while longs > 0; close/cancel stay', () => {
  assert.deepEqual(windDownAction({ exposure: { longs: 0n } }), { bid: false, write: false, resale: false, close: true, cancel: true });
  assert.deepEqual(windDownAction({ exposure: null }), { bid: false, write: false, resale: false, close: true, cancel: true });
  assert.deepEqual(windDownAction({ exposure: { longs: 1n } }), { bid: false, write: false, resale: true, close: true, cancel: true });
});

test('flatForRoll is true iff every series has longs == shorts == resale == 0', () => {
  assert.equal(flatForRoll([]), true);
  assert.equal(flatForRoll([{ longs: 0n, shorts: 0n, resale: 0n }]), true);
  assert.equal(flatForRoll([{ longs: 1n, shorts: 0n, resale: 0n }]), false);
  assert.equal(flatForRoll([{ longs: 0n, shorts: 1n, resale: 0n }]), false);
  assert.equal(flatForRoll([{ longs: 0n, shorts: 0n, resale: 1n }]), false);
});
