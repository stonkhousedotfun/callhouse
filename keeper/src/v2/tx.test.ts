/**
 * tx.ts's seven steps against a fake chain and an in-memory journal.
 *
 * WHY THIS FILE EXISTS: every v2 transaction goes through TxSender, and each of its failure modes
 * costs gas or pays twice: a duplicate of an unmined transaction, a send whose simulation reverted,
 * a nonce reused by two concurrent steps, a journal row written after the wait (lost on a kill), a
 * nonce gap left by a failed send. Pinned here, step by step, with the order of chain calls
 * recorded.
 *
 * DELIBERATELY ABSENT: viem clients and any RPC. viemTxChain is the thin adapter over them.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BaseError, ContractFunctionRevertedError, HttpRequestError, TimeoutError, encodeErrorResult, type Address, type Hash } from 'viem';
import { clearinghouseAbi } from './abi/clearinghouse.js';
import { settlementOracleAbi } from './abi/settlementOracle.js';
import { v2ErrorsAbi } from './abi/v2Errors.js';
import { silentLogger } from './logger.js';
import { V2Store } from './store.js';
import {
  DEFAULT_IN_FLIGHT_TTL_MS,
  NonceTracker,
  SerialQueue,
  TxSender,
  describeError,
  isTransportError,
  revertDetail,
  revertName,
  type TxChain,
  type TxReceiptSummary,
  type WriteCall,
} from './tx.js';

const CH: Address = '0x00000000000000000000000000000000000000C1';
const ORACLE: Address = '0x00000000000000000000000000000000000000c3';
const NVDA: Address = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC';

const settleCall = (longId: bigint) => ({ address: CH, abi: clearinghouseAbi, functionName: 'settle', args: [longId] }) as const;

/** A viem revert of `errorName`, as simulateContract would throw it. */
function revert(errorName: 'TooEarly' | 'AlreadySettled', args: readonly unknown[] = []): BaseError {
  const data = encodeErrorResult({ abi: v2ErrorsAbi, errorName, args } as never);
  return new BaseError('simulation failed', { cause: new ContractFunctionRevertedError({ abi: v2ErrorsAbi, data, functionName: 'settle' }) });
}

type ReceiptPlan = TxReceiptSummary | 'timeout' | ((hash: Hash) => Promise<TxReceiptSummary>);

/** Records every chain call in `log`; behaviour is set per test through the public fields. */
class FakeChain implements TxChain {
  readonly account: Address = '0x000000000000000000000000000000000000beef';
  log: string[] = [];
  /** What the node reports as the pending transaction count. */
  pending = 5;
  /** What the node reports as the mined (latest) transaction count. */
  mined = 0;
  simulateResult: unknown = true;
  simulateError: Error | null = null;
  broadcastError: Error | null = null;
  receipts: ReceiptPlan[] = [];
  /** getReceipt answers from here; absent = not mined. */
  known = new Map<Hash, TxReceiptSummary>();
  sent: Array<{ nonce: number; request: unknown }> = [];

  async simulate(call: WriteCall) {
    this.log.push(`simulate ${call.functionName}(${(call.args as readonly unknown[]).join(',')})`);
    if (this.simulateError) throw this.simulateError;
    return { result: this.simulateResult, request: { fn: call.functionName, args: call.args } };
  }

  async broadcast(request: unknown, nonce: number): Promise<Hash> {
    this.log.push(`broadcast nonce=${nonce}`);
    if (this.broadcastError) throw this.broadcastError;
    this.sent.push({ nonce, request });
    return `0x${(this.sent.length).toString(16).padStart(64, '0')}` as Hash;
  }

  async pendingNonce(): Promise<number> {
    this.log.push('pendingNonce');
    return this.pending;
  }

  async minedNonce(): Promise<number> {
    this.log.push('minedNonce');
    return this.mined;
  }

  async waitForReceipt(hash: Hash, timeoutMs: number): Promise<TxReceiptSummary> {
    this.log.push(`wait ${hash.slice(-2)} timeout=${timeoutMs}`);
    const plan = this.receipts.shift() ?? { status: 'success', blockNumber: 100n, gasUsed: 21_000n };
    if (plan === 'timeout') throw new Error('Timed out while waiting for transaction');
    return typeof plan === 'function' ? plan(hash) : plan;
  }

