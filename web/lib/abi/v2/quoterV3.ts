// Mirrored, not transcribed: copied verbatim from the Etherscan-verified ABI of the Uniswap v3 QuoterV2 at
// 0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7 on chain 4663 (solc v0.7.6; read 2026-09-23 through
// api.etherscan.io/v2 getsourcecode). The address is the registry's v2.uniswapV3.quoterV2
// (V2_UNISWAP_V3 in lib/markets.generated.ts). On chain it answers factory() = the v3 factory
// 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA and WETH9() = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73.
//
// The quote functions are nonpayable, not view: QuoterV2 runs the swap and reverts with the result.
// Call them with eth_call (viem simulateContract), never as a transaction.
export const quoterV3Abi = [
  {
    "inputs": [],
    "name": "WETH9",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "factory",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes",
        "name": "path",
        "type": "bytes"
      },
      {
        "internalType": "uint256",
        "name": "amountIn",
        "type": "uint256"
      }
    ],
    "name": "quoteExactInput",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "amountOut",
        "type": "uint256"
      },
      {
        "internalType": "uint160[]",
        "name": "sqrtPriceX96AfterList",
        "type": "uint160[]"
      },
      {
        "internalType": "uint32[]",
        "name": "initializedTicksCrossedList",
        "type": "uint32[]"
      },
      {
        "internalType": "uint256",
        "name": "gasEstimate",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "components": [
          {
            "internalType": "address",
            "name": "tokenIn",
            "type": "address"
          },
          {
            "internalType": "address",
            "name": "tokenOut",
            "type": "address"
          },
          {
            "internalType": "uint256",
            "name": "amountIn",
            "type": "uint256"
          },
          {
            "internalType": "uint24",
            "name": "fee",
            "type": "uint24"
          },
          {
            "internalType": "uint160",
            "name": "sqrtPriceLimitX96",
            "type": "uint160"
          }
        ],
        "internalType": "struct IQuoterV2.QuoteExactInputSingleParams",
        "name": "params",
        "type": "tuple"
      }
    ],
    "name": "quoteExactInputSingle",
    "outputs": [
      {
        "internalType": "uint256",
        "name": "amountOut",
        "type": "uint256"
      },
      {
        "internalType": "uint160",
        "name": "sqrtPriceX96After",
        "type": "uint160"
      },
      {
        "internalType": "uint32",
        "name": "initializedTicksCrossed",
        "type": "uint32"
      },
      {
        "internalType": "uint256",
        "name": "gasEstimate",
        "type": "uint256"
      }
    ],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;

// slot0() of a Uniswap v3 pool, copied verbatim from the Etherscan-verified UniswapV3Pool ABI at
// 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3 on chain 4663 (solc v0.7.6). Every v3 pool shares this
// surface; stockSwap.ts reads the pre-trade sqrtPriceX96 from it to measure a quote's price impact.
export const uniswapV3PoolAbi = [
  {
    "inputs": [],
    "name": "slot0",
    "outputs": [
      {
        "internalType": "uint160",
        "name": "sqrtPriceX96",
        "type": "uint160"
      },
      {
        "internalType": "int24",
        "name": "tick",
        "type": "int24"
      },
      {
        "internalType": "uint16",
        "name": "observationIndex",
        "type": "uint16"
      },
      {
        "internalType": "uint16",
        "name": "observationCardinality",
        "type": "uint16"
      },
      {
        "internalType": "uint16",
        "name": "observationCardinalityNext",
        "type": "uint16"
      },
      {
        "internalType": "uint8",
        "name": "feeProtocol",
        "type": "uint8"
      },
      {
        "internalType": "bool",
        "name": "unlocked",
        "type": "bool"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  }
] as const;
