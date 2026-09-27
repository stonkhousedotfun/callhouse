/**
 * readVaultState reads a House vault's reserved USDG in the SAME pinned multicall as its wallet,
 * appended after the existing positional reads; a treasury vault issues neither call; a failed reserve read throws.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Address } from 'viem';
import type { MulticallClient } from '../chain.js';
import { bandOf, readHouseReserve, readMeasuredNotional, readOtherAskers, readSeriesViews, readSettledHoldings, readVaultState, type MmAddresses } from './reads.js';

const A: MmAddresses = {
  clearinghouse: '0x00000000000000000000000000000000000000c1' as Address,
  orderBook: '0x00000000000000000000000000000000000000b0' as Address,
  vault: '0x00000000000000000000000000000000000000fa' as Address,
  usdg: '0x00000000000000000000000000000000000000e6' as Address,
  manager: '0x00000000000000000000000000000000000000a0' as Address,
};
const BLOCK = 65_200_123n;
const INPUT = { signer: '0x0000000000000000000000000000000000000001' as Address, calendar: '0x00000000000000000000000000000000000000ca' as Address, now: 1_790_000_000, blockNumber: BLOCK };

/** The 13 reads readVaultState issued before the reserve reads were appended, in order. Pinned so an insertion that shifts r[0..12] fails. */
const EXISTING = ['limits', 'totalNotional', 'trackedSeries', 'canCall', 'pendingFeeParams', 'tradingPaused', 'owed', 'makerOrderCount', 'feeParams', 'balanceOf', 'isRegularSession', 'closeOf', 'outflow'];

const VIEWS: Record<string, unknown> = {
  limits: { maxSeriesUnits: 1n, maxTotalNotional: 1n, askToleranceBps: 0, maxBidBpsOfSpot: 0, maxOrderLifetime: 0, maxDailyOutflow: 1n },
  totalNotional: 0n,
  trackedSeries: [],
  canCall: [true, 0],
  pendingFeeParams: [{ premiumFeeBps: 0, resaleFeeBps: 0 }, 0],
  tradingPaused: false,
  owed: 5n,
  makerOrderCount: 0n,
  feeParams: { premiumFeeBps: 500, resaleFeeBps: 0 },
  balanceOf: 1_000n,
  isRegularSession: false,
  closeOf: 0n,
  outflow: [0n, 1n],
  // DISTINCT and non-zero, so dropping any term of the sum changes the answer.
  pendingDepositUsdg: 7n,
  owedUsdg: 11n,
  // (N1): a carried performance fee. The contract reserves it (HouseVault._requireUnreservedSpend).
  performanceFeeOwed: 13n,
  // The quoting brake and the stock reserve depositToClearinghouse clamps to. Distinct, non-zero again.
  quotingPaused: true,
  pendingDepositStock: 17n,
  owedStock: 19n,
};

type Call = { address: string; functionName: string };

function fake(fail: ReadonlySet<string> = new Set()): { client: MulticallClient; batches: Array<{ calls: Call[]; blockNumber: bigint | undefined }> } {
  const batches: Array<{ calls: Call[]; blockNumber: bigint | undefined }> = [];
  const client = {
    getBlockNumber: async () => BLOCK + 9n,
    multicall: async ({ contracts, blockNumber }: { contracts: ReadonlyArray<Call>; blockNumber?: bigint }) => {
      batches.push({ calls: contracts.map((c) => ({ address: c.address, functionName: c.functionName })), blockNumber });
      return contracts.map((c) =>
        fail.has(c.functionName) || !(c.functionName in VIEWS)
          ? { status: 'failure', error: new Error(`reverted: ${c.functionName}`) }
          : { status: 'success', result: VIEWS[c.functionName] },
      );
    },
  } as unknown as MulticallClient;
  return { client, batches };
}

