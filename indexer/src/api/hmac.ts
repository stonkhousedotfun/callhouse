import { createHmac, timingSafeEqual } from "node:crypto";

import { KEEPER_HMAC_SECRET } from "../../lib/env";

/**
 * Keeper authentication for `POST /v1/overcall/list`.
 *
 * The route is a relay into a third-party order book, so it must not become an open one. The
 * keeper signs the exact bytes it is about to send:
 *
 *   signature = hex( HMAC-SHA256( secret, `${timestamp}.${rawBody}` ) )
 *
 *   x-callhouse-timestamp: unix seconds
 *   x-callhouse-signature: 64 lowercase hex characters
 *
 * The timestamp is inside the MAC, not merely alongside it, so a captured request cannot be
 * replayed with a fresh clock. Requests more than SKEW_SECONDS out are rejected outright.
 *
 * The comparison is constant-time. A byte-by-byte `===` on a MAC leaks its prefix through
 * timing, which is enough to forge one given patience.
 */

const SKEW_SECONDS = 300;
const SIGNATURE_HEADER = "x-callhouse-signature";
const TIMESTAMP_HEADER = "x-callhouse-timestamp";

export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 403 | 503; error: string };

export function verifyKeeperHmac(headers: Headers, rawBody: string): AuthResult {
  if (KEEPER_HMAC_SECRET === undefined) {
    return {
      ok: false,
      status: 503,
      error:
        "KEEPER_HMAC_SECRET is not configured on this indexer, so the keeper relay is disabled.",
    };
  }

  const signature = headers.get(SIGNATURE_HEADER);
  const timestamp = headers.get(TIMESTAMP_HEADER);

  if (signature === null || timestamp === null) {
    return {
      ok: false,
      status: 401,
      error: `Missing ${SIGNATURE_HEADER} or ${TIMESTAMP_HEADER}.`,
    };
  }

  const ts = Number(timestamp);
  if (!Number.isInteger(ts)) {
    return { ok: false, status: 401, error: "Malformed timestamp." };
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skew > SKEW_SECONDS) {
    return {
      ok: false,
      status: 403,
      error: `Timestamp is ${skew}s out; the window is ${SKEW_SECONDS}s.`,
    };
  }

  const expected = createHmac("sha256", KEEPER_HMAC_SECRET)
    .update(`${ts}.${rawBody}`)
    .digest();

  // `timingSafeEqual` throws on a length mismatch, which would itself be a timing signal, so
  // the length is checked first against a fixed constant rather than against the secret's MAC.
  const provided = hexToBytes(signature.trim().toLowerCase());
  if (provided === null || provided.length !== expected.length) {
    return { ok: false, status: 401, error: "Bad signature." };
  }

  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, status: 401, error: "Bad signature." };
  }

  return { ok: true };
}

function hexToBytes(hex: string): Buffer | null {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length === 0 || body.length % 2 !== 0) return null;
  if (!/^[0-9a-f]+$/.test(body)) return null;
  return Buffer.from(body, "hex");
}

/** Helper for the keeper side, and for the README's worked example. */
export function signKeeperRequest(
  secret: string,
  rawBody: string,
  timestampSeconds: number = Math.floor(Date.now() / 1000),
): { [SIGNATURE_HEADER]: string; [TIMESTAMP_HEADER]: string } {
  const mac = createHmac("sha256", secret)
    .update(`${timestampSeconds}.${rawBody}`)
    .digest("hex");
  return {
    [SIGNATURE_HEADER]: mac,
    [TIMESTAMP_HEADER]: String(timestampSeconds),
  };
}