  async getReceipt(hash: Hash): Promise<TxReceiptSummary | null> {
    this.log.push(`getReceipt ${hash.slice(-2)}`);
    return this.known.get(hash) ?? null;
  }
}

function setup(options: { now?: () => number } = {}) {
  const chain = new FakeChain();
  const store = new V2Store(':memory:');
  const sender = new TxSender({ chain, store, log: silentLogger(), txTimeoutMs: 30_000, ...(options.now ? { now: options.now } : {}) });
  return { chain, store, sender };
}

/*//////////////////////////////////////////////////////////////
                          THE HAPPY PATH
//////////////////////////////////////////////////////////////*/

test('execute: simulate → nonce → broadcast → journal row BEFORE the wait → receipt → confirmed with the simulated result', async () => {
  const { chain, store, sender } = setup({ now: () => 1_000 });
  let rowDuringWait: string | null = null;
  chain.receipts.push(async (hash) => {
    rowDuringWait = store.getTx(hash)?.status ?? null;
    return { status: 'success', blockNumber: 101n, gasUsed: 55_000n };
  });

  const outcome = await sender.execute(settleCall(7n), { kind: 'settle', key: '7' });

  assert.deepEqual(chain.log, ['simulate settle(7)', 'pendingNonce', 'broadcast nonce=5', 'wait 01 timeout=30000']);
  assert.equal(rowDuringWait, 'pending', 'recorded before the receipt wait');
  assert.deepEqual(outcome, { status: 'confirmed', hash: `0x${'1'.padStart(64, '0')}`, nonce: 5, blockNumber: 101n, gasUsed: 55_000n, result: true });
  assert.deepEqual(chain.sent[0]?.request, { fn: 'settle', args: [7n] }, 'the simulated request is what is signed');
  const row = store.latestTx('settle', '7');
  assert.equal(row?.status, 'success');
  assert.equal(row?.nonce, 5);
  assert.equal(row?.function_name, 'settle');
  assert.equal(row?.to_address, CH);
  assert.equal(row?.block_number, '101');
  assert.equal(row?.gas_used, '55000');
  assert.equal(row?.created_at, 1_000);
  assert.equal(sender.nonces.peek(), 6);
});

/*//////////////////////////////////////////////////////////////
                        NOTHING IS SENT WHEN
//////////////////////////////////////////////////////////////*/

test('isAdvanced() true: skipped before simulating; errors in the read propagate', async () => {
  const { chain, store, sender } = setup();
  assert.deepEqual(await sender.execute(settleCall(7n), { kind: 'settle', key: '7', isAdvanced: async () => true }), { status: 'already-advanced' });
  assert.deepEqual(chain.log, []);
  assert.equal(store.latestTx('settle', '7'), null);
  await assert.rejects(sender.execute(settleCall(7n), { kind: 'settle', key: '7', isAdvanced: async () => Promise.reject(new Error('rpc down')) }), /rpc down/);
});

test('a reverting simulation is an outcome with the custom error\'s name; no nonce read, no broadcast, no row', async () => {
  const { chain, store, sender } = setup();
  chain.simulateError = revert('TooEarly', [1_790_020_920]);
  const outcome = await sender.execute(settleCall(7n), { kind: 'settle', key: '7' });
  assert.equal(outcome.status, 'simulation-reverted');
  assert.ok(outcome.status === 'simulation-reverted');
  assert.equal(outcome.revert, 'TooEarly');
  assert.deepEqual(chain.log, ['simulate settle(7)']);
  assert.equal(store.latestTx('settle', '7'), null);
});

