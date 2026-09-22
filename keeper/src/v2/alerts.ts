/**
 * Alerts from a v2 mode to the relay: v1's alerts.ts without its import of the v1 config.
 *
 * Same contract with relay/src/payload.ts: `{ source, kind, severity, message, chainId, at, data }`,
 * kind a lowercase snake_case identifier, a Bearer token when ALERT_WEBHOOK_TOKEN is set. Same
 * behaviour: never throws (an alerting failure must not take down a tick), logged at its severity
 * and stored whether or not a webhook is configured, one delivery per (kind, dedupeKey) per
 * cooldown, and a FAILED delivery retried after five minutes rather than every tick or never: by the
 * caller raising it again, or, for an event nobody raises again (one transaction's revert, a kill),
 * by redeliver() from the stored row, which the mode loop calls at the start of every tick.
 *
 * `source` is `callhouse-<mode>`, so the cranker, the MM bot and the pricer are told apart in one
 * channel. No `vault` field: the relay types it as a string and v2 has none.
 *
 * Kinds are `v2_*`. The scaffold raises the ones below; each mode adds its own (K2-03:
 * v2_sources_disagree, v2_settlement_held, v2_snapshot_missed, v2_settle_stuck, v2_redeem_backlog,
 * v2_pin_refused, v2_stale_cancel_failed; K2-04: v2_mm_killed, v2_mm_resumed, v2_mm_loss_stop, v2_mm_delta,
 * v2_mm_not_quoter, v2_mm_pricing, v2_mm_tx_rejected, v2_mm_funds, v2_mm_outflow, v2_mm_outflow_foreign;
 * K2-05: v2_pricer_no_role, v2_pricer_fair_unavailable,
 * v2_pricer_reprice_failed, v2_pricer_clamped) and a severity for it in ALERT_SEVERITY, else it goes out as `warn`.
 *   v2_boot       the mode started (info)
 *   v2_error      a tick threw (error)
 *   v2_tx_revert  a transaction reverted on chain, was not confirmed, or could not be broadcast (error)
 *   v2_low_gas    the signer's balance is under KEEPER_MIN_GAS_WEI (warn)
 *   v2_rpc_lag    the head trails the wall clock by over KEEPER_RPC_LAG_ALERT_MS, or no RPC answers (warn)
 */
import type { Logger } from './logger.js';
import { bigintReplacer, type V2Store } from './store.js';

export type AlertSeverity = 'info' | 'warn' | 'error';
export type V2AlertKind = `v2_${string}`;

