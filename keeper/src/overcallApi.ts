/**
 * Overcall listings API client.
 *
 * Endpoint surface (ops/recon/R3-overcall-api.md, verified live on 2026-09-12):
 *
 *   POST   /api/orders?market=NVDA   body {chainId, components, signature}
 *            201 -> {"listing": {...}}   with listing.orderHash
 *            200 -> the existing row. Re-POSTing the same order hash is IDEMPOTENT, which is
 *                   what makes keeper retries safe: a 200 is a success, not a duplicate error.
 *   GET    /api/orders?optionId=&offerer=&status=&limit=   -> {"listings": [...]}
 *   GET    /api/orders/:hash                               -> {"listing": {...}}
 *   DELETE /api/orders/:hash    records a cancellation; it does NOT remove a fillable order.
 *
 *   Errors are always {"error": "<human string>"}:
 *     400 schema   422 on-chain facts   409 counter/duplicate   401 signature   429 rate limit
 *
 * The body is {chainId, components, signature}. TECHSPEC guessed
 * {chainId, order, signature, optionId, maker}; optionId and maker are derived server-side.
 *
 * There is no auth. No API key, no bearer, no cookie, no maker allowlist, and the validator
 * explicitly accepts an ERC-1271 contract offerer. `content-type: application/json` is the
 * only header their own client sends. OVERCALL_API_KEY is plumbed through anyway so the day
 * they add one is a config change, not a code change.
 */
import { z } from 'zod';
import { config } from './config.js';
import { log } from './logger.js';
import type { OrderComponentsJson } from './seaport.js';

/*//////////////////////////////////////////////////////////////
                              TYPES
//////////////////////////////////////////////////////////////*/

/** Status values Overcall's book reports. `unfillable -> open` recovers on its own once the
 *  tokens or the approval come back, so it is a warning, not a death certificate. */
export type OvercallListingStatus = 'open' | 'partial' | 'filled' | 'cancelled' | 'expired' | 'unfillable';

const listingSchema = z
  .object({
    orderHash: z.string(),
    chainId: z.number().optional(),
    offerer: z.string().optional(),
    optionId: z.string().optional(),
    quantity: z.string().optional(),
    remaining: z.string().optional(),
    unitPrice6: z.string().optional(),
    totalPrice6: z.string().optional(),
    /** The WRITER'S NET leg, not the buyer's gross — confirmed against a real 1/1 fill where
     *  totalPrice6 was 4000000 and this field returned 3800000. Never do NAV maths off it;
     *  read the USDG that actually lands in the vault. */
    realisedPremium6: z.string().optional(),
    startTime: z.string().optional(),
    endTime: z.string().optional(),
    salt: z.string().optional(),
    counter: z.string().optional(),
    status: z.string().optional(),
    filledNumerator: z.string().optional(),
    filledDenominator: z.string().optional(),
    signature: z.string().optional(),
    createdAt: z.string().optional(),
    checkedAt: z.string().optional(),
  })
  .passthrough();

export type OvercallListing = z.infer<typeof listingSchema> & { components?: OrderComponentsJson };

const listingsResponse = z.object({ listings: z.array(listingSchema).optional() }).passthrough();
const listingResponse = z.object({ listing: listingSchema.optional() }).passthrough();
const errorResponse = z.object({ error: z.string() }).passthrough();

/*//////////////////////////////////////////////////////////////
                             ERRORS
//////////////////////////////////////////////////////////////*/

export class OvercallApiError extends Error {
  readonly status: number;
  /** The server's own `error` string, surfaced verbatim. 409 and 422 are the two that matter
   *  operationally and their messages say exactly which check failed. */
  readonly serverMessage: string | null;
  readonly retryable: boolean;

  constructor(status: number, serverMessage: string | null, retryable: boolean) {
    super(`Overcall API ${status}${serverMessage ? `: ${serverMessage}` : ''}`);
    this.name = 'OvercallApiError';
    this.status = status;
    this.serverMessage = serverMessage;
    this.retryable = retryable;
  }
}

export class OvercallNetworkError extends Error {
  readonly retryable = true;
  constructor(cause: unknown) {
    super(`Overcall API unreachable: ${String(cause)}`);
    this.name = 'OvercallNetworkError';
  }
}

/*//////////////////////////////////////////////////////////////
                          HTTP PLUMBING
//////////////////////////////////////////////////////////////*/

