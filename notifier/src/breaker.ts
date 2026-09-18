/**
 * One breaker per shared destination: Telegram and email use a channel-wide breaker;
 * Web Push uses the endpoint host so user-controlled endpoints cannot block another service.
 *
 * WHY: when Telegram, a push service or the SMTP relay is down, every due delivery on that channel
 * would otherwise burn its retries against the outage within minutes and end `failed`, and a
 * backlog would hammer the service the moment it came back. With the breaker open, the worker
 * postpones that channel's deliveries WITHOUT spending an attempt, so an outage costs latency,
 * not messages, and the other channels keep flowing.
 *
 *   closed      sends go through. `threshold` transient failures in a row open it.
 *   open        nothing is sent until `openUntil`.
 *   half-open   after the cool-down, exactly one trial send. Success closes the breaker; failure
 *               re-opens it with the cool-down doubled, up to `maxCooldownMs`.
 *
 * Transient failures except HTTP 429 count (types.ts): 429 may concern one target and its row
 * already obeys Retry-After. A push 410 or a Telegram "blocked" is about one target, and the
 * channel that said so is working. State is in memory: the service runs as one
 * replica, and a restart starting closed is the right default.
 */

export interface BreakerOptions {
  threshold: number;
  cooldownMs: number;
  maxCooldownMs: number;
}

export const DEFAULT_BREAKER: BreakerOptions = { threshold: 5, cooldownMs: 30_000, maxCooldownMs: 10 * 60_000 };

export type BreakerState = 'closed' | 'open' | 'half-open';

export class CircuitBreaker {
  private failures = 0;
  private openedUntil = 0;
  private cooldown: number;
  private trialInFlight = false;

  constructor(private readonly options: BreakerOptions = DEFAULT_BREAKER) {
    this.cooldown = options.cooldownMs;
  }

  state(nowMs: number): BreakerState {
    if (this.openedUntil === 0) return 'closed';
    return nowMs < this.openedUntil ? 'open' : 'half-open';
  }

  /** When an open breaker next allows a trial (ms); 0 when closed. */
  get openUntil(): number {
    return this.openedUntil;
  }

  /** Whether a send may go now. In half-open, only the first caller gets true. */
  allow(nowMs: number): boolean {
    const state = this.state(nowMs);
    if (state === 'closed') return true;
    if (state === 'open' || this.trialInFlight) return false;
    this.trialInFlight = true;
    return true;
  }

  success(): void {
    this.failures = 0;
    this.openedUntil = 0;
    this.trialInFlight = false;
    this.cooldown = this.options.cooldownMs;
  }

  failure(nowMs: number): void {
    if (this.trialInFlight || this.openedUntil !== 0) {
      // The half-open trial failed: back off harder.
      this.trialInFlight = false;
      this.cooldown = Math.min(this.cooldown * 2, this.options.maxCooldownMs);
      this.openedUntil = nowMs + this.cooldown;
      return;
    }
    this.failures += 1;
    if (this.failures >= this.options.threshold) {
      this.openedUntil = nowMs + this.cooldown;
    }
  }
}