export const ALERT_SEVERITY: Record<string, AlertSeverity> = {
  v2_boot: 'info',
  v2_error: 'error',
  v2_tx_revert: 'error',
  v2_low_gas: 'warn',
  v2_rpc_lag: 'warn',
  /* ---- cranker (K2-03, cranker/steps.ts) ---- */
  /** Two ok sources disagree beyond maxDeviationBps: the expiry waits out the veto window on the first ok source. */
  v2_sources_disagree: 'warn',
  /** The guardian vetoed an expiry: nothing settles until unveto or adminResolve. */
  v2_settlement_held: 'error',
  /** An expiry with open interest passed [expiry, expiry + 600] without a snapshot: the pool source cannot vote. */
  v2_snapshot_missed: 'warn',
  /** No source prices an expiry for over an hour, a candidate is long past finalizableAt, or settle does not advance. */
  v2_settle_stuck: 'error',
  /** Redeemable holders of a settled series remain long after settlement. */
  v2_redeem_backlog: 'warn',
  /**
   * createSeries (a ladder rung, or an AutoRoller roll) is refused by the settlement pin (INTERFACE_VERSION 6,
   * cranker/pin.ts): PinMismatch, SourceNotPinned(source, reason), or the oracle's NotAuthorized / NoSource. No
   * series of that expiry can be created until the admin fixes the oracle or a source.
   */
  v2_pin_refused: 'error',
  /* ---- MM bot (K2-04, mm/quoter.ts) ---- */
  /** POST /kill: every vault order cancelled; nothing quotes until POST /resume. */
  v2_mm_killed: 'error',
  /** POST /resume: the kill switch released. */
  v2_mm_resumed: 'info',
  /** The day's realised loss reached MM_DAILY_LOSS_LIMIT_USDG6: every quote pulled until the next UTC day. */
  v2_mm_loss_stop: 'error',
  /** A market's net inventory delta is above MM_DELTA_ALERT_SHARES: hedge by hand. */
  v2_mm_delta: 'warn',
  /** INTERFACE_VERSION 8: the AccessManager refuses the MM signer `place` on the vault - not a QUOTER member,
   *  or a member whose calls must be scheduled. Either way it can neither quote nor cancel. */
  v2_mm_not_quoter: 'error',
  /** Every selected series is halted for its fair value (unreachable, refused, or stale): nothing is quoted. */
  v2_mm_pricing: 'warn',
  /** A vault call's simulation reverted (a guard, a stale spot, a paused book): not sent. */
  v2_mm_tx_rejected: 'warn',
  /** Quoted series lost a side to funds: no USDG for bids or no ledger collateral for write asks. */
  v2_mm_funds: 'warn',
  /**
   * The MakerVault's daily outflow cap (INTERFACE_VERSION 7, c21) is binding: the bot trimmed its bids inside the
   * remaining allowance, or the vault refused a call with OutflowCapExceeded and no further bid grows this tick.
   * Once per UTC day.
   */
  v2_mm_outflow: 'warn',
  /**
   * The vault's outflow bucket is above what this bot's own booked calls account for: USDG left the vault through a
   * quoter call this bot did not send. A second key the manager admits as QUOTER, or the Admin Safe, which holds
   * QUOTER in its own right (script/v2/roles.v8.json). Forced, never suppressed.
   */
  v2_mm_outflow_foreign: 'error',
  /** A configured vault quotes on a different OrderBook than the registry: skipped, others still tick. */
  v2_mm_wrong_book: 'error',
  /** A House vault still holds risk at epochEnd: roll is due and the plan is not flat. */
  v2_mm_epoch_unflat: 'warn',
  /** A rest that would cross another protocol-owned maker was skipped. */
  v2_mm_protocol_cross: 'warn',
  /**
   * One vault could not be read or failed mid-tick and was skipped; the others still quoted. Error, not warn:
   * a vault nobody is quoting is a vault whose epoch wind-down cancels are not being sent.
   */
  v2_mm_vault_unreadable: 'error',
  /**
   * The seller fee read was out of range, so the grossed ask could not be computed and those asks were NOT
   * rested. Error: quoting below the vault's intended net is a money-losing default, and the previous
   * behaviour was to rest anyway and record the fact somewhere nothing read.
   */
  v2_mm_fee_unreadable: 'error',
  /**
   * MM_HOUSE_FACTORY is set but no House vault can be quoted: the factory cannot be enumerated
   * (no ABI until T-78) or a discovered vault's epoch could not be read. Error, not warn: the
   * operator configured House quoting and is not getting it, and the bot will not fake an epoch.
   */
  v2_mm_house_unavailable: 'error',
  /** The cranker's key does not hold BUYBACK on the FeeSplitter: the flywheel claims and distributes, and no
   *  buyback can be sent. Raised only from the buyback probe, because `Managed` gives an unauthorised call the
   *  same V2Errors.NotAuthorized that `distribute` raises for an unset treasury. */
  v2_cranker_no_buyback_role: 'error',

  /* ---- pricer (K2-05, pricer/pricer.ts) ---- */
  /** INTERFACE_VERSION 8: the AccessManager refuses the pricer's key `reprice` on the AutoRoller - not a PRICER
   *  member, or a member whose calls must be scheduled. No smart-pricing ask can be repriced. */
  v2_pricer_no_role: 'error',
  /** A live smart-pricing ask has had no fair value (pricing service down or `fair: null`) for PRICER_FAIR_ALERT_S. */
  v2_pricer_fair_unavailable: 'warn',
  /** A due reprice did not go through: reverted on chain or not confirmed (error); a refused simulation is sent as warn. */
  v2_pricer_reprice_failed: 'error',
  /** Four consecutive evaluations landed on the minAsk/maxAsk clamp; streak resets on an unclamped tick. */
  v2_pricer_clamped: 'warn',
  /* ---- cranker, INTERFACE_VERSION 7 (c16, cranker/steps.ts stepStale) ---- */
  /**
   * An AutoRoller ask the spot has overtaken (at or past its strike) could not be withdrawn: `cancelStale`'s
   * simulation is refused, so the writer's ask keeps resting below intrinsic value until it fills or expires.
   * Raised as `warn` when the cause is the writer revoking the roller's delegate (nobody but the writer can fix it),
   * `error` otherwise (v7 design §7.4, the monitor's `v2_mon_roller_ask_overtaken` rule).
   */
  v2_stale_cancel_failed: 'error',
};

