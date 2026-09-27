/**
 * The guardian watch's tick (watch.ts) over a fake chain, sender and alerter. Pinned, as the guard's
 * core cases: an in-band uncorroborated candidate pages without a veto; a 1e8x candidate pages and is vetoed before
 * finalizableAt; the flag off pages only; a corroborated (finalized) expiry does nothing. Also: expiries are found
 * from the oracle's logs, a finalized price becomes the next expiry's reference, the other-source reference falls back
 * to the live TWAP, a failed veto pages, and a refused log range is halved; and expiries
 * 45 days apart are both covered, and a stale-round candidate is paged, and vetoed when the pool disagrees beyond the band.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpRequestError, createPublicClient, custom, decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, type Abi, type Address, type Hash, type Hex } from 'viem';
import { chainlinkFeedSourceAbi } from '../abi/chainlinkFeedSource.js';
import { priceSourceAbi } from '../abi/priceSource.js';
import { settlementOracleAbi } from '../abi/settlementOracle.js';
import { silentLogger } from '../logger.js';
import type { TxOutcome } from '../tx.js';
import type { GuardianThresholds } from './planner.js';
import { GuardianWatch, MAX_ROUND_READS, roundInForceAt, toGuardianLogs, viemGuardianChain, type ExpiryReads, type FeedRound, type GuardianChain, type GuardianLog, type VetoSender } from './watch.js';

const ORACLE = '0x0e4F266b73e95dc6d4cA10674DCd5eF353e2BDCD' as Address;
const CHAINLINK = '0xD824c6488982473364039e3790063b8bF1f2Cc93' as Address;
const POOL = '0x48B8d36bA9BB66A033094a84d52c95D20964C666' as Address;
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as Address;
const REAL = 229_000_000n;
const MIS = REAL * 100_000_000n;
const E1 = 1_790_107_200;
const E2 = 1_790_193_600;
const DELAY = 21_600;
const HASH = `0x${'ab'.repeat(32)}` as Hash;
const STALE_AFTER = 86_400 + 1_800;

interface FakeState {
  headBlock: bigint;
  now: number;
  logs: Array<GuardianLog & { block: bigint }>;
  expiries: Map<string, ExpiryReads>;
  latest: Map<string, bigint | null>;
  /** readRoundAge answers, by `source:underlying:expiry` (lowercase). Unset: null (not a Chainlink source), or 'unread'. */
  roundAges: Map<string, number | null | 'unread'>;
  refuseRangesOver: bigint | null;
  getLogsCalls: Array<[bigint, bigint]>;
}

function fakeChain(s: FakeState): GuardianChain {
  return {
    head: async () => ({ blockNumber: s.headBlock, timestamp: s.now }),
    logHead: async () => s.headBlock,
    async getLogs(from, to) {
      s.getLogsCalls.push([from, to]);
      if (s.refuseRangesOver !== null && to - from + 1n > s.refuseRangesOver) throw new Error('range too large');
      return s.logs.filter((l) => l.block >= from && l.block <= to);
    },
    async readExpiry(underlying, expiry) {
      const r = s.expiries.get(`${underlying.toLowerCase()}:${expiry}`);
      if (r === undefined) throw new Error(`no fake for ${underlying}:${expiry}`);
      return r;
    },
    async readLatest(source, underlying) {
      return s.latest.get(`${source.toLowerCase()}:${underlying.toLowerCase()}`) ?? null;
    },
    async readRoundAge(source, underlying, expiry) {
      return s.roundAges.get(`${source.toLowerCase()}:${underlying.toLowerCase()}:${expiry}`) ?? null;
    },
  };
}

const pending = (price: bigint, over: Partial<ExpiryReads> = {}): ExpiryReads => ({
  status: 'Pending',
  candidate: { price, sourceIndex: 0, disagreed: true, finalizableAt: E2 + 120 + DELAY },
  // Captured: Chainlink ok at `price`, the pool ok at the real price and disagreeing.
  recorded: { sources: [CHAINLINK, POOL], ok: [true, true], prices: [price, REAL] },
  sources: [CHAINLINK, POOL],
  maxDeviationBps: 150,
  ...over,
});

interface Harness {
  s: FakeState;
  watch: GuardianWatch;
  sends: Array<{ functionName: string; args: readonly unknown[]; kind: string; key: string }>;
  alerts: Array<{ kind: string; message: string; data: Record<string, unknown> }>;
  setOutcome(o: TxOutcome): void;
}

