"use client";

/** React Query readers for API v2. Errors stay visible; cached data remains available. */
import { useQuery } from "@tanstack/react-query";

import {
  v2Api,
  type ApiUnavailable,
  type ActivityOptions,
  type CardsOptions,
  type LeaderboardOptions,
  type MarketSeriesOptions,
  type PageOptions,
  type WinsOptions,
} from "./api";

const LIVE = { staleTime: 15_000, refetchInterval: 15_000, refetchOnWindowFocus: true } as const;
const FRESH = { staleTime: 0, refetchInterval: 5_000, refetchOnWindowFocus: true, retry: 0 } as const;

/** Shared prefixes for invalidating after a transaction. */
export const v2Keys = {
  all: ["v2"] as const,
  health: ["v2", "health"] as const,
  config: ["v2", "config"] as const,
  markets: ["v2", "markets"] as const,
  marketSeries: (ticker: string | undefined, filters: MarketSeriesOptions = {}) => ["v2", "marketSeries", ticker, filters] as const,
  series: (longId: string | undefined) => ["v2", "series", longId] as const,
  book: (longId: string | undefined, depth: number) => ["v2", "book", longId, depth] as const,
  holders: (longId: string | undefined, filters: PageOptions & { side?: "long" | "short" } = {}) => ["v2", "holders", longId, filters] as const,
  trades: (longId: string | undefined, filters: PageOptions = {}) => ["v2", "trades", longId, filters] as const,
  cards: (filters: CardsOptions = {}) => ["v2", "cards", filters] as const,
  heroCard: ["v2", "heroCard"] as const,
  positions: (address: string | undefined) => ["v2", "positions", address?.toLowerCase()] as const,
  history: (address: string | undefined, filters: PageOptions = {}) => ["v2", "history", address?.toLowerCase(), filters] as const,
  wins: (filters: WinsOptions = {}) => ["v2", "wins", filters] as const,
  activity: (filters: ActivityOptions = {}) => ["v2", "activity", filters] as const,
  strategies: (filters: PageOptions & { active?: boolean } = {}) => ["v2", "strategies", filters] as const,
  leaderboard: (filters: LeaderboardOptions = {}) => ["v2", "leaderboard", filters] as const,
  pnl: (id: string | undefined) => ["v2", "pnl", id] as const,
  stats: ["v2", "stats"] as const,
  makers: (filters: PageOptions = {}) => ["v2", "makers", filters] as const,
  maker: (address: string | undefined) => ["v2", "maker", address?.toLowerCase()] as const,
  fair: (longId: string | undefined) => ["v2", "fair", longId] as const,
};

function useV2Query<T>(key: readonly unknown[], read: (signal: AbortSignal) => Promise<T>, enabled = true, fresh = false) {
  return useQuery<T, ApiUnavailable>({
    queryKey: key,
    queryFn: ({ signal }) => read(signal),
    enabled,
    ...(fresh ? FRESH : LIVE),
  });
}

export function useHealth() {
  return useV2Query(v2Keys.health, (signal) => v2Api.getHealth({ signal }), true, true);
}
export function useConfig() {
  return useV2Query(v2Keys.config, (signal) => v2Api.getConfig({ signal }), true, true);
}
export function useMarkets() {
  return useV2Query(v2Keys.markets, (signal) => v2Api.getMarkets({ signal }));
}
export function useMarketSeries(ticker?: string, filters: MarketSeriesOptions = {}) {
  return useV2Query(v2Keys.marketSeries(ticker, filters), (signal) => v2Api.getMarketSeries(ticker!, filters, { signal }), Boolean(ticker));
}
export function useSeries(longId?: string) {
  return useV2Query(v2Keys.series(longId), (signal) => v2Api.getSeries(longId!, { signal }), Boolean(longId));
}
export function useBook(longId?: string, depth = 20) {
  return useV2Query(v2Keys.book(longId, depth), (signal) => v2Api.getBook(longId!, depth, { signal }), Boolean(longId));
}
export function useHolders(longId?: string, filters: PageOptions & { side?: "long" | "short" } = {}) {
  return useV2Query(v2Keys.holders(longId, filters), (signal) => v2Api.getHolders(longId!, filters, { signal }), Boolean(longId));
}
export function useTrades(longId?: string, filters: PageOptions = {}) {
  return useV2Query(v2Keys.trades(longId, filters), (signal) => v2Api.getTrades(longId!, filters, { signal }), Boolean(longId));
}
export function useCards(filters: CardsOptions = {}) {
  return useV2Query(v2Keys.cards(filters), (signal) => v2Api.getCards(filters, { signal }));
}
export function useHeroCard() {
  return useV2Query(v2Keys.heroCard, (signal) => v2Api.getHeroCard({ signal }));
}
export function usePositions(address?: string) {
  return useV2Query(v2Keys.positions(address), (signal) => v2Api.getPositions(address!, { signal }), Boolean(address));
}
export function useHistory(address?: string, filters: PageOptions = {}) {
  return useV2Query(v2Keys.history(address, filters), (signal) => v2Api.getHistory(address!, filters, { signal }), Boolean(address));
}
export function useWins(filters: WinsOptions = {}) {
  return useV2Query(v2Keys.wins(filters), (signal) => v2Api.getWins(filters, { signal }));
}
export function useActivity(filters: ActivityOptions = {}) {
  return useV2Query(v2Keys.activity(filters), (signal) => v2Api.getActivity(filters, { signal }));
}
export function useStrategies(filters: PageOptions & { active?: boolean } = {}) {
  return useV2Query(v2Keys.strategies(filters), (signal) => v2Api.getStrategies(filters, { signal }));
}
export function useLeaderboard(filters: LeaderboardOptions = {}) {
  return useV2Query(v2Keys.leaderboard(filters), (signal) => v2Api.getLeaderboard(filters, { signal }));
}
export function usePnl(id?: string) {
  return useV2Query(v2Keys.pnl(id), (signal) => v2Api.getPnl(id!, { signal }), Boolean(id));
}
export function useStats() {
  return useV2Query(v2Keys.stats, (signal) => v2Api.getStats({ signal }));
}
export function useMakers(filters: PageOptions = {}) {
  return useV2Query(v2Keys.makers(filters), (signal) => v2Api.getMakers(filters, { signal }));
}
export function useMaker(address?: string) {
  return useV2Query(v2Keys.maker(address), (signal) => v2Api.getMaker(address!, { signal }), Boolean(address));
}
export function useFair(longId?: string) {
  return useV2Query(v2Keys.fair(longId), (signal) => v2Api.getFair(longId!, { signal }), Boolean(longId));
}
