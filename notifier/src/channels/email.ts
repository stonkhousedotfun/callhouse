/**
 * Email: optional (off unless SMTP_URL is set), double opt-in, one-click unsubscribe.
 *
 * DOUBLE OPT-IN. A wallet signature proves the wallet, not the inbox: anyone can type anyone's
 * address. So `POST /v1/subscriptions` with channel "email" stores the row UNVERIFIED and mails a
 * confirmation link; nothing else is ever sent to that address until its owner opens the link and
 * presses Confirm (a POST: mail scanners that pre-fetch links must not confirm on their own).
 * Confirmation mails are capped per row, normalized inbox, wallet and service. Unsubscribe
 * suppresses future confirmation mail until the inbox owner explicitly opts back in.
 *
 * LINK TOKENS are stateless: `<subscription id>.<expiry>.<HMAC>` for confirm (24 hours) and
 * `<subscription id>.<HMAC>` for unsubscribe (no expiry: an unsubscribe link in an old email must
 * keep working), each under its own key derived from NOTIFIER_DATA_KEY (crypto.ts `sign`). They
 * point at NOTIFIER_PUBLIC_URL. Every alert carries the unsubscribe link in the body and as
 * List-Unsubscribe / List-Unsubscribe-Post (RFC 8058), which mail clients show as a button.
 *
 * SENDING goes through nodemailer's SMTP transport with connection, greeting and socket timeouts,
 * and an overall deadline around each send. Errors map to outcomes by SMTP reply code: 550/551/553
 * at RCPT TO (no such mailbox) = gone, other 5xx = permanent, 4xx and connection or auth failures = transient
 * (auth failing breaks every send, which is the circuit breaker's business). Only the code is kept:
 * nodemailer's messages quote the server's reply, which quotes the recipient.
 */
import { createTransport } from 'nodemailer';
import { constantTimeEqual, type TargetCipher } from '../crypto.js';
import { shortAddress } from '../format.js';
import { errorCode } from '../log.js';
import type { Links, Rendered } from '../templates.js';
import type { Channel, SendOutcome } from './types.js';

export const SEND_TIMEOUT_MS = 15_000;
export const CONFIRM_TTL_MS = 24 * 3600_000;
export const CONFIRM_RESEND_MS = 10 * 60_000;

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
}

export interface Mailer {
  /** Resolves when the SMTP server accepted the message; rejects otherwise. */
  send(message: MailMessage): Promise<void>;
}

export function smtpMailer(settings: { smtpUrl: string; from: string }): Mailer {
  const transport = createTransport({
    url: settings.smtpUrl,
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
  });
  return {
    async send(message) {
      await transport.sendMail({
        from: settings.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.headers === undefined ? {} : { headers: message.headers }),
      });
    },
  };
}

/** Canonical form of an email target, or null. Lower-cased whole: that is what users mean. */
export function parseEmailTarget(target: unknown): string | null {
  if (typeof target !== 'string') return null;
  const email = target.trim().toLowerCase();
  if (email.length > 254) return null;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(email)
    ? email
    : null;
}

/** Budget identity only: delivery still uses the exact address the user entered. */
export function emailBudgetInbox(email: string): string {
  const [local = '', domain = ''] = email.toLowerCase().split('@');
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${local.split('+', 1)[0]?.replaceAll('.', '')}@gmail.com`;
  }
  return email.toLowerCase();
}

/** "a***@example.com": enough for the owner to recognise, not enough to harvest. */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}***@${domain}`;
}

/* ------------------------------------------------------------------ tokens */

export interface EmailTokens {
  confirmToken(subscriptionId: string, now: Date): string;
  /** The subscription id, or null when the token is forged, malformed or expired. */
  readConfirmToken(token: string, now: Date): string | null;
  unsubscribeToken(subscriptionId: string): string;
  readUnsubscribeToken(token: string): string | null;
}