test('House: the three reserve reads target the vault at the tick block AFTER the 13 existing reads, and usdgReserved is their sum', async () => {
  const { client, batches } = fake();
  const state = await readVaultState(client, A, { ...INPUT, house: true });
  assert.equal(batches.length, 1, 'one pinned multicall');
  const [batch] = batches;
  assert.equal(batch!.blockNumber, BLOCK, 'pinned to the tick block');
  assert.deepEqual(batch!.calls.slice(0, 13).map((c) => c.functionName), EXISTING, 'r[0..12] unchanged in order');
  assert.deepEqual(batch!.calls.slice(13), [
    { address: A.vault, functionName: 'pendingDepositUsdg' },
    { address: A.vault, functionName: 'owedUsdg' },
    { address: A.vault, functionName: 'performanceFeeOwed' },
    // Appended after the reserve reads, never between them.
    { address: A.vault, functionName: 'quotingPaused' },
    { address: A.vault, functionName: 'pendingDepositStock' },
    { address: A.vault, functionName: 'owedStock' },
  ]);
  assert.equal(state.usdgReserved, 31n, 'pendingDepositUsdg 7 + owedUsdg 11 + performanceFeeOwed 13');
  assert.equal(state.quotingPaused, true, 'HouseVault.quotingPaused as read');
  assert.equal(state.stockReserved, 36n, 'pendingDepositStock 17 + owedStock 19: HouseVault._unreservedWallet(underlying)');
  assert.equal(state.usdgWallet, 1_000n);
  assert.equal(state.owed, 5n, 'OrderBook.owed is still its own field, not the House reserve');
});

test('treasury: neither reserve view is read, and usdgReserved is null', async () => {
  const { client, batches } = fake();
  const state = await readVaultState(client, A, { ...INPUT, house: false });
  const names = batches.flatMap((b) => b.calls.map((c) => c.functionName));
  assert.deepEqual(names, EXISTING);
  assert.ok(!names.includes('pendingDepositUsdg') && !names.includes('owedUsdg') && !names.includes('performanceFeeOwed'));
  assert.ok(!names.includes('quotingPaused') && !names.includes('pendingDepositStock') && !names.includes('owedStock'), 'T-OP-791: a MakerVault has none of these getters');
  assert.equal(state.usdgReserved, null);
  assert.equal(state.quotingPaused, null);
  assert.equal(state.stockReserved, null);
});

test('House: a failed pendingDepositUsdg, owedUsdg, performanceFeeOwed, quotingPaused, pendingDepositStock or owedStock read throws rather than reading as zero or unpaused', async () => {
  for (const view of ['pendingDepositUsdg', 'owedUsdg', 'performanceFeeOwed', 'quotingPaused', 'pendingDepositStock', 'owedStock']) {
    const { client } = fake(new Set([view]));
    await assert.rejects(readVaultState(client, A, { ...INPUT, house: true }), new RegExp(`house\\.${view}`), `${view} failing must throw`);
  }
});

test('readHouseReserve: wallet and all three reserves in one multicall at a FRESH block, never the tick block; a failed read throws', async () => {
  const { client, batches } = fake();
  const r = await readHouseReserve(client, A);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]!.blockNumber, BLOCK + 9n, 'read at the block getBlockNumber returned now');
  assert.deepEqual(batches[0]!.calls, [
    { address: A.usdg, functionName: 'balanceOf' },
    { address: A.vault, functionName: 'pendingDepositUsdg' },
    { address: A.vault, functionName: 'owedUsdg' },
    { address: A.vault, functionName: 'performanceFeeOwed' },
  ]);
  assert.deepEqual(r, { blockNumber: BLOCK + 9n, wallet: 1_000n, reserved: 31n });
  await assert.rejects(readHouseReserve(fake(new Set(['owedUsdg'])).client, A), /house\.owedUsdg/);
  // A failed fee read is a refusal, never a fee of zero.
  await assert.rejects(readHouseReserve(fake(new Set(['performanceFeeOwed'])).client, A), /house\.performanceFeeOwed/);
});

/*//////////////////////////////////////////////////////////////
   (N3): THE SETTLED TOKENS THE VAULT STILL HOLDS
//////////////////////////////////////////////////////////////*/

/**
 * A Clearinghouse fake: per long id, whether it is settled and the vault's long and short balances (`fail` = reverts).
 * A row may also say it is a put and what a long pays (`payout`, default 0 = out of the money, which never asks
 * the spot), and `env` answers the conversion reads: payoutPrefs(vault).inKind, payoutAdapter(), and the series oracle's
 * spot(underlying) (`fail` = reverts).
 */
