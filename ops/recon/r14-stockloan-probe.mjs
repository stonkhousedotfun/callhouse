#!/usr/bin/env node
// R14 — stock-loan borrow-demand probe (board P8-04, measurement half).
//
// Answers one question with on-chain reads: is anybody actually borrowing Stock Tokens on chain 4663?
// Writes ops/recon/r14-stockloan-demand.json, an append-only snapshot whose `verdict` is the go/no-go
// the sibling doc task cites. The bar the recon set is SUSTAINED borrowing, not a snapshot
// (v8-plan/tasks/P-periphery.md, P8-04), so a single healthy reading can never produce "go" on its own.
//
//   node ops/recon/r14-stockloan-probe.mjs            sample once and rewrite the JSON (appending the sample)
//   node ops/recon/r14-stockloan-probe.mjs --check    compare a live run against the committed JSON, exit 1 on drift
//
// NO npm DEPENDENCIES, and deliberately NO viem. v8-plan status ledger entry T-74 records a stubbed viem
// whose identity `checksumAddress` made assertions PASS instead of fail; every JS-side result from before
// 2026-09-19 20:40 is suspect for that reason. Raw JSON-RPC cannot be stubbed out from under this file.
// Batching, backoff and the chain-id assertion are lifted from ops/recon/r13-probe.mjs:60-80,287.
//
// MIRROR, DO NOT RE-REASON. Every constant that exists elsewhere is read from its source:
//   - Stock Token addresses and their Chainlink feeds  -> ops/markets/tier1.json (ops/markets/README.md:4:
//     "nothing else may hard-code a ticker, a token, a feed or a factory").
//   - RPC URL and chain id                             -> the r13 precedent, r13-probe.mjs:12 and :287.
//   - Every selector and event topic below             -> derived with `cast sig` / `cast keccak`, see PINS.
//
// PINS — derived 2026-09-20 with foundry `cast`, never copied out of a document. INTERFACE-CHANGES-V8
// Entry 2 records `take`/`quoteTake` published as 0x42e3b3d7/0xc4b1417b when they are actually
// 0xcf96851b/0xe2e13f01, because 25 assertions shipped unexecuted. These were executed:
//
//   cast keccak 'CreateMarket(bytes32,(address,address,address,address,uint256))'
//     -> 0xac4b2400f169220b0c0afdde7a0b32e775ba727ea1cb30b35f935cdaab8683ac
//   cast sig 'market(bytes32)'                       -> 0x5c60e39a
//   cast sig 'idToMarketParams(bytes32)'             -> 0x2c3c9157
//   cast sig 'decimals()'                            -> 0x313ce567
//   cast sig 'symbol()'                              -> 0x95d89b41
//   cast sig 'balanceOf(address)'                    -> 0x70a08231
//   cast sig 'latestRoundData()'                     -> 0xfeaf968c
//   cast sig 'getParams()'                           -> 0x5e615a6b
//   cast sig 'nextLoanId()'                          -> 0x87c51459
//   cast sig 'borrowRateView((address,address,address,address,uint256),(uint128,uint128,uint128,uint128,uint128,uint128))'
//     -> 0x8c00bf6b
//
// `decimals()` and `balanceOf(address)` agree with the independently written table at r13-probe.mjs:21-23,
// which is the cheapest available cross-check that the derivation itself is not systematically wrong.
//
// THE THRESHOLDS ARE PROPOSED, NOT APPROVED. `thresholds` in the JSON is the only place the bar appears as
// numbers; the sibling doc task cites these keys and restates no number. Who proposed each and on what
// evidence is in THRESHOLDS below. The owner has not signed off on any of them.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const registryPath = path.join(here, '../markets/tier1.json');
const outputPath = path.join(here, 'r14-stockloan-demand.json');
const check = process.argv.includes('--check');
const rpcUrl = process.env.RH_PUBLIC_RPC ?? 'https://rpc.mainnet.chain.robinhood.com';

