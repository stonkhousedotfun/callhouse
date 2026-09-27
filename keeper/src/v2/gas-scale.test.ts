/**
 * CRANKER_GAS_SCALE_PCT scales every
 * fixed gas limit a keeper process sends with, in one place: tx.ts TxSender.executeNow (and the cranker's dry-run
 * sender, which judges at the same limit). Covered here: the arithmetic (rounded up, capped, never lowered), every real
 * limit at 150 and 300, the cap pinned to the cranker's own chain cap, what the sender actually simulates and sends,
 * and the config: default 100, 150 parsed, 99 and 301 refused by name, in the cranker and the MM bot.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Address, Hash } from 'viem';
import { clearinghouseAbi } from './abi/clearinghouse.js';
import { V2ConfigError, loadV2Config, type CrankerConfig, type MmConfig } from './config.js';
import { GAS } from './cranker/constants.js';
import { drySender } from './cranker/effects.js';
import {
  CHAIN_MAX_TX_GAS,
  EARN_PROCESS_QUEUE_GAS_BASE,
  EARN_PROCESS_QUEUE_GAS_PER_ENTRY,
  EARN_PROCESS_QUEUE_MAX_ENTRIES,
  EARN_SKIM_GAS,
  HOUSE_ROLL_GAS_HEADROOM,
  earnProcessQueueGas,
  houseRollGas,
} from './cranker/steps.js';
import { silentLogger } from './logger.js';
import { MM_GAS } from './mm/constants.js';
import { GAS_REPRICE } from './pricer/pricer.js';
import { V2Store } from './store.js';
import {
  GAS_SCALE_CAP,
  GAS_SCALE_PCT_DEFAULT,
  GAS_SCALE_PCT_MAX,
  GAS_SCALE_PCT_MIN,
  TxSender,
  scaleGas,
  type TxChain,
  type TxReceiptSummary,
  type WriteCall,
} from './tx.js';

const CH: Address = '0x00000000000000000000000000000000000000C1';
const settle = (gas?: bigint) => ({ address: CH, abi: clearinghouseAbi, functionName: 'settle', args: [7n], ...(gas === undefined ? {} : { gas }) }) as const;

test('scaleGas: 100 leaves a limit as written; above 100 it is rounded up, capped at GAS_SCALE_CAP, and never lowered', () => {
  assert.equal(scaleGas(1_500_000n, 100), 1_500_000n);
  assert.equal(scaleGas(800_000n, 150), 1_200_000n);
  assert.equal(scaleGas(1_000_001n, 150), 1_500_002n, '1,500,001.5 rounds UP: a scaled limit is never short by a rounding');
  assert.equal(scaleGas(2_000_000n, 300), 6_000_000n);
  assert.equal(scaleGas(25_000_000n, 150), GAS_SCALE_CAP, '37.5M is capped');
  assert.equal(scaleGas(31_000_000n, 150), 31_000_000n, 'a limit the code already set above the cap is left as it is, never lowered');
  assert.equal(scaleGas(29_000_000n, 300, 30_000_000n), 30_000_000n);
});

test('GAS_SCALE_CAP is the cranker\'s own per-transaction ceiling: CHAIN_MAX_TX_GAS less HOUSE_ROLL_GAS_HEADROOM', () => {
  assert.equal(GAS_SCALE_CAP, CHAIN_MAX_TX_GAS - HOUSE_ROLL_GAS_HEADROOM);
  assert.ok(GAS_SCALE_CAP < CHAIN_MAX_TX_GAS, 'a scaled send can never exceed the chain\'s cap, where it would not be included at all');
});

test('every fixed limit the cranker, the MM bot and the pricer send is scaled at 150 and at 300, and never past the cap', () => {
  const limits: Array<[string, bigint]> = [
    ...Object.entries(GAS).map(([k, v]): [string, bigint] => [`GAS.${k}`, v]),
    ...Object.entries(MM_GAS).map(([k, v]): [string, bigint] => [`MM_GAS.${k}`, v]),
    ['EARN_PROCESS_QUEUE_GAS_BASE', EARN_PROCESS_QUEUE_GAS_BASE],
    ['EARN_PROCESS_QUEUE_GAS_PER_ENTRY', EARN_PROCESS_QUEUE_GAS_PER_ENTRY],
    ['earnProcessQueueGas(max entries)', earnProcessQueueGas(EARN_PROCESS_QUEUE_MAX_ENTRIES)],
    ['EARN_SKIM_GAS', EARN_SKIM_GAS],
    // (merge): the roll also pins the next boundary; null = an unread source count, the largest pin.
    ['houseRollGas([], null)', houseRollGas([], null)],
    ['GAS_REPRICE', GAS_REPRICE],
  ];
  // 22 GAS + 11 MM_GAS + 6 others (the audit table). A new limit changes the count: add it here and to the table.
  // A change corrects that table: EARN_SKIM_GAS was recorded not SHORT. It was under starvedCeiling(VENUE_PULL_GAS).
  // The row is the same one; the value is now the ceiling plus the 3.5M measured budget, not 3.5M.
  assert.equal(limits.length, 39, `the sweep covers every limit (${limits.map(([n]) => n).join(', ')})`);
  for (const [name, v] of limits) {
    for (const pct of [150, 300]) {
      const want = (v * BigInt(pct) + 99n) / 100n;
      const got = scaleGas(v, pct);
      assert.equal(got, want < GAS_SCALE_CAP ? want : v > GAS_SCALE_CAP ? v : GAS_SCALE_CAP, `${name} at ${pct}`);
      assert.ok(got >= v, `${name} at ${pct} is never lowered`);
      assert.ok(got <= (v > GAS_SCALE_CAP ? v : GAS_SCALE_CAP), `${name} at ${pct} stays under the cap`);
    }
  }
});

/** A chain that records the gas each simulation was asked for and returns it in the request it would broadcast. */
class GasChain implements TxChain {
  readonly account: Address = '0x000000000000000000000000000000000000bEEF';
  simulated: Array<bigint | undefined> = [];
  broadcasts: unknown[] = [];
  async simulate(call: WriteCall) {
    this.simulated.push(call.gas);
    return { result: true, request: { gas: call.gas } };
  }
  async broadcast(request: unknown): Promise<Hash> {
    this.broadcasts.push(request);
    return `0x${'11'.repeat(32)}` as Hash;
  }
  async pendingNonce() {
    return 0;
  }
  async minedNonce() {
    return 0;
  }
  async waitForReceipt(): Promise<TxReceiptSummary> {
    return { status: 'success', blockNumber: 1n, gasUsed: 21_000n };
  }
  async getReceipt() {
    return null;
  }
}

