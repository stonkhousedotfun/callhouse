/**
 * The pricing service's `/fair` as the pricer reads it (pricing/server.ts):
 *
 *   GET {PRICING_URL}/fair?ticker=NVDA&strike=231000000&expiry=1790020800&type=call
 *     200 { fair: Money, iv, delta, source, spot: Money, asOf }   → { ok: true, fair: BigInt(fair.raw) }
 *     200 { fair: null, reason, detail }                          → { ok: false, reason }
 *     400 / 404 / 500 { fair: null, reason }                      → { ok: false, reason }
 *
 * NEVER THROWS. "No fair value right now" is an answer the pricer acts on (it leaves the ask alone),
 * so an unreachable service, a timeout, a body of the wrong shape and a null fair all come back as
 * `{ ok: false, reason }`. The FairSource port lets the devnet harness and the tests inject prices.
 */

export interface FairRequest {
  ticker: string;
  /** USDG base units per whole share. */
  strike: bigint;
  /** Unix seconds. */
  expiry: number;
  type: 'call' | 'put';
}

export type FairAnswer =
  | {
      ok: true;
      /** USDG base units per whole share. */
      fair: bigint;
      source: string;
      /** The market data's time (the Cboe chain's last trade), unix seconds; null when absent. */
      asOf: number | null;
    }
  | { ok: false; reason: string };

export interface FairSource {
  fair(request: FairRequest): Promise<FairAnswer>;
}

const RAW_RE = /^(0|[1-9]\d*)$/;

/** The /fair body (and status) as a FairAnswer. Pure; exported for tests. */
export function parseFairBody(status: number, body: unknown): FairAnswer {
  if (typeof body !== 'object' || body === null) return { ok: false, reason: `HTTP ${status}: not a JSON object` };
  const { fair, reason, source, asOf } = body as { fair?: unknown; reason?: unknown; source?: unknown; asOf?: unknown };
  if (status === 200 && typeof fair === 'object' && fair !== null) {
    const raw = (fair as { raw?: unknown }).raw;
    if (typeof raw !== 'string' || !RAW_RE.test(raw)) return { ok: false, reason: 'fair.raw is not a non-negative integer string' };
    return { ok: true, fair: BigInt(raw), source: typeof source === 'string' ? source : 'unknown', asOf: typeof asOf === 'number' ? asOf : null };
  }
  if (fair === null) return { ok: false, reason: typeof reason === 'string' ? (status === 200 ? reason : `HTTP ${status}: ${reason}`) : `HTTP ${status}` };
  return { ok: false, reason: `HTTP ${status}: unexpected body` };
}

export interface PricingClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

export class PricingClient implements FairSource {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: PricingClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  async fair(request: FairRequest): Promise<FairAnswer> {
    const params = new URLSearchParams({ ticker: request.ticker, strike: request.strike.toString(), expiry: String(request.expiry), type: request.type });
    const url = `${this.options.baseUrl}/fair?${params.toString()}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.options.timeoutMs), headers: { accept: 'application/json' } });
    } catch (error) {
      return { ok: false, reason: `unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: `HTTP ${response.status}: not JSON` };
    }
    return parseFairBody(response.status, body);
  }
}
