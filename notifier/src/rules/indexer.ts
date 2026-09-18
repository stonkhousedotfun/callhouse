/**
 * The indexer API v2 as the rules engine reads it: five routes, a deadline on
 * every call, and a zod parse of every response before anything trusts it.
 *
 *   GET /v2/markets                          spot per ticker
 *   GET /v2/feed/activity?since&cursor       fills, settlements, redemptions, rolls, oldest first
 *   GET /v2/accounts/:address/positions      holdings of ONE subscribed wallet (the watch set)
 *   GET /v2/calendar/holidays?fromDay&toDay  ExpiryCalendar session days, at most 62 per call
 *   GET /v2/series/:longId                   fallback only: a settled long whose settlement item
 *                                            was never seen (engine.ts step 5)
 *
 * SCHEMAS MIRROR web/lib/v2/api-schema.ts (the frozen contract; indexer/src/api/v2/schema.ts is
 * its twin) for the fields read here, copied rather than imported: web/ is a Next app and this
 * package builds alone in its Docker image. Every field read has the contract's type, presence
 * and nullability exactly (a field the contract requires is required here too: `recipient`,
 * `settlementPrice`, `lastRolledAt`, and every calendar field), and is checked with the contract's
 * own rule (canonical uint strings, checksummed addresses, unix seconds). The objects are not
 * `.strict()` about keys the notifier does not read: the indexer already validates every response
 * against the strict schema before it leaves (500 `schema_mismatch` otherwise), so rejecting
 * unknown keys here would add nothing but a notifier that stops reading the feed the day the API
 * gains a field. Interface v4 fields the notifier depends on:
 *   - fill `data.recipient`: the take's recipient, who received the longs on an ask hit and the
 *     taker's USDG on a bid hit (OrderFilled.recipient); it is also in `accounts`;
 *   - redemption `data.settlementPrice`: the series' settlement price, never null on a redemption;
 *   - positions `strategies[].lastRolledAt`: unix seconds of the strategy's last Rolled, or null;
 *   - settlement items carry the Clearinghouse SeriesSettled block, log and timestamp, so the feed
 *     is ordered by (block, log) with `ts` that block's time for every kind.
 *   - markets return paired null spot/spotUpdatedAt when that ticker's oracle read fails;
 *     healthy ticker spots remain available in the same response.
 *
 * FAILURES are an IndexerError with a secret-free code: `timeout`, a network code, `http_<status>`,
 * `bad_json`, `bad_response`. The message never carries the URL: a positions path holds a wallet
 * address, which log.ts keeps out of the logs.
 */
import { getAddress } from 'viem';
import { z } from 'zod';
import { errorCode } from '../log.js';

/* ------------------------------------------------------------------ scalars */

const uintString = z.string().regex(/^(0|[1-9]\d*)$/, 'a canonical decimal uint string');
const unix = z.number().int().nonnegative();
const address = z.string().refine((a) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return false;
  return getAddress(a) === a;
}, 'an EIP-55 checksummed address');
const txHash = z.string().regex(/^0x[0-9a-f]{64}$/, 'a lowercase 0x-prefixed 32-byte hash');

export const apiMoneySchema = z.object({ raw: uintString, decimals: z.number().int().nonnegative(), formatted: z.string() });
export type ApiMoney = z.infer<typeof apiMoneySchema>;

export const apiSeriesSchema = z.object({
  longId: uintString,
  shortId: uintString,
  ticker: z.string().min(1),
  underlying: address,
  isPut: z.boolean(),
  strike: apiMoneySchema,
  expiry: unix,
  tenor: z.enum(['daily', 'weekly', 'special']),
  mintCutoff: unix,
  status: z.enum(['open', 'cutoff', 'expired', 'settling', 'held', 'settled']),
});
export type ApiSeries = z.infer<typeof apiSeriesSchema>;

/* ------------------------------------------------------------------ /v2/markets */

