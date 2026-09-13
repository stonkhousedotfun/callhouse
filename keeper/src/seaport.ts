/**
 * Seaport order construction, in exactly the shape Overcall uses.
 *
 * The shape below is not a design; it is a transcription. It was decoded from the one real
 * filled order on chain 4663 (tx 0x013cd30b..., orderHash 0xa11edb62...) and cross-checked
 * against Overcall's live API and their client bundle's `buildListing`. See
 * ops/recon/R2-R9-seaport-order-shape.md and ops/recon/sample-overcall-order.json.
 *
 *   zone       0x0 | zoneHash 0x0 | orderType 1 (PARTIAL_OPEN) | startTime 0
 *   endTime    the option's exerciseTimestamp — Friday book close, NOT Saturday expiry
 *   salt       a full random 256-bit value, no domain prefix
 *   conduitKey 0x0 — Seaport pulls the ERC-1155 itself, so the approval goes to SEAPORT
 *   counter    read live from seaport.getCounter(vault)
 *   offer[0]          ERC1155, Valorem Clear, identifier = optionId, amount = contracts
 *   consideration[0]  ERC20 USDG, writer's leg, recipient = the vault (the offerer)
 *   consideration[1]  ERC20 USDG, Overcall's 5%, recipient = OVERCALL_FEE_RECIPIENT
 *
 * Do not invent a variant. A second shape is an order Overcall's book will not show.
 */
import { randomBytes } from 'node:crypto';
import { getAddress, hashStruct, hashTypedData, keccak256, concatHex, type Address, type Hex } from 'viem';
import { seaportAbi, vaultAbi } from './abi.js';
import { BPS, config } from './config.js';
import { publicClient } from './clients.js';
import { log } from './logger.js';

/*//////////////////////////////////////////////////////////////
                            CONSTANTS
//////////////////////////////////////////////////////////////*/

export const ITEM_TYPE_ERC20 = 1;
export const ITEM_TYPE_ERC1155 = 3;
/** PARTIAL_OPEN. Overcall's schema hard-requires this literal; every listing is partially
 *  fillable, which is why the fee rounding below matters so much. */
export const ORDER_TYPE_PARTIAL_OPEN = 1;
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
export const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;

/** Overcall's cut, in bps. Sourced from their bundle: NEXT_PUBLIC_FEE_BPS = "500", ceiling 1000. */
export const OVERCALL_FEE_BPS = 500n;

/**
 * The smallest per-contract ask whose 5% does not floor to zero. 10000/500 = 20 USDG base
 * units. Below this, `feePerContract6` is 0, Overcall's schema rejects the zero-amount
 * consideration item, and the listing never reaches a buyer.
 */
export const MIN_LISTABLE_UNIT_PRICE_6 = BPS / OVERCALL_FEE_BPS;

/**
 * A 65-byte placeholder signature.
 *
 * WHY A PLACEHOLDER IS THE CORRECT ANSWER HERE, not a shortcut:
 *
 * The vault is the Seaport offerer and authorises an order by HASH, on chain, inside
 * `approveListing()` — which calls `seaport.validate()` and records `listingHash`. Its
 * `isValidSignature(digest, bytes)` deliberately ignores the signature bytes and answers
 * `0x1626ba7e` for the authorised hash (and for its EIP-712 digest). There is no key that
 * signs anything; the keeper never holds the option tokens and cannot produce an ECDSA
 * signature that recovers to the vault, because the vault is a contract.
 *
 * But Overcall's zod schema still demands `/^0x([0-9a-f]{128}|[0-9a-f]{130})$/` — exactly 64
 * or 65 bytes — before any on-chain check runs, and their validator's step 8 verifies the
 * signature "for offerer (EOA or ERC-1271)", which for us routes into `isValidSignature`.
 * So the field must be present and well-formed, and its contents are irrelevant. This is a
 * well-formed 65-byte value with v = 0x1b so nothing chokes parsing it as (r, s, v).
 */
export const PLACEHOLDER_SIGNATURE: Hex = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;

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

/** The wire form Overcall accepts: every uint as a decimal string, and NO
 *  `totalOriginalConsiderationItems` (that field lives in OrderParameters, not
 *  OrderComponents). Mirrors their `componentsToJson`. */
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

export interface PremiumSplit {
  /** consideration[0].startAmount — the vault's leg. */
  toVault6: bigint;
  /** consideration[1].startAmount — Overcall's 5%. */
  toOvercall6: bigint;
  /** What a full fill costs the buyer. Always exactly unitPrice6 * contracts. */
  gross6: bigint;
  feePerContract6: bigint;
  writerPerContract6: bigint;
}

/*//////////////////////////////////////////////////////////////
                        THE FEE ROUNDING
//////////////////////////////////////////////////////////////*/

/**
 * Split a per-contract ask into the two consideration amounts.
 *
 * *** ROUND PER CONTRACT, THEN MULTIPLY. THIS IS NOT A STYLE CHOICE. ***
 *
 *   feePerContract6    = floor(unitPrice6 * 500 / 10000)
 *   writerPerContract6 = unitPrice6 - feePerContract6
 *   consideration[1]   = feePerContract6    * N
 *   consideration[0]   = writerPerContract6 * N
 *
 * Rounding on the total instead produces an order that signs, passes Overcall's schema, and
 * passes `seaport.validate()` — and that Seaport then refuses to partially fill with
 * `InexactFraction`, because it scales every consideration item by the fill fraction and each
 * amount must divide evenly by the order size. Since every Overcall listing is PARTIAL_OPEN,
 * a total-rounded fee quietly turns the listing into full-fill-only, which on a 20-contract
 * listing means nobody fills it at all.
 *
 * contracts/src/Policy.sol `splitPremium()` implements exactly this, and
 * SeaportOrderLib re-derives it on chain and reverts `BadFeeSplit` on any disagreement, so a
 * mismatch here fails loudly at `approveListing` rather than silently on Friday.
 */