// Morpho Blue on 4663. NOT the canonical 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb, which has NO CODE on
// this chain: v8-plan/06-QUIRKS.md §H last bullet and LENDING-RECON-2026-09-19.md §2 row "Morpho canonical
// address" both record `eth_getCode` returning `0x`. A probe that reports zeros because it queried an
// address with no code is the worst outcome this file can produce, so getCode is asserted before any read.
const MORPHO = '0x9D53d5E3bd5E8d4Cbfa6DB1ca238AEA02E651010';
const MORPHO_CANONICAL_NO_CODE = '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb';
// Morpho Blue's first market on 4663 was created at block 287 (LENDING-RECON §2, Morpho Blue row), so the
// log scan starts there rather than at 0.
const MORPHO_FIRST_BLOCK = 287;

// Hedgehood StockLend, the one named non-Morpho venue that actually lends Stock Tokens out
// (LENDING-RECON §4). That table is a DOC and its bytecode is unverified on the explorer, so every address
// here is a CANDIDATE: each is eth_getCode'd and recorded with codeExists true/false rather than dropped,
// and anything that does not decode is recorded null rather than guessed.
const HEDGEHOOD_STOCKLEND = [
  { ticker: 'NVDA', address: '0x426A79a122c6A0A47fE2F5c5F41C4BC4d102c414' },
  { ticker: 'GME', address: '0x8e8f3CC988e0D56C52a49F3055aacd62ef1b970c' },
  { ticker: 'SPCX', address: '0x4977c00783605750789cEEc5A3cbfaEDA3f015DB' },
  { ticker: 'MU', address: '0x0Ac2B1411E4c0623D936DD3E8586eA5EeF1eADB2' },
  { ticker: 'CRCL', address: '0x5C88B4f4a1acBBb1E5E63d4414bc194477bD2A7a' },
  { ticker: 'USO', address: '0x6Ddc8f2dE5DCe2ff2EAc2c12CD96C936948C2912' },
];

const TOPIC_CREATE_MARKET = '0xac4b2400f169220b0c0afdde7a0b32e775ba727ea1cb30b35f935cdaab8683ac';
const SEL = {
  market: '5c60e39a',
  idToMarketParams: '2c3c9157',
  decimals: '313ce567',
  balanceOf: '70a08231',
  latestRoundData: 'feaf968c',
  borrowRateView: '8c00bf6b',
  getParams: '5e615a6b',
  nextLoanId: '87c51459',
};

const SECONDS_PER_YEAR = 31_536_000;

/**
 * The snapshot's top-level key set, in order. PINNED: the sibling go/no-go doc task reads these by name,
 * so adding, renaming or dropping one after submission breaks it. The probe asserts the object it is about
 * to write matches this list exactly, which turns "someone edited the builder" into a throw instead of a
 * silently different file.
 */
export const TOP_LEVEL_KEYS = [
  '_readme', 'checkedAt', 'chainId', 'rpc', 'observedBlock', 'morpho', 'thresholds',
  'venues', 'stockLoanMarkets', 'samples', 'ourPosition', 'perpAlternative', 'verdict',
];

/** Throws unless `snapshot` carries exactly TOP_LEVEL_KEYS, in order. */
export function assertTopLevelKeys(snapshot) {
  const got = Object.keys(snapshot ?? {});
  const missing = TOP_LEVEL_KEYS.filter((k) => !got.includes(k));
  const extra = got.filter((k) => !TOP_LEVEL_KEYS.includes(k));
  if (missing.length || extra.length || got.join(',') !== TOP_LEVEL_KEYS.join(',')) {
    throw new Error(`snapshot key set drifted: missing [${missing}], unexpected [${extra}], order ${got.join(',')}`);
  }
  return snapshot;
}

