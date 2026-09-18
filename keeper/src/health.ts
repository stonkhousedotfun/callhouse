/**
 * The keeper's HTTP surface. Hono on KEEPER_PORT.
 *
 *   GET /health   liveness: last beat, RPC lag, vault phase, cycle number, keeper ETH, DB rows.
 *                 503 ONLY when the loop is wedged — no beat for three poll intervals and no
 *                 tick currently in flight — because a 503 reader restarts the process. Real
 *                 problems a restart cannot fix (low gas, a lagging RPC) are `status:
 *                 "degraded"` on a 200, and page through the alert webhook instead.
 *                 A factory-only process (no VAULT) reports `vault: null` and a `factory` block
 *                 from the last solo snapshot; its heartbeat is tickSolo's.
 *   GET /state    the keeper's full view of the current cycle, for a human or a dashboard:
 *                 the vault, the next week it would arm, capacity, the stranded claim if any,
 *                 and `pricing`: how the LIVE cycle's latest listing was priced (policy.ts
 *                 PricingRecord: strike, spot, floor, fair value, edge, delta, iv). null while
 *                 the vault is Idle (between weeks, or a skipped week: the last record belongs to
 *                 a closed cycle and must not read as current), and when there is no listing.
 *                 Without a vault: the solo view (market, factory, the week, the next window,
 *                 pending/live counts, the last pricing record and the last skip reason). In v1
 *                 run-off (SOLO_WIND_DOWN) `windDown: true`, `nextWeek: null` and `drainedAt`.
 *                 `settleHeld` lists the expired accounts whose settle() the guard is holding
 *                 (account, claimKey, listedExpiryTs, reasons, since), in either mode.
 *   GET /orders   the vault's live, on-chain-authorised Seaport order(s), with OrderParameters
 *                 and the EMPTY signature. This is the book: the web fill page reads it, and any
 *                 Seaport 1.6 client can fill it directly. There is no other venue. Each order
 *                 carries `pricing`, the record it was priced on, or null for an older row.
 *                 Without a vault: `{orders: [], note}`; a factory's book is on chain (every
 *                 WriterAccount validates its own lots on Seaport) and the web app reads it there.
 *   GET /cycles   the last few cycles as the keeper recorded them, unfilled weeks included. Each
 *                 row also carries `premium_gross_usdg6` (gross minus strike proceeds) and
 *                 `strike_proceeds_usdg6`, so an assigned week's returned principal is not read
 *                 as yield. Both null when the split is not known.
 *
 * No host is passed to listen(): Node then binds `::` where IPv6 exists (which also accepts IPv4)
 * and `0.0.0.0` where it does not, the same as the relay and the indexer. That covers a container
 * healthcheck and Railway's IPv6 private network, where the web app reads /orders at
 * keeper.railway.internal (ops/deploy.md §3). Pinning `0.0.0.0` would cut that off.
 * Put it behind your own network boundary. Nothing here is a write endpoint and nothing here
 * needs a secret — which is also why the RPC URLs below are served origin-only: production
 * endpoints routinely embed keys.
 */
import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { account, rpcEndpoints } from './clients.js';
import { describeInstant } from './calendar.js';
import { config } from './config.js';
import { log } from './logger.js';
import { MAX_LISTINGS_PER_CYCLE } from './policy.js';
import { PHASE_NAMES, Phase, getLastSnapshot, getTickStartedAt, listingFilled, nextWindow, snapshotCapacity } from './roll.js';
import { getSettleHolds, getSoloSnapshot, getSoloTickStartedAt, nextSoloWindow, soloMemory, weekIsCurrent, type SoloSnapshot } from './solo.js';
import { cycleTapeRow, parsePricingJson, store } from './state.js';
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

/** The factory half of /health: the last solo snapshot, or nulls before the first tick. */
function factoryHealth(snap: SoloSnapshot | null): Record<string, unknown> {
  return {
    address: config.FACTORY,
    market: config.KEEPER_MARKET,
    priceFeed: config.PRICE_FEED,
    pricingMode: config.KEEPER_PRICING_MODE,
    windDown: config.SOLO_WIND_DOWN,
    weekId: snap ? snap.week.id : null,
    weekCurrent: snap ? weekIsCurrent(snap.week, Number(snap.blockTimestamp)) : null,
    weekExerciseTs: snap ? snap.week.exerciseTs : null,
    weekBaseExpiryTs: snap ? snap.week.baseExpiryTs : null,
    strikeUsdg6: snap ? snap.week.strikeUsdg6.toString() : null,
    askUsdg6: snap ? snap.week.askUsdg6.toString() : null,
    pendingCount: snap ? snap.pendingCount : null,
    liveCount: snap ? snap.liveCount : null,
    writesHalted: snap ? snap.writesHalted : null,
    hasKeeperRole: snap ? snap.hasKeeperRole : null,
    spotUsdg6: snap?.spot ? snap.spot.spotUsdg6.toString() : null,
    spotAgeSeconds: snap?.spot ? snap.spot.ageS : null,
    spotError: snap ? snap.spotError : null,
  };
}