function harness(thresholds: GuardianThresholds = { scaleFactor: 10, autoVeto: true, staleRoundAfterS: STALE_AFTER }, adminSafe: Address | null = null): Harness {
  const s: FakeState = { headBlock: 1_000n, now: E2 + 300, logs: [], expiries: new Map(), latest: new Map(), roundAges: new Map(), refuseRangesOver: null, getLogsCalls: [] };
  const sends: Harness['sends'] = [];
  const alerts: Harness['alerts'] = [];
  let outcome: TxOutcome = { status: 'confirmed', hash: HASH, nonce: 7, blockNumber: 1_001n, gasUsed: 50_000n, result: undefined };
  const sender: VetoSender = {
    execute: (async (call: { functionName: string; args: readonly unknown[] }, options: { kind: string; key: string }) => {
      sends.push({ functionName: call.functionName, args: call.args, kind: options.kind, key: options.key });
      return outcome;
    }) as unknown as VetoSender['execute'],
  };
  const watch = new GuardianWatch({
    chain: fakeChain(s),
    sender,
    alerter: {
      alert: async (kind, message, data = {}) => {
        alerts.push({ kind, message, data });
        return true;
      },
    },
    log: silentLogger(),
    oracle: ORACLE,
    fromBlock: 100n,
    chunkBlocks: 50_000,
    chunksPerTick: 40,
    thresholds,
    adminSafe,
  });
  return { s, watch, sends, alerts, setOutcome: (o) => (outcome = o) };
}

const kinds = (h: Harness) => h.alerts.map((a) => a.kind);

test('an in-band uncorroborated candidate pages v2_guardian_candidate and is not vetoed', async () => {
  const h = harness();
  h.s.logs.push({ eventName: 'SettlementCandidate', underlying: NVDA, expiry: E2, price: null, block: 900n });
  h.s.expiries.set(`${NVDA.toLowerCase()}:${E2}`, pending(240_000_000n));
  const report = await h.watch.tick();
  assert.deepEqual(kinds(h), ['v2_guardian_candidate']);
  assert.equal(h.sends.length, 0);
  assert.equal(report.expiries[0]!.plan, 'in-band');
  assert.equal(report.expiries[0]!.poolPrice, REAL.toString(), 'the recorded pool price is the reference');
});

test('a 1e8x candidate pages and is vetoed before finalizableAt; the expiry then leaves the open set', async () => {
  const h = harness();
  h.s.logs.push({ eventName: 'SettlementCandidate', underlying: NVDA, expiry: E2, price: null, block: 900n });
  h.s.expiries.set(`${NVDA.toLowerCase()}:${E2}`, pending(MIS));
  assert.ok(h.s.now < E2 + 120 + DELAY, 'the tick is before finalizableAt');
  const report = await h.watch.tick();
  assert.deepEqual(kinds(h), ['v2_guardian_candidate', 'v2_guardian_scale_fault', 'v2_guardian_vetoed']);
  assert.deepEqual(h.sends, [{ functionName: 'veto', args: [NVDA, E2], kind: 'guardian_veto', key: `${NVDA}:${E2}` }]);
  assert.equal(report.expiries[0]!.veto, 'confirmed');
  assert.equal(report.open, 0);
  // Held now; nothing is sent again.
  const again = await h.watch.tick();
  assert.equal(again.expiries.length, 0);
  assert.equal(h.sends.length, 1);
});

test('GUARDIAN_AUTO_VETO off: the scale fault pages and nothing is sent', async () => {
  const h = harness({ scaleFactor: 10, autoVeto: false, staleRoundAfterS: STALE_AFTER });
  h.s.logs.push({ eventName: 'SettlementCandidate', underlying: NVDA, expiry: E2, price: null, block: 900n });
  h.s.expiries.set(`${NVDA.toLowerCase()}:${E2}`, pending(MIS));
  const report = await h.watch.tick();
  assert.deepEqual(kinds(h), ['v2_guardian_candidate', 'v2_guardian_scale_fault']);
  assert.equal(h.sends.length, 0);
  assert.equal(report.expiries[0]!.veto, 'off');
});

const SAFE = '0x6f8A7B77b72511cD8939596b1659bA28C28f101B' as Address;

test('after the lock: a scale fault with GUARDIAN_AUTO_VETO on still sends nothing and pages for the Admin Safe', async () => {
  const h = harness({ scaleFactor: 10, autoVeto: true, staleRoundAfterS: STALE_AFTER }, SAFE);
  h.s.logs.push({ eventName: 'SettlementCandidate', underlying: NVDA, expiry: E2, price: null, block: 900n });
  h.s.expiries.set(`${NVDA.toLowerCase()}:${E2}`, pending(MIS));
  const report = await h.watch.tick();
  assert.deepEqual(kinds(h), ['v2_guardian_candidate', 'v2_guardian_scale_fault']);
  assert.equal(h.sends.length, 0, 'the key holds no GUARDIAN after the lock: a veto would revert');
  assert.equal(report.expiries[0]!.veto, 'admin-safe');
  assert.match(h.alerts[1]!.message, new RegExp(`holds no GUARDIAN after the lock \\(owner R4\\): veto through the Admin Safe ${SAFE}`));
  assert.doesNotMatch(h.alerts[1]!.message, /GUARDIAN_AUTO_VETO|vetoing/);
  assert.equal(report.open, 1, 'the expiry stays watched until someone vetoes or it finalizes');
});

