/**
 * Target encryption at rest: round trip, and every way a sealed target must refuse to open.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constantTimeEqual, createTargetCipher, randomToken, sha256Hex } from './crypto.js';

const KEY = Buffer.from('a1'.repeat(32), 'hex');
const OTHER_KEY = Buffer.from('b2'.repeat(32), 'hex');
const CONTEXT = 'telegram:0xE37876AcBfbA6186E4687f4ef465D9AC21558De3';

test('round trip, and the plaintext appears nowhere in the sealed form', () => {
  const cipher = createTargetCipher(KEY);
  for (const target of ['-1001234567890', 'someone@example.com', JSON.stringify({ endpoint: 'https://fcm.googleapis.com/x', keys: {} }), '']) {
    const sealed = cipher.encrypt(target, CONTEXT);
    assert.match(sealed, /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]*$/);
    if (target !== '') assert.ok(!sealed.includes(target));
    assert.equal(cipher.decrypt(sealed, CONTEXT), target);
  }
});

test('the same target seals differently every time (random IV)', () => {
  const cipher = createTargetCipher(KEY);
  const a = cipher.encrypt('-100555', CONTEXT);
  const b = cipher.encrypt('-100555', CONTEXT);
  assert.notEqual(a, b);
  assert.equal(cipher.decrypt(a, CONTEXT), cipher.decrypt(b, CONTEXT));
});

test('a wrong key, a wrong context (another wallet or channel), or any tampering refuses to open', () => {
  const cipher = createTargetCipher(KEY);
  const sealed = cipher.encrypt('-100555', CONTEXT);
  assert.throws(() => createTargetCipher(OTHER_KEY).decrypt(sealed, CONTEXT));
  assert.throws(() => cipher.decrypt(sealed, 'telegram:0x0000000000000000000000000000000000000001'));
  assert.throws(() => cipher.decrypt(sealed, CONTEXT.replace('telegram', 'email')));

  const [v, iv, tag, ct] = sealed.split('.') as [string, string, string, string];
  const flip = (part: string) => {
    const bytes = Buffer.from(part, 'base64url');
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    return bytes.toString('base64url');
  };
  assert.throws(() => cipher.decrypt([v, flip(iv), tag, ct].join('.'), CONTEXT));
  assert.throws(() => cipher.decrypt([v, iv, flip(tag), ct].join('.'), CONTEXT));
  assert.throws(() => cipher.decrypt([v, iv, tag, flip(ct)].join('.'), CONTEXT));
  assert.throws(() => cipher.decrypt(['v2', iv, tag, ct].join('.'), CONTEXT));
  assert.throws(() => cipher.decrypt('garbage', CONTEXT));
});

test('lookup hashes are deterministic, keyed, and not the plain SHA-256', () => {
  const cipher = createTargetCipher(KEY);
  assert.equal(cipher.hash('telegram:-100555'), cipher.hash('telegram:-100555'));
  assert.notEqual(cipher.hash('telegram:-100555'), cipher.hash('telegram:-100556'));
  assert.notEqual(cipher.hash('telegram:-100555'), createTargetCipher(OTHER_KEY).hash('telegram:-100555'));
  assert.notEqual(cipher.hash('telegram:-100555'), sha256Hex('telegram:-100555'));
  // Signatures are separated by purpose.
  assert.notEqual(cipher.sign('email-confirm', 'x'), cipher.sign('email-unsubscribe', 'x'));
});

test('the data key must be 32 bytes', () => {
  assert.throws(() => createTargetCipher(Buffer.alloc(16, 1)));
});

test('random tokens use the Telegram deep-link alphabet; constant-time compare', () => {
  const token = randomToken();
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(randomToken(), token);
  assert.equal(constantTimeEqual(token, token), true);
  assert.equal(constantTimeEqual(token, `${token}x`), false);
  assert.equal(constantTimeEqual('', token), false);
});
