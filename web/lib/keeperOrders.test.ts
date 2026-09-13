import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { getAddress, type Address, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CLEARINGHOUSE, OVERCALL_FEE_RECIPIENT, SEAPORT, USDG } from "./contracts";
import {
  KEEPER_MAX_ORDERS,
  KEEPER_REASONS,
  NOT_CONFIGURED,
  componentsStruct,
  fetchKeeperOrders,
  isKeeperOrder,
  parseKeeperOrdersUrl,
  restoreComponents,
  seaportOrderHash,
  serveKeeperOrders,
  verifyKeeperOrders,
  type KeeperChainReader,
  type KeeperCheckConfig,
  type KeeperOrderJson,
  type OrderComponentsStruct,
} from "./keeperOrders";
import { REASONS, checkListingIsOurs } from "./overcall";

/**
 * The keeper is not trusted. One good /orders entry, as keeper/src/health.ts serves it, then one
 * way for it to be wrong per test.
 *
 * The chain is a fixture reader whose getOrderHash is the real Seaport EIP-712 derivation
 * (seaportOrderHash), not a lookup table, so a tampered field really does move the hash and a
 * forgotten counter really does produce a different one. The fork acceptance
 * (tests/acceptance/fork.acceptance.ts) asserts that derivation equals Seaport.getOrderHash on
 * chain.
 *
 * The order is the lib/overcall.test.ts reference listing: the vault offers 20 contracts at
 * 4.000000 USDG, 3.800000 to the vault and 0.200000 to Overcall per contract. Seaport's counter
 * for the vault is 7, not 0, so a check that skipped the restore would hash the wrong order.
 */
const VAULT_T = getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
const STRANGER = getAddress("0x2222222222222222222222222222222222222222");
const OPTION_ID = "56885395977254369119998982131173877604217583767740146085872832926902011297792";
const SALT = "95941992777576660739888578361827826050802484697670100586800480598437555708740";
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const PLACEHOLDER_SIGNATURE = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as Hex;
const COUNTER = 7n;
const NOW = 1_789_000_000;
const END = String(NOW + 3600);

const CONFIG: KeeperCheckConfig = {
  vault: VAULT_T,
  usdg: USDG,
  clearinghouse: CLEARINGHOUSE,
  seaport: SEAPORT,
  chainId: 4663,
};

type Parameters = KeeperOrderJson["parameters"];

function goodParameters(): Parameters {
  return {
    offerer: VAULT_T,
    zone: "0x0000000000000000000000000000000000000000",
    offer: [{ itemType: 3, token: CLEARINGHOUSE, identifierOrCriteria: OPTION_ID, startAmount: "20", endAmount: "20" }],
    consideration: [
      { itemType: 1, token: USDG, identifierOrCriteria: "0", startAmount: "76000000", endAmount: "76000000", recipient: VAULT_T },
      {
        itemType: 1,
        token: USDG,
        identifierOrCriteria: "0",
        startAmount: "4000000",
        endAmount: "4000000",
        recipient: OVERCALL_FEE_RECIPIENT,
      },
    ],
    orderType: 1,
    startTime: "0",
    endTime: END,
    zoneHash: ZERO32,
    salt: SALT,
    conduitKey: ZERO32,
    totalOriginalConsiderationItems: "2",
  };
}

function hashOf(parameters: Parameters, counter: bigint): Hex {
  return seaportOrderHash(componentsStruct(restoreComponents(parameters, counter)));
}

/** Everything /orders serves for one order, including the fields this lib must not pass on. */
function keeperEntry(parameters: Parameters = goodParameters(), counter: bigint = COUNTER) {
  return {
    orderHash: hashOf(parameters, counter),
    chainId: 4663,
    seaport: SEAPORT,
    optionId: OPTION_ID,
    contracts: "20",
    unitPrice6: "4000000",
    grossUsdg6: "80000000",
    endTime: Number(parameters.endTime),
    status: "post_failed",
    bookStatus: "rejected: detail from the book the keeper posted to",
    parameters,
    signature: PLACEHOLDER_SIGNATURE,
  };
}

type Slot = Awaited<ReturnType<KeeperChainReader["vaultListing"]>>;

