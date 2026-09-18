/**
 * chain.ts without a chain: clients and handles are built (nothing dials until a request), the
 * multicall helpers and the head-block clock run against fakes.
 *
 * WHY THIS FILE EXISTS: three things here are easy to get quietly wrong. A chunked multicall that
 * does not pin one block reads a holder list across two blocks; a handle typed nullable for a
 * contract the mode requires pushes `!` into every cranker line (and one for a missing contract
 * typed non-null crashes at the first call); and the wiring check is what stops an env address from
 * one deployment being cranked beside a registry address from another.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address, PublicClient } from 'viem';
import { clearinghouseAbi } from './abi/clearinghouse.js';
import {
  MulticallError,
  chunk,
  contractHandles,
  createV2Clients,
  createV2Signer,
  headTimestamp,
  multicallMany,
  multicallStrict,
  readHead,
  readWiring,
  rpcLagSeconds,
  wiringProblems,
  type ContractHandle,
  type MulticallClient,
} from './chain.js';
import type { ContractsWith } from './config.js';

const CH: Address = '0x00000000000000000000000000000000000000C1';
const BOOK: Address = '0x00000000000000000000000000000000000000C2';
const CAL: Address = '0x00000000000000000000000000000000000000c4';
const USDG: Address = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';

/*//////////////////////////////////////////////////////////////
                        CLIENTS AND HANDLES
//////////////////////////////////////////////////////////////*/