test('worthSending() refuses the simulated result: no-op; its argument is typed by the ABI', async () => {
  const { chain, sender } = setup();
  chain.simulateResult = false; // settle → advanced = false
  const seen: boolean[] = [];
  const outcome = await sender.execute(settleCall(7n), {
    kind: 'settle',
    key: '7',
    // Type level: `advanced` is settle's `bool` return; typecheck fails if the ABI typing is lost.
    worthSending: (advanced: boolean) => {
      seen.push(advanced);
      return advanced;
    },
  });
  assert.deepEqual(outcome, { status: 'no-op', result: false });
  assert.deepEqual(seen, [false]);
  assert.deepEqual(chain.log, ['simulate settle(7)']);

  // A tuple return: finalize → [finalized, price].
  chain.simulateResult = [true, 215_000_000n];
  const finalize = await sender.execute(
    { address: ORACLE, abi: settlementOracleAbi, functionName: 'finalize', args: [NVDA, 1_790_020_800] },
    { kind: 'finalize', key: `${NVDA}:1790020800`, worthSending: ([finalized, price]: readonly [boolean, bigint]) => finalized && price > 0n },
  );
  assert.equal(finalize.status, 'confirmed');
});

test('a failed broadcast: send-failed, no row, and the nonce tracker forgets so the next send asks the node', async () => {
  const { chain, store, sender } = setup();
  await sender.execute(settleCall(1n), { kind: 'settle', key: '1' });
  assert.equal(sender.nonces.peek(), 6);
  chain.broadcastError = new Error('insufficient funds for gas');
  const outcome = await sender.execute(settleCall(2n), { kind: 'settle', key: '2' });
  assert.deepEqual(outcome, { status: 'send-failed', error: 'insufficient funds for gas' });
  assert.equal(store.latestTx('settle', '2'), null);
  assert.equal(sender.nonces.peek(), null);
});

/*//////////////////////////////////////////////////////////////
                     REVERTS, TIMEOUTS, IN FLIGHT
//////////////////////////////////////////////////////////////*/

test('a receipt with status reverted: reverted outcome and row; the nonce was consumed', async () => {
  const { chain, store, sender } = setup();
  chain.receipts.push({ status: 'reverted', blockNumber: 102n, gasUsed: 30_000n });
  const outcome = await sender.execute(settleCall(7n), { kind: 'settle', key: '7' });
  assert.equal(outcome.status, 'reverted');
  assert.equal(store.latestTx('settle', '7')?.status, 'reverted');
  assert.equal(store.latestTx('settle', '7')?.error, 'receipt status: reverted');
  assert.equal(sender.nonces.peek(), 6);
});

test('no receipt in time: unconfirmed, row stays pending; the same (kind, key) is not sent again until mined, dropped or past the TTL', async () => {
  let now = 10_000;
  const { chain, store, sender } = setup({ now: () => now });
  chain.receipts.push('timeout');
  const first = await sender.execute(settleCall(7n), { kind: 'settle', key: '7' });
  assert.equal(first.status, 'unconfirmed');
  assert.ok(first.status === 'unconfirmed');
  assert.equal(store.getTx(first.hash)?.status, 'pending');
  assert.match(store.getTx(first.hash)?.error ?? '', /Timed out/);
  assert.equal(sender.nonces.peek(), null, 'forgotten: the node decides whether that nonce is still taken');

  // Not mined, 5 minutes old: in flight. Nothing simulated, nothing sent.
  now += 5 * 60_000;
  chain.log = [];
  let advancedReads = 0;
  const isAdvanced = async () => {
    advancedReads += 1;
    return false;
  };
  assert.deepEqual(await sender.execute(settleCall(7n), { kind: 'settle', key: '7', isAdvanced }), { status: 'in-flight', hash: first.hash });
  assert.deepEqual(chain.log, ['getReceipt 01', 'minedNonce']);
  assert.equal(advancedReads, 0);

  // Another key is not blocked by it.
  assert.equal((await sender.execute(settleCall(8n), { kind: 'settle', key: '8' })).status, 'confirmed');

  // Mined after all: recorded, then the state read decides (already advanced).
  chain.known.set(first.hash, { status: 'success', blockNumber: 150n, gasUsed: 50_000n });
  assert.deepEqual(await sender.execute(settleCall(7n), { kind: 'settle', key: '7', isAdvanced: async () => true }), { status: 'already-advanced' });
  assert.equal(store.getTx(first.hash)?.status, 'success');
  assert.equal(store.getTx(first.hash)?.block_number, '150');
});

