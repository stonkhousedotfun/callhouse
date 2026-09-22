/**
 * A market whose `Clearinghouse.market(u)` read fails, through the real stale, ladder and roll steps on a fake chain.
 *
 * WHY THIS FILE EXISTS: oracles are per market, and each of these steps reads its spot from the oracle the market()
 * read names. A failed read used to fall back to the registry's settlementOracle (`?? ctx.addresses.settlementOracle`),
 * so the next multicall asked a DIFFERENT oracle for the spot and the step decided on it as if it were the market's own
 * price. Pinned here: when market(u) fails the way an allowFailure multicall reports it, no trySpot is read for that
 * market from any oracle, no cancel, roll or create is decided for it on a price, the report says which market was
 * unread, and the other markets of the same tick are processed as usual. And the opposite half, which a fix that just
 * dropped the fallback would break: a market whose read succeeds is priced from ITS oracle, never the default one.
 *
 * The two oracles in every test DISAGREE on purpose. With both answering the same spot every path agrees and the test
 * proves nothing.
 *
 * DELIBERATELY ABSENT: an RPC. ops/devnet (v2:devnet-cycle) runs the same code on a chain.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { loadV2Config, type CrankerConfig } from '../config.js';
import { silentLogger } from '../logger.js';
import { V2Store } from '../store.js';
import { CrankAlerts, type CrankSender, type FixedGasCall } from './effects.js';
import { CrankerIndex } from './index-store.js';
import { stepLadders, stepRolls, stepStale, type CrankContext } from './steps.js';

const REGISTRY = fileURLToPath(new URL('../fixtures/registry-v2.json', import.meta.url));
const CH = getAddress('0x2256c045245288A314048aD2d71006a564343C63');
const ROLLER = getAddress('0xC42b6f89b9970cd5a8e7bFC21D6CbB02F8f82302');
/** The registry's default settlementOracle: the address a failed market() read used to fall back to. */
const DEFAULT_ORACLE = getAddress('0x00000000000000000000000000000000Dead0001');
/** Two market oracles, neither of them the default. */
const ORACLE_A = getAddress('0x4b8c2BEFfecbdc4BeD6e6826e62093F0Cf635E78');
const ORACLE_B = getAddress('0x157f589Cd9d0E4a94C9936ede3b23BEfa3017F20');
const T0 = 1_789_750_000;
const E = 1_789_934_400;
const STRIKE = 220_000_000n;
/** At or past the strike: a call ask here is overtaken. */
const OVER = 260_000_000n;
/** Below the strike: nothing is overtaken. */
const UNDER = 200_000_000n;

interface Writer {
  writer: Address;
  underlying: 'NVDA' | 'TSLA';
  /** AutoRoller.position: longId, orderId, expiry. */
  position: readonly [bigint, bigint, number];
}

interface Options {
  /** Per ticker: the market's oracle, or 'fail' for a market() read the multicall reports as failed. */
  market: Record<'NVDA' | 'TSLA', Address | 'fail'>;
  /** Per oracle: the spot trySpot answers (ok, fresh). Unlisted oracles answer not-ok. */
  spot: Map<string, bigint>;
  writers?: Writer[];
}

