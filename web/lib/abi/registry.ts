// GENERATED from ops/abis/OvercallRegistry.abi.json — do not hand-edit.
//
// GROUND TRUTH (ops/recon/R1-overcall-registry.md): the cycle struct has NO status field. The
// gates are isWritingOpen() / isCycleLive() / writeDeadline(), and writeDeadline() == the
// cycle's exerciseTimestamp. Every countdown in this app reads these, never the wall clock.
//
// The NVDA registry is 0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA. There are 11 per-market
// registries; the `registry` key at the top level of Overcall's own frontend config is the
// JUGGERNAUT market and must never be wired in here.

export const overcallRegistryAbi = [
  {
    "name": "CycleIndexOutOfBounds",
    "type": "error",
    "inputs": [
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "count",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "CycleStillLive",
    "type": "error",
    "inputs": [
      {
        "name": "expiryTimestamp",
        "type": "uint40",
        "internalType": "uint40"
      }
    ]
  },
  {
    "name": "EmptyCycle",
    "type": "error",
    "inputs": []
  },
  {
    "name": "ExerciseAssetMismatch",
    "type": "error",
    "inputs": [
      {
        "name": "optionId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "expected",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "actual",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "name": "ExerciseNotInFuture",
    "type": "error",
    "inputs": [
      {
        "name": "exerciseAt",
        "type": "uint40",
        "internalType": "uint40"
      },
      {
        "name": "currentTime",
        "type": "uint40",
        "internalType": "uint40"
      }
    ]
  },
  {
    "name": "ExerciseTimestampMismatch",
    "type": "error",
    "inputs": [
      {
        "name": "optionId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "expected",
        "type": "uint40",
        "internalType": "uint40"
      },
      {
        "name": "actual",
        "type": "uint40",
        "internalType": "uint40"
      }
    ]
  },
  {
    "name": "ExerciseWindowTooShort",
    "type": "error",
    "inputs": [
      {
        "name": "exerciseAt",
        "type": "uint40",
        "internalType": "uint40"
      },
      {
        "name": "expireAt",
        "type": "uint40",
        "internalType": "uint40"
      },
      {
        "name": "minimumWindow",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "ExpiryTimestampMismatch",
    "type": "error",
    "inputs": [
      {
        "name": "optionId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "expected",
        "type": "uint40",
        "internalType": "uint40"
      },
      {
        "name": "actual",
        "type": "uint40",
        "internalType": "uint40"
      }
    ]
  },
  {
    "name": "IdenticalAssets",
    "type": "error",
    "inputs": [
      {
        "name": "asset",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "name": "LotSizeMismatch",
    "type": "error",
    "inputs": [
      {
        "name": "optionId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "expected",
        "type": "uint96",
        "internalType": "uint96"
      },
      {
        "name": "actual",
        "type": "uint96",
        "internalType": "uint96"
      }
    ]
  },
  {
    "name": "NotAnOptionType",
    "type": "error",
    "inputs": [
      {
        "name": "optionId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "OwnableInvalidOwner",
    "type": "error",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "name": "OwnableUnauthorizedAccount",
    "type": "error",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "name": "RenounceDisabled",
    "type": "error",
    "inputs": []
  },
  {
    "name": "StrikesNotAscending",
    "type": "error",
    "inputs": [
      {
        "name": "optionId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "previousStrike",
        "type": "uint96",
        "internalType": "uint96"
      },
      {
        "name": "strike",
        "type": "uint96",
        "internalType": "uint96"
      }
    ]
  },
  {
    "name": "TooManyStrikes",
    "type": "error",
    "inputs": [
      {
        "name": "provided",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "maximum",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "UnderlyingAssetMismatch",
    "type": "error",
    "inputs": [
      {
        "name": "optionId",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "expected",
        "type": "address",
        "internalType": "address"
      },
      {
        "name": "actual",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "name": "ZeroAddress",
    "type": "error",
    "inputs": []
  },
  {
    "name": "ZeroLotSize",
    "type": "error",
    "inputs": []
  },
  {
    "name": "ZeroStrike",
    "type": "error",
    "inputs": [
      {
        "name": "optionId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "name": "CycleSet",
    "type": "event",
    "inputs": [
      {
        "name": "number",
        "type": "uint32",
        "indexed": true,
        "internalType": "uint32"
      },
      {
        "name": "optionIds",
        "type": "uint256[]",
        "indexed": false,
        "internalType": "uint256[]"
      },
      {
        "name": "exerciseAt",
        "type": "uint40",
        "indexed": false,
        "internalType": "uint40"
      },
      {
        "name": "expireAt",
        "type": "uint40",
        "indexed": false,
        "internalType": "uint40"
      },
      {
        "name": "lotSize",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      }
    ],
    "anonymous": false
  },
  {
    "name": "LotSizeSet",
    "type": "event",
    "inputs": [
      {
        "name": "previousLotSize",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      },
      {
        "name": "newLotSize",
        "type": "uint96",
        "indexed": false,
        "internalType": "uint96"
      }
    ],
    "anonymous": false
  },
  {
    "name": "OwnershipTransferStarted",
    "type": "event",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "name": "OwnershipTransferred",
    "type": "event",
    "inputs": [
      {
        "name": "previousOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "newOwner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "name": "MAX_STRIKES",
    "type": "function",
    "inputs": [],
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
    "name": "MIN_EXERCISE_WINDOW",
    "type": "function",
    "inputs": [],
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
    "name": "activeOptionIds",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256[]",
        "internalType": "uint256[]"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "canReplaceCycle",
    "type": "function",
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
    "name": "clearinghouse",
    "type": "function",
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
    "name": "collateralToken",
    "type": "function",
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
    "name": "cycle",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "components": [
          {
            "name": "number",
            "type": "uint32",
            "internalType": "uint32"
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
            "name": "lotSize",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "optionIds",
            "type": "uint256[]",
            "internalType": "uint256[]"
          }
        ],
        "internalType": "struct IOvercallRegistry.Cycle"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "cycleAt",
    "type": "function",
    "inputs": [
      {
        "name": "index",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "tuple",
        "components": [
          {
            "name": "number",
            "type": "uint32",
            "internalType": "uint32"
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
            "name": "lotSize",
            "type": "uint96",
            "internalType": "uint96"
          },
          {
            "name": "optionIds",
            "type": "uint256[]",
            "internalType": "uint256[]"
          }
        ],
        "internalType": "struct IOvercallRegistry.Cycle"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "cycleCount",
    "type": "function",
    "inputs": [],
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
    "name": "cycleLotSize",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "cycleNumber",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "cycleOf",
    "type": "function",
    "inputs": [
      {
        "name": "optionId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint32",
        "internalType": "uint32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "exerciseTimestamp",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint40",
        "internalType": "uint40"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "exerciseToken",
    "type": "function",
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
    "name": "expiryTimestamp",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint40",
        "internalType": "uint40"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "isApproved",
    "type": "function",
    "inputs": [
      {
        "name": "optionId",
        "type": "uint256",
        "internalType": "uint256"
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
    "name": "isCycleLive",
    "type": "function",
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
    "name": "isWritingOpen",
    "type": "function",
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
    "name": "lotSize",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "owner",
    "type": "function",
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
    "name": "strikePerContract",
    "type": "function",
    "inputs": [
      {
        "name": "optionId",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [
      {
        "name": "strike",
        "type": "uint96",
        "internalType": "uint96"
      }
    ],
    "stateMutability": "view"
  },
  {
    "name": "writeDeadline",
    "type": "function",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint40",
        "internalType": "uint40"
      }
    ],
    "stateMutability": "view"
  },
] as const;
