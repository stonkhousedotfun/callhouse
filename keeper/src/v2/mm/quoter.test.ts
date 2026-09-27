/**
 * The MM bot's shell around the planner (quoter.ts): which markets it quotes, the kill switch when the chain is not
 * there to cancel on or refuses a cancel, and the store's deployment anchor.
 *
 * WHY THIS FILE EXISTS: a kill that throws when the RPC is down answers 500 and leaves the operator unsure whether
 * anything stopped; a kill that answers 200 while an expired Bid or AskResale still holds the vault's escrow tells the
 * operator the book is clean when it is not; a store kept from another deployment at the same addresses hides the
 * vault's orders from the kill. Pinned: the killed state is stored before anything is read from the chain, the alert
 * goes out, the answer says the cancels did not finish (202) with the reason, a restart stays killed, and resume
 * clears it; a cancel of an expired escrowed order that keeps failing is retried on every pass and answered 202 with
 * the order ids, an expired AskWrite is never a target; a store with another deployment anchor is reset before the
 * kill reads it. The happy path (cancels on a real book) is devnet-mm.ts's.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { pino } from 'pino';
import { ContractFunctionRevertedError, ContractFunctionZeroDataError, encodeErrorResult, getAddress, zeroAddress, type Address } from 'viem';
import { earnVaultAbi } from '../abi/earnVault.js';
import { epochSelectable } from './epoch.js';
import { loadV2Config, MM_OPEN_GRACE_DEFAULT_S, type MmConfig } from '../config.js';
import { silentLogger } from '../logger.js';
import { V2Store } from '../store.js';
import type { TxOutcome } from '../tx.js';
import { KIND_INDEX, MM_GAS, type OrderKindName } from './constants.js';
import { MmStore } from './mm-store.js';
import { replayLedger, type LossStop } from './pnl.js';
import type { HouseSupport } from './house.js';
import { Alerter } from '../alerts.js';
import { MmBot, answersEpochEnd, flattenRecentFills, managedSeries, mmPlanParams, quotedMarkets, unionProtocolBook } from './quoter.js';
import { mountKillRoutes } from './routes.js';
import { planTick, type MmPlanParams, type TickInput, type TickPlan } from './planner.js';
import type { ChainOrder, MarketsRead, MmAddresses } from './reads.js';

const REGISTRY = fileURLToPath(new URL('../fixtures/registry-v2.json', import.meta.url));
const env = { V2_MODE: 'mm', RH_RPC: 'http://127.0.0.1:9', MM_QUOTER_PK: `0x${'11'.repeat(32)}`, PRICING_URL: 'http://127.0.0.1:8790', MM_KILL_TOKEN: 'k'.repeat(32), V2_REGISTRY_PATH: REGISTRY };
/** A LastTick's budget line when the tick budget cut nothing (raiseAlerts reads it). */
const NO_BUDGET_CUT = { given: 60, unsent: 0, seriesWithoutAsk: 0, shortSends: 0 };

/**
 * `isHouseVault` answers the epochEnd() probe for MM_VAULTS entries. This helper's client is unreachable, so
 * without an answer every extra vault would be skipped as unreadable (fail closed); the default says what the fixtures'
 * extras are, plain MakerVaults.
 */
function bot(store: V2Store, config = loadV2Config(env) as MmConfig, house?: Partial<HouseSupport>, isHouseVault: (vault: Address, block: bigint) => Promise<boolean> = async () => false) {
  const alerts: string[] = [];
  const unreachable = async () => {
    throw new Error('HTTP request failed: connect ECONNREFUSED');
  };
  const instance = new MmBot({
    config,
    log: silentLogger(),
    client: { getBlock: unreachable, readContract: unreachable, multicall: unreachable } as never,
    logClient: { getLogs: unreachable } as never,
    sender: { execute: async () => assert.fail('nothing may be sent') },
    alerter: { alert: async (kind) => (alerts.push(kind), true), clear: () => undefined },
    store,
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
    killWaitMs: 2_000,
    ...(house === undefined ? {} : { house }),
    isHouseVault,
  });
  return { instance, alerts };
}

test('quotedMarkets: every live v2 market by default; MM_MARKETS names them, whatever their status', () => {
  const all = loadV2Config(env) as MmConfig;
  assert.deepEqual(quotedMarkets(all).map((m) => m.ticker), ['NVDA', 'TSLA']);
  const named = loadV2Config({ ...env, MM_MARKETS: 'sgov,NVDA' }) as MmConfig;
  assert.deepEqual(quotedMarkets(named).map((m) => m.ticker), ['NVDA', 'SGOV']);
  assert.equal(mmPlanParams(all).requoteBps, 300);
  assert.equal(mmPlanParams(named).askUnits, 100n);
});

test('kill with the chain unreachable: stored first, paged, answered as not done with the reason; resume clears it', async () => {
  const store = new V2Store(':memory:');
  const { instance, alerts } = bot(store);
  const outcome = await instance.kill('rpc down drill');
  assert.equal(outcome.killed, true);
  assert.equal(outcome.done, false);
  assert.equal(outcome.remaining, -1);
  assert.match(outcome.errors.join(' '), /ECONNREFUSED/);
  assert.deepEqual(alerts, ['v2_mm_killed']);
  assert.equal(new MmStore(store).killed()?.reason, 'rpc down drill', 'a restarted bot reads it back');

  await assert.rejects(instance.tick(), /ECONNREFUSED/, 'a tick without a chain fails (the loop pages v2_error), it never quotes');

  const again = bot(store).instance;
  assert.equal(again.mm.killed()?.reason, 'rpc down drill');
  const resumed = again.resume();
  assert.equal(resumed.killed, false);
  assert.equal(again.mm.killed(), null);
  assert.equal(instance.state(), null, 'no /state before a tick completed');
});

test('loss stop: a page the relay did not take is not remembered as sent; a later tick of the same UTC day delivers it once', async () => {
  const store = new V2Store(':memory:');
  let relayUp = false;
  const sent: string[] = [];
  let wall = 1_790_000_000_000;
  const instance = new MmBot({
    config: loadV2Config(env) as MmConfig,
    log: silentLogger(),
    client: {} as never,
    logClient: {} as never,
    sender: { execute: async () => assert.fail('nothing may be sent') },
    alerter: { alert: async (kind) => (sent.push(kind), relayUp), clear: () => undefined },
    store,
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
    now: () => wall,
  });
  const day = Math.floor(1_790_000_000 / 86_400);
  const VAULT_A = '0x00000000000000000000000000000000000000fa';
  const VAULT_B = '0x00000000000000000000000000000000000000fb';
  const tick = (timestamp: number, vaultAddress: string = VAULT_A) => ({
    head: { blockNumber: 1n, timestamp },
    vaultAddress,
    stop: { day, realised: -2_000_000_000n, limit: 1_000_000_000n, tripped: true },
    vault: { isQuoter: true, usdgWallet: 0n },
    plan: { netDelta: [], series: [], capped: [], outflow: { cap: 2_500_000_000n, used: 0n, released: 0n, budget: 2_500_000_000n, planned: 0n, blocked: false } },
    foreignOutflow: null,
    outflowRefused: [],
    pricing: { requested: 0, failed: 0, reasons: {} },
    budget: NO_BUDGET_CUT,
  });
  const raise = (timestamp: number, vaultAddress?: string) =>
    (instance as unknown as { raiseAlerts(t: unknown): Promise<void> }).raiseAlerts(tick(timestamp, vaultAddress));

  await raise(1_790_000_000);
  assert.deepEqual(sent, ['v2_mm_loss_stop']);
  wall += 60_000;
  await raise(1_790_000_060);
  assert.equal(sent.length, 1, 'not retried on every tick while the relay is down');
  relayUp = true;
  wall += 5 * 60_000;
  await raise(1_790_000_360);
  assert.deepEqual(sent, ['v2_mm_loss_stop', 'v2_mm_loss_stop'], 'retried once the retry spacing has passed');
  wall += 10 * 60_000;
  await raise(1_790_000_960);
  assert.equal(sent.length, 2, 'delivered: not paged again that day');
});

/*//////////////////////////////////////////////////////////////
                  KILL AGAINST A BOOK THAT REFUSES
//////////////////////////////////////////////////////////////*/

const T = 1_790_000_000;
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const hash = (byte: string) => `0x${byte.repeat(32)}` as const;

interface BookOrder {
  maker: Address;
  longId: bigint;
  kind: number;
  price: bigint;
  units: bigint;
  filled: bigint;
  validUntil: number;
  cancelled: boolean;
}

/** The OrderBook and MakerVault views the kill reads, and a sender whose vault.cancel reverts for chosen ids. */
class Book {
  readonly orders = new Map<bigint, BookOrder>();
  readonly failing = new Set<bigint>();
  /** Filled by a taker in the block the cancel lands: OrderBook.cancel skips them without reverting. */
  readonly fillOnCancel = new Set<bigint>();
  /** Lower-case vaults whose `orderBook` read throws, as it does for an address with no code. */
  readonly unreadable = new Set<string>();
  readonly cancelCalls: bigint[][] = [];
  deployHash = hash('d1');

  constructor(readonly config = loadV2Config(env) as MmConfig) {}

  private ofMaker(maker: unknown): bigint[] {
    return [...this.orders].filter(([, o]) => o.maker.toLowerCase() === String(maker).toLowerCase()).map(([id]) => id);
  }

  add(id: bigint, kind: OrderKindName, validUntil: number, over: Partial<BookOrder> = {}): void {
    this.orders.set(id, { maker: this.config.contracts.makerVault, longId: 7n, kind: KIND_INDEX[kind], price: 1_000_000n, units: 100n, filled: 0n, validUntil, cancelled: false, ...over });
  }

  client() {
    const c = this.config.contracts;
    return {
      getBlock: async (args: { blockNumber?: bigint }) =>
        args.blockNumber !== undefined ? { number: args.blockNumber, hash: this.deployHash, timestamp: 0n } : { number: 65_200_000n, hash: hash('ee'), timestamp: BigInt(T) },
      readContract: async ({ address, functionName, args = [] }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
        switch (functionName) {
          case 'orderBook':
            if (this.unreadable.has(address.toLowerCase())) throw new Error(`ContractFunctionExecutionError: ${address} has no code`);
            return c.orderBook;
          case 'epochEnd':
            // Every vault this fake chain holds is a MakerVault, and a MakerVault has no epochEnd(): the call
            // reverts, which answersEpochEnd reads as "not a House vault".
            throw new ContractFunctionRevertedError({ abi: [], functionName: 'epochEnd' });
          case 'usdg':
            return '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
          case 'calendar':
            return c.expiryCalendar;
          case 'makerOrderCount':
            return BigInt(this.ofMaker(args[0]).length);
          case 'ordersOfMaker': {
            const [maker, from, limit] = args as [Address, bigint, bigint];
            const ids = this.ofMaker(maker).slice(Number(from), Number(from + limit));
            return [ids, from + BigInt(ids.length)];
          }
          case 'getOrders':
            return (args[0] as bigint[]).map((id) => this.orders.get(id) ?? { maker: ZERO, longId: 0n, kind: 0, price: 0n, units: 0n, filled: 0n, validUntil: 0, cancelled: false });
          default:
            throw new Error(`the fake book has no view ${functionName}`);
        }
      },
      multicall: async () => assert.fail('the kill reads no multicall'),
    };
  }

  sender() {
    return {
      execute: async (call: { functionName: string; args: readonly unknown[] }): Promise<TxOutcome> => {
        assert.equal(call.functionName, 'cancel', 'the kill sends nothing but cancels');
        const ids = call.args[0] as bigint[];
        this.cancelCalls.push(ids);
        // One reverting id reverts the whole vault.cancel.
        if (ids.some((id) => this.failing.has(id))) return { status: 'simulation-reverted', revert: 'NotAuthorized', error: 'execution reverted: NotAuthorized()' };
        for (const id of ids) {
          const o = this.orders.get(id)!;
          if (this.fillOnCancel.has(id)) o.filled = o.units;
          if (!o.cancelled && o.filled < o.units) o.cancelled = true;
        }
        return { status: 'confirmed', hash: hash('ab'), nonce: 0, blockNumber: 65_200_001n, gasUsed: 100_000n, result: undefined };
      },
    };
  }

  bot(store: V2Store, logLines: string[] = []) {
    const alerts: string[] = [];
    const instance = new MmBot({
      config: this.config,
      log: pino({ level: 'info' }, { write: (line: string) => void logLines.push(line) }),
      client: this.client() as never,
      logClient: { getLogs: async () => assert.fail('the kill scans no logs') } as never,
      sender: this.sender() as never,
      alerter: { alert: async (kind) => (alerts.push(kind), true), clear: () => undefined },
      store,
      pricing: { fairMany: async () => [] },
      signer: '0x0000000000000000000000000000000000000001',
      killWaitMs: 10_000,
      killRetryMs: 5,
    });
    return { instance, alerts };
  }
}

test('kill: an expired Bid and AskResale whose cancels keep failing are remaining, retried every pass, answered 202 with their ids; an expired AskWrite is never a target', async () => {
  const book = new Book();
  book.add(1n, 'Bid', T - 60);
  book.add(2n, 'AskResale', T - 60);
  book.add(3n, 'AskWrite', T - 60, { units: 100n, filled: 40n });
  book.add(4n, 'Bid', T + 3_600, { filled: 100n });
  book.failing.add(1n);
  book.failing.add(2n);
  const store = new V2Store(':memory:');
  const { instance, alerts } = book.bot(store);

  const app = new Hono();
  const token = 'k'.repeat(32);
  mountKillRoutes(app, { token: () => token, target: instance });
  const res = await app.request('/kill', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'escrow drill' }) });
  assert.equal(res.status, 202, 'escrow still on the book is not a finished kill');
  const body = (await res.json()) as { done: boolean; remaining: number; remainingOrderIds: string[]; cancelled: number; errors: string[]; reason: string };
  assert.equal(body.done, false);
  assert.equal(body.remaining, 2);
  assert.deepEqual(body.remainingOrderIds, ['1', '2']);
  assert.equal(body.cancelled, 0);
  assert.equal(body.reason, 'escrow drill');
  assert.ok(body.errors.length > 0 && body.errors.every((e) => /cancel 1, 2 \(kill switch\): simulation-reverted NotAuthorized/.test(e)), JSON.stringify(body.errors));
  assert.equal(book.cancelCalls.length, 5, 'every pass retried the escrowed orders');
  assert.ok(book.cancelCalls.every((ids) => ids.join(',') === '1,2'), 'the expired AskWrite and the filled Bid are never sent');
  assert.deepEqual(alerts.filter((k) => k === 'v2_mm_killed'), ['v2_mm_killed']);
  assert.equal(instance.mm.killed()?.reason, 'escrow drill');

  // The book accepts the cancels again: the next kill finishes, 200 done, and still leaves the AskWrite alone.
  book.failing.clear();
  book.cancelCalls.length = 0;
  const again = await instance.kill('retry');
  assert.equal(again.done, true);
  assert.equal(again.remaining, 0);
  assert.deepEqual(again.remainingOrderIds, []);
  assert.equal(again.cancelled, 2);
  assert.deepEqual(book.cancelCalls, [[1n, 2n]]);
  assert.equal(book.orders.get(3n)!.cancelled, false);
});

test('kill on a store kept from another deployment at the same addresses: the anchor resets it first, so the vault\'s orders are found and cancelled', async () => {
  const book = new Book();
  book.add(1n, 'Bid', T + 3_600);
  book.add(2n, 'AskWrite', T + 3_600);
  const store = new V2Store(':memory:');
  // What the previous devnet left: the same addresses, its own anchor, every order index of the new vault "ingested".
  const stale = new MmStore(store);
  const c = book.config.contracts;
  stale.bind({ chainId: book.config.chainId, clearinghouse: c.clearinghouse, orderBook: c.orderBook, vault: c.makerVault });
  assert.equal(stale.bindAnchor(`${book.config.registry.deployBlock}:${hash('d0')}`), 'fresh');
  stale.ingestOrders([], 2n, 0);
  stale.applySeriesRange([], 70_000_000n);
  store.recordTxSubmitted({ hash: hash('01'), kind: 'mm-cancel', key: '1,2', nonce: 3, to: c.makerVault, functionName: 'cancel' });

  const logLines: string[] = [];
  const { instance } = book.bot(store, logLines);
  const outcome = await instance.kill('fresh devnet');
  assert.equal(outcome.done, true, JSON.stringify(outcome));
  assert.equal(outcome.cancelled, 2, 'a stale makerIndex would have hidden both orders and answered done with nothing cancelled');
  assert.deepEqual(book.cancelCalls, [[1n, 2n]]);
  assert.equal(instance.mm.anchor(), `${book.config.registry.deployBlock}:${hash('d1')}`);
  assert.equal(instance.mm.scannedTo(), null, 'the stale series cursor is gone');
  assert.equal(store.getTx(hash('01'))?.status, 'dropped', 'the old chain\'s pending cancel no longer blocks the key');
  const warning = logLines.map((l) => JSON.parse(l) as { level: number; msg: string; check?: string }).find((l) => l.check === 'changed');
  assert.ok(warning !== undefined && warning.level === 40 && /another deployment at the same addresses/.test(warning.msg), logLines.join('\n'));
});

