/**
 * Wiring: config → database (migrated) → channels → delivery worker → Telegram bot → HTTP server.
 *
 * `startNotifier` is what index.ts runs and what N2-02 extends: the returned object carries the
 * DeliveryService, whose `enqueue` is the rules engine's only way to send anything. Every external
 * dependency has a seam in `overrides`, so a test (or a devnet script) can run the whole service
 * against PGlite, a fake Bot API and a fake RPC.
 *
 * Boot order matters: migrations run before anything reads a table, and the server binds last,
 * so Railway's /health check passes only once the service can actually do its job.
 */
import { serve, type ServerType } from '@hono/node-server';
import { createPublicClient, http } from 'viem';
import { createSignatureVerifier, type SignatureVerifier } from './auth.js';
import { emailChannel, emailLinks, emailTokens, smtpMailer, type Mailer } from './channels/email.js';
import { createTelegramApi, telegramChannel, TelegramBot, type TelegramApi } from './channels/telegram.js';
import type { Channel, ChannelName } from './channels/types.js';
import { webPushChannel } from './channels/webpush.js';
import type { NotifierConfig } from './config.js';
import { createTargetCipher } from './crypto.js';
import { createPgDb, migrate, type Db } from './db.js';
import { DeliveryService, type DeliveryOptions } from './delivery.js';
import { createLogger, type Logger } from './log.js';
import { RulesEngine, type RulesHealth, type RulesOptions } from './rules/engine.js';
import { createIndexerClient, type IndexerClient } from './rules/indexer.js';
import { createApp } from './server.js';
import { appLinks } from './templates.js';

/** The RPC deadline for ERC-1271 / ERC-6492 checks. */
export const RPC_TIMEOUT_MS = 5_000;

export interface StartOverrides {
  logger?: Logger;
  db?: Db;
  now?: () => Date;
  verify?: SignatureVerifier;
  telegramApi?: TelegramApi;
  mailer?: Mailer;
  /** Replace a built channel (tests). */
  channels?: Partial<Record<ChannelName, Channel>>;
  delivery?: Partial<DeliveryOptions>;
  /** The indexer client the rules engine reads (tests). */
  indexer?: IndexerClient;
  rules?: Partial<RulesOptions>;
  telegramPollTimeoutS?: number;
  /** false: build everything but start no loops and bind no port (tests call runOnce / app.request). */
  listen?: boolean;
}

export interface RunningNotifier {
  delivery: DeliveryService;
  /** null when RULES_ENABLED is false. */
  rules: RulesEngine | null;
  bot: TelegramBot;
  app: ReturnType<typeof createApp>;
  db: Db;
  server: ServerType | null;
  port: number | null;
  close(): Promise<void>;
}

export async function startNotifier(config: NotifierConfig, overrides: StartOverrides = {}): Promise<RunningNotifier> {
  const logger = overrides.logger ?? createLogger();
  const now = overrides.now ?? (() => new Date());
  const db = overrides.db ?? createPgDb(config.databaseUrl, logger);

  const applied = await migrate(db);
  if (applied.length > 0) logger.info({ migrations: applied }, 'migrations applied');

  const cipher = createTargetCipher(config.dataKey);
  const links = appLinks(config.appUrl);

  const verify =
    overrides.verify ??
    createSignatureVerifier(
      createPublicClient({ transport: http(config.rpcUrl, { timeout: RPC_TIMEOUT_MS, retryCount: 1 }) }),
    );

  const telegramApi = overrides.telegramApi ?? createTelegramApi(config.telegram);
  const mailer = config.email === null ? null : (overrides.mailer ?? smtpMailer(config.email));
  const email =
    config.email === null || mailer === null
      ? null
      : { mailer, tokens: emailTokens(cipher), links: emailLinks(config.email.publicUrl) };

  const channels: Partial<Record<ChannelName, Channel>> = {
    telegram: telegramChannel(telegramApi, links),
    webpush: webPushChannel(config.webPush),
    ...(email === null ? {} : { email: emailChannel({ mailer: email.mailer, tokens: email.tokens, links, emailLinks: email.links }) }),
    ...overrides.channels,
  };

  const delivery = new DeliveryService({
    db,
    cipher,
    links,
    logger,
    now,
    channels,
    ...(overrides.delivery === undefined ? {} : { options: overrides.delivery }),
  });

  // N2-02: the rules engine decides what to send; enqueue is its only way to send anything.
  const rules = config.rules.enabled
    ? new RulesEngine({
        db,
        indexer: overrides.indexer ?? createIndexerClient({ baseUrl: config.indexerUrl }),
        enqueue: (kind, address, payload, key) => delivery.enqueue(kind, address, payload, key),
        logger,
        now,
        options: { pollMs: config.rules.pollMs, ...overrides.rules },
      })
    : null;
  const rulesHealth = (): RulesHealth => rules?.health() ?? { status: 'off', lastSuccessAt: null, consecutiveFailures: 0 };

  const bot = new TelegramBot({
    api: telegramApi,
    db,
    cipher,
    links,
    logger,
    now,
    ...(overrides.telegramPollTimeoutS === undefined ? {} : { pollTimeoutS: overrides.telegramPollTimeoutS }),
  });

  const app = createApp({
    appUrl: config.appUrl,
    vapidPublicKey: config.webPush.publicKey,
    db,
    cipher,
    verify,
    now,
    logger,
    breakerStates: () => delivery.breakerStates(),
    rulesHealth,
    telegram: bot,
    email,
  });

  if (overrides.listen === false) {
    return { delivery, rules, bot, app, db, server: null, port: null, close: () => db.close() };
  }

  await bot.refreshIdentity();
  bot.start();
  delivery.start();
  rules?.start();

  const server = await new Promise<ServerType>((resolve) => {
    const s = serve({ fetch: app.fetch, port: config.port }, () => resolve(s));
  });
  // Bound slow clients; well above any request's worst case (an RPC check or an SMTP send).
  if ('requestTimeout' in server) {
    server.requestTimeout = 30_000;
    server.headersTimeout = 10_000;
  }
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  logger.info(
    { port, channels: Object.keys(channels), telegramBot: bot.username === null ? 'unknown' : 'ok', rules: rules === null ? 'off' : 'on' },
    'notifier listening',
  );

  return {
    delivery,
    rules,
    bot,
    app,
    db,
    server,
    port,
    async close() {
      // Stop taking work, let an in-flight send or tick finish, then release the pool.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await Promise.all([bot.stop(), rules?.stop(), delivery.stop()]);
      await db.close();
    },
  };
}