test('after the lock: a stale round the pool disagrees with pages for the Admin Safe; one it agrees with is unchanged', async () => {
  const h = harness({ scaleFactor: 10, autoVeto: true, staleRoundAfterS: STALE_AFTER }, SAFE);
  h.s.logs.push({ eventName: 'SettlementCandidate', underlying: NVDA, expiry: E2, price: null, block: 900n });
  h.s.expiries.set(`${NVDA.toLowerCase()}:${E2}`, pending(REAL, { recorded: { sources: [CHAINLINK, POOL], ok: [true, true], prices: [REAL, (REAL * 98n) / 100n] } }));
  h.s.roundAges.set(`${CHAINLINK.toLowerCase()}:${NVDA.toLowerCase()}:${E2}`, 90_000);
  const report = await h.watch.tick();
  assert.equal(report.expiries[0]!.veto, 'admin-safe');
  assert.equal(h.sends.length, 0);
  assert.match(h.alerts[1]!.message, /veto through the Admin Safe 0x6f8A7B77/);
  const agree = harness({ scaleFactor: 10, autoVeto: true, staleRoundAfterS: STALE_AFTER }, SAFE);
  agree.s.logs.push({ eventName: 'SettlementCandidate', underlying: NVDA, expiry: E2, price: null, block: 900n });
  agree.s.expiries.set(`${NVDA.toLowerCase()}:${E2}`, pending(REAL));
  agree.s.roundAges.set(`${CHAINLINK.toLowerCase()}:${NVDA.toLowerCase()}:${E2}`, 90_000);
  const r2 = await agree.watch.tick();
  assert.equal(r2.expiries[0]!.veto, null, 'not a veto case at all: nothing is said about who vetoes');
  assert.match(agree.alerts[1]!.message, /check it against an independent price/);
});

test('a corroborated expiry does nothing: it finalizes at once, and the finalized log closes it', async () => {
  const h = harness();
  h.s.logs.push({ eventName: 'SettlementFinalized', underlying: NVDA, expiry: E2, price: REAL, block: 900n });
  const report = await h.watch.tick();
  assert.equal(report.open, 0);
  assert.deepEqual(h.alerts, []);
  assert.deepEqual(h.sends, []);
  // And an expiry whose read says Finalized (the log not scanned yet) is dropped without a page.
  const h2 = harness();
  h2.s.logs.push({ eventName: 'SettlementCandidate', underlying: NVDA, expiry: E2, price: null, block: 900n });
  h2.s.expiries.set(`${NVDA.toLowerCase()}:${E2}`, { ...pending(MIS), status: 'Finalized' });
  const r2 = await h2.watch.tick();
  assert.deepEqual(h2.alerts, []);
  assert.deepEqual(h2.sends, []);
  assert.equal(r2.open, 0);
});

test('the last finalized price is the second reference, and the live TWAP stands in for a pool that did not record', async () => {
  const h = harness();
  h.s.logs.push({ eventName: 'SettlementFinalized', underlying: NVDA, expiry: E1, price: 228_000_000n, block: 500n });
  h.s.logs.push({ eventName: 'SettlementCandidate', underlying: NVDA, expiry: E2, price: null, block: 900n });
  // Single ok source: the pool leg did not record, so the reference is the pool's live `latest`.
  h.s.expiries.set(`${NVDA.toLowerCase()}:${E2}`, pending(MIS, { recorded: { sources: [CHAINLINK, POOL], ok: [true, false], prices: [MIS, 0n] } }));
  h.s.latest.set(`${POOL.toLowerCase()}:${NVDA.toLowerCase()}`, 230_000_000n);
  const report = await h.watch.tick();
  const x = report.expiries[0]!;
  assert.equal(x.poolPrice, '230000000');
  assert.equal(x.lastFinalizedPrice, '228000000');
  assert.equal(x.plan, 'scale-fault');
  assert.equal(h.sends.length, 1);
  assert.equal(h.watch.lastFinalizedBefore(NVDA, E2), 228_000_000n);
  assert.equal(h.watch.lastFinalizedBefore(NVDA, E1), null, 'only an EARLIER expiry is a reference');
});

test('a veto that does not go through pages v2_guardian_veto_failed and keeps the expiry open', async () => {
  const h = harness();
  h.setOutcome({ status: 'simulation-reverted', revert: 'NotAuthorized', error: 'NotAuthorized()' });
  h.s.logs.push({ eventName: 'SettlementCandidate', underlying: NVDA, expiry: E2, price: null, block: 900n });
  h.s.expiries.set(`${NVDA.toLowerCase()}:${E2}`, pending(MIS));
  const report = await h.watch.tick();
  assert.deepEqual(kinds(h), ['v2_guardian_candidate', 'v2_guardian_scale_fault', 'v2_guardian_veto_failed']);
  assert.equal(report.open, 1);
  assert.equal(h.alerts[2]!.data.revert, 'NotAuthorized');
});

