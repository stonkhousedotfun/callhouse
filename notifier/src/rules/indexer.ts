/**
 * The indexer API v2 as the rules engine reads it: six routes, a deadline on
 * every call, and a zod parse of every response before anything trusts it.
 *
 *   GET /v2/markets                          spot per ticker
 *   GET /v2/feed/activity?since&cursor       every ACTIVITY_KINDS item, oldest first: fills,
 *                                            settlements, redemptions, rolls, stale cancels
 *   GET /v2/accounts/:address/positions      holdings of ONE subscribed wallet (the watch set)
 *   GET /v2/calendar/holidays?fromDay&toDay  ExpiryCalendar session days, at most 62 per call
 *   GET /v2/series/:longId                   fallback only: a settled long whose settlement item
 *                                            was never seen (engine.ts step 5)
 *   GET /v2/config                           chainId, interfaceVersion, deployBlock — the
 *                                            deployment anchor (engine.ts), and the interface
 *                                            version this build refuses to run against when it is
 *                                            not IMPLEMENTED_INTERFACE_VERSION. Other config keys
 *                                            are ignored here (this schema is not `.strict()`).
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

/* ------------------------------------------------------------------ /v2/config */

/**
 * Copied from web/lib/v2/api-schema.ts configResponseSchema:528-532, not imported: this package
 * builds alone. chainId and interfaceVersion are countSchema (number, int, nonnegative);
 * deployBlock is uintStringSchema.nullable(). Not `.strict()`: the indexer already validates.
 */
const feeBps = z.number().int().nonnegative();
export const pendingFeesSchema = z.object({
  premiumFeeBps: feeBps,
  resaleFeeBps: feeBps,
  takerFeeFlat: apiMoneySchema,
  takerFeeCapBps: feeBps,
  makerRebateBps: feeBps,
  /** Unix seconds. Source: web/lib/v2/api-schema.ts configResponseSchema.pendingFees.effectiveAt. */
  effectiveAt: unix,
}).nullable();
export const liveFeesSchema = z.object({
  premiumFeeBps: feeBps,
  resaleFeeBps: feeBps,
  takerFeeFlat: apiMoneySchema,
  takerFeeCapBps: feeBps,
  makerRebateBps: feeBps,
});
export const configSchema = z.object({
  chainId: z.number().int().nonnegative(),
  interfaceVersion: z.number().int().nonnegative(),
  deployBlock: uintString.nullable(),
  fees: liveFeesSchema.optional(),
  pendingFees: pendingFeesSchema.optional(),
});
export type ApiConfig = z.infer<typeof configSchema>;

/**
 * The interface version THIS BINARY implements.
 *
 * Mirrored from `web/lib/v2/config.ts` (`remote.interfaceVersion !== 8`), the pin the dapp already
 * carries, so the two consumers of /v2/config state the same number rather than each deriving one.
 * It is a BUILD-TIME constant and is deliberately NOT read from the indexer: a value taken from the
 * peer you are checking cannot disagree with it, and a check that cannot fail is not a check.
 *
 * This is the opposite stance from `deploymentAnchor` below, whose inputs are runtime deployment
 * IDENTITY and must never be hardcoded. Identity says WHICH deployment; this says WHICH PAYLOAD
 * SHAPES this build was written to decode. The anchor covers a cutover; it does not cover a build
 * pointed at an indexer of a different interface, because the anchor has no opinion about the
 * version it merely concatenates (`:176`).
 *
 * Raise it in the same commit that teaches this package a new payload shape.
 */
export const IMPLEMENTED_INTERFACE_VERSION = 8;
export type ApiPendingFees = NonNullable<z.infer<typeof pendingFeesSchema>>;
export type ApiLiveFees = z.infer<typeof liveFeesSchema>;

export function liveFeesKey(fees: ApiLiveFees): string {
  return JSON.stringify([
    fees.premiumFeeBps, fees.resaleFeeBps, fees.takerFeeFlat.raw, fees.takerFeeFlat.decimals,
    fees.takerFeeCapBps, fees.makerRebateBps,
  ]);
}

