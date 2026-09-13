/**
 * contractsAssignedAt: the keeper's pre-close read of the Valorem claim, without a chain.
 *
 * WHY THIS FILE EXISTS: roll.ts:doRollClose reads `contractsAssignedAt(snap)` BEFORE it sends
 * `rollClose`, because the transaction zeroes the vault's `claimKey` and Valorem reverts
 * `TokenNotFound` for the burned claim from then on. With the deployed bytecode the `RollClose`
 * event then wins in resolveContractsAssigned, so nothing downstream of a tick can tell whether
 * this function divides by the right scalar, reads the right contract, or turns a revert into a
 * silent 0. Those three properties are pinned here; the same function is called against the real
 * Clear before and after a real redeem in dryrun.ts cycle 3.
 *
 * It also drives BOTH close paths end to end through `tick()` (K-21): the keeper's own
 * `rollClose` (phase Exercisable past expiry) and the reconstruction of a close it never
 * witnessed (phase Idle, from RollClose/RollOpen/Harvest logs). Each must record
 * `assets_returned` and `usdg_from_assignment` on the cycle row, word the `roll_close` alert with
 * premium and strike proceeds apart, and serve the split from `GET /cycles`.
 *
 * HOW: roll.test.ts keeps to pure exports. This file needs impure ones, so it replaces the
 * keeper's own client methods — `publicClient.readContract` and friends, the very objects roll.ts
 * calls — with in-process stubs for each test and restores them after. No HTTP to a chain: the RPC
 * in the environment is a discard port, and a call that escapes the stubs fails loudly instead of
 * hanging. ALERT_WEBHOOK is unset, so alerts land in the SQLite `alerts` table and are read back.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';

/* ---- environment first: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-roll-close-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
process.env.REGISTRY = '0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';
delete process.env.ALERT_WEBHOOK;

const { encodeAbiParameters, encodeEventTopics } = await import('viem');
const { vaultAbi } = await import('./abi.js');
const { logClient, publicClient, walletClient } = await import('./clients.js');
const { config } = await import('./config.js');
const { buildApp } = await import('./health.js');
const { contractsAssignedAt, tick } = await import('./roll.js');
const { store } = await import('./state.js');
type CycleTapeRow = import('./state.js').CycleTapeRow;

const LOT = 1_000_000_000_000_000_000n;
/** A Valorem claim id: option key in the high 160 bits, claim index in the low 96. */
const CLAIM_KEY = (0xabcdefn << 96n) | 1n;
const OPTION_ID = 0xabcdefn << 96n;

interface ReadCall {
  address: string;
  functionName: string;
  args?: readonly unknown[];
}

/** Replace the keeper's readContract for one test. Returns the mock so calls can be inspected. */
function stubRead(impl: (call: ReadCall) => Promise<unknown>) {
  return mock.method(publicClient, 'readContract', (call: ReadCall) => impl(call));
}

test('contractsAssignedAt: a zero claimKey is "nothing written", answered without a read', async () => {
  const read = stubRead(async () => {
    throw new Error('must not be called');
  });
  try {
    assert.equal(await contractsAssignedAt({ vaultClaimKey: 0n }), 0n);
    assert.equal(read.mock.callCount(), 0);
  } finally {
    read.mock.restore();
  }
});

test('contractsAssignedAt: claim().amountExercised is a 1e18 scalar, divided back to a count, read from the Clear', async () => {
  const read = stubRead(async (call) => {
    assert.equal(call.address, config.CLEARINGHOUSE, 'reads the clearinghouse, not the vault');
    assert.equal(call.functionName, 'claim');
    assert.deepEqual(call.args, [CLAIM_KEY]);
    return { amountWritten: 23n * LOT, amountExercised: 9n * LOT, optionId: OPTION_ID };
  });
  try {
    assert.equal(await contractsAssignedAt({ vaultClaimKey: CLAIM_KEY }), 9n, '9e18 / 1e18 = 9, not 9e18');
    assert.equal(read.mock.callCount(), 1);
  } finally {
    read.mock.restore();
  }
});

test('contractsAssignedAt: integer division, the way ValoremLib.sol:149 does it', async () => {
  const read = stubRead(async () => ({ amountWritten: 23n * LOT, amountExercised: 9n * LOT + (LOT - 1n), optionId: OPTION_ID }));
  try {
    assert.equal(await contractsAssignedAt({ vaultClaimKey: CLAIM_KEY }), 9n);
  } finally {
    read.mock.restore();
  }
});

