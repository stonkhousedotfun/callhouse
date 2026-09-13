// Seaport 1.6 — events the vault is an offerer on, plus the two reads the API needs.
//
// Hand-written rather than generated: ops/abis/ carries no Seaport artefact, and only this
// slice is ever used. Every signature below was confirmed against the deployed bytecode on
// chain 4663 (0x0000000000000068F116a894984e2DB1123eB395, canonical Seaport 1.6, domain
// separator 0xa6b20d2b6f71c703cd333de0c921d303988fb481ff2982df74a21e19af3730b0) — see
// ops/recon/R2-R9-seaport-order-shape.md. The OrderFulfilled topic0 is
// 0x9d9af8e38d66c62e2c12f0225249fd9d721c54b83f48d9352c97c6cacdcb6f31.
export const seaportAbi = [
  {
    type: "event",
    name: "OrderFulfilled",
    inputs: [
      { name: "orderHash", type: "bytes32", indexed: false, internalType: "bytes32" },
      { name: "offerer", type: "address", indexed: true, internalType: "address" },
      { name: "zone", type: "address", indexed: true, internalType: "address" },
      { name: "recipient", type: "address", indexed: false, internalType: "address" },
      {
        name: "offer",
        type: "tuple[]",
        indexed: false,
        internalType: "struct SpentItem[]",
        components: [
          { name: "itemType", type: "uint8", internalType: "enum ItemType" },
          { name: "token", type: "address", internalType: "address" },
          { name: "identifier", type: "uint256", internalType: "uint256" },
          { name: "amount", type: "uint256", internalType: "uint256" },
        ],
      },
      {
        name: "consideration",
        type: "tuple[]",
        indexed: false,
        internalType: "struct ReceivedItem[]",
        components: [
          { name: "itemType", type: "uint8", internalType: "enum ItemType" },
          { name: "token", type: "address", internalType: "address" },
          { name: "identifier", type: "uint256", internalType: "uint256" },
          { name: "amount", type: "uint256", internalType: "uint256" },
          { name: "recipient", type: "address", internalType: "address payable" },
        ],
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OrderCancelled",
    inputs: [
      { name: "orderHash", type: "bytes32", indexed: false, internalType: "bytes32" },
      { name: "offerer", type: "address", indexed: true, internalType: "address" },
      { name: "zone", type: "address", indexed: true, internalType: "address" },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "CounterIncremented",
    inputs: [
      { name: "newCounter", type: "uint256", indexed: false, internalType: "uint256" },
      { name: "offerer", type: "address", indexed: true, internalType: "address" },
    ],
    anonymous: false,
  },
  {
    type: "function",
    name: "getCounter",
    stateMutability: "view",
    inputs: [{ name: "offerer", type: "address", internalType: "address" }],
    outputs: [{ name: "counter", type: "uint256", internalType: "uint256" }],
  },
  {
    type: "function",
    name: "getOrderStatus",
    stateMutability: "view",
    inputs: [{ name: "orderHash", type: "bytes32", internalType: "bytes32" }],
    outputs: [
      { name: "isValidated", type: "bool", internalType: "bool" },
      { name: "isCancelled", type: "bool", internalType: "bool" },
      { name: "totalFilled", type: "uint256", internalType: "uint256" },
      { name: "totalSize", type: "uint256", internalType: "uint256" },
    ],
  },
] as const;