const ORACLE = '0x00000000000000000000000000000000000000d5';
const SETTLED_STOCK = '0x00000000000000000000000000000000000000a5';
type ChRow = { settled: boolean; longs: bigint | 'fail'; shorts: bigint | 'fail'; isPut?: boolean; payout?: bigint };
type ChEnv = { inKind?: boolean | 'fail'; adapter?: string | 'fail'; spot?: bigint | 'fail' };
function chFake(rows: Record<string, ChRow | 'fail'>, env: ChEnv = {}) {
  const batches: Array<{ calls: Array<{ address: string; functionName: string; args: readonly unknown[] }>; blockNumber: bigint | undefined }> = [];
  const client = {
    multicall: async ({ contracts, blockNumber }: { contracts: ReadonlyArray<{ address: string; functionName: string; args?: readonly unknown[] }>; blockNumber?: bigint }) => {
      batches.push({ calls: contracts.map((c) => ({ address: c.address, functionName: c.functionName, args: c.args ?? [] })), blockNumber });
      return contracts.map((c) => {
        const failure = { status: 'failure', error: new Error('reverted') };
        const answer = (v: unknown) => (v === 'fail' ? failure : { status: 'success', result: v });
        if (c.functionName === 'payoutPrefs') return answer(env.inKind === 'fail' ? 'fail' : [env.inKind ?? false, false]);
        if (c.functionName === 'payoutAdapter') return answer(env.adapter ?? '0x00000000000000000000000000000000000000ad');
        if (c.functionName === 'spot') return answer(env.spot === 'fail' ? 'fail' : [env.spot ?? 210_000_000n, 1_790_000_000n]);
        const args = c.args ?? [];
        const id = args[c.functionName === 'series' ? 0 : 1] as bigint;
        const long = (id & ~1n).toString();
        const row = rows[long];
        if (row === undefined || row === 'fail') return failure;
        if (c.functionName === 'series') return { status: 'success', result: { settled: row.settled, isPut: row.isPut ?? false, longPayoutPerUnit: row.payout ?? 0n, oracle: ORACLE, underlying: SETTLED_STOCK } };
        const v = (id & 1n) === 1n ? row.shorts : row.longs;
        return answer(v);
      });
    },
  } as unknown as MulticallClient;
  return { client, batches };
}

test('readSettledHoldings: one multicall of series + both balances per id; held lists each non-zero settled token', async () => {
  const { client, batches } = chFake({
    '40': { settled: true, longs: 300n, shorts: 0n },
    '42': { settled: true, longs: 0n, shorts: 120n },
    '44': { settled: true, longs: 0n, shorts: 0n },
    '46': { settled: false, longs: 500n, shorts: 0n },
  });
  const r = await readSettledHoldings(client, A, [40n, 42n, 44n, 46n], BLOCK);
  assert.equal(batches.length, 1, 'one pinned multicall');
  assert.equal(batches[0]!.blockNumber, BLOCK);
  assert.deepEqual(batches[0]!.calls.slice(0, 3), [
    { address: A.clearinghouse, functionName: 'series', args: [40n] },
    { address: A.clearinghouse, functionName: 'balanceOf', args: [A.vault, 40n] },
    { address: A.clearinghouse, functionName: 'balanceOf', args: [A.vault, 41n] },
  ], 'the short id is longId | 1');
  assert.deepEqual(r.held, [
    { tokenId: 40n, longId: 40n, units: 300n },
    { tokenId: 43n, longId: 42n, units: 120n },
  ]);
  assert.deepEqual(r.empty, [44n], 'settled with nothing held: the caller may stop asking');
});

test('readSettledHoldings: a series not settled, or any failed read, is in neither list (asked again next tick)', async () => {
  const { client } = chFake({
    '40': 'fail',
    '42': { settled: true, longs: 'fail', shorts: 5n },
    '46': { settled: false, longs: 500n, shorts: 0n },
  });
  const r = await readSettledHoldings(client, A, [40n, 42n, 46n], BLOCK);
  assert.deepEqual(r, { held: [], empty: [], waiting: [] });
});

test('readSettledHoldings: no ids, no read', async () => {
  const { client, batches } = chFake({});
  assert.deepEqual(await readSettledHoldings(client, A, [], BLOCK), { held: [], empty: [], waiting: [] });
  assert.equal(batches.length, 0);
});

