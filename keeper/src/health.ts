/**
 * The keeper's HTTP surface. Hono on KEEPER_PORT.
 *
 *   GET /health   liveness: last beat, RPC lag, vault phase, cycle number, keeper ETH, DB rows.
 *                 503 ONLY when the loop is wedged — no beat for three poll intervals and no
 *                 tick currently in flight — because a 503 reader restarts the process. Real
 *                 problems a restart cannot fix (low gas, a lagging RPC) are `status:
 *                 "degraded"` on a 200, and page through the alert webhook instead.
 *   GET /state    the keeper's full view of the current cycle, for a human or a dashboard.
 *   GET /orders   the signed, on-chain-authorised Seaport payloads for every live listing.
 *                 This is the censorship/downtime fallback: if Overcall's book never shows our
 *                 listing, our own /vault/nvda/cycle page serves these and a buyer fills
 *                 directly against Seaport. An invisible listing is an unfilled week.
 *   GET /cycles   the last few cycles as the keeper recorded them, unfilled weeks included. Each
 *                 row also carries `premium_gross_usdg6` (gross minus strike proceeds) and
 *                 `strike_proceeds_usdg6`, so an assigned week's returned principal is not read
 *                 as yield. Both null when the split is not known.
 *
 * No host is passed to listen(): Node then binds `::` where IPv6 exists (which also accepts IPv4)
 * and `0.0.0.0` where it does not, the same as the relay and the indexer. That covers a container
 * healthcheck and Railway's IPv6 private network, where the web app's keeper fallback reads
 * /orders at keeper.railway.internal (ops/deploy.md §3). Pinning `0.0.0.0` would cut that off.
 * Put it behind your own network boundary. Nothing here is a write endpoint and nothing here
 * needs a secret — which is also why the RPC URLs below are served origin-only: production
 * endpoints routinely embed keys.
 */
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { account, rpcEndpoints } from './clients.js';
import { config } from './config.js';
import { log } from './logger.js';
import { PHASE_NAMES, getLastSnapshot, getTickStartedAt } from './roll.js';
import { cycleTapeRow, store } from './state.js';
import { toOrderParametersJson, componentsFromJson, type OrderComponentsJson } from './seaport.js';

const startedAt = Date.now();

/** Production RPC URLs routinely embed API keys and this server is unauthenticated on every
 *  interface, so /health reports only origins. */
function originOnly(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return 'unparseable';
  }
}

const rpcOrigins = {
  primary: originOnly(rpcEndpoints.primary),
  backup: rpcEndpoints.backup === null ? null : originOnly(rpcEndpoints.backup),
};

