/**
 * The v8 flywheel step against a fake chain: claim, distribute, buy back.
 *
 * WHY THIS FILE EXISTS: the step spends protocol USDG, and almost every way it can go wrong is silent. A
 * `minTokenOut` that leaked the probe's `1` would buy at any price and still confirm. A cap that the keeper
 * tried to enforce off chain would stall the whole reserve the first time the contract's cap moved. A
 * distribute sent on an estimated gas limit would catch its own out-of-gas and "succeed" having converted
 * nothing. None of those revert, so none of them would show up as a failure anywhere else.
 *
 * DELIBERATELY ABSENT: an RPC, and any assertion about WHY the splitter skipped. The splitter's skip reasons
 * (NO_ROUTE, NO_SPOT, DUST, BELOW_FLOOR, EMPTY, NO_EXECUTOR) are all expressed as a zero return, and the tests
 * below assert that a zero return sends nothing — never that the step recomputed the reason.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ContractFunctionRevertedError, encodeErrorResult, getAddress, type Address } from 'viem';
import { feeSplitterAbi } from '../abi/feeSplitter.js';
import { loadV2Config, type CrankerConfig } from '../config.js';
import { silentLogger } from '../logger.js';
import { v2Markets } from '../registry.js';
import { V2Store } from '../store.js';
import type { TxOutcome } from '../tx.js';
import { BUYBACK_COOLDOWN, BPS, GAS } from './constants.js';
import { CrankAlerts, type CrankSender, type FixedGasCall } from './effects.js';
import { stepFlywheel } from './flywheel.js';
import { CrankerIndex } from './index-store.js';
import { flywheelMetaKey, type CrankContext } from './steps.js';

const REGISTRY = fileURLToPath(new URL('../fixtures/registry-v2.json', import.meta.url));
const CH = getAddress('0x2256c045245288A314048aD2d71006a564343C63');
const BOOK = getAddress('0x9bE1c0b1E4f9C6e4dC8e3cA7B2f1e0a9D8c7b6A5');
const SPLITTER = getAddress('0x00000000000000000000000000000000c0de000c');
const USDG = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
const NOW = 1_789_934_400;

/**
 * The error names `feeSplitterAbi` actually declares. `encodeErrorResult` accepts only these, which is
 * the property this test relies on: a revert name that drifts from the generated ABI must fail to
 * compile rather than encode into a revert the step will never classify.
 */
type FeeSplitterErrorName = Extract<(typeof feeSplitterAbi)[number], { type: 'error' }>['name'];

interface Options {
  enabled?: boolean;
  splitter?: Address | null;
  dryRun?: boolean;
  buybackDryRun?: boolean;
  toleranceBps?: number;
}

