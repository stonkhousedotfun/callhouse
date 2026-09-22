/**
 * One pricer tick after another (pricer.ts) on a fake chain, a fake sender and injected fair values.
 *
 * WHY THIS FILE EXISTS: the planner's rules only matter if the tick applies them to the right ask at
 * the right time and remembers what it did. Pinned: a position is evaluated right after its roll and
 * then at most every 30 minutes on the HEAD clock, however the fair value moves in between; an
 * evaluation that leaves the ask alone restarts that clock, one that could not decide (no fair value,
 * a stale spot, a refused or failed send, a key without the role) does not; the reprice goes to the
 * clamped tick price with the fixed gas limit, keyed by the ask it replaces; the /fair request names
 * the series' own strike and expiry; each failure raises its v2_pricer_* alert; and a store kept from
 * another deployment at the same roller address (a previous devnet) is reset before the first tick
 * reads its strategies or its evaluation clock. And GET /ready (T-423): ready only when the loop is
 * alive, a tick completed and the latest did not throw, the latest canCall read answered (true, 0), and a
 * qualified fair value is inside the bound - each failing alone names itself, and unknown is never ready.
 *
 * DELIBERATELY ABSENT: an RPC and the pricing service. devnet-reprice.ts runs the same tick against
 * the real AutoRoller on ops/devnet.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getAddress, type Address } from 'viem';
import type { V2AlertKind } from '../alerts.js';
import { loadV2Config, type PricerConfig } from '../config.js';
import { ModeHealth, createModeHealthApp, type ReadyReason } from '../health.js';
import { silentLogger } from '../logger.js';
import { INTERFACE_VERSION } from '../registry.js';
import { V2Store } from '../store.js';
import type { ExecuteOptions, TxOutcome, WriteCall } from '../tx.js';
import type { FairAnswer, FairRequest } from './fair-client.js';
import { pricerReadyRoute } from './main.js';
import {
  GAS_REPRICE,
  ROLLER_REPRICE_SELECTOR,
  Pricer,
  evaluatePricerReadiness,
  evaluatedMetaKey,
  fairMissingMetaKey,
  fairReadyBoundMs,
  type PricerClient,
  type PricerReadinessFacts,
} from './pricer.js';
import { StrategyIndex } from './strategies.js';

const REGISTRY = fileURLToPath(new URL('../fixtures/registry-v2.json', import.meta.url));
const BEN = getAddress('0x15d34aaf54267db7d7c367839aaf71a00a2c6a65');
const NVDA = getAddress('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC');
const SIGNER = getAddress('0xa0Ee7A142d267C1f36714E4a8F75612F20a79720');
/** `market(NVDA).oracle`: the market's CURRENT pointer, which a setMarketOracle may move at any time. */
const MARKET_ORACLE = getAddress('0x00000000000000000000000000000000c0de0003');
/**
 * Two oracles a series can be PINNED to, both different from the market's pointer: the post-migration shape. A tick
 * that still read `market(u).oracle` would ask neither, so the assertions on `spotFrom` fail instead of coinciding.
 */
const SERIES_ORACLE_A = getAddress('0x00000000000000000000000000000000c0de00a1');
const SERIES_ORACLE_B = getAddress('0x00000000000000000000000000000000c0de00b2');
const T0 = 1_790_000_000;
const HASH = `0x${'ab'.repeat(32)}` as const;
const DEPLOY_HASH = `0x${'d1'.repeat(32)}` as const;
/** registry-v2.json's v2.deployBlock with the fake chain's hash of it. */
const ANCHOR = `65100000:${DEPLOY_HASH}`;

function pricerConfig(env: Record<string, string> = {}): PricerConfig {
  return loadV2Config({
    V2_MODE: 'pricer',
    RH_RPC: 'http://127.0.0.1:9',
    PRICER_PK: `0x${'5e'.repeat(32)}`,
    PRICER_PORT: '0',
    PRICING_URL: 'http://127.0.0.1:8790',
    KEEPER_DB_PATH: ':memory:',
    V2_REGISTRY_PATH: REGISTRY,
    ...env,
  }) as PricerConfig;
}

interface Order {
  maker: Address;
  longId: bigint;
  kind: number;
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
}

/** The views the tick reads, as mutable state. */
class FakeChain {
  timestamp = T0;
  block = 65_200_000n;
  /**
   * INTERFACE_VERSION 8: authority is one AccessManager.canCall(signer, roller, selector) -> (immediate,
   * delay), not AutoRoller.hasRole — the AutoRoller is `Managed` and has no role storage at all. Until
   * K8-178 this fixture still served `hasRole`, so the tick's real read fell to the `default` arm below,
   * came back as a multicall FAILURE, and every test here ran against hasRole === null.
   */
  canReprice = true;
  /** A member whose calls must be scheduled: canCall answers (false, delay). */
  repriceDelay = 0;
  /** The canCall READ fails. Not the same thing as an answer of false, and the tick must not confuse them. */
  canCallFails = false;
  sessionOpen = true;
  sessionReadFails = false;
  /** The head read throws, so the whole tick does (T-423: a tick that threw). */
  headFails = false;
  strategy = { active: true, weekly: true, smartPricing: true, otmBps: 500, askBps: 60, minAskBps: 30, maxAskBps: 150, maxUnits: 1_000n };
  position = { longId: 11n, orderId: 31n, expiry: T0 + 3 * 86_400 };
  spot: bigint | null = 212_210_000n;
  /**
   * T-437: a spot belongs to ONE oracle. Anything not named here falls back to `spot`, so a single-oracle deployment
   * reads exactly as before; a post-migration one names each oracle and `spotFrom` records who was actually asked.
   */
  spotByOracle = new Map<string, bigint | null>();
  /** Lower-case address of every oracle a trySpot went to, in order. */
  spotFrom: string[] = [];
  orders = new Map<bigint, Order>([[31n, { maker: BEN, longId: 11n, kind: 2, price: 1_273_300n, units: 1_000n, filled: 200n, validUntil: T0 + 3 * 86_400 - 1_800, cancelled: false }]]);
  /**
   * `oracle` is the one createSeries PINNED into the series: what `reprice` reads on chain and what the series settles
   * on (T-310/T-437). It is part of the real return value, so the fixture carries it - a series without one is not a
   * shape the Clearinghouse can produce, and the tick correctly refuses to price it.
   */
  series = new Map<bigint, { underlying: Address; isPut: boolean; expiry: number; strike: bigint; oracle: Address }>([
    [11n, { underlying: NVDA, isPut: false, expiry: T0 + 3 * 86_400, strike: 222_500_000n, oracle: MARKET_ORACLE }],
    [12n, { underlying: NVDA, isPut: false, expiry: T0 + 10 * 86_400, strike: 225_000_000n, oracle: MARKET_ORACLE }],
  ]);
  nextOrderId = 32n;

