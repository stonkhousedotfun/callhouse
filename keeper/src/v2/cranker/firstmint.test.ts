/**
 * The `firstmint` step: a one-unit take into the keeper's own account on each live-market expiry this
 * Clearinghouse has not pinned, so a heavy-hook receiver's fill (the EarnVault's) is never the first mint.
 *
 * WHY THIS FILE EXISTS: the step spends USDG every time it sends. Pinned here: an expiry this Clearinghouse pinned is
 * never taken again (read at the head, and again just before the send); the take names only another maker's live
 * AskWrite, one unit, `minUnits` 1, the keeper as recipient, and a price and fee bound that make its cost at most
 * firstMintCost(limitPrice); spend is kept per UTC day and a take that would cross the cap is not sent; an account
 * with code is never the recipient; a short balance pages instead of sending; a dry run writes no spend.
 *
 * DELIBERATELY ABSENT: an RPC. The client answers multicall, readContract, getCode and getBlock from tables; the
 * sender honours isAdvanced and worthSending the way TxSender does. The fork measurement that motivates the step
 * (a heavy EarnVault first fill is skipped; after a one-unit EOA take it fills) was taken on a 4663 fork.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { getAddress, type Address } from 'viem';
import { loadV2Config, type CrankerConfig } from '../config.js';
import { silentLogger } from '../logger.js';
import { longIdOf } from '../seriesId.js';
import { V2Store } from '../store.js';
import { FIRST_MINT_CUTOFF_MARGIN_S, FIRST_MINT_DAILY_CAP, FIRST_MINT_DEADLINE_S, FIRST_MINT_MAX_COST, FIRST_MINT_MAX_ORDER_IDS, FIRST_MINT_NO_ASK_ALERT_S, GAS, SETTLEMENT_WINDOW } from './constants.js';
import { CrankAlerts, type CrankOutcome, type CrankSender, type FixedGasCall } from './effects.js';
import { CrankerIndex } from './index-store.js';
import { firstMintCost, firstMintSpentMetaKey, planFirstMint, stepFirstMint, utcDay, type FirstMintAsk } from './firstmint.js';
import { CrankerMetrics } from './metrics.js';
import { STEP_ORDER, type CrankContext } from './steps.js';

const REGISTRY = fileURLToPath(new URL('../fixtures/registry-v2.json', import.meta.url));
const CH = getAddress('0x2256c045245288A314048aD2d71006a564343C63');
const ORACLE = getAddress('0x4b8c2BEFfecbdc4BeD6e6826e62093F0Cf635E78');
const OTHER_CH = getAddress('0x00000000000000000000000000000000000c0c0c');
const USDG = getAddress('0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168');
const KEEPER = getAddress('0x000000000000000000000000000000000000bEEF');
const WRITER = getAddress('0x00000000000000000000000000000000000A1001');
const EARN = getAddress('0x4417E9B86Be5d09331eF8B5a98Af4589228F476E');
const ZERO = '0x0000000000000000000000000000000000000000' as Address;
const T0 = 1_789_750_000;
const E = 1_789_934_400;

interface Order {
  orderId: bigint;
  longId: bigint;
  maker: Address;
  kind: number;
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
}

const ask = (orderId: bigint, longId: bigint, price: bigint, extra: Partial<Order> = {}): Order => ({ orderId, longId, maker: WRITER, kind: 2, price, units: 100n, filled: 0n, validUntil: E - SETTLEMENT_WINDOW, cancelled: false, ...extra });

function harness(options: { dryRun?: boolean; env?: Record<string, string> } = {}) {
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
    ...options.env,
  }) as CrankerConfig;
  const markets = config.registry.markets.filter((m) => m.v2?.status === 'live');
  const [nvda, tsla] = [markets.find((m) => m.ticker === 'NVDA')!, markets.find((m) => m.ticker === 'TSLA')!];
  const nvdaU = getAddress(nvda.underlying);
  const low = longIdOf(nvdaU, false, 150_000_000n, E);
  const high = longIdOf(nvdaU, false, 160_000_000n, E);

  const state = {
    now: T0,
    block: 65_000_000n,
    pinnedBy: new Map<string, Address>(),
    orders: [] as Order[],
    balance: 1_000_000n,
    allowance: 0n,
    code: undefined as string | undefined,
    /** What the take's simulation fills: 1 normally, 0 for a fill the book skips (minUnits then reverts it). */
    fills: 1n,
    views: [] as string[],
  };
  const pinKey = (oracle: string, u: string, e: unknown) => `${oracle.toLowerCase()}:${u.toLowerCase()}:${String(e)}`;
  const views: Record<string, (args: readonly unknown[], address: Address) => unknown> = {
    pinnedBy: ([u, e], address) => state.pinnedBy.get(pinKey(address, String(u), e)) ?? ZERO,
    seriesOrderCount: ([id]) => BigInt(state.orders.filter((o) => o.longId === id).length),
    ordersOfSeries: ([id, cursor, limit]) => {
      const ids = state.orders.filter((o) => o.longId === id).map((o) => o.orderId);
      const page = ids.slice(Number(cursor), Number(cursor) + Number(limit));
      const next = Number(cursor) + page.length;
      return [page, next < ids.length ? BigInt(next) : 0n];
    },
    getOrders: ([ids]) =>
      (ids as bigint[]).map((id) => {
        const o = state.orders.find((x) => x.orderId === id)!;
        return { maker: o.maker, longId: o.longId, kind: o.kind, price: o.price, units: o.units, filled: o.filled, validUntil: o.validUntil, cancelled: o.cancelled };
      }),
    balanceOf: () => state.balance,
    allowance: () => state.allowance,
  };
  const client = {
    getBlock: async () => ({ number: state.block, timestamp: BigInt(state.now) }),
    getBlockNumber: async () => state.block,
    getCode: async () => state.code,
    multicall: async ({ contracts }: { contracts: Array<{ functionName: string; args?: readonly unknown[]; address: Address }> }) =>
      contracts.map((c) => {
        state.views.push(c.functionName);
        const handler = views[c.functionName];
        if (handler === undefined) return { status: 'failure', error: new Error(`no view ${c.functionName}`) };
        return { status: 'success', result: handler(c.args ?? [], c.address) };
      }),
    readContract: async ({ functionName, args, address }: { functionName: string; args: readonly unknown[]; address: Address }) => {
      state.views.push(`read ${functionName}`);
      if (functionName === 'pinnedBy') return views.pinnedBy!(args, address);
      throw new Error(`no readContract ${functionName}`);
    },
  };

  const sends: Array<{ fn: string; gas: bigint; args: readonly unknown[]; kind: string; key: string }> = [];
  const sender: CrankSender = {
    dryRun: options.dryRun ?? false,
    account: KEEPER,
    async execute(call: FixedGasCall, opts): Promise<CrankOutcome> {
      if (opts.isAdvanced !== undefined && (await opts.isAdvanced())) return { status: 'already-advanced' };
      if (call.functionName === 'approve') {
        sends.push({ fn: 'approve', gas: call.gas, args: call.args as readonly unknown[], kind: opts.kind, key: opts.key });
        if (sender.dryRun) return { status: 'would-send', result: true };
        state.allowance = (call.args as readonly [Address, bigint])[1];
        return { status: 'confirmed', hash: `0x${'ab'.repeat(32)}`, nonce: 1, blockNumber: state.block, gasUsed: 50_000n, result: true };
      }
      const [p] = call.args as unknown as [{ longId: bigint; orderIds: bigint[]; limitPrice: bigint; maxTotalFee: bigint; recipient: Address; units: bigint; minUnits: bigint }];
      if (state.fills < p.minUnits) return { status: 'simulation-reverted', revert: 'BelowMinUnits', error: 'BelowMinUnits(0, 1)' };
      // The book fills the first named ask it can, at that ask's price.
      const filled = state.orders.find((o) => o.orderId === p.orderIds[0])!;
      const premium = filled.price / 100n;
      const result = [1n, premium, premium / 10n] as const;
      if (opts.worthSending !== undefined && !opts.worthSending(result)) return { status: 'no-op', result };
      sends.push({ fn: call.functionName, gas: call.gas, args: call.args as readonly unknown[], kind: opts.kind, key: opts.key });
      if (sender.dryRun) return { status: 'would-send', result };
      state.pinnedBy.set(pinKey(ORACLE, nvdaU, E), CH);
      return { status: 'confirmed', hash: `0x${'cd'.repeat(32)}`, nonce: 2, blockNumber: state.block, gasUsed: 537_900n, result };
    },
  };

  const store = new V2Store(':memory:');
  const index = new CrankerIndex(store);
  index.bind({ chainId: config.chainId, clearinghouse: CH, orderBook: config.contracts.orderBook, autoRoller: null });
  index.applyRange(
    {
      series: [
        { longId: low, underlying: nvdaU, isPut: false, strike: 150_000_000n, expiry: E, oracle: ORACLE },
        { longId: high, underlying: nvdaU, isPut: false, strike: 160_000_000n, expiry: E, oracle: ORACLE },
      ],
      holders: [],
      orders: [],
      strategies: [],
      block: state.block,
    },
    state.block,
  );
  const alerts: Array<{ kind: string; message: string; data: Record<string, unknown>; dedupeKey?: string; severity?: string }> = [];
  const alerter = {
    alert: async (kind: string, message: string, data: Record<string, unknown> = {}, o: { dedupeKey?: string; severity?: string } = {}) => (alerts.push({ kind, message, data, dedupeKey: o.dedupeKey, severity: o.severity }), true),
    clear: () => undefined,
  };
  const ctx: CrankContext = {
    config,
    log: silentLogger(),
    client: client as never,
    logClient: { getLogs: async () => [] } as never,
    addresses: { clearinghouse: CH, orderBook: config.contracts.orderBook, settlementOracle: ORACLE, expiryCalendar: config.contracts.expiryCalendar, autoRoller: null, feeSplitter: null, multicall3: config.multicall3 },
    store,
    index,
    sender,
    alerts: new CrankAlerts(alerter as never, store, options.dryRun ?? false),
    indexer: null,
  };
  return { ctx, state, sends, alerts, store, index, nvda, tsla, nvdaU, low, high, config };
}

