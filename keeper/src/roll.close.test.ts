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
 * HOW: roll.test.ts keeps to pure exports. This file needs one impure one, so it replaces the
 * keeper's own `publicClient.readContract` — the very object roll.ts calls — with an in-process
 * stub for each test and restores it after. No HTTP: the RPC in the environment is a discard
 * port, and a read that escapes the stub fails loudly instead of hanging.
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

const { publicClient } = await import('./clients.js');
const { config } = await import('./config.js');
const { contractsAssignedAt } = await import('./roll.js');

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
