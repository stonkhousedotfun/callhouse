/**
 * The notifier's HTTP API, on Hono. Built around injected dependencies so the
 * tests drive it with `app.request` and a PGlite database, no socket and no network.
 *
 *   GET    /health                    200 always while the process serves (liveness), with the
 *                                     database, per-channel breaker state and the rules engine's
 *                                     last tick (off | starting | ok | failing).
 *   POST   /v1/challenge              { address } → { message, nonce, expiresAt }
 *   POST   /v1/session                { address, signature, nonce } → { token, address, expiresAt } (v5)
 *   POST   /v1/subscriptions          { address, signature, nonce, channel, target, prefs } → { id }
 *                                     201 created, 200 an existing subscription updated
 *   GET    /v1/subscriptions          ?address&signature&nonce → { items }
 *   DELETE /v1/subscriptions/:id      ?address&signature&nonce (or the same in a JSON body) → { ok }
 *   GET    /v1/telegram/link          ?address&signature&nonce → { deepLink, expiresAt }
 *   GET    /v1/webpush/key            → { publicKey }
 *   GET    /v1/email/confirm          ?token → a page with a Confirm button (POSTs back)
 *   POST   /v1/email/confirm          token → verified
 *   GET    /v1/email/unsubscribe      ?token → a page with an Unsubscribe button
 *   POST   /v1/email/unsubscribe      token (form or query; RFC 8058 one-click) → disabled
 *   POST   /v1/email/resubscribe      token from a received email → allow new confirmation requests
 *
 * v5 SESSIONS (session.ts): GET/POST /v1/subscriptions, DELETE /v1/subscriptions/:id and
 * GET /v1/telegram/link also take `Authorization: Bearer <token>` in place of signature/nonce.
 * With a bearer, `address` in the query or body is optional and, when present, must be the token's
 * address (case-insensitive) or the answer is 403 forbidden; a malformed, forged or expired token
 * is 401 session-invalid. A bearer beats signature/nonce sent in the same request, and that nonce
 * is not spent. DELETE needs nothing but the bearer. /v1/session itself ignores a bearer.
 *
 * DECISIONS WHERE §6 IS SILENT (the dapp, W2-10, builds against these):
 *   - `target` per channel: webpush = the PushSubscription JSON (object or string); email = the
 *     address; telegram = omitted (or "" / null). The chat is bound by the bot's /start, never
 *     typed in: POST with channel "telegram" stores or updates PREFS for the wallet's (single)
 *     Telegram subscription, and `GET /v1/telegram/link` produces the link that attaches a chat.
 *   - `prefs` may be partial (prefs.ts): missing toggles are on.
 *   - Every request is fully validated BEFORE the nonce is spent, so a typo does not cost the user
 *     another wallet prompt. Authentication failures: 401 nonce-invalid | signature-invalid;
 *     503 verifier-unavailable (RPC down, contract wallet).
 *   - List items: { id, channel, status: active|pending|disabled, target, prefs, createdAt,
 *     verifiedAt, disabledAt, disabledReason }. `target` is a hint, never the target: the push
 *     service host, a masked email, null for Telegram. Times are unix seconds.
 *   - DELETE of an id that is not the wallet's answers 404, the same as an unknown id.
 *   - Errors are `{ error: { code, message } }`, as in the indexer API.
 *
 * CORS admits APP_URL's origin only, including /health used by dapp settings, with the
 * content-type and authorization request headers.
 * Bodies are capped at 16 KiB. Responses are `no-store` and `Referrer-Policy: no-referrer` (the
 * email pages carry their token in the URL). Nothing logs a query string, a body, a header, an
 * address, a target, a signature or a session token: see log.ts.
 */
