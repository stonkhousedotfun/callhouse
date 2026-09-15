import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { getAddress, type Address, type Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchKeeperOrderBook } from "./api";
import { CLEARINGHOUSE, SEAPORT, USDG } from "./contracts";
import {
  EMPTY_SIGNATURE,
  KEEPER_MAX_ORDERS,
  KEEPER_PRICING_MAX_KEYS,
  displayPricing,
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
  CHAIN_DEADLINE_MS,
  KEEPER_TIMEOUT_MS,
  VAULT_UNREADABLE,
  chainTimedOut,
  shareWhileRunning,
  type KeeperChainReader,
  type KeeperCheckConfig,
  type KeeperOrderJson,
  type OrderComponentsStruct,
  type VaultListingSlot,
} from "./keeperOrders";
import { REASONS, checkListingIsOurs } from "./listing";
import type { SeaportFillStatus } from "./seaportOrder";

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
 * The order is the lib/listing.test.ts reference listing: the vault (offerer and zone) offers 20
 * contracts of this cycle's option id for ONE leg of 80.000000 USDG to itself, PARTIAL_RESTRICTED,
 * empty signature. Seaport's counter for the vault is 7, not 0, so a check that skipped the
 * restore would hash the wrong order.
 */
const VAULT_T = getAddress("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
const STRANGER = getAddress("0x2222222222222222222222222222222222222222");
const OPTION_ID = "56885395977254369119998982131173877604217583767740146085872832926902011297792";
const SALT = "95941992777576660739888578361827826050802484697670100586800480598437555708740";
const ZERO32 = `0x${"0".repeat(64)}` as Hex;
/** What an older keeper served: 65 bytes of nothing. Accepted, and never carried. */
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
    zone: VAULT_T,
    offer: [{ itemType: 3, token: CLEARINGHOUSE, identifierOrCriteria: OPTION_ID, startAmount: "20", endAmount: "20" }],
    consideration: [
      { itemType: 1, token: USDG, identifierOrCriteria: "0", startAmount: "80000000", endAmount: "80000000", recipient: VAULT_T },
    ],
    orderType: 3,
    startTime: "0",
    endTime: END,
    zoneHash: ZERO32,
    salt: SALT,
    conduitKey: ZERO32,
    totalOriginalConsiderationItems: "1",
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
    status: "live",
    parameters,
    signature: "0x",
  };
}

const AUTHORISED = hashOf(goodParameters(), COUNTER);

/** An entry that names the vault's authorised hash whatever its parameters hash to: the shape a
 *  tampered or buggy keeper serves. */
function claimingAuthorised(parameters: Parameters) {
  return { ...keeperEntry(parameters), orderHash: AUTHORISED };
}

type ReadStateQuery = { offerers: readonly Address[]; orderHashes: readonly Hex[] };

function fakeChain(overrides: {
  slot?: Partial<VaultListingSlot>;
  counters?: Record<string, bigint>;
  status?: SeaportFillStatus;
  failCounterFor?: Address;
  failStatus?: boolean;
  failVault?: boolean;
  failOrderHash?: boolean;
  /** Seaport's getOrderHash answers something other than the EIP-712 derivation. */
  skewOrderHash?: boolean;
  /** readState never answers. */
  hang?: boolean;
} = {}) {
  const calls = { readState: [] as ReadStateQuery[], getOrderHashes: [] as OrderComponentsStruct[][] };
  const reader: KeeperChainReader = {
    async readState(query) {
      calls.readState.push({ offerers: [...query.offerers], orderHashes: [...query.orderHashes] });
      if (overrides.hang) await new Promise(() => {});
      if (overrides.failVault) throw new Error("rpc down");
      const counters = overrides.counters ?? { [VAULT_T]: COUNTER };
      return {
        vault: {
          phase: 1,
          listingHash: AUTHORISED,
          listingAmount: 20n,
          listingGrossUsdg: 80_000_000n,
          optionId: BigInt(OPTION_ID),
          conduitKey: ZERO32,
          ...overrides.slot,
        },
        counters: query.offerers.map((o) => (o === overrides.failCounterFor ? undefined : (counters[o] ?? 0n))),
        statuses: query.orderHashes.map(() =>
          overrides.failStatus ? undefined : (overrides.status ?? { isCancelled: false, totalFilled: 0n, totalSize: 0n }),
        ),
      };
    },
    async getOrderHashes(components) {
      calls.getOrderHashes.push([...components]);
      if (overrides.failOrderHash) throw new Error("rpc down");
      return components.map((c) => (overrides.skewOrderHash ? (ZERO32.replace(/0$/, "1") as Hex) : seaportOrderHash(c)));
    },
  };
  return { reader, calls };
}

