/**
 * V2_MODE=mm: two-sided quotes through MakerVault around the pricing service's fair value (K2-04). MM_QUOTER_PK holds
 * the AccessManager's QUOTER role and nothing else (INTERFACE_VERSION 8, id 10 in script/v2/roles.v8.json; the bot
 * never needs the id - it asks `canCall`): it can place, replace and cancel the vault's orders and move vault funds
 * between the vault's wallet and its own Clearinghouse ledger, never out of the vault.
 *
 * Files: engine.ts (the pure quote: halts, spread, skew, widening, selection, replace discipline), risk.ts (sizes under
 * the vault's guards and the bot's caps), pnl.ts (the realised-loss ledger and stop), planner.ts (one tick, decided),
 * reads.ts (pinned multicall views), series-index.ts + mm-store.ts (series, vault orders, ledger, switches in SQLite),
 * pricing-client.ts (/fair), quoter.ts (the tick, sending, alerts, /state, the kill switch), routes.ts (POST /kill and
 * POST /resume), devnet-mm.ts (the integration test against ops/devnet).
 *
 * HTTP on MM_PORT: GET /health, GET /state (net delta per market, every managed series' quote and halt, vault state),
 * POST /kill and POST /resume (Authorization: Bearer MM_KILL_TOKEN). Private networking only.
 */
import type { MmConfig } from '../config.js';
import type { RunningMode } from '../mode.js';
import { createModeRuntime, runSigningMode, type ModeRuntime, type RuntimeSeams } from '../runtime.js';
import { PricingClient } from './pricing-client.js';
import { MmBot } from './quoter.js';
import { mountKillRoutes } from './routes.js';

export function createMmBot(runtime: ModeRuntime<MmConfig>, options: { killWaitMs?: number } = {}): MmBot {
  const { config } = runtime;
  return new MmBot({
    config,
    log: runtime.log.child({ mod: 'mm' }),
    client: runtime.clients.publicClient,
    logClient: runtime.clients.logClient,
    sender: runtime.sender,
    alerter: runtime.alerter,
    store: runtime.store,
    pricing: new PricingClient({ baseUrl: config.pricingUrl, timeoutMs: config.tuning.pricingTimeoutMs, ...(runtime.seams.fetch === undefined ? {} : { fetch: runtime.seams.fetch }) }),
    signer: runtime.signer.account.address,
    now: runtime.now,
    ...(options.killWaitMs === undefined ? {} : { killWaitMs: options.killWaitMs }),
  });
}

export interface StartedMm extends RunningMode {
  bot: MmBot;
}

export async function startMm(config: MmConfig, seams: RuntimeSeams = {}): Promise<StartedMm> {
  const runtime = createModeRuntime(config, seams);
  const bot = createMmBot(runtime);
  let hasState = false;
  const running = await runSigningMode(runtime, {
    tick: async () => {
      await bot.tick();
      hasState = true;
    },
    state: () => (hasState ? bot.state() : null),
    routes: {
      mount: (app) => mountKillRoutes(app, { token: config.killToken, target: bot, log: runtime.log.child({ mod: 'kill' }) }),
      endpoints: ['POST /kill', 'POST /resume'],
    },
    onLoop: (loop) => bot.bindLoop(loop),
  });
  return { ...running, bot };
}
