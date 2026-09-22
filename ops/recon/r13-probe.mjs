#!/usr/bin/env node
// Re-run R13 against Robinhood Chain's public RPC. No key or archive endpoint required.
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(await readFile(path.join(here, '../markets/tier1.json'), 'utf8'));
const outputPath = path.join(here, '../markets/v2-sources.json');
const previous = await readFile(outputPath, 'utf8').then(JSON.parse).catch(() => null);
const check = process.argv.includes('--check');
const rpcUrl = process.env.RH_PUBLIC_RPC ?? 'https://rpc.mainnet.chain.robinhood.com';
// T-OP-131: RE-CASED, NOT RE-DERIVED, like V4_POOL_MANAGER below -- the same twenty bytes in the EIP-55 form
// `cast to-check-sum-address` prints, so the recon this probe writes (contracts.factory/router/quoter) carries
// the strings the strict readers accept and build-markets.mjs V2_SKELETON.uniswapV3 pins. The strict guard below
// covers these three too.
const FACTORY = '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA';
const ROUTER = '0xCaf681a66D020601342297493863E78C959E5cb2';
const QUOTER = '0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7';
const VERIFIER = '0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7';
const PYTH_PRO = '0xACeA761c27A909d4D3895128EBe6370FDE2dF481';
// T-600-LP: DERIVED ON CHAIN, not copied from a row description. eth_chainId -> 4663 and
// eth_getCode -> 24009 code bytes, against a positive control (0x...dEaD -> 0 bytes) so the check can
// fail. ops/recon/R12-overcall-discovery.md:121 records the same address and the same 24009; that
// column is the CODE SIZE, not a block number, and the size reproduces on chain today.
// T-608: RE-CASED, NOT RE-DERIVED. The same twenty bytes, now in EIP-55 form; five letters had the wrong
// case, which viem's isAddress(a, { strict: true }) rejects. `cast to-check-sum-address` and viem's
// checksumAddress produce this exact string independently. It survived because RPC and every lowercase
// comparison ignore case. The strict guard below refuses a regression before any RPC is sent.
const V4_POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
// v4StateView, the last key DeployV2Batch.sh dies on (T-OP-014). RE-DERIVED on chain before it was
// written, not taken from the row that supplied it: eth_chainId 0x1237 on
// https://rpc.mainnet.chain.robinhood.com; eth_getCode 3531 bytes here and 24009 at the pool manager;
// and the load-bearing one -- eth_call selector 0xdc4c90d3 `poolManager()` returns
// 0x8366a39cc670b4001a1121b8f6a443a643e40951, so THIS CONTRACT NAMES THE POOL MANAGER ALREADY IN THIS
// FILE. A table says where a thing is; that call says what it is.
const V4_STATE_VIEW = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b';
// T-600-LP then T-OP-014: BOTH v4 KEYS ARE NOW DERIVED AND APPENDED. NOTHING IS ABSENT.
//
// `DeployV8.s.sol:416-417` calls `_code()` on V2_V4_POOL_MANAGER and V2_V4_STATE_VIEW, and
// `DeployV2Batch.sh:312-313` reads BOTH out of the `contracts` block this file writes and dies by
// name when either is absent. So appending the pool manager alone does NOT unblock a v8 deploy -- the
// wrapper still dies, one key later, on `contracts.v4StateView.address ''`. That is stated here so
// nobody reads a half-filled file as a finished one.
//
// T-OP-014 RESOLVED THE ABOVE. `contracts.v4StateView` is now written, so DeployV2Batch.sh:312-313
// reads both keys and the wrapper no longer dies. The paragraph that follows is KEPT rather than
// deleted, because it is the record of what was tried and it names the route that finally worked --
// and because the next person to lose an address will want to know which five failed.
//
// HOW IT WAS SETTLED, and it is the second of the two routes the old note predicted: Uniswap's own v4
// deployment table for 4663. NOT trusted on sight. Three checks were re-run here before the value was
// written -- chainId 0x1237 first, so nothing later is trusted on the wrong endpoint; eth_getCode
// non-empty at the address; and the one that makes it load-bearing, eth_call 0xdc4c90d3
// `poolManager()` returning the pool manager ALREADY IN THIS FILE. The old note specified exactly that
// cross-check, and it is what turns a plausible address into a proven one.
//
// [HISTORY, T-600-LP] WHY v4StateView WAS ABSENT RATHER THAN PLACEHELD, and it was not the old reason. The network
// gate is LIFTED; the address simply could not be derived with the access available. Five routes were
// tried and each failed differently: it appears nowhere in this repository; `v2.uniswapV4` is null in
// tier1.json so there is no registry slot; every `v2.contracts` entry is null so no deployed contract
// exposes it; the blockscout API returns non-JSON from here; and the public RPC is NOT an archive node
// ("historical state ... is not available"), which kills the last real derivation -- binary-searching
// the pool manager's deploy block and scanning the neighbouring blocks for its sibling.
// WHAT WOULD SETTLE IT: Uniswap's own v4 deployment address for 4663, or an archive RPC. With an
// archive endpoint, test each contract creation near the pool manager's deploy with `poolManager()`
// (selector 0xdc4c90d3) and require it to return V4_POOL_MANAGER -- `IV4StateView` exposes that
// method, and the cross-check is what makes a found address load-bearing instead of merely plausible.
// A stand-in here would make THIS GENERATOR unrunnable for whoever gets that access, because every
// run would `eth_getCode` a non-address. An absent key fails closed at the wrapper; a broken probe
// blocks the fix instead of waiting for it.
//
// THE POSITIONAL CONSTRAINT STILL HOLDS AND I OBEYED IT. `codes` is positional and line ~345 reads
// `codes[4]` for `pythPro`. v4PoolManager is APPENDED at index 5 and v4StateView at index 6, in both
// the `codes` batch and the `contracts` map, so 0..4 are untouched. An INSERT would have silently re-pointed `codes[4]` at the
// pool manager and pythPro's deployed-or-not answer would describe a different contract entirely:
// green, wrong, and invisible.
const FEES = [100, 500, 3000, 10000];
const SEL = { getPool: '1698ee82', liquidity: '1a686502', slot0: '3850c7bd', observe: '883bdbfd',
  balanceOf: '70a08231', latestRoundData: 'feaf968c', getRoundData: '9a6fc8f5',
  decimals: '313ce567', token0: '0dfe1681', token1: 'd21220a7', feeManager: '38416b5b',
  // T-OP-108: `cast sig 'WETH9()'` -> 0x4aa4a4fc (SwapRouter02 and QuoterV2 both expose it).
  weth9: '4aa4a4fc' };
