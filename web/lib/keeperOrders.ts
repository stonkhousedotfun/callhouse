import { getAddress, hashStruct, type Abi, type Address, type Hex, type PublicClient } from "viem";

import type { OvercallListing as BookRow, OrderComponentsJson as BookComponents } from "./api";
import { seaportAbi } from "./abi/seaport";
import { vaultAbi } from "./abi/vault";
import { checkListingIsOurs, isOrderComponents } from "./overcall";

/**
 * The keeper fallback: the vault's own listing, read from the keeper's GET /orders, checked
 * against the chain on the server, and handed to the cycle page in the exact row shape the
 * Overcall book uses, so the page fills it through the one fill path it already has.
 *
 * WHY: the vault authorises one Seaport order by hash (EIP-1271). The keeper posts it to
 * Overcall's book, and if Overcall's validator refuses it (open question L-04) the book never
 * shows it and nobody can buy the week. The keeper keeps serving the order at /orders; this file
 * is how app.callhouse.finance reads it.
 *
 * THE KEEPER IS NOT TRUSTED. It is our process, but it is a hot-key host on a network, and a
 * wrong or tampered order reaching the fill button would spend a buyer's USDG. So nothing it
 * says is carried to the page except the Seaport OrderParameters and the signature bytes, and
 * those only after every one of these holds on chain:
 *
 *   - the counter is Seaport.getCounter(offerer), read here. /orders drops it (it serves
 *     OrderParameters, not OrderComponents), so it is RESTORED from the chain, never taken from
 *     the keeper;
 *   - the order hash is Seaport.getOrderHash(rebuilt components), read here. The keeper's own
 *     `orderHash` string must equal it, and the row the page receives carries Seaport's value;
 *   - that hash is the vault's listingHash(), the offerer is the configured vault, the vault's
 *     phase is Listed, the end time has not passed, and the payment legs are exactly the vault
 *     leg plus Overcall's 5% leg at the contract count and gross the vault recorded
 *     (checkListingIsOurs, the same function the page runs on Overcall's rows);
 *   - Seaport does not report the order cancelled or fully sold.
 *
 * Anything else is dropped and reported with its reasons: logged on the server, returned under
 * `rejected`, never under `orders`. The page runs checkListingIsOurs again on what it receives,
 * so a bug here still does not produce a fill button on its own.
 *
 * DELIBERATELY ABSENT: any URL from the request, any header or field the keeper sent beyond the
 * parameters and signature, a redirect follower, a clock (`nowSeconds` is passed in), React.
 */

/*//////////////////////////////////////////////////////////////
                              LIMITS
//////////////////////////////////////////////////////////////*/

/** The keeper answers from SQLite on a private network. Five seconds is a keeper in trouble. */
export const KEEPER_TIMEOUT_MS = 5_000;
/** A live order is about 1.5 KiB and a vault has at most three listings a cycle. */
export const KEEPER_MAX_BYTES = 64 * 1024;
/** More live orders than this is not a vault's book; the extras are not checked or served. */
export const KEEPER_MAX_ORDERS = 8;
/** PHASE_LABELS in lib/hooks.ts: Idle, Listed, Exercisable, Settling. */
export const PHASE_LISTED = 1;

/*//////////////////////////////////////////////////////////////
                              SHAPE
//////////////////////////////////////////////////////////////*/

/** What /orders serves per order, as far as this file reads it. Every other key is ignored. */
export type KeeperOrderJson = {
  orderHash: string;
  chainId?: number;
  parameters: Omit<BookComponents, "counter"> & { totalOriginalConsiderationItems: string };
  signature: string;
};

const DECIMAL = /^[0-9]+$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
/** Seaport accepts any bytes, and the vault ignores them, but Overcall's schema and the keeper
 *  both use 64 or 65 bytes. An empty signature is also fillable for an order validated on chain. */