export function splitPremium(unitPrice6: bigint, contracts: bigint): PremiumSplit {
  if (unitPrice6 <= 0n) throw new Error('unitPrice6 must be positive');
  if (contracts <= 0n) throw new Error('contracts must be positive');

  const feePerContract6 = (unitPrice6 * OVERCALL_FEE_BPS) / BPS;
  if (feePerContract6 === 0n) {
    throw new Error(
      `unitPrice6 ${unitPrice6} is below ${MIN_LISTABLE_UNIT_PRICE_6}: the 5% fee floors to zero ` +
        "and Overcall's schema rejects a zero-amount consideration item",
    );
  }
  const writerPerContract6 = unitPrice6 - feePerContract6;

  return {
    feePerContract6,
    writerPerContract6,
    toOvercall6: feePerContract6 * contracts,
    toVault6: writerPerContract6 * contracts,
    gross6: unitPrice6 * contracts,
  };
}

/*//////////////////////////////////////////////////////////////
                         ORDER BUILDING
//////////////////////////////////////////////////////////////*/

/** A full random 256-bit salt. Overcall's client uses 32 crypto-random bytes with no domain
 *  prefix; Seaport's optional salt-prefix convention is not used on this chain. */
export function randomSalt(): bigint {
  return BigInt(`0x${randomBytes(32).toString('hex')}`);
}

export interface BuildOrderInput {
  /** The vault. Offerer and consideration[0] recipient — Overcall's schema refines that the
   *  premium is paid to the offerer. */
  offerer: Address;
  optionId: bigint;
  contracts: bigint;
  unitPrice6: bigint;
  /** The option's exerciseTimestamp, read from the registry. Friday 20:00 UTC. */
  endTime: bigint;
  /** seaport.getCounter(offerer), read live. A cancel-all bumps it by a quasi-random amount. */
  counter: bigint;
  salt?: bigint;
}

export function buildOrderComponents(input: BuildOrderInput): OrderComponentsStruct {
  const { toVault6, toOvercall6, feePerContract6 } = splitPremium(input.unitPrice6, input.contracts);

  log.seaport.debug(
    {
      optionId: input.optionId.toString(),
      contracts: input.contracts.toString(),
      unitPrice6: input.unitPrice6.toString(),
      feePerContract6: feePerContract6.toString(),
      toVault6: toVault6.toString(),
      toOvercall6: toOvercall6.toString(),
      counter: input.counter.toString(),
      endTime: input.endTime.toString(),
    },
    'order components built',
  );

  return {
    offerer: getAddress(input.offerer),
    zone: config.SEAPORT_ZONE,
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
        startAmount: toVault6,
        endAmount: toVault6,
        recipient: getAddress(input.offerer),
      },
      {
        itemType: ITEM_TYPE_ERC20,
        token: config.USDG,
        identifierOrCriteria: 0n,
        startAmount: toOvercall6,
        endAmount: toOvercall6,
        recipient: config.OVERCALL_FEE_RECIPIENT,
      },
    ],
    orderType: ORDER_TYPE_PARTIAL_OPEN,
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

/** Rehydrate components persisted in SQLite, for a restart-safe cancel or repost. */
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
 * OrderParameters for the self-hosted fallback buy page: the same fields with the counter
 * dropped and `totalOriginalConsiderationItems` appended. This is what a buyer passes to
 * `fulfillOrder` / `fulfillAdvancedOrder` straight from our UI when Overcall's book is down.
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
 * plausible and is always false. Verified against the real filled order on chain 4663:
 *   struct hash  0xa11edb6292fa1789a13419830d5bd1b5a0145954d3e8352bb6ff776ca67de522  <- this
 *   digest       0x82a7ecd0f5f5e41573f4ae76a957201ccc49465979da780585b259b011e82150
 *
 * Used as a cross-check against `readOrderHash`. If the two disagree, our struct encoding is
 * wrong and the order must not be published: Overcall's validator does the same comparison at
 * their step 7 and answers 500. Catching it here costs one keccak instead of a wasted
 * `approveListing` transaction.
 */
export function localOrderHash(c: OrderComponentsStruct): Hex {
  return hashStruct({ data: messageOf(c), primaryType: 'OrderComponents', types: SEAPORT_TYPES });
}

/**
 * The EIP-712 digest a filler's signature check would be run against.
 *
 * The vault's `isValidSignature` answers for BOTH the raw order hash and this digest, so
 * nothing in the keeper depends on it — it exists so the dry run and an operator debugging a
 * rejected listing can compute the same number Seaport does.
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
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'listingHash' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'listingGrossUsdg' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'listingAmount' }),
    publicClient.readContract({ address: config.VAULT, abi: vaultAbi, functionName: 'listingsThisCycle' }),
  ]);
  log.seaport.debug(
    { hash, grossUsdg6: grossUsdg6.toString(), amount: amount.toString(), listingsThisCycle },
    'vault listing read',
  );
  return { hash, grossUsdg6, amount, listingsThisCycle };
}