export const marketsSchema = z.array(
  z.object({
    ticker: z.string().min(1),
    underlying: address,
    status: z.enum(['planned', 'live', 'paused']),
    spot: apiMoneySchema.nullable(),
    spotUpdatedAt: unix.nullable(),
  }).refine((market) => (market.spot === null) === (market.spotUpdatedAt === null),
    'spot and spotUpdatedAt must both be available or unavailable'),
);
export type ApiMarket = z.infer<typeof marketsSchema>[number];

/* ------------------------------------------------------------------ /v2/feed/activity */

const activityBase = {
  id: z.string().min(1),
  ts: unix,
  longId: uintString,
  series: apiSeriesSchema,
  accounts: z.array(address),
};

export const activityItemSchema = z.discriminatedUnion('kind', [
  z.object({
    ...activityBase,
    kind: z.literal('fill'),
    data: z.object({
      orderId: uintString,
      taker: address,
      maker: address,
      /** Interface v4: received the longs when takerIsBuyer, the taker's USDG proceeds otherwise. */
      recipient: address,
      units: uintString,
      price: apiMoneySchema,
      premium: apiMoneySchema,
      takerFee: apiMoneySchema,
      sellerFee: apiMoneySchema,
      makerRebate: apiMoneySchema,
      primary: z.boolean(),
      takerIsBuyer: z.boolean(),
      tx: txHash,
    }),
  }),
  z.object({
    ...activityBase,
    kind: z.literal('settlement'),
    data: z.object({
      price: apiMoneySchema,
      longPayoutPerUnit: apiMoneySchema,
      feePerUnit: apiMoneySchema,
      shortPayoutPerUnit: apiMoneySchema,
      tx: txHash,
    }),
  }),
  z.object({
    ...activityBase,
    kind: z.literal('redemption'),
    data: z.object({
      holder: address,
      side: z.enum(['long', 'short']),
      tokenId: uintString,
      units: uintString,
      asset: address,
      amount: apiMoneySchema,
      amountInKind: apiMoneySchema,
      /** USDG per share: the redeemed series' settlement price. */
      settlementPrice: apiMoneySchema,
      toLedger: z.boolean(),
      tx: txHash,
    }),
  }),
  z.object({
    ...activityBase,
    kind: z.literal('roll'),
    data: z.object({ writer: address, orderId: uintString, price: apiMoneySchema, units: uintString, tx: txHash }),
  }),
  /**
   * INTERFACE_VERSION 7 (c16): `AutoRoller.cancelStale` withdrew a roll ask the spot had overtaken.
   * `OrderCancelled` comes first in the same transaction, so the order row is already cancelled; this
   * item is the deliberate withdrawal, not a failed roll. `nextRollAfter` is the cancelled series'
   * expiry: the strategy rolls again after it.
   */
  z.object({
    ...activityBase,
    kind: z.literal('stale_cancel'),
    data: z.object({
      writer: address,
      orderId: uintString,
      spot: apiMoneySchema,
      spotUpdatedAt: unix,
      nextRollAfter: unix,
      tx: txHash,
    }),
  }),
]);
export type ActivityItem = z.infer<typeof activityItemSchema>;
export type FillItem = Extract<ActivityItem, { kind: 'fill' }>;
export type SettlementItem = Extract<ActivityItem, { kind: 'settlement' }>;
export type RedemptionItem = Extract<ActivityItem, { kind: 'redemption' }>;
export type RollItem = Extract<ActivityItem, { kind: 'roll' }>;
export type StaleCancelItem = Extract<ActivityItem, { kind: 'stale_cancel' }>;

export const activityPageSchema = z.object({
  items: z.array(activityItemSchema),
  nextCursor: z.string().min(1).nullable(),
});
export type ActivityPage = z.infer<typeof activityPageSchema>;

/* ------------------------------------------------------------------ /v2/accounts/:address/positions */

export const positionsSchema = z.object({
  longs: z.array(z.object({ series: apiSeriesSchema, units: uintString, avgCost: apiMoneySchema })),
  shorts: z.array(z.object({ series: apiSeriesSchema, units: uintString, collateralLocked: apiMoneySchema })),
  strategies: z.array(
    z.object({
      ticker: z.string().min(1),
      strategy: z.object({ active: z.boolean() }),
      currentSeries: apiSeriesSchema.nullable(),
      lastRolledAt: unix.nullable(),
    }),
  ),
  prefs: z.object({ inKind: z.boolean(), toLedger: z.boolean() }),
});
export type ApiPositions = z.infer<typeof positionsSchema>;