/** /state for a factory: everything the last solo tick read, plus the persisted memory. */
function soloStateView(snap: SoloSnapshot): Record<string, unknown> {
  const now = Number(snap.blockTimestamp);
  let nextWeek: Record<string, unknown> | null = null;
  // In run-off there is no next week: the keeper never sets one, and a window here would read as one.
  if (!config.SOLO_WIND_DOWN) {
    try {
      const w = nextSoloWindow(snap);
      nextWeek = { ...w, exercise: describeInstant(w.exerciseTs), expiry: describeInstant(w.expiryTs) };
    } catch {
      nextWeek = null;
    }
  }
  const memory = soloMemory();
  return {
    observedAt: new Date(snap.at).toISOString(),
    market: config.KEEPER_MARKET,
    factory: config.FACTORY,
    priceFeed: config.PRICE_FEED,
    pricingMode: config.KEEPER_PRICING_MODE,
    windDown: config.SOLO_WIND_DOWN,
    drainedAt: memory.drainedAt,
    block: snap.blockNumber.toString(),
    blockTimestamp: now,
    keeper: { address: account.address, hasKeeperRole: snap.hasKeeperRole, balanceWei: snap.keeperBalanceWei.toString() },
    week: {
      id: snap.week.id,
      current: weekIsCurrent(snap.week, now),
      strikeUsdg6: snap.week.strikeUsdg6.toString(),
      askUsdg6: snap.week.askUsdg6.toString(),
      exerciseTs: snap.week.exerciseTs,
      baseExpiryTs: snap.week.baseExpiryTs,
      exercise: snap.week.id === 0 ? null : describeInstant(snap.week.exerciseTs),
      baseExpiry: snap.week.id === 0 ? null : describeInstant(snap.week.baseExpiryTs),
    },
    nextWeek,
    pendingCount: snap.pendingCount,
    liveCount: snap.liveCount,
    // Expired accounts the settle guard is holding (solo.ts, v1_settle_held): empty when none.
    settleHeld: getSettleHolds(),
    writesHalted: snap.writesHalted,
    spot: snap.spot
      ? {
          spotUsdg6: snap.spot.spotUsdg6.toString(),
          answer: snap.spot.answer.toString(),
          decimals: snap.spot.decimals,
          roundId: snap.spot.roundId.toString(),
          updatedAt: snap.spot.updatedAt,
          ageSeconds: snap.spot.ageS,
        }
      : null,
    spotError: snap.spotError,
    maxPriceAge: snap.maxPriceAge,
    policy: {
      minOtmBps: snap.policy.minOtmBps.toString(),
      maxOtmBps: snap.policy.maxOtmBps.toString(),
      minPremiumBps: snap.policy.minPremiumBps.toString(),
      maxUtilizationBps: snap.policy.maxUtilizationBps.toString(),
      protocolFeeBps: snap.policy.protocolFeeBps.toString(),
      maxContractsCap: snap.policy.maxContractsCap.toString(),
    },
    valoremFeesEnabled: snap.feesEnabled,
    valoremFeeBps: snap.feeBps,
    minAskUsdg6: config.KEEPER_MIN_ASK_USDG6.toString(),
    lastPricing: memory.lastPricing,
    lastSkipReason: memory.lastSkip,
  };
}