test('managedSeries: vault orders and inventory on a market outside the quoted set are managed (pull-only), not dropped', () => {
  const NVDA = '0x00000000000000000000000000000000000000aa';
  const TSLA = '0x00000000000000000000000000000000000000bb';
  const s = (longId: bigint, underlying: string, expiry: number) => ({ longId, underlying, isPut: false, strike: 1n, expiry });
  const live = (id: bigint) => ({ id, kind: 'Bid' as const, price: 1n, units: 100n, filled: 0n, validUntil: T + 60, cancelled: false });
  const managed = managedSeries({
    now: T,
    picked: [s(1n, NVDA, T + 3_600)],
    extra: new Map([
      ['2', s(2n, TSLA, T + 3_600)], // live bid on a market no longer quoted
      ['3', s(3n, TSLA, T - 60)], // expired, nothing left on the book
      ['4', s(4n, TSLA, T - 60)], // expired, an escrowed bid to reclaim
    ]),
    ordersBySeries: new Map([
      ['2', [live(20n)]],
      ['4', [{ ...live(40n), validUntil: T - 120 }]],
    ]),
  });
  assert.deepEqual([...managed.keys()].sort(), ['1', '2', '4']);
});

test('v2_mm_pricing: every selected series halted for its fair value pages, whatever the reason (a refusal, a stale asOf), not only transport failures; it clears once one quotes', async () => {
  const alerts: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const cleared: string[] = [];
  const instance = new MmBot({
    config: loadV2Config(env) as MmConfig,
    log: silentLogger(),
    client: {} as never,
    logClient: {} as never,
    sender: { execute: async () => assert.fail('nothing may be sent') },
    alerter: { alert: async (kind, _m, data = {}) => (alerts.push({ kind, data }), true), clear: (kind) => void cleared.push(kind) },
    store: new V2Store(':memory:'),
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
  });
  const series = (halts: Array<{ halt: string; detail?: string } | null>) => halts.map((halt, i) => ({ longId: BigInt(i), ticker: 'NVDA', selected: true, halt, sizes: null, fairReason: halt?.halt === 'fair-unavailable' ? (halt.detail ?? null) : null }));
  const tick = (halts: Array<{ halt: string; detail?: string } | null>) => ({
    head: { blockNumber: 1n, timestamp: T },
    stop: { day: 0, realised: 0n, limit: 1n, tripped: false },
    vault: { isQuoter: true, usdgWallet: 0n },
    plan: { netDelta: [], series: series(halts), capped: [], outflow: { cap: 2_500_000_000n, used: 0n, released: 0n, budget: 2_500_000_000n, planned: 0n, blocked: false } },
    foreignOutflow: null,
    outflowRefused: [],
    // The service answered every request: no transport failure.
    pricing: { requested: halts.length, failed: halts.filter((h) => h?.halt === 'fair-unavailable').length, reasons: { 'chain-inconsistent': 1 } },
    // Every LastTick names its vault (the budget-short clear is keyed by it).
    vaultAddress: '0x00000000000000000000000000000000000000fa',
    budget: NO_BUDGET_CUT,
  });
  const raise = (t: unknown) => (instance as unknown as { raiseAlerts(t: unknown): Promise<void> }).raiseAlerts(t);

  await raise(tick([{ halt: 'fair-stale', detail: 'asOf 1 is 2000 s old' }, { halt: 'fair-unavailable', detail: 'chain-inconsistent' }]));
  const pages = alerts.filter((a) => a.kind === 'v2_mm_pricing');
  assert.equal(pages.length, 1);
  assert.deepEqual(pages[0]!.data.halts, { 'fair-stale': 1, 'fair-unavailable': 1 });
  await raise(tick([{ halt: 'fair-stale' }, null]));
  assert.ok(cleared.includes('v2_mm_pricing'), 'a series quoting again clears it');
});

test('the outflow cap: a binding cap pages v2_mm_outflow once per UTC day, a level the bot did not cause pages v2_mm_outflow_foreign', async () => {
  const alerts: Array<{ kind: string; data: Record<string, unknown> }> = [];
  let wall = 1_790_000_000_000;
  const instance = new MmBot({
    config: loadV2Config(env) as MmConfig,
    log: silentLogger(),
    client: {} as never,
    logClient: {} as never,
    sender: { execute: async () => assert.fail('nothing may be sent') },
    alerter: { alert: async (kind, _m, data = {}) => (alerts.push({ kind, data }), true), clear: () => undefined },
    store: new V2Store(':memory:'),
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
    now: () => wall,
  });
  const CAP = 2_500_000_000n;
  const tick = (over: { blocked?: boolean; used?: bigint; foreign?: bigint | null; refused?: unknown[] } = {}) => ({
    head: { blockNumber: 1n, timestamp: T },
    // Every real LastTick carries the vault it was for (quoter.ts sets `vaultAddress: a.vault`); the fixture
    // omitted it, which is why the outflow page could be keyed per day only and no test noticed.
    vaultAddress: '0x00000000000000000000000000000000000000fa',
    stop: { day: 0, realised: 0n, limit: 1n, tripped: false },
    vault: { isQuoter: true, usdgWallet: 0n, outflow: { used: over.used ?? 0n, available: CAP }, limits: { maxDailyOutflow: CAP } },
    plan: {
      netDelta: [],
      series: [],
      capped: over.blocked ? [{ longId: 1n, caps: ['outflow'] }, { longId: 2n, caps: ['usdg', 'outflow'] }] : [],
      outflow: { cap: CAP, used: over.used ?? 0n, released: 0n, budget: 500_000_000n, planned: 500_000_000n, blocked: over.blocked ?? false },
    },
    foreignOutflow: over.foreign ?? null,
    outflowRefused: over.refused ?? [],
    pricing: { requested: 0, failed: 0, reasons: {} },
    budget: NO_BUDGET_CUT,
  });
  const raise = (t: unknown) => (instance as unknown as { raiseAlerts(t: unknown): Promise<void> }).raiseAlerts(t);

  await raise(tick());
  assert.equal(alerts.length, 0, 'a cap with room pages nothing');

  await raise(tick({ blocked: true, used: 2_000_000_000n }));
  const page = alerts.filter((a) => a.kind === 'v2_mm_outflow');
  assert.equal(page.length, 1);
  assert.equal(page[0]!.data.seriesTrimmed, 2, 'the page counts the series the cap trimmed');
  assert.equal(page[0]!.data.budget, 500_000_000n);

  // A call the chain refused anyway (a race with a spend between ticks) pages the same kind, not v2_mm_tx_rejected.
  await raise(tick({ used: 2_500_000_000n, refused: [{ what: 'place bid', available: 0n, wanted: 100n }] }));
  assert.equal(alerts.filter((a) => a.kind === 'v2_mm_outflow').length, 2);
  assert.equal(alerts.filter((a) => a.kind === 'v2_mm_tx_rejected').length, 0);

  // Foreign spend is forced, so it is never suppressed behind the cooldown, and it says how much.
  await raise(tick({ foreign: 900_000_000n }));
  const foreign = alerts.filter((a) => a.kind === 'v2_mm_outflow_foreign');
  assert.equal(foreign.length, 1);
  assert.equal(foreign[0]!.data.over, 900_000_000n);
  wall += 86_400_000;
  await raise(tick({ foreign: 1n }));
  assert.equal(alerts.filter((a) => a.kind === 'v2_mm_outflow_foreign').length, 2);
});

test('kill then resume while the kill\'s cancel passes are still running: the remaining passes stop, the resumed quotes are not cancelled', async () => {
  const book = new Book();
  book.add(1n, 'Bid', T + 3_600);
  book.failing.add(1n);
  const store = new V2Store(':memory:');
  const { instance } = book.bot(store);
  const sender = book.sender();
  let resumed = false;
  (instance.ctx as { sender: unknown }).sender = {
    execute: async (call: { functionName: string; args: readonly unknown[] }) => {
      const outcome = await sender.execute(call);
      // The operator resumes right after the kill's first cancel pass.
      if (!resumed) {
        resumed = true;
        instance.resume();
      }
      return outcome;
    },
  };
  const outcome = await instance.kill('resume drill');
  assert.equal(book.cancelCalls.length, 1, `no pass after the resume (${book.cancelCalls.length} cancel calls)`);
  assert.equal(outcome.done, false);
  assert.match(outcome.errors.join(' '), /resumed/);
  assert.equal(instance.mm.killed(), null);
});