  private view(fn: string, args: readonly unknown[], address?: string): unknown {
    switch (fn) {
      case 'canCall':
        if (this.canCallFails) throw new Error('canCall unavailable');
        assert.equal(args[2], ROLLER_REPRICE_SELECTOR, 'the tick asks about reprice(address,address,uint128), never a pasted id');
        return [this.canReprice, this.repriceDelay];
      case 'isRegularSession':
        if (this.sessionReadFails) throw new Error('calendar unavailable');
        return this.sessionOpen;
      case 'strategy':
        return this.strategy;
      case 'position':
        return [this.position.longId, this.position.orderId, this.position.expiry];
      case 'market':
        return { enabled: true, mintPaused: false, strikeTick: 2_500_000n, exerciseFeeBps: 50, oracle: MARKET_ORACLE };
      case 'trySpot': {
        const who = (address ?? '').toLowerCase();
        this.spotFrom.push(who);
        const named = this.spotByOracle.has(who) ? this.spotByOracle.get(who)! : this.spot;
        return [named !== null, named ?? 0n, BigInt(this.timestamp)];
      }
      case 'getOrders':
        return (args[0] as bigint[]).map((id) => this.orders.get(id) ?? { maker: '0x0000000000000000000000000000000000000000', longId: 0n, kind: 0, price: 0n, units: 0n, filled: 0n, validUntil: 0, cancelled: false });
      case 'series': {
        const s = this.series.get(args[0] as bigint);
        if (s === undefined) throw new Error('UnknownSeries');
        return s;
      }
      default:
        throw new Error(`fake chain has no view ${fn}`);
    }
  }

  client(): PricerClient {
    return {
      getBlock: (async (args?: { blockNumber?: bigint }) => {
        if (args?.blockNumber !== undefined) return { number: args.blockNumber, hash: DEPLOY_HASH, timestamp: 0n };
        if (this.headFails) throw new Error('head unavailable');
        return { number: this.block, hash: HASH, timestamp: BigInt(this.timestamp) };
      }) as never,
      getBlockNumber: (async () => this.block) as never,
      multicall: (async ({ contracts }: { contracts: Array<{ functionName: string; args?: readonly unknown[]; address?: string }> }) =>
        contracts.map((c) => {
          try {
            return { status: 'success', result: this.view(c.functionName, c.args ?? [], c.address) };
          } catch (error) {
            return { status: 'failure', error };
          }
        })) as never,
      readContract: (async (c: { functionName: string; args?: readonly unknown[]; address?: string }) => this.view(c.functionName, c.args ?? [], c.address)) as never,
    };
  }

  /** What a confirmed reprice does on chain (AutoRoller.reprice + OrderBook.replace). */
  applyReprice(price: bigint): bigint {
    const old = this.orders.get(this.position.orderId)!;
    old.cancelled = true;
    const id = this.nextOrderId++;
    this.orders.set(id, { ...old, price, units: old.units - old.filled, filled: 0n, cancelled: false });
    this.position.orderId = id;
    return id;
  }

  roll(longId: bigint, orderId: bigint, price: bigint): void {
    this.position = { longId, orderId, expiry: this.series.get(longId)!.expiry };
    this.orders.set(orderId, { maker: BEN, longId, kind: 2, price, units: 1_000n, filled: 0n, validUntil: this.position.expiry - 1_800, cancelled: false });
  }
}

interface Harness {
  chain: FakeChain;
  pricer: Pricer;
  store: V2Store;
  sends: Array<{ args: readonly unknown[]; gas: bigint | undefined; kind: string; key: string }>;
  fairRequests: FairRequest[];
  alerts: Array<{ kind: V2AlertKind; dedupeKey: string | undefined; severity: string | undefined }>;
  cleared: string[];
  setFair(answer: FairAnswer | bigint): void;
  /** The sender's next outcome instead of a confirmation. */
  failNext(outcome: TxOutcome): void;
  /** Make (or stop making) the StrategySet log scan throw, as an RPC whose range limit has changed does. */
  breakLogs(reason: string | null): void;
  tickAt(timestamp: number): ReturnType<Pricer['tick']>;
}

/**
  * An empty alert list that still carries its element type. `assert.deepEqual` is declared as an
  * assertion signature, so comparing against a bare `[]` narrows `h.alerts` to `never[]` for the rest
  * of the test body and every later `.kind` / `.severity` read becomes a property access on `never`.
  */
const NO_ALERTS: Harness['alerts'] = [];

interface HarnessOptions {
  /** Replaces the default store preparation (this chain's anchor, BEN's NVDA strategy scanned). */
  prepare?: (store: V2Store, strategies: StrategyIndex) => void;
  /** What the StrategySet scan finds. */
  logs?: unknown[];
}

function harness(env: Record<string, string> = {}, options: HarnessOptions = {}): Harness {
  const config = pricerConfig(env);
  const chain = new FakeChain();
  const store = new V2Store(':memory:');
  const strategies = new StrategyIndex(store, config.contracts.autoRoller);
  if (options.prepare !== undefined) {
    options.prepare(store, strategies);
  } else {
    strategies.bindAnchor(ANCHOR);
    strategies.applyRange([{ writer: BEN, underlying: NVDA, block: 65_100_001n }], 65_100_001n);
  }
  const sends: Harness['sends'] = [];
  const fairRequests: FairRequest[] = [];
  const alerts: Harness['alerts'] = [];
  const cleared: string[] = [];
  let fair: FairAnswer | bigint = { ok: false, reason: 'unset' };
  let nextOutcome: TxOutcome | null = null;
  let logsThrow: string | null = null;
  const pricer = new Pricer({
    config,
    log: silentLogger(),
    client: chain.client(),
    logClient: {
      getBlockNumber: (async () => 10n ** 12n) as never,
      getLogs: (async () => {
        if (logsThrow !== null) throw new Error(logsThrow);
        return options.logs ?? [];
      }) as never,
    },
    store,
    sender: {
      account: SIGNER,
      execute: (async (call: WriteCall, options: ExecuteOptions<unknown>) => {
        sends.push({ args: call.args as readonly unknown[], gas: call.gas, kind: options.kind, key: options.key });
        if (options.isAdvanced !== undefined && (await options.isAdvanced())) return { status: 'already-advanced' };
        if (nextOutcome !== null) {
          const o = nextOutcome;
          nextOutcome = null;
          return o;
        }
        chain.applyReprice((call.args as readonly unknown[])[2] as bigint);
        return { status: 'confirmed', hash: HASH, nonce: sends.length, blockNumber: chain.block, gasUsed: 250_000n, result: undefined };
      }) as never,
    },
    alerter: {
      alert: async (kind, _message, _data, options) => {
        alerts.push({ kind, dedupeKey: options?.dedupeKey, severity: options?.severity });
        return true;
      },
      clear: (kind, dedupeKey) => {
        cleared.push(`${kind}:${dedupeKey ?? ''}`);
      },
    },
    fair: {
      fair: async (request) => {
        fairRequests.push(request);
        if (typeof fair === 'bigint') {
          return { ok: true, fair, source: 'cboe', asOf: chain.timestamp, spot: chain.spot ?? undefined };
        }
        return fair;
      },
    },
    indexer: null,
    strategies,
  });
  return {
    chain,
    pricer,
    store,
    sends,
    fairRequests,
    alerts,
    cleared,
    setFair: (answer) => {
      fair = answer;
    },
    failNext: (outcome) => {
      nextOutcome = outcome;
    },
    breakLogs: (reason) => {
      logsThrow = reason;
    },
    tickAt: (timestamp) => {
      chain.timestamp = timestamp;
      chain.block += 10n;
      return pricer.tick();
    },
  };
}

