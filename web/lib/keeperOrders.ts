import type { Abi, Address, Hex, PublicClient } from "viem";

import { seaportAbi } from "./abi/seaport";
import { vaultAbi } from "./abi/vault";
import { ZERO_CONDUIT_KEY } from "./contracts";
import { REASONS, checkListingIsOurs, isOrderComponents, type ListingRow, type OrderComponentsJson } from "./listing";
import {
  addr,
  componentsStruct,
  seaportOrderHash,
  seaportRemaining,
  seaportSoldOut,
  type OrderComponentsStruct,
  type SeaportFillStatus,
} from "./seaportOrder";

export { componentsStruct, seaportOrderHash, type OrderComponentsStruct } from "./seaportOrder";

/**
 * The order feed: the vault's own listing, read from the keeper's GET /orders, checked against
 * the chain on the server, and handed to the cycle page as a listing row it can fill.
 *
 * WHY: the vault authorises one Seaport order by hash (`approveListing` validates it on Seaport
 * and records its hash, size, gross and option id). The chain carries those four facts but not
 * the salt, the times or the counter a fill has to send, so the parameters have to come from the
 * process that built the order: the keeper, at /orders. This app's fill page is the ONLY venue
 * for the vault's calls, and this file is how it reads them.
 *
 * THE KEEPER IS NOT TRUSTED. It is our process, but it is a hot-key host on a network, and a
 * wrong or tampered order reaching the fill button would spend a buyer's USDG. So nothing it
 * says is carried to the page except the Seaport OrderParameters, and those only after every
 * one of these holds on chain:
 *
 *   - the order the keeper names is the vault's listingHash(). Any other order it serves is an
 *     earlier or superseded listing (a counter bump retires one without cancelling it, and the
 *     keeper serves a row until its end time): reported as `closed`, `notCurrent`, and not
 *     checked further, because it can never be offered;
 *   - the counter is Seaport.getCounter(offerer), read here. /orders drops it (it serves
 *     OrderParameters, not OrderComponents), so it is RESTORED from the chain, never taken from
 *     the keeper;
 *   - the order hash is derived locally (lib/seaportOrder.ts) AND read from Seaport.getOrderHash,
 *     and the two must agree. The keeper's own `orderHash` string must equal it, and the row the
 *     page receives carries that value;
 *   - the order is the vault's in every field a fill spends against: offerer AND zone are the
 *     vault, PARTIAL_RESTRICTED, one ERC-1155 offer of this cycle's option id on the clearinghouse
 *     the vault names (`vault.clear()`, read here), ONE USDG leg to the vault at the count and
 *     gross the vault recorded, the vault's conduit key, no zone hash, not past its end time
 *     (checkListingIsOurs, the same function the page runs on the row);
 *   - the vault's phase is Listed and Seaport does not report the order cancelled or sold out.
 *
 * The signature the keeper serves is NOT carried. The vault pre-validates the order on Seaport
 * and has no signing key, so an empty signature is the only honest one; the row's `signature`
 * is `0x` whatever the feed sent (a legacy 64/65-byte placeholder is accepted and dropped).
 *
 * FOUR OUTCOMES, so an alarm is only raised for what deserves one:
 *   orders     the vault's live, authorised listing, as a row.
 *   rejected   the keeper served something that claims the authorised hash and is not that
 *              order, or does not parse. An integrity failure: logged as a warning.
 *   closed     a lifecycle state, not a fault: sold out, cancelled, not Listed, past its end
 *              time, or not the current listing at all.
 *   unchecked  the chain could not be read for the order. Not offered, and not the keeper's fault.
 *
 * The chain state (the vault's slot, counters, statuses) is read in ONE eth_call, so one block;
 * Seaport's getOrderHash, a pure function, is a second. The route bounds both with a deadline.
 * The page runs checkListingIsOurs again on what it receives, and simulates the fill before
 * enabling the button, so a bug here still does not produce a live fill button on its own.
 *
 * DELIBERATELY ABSENT: any URL from the request, any header or field the keeper sent beyond the
 * parameters, a redirect follower, a clock (`nowSeconds` is passed in), React.
 */

/*//////////////////////////////////////////////////////////////
                              LIMITS
//////////////////////////////////////////////////////////////*/