test('an unmined submission older than the TTL is marked dropped and the step proceeds', async () => {
  let now = 0;
  const { chain, store, sender } = setup({ now: () => now });
  chain.receipts.push('timeout');
  const first = await sender.execute(settleCall(7n), { kind: 'settle', key: '7' });
  assert.ok(first.status === 'unconfirmed');

  now = DEFAULT_IN_FLIGHT_TTL_MS + 1;
  chain.log = [];
  const retry = await sender.execute(settleCall(7n), { kind: 'settle', key: '7' });
  assert.equal(retry.status, 'confirmed');
  assert.deepEqual(chain.log.slice(0, 3), ['getReceipt 01', 'minedNonce', 'simulate settle(7)']);
  assert.equal(store.getTx(first.hash)?.status, 'dropped');
  assert.match(store.getTx(first.hash)?.error ?? '', /no receipt 600 s after submission/);
});

/*//////////////////////////////////////////////////////////////
                         NONCES AND ORDER
//////////////////////////////////////////////////////////////*/

test('concurrent executes run one at a time: consecutive nonces from a lagging node, each simulation after the previous receipt', async () => {
  const { chain, sender } = setup();
  // The node never sees our pending transactions: it keeps answering 5.
  const outcomes = await Promise.all([1n, 2n, 3n].map((id) => sender.execute(settleCall(id), { kind: 'settle', key: String(id) })));
  assert.deepEqual(
    outcomes.map((o) => (o.status === 'confirmed' ? o.nonce : null)),
    [5, 6, 7],
  );
  assert.deepEqual(chain.log, [
    'simulate settle(1)', 'pendingNonce', 'broadcast nonce=5', 'wait 01 timeout=30000',
    'simulate settle(2)', 'pendingNonce', 'broadcast nonce=6', 'wait 02 timeout=30000',
    'simulate settle(3)', 'pendingNonce', 'broadcast nonce=7', 'wait 03 timeout=30000',
  ]);
});

test('a step that throws does not wedge the queue', async () => {
  const { sender } = setup();
  const failing = sender.execute(settleCall(1n), { kind: 'settle', key: '1', isAdvanced: async () => Promise.reject(new Error('boom')) });
  const next = sender.execute(settleCall(2n), { kind: 'settle', key: '2' });
  await assert.rejects(failing, /boom/);
  assert.equal((await next).status, 'confirmed');
});

test('NonceTracker: the node when it knows nothing, its own next when the node lags, the node when someone else sent', async () => {
  const tracker = new NonceTracker();
  assert.equal(await tracker.take(async () => 3), 3);
  tracker.used(3);
  assert.equal(await tracker.take(async () => 3), 4, 'lagging node');
  tracker.used(4);
  assert.equal(await tracker.take(async () => 9), 9, 'an operator sent from the same key');
  tracker.reset();
  assert.equal(tracker.peek(), null);
  assert.equal(await tracker.take(async () => 2), 2, 'after a reset the node is trusted, even lower');
});

test('SerialQueue: strictly in call order, a rejection passes to its caller only', async () => {
  const queue = new SerialQueue();
  const order: string[] = [];
  const slow = queue.run(async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push('slow');
  });
  const bad = queue.run(async () => {
    order.push('bad');
    throw new Error('bad');
  });
  const fast = queue.run(async () => {
    order.push('fast');
    return 42;
  });
  await slow;
  await assert.rejects(bad, /bad/);
  assert.equal(await fast, 42);
  assert.deepEqual(order, ['slow', 'bad', 'fast']);
});