function harness(options: Options = {}) {
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
    V2_ORDER_BOOK: BOOK,
    CRANKER_FLYWHEEL_ENABLED: options.enabled === false ? '0' : '1',
    CRANKER_BUYBACK_DRY_RUN: options.buybackDryRun === true ? '1' : '0',
    ...(options.toleranceBps === undefined ? {} : { CRANKER_BUYBACK_TOLERANCE_BPS: String(options.toleranceBps) }),
  }) as CrankerConfig;

  const state = {
    now: NOW,
    block: 65_000_000n,
    /** OrderBook.owed(splitter). */
    owed: 0n,
    /** ERC-20 balances of the splitter, by asset. */
    balances: new Map<string, bigint>(),
    buybackBalance: 0n,
    lastBuybackAt: 0n,
    /** Assets whose balanceOf read fails, to prove per-asset isolation. */
    failBalanceOf: new Set<string>(),
    /** View names whose multicall read FAILS the way allowFailure: true reports it (status 'failure', no throw). */
    failViews: new Set<string>(),
    /** The buyback probe's answer, or a revert name. */
    probe: { usdgIn: 0n, burned: 0n } as { usdgIn: bigint; burned: bigint } | { revert: FeeSplitterErrorName },
    /** What each write's simulation returns; a string is a revert name. */
    sim: {} as Record<string, unknown>,
    sends: [] as Array<{ fn: string; args: readonly unknown[]; gas: bigint }>,
    probes: [] as Array<{ fn: string; args: readonly unknown[] }>,
  };

  const views: Record<string, (args: readonly unknown[]) => unknown> = {
    owed: () => state.owed,
    buybackBalance: () => state.buybackBalance,
    lastBuybackAt: () => state.lastBuybackAt,
    balanceOf: ([who]) => {
      void who;
      return 0n; // replaced per-call below; multicall routes by address, not by name
    },
  };

  const client = {
    getBlock: async () => ({ number: state.block, timestamp: BigInt(state.now) }),
    getBlockNumber: async () => state.block,
    multicall: async ({ contracts }: { contracts: Array<{ address: Address; functionName: string; args?: readonly unknown[] }> }) =>
      contracts.map((c) => {
        if (c.functionName === 'balanceOf') {
          const key = c.address.toLowerCase();
          if (state.failBalanceOf.has(key)) return { status: 'failure', error: new Error('rpc said no') };
          return { status: 'success', result: state.balances.get(key) ?? 0n };
        }
        if (state.failViews.has(c.functionName)) return { status: 'failure', error: new Error(`execution reverted: ${c.functionName}`) };
        const handler = views[c.functionName];
        if (handler === undefined) return { status: 'failure', error: new Error(`no view ${c.functionName}`) };
        return { status: 'success', result: handler(c.args ?? []) };
      }),
    readContract: async ({ functionName, args = [] }: { functionName: string; args?: readonly unknown[] }) => {
      const handler = views[functionName];
      if (handler === undefined) throw new Error(`no readContract ${functionName}`);
      return handler(args);
    },
    simulateContract: async ({ functionName, args = [] }: { functionName: string; args?: readonly unknown[] }) => {
      state.probes.push({ fn: functionName, args });
      if ('revert' in state.probe) {
        // A REAL viem revert, encoded from the generated ABI and decoded by the same revertDetail() the step
        // uses in production. A hand-rolled Error would take the `revert === null` branch and this test would
        // pass while proving nothing about the classification it exists to check.
        throw new ContractFunctionRevertedError({
          abi: feeSplitterAbi,
          data: encodeErrorResult({ abi: feeSplitterAbi, errorName: state.probe.revert }),
          functionName: 'buyback',
        });
      }
      return { result: [state.probe.usdgIn, state.probe.burned] };
    },
  };

  const sender: CrankSender = {
    dryRun: options.dryRun === true,
    account: '0x000000000000000000000000000000000000beef',
    async execute(call: FixedGasCall, opts): Promise<TxOutcome> {
      const args = call.args as readonly unknown[];
      if (opts.isAdvanced !== undefined && (await opts.isAdvanced())) return { status: 'already-advanced' };
      const simulated = state.sim[call.functionName] ?? 0n;
      if (typeof simulated === 'string') return { status: 'simulation-reverted', revert: simulated, error: 'execution reverted' };
      if (opts.worthSending !== undefined && !opts.worthSending(simulated)) return { status: 'no-op', result: simulated };
      if (sender.dryRun) return { status: 'no-op', result: simulated };
      state.sends.push({ fn: call.functionName, args, gas: call.gas });
      return { status: 'confirmed', hash: `0x${'ab'.repeat(32)}`, nonce: 1, blockNumber: state.block, gasUsed: 1n, result: simulated };
    },
  };

  const store = new V2Store(':memory:');
  const index = new CrankerIndex(store);
  index.bind({ chainId: config.chainId, clearinghouse: CH, orderBook: BOOK, autoRoller: null });
  const alerts: Array<{ kind: string; message: string; data: Record<string, unknown>; dedupeKey?: string }> = [];
  const alerter = {
    alert: async (kind: string, message: string, data: Record<string, unknown> = {}, o: { dedupeKey?: string } = {}) => (alerts.push({ kind, message, data, dedupeKey: o.dedupeKey }), true),
    clear: () => undefined,
  };

  const ctx: CrankContext = {
    config,
    log: silentLogger(),
    client: client as never,
    logClient: { getLogs: async () => [], getBlockNumber: async () => state.block } as never,
    addresses: {
      clearinghouse: CH,
      orderBook: BOOK,
      settlementOracle: config.contracts.settlementOracle,
      expiryCalendar: config.contracts.expiryCalendar,
      autoRoller: null,
      feeSplitter: options.splitter === undefined ? SPLITTER : options.splitter,
      multicall3: config.multicall3,
    },
    store,
    index,
    sender,
    alerts: new CrankAlerts(alerter as never, store, false),
    indexer: null,
  };

  const underlyings = v2Markets(config.registry, ['live', 'paused']).map((m) => m.underlying);
  return { ctx, state, store, alerts, underlyings };
}