// T-OP-108: the fee tier of the USDG/WETH v3 pool the buyback's first leg swaps through (0.01 %). The
// contracts spike (callhouse-contracts docs/V2-FLYWHEEL-ROUTE-SPIKE.md) derived it as `factory.getPool(USDG,
// WETH, 100)`; DeployV2Batch.sh:354 reads the address as contracts.usdgWethV3Pool. All four tiers have a pool
// with code on 4663 (100/500/3000/10000, measured 2026-09-22 at block 69289315); this is the one the route uses.
const USDG_WETH_V3_FEE = 100;
// NYSE official hours/calendar, accessed 2026-09-16:
// https://www.nyse.com/trade/hours-calendars
const NYSE_DATES = {
  '2026': { fullDays: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'], earlyCloses: ['2026-11-27', '2026-12-24'] },
  '2027': { fullDays: ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'], earlyCloses: ['2027-11-26'] },
  '2028': { fullDays: ['2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19', '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25'], earlyCloses: ['2028-07-03', '2028-11-24'] },
};
// Cboe All Series, 2026-09-16 snapshot: nearest listed call strikes around each registry spot.
// https://cdn.cboe.com/data/us/options/market_statistics/symbol_reference/cone-all-series.csv
const CBOE_ATM_TICKS = { AAPL: 2.5, AMD: 2.5, AMZN: 2.5, ASML: 10, BABA: 1, CLSK: 0.5,
  COIN: 2.5, CRCL: 1, CRWV: 1, DELL: 2.5, EWY: 1, GME: 0.5, GOOGL: 2.5, INTC: 0.5,
  IONQ: 0.5, META: 2.5, MSFT: 2.5, MSTR: 1, MU: 5, NBIS: 2.5, NVDA: 2.5, ORCL: 1,
  PLTR: 2.5, QQQ: 1, RGTI: 0.5, RKLB: 1, SGOV: 1, SLV: 0.5, SNDK: 10, SPCX: 1,
  SPY: 1, TSLA: 2.5, TSM: 2.5, USAR: 0.5, USO: 1 };
const utcDayIndex = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
const nyseHolidays = Object.fromEntries(Object.entries(NYSE_DATES).map(([year, rows]) =>
  [year, Object.fromEntries(Object.entries(rows).map(([kind, dates]) => [kind, dates.map((date) => ({ date, dayIndex: utcDayIndex(date) }))]))]));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const addrWord = (v) => v.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const addr = (v) => `0x${v.slice(-40)}`;
const asWords = (v) => (v ?? '').replace(/^0x/, '').match(/.{64}/g) ?? [];
const median = (a) => !a.length ? null : [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) / 2)];
const local = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const nyParts = (ts) => Object.fromEntries(local.formatToParts(new Date(ts * 1000)).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
function lastTenSessions(ts) {
  const p = nyParts(ts);
  const start = Date.parse(`${p.year}-${p.month}-${p.day}T12:00:00Z`);
  const dates = [];
  const holidays = new Set(Object.values(NYSE_DATES).flatMap((v) => v.fullDays));
  for (let i = 0; dates.length < 10 && i < 30; i++) {
    const d = new Date(start - i * 86_400_000);
    const date = d.toISOString().slice(0, 10);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6 && !holidays.has(date)) dates.push(date);
  }
  return dates;
}

