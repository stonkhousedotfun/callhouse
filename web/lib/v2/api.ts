/** Strict, typed reader for the frozen indexer API v2. The v1 client remains independent. */
import type { z } from "zod";

import {
  activityResponseSchema,
  adminOperationsResponseSchema,
  calendarHolidaysResponseSchema,
  bookResponseSchema,
  cardsResponseSchema,
  configResponseSchema,
  errorSchema,
  fairResponseSchema,
  flywheelResponseSchema,
  earnResponseSchema,
  houseListResponseSchema,
  houseMarketResponseSchema,
  healthResponseSchema,
  servicesResponseSchema,
  heroCardResponseSchema,
  historyResponseSchema,
  holdersResponseSchema,
  leaderboardResponseSchema,
  makerResponseSchema,
  makersResponseSchema,
  marketSeriesResponseSchema,
  marketsResponseSchema,
  pnlResponseSchema,
  positionsResponseSchema,
  seriesDetailResponseSchema,
  statsResponseSchema,
  strategiesResponseSchema,
  tradesResponseSchema,
  winsResponseSchema,
} from "./api-schema";
import type {
  ActivityResponse,
  AdminOperationsResponse,
  CalendarHolidaysResponse,
  BookResponse,
  CardsResponse,
  ConfigResponse,
  FairResponse,
  FlywheelResponse,
  EarnResponse,
  HouseListResponse,
  HouseMarketResponse,
  HealthResponse,
  HeroCardResponse,
  HistoryResponse,
  HoldersResponse,
  LeaderboardResponse,
  MakerResponse,
  MakersResponse,
  MarketSeriesResponse,
  MarketsResponse,
  PnlResponse,
  PositionsResponse,
  SeriesDetailResponse,
  ServicesResponse,
  StatsResponse,
  StrategiesResponse,
  TradesResponse,
  WinsResponse,
} from "./api-types";

export const V2_API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:42069").replace(/\/+$/, "");
export const V2_API_TIMEOUT_MS = 8_000;
/** API pages are bounded; one MiB leaves headroom above the largest paginated response. */
export const V2_API_MAX_BYTES = 1024 * 1024;
export const V2_ALL_SERIES_TIMEOUT_MS = 20_000;
export const V2_ALL_SERIES_PAGE_SIZE = 200;
export const V2_ALL_SERIES_MAX_PAGES = 50;

export type ApiUnavailableReason = "network" | "timeout" | "redirect" | "too-large" | "http" | "invalid";

/** React Query retains its last good data when this error occurs; pages can show a degraded state. */
export class ApiUnavailable extends Error {
  readonly reason: ApiUnavailableReason;
  readonly path: string;
  readonly status?: number;
  readonly code?: string;

