/**
 * What every signing mode (cranker, mm, pricer) runs on, built once from its config, and the one
 * way to run such a mode. K2-03/K2-04/K2-05 write a `tick` (and a `/state` view) and hand it to
 * runSigningMode; boot, the chain probe, the heartbeat, alerts, the loop and shutdown are here.
 *
 *   const runtime = createModeRuntime(config);
 *   return runSigningMode(runtime, { tick: () => crank(runtime), state: () => lastView });
 *
 * EACH TICK: redeliver pages whose delivery failed (alerts.ts redeliver) → probe the chain (head block +
 * signer balance) → heartbeat → gas and lag alerts → the mode's tick → heartbeat. A probe that fails on every RPC alerts `v2_rpc_lag` and fails the tick,
 * so /health goes 503 after three poll intervals of it, like v1. A mode's tick that throws alerts
 * `v2_error` and the loop carries on.
 *
 * BOOT starts the health server (with the mode's routes: the MM bot's kill switch), then checks the
 * wiring on chain before the first tick (chain.ts wiringProblems): a configured order book that
 * belongs to another clearinghouse refuses to start instead of cranking two deployments at once. A
 * chain it cannot read (the head, or a view that fails) is retried with backoff for
 * KEEPER_BOOT_RETRY_MS before the boot fails: an RPC blip during a redeploy is not a crash loop into
 * the platform's restart cap. Then `v2_boot`, then the loop.
 */
import type { Hono } from 'hono';
import type { Address } from 'viem';
import { Alerter } from './alerts.js';
import {
  contractHandles,
  createV2Clients,
  createV2Signer,
  readHead,
  readWiring,
  rpcLagSeconds,
  wiringProblems,
  type ContractHandles,
  type V2Clients,
  type V2Signer,
} from './chain.js';
import type { SigningModeConfig } from './config.js';
import { createModeHealthApp, ModeHealth, serveApp, type ChainProbe } from './health.js';
import { createV2Logger, type Logger } from './logger.js';
import { startLoop } from './loop.js';
import type { RunningMode } from './mode.js';
import { V2Store } from './store.js';
import { describeError, TxSender, viemTxChain, type TxChain } from './tx.js';

export interface ModeRuntime<C extends SigningModeConfig = SigningModeConfig> {
  config: C;
  log: Logger;
  clients: V2Clients;
  signer: V2Signer;
  /** Typed read handles; the mode's required contracts are non-null. */
  contracts: ContractHandles<C['contracts']>;
  store: V2Store;
  sender: TxSender;
  alerter: Alerter;
  health: ModeHealth;
  now: () => number;
  /** The seams it was built with; runSigningMode reads probe and checkWiring from here. */
  seams: RuntimeSeams;
}

/** Test seams. Production passes none. */
export interface RuntimeSeams {
  log?: Logger;
  txChain?: TxChain;
  fetch?: typeof fetch;
  now?: () => number;
  /** Replaces the head-block and balance read of every tick. */
  probe?: () => Promise<ChainProbe>;
  /** Replaces the on-chain wiring check at boot; return the problems. */
  checkWiring?: () => Promise<string[]>;
  /** The first pause between boot wiring attempts (default 2 s, doubling to 30 s). */
  bootRetryDelayMs?: number;
}