test('readSettledHoldings: an ITM call long paid in USDG waits for a fresh spot (MakerVault.redeem runs _spot after the payout)', async () => {
  const rows = { '40': { settled: true, longs: 300n, shorts: 0n, payout: 5n } };
  for (const spot of [0n, 'fail'] as const) {
    const { client, batches } = chFake(rows, { spot });
    const r = await readSettledHoldings(client, A, [40n], BLOCK);
    assert.deepEqual(r.held, [], `spot ${spot}: not redeemed, it would revert`);
    assert.deepEqual(r.empty, [], 'and not recorded empty: asked again next tick');
    assert.equal(r.waiting.length, 1);
    assert.equal(r.waiting[0]!.tokenId, 40n);
    assert.match(r.waiting[0]!.reason, /fresh spot/);
    assert.equal(batches.length, 2);
    assert.equal(batches[1]!.blockNumber, BLOCK, 'the conversion reads are pinned to the same block');
    assert.deepEqual(batches[1]!.calls, [
      { address: A.clearinghouse, functionName: 'payoutPrefs', args: [A.vault] },
      { address: A.clearinghouse, functionName: 'payoutAdapter', args: [] },
      { address: ORACLE, functionName: 'spot', args: [SETTLED_STOCK] },
    ], "the series' own oracle and underlying, as MakerVault._spot asks");
  }
  const fresh = await readSettledHoldings(chFake(rows).client, A, [40n], BLOCK);
  assert.deepEqual(fresh, { held: [{ tokenId: 40n, longId: 40n, units: 300n }], empty: [], waiting: [] }, 'a fresh spot: redeemed');
});

test('readSettledHoldings: nothing converts -- in kind, no adapter, a put, an OTM call, a short -- so a stale spot holds nothing back', async () => {
  const itmCall = { '40': { settled: true, longs: 300n, shorts: 0n, payout: 5n } };
  const stale = { spot: 0n } as const;
  assert.equal((await readSettledHoldings(chFake(itmCall, { ...stale, inKind: true }).client, A, [40n], BLOCK)).held.length, 1, 'paid in kind: inUsdg false, no _spot');
  assert.equal((await readSettledHoldings(chFake(itmCall, { ...stale, adapter: '0x0000000000000000000000000000000000000000' }).client, A, [40n], BLOCK)).held.length, 1, 'no payout adapter: paid in kind');
  const others = chFake({
    '42': { settled: true, longs: 10n, shorts: 0n, isPut: true, payout: 5n },
    '44': { settled: true, longs: 10n, shorts: 0n, payout: 0n },
    '46': { settled: true, longs: 0n, shorts: 20n, payout: 5n },
  }, stale);
  const r = await readSettledHoldings(others.client, A, [42n, 44n, 46n], BLOCK);
  assert.deepEqual(r.held.map((h) => h.tokenId), [42n, 44n, 47n]);
  assert.deepEqual(r.waiting, []);
  assert.equal(others.batches.length, 1, 'no conversion read when no held call long pays');
});

test('readSettledHoldings: an unreadable payout preference or adapter counts as converting, so the redemption waits', async () => {
  const rows = { '40': { settled: true, longs: 300n, shorts: 0n, payout: 5n } };
  for (const env of [{ inKind: 'fail', spot: 0n }, { adapter: 'fail', spot: 0n }] as const) {
    const r = await readSettledHoldings(chFake(rows, env).client, A, [40n], BLOCK);
    assert.deepEqual(r.held, []);
    assert.equal(r.waiting.length, 1);
  }
});

/*//////////////////////////////////////////////////////////////
   WHAT BACKS ANOTHER MAKER'S ASK (readOtherAskers)
//////////////////////////////////////////////////////////////*/

const OTHER = '0x00000000000000000000000000000000000000cc';
const BROKE = '0x00000000000000000000000000000000000000dd';
const PROTO = '0x00000000000000000000000000000000000000bb';
const STOCK = '0x0000000000000000000000000000000000000a11';
const NOW = 1_790_000_000;
// kind: 0 Bid, 1 AskResale, 2 AskWrite (constants.ORDER_KIND).
const ORDERS: Record<string, { maker: string; longId: bigint; kind: number; price: bigint; units: bigint; filled: bigint; validUntil: number; cancelled: boolean }> = {
  '1': { maker: A.vault, longId: 7n, kind: 2, price: 3_000_000n, units: 100n, filled: 0n, validUntil: NOW + 600, cancelled: false }, // the vault's own
  '2': { maker: OTHER, longId: 7n, kind: 2, price: 2_900_000n, units: 300n, filled: 100n, validUntil: 0, cancelled: false },
  '3': { maker: PROTO, longId: 7n, kind: 1, price: 2_950_000n, units: 100n, filled: 0n, validUntil: NOW + 600, cancelled: false },
  '4': { maker: OTHER, longId: 7n, kind: 2, price: 1n, units: 100n, filled: 0n, validUntil: NOW + 600, cancelled: true }, // dead
  '5': { maker: BROKE, longId: 7n, kind: 2, price: 2_800_000n, units: 100n, filled: 0n, validUntil: NOW + 600, cancelled: false },
  '6': { maker: PROTO, longId: 8n, kind: 1, price: 4_000_000n, units: 100n, filled: 0n, validUntil: NOW + 600, cancelled: false },
};

