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
 * The stale step is the exception (steps.ts stepStale): it judges an ask by its SERIES' pinned oracle and does not
 * read market() at all, so its two tests pin the same halves against series(longId) instead.
 *
 * The two oracles in every test DISAGREE on purpose. With both answering the same spot every path agrees and the test
 * proves nothing.
 *
 * DELIBERATELY ABSENT: an RPC. ops/devnet (v2:devnet-cycle) runs the same code on a chain.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ContractFunctionRevertedError, decodeFunctionData, encodeErrorResult, getAddress, type Address, type Hex } from 'viem';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { earnVaultAbi } from '../abi/earnVault.js';
import { loadV2Config, type CrankerConfig } from '../config.js';
import type { Weekday } from '../registry.js';
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
  /**
   * Per longId: the series' pinned oracle and its market, or 'fail' for a series() read the multicall reports as
   * failed. Unset: every series reads back pinned to ORACLE_A on NVDA (what the ladder and roll tests need).
   */
  series?: Record<string, { ticker: 'NVDA' | 'TSLA'; oracle: Address } | 'fail'>;
  /** A market whose registry row lists no dailies (SPCX's shape: weekly 2, daily 0). */
  noDailies?: 'NVDA' | 'TSLA';
  /** Writers whose AutoRoller strategy is weekly. Unlisted writers' strategies are daily. */
  weeklyWriters?: readonly Address[];
  /** A market's registry `dailyWeekdays` (NVDA's shape: mon, wed, fri). */
  dailyWeekdays?: { ticker: 'NVDA' | 'TSLA'; days: readonly Weekday[] };
  /** What the multicall's ExpiryCalendar.nextExpiry answers (the daily roll's close); unset: the read fails. */
  rollExpiry?: number;
  /** Clearinghouse.createPaused(), and a market's `enabled` / `strikeTick` (0 = not registered). 'fail' = the read fails. */
  createPaused?: boolean | 'fail';
  marketCfg?: Partial<Record<'NVDA' | 'TSLA', { enabled?: boolean; strikeTick?: bigint }>>;
  /** Every Clearinghouse.seriesExists read fails the way an allowFailure multicall reports it. */
  seriesExistsFails?: boolean;
  /** Writers whose Clearinghouse.free(writer, u) read fails. */
  freeFails?: readonly Address[];
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
  if (options.noDailies !== undefined) markets.find((m) => m.ticker === options.noDailies)!.v2!.params.expiriesAhead = { weekly: 2, daily: 0 };
  if (options.dailyWeekdays !== undefined) markets.find((m) => m.ticker === options.dailyWeekdays!.ticker)!.v2!.params.dailyWeekdays = options.dailyWeekdays.days;
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
      const cfg = options.marketCfg?.[tickerOf(u) as 'NVDA' | 'TSLA'];
      return { status: 'success', result: { enabled: cfg?.enabled ?? true, mintPaused: false, strikeTick: cfg?.strikeTick ?? 1_000_000n, exerciseFeeBps: 25, oracle: o, mintFeePpm: 80 } };
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
    series: ([id]) => {
      const pinned = options.series?.[String(id)];
      if (pinned === 'fail') return { status: 'failure', error: new Error('series() reverted') };
      const underlying = pinned === undefined ? nvda.underlying : underlyingOf(pinned.ticker);
      const oracle = pinned === undefined ? ORACLE_A : pinned.oracle;
      return { status: 'success', result: { underlying, oracle, settled: false, settlementPrice: 0n, isPut: false, strike: STRIKE, expiry: E, mintFeePpm: 80 } };
    },
    // Rolls step.
    isRegularSession: () => ({ status: 'success', result: true }),
    strategy: ([writer]) => ({ status: 'success', result: { active: true, weekly: (options.weeklyWriters ?? []).some((w) => w.toLowerCase() === String(writer).toLowerCase()), smartPricing: false, maxUnits: 0n } }),
    free: ([w]) => ((options.freeFails ?? []).some((x) => x.toLowerCase() === String(w).toLowerCase()) ? { status: 'failure', error: new Error('free() reverted') } : { status: 'success', result: 10n ** 22n }),
    nextExpiry: () => (options.rollExpiry === undefined ? { status: 'failure', error: new Error('nextExpiry() reverted') } : { status: 'success', result: options.rollExpiry }),
    // Ladders step: every expiry already pinned by this Clearinghouse, so creates need no probe.
    createPaused: () => (options.createPaused === 'fail' ? { status: 'failure', error: new Error('createPaused() reverted') } : { status: 'success', result: options.createPaused ?? false }),
    seriesExists: () => (options.seriesExistsFails === true ? { status: 'failure', error: new Error('seriesExists() reverted') } : { status: 'success', result: false }),
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

/*
 * THE STALE STEP JUDGES AN ASK BY ITS SERIES' PINNED ORACLE, not by market(u).oracle: a
 * setMarketOracle moves the market's pointer and leaves every existing series on the oracle createSeries pinned,
 * which is the one AutoRoller.cancelStale reads. These two tests used to pin an older market()-read rule for
 * this step; a change superseded it, and they went red. They now pin the same two halves against the landed
 * rule -- an unreadable subject is judged on NO price, a readable one on ITS OWN oracle only -- and the oracles still
 * disagree on purpose: the market pointers name the OTHER oracle, so a step that read market() would decide the
 * opposite. steps.stale.test.ts pins the rest (two series under one underlying, a series with no oracle).
 */
test('stale: a series whose series() read FAILED has no ask cancelled on a substituted price; the other series still is', async () => {
  // NVDA's series (11) is unreadable. Its market pointer, the default oracle and the other series' oracle all say
  // overtaken: any stand-in would cancel it.
  const h = harness({
    market: { NVDA: ORACLE_A, TSLA: ORACLE_A },
    spot: new Map([[DEFAULT_ORACLE.toLowerCase(), OVER], [ORACLE_A.toLowerCase(), OVER], [ORACLE_B.toLowerCase(), OVER]]),
    series: { '11': 'fail', '12': { ticker: 'TSLA', oracle: ORACLE_B } },
    writers: [writer(1, 'NVDA', [11n, 1_001n, E]), writer(2, 'TSLA', [12n, 1_002n, E])],
  });
  const report = await stepStale(h.ctx);
  assert.deepEqual(h.sends, ['cancelStale TSLA'], 'nothing is cancelled for NVDA, whose series has no known pinned oracle');
  assert.deepEqual(h.spotFrom, ['TSLA from B'], 'no spot is read for NVDA from any oracle: not its market\'s, not the default');
  assert.deepEqual(report.notes.reasons, { unread: 1, cancel: 1 });
});

test('stale: a series is priced from ITS pinned oracle, never its market\'s current pointer nor the default one', async () => {
  // Each market points at the OTHER series' oracle; the default says the opposite of both. A is over, B under.
  const aOver = harness({
    market: { NVDA: ORACLE_B, TSLA: ORACLE_A },
    spot: new Map([[DEFAULT_ORACLE.toLowerCase(), UNDER], [ORACLE_A.toLowerCase(), OVER], [ORACLE_B.toLowerCase(), UNDER]]),
    series: { '11': { ticker: 'NVDA', oracle: ORACLE_A }, '12': { ticker: 'TSLA', oracle: ORACLE_B } },
    writers: [writer(1, 'NVDA', [11n, 1_001n, E]), writer(2, 'TSLA', [12n, 1_002n, E])],
  });
  const report = await stepStale(aOver.ctx);
  assert.deepEqual([...aOver.spotFrom].sort(), ['NVDA from A', 'TSLA from B'], 'each series read from its own pinned oracle, once');
  assert.deepEqual(aOver.sends, ['cancelStale NVDA'], 'NVDA is overtaken on A; TSLA is not on B, whatever TSLA\'s pointer (A) says');
  assert.deepEqual(report.notes.reasons, { cancel: 1, 'not-overtaken': 1 });
  assert.deepEqual((report.notes.cancelled as Array<{ oracle: string }>).map((c) => getAddress(c.oracle)), [ORACLE_A]);

  // And the other way round: B over, A under, the default over.
  const bOver = harness({
    market: { NVDA: ORACLE_B, TSLA: ORACLE_A },
    spot: new Map([[DEFAULT_ORACLE.toLowerCase(), OVER], [ORACLE_A.toLowerCase(), UNDER], [ORACLE_B.toLowerCase(), OVER]]),
    series: { '11': { ticker: 'NVDA', oracle: ORACLE_A }, '12': { ticker: 'TSLA', oracle: ORACLE_B } },
    writers: [writer(1, 'NVDA', [11n, 1_001n, E]), writer(2, 'TSLA', [12n, 1_002n, E])],
  });
  assert.deepEqual((await stepStale(bOver.ctx)).notes.reasons, { cancel: 1, 'not-overtaken': 1 });
  assert.deepEqual(bOver.sends, ['cancelStale TSLA']);
});