const SIGNATURE = /^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})?$/;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Structural gate for one /orders entry. OrderParameters are OrderComponents with
 *  `totalOriginalConsiderationItems` where the counter would be, so the existing components
 *  guard is reused with a dummy counter rather than written twice. */
export function isKeeperOrder(x: unknown): x is KeeperOrderJson {
  if (!isRecord(x) || !isRecord(x.parameters)) return false;
  if (typeof x.orderHash !== "string" || !BYTES32.test(x.orderHash)) return false;
  if (typeof x.signature !== "string" || !SIGNATURE.test(x.signature)) return false;
  if (x.chainId !== undefined && !(typeof x.chainId === "number" && Number.isInteger(x.chainId) && x.chainId > 0)) {
    return false;
  }
  const { totalOriginalConsiderationItems, ...rest } = x.parameters;
  if (typeof totalOriginalConsiderationItems !== "string" || !DECIMAL.test(totalOriginalConsiderationItems)) {
    return false;
  }
  // A counter from the keeper, if a later version ever sends one, is not read: the chain's is.
  return isOrderComponents({ ...rest, counter: "0" });
}

/*//////////////////////////////////////////////////////////////
                         COMPONENTS AND HASH
//////////////////////////////////////////////////////////////*/

export type OrderComponentsStruct = {
  offerer: Address;
  zone: Address;
  offer: Array<{ itemType: number; token: Address; identifierOrCriteria: bigint; startAmount: bigint; endAmount: bigint }>;
  consideration: Array<{
    itemType: number;
    token: Address;
    identifierOrCriteria: bigint;
    startAmount: bigint;
    endAmount: bigint;
    recipient: Address;
  }>;
  orderType: number;
  startTime: bigint;
  endTime: bigint;
  zoneHash: Hex;
  salt: bigint;
  conduitKey: Hex;
  counter: bigint;
};

/** Case is not meaning: an address is 20 bytes, and a keeper that mis-checksums one must not make
 *  viem throw mid-check. The bytes are what Seaport hashes. */
function addr(value: string): Address {
  return getAddress(value.toLowerCase());
}

/**
 * OrderParameters from /orders plus the chain's counter → OrderComponents, in the JSON form the
 * page's fill path reads. `totalOriginalConsiderationItems` is dropped: the fill path rebuilds it
 * from the consideration length, which the caller has already asserted it equals.
 */
export function restoreComponents(parameters: KeeperOrderJson["parameters"], counter: bigint): BookComponents {
  return {
    offerer: addr(parameters.offerer),
    zone: addr(parameters.zone),
    offer: parameters.offer.map((item) => ({
      itemType: item.itemType,
      token: addr(item.token),
      identifierOrCriteria: item.identifierOrCriteria,
      startAmount: item.startAmount,
      endAmount: item.endAmount,
    })),
    consideration: parameters.consideration.map((item) => ({
      itemType: item.itemType,
      token: addr(item.token),
      identifierOrCriteria: item.identifierOrCriteria,
      startAmount: item.startAmount,
      endAmount: item.endAmount,
      recipient: addr(item.recipient),
    })),
    orderType: parameters.orderType,
    startTime: parameters.startTime,
    endTime: parameters.endTime,
    zoneHash: parameters.zoneHash.toLowerCase() as Hex,
    salt: parameters.salt,
    conduitKey: parameters.conduitKey.toLowerCase() as Hex,
    counter: counter.toString(),
  };
}

/** The ABI struct for Seaport.getOrderHash. */
export function componentsStruct(c: BookComponents): OrderComponentsStruct {
  return {
    offerer: addr(c.offerer),
    zone: addr(c.zone),
    offer: c.offer.map((item) => ({
      itemType: item.itemType,
      token: addr(item.token),
      identifierOrCriteria: BigInt(item.identifierOrCriteria),
      startAmount: BigInt(item.startAmount),
      endAmount: BigInt(item.endAmount),
    })),
    consideration: c.consideration.map((item) => ({
      itemType: item.itemType,
      token: addr(item.token),
      identifierOrCriteria: BigInt(item.identifierOrCriteria),
      startAmount: BigInt(item.startAmount),
      endAmount: BigInt(item.endAmount),
      recipient: addr(item.recipient),
    })),
    orderType: c.orderType,
    startTime: BigInt(c.startTime),
    endTime: BigInt(c.endTime),
    zoneHash: c.zoneHash,
    salt: BigInt(c.salt),
    conduitKey: c.conduitKey,
    counter: BigInt(c.counter),
  };
}