async function batch(calls, attempt = 0) {
  const requests = calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params }));
  try {
    const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requests), signal: AbortSignal.timeout(30_000) });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const replies = await res.json();
    if (!Array.isArray(replies)) throw new Error(`batch rejected: ${JSON.stringify(replies)}`);
    const byId = new Map(replies.map((v) => [v.id, v]));
    return calls.map((_, i) => byId.get(i + 1)?.result ?? null);
  } catch (e) {
    if (attempt >= 7) throw e;
    await sleep(Math.min(16_000, 600 * 2 ** attempt) + Math.random() * 250);
    return batch(calls, attempt + 1);
  }
}

async function rpcMany(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 20) out.push(...await batch(calls.slice(i, i + 20)));
  return out;
}
async function fetchJson(url, attempt = 0) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': 'stonkhouse-r13-recon/1.0' }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return await res.json();
  } catch (e) {
    if (attempt >= 5) throw e;
    await sleep(Math.min(16_000, 600 * 2 ** attempt));
    return fetchJson(url, attempt + 1);
  }
}

async function streamInventory(markets) {
  const tickers = markets.map((m) => m.ticker);
  const [catalog, discovery] = await Promise.all([
    fetchJson('https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-arbitrum-1.json'),
    fetchJson(`https://api.dataengine.chain.link/api/v1/discovery?status=live&base_asset=${tickers.join(',')}&attribute_type=RegularHoursEquityPrice`),
  ]);
  const visible = new Set((discovery.feeds ?? []).filter((f) => f.networkType === 'mainnet' && f.schemaVersion === 'V11')
    .map((f) => f.feedId.toLowerCase()));
  const byTicker = new Map();
  for (const r of catalog) {
    const ticker = r.docs?.baseAsset ?? r.pair?.[0];
    if (!tickers.includes(ticker) || r.docs?.marketHours !== 'US Equities Regular' ||
      !r.feedId?.startsWith('0x000b') || r.status !== 'live') continue;
    const current = byTicker.get(ticker);
    if (!current || (current.docs?.hidden && !r.docs?.hidden)) byTicker.set(ticker, r);
  }
  console.error(`Data Streams: ${byTicker.size}/${tickers.length} regular-hours v11 catalog IDs; ${visible.size} public Discovery IDs`);
  return new Map(tickers.map((ticker) => {
    const r = byTicker.get(ticker);
    return [ticker, { id: r?.feedId ?? null, publicDiscovery: r ? visible.has(r.feedId.toLowerCase()) : false,
      catalogChain: r?.sourceChain ?? null, catalogHidden: r?.docs?.hidden === true }];
  }));
}
const ethCall = (to, data) => ({ method: 'eth_call', params: [{ to, data: `0x${data}` }, 'latest'] });
const decodeUint = (data, at = 0) => { const w = asWords(data)[at]; return w ? BigInt(`0x${w}`) : null; };
const codeExists = (v) => v !== null && v !== '0x';

function decodeObserve(data) {
  if (!data) return null;
  const w = asWords(data);
  const offset = Number(BigInt(`0x${w[0] ?? '0'}`) / 32n);
  if (!w[offset] || Number(BigInt(`0x${w[offset]}`)) !== 2) return null;
  return [BigInt.asIntN(56, BigInt(`0x${w[offset + 1]}`)), BigInt.asIntN(56, BigInt(`0x${w[offset + 2]}`))];
}

