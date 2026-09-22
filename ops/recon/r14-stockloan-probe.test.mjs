// node --test ops/recon/r14-stockloan-probe.test.mjs
//
// The decoders and the verdict, against inline fixtures. NO NETWORK: importing the probe module must not
// reach the chain, which is why every exported function here is pure and the probe body sits behind the
// `import.meta.url === pathToFileURL(process.argv[1]).href` guard.
//
// Nothing downstream runs this for you. ops is not a pnpm workspace package (pnpm-workspace.yaml lists
// keeper, indexer, web, relay, notifier only), so package.json's `pnpm -r test` never reaches it, and
// v8-plan/06-QUIRKS.md §A.5 says in as many words that ops checks are not in CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeCreateMarket,
  decodeMarket,
  decodeRound,
  utilisation,
  borrowApyFromRatePerSecond,
  usdValue,
  consecutiveDailySamples,
  verdictOf,
  drift,
  appendSample,
  assertTopLevelKeys,
  TOP_LEVEL_KEYS,
} from './r14-stockloan-probe.mjs';

const w = (v) => BigInt(v).toString(16).padStart(64, '0');
const aw = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

const NVDA = '0x1234567890abcdef1234567890abcdef12345678';
const USDG = '0xaabbccddeeff00112233445566778899aabbccdd';
const ORACLE = '0x00000000000000000000000000000000000000c5';
const IRM = '0x00000000000000000000000000000000000000ff';
const LLTV_625 = 625_000_000_000_000_000n; // 62.5% in WAD, the LLTV every stock-loan market in the recon uses

/** A CreateMarket log as the node returns it: id in topic1, the static MarketParams inline in data. */
const createMarketLog = (id, loan, collateral, oracle, irm, lltv, blockNumber) => ({
  address: '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010',
  topics: ['0xac4b2400f169220b0c0afdde7a0b32e775ba727ea1cb30b35f935cdaab8683ac', id],
  data: `0x${aw(loan)}${aw(collateral)}${aw(oracle)}${aw(irm)}${w(lltv)}`,
  blockNumber: `0x${blockNumber.toString(16)}`,
});

test('decodeCreateMarket reads the five static MarketParams words and the indexed id', () => {
  const id = `0x${'ab'.repeat(32)}`;
  const m = decodeCreateMarket(createMarketLog(id, NVDA, USDG, ORACLE, IRM, LLTV_625, 287));
  assert.equal(m.id, id);
  assert.equal(m.loanToken, NVDA);
  assert.equal(m.collateralToken, USDG);
  assert.equal(m.oracle, ORACLE);
  assert.equal(m.irm, IRM);
  assert.equal(m.lltv, LLTV_625);
  assert.equal(m.createdBlock, 287);
});

test('decodeCreateMarket returns null rather than a half-read market', () => {
  assert.equal(decodeCreateMarket(null), null);
  assert.equal(decodeCreateMarket({ topics: [], data: '0x' }), null);
  // topic1 present but the data is short: a struct layout change would look like this, and a partial
  // decode here would silently produce a market with the wrong collateral token.
  assert.equal(decodeCreateMarket({ topics: ['0xtopic0', `0x${'11'.repeat(32)}`], data: `0x${aw(NVDA)}${aw(USDG)}` }), null);
});

test('decodeMarket reads six uint128 in six words', () => {
  const data = `0x${w(1_000n)}${w(900n)}${w(250n)}${w(240n)}${w(1_780_000_000n)}${w(0n)}`;
  const s = decodeMarket(data);
  assert.equal(s.totalSupplyAssets, 1_000n);
  assert.equal(s.totalSupplyShares, 900n);
  assert.equal(s.totalBorrowAssets, 250n);
  assert.equal(s.totalBorrowShares, 240n);
  assert.equal(s.lastUpdate, 1_780_000_000n);
  assert.equal(s.fee, 0n);
  assert.equal(decodeMarket('0x'), null);
  assert.equal(decodeMarket(null), null);
});

test('decodeRound reads an 8-decimal Chainlink answer and its updatedAt', () => {
  const answer = 23_150_000_000n; // $231.50
  const data = `0x${w(7n)}${w(answer)}${w(1_789_000_000n)}${w(1_789_000_100n)}${w(7n)}`;
  const r = decodeRound(data);
  assert.equal(r.answer, answer);
  assert.equal(r.updatedAt, 1_789_000_100);
  assert.equal(decodeRound('0x'), null);
});

test('utilisation is zero for an empty market and never divides by zero', () => {
  // All twelve stock-loan markets the recon found were exactly this: zero supplied, zero borrowed.
  assert.equal(utilisation({ totalSupplyAssets: 0n, totalBorrowAssets: 0n }), 0);
  assert.equal(utilisation(null), 0);
  assert.equal(utilisation({ totalSupplyAssets: 1_000n, totalBorrowAssets: 250n }), 0.25);
});