export const FAILED_DELIVERY_RETRY_MS = 5 * 60_000;
/** A failed page older than this is not redelivered: by then it describes a state nobody can act on as paged. */
export const REDELIVERY_MAX_AGE_MS = 6 * 3_600_000;
/** Most stored pages one redeliver() sends: each is a POST inside the tick. */
export const REDELIVERY_MAX_PER_CALL = 10;

/** The relay's rule (relay/src/payload.ts): anything else is a 400 and the alert never arrives. */
const KIND_RE = /^[a-z][a-z0-9_]{0,63}$/;

export interface AlertOptions {
  /** Separates two instances of one kind (two series) so they do not suppress each other. */
  dedupeKey?: string;
  /** Ignore the cooldown: for state changes, not conditions. */
  force?: boolean;
  severity?: AlertSeverity;
}

export interface AlerterOptions {
  mode: string;
  chainId: number;
  webhook: string | null;
  token: string | null;
  cooldownMs: number;
  log: Logger;
  store: V2Store | null;
  /** SEAM: tests pass their own. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Told the outcome of every webhook POST (the mode's /health: checks.alerting). */
  onDelivery?: (ok: boolean, error: string | null) => void;
}

export class Alerter {
  private readonly lastSent = new Map<string, number>();
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: AlerterOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Returns true when delivered, or logged and stored with no webhook configured. Never throws. */
  async alert(kind: V2AlertKind, message: string, data: Record<string, unknown> = {}, options: AlertOptions = {}): Promise<boolean> {
    const { log, webhook, cooldownMs, store } = this.options;
    if (!KIND_RE.test(kind)) {
      log.error({ kind, message }, 'alert kind is not a relay identifier; not sent');
      return false;
    }
    const severity = options.severity ?? ALERT_SEVERITY[kind] ?? 'warn';
    const dedupeKey = `${kind}:${options.dedupeKey ?? ''}`;
    const now = this.now();

    if (!options.force) {
      const previous = this.lastSent.get(dedupeKey);
      if (previous !== undefined && now - previous < cooldownMs) {
        log.debug({ kind, dedupeKey }, 'alert suppressed by cooldown');
        return false;
      }
    }

    const line = { alert: kind, severity, ...data };
    if (severity === 'error') log.error(line, message);
    else if (severity === 'warn') log.warn(line, message);
    else log.info(line, message);

    let id: number | null = null;
    const rowKey = options.dedupeKey ?? null;
    try {
      id = store === null ? null : store.recordAlert(kind, severity, message, data, false, rowKey, now);
    } catch (error) {
      log.error({ err: String(error) }, 'could not store the alert');
    }
    if (webhook === null) {
      this.lastSent.set(dedupeKey, now);
      return true;
    }

    const delivered = await this.post({ kind, severity, message, at: now, data });
    this.noteDelivery(id, kind, rowKey, delivered, now);
    if (!delivered) {
      this.lastSent.set(dedupeKey, now - cooldownMs + FAILED_DELIVERY_RETRY_MS);
      return false;
    }
    this.lastSent.set(dedupeKey, now);
    return true;
  }