test('kill: the cancels start while the page is still being delivered (a hung relay costs no fillable seconds)', async () => {
  const book = new Book();
  book.add(1n, 'Bid', T + 3_600);
  const store = new V2Store(':memory:');
  let release: (value: boolean) => void = () => undefined;
  const instance = new MmBot({
    config: book.config,
    log: silentLogger(),
    client: book.client() as never,
    logClient: { getLogs: async () => assert.fail('the kill scans no logs') } as never,
    sender: book.sender() as never,
    alerter: { alert: () => new Promise<boolean>((r) => (release = r)), clear: () => undefined },
    store,
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
    killWaitMs: 10_000,
    killRetryMs: 5,
  });
  const killing = instance.kill('hung relay');
  const deadline = Date.now() + 2_000;
  while (book.cancelCalls.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  assert.equal(book.cancelCalls.length, 1, 'the cancel went out before the page was delivered');
  release(true);
  assert.equal((await killing).done, true);
});


/*----------------------------- N vaults -----------------------------*/

const HEAD = { blockNumber: 100n, timestamp: 1_790_000_000 };
const HOUSE = '0x00000000000000000000000000000000000000fb' as Address;
const EXTRA = '0x00000000000000000000000000000000000000fc' as Address;
const FACTORY_LEGACY = '0x0000000000000000000000000000000000000f00' as Address;
const FACTORY_KINDED = '0x0000000000000000000000000000000000000f01' as Address;
const HOUSE_DAILY = '0x00000000000000000000000000000000000000fd' as Address;
const HOUSE_NEW_WEEKLY = '0x00000000000000000000000000000000000000fe' as Address;
/** What every House vault in these fixtures trades (HouseVault.underlying()); the tests below are not about it. */
const readUnderlying = async () => '0x00000000000000000000000000000000000000aa' as Address;

test('vaultTargets: treasury and MM_VAULTS extras have no epoch; a discovered House vault carries the one the chain gave', async () => {
  const config = loadV2Config({ ...env, MM_VAULTS: EXTRA, MM_HOUSE_FACTORY: `${FACTORY_LEGACY}:legacy-weekly` }) as MmConfig;
  const { instance } = bot(new V2Store(':memory:'), config, {
    discover: async () => [{ vault: HOUSE, factory: FACTORY_LEGACY, factoryKind: 'legacy-weekly' }],
    // epochEnd and epochId are the vault's (HouseVault.sol :191, :193); rollDue is recomputed from the head.
    readEpoch: async () => ({ epochEnd: HEAD.timestamp + 3_600, index: 4n, rollDue: true, kind: 'weekly' }),
    readUnderlying,
  });
  const targets = await instance.vaultTargets(HEAD);
  assert.deepEqual(
    targets.map((t) => [t.address.toLowerCase(), t.kind, t.epoch === null]),
    [[config.contracts.makerVault.toLowerCase(), 'treasury', true], [EXTRA.toLowerCase(), 'treasury', true], [HOUSE.toLowerCase(), 'house', false]],
  );
  assert.equal(targets[2]!.epoch!.epochEnd, HEAD.timestamp + 3_600);
  assert.equal(targets[2]!.epoch!.rollDue, false, 'rollDue comes from the head, not from what the reader claimed');

  // Criterion: protocolAccounts is the treasury, every House vault, every extra, and the quoter key.
  const accounts = instance.protocolAccountSet(targets.map((t) => t.address));
  assert.deepEqual(
    [...accounts].sort(),
    [config.contracts.makerVault.toLowerCase(), EXTRA.toLowerCase(), HOUSE.toLowerCase(), '0x0000000000000000000000000000000000000001'].sort(),
  );
});

test('a House vault whose epoch cannot be read is NOT quoted, and the gap is paged', async () => {
  const config = loadV2Config({ ...env, MM_HOUSE_FACTORY: `${FACTORY_KINDED}:kinded` }) as MmConfig;
  const { instance, alerts } = bot(new V2Store(':memory:'), config, {
    discover: async () => [{ vault: HOUSE, factory: FACTORY_KINDED, factoryKind: 'kinded' }],
    readEpoch: async () => null,
    readUnderlying,
  });
  const targets = await instance.vaultTargets(HEAD);
  // THE POINT: not "quoted with epoch null". epoch null means `no epoch discipline` to mm/epoch.ts,
  // so falling back to it would be permission to open risk past epochEnd in the one kind of vault
  // that has to be flat for rollEpoch.
  assert.deepEqual(targets.map((t) => t.kind), ['treasury']);
  assert.deepEqual(alerts, ['v2_mm_house_unavailable']);
});

test('each House vault winds down on its own kind -- legacy weekly, kinded weekly and kinded daily', async () => {
  const config = loadV2Config({
    ...env,
    MM_HOUSE_FACTORY: `${FACTORY_LEGACY}:legacy-weekly,${FACTORY_KINDED}:kinded`,
    MM_EPOCH_WIND_DOWN_S: '14400',
    MM_EPOCH_WIND_DOWN_DAILY_S: '1800',
  }) as MmConfig;
  // The reader stands in for mm/house.ts chainEpochReader: its kind is what readEpochKind decides (house.test.ts).
  const kinds: Record<string, 'weekly' | 'daily'> = { [HOUSE.toLowerCase()]: 'weekly', [HOUSE_NEW_WEEKLY.toLowerCase()]: 'weekly', [HOUSE_DAILY.toLowerCase()]: 'daily' };
  const { instance, alerts } = bot(new V2Store(':memory:'), config, {
    discover: async () => [
      { vault: HOUSE, factory: FACTORY_LEGACY, factoryKind: 'legacy-weekly' },
      { vault: HOUSE_NEW_WEEKLY, factory: FACTORY_KINDED, factoryKind: 'kinded' },
      { vault: HOUSE_DAILY, factory: FACTORY_KINDED, factoryKind: 'kinded' },
    ],
    readEpoch: async (found) => ({ epochEnd: HEAD.timestamp + 3_600, index: 1n, rollDue: false, kind: kinds[found.vault.toLowerCase()]! }),
    readUnderlying,
  });
  const house = (await instance.vaultTargets(HEAD)).filter((t) => t.kind === 'house');
  assert.deepEqual(
    house.map((t) => [t.address.toLowerCase(), t.epoch?.kind, t.epoch?.windDownS]),
    [[HOUSE.toLowerCase(), 'weekly', 14_400], [HOUSE_NEW_WEEKLY.toLowerCase(), 'weekly', 14_400], [HOUSE_DAILY.toLowerCase(), 'daily', 1_800]],
  );
  assert.deepEqual(alerts, []);
  // And the lead is what the planner's predicate uses: one hour before the boundary a daily vault still quotes, a
  // weekly one is already winding down.
  const series = { expiry: HEAD.timestamp + 3_000 };
  assert.equal(epochSelectable(series, house[2]!.epoch, HEAD.timestamp, 14_400), 'ok');
  assert.equal(epochSelectable(series, house[0]!.epoch, HEAD.timestamp, 14_400), 'epoch-winddown');
});

test('once a kinded (daily) factory is configured, the legacy weekly vault is quoted closing-only for its whole epoch', async () => {
  const discover = async () => [
    { vault: HOUSE, factory: FACTORY_LEGACY, factoryKind: 'legacy-weekly' as const },
    { vault: HOUSE_DAILY, factory: FACTORY_KINDED, factoryKind: 'kinded' as const },
  ];
  const kinds: Record<string, 'weekly' | 'daily'> = { [HOUSE.toLowerCase()]: 'weekly', [HOUSE_DAILY.toLowerCase()]: 'daily' };
  // A full day before the boundary: far outside either wind-down lead, so only the retirement can stop new risk.
  const epochEnd = HEAD.timestamp + 86_400;
  const readEpoch = async (found: { vault: Address }) => ({ epochEnd, index: 7n, rollDue: false, kind: kinds[found.vault.toLowerCase()]! });
  const series = { expiry: epochEnd };

  const both = loadV2Config({ ...env, MM_HOUSE_FACTORY: `${FACTORY_LEGACY}:legacy-weekly,${FACTORY_KINDED}:kinded` }) as MmConfig;
  const { instance, alerts } = bot(new V2Store(':memory:'), both, { discover, readEpoch, readUnderlying });
  const house = (await instance.vaultTargets(HEAD)).filter((t) => t.kind === 'house');
  // The legacy vault is STILL a target (its resting orders get cancelled and inventory closed), marked winding down;
  // the daily vault is not.
  assert.deepEqual(
    house.map((t) => [t.address.toLowerCase(), t.epoch?.kind, t.epoch?.windingDown]),
    [[HOUSE.toLowerCase(), 'weekly', true], [HOUSE_DAILY.toLowerCase(), 'daily', false]],
  );
  assert.deepEqual(alerts, []);
  assert.equal(epochSelectable(series, house[0]!.epoch, HEAD.timestamp, 14_400), 'epoch-winddown', 'weekly: closing trades only');
  assert.equal(epochSelectable(series, house[1]!.epoch, HEAD.timestamp, 14_400), 'ok', 'daily: quotes normally');

  // Control: the SAME legacy vault with no kinded factory configured quotes exactly as before.
  const legacyOnly = loadV2Config({ ...env, MM_HOUSE_FACTORY: `${FACTORY_LEGACY}:legacy-weekly` }) as MmConfig;
  const alone = bot(new V2Store(':memory:'), legacyOnly, { discover: async () => [(await discover())[0]!], readEpoch, readUnderlying });
  const [legacy] = (await alone.instance.vaultTargets(HEAD)).filter((t) => t.kind === 'house');
  assert.equal(legacy!.epoch?.windingDown, false);
  assert.equal(epochSelectable(series, legacy!.epoch, HEAD.timestamp, 14_400), 'ok');
});

test('an untagged factory is an unknown kind rule -- its vault is NOT quoted, the reader is never asked, and the fix is paged', async () => {
  const config = loadV2Config({ ...env, MM_HOUSE_FACTORY: FACTORY_LEGACY }) as MmConfig;
  assert.deepEqual(config.tuning.houseFactories, [{ address: getAddress(FACTORY_LEGACY), kind: 'unknown' }]);
  let asked = 0;
  const { instance, alerts } = bot(new V2Store(':memory:'), config, {
    discover: async () => [{ vault: HOUSE, factory: FACTORY_LEGACY, factoryKind: 'unknown' }],
    readEpoch: async () => ((asked += 1), { epochEnd: HEAD.timestamp + 3_600, index: 1n, rollDue: false, kind: 'weekly' }),
    readUnderlying,
  });
  const targets = await instance.vaultTargets(HEAD);
  assert.deepEqual(targets.map((t) => t.kind), ['treasury']);
  assert.equal(asked, 0, 'no read is attempted for a vault whose kind rule is unknown');
  assert.deepEqual(alerts, ['v2_mm_house_unavailable']);
  assert.match(String(instance.houseGap()), /untagged/);
});

test('a House epoch view without a kind is not quoted (the wind-down would silently fall back to weekly)', async () => {
  const config = loadV2Config({ ...env, MM_HOUSE_FACTORY: `${FACTORY_KINDED}:kinded` }) as MmConfig;
  const { instance, alerts } = bot(new V2Store(':memory:'), config, {
    discover: async () => [{ vault: HOUSE_DAILY, factory: FACTORY_KINDED, factoryKind: 'kinded' }],
    readEpoch: async () => ({ epochEnd: HEAD.timestamp + 3_600, index: 1n, rollDue: false }),
    readUnderlying,
  });
  assert.deepEqual((await instance.vaultTargets(HEAD)).map((t) => t.kind), ['treasury']);
  assert.deepEqual(alerts, ['v2_mm_house_unavailable']);
});

test('MM_HOUSE_FACTORY set but the factory cannot be enumerated: the treasury still ticks and the gap is named every tick', async () => {
  // The House ABI IS published now (the export added HouseVault.json and HouseVaultFactory.json and
  // gen-abis renders both), so this no longer exercises the missing-artifact branch it was written for.
  // The PROPERTY it protects is unchanged and still worth proving: a configured factory the bot cannot
  // enumerate is REPORTED every tick rather than being silently equivalent to "no House vaults", and the
  // treasury keeps quoting through it. Here the client is unreachable, so `vaults()` throws.
  const config = loadV2Config({ ...env, MM_HOUSE_FACTORY: `${FACTORY_LEGACY}:legacy-weekly` }) as MmConfig;
  const { instance, alerts } = bot(new V2Store(':memory:'), config);
  const targets = await instance.vaultTargets(HEAD);
  assert.deepEqual(targets.map((t) => t.kind), ['treasury'], 'the treasury is unaffected by the House gap');
  assert.deepEqual(alerts, ['v2_mm_house_unavailable']);
  assert.match(String(instance.houseGap()), /could not be enumerated/);
});

/*--------------- a House vault listed in MM_VAULTS is refused, not quoted without its epoch ---------------*/

test('an MM_VAULTS entry the House factory enumerates is refused by name -- not treasury, not house -- and the rest still quote', async () => {
  const config = loadV2Config({ ...env, MM_VAULTS: `${EXTRA},${HOUSE}`, MM_HOUSE_FACTORY: `${FACTORY_LEGACY}:legacy-weekly` }) as MmConfig;
  let epochReads = 0;
  const { instance, alerts } = bot(new V2Store(':memory:'), config, {
    discover: async () => [
      { vault: HOUSE, factory: FACTORY_LEGACY, factoryKind: 'legacy-weekly' },
      { vault: HOUSE_NEW_WEEKLY, factory: FACTORY_LEGACY, factoryKind: 'legacy-weekly' },
    ],
    readEpoch: async () => ((epochReads += 1), { epochEnd: HEAD.timestamp + 3_600, index: 1n, rollDue: false, kind: 'weekly' }),
    readUnderlying,
  });
  const targets = await instance.vaultTargets(HEAD);
  // THE POINT: earlier HOUSE was quoted as ['treasury', epoch null] -- no epoch discipline on depositor money.
  assert.deepEqual(
    targets.map((t) => [t.address.toLowerCase(), t.kind]),
    [[config.contracts.makerVault.toLowerCase(), 'treasury'], [EXTRA.toLowerCase(), 'treasury'], [HOUSE_NEW_WEEKLY.toLowerCase(), 'house']],
  );
  assert.equal(epochReads, 1, 'the refused vault is not read as a House vault either');
  assert.deepEqual(alerts, ['v2_mm_vault_is_house']);
  assert.deepEqual(instance.refused().map((r) => [r.address.toLowerCase(), r.reason]), [[HOUSE.toLowerCase(), `House factory ${FACTORY_LEGACY} enumerates it`]]);
});

test('the other order -- quoted as treasury while no factory lists it, refused the tick a factory does', async () => {
  const config = loadV2Config({ ...env, MM_VAULTS: HOUSE, MM_HOUSE_FACTORY: `${FACTORY_KINDED}:kinded` }) as MmConfig;
  let listed = false;
  const { instance, alerts } = bot(new V2Store(':memory:'), config, {
    discover: async () => (listed ? [{ vault: HOUSE, factory: FACTORY_KINDED, factoryKind: 'kinded' as const }] : []),
    readEpoch: async () => ({ epochEnd: HEAD.timestamp + 3_600, index: 1n, rollDue: false, kind: 'daily' }),
    readUnderlying,
  });
  // Tick 1: nothing says it is a House vault (the injected probe answers false), so MM_VAULTS is taken at its word.
  assert.deepEqual((await instance.vaultTargets(HEAD)).map((t) => [t.address.toLowerCase(), t.kind]), [[config.contracts.makerVault.toLowerCase(), 'treasury'], [HOUSE.toLowerCase(), 'treasury']]);
  assert.deepEqual(alerts, []);
  // Tick 2: the factory now enumerates it. It is refused, and NOT picked up as a House vault by the loop below.
  listed = true;
  assert.deepEqual((await instance.vaultTargets(HEAD)).map((t) => t.kind), ['treasury']);
  assert.deepEqual(alerts, ['v2_mm_vault_is_house']);
  assert.equal(instance.refused().length, 1);
});

test('with no House factory configured, an MM_VAULTS entry that answers epochEnd() is refused; the probe is asked once', async () => {
  const config = loadV2Config({ ...env, MM_VAULTS: `${HOUSE},${EXTRA}` }) as MmConfig;
  const asked: string[] = [];
  const { instance, alerts } = bot(new V2Store(':memory:'), config, undefined, async (vault) => (asked.push(vault.toLowerCase()), vault.toLowerCase() === HOUSE.toLowerCase()));
  for (let tick = 0; tick < 2; tick += 1) {
    assert.deepEqual((await instance.vaultTargets(HEAD)).map((t) => t.address.toLowerCase()), [config.contracts.makerVault.toLowerCase(), EXTRA.toLowerCase()]);
  }
  assert.deepEqual(asked.sort(), [EXTRA.toLowerCase(), HOUSE.toLowerCase()].sort(), 'a conclusive answer is cached: one probe per address');
  assert.deepEqual(alerts, ['v2_mm_vault_is_house', 'v2_mm_vault_is_house'], 'paged every tick it stays listed (the alerter dedupes by vault)');
  assert.deepEqual(instance.refused().map((r) => r.reason), ['it answers HouseVault.epochEnd()']);
});

test('a probe that cannot reach the chain fails closed -- the entry is skipped this tick, not quoted, and asked again', async () => {
  const config = loadV2Config({ ...env, MM_VAULTS: EXTRA }) as MmConfig;
  let down = true;
  const { instance, alerts } = bot(new V2Store(':memory:'), config, undefined, async () => {
    if (down) throw new Error('HTTP request failed: connect ECONNREFUSED');
    return false;
  });
  assert.deepEqual((await instance.vaultTargets(HEAD)).map((t) => t.kind), ['treasury'], 'unknown is not "not a House vault"');
  assert.deepEqual(alerts, ['v2_mm_vault_unreadable']);
  assert.deepEqual(instance.refused(), [], 'not refused either: it may be a MakerVault');
  down = false;
  assert.deepEqual((await instance.vaultTargets(HEAD)).map((t) => t.address.toLowerCase()), [config.contracts.makerVault.toLowerCase(), EXTRA.toLowerCase()]);
});

test('answersEpochEnd -- an answer is a House vault, a revert or no data is not, anything else is thrown', async () => {
  const probe = (read: () => Promise<unknown>) => answersEpochEnd({ readContract: read } as never)(EXTRA, 1n);
  assert.equal(await probe(async () => 1_790_000_000), true);
  assert.equal(await probe(async () => { throw new ContractFunctionRevertedError({ abi: [], functionName: 'epochEnd' }); }), false);
  assert.equal(await probe(async () => { throw new ContractFunctionZeroDataError({ functionName: 'epochEnd' }); }), false);
  await assert.rejects(probe(async () => { throw new Error('HTTP request failed: connect ECONNREFUSED'); }), /ECONNREFUSED/);
});

test('MM_VAULT_CAPS tightens one vault without touching the others', async () => {
  const config = loadV2Config({
    ...env,
    MM_VAULTS: EXTRA,
    MM_MAX_SERIES_UNITS: '80',
    MM_DAILY_LOSS_LIMIT_USDG6: '900000000',
    MM_VAULT_CAPS: `{"${EXTRA}":{"maxSeriesUnits":"5","dailyLossLimitUsdg6":"1000000"}}`,
  }) as MmConfig;
  const { instance } = bot(new V2Store(':memory:'), config);
  const [treasury, extra] = await instance.vaultTargets(HEAD);
  assert.equal(treasury!.caps.maxSeriesUnits, 80n, 'the process-wide value where there is no override');
  assert.equal(treasury!.caps.dailyLossLimitUsdg6, 900_000_000n);
  assert.equal(extra!.caps.maxSeriesUnits, 5n);
  assert.equal(extra!.caps.dailyLossLimitUsdg6, 1_000_000n);
  assert.equal(extra!.caps.maxTotalNotionalUsdg6, treasury!.caps.maxTotalNotionalUsdg6, 'an absent field falls back');
});


test('unionProtocolBook: vault B\'s resting ask is in the book vault A plans against', () => {
  const vaultA = '0x00000000000000000000000000000000000000fa' as Address;
  const vaultB = '0x00000000000000000000000000000000000000fb' as Address;
  const outsider = '0x00000000000000000000000000000000000000cc' as Address;
  const accounts = new Set<string>([vaultA, vaultB]);
  const order = (maker: Address, over: Partial<{ id: bigint; longId: bigint; kind: OrderKindName; price: bigint; units: bigint; filled: bigint; cancelled: boolean }> = {}) => ({
    id: 1n, longId: 7n, kind: 'AskWrite' as OrderKindName, price: 99n, units: 10n, filled: 0n, cancelled: false, maker, validUntil: 0, ...over,
  });

  // THE WHOLE POINT. A quotes, B rests an ask at 99 on the same longId. The book A plans against
  // must contain B's order, or crossesProtocol can only ever catch A crossing itself and
  // v2_mm_protocol_cross is coverage that does not exist.
  const book = unionProtocolBook([[order(vaultA, { id: 1n, kind: 'Bid', price: 90n })], [order(vaultB, { id: 2n })]], accounts);
  assert.deepEqual(book.map((r) => [r.maker, r.kind, r.price]), [[vaultA, 'Bid', 90n], [vaultB, 'AskWrite', 99n]]);

  // A book built from ONE vault's orders - what tickOne did before this fix - cannot see the cross.
  assert.deepEqual(unionProtocolBook([[order(vaultA, { id: 1n, kind: 'Bid', price: 90n })]], accounts).map((r) => r.maker), [vaultA]);

  // Not resting, or not ours: dropped.
  assert.deepEqual(unionProtocolBook([[order(outsider, { id: 3n })]], accounts), [], 'an outside maker is not protocol-owned');
  assert.deepEqual(unionProtocolBook([[order(vaultB, { id: 4n, cancelled: true })]], accounts), [], 'cancelled is not resting');
  assert.deepEqual(unionProtocolBook([[order(vaultB, { id: 5n, filled: 10n })]], accounts), [], 'fully filled is not resting');
  assert.deepEqual(unionProtocolBook([[order(zeroAddress, { id: 6n })]], accounts), [], 'a zero maker is an empty slot');

  // Checksum-cased maker still matches: lower-cased compare, never checksum equality.
  assert.equal(unionProtocolBook([[order(vaultB.toUpperCase().replace('0X', '0x') as Address, { id: 7n })]], accounts).length, 1);
});

/*//////////////////////////////////////////////////////////////
        PER-VAULT ALERT SCOPING
//////////////////////////////////////////////////////////////*/

/**
 * THE CASE THAT DID NOT EXIST. A change made the loss-stop MARK per vault and tested that two vaults do not SHARE a
 * row; nobody tested that they both GET one. The probe beside the mark still asked `dedupeKey null`, which matches
 * ANY vault's page from that UTC day, so the first vault DELIVERED silenced every other vault for the rest of the
 * day - the same outcome an earlier fix closed, by a different route.
 *
 * These use the real Alerter against a real store, because the bug lives in the v2_alerts row the page writes: a
 * mocked alerter that records nothing cannot fail this test, which is exactly how it stayed invisible.
 */
const lossStopRig = () => {
  const store = new V2Store(':memory:');
  let wall = 1_790_000_000_000;
  const posts: Array<{ message: string }> = [];
  let relayUp = true;
  const alerter = new Alerter({
    mode: 'mm',
    chainId: 1,
    webhook: 'http://127.0.0.1:9/relay',
    token: null,
    cooldownMs: 60_000,
    log: silentLogger(),
    store,
    now: () => wall,
    fetch: (async (_url: string, init: { body: string }) => {
      posts.push({ message: String(JSON.parse(init.body).message ?? '') });
      return relayUp ? { ok: true, status: 200, text: async () => '' } : { ok: false, status: 502, text: async () => 'relay down' };
    }) as unknown as typeof fetch,
  });
  const instance = new MmBot({
    config: loadV2Config(env) as MmConfig,
    log: silentLogger(),
    client: {} as never,
    logClient: {} as never,
    sender: { execute: async () => assert.fail('nothing may be sent') },
    alerter,
    store,
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
    now: () => wall,
  });
  const day = Math.floor(1_790_000_000 / 86_400);
  const raise = (timestamp: number, vaultAddress: string) =>
    (instance as unknown as { raiseAlerts(t: unknown): Promise<void> }).raiseAlerts({
      head: { blockNumber: 1n, timestamp },
      vaultAddress,
      stop: { day, realised: -2_000_000_000n, limit: 1_000_000_000n, tripped: true },
      vault: { isQuoter: true, usdgWallet: 0n },
      plan: { netDelta: [], series: [], capped: [], outflow: { cap: 2_500_000_000n, used: 0n, released: 0n, budget: 2_500_000_000n, planned: 0n, blocked: false } },
      foreignOutflow: null,
      outflowRefused: [],
      pricing: { requested: 0, failed: 0, reasons: {} },
      budget: NO_BUDGET_CUT,
    });
  return {
    store,
    posts,
    raise,
    advance: (ms: number) => (wall += ms),
    setRelay: (up: boolean) => (relayUp = up),
    pagesFor: (vault: string) => posts.filter((p) => p.message.toLowerCase().includes(vault.toLowerCase())).length,
  };
};

const VAULT_A = '0x00000000000000000000000000000000000000fa';
const VAULT_B = '0x00000000000000000000000000000000000000fb';

test('loss stop: vault A being paged does not silence vault B on the same UTC day', async () => {
  const rig = lossStopRig();

  await rig.raise(1_790_000_000, VAULT_A);
  assert.equal(rig.pagesFor(VAULT_A), 1, 'vault A trips and is paged');

  rig.advance(60_000);
  await rig.raise(1_790_000_060, VAULT_B);
  // The assertion the bug fails: before the fix the probe matched A's delivered row, B was marked as already
  // paged, and the retry block below it was skipped - so vault B's loss stop tripped and NOBODY WAS PAGED.
  assert.equal(rig.pagesFor(VAULT_B), 1, 'vault B trips the same day and MUST be paged');

  rig.advance(60_000);
  await rig.raise(1_790_000_120, VAULT_A);
  assert.equal(rig.pagesFor(VAULT_A), 1, 'and A is still not paged twice for the same day');
});

test("loss stop retry clock is per vault: A's failure does not delay B, A's success does not unblock B early", async () => {
  const delayed = lossStopRig();
  delayed.setRelay(false);
  await delayed.raise(1_790_000_000, VAULT_A);
  assert.equal(delayed.pagesFor(VAULT_A), 1, "A's page was attempted and the relay refused it");
  delayed.setRelay(true);
  delayed.advance(1_000);
  await delayed.raise(1_790_000_001, VAULT_B);
  assert.equal(delayed.pagesFor(VAULT_B), 1, "A's failed delivery must not hold B's first page behind the retry spacing");

  const unblocked = lossStopRig();
  unblocked.setRelay(false);
  await unblocked.raise(1_790_000_000, VAULT_B);
  assert.equal(unblocked.pagesFor(VAULT_B), 1, "B's own page failed, so B is now behind its retry spacing");
  unblocked.setRelay(true);
  unblocked.advance(1_000);
  await unblocked.raise(1_790_000_001, VAULT_A);
  assert.equal(unblocked.pagesFor(VAULT_A), 1, 'A delivers');
  unblocked.advance(1_000);
  await unblocked.raise(1_790_000_002, VAULT_B);
  assert.equal(unblocked.pagesFor(VAULT_B), 1, "A's success must not clear B's clock and retry B early");
});

test('/state fills are attributed and windowed per vault: a busy vault cannot evict a quiet one', () => {
  const busy = Array.from({ length: 50 }, (_, i) => ({ at: 2_000 + i, orderId: 1n, longId: 1n, kind: 'AskWrite', side: 'sell', units: 1n, price: 1n })) as never[];
  const quiet = [{ at: 1_000, orderId: 9n, longId: 9n, kind: 'Bid', side: 'buy', units: 1n, price: 1n }] as never[];
  const view = flattenRecentFills(new Map([[VAULT_A, busy], [VAULT_B, quiet]]));

  assert.equal(view.length, 51, "the quiet vault's fill survives 50 fills on the busy one");
  assert.equal(view.filter((f) => f.vault === VAULT_B).length, 1);
  assert.ok(view.every((f) => typeof f.vault === 'string' && f.vault.length > 0), 'every entry says which vault it came from');
  assert.equal(view[0]?.at, 2_049, 'newest first across the fleet');
  assert.equal(view.at(-1)?.vault, VAULT_B, "and the oldest entry is still the quiet vault's");
});

/*--------------------- one bad vault, the rest still act ---------------------*/

// BAD's `orderBook` read throws, as it does for an address with no code. It is listed BEFORE GOOD, so a fault that
// escapes its own vault's boundary is exactly the one that stops GOOD.
const BAD_VAULT = '0x00000000000000000000000000000000000000bd' as Address;
const GOOD_VAULT = '0x0000000000000000000000000000000000000060' as Address;

function badThenGood(): Book {
  const book = new Book(loadV2Config({ ...env, MM_VAULTS: `${BAD_VAULT},${GOOD_VAULT}` }) as MmConfig);
  book.unreadable.add(BAD_VAULT.toLowerCase());
  return book;
}

test('tick: a vault whose orderBook read throws is skipped and paged by name; the vault after it is still read and planned', async () => {
  const book = badThenGood();
  const alerts: Array<{ kind: string; vault: unknown }> = [];
  // readVaultState's pinned multicall, answered per view: a vault with nothing on the book, not quoting.
  const views: Record<string, unknown> = {
    limits: { maxSeriesUnits: 0n, maxTotalNotional: 0n, askToleranceBps: 0, maxBidBpsOfSpot: 0, maxOrderLifetime: 0, maxDailyOutflow: 0n },
    totalNotional: 0n,
    trackedSeries: [],
    canCall: [false, 0],
    pendingFeeParams: [{ premiumFeeBps: 0, resaleFeeBps: 0 }, 0],
    tradingPaused: false,
    owed: 0n,
    makerOrderCount: 0n,
    feeParams: { premiumFeeBps: 0, resaleFeeBps: 0 },
    balanceOf: 0n,
    isRegularSession: false,
    closeOf: 0n,
    outflow: [0n, 0n],
    // The two House reserve views readVaultState appends for a House vault (never asked of a treasury one).
    pendingDepositUsdg: 0n,
    owedUsdg: 0n,
  };
  const instance = new MmBot({
    config: book.config,
    log: silentLogger(),
    client: {
      ...book.client(),
      multicall: async ({ contracts }: { contracts: ReadonlyArray<{ functionName: string }> }) =>
        contracts.map((c) => (c.functionName in views ? { status: 'success', result: views[c.functionName] } : { status: 'failure', error: new Error(`no view ${c.functionName}`) })),
    } as never,
    logClient: { getBlockNumber: async () => 65_200_000n, getLogs: async () => [] } as never,
    sender: { execute: async () => assert.fail('nothing may be sent') },
    alerter: { alert: async (kind, _m, data = {}) => (alerts.push({ kind, vault: data.vault }), true), clear: () => undefined },
    store: new V2Store(':memory:'),
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
  });
  // Planning itself is planner.ts's and is not what this pins: record which vaults REACH it (the plan phase,
  // planVault; sendVault only hands the plan back).
  const planned: string[] = [];
  const empty = { selected: [], netDelta: [], series: [], txs: [], capped: [], outflow: { cap: 0n, used: 0n, released: 0n, budget: 0n, planned: 0n, blocked: false } };
  const seam = instance as unknown as {
    trackOrders: () => Promise<unknown[]>;
    planVault: (p: { a: { vault: string } }) => Promise<unknown>;
    sendVault: (pv: { plan: unknown }) => Promise<unknown>;
  };
  seam.trackOrders = async () => [];
  seam.planVault = async (p) => {
    planned.push(p.a.vault.toLowerCase());
    return { prepared: p, plan: empty };
  };
  seam.sendVault = async (pv) => pv.plan;

  // Captured rather than awaited bare, so a fault that escapes BAD's boundary fails on the vault it stopped.
  const escaped = await instance.tick().then(
    () => null,
    (error: unknown) => (error as Error).message,
  );
  assert.deepEqual(
    planned,
    [book.config.contracts.makerVault.toLowerCase(), GOOD_VAULT.toLowerCase()],
    `the good vault ${GOOD_VAULT} listed after the bad one must still be planned${escaped === null ? '' : `; the tick threw instead: ${escaped}`}`,
  );
  assert.equal(escaped, null, 'one bad vault must not fail the tick');
  assert.deepEqual(
    alerts.filter((a) => a.kind === 'v2_mm_vault_unreadable').map((a) => String(a.vault).toLowerCase()),
    [BAD_VAULT.toLowerCase()],
    'the bad vault is paged, by address, and nothing else is',
  );
});

/*
 * The fair-share tx budget in tick() was the one piece of new arithmetic with no
 * test. Three readable vaults (treasury first, then MM_VAULTS in order) and MM_MAX_TX_PER_TICK = 10, so
 * share = 3. Every vault plans before any sends, and a vault still to send reserves what its plan needs, up
 * to a share. The seam: planVault returns a plan of `needs[i]` transactions, and sendVault records the budget it was
 * handed and "sends" `spend[i]` (default: its need) by charging the same per-tick counter execute() charges -- planner
 * and sender are not what this pins. Each scenario runs the real tick() loop; the numbers are the arithmetic's own.
 */
async function tickBudgets(needs: readonly number[], opts: { spend?: readonly number[]; throwAfterSending?: number } = {}): Promise<{ budgets: number[]; alerts: string[] }> {
  const V1 = '0x0000000000000000000000000000000000000061' as Address;
  const V2 = '0x0000000000000000000000000000000000000062' as Address;
  const book = new Book(loadV2Config({ ...env, MM_VAULTS: `${V1},${V2}`, MM_MAX_TX_PER_TICK: '10' }) as MmConfig);
  const views: Record<string, unknown> = {
    limits: { maxSeriesUnits: 0n, maxTotalNotional: 0n, askToleranceBps: 0, maxBidBpsOfSpot: 0, maxOrderLifetime: 0, maxDailyOutflow: 0n },
    totalNotional: 0n, trackedSeries: [], canCall: [false, 0], pendingFeeParams: [{ premiumFeeBps: 0, resaleFeeBps: 0 }, 0],
    tradingPaused: false, owed: 0n, makerOrderCount: 0n, feeParams: { premiumFeeBps: 0, resaleFeeBps: 0 }, balanceOf: 0n,
    isRegularSession: false, closeOf: 0n, outflow: [0n, 0n],
  };
  const alerts: string[] = [];
  const instance = new MmBot({
    config: book.config,
    log: silentLogger(),
    client: {
      ...book.client(),
      multicall: async ({ contracts }: { contracts: ReadonlyArray<{ functionName: string }> }) =>
        contracts.map((c) => (c.functionName in views ? { status: 'success', result: views[c.functionName] } : { status: 'failure', error: new Error(`no view ${c.functionName}`) })),
    } as never,
    logClient: { getBlockNumber: async () => 65_200_000n, getLogs: async () => [] } as never,
    sender: { execute: async () => assert.fail('nothing may be sent') },
    alerter: { alert: async (kind) => (alerts.push(kind), true), clear: () => undefined },
    store: new V2Store(':memory:'),
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
  });
  const budgets: number[] = [];
  const seam = instance as unknown as { trackOrders: () => Promise<unknown[]>; planVault: (...args: unknown[]) => Promise<unknown>; sendVault: (...args: unknown[]) => Promise<unknown>; sentThisTick: number };
  seam.trackOrders = async () => [];
  let planned = 0;
  seam.planVault = async (p: unknown) => {
    const i = planned++;
    const txs = Array.from({ length: needs[i] ?? 0 }, () => ({ type: 'sync', longIds: [], reason: 'stand-in' }));
    return { prepared: p, i, plan: { selected: [], netDelta: [], series: [], txs, capped: [], outflow: { cap: 0n, used: 0n, released: 0n, budget: 0n, planned: 0n, blocked: false } } };
  };
  seam.sendVault = async (pv: unknown, _head: unknown, _startedAt: unknown, budget: unknown) => {
    const { i, plan } = pv as { i: number; plan: { txs: unknown[] } };
    budgets.push(budget as number);
    // What execute() would have done: one charge per send, capped by the budget it was handed.
    seam.sentThisTick += Math.min(opts.spend?.[i] ?? plan.txs.length, budget as number);
    if (opts.throwAfterSending === i) throw new Error('head re-read failed after the sends went out');
    return plan;
  };
  await instance.tick();
  return { budgets, alerts };
}

test('tick: the fair-share tx budget -- a vault still to send reserves what it needs up to a share; the House surplus goes to the treasury', async () => {
  // M = 10, n = 3, share = 3. House vaults that need a full share each: treasury 10 - 2x3 = 4, then 3 and 3.
  assert.deepEqual((await tickBudgets([10, 3, 3])).budgets, [4, 3, 3]);
  // the launch shape (the treasury held to 20 of 60 while each House vault sent about 2): House
  // plans of 1 transaction each reserve 1 each, so the treasury may send 8, not 4, IN THE SAME TICK. BREAK CHECK:
  // reserve a full `share` per later vault again (vaultBudgetOf: `Math.min(share, need)` -> `share`) and this reads [4, 3, 5].
  assert.deepEqual((await tickBudgets([10, 1, 1])).budgets, [8, 2, 1]);
  assert.deepEqual((await tickBudgets([10, 0, 0])).budgets, [10, 0, 0], 'House vaults with nothing to send leave the treasury the whole budget');
  // A treasury that spends 1 leaves 9: the second vault keeps one share for the third and may spend 6.
  assert.deepEqual((await tickBudgets([10, 6, 3], { spend: [1, 6, 3] })).budgets, [4, 6, 3]);
  // Nobody needs anything: every vault is offered what remains.
  assert.deepEqual((await tickBudgets([0, 0, 0])).budgets, [10, 10, 10]);
  // The process budget is a bound: three vaults spending everything they are handed send exactly M.
  const { budgets } = await tickBudgets([10, 10, 10]);
  assert.deepEqual(budgets, [4, 3, 3]);
  assert.equal(budgets.reduce((a, b) => a + b, 0), 10);
});

test('tick: a vault that throws AFTER sending is still charged, so the vaults after it cannot push the tick past MM_MAX_TX_PER_TICK', async () => {
  // Earlier the charge came from lastByVault, written at the END of the vault's tick: a vault that sent 4 and then
  // threw (the post-send head re-read is an RPC call) was never charged, the next vault was offered 7 instead
  // of 3, and the tick could send up to 14 against a budget of 10. Charging what execute() actually sent, on
  // the catch path too, keeps M a bound on the process. BREAK CHECK: charge from lastByVault again on the
  // catch path (this seam never writes lastByVault, exactly like a sendVault that threw before its last line) and the
  // second vault is offered more than 3.
  const { budgets, alerts } = await tickBudgets([10, 3, 3], { throwAfterSending: 0 });
  assert.deepEqual(budgets, [4, 3, 3], 'the second vault is budgeted as if the treasury had sent its 4');
  assert.deepEqual(alerts, ['v2_mm_vault_unreadable'], 'the throwing vault is paged and the tick continues');
});

test('kill: a vault whose reads throw is skipped and named; the vault after it is still cancelled, and the kill does not answer done', async () => {
  const book = badThenGood();
  book.add(1n, 'Bid', T + 3_600, { maker: GOOD_VAULT });
  const { instance } = book.bot(new V2Store(':memory:'));
  const outcome = await instance.kill('one bad vault');
  assert.deepEqual(book.cancelCalls, [[1n]], `the good vault ${GOOD_VAULT} listed after the bad one must still be cancelled`);
  assert.equal(book.orders.get(1n)!.cancelled, true);
  assert.equal(outcome.cancelled, 1);
  // A vault nobody could read may still hold orders that can fill, so this is not a finished kill.
  assert.equal(outcome.done, false);
  assert.equal(outcome.remaining, -1);
  assert.ok(outcome.errors.some((e) => e.toLowerCase().includes(`vault ${BAD_VAULT.toLowerCase()} could not be read`)), JSON.stringify(outcome.errors));

  // Once the bad vault reads again, the next kill finishes.
  book.unreadable.clear();
  const again = await instance.kill('it reads now');
  assert.equal(again.done, true, JSON.stringify(again));
  assert.equal(again.remaining, 0);
});

test('kill: an order filled between the read and the cancel is not counted as cancelled; the count comes from the book, not the receipt', async () => {
  const book = new Book();
  book.add(1n, 'Bid', T + 3_600);
  book.add(2n, 'Bid', T + 3_600);
  // The receipt confirms a cancel naming both ids, and OrderBook.cancel skipped #2 because it was already filled.
  book.fillOnCancel.add(2n);
  const { instance } = book.bot(new V2Store(':memory:'));
  const outcome = await instance.kill('fill race');
  assert.deepEqual(book.cancelCalls, [[1n, 2n]]);
  assert.equal(outcome.done, true, JSON.stringify(outcome));
  assert.equal(outcome.cancelled, 1, 'the confirmed cancel named two ids and the book cancelled one');
});

/*//////////////////////////////////////////////////////////////
          v2_mm_delta KEY AND v2_mm_killed TEXT
//////////////////////////////////////////////////////////////*/

test('v2_mm_delta: the page and its clear use ONE dedupe key, so a resolved delta lifts the cooldown it set', async () => {
  const paged: Array<{ kind: string; dedupeKey: string | undefined; data: Record<string, unknown> }> = [];
  const cleared: Array<{ kind: string; key: string | undefined }> = [];
  const instance = new MmBot({
    config: loadV2Config(env) as MmConfig,
    log: silentLogger(),
    client: {} as never,
    logClient: {} as never,
    sender: { execute: async () => assert.fail('nothing may be sent') },
    alerter: {
      alert: async (kind, _m, data = {}, options) => (paged.push({ kind, dedupeKey: options?.dedupeKey, data }), true),
      clear: (kind, key) => void cleared.push({ kind, key }),
    },
    store: new V2Store(':memory:'),
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
  });
  const VAULT = '0x00000000000000000000000000000000000000AB';
  const tick = (alert: boolean) => ({
    head: { blockNumber: 1n, timestamp: T },
    stop: { day: 0, realised: 0n, limit: 1n, tripped: false },
    vault: { isQuoter: true, usdgWallet: 0n },
    vaultAddress: VAULT,
    plan: { netDelta: [{ ticker: 'NVDA', deltaShares: alert ? 9.5 : 0.2, positions: 1, unknown: 0, alert }], series: [], capped: [], outflow: { cap: 2_500_000_000n, used: 0n, released: 0n, budget: 2_500_000_000n, planned: 0n, blocked: false } },
    foreignOutflow: null,
    outflowRefused: [],
    pricing: { requested: 0, failed: 0, reasons: {} },
    budget: NO_BUDGET_CUT,
  });
  const raise = (t: unknown) => (instance as unknown as { raiseAlerts(t: unknown): Promise<void> }).raiseAlerts(t);

  await raise(tick(true));
  const page = paged.filter((p) => p.kind === 'v2_mm_delta');
  assert.equal(page.length, 1, 'a breach pages once');
  assert.equal(page[0]!.dedupeKey, `${VAULT.toLowerCase()}:NVDA`, 'the page is keyed vault:ticker');
  assert.equal(page[0]!.data.vault, VAULT.toLowerCase(), 'the data names the vault');

  await raise(tick(false));
  const clear = cleared.filter((c) => c.kind === 'v2_mm_delta');
  assert.equal(clear.length, 1, 'a resolved delta clears once');
  // THE ASSERTION THIS TEST EXISTS FOR: the clear key IS the page key. Earlier the clear passed `row.ticker`
  // alone, so `clearAlert` deleted `v2_mm_delta:NVDA` while the cooldown lived under `v2_mm_delta:<vault>:NVDA`,
  // and nothing was ever cleared.
  assert.equal(clear[0]!.key, page[0]!.dedupeKey, 'page -> resolve -> the SAME key is cleared');
});

test('v2_mm_killed: the page says which vault - one vault, or every vault', async () => {
  const messages: Array<{ kind: string; message: string; data: Record<string, unknown> }> = [];
  const store = new V2Store(':memory:');
  const unreachable = async () => {
    throw new Error('HTTP request failed: connect ECONNREFUSED');
  };
  const instance = new MmBot({
    config: loadV2Config(env) as MmConfig,
    log: silentLogger(),
    client: { getBlock: unreachable, readContract: unreachable, multicall: unreachable } as never,
    logClient: { getLogs: unreachable } as never,
    sender: { execute: async () => assert.fail('nothing may be sent') },
    alerter: { alert: async (kind, message, data = {}) => (messages.push({ kind, message, data }), true), clear: () => undefined },
    store,
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
    killWaitMs: 2_000,
  });
  const HOUSE = '0x00000000000000000000000000000000000000CD';
  await instance.kill('one house vault drill', HOUSE);
  await instance.kill('fleet drill');
  const killed = messages.filter((m) => m.kind === 'v2_mm_killed');
  assert.equal(killed.length, 2);
  assert.match(killed[0]!.message, new RegExp(`for vault ${HOUSE.toLowerCase()}`), 'a one-vault kill names that vault');
  assert.match(killed[0]!.message, /other vaults keep quoting/);
  assert.equal(killed[0]!.data.vault, HOUSE.toLowerCase());
  assert.match(killed[1]!.message, /for every vault/, 'a fleet kill says so');
  assert.equal(killed[1]!.data.vault, 'all');
});

/**
 * THROUGH THE CODE THAT CALLS IT. `mm-store.test.ts` pins that two vaults can each RECORD a
 * settlement of the same series; nothing drove `ledgerStop` (quoter.ts:540-564) over two vaults holding one EXPIRED
 * series, and that is where the defect lived: the `expired` filter at :549 asked `hasSettlement(id)` without the
 * vault, so once vault A had settled a series, vault B's copy of it was filtered out of `expired` for ever, B's
 * position stayed open in `replayLedger`, and the realised loss never reached B's loss stop. This drives that path
 * for both vaults, in the order the tick runs them (treasury first), and asserts on what each vault's ledger says
 * AFTER both have run.
 *
 * The chain is one `series` view answered "settled at 250": the only read `ledgerStop` makes. Both vaults sold
 * (wrote) 100 units of the 220 call at 3.00, so each holds the same short and each must realise the same loss.
 *
 * BREAK CHECK: revert the settlement key to the global form (`mm-store.ts:152` `settle:${longId}` for every
 * vault, and `hasSettlement` to ignore its vault argument) and this fails at "THE SECOND VAULT MUST CLOSE TOO":
 * B's `expired` is empty because A's row satisfies the global `hasSettlement`, B never records, B's units stay -100.
 */
test('ledgerStop through the quoter: two vaults holding ONE expired series both settle it and both close (through the code that calls it)', async () => {
  const config = loadV2Config({ ...env, MM_VAULTS: VAULT_B }) as MmConfig;
  const treasury = config.contracts.makerVault;
  const store = new V2Store(':memory:');
  // What the Clearinghouse says about series 9 at the head: settled, a 220 call that finished at 250.
  const settledSeries = {
    underlying: '0x00000000000000000000000000000000000000ee',
    oracle: '0x00000000000000000000000000000000000000ce',
    exerciseFeeBps: 0,
    settled: true,
    settlementPrice: 250_000_000n,
    isPut: false,
    strike: 220_000_000n,
    expiry: 1_790_000_000,
  };
  const reads: string[] = [];
  const instance = new MmBot({
    config,
    log: silentLogger(),
    client: {
      getBlockNumber: async () => 1n,
      multicall: async ({ contracts }: { contracts: ReadonlyArray<{ functionName: string; args?: readonly unknown[] }> }) =>
        contracts.map((c) => {
          reads.push(`${c.functionName}(${String(c.args?.[0])})`);
          return c.functionName === 'series' ? { status: 'success', result: settledSeries } : { status: 'failure', error: new Error(`no view ${c.functionName}`) };
        }),
    } as never,
    logClient: {} as never,
    sender: { execute: async () => assert.fail('nothing may be sent') },
    alerter: { alert: async () => true, clear: () => undefined },
    store,
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
  });
  // The bot's OWN store, after its constructor bound both vaults: seeding another MmStore over the same file would
  // be a second view of one deployment, which is the shape mm-store.test.ts already covers.
  const seam = instance as unknown as { mm: MmStore; ledgerStop(a: unknown, head: unknown, limit: bigint): Promise<LossStop> };
  const mm = seam.mm;
  mm.applySeriesRange([{ longId: 9n, underlying: settledSeries.underlying, isPut: false, strike: 220_000_000n, expiry: 1_790_000_000 }], 1n);
  // Each vault wrote 100 units at 3.00 through its own order; distinct order ids keep the fill rows distinct
  // (fill uniqs are order-global on purpose), so this is not the bug's shape yet.
  const wrote = (orderId: bigint, vault: string) =>
    mm.recordOrderProgress(orderId, 100n, true, { type: 'fill', longId: '9', side: 'sell', units: 100n, price: 3_000_000n, feeBps: 0, at: 1_789_990_000 }, vault);
  wrote(11n, treasury);
  wrote(12n, VAULT_B);
  assert.equal(replayLedger(mm.ledger(treasury)).positions.get('9')?.units, -100n, 'precondition: A is short');
  assert.equal(replayLedger(mm.ledger(VAULT_B)).positions.get('9')?.units, -100n, 'precondition: B is short');

  // Only `vault` and `clearinghouse` are read by ledgerStop; the rest of MmAddresses is filled from the registry.
  const addresses = (vault: string) => ({ clearinghouse: config.contracts.clearinghouse, orderBook: config.contracts.orderBook, vault, usdg: config.registry.usdg, manager: config.contracts.accessManager });
  const head = { blockNumber: 1n, timestamp: 1_790_000_100 }; // past the expiry, so both positions are `expired`
  const limit = 1_000_000_000n;

  // THE TICK'S ORDER: the treasury settles first, then the second vault asks the same question about the same series.
  const stopA = await seam.ledgerStop(addresses(treasury), head, limit);
  const stopB = await seam.ledgerStop(addresses(VAULT_B), head, limit);

  const ledgerA = replayLedger(mm.ledger(treasury));
  const ledgerB = replayLedger(mm.ledger(VAULT_B));
  assert.equal(ledgerA.positions.get('9')?.units, 0n, 'A closed its position at settlement');
  assert.equal(ledgerB.positions.get('9')?.units, 0n, 'THE SECOND VAULT MUST CLOSE TOO: B settled through the same ledgerStop, not behind A');
  assert.equal(reads.filter((r) => r === 'series(9)').length, 2, 'each vault read the settlement for itself (A did not answer for B)');

  // Both realised the same loss on the same UTC day, and it reached BOTH loss stops. A short 220 call settling at
  // 250 pays out 30 per share on 100 units (1 share): -30 USDG against the 3.00 x 100 units = 3 USDG premium.
  const day = Math.floor(head.timestamp / 86_400);
  assert.ok(stopA.realised < 0n, `A's day ${day} realised a loss: ${stopA.realised}`);
  assert.ok(stopB.realised < 0n, `B's day ${day} realised a loss too, on its own ledger: ${stopB.realised}`);
  assert.equal(stopB.realised, stopA.realised, 'identical positions realise identical losses on their own ledgers');
  assert.equal(mm.hasSettlement(9n, treasury), true);
  assert.equal(mm.hasSettlement(9n, VAULT_B), true, "B's settlement row exists under B's key");
});

/*//////////////////////////////////////////////////////////////
   A 50-SERIES MARKET IS FULLY SELECTED UNDER THE DERIVED CAPS
//////////////////////////////////////////////////////////////*/

// BREAK CHECK: restore the literal defaults (maxSeries 40 / maxSeriesPerMarket 10) in place of the
// derived 50 / 50 below and `selected` reads 10 with 40 `not-selected` -- the partial book this fixes.
test('the launch ladder (5 rungs x call/put x 2 weekly + 3 daily = 50) is selected in full when the caps derive from it', async () => {
  const { selectSeries, pullAtOf } = await import('./engine.js');
  const { marketCoverage } = await import('./quoter.js');
  const { ladderSeriesCount, settleSeriesCaps } = await import('../config.js');
  const underlying = '0x00000000000000000000000000000000000000aa';
  const now = 1_790_000_000;
  const spot = 220_000_000n;
  // The launch ladder resolved as the cranker resolves it: 5 rungs per tenor, 2 weekly + 3 daily expiries, puts on.
  const params = { ladder: { weekly: { rungs: 5 }, daily: { rungs: 5 } }, expiriesAhead: { weekly: 2, daily: 3 } } as never;
  const listed = ladderSeriesCount(params, true);
  assert.equal(listed, 50, 'the ladder count the row states');
  // Fifty live series: 5 strikes around spot x call/put x 5 expiries, all inside the pull window.
  const candidates = [] as Array<{ longId: bigint; underlying: string; isPut: boolean; strike: bigint; expiry: number }>;
  let id = 1n;
  for (let e = 0; e < 5; e += 1) for (let r = 0; r < 5; r += 1) for (const isPut of [false, true]) {
    candidates.push({ longId: id, underlying, isPut, strike: spot + BigInt(r - 2) * 5_000_000n, expiry: now + (e + 1) * 86_400 });
    id += 1n;
  }
  const tickerOf = new Map([[underlying, 'NVDA']]);
  const registry = { markets: [{ ticker: 'NVDA', underlying, v2: { params, puts: true, status: 'live' } }] } as never;
  const caps = settleSeriesCaps({ registry, markets: ['NVDA'], maxSeries: undefined, maxSeriesPerMarket: undefined });
  assert.equal(caps.maxSeriesPerMarket, 50);
  assert.equal(caps.maxSeries, 50);
  assert.equal(caps.problems.length, 0);
  const picked = selectSeries({ now, candidates, spots: new Map([[underlying, spot]]), pullMinutes: 15, maxSeries: caps.maxSeries, maxSeriesPerMarket: caps.maxSeriesPerMarket, epoch: null });
  const coverage = marketCoverage({ now, live: candidates, picked, pullMinutes: 15, epochEnd: null, tickerOf, listedByMarket: caps.coverage.listedByMarket });
  assert.deepEqual(coverage.NVDA, { listed: 50, live: 50, selected: 50, trimmed: { 'not-selected': 0, 'pull-window': 0, 'epoch-outside': 0 } });
  assert.ok(candidates.every((c) => now < pullAtOf(c.expiry, 15)), 'precondition: nothing is in the pull window');
  // The old literals leave forty unquoted: the failure this fixes, stated as a coverage case.
  const partial = selectSeries({ now, candidates, spots: new Map([[underlying, spot]]), pullMinutes: 15, maxSeries: 40, maxSeriesPerMarket: 10, epoch: null });
  assert.equal(marketCoverage({ now, live: candidates, picked: partial, pullMinutes: 15, epochEnd: null, tickerOf, listedByMarket: caps.coverage.listedByMarket }).NVDA!.trimmed['not-selected'], 40);
});

/*//////////////////////////////////////////////////////////////
   A CROSSING BID IS NOT SENT, NOT MERELY NOT PLANNED
//////////////////////////////////////////////////////////////*/

// planner.test.ts proves a bid that would rest at or above a protocol-owned ask is not PLANNED; the sent half is a
// quoter fact (an earlier attempt stopped on it: `execute` is private, reached from `sendVault` (`tickOne` before), the sender is `ctx.sender`). Here
// the tick's own pieces, in the tick's order: two quoted vaults (the treasury plans, MM_VAULTS' VAULT_B rests an
// AskWrite on series 0), the protocol account set the bot derives, the UNION book `tick()` builds from every vault's
// chain orders, `planTick` for the treasury, then the bot's private `execute` with a sender that records every call.
// The assertion is on the sender's call list, by function name and order kind. The control arm is the same tick with
// no protocol ask resting: the treasury's bid on series 0 IS sent, so the assertion can see a bid when there is one.
// BREAK CHECK: hand the crossed arm `protocolBook: []` -- the protocol-cross predicate's input --
// and the crossed assertion fails by name ("the treasury sent a Bid on series 0 ..."); so does short-circuiting the
// bid's `crossesProtocol` check in planner.ts (restored).
test('protocol-cross, SENT half: with vault B\'s ask resting on a series, the treasury\'s sender never receives a Bid on it; with no ask resting, it does', async () => {
  const config = loadV2Config({ ...env, MM_VAULTS: VAULT_B }) as MmConfig;
  const treasury = config.contracts.makerVault;
  const U = '0x00000000000000000000000000000000000000aa';
  const EXPIRY = 1_790_020_800;
  const NOW = EXPIRY - 6 * 3_600;
  const SPOT = 210_000_000n;
  // The planner's own fixture shapes (planner.test.ts), one series: strike 210, fair 3.00.
  const params: MmPlanParams = {
    halfSpreadBps: 500, minHalfSpreadUsdg6: 20_000n, expiryWidenS: 14_400, expiryWidenBps: 20_000, pullMinutes: 15, quoteOffHours: false,
    fairMaxAgeS: 1_800, fairMaxAgeOffHoursS: 345_600, skewBpsPerDeltaShare: 100, maxSkewBps: 2_000, requoteBps: 300, resizeBps: 5_000,
    maxSeries: 40, maxSeriesPerMarket: 10, bidUnits: 100n, askUnits: 100n, maxSeriesUnits: 0n, maxTotalNotionalUsdg6: 0n,
    deltaAlertShares: 5, syncIntervalS: 900, depositTokens: true, maxQuoteLifetimeS: 0, epochWindDownS: 600,
    // Safe call selling off: what this pins is the protocol-cross wiring, not the floor.
    spotLagBps: 0, spotLagStaleBps: 0, fairFromSession: false, writeStopMinutes: 0,
  };
  const tickInput = (protocolAccounts: ReadonlySet<string>, protocolBook: TickInput['protocolBook']): TickInput => ({
    now: NOW,
    sessionOpen: true,
    sessionClose: EXPIRY,
    killed: false,
    lossStop: { day: Math.floor(NOW / 86_400), realised: 0n, limit: 1_000_000_000n, tripped: false },
    lastSync: NOW - 60,
    vault: {
      isQuoter: true, quoterDelay: 0, tradingPaused: false,
      fees: { current: { premiumFeeBps: 500, resaleFeeBps: 0 }, pending: null },
      limits: { maxSeriesUnits: 10_000n, maxTotalNotional: 250_000_000_000n, askToleranceBps: 100, maxBidBpsOfSpot: 1_000, maxOrderLifetime: 0, maxDailyOutflow: 2_500_000_000n },
      outflow: { used: 0n, available: 2_500_000_000n }, totalNotional: 0n, usdgWallet: 100_000_000_000n, usdgReserved: null, owed: 0n,
      freeCollateral: new Map([[U, 100n * 10n ** 18n]]), walletTokens: new Map([[U, 0n]]), tracked: [], epoch: null,
    },
    markets: new Map([[U, { underlying: U, ticker: 'NVDA', enabled: true, mintPaused: false, spot: SPOT }]]),
    series: [{
      info: { longId: 0n, underlying: U, isPut: false, strike: SPOT, expiry: EXPIRY }, ticker: 'NVDA', settled: false, spotFresh: true, spot: SPOT,
      exposure: { longs: 0n, shorts: 0n, bids: 0n, resale: 0n, writes: 0n, live: 0n }, seriesNotional: 0n, askFloors: { write: 0n, resale: 0n }, bidCap: 21_000_000n,
      collateralAsset: U, collateralPerUnit: 10n ** 16n, mintFeePpm: 80, orders: [],
    }],
    fairs: new Map([['0', { ok: true, fair: 3_000_000n, delta: 0.45, iv: 0.5, asOf: NOW - 120, source: 'model' }]]),
    params,
    refreshS: 600,
    protocolAccounts,
    protocolBook,
  });

  const calls: Array<{ functionName: string; args: readonly unknown[] }> = [];
  const instance = new MmBot({
    config,
    log: silentLogger(),
    client: {} as never,
    logClient: {} as never,
    sender: {
      execute: async (call: { functionName: string; args: readonly unknown[] }): Promise<TxOutcome> => {
        calls.push({ functionName: call.functionName, args: call.args });
        return { status: 'confirmed', hash: `0x${'ab'.repeat(32)}`, nonce: 1, blockNumber: 1n, gasUsed: 1n, result: true } as unknown as TxOutcome;
      },
    } as never,
    alerter: { alert: async () => true, clear: () => undefined },
    store: new V2Store(':memory:'),
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
  });
  const seam = instance as unknown as { execute(plan: TickPlan, a: MmAddresses, head: { blockNumber: bigint; timestamp: number }): Promise<unknown> };
  const addresses: MmAddresses = { clearinghouse: config.contracts.clearinghouse, orderBook: config.contracts.orderBook, vault: treasury as Address, usdg: config.registry.usdg as Address, manager: config.contracts.accessManager as Address };
  const head = { blockNumber: 1n, timestamp: NOW };
  const bidsOn = (longId: bigint) => calls.filter((c) => c.functionName === 'place' && c.args[0] === longId && c.args[1] === KIND_INDEX.Bid);

  // The protocol account set as tick() derives it: the treasury and VAULT_B are both in it.
  const accounts = instance.protocolAccountSet([]);
  assert.ok([treasury, VAULT_B].every((v) => [...accounts].some((a) => a.toLowerCase() === v.toLowerCase())), 'precondition: both vaults are protocol accounts');

  // CONTROL: nothing resting. The treasury plans a bid on series 0 and the sender receives it.
  const control = planTick(tickInput(accounts, unionProtocolBook([[], []], accounts, NOW)));
  const bid = control.txs.find((t) => t.type === 'place' && t.slot === 'bid');
  assert.ok(bid !== undefined && bid.type === 'place', 'precondition: with nothing resting the treasury plans a bid');
  await seam.execute(control, addresses, head);
  assert.equal(bidsOn(0n).length, 1, 'control: the treasury\'s Bid on series 0 reaches the sender');

  // CROSSED: VAULT_B rests an AskWrite on series 0 at the treasury's own bid price. The union book tick() builds from
  // BOTH vaults' chain orders carries it; the treasury plans against that book and the result goes through execute().
  calls.length = 0;
  const bAsk: ChainOrder = { id: 7n, maker: VAULT_B as Address, longId: 0n, kind: 'AskWrite', price: bid.price, units: 100n, filled: 0n, validUntil: EXPIRY, cancelled: false };
  const book = unionProtocolBook([[], [bAsk]], accounts, NOW);
  assert.equal(book.length, 1, 'precondition: B\'s ask is in the union book');
  const crossed = planTick(tickInput(accounts, book));
  await seam.execute(crossed, addresses, head);
  assert.deepEqual(bidsOn(0n), [], `the treasury sent a Bid on series 0 while vault B's ask rests there: ${JSON.stringify(calls.map((c) => c.functionName))}`);
  assert.equal(crossed.series[0]?.halt?.halt, 'protocol-cross', 'and /state says why');
  assert.ok(calls.some((c) => c.functionName === 'place' && c.args[1] === KIND_INDEX.AskWrite), 'the rest of the tick still goes out: the write ask is sent');
});

/*//////////////////////////////////////////////////////////////
   MARKET-SAFETY HALTS THROUGH THE QUOTER
//////////////////////////////////////////////////////////////*/

// The quoter's own half: the breaker's HISTORY lives in the bot (one per process, fed every tick), the P7/P8 clocks are
// read off the chain (SettlementOracle.marketConfig sources, their latest(), the calendar), and the result rides on
// MarketView.halt. `marketSafety` is private; it is reached through the same cast seam the tick tests use for tickOne.
const U_NVDA = '0x00000000000000000000000000000000000000aa';
const U_SPCX = '0x00000000000000000000000000000000000000ab';
const SO = '0x00000000000000000000000000000000000000c1' as Address;
const CL = '0x00000000000000000000000000000000000000c2' as Address;
const POOL = '0x00000000000000000000000000000000000000c3' as Address;
const OPEN_T = 1_790_083_800; // 13:30 UTC, 09:30 NY
/**
 * `atGrace` answers calendar.isRegularSession(now - grace) for the tests' clock-read tick (now = OPEN_T + 3_600), where
 * `grace` is the MM_OPEN_GRACE_S the bot is CONFIGURED with -- the env override, else the keeper default. This
 * fake used to hard-code 900 s, so when a change raised the default to 1800 the bot asked about a different second, got
 * `inSession`, and the P8 case below went red for a reason unrelated to the halt. `sessionAsks` records every second
 * the bot asked the calendar about, so a test can pin which one it was.
 */
function safetyBot(extraEnv: Record<string, string>, chain: { sources?: Address[]; poolSpot?: bigint; poolOk?: boolean; atGrace?: boolean; inSession?: boolean } = {}) {
  const reads: string[] = [];
  const sessionAsks: number[] = [];
  const graceAsk = OPEN_T + 3_600 - Number(extraEnv.MM_OPEN_GRACE_S ?? MM_OPEN_GRACE_DEFAULT_S);
  const instance = new MmBot({
    config: loadV2Config({ ...env, ...extraEnv }) as MmConfig,
    log: silentLogger(),
    client: {
      multicall: async ({ contracts }: { contracts: ReadonlyArray<{ functionName: string; args?: readonly unknown[]; address: string }> }) =>
        contracts.map((c) => {
          reads.push(c.functionName);
          if (c.functionName === 'isRegularSession') {
            const at = Number(c.args?.[0]);
            sessionAsks.push(at);
            return { status: 'success', result: at === graceAsk ? (chain.atGrace ?? true) : (chain.inSession ?? true) };
          }
          if (c.functionName === 'marketConfig') return { status: 'success', result: [chain.sources ?? [CL, POOL], 150, 1_800, 90_000] };
          if (c.functionName === 'latest') return { status: 'success', result: [chain.poolOk ?? true, chain.poolSpot ?? 210_000_000n, BigInt(OPEN_T + 3_600)] };
          return { status: 'failure', error: new Error(`no view ${c.functionName}`) };
        }),
    } as never,
    logClient: {} as never,
    sender: { execute: async () => assert.fail('nothing may be sent') },
    alerter: { alert: async () => true, clear: () => undefined },
    store: new V2Store(':memory:'),
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
  });
  const seam = instance as unknown as { marketSafety(read: MarketsRead, head: { blockNumber: bigint; timestamp: number }, sessionOpen: boolean): Promise<Map<string, { halt: string; detail?: string } | null>> };
  const read = (spot: bigint | null, printAt: number | null): MarketsRead => ({
    markets: new Map([[U_NVDA, { underlying: U_NVDA, ticker: 'NVDA', enabled: true, mintPaused: false, spot }]]),
    freeCollateral: new Map(),
    walletTokens: new Map(),
    spotPrints: new Map([[U_NVDA, { oracle: SO, updatedAt: printAt }]]),
  });
  return { seam, read, reads, sessionAsks };
}

test('P15 through the quoter: the bot keeps each market\'s spot history across ticks; a 2 % move in 60 s halts THAT market, and only while the halt lasts', async () => {
  const { seam, read, reads } = safetyBot({ MM_MAX_SPOT_AGE_S: '0', MM_OPEN_GRACE_S: '0' });
  const at = (t: number) => ({ blockNumber: 1n, timestamp: t });
  assert.equal((await seam.marketSafety(read(210_000_000n, OPEN_T), at(OPEN_T + 3_600), true)).get(U_NVDA), null);
  const movedRead = read(214_200_000n, OPEN_T);
  const moved = (await seam.marketSafety(movedRead, at(OPEN_T + 3_660), true)).get(U_NVDA);
  assert.equal(moved?.halt, 'spot-move-breaker', 'the second tick sees the first tick\'s spot: the history is the bot\'s');
  assert.equal(movedRead.markets.get(U_NVDA)?.halt?.halt, 'spot-move-breaker', 'and it rides on the MarketView the planner reads');
  assert.equal((await seam.marketSafety(read(214_200_000n, OPEN_T), at(OPEN_T + 3_660 + 899), true)).get(U_NVDA)?.halt, 'spot-move-breaker', 'held MM_BREAKER_HALT_S');
  assert.equal((await seam.marketSafety(read(214_200_000n, OPEN_T), at(OPEN_T + 3_660 + 900), true)).get(U_NVDA), null, 'released');
  assert.deepEqual(reads, [], 'with P7 and P8 opted out nothing is read for the clocks');
});

test('P7 through the quoter: an hour-old Chainlink print is FRESH while the pool source agrees within MM_FAIR_SPOT_TOLERANCE_BPS; halts spot-age when the pool disagrees, is down, or the market has no second source', async () => {
  const now = { blockNumber: 1n, timestamp: OPEN_T + 3_600 };
  const printedOpen = OPEN_T + 60; // one print at 09:31, nothing since: a quiet session
  const agree = safetyBot({ MM_OPEN_GRACE_S: '900' }, { poolSpot: 210_300_000n });
  assert.equal((await agree.seam.marketSafety(agree.read(210_000_000n, printedOpen), now, true)).get(U_NVDA), null, '14 bps apart: the pool refreshes the observation, a quiet session keeps quoting');
  assert.ok(agree.reads.includes('marketConfig') && agree.reads.includes('latest'));

  const apart = safetyBot({}, { poolSpot: 217_000_000n });
  assert.equal((await apart.seam.marketSafety(apart.read(210_000_000n, printedOpen), now, true)).get(U_NVDA)?.halt, 'spot-age', '333 bps apart: no corroboration credit, the print is 3540 s old');
  const down = safetyBot({}, { poolOk: false });
  assert.equal((await down.seam.marketSafety(down.read(210_000_000n, printedOpen), now, true)).get(U_NVDA)?.halt, 'spot-age');
  const single = safetyBot({}, { sources: [CL] });
  assert.equal((await single.seam.marketSafety(single.read(210_000_000n, printedOpen), now, true)).get(U_NVDA)?.halt, 'spot-age', 'a single-source market ages on the print alone');
  const noTolerance = safetyBot({ MM_FAIR_SPOT_TOLERANCE_BPS: '0' }, { poolSpot: 210_000_000n });
  assert.equal((await noTolerance.seam.marketSafety(noTolerance.read(210_000_000n, printedOpen), now, true)).get(U_NVDA)?.halt, 'spot-age', 'tolerance 0: no source gets corroboration credit');
  assert.equal((await apart.seam.marketSafety(apart.read(210_000_000n, OPEN_T + 3_540), now, true)).get(U_NVDA), null, 'a 60 s old print needs no corroboration');
  assert.equal((await apart.seam.marketSafety(apart.read(210_000_000n, printedOpen), now, false)).get(U_NVDA), null, 'off-hours is market-closed\'s, not spot-age\'s');
});

test('P8 through the quoter: inside MM_OPEN_GRACE_S of the open, or with no in-session observation, the market halts open-grace', async () => {
  const now = { blockNumber: 1n, timestamp: OPEN_T + 3_600 };
  const early = safetyBot({}, { atGrace: false });
  assert.equal((await early.seam.marketSafety(early.read(210_000_000n, OPEN_T + 3_590), now, true)).get(U_NVDA)?.halt, 'open-grace', 'calendar says the session was not open a grace ago');
  // Under the keeper default the grace is 30 minutes, and that is the second the bot asks about.
  assert.equal(MM_OPEN_GRACE_DEFAULT_S, 1_800, 'T-OP-309: the default grace is the first 30 minutes of the session');
  assert.ok(early.sessionAsks.includes(now.timestamp - MM_OPEN_GRACE_DEFAULT_S), `asked the calendar about ${early.sessionAsks.join(', ')}, not open + 30 min`);
  // Each configured grace is exercised on its own: an explicit 900 asks about now - 900 and halts the same way.
  const early900 = safetyBot({ MM_OPEN_GRACE_S: '900' }, { atGrace: false });
  assert.equal((await early900.seam.marketSafety(early900.read(210_000_000n, OPEN_T + 3_590), now, true)).get(U_NVDA)?.halt, 'open-grace', 'MM_OPEN_GRACE_S=900: not open 900 s ago');
  assert.ok(early900.sessionAsks.includes(now.timestamp - 900) && !early900.sessionAsks.includes(now.timestamp - 1_800));
  const preMarket = safetyBot({ MM_MAX_SPOT_AGE_S: '0' }, { inSession: false, sources: [CL] });
  assert.equal((await preMarket.seam.marketSafety(preMarket.read(210_000_000n, OPEN_T - 600), now, true)).get(U_NVDA)?.halt, 'open-grace', 'the only observation is a pre-market print');
  const ok = safetyBot({});
  assert.equal((await ok.seam.marketSafety(ok.read(210_000_000n, OPEN_T + 3_590), now, true)).get(U_NVDA), null);
});

test('alerts: each market-safety halt pages its own kind per vault and market while it holds, and is cleared the tick it lifts; P9 pages v2_mm_event_halt', async () => {
  const alerts: Array<{ kind: string; key: string | undefined }> = [];
  const cleared: string[] = [];
  const instance = new MmBot({
    config: loadV2Config(env) as MmConfig,
    log: silentLogger(),
    client: {} as never,
    logClient: {} as never,
    sender: { execute: async () => assert.fail('nothing may be sent') },
    alerter: { alert: async (kind, _m, _d, o) => (alerts.push({ kind, key: o?.dedupeKey }), true), clear: (kind, key) => void cleared.push(`${kind}|${key}`) },
    store: new V2Store(':memory:'),
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
  });
  const V = '0x00000000000000000000000000000000000000fa';
  const tick = (halts: Record<string, { halt: string } | null>, seriesHalt: string | null = null) => ({
    head: { blockNumber: 1n, timestamp: OPEN_T },
    vaultAddress: V,
    stop: { day: 0, realised: 0n, limit: 1n, tripped: false },
    vault: { isQuoter: true, usdgWallet: 0n },
    input: { markets: new Map(Object.entries(halts).map(([u, halt]) => [u, { underlying: u, ticker: u === U_NVDA ? 'NVDA' : 'SPCX', enabled: true, mintPaused: false, spot: 1n, halt }])) },
    plan: { netDelta: [], series: [{ longId: 7n, ticker: 'NVDA', selected: true, halt: seriesHalt === null ? null : { halt: seriesHalt }, sizes: null, fairReason: null }], capped: [], outflow: { cap: 1n, used: 0n, released: 0n, budget: 1n, planned: 0n, blocked: false } },
    foreignOutflow: null,
    outflowRefused: [],
    pricing: { requested: 1, failed: 0, reasons: {} },
    budget: NO_BUDGET_CUT,
  });
  const raise = (t: unknown) => (instance as unknown as { raiseAlerts(t: unknown): Promise<void> }).raiseAlerts(t);
  await raise(tick({ [U_NVDA]: { halt: 'spot-age' }, [U_SPCX]: { halt: 'spot-move-breaker' } }, 'event-uncertainty'));
  assert.deepEqual(alerts.map((a) => `${a.kind}|${a.key}`).filter((k) => /spot_age|open_grace|spot_breaker|event_halt/.test(k)).sort(), [
    `v2_mm_event_halt|${V}`,
    `v2_mm_spot_age|${V}:${U_NVDA}`,
    `v2_mm_spot_breaker|${V}:${U_SPCX}`,
  ]);
  cleared.length = 0;
  await raise(tick({ [U_NVDA]: null, [U_SPCX]: { halt: 'spot-move-breaker' } }));
  assert.ok(cleared.includes(`v2_mm_spot_age|${V}:${U_NVDA}`), 'the lifted halt is cleared, so its next spell pages again');
  assert.ok(!cleared.includes(`v2_mm_spot_breaker|${V}:${U_SPCX}`), 'a halt still holding is not cleared');
  assert.ok(cleared.includes(`v2_mm_event_halt|${V}`));
});

/* ---------------------------------------------------------------------------------------------- */
/* post-trade markouts through the quoter                                               */
/* ---------------------------------------------------------------------------------------------- */

import { markoutsOf, sessionOpenedAtOf } from './quoter.js';
import type { MarkoutBook } from './markouts.js';
import type { FairClockInput } from './engine.js';
import { sessionOpenOf } from '../pricing/bs.js';

/** markoutTick's fair clock off-hours (MM_FAIR_MAX_AGE_OFF_HOURS_S, no open to compare): every test fair here passes it. */
const offHours = (now: number): FairClockInput => ({ now, sessionOpen: false, sessionOpenedAt: undefined, params: { fairMaxAgeS: 1_800, fairMaxAgeOffHoursS: 345_600 } });

function markoutBot(fairOk: (longId: string) => bigint | null, asOf: () => number = () => T) {
  const paged: Array<{ kind: string; dedupeKey: string | undefined; data: Record<string, unknown> }> = [];
  const cleared: Array<{ kind: string; key: string | undefined }> = [];
  const asked: string[][] = [];
  const instance = new MmBot({
    config: { ...(loadV2Config(env) as MmConfig), tuning: { ...(loadV2Config(env) as MmConfig).tuning, markoutAlert: { thresholdBps: -200, minFills: 2 } } },
    log: silentLogger(),
    client: {} as never,
    logClient: {} as never,
    sender: { execute: async () => assert.fail('nothing may be sent') },
    alerter: {
      alert: async (kind, _m, data = {}, options) => (paged.push({ kind, dedupeKey: options?.dedupeKey, data }), true),
      clear: (kind, key) => void cleared.push({ kind, key }),
    },
    store: new V2Store(':memory:'),
    pricing: {
      fairMany: async (reqs) => {
        asked.push(reqs.map((r) => `${r.ticker}:${r.strike}`));
        return reqs.map((r) => {
          const f = fairOk(r.strike.toString());
          return f === null ? { ok: false, reason: 'refused' } : ({ ok: true, fair: f, delta: 0.3, iv: 0.5, asOf: asOf(), source: 'test' } as never);
        });
      },
    },
    signer: '0x0000000000000000000000000000000000000001',
  });
  const inner = instance as unknown as {
    markoutsByVault: Map<string, MarkoutBook>;
    markoutBook(vaultKey: string): MarkoutBook;
    markoutTick(vault: string, head: { blockNumber: bigint; timestamp: number }, fairs: Map<string, unknown>, tickerFor: (info: { underlying: string }) => string | null, clock: FairClockInput): Promise<void>;
    mm: { applySeriesRange(series: unknown[], toBlock: bigint): void };
  };
  return { instance, inner, paged, cleared, asked };
}

const MK_VAULT = '0x00000000000000000000000000000000000000Cd';
const USDG_1 = 1_000_000n;

test('a fill whose series the tick no longer quotes is still marked at +30 min, from one bounded extra fair read', async () => {
  const b = markoutBot(() => USDG_1 * 2n); // later fair 2.00
  // Series 7 (strike 230): live until well after the 30-minute checkpoint, not in this tick's quoting fairs.
  b.inner.mm.applySeriesRange([{ longId: 7n, underlying: '0x00000000000000000000000000000000000000d4', isPut: false, strike: 230_000_000n, expiry: T + 86_400 }], 1n);
  b.inner.markoutBook(MK_VAULT.toLowerCase()).record({ at: T, orderId: 1n, longId: 7n, side: 'sell', units: 10n, price: USDG_1 * 2n });
  await b.inner.markoutTick(MK_VAULT, { blockNumber: 2n, timestamp: T + 1_800 }, new Map(), () => 'NVDA', offHours(T + 1_800));
  assert.deepEqual(b.asked, [['NVDA:230000000']], 'exactly one extra read, for the due series');
  const rows = markoutsOf(b.inner.markoutsByVault, MK_VAULT);
  assert.deepEqual((rows[0]!.marks as Record<string, unknown>)['1800s'], { bps: 0, fair: (USDG_1 * 2n).toString(), lateS: 0 });
  assert.equal(markoutsOf(b.inner.markoutsByVault, MK_VAULT.toUpperCase().replace('0X', '0x')).length, 1, '/state finds the vault whatever the address case');
});

test('a fair the tick already read is reused, and an expired series is never asked for', async () => {
  const b = markoutBot(() => assert.fail('no extra read expected') as never);
  b.inner.mm.applySeriesRange([{ longId: 8n, underlying: '0x00000000000000000000000000000000000000d4', isPut: true, strike: 200_000_000n, expiry: T + 600 }], 1n);
  const book = b.inner.markoutBook(MK_VAULT.toLowerCase());
  book.record({ at: T, orderId: 2n, longId: 7n, side: 'sell', units: 10n, price: USDG_1 * 2n });
  book.record({ at: T, orderId: 3n, longId: 8n, side: 'sell', units: 10n, price: USDG_1 * 2n });
  const fairs = new Map<string, unknown>([['7', { ok: true, fair: USDG_1 * 2n, delta: 0.3, iv: 0.5, asOf: T, source: 'tick' }]]);
  await b.inner.markoutTick(MK_VAULT, { blockNumber: 2n, timestamp: T + 1_800 }, fairs, () => 'NVDA', offHours(T + 1_800));
  const rows = markoutsOf(b.inner.markoutsByVault, MK_VAULT);
  const bySeries = Object.fromEntries(rows.map((r) => [r.longId, (r.marks as Record<string, unknown>)['1800s']]));
  assert.deepEqual(bySeries['7'], { bps: 0, fair: (USDG_1 * 2n).toString(), lateS: 0 }, 'series 7 marked from the tick fairs');
  assert.equal(bySeries['8'], 'pending', 'series 8 expired at T+600: no fair read, still pending inside its grace');
  assert.deepEqual(b.asked, [], 'no pricing call at all');
});

test('v2_mm_markout_low pages per vault on one key and clears on the same key', async () => {
  let later = USDG_1 * 3n; // sold at 2.00, worth 3.00 at +30: -5000 bps
  const b = markoutBot(() => later);
  b.inner.mm.applySeriesRange([{ longId: 7n, underlying: '0x00000000000000000000000000000000000000d4', isPut: false, strike: 230_000_000n, expiry: T + 86_400 }], 1n);
  const book = b.inner.markoutBook(MK_VAULT.toLowerCase());
  book.record({ at: T, orderId: 4n, longId: 7n, side: 'sell', units: 10n, price: USDG_1 * 2n });
  book.record({ at: T, orderId: 5n, longId: 7n, side: 'sell', units: 10n, price: USDG_1 * 2n });
  await b.inner.markoutTick(MK_VAULT, { blockNumber: 2n, timestamp: T + 1_800 }, new Map(), () => 'NVDA', offHours(T + 1_800));
  const page = b.paged.filter((p) => p.kind === 'v2_mm_markout_low');
  assert.equal(page.length, 1);
  assert.equal(page[0]!.dedupeKey, `markout:${MK_VAULT.toLowerCase()}`);
  assert.equal(page[0]!.data.meanBps, -5_000);
  assert.equal(page[0]!.data.fills, 2);

  // Two better fills push the window of the last 2 up past the threshold: the page clears on the SAME key.
  later = USDG_1 * 2n;
  book.record({ at: T + 60, orderId: 6n, longId: 7n, side: 'sell', units: 10n, price: USDG_1 * 2n });
  book.record({ at: T + 60, orderId: 7n, longId: 7n, side: 'sell', units: 10n, price: USDG_1 * 2n });
  await b.inner.markoutTick(MK_VAULT, { blockNumber: 3n, timestamp: T + 60 + 1_800 }, new Map(), () => 'NVDA', offHours(T + 60 + 1_800));
  const clear = b.cleared.filter((c) => c.kind === 'v2_mm_markout_low');
  assert.equal(clear.at(-1)!.key, page[0]!.dedupeKey, 'page -> resolve -> the same key is cleared');
});

/*
 * The markout sampler stores a fair only when it passes the quoting path's clock,
 * engine.fairClockHalt. In session, a fair priced on a chain dated before the open (the previous close's, which a
 * 15-minute-delayed chain still serves at 09:45) or older than MM_FAIR_MAX_AGE_S leaves the checkpoint pending.
 */
test('in session, a pre-open or stale fair never marks a fill (tick fairs and the extra read alike); a fresh in-session fair does', async () => {
  const open = sessionOpenedAtOf(OPEN_T, true);
  assert.equal(open, OPEN_T, 'the setup: OPEN_T is a regular 09:30 New York open');
  const inSession = (now: number): FairClockInput => ({ now, sessionOpen: true, sessionOpenedAt: open, params: { fairMaxAgeS: 1_800, fairMaxAgeOffHoursS: 345_600 } });
  const series7 = [{ longId: 7n, underlying: '0x00000000000000000000000000000000000000d4', isPut: false, strike: 230_000_000n, expiry: OPEN_T + 86_400 }];
  const fill = { at: OPEN_T + 30, orderId: 1n, longId: 7n, side: 'sell' as const, units: 10n, price: USDG_1 * 2n };
  const at60 = OPEN_T + 90; // the fill's +1 min checkpoint
  const mark60 = (b: ReturnType<typeof markoutBot>) => (markoutsOf(b.inner.markoutsByVault, MK_VAULT)[0]!.marks as Record<string, unknown>)['60s'];

  // Pre-open: the tick's own fair AND the extra read both answer on the 09:15 chain.
  let asOf = OPEN_T - 900;
  const pre = markoutBot(() => USDG_1 * 2n, () => asOf);
  pre.inner.mm.applySeriesRange(series7, 1n);
  pre.inner.markoutBook(MK_VAULT.toLowerCase()).record(fill);
  const tickFair = (at: number) => new Map<string, unknown>([['7', { ok: true, fair: USDG_1 * 3n, delta: 0.3, iv: 0.5, asOf: at, source: 'tick' }]]);
  await pre.inner.markoutTick(MK_VAULT, { blockNumber: 2n, timestamp: at60 }, tickFair(OPEN_T - 900), () => 'NVDA', inSession(at60));
  assert.equal(mark60(pre), 'pending', 'a chain dated before the open marks nothing');
  assert.deepEqual(pre.asked, [['NVDA:230000000']], 'the refused tick fair is re-asked once, like a failed one');

  // The same fill, the same tick, off-hours clock: the SAME fairs would have been stored -- the clock is what refuses.
  const offClock = markoutBot(() => USDG_1 * 2n, () => asOf);
  offClock.inner.mm.applySeriesRange(series7, 1n);
  offClock.inner.markoutBook(MK_VAULT.toLowerCase()).record(fill);
  await offClock.inner.markoutTick(MK_VAULT, { blockNumber: 2n, timestamp: at60 }, tickFair(OPEN_T - 900), () => 'NVDA', offHours(at60));
  assert.deepEqual(mark60(offClock), { bps: -5_000, fair: (USDG_1 * 3n).toString(), lateS: 0 }, 'control: without the clock the pre-open tick fair is stored');

  // Stale: dated after the open, but older than MM_FAIR_MAX_AGE_S at a later checkpoint.
  const late = OPEN_T + 30 + 1_800; // the +30 min checkpoint
  asOf = late - 1_801;
  const stale = markoutBot(() => USDG_1 * 2n, () => asOf);
  stale.inner.mm.applySeriesRange(series7, 1n);
  stale.inner.markoutBook(MK_VAULT.toLowerCase()).record(fill);
  await stale.inner.markoutTick(MK_VAULT, { blockNumber: 2n, timestamp: late }, new Map(), () => 'NVDA', inSession(late));
  assert.equal((markoutsOf(stale.inner.markoutsByVault, MK_VAULT)[0]!.marks as Record<string, unknown>)['1800s'], 'pending', 'an asOf 1801 s old is fair-stale');

  // Fresh and in session: stored.
  asOf = at60 - 5;
  const fresh = markoutBot(() => USDG_1 * 2n, () => asOf);
  fresh.inner.mm.applySeriesRange(series7, 1n);
  fresh.inner.markoutBook(MK_VAULT.toLowerCase()).record(fill);
  await fresh.inner.markoutTick(MK_VAULT, { blockNumber: 2n, timestamp: at60 }, new Map(), () => 'NVDA', inSession(at60));
  assert.deepEqual(mark60(fresh), { bps: 0, fair: (USDG_1 * 2n).toString(), lateS: 0 }, 'a fair priced after the open, inside the age limit, marks the fill');
});

/*
 * WHEN the session began is the 09:30 open of the date the on-chain
 * ExpiryCalendar has already called a session day. The keeper's own holiday list must not overrule it: where they
 * disagreed, sessionOpenOf's null halted every series fair-before-open for the whole session.
 */
test('sessionOpenedAtOf places the open on a date the chain calendar opened, even one the keeper list calls a holiday', () => {
  const thanksgiving1000 = Date.UTC(2026, 10, 26, 15, 0) / 1000; // Thu 2026-11-26 10:00 New York (EST)
  const thanksgivingOpen = Date.UTC(2026, 10, 26, 14, 30) / 1000; // 09:30 New York
  assert.equal(sessionOpenOf(thanksgiving1000), null, 'the setup: calendar.ts NYSE_HOLIDAYS_2026_2028 lists the date, so the keeper default cannot place it');
  assert.equal(sessionOpenedAtOf(thanksgiving1000, true), thanksgivingOpen, 'the chain says open: the open is that date\'s 09:30, not null');
  assert.equal(sessionOpenedAtOf(thanksgiving1000, false), null, 'the chain says closed: nothing to place');
  assert.equal(sessionOpenedAtOf(OPEN_T + 3_600, true), OPEN_T, 'an ordinary Tuesday: the same 09:30 the keeper list gives');
  assert.equal(sessionOpenedAtOf(OPEN_T + 3_600, true), sessionOpenOf(OPEN_T + 3_600));
  const saturdayNoon = Date.UTC(2026, 8, 26, 16, 0) / 1000; // Sat 2026-09-26 12:00 New York
  assert.equal(sessionOpenedAtOf(saturdayNoon, true), null, 'a weekend is never placed (the chain never opens one; if it did, the engine halts)');
});

/*
 * The EarnVault venue step, through MmBot with the env the bot boots from: the rendered EARN_* buffer decides,
 * the move goes to V2_EARN_VAULT as sweepToVenue / pullFromVenue, and a queue whose head stands still for
 * EARN_QUEUE_STUCK_S pages v2_earn_queue_stuck.
 */
const EARN_VAULT = getAddress(`0x${'ea'.repeat(20)}`);
const EARN_ADAPTER = getAddress(`0x${'ad'.repeat(20)}`);
const EARN_USDG = getAddress(`0x${'e5'.repeat(20)}`);
// `deferred`: EarnVault.deferredAssets(), 0 by default; an Error makes that one multicall entry fail.
// `venueUnreadable`: EarnVault.convertToAssets reverts VenueUnreadable and the adapter's reads revert.
type EarnChain = { adapter?: Address; position?: boolean; head?: bigint; tail?: bigint; wallet: bigint; escrowed?: bigint; deferred?: bigint | Error; totalAssets?: bigint; withdrawable?: bigint; venueUnreadable?: boolean };

function earnBot(chain: EarnChain, extra: Record<string, string> = {}) {
  const config = loadV2Config({ ...env, V2_EARN_VAULT: EARN_VAULT, ...extra }) as MmConfig;
  const sent: Array<{ address: string; functionName: string; args: readonly unknown[]; gas: bigint }> = [];
  const alerts: Array<{ kind: string; message: string }> = [];
  const views: Record<string, () => unknown> = {
    adapter: () => chain.adapter ?? EARN_ADAPTER,
    hasOpenPosition: () => chain.position ?? false,
    queue: () => [chain.head ?? 1n, chain.tail ?? 0n],
    balanceOf: () => chain.wallet,
    escrowedAssets: () => chain.escrowed ?? 0n,
    totalAssets: () => chain.totalAssets ?? chain.wallet,
    deferredAssets: () => chain.deferred ?? 0n,
    convertToAssets: () => (chain.venueUnreadable
      ? new ContractFunctionRevertedError({ abi: earnVaultAbi, data: encodeErrorResult({ abi: earnVaultAbi, errorName: 'VenueUnreadable' }), functionName: 'convertToAssets' })
      : 1n),
  };
  const instance = new MmBot({
    config,
    log: silentLogger(),
    client: {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'orderBook') return config.contracts.orderBook;
        if (functionName === 'usdg') return EARN_USDG;
        if (functionName === 'calendar') return `0x${'ca'.repeat(20)}`;
        if (functionName === 'withdrawable') {
          if (chain.venueUnreadable) throw new Error('adapter reverts');
          return chain.withdrawable ?? 0n;
        }
        throw new Error(`unexpected read ${functionName}`);
      },
      // viem's two multicall shapes: raw results, or with allowFailure one {status, result | error} per call.
      multicall: async ({ contracts, allowFailure }: { contracts: ReadonlyArray<{ functionName: string }>; allowFailure?: boolean }) =>
        contracts.map((c) => {
          const v = views[c.functionName]!();
          if (!allowFailure) {
            if (v instanceof Error) throw v;
            return v;
          }
          return v instanceof Error ? { status: 'failure', error: v } : { status: 'success', result: v };
        }),
    } as never,
    logClient: {} as never,
    // A recorder, typed loosely on purpose: TxSender.execute is generic over the ABI and this one reads four fields.
    sender: {
      execute: async (call: { address: string; functionName: string; args: readonly unknown[]; gas: bigint }): Promise<TxOutcome> => {
        sent.push({ address: call.address, functionName: call.functionName, args: call.args, gas: call.gas });
        return { status: 'confirmed', hash: hash('ee'), nonce: 0, blockNumber: 1n, gasUsed: 1n, result: undefined };
      },
    } as never,
    alerter: { alert: async (kind, message) => (alerts.push({ kind, message }), true), clear: () => undefined },
    store: new V2Store(':memory:'),
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
  });
  return { instance, sent, alerts };
}
const earnHead = (timestamp: number) => ({ blockNumber: 1n, timestamp }) as never;
const U6 = (n: number) => BigInt(n) * 1_000_000n;

