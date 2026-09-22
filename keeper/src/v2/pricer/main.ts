/**
 * V2_MODE=pricer: AutoRoller.reprice for smart-pricing strategies from the pricing service's fair
 * value (K2-05). PRICER_PK holds the AccessManager's PRICER role on the AutoRoller and nothing else: the role can only
 * move a smart-pricing writer's live ask inside the writer's own [minAskBps, maxAskBps] band of spot
 * (C2-09). It cannot touch collateral, but it is not harmless: a compromised key can move every smart-pricing
 * writer's ask to the bottom of that writer's band and a colluding taker can lift them there, so each writer sells
 * at its band minimum instead of fair plus edge (callhouse-contracts SECURITY.md, V2-ARCHITECTURE.md §2.2).
 * Revoking PRICER from the key on the AccessManager stops it (OPS_ADMIN, delay 0, one Safe transaction);
 * asks already lifted are not undone.
 *
 * Files: planner.ts (the pure decisions: band, target, threshold, cadence), fair-client.ts (the
 * pricing service's /fair), strategies.ts (the StrategySet scan ∪ the indexer's active strategies),
 * pricer.ts (the tick, /state and the readiness rule), devnet-reprice.ts (the integration test against
 * ops/devnet).
 *
 * HTTP: the runtime's /health and /state, plus GET /ready (T-423, pricerReadyRoute): whether this pricer
 * can price NOW, in a body safe to proxy to a public API. /health is liveness only and carries the signer,
 * RPC origins, contract addresses and db path, so the indexer (T-424) reads /ready and never /health.
 */
import type { PricerConfig } from '../config.js';
import { IndexerClient } from '../cranker/indexer-client.js';
import { evaluateHealth, readyRoute, type HealthLimits, type ModeHealth } from '../health.js';
import type { RunningMode } from '../mode.js';
import { createModeRuntime, runSigningMode, type ModeRuntime, type RuntimeSeams } from '../runtime.js';
import { PricingClient, type FairSource } from './fair-client.js';
import { Pricer } from './pricer.js';
import { StrategyIndex } from './strategies.js';

export interface PricerSeams extends RuntimeSeams {
  /** Replaces the pricing service (the devnet harness injects its fair values). */
  fair?: FairSource;
}

/** Build the pricer on a runtime: the strategy index for this roller, the pricing and indexer clients. */
export function createPricer(runtime: ModeRuntime<PricerConfig>, seams: PricerSeams = {}): Pricer {
  const { config } = runtime;
  const fetchSeam = runtime.seams.fetch === undefined ? {} : { fetch: runtime.seams.fetch };
  return new Pricer({
    config,
    log: runtime.log.child({ mod: 'pricer' }),
    client: runtime.clients.publicClient,
    logClient: runtime.clients.logClient,
    store: runtime.store,
    sender: runtime.sender,
    alerter: runtime.alerter,
    fair: seams.fair ?? new PricingClient({ baseUrl: config.pricingUrl, timeoutMs: config.tuning.httpTimeoutMs, ...fetchSeam }),
    indexer: config.indexerUrl === null ? null : new IndexerClient({ baseUrl: config.indexerUrl, timeoutMs: config.tuning.httpTimeoutMs, ...fetchSeam }),
    strategies: new StrategyIndex(runtime.store, config.contracts.autoRoller),
    now: runtime.now,
  });
}

/**
 * GET /ready for this pricer: /health's liveness rule over the runtime's ModeHealth, with the same limits
 * runtime.ts gives createModeHealthApp, then Pricer.readiness. Liveness is an INPUT here, never the answer.
 */
export function pricerReadyRoute(pricer: Pricer, health: ModeHealth, config: PricerConfig, now: () => number = Date.now) {
  const limits: HealthLimits = { pollIntervalMs: config.pollIntervalMs, txTimeoutMs: config.txTimeoutMs, rpcLagAlertMs: config.rpcLagAlertMs, minGasWei: config.minGasWei };
  return readyRoute((t) => pricer.readiness(evaluateHealth(health, limits, t).alive, t), now);
}

export async function startPricer(config: PricerConfig, seams: PricerSeams = {}): Promise<RunningMode> {
  const runtime = createModeRuntime(config, seams);
  const pricer = createPricer(runtime, seams);
  return runSigningMode(runtime, {
    tick: async () => {
      await pricer.tick();
    },
    state: () => (pricer.ticks === 0 ? null : pricer.state()),
    routes: pricerReadyRoute(pricer, runtime.health, config, runtime.now),
  });
}