test('ladders (pinned): createSeries\' own refusals are mirrored -- CreatePaused sends nothing, a disabled or unregistered market is skipped, a market without an ok spot waits', async () => {
  // Clearinghouse.createSeries (Clearinghouse.sol createSeries): MarketDisabled, CreatePaused, BadStrike on strikeTick 0.
  // The ladder step reads the same state and sends nothing the contract would refuse. The missing spot is deliberately
  // STRICTER than the contract (which skips its band check without a spot): a ladder is centred on the spot.
  const spot = new Map([[ORACLE_A.toLowerCase(), 200_000_000n], [ORACLE_B.toLowerCase(), 300_000_000n]]);
  const paused = harness({ market: { NVDA: ORACLE_A, TSLA: ORACLE_B }, spot, createPaused: true });
  const p = await stepLadders(paused.ctx);
  assert.deepEqual(paused.sends, [], 'nothing is created while series creation is paused');
  assert.match(String(p.notes.skipped), /paused/);

  const gated = harness({ market: { NVDA: ORACLE_A, TSLA: ORACLE_B }, spot, marketCfg: { NVDA: { enabled: false }, TSLA: { strikeTick: 0n } } });
  const g = await stepLadders(gated.ctx);
  assert.deepEqual(gated.sends, [], 'a disabled market and an unregistered one get no createSeries');
  const skipped = Object.fromEntries((g.notes.markets as Array<{ ticker: string; skipped?: string }>).map((m) => [m.ticker, m.skipped]));
  assert.equal(skipped.NVDA, 'market disabled');
  assert.equal(skipped.TSLA, 'not registered on the Clearinghouse');

  const dark = harness({ market: { NVDA: ORACLE_A, TSLA: ORACLE_B }, spot: new Map([[ORACLE_B.toLowerCase(), 300_000_000n]]) });
  const d = await stepLadders(dark.ctx);
  assert.deepEqual(dark.sends.filter((x) => x.endsWith('NVDA')), [], 'no ok spot for NVDA: no NVDA ladder');
  assert.ok(dark.sends.some((x) => x.endsWith('TSLA')), 'the market with a spot is still laddered');
  assert.match(String((d.notes.markets as Array<{ ticker: string; skipped?: string }>).find((m) => m.ticker === 'NVDA')!.skipped), /spot not fresh/);
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

/*
 * (bug hunt: a failed read never skips a guard or sends on a guess). Each test fails ONE read, the way an
 * allowFailure multicall reports it, and holds every other read of the step at a value that would send; the control half
 * of each test is the same harness with that one read answering, and it sends.
 */
test('ladders: an unread createPaused() is not "not paused": nothing is probed or created, and the note says why', async () => {
  const spot = new Map([[ORACLE_A.toLowerCase(), 200_000_000n], [ORACLE_B.toLowerCase(), 300_000_000n]]);
  const unread = harness({ market: { NVDA: ORACLE_A, TSLA: ORACLE_B }, spot, createPaused: 'fail' });
  const r = await stepLadders(unread.ctx);
  assert.deepEqual(unread.sends, [], 'no createSeries while the guardian pause could not be read');
  assert.deepEqual(unread.spotFrom, [], 'the step stops before it prices anything');
  assert.match(String(r.notes.skipped), /createPaused\(\) read failed/);
  // Control: the same chain with the flag read as false creates both ladders.
  const read = harness({ market: { NVDA: ORACLE_A, TSLA: ORACLE_B }, spot, createPaused: false });
  await stepLadders(read.ctx);
  assert.ok(read.sends.some((x) => x === 'createSeries NVDA') && read.sends.some((x) => x === 'createSeries TSLA'), `control creates (${read.sends.join(', ')})`);
});

test('ladders: a series whose seriesExists() read failed is not "missing": no createSeries is sent for it, and the notes count it', async () => {
  const spot = new Map([[ORACLE_A.toLowerCase(), 200_000_000n], [ORACLE_B.toLowerCase(), 300_000_000n]]);
  const unread = harness({ market: { NVDA: ORACLE_A, TSLA: ORACLE_B }, spot, seriesExistsFails: true });
  const r = await stepLadders(unread.ctx);
  assert.deepEqual(unread.sends, [], 'nothing is created on an existence nobody read');
  assert.equal(r.notes.missing, 0);
  assert.equal(r.notes.existsUnread, r.notes.planned, 'every planned series is counted unread');
  assert.ok((r.notes.planned as number) > 0, 'the step did plan series, so the zero is the guard and not an empty plan');
  // Control: seriesExists answering false makes every planned series missing and sent.
  const read = harness({ market: { NVDA: ORACLE_A, TSLA: ORACLE_B }, spot });
  const c = await stepLadders(read.ctx);
  assert.equal(c.notes.missing, c.notes.planned);
  assert.equal(c.notes.existsUnread, undefined);
  assert.equal(read.sends.length, c.notes.planned);
});

test('rolls: a new roll whose free() read failed is not sent (it was counted bounty-paying, outside the per-tick cap); its close-out and the other writers still roll', async () => {
  const unreadFree = writer(1, 'NVDA', [0n, 0n, 0]);
  const unreadCloseOut = writer(2, 'NVDA', [7n, 0n, T0 - 1]);
  const readable = writer(3, 'TSLA', [0n, 0n, 0]);
  const spot = new Map([[ORACLE_A.toLowerCase(), 100_000_000n], [ORACLE_B.toLowerCase(), 100_000_000n]]);
  const h = harness({ market: { NVDA: ORACLE_A, TSLA: ORACLE_B }, spot, writers: [unreadFree, unreadCloseOut, readable], freeFails: [unreadFree.writer, unreadCloseOut.writer] });
  const report = await stepRolls(h.ctx);
  const decisions = report.notes.decisions as Array<{ writer: string; roll: boolean; reason: string }>;
  const of = (w: Writer) => { const d = decisions.find((x) => x.writer.toLowerCase() === w.writer.toLowerCase())!; return `${d.roll}:${d.reason}`; };
  assert.equal(of(unreadFree), 'false:free-unread', 'the unread writer is reported, not rolled');
  assert.equal(of(unreadCloseOut), 'true:close-out', 'a close-out does not use the size');
  assert.equal(of(readable), 'true:roll');
  assert.deepEqual([...h.sends].sort(), ['roll NVDA', 'roll TSLA'], 'the NVDA send is the close-out');
  // Control: the same writer with free() answering rolls.
  const control = harness({ market: { NVDA: ORACLE_A, TSLA: ORACLE_B }, spot, writers: [unreadFree] });
  await stepRolls(control.ctx);
  assert.deepEqual(control.sends, ['roll NVDA']);
});

/*
 * On a market whose registry lists no dailies (SPCX), a
 * DAILY strategy's roll would create a series at the next Mon-Thu close: the cranker does not send it, and says why.
 * A weekly strategy on the same market still rolls, a close-out of a daily one still goes (it opens nothing), and a
 * daily strategy on a market that lists dailies is untouched.
 */
test('rolls: a daily strategy is not rolled on a market that lists no dailies; its close-out, a weekly strategy and the other market still roll', async () => {
  const daily = writer(1, 'TSLA', [0n, 0n, 0]);
  const weekly = writer(2, 'TSLA', [0n, 0n, 0]);
  const closeOut = writer(3, 'TSLA', [7n, 0n, T0 - 1]);
  const other = writer(4, 'NVDA', [0n, 0n, 0]);
  const h = harness({
    market: { NVDA: ORACLE_A, TSLA: ORACLE_B },
    spot: new Map([[ORACLE_A.toLowerCase(), 100_000_000n], [ORACLE_B.toLowerCase(), 100_000_000n]]),
    writers: [daily, weekly, closeOut, other],
    noDailies: 'TSLA',
    weeklyWriters: [weekly.writer],
  });
  const report = await stepRolls(h.ctx);
  const decisions = report.notes.decisions as Array<{ writer: string; roll: boolean; reason: string }>;
  const of = (w: Writer) => { const d = decisions.find((x) => x.writer.toLowerCase() === w.writer.toLowerCase())!; return { roll: d.roll, reason: d.reason }; };
  assert.deepEqual(of(daily), { roll: false, reason: 'daily-not-listed' }, 'the daily strategy on the no-dailies market is not rolled');
  assert.deepEqual(of(weekly), { roll: true, reason: 'roll' }, 'a weekly strategy on the same market rolls');
  assert.deepEqual(of(closeOut), { roll: true, reason: 'close-out' }, 'a close-out of a daily strategy still goes');
  assert.deepEqual(of(other), { roll: true, reason: 'roll' }, 'a daily strategy on a market that lists dailies is untouched');
  assert.deepEqual([...h.sends].sort(), ['roll NVDA', 'roll TSLA', 'roll TSLA'], 'three sends: NVDA daily, TSLA weekly, TSLA close-out');
});

/*
 * NVDA lists Mon/Wed/Fri only. A daily NVDA strategy rolled on a Tuesday or Thursday
 * would make AutoRoller.roll create a series at that day's close (its target is nextExpiry(now + DAILY_MIN_LEAD, false)).
 * The cranker reads that close and does not send the roll unless its weekday is listed; an unread close refuses too.
 */
test('rolls: an NVDA daily strategy rolls only into a Mon/Wed/Fri close; TSLA (every weekday) is untouched', async () => {
  const monday = Date.UTC(2026, 8, 28, 20, 0, 0) / 1_000;
  const tuesday = Date.UTC(2026, 8, 29, 20, 0, 0) / 1_000;
  const run = async (rollExpiry: number | undefined) => {
    const nvda = writer(1, 'NVDA', [0n, 0n, 0]);
    const nvdaWeekly = writer(2, 'NVDA', [0n, 0n, 0]);
    const tsla = writer(3, 'TSLA', [0n, 0n, 0]);
    const h = harness({
      market: { NVDA: ORACLE_A, TSLA: ORACLE_B },
      spot: new Map([[ORACLE_A.toLowerCase(), 100_000_000n], [ORACLE_B.toLowerCase(), 100_000_000n]]),
      writers: [nvda, nvdaWeekly, tsla],
      weeklyWriters: [nvdaWeekly.writer],
      dailyWeekdays: { ticker: 'NVDA', days: ['mon', 'wed', 'fri'] },
      rollExpiry,
    });
    const report = await stepRolls(h.ctx);
    const decisions = report.notes.decisions as Array<{ writer: string; roll: boolean; reason: string }>;
    const of = (w: Writer) => { const d = decisions.find((x) => x.writer.toLowerCase() === w.writer.toLowerCase())!; return `${d.roll}:${d.reason}`; };
    return { nvda: of(nvda), weekly: of(nvdaWeekly), tsla: of(tsla), sends: [...h.sends].sort() };
  };
  assert.deepEqual(await run(tuesday), { nvda: 'false:daily-not-listed', weekly: 'true:roll', tsla: 'true:roll', sends: ['roll NVDA', 'roll TSLA'] },
    'a Tuesday close: the NVDA daily roll is not sent; the weekly strategy and TSLA still roll');
  assert.deepEqual(await run(monday), { nvda: 'true:roll', weekly: 'true:roll', tsla: 'true:roll', sends: ['roll NVDA', 'roll NVDA', 'roll TSLA'] },
    'a Monday close: the NVDA daily strategy rolls');
  assert.deepEqual((await run(undefined)).nvda, 'false:daily-not-listed', 'an unread close never risks a Tue/Thu series');
  assert.deepEqual((await run(undefined)).tsla, 'true:roll', 'a market listing every weekday needs no read');
});

/*//////////////////////////////////////////////////////////////
                 HOUSE VAULT EPOCH ROLL
//////////////////////////////////////////////////////////////*/

import { BOOK_PULL_GAS, GAS, MAX_ORACLE_SOURCES } from './constants.js';
import { Budget, HOUSE_ROLL_BOOK_PULL_GAS, HOUSE_ROLL_GAS_BASE, HOUSE_ROLL_GAS_HEADROOM, HOUSE_ROLL_GAS_PER_TRACKED, HOUSE_ROLL_GAS_PIN_EXTRA, HOUSE_ROLL_KIND, HOUSE_ROLL_OVERDUE_S, HOUSE_ROLL_WORST_SERIES, STEP_ORDER, chainHouseRollReads, houseBoundaryKeys, houseRoll, houseRollGas, houseRollHeldMetaKey, houseRollPinGas, houseRollHeldUntil, houseRollOverdueS, newReport, readUncorroboratedDelay, send, stepHouse, stepHousekeeping, type HouseRollReads, type HouseTrackedView, type HouseVaultRollView } from './steps.js';
import { legacyWeeklyWindingDown } from '../mm/house.js';

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

/**
 * Reads for the roll, all injected: `flat` is per vault. The default readFinalized answers Finalized only for the
 * boundary every view below carries (HOUSE_ORACLE, NVDA_TOKEN, EPOCH_END), so a roll that asked about another
 * timestamp or another oracle would find it not Finalized (it used to answer true whatever it was asked,
 * and a `finalized` option it never read has been removed).
 */
function rollReads(over: Partial<HouseRollReads> & { flat?: Record<string, boolean>; vaults?: Address[] } = {}): HouseRollReads {
  const vaults = over.vaults ?? [HOUSE_A, HOUSE_B];
  const flat = over.flat ?? {};
  const view = (vault: Address): HouseVaultRollView => ({ epochEnd: EPOCH_END, epochId: vault === HOUSE_A ? 7n : 3n, underlying: NVDA_TOKEN, oracle: HOUSE_ORACLE, tracked: [11n, 12n] });
  return {
    factories: [FACTORY],
    registryVaults: () => [],
    discover: async () => vaults,
    readVault: async (vault) => view(vault),
    readTracked: async (vault, tracked) => tracked.map((longId) => (flat[vault.toLowerCase()] ?? true ? { longId, settled: true, longs: 0n, shorts: 0n, live: 0n } : { longId, settled: longId === 11n, longs: longId === 11n ? 100n : 0n, shorts: 0n, live: 0n })),
    readFinalized: async (oracle, underlying, epochEnd) => oracle === HOUSE_ORACLE && underlying === NVDA_TOKEN && epochEnd === EPOCH_END,
    // In kind (the launch setting) and a fresh spot, unless a test says otherwise.
    readConverts: async () => false,
    readSpotFresh: async () => true,
    // The market's source count the roll's boundary-pin allowance is sized from (NVDA: Chainlink + pool).
    readPinSources: async () => 2,
    ...over,
  };
}

const headAt = (timestamp: number) => ({ blockNumber: 65_000_100n, timestamp });

/**
 * callhouse-contracts test/v2/unit/HouseVaultRollGas.t.sol mirrors this file's House-roll budget (its KEEPER_*
 * constants and `_keeperRollGas` copy houseRollGas / houseRollPinGas / HOUSE_ROLL_BOOK_PULL_GAS), and
 * test_keeperRollGas_mirrorsTheKeepersFormula asserts the mirror on fixed vectors (read at the source).
 * The two it shares with the older house-roll tests below live here once, so no second copy can disagree.
 */
const CONTRACTS_ROLL_GAS_MIRROR = 'callhouse-contracts test/v2/unit/HouseVaultRollGas.t.sol KEEPER_*';
const HOUSE_ROLL_VECTORS = {
  bookPull: 517_936n, // assertEq(_starvedCeiling(KEEPER_BOOK_PULL_GAS), 517_936, "HOUSE_ROLL_BOOK_PULL_GAS")
  pinTwoSources: 360_000n, // assertEq(_keeperPinGas(2), 360_000, "houseRollPinGas(2)")
} as const;

test('houseBoundaryKeys is the current boundary of every vault the House step rolls, on the vault\'s own oracle; an unreadable vault gives none', async () => {
  const h = rollHarness();
  const REGISTRY_ONLY = getAddress('0x00000000000000000000000000000000000000e5');
  const MOVED_ORACLE = getAddress('0x00000000000000000000000000000000000000e6');
  const reads = rollReads({
    vaults: [HOUSE_A, HOUSE_B],
    registryVaults: () => [REGISTRY_ONLY],
    readVault: async (vault) => vault === HOUSE_B ? null : {
      epochEnd: vault === REGISTRY_ONLY ? EPOCH_END + 86_400 : EPOCH_END, epochId: 1n, underlying: NVDA_TOKEN,
      oracle: vault === REGISTRY_ONLY ? MOVED_ORACLE : HOUSE_ORACLE, tracked: [],
    },
  });
  assert.deepEqual(await houseBoundaryKeys(h.ctx, headAt(EPOCH_END - 60), reads), [
    { oracle: HOUSE_ORACLE, underlying: NVDA_TOKEN, expiry: EPOCH_END },
    { oracle: MOVED_ORACLE, underlying: NVDA_TOKEN, expiry: EPOCH_END + 86_400 },
  ]);
  const none = rollReads({ factories: [], discover: async () => assert.fail('must not enumerate') });
  assert.deepEqual(await houseBoundaryKeys(h.ctx, headAt(EPOCH_END), none), [], 'no factory and no registry vault: no read at all');
});

test('house roll: due, Finalized and flat -> rollEpoch is sent from the cranker with gas for its tracked series, keyed vault:epochId; the overdue page is cleared', async () => {
  const h = rollHarness();
  const report = newReport('house');
  const notes = await houseRoll(h.ctx, report, new Budget(10), headAt(EPOCH_END + 300), rollReads({ vaults: [HOUSE_A] }));
  assert.equal(h.sends.length, 1);
  // Two tracked series, both settled and empty: 300k base + 2 x 50k (was a flat, unmeasured 2.5M).
  // + the next boundary's pin on the market's two sources (readPinSources), 360k.
  // + one book pull's ceiling, 517,936 (was 760,000 with no room for the pull's cap).
  assert.deepEqual(h.sends[0], { vault: HOUSE_A, fn: 'rollEpoch', gas: 400_000n + houseRollPinGas(2) + HOUSE_ROLL_VECTORS.bookPull, kind: HOUSE_ROLL_KIND, key: `${HOUSE_A.toLowerCase()}:7` });
  assert.equal(houseRollPinGas(2), HOUSE_ROLL_VECTORS.pinTwoSources);
  assert.equal(notes[0]!.decision, 'sent');
  assert.equal(notes[0]!.detail, 'confirmed');
  assert.equal(report.actions.filter((a) => a.kind === HOUSE_ROLL_KIND).length, 1, 'the action is in the house report under its own kind');
  assert.deepEqual(h.cleared, [{ kind: 'v2_house_roll_overdue', dedupeKey: HOUSE_A.toLowerCase() }]);
  assert.equal(h.raised.length, 0);
});

test('house roll gas: sized per call from the measured rolls, at least 20 % over every one', () => {
  const flat = (n: number): HouseTrackedView[] => Array.from({ length: n }, (_, i) => ({ longId: BigInt(2 * i), settled: true, longs: 0n, shorts: 0n, live: 0n }));
  // HouseVaultRollGas.t.sol (callhouse-contracts): rollEpoch with n stale tracked series, cold.
  const measured = [
    { n: 1, gas: 229_299n },
    { n: 10, gas: 571_289n },
    { n: 50, gas: 2_093_979n },
    { n: 100, gas: 4_035_625n },
  ];
  for (const m of measured) {
    const sent = houseRollGas(flat(m.n), 2);
    assert.ok(sent * 100n >= m.gas * 120n, `${m.n} tracked: ${sent} is not 20 % over the measured ${m.gas}`);
  }
  assert.ok(houseRollGas([], 2) * 100n >= 194_913n * 120n, 'after the bot\'s sync the roll measured ~194,913 at any n');
  assert.ok(measured[3]!.gas > 2_500_000n, 'the flat 2.5M this replaced ran out of gas at 100 stale series');
  assert.equal(HOUSE_ROLL_GAS_BASE, 300_000n);
  assert.equal(HOUSE_ROLL_GAS_PER_TRACKED, 50_000n);
});

/**
 * The rollEpoch ends with _pinBoundary: SettlementOracle.pinBoundary (two cold
 * factory vaultOf lookups, the config copy, every source's own pin) and the vault's pinnedBoundary store. A pin the SENDER
 * starved is re-thrown (StarvedCall.DEEP), so a roll sent at the old 300k base reverts with no reason every tick. The
 * measured pieces: the roll itself ~194,913 once the bot untracked everything and a first pin on two sources
 * +181,719 (devnet, GAS.createSeriesPinBase). The House-only extras are NOT measured (no contracts case with an
 * authorized factory yet): the allowance is a ceiling, not a measurement.
 */
test('house roll gas: the roll also pays for the next boundary\'s pin, per source, MAX_ORACLE_SOURCES when unread', async () => {
  // Fails at the old budget: 300k does not cover the measured roll plus a two-source first pin, with 20 % over.
  assert.ok(houseRollGas([], 2) * 100n >= (194_913n + 181_719n) * 120n, `${houseRollGas([], 2)} does not cover the roll and the boundary pin`);
  assert.ok(houseRollPinGas(2) * 100n >= 181_719n * 120n, 'the pin alone is 20 % over the measured two-source first pin');
  assert.equal(houseRollPinGas(2), GAS.createSeriesPinBase + HOUSE_ROLL_GAS_PIN_EXTRA + 2n * GAS.createSeriesPinPerSource);
  assert.equal(houseRollPinGas(3) - houseRollPinGas(2), GAS.createSeriesPinPerSource, 'each source adds its own pin');
  assert.equal(houseRollPinGas(null), houseRollPinGas(MAX_ORACLE_SOURCES), 'an unread source count budgets the most');
  // The send carries the market's own count, read right before it.
  for (const [sources, want] of [[1, houseRollGas([], 1)], [null, houseRollGas([], null)]] as const) {
    const h = rollHarness();
    await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + 300), rollReads({ vaults: [HOUSE_A], readTracked: async () => [], readPinSources: async () => sources }));
    assert.equal(h.sends[0]!.gas, want, `pin sources ${sources}`);
  }
});

test('house roll gas: a held series pays its redeems (a converting call long, an in-kind long, a short), and the send is capped under the 4663 tx cap', () => {
  const view = (o: Partial<HouseTrackedView>): HouseTrackedView => ({ longId: 0n, settled: true, longs: 0n, shorts: 0n, live: 0n, ...o });
  const itmCall = view({ longs: 5n, isPut: false, longPayoutPerUnit: 1_000n });
  const pin2 = houseRollPinGas(2); // Every roll also pins the next boundary (two sources here)
  // A roll that may convert also carries ONE GAS.redeemConvertReserve (the conversion ceiling); none below does.
  // Every roll also carries ONE book pull's ceiling, HOUSE_ROLL_BOOK_PULL_GAS.
  const base = HOUSE_ROLL_GAS_BASE + pin2 + HOUSE_ROLL_BOOK_PULL_GAS;
  assert.equal(houseRollGas([itmCall], 2), base + HOUSE_ROLL_GAS_PER_TRACKED + GAS.redeemConvertEach + GAS.redeemConvertReserve);
  assert.equal(houseRollGas([itmCall, itmCall], 2), base + 2n * (HOUSE_ROLL_GAS_PER_TRACKED + GAS.redeemConvertEach) + GAS.redeemConvertReserve, 'one reserve per roll, not per series');
  assert.equal(houseRollGas([view({ longs: 5n, isPut: true, longPayoutPerUnit: 1_000n })], 2), base + HOUSE_ROLL_GAS_PER_TRACKED + GAS.redeemInKindEach, 'a put long pays in kind');
  assert.equal(houseRollGas([view({ longs: 5n, isPut: false, longPayoutPerUnit: 0n })], 2), base + HOUSE_ROLL_GAS_PER_TRACKED + GAS.redeemInKindEach, 'an OTM call long');
  assert.equal(houseRollGas([view({ shorts: 5n })], 2), base + HOUSE_ROLL_GAS_PER_TRACKED + GAS.redeemInKindEach);
  // HOUSE_ROLL_WORST_SERIES (and the monitor's page below it): the most worst-case series one roll fits, whatever the
  // source-count read returns. An unread count budgets the pin for MAX_ORACLE_SOURCES (900k), the largest, so it binds.
  const worst = (n: number) => Array.from({ length: n }, (_, i) => view({ longId: BigInt(2 * i), longs: 1n, shorts: 1n, isPut: false, longPayoutPerUnit: 1n }));
  const cap = CHAIN_MAX_TX_GAS - HOUSE_ROLL_GAS_HEADROOM;
  const unclamped = (n: number, sources: number | null) => HOUSE_ROLL_GAS_BASE + houseRollPinGas(sources) + HOUSE_ROLL_BOOK_PULL_GAS + GAS.redeemConvertReserve + BigInt(n) * (HOUSE_ROLL_GAS_PER_TRACKED + GAS.redeemConvertEach + GAS.redeemInKindEach);
  // A change set 40: the reserve and the pin, with the unread pin landing exactly on the cap at 40.
  // A change changed it on purpose to 39: the book pull's 517,936 comes out of the same cap, so the unread case is
  // (32M - 2M - 300k - 900k - 517,936 - 1.6M) / 680k = 39.2.
  assert.equal(HOUSE_ROLL_WORST_SERIES, 39);
  assert.ok(unclamped(HOUSE_ROLL_WORST_SERIES, null) <= cap && houseRollGas(worst(HOUSE_ROLL_WORST_SERIES), null) === unclamped(HOUSE_ROLL_WORST_SERIES, null));
  assert.ok(unclamped(HOUSE_ROLL_WORST_SERIES + 1, null) > cap);
  assert.equal(houseRollGas(worst(HOUSE_ROLL_WORST_SERIES + 1), null), cap, 'past the cap the send is clamped: it reverts loudly, never above the chain cap');
  // What tipped it: at 40 the unread case was exactly on the cap before the change and is now over it by exactly the ceiling.
  assert.equal(unclamped(HOUSE_ROLL_WORST_SERIES + 1, null) - cap, HOUSE_ROLL_BOOK_PULL_GAS);
  // A two-source pin (the launch markets, 360k) fits one more: 40 ((30M - 300k - 360k - 517,936 - 1.6M) / 680k = 40.03),
  // not 41. The constant is the smaller of the two, so it holds whatever the source-count read returns.
  assert.ok(unclamped(HOUSE_ROLL_WORST_SERIES + 1, 2) <= cap && houseRollGas(worst(HOUSE_ROLL_WORST_SERIES + 1), 2) === unclamped(HOUSE_ROLL_WORST_SERIES + 1, 2));
  assert.ok(unclamped(HOUSE_ROLL_WORST_SERIES + 2, 2) > cap);
  assert.equal(houseRollGas(worst(HOUSE_ROLL_WORST_SERIES + 2), 2), cap);
  const monitor = readFileSync(new URL('../../../../ops/v2/monitor.mjs', import.meta.url), 'utf8');
  const page = /^export const HOUSE_TRACKED_PAGE = (\d+);/m.exec(monitor);
  assert.ok(page && Number(page[1]) < HOUSE_ROLL_WORST_SERIES, 'the monitor pages below the roll\'s worst-case limit');
});

test('house roll gas: HouseVault.BOOK_PULL_GAS and its StarvedCall ceiling, as HouseVault.sol and StarvedCall.sol define them', () => {
  // HouseVault.sol:212 `BOOK_PULL_GAS = 500_000` (private); rollEpoch sends `claimOwed{gas: BOOK_PULL_GAS}` at :983 and
  // guards it with `revertIfStarvedBelow(g, DEEP, BOOK_PULL_GAS, reason)` at :985. StarvedCall.sol:70 CALL_SLACK = 10_000,
  // :77 `gasBefore < ceiling + ceiling / 63 + CALL_SLACK` (integer division).
  assert.equal(BOOK_PULL_GAS, 500_000n);
  assert.equal(STARVED_CALL_SLACK, 10_000n);
  assert.equal(HOUSE_ROLL_BOOK_PULL_GAS, 500_000n + 500_000n / 63n + 10_000n);
  assert.equal(HOUSE_ROLL_BOOK_PULL_GAS, HOUSE_ROLL_VECTORS.bookPull);
});