const sender = (chain: GasChain, gasScalePct?: number) =>
  new TxSender({ chain, store: new V2Store(':memory:'), log: silentLogger(), txTimeoutMs: 30_000, ...(gasScalePct === undefined ? {} : { gasScalePct }) });

test('TxSender simulates AND sends a fixed limit at CRANKER_GAS_SCALE_PCT of itself; default 100 and an estimated call are untouched', async () => {
  const scaled = new GasChain();
  await sender(scaled, 150).execute(settle(GAS.settle), { kind: 'settle', key: '7' });
  assert.deepEqual(scaled.simulated, [2_250_000n], 'GAS.settle 1.5M simulated at 2.25M');
  assert.deepEqual(scaled.broadcasts, [{ gas: 2_250_000n }], 'and sent at the simulated limit');

  const plain = new GasChain();
  await sender(plain).execute(settle(GAS.settle), { kind: 'settle', key: '8' });
  assert.deepEqual(plain.simulated, [GAS.settle], 'no setting: the limit as written');

  const estimated = new GasChain();
  await sender(estimated, 300).execute(settle(), { kind: 'settle', key: '9' });
  assert.deepEqual(estimated.simulated, [undefined], 'a call without a fixed limit is left to the node, not given one');

  const capped = new GasChain();
  await sender(capped, 300).execute(settle(20_000_000n), { kind: 'settle', key: '10' });
  assert.deepEqual(capped.simulated, [GAS_SCALE_CAP], '60M is capped at 30M');
});

