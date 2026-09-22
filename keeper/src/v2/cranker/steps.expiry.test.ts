/**
 * The cranker's expiry steps (settle, prune, redeem, housekeeping) through the real steps on a fake chain.
 *
 * WHY THIS FILE EXISTS: the failures pinned here only show when the planner's decisions meet what the chain answers:
 * a broadcast that never reaches the sequencer must page; a resale ask whose maker rejects the refund must not keep its
 * expiry (and, two hundred such keys later, every newer expiry) from being finished; a prune or redeem chunk that runs
 * out of gas as a whole must be split down to the order or holder that causes it instead of being dropped every tick;
 * a large backlog must page once per expiry, not once per token.
 *
 * DELIBERATELY ABSENT: an RPC. The client answers multicall, readContract and getBlock from tables; the sender
 * simulates from per-function handlers, honours isAdvanced and worthSending like tx.ts, and applies the effect.
 * ops/devnet (v2:devnet-cycle) runs the same code on a chain.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getAddress, type Address } from 'viem';
import { loadV2Config, type CrankerConfig } from '../config.js';
import { silentLogger } from '../logger.js';
import { longIdOf, shortIdOf } from '../seriesId.js';
import { V2Store } from '../store.js';
import type { TxOutcome } from '../tx.js';
import { CrankAlerts, type CrankSender, type FixedGasCall } from './effects.js';
import { CrankerIndex } from './index-store.js';
import { yieldDeadlineMs } from './planner.js';
import { settledSeenMetaKey, snapshotMetaKey, stepHousekeeping, stepPrune, stepRedeem, stepSettle, stepSnapshot, unprunableMetaKey, type CrankContext } from './steps.js';

const REGISTRY = fileURLToPath(new URL('../fixtures/registry-v2.json', import.meta.url));
const CH = getAddress('0x2256c045245288A314048aD2d71006a564343C63');
const BOOK = getAddress('0x9bE1c0b1E4f9C6e4dC8e3cA7B2f1e0a9D8c7b6A5');
const ORACLE = getAddress('0x4b8c2BEFfecbdc4BeD6e6826e62093F0Cf635E78');
const USDG = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
const U = getAddress('0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec');
const ZERO = '0x0000000000000000000000000000000000000000' as const;
const E = 1_789_934_400;

export interface FakeOrder {
  maker: Address;
  longId: bigint;
  kind: number;
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
}

export interface FakeSeries {
  underlying: Address;
  isPut: boolean;
  strike: bigint;
  expiry: number;
  oracle: Address;
  settled: boolean;
  settlementPrice: bigint;
  longPayoutPerUnit: bigint;
  shortPayoutPerUnit: bigint;
}

type Simulated = { ok: true; result: unknown; apply?: () => void } | { ok: false; revert: string | null };
type SimHandler = (args: readonly unknown[], gas: bigint) => Simulated;

export function harness() {
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
    V2_ORDER_BOOK: BOOK,
  }) as CrankerConfig;

  const state = {
    now: E + 3_600,
    block: 65_000_000n,
    status: 2 as number,
    openInterest: 0n,
    series: new Map<string, FakeSeries>(),
    supply: new Map<string, bigint>(),
    balances: new Map<string, bigint>(),
    orders: new Map<bigint, FakeOrder>(),
    accruedFees: new Map<string, bigint>(),
    /**
     * T-496. State AT A PAST BLOCK, keyed by block number, for the post-reads the cranker pins to a
     * receipt's block. Empty by default, so a test that registers nothing sees head exactly as before.
     *
     * The cranker's post-reads (`settledAtBlock`, `deadAtBlock`, `stillHeldAtBlock`) run at
     * `outcome.blockNumber`, NOT at head. `multicallMany` omits the key entirely when the pin is
     * undefined (chain.ts:219), which viem reads as head — so a fake that answered every block from the
     * live `state` could not fail when the pin was dropped, and none of these tests could see whether
     * the block reached the RPC.
     */
    atBlock: new Map<string, Record<string, (args: readonly unknown[]) => unknown>>(),
    sendFails: false,
    sim: {} as Record<string, SimHandler>,
    sends: [] as Array<{ fn: string; args: readonly unknown[]; gas: bigint; status: TxOutcome['status'] }>,
    simulations: [] as Array<{ fn: string; args: readonly unknown[]; gas: bigint }>,
  };

  const orderIdsOf = (longId: bigint) => [...state.orders.entries()].filter(([, o]) => o.longId === longId).map(([id]) => id);
  const views: Record<string, (args: readonly unknown[]) => unknown> = {
    openInterest: () => state.openInterest,
    settlementPrice: () => [state.status, 0n],
    candidate: () => [0n, 0, false, 0],
    settlementInfo: () => [state.status, 0n, 0, true, false, true],
    recordedSources: () => [[], [], [], 0],
    settlementConfig: () => [true, [], 150, 21_600, 90_000],
    series: ([id]) => state.series.get(String(id)),
    totalSupply: ([id]) => state.supply.get(String(id)) ?? 0n,
    seriesOrderCount: ([id]) => BigInt(orderIdsOf(id as bigint).length),
    ordersOfSeries: ([id, cursor, limit]) => {
      const ids = orderIdsOf(id as bigint);
      const from = Number(cursor);
      const page = ids.slice(from, from + Number(limit));
      const next = from + page.length;
      return [page, next >= ids.length ? 0n : BigInt(next)];
    },
    getOrders: ([ids]) => (ids as bigint[]).map((id) => state.orders.get(id) ?? { maker: ZERO, longId: 0n, kind: 0, price: 0n, units: 0n, filled: 0n, validUntil: 0, cancelled: false }),
    payoutAdapter: () => ZERO,
    balanceOf: ([holder, id]) => state.balances.get(`${String(holder).toLowerCase()}:${id}`) ?? 0n,
    thirdPartyRedeemAllowed: () => true,
    payoutPrefs: () => [false, false],
    accruedFees: ([asset]) => state.accruedFees.get(String(asset).toLowerCase()) ?? 0n,
  };
  /** T-496. The views as of `blockNumber`: a registered past block, else head. An absent pin IS head. */
  const viewsAt = (blockNumber?: bigint) => {
    const past = blockNumber === undefined ? undefined : state.atBlock.get(String(blockNumber));
    return past === undefined ? views : { ...views, ...past };
  };
  const client = {
    getBlock: async () => ({ number: state.block, timestamp: BigInt(state.now) }),
    getBlockNumber: async () => state.block,
    getGasPrice: async () => 1n,
    multicall: async ({ contracts, blockNumber }: { contracts: Array<{ functionName: string; args?: readonly unknown[] }>; blockNumber?: bigint }) => {
      const at = viewsAt(blockNumber);
      return contracts.map((c) => {
        const handler = at[c.functionName];
        if (handler === undefined) return { status: 'failure', error: new Error(`no view ${c.functionName}`) };
        return { status: 'success', result: handler(c.args ?? []) };
      });
    },
    readContract: async ({ functionName, args = [], blockNumber }: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      const handler = viewsAt(blockNumber)[functionName];
      if (handler === undefined) throw new Error(`no readContract ${functionName}`);
      return handler(args);
    },
  };

  const sender: CrankSender = {
    dryRun: false,
    account: '0x000000000000000000000000000000000000beef',
    async execute(call: FixedGasCall, opts): Promise<TxOutcome> {
      const args = call.args as readonly unknown[];
      if (opts.isAdvanced !== undefined && (await opts.isAdvanced())) return { status: 'already-advanced' };
      state.simulations.push({ fn: call.functionName, args, gas: call.gas });
      const handler = state.sim[call.functionName];
      const simulated: Simulated = handler === undefined ? { ok: true, result: true } : handler(args, call.gas);
      if (!simulated.ok) return { status: 'simulation-reverted', revert: simulated.revert, error: 'execution reverted' };
      if (opts.worthSending !== undefined && !opts.worthSending(simulated.result)) return { status: 'no-op', result: simulated.result };
      if (state.sendFails) {
        state.sends.push({ fn: call.functionName, args, gas: call.gas, status: 'send-failed' });
        return { status: 'send-failed', error: 'HTTP request failed.' };
      }
      // T-496. The block this tx MINED IN, captured before `apply` runs. A receipt reports where it
      // landed, not where head drifted to afterwards, and an `apply` that advances head (as the
      // post-read tests do) must not be able to rewrite its own receipt's block.
      const minedAt = state.block;
      simulated.apply?.();
      state.sends.push({ fn: call.functionName, args, gas: call.gas, status: 'confirmed' });
      return { status: 'confirmed', hash: `0x${'ab'.repeat(32)}`, nonce: 1, blockNumber: minedAt, gasUsed: 1n, result: simulated.result };
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
    addresses: { clearinghouse: CH, orderBook: BOOK, settlementOracle: ORACLE, expiryCalendar: config.contracts.expiryCalendar, autoRoller: null, feeSplitter: null, multicall3: config.multicall3 },
    store,
    index,
    sender,
    alerts: new CrankAlerts(alerter as never, store, false),
    indexer: null,
  };

  /** A settled call series of expiry E at `strike`, indexed, with the given supplies. */
  const addSeries = (strike: bigint, over: Partial<FakeSeries> = {}, supplies: { long?: bigint; short?: bigint } = {}) => {
    const longId = longIdOf(U, false, strike, E);
    state.series.set(longId.toString(), { underlying: U, isPut: false, strike, expiry: E, oracle: ORACLE, settled: true, settlementPrice: 0n, longPayoutPerUnit: 0n, shortPayoutPerUnit: 1n, ...over });
    state.supply.set(longId.toString(), supplies.long ?? 0n);
    state.supply.set(shortIdOf(longId).toString(), supplies.short ?? 0n);
    index.applyRange({ series: [{ longId, underlying: U, isPut: false, strike, expiry: E, oracle: ORACLE }], holders: [], orders: [], strategies: [], block: state.block }, state.block);
    return longId;
  };

  return { ctx, state, store, index, alerts, addSeries, key: { oracle: ORACLE, underlying: U, expiry: E } };
}