test('an unveto reopens a Held expiry; the scan restarts below its cursor and halves a refused range', async () => {
  const h = harness();
  h.s.refuseRangesOver = 400n;
  h.s.logs.push({ eventName: 'SettlementUnvetoed', underlying: NVDA, expiry: E2, price: null, block: 900n });
  h.s.expiries.set(`${NVDA.toLowerCase()}:${E2}`, pending(240_000_000n));
  const report = await h.watch.tick();
  assert.equal(report.open, 1);
  assert.equal(report.scannedTo, '1000');
  assert.ok(h.s.getLogsCalls.some(([f, t]) => t - f + 1n <= 400n), 'a smaller range was tried after the refusal');
  h.s.getLogsCalls.length = 0;
  h.s.headBlock = 1_050n;
  await h.watch.tick();
  assert.equal(h.s.getLogsCalls[0]![0], 1_000n + 1n - 100n, 'restarts REORG_OVERLAP below the cursor');
});

test('toGuardianLogs keeps the three events with their indexed arguments and the finalized price', () => {
  const logs = toGuardianLogs([
    { eventName: 'SettlementCandidate', args: { underlying: NVDA, expiry: BigInt(E2), price: MIS } },
    { eventName: 'SettlementFinalized', args: { underlying: NVDA, expiry: E1, price: REAL } },
    { eventName: 'SettlementUnvetoed', args: { underlying: NVDA, expiry: E2 } },
    { eventName: 'SettlementVetoed', args: { underlying: NVDA, expiry: E2 } },
    { eventName: 'SettlementCandidate', args: { expiry: E2 } },
  ]);
  assert.deepEqual(logs, [
    { eventName: 'SettlementCandidate', underlying: NVDA, expiry: E2, price: null },
    { eventName: 'SettlementFinalized', underlying: NVDA, expiry: E1, price: REAL },
    { eventName: 'SettlementUnvetoed', underlying: NVDA, expiry: E2, price: null },
  ]);
});

/*//////////////////////////////////////////////////////////////
     45-DAY COVERAGE AND STALE ROUNDS
//////////////////////////////////////////////////////////////*/

test('every expiry that emits a candidate is watched, up to the 45-day pin horizon and beyond; each is vetoed on its own', async () => {
  const h = harness();
  const far = E2 + 45 * 86_400;
  h.s.logs.push({ eventName: 'SettlementCandidate', underlying: NVDA, expiry: E2, price: null, block: 900n });
  h.s.logs.push({ eventName: 'SettlementCandidate', underlying: NVDA, expiry: far, price: null, block: 950n });
  h.s.expiries.set(`${NVDA.toLowerCase()}:${E2}`, pending(MIS));
  h.s.expiries.set(`${NVDA.toLowerCase()}:${far}`, pending(MIS, { candidate: { price: MIS, sourceIndex: 0, disagreed: true, finalizableAt: far + 120 + DELAY } }));
  const report = await h.watch.tick();
  assert.deepEqual(report.expiries.map((x) => [x.expiry, x.plan, x.veto]), [
    [E2, 'scale-fault', 'confirmed'],
    [far, 'scale-fault', 'confirmed'],
  ]);
  assert.deepEqual(h.sends.map((x) => x.args), [[NVDA, E2], [NVDA, far]]);
});

test('a stale-round candidate the pool disagrees with is paged v2_guardian_stale_round and vetoed', async () => {
  const h = harness();
  const price = REAL;
  // Pool recorded 2 % lower; band 150 bps; the Chainlink round in force at the expiry was 25 h old.
  h.s.logs.push({ eventName: 'SettlementCandidate', underlying: NVDA, expiry: E2, price: null, block: 900n });
  h.s.expiries.set(`${NVDA.toLowerCase()}:${E2}`, pending(price, { recorded: { sources: [CHAINLINK, POOL], ok: [true, true], prices: [price, (REAL * 98n) / 100n] } }));
  h.s.roundAges.set(`${CHAINLINK.toLowerCase()}:${NVDA.toLowerCase()}:${E2}`, 90_000);
  const report = await h.watch.tick();
  assert.deepEqual(kinds(h), ['v2_guardian_candidate', 'v2_guardian_stale_round', 'v2_guardian_vetoed']);
  assert.equal(report.expiries[0]!.staleRound, true);
  assert.equal(report.expiries[0]!.roundAge, 90_000);
  assert.equal(report.expiries[0]!.veto, 'confirmed');
  assert.equal(h.sends.length, 1);
  assert.match(h.alerts[2]!.message, /stale feed round/);
});

