/**
 * Entry point. One vault per process.
 *
 * Boot order matters:
 *   1. config is validated the moment it is imported — a bad address never reaches the loop
 *   2. reconcile() makes the database agree with the chain before any decision is taken
 *   3. the health server comes up
 *   4. the poll loop starts
 *
 * Shutdown is graceful: the in-flight tick is allowed to finish (a half-sent transaction is
 * worse than a slow exit), the HTTP server closes, SQLite is closed, and the process leaves.
 */
import { alert } from './alerts.js';
import { account } from './clients.js';
import { config } from './config.js';
import { startHealthServer } from './health.js';
import { log, logger } from './logger.js';
import { describeError, reconcile, tick } from './roll.js';
import { tickSolo } from './solo.js';
import { store } from './state.js';

let stopping = false;
let tickInFlight: Promise<void> | null = null;
let timer: NodeJS.Timeout | null = null;

async function runTick(): Promise<void> {
  if (stopping) return;
  try {
    await tick();
    await tickSolo();
  } catch (error) {
    // An unhandled error inside one tick must not kill the loop: the next tick re-reads
    // everything from chain and this one's work is either done or not, never half-done.
    const reason = describeError(error);
    log.roll.error({ err: reason }, 'tick failed');
    await alert('keeper_error', `tick failed: ${reason}`, { reason });
  }
}

function schedule(): void {
  timer = setTimeout(() => {
    tickInFlight = runTick().finally(() => {
      tickInFlight = null;
      if (!stopping) schedule();
    });
  }, config.POLL_INTERVAL_MS);
}

async function main(): Promise<void> {
  log.boot.info(
    {
      vault: config.VAULT,
      clearinghouse: config.CLEARINGHOUSE,
      keeper: account.address,
      chainId: config.CHAIN_ID,
      pollIntervalMs: config.POLL_INTERVAL_MS,
      db: store.path,
    },
    'callhouse keeper starting',
  );

  await reconcile();
  const server = startHealthServer();

  await alert(
    'boot',
    `keeper online for ${config.VAULT}`,
    { keeper: account.address, chainId: config.CHAIN_ID },
    { force: true },
  );

  // First tick immediately, then every POLL_INTERVAL_MS.
  tickInFlight = runTick().finally(() => {
    tickInFlight = null;
    if (!stopping) schedule();
  });

  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.boot.info({ signal }, 'shutting down');
    if (timer) clearTimeout(timer);

    const finish = async (): Promise<void> => {
      if (tickInFlight) {
        log.boot.info({}, 'waiting for the in-flight tick');
        await tickInFlight;
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      store.close();
      logger.flush();
      log.boot.info({}, 'stopped');
      process.exit(0);
    };

    void finish().catch((error: unknown) => {
      log.boot.error({ err: describeError(error) }, 'unclean shutdown');
      process.exit(1);
    });
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
  });

  process.on('unhandledRejection', (reason) => {
    log.boot.error({ err: String(reason) }, 'unhandled rejection');
    void alert('keeper_error', `unhandled rejection: ${String(reason)}`, {});
  });
}

main().catch((error: unknown) => {
  // A boot failure is fatal on purpose. A keeper running on a bad config is worse than one
  // that is visibly down.
  logger.fatal({ err: describeError(error) }, 'keeper failed to start');
  process.exit(1);
});
