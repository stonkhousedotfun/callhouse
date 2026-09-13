// Seaport 1.6 — the slice this app needs to (a) show a listing's real on-chain status and
// (b) let a buyer fill our listing from this UI when Overcall's own book does not show it.
//
// The deployed 0x0000000000000068F116a894984e2DB1123eB395 on 4663 was byte-diffed against
// Ethereum mainnet Seaport 1.6 in ops/recon/R2-R9-seaport-order-shape.md: identical except
// the two immutables (chainId, domainSeparator). So the canonical ABI applies verbatim.
//
// WHY fulfillAdvancedOrder and not fulfillOrder: every Overcall listing is orderType 1
// (PARTIAL_OPEN). fulfillOrder takes the whole thing or nothing. fulfillAdvancedOrder carries
// numerator/denominator so a buyer can take k of N contracts — which only works because the
// listing's premium was rounded PER CONTRACT and is therefore an exact multiple of N.
// Rounding on the total instead makes Seaport revert with InexactFraction and silently turns
// a partial-open listing into full-fill-only. See splitPremium() in lib/format.ts.
const offerItem = {
  name: "offer",
  type: "tuple[]",
  components: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
} as const;

const considerationItem = {
  name: "consideration",
  type: "tuple[]",
  components: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
} as const;

/**
 * OrderParameters — what Seaport's fulfil path takes. Note the tail field is
 * `totalOriginalConsiderationItems` (always 2 for an Overcall listing: writer leg + 5% fee leg).
 */
const orderParameters = {
  name: "parameters",
  type: "tuple",
  components: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    offerItem,
    considerationItem,
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "totalOriginalConsiderationItems", type: "uint256" },
  ],
} as const;

/**
 * OrderComponents — what gets SIGNED, and what Overcall's API stores and returns. Identical to
 * OrderParameters except the tail field is `counter` instead of
 * `totalOriginalConsiderationItems`. Mixing the two up produces a different order hash.
 */
const orderComponents = {
  name: "order",
  type: "tuple",
  components: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    offerItem,
    considerationItem,
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
} as const;

export const seaportAbi = [
  {
    type: "function",
    name: "getCounter",
    stateMutability: "view",
    inputs: [{ name: "offerer", type: "address" }],
    outputs: [{ name: "counter", type: "uint256" }],
  },
  {
    type: "function",
    name: "getOrderHash",
    stateMutability: "view",
    inputs: [orderComponents],
    outputs: [{ name: "orderHash", type: "bytes32" }],
  },
  {
    type: "function",
    name: "getOrderStatus",
    stateMutability: "view",
    inputs: [{ name: "orderHash", type: "bytes32" }],
    outputs: [
      { name: "isValidated", type: "bool" },
      { name: "isCancelled", type: "bool" },
      { name: "totalFilled", type: "uint256" },
      { name: "totalSize", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "information",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "version", type: "string" },
      { name: "domainSeparator", type: "bytes32" },
      { name: "conduitController", type: "address" },
    ],
  },
  {
    type: "function",
    name: "fulfillAdvancedOrder",
    stateMutability: "payable",
    inputs: [
      {
        name: "advancedOrder",
        type: "tuple",
        components: [
          orderParameters,
          { name: "numerator", type: "uint120" },
          { name: "denominator", type: "uint120" },
          { name: "signature", type: "bytes" },
          { name: "extraData", type: "bytes" },
        ],
      },
      {
        name: "criteriaResolvers",
        type: "tuple[]",
        components: [
          { name: "orderIndex", type: "uint256" },
          { name: "side", type: "uint8" },
          { name: "index", type: "uint256" },
          { name: "identifier", type: "uint256" },
          { name: "criteriaProof", type: "bytes32[]" },
        ],
      },
      { name: "fulfillerConduitKey", type: "bytes32" },
      { name: "recipient", type: "address" },
    ],
    outputs: [{ name: "fulfilled", type: "bool" }],
  },
  {
    type: "event",
    name: "OrderFulfilled",
    inputs: [
      { name: "orderHash", type: "bytes32", indexed: false },
      { name: "offerer", type: "address", indexed: true },
      { name: "zone", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: false },
      {
        name: "offer",
        type: "tuple[]",
        indexed: false,
        components: [
          { name: "itemType", type: "uint8" },
          { name: "token", type: "address" },
          { name: "identifier", type: "uint256" },
          { name: "amount", type: "uint256" },
        ],
      },
      {
        name: "consideration",
        type: "tuple[]",
        indexed: false,
        components: [
          { name: "itemType", type: "uint8" },
          { name: "token", type: "address" },
          { name: "identifier", type: "uint256" },
          { name: "amount", type: "uint256" },
          { name: "recipient", type: "address" },
        ],
      },
    ],
  },
] as const;
