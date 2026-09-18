/**
 * The v5 session token codec (session.ts), without HTTP. The routes are pinned in server.test.ts.
 *
 * WHAT IS PINNED:
 *   - the format `v1.<checksummed address>.<expiresAt>.<mac>` and the 30-minute lifetime;
 *   - the MAC key is derived from NOTIFIER_DATA_KEY under its own label, never the raw key;
 *   - expiry at `expiresAt`, tampering of any part, re-casing and a foreign key are all refused;
 *   - how an Authorization header value is read.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import type { Address } from 'viem';
import { createTargetCipher } from './crypto.js';
import { bearerToken, SESSION_TTL_S, sessionTokens } from './session.js';
import { T0, TEST_DATA_KEY_HEX } from './testing.js';

const KEY = Buffer.from(TEST_DATA_KEY_HEX, 'hex');
const sessions = sessionTokens(createTargetCipher(KEY));
const ALICE = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address;
const BOB = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const now = new Date(T0);
const at = (seconds: number) => new Date(seconds * 1000);

test('issue: v1.<checksummed address>.<expiresAt>.<mac>, 30 minutes, read back to the address', () => {
  const session = sessions.issue(ALICE.toLowerCase() as Address, now);
  assert.equal(SESSION_TTL_S, 1800);
  assert.equal(session.address, ALICE);
  assert.equal(session.expiresAt, Math.floor(T0 / 1000) + 1800);
  assert.match(session.token, new RegExp(`^v1\\.${ALICE}\\.${session.expiresAt}\\.[A-Za-z0-9_-]{43}$`));
  assert.equal(sessions.read(session.token, now), ALICE);
  // Stateless and deterministic: the same inputs give the same token.
  assert.equal(sessions.issue(ALICE, now).token, session.token);
});

test('the MAC is HMAC-SHA256 under a key derived from NOTIFIER_DATA_KEY with a fixed label, never the raw key', () => {
  const { token, expiresAt } = sessions.issue(ALICE, now);
  const mac = token.split('.')[3];
  const input = `v1.${ALICE}.${expiresAt}`;
  const derived = createHmac('sha256', KEY).update('callhouse-notifier/sign/session/v1').digest();
  assert.equal(mac, createHmac('sha256', derived).update(input).digest('base64url'));
  assert.notEqual(mac, createHmac('sha256', KEY).update(input).digest('base64url'));
  // Other token kinds keyed from the same data key do not collide with it.
  const cipher = createTargetCipher(KEY);
  assert.notEqual(mac, cipher.sign('email-confirm', input));
  assert.notEqual(mac, cipher.sign('email-unsubscribe', input));
});

test('expiry: valid through the second before expiresAt, refused from expiresAt on', () => {
  const { token, expiresAt } = sessions.issue(ALICE, now);
  assert.equal(sessions.read(token, at(expiresAt - 1)), ALICE);
  assert.equal(sessions.read(token, new Date(expiresAt * 1000 - 1)), ALICE);
  assert.equal(sessions.read(token, at(expiresAt)), null);
  assert.equal(sessions.read(token, at(expiresAt + 86_400)), null);
});

test('tampering with any part, re-casing the address or reformatting the token is refused', () => {
  const { token, expiresAt } = sessions.issue(ALICE, now);
  const [version, address, expires, mac = ''] = token.split('.');
  const flipped = `${mac[0] === 'A' ? 'B' : 'A'}${mac.slice(1)}`;
  const variants = [
    `v2.${address}.${expires}.${mac}`,
    `${version}.${BOB}.${expires}.${mac}`,
    `${version}.${ALICE.toLowerCase()}.${expires}.${mac}`,
    `${version}.${address}.${expiresAt + 3600}.${mac}`,
    `${version}.${address}.0${expires}.${mac}`,
    `${version}.${address}.${expires}.${flipped}`,
    `${version}.${address}.${expires}.${mac.slice(0, -1)}`,
    `${token}A`,
    `${token}.`,
    ` ${token}`,
    token.replaceAll('.', ':'),
    '',
    'v1',
  ];
  for (const variant of variants) assert.equal(sessions.read(variant, now), null, variant);
  assert.equal(sessions.read(token, now), ALICE);
});

test('a token minted under another NOTIFIER_DATA_KEY is refused', () => {
  const foreign = sessionTokens(createTargetCipher(Buffer.from('b2'.repeat(32), 'hex'))).issue(ALICE, now);
  assert.equal(sessions.read(foreign.token, now), null);
});

test('bearerToken: absent or blank → no session; Bearer <token> → the token; anything else → invalid', () => {
  assert.equal(bearerToken(undefined), undefined);
  assert.equal(bearerToken(''), undefined);
  assert.equal(bearerToken('   '), undefined);
  assert.equal(bearerToken('Bearer v1.abc'), 'v1.abc');
  assert.equal(bearerToken('bearer v1.abc'), 'v1.abc');
  assert.equal(bearerToken('BEARER   v1.abc '), 'v1.abc');
  for (const bad of ['Basic dXNlcjpwYXNz', 'Bearer', 'Bearer ', 'Bearer a b', 'v1.abc', 'Bearerv1.abc']) {
    assert.equal(bearerToken(bad), null, bad);
  }
});