import { Hono, type Context } from 'hono';
import { isIP } from 'node:net';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { Address } from 'viem';
import { z } from 'zod';
import { authenticate, CHALLENGE_WINDOW_MS, ChallengeRateLimitError, createChallenge, MAX_CHALLENGES_GLOBAL, normaliseAddress, type SignatureVerifier } from './auth.js';
import type { BreakerState } from './breaker.js';
import {
  classifySmtp,
  confirmationMail,
  emailBudgetInbox,
  maskEmail,
  parseEmailTarget,
  sendWithDeadline,
  type EmailLinks,
  type EmailTokens,
  type Mailer,
} from './channels/email.js';
import type { ChannelName } from './channels/types.js';
import { parsePushTarget } from './channels/webpush.js';
import type { TargetCipher } from './crypto.js';
import type { Db } from './db.js';
import { errorCode, type Logger } from './log.js';
import { prefsSchema, readPrefs } from './prefs.js';
import type { RulesHealth } from './rules/engine.js';
import { bearerToken, sessionTokens } from './session.js';
import {
  confirmEmail,
  deleteOwned,
  allowEmailConfirmations,
  EmailRecipientLimitError,
  EmailConfirmationBudgetError,
  EmailSuppressedError,
  EmailSubscriptionLimitError,
  getById,
  listByAddress,
  SubscriptionLimitError,
  upsertEmailAndClaimConfirmation,
  unsubscribeEmail,
  upsertTelegramPrefs,
  upsertWebPush,
  type SubscriptionRow,
} from './store.js';

export const MAX_BODY_BYTES = 16 * 1024;

export interface AppDeps {
  appUrl: string;
  vapidPublicKey: string;
  db: Db;
  cipher: TargetCipher;
  verify: SignatureVerifier;
  now: () => Date;
  logger: Logger;
  breakerStates: () => Record<ChannelName, BreakerState | 'off'>;
  /** The rules engine (N2-02). Absent = off. */
  rulesHealth?: () => RulesHealth;
  telegram: {
    readonly username: string | null;
    createLink(address: string): Promise<{ deepLink: string; expiresAt: number } | null>;
  };
  /** null when SMTP_URL is unset: the email channel is off. */
  email: { mailer: Mailer; tokens: EmailTokens; links: EmailLinks } | null;
}

type ErrorStatus = 400 | 401 | 403 | 404 | 413 | 429 | 500 | 502 | 503;

function fail(c: Context, status: ErrorStatus, code: string, message: string) {
  return c.json({ error: { code, message } }, status);
}

const seconds = (d: Date | null): number | null => (d === null ? null : Math.floor(d.getTime() / 1000));

// address / signature / nonce are optional here: with a bearer only `channel` (and target, prefs)
// matter; without one, authenticate() refuses a missing credential with the same 400.
const subscribeSchema = z
  .object({
    address: z.string().optional(),
    signature: z.string().optional(),
    nonce: z.string().optional(),
    channel: z.enum(['telegram', 'webpush', 'email']),
    target: z.unknown().optional(),
    prefs: z.unknown().optional(),
  })
  .strict();

const authSchema = z.object({ address: z.string(), signature: z.string(), nonce: z.string() });

const sessionSchema = authSchema.strict();

type Credentials = { address?: unknown; signature?: unknown; nonce?: unknown };
type Access = { ok: true; address: Address } | { ok: false; status: 400 | 401 | 403 | 503; code: string; message: string };

async function readJson(c: Context): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return { ok: false };
  }
}

const zodIssues = (error: z.ZodError): string =>
  error.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');

/* ------------------------------------------------------------------ html pages (email links) */

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);

function page(title: string, lines: string[], form?: { action: string; token: string; button: string }): string {
  const formHtml =
    form === undefined
      ? ''
      : `<form method="post" action="${escapeHtml(form.action)}"><input type="hidden" name="token" value="${escapeHtml(form.token)}"><button type="submit">${escapeHtml(form.button)}</button></form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#111;background:#fff}button{font:inherit;padding:.5rem 1rem;cursor:pointer}</style></head><body><h1>${escapeHtml(title)}</h1>${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}${formHtml}</body></html>`;
}

function htmlResponse(c: Context, status: 200 | 400 | 404 | 503, html: string) {
  c.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
  return c.html(html, status);
}

/* ------------------------------------------------------------------ app */