/** The contract's own rule for `key` (web/lib/v2/api-schema.ts OPERATION_KEY_RE): `<operationId>:<nonce>`. */
const operationKey = z.string().regex(/^0x[0-9a-f]{64}:(0|[1-9]\d{0,9})$/, 'expected <operationId>:<nonce>');

export const adminOperationSchema = z.object({
  /**
   * T-435. THE PER-OPERATION IDENTITY, and the only thing this package keys an operation on. `id` is
   * AccessManager's operation id and it REPEATS: rescheduling the same call reuses it, so two live
   * operations can share one `id` and only `key` (T-434) tells them apart.
   */
  key: operationKey,
  id: z.string().min(1),
  role: z.string().min(1),
  target: address,
  /**
   * T-435. NULLABLE, as the contract declares it: null when the scheduled calldata is shorter than a
   * four-byte selector, a case the indexer serves on purpose (indexer/src/api/v2/routes.test.ts,
   * 'keeps a scheduled selector-less operation visible in both public views'). This copy used to
   * require a string, and because the page is parsed as one array a single selector-less operation
   * failed `adminOperationsPageSchema` and threw away EVERY operation on the page. The notifier reads
   * no selector; null is accepted and simply absent downstream.
   */
  selector: z.string().regex(/^0x[0-9a-f]{8}$/).nullable(),
  label: z.string().min(1),
  caller: address,
  scheduledAt: unix,
  readyAt: unix,
  status: z.enum(['pending', 'executed', 'canceled']),
});
export type ApiAdminOperation = z.infer<typeof adminOperationSchema>;
export const adminOperationsPageSchema = z.object({
  items: z.array(adminOperationSchema),
  nextCursor: z.string().nullable().optional(),
});

/**
 * X8-181. The three statuses `/v2/admin/operations` serves, asked for one at a time because the route
 * takes exactly one (`indexer/src/api/v2/admin.ts:92-95`: `status` defaults to `pending` and anything
 * outside this set is a `bad_status` error). Asking for only `pending`, which is what the default did,
 * means the notifier never sees an operation reach a terminal state — and `executed` and `canceled` are
 * the half that actually moved protocol state.
 *
 * Deliberately NOT `executed` only: a canceled operation is a different notice, not a missing one.
 */
const ADMIN_OPERATION_STATUSES = ['pending', 'executed', 'canceled'] as const;

/** The route's own ceiling (`indexer/src/api/v2/shared.ts` `limit()`: default 50, capped at 200). */
const ADMIN_OPERATIONS_PAGE = 200;

/**
 * Pages per status before the read gives up. 200 x 25 is 5,000 operations of one status, which the
 * AccessManager will not produce in the life of this deployment; the bound exists so a cursor the route
 * never stops advancing cannot hang a tick, not because the ceiling is expected.
 *
 * Reaching it THROWS rather than returning a short list. A truncated read looks exactly like a complete
 * one to every caller, and the engine's catch already does the right thing with a failure: it keeps the
 * operations it had and logs. Returning the first 5,000 silently would be the same defect this task
 * exists to fix, one layer down.
 */
export const ADMIN_OPERATIONS_MAX_PAGES = 25;

/**
 * The deployment identity persisted as rules_state.anchor.
 * Composition: `${chainId}:${interfaceVersion}:${deployBlock}` with the JSON token `null`
 * (four letters) when deployBlock is null, so a missing block is distinct from the uint
 * string "0". Values come from /v2/config at runtime — never a hardcoded chain or version.
 */
export function deploymentAnchor(config: ApiConfig): string {
  return `${config.chainId}:${config.interfaceVersion}:${config.deployBlock === null ? 'null' : config.deployBlock}`;
}

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

/**
 * The `kinds` GET /v2/feed/activity is asked for (F4 D4). Explicit rather than omitted, because the
 * union above has no catch-all: one kind the notifier cannot parse fails the whole page, so the
 * indexer must stay free to ship a new feed kind before the notifier knows it. The price of that is
 * this list — a kind added to the union and forgotten here is never read, which is exactly how the
 * v7 `stale_cancel` withdrawal went missing. engine.test.ts pins the list against the union and
 * against the route's 64-character bound on the parameter (indexer api/v2/machine.ts).
 */