test('cadence: repriced right after the roll, not again inside 30 minutes however fair moves, left alone within 10 % (which restarts the clock), then clamped to the ceiling; a new roll is evaluated at once', async () => {
  const h = harness();
  const key = (orderId: bigint) => `${BEN.toLowerCase()}:${NVDA.toLowerCase()}:${orderId}`;

  // t0: first sight of the rolled position. Live 1.273300 (60 bps); fair 2.0 + 5 % = 2.1: +65 %.
  h.setFair(2_000_000n);
  let r = await h.tickAt(T0);
  assert.equal(r.strategies, 1);
  assert.equal(r.hasRole, true);
  let pair = r.pairs[0]!;
  assert.equal(pair.outcome, 'repriced');
  assert.equal(pair.why, 'new-position');
  assert.equal(pair.ticker, 'NVDA');
  assert.deepEqual(h.sends, [{ args: [BEN, NVDA, 2_100_000n], gas: GAS_REPRICE, kind: 'reprice', key: key(31n) }]);
  assert.deepEqual(h.fairRequests, [{ ticker: 'NVDA', strike: 222_500_000n, expiry: T0 + 3 * 86_400, type: 'call' }]);
  assert.equal(h.chain.position.orderId, 32n);
  assert.equal(h.chain.orders.get(32n)!.units, 800n, 'the remaining units carried over (fake AutoRoller)');
  assert.equal(pair.nextCheckAt, T0 + 1_800);

  // t0 + 10 min: fair jumps +43 %; not due, and no /fair request is made.
  h.setFair(3_000_000n);
  r = await h.tickAt(T0 + 600);
  pair = r.pairs[0]!;
  assert.equal(pair.outcome, 'not-due');
  assert.equal(pair.nextCheckAt, T0 + 1_800);
  assert.equal(h.sends.length, 1);
  assert.equal(h.fairRequests.length, 1);

  // t0 + 30 min: due; fair 2.15 + 5 % = 2.2575 vs live 2.1: +7.5 %, within 10 %.
  h.setFair(2_150_000n);
  r = await h.tickAt(T0 + 1_800);
  pair = r.pairs[0]!;
  assert.equal(pair.outcome, 'within-threshold');
  assert.equal(pair.why, 'interval');
  assert.equal(pair.target, 2_257_500n);
  assert.equal(h.sends.length, 1);
  assert.deepEqual(JSON.parse(h.store.getMeta(evaluatedMetaKey(h.pricer.ctx.config.contracts.autoRoller, { writer: BEN, underlying: NVDA }))!), { longId: '11', checkedAt: T0 + 1_800 });

  // t0 + 40 min: the evaluation at 30 min restarted the clock.
  h.setFair(5_000_000n);
  assert.equal((await h.tickAt(T0 + 2_400)).pairs[0]!.outcome, 'not-due');

  // t0 + 60 min: fair 5.0 + 5 % is above the 150 bps ceiling (3.183100): repriced to the ceiling.
  r = await h.tickAt(T0 + 3_600);
  pair = r.pairs[0]!;
  assert.equal(pair.outcome, 'repriced');
  assert.equal(pair.clamped, 'ceiling');
  assert.deepEqual(h.sends[1], { args: [BEN, NVDA, 3_183_100n], gas: GAS_REPRICE, kind: 'reprice', key: key(32n) });

  // A roll 100 s later (new series 12, ask 40 at 60 bps): evaluated at once despite the 30 minutes.
  h.chain.roll(12n, 40n, 1_273_300n);
  h.setFair(2_000_000n);
  r = await h.tickAt(T0 + 3_700);
  pair = r.pairs[0]!;
  assert.equal(pair.why, 'new-position');
  assert.equal(pair.outcome, 'repriced');
  assert.deepEqual(h.sends[2], { args: [BEN, NVDA, 2_100_000n], gas: GAS_REPRICE, kind: 'reprice', key: key(40n) });
  assert.deepEqual(h.fairRequests.at(-1), { ticker: 'NVDA', strike: 225_000_000n, expiry: T0 + 10 * 86_400, type: 'call' });
  assert.deepEqual(h.pricer.outcomes, { repriced: 3, 'not-due': 2, 'within-threshold': 1 });
  h.store.close();
});

test('no decision, no clock: a missing fair value is retried every tick and alerted after PRICER_FAIR_ALERT_S; a stale spot asks nothing', async () => {
  const h = harness({ PRICER_FAIR_ALERT_S: '3600' });
  const pairKey = `${BEN.toLowerCase()}:${NVDA.toLowerCase()}`;
  h.setFair({ ok: false, reason: 'chain-stale' });
  let r = await h.tickAt(T0);
  assert.equal(r.pairs[0]!.outcome, 'fair-unavailable');
  assert.equal(r.pairs[0]!.detail, 'chain-stale');
  assert.equal(h.store.getMeta(fairMissingMetaKey(h.pricer.ctx.config.contracts.autoRoller, { writer: BEN, underlying: NVDA })), String(T0));
  r = await h.tickAt(T0 + 60);
  assert.equal(r.pairs[0]!.outcome, 'fair-unavailable', 'still due: nothing was decided');
  assert.equal(h.fairRequests.length, 2);
  assert.deepEqual(h.alerts, NO_ALERTS);
  await h.tickAt(T0 + 3_600);
  assert.deepEqual(h.alerts, [{ kind: 'v2_pricer_fair_unavailable', dedupeKey: pairKey, severity: undefined }]);

  // Spot stale: skipped before any /fair request; the missing-fair marker is cleared with it.
  h.chain.spot = null;
  r = await h.tickAt(T0 + 3_700);
  assert.equal(r.pairs[0]!.outcome, 'spot-stale');
  assert.equal(h.fairRequests.length, 3);
  assert.equal(h.store.getMeta(fairMissingMetaKey(h.pricer.ctx.config.contracts.autoRoller, { writer: BEN, underlying: NVDA })), null);
  assert.ok(h.cleared.includes(`v2_pricer_fair_unavailable:${pairKey}`));

  // Fair back and spot fresh: repriced on this tick.
  h.chain.spot = 212_210_000n;
  h.setFair(2_000_000n);
  r = await h.tickAt(T0 + 3_760);
  assert.equal(r.pairs[0]!.outcome, 'repriced');
  assert.equal(h.sends.length, 1);
  h.store.close();
});

