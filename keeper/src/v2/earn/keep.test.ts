/**
 * earn/keep.ts: the mm bot's EarnVault venue step. The buffer comes from the rendered env (MmTuning.earn),
 * the decision boundary is pinned on both sides of it and inside the dust band, the cranker's actions are dropped, and
 * a queue whose head stands still is measured on the head clock.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ContractFunctionRevertedError, encodeErrorResult } from 'viem';

import { earnVaultAbi } from '../abi/earnVault.js';
import { loadV2Config, type MmConfig } from '../config.js';
import { keepEarn, planVenue, stuckReason, venueMoves, watchQueue, type EarnMove, type EarnVenueKnobs } from './keep.js';
import type { EarnState } from './plan.js';
import { readEarnState } from './reads.js';

const USDG = (n: number) => BigInt(Math.round(n * 1e6));
const REGISTRY = fileURLToPath(new URL('../fixtures/registry-v2.json', import.meta.url));
const MM_ENV = {
  V2_MODE: 'mm',
  RH_RPC: 'http://127.0.0.1:9',
  MM_QUOTER_PK: `0x${'11'.repeat(32)}`,
  PRICING_URL: 'http://127.0.0.1:8790',
  MM_KILL_TOKEN: 'k'.repeat(32),
  V2_REGISTRY_PATH: REGISTRY,
  V2_EARN_VAULT: `0x${'ea'.repeat(20)}`,
};

/** The venue settings exactly as the mm bot gets them: env, through loadV2Config, into MmTuning.earn. */
function renderedKnobs(env: Record<string, string>): EarnVenueKnobs {
  const earn = (loadV2Config({ ...MM_ENV, ...env }) as MmConfig).tuning.earn;
  assert.ok(earn !== null);
  return earn;
}

// An idle flat vault with an adapter and no queue (head 1 > tail 0, the constructor's empty state).
const state = (over: Partial<EarnState> = {}): EarnState => ({
  adapter: '0x00000000000000000000000000000000000000ad',
  hasOpenPosition: false,
  venueUnreadable: false,
  queueHead: 1n,
  queueTail: 0n,
  wallet: USDG(10_000),
  escrowed: 0n,
  deferred: 0n,
  totalAssets: USDG(100_000),
  venueWithdrawable: USDG(90_000),
  now: 1_800_000_000,
  lastSkimAt: null,
  ...over,
});

test('the buffer is the rendered EARN_BUFFER_USDG6: above it sweeps the excess, below it pulls the gap, at it nothing', () => {
  const k = renderedKnobs({ EARN_BUFFER_USDG6: String(USDG(10_000)), EARN_DUST_USDG6: String(USDG(1)) });
  assert.equal(k.bufferUsdg6, USDG(10_000));

  assert.deepEqual(planVenue(state({ wallet: USDG(10_250) }), k).moves, [{ kind: 'sweep', amount: USDG(250) }]);
  assert.deepEqual(planVenue(state({ wallet: USDG(9_600) }), k).moves, [{ kind: 'pull', amount: USDG(400), reason: 'buffer' }]);
  assert.deepEqual(planVenue(state({ wallet: USDG(10_000) }), k).moves, [], 'exactly at the buffer');
});

test('within the dust band either side of the buffer nothing is sent; one base unit past it is', () => {
  const k = renderedKnobs({ EARN_BUFFER_USDG6: String(USDG(10_000)), EARN_DUST_USDG6: String(USDG(1)) });
  assert.deepEqual(planVenue(state({ wallet: USDG(10_000) + USDG(1) - 1n }), k).moves, [], 'excess one unit under dust');
  assert.deepEqual(planVenue(state({ wallet: USDG(10_000) - USDG(1) + 1n }), k).moves, [], 'gap one unit under dust');
  assert.deepEqual(planVenue(state({ wallet: USDG(10_001) }), k).moves, [{ kind: 'sweep', amount: USDG(1) }]);
  assert.deepEqual(planVenue(state({ wallet: USDG(9_999) }), k).moves, [{ kind: 'pull', amount: USDG(1), reason: 'buffer' }]);
});

test('EARN_BUFFER_BPS of totalAssets wins when larger, and escrowed deposits never count as idle', () => {
  const k = renderedKnobs({ EARN_BUFFER_USDG6: String(USDG(1_000)), EARN_BUFFER_BPS: '500' });
  // 5 % of 100 000 = 5 000 > 1 000. Wallet 8 000 of which 2 000 escrowed: 6 000 unescrowed, 1 000 over.
  assert.deepEqual(planVenue(state({ wallet: USDG(8_000), escrowed: USDG(2_000) }), k).moves, [{ kind: 'sweep', amount: USDG(1_000) }]);
});

test('the launch setting (both buffers 0, the default) sweeps everything idle, capped per tick by EARN_MAX_MOVE_USDG6', () => {
  const k = renderedKnobs({ EARN_MAX_MOVE_USDG6: String(USDG(4_000)) });
  assert.equal(k.bufferUsdg6, 0n);
  assert.equal(k.bufferBps, 0);
  assert.deepEqual(planVenue(state({ wallet: USDG(10_000) }), k).moves, [{ kind: 'sweep', amount: USDG(4_000) }]);
});