const takeArgs = (s: { args: readonly unknown[] }) => (s.args as unknown as [Record<string, unknown>])[0];

/*//////////////////////////////////////////////////////////////
                         planFirstMint (pure)
//////////////////////////////////////////////////////////////*/

const plan = (asks: FirstMintAsk[], over: Partial<Parameters<typeof planFirstMint>[0]> = {}) =>
  planFirstMint({ expiry: E, pinnedBy: ZERO, clearinghouse: CH, asks, now: T0, keeper: KEEPER, capLeft: FIRST_MINT_DAILY_CAP, ...over });

test('firstMintCost: premium is price / 100 floored and the fee its 10 % ceiling (the fork take of a 1 USDG ask cost exactly 11,000)', () => {
  assert.deepEqual(firstMintCost(1_000_000n), { premium: 10_000n, fee: 1_000n, total: 11_000n });
  assert.deepEqual(firstMintCost(100n), { premium: 1n, fee: 0n, total: 1n });
  assert.deepEqual(firstMintCost(12_345_600n), { premium: 123_456n, fee: 12_345n, total: 135_801n });
});

test('planFirstMint: an expiry pinned by THIS Clearinghouse is never taken; pinned elsewhere or not at all is', () => {
  const asks = [ask(1n, 11n, 1_000_000n)];
  assert.deepEqual(plan(asks, { pinnedBy: CH }), { action: 'pinned' });
  assert.deepEqual(plan(asks, { pinnedBy: CH.toLowerCase() as Address }), { action: 'pinned' });
  assert.equal(plan(asks, { pinnedBy: ZERO }).action, 'take');
  assert.equal(plan(asks, { pinnedBy: OTHER_CH }).action, 'take');
});

