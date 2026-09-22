// FROZEN v7 run-off subset copied from
// e8e4457c3356f58d2a93ee09094d37f7c971590d:web/lib/abi/v2/clearinghouse.ts.
// Never regenerate this file: web/scripts/gen-abis.mjs owns lib/abi/v2 only.
export const v7ClearinghouseAbi = [
  {
    "type": "function",
    "name": "close",
    "inputs": [
      { "name": "longId", "type": "uint256", "internalType": "uint256" },
      { "name": "units", "type": "uint64", "internalType": "uint64" },
    ],
    "outputs": [],
    "stateMutability": "nonpayable",
  },
  {
    "type": "function",
    "name": "redeem",
    "inputs": [
      { "name": "tokenId", "type": "uint256", "internalType": "uint256" },
      { "name": "holder", "type": "address", "internalType": "address" },
    ],
    "outputs": [
      { "name": "paid", "type": "uint256", "internalType": "uint256" },
      { "name": "inUsdg", "type": "bool", "internalType": "bool" },
    ],
    "stateMutability": "nonpayable",
  },
  {
    "type": "function",
    "name": "withdraw",
    "inputs": [
      { "name": "asset", "type": "address", "internalType": "address" },
      { "name": "amount", "type": "uint256", "internalType": "uint256" },
      { "name": "to", "type": "address", "internalType": "address" },
    ],
    "outputs": [],
    "stateMutability": "nonpayable",
  },
] as const;