// Generic in the element type. The previous signature declared the array as `Array<{ fn: string }>`, so the
// RETURN type dropped `args` and `gas` -- which state.sends has carried since its declaration above -- and
// every caller that read either one off the result was reading a property the type said was not there.
const sent = <T extends { fn: string }>(state: { sends: T[] }, fn: string): T[] => state.sends.filter((s) => s.fn === fn);

/*//////////////////////////////////////////////////////////////
                             GATES
//////////////////////////////////////////////////////////////*/

test('the flag is off by default and the step sends nothing and says which gate stopped it', async () => {
  const { ctx, state } = harness({ enabled: false });
  state.owed = 10n ** 9n;
  state.buybackBalance = 10n ** 9n;
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(report.notes.skipped, 'disabled');
  assert.deepEqual(state.sends, [], 'nothing sent');
  assert.deepEqual(state.probes, [], 'not even a probe');
});

test('no splitter address: the step skips and the rest of the cranker is unaffected', async () => {
  // ops/v2/env/cranker.env:26-27 promises the operator exactly this, and that comment shipped before the code.
  const { ctx, state } = harness({ splitter: null });
  state.owed = 10n ** 9n;
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(report.notes.skipped, 'no-splitter');
  assert.deepEqual(state.sends, []);
});

test('the interval gate: a second pass inside CRANKER_FLYWHEEL_INTERVAL_S sends nothing and reports when it is due', async () => {
  const { ctx, state, store } = harness();
  state.owed = 10n ** 9n;
  state.sim.claimOrderBookFees = 10n ** 9n;
  await stepFlywheel(ctx, USDG);
  assert.equal(sent(state, 'claimOrderBookFees').length, 1, 'the first pass claims');

  state.now = NOW + 60;
  const second = await stepFlywheel(ctx, USDG);
  assert.equal(second.notes.skipped, 'interval');
  assert.equal(second.notes.nextAt, NOW + ctx.config.tuning.flywheelIntervalS);
  assert.equal(sent(state, 'claimOrderBookFees').length, 1, 'still one');
  assert.equal(store.getMeta(flywheelMetaKey), String(NOW));
});

/*//////////////////////////////////////////////////////////////
                        CLAIM AND DISTRIBUTE
//////////////////////////////////////////////////////////////*/

test('owed > 0 claims; owed == 0 sends no claim at all', async () => {
  const withOwed = harness();
  withOwed.state.owed = 25n * 10n ** 6n;
  withOwed.state.sim.claimOrderBookFees = 25n * 10n ** 6n;
  await stepFlywheel(withOwed.ctx, USDG);
  assert.equal(sent(withOwed.state, 'claimOrderBookFees').length, 1);
  assert.equal(sent(withOwed.state, 'claimOrderBookFees')[0]!.gas, GAS.claimOrderBookFees, 'fixed gas, never estimated');

  const without = harness();
  without.state.owed = 0n;
  await stepFlywheel(without.ctx, USDG);
  assert.equal(sent(without.state, 'claimOrderBookFees').length, 0, 'nothing owed, nothing sent, nothing logged');
});

test('distribute is sent for USDG and for each live or paused underlying holding a balance, with fixed gas', async () => {
  const { ctx, state, underlyings } = harness();
  assert.ok(underlyings.length >= 2, 'the fixture has live and paused markets');
  state.balances.set(underlyings[0]!.toLowerCase(), 5n * 10n ** 18n);
  state.sim.distribute = 10n ** 6n;
  await stepFlywheel(ctx, USDG);

  const calls = sent(state, 'distribute');
  const assets = calls.map((c) => String(c.args[0]).toLowerCase());
  assert.ok(assets.includes(USDG.toLowerCase()), 'USDG is always asked: its pending amount is a subtraction, not a balance');
  assert.ok(assets.includes(underlyings[0]!.toLowerCase()), 'the asset with a balance');
  assert.ok(!assets.includes(underlyings[1]!.toLowerCase()), 'an asset with no balance is not asked');
  for (const c of calls) assert.equal(c.gas, GAS.distribute, 'fixed gas: an estimate would find the limit where the inner swap OOGs and the catch fires');
});

