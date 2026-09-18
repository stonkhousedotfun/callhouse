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
 * reads its strategies or its evaluation clock.
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
import { silentLogger } from '../logger.js';
import { V2Store } from '../store.js';
import type { ExecuteOptions, TxOutcome, WriteCall } from '../tx.js';
import type { FairAnswer, FairRequest } from './fair-client.js';
import { GAS_REPRICE, PRICER_ROLE, Pricer, evaluatedMetaKey, fairMissingMetaKey, type PricerClient } from './pricer.js';
import { StrategyIndex } from './strategies.js';

const REGISTRY = fileURLToPath(new URL('../fixtures/registry-v2.json', import.meta.url));
const BEN = getAddress('0x15d34aaf54267db7d7c367839aaf71a00a2c6a65');
const NVDA = getAddress('0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC');
const SIGNER = getAddress('0xa0Ee7A142d267C1f36714E4a8F75612F20a79720');
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
  hasRole = true;
  strategy = { active: true, weekly: true, smartPricing: true, otmBps: 500, askBps: 60, minAskBps: 30, maxAskBps: 150, maxUnits: 1_000n };
  position = { longId: 11n, orderId: 31n, expiry: T0 + 3 * 86_400 };
  spot: bigint | null = 212_210_000n;
  orders = new Map<bigint, Order>([[31n, { maker: BEN, longId: 11n, kind: 2, price: 1_273_300n, units: 1_000n, filled: 200n, validUntil: T0 + 3 * 86_400 - 1_800, cancelled: false }]]);
  series = new Map<bigint, { underlying: Address; isPut: boolean; expiry: number; strike: bigint }>([
    [11n, { underlying: NVDA, isPut: false, expiry: T0 + 3 * 86_400, strike: 222_500_000n }],
    [12n, { underlying: NVDA, isPut: false, expiry: T0 + 10 * 86_400, strike: 225_000_000n }],
  ]);
  nextOrderId = 32n;

  private view(fn: string, args: readonly unknown[]): unknown {
    switch (fn) {
      case 'hasRole':
        assert.equal(args[0], PRICER_ROLE);
        return this.hasRole;
      case 'strategy':
        return this.strategy;
      case 'position':
        return [this.position.longId, this.position.orderId, this.position.expiry];
      case 'market':
        return { enabled: true, mintPaused: false, strikeTick: 2_500_000n, exerciseFeeBps: 50, oracle: getAddress('0x00000000000000000000000000000000c0de0003') };
      case 'trySpot':
        return [this.spot !== null, this.spot ?? 0n, BigInt(this.timestamp)];
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
      getBlock: (async (args?: { blockNumber?: bigint }) =>
        args?.blockNumber !== undefined ? { number: args.blockNumber, hash: DEPLOY_HASH, timestamp: 0n } : { number: this.block, hash: HASH, timestamp: BigInt(this.timestamp) }) as never,
      getBlockNumber: (async () => this.block) as never,
      multicall: (async ({ contracts }: { contracts: Array<{ functionName: string; args?: readonly unknown[] }> }) =>
        contracts.map((c) => {
          try {
            return { status: 'success', result: this.view(c.functionName, c.args ?? []) };
          } catch (error) {
            return { status: 'failure', error };
          }
        })) as never,
      readContract: (async (c: { functionName: string; args?: readonly unknown[] }) => this.view(c.functionName, c.args ?? [])) as never,
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
  tickAt(timestamp: number): ReturnType<Pricer['tick']>;
}

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
  let fair: FairAnswer = { ok: false, reason: 'unset' };
  let nextOutcome: TxOutcome | null = null;
  const pricer = new Pricer({
    config,
    log: silentLogger(),
    client: chain.client(),
    logClient: { getBlockNumber: (async () => 10n ** 12n) as never, getLogs: (async () => options.logs ?? []) as never },
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
      fair = typeof answer === 'bigint' ? { ok: true, fair: answer, source: 'cboe', asOf: T0 - 3_600 } : answer;
    },
    failNext: (outcome) => {
      nextOutcome = outcome;
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
  assert.deepEqual(h.alerts, []);
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

test('a key without PRICER_ROLE sends nothing and pages; refused and failed sends page and are retried next tick', async () => {
  const h = harness();
  const pairKey = `${BEN.toLowerCase()}:${NVDA.toLowerCase()}`;
  h.setFair(2_000_000n);

  h.chain.hasRole = false;
  let r = await h.tickAt(T0);
  assert.equal(r.hasRole, false);
  assert.equal(r.pairs[0]!.outcome, 'no-role');
  assert.equal(r.pairs[0]!.target, 2_100_000n, 'the decision is still shown on /state');
  assert.equal(h.sends.length, 0);
  assert.deepEqual(h.alerts.map((a) => a.kind), ['v2_pricer_no_role']);

  h.chain.hasRole = true;
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
