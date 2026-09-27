/**
 * The cranker's stale-ask step (INTERFACE_VERSION 7) through the real `stepStale` on a fake chain.
 *
 * WHY THIS FILE EXISTS: an AutoRoller ask the spot has overtaken is free money for the first taker, and nothing else
 * withdraws it — `reprice` refuses (`InTheMoney`) and the writer may be asleep. The decision table is pinned in
 * planner.test.ts; what is pinned HERE is the wiring, which is where a keeper goes quietly wrong: reading the SERIES'
 * OWN pinned oracle for the spot (not the registry default and not `market(u).oracle`, which a
 * `setMarketOracle` moves away from every series already created), comparing against the SERIES' strike, sending with the fixed
 * `GAS.cancelStale`, not sending for a writer the contract would answer `false` for, ordering the bounty-paying
 * cancels first and capping the rest, and paging `v2_stale_cancel_failed` at `warn` when the writer revoked the
 * roller and at `error` otherwise.
 *
 * DELIBERATELY ABSENT: an RPC. ops/devnet (v2:devnet-cycle) runs the same code on a chain.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getAddress, type Address } from 'viem';
import { loadV2Config, type CrankerConfig } from '../config.js';
import { silentLogger } from '../logger.js';
import { V2Store } from '../store.js';
import type { TxOutcome } from '../tx.js';
import { GAS } from './constants.js';
import { CrankAlerts, type CrankSender, type FixedGasCall } from './effects.js';
import { CrankerIndex } from './index-store.js';
import { STEP_ORDER, stepStale, type CrankContext } from './steps.js';

const REGISTRY = fileURLToPath(new URL('../fixtures/registry-v2.json', import.meta.url));
const CH = getAddress('0x2256c045245288A314048aD2d71006a564343C63');
const ROLLER = getAddress('0xC42b6f89b9970cd5a8e7bFC21D6CbB02F8f82302');
/** The market's own oracle, deliberately NOT the registry's default: a spot read from the wrong one is the bug. */
const MARKET_ORACLE = getAddress('0x4b8c2BEFfecbdc4BeD6e6826e62093F0Cf635E78');
/**
 * Two series' pinned oracles, both different from each other AND from the market's pointer: the post-migration shape
 * a `setMarketOracle` leaves behind. Distinct from MARKET_ORACLE on purpose - a mirror that read the market's would
 * read neither of these, so the assertion on `spotFrom` fails rather than passing on a coincidence.
 */
const SERIES_ORACLE_A = getAddress('0x1111111111111111111111111111111111111111');
const SERIES_ORACLE_B = getAddress('0x2222222222222222222222222222222222222222');
const ZERO = '0x0000000000000000000000000000000000000000';
/** Source 1 of the expiry's settlement configuration: the pool TWAP on the launch markets. */
const WITNESS_SOURCE = getAddress('0x3333333333333333333333333333333333333333');
const T0 = 1_789_750_000;
const E = 1_789_934_400;
const STRIKE = 220_000_000n;

interface Writer {
  writer: Address;
  /** AutoRoller.position: longId, orderId, expiry. */
  position: readonly [bigint, bigint, number];
  order: { units: bigint; filled: bigint; validUntil: number; cancelled: boolean; maker: Address };
}

