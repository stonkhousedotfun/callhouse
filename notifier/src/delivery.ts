/**
 * The delivery queue: `enqueue` in, a worker out. This is the API the rules engine (N2-02) uses.
 *
 * ─── FOR N2-02 ──────────────────────────────────────────────────────────────────────────────
 *
 *   const result = await notifier.delivery.enqueue(kind, address, payload, dedupeKey);
 *
 *   kind       one of EVENT_KINDS (events.ts).
 *   address    the wallet the event is about (any case; stored checksummed).
 *   payload    the kind's shape in events.ts. Validated here: a bad payload THROWS EnqueueError
 *              (a bug in the caller, not a delivery problem), before anything is written.
 *   dedupeKey  `kind:address:seriesId:bucket`, built with dedupeKey() below. The bucket is what
 *              makes a repeat the same event: a day for strike_cross ("once per direction per
 *              day": `above-2026-09-18`), the expiry for expiry_24h, the fill id for
 *              fill_receipt, and so on. Enqueueing the same key again is a no-op per subscription,
 *              so the rules engine may re-evaluate after a restart without double-sending.
 *
 *   → { queued, duplicates, filtered }: rows written, rows that already existed, and active
 *     subscriptions of the address that do not want this kind (prefs) or whose channel is off.
 *     An address with no subscription is { 0, 0, 0 }, not an error.
 *
 * Enqueue is cheap (one SELECT, one INSERT per subscription) and returns before anything is sent.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * DELIVERY SEMANTICS
 *   - At least once. A pass leases due rows (status `sending`, lease 5 minutes) with
 *     FOR UPDATE SKIP LOCKED, sends, and records the outcome. A process that dies mid-send leaves
 *     the lease to expire and the row is sent again: a duplicate is possible, a loss is not.
 *   - Retries: 3, after 30 s, 2 min and 10 min (or the channel's Retry-After, if longer), then
 *     `failed`. Only transient outcomes retry (channels/types.ts).
 *   - Rate limit: at most 20 messages per subscription per rolling hour. The excess is DROPPED,
 *     not delayed: a storm that produces more than that is noise, and holding it back would only
 *     deliver stale alerts later.
 *   - Circuit breaker per shared destination (breaker.ts): Telegram and email use their channel;
 *     Web Push uses the endpoint host. A failing user-controlled push host cannot postpone another
 *     push service's rows. A 429 uses its Retry-After without counting as a channel outage.
 *   - At send time the subscription is re-read: deleted, disabled, unverified or no longer wanting
 *     the kind → dropped. A delivery older than 6 hours is dropped as stale (after an outage, a
 *     "expires in 1 hour" from yesterday helps nobody).
 *   - A `gone` outcome (push 404/410, Telegram blocked) disables the subscription.
 *   - Finished rows are kept 30 days (store.ts purge), which is also what the rate limit reads.
 */
import { getAddress, isAddress } from 'viem';
import { CircuitBreaker, DEFAULT_BREAKER, type BreakerState } from './breaker.js';
import { CHANNELS, type Channel, type ChannelName, type SendOutcome } from './channels/types.js';
import type { TargetCipher } from './crypto.js';
import type { Db } from './db.js';
import { isEventKind, parsePayload, type EventKind } from './events.js';
import { errorCode, type Logger } from './log.js';
import { prefsAllow, readPrefs } from './prefs.js';
import { activeForAddress, disableSubscription, purge } from './store.js';
import { render, type Links } from './templates.js';

export interface DeliveryOptions {
  batchSize: number;
  leaseMs: number;
  /** Idle wait between passes when the queue is drained. enqueue() wakes the worker early. */
  pollMs: number;
  /** Wait before retry n (1-based index n-1). Its length is the number of retries. */
  retryBackoffMs: number[];
  ratePerHour: number;
  maxAgeMs: number;
  purgeEveryMs: number;
}

export const DEFAULT_DELIVERY_OPTIONS: DeliveryOptions = {
  batchSize: 20,
  leaseMs: 5 * 60_000,
  pollMs: 2_000,
  retryBackoffMs: [30_000, 120_000, 600_000],
  ratePerHour: 20,
  maxAgeMs: 6 * 3600_000,
  purgeEveryMs: 10 * 60_000,
};

export class EnqueueError extends Error {
  constructor(readonly issues: string[]) {
    super(`enqueue refused: ${issues.join('; ')}`);
    this.name = 'EnqueueError';
  }
}

export interface EnqueueResult {
  queued: number;
  duplicates: number;
  filtered: number;
}