function harness(options: Options) {
  const config = loadV2Config({
    V2_MODE: 'cranker',
    RH_RPC: 'http://127.0.0.1:9',
    CRANKER_PK: `0x${'3c'.repeat(32)}`,
    CRANKER_PORT: '0',
    KEEPER_DB_PATH: ':memory:',
    POLL_INTERVAL_MS: '1000',
    V2_REGISTRY_PATH: REGISTRY,
    V2_CLEARINGHOUSE: CH,
    // Deliberate: this harness drives its own addresses past the fixture registry (config.ts).
    V2_CONTRACTS_FROM_ENV: '1',
  }) as CrankerConfig;
  // One daily expiry, two call rungs per market: small enough to read.
  const markets = config.registry.markets.filter((m) => m.v2?.status === 'live');
  for (const m of markets) {
    m.v2!.puts = false;
    m.v2!.params.expiriesAhead = { weekly: 0, daily: 1 };
    m.v2!.params.ladder.daily = { ...m.v2!.params.ladder.daily, rungs: 2, firstOtmBps: 100, stepBps: 100 };
  }
  const nvda = markets.find((m) => m.ticker === 'NVDA')!;
  const tsla = markets.find((m) => m.ticker === 'TSLA')!;
  const tickerOf = (u: unknown) => (String(u).toLowerCase() === nvda.underlying.toLowerCase() ? 'NVDA' : String(u).toLowerCase() === tsla.underlying.toLowerCase() ? 'TSLA' : `? ${String(u)}`);
  const underlyingOf = (t: 'NVDA' | 'TSLA') => (t === 'NVDA' ? nvda.underlying : tsla.underlying);

  const writers = (options.writers ?? []).map((w) => ({ ...w, address: underlyingOf(w.underlying) }));
  /** Every trySpot read, as `<ticker> from <oracle>`: which oracle the step chose for which market. */
  const spotFrom: string[] = [];
  const nameOf = (a: Address) => ({ [DEFAULT_ORACLE.toLowerCase()]: 'DEFAULT', [ORACLE_A.toLowerCase()]: 'A', [ORACLE_B.toLowerCase()]: 'B' })[a.toLowerCase()] ?? a;

  const views: Record<string, (args: readonly unknown[], address: Address) => { status: 'success'; result: unknown } | { status: 'failure'; error: Error }> = {
    market: ([u]) => {
      const o = options.market[tickerOf(u) as 'NVDA' | 'TSLA'];
      // allowFailure: a reverted or unreachable view is a failed outcome in the batch, not a thrown multicall.
      if (o === undefined || o === 'fail') return { status: 'failure', error: new Error('market() reverted') };
      return { status: 'success', result: { enabled: true, mintPaused: false, strikeTick: 1_000_000n, exerciseFeeBps: 25, oracle: o, mintFeePpm: 80 } };
    },
    trySpot: ([u], address) => {
      spotFrom.push(`${tickerOf(u)} from ${nameOf(address)}`);
      const spot = options.spot.get(address.toLowerCase());
      return { status: 'success', result: spot === undefined ? [false, 0n, 0n] : [true, spot, BigInt(T0 - 60)] };
    },
    // Stale step.
    position: ([writer, u]) => {
      const w = writers.find((x) => x.writer.toLowerCase() === String(writer).toLowerCase() && x.address.toLowerCase() === String(u).toLowerCase());
      return { status: 'success', result: w?.position ?? [0n, 0n, 0] };
    },
    minRollUnits: () => ({ status: 'success', result: 100n }),
    getOrders: ([ids]) => ({
      status: 'success',
      result: (ids as bigint[]).map(() => ({ maker: ROLLER, longId: 1n, kind: 2, price: 1_000_000n, units: 500n, filled: 0n, validUntil: T0 + 3_600, cancelled: false })),
    }),
    series: () => ({ status: 'success', result: { underlying: nvda.underlying, oracle: ORACLE_A, settled: false, settlementPrice: 0n, isPut: false, strike: STRIKE, expiry: E, mintFeePpm: 80 } }),
    // Rolls step.
    isRegularSession: () => ({ status: 'success', result: true }),
    strategy: () => ({ status: 'success', result: { active: true, weekly: false, smartPricing: false, maxUnits: 0n } }),
    free: () => ({ status: 'success', result: 10n ** 22n }),
    // Ladders step: every expiry already pinned by this Clearinghouse, so creates need no probe.
    createPaused: () => ({ status: 'success', result: false }),
    seriesExists: () => ({ status: 'success', result: false }),
    pinnedBy: () => ({ status: 'success', result: CH }),
    settlementConfig: () => ({ status: 'success', result: [true, [ORACLE_A], 150, 21_600, 90_000] }),
  };

  const client = {
    getBlock: async () => ({ number: 65_000_000n, timestamp: BigInt(T0) }),
    getBlockNumber: async () => 65_000_000n,
    multicall: async ({ contracts }: { contracts: Array<{ functionName: string; args?: readonly unknown[]; address: Address }> }) =>
      contracts.map((c) => views[c.functionName]?.(c.args ?? [], c.address) ?? { status: 'failure', error: new Error(`no view ${c.functionName}`) }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'nextExpiry') return E;
      throw new Error(`no readContract ${functionName}`);
    },
    simulateContract: async () => ({ result: 1n, request: {} }),
  };

  /** Every write, as `<fn> <ticker>`; a createSeries batch as one entry per series. */
  const sends: string[] = [];
  const sender: CrankSender = {
    dryRun: false,
    account: '0x000000000000000000000000000000000000beef',
    async execute(call: FixedGasCall) {
      const args = call.args as readonly unknown[];
      if (call.functionName === 'aggregate3') {
        const calls = (args as unknown as [Array<{ callData: Hex }>])[0];
        for (const c of calls) sends.push(`createSeries ${tickerOf((decodeFunctionData({ abi: clearinghouseAbi, data: c.callData }).args as readonly unknown[])[0])}`);
        return { status: 'confirmed', hash: `0x${'ab'.repeat(32)}`, nonce: 1, blockNumber: 65_000_000n, gasUsed: 1n, result: calls.map(() => ({ success: true, returnData: '0x' })) };
      }
      sends.push(`${call.functionName} ${tickerOf(args[1])}`);
      return { status: 'confirmed', hash: `0x${'ab'.repeat(32)}`, nonce: 1, blockNumber: 65_000_000n, gasUsed: 1n, result: true };
    },
  };

  const store = new V2Store(':memory:');
  const index = new CrankerIndex(store);
  index.bind({ chainId: config.chainId, clearinghouse: CH, orderBook: config.contracts.orderBook, autoRoller: ROLLER });
  index.applyRange({ series: [], holders: [], orders: [], strategies: writers.map((w) => ({ writer: w.writer, underlying: w.address })), block: 1n }, 1n);
  const alerter = { alert: async () => true, clear: () => undefined };
  const ctx: CrankContext = {
    config,
    log: silentLogger(),
    client: client as never,
    logClient: { getLogs: async () => [] } as never,
    addresses: { clearinghouse: CH, orderBook: config.contracts.orderBook, settlementOracle: DEFAULT_ORACLE, expiryCalendar: config.contracts.expiryCalendar, autoRoller: ROLLER, feeSplitter: null, multicall3: config.multicall3 },
    store,
    index,
    sender,
    alerts: new CrankAlerts(alerter as never, store, false),
    indexer: null,
  };
  return { ctx, sends, spotFrom };
}

