/**
 * ABI fragments, inlined as viem `as const` tuples so every readContract/writeContract call
 * infers its argument and return types.
 *
 * These are transcribed from the compiled artefacts in ops/abis (Vault.json,
 * OvercallRegistry.json, ValoremClear.json) and from ops/recon. They are deliberately NOT
 * imported from those JSON files: ops/ sits outside this package's tsconfig `rootDir`, and a
 * plain JSON import loses the literal types that make viem's inference work.
 *
 * Only what the keeper touches is here. Nothing is guessed.
 */

/*//////////////////////////////////////////////////////////////
                       SEAPORT ORDER STRUCTS
//////////////////////////////////////////////////////////////*/

const OFFER_ITEM = {
  name: 'offer',
  type: 'tuple[]',
  components: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
  ],
} as const;

const CONSIDERATION_ITEM = {
  name: 'consideration',
  type: 'tuple[]',
  components: [
    { name: 'itemType', type: 'uint8' },
    { name: 'token', type: 'address' },
    { name: 'identifierOrCriteria', type: 'uint256' },
    { name: 'startAmount', type: 'uint256' },
    { name: 'endAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ],
} as const;

/** OrderComponents: the struct that is hashed into an order hash. Ends in `counter`. */
const ORDER_COMPONENTS = [
  { name: 'offerer', type: 'address' },
  { name: 'zone', type: 'address' },
  OFFER_ITEM,
  CONSIDERATION_ITEM,
  { name: 'orderType', type: 'uint8' },
  { name: 'startTime', type: 'uint256' },
  { name: 'endTime', type: 'uint256' },
  { name: 'zoneHash', type: 'bytes32' },
  { name: 'salt', type: 'uint256' },
  { name: 'conduitKey', type: 'bytes32' },
  { name: 'counter', type: 'uint256' },
] as const;

/** OrderParameters: identical to OrderComponents except the final field is the consideration
 *  count instead of the counter. This is what `validate` and the fulfil paths take. */
const ORDER_PARAMETERS = [
  { name: 'offerer', type: 'address' },
  { name: 'zone', type: 'address' },
  OFFER_ITEM,
  CONSIDERATION_ITEM,
  { name: 'orderType', type: 'uint8' },
  { name: 'startTime', type: 'uint256' },
  { name: 'endTime', type: 'uint256' },
  { name: 'zoneHash', type: 'bytes32' },
  { name: 'salt', type: 'uint256' },
  { name: 'conduitKey', type: 'bytes32' },
  { name: 'totalOriginalConsiderationItems', type: 'uint256' },
] as const;

/*//////////////////////////////////////////////////////////////
                              VAULT
//////////////////////////////////////////////////////////////*/

/**
 * Vault.Harvest.
 *
 * Hoisted out of `vaultAbi` because the keeper queries it with `getLogs` as well as decoding
 * it from a receipt: the vault checkpoints the harvest inside `deposit()` and `mint()`, so a
 * deposit landing between a Seaport fill and `rollClose()` emits the week's premium EARLY and
 * the `rollClose` receipt then carries `Harvest(cycle, 0, 0, 0)`. Reading only the receipt
 * would publish a filled week as "unfilled, 0", which is the one thing the tape must never do.
 */
const HARVEST_EVENT = {
  type: 'event',
  name: 'Harvest',
  inputs: [
    { name: 'cycleNumber', type: 'uint32', indexed: true },
    { name: 'grossUsdg', type: 'uint256', indexed: false },
    { name: 'feeUsdg', type: 'uint256', indexed: false },
    { name: 'netUsdg', type: 'uint256', indexed: false },
  ],
} as const;

/** The same fragment, for `getLogs`. */
export const harvestEvent = HARVEST_EVENT;

/**
 * Vault.RollOpen and Vault.RollClose, hoisted for `getLogs` for the same reason as Harvest:
 * both carry the cycle number INDEXED, so a cycle the keeper never witnessed (its own receipt
 * timed out, or someone else ran the week) is reconstructable from the logs alone — the open
 * gives the block the harvest sum starts from, the close gives the assignment count.
 */
const ROLL_OPEN_EVENT = {
  type: 'event',
  name: 'RollOpen',
  inputs: [
    { name: 'cycleNumber', type: 'uint32', indexed: true },
    { name: 'optionId', type: 'uint256', indexed: true },
    { name: 'contractsCount', type: 'uint112', indexed: false },
    { name: 'strikeUsdg', type: 'uint256', indexed: false },
  ],
} as const;

/** The same fragment, for `getLogs`. */
export const rollOpenEvent = ROLL_OPEN_EVENT;

const ROLL_CLOSE_EVENT = {
  type: 'event',
  name: 'RollClose',
  inputs: [
    { name: 'cycleNumber', type: 'uint32', indexed: true },
    { name: 'assetsReturned', type: 'uint256', indexed: false },
    { name: 'usdgFromAssignment', type: 'uint256', indexed: false },
    { name: 'contractsAssignedCount', type: 'uint256', indexed: false },
  ],
} as const;

/** The same fragment, for `getLogs`. */
export const rollCloseEvent = ROLL_CLOSE_EVENT;

export const vaultAbi = [
  // --- phase machine ---
  { type: 'function', name: 'phase', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'rollOpen',
    inputs: [
      { name: 'optionId_', type: 'uint256' },
      { name: 'contractsCount', type: 'uint112' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'approveListing',
    inputs: [{ name: 'components', type: 'tuple', components: ORDER_COMPONENTS }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'cancelListing',
    inputs: [{ name: 'components', type: 'tuple', components: ORDER_COMPONENTS }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  { type: 'function', name: 'invalidateAllListings', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'lockBook', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'rollClose', inputs: [], outputs: [], stateMutability: 'nonpayable' },

  // --- cycle state ---
  { type: 'function', name: 'cycleNumber', inputs: [], outputs: [{ type: 'uint32' }], stateMutability: 'view' },
  { type: 'function', name: 'cycleExerciseTs', inputs: [], outputs: [{ type: 'uint40' }], stateMutability: 'view' },
  { type: 'function', name: 'cycleExpiryTs', inputs: [], outputs: [{ type: 'uint40' }], stateMutability: 'view' },
  { type: 'function', name: 'cycleStrikeUsdg', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'optionId', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'claimKey', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'contractsWritten', inputs: [], outputs: [{ type: 'uint112' }], stateMutability: 'view' },
  { type: 'function', name: 'contractsSold', inputs: [], outputs: [{ type: 'uint112' }], stateMutability: 'view' },
  { type: 'function', name: 'contractsRemaining', inputs: [], outputs: [{ type: 'uint112' }], stateMutability: 'view' },
  { type: 'function', name: 'contractsAssigned', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'lockedAssets', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'claimedExerciseProceeds',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },

  // --- listing state ---
  { type: 'function', name: 'listingHash', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'listingGrossUsdg', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'listingAmount', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'listingsThisCycle', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },

  // --- accounting ---
  { type: 'function', name: 'totalAssets', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'idleAssets', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'previewDeposit',
    inputs: [{ name: 'assets', type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'deposit',
    inputs: [
      { name: 'assets', type: 'uint256' },
      { name: 'receiver', type: 'address' },
    ],
    outputs: [{ name: 'shares', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  { type: 'function', name: 'accUsdgPerShare', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'claimableUsdg',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'claimUsdg',
    inputs: [],
    outputs: [{ name: 'amount', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'claimUsdgTo',
    inputs: [{ name: 'to', type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  { type: 'function', name: 'totalUsdgDistributed', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'queuedShares', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'epochId', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'reservedAssets', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'usdgReservedForQueue',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  { type: 'function', name: 'canRedeemInstantly', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },

  // --- policy + gates ---
  {
    type: 'function',
    name: 'policy',
    inputs: [],
    outputs: [
      { name: 'minOtmBps', type: 'uint16' },
      { name: 'maxOtmBps', type: 'uint16' },
      { name: 'minPremiumBps', type: 'uint16' },
      { name: 'maxUtilizationBps', type: 'uint16' },
      { name: 'protocolFeeBps', type: 'uint16' },
      { name: 'maxContractsCap', type: 'uint64' },
    ],
    stateMutability: 'view',
  },
  { type: 'function', name: 'spotUsdg', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'uiMultiplier', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'writesHalted', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'valoremFeeAccepted', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'depositCap', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'feeRecipient', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'setDepositCap',
    inputs: [{ name: 'cap', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'setPolicy',
    inputs: [
      {
        name: 'p',
        type: 'tuple',
        components: [
          { name: 'minOtmBps', type: 'uint16' },
          { name: 'maxOtmBps', type: 'uint16' },
          { name: 'minPremiumBps', type: 'uint16' },
          { name: 'maxUtilizationBps', type: 'uint16' },
          { name: 'protocolFeeBps', type: 'uint16' },
          { name: 'maxContractsCap', type: 'uint64' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'acceptValoremFee',
    inputs: [{ name: 'accepted', type: 'bool' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  { type: 'function', name: 'haltWrites', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'unhaltWrites', inputs: [], outputs: [], stateMutability: 'nonpayable' },

  // --- wiring, checked at boot ---
  { type: 'function', name: 'asset', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'usdg', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'clear', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'seaport', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'registry', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'overcallFeeRecipient',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },
  { type: 'function', name: 'conduitKey', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'seaportZone', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'transferApprovalTarget',
    inputs: [],
    outputs: [{ type: 'address' }],
    stateMutability: 'view',
  },

  // --- roles ---
  { type: 'function', name: 'KEEPER_ROLE', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'GUARDIAN_ROLE', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  { type: 'function', name: 'DEFAULT_ADMIN_ROLE', inputs: [], outputs: [{ type: 'bytes32' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'hasRole',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'grantRole',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },

  // --- events the keeper reads back out of receipts ---
  ROLL_OPEN_EVENT,
  {
    type: 'event',
    name: 'ListingApproved',
    inputs: [
      { name: 'orderHash', type: 'bytes32', indexed: true },
      { name: 'optionId', type: 'uint256', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'grossUsdg', type: 'uint256', indexed: false },
      { name: 'seq', type: 'uint8', indexed: false },
    ],
  },
  { type: 'event', name: 'ListingCancelled', inputs: [{ name: 'orderHash', type: 'bytes32', indexed: true }] },
  {
    type: 'event',
    name: 'AllListingsInvalidated',
    inputs: [{ name: 'newCounter', type: 'uint256', indexed: false }],
  },
  { type: 'event', name: 'BookLocked', inputs: [{ name: 'cycleNumber', type: 'uint32', indexed: true }] },
  ROLL_CLOSE_EVENT,
  HARVEST_EVENT,
  /*------------------------------------------------------------------
    Custom errors, every one the vault can throw — its own, Policy's,
    SeaportOrderLib's, the adapters', AccessControl's and OpenZeppelin's.
    These carry no calldata cost and no runtime weight; they exist so a
    revert surfaces as `StrikeBelowBand(226000000, 230720000)` in an alert
    at 20:00 UTC on a Friday instead of a bare four-byte selector.
  ------------------------------------------------------------------*/
  { type: 'error', name: 'AccessControlBadConfirmation', inputs: [] },
  { type: 'error', name: 'AccessControlUnauthorizedAccount', inputs: [{ name: 'account', type: 'address' }, { name: 'neededRole', type: 'bytes32' }] },
  { type: 'error', name: 'BadConduitKey', inputs: [{ name: 'expected', type: 'bytes32' }, { name: 'got', type: 'bytes32' }] }, // SeaportOrderLib.sol:51
  { type: 'error', name: 'BadConsiderationIdentifier', inputs: [{ name: 'got', type: 'uint256' }] }, // SeaportOrderLib.sol:64
  { type: 'error', name: 'BadConsiderationItemType', inputs: [{ name: 'got', type: 'uint8' }] }, // SeaportOrderLib.sol:62 (ItemType enum)
  { type: 'error', name: 'BadConsiderationLength', inputs: [{ name: 'got', type: 'uint256' }] }, // SeaportOrderLib.sol:61
  { type: 'error', name: 'BadConsiderationToken', inputs: [{ name: 'expected', type: 'address' }, { name: 'got', type: 'address' }] }, // SeaportOrderLib.sol:63
  { type: 'error', name: 'BadCounter', inputs: [{ name: 'expected', type: 'uint256' }, { name: 'got', type: 'uint256' }] }, // SeaportOrderLib.sol:71
  { type: 'error', name: 'BadCycleWindow', inputs: [{ name: 'exerciseTs', type: 'uint40' }, { name: 'expiryTs', type: 'uint40' }] }, // Vault.sol:242
  { type: 'error', name: 'BadFeeSplit', inputs: [{ name: 'expectedToVault', type: 'uint256' }, { name: 'gotToVault', type: 'uint256' }, { name: 'expectedToOvercall', type: 'uint256' }, { name: 'gotToOvercall', type: 'uint256' }] }, // SeaportOrderLib.sol:67
  { type: 'error', name: 'BadOfferer', inputs: [{ name: 'got', type: 'address' }] }, // SeaportOrderLib.sol:49
  { type: 'error', name: 'BadOfferIdentifier', inputs: [{ name: 'expected', type: 'uint256' }, { name: 'got', type: 'uint256' }] }, // SeaportOrderLib.sol:57
  { type: 'error', name: 'BadOfferItemType', inputs: [{ name: 'got', type: 'uint8' }] }, // SeaportOrderLib.sol:55 (ItemType enum)
  { type: 'error', name: 'BadOfferLength', inputs: [{ name: 'got', type: 'uint256' }] }, // SeaportOrderLib.sol:54
  { type: 'error', name: 'BadOfferToken', inputs: [{ name: 'expected', type: 'address' }, { name: 'got', type: 'address' }] }, // SeaportOrderLib.sol:56
  { type: 'error', name: 'BadOrderType', inputs: [{ name: 'got', type: 'uint8' }] }, // SeaportOrderLib.sol:53 (OrderType enum)
  { type: 'error', name: 'BadOvercallRecipient', inputs: [{ name: 'expected', type: 'address' }, { name: 'got', type: 'address' }] }, // SeaportOrderLib.sol:66
  { type: 'error', name: 'BadVaultRecipient', inputs: [{ name: 'expected', type: 'address' }, { name: 'got', type: 'address' }] }, // SeaportOrderLib.sol:65
  { type: 'error', name: 'BadZone', inputs: [{ name: 'expected', type: 'address' }, { name: 'got', type: 'address' }] }, // SeaportOrderLib.sol:50
  { type: 'error', name: 'BadZoneHash', inputs: [{ name: 'got', type: 'bytes32' }] }, // SeaportOrderLib.sol:52
  { type: 'error', name: 'ContractsAboveCap', inputs: [{ name: 'contractsRequested', type: 'uint256' }, { name: 'cap', type: 'uint256' }] },
  { type: 'error', name: 'ContractsAboveUtilization', inputs: [{ name: 'contractsRequested', type: 'uint256' }, { name: 'maxByUtilization', type: 'uint256' }] },
  { type: 'error', name: 'ContractsCapZero', inputs: [] },
  { type: 'error', name: 'ContractsZero', inputs: [] },
  { type: 'error', name: 'DepositCapExceeded', inputs: [{ name: 'wouldBe', type: 'uint256' }, { name: 'cap', type: 'uint256' }] },
  { type: 'error', name: 'DepositsClosedForCycle', inputs: [{ name: 'exerciseTs', type: 'uint40' }] }, // Vault.sol:243
  { type: 'error', name: 'DutchAuctionNotAllowed', inputs: [] }, // SeaportOrderLib.sol:58
  { type: 'error', name: 'ERC20InsufficientAllowance', inputs: [{ name: 'spender', type: 'address' }, { name: 'allowance', type: 'uint256' }, { name: 'needed', type: 'uint256' }] },
  { type: 'error', name: 'ERC20InsufficientBalance', inputs: [{ name: 'sender', type: 'address' }, { name: 'balance', type: 'uint256' }, { name: 'needed', type: 'uint256' }] },
  { type: 'error', name: 'ERC20InvalidApprover', inputs: [{ name: 'approver', type: 'address' }] },
  { type: 'error', name: 'ERC20InvalidReceiver', inputs: [{ name: 'receiver', type: 'address' }] },
  { type: 'error', name: 'ERC20InvalidSender', inputs: [{ name: 'sender', type: 'address' }] },
  { type: 'error', name: 'ERC20InvalidSpender', inputs: [{ name: 'spender', type: 'address' }] },
  { type: 'error', name: 'EpochNotSettled', inputs: [{ name: 'epochId', type: 'uint256' }, { name: 'currentEpoch', type: 'uint256' }] },
  { type: 'error', name: 'GuardianTooEarly', inputs: [{ name: 'allowedAt', type: 'uint40' }] },
  { type: 'error', name: 'InsufficientFreeShares', inputs: [{ name: 'free', type: 'uint256' }, { name: 'requested', type: 'uint256' }] },
  { type: 'error', name: 'ListingAlreadyEnded', inputs: [{ name: 'endTime', type: 'uint256' }] }, // SeaportOrderLib.sol:74
  { type: 'error', name: 'ListingOutlivesExercise', inputs: [{ name: 'endTime', type: 'uint256' }, { name: 'exerciseTimestamp', type: 'uint256' }] }, // SeaportOrderLib.sol:72
  { type: 'error', name: 'ListingStartsInFuture', inputs: [{ name: 'startTime', type: 'uint256' }] }, // SeaportOrderLib.sol:73
  { type: 'error', name: 'MaxOtmAboveCeiling', inputs: [{ name: 'got', type: 'uint16' }, { name: 'ceilBps', type: 'uint16' }] },
  { type: 'error', name: 'MinOtmBelowFloor', inputs: [{ name: 'got', type: 'uint16' }, { name: 'floorBps', type: 'uint16' }] },
  { type: 'error', name: 'MinPremiumBelowFloor', inputs: [{ name: 'got', type: 'uint16' }, { name: 'floorBps', type: 'uint16' }] },
  { type: 'error', name: 'NoCycle', inputs: [] },
  { type: 'error', name: 'NoLiveListing', inputs: [] },
  { type: 'error', name: 'NoOpenClaim', inputs: [] },
  { type: 'error', name: 'NotYetExercisable', inputs: [{ name: 'exerciseTs', type: 'uint40' }] },
  { type: 'error', name: 'NotYetExpired', inputs: [{ name: 'expiryTs', type: 'uint40' }] },
  { type: 'error', name: 'NothingQueued', inputs: [] },
  { type: 'error', name: 'NothingToClaim', inputs: [] },
  { type: 'error', name: 'OfferAmountZero', inputs: [] }, // SeaportOrderLib.sol:59
  { type: 'error', name: 'OfferExceedsInventory', inputs: [{ name: 'requested', type: 'uint256' }, { name: 'available', type: 'uint256' }] }, // SeaportOrderLib.sol:60
  { type: 'error', name: 'OptionAssetMismatch', inputs: [{ name: 'expectedUnderlying', type: 'address' }, { name: 'gotUnderlying', type: 'address' }] },
  { type: 'error', name: 'OptionExerciseAssetMismatch', inputs: [{ name: 'expectedExercise', type: 'address' }, { name: 'gotExercise', type: 'address' }] },
  { type: 'error', name: 'OptionNotApproved', inputs: [{ name: 'optionId', type: 'uint256' }] },
  { type: 'error', name: 'OptionNotInCurrentCycle', inputs: [{ name: 'optionId', type: 'uint256' }, { name: 'optionCycle', type: 'uint32' }, { name: 'currentCycle', type: 'uint32' }] },
  { type: 'error', name: 'OptionWindowMismatch', inputs: [{ name: 'optionExerciseTs', type: 'uint40' }, { name: 'optionExpiryTs', type: 'uint40' }] }, // ValoremLib.sol:27
  { type: 'error', name: 'OraclePaused', inputs: [] },
  { type: 'error', name: 'OrderHashMismatch', inputs: [{ name: 'expected', type: 'bytes32' }, { name: 'got', type: 'bytes32' }] }, // SeaportOrderLib.sol:77
  { type: 'error', name: 'OtmBandInverted', inputs: [{ name: 'minOtmBps', type: 'uint16' }, { name: 'maxOtmBps', type: 'uint16' }] },
  { type: 'error', name: 'OvercallFeeRoundsToZero', inputs: [{ name: 'unitPriceUsdg', type: 'uint256' }, { name: 'minimum', type: 'uint256' }] }, // SeaportOrderLib.sol:69
  { type: 'error', name: 'PremiumBelowMinimum', inputs: [{ name: 'premiumUsdg', type: 'uint256' }, { name: 'minPremiumUsdg', type: 'uint256' }] },
  { type: 'error', name: 'PremiumNotDivisibleByOrderSize', inputs: [{ name: 'grossUsdg', type: 'uint256' }, { name: 'amount', type: 'uint256' }] }, // SeaportOrderLib.sol:68
  { type: 'error', name: 'PreviousListingLive', inputs: [{ name: 'liveHash', type: 'bytes32' }] },
  { type: 'error', name: 'PriceAgeOutOfBounds', inputs: [{ name: 'got', type: 'uint32' }, { name: 'minAge', type: 'uint32' }, { name: 'maxAge', type: 'uint32' }] },
  { type: 'error', name: 'ProtocolFeeAboveCeiling', inputs: [{ name: 'got', type: 'uint16' }, { name: 'ceilBps', type: 'uint16' }] },
  { type: 'error', name: 'ReentrancyGuardReentrantCall', inputs: [] },
  { type: 'error', name: 'RegistryAssetMismatch', inputs: [{ name: 'expected', type: 'address' }, { name: 'got', type: 'address' }] },
  { type: 'error', name: 'SafeERC20FailedOperation', inputs: [{ name: 'token', type: 'address' }] },
  { type: 'error', name: 'SeaportCancelFailed', inputs: [] }, // SeaportOrderLib.sol:76
  { type: 'error', name: 'SeaportValidateFailed', inputs: [] }, // SeaportOrderLib.sol:75
  { type: 'error', name: 'SpotZero', inputs: [] },
  { type: 'error', name: 'StalePrice', inputs: [{ name: 'updatedAt', type: 'uint256' }, { name: 'maxAge', type: 'uint256' }] },
  { type: 'error', name: 'StrikeAboveBand', inputs: [{ name: 'strikeUsdg', type: 'uint256' }, { name: 'maxStrikeUsdg', type: 'uint256' }] },
  { type: 'error', name: 'StrikeBelowBand', inputs: [{ name: 'strikeUsdg', type: 'uint256' }, { name: 'minStrikeUsdg', type: 'uint256' }] },
  { type: 'error', name: 'TooManyListings', inputs: [{ name: 'authorised', type: 'uint8' }, { name: 'max', type: 'uint8' }] },
  { type: 'error', name: 'UnexpectedLotSize', inputs: [{ name: 'expected', type: 'uint96' }, { name: 'got', type: 'uint96' }] },
  { type: 'error', name: 'UnitPriceExceedsStrike', inputs: [{ name: 'unitPriceUsdg', type: 'uint256' }, { name: 'strikeUsdg', type: 'uint256' }] }, // SeaportOrderLib.sol:70
  { type: 'error', name: 'UseQueue', inputs: [] },
  { type: 'error', name: 'UtilizationAboveCeiling', inputs: [{ name: 'got', type: 'uint16' }, { name: 'ceilBps', type: 'uint16' }] },
  { type: 'error', name: 'ValoremFeeNotAccepted', inputs: [{ name: 'feeBps', type: 'uint8' }] },
  { type: 'error', name: 'ValoremFeesEnabled', inputs: [{ name: 'feeBps', type: 'uint8' }] },
  { type: 'error', name: 'WriteReturnedNoClaim', inputs: [] },
  { type: 'error', name: 'WritesAreHalted', inputs: [] },
  { type: 'error', name: 'WritingNotOpen', inputs: [] },
  { type: 'error', name: 'WrongPhase', inputs: [{ name: 'expected', type: 'uint8' }, { name: 'actual', type: 'uint8' }] },
  { type: 'error', name: 'ZeroAddr', inputs: [] },
  { type: 'error', name: 'ZeroAddress', inputs: [] },
  { type: 'error', name: 'ZeroAssets', inputs: [] },
  { type: 'error', name: 'ZeroShares', inputs: [] },

  {
    type: 'event',
    name: 'QueueSettled',
    inputs: [
      { name: 'epochId', type: 'uint256', indexed: true },
      { name: 'shares', type: 'uint256', indexed: false },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'usdgOut', type: 'uint256', indexed: false },
    ],
  },
] as const;

/*//////////////////////////////////////////////////////////////
                        OVERCALL REGISTRY
//////////////////////////////////////////////////////////////*/

/**
 * NOTE: the Cycle struct has NO status field. TECHSPEC guessed one; it does not exist on chain.
 * The keeper's write trigger is `isWritingOpen()`, which is
 *   cycleNumber != 0 && block.timestamp < writeDeadline()   (writeDeadline == exerciseTimestamp).
 */
const CYCLE_STRUCT = {
  type: 'tuple',
  components: [
    { name: 'number', type: 'uint32' },
    { name: 'exerciseTimestamp', type: 'uint40' },
    { name: 'expiryTimestamp', type: 'uint40' },
    { name: 'lotSize', type: 'uint96' },
    { name: 'optionIds', type: 'uint256[]' },
  ],
} as const;

export const registryAbi = [
  { type: 'function', name: 'cycle', inputs: [], outputs: [CYCLE_STRUCT], stateMutability: 'view' },
  {
    type: 'function',
    name: 'cycleAt',
    inputs: [{ name: 'index', type: 'uint256' }],
    outputs: [CYCLE_STRUCT],
    stateMutability: 'view',
  },
  { type: 'function', name: 'activeOptionIds', inputs: [], outputs: [{ type: 'uint256[]' }], stateMutability: 'view' },
  { type: 'function', name: 'isWritingOpen', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'isCycleLive', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'canReplaceCycle', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'writeDeadline', inputs: [], outputs: [{ type: 'uint40' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'isApproved',
    inputs: [{ name: 'optionId', type: 'uint256' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'cycleOf',
    inputs: [{ name: 'optionId', type: 'uint256' }],
    outputs: [{ type: 'uint32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'strikePerContract',
    inputs: [{ name: 'optionId', type: 'uint256' }],
    outputs: [{ name: 'strike', type: 'uint96' }],
    stateMutability: 'view',
  },
  { type: 'function', name: 'collateralToken', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'exerciseToken', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'clearinghouse', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  { type: 'function', name: 'lotSize', inputs: [], outputs: [{ type: 'uint96' }], stateMutability: 'view' },
  { type: 'function', name: 'cycleLotSize', inputs: [], outputs: [{ type: 'uint96' }], stateMutability: 'view' },
  { type: 'function', name: 'cycleNumber', inputs: [], outputs: [{ type: 'uint32' }], stateMutability: 'view' },
  { type: 'function', name: 'cycleCount', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'exerciseTimestamp', inputs: [], outputs: [{ type: 'uint40' }], stateMutability: 'view' },
  { type: 'function', name: 'expiryTimestamp', inputs: [], outputs: [{ type: 'uint40' }], stateMutability: 'view' },
  { type: 'function', name: 'MAX_STRIKES', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'MIN_EXERCISE_WINDOW',
    inputs: [],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'event',
    name: 'CycleSet',
    inputs: [
      { name: 'number', type: 'uint32', indexed: true },
      { name: 'optionIds', type: 'uint256[]', indexed: false },
      { name: 'exerciseAt', type: 'uint40', indexed: false },
      { name: 'expireAt', type: 'uint40', indexed: false },
      { name: 'lotSize', type: 'uint96', indexed: false },
    ],
  },
] as const;

/*//////////////////////////////////////////////////////////////
                          VALOREM CLEAR
//////////////////////////////////////////////////////////////*/

/**
 * Exact upstream ValoremOptionsClearinghouse (valorem-core @6436c823, solc 0.8.16).
 *
 * TRAP, worth repeating everywhere it is used: `claim()` returns `amountWritten` and
 * `amountExercised` as 1e18-SCALED SCALARS, not contract counts. Divide by 1e18 before
 * comparing them with anything the vault calls a "contract".
 */
export const clearAbi = [
  {
    type: 'function',
    name: 'option',
    inputs: [{ name: 'optionId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'underlyingAsset', type: 'address' },
          { name: 'underlyingAmount', type: 'uint96' },
          { name: 'exerciseAsset', type: 'address' },
          { name: 'exerciseAmount', type: 'uint96' },
          { name: 'exerciseTimestamp', type: 'uint40' },
          { name: 'expiryTimestamp', type: 'uint40' },
          { name: 'settlementSeed', type: 'uint160' },
          { name: 'nextClaimKey', type: 'uint96' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'claim',
    inputs: [{ name: 'claimId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'amountWritten', type: 'uint256' },
          { name: 'amountExercised', type: 'uint256' },
          { name: 'optionId', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'position',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'underlyingAsset', type: 'address' },
          { name: 'underlyingAmount', type: 'int256' },
          { name: 'exerciseAsset', type: 'address' },
          { name: 'exerciseAmount', type: 'int256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'write',
    inputs: [
      { name: 'optionId', type: 'uint256' },
      { name: 'amount', type: 'uint112' },
    ],
    outputs: [{ name: 'claimId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'redeem',
    inputs: [{ name: 'claimId', type: 'uint256' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'exercise',
    inputs: [
      { name: 'optionId', type: 'uint256' },
      { name: 'amount', type: 'uint112' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  { type: 'function', name: 'feesEnabled', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'feeBps', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'feeTo', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'tokenType',
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    outputs: [{ type: 'uint8' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'id', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'isApprovedForAll',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'operator', type: 'address' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'setApprovalForAll',
    inputs: [
      { name: 'operator', type: 'address' },
      { name: 'approved', type: 'bool' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'event',
    name: 'OptionsWritten',
    inputs: [
      { name: 'optionId', type: 'uint256', indexed: false },
      { name: 'writer', type: 'address', indexed: true },
      { name: 'claimId', type: 'uint256', indexed: false },
      { name: 'amount', type: 'uint112', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'OptionsExercised',
    inputs: [
      { name: 'optionId', type: 'uint256', indexed: true },
      { name: 'exerciser', type: 'address', indexed: true },
      { name: 'amount', type: 'uint112', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ClaimRedeemed',
    inputs: [
      { name: 'claimId', type: 'uint256', indexed: true },
      { name: 'optionId', type: 'uint256', indexed: true },
      { name: 'redeemer', type: 'address', indexed: true },
      { name: 'exerciseAmountRedeemed', type: 'uint256', indexed: false },
      { name: 'underlyingAmountRedeemed', type: 'uint256', indexed: false },
    ],
  },
] as const;

/*//////////////////////////////////////////////////////////////
                            SEAPORT 1.6
//////////////////////////////////////////////////////////////*/

export const seaportAbi = [
  {
    type: 'function',
    name: 'getCounter',
    inputs: [{ name: 'offerer', type: 'address' }],
    outputs: [{ name: 'counter', type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getOrderHash',
    inputs: [{ name: 'order', type: 'tuple', components: ORDER_COMPONENTS }],
    outputs: [{ name: 'orderHash', type: 'bytes32' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'getOrderStatus',
    inputs: [{ name: 'orderHash', type: 'bytes32' }],
    outputs: [
      { name: 'isValidated', type: 'bool' },
      { name: 'isCancelled', type: 'bool' },
      { name: 'totalFilled', type: 'uint256' },
      { name: 'totalSize', type: 'uint256' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'information',
    inputs: [],
    outputs: [
      { name: 'version', type: 'string' },
      { name: 'domainSeparator', type: 'bytes32' },
      { name: 'conduitController', type: 'address' },
    ],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'fulfillOrder',
    inputs: [
      {
        name: 'order',
        type: 'tuple',
        components: [
          { name: 'parameters', type: 'tuple', components: ORDER_PARAMETERS },
          { name: 'signature', type: 'bytes' },
        ],
      },
      { name: 'fulfillerConduitKey', type: 'bytes32' },
    ],
    outputs: [{ name: 'fulfilled', type: 'bool' }],
    stateMutability: 'payable',
  },
  {
    type: 'function',
    name: 'fulfillAdvancedOrder',
    inputs: [
      {
        name: 'advancedOrder',
        type: 'tuple',
        components: [
          { name: 'parameters', type: 'tuple', components: ORDER_PARAMETERS },
          { name: 'numerator', type: 'uint120' },
          { name: 'denominator', type: 'uint120' },
          { name: 'signature', type: 'bytes' },
          { name: 'extraData', type: 'bytes' },
        ],
      },
      {
        name: 'criteriaResolvers',
        type: 'tuple[]',
        components: [
          { name: 'orderIndex', type: 'uint256' },
          { name: 'side', type: 'uint8' },
          { name: 'index', type: 'uint256' },
          { name: 'identifier', type: 'uint256' },
          { name: 'criteriaProof', type: 'bytes32[]' },
        ],
      },
      { name: 'fulfillerConduitKey', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
    ],
    outputs: [{ name: 'fulfilled', type: 'bool' }],
    stateMutability: 'payable',
  },
  {
    type: 'event',
    name: 'OrderFulfilled',
    inputs: [
      { name: 'orderHash', type: 'bytes32', indexed: false },
      { name: 'offerer', type: 'address', indexed: true },
      { name: 'zone', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: false },
      {
        name: 'offer',
        type: 'tuple[]',
        indexed: false,
        components: [
          { name: 'itemType', type: 'uint8' },
          { name: 'token', type: 'address' },
          { name: 'identifier', type: 'uint256' },
          { name: 'amount', type: 'uint256' },
        ],
      },
      {
        name: 'consideration',
        type: 'tuple[]',
        indexed: false,
        components: [
          { name: 'itemType', type: 'uint8' },
          { name: 'token', type: 'address' },
          { name: 'identifier', type: 'uint256' },
          { name: 'amount', type: 'uint256' },
          { name: 'recipient', type: 'address' },
        ],
      },
    ],
  },
] as const;

/*//////////////////////////////////////////////////////////////
                              ERC-20
//////////////////////////////////////////////////////////////*/

export const erc20Abi = [
  {
    type: 'function',
    name: 'balanceOf',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  { type: 'function', name: 'decimals', inputs: [], outputs: [{ type: 'uint8' }], stateMutability: 'view' },
  { type: 'function', name: 'symbol', inputs: [], outputs: [{ type: 'string' }], stateMutability: 'view' },
  { type: 'function', name: 'totalSupply', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'function',
    name: 'allowance',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
  },
  {
    type: 'function',
    name: 'approve',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'transfer',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
    stateMutability: 'nonpayable',
  },
] as const;

/*//////////////////////////////////////////////////////////////
                    ROBINHOOD CHAIN STOCK TOKEN
//////////////////////////////////////////////////////////////*/

/** The write gate the vault enforces on chain, mirrored here so the keeper can alert on it
 *  before it wastes a simulation. Probed, never assumed: an older Stock implementation does
 *  not have `oraclePaused()` at all. */
export const stockTokenAbi = [
  { type: 'function', name: 'oraclePaused', inputs: [], outputs: [{ type: 'bool' }], stateMutability: 'view' },
  { type: 'function', name: 'uiMultiplier', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const;
