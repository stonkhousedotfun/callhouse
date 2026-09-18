/**
 * Seaport order construction, in exactly the shape the vault authorises.
 *
 * The shape is dictated by contracts/src/lib/SeaportOrderLib.sol, which checks every field at
 * `approveListing` and reverts on any other:
 *
 *   offerer    the vault
 *   zone       the vault — Seaport 1.6 calls the zone's `authorizeOrder` before it moves anything,
 *              and that hook is where the vault writes the filled contracts into Valorem
 *   zoneHash   0x0 | conduitKey vault.conduitKey() (0x0: Seaport pulls the ERC-1155 itself)
 *   orderType  3 (PARTIAL_RESTRICTED): restricted so every fill runs the hooks, partial so a
 *              buyer takes what they want and the rest stays offered
 *   startTime  0 | endTime the cycle's exerciseTimestamp (Friday close, NOT Saturday expiry)
 *   salt       a full random 256-bit value
 *   counter    read live from seaport.getCounter(vault); every kill bumps it quasi-randomly
 *   offer[0]          ERC1155, Valorem Clear, identifier = optionId, amount = N (≤ capacity),
 *                     tokens the vault does NOT yet hold — they are minted inside the fill
 *   consideration[0]  ERC20 USDG, N × unitPrice6, recipient = the vault. The ONLY item: no
 *                     venue fee, nobody else is paid.
 *
 * And the signature is EMPTY. The vault has no signing key and no EIP-1271 hook; `approveListing`
 * calls `seaport.validate()` and Seaport skips signature verification for a validated order on
 * every fill. /orders serves `"0x"` and any Seaport client fills with it.
 */
import { randomBytes } from 'node:crypto';
import { getAddress, hashStruct, hashTypedData, keccak256, concatHex, type Address, type Hex } from 'viem';
import { seaportAbi, vaultAbi } from './abi.js';
import { config, vaultAddress } from './config.js';
import { publicClient } from './clients.js';
import { log } from './logger.js';

/*//////////////////////////////////////////////////////////////
                            CONSTANTS
//////////////////////////////////////////////////////////////*/

export const ITEM_TYPE_ERC20 = 1;
export const ITEM_TYPE_ERC1155 = 3;
/** Seaport OrderType: FULL_OPEN 0, PARTIAL_OPEN 1, FULL_RESTRICTED 2, PARTIAL_RESTRICTED 3.
 *  The vault accepts 3 and nothing else (SeaportOrderLib `BadOrderType`). */
export const ORDER_TYPE_PARTIAL_RESTRICTED = 3;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
export const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

/** The signature every listing ships with. The vault pre-validates on Seaport; there is no key. */
export const EMPTY_SIGNATURE: Hex = '0x';

/*//////////////////////////////////////////////////////////////
                              TYPES
//////////////////////////////////////////////////////////////*/

export interface OfferItemStruct {
  itemType: number;
  token: Address;
  identifierOrCriteria: bigint;
  startAmount: bigint;
  endAmount: bigint;
}

export interface ConsiderationItemStruct extends OfferItemStruct {
  recipient: Address;
}

export interface OrderComponentsStruct {
  offerer: Address;
  zone: Address;
  offer: OfferItemStruct[];
  consideration: ConsiderationItemStruct[];
  orderType: number;
  startTime: bigint;
  endTime: bigint;
  zoneHash: Hex;
  salt: bigint;
  conduitKey: Hex;
  counter: bigint;
}

/** The wire form: every uint as a decimal string, and NO `totalOriginalConsiderationItems`
 *  (that field lives in OrderParameters, not OrderComponents). */
export interface OrderComponentsJson {
  offerer: string;
  zone: string;
  offer: Array<{
    itemType: number;
    token: string;
    identifierOrCriteria: string;
    startAmount: string;
    endAmount: string;
  }>;
  consideration: Array<{
    itemType: number;
    token: string;
    identifierOrCriteria: string;
    startAmount: string;
    endAmount: string;
    recipient: string;
  }>;
  orderType: number;
  startTime: string;
  endTime: string;
  zoneHash: string;
  salt: string;
  conduitKey: string;
  counter: string;
}