const writer = (n: number, underlying: 'NVDA' | 'TSLA', position: readonly [bigint, bigint, number] = [1n, BigInt(1_000 + n), E]): Writer => ({
  writer: getAddress(`0x${n.toString(16).padStart(40, '0')}`),
  underlying,
  position,
});

test('stale: a market whose market() read FAILED has no ask cancelled on a substituted price; the other market still is', async () => {
  // NVDA's market() fails. The default oracle, which the old fallback read NVDA's spot from, says overtaken.
  const h = harness({
    market: { NVDA: 'fail', TSLA: ORACLE_B },
    spot: new Map([[DEFAULT_ORACLE.toLowerCase(), OVER], [ORACLE_B.toLowerCase(), OVER]]),
    writers: [writer(1, 'NVDA'), writer(2, 'TSLA')],
  });
  const report = await stepStale(h.ctx);
  assert.deepEqual(h.sends, ['cancelStale TSLA'], 'nothing is cancelled for NVDA, whose oracle is unknown');
  assert.deepEqual(h.spotFrom, ['TSLA from B'], 'no spot is read for NVDA from any oracle, the default included');
  assert.deepEqual(report.notes.reasons, { 'market-unread': 1, cancel: 1 });
  assert.deepEqual(report.notes.marketUnread, ['NVDA'], 'the report names the market it could not read');
});