test('a broadcast that fails (send-failed) pages v2_tx_revert: a primary that reads but will not send must not be silent', async () => {
  const h = harness();
  h.state.accruedFees.set(USDG.toLowerCase(), 5_000_000n);
  h.state.sendFails = true;
  const report = await stepHousekeeping(h.ctx, USDG);
  assert.deepEqual(report.actions.map((a) => a.status), ['send-failed']);
  const pages = h.alerts.filter((a) => a.kind === 'v2_tx_revert');
  assert.equal(pages.length, 1, JSON.stringify(h.alerts));
  assert.match(pages[0]!.message, /sweepFees/);
  assert.match(pages[0]!.message, /could not be broadcast/);
  assert.equal(pages[0]!.dedupeKey, `sweepFees:${USDG.toLowerCase()}`);
});

const MAKER = getAddress('0x90F79bf6EB2c4f870365E785982E1f101E93b906');
const REJECTING = getAddress('0x00000000000000000000000000000000000000Bd');

/** OrderBook.prune on the fake book: a refund to REJECTING fails. Starved of gas by its hook, a chunk holding it runs out
 *  of gas as a whole; alone with ample gas, prune skips it and returns what it pruned. */
function bookPrune(h: ReturnType<typeof harness>): SimHandler {
  return (args, gas) => {
    const ids = args[0] as bigint[];
    const live = ids.filter((id) => {
      const o = h.state.orders.get(id);
      return o !== undefined && !o.cancelled && o.filled < o.units && h.state.now >= o.validUntil;
    });
    const rejecting = live.filter((id) => h.state.orders.get(id)!.maker === REJECTING && h.state.orders.get(id)!.kind === 1);
    if (rejecting.length > 0 && gas < h.ctx.config.tuning.txGasCap) return { ok: false, revert: null };
    const prunable = live.filter((id) => !rejecting.includes(id));
    return { ok: true, result: BigInt(prunable.length), apply: () => prunable.forEach((id) => (h.state.orders.get(id)!.cancelled = true)) };
  };
}

