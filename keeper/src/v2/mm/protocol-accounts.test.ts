/**
 * Protocol-owned resting-quote predicates. No taker path.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crossesProtocol, isProtocolOwned, lc, type ProtocolBook, type ProtocolResting } from './protocol-accounts.js';

const A = '0x00000000000000000000000000000000000000Aa';
const B = '0x00000000000000000000000000000000000000Bb';
const OUTSIDER = '0x00000000000000000000000000000000000000Cc';
const SET = new Set([A.toLowerCase(), B]);

const rest = (over: Partial<ProtocolResting>): ProtocolResting => ({
  longId: 1n,
  maker: B,
  kind: 'AskWrite',
  price: 99n,
  ...over,
});

const book = (resting: ProtocolResting[], set: ReadonlySet<string> = SET): ProtocolBook => ({
  protocolAccounts: set,
  resting,
});

test('isProtocolOwned lower-cases both the address and the set members', () => {
  assert.equal(lc(A), A.toLowerCase());
  assert.equal(isProtocolOwned(A, SET), true);
  assert.equal(isProtocolOwned(A.toLowerCase(), new Set([A])), true);
  assert.equal(isProtocolOwned(OUTSIDER, SET), false);
});

test('a bid at or above a protocol-owned ask on the same longId crosses; a cheaper bid does not', () => {
  const asks = book([rest({ kind: 'AskWrite', price: 99n })]);
  assert.equal(crossesProtocol({ longId: 1n, side: 'bid', price: 100n }, asks), true);
  assert.equal(crossesProtocol({ longId: 1n, side: 'bid', price: 99n }, asks), true);
  assert.equal(crossesProtocol({ longId: 1n, side: 'bid', price: 98n }, asks), false);
  assert.equal(crossesProtocol({ longId: 1n, side: 'bid', price: 100n }, book([rest({ kind: 'AskResale', price: 99n })])), true);
});

test('an ask at or below a protocol-owned bid on the same longId crosses', () => {
  const bids = book([rest({ kind: 'Bid', price: 100n })]);
  assert.equal(crossesProtocol({ longId: 1n, side: 'ask', price: 99n }, bids), true);
  assert.equal(crossesProtocol({ longId: 1n, side: 'ask', price: 100n }, bids), true);
  assert.equal(crossesProtocol({ longId: 1n, side: 'ask', price: 101n }, bids), false);
});

test('different longId, or a non-protocol maker, never crosses', () => {
  assert.equal(crossesProtocol({ longId: 2n, side: 'bid', price: 100n }, book([rest({ price: 99n })])), false);
  assert.equal(
    crossesProtocol({ longId: 1n, side: 'bid', price: 100n }, book([rest({ maker: OUTSIDER, price: 99n })])),
    false,
  );
});