test('a key the AccessManager refuses `reprice` sends nothing and pages; refused and failed sends page and are retried next tick', async () => {
  const h = harness();
  const pairKey = `${BEN.toLowerCase()}:${NVDA.toLowerCase()}`;
  h.setFair(2_000_000n);

  h.chain.canReprice = false;
  let r = await h.tickAt(T0);
  assert.equal(r.hasRole, false);
  assert.equal(r.pairs[0]!.outcome, 'no-role');
  assert.equal(r.pairs[0]!.target, 2_100_000n, 'the decision is still shown on /state');
  assert.equal(h.sends.length, 0);
  assert.deepEqual(h.alerts.map((a) => a.kind), ['v2_pricer_no_role']);

  h.chain.canReprice = true;
  h.failNext({ status: 'simulation-reverted', revert: 'BadPrice', error: 'The contract function "reprice" reverted: BadPrice()' });
  r = await h.tickAt(T0 + 30);
  assert.equal(r.pairs[0]!.outcome, 'reprice-failed');
  assert.equal(r.pairs[0]!.tx?.revert, 'BadPrice');
  assert.ok(h.cleared.includes('v2_pricer_no_role:'));
  assert.deepEqual(h.alerts.at(-1), { kind: 'v2_pricer_reprice_failed', dedupeKey: pairKey, severity: 'warn' });
  assert.equal(r.sent, 0, 'a refused simulation spends no transaction budget');

  h.failNext({ status: 'reverted', hash: HASH, nonce: 1, blockNumber: 1n, gasUsed: 90_000n });
  r = await h.tickAt(T0 + 60);
  assert.equal(r.pairs[0]!.outcome, 'reprice-failed');
  assert.equal(r.sent, 1);
  assert.deepEqual(h.alerts.at(-1), { kind: 'v2_pricer_reprice_failed', dedupeKey: pairKey, severity: 'error' });

  // Nothing above counted as an evaluation: the next tick sends again, and succeeds.
  r = await h.tickAt(T0 + 90);
  assert.equal(r.pairs[0]!.outcome, 'repriced');
  assert.equal(h.sends.length, 3);
  assert.ok(h.cleared.includes(`v2_pricer_reprice_failed:${pairKey}`));
  h.store.close();
});

test('default session gate skips overnight, reports it, and retries at the open; override permits off-hours', async () => {
  const h = harness();
  h.setFair(2_000_000n);
  h.chain.sessionOpen = false;
  let r = await h.tickAt(T0);
  assert.equal(r.sessionOpen, false);
  assert.equal(r.pairs[0]!.outcome, 'market-closed');
  assert.equal(h.fairRequests.length, 0);
  assert.equal(h.sends.length, 0);
  assert.equal((h.pricer.state() as { sessionOpen: boolean }).sessionOpen, false);
  h.chain.sessionReadFails = true;
  r = await h.tickAt(T0 + 60);
  assert.equal(r.pairs[0]!.outcome, 'session-unavailable');
  h.chain.sessionReadFails = false;
  h.chain.sessionOpen = true;
  r = await h.tickAt(T0 + 120);
  assert.equal(r.pairs[0]!.outcome, 'repriced');
  h.store.close();

  const offHours = harness({ PRICER_REPRICE_OFF_HOURS: '1' });
  offHours.chain.sessionOpen = false;
  offHours.chain.sessionReadFails = true;
  offHours.setFair(2_000_000n);
  r = await offHours.tickAt(T0);
  assert.equal(r.pairs[0]!.outcome, 'repriced');
  assert.equal(offHours.pricer.ctx.config.tuning.repriceOffHours, true);
  offHours.store.close();
});

test('what the contract would refuse is never asked about: no smart pricing, a filled or cancelled ask, an ask about to pass its cutoff, a stopped strategy', async () => {
  const h = harness();
  h.setFair(2_000_000n);
  const outcome = async (at: number) => (await h.tickAt(at)).pairs[0]!.outcome;

  h.chain.strategy = { ...h.chain.strategy, smartPricing: false };
  assert.equal(await outcome(T0), 'not-smart-pricing');
  h.chain.strategy = { ...h.chain.strategy, smartPricing: true, active: false };
  assert.equal(await outcome(T0 + 1), 'inactive');
  h.chain.strategy = { ...h.chain.strategy, active: true };
  const order = h.chain.orders.get(31n)!;
  order.filled = order.units;
  assert.equal(await outcome(T0 + 2), 'order-not-live');
  order.filled = 0n;
  assert.equal(await outcome(order.validUntil - 30), 'near-cutoff');
  h.chain.position = { ...h.chain.position, orderId: 0n };
  assert.equal(await outcome(T0 + 3), 'no-tracked-ask');
  assert.equal(h.fairRequests.length, 0);
  assert.equal(h.sends.length, 0);
  // The /state body names the reasons and the settings.
  const state = h.pricer.state() as { pairs: Array<{ outcome: string }>; settings: { edgeBps: number; repriceThresholdBps: number; minIntervalS: number } };
  assert.equal(state.pairs[0]!.outcome, 'no-tracked-ask');
  assert.deepEqual([state.settings.edgeBps, state.settings.repriceThresholdBps, state.settings.minIntervalS], [500, 1_000, 1_800]);
  h.store.close();
});

test('a store kept from another deployment at the same roller address: reset before the first tick, so the scan, not the old rows, names the strategies and the old evaluation clock is gone', async () => {
  const STALE = `65100000:0x${'d0'.repeat(32)}`;
  const ADA = getAddress('0x90f79bf6eb2c4f870365e785982e1f101e93b906');
  let roller: Address = '0x0000000000000000000000000000000000000000';
  const h = harness(
    {},
    {
      prepare: (store, strategies) => {
        roller = strategies.roller;
        assert.equal(strategies.bindAnchor(STALE), 'fresh');
        // The previous devnet: ada's strategy, a cursor past this chain's head, and ben's position (the seed's ids are
        // the same every run) evaluated on that chain's clock, a day ahead of this one.
        strategies.applyRange([{ writer: ADA, underlying: NVDA, block: 65_100_001n }], 70_000_000n);
        store.setMeta(evaluatedMetaKey(roller, { writer: BEN, underlying: NVDA }), JSON.stringify({ longId: '11', checkedAt: T0 + 86_400 }));
      },
      logs: [{ address: '0x00000000000000000000000000000000c0de0006', blockNumber: 65_100_002n, eventName: 'StrategySet', args: { writer: BEN, underlying: NVDA } }],
    },
  );
  assert.equal(roller.toLowerCase(), '0x00000000000000000000000000000000c0de0006', 'the fixture roller the scan log names');
  h.setFair(2_000_000n);
  const r = await h.tickAt(T0);
  assert.equal(r.strategies, 1);
  assert.deepEqual(r.pairs.map((p) => p.writer), [BEN], 'ada was the old deployment\'s strategy');
  assert.equal(r.pairs[0]!.outcome, 'repriced');
  assert.equal(r.pairs[0]!.why, 'new-position', 'a stale evaluation a day ahead would have read not-due');
  assert.equal(h.sends.length, 1);
  assert.equal(h.pricer.ctx.strategies.anchor(), ANCHOR);
  assert.equal(h.pricer.ctx.strategies.scannedTo(), h.chain.block);
});