const SEAPORT_TYPES = {
  OrderComponents: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
} as const;

/**
 * Seaport's order hash, derived locally: the EIP-712 struct hash of OrderComponents, which is
 * what Seaport.getOrderHash returns and what the vault records as listingHash (keeper
 * localOrderHash is the same derivation). The route asks Seaport itself; this exists so tests
 * can stand in for the chain with the real function rather than a lookup table, and the fork
 * acceptance asserts the two agree.
 */
export function seaportOrderHash(c: OrderComponentsStruct): Hex {
  return hashStruct({ data: c, primaryType: "OrderComponents", types: SEAPORT_TYPES });
}

/*//////////////////////////////////////////////////////////////
                            THE CHECK
//////////////////////////////////////////////////////////////*/

/** Chain reads the check needs. The route builds one from the app's server-side viem client;
 *  tests build one from fixtures. */
export type KeeperChainReader = {
  vaultListing(): Promise<{
    phase: number;
    listingHash: Hex;
    listingAmount: bigint;
    listingGrossUsdg: bigint;
    optionId: bigint;
  }>;
  getCounter(offerer: Address): Promise<bigint>;
  getOrderHash(components: OrderComponentsStruct): Promise<Hex>;
  getOrderStatus(orderHash: Hex): Promise<{ isCancelled: boolean; totalFilled: bigint; totalSize: bigint }>;
};

export type KeeperCheckConfig = {
  vault: Address | undefined;
  usdg: Address;
  clearinghouse: Address;
  seaport: Address;
  chainId: number;
};

/** Reasons specific to the keeper path, as the page and the server log print them. The
 *  field-by-field reasons come from REASONS in lib/overcall.ts. */
export const KEEPER_REASONS = {
  malformed: "The keeper served an order whose fields do not parse as Seaport order parameters.",
  itemCount: "The keeper's totalOriginalConsiderationItems is not the number of payment legs it served.",
  claimedHash: "The order hash the keeper names is not the hash Seaport computes for the order it served.",
  phase: "The vault is not in its Listed phase, so no order of its can be filled now.",
  cancelled: "Seaport reports this order as cancelled.",
  soldOut: "Seaport reports every contract in this order as sold.",
  unreadable: "This order could not be checked against the chain, so it is not offered.",
  tooMany: "The keeper served more orders than a vault can have live; the extras were not checked.",
} as const;

export type RejectedKeeperOrder = {
  /** The keeper's claimed hash, only when it is at least a well-formed bytes32. */
  orderHash: Hex | null;
  reasons: string[];
};

export type VerifiedKeeperOrders = { orders: BookRow[]; rejected: RejectedKeeperOrder[] };

function claimedHash(x: unknown): Hex | null {
  return isRecord(x) && typeof x.orderHash === "string" && BYTES32.test(x.orderHash) ? (x.orderHash as Hex) : null;
}

/**
 * Check every order the keeper served against the chain and return the ones that are the vault's
 * live, authorised listing, as book rows. Throws only when the vault itself cannot be read; a
 * failed read for one order rejects that order.
 */