test('prune: a resale ask whose maker burns the refund gas no longer sinks its whole chunk; honest orders are pruned, it is isolated and marked, and its expiry finishes', async () => {
  const h = harness();
  const longId = h.addSeries(200_000_000n);
  const order = (maker: Address, kind: number): FakeOrder => ({ maker, longId, kind, price: 1_000_000n, units: 100n, filled: 0n, validUntil: E - 1_800, cancelled: false });
  h.state.orders.set(1n, order(REJECTING, 1));
  h.state.orders.set(2n, order(MAKER, 1));
  h.state.orders.set(3n, order(MAKER, 0));
  h.state.sim.prune = bookPrune(h);

  const pruned = await stepPrune(h.ctx, [h.key]);
  assert.deepEqual(
    h.state.sends.filter((s) => s.fn === 'prune').map((s) => (s.args[0] as bigint[]).join(',')).sort(),
    ['2', '3'],
    'every honest order was pruned despite sharing a chunk with the rejecting one',
  );
  assert.equal(h.state.orders.get(2n)!.cancelled && h.state.orders.get(3n)!.cancelled, true);
  assert.equal(pruned.notes.pruned, 2);
  assert.deepEqual(pruned.notes.unprunable, ['1']);
  assert.notEqual(h.store.getMeta(unprunableMetaKey(1n)), null);

  // The next steps see no order left to prune: the expiry is done and later ticks stop surveying it.
  h.state.simulations.length = 0;
  await stepPrune(h.ctx, [h.key]);
  assert.equal(h.state.simulations.filter((s) => s.fn === 'prune').length, 0, 'the marked order is not simulated again');
  await stepRedeem(h.ctx, [h.key]);
  assert.equal(h.index.doneExpiries().size, 1, 'an order the book will never prune does not keep its expiry open');
});