export function createApp(deps: AppDeps): Hono {
  const { db, logger } = deps;
  const app = new Hono();
  const appOrigin = new URL(deps.appUrl).origin;
  const settingsUrl = `${deps.appUrl}/settings/notifications`;
  const sessions = sessionTokens(deps.cipher);
  const challengeClients = new Map<string, { count: number; since: number }>();

  const challengeClientKey = (c: Context): string => {
    // The ingress appends the connecting address to X-Forwarded-For; use the final valid hop, not
    // a caller-supplied first hop. Unknown clients share a conservative bucket.
    const hop = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim() ?? '';
    return isIP(hop) ? hop : 'unknown';
  };
  const admitChallengeClient = (key: string, now: Date): boolean => {
    const ms = now.getTime();
    const prior = challengeClients.get(key);
    if (prior !== undefined && ms >= prior.since && ms - prior.since < CHALLENGE_WINDOW_MS) {
      if (prior.count >= MAX_CHALLENGES_GLOBAL) return false;
      prior.count += 1;
      return true;
    }
    if (challengeClients.size >= 4096) challengeClients.delete(challengeClients.keys().next().value!);
    challengeClients.set(key, { count: 1, since: ms });
    return true;
  };

  const emailRowBudget = async (id: string): Promise<{ row: SubscriptionRow; hash: string } | null> => {
    const row = await getById(db, id);
    if (row?.channel !== 'email' || row.target_enc === null) return null;
    try {
      const address = deps.cipher.decrypt(row.target_enc, `email:${row.address}`);
      return { row, hash: deps.cipher.hash(`email-inbox-budget:${emailBudgetInbox(address)}`) };
    } catch {
      return null;
    }
  };

  /**
   * Who is calling: a session bearer when the request has an Authorization header, else the
   * address/signature/nonce in `input` (which spends the nonce). With a bearer, signature and
   * nonce are ignored and nothing is spent.
   */
  const authorize = async (c: Context, input: Credentials): Promise<Access> => {
    const token = bearerToken(c.req.header('authorization'));
    if (token === undefined) return authenticate({ db, verify: deps.verify, now: deps.now() }, input);
    const address = token === null ? null : sessions.read(token, deps.now());
    if (address === null) {
      return { ok: false, status: 401, code: 'session-invalid', message: 'the session is invalid or has expired: sign in again' };
    }
    if (input.address !== undefined && (typeof input.address !== 'string' || input.address.toLowerCase() !== address.toLowerCase())) {
      return { ok: false, status: 403, code: 'forbidden', message: 'address: the session belongs to another address' };
    }
    return { ok: true, address };
  };

  app.use('*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
    c.header('referrer-policy', 'no-referrer');
    c.header('x-content-type-options', 'nosniff');
  });
  app.use(
    '*',
    cors({
      origin: appOrigin,
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['content-type', 'authorization'],
      maxAge: 600,
    }),
  );
  app.use(
    '/v1/*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => fail(c, 413, 'payload-too-large', `body exceeds ${MAX_BODY_BYTES} bytes`),
    }),
  );

  app.onError((error, c) => {
    logger.error({ route: c.req.routePath, method: c.req.method, errorCode: errorCode(error) }, 'unhandled error in request');
    return fail(c, 500, 'internal-error', 'internal error');
  });
  app.notFound((c) => fail(c, 404, 'not-found', 'no such route'));

  /* ---- health ---- */

  app.get('/health', async (c) => {
    let database: 'ok' | 'unavailable' = 'ok';
    try {
      await Promise.race([
        db.query('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2_000).unref()),
      ]);
    } catch {
      database = 'unavailable';
    }
    return c.json({
      status: database === 'ok' ? 'ok' : 'degraded',
      service: 'callhouse-notifier',
      database,
      channels: deps.breakerStates(),
      telegramBot: deps.telegram.username === null ? 'unknown' : 'ok',
      rules: deps.rulesHealth?.() ?? { status: 'off', lastSuccessAt: null, consecutiveFailures: 0 },
    });
  });

  /* ---- challenge ---- */

  app.post('/v1/challenge', async (c) => {
    const body = await readJson(c);
    if (!body.ok) return fail(c, 400, 'bad-request', 'body is not valid JSON');
    const address = normaliseAddress((body.value as { address?: unknown } | null)?.address);
    if (address === null) return fail(c, 400, 'bad-request', 'address: a 20-byte hex address');
    const now = deps.now();
    const clientKey = challengeClientKey(c);
    if (!admitChallengeClient(clientKey, now)) return fail(c, 429, 'challenge-rate-limited', 'too many challenges: try again shortly');
    try {
      return c.json(await createChallenge(db, { appUrl: deps.appUrl, address, now }));
    } catch (error) {
      if (error instanceof ChallengeRateLimitError) {
        const quota = challengeClients.get(clientKey);
        if (quota !== undefined && quota.since <= now.getTime()) quota.count = Math.max(0, quota.count - 1);
        return fail(c, 429, 'challenge-rate-limited', 'too many challenges: try again shortly');
      }
      throw error;
    }
  });

  /* ---- session (v5) ---- */

  // Always a fresh signature: a bearer on this route is ignored, so a session cannot extend itself.
  app.post('/v1/session', async (c) => {
    const body = await readJson(c);
    if (!body.ok) return fail(c, 400, 'bad-request', 'body is not valid JSON');
    const parsed = sessionSchema.safeParse(body.value);
    if (!parsed.success) return fail(c, 400, 'bad-request', zodIssues(parsed.error));
    const auth = await authenticate({ db, verify: deps.verify, now: deps.now() }, parsed.data);
    if (!auth.ok) return fail(c, auth.status, auth.code, auth.message);
    const session = sessions.issue(auth.address, deps.now());
    logger.info({ route: '/v1/session' }, 'session issued');
    return c.json(session);
  });

  /* ---- subscribe ---- */

  app.post('/v1/subscriptions', async (c) => {
    const body = await readJson(c);
    if (!body.ok) return fail(c, 400, 'bad-request', 'body is not valid JSON');
    const parsed = subscribeSchema.safeParse(body.value);
    if (!parsed.success) return fail(c, 400, 'bad-request', zodIssues(parsed.error));
    const input = parsed.data;

    const prefs = prefsSchema.safeParse(input.prefs ?? {});
    if (!prefs.success) return fail(c, 400, 'bad-request', `prefs: ${zodIssues(prefs.error)}`);

    let canonicalTarget: string | null = null;
    if (input.channel === 'webpush') {
      const sub = parsePushTarget(input.target);
      if (sub === null) {
        return fail(c, 400, 'target-invalid', 'target: a PushSubscription ({ endpoint, keys: { p256dh, auth } }) with an https push-service endpoint');
      }
      canonicalTarget = JSON.stringify(sub);
    } else if (input.channel === 'email') {
      if (deps.email === null) return fail(c, 400, 'channel-unavailable', 'email alerts are not enabled on this notifier');
      canonicalTarget = parseEmailTarget(input.target);
      if (canonicalTarget === null) return fail(c, 400, 'target-invalid', 'target: an email address');
    } else if (!(input.target === undefined || input.target === null || input.target === '')) {
      return fail(c, 400, 'target-invalid', 'target: omit it for telegram; the chat is linked through GET /v1/telegram/link');
    }

    const auth = await authorize(c, input);
    if (!auth.ok) return fail(c, auth.status, auth.code, auth.message);
    const address = auth.address;
    const now = deps.now();

    if (input.channel === 'telegram') {
      const row = await upsertTelegramPrefs(db, { address, prefs: prefs.data, now });
      logger.info({ route: '/v1/subscriptions', channel: 'telegram', subscriptionId: row.id, inserted: row.inserted }, 'subscription saved');
      return c.json({ id: row.id }, row.inserted ? 201 : 200);
    }

    const target = canonicalTarget as string;
    const sealed = {
      address,
      targetEnc: deps.cipher.encrypt(target, `${input.channel}:${address}`),
      targetHash: deps.cipher.hash(`${input.channel}:${input.channel === 'webpush' ? (JSON.parse(target) as { endpoint: string }).endpoint : target}`),
      prefs: prefs.data,
      now,
    };

    if (input.channel === 'webpush') {
      let row;
      try {
        row = await upsertWebPush(db, sealed);
      } catch (error) {
        if (error instanceof SubscriptionLimitError) return fail(c, 429, 'subscription-limit', 'too many web push subscriptions for this wallet');
        throw error;
      }
      logger.info({ route: '/v1/subscriptions', channel: 'webpush', subscriptionId: row.id, inserted: row.inserted }, 'subscription saved');
      return c.json({ id: row.id }, row.inserted ? 201 : 200);
    }

    // email: double opt-in.
    const email = deps.email as NonNullable<AppDeps['email']>;
    let row;
    try {
      row = await upsertEmailAndClaimConfirmation(db, {
        ...sealed,
        inboxBudgetHash: deps.cipher.hash(`email-inbox-budget:${emailBudgetInbox(target)}`),
        walletBudgetHash: deps.cipher.hash(`email-wallet-budget:${address}`),
        globalBudgetHash: deps.cipher.hash('email-global-budget'),
      });
    } catch (error) {
      if (error instanceof EmailSubscriptionLimitError) return fail(c, 429, 'email-subscription-limit', 'too many email subscriptions for this wallet');
      if (error instanceof EmailSuppressedError) return fail(c, 429, 'email-recipient-rate-limited', 'confirmation emails to this address are unavailable');
      if (error instanceof EmailConfirmationBudgetError) return fail(c, 429, 'email-confirmation-rate-limited', 'too many confirmation emails requested today');
      if (error instanceof EmailRecipientLimitError) return fail(c, 429, 'email-recipient-rate-limited', 'too many confirmation emails to this address today');
      throw error;
    }
    logger.info({ route: '/v1/subscriptions', channel: 'email', subscriptionId: row.id, inserted: row.inserted }, 'subscription saved');
    if (row.due) {
      try {
        await sendWithDeadline(
          email.mailer,
          confirmationMail({ to: target, address, confirmUrl: email.links.confirm(email.tokens.confirmToken(row.id, now)) }),
        );
        logger.info({ channel: 'email', subscriptionId: row.id }, 'email confirmation sent');
      } catch (error) {
        // SMTP may accept a message before the socket times out. Keep both reservations so
        // retrying cannot turn an ambiguous outcome into unlimited confirmation mail.
        const outcome = classifySmtp(error);
        logger.warn({ channel: 'email', subscriptionId: row.id, errorCode: outcome.ok ? 'error' : outcome.code }, 'email confirmation not sent');
        return fail(c, 502, 'email-send-failed', 'the confirmation email could not be sent: try again later');
      }
    }
    return c.json({ id: row.id }, row.inserted ? 201 : 200);
  });

  /* ---- list ---- */

  const targetHint = (row: SubscriptionRow): string | null => {
    if (row.target_enc === null || row.channel === 'telegram') return null;
    try {
      const target = deps.cipher.decrypt(row.target_enc, `${row.channel}:${row.address}`);
      if (row.channel === 'email') return maskEmail(target);
      return new URL((JSON.parse(target) as { endpoint: string }).endpoint).host;
    } catch {
      return null;
    }
  };

  app.get('/v1/subscriptions', async (c) => {
    const auth = await authorize(c, c.req.query());
    if (!auth.ok) return fail(c, auth.status, auth.code, auth.message);
    const rows = await listByAddress(db, auth.address);
    return c.json({
      items: rows.map((row) => ({
        id: row.id,
        channel: row.channel,
        status: row.disabled_at !== null ? 'disabled' : row.verified_at !== null ? 'active' : 'pending',
        target: targetHint(row),
        prefs: readPrefs(row.prefs),
        createdAt: seconds(row.created_at),
        verifiedAt: seconds(row.verified_at),
        disabledAt: seconds(row.disabled_at),
        disabledReason: row.disabled_reason,
      })),
    });
  });

  /* ---- delete ---- */

  app.delete('/v1/subscriptions/:id', async (c) => {
    const query = c.req.query();
    let credentials: unknown = query;
    // The query when it carries the credentials (signature: all three; bearer: the address), else a JSON body.
    const fromQuery =
      bearerToken(c.req.header('authorization')) === undefined ? authSchema.safeParse(query).success : query.address !== undefined;
    if (!fromQuery && (c.req.header('content-type') ?? '').includes('json')) {
      const body = await readJson(c);
      if (body.ok) credentials = body.value;
    }
    const auth = await authorize(c, (credentials ?? {}) as Credentials);
    if (!auth.ok) return fail(c, auth.status, auth.code, auth.message);
    const id = c.req.param('id');
    if (!(await deleteOwned(db, id, auth.address))) return fail(c, 404, 'not-found', 'no such subscription for this address');
    logger.info({ route: '/v1/subscriptions/:id', subscriptionId: id }, 'subscription deleted');
    return c.json({ ok: true });
  });

  /* ---- telegram ---- */

  app.get('/v1/telegram/link', async (c) => {
    const auth = await authorize(c, c.req.query());
    if (!auth.ok) return fail(c, auth.status, auth.code, auth.message);
    const link = await deps.telegram.createLink(auth.address);
    if (link === null) return fail(c, 503, 'channel-unavailable', 'the Telegram bot is not reachable right now: try again shortly');
    return c.json(link);
  });

  /* ---- web push ---- */

  app.get('/v1/webpush/key', (c) => c.json({ publicKey: deps.vapidPublicKey }));

  /* ---- email links ---- */

  const emailOff = (c: Context) =>
    htmlResponse(c, 404, page('Email alerts are off', ['This notifier does not send email.']));

  app.get('/v1/email/confirm', (c) => {
    if (deps.email === null) return emailOff(c);
    const token = c.req.query('token') ?? '';
    if (deps.email.tokens.readConfirmToken(token, deps.now()) === null) {
      return htmlResponse(c, 400, page('Link not valid', ['This confirmation link is not valid or has expired.', `Subscribe again from ${settingsUrl}`]));
    }
    return htmlResponse(
      c,
      200,
      page('Confirm email alerts', ['Press Confirm to receive Stonkhouse alerts at this address.'], {
        action: '/v1/email/confirm',
        token,
        button: 'Confirm',
      }),
    );
  });

  const formToken = async (c: Context): Promise<string> => {
    const fromQuery = c.req.query('token');
    if (fromQuery !== undefined) return fromQuery;
    try {
      const form = await c.req.parseBody();
      return typeof form.token === 'string' ? form.token : '';
    } catch {
      return '';
    }
  };

  app.post('/v1/email/confirm', async (c) => {
    if (deps.email === null) return emailOff(c);
    const id = deps.email.tokens.readConfirmToken(await formToken(c), deps.now());
    if (id === null) {
      return htmlResponse(c, 400, page('Link not valid', ['This confirmation link is not valid or has expired.', `Subscribe again from ${settingsUrl}`]));
    }
    const confirmed = await confirmEmail(db, id, deps.now());
    if (confirmed) logger.info({ channel: 'email', subscriptionId: id }, 'email subscription confirmed');
    const row = confirmed ? null : await getById(db, id);
    if (!confirmed && (row === null || row.disabled_at !== null)) {
      return htmlResponse(c, 404, page('Subscription not found', ['This subscription was removed or turned off.', `Subscribe again from ${settingsUrl}`]));
    }
    return htmlResponse(c, 200, page('Email alerts are on', ['This address will receive the Stonkhouse alerts chosen in Settings.', settingsUrl]));
  });

  app.get('/v1/email/unsubscribe', async (c) => {
    if (deps.email === null) return emailOff(c);
    const token = c.req.query('token') ?? '';
    const id = deps.email.tokens.readUnsubscribeToken(token);
    if (id === null) {
      return htmlResponse(c, 400, page('Link not valid', ['This unsubscribe link is not valid.']));
    }
    const owned = await emailRowBudget(id);
    if (owned?.row.disabled_reason === 'email_unsubscribe') {
      return htmlResponse(c, 200, page('Email alerts are off', ['To allow a new confirmation email, press the button below and then subscribe again from Settings.'], {
        action: '/v1/email/resubscribe', token, button: 'Allow confirmation emails',
      }));
    }
    return htmlResponse(
      c,
      200,
      page('Stop email alerts', ['Press Unsubscribe to stop Stonkhouse alerts to this address.'], {
        action: '/v1/email/unsubscribe',
        token,
        button: 'Unsubscribe',
      }),
    );
  });

  app.post('/v1/email/unsubscribe', async (c) => {
    if (deps.email === null) return emailOff(c);
    const id = deps.email.tokens.readUnsubscribeToken(await formToken(c));
    if (id === null) return htmlResponse(c, 400, page('Link not valid', ['This unsubscribe link is not valid.']));
    const owned = await emailRowBudget(id);
    if (owned === null) return htmlResponse(c, 404, page('Subscription not found', ['This subscription is no longer available.']));
    if (await unsubscribeEmail(db, id, owned.hash, deps.now())) {
      logger.info({ channel: 'email', subscriptionId: id }, 'email subscription unsubscribed');
    }
    return htmlResponse(c, 200, page('Unsubscribed', ['This address will not receive Stonkhouse alerts any more.']));
  });

  app.post('/v1/email/resubscribe', async (c) => {
    if (deps.email === null) return emailOff(c);
    const id = deps.email.tokens.readUnsubscribeToken(await formToken(c));
    if (id === null) return htmlResponse(c, 400, page('Link not valid', ['This link is not valid.']));
    const owned = await emailRowBudget(id);
    if (owned === null || owned.row.disabled_reason !== 'email_unsubscribe') {
      return htmlResponse(c, 404, page('Subscription not found', ['This subscription is no longer available.']));
    }
    await allowEmailConfirmations(db, owned.hash);
    return htmlResponse(c, 200, page('Confirmation emails allowed', ['Subscribe again from Settings to request a new confirmation email.', settingsUrl]));
  });

  return app;
}