export async function verifyKeeperOrders(
  raw: readonly unknown[],
  chain: KeeperChainReader,
  config: KeeperCheckConfig,
  nowSeconds: number,
): Promise<VerifiedKeeperOrders> {
  const rejected: RejectedKeeperOrder[] = [];
  const orders: BookRow[] = [];

  const considered = raw.slice(0, KEEPER_MAX_ORDERS);
  for (const extra of raw.slice(KEEPER_MAX_ORDERS)) {
    rejected.push({ orderHash: claimedHash(extra), reasons: [KEEPER_REASONS.tooMany] });
  }
  if (considered.length === 0) return { orders, rejected };

  // One read of the vault's slot for every order: there is one authorised hash, not one per order.
  const vault = await chain.vaultListing();

  const results = await Promise.all(
    considered.map(async (entry): Promise<BookRow | RejectedKeeperOrder> => {
      if (!isKeeperOrder(entry)) return { orderHash: claimedHash(entry), reasons: [KEEPER_REASONS.malformed] };
      const p = entry.parameters;
      const reasons: string[] = [];
      if (BigInt(p.totalOriginalConsiderationItems) !== BigInt(p.consideration.length)) {
        reasons.push(KEEPER_REASONS.itemCount);
      }

      let components: BookComponents;
      let orderHash: Hex;
      let status: { isCancelled: boolean; totalFilled: bigint; totalSize: bigint };
      try {
        const counter = await chain.getCounter(addr(p.offerer));
        components = restoreComponents(p, counter);
        orderHash = (await chain.getOrderHash(componentsStruct(components))).toLowerCase() as Hex;
        status = await chain.getOrderStatus(orderHash);
      } catch {
        return { orderHash: entry.orderHash as Hex, reasons: [...reasons, KEEPER_REASONS.unreadable] };
      }

      // The keeper's string is compared, then discarded: the row carries Seaport's hash, so
      // everything downstream compares the chain's number with the chain's number.
      if (entry.orderHash.toLowerCase() !== orderHash) reasons.push(KEEPER_REASONS.claimedHash);
      if (vault.phase !== PHASE_LISTED) reasons.push(KEEPER_REASONS.phase);
      if (status.isCancelled) reasons.push(KEEPER_REASONS.cancelled);

      const total = BigInt(components.offer[0]?.startAmount ?? "0");
      const writerLeg = BigInt(components.consideration[0]?.startAmount ?? "0");
      const feeLeg = BigInt(components.consideration[1]?.startAmount ?? "0");
      // Seaport's fraction is totalFilled/totalSize in its own reduced units; 0/0 is untouched.
      const sold = status.totalSize === 0n || total === 0n ? 0n : (status.totalFilled * total) / status.totalSize;
      if (total > 0n && sold >= total) reasons.push(KEEPER_REASONS.soldOut);

      const check = checkListingIsOurs(
        { orderHash, chainId: entry.chainId, offerer: components.offerer, components },
        {
          vault: config.vault,
          usdg: config.usdg,
          clearinghouse: config.clearinghouse,
          seaport: config.seaport,
          listingHash: vault.listingHash,
          chainId: config.chainId,
          amount: vault.listingAmount,
          grossUsdg: vault.listingGrossUsdg,
          optionId: vault.optionId,
        },
        nowSeconds,
      );
      if (!check.ok) reasons.push(...check.reasons);
      if (reasons.length > 0) return { orderHash: entry.orderHash as Hex, reasons };

      const gross = writerLeg + feeLeg;
      return {
        orderHash,
        chainId: config.chainId,
        offerer: components.offerer,
        optionId: components.offer[0]!.identifierOrCriteria,
        quantity: total.toString(),
        remaining: (total - sold).toString(),
        unitPrice6: (gross / total).toString(),
        totalPrice6: gross.toString(),
        startTime: components.startTime,
        endTime: components.endTime,
        salt: components.salt,
        counter: components.counter,
        status: sold === 0n ? "open" : "partial",
        components,
        signature: entry.signature.toLowerCase() as Hex,
      };
    }),
  );

  for (const result of results) {
    if ("components" in result) orders.push(result);
    else rejected.push(result);
  }
  return { orders, rejected };
}

/*//////////////////////////////////////////////////////////////
                           THE FETCH
//////////////////////////////////////////////////////////////*/