function book(failFreeOf: ReadonlySet<string> = new Set()) {
  const batches: Array<Array<{ functionName: string; args: readonly unknown[] }>> = [];
  const client = {
    getBlockNumber: async () => BLOCK,
    multicall: async ({ contracts }: { contracts: ReadonlyArray<{ functionName: string; args: readonly unknown[] }> }) => {
      batches.push(contracts.map((c) => ({ functionName: c.functionName, args: c.args })));
      return contracts.map((c) => {
        const [x, y] = c.args as [unknown, unknown];
        switch (c.functionName) {
          case 'seriesOrderCount': return { status: 'success', result: x === 7n ? 5n : 1n };
          case 'ordersOfSeries': return { status: 'success', result: [x === 7n ? [1n, 2n, 3n, 4n, 5n] : [6n], 0n] };
          case 'collateralAsset': return { status: 'success', result: STOCK };
          case 'free': return failFreeOf.has(String(x).toLowerCase())
            ? { status: 'failure', error: new Error('reverted: free') }
            : { status: 'success', result: String(x).toLowerCase() === OTHER && String(y).toLowerCase() === STOCK ? 12n * 10n ** 18n : 0n };
          default: return { status: 'failure', error: new Error(`unexpected ${c.functionName}`) };
        }
      });
    },
    readContract: async ({ functionName, args }: { functionName: string; args: [readonly bigint[]] }) => {
      assert.equal(functionName, 'getOrders');
      return args[0].map((id) => ORDERS[id.toString()]!);
    },
  } as unknown as Parameters<typeof readOtherAskers>[0];
  return { client, batches };
}

test('readOtherAskers: each third-party AskWrite carries its maker\'s free collateral; a resale carries none; the vault\'s own ask is dropped', async () => {
  const { client, batches } = book(new Set([BROKE]));
  const { asks } = await readOtherAskers(client, A, [7n, 8n], NOW, BLOCK);
  const s7 = asks.get('7')!;
  assert.deepEqual(s7.map((o) => o.id), [2n, 3n, 5n], 'own (1) and cancelled (4) orders are not other asks');
  assert.ok(!s7.some((o) => o.maker === A.vault.toLowerCase()), 'the vault never counts as another asker');
  const [write, resale, broke] = s7;
  assert.equal(write!.kind, 'AskWrite');
  assert.equal(write!.remaining, 200n);
  assert.equal(write!.makerFree, 12n * 10n ** 18n, 'Clearinghouse.free(maker, collateralAsset(series))');
  assert.equal(resale!.kind, 'AskResale');
  assert.equal(resale!.makerFree, undefined, 'a resale is backed by its escrowed longs, no balance read');
  assert.equal(broke!.makerFree, null, 'a failed free read is null (unknown), never 0n');
  // Only series 7 carries an AskWrite, so only it gets a collateralAsset read; series 8 (a resale only) gets none.
  const names = batches.flat();
  assert.deepEqual(names.filter((c) => c.functionName === 'collateralAsset').map((c) => c.args[0]), [7n]);
  assert.deepEqual(names.filter((c) => c.functionName === 'free').map((c) => [String(c.args[0]).toLowerCase(), c.args[1]]),
    [[OTHER, STOCK], [BROKE, STOCK]], 'one free read per distinct (maker, asset)');
  assert.deepEqual(asks.get('8')!.map((o) => [o.id, o.makerFree]), [[6n, undefined]]);
});

test('readOtherAskers: no third-party AskWrite, no extra reads', async () => {
  const { client, batches } = book();
  await readOtherAskers(client, A, [8n], NOW, BLOCK);
  const names = batches.flat().map((c) => c.functionName);
  assert.ok(!names.includes('collateralAsset') && !names.includes('free'), names.join(','));
});

/*//////////////////////////////////////////////////////////////
     THE SPOT-LAG BAND IS THE ORACLE'S LIVE maxDeviationBps
//////////////////////////////////////////////////////////////*/

const NVDA = '0x00000000000000000000000000000000000000aa' as Address;
/** The series' PINNED oracle, deliberately not any address the market read would use. */
const PINNED = '0x00000000000000000000000000000000000000d1' as Address;

/** On a v9 fork: a HouseVault's askFloorOf(id, true) and askFloorOf(id, false). */
const WRITE_FLOOR = 775_328n;
const RESALE_FLOOR = 736_561n;