test('stale: a market whose market() read SUCCEEDS is priced from its own oracle, never the default one', async () => {
  // The oracles disagree in both directions: each market's own says overtaken, the default says not.
  const over = harness({
    market: { NVDA: ORACLE_A, TSLA: ORACLE_B },
    spot: new Map([[DEFAULT_ORACLE.toLowerCase(), UNDER], [ORACLE_A.toLowerCase(), OVER], [ORACLE_B.toLowerCase(), OVER]]),
    writers: [writer(1, 'NVDA'), writer(2, 'TSLA')],
  });
  const report = await stepStale(over.ctx);
  assert.deepEqual([...over.spotFrom].sort(), ['NVDA from A', 'TSLA from B']);
  assert.deepEqual([...over.sends].sort(), ['cancelStale NVDA', 'cancelStale TSLA']);
  assert.equal(report.notes.marketUnread, undefined);

  // And the other way round: each market's own says not overtaken, the default says overtaken.
  const under = harness({
    market: { NVDA: ORACLE_A, TSLA: ORACLE_B },
    spot: new Map([[DEFAULT_ORACLE.toLowerCase(), OVER], [ORACLE_A.toLowerCase(), UNDER], [ORACLE_B.toLowerCase(), UNDER]]),
    writers: [writer(1, 'NVDA'), writer(2, 'TSLA')],
  });
  assert.deepEqual((await stepStale(under.ctx)).notes.reasons, { 'not-overtaken': 2 });
  assert.deepEqual(under.sends, []);
});

test('ladders: a market whose market() read FAILED reads no spot from the default oracle and says why it was skipped; the other market is laddered', async () => {
  const h = harness({
    market: { NVDA: 'fail', TSLA: ORACLE_B },
    spot: new Map([[DEFAULT_ORACLE.toLowerCase(), 100_000_000n], [ORACLE_B.toLowerCase(), 100_000_000n]]),
  });
  const report = await stepLadders(h.ctx);
  assert.deepEqual(h.spotFrom, ['TSLA from B'], 'no spot is read for NVDA from any oracle, the default included');
  assert.ok(h.sends.length > 0 && h.sends.every((s) => s === 'createSeries TSLA'), `only TSLA is created (${h.sends.join(', ')})`);
  const notes = report.notes.markets as Array<{ ticker: string; skipped?: string }>;
  assert.match(String(notes.find((n) => n.ticker === 'NVDA')?.skipped), /market\(\) read failed/, 'a failed read is not reported as an unregistered market');
  assert.equal(notes.find((n) => n.ticker === 'TSLA')?.skipped, undefined);
});

test('rolls: a market whose market() read FAILED gets no new roll on a substituted spot; its close-out and the other market still roll', async () => {
  // NVDA's market() fails and the default oracle says fresh; TSLA's own oracle says fresh.
  const fresh = writer(1, 'NVDA', [0n, 0n, 0]);
  const closeOut = writer(2, 'NVDA', [7n, 0n, T0 - 1]);
  const other = writer(3, 'TSLA', [0n, 0n, 0]);
  const h = harness({
    market: { NVDA: 'fail', TSLA: ORACLE_B },
    spot: new Map([[DEFAULT_ORACLE.toLowerCase(), 100_000_000n], [ORACLE_B.toLowerCase(), 100_000_000n]]),
    writers: [fresh, closeOut, other],
  });
  const report = await stepRolls(h.ctx);
  const decisions = report.notes.decisions as Array<{ writer: string; roll: boolean; reason: string; marketUnread?: boolean }>;
  const of = (w: Writer) => decisions.find((d) => d.writer.toLowerCase() === w.writer.toLowerCase())!;
  assert.deepEqual({ roll: of(fresh).roll, reason: of(fresh).reason, marketUnread: of(fresh).marketUnread }, { roll: false, reason: 'spot-stale', marketUnread: true }, 'NVDA is not rolled on the default oracle\'s spot');
  // A close-out does not read the spot: the roller settles it on the series' own terms.
  assert.deepEqual({ roll: of(closeOut).roll, reason: of(closeOut).reason }, { roll: true, reason: 'close-out' });
  assert.deepEqual({ roll: of(other).roll, reason: of(other).reason, marketUnread: of(other).marketUnread }, { roll: true, reason: 'roll', marketUnread: undefined });
  assert.deepEqual([...h.sends].sort(), ['roll NVDA', 'roll TSLA'], 'the NVDA send is the close-out');
  assert.deepEqual(h.spotFrom, ['TSLA from B'], 'no spot is read for NVDA from any oracle, the default included');
  assert.deepEqual(report.notes.marketUnread, ['NVDA']);
});