function fakeChain(overrides: {
  slot?: Partial<Slot>;
  counters?: Record<string, bigint>;
  status?: { isCancelled: boolean; totalFilled: bigint; totalSize: bigint };
  failCounterFor?: Address;
  failVault?: boolean;
} = {}) {
  const calls = { getCounter: [] as Address[], getOrderHash: [] as OrderComponentsStruct[], vaultListing: 0 };
  const reader: KeeperChainReader = {
    async vaultListing() {
      calls.vaultListing += 1;
      if (overrides.failVault) throw new Error("rpc down");
      return {
        phase: 1,
        listingHash: hashOf(goodParameters(), COUNTER),
        listingAmount: 20n,
        listingGrossUsdg: 80_000_000n,
        optionId: BigInt(OPTION_ID),
        ...overrides.slot,
      };
    },
    async getCounter(offerer) {
      calls.getCounter.push(offerer);
      if (overrides.failCounterFor !== undefined && offerer === overrides.failCounterFor) throw new Error("rpc down");
      return (overrides.counters ?? { [VAULT_T]: COUNTER })[offerer] ?? 0n;
    },
    async getOrderHash(components) {
      calls.getOrderHash.push(components);
      return seaportOrderHash(components);
    },
    async getOrderStatus() {
      return overrides.status ?? { isCancelled: false, totalFilled: 0n, totalSize: 0n };
    },
  };
  return { reader, calls };
}

async function reasonsFor(entry: unknown, chain = fakeChain().reader, now = NOW): Promise<string[]> {
  const { orders, rejected } = await verifyKeeperOrders([entry], chain, CONFIG, now);
  expect(orders).toEqual([]);
  expect(rejected).toHaveLength(1);
  return rejected[0]!.reasons;
}

/*//////////////////////////////////////////////////////////////
                         verifyKeeperOrders
//////////////////////////////////////////////////////////////*/

