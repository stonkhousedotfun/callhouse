/**
 * Replay a fresh ops/devnet seed through a bounded Ponder deployment and compare the public API
 * with chain logs and views. Run ops/devnet/up.sh first; this script only starts/stops Ponder.
 * The RPC must be a local anvil, and the database is always a new PGlite directory.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, getAddress, http, type Address } from "viem";

import { clearinghouseAbi } from "../abis/v2/clearinghouse.ts";
import { orderBookAbi } from "../abis/v2/orderBook.ts";
import { settlementOracleAbi } from "../abis/v2/settlementOracle.ts";

const INDEXER = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(INDEXER, "..");
const DEVNET = join(ROOT, "ops/devnet");
const OUT = mkdtempSync(join(tmpdir(), "stonkhouse-v2-sync-"));
const PORT = Number(process.env.V2_DEVNET_API_PORT ?? "42170");
const TIMEOUT = Number(process.env.V2_DEVNET_SYNC_TIMEOUT_MS ?? "900000");
const API = `http://127.0.0.1:${PORT}`;

type SeedSeries = { longId: string; ticker: string; underlying: Address; strike: string; expiry: number; isPut: boolean; tag: string };
type Devnet = {
  chainId: number; rpc: string; startBlock: number; usdg: Address;
  contracts: { clearinghouse: Address; orderBook: Address; settlementOracle: Address };
  markets: { ticker: string; underlying: Address }[];
  accounts: Record<string, Address>;
  seed: { trade: { series: SeedSeries[]; resaleOrderId: string; itm: { longId: string } };
    summary: { gates: string; block: string; series: number; orders: number; fills: number; settledSeries: number;
      itmSettled: { longId: string; settlementPrice: string; redeemedHolders: Address[] }[] } };
};

function envFile(path: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    if (line.startsWith("#") || !line.trim()) continue;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match) throw new Error(`Malformed generated env line: ${line}`);
    result[match[1]!] = match[2]!;
  }
  return result;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function json<T>(path: string): Promise<T> {
  const response = await fetch(`${API}${path}`);
  const body = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${body.slice(0, 600)}`);
  return JSON.parse(body) as T;
}

async function pages<T>(path: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | null = null;
  do {
    const separator = path.includes("?") ? "&" : "?";
    const page: { items: T[]; nextCursor: string | null } = await json<{ items: T[]; nextCursor: string | null }>(
      `${path}${separator}limit=100${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
    );
    items.push(...page.items);
    cursor = page.nextCursor;
    assert(items.length < 10_000, `pagination did not end: ${path}`);
  } while (cursor !== null);
  return items;
}

function equal(actual: unknown, expected: unknown, label: string): void {
  assert.deepEqual(actual, expected, label);
  console.log(`  ✓ ${label}`);
}

async function main(): Promise<void> {
  const addressFile = join(DEVNET, "addresses.json");
  const devnet = JSON.parse(readFileSync(addressFile, "utf8")) as Devnet;
  assert.equal(devnet.chainId, 4663);
  assert.equal(devnet.seed.summary.gates, "passed", "run a fresh ops/devnet/up.sh first");
  const rpcUrl = new URL(devnet.rpc);
  assert(["127.0.0.1", "localhost", "::1", "[::1]"].includes(rpcUrl.hostname), "devnet RPC must be loopback");
  const rpcResponse = await fetch(devnet.rpc, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "web3_clientVersion", params: [] }) });
  const version = (await rpcResponse.json()) as { result?: string };
  assert.match(version.result ?? "", /anvil/i, "devnet RPC must be anvil");
  const chain = createPublicClient({ transport: http(devnet.rpc), chain: { id: 4663, name: "Devnet",
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [devnet.rpc] } } } });
  equal(await chain.getChainId(), 4663, "chain id");
  equal(await chain.readContract({ address: devnet.contracts.clearinghouse, abi: clearinghouseAbi,
    functionName: "supportsInterface", args: ["0xf9e1eb5d"] }), true, "v7 Clearinghouse interface ID");
  // The PnL reconciler samples every 30 blocks. Give it a full tick after the final redemption.
  const endBlock = BigInt(devnet.seed.summary.block) + 30n;
  const clockDeadline = Date.now() + 90_000;
  while ((await chain.getBlockNumber()) < endBlock && Date.now() < clockDeadline) await sleep(1000);
  assert((await chain.getBlockNumber()) >= endBlock, "devnet did not mine the PnL reconciliation block");
  const block = await chain.getBlock({ blockNumber: endBlock });
  console.log(`devnet ${devnet.rpc}, blocks ${devnet.startBlock}..${endBlock}, PGlite ${OUT}`);

  const env: NodeJS.ProcessEnv = { ...process.env, ...envFile(join(DEVNET, "env/indexer.env")),
    PONDER_RPC_URL_4663: devnet.rpc, V2_START_BLOCK: String(devnet.startBlock),
    END_BLOCK: String(endBlock), PGLITE_DIRECTORY: join(OUT, "pglite"),
    DATABASE_SCHEMA: "v2_devnet_check", PORT: String(PORT), PRICING_URL: "" };
  for (const name of ["DATABASE_URL", "DATABASE_PRIVATE_URL", "VAULT_ADDRESS", "VAULT", "FACTORY_ADDRESS", "FACTORY", "START_BLOCK"])
    delete env[name];
  const response = await fetch(`${API}/health`).catch(() => null);
  assert(response === null, `API port ${PORT} is occupied; set V2_DEVNET_API_PORT`);
  const child = spawn(join(INDEXER, "node_modules/.bin/ponder"), ["start", "--schema", "v2_devnet_check"],
    { cwd: INDEXER, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream?.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-20_000);
    appendFileSync(join(OUT, "ponder.log"), chunk);
  });
  try {
    const deadline = Date.now() + TIMEOUT;
    let synced = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Ponder exited ${child.exitCode}:\n${output}`);
      try {
        const ready = await fetch(`${API}/ready`);
        if (ready.ok) {
          const health = await json<{ block: string }>("/v2/health");
          if (BigInt(health.block) >= endBlock) { synced = true; break; }
        }
      } catch { /* Ponder has not started HTTP yet. */ }
      await sleep(500);
    }
    if (!synced) throw new Error(`Ponder did not reach block ${endBlock} in ${TIMEOUT} ms:\n${output}`);
    console.log(`Ponder synced to block ${endBlock}`);
    const config = await json<{ interfaceVersion: number; fees: { premiumFeeBps: number; mintFeePpm: number } }>("/v2/config");
    equal(config.interfaceVersion, 7, "v7 API interface");
    equal(config.fees.premiumFeeBps, 0, "v7 launch primary premium fee");
    assert(config.fees.mintFeePpm > 0, "v7 seed requires nonzero writer rent");

    const C = devnet.contracts;
    const fromBlock = BigInt(devnet.startBlock);
    const logs = <N extends "SeriesCreated" | "SeriesSettled" | "Redeemed" | "OrderPlaced" | "OrderFilled" | "Taken">(
      name: N, address: Address, abi: typeof clearinghouseAbi | typeof orderBookAbi,
    ) => chain.getContractEvents({ address, abi, eventName: name, fromBlock, toBlock: endBlock });
    const [created, settled, redeemed, placed, filled, taken] = await Promise.all([
      logs("SeriesCreated", C.clearinghouse, clearinghouseAbi),
      logs("SeriesSettled", C.clearinghouse, clearinghouseAbi),
      logs("Redeemed", C.clearinghouse, clearinghouseAbi),
      logs("OrderPlaced", C.orderBook, orderBookAbi),
      logs("OrderFilled", C.orderBook, orderBookAbi),
      logs("Taken", C.orderBook, orderBookAbi),
    ]);
    equal(created.length, devnet.seed.summary.series, "on-chain series count matches seed");
    equal(placed.length, devnet.seed.summary.orders, "on-chain order count matches seed");
    equal(filled.length, devnet.seed.summary.fills, "on-chain fill count matches seed");
    equal(settled.length, devnet.seed.summary.settledSeries, "on-chain settled count matches seed");

    const [mints, closes, accruals] = await Promise.all([
      chain.getContractEvents({ address: C.clearinghouse, abi: clearinghouseAbi, eventName: "Minted", fromBlock, toBlock: endBlock }),
      chain.getContractEvents({ address: C.clearinghouse, abi: clearinghouseAbi, eventName: "Closed", fromBlock, toBlock: endBlock }),
      chain.getContractEvents({ address: C.clearinghouse, abi: clearinghouseAbi, eventName: "MintFeesAccrued", fromBlock, toBlock: endBlock }),
    ]);
    assert(mints.some((log) => (log.args.fee ?? 0n) > 0n), "seed must charge nonzero mint rent");
    assert(accruals.some((log) => (log.args.amount ?? 0n) > 0n), "seed must accrue nonzero rent at settlement");
    const allSeries: { series: { longId: string; underlying: Address; strike: { raw: string }; expiry: number; isPut: boolean;
      mintFeePpm: number; mintFeesHeld: { raw: string; decimals: number }; mintFeesAccrued: { raw: string; decimals: number } } }[] = [];
    for (const market of devnet.markets) {
      const rows = await pages<typeof allSeries[number]>(`/v2/markets/${market.ticker}/series`);
      allSeries.push(...rows);
      equal(rows.length, created.filter((log) => log.args.underlying?.toLowerCase() === market.underlying.toLowerCase()).length,
        `${market.ticker} API series count`);
    }
    equal(new Set(allSeries.map((item) => item.series.longId)),
      new Set(created.map((log) => String(log.args.longId))), "API series ids equal chain SeriesCreated ids");
    for (const row of allSeries) {
      const id = BigInt(row.series.longId);
      const view = await chain.readContract({ address: C.clearinghouse, abi: clearinghouseAbi,
        functionName: "series", args: [id], blockNumber: endBlock });
      assert.deepEqual([row.series.underlying.toLowerCase(), row.series.isPut, row.series.strike.raw, row.series.expiry, row.series.mintFeePpm],
        [view.underlying.toLowerCase(), view.isPut, String(view.strike), Number(view.expiry), view.mintFeePpm], `series ${id} terms`);
      const charged = mints.filter((log) => log.args.longId === id).reduce((sum, log) => sum + log.args.fee!, 0n);
      const refunded = closes.filter((log) => log.args.longId === id).reduce((sum, log) => sum + log.args.feeRefund!, 0n);
      const accrued = accruals.filter((log) => log.args.longId === id).reduce((sum, log) => sum + log.args.amount!, 0n);
      const decimals = view.isPut ? 6 : 18;
      assert.equal(charged - refunded - accrued, view.mintFeesHeld, `series ${id} rent conservation`);
      assert.deepEqual([row.series.mintFeesHeld.raw, row.series.mintFeesHeld.decimals,
        row.series.mintFeesAccrued.raw, row.series.mintFeesAccrued.decimals],
      [String(view.mintFeesHeld), decimals, String(accrued), decimals], `series ${id} indexed native-asset rent`);
      for (const accruedLog of accruals.filter((log) => log.args.longId === id)) {
        assert.equal(accruedLog.args.asset!.toLowerCase(), (view.isPut ? devnet.usdg : view.underlying).toLowerCase(),
          `series ${id} rent accrued in collateral asset`);
        assert(settled.some((log) => log.args.longId === id && log.transactionHash === accruedLog.transactionHash &&
          log.logIndex! < accruedLog.logIndex!), `series ${id} rent accrued after SeriesSettled`);
      }
    }
    console.log(`  ✓ all ${allSeries.length} series terms equal on-chain views`);

    const resaleId = BigInt(devnet.seed.trade.resaleOrderId);
    const resale = (await chain.readContract({ address: C.orderBook, abi: orderBookAbi,
      functionName: "getOrders", args: [[resaleId]], blockNumber: endBlock }))[0]!;
    assert.equal(resale.kind, 1, "seeded resale order is AskResale");
    const book = await json<{ updatedBlock: string; snapshotTimestamp: number;
      bids: { price: { raw: string }; units: string; orders: { orderId: string; units: string }[] }[];
      asks: { price: { raw: string }; units: string; orders: { orderId: string; units: string }[] }[] }>(
      `/v2/series/${resale.longId}/book?depth=100`);
    const listing = book.asks.flatMap((level) => level.orders).find((order) => order.orderId === String(resaleId));
    assert(listing, "seeded resale ask missing from API book");
    equal(listing.units, String(resale.units - resale.filled), "resale ask units equal on-chain remaining units");
    const apiAskTotal = book.asks.reduce((sum, level) => sum + BigInt(level.units), 0n);
    const apiBidTotal = book.bids.reduce((sum, level) => sum + BigInt(level.units), 0n);
    const bookBlock = BigInt(book.updatedBlock);
    const bookSnapshot = await chain.getBlock({ blockNumber: bookBlock });
    equal(book.snapshotTimestamp, Number(bookSnapshot.timestamp), "book clock equals its pinned block");
    const [seriesForBook, mintCutoff, market, tradingPaused] = await Promise.all([
      chain.readContract({ address: C.clearinghouse, abi: clearinghouseAbi, functionName: "series",
        args: [resale.longId], blockNumber: bookBlock }),
      chain.readContract({ address: C.clearinghouse, abi: clearinghouseAbi, functionName: "mintCutoff",
        args: [resale.longId], blockNumber: bookBlock }),
      chain.readContract({ address: C.clearinghouse, abi: clearinghouseAbi, functionName: "market",
        args: [devnet.seed.trade.series.find((s) => s.longId === String(resale.longId))!.underlying], blockNumber: bookBlock }),
      chain.readContract({ address: C.orderBook, abi: orderBookAbi, functionName: "tradingPaused", blockNumber: bookBlock }),
    ]);
    const ids = placed.filter((log) => log.args.longId === resale.longId).map((log) => log.args.orderId!);
    const orders = await chain.readContract({ address: C.orderBook, abi: orderBookAbi,
      functionName: "getOrders", args: [ids], blockNumber: bookBlock });
    const now = bookSnapshot.timestamp;
    const chainBook = new Map<string, { side: "bid" | "ask"; units: bigint }>();
    if (market.enabled && !tradingPaused && now < seriesForBook.expiry) {
      for (let i = 0; i < orders.length; i++) {
        const order = orders[i]!;
        const deadline = order.kind === 2 ? mintCutoff : seriesForBook.expiry;
        const validUntil = order.validUntil === 0 || order.validUntil > deadline ? deadline : order.validUntil;
        if (order.cancelled || order.price <= 0n || validUntil <= now || order.filled >= order.units) continue;
        let units = order.units - order.filled;
        if (order.kind === 2) {
          if (market.mintPaused || now >= mintCutoff) continue;
          const free = await chain.readContract({ address: C.clearinghouse, abi: clearinghouseAbi,
            functionName: "free", args: [order.maker, seriesForBook.isPut ? devnet.usdg : seriesForBook.underlying], blockNumber: bookBlock });
          const perUnit = seriesForBook.isPut ? seriesForBook.strike / 100n : 10n ** 16n;
          // Use the contract view as an independent oracle, rather than importing the book's math.
          let low = 0n;
          let high = units < free / perUnit ? units : free / perUnit;
          while (low < high) {
            const candidate = (low + high + 1n) / 2n;
            const fee = await chain.readContract({ address: C.clearinghouse, abi: clearinghouseAbi,
              functionName: "mintFee", args: [resale.longId, candidate], blockNumber: bookBlock });
            if (candidate * perUnit + fee <= free) low = candidate;
            else high = candidate - 1n;
          }
          units = low;
        }
        if (units > 0n) chainBook.set(String(ids[i]), { side: order.kind === 0 ? "bid" : "ask", units });
      }
    }
    const apiBook = new Map<string, { side: "bid" | "ask"; units: bigint }>([...book.asks.flatMap((level) => level.orders.map((order) => [order.orderId,
      { side: "ask" as const, units: BigInt(order.units) }] as const)),
      ...book.bids.flatMap((level) => level.orders.map((order) => [order.orderId,
        { side: "bid" as const, units: BigInt(order.units) }] as const))]);
    equal(apiBook, chainBook, "book orders and fillable units equal on-chain orders and collateral");
    equal([apiAskTotal, apiBidTotal], [
      [...chainBook.values()].filter((order) => order.side === "ask").reduce((sum, order) => sum + order.units, 0n),
      [...chainBook.values()].filter((order) => order.side === "bid").reduce((sum, order) => sum + order.units, 0n),
    ], "book side totals equal on-chain fillable units");
    const detail = await json<{ quote: { askUnits: string; bidUnits: string } }>(`/v2/series/${resale.longId}`);
    equal([detail.quote.askUnits, detail.quote.bidUnits], [String(apiAskTotal), String(apiBidTotal)],
      "quote book totals equal depth totals");

    const sampled = BigInt(devnet.seed.trade.series.find((s) => s.tag === "daily2-r1" && s.ticker === "NVDA")!.longId);
    const holders = await pages<{ holder: Address; units: string }>(`/v2/series/${sampled}/holders?side=long`);
    const byHolder = new Map(holders.map((holder) => [holder.holder.toLowerCase(), holder.units]));
    for (const who of ["ada", "ben", "cy", "dee", "eve"] as const) {
      const account = devnet.accounts[who]!;
      const onchain = await chain.readContract({ address: C.clearinghouse, abi: clearinghouseAbi,
        functionName: "balanceOf", args: [account, sampled], blockNumber: endBlock });
      equal(byHolder.get(account.toLowerCase()) ?? "0", String(onchain), `${who} long balance`);
    }

    const itmId = BigInt(devnet.seed.trade.itm.longId);
    const chainSeries = await chain.readContract({ address: C.clearinghouse, abi: clearinghouseAbi,
      functionName: "series", args: [itmId], blockNumber: endBlock });
    assert(chainSeries.settled && chainSeries.longPayoutPerUnit > 0n, "seeded ITM series was not settled");
    const oracle = await chain.readContract({ address: C.settlementOracle, abi: settlementOracleAbi,
      functionName: "settlementPrice", args: [chainSeries.underlying, chainSeries.expiry], blockNumber: endBlock });
    const apiSettled = await json<{ settlement: { price: { raw: string }; longPayoutPerUnit: { raw: string } } | null }>(
      `/v2/series/${itmId}`);
    assert(apiSettled.settlement, "API omitted settled series settlement");
    equal(apiSettled.settlement.price.raw, String(chainSeries.settlementPrice), "settlement price equals Clearinghouse");
    equal(apiSettled.settlement.price.raw, String(oracle[1]), "settlement price equals Oracle");
    equal(apiSettled.settlement.longPayoutPerUnit.raw, String(chainSeries.longPayoutPerUnit), "long payout per unit");

    const paid = redeemed.filter((log) => log.args.tokenId === itmId && (log.args.amount ?? 0n) > 0n);
    const winners = await pages<{ id: string; holder: Address; cost: { raw: string }; payout: { raw: string };
      series: { longId: string } }>(
      "/v2/feed/wins?window=all");
    let eligibleWins = 0;
    for (const redemption of paid) {
      const holder = redemption.args.holder!;
      const win = winners.find((row) => row.holder.toLowerCase() === holder.toLowerCase() && row.series.longId === String(itmId));
      const asset = redemption.args.asset!.toLowerCase();
      assert(asset === devnet.usdg.toLowerCase() || asset === chainSeries.underlying.toLowerCase(),
        `unexpected redemption asset ${redemption.args.asset}`);
      // Redeemed.amount is the delivered asset: USDG after adapter conversion, or an in-kind Stock Token.
      const payoutUsdg = asset === devnet.usdg.toLowerCase() ? redemption.args.amount! :
        redemption.args.amount! * chainSeries.settlementPrice / 10n ** 18n;
      const premium = filled.filter((log) => log.args.longId === itmId && log.args.takerIsBuyer &&
        log.args.recipient?.toLowerCase() === holder.toLowerCase())
        .reduce((sum, log) => sum + (log.args.premium ?? 0n), 0n);
      const fees = taken.filter((log) => log.args.longId === itmId && log.args.buying &&
        log.args.taker?.toLowerCase() === holder.toLowerCase())
        .reduce((sum, log) => sum + (log.args.takerFee ?? 0n), 0n);
      const cost = premium + fees;
      if (cost >= 100_000n && payoutUsdg > cost) {
        assert(win, `eligible redeemed ITM holder ${holder} missing from wins feed`);
        equal(win.payout.raw, String(payoutUsdg), `${holder} win payout equals chain redemption value`);
        equal(win.cost.raw, String(cost), `${holder} win cost equals chain fill plus fee`);
        eligibleWins++;
      } else {
        assert(!win, `${holder} should be excluded from wins (cost ${cost}, payout ${payoutUsdg})`);
      }
    }
    assert(eligibleWins >= 2, "seed did not produce multiple verified wins");
    console.log(`PASS: ${created.length} series, ${placed.length} orders, ${filled.length} fills, ${settled.length} settlements, ${eligibleWins} verified winners; API ${API}`);
    writeFileSync(join(OUT, "result.json"), JSON.stringify({ passed: true, endBlock: String(endBlock),
      series: created.length, orders: placed.length, fills: filled.length, settled: settled.length,
      winners: eligibleWins, rentMints: mints.length, rentCloses: closes.length, rentAccruals: accruals.length,
      api: API, chainTime: String(block.timestamp) }, null, 2) + "\n");
  } finally {
    child.kill("SIGTERM");
    await Promise.race([new Promise<void>((done) => child.once("exit", () => done())), sleep(5000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
    console.log(`harness artifacts: ${OUT}`);
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
