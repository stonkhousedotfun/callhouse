/**
 * Boot-time configuration, validated once, before anything connects or binds.
 *
 * Same stance as relay/src/config.ts: a notifier that starts half-configured finds out on the
 * first alert it cannot send, and that alert is lost. So it refuses to start instead, listing
 * every problem at once. No issue message ever echoes the value it complains about: half of
 * these are credentials, and the other half (DATABASE_URL, SMTP_URL) carry one.
 *
 *   DATABASE_URL         required. postgres:// or postgresql://. The notifier owns schema "notifier".
 *   INDEXER_URL          required. The indexer API (/v2/*) the rules engine polls (N2-02).
 *   RH_RPC               required. Used only to verify ERC-1271 / ERC-6492 wallet signatures.
 *   NOTIFIER_DATA_KEY    required. 32 bytes as 64 hex characters (`openssl rand -hex 32`).
 *                        Encrypts stored targets (AES-256-GCM) and keys the lookup HMACs and the
 *                        email link tokens. Losing it orphans every stored target; rotating it is
 *                        not supported (crypto.ts carries a version prefix for when it is).
 *   TELEGRAM_BOT_TOKEN   required. From @BotFather. It sits in every Bot API path: never logged.
 *   TELEGRAM_API_BASE    default https://api.telegram.org. Exists for the tests' fake Bot API.
 *   VAPID_PUBLIC_KEY     required. base64url, 65-byte uncompressed P-256 point
 *   VAPID_PRIVATE_KEY    required. base64url, 32 bytes. Must be the public key's pair (checked):
 *                        a mismatched pair makes every push service answer 401/403 forever.
 *   VAPID_SUBJECT        optional. mailto: or https:. Default: APP_URL when it is https. Push
 *                        services require one of the two, so an http APP_URL (local dev) needs it.
 *   SMTP_URL             optional. smtp:// or smtps://. Unset = the email channel is off.
 *   EMAIL_FROM           required with SMTP_URL. `Stonkhouse <alerts@example.com>` or a bare address.
 *   NOTIFIER_PUBLIC_URL  required with SMTP_URL. This service's public origin: the double opt-in
 *                        and unsubscribe links in an email point here.
 *   APP_URL              required. The dapp origin. Every message links into it, and it is the
 *                        only origin CORS admits.
 *   PORT                 default 8791. Railway injects it.
 *   RULES_ENABLED        default true. false / 0 turns the rules engine (N2-02) off: the API and
 *                        the delivery worker still run, nothing new is enqueued.
 *   RULES_POLL_S         default 30. Seconds between rules ticks over INDEXER_URL (5-3600).
 *
 * EMAIL_FROM, NOTIFIER_PUBLIC_URL and VAPID_SUBJECT are additional delivery settings: an email
 * needs a sender and an absolute confirmation link, and web-push refuses an http subject.
 * RULES_ENABLED and RULES_POLL_S are operator switches for N2-02.
 *
 * Blank variables count as unset: Railway keeps a variable that was cleared in the UI as "".
 */
import { createECDH } from 'node:crypto';
import { z } from 'zod';

export interface NotifierConfig {
  port: number;
  databaseUrl: string;
  indexerUrl: string;
  rpcUrl: string;
  /** 32 bytes. */
  dataKey: Buffer;
  /** Origin plus optional path, no trailing slash. */
  appUrl: string;
  telegram: { botToken: string; apiBase: string };
  webPush: { publicKey: string; privateKey: string; subject: string };
  email: { smtpUrl: string; from: string; publicUrl: string } | null;
  rules: { enabled: boolean; pollMs: number };
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Notifier configuration is not usable:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

export const DEFAULT_PORT = 8791;
export const DEFAULT_RULES_POLL_S = 30;

const blankIsUnset = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** A URL with one of `protocols`. The message names the problem, never the value. */
const urlWith = (protocols: string[], label: string) =>
  z.string().refine((raw) => {
    try {
      return protocols.includes(new URL(raw).protocol);
    } catch {
      return false;
    }
  }, `must be ${label} (value not shown)`);

const httpUrl = urlWith(['http:', 'https:'], 'an http(s) URL');

function base64urlBytes(raw: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) return null;
  return Buffer.from(raw, 'base64url');
}

