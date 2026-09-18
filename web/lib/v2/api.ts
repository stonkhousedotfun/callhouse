/** Strict, typed reader for the frozen indexer API v2. The v1 client remains independent. */
import type { z } from "zod";

import {
  activityResponseSchema,
  calendarHolidaysResponseSchema,
  bookResponseSchema,
  cardsResponseSchema,
  configResponseSchema,
  errorSchema,
  fairResponseSchema,
  healthResponseSchema,
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
  CalendarHolidaysResponse,
  BookResponse,
  CardsResponse,
  ConfigResponse,
  FairResponse,
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
  StatsResponse,
  StrategiesResponse,
  TradesResponse,
  WinsResponse,
} from "./api-types";

export const V2_API_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:42069").replace(/\/+$/, "");
export const V2_API_TIMEOUT_MS = 8_000;

export type ApiUnavailableReason = "network" | "timeout" | "http" | "invalid";

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
export type LeaderboardOptions = PageOptions & {
  metric?: "multiple" | "absolute" | "streak";
  window?: "week" | "month" | "all";
};

export class V2ApiClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor({ baseUrl = V2_API_BASE, fetchImpl = fetch, timeoutMs = V2_API_TIMEOUT_MS }: { baseUrl?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  private async read<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}, noStore = false): Promise<T> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      // Browser fetch rejects a receiver other than Window. Reading it into a
      // local keeps both the native fetch and injected test fetches callable.
      const fetchImpl = this.fetchImpl;
      response = await fetchImpl(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { accept: "application/json" },
        ...(noStore ? { cache: "no-store" as const } : {}),
        signal,
      });
    } catch (cause) {
      const timedOut = timeout.aborted || (cause instanceof Error && cause.name === "TimeoutError");
      throw new ApiUnavailable(timedOut ? "timeout" : "network", path, timedOut ? "Indexer request timed out" : "Indexer unavailable", { cause });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      throw new ApiUnavailable(timeout.aborted ? "timeout" : "invalid", path, timeout.aborted ? "Indexer request timed out" : "Indexer returned invalid JSON", { status: response.status, cause });
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