test('borrowApyFromRatePerSecond compounds a WAD per-second rate, and keeps null null', () => {
  // A rate that compounds to about 5% a year.
  const ratePerSecond = BigInt(Math.round((Math.log1p(0.05) / 31_536_000) * 1e18));
  const apy = borrowApyFromRatePerSecond(ratePerSecond);
  assert.ok(Math.abs(apy - 0.05) < 1e-6, `expected ~5%, got ${apy}`);
  assert.equal(borrowApyFromRatePerSecond(0n), 0);
  // An IRM that did not answer must not look like a market paying nothing.
  assert.equal(borrowApyFromRatePerSecond(null), null);
  assert.equal(borrowApyFromRatePerSecond(undefined), null);
});

test('usdValue scales loan-token decimals against an 8-decimal price', () => {
  // 18.90 NVDA at $231.50 — the order of magnitude the recon actually found in the Morpho singleton.
  assert.ok(Math.abs(usdValue(18_900_000_000_000_000_000n, 18, 23_150_000_000n) - 4_375.35) < 0.01);
  assert.equal(usdValue(null, 18, 1n), null);
  assert.equal(usdValue(1n, null, 1n), null);
  assert.equal(usdValue(1n, 18, null), null);
});

test('consecutiveDailySamples counts the trailing run, not the total', () => {
  assert.equal(consecutiveDailySamples([]), 0);
  assert.equal(consecutiveDailySamples([{ date: '2026-09-20' }]), 1);
  assert.equal(consecutiveDailySamples([{ date: '2026-09-18' }, { date: '2026-09-19' }, { date: '2026-09-20' }]), 3);
  // A gap resets it: three weeks of history with a hole yesterday is not sustained borrowing.
  assert.equal(consecutiveDailySamples([{ date: '2026-09-01' }, { date: '2026-09-02' }, { date: '2026-09-20' }]), 1);
  // Two runs on the same day count once.
  assert.equal(consecutiveDailySamples([{ date: '2026-09-19' }, { date: '2026-09-20' }, { date: '2026-09-20' }]), 2);
});

const THRESHOLDS = { minStockOnLoanUsd: 250_000, minUtilisation: 0.2, minBorrowApy: 0.05, minConsecutiveDailySamples: 14 };

/** `days` consecutive days ending 2026-09-20, every one of them meeting the bar. */
const passingSamples = (days, overrides = {}) =>
  Array.from({ length: days }, (_, i) => ({
    date: new Date(Date.UTC(2026, 8, 20) - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10),
    totalStockOnLoanUsd: 400_000,
    maxUtilisation: 0.55,
    maxBorrowApy: 0.11,
    ...overrides,
  }));

test('the verdict is fail-closed: no samples at all is no-go', () => {
  assert.equal(verdictOf({ samples: [] }, THRESHOLDS).value, 'no-go');
  assert.equal(verdictOf({}, THRESHOLDS).value, 'no-go');
  assert.match(verdictOf({ samples: [] }, THRESHOLDS).reasons[0], /no sample/);
});

test('dust cannot trip the verdict', () => {
  // Longbow's NVDA market, LENDING-RECON §3: $6,579 supplied against $29.31 borrowed. Fourteen consecutive
  // days of it is still no-go, which is the whole point of an absolute floor beside a utilisation ratio.
  const dust = passingSamples(14, { totalStockOnLoanUsd: 29.31, maxUtilisation: 29.31 / 6_579, maxBorrowApy: 0.01 });
  const v = verdictOf({ samples: dust }, THRESHOLDS);
  assert.equal(v.value, 'no-go');
  assert.ok(v.reasons.some((r) => /below the \$250000 floor/.test(r)), v.reasons.join(' | '));
});

test('every threshold must be met AND the history must be long enough', () => {
  assert.equal(verdictOf({ samples: passingSamples(14) }, THRESHOLDS).value, 'go');
  // One day short.
  assert.equal(verdictOf({ samples: passingSamples(13) }, THRESHOLDS).value, 'no-go');
  // Size, utilisation and rate each fail alone.
  assert.equal(verdictOf({ samples: passingSamples(14, { totalStockOnLoanUsd: 249_999 }) }, THRESHOLDS).value, 'no-go');
  assert.equal(verdictOf({ samples: passingSamples(14, { maxUtilisation: 0.19 }) }, THRESHOLDS).value, 'no-go');
  // 3.63% is the Steakhouse USDG vault, the alternative the borrow rate has to beat.
  assert.equal(verdictOf({ samples: passingSamples(14, { maxBorrowApy: 0.0363 }) }, THRESHOLDS).value, 'no-go');
});

