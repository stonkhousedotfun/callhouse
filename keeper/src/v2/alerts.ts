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
 * Kinds are `v2_*`. The scaffold raises the ones below; each mode adds its own (cranker:
 * v2_sources_disagree, v2_settlement_held, v2_snapshot_missed, v2_settle_stuck, v2_redeem_backlog,
 * v2_pin_refused, v2_stale_cancel_failed; mm: v2_mm_killed, v2_mm_resumed, v2_mm_loss_stop, v2_mm_delta,
 * v2_mm_not_quoter, v2_mm_pricing, v2_mm_tx_rejected, v2_mm_funds, v2_mm_outflow, v2_mm_outflow_foreign,
 * v2_mm_spot_age, v2_mm_open_grace, v2_mm_spot_breaker, v2_mm_event_halt, v2_earn_queue_stuck, v2_mm_budget_short,
 * v2_mm_slow_tick;
 * pricer: v2_pricer_no_role, v2_pricer_fair_unavailable,
 * v2_pricer_reprice_failed, v2_pricer_clamped; guardian: v2_guardian_candidate, v2_guardian_scale_fault,
 * v2_guardian_stale_round, v2_guardian_vetoed, v2_guardian_veto_failed) and a severity for it in ALERT_SEVERITY, else it goes out as `warn`.
 *   v2_boot       the mode started (info)
 *   v2_error      a tick threw (error)
 *   v2_tx_revert  a transaction reverted on chain, was not confirmed, or could not be broadcast (error)
 *   v2_low_gas    the signer's balance is under KEEPER_MIN_GAS_WEI (warn)
 *   v2_rpc_lag    the head trails the wall clock by over KEEPER_RPC_LAG_ALERT_MS, or no RPC answers (warn)
 */
import type { Logger } from './logger.js';
import { bigintReplacer, type V2Store } from './store.js';
import { redactUrls } from './tx.js';

export type AlertSeverity = 'info' | 'warn' | 'error';
export type V2AlertKind = `v2_${string}`;