test('a zero return sends nothing: every splitter-side skip is a no-op, and none of them is recomputed here', async () => {
  const { ctx, state, underlyings } = harness();
  for (const u of underlyings) state.balances.set(u.toLowerCase(), 10n ** 18n);
  state.owed = 10n ** 9n;
  // NO_ROUTE, NO_SPOT, BELOW_FLOOR and DUST all look like this from off chain, and so does a claim of 0.
  state.sim.distribute = 0n;
  state.sim.claimOrderBookFees = 0n;
  const report = await stepFlywheel(ctx, USDG);
  assert.deepEqual(state.sends, [], 'nothing was broadcast');
  assert.ok(report.actions.every((a) => a.status === 'no-op'), 'every call was judged not worth sending');
});

test('one asset whose read fails does not cost the others their distribution', async () => {
  const { ctx, state, underlyings } = harness();
  state.balances.set(underlyings[0]!.toLowerCase(), 10n ** 18n);
  state.balances.set(underlyings[1]!.toLowerCase(), 10n ** 18n);
  state.failBalanceOf.add(underlyings[0]!.toLowerCase());
  state.sim.distribute = 10n ** 6n;
  await stepFlywheel(ctx, USDG);
  const assets = sent(state, 'distribute').map((c) => String(c.args[0]).toLowerCase());
  assert.ok(!assets.includes(underlyings[0]!.toLowerCase()), 'the unreadable asset reads as 0 and is skipped');
  assert.ok(assets.includes(underlyings[1]!.toLowerCase()), 'the next asset still runs');
});

/*//////////////////////////////////////////////////////////////
                            BUYBACK
//////////////////////////////////////////////////////////////*/

test('buybackBalance 0: no probe and no send', async () => {
  const { ctx, state } = harness();
  state.buybackBalance = 0n;
  const report = await stepFlywheel(ctx, USDG);
  assert.deepEqual(state.probes, [], 'an empty reserve is not worth a simulation');
  assert.equal(sent(state, 'buyback').length, 0);
  assert.equal(report.notes.buyback, 'skipped: empty reserve');
});

test('buybackBalance 0 stays quiet: empty reserve, and no unreadable-reserve page', async () => {
  const { ctx, state, alerts } = harness();
  state.buybackBalance = 0n;
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(report.notes.buyback, 'skipped: empty reserve');
  assert.equal(report.notes.buybackBalance, '0');
  assert.equal(alerts.filter((a) => a.dedupeKey === 'flywheel:buyback-reserve-unreadable').length, 0);
});

test('a FAILED buybackBalance read is not an empty reserve: distinct note, a page, no probe, and the tick completes', async () => {
  // THE PROTECTED FACT (T-289). The read fails inside the multicall - status 'failure', which is what
  // allowFailure: true produces - rather than throwing, so the try/catch around readMany never sees it.
  // Against the old `okResult(...) ?? 0n` this step recorded buybackBalance "0" and "skipped: empty reserve".
  const { ctx, state, alerts } = harness();
  state.buybackBalance = 50n * 10n ** 6n; // there IS a reserve; the keeper just cannot see it
  state.owed = 7n * 10n ** 6n;
  state.sim.claimOrderBookFees = 7n * 10n ** 6n;
  state.failViews.add('buybackBalance');
  const report = await stepFlywheel(ctx, USDG);
  assert.notEqual(report.notes.buyback, 'skipped: empty reserve', 'an unread reserve must not be recorded as an empty one');
  assert.equal(report.notes.buyback, 'skipped: reserve unreadable');
  assert.equal(report.notes.buybackBalance, null);
  assert.match(String(report.notes.buybackReadError), /buybackBalance/);
  assert.deepEqual(state.probes, [], 'an unknown balance cannot size a buy, so it is not probed');
  assert.equal(sent(state, 'buyback').length, 0);
  const paged = alerts.filter((a) => a.dedupeKey === 'flywheel:buyback-reserve-unreadable');
  assert.equal(paged.length, 1);
  assert.equal(paged[0]!.kind, 'v2_error');
  // The rest of the tick still ran: the claim for owed > 0 was sent despite the failed read.
  assert.equal(sent(state, 'claimOrderBookFees').length, 1);
});