test('contractsAssignedAt: a failed read is null — unknown — never a silent 0', async () => {
  // What Valorem answers for a burned claim (after rollClose) or what an RPC outage looks like.
  const read = stubRead(async () => {
    throw new Error('execution reverted: TokenNotFound(uint256)');
  });
  try {
    assert.equal(await contractsAssignedAt({ vaultClaimKey: CLAIM_KEY }), null);
    assert.equal(read.mock.callCount(), 1);
  } finally {
    read.mock.restore();
  }
});

/*//////////////////////////////////////////////////////////////
          K-21: BOTH CLOSE PATHS RECORD THE SPLIT, THROUGH tick()
//////////////////////////////////////////////////////////////*/

const ZERO32 = `0x${'00'.repeat(32)}` as const;
const STRIKE = 225_000_000n;
const WRITTEN = 23n;

interface Week {
  cycleNumber: number;
  /** Harvest.grossUsdg, already including the strike proceeds on an assigned week. */
  gross: bigint;
  fee: bigint;
  net: bigint;
  assigned: bigint;
  closeTx: `0x${string}`;
}

/** A week's amounts the way the vault computes them: fee 5% of premium only. */
function week(cycleNumber: number, premium: bigint, assigned: bigint, closeByte: string): Week {
  const proceeds = assigned * STRIKE;
  const fee = (premium * 500n) / 10_000n;
  return { cycleNumber, gross: premium + proceeds, fee, net: premium + proceeds - fee, assigned, closeTx: `0x${closeByte.repeat(32)}` };
}

interface EncodedLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
}

function encodedLog(eventName: 'RollClose' | 'Harvest', w: Week, logIndex: number): EncodedLog {
  const topics = encodeEventTopics({ abi: vaultAbi, eventName, args: { cycleNumber: w.cycleNumber } }) as string[];
  const values: [bigint, bigint, bigint] =
    eventName === 'RollClose' ? [(WRITTEN - w.assigned) * LOT, w.assigned * STRIKE, w.assigned] : [w.gross, w.fee, w.net];
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], values);
  return { address: config.VAULT, topics, data, blockNumber: 1_000n, transactionHash: w.closeTx, logIndex };
}

interface LogQuery {
  event: { name: string };
  args: { cycleNumber: number };
}

/** Every chain call a tick makes, answered for one week in one phase. Returns the restorer. */
function stubChain(w: Week, phase: 'Exercisable' | 'Idle'): () => void {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const expiry = now - 60n; // past expiry, but not an hour past (no phase_stuck)
  const live = phase === 'Exercisable';
  const reads: Record<string, unknown> = {
    phase: live ? 2 : 0,
    writesHalted: false,
    valoremFeeAccepted: false,
    cycleNumber: w.cycleNumber,
    cycleExerciseTs: expiry - 86_400n,
    cycleExpiryTs: expiry,
    cycleStrikeUsdg: live ? STRIKE : 0n,
    optionId: live ? OPTION_ID : 0n,
    claimKey: live ? CLAIM_KEY : 0n,
    contractsWritten: live ? WRITTEN : 0n,
    listingHash: ZERO32,
    listingsThisCycle: 1,
    idleAssets: 0n,
    totalAssets: 0n,
    lockedAssets: 0n,
    KEEPER_ROLE: ZERO32,
    feesEnabled: false,
    feeBps: 0,
    // The registry is already on this cycle, so the Idle tick stops after reconciling the close.
    cycle: { number: w.cycleNumber, exerciseTimestamp: expiry - 86_400n, expiryTimestamp: expiry, lotSize: LOT, optionIds: [] },
    isWritingOpen: false,
    isCycleLive: false,
    hasRole: true,
    balanceOf: 0n,
    oraclePaused: false,
    claim: { amountWritten: WRITTEN * LOT, amountExercised: w.assigned * LOT, optionId: OPTION_ID },
  };
  const mocks = [
    mock.method(publicClient, 'readContract', async (call: ReadCall) => {
      if (!(call.functionName in reads)) throw new Error(`unstubbed read ${call.functionName}`);
      return reads[call.functionName];
    }),
    mock.method(publicClient, 'getBlock', async () => ({ number: 1_001n, timestamp: now })),
    mock.method(publicClient, 'getBalance', async () => 10n ** 18n),
    mock.method(publicClient, 'simulateContract', async (call: ReadCall) => {
      assert.equal(call.functionName, 'rollClose', 'the only transaction a close tick sends');
      return { request: call };
    }),
    mock.method(walletClient, 'writeContract', async () => w.closeTx),
    mock.method(publicClient, 'waitForTransactionReceipt', async () => ({
      status: 'success',
      blockNumber: 1_000n,
      gasUsed: 400_000n,
      transactionHash: w.closeTx,
      logs: [encodedLog('Harvest', w, 0), encodedLog('RollClose', w, 1)],
    })),
    mock.method(logClient, 'getLogs', async (query: LogQuery) => {
      assert.equal(query.args.cycleNumber, w.cycleNumber, 'log queries filter on the indexed cycle number');
      const args = { cycleNumber: w.cycleNumber };
      if (query.event.name === 'Harvest') {
        return [{ ...encodedLog('Harvest', w, 0), args: { ...args, grossUsdg: w.gross, feeUsdg: w.fee, netUsdg: w.net } }];
      }
      if (query.event.name === 'RollClose') {
        const amounts = { assetsReturned: (WRITTEN - w.assigned) * LOT, usdgFromAssignment: w.assigned * STRIKE, contractsAssignedCount: w.assigned };
        return [{ ...encodedLog('RollClose', w, 1), args: { ...args, ...amounts } }];
      }
      if (query.event.name === 'RollOpen') {
        return [{ blockNumber: 900n, transactionHash: `0x${'0f'.repeat(32)}`, args: { ...args, optionId: OPTION_ID, contractsCount: WRITTEN, strikeUsdg: STRIKE } }];
      }
      throw new Error(`unstubbed getLogs ${query.event.name}`);
    }),
  ];
  return () => {
    for (const m of mocks) m.mock.restore();
  };
}