test('processQueue and skim are the cranker\'s: an open queue sends only the pull, a flat idle vault never a skim', () => {
  const k = renderedKnobs({});
  const queued = planVenue(state({ queueHead: 3n, queueTail: 5n, wallet: USDG(10), venueWithdrawable: USDG(700) }), k);
  assert.deepEqual(queued.plan.actions.map((a) => a.kind), ['pull', 'processQueue']);
  assert.deepEqual(queued.moves, [{ kind: 'pull', amount: USDG(700), reason: 'queue' }]);
  const idle = planVenue(state({ wallet: 0n }), k);
  assert.ok(idle.plan.actions.some((a) => a.kind === 'skim'));
  assert.deepEqual(venueMoves(idle.plan), []);
});

test('keepEarn sends the plan\'s move through io.send and reports whether it confirmed; no move, no send', async () => {
  const k = renderedKnobs({ EARN_BUFFER_USDG6: String(USDG(10_000)) });
  const sends: EarnMove[] = [];
  const io = (s: EarnState, confirmed = true) => ({ read: async () => s, send: async (m: EarnMove) => (sends.push(m), confirmed) });

  const swept = await keepEarn(io(state({ wallet: USDG(12_000) })), k, null);
  assert.deepEqual(swept.sent, [{ move: { kind: 'sweep', amount: USDG(2_000) }, confirmed: true }]);
  const pulled = await keepEarn(io(state({ wallet: USDG(7_000) }), false), k, null);
  assert.deepEqual(pulled.sent, [{ move: { kind: 'pull', amount: USDG(3_000), reason: 'buffer' }, confirmed: false }]);
  const held = await keepEarn(io(state({ wallet: USDG(10_000) })), k, null);
  assert.deepEqual(held.sent, []);
  assert.equal(sends.length, 2);
});

// Payments held for claimDeferred are in the wallet but not the vault's.
test('deferred payments shrink the sweep at the rendered buffer, and deferred == idle sends nothing', async () => {
  const k = renderedKnobs({ EARN_BUFFER_USDG6: String(USDG(10_000)), EARN_DUST_USDG6: String(USDG(1)) });
  assert.deepEqual(planVenue(state({ wallet: USDG(12_000), deferred: USDG(1_000) }), k).moves, [{ kind: 'sweep', amount: USDG(1_000) }]);
  const sends: EarnMove[] = [];
  const allDeferred = await keepEarn(
    { read: async () => state({ wallet: USDG(10_000), deferred: USDG(10_000), venueWithdrawable: 0n }), send: async (m) => (sends.push(m), true) },
    renderedKnobs({}),
    null,
  );
  assert.equal(allDeferred.plan.unescrowed, 0n);
  assert.deepEqual(sends, [], 'no sweepToVenue of money owed to deferred receivers (it would revert BadUnits every tick)');
});

const VAULT = `0x${'ea'.repeat(20)}` as const;
const USDG_TOKEN = `0x${'c0'.repeat(20)}` as const;
type ReadClient = Parameters<typeof readEarnState>[0]['client'];
type Call = { address: string; functionName: string };
/** A multicall that answers each call from `answers` by function name; a name mapped to an Error fails that call only. */
function fakeClient(answers: Record<string, unknown>, calls: Call[][] = [], withdrawable: bigint | Error = USDG(50)): ReadClient {
  return {
    multicall: async ({ contracts, allowFailure }: { contracts: Call[]; allowFailure?: boolean }) => {
      calls.push(contracts);
      assert.equal(allowFailure, true, 'one multicall, failures reported per call');
      return contracts.map((c) => {
        const a = answers[c.functionName];
        return a instanceof Error ? { status: 'failure', error: a } : { status: 'success', result: a };
      });
    },
    readContract: async () => {
      if (withdrawable instanceof Error) throw withdrawable;
      return withdrawable;
    },
  } as unknown as ReadClient;
}
const LIVE = {
  adapter: '0x00000000000000000000000000000000000000ad',
  hasOpenPosition: false,
  queue: [1n, 0n],
  balanceOf: USDG(5_000),
  escrowedAssets: USDG(1_000),
  totalAssets: USDG(4_000),
  deferredAssets: USDG(1_500),
  convertToAssets: 1n,
};
/** What EarnVault.convertToAssets reverts with while its venue cannot be read, as viem decodes it. */
const revertWith = (errorName: 'VenueUnreadable' | 'PositionOpen') =>
  new ContractFunctionRevertedError({ abi: earnVaultAbi, data: encodeErrorResult({ abi: earnVaultAbi, errorName }), functionName: 'convertToAssets' });
const read = (client: ReadClient) => readEarnState({ client, vault: VAULT, usdg: USDG_TOKEN, now: 1_800_000_000, lastSkimAt: null });

