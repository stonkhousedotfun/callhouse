import { buybackExecutorAbi } from "../../abis/v2/buybackExecutor";

/**
 * Event-only ABI from contracts/src/v2/periphery/V4BuybackExecutor.sol.
 *
 * The generated `buybackExecutorAbi` still comes from the frozen IBuybackExecutor artifact, which
 * declares `execute` but cannot declare implementation events. Keep this additive fragment outside
 * the generated ABI directory until C8-08 exports V4BuybackExecutor.json.
 */
export const buybackExecutorEventsAbi = [
  {
    type: "event",
    name: "Bought",
    inputs: [
      { name: "usdgIn", type: "uint256", internalType: "uint256", indexed: false },
      { name: "usdgSpent", type: "uint256", internalType: "uint256", indexed: false },
      { name: "wethOut", type: "uint256", internalType: "uint256", indexed: false },
      { name: "tokenOut", type: "uint256", internalType: "uint256", indexed: false },
      { name: "minWethOut", type: "uint256", internalType: "uint256", indexed: false },
      { name: "declaredFeeBps", type: "uint256", internalType: "uint256", indexed: false },
      { name: "measuredFeeBps", type: "uint256", internalType: "uint256", indexed: false },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Burned",
    inputs: [{ name: "amount", type: "uint256", internalType: "uint256", indexed: false }],
    anonymous: false,
  },
] as const;

/** Indexing surface while the concrete contract artifact has not replaced IBuybackExecutor. */
export const buybackExecutorIndexingAbi = [
  ...buybackExecutorAbi,
  ...buybackExecutorEventsAbi,
] as const;