async function poolInventory(markets) {
  const lookups = markets.flatMap((m) => FEES.map((fee) => ({ ticker: m.ticker, fee, asset: m.asset,
    call: ethCall(FACTORY, SEL.getPool + addrWord(registry.shared.usdg) + addrWord(m.asset) + word(fee)) })));
  const found = (await rpcMany(lookups.map((x) => x.call))).map((x, i) => ({ ...lookups[i], pool: x ? addr(x) : null }))
    .filter((x) => x.pool && !/^0x0{40}$/.test(x.pool));
  console.error(`Uniswap: ${found.length} pools across ${markets.length} markets`);
  const calls = found.flatMap((p) => [
    ethCall(p.pool, SEL.liquidity), ethCall(p.pool, SEL.slot0),
    ethCall(registry.shared.usdg, SEL.balanceOf + addrWord(p.pool)),
    ethCall(p.asset, SEL.balanceOf + addrWord(p.pool)),
    ethCall(p.pool, SEL.token0), ethCall(p.pool, SEL.token1),
    ethCall(p.pool, SEL.observe + word(32) + word(2) + word(1800) + word(0)),
  ]);
  const values = await rpcMany(calls);
  const byTicker = new Map(markets.map((m) => [m.ticker, []]));
  for (let i = 0; i < found.length; i++) {
    const p = found[i], v = values.slice(i * 7, i * 7 + 7);
    const sw = asWords(v[1]);
    const ticks = decodeObserve(v[6]);
    const token0 = v[4] ? addr(v[4]) : null;
    const token1 = v[5] ? addr(v[5]) : null;
    const tickDelta = ticks ? ticks[1] - ticks[0] : null;
    const avgTick = tickDelta === null ? null : Number(tickDelta < 0n && tickDelta % 1800n !== 0n
      ? tickDelta / 1800n - 1n : tickDelta / 1800n);
    const ratio = avgTick === null ? null : Math.pow(1.0001, avgTick);
    const usdgIsToken0 = token0?.toLowerCase() === registry.shared.usdg.toLowerCase();
    const twapUsd = ratio === null ? null : (usdgIsToken0 ? 1e12 / ratio : ratio * 1e12);
    const feedUsd = markets.find((m) => m.ticker === p.ticker).currentSpotUsd;
    const deviationBps = twapUsd === null ? null : Math.round(Math.abs(twapUsd / feedUsd - 1) * 10_000);
    const row = { address: p.pool, fee: p.fee, liquidity: decodeUint(v[0])?.toString() ?? null,
      usdgDepth: decodeUint(v[2]) === null ? null : Number(decodeUint(v[2])) / 1e6,
      assetBalance: decodeUint(v[3]) === null ? null : Number(decodeUint(v[3])) / 1e18,
      cardinality: sw[3] ? Number(BigInt(`0x${sw[3]}`)) : null,
      observationCardinalityNext: sw[4] ? Number(BigInt(`0x${sw[4]}`)) : null,
      observe1800: ticks !== null, twapUsd, deviationBps, token0, token1 };
    row.twap = row.observe1800 && row.usdgDepth >= 250_000 && row.cardinality >= 300 && deviationBps <= 100
      ? 'usable' : 'thin';
    byTicker.get(p.ticker).push(row);
  }
  return byTicker;
}

function decodeRound(data) {
  const w = asWords(data);
  if (w.length < 5) return null;
  return { id: BigInt(`0x${w[0]}`), answer: BigInt.asIntN(256, BigInt(`0x${w[1]}`)), updatedAt: Number(BigInt(`0x${w[3]}`)) };
}

async function roundHistory(market) {
  const latestRaw = (await rpcMany([ethCall(market.feed, SEL.latestRoundData)]))[0];
  const latest = decodeRound(latestRaw);
  if (!latest) throw new Error(`${market.ticker}: latestRoundData failed`);
  const phase = latest.id >> 64n;
  const rounds = [latest];
  let next = latest.id - 1n;
  const oldestWindowDate = lastTenSessions(latest.updatedAt).at(-1);
  while (rounds.length < 200 || `${nyParts(rounds.at(-1).updatedAt).year}-${nyParts(rounds.at(-1).updatedAt).month}-${nyParts(rounds.at(-1).updatedAt).day}` > oldestWindowDate) {
    if ((next >> 64n) !== phase || rounds.length >= 1200) break;
    const ids = [];
    for (let i = 0; i < 20 && (next >> 64n) === phase; i++, next--) ids.push(next);
    const results = await rpcMany(ids.map((id) => ethCall(market.feed, SEL.getRoundData + word(id))));
    for (const v of results) { const r = decodeRound(v); if (r && r.updatedAt > 0) rounds.push(r); }
    if (results.every((v) => v === null)) break;
  }
  const first200 = rounds.slice(0, 200);
  const jumps = first200.slice(0, -1).map((r, i) => {
    const older = first200[i + 1];
    return older.answer > 0n ? { bps: Math.round(Math.abs(Number(r.answer) / Number(older.answer) - 1) * 10_000),
      newerRoundId: r.id.toString(), olderRoundId: older.id.toString(), newerAnswer: r.answer.toString(), olderAnswer: older.answer.toString(),
      newerUpdatedAt: r.updatedAt, olderUpdatedAt: older.updatedAt } : null;
  }).filter((v) => v !== null).sort((a, b) => b.bps - a.bps);
  const sessionDates = lastTenSessions(latest.updatedAt);
  const sessions = new Map(sessionDates.map((date) => [date, 0]));
  const hourBuckets = new Map(sessionDates.flatMap((date) => [10, 11, 12, 13, 14, 15].map((hour) => [`${date}-${hour}`, 0])));
  for (const r of rounds) {
    const p = nyParts(r.updatedAt);
    const day = `${p.year}-${p.month}-${p.day}`;
    const hm = Number(p.hour) * 60 + Number(p.minute);
    if (hm < 570 || hm > 960) continue;
    if (sessions.has(day) && hm >= 930 && hm < 960) sessions.set(day, sessions.get(day) + 1);
    if (hm >= 600 && hm < 960) {
      const key = `${day}-${Number(p.hour)}`;
      if (hourBuckets.has(key)) hourBuckets.set(key, hourBuckets.get(key) + 1);
    }
  }
  const last10 = [...sessions];
  return { latestRoundId: latest.id.toString(), latestUpdatedAt: latest.updatedAt,
    phase: phase.toString(), scanned: rounds.length,
    roundsPerTradingHourP50: median([...hourBuckets.values()]),
    roundsPerTradingHourMean: Number(([...hourBuckets.values()].reduce((a, b) => a + b, 0) / hourBuckets.size).toFixed(2)),
    maxRoundJumpBps200: jumps[0]?.bps ?? null, maxRoundJump200: jumps[0] ?? null,
    roundsPerWindowP50: median(last10.map((x) => x[1])),
    maxRoundsPerWindow: Math.max(...last10.map((x) => x[1])),
    closeWindows: Object.fromEntries(last10),
    decrementWithinPhase: first200.every((r, i) => i === 0 || r.id === first200[i - 1].id - 1n),
    historyReachesTenSessions: `${nyParts(rounds.at(-1).updatedAt).year}-${nyParts(rounds.at(-1).updatedAt).month}-${nyParts(rounds.at(-1).updatedAt).day}` <= oldestWindowDate };
}

