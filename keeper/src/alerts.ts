/**
 * Alerting.
 *
 * A generic JSON webhook (ALERT_WEBHOOK). No Slack/Discord/Telegram-specific payload shape,
 * because the destination is an operational choice and every one of those accepts a JSON POST
 * through a relay. If no webhook is configured the alert is still logged at its severity and
 * still written to SQLite, so nothing is silently lost.
 *
 * WHAT EARNS AN ALERT (plan.md 5.5, task K-13). Each of these is a week of premium or a
 * depositor's money:
 *   tx_revert             a simulation or a receipt came back reverted
 *   api_reject            Overcall refused the listing (4xx that is not a retry)
 *   listing_invisible     accepted but not in the book 15 minutes later
 *   oracle_paused         the Stock Token halted its own oracle; the vault will refuse to write
 *   valorem_fees_enabled  Valorem turned its 15 bps notional fee on; writes stop until accepted
 *   low_gas               keeper ETH under KEEPER_MIN_GAS_WEI (0.01 by default)
 *   rpc_lag               head block trails the wall clock by over KEEPER_RPC_LAG_ALERT_MS
 *   phase_stuck           still not Idle an hour after expiry — the guardian path is now open
 *   no_rung               no strike inside the policy band: an honest skipped week, info only
 *   keeper_error          an unhandled error inside the loop
 */
import { config } from './config.js';
import { log } from './logger.js';
import { bigintReplacer, store } from './state.js';

export type AlertKind =
  | 'tx_revert'
  | 'api_reject'
  | 'listing_invisible'
  | 'oracle_paused'
  | 'valorem_fees_enabled'
  | 'low_gas'
  | 'rpc_lag'
  | 'phase_stuck'
  | 'no_rung'
  | 'keeper_error'
  | 'boot'
  | 'roll_open'
  | 'roll_close';

export type AlertSeverity = 'info' | 'warn' | 'error';

const DEFAULT_SEVERITY: Record<AlertKind, AlertSeverity> = {
  tx_revert: 'error',
  api_reject: 'error',
  listing_invisible: 'error',
  oracle_paused: 'warn',
  valorem_fees_enabled: 'warn',
  low_gas: 'warn',
  rpc_lag: 'warn',
  phase_stuck: 'error',
  no_rung: 'info',
  keeper_error: 'error',
  boot: 'info',
  roll_open: 'info',
  roll_close: 'info',
};

/** Last delivery per dedupe key, so a condition that is true every 60s alerts once an hour.
 *  A FAILED delivery backdates the entry instead: retried in five minutes, not every tick and
 *  not after the full cooldown. */
const lastSent = new Map<string, number>();

/** How long a failed webhook delivery suppresses repeats: long enough that a flapping webhook
 *  is not paged every tick, short enough that one failed POST is not the only attempt for an
 *  hour. */
export const FAILED_DELIVERY_RETRY_MS = 5 * 60_000;

/** The cooldown stamp after a delivery attempt. A success (or no webhook) starts the full
 *  cooldown; a failure leaves only FAILED_DELIVERY_RETRY_MS of it. Exported for tests. */
export function failedDeliveryStamp(now: number): number {
  return now - config.KEEPER_ALERT_COOLDOWN_MS + FAILED_DELIVERY_RETRY_MS;
}

export interface AlertOptions {
  /** Extra key so two instances of the same kind (two order hashes, say) do not suppress each
   *  other. Defaults to the kind alone. */
  dedupeKey?: string;
  /** Send even if the cooldown has not elapsed. Use for state changes, not for conditions. */
  force?: boolean;
  severity?: AlertSeverity;
}

/**
 * Raise an alert. Never throws: an alerting failure must not take down the roll.
 * Returns true if the webhook accepted it (or if there is no webhook and it was logged).
 */
export async function alert(
  kind: AlertKind,
  message: string,
  data?: Record<string, unknown>,
  options: AlertOptions = {},
): Promise<boolean> {
  const severity = options.severity ?? DEFAULT_SEVERITY[kind];
  const dedupeKey = `${kind}:${options.dedupeKey ?? ''}`;
  const now = Date.now();

  if (!options.force) {
    const previous = lastSent.get(dedupeKey);
    if (previous !== undefined && now - previous < config.KEEPER_ALERT_COOLDOWN_MS) {
      log.alerts.debug({ kind, dedupeKey, message }, 'alert suppressed by cooldown');
      return false;
    }
  }

  const payload = {
    source: 'callhouse-keeper',
    kind,
    severity,
    message,
    vault: config.VAULT,
    chainId: config.CHAIN_ID,
    at: new Date(now).toISOString(),
    data: data ?? {},
  };

  const logLine = { kind, severity, ...data };
  if (severity === 'error') log.alerts.error(logLine, message);
  else if (severity === 'warn') log.alerts.warn(logLine, message);
  else log.alerts.info(logLine, message);

  if (!config.ALERT_WEBHOOK) {
    lastSent.set(dedupeKey, now);
    store.recordAlert(kind, severity, message, data, false);
    return true;
  }

  const id = store.recordAlert(kind, severity, message, data, false);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.ALERT_WEBHOOK_TOKEN) headers.authorization = `Bearer ${config.ALERT_WEBHOOK_TOKEN}`;
    const response = await fetch(config.ALERT_WEBHOOK, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload, bigintReplacer),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      log.alerts.error({ status: response.status, kind }, 'alert webhook rejected the POST');
      lastSent.set(dedupeKey, failedDeliveryStamp(now));
      return false;
    }
    store.markAlertDelivered(id);
    lastSent.set(dedupeKey, now);
    return true;
  } catch (error) {
    log.alerts.error({ err: String(error), kind }, 'alert webhook unreachable');
    lastSent.set(dedupeKey, failedDeliveryStamp(now));
    return false;
  }
}

/** Clear a condition's cooldown so the next occurrence alerts immediately. Call this when the
 *  condition resolves — otherwise a problem that recurs 20 minutes later stays silent. */
export function clearAlert(kind: AlertKind, dedupeKey?: string): void {
  lastSent.delete(`${kind}:${dedupeKey ?? ''}`);
}