test('house roll gas: every vector callhouse-contracts HouseVaultRollGas.t.sol pins on its KEEPER_* mirror, so a change on either side goes red', () => {
  const mirror = (what: string) => `${what}: pinned by ${CONTRACTS_ROLL_GAS_MIRROR} (test_keeperRollGas_mirrorsTheKeepersFormula, T-OP-985); change that mirror in the same change`;
  const view = (o: Partial<HouseTrackedView>): HouseTrackedView => ({ longId: 0n, settled: true, longs: 0n, shorts: 0n, live: 0n, ...o });
  const itmCall = (longId: bigint) => view({ longId, longs: 5n, isPut: false, longPayoutPerUnit: 1_000n });
  // `_keeperRollGas(n, n, n, s)`: n series that each hold a converting call long and its short, the worst case.
  const worst = (n: number) => Array.from({ length: n }, (_, i) => view({ longId: BigInt(2 * i), longs: 1n, shorts: 1n, isPut: false, longPayoutPerUnit: 1n }));
  const cap = 30_000_000n; // KEEPER_CHAIN_MAX_TX_GAS 32,000,000 - KEEPER_ROLL_HEADROOM 2,000,000
  assert.equal(HOUSE_ROLL_BOOK_PULL_GAS, HOUSE_ROLL_VECTORS.bookPull, mirror('HOUSE_ROLL_BOOK_PULL_GAS'));
  assert.equal(houseRollPinGas(2), HOUSE_ROLL_VECTORS.pinTwoSources, mirror('houseRollPinGas(2)'));
  assert.equal(houseRollGas([view({ longId: 11n }), view({ longId: 12n })], 2), 1_277_936n, mirror('_keeperRollGas(2, 0, 0, 2), two empty tracked series on two sources'));
  assert.equal(houseRollGas([itmCall(11n)], 2), 3_277_936n, mirror('_keeperRollGas(1, 1, 0, 2), one converting call long on two sources'));
  assert.equal(houseRollGas([itmCall(11n), itmCall(12n)], 2) - houseRollGas([itmCall(11n)], 2), 500_000n, mirror('_keeperRollGas(2, 2, 0, 2) - _keeperRollGas(1, 1, 0, 2), one reserve per roll'));
  const inKind: Array<[string, HouseTrackedView]> = [
    ['a put long', view({ longs: 5n, isPut: true, longPayoutPerUnit: 1_000n })],
    ['an OTM call long', view({ longs: 5n, isPut: false, longPayoutPerUnit: 0n })],
    ['a short', view({ shorts: 5n })],
  ];
  for (const [leg, t] of inKind) {
    assert.equal(houseRollGas([t], 2), 1_407_936n, mirror(`_keeperRollGas(1, 0, 1, 2), one in-kind leg (${leg}) on two sources`));
  }
  // The mirror sizes the unread case at KEEPER_MAX_ORACLE_SOURCES; the keeper budgets an unread count (null) at the most.
  assert.equal(MAX_ORACLE_SOURCES, 8, mirror('MAX_ORACLE_SOURCES (KEEPER_MAX_ORACLE_SOURCES)'));
  assert.ok(houseRollGas(worst(39), null) < cap, mirror('_keeperRollGas(39, 39, 39, 8) < cap, 39 worst-case series fit at an unread source count'));
  assert.equal(houseRollGas(worst(40), null), cap, mirror('_keeperRollGas(40, 40, 40, 8) == cap, the 40th is capped'));
  assert.ok(houseRollGas(worst(40), 2) < cap, mirror('_keeperRollGas(40, 40, 40, 2) < cap, 40 fit on a two-source pin'));
});

test('house roll gas: every roll carries one book pull\'s ceiling on top of its measured work and the boundary pin, so a pull that burns its whole cap is the book\'s own failure (fails at a budget of measured work plus pin only)', () => {
  const view = (o: Partial<HouseTrackedView>): HouseTrackedView => ({ longId: 0n, settled: true, longs: 0n, shorts: 0n, live: 0n, ...o });
  const flat = (n: number): HouseTrackedView[] => Array.from({ length: n }, (_, i) => view({ longId: BigInt(2 * i) }));
  const itmCall = view({ longs: 5n, isPut: false, longPayoutPerUnit: 1_000n });
  // The budget without the book pull: the measured work (per series, the one conversion reserve) and the pin.
  const measured = (t: readonly HouseTrackedView[], sources: number | null) => {
    let gas = HOUSE_ROLL_GAS_BASE + houseRollPinGas(sources);
    let converts = false;
    for (const v of t) {
      gas += HOUSE_ROLL_GAS_PER_TRACKED;
      const c = v.longs !== 0n && v.isPut === false && (v.longPayoutPerUnit ?? 0n) > 0n;
      if (v.longs !== 0n) gas += c ? GAS.redeemConvertEach : GAS.redeemInKindEach;
      if (v.shorts !== 0n) gas += GAS.redeemInKindEach;
      converts ||= c;
    }
    return converts ? gas + GAS.redeemConvertReserve : gas;
  };
  const fixtures: Array<[string, HouseTrackedView[]]> = [
    ['no tracked series', []],
    ['two settled empty series', flat(2)],
    ['one held ITM call long and its short', [{ ...itmCall, shorts: 5n }]],
    [`${HOUSE_ROLL_WORST_SERIES} worst-case series`, Array.from({ length: HOUSE_ROLL_WORST_SERIES }, (_, i) => view({ longId: BigInt(2 * i), longs: 1n, shorts: 1n, isPut: false, longPayoutPerUnit: 1n }))],
  ];
  assert.equal(houseRollGas([], 2), 1_177_936n, '300k base + 360k two-source pin + 517,936 (was 660,000)');
  assert.equal(houseRollGas([], null), 1_717_936n, '300k base + 900k unread-source pin + 517,936 (was 1,200,000)');
  for (const sources of [2, null] as const) {
    for (const [name, t] of fixtures) {
      const label = `${name}, pin sources ${sources}`;
      const sent = houseRollGas(t, sources);
      assert.equal(sent, measured(t, sources) + HOUSE_ROLL_BOOK_PULL_GAS, `${label}: the send is the measured work and pin plus one pull ceiling`);
      // At the pull (before the pin, which ends the roll) the roll has spent at most its measured work, so it still holds
      // the whole ceiling there; a pull that burns all of BOOK_PULL_GAS then leaves the budget for everything after it.
      assert.ok(sent - measured(t, sources) >= starvedCeiling(BOOK_PULL_GAS), `${label}: ${sent} does not hold the pull's ceiling above the measured ${measured(t, sources)}`);
      assert.ok(sent - BOOK_PULL_GAS >= measured(t, sources), `${label}: a pull that burned its cap leaves less than the measured work`);
      assert.ok(sent <= CHAIN_MAX_TX_GAS - HOUSE_ROLL_GAS_HEADROOM, `${label}: under the cranker's cap`);
    }
  }
});

test('house roll: not yet due -> nothing sent, the overdue page is cleared (a hand roll or an earlier tick already moved epochEnd)', async () => {
  const h = rollHarness();
  const notes = await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END - 1), rollReads({ vaults: [HOUSE_A] }));
  assert.equal(h.sends.length, 0);
  assert.equal(notes[0]!.decision, 'not-due');
  assert.deepEqual(h.cleared, [{ kind: 'v2_house_roll_overdue', dedupeKey: HOUSE_A.toLowerCase() }]);
});

test('house roll: due but the oracle is not Finalized -> not sent (it would revert NotSettled); no page inside the 7 h settlement window, a page past it', async () => {
  const h = rollHarness();
  const reads = rollReads({ vaults: [HOUSE_A], readFinalized: async () => false });
  const inside = await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + HOUSE_ROLL_OVERDUE_S - 60), reads);
  assert.equal(h.sends.length, 0, 'a NotSettled revert is predicted, not provoked');
  assert.equal(inside[0]!.decision, 'not-finalized');
  assert.equal(h.raised.length, 0, 'inside the uncorroborated delay the wait is the settlement chain working');
  const past = await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + HOUSE_ROLL_OVERDUE_S + 1), reads);
  assert.equal(past[0]!.decision, 'not-finalized');
  assert.equal(h.raised.length, 1);
  assert.equal(h.raised[0]!.kind, 'v2_house_roll_overdue');
  assert.equal(h.raised[0]!.dedupeKey, HOUSE_A.toLowerCase());
  assert.match(h.raised[0]!.message, /not-finalized/);
  assert.match(h.raised[0]!.message, /rollEpoch\(\) is permissionless/);
});

test('the overdue page waits for the LIVE uncorroborated delay, not the 6 h default the owner can change', async () => {
  const TWELVE_H = 12 * 3_600;
  const h = rollHarness();
  const base = rollReads({ vaults: [HOUSE_A], readFinalized: async () => false });
  const reads: HouseRollReads = { ...base, readVault: async (vault, block) => ({ ...(await base.readVault(vault, block))!, uncorroboratedDelayS: TWELVE_H }) };
  // Past the old fixed 7 h: with a 12 h delay the settlement chain is still inside its own wait, so no page.
  await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + HOUSE_ROLL_OVERDUE_S + 60), reads);
  assert.equal(h.raised.length, 0, 'a raised setMarket delay must not page at the stale 7 h');
  await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + TWELVE_H + 3_600 + 1), reads);
  assert.equal(h.raised.length, 1);
  assert.equal(h.raised[0]!.kind, 'v2_house_roll_overdue');
});

test('houseRollOverdueS is the live delay + 1 h, and the 7 h fallback when the delay was not read', () => {
  assert.equal(HOUSE_ROLL_OVERDUE_S, 7 * 3_600);
  assert.equal(houseRollOverdueS(21_600), 7 * 3_600);
  assert.equal(houseRollOverdueS(43_200), 13 * 3_600);
  assert.equal(houseRollOverdueS(1_800), 1_800 + 3_600, 'a lowered delay pages sooner');
  for (const unread of [null, undefined, 0, Number.NaN]) assert.equal(houseRollOverdueS(unread), HOUSE_ROLL_OVERDUE_S);
});

test('readUncorroboratedDelay prefers the expiry pin, then the market config, then null', async () => {
  const U = getAddress('0x00000000000000000000000000000000000000d1');
  const O = getAddress('0x00000000000000000000000000000000000000d2');
  const client = (pinned: unknown, current: unknown) => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      const r = functionName === 'settlementConfig' ? pinned : current;
      if (r instanceof Error) throw r;
      return r;
    },
  }) as unknown as Parameters<typeof readUncorroboratedDelay>[0];
  assert.equal(await readUncorroboratedDelay(client([true, [O], 150, 43_200, 3_600], [[O], 150, 21_600, 3_600]), O, U, EPOCH_END, 1n), 43_200);
  assert.equal(await readUncorroboratedDelay(client([false, [], 0, 0, 0], [[O], 150, 28_800, 3_600]), O, U, EPOCH_END, 1n), 28_800);
  assert.equal(await readUncorroboratedDelay(client(new Error('revert'), [[O], 150, 28_800, 3_600]), O, U, EPOCH_END, 1n), 28_800);
  assert.equal(await readUncorroboratedDelay(client(new Error('revert'), new Error('revert')), O, U, EPOCH_END, 1n), null);
});

test('house roll: due and Finalized but a tracked series is unsettled -> not sent, reason names the series', async () => {
  const h = rollHarness();
  const notes = await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + 300), rollReads({ vaults: [HOUSE_A], flat: { [HOUSE_A.toLowerCase()]: false } }));
  assert.equal(h.sends.length, 0);
  assert.equal(notes[0]!.decision, 'not-flat');
  // 11 is settled with 100 longs still held: rollEpoch redeems it (_redeemSettled before _requireFlat), so only 12,
  // unsettled, blocks. A change changed this expectation on purpose: it was '11:held/live,12:unsettled', a mirror of a
  // HouseVault without _redeemSettled, and it kept the keeper from ever rolling a vault that held a settled token.
  assert.equal(notes[0]!.detail, '12:unsettled');
});

/*
 * rollEpoch's settled-holdings rule and the fourth precondition. `held` gives vault A one tracked series
 * (11), settled, holding `longs` longs, a call unless `isPut`, paying `payout` per unit.
 */
const held = (o: { longs?: bigint; isPut?: boolean; payout?: bigint; live?: bigint } = {}): Partial<HouseRollReads> => ({
  readVault: async () => ({ epochEnd: EPOCH_END, epochId: 7n, underlying: NVDA_TOKEN, oracle: HOUSE_ORACLE, tracked: [11n] }),
  readTracked: async () => [{ longId: 11n, settled: true, longs: o.longs ?? 100n, shorts: 40n, live: o.live ?? 0n, isPut: o.isPut ?? false, longPayoutPerUnit: o.payout ?? 5_000_000n, oracle: HOUSE_ORACLE, underlying: NVDA_TOKEN }],
});

test('a vault holding settled longs and shorts is rolled -- rollEpoch redeems them itself; a live order still blocks', async () => {
  const h = rollHarness();
  const notes = await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + 300), rollReads({ vaults: [HOUSE_A], ...held() }));
  assert.equal(notes[0]!.decision, 'sent', 'settled holdings are redeemed inside the roll: nothing blocks it');
  assert.deepEqual(h.sends.map((s) => [s.vault, s.fn]), [[HOUSE_A, 'rollEpoch']]);
  const live = rollHarness();
  const blocked = await houseRoll(live.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + 300), rollReads({ vaults: [HOUSE_A], ...held({ live: 1n }) }));
  assert.equal(blocked[0]!.decision, 'not-flat');
  assert.equal(blocked[0]!.detail, '11:live order');
  assert.equal(live.sends.length, 0);
});

test('a converted ITM call with no fresh spot waits by name and pages only past the overdue window; a fresh spot rolls', async () => {
  const h = rollHarness();
  const asked: Array<[Address, Address]> = [];
  const reads = (fresh: boolean) => rollReads({ vaults: [HOUSE_A], ...held(), readConverts: async () => true, readSpotFresh: async (o, u) => (asked.push([o, u]), fresh) });
  const inside = await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + 300), reads(false));
  assert.equal(h.sends.length, 0, 'the NoSource revert is predicted, not sent');
  assert.equal(inside[0]!.decision, 'no-fresh-spot');
  assert.match(inside[0]!.detail!, /^waiting for a fresh spot: series 11 /);
  assert.deepEqual(asked, [[HOUSE_ORACLE, NVDA_TOKEN]], 'the spot is asked of the series\' own oracle and underlying');
  assert.equal(h.raised.length, 0, 'inside the overdue window: no page');
  await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + HOUSE_ROLL_OVERDUE_S + 1), reads(false));
  assert.equal(h.raised.length, 1);
  assert.equal(h.raised[0]!.kind, 'v2_house_roll_overdue');
  assert.match(h.raised[0]!.message, /no-fresh-spot \(waiting for a fresh spot: /);
  const fresh = rollHarness();
  const rolled = await houseRoll(fresh.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + 300), reads(true));
  assert.equal(rolled[0]!.decision, 'sent', 'with a fresh spot the roll goes out');
  assert.deepEqual(fresh.sends.map((s) => s.fn), ['rollEpoch']);
});

test('the spot is not asked for an in-kind vault, a put, an out-of-the-money call or a call the vault does not hold', async () => {
  for (const [name, over] of [
    ['in kind (the launch setting)', { ...held(), readConverts: async () => false }],
    ['a put pays USDG and never runs _spot', { ...held({ isPut: true }), readConverts: async () => true }],
    ['an OTM call long pays nothing', { ...held({ payout: 0n }), readConverts: async () => true }],
    ['only the short is held', { ...held({ longs: 0n }), readConverts: async () => true }],
  ] as Array<[string, Partial<HouseRollReads>]>) {
    const h = rollHarness();
    let asked = 0;
    const notes = await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + 300), rollReads({ vaults: [HOUSE_A], readSpotFresh: async () => (asked++, false), ...over }));
    assert.equal(notes[0]!.decision, 'sent', name);
    assert.equal(asked, 0, `${name}: no spot read`);
  }
});

test('chainHouseRollReads.readConverts is payoutPrefs(vault).inKind false with a payoutAdapter; readSpotFresh is spot(underlying) != 0', async () => {
  const ADAPTER = getAddress('0x00000000000000000000000000000000000000ad');
  let prefs: readonly [boolean, boolean] | Error = [false, false];
  let adapter: Address = ADAPTER;
  let spot: readonly [bigint, bigint] | Error = [0n, 0n];
  const calls: Array<{ address: Address; functionName: string; args?: readonly unknown[] }> = [];
  const client = {
    readContract: async (a: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      calls.push(a);
      const r = a.functionName === 'payoutPrefs' ? prefs : a.functionName === 'payoutAdapter' ? adapter : spot;
      if (r instanceof Error) throw r;
      return r;
    },
  };
  const CH = getAddress('0x00000000000000000000000000000000000000c1');
  const reads = chainHouseRollReads({ client, addresses: { clearinghouse: CH } } as never, []);
  assert.equal(await reads.readConverts(HOUSE_A, 1n), true, 'not in kind, adapter set: converts');
  assert.deepEqual(calls.filter((c) => c.functionName === 'payoutPrefs').map((c) => [c.address, c.args]), [[CH, [HOUSE_A]]]);
  prefs = [true, false];
  assert.equal(await reads.readConverts(HOUSE_A, 1n), false, 'in kind');
  prefs = [false, false];
  adapter = getAddress('0x0000000000000000000000000000000000000000');
  assert.equal(await reads.readConverts(HOUSE_A, 1n), false, 'no adapter: nothing to convert through');
  prefs = new Error('revert');
  assert.equal(await reads.readConverts(HOUSE_A, 1n), true, 'a failed read waits (the NoSource side)');
  assert.equal(await reads.readSpotFresh(HOUSE_ORACLE, NVDA_TOKEN, 1n), false, 'spot 0: HouseVault._spot reverts NoSource');
  spot = [180_000_000n, 1n];
  assert.equal(await reads.readSpotFresh(HOUSE_ORACLE, NVDA_TOKEN, 1n), true);
  spot = new Error('revert');
  assert.equal(await reads.readSpotFresh(HOUSE_ORACLE, NVDA_TOKEN, 1n), false, 'a reverting spot read is not fresh');
  assert.deepEqual(calls.filter((c) => c.functionName === 'spot').map((c) => [c.address, c.args]), [[HOUSE_ORACLE, [NVDA_TOKEN]], [HOUSE_ORACLE, [NVDA_TOKEN]], [HOUSE_ORACLE, [NVDA_TOKEN]]]);
});

