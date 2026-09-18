#!/usr/bin/env node
// Re-run R13 against Robinhood Chain's public RPC. No key or archive endpoint required.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(await readFile(path.join(here, '../markets/tier1.json'), 'utf8'));
const outputPath = path.join(here, '../markets/v2-sources.json');
const previous = await readFile(outputPath, 'utf8').then(JSON.parse).catch(() => null);
const check = process.argv.includes('--check');
const rpcUrl = process.env.RH_PUBLIC_RPC ?? 'https://rpc.mainnet.chain.robinhood.com';
const FACTORY = '0x1f7d7550b1b028f7571e69a784071f0205fd2efa';
const ROUTER = '0xcaf681a66d020601342297493863e78c959e5cb2';
const QUOTER = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7';
const VERIFIER = '0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7';
const PYTH_PRO = '0xACeA761c27A909d4D3895128EBe6370FDE2dF481';
const FEES = [100, 500, 3000, 10000];
const SEL = { getPool: '1698ee82', liquidity: '1a686502', slot0: '3850c7bd', observe: '883bdbfd',
  balanceOf: '70a08231', latestRoundData: 'feaf968c', getRoundData: '9a6fc8f5',
  decimals: '313ce567', token0: '0dfe1681', token1: 'd21220a7', feeManager: '38416b5b' };
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

const [[chainId, blockNumber], codes, streams] = await Promise.all([
  rpcMany([{ method: 'eth_chainId', params: [] }, { method: 'eth_blockNumber', params: [] }]),
  rpcMany([FACTORY, ROUTER, QUOTER, VERIFIER, PYTH_PRO].map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] }))),
  streamInventory(registry.markets),
]);
if (Number(BigInt(chainId)) !== 4663) throw new Error(`unexpected chain id ${chainId}`);
const contracts = Object.fromEntries([['factory', FACTORY], ['router', ROUTER], ['quoter', QUOTER], ['verifierProxy', VERIFIER], ['pythPro', PYTH_PRO]]
  .map(([name, address], i) => [name, { address, codeExists: codeExists(codes[i]) }]));
const feeManagerRaw = (await rpcMany([ethCall(VERIFIER, SEL.feeManager)]))[0];
contracts.verifierProxy.feeManager = feeManagerRaw ? addr(feeManagerRaw) : null;
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
if (check) {
  const changes = drift(data, previous);
  if (changes.length) { console.error(changes.join('\n')); process.exitCode = 1; }
  else console.error('R13 check: no material drift');
} else {
  await writeFile(outputPath, JSON.stringify(data, null, 2) + '\n');
  console.error(`wrote ${outputPath}`);
}
