/**
 * Boot-time configuration, validated once, before the server binds.
 *
 * Same stance as keeper/src/config.ts: a relay that starts half-configured and discovers it on
 * the first real alert has already lost that alert, so this refuses to start instead. And the
 * same rule about secrets: no issue message ever echoes the value it is complaining about.
 *
 *   RELAY_TOKEN            required. The shared secret the keeper presents. Surrounding
 *                          whitespace is trimmed, as it is in the keeper. ≥ 32 characters;
 *                          generate with `openssl rand -hex 32`.
 *   DISCORD_WEBHOOK_URL    a Discord channel webhook. Its path is the credential.
 *   TELEGRAM_BOT_TOKEN     a Telegram bot token from @BotFather …
 *   TELEGRAM_CHAT_ID       … and the chat it posts into. Both or neither.
 *   TELEGRAM_API_BASE      default https://api.telegram.org. Exists for the tests' fake target.
 *   RELAY_TIMEOUT_MS       per-target deadline, default 5000, at most 9000 — see below.
 *   PORT                   default 8080. Railway injects it.
 *
 * At least one target (Discord, Telegram, or both) is required: a relay with nowhere to send
 * would answer 502 to every alert forever, which is a misconfiguration and should look like one.
 *
 * WHY RELAY_TIMEOUT_MS IS CAPPED AT 9000: keeper/src/alerts.ts aborts its POST after 10 seconds.
 * The targets are called in parallel, so the relay's worst case is one timeout, and it must
 * answer before the keeper gives up — otherwise a delivery that succeeded late is recorded by
 * the keeper as a failure and sent again five minutes later.
 *
 * Blank variables count as unset: Railway keeps a variable that was cleared in the UI as "".
 */
import { z } from 'zod';

export interface RelayConfig {
  token: string;
  discord: { webhookUrl: string } | null;
  telegram: { botToken: string; chatId: string; apiBase: string } | null;
  timeoutMs: number;
  port: number;
}

export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Relay configuration is not usable:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

const blankIsUnset = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** An http(s) URL. The message names the problem, never the value: a webhook URL is a secret. */
const httpUrl = z.string().refine((raw) => {
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}, 'must be an http(s) URL (value not shown)');

const envSchema = z
  .object({
    RELAY_TOKEN: z.preprocess(
      blankIsUnset,
      z
        .string({ required_error: 'Required' })
        .trim()
        .min(32, 'must be at least 32 characters (openssl rand -hex 32)'),
    ),
    DISCORD_WEBHOOK_URL: z.preprocess(blankIsUnset, httpUrl.optional()),
    TELEGRAM_BOT_TOKEN: z.preprocess(blankIsUnset, z.string().optional()),
    TELEGRAM_CHAT_ID: z.preprocess(blankIsUnset, z.string().optional()),
    TELEGRAM_API_BASE: z.preprocess(blankIsUnset, httpUrl.default('https://api.telegram.org')),
    RELAY_TIMEOUT_MS: z.preprocess(
      blankIsUnset,
      z.coerce.number().int().min(100).max(9000).default(5000),
    ),
    PORT: z.preprocess(blankIsUnset, z.coerce.number().int().min(1).max(65535).default(8080)),
  })
  .superRefine((env, ctx) => {
    if ((env.TELEGRAM_BOT_TOKEN === undefined) !== (env.TELEGRAM_CHAT_ID === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['TELEGRAM_BOT_TOKEN'],
        message: 'TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set together',
      });
    }
    if (env.DISCORD_WEBHOOK_URL === undefined && env.TELEGRAM_BOT_TOKEN === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DISCORD_WEBHOOK_URL'],
        message:
          'no target configured: set DISCORD_WEBHOOK_URL, or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, or both',
      });
    }
  });

export function parseConfig(env: Record<string, string | undefined>): RelayConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(env)'}: ${issue.message}`),
    );
  }
  const e = result.data;
  return {
    token: e.RELAY_TOKEN,
    discord: e.DISCORD_WEBHOOK_URL === undefined ? null : { webhookUrl: e.DISCORD_WEBHOOK_URL },
    telegram:
      e.TELEGRAM_BOT_TOKEN === undefined || e.TELEGRAM_CHAT_ID === undefined
        ? null
        : {
            botToken: e.TELEGRAM_BOT_TOKEN,
            chatId: e.TELEGRAM_CHAT_ID,
            apiBase: e.TELEGRAM_API_BASE.replace(/\/+$/, ''),
          },
    timeoutMs: e.RELAY_TIMEOUT_MS,
    port: e.PORT,
  };
}