test('house roll: two vaults due on a budget of one -> the second is deferred as no-budget, never squeezed past MM_MAX_TX_PER_TICK', async () => {
  const h = rollHarness();
  const notes = await houseRoll(h.ctx, newReport('house'), new Budget(1), headAt(EPOCH_END + 300), rollReads());
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0]!.vault, HOUSE_A);
  assert.deepEqual(notes.map((n) => n.decision), ['sent', 'no-budget']);
});

test('house roll: a send whose simulation reverts is recorded with its reason and not resent in the same tick', async () => {
  const h = rollHarness('simulation-reverted');
  const report = newReport('house');
  const notes = await houseRoll(h.ctx, report, new Budget(10), headAt(EPOCH_END + 300), rollReads({ vaults: [HOUSE_A] }));
  assert.equal(h.sends.length, 1, 'one attempt, no blind retry');
  assert.equal(notes[0]!.decision, 'sent');
  assert.match(notes[0]!.detail ?? '', /^simulation-reverted: NotSettled/);
  assert.equal(report.actions[0]!.revert, 'NotSettled()');
  assert.equal(h.cleared.length, 0, 'a reverted roll does not clear the overdue page');
});

/**
 * A vault whose boundary pin failed while money was exposed refuses rollEpoch
 * TooEarly(epochEnd + UNPINNED_BOUNDARY_HOLD) for 7 days. `until` answers the refusal's argument per call (null = the roll
 * goes through); the keeper holds no copy of the constant, so this 7 days lives only in the fake refusal.
 */
const UNPINNED_HOLD_S = 7 * 86_400;
function holdingSender(h: RollHarness, until: () => number | null, dryRun = false): void {
  h.ctx.sender = {
    ...h.ctx.sender,
    dryRun,
    async execute(call: FixedGasCall, options) {
      h.sends.push({ vault: call.address, fn: call.functionName, gas: call.gas, kind: options.kind, key: options.key });
      const t = until();
      if (t !== null) return { status: 'simulation-reverted', revert: 'TooEarly', revertArgs: [t], error: 'execution reverted: TooEarly(uint40)' };
      const k = call.address.toLowerCase();
      h.epochIdOf.set(k, (h.epochIdOf.get(k) ?? 0n) + 1n);
      return { status: 'confirmed', hash: `0x${'cd'.repeat(32)}`, nonce: 1, blockNumber: 65_000_000n, gasUsed: 1n, result: undefined };
    },
  };
}

test('a roll the vault holds (TooEarly(end + 7 days)) is recorded once, then neither simulated nor paged until the stated time, woken at it, then rolled', async () => {
  const h = rollHarness();
  let held = true;
  holdingSender(h, () => (held ? EPOCH_END + UNPINNED_HOLD_S : null));
  const reads = rollReads({ vaults: [HOUSE_A] });
  const first = newReport('house');
  const seen = await houseRoll(h.ctx, first, new Budget(10), headAt(EPOCH_END + 300), reads);
  assert.equal(h.sends.length, 1, 'the refusal is learned from one simulation');
  assert.equal(seen[0]!.decision, 'held');
  assert.equal(seen[0]!.heldUntil, EPOCH_END + UNPINNED_HOLD_S);
  assert.match(seen[0]!.detail ?? '', /TooEarly\(\d+\) until .* pinnedBoundary != epochEnd/);
  assert.deepEqual(first.wakeAt, [EPOCH_END + UNPINNED_HOLD_S], 'the step asks to wake when the hold ends');
  assert.deepEqual(JSON.parse(h.ctx.store.getMeta(houseRollHeldMetaKey(HOUSE_A))!), { epochId: '7', epochEnd: EPOCH_END, until: EPOCH_END + UNPINNED_HOLD_S, at: EPOCH_END + 300 });
  // Past the overdue window, still inside the hold: no simulation, no send, no overdue page (the old code paged here
  // every tick for a week and re-simulated every tick).
  const later = newReport('house');
  const waiting = await houseRoll(h.ctx, later, new Budget(10), headAt(EPOCH_END + HOUSE_ROLL_OVERDUE_S + 60), reads);
  assert.equal(h.sends.length, 1, 'not simulated again inside the hold');
  assert.equal(waiting[0]!.decision, 'held');
  assert.equal(later.actions.length, 0);
  assert.deepEqual(later.wakeAt, [EPOCH_END + UNPINNED_HOLD_S]);
  assert.equal(h.raised.length, 0, 'a held boundary is a wait with a known end, not an overdue roll');
  assert.ok(h.cleared.some((c) => c.kind === 'v2_house_roll_overdue' && c.dedupeKey === HOUSE_A.toLowerCase()), 'a page raised before the hold was known is cleared');
  // At the stated time the roll goes through, and the mark is dropped.
  held = false;
  const rolled = await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + UNPINNED_HOLD_S), reads);
  assert.equal(h.sends.length, 2);
  assert.equal(rolled[0]!.decision, 'sent');
  assert.equal(rolled[0]!.detail, 'confirmed');
  assert.equal(h.ctx.store.getMeta(houseRollHeldMetaKey(HOUSE_A)), null);
});

test('TooEarly(epochEnd) is the node clock behind the head, not a hold: nothing recorded, the next tick simulates again', async () => {
  const h = rollHarness();
  holdingSender(h, () => EPOCH_END);
  const reads = rollReads({ vaults: [HOUSE_A] });
  const notes = await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + 300), reads);
  assert.equal(notes[0]!.decision, 'sent');
  assert.match(notes[0]!.detail ?? '', /^simulation-reverted: TooEarly/);
  assert.equal(h.ctx.store.getMeta(houseRollHeldMetaKey(HOUSE_A)), null);
  await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + 360), reads);
  assert.equal(h.sends.length, 2, 'retried next tick as before');
});

test('a hold recorded for another epoch, or a garbled one, is dropped and the roll is sent', async () => {
  for (const raw of [JSON.stringify({ epochId: '6', epochEnd: EPOCH_END - 604_800, until: EPOCH_END + UNPINNED_HOLD_S, at: 1 }), 'not json']) {
    const h = rollHarness();
    h.ctx.store.setMeta(houseRollHeldMetaKey(HOUSE_A), raw);
    const notes = await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + 300), rollReads({ vaults: [HOUSE_A] }));
    assert.equal(notes[0]!.decision, 'sent', raw);
    assert.equal(h.sends.length, 1, raw);
    assert.equal(h.ctx.store.getMeta(houseRollHeldMetaKey(HOUSE_A)), null, raw);
  }
});

test('a dry run reports the hold but records nothing', async () => {
  const h = rollHarness();
  holdingSender(h, () => EPOCH_END + UNPINNED_HOLD_S, true);
  const notes = await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + 300), rollReads({ vaults: [HOUSE_A] }));
  assert.equal(notes[0]!.decision, 'held');
  assert.equal(h.ctx.store.getMeta(houseRollHeldMetaKey(HOUSE_A)), null);
});

test('houseRollHeldUntil reads only a TooEarly whose argument is after the boundary', () => {
  const reverted = (revert: string | null, revertArgs?: readonly unknown[]) => ({ status: 'simulation-reverted' as const, revert, error: 'x', ...(revertArgs === undefined ? {} : { revertArgs }) });
  assert.equal(houseRollHeldUntil(reverted('TooEarly', [EPOCH_END + 1]), EPOCH_END), EPOCH_END + 1);
  assert.equal(houseRollHeldUntil(reverted('TooEarly', [BigInt(EPOCH_END + UNPINNED_HOLD_S)]), EPOCH_END), EPOCH_END + UNPINNED_HOLD_S, 'a bigint argument');
  assert.equal(houseRollHeldUntil(reverted('TooEarly', [EPOCH_END]), EPOCH_END), null);
  assert.equal(houseRollHeldUntil(reverted('TooEarly'), EPOCH_END), null, 'no decoded argument');
  assert.equal(houseRollHeldUntil(reverted('NotSettled', [EPOCH_END + 1]), EPOCH_END), null);
  assert.equal(houseRollHeldUntil({ status: 'confirmed', hash: `0x${'cd'.repeat(32)}`, nonce: 1, blockNumber: 1n, gasUsed: 1n, result: undefined }, EPOCH_END), null);
});

test('house roll: no factory configured -> a documented no-op, nothing read, nothing sent', async () => {
  const h = rollHarness();
  const notes = await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + 300), rollReads({ factories: [], discover: async () => assert.fail('must not enumerate') }));
  assert.deepEqual(notes, []);
  assert.equal(h.sends.length, 0);
});

test('STEP_ORDER: house is its own step, after redeem (a vault is only flat once its series are settled and redeemed) and before ladders', () => {
  const order = [...STEP_ORDER];
  assert.equal(order.filter((s) => s === 'house').length, 1);
  assert.equal(order.indexOf('house'), order.indexOf('redeem') + 1);
  assert.equal(order.indexOf('house') + 1, order.indexOf('ladders'));
  assert.ok(order.indexOf('house') > order.indexOf('settle'));
  assert.ok(order.indexOf('house') < order.indexOf('housekeeping'));
});

/** A client for the step-level tests: a head, a multicall that answers 0 for everything, and every factory enumeration recorded. */
function stepClient(h: RollHarness, timestamp: number): { enumerated: Address[] } {
  const enumerated: Address[] = [];
  const epochIdRead = h.ctx.client.readContract;
  h.ctx.client = {
    getBlock: async () => ({ number: 65_000_100n, timestamp: BigInt(timestamp) }),
    getBlockNumber: async () => 65_000_100n,
    multicall: async ({ contracts }: { contracts: readonly unknown[] }) => contracts.map(() => ({ status: 'success', result: 0n })),
    readContract: async (args: { functionName: string; address: Address }) => {
      if (args.functionName === 'vaults') {
        enumerated.push(args.address);
        return [];
      }
      return epochIdRead(args as never);
    },
  } as never;
  return { enumerated };
}

test('stepHouse: reports as step house, notes { factory, houseRoll }, and its action carries kind house-roll', async () => {
  const h = rollHarness();
  stepClient(h, EPOCH_END + 300);
  const report = await stepHouse(h.ctx, rollReads({ vaults: [HOUSE_A] }));
  assert.equal(report.step, 'house');
  assert.deepEqual(report.notes.factories, [FACTORY]);
  const notes = report.notes.houseRoll as Array<{ vault: Address; decision: string; detail?: string }>;
  assert.deepEqual(notes.map((n) => [n.vault, n.decision, n.detail]), [[HOUSE_A, 'sent', 'confirmed']]);
  assert.deepEqual(report.actions.map((a) => a.kind), [HOUSE_ROLL_KIND]);
  assert.equal(h.sends.length, 1);
});

test('stepHouse: an unenumerable factory keeps the error note instead of an empty list', async () => {
  const h = rollHarness();
  stepClient(h, EPOCH_END + 300);
  const report = await stepHouse(h.ctx, rollReads({ discover: async () => { throw new Error('vaults reverted'); } }));
  assert.deepEqual(report.notes.factories, [FACTORY]);
  const errors = report.notes.houseRollErrors as Array<{ factory: Address; error: string }>;
  assert.deepEqual(errors.map((e) => e.factory), [FACTORY]);
  assert.match(errors[0]!.error, /vaults\(\) failed: .*vaults reverted/);
  assert.deepEqual(report.notes.houseRoll, []);
  assert.equal(h.sends.length, 0);
});

test('the roll enumerates EVERY factory (legacy and kinded), one failing factory does not stop the others, and weekly() is never read', async () => {
  const h = rollHarness();
  stepClient(h, EPOCH_END + 300);
  const LEGACY = getAddress('0x00000000000000000000000000000000000fac01');
  const KINDED = getAddress('0x00000000000000000000000000000000000fac02');
  const BROKEN = getAddress('0x00000000000000000000000000000000000fac03');
  const enumerated: Address[] = [];
  const report = await stepHouse(h.ctx, rollReads({
    factories: [LEGACY, BROKEN, KINDED],
    discover: async (f) => {
      enumerated.push(f);
      if (f === BROKEN) throw new Error('vaults reverted');
      return f === LEGACY ? [HOUSE_A] : [HOUSE_B];
    },
  }));
  assert.deepEqual(enumerated, [LEGACY, BROKEN, KINDED]);
  const notes = report.notes.houseRoll as Array<{ vault: Address; factory: Address; decision: string }>;
  assert.deepEqual(notes.map((n) => [n.vault, n.factory, n.decision]), [[HOUSE_A, LEGACY, 'sent'], [HOUSE_B, KINDED, 'sent']]);
  assert.deepEqual((report.notes.houseRollErrors as Array<{ factory: Address }>).map((e) => e.factory), [BROKEN]);
  // The real chain reads: a legacy vault has no weekly() getter, so the roll must never ask. Record what readVault
  // calls against a client that answers every getter.
  const called: string[] = [];
  const reads = chainHouseRollReads({
    client: { readContract: async (args: { functionName: string }) => { called.push(args.functionName); return args.functionName === 'trackedSeries' ? [] : args.functionName === 'epochEnd' || args.functionName === 'epochId' ? 1n : LEGACY; } },
  } as never, [LEGACY]);
  assert.notEqual(await reads.readVault(HOUSE_A, 1n), null, 'positive control: the recording client answers the roll read');
  // A change adds the boundary expiry's settlementConfig (its live uncorroborated delay times the overdue page); the
  // mock answers it as pinned, so marketConfig is not asked.
  assert.deepEqual([...called].sort(), ['epochEnd', 'epochId', 'oracle', 'settlementConfig', 'trackedSeries', 'underlying']);
  assert.ok(!called.includes('weekly'));
});

test('while the MM bot winds the weekly vaults down, the cranker still rolls the legacy weekly vault that is due', async () => {
  const h = rollHarness();
  stepClient(h, EPOCH_END + 300);
  const LEGACY = getAddress('0x00000000000000000000000000000000000fac11');
  const KINDED = getAddress('0x00000000000000000000000000000000000fac12');
  const factories = [{ address: LEGACY, kind: 'legacy-weekly' as const }, { address: KINDED, kind: 'kinded' as const }];
  h.ctx.config = { ...h.ctx.config, tuning: { ...h.ctx.config.tuning, houseFactories: factories } };
  // Precondition: this is the wind-down configuration -- the bot opens no new weekly exposure (mm/house.ts).
  assert.equal(legacyWeeklyWindingDown('legacy-weekly', factories), true);
  // The weekly vault's final epoch has ended; the daily factory has no vault due yet.
  const report = await stepHouse(h.ctx, rollReads({ factories: [LEGACY, KINDED], discover: async (f) => (f === LEGACY ? [HOUSE_A] : []) }));
  const notes = report.notes.houseRoll as Array<{ vault: Address; factory: Address; decision: string }>;
  assert.deepEqual(notes.map((n) => [n.vault, n.factory, n.decision]), [[HOUSE_A, LEGACY, 'sent']], 'the last weekly epoch is closed by the roll');
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0]!.vault, HOUSE_A);
});

test('stepHouse: no factory in the tuning -> nothing read, not even the head, nothing sent', async () => {
  const h = rollHarness();
  assert.deepEqual(h.ctx.config.tuning.houseFactories, [], 'the harness config sets neither CRANKER_HOUSE_FACTORY nor MM_HOUSE_FACTORY');
  h.ctx.client = { getBlock: async () => assert.fail('no head read'), readContract: async () => assert.fail('no chain read') } as never;
  const report = await stepHouse(h.ctx);
  assert.deepEqual(report.notes, { factories: [], houseRoll: [] });
  assert.equal(h.sends.length, 0);
});

test('stepHouse: the factory comes from CrankerTuning.houseFactories, not the environment', async () => {
  const h = rollHarness();
  const client = stepClient(h, EPOCH_END + 300);
  h.ctx.config = { ...h.ctx.config, tuning: { ...h.ctx.config.tuning, houseFactories: [{ address: FACTORY, kind: 'legacy-weekly' }] } };
  const saved = process.env.CRANKER_HOUSE_FACTORY;
  process.env.CRANKER_HOUSE_FACTORY = HOUSE_B;
  try {
    const report = await stepHouse(h.ctx);
    assert.deepEqual(report.notes.factories, [FACTORY]);
  } finally {
    if (saved === undefined) delete process.env.CRANKER_HOUSE_FACTORY;
    else process.env.CRANKER_HOUSE_FACTORY = saved;
  }
  assert.deepEqual(client.enumerated, [FACTORY], 'the tuning factory is enumerated; the environment value is ignored');
});

test('stepHousekeeping: no longer rolls House vaults - a configured factory is never enumerated there and its notes carry no houseRoll', async () => {
  const h = rollHarness();
  const client = stepClient(h, EPOCH_END + 300);
  h.ctx.config = { ...h.ctx.config, tuning: { ...h.ctx.config.tuning, houseFactories: [{ address: FACTORY, kind: 'legacy-weekly' }] } };
  const report = await stepHousekeeping(h.ctx, getAddress('0x00000000000000000000000000000000000000e5'));
  assert.equal(report.step, 'housekeeping');
  assert.equal('houseRoll' in report.notes, false);
  assert.deepEqual(client.enumerated, []);
  assert.equal(h.sends.filter((s) => s.kind === HOUSE_ROLL_KIND).length, 0);
});

