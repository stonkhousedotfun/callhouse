// Mirrored, not transcribed: the fragments below are copied verbatim from the Etherscan-verified ABIs
// (read 2026-09-23 through api.etherscan.io/v2 getsourcecode).
//
// universalRouterAbi — UniversalRouter at 0x8876789976decbfcbbbe364623c63652db8c0904 on chain 4663
//   (solc v0.8.26, the v4-era router: poolManager() returns the 4663 PoolManager). Kept: the deadline
//   overload execute(bytes,bytes[],uint256) and every error, so a revert decodes to a name.
//   THIS BUILD'S V3_SWAP_EXACT_IN INPUT HAS SIX FIELDS, not the five in older routers:
//   (address, uint256, uint256, bytes, bool, uint256[] minHopPriceX36) — the router's Dispatcher, V3_SWAP_EXACT_IN. Five-field
//   input reverts SliceOutOfBounds() (0x3b99b53d); measured on a 4663 fork.
//
// permit2Abi — Permit2 at 0x000000000022D473030F116dDEE9F6B43aC78BA3. Not verified on the 4663 explorer;
//   copied from the Ethereum mainnet verification of the same address (solc v0.8.17). Kept: allowance,
//   approve and every error. The router pulls ERC-20 input through Permit2 (PaymentsImmutables.PERMIT2).
export const universalRouterAbi = [
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "target",
        "type": "address"
      }
    ],
    "name": "AddressEmptyCode",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "account",
        "type": "address"
      }
    ],
    "name": "AddressInsufficientBalance",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "BalanceTooLow",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ContractLocked",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "Currency",
        "name": "currency",
        "type": "address"
      }
    ],
    "name": "DeltaNotNegative",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "Currency",
        "name": "currency",
        "type": "address"
      }
    ],
    "name": "DeltaNotPositive",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ECDSAInvalidSignature",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "length",
        "type": "uint256"
      }
    ],
    "name": "ECDSAInvalidSignatureLength",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "s",
        "type": "bytes32"
      }
    ],
    "name": "ECDSAInvalidSignatureS",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ETHNotAccepted",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "commandIndex",
        "type": "uint256"
      },
      {
        "internalType": "bytes",
        "name": "message",
        "type": "bytes"
      }
    ],
    "name": "ExecutionFailed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "FailedInnerCall",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "FromAddressIsNotOwner",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InputLengthMismatch",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InsufficientBalance",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InsufficientETH",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InsufficientToken",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "bytes4",
        "name": "action",
        "type": "bytes4"
      }
    ],
    "name": "InvalidAction",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidBips",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "commandType",
        "type": "uint256"
      }
    ],
    "name": "InvalidCommandType",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidEthSender",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidHopPriceLength",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidPath",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidPortion",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidReserves",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidShortString",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LengthMismatch",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NonceAlreadyUsed",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "tokenId",
        "type": "uint256"
      }
    ],
    "name": "NotAuthorizedForToken",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "NotPoolManager",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "OnlyMintAllowed",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      }
    ],
    "name": "SafeERC20FailedOperation",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "SliceOutOfBounds",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "string",
        "name": "str",
        "type": "string"
      }
    ],
    "name": "StringTooLong",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "TransactionDeadlinePassed",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "UnsafeCast",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "action",
        "type": "uint256"
      }
    ],
    "name": "UnsupportedAction",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "V2InvalidHopPriceLength",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "V2InvalidPath",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "V2TooLittleReceived",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "hopIndex",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minPrice",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "price",
        "type": "uint256"
      }
    ],
    "name": "V2TooLittleReceivedPerHop",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "V2TooMuchRequested",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "V3HopPriceAndPathLengthMismatch",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "V3InvalidAmountOut",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "V3InvalidCaller",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "V3InvalidSwap",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "V3TooLittleReceived",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "hopIndex",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minPrice",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "price",
        "type": "uint256"
      }
    ],
    "name": "V3TooLittleReceivedPerHop",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "V3TooMuchRequested",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "hopIndex",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minPrice",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "price",
        "type": "uint256"
      }
    ],
    "name": "V3TooMuchRequestedPerHop",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "minAmountOutReceived",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "amountReceived",
        "type": "uint256"
      }
    ],
    "name": "V4TooLittleReceived",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "hopIndex",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minPrice",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "price",
        "type": "uint256"
      }
    ],
    "name": "V4TooLittleReceivedPerHop",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "minPrice",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "price",
        "type": "uint256"
      }
    ],
    "name": "V4TooLittleReceivedPerHopSingle",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "maxAmountInRequested",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "amountRequested",
        "type": "uint256"
      }
    ],
    "name": "V4TooMuchRequested",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "hopIndex",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "minPrice",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "price",
        "type": "uint256"
      }
    ],
    "name": "V4TooMuchRequestedPerHop",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "minPrice",
        "type": "uint256"
      },
      {
        "internalType": "uint256",
        "name": "price",
        "type": "uint256"
      }
    ],
    "name": "V4TooMuchRequestedPerHopSingle",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "bytes",
        "name": "commands",
        "type": "bytes"
      },
      {
        "internalType": "bytes[]",
        "name": "inputs",
        "type": "bytes[]"
      },
      {
        "internalType": "uint256",
        "name": "deadline",
        "type": "uint256"
      }
    ],
    "name": "execute",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  }
] as const;

export const permit2Abi = [
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "deadline",
        "type": "uint256"
      }
    ],
    "name": "AllowanceExpired",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "ExcessiveInvalidation",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "amount",
        "type": "uint256"
      }
    ],
    "name": "InsufficientAllowance",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "maxAmount",
        "type": "uint256"
      }
    ],
    "name": "InvalidAmount",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidContractSignature",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidNonce",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidSignature",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidSignatureLength",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "InvalidSigner",
    "type": "error"
  },
  {
    "inputs": [],
    "name": "LengthMismatch",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "signatureDeadline",
        "type": "uint256"
      }
    ],
    "name": "SignatureExpired",
    "type": "error"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "name": "allowance",
    "outputs": [
      {
        "internalType": "uint160",
        "name": "amount",
        "type": "uint160"
      },
      {
        "internalType": "uint48",
        "name": "expiration",
        "type": "uint48"
      },
      {
        "internalType": "uint48",
        "name": "nonce",
        "type": "uint48"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "token",
        "type": "address"
      },
      {
        "internalType": "address",
        "name": "spender",
        "type": "address"
      },
      {
        "internalType": "uint160",
        "name": "amount",
        "type": "uint160"
      },
      {
        "internalType": "uint48",
        "name": "expiration",
        "type": "uint48"
      }
    ],
    "name": "approve",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const;