async function verifyOne(entry: unknown, chain = fakeChain().reader, now = NOW) {
  return verifyKeeperOrders([entry], chain, CONFIG, now);
}

async function reasonsFor(entry: unknown, chain = fakeChain().reader, now = NOW): Promise<string[]> {
  const { orders, rejected, closed, unchecked } = await verifyOne(entry, chain, now);
  expect(orders).toEqual([]);
  expect(closed).toEqual([]);
  expect(unchecked).toEqual([]);
  expect(rejected).toHaveLength(1);
  return rejected[0]!.reasons;
}

async function stateOf(entry: unknown, chain = fakeChain().reader, now = NOW) {
  const { orders, rejected, closed, unchecked } = await verifyOne(entry, chain, now);
  expect(orders).toEqual([]);
  expect(rejected).toEqual([]);
  expect(unchecked).toEqual([]);
  expect(closed).toHaveLength(1);
  return closed[0]!;
}

/*//////////////////////////////////////////////////////////////
                         verifyKeeperOrders
//////////////////////////////////////////////////////////////*/

describe("verifyKeeperOrders", () => {
  it("accepts the vault's order, restoring Seaport's counter from the chain", async () => {
    const { reader, calls } = fakeChain();
    const { orders, rejected, closed, unchecked } = await verifyKeeperOrders([keeperEntry()], reader, CONFIG, NOW);
    expect(rejected).toEqual([]);
    expect(closed).toEqual([]);
    expect(unchecked).toEqual([]);
    expect(orders).toHaveLength(1);
    const row = orders[0]!;

    // The counter came from Seaport for the offerer, and it is what was hashed.
    expect(calls.readState).toEqual([{ offerers: [VAULT_T], orderHashes: [AUTHORISED] }]);
    expect(calls.getOrderHashes.map((batch) => batch.map((c) => c.counter))).toEqual([[COUNTER]]);
    expect(row.components.counter).toBe("7");
    expect(row.counter).toBe("7");
    // Without the restore the hash is a different order: the check would be looking at nothing.
    expect(hashOf(goodParameters(), 0n)).not.toBe(AUTHORISED);
    expect(row.orderHash).toBe(AUTHORISED);

    // The row is one the page's own check accepts, with figures from the components.
    const slot = (await reader.readState({ offerers: [], orderHashes: [] })).vault;
    const pageCheck = checkListingIsOurs(
      row,
      {
        ...CONFIG,
        listingHash: slot.listingHash,
        amount: slot.listingAmount,
        grossUsdg: slot.listingGrossUsdg,
        optionId: slot.optionId,
        conduitKey: slot.conduitKey,
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
      signature: EMPTY_SIGNATURE,
    });
    expect(row.components.orderType).toBe(3);
    expect(row.components.zone).toBe(VAULT_T);
    expect(row.components.consideration).toHaveLength(1);

    // Nothing else the keeper said is passed on, except its display-only pricing report, which is
    // null here (none served) and gated by displayPricing when present.
    expect(Object.keys(row).sort()).toEqual(
      [
        "chainId",
        "components",
        "counter",
        "endTime",
        "offerer",
        "optionId",
        "orderHash",
        "pricing",
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
    expect(row.pricing).toBeNull();
    expect(JSON.stringify(row)).not.toContain("grossUsdg6");
    expect(JSON.stringify(row)).not.toContain("totalOriginalConsiderationItems");
  });

  it("never carries the keeper's signature bytes: the row's signature is empty, whatever was served", async () => {
    // An older keeper served a 65-byte placeholder. It is accepted (well-formed) and dropped: the
    // vault validated the order on chain and Seaport skips verification, so `0x` is the only
    // honest value, and the fill sends `0x` regardless.
    const legacy = { ...keeperEntry(), signature: PLACEHOLDER_SIGNATURE };
    expect(isKeeperOrder(legacy)).toBe(true);
    const { orders } = await verifyKeeperOrders([legacy], fakeChain().reader, CONFIG, NOW);
    expect(orders[0]!.signature).toBe("0x");
    // A keeper that sends no signature field at all is fine too.
    const { signature: _dropped, ...withoutSignature } = keeperEntry();
    expect(isKeeperOrder(withoutSignature)).toBe(true);
    const { orders: also } = await verifyKeeperOrders([withoutSignature], fakeChain().reader, CONFIG, NOW);
    expect(also[0]!.signature).toBe("0x");
  });

  it("reads remaining contracts from Seaport's fill fraction, not from the keeper", async () => {
    // Seaport stores the fraction reduced: 5 of 20 is 1/4.
    const { reader } = fakeChain({ status: { isCancelled: false, totalFilled: 1n, totalSize: 4n } });
    const { orders } = await verifyKeeperOrders([keeperEntry()], reader, CONFIG, NOW);
    expect(orders[0]).toMatchObject({ remaining: "15", status: "partial", quantity: "20" });
  });

  it("reads every stateful fact in one readState call, so from one block", async () => {
    const stranger = goodParameters();
    stranger.offerer = STRANGER;
    const older = goodParameters();
    older.salt = "1";
    const { reader, calls } = fakeChain();
    await verifyKeeperOrders([keeperEntry(), keeperEntry(stranger, 0n), keeperEntry(older)], reader, CONFIG, NOW);
    expect(calls.readState).toHaveLength(1);
    expect(calls.readState[0]!.offerers).toEqual([VAULT_T, STRANGER]);
    expect(calls.readState[0]!.orderHashes).toHaveLength(3);
    // Only the order that names the authorised hash is hashed by Seaport.
    expect(calls.getOrderHashes).toHaveLength(1);
    expect(calls.getOrderHashes[0]).toHaveLength(1);
  });

  it("reports an order that is not the vault's current listing as closed, not as tampering", async () => {
    // A well-formed, correctly hashed order of the vault's, but not the one it authorised.
    const other = goodParameters();
    other.salt = "1";
    const { reader, calls } = fakeChain();
    expect(await stateOf(keeperEntry(other), reader)).toEqual({ orderHash: hashOf(other, COUNTER), state: "notCurrent" });
    expect(calls.getOrderHashes).toEqual([]);
  });

  it("does not raise a tamper alarm for a listing superseded by a counter bump", async () => {
    // invalidateAllListings() (or the keeper's own recovery) bumped Seaport's counter from 6 to 7
    // without cancelling H1, so the keeper still serves H1 until its end time. The vault then
    // authorised H2. H1 must not be reported with the claimed-hash reason that marks tampering.
    const h1Parameters = goodParameters();
    h1Parameters.salt = "42";
    const h1 = keeperEntry(h1Parameters, 6n);
    const logged: Array<Record<string, unknown>> = [];
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ orders: [h1, keeperEntry()] }));
    };
    const out = await serveKeeperOrders({
      keeperOrdersUrl: `${base}/orders`,
      config: CONFIG,
      chain: fakeChain().reader,
      nowSeconds: NOW,
      log: (e) => logged.push(e),
    });
    expect(out.status).toBe(200);
    expect(out.body.orders.map((o) => o.orderHash)).toEqual([AUTHORISED]);
    expect(out.body.rejected).toEqual([]);
    expect(out.body.closed).toEqual([{ orderHash: h1.orderHash, state: "notCurrent" }]);
    expect(JSON.stringify(out.body)).not.toContain(KEEPER_REASONS.claimedHash);
    expect(logged.filter((e) => e.level === "warn" || e.level === "error")).toEqual([]);
  });

  it("reports every order as not current when the vault has nothing authorised", async () => {
    const state = await stateOf(keeperEntry(), fakeChain({ slot: { listingHash: ZERO32 } }).reader);
    expect(state.state).toBe("notCurrent");
  });

  it("rejects parameters that do not hash to the authorised hash the keeper names", async () => {
    const other = goodParameters();
    other.salt = "1";
    expect(await reasonsFor(claimingAuthorised(other))).toEqual([
      KEEPER_REASONS.claimedHash,
      REASONS.hashMismatch,
    ]);
  });

  it("rejects the wrong offerer", async () => {
    const stranger = goodParameters();
    stranger.offerer = STRANGER;
    // Even if the vault's slot somehow carried that order's hash, the seller is still wrong.
    const hash = hashOf(stranger, 0n);
    const { reader, calls } = fakeChain({ slot: { listingHash: hash } });
    const reasons = await reasonsFor(keeperEntry(stranger, 0n), reader);
    expect(calls.readState[0]!.offerers).toEqual([STRANGER]);
    expect(reasons).toContain(REASONS.seller);
  });

  it("rejects a zone that is not the vault and an order type that is not PARTIAL_RESTRICTED", async () => {
    // The pre-redesign shape: zero zone, PARTIAL_OPEN. Under write on fill nothing would be written.
    const open = goodParameters();
    open.zone = "0x0000000000000000000000000000000000000000";
    open.orderType = 1;
    const reasons = await reasonsFor(claimingAuthorised(open));
    expect(reasons).toContain(REASONS.zone);
    expect(reasons).toContain(REASONS.orderType);
  });

  it("rejects a conduit key that is not the vault's, and accepts the vault's own", async () => {
    const withConduit = goodParameters();
    withConduit.conduitKey = `0x${"ab".repeat(32)}`;
    expect(await reasonsFor(claimingAuthorised(withConduit))).toContain(REASONS.conduit);
    // A vault deployed with a conduit key: the slot carries it, the order must too.
    const hash = hashOf(withConduit, COUNTER);
    const { orders } = await verifyKeeperOrders(
      [keeperEntry(withConduit)],
      fakeChain({ slot: { listingHash: hash, conduitKey: `0x${"ab".repeat(32)}` } }).reader,
      CONFIG,
      NOW,
    );
    expect(orders).toHaveLength(1);
  });

  it("checks the offer token against the clearinghouse the VAULT names, not the build's constant", async () => {
    // A vault deployed on its own Clear (contracts/script/DeployClear.s.sol): the slot's `clear`
    // is that address, the keeper's offer item names it, and a build whose compiled
    // NEXT_PUBLIC_CLEARINGHOUSE still points at the upstream instance must not reject the
    // vault's real listing. Without the slot's `clear` the constant is the fallback.
    const ownClear = "0x3333333333333333333333333333333333333333" as Address;
    const onOwnClear = goodParameters();
    onOwnClear.offer[0]!.token = ownClear;
    const hash = hashOf(onOwnClear, COUNTER);
    const { orders, rejected } = await verifyKeeperOrders(
      [keeperEntry(onOwnClear)],
      fakeChain({ slot: { listingHash: hash, clear: ownClear } }).reader,
      CONFIG,
      NOW,
    );
    expect(rejected).toEqual([]);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.components.offer[0]!.token).toBe(ownClear);
    // And the converse: the slot names the upstream Clear, so an offer of some other ERC-1155
    // is refused even when the build's constant would have accepted it.
    const { rejected: refused } = await verifyKeeperOrders(
      [keeperEntry(onOwnClear)],
      fakeChain({ slot: { listingHash: hash, clear: CLEARINGHOUSE } }).reader,
      CONFIG,
      NOW,
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reasons).toContain(REASONS.offerToken);
    // No `clear` in the slot: the build's constant stands in, and the fixture's offer is on it.
    const { orders: byConstant } = await verifyKeeperOrders([keeperEntry()], fakeChain().reader, CONFIG, NOW);
    expect(byConstant).toHaveLength(1);
  });

  it("reports an expired order as closed", async () => {
    const expired = goodParameters();
    expired.endTime = String(NOW);
    const hash = hashOf(expired, COUNTER);
    expect(await stateOf(keeperEntry(expired), fakeChain({ slot: { listingHash: hash } }).reader)).toEqual({
      orderHash: hash,
      state: "expired",
    });
  });

  it.each([
    [0, "Idle"],
    [2, "Exercisable"],
    [3, "Settling"],
  ])("reports the order as closed when the vault's phase is %i (%s), not Listed", async (phase) => {
    expect((await stateOf(keeperEntry(), fakeChain({ slot: { phase } }).reader)).state).toBe("notListed");
  });

  it("rejects a swapped payment recipient even when the keeper names the authorised hash", async () => {
    const tampered = goodParameters();
    tampered.consideration[0]!.recipient = STRANGER;
    const reasons = await reasonsFor(claimingAuthorised(tampered));
    expect(reasons).toContain(KEEPER_REASONS.claimedHash);
    expect(reasons).toContain(REASONS.hashMismatch);
    expect(reasons).toContain(REASONS.writerRecipient);
  });

  it("rejects an inflated payment leg even when the keeper names the authorised hash", async () => {
    const tampered = goodParameters();
    tampered.consideration[0]!.startAmount = "800000000";
    tampered.consideration[0]!.endAmount = "800000000";
    const reasons = await reasonsFor(claimingAuthorised(tampered));
    expect(reasons).toContain(REASONS.hashMismatch);
    expect(reasons).toContain(REASONS.grossMismatch);
  });

  it("rejects a second payment leg and a mismatched item count", async () => {
    const extra = goodParameters();
    extra.consideration.push({ ...extra.consideration[0]!, startAmount: "4000000", endAmount: "4000000", recipient: STRANGER });
    extra.totalOriginalConsiderationItems = "2";
    expect(await reasonsFor(claimingAuthorised(extra))).toContain(REASONS.considerationShape);

    const miscount = goodParameters();
    miscount.totalOriginalConsiderationItems = "2";
    expect(await reasonsFor(keeperEntry(miscount))).toEqual([KEEPER_REASONS.itemCount]);
  });

  it("reports a cancelled or sold-out order as closed, never as rejected", async () => {
    expect(
      await stateOf(keeperEntry(), fakeChain({ status: { isCancelled: true, totalFilled: 0n, totalSize: 0n } }).reader),
    ).toEqual({ orderHash: AUTHORISED, state: "cancelled" });
    // Seaport's fraction reduced: 23 of 23 is 1/1.
    expect(
      await stateOf(keeperEntry(), fakeChain({ status: { isCancelled: false, totalFilled: 1n, totalSize: 1n } }).reader),
    ).toEqual({ orderHash: AUTHORISED, state: "soldOut" });
  });

  it("still rejects a tampered order that is also sold out: integrity outranks lifecycle", async () => {
    const tampered = goodParameters();
    tampered.consideration[0]!.recipient = STRANGER;
    const chain = fakeChain({ status: { isCancelled: false, totalFilled: 20n, totalSize: 20n } }).reader;
    expect(await reasonsFor(claimingAuthorised(tampered), chain)).toContain(REASONS.writerRecipient);
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
    expect(calls.readState).toEqual([]);
  });

  it("refuses more orders than a vault can have live as one item, checking none", async () => {
    const { reader, calls } = fakeChain();
    const entries = Array.from({ length: 32_762 }, () => 0);
    const { orders, rejected, closed, unchecked } = await verifyKeeperOrders(entries, reader, CONFIG, NOW);
    expect(orders).toEqual([]);
    expect(closed).toEqual([]);
    expect(unchecked).toEqual([]);
    expect(rejected).toEqual([{ orderHash: null, reasons: [`${KEEPER_REASONS.tooMany} (32762 served)`] }]);
    expect(calls.readState).toEqual([]);

    const atCap = await verifyKeeperOrders(Array.from({ length: KEEPER_MAX_ORDERS }, () => keeperEntry()), reader, CONFIG, NOW);
    expect(atCap.orders).toHaveLength(KEEPER_MAX_ORDERS);
  });

  it("puts an order whose chain reads fail under unchecked, and throws when the vault cannot be read", async () => {
    const stranger = goodParameters();
    stranger.offerer = STRANGER;
    const strangerHash = hashOf(stranger, 0n);
    // Both claim the authorised hash, so both are checked; only the stranger's counter read fails.
    const { reader } = fakeChain({ failCounterFor: STRANGER });
    const out = await verifyKeeperOrders([keeperEntry(), { ...keeperEntry(stranger, 0n), orderHash: AUTHORISED }], reader, CONFIG, NOW);
    expect(out.orders).toHaveLength(1);
    expect(out.rejected).toEqual([]);
    expect(out.unchecked).toEqual([{ orderHash: AUTHORISED, reasons: [KEEPER_REASONS.unreadable] }]);
    expect(strangerHash).not.toBe(AUTHORISED);

    expect((await verifyOne(keeperEntry(), fakeChain({ failStatus: true }).reader)).unchecked).toEqual([
      { orderHash: AUTHORISED, reasons: [KEEPER_REASONS.unreadable] },
    ]);
    expect((await verifyOne(keeperEntry(), fakeChain({ failOrderHash: true }).reader)).unchecked).toEqual([
      { orderHash: AUTHORISED, reasons: [KEEPER_REASONS.unreadable] },
    ]);
    await expect(verifyKeeperOrders([keeperEntry()], fakeChain({ failVault: true }).reader, CONFIG, NOW)).rejects.toThrow();
  });

  it("does not offer an order when Seaport's hash and the local derivation disagree", async () => {
    const out = await verifyOne(keeperEntry(), fakeChain({ skewOrderHash: true }).reader);
    expect(out.orders).toEqual([]);
    expect(out.rejected).toEqual([]);
    expect(out.unchecked).toEqual([{ orderHash: AUTHORISED, reasons: [KEEPER_REASONS.hashDerivation] }]);
  });

  it("treats address case as meaning nothing, and ignores a counter the keeper sends", async () => {
    const lower = goodParameters();
    lower.offerer = VAULT_T.toLowerCase() as Address;
    lower.zone = VAULT_T.toLowerCase() as Address;
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

const EMPTY = { configured: true, orders: [], rejected: [], closed: [], unchecked: [] };

function serveBody(body: string) {
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  };
}

describe("serveKeeperOrders", () => {
  const good = fakeChain().reader;

  it("answers 503, not configured, when KEEPER_ORDERS_URL is unset, without touching the chain", async () => {
    const { reader, calls } = fakeChain();
    const out = await serveKeeperOrders({ keeperOrdersUrl: undefined, config: CONFIG, chain: reader, nowSeconds: NOW });
    expect(out).toEqual({ status: 503, body: { ...EMPTY, configured: false, error: NOT_CONFIGURED } });
    expect(calls.readState).toEqual([]);
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
      body: { ...EMPTY, error: "The keeper's answer was larger than a book of live orders can be." },
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
    expect(out).toEqual({ status: 502, body: { ...EMPTY, error: VAULT_UNREADABLE } });
  });

  it("answers 502 in its own words when the chain reads pass their deadline", async () => {
    serveBody(JSON.stringify({ orders: [keeperEntry()] }));
    const logged: Array<Record<string, unknown>> = [];
    const t0 = Date.now();
    const out = await serveKeeperOrders({
      keeperOrdersUrl: `${base}/orders`,
      config: CONFIG,
      chain: fakeChain({ hang: true }).reader,
      nowSeconds: NOW,
      chainDeadlineMs: 200,
      log: (e) => logged.push(e),
    });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(out).toEqual({ status: 502, body: { ...EMPTY, error: chainTimedOut(200) } });
    expect(out.body.error).toBe("The chain did not answer within 0.2 seconds, so the keeper's orders cannot be checked yet.");
    expect(logged).toEqual([expect.objectContaining({ level: "warn", msg: "keeper orders could not be checked: chain reads timed out" })]);
    // The default deadline plus the keeper's timeout stays under the browser's fifteen seconds.
    expect(CHAIN_DEADLINE_MS + KEEPER_TIMEOUT_MS).toBeLessThan(15_000);
  });

  it("refuses a 64 KiB flood of entries in one small answer and one log line", async () => {
    // Exactly the cap: {"orders":[0,0,...]} is 32,762 entries in 65,536 bytes.
    const flood = `{"orders":[${Array.from({ length: 32_762 }, () => "0").join(",")}]}`;
    const padded = flood + " ".repeat(65_536 - flood.length);
    expect(Buffer.byteLength(padded)).toBe(65_536);
    serveBody(padded);
    const logged: Array<Record<string, unknown>> = [];
    const { reader, calls } = fakeChain();
    const out = await serveKeeperOrders({
      keeperOrdersUrl: `${base}/orders`,
      config: CONFIG,
      chain: reader,
      nowSeconds: NOW,
      log: (e) => logged.push(e),
    });
    expect(out).toEqual({ status: 502, body: { ...EMPTY, error: KEEPER_REASONS.tooMany } });
    expect(JSON.stringify(out.body).length).toBeLessThan(512);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: "warn", msg: "keeper served too many orders", count: 32_762 });
    expect(calls.readState).toEqual([]);
  });

  it("logs one line for many rejected orders, not one per order", async () => {
    const tampered = goodParameters();
    tampered.consideration[0]!.recipient = STRANGER;
    serveBody(JSON.stringify({ orders: Array.from({ length: KEEPER_MAX_ORDERS }, () => claimingAuthorised(tampered)) }));
    const logged: Array<Record<string, unknown>> = [];
    const out = await serveKeeperOrders({
      keeperOrdersUrl: `${base}/orders`,
      config: CONFIG,
      chain: good,
      nowSeconds: NOW,
      log: (e) => logged.push(e),
    });
    expect(out.body.rejected).toHaveLength(KEEPER_MAX_ORDERS);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: "warn", msg: "keeper orders rejected", count: KEEPER_MAX_ORDERS });
    expect(logged[0]!.orderHashes).toHaveLength(3);
  });

  it("reports a sold-out order as closed with no warning logged", async () => {
    serveBody(JSON.stringify({ orders: [keeperEntry()] }));
    const logged: Array<Record<string, unknown>> = [];
    const out = await serveKeeperOrders({
      keeperOrdersUrl: `${base}/orders`,
      config: CONFIG,
      chain: fakeChain({ status: { isCancelled: false, totalFilled: 20n, totalSize: 20n } }).reader,
      nowSeconds: NOW,
      log: (e) => logged.push(e),
    });
    expect(out).toEqual({ status: 200, body: { ...EMPTY, closed: [{ orderHash: AUTHORISED, state: "soldOut" }] } });
    expect(logged.filter((e) => e.level !== "debug")).toEqual([]);
  });

  it("puts an order the chain could not be read for under unchecked, not rejected", async () => {
    serveBody(JSON.stringify({ orders: [keeperEntry()] }));
    const out = await serveKeeperOrders({
      keeperOrdersUrl: `${base}/orders`,
      config: CONFIG,
      chain: fakeChain({ failStatus: true }).reader,
      nowSeconds: NOW,
      log: () => {},
    });
    expect(out).toEqual({
      status: 200,
      body: { ...EMPTY, unchecked: [{ orderHash: AUTHORISED, reasons: [KEEPER_REASONS.unreadable] }] },
    });
  });

  it("serves the verified order and reports, and logs, the tampered one", async () => {
    const tampered = goodParameters();
    tampered.consideration[0]!.recipient = STRANGER;
    const bad = claimingAuthorised(tampered);
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
      expect.objectContaining({
        level: "warn",
        msg: "keeper orders rejected",
        count: 1,
        orderHashes: [bad.orderHash],
        reasons: out.body.rejected[0]!.reasons,
      }),
    ]);
  });
});