/**
 * APPEND-ONLY. Earlier samples are carried forward untouched and the new one goes last; nothing is ever
 * rewritten or dropped. The bar is sustained borrowing, so a run that clobbers history makes the go/no-go
 * permanently unanswerable — there is no way to re-read a day that has passed.
 */
export function appendSample(previousSamples, sample) {
  return [...(previousSamples ?? []), sample];
}

/**
 * The bar. PROPOSED by the author of this file on the evidence named beside each number, on 2026-09-20.
 * NOT owner-approved, and deliberately not presented as such.
 *
 * minStockOnLoanUsd 250000 — every borrow figure the recon found is dust by four orders of magnitude:
 *   Longbow's NVDA market is $6,579 supplied against $29.31 borrowed (LENDING-RECON §3) and Kyros shows $7
 *   of NVDA borrowed (§2 table). 250k is the same order as the $317.4K of USDG already parked against NVDA
 *   collateral (§2), i.e. the size the chain has already demonstrated it can hold in one stock market.
 * minUtilisation 0.20 — Morpho's adaptive IRM targets 90% utilisation (§7); the four large curator markets
 *   created 2026-09-09 sit at about 0.04% (§2). 20% is the lowest level at which a supplier earns most of
 *   the time rather than occasionally.
 * minBorrowApy 0.05 — it must beat what the same capital earns doing nothing: the Steakhouse USDG vault is
 *   $486.4M at 3.63% APY (§2 table, §1.6). 5% carries a margin over that for the weekend oracle-gap risk
 *   §5 describes, which is a real cost of lending stock specifically.
 * minConsecutiveDailySamples 14 — the recon's bar is "sustained borrowing, not a snapshot"
 *   (tasks/P-periphery.md P8-04). Two weeks spans two weekly option rolls and two weekend oracle gaps, so a
 *   fortnight of daily samples is the shortest window that can show demand surviving both.
 */
const THRESHOLDS = {
  minStockOnLoanUsd: 250_000,
  minUtilisation: 0.2,
  minBorrowApy: 0.05,
  minConsecutiveDailySamples: 14,
  proposedBy: 'r14-stockloan-probe.mjs author, 2026-09-20; evidence in the file header; NOT owner-approved',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const asWords = (v) => (v ?? '').replace(/^0x/, '').match(/.{64}/g) ?? [];
const addr = (v) => `0x${v.slice(-40)}`;
const addrWord = (v) => v.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const word = (v) => BigInt(v).toString(16).padStart(64, '0');
const hex = (n) => `0x${BigInt(n).toString(16)}`;
const codeExists = (v) => v !== null && v !== '0x';
const ethCall = (to, data) => ({ method: 'eth_call', params: [{ to, data: `0x${data}` }, 'latest'] });

/** r13-probe.mjs:60-75. Throws on 429/5xx and on a non-array reply; never returns a silent null for those. */
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

/** r13-probe.mjs:77-80: at most 20 JSON-RPC calls per HTTP batch. */
async function rpcMany(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 20) out.push(...await batch(calls.slice(i, i + 20)));
  return out;
}

const rpcOne = async (call) => (await batch([call]))[0];

/**
 * eth_getLogs over a span the node will actually serve. A public RPC caps the block range and answers a
 * too-wide window with a JSON-RPC error, which `batch` surfaces as a null result; halve and retry rather
 * than accept the null, because an empty market list from a refused query is indistinguishable from an
 * empty market list from a healthy chain — and that mistake is exactly what this file exists to avoid.
 */
async function getLogsChunked(address, topics, fromBlock, toBlock, span = 200_000) {
  const logs = [];
  let from = fromBlock;
  while (from <= toBlock) {
    const to = Math.min(from + span - 1, toBlock);
    const result = await rpcOne({ method: 'eth_getLogs', params: [{ address, topics, fromBlock: hex(from), toBlock: hex(to) }] });
    if (result === null) {
      if (span <= 1_000) throw new Error(`eth_getLogs refused ${from}..${to} at the minimum span; the endpoint cannot serve this scan`);
      return [...logs, ...await getLogsChunked(address, topics, from, toBlock, Math.floor(span / 2))];
    }
    logs.push(...result);
    from = to + 1;
  }
  return logs;
}