function harness(
  writers: Writer[],
  options: {
    spot?: bigint;
    oracle?: Address;
    /** The oracle `series(longId)` reports as pinned. Default: the market's, the pre-migration shape. */
    seriesOracleOf?: (longId: bigint) => Address;
    /** The trySpot answer of ONE oracle address, lower-case. Default: the single `state.spot` for every oracle. */
    spotOf?: (oracle: string) => readonly [boolean, bigint];
    /**
     * The witness chain AutoRoller._tryWitness reads: settlementConfig's source list, the Stock Token's
     * oraclePaused ('revert' = the view reverts) and source 1's latest (price, age in seconds before the head, ok).
     * Absent: settlementConfig is not answered, so no witness exists (the earlier fake chain).
     */
    witness?: { sources?: readonly Address[]; paused?: boolean | 'revert'; price?: bigint; ageS?: number; ok?: boolean };
  } = {},
) {
  const config = loadV2Config({
    V2_MODE: 'cranker',
    RH_RPC: 'http://127.0.0.1:9',
    CRANKER_PK: `0x${'3c'.repeat(32)}`,
    CRANKER_PORT: '0',
    KEEPER_DB_PATH: ':memory:',
    POLL_INTERVAL_MS: '1000',
    V2_REGISTRY_PATH: REGISTRY,
    V2_CLEARINGHOUSE: CH,
    V2_CONTRACTS_FROM_ENV: '1',
  }) as CrankerConfig;
  const nvda = config.registry.markets.find((m) => m.ticker === 'NVDA')!;

  const state = { now: T0, block: 65_000_000n, spot: options.spot ?? 225_000_000n, spotOk: true, spotFrom: [] as string[], configReads: [] as string[], latestFrom: [] as string[] };
  const byOrderId = new Map(writers.map((w) => [w.position[1].toString(), w.order]));

  const client = {
    getBlock: async () => ({ number: state.block, timestamp: BigInt(state.now) }),
    getBlockNumber: async () => state.block,
    multicall: async ({ contracts }: { contracts: Array<{ functionName: string; args?: readonly unknown[]; address: Address }> }) =>
      contracts.map((c) => {
        const args = c.args ?? [];
        switch (c.functionName) {
          case 'position': {
            const w = writers.find((x) => x.writer.toLowerCase() === String(args[0]).toLowerCase());
            return { status: 'success', result: w?.position ?? [0n, 0n, 0] };
          }
          case 'market':
            return { status: 'success', result: { enabled: true, mintPaused: false, strikeTick: 1_000_000n, exerciseFeeBps: 25, oracle: options.oracle ?? MARKET_ORACLE, mintFeePpm: 80 } };
          case 'minRollUnits':
            return { status: 'success', result: 100n };
          case 'getOrders':
            return {
              status: 'success',
              result: (args[0] as bigint[]).map((id) => {
                const o = byOrderId.get(id.toString());
                return o === undefined
                  ? { maker: ZERO, longId: 0n, kind: 2, price: 0n, units: 0n, filled: 0n, validUntil: 0, cancelled: false }
                  : { maker: o.maker, longId: 1n, kind: 2, price: 1_000_000n, units: o.units, filled: o.filled, validUntil: o.validUntil, cancelled: o.cancelled };
              }),
            };
          case 'series': {
            const oracle = options.seriesOracleOf?.(args[0] as bigint) ?? MARKET_ORACLE;
            return { status: 'success', result: { underlying: nvda.underlying, oracle, settled: false, settlementPrice: 0n, isPut: false, strike: STRIKE, expiry: E, mintFeePpm: 80 } };
          }
          case 'trySpot': {
            state.spotFrom.push(c.address.toLowerCase());
            const per = options.spotOf?.(c.address.toLowerCase());
            return { status: 'success', result: per === undefined ? [state.spotOk, state.spot, BigInt(state.now)] : [per[0], per[1], BigInt(state.now)] };
          }
          case 'settlementConfig': {
            if (options.witness === undefined) return { status: 'failure', error: new Error('no view settlementConfig') };
            state.configReads.push(`${c.address.toLowerCase()}:${String(args[0]).toLowerCase()}:${args[1]}`);
            return { status: 'success', result: [true, options.witness.sources ?? [MARKET_ORACLE, WITNESS_SOURCE], 100, 3_600, 86_400] };
          }
          case 'oraclePaused': {
            const paused = options.witness?.paused ?? false;
            return paused === 'revert' ? { status: 'failure', error: new Error('reverted') } : { status: 'success', result: paused };
          }
          case 'latest': {
            state.latestFrom.push(c.address.toLowerCase());
            const w = options.witness ?? {};
            return { status: 'success', result: [w.ok ?? true, w.price ?? STRIKE + 1_000_000n, BigInt(state.now - (w.ageS ?? 60))] };
          }
          default:
            return { status: 'failure', error: new Error(`no view ${c.functionName}`) };
        }
      }),
    readContract: async () => {
      throw new Error('no readContract');
    },
    simulateContract: async () => ({ result: true, request: {} }),
  };

  const sends: Array<{ fn: string; gas: bigint; args: readonly unknown[] }> = [];
  const outcomes: TxOutcome[] = [];
  const sender: CrankSender = {
    dryRun: false,
    account: '0x000000000000000000000000000000000000beef',
    async execute(call: FixedGasCall) {
      sends.push({ fn: call.functionName, gas: call.gas, args: call.args as readonly unknown[] });
      return outcomes.shift() ?? { status: 'confirmed', hash: `0x${'ab'.repeat(32)}`, nonce: 1, blockNumber: state.block, gasUsed: 1n, result: true };
    },
  };

  const store = new V2Store(':memory:');
  const index = new CrankerIndex(store);
  index.bind({ chainId: config.chainId, clearinghouse: CH, orderBook: config.contracts.orderBook, autoRoller: ROLLER });
  index.applyRange({ series: [], holders: [], orders: [], strategies: writers.map((w) => ({ writer: w.writer, underlying: nvda.underlying })), block: 1n }, 1n);
  const alerts: Array<{ kind: string; message: string; data: Record<string, unknown>; severity?: string; dedupeKey?: string }> = [];
  const cleared: string[] = [];
  const alerter = {
    alert: async (kind: string, message: string, data: Record<string, unknown> = {}, o: { dedupeKey?: string; severity?: string } = {}) => (alerts.push({ kind, message, data, dedupeKey: o.dedupeKey, severity: o.severity }), true),
    clear: (kind: string, key?: string) => void cleared.push(`${kind}:${key}`),
  };
  const ctx: CrankContext = {
    config,
    log: silentLogger(),
    client: client as never,
    logClient: { getLogs: async () => [] } as never,
    addresses: { clearinghouse: CH, orderBook: config.contracts.orderBook, settlementOracle: config.contracts.settlementOracle, expiryCalendar: config.contracts.expiryCalendar, autoRoller: ROLLER, feeSplitter: null, multicall3: config.multicall3 },
    store,
    index,
    sender,
    alerts: new CrankAlerts(alerter as never, store, false),
    indexer: null,
  };
  return { ctx, state, sends, alerts, cleared, outcomes, nvda };
}