/** `kind:address:seriesId:bucket`, the dedupe key format of the N2 plan. */
export function dedupeKey(kind: EventKind, address: string, seriesId: string, bucket: string | number): string {
  return `${kind}:${getAddress(address)}:${seriesId}:${bucket}`;
}

const DEDUPE_KEY_RE = /^[\x21-\x7e]{1,256}$/;
const MAX_PUSH_BREAKERS = 256;

interface ClaimedRow {
  id: string;
  kind: string;
  payload: unknown;
  attempts: number;
  created_at: Date;
  subscription_id: string;
  address: string;
  channel: ChannelName;
  target_enc: string | null;
  prefs: unknown;
  verified_at: Date | null;
  disabled_at: Date | null;
}

export interface DeliveryDeps {
  db: Db;
  cipher: TargetCipher;
  links: Links;
  logger: Logger;
  now: () => Date;
  /** Configured channels. A channel left out (email without SMTP_URL) is off. */
  channels: Partial<Record<ChannelName, Channel>>;
  options?: Partial<DeliveryOptions>;
  breakers?: Partial<Record<ChannelName, CircuitBreaker>>;
}

export class DeliveryService {
  private readonly options: DeliveryOptions;
  private readonly breakers: Record<ChannelName, CircuitBreaker>;
  /** Bounded LRU of host-local Web Push breakers. Endpoint hosts are untrusted input. */
  private readonly pushBreakers = new Map<string, CircuitBreaker>();
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private wakeRequested = false;
  private lastPurge = 0;

  constructor(private readonly deps: DeliveryDeps) {
    this.options = { ...DEFAULT_DELIVERY_OPTIONS, ...deps.options };
    this.breakers = {
      telegram: deps.breakers?.telegram ?? new CircuitBreaker(DEFAULT_BREAKER),
      webpush: deps.breakers?.webpush ?? new CircuitBreaker(DEFAULT_BREAKER),
      email: deps.breakers?.email ?? new CircuitBreaker(DEFAULT_BREAKER),
    };
  }

  async enqueue(kind: EventKind, address: string, payload: unknown, dedupe: string): Promise<EnqueueResult> {
    const issues: string[] = [];
    if (!isEventKind(kind)) issues.push(`kind: not one of the §6 event kinds`);
    if (typeof address !== 'string' || !isAddress(address, { strict: false })) issues.push('address: a 20-byte hex address');
    if (typeof dedupe !== 'string' || !DEDUPE_KEY_RE.test(dedupe)) issues.push('dedupeKey: 1-256 printable characters, no spaces');
    if (issues.length > 0) throw new EnqueueError(issues);

    const wallet = getAddress(address);
    if (!dedupe.toLowerCase().startsWith(`${kind}:${wallet.toLowerCase()}:`)) {
      throw new EnqueueError(['dedupeKey: must start with `kind:address:` (use dedupeKey())']);
    }
    const parsed = parsePayload(kind, payload);
    if (!parsed.ok) throw new EnqueueError(parsed.issues);

    const { db, now } = this.deps;
    const at = now();
    const result: EnqueueResult = { queued: 0, duplicates: 0, filtered: 0 };
    for (const sub of await activeForAddress(db, wallet)) {
      const prefs = readPrefs(sub.prefs);
      if (this.deps.channels[sub.channel] === undefined || prefs === null || !prefsAllow(prefs, parsed.event)) {
        result.filtered += 1;
        continue;
      }
      const { rowCount } = await db.query(
        `INSERT INTO notifier.delivery (subscription_id, kind, dedupe_key, payload, status, created_at, next_attempt_at)
         VALUES ($1, $2, $3, $4::jsonb, 'pending', $5::timestamptz, $5::timestamptz)
         ON CONFLICT (subscription_id, dedupe_key) DO NOTHING`,
        [sub.id, kind, dedupe, JSON.stringify(parsed.event.payload), at],
      );
      if (rowCount > 0) result.queued += 1;
      else result.duplicates += 1;
    }
    if (result.queued > 0) this.notify();
    return result;
  }

  breakerStates(): Record<ChannelName, BreakerState | 'off'> {
    const nowMs = this.deps.now().getTime();
    const out = {} as Record<ChannelName, BreakerState | 'off'>;
    for (const name of CHANNELS) {
      out[name] = this.deps.channels[name] === undefined ? 'off' : this.breakers[name].state(nowMs);
    }
    if (out.webpush !== 'off') {
      // This is an aggregate diagnostic only; each host's breaker controls only that host.
      for (const breaker of this.pushBreakers.values()) {
        const state = breaker.state(nowMs);
        if (state === 'open') { out.webpush = 'open'; break; }
        if (state === 'half-open') out.webpush = 'half-open';
      }
    }
    return out;
  }