test('a stale-round candidate the pool agrees with pages v2_guardian_stale_round and is not vetoed', async () => {
  const h = harness();
  h.s.logs.push({ eventName: 'SettlementCandidate', underlying: NVDA, expiry: E2, price: null, block: 900n });
  // Single ok source; the pool's live TWAP agrees within the band.
  h.s.expiries.set(`${NVDA.toLowerCase()}:${E2}`, pending(REAL, { recorded: { sources: [CHAINLINK, POOL], ok: [true, false], prices: [REAL, 0n] } }));
  h.s.latest.set(`${POOL.toLowerCase()}:${NVDA.toLowerCase()}`, (REAL * 1_001n) / 1_000n);
  h.s.roundAges.set(`${CHAINLINK.toLowerCase()}:${NVDA.toLowerCase()}:${E2}`, 90_000);
  const report = await h.watch.tick();
  assert.deepEqual(kinds(h), ['v2_guardian_candidate', 'v2_guardian_stale_round']);
  assert.equal(h.sends.length, 0);
  assert.equal(report.expiries[0]!.veto, null);
});

test('GUARDIAN_AUTO_VETO off: a stale round the pool disagrees with reports "off" and sends nothing', async () => {
  const h = harness({ scaleFactor: 10, autoVeto: false, staleRoundAfterS: STALE_AFTER });
  h.s.logs.push({ eventName: 'SettlementCandidate', underlying: NVDA, expiry: E2, price: null, block: 900n });
  h.s.expiries.set(`${NVDA.toLowerCase()}:${E2}`, pending(REAL, { recorded: { sources: [CHAINLINK, POOL], ok: [true, true], prices: [REAL, (REAL * 98n) / 100n] } }));
  h.s.roundAges.set(`${CHAINLINK.toLowerCase()}:${NVDA.toLowerCase()}:${E2}`, 90_000);
  const report = await h.watch.tick();
  assert.deepEqual(kinds(h), ['v2_guardian_candidate', 'v2_guardian_stale_round']);
  assert.equal(report.expiries[0]!.veto, 'off');
  assert.equal(h.sends.length, 0);
  assert.match(h.alerts[1]!.message, /GUARDIAN_AUTO_VETO is off/);
});

test('the round age is read for the candidate\'s OWN source (its index in the pinned list)', async () => {
  const h = harness();
  h.s.logs.push({ eventName: 'SettlementCandidate', underlying: NVDA, expiry: E2, price: null, block: 900n });
  // The pool is the candidate (index 1): a stale answer stored for Chainlink must not be used.
  h.s.expiries.set(`${NVDA.toLowerCase()}:${E2}`, pending(REAL, { candidate: { price: REAL, sourceIndex: 1, disagreed: false, finalizableAt: E2 + 120 + DELAY }, recorded: { sources: [CHAINLINK, POOL], ok: [false, true], prices: [0n, REAL] } }));
  h.s.roundAges.set(`${CHAINLINK.toLowerCase()}:${NVDA.toLowerCase()}:${E2}`, 90_000);
  const report = await h.watch.tick();
  assert.equal(report.expiries[0]!.roundAge, null);
  assert.equal(report.expiries[0]!.staleRound, false);
});

test('roundInForceAt: walks back to the first round at or before the time; stops at the phase start and at the read bound', async () => {
  const PHASE = 2n << 64n;
  const rounds = new Map<bigint, bigint>([
    [PHASE + 5n, 5_000n],
    [PHASE + 4n, 4_000n],
    [PHASE + 3n, 3_000n],
    [PHASE + 2n, 2_000n],
    [PHASE + 1n, 1_000n],
  ]);
  const reads: Array<bigint | null> = [];
  const read = async (id: bigint | null): Promise<FeedRound | null> => {
    reads.push(id);
    const key = id ?? PHASE + 5n;
    const t = rounds.get(key);
    return t === undefined ? null : { id: key, updatedAt: t };
  };
  assert.deepEqual(await roundInForceAt(read, 3_500), { id: PHASE + 3n, updatedAt: 3_000n });
  assert.deepEqual(reads, [null, PHASE + 4n, PHASE + 3n]);
  assert.deepEqual(await roundInForceAt(read, 5_000), { id: PHASE + 5n, updatedAt: 5_000n }, 'at the round itself');
  assert.equal(await roundInForceAt(read, 500), null, 'never crosses into the previous phase');
  assert.equal(await roundInForceAt(read, 1_500, 3), null, 'gives up at the read bound');
  assert.equal(MAX_ROUND_READS, 96);
  const failing = async (id: bigint | null): Promise<FeedRound | null> => (id === null ? { id: PHASE + 5n, updatedAt: 5_000n } : null);
  assert.equal(await roundInForceAt(failing, 3_500), null, 'a failed read ends the walk as unknown');
});