const envSchema = z
  .object({
    DATABASE_URL: z.preprocess(blankIsUnset, urlWith(['postgres:', 'postgresql:'], 'a postgres:// URL')),
    INDEXER_URL: z.preprocess(blankIsUnset, httpUrl),
    RH_RPC: z.preprocess(blankIsUnset, httpUrl),
    NOTIFIER_DATA_KEY: z.preprocess(
      blankIsUnset,
      z
        .string({ required_error: 'Required' })
        .regex(/^[0-9a-fA-F]{64}$/, 'must be 32 bytes as 64 hex characters (openssl rand -hex 32)')
        .refine((hex) => !/^0+$/.test(hex), 'must not be all zeros'),
    ),
    TELEGRAM_BOT_TOKEN: z.preprocess(
      blankIsUnset,
      z
        .string({ required_error: 'Required' })
        .regex(/^\d{1,20}:[A-Za-z0-9_-]{20,}$/, 'is not a Bot API token from @BotFather (value not shown)'),
    ),
    TELEGRAM_API_BASE: z.preprocess(blankIsUnset, httpUrl.default('https://api.telegram.org')),
    VAPID_PUBLIC_KEY: z.preprocess(
      blankIsUnset,
      z.string({ required_error: 'Required' }).refine((raw) => {
        const bytes = base64urlBytes(raw);
        return bytes !== null && bytes.length === 65 && bytes[0] === 0x04;
      }, 'must be a base64url uncompressed P-256 public key (65 bytes)'),
    ),
    VAPID_PRIVATE_KEY: z.preprocess(
      blankIsUnset,
      z.string({ required_error: 'Required' }).refine((raw) => {
        const bytes = base64urlBytes(raw);
        return bytes !== null && bytes.length === 32;
      }, 'must be a base64url P-256 private key (32 bytes, value not shown)'),
    ),
    VAPID_SUBJECT: z.preprocess(blankIsUnset, urlWith(['mailto:', 'https:'], 'a mailto: or https: URL').optional()),
    SMTP_URL: z.preprocess(blankIsUnset, urlWith(['smtp:', 'smtps:'], 'an smtp:// or smtps:// URL').optional()),
    EMAIL_FROM: z.preprocess(
      blankIsUnset,
      z
        .string()
        // One address, optionally with a display name, and no line break: this lands in a header.
        .regex(/^[^\r\n<>@]*<[^\s<>@]+@[^\s<>@]+>$|^[^\s<>@]+@[^\s<>@]+$/, 'must be `Name <address>` or a bare address')
        .optional(),
    ),
    NOTIFIER_PUBLIC_URL: z.preprocess(blankIsUnset, httpUrl.optional()),
    APP_URL: z.preprocess(blankIsUnset, httpUrl),
    PORT: z.preprocess(blankIsUnset, z.coerce.number().int().min(0).max(65535).default(DEFAULT_PORT)),
    RULES_ENABLED: z.preprocess(
      (value) => (typeof value === 'string' ? blankIsUnset(value.trim().toLowerCase()) : value),
      z.enum(['true', 'false', '1', '0'], { message: 'must be true or false' }).default('true'),
    ),
    RULES_POLL_S: z.preprocess(blankIsUnset, z.coerce.number().int().min(5).max(3600).default(DEFAULT_RULES_POLL_S)),
  })
  .superRefine((env, ctx) => {
    if (env.SMTP_URL !== undefined) {
      if (env.EMAIL_FROM === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['EMAIL_FROM'], message: 'required when SMTP_URL is set' });
      }
      if (env.NOTIFIER_PUBLIC_URL === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['NOTIFIER_PUBLIC_URL'],
          message: 'required when SMTP_URL is set (confirmation links point at it)',
        });
      }
    } else if (env.EMAIL_FROM !== undefined || env.NOTIFIER_PUBLIC_URL !== undefined) {
      // Half an email setup is a typo in SMTP_URL's name more often than a choice.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_URL'],
        message: 'EMAIL_FROM or NOTIFIER_PUBLIC_URL is set but SMTP_URL is not: set all three or none',
      });
    }
    if (env.VAPID_SUBJECT === undefined && typeof env.APP_URL === 'string') {
      let https = false;
      try {
        https = new URL(env.APP_URL).protocol === 'https:';
      } catch {
        // APP_URL's own issue already reports this.
      }
      if (!https) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['VAPID_SUBJECT'],
          message: 'required when APP_URL is not https (push services accept only mailto: or https:)',
        });
      }
    }
    if (typeof env.VAPID_PUBLIC_KEY === 'string' && typeof env.VAPID_PRIVATE_KEY === 'string') {
      const priv = base64urlBytes(env.VAPID_PRIVATE_KEY);
      const pub = base64urlBytes(env.VAPID_PUBLIC_KEY);
      if (priv !== null && priv.length === 32 && pub !== null && pub.length === 65) {
        let matches = false;
        try {
          const ecdh = createECDH('prime256v1');
          ecdh.setPrivateKey(priv);
          matches = ecdh.getPublicKey().equals(pub);
        } catch {
          matches = false;
        }
        if (!matches) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['VAPID_PRIVATE_KEY'],
            message: 'is not the private key of VAPID_PUBLIC_KEY',
          });
        }
      }
    }
  });

const stripSlash = (url: string): string => url.replace(/\/+$/, '');

export function parseConfig(env: Record<string, string | undefined>): NotifierConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(env)'}: ${issue.message}`),
    );
  }
  const e = result.data;
  const appUrl = stripSlash(e.APP_URL);
  return {
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    indexerUrl: stripSlash(e.INDEXER_URL),
    rpcUrl: e.RH_RPC,
    dataKey: Buffer.from(e.NOTIFIER_DATA_KEY, 'hex'),
    appUrl,
    telegram: { botToken: e.TELEGRAM_BOT_TOKEN, apiBase: stripSlash(e.TELEGRAM_API_BASE) },
    webPush: {
      publicKey: e.VAPID_PUBLIC_KEY,
      privateKey: e.VAPID_PRIVATE_KEY,
      subject: e.VAPID_SUBJECT ?? new URL(appUrl).origin,
    },
    email:
      e.SMTP_URL === undefined || e.EMAIL_FROM === undefined || e.NOTIFIER_PUBLIC_URL === undefined
        ? null
        : { smtpUrl: e.SMTP_URL, from: e.EMAIL_FROM, publicUrl: stripSlash(e.NOTIFIER_PUBLIC_URL) },
    rules: { enabled: e.RULES_ENABLED === 'true' || e.RULES_ENABLED === '1', pollMs: e.RULES_POLL_S * 1000 },
  };
}