/*//////////////////////////////////////////////////////////////
   a simulation the node never ANSWERED is paged as a transport failure, once per step kind
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
  // The risk: a node that stops answering simulations arrives as `simulation-reverted` and, below the
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


/* ---------------------------------------------------------------------------------------------- */
/* the EarnVault queue is paid in the house step once the vault's series have settled   */
/* ---------------------------------------------------------------------------------------------- */

import { STARVED_CALL_SLACK, VENUE_PULL_GAS, starvedCeiling } from './constants.js';
import {
  CHAIN_MAX_TX_GAS,
  EARN_PROCESS_QUEUE_DRAIN_SKIM_GAS,
  EARN_PROCESS_QUEUE_GAS_BASE,
  EARN_PROCESS_QUEUE_GAS_PER_ENTRY,
  EARN_PROCESS_QUEUE_KIND,
  EARN_PROCESS_QUEUE_MAX_ENTRIES,
  EARN_SKIM_GAS,
  EARN_SKIM_KIND,
  EARN_SKIM_MEASURED_BUDGET,
  EARN_SKIM_REFUSED_RETRY_S,
  earnProcessQueueGas,
  earnSharePrice,
  earnSkimFollowUp,
  earnSkimMetaKey,
} from './steps.js';

const EARN = getAddress('0x00000000000000000000000000000000000ea4a1');
/** What EarnVault.convertToAssets reverts with while its venue cannot be read. */
const venueUnreadableRevert = () =>
  new ContractFunctionRevertedError({ abi: earnVaultAbi, data: encodeErrorResult({ abi: earnVaultAbi, errorName: 'VenueUnreadable' }), functionName: 'convertToAssets' });

/** A cranker with V2_EARN_VAULT set, no House factory, and a mocked EarnVault queue. */
function earnHarness(init: { head: bigint; tail: bigint; position: boolean; payable?: number; batch?: number; simReverts?: number; drainSkimFee?: bigint; venueUnreadable?: boolean }) {
  const h = rollHarness();
  const v = {
    head: init.head, tail: init.tail, position: init.position, payable: init.payable ?? 1_000, simReverts: init.simReverts ?? 0,
    venueUnreadable: init.venueUnreadable ?? false,
    // Flat by default: price == mark, so a zero-fee skim is "nothing owed" and the interval starts.
    mark: 1_000_000n, assets: 1_000_000n, supply: 10n ** 18n, fee: 0n, moveMark: false,
    // The fee the skim at the end of a DRAINING processQueue takes; null = no drain skim.
    drainSkimFee: init.drainSkimFee ?? null,
    /** The n-th highWaterMark() read (1-based) throws, as an RPC that did not answer. 0 = none. */
    failMarkRead: 0, markReads: 0,
  };
  const sends: Array<{ fn: string; args: readonly unknown[]; gas: bigint; kind: string; key: string }> = [];
  h.ctx.config = { ...h.ctx.config, tuning: { ...h.ctx.config.tuning, houseFactories: [], earn: { vault: EARN, queueBatch: init.batch ?? 10, queueCallsPerTick: 5, skimIntervalS: 86_400 } } };
  h.ctx.client = {
    getBlock: async () => assert.fail('the Earn half needs no head read'),
    readContract: async ({ address, functionName }: { address: Address; functionName: string }) => {
      assert.equal(address, EARN);
      if (functionName === 'queue') return [v.head, v.tail] as const;
      if (functionName === 'hasOpenPosition') return v.position;
      if (functionName === 'highWaterMark') {
        v.markReads += 1;
        if (v.markReads === v.failMarkRead) throw new Error('HTTP request failed: 429 Too Many Requests');
        return v.mark;
      }
      if (functionName === 'totalAssets') return v.assets;
      if (functionName === 'totalSupply') return v.supply;
      // The probe readVenueUnpriced sends. The contract checks PositionOpen first, then VenueUnreadable.
      if (functionName === 'convertToAssets') {
        if (v.position) throw new ContractFunctionRevertedError({ abi: earnVaultAbi, data: encodeErrorResult({ abi: earnVaultAbi, errorName: 'PositionOpen' }), functionName });
        if (v.venueUnreadable) throw venueUnreadableRevert();
        return 1n;
      }
      return assert.fail(`no chain read ${functionName}`);
    },
  } as never;
  h.ctx.sender = {
    dryRun: false,
    account: '0x000000000000000000000000000000000000beef',
    async execute(call: FixedGasCall, options) {
      sends.push({ fn: call.functionName, args: (call.args ?? []) as readonly unknown[], gas: call.gas, kind: options.kind, key: options.key });
      if (call.functionName === 'skim') {
        if (v.moveMark) v.mark = earnSharePrice(v.assets, v.supply);
        return { status: 'confirmed', hash: `0x${'ab'.repeat(32)}`, nonce: 1, blockNumber: 65_000_000n, gasUsed: 1n, result: v.fee };
      }
      // The batch reverts in simulation (a starved venue pull reverts the whole processQueue).
      if (v.simReverts > 0) {
        v.simReverts -= 1;
        return { status: 'simulation-reverted', revert: null, error: 'execution reverted' };
      }
      // processQueue serves nothing while a position is open or the venue cannot be read.
      if (!v.position && !v.venueUnreadable) {
        const n = BigInt(Math.min(Number(call.args![0] as bigint), v.payable, Number(v.tail - v.head + 1n)));
        v.head += n;
        v.payable -= Number(n);
        // The call that drains the queue runs _skim: the fee leaves and the mark moves to the post-fee price.
        if (v.drainSkimFee !== null && v.head > v.tail) {
          v.assets -= v.drainSkimFee;
          v.mark = earnSharePrice(v.assets, v.supply);
        }
      }
      return { status: 'confirmed', hash: `0x${'ab'.repeat(32)}`, nonce: 1, blockNumber: 65_000_000n, gasUsed: 1n, result: 0n };
    },
  };
  return { ...h, v, sends };
}

test('earn: a settled vault with a queue gets processQueue until the queue is empty, with per-batch gas and a head-keyed send', async () => {
  const e = earnHarness({ head: 1n, tail: 23n, position: false });
  const report = await stepHouse(e.ctx);
  const queue = e.sends.filter((s) => s.fn === 'processQueue');
  assert.deepEqual(e.sends.map((s) => s.fn), ['processQueue', 'processQueue', 'processQueue', 'skim'], 'the queue first; the skim only once it is empty');
  assert.deepEqual(queue.map((s) => s.args[0]), [10n, 10n, 10n]);
  // The gas is sized per entry. A change adds the venue-pull ceiling on top of that budget, and another adds the
  // skim the call that drains the queue runs.
  assert.ok(queue.every((s) => s.gas === earnProcessQueueGas(10) && s.kind === EARN_PROCESS_QUEUE_KIND));
  assert.equal(queue[0]!.gas, starvedCeiling(VENUE_PULL_GAS) + 12_000_000n + EARN_SKIM_MEASURED_BUDGET);
  assert.deepEqual(queue.map((s) => s.key), [`${EARN.toLowerCase()}:1`, `${EARN.toLowerCase()}:11`, `${EARN.toLowerCase()}:21`]);
  assert.deepEqual(report.notes.earnQueue, { vault: EARN, calls: 3, served: '23', stop: 'empty', head: '24', tail: '23', hasOpenPosition: false, skim: 'confirmed' });
  assert.deepEqual(report.notes.houseRoll, [], 'no House factory: the roll half did nothing');
});

test('earn: processQueue gas covers the measured worst case with margin and stays under the 4663 tx cap', () => {
  // Fork measurements (steps.ts, EARN_PROCESS_QUEUE_GAS_BASE): the launch venue wired, every entry pulling from it,
  // and the vault tracking the most book orders it can (128), which every totalAssets() in the loop re-reads.
  const measuredWorst = [
    { entries: 1, gas: 2_402_708n },
    { entries: 20, gas: 17_625_757n },
  ];
  for (const m of measuredWorst) {
    const sent = earnProcessQueueGas(m.entries);
    assert.ok(sent * 100n >= m.gas * 120n, `${m.entries} entries: ${sent} is not 20 % over the measured ${m.gas}`);
  }
  // Without tracked orders the same 20 entries measured 2,165,962: the flat 4M this replaced fit only that case.
  assert.ok(earnProcessQueueGas(20) > 4_000_000n);
  assert.equal(EARN_PROCESS_QUEUE_GAS_BASE, 2_000_000n);
  assert.equal(EARN_PROCESS_QUEUE_GAS_PER_ENTRY, 1_000_000n);
  assert.equal(earnProcessQueueGas(20), starvedCeiling(VENUE_PULL_GAS) + 22_000_000n + EARN_SKIM_MEASURED_BUDGET,
    'the default EARN_QUEUE_BATCH, plus the pull ceiling and the drain skim (T-OP-950)');
  assert.equal(CHAIN_MAX_TX_GAS, 32_000_000n, 'ArbGasInfo maxTxGasLimit on 4663');
  // 22 before the drain skim was reserved; (32M - 2M - 5,089,365 - 2M - 3.5M) / 1M = 19 with it.
  assert.equal(EARN_PROCESS_QUEUE_MAX_ENTRIES, 19);
  assert.ok(earnProcessQueueGas(EARN_PROCESS_QUEUE_MAX_ENTRIES) <= CHAIN_MAX_TX_GAS - 2_000_000n, 'the largest send keeps 2M under the cap');
  assert.ok(earnProcessQueueGas(EARN_PROCESS_QUEUE_MAX_ENTRIES + 1) > CHAIN_MAX_TX_GAS - 2_000_000n, 'and one more entry would not');
});

test('earn: skim gas covers the measured worst case with margin and stays well under the 4663 tx cap', () => {
  // Fork measurements (steps.ts, EARN_SKIM_GAS): eth_estimateGas of skim(), the smallest limit that succeeds. The worst
  // case is 128 tracked Bids with the fee raised from the ledger AND the venue.
  const measured = { flat: 228_606n, gainSmallSupply: 610_364n, worst128Bids: 2_817_194n, bids120Shorts8: 2_791_438n };
  for (const [name, gas] of Object.entries(measured)) {
    assert.ok(EARN_SKIM_GAS * 100n >= gas * 120n, `${name}: ${EARN_SKIM_GAS} is not 20 % over the measured ${gas}`);
  }
  // The 1,000,000 this replaced ran out of gas in the worst case.
  assert.ok(measured.worst128Bids > 1_000_000n);
  assert.equal(EARN_SKIM_MEASURED_BUDGET, 3_500_000n, 'the measured budget is unchanged; it is no longer the send');
  assert.equal(EARN_SKIM_GAS, starvedCeiling(VENUE_PULL_GAS) + EARN_SKIM_MEASURED_BUDGET);
  // CHAIN_MAX/8 (4M) is under the pull ceiling, so it cannot be the bound. The send stays 2M under the chain cap.
  assert.ok(EARN_SKIM_GAS <= CHAIN_MAX_TX_GAS - 2_000_000n, 'skim stays 2M under the chain cap');
});

test('earn: skim and the smallest processQueue batch are at or above the venue-pull ceiling', () => {
  // Re-derived from EarnVault.sol: VENUE_PULL_GAS 5_000_000, StarvedCall.belowCeiling = cap + cap/63 + CALL_SLACK.
  assert.equal(VENUE_PULL_GAS, 5_000_000n);
  assert.equal(STARVED_CALL_SLACK, 10_000n);
  const ceiling = 5_000_000n + 5_000_000n / 63n + STARVED_CALL_SLACK;
  assert.equal(ceiling, 5_089_365n);
  assert.equal(starvedCeiling(VENUE_PULL_GAS), ceiling);
  // The old sends. A skim of 3.5M, and processQueue of 1, 2, or 3 entries (3M, 4M, 5M), are under the ceiling.
  assert.ok(3_500_000n < ceiling, 'the budget T-OP-929 called not SHORT does not hold the ceiling');
  for (const entries of [1, 2, 3]) {
    const old = 2_000_000n + 1_000_000n * BigInt(entries);
    assert.ok(old < ceiling, `the old processQueue(${entries}) budget ${old} is under the ceiling`);
    assert.ok(earnProcessQueueGas(entries) >= ceiling, `processQueue(${entries})`);
  }
  // Plus the 3.5M drain skim. With it the default batch of 20 no longer fits one send (below: the
  // drain loop sends a batch above the cap as capped calls).
  assert.equal(earnProcessQueueGas(1), ceiling + 3_000_000n + 3_500_000n);
  assert.equal(EARN_SKIM_GAS, ceiling + 3_500_000n);
  assert.ok(earnProcessQueueGas(EARN_PROCESS_QUEUE_MAX_ENTRIES) <= CHAIN_MAX_TX_GAS - 2_000_000n, 'the largest send fits under the cap');
  assert.ok(earnProcessQueueGas(20) > CHAIN_MAX_TX_GAS - 2_000_000n, 'the default batch of 20 is sent as capped calls now');
});

test('earn: a processQueue that drains the queue has room for the skim it now runs at its end', () => {
  // EarnVault.processQueue ends `if (head > tail && _mintedNetOfFee) _skim();` (EarnVault.sol processQueue),
  // the same _skim a skim() send runs. Derived from skim's own budget, not copied.
  assert.equal(EARN_PROCESS_QUEUE_DRAIN_SKIM_GAS, EARN_SKIM_MEASURED_BUDGET);
  const ceiling = starvedCeiling(VENUE_PULL_GAS);
  // Measured worst cases (steps.ts): processQueue(1) 2,402,708 and processQueue(20) 17,625,757 with every entry pulling
  // from the venue and 128 tracked orders; skim 2,817,194 with the fee raised from the ledger AND the venue. A drain
  // skim's venue pull re-throws unless gasleft is still the ceiling, so the send must hold the ceiling on top of both.
  const skimWorst = 2_817_194n;
  for (const m of [{ entries: 1, gas: 2_402_708n }, { entries: 20, gas: 17_625_757n }]) {
    const sent = earnProcessQueueGas(m.entries);
    assert.ok(sent >= ceiling + m.gas + skimWorst,
      `processQueue(${m.entries}) that drains: ${sent} < ceiling ${ceiling} + batch ${m.gas} + skim ${skimWorst}`);
  }
  // Every batch size carries the whole drain skim on top of its own per-entry budget, not in place of any of it.
  for (let n = 1; n <= EARN_PROCESS_QUEUE_MAX_ENTRIES; n++) {
    assert.equal(earnProcessQueueGas(n),
      ceiling + EARN_PROCESS_QUEUE_GAS_BASE + EARN_PROCESS_QUEUE_GAS_PER_ENTRY * BigInt(n) + EARN_SKIM_MEASURED_BUDGET, `processQueue(${n})`);
  }
});

test('earn: a draining 1-entry batch is sent with the drain-skim budget on top of the ceiling and the entry', async () => {
  const e = earnHarness({ head: 7n, tail: 7n, position: false, batch: 1 });
  await stepHouse(e.ctx);
  const queue = e.sends.filter((s) => s.fn === 'processQueue');
  assert.deepEqual(queue.map((s) => s.args[0]), [1n]);
  assert.equal(queue[0]!.gas, starvedCeiling(VENUE_PULL_GAS) + EARN_PROCESS_QUEUE_GAS_BASE + EARN_PROCESS_QUEUE_GAS_PER_ENTRY + EARN_SKIM_MEASURED_BUDGET);
  assert.equal(queue[0]!.gas, 11_589_365n, '5,089,365 + 2M + 1M + 3.5M');
});

test('earn: a skim run by the draining processQueue is not the cranker\'s own: no retry, no page, its own skim keeps its interval', async () => {
  // The vault is 10 % up on the mark when the queue drains, and the drain skim takes the fee.
  const e = earnHarness({ head: 1n, tail: 3n, position: false, drainSkimFee: 10_000n });
  e.v.assets = 1_100_000n;
  const t0 = Math.floor(Date.now() / 1000);
  const report = await stepHouse(e.ctx);
  const t1 = Math.floor(Date.now() / 1000);
  assert.deepEqual(e.sends.map((s) => s.fn), ['processQueue', 'skim'], 'processQueue once (not re-sent for its skim), then the interval skim');
  assert.equal(e.v.mark, earnSharePrice(1_090_000n, 10n ** 18n), 'the drain skim moved the mark');
  // The cranker's own skim now finds the price at the mark: nothing owed, not a refusal of the fee the queue already took.
  assert.equal((report.notes.earnQueue as { skim: string }).skim, 'confirmed');
  assert.equal(e.raised.filter((a) => a.kind === 'v2_earn_skim_refused').length, 0);
  const stored = Number(e.ctx.store.getMeta(earnSkimMetaKey(EARN)));
  assert.ok(stored >= t0 && stored <= t1, 'its own confirmed skim starts the full interval');
  await stepHouse(e.ctx);
  assert.deepEqual(e.sends.map((s) => s.fn), ['processQueue', 'skim'], 'the next tick sends nothing: the queue is empty and the skim is not due');
});

test('earn: a processQueue that reverts (a starved pull) is not success: the drain stops, serves nothing, no skim, and the next tick re-sends from the same head', async () => {
  const e = earnHarness({ head: 1n, tail: 5n, position: false, simReverts: 1 });
  const first = await stepHouse(e.ctx);
  assert.deepEqual(e.sends.map((s) => s.fn), ['processQueue'], 'one send, then stop: no second batch and no skim with the queue open');
  assert.deepEqual(first.notes.earnQueue, { vault: EARN, calls: 1, served: '0', stop: 'not-confirmed', head: '1', tail: '5', hasOpenPosition: false, skim: 'queue-open' });
  assert.equal(first.actions[0]!.status, 'simulation-reverted');
  const second = await stepHouse(e.ctx);
  const queue = e.sends.filter((s) => s.fn === 'processQueue');
  assert.deepEqual(queue.map((s) => s.key), [`${EARN.toLowerCase()}:1`, `${EARN.toLowerCase()}:1`], 'retried from chain state under the same head key');
  assert.equal((second.notes.earnQueue as { stop: string }).stop, 'empty');
  assert.equal((second.notes.earnQueue as { served: string }).served, '5');
});