test('earnTick sends sweepToVenue / pullFromVenue to V2_EARN_VAULT per the rendered EARN_BUFFER_USDG6, nothing within the band', async () => {
  const buffer = { EARN_BUFFER_USDG6: String(U6(10_000)) };
  const above = earnBot({ wallet: U6(12_500), withdrawable: U6(50_000) }, buffer);
  await above.instance.earnTick(earnHead(1_800_000_000));
  assert.deepEqual(above.sent.map((s) => [s.address, s.functionName, s.args]), [[EARN_VAULT, 'sweepToVenue', [U6(2_500)]]]);

  const below = earnBot({ wallet: U6(6_000), withdrawable: U6(50_000) }, buffer);
  await below.instance.earnTick(earnHead(1_800_000_000));
  assert.deepEqual(below.sent.map((s) => [s.address, s.functionName, s.args]), [[EARN_VAULT, 'pullFromVenue', [U6(4_000)]]]);

  const band = earnBot({ wallet: U6(10_000), withdrawable: U6(50_000) }, buffer);
  await band.instance.earnTick(earnHead(1_800_000_000));
  assert.deepEqual(band.sent, []);
});

test('earnTick sweeps only the vault\'s own cash: deferred payments shrink the sweep, and an unreadable deferredAssets() sends nothing', async () => {
  const buffer = { EARN_BUFFER_USDG6: String(U6(10_000)) };
  const held = earnBot({ wallet: U6(12_500), deferred: U6(1_000), withdrawable: U6(50_000) }, buffer);
  await held.instance.earnTick(earnHead(1_800_000_000));
  assert.deepEqual(held.sent.map((s) => [s.address, s.functionName, s.args]), [[EARN_VAULT, 'sweepToVenue', [U6(1_500)]]]);

  const unknown = earnBot({ wallet: U6(12_500), deferred: new Error('execution reverted'), withdrawable: U6(50_000) }, buffer);
  const r = await unknown.instance.earnTick(earnHead(1_800_000_000));
  assert.equal(r?.plan.skipped, 'deferred-unreadable');
  assert.deepEqual(unknown.sent, [], 'never read as 0: nothing is swept');
  assert.equal(unknown.alerts.length, 0, 'a skip, not an unreadable vault');
});