function heuristicStrikeTick(spot) { return spot < 25 ? 0.25 : spot < 100 ? 0.5 : spot < 250 ? 1 : 5; }

function validate(data) {
  const fail = (why) => { throw new Error(`v2-sources schema: ${why}`); };
  if (data.chainId !== 4663 || !Array.isArray(data.markets) || data.markets.length !== 35) fail('chain/market count');
  const names = new Set();
  for (const m of data.markets) {
    if (names.has(m.ticker) || !/^[A-Z]+$/.test(m.ticker)) fail(`ticker ${m.ticker}`);
    names.add(m.ticker);
    if (!['usable', 'thin', 'none'].includes(m.twap) || !Number.isFinite(m.strikeTick) || m.strikeTick <= 0) fail(`${m.ticker} classification/tick`);
    if (!/^0x[\da-fA-F]{40}$/.test(m.asset) || !/^0x[\da-fA-F]{40}$/.test(m.feed)) fail(`${m.ticker} addresses`);
    if (!Number.isFinite(m.spotUsd) || m.spotUsd <= 0 || !Number.isInteger(m.spotUpdatedAt)) fail(`${m.ticker} spot`);
    if (m.univ3Pool !== null && !/^0x[\da-fA-F]{40}$/.test(m.univ3Pool)) fail(`${m.ticker} pool`);
    if (m.dataStreamsFeedId !== null && !/^0x[\da-fA-F]{64}$/.test(m.dataStreamsFeedId)) fail(`${m.ticker} stream id`);
    if (m.roundsPerWindowP50 !== null && (!Number.isInteger(m.roundsPerWindowP50) || m.roundsPerWindowP50 < 0)) fail(`${m.ticker} rounds`);
    if (!Array.isArray(m.pools)) fail(`${m.ticker} pools`);
    for (const p of m.pools) {
      if (!/^0x[\da-fA-F]{40}$/.test(p.address) || !FEES.includes(p.fee) || !['usable', 'thin'].includes(p.twap)) fail(`${m.ticker} pool row`);
      if (p.usdgDepth !== null && (!Number.isFinite(p.usdgDepth) || p.usdgDepth < 0)) fail(`${m.ticker} depth`);
      if (p.assetBalance !== null && (!Number.isFinite(p.assetBalance) || p.assetBalance < 0)) fail(`${m.ticker} token balance`);
    }
  }
  if (!data.providers || !data.nyseHolidays || !data.roundHistory) fail('top-level metadata');
  for (const key of ['gelato', 'chainlinkAutomation', 'pyth', 'pythCore', 'pythPro']) if (typeof data.providers[key] !== 'boolean') fail(`provider ${key}`);
  for (const year of ['2026', '2027', '2028']) {
    const group = data.nyseHolidays[year];
    if (!group || !Array.isArray(group.fullDays) || !Array.isArray(group.earlyCloses)) fail(`NYSE ${year}`);
    for (const row of [...group.fullDays, ...group.earlyCloses]) {
      if (!/^\d{4}-\d\d-\d\d$/.test(row.date) || row.dayIndex !== utcDayIndex(row.date)) fail(`NYSE day ${row.date}`);
    }
  }
  for (const ticker of ['NVDA', 'TSLA', 'SPY', 'SGOV']) {
    const h = data.roundHistory[ticker];
    if (!h || !Number.isInteger(h.scanned) || h.scanned < 1 || !h.decrementWithinPhase || Object.keys(h.closeWindows).length !== 10) fail(`round history ${ticker}`);
  }
  return data;
}

