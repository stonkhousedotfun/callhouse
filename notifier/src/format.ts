/**
 * Number and time formatting for messages, matching the dapp so a figure in an alert reads exactly
 * as it does on the page it links to.
 *
 *   formatAmount / fmtUsdg / fmtAsset   web/lib/format.ts: thousands separators, fixed decimals,
 *                                       digits past the shown ones dropped (never rounded up).
 *   fmtUsdgUp                           web/lib/v2/payoff.ts `formatTwo(raw, true)`: a COST or a
 *                                       MAX LOSS rounds UP to the cent. 0.0825 USDG shows as
 *                                       0.09, never as an understated 0.08.
 *   fmtEastern                          web/lib/format.ts: "Fri 18 Sep, 4:00pm EDT". Expiries are
 *                                       16:00 New York (ADR-07), so the New York clock is the one
 *                                       that reads right; the zone name is always shown.
 *
 * Copied rather than imported: web/ is a Next app with its own module graph, and this package
 * must build alone in its Docker image. If the dapp's rules change, these change.
 */
import { formatUnits } from 'viem';

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Fixed-decimal formatting with thousands separators and no scientific notation. */
export function formatAmount(value: bigint, decimals: number, displayDecimals: number): string {
  const negative = value < 0n;
  const raw = formatUnits(negative ? -value : value, decimals);
  const [whole = '0', frac = ''] = raw.split('.');
  let out = group(whole);
  if (displayDecimals > 0) {
    const padded = (frac + '0'.repeat(displayDecimals)).slice(0, displayDecimals);
    out = `${out}.${padded}`;
  }
  return negative ? `-${out}` : out;
}

export const USDG_DECIMALS = 6;
const USDG_CENT = 10_000n;

/** USDG, two decimals, dropped past the cent. For prices, spot, strikes and payouts. */
export function fmtUsdg(raw: bigint, displayDecimals = 2): string {
  return formatAmount(raw, USDG_DECIMALS, displayDecimals);
}

/** USDG rounded UP to the cent. For costs and max losses. */
export function fmtUsdgUp(raw: bigint): string {
  if (raw < 0n) throw new RangeError('a cost is never negative');
  const cents = (raw + USDG_CENT - 1n) / USDG_CENT;
  return `${group((cents / 100n).toString())}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** Stock Tokens (18 decimals): four shown, as on the dapp. */
export function fmtAsset(raw: bigint, displayDecimals = 4): string {
  return formatAmount(raw, 18, displayDecimals);
}

/** Units to shares: 1 unit = 0.01 share (ADR-04), so 40 units → "0.40". */
export function fmtShares(units: bigint): string {
  return formatAmount(units, 2, 2);
}

/** `payout / cost` rounded down to two decimals, as the dapp's multipleAt; null without a cost. */
export function fmtMultiple(payout: bigint, cost: bigint): string | null {
  if (cost <= 0n) return null;
  return formatAmount((payout * 100n) / cost, 2, 2);
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/* ------------------------------------------------------------------ time */

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function hour12(hour: number, minute: number): string {
  const h = hour % 12 || 12;
  return `${h}:${pad2(minute)}${hour < 12 ? 'am' : 'pm'}`;
}

/** "Fri 18 Sep, 4:00pm EDT": the instant on the New York clock, zone name included. */
export function fmtEastern(unixSeconds: number): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  });
  const got: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of fmt.formatToParts(new Date(unixSeconds * 1000))) {
    if (part.type !== 'literal') got[part.type] = part.value;
  }
  const hour = Number(got.hour === '24' ? '0' : (got.hour ?? '0'));
  return `${got.weekday ?? ''} ${got.day ?? ''} ${got.month ?? ''}, ${hour12(hour, Number(got.minute ?? '0'))} ${got.timeZoneName ?? 'ET'}`;
}