export function emailTokens(cipher: TargetCipher): EmailTokens {
  return {
    confirmToken(id, now) {
      const expires = Math.floor((now.getTime() + CONFIRM_TTL_MS) / 1000);
      return `${id}.${expires}.${cipher.sign('email-confirm', `${id}.${expires}`)}`;
    },
    readConfirmToken(token, now) {
      const match = /^([0-9a-f-]{36})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (match === null) return null;
      const [, id = '', expires = '', mac = ''] = match;
      if (!constantTimeEqual(mac, cipher.sign('email-confirm', `${id}.${expires}`))) return null;
      return Number(expires) * 1000 > now.getTime() ? id : null;
    },
    unsubscribeToken(id) {
      return `${id}.${cipher.sign('email-unsubscribe', id)}`;
    },
    readUnsubscribeToken(token) {
      const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (match === null) return null;
      const [, id = '', mac = ''] = match;
      return constantTimeEqual(mac, cipher.sign('email-unsubscribe', id)) ? id : null;
    },
  };
}

/* ------------------------------------------------------------------ messages */

export interface EmailLinks {
  confirm(token: string): string;
  unsubscribe(token: string): string;
}

export function emailLinks(publicUrl: string): EmailLinks {
  return {
    confirm: (token) => `${publicUrl}/v1/email/confirm?token=${encodeURIComponent(token)}`,
    unsubscribe: (token) => `${publicUrl}/v1/email/unsubscribe?token=${encodeURIComponent(token)}`,
  };
}

export function confirmationMail(a: { to: string; address: string; confirmUrl: string }): MailMessage {
  return {
    to: a.to,
    subject: 'Confirm Stonkhouse alerts for this address',
    text: [
      `Someone asked for Stonkhouse alerts for wallet ${shortAddress(a.address)} to be sent to this address.`,
      '',
      'To turn them on, open this link and press Confirm. It expires in 24 hours:',
      a.confirmUrl,
      '',
      'If this was not you, ignore this email. Nothing else will be sent.',
    ].join('\n'),
  };
}

export function alertMail(a: { to: string; message: Rendered; settingsUrl: string; unsubscribeUrl: string }): MailMessage {
  return {
    to: a.to,
    subject: a.message.title,
    text: [
      a.message.body,
      '',
      a.message.url,
      '',
      '--',
      `Alert settings: ${a.settingsUrl}`,
      `Stop these emails: ${a.unsubscribeUrl}`,
    ].join('\n'),
    headers: {
      'List-Unsubscribe': `<${a.unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

/* ------------------------------------------------------------------ channel */

export function classifySmtp(error: unknown): SendOutcome {
  const responseCode = (error as { responseCode?: unknown } | null)?.responseCode;
  const command = (error as { command?: unknown } | null)?.command;
  if (typeof responseCode === 'number') {
    const code = `smtp_${responseCode}`;
    if ((responseCode === 550 || responseCode === 551 || responseCode === 553) && command === 'RCPT TO') {
      return { ok: false, kind: 'gone', code };
    }
    if (responseCode >= 500) return { ok: false, kind: 'permanent', code };
    return { ok: false, kind: 'transient', code };
  }
  // The server may have accepted the message before a deadline expired. Retrying that
  // uncertain send can duplicate an alert, so retain the outcome and stop this delivery.
  if (error instanceof Error && error.name === 'TimeoutError') {
    return { ok: false, kind: 'permanent', code: 'smtp_timeout_ambiguous' };
  }
  const code = errorCode(error);
  // EENVELOPE without a reply: nodemailer refused the recipient itself.
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return { ok: false, kind: 'permanent', code };
  return { ok: false, kind: 'transient', code };
}

/** Send with an overall deadline. Rejects with a TimeoutError-named error when it passes. */
export async function sendWithDeadline(mailer: Mailer, message: MailMessage, timeoutMs = SEND_TIMEOUT_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('email send deadline passed');
      error.name = 'TimeoutError';
      reject(error);
    }, timeoutMs);
  });
  try {
    await Promise.race([mailer.send(message), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export function emailChannel(deps: { mailer: Mailer; tokens: EmailTokens; links: Links; emailLinks: EmailLinks }): Channel {
  return {
    name: 'email',
    async send(to, message, context) {
      try {
        await sendWithDeadline(
          deps.mailer,
          alertMail({
            to,
            message,
            settingsUrl: deps.links.settings(),
            unsubscribeUrl: deps.emailLinks.unsubscribe(deps.tokens.unsubscribeToken(context.subscriptionId)),
          }),
        );
        return { ok: true };
      } catch (error) {
        return classifySmtp(error);
      }
    },
  };
}