test('readEarnState reads deferredAssets() in the SAME multicall as the wallet it is subtracted from', async () => {
  const calls: Call[][] = [];
  const s = await read(fakeClient(LIVE, calls));
  assert.equal(calls.length, 1, 'one multicall: one block for the wallet, escrow and deferred');
  assert.ok(calls[0]!.some((c) => c.functionName === 'deferredAssets' && c.address === VAULT), 'deferredAssets() on the vault');
  assert.equal(s.deferred, USDG(1_500));
  assert.equal(s.escrowed, USDG(1_000));
  assert.equal(planVenue(s, renderedKnobs({})).plan.unescrowed, USDG(2_500));
});

test('a failed deferredAssets() read is null, never 0: the tick skips and sends nothing', async () => {
  const s = await read(fakeClient({ ...LIVE, deferredAssets: new Error('execution reverted') }));
  assert.equal(s.deferred, null);
  const result = await keepEarn({ read: async () => s, send: async () => assert.fail('an unknown deferred figure sends nothing') }, renderedKnobs({}), null);
  assert.equal(result.plan.skipped, 'deferred-unreadable');
  assert.deepEqual(result.sent, []);
});

test('a failed REQUIRED read still fails the whole read, naming it (the mm bot pages v2_mm_vault_unreadable)', async () => {
  await assert.rejects(read(fakeClient({ ...LIVE, escrowedAssets: new Error('execution reverted') })), /escrowedAssets\(\) read failed/);
  await assert.rejects(read(fakeClient({ ...LIVE, balanceOf: new Error('rpc down') })), /balanceOf\(\) read failed/);
});

test('the queue watch: empty clears it, a standing head accumulates on the head clock, a moved head restarts it', async () => {
  const k = renderedKnobs({});
  const t0 = 1_800_000_000;
  assert.equal(watchQueue({ head: 3n, since: t0 }, { queueHead: 6n, queueTail: 5n, now: t0 + 10 }), null, 'empty');

  const run = (head: bigint, now: number, prev: Parameters<typeof keepEarn>[2]) =>
    keepEarn({ read: async () => state({ queueHead: head, queueTail: 9n, hasOpenPosition: true, now }), send: async () => assert.fail('an open position sends nothing') }, k, prev);
  const a = await run(3n, t0, null);
  assert.deepEqual(a.watch, { head: 3n, since: t0 });
  assert.equal(a.stuckForS, 0);
  const b = await run(3n, t0 + 3_600, a.watch);
  assert.equal(b.stuckForS, 3_600);
  const c = await run(4n, t0 + 3_700, b.watch);
  assert.deepEqual(c.watch, { head: 4n, since: t0 + 3_700 });
  assert.equal(c.stuckForS, 0);
});

test('the stuck page names what holds the queue', () => {
  const k = renderedKnobs({});
  const why = (s: EarnState) => stuckReason(s, planVenue(s, k).plan);
  const q = { queueHead: 2n, queueTail: 4n };
  assert.match(why(state({ ...q, adapter: null })), /no venue adapter/);
  assert.match(why(state({ ...q, hasOpenPosition: true })), /holds a position/);
  assert.match(why(state({ ...q, venueWithdrawable: 0n })), /nothing withdrawable/);
  // Without the venue-unreadable reason this would read "still has USDG to pull", sending ops the wrong way.
  assert.match(why(state({ ...q, venueUnreadable: true, venueWithdrawable: USDG(700) })), /venue adapter cannot be read.*writes it off with setAdapter/);
  assert.match(why(state({ ...q })), /still has USDG to pull/);
});

test('readEarnState reads the vault\'s VenueUnreadable refusal in the same multicall, and the tick sends nothing', async () => {
  const calls: Call[][] = [];
  const s = await read(fakeClient({ ...LIVE, convertToAssets: revertWith('VenueUnreadable') }, calls, new Error('adapter reverts')));
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.some((c) => c.functionName === 'convertToAssets' && c.address === VAULT), 'the vault is asked, in the same block');
  assert.equal(s.venueUnreadable, true);
  assert.equal(s.venueWithdrawable, 0n, 'an adapter that cannot answer withdrawable() does not fail the read then');
  const result = await keepEarn({ read: async () => s, send: async () => assert.fail('nothing is moved in or out of an unreadable venue') }, renderedKnobs({}), null);
  assert.equal(result.plan.skipped, 'venue-unreadable');
  assert.deepEqual(result.sent, []);
});

test('a priced vault and an open position both read as not unreadable; a failed withdrawable() on a readable venue still fails the read', async () => {
  assert.equal((await read(fakeClient(LIVE))).venueUnreadable, false);
  assert.equal((await read(fakeClient({ ...LIVE, hasOpenPosition: true, convertToAssets: revertWith('PositionOpen') }))).venueUnreadable, false);
  await assert.rejects(read(fakeClient(LIVE, [], new Error('adapter reverts'))), /adapter reverts/);
  await assert.rejects(read(fakeClient({ ...LIVE, convertToAssets: new Error('rpc down') })), /convertToAssets\(1\) failed and did not say why/);
});