test('prune: a chunk that reverts without data because the RPC is down is left for the next tick, never bisected or marked', async () => {
  const h = harness();
  const longId = h.addSeries(200_000_000n);
  for (const id of [1n, 2n, 3n]) h.state.orders.set(id, { maker: MAKER, longId, kind: 0, price: 1_000_000n, units: 100n, filled: 0n, validUntil: E - 1_800, cancelled: false });
  const sender = h.ctx.sender;
  h.ctx.sender = { ...sender, execute: async (call, opts) => (call.functionName === 'prune' ? { status: 'simulation-reverted', revert: null, error: 'HTTP request failed.', transportError: true } : sender.execute(call, opts)) };
  const report = await stepPrune(h.ctx, [h.key]);
  assert.deepEqual(report.actions.map((a) => a.status), ['simulation-reverted']);
  assert.equal(h.store.getMeta(unprunableMetaKey(1n)), null);
});

/** Clearinghouse.redeemBatch on the fake chain: each holder really costs `each` gas. Short of that for the whole chunk,
 *  a holder runs out of gas mid-batch and the next one's cold reads revert the call as a whole (no data). */
function chRedeemBatch(h: ReturnType<typeof harness>, each: bigint): SimHandler {
  return (args, gas) => {
    const [tokenId, holders] = args as [bigint, Address[]];
    if (gas < 60_000n + each * BigInt(holders.length)) return { ok: false, revert: null };
    return { ok: true, result: BigInt(holders.length), apply: () => holders.forEach((a) => h.state.balances.set(`${a.toLowerCase()}:${tokenId}`, 0n)) };
  };
}

test('redeem: a chunk that runs out of gas as a whole (a holder costs more than its budget) is split until it fits, not dropped every tick', async () => {
  const h = harness();
  const longId = h.addSeries(200_000_000n, { longPayoutPerUnit: 10n ** 16n, shortPayoutPerUnit: 0n }, { long: 1_700n });
  const holders = Array.from({ length: 17 }, (_, i) => getAddress(`0x${(i + 1).toString(16).padStart(40, '0')}`));
  for (const a of holders) h.state.balances.set(`${a.toLowerCase()}:${longId}`, 100n);
  h.index.applyRange({ series: [], holders: holders.map((holder) => ({ tokenId: longId, holder })), orders: [], strategies: [], block: h.state.block }, h.state.block);
  // 200k a holder against the 180k in-kind budget: 17 holders fit one 8M chunk by budget, not by what they cost.
  h.state.sim.redeemBatch = chRedeemBatch(h, 200_000n);

  const report = await stepRedeem(h.ctx, [h.key]);
  const sent = h.state.sends.filter((s) => s.fn === 'redeemBatch');
  assert.ok(sent.length >= 2, JSON.stringify(report.actions.map((a) => a.status)));
  assert.equal(sent.reduce((n, s) => n + (s.args[1] as Address[]).length, 0), 17, 'every holder was redeemed');
  assert.ok(holders.every((a) => h.state.balances.get(`${a.toLowerCase()}:${longId}`) === 0n));
});

/*//////////////////////////////////////////////////////////////
    T-462: A MINED BATCH THAT DID LESS THAN ITS SIMULATION
//////////////////////////////////////////////////////////////*/

// The sender's confirmed outcome carries the SIMULATED result (tx.ts), and redeemBatch and prune each swallow a
// per-item failure, so the receipt reads success either way. These handlers make the two diverge: the simulation
// reports every item done, and the mined effect (`apply`) leaves one item as it was.

