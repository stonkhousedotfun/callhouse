import { getAddress, hashStruct, type Address, type Hex } from "viem";

import type { OrderComponentsJson } from "./listing";

/**
 * Seaport facts derived locally and purely: the EIP-712 order hash of a set of OrderComponents,
 * the AdvancedOrder a fill of k out of N sends, and what a Seaport getOrderStatus reading means
 * for a listing of N contracts.
 *
 * WHY THIS FILE EXISTS: an order hash string from the keeper's feed is only a claim. The hash the
 * vault authorised (listingHash) is bound to the order a buyer's fill will send only if the
 * components themselves hash to it. checkListingIsOurs (lib/listing.ts) runs that derivation on
 * every row before a fill button exists; the route (lib/keeperOrders.ts) runs it too and then
 * asks Seaport for the same hash as a cross-check. And the struct the fill sends is built HERE,
 * once, so the pre-flight simulation and the real transaction cannot drift apart.
 *
 * DELIBERATELY ABSENT: React, fetch, a clock, a chain client. Imports only types from
 * lib/listing.ts, so listing.ts can import this file without a cycle at runtime.
 */

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

/** OrderParameters: OrderComponents with the consideration count where the counter was. */
export type OrderParametersStruct = Omit<OrderComponentsStruct, "counter"> & { totalOriginalConsiderationItems: bigint };

/** The `advancedOrder` argument of Seaport.fulfillAdvancedOrder. */
export type AdvancedOrderStruct = {
  parameters: OrderParametersStruct;
  numerator: bigint;
  denominator: bigint;
  signature: Hex;
  extraData: Hex;
};

/** Case is not meaning: an address is 20 bytes, and a row that mis-checksums one must not make
 *  viem throw mid-check. The bytes are what Seaport hashes. */
export function addr(value: string): Address {
  return getAddress(value.toLowerCase());
}

/** The ABI struct for Seaport.getOrderHash, and the input to seaportOrderHash. Throws on a field
 *  that does not parse (an address that is not 20 bytes, an amount that is not an integer). */
export function componentsStruct(c: OrderComponentsJson): OrderComponentsStruct {
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
    zoneHash: c.zoneHash as Hex,
    salt: BigInt(c.salt),
    conduitKey: c.conduitKey as Hex,
    counter: BigInt(c.counter),
  };
}

/**
 * OrderComponents → OrderParameters. `totalOriginalConsiderationItems` is the consideration
 * length (SeaportOrderLib.toParameters does the same); a different value makes Seaport derive a
 * different order hash and refuse the fill.
 */
export function toOrderParameters(c: OrderComponentsStruct): OrderParametersStruct {
  const { counter: _counter, ...rest } = c;
  return { ...rest, totalOriginalConsiderationItems: BigInt(c.consideration.length) };
}

/**
 * The fill of `numerator` out of `denominator` contracts, as Seaport.fulfillAdvancedOrder takes it.
 *
 * The signature is ALWAYS empty. The vault has no signing key: it authorises the order by
 * `seaport.validate()` inside approveListing, and Seaport skips signature verification for a
 * validated order (OrderValidator.sol). Whatever bytes a feed carries in its `signature` field are
 * meaningless and are not sent. `extraData` is empty too: the vault's zone hooks read nothing
 * from it.
 */
export function advancedOrderFor(c: OrderComponentsJson, numerator: bigint, denominator: bigint): AdvancedOrderStruct {
  return {
    parameters: toOrderParameters(componentsStruct(c)),
    numerator,
    denominator,
    signature: "0x",
    extraData: "0x",
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
 * what Seaport.getOrderHash returns and what the vault records as listingHash (the keeper's
 * localOrderHash is the same derivation). The fork acceptance asserts the three agree on chain.
 * Lowercase, so it compares with `===` against other lowercased hashes.
 */
export function seaportOrderHash(c: OrderComponentsStruct): Hex {
  return hashStruct({ data: c, primaryType: "OrderComponents", types: SEAPORT_TYPES }).toLowerCase() as Hex;
}

/** The order hash a JSON components object commits to, or undefined when a field does not parse. */
export function componentsHash(c: OrderComponentsJson): Hex | undefined {
  try {
    return seaportOrderHash(componentsStruct(c));
  } catch {
    return undefined;
  }
}

/*//////////////////////////////////////////////////////////////
                          SEAPORT STATUS
//////////////////////////////////////////////////////////////*/

/** The part of Seaport.getOrderStatus these checks read. */
export type SeaportFillStatus = { isCancelled: boolean; totalFilled: bigint; totalSize: bigint };

/** Every contract sold, or the order cancelled: nothing is left to fill, and that is not a fault. */
export function seaportSoldOut(status: SeaportFillStatus): boolean {
  return status.totalSize > 0n && status.totalFilled >= status.totalSize;
}

export function seaportFinished(status: SeaportFillStatus | undefined): boolean {
  return status !== undefined && (status.isCancelled || seaportSoldOut(status));
}

/**
 * Contracts still fillable out of `total`, per Seaport. Seaport stores the filled fraction reduced
 * (5 of 20 is 1/4), so the count sold is totalFilled * total / totalSize; 0/0 is untouched.
 * Undefined when there is no reading or no total to scale it by.
 */
export function seaportRemaining(total: bigint | undefined, status: SeaportFillStatus | undefined): bigint | undefined {
  if (status === undefined || total === undefined) return undefined;
  if (status.isCancelled) return 0n;
  if (status.totalSize === 0n || total === 0n) return total;
  const sold = (status.totalFilled * total) / status.totalSize;
  return sold >= total ? 0n : total - sold;
}

/**
 * How many contracts a fill card may offer. Seaport's count wins whenever the card's row carries
 * the hash Seaport's status was read for: a row that says `remaining: "0"` (a stale feed is
 * enough) for an order Seaport still holds open must not disable the only fill button on the
 * page, and a row claiming more than Seaport has left must not be quoted. Without a reading for
 * this hash, the row's own figure is used, capped at the total.
 */
export function fillableContracts(
  row: { orderHash: string; remaining?: string },
  total: bigint,
  statusHash: string | undefined,
  status: SeaportFillStatus | undefined,
): bigint {
  const sameHash = statusHash !== undefined && row.orderHash.toLowerCase() === statusHash.toLowerCase();
  const chain = sameHash ? seaportRemaining(total, status) : undefined;
  if (chain !== undefined) return chain;
  const claimed = /^[0-9]+$/.test(row.remaining ?? "") ? BigInt(row.remaining!) : total;
  return claimed > total ? total : claimed;
}
