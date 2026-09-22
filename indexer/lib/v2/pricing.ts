/** The pricing service is optional for indexer reads. A bad response never breaks a book. */

import type { z } from "zod";

import { pricingProvenanceSchema } from "../../src/api/v2/schema";
import { V2_REGISTRY } from "./marketRegistry.generated";

export type FairInput = {
  ticker: string;
  underlying: string;
  strike: bigint;
  expiry: number;
  isPut: boolean;
};

export type FairQuote = {
  fair: bigint;
  spot: bigint;
  iv: number;
  delta: number;
  asOf: number;
  source: "cboe" | "model";
};

export type PricingProvenance = z.infer<typeof pricingProvenanceSchema>;

export type FairResult = {
  quote: FairQuote | null;
  reasonCode: string | null;
  provenance: PricingProvenance | null;
};

export type PricingOptions = {
  url?: string;
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

type Entry<T> = { value: T; expires: number };
const DECIMAL = /^(?:0|[1-9]\d*)$/;
const registryMarkets = new Map<string, (typeof V2_REGISTRY.markets)[number]>(
  V2_REGISTRY.markets.map((market) => [market.ticker, market]),
);

function rawMoney(value: unknown): bigint | null {
  if (typeof value !== "object" || value === null || !("raw" in value) || !("decimals" in value)) return null;
  const money = value as { raw: unknown; decimals: unknown };
  return typeof money.raw === "string" && DECIMAL.test(money.raw) && money.decimals === 6
    ? BigInt(money.raw)
    : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function matchesRequest(provenance: PricingProvenance, input: FairInput, spot?: bigint): boolean {
  const option = provenance.identity.option;
  const pricedSpot = provenance.pricedSpot;
  const token = provenance.identity.token;
  const ticker = input.ticker.toUpperCase();
  const underlying = input.underlying.toLowerCase();
  const registryMarket = registryMarkets.get(ticker);
  return provenance.identity.market === input.ticker.toUpperCase()
    && token.chainId === V2_REGISTRY.chainId
    && token.address.toLowerCase() === underlying
    && registryMarket !== undefined
    && registryMarket.underlying.toLowerCase() === underlying
    && token.uiMultiplier === registryMarket.uiMultiplier
    && option.side === (input.isPut ? "put" : "call")
    && option.strike.decimals === 6
    && option.strike.raw === input.strike.toString()
    && option.expiry === input.expiry
    && (spot === undefined || (pricedSpot !== null &&
      pricedSpot.decimals === 6 && pricedSpot.raw === spot.toString()));
}

type JsonResponse = { ok: boolean; body: unknown | null };

/** Separate fair and surface-spot caches, bounded for long-running Ponder processes. */
export class PricingClient {
  private readonly url: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly fairCache = new Map<string, Entry<FairResult>>();
  private readonly spotCache = new Map<string, Entry<bigint | null>>();
  private readonly pendingFair = new Map<string, Promise<FairResult>>();
  private readonly pendingSpot = new Map<string, Promise<bigint | null>>();

  constructor(options: PricingOptions = {}) {
    this.url = options.url?.replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 3_000;
  }

  private async get(path: string): Promise<JsonResponse> {
    if (this.url === undefined) return { ok: false, body: null };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.url}${path}`, { signal: controller.signal });
      try {
        return { ok: response.ok, body: await response.json() };
      } catch {
        return { ok: response.ok, body: null };
      }
    } catch {
      return { ok: false, body: null };
    } finally {
      clearTimeout(timeout);
    }
  }

  private put<T>(cache: Map<string, Entry<T>>, key: string, value: T, failed = value === null): T {
    // A failed service can recover quickly; successful quotes stay warm for the promised 30 s.
    cache.set(key, { value, expires: this.now() + (failed ? 5_000 : 30_000) });
    if (cache.size > 512) cache.delete(cache.keys().next().value!);
    return value;
  }

  async fair(input: FairInput): Promise<FairQuote | null> {
    return (await this.fairResult(input)).quote;
  }

  async fairResult(input: FairInput): Promise<FairResult> {
    const unavailable = (): FairResult => ({ quote: null, reasonCode: null, provenance: null });
    if (!DECIMAL.test(input.strike.toString()) || input.strike <= 0n || !Number.isSafeInteger(input.expiry) || input.expiry <= 0) return unavailable();
    const ticker = input.ticker.toUpperCase();
    if (!/^[A-Z][A-Z0-9.]{0,12}$/.test(ticker) || !/^0x[0-9a-fA-F]{40}$/.test(input.underlying)) return unavailable();
    const underlying = input.underlying.toLowerCase();
    const registryMarket = registryMarkets.get(ticker);
    const key = `${V2_REGISTRY.chainId}:${registryMarket?.uiMultiplier ?? "<unknown>"}:${ticker}:${underlying}:${input.strike}:${input.expiry}:${input.isPut ? "put" : "call"}`;
    const cached = this.fairCache.get(key);
    if (cached !== undefined && cached.expires > this.now()) return cached.value;
    const pending = this.pendingFair.get(key);
    if (pending !== undefined) return pending;
    const request = (async () => {
      const query = new URLSearchParams({ ticker, strike: input.strike.toString(), expiry: String(input.expiry), type: input.isPut ? "put" : "call" });
      const response = await this.get(`/fair?${query}`);
      const body = response.body;
      let result = unavailable();
      if (typeof body === "object" && body !== null) {
        const b = body as Record<string, unknown>;
        const hasProvenance = Object.prototype.hasOwnProperty.call(b, "provenance");
        const parsedProvenance = hasProvenance ? pricingProvenanceSchema.safeParse(b.provenance) : null;
        const fair = rawMoney(b.fair);
        const spot = rawMoney(b.spot);
        const provenance = parsedProvenance?.success === true &&
          matchesRequest(parsedProvenance.data, input, b.fair === null ? undefined : spot ?? undefined)
          ? parsedProvenance.data : null;
        const validProvenance = !hasProvenance || provenance !== null;
        if (response.ok && validProvenance && provenance?.quality.readiness !== "unavailable"
            && fair !== null && spot !== null && spot > 0n && finite(b.iv) && finite(b.delta)
            && Number.isSafeInteger(b.asOf) && (b.asOf as number) > 0
            && (b.source === "cboe" || b.source === "model")) {
          const source = provenance === null
            ? b.source
            : provenance.provider === "cboe-delayed" && provenance.method === "listed" ? "cboe" : "model";
          result = {
            quote: { fair, spot, iv: b.iv, delta: b.delta, asOf: b.asOf as number, source },
            reasonCode: null,
            provenance,
          };
        } else if (b.fair === null) {
          result = {
            quote: null,
            reasonCode: typeof b.reason === "string" && b.reason.length > 0 ? b.reason : null,
            provenance: provenance?.quality.readiness === "unavailable" ? provenance : null,
          };
        }
      }
      return this.put(this.fairCache, key, result, result.quote === null);
    })().finally(() => this.pendingFair.delete(key));
    this.pendingFair.set(key, request);
    return request;
  }

  async spot(tickerInput: string): Promise<bigint | null> {
    const ticker = tickerInput.toUpperCase();
    if (!/^[A-Z][A-Z0-9.]{0,12}$/.test(ticker)) return null;
    const cached = this.spotCache.get(ticker);
    if (cached !== undefined && cached.expires > this.now()) return cached.value;
    const pending = this.pendingSpot.get(ticker);
    if (pending !== undefined) return pending;
    const request = (async () => {
      const response = await this.get(`/surface/${encodeURIComponent(ticker)}`);
      const body = response.ok ? response.body : null;
      const spot = typeof body === "object" && body !== null && "spot" in body
        ? rawMoney((body as { spot: unknown }).spot)
        : null;
      return this.put(this.spotCache, ticker, spot !== null && spot > 0n ? spot : null);
    })().finally(() => this.pendingSpot.delete(ticker));
    this.pendingSpot.set(ticker, request);
    return request;
  }
}

let liveClient: PricingClient | undefined;

function live(): PricingClient {
  return liveClient ??= new PricingClient({ url: process.env.PRICING_URL });
}

/** Handler-friendly fair read, with the service's asOf for fill-time integrity checks. */
export async function fetchFairQuote(input: FairInput, options?: PricingOptions): Promise<FairQuote | null> {
  return (options === undefined ? live() : new PricingClient(options)).fair(input);
}

/** Handler-friendly fair read retaining upstream machine failures and optional provenance. */
export async function fetchFairResult(input: FairInput, options?: PricingOptions): Promise<FairResult> {
  return (options === undefined ? live() : new PricingClient(options)).fairResult(input);
}

export async function fetchPricingSpot(ticker: string, options?: PricingOptions): Promise<bigint | null> {
  return (options === undefined ? live() : new PricingClient(options)).spot(ticker);
}