  /**
   * Send again the stored pages whose delivery failed and that nothing delivered since (store.undeliveredAlerts): at most
   * REDELIVERY_MAX_PER_CALL, each no sooner than FAILED_DELIVERY_RETRY_MS after its last attempt and no older than
   * REDELIVERY_MAX_AGE_MS. The payload is the original one, its `at` the original time, with `data.redeliveredFrom`.
   * Returns how many were delivered. Never throws.
   */
  async redeliver(): Promise<number> {
    const { webhook, store, log } = this.options;
    if (webhook === null || store === null) return 0;
    const now = this.now();
    let rows: ReturnType<V2Store['undeliveredAlerts']>;
    try {
      rows = store.undeliveredAlerts({ since: now - REDELIVERY_MAX_AGE_MS, triedBefore: now - FAILED_DELIVERY_RETRY_MS, limit: REDELIVERY_MAX_PER_CALL });
    } catch (error) {
      log.error({ err: String(error) }, 'could not read undelivered alerts');
      return 0;
    }
    let delivered = 0;
    for (const row of rows) {
      let data: Record<string, unknown> = {};
      try {
        data = row.data_json === null ? {} : (JSON.parse(row.data_json) as Record<string, unknown>);
      } catch {
        data = {};
      }
      const at = new Date(row.created_at).toISOString();
      const ok = await this.post({ kind: row.kind as V2AlertKind, severity: row.severity as AlertSeverity, message: row.message, at: row.created_at, data: { ...data, redeliveredFrom: at } });
      this.noteDelivery(row.id, row.kind, row.dedupe_key, ok, now);
      if (ok) {
        delivered += 1;
        this.lastSent.set(`${row.kind}:${row.dedupe_key ?? ''}`, now);
        log.info({ kind: row.kind, dedupeKey: row.dedupe_key, at }, 'redelivered an alert whose delivery had failed');
      }
    }
    return delivered;
  }

  private async post(alert: { kind: string; severity: AlertSeverity; message: string; at: number; data: Record<string, unknown> }): Promise<boolean> {
    const { log, webhook, token } = this.options;
    if (webhook === null) return true;
    const payload = { source: `callhouse-${this.options.mode}`, kind: alert.kind, severity: alert.severity, message: alert.message, chainId: this.options.chainId, at: new Date(alert.at).toISOString(), data: alert.data };
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (token !== null) headers.authorization = `Bearer ${token}`;
      const response = await this.fetchImpl(webhook, { method: 'POST', headers, body: JSON.stringify(payload, bigintReplacer), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        log.error({ status: response.status, kind: alert.kind }, 'alert webhook rejected the POST');
        this.options.onDelivery?.(false, `alert webhook rejected the POST (HTTP ${response.status})`);
        return false;
      }
      this.options.onDelivery?.(true, null);
      return true;
    } catch (error) {
      log.error({ err: String(error), kind: alert.kind }, 'alert webhook unreachable');
      this.options.onDelivery?.(false, 'alert webhook unreachable');
      return false;
    }
  }

  private noteDelivery(id: number | null, kind: string, dedupeKey: string | null, delivered: boolean, now: number): void {
    const { store, log } = this.options;
    if (id === null || store === null) return;
    try {
      if (delivered) store.markAlertsDeliveredUpTo(id, kind, dedupeKey);
      else store.markAlertFailed(id, now);
    } catch (error) {
      log.error({ err: String(error) }, 'could not record the alert delivery');
    }
  }

  /** The condition resolved: its next occurrence alerts at once instead of waiting out the cooldown. */
  clear(kind: V2AlertKind, dedupeKey?: string): void {
    this.lastSent.delete(`${kind}:${dedupeKey ?? ''}`);
  }
}