/*//////////////////////////////////////////////////////////////
                 HOUSE VAULT EPOCH ROLL (T-OP-117)
//////////////////////////////////////////////////////////////*/

import { Budget, HOUSE_ROLL_GAS, HOUSE_ROLL_KIND, HOUSE_ROLL_OVERDUE_S, houseFactoryFor, houseRoll, newReport, send, type HouseRollReads, type HouseVaultRollView } from './steps.js';

const FACTORY = getAddress('0x00000000000000000000000000000000000fac70');
const HOUSE_A = getAddress('0x00000000000000000000000000000000000000a1');
const HOUSE_B = getAddress('0x00000000000000000000000000000000000000b2');
const HOUSE_ORACLE = getAddress('0x00000000000000000000000000000000000000c3');
const NVDA_TOKEN = getAddress('0x00000000000000000000000000000000000000d4');
const EPOCH_END = 1_790_020_800;

interface RollHarness {
  ctx: CrankContext;
  sends: Array<{ vault: Address; fn: string; gas: bigint; kind: string; key: string }>;
  raised: Array<{ kind: string; dedupeKey: string; message: string }>;
  cleared: Array<{ kind: string; dedupeKey: string }>;
  epochIdOf: Map<string, bigint>;
}

/** A cranker context whose sender records rollEpoch calls and advances the vault's epochId when it 'confirms'. */
function rollHarness(outcome: 'confirmed' | 'simulation-reverted' = 'confirmed'): RollHarness {
  const config = loadV2Config({ V2_MODE: 'cranker', RH_RPC: 'http://127.0.0.1:9', CRANKER_PK: `0x${'11'.repeat(32)}`, V2_REGISTRY_PATH: REGISTRY }) as CrankerConfig;
  const sends: RollHarness['sends'] = [];
  const raised: RollHarness['raised'] = [];
  const cleared: RollHarness['cleared'] = [];
  const epochIdOf = new Map<string, bigint>([[HOUSE_A.toLowerCase(), 7n], [HOUSE_B.toLowerCase(), 3n]]);
  const sender: CrankSender = {
    dryRun: false,
    account: '0x000000000000000000000000000000000000beef',
    async execute(call: FixedGasCall, options) {
      sends.push({ vault: call.address, fn: call.functionName, gas: call.gas, kind: options.kind, key: options.key });
      if (outcome === 'simulation-reverted') return { status: 'simulation-reverted', revert: 'NotSettled()', error: 'execution reverted: NotSettled()' };
      const k = call.address.toLowerCase();
      epochIdOf.set(k, (epochIdOf.get(k) ?? 0n) + 1n);
      return { status: 'confirmed', hash: `0x${'cd'.repeat(32)}`, nonce: 1, blockNumber: 65_000_000n, gasUsed: 1n, result: undefined };
    },
  };
  const store = new V2Store(':memory:');
  const alerts = {
    raise: async (a: { kind: string; dedupeKey: string; message: string }) => void raised.push({ kind: a.kind, dedupeKey: a.dedupeKey, message: a.message }),
    clear: (kind: string, dedupeKey: string) => void cleared.push({ kind, dedupeKey }),
  };
  const ctx: CrankContext = {
    config,
    log: silentLogger(),
    client: { readContract: async ({ functionName, address }: { functionName: string; address: Address }) => (functionName === 'epochId' ? epochIdOf.get(address.toLowerCase()) ?? 0n : assert.fail(`no chain read ${functionName}`)) } as never,
    logClient: { getLogs: async () => [] } as never,
    addresses: { clearinghouse: CH, orderBook: config.contracts.orderBook, settlementOracle: DEFAULT_ORACLE, expiryCalendar: config.contracts.expiryCalendar, autoRoller: null, feeSplitter: null, multicall3: config.multicall3 },
    store,
    index: new CrankerIndex(store),
    sender,
    alerts: alerts as never,
    indexer: null,
  };
  return { ctx, sends, raised, cleared, epochIdOf };
}

