/**
 * The SEND-TIME recheck of a House vault's reserved USDG in MmBot.execute().
 *
 * The plan budgets bids from wallet + live escrow - reserve, assuming every live bid's escrow comes back first. A cancel
 * of a Bid that filled after the tick's read returns nothing and does not revert (OrderBook.sol:316-317), so before
 * each bid-growing tx on a House vault execute() reads the wallet and the reserve again, at a fresh block, and sends
 * only if the tx's USDG fits in max(0, wallet - reserve). Driven through the same private `execute` seam as
 * quoter.test.ts's protocol-cross test, with a fake multicall and a sender that records every call.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Address } from 'viem';
import { loadV2Config, type MmConfig } from '../config.js';
import { silentLogger } from '../logger.js';
import { V2Store } from '../store.js';
import type { TxOutcome } from '../tx.js';
import { KIND_INDEX } from './constants.js';
import { MmBot, type VaultTarget } from './quoter.js';
import type { TickPlan } from './planner.js';
import type { MmAddresses } from './reads.js';

const REGISTRY = fileURLToPath(new URL('../fixtures/registry-v2.json', import.meta.url));
const env = { V2_MODE: 'mm', RH_RPC: 'http://127.0.0.1:9', MM_QUOTER_PK: `0x${'11'.repeat(32)}`, PRICING_URL: 'http://127.0.0.1:8790', MM_KILL_TOKEN: 'k'.repeat(32), V2_REGISTRY_PATH: REGISTRY };

const USDG = 1_000_000n;
/** The live Bid's escrow and the new Bid's escrow: 3,000 units at 1.00 a share = 30 USDG. */
const E = 30n * USDG;
const UNTIL = 1_790_020_800;
const FRESH_BLOCK = 65_300_000n;
const TICK_BLOCK = 65_200_000n;

/** Cancel the live Bid 5 (escrow E), then place a Bid of escrow E: the plan's own "the escrow comes back" assumption. */
const PLAN = {
  series: [{ longId: 0n, prices: null, live: [{ id: 5n, kind: 'Bid', price: USDG, remaining: 3_000n, validUntil: UNTIL }] }],
  txs: [
    { type: 'cancel', orderIds: [5n], longIds: [0n], reason: 'requote' },
    { type: 'place', longId: 0n, slot: 'bid', kind: KIND_INDEX.Bid, price: USDG, units: 3_000n, validUntil: UNTIL, reason: 'no live bid' },
  ],
} as unknown as TickPlan;

interface Run {
  sent: string[];
  reads: Array<{ functionName: string; blockNumber: bigint | undefined }>;
  alerts: Array<{ kind: string; data: Record<string, unknown> }>;
}

/** `reserved` is split across pendingDepositUsdg and owedUsdg; `feeOwed` is HouseVault.performanceFeeOwed (default 0). */
async function run(kind: VaultTarget['kind'], answer: { wallet: bigint; reserved: bigint; feeOwed?: bigint } | 'fail'): Promise<Run> {
  const config = loadV2Config(env) as MmConfig;
  const vault = config.contracts.makerVault as Address;
  const out: Run = { sent: [], reads: [], alerts: [] };
  const instance = new MmBot({
    config,
    log: silentLogger(),
    client: {
      getBlockNumber: async () => FRESH_BLOCK,
      multicall: async ({ contracts, blockNumber }: { contracts: ReadonlyArray<{ functionName: string }>; blockNumber?: bigint }) =>
        contracts.map((c) => {
          out.reads.push({ functionName: c.functionName, blockNumber });
          if (answer === 'fail' && c.functionName === 'owedUsdg') return { status: 'failure', error: new Error('execution reverted') };
          const a = answer === 'fail' ? { wallet: 100n * USDG, reserved: 0n, feeOwed: 0n } : answer;
          // The reserve is split across the views so a recheck that reads only some of them under-counts.
          const value = {
            balanceOf: a.wallet,
            pendingDepositUsdg: a.reserved / 2n,
            owedUsdg: a.reserved - a.reserved / 2n,
            performanceFeeOwed: a.feeOwed ?? 0n,
          }[c.functionName];
          return value === undefined ? { status: 'failure', error: new Error(`no view ${c.functionName}`) } : { status: 'success', result: value };
        }),
    } as never,
    logClient: {} as never,
    sender: {
      execute: async (call: { functionName: string }): Promise<TxOutcome> => {
        out.sent.push(call.functionName);
        return { status: 'confirmed', hash: `0x${'ab'.repeat(32)}`, nonce: 1, blockNumber: 1n, gasUsed: 1n, result: true } as unknown as TxOutcome;
      },
    } as never,
    alerter: { alert: async (k: string, _m: string, data: Record<string, unknown> = {}) => (out.alerts.push({ kind: k, data }), true), clear: () => undefined } as never,
    store: new V2Store(':memory:'),
    pricing: { fairMany: async () => [] },
    signer: '0x0000000000000000000000000000000000000001',
  });
  const seam = instance as unknown as {
    targetsByVault: Map<string, VaultTarget>;
    execute(plan: TickPlan, a: MmAddresses, head: { blockNumber: bigint; timestamp: number }): Promise<unknown>;
  };
  seam.targetsByVault.set(vault.toLowerCase(), {
    address: vault,
    kind,
    underlying: null,
    caps: { maxSeriesUnits: 0n, maxTotalNotionalUsdg6: 0n },
    epoch: kind === 'house' ? { epochEnd: UNTIL, index: 1n, rollDue: false } : null,
  } as unknown as VaultTarget);
  const a: MmAddresses = { clearinghouse: config.contracts.clearinghouse, orderBook: config.contracts.orderBook, vault, usdg: config.registry.usdg as Address, manager: config.contracts.accessManager as Address };
  await seam.execute(PLAN, a, { blockNumber: TICK_BLOCK, timestamp: UNTIL - 3_600 });
  return out;
}

