/**
 * Entry point: validate the environment, bind, and shut down cleanly on SIGTERM.
 *
 * No host is passed to listen(): Node then binds `::` where IPv6 exists (which also accepts
 * IPv4) and `0.0.0.0` where it does not. That covers Railway's public edge, its healthcheck,
 * and its IPv6 private network (`relay.railway.internal`), which a keeper in the same project
 * can use so alerts never leave Railway.
 */
import { ConfigError, parseConfig } from './config.js';
import { createLogger } from './log.js';
import { createRelayServer } from './server.js';

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

const server = createRelayServer(config, { logger });

server.listen(config.port, () => {
  logger.info(
    {
      port: config.port,
      targets: [config.discord ? 'discord' : null, config.telegram ? 'telegram' : null].filter(Boolean),
      timeoutMs: config.timeoutMs,
    },
    'relay listening',
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  // Stop accepting; let an in-flight delivery (≤ RELAY_TIMEOUT_MS) finish, then exit.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
