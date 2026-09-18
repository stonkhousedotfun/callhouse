/**
 * Vol pricing through the keeper tick: the fetch, the arm, the listing, the reprice, the database
 * and the HTTP surface, with the chain and the vault stubbed.
 *
 * WHY THIS FILE EXISTS: policy.vol.test.ts pins the maths; this pins the wiring the maths depends
 * on. The chain must be fetched once per decision (not once per helper), a failed or stale fetch
 * must become a remembered skip and an alert rather than a thrown tick or an arm on the fixed
 * rule, the arm and its first listing must read the same market, a reprice with the feed dark
 * must not cancel a listing it cannot replace, and every number behind the order must reach the
 * listing row, /orders and /state, where the site reads it.
 *
 * HOW: the technique of roll.idle.test.ts. The keeper's own client methods and the vol fetch seam
 * are replaced per test and restored after; the RPC in the environment is a discard port and
 * ALERT_WEBHOOK is unset, so alerts land in SQLite. The fixture's 25 Sep calls are re-dated to
 * the week the head block implies, and its clocks to an hour ago, so the file does not rot as the
 * calendar moves on.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';

/* ---- environment first: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-roll-vol-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';
delete process.env.ALERT_WEBHOOK;
for (const key of ['KEEPER_PRICING_MODE', 'KEEPER_TARGET_DELTA', 'KEEPER_PRICE_EDGE_BPS', 'KEEPER_PREMIUM_MARGIN_BPS', 'KEEPER_UNIT_PRICE_USDG6', 'KEEPER_STRIKE_BAND_BUFFER_BPS', 'KEEPER_ARM_LEAD_S', 'KEEPER_NYSE_HOLIDAYS']) {
  delete process.env[key];
}

const { publicClient, walletClient } = await import('./clients.js');
const { config, vaultAddress } = await import('./config.js');
const { newYorkParts, nextWeekWindow } = await import('./calendar.js');
const { optionIdFor, weeklyTuple } = await import('./optionType.js');
const { planWeek, priceListing } = await import('./policy.js');
const { VOL_MIN_REFETCH_MS, VOL_REPRICE_UP_CHECK_MS, formatUsdg, resetVolCache, tick, volSource } = await import('./roll.js');
const { buildApp } = await import('./health.js');
const { buildOrderComponents, componentsToJson, localOrderHash } = await import('./seaport.js');
const { store } = await import('./state.js');
const { VolFetchError, closeDayOf } = await import('./vol.js');
const { syntheticNvdaChain } = await import('./fixtures/synthetic-chains.js');
type CboeChain = import('./vol.js').CboeChain;
type OrderComponentsStruct = import('./seaport.js').OrderComponentsStruct;

const LOT = 1_000_000_000_000_000_000n;
const ZERO32 = `0x${'00'.repeat(32)}` as const;
const SPOT = 212_210_000n;
const FIXTURE = syntheticNvdaChain();

interface Call {
  address?: string;
  functionName: string;
  args?: readonly unknown[];
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The fixture's 25 Sep calls, listed for `closeDay`, last traded an hour before `now`. */
function liveChain(now: number, closeDay: string): CboeChain {
  const ny = newYorkParts(now - 3_600);
  const utc = new Date((now - 1_800) * 1000);
  return {
    ...FIXTURE,
    timestamp: `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())} ${pad(utc.getUTCHours())}:${pad(utc.getUTCMinutes())}:${pad(utc.getUTCSeconds())}`,
    lastTradeTime: `${ny.year}-${pad(ny.month)}-${pad(ny.day)}T${pad(ny.hour)}:${pad(ny.minute)}:${pad(ny.second)}`,
    options: FIXTURE.options.filter((o) => o.expiry === '2026-09-25').map((o) => ({ ...o, expiry: closeDay })),
  };
}

function idleReads(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: 0,
    writesHalted: false,
    valoremFeeAccepted: false,
    cycleNumber: 0,
    cycleExerciseTs: 0n,
    cycleExpiryTs: 0n,
    cycleStrikeUsdg: 0n,
    optionId: 0n,
    claimKey: 0n,
    contractsWritten: 0n,
    listingHash: ZERO32,
    listingGrossUsdg: 0n,
    listingAmount: 0n,
    listingsThisCycle: 0,
    idleAssets: 25n * LOT,
    totalAssets: 25n * LOT,
    lockedAssets: 0n,
    isStranded: false,
    strandGen: 0n,
    queuedShares: 0n,
    KEEPER_ROLE: ZERO32,
    policy: [300, 1200, 40, 9500, 500, 50n],
    spotUsdg: SPOT,
    feesEnabled: false,
    feeBps: 15,
    hasRole: true,
    oraclePaused: false,
    getCounter: 0n,
    ...overrides,
  };
}

