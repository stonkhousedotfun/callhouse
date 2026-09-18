/** The pricing service is optional for indexer reads. A bad response never breaks a book. */

export type FairInput = {
  ticker: string;
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

export type PricingOptions = {
  url?: string;
  fetcher?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

type Entry<T> = { value: T; expires: number };
const DECIMAL = /^(?:0|[1-9]\d*)$/;

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

/** Separate fair and surface-spot caches, bounded for long-running Ponder processes. */
export class PricingClient {
  private readonly url: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly fairCache = new Map<string, Entry<FairQuote | null>>();
  private readonly spotCache = new Map<string, Entry<bigint | null>>();
  private readonly pendingFair = new Map<string, Promise<FairQuote | null>>();
  private readonly pendingSpot = new Map<string, Promise<bigint | null>>();

  constructor(options: PricingOptions = {}) {
    this.url = options.url?.replace(/\/$/, "");
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 3_000;
  }

  private async get(path: string): Promise<unknown | null> {
    if (this.url === undefined) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.url}${path}`, { signal: controller.signal });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private put<T>(cache: Map<string, Entry<T>>, key: string, value: T): T {
    // A failed service can recover quickly; successful quotes stay warm for the promised 30 s.
    cache.set(key, { value, expires: this.now() + (value === null ? 5_000 : 30_000) });
    if (cache.size > 512) cache.delete(cache.keys().next().value!);
    return value;
  }

  async fair(input: FairInput): Promise<FairQuote | null> {
    if (!DECIMAL.test(input.strike.toString()) || input.strike <= 0n || !Number.isSafeInteger(input.expiry) || input.expiry <= 0) return null;
    const ticker = input.ticker.toUpperCase();
    if (!/^[A-Z][A-Z0-9.]{0,12}$/.test(ticker)) return null;
    const key = `${ticker}:${input.strike}:${input.expiry}:${input.isPut ? "put" : "call"}`;
    const cached = this.fairCache.get(key);
    if (cached !== undefined && cached.expires > this.now()) return cached.value;
    const pending = this.pendingFair.get(key);
    if (pending !== undefined) return pending;
    const request = (async () => {
      const query = new URLSearchParams({ ticker, strike: input.strike.toString(), expiry: String(input.expiry), type: input.isPut ? "put" : "call" });
      const body = await this.get(`/fair?${query}`);
      let quote: FairQuote | null = null;
      if (typeof body === "object" && body !== null) {
        const b = body as Record<string, unknown>;
        const fair = rawMoney(b.fair);
        const spot = rawMoney(b.spot);
        if (fair !== null && spot !== null && spot > 0n && finite(b.iv) && finite(b.delta)
            && Number.isSafeInteger(b.asOf) && (b.asOf as number) > 0
            && (b.source === "cboe" || b.source === "model")) {
          quote = { fair, spot, iv: b.iv, delta: b.delta, asOf: b.asOf as number, source: b.source };
        }
      }
      return this.put(this.fairCache, key, quote);
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
      const body = await this.get(`/surface/${encodeURIComponent(ticker)}`);
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

export async function fetchPricingSpot(ticker: string, options?: PricingOptions): Promise<bigint | null> {
  return (options === undefined ? live() : new PricingClient(options)).spot(ticker);
}
