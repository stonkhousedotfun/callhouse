/**
 * Event/view ABI fragments mirrored from callhouse-contracts
 * src/v2/periphery/house/HouseVault.sol and HouseVaultFactory.sol.
 *
 * ops/abis/v2 has no HouseVault.json / HouseVaultFactory.json yet (the export list
 * script/v2/abi-manifest.txt does not name them). Same pattern as
 * buybackExecutorEvents.ts: an indexing surface outside abis/v2 until export-abis.sh
 * copies the compiler artefact. Signatures match HouseVaultInterface.t.sol topics.
 *
 * Transfer is OpenZeppelin ERC20 (HouseVault is ERC20). epochEnd/epochId are public
 * getters used once at VaultCreated to open epoch 0 without inventing the boundary.
 */
/**
 * The LEGACY `VaultCreated`, as the legacy factory emits it (4 fields, topic
 * 0xf4c8fe3d...6e29). A change appended `bool weekly`, so the generated abis/v2/houseVaultFactory.ts now
 * carries a different event (topic 0xeef0325f...500d) that the live launch factory never emits. The
 * configured HouseVaultFactory source and its clone discovery use this fragment (ponder.config.ts
 * legacyHouseVaultFactoryAbi); a factory that emits the new event is a separate source,.
 */
export const houseVaultFactoryIndexingAbi = [
  {
    type: "event",
    name: "VaultCreated",
    inputs: [
      { name: "underlying", type: "address", indexed: true, internalType: "address" },
      { name: "vault", type: "address", indexed: true, internalType: "address" },
      { name: "name", type: "string", indexed: false, internalType: "string" },
      { name: "symbol", type: "string", indexed: false, internalType: "string" },
    ],
    anonymous: false,
  },
] as const;

const limitsComponents = [
  { name: "maxSeriesUnits", type: "uint64", internalType: "uint64" },
  { name: "maxTotalNotional", type: "uint128", internalType: "uint128" },
  { name: "askToleranceBps", type: "uint16", internalType: "uint16" },
  { name: "maxBidBpsOfSpot", type: "uint16", internalType: "uint16" },
  { name: "maxOrderLifetime", type: "uint32", internalType: "uint32" },
  { name: "maxDailyOutflow", type: "uint128", internalType: "uint128" },
] as const;

export const houseVaultIndexingAbi = [
  {
    type: "event",
    name: "DepositRequested",
    inputs: [
      { name: "account", type: "address", indexed: true, internalType: "address" },
      { name: "usdgAmount", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "stockAmount", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "epochId", type: "uint64", indexed: true, internalType: "uint64" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "DepositRequestCancelled",
    inputs: [
      { name: "account", type: "address", indexed: true, internalType: "address" },
      { name: "usdgAmount", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "stockAmount", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "WithdrawRequested",
    inputs: [
      { name: "account", type: "address", indexed: true, internalType: "address" },
      { name: "shares", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "epochId", type: "uint64", indexed: true, internalType: "uint64" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "WithdrawRequestCancelled",
    inputs: [
      { name: "account", type: "address", indexed: true, internalType: "address" },
      { name: "shares", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "EpochRolled",
    inputs: [
      { name: "epochId", type: "uint64", indexed: true, internalType: "uint64" },
      { name: "epochEnd", type: "uint40", indexed: true, internalType: "uint40" },
      { name: "price", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "nav", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "supply", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "sharesMinted", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "sharesBurned", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "performanceFee", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "account", type: "address", indexed: true, internalType: "address" },
      { name: "shares", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "usdgAmount", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "stockAmount", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "LimitsSet",
    inputs: [
      {
        name: "limits",
        type: "tuple",
        indexed: false,
        internalType: "struct HouseVault.Limits",
        components: limitsComponents,
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "PerformanceFeeBpsSet",
    inputs: [{ name: "bps", type: "uint16", indexed: false, internalType: "uint16" }],
    anonymous: false,
  },
  {
    type: "event",
    name: "ProtocolAccountSet",
    inputs: [
      { name: "account", type: "address", indexed: true, internalType: "address" },
      { name: "blocked", type: "bool", indexed: false, internalType: "bool" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "QuotingPausedSet",
    inputs: [{ name: "paused", type: "bool", indexed: false, internalType: "bool" }],
    anonymous: false,
  },
  {
    type: "event",
    name: "ExposureSet",
    inputs: [
      { name: "longId", type: "uint256", indexed: true, internalType: "uint256" },
      { name: "units", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "notional", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "totalNotional", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true, internalType: "address" },
      { name: "to", type: "address", indexed: true, internalType: "address" },
      { name: "value", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  {
    type: "function",
    name: "epochEnd",
    inputs: [],
    outputs: [{ name: "", type: "uint40", internalType: "uint40" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "epochId",
    inputs: [],
    outputs: [{ name: "", type: "uint64", internalType: "uint64" }],
    stateMutability: "view",
  },
] as const;

/** Declared exactly as HouseVaultInterface.t.sol keccak's them. */
export const HOUSE_VAULT_EVENTS = {
  /** The legacy (legacy) factory's event: what the live launch factory emits and what discovery watches. */
  VaultCreated: "event VaultCreated(address indexed underlying, address indexed vault, string name, string symbol)",
  /** The event, with the epoch kind: what the generated ABI carries. */
  VaultCreatedKinded:
    "event VaultCreated(address indexed underlying, address indexed vault, string name, string symbol, bool weekly)",
  DepositRequested:
    "event DepositRequested(address indexed account, uint256 usdgAmount, uint256 stockAmount, uint64 indexed epochId)",
  DepositRequestCancelled:
    "event DepositRequestCancelled(address indexed account, uint256 usdgAmount, uint256 stockAmount)",
  WithdrawRequested: "event WithdrawRequested(address indexed account, uint256 shares, uint64 indexed epochId)",
  WithdrawRequestCancelled: "event WithdrawRequestCancelled(address indexed account, uint256 shares)",
  EpochRolled:
    "event EpochRolled(uint64 indexed epochId, uint40 indexed epochEnd, uint256 price, uint256 nav, uint256 supply, uint256 sharesMinted, uint256 sharesBurned, uint256 performanceFee)",
  Claimed: "event Claimed(address indexed account, uint256 shares, uint256 usdgAmount, uint256 stockAmount)",
  LimitsSet: "event LimitsSet((uint64,uint128,uint16,uint16,uint32,uint128) limits)",
  PerformanceFeeBpsSet: "event PerformanceFeeBpsSet(uint16 bps)",
  ProtocolAccountSet: "event ProtocolAccountSet(address indexed account, bool blocked)",
  QuotingPausedSet: "event QuotingPausedSet(bool paused)",
  ExposureSet:
    "event ExposureSet(uint256 indexed longId, uint256 units, uint256 notional, uint256 totalNotional)",
  Transfer: "event Transfer(address indexed from, address indexed to, uint256 value)",
  // Kept beside the generated ABI: this file is what ponder.config's legacy factory
  // fragment and the handler topic pins import. Deleting it would drop the 4-field VaultCreated.
  PerformanceFeePaid: "event PerformanceFeePaid(uint64 indexed epochId, uint256 paid, uint256 owed)",
  EpochBatchesPriced:
    "event EpochBatchesPriced(uint64 indexed epochId, uint256 depositValue, bool depositRefused, uint256 withdrawUsdg, uint256 withdrawStock)",
  EpochOpened: "event EpochOpened(uint64 indexed epochId, uint40 epochEnd)",
} as const;
