/**
 * Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291).
 *
 * TARGET. What the browser's `PushManager.subscribe()` returns, as `subscription.toJSON()`:
 *   { endpoint: "https://…", expirationTime: null, keys: { p256dh, auth } }
 * The dapp POSTs it as `target` (the object or its JSON string); it is stored sealed, whole.
 * The endpoint is the identity: a repeat POST from the same browser updates the same row.
 *
 * SENDING. `web-push` builds the request (encrypts the payload, signs the VAPID JWT) and this
 * module sends it with fetch, so the call has the same deadline, redirect refusal and secret-free
 * error codes as every other outbound call here. 201/202/200 = accepted; 404/410 = the browser
 * unsubscribed or the subscription expired, so the subscription is disabled (`gone`); 429 and 5xx
 * are transient; anything else is permanent for this message.
 *
 * PAYLOAD, for the service worker (W2-10 public/sw.js):
 *   { title, body, url, kind }   JSON; show `title` / `body`, open `url` on click.
 * Push services cap the encrypted body near 4 KB, so the body is trimmed to 1 KB of text.
 *
 * ENDPOINTS ARE USER INPUT, and this service POSTs to them. `isAllowedPushEndpoint` (applied by the
 * API before anything is stored) takes https URLs on known browser push-service hosts only.
 * This prevents a subscriber from making the worker POST to arbitrary hosts, including
 * wildcard-DNS names that resolve to private addresses. It does not replace network egress policy.
 */
import { isIP } from 'node:net';
import webpush from 'web-push';
import { z } from 'zod';
import { errorCode } from '../log.js';
import type { Rendered } from '../templates.js';
import { retryAfterMs, type Channel } from './types.js';

export const PUSH_TIMEOUT_MS = 5_000;
/** How long a push service keeps an undelivered message for an offline browser. */
export const PUSH_TTL_S = 6 * 3600;
const SHORT_PUSH_TTL_S = 3600;
const BODY_LIMIT = 1_000;

const b64url = (bytes: number) =>
  z.string().refine((raw) => /^[A-Za-z0-9_-]+={0,2}$/.test(raw) && Buffer.from(raw, 'base64url').length === bytes, {
    message: `must be base64url of ${bytes} bytes`,
  });

export const pushSubscriptionSchema = z.object({
  endpoint: z.string().max(2048),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: b64url(65), auth: b64url(16) }),
});

export type PushSubscriptionJson = z.infer<typeof pushSubscriptionSchema>;

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username !== '' || url.password !== '') return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) return false;
  return host === 'fcm.googleapis.com' ||
    host === 'updates.push.services.mozilla.com' ||
    host === 'web.push.apple.com' ||
    host.endsWith('.push.apple.com') ||
    host.endsWith('.notify.windows.com');
}

/** Parse a `target` from the API into a canonical subscription, or null. */
export function parsePushTarget(target: unknown): PushSubscriptionJson | null {
  let value = target;
  if (typeof target === 'string') {
    try {
      value = JSON.parse(target);
    } catch {
      return null;
    }
  }
  const parsed = pushSubscriptionSchema.safeParse(value);
  if (!parsed.success || !isAllowedPushEndpoint(parsed.data.endpoint)) return null;
  return { endpoint: parsed.data.endpoint, keys: parsed.data.keys };
}

export interface WebPushSettings {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function pushTtlSeconds(kind: string, expiresAt?: number, now = Date.now()): number {
  const cap = kind === 'expiry_1h' || kind === 'price_alert' || kind === 'strike_cross' ||
    kind === 'writer_itm_warning' ? SHORT_PUSH_TTL_S : PUSH_TTL_S;
  if (kind !== 'expiry_1h' && kind !== 'expiry_24h') return cap;
  if (expiresAt === undefined) return cap;
  return Math.max(0, Math.min(cap, Math.floor(expiresAt - now / 1000)));
}

export function webPushChannel(settings: WebPushSettings): Channel {
  return {
    name: 'webpush',
    async send(target, message: Rendered, context) {
      const ttl = pushTtlSeconds(context.kind, context.expiresAt);
      if (ttl === 0) return { ok: false, kind: 'permanent', code: 'expired_notification' };
      let subscription: PushSubscriptionJson;
      let details: ReturnType<typeof webpush.generateRequestDetails>;
      try {
        subscription = pushSubscriptionSchema.parse(JSON.parse(target));
        const body = message.body.length > BODY_LIMIT ? `${message.body.slice(0, BODY_LIMIT - 1)}…` : message.body;
        details = webpush.generateRequestDetails(
          subscription,
          JSON.stringify({ title: message.title, body, url: message.url, kind: context.kind }),
          {
            vapidDetails: settings,
            TTL: ttl,
            urgency: 'normal',
            contentEncoding: 'aes128gcm',
          },
        );
      } catch {
        // A stored target that no longer parses, or keys web-push refuses: this will never send.
        return { ok: false, kind: 'permanent', code: 'bad_subscription' };
      }

      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(details.headers)) {
        // fetch computes Content-Length from the body itself.
        if (name.toLowerCase() !== 'content-length') headers[name] = String(value);
      }
      try {
        const response = await fetch(details.endpoint, {
          method: details.method,
          headers,
          body: details.body ?? undefined,
          signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
          redirect: 'error',
        });
        // Push endpoints are user input. Discard their response without buffering an
        // arbitrarily large body in this process.
        await response.body?.cancel().catch(() => undefined);
        const code = `http_${response.status}`;
        if (response.status >= 200 && response.status < 300) return { ok: true };
        if (response.status === 404 || response.status === 410) return { ok: false, kind: 'gone', code };
        if (response.status === 429 || response.status >= 500) {
          const after = retryAfterMs(response.headers.get('retry-after'));
          return after === undefined ? { ok: false, kind: 'transient', code } : { ok: false, kind: 'transient', code, retryAfterMs: after };
        }
        return { ok: false, kind: 'permanent', code };
      } catch (error) {
        return { ok: false, kind: 'transient', code: errorCode(error) };
      }
    },
  };
}