test('earn: a configured batch above the cap is sent as capped calls, each with the gas for what it asks', async () => {
  const e = earnHarness({ head: 1n, tail: 60n, position: false, batch: 200 });
  const report = await stepHouse(e.ctx);
  const queue = e.sends.filter((s) => s.fn === 'processQueue');
  // Capped at 19 (22 before the drain skim was reserved), so 60 entries take a fourth call.
  assert.deepEqual(queue.map((s) => s.args[0]), [19n, 19n, 19n, 19n], 'EARN_QUEUE_BATCH 200 is capped at 19 per send');
  assert.ok(queue.every((s) => s.gas === earnProcessQueueGas(19) && s.gas <= CHAIN_MAX_TX_GAS));
  assert.equal((report.notes.earnQueue as { stop: string }).stop, 'empty', 'the drain loop re-reads the head, so the rest is paid by the next call');
  assert.equal((report.notes.earnQueue as { served: string }).served, '60');
});

test('earn: while the vault still holds a position nothing is sent; the first tick after it settles pays the queue', async () => {
  const e = earnHarness({ head: 5n, tail: 9n, position: true });
  const held = await stepHouse(e.ctx);
  assert.equal(e.sends.length, 0, 'no processQueue, and no skim while the queue is open');
  assert.equal((held.notes.earnQueue as { skim: string }).skim, 'queue-open');
  assert.equal((held.notes.earnQueue as { stop: string }).stop, 'open-position');
  e.v.position = false; // the series settles and prunes to none
  const paid = await stepHouse(e.ctx);
  assert.deepEqual(e.sends.map((s) => s.fn), ['processQueue', 'skim']);
  assert.equal((paid.notes.earnQueue as { stop: string; served: string }).stop, 'empty');
  assert.equal((paid.notes.earnQueue as { served: string }).served, '5');
});

test('earn: while the vault cannot read its venue nothing is sent (processQueue would serve nothing); once it reads, the queue is paid', async () => {
  const e = earnHarness({ head: 5n, tail: 9n, position: false, venueUnreadable: true });
  const held = await stepHouse(e.ctx);
  assert.equal(e.sends.length, 0, 'no processQueue while the vault refuses to price, and no skim with the queue open');
  assert.deepEqual(held.notes.earnQueue, { vault: EARN, calls: 0, served: '0', stop: 'venue-unreadable', head: '5', tail: '9', hasOpenPosition: false, skim: 'queue-open' });
  e.v.venueUnreadable = false; // the venue reads again (or TREASURY_ADMIN wrote it off)
  const paid = await stepHouse(e.ctx);
  assert.deepEqual(e.sends.map((s) => s.fn), ['processQueue', 'skim']);
  assert.equal((paid.notes.earnQueue as { stop: string; served: string }).stop, 'empty');
  assert.equal((paid.notes.earnQueue as { served: string }).served, '5');
});

test('earn: no skim while the venue cannot be read, and none recorded, so the first readable tick skims at once', async () => {
  const e = earnHarness({ head: 4n, tail: 3n, position: false, venueUnreadable: true });
  const held = await stepHouse(e.ctx);
  assert.equal(e.sends.length, 0, 'a skim then takes nothing (Skimmed(0, 0)) and would only spend gas');
  assert.equal((held.notes.earnQueue as { skim: string }).skim, 'venue-unreadable');
  assert.equal(e.ctx.store.getMeta(earnSkimMetaKey(EARN)), null, 'the interval is not marked as skimmed');
  e.v.venueUnreadable = false;
  const next = await stepHouse(e.ctx);
  assert.deepEqual(e.sends.map((s) => s.fn), ['skim'], 'not held back a whole interval by the skipped one');
  assert.equal((next.notes.earnQueue as { skim: string }).skim, 'confirmed');
});

test('earn: short of cash, one call that serves nothing ends the tick instead of spinning', async () => {
  const e = earnHarness({ head: 1n, tail: 30n, position: false, payable: 4 });
  const report = await stepHouse(e.ctx);
  assert.deepEqual(e.sends.map((s) => s.fn), ['processQueue', 'processQueue'], 'no skim: the queue is still open');
  assert.equal((report.notes.earnQueue as { stop: string }).stop, 'no-progress');
});

test('earn: V2_EARN_VAULT unset -> the tuning is null and the step still reads nothing', () => {
  const h = rollHarness();
  assert.equal(h.ctx.config.tuning.earn, null);
  const withEarn = loadV2Config({ V2_MODE: 'cranker', RH_RPC: 'http://127.0.0.1:9', CRANKER_PK: `0x${'11'.repeat(32)}`, V2_REGISTRY_PATH: REGISTRY, V2_EARN_VAULT: EARN.toLowerCase() }) as CrankerConfig;
  assert.deepEqual(withEarn.tuning.earn, { vault: EARN, queueBatch: 20, queueCallsPerTick: 5, skimIntervalS: 86_400 });
});

test('earn: skim once per interval when no queue is open, remembered in the store', async () => {
  const e = earnHarness({ head: 4n, tail: 3n, position: false });
  const first = await stepHouse(e.ctx);
  assert.deepEqual(e.sends.map((s) => s.fn), ['skim']);
  assert.equal(e.sends[0]!.gas, EARN_SKIM_GAS);
  assert.equal(e.sends[0]!.kind, EARN_SKIM_KIND);
  assert.equal((first.notes.earnQueue as { skim: string }).skim, 'confirmed');
  const again = await stepHouse(e.ctx);
  assert.equal(e.sends.length, 1, 'the next tick inside the interval sends nothing');
  assert.equal((again.notes.earnQueue as { skim: string }).skim, 'not-due');
  e.ctx.store.setMeta(earnSkimMetaKey(EARN), String(Math.floor(Date.now() / 1000) - 86_400));
  await stepHouse(e.ctx);
  assert.equal(e.sends.length, 2, 'a day later it skims again');
});

test('earn: a zero fee while the price stays above an unchanged mark is still owed, and is not done for the day', async () => {
  assert.equal(earnSkimFollowUp({ fee: 0n, priceBefore: 1_100_000n, markBefore: 1_000_000n, markAfter: 1_000_000n }), 'refused');
  assert.equal(earnSkimFollowUp({ fee: 0n, priceBefore: 1_000_000n, markBefore: 1_000_000n, markAfter: 1_000_000n }), 'nothing');
  assert.equal(earnSkimFollowUp({ fee: 0n, priceBefore: 1_100_000n, markBefore: 1_000_000n, markAfter: 1_100_000n }), 'mark-moved');
  assert.equal(earnSkimFollowUp({ fee: 100n, priceBefore: 1_100_000n, markBefore: 1_000_000n, markAfter: 1_090_000n }), 'collected');

  const e = earnHarness({ head: 4n, tail: 3n, position: false });
  e.v.assets = 1_100_000n; // price 1.1, mark 1.0, fee 0, mark does not move
  const interval = e.ctx.config.tuning.earn!.skimIntervalS;
  const t0 = Math.floor(Date.now() / 1000);
  const first = await stepHouse(e.ctx);
  const t1 = Math.floor(Date.now() / 1000);
  assert.deepEqual(e.sends.map((s) => s.fn), ['skim']);
  assert.equal((first.notes.earnQueue as { skim: string }).skim, 'fee-refused');
  assert.equal(e.raised.filter((a) => a.kind === 'v2_earn_skim_refused').length, 1);
  // The refusal is remembered as "last skim" one retry short of a full interval, not as now.
  const stored = Number(e.ctx.store.getMeta(earnSkimMetaKey(EARN)));
  assert.ok(stored >= t0 - interval + EARN_SKIM_REFUSED_RETRY_S && stored <= t1 - interval + EARN_SKIM_REFUSED_RETRY_S,
    `stored ${stored}: expected now - ${interval} + ${EARN_SKIM_REFUSED_RETRY_S}`);
  const again = await stepHouse(e.ctx);
  assert.equal(e.sends.length, 1, 'the next tick is inside the one-hour retry');
  assert.equal((again.notes.earnQueue as { skim: string }).skim, 'not-due');
  // The clock moved back by the stored amount stands in for waiting. A minute short of the retry it still waits; once
  // the retry has passed it skims, most of a day before a full interval would have ended.
  e.ctx.store.setMeta(earnSkimMetaKey(EARN), String(stored - EARN_SKIM_REFUSED_RETRY_S + 60));
  await stepHouse(e.ctx);
  assert.equal(e.sends.length, 1, 'a minute short of the retry it still waits');
  e.ctx.store.setMeta(earnSkimMetaKey(EARN), String(stored - EARN_SKIM_REFUSED_RETRY_S));
  await stepHouse(e.ctx);
  assert.equal(e.sends.length, 2, 'once the retry has elapsed it skims again');
  assert.ok(EARN_SKIM_REFUSED_RETRY_S < interval);
});

test('earn: a zero fee that moved the mark, or a fee that was taken, starts the full interval', async () => {
  const moved = earnHarness({ head: 4n, tail: 3n, position: false });
  moved.v.assets = 1_100_000n;
  moved.v.moveMark = true;
  const first = await stepHouse(moved.ctx);
  assert.equal((first.notes.earnQueue as { skim: string }).skim, 'confirmed');
  assert.equal(moved.raised.filter((a) => a.kind === 'v2_earn_skim_refused').length, 0);
  await stepHouse(moved.ctx);
  assert.equal(moved.sends.length, 1, 'the mark moved: nothing is still owed, so the full interval applies');

  const paid = earnHarness({ head: 4n, tail: 3n, position: false });
  paid.v.assets = 1_100_000n;
  paid.v.fee = 100n;
  const took = await stepHouse(paid.ctx);
  assert.equal((took.notes.earnQueue as { skim: string }).skim, 'confirmed');
  assert.equal(paid.raised.filter((a) => a.kind === 'v2_earn_skim_refused').length, 0);
});

test('earn: a zero fee whose mark could not be read, before or after, is not done for the day: it is retried after the refusal retry, and nothing pages', async () => {
  for (const failed of [1, 2]) {
    const e = earnHarness({ head: 4n, tail: 3n, position: false });
    e.v.failMarkRead = failed; // 1: the read before the skim; 2: the read after it. Price and mark are flat (nothing owed).
    const interval = e.ctx.config.tuning.earn!.skimIntervalS;
    const t0 = Math.floor(Date.now() / 1000);
    const first = await stepHouse(e.ctx);
    const t1 = Math.floor(Date.now() / 1000);
    assert.deepEqual(e.sends.map((s) => s.fn), ['skim']);
    assert.equal((first.notes.earnQueue as { skim: string }).skim, 'fee-unverified', `read ${failed} failed: the outcome says unverified, not confirmed`);
    assert.equal(e.raised.filter((a) => a.kind === 'v2_earn_skim_refused').length, 0, 'nothing is known to be refused, so nothing pages');
    const stored = Number(e.ctx.store.getMeta(earnSkimMetaKey(EARN)));
    assert.ok(stored >= t0 - interval + EARN_SKIM_REFUSED_RETRY_S && stored <= t1 - interval + EARN_SKIM_REFUSED_RETRY_S,
      `read ${failed} failed: stored ${stored}, expected now - ${interval} + ${EARN_SKIM_REFUSED_RETRY_S} (the refusal retry), not now (a full interval)`);
  }
  // Control: the same flat vault with both reads answering is "nothing owed" and waits the full interval.
  const ok = earnHarness({ head: 4n, tail: 3n, position: false });
  const t0 = Math.floor(Date.now() / 1000);
  const c = await stepHouse(ok.ctx);
  assert.equal((c.notes.earnQueue as { skim: string }).skim, 'confirmed');
  assert.ok(Number(ok.ctx.store.getMeta(earnSkimMetaKey(EARN))) >= t0, 'a verified zero fee starts the full interval');
});

/*//////////////////////////////////////////////////////////////
   AN UNROLLED VAULT IS RETRIED EVERY TICK AND PAGED
//////////////////////////////////////////////////////////////*/
import { CrankerMetrics } from './metrics.js';

test('a due vault whose rollEpoch does not land is retried on the next tick, and past the overdue window it pages each time', async () => {
  const h = rollHarness('simulation-reverted');
  const reads = rollReads({ vaults: [HOUSE_A] });
  const late = EPOCH_END + HOUSE_ROLL_OVERDUE_S + 60;
  const first = await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(late), reads);
  assert.equal(first[0]!.decision, 'sent');
  assert.match(first[0]!.detail ?? '', /^simulation-reverted/);
  assert.deepEqual(h.raised.map((a) => [a.kind, a.dedupeKey]), [['v2_house_roll_overdue', HOUSE_A.toLowerCase()]], 'the roll did not land and the boundary is past the window: page');
  assert.match(h.raised[0]!.message, /has not rolled: sent \(simulation-reverted/);
  // Next tick, from fresh chain state: the vault is still due, so the roll is sent again and the page repeats.
  const second = await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(late + 30), reads);
  assert.equal(second[0]!.decision, 'sent');
  assert.equal(h.sends.length, 2, 'retried on the next tick');
  assert.equal(h.raised.length, 2);
  assert.equal(h.cleared.length, 0, 'nothing rolled, so nothing clears the page');
});

test('inside the settlement window a roll that does not land is retried but not paged; a confirmed roll clears the page', async () => {
  const reverting = rollHarness('simulation-reverted');
  await houseRoll(reverting.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + 300), rollReads({ vaults: [HOUSE_A] }));
  assert.equal(reverting.sends.length, 1);
  assert.equal(reverting.raised.length, 0, 'inside HOUSE_ROLL_OVERDUE_S the wait is the settlement chain working');
  const landing = rollHarness('confirmed');
  await houseRoll(landing.ctx, newReport('house'), new Budget(10), headAt(EPOCH_END + HOUSE_ROLL_OVERDUE_S + 60), rollReads({ vaults: [HOUSE_A] }));
  assert.equal(landing.raised.length, 0);
  assert.deepEqual(landing.cleared, [{ kind: 'v2_house_roll_overdue', dedupeKey: HOUSE_A.toLowerCase() }]);
});

test('a due vault deferred for budget past the overdue window is paged too', async () => {
  const h = rollHarness();
  const notes = await houseRoll(h.ctx, newReport('house'), new Budget(1), headAt(EPOCH_END + HOUSE_ROLL_OVERDUE_S + 60), rollReads());
  assert.deepEqual(notes.map((n) => n.decision), ['sent', 'no-budget']);
  assert.deepEqual(h.raised.map((a) => a.dedupeKey), [HOUSE_B.toLowerCase()], 'only the vault that did not roll');
  assert.match(h.raised[0]!.message, /has not rolled: no-budget/);
});

test('/state carries each House vault\'s epochEnd, when it rolls next and its roll status', async () => {
  const h = rollHarness();
  stepClient(h, EPOCH_END - 600);
  const report = await stepHouse(h.ctx, rollReads());
  const metrics = new CrankerMetrics();
  metrics.recordStep(report, Date.now(), 1, EPOCH_END - 600);
  // What GET /state serves for the step (cranker.ts stateBody -> metrics.steps).
  const state = JSON.parse(JSON.stringify(metrics.steps.house.lastNotes)) as { houseRoll: Array<Record<string, unknown>> };
  assert.deepEqual(
    state.houseRoll.map((n) => ({ vault: n.vault, epochEnd: n.epochEnd, epochEndIso: n.epochEndIso, decision: n.decision })),
    [HOUSE_A, HOUSE_B].map((vault) => ({ vault, epochEnd: EPOCH_END, epochEndIso: new Date(EPOCH_END * 1000).toISOString(), decision: 'not-due' })),
  );
});

/*
 * THE INDEX STEP'S FAILURE NAMES THE NODE. Production logged 'cranker step index failed: HTTP request failed'
 * for weeks: viem's shortMessage for any non-2xx answer, with no host, no status and no body. robinhood-rpc.publicnode.com
 * answers eth_getLogs for any range starting more than ~128 blocks back with HTTP 403 "Archive requests require a
 * personal token" (measured 2026-09-23), and the index scan always starts REORG_OVERLAP (100) blocks below its cursor,
 * so a log path on such a node fails every tick. Pinned: the host (never the keyed URL), the status and the node's words
 * are in the error; a deterministic 4xx fails at once; a transient failure (429, 5xx, no status) is retried with the
 * INDEX_BACKOFF_MS waits, and succeeds or fails named after INDEX_ATTEMPTS.
 */
import { HttpRequestError } from 'viem';
import { INDEX_ATTEMPTS, INDEX_BACKOFF_MS, IndexStepError, rpcFailureOf, rpcHost, stepIndex } from './steps.js';

const KEYED = 'https://robinhood-mainnet.g.alchemy.com/v2/SECRETKEY0123456789abcdef';
const PUBLICNODE = 'https://robinhood-rpc.publicnode.com';

const archive403 = () =>
  new HttpRequestError({
    url: PUBLICNODE,
    status: 403,
    details: JSON.stringify({ code: -32602, message: 'Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode' }),
  });
const status = (s: number, url = KEYED) => new HttpRequestError({ url, status: s, details: 'upstream said no' });