describe("shareWhileRunning", () => {
  it("shares a computation until it settles and for the window after, not from its start", async () => {
    let clock = 0;
    const releases: Array<(value: number) => void> = [];
    let started = 0;
    const answer = shareWhileRunning(
      () => {
        started += 1;
        return new Promise<number>((resolve) => releases.push(resolve));
      },
      { shareMs: 2_000, now: () => clock },
    );

    const first = answer("a");
    clock = 40_000; // a hung RPC: forty seconds and still running
    expect(answer("a")).toBe(first);
    expect(started).toBe(1);

    releases[0]!(1);
    await first;
    clock = 41_000; // one second after it settled
    expect(answer("a")).toBe(first);
    expect(started).toBe(1);

    clock = 42_500; // past the window
    const second = answer("a");
    expect(second).not.toBe(first);
    expect(started).toBe(2);

    // A different key (a changed KEEPER_ORDERS_URL) never reuses an answer.
    expect(answer("b")).not.toBe(second);
    expect(started).toBe(3);
  });

  it("starts the window from a rejection too", async () => {
    let clock = 0;
    let started = 0;
    const answer = shareWhileRunning(
      () => {
        started += 1;
        return Promise.reject(new Error("boom"));
      },
      { shareMs: 2_000, now: () => clock },
    );
    const first = answer(undefined);
    await expect(first).rejects.toThrow();
    clock = 1_000;
    expect(answer(undefined)).toBe(first);
    await expect(answer(undefined)).rejects.toThrow();
    expect(started).toBe(1);
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
      expect(await res.json()).toEqual({ ...EMPTY, configured: false, error: NOT_CONFIGURED });
    } finally {
      if (before !== undefined) process.env.KEEPER_ORDERS_URL = before;
    }
  });
});