const writer = (n: number, over: Partial<Writer> = {}): Writer => ({
  writer: getAddress(`0x${n.toString(16).padStart(40, '0')}`),
  position: [1n, BigInt(1_000 + n), E],
  order: { units: 500n, filled: 0n, validUntil: T0 + 3_600, cancelled: false, maker: ROLLER },
  ...over,
});

test('the stale step runs first of the sending steps, right after the index', () => {
  assert.deepEqual([...STEP_ORDER].slice(0, 3), ['index', 'stale', 'snapshot']);
});

test('stepStale: an overtaken ask is cancelled with the fixed gas, from the SERIES\' pinned oracle, against the series\' strike', async () => {
  const h = harness([writer(1)]);
  const report = await stepStale(h.ctx);
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0]!.fn, 'cancelStale');
  assert.equal(h.sends[0]!.gas, GAS.cancelStale);
  assert.deepEqual(h.sends[0]!.args, [getAddress('0x' + '0'.repeat(39) + '1'), getAddress(h.nvda.underlying)]);
  assert.deepEqual(h.state.spotFrom, [MARKET_ORACLE.toLowerCase()], 'the spot comes from the oracle the SERIES pinned (here the market\'s, pre-migration)');
  assert.deepEqual(report.notes.reasons, { cancel: 1 });
  assert.equal((report.notes.cancelled as unknown[]).length, 1);
  assert.equal(h.alerts.length, 0);
});

test('stepStale: nothing is sent for a writer the contract itself would answer false for', async () => {
  // A spot short of the strike, a spot the oracle will not give, an ask that is gone, and a period that is over.
  const short = harness([writer(1)], { spot: STRIKE - 1n });
  await stepStale(short.ctx);
  assert.equal(short.sends.length, 0);
  assert.deepEqual(short.ctx === undefined ? {} : (await stepStale(short.ctx)).notes.reasons, { 'not-overtaken': 1 });

  const stale = harness([writer(1)]);
  stale.state.spotOk = false;
  assert.deepEqual((await stepStale(stale.ctx)).notes.reasons, { 'spot-stale': 1 });
  assert.equal(stale.sends.length, 0);

  const dead = harness([writer(1, { order: { units: 500n, filled: 500n, validUntil: T0 + 3_600, cancelled: false, maker: ROLLER } })]);
  assert.deepEqual((await stepStale(dead.ctx)).notes.reasons, { 'order-dead': 1 });
  assert.equal(dead.sends.length, 0);

  // No tracked ask and a period already over never even reach the order read.
  const none = harness([writer(1, { position: [1n, 0n, E] }), writer(2, { position: [1n, 77n, T0 - 1] })]);
  const report = await stepStale(none.ctx);
  assert.equal(none.sends.length, 0);
  assert.equal(report.notes.withLiveAsk, 0);
});