/* ------------------------------------------------------------------ decoders (unit-tested, no network) */

/**
 * A CreateMarket log. `id` is topic1; MarketParams is a fully static struct, so the data is its five
 * words inline with no offset word.
 */
export function decodeCreateMarket(log) {
  const w = asWords(log?.data);
  if (!log?.topics?.[1] || w.length < 5) return null;
  return {
    id: log.topics[1],
    loanToken: addr(w[0]),
    collateralToken: addr(w[1]),
    oracle: addr(w[2]),
    irm: addr(w[3]),
    lltv: BigInt(`0x${w[4]}`),
    createdBlock: log.blockNumber === undefined ? null : Number(BigInt(log.blockNumber)),
  };
}

/** Morpho `market(Id)` -> Market{totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee}, six uint128 in six words. */
export function decodeMarket(data) {
  const w = asWords(data);
  if (w.length < 6) return null;
  const at = (i) => BigInt(`0x${w[i]}`);
  return { totalSupplyAssets: at(0), totalSupplyShares: at(1), totalBorrowAssets: at(2), totalBorrowShares: at(3), lastUpdate: at(4), fee: at(5) };
}

/** Chainlink latestRoundData: r13-probe.mjs:174-177, 8-decimal answer. */
export function decodeRound(data) {
  const w = asWords(data);
  if (w.length < 5) return null;
  return { id: BigInt(`0x${w[0]}`), answer: BigInt.asIntN(256, BigInt(`0x${w[1]}`)), updatedAt: Number(BigInt(`0x${w[3]}`)) };
}

/** Utilisation as a fraction. An empty market is 0, never a division by zero and never null. */
export function utilisation(market) {
  if (!market || market.totalSupplyAssets === 0n) return 0;
  return Number(market.totalBorrowAssets) / Number(market.totalSupplyAssets);
}

/**
 * Morpho IRMs return a borrow rate per second scaled by 1e18. Compounded continuously over a year that is
 * exp(rate * SECONDS_PER_YEAR) - 1. Returns null when the IRM did not answer, never 0 — a market whose rate
 * could not be read must not look like a market paying nothing.
 */
export function borrowApyFromRatePerSecond(ratePerSecondWad) {
  if (ratePerSecondWad === null || ratePerSecondWad === undefined) return null;
  const perSecond = Number(ratePerSecondWad) / 1e18;
  if (!Number.isFinite(perSecond)) return null;
  return Math.expm1(perSecond * SECONDS_PER_YEAR);
}

/** Loan-side value in USD: assets are in the loan token's own decimals, the Chainlink answer is 8-decimal. */
export function usdValue(assets, decimals, priceAnswer8dp) {
  if (assets === null || decimals === null || priceAnswer8dp === null) return null;
  return (Number(assets) / 10 ** Number(decimals)) * (Number(priceAnswer8dp) / 1e8);
}

/**
 * How many samples, counting back from the newest, fall on consecutive calendar days. One sample is a run
 * of one; a gap ends the run. This is the "sustained, not a snapshot" test, so it deliberately counts the
 * TRAILING run and not the total number of samples ever taken.
 */
export function consecutiveDailySamples(samples) {
  const days = [...new Set((samples ?? []).map((s) => s.date))].sort();
  if (days.length === 0) return 0;
  let run = 1;
  for (let i = days.length - 1; i > 0; i--) {
    const gap = (Date.parse(`${days[i]}T00:00:00Z`) - Date.parse(`${days[i - 1]}T00:00:00Z`)) / 86_400_000;
    if (gap !== 1) break;
    run += 1;
  }
  return run;
}