describe("verifyKeeperOrders", () => {
  it("accepts the vault's order, restoring Seaport's counter from the chain", async () => {
    const { reader, calls } = fakeChain();
    const { orders, rejected } = await verifyKeeperOrders([keeperEntry()], reader, CONFIG, NOW);
    expect(rejected).toEqual([]);
    expect(orders).toHaveLength(1);
    const row = orders[0]!;

    // The counter came from Seaport for the offerer, and it is what was hashed.
    expect(calls.getCounter).toEqual([VAULT_T]);
    expect(calls.getOrderHash.map((c) => c.counter)).toEqual([COUNTER]);
    expect(row.components.counter).toBe("7");
    expect(row.counter).toBe("7");
    // Without the restore the hash is a different order: the check would be looking at nothing.
    expect(hashOf(goodParameters(), 0n)).not.toBe(hashOf(goodParameters(), COUNTER));
    expect(row.orderHash).toBe(hashOf(goodParameters(), COUNTER).toLowerCase());

    // The row is a book row the page's own check accepts, with figures from the components.
    const slot = await reader.vaultListing();
    const pageCheck = checkListingIsOurs(
      row,
      {
        ...CONFIG,
        listingHash: slot.listingHash,
        amount: slot.listingAmount,
        grossUsdg: slot.listingGrossUsdg,
        optionId: slot.optionId,
      },
      NOW,
    );
    expect(pageCheck).toEqual({ ok: true });
    expect(row).toMatchObject({
      chainId: 4663,
      offerer: VAULT_T,
      optionId: OPTION_ID,
      quantity: "20",
      remaining: "20",
      unitPrice6: "4000000",
      totalPrice6: "80000000",
      status: "open",
      signature: PLACEHOLDER_SIGNATURE,
    });

    // Nothing else the keeper said is passed on.
    expect(Object.keys(row).sort()).toEqual(
      [
        "chainId",
        "components",
        "counter",
        "endTime",
        "offerer",
        "optionId",
        "orderHash",
        "quantity",
        "remaining",
        "salt",
        "signature",
        "startTime",
        "status",
        "totalPrice6",
        "unitPrice6",
      ].sort(),
    );
    expect(JSON.stringify(row)).not.toContain("detail from the book");
    expect(JSON.stringify(row)).not.toContain("totalOriginalConsiderationItems");
  });

  it("reads remaining contracts from Seaport's fill fraction, not from the keeper", async () => {
    // Seaport stores the fraction reduced: 5 of 20 is 1/4.
    const { reader } = fakeChain({ status: { isCancelled: false, totalFilled: 1n, totalSize: 4n } });
    const { orders } = await verifyKeeperOrders([keeperEntry()], reader, CONFIG, NOW);
    expect(orders[0]).toMatchObject({ remaining: "15", status: "partial", quantity: "20" });
  });

  it("rejects an order whose hash is not the vault's listingHash", async () => {
    // A well-formed, correctly hashed order of the vault's, but not the one it authorised.
    const other = goodParameters();
    other.salt = "1";
    const reasons = await reasonsFor(keeperEntry(other));
    expect(reasons).toContain(REASONS.hashMismatch);
    expect(reasons).not.toContain(KEEPER_REASONS.claimedHash);
  });

  it("rejects an order when the vault has nothing authorised", async () => {
    const reasons = await reasonsFor(keeperEntry(), fakeChain({ slot: { listingHash: ZERO32 } }).reader);
    expect(reasons).toContain(REASONS.hashNone);
  });

  it("rejects a hash the keeper names that Seaport does not compute for its parameters", async () => {
    const entry = { ...keeperEntry(), orderHash: hashOf(goodParameters(), 0n) };
    expect(await reasonsFor(entry)).toEqual([KEEPER_REASONS.claimedHash]);
  });

  it("rejects the wrong offerer", async () => {
    const stranger = goodParameters();
    stranger.offerer = STRANGER;
    // Even if the vault's slot somehow carried that order's hash, the seller is still wrong.
    const hash = hashOf(stranger, 0n);
    const { reader, calls } = fakeChain({ slot: { listingHash: hash } });
    const reasons = await reasonsFor(keeperEntry(stranger, 0n), reader);
    expect(calls.getCounter).toEqual([STRANGER]);
    expect(reasons).toContain(REASONS.seller);
  });

  it("rejects an expired order", async () => {
    const expired = goodParameters();
    expired.endTime = String(NOW);
    const hash = hashOf(expired, COUNTER);
    const reasons = await reasonsFor(keeperEntry(expired), fakeChain({ slot: { listingHash: hash } }).reader);
    expect(reasons).toEqual([REASONS.expired]);
  });

  it.each([
    [0, "Idle"],
    [2, "Exercisable"],
    [3, "Settling"],
  ])("rejects the order when the vault's phase is %i (%s), not Listed", async (phase) => {
    const reasons = await reasonsFor(keeperEntry(), fakeChain({ slot: { phase } }).reader);
    expect(reasons).toEqual([KEEPER_REASONS.phase]);
  });

  it("rejects a swapped premium recipient even when the keeper names the authorised hash", async () => {
    const tampered = goodParameters();
    tampered.consideration[0]!.recipient = STRANGER;
    const entry = { ...keeperEntry(tampered), orderHash: hashOf(goodParameters(), COUNTER) };
    const reasons = await reasonsFor(entry);
    expect(reasons).toContain(KEEPER_REASONS.claimedHash);
    expect(reasons).toContain(REASONS.hashMismatch);
    expect(reasons).toContain(REASONS.writerRecipient);
  });

  it("rejects inflated payment legs even when the keeper names the authorised hash", async () => {
    const tampered = goodParameters();
    tampered.consideration[0]!.startAmount = "760000000";
    tampered.consideration[0]!.endAmount = "760000000";
    tampered.consideration[1]!.startAmount = "40000000";
    tampered.consideration[1]!.endAmount = "40000000";
    const entry = { ...keeperEntry(tampered), orderHash: hashOf(goodParameters(), COUNTER) };
    const reasons = await reasonsFor(entry);
    expect(reasons).toContain(REASONS.hashMismatch);
    expect(reasons).toContain(REASONS.grossMismatch);
  });

  it("rejects a skimmed fee leg, a third leg, and a mismatched item count", async () => {
    const skim = goodParameters();
    skim.consideration[1]!.recipient = STRANGER;
    expect(await reasonsFor(keeperEntry(skim))).toContain(REASONS.feeRecipient);

    const extra = goodParameters();
    extra.consideration.push({ ...extra.consideration[1]!, recipient: STRANGER });
    extra.totalOriginalConsiderationItems = "3";
    expect(await reasonsFor(keeperEntry(extra))).toContain(REASONS.considerationShape);

    const miscount = goodParameters();
    miscount.totalOriginalConsiderationItems = "1";
    expect(await reasonsFor(keeperEntry(miscount))).toEqual([KEEPER_REASONS.itemCount]);
  });

  it("rejects a cancelled or sold-out order", async () => {
    expect(
      await reasonsFor(keeperEntry(), fakeChain({ status: { isCancelled: true, totalFilled: 0n, totalSize: 0n } }).reader),
    ).toEqual([KEEPER_REASONS.cancelled]);
    expect(
      await reasonsFor(keeperEntry(), fakeChain({ status: { isCancelled: false, totalFilled: 20n, totalSize: 20n } }).reader),
    ).toEqual([KEEPER_REASONS.soldOut]);
  });

  it("rejects malformed entries without a chain read, and keeps only a well-formed hash", async () => {
    const { reader, calls } = fakeChain();
    const noParams = { ...keeperEntry(), parameters: undefined };
    const badAmount = keeperEntry();
    badAmount.parameters.offer[0]!.startAmount = "20.5";
    const badSignature = { ...keeperEntry(), signature: "0x1234" };
    const { orders, rejected } = await verifyKeeperOrders(
      [noParams, badAmount, badSignature, "not an order", { orderHash: "0xnothex" }],
      reader,
      CONFIG,
      NOW,
    );
    expect(orders).toEqual([]);
    expect(rejected.map((r) => r.reasons)).toEqual(Array(5).fill([KEEPER_REASONS.malformed]));
    expect(rejected[3]!.orderHash).toBeNull();
    expect(rejected[4]!.orderHash).toBeNull();
    expect(calls.getCounter).toEqual([]);
  });

  it("does not check more orders than a vault can have live", async () => {
    const { reader, calls } = fakeChain();
    const entries = Array.from({ length: KEEPER_MAX_ORDERS + 3 }, () => keeperEntry());
    const { orders, rejected } = await verifyKeeperOrders(entries, reader, CONFIG, NOW);
    expect(orders).toHaveLength(KEEPER_MAX_ORDERS);
    expect(rejected).toHaveLength(3);
    expect(rejected.every((r) => r.reasons[0] === KEEPER_REASONS.tooMany)).toBe(true);
    expect(calls.getCounter).toHaveLength(KEEPER_MAX_ORDERS);
  });

  it("rejects one order whose chain reads fail, and throws when the vault cannot be read", async () => {
    const stranger = goodParameters();
    stranger.offerer = STRANGER;
    const { reader } = fakeChain({ failCounterFor: STRANGER });
    const { orders, rejected } = await verifyKeeperOrders([keeperEntry(), keeperEntry(stranger, 0n)], reader, CONFIG, NOW);
    expect(orders).toHaveLength(1);
    expect(rejected).toEqual([{ orderHash: hashOf(stranger, 0n), reasons: [KEEPER_REASONS.unreadable] }]);

    await expect(verifyKeeperOrders([keeperEntry()], fakeChain({ failVault: true }).reader, CONFIG, NOW)).rejects.toThrow();
  });

  it("treats address case as meaning nothing, and ignores a counter the keeper sends", async () => {
    const lower = goodParameters();
    lower.offerer = VAULT_T.toLowerCase() as Address;
    lower.consideration[0]!.recipient = VAULT_T.toUpperCase().replace("0X", "0x") as Address;
    const entry = { ...keeperEntry(lower), parameters: { ...lower, counter: "999" } };
    expect(isKeeperOrder(entry)).toBe(true);
    const { orders, rejected } = await verifyKeeperOrders([entry], fakeChain().reader, CONFIG, NOW);
    expect(rejected).toEqual([]);
    expect(orders[0]!.components.counter).toBe("7");
  });
});