test('createV2Clients: reads fall back across both RPCs, logs and sends stay on the primary, Multicall3 from config', () => {
  const clients = createV2Clients({ chainId: 4663, rpcUrls: ['http://127.0.0.1:9', 'http://127.0.0.1:10'], multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11' });
  assert.equal(clients.chain.id, 4663);
  assert.equal(clients.chain.name, 'Robinhood Chain');
  assert.equal(clients.chain.contracts?.multicall3?.address, '0xcA11bde05977b3631167028862bE2a173976CA11');
  assert.equal(clients.publicClient.transport.type, 'fallback');
  assert.equal(clients.logClient.transport.type, 'http');
  const signer = createV2Signer(clients, { privateKey: `0x${'11'.repeat(32)}`, primaryRpc: 'http://127.0.0.1:9' });
  assert.equal(signer.walletClient.transport.type, 'http');
  assert.equal(signer.walletClient.account?.address, signer.account.address);

  const single = createV2Clients({ chainId: 31337, rpcUrls: ['http://127.0.0.1:9'], multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11' });
  assert.equal(single.chain.name, 'Chain 31337');
  assert.equal(single.publicClient.transport.type, 'http');
});

test('contractHandles: a handle per ABI module, non-null exactly where the mode requires the address', () => {
  const { publicClient } = createV2Clients({ chainId: 4663, rpcUrls: ['http://127.0.0.1:9'], multicall3: '0xcA11bde05977b3631167028862bE2a173976CA11' });
  const contracts: ContractsWith<'clearinghouse' | 'orderBook'> = {
    clearinghouse: CH,
    orderBook: BOOK,
    settlementOracle: null,
    expiryCalendar: CAL,
    keeperRewards: null,
    autoRoller: null,
    payoutAdapter: null,
    makerVault: '0x00000000000000000000000000000000000000c8',
    makerRegistry: null,
    rewardsDistributor: null,
  };
  const handles = contractHandles(publicClient, contracts);
  // Type level: a required contract's handle needs no null check (typecheck fails otherwise)...
  const ch: ContractHandle<'clearinghouse'> = handles.clearinghouse;
  // ...and an optional one does.
  // @ts-expect-error settlementOracle is not required here, so its handle may be null
  const oracle: ContractHandle<'settlementOracle'> = handles.settlementOracle;
  void oracle;

  assert.equal(ch.address, CH);
  assert.equal(ch.abi, clearinghouseAbi);
  assert.equal(typeof ch.read.seriesExists, 'function');
  assert.equal(typeof ch.simulate.settle, 'function');
  assert.equal('write' in ch, false, 'writes go through tx.ts only');
  assert.equal(handles.expiryCalendar?.address, CAL, 'present but not required: a handle, typed nullable');
  assert.equal(handles.settlementOracle, null);
  assert.deepEqual(Object.keys(handles).sort(), ['autoRoller', 'clearinghouse', 'expiryCalendar', 'keeperRewards', 'makerRegistry', 'makerVault', 'orderBook', 'payoutAdapter', 'settlementOracle']);
  assert.equal(handles.makerVault?.address, '0x00000000000000000000000000000000000000c8', "the MM bot vault (K2-04) has a handle");
});

/*//////////////////////////////////////////////////////////////
                            MULTICALL
//////////////////////////////////////////////////////////////*/

test('chunk: consecutive slices, the last one short; a size under 1 is refused', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
  assert.throws(() => chunk([1], 0), /chunk size must be a positive integer/);
  assert.throws(() => chunk([1], 1.5), /chunk size must be a positive integer/);
});

/** A Multicall3 stand-in: `seriesExists(id)` is true for even ids, and id 13 reverts. */
function fakeMulticall() {
  const batches: Array<{ size: number; blockNumber: bigint | undefined; allowFailure: boolean }> = [];
  let headReads = 0;
  const client = {
    async getBlockNumber() {
      headReads += 1;
      return 777n;
    },
    async multicall(args: { contracts: Array<{ args: [bigint] }>; allowFailure: boolean; blockNumber?: bigint }) {
      batches.push({ size: args.contracts.length, blockNumber: args.blockNumber, allowFailure: args.allowFailure });
      return args.contracts.map((c) =>
        c.args[0] === 13n ? { status: 'failure', error: new Error('execution reverted: UnknownSeries()\nmore detail') } : { status: 'success', result: c.args[0] % 2n === 0n },
      );
    },
  };
  return { client: client as unknown as MulticallClient, batches, headReads: () => headReads };
}

const existsCalls = (ids: readonly bigint[]) => ids.map((id) => ({ address: CH, abi: clearinghouseAbi, functionName: 'seriesExists' as const, args: [id] as const }));

test('multicallMany: chunks, every chunk pinned to one head block, one outcome per call in order, failures in place', async () => {
  const fake = fakeMulticall();
  const ids = Array.from({ length: 450 }, (_, i) => BigInt(i));
  const outcomes = await multicallMany(fake.client, existsCalls(ids));
  assert.deepEqual(fake.batches.map((b) => b.size), [200, 200, 50]);
  assert.equal(fake.headReads(), 1, 'the head is read once, up front');
  assert.ok(fake.batches.every((b) => b.blockNumber === 777n && b.allowFailure));
  assert.equal(outcomes.length, 450);
  assert.deepEqual(outcomes[12], { ok: true, result: true });
  assert.equal(outcomes[13]?.ok, false);
  // Type level: the result of seriesExists is a boolean.
  const first = outcomes[0];
  if (first?.ok) {
    const exists: boolean = first.result;
    assert.equal(exists, true);
  }
});

test('multicallMany: one chunk needs no pin; an explicit block is used as given; nothing to read reads nothing', async () => {
  const single = fakeMulticall();
  await multicallMany(single.client, existsCalls([1n, 2n]));
  assert.equal(single.headReads(), 0);
  assert.equal(single.batches[0]?.blockNumber, undefined);

  const pinned = fakeMulticall();
  await multicallMany(pinned.client, existsCalls([1n, 2n, 3n]), { chunkSize: 2, blockNumber: 42n });
  assert.equal(pinned.headReads(), 0);
  assert.deepEqual(pinned.batches.map((b) => b.blockNumber), [42n, 42n]);

  const empty = fakeMulticall();
  assert.deepEqual(await multicallMany(empty.client, existsCalls([])), []);
  assert.equal(empty.batches.length, 0);
});

test('multicallStrict: all results, or a MulticallError naming the index, the function and the first line of the cause', async () => {
  const fake = fakeMulticall();
  assert.deepEqual(await multicallStrict(fake.client, existsCalls([2n, 3n])), [true, false]);
  await assert.rejects(multicallStrict(fake.client, existsCalls([2n, 13n])), (error: unknown) => {
    assert.ok(error instanceof MulticallError);
    assert.equal(error.index, 1);
    assert.equal(error.message, `multicall 1 seriesExists on ${CH} failed: execution reverted: UnknownSeries()`);
    return true;
  });
});

/*//////////////////////////////////////////////////////////////
                         THE HEAD BLOCK
//////////////////////////////////////////////////////////////*/

test('readHead / headTimestamp: the latest block\'s number and timestamp; rpcLagSeconds is the only wall-clock use', async () => {
  const tags: unknown[] = [];
  const client = {
    async getBlock(args: { blockTag: string }) {
      tags.push(args.blockTag);
      return { number: 65_000_000n, timestamp: 1_790_020_800n };
    },
  } as unknown as Pick<PublicClient, 'getBlock'>;
  assert.deepEqual(await readHead(client), { blockNumber: 65_000_000n, timestamp: 1_790_020_800 });
  assert.equal(await headTimestamp(client), 1_790_020_800);
  assert.deepEqual(tags, ['latest', 'latest']);

  const head = { blockNumber: 1n, timestamp: 1_790_020_800 };
  assert.equal(rpcLagSeconds(head, 1_790_020_812_999), 12);
  assert.equal(rpcLagSeconds(head, 1_790_020_700_000), 0, 'a head ahead of a slow local clock is not negative lag');
});

/*//////////////////////////////////////////////////////////////
                             WIRING
//////////////////////////////////////////////////////////////*/

test('wiringProblems: matching wiring (any address case) is clean; each mismatch and unreadable view is a sentence', () => {
  const expected = { clearinghouse: CH, orderBook: BOOK, expiryCalendar: CAL, usdg: USDG };
  assert.deepEqual(
    wiringProblems(expected, { orderBookClearinghouse: CH.toLowerCase() as Address, clearinghouseCalendar: CAL, clearinghouseUsdg: USDG }),
    [],
  );
  const other: Address = '0x00000000000000000000000000000000000000dd';
  assert.deepEqual(wiringProblems(expected, { orderBookClearinghouse: other, clearinghouseCalendar: other, clearinghouseUsdg: null }), [
    `orderBook ${BOOK} belongs to clearinghouse ${other}, not the configured ${CH}`,
    `clearinghouse ${CH} uses calendar ${other}, not the configured ${CAL}`,
    `clearinghouse ${CH}: usdg() could not be read`,
  ]);
  assert.deepEqual(
    wiringProblems({ clearinghouse: CH, orderBook: null, expiryCalendar: null, usdg: null }, { orderBookClearinghouse: null, clearinghouseCalendar: null, clearinghouseUsdg: null }),
    [],
    'nothing configured, nothing checked',
  );
});

test('readWiring: reads orderBook.clearinghouse, clearinghouse.calendar and usdg; a revert reads as null', async () => {
  const seen: string[] = [];
  const client = {
    async readContract(args: { address: Address; functionName: string }) {
      seen.push(`${args.address}.${args.functionName}`);
      if (args.functionName === 'usdg') throw new Error('execution reverted');
      return args.functionName === 'clearinghouse' ? CH : CAL;
    },
  } as unknown as Pick<PublicClient, 'readContract'>;
  const observed = await readWiring(client, { clearinghouse: CH, orderBook: BOOK, expiryCalendar: CAL, usdg: USDG });
  assert.deepEqual(observed, { orderBookClearinghouse: CH, clearinghouseCalendar: CAL, clearinghouseUsdg: null });
  assert.deepEqual(seen.sort(), [`${BOOK}.clearinghouse`, `${CH}.calendar`, `${CH}.usdg`].sort());
});