test('planFirstMint: nothing within FIRST_MINT_CUTOFF_MARGIN_S of the mint cutoff', () => {
  const asks = [ask(1n, 11n, 1_000_000n, { validUntil: E })];
  const edge = E - SETTLEMENT_WINDOW - FIRST_MINT_CUTOFF_MARGIN_S;
  assert.equal(plan(asks, { now: edge - 1 }).action, 'take');
  assert.deepEqual(plan(asks, { now: edge }), { action: 'past-cutoff' });
});

test('planFirstMint: only another maker\'s live AskWrite at a positive price qualifies', () => {
  const t = T0;
  const unfit = [
    ask(1n, 11n, 1_000n, { kind: 0 }),
    ask(2n, 11n, 1_000n, { kind: 1 }),
    ask(3n, 11n, 1_000n, { cancelled: true }),
    ask(4n, 11n, 1_000n, { filled: 100n }),
    ask(5n, 11n, 1_000n, { validUntil: t + FIRST_MINT_DEADLINE_S }),
    ask(6n, 11n, 1_000n, { maker: KEEPER }),
    ask(7n, 11n, 0n),
  ];
  assert.deepEqual(plan(unfit), { action: 'no-ask' });
  assert.deepEqual(plan([...unfit, ask(8n, 11n, 1_000n, { validUntil: t + FIRST_MINT_DEADLINE_S + 1 })]), { action: 'take', longId: 11n, orderIds: [8n], limitPrice: 1_000n, maxTotalFee: 1n, maxCost: 11n });
});

