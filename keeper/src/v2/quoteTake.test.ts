/**
 * quoteTakeAs: OrderBook.quoteTake is simulated from the taker's account.
 *
 * WHAT THIS CATCHES: a quote asked as a plain view read, or with no account. Against the order book the first no
 * longer typechecks and the second reverts NotAuthorized (msg.sender address(0)); against an older book a quote with no
 * `from` priced the zero address's fill, not the taker's, and nothing failed.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { zeroAddress, type Address } from 'viem';
import { orderBookAbi } from './abi/orderBook.js';
import { quoteTakeAs, type QuoteSimulator, type QuoteTakeParams } from './quoteTake.js';

const BOOK = '0x00000000000000000000000000000000000000b0' as Address;
const TAKER = '0x00000000000000000000000000000000000000c1' as Address;
const PARAMS: QuoteTakeParams = {
  longId: 7n, buying: true, orderIds: [3n], units: 100n, minUnits: 1n, limitPrice: 250_000n, writeToSell: false,
  recipient: TAKER, deadline: 1_789_620_300, maxTotalFee: (1n << 128n) - 1n,
};

function simulator(result: readonly [bigint, bigint, bigint, bigint]) {
  const calls: Array<Record<string, unknown>> = [];
  const client = {
    simulateContract: async (args: Record<string, unknown>) => { calls.push(args); return { result, request: args }; },
    readContract: async () => { throw new Error('quoteTake is not a view since T-OP-835'); },
  } as unknown as QuoteSimulator;
  return { client, calls };
}

test('the ABI quoteTakeAs asks with is the current one: quoteTake is nonpayable', () => {
  const fn = orderBookAbi.find((item) => item.type === 'function' && item.name === 'quoteTake');
  assert.ok(fn && fn.type === 'function');
  assert.equal(fn.stateMutability, 'nonpayable');
});

test('quoteTakeAs simulates quoteTake FROM the taker and returns its four values', async () => {
  const { client, calls } = simulator([100n, 250_000n, 1_000n, 0n]);
  assert.deepEqual(await quoteTakeAs(client, BOOK, TAKER, PARAMS), [100n, 250_000n, 1_000n, 0n]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.functionName, 'quoteTake');
  assert.equal(calls[0]!.address, BOOK);
  assert.equal(calls[0]!.account, TAKER);
  assert.deepEqual(calls[0]!.args, [PARAMS]);
});

test('quoteTakeAs refuses a missing or zero taker before any RPC', async () => {
  for (const taker of [zeroAddress, '0x0000000000000000000000000000000000000000' as Address, undefined as unknown as Address]) {
    const { client, calls } = simulator([0n, 0n, 0n, 0n]);
    await assert.rejects(quoteTakeAs(client, BOOK, taker, PARAMS), /taker account/);
    assert.equal(calls.length, 0);
  }
});

/**
 * The devnet harnesses (devnet-mm.ts, devnet-cycle.ts) run a devnet at module load, so they are read as text. Before
 * a later change, devnet-mm.ts asked quoteTake three times through its view `read` helper with NO account: against the
 * newer book each of those reverts NotAuthorized, and the harness stops at its first quote (step H7).
 */
test('the devnet harnesses ask every quote through quoteTakeAs with a taker, never as a view read', () => {
  const code = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')
    .split('\n').filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');
  for (const [file, quotes] of [['./mm/devnet-mm.ts', 3], ['./cranker/devnet-cycle.ts', 1]] as const) {
    const src = code(file);
    assert.doesNotMatch(src, /['"]quoteTake['"]/, `${file} names quoteTake as a read`);
    assert.equal([...src.matchAll(/quoteTakeAs\(pub, D\.contracts\.orderBook, [\w.!]+,/g)].length, quotes, `${file} quotes through quoteTakeAs`);
  }
});
