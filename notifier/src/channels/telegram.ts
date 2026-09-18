/**
 * Telegram: the Bot API client, the delivery channel, and the bot that links chats to wallets.
 *
 * LINKING. The dapp asks for `GET /v1/telegram/link` (wallet-signed) and gets
 * `https://t.me/<bot>?start=<token>`. Opening it makes Telegram send `/start <token>` to the bot,
 * which consumes the token (single use, 15 minutes) and binds that chat to the wallet. The bot
 * therefore learns the chat id from Telegram itself: nobody can type someone else's chat id into
 * the API and have alerts sent there. The bot's username comes from getMe at boot.
 *
 *   /start <token>   link the chat to the token's wallet (re-enables it after /stop)
 *   /stop            turn alerts off for every wallet linked to this chat
 *   /status          list the wallets linked to this chat and what they send
 *
 * UPDATES are read by long-polling getUpdates in-process: no webhook, so no public endpoint and no
 * webhook secret to manage, and one replica (railway.json) is the only poller. Offsets are kept in
 * memory; after a restart Telegram re-sends only updates that were never confirmed, and every
 * command is safe to see twice (a consumed token just answers "expired").
 *
 * SECRETS. The bot token is in every request path, so nothing here logs a URL or an error message:
 * failures are an HTTP status and a code, as in relay/src/targets.ts. Chat ids are targets and are
 * never logged either; lines carry subscription ids.
 */
import type { Db } from '../db.js';
import type { TargetCipher } from '../crypto.js';
import { randomToken, sha256Hex } from '../crypto.js';
import { shortAddress } from '../format.js';
import { errorCode, type Logger } from '../log.js';
import { DEFAULT_PREFS, readPrefs } from '../prefs.js';
import {
  consumeTelegramLink,
  disableTelegramChat,
  insertTelegramLink,
  linkTelegramChat,
  telegramByChat,
} from '../store.js';
import type { Links, Rendered } from '../templates.js';
import { retryAfterMs, type Channel, type SendOutcome } from './types.js';

export const SEND_TIMEOUT_MS = 5_000;
export const LINK_TTL_MS = 15 * 60_000;
const TEXT_LIMIT = 4096;

/* ------------------------------------------------------------------ Bot API client */

export type TelegramResult<T> =
  | { ok: true; result: T }
  | { ok: false; status: number | null; code: string; description: string | null; retryAfterS?: number };

interface BotReply {
  ok?: unknown;
  result?: unknown;
  description?: unknown;
  parameters?: { retry_after?: unknown };
}

export interface TelegramApi {
  call<T>(method: string, body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<TelegramResult<T>>;
}

export function createTelegramApi(settings: { botToken: string; apiBase: string }): TelegramApi {
  return {
    async call<T>(method: string, body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) {
      const url = `${settings.apiBase}/bot${settings.botToken}/${method}`;
      const deadline = AbortSignal.timeout(timeoutMs);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: signal === undefined ? deadline : AbortSignal.any([deadline, signal]),
          redirect: 'error',
        });
        let json: BotReply | null = null;
        try {
          const text = await response.text();
          json = text === '' ? null : (JSON.parse(text) as BotReply);
        } catch {
          json = null;
        }
        if (response.ok && json !== null && json.ok === true) return { ok: true, result: json.result as T };
        const retry = json?.parameters?.retry_after;
        return {
          ok: false,
          status: response.status,
          code: `http_${response.status}`,
          // Kept to classify the failure (blocked vs. chat not found). Never logged.
          description: typeof json?.description === 'string' ? json.description.slice(0, 200) : null,
          ...(typeof retry === 'number' ? { retryAfterS: retry } : {}),
        };
      } catch (error) {
        return { ok: false, status: null, code: errorCode(error), description: null };
      }
    },
  };
}

/* ------------------------------------------------------------------ delivery channel */