test('the dry-run sender judges at the same scaled limit a live send would use', async () => {
  const seen: bigint[] = [];
  const client = { simulateContract: async (args: { gas: bigint }) => (seen.push(args.gas), { result: true }) };
  await drySender(client as never, '0x000000000000000000000000000000000000bEEF', 150).execute(settle(GAS.finalize) as never, { kind: 'finalize', key: 'x' });
  await drySender(client as never, '0x000000000000000000000000000000000000bEEF').execute(settle(GAS.finalize) as never, { kind: 'finalize', key: 'y' });
  assert.deepEqual(seen, [2_250_000n, GAS.finalize]);
});

/*//////////////////////////////////////////////////////////////
                              CONFIG
//////////////////////////////////////////////////////////////*/

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const UNSET = join(FIXTURES, 'registry-v2-unset.json');
const DEPLOYED = join(FIXTURES, 'registry-v2.json');
const KEY = `0x${'2b'.repeat(32)}`;
const RPC = 'http://127.0.0.1:9';
const CRANKER = {
  V2_MODE: 'cranker',
  RH_RPC: RPC,
  CRANKER_PK: KEY,
  V2_REGISTRY_PATH: UNSET,
  V2_CLEARINGHOUSE: '0x00000000000000000000000000000000000000c1',
  V2_ORDER_BOOK: '0x00000000000000000000000000000000000000c2',
  V2_SETTLEMENT_ORACLE: '0x00000000000000000000000000000000000000c3',
  V2_EXPIRY_CALENDAR: '0x00000000000000000000000000000000000000c4',
};
const MM = { V2_MODE: 'mm', RH_RPC: RPC, MM_QUOTER_PK: KEY, PRICING_URL: 'http://127.0.0.1:8790', MM_KILL_TOKEN: 'f0'.repeat(32), V2_REGISTRY_PATH: DEPLOYED };

function refusal(env: NodeJS.ProcessEnv): string {
  try {
    loadV2Config(env);
  } catch (error) {
    assert.ok(error instanceof V2ConfigError, `expected V2ConfigError, got ${String(error)}`);
    return error.message;
  }
  assert.fail('the configuration was accepted');
}

test('CRANKER_GAS_SCALE_PCT: default 100, 150 parsed, the bounds tx.ts scales with (100..300), 99 and 301 refused by name', () => {
  assert.deepEqual([GAS_SCALE_PCT_DEFAULT, GAS_SCALE_PCT_MIN, GAS_SCALE_PCT_MAX], [100, 100, 300]);
  assert.equal((loadV2Config(CRANKER) as CrankerConfig).gasScalePct, GAS_SCALE_PCT_DEFAULT, 'unset: the limits as written');
  assert.equal((loadV2Config({ ...CRANKER, CRANKER_GAS_SCALE_PCT: '150' }) as CrankerConfig).gasScalePct, 150);
  assert.equal((loadV2Config({ ...CRANKER, CRANKER_GAS_SCALE_PCT: String(GAS_SCALE_PCT_MIN) }) as CrankerConfig).gasScalePct, GAS_SCALE_PCT_MIN);
  assert.equal((loadV2Config({ ...CRANKER, CRANKER_GAS_SCALE_PCT: String(GAS_SCALE_PCT_MAX) }) as CrankerConfig).gasScalePct, GAS_SCALE_PCT_MAX);
  assert.match(refusal({ ...CRANKER, CRANKER_GAS_SCALE_PCT: String(GAS_SCALE_PCT_MIN - 1) }), /CRANKER_GAS_SCALE_PCT: Number must be greater than or equal to 100/);
  assert.match(refusal({ ...CRANKER, CRANKER_GAS_SCALE_PCT: String(GAS_SCALE_PCT_MAX + 1) }), /CRANKER_GAS_SCALE_PCT: Number must be less than or equal to 300/);
  assert.match(refusal({ ...CRANKER, CRANKER_GAS_SCALE_PCT: '1.5' }), /CRANKER_GAS_SCALE_PCT/);
});

test('CRANKER_GAS_SCALE_PCT reaches the MM bot too (one TxSender per process), with the same refusal', () => {
  assert.equal((loadV2Config(MM) as MmConfig).gasScalePct, 100);
  assert.equal((loadV2Config({ ...MM, CRANKER_GAS_SCALE_PCT: '200' }) as MmConfig).gasScalePct, 200);
  assert.match(refusal({ ...MM, CRANKER_GAS_SCALE_PCT: '301' }), /CRANKER_GAS_SCALE_PCT: Number must be less than or equal to 300/);
});