test('redeem: a holder the MINED batch skipped is not counted redeemed from the simulation; its expiry stays open and the backlog counts it (T-462)', async () => {
  const h = harness();
  const longId = h.addSeries(200_000_000n, { longPayoutPerUnit: 10n ** 16n, shortPayoutPerUnit: 0n }, { long: 300n });
  const holders = [0xa1, 0xa2, 0xa3].map((n) => getAddress(`0x${n.toString(16).padStart(40, '0')}`));
  const SKIPPED = holders[1]!;
  for (const a of holders) h.state.balances.set(`${a.toLowerCase()}:${longId}`, 100n);
  h.index.applyRange({ series: [], holders: holders.map((holder) => ({ tokenId: longId, holder })), orders: [], strategies: [], block: h.state.block }, h.state.block);
  // Settled two hours ago, so a holder left behind is old enough for the backlog page.
  h.store.setMeta(settledSeenMetaKey(longId), String(h.state.now - 7_200));
  h.state.sim.redeemBatch = (args) => {
    const [tokenId, batch] = args as [bigint, Address[]];
    return { ok: true, result: BigInt(batch.length), apply: () => batch.filter((a) => a !== SKIPPED).forEach((a) => h.state.balances.set(`${a.toLowerCase()}:${tokenId}`, 0n)) };
  };

  const report = await stepRedeem(h.ctx, [h.key]);
  assert.deepEqual(h.state.sends.filter((s) => s.fn === 'redeemBatch').map((s) => s.status), ['confirmed'], 'one chunk, and its receipt reads success');
  assert.equal(h.state.balances.get(`${SKIPPED.toLowerCase()}:${longId}`), 100n, 'the break landed: the mined batch left the holder unredeemed');
  const token = (report.notes.tokens as Array<{ redeemed: number; minedSkipped: string[] }>)[0]!;
  assert.equal(token.redeemed, 2, `${SKIPPED} was skipped by the mined batch and must not be counted redeemed`);
  assert.deepEqual(token.minedSkipped, [SKIPPED], 'the holder the mined batch skipped is named');
  assert.equal(h.index.doneExpiries().size, 0, `${SKIPPED} still holds a redeemable balance, so its expiry must not be marked done`);
  const backlog = h.alerts.filter((a) => a.kind === 'v2_redeem_backlog');
  assert.equal(backlog.length, 1, `${SKIPPED} must reach the v2_redeem_backlog accounting`);
  assert.equal(backlog[0]!.data.holders, 1, `the backlog counts exactly one holder left: ${SKIPPED}`);
});

test('prune: an order the MINED prune skipped is not marked dead from the simulation; it stays live for the next tick (T-462)', async () => {
  const h = harness();
  const longId = h.addSeries(200_000_000n);
  const ids = [1n, 2n, 3n];
  const SKIPPED = 2n;
  for (const id of ids) h.state.orders.set(id, { maker: MAKER, longId, kind: 0, price: 1_000_000n, units: 100n, filled: 0n, validUntil: E - 1_800, cancelled: false });
  h.index.applyRange({ series: [], holders: [], orders: ids.map((orderId) => ({ orderId, longId, maker: MAKER, kind: 0, validUntil: E - 1_800 })), strategies: [], block: h.state.block }, h.state.block);
  h.state.sim.prune = (args) => {
    const batch = args[0] as bigint[];
    return { ok: true, result: BigInt(batch.length), apply: () => batch.filter((id) => id !== SKIPPED).forEach((id) => (h.state.orders.get(id)!.cancelled = true)) };
  };

  const report = await stepPrune(h.ctx, [h.key]);
  assert.deepEqual(h.state.sends.filter((s) => s.fn === 'prune').map((s) => s.status), ['confirmed'], 'one chunk, and its receipt reads success');
  assert.equal(h.state.orders.get(SKIPPED)!.cancelled, false, 'the break landed: the mined prune left the order live');
  assert.equal(report.notes.pruned, 2, `order ${SKIPPED} was skipped by the mined prune and must not be counted pruned`);
  assert.deepEqual(
    h.index.expiredOpenOrders(h.state.now, 100).map((o) => o.orderId),
    [SKIPPED],
    `order ${SKIPPED} must stay live in the index for the next tick, and only orders 1 and 3 are marked dead`,
  );
});

test('settle: a mined settle that did not settle does not start the redeem backlog clock from the simulated `true`; one that did, does (T-462)', async () => {
  const h = harness();
  // Clearinghouse.settle returns false, with a successful receipt, when the price is not final on chain.
  const unsettled = h.addSeries(200_000_000n, { settled: false }, { long: 100n });
  const settles = h.addSeries(210_000_000n, { settled: false }, { long: 100n });
  h.state.sim.settle = (args) => ({ ok: true, result: true, ...(args[0] === settles ? { apply: () => (h.state.series.get(settles.toString())!.settled = true) } : {}) });

  await stepSettle(h.ctx, [h.key]);
  assert.deepEqual(h.state.sends.filter((s) => s.fn === 'settle').map((s) => s.status), ['confirmed', 'confirmed'], 'both receipts read success');
  assert.equal(h.state.series.get(unsettled.toString())!.settled, false, 'the break landed: the mined settle left the series unsettled');
  assert.equal(h.store.getMeta(settledSeenMetaKey(unsettled)), null, `series ${unsettled} is not settled on chain, so its settled mark must not be set`);
  assert.notEqual(h.store.getMeta(settledSeenMetaKey(settles)), null, `series ${settles} did settle on chain, so its settled mark is set`);
});

