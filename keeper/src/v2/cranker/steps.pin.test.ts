/**
 * The cranker against INTERFACE_VERSION 6's settlement pins, through the real steps on a fake chain.
 *
 * WHY THIS FILE EXISTS: every createSeries pins its expiry, and the pin fails closed. A ladder batch budgeted for a
 * pinned expiry starves the first series of a new one (the rung never appears); a refused pin retried blindly spends a
 * tick's budget and pages nobody; and a finalize decision read from the market's current sources judges an expiry by
 * a list it will never settle on. Pinned: the pin budget of each new (underlying, expiry) in the batch's gas limit; a
 * refused pin probed with ample gas, skipped, marked, paged once per cause and asked again only after the recheck,
 * then cleared; a refusal a batch reports marks its group too; a roll refused by its series' pin pages; and the survey
 * reading the expiry's settlementConfig, never marketConfig.
 *
 * DELIBERATELY ABSENT: an RPC. The client answers multicall, readContract, simulateContract and getBlock from tables;
 * the sender records calls and answers what a test says. ops/devnet (v2:devnet-cycle) runs the same code on a chain.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BaseError, ContractFunctionRevertedError, decodeFunctionData, encodeErrorResult, getAddress, type Abi, type Address, type Hex } from 'viem';
import { clearinghouseAbi } from '../abi/clearinghouse.js';
import { loadV2Config, type CrankerConfig } from '../config.js';
import { silentLogger } from '../logger.js';
import { longIdOf } from '../seriesId.js';
import { V2Store } from '../store.js';
import type { TxOutcome } from '../tx.js';
import { GAS, PIN_REFUSED_RECHECK_S } from './constants.js';
import { CrankAlerts, type CrankSender, type FixedGasCall } from './effects.js';
import { CrankerIndex } from './index-store.js';
import { pinGasOf } from './planner.js';
import { PIN_ERROR_SELECTORS } from './pin.js';
import { surveyExpiries } from './reads.js';
import { pinRefusedMetaKey, stepLadders, stepRolls, type CrankContext } from './steps.js';

const REGISTRY = fileURLToPath(new URL('../fixtures/registry-v2.json', import.meta.url));
const CH = getAddress('0x2256c045245288A314048aD2d71006a564343C63');
const ORACLE = getAddress('0x4b8c2BEFfecbdc4BeD6e6826e62093F0Cf635E78');
const CL = getAddress('0x157f589Cd9d0E4a94C9936ede3b23BEfa3017F20');
const POOL = getAddress('0x5d46388aD462fF7f92587fE4872e97668e98329d');
const ZERO = '0x0000000000000000000000000000000000000000';
const T0 = 1_789_750_000;
const E = 1_789_934_400;

type Handler = (args: readonly unknown[], address: Address) => unknown;

/** A revert as viem's simulateContract throws it. */
function simulationRevert(errorName: string, args: readonly unknown[] = []): BaseError {
  const data = encodeErrorResult({ abi: clearinghouseAbi, errorName, args } as never);
  return new BaseError('simulation failed', { cause: new ContractFunctionRevertedError({ abi: clearinghouseAbi, data, functionName: 'createSeries' }) });
}

