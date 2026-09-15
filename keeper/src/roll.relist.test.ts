/**
 * A listing the vault no longer authorises must leave the keeper's own book.
 *
 * WHY THIS FILE EXISTS: the guardian cancelListing()s or invalidateAllListings() while the keeper
 * is between ticks. Nothing else notices: pollLiveListing only reads the vault's live hash,
 * refreshListings runs only at boot, and a counter bump never sets Seaport's isCancelled. The
 * dead row would stay `approved`/`partial` and GET /orders — the book the fill page reads — would
 * serve an order Seaport rejects until endTime. roll.ts:retireUnauthorisedListings runs on every
 * Listed tick that sees `listingHash == 0`, before any relist decision.
 *
 * HOW: the same technique as roll.close.test.ts — the keeper's own client methods are replaced
 * for the test and restored after; the RPC in the environment is a discard port. Capacity is
 * zero on the stubbed vault, so the tick may retire rows but must not simulate a relist.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';

/* ---- environment first: config.ts validates process.env the moment it is imported ---- */
const scratch = mkdtempSync(join(tmpdir(), 'callhouse-keeper-roll-relist-'));
process.env.KEEPER_ENV_FILE = '/dev/null';
process.env.RH_RPC = 'http://127.0.0.1:9';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';
delete process.env.ALERT_WEBHOOK;

const { publicClient } = await import('./clients.js');
const { tick } = await import('./roll.js');
const { store } = await import('./state.js');
type ListingStatus = import('./state.js').ListingStatus;

const LOT = 1_000_000_000_000_000_000n;
const ZERO32 = `0x${'00'.repeat(32)}` as const;
const OPTION_ID = 0xabcdefn << 96n;
const hash = (byte: string) => `0x${byte.repeat(32)}`;

interface ReadCall {
  functionName: string;
  args?: readonly unknown[];
}

function seedListing(cycleNumber: number, seq: number, orderHash: string, status: ListingStatus, endTime: number): void {
  store.insertListing({
    order_hash: orderHash,
    cycle_number: cycleNumber,
    seq,
    option_id: OPTION_ID.toString(),
    contracts: '28',
    unit_price6: '881924',
    gross_usdg6: (881_924n * 28n).toString(),
    end_time: endTime,
    counter: '0',
    salt: String(seq),
    components_json: '{}',
    signature: '0x',
    approve_tx: hash(`a${seq}`),
    cancel_tx: null,
    status,
    seaport_total_filled: null,
    seaport_total_size: null,
    seaport_cancelled: null,
  });
}

test('a Listed tick with listingHash 0 retires every offered row of the cycle: cancelled, invalidated, or filled before the cancel', async () => {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const exerciseTs = now + 3_600n;
  const CANCELLED = hash('c1'); // guardian cancelListing after a 7/28 partial fill: isCancelled
  const INVALIDATED = hash('c2'); // invalidateAllListings: counter bumped, isCancelled stays false
  const FILLED = hash('c3'); // filled in full just before the guardian cancelled it
  const OTHER_CYCLE = hash('c9'); // another cycle's live row: not this tick's business
  store.ensureCycle(7, 'open');
  store.updateCycle(7, { contracts: 28 });
  seedListing(7, 1, CANCELLED, 'partial', Number(exerciseTs));
  seedListing(7, 2, INVALIDATED, 'approved', Number(exerciseTs));
  seedListing(7, 3, FILLED, 'approved', Number(exerciseTs));
  seedListing(8, 1, OTHER_CYCLE, 'approved', Number(exerciseTs));
  assert.equal(store.openListings().length, 4, 'before: /orders would serve all four');

  const statuses: Record<string, [boolean, boolean, bigint, bigint]> = {
    [CANCELLED]: [true, true, 7n, 28n],
    [INVALIDATED]: [true, false, 0n, 0n],
    [FILLED]: [true, true, 15n, 15n],
  };
  const reads: Record<string, unknown> = {
    phase: 1,
    writesHalted: false,
    valoremFeeAccepted: false,
    cycleNumber: 7,
    cycleExerciseTs: exerciseTs,
    cycleExpiryTs: exerciseTs + 86_400n,
    cycleStrikeUsdg: 229_000_000n,
    optionId: OPTION_ID,
    claimKey: OPTION_ID | 1n,
    contractsWritten: 28n,
    listingHash: ZERO32,
    listingGrossUsdg: 0n,
    listingAmount: 0n,
    listingsThisCycle: 3,
    idleAssets: 2n * LOT,
    // 30 NVDA at 95% is 28 contracts, all written: capacity 0, so no relist is attempted.
    totalAssets: 30n * LOT,
    lockedAssets: 28n * LOT,
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
  };
  const statusReads: string[] = [];
  const mocks = [
    mock.method(publicClient, 'readContract', async (call: ReadCall) => {
      if (call.functionName === 'getOrderStatus') {
        const orderHash = String(call.args?.[0]);
        statusReads.push(orderHash);
        const status = statuses[orderHash];
        if (!status) throw new Error(`unexpected status read ${orderHash}`);
        return status;
      }
      if (!(call.functionName in reads)) throw new Error(`unstubbed read ${call.functionName}`);
      return reads[call.functionName];
    }),
    mock.method(publicClient, 'getBlock', async () => ({ number: 1_001n, timestamp: now })),
    mock.method(publicClient, 'getBalance', async () => 10n ** 18n),
    mock.method(publicClient, 'simulateContract', async () => {
      throw new Error('no transaction may be simulated: nothing is left to list');
    }),
  ];
  try {
    await tick();
  } finally {
    for (const m of mocks) m.mock.restore();
  }

  assert.deepEqual(statusReads.sort(), [CANCELLED, FILLED, INVALIDATED].sort(), 'each offered row of cycle 7 was checked on Seaport once');
  const row = (h: string) => store.getListing(h);
  assert.equal(row(CANCELLED)?.status, 'cancelled', 'cancelListing: retired');
  assert.equal(row(CANCELLED)?.seaport_cancelled, 1);
  assert.equal(row(CANCELLED)?.seaport_total_filled, '7', 'the partial fill is kept on the row');
  assert.equal(row(INVALIDATED)?.status, 'cancelled', 'counter bump: retired although Seaport never set isCancelled');
  assert.equal(row(INVALIDATED)?.seaport_cancelled, 0);
  assert.equal(row(FILLED)?.status, 'filled', 'fully filled before the cancel: filled, not cancelled');
  assert.equal(row(OTHER_CYCLE)?.status, 'approved', "another cycle's row is untouched");
  assert.deepEqual(
    store.openListings().map((l) => l.order_hash),
    [OTHER_CYCLE],
    '/orders no longer serves any dead order of cycle 7',
  );
  assert.equal(store.getCycle(7)?.contracts, 28, 'the sold count is what the vault says');
});
