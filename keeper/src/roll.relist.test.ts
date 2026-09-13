/**
 * A listing the vault no longer authorises must leave the keeper's own book.
 *
 * WHY THIS FILE EXISTS: dryrun-extended.ts found it on a fork. The guardian cancelListing()ed a
 * partially filled listing; the keeper's next tick relisted the rest — and the dead row stayed
 * `partial`, so GET /orders served the Seaport-cancelled order beside the relist until endTime.
 * An invalidateAllListings() is worse for detection: a counter bump never sets isCancelled, so no
 * Seaport poll would ever flag it. roll.ts:retireUnauthorisedListings now runs on every Listed
 * tick that sees `listingHash == 0`, before any relist decision.
 *
 * HOW: the same technique as roll.close.test.ts — the keeper's own client methods are replaced
 * for the test and restored after; the RPC in the environment is a discard port; `fetch` is
 * replaced so the best-effort DELETE to the book is observed rather than sent.
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
process.env.REGISTRY = '0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA';
process.env.VAULT = '0x1111111111111111111111111111111111111111';
process.env.KEEPER_PK = `0x${'11'.repeat(32)}`;
process.env.KEEPER_DB_PATH = join(scratch, 'keeper.db');
process.env.KEEPER_LOG_LEVEL = 'fatal';
process.env.OVERCALL_ORDERS_URL = 'http://127.0.0.1:9/api/orders';
process.env.OVERCALL_MAX_ATTEMPTS = '1';
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
    unit_price6: '873192',
    gross_usdg6: '24449376',
    to_vault6: '23227016',
    to_overcall6: '1222360',
    end_time: endTime,
    counter: '0',
    salt: String(seq),
    components_json: '{}',
    signature: '0x',
    approve_tx: hash(`a${seq}`),
    cancel_tx: null,
    status,
    api_status: 'open',
    api_error: null,
    posted_at: 1,
    visible_at: 1,
    filled_numerator: null,
    filled_denominator: null,
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
  seedListing(7, 1, CANCELLED, 'partial', Number(exerciseTs));
  seedListing(7, 2, INVALIDATED, 'visible', Number(exerciseTs));
  seedListing(7, 3, FILLED, 'visible', Number(exerciseTs));
  seedListing(8, 1, OTHER_CYCLE, 'visible', Number(exerciseTs));
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
    cycleStrikeUsdg: 225_000_000n,
    optionId: OPTION_ID,
    claimKey: OPTION_ID | 1n,
    contractsWritten: 28n,
    listingHash: ZERO32,
    listingsThisCycle: 3,
    idleAssets: 0n,
    totalAssets: 30n * LOT,
    lockedAssets: 28n * LOT,
    KEEPER_ROLE: ZERO32,
    feesEnabled: false,
    feeBps: 15,
    cycle: { number: 7, exerciseTimestamp: exerciseTs, expiryTimestamp: exerciseTs + 86_400n, lotSize: LOT, optionIds: [] },
    isWritingOpen: true,
    isCycleLive: true,
    hasRole: true,
    // clear.balanceOf(vault, optionId): nothing left to sell, so no relist is attempted either way.
    balanceOf: 0n,
    oraclePaused: false,
  };
  const statusReads: string[] = [];
  const deletes: string[] = [];
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
    mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
      deletes.push(`${init?.method ?? 'GET'} ${url}`);
      return new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } });
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
  assert.equal(row(OTHER_CYCLE)?.status, 'visible', "another cycle's row is untouched");
  assert.deepEqual(
    deletes.sort(),
    [`DELETE http://127.0.0.1:9/api/orders/${CANCELLED}`, `DELETE http://127.0.0.1:9/api/orders/${INVALIDATED}`].sort(),
    'the book is told about the two dead orders, not the filled one',
  );
  assert.deepEqual(
    store.openListings().map((l) => l.order_hash),
    [OTHER_CYCLE],
    '/orders no longer serves any dead order of cycle 7',
  );
});
