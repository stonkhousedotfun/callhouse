// Seaport 1.6 — the slice this app needs to (a) show a listing's real on-chain status, (b) let a
// buyer fill the vault's listing from this UI, and (c) name what a failed fill simulation
// reverted with.
//
// The deployed 0x0000000000000068F116a894984e2DB1123eB395 on 4663 was byte-diffed against
// Ethereum mainnet Seaport 1.6 in ops/recon/R2-R9-seaport-order-shape.md: identical except
// the two immutables (chainId, domainSeparator). So the canonical ABI applies verbatim.
//
// THE ORDER SHAPE. Every listing of the vault's is orderType 3 (PARTIAL_RESTRICTED) with the
// vault as offerer AND zone. Restricted, so Seaport calls the vault's `authorizeOrder` before it
// moves anything (that hook writes exactly the filled contracts into Valorem) and `validateOrder`
// after; partial, so a buyer takes k of N and the rest stays offered. The vault pre-validates the
// order on chain (`seaport.validate`), so the signature is EMPTY and Seaport skips verification.
//
// WHY fulfillAdvancedOrder and not fulfillOrder: fulfillOrder takes the whole thing or nothing.
// fulfillAdvancedOrder carries numerator/denominator so a buyer can take k of N contracts, which
// works because the listing's gross is an exact multiple of N (the vault enforces
// `gross % amount == 0` at approveListing); a fraction Seaport cannot express exactly reverts
// with InexactFraction.
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
 * `totalOriginalConsiderationItems` (always 1 for a vault listing: the one USDG leg to the vault).
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
 * OrderComponents — what gets HASHED (and what the keeper's /orders is rebuilt into). Identical
 * to OrderParameters except the tail field is `counter` instead of
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
  // Seaport's own reverts, so a failed fill simulation can be told apart from a vault refusal
  // (lib/fillPreflight.ts). A zone revert with data is bubbled up by Seaport as the zone's own
  // error; `InvalidRestrictedOrder` is what Seaport says when the zone reverted WITHOUT data.
  { type: "error", name: "InvalidTime", inputs: [{ name: "startTime", type: "uint256" }, { name: "endTime", type: "uint256" }] },
  { type: "error", name: "OrderIsCancelled", inputs: [{ name: "orderHash", type: "bytes32" }] },
  { type: "error", name: "OrderAlreadyFilled", inputs: [{ name: "orderHash", type: "bytes32" }] },
  { type: "error", name: "OrderPartiallyFilled", inputs: [{ name: "orderHash", type: "bytes32" }] },
  { type: "error", name: "BadFraction", inputs: [] },
  { type: "error", name: "InexactFraction", inputs: [] },
  { type: "error", name: "PartialFillsNotEnabledForOrder", inputs: [] },
  { type: "error", name: "InvalidRestrictedOrder", inputs: [{ name: "orderHash", type: "bytes32" }] },
  { type: "error", name: "InvalidContractOrder", inputs: [{ name: "orderHash", type: "bytes32" }] },
  { type: "error", name: "InvalidSigner", inputs: [] },
  { type: "error", name: "InvalidSignature", inputs: [] },
  { type: "error", name: "BadSignatureV", inputs: [{ name: "v", type: "uint8" }] },
  { type: "error", name: "InvalidMsgValue", inputs: [{ name: "value", type: "uint256" }] },
  { type: "error", name: "MissingOriginalConsiderationItems", inputs: [] },
  { type: "error", name: "NoSpecifiedOrdersAvailable", inputs: [] },
  { type: "error", name: "NoReentrantCalls", inputs: [] },
  {
    type: "error",
    name: "TokenTransferGenericFailure",
    inputs: [
      { name: "token", type: "address" },
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "identifier", type: "uint256" },
      { name: "amount", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "BadReturnValueFromERC20OnTransfer",
    inputs: [
      { name: "token", type: "address" },
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
  },
  { type: "error", name: "NoContract", inputs: [{ name: "account", type: "address" }] },
  {
    type: "error",
    name: "ConsiderationNotMet",
    inputs: [
      { name: "orderIndex", type: "uint256" },
      { name: "considerationIndex", type: "uint256" },
      { name: "shortfallAmount", type: "uint256" },
    ],
  },
] as const;

/** Seaport errors raised BEFORE the zone hook runs: nothing about the vault can be inferred. */
export const SEAPORT_PRE_HOOK_ERRORS = new Set([
  "InvalidTime",
  "OrderIsCancelled",
  "OrderAlreadyFilled",
  "OrderPartiallyFilled",
  "BadFraction",
  "InexactFraction",
  "PartialFillsNotEnabledForOrder",
  "InvalidSigner",
  "InvalidSignature",
  "BadSignatureV",
  "InvalidMsgValue",
  "MissingOriginalConsiderationItems",
  "NoSpecifiedOrdersAvailable",
  "InvalidContractOrder",
]);

/** Seaport errors raised while MOVING tokens, i.e. after `authorizeOrder` has already passed. */
export const SEAPORT_TRANSFER_ERRORS = new Set([
  "TokenTransferGenericFailure",
  "BadReturnValueFromERC20OnTransfer",
  "NoContract",
  "ConsiderationNotMet",
]);
