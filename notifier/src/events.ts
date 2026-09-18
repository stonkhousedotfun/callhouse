/**
 * The event kinds and the payload each one carries into enqueue().
 *
 * These schemas are the contract with the rules engine (N2-02): it builds a payload from indexer
 * objects and enqueue() validates it here, synchronously, so a malformed payload is a thrown error
 * in the rules engine's tests rather than a dead letter at 3 a.m. Payloads are stored with the
 * delivery and rendered at send time (templates.ts), so a template fix applies to retries.
 *
 * SHAPES FOLLOW THE INDEXER API (§4) so N2-02 can pass its objects straight through: `Money` is
 * `{ raw, decimals, formatted? }` (formatted is ignored: templates format `raw` themselves), and
 * `series` accepts a full `SeriesRef` (extra keys are stripped before storage). Units are decimal
 * strings (1 unit = 0.01 share, ADR-04). Prices and strikes are USDG base units per whole share.
 *
 * WHO IS A "LONG" MESSAGE FOR: a long position is a payoff the holder paid for, so every payload
 * about one carries `cost` (FIFO cost including taker fees: /v2/accounts/:address/positions
 * `avgCost × units / 100`) and the template states it with the max loss, which for a long is the
 * cost (copy rules). The schemas refuse a long payload without it.
 */
import { z } from 'zod';

export const EVENT_KINDS = [
  'strike_cross',
  'price_alert',
  'expiry_24h',
  'expiry_1h',
  'settlement_receipt',
  'fill_receipt',
  'writer_itm_warning',
  'auto_roll',
  'payout_failed_to_ledger',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export function isEventKind(value: unknown): value is EventKind {
  return typeof value === 'string' && (EVENT_KINDS as readonly string[]).includes(value);
}

const rawAmount = z.string().regex(/^(0|[1-9]\d{0,77})$/, 'a canonical non-negative integer string');

export const moneySchema = z.object({
  raw: rawAmount,
  decimals: z.number().int().min(0).max(36),
  formatted: z.string().optional(),
});
export type Money = z.infer<typeof moneySchema>;

/** USDG, 6 decimals: premiums, costs, spot, strikes, settlement prices. */
export const usdgSchema = moneySchema.refine((m) => m.decimals === 6, 'must be USDG Money (decimals 6)');

export const unitsSchema = z.string().regex(/^[1-9]\d{0,30}$/, 'units: a positive integer string (1 unit = 0.01 share)');

export const tickerSchema = z.string().regex(/^[A-Z0-9.]{1,8}$/, 'an upper-case registry ticker, e.g. NVDA');

const txSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'a transaction hash');

const walletSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'a 20-byte hex address');

/** The part of §4 `SeriesRef` a message needs. A full SeriesRef validates; the rest is stripped. */
export const seriesSchema = z.object({
  longId: z.string().regex(/^\d{1,78}$/, 'longId: a decimal string'),
  ticker: tickerSchema,
  isPut: z.boolean(),
  strike: usdgSchema,
  expiry: z.number().int().positive(),
});
export type SeriesLite = z.infer<typeof seriesSchema>;

const position = z.enum(['long', 'short']);
const direction = z.enum(['above', 'below']);

const longNeedsCost = <T extends { position: 'long' | 'short'; cost?: unknown }>(p: T) =>
  p.position === 'short' || p.cost !== undefined;
const COST_MESSAGE = { message: 'cost is required for a long position (every payoff message states cost and max loss)', path: ['cost'] };

