import type { Address, Hex } from "viem";

import { ZERO_CONDUIT_KEY, ZERO_HASH } from "./contracts";
import { componentsHash } from "./seaportOrder";

/**
 * Guards for a listing's JSON, and the check that a listing is OURS before a buyer's USDG goes
 * anywhere near it.
 *
 * WHY: the only venue for the vault's calls is this app's own fill page, fed by the keeper's
 * GET /orders through app/api/keeper/orders. The keeper is our process, but it is a hot-key host
 * on a network, and every field it serves (the offerer, the zone, the recipient, the token, the
 * amounts) is a row in its database until the chain has confirmed it. Until this file existed,
 * OrderPayload copied those fields straight into fulfillAdvancedOrder right after
 * approve(SEAPORT, cost), so a tampered or merely wrong row would have spent the buyer's USDG on
 * a different seller, to a different recipient, or in a different token. The vault's on-chain
 * `listingHash` is the authoritative fact about which order is ours, and the vault records three
 * more facts about it at approveListing(): `listingAmount` (the contract count),
 * `listingGrossUsdg` (the one USDG leg) and `optionId` (the ERC-1155 id on offer). Everything the
 * feed serves is checked against all four and against the addresses compiled into contracts.ts.
 * The hash string alone is not enough: the feed's `orderHash` is its string, and a row that keeps
 * our hash but carries components at ten times the price would still be quoted, and approved, at
 * that price before Seaport ever recomputed the hash. Pinning the amounts to the chain closes
 * that. So does the second half: the components are hashed here, locally, with Seaport's own
 * EIP-712 derivation (lib/seaportOrder.ts), and must hash to the row's orderHash. Without it a
 * row could carry our hash and our amounts but a different salt, counter, start time or zone
 * hash, pass every field check, and revert at fulfilment after the buyer's approve(), because
 * Seaport would hash the edited components to a hash the vault never authorised.
 *
 * THE SHAPE UNDER WRITE ON FILL (contracts/src/lib/SeaportOrderLib.sol). A listing is a
 * PARTIAL_RESTRICTED order (type 3) whose zone is the VAULT: Seaport calls the vault's
 * `authorizeOrder` before it moves anything, and that hook writes exactly the filled contracts
 * into Valorem. One ERC-1155 offer item (the clearinghouse, this cycle's option id), ONE ERC-20
 * consideration item (USDG to the vault, a whole multiple of the contract count so Seaport can
 * fill any fraction exactly), zone hash zero, the vault's conduit key (zero at deploy), and an
 * empty signature: the vault validated the order on chain, so Seaport skips verification. There
 * is no third-party fee leg. The same rules, in the same order, are what the vault itself
 * enforces at approveListing(); a row that fails one here would have been refused there, so a
 * failure here is a row the vault never authorised, whatever hash it names.
 *
 * DELIBERATELY ABSENT: React, fetch, Date.now(), zod, a chain client. Pure functions over
 * `unknown`, so the route and the component share one definition of "well-formed" and one of
 * "ours", and so the whole thing runs under vitest with fixtures.
 */

/*//////////////////////////////////////////////////////////////
                              SHAPE
//////////////////////////////////////////////////////////////*/

/** Seaport ItemType. The vault offers an ERC-1155 option and asks for ERC-20 USDG, nothing else. */
export const ITEM_TYPE_ERC20 = 1;
export const ITEM_TYPE_ERC1155 = 3;
/** PARTIAL_RESTRICTED. Every vault listing is orderType 3; the fill path and the hooks rely on it. */
export const ORDER_TYPE_PARTIAL_RESTRICTED = 3;

export type OfferItemJson = {
  itemType: number;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
};

export type ConsiderationItemJson = OfferItemJson & { recipient: string };

/** Seaport OrderComponents as JSON: uints as decimal strings, enums as numbers. `counter` is
 *  present (it is OrderComponents, not OrderParameters). */
export type OrderComponentsJson = {
  offerer: string;
  zone: string;
  offer: OfferItemJson[];
  consideration: ConsiderationItemJson[];
  orderType: number;
  startTime: string;
  endTime: string;
  zoneHash: string;
  salt: string;
  conduitKey: string;
  counter: string;
};

/**
 * One listing row as the fill page consumes it: the route (lib/keeperOrders.ts) builds it from
 * the keeper's /orders after checking it against the chain. Only the fields the fill path or the
 * check reads are required; the rest are display conveniences derived from the components.
 * `status` is `open` or `partial` (from Seaport's fill fraction); a finished order is never a row.
 */