test('K3-301: stale and unknown source times refuse, feed the fair-unavailable timer, and do not move the cadence clock', async () => {
  const h = harness({ PRICER_FAIR_ALERT_S: '3600' });
  const pairKey = `${BEN.toLowerCase()}:${NVDA.toLowerCase()}`;
  h.setFair({ ok: true, fair: 2_000_000n, source: 'cboe', asOf: T0 - 1_801, spot: 212_210_000n });
  let r = await h.tickAt(T0);
  assert.equal(r.pairs[0]!.outcome, 'fair-stale');
  assert.equal(h.sends.length, 0);
  assert.equal(h.store.getMeta(fairMissingMetaKey(h.pricer.ctx.config.contracts.autoRoller, { writer: BEN, underlying: NVDA })), String(T0));

  h.setFair({ ok: true, fair: 2_000_000n, source: 'cboe', asOf: null, spot: 212_210_000n });
  r = await h.tickAt(T0 + 60);
  assert.equal(r.pairs[0]!.outcome, 'asOf-unknown');
  assert.equal(h.fairRequests.length, 2, 'still due: no evaluation clock');

  await h.tickAt(T0 + 3_600);
  assert.deepEqual(h.alerts, [{ kind: 'v2_pricer_fair_unavailable', dedupeKey: pairKey, severity: undefined }]);
  h.store.close();
});

test('K3-301: 301 bps fair/oracle spot gap is refused; 300 is accepted and repriced', async () => {
  const oracle = 212_210_000n;
  const at300 = oracle + (oracle * 300n) / 10_000n;
  const at301 = oracle + (oracle * 301n) / 10_000n;
  const miss = harness();
  miss.setFair({ ok: true, fair: 2_000_000n, source: 'cboe', asOf: T0, spot: at301 });
  assert.equal((await miss.tickAt(T0)).pairs[0]!.outcome, 'fair-spot-mismatch');
  assert.equal(miss.sends.length, 0);
  miss.store.close();

  const ok = harness();
  ok.setFair({ ok: true, fair: 2_000_000n, source: 'cboe', asOf: T0, spot: at300 });
  assert.equal((await ok.tickAt(T0)).pairs[0]!.outcome, 'repriced');
  assert.equal(ok.sends.length, 1);
  ok.store.close();
});

test('K3-301: provenance quoteObservedAt can be fresh while asOf (underlying last-trade) is frozen; quote-age-unknown is not ready', async () => {
  const frozen = T0 - 86_400;
  const h = harness();
  h.setFair({
    ok: true,
    fair: 2_000_000n,
    source: 'cboe',
    asOf: frozen,
    spot: 212_210_000n,
    provenance: {
      quality: { readiness: 'ready', reasons: [] },
      clocks: { quoteObservedAt: T0 - 10, underlyingObservedAt: frozen },
      identity: { market: 'NVDA', token: { address: NVDA }, option: { side: 'call', strike: 222_500_000n, expiry: T0 + 3 * 86_400 } },
    },
  });
  assert.equal((await h.tickAt(T0)).pairs[0]!.outcome, 'repriced');
  h.store.close();

  const unknown = harness();
  unknown.setFair({
    ok: true,
    fair: 2_000_000n,
    source: 'cboe',
    asOf: T0,
    spot: 212_210_000n,
    provenance: { quality: { readiness: 'degraded', reasons: ['quote-age-unknown'] }, clocks: { quoteObservedAt: null } },
  });
  assert.equal((await unknown.tickAt(T0)).pairs[0]!.outcome, 'quote-age-unknown');
  unknown.store.close();
});

test('K3-307: clamp streak on /state, v2_pricer_clamped after 4 consecutive clamps, reset on an unclamped tick', async () => {
  const h = harness();
  const pairKey = `${BEN.toLowerCase()}:${NVDA.toLowerCase()}`;
  h.setFair(5_000_000n);
  const interval = 1_800;
  for (let i = 0; i < 3; i++) {
    const r = await h.tickAt(T0 + i * interval);
    assert.equal(r.pairs[0]!.clamped, 'ceiling');
    assert.equal(r.pairs[0]!.clampStreak, i + 1);
    assert.equal(h.alerts.some((a) => a.kind === 'v2_pricer_clamped'), false, `no page before the 4th clamp (streak ${i + 1})`);
  }
  const fourth = await h.tickAt(T0 + 3 * interval);
  assert.equal(fourth.pairs[0]!.clamped, 'ceiling');
  assert.equal(fourth.pairs[0]!.clampStreak, 4);
  assert.deepEqual(h.alerts.filter((a) => a.kind === 'v2_pricer_clamped'), [{ kind: 'v2_pricer_clamped', dedupeKey: pairKey, severity: undefined }]);
  const state = h.pricer.state() as { clampStreaks: Record<string, number>; pairs: Array<{ clampStreak: number }> };
  assert.equal(state.clampStreaks[pairKey], 4);
  assert.equal(state.pairs[0]!.clampStreak, 4);

  h.setFair(2_000_000n);
  const reset = await h.tickAt(T0 + 4 * interval);
  assert.equal(reset.pairs[0]!.clamped, null);
  assert.equal(reset.pairs[0]!.clampStreak, 0);
  assert.ok(h.cleared.includes(`v2_pricer_clamped:${pairKey}`));
  assert.equal((h.pricer.state() as { clampStreaks: Record<string, number> }).clampStreaks[pairKey], 0);
  h.store.close();
});

/*//////////////////////////////////////////////////////////////
       K8-178: RECORDED IS NOT ALERTED (the pricer's mute failures)
//////////////////////////////////////////////////////////////*/

test('K8-178: an unreadable canCall stops every reprice, never reports the revoked key healthy, and pages on its own kind at the 3rd consecutive tick', async () => {
  const h = harness();
  h.setFair(2_000_000n);
  h.chain.canCallFails = true;

  // The fact this protects: a pricer that has stopped repricing is VISIBLE. It had stopped (every pair
  // reports role-unread, nothing is sent) and said nothing at all.
  let r = await h.tickAt(T0);
  assert.equal(r.hasRole, null, 'a failed read is not an answer of false');
  assert.equal(r.pairs[0]!.outcome, 'role-unread');
  assert.equal(r.pairs[0]!.target, 2_100_000n, 'the decision is still reached and still shown on /state');
  assert.equal(h.sends.length, 0, 'nothing is sent while authority is unknown');
  assert.deepEqual(h.alerts, NO_ALERTS, 'one multicall hiccup does not page');
  assert.equal(h.cleared.includes('v2_pricer_no_role:'), false, 'an unread subject is never reported healthy');

  await h.tickAt(T0 + 60);
  assert.deepEqual(h.alerts, NO_ALERTS, 'nor does a second');

  r = await h.tickAt(T0 + 120);
  assert.deepEqual(
    h.alerts.map((a) => a.kind),
    ['v2_pricer_role_unread'],
  );
  assert.equal(h.alerts.at(-1)!.severity, 'error');
  assert.equal(r.pairs[0]!.outcome, 'role-unread');
  assert.equal(h.sends.length, 0);

  // A read that ANSWERS ends it, and only then is the page taken down.
  h.chain.canCallFails = false;
  r = await h.tickAt(T0 + 180);
  assert.equal(r.hasRole, true);
  assert.equal(r.pairs[0]!.outcome, 'repriced');
  assert.ok(h.cleared.includes('v2_pricer_role_unread:'));

  // ...and the counter restarted at zero: the next single failure must not page again.
  h.chain.canCallFails = true;
  await h.tickAt(T0 + 3 * 1_800);
  assert.equal(
    h.alerts.filter((a) => a.kind === 'v2_pricer_role_unread').length,
    1,
    'the streak restarted, so one failure after a good read is silent',
  );
  h.store.close();
});

