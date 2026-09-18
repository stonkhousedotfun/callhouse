/**
 * Keeper alert → the text a human reads in Discord or Telegram. Pure functions, no I/O.
 *
 * Both renderings lead with the severity, because ops/alerts.md routes on it: an `error` is
 * somebody's pager, an `info` is a record. Then the kind (what the runbook index keys on), the
 * message, one line of context, and `data` as indented JSON.
 *
 * LIMITS, and what gets cut first. Discord refuses `content` over 2000 characters with a 400 —
 * which the keeper would retry every five minutes, forever. Telegram's `text` limit is 4096.
 * The header (severity, kind, message) is kept whole whenever it fits, and `data` is truncated
 * before any of it, with an explicit marker; the header itself is truncated only when it alone
 * is over the limit. JavaScript string length counts UTF-16 code units, which is never fewer
 * than the characters either service counts, so a string that passes here passes there.
 *
 * DISCORD MENTIONS. `allowed_mentions: { parse: [] }` goes on every message: a keeper message
 * that happens to contain `@everyone`, or a role id pulled out of revert data, must not ping a
 * whole server. Telegram is sent as plain text (no parse_mode), so there is nothing to escape and
 * nothing a message can inject.
 */
import type { KeeperAlert, Severity } from './payload.js';

export const DISCORD_CONTENT_LIMIT = 2000;
export const TELEGRAM_TEXT_LIMIT = 4096;

const SEVERITY_MARK: Record<Severity, { emoji: string; label: string }> = {
  error: { emoji: '🔴', label: 'ERROR' },
  warn: { emoji: '🟠', label: 'WARN' },
  info: { emoji: '🔵', label: 'INFO' },
};

const TRUNCATED = '… (truncated)';

/** Cut `text` to at most `max` UTF-16 units, ending in `marker`, without splitting a surrogate pair. */
export function truncate(text: string, max: number, marker = '…'): string {
  if (text.length <= max) return text;
  if (max <= marker.length) return marker.slice(0, Math.max(0, max));
  let end = max - marker.length;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // high surrogate: keep the pair together
  return text.slice(0, end) + marker;
}

function contextLine(alert: KeeperAlert): string {
  return [
    alert.market === undefined ? null : `market ${alert.market}`,
    alert.factory === undefined ? null : `factory ${alert.factory}`,
    alert.vault === undefined || alert.vault === null ? null : `vault ${alert.vault}`,
    alert.chainId === undefined ? null : `chain ${alert.chainId}`,
    alert.at ?? null,
    alert.source ?? null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

function dataJson(alert: KeeperAlert): string | null {
  if (alert.data === undefined || Object.keys(alert.data).length === 0) return null;
  return JSON.stringify(alert.data, null, 2);
}

/**
 * Header + an optional fenced body, fitted to `limit`. The body is what gets cut.
 * Returns the header alone when not even a truncated body would be readable.
 */
function fit(header: string, body: string | null, limit: number, fence: { open: string; close: string }): string {
  const head = truncate(header, limit);
  if (body === null) return head;
  const room = limit - head.length - fence.open.length - fence.close.length;
  const MIN_READABLE_BODY = 32;
  if (room < MIN_READABLE_BODY) {
    const note = '\n(data omitted: message too long)';
    return head.length + note.length <= limit ? head + note : head;
  }
  return head + fence.open + truncate(body, room, `\n${TRUNCATED}`) + fence.close;
}

export interface DiscordBody {
  content: string;
  allowed_mentions: { parse: never[] };
}

export function formatDiscord(alert: KeeperAlert): DiscordBody {
  const mark = SEVERITY_MARK[alert.severity];
  const context = contextLine(alert);
  // Break every backtick in untrusted text. Replacing only runs of three misses overlapping
  // fences in longer runs, including strings quoted from RPC errors in the header.
  const defuseFence = (value: string): string => value.replaceAll('`', '`​');
  const header = `${mark.emoji} **${mark.label}** \`${alert.kind}\` ${defuseFence(alert.message)}${context === '' ? '' : `\n${defuseFence(context)}`}`;
  const json = dataJson(alert);
  const body = json === null ? null : defuseFence(json);
  return {
    content: fit(header, body, DISCORD_CONTENT_LIMIT, { open: '\n```json\n', close: '\n```' }),
    allowed_mentions: { parse: [] },
  };
}

export interface TelegramBody {
  chat_id: string;
  text: string;
  disable_web_page_preview: true;
  disable_notification: boolean;
}

export function formatTelegram(alert: KeeperAlert, chatId: string): TelegramBody {
  const mark = SEVERITY_MARK[alert.severity];
  const context = contextLine(alert);
  const header = `${mark.emoji} ${mark.label} ${alert.kind}\n${alert.message}${context === '' ? '' : `\n${context}`}`;
  return {
    chat_id: chatId,
    text: fit(header, dataJson(alert), TELEGRAM_TEXT_LIMIT, { open: '\n\ndata:\n', close: '' }),
    disable_web_page_preview: true,
    disable_notification: alert.severity === 'info',
  };
}