export type ListingRow = {
  orderHash: Hex;
  status: string;
  components: OrderComponentsJson;
  /** Always `0x`: the vault pre-validates on Seaport and there is no key behind the order. */
  signature: Hex;
  chainId?: number;
  offerer?: string;
  optionId?: string;
  quantity?: string;
  remaining?: string;
  unitPrice6?: string;
  totalPrice6?: string;
  startTime?: string;
  endTime?: string;
  salt?: string;
  counter?: string;
  /**
   * The keeper's pricing report for this order (strike selection, market fair value, floor), as
   * served on /orders and passed through by lib/keeperOrders.ts only when
   * lib/cycleTerms.ts `keeperPricingFigures` accepts it. DISPLAY ONLY: keeper-reported, never read
   * by the hash, the listing check or the fill path. Parse it with `keeperPricingFigures` before use.
   */
  pricing?: Record<string, string | number | boolean | null> | null;
};

const DECIMAL = /^[0-9]+$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function isDecimalString(x: unknown): x is string {
  return typeof x === "string" && DECIMAL.test(x);
}
function isAddressString(x: unknown): x is string {
  return typeof x === "string" && ADDRESS.test(x);
}
function isBytes32String(x: unknown): x is string {
  return typeof x === "string" && BYTES32.test(x);
}
function isHexString(x: unknown): x is string {
  return typeof x === "string" && HEX.test(x);
}
/** Seaport enums are uint8 on the ABI; a float or a negative here would be a malformed row. */
function isSmallUint(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 255;
}
function isOptionalString(x: unknown): x is string | undefined {
  return x === undefined || typeof x === "string";
}
function isOptionalDecimalString(x: unknown): x is string | undefined {
  return x === undefined || isDecimalString(x);
}

function isOfferItem(x: unknown): x is OfferItemJson {
  return (
    isRecord(x) &&
    isSmallUint(x.itemType) &&
    isAddressString(x.token) &&
    isDecimalString(x.identifierOrCriteria) &&
    isDecimalString(x.startAmount) &&
    isDecimalString(x.endAmount)
  );
}

function isConsiderationItem(x: unknown): x is ConsiderationItemJson {
  return isOfferItem(x) && isAddressString((x as Record<string, unknown>).recipient);
}

/** Structural guard for OrderComponents. Every field the ABI needs must be present and parse;
 *  a missing or mistyped one would otherwise throw inside BigInt() mid-fill or, worse, encode
 *  as zero and produce a hash that is not the one the vault authorised. */
export function isOrderComponents(x: unknown): x is OrderComponentsJson {
  return (
    isRecord(x) &&
    isAddressString(x.offerer) &&
    isAddressString(x.zone) &&
    Array.isArray(x.offer) &&
    x.offer.every(isOfferItem) &&
    Array.isArray(x.consideration) &&
    x.consideration.every(isConsiderationItem) &&
    isSmallUint(x.orderType) &&
    isDecimalString(x.startTime) &&
    isDecimalString(x.endTime) &&
    isBytes32String(x.zoneHash) &&
    isDecimalString(x.salt) &&
    isBytes32String(x.conduitKey) &&
    isDecimalString(x.counter)
  );
}

/** Structural guard for one listing row. Unknown extra keys are allowed, so a new convenience
 *  field on the route's side cannot blank the page. */
export function isListingRow(x: unknown): x is ListingRow {
  if (!isRecord(x)) return false;
  if (!isBytes32String(x.orderHash)) return false;
  if (typeof x.status !== "string") return false;
  if (!isOrderComponents(x.components)) return false;
  if (!isHexString(x.signature)) return false;
  if (x.chainId !== undefined && !(typeof x.chainId === "number" && Number.isInteger(x.chainId) && x.chainId > 0)) {
    return false;
  }
  if (x.offerer !== undefined && !isAddressString(x.offerer)) return false;
  for (const key of ["optionId", "quantity", "remaining", "unitPrice6", "totalPrice6", "startTime", "endTime", "salt", "counter"] as const) {
    if (!isOptionalDecimalString(x[key])) return false;
  }
  return isOptionalString(x.offerer);
}

/*//////////////////////////////////////////////////////////////
                             THE CHECK
//////////////////////////////////////////////////////////////*/

export type ListingCheck = { ok: true } | { ok: false; reasons: string[] };

/** What the chain and this build say a listing of ours must look like. `listingHash` is the
 *  vault's own `listingHash()` slot: undefined when it has not been read, zero when the vault has
 *  nothing authorised. `vault` is undefined on a build with no NEXT_PUBLIC_VAULT.
 *
 *  `amount`, `grossUsdg` and `optionId` are the vault's `listingAmount()`, `listingGrossUsdg()`
 *  and `optionId()`, read in the same multicall as the hash. They are optional only because a
 *  caller may not have them; when present each is asserted, and the cycle page always passes
 *  them. A caller that omits them gets a hash-only check, which is weaker (see header).
 *  `conduitKey` is `vault.conduitKey()`; unread, the deploy default (zero) is expected. */