test('planFirstMint: the cheapest ask\'s series, its asks cheapest first (at most FIRST_MINT_MAX_ORDER_IDS), priced at the dearest named', () => {
  const asks = [
    ask(1n, 11n, 900_000n),
    ask(2n, 22n, 300_000n),
    ask(3n, 22n, 500_000n),
    ask(4n, 22n, 300_000n),
    ...Array.from({ length: 10 }, (_, i) => ask(10n + BigInt(i), 22n, 600_000n + BigInt(i) * 100n)),
  ];
  const p = plan(asks);
  assert.equal(p.action, 'take');
  if (p.action !== 'take') return;
  assert.equal(p.longId, 22n);
  assert.equal(p.orderIds.length, FIRST_MINT_MAX_ORDER_IDS);
  assert.deepEqual(p.orderIds.slice(0, 3), [2n, 4n, 3n]);
  assert.equal(p.limitPrice, 600_400n);
  assert.deepEqual({ fee: p.maxTotalFee, cost: p.maxCost }, { fee: firstMintCost(600_400n).fee, cost: firstMintCost(600_400n).total });
});

test('planFirstMint: an ask dearer than the day\'s cap left, or than FIRST_MINT_MAX_COST, is not taken', () => {
  const asks = [ask(1n, 11n, 1_000_000n), ask(2n, 11n, 2_000_000n)];
  assert.deepEqual(plan(asks, { capLeft: 10_999n }), { action: 'over-cap', cheapest: 11_000n, bound: 10_999n });
  assert.deepEqual(plan(asks, { capLeft: 0n }), { action: 'over-cap', cheapest: 11_000n, bound: 0n });
  // Only the affordable ask is named, so the price bound stays under the cap.
  assert.deepEqual(plan(asks, { capLeft: 15_000n }), { action: 'take', longId: 11n, orderIds: [1n], limitPrice: 1_000_000n, maxTotalFee: 1_000n, maxCost: 11_000n });
  const dear = [ask(1n, 11n, FIRST_MINT_MAX_COST * 100n)];
  assert.equal(firstMintCost(dear[0]!.price).total > FIRST_MINT_MAX_COST, true);
  assert.equal(plan(dear).action, 'over-cap');
});

/*//////////////////////////////////////////////////////////////
                         stepFirstMint (fake chain)
//////////////////////////////////////////////////////////////*/