test('a redeem backlog pages once per expiry, naming its tokens, not once per token id; a settle that does not advance pages once per expiry', async () => {
  const h = harness();
  const holder = getAddress('0x00000000000000000000000000000000000000a1');
  const ids: bigint[] = [];
  for (const strike of [200_000_000n, 210_000_000n, 220_000_000n]) {
    const longId = h.addSeries(strike, { longPayoutPerUnit: 10n ** 16n, shortPayoutPerUnit: 10n ** 16n }, { long: 100n, short: 100n });
    ids.push(longId);
    for (const token of [longId, shortIdOf(longId)]) {
      h.state.balances.set(`${holder.toLowerCase()}:${token}`, 100n);
      h.index.applyRange({ series: [], holders: [{ tokenId: token, holder }], orders: [], strategies: [], block: h.state.block }, h.state.block);
    }
    h.store.setMeta(settledSeenMetaKey(longId), String(h.state.now - 7_200));
  }
  h.state.sim.redeemBatch = () => ({ ok: false, revert: 'ThirdPartyRedeemDisabled' });
  await stepRedeem(h.ctx, [h.key]);
  const backlog = h.alerts.filter((a) => a.kind === 'v2_redeem_backlog');
  assert.equal(backlog.length, 1, JSON.stringify(backlog.map((a) => a.dedupeKey)));
  assert.equal(backlog[0]!.dedupeKey, `${ORACLE.toLowerCase()}:${U.toLowerCase()}:${E}`);
  assert.equal((backlog[0]!.data.tokens as unknown[]).length, 6);

  // Three series of one expiry that do not settle: one page for the expiry.
  for (const longId of ids) h.state.series.get(longId.toString())!.settled = false;
  h.state.sim.settle = () => ({ ok: true, result: false });
  await stepSettle(h.ctx, [h.key]);
  const stuck = h.alerts.filter((a) => a.kind === 'v2_settle_stuck');
  assert.equal(stuck.length, 1, JSON.stringify(stuck.map((a) => a.dedupeKey)));
  assert.deepEqual((stuck[0]!.data.longIds as string[]).length, 3);
});

test('orders of a series with more history than one read covers: the newest are read (they hold the live escrow), and the expiry is never marked done on a partial read', async () => {
  const h = harness();
  const longId = h.addSeries(200_000_000n);
  // 20,050 orders: requotes and spam, all dead, then one escrowed bid past validUntil at the very end.
  for (let id = 1n; id <= 20_049n; id += 1n) h.state.orders.set(id, { maker: MAKER, longId, kind: 2, price: 1n, units: 1n, filled: 0n, validUntil: E - 1_800, cancelled: true });
  h.state.orders.set(20_050n, { maker: MAKER, longId, kind: 0, price: 1_000_000n, units: 100n, filled: 0n, validUntil: E - 1_800, cancelled: false });
  h.state.sim.prune = bookPrune(h);
  await stepPrune(h.ctx, [h.key]);
  assert.deepEqual(h.state.sends.filter((s) => s.fn === 'prune').map((s) => (s.args[0] as bigint[]).map(String)), [['20050']], 'the newest order, which holds the escrow, is pruned');
  await stepRedeem(h.ctx, [h.key]);
  assert.equal(h.index.doneExpiries().size, 0, 'more orders than one read covers: not provably done');
});

test('a tick that must yield to a time-critical target (an expiry\'s snapshot) stops sending in the slow steps; the snapshot step never yields', async () => {
  const h = harness();
  const longId = h.addSeries(200_000_000n, { longPayoutPerUnit: 10n ** 16n, shortPayoutPerUnit: 0n }, { long: 100n });
  const holder = getAddress('0x00000000000000000000000000000000000000a1');
  h.state.balances.set(`${holder.toLowerCase()}:${longId}`, 100n);
  h.index.applyRange({ series: [], holders: [{ tokenId: longId, holder }], orders: [], strategies: [], block: h.state.block }, h.state.block);
  h.state.sim.redeemBatch = chRedeemBatch(h, 100_000n);
  h.ctx.yieldWhen = () => true;
  const redeem = await stepRedeem(h.ctx, [h.key]);
  assert.equal(h.state.sends.filter((s) => s.fn === 'redeemBatch').length, 0, 'the redeem waits for the next tick');
  assert.equal((redeem.notes.tokens as Array<{ redeemed: number }>)[0]!.redeemed, 0);

  // The snapshot of an expiry inside its window is sent even while the tick is yielding.
  h.state.openInterest = 100n;
  h.state.status = 0;
  const next = { ...h.key, expiry: h.state.now - 10 };
  h.index.applyRange({ series: [{ longId: 1n, underlying: next.underlying, isPut: false, strike: 1n, expiry: next.expiry, oracle: next.oracle }], holders: [], orders: [], strategies: [], block: h.state.block }, h.state.block);
  h.state.series.set('1', { underlying: next.underlying as Address, isPut: false, strike: 1n, expiry: next.expiry, oracle: next.oracle as Address, settled: false, settlementPrice: 0n, longPayoutPerUnit: 0n, shortPayoutPerUnit: 0n });
  h.state.sim.snapshot = () => ({ ok: true, result: 1 });
  await stepSnapshot(h.ctx, [next]);
  assert.equal(h.state.sends.filter((s) => s.fn === 'snapshot').length, 1);
});