function drift(now, old) {
  if (!old) return ['missing committed JSON'];
  const errors = [];
  for (const m of now.markets) {
    const p = old.markets.find((x) => x.ticker === m.ticker);
    if (!p) { errors.push(`${m.ticker}: absent`); continue; }
    if (m.univ3Pool?.toLowerCase() !== p.univ3Pool?.toLowerCase() || m.fee !== p.fee || m.twap !== p.twap) errors.push(`${m.ticker}: pool or TWAP classification changed`);
    if (p.usdgDepth && m.usdgDepth && Math.abs(m.usdgDepth / p.usdgDepth - 1) > 0.25) errors.push(`${m.ticker}: USDG depth >25% drift`);
    if (p.cardinality && m.cardinality && m.cardinality < Math.min(300, p.cardinality)) errors.push(`${m.ticker}: cardinality fell`);
    if (m.dataStreamsFeedId !== p.dataStreamsFeedId || m.strikeTick !== p.strikeTick) errors.push(`${m.ticker}: static config drift`);
  }
  if (JSON.stringify(now.providers) !== JSON.stringify(old.providers)) errors.push('provider metadata drift');
  if (JSON.stringify(now.nyseHolidays) !== JSON.stringify(old.nyseHolidays)) errors.push('NYSE calendar drift');
  return errors;
}

// T-608: STRICT EIP-55 GUARD over every address this probe pins or emits. validate() only regex-checks
// shape, so a mis-cased constant passed it and was published into v2-sources.json verbatim.
//
// THE RULE IS viem's isAddress(a, { strict: true }), mirrored line for line from viem 2.x
// utils/address/isAddress.js: well-formed, and then either all-lowercase (unchecksummed is legal) or
// exactly equal to its own EIP-55 form. NOT getAddress / to-check-sum-address as a validator: both
// NORMALISE, so a corrupted checksum goes in and a corrected address comes out with no error.
//
// The EIP-55 form comes from `cast to-check-sum-address`, the helper build-markets.mjs:677-679 and
// DeployV2Batch.sh:180 already use (not exported, so it cannot be imported). Its input is lowercased first
// so the answer never depends on the casing handed to it. No cast means exit 2: the guard fails closed
// instead of passing unchecked.
//
// Every candidate is found by SCANNING rather than by a hand-kept list: this file's own source for pinned
// literals, and the whole generated object for emitted values. A list is one more thing the next constant
// must remember to join, and a check that cannot see its subject passes.
//
// Runnable with NO network, so it can be proven by breaking:
//   --addresses          every address literal in this file, plus the tier1.json asset/feed values this
//                        probe copies into its output. Exit 0 valid, 1 refused (naming each), 2 unable.
//   --audit <file.json>  the same check over every address-shaped string in a JSON file, e.g. the
//                        committed ops/markets/v2-sources.json.
const ADDRESS = /^0x[\da-fA-F]{40}$/;
const checksums = new Map();
function checksum(a) {
  const key = a.toLowerCase();
  if (!checksums.has(key)) {
    checksums.set(key, execFileP('cast', ['to-check-sum-address', key]).then(({ stdout }) => stdout.trim(), (e) => {
      throw Object.assign(new Error(`address guard unable: cast to-check-sum-address failed (${e.code ?? e.message})`), { unable: true });
    }));
  }
  return checksums.get(key);
}
async function isStrictAddress(a) {
  if (typeof a !== 'string' || !ADDRESS.test(a)) return false;
  if (a.toLowerCase() === a) return true;
  return (await checksum(a)) === a;
}
async function refuseNonStrict(pairs, where) {
  // One `cast` process per distinct mixed-case address; start them all before awaiting any, so a 366-address
  // audit costs one spawn's latency per CPU rather than one per address. `checksum` memoises by lowercase
  // key, so this is the same set of processes the sequential loop would have run, just not one at a time.
  await Promise.allSettled(pairs.filter(([, v]) => ADDRESS.test(v) && v.toLowerCase() !== v).map(([, v]) => checksum(v)));
  const issues = [];
  for (const [label, value] of pairs) {
    if (await isStrictAddress(value)) continue;
    issues.push(ADDRESS.test(value) ? `${label} ${value} is not EIP-55 (checksum form ${await checksum(value)})` : `${label} ${value} is not an address`);
  }
  if (issues.length) {
    throw Object.assign(new Error(`address guard refused ${issues.length} of ${pairs.length} in ${where}:\n  ${issues.join('\n  ')}`), { refused: true });
  }
  return pairs.length;
}
// A `const NAME = '0x...'` of the wrong length is returned too, so a truncated constant is refused as "not
// an address" rather than being invisible to a scan that only matches forty hex digits.
function sourceLiterals(source) {
  return source.split('\n').flatMap((line, i) => {
    const named = line.match(/^const ([A-Z0-9_]+) = '(0x[\da-fA-F]*)';/);
    const label = named ? `pinned ${named[1]} (r13-probe.mjs:${i + 1})` : `literal at r13-probe.mjs:${i + 1}`;
    const found = [...line.matchAll(/(?<![\da-fA-Fx])0x[\da-fA-F]{40}(?![\da-fA-F])/g)].map(([a]) => [label, a]);
    return named && !ADDRESS.test(named[2]) ? [...found, [label, named[2]]] : found;
  });
}
function addressStrings(value, at = '') {
  if (typeof value === 'string') return ADDRESS.test(value) ? [[at, value]] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => addressStrings(v, `${at}[${i}]`));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => addressStrings(v, at ? `${at}.${k}` : k));
  return [];
}