/*//////////////////////////////////////////////////////////////
          THE PRODUCTION ADAPTER OVER ABI-ENCODED RETURN DATA
//////////////////////////////////////////////////////////////*/

// (finding l3): viemGuardianChain reads every return tuple BY POSITION behind `as never` casts, so tsc checks
// none of it and every other test here uses a fake GuardianChain. These run the real adapter over a viem client whose
// transport answers eth_call with data ENCODED FROM THE GENERATED ABIs (src/v2/abi/*), so a position read against the
// wrong field, or a revert turned into null where it should not be, fails here.
const ADAPTER_ORACLE = getAddress('0x0000000000000000000000000000000000000a01');
const CHAINLINK_SOURCE = getAddress('0x0000000000000000000000000000000000000a02');
const POOL_SOURCE = getAddress('0x0000000000000000000000000000000000000a03');
const AGGREGATOR = getAddress('0x0000000000000000000000000000000000000a04');
const PINNED_AGGREGATOR = getAddress('0x0000000000000000000000000000000000000a05');
const U = getAddress('0x0000000000000000000000000000000000000b01');
const EXPIRY = 1_789_156_800;
const BLOCK = 70_000_123n;
const aggregatorAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function getRoundData(uint80 roundId) view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);
const ROUND_PHASE = 5n << 64n;

type Answer = (functionName: string, args: readonly unknown[]) => readonly unknown[];
interface Contract { abi: Abi; answer: Answer }

/** A PublicClient whose eth_call decodes the calldata against `contracts[to].abi` and ABI-encodes `answer`'s tuple. */
function abiClient(contracts: Record<string, Contract>, blocks: string[]) {
  return createPublicClient({
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown }) {
        if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
        const [call, block] = params as [{ to: Address; data: Hex }, string];
        blocks.push(block);
        const c = contracts[call.to.toLowerCase()];
        if (c === undefined) throw new Error(`execution reverted: no contract at ${call.to}`);
        // A contract without the called function reverts on chain (no fallback): so does this fake (the watch tells a
        // revert from a read that got no answer, so the fake must answer the way the node does).
        let decoded: { functionName: string; args: readonly unknown[] };
        try {
          const d = decodeFunctionData({ abi: c.abi, data: call.data });
          decoded = { functionName: d.functionName, args: d.args ?? [] };
        } catch {
          throw new Error(`execution reverted: ${call.data.slice(0, 10)} is not a function of ${call.to}`);
        }
        const { functionName, args } = decoded;
        const result = c.answer(functionName, args ?? []);
        return encodeFunctionResult({ abi: c.abi, functionName, result: (result.length === 1 ? result[0] : result) as never } as never);
      },
    }),
  });
}

function oracleContract(status: number, finalizableAt: number): Contract {
  return {
    abi: settlementOracleAbi as Abi,
    answer: (fn, args) => {
      assert.deepEqual([String(args[0]).toLowerCase(), Number(args[1])], [U.toLowerCase(), EXPIRY], `${fn} is asked about (underlying, expiry)`);
      switch (fn) {
        case 'settlementInfo': return [status, 219_400_000n, 1, true, false, true];
        case 'candidate': return [219_350_000n, 1, true, finalizableAt];
        case 'recordedSources': return [[CHAINLINK_SOURCE, POOL_SOURCE], [true, false], [219_300_000n, 0n], 150];
        case 'settlementConfig': return [true, [CHAINLINK_SOURCE, POOL_SOURCE], 250, 3_600, 90_000];
        default: throw new Error(`execution reverted: ${fn}`);
      }
    },
  };
}

test('viemGuardianChain.readExpiry decodes the oracle tuples by the generated ABIs, at the block asked for', async () => {
  const blocks: string[] = [];
  const chain = viemGuardianChain(abiClient({ [ADAPTER_ORACLE.toLowerCase()]: oracleContract(1, EXPIRY + 900) }, blocks) as never, undefined as never, ADAPTER_ORACLE);
  const reads = await chain.readExpiry(U, EXPIRY, BLOCK);
  assert.deepEqual(reads, {
    status: 'Pending',
    candidate: { price: 219_350_000n, sourceIndex: 1, disagreed: true, finalizableAt: EXPIRY + 900 },
    recorded: { sources: [CHAINLINK_SOURCE, POOL_SOURCE], ok: [true, false], prices: [219_300_000n, 0n] },
    sources: [CHAINLINK_SOURCE, POOL_SOURCE],
    maxDeviationBps: 250,
  } satisfies ExpiryReads);
  assert.equal(blocks.length, 4);
  assert.ok(blocks.every((b) => b === `0x${BLOCK.toString(16)}`), `every read pinned at the block: ${blocks.join(', ')}`);
  // finalizableAt 0 is the oracle's "no candidate"; an out-of-range status is refused by name, never guessed.
  const none = viemGuardianChain(abiClient({ [ADAPTER_ORACLE.toLowerCase()]: oracleContract(2, 0) }, []) as never, undefined as never, ADAPTER_ORACLE);
  assert.deepEqual([(await none.readExpiry(U, EXPIRY, BLOCK)).status, (await none.readExpiry(U, EXPIRY, BLOCK)).candidate], ['Finalized', null]);
  const bad = viemGuardianChain(abiClient({ [ADAPTER_ORACLE.toLowerCase()]: oracleContract(7, 0) }, []) as never, undefined as never, ADAPTER_ORACLE);
  await assert.rejects(bad.readExpiry(U, EXPIRY, BLOCK), /unknown status 7/);
});