describe("fetchKeeperOrderBook (the browser's client)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps a timeout or a network failure to its own wording, never the browser's", async () => {
    for (const failure of [
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      new TypeError("Failed to fetch"),
    ]) {
      vi.stubGlobal("fetch", async () => {
        throw failure;
      });
      const book = await fetchKeeperOrderBook();
      expect(book).toEqual({
        configured: true,
        listings: [],
        rejected: [],
        closed: [],
        unchecked: [],
        error: "The order feed route did not answer.",
      });
      expect(JSON.stringify(book)).not.toMatch(/aborted|Failed to fetch/);
    }
  });

  it("reads the four outcomes and bounds each list", async () => {
    const many = Array.from({ length: 50 }, () => ({ orderHash: AUTHORISED, reasons: ["r"] }));
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            configured: true,
            orders: [],
            rejected: many,
            unchecked: many,
            closed: [
              ...Array.from({ length: 50 }, () => ({ orderHash: AUTHORISED, state: "soldOut" })),
              { orderHash: AUTHORISED, state: "made-up" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const book = await fetchKeeperOrderBook();
    expect(book.rejected).toHaveLength(KEEPER_MAX_ORDERS + 1);
    expect(book.unchecked).toHaveLength(KEEPER_MAX_ORDERS + 1);
    expect(book.closed).toHaveLength(KEEPER_MAX_ORDERS + 1);
    expect(book.closed.every((c) => c.state === "soldOut")).toBe(true);
    expect(book.error).toBeUndefined();
  });

  it("keeps the route's own error on a 502", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response(JSON.stringify({ ...EMPTY, error: VAULT_UNREADABLE }), { status: 502 }),
    );
    expect((await fetchKeeperOrderBook()).error).toBe(VAULT_UNREADABLE);
    vi.stubGlobal("fetch", async () => new Response("<html>bad gateway</html>", { status: 502 }));
    expect((await fetchKeeperOrderBook()).error).toBe("The order feed route answered HTTP 502.");
  });
});