/*//////////////////////////////////////////////////////////////
                    fetchKeeperOrders, over real HTTP
//////////////////////////////////////////////////////////////*/

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
let base = "";
let handler: Handler = (_req, res) => res.end();
const hits: string[] = [];
const openSockets = new Set<import("node:net").Socket>();

// A fresh server, on a fresh port, per test. The client's connection pool is keyed by origin, so a
// socket a previous test hung or destroyed can never be handed to the next test's request.
beforeEach(async () => {
  hits.length = 0;
  handler = (_req, res) => res.end();
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    res.setHeader("connection", "close");
    handler(req, res);
  });
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  // Hung responses from the timeout tests must not keep the server open.
  for (const socket of openSockets) socket.destroy();
  await new Promise<void>((done) => server.close(() => done()));
});

describe("fetchKeeperOrders", () => {
  it("returns the orders array", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ orders: [keeperEntry()] }));
    };
    const result = await fetchKeeperOrders(`${base}/orders`);
    expect(result.ok).toBe(true);
    expect(result.ok && result.orders).toHaveLength(1);
  });

  it("refuses a body declared larger than the cap", async () => {
    handler = (_req, res) => {
      const body = JSON.stringify({ orders: [], pad: "x".repeat(4096) });
      res.writeHead(200, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
      res.end(body);
    };
    expect(await fetchKeeperOrders(`${base}/orders`, { maxBytes: 1024 })).toEqual({
      ok: false,
      error: "The keeper's answer was larger than a book of live orders can be.",
    });
  });

  it("stops reading an undeclared, streaming body at the cap", async () => {
    let written = 0;
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"orders":[],"pad":"');
      const timer = setInterval(() => {
        if (res.destroyed || written > 10 * 1024 * 1024) {
          clearInterval(timer);
          res.destroy();
          return;
        }
        res.write("x".repeat(16 * 1024));
        written += 16 * 1024;
      }, 1);
    };
    const result = await fetchKeeperOrders(`${base}/orders`, { maxBytes: 64 * 1024 });
    expect(result).toEqual({ ok: false, error: "The keeper's answer was larger than a book of live orders can be." });
    expect(written).toBeLessThan(10 * 1024 * 1024);
  });

  it("times out when the keeper never answers", async () => {
    handler = () => {
      /* never respond */
    };
    const t0 = Date.now();
    expect(await fetchKeeperOrders(`${base}/orders`, { timeoutMs: 200 })).toEqual({
      ok: false,
      error: "The keeper did not answer within 0.2 seconds.",
    });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("times out when the keeper sends headers and then stalls the body", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"orders":[');
    };
    expect(await fetchKeeperOrders(`${base}/orders`, { timeoutMs: 200 })).toEqual({
      ok: false,
      error: "The keeper did not answer within 0.2 seconds.",
    });
  });

  it("does not follow a redirect, to another host or anywhere", async () => {
    handler = (req, res) => {
      if (req.url === "/orders") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ orders: [keeperEntry()] }));
    };
    expect(await fetchKeeperOrders(`${base}/orders`)).toEqual({
      ok: false,
      error: "The keeper answered with a redirect, which is not followed.",
    });
    expect(hits).toEqual(["/orders"]);
  });

  it("reports a non-2xx, a non-JSON body and a body without orders in its own words", async () => {
    handler = (_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("stack trace with secrets");
    };
    expect(await fetchKeeperOrders(`${base}/orders`)).toEqual({ ok: false, error: "The keeper answered HTTP 500." });

    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>");
    };
    expect(await fetchKeeperOrders(`${base}/orders`)).toEqual({ ok: false, error: "The keeper's answer was not JSON." });

    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ listings: [] }));
    };
    expect(await fetchKeeperOrders(`${base}/orders`)).toEqual({
      ok: false,
      error: "The keeper's answer did not contain an orders array.",
    });
  });

  it("reports an unreachable keeper", async () => {
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((done) => closed.close(() => done()));
    expect(await fetchKeeperOrders(`http://127.0.0.1:${port}/orders`)).toEqual({
      ok: false,
      error: "The keeper could not be reached.",
    });
  });
});