/** Build clients, signer, handles, store, sender, alerter and health state. Dials nothing. */
export function createModeRuntime<C extends SigningModeConfig>(config: C, seams: RuntimeSeams = {}): ModeRuntime<C> {
  const now = seams.now ?? Date.now;
  const log = seams.log ?? createV2Logger({ level: config.logLevel, mode: config.mode, base: { chainId: config.chainId } });
  const clients = createV2Clients({ chainId: config.chainId, rpcUrls: config.rpcUrls, multicall3: config.multicall3 });
  const signer = createV2Signer(clients, { privateKey: config.privateKey(), primaryRpc: config.rpcUrls[0] });
  const store = new V2Store(config.dbPath);
  const runtime: ModeRuntime<C> = {
    config,
    log,
    clients,
    signer,
    contracts: contractHandles(clients.publicClient, config.contracts),
    store,
    sender: new TxSender({
      chain: seams.txChain ?? viemTxChain(clients.publicClient, signer.walletClient, signer.account),
      store,
      log: log.child({ mod: 'tx' }),
      txTimeoutMs: config.txTimeoutMs,
      now,
      // Every send beats: a long tick of receipts is progress, not a wedged loop (health.ts).
      onProgress: () => runtime.health.beat(now()),
    }),
    alerter: new Alerter({
      mode: config.mode,
      chainId: config.chainId,
      webhook: config.alertWebhook,
      token: config.alertWebhookToken,
      cooldownMs: config.alertCooldownMs,
      log: log.child({ mod: 'alerts' }),
      store,
      ...(seams.fetch === undefined ? {} : { fetch: seams.fetch }),
      now,
      onDelivery: (ok, error) => runtime.health.recordAlertDelivery(now(), ok, error),
    }),
    health: new ModeHealth(now()),
    now,
    seams,
  };
  return runtime;
}

export interface ModeDefinition {
  tick: () => Promise<void>;
  /** The /state body, or null before there is one. */
  state?: () => unknown;
  /** Extra HTTP routes on the mode's port (the MM bot's kill switch). */
  routes?: { mount: (app: Hono) => void; endpoints: readonly string[] };
  /** Called once the loop exists, before its first tick awaits anything: a mode that schedules its
   *  own wake-ups (the cranker at an expiry) keeps `wake`. */
  onLoop?: (loop: { wake(): void }) => void;
}

async function probeChain(runtime: ModeRuntime): Promise<ChainProbe> {
  const { publicClient } = runtime.clients;
  const [head, balanceWei] = await Promise.all([readHead(publicClient), publicClient.getBalance({ address: runtime.signer.account.address })]);
  return { headBlock: head.blockNumber, headTimestamp: head.timestamp, rpcLagSeconds: rpcLagSeconds(head, runtime.now()), balanceWei };
}

async function checkWiring(runtime: ModeRuntime): Promise<string[]> {
  const { contracts, registry } = runtime.config;
  // readWiring reads a failed view as null ("could not be read"). Read the head first so an
  // unreachable RPC fails the boot as itself, not as three wiring problems.
  await readHead(runtime.clients.publicClient);
  const observed = await readWiring(runtime.clients.publicClient, {
    clearinghouse: contracts.clearinghouse,
    orderBook: contracts.orderBook,
    expiryCalendar: contracts.expiryCalendar,
    usdg: registry.usdg,
  });
  return wiringProblems(
    { clearinghouse: contracts.clearinghouse, orderBook: contracts.orderBook, expiryCalendar: contracts.expiryCalendar, usdg: registry.usdg },
    observed,
  );
}

async function raiseChainAlerts(runtime: ModeRuntime, probe: ChainProbe): Promise<void> {
  const { alerter, config } = runtime;
  if (probe.balanceWei < config.minGasWei) {
    await alerter.alert('v2_low_gas', `${config.mode} signer ${runtime.signer.account.address} is low on gas`, {
      balanceWei: probe.balanceWei,
      minBalanceWei: config.minGasWei,
    });
  } else {
    alerter.clear('v2_low_gas');
  }
  if (probe.rpcLagSeconds * 1000 > config.rpcLagAlertMs) {
    await alerter.alert('v2_rpc_lag', `head block ${probe.headBlock} trails the wall clock by ${probe.rpcLagSeconds} s`, {
      headBlock: probe.headBlock,
      headTimestamp: probe.headTimestamp,
      rpcLagSeconds: probe.rpcLagSeconds,
    });
  } else {
    alerter.clear('v2_rpc_lag');
  }
}