/** Reads for the roll, all injected: `flat` and `finalized` are per vault. */
function rollReads(over: Partial<HouseRollReads> & { flat?: Record<string, boolean>; finalized?: Record<string, boolean>; vaults?: Address[] } = {}): HouseRollReads {
  const vaults = over.vaults ?? [HOUSE_A, HOUSE_B];
  const flat = over.flat ?? {};
  const finalized = over.finalized ?? {};
  const view = (vault: Address): HouseVaultRollView => ({ epochEnd: EPOCH_END, epochId: vault === HOUSE_A ? 7n : 3n, underlying: NVDA_TOKEN, oracle: HOUSE_ORACLE, tracked: [11n, 12n] });
  return {
    factory: FACTORY,
    discover: async () => vaults,
    readVault: async (vault) => view(vault),
    readTracked: async (vault, tracked) => tracked.map((longId) => (flat[vault.toLowerCase()] ?? true ? { longId, settled: true, longs: 0n, shorts: 0n, live: 0n } : { longId, settled: longId === 11n, longs: longId === 11n ? 100n : 0n, shorts: 0n, live: 0n })),
    readFinalized: async () => true,
    ...over,
    ...(over.finalized === undefined ? {} : { readFinalized: async (_o: Address, _u: Address, _e: number) => true }),
  };
}

const headAt = (timestamp: number) => ({ blockNumber: 65_000_100n, timestamp });

test('house roll: due, Finalized and flat -> rollEpoch is sent from the cranker with the fixed gas, keyed vault:epochId; the overdue page is cleared', async () => {
  const h = rollHarness();
  const report = newReport('housekeeping');
  const notes = await houseRoll(h.ctx, report, new Budget(10), headAt(EPOCH_END + 300), rollReads({ vaults: [HOUSE_A] }));
  assert.equal(h.sends.length, 1);
  assert.deepEqual(h.sends[0], { vault: HOUSE_A, fn: 'rollEpoch', gas: HOUSE_ROLL_GAS, kind: HOUSE_ROLL_KIND, key: `${HOUSE_A.toLowerCase()}:7` });
  assert.equal(notes[0]!.decision, 'sent');
  assert.equal(notes[0]!.detail, 'confirmed');
  assert.equal(report.actions.filter((a) => a.kind === HOUSE_ROLL_KIND).length, 1, 'the action is in the housekeeping report under its own kind');
  assert.deepEqual(h.cleared, [{ kind: 'v2_house_roll_overdue', dedupeKey: HOUSE_A.toLowerCase() }]);
  assert.equal(h.raised.length, 0);
});

test('house roll: not yet due -> nothing sent, the overdue page is cleared (a hand roll or an earlier tick already moved epochEnd)', async () => {
  const h = rollHarness();
  const notes = await houseRoll(h.ctx, newReport('housekeeping'), new Budget(10), headAt(EPOCH_END - 1), rollReads({ vaults: [HOUSE_A] }));
  assert.equal(h.sends.length, 0);
  assert.equal(notes[0]!.decision, 'not-due');
  assert.deepEqual(h.cleared, [{ kind: 'v2_house_roll_overdue', dedupeKey: HOUSE_A.toLowerCase() }]);
});