test('STEP_ORDER: firstmint runs once, right after rolls (which place the fresh asks) and before housekeeping', () => {
  const order = [...STEP_ORDER];
  assert.equal(order.filter((s) => s === 'firstmint').length, 1);
  assert.equal(order.indexOf('firstmint'), order.indexOf('rolls') + 1);
  assert.equal(order.indexOf('firstmint') + 1, order.indexOf('housekeeping'));
});

test('stepFirstMint: an unpinned expiry is taken once, one unit into the keeper, after a capped approve; spend is recorded; the next tick sends nothing', async () => {
  const h = harness();
  h.state.orders.push(ask(1n, h.high, 2_000_000n), ask(2n, h.low, 1_000_000n), ask(3n, h.low, 1_000_000n, { maker: EARN, kind: 0 }));

  const report = await stepFirstMint(h.ctx, USDG);

  assert.deepEqual(h.sends.map((s) => s.fn), ['approve', 'take']);
  assert.deepEqual(h.sends[0]!.args, [h.config.contracts.orderBook, FIRST_MINT_DAILY_CAP]);
  assert.equal(h.sends[0]!.gas, GAS.usdgApprove);
  const take = h.sends[1]!;
  assert.equal(take.gas, GAS.firstMintTake);
  assert.equal(take.kind, 'firstmint');
  assert.equal(take.key, `${ORACLE.toLowerCase()}:${h.nvdaU.toLowerCase()}:${E}`);
  assert.deepEqual(takeArgs(take), {
    longId: h.low,
    buying: true,
    orderIds: [2n],
    units: 1n,
    minUnits: 1n,
    limitPrice: 1_000_000n,
    writeToSell: false,
    recipient: KEEPER,
    deadline: T0 + FIRST_MINT_DEADLINE_S,
    maxTotalFee: 1_000n,
  });
  assert.equal(h.store.getMeta(firstMintSpentMetaKey(utcDay(T0))), '11000');
  assert.equal(report.notes.pinnedThisTick, 1);
  assert.equal(report.notes.spentThisTick, '11000');
  assert.equal(h.alerts.length, 0);

  // Pinned now: the next tick reads the pin and nothing else, and sends nothing.
  h.state.views = [];
  const again = await stepFirstMint(h.ctx, USDG);
  assert.equal(h.sends.length, 2);
  assert.deepEqual(h.state.views, ['pinnedBy']);
  assert.deepEqual((again.notes.groups as Array<{ action: string }>).map((g) => g.action), ['pinned']);
  assert.equal(h.store.getMeta(firstMintSpentMetaKey(utcDay(T0))), '11000');
});

test('stepFirstMint: CRANKER_FIRSTMINT_ENABLED=0 turns this step off before any read, says so once per tick, and sends nothing', async () => {
  const h = harness({ env: { CRANKER_FIRSTMINT_ENABLED: '0' } });
  h.state.orders.push(ask(1n, h.low, 1_000_000n));   // an unpinned expiry with an ask: the enabled step would take it
  const warned: string[] = [];
  h.ctx.log.warn = ((_o: unknown, message?: string) => { warned.push(String(message)); }) as never;
  const report = await stepFirstMint(h.ctx, USDG);
  assert.deepEqual(report.notes, { skipped: 'disabled' });
  assert.equal(h.sends.length, 0);
  assert.deepEqual(h.state.views, [], 'nothing is read: not even the pin');
  assert.equal(warned.filter((m) => /CRANKER_FIRSTMINT_ENABLED=0/.test(m)).length, 1, 'said once for this tick');
  await stepFirstMint(h.ctx, USDG);
  assert.equal(warned.filter((m) => /CRANKER_FIRSTMINT_ENABLED=0/.test(m)).length, 2, 'and again on the next tick, while it stays off');

  const on = harness();
  on.state.orders.push(ask(1n, on.low, 1_000_000n));
  await stepFirstMint(on.ctx, USDG);
  assert.equal(on.sends.filter((s) => s.fn !== 'approve').length, 1, 'control: the same expiry is taken with the switch at its default');
});