/** The keeper's documented vol-mode record (keeper/README.md, "Market data (vol mode)"). */
const PRICING = {
  mode: "vol", source: "cboe-delayed", priceSource: "vol-fair", volPath: "fresh",
  volUnavailableReason: null, targetDelta: 0.15, deltaAtStrike: 0.1464, ivAtStrike: 0.3266,
  strikeUsdg6: "225000000", strikeOtmBps: 602, deltaStrikeUsdg6: "225000000",
  strikeClamped: null, bandBufferBps: 50,
  fairUnit6: "860864", volUnit6: "946951", floorUnit6: "848840", marginUnit6: "857329",
  unitPrice6: "946951", edgeBps: 1000, marginBps: 100,
  shareSpot: 212.0404, tokenSpot: 212.21, spotUsdg6: "212210000",
  expiry: "2026-09-25", chainTimestamp: "2026-09-15 05:57:42", lastTradeTime: "2026-09-14T15:59:59",
};

describe("the keeper's pricing report is carried for display only", () => {
  it("passes a record keeperPricingFigures accepts through to the verified row, as a fresh plain object", async () => {
    const { reader } = fakeChain();
    const { orders, rejected } = await verifyKeeperOrders([{ ...keeperEntry(), pricing: PRICING }], reader, CONFIG, NOW);
    expect(rejected).toEqual([]);
    expect(orders[0]!.pricing).toEqual(PRICING);
    expect(orders[0]!.pricing).not.toBe(PRICING);
  });

  it("serves the order with pricing null when the report is absent, malformed or inconsistent, and never rejects the order for it", async () => {
    const bad: unknown[] = [
      undefined,
      null,
      "vol",
      [],
      { ...PRICING, mode: "guess" },
      { ...PRICING, unitPrice6: "1" }, // below the floor: internally inconsistent
      { ...PRICING, extra: { nested: true } },
      { ...PRICING, extra: Number.POSITIVE_INFINITY },
    ];
    for (const pricing of bad) {
      const { reader } = fakeChain();
      const entry = pricing === undefined ? keeperEntry() : { ...keeperEntry(), pricing };
      const { orders, rejected } = await verifyKeeperOrders([entry], reader, CONFIG, NOW);
      expect(rejected, JSON.stringify(pricing)).toEqual([]);
      expect(orders).toHaveLength(1);
      expect(orders[0]!.pricing, JSON.stringify(pricing)).toBeNull();
    }
  });

  it("drops a report carrying prototype keys or too many keys", () => {
    const polluted = JSON.parse(`{"__proto__": {"x": 1}, ${JSON.stringify(PRICING).slice(1)}`) as unknown;
    expect(displayPricing(polluted)).toBeNull();
    const wide: Record<string, unknown> = { ...PRICING };
    for (let i = 0; Object.keys(wide).length <= KEEPER_PRICING_MAX_KEYS; i++) wide[`k${i}`] = i;
    expect(displayPricing(wide)).toBeNull();
    expect(displayPricing(PRICING)).toEqual(PRICING);
  });
});