/**
 * A chain with one series on PINNED; `config` is marketConfig(NVDA)'s answer there ('fail' = it reverts). `vault` is
 * the vault kind at A.vault: both answer askFloorOf(uint256,bool), and only a MakerVault answers askFloor(uint256)
 * (MakerVault.sol askFloor; HouseVault.sol has askFloorOf alone), so on 'house' an askFloor read reverts as on chain.
 * `fail` names reads, as `fn(args)`, that revert.
 */
function seriesFake(
  config: readonly [readonly Address[], number, number, number] | 'fail',
  vault: 'maker' | 'house' = 'maker',
  fail: readonly string[] = [],
): { client: MulticallClient; batches: Array<Array<Call & { args?: readonly unknown[] }>> } {
  const batches: Array<Array<Call & { args?: readonly unknown[] }>> = [];
  const views: Record<string, unknown> = {
    series: { underlying: NVDA, oracle: PINNED, exerciseFeeBps: 0, settled: false, settlementPrice: 0n, isPut: false, strike: 200_000_000n, expiry: 1_790_100_000, mintFeePpm: 80 },
    exposure: [0n, 0n, { longs: 0n, shorts: 0n, bids: 0n, resale: 0n, writes: 0n, live: 0n }],
    ...(vault === 'maker' ? { askFloor: WRITE_FLOOR } : {}),
    bidCap: 2n,
    seriesNotional: 0n,
    collateralAsset: NVDA,
    collateralPerUnit: 10n ** 16n,
    trySpot: [true, 229_030_000n, 1_789_999_000n],
    ...(config === 'fail' ? {} : { marketConfig: config }),
  };
  const client = {
    multicall: async ({ contracts }: { contracts: ReadonlyArray<Call & { args?: readonly unknown[] }> }) => {
      batches.push(contracts.map((c) => ({ address: c.address, functionName: c.functionName, args: c.args })));
      return contracts.map((c) => {
        const call = `${c.functionName}(${(c.args ?? []).map(String).join(',')})`;
        if (fail.includes(call)) return { status: 'failure', error: new Error(`reverted: ${call}`) };
        if (c.functionName === 'askFloorOf') return { status: 'success', result: c.args?.[1] === true ? WRITE_FLOOR : RESALE_FLOOR };
        return c.functionName in views ? { status: 'success', result: views[c.functionName] } : { status: 'failure', error: new Error(`reverted: ${c.functionName}`) };
      });
    },
  } as unknown as MulticallClient;
  return { client, batches };
}

const ONE_SERIES = { series: [{ info: { longId: 40n, underlying: NVDA, isPut: false, strike: 200_000_000n, expiry: 1_790_100_000 }, ticker: 'NVDA', orders: [] }], blockNumber: BLOCK };

test('readSeriesViews: marketConfig is read on the series\' PINNED oracle beside trySpot, and its maxDeviationBps is the view\'s oracleBandBps', async () => {
  const { client, batches } = seriesFake([[PINNED], 300, 21_600, 90_000]);
  const [view] = await readSeriesViews(client, A, ONE_SERIES);
  assert.equal(batches.length, 2, 'the series multicall, then one spot multicall');
  assert.deepEqual(batches[1], [
    { address: PINNED, functionName: 'trySpot', args: [NVDA.toLowerCase()] },
    { address: PINNED, functionName: 'marketConfig', args: [NVDA.toLowerCase()] },
  ]);
  assert.equal(view!.oracleBandBps, 300, 'the owner-set band, not the env default');
  assert.equal(view!.spot, 229_030_000n, 'trySpot still lands on spot (the pair is interleaved, not shifted)');
  assert.equal(view!.spotUpdatedAt, 1_789_999_000);
});

test('readSeriesViews: a marketConfig that reverts leaves oracleBandBps null (the env band alone) and the spot untouched', async () => {
  const { client } = seriesFake('fail');
  const [view] = await readSeriesViews(client, A, ONE_SERIES);
  assert.equal(view!.oracleBandBps, null);
  assert.equal(view!.spot, 229_030_000n);
});

/*//////////////////////////////////////////////////////////////
   THE ASK FLOOR IS askFloorOf PER KIND, ON EVERY VAULT
//////////////////////////////////////////////////////////////*/

