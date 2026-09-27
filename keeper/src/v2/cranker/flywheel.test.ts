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
import { BUYBACK_DEADLINE_S, BPS, FLYWHEEL_MAX_PIECES, FLYWHEEL_MIN_PIECE_USDG, FLYWHEEL_PIECE_PROBES, FLYWHEEL_PIECE_STRIDE, GAS } from './constants.js';

/** The splitter's cooldown as the fake chain answers it by default (the launch value, V2Constants BUYBACK_COOLDOWN). */
const COOLDOWN = 300;
import { CrankAlerts, type CrankOutcome, type CrankSender, type FixedGasCall } from './effects.js';
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

/**
 * The only buyback entry point that executes from the v9 FeeSplitter. The fake splitter below refuses the
 * frozen `buyback(uint256)` exactly as the contract does, with `BuybackDeadlineRequired`, so a step that went back to
 * the old call would send nothing and every test that expects a buyback would go red, not quietly pass.
 */
const BUY = 'buybackWithDeadline';
const OLD_BUYBACK = 'buyback';

interface Options {
  enabled?: boolean;
  splitter?: Address | null;
  dryRun?: boolean;
  buybackDryRun?: boolean;
  toleranceBps?: number;
  /** CRANKER_MAX_TX_PER_STEP; the config default when absent. */
  maxTxPerStep?: number;
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
    ...(options.maxTxPerStep === undefined ? {} : { CRANKER_MAX_TX_PER_STEP: String(options.maxTxPerStep) }),
  }) as CrankerConfig;

  const state = {
    now: NOW,
    /** Seconds the head moves on at each getBlock read, to model claim and distribute confirming before the buyback. */
    headAdvanceS: 0,
    /** getBlock reads so far. */
    headReads: 0,
    block: 65_000_000n,
    /** OrderBook.owed(splitter). */
    owed: 0n,
    /** ERC-20 balances of the splitter, by asset. */
    balances: new Map<string, bigint>(),
    buybackBalance: 0n,
    lastBuybackAt: 0n,
    /** FeeSplitter.buybackCooldown(), ADMIN-settable. */
    buybackCooldown: COOLDOWN,
    /** Assets whose balanceOf read fails, to prove per-asset isolation. */
    failBalanceOf: new Set<string>(),
    /** View names whose multicall read FAILS the way allowFailure: true reports it (status 'failure', no throw). */
    failViews: new Set<string>(),
    /** The buyback probe's answer, or a revert name. */
    probe: { usdgIn: 0n, burned: 0n } as { usdgIn: bigint; burned: bigint } | { revert: FeeSplitterErrorName; args?: readonly unknown[] },
    /** What each write's simulation returns; a string is a revert name, a function is asked with the call's args. */
    sim: {} as Record<string, unknown>,
    sends: [] as Array<{ fn: string; args: readonly unknown[]; gas: bigint }>,
    /** False models a pool that moved before inclusion: the piece confirms, the splitter skips inside it. */
    piecesFillOnChain: true,
    /** The pieces' simulations (distributeAmount through simulateContract), apart from the buyback probe's. */
    pieceProbes: [] as Array<readonly unknown[]>,
    /** The distributeAmount send (1-based) at which the sender throws, as a failed RPC would. */
    pieceSendThrowsAt: null as number | null,
    pieceSendAttempts: 0,
    /** Attempts to send the frozen buyback(uint256); the fake refuses them, and no test expects one. */
    oldBuybackSends: 0,
    probes: [] as Array<{ fn: string; args: readonly unknown[] }>,
    /** The block a confirmed send lands in; the head block when null. */
    confirmBlock: null as bigint | null,
    /** buybackBalance() by the block it is read at, for a counter a send changed; `buybackBalance` when null. */
    buybackBalanceAt: null as ((block: bigint | undefined) => bigint) | null,
    /** Every multicall, by the views it read and the block it read them at. */
    multicalls: [] as Array<{ fns: string[]; blockNumber: bigint | undefined }>,
  };

  const views: Record<string, (args: readonly unknown[]) => unknown> = {
    owed: () => state.owed,
    buybackBalance: () => state.buybackBalance,
    lastBuybackAt: () => state.lastBuybackAt,
    buybackCooldown: () => state.buybackCooldown,
    balanceOf: ([who]) => {
      void who;
      return 0n; // replaced per-call below; multicall routes by address, not by name
    },
  };

  const client = {
    getBlock: async () => ({ number: state.block, timestamp: BigInt(state.now + state.headAdvanceS * state.headReads++) }),
    getBlockNumber: async () => state.block,
    multicall: async ({ contracts, blockNumber }: { contracts: Array<{ address: Address; functionName: string; args?: readonly unknown[] }>; blockNumber?: bigint }) => {
      state.multicalls.push({ fns: contracts.map((c) => c.functionName), blockNumber });
      return contracts.map((c) => {
        if (c.functionName === 'balanceOf') {
          const key = c.address.toLowerCase();
          if (state.failBalanceOf.has(key)) return { status: 'failure', error: new Error('rpc said no') };
          return { status: 'success', result: state.balances.get(key) ?? 0n };
        }
        if (state.failViews.has(c.functionName)) return { status: 'failure', error: new Error(`execution reverted: ${c.functionName}`) };
        if (c.functionName === 'buybackBalance' && state.buybackBalanceAt !== null) return { status: 'success', result: state.buybackBalanceAt(blockNumber) };
        const handler = views[c.functionName];
        if (handler === undefined) return { status: 'failure', error: new Error(`no view ${c.functionName}`) };
        return { status: 'success', result: handler(c.args ?? []) };
      });
    },
    readContract: async ({ address, functionName, args = [] }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
      // The pieces re-read the splitter's balance of the asset they sold, by the asset's address.
      if (functionName === 'balanceOf') return state.balances.get(address.toLowerCase()) ?? 0n;
      const handler = views[functionName];
      if (handler === undefined) throw new Error(`no readContract ${functionName}`);
      return handler(args);
    },
    simulateContract: async ({ functionName, args = [] }: { functionName: string; args?: readonly unknown[] }) => {
      // A REAL viem revert, encoded from the generated ABI and decoded by the same revertDetail() the step
      // uses in production. A hand-rolled Error would take the `revert === null` branch and this test would
      // pass while proving nothing about the classification it exists to check.
      const revert = (errorName: FeeSplitterErrorName, args?: readonly unknown[]) =>
        new ContractFunctionRevertedError({ abi: feeSplitterAbi, data: encodeErrorResult({ abi: feeSplitterAbi, errorName, ...(args === undefined ? {} : { args }) } as never), functionName });
      // The pieces' search simulates distributeAmount directly; it answers what the sender's simulation would.
      if (functionName === 'distributeAmount') {
        state.pieceProbes.push(args);
        const answer = state.sim.distributeAmount;
        const simulated = typeof answer === 'function' ? (answer as (a: readonly unknown[]) => unknown)(args) : (answer ?? 0n);
        if (typeof simulated === 'string') throw revert(simulated as FeeSplitterErrorName);
        return { result: simulated };
      }
      state.probes.push({ fn: functionName, args });
      // The v9 splitter: the frozen entry point always refuses (FeeSplitter.sol buyback).
      if (functionName === OLD_BUYBACK) throw revert('BuybackDeadlineRequired');
      if ('revert' in state.probe) throw revert(state.probe.revert, state.probe.args);
      return { result: [state.probe.usdgIn, state.probe.burned] };
    },
  };

  const sender: CrankSender = {
    dryRun: options.dryRun === true,
    account: '0x000000000000000000000000000000000000beef',
    async execute(call: FixedGasCall, opts): Promise<CrankOutcome> {
      const args = call.args as readonly unknown[];
      if (opts.isAdvanced !== undefined && (await opts.isAdvanced())) return { status: 'already-advanced' };
      if (call.functionName === OLD_BUYBACK) {
        state.oldBuybackSends += 1;
        return { status: 'simulation-reverted', revert: 'BuybackDeadlineRequired', error: 'execution reverted' };
      }
      if (call.functionName === 'distributeAmount' && ++state.pieceSendAttempts === state.pieceSendThrowsAt) throw new Error('rpc went away');
      const answer = state.sim[call.functionName];
      const simulated = typeof answer === 'function' ? (answer as (a: readonly unknown[]) => unknown)(args) : (answer ?? 0n);
      if (typeof simulated === 'string') return { status: 'simulation-reverted', revert: simulated, error: 'execution reverted' };
      if (opts.worthSending !== undefined && !opts.worthSending(simulated)) return { status: 'no-op', result: simulated };
      // As drySender (effects.ts): a simulation worth sending is `would-send`, and nothing is signed.
      if (sender.dryRun) return { status: 'would-send', result: simulated };
      state.sends.push({ fn: call.functionName, args, gas: call.gas });
      // A piece that sold has left the splitter, so the next simulation sees the smaller balance.
      if (call.functionName === 'distributeAmount' && state.piecesFillOnChain) {
        const key = String(args[0]).toLowerCase();
        state.balances.set(key, (state.balances.get(key) ?? 0n) - (args[1] as bigint));
      }
      return { status: 'confirmed', hash: `0x${'ab'.repeat(32)}`, nonce: 1, blockNumber: state.confirmBlock ?? state.block, gasUsed: 1n, result: simulated };
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

test('off WITH a splitter configured pages v2_cranker_flywheel_disabled, still sends nothing, and pages again next tick', async () => {
  // Launch-day fees that are never claimed, distributed or bought back with used to be this same silent skip.
  const { ctx, state, alerts } = harness({ enabled: false });
  state.owed = 10n ** 9n;
  state.buybackBalance = 10n ** 9n;
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(report.notes.skipped, 'disabled', 'the gate is unchanged: nothing is sent while the flag is off');
  assert.deepEqual(state.sends, []);
  assert.deepEqual(state.probes, []);
  const paged = alerts.filter((a) => a.kind === 'v2_cranker_flywheel_disabled');
  assert.equal(paged.length, 1, 'one page for the tick');
  assert.equal(paged[0]!.data.splitter, SPLITTER);
  assert.equal(paged[0]!.dedupeKey, SPLITTER.toLowerCase());
  // Not once-ever: the condition lasts until somebody turns the flag on, so each tick raises it again and the
  // alerter's cooldown (not this step) spaces the pages.
  await stepFlywheel(ctx, USDG);
  assert.equal(alerts.filter((a) => a.kind === 'v2_cranker_flywheel_disabled').length, 2);
});

test('off with NO splitter (before the flywheel is deployed) stays quiet', async () => {
  const { ctx, state, alerts } = harness({ enabled: false, splitter: null });
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(report.notes.skipped, 'disabled');
  assert.deepEqual(state.sends, []);
  assert.deepEqual(alerts.filter((a) => a.kind === 'v2_cranker_flywheel_disabled'), []);
});

test('on with a splitter raises no disabled page', async () => {
  const { ctx, alerts } = harness();
  await stepFlywheel(ctx, USDG);
  assert.deepEqual(alerts.filter((a) => a.kind === 'v2_cranker_flywheel_disabled'), []);
});

test('no splitter address: the step skips and the rest of the cranker is unaffected', async () => {
  // ops/v2/env/cranker.env ("With V2_FEE_SPLITTER empty the cranker runs every other step") promises the operator
  // exactly this, and that comment shipped before the code.
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

test('an unread splitter balance is not 0: a Stock Token is not distributed and the notes name it; USDG is still asked, with its balance shown unread', async () => {
  const { ctx, state, underlyings } = harness();
  const stock = underlyings[0]!;
  state.balances.set(stock.toLowerCase(), 10n ** 18n);
  state.balances.set(USDG.toLowerCase(), 5n * 10n ** 6n);
  state.failBalanceOf.add(stock.toLowerCase());
  state.failBalanceOf.add(USDG.toLowerCase());
  state.sim.distribute = 10n ** 6n;
  const report = await stepFlywheel(ctx, USDG);
  const entries = report.notes.distributed as Array<{ asset: string; balance: string | null; balanceReadError?: string; status?: string }>;
  const of = (a: string) => entries.find((e) => e.asset.toLowerCase() === a.toLowerCase());
  assert.deepEqual(
    { balance: of(stock)?.balance, status: of(stock)?.status, error: of(stock)?.balanceReadError },
    { balance: null, status: 'not-sent', error: 'rpc said no' },
    'the unread Stock Token is in the notes as unread, not silently dropped',
  );
  assert.ok(!sent(state, 'distribute').some((c) => String(c.args[0]).toLowerCase() === stock.toLowerCase()), 'and it is not distributed on a guess');
  assert.equal(of(USDG)?.balance, null, 'USDG shows an unread balance, not a made-up "0"');
  assert.equal(of(USDG)?.balanceReadError, 'rpc said no');
  assert.ok(sent(state, 'distribute').some((c) => String(c.args[0]).toLowerCase() === USDG.toLowerCase()), 'USDG is asked whatever its balance, as before');
  // Control: read, the same balances show as numbers.
  const read = harness();
  read.state.balances.set(USDG.toLowerCase(), 5n * 10n ** 6n);
  read.state.sim.distribute = 10n ** 6n;
  const r = await stepFlywheel(read.ctx, USDG);
  assert.equal((r.notes.distributed as Array<{ asset: string; balance: string | null }>).find((e) => e.asset.toLowerCase() === USDG.toLowerCase())?.balance, (5n * 10n ** 6n).toString());
});

/*//////////////////////////////////////////////////////////////
              A WHOLE BALANCE THAT MISSES THE FLOOR
//////////////////////////////////////////////////////////////*/

const SHARE = 10n ** 18n;
/** 100 USDG a share: every piece these tests sell clears FLYWHEEL_MIN_PIECE_USDG by far. */
const PRICE = 100n * 10n ** 6n;

/**
 * A fake splitter whose route fills at most `fills` base units of `asset` within the floor. `distribute` of a larger
 * whole balance and `distributeAmount` of a larger piece return 0, which is the splitter's BELOW_FLOOR skip as it looks
 * from off chain; a sale at or below `fills` returns `usdgPerShare` USDG base units per 1e18 base units. `fills = 0`
 * is a skip that does not depend on the size (NO_SPOT, NO_ROUTE, HAIRCUT): every piece returns 0. `distributeAmount`
 * answers in the contract's order (FeeSplitter.sol distributeAmount, then `_distribute`): 0 reverts BadUnits, USDG
 * reverts UnsupportedAsset, nothing held returns 0 (EMPTY), more than is held reverts BadUnits.
 */
function floorFillsAtMost(state: ReturnType<typeof harness>['state'], asset: Address, fills: bigint, usdgPerShare: bigint) {
  const key = asset.toLowerCase();
  const held = () => state.balances.get(key) ?? 0n;
  const sale = (amount: bigint) => (amount > fills ? 0n : (amount * usdgPerShare) / SHARE);
  state.sim.distribute = ([a]: readonly unknown[]) => (String(a).toLowerCase() === key ? sale(held()) : 0n);
  state.sim.distributeAmount = ([a, amount]: readonly unknown[]) => {
    const n = amount as bigint;
    if (n === 0n) return 'BadUnits';
    if (String(a).toLowerCase() === USDG.toLowerCase()) return 'UnsupportedAsset';
    if (String(a).toLowerCase() !== key) return 0n;
    if (held() === 0n) return 0n;
    if (n > held()) return 'BadUnits';
    return sale(n);
  };
}

/** The largest `balance >> k` (k >= 1) a route that fills at most `fills` takes: what the search must find. */
function largestFit(balance: bigint, fills: bigint): bigint {
  let k = 1n;
  while (balance >> k > fills) k += 1n;
  return balance >> k;
}

type Pieces = {
  sold: string | null;
  remaining: string | null;
  sent: string;
  simulatedUsdgIn: string;
  stop: string;
  probes: Array<Record<string, string>>;
  each: Array<Record<string, string>>;
};
type DistributedEntry = { asset: string; balance: string; status: string; pieces?: Pieces };
const entryOf = (notes: Record<string, unknown>, asset: Address) =>
  (notes.distributed as DistributedEntry[]).find((d) => d.asset.toLowerCase() === asset.toLowerCase());
const piecesOf = (notes: Record<string, unknown>, asset: Address): Pieces => {
  const pieces = entryOf(notes, asset)?.pieces;
  assert.ok(pieces !== undefined, 'the asset\'s distribute entry carries its pieces');
  return pieces;
};
const pieceSends = (state: ReturnType<typeof harness>['state'], from = 0) => state.sends.slice(from).filter((x) => x.fn === 'distributeAmount');

test('a stock fee whose whole balance misses the floor is sold in pieces the route fills, and the step says what sold and what is left', async () => {
  // THE PROTECTED FACT. `distribute(asset)` always offers the WHOLE balance. A balance larger than the route can fill
  // within the floor skipped on every pass, for good: the old step sent nothing, and the fees sat in the splitter.
  const { ctx, state, underlyings } = harness();
  const nvda = underlyings[0]!;
  state.balances.set(nvda.toLowerCase(), 10n * SHARE);
  floorFillsAtMost(state, nvda, 3n * SHARE, PRICE);

  const report = await stepFlywheel(ctx, USDG);

  assert.equal(sent(state, 'distribute').filter((c) => String(c.args[0]).toLowerCase() === nvda.toLowerCase()).length, 0, 'the whole balance is not sent: the splitter would skip it');
  const pieces = pieceSends(state);
  assert.ok(pieces.length >= 2, `sold in pieces, not nothing (got ${pieces.length})`);
  for (const p of pieces) {
    assert.equal(String(p.args[0]).toLowerCase(), nvda.toLowerCase());
    assert.ok((p.args[1] as bigint) <= 3n * SHARE, 'every piece sent is one the route fills: the floor is the splitter\'s, and it is never argued with');
    assert.equal(p.gas, GAS.distribute, 'fixed gas, never estimated');
  }
  // The largest power-of-two fraction of 10 shares at or under 3 is 2.5, sold until nothing is left.
  assert.deepEqual(pieces.map((p) => p.args[1]), [25n, 25n, 25n, 25n].map((x) => (x * SHARE) / 10n));
  assert.equal(state.balances.get(nvda.toLowerCase()), 0n, 'the whole fee left the splitter');

  const entry = entryOf(report.notes, nvda)!;
  assert.equal(entry.status, 'no-op', 'the whole-balance distribute was still asked first, and declined');
  const p = piecesOf(report.notes, nvda);
  assert.equal(p.sold, (10n * SHARE).toString(), 'what sold: how far the splitter\'s balance fell');
  assert.equal(p.remaining, '0', 'what is left, read from the splitter after the pieces');
  assert.equal(p.sent, (10n * SHARE).toString());
  assert.equal(p.simulatedUsdgIn, (1_000n * 10n ** 6n).toString(), 'and what the simulations said it would fetch');
  assert.equal(p.stop, 'all sent');
  assert.deepEqual(p.each.map((e) => e.status), ['confirmed', 'confirmed', 'confirmed', 'confirmed']);
  assert.ok(p.probes.length <= FLYWHEEL_PIECE_PROBES);
});

test('a balance hundreds of times what the route fills still sells, pass after pass (review 1 probe: 1000 shares, 1 share fills)', async () => {
  // REVIEW 1. Every pass used to restart at balance / 2 and give up after 8 halvings, so a balance more than 2^8 times
  // what the route fills never sold: 5 passes, 0 sends, 1000 shares still in the splitter.
  const { ctx, state, underlyings } = harness();
  const nvda = underlyings[0]!;
  state.balances.set(nvda.toLowerCase(), 1_000n * SHARE);
  floorFillsAtMost(state, nvda, SHARE, PRICE);

  for (let pass = 0; pass < 5; pass++) {
    state.now = NOW + pass * (ctx.config.tuning.flywheelIntervalS + 1);
    const before = state.balances.get(nvda.toLowerCase())!;
    const from = state.sends.length;
    const report = await stepFlywheel(ctx, USDG);
    assert.notEqual(report.notes.skipped, 'interval', `pass ${pass} ran`);
    const piece = largestFit(before, SHARE);
    assert.deepEqual(pieceSends(state, from).map((x) => x.args[1]), Array(FLYWHEEL_MAX_PIECES).fill(piece), `pass ${pass} sends its full quota of the largest piece the route fills`);
    const after = state.balances.get(nvda.toLowerCase())!;
    assert.equal(after, before - BigInt(FLYWHEEL_MAX_PIECES) * piece, `pass ${pass}: the balance falls by what was sold`);
    assert.equal(piecesOf(report.notes, nvda).remaining, after.toString());
    assert.ok(piecesOf(report.notes, nvda).probes.length <= FLYWHEEL_PIECE_PROBES);
  }
});

test('a balance 2^20 times what the route fills sells in the first pass', async () => {
  const { ctx, state, underlyings } = harness();
  const nvda = underlyings[0]!;
  const whole = 1_000_000n * SHARE;
  state.balances.set(nvda.toLowerCase(), whole);
  floorFillsAtMost(state, nvda, SHARE, PRICE);

  const report = await stepFlywheel(ctx, USDG);

  const piece = largestFit(whole, SHARE);
  assert.deepEqual(pieceSends(state).map((x) => x.args[1]), Array(FLYWHEEL_MAX_PIECES).fill(piece));
  assert.equal(state.balances.get(nvda.toLowerCase()), whole - BigInt(FLYWHEEL_MAX_PIECES) * piece);
  assert.ok(piecesOf(report.notes, nvda).probes.length <= FLYWHEEL_PIECE_PROBES);
});

test('a pass whose spot was stale (every size refused) leaves nothing behind: the next pass with a good spot sells properly (review 2 probes F/G)', async () => {
  // REVIEW 2. A 30-minute spot on an hourly flywheel: NO_SPOT and good passes alternate. NO_SPOT refuses every size,
  // and a pass that remembered where that refusal left its halving made the next good pass start at a crumb:
  // 1000 shares, route fills 100 -> 0 sends in 10 passes; 5000 shares -> 24 sends of 0.038 share.
  for (const shares of [1_000n, 5_000n]) {
    const { ctx, state, underlyings } = harness();
    const nvda = underlyings[0]!;
    state.balances.set(nvda.toLowerCase(), shares * SHARE);
    for (let pass = 0; pass < 6; pass++) {
      state.now = NOW + pass * (ctx.config.tuning.flywheelIntervalS + 1);
      const spotOk = pass % 2 === 1;
      floorFillsAtMost(state, nvda, spotOk ? 100n * SHARE : 0n, PRICE);
      const before = state.balances.get(nvda.toLowerCase())!;
      if (before === 0n) break; // sold out: the step no longer asks about the asset at all
      const from = state.sends.length;
      const report = await stepFlywheel(ctx, USDG);
      const p = piecesOf(report.notes, nvda);
      if (!spotOk) {
        assert.deepEqual(pieceSends(state, from), [], `${shares}/${pass}: a stale spot sells nothing`);
        assert.equal(p.stop, 'no size sells');
        continue;
      }
      const piece = largestFit(before, 100n * SHARE);
      const quota = before / piece < BigInt(FLYWHEEL_MAX_PIECES) ? before / piece : BigInt(FLYWHEEL_MAX_PIECES);
      assert.equal(pieceSends(state, from).length, Number(quota), `${shares}/${pass}: a good spot sells its quota`);
      for (const x of pieceSends(state, from)) assert.equal(x.args[1], piece, `${shares}/${pass}: of the largest piece the route fills, not a crumb`);
      assert.equal(state.balances.get(nvda.toLowerCase()), before - quota * piece);
    }
    if (shares === 1_000n) assert.equal(state.balances.get(nvda.toLowerCase()), 0n, '1000 shares are gone in two good passes (8 x 62.5 each)');
  }
});

test('one stale-spot pass, then a route that fills 10,000 of 100,000 shares: the next pass sells 50,000 (review 2 case c)', async () => {
  const { ctx, state, underlyings } = harness();
  const nvda = underlyings[0]!;
  state.balances.set(nvda.toLowerCase(), 100_000n * SHARE);
  floorFillsAtMost(state, nvda, 0n, PRICE);
  await stepFlywheel(ctx, USDG);
  assert.deepEqual(pieceSends(state), []);

  state.now = NOW + ctx.config.tuning.flywheelIntervalS + 1;
  floorFillsAtMost(state, nvda, 10_000n * SHARE, PRICE);
  await stepFlywheel(ctx, USDG);
  assert.deepEqual(pieceSends(state).map((x) => x.args[1]), Array(FLYWHEEL_MAX_PIECES).fill(6_250n * SHARE));
  assert.equal(state.balances.get(nvda.toLowerCase()), 50_000n * SHARE);
});

test('a size-independent refusal costs a stride walk of simulations, no send, no action per simulation, and USDG is never offered', async () => {
  // NO_ROUTE, NO_SPOT and HAIRCUT do not depend on the amount, and a piece of a DUST balance is DUST: none of them is
  // told apart here, and the search pays for them in simulations only, never a transaction.
  const { ctx, state, underlyings } = harness();
  const nvda = underlyings[0]!;
  const whole = 1_000n * SHARE;
  state.balances.set(nvda.toLowerCase(), whole);
  // A USDG balance too: `distributeAmount` refuses USDG (UnsupportedAsset), so offering it a piece would be on the record.
  state.balances.set(USDG.toLowerCase(), 100n * 10n ** 6n);
  floorFillsAtMost(state, nvda, 0n, PRICE);

  const report = await stepFlywheel(ctx, USDG);

  assert.deepEqual(state.sends.filter((x) => x.fn === 'distribute' || x.fn === 'distributeAmount'), [], 'nothing was broadcast');
  const p = piecesOf(report.notes, nvda);
  const walk: bigint[] = [];
  for (let k = 1n; whole >> k > 0n; k += BigInt(FLYWHEEL_PIECE_STRIDE)) walk.push(whole >> k);
  assert.deepEqual(p.probes.map((e) => BigInt(e.assetIn!)), walk, 'down from half the balance, a stride at a time, to nothing');
  assert.equal(p.stop, 'no size sells');
  assert.equal(p.remaining, whole.toString());
  assert.equal(p.sold, '0');
  assert.deepEqual(report.actions.filter((a) => a.kind === 'distributeAmount'), [], 'the simulations are not report actions: a stale-spot hour is one log line per asset');
  assert.ok(state.pieceProbes.every(([a]) => String(a).toLowerCase() === nvda.toLowerCase()), 'USDG is never offered in pieces');
});

test('a pass never makes more than FLYWHEEL_PIECE_PROBES simulations for one asset', async () => {
  const { ctx, state, underlyings } = harness();
  const nvda = underlyings[0]!;
  state.balances.set(nvda.toLowerCase(), 2n ** 200n);
  floorFillsAtMost(state, nvda, 0n, PRICE);
  const report = await stepFlywheel(ctx, USDG);
  const p = piecesOf(report.notes, nvda);
  assert.equal(p.probes.length, FLYWHEEL_PIECE_PROBES);
  assert.equal(p.stop, 'probes spent');
  assert.deepEqual(pieceSends(state), []);
});

test('when the largest piece the route fills sells for less than FLYWHEEL_MIN_PIECE_USDG, nothing is sent', async () => {
  const { ctx, state, underlyings } = harness();
  const nvda = underlyings[0]!;
  state.balances.set(nvda.toLowerCase(), 4n * SHARE);
  // 1 share fills, at 0.5 USDG: under the keeper's piece floor, and every smaller piece is smaller still.
  floorFillsAtMost(state, nvda, SHARE, FLYWHEEL_MIN_PIECE_USDG / 2n);

  const report = await stepFlywheel(ctx, USDG);

  assert.deepEqual(pieceSends(state), []);
  const p = piecesOf(report.notes, nvda);
  assert.ok(p.probes.some((e) => e.assetIn === SHARE.toString() && e.usdgIn === (FLYWHEEL_MIN_PIECE_USDG / 2n).toString()), 'the search found the 1-share piece');
  assert.equal(p.stop, 'under the piece floor');
});

test('pieces never take the step\'s last send, which stays for the buyback', async () => {
  const { ctx, state, underlyings } = harness({ maxTxPerStep: 3 });
  const nvda = underlyings[0]!;
  state.balances.set(nvda.toLowerCase(), 10n * SHARE);
  floorFillsAtMost(state, nvda, 3n * SHARE, PRICE);
  state.buybackBalance = 50n * 10n ** 6n;
  // The splitter holds the USDG it counts. With less it is a hole and the write-down distribute takes
  // the first send; this test is about the pieces and the buyback.
  state.balances.set(USDG.toLowerCase(), 50n * 10n ** 6n);
  state.lastBuybackAt = 0n;
  state.probe = { usdgIn: 50n * 10n ** 6n, burned: 900n * SHARE };
  state.sim[BUY] = [50n * 10n ** 6n, 900n * SHARE];

  const report = await stepFlywheel(ctx, USDG);

  assert.equal(pieceSends(state).length, 2, 'two of the three sends');
  assert.equal(sent(state, BUY).length, 1, 'and the third is the buyback');
  const p = piecesOf(report.notes, nvda);
  assert.equal(p.stop, 'tick budget spent');
  assert.equal(p.remaining, (5n * SHARE).toString(), 'what is left waits for the next pass');
});

test('a piece that confirms but sells nothing on chain (the pool moved) is not reported as sold', async () => {
  // A confirmed outcome carries the SIMULATION's return. If the pool moves before inclusion, the splitter's catch skips
  // BELOW_FLOOR inside a successful transaction, and the old notes said "sold out" with the whole balance still there.
  const { ctx, state, underlyings } = harness();
  const nvda = underlyings[0]!;
  state.balances.set(nvda.toLowerCase(), 10n * SHARE);
  floorFillsAtMost(state, nvda, 3n * SHARE, PRICE);
  state.piecesFillOnChain = false;

  const report = await stepFlywheel(ctx, USDG);

  assert.ok(pieceSends(state).length > 0, 'pieces went out');
  const p = piecesOf(report.notes, nvda);
  assert.equal(p.remaining, (10n * SHARE).toString(), 'remaining is the splitter\'s balance as read, not the simulations\' arithmetic');
  assert.equal(p.sold, '0', 'and nothing is reported sold');
  assert.notEqual(p.sent, '0', 'what was sent is still on the record, under its own name');
});

test('a piece that throws does not wipe out the record of the pieces sent before it', async () => {
  const { ctx, state, underlyings } = harness();
  const nvda = underlyings[0]!;
  state.balances.set(nvda.toLowerCase(), 10n * SHARE);
  floorFillsAtMost(state, nvda, 3n * SHARE, PRICE);
  state.pieceSendThrowsAt = 3;

  const report = await stepFlywheel(ctx, USDG);

  assert.equal(pieceSends(state).length, 2);
  const p = piecesOf(report.notes, nvda);
  assert.equal(p.stop, 'error');
  assert.equal(p.sold, (5n * SHARE).toString(), 'the two pieces that sold are still reported');
  assert.equal(p.remaining, (5n * SHARE).toString());
  assert.match(p.each.at(-1)!.error!, /rpc went away/);
});

test('the process dry run searches, stops at the first piece it would send, and sends nothing', async () => {
  const { ctx, state, underlyings } = harness({ dryRun: true });
  const nvda = underlyings[0]!;
  state.balances.set(nvda.toLowerCase(), 10n * SHARE);
  floorFillsAtMost(state, nvda, 3n * SHARE, PRICE);

  const report = await stepFlywheel(ctx, USDG);

  assert.deepEqual(state.sends, []);
  const p = piecesOf(report.notes, nvda);
  assert.deepEqual(p.each.map((e) => [e.assetIn, e.status]), [[((25n * SHARE) / 10n).toString(), 'would-send']], 'one would-send: the next simulation would not see its sale');
  assert.equal(p.stop, 'would-send');
  assert.equal(p.remaining, (10n * SHARE).toString());
});

/*//////////////////////////////////////////////////////////////
                            BUYBACK
//////////////////////////////////////////////////////////////*/

test('buybackBalance 0: no probe and no send', async () => {
  const { ctx, state } = harness();
  state.buybackBalance = 0n;
  const report = await stepFlywheel(ctx, USDG);
  assert.deepEqual(state.probes, [], 'an empty reserve is not worth a simulation');
  assert.equal(sent(state, BUY).length, 0);
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
  // THE PROTECTED FACT. The read fails inside the multicall - status 'failure', which is what
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
  assert.equal(sent(state, BUY).length, 0);
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
  assert.equal(sent(state, BUY).length, 0);
  assert.equal(report.notes.readyAt, NOW - 60 + COOLDOWN);
});

test('the cooldown is the splitter\'s own, read live: set to 900 s it holds the probe 900 s, not the old compiled 300', async () => {
  const { ctx, state } = harness();
  state.buybackBalance = 50n * 10n ** 6n;
  state.buybackCooldown = 900;
  state.lastBuybackAt = BigInt(NOW - 600); // past the old 300, inside the 900 the splitter now enforces
  state.probe = { usdgIn: 50n * 10n ** 6n, burned: 1_000n * 10n ** 18n };
  state.sim[BUY] = [50n * 10n ** 6n, 1_000n * 10n ** 18n];
  const report = await stepFlywheel(ctx, USDG);
  assert.deepEqual(state.probes, [], 'inside the live cooldown the probe can only answer CooldownActive');
  assert.equal(sent(state, BUY).length, 0);
  assert.equal(report.notes.readyAt, NOW - 600 + 900);
  assert.equal(report.notes.buybackCooldown, 900);
});

test('a shorter live cooldown is honoured too: set to 60 s, a buyback 120 s after the last one goes out', async () => {
  const { ctx, state } = harness();
  state.buybackBalance = 50n * 10n ** 6n;
  state.buybackCooldown = 60;
  state.lastBuybackAt = BigInt(NOW - 120); // inside the old 300, past the 60 the splitter now enforces
  state.probe = { usdgIn: 50n * 10n ** 6n, burned: 1_000n * 10n ** 18n };
  state.sim[BUY] = [50n * 10n ** 6n, 1_000n * 10n ** 18n];
  await stepFlywheel(ctx, USDG);
  assert.equal(sent(state, BUY).length, 1);
});

test('an unreadable cooldown does not hold the buyback back (the chain still refuses inside the window) and says why', async () => {
  const { ctx, state } = harness();
  state.buybackBalance = 50n * 10n ** 6n;
  state.lastBuybackAt = BigInt(NOW - 60);
  state.failViews.add('buybackCooldown');
  state.probe = { usdgIn: 50n * 10n ** 6n, burned: 1_000n * 10n ** 18n };
  state.sim[BUY] = [50n * 10n ** 6n, 1_000n * 10n ** 18n];
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(state.probes.length, 1, 'probed: the splitter, not a guessed number, decides');
  assert.equal(report.notes.buybackCooldown, null);
  assert.match(String(report.notes.buybackCooldownReadError), /buybackCooldown/);
});

test('an unread lastBuybackAt is not 0 ("never"): it is shown unread with its error, and the chain, not the guess, decides the buyback', async () => {
  // Inside a live cooldown: a keeper that read the failed view as 0 would record "never bought" as a fact.
  const { ctx, state } = harness();
  state.buybackBalance = 50n * 10n ** 6n;
  state.lastBuybackAt = BigInt(NOW - 60);
  state.failViews.add('lastBuybackAt');
  state.probe = { revert: 'CooldownActive', args: [BigInt(NOW - 60 + COOLDOWN)] };
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(report.notes.lastBuybackAt, null, 'the note shows an unread value, not a made-up 0');
  assert.match(String(report.notes.lastBuybackAtReadError), /lastBuybackAt/);
  assert.equal(report.notes.buyback, 'skipped: cooldown (chain)', 'the splitter refused inside its window');
  assert.equal(sent(state, BUY).length, 0, 'no buyback on the guess');
  // Control: the same chain with the view answering holds the probe back on its own arithmetic and shows the time.
  const read = harness();
  read.state.buybackBalance = 50n * 10n ** 6n;
  read.state.lastBuybackAt = BigInt(NOW - 60);
  const r = await stepFlywheel(read.ctx, USDG);
  assert.equal(r.notes.lastBuybackAt, NOW - 60);
  assert.equal(r.notes.lastBuybackAtReadError, undefined);
});

test('lastBuybackAt 0 means NEVER, not 1970: the first buyback is not held back', async () => {
  const { ctx, state } = harness();
  state.buybackBalance = 50n * 10n ** 6n;
  state.lastBuybackAt = 0n;
  state.probe = { usdgIn: 50n * 10n ** 6n, burned: 1_000n * 10n ** 18n };
  state.sim[BUY] = [50n * 10n ** 6n, 1_000n * 10n ** 18n];
  await stepFlywheel(ctx, USDG);
  assert.equal(sent(state, BUY).length, 1, 'a splitter that has never bought back is ready now');
});

test('THE FLOOR: minTokenOut is the probe tightened by the tolerance, and the probe argument never reaches the sender', async () => {
  // THE ONE GUARD IN THIS STEP THAT NOTHING DOWNSTREAM WOULD CATCH. A buyback sent with the probe's `1`
  // confirms, burns, and emits exactly the events a correct one does — it is simply unbounded, and the
  // difference only ever shows up as a worse fill. Deleting the tightening line must turn this test red.
  const { ctx, state } = harness({ toleranceBps: 50 });
  state.buybackBalance = 50n * 10n ** 6n;
  state.lastBuybackAt = BigInt(NOW - COOLDOWN - 1);
  const burned = 1_000n * 10n ** 18n;
  state.probe = { usdgIn: 50n * 10n ** 6n, burned };
  state.sim[BUY] = [50n * 10n ** 6n, burned];

  const report = await stepFlywheel(ctx, USDG);

  assert.equal(state.probes.length, 1, 'exactly one probe');
  assert.equal(state.probes[0]!.fn, BUY);
  assert.equal(state.probes[0]!.args[0], 1n, 'the probe asks with 1: 0 would revert BadPrice');

  const calls = sent(state, BUY);
  assert.equal(calls.length, 1);
  const argument = calls[0]!.args[0] as bigint;
  assert.equal(argument, (burned * (BPS - 50n)) / BPS, 'burned x (1 - tolerance)');
  assert.notEqual(argument, 1n, 'the probe value must never be what is sent');
  assert.ok(argument > 1n && argument < burned, 'strictly between the probe and the quote');
  assert.equal(report.notes.minTokenOut, argument.toString());
  assert.equal(calls[0]!.gas, GAS.buyback);
});

/*//////////////////////////////////////////////////////////////
               THE ENTRY POINT AND ITS DEADLINE
//////////////////////////////////////////////////////////////*/

test('the buyback is buybackWithDeadline(minTokenOut, deadline) with a nonzero floor and a bounded deadline, never buyback(uint256)', async () => {
  // THE PROTECTED FACT. From the v9 FeeSplitter buyback(uint256) ALWAYS reverts BuybackDeadlineRequired and leaves
  // no event, so a cranker still sending it stops the flywheel while looking like one that is merely idle. The
  // fake splitter refuses the old call the same way, so going back to it sends nothing and this goes red.
  const { ctx, state } = harness({ toleranceBps: 50 });
  state.buybackBalance = 50n * 10n ** 6n;
  state.lastBuybackAt = 0n;
  const burned = 1_000n * 10n ** 18n;
  state.probe = { usdgIn: 50n * 10n ** 6n, burned };
  state.sim[BUY] = [50n * 10n ** 6n, burned];

  const report = await stepFlywheel(ctx, USDG);

  assert.equal(state.oldBuybackSends, 0, 'buyback(uint256) is never sent');
  assert.equal(state.probes.filter((p) => p.fn === OLD_BUYBACK).length, 0, 'buyback(uint256) is never even probed');
  assert.equal(state.sends.filter((s) => s.fn === OLD_BUYBACK).length, 0);

  const calls = sent(state, BUY);
  assert.equal(calls.length, 1, 'exactly one buybackWithDeadline');
  const [minTokenOut, deadline] = calls[0]!.args as [bigint, bigint];
  assert.equal(calls[0]!.args.length, 2);
  assert.ok(minTokenOut > 0n, 'a derived nonzero minTokenOut, never 0 (FS-01)');
  assert.equal(minTokenOut, (burned * (BPS - 50n)) / BPS, 'the floor is the fresh quote less the tolerance');
  assert.equal(deadline, BigInt(NOW + BUYBACK_DEADLINE_S), 'the head timestamp plus the configured window');
  assert.ok(deadline > BigInt(NOW), 'in the future at send time');
  assert.ok(deadline - BigInt(NOW) <= 600n, 'and short: minutes, not max uint');
  assert.ok(BUYBACK_DEADLINE_S > 0 && BUYBACK_DEADLINE_S <= 600, 'the window itself is bounded');
  assert.equal(state.probes[0]!.args[1], deadline, 'the probe quoted the same deadline the send carries');
  assert.equal(report.notes.deadline, deadline.toString());
  assert.equal(report.notes.buyback, 'confirmed');
});

test('the deadline is taken from a head read just before the probe, not from the step start', async () => {
  // Claim and distribute confirm before the buyback runs, so the step's own `now` can be minutes old. A deadline
  // built on it would be shorter than BUYBACK_DEADLINE_S, or already past. Every getBlock here is 40 s later than
  // the one before, so the deadline must follow the LAST head the step read, not the first.
  const { ctx, state } = harness();
  state.headAdvanceS = 40;
  state.buybackBalance = 50n * 10n ** 6n;
  state.lastBuybackAt = 0n;
  state.probe = { usdgIn: 50n * 10n ** 6n, burned: 900n * 10n ** 18n };
  state.sim[BUY] = [50n * 10n ** 6n, 900n * 10n ** 18n];

  await stepFlywheel(ctx, USDG);

  assert.ok(state.headReads >= 2, 'the step read the head again for the deadline');
  const lastHead = NOW + state.headAdvanceS * (state.headReads - 1);
  const [, deadline] = sent(state, BUY)[0]!.args as [bigint, bigint];
  assert.equal(deadline, BigInt(lastHead + BUYBACK_DEADLINE_S), 'the freshest head plus the window');
  assert.ok(deadline > BigInt(NOW + BUYBACK_DEADLINE_S), 'later than a deadline built on the step start would be');
});

test('a send that misses its deadline is recorded as DeadlinePassed, not caught, and moves nothing', async () => {
  const { ctx, state } = harness();
  state.buybackBalance = 50n * 10n ** 6n;
  state.lastBuybackAt = 0n;
  state.probe = { usdgIn: 50n * 10n ** 6n, burned: 900n * 10n ** 18n };
  state.sim[BUY] = 'DeadlinePassed';

  const report = await stepFlywheel(ctx, USDG);

  assert.equal(sent(state, BUY).length, 0, 'nothing is broadcast');
  assert.equal(state.oldBuybackSends, 0, 'and there is no fallback to buyback(uint256)');
  assert.equal(report.notes.buyback, 'simulation-reverted', 'the note says the send failed, not that it was skipped');
  const action = report.actions.find((a) => a.kind === 'buyback');
  assert.ok(action !== undefined, 'the refusal is on the record');
  assert.equal(action.revert, 'DeadlinePassed');
});

test('the cap needs no read: a simulated spend below the reserve still sends, and the reserve drains next interval', async () => {
  // FeeSplitter.buyback spends min(reserve, buybackCap) and does NOT revert on the cap, so the keeper pins no
  // cap of its own. The simulated usdgIn is simply smaller than the reserve, and that is not a reason to stop.
  const { ctx, state, store } = harness();
  state.buybackBalance = 500n * 10n ** 6n;
  state.lastBuybackAt = 0n;
  state.probe = { usdgIn: 50n * 10n ** 6n, burned: 900n * 10n ** 18n };
  state.sim[BUY] = [50n * 10n ** 6n, 900n * 10n ** 18n];
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(sent(state, BUY).length, 1);
  assert.equal(report.notes.buybackBalance, (500n * 10n ** 6n).toString());
  assert.deepEqual(report.notes.probe, { usdgIn: (50n * 10n ** 6n).toString(), burned: (900n * 10n ** 18n).toString() });
  assert.equal(store.getMeta(flywheelMetaKey), String(NOW), 'the pass is recorded, so the next one is one interval away');
});

test('a zero quote sends nothing rather than a floor of 0', async () => {
  const { ctx, state } = harness();
  state.buybackBalance = 50n * 10n ** 6n;
  // The splitter holds exactly what the counter says. With LESS it is a hole, and the step sends
  // the write-down below instead; this test is about a zero quote on an intact reserve.
  state.balances.set(USDG.toLowerCase(), 50n * 10n ** 6n);
  state.lastBuybackAt = 0n;
  state.probe = { usdgIn: 0n, burned: 0n };
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(sent(state, BUY).length, 0);
  assert.equal(report.notes.buyback, 'skipped: the route quotes nothing');
});

/*//////////////////////////////////////////////////////////////
          THE WRITE-DOWN (the counter follows the balance down)
//////////////////////////////////////////////////////////////*/

/** A hole: the counter says 150 USDG, 40 are left (an issuer burned the rest), and the probe skips. */
function hole(options: Options = {}) {
  const h = harness(options);
  h.state.buybackBalance = 150n * 10n ** 6n;
  h.state.balances.set(USDG.toLowerCase(), 40n * 10n ** 6n);
  h.state.lastBuybackAt = 0n;
  h.state.probe = { usdgIn: 0n, burned: 0n };
  h.state.sim[BUY] = [0n, 0n];
  return h;
}

test('a skip while the splitter holds less USDG than buybackBalance sends ONE write-down that cannot buy', async () => {
  const { ctx, state } = hole();
  const report = await stepFlywheel(ctx, USDG);
  const buys = sent(state, BUY);
  assert.equal(buys.length, 1, 'the write-down is sent: without it the counter never comes down on chain');
  assert.equal(buys[0]!.args[0], 2n ** 256n - 1n, 'minTokenOut no buy can meet: a skip lands, a buy reverts in the executor');
  assert.notEqual(buys[0]!.args[0], 1n, 'the probe argument never reaches the sender');
  assert.equal(buys[0]!.args[1], BigInt(NOW + BUYBACK_DEADLINE_S), 'the same bounded deadline as a buy');
  assert.equal(buys[0]!.gas, GAS.buyback);
  assert.equal(report.notes.buyback, 'write-down: confirmed');
  assert.equal(report.notes.usdgHeld, (40n * 10n ** 6n).toString());
  assert.ok(report.actions.some((a) => a.kind === 'buyback' && a.key === `${SPLITTER.toLowerCase()}:write-down` && a.status === 'confirmed'));
});

test('the same skip with the counter fully backed sends nothing (the hole, not the skip, is the trigger)', async () => {
  const { ctx, state } = hole();
  state.balances.set(USDG.toLowerCase(), 150n * 10n ** 6n);
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(sent(state, BUY).length, 0);
  assert.equal(report.notes.buyback, 'skipped: the route quotes nothing');
});

test('an unreadable USDG balance sends no write-down and says why', async () => {
  const { ctx, state } = hole();
  state.failBalanceOf.add(USDG.toLowerCase());
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(sent(state, BUY).length, 0, 'a hole nobody could measure is not written down blind');
  assert.equal(report.notes.buyback, 'skipped: the route quotes nothing');
  assert.equal(report.notes.usdgHeld, null);
  assert.match(String(report.notes.usdgHeldReadError), /rpc said no/);
});

test('CRANKER_BUYBACK_DRY_RUN withholds the write-down too, and reports it', async () => {
  const { ctx, state } = hole({ buybackDryRun: true });
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(sent(state, BUY).length, 0);
  assert.equal(report.notes.buyback, 'dry run: write-down probed, not sent');
  assert.ok(report.actions.some((a) => a.key === `${SPLITTER.toLowerCase()}:write-down` && a.status === 'not-sent'));
});

/*//////////////////////////////////////////////////////////////
   THE DISTRIBUTE WRITE-DOWN (the distribute lowers the counter too)
//////////////////////////////////////////////////////////////*/

/** The step's sends of `distribute(usdg)`, in order. */
const usdgDistributes = (state: ReturnType<typeof harness>['state']) => sent(state, 'distribute').filter((c) => String(c.args[0]).toLowerCase() === USDG.toLowerCase());
const WRITE_DOWN_KEY = `${USDG.toLowerCase()}:write-down`;

test('a stale counter with no income sends distribute(usdg) once, before the claim, though it simulates to 0', async () => {
  const { ctx, state } = hole();
  state.owed = 25n * 10n ** 6n;
  state.sim.claimOrderBookFees = 25n * 10n ** 6n;
  // state.sim.distribute is unset: every distribute simulates to 0, which the zero-return rule never sends.
  const report = await stepFlywheel(ctx, USDG);

  const writes = usdgDistributes(state);
  assert.equal(writes.length, 1, 'sent once: without it the counter stays up until a buyback, and income refills the hole');
  assert.equal(writes[0]!.gas, GAS.distribute, 'fixed gas, as every distribute');
  const order = state.sends.map((x) => x.fn);
  assert.equal(order[0], 'distribute', 'first of the pass');
  assert.ok(order.indexOf('distribute') < order.indexOf('claimOrderBookFees'), 'before the claim, so the fees it pulls in are split, not absorbed');
  assert.ok(report.actions.some((a) => a.kind === 'distribute' && a.key === WRITE_DOWN_KEY && a.status === 'confirmed'));
  assert.deepEqual(report.notes.writeDown, { buybackBalance: (150n * 10n ** 6n).toString(), usdgHeld: (40n * 10n ** 6n).toString(), status: 'confirmed' });
});

test('nothing due sends no write-down: a counter the balance covers, exactly or with income on top', async () => {
  for (const held of [50n * 10n ** 6n, 80n * 10n ** 6n]) {
    const { ctx, state } = harness();
    state.buybackBalance = 50n * 10n ** 6n;
    state.balances.set(USDG.toLowerCase(), held);
    state.lastBuybackAt = 0n;
    state.probe = { usdgIn: 0n, burned: 0n };
    const report = await stepFlywheel(ctx, USDG);
    assert.deepEqual(state.sends, [], `held ${held}: nothing sent, the zero-return rule is unchanged`);
    assert.equal(report.notes.writeDown, undefined, `held ${held}: the pass reads as it always did`);
    assert.ok(!report.actions.some((a) => a.key === WRITE_DOWN_KEY));
  }
});

test('an unreadable counter or USDG balance sends no write-down distribute and says which read failed', async () => {
  const balance = hole();
  balance.state.failBalanceOf.add(USDG.toLowerCase());
  const a = await stepFlywheel(balance.ctx, USDG);
  assert.equal(usdgDistributes(balance.state).length, 0, 'an unreadable balance is not a balance of 0: no hole is assumed');
  assert.deepEqual(a.notes.writeDown, { sent: false, unreadable: 'USDG balanceOf' });

  const counter = hole();
  counter.state.failViews.add('buybackBalance');
  const b = await stepFlywheel(counter.ctx, USDG);
  assert.equal(usdgDistributes(counter.state).length, 0);
  assert.deepEqual(b.notes.writeDown, { sent: false, unreadable: 'buybackBalance' });
});

test('once the write-down lands, the buyback leg reads at that block and sends no second write-down', async () => {
  const { ctx, state } = hole();
  const HEAD = state.block;
  state.confirmBlock = HEAD + 1n;
  // On chain: the counter is 150 at the head block and 40, the balance, from the block the distribute landed in.
  state.buybackBalanceAt = (block) => (block !== undefined && block > HEAD ? 40n * 10n ** 6n : 150n * 10n ** 6n);
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(usdgDistributes(state).length, 1);
  const buybackReads = state.multicalls.filter((m) => m.fns.includes('lastBuybackAt'));
  assert.equal(buybackReads.length, 1);
  assert.equal(buybackReads[0]!.blockNumber, HEAD + 1n, 'the buyback leg reads where the write-down landed, not the step head');
  assert.equal(sent(state, BUY).length, 0, 'no buybackWithDeadline for a hole this pass already closed');
  assert.equal(report.notes.buybackBalance, (40n * 10n ** 6n).toString());
  assert.equal(report.notes.buyback, 'skipped: the route quotes nothing');
});

test('against a splitter whose distribute leaves the counter up, the buyback leg\'s own write-down still goes out', async () => {
  const { ctx, state } = hole();
  state.confirmBlock = state.block + 1n;
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(usdgDistributes(state).length, 1, 'the distribute is sent: from off chain a 0 return cannot say whether it wrote down');
  assert.equal(sent(state, BUY).length, 1, 'the counter still reads 150 where it landed, so the buyback leg writes it down itself');
  assert.equal(report.notes.buyback, 'write-down: confirmed');
});

test('CRANKER_BUYBACK_DRY_RUN still sends the write-down distribute (it withholds buyback calls only)', async () => {
  const { ctx, state } = hole({ buybackDryRun: true });
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(usdgDistributes(state).length, 1, 'a distribute spends nothing, and the flag leaves every other distribute live');
  assert.equal(sent(state, BUY).length, 0, 'the buyback-side write-down stays withheld');
  assert.equal(report.notes.buyback, 'dry run: write-down probed, not sent');
});

test('the process dry run sends nothing and the buyback leg reads at the step head', async () => {
  const { ctx, state } = hole({ dryRun: true });
  const report = await stepFlywheel(ctx, USDG);
  assert.deepEqual(state.sends, []);
  assert.equal((report.notes.writeDown as Record<string, unknown>).status, 'would-send');
  assert.equal(state.multicalls.find((m) => m.fns.includes('lastBuybackAt'))!.blockNumber, state.block, 'nothing landed, so nothing moved the read');
});

test('a tick that must yield sends no write-down and says why; the next pass finds the hole again', async () => {
  const { ctx, state } = hole();
  ctx.yieldWhen = () => true;
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(usdgDistributes(state).length, 0);
  assert.deepEqual(report.notes.writeDown, { buybackBalance: (150n * 10n ** 6n).toString(), usdgHeld: (40n * 10n ** 6n).toString(), sent: false, why: 'tick budget spent' });
});

test('a paused splitter refuses the write-down; the claim still goes out and nothing else is asked', async () => {
  const { ctx, state, alerts } = hole();
  state.owed = 10n ** 9n;
  state.sim.claimOrderBookFees = 10n ** 9n;
  state.sim.distribute = 'TradingPaused';
  const report = await stepFlywheel(ctx, USDG);
  assert.deepEqual(state.sends.map((x) => x.fn), ['claimOrderBookFees'], 'the claim is never gated on the pause');
  assert.equal(report.notes.paused, true);
  assert.equal(state.probes.length, 0, 'the buyback is not probed once the pause is known');
  assert.equal(alerts.filter((a) => a.dedupeKey === 'flywheel:paused').length, 1);
});

test('a write-down send that throws is recorded and the rest of the pass still runs', async () => {
  const { ctx, state } = hole();
  state.owed = 10n ** 9n;
  state.sim.claimOrderBookFees = 10n ** 9n;
  state.sim.distribute = () => {
    throw new Error('rpc went away');
  };
  const report = await stepFlywheel(ctx, USDG);
  assert.match(String((report.notes.writeDown as Record<string, unknown>).error), /rpc went away/);
  assert.equal(sent(state, 'claimOrderBookFees').length, 1, 'the claim is not lost to the write-down');
});

test('a step-0 read that THROWS (transport, not a failed view) is noted and the claim still goes out', async () => {
  const { ctx, state } = hole();
  state.owed = 10n ** 9n;
  state.sim.claimOrderBookFees = 10n ** 9n;
  const client = ctx.client as unknown as { multicall: (a: { contracts: Array<{ functionName: string }> }) => Promise<unknown> };
  const real = client.multicall;
  let thrown = 0;
  client.multicall = async (a) => {
    // Only the write-down's own read (buybackBalance + USDG balanceOf) throws, as a dropped socket would.
    if (thrown === 0 && a.contracts.some((c) => c.functionName === 'buybackBalance') && a.contracts.some((c) => c.functionName === 'balanceOf')) {
      thrown += 1;
      throw new Error('socket hang up');
    }
    return real(a);
  };
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(thrown, 1, 'the step-0 read was the one that threw');
  assert.match(String((report.notes.writeDown as Record<string, unknown>).readError), /socket hang up/);
  assert.equal(usdgDistributes(state).length, 0, 'no write-down on a read that never came back');
  assert.equal(sent(state, 'claimOrderBookFees').length, 1, 'a transport throw in step 0 does not abort the pass before the claim');
});

test('a write-down refused as TradingPaused stops the pass asking, even if a later simulation would pass', async () => {
  const { ctx, state } = hole();
  state.owed = 10n ** 9n;
  state.sim.claimOrderBookFees = 10n ** 9n;
  // Only the FIRST distribute (the write-down) reverts TradingPaused; any later one would simulate to a real amount.
  // So only the step-0 `paused` flag, not a step-2 re-simulation, can keep the rest of the pass from sending.
  let distributes = 0;
  state.sim.distribute = () => (distributes++ === 0 ? 'TradingPaused' : 7n * 10n ** 6n);
  const report = await stepFlywheel(ctx, USDG);
  assert.equal(distributes, 1, 'nothing after the paused write-down simulates distribute');
  assert.deepEqual(state.sends.map((x) => x.fn), ['claimOrderBookFees'], 'the claim goes out; no distribute follows a known pause');
  assert.equal(report.notes.paused, true);
  assert.equal(state.probes.length, 0, 'the buyback is not probed once the pause is known');
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
  state.sim[BUY] = [50n * 10n ** 6n, 900n * 10n ** 18n];
  await stepFlywheel(ctx, USDG);
  assert.deepEqual(state.sends, [], 'a dry run broadcasts nothing');
  assert.equal(store.getMeta(flywheelMetaKey), null, 'and records no pass, so a later live tick is not skipped');
});

test('CRANKER_BUYBACK_DRY_RUN probes and reports but never sends the buyback, while the rest stays live', async () => {
  const { ctx, state, alerts } = harness({ buybackDryRun: true });
  state.owed = 10n ** 9n;
  state.sim.claimOrderBookFees = 10n ** 9n;
  state.buybackBalance = 50n * 10n ** 6n;
  state.lastBuybackAt = 0n;
  state.probe = { usdgIn: 50n * 10n ** 6n, burned: 900n * 10n ** 18n };
  state.sim[BUY] = [50n * 10n ** 6n, 900n * 10n ** 18n];

  const report = await stepFlywheel(ctx, USDG);
  assert.equal(state.probes.length, 1, 'it still probes: the point is to watch the route');
  assert.equal(sent(state, BUY).length, 0, 'and never spends');
  assert.equal(sent(state, 'claimOrderBookFees').length, 1, 'this is NOT the process dry run: the rest is live');
  assert.equal(report.notes.buyback, 'dry run: probed, not sent');
  assert.ok(report.actions.some((a) => a.kind === 'buyback' && a.status === 'not-sent'));
  // The withheld buyback pages; it used to be this report note and nothing else.
  const paged = alerts.filter((a) => a.kind === 'v2_cranker_buyback_dry_run');
  assert.equal(paged.length, 1, 'one page for the withheld buyback');
  assert.equal(paged[0]!.dedupeKey, SPLITTER.toLowerCase());
  assert.equal(paged[0]!.data.usdgIn, (50n * 10n ** 6n).toString());
  assert.equal(paged[0]!.data.burned, (900n * 10n ** 18n).toString());
});

test('the dry-run page fires only when a buyback was withheld: not on an empty reserve, not when live', async () => {
  const empty = harness({ buybackDryRun: true });
  empty.state.buybackBalance = 0n;
  const quiet = await stepFlywheel(empty.ctx, USDG);
  assert.equal(quiet.notes.buyback, 'skipped: empty reserve');
  assert.deepEqual(empty.alerts.filter((a) => a.kind === 'v2_cranker_buyback_dry_run'), [], 'nothing withheld, nothing paged');

  const live = harness();
  live.state.buybackBalance = 50n * 10n ** 6n;
  live.state.lastBuybackAt = 0n;
  live.state.probe = { usdgIn: 50n * 10n ** 6n, burned: 900n * 10n ** 18n };
  live.state.sim[BUY] = [50n * 10n ** 6n, 900n * 10n ** 18n];
  await stepFlywheel(live.ctx, USDG);
  assert.equal(sent(live.state, BUY).length, 1, 'the live cranker buys back');
  assert.deepEqual(live.alerts.filter((a) => a.kind === 'v2_cranker_buyback_dry_run'), []);
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
  // DeadlinePassed is what a late buybackWithDeadline reverts with, and BuybackDeadlineRequired is what
  // the frozen buyback(uint256) always reverts with; the fake splitter encodes both from this same ABI.
  for (const name of ['NotAuthorized', 'TradingPaused', 'DeadlinePassed', 'BuybackDeadlineRequired'] as const) {
    const data = encodeErrorResult({ abi: feeSplitterAbi, errorName: name });
    assert.match(data, /^0x[0-9a-f]{8}$/, `${name} encodes to a 4-byte selector`);
  }
});

test('NotAuthorized from the buybackWithDeadline probe raises v2_cranker_no_buyback_role and sends nothing', async () => {
  // The probe is now buybackWithDeadline. `restricted` runs before its deadline check, so a key without
  // BUYBACK is refused NotAuthorized exactly as before, and the probe must still classify it as the role.
  const { ctx, state, alerts } = harness();
  state.buybackBalance = 50n * 10n ** 6n;
  state.lastBuybackAt = 0n;
  state.probe = { revert: 'NotAuthorized' };
  const report = await stepFlywheel(ctx, USDG);
  assert.deepEqual(state.probes.map((p) => p.fn), [BUY], 'the role is probed on the new selector');
  assert.equal(sent(state, BUY).length, 0);
  assert.equal(state.oldBuybackSends, 0);
  assert.equal(report.notes.buyback, 'refused: no BUYBACK role');
  const paged = alerts.filter((a) => a.kind === 'v2_cranker_no_buyback_role');
  assert.equal(paged.length, 1);
  assert.equal(paged[0]!.data.signer, ctx.sender.account);
});
