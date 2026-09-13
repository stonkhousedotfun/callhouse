import type { Address, Hex } from "viem";

import { OVERCALL_FEE_BPS, OVERCALL_FEE_RECIPIENT, ZERO_ADDRESS, ZERO_HASH } from "./contracts";
import { componentsHash } from "./seaportOrder";

/**
 * Guards for Overcall's listing JSON, and the check that a listing is OURS before a buyer's
 * USDG goes anywhere near it.
 *
 * WHY: /api/overcall/listings is a passthrough from overcall.finance. Every field in it — the
 * offerer, both recipients, both tokens, every amount — is a third party's database row. Until
 * this file existed, OrderPayload copied those fields straight into fulfillAdvancedOrder right
 * after approve(SEAPORT, cost), so a tampered or merely wrong row would have spent the buyer's
 * USDG on a different seller, to a different recipient, or in a different token. The vault's
 * on-chain `listingHash` is the authoritative fact about which order is ours, and the vault
 * records three more facts about it at approveListing(): `listingAmount` (the contract count),
 * `listingGrossUsdg` (both payment legs summed) and `optionId` (the ERC-1155 id on offer).
 * Everything Overcall serves is checked against all four and against the addresses compiled into
 * contracts.ts. The hash string alone is not enough: Overcall's `orderHash` is their string, and
 * a row that keeps our hash but carries components at ten times the price would still be quoted,
 * and approved, at that price before Seaport ever recomputed the hash. Pinning the amounts to the
 * chain closes that. So does the second half: the components are hashed here, locally, with
 * Seaport's own EIP-712 derivation (lib/seaportOrder.ts), and must hash to the row's orderHash.
 * Without it a row could carry our hash and our amounts but a different salt, counter, start time
 * or zone hash, pass every field check, and revert at fulfilment after the buyer's approve(),
 * because Seaport would hash the edited components to a hash the vault never authorised. EIP-1271
 * would reject that at fill time, but that backstop has never been exercised against Overcall's
 * live server and the approve() before it has already happened.
 *
 * DELIBERATELY ABSENT: React, fetch, Date.now(), zod, a chain client. Pure functions over `unknown`, so the
 * proxy route and the component share one definition of "well-formed" and one of "ours", and
 * so the whole thing runs under vitest with fixtures. The keeper carries the same shape in zod
 * (keeper/src/overcallApi.ts, keeper/src/seaport.ts); the field list below mirrors it.
 */

/*//////////////////////////////////////////////////////////////
                              SHAPE
//////////////////////////////////////////////////////////////*/

/** Seaport ItemType. Overcall lists an ERC-1155 option and asks for ERC-20 USDG, nothing else. */
export const ITEM_TYPE_ERC20 = 1;
export const ITEM_TYPE_ERC1155 = 3;
/** PARTIAL_OPEN. Every Overcall listing is orderType 1; the fill path relies on it. */
export const ORDER_TYPE_PARTIAL_OPEN = 1;

export type OfferItemJson = {
  itemType: number;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
};

export type ConsiderationItemJson = OfferItemJson & { recipient: string };

/** Seaport OrderComponents as Overcall serialises them: uints as decimal strings, enums as
 *  numbers. `counter` is present (it is OrderComponents, not OrderParameters). */
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
 * One row of Overcall's book. Only the fields the fill path or the check reads are required;
 * the rest are optional and typed loosely, exactly as the keeper's zod schema treats them.
 * There is no `market` field in their rows (ops/recon/R3-overcall-api.md §5.3), so none is
 * required here; if one appears it must at least be a string.
 */