test('snapshot: a mined snapshot whose source recorded nothing does not mark its expiry from the simulated count; one that recorded, does (T-469)', async () => {
  const h = harness();
  h.state.openInterest = 100n;
  h.state.status = 0;
  // Two expiries inside their snapshot window, each settled on one pool source that prices the window only once a
  // snapshot is recorded. The simulation says 1 recorded for both; the mined snapshot records only `lit`'s.
  const POOL = getAddress('0x00000000000000000000000000000000000000b1');
  const dark = { ...h.key, expiry: h.state.now - 10 };
  const lit = { ...h.key, expiry: h.state.now - 20 };
  [dark, lit].forEach((k, i) => {
    const longId = BigInt(i + 1);
    h.index.applyRange({ series: [{ longId, underlying: k.underlying, isPut: false, strike: 1n, expiry: k.expiry, oracle: k.oracle }], holders: [], orders: [], strategies: [], block: h.state.block }, h.state.block);
    h.state.series.set(longId.toString(), { underlying: k.underlying as Address, isPut: false, strike: 1n, expiry: k.expiry, oracle: k.oracle as Address, settled: false, settlementPrice: 0n, longPayoutPerUnit: 0n, shortPayoutPerUnit: 0n });
  });
  const recorded = new Set<number>();
  type Call = { functionName: string; args?: readonly unknown[] };
  const client = h.ctx.client as unknown as { multicall: (a: { contracts: Call[] }) => Promise<unknown[]> };
  const inner = client.multicall;
  h.ctx.client = {
    ...client,
    multicall: async ({ contracts }: { contracts: Call[] }) => {
      const base = await inner({ contracts });
      return contracts.map((c, i) => {
        if (c.functionName === 'settlementConfig') return { status: 'success', result: [true, [POOL], 150, 21_600, 90_000] };
        if (c.functionName === 'recordedSources') return { status: 'success', result: [[POOL], [false], [0n], 0] };
        if (c.functionName === 'windowPrice') return { status: 'success', result: recorded.has(Number(c.args![2])) ? [true, 10n ** 8n] : [false, 0n] };
        return base[i];
      });
    },
  } as never;
  h.state.sim.snapshot = (args) => ({ ok: true, result: 1, ...(Number(args[1]) === lit.expiry ? { apply: () => recorded.add(lit.expiry) } : {}) });

  await stepSnapshot(h.ctx, [dark, lit]);
  assert.deepEqual(h.state.sends.filter((s) => s.fn === 'snapshot').map((s) => [Number(s.args[1]), s.status]), [[dark.expiry, 'confirmed'], [lit.expiry, 'confirmed']], 'both receipts read success');
  assert.equal(recorded.has(dark.expiry), false, 'the break landed: the mined snapshot of the dark expiry recorded nothing');
  assert.equal(h.store.getMeta(snapshotMetaKey(dark)), null, `expiry ${dark.expiry}: its source still does not price the window after the mined snapshot, so it must not be marked snapshotted from the simulated count`);
  const mark = h.store.getMeta(snapshotMetaKey(lit));
  assert.notEqual(mark, null, `expiry ${lit.expiry}: its source prices the window after the mined snapshot, so it is marked`);
  assert.equal(JSON.parse(mark!).recorded, 1, `expiry ${lit.expiry}: the count is the one source that chain state shows recorded`);
});

test('yieldDeadlineMs: the wall-clock moment the head reaches the earliest future target of this tick; none without one', () => {
  assert.equal(yieldDeadlineMs({ targets: [E + 600, E, null, E - 35], headTimestamp: E - 30, headReadAtMs: 1_000_000 }), 1_000_000 + 30_000);
  assert.equal(yieldDeadlineMs({ targets: [E - 5, null], headTimestamp: E, headReadAtMs: 1_000_000 }), null);
});

