/**
 * Settings sessions (INTERFACE_VERSION 5): sign once, then a bearer token.
 *
 *   POST /v1/session { address, signature, nonce }  →  { token, address, expiresAt }
 *   then `Authorization: Bearer <token>` on GET/POST /v1/subscriptions, DELETE /v1/subscriptions/:id
 *   and GET /v1/telegram/link, instead of a fresh challenge signature per call.
 *
 * THE TOKEN is stateless: nothing is stored, so there is no session table to leak, sweep or
 * replicate. It is opaque to clients (they hold it in memory and send it back, never parse it):
 *
 *   v1.<checksummed address>.<expiresAt, unix seconds>.<HMAC-SHA256, base64url, 43 chars>
 *
 * The MAC covers `v1.<address>.<expiresAt>` exactly as the token spells them, under a key derived
 * from NOTIFIER_DATA_KEY with the fixed label `callhouse-notifier/sign/session/v1` (crypto.ts
 * `sign`). The data key itself never keys it, and the email link tokens and target hashes use
 * other labels, so no token of one kind verifies as another. Issuing always writes the checksummed
 * address, so a re-cased copy of a real token fails the MAC instead of being a second valid token.
 * The MAC is compared in constant time.
 *
 * 30 minutes, no refresh, no revocation: a token lives until `expiresAt` and then the wallet signs
 * again. The one way to invalidate every token at once is to change NOTIFIER_DATA_KEY, which also
 * orphans every stored target (crypto.ts), so it is not a routine lever. A token grants exactly
 * what one fresh signature grants for 30 minutes: read, change and delete that wallet's own
 * subscriptions and issue its Telegram link.
 *
 * THE HEADER. A blank or absent `Authorization` means "no session": the route falls back to the
 * address/signature/nonce check. Anything else must be `Bearer <token>` (scheme case-insensitive)
 * and a valid, unexpired token, or the request is 401 `session-invalid`. A present bearer always
 * wins over signature/nonce in the same request, and that nonce is not spent.
 *
 * Tokens and signatures are never logged (log.ts).
 */
import type { Address } from 'viem';
import { getAddress } from 'viem';
import { constantTimeEqual, type TargetCipher } from './crypto.js';

export const SESSION_TTL_S = 30 * 60;

const VERSION = 'v1';
const PURPOSE = 'session/v1';
const TOKEN_RE = /^v1\.(0x[0-9a-fA-F]{40})\.([1-9]\d{0,11})\.([A-Za-z0-9_-]{43})$/;
const BEARER_RE = /^Bearer +(\S+) *$/i;

export interface Session {
  token: string;
  /** Checksummed. */
  address: Address;
  /** Unix seconds. */
  expiresAt: number;
}

export interface SessionTokens {
  issue(address: Address, now: Date): Session;
  /** The token's address, or null when it is malformed, forged, from another key or expired. */
  read(token: string, now: Date): Address | null;
}

export function sessionTokens(cipher: TargetCipher): SessionTokens {
  const mac = (address: string, expiresAt: string): string => cipher.sign(PURPOSE, `${VERSION}.${address}.${expiresAt}`);
  return {
    issue(raw, now) {
      const address = getAddress(raw);
      const expiresAt = Math.floor(now.getTime() / 1000) + SESSION_TTL_S;
      return { token: `${VERSION}.${address}.${expiresAt}.${mac(address, String(expiresAt))}`, address, expiresAt };
    },
    read(token, now) {
      const match = TOKEN_RE.exec(token);
      if (match === null) return null;
      const [, address = '', expiresAt = '', presented = ''] = match;
      if (!constantTimeEqual(presented, mac(address, expiresAt))) return null;
      if (Number(expiresAt) <= Math.floor(now.getTime() / 1000)) return null;
      return getAddress(address);
    },
  };
}

/**
 * The bearer credential in an Authorization header value:
 *   undefined  no header, or a blank one (use the signature check);
 *   null       a header that is not `Bearer <token>` (401 session-invalid);
 *   string     the token, not yet verified.
 */
export function bearerToken(header: string | undefined): string | null | undefined {
  if (header === undefined || header.trim() === '') return undefined;
  const match = BEARER_RE.exec(header);
  return match === null ? null : (match[1] ?? null);
}