export type OvercallListing = {
  orderHash: Hex;
  status: string;
  components: OrderComponentsJson;
  signature: Hex;
  chainId?: number;
  market?: string;
  offerer?: string;
  optionId?: string;
  quantity?: string;
  remaining?: string;
  unitPrice6?: string;
  totalPrice6?: string;
  realisedPremium6?: string;
  startTime?: string;
  endTime?: string;
  salt?: string;
  counter?: string;
  filledNumerator?: string;
  filledDenominator?: string;
  createdAt?: string;
  checkedAt?: string;
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

/** Structural guard for one book row. Unknown extra keys are allowed — Overcall adds fields
 *  (checkedAt, realisedPremium6) without notice and a new key must not blank the book. */
export function isOvercallListing(x: unknown): x is OvercallListing {
  if (!isRecord(x)) return false;
  if (!isBytes32String(x.orderHash)) return false;
  if (typeof x.status !== "string") return false;
  if (!isOrderComponents(x.components)) return false;
  if (!isHexString(x.signature)) return false;
  if (x.chainId !== undefined && !(typeof x.chainId === "number" && Number.isInteger(x.chainId) && x.chainId > 0)) {
    return false;
  }
  if (!isOptionalString(x.market)) return false;
  if (x.offerer !== undefined && !isAddressString(x.offerer)) return false;
  for (const key of [
    "optionId",
    "quantity",
    "remaining",
    "unitPrice6",
    "totalPrice6",
    "realisedPremium6",
    "startTime",
    "endTime",
    "salt",
    "counter",
    "filledNumerator",
    "filledDenominator",
  ] as const) {
    if (!isOptionalDecimalString(x[key])) return false;
  }
  return isOptionalString(x.createdAt) && isOptionalString(x.checkedAt);
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
 *  them. A caller that omits them gets a hash-only check, which is weaker (see header). */
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
};

/** The reasons, as the UI prints them. Exported so tests assert the exact string, not a regex. */
export const REASONS = {
  noVault: "This build has no vault address configured, so nothing can be checked against it.",
  seller: "This listing's seller is not the vault.",
  zone: "This listing names a Seaport zone; the vault's orders have none.",
  conduit: "This listing uses a Seaport conduit; the vault's orders pull through Seaport itself.",
  orderType: "This listing is not a partially fillable (PARTIAL_OPEN) order.",
  offerShape: "This listing does not offer exactly one ERC-1155 item.",
  offerToken: "The item on offer is not a clearinghouse option token.",
  considerationShape: "This listing does not ask for exactly two payment legs.",
  considerationToken: "A payment leg is not denominated in USDG.",
  writerRecipient: "The premium leg does not pay the vault.",
  feeRecipient: "The fee leg does not pay Overcall's fee recipient.",
  feeSplit: "The fee leg is not Overcall's 5% of the premium, rounded per contract.",
  amountsDrift: "An amount changes between the order's start and end, so the price is not fixed.",
  contractsZero: "This listing offers zero contracts.",
  hashUnread: "The vault's authorised order hash has not been read yet, so this listing cannot be checked against it.",
  hashNone: "The vault has no listing authorised on chain right now, so nothing on Overcall's book can be ours.",
  hashMismatch: "This listing's order hash is not the one the vault has authorised on chain.",
  componentsHash:
    "This listing's signed fields do not hash to its order hash, so a fill would not be the order the vault authorised.",
  expired: "This listing's end time has passed.",
  chain: "This listing is for a different chain.",
  offererMismatch: "The row's offerer does not match the signed order's offerer.",
  malformedAmount: "An amount or option id in this listing is not a whole number, so it cannot be checked.",
  amountMismatch: "This listing's contract count is not the one the vault authorised on chain.",
  grossMismatch: "This listing's total price is not the one the vault authorised on chain.",
  optionIdMismatch: "The option on offer is not the one the vault wrote this cycle.",
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

  // Row/components disagreement: the top-level offerer is what the book filters on; the one
  // inside components is what gets hashed. If they differ the row was edited after signing.
  if (listing.offerer !== undefined && !sameAddress(listing.offerer, c.offerer)) {
    reasons.push(REASONS.offererMismatch);
  }

  // Zone injection: a non-zero zone can restrict or redirect fulfilment through a contract we
  // never audited. README: zone 0x0.
  if (!sameAddress(c.zone, ZERO_ADDRESS)) reasons.push(REASONS.zone);

  // Conduit swap: the page approves USDG to Seaport itself; a conduit key would have Seaport
  // pull through a conduit the buyer never approved, or one an attacker controls. README: conduit 0x0.
  if (!sameHash(c.conduitKey, ZERO_HASH)) reasons.push(REASONS.conduit);

  // Order type: the fill sends numerator/denominator; anything but PARTIAL_OPEN either reverts
  // or is a restricted order with a zone in the loop.
  if (c.orderType !== ORDER_TYPE_PARTIAL_OPEN) reasons.push(REASONS.orderType);

  // Offer shape and token: the buyer must receive a clearinghouse option ERC-1155 and nothing
  // else — not a lookalike token, not a bundle.
  const offer0 = c.offer[0];
  if (c.offer.length !== 1 || offer0 === undefined || offer0.itemType !== ITEM_TYPE_ERC1155) {
    reasons.push(REASONS.offerShape);
  } else if (!sameAddress(offer0.token, expected.clearinghouse)) {
    reasons.push(REASONS.offerToken);
  }

  // Consideration shape: exactly two legs, both USDG. A third leg is extra money leaving the
  // buyer; a different token is a leg the page's USDG approval was never meant to cover.
  const [con0, con1] = c.consideration;
  if (c.consideration.length !== 2 || con0 === undefined || con1 === undefined) {
    reasons.push(REASONS.considerationShape);
  } else {
    if (
      con0.itemType !== ITEM_TYPE_ERC20 ||
      con1.itemType !== ITEM_TYPE_ERC20 ||
      !sameAddress(con0.token, expected.usdg) ||
      !sameAddress(con1.token, expected.usdg)
    ) {
      reasons.push(REASONS.considerationToken);
    }
    // Recipient swap on the premium leg: 95% of the price would go to whoever edited the row.
    if (expected.vault !== undefined && !sameAddress(con0.recipient, expected.vault)) {
      reasons.push(REASONS.writerRecipient);
    }
    // Recipient swap on the fee leg: the 5% goes somewhere other than Overcall.
    if (!sameAddress(con1.recipient, OVERCALL_FEE_RECIPIENT)) reasons.push(REASONS.feeRecipient);
  }

  // Price drift: Seaport interpolates between startAmount and endAmount over time. The page
  // quotes startAmount; an endAmount above it lets Seaport pull more than was shown.
  const allItems = [...c.offer, ...c.consideration];
  if (allItems.some((item) => item.startAmount !== item.endAmount)) reasons.push(REASONS.amountsDrift);

  // Malformed numbers: the check is total over its declared input, so a row that skipped the
  // proxy's shape gate reports a reason here rather than throwing inside BigInt() mid-render.
  const numbersParse =
    offer0 !== undefined &&
    con0 !== undefined &&
    con1 !== undefined &&
    DECIMAL.test(offer0.startAmount) &&
    DECIMAL.test(offer0.identifierOrCriteria) &&
    DECIMAL.test(con0.startAmount) &&
    DECIMAL.test(con1.startAmount);
  if (offer0 !== undefined && con0 !== undefined && con1 !== undefined && !numbersParse) {
    reasons.push(REASONS.malformedAmount);
  }

  // Fee split, exact. keeper/src/seaport.ts splitPremium(): feePerContract = floor(unit * 500 /
  // 10000), consideration[1] = feePerContract * N, consideration[0] = (unit - feePerContract) * N,
  // with N = offer[0].startAmount. A leg that is not that multiple is either a fee skimmed off
  // the premium or an order Seaport cannot partially fill (InexactFraction).
  if (numbersParse) {
    const n = BigInt(offer0.startAmount);
    const writerLeg = BigInt(con0.startAmount);
    const feeLeg = BigInt(con1.startAmount);
    const gross = writerLeg + feeLeg;
    if (n === 0n) {
      reasons.push(REASONS.contractsZero);
    } else if (gross % n !== 0n) {
      reasons.push(REASONS.feeSplit);
    } else {
      const unit = gross / n;
      const feePerContract = (unit * OVERCALL_FEE_BPS) / 10_000n;
      if (feeLeg !== feePerContract * n || writerLeg !== (unit - feePerContract) * n) {
        reasons.push(REASONS.feeSplit);
      }
    }

    // Size substitution: the vault recorded listingAmount at approveListing(); a row with our
    // hash but a different N would quote a different denominator than the order Seaport holds.
    if (expected.amount !== undefined && n !== expected.amount) reasons.push(REASONS.amountMismatch);

    // Price substitution: the vault recorded listingGrossUsdg (both legs summed). A row that
    // inflates the legs is quoted, and approved, at the inflated price before Seaport ever
    // recomputes the hash and rejects it. The chain's number is the one the buyer is shown.
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