const pinned = sourceLiterals(await readFile(fileURLToPath(import.meta.url), 'utf8'));
const auditAt = process.argv.indexOf('--audit');
if (process.argv.includes('--addresses') || auditAt !== -1) {
  try {
    const lines = [`${await refuseNonStrict(pinned, 'r13-probe.mjs')} literal(s) in r13-probe.mjs: ${pinned.map(([label]) => label.replace(/^pinned /, '')).join(', ')}`];
    const inputs = registry.markets.flatMap((m) => [[`tier1.json ${m.ticker}.asset`, m.asset], [`tier1.json ${m.ticker}.feed`, m.feed]]);
    lines.push(`${await refuseNonStrict(inputs, 'tier1.json')} tier1.json asset/feed value(s) this probe emits`);
    if (auditAt !== -1) {
      const file = process.argv[auditAt + 1];
      if (!file || file.startsWith('--')) throw Object.assign(new Error('--audit needs a JSON file path'), { unable: true });
      const audited = addressStrings(JSON.parse(await readFile(file, 'utf8')));
      lines.push(`${await refuseNonStrict(audited, file)} address string(s) in ${file}`);
    }
    console.error(`address guard: all strict EIP-55\n  ${lines.join('\n  ')}`);
    process.exit(0);
  } catch (e) {
    console.error(e.message);
    process.exit(e.refused ? 1 : 2);
  }
}
// Pinned literals are checked on EVERY run, before the first RPC: a mis-cased constant stops the probe here
// instead of being written into the output. The refusal is printed as the one-line verdict the guard produced,
// not as an uncaught stack trace, and exits 1 (refused) or 2 (cast unavailable) like the --addresses mode.
async function guardOrExit(pairs, where) {
  try {
    await refuseNonStrict(pairs, where);
  } catch (e) {
    console.error(e.message);
    process.exit(e.refused ? 1 : 2);
  }
}
await guardOrExit(pinned, 'r13-probe.mjs');

const [[chainId, blockNumber], codes, streams] = await Promise.all([
  rpcMany([{ method: 'eth_chainId', params: [] }, { method: 'eth_blockNumber', params: [] }]),
  rpcMany([FACTORY, ROUTER, QUOTER, VERIFIER, PYTH_PRO, V4_POOL_MANAGER, V4_STATE_VIEW].map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] }))),
  streamInventory(registry.markets),
]);
if (Number(BigInt(chainId)) !== 4663) throw new Error(`unexpected chain id ${chainId}`);
const contracts = Object.fromEntries([['factory', FACTORY], ['router', ROUTER], ['quoter', QUOTER], ['verifierProxy', VERIFIER], ['pythPro', PYTH_PRO], ['v4PoolManager', V4_POOL_MANAGER], ['v4StateView', V4_STATE_VIEW]]
  .map(([name, address], i) => [name, { address, codeExists: codeExists(codes[i]) }]));