test('the verdict reads the NEWEST sample, so yesterday being good does not carry today', () => {
  const samples = [...passingSamples(14)];
  samples[samples.length - 1] = { ...samples[samples.length - 1], totalStockOnLoanUsd: 100 };
  assert.equal(verdictOf({ samples }, THRESHOLDS).value, 'no-go');
});

test('a go lists what it cleared, a no-go lists what it failed', () => {
  const go = verdictOf({ samples: passingSamples(14) }, THRESHOLDS);
  assert.equal(go.reasons.length, 4);
  const no = verdictOf({ samples: passingSamples(1, { totalStockOnLoanUsd: 0, maxUtilisation: 0, maxBorrowApy: 0 }) }, THRESHOLDS);
  assert.equal(no.reasons.length, 4);
});

test('drift catches a market appearing, disappearing, changing, and a verdict flip', () => {
  const market = { id: `0x${'aa'.repeat(32)}`, loanTicker: 'NVDA', loanToken: NVDA, collateralToken: USDG, oracle: ORACLE, irm: IRM, lltv: LLTV_625.toString() };
  const base = { stockLoanMarkets: [market], verdict: { value: 'no-go' }, morpho: { codeExists: true } };
  assert.deepEqual(drift(base, base), []);
  assert.deepEqual(drift(base, null), ['missing committed JSON']);
  // Utilisation and rate moving is expected between runs and must NOT be drift.
  assert.deepEqual(drift({ ...base, stockLoanMarkets: [{ ...market, utilisation: 0.9, borrowApy: 0.42 }] }, base), []);

  const appeared = drift({ ...base, stockLoanMarkets: [market, { ...market, id: `0x${'bb'.repeat(32)}` }] }, base);
  assert.ok(appeared.some((e) => /appeared/.test(e)), appeared.join(' | '));
  const disappeared = drift({ ...base, stockLoanMarkets: [] }, base);
  assert.ok(disappeared.some((e) => /disappeared/.test(e)), disappeared.join(' | '));
  const changed = drift({ ...base, stockLoanMarkets: [{ ...market, oracle: '0x00000000000000000000000000000000000000dd' }] }, base);
  assert.ok(changed.some((e) => /oracle\/IRM\/LLTV changed/.test(e)), changed.join(' | '));
  const flipped = drift({ ...base, verdict: { value: 'go' } }, base);
  assert.ok(flipped.some((e) => /verdict flipped/.test(e)), flipped.join(' | '));
  const lostCode = drift({ ...base, morpho: { codeExists: false } }, base);
  assert.ok(lostCode.some((e) => /code presence/.test(e)), lostCode.join(' | '));
});

test('the snapshot key set is exactly what the sibling doc task reads', () => {
  // Pinned in the task contract. If this list changes, the go/no-go doc breaks silently.
  assert.deepEqual(TOP_LEVEL_KEYS, [
    '_readme', 'checkedAt', 'chainId', 'rpc', 'observedBlock', 'morpho', 'thresholds',
    'venues', 'stockLoanMarkets', 'samples', 'ourPosition', 'perpAlternative', 'verdict',
  ]);
  const ok = Object.fromEntries(TOP_LEVEL_KEYS.map((k) => [k, null]));
  assert.equal(assertTopLevelKeys(ok), ok);
  // A dropped key, an extra key and a reordering are each caught.
  const { verdict, ...missing } = ok;
  assert.throws(() => assertTopLevelKeys(missing), /missing \[verdict\]/);
  assert.throws(() => assertTopLevelKeys({ ...ok, apy: 1 }), /unexpected \[apy\]/);
  const reordered = Object.fromEntries([...TOP_LEVEL_KEYS].reverse().map((k) => [k, null]));
  assert.throws(() => assertTopLevelKeys(reordered), /order /);
});

test('appendSample never rewrites or drops history', () => {
  const older = [{ date: '2026-09-18', totalStockOnLoanUsd: 1 }, { date: '2026-09-19', totalStockOnLoanUsd: 2 }];
  const next = appendSample(older, { date: '2026-09-20', totalStockOnLoanUsd: 3 });
  assert.equal(next.length, 3);
  assert.deepEqual(next.slice(0, 2), older);
  assert.equal(next[2].date, '2026-09-20');
  // The input array is not mutated, so a failed write cannot corrupt what is already committed.
  assert.equal(older.length, 2);
  // A first run has no history and still produces one sample.
  assert.equal(appendSample(undefined, { date: '2026-09-20' }).length, 1);
  assert.equal(appendSample(null, { date: '2026-09-20' }).length, 1);
});
