/**
 * V2_MODE=cranker: the permissionless lifecycle loop (K2-03). Ladders, snapshot at expiry, finalize,
 * settle, prune then redeem, rolls, housekeeping; one loop (POLL_INTERVAL_MS) plus precise wake-ups,
 * every step bounded per tick and idempotent. It holds no protocol role: CRANKER_PK is any funded key
 * (its bounties come from KeeperRewards).
 *
 * Files: steps.ts (the steps), planner.ts (the pure decisions), reads.ts (pinned multicall views),
 * scanner.ts + index-store.ts (the log index the holder, series, order and strategy lists fall back
 * to), indexer-client.ts (the indexer pages), effects.ts (sender and alerts, live or dry),
 * cranker.ts (the tick and the wake-up), metrics.ts (/state), dryrun.ts (the dry-run CLI),
 * devnet-cycle.ts (the integration test against ops/devnet).
 */
import type { CrankerConfig } from '../config.js';
import type { RunningMode } from '../mode.js';
import { createModeRuntime, runSigningMode, type ModeRuntime, type RuntimeSeams } from '../runtime.js';
import { Cranker } from './cranker.js';
import { CrankAlerts, drySender, liveSender, type CrankSender } from './effects.js';
import { CrankerIndex } from './index-store.js';
import { IndexerClient } from './indexer-client.js';
import type { CrankContext } from './steps.js';

/** Build the cranker on a runtime: the index bound to this deployment, the sender (live or dry), alerts. */
export function createCranker(runtime: ModeRuntime<CrankerConfig>, options: { dryRun: boolean }): Cranker {
  const { config } = runtime;
  const index = new CrankerIndex(runtime.store);
  const wiped = index.bind({
    chainId: config.chainId,
    clearinghouse: config.contracts.clearinghouse,
    orderBook: config.contracts.orderBook,
    autoRoller: config.contracts.autoRoller,
  });
  if (wiped) runtime.log.warn({}, 'the cranker index described another deployment; it was cleared and rescans from the deploy block');
  const sender: CrankSender = options.dryRun ? drySender(runtime.clients.publicClient, runtime.signer.account.address) : liveSender(runtime.sender);
  const ctx: CrankContext = {
    config,
    log: runtime.log.child({ mod: 'cranker' }),
    client: runtime.clients.publicClient,
    logClient: runtime.clients.logClient,
    addresses: {
      clearinghouse: config.contracts.clearinghouse,
      orderBook: config.contracts.orderBook,
      settlementOracle: config.contracts.settlementOracle,
      expiryCalendar: config.contracts.expiryCalendar,
      autoRoller: config.contracts.autoRoller,
      // null until the v8 flywheel is deployed; the flywheel step then reports itself skipped rather than
      // failing the boot (keeper/src/v2/config.ts, ops/v2/env/cranker.env:26-27).
      feeSplitter: config.contracts.feeSplitter,
      multicall3: config.multicall3,
    },
    store: runtime.store,
    index,
    sender,
    alerts: new CrankAlerts(options.dryRun ? null : runtime.alerter, runtime.store, options.dryRun),
    indexer: config.indexerUrl === null ? null : new IndexerClient({ baseUrl: config.indexerUrl, timeoutMs: config.tuning.indexerTimeoutMs, ...(runtime.seams.fetch === undefined ? {} : { fetch: runtime.seams.fetch }) }),
  };
  return new Cranker(ctx, { pollIntervalMs: config.pollIntervalMs, schedule: !options.dryRun, now: runtime.now });
}

export async function startCranker(config: CrankerConfig, seams: RuntimeSeams = {}): Promise<RunningMode> {
  const runtime = createModeRuntime(config, seams);
  const cranker = createCranker(runtime, { dryRun: false });
  let hasState = false;
  const running = await runSigningMode(runtime, {
    tick: async () => {
      await cranker.tick();
      hasState = true;
    },
    state: () => (hasState ? cranker.state() : null),
    onLoop: (loop) => cranker.bindLoop(loop),
  });
  return {
    ...running,
    async close() {
      cranker.stop();
      await running.close();
    },
  };
}