const feeManagerRaw = (await rpcMany([ethCall(VERIFIER, SEL.feeManager)]))[0];
contracts.verifierProxy.feeManager = feeManagerRaw ? addr(feeManagerRaw) : null;
// T-OP-108. TWO ADDRESSES THE WRAPPER READS THAT THIS RECON NEVER WROTE. DeployV2Batch.sh:354 dies on
// `contracts.weth.address` and `contracts.usdgWethV3Pool.address` being absent; T-OP-038 copied both into the
// contracts fixture from the spike doc because they were not here. Derived, not typed: WETH is what the
// router says it wraps (`SwapRouter02.WETH9()`), the pool is what the factory returns for (USDG, WETH,
// USDG_WETH_V3_FEE), and both are code-checked like every other contracts.* entry. Checksummed through the
// same `cast to-check-sum-address` path the guard below verifies against.
const [wethRaw] = await rpcMany([ethCall(ROUTER, SEL.weth9)]);
if (!wethRaw || wethRaw === '0x') throw new Error('SwapRouter02.WETH9() answered nothing');
const weth = await checksum(addr(wethRaw));
const [usdgWethPoolRaw] = await rpcMany([ethCall(FACTORY, SEL.getPool + addrWord(registry.shared.usdg) + addrWord(weth) + word(USDG_WETH_V3_FEE))]);
if (!usdgWethPoolRaw || addr(usdgWethPoolRaw) === `0x${'0'.repeat(40)}`) throw new Error(`factory.getPool(USDG, WETH, ${USDG_WETH_V3_FEE}) is the zero address`);
const usdgWethV3Pool = await checksum(addr(usdgWethPoolRaw));
const [wethCode, usdgWethPoolCode] = await rpcMany([weth, usdgWethV3Pool].map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] })));
contracts.weth = { address: weth, codeExists: codeExists(wethCode) };
contracts.usdgWethV3Pool = { address: usdgWethV3Pool, codeExists: codeExists(usdgWethPoolCode) };
const currentFeedRounds = await rpcMany(registry.markets.map((m) => ethCall(m.feed, SEL.latestRoundData)));
const currentMarkets = registry.markets.map((m, i) => {
  const round = decodeRound(currentFeedRounds[i]);
  if (!round || round.answer <= 0n) throw new Error(`${m.ticker}: live feed unavailable`);
  return { ...m, currentSpotUsd: Number(round.answer) / 1e8, currentSpotUpdatedAt: round.updatedAt };
});
const pools = await poolInventory(currentMarkets);
const markets = currentMarkets.map((m) => {
  const all = pools.get(m.ticker).sort((a, b) => (a.twap === 'usable' ? -1 : 0) - (b.twap === 'usable' ? -1 : 0) || b.usdgDepth - a.usdgDepth);
  const best = all[0] ?? null;
  return { ticker: m.ticker, asset: m.asset, feed: m.feed, spotUsd: m.currentSpotUsd,
    spotUpdatedAt: m.currentSpotUpdatedAt,
    univ3Pool: best?.address ?? null, fee: best?.fee ?? null, twap: best?.twap ?? 'none',
    usdgDepth: best?.usdgDepth ?? null, cardinality: best?.cardinality ?? null,
    dataStreamsFeedId: streams.get(m.ticker).id,
    dataStreamsPublicDiscovery: streams.get(m.ticker).publicDiscovery,
    dataStreamsCatalogChain: streams.get(m.ticker).catalogChain,
    dataStreamsCatalogHidden: streams.get(m.ticker).catalogHidden,
    strikeTick: CBOE_ATM_TICKS[m.ticker] ?? heuristicStrikeTick(m.currentSpotUsd),
    heuristicStrikeTick: heuristicStrikeTick(m.currentSpotUsd),
    roundsPerWindowP50: null, pools: all };
});
const roundHistoryByTicker = {};
for (const ticker of ['NVDA', 'TSLA', 'SPY', 'SGOV']) {
  console.error(`Chainlink rounds: ${ticker}`);
  const m = registry.markets.find((x) => x.ticker === ticker);
  const history = await roundHistory(m);
  roundHistoryByTicker[ticker] = history;
  markets.find((x) => x.ticker === ticker).roundsPerWindowP50 = history.roundsPerWindowP50;
}
const data = validate({ _readme: 'R13 recon; generated by ops/recon/r13-probe.mjs. Dynamic values sampled at observedBlock. Static research evidence in ops/recon/R13-v2-sources.md.',
  checkedAt: new Date().toISOString(), chainId: 4663, rpc: rpcUrl, observedBlock: Number(BigInt(blockNumber)),
  contracts, providers: { gelato: false, chainlinkAutomation: false, pyth: true, pythCore: false, pythPro: codeExists(codes[4]) },
  nyseHolidays,
  roundHistory: roundHistoryByTicker, markets });
// T-608: every address-shaped string in the output, found by walking it rather than by naming fields, is
// strict EIP-55 before anything is written or compared.
await guardOrExit(addressStrings(data), 'the generated v2-sources data');
if (check) {
  const changes = drift(data, previous);
  if (changes.length) { console.error(changes.join('\n')); process.exitCode = 1; }
  else console.error('R13 check: no material drift');
} else {
  await writeFile(outputPath, JSON.stringify(data, null, 2) + '\n');
  console.error(`wrote ${outputPath}`);
}