test('stepFirstMint: an expiry already pinned by this Clearinghouse reads no order, no balance and sends nothing', async () => {
  const h = harness();
  h.state.orders.push(ask(1n, h.low, 1_000_000n));
  h.state.pinnedBy.set(`${ORACLE.toLowerCase()}:${h.nvdaU.toLowerCase()}:${E}`, CH);
  const report = await stepFirstMint(h.ctx, USDG);
  assert.equal(h.sends.length, 0);
  assert.deepEqual(h.state.views, ['pinnedBy']);
  assert.equal(report.notes.pinnedThisTick, 0);
});

test('stepFirstMint: pinned between the head read and the send (isAdvanced), the take is not sent and nothing is spent', async () => {
  const h = harness();
  h.state.allowance = FIRST_MINT_DAILY_CAP;
  h.state.orders.push(ask(1n, h.low, 1_000_000n));
  const read = h.ctx.client.readContract.bind(h.ctx.client);
  (h.ctx.client as unknown as { readContract: unknown }).readContract = async () => CH;
  const report = await stepFirstMint(h.ctx, USDG);
  (h.ctx.client as unknown as { readContract: unknown }).readContract = read;
  assert.equal(h.sends.length, 0);
  assert.deepEqual((report.notes.groups as Array<{ status?: string }>).map((g) => g.status), ['already-advanced']);
  assert.equal(h.store.getMeta(firstMintSpentMetaKey(utcDay(T0))), null);
});

test('stepFirstMint: a fill the book would skip reverts in simulation (minUnits 1): nothing sent, nothing spent', async () => {
  const h = harness();
  h.state.allowance = FIRST_MINT_DAILY_CAP;
  h.state.fills = 0n;
  h.state.orders.push(ask(1n, h.low, 1_000_000n));
  const report = await stepFirstMint(h.ctx, USDG);
  assert.equal(h.sends.length, 0);
  assert.deepEqual((report.notes.groups as Array<{ status?: string }>).map((g) => g.status), ['simulation-reverted']);
  assert.equal(h.store.getMeta(firstMintSpentMetaKey(utcDay(T0))), null);
});

test('stepFirstMint: the day\'s cap is respected across ticks and resets on the next UTC day', async () => {
  const h = harness();
  h.state.allowance = FIRST_MINT_DAILY_CAP;
  h.state.orders.push(ask(1n, h.low, 1_000_000n));
  h.store.setMeta(firstMintSpentMetaKey(utcDay(T0)), (FIRST_MINT_DAILY_CAP - 10_999n).toString());
  const capped = await stepFirstMint(h.ctx, USDG);
  assert.equal(h.sends.length, 0);
  assert.deepEqual((capped.notes.groups as Array<{ action: string }>).map((g) => g.action), ['over-cap']);
  assert.equal(h.alerts.length, 1);
  assert.equal(h.alerts[0]!.kind, 'v2_first_mint');
  assert.equal(h.alerts[0]!.severity, 'warn');

  // Next UTC day: the cap is whole again. (The ask stays valid; the expiry is still well before its cutoff.)
  const nextDay = Math.floor(T0 / 86_400 + 1) * 86_400 + 60;
  assert.ok(nextDay < E - SETTLEMENT_WINDOW - FIRST_MINT_CUTOFF_MARGIN_S);
  h.state.now = nextDay;
  await stepFirstMint(h.ctx, USDG);
  assert.deepEqual(h.sends.map((s) => s.fn), ['take']);
  assert.equal(h.store.getMeta(firstMintSpentMetaKey(utcDay(nextDay))), '11000');
  assert.equal(h.store.getMeta(firstMintSpentMetaKey(utcDay(T0))), (FIRST_MINT_DAILY_CAP - 10_999n).toString());
});

