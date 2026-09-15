/**
 * The Idle tick's three decisions that the fork dry run found or nearly found wrong, pinned
 * without a chain.
 *
 * WHY THIS FILE EXISTS:
 *   1. `settleQueue` moves collateral into the reserve, and the week is sized on `totalAssets()`.
 *      An Idle tick that settled the queue and then planned the arm from the snapshot it took
 *      BEFORE the settlement sized capacity on redeemers' collateral; with everything queued it
 *      would have armed a cycle with nothing left to list. The tick must re-read the vault
 *      after a settlement and plan from that.
 *   2. `phase_stuck` is a `block.timestamp` fact (the vault's own `GuardianTooEarly` is), and every
 *      other decision in roll.ts binds to the head block's clock. It was judged on the wall
 *      clock, which a lagging RPC or a warped fork does not share with the chain: the dry run
 *      warps a week in seconds and the wall clock never gets there.
 *   3. A stranded claim: the keeper must not even simulate `rollOpen` (it would revert
 *      `StillStranded`), must page `claim_stranded` once, must try `retryStrandedClaim` on its
 *      timer and report a `StillStranded` answer as `strand_retry_failed` rather than a
 *      `tx_revert`, and must close the row out as `strand_recovered` when the retry lands.
 *
 * HOW: the same technique as roll.close.test.ts. The keeper's own client methods are replaced
 * for each test and restored after; the RPC in the environment is a discard port. ALERT_WEBHOOK
 * is unset, so alerts land in the SQLite `alerts` table and are read back from there.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';

/* ---- environment first: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-roll-idle-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';
process.env.KEEPER_RETRY_STRANDED_MS = '1000';
delete process.env.ALERT_WEBHOOK;

const { ContractFunctionRevertedError, encodeAbiParameters, encodeErrorResult, encodeEventTopics } = await import('viem');
const { vaultAbi } = await import('./abi.js');
const { logClient, publicClient, walletClient } = await import('./clients.js');
const { config } = await import('./config.js');
const { tick } = await import('./roll.js');
const { store } = await import('./state.js');

const LOT = 1_000_000_000_000_000_000n;
const ZERO32 = `0x${'00'.repeat(32)}` as const;
const OPTION_ID = 0xabcdefn << 96n;
const CLAIM_KEY = OPTION_ID | 1n;

interface ReadCall {
  address: string;
  functionName: string;
  args?: readonly unknown[];
}

interface LogQuery {
  event: { name: string };
}

/** Every read a tick makes, for an Idle vault with `queued` shares waiting and `assets` behind them. */
function idleReads(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    phase: 0,
    writesHalted: false,
    valoremFeeAccepted: false,
    cycleNumber: 0,
    cycleExerciseTs: 0n,
    cycleExpiryTs: 0n,
    cycleStrikeUsdg: 0n,
    optionId: 0n,
    claimKey: 0n,
    contractsWritten: 0n,
    listingHash: ZERO32,
    listingGrossUsdg: 0n,
    listingAmount: 0n,
    listingsThisCycle: 0,
    idleAssets: 25n * LOT,
    totalAssets: 25n * LOT,
    lockedAssets: 0n,
    isStranded: false,
    strandGen: 0n,
    queuedShares: 0n,
    KEEPER_ROLE: ZERO32,
    policy: [300, 1200, 40, 9500, 500, 50n],
    spotUsdg: 218_297_934n,
    feesEnabled: false,
    feeBps: 15,
    hasRole: true,
    oraclePaused: false,
    ...overrides,
  };
}

function encodedLog(eventName: 'QueueSettled' | 'StrandedClaimRecovered' | 'Harvest', indexed: Record<string, unknown>, data: bigint[]) {
  const topics = encodeEventTopics({ abi: vaultAbi, eventName, args: indexed } as never) as string[];
  return {
    address: config.VAULT,
    topics,
    data: encodeAbiParameters(data.map(() => ({ type: 'uint256' })), data),
    blockNumber: 1_000n,
    transactionHash: `0x${'ab'.repeat(32)}`,
    logIndex: 0,
  };
}