test('house roll: due but the oracle is not Finalized -> not sent (it would revert NotSettled); no page inside the 7 h settlement window, a page past it', async () => {
  const h = rollHarness();
  const reads = rollReads({ vaults: [HOUSE_A], readFinalized: async () => false });
  const inside = await houseRoll(h.ctx, newReport('housekeeping'), new Budget(10), headAt(EPOCH_END + HOUSE_ROLL_OVERDUE_S - 60), reads);
  assert.equal(h.sends.length, 0, 'a NotSettled revert is predicted, not provoked');
  assert.equal(inside[0]!.decision, 'not-finalized');
  assert.equal(h.raised.length, 0, 'inside the uncorroborated delay the wait is the settlement chain working');
  const past = await houseRoll(h.ctx, newReport('housekeeping'), new Budget(10), headAt(EPOCH_END + HOUSE_ROLL_OVERDUE_S + 1), reads);
  assert.equal(past[0]!.decision, 'not-finalized');
  assert.equal(h.raised.length, 1);
  assert.equal(h.raised[0]!.kind, 'v2_house_roll_overdue');
  assert.equal(h.raised[0]!.dedupeKey, HOUSE_A.toLowerCase());
  assert.match(h.raised[0]!.message, /not-finalized/);
  assert.match(h.raised[0]!.message, /rollEpoch\(\) is permissionless/);
});

test('house roll: due and Finalized but a tracked series is unsettled or still held -> not sent, reason names the series', async () => {
  const h = rollHarness();
  const notes = await houseRoll(h.ctx, newReport('housekeeping'), new Budget(10), headAt(EPOCH_END + 300), rollReads({ vaults: [HOUSE_A], flat: { [HOUSE_A.toLowerCase()]: false } }));
  assert.equal(h.sends.length, 0);
  assert.equal(notes[0]!.decision, 'not-flat');
  // 11 is settled but 100 longs are still held; 12 is unsettled.
  assert.equal(notes[0]!.detail, '11:held/live,12:unsettled');
});

test('house roll: two vaults due on a budget of one -> the second is deferred as no-budget, never squeezed past MM_MAX_TX_PER_TICK', async () => {
  const h = rollHarness();
  const notes = await houseRoll(h.ctx, newReport('housekeeping'), new Budget(1), headAt(EPOCH_END + 300), rollReads());
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0]!.vault, HOUSE_A);
  assert.deepEqual(notes.map((n) => n.decision), ['sent', 'no-budget']);
});

test('house roll: a send whose simulation reverts is recorded with its reason and not resent in the same tick', async () => {
  const h = rollHarness('simulation-reverted');
  const report = newReport('housekeeping');
  const notes = await houseRoll(h.ctx, report, new Budget(10), headAt(EPOCH_END + 300), rollReads({ vaults: [HOUSE_A] }));
  assert.equal(h.sends.length, 1, 'one attempt, no blind retry');
  assert.equal(notes[0]!.decision, 'sent');
  assert.match(notes[0]!.detail ?? '', /^simulation-reverted: NotSettled/);
  assert.equal(report.actions[0]!.revert, 'NotSettled()');
  assert.equal(h.cleared.length, 0, 'a reverted roll does not clear the overdue page');
});

test('house roll: no factory configured -> a documented no-op, nothing read, nothing sent', async () => {
  const h = rollHarness();
  const notes = await houseRoll(h.ctx, newReport('housekeeping'), new Budget(10), headAt(EPOCH_END + 300), rollReads({ factory: null, discover: async () => assert.fail('must not enumerate') }));
  assert.deepEqual(notes, []);
  assert.equal(h.sends.length, 0);
});

test('houseFactoryFor: CRANKER_HOUSE_FACTORY wins, MM_HOUSE_FACTORY is the fallback, garbage is null (fail closed), checksum is canonical', () => {
  assert.equal(houseFactoryFor({}), null);
  assert.equal(houseFactoryFor({ MM_HOUSE_FACTORY: 'not-an-address' }), null);
  assert.equal(houseFactoryFor({ MM_HOUSE_FACTORY: FACTORY.toLowerCase() }), FACTORY);
  assert.equal(houseFactoryFor({ MM_HOUSE_FACTORY: HOUSE_A, CRANKER_HOUSE_FACTORY: FACTORY }), FACTORY);
});