/** 429 and 5xx are transient. Everything else in 4xx is our order being wrong, and retrying a
 *  wrong order just burns the per-IP token bucket. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function headers(): Record<string, string> {
  const base: Record<string, string> = { accept: 'application/json' };
  if (config.OVERCALL_API_KEY) base.authorization = `Bearer ${config.OVERCALL_API_KEY}`;
  return base;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { error: text.slice(0, 500) };
  }
}

function serverErrorOf(body: unknown): string | null {
  const parsed = errorResponse.safeParse(body);
  return parsed.success ? parsed.data.error : null;
}

interface RequestResult {
  status: number;
  body: unknown;
}

/**
 * The ceiling on a server-suggested wait. `Retry-After: 86400` on a 429 is legal, and this
 * process is single-threaded: honouring it would park the whole loop for a day — no lockBook,
 * no rollClose, a stale heartbeat, a supervisor restart loop. The attempt cap still bounds the
 * total wait either way.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/** The wait before the next attempt: Retry-After when the limiter sets it (capped), otherwise
 *  exponential backoff with jitter. */
export function retryWaitMs(attempt: number, retryAfterSeconds: number): number {
  return Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? Math.min(retryAfterSeconds * 1000, MAX_RETRY_AFTER_MS)
    : backoffMs(attempt);
}

async function request(url: string, init: RequestInit, attemptLabel: string): Promise<RequestResult> {
  const maxAttempts = config.OVERCALL_MAX_ATTEMPTS;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: { ...headers(), ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.timeout(20_000),
      });
      const body = await readBody(response);

      if (response.ok) return { status: response.status, body };

      const serverMessage = serverErrorOf(body);
      const retryable = isRetryableStatus(response.status);
      const error = new OvercallApiError(response.status, serverMessage, retryable);

      if (!retryable || attempt === maxAttempts) throw error;

      // Respect Retry-After when the rate limiter sets it (capped — see MAX_RETRY_AFTER_MS);
      // otherwise exponential + jitter.
      const retryAfter = Number(response.headers.get('retry-after'));
      const waitMs = retryWaitMs(attempt, retryAfter);
      log.api.warn({ url, status: response.status, serverMessage, attempt, waitMs }, `${attemptLabel} retrying`);
      await sleep(waitMs);
      lastError = error;
    } catch (caught) {
      // The try block only throws an OvercallApiError when it has already decided the failure
      // is not worth another attempt, so it goes straight back out.
      if (caught instanceof OvercallApiError) throw caught;
      const networkError = new OvercallNetworkError(caught);
      if (attempt === maxAttempts) throw networkError;
      const waitMs = backoffMs(attempt);
      log.api.warn({ url, attempt, waitMs, err: String(caught) }, `${attemptLabel} network error, retrying`);
      await sleep(waitMs);
      lastError = networkError;
    }
  }

  throw lastError ?? new OvercallNetworkError('exhausted attempts with no error recorded');
}

function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
  return base + Math.floor(Math.random() * 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/*//////////////////////////////////////////////////////////////
                              POST
//////////////////////////////////////////////////////////////*/

export interface PublishResult {
  listing: OvercallListing | null;
  httpStatus: number;
  /** 200 means the book already had this exact order hash. Still a success. */
  idempotent: boolean;
}

/**
 * Publish a signed order.
 *
 * `signature` is the 65-byte placeholder from seaport.ts: the vault authorises by hash on
 * chain and answers EIP-1271 for it, but the schema still requires a 64/65-byte field.
 */
export async function publishListing(
  components: OrderComponentsJson,
  signature: string,
): Promise<PublishResult> {
  const url = `${config.OVERCALL_ORDERS_URL}?market=${encodeURIComponent(config.OVERCALL_MARKET)}`;
  const { status, body } = await request(
    url,
    {
      method: 'POST',
      // content-type is the ONLY header Overcall's own client sends on this call.
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chainId: config.CHAIN_ID, components, signature }),
    },
    'POST /api/orders',
  );

  const parsed = listingResponse.safeParse(body);
  const listing = parsed.success && parsed.data.listing ? (parsed.data.listing as OvercallListing) : null;
  return { listing, httpStatus: status, idempotent: status === 200 };
}

/*//////////////////////////////////////////////////////////////
                               GET
//////////////////////////////////////////////////////////////*/