/* ------------------------------------------------------------------ /v2/calendar/holidays */

/** The route refuses a range of more than 62 days (toDay − fromDay ≤ 61), inclusive. */
export const CALENDAR_MAX_DAYS = 62;

export const calendarSchema = z.object({
  items: z.array(
    z.object({
      /** floor(unix / 86400) of the New York date's 16:00 close (the same UTC date). */
      dayIndex: z.number().int().nonnegative(),
      isHoliday: z.boolean(),
      /** A weekday that is not an ExpiryCalendar holiday. */
      isSessionDay: z.boolean(),
    }),
  ),
});
export type ApiCalendar = z.infer<typeof calendarSchema>;

/* ------------------------------------------------------------------ /v2/series/:longId */

export const seriesDetailSchema = z.object({
  series: apiSeriesSchema,
  settlement: z
    .object({
      status: z.enum(['None', 'Pending', 'Finalized', 'Held']),
      price: apiMoneySchema.nullable(),
      longPayoutPerUnit: apiMoneySchema.nullable(),
      finalizedAt: unix.nullable(),
    })
    .nullable(),
});
export type ApiSeriesDetail = z.infer<typeof seriesDetailSchema>;

/* ------------------------------------------------------------------ client */

export class IndexerError extends Error {
  constructor(
    readonly route: string,
    readonly code: string,
  ) {
    super(`indexer ${route}: ${code}`);
    this.name = 'IndexerError';
  }
}

export interface IndexerClient {
  markets(): Promise<ApiMarket[]>;
  activity(query: { since: number; cursor?: string | null; limit: number }): Promise<ActivityPage>;
  positions(address: string): Promise<ApiPositions>;
  /** Inclusive; at most CALENDAR_MAX_DAYS days (the client refuses a wider range before any request). */
  calendar(fromDay: number, toDay: number): Promise<ApiCalendar>;
  series(longId: string): Promise<ApiSeriesDetail>;
}

export const INDEXER_TIMEOUT_MS = 10_000;

export function createIndexerClient(options: { baseUrl: string; timeoutMs?: number }): IndexerClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? INDEXER_TIMEOUT_MS;

  async function get<S extends z.ZodTypeAny>(route: string, path: string, schema: S): Promise<z.infer<S>> {
    let response: Response;
    try {
      response = await fetch(`${base}${path}`, {
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new IndexerError(route, errorCode(error));
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new IndexerError(route, `http_${response.status}`);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      const code = errorCode(error);
      throw new IndexerError(route, code === 'timeout' ? code : 'bad_json');
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new IndexerError(route, 'bad_response');
    return parsed.data;
  }

  return {
    markets: () => get('markets', '/v2/markets', marketsSchema),
    activity: ({ since, cursor, limit }) => {
      const params = new URLSearchParams({ since: String(since), kinds: 'fill,settlement,redemption,roll', limit: String(limit) });
      if (cursor !== undefined && cursor !== null) params.set('cursor', cursor);
      return get('activity', `/v2/feed/activity?${params.toString()}`, activityPageSchema);
    },
    positions: (wallet) => get('positions', `/v2/accounts/${getAddress(wallet)}/positions`, positionsSchema),
    calendar: (fromDay, toDay) => {
      if (!Number.isSafeInteger(fromDay) || !Number.isSafeInteger(toDay) || fromDay < 0 || toDay < fromDay || toDay - fromDay >= CALENDAR_MAX_DAYS) {
        return Promise.reject(new IndexerError('calendar', 'bad_calendar_range'));
      }
      return get('calendar', `/v2/calendar/holidays?fromDay=${fromDay}&toDay=${toDay}`, calendarSchema);
    },
    series: (longId) => {
      if (!/^(0|[1-9]\d*)$/.test(longId)) return Promise.reject(new IndexerError('series', 'bad_long_id'));
      return get('series', `/v2/series/${longId}`, seriesDetailSchema);
    },
  };
}
