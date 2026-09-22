/**
 * The pricing service's `/fair` as the pricer reads it (pricing/server.ts):
 *
 *   GET {PRICING_URL}/fair?ticker=NVDA&strike=231000000&expiry=1790020800&type=call
 *     200 { fair: Money, iv, delta, source, spot: Money, asOf, provenance? }
 *       → { ok: true, fair, source, asOf, spot?, provenance? }  provenance is optional and never required
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

/** Additive §5.1 provenance on /fair, when a producer emits it. Every field is optional so a
 *  partial object cannot crash the pricer; qualifyFair treats missing clocks/reasons as unknown. */
export interface FairWireProvenance {
  quality?: { readiness?: string; reasons?: string[] };
  clocks?: { quoteObservedAt?: number | null; underlyingObservedAt?: number | null; receivedAt?: number; computedAt?: number };
  identity?: {
    market?: string;
    token?: { address?: string; uiMultiplier?: string | null };
    option?: { side?: 'call' | 'put'; strike?: bigint; expiry?: number };
    listed?: Array<{ multiplier?: number | null }>;
  };
  pricedSpot?: bigint;
}

export type FairAnswer =
  | {
      ok: true;
      /** USDG base units per whole share. */
      fair: bigint;
      source: string;
      /** The market data's time (the Cboe chain's last trade), unix seconds; null when absent. */
      asOf: number | null;
      /** Token spot the estimate was priced at, when the body carries it. */
      spot?: bigint;
      /** Ignored when absent; never required. */
      provenance?: FairWireProvenance;
    }
  | { ok: false; reason: string };

export interface FairSource {
  fair(request: FairRequest): Promise<FairAnswer>;
}

const RAW_RE = /^(0|[1-9]\d*)$/;

function moneyRaw(value: unknown): bigint | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const raw = (value as { raw?: unknown }).raw;
  if (typeof raw !== 'string' || !RAW_RE.test(raw)) return undefined;
  return BigInt(raw);
}

function parseProvenance(value: unknown): FairWireProvenance | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const o = value as Record<string, unknown>;
  const out: FairWireProvenance = {};
  if (typeof o.quality === 'object' && o.quality !== null) {
    const q = o.quality as Record<string, unknown>;
    const reasons = Array.isArray(q.reasons) ? q.reasons.filter((r): r is string => typeof r === 'string') : undefined;
    out.quality = { readiness: typeof q.readiness === 'string' ? q.readiness : undefined, reasons };
  }
  if (typeof o.clocks === 'object' && o.clocks !== null) {
    const c = o.clocks as Record<string, unknown>;
    out.clocks = {
      quoteObservedAt: typeof c.quoteObservedAt === 'number' ? c.quoteObservedAt : c.quoteObservedAt === null ? null : undefined,
      underlyingObservedAt: typeof c.underlyingObservedAt === 'number' ? c.underlyingObservedAt : c.underlyingObservedAt === null ? null : undefined,
      receivedAt: typeof c.receivedAt === 'number' ? c.receivedAt : undefined,
      computedAt: typeof c.computedAt === 'number' ? c.computedAt : undefined,
    };
  }
  if (typeof o.identity === 'object' && o.identity !== null) {
    const id = o.identity as Record<string, unknown>;
    const token = typeof id.token === 'object' && id.token !== null ? (id.token as Record<string, unknown>) : undefined;
    const option = typeof id.option === 'object' && id.option !== null ? (id.option as Record<string, unknown>) : undefined;
    const strike = option !== undefined ? moneyRaw(option.strike) ?? (typeof option.strikeUsdg6 === 'string' && RAW_RE.test(option.strikeUsdg6) ? BigInt(option.strikeUsdg6) : undefined) : undefined;
    out.identity = {
      market: typeof id.market === 'string' ? id.market : undefined,
      token: token === undefined ? undefined : { address: typeof token.address === 'string' ? token.address : undefined, uiMultiplier: typeof token.uiMultiplier === 'string' || token.uiMultiplier === null ? (token.uiMultiplier as string | null) : undefined },
      option: option === undefined ? undefined : { side: option.side === 'call' || option.side === 'put' ? option.side : undefined, strike, expiry: typeof option.expiry === 'number' ? option.expiry : undefined },
    };
  }
  const priced = moneyRaw(o.pricedSpot) ?? (typeof o.pricedSpotUsdg6 === 'string' && RAW_RE.test(o.pricedSpotUsdg6) ? BigInt(o.pricedSpotUsdg6) : undefined);
  if (priced !== undefined) out.pricedSpot = priced;
  return out;
}

/** The /fair body (and status) as a FairAnswer. Pure; exported for tests. Extra keys are ignored. */
export function parseFairBody(status: number, body: unknown): FairAnswer {
  if (typeof body !== 'object' || body === null) return { ok: false, reason: `HTTP ${status}: not a JSON object` };
  const { fair, reason, source, asOf, spot, provenance } = body as { fair?: unknown; reason?: unknown; source?: unknown; asOf?: unknown; spot?: unknown; provenance?: unknown };
  if (status === 200 && typeof fair === 'object' && fair !== null) {
    const raw = (fair as { raw?: unknown }).raw;
    if (typeof raw !== 'string' || !RAW_RE.test(raw)) return { ok: false, reason: 'fair.raw is not a non-negative integer string' };
    const parsed: Extract<FairAnswer, { ok: true }> = { ok: true, fair: BigInt(raw), source: typeof source === 'string' ? source : 'unknown', asOf: typeof asOf === 'number' ? asOf : null };
    const spotRaw = moneyRaw(spot);
    if (spotRaw !== undefined) parsed.spot = spotRaw;
    const prov = parseProvenance(provenance);
    if (prov !== undefined) parsed.provenance = prov;
    return parsed;
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