test('K8-178: a throwing StrategySet scan pages instead of degrading to the stale list in silence, and clears when a scan gets through', async () => {
  const h = harness();
  h.setFair(2_000_000n);

  h.breakLogs('getLogs: block range limit exceeded');
  let r = await h.tickAt(T0);
  // The list still holds what EARLIER scans found, which is why this is a warn and not an error: the
  // known pair is still priced. What it cannot hold is a strategy created since, and that is the bug.
  assert.deepEqual(r.scan, { error: 'getLogs: block range limit exceeded' });
  assert.equal(r.strategies, 1, 'the pair the store already knew is still priced');
  assert.equal(r.pairs[0]!.outcome, 'repriced');
  assert.deepEqual(
    h.alerts.map((a) => a.kind),
    ['v2_pricer_strategy_scan'],
  );
  assert.equal(h.alerts.at(-1)!.severity, 'warn');

  h.breakLogs(null);
  r = await h.tickAt(T0 + 1_800);
  assert.ok(!('error' in r.scan), 'the scan got through');
  assert.ok(h.cleared.includes('v2_pricer_strategy_scan:'));
  h.store.close();
});

test('K8-178: band-empty is a completed evaluation, so it resets the clamp streak - the page means four CONSECUTIVE clamps', async () => {
  const h = harness();
  const pairKey = `${BEN.toLowerCase()}:${NVDA.toLowerCase()}`;
  const interval = 1_800;
  const goodSpot = 212_210_000n;
  // A spot this small makes minAskBps*spot round up past maxAskBps*spot on the 100-unit tick grid, so
  // priceBand returns null: a real empty band, reached through a real evaluation, not a skipped tick.
  const bandEmptySpot = 1_000n;

  h.setFair(5_000_000n);
  let r = await h.tickAt(T0);
  assert.equal(r.pairs[0]!.clamped, 'ceiling');
  assert.equal(r.pairs[0]!.clampStreak, 1);

  // clamp, band-empty, clamp, band-empty, clamp, band-empty, clamp: four clamps, none consecutive.
  // Before K8-178 the band-empty arm skipped noteClamp, so the streak survived it, reached 4, and paged
  // "clamped to the ceiling for 4 consecutive evaluations" about clamps that were three apart.
  for (let i = 1; i <= 3; i++) {
    h.chain.spot = bandEmptySpot;
    const empty = await h.tickAt(T0 + (2 * i - 1) * interval);
    assert.equal(empty.pairs[0]!.outcome, 'band-empty');
    assert.equal(empty.pairs[0]!.clampStreak, 0, 'an empty band is the absence of a target, not a clamped one');

    h.chain.spot = goodSpot;
    const clamp = await h.tickAt(T0 + 2 * i * interval);
    assert.equal(clamp.pairs[0]!.clamped, 'ceiling');
    assert.equal(clamp.pairs[0]!.clampStreak, 1, 'each clamp starts a new streak');
  }
  assert.equal(h.alerts.filter((a) => a.kind === 'v2_pricer_clamped').length, 0, 'four non-consecutive clamps do not page');

  // The signal is still there when the clamps really are consecutive: the symptom went, not the alert.
  await h.tickAt(T0 + 7 * interval);
  await h.tickAt(T0 + 8 * interval);
  const fourth = await h.tickAt(T0 + 9 * interval);
  assert.equal(fourth.pairs[0]!.clampStreak, 4);
  assert.deepEqual(h.alerts.filter((a) => a.kind === 'v2_pricer_clamped'), [{ kind: 'v2_pricer_clamped', dedupeKey: pairKey, severity: undefined }]);
  h.store.close();
});

test('T-OP-059 (F-APP-KEEPER-03): the two sequences the alert is defined over - clamp, clamp -> 2; clamp, band-empty, clamp -> 1', async () => {
  // THE DECISION, and where it comes from. `v2_pricer_clamped` is defined at the top of pricer.ts as "four
  // consecutive COMPLETED EVALUATIONS landed on the minAsk/maxAsk clamp; reset by any completed evaluation
  // that did not, band-empty included". ops/alerts.md has no section for this alert kind (a docs gap, reported
  // in the T-OP-059 ledger entry), so the code header is the stated purpose. Band-empty is a completed
  // evaluation whose target is absent, not one sitting on the clamp, so it RESETS. K8-178 implemented that;
  // this test pins the two minimal sequences by name so the decision cannot drift back silently.
  // PROVE BY BREAKING: in noteClamp, make `clamped` treat `undefined` as "leave the streak alone" (or skip
  // noteClamp on the band-empty arm again) and the second sequence goes red at `clamp, band-empty, clamp -> 1`.
  const h = harness();
  const interval = 1_800;
  const goodSpot = 212_210_000n;
  // Same construction as the K8-178 test above: a spot this small makes the band empty through a real evaluation.
  const bandEmptySpot = 1_000n;
  h.setFair(5_000_000n);

  // clamp, clamp -> 2.
  let r = await h.tickAt(T0);
  assert.equal(r.pairs[0]!.clamped, 'ceiling');
  assert.equal(r.pairs[0]!.clampStreak, 1);
  r = await h.tickAt(T0 + interval);
  assert.equal(r.pairs[0]!.clamped, 'ceiling');
  assert.equal(r.pairs[0]!.clampStreak, 2, 'clamp, clamp -> 2: consecutive clamps accumulate');

  // clamp, band-empty, clamp -> 1.
  h.chain.spot = bandEmptySpot;
  r = await h.tickAt(T0 + 2 * interval);
  assert.equal(r.pairs[0]!.outcome, 'band-empty');
  assert.equal(r.pairs[0]!.clampStreak, 0, 'band-empty is a completed evaluation that did not clamp: the streak resets');
  h.chain.spot = goodSpot;
  r = await h.tickAt(T0 + 3 * interval);
  assert.equal(r.pairs[0]!.clamped, 'ceiling');
  assert.equal(r.pairs[0]!.clampStreak, 1, 'clamp, band-empty, clamp -> 1, not 3: the clamps were not consecutive');
  assert.equal(h.alerts.filter((a) => a.kind === 'v2_pricer_clamped').length, 0, 'nothing here is four consecutive clamps');
  h.store.close();
});