export const ALERT_SEVERITY: Record<string, AlertSeverity> = {
  v2_boot: 'info',
  v2_error: 'error',
  v2_tx_revert: 'error',
  v2_low_gas: 'warn',
  v2_rpc_lag: 'warn',
  /* ---- cranker (cranker/steps.ts) ---- */
  /** Two ok sources disagree beyond maxDeviationBps: the expiry waits out the veto window on the first ok source. */
  v2_sources_disagree: 'warn',
  /** The guardian vetoed an expiry: nothing settles until unveto or adminResolve. */
  v2_settlement_held: 'error',
  /**
   * An expiry with open interest passed [expiry, expiry + 600] without the pool's snapshot: none was sent, or every
   * attempt inside the grace recorded nothing for it (steps.ts retries those, SNAPSHOT_RETRY_S apart). Since
   * a later change, a finalize or Clearinghouse.settle inside the grace records too, so it also means none of those did. The
   * pool source cannot vote: the expiry settles uncorroborated on its other source after the veto delay, or, if that
   * one does not price the window either, only through adminResolve.
   */
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
  /* ---- MM bot (mm/quoter.ts) ---- */
  /** POST /kill: every vault order cancelled; nothing quotes until POST /resume. */
  v2_mm_killed: 'error',
  /** POST /resume: the kill switch released. */
  v2_mm_resumed: 'info',
  /** The day's realised loss reached MM_DAILY_LOSS_LIMIT_USDG6: every quote pulled until the next UTC day. */
  v2_mm_loss_stop: 'error',
  /** A market's net inventory delta is above MM_DELTA_ALERT_SHARES: hedge by hand. */
  v2_mm_delta: 'warn',
  /**
   * The notional-weighted mean 30-minute markout of the last MM_MARKOUT_ALERT_FILLS
   * vault fills is below MM_MARKOUT_ALERT_BPS: the fills are systematically on the wrong side of where the option
   * went next (stale or cheap asks being picked off). mm/markouts.ts. Paging needs the relay deployed.
   */
  v2_mm_markout_low: 'warn',
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
   * The MakerVault's daily outflow cap (INTERFACE_VERSION 7) is binding: the bot trimmed its bids inside the
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
   * A market-safety halt pulled a market's quotes, resting asks included. Warn, not error: each is
   * the guard WORKING; the page is so an operator knows why a market is dark. One page per market per halt spell.
   *   v2_mm_spot_age      P7: the oracle print is older than MM_MAX_SPOT_AGE_S in session (corroborated or not).
   *   v2_mm_open_grace    P8: no in-session print today yet, or inside MM_OPEN_GRACE_S of the open.
   *   v2_mm_spot_breaker  P15: the spot moved more than MM_BREAKER_BPS inside MM_BREAKER_WINDOW_S; halted MM_BREAKER_HALT_S.
   *   v2_mm_event_halt    P9: the pricing service flagged the fair event- or model-uncertain (per series).
   */
  v2_mm_spot_age: 'warn',
  v2_mm_open_grace: 'warn',
  v2_mm_spot_breaker: 'warn',
  v2_mm_event_halt: 'warn',
  /**
   * One vault could not be read or failed mid-tick and was skipped; the others still quoted. Error, not warn:
   * a vault nobody is quoting is a vault whose epoch wind-down cancels are not being sent.
   */
  v2_mm_vault_unreadable: 'error',
  /**
   * A vault's routine sends were cut short by MM_MAX_TX_PER_TICK for mm/constants.ts BUDGET_SHORT_SENDS (3) in a
   * row, so series it prices sit without an ask; the page carries how many. Warn: nothing is mispriced, a series is dark.
   */
  v2_mm_budget_short: 'warn',
  v2_mm_slow_tick: 'warn',
  /**
   * A guard read (askFloorOf, bidCap, exposure) failed, so series were halted `guards-unreadable` and not
   * quoted. Warn on the first tick (one RPC leg can fail and the next tick re-reads it); the quoter raises it as ERROR,
   * under its own dedupe key, once it has held mm/quoter.ts GUARDS_UNREADABLE_ERROR_TICKS (3) ticks in a row.
   */
  v2_mm_guards_unreadable: 'warn',
  /**
   * The seller fee read was out of range, so the grossed ask could not be computed and those asks were NOT
   * rested. Error: quoting below the vault's intended net is a money-losing default, and the previous
   * behaviour was to rest anyway and record the fact somewhere nothing read.
   */
  v2_mm_fee_unreadable: 'error',
  /**
   * MM_HOUSE_FACTORY is set but no House vault can be quoted: the factory cannot be enumerated
   * (no ABI), a discovered vault's epoch could not be read, or its underlying() could not be
   * read. Error, not warn: the operator configured House quoting and is not getting it, and the bot will not fake an
   * epoch, nor quote a House vault on every market for want of its own.
   */
  v2_mm_house_unavailable: 'error',
  /**
   * An MM_VAULTS entry is a House vault (a configured factory enumerates it, or it answers epochEnd()), so it
   * is NOT quoted: as a treasury vault it would have no epoch, which is permission to open risk past epochEnd on
   * depositor money. Error: a configured vault is dark until MM_VAULTS stops listing it, and nothing fixes that itself.
   */
  v2_mm_vault_is_house: 'error',
  /**
   * The EarnVault's withdrawal queue has entries and its head has not moved for EARN_QUEUE_STUCK_S (the mm
   * bot's Earn step, earn/keep.ts). The message names what holds it: an open position (processQueue serves nothing
   * until the series settle or are closed), no venue adapter, or a venue with nothing left to pull. Error: depositors
   * are waiting for their own money, and a vault short of cash does not refill itself.
   */
  v2_earn_queue_stuck: 'error',
  /** EarnVault.skim() confirmed with the share price still above an unchanged mark: the fee was not taken. */
  v2_earn_skim_refused: 'warn',
  /** The cranker's key does not hold BUYBACK on the FeeSplitter: the flywheel claims and distributes, and no
   *  buyback can be sent. Raised only from the buyback probe (`buybackWithDeadline`; the role check
   *  runs before the deadline check), because `Managed` gives an unauthorised call the same V2Errors.NotAuthorized
   *  that `distribute` raises for an unset treasury. */
  v2_cranker_no_buyback_role: 'error',
  /** CRANKER_FLYWHEEL_ENABLED is off while V2_FEE_SPLITTER names a splitter: the flywheel step claims,
   *  distributes and buys back nothing, and the protocol's fees pile up on the book and in the splitter. Raised by
   *  the step's gate every tick it holds (the alerter's cooldown spaces the pages); earlier it skipped
   *  silently. Error: nothing turns it on by itself, and ops/v2-env.mjs renders it on whenever the splitter exists. */
  v2_cranker_flywheel_disabled: 'error',
  /** CRANKER_BUYBACK_DRY_RUN is on and the flywheel just withheld a buyback the route would have taken
   *  (reserve non-empty, cooldown elapsed, a non-zero quote): claims and distribution run, nothing is burned, and the
   *  reserve grows. Raised on each withheld buyback; earlier it was a /state note only. Warn: the switch
   *  exists to watch the route on purpose, and a watch has an end the page reminds somebody of. */
  v2_cranker_buyback_dry_run: 'warn',
  /** A House vault's weekly boundary has been due longer than its boundary expiry's uncorroborated delay + 1 h
   *  (cranker/steps.ts houseRollOverdueS: read live, 7 h HOUSE_ROLL_OVERDUE_S when unreadable) and has not
   *  rolled: the oracle is not Finalized, the vault is not flat, or nothing is sending `rollEpoch`. Error: until it
   *  rolls the vault prices no deposit and no withdrawal (the step is `house`). */
  v2_house_roll_overdue: 'error',

  /* ---- pricer (pricer/pricer.ts) ---- */
  /** INTERFACE_VERSION 8: the AccessManager refuses the pricer's key `reprice` on the AutoRoller - not a PRICER
   *  member, or a member whose calls must be scheduled. No smart-pricing ask can be repriced. */
  v2_pricer_no_role: 'error',
  /** A live smart-pricing ask has had no fair value (pricing service down or `fair: null`) for PRICER_FAIR_ALERT_S. */
  v2_pricer_fair_unavailable: 'warn',
  /** A due reprice did not go through: reverted on chain or not confirmed (error); a refused simulation, or a band ceiling
   *  below AutoRoller.reprice's per-call drop floor so nothing can be sent, is sent as warn. */
  v2_pricer_reprice_failed: 'error',
  /** Four consecutive evaluations landed on the minAsk/maxAsk clamp; streak resets on an unclamped tick. */
  v2_pricer_clamped: 'warn',
  /* ---- guardian (guardian/watch.ts) ---- */
  /**
   * An expiry is Pending on an UNCORROBORATED candidate: one ok source, or two that disagree. It finalizes at
   * `finalizableAt` unless the GUARDIAN vetoes or the sources corroborate first. A person compares the candidate with
   * an independent price before then. Warn: the watch pages every such
   * candidate, and most are a pool hiccup, not a fault.
   */
  v2_guardian_candidate: 'warn',
  /**
   * The candidate is GUARDIAN_SCALE_FACTOR (default 10x) or more away from every reference the watch could read (the
   * pool's window price or TWAP, and the market's last finalized price): a mis-scaled print. Error: if nothing vetoes
   * it, it finalizes and cannot be undone.
   */
  v2_guardian_scale_fault: 'error',
  /**
   * The candidate came from a Chainlink round in force longer than GUARDIAN_FEED_HEARTBEAT_S + GUARDIAN_FEED_STALE_MARGIN_S
   * at the expiry: the feed was down and the window was priced from a pre-outage round. Vetoed when the pool disagrees
   * beyond the market's maxDeviationBps; otherwise a person checks it. Error: it finalizes unless someone acts.
   */
  v2_guardian_stale_round: 'error',
  /** The watch vetoed a candidate (a scale fault, or a stale round the pool disagrees with): the expiry is Held until
   *  a person unvetoes it or adminResolve runs. */
  v2_guardian_vetoed: 'error',
  /** A veto was refused in simulation, reverted, or not confirmed. The candidate can still finalize. */
  v2_guardian_veto_failed: 'error',
  /* ---- cranker, INTERFACE_VERSION 7 (cranker/steps.ts stepStale) ---- */
  /**
   * An AutoRoller ask the spot has overtaken (at or past its strike) could not be withdrawn: `cancelStale`'s
   * simulation is refused, so the writer's ask keeps resting below intrinsic value until it fills or expires.
   * Raised as `warn` when the cause is the writer revoking the roller's delegate (nobody but the writer can fix it),
   * `error` otherwise (the monitor's `v2_mon_roller_ask_overtaken` rule).
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

/** The webhook's host, for messages and logs. Never its path or query: those carry the webhook's secret. */
export function webhookHost(webhook: string): string {
  try {
    return new URL(webhook).host || 'unparseable webhook URL';
  } catch {
    return 'unparseable webhook URL';
  }
}

/**
 * Why a POST never got an answer: the system error code under fetch's TypeError ('ENOTFOUND': the host does not resolve,
 * which is what a relay that was never deployed looks like; 'ECONNREFUSED': nothing listens), else the error's name
 * ('TimeoutError' from the 10 s AbortSignal), else 'unknown'.
 */
export function unreachableReason(error: unknown): string {
  let cur: unknown = error;
  for (let depth = 0; depth < 6 && cur !== null && typeof cur === 'object'; depth += 1) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  if (error instanceof Error && error.name !== 'Error' && error.name !== 'TypeError') return error.name;
  return 'unknown';
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
        const host = webhookHost(webhook);
        log.error({ status: response.status, host, kind: alert.kind }, 'alert webhook rejected the POST');
        this.options.onDelivery?.(false, `alert webhook rejected the POST (HTTP ${response.status} from ${host})`);
        return false;
      }
      this.options.onDelivery?.(true, null);
      return true;
    } catch (error) {
      // "unreachable" alone could not tell a relay that was never deployed (ENOTFOUND) from one that is down
      // (ECONNREFUSED) or slow (TimeoutError). Say which, and where -- the HOST only: a Discord or Telegram webhook URL
      // carries its token in the path.
      const host = webhookHost(webhook);
      const reason = unreachableReason(error);
      log.error({ err: redactUrls(String(error)), host, reason, kind: alert.kind }, 'alert webhook unreachable');
      this.options.onDelivery?.(false, `alert webhook unreachable (${host}: ${reason})`);
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