export type ExpectedListing = {
  vault: Address | undefined;
  usdg: Address;
  clearinghouse: Address;
  seaport: Address;
  listingHash: Hex | undefined;
  chainId?: number;
  amount?: bigint;
  grossUsdg?: bigint;
  optionId?: bigint;
  conduitKey?: Hex;
};

/** The reasons, as the UI prints them. Exported so tests assert the exact string, not a regex. */
export const REASONS = {
  noVault: "This build has no vault address configured, so nothing can be checked against it.",
  seller: "This listing's seller is not the vault.",
  zone: "This listing's Seaport zone is not the vault, so the vault's fill hook would never run and nothing would be written.",
  zoneHash: "This listing carries a zone hash; the vault's orders carry none.",
  conduit: "This listing names a Seaport conduit the vault did not; the buyer's approval goes to Seaport itself.",
  orderType: "This listing is not a partially fillable restricted (PARTIAL_RESTRICTED) order.",
  offerShape: "This listing does not offer exactly one ERC-1155 item.",
  offerToken: "The item on offer is not a clearinghouse option token.",
  considerationShape: "This listing does not ask for exactly one payment leg.",
  considerationToken: "The payment leg is not denominated in USDG.",
  writerRecipient: "The payment leg does not pay the vault.",
  notDivisible: "The price is not a whole multiple of the contract count, so Seaport could not fill a fraction of it.",
  amountsDrift: "An amount changes between the order's start and end, so the price is not fixed.",
  contractsZero: "This listing offers zero contracts.",
  hashUnread: "The vault's authorised order hash has not been read yet, so this listing cannot be checked against it.",
  hashNone: "The vault has no listing authorised on chain right now, so no order can be ours.",
  hashMismatch: "This listing's order hash is not the one the vault has authorised on chain.",
  componentsHash:
    "This listing's fields do not hash to its order hash, so a fill would not be the order the vault authorised.",
  expired: "This listing's end time has passed.",
  chain: "This listing is for a different chain.",
  offererMismatch: "The row's offerer does not match the order's offerer.",
  malformedAmount: "An amount or option id in this listing is not a whole number, so it cannot be checked.",
  amountMismatch: "This listing's contract count is not the one the vault authorised on chain.",
  grossMismatch: "This listing's total price is not the one the vault authorised on chain.",
  optionIdMismatch: "The option on offer is not the one the vault armed this cycle.",
} as const;

function sameAddress(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}
function sameHash(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}
function isZeroHash(h: string | undefined): boolean {
  return h !== undefined && /^0x0*$/.test(h);
}

/**
 * Is this listing the vault's own, in every field that a fill would spend against?
 *
 * All checks run and every failure is collected, so a tampered row reports everything wrong
 * with it rather than the first thing. `nowSeconds` is passed in: the lib never reads a clock.
 */
