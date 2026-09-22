#!/usr/bin/env node
/* -------------------------------------------------------------------------------------------------
 * ops/devnet/set-feed.mjs — push Chainlink rounds into the devnet's mock feeds.
 *
 * A live Chainlink feed cannot follow `evm_increaseTime`, and nobody can impersonate its
 * transmitters, so DevDeploy (DEV_MOCK_FEED=1, the default) points each market's ChainlinkFeedSource
 * at a MockRoundFeed that starts with the real feed's recent rounds. This script appends rounds
 * (answers at the feed's 8 decimals; `push` has no access control). Every timestamp must be <= the
 * chain's time: a round stamped in the future makes spot revert until the chain gets there, so the
 * script refuses one — warp first.
 *
 *   node ops/devnet/set-feed.mjs NVDA                       re-print the latest answer, stamped now
 *                                                           (spot goes stale after spotMaxAge, 25 h)
 *   node ops/devnet/set-feed.mjs NVDA --price 231.5         a new round at 231.50 USD, stamped now
 *   node ops/devnet/set-feed.mjs NVDA --price 231.5 --at <unix>
 *   node ops/devnet/set-feed.mjs NVDA --pool                a round at the Uniswap pool's 5-min TWAP
 *   node ops/devnet/set-feed.mjs NVDA --window <expiry> [--price P | --pool]
 *                                                           the settlement window of <expiry>: rounds at
 *                                                           expiry-2100 and expiry-900 and now (the chain
 *                                                           must be past expiry-900), so the 30-minute
 *                                                           TWAP is exactly P
 *   node ops/devnet/set-feed.mjs --all                      refresh every market (latest answer, now)
 *   node ops/devnet/set-feed.mjs --show                     print each mock's latest round and spot
 *
 * Prices move at most ChainlinkFeedSource's maxRoundJumpBps (20 %) from one round to the next, or
 * the source reports not ok; move further in steps. Environment: DEVNET_PORT / DEVNET_RPC.
 * ------------------------------------------------------------------------------------------------- */
import { ABI, devAccounts, die, loadAddresses, now, nyTime, read, rpc, send, usd } from "./lib.mjs";

const argv = process.argv.slice(2);
const flags = {};
const tickers = [];
for (let i = 0; i < argv.length; i += 1) {
  const x = argv[i];
  if (x === "--all" || x === "--pool" || x === "--show") flags[x.slice(2)] = true;
  else if (x === "--price" || x === "--at" || x === "--window") flags[x.slice(2)] = argv[++i] ?? die(`${x} needs a value`, 2);
  else if (x === "-h" || x === "--help") {
    process.stdout.write("usage: node ops/devnet/set-feed.mjs <TICKER>|--all [--price USD | --pool] [--at unix | --window expiry] | --show\n");
    process.exit(0);
  } else if (x.startsWith("--")) die(`unknown flag ${x}`, 2);
  else tickers.push(x.toUpperCase());
}

await rpc("eth_chainId").catch(() => die("no devnet node answers; start it with ops/devnet/up.sh", 2));
const A = loadAddresses();
if (!A.mockFeed) die("this devnet was deployed with DEV_MOCK_FEED=0: the markets read the real feeds, which cannot be pushed", 2);
const acct = await devAccounts();
const markets = flags.all || flags.show ? A.markets : A.markets.filter((m) => tickers.includes(m.ticker));
if (markets.length === 0) die(`no market ${tickers.join(",")} on this devnet (${A.markets.map((m) => m.ticker).join(", ")})`, 2);

async function show(m) {
  const [id, answer, , updatedAt] = await read(m.feed, ABI.mockFeed, "latestRoundData");
  const [ok, spot, at] = await read(A.contracts.settlementOracle, ABI.oracle, "trySpot", [m.underlying]);
  process.stdout.write(`  ${m.ticker.padEnd(5)} mock ${m.feed} round ${id & ((1n << 64n) - 1n)}: ${usd(answer / 100n)} at ${nyTime(Number(updatedAt))} NY; spot ${ok ? `${usd(spot)} (age ${(await now()) - Number(at)} s)` : "NOT OK (stale or no source)"}\n`);
}

async function priceFor(m) {
  if (flags.pool) {
    if (!m.pool) die(`${m.ticker} has no pool on this devnet`, 2);
    const [ok, p] = await read(A.contracts.sources.univ3, ABI.univ3, "latest", [m.underlying]);
    if (!ok) die(`${m.ticker} pool TWAP is not ok`, 1);
    return p * 100n; // 6 dp -> 8 dp
  }
  if (flags.price !== undefined) {
    const [whole, frac = ""] = String(flags.price).split(".");
    if (!/^\d+$/.test(whole) || !/^\d{0,8}$/.test(frac)) die(`--price must be a USD amount with at most 8 decimals, got ${flags.price}`, 2);
    return BigInt(whole) * 10n ** 8n + BigInt(frac.padEnd(8, "0"));
  }
  const [, answer] = await read(m.feed, ABI.mockFeed, "latestRoundData");
  return answer;
}

async function push(m, answer, at) {
  const t = await now();
  if (at > t) die(`${m.ticker}: round at ${at} is after the chain time ${t}; warp first (evm_setNextBlockTimestamp / evm_increaseTime)`, 2);
  await send(acct.admin, { address: m.feed, abi: ABI.mockFeed, functionName: "push", args: [answer, BigInt(at)], label: `push ${m.ticker}` });
  process.stdout.write(`  ${m.ticker} round ${usd(answer / 100n)} USD at ${at} (${nyTime(at)} NY)\n`);
}

if (flags.show) {
  for (const m of markets) await show(m);
  process.exit(0);
}
for (const m of markets) {
  const answer = await priceFor(m);
  const t = await now();
  if (flags.window !== undefined) {
    const expiry = Number(flags.window);
    if (t < expiry - 900) die(`--window ${expiry}: the chain (${t}) must be past expiry - 900; warp first`, 2);
    await push(m, answer, expiry - 2100);
    await push(m, answer, expiry - 900);
    await push(m, answer, t);
  } else {
    await push(m, answer, flags.at !== undefined ? Number(flags.at) : t);
  }
  await show(m);
}