test('readSeriesViews: a HouseVault (no askFloor) gets both floors from askFloorOf, and askFloor is never read', async () => {
  const { client, batches } = seriesFake([[PINNED], 300, 21_600, 90_000], 'house');
  const [view] = await readSeriesViews(client, A, ONE_SERIES);
  // Read with askFloor, a HouseVault reverts every leg: the floors come back null and every House series halts
  // guards-unreadable, which is what was measured on both House vaults.
  assert.deepEqual(view!.askFloors, { write: WRITE_FLOOR, resale: RESALE_FLOOR }, 'HouseVault: the floors must come from askFloorOf, the only floor read it has');
  assert.deepEqual(view!.guardFailures, [], 'every guard read answered');
  const vaultCalls = batches[0]!.filter((c) => c.address.toLowerCase() === A.vault.toLowerCase());
  assert.deepEqual(vaultCalls.filter((c) => c.functionName.startsWith('askFloor')).map((c) => [c.functionName, ...(c.args ?? [])]), [
    ['askFloorOf', 40n, true],
    ['askFloorOf', 40n, false],
  ]);
  assert.equal(vaultCalls.some((c) => c.functionName === 'askFloor'), false, 'askFloor(uint256) exists on MakerVault only');
});

test('readSeriesViews: a MakerVault is read the same way; write and resale floors are the primary=true and primary=false legs', async () => {
  const { client, batches } = seriesFake([[PINNED], 300, 21_600, 90_000], 'maker');
  const [view] = await readSeriesViews(client, A, ONE_SERIES);
  assert.deepEqual(view!.askFloors, { write: WRITE_FLOOR, resale: RESALE_FLOOR });
  assert.equal(batches[0]!.some((c) => c.functionName === 'askFloor'), false, 'one read path for both vault kinds');
  assert.equal(view!.bidCap, 2n, 'the legs after the floors are not shifted');
  assert.equal(view!.collateralPerUnit, 10n ** 16n);
});

test('readSeriesViews: one failed floor leg leaves no floor pair and names the failing call', async () => {
  const { client } = seriesFake([[PINNED], 300, 21_600, 90_000], 'house', ['askFloorOf(40,false)', 'bidCap(40)']);
  const [view] = await readSeriesViews(client, A, ONE_SERIES);
  assert.equal(view!.askFloors, null, 'a write floor without its resale floor is not a pair the planner may price with');
  assert.equal(view!.bidCap, null);
  assert.deepEqual(view!.guardFailures!.map((f) => f.split(':')[0]), ['askFloorOf(40,false)', 'bidCap(40)']);
  assert.match(view!.guardFailures![0]!, /reverted: askFloorOf\(40,false\)/, 'the error travels with the call');
});

test('bandOf: element 1 of marketConfig when it is a band in (0, 10 000) bps; anything else is unread', () => {
  assert.equal(bandOf([[PINNED], 150, 21_600, 90_000]), 150);
  assert.equal(bandOf([[PINNED], 1_000, 21_600, 90_000]), 1_000, 'the contract ceiling MAX_DEVIATION_CEIL_BPS');
  assert.equal(bandOf(undefined), null, 'a failed read');
  assert.equal(bandOf([[PINNED], 0, 21_600, 90_000]), null, 'zero is not a band');
  assert.equal(bandOf([[PINNED], 10_000, 21_600, 90_000]), null, 'the whole spot is not a band');
  assert.equal(bandOf([[PINNED], Number.NaN, 21_600, 90_000]), null);
});