function harness(options: { roller?: Address } = {}) {
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
  const [nvda, tsla] = [markets.find((m) => m.ticker === 'NVDA')!, markets.find((m) => m.ticker === 'TSLA')!];

  const state = {
    now: T0,
    block: 65_000_000n,
    expiry: E,
    created: new Set<string>(),
    pinnedBy: new Map<string, Address>(),
    sources: new Map<string, Address[]>([[nvda.underlying.toLowerCase(), [CL, POOL]], [tsla.underlying.toLowerCase(), [CL]]]),
    /** Per underlying: what a createSeries simulation throws (probe). */
    probeError: new Map<string, BaseError>(),
    /** Per underlying: the raw revert data a batch reports for its creates. */
    batchFailure: new Map<string, Hex>(),
    calls: [] as string[],
  };

  const views: Record<string, Handler> = {
    createPaused: () => false,
    market: () => ({ enabled: true, mintPaused: false, strikeTick: 1_000_000n, exerciseFeeBps: 25, oracle: ORACLE }),
    trySpot: () => [true, 100_000_000n, BigInt(state.now)],
    seriesExists: ([id]) => state.created.has(String(id)),
    pinnedBy: ([u, e]) => state.pinnedBy.get(`${String(u).toLowerCase()}:${e}`) ?? ZERO,
    settlementConfig: ([u, e]) => [state.pinnedBy.has(`${String(u).toLowerCase()}:${e}`), state.sources.get(String(u).toLowerCase()) ?? [], 150, 21_600, 90_000],
  };
  const client = {
    getBlock: async () => ({ number: state.block, timestamp: BigInt(state.now) }),
    getBlockNumber: async () => state.block,
    multicall: async ({ contracts }: { contracts: Array<{ functionName: string; args?: readonly unknown[]; address: Address }> }) =>
      contracts.map((c) => {
        state.calls.push(`view ${c.functionName}`);
        const handler = views[c.functionName];
        if (handler === undefined) return { status: 'failure', error: new Error(`no view ${c.functionName}`) };
        return { status: 'success', result: handler(c.args ?? [], c.address) };
      }),
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === 'nextExpiry') return state.expiry;
      throw new Error(`no readContract ${functionName}`);
    },
    simulateContract: async ({ functionName, args, gas }: { functionName: string; args: readonly unknown[]; gas: bigint }) => {
      state.calls.push(`probe ${functionName} ${String(args[0]).toLowerCase()} gas=${gas}`);
      const error = state.probeError.get(String(args[0]).toLowerCase());
      if (error !== undefined) throw error;
      return { result: 1n, request: {} };
    },
  };

  const sends: Array<{ fn: string; gas: bigint; creates: Array<{ underlying: string; strike: bigint; expiry: number }>; args: readonly unknown[] }> = [];
  const rollOutcomes: TxOutcome[] = [];
  const sender: CrankSender = {
    dryRun: false,
    account: '0x000000000000000000000000000000000000beef',
    async execute(call: FixedGasCall, opts) {
      if (call.functionName === 'roll') {
        sends.push({ fn: 'roll', gas: call.gas, creates: [], args: call.args as readonly unknown[] });
        return rollOutcomes.shift() ?? { status: 'no-op', result: false };
      }
      const calls = (call.args as unknown as [Array<{ callData: Hex }>])[0];
      const creates = calls.map((c) => {
        const { args } = decodeFunctionData({ abi: clearinghouseAbi, data: c.callData }) as { args: readonly [Address, boolean, bigint, number] };
        return { underlying: args[0].toLowerCase(), strike: args[2], expiry: Number(args[3]) };
      });
      sends.push({ fn: call.functionName, gas: call.gas, creates, args: call.args as readonly unknown[] });
      const results = creates.map((c) => {
        const failure = state.batchFailure.get(c.underlying);
        return failure === undefined ? { success: true, returnData: '0x' as Hex } : { success: false, returnData: failure };
      });
      if (opts.worthSending !== undefined && !opts.worthSending(results)) return { status: 'no-op', result: results };
      creates.forEach((c, i) => {
        if (!results[i]!.success) return;
        state.created.add(longIdOf(c.underlying as Address, false, c.strike, c.expiry).toString());
        state.pinnedBy.set(`${c.underlying}:${c.expiry}`, CH);
      });
      return { status: 'confirmed', hash: `0x${'ab'.repeat(32)}`, nonce: 1, blockNumber: state.block, gasUsed: 1n, result: results };
    },
  };

  const store = new V2Store(':memory:');
  const index = new CrankerIndex(store);
  index.bind({ chainId: config.chainId, clearinghouse: CH, orderBook: config.contracts.orderBook, autoRoller: options.roller ?? null });
  const alerts: Array<{ kind: string; message: string; data: Record<string, unknown>; dedupeKey?: string }> = [];
  const cleared: string[] = [];
  const alerter = {
    alert: async (kind: string, message: string, data: Record<string, unknown> = {}, o: { dedupeKey?: string } = {}) => (alerts.push({ kind, message, data, dedupeKey: o.dedupeKey }), true),
    clear: (kind: string, key?: string) => void cleared.push(`${kind}:${key}`),
  };
  const ctx: CrankContext = {
    config,
    log: silentLogger(),
    client: client as never,
    logClient: { getLogs: async () => [] } as never,
    addresses: { clearinghouse: CH, orderBook: config.contracts.orderBook, settlementOracle: ORACLE, expiryCalendar: config.contracts.expiryCalendar, autoRoller: options.roller ?? null, feeSplitter: null, multicall3: config.multicall3 },
    store,
    index,
    sender,
    alerts: new CrankAlerts(alerter as never, store, false),
    indexer: null,
  };
  return { ctx, state, sends, alerts, cleared, nvda, tsla, store, index, rollOutcomes };
}

