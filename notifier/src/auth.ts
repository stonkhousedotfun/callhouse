/**
 * Wallet authentication: no accounts, no passwords. A wallet proves control by signing a
 * challenge, and every call that reads or changes its subscriptions spends one, unless it carries
 * a v5 session bearer (session.ts), which itself costs one signature for 30 minutes.
 *
 *   POST /v1/challenge { address }  →  { message, nonce, expiresAt }
 *   the wallet signs `message` with personal_sign (EIP-191) and the next call carries
 *   { address, signature, nonce }.
 *
 * NONCES are 128 random bits, bound to the address they were issued for, valid for 10 minutes,
 * and single-use. The nonce is burned BEFORE the signature is checked, in one UPDATE: two
 * requests racing with one signature cannot both pass, and a wrong signature costs the caller a
 * fresh challenge rather than letting it try again against the same message. Reads and deletes
 * need a fresh signature too, so a signature seen in a log or a proxy is
 * worth nothing a second time.
 *
 * THE MESSAGE is EIP-4361 with the app domain, URI, chain 4663, address, nonce and both times,
 * so a wallet shows the user what they are signing and a signature phished
 * for another site does not verify here (the stored message is what is verified, byte for byte).
 *
 * SIGNATURES. EOAs are checked locally first (ecrecover, no network). Mismatched ordinary ECDSA
 * signatures query code once per address per minute; only contracts reach verifyMessage. Non-ECDSA
 * signatures go to the chain for ERC-1271 / ERC-6492, after wrapper validation and a per-address
 * RPC budget. RPC is behind a deadline: an unreachable RPC answers 503, not 401, so a Safe owner is told to retry
 * rather than that their signature is wrong.
 */
import { randomBytes } from 'node:crypto';
import { getAddress, isAddress, isErc6492Signature, parseErc6492Signature, verifyMessage, type Address, type Hex } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import type { Db, Queryable } from './db.js';
import { consumeNonce, insertNonce } from './store.js';

export const NONCE_TTL_MS = 10 * 60_000;
export const CHALLENGE_WINDOW_MS = 60_000;
export const MAX_CHALLENGES_PER_ADDRESS = 20;
export const MAX_CHALLENGES_GLOBAL = 120;

export class ChallengeRateLimitError extends Error {
  constructor() {
    super('challenge rate limit reached');
    this.name = 'ChallengeRateLimitError';
  }
}

export interface VerifyArgs {
  address: Address;
  message: string;
  signature: Hex;
}

/** true / false for a definite answer; throws when the answer could not be obtained (RPC down). */
export type SignatureVerifier = (args: VerifyArgs) => Promise<boolean>;

/** The slice of a viem PublicClient this needs. Tests pass a fake. */
export interface VerifyingClient {
  verifyMessage(args: VerifyArgs): Promise<boolean>;
  /** Production clients supply getCode; test doubles without it treat a mismatched ECDSA signature as invalid. */
  getCode?(args: { address: Address }): Promise<Hex | undefined>;
}

export function createSignatureVerifier(client: VerifyingClient): SignatureVerifier {
  const codeCache = new Map<Address, { hasCode: boolean; expiresAt: number }>();
  const rpcBudget = new Map<Address, { count: number; since: number }>();
  return async (args) => {
    const wrapped = isErc6492Signature(args.signature);
    if (wrapped) {
      // A magic suffix alone is insufficient. Reject malformed ABI before its factory calldata
      // reaches the public RPC.
      try {
        parseErc6492Signature(args.signature);
      } catch {
        return false;
      }
    }
    try {
      // A 65-byte ECDSA signature from the address itself: done, without the network.
      if (await verifyMessage(args)) return true;
    } catch {
      // Non-ECDSA signatures still need ERC-1271 / ERC-6492 verification below.
    }
    // A mismatched ordinary ECDSA signature is invalid for an EOA. Only contract accounts need
    // chain verification. Cache the code classification briefly to avoid one RPC per bad attempt.
    if (!wrapped && client.getCode !== undefined) {
      const cached = codeCache.get(args.address);
      let hasCode: boolean;
      if (cached !== undefined && cached.expiresAt > Date.now()) {
        hasCode = cached.hasCode;
      } else {
        const code = await client.getCode({ address: args.address });
        hasCode = code !== undefined && code !== '0x';
        if (codeCache.size >= 4096) codeCache.delete(codeCache.keys().next().value!);
        codeCache.set(args.address, { hasCode, expiresAt: Date.now() + 60_000 });
      }
      if (!hasCode) return false;
    }
    if (args.signature.length === 132 && client.getCode === undefined) return false;
    const now = Date.now();
    const prior = rpcBudget.get(args.address);
    if (prior !== undefined && now - prior.since < 60_000) {
      if (prior.count >= 10) return false;
      prior.count += 1;
    } else {
      if (rpcBudget.size >= 4096) rpcBudget.delete(rpcBudget.keys().next().value!);
      rpcBudget.set(args.address, { count: 1, since: now });
    }
    return client.verifyMessage(args);
  };
}