function indexHarness(options: { getLogs?: () => Promise<unknown[]>; getBlock?: () => Promise<{ number: bigint; timestamp: bigint }> } = {}) {
  const config = loadV2Config({
    V2_MODE: 'cranker',
    RH_RPC: KEYED,
    CRANKER_PK: `0x${'3c'.repeat(32)}`,
    CRANKER_PORT: '0',
    KEEPER_DB_PATH: ':memory:',
    POLL_INTERVAL_MS: '1000',
    V2_REGISTRY_PATH: REGISTRY,
    V2_CLEARINGHOUSE: CH,
    V2_CONTRACTS_FROM_ENV: '1',
  }) as CrankerConfig;
  const store = new V2Store(':memory:');
  const index = new CrankerIndex(store);
  index.bind({ chainId: config.chainId, clearinghouse: CH, orderBook: config.contracts.orderBook, autoRoller: null });
  const sleeps: number[] = [];
  let getLogsCalls = 0;
  const ctx: CrankContext = {
    config,
    log: silentLogger(),
    // Above the fixture registry's deployBlock (65_100_000), so the scan has a range to read.
    client: { getBlock: options.getBlock ?? (async () => ({ number: 65_200_000n, timestamp: BigInt(T0) })) } as never,
    logClient: {
      getBlockNumber: async () => 65_200_000n,
      getLogs: async () => {
        getLogsCalls += 1;
        return (options.getLogs ?? (async () => []))();
      },
    } as never,
    addresses: { clearinghouse: CH, orderBook: config.contracts.orderBook, settlementOracle: DEFAULT_ORACLE, expiryCalendar: config.contracts.expiryCalendar, autoRoller: null, feeSplitter: null, multicall3: config.multicall3 },
    store,
    index,
    sender: {} as never,
    alerts: {} as never,
    indexer: null,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { ctx, sleeps, getLogsCalls: () => getLogsCalls };
}

async function indexError(ctx: CrankContext): Promise<IndexStepError> {
  try {
    await stepIndex(ctx);
  } catch (error) {
    assert.ok(error instanceof IndexStepError, `not an IndexStepError: ${String(error)}`);
    return error;
  }
  assert.fail('stepIndex did not throw');
}

test('an archive refusal (HTTP 403) fails at once, naming the host, the status and the node\'s words', async () => {
  const h = indexHarness({ getLogs: async () => Promise.reject(archive403()) });
  const e = await indexError(h.ctx);
  assert.equal(e.phase, 'scan');
  assert.equal(e.host, 'robinhood-rpc.publicnode.com');
  assert.equal(e.status, 403);
  assert.equal(e.attempts, 1);
  assert.match(e.message, /^eth_getLogs failed at robinhood-rpc\.publicnode\.com \(HTTP 403\) after 1 attempt: HTTP request failed\..*Archive requests require a personal token/);
  // The node's own link is reduced to its origin like every other URL.
  assert.ok(!e.message.includes('/publicnode"'), e.message);
  assert.deepEqual(h.sleeps, [], 'a deterministic refusal must not wait');
  assert.ok(h.getLogsCalls() > 1, 'scanLogs still halves its chunk inside the attempt');
});

test('the keyed RPC URL never appears, only its host', async () => {
  const h = indexHarness({ getLogs: async () => Promise.reject(status(404)) });
  const e = await indexError(h.ctx);
  assert.equal(e.host, 'robinhood-mainnet.g.alchemy.com');
  for (const text of [e.message, e.host, e.detail]) {
    assert.ok(!text.includes('SECRETKEY'), text);
    assert.ok(!text.includes('/v2/'), text);
  }
});

test('a transient failure (429, then 503) is retried with the backoff and the step then succeeds', async () => {
  let n = 0;
  const h = indexHarness({
    getLogs: async () => {
      n += 1;
      // Fail every call of the first two attempts; scanLogs halves 50_000 down to 100 blocks (10 calls) before it gives up.
      if (n <= 20) throw n <= 10 ? status(429) : status(503);
      return [];
    },
  });
  const report = await stepIndex(h.ctx);
  assert.equal(report.step, 'index');
  assert.deepEqual(h.sleeps, [INDEX_BACKOFF_MS[0], INDEX_BACKOFF_MS[1]]);
});

test('a transient failure that never clears ends named after INDEX_ATTEMPTS', async () => {
  const h = indexHarness({ getLogs: async () => Promise.reject(status(502)) });
  const e = await indexError(h.ctx);
  assert.equal(e.attempts, INDEX_ATTEMPTS);
  assert.equal(e.status, 502);
  assert.match(e.message, new RegExp(`after ${INDEX_ATTEMPTS} attempts`));
  assert.equal(h.sleeps.length, INDEX_ATTEMPTS - 1);
});

test('a head read that fails is named "head read" with the host of the node that answered', async () => {
  const h = indexHarness({ getBlock: async () => Promise.reject(status(500, PUBLICNODE)) });
  const e = await indexError(h.ctx);
  assert.equal(e.phase, 'head');
  assert.match(e.message, /^head read failed at robinhood-rpc\.publicnode\.com \(HTTP 500\) after 3 attempts/);
  assert.equal(h.getLogsCalls(), 0);
});

test('an error without a URL on the pinned log client is named after RH_RPC\'s host; a non-RPC error is not retried', async () => {
  const h = indexHarness({ getLogs: async () => Promise.reject(new Error('SQLITE_BUSY: database is locked')) });
  const e = await indexError(h.ctx);
  assert.equal(e.host, 'robinhood-mainnet.g.alchemy.com');
  assert.equal(e.status, null);
  assert.equal(e.attempts, 1);
  assert.deepEqual(h.sleeps, []);
});

test('rpcHost and rpcFailureOf', () => {
  assert.equal(rpcHost(KEYED), 'robinhood-mainnet.g.alchemy.com');
  assert.equal(rpcHost('http://127.0.0.1:8545/'), '127.0.0.1:8545');
  assert.equal(rpcHost('not a url'), null);
  assert.equal(rpcHost(undefined), null);
  const f = rpcFailureOf(status(429));
  assert.deepEqual([f.host, f.status, f.transient], ['robinhood-mainnet.g.alchemy.com', 429, true]);
  assert.equal(rpcFailureOf(archive403()).transient, false);
  assert.equal(rpcFailureOf(new HttpRequestError({ url: KEYED })).transient, true, 'no status: a network failure, transient');
});

/*
 * THE ROLL COVERS EVERY HOUSE VAULT THE REGISTRY RECORDS, AND ITS FINALIZED GATE IS THE BOUNDARY'S.
 * (1) An env override (CRANKER_HOUSE_FACTORY / MM_HOUSE_FACTORY) wins over the registry's factories and skips the boot
 * check, so ops/v2/env/cranker.env pinning the weekly factory left every registry daily vault unread, unrolled and
 * unpaged. houseRoll now rolls the union of the factories' vaults() and registry.house.vaults, and names a vault only
 * the registry listed. (2) rollEpoch reverts unless settlementPrice(underlying, epochEnd) is Finalized AND its price
 * is not 0 (HouseVault.sol), asked of the vault's own oracle; every fake readFinalized here used to ignore its
 * arguments, so asking about the head's timestamp passed every test.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SETTLEMENT_STATUS } from './constants.js';

const DAILY_FACTORY = getAddress('0x00000000000000000000000000000000000fad01');
const WEEKLY_FACTORY = getAddress('0x00000000000000000000000000000000000fad02');
const NVDA_DAILY = getAddress('0x00000000000000000000000000000000000da001');
const TSLA_DAILY = getAddress('0x00000000000000000000000000000000000da002');
/** A vault the factory lists and the registry does not. */
const FACTORY_ONLY = getAddress('0x00000000000000000000000000000000000da003');
const WEEKLY_VAULT = getAddress('0x00000000000000000000000000000000000da004');
const PRICE = 227_000_000n;

/**
 * A copy of the fixture registry in os.tmpdir() (never a checked-in file) whose NVDA and TSLA markets record a daily
 * House vault and whose v2.house.factories is `factories`. The fixture has no SPCX row; NVDA and TSLA stand in for the
 * launch pair. The fixture itself records no House vault and no House factory.
 */
function dailyRegistry(factories: Array<{ kind: 'weekly' | 'daily'; address: Address }>): { path: string; cleanup: () => void } {
  const data = JSON.parse(readFileSync(REGISTRY, 'utf8')) as { v2: Record<string, unknown>; markets: Array<{ ticker: string; v2?: Record<string, unknown> }> };
  data.v2.house = { factories };
  for (const m of data.markets) {
    if (m.ticker === 'NVDA') m.v2!.house = { daily: NVDA_DAILY };
    if (m.ticker === 'TSLA') m.v2!.house = { daily: TSLA_DAILY };
  }
  const dir = mkdtempSync(join(tmpdir(), 't-op-351-'));
  const path = join(dir, 'registry-v2.json');
  writeFileSync(path, JSON.stringify(data));
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The cranker config the real loader builds from `registryPath`, with only the variables a cranker must have plus `extra`. */
function loadCranker(registryPath: string, extra: Record<string, string> = {}): CrankerConfig {
  return loadV2Config({ V2_MODE: 'cranker', RH_RPC: 'http://127.0.0.1:9', CRANKER_PK: `0x${'11'.repeat(32)}`, V2_REGISTRY_PATH: registryPath, ...extra }) as CrankerConfig;
}

interface ChainVault {
  epochEnd: number;
  epochId: bigint;
  underlying: Address;
  oracle: Address;
}

/**
 * A chain the DEFAULT reads (chainHouseRollReads) run against: a head, each factory's vaults(), each vault's roll
 * getters (no tracked series, so flat), and each oracle's settlementPrice, Finalized with a price only for the
 * `<oracle>:<underlying>:<expiry>` keys in `finalized`. Every settlementPrice question is recorded in `asked`.
 */
const PIN_SOURCE_A = '0x00000000000000000000000000000000000000a1' as Address;
const PIN_SOURCE_B = '0x00000000000000000000000000000000000000a2' as Address;

function houseChain(h: RollHarness, timestamp: number, factories: Record<string, readonly Address[]>, vaults: Record<string, ChainVault>) {
  const finalized = new Set<string>();
  const asked: string[] = [];
  for (const [vault, v] of Object.entries(vaults)) h.epochIdOf.set(vault.toLowerCase(), v.epochId);
  h.ctx.client = {
    getBlock: async () => ({ number: 65_000_100n, timestamp: BigInt(timestamp) }),
    readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      const a = address.toLowerCase();
      if (functionName === 'vaults') return factories[a] ?? assert.fail(`vaults() read on ${address}, which is not a factory here`);
      if (functionName === 'settlementPrice') {
        const k = `${a}:${String(args![0]).toLowerCase()}:${Number(args![1])}`;
        asked.push(k);
        return finalized.has(k) ? [SETTLEMENT_STATUS.indexOf('Finalized'), PRICE] : [SETTLEMENT_STATUS.indexOf('Pending'), 0n];
      }
      // The roll's pin allowance reads the market's sources from the oracle. Without this the
      // read fell to the assert.fail below, which readPinSources' catch swallowed (null = unread, the 900k worst case).
      if (functionName === 'marketConfig') return [[PIN_SOURCE_A, PIN_SOURCE_B], 0, 0, 0];
      const v = Object.entries(vaults).find(([k]) => k.toLowerCase() === a)?.[1];
      if (v === undefined) return assert.fail(`${functionName} read on ${address}, which is not a vault here`);
      if (functionName === 'epochEnd') return v.epochEnd;
      if (functionName === 'epochId') return h.epochIdOf.get(a) ?? v.epochId;
      if (functionName === 'underlying') return v.underlying;
      if (functionName === 'oracle') return v.oracle;
      if (functionName === 'trackedSeries') return [];
      return assert.fail(`no chain read ${functionName}`);
    },
  } as never;
  const finalize = (v: ChainVault) => void finalized.add(`${v.oracle.toLowerCase()}:${v.underlying.toLowerCase()}:${v.epochEnd}`);
  return { asked, finalize };
}

const underlyingOf = (config: CrankerConfig, ticker: string) => config.registry.markets.find((m) => m.ticker === ticker)!.underlying;

test('a daily-only registry through the real loader, no factory variable -> each registry vault and the factory-only vault is rolled exactly once', async () => {
  const reg = dailyRegistry([{ kind: 'daily', address: DAILY_FACTORY }]);
  try {
    const h = rollHarness();
    h.ctx.config = loadCranker(reg.path);
    // Preconditions: the list is the registry's own, and the registry records both daily vaults.
    assert.deepEqual(h.ctx.config.tuning.houseFactories, [{ address: DAILY_FACTORY, kind: 'kinded' }]);
    assert.deepEqual(h.ctx.config.registry.house.vaults.map((v) => [v.ticker, v.kind, v.address]), [['NVDA', 'daily', NVDA_DAILY], ['TSLA', 'daily', TSLA_DAILY]]);
    const nvda = underlyingOf(h.ctx.config, 'NVDA');
    const tsla = underlyingOf(h.ctx.config, 'TSLA');
    const vaults: Record<string, ChainVault> = {
      [NVDA_DAILY]: { epochEnd: EPOCH_END, epochId: 21n, underlying: nvda, oracle: HOUSE_ORACLE },
      [TSLA_DAILY]: { epochEnd: EPOCH_END, epochId: 22n, underlying: tsla, oracle: HOUSE_ORACLE },
      [FACTORY_ONLY]: { epochEnd: EPOCH_END, epochId: 23n, underlying: nvda, oracle: HOUSE_ORACLE },
    };
    // The registry's two vaults FIRST, the factory-only one LAST: a roll of only the first vault per factory cannot be
    // rescued by the registry half, because the registry does not know the last one.
    const chain = houseChain(h, EPOCH_END + 300, { [DAILY_FACTORY.toLowerCase()]: [NVDA_DAILY, TSLA_DAILY, FACTORY_ONLY] }, vaults);
    for (const v of Object.values(vaults)) chain.finalize(v);
    const report = await stepHouse(h.ctx);
    assert.deepEqual(
      h.sends.map((s) => [s.vault, s.fn, s.key]),
      [[NVDA_DAILY, 'rollEpoch', `${NVDA_DAILY.toLowerCase()}:21`], [TSLA_DAILY, 'rollEpoch', `${TSLA_DAILY.toLowerCase()}:22`], [FACTORY_ONLY, 'rollEpoch', `${FACTORY_ONLY.toLowerCase()}:23`]],
    );
    const notes = report.notes.houseRoll as Array<{ vault: Address; factory: Address | null; source: string; decision: string }>;
    assert.deepEqual(notes.map((n) => [n.vault, n.factory, n.source, n.decision]), [
      [NVDA_DAILY, DAILY_FACTORY, 'factory', 'sent'],
      [TSLA_DAILY, DAILY_FACTORY, 'factory', 'sent'],
      [FACTORY_ONLY, DAILY_FACTORY, 'factory', 'sent'],
    ]);
    assert.equal('houseRollUnlisted' in report.notes, false, 'the factory listed every registry vault: no drift to name');
  } finally {
    reg.cleanup();
  }
});

test('a registry daily vault the configured factory does not list is paged past the window, rolled once Finalized, and named on /state', async () => {
  const reg = dailyRegistry([{ kind: 'daily', address: DAILY_FACTORY }]);
  try {
    const h = rollHarness();
    // The weekly-only pin of ops/v2/env/cranker.env: the variable names another factory and wins over the registry's.
    h.ctx.config = loadCranker(reg.path, { CRANKER_HOUSE_FACTORY: `${WEEKLY_FACTORY}:legacy-weekly` });
    assert.deepEqual(h.ctx.config.tuning.houseFactories, [{ address: WEEKLY_FACTORY, kind: 'legacy-weekly' }]);
    const nvda = underlyingOf(h.ctx.config, 'NVDA');
    const late = EPOCH_END + HOUSE_ROLL_OVERDUE_S + 60;
    const vaults: Record<string, ChainVault> = {
      [WEEKLY_VAULT]: { epochEnd: late + 86_400, epochId: 5n, underlying: nvda, oracle: HOUSE_ORACLE },
      [NVDA_DAILY]: { epochEnd: EPOCH_END, epochId: 31n, underlying: nvda, oracle: HOUSE_ORACLE },
      [TSLA_DAILY]: { epochEnd: late + 3_600, epochId: 32n, underlying: underlyingOf(h.ctx.config, 'TSLA'), oracle: HOUSE_ORACLE },
    };
    const chain = houseChain(h, late, { [WEEKLY_FACTORY.toLowerCase()]: [WEEKLY_VAULT] }, vaults);

    // Tick 1: NVDA's daily boundary is past the overdue window and its price is not Finalized yet.
    const blocked = await stepHouse(h.ctx);
    assert.equal(h.sends.length, 0);
    const notesOf = (r: typeof blocked) => (r.notes.houseRoll as Array<{ vault: Address; factory: Address | null; source: string; decision: string }>).map((n) => [n.vault, n.factory, n.source, n.decision]);
    assert.deepEqual(notesOf(blocked), [
      [WEEKLY_VAULT, WEEKLY_FACTORY, 'factory', 'not-due'],
      [NVDA_DAILY, null, 'registry', 'not-finalized'],
      [TSLA_DAILY, null, 'registry', 'not-due'],
    ]);
    assert.deepEqual(h.raised.map((a) => [a.kind, a.dedupeKey]), [['v2_house_roll_overdue', NVDA_DAILY.toLowerCase()]]);
    assert.deepEqual(blocked.notes.houseRollUnlisted, [NVDA_DAILY, TSLA_DAILY]);
    // What GET /state serves for the step (cranker.ts stateBody -> metrics.steps): the drift is visible there.
    const metrics = new CrankerMetrics();
    metrics.recordStep(blocked, Date.now(), 1, late);
    const state = JSON.parse(JSON.stringify(metrics.steps.house.lastNotes)) as { houseRollUnlisted: string[]; houseRoll: Array<{ vault: string; source: string; factory: string | null }> };
    assert.deepEqual(state.houseRollUnlisted, [NVDA_DAILY, TSLA_DAILY]);
    assert.deepEqual(state.houseRoll.filter((n) => n.source === 'registry').map((n) => [n.vault, n.factory]), [[NVDA_DAILY, null], [TSLA_DAILY, null]]);

    // Tick 2: the price finalizes; the same vault is rolled from the registry list and its page is cleared.
    chain.finalize(vaults[NVDA_DAILY]!);
    const rolled = await stepHouse(h.ctx);
    assert.deepEqual(h.sends.map((s) => [s.vault, s.fn, s.key]), [[NVDA_DAILY, 'rollEpoch', `${NVDA_DAILY.toLowerCase()}:31`]]);
    assert.deepEqual(notesOf(rolled)[1], [NVDA_DAILY, null, 'registry', 'sent']);
    assert.ok(h.cleared.some((c) => c.kind === 'v2_house_roll_overdue' && c.dedupeKey === NVDA_DAILY.toLowerCase()));
    assert.ok(chain.asked.every((k) => k.startsWith(HOUSE_ORACLE.toLowerCase())), 'each asked the vault\'s own oracle');
  } finally {
    reg.cleanup();
  }
});

test('with no factory at all, a House vault the registry records still makes the step read and roll', async () => {
  const reg = dailyRegistry([{ kind: 'daily', address: DAILY_FACTORY }]);
  try {
    const h = rollHarness();
    const loaded = loadCranker(reg.path);
    h.ctx.config = { ...loaded, tuning: { ...loaded.tuning, houseFactories: [] } };
    const nvda = underlyingOf(h.ctx.config, 'NVDA');
    const vaults: Record<string, ChainVault> = {
      [NVDA_DAILY]: { epochEnd: EPOCH_END, epochId: 41n, underlying: nvda, oracle: HOUSE_ORACLE },
      [TSLA_DAILY]: { epochEnd: EPOCH_END + 86_400, epochId: 42n, underlying: underlyingOf(h.ctx.config, 'TSLA'), oracle: HOUSE_ORACLE },
    };
    const chain = houseChain(h, EPOCH_END + 300, {}, vaults);
    chain.finalize(vaults[NVDA_DAILY]!);
    const report = await stepHouse(h.ctx);
    assert.deepEqual(report.notes.factories, []);
    assert.deepEqual(h.sends.map((s) => s.vault), [NVDA_DAILY]);
    assert.deepEqual(report.notes.houseRollUnlisted, [NVDA_DAILY, TSLA_DAILY]);
  } finally {
    reg.cleanup();
  }
});

test('the Finalized gate asks each vault\'s OWN oracle, underlying and epochEnd; Finalized only at another timestamp is not-finalized and not sent', async () => {
  const h = rollHarness();
  const HOUSE_C = getAddress('0x00000000000000000000000000000000000000a3');
  const ORACLE_2 = getAddress('0x00000000000000000000000000000000000000c4');
  const ORACLE_3 = getAddress('0x00000000000000000000000000000000000000c5');
  const TSLA_TOKEN = getAddress('0x00000000000000000000000000000000000000d5');
  const AAPL_TOKEN = getAddress('0x00000000000000000000000000000000000000d6');
  const DAY = 86_400;
  const now = EPOCH_END + DAY + 300;
  const views: Record<string, HouseVaultRollView> = {
    [HOUSE_A]: { epochEnd: EPOCH_END, epochId: 7n, underlying: NVDA_TOKEN, oracle: HOUSE_ORACLE, tracked: [] },
    [HOUSE_B]: { epochEnd: EPOCH_END + DAY, epochId: 3n, underlying: TSLA_TOKEN, oracle: ORACLE_2, tracked: [] },
    // Its oracle has Finalized the head's timestamp and the day before its boundary, never the boundary itself.
    [HOUSE_C]: { epochEnd: EPOCH_END, epochId: 9n, underlying: AAPL_TOKEN, oracle: ORACLE_3, tracked: [] },
  };
  const finalizedAt = new Set([
    `${HOUSE_ORACLE}:${NVDA_TOKEN}:${EPOCH_END}`,
    `${ORACLE_2}:${TSLA_TOKEN}:${EPOCH_END + DAY}`,
    `${ORACLE_3}:${AAPL_TOKEN}:${now}`,
    `${ORACLE_3}:${AAPL_TOKEN}:${EPOCH_END - DAY}`,
  ]);
  const asked: Array<[Address, Address, number]> = [];
  const notes = await houseRoll(h.ctx, newReport('house'), new Budget(10), headAt(now), rollReads({
    vaults: [HOUSE_A, HOUSE_B, HOUSE_C],
    readVault: async (vault) => views[vault]!,
    readFinalized: async (oracle, underlying, epochEnd) => {
      asked.push([oracle, underlying, epochEnd]);
      return finalizedAt.has(`${oracle}:${underlying}:${epochEnd}`);
    },
  }));
  assert.deepEqual(asked, [[HOUSE_ORACLE, NVDA_TOKEN, EPOCH_END], [ORACLE_2, TSLA_TOKEN, EPOCH_END + DAY], [ORACLE_3, AAPL_TOKEN, EPOCH_END]]);
  assert.deepEqual(notes.map((n) => [n.vault, n.decision]), [[HOUSE_A, 'sent'], [HOUSE_B, 'sent'], [HOUSE_C, 'not-finalized']]);
  assert.deepEqual(h.sends.map((s) => s.vault), [HOUSE_A, HOUSE_B], 'a price Finalized for another timestamp does not roll the boundary');
});

test('chainHouseRollReads.readFinalized asks settlementPrice(underlying, epochEnd) of the given oracle at the tick\'s block, and is true only for Finalized with a price', async () => {
  const calls: Array<{ address: Address; functionName: string; args: readonly unknown[]; blockNumber: bigint }> = [];
  let answer: readonly [number, bigint] = [0, 0n];
  // A context carrying only a client: the registry list is read lazily, so building the reads must not touch config.
  const reads = chainHouseRollReads({ client: { readContract: async (a: (typeof calls)[number]) => (calls.push(a), answer) } } as never, []);
  const status = (s: (typeof SETTLEMENT_STATUS)[number]) => SETTLEMENT_STATUS.indexOf(s);
  const cases: Array<[string, readonly [number, bigint], boolean]> = [
    ['Finalized with a price', [status('Finalized'), PRICE], true],
    ['None', [status('None'), 0n], false],
    ['Pending with a captured price', [status('Pending'), PRICE], false],
    ['Held with a price', [status('Held'), PRICE], false],
    ['Finalized at price 0 (rollEpoch reverts NotSettled on it)', [status('Finalized'), 0n], false],
  ];
  for (const [name, a, want] of cases) {
    answer = a;
    assert.equal(await reads.readFinalized(HOUSE_ORACLE, NVDA_TOKEN, EPOCH_END, 65_000_100n), want, name);
  }
  assert.equal(calls.length, cases.length);
  for (const c of calls) {
    assert.deepEqual({ address: c.address, functionName: c.functionName, args: c.args, blockNumber: c.blockNumber }, { address: HOUSE_ORACLE, functionName: 'settlementPrice', args: [NVDA_TOKEN, EPOCH_END], blockNumber: 65_000_100n });
  }
});

test('chainHouseRollReads.readPinSources asks marketConfig(underlying) of the given oracle at the tick\'s block and returns its source count; a failed read is null', async () => {
  const calls: Array<{ address: Address; functionName: string; args: readonly unknown[]; blockNumber: bigint }> = [];
  let answer: (() => unknown) = () => [[PIN_SOURCE_A, PIN_SOURCE_B], 0, 0, 0];
  const reads = chainHouseRollReads({ client: { readContract: async (a: (typeof calls)[number]) => (calls.push(a), answer()) } } as never, []);
  // The success path: the budget is sized from this count, so a count of 0 would undercut a real two-source pin.
  assert.equal(await reads.readPinSources(HOUSE_ORACLE, NVDA_TOKEN, 65_000_100n), 2, 'two sources configured -> 2');
  answer = () => [[PIN_SOURCE_A], 0, 0, 0];
  assert.equal(await reads.readPinSources(HOUSE_ORACLE, NVDA_TOKEN, 65_000_100n), 1, 'one source configured -> 1');
  answer = () => {
    throw new Error('execution reverted');
  };
  assert.equal(await reads.readPinSources(HOUSE_ORACLE, NVDA_TOKEN, 65_000_100n), null, 'an unreadable config is null (unread), never 0');
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.deepEqual({ address: c.address, functionName: c.functionName, args: c.args, blockNumber: c.blockNumber }, { address: HOUSE_ORACLE, functionName: 'marketConfig', args: [NVDA_TOKEN], blockNumber: 65_000_100n });
  }
});