export function buildApp(): Hono {
  const app = new Hono();

  app.get('/health', (c) => {
    const snap = config.VAULT === undefined ? null : getLastSnapshot();
    const solo = config.FACTORY === undefined ? null : getSoloSnapshot();
    const lastBeat = store.lastHeartbeat();
    const beatAgeMs = lastBeat === null ? null : Date.now() - lastBeat;

    // A tick that has not completed in three poll intervals means the loop is wedged. A first
    // boot has no beat yet and is allowed a grace period of the same length.
    const staleAfterMs = config.POLL_INTERVAL_MS * 3;
    // A tick in flight cannot beat: a slow rollClose (or a listFor waiting on its receipt)
    // legitimately holds the loop for the whole receipt timeout. Grant it KEEPER_TX_TIMEOUT_MS
    // plus a margin before the loop reads as wedged — the 503 below restarts the process, which
    // would kill a healthy keeper mid-transaction.
    const tickStarted = getTickStartedAt() ?? getSoloTickStartedAt();
    const tickActive = tickStarted !== null && Date.now() - tickStarted < config.KEEPER_TX_TIMEOUT_MS + 60_000;
    const beatOk = tickActive || (beatAgeMs === null ? Date.now() - startedAt < staleAfterMs : beatAgeMs < staleAfterMs);
    // RPC lag and gas come from whichever snapshots this process takes; with both a vault and a
    // factory, both must be fine.
    const lags = [snap?.rpcLagSeconds, solo?.rpcLagSeconds].filter((v): v is number => v !== undefined);
    const balances = [snap?.keeperBalanceWei, solo?.keeperBalanceWei].filter((v): v is bigint => v !== undefined);
    const rpcOk = lags.length > 0 && lags.every((lag) => lag * 1000 <= config.KEEPER_RPC_LAG_ALERT_MS);
    const gasOk = balances.length > 0 && balances.every((wei) => wei >= config.KEEPER_MIN_GAS_WEI);
    // No snapshot yet during the boot grace window is "starting", not "broken". Reporting 503
    // there would have a supervisor restart the keeper forever without it ever ticking once.
    const booting = snap === null && solo === null && Date.now() - startedAt < staleAfterMs;

    // The HTTP CODE IS A LIVENESS SIGNAL, and the only thing reading it (the Dockerfile
    // HEALTHCHECK, a k8s probe, a load balancer) responds to a failure by restarting the
    // process. So only "the loop is wedged" earns a 503. An empty gas tank and a lagging RPC
    // are real problems that a restart cannot fix — restarting on them turns one page into a
    // crash loop that also loses every in-flight tick. They already page through the alert
    // webhook (`low_gas`, `rpc_lag`); here they surface as `status: "degraded"` on a 200 and
    // in `checks`, which is what a dashboard reads.
    const alive = booting || beatOk;
    const healthy = booting || (beatOk && rpcOk && gasOk);
    const head = snap ?? solo;
    const balance = snap?.keeperBalanceWei ?? solo?.keeperBalanceWei ?? null;
    const hasKeeperRole = snap?.hasKeeperRole ?? solo?.hasKeeperRole ?? null;

    return c.json(
      {
        status: booting ? 'starting' : healthy ? 'ok' : 'degraded',
        checks: { heartbeat: beatOk, rpcLag: rpcOk, gas: gasOk },
        market: config.KEEPER_MARKET,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        lastHeartbeat: lastBeat === null ? null : new Date(lastBeat).toISOString(),
        lastHeartbeatAgeSeconds: beatAgeMs === null ? null : Math.floor(beatAgeMs / 1000),
        chain: {
          chainId: config.CHAIN_ID,
          rpc: rpcOrigins,
          headBlock: head ? head.blockNumber.toString() : null,
          headTimestamp: head ? Number(head.blockTimestamp) : null,
          rpcLagSeconds: head ? head.rpcLagSeconds : null,
        },
        vault:
          config.VAULT === undefined
            ? null
            : {
                address: config.VAULT,
                phase: snap ? PHASE_NAMES[snap.phase] : null,
                cycleNumber: snap ? snap.vaultCycleNumber : null,
                stranded: snap ? snap.isStranded : null,
                writesHalted: snap ? snap.writesHalted : null,
                listingHash: snap ? snap.listingHash : null,
              },
        factory: config.FACTORY === undefined ? null : factoryHealth(solo),
        keeper: {
          address: account.address,
          balanceWei: balance === null ? null : balance.toString(),
          minBalanceWei: config.KEEPER_MIN_GAS_WEI.toString(),
          hasKeeperRole,
        },
        db: { path: store.path, rows: store.counts() },
      },
      alive ? 200 : 503,
    );
  });

  app.get('/state', (c) => {
    if (config.VAULT === undefined) {
      const solo = getSoloSnapshot();
      if (!solo) return c.json({ error: 'no snapshot yet; the first tick has not completed', market: config.KEEPER_MARKET, factory: config.FACTORY }, 503);
      return c.json(soloStateView(solo));
    }

    const snap = getLastSnapshot();
    if (!snap) return c.json({ error: 'no snapshot yet; the first tick has not completed' }, 503);

    const cycle = store.getCycle(snap.vaultCycleNumber) ?? store.latestCycle();
    const listings = cycle ? store.listingsForCycle(cycle.cycle_number) : [];
    // Only a cycle the vault is still in has a current price.
    const live = snap.phase !== Phase.Idle && cycle !== null && cycle.cycle_number === snap.vaultCycleNumber;
    const latestListing = live && listings.length > 0 ? listings[listings.length - 1] : undefined;
    let week: Record<string, unknown> | null = null;
    try {
      const w = nextWindow(snap);
      week = { ...w, exercise: describeInstant(w.exerciseTs), expiry: describeInstant(w.expiryTs) };
    } catch {
      week = null;
    }
    const solo = config.FACTORY === undefined ? null : getSoloSnapshot();

    return c.json({
      observedAt: new Date(snap.at).toISOString(),
      phase: PHASE_NAMES[snap.phase],
      vault: {
        address: config.VAULT,
        cycleNumber: snap.vaultCycleNumber,
        optionId: snap.vaultOptionId.toString(),
        claimKey: snap.vaultClaimKey.toString(),
        strikeUsdg6: snap.vaultStrikeUsdg6.toString(),
        contractsWritten: snap.contractsWritten.toString(),
        capacity: snapshotCapacity(snap).toString(),
        idleAssets: snap.idleAssets.toString(),
        totalAssets: snap.totalAssets.toString(),
        lockedAssets: snap.lockedAssets.toString(),
        listingHash: snap.listingHash,
        listingAmount: snap.listingAmount.toString(),
        listingGrossUsdg6: snap.listingGrossUsdg6.toString(),
        listingsThisCycle: snap.listingsThisCycle,
        maxListingsPerCycle: MAX_LISTINGS_PER_CYCLE,
        exerciseTimestamp: Number(snap.vaultExerciseTs),
        expiryTimestamp: Number(snap.vaultExpiryTs),
        writesHalted: snap.writesHalted,
        valoremFeesEnabled: snap.valoremFeesEnabled,
        valoremFeeAccepted: snap.valoremFeeAccepted,
        oraclePaused: snap.oraclePaused,
        spotUsdg6: snap.spotUsdg6 === null ? null : snap.spotUsdg6.toString(),
        spotError: snap.spotError,
        queuedShares: snap.queuedShares.toString(),
        stranded: snap.isStranded,
        strandGen: snap.strandGen.toString(),
      },
      policy: {
        minOtmBps: snap.policy.minOtmBps.toString(),
        maxOtmBps: snap.policy.maxOtmBps.toString(),
        minPremiumBps: snap.policy.minPremiumBps.toString(),
        maxUtilizationBps: snap.policy.maxUtilizationBps.toString(),
        protocolFeeBps: snap.policy.protocolFeeBps.toString(),
        maxContractsCap: snap.policy.maxContractsCap.toString(),
      },
      nextWeek: week,
      keeperView: cycle,
      listings,
      pricing: parsePricingJson(latestListing?.pricing_json),
      // A process that also drives a factory shows it here; null before its first solo tick.
      factory: config.FACTORY === undefined ? undefined : solo === null ? null : soloStateView(solo),
    });
  });

  /**
   * The book. Everything a buyer needs to fill our listing: OrderParameters (components plus
   * totalOriginalConsiderationItems, counter dropped — the fill page re-reads it from Seaport),
   * the EMPTY signature, and the order hash. The order is authorised on chain via
   * `seaport.validate()`, and the vault is its zone: every fill runs the vault's hooks, which
   * write exactly what is bought. `remainingContracts` is the size less Seaport's fill fraction.
   */
  app.get('/orders', (c) => {
    if (config.VAULT === undefined) {
      return c.json({
        orders: [],
        note: `factory-only keeper (${config.KEEPER_MARKET}): there is no vault book here. Each WriterAccount of factory ${config.FACTORY} validates its own lots on Seaport; the web app reads them from chain.`,
      });
    }
    const rows = store.openListings();
    const orders = rows.map((row) => {
      const components = componentsFromJson(JSON.parse(row.components_json) as OrderComponentsJson);
      const filled = listingFilled(row);
      return {
        orderHash: row.order_hash,
        chainId: config.CHAIN_ID,
        seaport: config.SEAPORT,
        vault: config.VAULT,
        optionId: row.option_id,
        contracts: row.contracts,
        filledContracts: filled.toString(),
        remainingContracts: (BigInt(row.contracts) - filled).toString(),
        unitPrice6: row.unit_price6,
        grossUsdg6: row.gross_usdg6,
        endTime: row.end_time,
        status: row.status,
        parameters: toOrderParametersJson(components),
        signature: row.signature,
        pricing: parsePricingJson(row.pricing_json),
      };
    });
    return c.json({ orders });
  });

  app.get('/cycles', (c) => c.json({ cycles: store.recentCycles(26).map(cycleTapeRow) }));

  app.get('/', (c) =>
    c.json({
      service: 'callhouse-keeper',
      market: config.KEEPER_MARKET,
      vault: config.VAULT ?? null,
      factory: config.FACTORY ?? null,
      endpoints: ['/health', '/state', '/orders', '/cycles'],
    }),
  );

  return app;
}

export function startHealthServer(): ServerType {
  // No `hostname`: see the header. A test pins that this answers on ::1 as well as 127.0.0.1.
  const server = serve({ fetch: buildApp().fetch, port: config.KEEPER_PORT });
  log.health.info({ port: config.KEEPER_PORT, market: config.KEEPER_MARKET }, 'health server listening');
  return server;
}