export interface ListQuery {
  optionId?: string;
  offerer?: string;
  /** `all` is only legal together with `offerer`. */
  status?: OvercallListingStatus | 'all';
  limit?: number;
}

export async function fetchListings(query: ListQuery = {}): Promise<OvercallListing[]> {
  const params = new URLSearchParams();
  if (query.optionId !== undefined) params.set('optionId', query.optionId);
  if (query.offerer !== undefined) params.set('offerer', query.offerer);
  if (query.status !== undefined) params.set('status', query.status);
  if (query.limit !== undefined) params.set('limit', String(query.limit));
  const suffix = params.toString();
  const url = suffix === '' ? config.OVERCALL_ORDERS_URL : `${config.OVERCALL_ORDERS_URL}?${suffix}`;

  const { body } = await request(url, { method: 'GET' }, 'GET /api/orders');
  const parsed = listingsResponse.safeParse(body);
  if (!parsed.success || !parsed.data.listings) return [];
  return parsed.data.listings as OvercallListing[];
}

/** One listing by hash. Returns null on 404 rather than throwing: "not in the book" is an
 *  answer the caller acts on, not an error. */
export async function fetchListing(orderHash: string): Promise<OvercallListing | null> {
  try {
    const { body } = await request(
      `${config.OVERCALL_ORDERS_URL}/${orderHash}`,
      { method: 'GET' },
      'GET /api/orders/:hash',
    );
    const parsed = listingResponse.safeParse(body);
    return parsed.success && parsed.data.listing ? (parsed.data.listing as OvercallListing) : null;
  } catch (error) {
    if (error instanceof OvercallApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Tell the book we cancelled.
 *
 * This does NOT delete anything: Overcall answer 409 while Seaport still considers the order
 * live, on the stated principle that a hidden fillable order is worse than a visible one. The
 * real kill switch is `vault.cancelListing(components)` or `vault.invalidateAllListings()`.
 * We call this afterwards so their row flips promptly instead of waiting for a lazy re-sync.
 */
export async function recordCancellation(orderHash: string): Promise<{ ok: boolean; status: number; error: string | null }> {
  try {
    const { status } = await request(
      `${config.OVERCALL_ORDERS_URL}/${orderHash}`,
      { method: 'DELETE' },
      'DELETE /api/orders/:hash',
    );
    return { ok: true, status, error: null };
  } catch (error) {
    if (error instanceof OvercallApiError) return { ok: false, status: error.status, error: error.serverMessage };
    return { ok: false, status: 0, error: String(error) };
  }
}

/*//////////////////////////////////////////////////////////////
                          PRICE DISCOVERY
//////////////////////////////////////////////////////////////*/

/**
 * The most recent fill price on any of this cycle's rungs, in USDG base units per contract.
 *
 * plan.md 5.2 prices at `max(policy floor, last fill)`. This is the "last fill" half. It is
 * best-effort: an empty book is the normal state on a young market, and a null here just
 * means the policy floor sets the ask.
 *
 * Only `unitPrice6` is used — never `realisedPremium6`, which is the writer's post-fee leg.
 */
export async function lastFilledUnitPrice6(optionIds: readonly bigint[]): Promise<bigint | null> {
  if (optionIds.length === 0) return null;
  const wanted = new Set(optionIds.map((id) => id.toString()));

  let filled: OvercallListing[];
  try {
    filled = await fetchListings({ status: 'filled', limit: 50 });
  } catch (error) {
    log.api.warn({ err: String(error) }, 'could not read the filled book; pricing from the policy floor alone');
    return null;
  }

  let best: { at: number; unitPrice6: bigint } | null = null;
  for (const listing of filled) {
    if (listing.optionId === undefined || !wanted.has(listing.optionId)) continue;
    if (listing.unitPrice6 === undefined) continue;
    let unitPrice6: bigint;
    try {
      unitPrice6 = BigInt(listing.unitPrice6);
    } catch {
      continue;
    }
    if (unitPrice6 <= 0n) continue;
    // createdAt is when the order was written; checkedAt is only the last chain re-sync, so
    // ordering by checkedAt would rank a stale row above a newer one that nobody has read.
    const raw = listing.createdAt ?? listing.checkedAt;
    const at = raw ? Date.parse(raw) : 0;
    const stamp = Number.isFinite(at) ? at : 0;
    if (best === null || stamp > best.at) best = { at: stamp, unitPrice6 };
  }

  return best ? best.unitPrice6 : null;
}