test('K8-178: a tick that reached a target but sent nothing is not an evaluation, so it does not inflate the clamp streak', async () => {
  const h = harness();
  h.setFair(5_000_000n); // clamps to the ceiling...
  h.chain.canReprice = false; // ...and nothing may be sent, so the clock never moves and the pair is due again next tick.

  for (let i = 0; i < 6; i++) {
    const r = await h.tickAt(T0 + i * 60);
    assert.equal(r.pairs[0]!.outcome, 'no-role');
    assert.equal(r.pairs[0]!.clamped, 'ceiling', 'the target was still reached and is still shown');
    assert.equal(r.pairs[0]!.clampStreak, undefined, 'and it was not counted as an evaluation');
  }
  assert.equal(
    h.alerts.filter((a) => a.kind === 'v2_pricer_clamped').length,
    0,
    'six blocked ticks are not four clamped evaluations: the operator is sent after the manager, not after a clamp',
  );
  assert.deepEqual(new Set(h.alerts.map((a) => a.kind)), new Set(['v2_pricer_no_role']));
  assert.deepEqual((h.pricer.state() as { clampStreaks: Record<string, number> }).clampStreaks, {});
  h.store.close();
});

/*//////////////////////////////////////////////////////////////
                         GET /ready (T-423)
//////////////////////////////////////////////////////////////*/

const NOW_MS = T0 * 1_000;
/** fairReadyBoundMs at the defaults: max(7,200 s, 1,800 s) + 3 × 60 s. */
const BOUND_MS = 7_380_000;
const READY_FACTS: PricerReadinessFacts = {
  alive: true,
  completedTicks: 1,
  lastTickFailed: false,
  role: { read: true, immediate: true, delay: 0 },
  lastQualifiedFairAt: NOW_MS - 60_000,
  lastEvaluationAt: NOW_MS - 60_000,
};

test('T-423 fairReadyBoundMs: max(PRICER_FAIR_ALERT_S, PRICER_MIN_INTERVAL_S) plus three poll intervals', () => {
  assert.equal(fairReadyBoundMs({ fairAlertS: 7_200, minIntervalS: 1_800 }, 60_000), BOUND_MS);
  assert.equal(fairReadyBoundMs({ fairAlertS: 600, minIntervalS: 1_800 }, 60_000), 1_980_000, 'never below the cadence, or a healthy pricer reads unready between evaluations');
  const config = pricerConfig();
  assert.equal(fairReadyBoundMs(config.tuning, config.pollIntervalMs), BOUND_MS, 'what loadV2Config defaults to');
});

test('T-423 evaluatePricerReadiness: ready only when all four hold; each failing ALONE is not ready and names exactly its reason', () => {
  assert.deepEqual(evaluatePricerReadiness(READY_FACTS, BOUND_MS, NOW_MS), { ready: true, reasons: [], lastEvaluationAt: NOW_MS - 60_000 });
  assert.equal(evaluatePricerReadiness({ ...READY_FACTS, lastQualifiedFairAt: NOW_MS - BOUND_MS }, BOUND_MS, NOW_MS).ready, true, 'at the bound: still ready');

  const alone: Array<[string, Partial<PricerReadinessFacts>, ReadyReason]> = [
    ['1. the loop is wedged: /health would answer 503', { alive: false }, 'loop-wedged'],
    ['2. no tick has completed', { completedTicks: 0 }, 'no-completed-tick'],
    ['2. the latest tick threw', { lastTickFailed: true }, 'tick-failed'],
    ['3. canCall never read', { role: null }, 'role-unread'],
    ['3. the canCall READ failed: unknown is not ready (forbidden fix (b))', { role: { read: false } }, 'role-unread'],
    ['3. canCall answered an unparseable delay', { role: { read: true, immediate: true, delay: Number.NaN } }, 'role-unread'],
    ['3. canCall answered (false, 0): not a member, or the selector is unmapped', { role: { read: true, immediate: false, delay: 0 } }, 'role-refused'],
    ['3. canCall answered (false, 3600): a member whose every call must be scheduled', { role: { read: true, immediate: false, delay: 3_600 } }, 'role-delayed'],
    ['3. immediate with a delay is not zero delay', { role: { read: true, immediate: true, delay: 1 } }, 'role-delayed'],
    ['4. no qualified fair value, ever', { lastQualifiedFairAt: null }, 'fair-stale'],
    ['4. the latest qualified fair value is past the bound', { lastQualifiedFairAt: NOW_MS - BOUND_MS - 1 }, 'fair-stale'],
  ];
  for (const [what, change, reason] of alone) {
    assert.deepEqual(evaluatePricerReadiness({ ...READY_FACTS, ...change }, BOUND_MS, NOW_MS), { ready: false, reasons: [reason], lastEvaluationAt: READY_FACTS.lastEvaluationAt }, what);
  }

  // Before the first tick nothing is known: not ready, and every unknown is named.
  assert.deepEqual(evaluatePricerReadiness({ alive: true, completedTicks: 0, lastTickFailed: false, role: null, lastQualifiedFairAt: null, lastEvaluationAt: null }, BOUND_MS, NOW_MS), {
    ready: false,
    reasons: ['no-completed-tick', 'role-unread', 'fair-stale'],
    lastEvaluationAt: null,
  });
});

test('T-423 readiness through the tick: a failed canCall read is role-unread AT ONCE, not at the 3rd tick like the page; a throwing tick is tick-failed', async () => {
  const h = harness();
  const readiness = () => h.pricer.readiness(true, Date.now());
  assert.deepEqual(readiness(), { ready: false, reasons: ['no-completed-tick', 'role-unread', 'fair-stale'], lastEvaluationAt: null }, 'before the first tick');

  h.setFair(2_000_000n);
  assert.equal((await h.tickAt(T0)).pairs[0]!.outcome, 'repriced');
  const ready = readiness();
  assert.deepEqual([ready.ready, ready.reasons], [true, []]);
  assert.equal(typeof ready.lastEvaluationAt, 'number', 'the repriced evaluation was stamped');

  h.chain.canCallFails = true;
  assert.equal((await h.tickAt(T0 + 600)).hasRole, null);
  assert.deepEqual(readiness().reasons, ['role-unread']);
  assert.equal(h.alerts.filter((a) => a.kind === 'v2_pricer_role_unread').length, 0, 'the page waits for ROLE_UNREAD_TICKS; readiness does not');

  h.chain.canCallFails = false;
  h.chain.canReprice = false;
  await h.tickAt(T0 + 660);
  assert.deepEqual(readiness().reasons, ['role-refused']);

  h.chain.repriceDelay = 3_600;
  await h.tickAt(T0 + 720);
  assert.deepEqual(readiness().reasons, ['role-delayed']);

  h.chain.canReprice = true;
  h.chain.repriceDelay = 0;
  await h.tickAt(T0 + 780);
  assert.equal(readiness().ready, true, 'the role answers (true, 0) again');

  // A tick that throws before its canCall read leaves the previous tick's answer in place - which is
  // exactly why a failed latest tick is its own reason: that answer is not evidence about now.
  h.chain.headFails = true;
  await assert.rejects(h.tickAt(T0 + 840), /head unavailable/);
  assert.deepEqual(readiness().reasons, ['tick-failed']);

  h.chain.headFails = false;
  assert.equal((await h.tickAt(T0 + 900)).pairs[0]!.outcome, 'not-due');
  assert.deepEqual(readiness(), { ready: true, reasons: [], lastEvaluationAt: ready.lastEvaluationAt }, 'no evaluation since the first: its stamp stands');
  h.store.close();
});