export function formatTelegram(message: Rendered, settingsUrl: string): string {
  const footer = `\n\n${message.url}\n\nAlert settings: ${settingsUrl}`;
  const head = `${message.title}\n\n`;
  const room = TEXT_LIMIT - head.length - footer.length;
  const body = message.body.length > room ? `${message.body.slice(0, Math.max(0, room - 1))}…` : message.body;
  return `${head}${body}${footer}`;
}

/** Map a failed Bot API call to what the worker should do with it. */
export function classifyTelegram(result: Extract<TelegramResult<unknown>, { ok: false }>): SendOutcome {
  const { status, code } = result;
  const description = result.description ?? '';
  if (status === null || status >= 500) return { ok: false, kind: 'transient', code };
  if (status === 429) {
    const after = retryAfterMs(result.retryAfterS);
    return after === undefined ? { ok: false, kind: 'transient', code } : { ok: false, kind: 'transient', code, retryAfterMs: after };
  }
  // Blocked by the user, kicked from the group, account deleted: the chat does not want us.
  if (status === 403) return { ok: false, kind: 'gone', code };
  if (status === 400 && /chat not found|user not found|chat was upgraded|bot was kicked|not enough rights/i.test(description)) {
    return { ok: false, kind: 'gone', code };
  }
  // 401 (revoked token) and 404 (wrong API base) break every send, not this one: let the breaker see them.
  if (status === 401 || status === 404) return { ok: false, kind: 'transient', code };
  return { ok: false, kind: 'permanent', code };
}

export function telegramChannel(api: TelegramApi, links: Links): Channel {
  return {
    name: 'telegram',
    async send(chatId, message) {
      const result = await api.call(
        'sendMessage',
        { chat_id: chatId, text: formatTelegram(message, links.settings()), link_preview_options: { is_disabled: true } },
        SEND_TIMEOUT_MS,
      );
      return result.ok ? { ok: true } : classifyTelegram(result);
    },
  };
}

/* ------------------------------------------------------------------ bot */

interface TelegramUpdate {
  update_id: number;
  message?: { text?: string; chat?: { id?: number | string; type?: string } };
}

const PREF_LABELS: Record<string, string> = {
  fills: 'fills',
  settlement: 'settlements and payouts',
  strikeCross: 'strike crosses',
  expiry24h: 'expiry in 24 hours',
  expiry1h: 'expiry in 1 hour',
  writerItmWarning: 'writer warnings',
  autoRoll: 'auto-roll',
};

export interface TelegramBotDeps {
  api: TelegramApi;
  db: Db;
  cipher: TargetCipher;
  links: Links;
  logger: Logger;
  now: () => Date;
  /** getUpdates long-poll seconds. 25 in production; the tests use 0. */
  pollTimeoutS?: number;
}

export class TelegramBot {
  private botUsername: string | null = null;
  private offset = 0;
  private running = false;
  private abort: AbortController | null = null;
  private loop: Promise<void> | null = null;

  constructor(private readonly deps: TelegramBotDeps) {}

  get username(): string | null {
    return this.botUsername;
  }

  /** getMe, for the deep-link username. Returns whether it is known. */
  async refreshIdentity(signal?: AbortSignal): Promise<boolean> {
    const result = await this.deps.api.call<{ username?: unknown }>('getMe', {}, SEND_TIMEOUT_MS, signal);
    if (result.ok && typeof result.result.username === 'string' && /^[A-Za-z0-9_]{3,64}$/.test(result.result.username)) {
      this.botUsername = result.result.username;
      return true;
    }
    if (!result.ok) this.deps.logger.warn({ channel: 'telegram', status: result.status, errorCode: result.code }, 'telegram getMe failed');
    return false;
  }

