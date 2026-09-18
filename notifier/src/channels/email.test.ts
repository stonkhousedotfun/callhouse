/**
 * Email, end to end through the API with SMTP configured and a recording mailer.
 *
 * WHAT IS PINNED:
 *   - double opt-in: a new address is pending, gets exactly one confirmation mail, receives nothing
 *     else until its owner POSTs the confirm form (a GET, as a link scanner does, confirms nothing);
 *   - confirmation mails to one row are throttled to one per 10 minutes, and links expire in 24 h;
 *   - every alert carries an unsubscribe link and List-Unsubscribe headers, and the one-click POST
 *     disables the subscription; subscribing again needs a fresh opt-in;
 *   - SMTP replies map to gone / permanent / transient; sends have a deadline;
 *   - no log line carries the email address.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { startNotifier, type RunningNotifier } from '../app.js';
import { createSignatureVerifier } from '../auth.js';
import { createTargetCipher } from '../crypto.js';
import { dedupeKey } from '../delivery.js';
import { MAX_EMAIL_CONFIRMATIONS_GLOBAL_DAY, MAX_EMAIL_CONFIRMATIONS_PER_DAY } from '../store.js';
import {
  browserSubscription,
  captureLogger,
  createTestDb,
  SAMPLE_PAYLOADS,
  SERIES_221,
  TEST_DATA_KEY_HEX,
  testConfig,
  TestClock,
  type TestDb,
} from '../testing.js';
import {
  CONFIRM_RESEND_MS,
  CONFIRM_TTL_MS,
  classifySmtp,
  emailBudgetInbox,
  emailTokens,
  maskEmail,
  parseEmailTarget,
  sendWithDeadline,
  type MailMessage,
  type Mailer,
} from './email.js';

const APP_URL = 'https://app.stonkhouse.test';
const PUBLIC_URL = 'https://notifier.stonkhouse.test';
const EMAIL = 'Holder.Person@Example.com';
const alice = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');

class RecordingMailer implements Mailer {
  sent: MailMessage[] = [];
  failWith: unknown = null;
  acceptBeforeFailure = false;
  async send(message: MailMessage): Promise<void> {
    if (this.acceptBeforeFailure) this.sent.push(message);
    if (this.failWith !== null) throw this.failWith;
    if (!this.acceptBeforeFailure) this.sent.push(message);
  }
}

let db: TestDb;
let notifier: RunningNotifier;
const mailer = new RecordingMailer();
const clock = new TestClock();
const log = captureLogger();

before(async () => {
  db = await createTestDb();
  notifier = await startNotifier(
    testConfig({
      APP_URL,
      SMTP_URL: 'smtps://user:SECRET-SMTP@smtp.stonkhouse.test:465',
      EMAIL_FROM: 'Stonkhouse <alerts@stonkhouse.test>',
      NOTIFIER_PUBLIC_URL: PUBLIC_URL,
    }),
    {
      db,
      now: clock.now,
      logger: log.logger,
      verify: createSignatureVerifier({ verifyMessage: async () => false }),
      mailer,
      telegramApi: { call: async () => ({ ok: false, status: 500, code: 'http_500', description: null }) },
      listen: false,
    },
  );
});
after(async () => {
  await notifier.close();
  const text = log.lines.join('\n');
  assert.ok(log.lines.length >= 5);
  for (const secret of [EMAIL, EMAIL.toLowerCase(), 'SECRET-SMTP', alice.address]) {
    assert.ok(!text.includes(secret), `log output leaked ${secret}`);
  }
});
beforeEach(async () => {
  await db.reset();
  clock.ms = Date.parse('2026-09-16T21:00:00Z');
  mailer.sent = [];
  mailer.failWith = null;
  mailer.acceptBeforeFailure = false;
});

function request(path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return notifier.app.request(path, { method: init.method ?? 'GET', ...(init.body === undefined ? {} : { body: init.body }), headers: init.headers ?? {} });
}

async function credentials() {
  const res = await request('/v1/challenge', { method: 'POST', body: JSON.stringify({ address: alice.address }), headers: { 'content-type': 'application/json' } });
  const { message, nonce } = (await res.json()) as { message: string; nonce: string };
  return { address: alice.address, signature: await alice.signMessage({ message }), nonce };
}

async function subscribe(target: unknown = EMAIL) {
  return request('/v1/subscriptions', {
    method: 'POST',
    body: JSON.stringify({ ...(await credentials()), channel: 'email', target }),
    headers: { 'content-type': 'application/json' },
  });
}

async function list() {
  const q = new URLSearchParams(await credentials()).toString();
  return ((await (await request(`/v1/subscriptions?${q}`)).json()) as { items: { id: string; status: string; target: string }[] }).items;
}

const enqueueFill = (bucket: number) =>
  notifier.delivery.enqueue('fill_receipt', alice.address, SAMPLE_PAYLOADS.fill_receipt, dedupeKey('fill_receipt', alice.address, SERIES_221.longId, bucket));

const tokenFrom = (text: string, route: string): string => {
  const match = new RegExp(`${PUBLIC_URL}${route}\\?token=([^\\s]+)`).exec(text);
  assert.ok(match, `no ${route} link in: ${text}`);
  return decodeURIComponent(match[1] ?? '');
};

const form = (token: string) => ({
  method: 'POST',
  body: new URLSearchParams({ token }).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
});

test('double opt-in: pending, one confirmation mail, nothing delivered until the Confirm form is posted', async () => {
  const res = await subscribe();
  assert.equal(res.status, 201);
  const [row] = await list();
  assert.deepEqual([row?.status, row?.target], ['pending', 'h***@example.com']);

  assert.equal(mailer.sent.length, 1);
  const confirmation = mailer.sent[0] as MailMessage;
  assert.equal(confirmation.to, 'holder.person@example.com');
  assert.equal(confirmation.subject, 'Confirm Stonkhouse alerts for this address');
  assert.ok(confirmation.text.includes('0xf39F…2266'));
  const token = tokenFrom(confirmation.text, '/v1/email/confirm');

  assert.deepEqual(await enqueueFill(1), { queued: 0, duplicates: 0, filtered: 0 });

  // A GET (what a mail scanner does) shows the button and confirms nothing.
  const page = await request(`/v1/email/confirm?token=${encodeURIComponent(token)}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('<form method="post" action="/v1/email/confirm">'));
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await list())[0]?.status, 'pending');

  const confirmed = await request('/v1/email/confirm', form(token));
  assert.equal(confirmed.status, 200);
  assert.ok((await confirmed.text()).includes('Email alerts are on'));
  assert.equal((await list())[0]?.status, 'active');
  // Confirming twice is harmless.
  assert.equal((await request('/v1/email/confirm', form(token))).status, 200);

  assert.deepEqual(await enqueueFill(1), { queued: 1, duplicates: 0, filtered: 0 });
  await notifier.delivery.runOnce();
  const alert = mailer.sent[1] as MailMessage;
  assert.equal(alert.subject, 'Bought NVDA 221.00 call');
  assert.ok(alert.text.startsWith('You bought 0.50 shares'));
  assert.ok(alert.text.includes(`Alert settings: ${APP_URL}/settings/notifications`));
  const unsubscribe = tokenFrom(alert.text, '/v1/email/unsubscribe');
  assert.equal(alert.headers?.['List-Unsubscribe'], `<${PUBLIC_URL}/v1/email/unsubscribe?token=${encodeURIComponent(unsubscribe)}>`);
  assert.equal(alert.headers?.['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');

  // RFC 8058 one-click: POST to the URL with the token in the query.
  const one = await request(`/v1/email/unsubscribe?token=${encodeURIComponent(unsubscribe)}`, {
    method: 'POST',
    body: 'List-Unsubscribe=One-Click',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(one.status, 200);
  assert.equal((await list())[0]?.status, 'disabled');
  assert.deepEqual(await enqueueFill(2), { queued: 0, duplicates: 0, filtered: 0 });

  // A wallet cannot restart confirmation mail after the inbox owner unsubscribes.
  assert.equal((await subscribe()).status, 429);
  assert.equal(mailer.sent.length, 2);
  const optInPage = await request(`/v1/email/unsubscribe?token=${encodeURIComponent(unsubscribe)}`);
  assert.ok((await optInPage.text()).includes('action="/v1/email/resubscribe"'));
  assert.equal((await subscribe()).status, 429, 'a GET does not opt the inbox back in');
  assert.equal((await request('/v1/email/resubscribe', form(`${unsubscribe}broken`))).status, 400);
  assert.equal((await request('/v1/email/resubscribe', form(unsubscribe))).status, 200);
  assert.equal((await subscribe()).status, 200);
  assert.equal((await list())[0]?.status, 'pending');
  assert.equal(mailer.sent.length, 3);
  assert.ok(mailer.sent[2]?.subject.startsWith('Confirm'));
});

test('confirmation mails are throttled to one per 10 minutes per subscription', async () => {
  await subscribe();
  await subscribe(EMAIL.toLowerCase());
  assert.equal(mailer.sent.length, 1, 'the same address in another case is the same subscription');
  clock.advance(CONFIRM_RESEND_MS);
  await subscribe();
  assert.equal(mailer.sent.length, 2);
  assert.equal((await list()).length, 1);
});

test('different wallets share a recipient-wide confirmation budget', async () => {
  const wallets = [
    alice,
    ...[1, 2, 3].map((n) => privateKeyToAccount(`0x${n.toString(16).padStart(64, '0')}`)),
  ];
  for (const [i, wallet] of wallets.entries()) {
    const challenge = await request('/v1/challenge', {
      method: 'POST', body: JSON.stringify({ address: wallet.address }), headers: { 'content-type': 'application/json' },
    });
    const { message, nonce } = (await challenge.json()) as { message: string; nonce: string };
    const res = await request('/v1/subscriptions', {
      method: 'POST',
      body: JSON.stringify({ address: wallet.address, signature: await wallet.signMessage({ message }), nonce, channel: 'email', target: EMAIL }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, i < MAX_EMAIL_CONFIRMATIONS_PER_DAY ? 201 : 429);
    if (i === MAX_EMAIL_CONFIRMATIONS_PER_DAY) {
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'email-recipient-rate-limited');
    }
  }
  assert.equal(mailer.sent.length, MAX_EMAIL_CONFIRMATIONS_PER_DAY);
  const { rows } = await db.query<{ attempts: number }>('SELECT max(attempts)::int AS attempts FROM notifier.email_confirmation_budget');
  assert.equal(rows[0]?.attempts, MAX_EMAIL_CONFIRMATIONS_PER_DAY);
  const subscriptions = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM notifier.subscription WHERE channel = 'email'`);
  assert.equal(subscriptions.rows[0]?.n, MAX_EMAIL_CONFIRMATIONS_PER_DAY, 'rejected wallets must not leave pending rows');
});

test('the global confirmation budget rejects a send before creating a pending row', async () => {
  const cipher = createTargetCipher(Buffer.from(TEST_DATA_KEY_HEX, 'hex'));
  await db.query(
    `INSERT INTO notifier.email_confirmation_budget (target_hash, day_index, attempts) VALUES ($1, $2, $3)`,
    [cipher.hash('email-global-budget'), Math.floor(clock.ms / 86_400_000), MAX_EMAIL_CONFIRMATIONS_GLOBAL_DAY],
  );
  const response = await subscribe();
  assert.equal(response.status, 429);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'email-confirmation-rate-limited');
  assert.equal(mailer.sent.length, 0);
  assert.equal((await db.query('SELECT 1 FROM notifier.subscription WHERE channel = \'email\'')).rows.length, 0);
});

test('links: forged, expired and unknown tokens are refused', async () => {
  await subscribe();
  const token = tokenFrom(mailer.sent[0]?.text ?? '', '/v1/email/confirm');
  const forged = `${token.slice(0, -2)}${token.endsWith('AA') ? 'BB' : 'AA'}`;
  assert.equal((await request('/v1/email/confirm', form(forged))).status, 400);
  assert.equal((await request(`/v1/email/confirm?token=${encodeURIComponent(forged)}`)).status, 400);
  assert.equal((await request('/v1/email/unsubscribe', form('nope'))).status, 400);
  clock.advance(CONFIRM_TTL_MS);
  assert.equal((await request('/v1/email/confirm', form(token))).status, 400);
  assert.equal((await list())[0]?.status, 'pending');

  // A valid token for a subscription that was deleted meanwhile.
  const tokens = emailTokens(createTargetCipher(Buffer.from(TEST_DATA_KEY_HEX, 'hex')));
  const ghost = tokens.confirmToken('00000000-0000-4000-8000-000000000000', clock.now());
  assert.equal((await request('/v1/email/confirm', form(ghost))).status, 404);
});

test('an SMTP failure returns 502 and keeps its reservation until the resend window', async () => {
  mailer.failWith = Object.assign(new Error('Connection timeout to smtp.stonkhouse.test for holder.person@example.com'), { code: 'ETIMEDOUT' });
  const res = await subscribe();
  assert.equal(res.status, 502);
  assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'email-send-failed');
  mailer.failWith = null;
  assert.equal((await subscribe()).status, 200);
  assert.equal(mailer.sent.length, 0);
  clock.advance(CONFIRM_RESEND_MS);
  assert.equal((await subscribe()).status, 200);
  assert.equal(mailer.sent.length, 1);
});

test('an SMTP timeout after acceptance still consumes the recipient budget', async () => {
  mailer.acceptBeforeFailure = true;
  const timeout = new Error('SMTP accepted the message, then its response timed out');
  timeout.name = 'TimeoutError';
  mailer.failWith = timeout;
  for (let i = 0; i < MAX_EMAIL_CONFIRMATIONS_PER_DAY; i += 1) {
    if (i > 0) clock.advance(CONFIRM_RESEND_MS);
    assert.equal((await subscribe()).status, 502);
  }
  assert.equal(mailer.sent.length, MAX_EMAIL_CONFIRMATIONS_PER_DAY, 'SMTP may have accepted every ambiguous attempt');
  clock.advance(CONFIRM_RESEND_MS);
  const limited = await subscribe();
  assert.equal(limited.status, 429);
  assert.equal(((await limited.json()) as { error: { code: string } }).error.code, 'email-recipient-rate-limited');
  assert.equal(mailer.sent.length, MAX_EMAIL_CONFIRMATIONS_PER_DAY);
  const { rows } = await db.query<{ attempts: number }>('SELECT attempts FROM notifier.email_confirmation_budget');
  assert.equal(rows[0]?.attempts, MAX_EMAIL_CONFIRMATIONS_PER_DAY);
});

test('an invalid address is refused, and email does not accept a push subscription', async () => {
  for (const bad of ['not-an-email', 'a@b', 'x@-bad-.com', browserSubscription('https://fcm.googleapis.com/x')]) {
    const res = await subscribe(bad);
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'target-invalid');
  }
  assert.equal(mailer.sent.length, 0);
});

test('SMTP outcomes, targets and the send deadline', async () => {
  assert.deepEqual(classifySmtp(Object.assign(new Error('x'), { responseCode: 550, command: 'RCPT TO' })), { ok: false, kind: 'gone', code: 'smtp_550' });
  assert.deepEqual(classifySmtp(Object.assign(new Error('x'), { responseCode: 550, command: 'MAIL FROM' })), { ok: false, kind: 'permanent', code: 'smtp_550' });
  assert.deepEqual(classifySmtp(Object.assign(new Error('x'), { responseCode: 550 })), { ok: false, kind: 'permanent', code: 'smtp_550' });
  assert.deepEqual(classifySmtp(Object.assign(new Error('x'), { name: 'TimeoutError' })), { ok: false, kind: 'permanent', code: 'smtp_timeout_ambiguous' });
  assert.deepEqual(classifySmtp(Object.assign(new Error('x'), { responseCode: 554 })), { ok: false, kind: 'permanent', code: 'smtp_554' });
  assert.deepEqual(classifySmtp(Object.assign(new Error('x'), { responseCode: 421 })), { ok: false, kind: 'transient', code: 'smtp_421' });
  assert.deepEqual(classifySmtp(Object.assign(new Error('x'), { code: 'ECONNECTION' })), { ok: false, kind: 'transient', code: 'ECONNECTION' });
  assert.deepEqual(classifySmtp(Object.assign(new Error('x'), { code: 'EAUTH' })), { ok: false, kind: 'transient', code: 'EAUTH' });
  assert.deepEqual(classifySmtp(Object.assign(new Error('x'), { code: 'EENVELOPE' })), { ok: false, kind: 'permanent', code: 'EENVELOPE' });

  assert.equal(parseEmailTarget('  Someone@Example.COM '), 'someone@example.com');
  assert.equal(parseEmailTarget('a b@example.com'), null);
  assert.equal(parseEmailTarget(42), null);
  assert.equal(emailBudgetInbox('First.Last+promo@googlemail.com'), 'firstlast@gmail.com');
  assert.equal(emailBudgetInbox('firstlast@gmail.com'), 'firstlast@gmail.com');
  assert.equal(emailBudgetInbox('first.last+promo@example.com'), 'first.last+promo@example.com');
  assert.equal(maskEmail('someone@example.com'), 's***@example.com');

  const hanging: Mailer = { send: () => new Promise(() => undefined) };
  const started = Date.now();
  await assert.rejects(sendWithDeadline(hanging, { to: 'a@b.co', subject: 's', text: 't' }, 100), (error: Error) => error.name === 'TimeoutError');
  assert.ok(Date.now() - started < 2_000);
});