const group = (underlying: string, expiry = E) => `${ORACLE.toLowerCase()}:${underlying.toLowerCase()}:${expiry}`;

test('ladders: a new expiry\'s batch carries the pin of each (underlying, expiry); a refused pin is probed with ample gas, skipped, marked and paged once per cause', async () => {
  const h = harness();
  const tslaU = h.tsla.underlying.toLowerCase();
  h.state.probeError.set(tslaU, simulationRevert('SourceNotPinned', [CL, PIN_ERROR_SELECTORS.NotAuthorized]));

  const report = await stepLadders(h.ctx);

  // Both new groups were probed alone, with ample gas; only NVDA went into the batch, with its two-source pin budgeted.
  assert.deepEqual(h.state.calls.filter((c) => c.startsWith('probe')).map((c) => c.split(' ')[2]), [h.nvda.underlying.toLowerCase(), tslaU]);
  assert.ok(h.state.calls.filter((c) => c.startsWith('probe')).every((c) => c.endsWith(`gas=${GAS.createSeriesProbe}`)));
  assert.equal(h.sends.length, 1);
  assert.deepEqual([...new Set(h.sends[0]!.creates.map((c) => c.underlying))], [h.nvda.underlying.toLowerCase()]);
  assert.equal(h.sends[0]!.creates.length, 2);
  assert.equal(h.sends[0]!.gas, GAS.createSeriesBase + 2n * GAS.createSeriesEach + pinGasOf(2));

  // TSLA: marked, one error page naming the source and the reason, the expiry listed.
  const mark = JSON.parse(h.store.getMeta(pinRefusedMetaKey(group(tslaU)))!) as { at: number; error: string; alertKey: string };
  assert.deepEqual({ at: mark.at, error: mark.error }, { at: T0, error: 'SourceNotPinned' });
  const pages = h.alerts.filter((a) => a.kind === 'v2_pin_refused');
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.dedupeKey, `${ORACLE.toLowerCase()}:sourcenotpinned:${CL.toLowerCase()}:${PIN_ERROR_SELECTORS.NotAuthorized}`);
  assert.equal(pages[0]!.data.reasonName, 'NotAuthorized');
  assert.deepEqual(pages[0]!.data.expiries, [{ ticker: 'TSLA', expiry: E }]);
  assert.match(pages[0]!.message, /setOracle/);
  const pins = report.notes.pins as Array<{ ticker: string; action: string; probe?: string; refused?: string }>;
  assert.deepEqual(pins.map((p) => [p.ticker, p.action, p.probe]), [['NVDA', 'probe', 'ok'], ['TSLA', 'probe', 'refused']]);
  assert.equal(report.notes.created, 2);

  // Inside the recheck: nothing probed, sent or paged for TSLA; NVDA exists now.
  h.state.calls.length = 0;
  h.state.now = T0 + PIN_REFUSED_RECHECK_S - 1;
  const inside = await stepLadders(h.ctx);
  assert.deepEqual(h.state.calls.filter((c) => c.startsWith('probe')), []);
  assert.equal(h.sends.length, 1);
  assert.equal(h.alerts.filter((a) => a.kind === 'v2_pin_refused').length, 1);
  assert.deepEqual((inside.notes.pins as Array<{ ticker: string; action: string; recheckAt: number }>).map((p) => [p.ticker, p.action, p.recheckAt]), [['TSLA', 'skip', T0 + PIN_REFUSED_RECHECK_S]]);

  // The admin fixed the allow-list: at the recheck the probe passes, the mark and the alert are cleared, TSLA is created with a one-source pin.
  h.state.probeError.delete(tslaU);
  h.state.now = T0 + PIN_REFUSED_RECHECK_S;
  await stepLadders(h.ctx);
  assert.equal(h.store.getMeta(pinRefusedMetaKey(group(tslaU))), null);
  assert.deepEqual(h.cleared, [`v2_pin_refused:${mark.alertKey}`]);
  assert.equal(h.sends.length, 2);
  assert.deepEqual([...new Set(h.sends[1]!.creates.map((c) => c.underlying))], [tslaU]);
  assert.equal(h.sends[1]!.gas, GAS.createSeriesBase + 2n * GAS.createSeriesEach + pinGasOf(1));
});