/*//////////////////////////////////////////////////////////////
    T-496: THE POST-READ MUST READ THE RECEIPT'S BLOCK
//////////////////////////////////////////////////////////////*/

/**
 * T-462 and T-469 each recorded the same suspicion: the fake chain ignored `blockNumber`, so their tests
 * proved the counting logic and not that the block reached the RPC. Both were right, and neither could
 * test it, because every block answered from the same live state.
 *
 * Here the two blocks genuinely differ. The mined `redeemBatch` redeems all three holders at the receipt
 * block; THEN head moves on and one of them is transferred the token again. The post-read is pinned to the
 * receipt block (`stillHeldAtBlock`, steps.ts:785-792, at `outcome.blockNumber`), so it must see three
 * redeemed and an expiry it can mark done.
 *
 * Delete `{ blockNumber }` at reads.ts:27 and this goes red: `multicallMany` omits the key (chain.ts:219),
 * the fake answers from head, the re-acquired holder reads as still holding, and the tick reports a
 * mined-skipped holder and a redeem backlog that never happened. Note the direction — the failure invents
 * work rather than losing it, which is why nothing downstream would have caught it either.
 */
test('T-496: the redeem post-read reads the receipt block, not head', async () => {
  const h = harness();
  const longId = h.addSeries(200_000_000n, { longPayoutPerUnit: 10n ** 16n, shortPayoutPerUnit: 0n }, { long: 300n });
  const holders = [0xb1, 0xb2, 0xb3].map((n) => getAddress(`0x${n.toString(16).padStart(40, '0')}`));
  const REACQUIRED = holders[1]!;
  for (const a of holders) h.state.balances.set(`${a.toLowerCase()}:${longId}`, 100n);
  h.index.applyRange({ series: [], holders: holders.map((holder) => ({ tokenId: longId, holder })), orders: [], strategies: [], block: h.state.block }, h.state.block);
  h.store.setMeta(settledSeenMetaKey(longId), String(h.state.now - 7_200));

  const receiptBlock = h.state.block;
  h.state.sim.redeemBatch = (args) => {
    const [tokenId, batch] = args as [bigint, Address[]];
    return {
      ok: true,
      result: BigInt(batch.length),
      apply: () => {
        batch.forEach((a) => h.state.balances.set(`${a.toLowerCase()}:${tokenId}`, 0n));
        // Freeze the receipt block: every holder in the batch is redeemed AS OF HERE.
        const atReceipt = new Map(h.state.balances);
        h.state.atBlock.set(String(receiptBlock), {
          balanceOf: ([holder, id]) => atReceipt.get(`${String(holder).toLowerCase()}:${id}`) ?? 0n,
        });
        // Head moves past the receipt, and one holder is sent the token again.
        h.state.block = receiptBlock + 1n;
        h.state.balances.set(`${REACQUIRED.toLowerCase()}:${tokenId}`, 100n);
      },
    };
  };

  const report = await stepRedeem(h.ctx, [h.key]);
  assert.equal(h.state.block, receiptBlock + 1n, 'the scenario needs head PAST the receipt block, or it tests nothing');
  assert.equal(h.state.balances.get(`${REACQUIRED.toLowerCase()}:${longId}`), 100n, 'and it needs the two blocks to disagree');

  const token = (report.notes.tokens as Array<{ redeemed: number; minedSkipped: string[] }>)[0]!;
  assert.equal(
    token.redeemed,
    3,
    `block ${receiptBlock}: all three holders were redeemed AT THE RECEIPT BLOCK. redeemed=${token.redeemed}`
      + ` means the post-read answered from head (block ${h.state.block}), where ${REACQUIRED} holds again.`,
  );
  assert.deepEqual(
    token.minedSkipped,
    [],
    `block ${receiptBlock}: the mined batch skipped nobody. A name here is a holder who re-acquired AFTER`
      + ` the receipt block and was read at head (block ${h.state.block}) instead.`,
  );
  assert.equal(
    h.index.doneExpiries().size,
    1,
    `block ${receiptBlock}: every holder was redeemed at the receipt block, so the expiry is done.`
      + ` Reading head (block ${h.state.block}) leaves it open on a balance the tick never saw.`,
  );
  assert.deepEqual(
    h.alerts.filter((a) => a.kind === 'v2_redeem_backlog'),
    [],
    `block ${receiptBlock}: no holder was left behind, so there is no backlog. One here is invented by`
      + ` reading head (block ${h.state.block}).`,
  );
});