test('without V2_EARN_VAULT the step reads and sends nothing; with no adapter it sends nothing', async () => {
  const unset = bot(new V2Store(':memory:'));
  assert.equal(await unset.instance.earnTick(earnHead(1_800_000_000)), null);
  const noAdapter = earnBot({ adapter: zeroAddress, wallet: U6(1_000_000) });
  const r = await noAdapter.instance.earnTick(earnHead(1_800_000_000));
  assert.equal(r?.plan.skipped, 'no-adapter');
  assert.deepEqual(noAdapter.sent, []);
});

test('a queue head standing still for EARN_QUEUE_STUCK_S pages v2_earn_queue_stuck with the reason; a moving head does not', async () => {
  const chain: EarnChain = { position: true, head: 4n, tail: 9n, wallet: U6(10) };
  const { instance, alerts, sent } = earnBot(chain, { EARN_QUEUE_STUCK_S: '900' });
  const t0 = 1_800_000_000;
  await instance.earnTick(earnHead(t0));
  await instance.earnTick(earnHead(t0 + 899));
  assert.equal(alerts.length, 0, 'under the threshold');
  await instance.earnTick(earnHead(t0 + 900));
  assert.deepEqual(alerts.map((a) => a.kind), ['v2_earn_queue_stuck']);
  assert.match(alerts[0]!.message, /4\.\.9 have not moved for 900 s.*holds a position/);
  chain.head = 5n;
  await instance.earnTick(earnHead(t0 + 5_000));
  assert.equal(alerts.length, 1, 'the head moved: the wait starts again');
  assert.deepEqual(sent, [], 'an open position sends nothing');
});

