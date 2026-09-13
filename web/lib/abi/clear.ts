// Derived from ops/abis/ValoremClear.json — maintained by hand: no generator exists for this
// file (unlike vault.ts, which scripts/gen-abis.mjs produces). Re-check it against the canonical
// artifact whenever ops/abis changes.
//
// The deployed 0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0 is the exact upstream
// ValoremOptionsClearinghouse (valorem-core @6436c823, solc 0.8.16). Read surface only —
// this app never writes or exercises.
//
// TRAP, from ops/recon/R4-valorem-abi.md: `claim(claimId)` returns amountWritten and
// amountExercised as 1e18-SCALED SCALARS, not contract counts. Divide by 1e18 before you
// show a number to a human. See scaleToContracts() in lib/format.ts.

export const valoremClearAbi = [
  {
    "type": "event",
    "name": "BucketAssignedExercise",
    "inputs": [
      {
        "name": "optionId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "bucketIndex",
        "type": "uint96",
        "indexed": true,
        "internalType": "uint96"
      },
      {
        "name": "amountAssigned",
        "type": "uint112",
        "indexed": false,
        "internalType": "uint112"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "ClaimRedeemed",
    "inputs": [
      {
        "name": "claimId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "optionId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "redeemer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "exerciseAmountRedeemed",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "underlyingAmountRedeemed",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "NewOptionType",
    "inputs": [
      {
        "name": "optionId",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "exerciseAsset",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "underlyingAsset",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "exerciseAmount",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      },
      {
        "name": "underlyingAmount",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      },
      {
        "name": "exerciseTimestamp",
        "type": "uint40",
        "indexed": false,
        "internalType": "uint40"
      },
      {
        "name": "expiryTimestamp",
        "type": "uint40",
        "indexed": true,
        "internalType": "uint40"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OptionsExercised",
    "inputs": [
      {
        "name": "optionId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "exerciser",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "amount",
        "type": "uint112",
        "indexed": false,
        "internalType": "uint112"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "OptionsWritten",
    "inputs": [
      {
        "name": "optionId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "writer",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "claimId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "amount",
        "type": "uint112",
        "indexed": false,
        "internalType": "uint112"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TransferBatch",
    "inputs": [
      {
        "name": "operator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "from",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "ids",
        "type": "uint256[]",
        "indexed": false,
        "internalType": "uint256[]"
      },
      {
        "name": "amounts",
        "type": "uint256[]",
        "indexed": false,
        "internalType": "uint256[]"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "TransferSingle",
    "inputs": [
      {
        "name": "operator",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "from",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "to",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "id",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "amount",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      }
    ],
    "anonymous": false
  },
  {
    "type": "function",
    "name": "balanceOf",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "claim",
    "inputs": [
      {
        "name": "claimId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "claimInfo",
        "type": "tuple",
        "internalType": "struct IValoremOptionsClearinghouse.Claim",
        "components": [
          {
            "name": "amountWritten",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "amountExercised",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "optionId",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "feeBps",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint8",
        "internalType": "uint8"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "feeTo",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "feesEnabled",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isApprovedForAll",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "option",
    "inputs": [
      {
        "name": "tokenId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "optionInfo",
        "type": "tuple",
        "internalType": "struct IValoremOptionsClearinghouse.Option",
        "components": [
          {
            "name": "underlyingAsset",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "underlyingAmount",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "exerciseAsset",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "exerciseAmount",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "exerciseTimestamp",
            "type": "uint40",
            "internalType": "uint40"
          },
          {
            "name": "expiryTimestamp",
            "type": "uint40",
            "internalType": "uint40"
          },
          {
            "name": "settlementSeed",
            "type": "uint160",
            "internalType": "uint160"
          },
          {
            "name": "nextClaimKey",
            "type": "uint96",
            "internalType": "uint96"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "position",
    "inputs": [
      {
        "name": "tokenId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "positionInfo",
        "type": "tuple",
        "internalType": "struct IValoremOptionsClearinghouse.Position",
        "components": [
          {
            "name": "underlyingAsset",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "underlyingAmount",
            "type": "int256",
            "internalType": "int256"
          },
          {
            "name": "exerciseAsset",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "exerciseAmount",
            "type": "int256",
            "internalType": "int256"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "tokenType",
    "inputs": [
      {
        "name": "tokenId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "typeOfToken",
        "type": "uint8",
        "internalType": "enum IValoremOptionsClearinghouse.TokenType"
      }
    ],
    "stateMutability": "view"
  },
] as const;