function feedSource(pinned: boolean): Contract {
  return {
    abi: chainlinkFeedSourceAbi as Abi,
    answer: (fn) => {
      if (fn === 'pinnedFeeds') return [PINNED_AGGREGATOR, 90_000, 500, pinned];
      if (fn === 'feeds') return [AGGREGATOR, 90_000, 500];
      throw new Error(`execution reverted: ${fn}`);
    },
  };
}

/** An aggregator whose latest round is after the expiry and whose previous one is the round in force at it. */
function aggregator(inForceUpdatedAt: number): Contract {
  return {
    abi: aggregatorAbi as Abi,
    answer: (fn, args) => {
      if (fn === 'latestRoundData') return [ROUND_PHASE + 8n, 219_000_000n, BigInt(EXPIRY + 60), BigInt(EXPIRY + 60), ROUND_PHASE + 8n];
      if (fn === 'getRoundData' && args[0] === ROUND_PHASE + 7n) return [ROUND_PHASE + 7n, 218_000_000n, BigInt(inForceUpdatedAt), BigInt(inForceUpdatedAt), ROUND_PHASE + 7n];
      throw new Error(`execution reverted: ${fn} ${String(args[0])}`);
    },
  };
}

test('viemGuardianChain.readRoundAge: the Chainlink source\'s feed (feeds() unless pinned), walked back to the round in force at expiry', async () => {
  const unpinned = viemGuardianChain(abiClient({
    [CHAINLINK_SOURCE.toLowerCase()]: feedSource(false),
    [AGGREGATOR.toLowerCase()]: aggregator(EXPIRY - 1_200),
  }, []) as never, undefined as never, ADAPTER_ORACLE);
  assert.equal(await unpinned.readRoundAge(CHAINLINK_SOURCE, U, EXPIRY, BLOCK), 1_200, 'feeds()[0] is the feed; age = expiry - the in-force updatedAt');
  const pinned = viemGuardianChain(abiClient({
    [CHAINLINK_SOURCE.toLowerCase()]: feedSource(true),
    [PINNED_AGGREGATOR.toLowerCase()]: aggregator(EXPIRY - 30),
  }, []) as never, undefined as never, ADAPTER_ORACLE);
  assert.equal(await pinned.readRoundAge(CHAINLINK_SOURCE, U, EXPIRY, BLOCK), 30, 'pinnedFeeds()[0] when pinnedFeeds()[3] is true');
});

test('viemGuardianChain.readRoundAge is null for a source without pinnedFeeds (not Chainlink), and only then; readLatest reads (ok, price)', async () => {
  const pool: Contract = {
    abi: priceSourceAbi as Abi,
    answer: (fn) => {
      if (fn === 'latest') return [true, 219_100_000n, BigInt(EXPIRY)];
      throw new Error(`execution reverted: ${fn}`);
    },
  };
  const chain = viemGuardianChain(abiClient({
    [POOL_SOURCE.toLowerCase()]: pool,
    [CHAINLINK_SOURCE.toLowerCase()]: feedSource(false),
    [AGGREGATOR.toLowerCase()]: aggregator(EXPIRY - 1_200),
  }, []) as never, undefined as never, ADAPTER_ORACLE);
  assert.equal(await chain.readRoundAge(POOL_SOURCE, U, EXPIRY, BLOCK), null, 'pinnedFeeds reverts: not a ChainlinkFeedSource');
  assert.notEqual(await chain.readRoundAge(CHAINLINK_SOURCE, U, EXPIRY, BLOCK), null, 'positive control: the Chainlink source is not null');
  assert.equal(await chain.readLatest(POOL_SOURCE, U, BLOCK), 219_100_000n);
  const notOk: Contract = { abi: priceSourceAbi as Abi, answer: () => [false, 219_100_000n, 0n] };
  assert.equal(await viemGuardianChain(abiClient({ [POOL_SOURCE.toLowerCase()]: notOk }, []) as never, undefined as never, ADAPTER_ORACLE).readLatest(POOL_SOURCE, U, BLOCK), null, 'ok false');
  assert.equal(await viemGuardianChain(abiClient({}, []) as never, undefined as never, ADAPTER_ORACLE).readLatest(POOL_SOURCE, U, BLOCK), null, 'a revert');
});

