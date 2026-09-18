/**
 * Entry point: validate the environment, migrate, start the worker and the bot, bind, and shut
 * down cleanly on SIGTERM.
 *
 * No host is passed to listen() (app.ts), as in relay/src/index.ts: Node binds `::` where IPv6
 * exists, which also accepts IPv4. That covers Railway's public edge, its healthcheck, and the
 * private network (`notifier.railway.internal`).
 */
import { ConfigError, parseConfig } from './config.js';
import { startNotifier } from './app.js';
import { createLogger, errorCode } from './log.js';

const logger = createLogger();

let config;
try {
  config = parseConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    // ConfigError's messages name variables and problems, never values.
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

try {
  const running = await startNotifier(config, { logger });
  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    // An in-flight send has a deadline of at most 15 s (email); give it that, then go.
    setTimeout(() => process.exit(0), 20_000).unref();
    running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
} catch (error) {
  // A database that refuses connections or a migration that fails: say which kind, never the URL.
  logger.error({ errorCode: errorCode(error), errorName: error instanceof Error ? error.name : typeof error }, 'notifier failed to start');
  process.exit(1);
}