const RESERVE_VIEWS = new Set(['pendingDepositUsdg', 'owedUsdg', 'performanceFeeOwed']);
const reserveReads = (r: Run) => r.reads.filter((x) => RESERVE_VIEWS.has(x.functionName));

test('(a) House: the live Bid filled first, so the cancel returned nothing: the recheck sees the UN-credited wallet and the place is withheld', async () => {
  // Wallet 40, reserve 20: unreserved 20 < E 30. Had the cancel credited E, the wallet would be 70.
  const r = await run('house', { wallet: 40n * USDG, reserved: 20n * USDG });
  assert.deepEqual(r.sent, ['cancel'], 'the cancel is sent, the place is not');
  const rejected = r.alerts.filter((x) => x.kind === 'v2_mm_tx_rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.data.revert, 'house-reserve');
  assert.equal(rejected[0]!.data.delta, E);
  assert.equal(rejected[0]!.data.unreserved, 20n * USDG);
  assert.ok(r.reads.every((x) => x.blockNumber === FRESH_BLOCK), 'read at a fresh block, never the tick head');
});

test('(b) House: the cancel credited the wallet, so the place fits in wallet - reserve and is sent', async () => {
  const r = await run('house', { wallet: 70n * USDG, reserved: 20n * USDG });
  assert.deepEqual(r.sent, ['cancel', 'place']);
  assert.equal(r.alerts.filter((x) => x.kind === 'v2_mm_tx_rejected').length, 0);
  assert.equal(reserveReads(r).length, 3, 'one recheck (three reserve views), before the place only: the cancel triggers no read');
});

test('(c) House: a failed recheck read is a refusal: the place is not sent, the cancel is', async () => {
  const r = await run('house', 'fail');
  assert.deepEqual(r.sent, ['cancel']);
  const rejected = r.alerts.filter((x) => x.kind === 'v2_mm_tx_rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.data.revert, 'house-reserve');
  assert.equal(rejected[0]!.data.unreserved, null);
});

test('(d) treasury: no reserve view is read and the place is sent, whatever a House reserve would have said', async () => {
  const r = await run('treasury', { wallet: 40n * USDG, reserved: 20n * USDG });
  assert.deepEqual(r.sent, ['cancel', 'place']);
  assert.deepEqual(reserveReads(r), []);
  assert.deepEqual(r.reads, [], 'a treasury tick issues no recheck read at all');
});

/**
 * (N1). The contract reserves pendingDepositUsdg + owedUsdg + performanceFeeOwed
 * (HouseVault._requireUnreservedSpend). Wallet 70, pending+owed 20, a carried fee of 25: unreserved is 25 < E 30, so the
 * Bid would revert InsufficientCollateral on chain. A recheck that ignored the fee would see 50 and send it.
 */
test('(e) House: a carried performance fee is reserved too, so a Bid that fits only without the fee is withheld', async () => {
  const r = await run('house', { wallet: 70n * USDG, reserved: 20n * USDG, feeOwed: 25n * USDG });
  assert.deepEqual(r.sent, ['cancel'], 'the place is withheld: it does not fit once the fee is reserved');
  const rejected = r.alerts.filter((x) => x.kind === 'v2_mm_tx_rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.data.revert, 'house-reserve');
  assert.equal(rejected[0]!.data.unreserved, 25n * USDG, 'wallet 70 - (20 + fee 25)');
  assert.ok(reserveReads(r).some((x) => x.functionName === 'performanceFeeOwed'), 'the fee is read at send time');
});

test('(f) House: the control -- the same wallet and reserve with no fee carried sends the Bid', async () => {
  const r = await run('house', { wallet: 70n * USDG, reserved: 20n * USDG, feeOwed: 0n });
  assert.deepEqual(r.sent, ['cancel', 'place']);
});