/*//////////////////////////////////////////////////////////////
                         ORDER BUILDING
//////////////////////////////////////////////////////////////*/

/** A full random 256-bit salt. Seaport's optional salt-prefix convention is not used here. */
export function randomSalt(): bigint {
  return BigInt(`0x${randomBytes(32).toString('hex')}`);
}

export interface BuildOrderInput {
  /** The vault. Offerer, zone and consideration recipient, all three. */
  vault: Address;
  optionId: bigint;
  /** The offer size. At most the vault's remaining capacity, or approveListing reverts
   *  `OfferExceedsCapacity`. */
  contracts: bigint;
  /** Per contract, USDG base units. The gross is `unitPrice6 × contracts`, so it divides by
   *  the size exactly and a partial fill of k pays k × unitPrice6 (`PremiumNotDivisibleByOrderSize`
   *  is impossible by construction). */
  unitPrice6: bigint;
  /** The cycle's exerciseTimestamp. */
  endTime: bigint;
  /** seaport.getCounter(vault), read live. */
  counter: bigint;
  salt?: bigint;
}

export function buildOrderComponents(input: BuildOrderInput): OrderComponentsStruct {
  if (input.unitPrice6 <= 0n) throw new Error('unitPrice6 must be positive');
  if (input.contracts <= 0n) throw new Error('contracts must be positive');
  const vault = getAddress(input.vault);
  const gross6 = input.unitPrice6 * input.contracts;

  log.seaport.debug(
    {
      optionId: input.optionId.toString(),
      contracts: input.contracts.toString(),
      unitPrice6: input.unitPrice6.toString(),
      gross6: gross6.toString(),
      counter: input.counter.toString(),
      endTime: input.endTime.toString(),
    },
    'order components built',
  );

  return {
    offerer: vault,
    zone: vault,
    offer: [
      {
        itemType: ITEM_TYPE_ERC1155,
        token: config.CLEARINGHOUSE,
        identifierOrCriteria: input.optionId,
        startAmount: input.contracts,
        endAmount: input.contracts,
      },
    ],
    consideration: [
      {
        itemType: ITEM_TYPE_ERC20,
        token: config.USDG,
        identifierOrCriteria: 0n,
        startAmount: gross6,
        endAmount: gross6,
        recipient: vault,
      },
    ],
    orderType: ORDER_TYPE_PARTIAL_RESTRICTED,
    startTime: 0n,
    endTime: input.endTime,
    zoneHash: ZERO_BYTES32,
    salt: input.salt ?? randomSalt(),
    conduitKey: config.SEAPORT_CONDUIT_KEY,
    counter: input.counter,
  };
}

/*//////////////////////////////////////////////////////////////
                          SERIALISATION
//////////////////////////////////////////////////////////////*/

export function componentsToJson(c: OrderComponentsStruct): OrderComponentsJson {
  return {
    offerer: c.offerer,
    zone: c.zone,
    offer: c.offer.map((item) => ({
      itemType: item.itemType,
      token: item.token,
      identifierOrCriteria: item.identifierOrCriteria.toString(),
      startAmount: item.startAmount.toString(),
      endAmount: item.endAmount.toString(),
    })),
    consideration: c.consideration.map((item) => ({
      itemType: item.itemType,
      token: item.token,
      identifierOrCriteria: item.identifierOrCriteria.toString(),
      startAmount: item.startAmount.toString(),
      endAmount: item.endAmount.toString(),
      recipient: item.recipient,
    })),
    orderType: c.orderType,
    startTime: c.startTime.toString(),
    endTime: c.endTime.toString(),
    zoneHash: c.zoneHash,
    salt: c.salt.toString(),
    conduitKey: c.conduitKey,
    counter: c.counter.toString(),
  };
}