/** Boot a signing mode and run its loop until close(). Rejects when the wiring or the port is wrong. */
export async function runSigningMode<C extends SigningModeConfig>(runtime: ModeRuntime<C>, definition: ModeDefinition): Promise<RunningMode> {
  const rt = runtime as unknown as ModeRuntime;
  const { config, log, health, alerter, store, seams } = rt;
  const address: Address = rt.signer.account.address;

  log.info(
    {
      signer: address,
      keyEnv: config.keyEnv,
      contracts: config.contracts,
      contractSources: config.contractSources,
      registry: config.registryPath,
      pollIntervalMs: config.pollIntervalMs,
      db: store.path,
    },
    `${config.mode} starting`,
  );

  let server;
  try {
    server = await serveApp(
      createModeHealthApp({
        mode: config.mode,
        health,
        limits: { pollIntervalMs: config.pollIntervalMs, txTimeoutMs: config.txTimeoutMs, rpcLagAlertMs: config.rpcLagAlertMs, minGasWei: config.minGasWei },
        chainId: config.chainId,
        rpcUrls: config.rpcUrls,
        signer: address,
        contracts: config.contracts,
        store,
        ...(definition.state === undefined ? {} : { state: definition.state }),
        ...(definition.routes === undefined ? {} : { routes: definition.routes }),
        now: rt.now,
      }),
      config.port,
    );
  } catch (error) {
    store.close();
    throw error;
  }
  log.info({ port: server.port }, 'health server listening');

  // The wiring, retried while the chain cannot be read (a thrown read, or only unreadable views); a mismatch is final.
  const check = seams.checkWiring ?? (() => checkWiring(rt));
  const deadline = Date.now() + config.bootRetryMs;
  let delay = seams.bootRetryDelayMs ?? 2_000;
  let problems: string[] = [];
  for (;;) {
    let failure: unknown = null;
    try {
      problems = await check();
      if (problems.length === 0 || !problems.every((p) => /could not be read/.test(p))) break;
    } catch (error) {
      failure = error;
    }
    if (Date.now() >= deadline) {
      if (failure === null) break;
      await server.close();
      store.close();
      throw failure;
    }
    log.warn({ reason: failure === null ? problems.join('; ') : describeError(failure), retryInMs: delay }, 'chain not reachable at boot; retrying');
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 2, 30_000);
  }
  if (problems.length > 0) {
    await server.close();
    store.close();
    throw new Error(`the configured v2 contracts do not belong together:\n  ${problems.join('\n  ')}`);
  }

  await alerter.alert('v2_boot', `${config.mode} online`, { signer: address, chainId: config.chainId }, { force: true });

  const probe = seams.probe ?? (() => probeChain(rt));
  let prunedAt = 0;
  const loop = startLoop({
    intervalMs: config.pollIntervalMs,
    tick: async () => {
      health.tickStarted(rt.now());
      try {
        // A page a failed relay never took (a revert, a kill): sent again from the store, bounded, never throwing.
        await alerter.redeliver();
        // Hourly: the journal and the alert table keep HISTORY_RETENTION_MS, not forever.
        if (Date.now() - prunedAt >= 3_600_000) {
          prunedAt = Date.now();
          try {
            const pruned = store.pruneHistory();
            if (pruned.txs + pruned.alerts > 0) log.info(pruned, 'pruned journal and alert history past the retention');
          } catch (error) {
            log.error({ err: describeError(error) }, 'could not prune the journal');
          }
        }
        let snapshot: ChainProbe;
        try {
          snapshot = await probe();
        } catch (error) {
          await alerter.alert('v2_rpc_lag', `chain probe failed on every RPC: ${describeError(error)}`, { reason: describeError(error) });
          throw error;
        }
        health.recordChain(snapshot);
        health.beat(rt.now());
        await raiseChainAlerts(rt, snapshot);
        await definition.tick();
        // Beat on the way out too: a tick that spent minutes on receipts must not read as wedged.
        health.beat(rt.now());
      } finally {
        health.tickEnded();
      }
    },
    onError: async (error) => {
      const reason = describeError(error);
      health.recordTickError(rt.now(), reason);
      log.error({ err: reason }, 'tick failed');
      await alerter.alert('v2_error', `${config.mode} tick failed: ${reason}`, { reason });
    },
  });

  definition.onLoop?.({ wake: () => loop.wake() });

  return {
    mode: config.mode,
    port: server.port,
    wake: () => loop.wake(),
    async close() {
      await loop.stop();
      await server.close();
      store.close();
      log.info({}, `${config.mode} stopped`);
    },
  };
}
