/**
 * Subscription preferences and which event kinds they let through.
 *
 *   { strikeCross, expiry24h, expiry1h, settlement, fills, writerItmWarning, autoRoll: boolean,
 *     priceAlerts: [{ ticker, above?: string, below?: string }] }
 *
 * DECISIONS WHERE §6 IS SILENT:
 *   - Every key is optional on input. A missing toggle defaults to ON (someone subscribing wants
 *     alerts) and priceAlerts to []. Unknown keys are refused (400), so a misspelt toggle is an
 *     error in the dapp, not a switch that silently does nothing.
 *   - `above` / `below` are USDG base units per whole share as an integer string, the unit of
 *     every price in the protocol and of Money.raw (221.50 USDG = "221500000"). A decimal like
 *     "221.5" is refused with that explanation rather than guessed at.
 *   - At most 20 price alerts per subscription.
 *   - `payout_failed_to_ledger` follows `settlement`: it is news about a payout.
 *   - `price_alert` is delivered only to a subscription holding an alert with the same ticker,
 *     direction and threshold, because prefs are per subscription (per channel) and a wallet's
 *     Telegram and browser may carry different alerts.
 */
import { z } from 'zod';
import type { EventKind, ParsedEvent } from './events.js';

const threshold = z
  .string()
  .regex(/^[1-9]\d{0,17}$/, 'USDG base units per whole share as an integer string (221.50 USDG = "221500000")');

export const priceAlertSchema = z
  .object({
    ticker: z.string().regex(/^[A-Z0-9.]{1,8}$/, 'an upper-case registry ticker, e.g. NVDA'),
    above: threshold.optional(),
    below: threshold.optional(),
  })
  .strict()
  .refine((a) => a.above !== undefined || a.below !== undefined, 'set above, below, or both');

export const prefsSchema = z
  .object({
    strikeCross: z.boolean().default(true),
    expiry24h: z.boolean().default(true),
    expiry1h: z.boolean().default(true),
    settlement: z.boolean().default(true),
    fills: z.boolean().default(true),
    writerItmWarning: z.boolean().default(true),
    autoRoll: z.boolean().default(true),
    priceAlerts: z.array(priceAlertSchema).max(20).default([]),
  })
  .strict();

export type Prefs = z.infer<typeof prefsSchema>;

export const DEFAULT_PREFS: Prefs = prefsSchema.parse({});

type Toggle = Exclude<keyof Prefs, 'priceAlerts'>;

export const KIND_TOGGLE: Record<Exclude<EventKind, 'price_alert'>, Toggle> = {
  strike_cross: 'strikeCross',
  expiry_24h: 'expiry24h',
  expiry_1h: 'expiry1h',
  settlement_receipt: 'settlement',
  payout_failed_to_ledger: 'settlement',
  fill_receipt: 'fills',
  writer_itm_warning: 'writerItmWarning',
  auto_roll: 'autoRoll',
};

/** Stored prefs back to Prefs. A row that no longer parses lets nothing through. */
export function readPrefs(stored: unknown): Prefs | null {
  const parsed = prefsSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

export function prefsAllow(prefs: Prefs, event: ParsedEvent): boolean {
  if (event.kind === 'price_alert') {
    const { ticker, direction, threshold: level } = event.payload;
    return prefs.priceAlerts.some(
      (alert) => alert.ticker === ticker && (direction === 'above' ? alert.above : alert.below) === level.raw,
    );
  }
  return prefs[KIND_TOGGLE[event.kind]];
}