export const payloadSchemas = {
  /** A fill the subscriber was part of, from their side. */
  fill_receipt: z
    .object({
      series: seriesSchema,
      side: z.enum(['buy', 'sell']),
      units: unitsSchema,
      /** Per whole share. */
      price: usdgSchema,
      /** buy: everything paid, fees included (this is the cost). sell: received, after fees. */
      total: usdgSchema,
      /** The fee inside `total`: taker fee as a taker, seller fee as a selling maker. */
      fee: usdgSchema,
      /** true when the fill minted (a writer sold new options), false for a resale. */
      primary: z.boolean(),
      tx: txSchema.optional(),
      /**
       * N2-02, interface v4 (`OrderFilled.recipient`: the longs on an ask hit, the taker's USDG
       * on a bid hit). Absent = taker or maker, as before. `recipient`: the subscriber is that
       * wallet and another wallet traded (`payer` on a buy, `seller` on a sale).
       */
      role: z.enum(['taker', 'maker', 'recipient']).optional(),
      /** A taker's fill whose longs (buy) or proceeds (sell) went to another wallet: that wallet. */
      recipient: walletSchema.optional(),
      /** role `recipient`, buy: the wallet that bought the longs for it and paid. */
      payer: walletSchema.optional(),
      /** role `recipient`, sell: the wallet that sold and had the proceeds paid to it. */
      seller: walletSchema.optional(),
    })
    .refine((p) => p.role !== 'recipient' || p.side !== 'buy' || p.payer !== undefined, {
      message: 'a recipient buy receipt names the payer',
      path: ['payer'],
    })
    .refine((p) => p.role !== 'recipient' || p.side !== 'sell' || p.seller !== undefined, {
      message: 'a recipient sale receipt names the seller',
      path: ['seller'],
    })
    .refine((p) => p.recipient === undefined || p.role !== 'recipient', {
      message: 'a recipient receipt does not name a recipient',
      path: ['recipient'],
    })
    .refine((p) => (p.payer === undefined || p.side === 'buy') && (p.seller === undefined || p.side === 'sell'), {
      message: 'payer goes with a buy, seller with a sale',
    }),

  /** Spot crossed a held series' strike (N2-02 applies the hysteresis). */
  strike_cross: z
    .object({
      series: seriesSchema,
      position,
      direction,
      spot: usdgSchema,
      units: unitsSchema,
      cost: usdgSchema.optional(),
    })
    .refine(longNeedsCost, COST_MESSAGE),

  /** A user-defined price alert fired. `threshold.raw` equals the alert's `above` or `below`. */
  price_alert: z.object({
    ticker: tickerSchema,
    direction,
    threshold: usdgSchema,
    spot: usdgSchema,
  }),

  expiry_24h: z
    .object({ series: seriesSchema, position, units: unitsSchema, spot: usdgSchema.optional(), cost: usdgSchema.optional() })
    .refine(longNeedsCost, COST_MESSAGE),

  expiry_1h: z
    .object({ series: seriesSchema, position, units: unitsSchema, spot: usdgSchema.optional(), cost: usdgSchema.optional() })
    .refine(longNeedsCost, COST_MESSAGE),

  /**
   * The holder's side of a settled series. `payout` is what `Redeemed` delivered (null when
   * nothing was: an OTM long, or a short whose whole collateral went to holders). `payoutValue`
   * is the in-kind amount valued at the settlement price (§4 wins rule), for a stock payout.
   */
  settlement_receipt: z
    .object({
      series: seriesSchema,
      position,
      units: unitsSchema,
      settlementPrice: usdgSchema,
      payout: z.object({ asset: z.enum(['usdg', 'stock']), amount: moneySchema }).nullable(),
      payoutValue: usdgSchema.optional(),
      cost: usdgSchema.optional(),
      toLedger: z.boolean(),
      tx: txSchema.optional(),
    })
    .refine(longNeedsCost, COST_MESSAGE)
    .refine((p) => p.payout === null || (p.payout.asset === 'usdg') === (p.payout.amount.decimals === 6), {
      message: 'payout.amount decimals must match its asset (usdg: 6)',
      path: ['payout'],
    }),

  /** A short position is in the money inside the last trading day. */
  writer_itm_warning: z.object({
    series: seriesSchema,
    units: unitsSchema,
    spot: usdgSchema,
    /** In the collateral asset: Stock Tokens (18 dp) for calls, USDG for puts. */
    collateralLocked: moneySchema,
  }),

  /**
   * AutoRoller: a roll happened (`rolled`), none has in the 24 h since one fell due (`skipped`), or
   * INTERFACE_VERSION 7 withdrew the live ask because the spot reached its strike (`withdrawn`).
   * `withdrawn` is deliberate, not a failure: it stops the ask filling below intrinsic value.
   */
  auto_roll: z
    .object({
      ticker: tickerSchema,
      status: z.enum(['rolled', 'skipped', 'withdrawn']),
      /** rolled, withdrawn: the series (withdrawn carries the strike the spot reached). */
      series: seriesSchema.optional(),
      /** rolled: the new ask, per whole share. */
      price: usdgSchema.optional(),
      units: unitsSchema.optional(),
      /** skipped: unix seconds of the last roll, when there was one. */
      lastRolledAt: z.number().int().positive().optional(),
      /** skipped: when the roll fell due (09:30 New York on the first session day after expiry). */
      dueAt: z.number().int().positive().optional(),
      /** withdrawn: the spot that reached the strike, and when the oracle last updated it. */
      spot: usdgSchema.optional(),
      spotUpdatedAt: z.number().int().positive().optional(),
      /** withdrawn: the cancelled series' expiry; the strategy rolls again after it. */
      nextRollAfter: z.number().int().positive().optional(),
    })
    .refine((p) => p.status !== 'rolled' || (p.series !== undefined && p.price !== undefined && p.units !== undefined), {
      message: 'a rolled event needs series, price and units',
    })
    .refine((p) => p.status !== 'withdrawn' || (p.series !== undefined && p.spot !== undefined && p.nextRollAfter !== undefined), {
      message: 'a withdrawn event needs series, spot and nextRollAfter',
    }),

  /** `Redeemed.toLedger` for a holder who did not ask for ledger payouts. */
  payout_failed_to_ledger: z.object({
    series: seriesSchema,
    asset: z.enum(['usdg', 'stock']),
    amount: moneySchema,
    tx: txSchema.optional(),
  }),
} satisfies Record<EventKind, z.ZodTypeAny>;

export type EventPayloads = { [K in EventKind]: z.infer<(typeof payloadSchemas)[K]> };
export type EventPayload = EventPayloads[EventKind];

export type ParsedEvent = { [K in EventKind]: { kind: K; payload: EventPayloads[K] } }[EventKind];

export type PayloadParseResult = { ok: true; event: ParsedEvent } | { ok: false; issues: string[] };

/** Validate `payload` for `kind`. Never throws. */
export function parsePayload(kind: EventKind, payload: unknown): PayloadParseResult {
  const result = payloadSchemas[kind].safeParse(payload);
  if (!result.success) {
    return { ok: false, issues: result.error.issues.map((i) => `${i.path.join('.') || '(payload)'}: ${i.message}`) };
  }
  return { ok: true, event: { kind, payload: result.data } as ParsedEvent };
}