test('a reverting simulation carries the custom error\'s decoded arguments (SourceNotPinned\'s source and reason) for the caller to name', async () => {
  const { chain, sender } = setup();
  const source = '0x157f589Cd9d0E4a94C9936ede3b23BEfa3017F20';
  const data = encodeErrorResult({ abi: v2ErrorsAbi, errorName: 'SourceNotPinned', args: [source, '0xea8e4eb5'] } as never);
  chain.simulateError = new BaseError('simulation failed', { cause: new ContractFunctionRevertedError({ abi: v2ErrorsAbi, data, functionName: 'roll' }) });
  const outcome = await sender.execute(settleCall(7n), { kind: 'settle', key: '7' });
  assert.ok(outcome.status === 'simulation-reverted');
  assert.equal(outcome.revert, 'SourceNotPinned');
  assert.deepEqual(outcome.revertArgs, [source, '0xea8e4eb5']);
  assert.deepEqual(revertDetail(chain.simulateError), { name: 'SourceNotPinned', args: [source, '0xea8e4eb5'] });
  // An argument-less error carries none.
  chain.simulateError = revert('AlreadySettled');
  const bare = await sender.execute(settleCall(8n), { kind: 'settle', key: '8' });
  assert.ok(bare.status === 'simulation-reverted');
  assert.equal('revertArgs' in bare, false);
  assert.equal(revertDetail(new Error('socket hang up')), null);
});

test('revertName / describeError: custom error names through viem\'s cause chain; plain errors pass through', () => {
  assert.equal(revertName(revert('AlreadySettled')), 'AlreadySettled');
  assert.equal(revertName(new Error('socket hang up')), null);
  assert.equal(revertName(new BaseError('rpc failed')), null);
  assert.equal(describeError(new BaseError('short', { details: 'a long multi-line dump' })), 'short');
  assert.equal(describeError(new Error('plain')), 'plain');
  assert.equal(describeError('text'), 'text');
});

test('a simulation that got no answer (HTTP failure, timeout) is flagged transportError; one the node executed and refused is not', async () => {
  const { chain, sender } = setup();
  chain.simulateError = new BaseError('simulation failed', { cause: new HttpRequestError({ url: 'http://127.0.0.1:9', status: 429 }) });
  const down = await sender.execute(settleCall(9n), { kind: 'settle', key: '9' });
  assert.ok(down.status === 'simulation-reverted');
  assert.equal(down.transportError, true);
  assert.equal(isTransportError(new TimeoutError({ body: {}, url: 'http://127.0.0.1:9' })), true);
  // Out of gas as a whole: a revert without data. Worth splitting, not a dead RPC.
  chain.simulateError = new BaseError('simulation failed', { cause: new ContractFunctionRevertedError({ abi: v2ErrorsAbi, functionName: 'redeemBatch' }) });
  const oog = await sender.execute(settleCall(10n), { kind: 'settle', key: '10' });
  assert.ok(oog.status === 'simulation-reverted');
  assert.equal(oog.revert, null);
  assert.equal('transportError' in oog, false);
});

test('onProgress: told after every execute, whatever the outcome, so a tick of hundreds of sends keeps its heartbeat', async () => {
  const chain = new FakeChain();
  chain.receipts = [{ status: 'success', blockNumber: 1n, gasUsed: 1n }];
  let beats = 0;
  const sender = new TxSender({ chain, store: new V2Store(':memory:'), log: silentLogger(), txTimeoutMs: 1_000, onProgress: () => (beats += 1) });
  await sender.execute(settleCall(1n), { kind: 'settle', key: '1' });
  chain.simulateError = revert('AlreadySettled');
  await sender.execute(settleCall(2n), { kind: 'settle', key: '2' });
  await sender.execute(settleCall(3n), { kind: 'settle', key: '3', isAdvanced: async () => true });
  assert.equal(beats, 3);
});

test('an unmined submission whose nonce the chain has already used (another transaction took it) is dropped at once, not held for the ten-minute TTL', async () => {
  let now = 0;
  const { chain, store, sender } = setup({ now: () => now });
  chain.receipts.push('timeout');
  const lost = await sender.execute(settleCall(7n), { kind: 'snapshot', key: 'u:E' });
  assert.ok(lost.status === 'unconfirmed');
  assert.equal(lost.nonce, 5);
  // The RPC lost it; the next send reused nonce 5 and was mined.
  chain.mined = 6;
  now = 60_000;
  chain.log = [];
  const retry = await sender.execute(settleCall(7n), { kind: 'snapshot', key: 'u:E' });
  assert.equal(retry.status, 'confirmed', 'a snapshot lost at expiry + 2 is resent inside the 600 s grace');
  assert.equal(store.getTx(lost.hash)?.status, 'dropped');
  assert.match(store.getTx(lost.hash)?.error ?? '', /nonce 5 .*used/);
});
