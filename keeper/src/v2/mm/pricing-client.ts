/**
 * The pricing service's /fair, as the MM bot asks it (pricing/server.ts):
 *
 *   GET {PRICING_URL}/fair?ticker&strike&expiry&type
 *     200 { fair: Money, iv, delta, source: "cboe"|"model", spot: Money, asOf }
 *     200 { fair: null, reason, detail }      no price right now (a reason code)
 *     400 / 404 / 500                          refused
 *
 * Every answer becomes a FairInput; nothing throws. A timeout, a refused connection, a non-200 or a body
 * of the wrong shape is `{ ok: false, reason }` with the reason prefixed `pricing-`, so the engine halts
 * that series (never quote without a fair value) and /state says why.
 */
import { z } from 'zod';
import type { FairInput } from './engine.js';
import { PRICING_CONCURRENCY } from './constants.js';

const money = z.object({ raw: z.string().regex(/^\d{1,40}$/) }).passthrough();
const priced = z
  .object({
    fair: money,
    iv: z.number().finite(),
    delta: z.number().finite(),
    source: z.string(),
    asOf: z.number().int().nonnegative(),
    spot: money.optional(),
  })
  .passthrough();
const refused = z.object({ fair: z.null(), reason: z.string() }).passthrough();

export interface FairRequest {
  ticker: string;
  strike: bigint;
  expiry: number;
  isPut: boolean;
}

export function fairUrl(baseUrl: string, request: FairRequest): string {
  const params = new URLSearchParams({ ticker: request.ticker, strike: request.strike.toString(), expiry: String(request.expiry), type: request.isPut ? 'put' : 'call' });
  return `${baseUrl.replace(/\/$/, '')}/fair?${params.toString()}`;
}

/** A /fair body (with its status) as a FairInput. Pure. */
export function parseFairResponse(status: number, body: unknown): FairInput {
  if (status === 200) {
    const ok = priced.safeParse(body);
    if (ok.success) return { ok: true, fair: BigInt(ok.data.fair.raw), delta: ok.data.delta, iv: ok.data.iv, asOf: ok.data.asOf, source: ok.data.source, ...(ok.data.spot === undefined ? {} : { spot: BigInt(ok.data.spot.raw) }) };
    const no = refused.safeParse(body);
    if (no.success) return { ok: false, reason: no.data.reason };
    return { ok: false, reason: 'pricing-bad-body' };
  }
  const no = refused.safeParse(body);
  return { ok: false, reason: `pricing-http-${status}${no.success ? `:${no.data.reason}` : ''}` };
}

export class PricingClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: { baseUrl: string; timeoutMs: number; fetch?: typeof fetch }) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async fair(request: FairRequest): Promise<FairInput> {
    let response: Response;
    try {
      response = await this.fetchImpl(fairUrl(this.options.baseUrl, request), { signal: AbortSignal.timeout(this.options.timeoutMs), headers: { accept: 'application/json' } });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      return { ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? 'pricing-timeout' : 'pricing-unreachable' };
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: response.status === 200 ? 'pricing-bad-body' : `pricing-http-${response.status}` };
    }
    return parseFairResponse(response.status, body);
  }

  /** Many requests, at most PRICING_CONCURRENCY at a time, answers in request order. */
  async fairMany(requests: readonly FairRequest[]): Promise<FairInput[]> {
    const out: FairInput[] = new Array(requests.length);
    let next = 0;
    const worker = async () => {
      while (next < requests.length) {
        const i = next;
        next += 1;
        out[i] = await this.fair(requests[i]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PRICING_CONCURRENCY, requests.length) }, worker));
    return out;
  }
}