test('ladders: an expiry this Clearinghouse pinned is created without a probe or pin gas; a refusal the batch reports marks it and pages', async () => {
  const h = harness();
  const nvdaU = h.nvda.underlying.toLowerCase();
  const tslaU = h.tsla.underlying.toLowerCase();
  h.state.pinnedBy.set(`${nvdaU}:${E}`, CH);
  h.state.pinnedBy.set(`${tslaU}:${E}`, CH);
  // The oracle's clearinghouse pointer moved after the pin: every TSLA create in the batch reverts NotAuthorized.
  h.state.batchFailure.set(tslaU, encodeErrorResult({ abi: clearinghouseAbi, errorName: 'NotAuthorized' }));

  const report = await stepLadders(h.ctx);
  assert.deepEqual(h.state.calls.filter((c) => c.startsWith('probe')), [], 'pinned by us: no probe');
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0]!.gas, GAS.createSeriesBase + 4n * GAS.createSeriesEach, 'no pin budget');
  const failures = report.notes.failures as Array<{ ticker: string; revert: string; pin?: string }>;
  assert.deepEqual(failures.map((f) => [f.ticker, f.revert]), [['TSLA', 'NotAuthorized'], ['TSLA', 'NotAuthorized']]);
  assert.match(failures[0]!.pin!, /clearinghouse pointer/);
  assert.notEqual(h.store.getMeta(pinRefusedMetaKey(group(tslaU))), null);
  const pages = h.alerts.filter((a) => a.kind === 'v2_pin_refused');
  assert.deepEqual(pages.map((p) => [p.dedupeKey, p.data.error]), [[`${ORACLE.toLowerCase()}:notauthorized`, 'NotAuthorized']]);

  // Next tick, inside the recheck: TSLA is not sent again.
  h.state.now += 60;
  await stepLadders(h.ctx);
  assert.equal(h.sends.length, 1);
});

test('ladders: a SourceNotPinned without revert data from a batch may be a starved source: named in the notes, not marked; the next tick probes', async () => {
  const h = harness();
  const nvdaU = h.nvda.underlying.toLowerCase();
  h.state.batchFailure.set(nvdaU, encodeErrorResult({ abi: clearinghouseAbi, errorName: 'SourceNotPinned', args: [POOL, '0x00000000'] }));
  const report = await stepLadders(h.ctx);
  assert.equal(h.store.getMeta(pinRefusedMetaKey(group(nvdaU))), null);
  assert.deepEqual((report.notes.failures as Array<{ ticker: string; revert: string; pin: string }>).map((f) => [f.ticker, f.revert, /out of gas/.test(f.pin)]), [['NVDA', 'SourceNotPinned', true], ['NVDA', 'SourceNotPinned', true]]);
  assert.equal(h.alerts.filter((a) => a.kind === 'v2_pin_refused').length, 0);

  // Not marked, so the next tick asks again at once, with a probe under ample gas that decides.
  h.state.calls.length = 0;
  h.state.now += 60;
  await stepLadders(h.ctx);
  assert.deepEqual(h.state.calls.filter((c) => c.startsWith('probe')).map((c) => c.split(' ')[2]), [nvdaU]);
});