/*
 * The pool leg of a launch expiry
 * exists only if a snapshot records it inside [E, E + 600]. UniV3TwapSource.record answers false and stores nothing when
 * it cannot price the window at that moment, and a retry inside the grace may succeed. The snapshot step read that
 * simulated 0 as "nothing left to record" and marked the expiry, which stopped every retry and silenced
 * v2_snapshot_missed in exactly the case it exists for. Pinned here, through the real snapshot and finalize steps on a
 * fake chain: a snapshot that records nothing while the pool is still dark leaves the expiry unmarked and asks again at
 * a precise wake-up inside the grace; a pool that never records pages v2_snapshot_missed once the grace closes; and the
 * opposite half, which a fix that simply dropped the no-op mark would break, marks as before when no pool is dark (every
 * source prices the window, or the only dark source is a Chainlink feed, whose `record` is always false).
 */
import { SNAPSHOT_GRACE } from './constants.js';
import { SNAPSHOT_RETRY_S, snapshotMetaKey, stepFinalize, stepSnapshot } from './steps.js';

const SNAP_CHAINLINK = getAddress('0x00000000000000000000000000000000000000c1');
const SNAP_POOL = getAddress('0x00000000000000000000000000000000000000b1');

function snapshotHarness() {
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
  const underlying = getAddress(config.registry.markets.find((m) => m.ticker === 'NVDA')!.underlying);
  const key = { oracle: ORACLE_A, underlying, expiry: E };
  const state = {
    now: E + 200,
    block: 65_000_000n,
    /** Sources whose windowPrice is ok. Chainlink prices the window from its replayable history. */
    priced: new Set<string>([SNAP_CHAINLINK.toLowerCase()]),
    /** Whether the pool can price the window when a snapshot calls its `record` now. */
    poolCanRecord: false,
    /** Whether a broadcast fails (a primary that reads but will not send). */
    sendFails: false,
    sends: [] as Array<{ fn: string; status: string }>,
    /** Whether the snapshots() probe throws as a whole (an RPC that does not answer). */
    probeThrows: false,
  };
  const poolStored = () => state.priced.has(SNAP_POOL.toLowerCase());
  type Outcome = { status: 'success'; result: unknown } | { status: 'failure'; error: Error };
  const views: Record<string, (args: readonly unknown[], address: Address) => Outcome> = {
    openInterest: () => ({ status: 'success', result: 100n }),
    settlementPrice: () => ({ status: 'success', result: [0, 0n] }),
    candidate: () => ({ status: 'success', result: [0n, 0, false, 0] }),
    settlementInfo: () => ({ status: 'success', result: [0, 0n, 0, true, false, false] }),
    recordedSources: () => ({ status: 'success', result: [[], [], [], 0] }),
    settlementConfig: () => ({ status: 'success', result: [true, [SNAP_CHAINLINK, SNAP_POOL], 150, 21_600, 90_000] }),
    windowPrice: (_, address) => ({ status: 'success', result: state.priced.has(address.toLowerCase()) ? [true, 10n ** 8n] : [false, 0n] }),
    // UniV3TwapSource only. ChainlinkFeedSource has no such view: the call reverts, a failed outcome in the batch.
    snapshots: (_, address) =>
      address.toLowerCase() === SNAP_POOL.toLowerCase()
        ? { status: 'success', result: [poolStored() ? 10n ** 8n : 0n, 0, poolStored() ? state.now : 0] }
        : { status: 'failure', error: new Error('snapshots() reverted') },
  };
  const client = {
    getBlock: async () => ({ number: state.block, timestamp: BigInt(state.now) }),
    getBlockNumber: async () => state.block,
    multicall: async ({ contracts }: { contracts: Array<{ functionName: string; args?: readonly unknown[]; address: Address }> }) => {
      if (state.probeThrows && contracts.some((c) => c.functionName === 'snapshots')) throw new Error('HTTP request failed.');
      return contracts.map((c) => views[c.functionName]?.(c.args ?? [], c.address) ?? { status: 'failure', error: new Error(`no view ${c.functionName}`) });
    },
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'settlementPrice') return [0, 0n];
      throw new Error(`no readContract ${functionName}`);
    },
  };
  const sender: CrankSender = {
    dryRun: false,
    account: '0x000000000000000000000000000000000000beef',
    async execute(call: FixedGasCall, opts) {
      if (opts.isAdvanced !== undefined && (await opts.isAdvanced())) return { status: 'already-advanced' };
      // SettlementOracle.snapshot returns how many sources recorded: Chainlink never does, the pool only when it can.
      const result = call.functionName === 'snapshot' ? (state.poolCanRecord && !poolStored() ? 1 : 0) : true;
      if (opts.worthSending !== undefined && !opts.worthSending(result)) return { status: 'no-op', result };
      if (state.sendFails) {
        state.sends.push({ fn: call.functionName, status: 'send-failed' });
        return { status: 'send-failed', error: 'HTTP request failed.' };
      }
      if (call.functionName === 'snapshot' && result === 1) state.priced.add(SNAP_POOL.toLowerCase());
      state.sends.push({ fn: call.functionName, status: 'confirmed' });
      return { status: 'confirmed', hash: `0x${'ab'.repeat(32)}`, nonce: 1, blockNumber: state.block, gasUsed: 1n, result };
    },
  };
  const store = new V2Store(':memory:');
  const index = new CrankerIndex(store);
  index.bind({ chainId: config.chainId, clearinghouse: CH, orderBook: config.contracts.orderBook, autoRoller: null });
  const pages: Array<{ kind: string; dedupeKey?: string }> = [];
  const alerter = { alert: async (kind: string, _m: string, _d: unknown, o: { dedupeKey?: string } = {}) => (pages.push({ kind, dedupeKey: o.dedupeKey }), true), clear: () => undefined };
  const ctx: CrankContext = {
    config,
    log: silentLogger(),
    client: client as never,
    logClient: { getLogs: async () => [] } as never,
    addresses: { clearinghouse: CH, orderBook: config.contracts.orderBook, settlementOracle: ORACLE_A, expiryCalendar: config.contracts.expiryCalendar, autoRoller: null, feeSplitter: null, multicall3: config.multicall3 },
    store,
    index,
    sender,
    alerts: new CrankAlerts(alerter as never, store, false),
    indexer: null,
  };
  const mark = () => store.getMeta(snapshotMetaKey(key));
  return { ctx, state, key, pages, mark };
}

test('inside the grace, a snapshot the pool cannot record yet leaves the expiry unmarked, asks again at a precise wake-up, and marks once the pool records', async () => {
  const h = snapshotHarness();
  // Past finalize's opening (E + 120): the planner has no wake-up of its own for this expiry any more.
  h.state.now = E + 200;
  const first = await stepSnapshot(h.ctx, [h.key]);
  assert.deepEqual(first.actions.map((a) => [a.kind, a.status]), [['snapshot', 'no-op']], 'the simulation recorded nothing, so nothing was sent');
  assert.equal(h.mark(), null, 'the pool is still dark: a snapshot that recorded nothing must not mark the expiry done');
  assert.deepEqual(first.wakeAt, [E + 200 + SNAPSHOT_RETRY_S], 'a retry is scheduled inside the grace, not left to the next poll');
  assert.ok(first.wakeAt.every((t) => t < E + SNAPSHOT_GRACE), 'every retry lands before the grace closes');

  // A minute later the pool can price the window: the retry records it, and the expiry is marked with that count.
  h.state.now = E + 200 + SNAPSHOT_RETRY_S;
  h.state.poolCanRecord = true;
  const second = await stepSnapshot(h.ctx, [h.key]);
  assert.deepEqual(h.state.sends, [{ fn: 'snapshot', status: 'confirmed' }]);
  assert.notEqual(h.mark(), null, 'the pool recorded: the expiry is marked');
  assert.equal(JSON.parse(h.mark()!).recorded, 1);
  assert.deepEqual(second.wakeAt, [], 'marked: no further retry');
});

test('a pool that never records inside the grace pages v2_snapshot_missed once the grace closes; finalize goes ahead on Chainlink', async () => {
  const h = snapshotHarness();
  for (const t of [E + 5, E + 200, E + 500]) {
    h.state.now = t;
    await stepSnapshot(h.ctx, [h.key]);
  }
  assert.equal(h.mark(), null, 'three attempts inside the grace, the pool dark each time: never marked');
  assert.equal(h.pages.length, 0, 'no page while the grace is still open');

  h.state.now = E + SNAPSHOT_GRACE + 1;
  const after = await stepSnapshot(h.ctx, [h.key]);
  assert.deepEqual(after.actions, [], 'past the grace no snapshot is sent: record() can no longer succeed');
  await stepFinalize(h.ctx, [h.key]);
  assert.deepEqual(h.pages.map((p) => p.kind), ['v2_snapshot_missed'], 'the lost pool leg pages');
  assert.equal(h.pages[0]!.dedupeKey, `${h.key.underlying}:${E}`);
  assert.deepEqual(h.state.sends.map((s) => s.fn), ['finalize'], 'Chainlink still prices the window, so finalize is sent');
});

test('control: a snapshot that records nothing still marks when no pool is dark: every source priced, or only a Chainlink feed dark', async () => {
  const allPriced = snapshotHarness();
  allPriced.state.priced.add(SNAP_POOL.toLowerCase());
  const a = await stepSnapshot(allPriced.ctx, [allPriced.key]);
  assert.notEqual(allPriced.mark(), null, 'both sources price the window: nothing left to record, marked');
  assert.equal(JSON.parse(allPriced.mark()!).recorded, 0);
  assert.deepEqual(a.wakeAt, []);

  const feedDark = snapshotHarness();
  feedDark.state.priced = new Set([SNAP_POOL.toLowerCase()]);
  const b = await stepSnapshot(feedDark.ctx, [feedDark.key]);
  assert.notEqual(feedDark.mark(), null, 'the pool has its snapshot; the dark Chainlink feed cannot be helped by one, so the expiry is marked');
  assert.equal(JSON.parse(feedDark.mark()!).recorded, 0);
  assert.deepEqual(b.wakeAt, [], 'and no retry is scheduled for it');
});

test('a broadcast that fails inside the grace is retried at a wake-up; no retry is scheduled past the grace; an unreadable probe does not mark', async () => {
  const failing = snapshotHarness();
  failing.state.poolCanRecord = true;
  failing.state.sendFails = true;
  const r = await stepSnapshot(failing.ctx, [failing.key]);
  assert.deepEqual(failing.state.sends, [{ fn: 'snapshot', status: 'send-failed' }]);
  assert.equal(failing.mark(), null);
  assert.deepEqual(r.wakeAt, [E + 200 + SNAPSHOT_RETRY_S]);

  const late = snapshotHarness();
  late.state.now = E + SNAPSHOT_GRACE - SNAPSHOT_RETRY_S;
  const l = await stepSnapshot(late.ctx, [late.key]);
  assert.equal(late.mark(), null, 'the last attempt still does not mark a dark pool');
  assert.deepEqual(l.wakeAt, [], `a retry at ${E + SNAPSHOT_GRACE} would land after the grace: none is scheduled`);

  const blind = snapshotHarness();
  blind.state.probeThrows = true;
  await stepSnapshot(blind.ctx, [blind.key]);
  assert.equal(blind.mark(), null, 'the snapshots() read failed: the mark is not set on what could not be seen');
});
