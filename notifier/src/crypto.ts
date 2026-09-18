/**
 * Targets at rest, lookup hashes, and link tokens. All keyed by NOTIFIER_DATA_KEY.
 *
 * TARGETS (Telegram chat ids, push subscriptions, email addresses) are personal data that tie a
 * wallet to a person. A database dump, a Railway backup or a support query must not hand them
 * out, so each is sealed with AES-256-GCM under NOTIFIER_DATA_KEY before it is written:
 *
 *   v1.<iv, 12 bytes>.<auth tag, 16 bytes>.<ciphertext>        (each part base64url)
 *
 * The additional authenticated data is `callhouse-notifier:<context>`, where the caller passes
 * `<channel>:<address>`. A sealed target copied onto another wallet's row, or from an email row
 * onto a push row, then fails to open instead of delivering someone's alerts to someone else.
 * `v1` is there so a later key rotation can tell old rows from new ones; rotation itself is not
 * built.
 *
 * LOOKUPS cannot decrypt every row, so each target also gets an HMAC-SHA256 (`hash`): uniqueness
 * of (address, channel, target) and the Telegram /stop and /status lookups by chat id use it. The
 * HMAC key is derived from the data key with a label, so the AES key itself never keys anything
 * else and a leaked hash table cannot be brute-forced (chat ids are small numbers) without it.
 *
 * TOKENS. `sign` makes the stateless email link tokens (email.ts). Telegram link tokens are random
 * and stored as SHA-256 (`sha256Hex`): a database read gives no working link.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface TargetCipher {
  /** Seal `plaintext` bound to `context` (`<channel>:<address>`). */
  encrypt(plaintext: string, context: string): string;
  /** Open a sealed target. Throws on a wrong key, a wrong context or any tampering. */
  decrypt(sealed: string, context: string): string;
  /** Deterministic HMAC-SHA256 hex of a canonical target, for equality lookups. */
  hash(value: string): string;
  /** HMAC-SHA256 base64url of `value` under a key derived for `purpose`. */
  sign(purpose: string, value: string): string;
}

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function derive(dataKey: Buffer, label: string): Buffer {
  return createHmac('sha256', dataKey).update(`callhouse-notifier/${label}`).digest();
}

export function createTargetCipher(dataKey: Buffer): TargetCipher {
  if (dataKey.length !== 32) throw new Error('NOTIFIER_DATA_KEY must be 32 bytes');
  const hashKey = derive(dataKey, 'target-hash/v1');
  const aad = (context: string) => Buffer.from(`callhouse-notifier:${context}`, 'utf8');

  return {
    encrypt(plaintext, context) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', dataKey, iv, { authTagLength: TAG_BYTES });
      cipher.setAAD(aad(context));
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
    },
    decrypt(sealed, context) {
      const parts = sealed.split('.');
      if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('unsupported sealed target');
      const iv = Buffer.from(parts[1] ?? '', 'base64url');
      const tag = Buffer.from(parts[2] ?? '', 'base64url');
      const ciphertext = Buffer.from(parts[3] ?? '', 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('malformed sealed target');
      const decipher = createDecipheriv('aes-256-gcm', dataKey, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad(context));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },
    hash(value) {
      return createHmac('sha256', hashKey).update(value, 'utf8').digest('hex');
    },
    sign(purpose, value) {
      return createHmac('sha256', derive(dataKey, `sign/${purpose}`)).update(value, 'utf8').digest('base64url');
    },
  };
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** URL-safe random token: 24 bytes → 32 characters of [A-Za-z0-9_-] (Telegram's deep-link alphabet). */
export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time string equality: both sides are hashed to 32 bytes first, as relay/src/server.ts does. */
export function constantTimeEqual(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}