test('an EarnVault that cannot read its venue gets no sweep or pull, and the stuck page names the unreadable venue', async () => {
  // A wallet far above the buffer and a queue: without the rule this sweeps into (or pulls from) the broken venue.
  const chain: EarnChain = { head: 4n, tail: 9n, wallet: U6(50_000), withdrawable: U6(50_000), venueUnreadable: true };
  const { instance, alerts, sent } = earnBot(chain, { EARN_QUEUE_STUCK_S: '900' });
  const t0 = 1_800_000_000;
  await instance.earnTick(earnHead(t0));
  await instance.earnTick(earnHead(t0 + 900));
  assert.deepEqual(sent, [], 'nothing moved in or out of a venue the vault will not price');
  assert.deepEqual(alerts.map((a) => a.kind), ['v2_earn_queue_stuck'], 'not v2_mm_vault_unreadable: the read succeeded');
  assert.match(alerts[0]!.message, /venue adapter cannot be read.*writes it off with setAdapter/);
});


/* ---------------------------------------------------------------------------------------------- */
/* /state carries the mark-to-market loss stop each vault's tick planned with  */
/* ---------------------------------------------------------------------------------------------- */

import { bigintReplacer } from '../store.js';

test('/state vaults[] carries the tick plan\'s mtm (realised, unrealised, total, limit, tripped, unmarked), bigints as strings; null when the plan has none', () => {
  const instance = new MmBot({
    config: loadV2Config(env) as MmConfig,
    log: silentLogger(),
    client: {} as never,
    logClient: {} as never,
    sender: { execute: async () => assert.fail('nothing may be sent') },
    alerter: { alert: async () => true, clear: () => undefined },
    store: new V2Store(':memory:'),
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
  });
  const V = '0x00000000000000000000000000000000000000fa';
  const mtm = { day: 20_724, realised: -5_000_000n, unrealised: -1_250_000n, total: -6_250_000n, limit: 1_000_000_000n, tripped: false, unmarked: ['123'] };
  const lastTick = (plan: Record<string, unknown>) => ({
    head: { blockNumber: 1n, timestamp: OPEN_T },
    startedAt: 0,
    durationMs: 1,
    vaultAddress: V,
    plan: { selected: [], netDelta: [], series: [], txs: [], capped: [], outflow: { cap: 1n, used: 0n, released: 0n, budget: 1n, planned: 0n, blocked: false }, ...plan },
    input: { vault: { freeCollateral: new Map(), walletTokens: new Map(), tracked: [], epoch: null }, params: { maxSeriesUnits: 1n, maxTotalNotionalUsdg6: 1n } },
    vault: { isQuoter: true, tradingPaused: false, limits: {}, outflow: { available: 0n }, owed: 0n, sessionClose: null, sessionOpen: null, totalNotional: 0n, usdgWallet: 0n },
    stop: { day: 0, realised: 0n, limit: 1n, tripped: false },
    txs: [],
    coverage: {},
    pricing: { requested: 0, failed: 0, reasons: {} },
    budget: NO_BUDGET_CUT,
    scan: null,
    foreignOutflow: null,
    outflowRefused: [],
  });
  const stateWith = (plan: Record<string, unknown>) => {
    const inner = instance as unknown as { last: unknown; lastByVault: Map<string, unknown> };
    inner.last = lastTick(plan);
    inner.lastByVault = new Map([[V, inner.last]]);
    // The route serializes /state with bigintReplacer (routes.ts), so that is what a reader sees.
    return JSON.parse(JSON.stringify(instance.state(), bigintReplacer)) as { vaults: Array<{ mtm: unknown }> };
  };
  assert.deepEqual(stateWith({ mtm }).vaults[0]?.mtm, {
    day: 20_724,
    realised: '-5000000',
    unrealised: '-1250000',
    total: '-6250000',
    limit: '1000000000',
    tripped: false,
    unmarked: ['123'],
  });
  assert.equal(stateWith({}).vaults[0]?.mtm, null, 'a plan with no mtm (every series halted before the marks) says so');
});