/*//////////////////////////////////////////////////////////////
                    configuration and the route
//////////////////////////////////////////////////////////////*/

describe("parseKeeperOrdersUrl", () => {
  it("parses the private Railway address and refuses what is not an http(s) URL", () => {
    expect(parseKeeperOrdersUrl(undefined)).toEqual({ kind: "unset" });
    expect(parseKeeperOrdersUrl("   ")).toEqual({ kind: "unset" });
    expect(parseKeeperOrdersUrl("http://keeper.railway.internal:8787/orders")).toEqual({
      kind: "ok",
      url: "http://keeper.railway.internal:8787/orders",
    });
    expect(parseKeeperOrdersUrl("keeper:8787").kind).toBe("invalid");
    expect(parseKeeperOrdersUrl("file:///etc/passwd").kind).toBe("invalid");
    const withSecret = parseKeeperOrdersUrl("https://user:s3cret@keeper.example/orders");
    expect(withSecret.kind).toBe("invalid");
    expect(JSON.stringify(withSecret)).not.toContain("s3cret");
  });
});

describe("serveKeeperOrders", () => {
  const good = fakeChain().reader;

  it("answers 503, not configured, when KEEPER_ORDERS_URL is unset, without touching the chain", async () => {
    const { reader, calls } = fakeChain();
    const out = await serveKeeperOrders({ keeperOrdersUrl: undefined, config: CONFIG, chain: reader, nowSeconds: NOW });
    expect(out).toEqual({ status: 503, body: { configured: false, orders: [], rejected: [], error: NOT_CONFIGURED } });
    expect(calls.vaultListing).toBe(0);
  });

  it("answers 503 for a misconfigured URL without echoing it, and logs the problem", async () => {
    const logged: Array<Record<string, unknown>> = [];
    const out = await serveKeeperOrders({
      keeperOrdersUrl: "https://user:s3cret@keeper.example/orders",
      config: CONFIG,
      chain: good,
      nowSeconds: NOW,
      log: (e) => logged.push(e),
    });
    expect(out.status).toBe(503);
    expect(out.body.configured).toBe(true);
    expect(JSON.stringify(out)).not.toContain("s3cret");
    expect(JSON.stringify(logged)).not.toContain("s3cret");
  });

  it("answers 502 for an oversized or timed-out keeper", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ orders: [], pad: "x".repeat(8192) }));
    };
    const big = await serveKeeperOrders({
      keeperOrdersUrl: `${base}/orders`,
      config: CONFIG,
      chain: good,
      nowSeconds: NOW,
      maxBytes: 1024,
      log: () => {},
    });
    expect(big).toEqual({
      status: 502,
      body: {
        configured: true,
        orders: [],
        rejected: [],
        error: "The keeper's answer was larger than a book of live orders can be.",
      },
    });

    handler = () => {};
    const slow = await serveKeeperOrders({
      keeperOrdersUrl: `${base}/orders`,
      config: CONFIG,
      chain: good,
      nowSeconds: NOW,
      timeoutMs: 200,
      log: () => {},
    });
    expect(slow.status).toBe(502);
    expect(slow.body.error).toBe("The keeper did not answer within 0.2 seconds.");
  });

  it("answers 502 when the vault cannot be read", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ orders: [keeperEntry()] }));
    };
    const out = await serveKeeperOrders({
      keeperOrdersUrl: `${base}/orders`,
      config: CONFIG,
      chain: fakeChain({ failVault: true }).reader,
      nowSeconds: NOW,
      log: () => {},
    });
    expect(out.status).toBe(502);
    expect(out.body.orders).toEqual([]);
  });

  it("serves the verified order and reports, and logs, the tampered one", async () => {
    const tampered = goodParameters();
    tampered.consideration[0]!.recipient = STRANGER;
    const bad = { ...keeperEntry(tampered), orderHash: hashOf(goodParameters(), COUNTER) };
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ orders: [keeperEntry(), bad] }));
    };
    const logged: Array<Record<string, unknown>> = [];
    const out = await serveKeeperOrders({
      keeperOrdersUrl: `${base}/orders`,
      config: CONFIG,
      chain: good,
      nowSeconds: NOW,
      log: (e) => logged.push(e),
    });
    expect(out.status).toBe(200);
    expect(out.body.orders.map((o) => o.orderHash)).toEqual([hashOf(goodParameters(), COUNTER).toLowerCase()]);
    expect(out.body.rejected).toHaveLength(1);
    expect(out.body.rejected[0]!.reasons).toContain(REASONS.writerRecipient);
    expect(logged).toEqual([
      expect.objectContaining({ msg: "keeper order rejected", orderHash: bad.orderHash, reasons: out.body.rejected[0]!.reasons }),
    ]);
  });
});

describe("GET /api/keeper/orders", () => {
  it("answers 503 with a clear body when KEEPER_ORDERS_URL is not set", async () => {
    const before = process.env.KEEPER_ORDERS_URL;
    delete process.env.KEEPER_ORDERS_URL;
    try {
      const { GET } = await import("../app/api/keeper/orders/route");
      const res = await GET();
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ configured: false, orders: [], rejected: [], error: NOT_CONFIGURED });
    } finally {
      if (before !== undefined) process.env.KEEPER_ORDERS_URL = before;
    }
  });
});