/** The keeper answers from SQLite on a private network. Five seconds is a keeper in trouble. */
export const KEEPER_TIMEOUT_MS = 5_000;
/** A live order is about 1.5 KiB and a vault has at most three listings a cycle. */
export const KEEPER_MAX_BYTES = 64 * 1024;
/** More live orders than this is not a vault's book: the whole answer is refused, none checked. */
export const KEEPER_MAX_ORDERS = 8;
/**
 * Every chain read the check makes, together. With the keeper's five seconds the route answers
 * within eleven, under the fifteen the browser waits (lib/api.ts fetchKeeperOrderBook), so a hung
 * RPC is reported in the route's words rather than as the browser's own abort.
 */
export const CHAIN_DEADLINE_MS = 6_000;
/** PHASE_LABELS in lib/hooks.ts: Idle, Listed, Exercisable, Settling. */
export const PHASE_LISTED = 1;

/*//////////////////////////////////////////////////////////////
                              SHAPE
//////////////////////////////////////////////////////////////*/

/** What /orders serves per order, as far as this file reads it. Every other key is ignored. */
export type KeeperOrderJson = {
  orderHash: string;
  chainId?: number;
  parameters: Omit<OrderComponentsJson, "counter"> & { totalOriginalConsiderationItems: string };
  signature?: string;
};

const DECIMAL = /^[0-9]+$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
/** Empty (the honest value for a pre-validated order), or the 64/65-byte placeholder an older
 *  keeper served. Anything else is a malformed row; whatever passes is dropped, not carried. */
const SIGNATURE = /^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})?$/;

/** The one signature a row ever carries. */
export const EMPTY_SIGNATURE: Hex = "0x";

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Structural gate for one /orders entry. OrderParameters are OrderComponents with
 *  `totalOriginalConsiderationItems` where the counter would be, so the existing components
 *  guard is reused with a dummy counter rather than written twice. */