/*//////////////////////////////////////////////////////////////
   (N3): THE TREASURY MAKERVAULT REDEEMS ITS OWN SETTLED TOKENS
//////////////////////////////////////////////////////////////*/

/**
 * Once the MakerVault is opted out of third-party redemption, the cranker's Clearinghouse.redeemBatch skips it
 * silently. The quoter finds the settled tokens the vault still holds (its ledger's expired series plus trackedSeries,
 * read through reads.readSettledHoldings) and the planner redeems each through MakerVault.redeem(tokenId).
 */
test('settledHoldings reads the expired ledger and tracked series, returns what is held, and stops asking about emptied ones', async () => {
  const config = loadV2Config(env) as MmConfig;
  const treasury = config.contracts.makerVault;
  const store = new V2Store(':memory:');
  const reads: string[] = [];
  // Series 10: settled, the vault holds 300 longs. Series 12: settled, nothing held. Series 14: expired, NOT settled yet.
  // Series 16: still live (not expired), never asked about.
  const chain: Record<string, { settled: boolean; longs: bigint; shorts: bigint }> = {
    '10': { settled: true, longs: 300n, shorts: 0n },
    '12': { settled: true, longs: 0n, shorts: 0n },
    '14': { settled: false, longs: 50n, shorts: 0n },
  };
  const instance = new MmBot({
    config,
    log: silentLogger(),
    client: {
      getBlockNumber: async () => 1n,
      multicall: async ({ contracts }: { contracts: ReadonlyArray<{ functionName: string; args?: readonly unknown[] }> }) =>
        contracts.map((c) => {
          const id = (c.functionName === 'series' ? c.args?.[0] : c.args?.[1]) as bigint;
          reads.push(`${c.functionName}(${id})`);
          const row = chain[(id & ~1n).toString()];
          if (row === undefined) return { status: 'failure', error: new Error('unknown') };
          // An out-of-the-money call (longPayoutPerUnit 0), so the redemption asks no spot and this test keeps
          // reading only the series and balances (reads.test.ts covers the converted-call hold).
          if (c.functionName === 'series') return { status: 'success', result: { settled: row.settled, isPut: false, longPayoutPerUnit: 0n } };
          return { status: 'success', result: (id & 1n) === 1n ? row.shorts : row.longs };
        }),
    } as never,
    logClient: {} as never,
    sender: { execute: async () => assert.fail('nothing may be sent') },
    alerter: { alert: async () => true, clear: () => undefined },
    store,
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
  });
  const seam = instance as unknown as {
    mm: MmStore;
    settledHoldings(a: MmAddresses, tracked: readonly bigint[], head: { blockNumber: bigint; timestamp: number }): Promise<Array<{ tokenId: bigint; longId: bigint; units: bigint }>>;
  };
  const U = '0x00000000000000000000000000000000000000ee';
  seam.mm.applySeriesRange([10n, 12n, 14n, 16n].map((longId) => ({ longId, underlying: U, isPut: false, strike: 220_000_000n, expiry: longId === 16n ? 1_800_000_000 : 1_790_000_000 })), 1n);
  // The vault traded 10 and 16 (ledger); 12 and 14 reach the candidates through trackedSeries.
  seam.mm.recordOrderProgress(21n, 300n, true, { type: 'fill', longId: '10', side: 'buy', units: 300n, price: 1_000_000n, feeBps: 0, at: 1_789_990_000 }, treasury);
  seam.mm.recordOrderProgress(22n, 10n, true, { type: 'fill', longId: '16', side: 'buy', units: 10n, price: 1_000_000n, feeBps: 0, at: 1_789_990_000 }, treasury);
  const a = { clearinghouse: config.contracts.clearinghouse, orderBook: config.contracts.orderBook, vault: treasury, usdg: config.registry.usdg, manager: config.contracts.accessManager } as MmAddresses;
  const head = { blockNumber: 1n, timestamp: 1_790_000_100 };

  const held = await seam.settledHoldings(a, [12n, 14n], head);
  assert.deepEqual(held, [{ tokenId: 10n, longId: 10n, units: 300n }], 'only the settled series with a balance');
  assert.ok(!reads.some((r) => r.includes('(16)') || r.includes('(17)')), 'a live series is never asked about');
  assert.ok(reads.includes('series(14)'), 'expired but not settled: asked');

  reads.length = 0;
  await seam.settledHoldings(a, [12n, 14n], head);
  assert.ok(!reads.includes('series(12)'), 'settled and emptied: not asked again');
  assert.ok(reads.includes('series(10)') && reads.includes('series(14)'), 'still held, or not settled yet: asked again');
});

test('a planned redeem is sent as MakerVault.redeem(tokenId) on the vault, never a Clearinghouse redeem, with the redeem gas', () => {
  const { instance } = bot(new V2Store(':memory:'));
  const vault = '0x00000000000000000000000000000000000000fa' as Address;
  const seam = instance as unknown as { callOf(tx: unknown, vault: Address): { call: { address: Address; functionName: string; args: readonly unknown[]; gas: bigint; abi: readonly { name?: string }[] }; kind: string; key: string } };
  const prepared = seam.callOf({ type: 'redeem', tokenId: 41n, longId: 40n, units: 120n, reason: 'r' }, vault);
  assert.equal(prepared.call.address, vault, 'sent to the vault');
  assert.equal(prepared.call.functionName, 'redeem');
  assert.deepEqual(prepared.call.args, [41n]);
  assert.equal(prepared.call.gas, MM_GAS.redeem);
  assert.ok(prepared.call.abi.some((x) => x.name === 'redeem'), 'the MakerVault ABI carries redeem(uint256)');
  assert.equal(prepared.kind, 'mm-redeem');
  assert.equal(prepared.key, '41', 'deduped per token id');
});