/** Rehydrate components persisted in SQLite, for a restart-safe cancel or a served order. */
export function componentsFromJson(json: OrderComponentsJson): OrderComponentsStruct {
  return {
    offerer: getAddress(json.offerer),
    zone: getAddress(json.zone),
    offer: json.offer.map((item) => ({
      itemType: item.itemType,
      token: getAddress(item.token),
      identifierOrCriteria: BigInt(item.identifierOrCriteria),
      startAmount: BigInt(item.startAmount),
      endAmount: BigInt(item.endAmount),
    })),
    consideration: json.consideration.map((item) => ({
      itemType: item.itemType,
      token: getAddress(item.token),
      identifierOrCriteria: BigInt(item.identifierOrCriteria),
      startAmount: BigInt(item.startAmount),
      endAmount: BigInt(item.endAmount),
      recipient: getAddress(item.recipient),
    })),
    orderType: json.orderType,
    startTime: BigInt(json.startTime),
    endTime: BigInt(json.endTime),
    zoneHash: json.zoneHash as Hex,
    salt: BigInt(json.salt),
    conduitKey: json.conduitKey as Hex,
    counter: BigInt(json.counter),
  };
}

/**
 * OrderParameters for the fill page: the same fields with the counter dropped and
 * `totalOriginalConsiderationItems` appended. This is what a buyer passes to `fulfillOrder` /
 * `fulfillAdvancedOrder`, with `signature: "0x"`. The web page re-reads the counter from Seaport.
 */
export function toOrderParametersJson(c: OrderComponentsStruct): Omit<OrderComponentsJson, 'counter'> & {
  totalOriginalConsiderationItems: string;
} {
  const { counter: _counter, ...rest } = componentsToJson(c);
  return { ...rest, totalOriginalConsiderationItems: String(c.consideration.length) };
}

/*//////////////////////////////////////////////////////////////
                          CHAIN READS
//////////////////////////////////////////////////////////////*/

export async function readCounter(offerer: Address): Promise<bigint> {
  const counter = await publicClient.readContract({
    address: config.SEAPORT,
    abi: seaportAbi,
    functionName: 'getCounter',
    args: [offerer],
  });
  log.seaport.debug({ offerer, counter: counter.toString() }, 'seaport counter read');
  return counter;
}

/** Seaport's own hash for these components. Authoritative — this is what the vault records. */
export async function readOrderHash(c: OrderComponentsStruct): Promise<Hex> {
  const orderHash = await publicClient.readContract({
    address: config.SEAPORT,
    abi: seaportAbi,
    functionName: 'getOrderHash',
    args: [c],
  });
  log.seaport.debug({ orderHash }, 'order hash read');
  return orderHash;
}

export interface SeaportOrderStatus {
  isValidated: boolean;
  isCancelled: boolean;
  totalFilled: bigint;
  totalSize: bigint;
  /** True once the order can never be filled again. `totalSize == 0` means untouched, not full. */
  isFullyFilled: boolean;
}

export async function readOrderStatus(orderHash: Hex): Promise<SeaportOrderStatus> {
  const [isValidated, isCancelled, totalFilled, totalSize] = await publicClient.readContract({
    address: config.SEAPORT,
    abi: seaportAbi,
    functionName: 'getOrderStatus',
    args: [orderHash],
  });
  log.seaport.debug(
    { orderHash, isValidated, isCancelled, totalFilled: totalFilled.toString(), totalSize: totalSize.toString() },
    'order status read',
  );
  return {
    isValidated,
    isCancelled,
    totalFilled,
    totalSize,
    isFullyFilled: totalSize > 0n && totalFilled >= totalSize,
  };
}

/**
 * Contracts of a listing Seaport has filled so far: `contracts × totalFilled / totalSize`.
 * Seaport records the fill as a fraction of the order (a full `fulfillOrder` is 1/1, a
 * `fulfillAdvancedOrder` of 7 of 28 is 7/28 or its reduced form), so the count is the fraction
 * applied to the size. Exact for our orders: every fill of k moves k whole contracts.
 */
export function filledContracts(contracts: bigint, status: Pick<SeaportOrderStatus, 'totalFilled' | 'totalSize'>): bigint {
  if (status.totalSize === 0n) return 0n;
  return (contracts * status.totalFilled) / status.totalSize;
}

/** Seaport's EIP-712 domain separator, read live rather than derived. */
export async function readDomainSeparator(): Promise<Hex> {
  const [, domainSeparator] = await publicClient.readContract({
    address: config.SEAPORT,
    abi: seaportAbi,
    functionName: 'information',
  });
  log.seaport.debug({ domainSeparator }, 'domain separator read');
  return domainSeparator;
}