test('stepStale: bounty-paying cancels go first and the dust ones are capped per tick', async () => {
  // Twelve writers whose remainder is under minRollUnits (100) and one whose is not.
  const dust = Array.from({ length: 12 }, (_, k) => writer(10 + k, { order: { units: 500n, filled: 450n, validUntil: T0 + 3_600, cancelled: false, maker: ROLLER } }));
  const h = harness([...dust, writer(99)]);
  const report = await stepStale(h.ctx);
  const sent = h.sends.map((s) => String(s.args[0]).toLowerCase());
  assert.equal(sent[0], writer(99).writer.toLowerCase(), 'the one that pays the bounty is sent first');
  assert.equal(report.notes.belowMinRollUnitsSent, 10);
  assert.equal(sent.length, 11, 'one bounty cancel plus ten dust ones');
  assert.equal(report.notes.overtaken, 13);
});

test('stepStale: a refused simulation pages — warn when the writer revoked the roller, error otherwise; a later cancel clears it', async () => {
  const h = harness([writer(1)]);
  h.outcomes.push({ status: 'simulation-reverted', revert: 'NotAuthorized', error: 'reverted' });
  await stepStale(h.ctx);
  assert.equal(h.alerts.length, 1);
  assert.equal(h.alerts[0]!.kind, 'v2_stale_cancel_failed');
  assert.equal(h.alerts[0]!.severity, 'warn', 'only the writer can restore its own delegate');
  assert.equal(h.alerts[0]!.data.delegateRevoked, true);
  assert.match(h.alerts[0]!.message, /revoked the roller/);
  assert.equal(h.alerts[0]!.data.strike, STRIKE);

  h.outcomes.push({ status: 'simulation-reverted', revert: 'TradingPaused', error: 'reverted' });
  await stepStale(h.ctx);
  assert.equal(h.alerts[1]!.severity, 'error', 'anything else is the admin\'s or the guardian\'s');

  // The next tick cancels: the condition is cleared so its return pages at once instead of waiting out the cooldown.
  await stepStale(h.ctx);
  assert.ok(h.cleared.some((c) => c.startsWith('v2_stale_cancel_failed:')));
});

test('stepStale: no AutoRoller configured is a skip, not an error', async () => {
  const h = harness([writer(1)]);
  h.ctx.addresses = { ...h.ctx.addresses, autoRoller: null };
  const report = await stepStale(h.ctx);
  assert.equal(h.sends.length, 0);
  assert.match(String(report.notes.skipped), /no autoRoller/);
});

test('stepStale: two series on ONE underlying with different pinned oracles are each judged on their own', async () => {
  // The shape a setMarketOracle leaves behind: the market's pointer moved, every series already created kept the
  // oracle createSeries pinned into it, and AutoRoller.cancelStale reads THAT one. Series 1 is overtaken on
  // its oracle and series 2 is not, while the market's pointer would say neither is — so a mirror that still read
  // `market(u).oracle` sends nothing and leaves an in-the-money ask resting for the first taker.
  const h = harness([writer(1), writer(2, { position: [2n, 1_002n, E] })], {
    seriesOracleOf: (longId) => (longId === 1n ? SERIES_ORACLE_A : SERIES_ORACLE_B),
    spotOf: (oracle) => {
      if (oracle === SERIES_ORACLE_A.toLowerCase()) return [true, STRIKE + 5_000_000n];
      if (oracle === SERIES_ORACLE_B.toLowerCase()) return [true, STRIKE - 10_000_000n];
      return [true, STRIKE - 10_000_000n]; // the market's pointer: short of the strike, so reading it cancels nothing
    },
  });
  const report = await stepStale(h.ctx);

  assert.deepEqual(
    [...new Set(h.state.spotFrom)].sort(),
    [SERIES_ORACLE_A.toLowerCase(), SERIES_ORACLE_B.toLowerCase()].sort(),
    'one trySpot per pinned series oracle, and the market\'s pointer is never asked',
  );
  assert.ok(!h.state.spotFrom.includes(MARKET_ORACLE.toLowerCase()), 'market(u).oracle is not a spot source for an existing series');
  assert.deepEqual(report.notes.reasons, { cancel: 1, 'not-overtaken': 1 });
  assert.equal(h.sends.length, 1, 'only the series whose OWN oracle has overtaken it is withdrawn');
  assert.equal(String(h.sends[0]!.args[0]).toLowerCase(), writer(1).writer.toLowerCase());
  const cancelled = report.notes.cancelled as Array<{ oracle: string | null; spot: bigint | null }>;
  assert.equal(String(cancelled[0]!.oracle).toLowerCase(), SERIES_ORACLE_A.toLowerCase(), 'the report names the oracle the decision was made on');
  assert.equal(cancelled[0]!.spot, STRIKE + 5_000_000n);
});

