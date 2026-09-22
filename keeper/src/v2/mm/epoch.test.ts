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