test('inside the cooldown: no probe, no send, and the step says when it is ready', async () => {
  const { ctx, state } = harness();
  state.buybackBalance = 50n * 10n ** 6n;
  state.lastBuybackAt = BigInt(NOW - 60);
  const report = await stepFlywheel(ctx, USDG);
  assert.deepEqual(state.probes, [], 'a probe inside the window can only answer CooldownActive');
  assert.equal(sent(state, 'buyback').length, 0);
  assert.equal(report.notes.readyAt, NOW - 60 + BUYBACK_COOLDOWN);
  assert.equal(BUYBACK_COOLDOWN, 300, 'V2Constants.sol:63 BUYBACK_COOLDOWN = 5 minutes');
});

test('lastBuybackAt 0 means NEVER, not 1970: the first buyback is not held back', async () => {
  const { ctx, state } = harness();
  state.buybackBalance = 50n * 10n ** 6n;
  state.lastBuybackAt = 0n;
  state.probe = { usdgIn: 50n * 10n ** 6n, burned: 1_000n * 10n ** 18n };
  state.sim.buyback = [50n * 10n ** 6n, 1_000n * 10n ** 18n];
  await stepFlywheel(ctx, USDG);
  assert.equal(sent(state, 'buyback').length, 1, 'a splitter that has never bought back is ready now');
});

test('THE FLOOR: minTokenOut is the probe tightened by the tolerance, and the probe argument never reaches the sender', async () => {
  // THE ONE GUARD IN THIS STEP THAT NOTHING DOWNSTREAM WOULD CATCH. A buyback sent with the probe's `1`
  // confirms, burns, and emits exactly the events a correct one does — it is simply unbounded, and the
  // difference only ever shows up as a worse fill. Deleting the tightening line must turn this test red.
  const { ctx, state } = harness({ toleranceBps: 50 });
  state.buybackBalance = 50n * 10n ** 6n;
  state.lastBuybackAt = BigInt(NOW - BUYBACK_COOLDOWN - 1);
  const burned = 1_000n * 10n ** 18n;
  state.probe = { usdgIn: 50n * 10n ** 6n, burned };
  state.sim.buyback = [50n * 10n ** 6n, burned];

  const report = await stepFlywheel(ctx, USDG);

  assert.equal(state.probes.length, 1, 'exactly one probe');
  assert.deepEqual(state.probes[0]!.args, [1n], 'the probe asks with 1: 0 would revert BadPrice');

  const calls = sent(state, 'buyback');
  assert.equal(calls.length, 1);
  const argument = calls[0]!.args[0] as bigint;
  assert.equal(argument, (burned * (BPS - 50n)) / BPS, 'burned x (1 - tolerance)');
  assert.notEqual(argument, 1n, 'the probe value must never be what is sent');
  assert.ok(argument > 1n && argument < burned, 'strictly between the probe and the quote');
  assert.equal(report.notes.minTokenOut, argument.toString());
  assert.equal(calls[0]!.gas, GAS.buyback);
});

test('the cap needs no read: a simulated spend below the reserve still sends, and the reserve drains next interval', async () => {
  // FeeSplitter.buyback spends min(reserve, buybackCap) and does NOT revert on the cap, so the keeper pins no
  // cap of its own. The simulated usdgIn is simply smaller than the reserve, and that is not a reason to stop.
  const { ctx, state, store } = harness();
  state.buybackBalance = 500n * 10n ** 6n;
  state.lastBuybackAt = 0n;
  state.probe = { usdgIn: 50n * 10n ** 6n, burned: 900n * 10n ** 18n };
  state.sim.buyback = [50n * 10n ** 6n, 900n * 10n ** 18n];
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(sent(state, 'buyback').length, 1);
  assert.equal(report.notes.buybackBalance, (500n * 10n ** 6n).toString());
  assert.deepEqual(report.notes.probe, { usdgIn: (50n * 10n ** 6n).toString(), burned: (900n * 10n ** 18n).toString() });
  assert.equal(store.getMeta(flywheelMetaKey), String(NOW), 'the pass is recorded, so the next one is one interval away');
});

test('a zero quote sends nothing rather than a floor of 0', async () => {
  const { ctx, state } = harness();
  state.buybackBalance = 50n * 10n ** 6n;
  state.lastBuybackAt = 0n;
  state.probe = { usdgIn: 0n, burned: 0n };
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(sent(state, 'buyback').length, 0);
  assert.equal(report.notes.buyback, 'skipped: the route quotes nothing');
});