test('rolls: a roll refused by its new series\' pin pages v2_pin_refused; a roll the roller itself refuses (NotAuthorized) does not', async () => {
  const roller = getAddress('0xC42b6f89b9970cd5a8e7bFC21D6CbB02F8f82302');
  const h = harness({ roller });
  const writer = '0x00000000000000000000000000000000000000a1';
  h.index.applyRange({ series: [], holders: [], orders: [], strategies: [{ writer, underlying: h.nvda.underlying }], block: 1n }, 1n);
  const views = (h.ctx.client as unknown as { multicall: (x: { contracts: Array<{ functionName: string }> }) => Promise<unknown[]> }).multicall;
  (h.ctx.client as unknown as { multicall: unknown }).multicall = async (x: { contracts: Array<{ functionName: string; args?: readonly unknown[]; address: Address }> }) => {
    const extra: Record<string, unknown> = {
      isRegularSession: true,
      strategy: { active: true, weekly: false, smartPricing: false },
      position: [0n, 0n, 0],
    };
    const base = (await views(x)) as Array<{ status: string }>;
    return x.contracts.map((c, i) => (c.functionName in extra ? { status: 'success', result: extra[c.functionName] } : base[i]));
  };
  h.rollOutcomes.push({ status: 'simulation-reverted', revert: 'SourceNotPinned', revertArgs: [POOL, PIN_ERROR_SELECTORS.PinMismatch], error: 'reverted' });
  const report = await stepRolls(h.ctx);
  assert.equal(h.sends.filter((s) => s.fn === 'roll').length, 1);
  assert.equal(h.sends[0]!.gas, GAS.roll);
  const pages = h.alerts.filter((a) => a.kind === 'v2_pin_refused');
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.dedupeKey, `roll:${h.nvda.underlying.toLowerCase()}:sourcenotpinned:${POOL.toLowerCase()}:${PIN_ERROR_SELECTORS.PinMismatch}`);
  assert.match(pages[0]!.message, /earlier pin/);
  assert.match(String((report.notes.reverting as Array<{ pin?: string }>)[0]!.pin), /earlier pin/);

  h.rollOutcomes.push({ status: 'simulation-reverted', revert: 'NotAuthorized', error: 'reverted' });
  await stepRolls(h.ctx);
  assert.equal(h.alerts.filter((a) => a.kind === 'v2_pin_refused').length, 1, 'a revoked operator approval is the writer\'s, not a pin');
});

test('GAS.roll covers the first roll into an expiry (pin included) and a close-out in one call, with headroom', () => {
  // AutoRollerCycleTest.test_gas_rollAndCloseOut on the v6 contracts: first roll 718,819; close-out 437,284.
  const firstRoll = 718_819n;
  const closeOut = 437_284n;
  // A close-out whose settle finalizes over a 96-read Chainlink walk (+170k settle, +661k walk, less the 133k of a settle of a final expiry), then a first roll on three sources.
  const worst = closeOut - 133_000n + 170_000n + 661_000n + firstRoll + GAS.createSeriesPinPerSource;
  assert.ok(GAS.roll * 100n >= worst * 110n, `${GAS.roll} leaves 10 % over ${worst}`);
  assert.ok(GAS.roll > firstRoll * 3n);
});

test('the survey reads the expiry\'s settlement configuration (pinned), never the market\'s current sources', async () => {
  const U = getAddress('0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec');
  const PINNED_A = getAddress('0x00000000000000000000000000000000000000aa');
  const PINNED_B = getAddress('0x00000000000000000000000000000000000000bb');
  const calls: Array<{ fn: string; address: string }> = [];
  const results: Record<string, (args: readonly unknown[], address: Address) => unknown> = {
    openInterest: () => 100n,
    settlementPrice: () => [0, 0n],
    candidate: () => [0n, 0, false, 0],
    settlementInfo: () => [0, 0n, 0, false, false, false],
    recordedSources: () => [[], [], [], 0],
    settlementConfig: () => [true, [PINNED_A, PINNED_B], 150, 21_600, 90_000],
    // The admin re-pointed the market after the pin: the expiry must not be judged by this list.
    marketConfig: () => [[getAddress('0x00000000000000000000000000000000000000cc')], 150, 21_600, 90_000],
    windowPrice: (_, address) => (address.toLowerCase() === PINNED_A.toLowerCase() ? [true, 216_000_000n] : [false, 0n]),
  };
  const client = {
    getBlockNumber: async () => 1n,
    multicall: async ({ contracts }: { contracts: Array<{ functionName: string; args?: readonly unknown[]; address: Address; abi: Abi }> }) =>
      contracts.map((c) => {
        calls.push({ fn: c.functionName, address: c.address.toLowerCase() });
        return { status: 'success', result: results[c.functionName]!(c.args ?? [], c.address) };
      }),
  };
  const [survey] = await surveyExpiries(client as never, {
    clearinghouse: CH,
    orderBook: CH,
    keys: [{ oracle: ORACLE, underlying: U, expiry: E }],
    seriesOf: () => [],
    snapshotDone: () => true,
    now: E + 200,
    blockNumber: 1n,
    withOrders: false,
    prunable: () => [],
  });
  assert.deepEqual(survey!.view.sources.map((s) => [s.address, s.windowOk]), [[PINNED_A, true], [PINNED_B, false]]);
  assert.equal(survey!.view.pinned, true);
  assert.equal(calls.some((c) => c.fn === 'marketConfig'), false, 'marketConfig is never read');
  assert.deepEqual(calls.filter((c) => c.fn === 'windowPrice').map((c) => c.address), [PINNED_A.toLowerCase(), PINNED_B.toLowerCase()]);

  // An oracle that does not answer settlementConfig is cranked blind rather than on the market's list.
  results.settlementConfig = () => {
    throw new Error('no settlementConfig');
  };
  const blindClient = {
    getBlockNumber: async () => 1n,
    multicall: async ({ contracts }: { contracts: Array<{ functionName: string; args?: readonly unknown[]; address: Address }> }) =>
      contracts.map((c) => {
        try {
          return { status: 'success', result: results[c.functionName]!(c.args ?? [], c.address) };
        } catch (error) {
          return { status: 'failure', error };
        }
      }),
  };
  const [blind] = await surveyExpiries(blindClient as never, { clearinghouse: CH, orderBook: CH, keys: [{ oracle: ORACLE, underlying: U, expiry: E }], seriesOf: () => [], snapshotDone: () => true, now: E + 200, blockNumber: 1n, withOrders: false, prunable: () => [] });
  assert.deepEqual({ sourcesKnown: blind!.view.sourcesKnown, sources: blind!.view.sources.length, pinned: blind!.view.pinned }, { sourcesKnown: false, sources: 0, pinned: null });
});