export function buildApp(): Hono {
  const app = new Hono();

  app.get('/health', (c) => {
    const snap = getLastSnapshot();
    const lastBeat = store.lastHeartbeat();
    const beatAgeMs = lastBeat === null ? null : Date.now() - lastBeat;

    // A tick that has not completed in three poll intervals means the loop is wedged. A first
    // boot has no beat yet and is allowed a grace period of the same length.
    const staleAfterMs = config.POLL_INTERVAL_MS * 3;
    // A tick in flight cannot beat: a slow rollClose legitimately holds the loop for the whole
    // receipt timeout. Grant it KEEPER_TX_TIMEOUT_MS plus a margin before the loop reads as
    // wedged — the 503 below restarts the process, which would kill a healthy keeper
    // mid-transaction.
    const tickStarted = getTickStartedAt();
    const tickActive = tickStarted !== null && Date.now() - tickStarted < config.KEEPER_TX_TIMEOUT_MS + 60_000;
    const beatOk = tickActive || (beatAgeMs === null ? Date.now() - startedAt < staleAfterMs : beatAgeMs < staleAfterMs);
    const rpcOk = snap === null ? false : snap.rpcLagSeconds * 1000 <= config.KEEPER_RPC_LAG_ALERT_MS;
    const gasOk = snap === null ? false : snap.keeperBalanceWei >= config.KEEPER_MIN_GAS_WEI;
    // No snapshot yet during the boot grace window is "starting", not "broken". Reporting 503
    // there would have a supervisor restart the keeper forever without it ever ticking once.
    const booting = snap === null && Date.now() - startedAt < staleAfterMs;

    // The HTTP CODE IS A LIVENESS SIGNAL, and the only thing reading it (the Dockerfile
    // HEALTHCHECK, a k8s probe, a load balancer) responds to a failure by restarting the
    // process. So only "the loop is wedged" earns a 503. An empty gas tank and a lagging RPC
    // are real problems that a restart cannot fix — restarting on them turns one page into a
    // crash loop that also loses every in-flight tick. They already page through the alert
    // webhook (`low_gas`, `rpc_lag`); here they surface as `status: "degraded"` on a 200 and
    // in `checks`, which is what a dashboard reads.
    const alive = booting || beatOk;
    const healthy = booting || (beatOk && rpcOk && gasOk);

    return c.json(
      {
        status: booting ? 'starting' : healthy ? 'ok' : 'degraded',
        checks: { heartbeat: beatOk, rpcLag: rpcOk, gas: gasOk },
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        lastHeartbeat: lastBeat === null ? null : new Date(lastBeat).toISOString(),
        lastHeartbeatAgeSeconds: beatAgeMs === null ? null : Math.floor(beatAgeMs / 1000),
        chain: {
          chainId: config.CHAIN_ID,
          rpc: rpcOrigins,
          headBlock: snap ? snap.blockNumber.toString() : null,
          headTimestamp: snap ? Number(snap.blockTimestamp) : null,
          rpcLagSeconds: snap ? snap.rpcLagSeconds : null,
        },
        vault: {
          address: config.VAULT,
          phase: snap ? PHASE_NAMES[snap.phase] : null,
          cycleNumber: snap ? snap.vaultCycleNumber : null,
          registryCycleNumber: snap ? snap.registryCycle.number : null,
          writesHalted: snap ? snap.writesHalted : null,
          listingHash: snap ? snap.listingHash : null,
        },
        keeper: {
          address: account.address,
          balanceWei: snap ? snap.keeperBalanceWei.toString() : null,
          minBalanceWei: config.KEEPER_MIN_GAS_WEI.toString(),
          hasKeeperRole: snap ? snap.hasKeeperRole : null,
        },
        db: { path: store.path, rows: store.counts() },
      },
      alive ? 200 : 503,
    );
  });

  app.get('/state', (c) => {
    const snap = getLastSnapshot();
    if (!snap) return c.json({ error: 'no snapshot yet; the first tick has not completed' }, 503);

    const cycle = store.getCycle(snap.vaultCycleNumber) ?? store.latestCycle();
    const listings = cycle ? store.listingsForCycle(cycle.cycle_number) : [];

    return c.json({
      observedAt: new Date(snap.at).toISOString(),
      phase: PHASE_NAMES[snap.phase],
      registry: {
        address: config.REGISTRY,
        cycleNumber: snap.registryCycle.number,
        isWritingOpen: snap.isWritingOpen,
        isCycleLive: snap.isCycleLive,
        exerciseTimestamp: Number(snap.registryCycle.exerciseTimestamp),
        expiryTimestamp: Number(snap.registryCycle.expiryTimestamp),
        lotSize: snap.registryCycle.lotSize.toString(),
        optionIds: snap.registryCycle.optionIds.map((id) => id.toString()),
      },
      vault: {
        address: config.VAULT,
        cycleNumber: snap.vaultCycleNumber,
        optionId: snap.vaultOptionId.toString(),
        claimKey: snap.vaultClaimKey.toString(),
        strikeUsdg6: snap.vaultStrikeUsdg6.toString(),
        contractsWritten: snap.contractsWritten.toString(),
        optionInventory: snap.optionInventory.toString(),
        idleAssets: snap.idleAssets.toString(),
        totalAssets: snap.totalAssets.toString(),
        lockedAssets: snap.lockedAssets.toString(),
        listingHash: snap.listingHash,
        listingsThisCycle: snap.listingsThisCycle,
        exerciseTimestamp: Number(snap.vaultExerciseTs),
        expiryTimestamp: Number(snap.vaultExpiryTs),
        writesHalted: snap.writesHalted,
        valoremFeesEnabled: snap.valoremFeesEnabled,
        valoremFeeAccepted: snap.valoremFeeAccepted,
        oraclePaused: snap.oraclePaused,
      },
      keeperView: cycle,
      listings,
    });
  });

  /**
   * The fallback book. Everything a buyer needs to fill our listing without Overcall:
   * OrderParameters (components plus totalOriginalConsiderationItems, counter dropped), the
   * signature field, and the order hash. The order is authorised on chain via
   * `seaport.validate()`, so it is fillable with an empty signature too.
   */
  app.get('/orders', (c) => {
    const rows = store.openListings();
    const orders = rows.map((row) => {
      const components = componentsFromJson(JSON.parse(row.components_json) as OrderComponentsJson);
      return {
        orderHash: row.order_hash,
        chainId: config.CHAIN_ID,
        seaport: config.SEAPORT,
        optionId: row.option_id,
        contracts: row.contracts,
        unitPrice6: row.unit_price6,
        grossUsdg6: row.gross_usdg6,
        endTime: row.end_time,
        status: row.status,
        bookStatus: row.api_status,
        parameters: toOrderParametersJson(components),
        signature: row.signature,
      };
    });
    return c.json({ orders });
  });

  app.get('/cycles', (c) => c.json({ cycles: store.recentCycles(26).map(cycleTapeRow) }));

  app.get('/', (c) =>
    c.json({
      service: 'callhouse-keeper',
      vault: config.VAULT,
      endpoints: ['/health', '/state', '/orders', '/cycles'],
    }),
  );

  return app;
}

export function startHealthServer(): ServerType {
  // No `hostname`: see the header. A test pins that this answers on ::1 as well as 127.0.0.1.
  const server = serve({ fetch: buildApp().fetch, port: config.KEEPER_PORT });
  log.health.info({ port: config.KEEPER_PORT }, 'health server listening');
  return server;
}