/** The kinds recorded after `sinceId`, in insertion order. By id, not `created_at`: two alerts
 *  from one tick land in the same millisecond. */
function alertKinds(sinceId: number): string[] {
  return (store.db.prepare('SELECT kind FROM alerts WHERE id > ? ORDER BY id').all(sinceId) as Array<{ kind: string }>).map((a) => a.kind);
}

function lastAlertId(): number {
  return (store.db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM alerts').get() as { n: number }).n;
}

test('an Idle tick that settles the queue re-reads the vault before it plans the week', async () => {
  const reads = idleReads({ queuedShares: 25n * LOT });
  const now = BigInt(Math.floor(Date.now() / 1000));
  const settleTx = `0x${'51'.repeat(32)}` as const;
  const simulated: string[] = [];
  const totalAssetsReads: bigint[] = [];
  const mocks = [
    mock.method(publicClient, 'readContract', async (call: ReadCall) => {
      if (!(call.functionName in reads)) throw new Error(`unstubbed read ${call.functionName}`);
      if (call.functionName === 'totalAssets') totalAssetsReads.push(reads.totalAssets as bigint);
      return reads[call.functionName];
    }),
    mock.method(publicClient, 'getBlock', async () => ({ number: 1_001n, timestamp: now })),
    mock.method(publicClient, 'getBalance', async () => 10n ** 18n),
    mock.method(publicClient, 'simulateContract', async (call: ReadCall) => {
      simulated.push(call.functionName);
      return { request: call };
    }),
    mock.method(walletClient, 'writeContract', async () => {
      // The settlement lands: every share was queued, so the whole balance is now reserved
      // for the epoch and nothing backs a new cycle.
      reads.queuedShares = 0n;
      reads.totalAssets = 0n;
      reads.idleAssets = 0n;
      return settleTx;
    }),
    mock.method(publicClient, 'waitForTransactionReceipt', async () => ({
      status: 'success',
      blockNumber: 1_000n,
      gasUsed: 90_000n,
      transactionHash: settleTx,
      logs: [encodedLog('QueueSettled', { epochId: 1n }, [25n * LOT, 25n * LOT, 0n])],
    })),
  ];
  const alertsBefore = lastAlertId();
  try {
    await tick();
  } finally {
    for (const m of mocks) m.mock.restore();
  }

  assert.deepEqual(simulated, ['settleQueue'], 'settleQueue was the only transaction: no newOptionType, no rollOpen');
  assert.deepEqual(totalAssetsReads, [25n * LOT, 0n], 'the vault was read again after the settlement, and the plan saw the reserve');
  assert.equal(store.getTx(settleTx)?.status, 'success');
  assert.deepEqual(alertKinds(alertsBefore), ['queue_settled']);
  const skip = store.db.prepare("SELECT value FROM meta WHERE key LIKE 'skip_reason:%'").all() as Array<{ value: string }>;
  assert.deepEqual(
    skip.map((s) => s.value),
    ['no-capacity'],
    'the week was declined on the fresh snapshot (nothing to write), not armed on the stale one',
  );
});

test('phase_stuck is judged on the head block clock, not the wall clock', async () => {
  // The chain is a month ahead of this machine (a warped fork, or a wall clock that is wrong):
  // the vault is Exercisable more than an hour past expiry BY THE CHAIN'S CLOCK, and the wall
  // clock would say the expiry is still weeks away.
  const blockNow = BigInt(Math.floor(Date.now() / 1000)) + 30n * 86_400n;
  const run = async (expiry: bigint): Promise<string[]> => {
    const reads = idleReads({
      phase: 2,
      cycleNumber: 4,
      cycleExerciseTs: expiry - 86_400n,
      cycleExpiryTs: expiry,
      optionId: OPTION_ID,
      claimKey: CLAIM_KEY,
      contractsWritten: 3n,
      lockedAssets: 3n * LOT,
      claim: { amountWritten: 3n * LOT, amountExercised: 0n, optionId: OPTION_ID },
    });
    const mocks = [
      mock.method(publicClient, 'readContract', async (call: ReadCall) => {
        if (!(call.functionName in reads)) throw new Error(`unstubbed read ${call.functionName}`);
        return reads[call.functionName];
      }),
      mock.method(publicClient, 'getBlock', async () => ({ number: 1_001n, timestamp: blockNow })),
      mock.method(publicClient, 'getBalance', async () => 10n ** 18n),
      // The close itself is refused, so the tick ends with the vault still Exercisable and the
      // only question is whether the stuck alert was raised.
      mock.method(publicClient, 'simulateContract', async () => {
        throw new Error('rollClose refused for this test');
      }),
    ];
    const before = lastAlertId();
    try {
      await tick();
    } finally {
      for (const m of mocks) m.mock.restore();
    }
    return alertKinds(before);
  };

  assert.deepEqual(await run(blockNow - 3_601n), ['phase_stuck', 'tx_revert'], 'an hour and a second past expiry on the chain: stuck');
  // A second before the guardian hour: not stuck. (The refused close's tx_revert is inside its
  // own cooldown from the run above, so it is not recorded a second time.)
  assert.deepEqual(await run(blockNow - 3_599n), []);
});

test('stranded: no arm is attempted, claim_stranded pages once, the retry reports StillStranded as strand_retry_failed, and its success closes the row', async () => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const expiry = now - 7_200n;
  const reads = idleReads({
    cycleNumber: 3,
    cycleExerciseTs: expiry - 86_400n,
    cycleExpiryTs: expiry,
    optionId: OPTION_ID,
    claimKey: CLAIM_KEY,
    contractsWritten: 2n,
    idleAssets: 23n * LOT,
    totalAssets: 24n * LOT,
    lockedAssets: LOT,
    isStranded: true,
    strandGen: 1n,
  });
  // The stranded close was witnessed by this keeper: the row says so, and its close tx is on file.
  store.ensureCycle(3, 'stranded');
  store.updateCycle(3, { option_id: OPTION_ID.toString(), strike_usdg6: '229000000', contracts: 2, roll_close_tx: `0x${'c3'.repeat(32)}`, strand_gen: '1' });
  store.recordTxSubmitted(`0x${'0e'.repeat(32)}`, 'rollOpen', 3);
  store.recordTxResult(`0x${'0e'.repeat(32)}`, 'success', 900n, 1n, null);

  const stillStranded = new ContractFunctionRevertedError({
    abi: vaultAbi,
    data: encodeErrorResult({ abi: vaultAbi, errorName: 'StillStranded', args: [] }),
    functionName: 'retryStrandedClaim',
  });
  let retryAnswer: 'reverts' | 'lands' = 'reverts';
  const retryTx = `0x${'ee'.repeat(32)}` as const;
  const simulated: string[] = [];
  const mocks = [
    mock.method(publicClient, 'readContract', async (call: ReadCall) => {
      if (!(call.functionName in reads)) throw new Error(`unstubbed read ${call.functionName}`);
      return reads[call.functionName];
    }),
    mock.method(publicClient, 'getBlock', async () => ({ number: 1_001n, timestamp: now })),
    mock.method(publicClient, 'getBalance', async () => 10n ** 18n),
    mock.method(publicClient, 'simulateContract', async (call: ReadCall) => {
      simulated.push(call.functionName);
      if (call.functionName !== 'retryStrandedClaim') throw new Error(`the keeper must not simulate ${call.functionName} while stranded`);
      if (retryAnswer === 'reverts') throw stillStranded;
      return { request: call };
    }),
    mock.method(walletClient, 'writeContract', async () => {
      reads.isStranded = false;
      reads.claimKey = 0n;
      reads.contractsWritten = 0n;
      reads.lockedAssets = 0n;
      return retryTx;
    }),
    mock.method(publicClient, 'waitForTransactionReceipt', async () => ({
      status: 'success',
      blockNumber: 1_000n,
      gasUsed: 200_000n,
      transactionHash: retryTx,
      logs: [
        encodedLog('StrandedClaimRecovered', { gen: 1n }, [LOT, 229_000_000n, 0n]),
        encodedLog('Harvest', { cycleNumber: 3 }, [229_000_000n, 0n, 229_000_000n]),
      ],
    })),
    mock.method(logClient, 'getLogs', async (query: LogQuery) => {
      if (query.event.name === 'Harvest') {
        // The stranded close's own harvest (the premium) plus the retry's (the strike leg).
        return [
          { blockNumber: 950n, transactionHash: `0x${'c3'.repeat(32)}`, args: { cycleNumber: 3, grossUsdg: 4_000_000n, feeUsdg: 200_000n, netUsdg: 3_800_000n } },
          { blockNumber: 1_000n, transactionHash: retryTx, args: { cycleNumber: 3, grossUsdg: 229_000_000n, feeUsdg: 0n, netUsdg: 229_000_000n } },
        ];
      }
      throw new Error(`unstubbed getLogs ${query.event.name}`);
    }),
  ];
  try {
    /* ---- tick 1: the freeze holds ---- */
    let before = lastAlertId();
    await tick();
    assert.deepEqual(simulated, ['retryStrandedClaim'], 'the only simulation is the retry: rollOpen is never even tried');
    assert.deepEqual(alertKinds(before), ['claim_stranded', 'strand_retry_failed'], 'StillStranded is not a tx_revert page');
    const failed = store.db.prepare('SELECT kind, message FROM alerts ORDER BY id DESC LIMIT 1').get() as { kind: string; message: string };
    assert.equal(failed.kind, 'strand_retry_failed');
    assert.match(failed.message, /StillStranded/, 'the retry alert names the hook answer, not a generic revert');

    /* ---- tick 2: inside the retry timer, nothing is simulated and nothing pages again ---- */
    before = lastAlertId();
    await tick();
    assert.deepEqual(simulated, ['retryStrandedClaim'], 'no second simulation inside KEEPER_RETRY_STRANDED_MS');
    assert.deepEqual(alertKinds(before), [], 'claim_stranded pages once per generation');

    /* ---- tick 3: the timer elapsed and the freeze lifted ---- */
    store.setMeta('strand_retry_ms', '0');
    retryAnswer = 'lands';
    before = lastAlertId();
    await tick();
    assert.deepEqual(simulated, ['retryStrandedClaim', 'retryStrandedClaim']);
    assert.equal(store.getTx(retryTx)?.status, 'success');
    const row = store.getCycle(3);
    assert.ok(row);
    assert.equal(row.status, 'closed', 'recovered: the stranded row is closed');
    assert.equal(row.retry_tx, retryTx);
    assert.equal(row.strand_gen, '1');
    assert.equal(row.gross_usdg6, '233000000', 'the cycle sum: the close’s premium harvest plus the retry’s strike leg');
    assert.equal(row.fee_usdg6, '200000', 'the fee was charged on the premium only');
    assert.equal(row.net_usdg6, '232800000');
    assert.equal(row.assets_returned, LOT.toString(), 'StrandedClaimRecovered.assets');
    assert.equal(row.usdg_from_assignment, '229000000', 'StrandedClaimRecovered.usdgOut');
    const kinds = alertKinds(before);
    assert.equal(kinds[0], 'strand_recovered', 'the recovery is announced first');
    assert.ok(!simulated.includes('rollOpen') && !simulated.includes('newOptionType'), 'the arm waits for the next tick’s fresh snapshot');
  } finally {
    for (const m of mocks) m.mock.restore();
  }
});