  private breakerFor(channel: ChannelName, target: string, subscriptionId: string): CircuitBreaker {
    if (channel !== 'webpush') return this.breakers[channel];
    let key = subscriptionId;
    try {
      const parsed = JSON.parse(target) as { endpoint?: unknown };
      if (typeof parsed.endpoint === 'string') key = new URL(parsed.endpoint).hostname.toLowerCase();
    } catch {
      // A malformed stored target is handled by the channel as a permanent failure. It still
      // gets an isolated breaker so it can never affect another subscription.
    }
    const existing = this.pushBreakers.get(key);
    if (existing !== undefined) {
      this.pushBreakers.delete(key);
      this.pushBreakers.set(key, existing);
      return existing;
    }
    if (this.pushBreakers.size >= MAX_PUSH_BREAKERS) this.pushBreakers.delete(this.pushBreakers.keys().next().value!);
    const breaker = new CircuitBreaker(DEFAULT_BREAKER);
    this.pushBreakers.set(key, breaker);
    return breaker;
  }

  /** Lease and process one batch of due deliveries. Returns how many rows it took. */
  async runOnce(): Promise<number> {
    const at = this.deps.now();
    const { rows } = await this.deps.db.query<ClaimedRow>(
      `UPDATE notifier.delivery AS d
          SET status = 'sending', next_attempt_at = $2::timestamptz
         FROM notifier.subscription AS s
        WHERE d.id IN (SELECT id FROM notifier.delivery
                        WHERE status IN ('pending', 'sending') AND next_attempt_at <= $1::timestamptz
                        ORDER BY next_attempt_at, id
                        LIMIT $3
                        FOR UPDATE SKIP LOCKED)
          AND s.id = d.subscription_id
      RETURNING d.id, d.kind, d.payload, d.attempts, d.created_at, d.subscription_id,
                s.address, s.channel, s.target_enc, s.prefs, s.verified_at, s.disabled_at`,
      [at, new Date(at.getTime() + this.options.leaseMs), this.options.batchSize],
    );
    rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id));
    for (const row of rows) {
      try {
        await this.process(row);
      } catch (error) {
        // A database error mid-row: the lease runs out and a later pass takes the row again.
        this.deps.logger.error(
          { deliveryId: row.id, subscriptionId: row.subscription_id, errorCode: errorCode(error) },
          'delivery processing error',
        );
      }
    }
    return rows.length;
  }

  private async process(row: ClaimedRow): Promise<void> {
    const { db, logger, cipher } = this.deps;
    const at = this.deps.now();
    const fields = { deliveryId: row.id, subscriptionId: row.subscription_id, kind: row.kind, channel: row.channel };

    const drop = async (reason: string) => {
      await db.query(`UPDATE notifier.delivery SET status = 'dropped', last_error_code = $2 WHERE id = $1`, [row.id, reason]);
      logger.info({ ...fields, reason }, 'delivery dropped');
    };
    const fail = async (code: string) => {
      await db.query(
        `UPDATE notifier.delivery SET status = 'failed', attempts = attempts + 1, last_error_code = $2 WHERE id = $1`,
        [row.id, code],
      );
      logger.warn({ ...fields, errorCode: code, attempts: row.attempts + 1 }, 'delivery failed');
    };

    if (row.disabled_at !== null || row.verified_at === null || row.target_enc === null) return drop('subscription_inactive');
    const channel = this.deps.channels[row.channel];
    if (channel === undefined) return drop('channel_off');
    if (at.getTime() - row.created_at.getTime() > this.options.maxAgeMs) return drop('stale');
    if (!isEventKind(row.kind)) return drop('unknown_kind');
    const parsed = parsePayload(row.kind, row.payload);
    if (!parsed.ok) return fail('bad_payload');
    const prefs = readPrefs(row.prefs);
    if (prefs === null || !prefsAllow(prefs, parsed.event)) return drop('pref_off');

    const { rows: sent } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM notifier.delivery
        WHERE subscription_id = $1 AND status = 'sent' AND sent_at > $2::timestamptz`,
      [row.subscription_id, new Date(at.getTime() - 3600_000)],
    );
    if ((sent[0]?.n ?? 0) >= this.options.ratePerHour) return drop('rate_limited');

    let target: string;
    try {
      target = cipher.decrypt(row.target_enc, `${row.channel}:${row.address}`);
    } catch {
      return fail('target_unreadable');
    }

    let message: ReturnType<typeof render>;
    try {
      message = render(parsed.event, this.deps.links);
    } catch {
      // A payload the schema accepted but a template cannot format: retrying will not help.
      return fail('render_error');
    }

    // Last gate before the network, so a half-open breaker's single trial is always a real send.
    const breaker = this.breakerFor(row.channel, target, row.subscription_id);
    if (!breaker.allow(at.getTime())) {
      const next = new Date(Math.max(breaker.openUntil, at.getTime() + 1_000));
      await db.query(`UPDATE notifier.delivery SET status = 'pending', next_attempt_at = $2::timestamptz WHERE id = $1`, [
        row.id,
        next,
      ]);
      return;
    }

    let outcome: SendOutcome;
    try {
      const expiresAt = parsed.event.kind === 'expiry_1h' || parsed.event.kind === 'expiry_24h'
        ? parsed.event.payload.series.expiry : undefined;
      outcome = await channel.send(target, message, {
        subscriptionId: row.subscription_id,
        kind: row.kind,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
    } catch (error) {
      // Channels never throw by contract; if one does, it must still settle the breaker's trial.
      outcome = { ok: false, kind: 'transient', code: errorCode(error) };
    }

    if (outcome.ok) {
      breaker.success();
      await db.query(
        `UPDATE notifier.delivery SET status = 'sent', attempts = attempts + 1, sent_at = $2::timestamptz, last_error_code = NULL
          WHERE id = $1`,
        [row.id, at],
      );
      logger.info({ ...fields, attempts: row.attempts + 1 }, 'delivery sent');
      return;
    }

    if (outcome.kind === 'transient') {
      const wasOpen = breaker.state(at.getTime()) !== 'closed';
      // Push and Bot API 429s can be scoped to one subscription/chat. Their Retry-After is
      // already applied to this row, so they must not trip a shared destination breaker.
      if (outcome.code === 'http_429') breaker.success();
      else breaker.failure(at.getTime());
      if (!wasOpen && breaker.state(at.getTime()) === 'open') {
        logger.warn({ channel: row.channel, errorCode: outcome.code, openUntil: new Date(breaker.openUntil).toISOString() }, 'circuit breaker opened');
      }
      const attempts = row.attempts + 1;
      const backoff = this.options.retryBackoffMs[attempts - 1];
      if (backoff === undefined) return fail(outcome.code);
      const delay = Math.max(backoff, outcome.retryAfterMs ?? 0);
      await db.query(
        `UPDATE notifier.delivery SET status = 'pending', attempts = attempts + 1, last_error_code = $2, next_attempt_at = $3::timestamptz
          WHERE id = $1`,
        [row.id, outcome.code, new Date(at.getTime() + delay)],
      );
      logger.warn({ ...fields, errorCode: outcome.code, attempts, retryInMs: delay }, 'delivery retry scheduled');
      return;
    }

    // permanent or gone: the channel answered, so it is healthy.
    breaker.success();
    await fail(outcome.code);
    if (outcome.kind === 'gone' && (await disableSubscription(db, row.subscription_id, outcome.code, at))) {
      logger.warn({ subscriptionId: row.subscription_id, channel: row.channel, errorCode: outcome.code }, 'subscription disabled');
    }
  }

  /** Start the worker loop. Returns at once. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.notify();
    await this.loop;
    this.loop = null;
  }

  /**
   * Cut the idle wait short. The flag covers an enqueue that lands while a pass is still running
   * (no wait to cut yet): the loop sees it and goes straight into another pass instead of sleeping
   * through a message it has not read.
   */
  private notify(): void {
    this.wakeRequested = true;
    this.wake?.();
  }

  private async run(): Promise<void> {
    while (this.running) {
      let taken = 0;
      this.wakeRequested = false;
      try {
        taken = await this.runOnce();
        const nowMs = this.deps.now().getTime();
        if (nowMs - this.lastPurge >= this.options.purgeEveryMs) {
          this.lastPurge = nowMs;
          const removed = await purge(this.deps.db, this.deps.now());
          if (removed.nonces + removed.links + removed.deliveries > 0) this.deps.logger.info(removed, 'purged expired rows');
        }
      } catch (error) {
        this.deps.logger.error({ errorCode: errorCode(error) }, 'delivery pass failed');
      }
      if (!this.running) return;
      if (taken < this.options.batchSize && !this.wakeRequested) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, this.options.pollMs);
          const self = this;
          function done() {
            clearTimeout(timer);
            if (self.wake === done) self.wake = null;
            resolve();
          }
          this.wake = done;
        });
      }
    }
  }
}