/*//////////////////////////////////////////////////////////////
   T-556: a simulation the node never ANSWERED is paged as a transport failure, once per step kind
//////////////////////////////////////////////////////////////*/

/** A context whose sender returns one fixed outcome, with the alerts captured. Everything else is the roll harness's. */
function sendHarness(outcome: Awaited<ReturnType<CrankSender['execute']>>): RollHarness & { ctx: CrankContext } {
  const h = rollHarness();
  h.ctx.sender = { ...h.ctx.sender, execute: async (call: FixedGasCall, options) => {
    h.sends.push({ vault: call.address, fn: call.functionName, gas: call.gas, kind: options.kind, key: options.key });
    return outcome;
  } };
  return h;
}

const A_CALL: FixedGasCall = { address: HOUSE_A, abi: [], functionName: 'prune', args: [], gas: 100_000n };

test('send: a simulation with transportError pages v2_rpc_lag naming the node, keyed per step kind; nothing was sent', async () => {
  // The suspicion (T-202 #2): a node that stops answering simulations arrives as `simulation-reverted` and, below the
  // runtime's chain probe, nothing said so. The runtime catches a FULL outage (the probe throws); this is the PARTIAL one.
  const h = sendHarness({ status: 'simulation-reverted', revert: null, error: 'HTTP request failed: 429 Too Many Requests', transportError: true });
  const report = newReport('prune');
  const out = await send(h.ctx, report, new Budget(10), 'prune 3 orders', A_CALL, { kind: 'prune', key: 'chunk:1', worthSending: () => true });
  assert.equal(out.status, 'simulation-reverted');
  assert.equal(h.raised.length, 1, 'exactly one page');
  assert.equal(h.raised[0]!.kind, 'v2_rpc_lag', 'the kind the runtime uses for "no RPC answers", not v2_tx_revert');
  assert.equal(h.raised[0]!.dedupeKey, 'transport:prune', 'keyed per step kind: an hour-long outage pages once per step, not once per chunk');
  assert.match(h.raised[0]!.message, /did not answer the simulation/);
  assert.match(h.raised[0]!.message, /429 Too Many Requests/, 'the transport error text reaches the operator');
  assert.match(h.raised[0]!.message, /not a contract refusal/);
  // A second chunk of the same step in the same outage dedupes onto the same key.
  await send(h.ctx, report, new Budget(10), 'prune 2 orders', A_CALL, { kind: 'prune', key: 'chunk:2', worthSending: () => true });
  assert.equal(h.raised[1]!.dedupeKey, 'transport:prune');
  assert.equal(report.actions.length, 2, 'both attempts are still recorded in the report');
  assert.equal(report.actions[0]!.revert, null);
});

test('send: a simulation the node EXECUTED and refused is not a transport page (control), and neither is a revert without data', async () => {
  // The control that makes the test above mean something: the same status without the flag pages nothing here.
  const refused = sendHarness({ status: 'simulation-reverted', revert: 'NotSettled()', error: 'execution reverted: NotSettled()' });
  await send(refused.ctx, newReport('settle'), new Budget(10), 'settle', A_CALL, { kind: 'settle', key: 'x', worthSending: () => true });
  assert.equal(refused.raised.length, 0, 'a contract refusal is the step\'s business, not a transport page');
  // An out-of-gas: revert === null but NOT a transport failure (tx.ts isTransportError says so) -- fellShort's case, not this one.
  const oog = sendHarness({ status: 'simulation-reverted', revert: null, error: 'execution reverted' });
  await send(oog.ctx, newReport('prune'), new Budget(10), 'prune', A_CALL, { kind: 'prune', key: 'y', worthSending: () => true });
  assert.equal(oog.raised.length, 0, 'a revert without data is an out-of-gas to split, not a node that went quiet');
});