/** The keeper already opened and locked this week, the way a live tick would have left it. */
function seedLockedWeek(w: Week): void {
  const openTx = `0x${w.cycleNumber.toString(16).padStart(64, 'e')}`;
  store.ensureCycle(w.cycleNumber, 'locked');
  store.updateCycle(w.cycleNumber, {
    option_id: OPTION_ID.toString(),
    strike_usdg6: STRIKE.toString(),
    contracts: Number(WRITTEN),
    roll_open_tx: openTx,
  });
  store.recordTxSubmitted(openTx, 'rollOpen', w.cycleNumber);
  store.recordTxResult(openTx, 'success', 900n, 1n, null);
}

async function tickAgainst(w: Week, phase: 'Exercisable' | 'Idle'): Promise<void> {
  const restore = stubChain(w, phase);
  try {
    await tick();
  } finally {
    restore();
  }
}

function lastRollClose(): { message: string; data: Record<string, unknown> } {
  const row = store.recentAlerts(50).find((a) => a.kind === 'roll_close');
  assert.ok(row, 'a roll_close alert was recorded');
  return { message: row.message, data: JSON.parse(row.data_json ?? '{}') as Record<string, unknown> };
}

const UNWITNESSED = ' The close ran without this keeper witnessing it; reconstructed from chain logs.';
const ASSIGNED_MESSAGE =
  'premium 19.079259 USDG (fee 0.953962), strike proceeds 2025 USDG from 9 contracts assigned; 2043.125297 USDG to depositors.';

/* Dry-run cycle 3's premium, 19.079259 USDG, with 9 of 23 assigned at 225 and without. */
const ASSIGNED_LIVE = week(3, 19_079_259n, 9n, '31');
const UNASSIGNED_LIVE = week(4, 19_079_259n, 0n, '41');
const ASSIGNED_ADOPTED = week(5, 19_079_259n, 9n, '51');
const UNFILLED_ADOPTED = week(6, 0n, 0n, '61');

test("the keeper's own rollClose records assets_returned and usdg_from_assignment, and words the assigned alert", async () => {
  const w = ASSIGNED_LIVE;
  assert.equal(w.gross, 2_044_079_259n);
  assert.equal(w.net, 2_043_125_297n);
  seedLockedWeek(w);
  await tickAgainst(w, 'Exercisable');

  const row = store.getCycle(3);
  assert.ok(row);
  assert.equal(row.status, 'closed');
  assert.equal(row.roll_close_tx, w.closeTx);
  assert.equal(row.gross_usdg6, '2044079259');
  assert.equal(row.fee_usdg6, '953962');
  assert.equal(row.net_usdg6, '2043125297');
  assert.equal(row.contracts_assigned, 9);
  assert.equal(row.assets_returned, (14n * LOT).toString(), 'RollClose.assetsReturned, wei as TEXT');
  assert.equal(row.usdg_from_assignment, '2025000000', 'RollClose.usdgFromAssignment, USDG6 as TEXT');

  const { message, data } = lastRollClose();
  assert.equal(message, `cycle 3 closed: ${ASSIGNED_MESSAGE}`);
  assert.equal(data.premiumUsdg, '19.079259');
  assert.equal(data.strikeProceedsUsdg, '2025');
  assert.equal(data.assetsReturned, (14n * LOT).toString());
  assert.equal(data.grossUsdg, '2044.079259');
  assert.equal(data.contractsAssigned, 9);
  assert.equal(data.contractsAssignedSource, 'RollClose');
  assert.equal(data.contractsAssignedFromClaim, 9);
  assert.equal(data.tx, w.closeTx);
});

