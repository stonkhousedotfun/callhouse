// FROZEN v7 run-off subset copied from
// e8e4457c3356f58d2a93ee09094d37f7c971590d:web/lib/abi/v2/orderBook.ts.
// Never regenerate this file: web/scripts/gen-abis.mjs owns lib/abi/v2 only.
export const v7OrderBookAbi = [
  {
    "type": "function",
    "name": "cancel",
    "inputs": [
      { "name": "orderIds", "type": "uint256[]", "internalType": "uint256[]" },
    ],
    "outputs": [],
    "stateMutability": "nonpayable",
  },
  {
    "type": "function",
    "name": "claimOwed",
    "inputs": [],
    "outputs": [],
    "stateMutability": "nonpayable",
  },
] as const;