test('stepFirstMint: a keeper account with code is never the recipient: nothing read past the pin, nothing sent, an error page', async () => {
  const h = harness();
  h.state.code = '0xef0100000000000000000000000000000000000000c0de';
  h.state.orders.push(ask(1n, h.low, 1_000_000n));
  const report = await stepFirstMint(h.ctx, USDG);
  assert.equal(h.sends.length, 0);
  assert.deepEqual(h.state.views, ['pinnedBy']);
  assert.equal(h.alerts.length, 1);
  assert.deepEqual({ kind: h.alerts[0]!.kind, severity: h.alerts[0]!.severity, key: h.alerts[0]!.dedupeKey }, { kind: 'v2_first_mint', severity: 'error', key: 'keeper-code' });
  assert.deepEqual((report.notes.groups as Array<{ action: string }>).map((g) => g.action), ['refused']);
});

test('stepFirstMint: a balance short of the take pages and sends nothing, not even the approve', async () => {
  const h = harness();
  h.state.balance = 10_999n;
  h.state.orders.push(ask(1n, h.low, 1_000_000n));
  const report = await stepFirstMint(h.ctx, USDG);
  assert.equal(h.sends.length, 0);
  assert.deepEqual((report.notes.groups as Array<{ action: string }>).map((g) => g.action), ['unfunded']);
  assert.deepEqual({ kind: h.alerts[0]!.kind, key: h.alerts[0]!.dedupeKey, need: h.alerts[0]!.data.need }, { kind: 'v2_first_mint', key: 'balance', need: '11000' });
});

test('stepFirstMint: no ask pages once, and only inside FIRST_MINT_NO_ASK_ALERT_S of the cutoff', async () => {
  const h = harness();
  await stepFirstMint(h.ctx, USDG);
  assert.equal(h.alerts.length, 0);
  h.state.now = E - SETTLEMENT_WINDOW - FIRST_MINT_NO_ASK_ALERT_S;
  await stepFirstMint(h.ctx, USDG);
  await stepFirstMint(h.ctx, USDG);
  assert.equal(h.alerts.length, 1);
  assert.equal(h.alerts[0]!.kind, 'v2_first_mint');
  assert.equal(h.sends.length, 0);
});

test('stepFirstMint: expiries of a market that is not live, past their cutoff, or marked done are not read', async () => {
  const h = harness();
  h.nvda.v2!.status = 'paused';
  const report = await stepFirstMint(h.ctx, USDG);
  assert.deepEqual(h.state.views, []);
  assert.equal(report.notes.reason, 'no upcoming expiry of a live market in the index');

  const past = harness();
  past.state.now = E - SETTLEMENT_WINDOW;
  await stepFirstMint(past.ctx, USDG);
  assert.deepEqual(past.state.views, []);

  const done = harness();
  done.index.markExpiryDone(ORACLE, done.nvdaU, E, T0);
  await stepFirstMint(done.ctx, USDG);
  assert.deepEqual(done.state.views, []);
});

test('stepFirstMint: a dry run reports would-send and writes no spend', async () => {
  const h = harness({ dryRun: true });
  h.state.orders.push(ask(1n, h.low, 1_000_000n));
  const report = await stepFirstMint(h.ctx, USDG);
  assert.deepEqual(h.sends.map((s) => s.fn), ['approve', 'take']);
  assert.equal(report.notes.pinnedThisTick, 1);
  assert.equal(report.notes.spentThisTick, '0');
  assert.equal(h.store.getMeta(firstMintSpentMetaKey(utcDay(T0))), null);
});

test('CrankerMetrics: the firstmint step\'s pins and spend accumulate since boot', () => {
  const m = new CrankerMetrics();
  m.recordStep({ step: 'firstmint', actions: [], notes: { pinnedThisTick: 1, spentThisTick: '11000' }, wakeAt: [] }, 0, 1, T0);
  m.recordStep({ step: 'firstmint', actions: [], notes: { pinnedThisTick: 2, spentThisTick: '500' }, wakeAt: [] }, 0, 1, T0);
  m.recordStep({ step: 'rolls', actions: [], notes: { pinnedThisTick: 9, spentThisTick: '9' }, wakeAt: [] }, 0, 1, T0);
  assert.deepEqual(m.firstMint, { pinned: 3, spent: '11500' });
});