export type KeeperUrl =
  | { kind: "unset" }
  | { kind: "invalid"; problem: string }
  | { kind: "ok"; url: string };

/**
 * KEEPER_ORDERS_URL, parsed. http or https only, no credentials in it (fetch refuses them and a
 * credential in an env var URL is one that ends up in a log). The value itself is never echoed:
 * the problem names what is wrong, not what was set.
 */
export function parseKeeperOrdersUrl(raw: string | undefined): KeeperUrl {
  const value = raw?.trim();
  if (!value) return { kind: "unset" };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: "invalid", problem: "KEEPER_ORDERS_URL is not a URL." };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "invalid", problem: "KEEPER_ORDERS_URL must be an http or https URL." };
  }
  if (url.username !== "" || url.password !== "") {
    return { kind: "invalid", problem: "KEEPER_ORDERS_URL must not carry credentials." };
  }
  url.hash = "";
  return { kind: "ok", url: url.toString() };
}

export type KeeperFetchResult = { ok: true; orders: unknown[] } | { ok: false; error: string };

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Read at most `maxBytes` of the body, cancelling the stream the moment it goes over. */
async function readCapped(res: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array | "too-large"> {
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const onAbort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return "too-large";
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * GET the keeper's /orders. One fixed URL, no redirects followed (a 3xx is an error, so the
 * request can never be bounced to another host), a timeout that covers the body as well as the
 * headers, and a byte cap enforced while streaming rather than after buffering. Error strings
 * are this file's own words; nothing the keeper or the network said is passed on.
 */
export async function fetchKeeperOrders(
  url: string,
  options: { fetchImpl?: FetchLike; timeoutMs?: number; maxBytes?: number } = {},
): Promise<KeeperFetchResult> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? KEEPER_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? KEEPER_MAX_BYTES;
  const signal = AbortSignal.timeout(timeoutMs);
  const timedOut = `The keeper did not answer within ${timeoutMs / 1000} seconds.`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
      redirect: "manual",
      signal,
    });
  } catch {
    return { ok: false, error: signal.aborted ? timedOut : "The keeper could not be reached." };
  }

  if (res.status >= 300 && res.status < 400) {
    void res.body?.cancel().catch(() => {});
    return { ok: false, error: "The keeper answered with a redirect, which is not followed." };
  }
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    return { ok: false, error: `The keeper answered HTTP ${res.status}.` };
  }

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void res.body?.cancel().catch(() => {});
    return { ok: false, error: "The keeper's answer was larger than a book of live orders can be." };
  }

  let bytes: Uint8Array | "too-large";
  try {
    bytes = await readCapped(res, maxBytes, signal);
  } catch {
    return { ok: false, error: signal.aborted ? timedOut : "The keeper's answer could not be read." };
  }
  if (bytes === "too-large") {
    return { ok: false, error: "The keeper's answer was larger than a book of live orders can be." };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, error: "The keeper's answer was not JSON." };
  }
  if (!isRecord(payload) || !Array.isArray(payload.orders)) {
    return { ok: false, error: "The keeper's answer did not contain an orders array." };
  }
  return { ok: true, orders: payload.orders };
}

/*//////////////////////////////////////////////////////////////
                            THE ROUTE
//////////////////////////////////////////////////////////////*/

/** What GET /api/keeper/orders answers. `configured: false` is the one state in which the page
 *  shows nothing about the fallback at all. */
export type KeeperOrdersBody = {
  configured: boolean;
  orders: BookRow[];
  rejected: RejectedKeeperOrder[];
  error?: string;
};

export type KeeperRouteDeps = {
  /** process.env.KEEPER_ORDERS_URL, read per request. */
  keeperOrdersUrl: string | undefined;
  config: KeeperCheckConfig;
  chain: KeeperChainReader;
  nowSeconds: number;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
  /** Server-side report of what was dropped. Defaults to one JSON line on stderr. */
  log?: (event: Record<string, unknown>) => void;
};

