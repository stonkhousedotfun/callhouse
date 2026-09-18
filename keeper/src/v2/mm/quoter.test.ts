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
import type { Address } from 'viem';
import { loadV2Config, type MmConfig } from '../config.js';
import { silentLogger } from '../logger.js';
import { V2Store } from '../store.js';
import type { TxOutcome } from '../tx.js';
import { KIND_INDEX, type OrderKindName } from './constants.js';
import { MmStore } from './mm-store.js';
import { MmBot, managedSeries, mmPlanParams, quotedMarkets } from './quoter.js';
import { mountKillRoutes } from './routes.js';

const REGISTRY = fileURLToPath(new URL('../fixtures/registry-v2.json', import.meta.url));
const env = { V2_MODE: 'mm', RH_RPC: 'http://127.0.0.1:9', MM_QUOTER_PK: `0x${'11'.repeat(32)}`, PRICING_URL: 'http://127.0.0.1:8790', MM_KILL_TOKEN: 'k'.repeat(32), V2_REGISTRY_PATH: REGISTRY };

function bot(store: V2Store, config = loadV2Config(env) as MmConfig) {
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
  const tick = (timestamp: number) => ({
    head: { blockNumber: 1n, timestamp },
    stop: { day, realised: -2_000_000_000n, limit: 1_000_000_000n, tripped: true },
    vault: { isQuoter: true, usdgWallet: 0n },
    plan: { netDelta: [], series: [], capped: [], outflow: { cap: 2_500_000_000n, used: 0n, released: 0n, budget: 2_500_000_000n, planned: 0n, blocked: false } },
    foreignOutflow: null,
    outflowRefused: [],
    pricing: { requested: 0, failed: 0, reasons: {} },
  });
  const raise = (timestamp: number) => (instance as unknown as { raiseAlerts(t: unknown): Promise<void> }).raiseAlerts(tick(timestamp));

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
  readonly config = loadV2Config(env) as MmConfig;
  readonly orders = new Map<bigint, BookOrder>();
  readonly failing = new Set<bigint>();
  readonly cancelCalls: bigint[][] = [];
  deployHash = hash('d1');

  add(id: bigint, kind: OrderKindName, validUntil: number, over: Partial<BookOrder> = {}): void {
    this.orders.set(id, { maker: this.config.contracts.makerVault, longId: 7n, kind: KIND_INDEX[kind], price: 1_000_000n, units: 100n, filled: 0n, validUntil, cancelled: false, ...over });
  }

  client() {
    const c = this.config.contracts;
    return {
      getBlock: async (args: { blockNumber?: bigint }) =>
        args.blockNumber !== undefined ? { number: args.blockNumber, hash: this.deployHash, timestamp: 0n } : { number: 65_200_000n, hash: hash('ee'), timestamp: BigInt(T) },
      readContract: async ({ functionName, args = [] }: { functionName: string; args?: readonly unknown[] }) => {
        switch (functionName) {
          case 'orderBook':
            return c.orderBook;
          case 'usdg':
            return '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
          case 'calendar':
            return c.expiryCalendar;
          case 'makerOrderCount':
            return BigInt(this.orders.size);
          case 'ordersOfMaker': {
            const [, from, limit] = args as [Address, bigint, bigint];
            const ids = [...this.orders.keys()].slice(Number(from), Number(from + limit));
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