  /**
   * Issue a deep link for `address` (already authenticated by the caller). Null while the bot's
   * username is unknown (getMe has not succeeded yet).
   */
  async createLink(address: string): Promise<{ deepLink: string; expiresAt: number } | null> {
    if (this.botUsername === null && !(await this.refreshIdentity())) return null;
    const token = randomToken();
    const now = this.deps.now();
    const expiresAt = new Date(now.getTime() + LINK_TTL_MS);
    await this.deps.db.transaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('telegram-link:' || $1))`, [address]);
      await insertTelegramLink(tx, { tokenHash: sha256Hex(token), address, now, expiresAt });
    });
    return {
      deepLink: `https://t.me/${this.botUsername}?start=${token}`,
      expiresAt: Math.floor(expiresAt.getTime() / 1000),
    };
  }

  private async reply(chatId: string, text: string): Promise<void> {
    const result = await this.deps.api.call(
      'sendMessage',
      { chat_id: chatId, text, link_preview_options: { is_disabled: true } },
      SEND_TIMEOUT_MS,
    );
    if (!result.ok) this.deps.logger.warn({ channel: 'telegram', status: result.status, errorCode: result.code }, 'telegram reply failed');
  }

  private chatHash(chatId: string): string {
    return this.deps.cipher.hash(`telegram:${chatId}`);
  }

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const text = update.message?.text;
    const rawChat = update.message?.chat?.id;
    if (typeof text !== 'string' || (typeof rawChat !== 'number' && typeof rawChat !== 'string')) return;
    const chatId = String(rawChat);
    if (!/^-?\d{1,20}$/.test(chatId)) return;
    const privateChat = update.message?.chat?.type === 'private';

    const [head = '', arg] = text.trim().split(/\s+/, 2);
    // In groups, Telegram may deliver commands addressed to another bot. Ignore those entirely.
    const [command, addressedTo] = head.toLowerCase().split('@', 2);
    if (addressedTo !== undefined && addressedTo !== this.botUsername?.toLowerCase()) return;
    const settings = this.deps.links.settings();

    switch (command) {
      case '/start':
        if (arg !== undefined && /^[A-Za-z0-9_-]{16,64}$/.test(arg)) {
          await this.link(chatId, arg, settings);
          return;
        }
        await this.reply(chatId, this.help(settings));
        return;
      case '/stop':
        await this.stopChat(chatId, settings);
        return;
      case '/status':
        await this.status(chatId, settings);
        return;
      default:
        // In a group the bot sees commands meant for other bots; answer only people talking to it.
        if (privateChat) await this.reply(chatId, this.help(settings));
    }
  }

  private help(settings: string): string {
    return [
      'This bot sends Stonkhouse alerts for wallets you link from the app.',
      `Link a wallet and choose alerts in Settings: ${settings}`,
      'Send /status to see linked wallets, or /stop to turn alerts off for this chat.',
    ].join('\n');
  }

  private async link(chatId: string, token: string, settings: string): Promise<void> {
    const { db, cipher, now } = this.deps;
    const at = now();
    const linked = await db.transaction(async (tx) => {
      const address = await consumeTelegramLink(tx, sha256Hex(token), at);
      if (address === null) return null;
      const row = await linkTelegramChat(tx, {
        address,
        targetEnc: cipher.encrypt(chatId, `telegram:${address}`),
        targetHash: this.chatHash(chatId),
        defaultPrefs: DEFAULT_PREFS,
        now: at,
      });
      return { address, ...row };
    });
    if (linked === null) {
      this.deps.logger.info({ channel: 'telegram', outcome: 'link_expired' }, 'telegram link refused');
      await this.reply(chatId, `This link has expired or was already used. Get a new one from Settings: ${settings}`);
      return;
    }
    this.deps.logger.info({ channel: 'telegram', subscriptionId: linked.id, inserted: linked.inserted }, 'telegram chat linked');
    await this.reply(
      chatId,
      [
        `Linked to wallet ${shortAddress(linked.address)}. Its alerts will arrive in this chat.`,
        `Choose which alerts in Settings: ${settings}`,
        'Send /status to see linked wallets, or /stop to turn alerts off.',
      ].join('\n'),
    );
  }

  private async stopChat(chatId: string, settings: string): Promise<void> {
    const ids = await disableTelegramChat(this.deps.db, this.chatHash(chatId), this.deps.now());
    for (const id of ids) this.deps.logger.info({ channel: 'telegram', subscriptionId: id }, 'telegram chat stopped');
    await this.reply(
      chatId,
      ids.length === 0
        ? 'No alerts were on for this chat.'
        : `Alerts are off for this chat (${ids.length} ${ids.length === 1 ? 'wallet' : 'wallets'}). To turn them back on, link again from Settings: ${settings}`,
    );
  }

  private async status(chatId: string, settings: string): Promise<void> {
    const rows = await telegramByChat(this.deps.db, this.chatHash(chatId));
    if (rows.length === 0) {
      await this.reply(chatId, `No wallets are linked to this chat. Link one from Settings: ${settings}`);
      return;
    }
    const lines = rows.map((row) => {
      if (row.disabled_at !== null) return `${shortAddress(row.address)}: off`;
      const prefs = readPrefs(row.prefs);
      if (prefs === null) return `${shortAddress(row.address)}: on`;
      const kinds = Object.entries(PREF_LABELS)
        .filter(([key]) => prefs[key as keyof typeof prefs] === true)
        .map(([, label]) => label);
      if (prefs.priceAlerts.length > 0) {
        kinds.push(`${prefs.priceAlerts.length} price ${prefs.priceAlerts.length === 1 ? 'alert' : 'alerts'}`);
      }
      return `${shortAddress(row.address)}: on (${kinds.length === 0 ? 'no alert kinds selected' : kinds.join(', ')})`;
    });
    await this.reply(chatId, [...lines, '', `Change alerts in Settings: ${settings}`].join('\n'));
  }

  /** Start long-polling. Returns at once; stop() ends the loop. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.run(this.abort.signal);
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loop;
    this.loop = null;
  }

  private async run(signal: AbortSignal): Promise<void> {
    const pollS = this.deps.pollTimeoutS ?? 25;
    let backoffMs = 1_000;
    let lastCode: string | null = null;
    while (this.running) {
      if (this.botUsername === null) await this.refreshIdentity(signal);
      const startedAt = Date.now();
      const result = await this.deps.api.call<TelegramUpdate[]>(
        'getUpdates',
        { offset: this.offset, timeout: pollS, allowed_updates: ['message'] },
        (pollS + 10) * 1000,
        signal,
      );
      if (!this.running) return;
      if (!result.ok) {
        // 409: a webhook is set or another process polls. Either way, wait and say so once.
        if (result.code !== lastCode) {
          this.deps.logger.warn({ channel: 'telegram', status: result.status, errorCode: result.code }, 'telegram getUpdates failed');
          lastCode = result.code;
        }
        await sleep(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, 60_000);
        continue;
      }
      backoffMs = 1_000;
      lastCode = null;
      const updates = Array.isArray(result.result) ? result.result : [];
      let failed = false;
      for (const update of updates) {
        if (typeof update?.update_id !== 'number') continue;
        try {
          await this.handleUpdate(update);
          this.offset = Math.max(this.offset, update.update_id + 1);
        } catch (error) {
          this.deps.logger.error({ channel: 'telegram', errorCode: errorCode(error) }, 'telegram update failed');
          failed = true;
          break;
        }
      }
      if (failed) {
        await sleep(backoffMs, signal);
        backoffMs = Math.min(backoffMs * 2, 60_000);
        continue;
      }
      // Telegram holds an empty long poll for `timeout` seconds. Something that answers an empty
      // poll at once (a proxy, a fake) would otherwise spin this loop.
      if (updates.length === 0 && pollS > 0 && Date.now() - startedAt < 1_000) await sleep(1_000, signal);
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
