/**
 * The v1 keeper process. One process drives one market: the pooled vault (VAULT), one
 * isolated-account factory (FACTORY), or, for the transition, both.
 *
 * Importing this module IS starting the keeper (main() runs at the bottom). src/index.ts, the
 * image's entry (`node dist/index.js`), imports it when V2_MODE is unset; the file moved out of
 * index.ts unchanged below this header so that a v2 mode never evaluates the v1 config, which
 * exits without VAULT/FACTORY and KEEPER_PK.
 *
 * Boot order matters:
 *   1. config is validated the moment it is imported — a bad address never reaches the loop
 *   2. with a VAULT, reconcile() makes the database agree with the chain before any decision is
 *      taken; with a FACTORY, assertSoloWiring() refuses a factory the config does not describe
 *   3. the health server comes up
 *   4. the poll loop starts: tick() for the vault, tickSolo() for the factory, whichever are set
 *
 * A factory-only process (the 34 new markets, and NVDA's own factory keeper) never enters roll.ts:
 * there is no vault to reconcile, no book to serve, no cycle to close. Its heartbeat comes from
 * tickSolo, so /health reads it exactly as it reads a vault keeper.
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
import { assertSoloWiring, tickSolo } from './solo.js';
import { store } from './state.js';

let stopping = false;
let tickInFlight: Promise<void> | null = null;
let timer: NodeJS.Timeout | null = null;

async function runTick(): Promise<void> {
  if (stopping) return;
  try {
    if (config.VAULT !== undefined) await tick();
    if (config.FACTORY !== undefined) await tickSolo();
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

/** "vault 0x…", "factory 0x… (TSLA)" or both: what the boot line and the boot alert name. */
function describeTargets(): string {
  const parts: string[] = [];
  if (config.VAULT !== undefined) parts.push(`vault ${config.VAULT}`);
  if (config.FACTORY !== undefined) parts.push(`${config.KEEPER_MARKET} factory ${config.FACTORY}${config.SOLO_WIND_DOWN ? ' (v1 run-off: settle only)' : ''}`);
  return parts.join(' and ');
}

async function main(): Promise<void> {
  log.boot.info(
    {
      vault: config.VAULT ?? null,
      factory: config.FACTORY ?? null,
      market: config.KEEPER_MARKET,
      priceFeed: config.FACTORY === undefined ? null : config.PRICE_FEED,
      pricingMode: config.KEEPER_PRICING_MODE,
      windDown: config.WIND_DOWN,
      soloWindDown: config.SOLO_WIND_DOWN,
      clearinghouse: config.CLEARINGHOUSE,
      keeper: account.address,
      chainId: config.CHAIN_ID,
      pollIntervalMs: config.POLL_INTERVAL_MS,
      db: store.path,
    },
    'callhouse keeper starting',
  );

  if (config.VAULT !== undefined) await reconcile();
  if (config.FACTORY !== undefined) await assertSoloWiring();
  const server = startHealthServer();

  await alert(
    'boot',
    `keeper online for ${describeTargets()}`,
    { keeper: account.address, chainId: config.CHAIN_ID, market: config.KEEPER_MARKET, pricingMode: config.KEEPER_PRICING_MODE },
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