test('stepStale: a series with no pinned oracle is judged on no oracle at all', async () => {
  // Fail closed. An unreadable or zero oracle means the spot the contract would use is unknown, so no other oracle's
  // price stands in for it: the series is dropped as unread, no trySpot is issued and nothing is sent. `unread` rather
  // than `spot-stale` on purpose - the report says the SERIES could not be trusted, not that some oracle was stale.
  const h = harness([writer(1)], { seriesOracleOf: () => ZERO as Address });
  const report = await stepStale(h.ctx);
  assert.deepEqual(h.state.spotFrom, [], 'no spot is read from any oracle for a series with no pinned one');
  assert.equal(h.sends.length, 0);
  assert.deepEqual(report.notes.reasons, { unread: 1 });
});

/*//////////////////////////////////////////////////////////////
        THE WITNESS PATH
//////////////////////////////////////////////////////////////*/

test('stepStale: Chainlink silent and the pool witness past the strike -> cancelStale is sent', async () => {
  // AutoRoller.cancelStale reads the expiry's witness when the spot declines. Earlier this step stopped at the
  // spot, so this exact state (nights, weekends) answered spot-stale and the in-the-money ask stayed live.
  const h = harness([writer(1)], { witness: {} });
  h.state.spotOk = false;
  const report = await stepStale(h.ctx);
  assert.equal(h.sends.length, 1, 'the cancel the contract would make is sent');
  assert.equal(h.sends[0]!.fn, 'cancelStale');
  assert.deepEqual(report.notes.reasons, { cancel: 1 });
  const cancelled = report.notes.cancelled as Array<{ via: string; witness: bigint }>;
  assert.equal(cancelled[0]!.via, 'witness');
  assert.equal(cancelled[0]!.witness, STRIKE + 1_000_000n);
  assert.deepEqual(h.state.configReads, [`${MARKET_ORACLE.toLowerCase()}:${h.nvda.underlying.toLowerCase()}:${E}`], 'settlementConfig of the SERIES\' pinned oracle at the SERIES\' expiry');
  assert.deepEqual(h.state.latestFrom, [WITNESS_SOURCE.toLowerCase()], 'latest is read from source 1');
});

test('stepStale: a spot short of the strike still consults the witness, as the contract does', async () => {
  const h = harness([writer(1)], { spot: STRIKE - 1n, witness: { price: STRIKE } });
  const report = await stepStale(h.ctx);
  assert.equal(h.sends.length, 1);
  assert.equal((report.notes.cancelled as Array<{ via: string }>)[0]!.via, 'witness');
});

test('stepStale: a spot that settles the ask never reads the witness', async () => {
  const h = harness([writer(1)], { witness: {} });
  await stepStale(h.ctx);
  assert.equal(h.sends.length, 1);
  assert.deepEqual(h.state.configReads, [], 'the contract takes the spot path first and never reaches _tryWitness');
});

test('stepStale: every _tryWitness refusal is a null witness, so nothing is sent', async () => {
  const cases: Array<[string, { sources?: readonly Address[]; paused?: boolean | 'revert'; price?: bigint; ageS?: number; ok?: boolean }]> = [
    ['one source: no source 1', { sources: [MARKET_ORACLE] }],
    ['issuer oracle paused', { paused: true }],
    ['oraclePaused reverts (counts as paused)', { paused: 'revert' }],
    ['latest not ok', { ok: false }],
    ['latest price zero', { price: 0n }],
    ['latest price above 2^128 - 1', { price: 1n << 128n }],
    ['latest older than WITNESS_MAX_AGE', { ageS: 1_801 }],
    ['latest in the future', { ageS: -1 }],
    ['witness short of the strike', { price: STRIKE - 1n }],
  ];
  for (const [label, witness] of cases) {
    const h = harness([writer(1)], { witness });
    h.state.spotOk = false;
    const report = await stepStale(h.ctx);
    assert.equal(h.sends.length, 0, `${label}: nothing is sent`);
    assert.ok(!('cancel' in (report.notes.reasons as Record<string, number>)), `${label}: not planned`);
  }
  // The age bound is inclusive at WITNESS_MAX_AGE, as `block.timestamp - t > WITNESS_MAX_AGE` refuses only past it.
  const edge = harness([writer(1)], { witness: { ageS: 1_800 } });
  edge.state.spotOk = false;
  await stepStale(edge.ctx);
  assert.equal(edge.sends.length, 1, 'exactly 30 minutes old is still a witness');
});