export function checkListingIsOurs(
  listing: { orderHash: string; chainId?: number; offerer?: string; components: OrderComponentsJson },
  expected: ExpectedListing,
  nowSeconds: number,
): ListingCheck {
  const reasons: string[] = [];
  const c = listing.components;

  // Seller swap: a listing from any other offerer would move the buyer's USDG to a stranger's
  // order. Without a configured vault there is nothing to compare against, which is a failure too.
  if (expected.vault === undefined) reasons.push(REASONS.noVault);
  else if (!sameAddress(c.offerer, expected.vault)) reasons.push(REASONS.seller);

  // Row/components disagreement: the top-level offerer is a convenience field; the one inside
  // components is what gets hashed. If they differ the row was edited after the hash was taken.
  if (listing.offerer !== undefined && !sameAddress(listing.offerer, c.offerer)) {
    reasons.push(REASONS.offererMismatch);
  }

  // The zone IS the vault. Seaport 1.6 calls the zone's `authorizeOrder` before any transfer of
  // a restricted order, and that hook is where the vault writes the filled contracts. Any other
  // zone is an order promising option tokens nobody mints.
  if (expected.vault !== undefined && !sameAddress(c.zone, expected.vault)) reasons.push(REASONS.zone);

  // The vault passes no data to itself through the zone hash.
  if (!sameHash(c.zoneHash, ZERO_HASH)) reasons.push(REASONS.zoneHash);

  // Conduit swap: the page approves USDG to Seaport itself; a conduit key the vault did not name
  // would have Seaport pull through a conduit the buyer never approved, or one an attacker controls.
  if (!sameHash(c.conduitKey, expected.conduitKey ?? ZERO_CONDUIT_KEY)) reasons.push(REASONS.conduit);

  // Order type: the fill sends numerator/denominator, and the write happens inside the zone
  // hook, so only PARTIAL_RESTRICTED is both fillable in fractions and routed through the vault.
  if (c.orderType !== ORDER_TYPE_PARTIAL_RESTRICTED) reasons.push(REASONS.orderType);

  // Offer shape and token: the buyer must receive a clearinghouse option ERC-1155 and nothing
  // else — not a lookalike token, not a bundle.
  const offer0 = c.offer[0];
  if (c.offer.length !== 1 || offer0 === undefined || offer0.itemType !== ITEM_TYPE_ERC1155) {
    reasons.push(REASONS.offerShape);
  } else if (!sameAddress(offer0.token, expected.clearinghouse)) {
    reasons.push(REASONS.offerToken);
  }

  // Consideration shape: exactly ONE leg, USDG, to the vault. A second leg is extra money leaving
  // the buyer; a different token is a leg the page's USDG approval was never meant to cover.
  const con0 = c.consideration[0];
  if (c.consideration.length !== 1 || con0 === undefined) {
    reasons.push(REASONS.considerationShape);
  } else {
    if (con0.itemType !== ITEM_TYPE_ERC20 || !sameAddress(con0.token, expected.usdg)) {
      reasons.push(REASONS.considerationToken);
    }
    // Recipient swap: the whole price would go to whoever edited the row.
    if (expected.vault !== undefined && !sameAddress(con0.recipient, expected.vault)) {
      reasons.push(REASONS.writerRecipient);
    }
  }

  // Price drift: Seaport interpolates between startAmount and endAmount over time. The page
  // quotes startAmount; an endAmount above it lets Seaport pull more than was shown.
  const allItems = [...c.offer, ...c.consideration];
  if (allItems.some((item) => item.startAmount !== item.endAmount)) reasons.push(REASONS.amountsDrift);

  // Malformed numbers: the check is total over its declared input, so a row that skipped the
  // route's shape gate reports a reason here rather than throwing inside BigInt() mid-render.
  const numbersParse =
    offer0 !== undefined &&
    con0 !== undefined &&
    DECIMAL.test(offer0.startAmount) &&
    DECIMAL.test(offer0.identifierOrCriteria) &&
    DECIMAL.test(con0.startAmount);
  if (offer0 !== undefined && con0 !== undefined && !numbersParse) {
    reasons.push(REASONS.malformedAmount);
  }

  if (numbersParse) {
    const n = BigInt(offer0.startAmount);
    const gross = BigInt(con0.startAmount);
    if (n === 0n) {
      reasons.push(REASONS.contractsZero);
    } else if (gross % n !== 0n) {
      // The vault enforces this at approveListing (PremiumNotDivisibleByOrderSize): a partial fill
      // pays gross × k / N, and Seaport reverts InexactFraction when that is not exact.
      reasons.push(REASONS.notDivisible);
    }

    // Size substitution: the vault recorded listingAmount at approveListing(); a row with our
    // hash but a different N would quote a different denominator than the order Seaport holds.
    if (expected.amount !== undefined && n !== expected.amount) reasons.push(REASONS.amountMismatch);

    // Price substitution: the vault recorded listingGrossUsdg (the one leg). A row that inflates
    // the leg is quoted, and approved, at the inflated price before Seaport ever recomputes the
    // hash and rejects it. The chain's number is the one the buyer is shown.
    if (expected.grossUsdg !== undefined && gross !== expected.grossUsdg) reasons.push(REASONS.grossMismatch);

    // Option substitution: a different identifierOrCriteria is a different ERC-1155 — another
    // strike, another expiry, or a token the clearinghouse minted for someone else.
    if (expected.optionId !== undefined && BigInt(offer0.identifierOrCriteria) !== expected.optionId) {
      reasons.push(REASONS.optionIdMismatch);
    }
  }

  // Hash substitution: the vault authorises exactly one order hash on chain. Anything else is
  // not ours, even if every other field looks right. An unread or empty slot is also a "no":
  // no button until the chain has said yes.
  if (expected.listingHash === undefined) reasons.push(REASONS.hashUnread);
  else if (isZeroHash(expected.listingHash)) reasons.push(REASONS.hashNone);
  else if (!sameHash(listing.orderHash, expected.listingHash)) reasons.push(REASONS.hashMismatch);

  // Component substitution: the hash string above is the row's claim. Seaport hashes the
  // components the fill sends, so those must hash to that string, or salt, counter, start time
  // and zone hash (which no field check above looks at) are not tied to the authorised order.
  if (!sameHash(componentsHash(c), listing.orderHash)) reasons.push(REASONS.componentsHash);

  // Stale order: a fill after endTime reverts, but the approve() before it would still stand.
  if (!DECIMAL.test(c.endTime) || BigInt(c.endTime) <= BigInt(Math.floor(nowSeconds))) {
    reasons.push(REASONS.expired);
  }

  // Wrong chain: an approval here for a fill that lives on another chain's Seaport.
  if (expected.chainId !== undefined && listing.chainId !== undefined && listing.chainId !== expected.chainId) {
    reasons.push(REASONS.chain);
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