function lastAlertId(): number {
  return (store.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM alerts').get() as { n: number }).n;
}

function alertsSince(id: number): Array<{ kind: string; message: string; data: Record<string, unknown> }> {
  return (store.db.prepare('SELECT kind, message, data_json FROM alerts WHERE id > ? ORDER BY id').all(id) as Array<{ kind: string; message: string; data_json: string | null }>).map((a) => ({
    kind: a.kind,
    message: a.message,
    data: a.data_json === null ? {} : (JSON.parse(a.data_json) as Record<string, unknown>),
  }));
}

/** Stub every client method a tick can touch; `reads` is mutated by the writes, like a chain. */
function stubChain(reads: Record<string, unknown>, onWrite: (call: Call) => void = () => undefined) {
  const simulated: string[] = [];
  const statuses = new Map<string, [boolean, boolean, bigint, bigint]>();
  const mocks = [
    mock.method(publicClient, 'readContract', async (call: Call) => {
      if (call.functionName === 'getOrderHash') return localOrderHash(call.args?.[0] as OrderComponentsStruct);
      if (call.functionName === 'getOrderStatus') return statuses.get(String(call.args?.[0])) ?? [true, false, 0n, 0n];
      if (!(call.functionName in reads)) throw new Error(`unstubbed read ${call.functionName}`);
      return reads[call.functionName];
    }),
    mock.method(publicClient, 'getBlock', async () => ({ number: 1_001n, timestamp: reads.__now as bigint })),
    mock.method(publicClient, 'getBalance', async () => 10n ** 18n),
    mock.method(publicClient, 'simulateContract', async (call: Call) => {
      simulated.push(call.functionName);
      return { request: call };
    }),
    mock.method(walletClient, 'writeContract', async (call: Call) => {
      onWrite(call);
      return `0x${(simulated.length.toString(16) + 'e').repeat(64).slice(0, 64)}`;
    }),
    mock.method(publicClient, 'waitForTransactionReceipt', async ({ hash }: { hash: string }) => ({
      status: 'success',
      blockNumber: 1_000n,
      gasUsed: 100_000n,
      transactionHash: hash,
      logs: [],
    })),
  ];
  return { simulated, statuses, restore: () => mocks.forEach((m) => m.mock.restore()) };
}

/*//////////////////////////////////////////////////////////////
                               SKIPS
//////////////////////////////////////////////////////////////*/

test('Idle, vol mode: a failed or stale fetch is a remembered skip with an alert, nothing is simulated, and an empty vault fetches nothing', async () => {
  assert.equal(config.KEEPER_PRICING_MODE, 'vol', 'the default');
  const now = Math.floor(Date.now() / 1000);
  const window = nextWeekWindow(now, config.KEEPER_ARM_LEAD_S, config.KEEPER_NYSE_HOLIDAYS);
  const reads = idleReads({ __now: BigInt(now) });
  let fetches = 0;
  let answer: () => Promise<CboeChain> = async () => {
    throw new VolFetchError('timeout', 'no complete response within 10000 ms');
  };
  const chain = stubChain(reads);
  const fetchMock = mock.method(volSource, 'fetch', async () => {
    fetches += 1;
    return answer();
  });
  resetVolCache();
  try {
    let before = lastAlertId();
    await tick(); // must not throw
    assert.equal(fetches, 1);
    // The next tick inside VOL_MIN_REFETCH_MS reuses the failure rather than hammering Cboe.
    await tick();
    assert.equal(fetches, 1, `no second download within ${VOL_MIN_REFETCH_MS} ms`);
    assert.equal(store.getMeta(`skip_reason:${window.exerciseTs}`), 'vol-unavailable');
    assert.deepEqual(chain.simulated, [], 'no option type, no rollOpen: the week is not armed on a guess');
    assert.equal(store.getMeta(`skip_reason:${window.exerciseTs}`), 'vol-unavailable');
    const skip = alertsSince(before).find((a) => a.kind === 'cycle_not_created');
    assert.ok(skip, 'the operator hears about it while there is time');
    assert.equal(skip.data.reason, 'vol-unavailable');
    assert.match(String(skip.data.error), /timeout/);
    assert.equal(store.latestCycle(), null);

    // A chain from last week: stale, by name.
    const old = liveChain(now - 6 * 86_400, window.closeDay);
    answer = async () => old;
    resetVolCache();
    before = lastAlertId();
    await tick();
    assert.equal(store.getMeta(`skip_reason:${window.exerciseTs}`), 'vol-stale');
    assert.equal(alertsSince(before).find((a) => a.kind === 'cycle_not_created')?.data.reason, 'vol-stale');
    assert.deepEqual(chain.simulated, []);

    // A chain without this week's expiry.
    answer = async () => liveChain(now, '1999-01-01');
    resetVolCache();
    await tick();
    assert.equal(store.getMeta(`skip_reason:${window.exerciseTs}`), 'vol-no-expiry');

    // Nothing to sell: decided without a request.
    reads.totalAssets = 0n;
    fetches = 0;
    resetVolCache();
    await tick();
    assert.equal(fetches, 0, 'an empty vault costs Cboe nothing');
    assert.equal(store.getMeta(`skip_reason:${window.exerciseTs}`), 'no-capacity');
  } finally {
    fetchMock.mock.restore();
    chain.restore();
  }
});

/*//////////////////////////////////////////////////////////////
                           ARM AND LIST
//////////////////////////////////////////////////////////////*/

test('Idle, vol mode: one fetch arms the delta strike and prices its listing; the record reaches the rows, the alerts, /orders and /state', async () => {
  const now = Math.floor(Date.now() / 1000);
  const window = nextWeekWindow(now, config.KEEPER_ARM_LEAD_S, config.KEEPER_NYSE_HOLIDAYS);
  const chainData = liveChain(now, window.closeDay);
  const reads = idleReads({ __now: BigInt(now), tokenType: 1 });
  const expected = planWeek({
    policy: { minOtmBps: 300n, maxOtmBps: 1200n, minPremiumBps: 40n, maxUtilizationBps: 9500n, protocolFeeBps: 500n, maxContractsCap: 50n },
    spotUsdg6: SPOT,
    totalAssets: 25n * LOT,
    contractsWritten: 0n,
    feesEnabled: false,
    feeBps: 15,
    vol: { chain: chainData, error: null, closeDay: window.closeDay, nowSeconds: now },
  });
  assert.ok(expected.ok);
  assert.ok(expected.strikeUsdg6 > SPOT, 'synthetic delta selection stays out of the money');
  const expectedStrike = expected.strikeUsdg6.toString();
  const expectedUnit = expected.unitPrice6.toString();
  const expectedFair = expected.pricing.fairUnit6;

  const tokenTypeQueries: bigint[] = [];
  const chain = stubChain(reads, (call) => {
    if (call.functionName === 'rollOpen') {
      Object.assign(reads, {
        phase: 1,
        cycleNumber: 1,
        cycleExerciseTs: BigInt(window.exerciseTs),
        cycleExpiryTs: BigInt(window.expiryTs),
        cycleStrikeUsdg: expected.strikeUsdg6,
        optionId: call.args?.[0],
      });
    }
    if (call.functionName === 'approveListing') {
      const components = call.args?.[0] as OrderComponentsStruct;
      Object.assign(reads, { listingHash: localOrderHash(components), listingsThisCycle: 1, listingAmount: 23n });
    }
  });
  const readMock = publicClient.readContract as unknown as { mock: { calls: Array<{ arguments: [Call] }> } };
  let fetches = 0;
  resetVolCache();
  const fetchMock = mock.method(volSource, 'fetch', async (url: string, options: { timeoutMs: number; maxBytes: number }) => {
    fetches += 1;
    assert.equal(url, 'https://cdn.cboe.com/api/global/delayed_quotes/options/NVDA.json');
    assert.deepEqual(options, { timeoutMs: 10_000, maxBytes: 8_000_000 });
    return chainData;
  });
  const before = lastAlertId();
  try {
    await tick();
  } finally {
    fetchMock.mock.restore();
    for (const c of readMock.mock.calls) if (c.arguments[0].functionName === 'tokenType') tokenTypeQueries.push(c.arguments[0].args?.[0] as bigint);
    chain.restore();
  }

  assert.equal(fetches, 1, 'the arm and its first listing read ONE market');
  assert.deepEqual(chain.simulated, ['rollOpen', 'approveListing']);
  const armedId = optionIdFor(weeklyTuple(config.ASSET, config.USDG, expected.strikeUsdg6, window.exerciseTs, window.expiryTs));
  assert.deepEqual(tokenTypeQueries, [armedId], 'the option type carries the selected strike');

  const cycle = store.getCycle(1);
  assert.ok(cycle);
  assert.equal(cycle.strike_usdg6, expectedStrike);
  const armPricing = JSON.parse(cycle.pricing_json ?? 'null') as Record<string, unknown>;
  assert.equal(armPricing.mode, 'vol');
  assert.equal(armPricing.deltaStrikeUsdg6, expected.pricing.deltaStrikeUsdg6);
  assert.equal(armPricing.expiry, window.closeDay);

  const listings = store.listingsForCycle(1);
  assert.equal(listings.length, 1);
  const listing = listings[0]!;
  assert.equal(listing.unit_price6, expectedUnit);
  assert.equal(listing.contracts, '23');
  assert.equal(listing.gross_usdg6, (expected.unitPrice6 * 23n).toString());
  const listingPricing = JSON.parse(listing.pricing_json ?? 'null') as Record<string, unknown>;
  assert.deepEqual(listingPricing, JSON.parse(JSON.stringify(expected.pricing)), 'the listing carries exactly the plan’s record');

  const alerts = alertsSince(before);
  const rollOpen = alerts.find((a) => a.kind === 'roll_open');
  assert.ok(rollOpen);
  assert.equal(rollOpen.data.strikeUsdg, formatUsdg(expected.strikeUsdg6));
  assert.equal(rollOpen.data.strikeOtmBps, expected.pricing.strikeOtmBps);
  assert.equal(rollOpen.data.fairUnitUsdg, expectedFair === null ? null : formatUsdg(BigInt(expectedFair)));
  assert.equal(rollOpen.data.unitPriceUsdg, formatUsdg(expected.unitPrice6));
  assert.equal(rollOpen.data.targetDelta, 0.15);
  assert.ok(typeof rollOpen.data.deltaAtStrike === 'number' && typeof rollOpen.data.ivAtStrike === 'number');
  assert.match(rollOpen.message, /bps over spot 212\.21, delta .* \(target 0\.15\), Cboe iv .* fair /);
  const listed = alerts.find((a) => a.kind === 'listing');
  assert.ok(listed);
  assert.equal(listed.data.priceSource, 'vol-fair');
  assert.equal(listed.data.unitPriceUsdg, formatUsdg(expected.unitPrice6), 'the existing alert field keeps its name and meaning');
  assert.equal(listed.data.floorUnitUsdg, formatUsdg(expected.floorUnit6));
  assert.equal(listed.data.pricingMode, 'vol');

  const app = buildApp();
  const orders = (await (await app.request('/orders')).json()) as { orders: Array<Record<string, unknown>> };
  assert.equal(orders.orders.length, 1);
  const order = orders.orders[0]!;
  assert.equal(order.unitPrice6, expectedUnit, 'the existing fields are unchanged');
  assert.equal(order.contracts, '23');
  assert.deepEqual(order.pricing, listingPricing, '/orders serves the record, parsed');
  const state = (await (await app.request('/state')).json()) as Record<string, unknown> & { pricing: Record<string, unknown> | null; vault: Record<string, unknown> };
  assert.deepEqual(state.pricing, listingPricing, '/state serves the live cycle’s latest listing record');
  assert.equal(state.vault.strikeUsdg6, expectedStrike);
});

/*//////////////////////////////////////////////////////////////
                              REPRICE
//////////////////////////////////////////////////////////////*/

/** A cycle Listed on `listing` at 0.857329, with spot rallied to 218 so the fill floor is 0.872. */
function seedRallied(cycleNumber: number, salt: bigint, pricingJson: string | null) {
  const now = Math.floor(Date.now() / 1000);
  const exerciseTs = now + 3 * 86_400;
  const optionId = (0xabc000n + BigInt(cycleNumber)) << 96n;
  const components = buildOrderComponents({ vault: vaultAddress(), optionId, contracts: 23n, unitPrice6: 857_329n, endTime: BigInt(exerciseTs), counter: 0n, salt });
  const orderHash = localOrderHash(components);
  store.ensureCycle(cycleNumber, 'open');
  store.updateCycle(cycleNumber, { contracts: 0, strike_usdg6: '225000000', exercise_ts: exerciseTs, pricing_json: pricingJson });
  store.insertListing({
    order_hash: orderHash,
    cycle_number: cycleNumber,
    seq: 1,
    option_id: optionId.toString(),
    contracts: '23',
    unit_price6: '857329',
    gross_usdg6: (857_329n * 23n).toString(),
    end_time: exerciseTs,
    counter: '0',
    salt: salt.toString(),
    components_json: JSON.stringify(componentsToJson(components)),
    signature: '0x',
    approve_tx: `0x${'a1'.repeat(32)}`,
    cancel_tx: null,
    status: 'approved',
    seaport_total_filled: null,
    seaport_total_size: null,
    seaport_cancelled: null,
    pricing_json: pricingJson,
  });
  const reads = idleReads({
    __now: BigInt(now),
    phase: 1,
    cycleNumber,
    cycleExerciseTs: BigInt(exerciseTs),
    cycleExpiryTs: BigInt(exerciseTs + 86_400),
    cycleStrikeUsdg: 225_000_000n,
    optionId,
    claimKey: optionId | 1n,
    listingHash: orderHash,
    listingGrossUsdg: 857_329n * 23n,
    listingAmount: 23n,
    listingsThisCycle: 1,
    spotUsdg: 218_000_000n,
  });
  return { orderHash, reads };
}

test('Listed, vol mode, feed dark: the reprice falls back to the previous listing’s fair value, with one fetch for the whole decision', async () => {
  const previous = JSON.stringify({ mode: 'vol', fairUnit6: '860864', strikeClamped: null, deltaStrikeUsdg6: '225000000', targetDelta: 0.15, bandBufferBps: 50 });
  const { orderHash, reads } = seedRallied(7, 7n, previous);
  const chain = stubChain(reads, (call) => {
    if (call.functionName === 'cancelListing') {
      Object.assign(reads, { listingHash: ZERO32, listingGrossUsdg: 0n, listingAmount: 0n });
      chain.statuses.set(orderHash, [true, true, 0n, 0n]);
    }
    if (call.functionName === 'approveListing') {
      Object.assign(reads, { listingHash: localOrderHash(call.args?.[0] as OrderComponentsStruct), listingsThisCycle: 2 });
    }
  });
  let fetches = 0;
  resetVolCache();
  const fetchMock = mock.method(volSource, 'fetch', async () => {
    fetches += 1;
    throw new VolFetchError('http-status', 'HTTP 503');
  });
  try {
    await tick();
  } finally {
    fetchMock.mock.restore();
    chain.restore();
  }

  assert.equal(fetches, 1, 'the pre-cancel check and the relist share one fetch');
  assert.deepEqual(chain.simulated, ['cancelListing', 'approveListing']);
  assert.equal(store.getListing(orderHash)?.status, 'cancelled');
  const relist = store.listingsForCycle(7).find((l) => l.seq === 2);
  assert.ok(relist, 'replaced');
  // ceil(860864 x 1.1) = 946951 against the rallied floor ceil(ceil(218 x 40 bps) x 1.01) = 880720.
  assert.equal(relist.unit_price6, '946951');
  const pricing = JSON.parse(relist.pricing_json ?? 'null') as Record<string, unknown>;
  assert.equal(pricing.volPath, 'previous-fair');
  assert.equal(pricing.priceSource, 'vol-previous-fair');
  assert.equal(pricing.volUnavailableReason, 'vol-unavailable');
  assert.equal(pricing.fairUnit6, '860864');
  assert.equal(pricing.deltaStrikeUsdg6, '225000000', 'the arm’s strike context comes from the cycle row');
  assert.equal(store.getCycle(7)?.relists_used, 1);
});

test('Listed, vol mode, feed dark and no previous fair value: the live listing is NOT cancelled for a relist that cannot be priced', async () => {
  const { orderHash, reads } = seedRallied(8, 8n, null);
  const chain = stubChain(reads);
  resetVolCache();
  const fetchMock = mock.method(volSource, 'fetch', async () => {
    throw new VolFetchError('timeout', 'no complete response within 10000 ms');
  });
  const before = lastAlertId();
  try {
    await tick();
  } finally {
    fetchMock.mock.restore();
    chain.restore();
  }
  assert.deepEqual(chain.simulated, [], 'no cancel, no approval: a slot is not spent on nothing');
  assert.equal(store.getListing(orderHash)?.status, 'approved');
  const warn = alertsSince(before).find((a) => a.kind === 'fill_sim_revert');
  assert.ok(warn);
  assert.equal(warn.data.reason, 'vol-unavailable');
  assert.match(warn.message, /cannot be priced \(vol-unavailable\); leaving the listing in place/);

  // /orders still serves the untouched listing, with no record for a row that never had one.
  const orders = (await (await buildApp().request('/orders')).json()) as { orders: Array<{ orderHash: string; pricing: unknown }> };
  assert.equal(orders.orders.find((o) => o.orderHash === orderHash)?.pricing, null);
});

/*//////////////////////////////////////////////////////////////
                    REPRICE UP, FIRST LISTING, /state
//////////////////////////////////////////////////////////////*/

const LAUNCH_POLICY = { minOtmBps: 300n, maxOtmBps: 1200n, minPremiumBps: 40n, maxUtilizationBps: 9500n, protocolFeeBps: 500n, maxContractsCap: 50n };
const ARM_RECORD = JSON.stringify({ mode: 'vol', fairUnit6: '860864', strikeClamped: null, deltaStrikeUsdg6: '225000000', targetDelta: 0.15, bandBufferBps: 200 });

/** A cycle Listed on one vol-priced listing at `unitPrice6` (strike 225, 23 contracts). */
function seedVolListing(cycleNumber: number, salt: bigint, opts: { unitPrice6: bigint; spot: bigint; listingsThisCycle: number; pricingJson: string | null }) {
  const now = Math.floor(Date.now() / 1000);
  const exerciseTs = now + 3 * 86_400;
  const optionId = (0xabc000n + BigInt(cycleNumber)) << 96n;
  const components = buildOrderComponents({ vault: vaultAddress(), optionId, contracts: 23n, unitPrice6: opts.unitPrice6, endTime: BigInt(exerciseTs), counter: 0n, salt });
  const orderHash = localOrderHash(components);
  store.ensureCycle(cycleNumber, 'open');
  store.updateCycle(cycleNumber, { contracts: 0, strike_usdg6: '225000000', exercise_ts: exerciseTs, pricing_json: ARM_RECORD });
  store.insertListing({
    order_hash: orderHash,
    cycle_number: cycleNumber,
    seq: opts.listingsThisCycle,
    option_id: optionId.toString(),
    contracts: '23',
    unit_price6: opts.unitPrice6.toString(),
    gross_usdg6: (opts.unitPrice6 * 23n).toString(),
    end_time: exerciseTs,
    counter: '0',
    salt: salt.toString(),
    components_json: JSON.stringify(componentsToJson(components)),
    signature: '0x',
    approve_tx: `0x${'a2'.repeat(32)}`,
    cancel_tx: null,
    status: 'approved',
    seaport_total_filled: null,
    seaport_total_size: null,
    seaport_cancelled: null,
    pricing_json: opts.pricingJson,
  });
  const reads = idleReads({
    __now: BigInt(now),
    phase: 1,
    cycleNumber,
    cycleExerciseTs: BigInt(exerciseTs),
    cycleExpiryTs: BigInt(exerciseTs + 86_400),
    cycleStrikeUsdg: 225_000_000n,
    optionId,
    claimKey: optionId | 1n,
    listingHash: orderHash,
    listingGrossUsdg: opts.unitPrice6 * 23n,
    listingAmount: 23n,
    listingsThisCycle: opts.listingsThisCycle,
    spotUsdg: opts.spot,
  });
  return { now, exerciseTs, orderHash, reads, chainData: liveChain(now, closeDayOf(exerciseTs)) };
}

const VOL_LISTING_RECORD = JSON.stringify({ mode: 'vol', fairUnit6: '860864', unitPrice6: '946951' });

test('Listed, vol mode: a rally leaves the ask far under the market while fills still clear; the listing is repriced UP from fresh data', async () => {
  // Friday's ask 0.946951 at strike 225. Spot +2% (216.45): the fill gate still passes (floor 222.94,
  // premium floor 0.8658), but the market-based ask at the armed strike is now ~1.78.
  const { orderHash, reads, chainData, now } = seedVolListing(11, 11n, { unitPrice6: 946_951n, spot: 216_450_000n, listingsThisCycle: 1, pricingJson: VOL_LISTING_RECORD });
  const expected = priceListing({
    policy: LAUNCH_POLICY,
    spotUsdg6: 216_450_000n,
    strikeUsdg6: 225_000_000n,
    contracts: 23n,
    feesEnabled: false,
    feeBps: 15,
    vol: { chain: chainData, error: null, closeDay: chainData.options[0]!.expiry, nowSeconds: now },
    previousFairUnit6: null,
  });
  assert.ok(expected.ok);
  assert.equal(expected.pricing.volPath, 'fresh');
  assert.ok(expected.unitPrice6 * 10_000n > 946_951n * 12_500n, `the market ask ${expected.unitPrice6} is more than 25% over the live one`);

  const chain = stubChain(reads, (call) => {
    if (call.functionName === 'cancelListing') {
      Object.assign(reads, { listingHash: ZERO32, listingGrossUsdg: 0n, listingAmount: 0n });
      chain.statuses.set(orderHash, [true, true, 0n, 0n]);
    }
    if (call.functionName === 'approveListing') {
      Object.assign(reads, { listingHash: localOrderHash(call.args?.[0] as OrderComponentsStruct), listingsThisCycle: 2, listingAmount: 23n });
    }
  });
  let fetches = 0;
  resetVolCache();
  const fetchMock = mock.method(volSource, 'fetch', async () => {
    fetches += 1;
    return chainData;
  });
  try {
    await tick();
  } finally {
    fetchMock.mock.restore();
    chain.restore();
  }
  assert.equal(fetches, 1, 'the check and the relist share one fetch');
  assert.deepEqual(chain.simulated, ['cancelListing', 'approveListing']);
  assert.equal(store.getListing(orderHash)?.status, 'cancelled');
  const relist = store.listingsForCycle(11).find((l) => l.order_hash !== orderHash);
  assert.ok(relist);
  assert.equal(relist.unit_price6, expected.unitPrice6.toString());
  const pricing = JSON.parse(relist.pricing_json ?? 'null') as Record<string, unknown>;
  assert.equal(pricing.volPath, 'fresh');
  assert.equal(pricing.priceSource, 'vol-fair');
  assert.equal(pricing.deltaStrikeUsdg6, '225000000', 'the arm’s strike context is carried');
});

test('Listed, vol mode: no upward reprice without a spare slot, below the threshold, more often than every 30 minutes, or for a listing not priced in vol mode', async () => {
  // Only one slot left: it is kept for a floor reprice, and the operator is told.
  {
    const { orderHash, reads, chainData } = seedVolListing(12, 12n, { unitPrice6: 946_951n, spot: 216_450_000n, listingsThisCycle: 2, pricingJson: VOL_LISTING_RECORD });
    const chain = stubChain(reads);
    resetVolCache();
    const fetchMock = mock.method(volSource, 'fetch', async () => chainData);
    const before = lastAlertId();
    try {
      await tick();
    } finally {
      fetchMock.mock.restore();
      chain.restore();
    }
    assert.deepEqual(chain.simulated, []);
    assert.equal(store.getListing(orderHash)?.status, 'approved');
    const warn = alertsSince(before).find((a) => a.data.reason === 'reprice-up-no-slot');
    assert.ok(warn, 'alerted');
    assert.equal(warn.data.liveUnitUsdg, '0.946951');
  }

  // The live ask is safely above the synthetic market: nothing to do, and checks are throttled past the 5-minute
  // download cache.
  {
    const { orderHash, reads, chainData } = seedVolListing(13, 13n, { unitPrice6: 5_000_000n, spot: 212_210_000n, listingsThisCycle: 1, pricingJson: JSON.stringify({ mode: 'vol', fairUnit6: '4500000', unitPrice6: '5000000' }) });
    const chain = stubChain(reads);
    resetVolCache();
    let fetches = 0;
    const fetchMock = mock.method(volSource, 'fetch', async () => {
      fetches += 1;
      return chainData;
    });
    const realNow = Date.now();
    let offset = 0;
    const clock = mock.method(Date, 'now', () => realNow + offset);
    try {
      await tick();
      assert.equal(fetches, 1);
      offset = VOL_MIN_REFETCH_MS + 60_000;
      await tick();
      assert.equal(fetches, 1, 'the download cache has expired, the upward check has not');
      offset = VOL_REPRICE_UP_CHECK_MS + 60_000;
      await tick();
      assert.equal(fetches, 2, 'checked again after 30 minutes');
    } finally {
      clock.mock.restore();
      fetchMock.mock.restore();
      chain.restore();
    }
    assert.deepEqual(chain.simulated, []);
    assert.equal(store.getListing(orderHash)?.status, 'approved');
  }

  // A listing with no vol record (fixed mode, or older than vol mode): never fetched for.
  {
    const { reads, chainData } = seedVolListing(14, 14n, { unitPrice6: 946_951n, spot: 216_450_000n, listingsThisCycle: 1, pricingJson: null });
    const chain = stubChain(reads);
    resetVolCache();
    let fetches = 0;
    const fetchMock = mock.method(volSource, 'fetch', async () => {
      fetches += 1;
      return chainData;
    });
    try {
      await tick();
    } finally {
      fetchMock.mock.restore();
      chain.restore();
    }
    assert.equal(fetches, 0);
    assert.deepEqual(chain.simulated, []);
  }
});

test('Listed, vol mode, no listing yet and the feed dark: the first listing falls back to the fair value the arm was priced on', async () => {
  const now = Math.floor(Date.now() / 1000);
  const exerciseTs = now + 3 * 86_400;
  const optionId = 0xabc0f0n << 96n;
  store.ensureCycle(15, 'open');
  store.updateCycle(15, { contracts: 0, strike_usdg6: '225000000', exercise_ts: exerciseTs, pricing_json: ARM_RECORD });
  const reads = idleReads({
    __now: BigInt(now),
    phase: 1,
    cycleNumber: 15,
    cycleExerciseTs: BigInt(exerciseTs),
    cycleExpiryTs: BigInt(exerciseTs + 86_400),
    cycleStrikeUsdg: 225_000_000n,
    optionId,
    claimKey: optionId | 1n,
    listingsThisCycle: 0,
  });
  const chain = stubChain(reads, (call) => {
    if (call.functionName === 'approveListing') {
      Object.assign(reads, { listingHash: localOrderHash(call.args?.[0] as OrderComponentsStruct), listingsThisCycle: 1, listingAmount: 23n });
    }
  });
  resetVolCache();
  const fetchMock = mock.method(volSource, 'fetch', async () => {
    throw new VolFetchError('http-status', 'HTTP 503');
  });
  try {
    await tick();
  } finally {
    fetchMock.mock.restore();
    chain.restore();
  }
  assert.deepEqual(chain.simulated, ['approveListing'], 'the armed week is offered, not left empty');
  const listing = store.listingsForCycle(15)[0];
  assert.ok(listing);
  assert.equal(listing.unit_price6, '946951', 'ceil(860864 x 1.1): the arm’s market-based ask');
  const pricing = JSON.parse(listing.pricing_json ?? 'null') as Record<string, unknown>;
  assert.equal(pricing.volPath, 'previous-fair');
  assert.equal(pricing.volUnavailableReason, 'vol-unavailable');
});

test('/state: pricing is null while the vault is Idle, so a closed week’s ask never reads as current', async () => {
  const now = Math.floor(Date.now() / 1000);
  // Cycle 15 (above) has a listing with a record. The vault has since closed it and is Idle, with
  // nothing to sell this tick.
  assert.ok(store.listingsForCycle(15).length > 0);
  const reads = idleReads({ __now: BigInt(now), cycleNumber: 15, totalAssets: 0n, idleAssets: 0n });
  const chain = stubChain(reads);
  resetVolCache();
  try {
    await tick();
  } finally {
    chain.restore();
  }
  const state = (await (await buildApp().request('/state')).json()) as { pricing: unknown; listings: unknown[]; phase: string };
  assert.equal(state.phase, 'Idle');
  assert.ok(state.listings.length > 0, 'the cycle’s rows are still listed for reference');
  assert.equal(state.pricing, null);
});
