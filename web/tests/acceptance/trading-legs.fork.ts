/**
 * (trading audit C): every trading leg, end to end, against a LIVE v9 fork, through the web app's own
 * read and write modules (lib/v2/tx.ts, zapTx.ts, earnTx.ts, bookFromChain.ts, ticket.ts, portfolio.ts).
 *
 *   TRADING_FORK_RPC=http://127.0.0.1:<port> TRADING_FORK_REGISTRY=<written-back tier1.json> \
 *     node_modules/.bin/tsx --tsconfig tests/acceptance/tsconfig.json tests/acceptance/trading-legs.fork.ts
 *
 * WHAT IT IS NOT. Not a browser run: the page code above these modules (TradeTicket, Portfolio, EarnMarket) is not
 * driven here. What is driven is every call the app makes to the chain for a trade -- the book read, the quote, the
 * exact approval, the on-chain requote, the write and its receipt decode -- with the builders the pages use
 * (TradeTicket `paramsFor` / `expected`, Portfolio's sell `expected`), so a wrong argument, unit, fee or decode in the
 * app's trading path fails here against the v9 contracts.
 *
 * SAFETY. It refuses any RPC that is not loopback, any chain that is not 4663 and any node that is not anvil, and it
 * points NEXT_PUBLIC_RPC_URL / _2 at the fork BEFORE any web module loads, so no default client can reach mainnet.
 * Accounts are fresh addresses the node impersonates (anvil_impersonateAccount), funded with anvil_setBalance and with
 * USDG from the fork's deployer (anvil account 0, which the rehearsal left holding spare USDG). The only
 * time travel is evm_setNextBlockTimestamp for the settlement leg. It never restarts or reconfigures the node.
 *
 * THE WEB REGISTRY. lib/v2/config.ts reads contract addresses from lib/markets.generated.ts, so the run regenerates
 * that file from the fork's registry (scripts/gen-markets.mjs --registry, the rehearsal path it documents) and
 * RESTORES the committed bytes in a finally block, as v2.acceptance.ts does. The committed file is never changed.
 *
 * OUTPUT. One JSON record per leg (tx hashes, expected vs actual deltas, pass/fail) to stdout and to
 * TRADING_FORK_OUT (default a temp file). Exit code 1 if any leg failed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, erc20Abi, getAddress, http, parseEventLogs, type Address, type Hex,
  type PublicClient, type WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { clearinghouseAbi } from "../../lib/abi/v2/clearinghouse";
import { expiryCalendarAbi } from "../../lib/abi/v2/expiryCalendar";
import { orderBookAbi } from "../../lib/abi/v2/orderBook";
import { settlementOracleAbi } from "../../lib/abi/v2/settlementOracle";
import { stockZapAbi } from "../../lib/abi/v2/stockZap";
import type { BuyQuote } from "../../lib/v2/ticket";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MARKET_FILE = join(WEB, "lib/markets.generated.ts");

const RPC = process.env.TRADING_FORK_RPC ?? "";
const REGISTRY = process.env.TRADING_FORK_REGISTRY ?? "";
const OUT = process.env.TRADING_FORK_OUT ?? join(mkdtempSync(join(tmpdir(), "trading-legs-")), "legs.json");
const TICKER = process.env.TRADING_FORK_TICKER ?? "NVDA";

type Leg = { leg: string; pass: boolean; txs: Hex[]; expected: Record<string, string>; actual: Record<string, string>; note?: string };
const legs: Leg[] = [];
const s = (v: bigint | number | boolean | string | null | undefined) => String(v);

function refuse(message: string): never {
  console.error(`trading-legs: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  if (!RPC) refuse("TRADING_FORK_RPC is required");
  if (!REGISTRY) refuse("TRADING_FORK_REGISTRY is required");
  const host = new URL(RPC).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") refuse(`RPC host ${host} is not loopback`);
  // Before any web module loads: lib/chain.ts reads these at import.
  process.env.NEXT_PUBLIC_RPC_URL = RPC;
  process.env.NEXT_PUBLIC_RPC_URL_2 = RPC;
  process.env.NEXT_PUBLIC_CHAIN_ID = "4663";

  const raw = createPublicClient({ transport: http(RPC) });
  const chainId = await raw.getChainId();
  if (chainId !== 4663) refuse(`chain ${chainId} is not 4663`);
  const version = await raw.request({ method: "web3_clientVersion" as never }) as string;
  if (!String(version).startsWith("anvil")) refuse(`node ${version} is not anvil`);

  const registry = JSON.parse(readFileSync(REGISTRY, "utf8")) as {
    shared: { usdg: string }; v2: { contracts: Record<string, string | null> };
    markets: { ticker: string; asset: string }[] };
  const market = registry.markets.find((m) => m.ticker === TICKER);
  assert(market, `the registry has no ${TICKER}`);

  // The v9 registry carries `v2.chainlinkBand` (contracts side), which the web generator at this harness's
  // base does not list in V2_MARKET_KEYS yet, so it refuses the file. No web trading module reads the band (it is a
  // registration input for the oracle), so the generator gets a copy with exactly that one key removed. Any OTHER
  // unknown key still fails the generator, as it should.
  const genRegistry = JSON.parse(readFileSync(REGISTRY, "utf8")) as { markets: { v2?: Record<string, unknown> }[] };
  let stripped = 0;
  for (const m of genRegistry.markets) if (m.v2 && "chainlinkBand" in m.v2) { delete m.v2.chainlinkBand; stripped++; }
  const genRegistryPath = join(mkdtempSync(join(tmpdir(), "trading-legs-reg-")), "tier1.json");
  writeFileSync(genRegistryPath, JSON.stringify(genRegistry, null, 2));
  console.log(`trading-legs: generator registry = fork registry minus v2.chainlinkBand on ${stripped} market(s)`);

  const original = readFileSync(MARKET_FILE, "utf8");
  try {
    const gen = spawnSync(process.execPath, ["scripts/gen-markets.mjs", "--registry", genRegistryPath], { cwd: WEB, encoding: "utf8" });
    assert.equal(gen.status, 0, `gen-markets --registry failed: ${gen.stderr}`);
    await runLegs(registry, getAddress(market.asset));
  } finally {
    writeFileSync(MARKET_FILE, original);
  }
}

async function runLegs(registry: { shared: { usdg: string }; v2: { contracts: Record<string, string | null> } }, asset: Address) {
  // Dynamic: these modules read the regenerated registry and the fork RPC at import.
  const { robinhoodChain } = await import("../../lib/chain");
  const cfg = await import("../../lib/v2/config");
  const tx = await import("../../lib/v2/tx");
  const zap = await import("../../lib/v2/zapTx");
  const earn = await import("../../lib/v2/earnTx");
  const { bookFromChain } = await import("../../lib/v2/bookFromChain");
  const { buyQuote } = await import("../../lib/v2/ticket");
  const { quoteSell, verifySellOrders } = await import("../../lib/v2/portfolio");
  const { staleSelectedOrders } = await import("../../lib/v2/ticket");
  const { readOrderPreflight, readSeriesOnChain } = await import("../../lib/v2/chainReads");
  const { V2_ERROR_TEXT } = await import("../../lib/v2/errors");

  const C = registry.v2.contracts;
  const orderBook = getAddress(C.orderBook!);
  const clearinghouse = getAddress(C.clearinghouse!);
  const oracle = getAddress(C.settlementOracle!);
  const calendar = getAddress(C.expiryCalendar!);
  const stockZap = getAddress(C.stockZap!);
  const usdg = getAddress(registry.shared.usdg);
  // The web lib resolves the same addresses: proves the regeneration took before anything is sent.
  assert.equal(cfg.requireV2Address("orderBook"), orderBook, "web lib orderBook is the fork's");
  assert.equal(cfg.requireV2Address("clearinghouse"), clearinghouse, "web lib clearinghouse is the fork's");
  assert.equal(cfg.requireV2Address("stockZap"), stockZap, "web lib stockZap is the fork's");

  // cacheTime 0: viem caches getBlockNumber for 4 s by default, and bookFromChain / readSeriesOnChain pin their reads to
  // it. The harness reads the book within milliseconds of its own write, which no page does, so with the cache a read
  // right after a place or replace sees the block BEFORE it (run 2: a live bid missing from the book, a replaced ask
  // still quoted). This is a harness artefact; the pages' own guard against a stale book is the preflight below.
  const client = createPublicClient({ chain: robinhoodChain, transport: http(RPC), cacheTime: 0 }) as PublicClient;
  const wallet = createWalletClient({ chain: robinhoodChain, transport: http(RPC) }) as WalletClient;
  const rpc = (method: string, params: unknown[]) => client.request({ method: method as never, params: params as never });
  const ctx = (account: Address) => ({ account, wallet, client });

  const fresh = async (): Promise<Address> => {
    const a = privateKeyToAccount(generatePrivateKey()).address;
    await rpc("anvil_impersonateAccount", [a]);
    await rpc("anvil_setBalance", [a, "0x56BC75E2D63100000"]); // 100 ETH for gas
    return a;
  };
  const deployer = getAddress("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  const W = await fresh(); // writer
  const B = await fresh(); // buyer
  const K = await fresh(); // bidder / second taker
  const fund = async (to: Address, amount: bigint) => {
    const h = await wallet.writeContract({ account: deployer, chain: robinhoodChain, address: usdg, abi: erc20Abi, functionName: "transfer", args: [to, amount] });
    assert.equal((await client.waitForTransactionReceipt({ hash: h })).status, "success");
  };
  await fund(W, 300_000_000n);
  await fund(B, 100_000_000n);
  await fund(K, 50_000_000n);

  const bal = (token: Address, who: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  const long = (who: Address, id: bigint) => client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "balanceOf", args: [who, id] });
  const free = (who: Address, a: Address) => client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "free", args: [who, a] });
  const now = async () => Number((await client.getBlock({ blockTag: "latest" })).timestamp);
  const receiptOf = (hash: Hex) => client.getTransactionReceipt({ hash });

  const leg = async (name: string, body: (l: Leg) => Promise<void>) => {
    const l: Leg = { leg: name, pass: false, txs: [], expected: {}, actual: {} };
    try { await body(l); } catch (error) { l.pass = false; l.note = `${l.note ? `${l.note}; ` : ""}ERROR ${(error as Error).message}`; }
    legs.push(l);
    console.log(JSON.stringify(l));
  };

  const [spot] = await client.readContract({ address: oracle, abi: settlementOracleAbi, functionName: "spot", args: [asset] });
  const fp = await client.readContract({ address: orderBook, abi: orderBookAbi, functionName: "feeParams" });
  const fees = { takerFeeFlat: BigInt(fp.takerFeeFlat), takerFeeCapBps: Number(fp.takerFeeCapBps) };
  const mkt = await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "market", args: [asset] });

  // ---- 1. StockZap buy: USDG -> Stock Token credited to the writer's Clearinghouse ledger ------------------------
  await leg("StockZap buy (writeZap)", async (l) => {
    const usdgIn = 280_000_000n;
    const quote = zap.quoteWriteZap(usdgIn, spot, 6, 18);
    assert(quote, "quoteWriteZap priced the zap");
    const [u0, f0] = [await bal(usdg, W), await free(W, asset)];
    const approve = await tx.approveExact(ctx(W), usdg, stockZap, usdgIn);
    if (approve) l.txs.push(approve);
    const hash = await zap.writeZap(ctx(W), asset, usdgIn, spot, 6, 18);
    l.txs.push(hash);
    const [u1, f1] = [await bal(usdg, W), await free(W, asset)];
    const ev = parseEventLogs({ abi: stockZapAbi, eventName: "WriteZapped", logs: (await receiptOf(hash)).logs });
    l.expected = { usdgDelta: s(-usdgIn), freeAssetDeltaAtLeast: s(quote.minOut), eventAssetOut: "== free delta" };
    l.actual = { usdgDelta: s(u1 - u0), freeAssetDelta: s(f1 - f0), eventAssetOut: s(ev[0]?.args.assetOut) };
    l.pass = u1 - u0 === -usdgIn && f1 - f0 >= quote.minOut && ev.length === 1 && ev[0]!.args.assetOut === f1 - f0;
  });

  // ---- 2. Writer: operator approval, series, AskWrite ------------------------------------------------------------
  const t0 = await now();
  const expiry = Number(await client.readContract({ address: calendar, abi: expiryCalendarAbi, functionName: "nextExpiry", args: [t0, false] }));
  const tick = BigInt(mkt.strikeTick);
  const strike = (spot / tick - 1n) * tick; // one tick in the money for a call
  let longId = 0n;
  let cpu = 0n;
  let cutoff = 0;
  let askId = 0n;
  const ASK_PRICE = 5_000_000n;
  await leg("writer: setOperator, createSeries, AskWrite 1 share", async (l) => {
    l.txs.push(await tx.setOperator(ctx(W), orderBook, true));
    l.txs.push(await earn.createSeries(ctx(W), asset, false, strike, expiry));
    longId = await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "longIdOf", args: [asset, false, strike, expiry] });
    cpu = await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "collateralPerUnit", args: [longId] });
    cutoff = Number(await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "mintCutoff", args: [longId] }));
    const validUntil = earn.nextAskExpiry(await now(), cutoff);
    const hash = await tx.place(ctx(W), longId, 2, ASK_PRICE, 100n, validUntil);
    l.txs.push(hash);
    const placed = parseEventLogs({ abi: orderBookAbi, eventName: "OrderPlaced", logs: (await receiptOf(hash)).logs });
    askId = placed[0]!.args.orderId;
    l.expected = { kind: "2 (AskWrite)", units: "100", price: s(ASK_PRICE), strike: s(strike), expiry: s(expiry) };
    l.actual = { kind: s(placed[0]?.args.kind), units: s(placed[0]?.args.units), price: s(placed[0]?.args.price), longId: s(longId), orderId: s(askId) };
    l.pass = placed.length === 1 && placed[0]!.args.kind === 2 && placed[0]!.args.units === 100n && placed[0]!.args.price === ASK_PRICE;
  });

  const rentNow = async () => ({ collateralPerUnit: cpu, mintFeePpm: Number(mkt.mintFeePpm), expiry, snapshotTimestamp: await now(), mintCutoff: cutoff });
  const buy = async (who: Address, units: bigint) => {
    const book = await bookFromChain(longId, asset, cpu, cutoff, client);
    const q = buyQuote(book.asks, units, fees, 200, who, await rentNow());
    assert(q.limitPrice !== null && q.buy.filledUnits === units, `the book fills ${units} (got ${q.buy.filledUnits})`);
    // TradeTicket.tsx paramsFor / executeCrossing, mirrored.
    const request = { longId, buying: true, orderIds: q.buy.orderIds.map(BigInt), units, minUnits: units, limitPrice: q.limitPrice,
      writeToSell: false, recipient: who };
    const expected = { filled: q.buy.filledUnits, premium: q.buy.premium, takerFee: q.buy.fee, sellerFees: 0n };
    return { q, request, expected };
  };
  // TradeTicket.tsx executeCrossing (:228-241), mirrored: re-read the series and the selected orders at one block, and a
  // changed order stops the trade with the ticket's own text before any requote or approval. assertSeriesTermsMatch is
  // not mirrored: it compares the API's display row, and this run has no indexer.
  const TICKET_STALE = "An ask changed or lost collateral. Refresh the book and review your quote.";
  const ticketPreflight = async (q: BuyQuote) => {
    const series = await readSeriesOnChain(longId, client);
    if (!series.exists) throw new Error("This option is no longer on chain.");
    const orders = await readOrderPreflight(q.buy.orderIds.map(BigInt), asset, client, series.blockNumber);
    const stale = staleSelectedOrders(q, orders.map(({ orderId, order, freeCollateral }) => ({
      orderId, maker: order.maker, longId: order.longId, kind: order.kind, price: order.price,
      units: order.units, filled: order.filled, validUntil: order.validUntil, cancelled: order.cancelled, freeCollateral,
    })), longId, series.collateral, series.snapshotTimestamp, { collateralPerUnit: series.collateral,
      mintFeePpm: series.series.mintFeePpm, expiry: Number(series.series.expiry), mintCutoff: Number(series.cutoff),
      snapshotTimestamp: series.snapshotTimestamp });
    if (stale.length) throw new Error(TICKET_STALE);
  };

  // ---- 3. Buy from a listed ask ----------------------------------------------------------------------------------
  await leg("buy from a listed ask (0.6 share)", async (l) => {
    const units = 60n;
    const { q, request, expected } = await buy(B, units);
    await ticketPreflight(q);
    await tx.recheckTakeQuote(ctx(B), request, expected);
    const approve = await tx.approveExact(ctx(B), usdg, orderBook, expected.premium + expected.takerFee);
    if (approve) l.txs.push(approve);
    const params = await tx.recheckTakeQuote(ctx(B), request, expected);
    const [bu0, bl0, wu0] = [await bal(usdg, B), await long(B, longId), await bal(usdg, W)];
    const result = await tx.take(ctx(B), params);
    l.txs.push(result.hash);
    const [bu1, bl1, wu1] = [await bal(usdg, B), await long(B, longId), await bal(usdg, W)];
    l.expected = { buyerUsdgDelta: s(-(q.buy.premium + q.buy.fee)), buyerLongDelta: s(units), unitsFilled: s(units) };
    l.actual = { buyerUsdgDelta: s(bu1 - bu0), buyerLongDelta: s(bl1 - bl0), unitsFilled: s(result.unitsFilled), writerUsdgDelta: s(wu1 - wu0) };
    l.pass = bu1 - bu0 === -(q.buy.premium + q.buy.fee) && bl1 - bl0 === units && result.unitsFilled === units && wu1 > wu0;
  });

  // ---- 4. List for resale, 5. cancel ---------------------------------------------------------------------------
  let resaleId = 0n;
  await leg("list for resale (0.2 share AskResale)", async (l) => {
    l.txs.push(await tx.setTokenApproval(ctx(B), orderBook, true));
    const validUntil = await tx.restingValidUntil(client, expiry);
    assert(validUntil !== null, "a resting validUntil exists before expiry");
    const [bl0, ob0] = [await long(B, longId), await long(orderBook, longId)];
    const hash = await tx.place(ctx(B), longId, 1, 6_000_000n, 20n, validUntil);
    l.txs.push(hash);
    resaleId = parseEventLogs({ abi: orderBookAbi, eventName: "OrderPlaced", logs: (await receiptOf(hash)).logs })[0]!.args.orderId;
    const [bl1, ob1] = [await long(B, longId), await long(orderBook, longId)];
    l.expected = { sellerLongDelta: "-20", bookEscrowDelta: "+20" };
    l.actual = { sellerLongDelta: s(bl1 - bl0), bookEscrowDelta: s(ob1 - ob0), orderId: s(resaleId) };
    l.pass = bl1 - bl0 === -20n && ob1 - ob0 === 20n;
  });
  await leg("cancel the resale ask", async (l) => {
    const bl0 = await long(B, longId);
    l.txs.push(await tx.cancel(ctx(B), [resaleId]));
    const bl1 = await long(B, longId);
    const [order] = await client.readContract({ address: orderBook, abi: orderBookAbi, functionName: "getOrders", args: [[resaleId]] });
    l.expected = { sellerLongDelta: "+20", cancelled: "true" };
    l.actual = { sellerLongDelta: s(bl1 - bl0), cancelled: s(order?.cancelled) };
    l.pass = bl1 - bl0 === 20n && order?.cancelled === true;
  });

  // ---- 6. Sell into a bid (another wallet's) ----------------------------------------------------------------------
  await leg("sell into another wallet's bid (0.1 share)", async (l) => {
    const BID = 4_000_000n;
    const escrow = BID * 10n / 100n;
    const approve = await tx.approveExact(ctx(K), usdg, orderBook, escrow);
    if (approve) l.txs.push(approve);
    const validUntil = await tx.restingValidUntil(client, expiry);
    l.txs.push(await tx.place(ctx(K), longId, 0, BID, 10n, validUntil!));
    const book = await bookFromChain(longId, asset, cpu, cutoff, client);
    const sq = quoteSell(book.bids, 10n, fees, Number(fp.resaleFeeBps), B);
    assert(sq.filled === 10n && sq.limitPrice !== null, `the bid covers the sale (filled ${sq.filled}, bid levels ${book.bids.length})`);
    // Portfolio.tsx executeSellQuote (:66-79), mirrored: the selected bids are re-read and must be unchanged. The page
    // passes wall-clock seconds as `now`; the harness passes the fork's clock, which the settlement leg runs ahead.
    const current = await readOrderPreflight(sq.orderIds.map(BigInt), asset, client);
    if (!verifySellOrders(sq, current.map((row) => ({ orderId: row.orderId, ...row.order })), longId, await now()))
      throw new Error("A bid changed. Refresh the book and review the new proceeds.");
    // Portfolio.tsx's sell `expected`, mirrored.
    const request = { longId, buying: false, orderIds: sq.orderIds.map(BigInt), units: 10n, minUnits: 10n, limitPrice: sq.limitPrice,
      writeToSell: false, recipient: B };
    const expected = { filled: sq.filled, premium: sq.premium, takerFee: sq.fee, sellerFees: sq.sellerFee };
    const params = await tx.recheckTakeQuote(ctx(B), request, expected);
    const [bu0, bl0, kl0] = [await bal(usdg, B), await long(B, longId), await long(K, longId)];
    const result = await tx.take(ctx(B), params);
    l.txs.push(result.hash);
    const [bu1, bl1, kl1] = [await bal(usdg, B), await long(B, longId), await long(K, longId)];
    l.expected = { sellerUsdgDelta: s(sq.net), sellerLongDelta: "-10", bidderLongDelta: "+10" };
    l.actual = { sellerUsdgDelta: s(bu1 - bu0), sellerLongDelta: s(bl1 - bl0), bidderLongDelta: s(kl1 - kl0) };
    l.pass = bu1 - bu0 === sq.net && bl1 - bl0 === -10n && kl1 - kl0 === 10n;
  });

  // ---- 7. Stale quote. (a) The writer reprices after the buyer quoted: the ticket's preflight refuses with its own text
  // before any requote or approval. (b) A fresh quote sent past its deadline: the contract refuses it and the app decodes
  // the error name. Nothing moves in either. (c): the same stale request put straight to the on-chain requote --
  // what the ticket meets if the order changes between its preflight read and its requote read -- must now read as the
  // decoded BelowMinUnits copy (it used to be viem's raw ~936-character dump). A PASS CONDITION.
  await leg("stale quote fails safely with a decoded message", async (l) => {
    const { q, request, expected } = await buy(B, 10n);
    // The writer reprices the ask, which cancels the quoted order id and places a new one.
    const remaining = 100n - 60n;
    l.txs.push(await tx.replace(ctx(W), askId, 5_500_000n, remaining));
    const [bu0, bl0] = [await bal(usdg, B), await long(B, longId)];
    let staleMessage = "";
    try {
      await ticketPreflight(q);
      await tx.recheckTakeQuote(ctx(B), request, expected);
    } catch (e) { staleMessage = (e as Error).message; }
    let requoteMessage = "";
    try { await tx.recheckTakeQuote(ctx(B), request, expected); } catch (e) { requoteMessage = (e as Error).message; }
    const fresh = await buy(B, 10n);
    await ticketPreflight(fresh.q);
    const freshParams = await tx.recheckTakeQuote(ctx(B), fresh.request, fresh.expected);
    let expiredMessage = "";
    try { await tx.take(ctx(B), { ...freshParams, deadline: (await now()) - 1 }); } catch (e) { expiredMessage = (e as Error).message; }
    const [bu1, bl1] = [await bal(usdg, B), await long(B, longId)];
    l.expected = { stale: TICKET_STALE, expired: V2_ERROR_TEXT.DeadlinePassed, requote: V2_ERROR_TEXT.BelowMinUnits,
      buyerUsdgDelta: "0", buyerLongDelta: "0" };
    l.actual = { stale: staleMessage, expired: expiredMessage, requote: requoteMessage, buyerUsdgDelta: s(bu1 - bu0),
      buyerLongDelta: s(bl1 - bl0), requoteLength: s(requoteMessage.length) };
    l.note = `(c) the requote alone threw ${requoteMessage.length} chars: "${requoteMessage.split("\n")[0]}"`;
    l.pass = staleMessage === TICKET_STALE && expiredMessage === V2_ERROR_TEXT.DeadlinePassed &&
      requoteMessage === V2_ERROR_TEXT.BelowMinUnits && bu1 === bu0 && bl1 === bl0;
  });

  // ---- 8. StockZap exit: Stock Token -> USDG --------------------------------------------------------------------
  await leg("StockZap exit (exitZap)", async (l) => {
    const available = await free(W, asset);
    const amount = available < 100_000_000_000_000_000n ? available : 100_000_000_000_000_000n; // up to 0.1 share
    assert(amount > 0n, "the writer has free Stock Token to exit");
    l.txs.push(await tx.withdraw(ctx(W), asset, amount));
    const approve = await tx.approveExact(ctx(W), asset, stockZap, amount);
    if (approve) l.txs.push(approve);
    const quote = zap.quoteExitZap(amount, spot, 6, 18);
    assert(quote, "quoteExitZap priced the exit");
    const [u0, a0] = [await bal(usdg, W), await bal(asset, W)];
    const hash = await zap.exitZap(ctx(W), asset, amount, spot, 6, 18);
    l.txs.push(hash);
    const [u1, a1] = [await bal(usdg, W), await bal(asset, W)];
    const ev = parseEventLogs({ abi: stockZapAbi, eventName: "ExitZapped", logs: (await receiptOf(hash)).logs });
    l.expected = { assetDelta: s(-amount), usdgDeltaAtLeast: s(quote.minOut), eventUsdgOut: "== usdg delta" };
    l.actual = { assetDelta: s(a1 - a0), usdgDelta: s(u1 - u0), eventUsdgOut: s(ev[0]?.args.usdgOut) };
    l.pass = a1 - a0 === -amount && u1 - u0 >= quote.minOut && ev.length === 1 && ev[0]!.args.usdgOut === u1 - u0;
  });

  // ---- 9. Settle after expiry, then redeem the long (buyer) and the short (writer) --------------------------------
  await leg("settle after expiry, redeem long and short", async (l) => {
    // FIXED GAS, as the keeper sends these (keeper/src/v2/cranker/constants.ts:63-95). snapshot, finalize and settle
    // reach the sources through raw calls / try-catch that swallow an inner out-of-gas, so eth_estimateGas finds a limit
    // at which the outer call succeeds and the source did nothing. Run 2 sent snapshot on the estimate: the pool's
    // observe ran out of gas inside UniV3TwapSource.record, snapshot returned 0, and no source was ever recorded.
    const GAS = { snapshot: 800_000n, finalize: 1_500_000n, settle: 1_500_000n };
    const send = async (fn: "snapshot" | "finalize") => {
      const h = await wallet.writeContract({ account: deployer, chain: robinhoodChain, address: oracle, abi: settlementOracleAbi, functionName: fn, args: [asset, expiry], gas: GAS[fn] });
      assert.equal((await client.waitForTransactionReceipt({ hash: h })).status, "success", `${fn} reverted`);
      l.txs.push(h);
    };
    const warp = async (ts: number) => { await rpc("evm_setNextBlockTimestamp", [ts]); await rpc("evm_mine", []); };
    await warp(expiry + 60);
    await send("snapshot");
    await warp(expiry + 180);
    await send("finalize");
    // The oracle captures the sources' window prices at the first finalize, not at snapshot.
    const recorded = await client.readContract({ address: oracle, abi: settlementOracleAbi, functionName: "recordedSources", args: [asset, expiry] });
    let info = await client.readContract({ address: oracle, abi: settlementOracleAbi, functionName: "settlementInfo", args: [asset, expiry] });
    const notes = [`sources ok=${recorded[1].join(",")} prices=${recorded[2].join(",")}`, `after first finalize status=${info[0]} corroborated=${info[3]}`];
    l.note = notes.join("; ");
    // V2Types.SettlementStatus: None 0, Pending 1, Finalized 2, Held 3 (V2Types.sol SettlementStatus).
    if (info[0] !== 2) {
      // Uncorroborated: the candidate waits out the market's delay, then a second finalize settles it.
      const [, , uncorroboratedDelay] = await client.readContract({ address: oracle, abi: settlementOracleAbi, functionName: "marketConfig", args: [asset] });
      await warp(expiry + 180 + Number(uncorroboratedDelay) + 5);
      await send("finalize");
      info = await client.readContract({ address: oracle, abi: settlementOracleAbi, functionName: "settlementInfo", args: [asset, expiry] });
      notes.push(`after the uncorroborated delay (${uncorroboratedDelay}s) status=${info[0]} corroborated=${info[3]}`);
      l.note = notes.join("; ");
    }
    const settleHash = await wallet.writeContract({ account: deployer, chain: robinhoodChain, address: clearinghouse, abi: clearinghouseAbi, functionName: "settle", args: [longId], gas: GAS.settle });
    assert.equal((await client.waitForTransactionReceipt({ hash: settleHash })).status, "success", "settle reverted");
    l.txs.push(settleHash);
    const series = await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "series", args: [longId] });
    const shortId = await client.readContract({ address: clearinghouse, abi: clearinghouseAbi, functionName: "shortIdOf", args: [longId] });
    const held = await long(B, longId);
    const [bu0] = [await bal(usdg, B)];
    const redeemLong = await tx.redeem(ctx(B), longId);
    l.txs.push(redeemLong);
    const bu1 = await bal(usdg, B);
    const redeemedLong = parseEventLogs({ abi: clearinghouseAbi, eventName: "Redeemed", logs: (await receiptOf(redeemLong)).logs });
    const shortHeld = await long(W, shortId);
    const [wf0, wa0] = [await free(W, asset), await bal(asset, W)];
    const redeemShort = await tx.redeem(ctx(W), shortId);
    l.txs.push(redeemShort);
    const [wf1, wa1] = [await free(W, asset), await bal(asset, W)];
    l.expected = { settled: "true", longPayout: "> 0 USDG for an in-the-money call (converted over the payout route)",
      buyerLongAfter: "0", writerShortAfter: "0", writerCollateralBack: "> 0 Stock Token" };
    l.actual = { settled: s(series.settled), settlementPrice: s(series.settlementPrice), strike: s(strike),
      longPayoutPerUnit: s(series.longPayoutPerUnit), longHeld: s(held), buyerUsdgDelta: s(bu1 - bu0),
      redeemedEvents: s(redeemedLong.length), buyerLongAfter: s(await long(B, longId)), shortHeld: s(shortHeld),
      writerShortAfter: s(await long(W, shortId)), writerCollateralBack: s((wf1 - wf0) + (wa1 - wa0)) };
    l.note = notes.join("; ");
    l.pass = info[0] === 2 && series.settled && bu1 > bu0 && (await long(B, longId)) === 0n && (await long(W, shortId)) === 0n && (wf1 - wf0) + (wa1 - wa0) > 0n;
  });

  const block = await client.getBlockNumber();
  const summary = { rpcHost: "127.0.0.1", chainId: await client.getChainId(), forkHeadAtEnd: s(block), registry: REGISTRY, legs };
  writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(`trading-legs: ${legs.filter((x) => x.pass).length}/${legs.length} legs passed; record ${OUT}`);
  if (legs.some((x) => !x.pass)) process.exitCode = 1;
}

main().catch((error) => { console.error(error); process.exit(1); });
