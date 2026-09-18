/**
 * The two indexer API v2 routes the cranker pages (indexer/src/api/v2/machine.ts):
 *   GET /v2/series/:longId/holders?side=long|short&limit=&cursor=  { items: [{ holder, units }], nextCursor }
 *   GET /v2/strategies?active=1&limit=&cursor=                     { items: [{ writer, underlying, ... }], nextCursor }
 *
 * The indexer is a convenience here, never a dependency (ADR-13 for writes, K2-03 "fall back to log
 * scans when the indexer is down"): every call resolves to `{ ok: false, reason }` on a network
 * error, a timeout, a non-200 or a body of the wrong shape, and the cranker then uses its own log
 * index alone. What an answer contributes is a list of CANDIDATES: balances and strategies are
 * always read from chain before anything is sent.
 */
import { getAddress, isAddress, type Address } from 'viem';

export const PAGE_LIMIT = 200;
/** A holder list longer than this many pages is not paged further in one tick (the log index still has everyone). */
export const MAX_PAGES = 50;

export type IndexerResult<T> = { ok: true; items: T[] } | { ok: false; reason: string };

export interface IndexerClientOptions {
  baseUrl: string;
  timeoutMs: number;
  fetch?: typeof fetch;
}

interface Page {
  items: unknown[];
  nextCursor: string | null;
}

function parsePage(body: unknown): Page | null {
  if (typeof body !== 'object' || body === null) return null;
  const { items, nextCursor } = body as { items?: unknown; nextCursor?: unknown };
  if (!Array.isArray(items)) return null;
  if (nextCursor !== null && typeof nextCursor !== 'string') return null;
  return { items, nextCursor };
}

export class IndexerClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: IndexerClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async pages(path: string, query: Record<string, string>): Promise<IndexerResult<unknown>> {
    const items: unknown[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams({ ...query, limit: String(PAGE_LIMIT), ...(cursor === null ? {} : { cursor }) });
      const url = `${this.options.baseUrl}${path}?${params.toString()}`;
      let response: Response;
      try {
        response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.options.timeoutMs), headers: { accept: 'application/json' } });
      } catch (error) {
        return { ok: false, reason: `unreachable: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (response.status !== 200) return { ok: false, reason: `HTTP ${response.status} from ${path}` };
      let parsed: Page | null;
      try {
        parsed = parsePage(await response.json());
      } catch {
        parsed = null;
      }
      if (parsed === null) return { ok: false, reason: `unexpected body from ${path}` };
      items.push(...parsed.items);
      if (parsed.nextCursor === null) return { ok: true, items };
      cursor = parsed.nextCursor;
    }
    return { ok: true, items };
  }

  /** Holders of the long or short side of a series with units > 0, escrow excluded (the indexer's rule). */
  async holders(longId: bigint, side: 'long' | 'short'): Promise<IndexerResult<Address>> {
    const result = await this.pages(`/v2/series/${longId.toString()}/holders`, { side });
    if (!result.ok) return result;
    const out: Address[] = [];
    for (const item of result.items) {
      const holder = (item as { holder?: unknown }).holder;
      if (typeof holder !== 'string' || !isAddress(holder, { strict: false })) return { ok: false, reason: 'holders: an item without a holder address' };
      out.push(getAddress(holder));
    }
    return { ok: true, items: out };
  }

  /** Active strategies: (writer, underlying) pairs. */
  async activeStrategies(): Promise<IndexerResult<{ writer: Address; underlying: Address }>> {
    const result = await this.pages('/v2/strategies', { active: '1' });
    if (!result.ok) return result;
    const out: Array<{ writer: Address; underlying: Address }> = [];
    for (const item of result.items) {
      const { writer, underlying } = item as { writer?: unknown; underlying?: unknown };
      if (typeof writer !== 'string' || typeof underlying !== 'string' || !isAddress(writer, { strict: false }) || !isAddress(underlying, { strict: false })) {
        return { ok: false, reason: 'strategies: an item without writer/underlying addresses' };
      }
      out.push({ writer: getAddress(writer), underlying: getAddress(underlying) });
    }
    return { ok: true, items: out };
  }
}