export const ACTIVITY_KINDS = ['fill', 'settlement', 'redemption', 'roll', 'stale_cancel'] as const satisfies readonly ActivityItem['kind'][];
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

/**
 * /v2/config reported an interface this build was not written for.
 *
 * An `IndexerError` subclass so the engine's `codeOf` and its tick-failure log report it with a
 * route and a code like every other indexer failure, rather than as a bare `Error`.
 */
export class InterfaceVersionError extends IndexerError {
  constructor(
    readonly observed: number,
    readonly implemented: number = IMPLEMENTED_INTERFACE_VERSION,
  ) {
    super('/v2/config', 'interface-version-unsupported');
    this.name = 'InterfaceVersionError';
    this.message = `indexer /v2/config: interface version ${observed}, this build implements ${implemented}`;
  }
}

/**
 * Fail closed on an interface this build does not implement.
 *
 * BEFORE THIS EXISTED the notifier read `interfaceVersion` and used it for identity only (`:176`),
 * so a v8 binary pointed at a v7 indexer of the SAME deployment anchor decoded v7 payloads with v8
 * expectations and sent whatever survived the zod parse. The schemas here are not `.strict()` by
 * deliberate design (see the header), which is exactly why a wrong-version payload does not
 * announce itself: a field that moved or changed meaning parses, and a field that vanished fails
 * only if it happened to be required. Degrading quietly is the failure mode; refusing the tick is
 * the fix.
 *
 * Throwing is what makes it fail closed. `RulesEngine.runOnce` persists nothing when it throws and
 * enqueues nothing, so no notice is ever derived from a payload this build cannot claim to
 * understand; the run loop counts the failure, backs off and keeps reporting `failing` in health.
 * The notifier's API and delivery worker keep running — an operator can still read the failure and
 * the already-enqueued mail still goes out.
 */
export function assertInterfaceVersion(config: ApiConfig): void {
  if (config.interfaceVersion !== IMPLEMENTED_INTERFACE_VERSION) {
    throw new InterfaceVersionError(config.interfaceVersion);
  }
}

export interface IndexerClient {
  markets(): Promise<ApiMarket[]>;
  activity(query: { since: number; cursor?: string | null; limit: number }): Promise<ActivityPage>;
  positions(address: string): Promise<ApiPositions>;
  /** Inclusive; at most CALENDAR_MAX_DAYS days (the client refuses a wider range before any request). */
  calendar(fromDay: number, toDay: number): Promise<ApiCalendar>;
  series(longId: string): Promise<ApiSeriesDetail>;
  config(): Promise<ApiConfig>;
  adminOperations(): Promise<ApiAdminOperation[]>;
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
      const params = new URLSearchParams({ since: String(since), kinds: ACTIVITY_KINDS.join(','), limit: String(limit) });
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
    config: () => get('config', '/v2/config', configSchema),
    adminOperations: async () => {
      // One query per status, each followed to exhaustion through nextCursor - which the page schema
      // has always declared (:140) and which the old single call discarded, so a second page of
      // simultaneously pending operations was invisible.
      const items: ApiAdminOperation[] = [];
      for (const status of ADMIN_OPERATION_STATUSES) {
        let cursor: string | undefined;
        let pages = 0;
        for (;;) {
          const query = new URLSearchParams({ status, limit: String(ADMIN_OPERATIONS_PAGE) });
          if (cursor !== undefined) query.set('cursor', cursor);
          const page = await get('admin_operations', `/v2/admin/operations?${query.toString()}`, adminOperationsPageSchema);
          items.push(...page.items);
          pages += 1;
          cursor = page.nextCursor ?? undefined;
          if (cursor === undefined) break;
          if (pages >= ADMIN_OPERATIONS_MAX_PAGES) {
            throw new Error(`admin operations: ${status} still had a cursor after ${pages} pages of ${ADMIN_OPERATIONS_PAGE}; refusing to report a truncated list`);
          }
        }
      }
      return items;
    },
  };
}