  constructor(reason: ApiUnavailableReason, path: string, message: string, options: { status?: number; code?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "ApiUnavailable";
    this.reason = reason;
    this.path = path;
    this.status = options.status;
    this.code = options.code;
  }
}

type RequestOptions = { signal?: AbortSignal };

/**
 * Mirrors the bounded stream reader in keeperOrders.ts. It stays local because importing that
 * server-side order module would pull wallet and Seaport validation into this shared API client.
 */
async function readCappedResponse(response: Response, maxBytes: number,
  signal?: AbortSignal): Promise<Uint8Array | "too-large"> {
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return "too-large";
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function pathWithParams(path: string, params?: object): string {
  if (!params) return path;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

function segment(value: string | number): string {
  return encodeURIComponent(String(value));
}

export type PageOptions = { limit?: number; cursor?: string };
export type MarketSeriesOptions = PageOptions & { expiry?: number; type?: "call" | "put"; status?: string };
export type CardsOptions = PageOptions & {
  ticker?: string;
  tenor?: "daily" | "weekly" | "special";
  type?: "call" | "put";
  sort?: "multiple" | "expiry" | "volume";
};
export type WinsOptions = PageOptions & { window?: "day" | "week" | "all" };
export type ActivityOptions = PageOptions & { since?: number; kinds?: string | readonly string[] };
export type AdminOperationsOptions = PageOptions & { status?: "pending" | "executed" | "canceled" };
export type LeaderboardOptions = PageOptions & {
  metric?: "multiple" | "absolute" | "streak";
  window?: "week" | "month" | "all";
};

export class V2ApiClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly allSeriesTimeoutMs: number;
  private readonly maxBytes: number;

  constructor({ baseUrl = V2_API_BASE, fetchImpl = fetch, timeoutMs = V2_API_TIMEOUT_MS,
    allSeriesTimeoutMs = V2_ALL_SERIES_TIMEOUT_MS, maxBytes = V2_API_MAX_BYTES }: {
    baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number; allSeriesTimeoutMs?: number; maxBytes?: number;
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.allSeriesTimeoutMs = allSeriesTimeoutMs;
    this.maxBytes = maxBytes;
  }

  private async read<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}, noStore = false,
    timeoutMs: number | null = this.timeoutMs): Promise<T> {
    const timeout = timeoutMs === null ? null : AbortSignal.timeout(timeoutMs);
    const signal = timeout === null ? options.signal
      : options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      // Browser fetch rejects a receiver other than Window. Reading it into a
      // local keeps both the native fetch and injected test fetches callable.
      const fetchImpl = this.fetchImpl;
      response = await fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        ...(noStore ? { cache: "no-store" as const } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch (cause) {
      const timedOut = timeout?.aborted === true || (cause instanceof Error && cause.name === "TimeoutError");
      throw new ApiUnavailable(timedOut ? "timeout" : "network", path, timedOut ? "Indexer request timed out" : "Indexer unavailable", { cause });
    }

    if (response.status === 0 || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel().catch(() => {});
      throw new ApiUnavailable("redirect", path, "Indexer returned a redirect, which is not followed", {
        status: response.status,
      });
    }

    const declaredLength = response.headers.get("content-length");
    const declaredBytes = declaredLength === null ? Number.NaN : Number(declaredLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > this.maxBytes) {
      void response.body?.cancel().catch(() => {});
      throw new ApiUnavailable("too-large", path, "Indexer response exceeded the byte limit", {
        status: response.status,
      });
    }

    let bytes: Uint8Array | "too-large";
    try {
      bytes = await readCappedResponse(response, this.maxBytes, signal);
    } catch (cause) {
      const timedOut = timeout?.aborted === true || (cause instanceof Error && cause.name === "TimeoutError");
      throw new ApiUnavailable(timedOut ? "timeout" : "invalid", path,
        timedOut ? "Indexer request timed out" : "Indexer response could not be read", { status: response.status, cause });
    }
    if (bytes === "too-large") {
      throw new ApiUnavailable("too-large", path, "Indexer response exceeded the byte limit", {
        status: response.status,
      });
    }

    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch (cause) {
      throw new ApiUnavailable("invalid", path, "Indexer returned invalid JSON", { status: response.status, cause });
    }
    if (!response.ok) {
      const parsed = errorSchema.safeParse(body);
      throw new ApiUnavailable("http", path, parsed.success ? parsed.data.error.message : `Indexer returned HTTP ${response.status}`, {
        status: response.status,
        code: parsed.success ? parsed.data.error.code : undefined,
      });
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ApiUnavailable("invalid", path, "Indexer response did not match API v2", {
        status: response.status,
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  getHealth(options?: RequestOptions): Promise<HealthResponse> {
    return this.read("/v2/health", healthResponseSchema, options, true);
  }
  /**
   * Readiness of the services the indexer does not run (T-424). `noStore` for the same reason
   * `getHealth` has it: a cached readiness answer is the same defect as a cached health answer —
   * it reports a dead service as alive for as long as the cache lives.
   */
  getServices(options?: RequestOptions): Promise<ServicesResponse> {
    return this.read("/v2/services", servicesResponseSchema, options, true);
  }
  getAdminOperations(params: AdminOperationsOptions = {}, options?: RequestOptions): Promise<AdminOperationsResponse> {
    return this.read(pathWithParams("/v2/admin/operations", params), adminOperationsResponseSchema, options);
  }
  getFlywheel(options?: RequestOptions): Promise<FlywheelResponse> {
    return this.read("/v2/flywheel", flywheelResponseSchema, options);
  }
  getEarn(params: { address?: string } = {}, options?: RequestOptions): Promise<EarnResponse> {
    return this.read(pathWithParams("/v2/earn", params), earnResponseSchema, options);
  }
  getHouse(options?: RequestOptions): Promise<HouseListResponse> {
    return this.read("/v2/house", houseListResponseSchema, options);
  }
  getHouseMarket(market: string, params: { address?: string } = {}, options?: RequestOptions): Promise<HouseMarketResponse> {
    return this.read(pathWithParams(`/v2/house/${segment(market)}`, params), houseMarketResponseSchema, options);
  }
  getConfig(options?: RequestOptions): Promise<ConfigResponse> {
    return this.read("/v2/config", configResponseSchema, options, true);
  }
  getMarkets(options?: RequestOptions): Promise<MarketsResponse> {
    return this.read("/v2/markets", marketsResponseSchema, options);
  }
  getCalendarHolidays(fromDay: number, toDay: number, options?: RequestOptions): Promise<CalendarHolidaysResponse> {
    return this.read(pathWithParams("/v2/calendar/holidays", { fromDay, toDay }), calendarHolidaysResponseSchema, options);
  }
  getMarketSeries(ticker: string, params: MarketSeriesOptions = {}, options?: RequestOptions): Promise<MarketSeriesResponse> {
    return this.read(pathWithParams(`/v2/markets/${segment(ticker)}/series`, params), marketSeriesResponseSchema, options);
  }
  async getAllMarketSeries(ticker: string, params: Omit<MarketSeriesOptions, "cursor" | "limit"> = {}, options?: RequestOptions): Promise<MarketSeriesResponse> {
    const path = `/v2/markets/${segment(ticker)}/series`;
    const walkTimeout = AbortSignal.timeout(this.allSeriesTimeoutMs);
    const signal = options?.signal ? AbortSignal.any([options.signal, walkTimeout]) : walkTimeout;
    const items: MarketSeriesResponse["items"] = [];
    const seenIds = new Set<string>();
    const identities = new Map<string, string>();
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let asOf: number | undefined;
    for (let page = 0; page < V2_ALL_SERIES_MAX_PAGES; page += 1) {
      const pagePath = pathWithParams(path,
        { ...params, limit: V2_ALL_SERIES_PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      // The traversal owns one deadline. Adding the ordinary per-request timeout here would make
      // an otherwise healthy page fail at eight seconds even though the 20-second walk is current.
      const response = await this.read(pagePath, marketSeriesResponseSchema, { signal }, false, null);
      // The merged walk is only as fresh as its stalest page, so it reports the oldest indexed head it read.
      asOf = asOf === undefined ? response.asOf : Math.min(asOf, response.asOf);
      if (response.items.length > V2_ALL_SERIES_PAGE_SIZE)
        throw new ApiUnavailable("invalid", path, "Indexer returned an oversized series page");
      if (response.nextCursor && seenCursors.has(response.nextCursor))
        throw new ApiUnavailable("invalid", path, "Indexer repeated a series cursor");
      if (response.nextCursor && response.items.length < V2_ALL_SERIES_PAGE_SIZE)
        throw new ApiUnavailable("invalid", path, "Indexer returned a short nonterminal series page");
      let added = 0;
      for (const item of response.items) {
        const row = item.series;
        if (row.ticker.toUpperCase() !== ticker.toUpperCase() ||
            (params.type !== undefined && row.isPut !== (params.type === "put")) ||
            (params.status !== undefined && row.status !== params.status) ||
            (params.expiry !== undefined && row.expiry !== params.expiry))
          throw new ApiUnavailable("invalid", path, "Indexer returned a series outside the requested market filters");
        const identity = [row.shortId, row.ticker.toUpperCase(), row.underlying.toLowerCase(), row.isPut ? "put" : "call",
          row.strike.raw, row.strike.decimals, row.expiry, row.tenor, row.mintCutoff].join(":");
        const knownIdentity = identities.get(row.longId);
        if (knownIdentity !== undefined && knownIdentity !== identity)
          throw new ApiUnavailable("invalid", path, "Indexer returned conflicting series identities");
        identities.set(row.longId, identity);
        if (!seenIds.has(row.longId)) {
          seenIds.add(row.longId);
          items.push(item);
          added += 1;
        }
      }
      if (response.items.length > 0 && added === 0)
        throw new ApiUnavailable("invalid", path, "Indexer series pagination made no progress");
      if (!response.nextCursor) return { items, asOf, nextCursor: null };
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
    throw new ApiUnavailable("invalid", path, "Indexer returned too many series pages");
  }
  getSeries(longId: string, options?: RequestOptions): Promise<SeriesDetailResponse> {
    return this.read(`/v2/series/${segment(longId)}`, seriesDetailResponseSchema, options);
  }
  getBook(longId: string, depth = 20, options?: RequestOptions): Promise<BookResponse> {
    return this.read(pathWithParams(`/v2/series/${segment(longId)}/book`, { depth }), bookResponseSchema, options);
  }
  getHolders(longId: string, params: PageOptions & { side?: "long" | "short" } = {}, options?: RequestOptions): Promise<HoldersResponse> {
    return this.read(pathWithParams(`/v2/series/${segment(longId)}/holders`, params), holdersResponseSchema, options);
  }
  getTrades(longId: string, params: PageOptions = {}, options?: RequestOptions): Promise<TradesResponse> {
    return this.read(pathWithParams(`/v2/series/${segment(longId)}/trades`, params), tradesResponseSchema, options);
  }
  getCards(params: CardsOptions = {}, options?: RequestOptions): Promise<CardsResponse> {
    return this.read(pathWithParams("/v2/cards", params), cardsResponseSchema, options);
  }
  getHeroCard(options?: RequestOptions): Promise<HeroCardResponse> {
    return this.read("/v2/cards/hero", heroCardResponseSchema, options);
  }
  getPositions(address: string, options?: RequestOptions): Promise<PositionsResponse> {
    return this.read(`/v2/accounts/${segment(address)}/positions`, positionsResponseSchema, options);
  }
  getHistory(address: string, params: PageOptions = {}, options?: RequestOptions): Promise<HistoryResponse> {
    return this.read(pathWithParams(`/v2/accounts/${segment(address)}/history`, params), historyResponseSchema, options);
  }
  getWins(params: WinsOptions = {}, options?: RequestOptions): Promise<WinsResponse> {
    return this.read(pathWithParams("/v2/feed/wins", params), winsResponseSchema, options);
  }
  getActivity(params: ActivityOptions = {}, options?: RequestOptions): Promise<ActivityResponse> {
    const { kinds, ...rest } = params;
    return this.read(pathWithParams("/v2/feed/activity", { ...rest, kinds: typeof kinds === "string" ? kinds : kinds?.join(",") }), activityResponseSchema, options);
  }
  getStrategies(params: PageOptions & { active?: boolean } = {}, options?: RequestOptions): Promise<StrategiesResponse> {
    return this.read(pathWithParams("/v2/strategies", params), strategiesResponseSchema, options);
  }
  getLeaderboard(params: LeaderboardOptions = {}, options?: RequestOptions): Promise<LeaderboardResponse> {
    return this.read(pathWithParams("/v2/leaderboard", params), leaderboardResponseSchema, options);
  }
  getPnl(id: string, options?: RequestOptions): Promise<PnlResponse> {
    return this.read(`/v2/pnl/${segment(id)}`, pnlResponseSchema, options);
  }
  getStats(options?: RequestOptions): Promise<StatsResponse> {
    return this.read("/v2/stats", statsResponseSchema, options);
  }
  getMakers(params: PageOptions = {}, options?: RequestOptions): Promise<MakersResponse> {
    return this.read(pathWithParams("/v2/makers", params), makersResponseSchema, options);
  }
  getMaker(address: string, options?: RequestOptions): Promise<MakerResponse> {
    return this.read(`/v2/makers/${segment(address)}`, makerResponseSchema, options);
  }
  getFair(longId: string, options?: RequestOptions): Promise<FairResponse> {
    return this.read(`/v2/fair/${segment(longId)}`, fairResponseSchema, options);
  }
}

export const v2Api = new V2ApiClient();