/**
 * FAIL-CLOSED. "no-go" unless every threshold is met AND the sample history is long enough. Each failing
 * condition contributes a reason, so a "no-go" always says why, and a "go" lists the conditions it cleared.
 * Dust cannot trip this: $29.31 of borrowed NVDA (LENDING-RECON §3) fails minStockOnLoanUsd by four orders
 * of magnitude, and a market with one healthy day fails minConsecutiveDailySamples regardless of its size.
 */
export function verdictOf(snapshot, thresholds = THRESHOLDS) {
  const reasons = [];
  const samples = snapshot?.samples ?? [];
  const latest = samples.length ? samples[samples.length - 1] : null;
  if (!latest) {
    return { value: 'no-go', reasons: ['no sample has been taken'] };
  }
  const onLoan = latest.totalStockOnLoanUsd ?? 0;
  const util = latest.maxUtilisation ?? 0;
  const apy = latest.maxBorrowApy ?? 0;
  const run = consecutiveDailySamples(samples);
  if (onLoan < thresholds.minStockOnLoanUsd) reasons.push(`stock on loan $${Math.round(onLoan)} is below the $${thresholds.minStockOnLoanUsd} floor`);
  if (util < thresholds.minUtilisation) reasons.push(`best utilisation ${(util * 100).toFixed(2)}% is below ${(thresholds.minUtilisation * 100).toFixed(0)}%`);
  if (apy < thresholds.minBorrowApy) reasons.push(`best borrow APY ${(apy * 100).toFixed(2)}% is below ${(thresholds.minBorrowApy * 100).toFixed(0)}%, the bar the USDG alternative sets`);
  if (run < thresholds.minConsecutiveDailySamples) reasons.push(`${run} consecutive daily sample(s), fewer than the ${thresholds.minConsecutiveDailySamples} the sustained-borrowing bar requires`);
  if (reasons.length) return { value: 'no-go', reasons };
  return {
    value: 'go',
    reasons: [
      `stock on loan $${Math.round(onLoan)} >= $${thresholds.minStockOnLoanUsd}`,
      `utilisation ${(util * 100).toFixed(2)}% >= ${(thresholds.minUtilisation * 100).toFixed(0)}%`,
      `borrow APY ${(apy * 100).toFixed(2)}% >= ${(thresholds.minBorrowApy * 100).toFixed(0)}%`,
      `${run} consecutive daily samples >= ${thresholds.minConsecutiveDailySamples}`,
    ],
  };
}

/**
 * Material drift, r13-probe.mjs:266-278. A market appearing or disappearing, a change to any immutable
 * market parameter, or a verdict flip. Deliberately NOT sensitive to utilisation or rate moving, which is
 * what this probe expects to see change between runs.
 */
export function drift(now, old) {
  if (!old) return ['missing committed JSON'];
  const errors = [];
  const oldById = new Map((old.stockLoanMarkets ?? []).map((m) => [m.id, m]));
  for (const m of now.stockLoanMarkets ?? []) {
    const p = oldById.get(m.id);
    if (!p) { errors.push(`market ${m.id} (${m.loanTicker}): appeared`); continue; }
    if (m.loanToken?.toLowerCase() !== p.loanToken?.toLowerCase()
      || m.collateralToken?.toLowerCase() !== p.collateralToken?.toLowerCase()
      || m.oracle?.toLowerCase() !== p.oracle?.toLowerCase()
      || m.irm?.toLowerCase() !== p.irm?.toLowerCase()
      || String(m.lltv) !== String(p.lltv)) errors.push(`market ${m.id} (${m.loanTicker}): loan/collateral/oracle/IRM/LLTV changed`);
  }
  const nowIds = new Set((now.stockLoanMarkets ?? []).map((m) => m.id));
  for (const p of old.stockLoanMarkets ?? []) if (!nowIds.has(p.id)) errors.push(`market ${p.id} (${p.loanTicker}): disappeared`);
  if (now.verdict?.value !== old.verdict?.value) errors.push(`verdict flipped ${old.verdict?.value} -> ${now.verdict?.value}`);
  if (now.morpho?.codeExists !== old.morpho?.codeExists) errors.push('Morpho code presence changed');
  return errors;
}