/*//////////////////////////////////////////////////////////////
                       DRY RUNS AND REFUSALS
//////////////////////////////////////////////////////////////*/

test('the process-wide dry run sends nothing at all', async () => {
  const { ctx, state, store } = harness({ dryRun: true });
  state.owed = 10n ** 9n;
  state.buybackBalance = 50n * 10n ** 6n;
  state.lastBuybackAt = 0n;
  state.probe = { usdgIn: 50n * 10n ** 6n, burned: 900n * 10n ** 18n };
  state.sim.claimOrderBookFees = 10n ** 9n;
  state.sim.buyback = [50n * 10n ** 6n, 900n * 10n ** 18n];
  await stepFlywheel(ctx, USDG);
  assert.deepEqual(state.sends, [], 'a dry run broadcasts nothing');
  assert.equal(store.getMeta(flywheelMetaKey), null, 'and records no pass, so a later live tick is not skipped');
});

test('CRANKER_BUYBACK_DRY_RUN probes and reports but never sends the buyback, while the rest stays live', async () => {
  const { ctx, state } = harness({ buybackDryRun: true });
  state.owed = 10n ** 9n;
  state.sim.claimOrderBookFees = 10n ** 9n;
  state.buybackBalance = 50n * 10n ** 6n;
  state.lastBuybackAt = 0n;
  state.probe = { usdgIn: 50n * 10n ** 6n, burned: 900n * 10n ** 18n };
  state.sim.buyback = [50n * 10n ** 6n, 900n * 10n ** 18n];

  const report = await stepFlywheel(ctx, USDG);
  assert.equal(state.probes.length, 1, 'it still probes: the point is to watch the route');
  assert.equal(sent(state, 'buyback').length, 0, 'and never spends');
  assert.equal(sent(state, 'claimOrderBookFees').length, 1, 'this is NOT the process dry run: the rest is live');
  assert.equal(report.notes.buyback, 'dry run: probed, not sent');
  assert.ok(report.actions.some((a) => a.kind === 'buyback' && a.status === 'not-sent'));
});

test('a paused splitter stops the remaining calls and raises one alert; the claim is not gated on it', async () => {
  const { ctx, state, alerts, underlyings } = harness();
  state.owed = 10n ** 9n;
  state.sim.claimOrderBookFees = 10n ** 9n;
  for (const u of underlyings) state.balances.set(u.toLowerCase(), 10n ** 18n);
  state.sim.distribute = 'TradingPaused';
  state.buybackBalance = 50n * 10n ** 6n;

  const report = await stepFlywheel(ctx, USDG);
  assert.equal(sent(state, 'claimOrderBookFees').length, 1, 'claimOrderBookFees is never paused (IFeeSplitter.sol:92-93)');
  assert.equal(report.notes.paused, true);
  assert.equal(state.probes.length, 0, 'the buyback is not even probed once the pause is known');
  const paged = alerts.filter((a) => a.dedupeKey === 'flywheel:paused');
  assert.equal(paged.length, 1, 'one alert, not one per asset');
  assert.equal(paged[0]!.kind, 'v2_error');
});

test('the probe reverts are encoded from the published ABI, so this suite decodes the same bytes production does', () => {
  // If either fragment ever leaves ops/abis/v2, this fails here rather than turning the two classification
  // tests below into silent passes down the `revert === null` branch.
  for (const name of ['NotAuthorized', 'TradingPaused'] as const) {
    const data = encodeErrorResult({ abi: feeSplitterAbi, errorName: name });
    assert.match(data, /^0x[0-9a-f]{8}$/, `${name} encodes to a 4-byte selector`);
  }
});

test('NotAuthorized from the buyback probe raises v2_cranker_no_buyback_role and sends nothing', async () => {
  const { ctx, state, alerts } = harness();
  state.buybackBalance = 50n * 10n ** 6n;
  state.lastBuybackAt = 0n;
  state.probe = { revert: 'NotAuthorized' };
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(sent(state, 'buyback').length, 0);
  assert.equal(report.notes.buyback, 'refused: no BUYBACK role');
  const paged = alerts.filter((a) => a.kind === 'v2_cranker_no_buyback_role');
  assert.equal(paged.length, 1);
  assert.equal(paged[0]!.data.signer, ctx.sender.account);
});