export function isKeeperOrder(x: unknown): x is KeeperOrderJson {
  if (!isRecord(x) || !isRecord(x.parameters)) return false;
  if (typeof x.orderHash !== "string" || !BYTES32.test(x.orderHash)) return false;
  if (x.signature !== undefined && (typeof x.signature !== "string" || !SIGNATURE.test(x.signature))) return false;
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

/**
 * OrderParameters from /orders plus the chain's counter → OrderComponents, in the JSON form the
 * page's fill path reads. `totalOriginalConsiderationItems` is dropped: the fill path rebuilds it
 * from the consideration length, which the caller has already asserted it equals.
 */
export function restoreComponents(parameters: KeeperOrderJson["parameters"], counter: bigint): OrderComponentsJson {
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

/*//////////////////////////////////////////////////////////////
                            THE CHECK
//////////////////////////////////////////////////////////////*/

export type VaultListingSlot = {
  phase: number;
  listingHash: Hex;
  listingAmount: bigint;
  listingGrossUsdg: bigint;
  optionId: bigint;
  /** `vault.conduitKey()`: zero at deploy, read rather than assumed. */
  conduitKey: Hex;
  /**
   * `vault.clear()`: the clearinghouse the vault was constructed with, a deploy-time choice. The
   * offer item must be this contract's ERC-1155. Read rather than taken from the build's
   * NEXT_PUBLIC_CLEARINGHOUSE, which is the fallback for a reader that does not supply it.
   */
  clear?: Address;
};

/** Chain reads the check needs. The route builds one from the app's server-side viem client;
 *  tests build one from fixtures. */
export type KeeperChainReader = {
  /**
   * The chain's state for the check, in ONE eth_call and so one block: the vault's listing slot,
   * Seaport's counter for each offerer and Seaport's status for each order hash, in the order
   * asked. Throws when the vault's slot cannot be read; a per-order read that fails is
   * `undefined` in its place.
   */
  readState(query: { offerers: readonly Address[]; orderHashes: readonly Hex[] }): Promise<{
    vault: VaultListingSlot;
    counters: ReadonlyArray<bigint | undefined>;
    statuses: ReadonlyArray<SeaportFillStatus | undefined>;
  }>;
  /** Seaport.getOrderHash for each struct, in one batch. Pure on chain, so no block is pinned.
   *  A read that fails is `undefined` in its place. */
  getOrderHashes(components: readonly OrderComponentsStruct[]): Promise<ReadonlyArray<Hex | undefined>>;
};

export type KeeperCheckConfig = {
  vault: Address | undefined;
  usdg: Address;
  clearinghouse: Address;
  seaport: Address;
  chainId: number;
};

/** Reasons specific to the keeper path, as the page and the server log print them. The
 *  field-by-field reasons come from REASONS in lib/listing.ts. */
export const KEEPER_REASONS = {
  malformed: "The keeper served an order whose fields do not parse as Seaport order parameters.",
  itemCount: "The keeper's totalOriginalConsiderationItems is not the number of payment legs it served.",
  claimedHash: "The order hash the keeper names is not the hash Seaport computes for the order it served.",
  unreadable: "The chain could not be read for this order, so it is not offered yet.",
  hashDerivation: "Seaport's order hash and this app's own derivation of it disagree, so the order is not offered.",
  tooMany: "The keeper served more orders than a vault can have live, so none of them are offered.",
} as const;

/** Lifecycle states: why an order is not offered when nothing is wrong with it. */
export type KeeperOrderState = "notCurrent" | "soldOut" | "cancelled" | "notListed" | "expired";

export const KEEPER_STATES: Record<KeeperOrderState, string> = {
  notCurrent: "Not the order the vault authorises now; an earlier or superseded listing.",
  soldOut: "Seaport reports every contract in this order as sold.",
  cancelled: "Seaport reports this order as cancelled.",
  notListed: "The vault is not in its Listed phase, so no order of its can be filled now.",
  expired: "This order's end time has passed.",
};

export type KeeperOrderIssue = {
  /** The keeper's claimed hash, only when it is at least a well-formed bytes32. */
  orderHash: Hex | null;
  reasons: string[];
};

export type ClosedKeeperOrder = { orderHash: Hex; state: KeeperOrderState };

export type VerifiedKeeperOrders = {
  orders: ListingRow[];
  rejected: KeeperOrderIssue[];
  closed: ClosedKeeperOrder[];
  unchecked: KeeperOrderIssue[];
};

function claimedHash(x: unknown): Hex | null {
  return isRecord(x) && typeof x.orderHash === "string" && BYTES32.test(x.orderHash)
    ? (x.orderHash.toLowerCase() as Hex)
    : null;
}

function isZeroHash(h: string): boolean {
  return /^0x0*$/.test(h);
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/**
 * Check every order the keeper served against the chain and sort it into one of the four
 * outcomes. Throws only when the vault itself cannot be read; a failed read for one order puts
 * that order under `unchecked`.
 */
export async function verifyKeeperOrders(
  raw: readonly unknown[],
  chain: KeeperChainReader,
  config: KeeperCheckConfig,
  nowSeconds: number,
): Promise<VerifiedKeeperOrders> {
  const out: VerifiedKeeperOrders = { orders: [], rejected: [], closed: [], unchecked: [] };

  // A keeper that serves more than a vault can have live is not describing a vault's book. One
  // item says so; nothing is checked, so the size of the answer bounds nothing downstream.
  if (raw.length > KEEPER_MAX_ORDERS) {
    out.rejected.push({ orderHash: null, reasons: [`${KEEPER_REASONS.tooMany} (${raw.length} served)`] });
    return out;
  }

  const wellFormed: KeeperOrderJson[] = [];
  for (const entry of raw) {
    if (isKeeperOrder(entry)) wellFormed.push(entry);
    else out.rejected.push({ orderHash: claimedHash(entry), reasons: [KEEPER_REASONS.malformed] });
  }
  if (wellFormed.length === 0) return out;

  // One block for every stateful fact: there is one authorised hash, not one per order.
  const offerers = unique(wellFormed.map((e) => addr(e.parameters.offerer)));
  const orderHashes = unique(wellFormed.map((e) => e.orderHash.toLowerCase() as Hex));
  const state = await chain.readState({ offerers, orderHashes });
  const authorised = state.vault.listingHash.toLowerCase() as Hex;

  type Candidate = {
    entry: KeeperOrderJson;
    claimed: Hex;
    components: OrderComponentsJson;
    struct: OrderComponentsStruct;
    localHash: Hex;
    status: SeaportFillStatus;
  };
  const candidates: Candidate[] = [];
  for (const entry of wellFormed) {
    const claimed = entry.orderHash.toLowerCase() as Hex;
    // Not the vault's current listing: never offerable, so not checked. A legitimately
    // superseded order lands here, and must not read as tampering.
    if (isZeroHash(authorised) || claimed !== authorised) {
      out.closed.push({ orderHash: claimed, state: "notCurrent" });
      continue;
    }
    const counter = state.counters[offerers.indexOf(addr(entry.parameters.offerer))];
    const status = state.statuses[orderHashes.indexOf(claimed)];
    if (counter === undefined || status === undefined) {
      out.unchecked.push({ orderHash: claimed, reasons: [KEEPER_REASONS.unreadable] });
      continue;
    }
    const components = restoreComponents(entry.parameters, counter);
    const struct = componentsStruct(components);
    candidates.push({ entry, claimed, components, struct, localHash: seaportOrderHash(struct), status });
  }
  if (candidates.length === 0) return out;

  let seaportHashes: ReadonlyArray<Hex | undefined>;
  try {
    seaportHashes = await chain.getOrderHashes(candidates.map((c) => c.struct));
  } catch {
    seaportHashes = [];
  }

  candidates.forEach((candidate, i) => {
    const { entry, claimed, components, localHash, status } = candidate;
    const seaportHash = seaportHashes[i]?.toLowerCase() as Hex | undefined;
    if (seaportHash === undefined) {
      out.unchecked.push({ orderHash: claimed, reasons: [KEEPER_REASONS.unreadable] });
      return;
    }
    if (seaportHash !== localHash) {
      out.unchecked.push({ orderHash: claimed, reasons: [KEEPER_REASONS.hashDerivation] });
      return;
    }

    // Integrity: the keeper claims the authorised hash, so everything it served must be that order.
    const p = entry.parameters;
    const reasons: string[] = [];
    if (BigInt(p.totalOriginalConsiderationItems) !== BigInt(p.consideration.length)) {
      reasons.push(KEEPER_REASONS.itemCount);
    }
    // The keeper's string is compared, then discarded: the row carries the chain's hash.
    if (claimed !== seaportHash) reasons.push(KEEPER_REASONS.claimedHash);
    const check = checkListingIsOurs(
      { orderHash: seaportHash, chainId: entry.chainId, offerer: components.offerer, components },
      {
        vault: config.vault,
        usdg: config.usdg,
        // The vault's own clearinghouse when the reader supplied it: a build whose compiled
        // constant points at another Clear must not reject the vault's real listing.
        clearinghouse: state.vault.clear ?? config.clearinghouse,
        seaport: config.seaport,
        listingHash: state.vault.listingHash,
        chainId: config.chainId,
        amount: state.vault.listingAmount,
        grossUsdg: state.vault.listingGrossUsdg,
        optionId: state.vault.optionId,
        conduitKey: state.vault.conduitKey,
      },
      nowSeconds,
    );
    const checkReasons = check.ok ? [] : check.reasons;
    const expired = checkReasons.includes(REASONS.expired);
    reasons.push(...checkReasons.filter((r) => r !== REASONS.expired));
    if (reasons.length > 0) {
      out.rejected.push({ orderHash: claimed, reasons: expired ? [...reasons, REASONS.expired] : reasons });
      return;
    }

    // Lifecycle: the right order, and nothing wrong with it, but not fillable now.
    if (status.isCancelled) return void out.closed.push({ orderHash: claimed, state: "cancelled" });
    if (seaportSoldOut(status)) return void out.closed.push({ orderHash: claimed, state: "soldOut" });
    if (state.vault.phase !== PHASE_LISTED) return void out.closed.push({ orderHash: claimed, state: "notListed" });
    if (expired) return void out.closed.push({ orderHash: claimed, state: "expired" });

    const total = BigInt(components.offer[0]!.startAmount);
    const remaining = seaportRemaining(total, status) ?? total;
    if (remaining === 0n) return void out.closed.push({ orderHash: claimed, state: "soldOut" });
    // ONE leg: the check above has asserted the shape, so consideration[0] is the whole gross.
    const gross = BigInt(components.consideration[0]!.startAmount);
    out.orders.push({
      orderHash: seaportHash,
      chainId: config.chainId,
      offerer: components.offerer,
      optionId: components.offer[0]!.identifierOrCriteria,
      quantity: total.toString(),
      remaining: remaining.toString(),
      unitPrice6: (gross / total).toString(),
      totalPrice6: gross.toString(),
      startTime: components.startTime,
      endTime: components.endTime,
      salt: components.salt,
      counter: components.counter,
      status: remaining === total ? "open" : "partial",
      components,
      signature: EMPTY_SIGNATURE,
    });
  });

  return out;
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
 *  says the feed is not wired on this deployment. */
export type KeeperOrdersBody = {
  configured: boolean;
  orders: ListingRow[];
  rejected: KeeperOrderIssue[];
  closed: ClosedKeeperOrder[];
  unchecked: KeeperOrderIssue[];
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
  /** Deadline for every chain read together. Defaults to CHAIN_DEADLINE_MS. */
  chainDeadlineMs?: number;
  /** Server-side report. Defaults to one JSON line per event on stderr; `debug` is dropped. */
  log?: (event: Record<string, unknown>) => void;
};

export const NOT_CONFIGURED =
  "The order feed is not configured on this deployment (KEEPER_ORDERS_URL is not set).";

export const VAULT_UNREADABLE = "The vault could not be read from the chain, so the keeper's orders cannot be checked.";

export function chainTimedOut(ms: number): string {
  return `The chain did not answer within ${ms / 1000} seconds, so the keeper's orders cannot be checked yet.`;
}

/** How many hashes one log line names. The count is always the full count. */
const LOG_HASHES = 3;

function defaultLog(event: Record<string, unknown>): void {
  if (event.level === "debug") return;
  const line = JSON.stringify({ service: "web", route: "/api/keeper/orders", ...event });
  if (event.level === "warn" || event.level === "error") console.warn(line);
  else console.log(line);
}

function emptyBody(configured: boolean, error?: string): KeeperOrdersBody {
  return { configured, orders: [], rejected: [], closed: [], unchecked: [], ...(error === undefined ? {} : { error }) };
}

const TIMED_OUT = Symbol("timed out");

/** `work`, or TIMED_OUT once `ms` pass. A late rejection is swallowed, not left unhandled. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  work.catch(() => {});
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** One line per outcome per computation, however many orders: the answer is shared for two
 *  seconds, and a line per order per share window is what drowns the logs that matter. */
function logOutcome(log: (event: Record<string, unknown>) => void, v: VerifiedKeeperOrders): void {
  if (v.rejected.length > 0) {
    log({
      level: "warn",
      msg: "keeper orders rejected",
      count: v.rejected.length,
      orderHashes: v.rejected.slice(0, LOG_HASHES).map((r) => r.orderHash),
      reasons: v.rejected[0]!.reasons,
    });
  }
  if (v.unchecked.length > 0) {
    log({
      level: "warn",
      msg: "keeper orders unchecked: chain read failed",
      count: v.unchecked.length,
      orderHashes: v.unchecked.slice(0, LOG_HASHES).map((r) => r.orderHash),
      reasons: v.unchecked[0]!.reasons,
    });
  }
  if (v.closed.length > 0) {
    log({
      level: "debug",
      msg: "keeper orders not offered",
      count: v.closed.length,
      closed: v.closed.slice(0, LOG_HASHES),
    });
  }
}

export async function serveKeeperOrders(deps: KeeperRouteDeps): Promise<{ status: number; body: KeeperOrdersBody }> {
  const log = deps.log ?? defaultLog;
  const target = parseKeeperOrdersUrl(deps.keeperOrdersUrl);
  if (target.kind === "unset") return { status: 503, body: emptyBody(false, NOT_CONFIGURED) };
  if (target.kind === "invalid") {
    log({ level: "error", msg: "order feed misconfigured", problem: target.problem });
    return { status: 503, body: emptyBody(true, "The order feed is misconfigured on this deployment.") };
  }
  if (deps.config.vault === undefined) {
    return { status: 503, body: emptyBody(true, "This build has no vault address configured, so nothing can be checked.") };
  }

  const fetched = await fetchKeeperOrders(target.url, {
    fetchImpl: deps.fetchImpl,
    timeoutMs: deps.timeoutMs,
    maxBytes: deps.maxBytes,
  });
  if (!fetched.ok) {
    log({ level: "warn", msg: "keeper orders unavailable", error: fetched.error });
    return { status: 502, body: emptyBody(true, fetched.error) };
  }
  if (fetched.orders.length > KEEPER_MAX_ORDERS) {
    log({ level: "warn", msg: "keeper served too many orders", count: fetched.orders.length, max: KEEPER_MAX_ORDERS });
    return { status: 502, body: emptyBody(true, KEEPER_REASONS.tooMany) };
  }

  const deadlineMs = deps.chainDeadlineMs ?? CHAIN_DEADLINE_MS;
  let verified: VerifiedKeeperOrders | typeof TIMED_OUT;
  try {
    verified = await withDeadline(verifyKeeperOrders(fetched.orders, deps.chain, deps.config, deps.nowSeconds), deadlineMs);
  } catch {
    log({ level: "warn", msg: "keeper orders could not be checked: vault read failed" });
    return { status: 502, body: emptyBody(true, VAULT_UNREADABLE) };
  }
  if (verified === TIMED_OUT) {
    log({ level: "warn", msg: "keeper orders could not be checked: chain reads timed out", deadlineMs });
    return { status: 502, body: emptyBody(true, chainTimedOut(deadlineMs)) };
  }

  logOutcome(log, verified);
  return { status: 200, body: { configured: true, ...verified } };
}

/**
 * One computation per key while it runs and for `shareMs` after it SETTLES. Measured from the
 * settle, not the start: a computation that takes longer than the window (a slow keeper, an RPC
 * near its deadline) would otherwise have every poll start another on top of it.
 */
export function shareWhileRunning<T>(
  compute: (key: string | undefined) => Promise<T>,
  options: { shareMs: number; now?: () => number },
): (key: string | undefined) => Promise<T> {
  const now = options.now ?? Date.now;
  let shared: { key: string | undefined; settledAt: number | null; answer: Promise<T> } | null = null;
  return (key) => {
    const current = shared;
    if (current !== null && current.key === key && (current.settledAt === null || now() - current.settledAt < options.shareMs)) {
      return current.answer;
    }
    const entry: { key: string | undefined; settledAt: number | null; answer: Promise<T> } = {
      key,
      settledAt: null,
      answer: compute(key),
    };
    const settle = () => {
      entry.settledAt = now();
    };
    entry.answer.then(settle, settle);
    shared = entry;
    return entry.answer;
  };
}

/*//////////////////////////////////////////////////////////////
                         THE CHAIN READER
//////////////////////////////////////////////////////////////*/

type CallResult = { status: "success"; result: unknown } | { status: "failure"; error: unknown };

/**
 * The production reader: the app's server-side viem client (lib/chain.ts) through Multicall3.
 * `batchSize: 0` stops viem splitting a large batch into several eth_calls, which could land in
 * different blocks; readState is one eth_call, so its answers describe one block.
 */
export function viemKeeperChainReader(client: PublicClient, addresses: { vault: Address; seaport: Address }): KeeperChainReader {
  const vault = (functionName: string) => ({ address: addresses.vault, abi: vaultAbi as unknown as Abi, functionName });
  const seaport = (functionName: string, args: readonly unknown[]) => ({
    address: addresses.seaport,
    abi: seaportAbi as unknown as Abi,
    functionName,
    args,
  });
  const multicall = async (contracts: ReadonlyArray<ReturnType<typeof vault> | ReturnType<typeof seaport>>) =>
    (await client.multicall({ allowFailure: true, batchSize: 0, contracts: contracts as never })) as unknown as CallResult[];
  const ok = (r: CallResult | undefined): unknown => (r?.status === "success" ? r.result : undefined);

  const SLOT = ["phase", "listingHash", "listingAmount", "listingGrossUsdg", "optionId", "conduitKey", "clear"] as const;

  return {
    async readState({ offerers, orderHashes }) {
      const results = await multicall([
        ...SLOT.map((name) => vault(name)),
        ...offerers.map((o) => seaport("getCounter", [o])),
        ...orderHashes.map((h) => seaport("getOrderStatus", [h])),
      ]);
      const slot = results.slice(0, SLOT.length);
      if (slot.some((r) => r.status !== "success")) throw new Error("vault listing slot unreadable");
      const [phase, listingHash, listingAmount, listingGrossUsdg, optionId, conduitKey, clear] = slot.map(ok);
      const base = SLOT.length;
      return {
        vault: {
          phase: Number(phase),
          listingHash: listingHash as Hex,
          listingAmount: listingAmount as bigint,
          listingGrossUsdg: listingGrossUsdg as bigint,
          optionId: optionId as bigint,
          conduitKey: (conduitKey as Hex | undefined) ?? ZERO_CONDUIT_KEY,
          clear: clear as Address,
        },
        counters: offerers.map((_, i) => ok(results[base + i]) as bigint | undefined),
        statuses: orderHashes.map((_, i) => {
          const tuple = ok(results[base + offerers.length + i]) as readonly [boolean, boolean, bigint, bigint] | undefined;
          return tuple === undefined ? undefined : { isCancelled: tuple[1], totalFilled: tuple[2], totalSize: tuple[3] };
        }),
      };
    },
    async getOrderHashes(components) {
      const results = await multicall(components.map((c) => seaport("getOrderHash", [c])));
      return components.map((_, i) => ok(results[i]) as Hex | undefined);
    },
  };
}
