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
import { zeroAddress, type Address } from 'viem';
import { loadV2Config, type MmConfig } from '../config.js';
import { silentLogger } from '../logger.js';
import { V2Store } from '../store.js';
import type { TxOutcome } from '../tx.js';
import { KIND_INDEX, type OrderKindName } from './constants.js';
import { MmStore } from './mm-store.js';
import { replayLedger, type LossStop } from './pnl.js';
import type { HouseSupport } from './house.js';
import { Alerter } from '../alerts.js';
import { MmBot, flattenRecentFills, managedSeries, mmPlanParams, quotedMarkets, unionProtocolBook } from './quoter.js';
import { mountKillRoutes } from './routes.js';

const REGISTRY = fileURLToPath(new URL('../fixtures/registry-v2.json', import.meta.url));
const env = { V2_MODE: 'mm', RH_RPC: 'http://127.0.0.1:9', MM_QUOTER_PK: `0x${'11'.repeat(32)}`, PRICING_URL: 'http://127.0.0.1:8790', MM_KILL_TOKEN: 'k'.repeat(32), V2_REGISTRY_PATH: REGISTRY };

function bot(store: V2Store, config = loadV2Config(env) as MmConfig, house?: Partial<HouseSupport>) {
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
    // omitted it, which is why the outflow page could be keyed per day only and no test noticed (T-218).
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


/*----------------------------- N vaults (T-124) -----------------------------*/

const HEAD = { blockNumber: 100n, timestamp: 1_790_000_000 };
const HOUSE = '0x00000000000000000000000000000000000000fb' as Address;
const EXTRA = '0x00000000000000000000000000000000000000fc' as Address;

test('vaultTargets: treasury and MM_VAULTS extras have no epoch; a discovered House vault carries the one the chain gave', async () => {
  const config = loadV2Config({ ...env, MM_VAULTS: EXTRA, MM_HOUSE_FACTORY: '0x0000000000000000000000000000000000000f00' }) as MmConfig;
  const { instance } = bot(new V2Store(':memory:'), config, {
    discover: async () => [HOUSE],
    // epochEnd and epochId are the vault's (HouseVault.sol :191, :193); rollDue is recomputed from the head.
    readEpoch: async () => ({ epochEnd: HEAD.timestamp + 3_600, index: 4n, rollDue: true }),
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
  const config = loadV2Config({ ...env, MM_HOUSE_FACTORY: '0x0000000000000000000000000000000000000f00' }) as MmConfig;
  const { instance, alerts } = bot(new V2Store(':memory:'), config, { discover: async () => [HOUSE], readEpoch: async () => null });
  const targets = await instance.vaultTargets(HEAD);
  // THE POINT: not "quoted with epoch null". epoch null means `no epoch discipline` to mm/epoch.ts,
  // so falling back to it would be permission to open risk past epochEnd in the one kind of vault
  // that has to be flat for rollEpoch.
  assert.deepEqual(targets.map((t) => t.kind), ['treasury']);
  assert.deepEqual(alerts, ['v2_mm_house_unavailable']);
});

test('MM_HOUSE_FACTORY set but the factory cannot be enumerated: the treasury still ticks and the gap is named every tick', async () => {
  // The House ABI IS published now (T-159/T-163 exported HouseVault.json and HouseVaultFactory.json and
  // gen-abis renders both), so this no longer exercises the missing-artifact branch it was written for.
  // The PROPERTY it protects is unchanged and still worth proving: a configured factory the bot cannot
  // enumerate is REPORTED every tick rather than being silently equivalent to "no House vaults", and the
  // treasury keeps quoting through it. Here the client is unreachable, so `vaults()` throws.
  const config = loadV2Config({ ...env, MM_HOUSE_FACTORY: '0x0000000000000000000000000000000000000f00' }) as MmConfig;
  const { instance, alerts } = bot(new V2Store(':memory:'), config);
  const targets = await instance.vaultTargets(HEAD);
  assert.deepEqual(targets.map((t) => t.kind), ['treasury'], 'the treasury is unaffected by the House gap');
  assert.deepEqual(alerts, ['v2_mm_house_unavailable']);
  assert.match(String(instance.houseGap()), /could not be enumerated/);
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
        PER-VAULT ALERT SCOPING (T-218; found in T-201-AUDIT-CH1)
//////////////////////////////////////////////////////////////*/

/**
 * THE CASE THAT DID NOT EXIST. T-170 made the loss-stop MARK per vault and tested that two vaults do not SHARE a
 * row; nobody tested that they both GET one. The probe beside the mark still asked `dedupeKey null`, which matches
 * ANY vault's page from that UTC day, so the first vault DELIVERED silenced every other vault for the rest of the
 * day - the same outcome T-170 fixed, by a different route.
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

/*--------------------- one bad vault, the rest still act (T-473) ---------------------*/

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
  // Planning itself is planner.ts's and is not what this pins: record which vaults REACH it.
  const planned: string[] = [];
  const seam = instance as unknown as { trackOrders: () => Promise<unknown[]>; tickOne: (p: { a: { vault: string } }) => Promise<unknown> };
  seam.trackOrders = async () => [];
  seam.tickOne = async (p) => {
    planned.push(p.a.vault.toLowerCase());
    return { selected: [], netDelta: [], series: [], txs: [], capped: [], outflow: { cap: 0n, used: 0n, released: 0n, budget: 0n, planned: 0n, blocked: false } };
  };

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
 * T-540 / K8-05 suspicion 1: the fair-share tx budget in tick() "is the one piece of new arithmetic with no
 * test". Three readable vaults (treasury first, then MM_VAULTS in order) and MM_MAX_TX_PER_TICK = 10, so
 * share = 3. tickOne is replaced at the seam: it records the budget it was handed and "sends" a chosen number
 * of transactions by charging the same per-tick counter execute() charges -- planner and sender are not what
 * this pins. Each scenario runs the real tick() loop; the numbers are the arithmetic's own.
 */
async function tickBudgets(spend: readonly number[], opts: { throwAfterSending?: number } = {}): Promise<{ budgets: number[]; alerts: string[] }> {
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
  const seam = instance as unknown as { trackOrders: () => Promise<unknown[]>; tickOne: (...args: unknown[]) => Promise<unknown>; sentThisTick: number };
  seam.trackOrders = async () => [];
  seam.tickOne = async (...args: unknown[]) => {
    const i = budgets.length;
    budgets.push(args[6] as number);
    // What execute() would have done: one charge per send, capped by the budget it was handed.
    seam.sentThisTick += Math.min(spend[i] ?? 0, args[6] as number);
    if (opts.throwAfterSending === i) throw new Error('head re-read failed after the sends went out');
    return { selected: [], netDelta: [], series: [], txs: [], capped: [], outflow: { cap: 0n, used: 0n, released: 0n, budget: 0n, planned: 0n, blocked: false } };
  };
  await instance.tick();
  return { budgets, alerts };
}

test('tick: the fair-share tx budget -- treasury gets its share plus the remainder, the rest hold one share each, unspent budget flows forward', async () => {
  // M = 10, n = 3, share = 3: treasury 10 - 2x3 = 4; then 3 and 3 when everyone spends what they were given.
  assert.deepEqual((await tickBudgets([4, 3, 3])).budgets, [4, 3, 3]);
  // A treasury that spends 1 leaves 9: the second vault keeps one share for the third and may spend 6.
  assert.deepEqual((await tickBudgets([1, 6, 3])).budgets, [4, 6, 3]);
  // Nobody spends anything: every vault is offered the whole remainder less the reserve for those after it.
  assert.deepEqual((await tickBudgets([0, 0, 0])).budgets, [4, 7, 10]);
  // The process budget is a bound: three vaults spending everything they are handed send exactly M.
  const { budgets } = await tickBudgets([10, 10, 10]);
  assert.deepEqual(budgets, [4, 3, 3]);
  assert.equal(budgets.reduce((a, b) => a + b, 0), 10);
});

test('tick: a vault that throws AFTER sending is still charged, so the vaults after it cannot push the tick past MM_MAX_TX_PER_TICK', async () => {
  // Before T-540 the charge came from lastByVault, written at the END of tickOne: a vault that sent 4 and then
  // threw (the post-send head re-read is an RPC call) was never charged, the next vault was offered 7 instead
  // of 3, and the tick could send up to 14 against a budget of 10. Charging what execute() actually sent, on
  // the catch path too, keeps M a bound on the process. PROVE-BY-BREAKING: restore the old `remaining -=
  // lastByVault...` charge (this seam never writes lastByVault, exactly like a tickOne that threw before its
  // last line) and this reads [4, 7, 10] with the alert still raised.
  const { budgets, alerts } = await tickBudgets([4, 3, 3], { throwAfterSending: 0 });
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
          v2_mm_delta KEY AND v2_mm_killed TEXT (T-OP-092)
//////////////////////////////////////////////////////////////*/

test('v2_mm_delta: the page and its clear use ONE dedupe key, so a resolved delta lifts the cooldown it set (F-DAPP-08 shape)', async () => {
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
  // THE ASSERTION THIS ROW EXISTS FOR: the clear key IS the page key. Before T-OP-092 the clear passed `row.ticker`
  // alone, so `clearAlert` deleted `v2_mm_delta:NVDA` while the cooldown lived under `v2_mm_delta:<vault>:NVDA`,
  // and nothing was ever cleared.
  assert.equal(clear[0]!.key, page[0]!.dedupeKey, 'page -> resolve -> the SAME key is cleared');
});

test('v2_mm_killed: the page says which vault - one vault, or every vault (T-OP-092)', async () => {
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
 * F-DAPP-01 THROUGH THE CODE THAT CALLS IT (T-OP-106). `mm-store.test.ts` pins that two vaults can each RECORD a
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
 * PROVE BY BREAKING: revert the settlement key to the global form (`mm-store.ts:152` `settle:${longId}` for every
 * vault, and `hasSettlement` to ignore its vault argument) and this fails at "THE SECOND VAULT MUST CLOSE TOO":
 * B's `expired` is empty because A's row satisfies the global `hasSettlement`, B never records, B's units stay -100.
 */
test('ledgerStop through the quoter: two vaults holding ONE expired series both settle it and both close (F-DAPP-01 through the code that calls it)', async () => {
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
  // (fill uniqs are order-global on purpose), so this is not the F-DAPP-01 shape yet.
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
   T-OP-133 (from T-OP-123): A 50-SERIES MARKET IS FULLY SELECTED UNDER THE DERIVED CAPS
//////////////////////////////////////////////////////////////*/

// PROVE BY BREAKING (authored): restore the literal defaults (maxSeries 40 / maxSeriesPerMarket 10) in place of the
// derived 50 / 50 below and `selected` reads 10 with 40 `not-selected` -- the partial book T-OP-123 was opened on.
test('T-OP-133: the launch ladder (5 rungs x call/put x 2 weekly + 3 daily = 50) is selected in full when the caps derive from it', async () => {
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
  // The old literals leave forty unquoted: the failure the row was opened on, stated by the coverage row.
  const partial = selectSeries({ now, candidates, spots: new Map([[underlying, spot]]), pullMinutes: 15, maxSeries: 40, maxSeriesPerMarket: 10, epoch: null });
  assert.equal(marketCoverage({ now, live: candidates, picked: partial, pullMinutes: 15, epochEnd: null, tickerOf, listedByMarket: caps.coverage.listedByMarket }).NVDA!.trimmed['not-selected'], 40);
});