test('readMeasuredNotional: stored and live notional per tracked series, and held from the exposure detail (longs, shorts, live)', async () => {
  // HouseVault.exposure: (units, live notional, detail). Series 40 stores more than it measures; 42 is a
  // flat series already storing 0 (the case the old measured-below-stored rule never synced); 44 is a held pair (net 0
  // units, still tracked); 46's exposure read fails; 48 holds only a live order (HouseVault._holds counts it).
  const detail = (longs: bigint, shorts: bigint, live: bigint) => ({ longs, shorts, bids: 0n, resale: 0n, writes: 0n, live });
  const views: Record<string, { stored: bigint; exposure: readonly [bigint, bigint, ReturnType<typeof detail>] | 'fail' }> = {
    '40': { stored: 23_000_000n, exposure: [10n, 13_800_000n, detail(10n, 0n, 0n)] },
    '42': { stored: 0n, exposure: [0n, 0n, detail(0n, 0n, 0n)] },
    '44': { stored: 0n, exposure: [0n, 0n, detail(5n, 5n, 0n)] },
    '46': { stored: 7n, exposure: 'fail' },
    '48': { stored: 0n, exposure: [0n, 0n, detail(0n, 0n, 1n)] },
  };
  const calls: Array<{ address: string; functionName: string; args: readonly bigint[] }> = [];
  const client = {
    multicall: async ({ contracts }: { contracts: ReadonlyArray<{ address: string; functionName: string; args: readonly bigint[] }> }) => {
      calls.push(...contracts.map((c) => ({ address: c.address, functionName: c.functionName, args: c.args })));
      return contracts.map((c) => {
        const v = views[String(c.args[0])]!;
        if (c.functionName === 'seriesNotional') return { status: 'success', result: v.stored };
        return v.exposure === 'fail' ? { status: 'failure', error: new Error('reverted') } : { status: 'success', result: v.exposure };
      });
    },
  } as unknown as MulticallClient;
  const r = await readMeasuredNotional(client, A.vault, [40n, 42n, 44n, 46n, 48n], BLOCK);
  assert.deepEqual(calls.slice(0, 2), [
    { address: A.vault, functionName: 'seriesNotional', args: [40n] },
    { address: A.vault, functionName: 'exposure', args: [40n] },
  ]);
  assert.deepEqual(r, [
    { longId: 40n, stored: 23_000_000n, measured: 13_800_000n, held: true },
    { longId: 42n, stored: 0n, measured: 0n, held: false },
    { longId: 44n, stored: 0n, measured: 0n, held: true },
    { longId: 46n, stored: 7n, measured: null, held: null },
    { longId: 48n, stored: 0n, measured: 0n, held: true },
  ]);
});

/*//////////////////////////////////////////////////////////////
   A FAILED READ IS UNKNOWN, NEVER ZERO OR "NONE"
//////////////////////////////////////////////////////////////*/

test('readSeriesViews: a failed seriesNotional read is flagged unread (its 0n must not be summed as known); a read one is not', async () => {
  const failed = seriesFake([[PINNED], 300, 21_600, 90_000], 'maker', ['seriesNotional(40)']);
  const [view] = await readSeriesViews(failed.client, A, ONE_SERIES);
  assert.equal(view!.seriesNotionalUnread, true);
  assert.equal(view!.seriesNotional, 0n, 'still 0n for the vault-wide cap, where subtracting nothing is conservative');
  const read = seriesFake([[PINNED], 300, 21_600, 90_000]);
  const [ok] = await readSeriesViews(read.client, A, ONE_SERIES);
  assert.equal(ok!.seriesNotionalUnread, undefined);
});

test('readOtherAskers: a series whose order count or id page could not be read is reported partial (truncated), never "no other asker"', async () => {
  const fake = (fail: 'count' | 'page' | null) => ({
    getBlockNumber: async () => BLOCK,
    multicall: async ({ contracts }: { contracts: ReadonlyArray<{ functionName: string; args: readonly unknown[] }> }) =>
      contracts.map((c) => {
        const [x] = c.args as [unknown];
        if (c.functionName === 'seriesOrderCount') return fail === 'count' && x === 7n ? { status: 'failure', error: new Error('HTTP 429') } : { status: 'success', result: x === 7n ? 5n : 1n };
        if (c.functionName === 'ordersOfSeries') return fail === 'page' && x === 7n ? { status: 'failure', error: new Error('HTTP 429') } : { status: 'success', result: [x === 7n ? [1n, 2n, 3n, 4n, 5n] : [6n], 0n] };
        if (c.functionName === 'collateralAsset') return { status: 'success', result: STOCK };
        if (c.functionName === 'free') return { status: 'success', result: 0n };
        return { status: 'failure', error: new Error(`unexpected ${c.functionName}`) };
      }),
    readContract: async ({ args }: { args: [readonly bigint[]] }) => args[0].map((id) => ORDERS[id.toString()]!),
  }) as unknown as Parameters<typeof readOtherAskers>[0];
  for (const fail of ['count', 'page'] as const) {
    const r = await readOtherAskers(fake(fail), A, [7n, 8n], NOW, BLOCK);
    assert.deepEqual(r.truncated, ['7'], `${fail} read failed: series 7 is named partial`);
    assert.deepEqual(r.asks.get('7'), [], 'nothing was seen on it');
    assert.deepEqual(r.asks.get('8')!.map((o) => o.id), [6n], 'the other series is read as usual');
  }
  const ok = await readOtherAskers(fake(null), A, [7n, 8n], NOW, BLOCK);
  assert.deepEqual(ok.truncated, [], 'control: every read answered, nothing partial');
});