test("the keeper's own rollClose on an unassigned filled week: columns recorded, wording unchanged", async () => {
  const w = UNASSIGNED_LIVE;
  seedLockedWeek(w);
  await tickAgainst(w, 'Exercisable');

  const row = store.getCycle(4);
  assert.ok(row);
  assert.equal(row.status, 'closed');
  assert.equal(row.assets_returned, (23n * LOT).toString(), 'the whole claim came back');
  assert.equal(row.usdg_from_assignment, '0', 'a recorded 0, not NULL: the event said nothing was assigned');
  const { message, data } = lastRollClose();
  assert.equal(message, 'cycle 4 closed: 19.079259 USDG harvested, 18.125297 to depositors.');
  assert.equal(data.premiumUsdg, '19.079259');
  assert.equal(data.strikeProceedsUsdg, '0');
});

test('a close this keeper never witnessed is reconstructed from logs WITH the split', async () => {
  const w = ASSIGNED_ADOPTED;
  assert.equal(store.getCycle(5), null, 'another operator ran this week end to end');
  await tickAgainst(w, 'Idle');

  const row = store.getCycle(5);
  assert.ok(row);
  assert.equal(row.status, 'closed');
  assert.equal(row.roll_close_tx, w.closeTx);
  assert.equal(row.gross_usdg6, '2044079259');
  assert.equal(row.contracts_assigned, 9);
  assert.equal(row.assets_returned, (14n * LOT).toString());
  assert.equal(row.usdg_from_assignment, '2025000000');
  assert.equal(row.strike_usdg6, STRIKE.toString(), 'write details still adopted from the RollOpen log');
  const { message, data } = lastRollClose();
  assert.equal(message, `cycle 5 closed: ${ASSIGNED_MESSAGE}${UNWITNESSED}`);
  assert.equal(data.premiumUsdg, '19.079259');
  assert.equal(data.strikeProceedsUsdg, '2025');
  assert.equal(data.witnessedLive, false);
});

test('a reconstructed unfilled week keeps its wording and records 0 and the full claim', async () => {
  const w = UNFILLED_ADOPTED;
  seedLockedWeek(w); // the keeper wrote it, then was down through the close
  await tickAgainst(w, 'Idle');

  const row = store.getCycle(6);
  assert.ok(row);
  assert.equal(row.status, 'closed');
  assert.equal(row.gross_usdg6, '0');
  assert.equal(row.usdg_from_assignment, '0');
  assert.equal(row.assets_returned, (23n * LOT).toString());
  const { message, data } = lastRollClose();
  assert.equal(message, `cycle 6 closed unfilled: 0 USDG harvested.${UNWITNESSED}`);
  assert.equal(data.premiumUsdg, '0');
  assert.equal(data.strikeProceedsUsdg, '0');
});

test('GET /cycles serves the stored split and the derived premium_gross_usdg6 / strike_proceeds_usdg6', async () => {
  // A row closed by the previous keeper version: columns NULL, so no split is claimed.
  store.ensureCycle(2, 'closed');
  store.updateCycle(2, { gross_usdg6: '19079259', fee_usdg6: '953962', net_usdg6: '18125297', contracts_assigned: 0 });

  const response = await buildApp().request('/cycles');
  assert.equal(response.status, 200);
  const { cycles } = (await response.json()) as { cycles: CycleTapeRow[] };
  const byNumber = new Map(cycles.map((c) => [c.cycle_number, c]));
  assert.deepEqual([...byNumber.keys()], [6, 5, 4, 3, 2], 'newest first');

  for (const n of [3, 5]) {
    const c = byNumber.get(n);
    assert.ok(c);
    assert.equal(c.gross_usdg6, '2044079259');
    assert.equal(c.usdg_from_assignment, '2025000000');
    assert.equal(c.assets_returned, (14n * LOT).toString());
    assert.equal(c.premium_gross_usdg6, '19079259', `cycle ${n}: gross - strike proceeds`);
    assert.equal(c.strike_proceeds_usdg6, '2025000000');
  }
  assert.equal(byNumber.get(4)?.premium_gross_usdg6, '19079259', 'unassigned: the whole gross is premium');
  assert.equal(byNumber.get(4)?.strike_proceeds_usdg6, '0');
  assert.equal(byNumber.get(6)?.premium_gross_usdg6, '0');
  assert.equal(byNumber.get(6)?.strike_proceeds_usdg6, '0');
  assert.equal(byNumber.get(2)?.usdg_from_assignment, null);
  assert.equal(byNumber.get(2)?.premium_gross_usdg6, null, 'unknown split: null, not all-premium');
  assert.equal(byNumber.get(2)?.strike_proceeds_usdg6, null);
});