/*//////////////////////////////////////////////////////////////
   A FEED READ THAT GOT NO ANSWER IS NOT "NOT CHAINLINK"
//////////////////////////////////////////////////////////////*/

test('viemGuardianChain.readRoundAge: a read that got no answer (HTTP 429) is \'unread\', never the null of "not a Chainlink source"', async () => {
  const limited = (c: Contract, fail: string): Contract => ({
    abi: c.abi,
    answer: (fn, args) => {
      if (fn === fail) throw new HttpRequestError({ url: 'https://rpc.example', status: 429, details: 'Too Many Requests' });
      return c.answer(fn, args);
    },
  });
  // The source's own view, then the aggregator's walk: each one alone rate-limited.
  const atSource = viemGuardianChain(abiClient({
    [CHAINLINK_SOURCE.toLowerCase()]: limited(feedSource(false), 'pinnedFeeds'),
    [AGGREGATOR.toLowerCase()]: aggregator(EXPIRY - 1_200),
  }, []) as never, undefined as never, ADAPTER_ORACLE);
  assert.equal(await atSource.readRoundAge(CHAINLINK_SOURCE, U, EXPIRY, BLOCK), 'unread');
  for (const fn of ['latestRoundData', 'getRoundData']) {
    const inWalk = viemGuardianChain(abiClient({
      [CHAINLINK_SOURCE.toLowerCase()]: feedSource(false),
      [AGGREGATOR.toLowerCase()]: limited(aggregator(EXPIRY - 1_200), fn),
    }, []) as never, undefined as never, ADAPTER_ORACLE);
    assert.equal(await inWalk.readRoundAge(CHAINLINK_SOURCE, U, EXPIRY, BLOCK), 'unread', `${fn} rate-limited`);
  }
  // Controls: the same source answering gives the age; a contract revert (a pool source) is still null.
  const ok = viemGuardianChain(abiClient({
    [CHAINLINK_SOURCE.toLowerCase()]: feedSource(false),
    [AGGREGATOR.toLowerCase()]: aggregator(EXPIRY - 1_200),
  }, []) as never, undefined as never, ADAPTER_ORACLE);
  assert.equal(await ok.readRoundAge(CHAINLINK_SOURCE, U, EXPIRY, BLOCK), 1_200);
  const pool: Contract = { abi: priceSourceAbi as Abi, answer: (fn) => { throw new Error(`execution reverted: ${fn}`); } };
  const reverted = viemGuardianChain(abiClient({ [POOL_SOURCE.toLowerCase()]: pool }, []) as never, undefined as never, ADAPTER_ORACLE);
  assert.equal(await reverted.readRoundAge(POOL_SOURCE, U, EXPIRY, BLOCK), null);
});

test('an unread feed round is reported, and the candidate page says the stale-round check did not run; nothing is vetoed on it', async () => {
  const h = harness();
  h.s.logs.push({ eventName: 'SettlementCandidate', underlying: NVDA, expiry: E2, price: null, block: 900n });
  h.s.expiries.set(`${NVDA.toLowerCase()}:${E2}`, pending(REAL, { recorded: { sources: [CHAINLINK, POOL], ok: [true, true], prices: [REAL, (REAL * 98n) / 100n] } }));
  h.s.roundAges.set(`${CHAINLINK.toLowerCase()}:${NVDA.toLowerCase()}:${E2}`, 'unread');
  const report = await h.watch.tick();
  assert.equal(report.expiries[0]!.roundAge, 'unread');
  assert.equal(report.expiries[0]!.plan, 'round-unread', 'not "in-band": half of the rule did not run');
  assert.equal(report.expiries[0]!.staleRound, false);
  assert.deepEqual(kinds(h), ['v2_guardian_candidate']);
  assert.match(h.alerts[0]!.message, /stale-round check did not run/);
  assert.equal(h.alerts[0]!.data.roundAge, 'unread');
  assert.equal(h.sends.length, 0, 'no veto on an unknown');
  // Control: the same candidate with the round read and fresh is plainly in band.
  const c = harness();
  c.s.logs.push({ eventName: 'SettlementCandidate', underlying: NVDA, expiry: E2, price: null, block: 900n });
  c.s.expiries.set(`${NVDA.toLowerCase()}:${E2}`, pending(REAL, { recorded: { sources: [CHAINLINK, POOL], ok: [true, true], prices: [REAL, (REAL * 98n) / 100n] } }));
  c.s.roundAges.set(`${CHAINLINK.toLowerCase()}:${NVDA.toLowerCase()}:${E2}`, 600);
  const r = await c.watch.tick();
  assert.equal(r.expiries[0]!.plan, 'in-band');
  assert.doesNotMatch(c.alerts[0]!.message, /stale-round check did not run/);
});