/* ------------------------------------------------------------------------------------ the probe itself */

async function probe() {
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  const previous = await readFile(outputPath, 'utf8').then(JSON.parse).catch(() => null);

  // r13-probe.mjs:287 — the chain-id assertion runs before anything else.
  const [chainId, blockNumber] = await rpcMany([{ method: 'eth_chainId', params: [] }, { method: 'eth_blockNumber', params: [] }]);
  if (Number(BigInt(chainId)) !== 4663) throw new Error(`unexpected chain id ${chainId}`);
  const observedBlock = Number(BigInt(blockNumber));

  const [morphoCode, canonicalCode] = await rpcMany([MORPHO, MORPHO_CANONICAL_NO_CODE].map((a) => ({ method: 'eth_getCode', params: [a, 'latest'] })));
  if (!codeExists(morphoCode)) throw new Error(`Morpho Blue has no code at ${MORPHO} on chain ${Number(BigInt(chainId))}: refusing to emit a snapshot of zeros`);
  const morpho = {
    address: MORPHO,
    codeExists: true,
    codeSizeBytes: (morphoCode.length - 2) / 2,
    canonicalAddressChecked: MORPHO_CANONICAL_NO_CODE,
    canonicalCodeExists: codeExists(canonicalCode),
  };

  // Stock Tokens come from the registry, never from the recon prose (ops/markets/README.md:4).
  const byAsset = new Map(registry.markets.map((m) => [m.asset.toLowerCase(), m]));

  console.error(`scanning CreateMarket logs ${MORPHO_FIRST_BLOCK}..${observedBlock}`);
  const logs = await getLogsChunked(MORPHO, [TOPIC_CREATE_MARKET], MORPHO_FIRST_BLOCK, observedBlock);
  const created = logs.map(decodeCreateMarket).filter((x) => x !== null);
  const stockLoan = created.filter((m) => byAsset.has(m.loanToken.toLowerCase()));
  console.error(`${created.length} markets created, ${stockLoan.length} with a Stock Token as the loan asset`);

  const states = await rpcMany(stockLoan.map((m) => ethCall(MORPHO, SEL.market + m.id.replace(/^0x/, ''))));

  // REDUNDANCY, deliberately. F8-02 froze 25 assertions unexecuted and published two wrong selectors; what
  // caught it was a second task deriving the same values independently. So every market's params are read
  // back from `idToMarketParams(Id)` and compared with what the CreateMarket log decoded. A mismatch means
  // the topic or the decoder is wrong, and that is a bug in THIS file, not a fact about the chain — so it
  // throws rather than quietly emitting numbers nobody can trust.
  const paramsRaw = await rpcMany(stockLoan.map((m) => ethCall(MORPHO, SEL.idToMarketParams + m.id.replace(/^0x/, ''))));
  for (let i = 0; i < stockLoan.length; i++) {
    const m = stockLoan[i];
    const g = asWords(paramsRaw[i]);
    if (g.length < 5) throw new Error(`idToMarketParams(${m.id}) did not decode: the getter selector or the market id is wrong`);
    const got = { loanToken: addr(g[0]), collateralToken: addr(g[1]), oracle: addr(g[2]), irm: addr(g[3]), lltv: BigInt(`0x${g[4]}`) };
    const same = got.loanToken.toLowerCase() === m.loanToken.toLowerCase()
      && got.collateralToken.toLowerCase() === m.collateralToken.toLowerCase()
      && got.oracle.toLowerCase() === m.oracle.toLowerCase()
      && got.irm.toLowerCase() === m.irm.toLowerCase()
      && got.lltv === m.lltv;
    if (!same) throw new Error(`market ${m.id}: the CreateMarket log and idToMarketParams disagree — log ${JSON.stringify({ ...m, lltv: m.lltv.toString() })} vs getter ${JSON.stringify({ ...got, lltv: got.lltv.toString() })}. Fix the decoder before trusting any number in this file.`);
  }
  const decimalsRaw = await rpcMany(stockLoan.map((m) => ethCall(m.loanToken, SEL.decimals)));
  const feedRaw = await rpcMany(stockLoan.map((m) => ethCall(byAsset.get(m.loanToken.toLowerCase()).feed, SEL.latestRoundData)));

  // The IRM's own view of the rate. A market whose IRM does not answer keeps borrowApy null.
  const rateRaw = await rpcMany(stockLoan.map((m, i) => {
    const s = decodeMarket(states[i]);
    if (!s) return ethCall(MORPHO, SEL.market + m.id.replace(/^0x/, '')); // placeholder, discarded below
    const params = addrWord(m.loanToken) + addrWord(m.collateralToken) + addrWord(m.oracle) + addrWord(m.irm) + word(m.lltv);
    const state = word(s.totalSupplyAssets) + word(s.totalSupplyShares) + word(s.totalBorrowAssets) + word(s.totalBorrowShares) + word(s.lastUpdate) + word(s.fee);
    return ethCall(m.irm, SEL.borrowRateView + params + state);
  }));

  const stockLoanMarkets = stockLoan.map((m, i) => {
    const state = decodeMarket(states[i]);
    const row = byAsset.get(m.loanToken.toLowerCase());
    const decimals = decimalsRaw[i] === null ? null : Number(BigInt(decimalsRaw[i]));
    const round = decodeRound(feedRaw[i]);
    const ratePerSecond = state === null || rateRaw[i] === null ? null : BigInt(rateRaw[i]);
    return {
      id: m.id,
      loanToken: m.loanToken,
      loanTicker: row.ticker,
      collateralToken: m.collateralToken,
      lltv: m.lltv.toString(),
      oracle: m.oracle,
      irm: m.irm,
      creator: null, // the CreateMarket log does not carry it; filling it would need a tx lookup per market
      createdBlock: m.createdBlock,
      totalSupplyAssets: state === null ? null : state.totalSupplyAssets.toString(),
      totalBorrowAssets: state === null ? null : state.totalBorrowAssets.toString(),
      utilisation: state === null ? null : utilisation(state),
      borrowApy: state === null ? null : borrowApyFromRatePerSecond(ratePerSecond),
      decodable: state !== null && decimals !== null && round !== null,
      borrowedUsd: state === null ? null : usdValue(state.totalBorrowAssets, decimals, round?.answer ?? null),
      suppliedUsd: state === null ? null : usdValue(state.totalSupplyAssets, decimals, round?.answer ?? null),
    };
  });

  // The named non-Morpho venue. Its interface is reconstructed in a doc and its bytecode is unverified, so
  // read only what decodes and mark the rest null.
  const venueCodes = await rpcMany(HEDGEHOOD_STOCKLEND.map((v) => ({ method: 'eth_getCode', params: [v.address, 'latest'] })));
  const venueLoanIds = await rpcMany(HEDGEHOOD_STOCKLEND.map((v) => ethCall(v.address, SEL.nextLoanId)));
  const venueParams = await rpcMany(HEDGEHOOD_STOCKLEND.map((v) => ethCall(v.address, SEL.getParams)));
  const venues = HEDGEHOOD_STOCKLEND.map((v, i) => ({
    venue: 'Hedgehood StockLend',
    ticker: v.ticker,
    address: v.address,
    codeExists: codeExists(venueCodes[i]),
    codeSizeBytes: codeExists(venueCodes[i]) ? (venueCodes[i].length - 2) / 2 : 0,
    nextLoanId: venueLoanIds[i] === null ? null : BigInt(venueLoanIds[i]).toString(),
    loansEverOpened: venueLoanIds[i] === null ? null : BigInt(venueLoanIds[i]) > 1n,
    // getParams()'s RETURN SHAPE is reconstructed in a doc and the bytecode is unverified on the explorer,
    // so this records only that the call answered and how wide the answer was. Decoding fields out of an
    // unverified layout would be inventing numbers, which is worse than having none.
    getParamsAnswered: venueParams[i] !== null && venueParams[i] !== '0x',
    getParamsWordCount: venueParams[i] === null ? null : asWords(venueParams[i]).length,
    source: 'v8-plan/LENDING-RECON-2026-09-19.md §4 address table; bytecode unverified on the explorer, interface reconstructed there',
  }));

  const decodedRows = stockLoanMarkets.filter((m) => m.decodable);
  const sample = {
    date: new Date().toISOString().slice(0, 10),
    checkedAt: new Date().toISOString(),
    observedBlock,
    marketsWithLoanAsset: stockLoanMarkets.length,
    marketsWithAnyBorrow: decodedRows.filter((m) => BigInt(m.totalBorrowAssets ?? '0') > 0n).length,
    totalStockOnLoanUsd: decodedRows.reduce((sum, m) => sum + (m.borrowedUsd ?? 0), 0),
    totalStockSuppliedUsd: decodedRows.reduce((sum, m) => sum + (m.suppliedUsd ?? 0), 0),
    maxUtilisation: decodedRows.reduce((best, m) => Math.max(best, m.utilisation ?? 0), 0),
    maxBorrowApy: decodedRows.reduce((best, m) => Math.max(best, m.borrowApy ?? 0), 0),
  };
  const samples = appendSample(previous?.samples, sample);

  const snapshot = {
    _readme: 'R14 stock-loan borrow demand (board P8-04). Generated by ops/recon/r14-stockloan-probe.mjs from on-chain reads at observedBlock. `samples` is APPEND-ONLY: every run adds one dated row and rewrites none. `thresholds` are PROPOSED by the script author on the evidence in the file header and are NOT owner-approved. Narrative evidence: v8-plan/LENDING-RECON-2026-09-19.md.',
    checkedAt: sample.checkedAt,
    chainId: 4663,
    rpc: rpcUrl,
    observedBlock,
    morpho,
    thresholds: THRESHOLDS,
    venues,
    stockLoanMarkets,
    samples,
    // P8-02 (the Earn-vault position this probe would measure our own exposure through) does not exist yet,
    // so there is nothing to read. Null, and every consumer must be null-safe about it.
    ourPosition: null,
    perpAlternative: {
      note: 'The hedge a covered-call maker actually needs is a small short, which goes on a perp, and the funding it pays is the real alternative cost of borrowing stock (v8-plan/LENDING-RECON-2026-09-19.md §8). No perp venue on 4663 was read by this probe.',
      annualisedFundingBps: null,
      venue: null,
      verified: false,
    },
    verdict: null,
  };
  snapshot.verdict = verdictOf(snapshot);
  assertTopLevelKeys(snapshot);
  return { snapshot, previous };
}

/* ------------------------------------------------------------------------------------------------ main */

// Run the probe only when this file IS the entry point. `process.argv[1]` is undefined under `node -e` and
// under some loaders, and pathToFileURL(undefined) THROWS, so the guard must check argv[1] first: without
// that check, merely importing this module from a context with no script path crashes before any test runs.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { snapshot, previous } = await probe();
  if (check) {
    const changes = drift(snapshot, previous);
    if (changes.length) { console.error(changes.join('\n')); process.exitCode = 1; }
    else console.error('R14 check: no material drift');
  } else {
    await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.error(`wrote ${outputPath}`);
    console.error(`verdict: ${snapshot.verdict.value} — ${snapshot.verdict.reasons.join('; ')}`);
  }
}