/*//////////////////////////////////////////////////////////////
                       LOCAL HASH CROSS-CHECK
//////////////////////////////////////////////////////////////*/

const SEAPORT_TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' },
    { name: 'zone', type: 'address' },
    { name: 'offer', type: 'OfferItem[]' },
    { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' },
    { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' },
    { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' },
    { name: 'conduitKey', type: 'bytes32' },
    { name: 'counter', type: 'uint256' },
  ],
  OfferItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
  ],
  ConsiderationItem: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ],
} as const;

function messageOf(c: OrderComponentsStruct) {
  return {
    offerer: c.offerer,
    zone: c.zone,
    offer: c.offer,
    consideration: c.consideration,
    orderType: c.orderType,
    startTime: c.startTime,
    endTime: c.endTime,
    zoneHash: c.zoneHash,
    salt: c.salt,
    conduitKey: c.conduitKey,
    counter: c.counter,
  };
}

/**
 * The order hash, derived locally.
 *
 * IMPORTANT AND EASY TO GET WRONG: Seaport's `getOrderHash` returns the EIP-712 STRUCT HASH,
 * not the signing digest. The digest is `keccak256(0x1901 ‖ domainSeparator ‖ structHash)` and
 * is what `hashTypedData` produces — feeding that to a comparison against `getOrderHash` looks
 * plausible and is always false. Verified against a real filled order on chain 4663:
 *   struct hash  0xa11edb6292fa1789a13419830d5bd1b5a0145954d3e8352bb6ff776ca67de522  <- this
 *   digest       0x82a7ecd0f5f5e41573f4ae76a957201ccc49465979da780585b259b011e82150
 *
 * Used as a cross-check against `readOrderHash` before spending gas on `approveListing`: if the
 * two disagree our struct encoding is wrong and the web fill page (which derives the same hash)
 * would refuse the order too.
 */
export function localOrderHash(c: OrderComponentsStruct): Hex {
  return hashStruct({ data: messageOf(c), primaryType: 'OrderComponents', types: SEAPORT_TYPES });
}

/**
 * The EIP-712 digest a signature would be made over. Nothing in the keeper depends on it — the
 * vault signs nothing — it exists so an operator debugging a refused fill can compute the same
 * number Seaport does.
 */
export function localOrderDigest(c: OrderComponentsStruct): Hex {
  return hashTypedData({
    domain: { name: 'Seaport', version: '1.6', chainId: config.CHAIN_ID, verifyingContract: config.SEAPORT },
    types: SEAPORT_TYPES,
    primaryType: 'OrderComponents',
    message: messageOf(c),
  });
}

/** The same digest built from Seaport's live domain separator, for cross-checking the domain
 *  itself rather than trusting the name/version pair. */
export function digestFromDomainSeparator(orderHash: Hex, domainSeparator: Hex): Hex {
  return keccak256(concatHex(['0x1901', domainSeparator, orderHash]));
}

/** The vault's view of the order it has authorised. */
export async function readVaultListing(): Promise<{
  hash: Hex;
  grossUsdg6: bigint;
  amount: bigint;
  listingsThisCycle: number;
}> {
  const [hash, grossUsdg6, amount, listingsThisCycle] = await Promise.all([
    publicClient.readContract({ address: vaultAddress(), abi: vaultAbi, functionName: 'listingHash' }),
    publicClient.readContract({ address: vaultAddress(), abi: vaultAbi, functionName: 'listingGrossUsdg' }),
    publicClient.readContract({ address: vaultAddress(), abi: vaultAbi, functionName: 'listingAmount' }),
    publicClient.readContract({ address: vaultAddress(), abi: vaultAbi, functionName: 'listingsThisCycle' }),
  ]);
  log.seaport.debug(
    { hash, grossUsdg6: grossUsdg6.toString(), amount: amount.toString(), listingsThisCycle },
    'vault listing read',
  );
  return { hash, grossUsdg6, amount, listingsThisCycle };
}
