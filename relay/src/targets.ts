/**
 * The two destinations, each a JSON POST with a deadline. One 429 retry is allowed when the
 * platform's requested wait fits within that same deadline.
 *
 *   Discord   POST <DISCORD_WEBHOOK_URL>                         { content, allowed_mentions }
 *             2xx (204 by default) = accepted. 400 = our body is wrong. 429 = rate limited.
 *   Telegram  POST <TELEGRAM_API_BASE>/bot<TOKEN>/sendMessage     { chat_id, text, … }
 *             200 with { ok: true } = accepted. Anything else carries { ok: false, description }.
 *
 * A delivery NEVER throws. It resolves to { target, ok, status, error } and the server decides
 * what the keeper hears. That is what makes "2xx only if at least one target accepted" a single
 * `some()` rather than a try/catch per target.
 *
 * SECRETS. Both URLs are credentials — Discord's in the path, Telegram's as `bot<TOKEN>`. So a
 * failure is reported as a target name, an HTTP status and an error CODE (`timeout`,
 * `ECONNREFUSED`, …), never as `String(error)`: undici's messages and causes can carry the
 * address it was dialling, and a future version could carry the path. Response bodies are read
 * only to free the socket, and never logged or returned — Discord's 400 body echoes our content.
 */
import { formatDiscord, formatTelegram } from './format.js';
import type { RelayConfig } from './config.js';
import type { KeeperAlert } from './payload.js';

export type TargetName = 'discord' | 'telegram';

export interface DeliveryResult {
  target: TargetName;
  ok: boolean;
  /** The target's HTTP status, or null when no response arrived. */
  status: number | null;
  /** A short, secret-free code when not ok: `http_<status>`, `timeout`, `ECONNREFUSED`, … */
  error?: string;
}

export interface Target {
  name: TargetName;
  deliver(alert: KeeperAlert): Promise<DeliveryResult>;
}

/** A secret-free code for a failed fetch. Never the message. */
export function errorCode(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return 'timeout';
    const cause = (error as { cause?: unknown }).cause;
    if (cause !== null && typeof cause === 'object') {
      const code = (cause as { code?: unknown }).code;
      if (typeof code === 'string' && /^[A-Z0-9_]{2,40}$/.test(code)) return code;
    }
    return /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : 'error';
  }
  return 'error';
}

/** Delay requested by a 429, in milliseconds. Discord uses a float; Telegram uses seconds. */
function retryAfterMs(target: TargetName, header: string | null, json: unknown): number | null {
  const delays: number[] = [];
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) delays.push(seconds * 1000);
    else {
      const date = Date.parse(header);
      if (Number.isFinite(date)) delays.push(Math.max(0, date - Date.now()));
    }
  }
  if (json !== null && typeof json === 'object') {
    const body = json as { retry_after?: unknown; parameters?: { retry_after?: unknown } };
    const seconds = target === 'discord' ? body.retry_after : body.parameters?.retry_after;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) delays.push(seconds * 1000);
  }
  return delays.length === 0 ? null : Math.max(...delays);
}

async function postJson(
  target: TargetName,
  url: string,
  body: unknown,
  timeoutMs: number,
  accept: (status: number, json: unknown) => boolean,
): Promise<DeliveryResult> {
  const deadline = performance.now() + timeoutMs;
  const payload = JSON.stringify(body);
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remaining = deadline - performance.now();
      if (remaining <= 0) return { target, ok: false, status: null, error: 'timeout' };
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(Math.max(1, Math.ceil(remaining))),
        redirect: 'error',
      });
      let json: unknown = null;
      try {
        const text = await response.text();
        json = text === '' ? null : JSON.parse(text);
      } catch {
        json = null;
      }
      if (accept(response.status, json)) return { target, ok: true, status: response.status };
      if (response.status === 429 && attempt === 0) {
        const delay = retryAfterMs(target, response.headers.get('retry-after'), json);
        // Leave a little time for the second request and its response. Never extend the
        // keeper-facing deadline, and never retry indefinitely on repeated 429s.
        if (delay !== null && delay + 50 < deadline - performance.now()) {
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
          continue;
        }
      }
      return { target, ok: false, status: response.status, error: `http_${response.status}` };
    }
    return { target, ok: false, status: null, error: 'error' };
  } catch (error) {
    return { target, ok: false, status: null, error: errorCode(error) };
  }
}

export function discordTarget(webhookUrl: string, timeoutMs: number): Target {
  return {
    name: 'discord',
    deliver: (alert) =>
      postJson('discord', webhookUrl, formatDiscord(alert), timeoutMs, (status) => status >= 200 && status < 300),
  };
}

export function telegramTarget(
  settings: { botToken: string; chatId: string; apiBase: string },
  timeoutMs: number,
): Target {
  const url = `${settings.apiBase}/bot${settings.botToken}/sendMessage`;
  return {
    name: 'telegram',
    deliver: (alert) =>
      postJson(
        'telegram',
        url,
        formatTelegram(alert, settings.chatId),
        timeoutMs,
        (status, json) =>
          status >= 200 &&
          status < 300 &&
          json !== null &&
          typeof json === 'object' &&
          (json as { ok?: unknown }).ok === true,
      ),
  };
}

export function targetsFromConfig(config: RelayConfig): Target[] {
  const targets: Target[] = [];
  if (config.discord !== null) targets.push(discordTarget(config.discord.webhookUrl, config.timeoutMs));
  if (config.telegram !== null) targets.push(telegramTarget(config.telegram, config.timeoutMs));
  return targets;
}