test('T-423 an unqualified fair value is not a qualified one: fair-stale, alone', async () => {
  const h = harness();
  h.setFair({ ok: false, reason: 'pricing service down' });
  assert.equal((await h.tickAt(T0)).pairs[0]!.outcome, 'fair-unavailable');
  assert.deepEqual(h.pricer.readiness(true, Date.now()), { ready: false, reasons: ['fair-stale'], lastEvaluationAt: null });
  h.store.close();
});

test('T-423 GET /ready on the pricer app: /health liveness is an input, never the answer; no signer, contract, RPC or db in the body', async () => {
  const h = harness();
  const config = h.pricer.ctx.config;
  let now = Date.now();
  const health = new ModeHealth(now);
  const app = createModeHealthApp({
    mode: 'pricer',
    health,
    limits: { pollIntervalMs: config.pollIntervalMs, txTimeoutMs: config.txTimeoutMs, rpcLagAlertMs: config.rpcLagAlertMs, minGasWei: config.minGasWei },
    chainId: config.chainId,
    rpcUrls: config.rpcUrls,
    signer: SIGNER,
    contracts: config.contracts,
    store: h.store,
    routes: pricerReadyRoute(h.pricer, health, config, () => now),
    now: () => now,
  });
  const read = async () => {
    const res = await app.request('/ready');
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  // Starting: /health answers 200 (the grace window), and /ready still says not ready - forbidden fix (a).
  assert.equal((await app.request('/health')).status, 200);
  let r = await read();
  assert.equal(r.status, 503);
  assert.deepEqual(r.body.reasons, ['no-completed-tick', 'role-unread', 'fair-stale']);

  h.setFair(2_000_000n);
  await h.tickAt(T0);
  health.beat(now);
  r = await read();
  assert.equal(r.status, 200);
  assert.equal(r.body.ready, true);
  assert.equal(r.body.interfaceVersion, INTERFACE_VERSION);
  assert.deepEqual(Object.keys(r.body).sort(), ['checkedAt', 'interfaceVersion', 'lastEvaluationAt', 'ready', 'reasons']);
  const raw = JSON.stringify(r.body).toLowerCase();
  const privateValues: Array<[string, string]> = [
    ['signer', SIGNER],
    ['autoRoller', config.contracts.autoRoller],
    ['accessManager', config.contracts.accessManager],
    ['rpc', new URL(config.rpcUrls[0]).host],
    ['pricing', new URL(config.pricingUrl).host],
    ['db', h.store.path],
  ];
  for (const [what, value] of privateValues) assert.equal(raw.includes(value.toLowerCase()), false, `/ready carries the ${what}`);

  // Three poll intervals with no beat and no tick in flight: /health's 503 is /ready's loop-wedged, alone.
  now += 3 * config.pollIntervalMs;
  assert.equal((await app.request('/health')).status, 503);
  r = await read();
  assert.equal(r.status, 503);
  assert.deepEqual(r.body.reasons, ['loop-wedged']);
  h.store.close();
});

test('T-437: the spot that judges an ask comes from its SERIES\' pinned oracle, never the market\'s pointer', async () => {
  // A setMarketOracle moved the market's pointer to an oracle reading past the strike. `reprice` reads the oracle the
  // SERIES pinned (T-310), which is still short of it, so the ask is repriced — a pricer that read the market's would
  // answer in-the-money and skip a reprice the contract would have accepted.
  const h = harness();
  h.chain.series.get(11n)!.oracle = SERIES_ORACLE_A;
  h.chain.spotByOracle.set(SERIES_ORACLE_A.toLowerCase(), 212_210_000n); // short of the 222.500000 strike
  h.chain.spotByOracle.set(MARKET_ORACLE.toLowerCase(), 230_000_000n); // past it
  h.setFair(2_000_000n);

  const r = await h.tickAt(T0);
  assert.equal(r.pairs[0]!.outcome, 'repriced');
  assert.equal(r.pairs[0]!.spot, 212_210_000n, 'the series oracle\'s price, not the market pointer\'s');
  assert.deepEqual(h.chain.spotFrom, [SERIES_ORACLE_A.toLowerCase()], 'exactly one trySpot, to the oracle the series pinned');
  assert.ok(!h.chain.spotFrom.includes(MARKET_ORACLE.toLowerCase()), 'market(u).oracle is never asked for an existing series');
});

test('T-437: two series on ONE underlying with different pinned oracles are each priced on their own', async () => {
  const h = harness();
  h.chain.series.get(11n)!.oracle = SERIES_ORACLE_A;
  h.chain.series.get(12n)!.oracle = SERIES_ORACLE_B;
  h.chain.spotByOracle.set(SERIES_ORACLE_A.toLowerCase(), 212_210_000n); // short of series 11's 222.500000
  h.chain.spotByOracle.set(SERIES_ORACLE_B.toLowerCase(), 240_000_000n); // past series 12's 225.000000
  h.chain.spotByOracle.set(MARKET_ORACLE.toLowerCase(), 212_210_000n); // reading this one would price BOTH: the bug
  h.setFair(2_000_000n);

  let r = await h.tickAt(T0);
  assert.equal(r.pairs[0]!.outcome, 'repriced');
  assert.deepEqual(h.chain.spotFrom, [SERIES_ORACLE_A.toLowerCase()]);

  // The strategy rolls into the other series under the SAME underlying. Same market, same pointer, different pin.
  h.chain.spotFrom.length = 0;
  h.chain.roll(12n, 41n, 1_273_300n);
  r = await h.tickAt(T0 + 3_600);
  assert.deepEqual(h.chain.spotFrom, [SERIES_ORACLE_B.toLowerCase()], 'the second series is judged on ITS oracle');
  assert.equal(r.pairs[0]!.outcome, 'in-the-money', 'past its strike on its own oracle: reprice would revert InTheMoney');
  assert.equal(h.sends.length, 1, 'nothing more is sent');
});

test('T-437: a series with no pinned oracle is priced on no oracle at all', async () => {
  // Fail closed. Without the oracle the contract would use, no other oracle's price stands in for it.
  const h = harness();
  h.chain.series.get(11n)!.oracle = getAddress('0x0000000000000000000000000000000000000000');
  h.setFair(2_000_000n);

  const r = await h.tickAt(T0);
  assert.deepEqual(h.chain.spotFrom, [], 'no trySpot is issued to any oracle');
  assert.equal(r.pairs[0]!.spot, null);
  assert.equal(h.sends.length, 0, 'nothing is repriced on an unknown oracle');
});
