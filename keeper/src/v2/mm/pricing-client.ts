/**
 * The pricing service's /fair, as the MM bot asks it (pricing/server.ts):
 *
 *   GET {PRICING_URL}/fair?ticker&strike&expiry&type
 *     200 { fair: Money, iv, delta, source: "cboe"|"model", spot: Money, asOf,
 *           quality?: { readiness, reasons: string[], uncertainty }, event?: { input, inWindow },
 *           askIv?, vega?, gamma? }                                  (carried to the engine by P3/P14)
 *   `quality` and `event` are TOP-LEVEL: pricing never emits a `provenance` key, because
 *   indexer/lib/v2/pricing.ts treats one as the full O3-307/1 provenance and discards a quote whose `provenance` fails
 *   that schema. A `provenance.quality` / `provenance.event` is still read, as a fallback only.
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
const qualityShape = z.object({ reasons: z.array(z.string()) }).passthrough();
const eventShape = z.object({ inWindow: z.boolean(), input: z.enum(['supplied', 'missing', 'short']).optional() }).passthrough();
const priced = z
  .object({
    fair: money,
    iv: z.number().finite(),
    delta: z.number().finite(),
    source: z.string(),
    asOf: z.number().int().nonnegative(),
    spot: money.optional(),
    /**
     * P9 (the service serializes them): read, never required. A body without them is an older service and is
     * priced as before; a body WITH one whose shape is wrong is a bad body, not a silently ignored flag.
     */
    quality: qualityShape.optional(),
    event: eventShape.optional(),
    /**
     * The safest-ask inputs (pricing/server.ts): askIv >= iv on the trading clock, vega in USD per share per
     * 1.00 of vol, gamma per USD of spot. Read, never required; a present one that is not a finite non-negative number
     * is a bad body, never a silently dropped markup.
     */
    askIv: z.number().finite().nonnegative().optional(),
    vega: z.number().finite().nonnegative().optional(),
    gamma: z.number().finite().nonnegative().optional(),
    provenance: z.object({ quality: qualityShape.optional(), event: eventShape.optional() }).passthrough().optional(),
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
    if (ok.success) {
      const q = ok.data.quality ?? ok.data.provenance?.quality;
      const e = ok.data.event ?? ok.data.provenance?.event;
      const quality =
        q === undefined && e === undefined
          ? undefined
          : {
              reasons: q?.reasons ?? [],
              ...(e === undefined ? {} : { eventInWindow: e.inWindow, ...(e.input === undefined ? {} : { eventInput: e.input }) }),
            };
      return {
        ok: true,
        fair: BigInt(ok.data.fair.raw),
        delta: ok.data.delta,
        iv: ok.data.iv,
        asOf: ok.data.asOf,
        source: ok.data.source,
        ...(ok.data.spot === undefined ? {} : { spot: BigInt(ok.data.spot.raw) }),
        ...(ok.data.askIv === undefined ? {} : { askIv: ok.data.askIv }),
        ...(ok.data.vega === undefined ? {} : { vega: ok.data.vega }),
        ...(ok.data.gamma === undefined ? {} : { gamma: ok.data.gamma }),
        ...(quality === undefined ? {} : { quality }),
      };
    }
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