export function normaliseAddress(raw: unknown): Address | null {
  if (typeof raw !== 'string' || !isAddress(raw, { strict: false })) return null;
  return getAddress(raw);
}

export function challengeMessage(a: {
  appUrl: string;
  address: Address;
  nonce: string;
  issuedAt: Date;
  expiresAt: Date;
}): string {
  const url = new URL(a.appUrl);
  return createSiweMessage({
    domain: url.host,
    address: a.address,
    statement: 'Sign in to manage Stonkhouse notifications. Signing sends no transaction and costs nothing.',
    uri: url.origin,
    version: '1',
    chainId: 4663,
    nonce: a.nonce,
    issuedAt: a.issuedAt,
    expirationTime: a.expiresAt,
  });
}

export interface Challenge {
  message: string;
  nonce: string;
  /** Unix seconds. */
  expiresAt: number;
}

export async function createChallenge(
  q: Db,
  a: { appUrl: string; address: Address; now: Date },
): Promise<Challenge> {
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = new Date(a.now.getTime() + NONCE_TTL_MS);
  const message = challengeMessage({ appUrl: a.appUrl, address: a.address, nonce, issuedAt: a.now, expiresAt });
  await q.transaction(async (tx) => {
    // Per-address lock preserves the bound across replicas without serialising unrelated users.
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [a.address]);
    const since = new Date(a.now.getTime() - CHALLENGE_WINDOW_MS);
    const { rows } = await tx.query<{ total: number; for_address: number }>(
      `SELECT count(*)::int AS for_address
         FROM notifier.nonce WHERE created_at > $1::timestamptz AND address = $2`,
      [since, a.address],
    );
    if ((rows[0]?.for_address ?? 0) >= MAX_CHALLENGES_PER_ADDRESS) {
      throw new ChallengeRateLimitError();
    }
    await insertNonce(tx, { nonce, address: a.address, message, now: a.now, expiresAt });
  });
  return { message, nonce, expiresAt: Math.floor(expiresAt.getTime() / 1000) };
}

export type AuthFailure = { ok: false; status: 400 | 401 | 503; code: string; message: string };
export type AuthResult = { ok: true; address: Address } | AuthFailure;

const NONCE_RE = /^[0-9a-f]{32}$/;
// 65-byte ECDSA is 132 characters; ERC-1271 / ERC-6492 wrappers are longer. Bounded all the same.
const SIGNATURE_RE = /^0x(?:[0-9a-fA-F]{2}){1,8192}$/;

/** Check { address, signature, nonce } from a request. Burns the nonce whenever it was live. */
export async function authenticate(
  deps: { db: Queryable; verify: SignatureVerifier; now: Date },
  input: { address?: unknown; signature?: unknown; nonce?: unknown },
): Promise<AuthResult> {
  const address = normaliseAddress(input.address);
  if (address === null) return { ok: false, status: 400, code: 'bad-request', message: 'address: a 20-byte hex address' };
  if (typeof input.signature !== 'string' || !SIGNATURE_RE.test(input.signature)) {
    return { ok: false, status: 400, code: 'bad-request', message: 'signature: a 0x-prefixed hex signature' };
  }
  if (typeof input.nonce !== 'string' || !NONCE_RE.test(input.nonce)) {
    return { ok: false, status: 400, code: 'bad-request', message: 'nonce: the nonce from POST /v1/challenge' };
  }

  const message = await consumeNonce(deps.db, input.nonce, address, deps.now);
  if (message === null) {
    return {
      ok: false,
      status: 401,
      code: 'nonce-invalid',
      message: 'the nonce is unknown, used, expired, or was issued for another address: request a new challenge',
    };
  }

  let valid: boolean;
  try {
    valid = await deps.verify({ address, message, signature: input.signature as Hex });
  } catch {
    return {
      ok: false,
      status: 503,
      code: 'verifier-unavailable',
      message: 'the signature could not be checked against the chain right now: request a new challenge and retry',
    };
  }
  if (!valid) {
    return { ok: false, status: 401, code: 'signature-invalid', message: 'the signature does not match the address and challenge' };
  }
  return { ok: true, address };
}