test('rolls: writers whose roll earns no bounty (under minRollUnits) cannot crowd honest writers out of the per-step budget; they are capped and rotated', async () => {
  const roller = getAddress('0xC42b6f89b9970cd5a8e7bFC21D6CbB02F8f82302');
  const h = harness({ roller });
  const UNIT = 10n ** 16n;
  // 55 dust strategies at addresses that sort first (1 share or less of collateral each), then 5 real writers.
  const dust = Array.from({ length: 55 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, '0')}`));
  const honest = Array.from({ length: 5 }, (_, i) => getAddress(`0xff${(i + 1).toString(16).padStart(38, '0')}`));
  h.index.applyRange({ series: [], holders: [], orders: [], strategies: [...dust, ...honest].map((writer) => ({ writer, underlying: h.nvda.underlying })), block: 1n }, 1n);
  const views = (h.ctx.client as unknown as { multicall: (x: { contracts: Array<{ functionName: string }> }) => Promise<unknown[]> }).multicall;
  (h.ctx.client as unknown as { multicall: unknown }).multicall = async (x: { contracts: Array<{ functionName: string; args?: readonly unknown[]; address: Address }> }) => {
    const base = (await views(x)) as Array<{ status: string }>;
    return x.contracts.map((c, i) => {
      switch (c.functionName) {
        case 'isRegularSession':
          return { status: 'success', result: true };
        case 'strategy':
          return { status: 'success', result: { active: true, weekly: false, smartPricing: false, maxUnits: 0n } };
        case 'position':
          return { status: 'success', result: [0n, 0n, 0] };
        case 'minRollUnits':
          return { status: 'success', result: 100n };
        case 'free':
          return { status: 'success', result: honest.includes(getAddress(String(c.args![0]))) ? 1_000n * UNIT : 50n * UNIT };
        default:
          return base[i];
      }
    });
  };
  h.ctx.sender = {
    ...h.ctx.sender,
    execute: async (call) => {
      h.sends.push({ fn: call.functionName, gas: call.gas, creates: [], args: call.args as readonly unknown[] });
      return { status: 'confirmed', hash: `0x${'ab'.repeat(32)}`, nonce: 1, blockNumber: 1n, gasUsed: 1n, result: true };
    },
  };
  await stepRolls(h.ctx);
  const rolled = h.sends.filter((s) => s.fn === 'roll').map((s) => getAddress(String(s.args[0])));
  assert.ok(honest.every((w) => rolled.includes(w)), `every writer whose roll earns the bounty rolled (${rolled.length} rolls)`);
  const dustRolled = rolled.filter((w) => dust.includes(w));
  assert.ok(dustRolled.length <= 10, `below-bounty rolls capped per tick (${dustRolled.length})`);
  // The next tick moves on to other dust writers instead of the same first ten.
  h.sends.length = 0;
  await stepRolls(h.ctx);
  const next = h.sends.filter((s) => s.fn === 'roll').map((s) => getAddress(String(s.args[0]))).filter((w) => dust.includes(w));
  assert.ok(next.length > 0 && next.some((w) => !dustRolled.includes(w)), 'rotated');
});
