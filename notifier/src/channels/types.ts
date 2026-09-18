/**
 * What a channel is to the delivery worker: one send with a deadline that never throws, and an
 * outcome the worker can act on without knowing the channel.
 *
 *   ok          delivered (accepted by the Bot API, the push service or the SMTP server).
 *   transient   the channel is unwell or busy: timeout, network error, 5xx, 429. Retried with
 *               back-off; 429 uses Retry-After without tripping a shared breaker.
 *   permanent   this message to this target will never go through (400 on our body, 413, a
 *               5xx SMTP reply). Not retried; the channel itself is fine.
 *   gone        the target no longer exists or no longer wants us: push 404/410, Telegram "bot
 *               was blocked" / "chat not found", SMTP 550 at RCPT TO. Not retried, and the subscription is
 *               disabled so nothing else is queued for it.
 *
 * `code` is short and secret-free (`http_410`, `timeout`, `ECONNREFUSED`): it is stored in
 * delivery.last_error_code and logged.
 */
import type { Rendered } from '../templates.js';

export type ChannelName = 'telegram' | 'webpush' | 'email';

export const CHANNELS: readonly ChannelName[] = ['telegram', 'webpush', 'email'];

export type SendOutcome =
  | { ok: true }
  | { ok: false; kind: 'transient'; code: string; retryAfterMs?: number }
  | { ok: false; kind: 'permanent'; code: string }
  | { ok: false; kind: 'gone'; code: string };

export interface SendContext {
  subscriptionId: string;
  kind: string;
  /** Unix expiry for countdown alerts; limits the push service's offline TTL. */
  expiresAt?: number;
}

export interface Channel {
  name: ChannelName;
  /** `target` is the decrypted target. Never throws. */
  send(target: string, message: Rendered, context: SendContext): Promise<SendOutcome>;
}

/** Seconds from a Retry-After header or Telegram's retry_after, capped at an hour. */
export function retryAfterMs(seconds: unknown): number | undefined {
  const n = typeof seconds === 'string' ? Number(seconds) : seconds;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, 3600) * 1000;
}