export const NOT_CONFIGURED =
  "The keeper fallback is not configured on this deployment (KEEPER_ORDERS_URL is not set).";

function defaultLog(event: Record<string, unknown>): void {
  console.warn(JSON.stringify({ service: "web", route: "/api/keeper/orders", ...event }));
}

export async function serveKeeperOrders(deps: KeeperRouteDeps): Promise<{ status: number; body: KeeperOrdersBody }> {
  const log = deps.log ?? defaultLog;
  const target = parseKeeperOrdersUrl(deps.keeperOrdersUrl);
  if (target.kind === "unset") {
    return { status: 503, body: { configured: false, orders: [], rejected: [], error: NOT_CONFIGURED } };
  }
  if (target.kind === "invalid") {
    log({ level: "error", msg: "keeper fallback misconfigured", problem: target.problem });
    return {
      status: 503,
      body: { configured: true, orders: [], rejected: [], error: "The keeper fallback is misconfigured on this deployment." },
    };
  }
  if (deps.config.vault === undefined) {
    return {
      status: 503,
      body: { configured: true, orders: [], rejected: [], error: "This build has no vault address configured, so nothing can be checked." },
    };
  }

  const fetched = await fetchKeeperOrders(target.url, {
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    maxBytes: deps.maxBytes,
  });
  if (!fetched.ok) {
    log({ level: "warn", msg: "keeper orders unavailable", error: fetched.error });
    return { status: 502, body: { configured: true, orders: [], rejected: [], error: fetched.error } };
  }

  let verified: VerifiedKeeperOrders;
  try {
    verified = await verifyKeeperOrders(fetched.orders, deps.chain, deps.config, deps.nowSeconds);
  } catch {
    log({ level: "warn", msg: "keeper orders could not be checked: vault read failed" });
    return {
      status: 502,
      body: {
        configured: true,
        orders: [],
        rejected: [],
        error: "The vault could not be read from the chain, so the keeper's orders cannot be checked.",
      },
    };
  }

  for (const r of verified.rejected) {
    log({ level: "warn", msg: "keeper order rejected", orderHash: r.orderHash, reasons: r.reasons });
  }
  return { status: 200, body: { configured: true, ...verified } };
}

/*//////////////////////////////////////////////////////////////
                         THE CHAIN READER
//////////////////////////////////////////////////////////////*/

/** The production reader: the app's server-side viem client (lib/chain.ts), multicall-batched. */
export function viemKeeperChainReader(client: PublicClient, addresses: { vault: Address; seaport: Address }): KeeperChainReader {
  const vault = (functionName: string) =>
    client.readContract({ address: addresses.vault, abi: vaultAbi as unknown as Abi, functionName });
  const seaport = (functionName: string, args: readonly unknown[]) =>
    client.readContract({ address: addresses.seaport, abi: seaportAbi as unknown as Abi, functionName, args });
  return {
    async vaultListing() {
      const [phase, listingHash, listingAmount, listingGrossUsdg, optionId] = await Promise.all([
        vault("phase"),
        vault("listingHash"),
        vault("listingAmount"),
        vault("listingGrossUsdg"),
        vault("optionId"),
      ]);
      return {
        phase: Number(phase),
        listingHash: listingHash as Hex,
        listingAmount: listingAmount as bigint,
        listingGrossUsdg: listingGrossUsdg as bigint,
        optionId: optionId as bigint,
      };
    },
    async getCounter(offerer) {
      return (await seaport("getCounter", [offerer])) as bigint;
    },
    async getOrderHash(components) {
      return (await seaport("getOrderHash", [components])) as Hex;
    },
    async getOrderStatus(orderHash) {
      const [, isCancelled, totalFilled, totalSize] = (await seaport("getOrderStatus", [orderHash])) as readonly [
        boolean,
        boolean,
        bigint,
        bigint,
      ];
      return { isCancelled, totalFilled, totalSize };
    },
  };
}
