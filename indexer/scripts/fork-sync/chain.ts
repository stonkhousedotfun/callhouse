/**
 * What the fork itself says happened, read straight from the anvil node the dry run drove.
 *
 * Nothing here comes from Ponder or from the indexer's database: logs are fetched with
 * `eth_getLogs` over [startBlock, endBlock] and decoded with viem, and the end state is read
 * with `eth_call` at `endBlock`. The keeper dry run's run.json is the other source of truth; the
 * expectation builder (expected.ts) cross-checks the two before either is compared to the API.
 */
import {
  createPublicClient,
  getAddress,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

import { erc20Abi } from "../../abis/erc20.ts";
import { overcallRegistryAbi } from "../../abis/overcallRegistry.ts";
import { seaportAbi } from "../../abis/seaport.ts";
import { stockTokenAbi } from "../../abis/stockToken.ts";
import { valoremClearAbi } from "../../abis/valoremClear.ts";
import { vaultAbi } from "../../abis/vault.ts";

export type ChainCycle = {
  cycleNumber: number;
  set: { txHash: Hex; block: bigint; timestamp: bigint; optionIds: string[]; exerciseAt: bigint; expireAt: bigint; lotSize: bigint } | null;
  open: { txHash: Hex; block: bigint; timestamp: bigint; optionId: bigint; contracts: bigint; strike: bigint } | null;
  written: { claimKey: bigint; collateral: bigint } | null;
  locked: { txHash: Hex; timestamp: bigint } | null;
  close: { txHash: Hex; block: bigint; timestamp: bigint; assetsReturned: bigint; usdgFromAssignment: bigint; contractsAssignedCount: bigint } | null;
  /** `accUsdgPerShare()` at the close block: the index the terminal harvest left behind. */
  accAfterClose: bigint | null;
  /** `totalSupply()` in the block before the close: the supply the terminal harvest indexed against. */
  supplyBeforeClose: bigint | null;
  /** `UsdgDistributed.totalSupply` in the close transaction, when the harvest distributed anything. */
  distributedSupply: bigint | null;
  /** Valorem `BucketWrittenInto` for this cycle's claim, emitted inside its rollOpen transaction. */
  bucketIndex: bigint | null;
  bucketAssigned: bigint;
  marketExercised: bigint;
};

export type ChainHarvest = { cycleNumber: number; txHash: Hex; block: bigint; timestamp: bigint; gross: bigint; fee: bigint; net: bigint };

export type ChainListing = {
  orderHash: Hex;
  optionId: bigint;
  amount: bigint;
  grossUsdg: bigint;
  seq: number;
  approvedTx: Hex;
  approvedBlock: bigint;
  approvedTimestamp: bigint;
  fills: Array<{ txHash: Hex; timestamp: bigint; contracts: bigint; toVault: bigint; toOvercall: bigint }>;
  /** ListingCancelled for this hash, and whether AllListingsInvalidated followed in the same tx. */
  cancelled: { txHash: Hex; timestamp: bigint; invalidated: boolean } | null;
};

export type ChainFacts = {
  rpc: string;
  chainId: number;
  endBlock: bigint;
  startBlock: bigint;
  vault: Address;
  depositor: Address;
  immutables: { asset: Address; usdg: Address; clear: Address; seaport: Address; registry: Address; overcallFeeRecipient: Address };
  settings: { feeRecipient: Address; depositCap: bigint; maxPriceAge: number; protocolFeeBps: number };
  cycles: ChainCycle[];
  harvests: ChainHarvest[];
  listings: ChainListing[];
  queue: {
    redeems: Array<{ owner: Address; shares: bigint; epochId: bigint }>;
    settled: Array<{ epochId: bigint; shares: bigint; assets: bigint; usdgOut: bigint; txHash: Hex; timestamp: bigint }>;
    entries: Array<{ owner: Address; epochId: bigint; shares: bigint; assets: bigint; usdgOut: bigint }>;
    completes: Array<{ owner: Address; shares: bigint; assets: bigint; usdgOut: bigint }>;
  };
  deposits: Array<{ owner: Address; assets: bigint; shares: bigint; timestamp: bigint }>;
  claims: Array<{ account: Address; amount: bigint }>;
  feeSwept: bigint;
  usdgDistributed: bigint;
  roles: Array<{ role: Hex; account: Address; granted: boolean }>;
  /** Block of the last log the indexer consumes that touches vault state (vault, its tokens, its orders). */
  lastVaultActivityBlock: bigint;
  lastVaultActivityTimestamp: bigint;
  endBlockTimestamp: bigint;
  /** First and last timestamps of vault events whose handlers touch the depositor's user row. */
  depositorFirstSeen: bigint | null;
  depositorLastActivity: bigint | null;
  views: {
    phase: number;
    writesHalted: boolean;
    canRedeemInstantly: boolean;
    valoremFeeAccepted: boolean;
    totalAssets: bigint;
    idleAssets: bigint;
    lockedAssets: bigint;
    reservedAssets: bigint;
    totalSupply: bigint;
    maxDepositZero: bigint;
    uiMultiplier: bigint;
    spotUsdg: bigint | null;
    listingHash: Hex;
    listingAmount: bigint;
    listingGrossUsdg: bigint;
    listingsThisCycle: number;
    queuedShares: bigint;
    usdgReservedForQueue: bigint;
    usdgUnallocated: bigint;
    accUsdgPerShare: bigint;
    totalUsdgDistributed: bigint;
    totalUsdgClaimed: bigint;
    epochId: bigint;
    contractsAssigned: bigint;
    contractsRemaining: bigint;
    contractsWritten: bigint;
    cycleNumber: number;
    pendingFeeUsdg: bigint;
    usdgBalance: bigint;
    assetBalance: bigint;
    seaportCounter: bigint;
    oraclePaused: boolean;
  };
  registryLive: {
    cycleNumber: number;
    exerciseTimestamp: bigint;
    expiryTimestamp: bigint;
    lotSize: bigint;
    isWritingOpen: boolean;
    isCycleLive: boolean;
    writeDeadline: bigint;
    rungs: Array<{ optionId: bigint; strike: bigint; approved: boolean }>;
  };
  account: {
    shares: bigint;
    sharesAsAssets: bigint;
    claimableUsdg: bigint;
    queuedShares: bigint;
    queuedEpoch: bigint;
    previewAssets: bigint;
    previewUsdg: bigint;
  };
};

const lower = (a: string) => a.toLowerCase();

export async function readChainFacts(opts: {
  rpc: string;
  vault: Address;
  depositor: Address;
  startBlock: bigint;
  registryStartBlock: bigint;
  endBlock: bigint;
}): Promise<ChainFacts> {
  const client: PublicClient = createPublicClient({ transport: http(opts.rpc) });
  const { vault, startBlock, endBlock } = opts;
  const at = { blockNumber: endBlock } as const;
  const V = { address: vault, abi: vaultAbi } as const;

  const chainId = await client.getChainId();

  const [asset, usdg, clear, seaport, registry, overcallFeeRecipient] = await Promise.all([
    client.readContract({ ...V, functionName: "asset", ...at }),
    client.readContract({ ...V, functionName: "usdg", ...at }),
    client.readContract({ ...V, functionName: "clear", ...at }),
    client.readContract({ ...V, functionName: "seaport", ...at }),
    client.readContract({ ...V, functionName: "registry", ...at }),
    client.readContract({ ...V, functionName: "overcallFeeRecipient", ...at }),
  ]);

  const timestamps = new Map<bigint, bigint>();
  const tsOf = async (block: bigint): Promise<bigint> => {
    const cached = timestamps.get(block);
    if (cached !== undefined) return cached;
    const b = await client.getBlock({ blockNumber: block });
    timestamps.set(block, b.timestamp);
    return b.timestamp;
  };

  const range = { fromBlock: startBlock, toBlock: endBlock } as const;
  const [vaultLogsRaw, clearLogsRaw, seaportLogsRaw, registryLogsRaw, assetLogsRaw, usdgLogsRaw] = await Promise.all([
    client.getLogs({ address: vault, ...range }),
    client.getLogs({ address: clear, ...range }),
    client.getLogs({ address: seaport, ...range }),
    client.getLogs({ address: registry, fromBlock: opts.registryStartBlock, toBlock: endBlock }),
    client.getLogs({ address: asset, ...range }),
    client.getLogs({ address: usdg, ...range }),
  ]);
  const vaultLogs = parseEventLogs({ abi: vaultAbi, logs: vaultLogsRaw });
  const clearLogs = parseEventLogs({ abi: valoremClearAbi, logs: clearLogsRaw });
  const seaportLogs = parseEventLogs({ abi: seaportAbi, logs: seaportLogsRaw });
  const registryLogs = parseEventLogs({ abi: overcallRegistryAbi, logs: registryLogsRaw });

  const ofEvent = <N extends string>(name: N) =>
    vaultLogs.filter((l): l is Extract<(typeof vaultLogs)[number], { eventName: N }> => l.eventName === name);

  /* ---- cycles ---- */
  const cycleNumbers = new Set<number>();
  for (const l of registryLogs) if (l.eventName === "CycleSet") cycleNumbers.add(Number(l.args.number));
  for (const l of ofEvent("RollOpen")) cycleNumbers.add(Number(l.args.cycleNumber));

  const cycles: ChainCycle[] = [];
  for (const n of [...cycleNumbers].sort((a, b) => a - b)) {
    const setLog = registryLogs.filter((l) => l.eventName === "CycleSet" && Number(l.args.number) === n).at(-1);
    const openLog = ofEvent("RollOpen").find((l) => Number(l.args.cycleNumber) === n);
    const lockLog = ofEvent("BookLocked").find((l) => Number(l.args.cycleNumber) === n);
    const closeLog = ofEvent("RollClose").find((l) => Number(l.args.cycleNumber) === n);
    const writtenLog = openLog === undefined ? undefined : ofEvent("CallsWritten").find((l) => l.transactionHash === openLog.transactionHash);
    const bucketLog =
      writtenLog === undefined
        ? undefined
        : clearLogs.find(
            (l) => l.eventName === "BucketWrittenInto" && l.transactionHash === writtenLog.transactionHash && l.args.claimId === writtenLog.args.claimKey,
          );
    const bucketIndex = bucketLog !== undefined && bucketLog.eventName === "BucketWrittenInto" ? BigInt(bucketLog.args.bucketIndex) : null;
    let bucketAssigned = 0n;
    let marketExercised = 0n;
    if (openLog !== undefined) {
      for (const l of clearLogs) {
        if (l.eventName === "BucketAssignedExercise" && l.args.optionId === openLog.args.optionId && bucketIndex !== null && BigInt(l.args.bucketIndex) === bucketIndex) {
          bucketAssigned += BigInt(l.args.amountAssigned);
        }
        if (l.eventName === "OptionsExercised" && l.args.optionId === openLog.args.optionId) marketExercised += BigInt(l.args.amount);
      }
    }
    const distributed =
      closeLog === undefined ? undefined : ofEvent("UsdgDistributed").find((l) => l.transactionHash === closeLog.transactionHash);

    cycles.push({
      cycleNumber: n,
      set:
        setLog === undefined || setLog.eventName !== "CycleSet"
          ? null
          : {
              txHash: setLog.transactionHash,
              block: setLog.blockNumber,
              timestamp: await tsOf(setLog.blockNumber),
              optionIds: setLog.args.optionIds.map(String),
              exerciseAt: BigInt(setLog.args.exerciseAt),
              expireAt: BigInt(setLog.args.expireAt),
              lotSize: BigInt(setLog.args.lotSize),
            },
      open:
        openLog === undefined
          ? null
          : {
              txHash: openLog.transactionHash,
              block: openLog.blockNumber,
              timestamp: await tsOf(openLog.blockNumber),
              optionId: openLog.args.optionId,
              contracts: BigInt(openLog.args.contractsCount),
              strike: openLog.args.strikeUsdg,
            },
      written: writtenLog === undefined ? null : { claimKey: writtenLog.args.claimKey, collateral: writtenLog.args.collateral },
      locked: lockLog === undefined ? null : { txHash: lockLog.transactionHash, timestamp: await tsOf(lockLog.blockNumber) },
      close:
        closeLog === undefined
          ? null
          : {
              txHash: closeLog.transactionHash,
              block: closeLog.blockNumber,
              timestamp: await tsOf(closeLog.blockNumber),
              assetsReturned: closeLog.args.assetsReturned,
              usdgFromAssignment: closeLog.args.usdgFromAssignment,
              contractsAssignedCount: closeLog.args.contractsAssignedCount,
            },
      accAfterClose:
        closeLog === undefined ? null : await client.readContract({ ...V, functionName: "accUsdgPerShare", blockNumber: closeLog.blockNumber }),
      supplyBeforeClose:
        closeLog === undefined
          ? null
          : await client.readContract({ ...V, functionName: "totalSupply", blockNumber: closeLog.blockNumber - 1n }),
      distributedSupply: distributed === undefined ? null : distributed.args.totalSupply,
      bucketIndex,
      bucketAssigned,
      marketExercised,
    });
  }

  /* ---- harvests ---- */
  const harvests: ChainHarvest[] = [];
  for (const l of ofEvent("Harvest")) {
    harvests.push({
      cycleNumber: Number(l.args.cycleNumber),
      txHash: l.transactionHash,
      block: l.blockNumber,
      timestamp: await tsOf(l.blockNumber),
      gross: l.args.grossUsdg,
      fee: l.args.feeUsdg,
      net: l.args.netUsdg,
    });
  }

  /* ---- listings ---- */
  const listings: ChainListing[] = [];
  for (const l of ofEvent("ListingApproved")) {
    const fills: ChainListing["fills"] = [];
    for (const s of seaportLogs) {
      if (s.eventName !== "OrderFulfilled" || s.args.orderHash !== l.args.orderHash || lower(s.args.offerer) !== lower(vault)) continue;
      let contracts = 0n;
      for (const item of s.args.offer) if (item.itemType === 3 && lower(item.token) === lower(clear)) contracts += item.amount;
      let toVault = 0n;
      let toOvercall = 0n;
      for (const item of s.args.consideration) {
        if (item.itemType !== 1 || lower(item.token) !== lower(usdg)) continue;
        if (lower(item.recipient) === lower(vault)) toVault += item.amount;
        else if (lower(item.recipient) === lower(overcallFeeRecipient)) toOvercall += item.amount;
      }
      fills.push({ txHash: s.transactionHash, timestamp: await tsOf(s.blockNumber), contracts, toVault, toOvercall });
    }
    const cancelLog = ofEvent("ListingCancelled").find((c) => c.args.orderHash === l.args.orderHash);
    listings.push({
      orderHash: l.args.orderHash,
      optionId: l.args.optionId,
      amount: l.args.amount,
      grossUsdg: l.args.grossUsdg,
      seq: Number(l.args.seq),
      approvedTx: l.transactionHash,
      approvedBlock: l.blockNumber,
      approvedTimestamp: await tsOf(l.blockNumber),
      fills,
      cancelled:
        cancelLog === undefined
          ? null
          : {
              txHash: cancelLog.transactionHash,
              timestamp: await tsOf(cancelLog.blockNumber),
              invalidated: ofEvent("AllListingsInvalidated").some((a) => a.transactionHash === cancelLog.transactionHash),
            },
    });
  }

  /* ---- queue, deposits, claims, fees, roles ---- */
  const queue: ChainFacts["queue"] = {
    redeems: ofEvent("QueueRedeem").map((l) => ({ owner: l.args.owner, shares: l.args.shares, epochId: l.args.epochId })),
    settled: await Promise.all(
      ofEvent("QueueSettled").map(async (l) => ({
        epochId: l.args.epochId,
        shares: l.args.shares,
        assets: l.args.assets,
        usdgOut: l.args.usdgOut,
        txHash: l.transactionHash,
        timestamp: await tsOf(l.blockNumber),
      })),
    ),
    entries: ofEvent("QueueEntrySettled").map((l) => ({ owner: l.args.owner, epochId: l.args.epochId, shares: l.args.shares, assets: l.args.assets, usdgOut: l.args.usdgOut })),
    completes: ofEvent("CompleteRedeem").map((l) => ({ owner: l.args.owner, shares: l.args.shares, assets: l.args.assets, usdgOut: l.args.usdgOut })),
  };
  const deposits = await Promise.all(
    ofEvent("Deposit").map(async (l) => ({ owner: l.args.owner, assets: l.args.assets, shares: l.args.shares, timestamp: await tsOf(l.blockNumber) })),
  );
  const claims = ofEvent("ClaimUsdg").map((l) => ({ account: l.args.account, amount: l.args.amount }));
  const feeSwept = ofEvent("FeeSwept").reduce((s, l) => s + l.args.amount, 0n);
  const usdgDistributed = ofEvent("UsdgDistributed").reduce((s, l) => s + l.args.amount, 0n);
  const roleState = new Map<string, { role: Hex; account: Address; granted: boolean }>();
  for (const l of vaultLogs) {
    if (l.eventName !== "RoleGranted" && l.eventName !== "RoleRevoked") continue;
    roleState.set(`${l.args.role}-${lower(l.args.account)}`, { role: l.args.role, account: l.args.account, granted: l.eventName === "RoleGranted" });
  }

  // The indexer's `lastBlock` moves on the handlers that patch vault state: most vault events
  // (not share Transfer/Approval, Deposit, Withdraw, QueueEntrySettled or the role events), token
  // transfers in or out of the vault, Seaport fills and counters for it, registry cycles and
  // Valorem writes by it. The latest of those is what /v1/health reports as last activity.
  const noLastBlock = new Set(["Transfer", "Approval", "Deposit", "Withdraw", "QueueEntrySettled", "RoleGranted", "RoleRevoked", "RoleAdminChanged"]);
  const activity: bigint[] = [
    ...vaultLogs.filter((l) => !noLastBlock.has(l.eventName)).map((l) => l.blockNumber),
    ...clearLogs.filter((l) => l.eventName === "OptionsWritten" && lower(l.args.writer) === lower(vault)).map((l) => l.blockNumber),
    ...registryLogs.map((l) => l.blockNumber),
    ...seaportLogs.filter((l) => "offerer" in l.args && lower(l.args.offerer as string) === lower(vault)).map((l) => l.blockNumber),
    ...[...parseEventLogs({ abi: erc20Abi, logs: [...assetLogsRaw, ...usdgLogsRaw], eventName: "Transfer" })]
      .filter((l) => lower(l.args.from) === lower(vault) || lower(l.args.to) === lower(vault))
      .map((l) => l.blockNumber),
  ];
  const lastVaultActivityBlock = activity.reduce((m, b) => (b > m ? b : m), 0n);

  // Handlers that call getUser(): share Transfer (either side), Deposit/Withdraw owner, QueueRedeem,
  // QueueEntrySettled, CompleteRedeem owner, ClaimUsdg account.
  const dep = lower(opts.depositor);
  const userBlocks = vaultLogs
    .filter((l) => {
      const a = l.args as Record<string, unknown>;
      const is = (k: string) => typeof a[k] === "string" && lower(a[k] as string) === dep;
      switch (l.eventName) {
        case "Transfer":
          return (is("from") || is("to")) && (a.value as bigint) !== 0n;
        case "Deposit":
        case "Withdraw":
        case "QueueRedeem":
        case "QueueEntrySettled":
        case "CompleteRedeem":
          return is("owner");
        case "ClaimUsdg":
          return is("account");
        default:
          return false;
      }
    })
    .map((l) => l.blockNumber);

  /* ---- end state ---- */
  const read = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> =>
    client.readContract({ ...V, functionName: functionName as never, args: args as never, ...at }) as Promise<T>;
  const policy = await read<readonly [number, number, number, number, number, bigint]>("policy");
  let spotUsdg: bigint | null = null;
  try {
    spotUsdg = await read<bigint>("spotUsdg");
  } catch {
    spotUsdg = null;
  }
  const views: ChainFacts["views"] = {
    phase: await read<number>("phase"),
    writesHalted: await read<boolean>("writesHalted"),
    canRedeemInstantly: await read<boolean>("canRedeemInstantly"),
    valoremFeeAccepted: await read<boolean>("valoremFeeAccepted"),
    totalAssets: await read<bigint>("totalAssets"),
    idleAssets: await read<bigint>("idleAssets"),
    lockedAssets: await read<bigint>("lockedAssets"),
    reservedAssets: await read<bigint>("reservedAssets"),
    totalSupply: await read<bigint>("totalSupply"),
    maxDepositZero: await read<bigint>("maxDeposit", ["0x0000000000000000000000000000000000000000"]),
    uiMultiplier: await read<bigint>("uiMultiplier"),
    spotUsdg,
    listingHash: await read<Hex>("listingHash"),
    listingAmount: await read<bigint>("listingAmount"),
    listingGrossUsdg: await read<bigint>("listingGrossUsdg"),
    listingsThisCycle: await read<number>("listingsThisCycle"),
    queuedShares: await read<bigint>("queuedShares"),
    usdgReservedForQueue: await read<bigint>("usdgReservedForQueue"),
    usdgUnallocated: await read<bigint>("usdgUnallocated"),
    accUsdgPerShare: await read<bigint>("accUsdgPerShare"),
    totalUsdgDistributed: await read<bigint>("totalUsdgDistributed"),
    totalUsdgClaimed: await read<bigint>("totalUsdgClaimed"),
    epochId: await read<bigint>("epochId"),
    contractsAssigned: await read<bigint>("contractsAssigned"),
    contractsRemaining: await read<bigint>("contractsRemaining"),
    contractsWritten: await read<bigint>("contractsWritten"),
    cycleNumber: await read<number>("cycleNumber"),
    pendingFeeUsdg: await read<bigint>("pendingFeeUsdg"),
    usdgBalance: await client.readContract({ address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [vault], ...at }),
    assetBalance: await client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [vault], ...at }),
    seaportCounter: await client.readContract({ address: seaport, abi: seaportAbi, functionName: "getCounter", args: [vault], ...at }),
    oraclePaused: await client.readContract({ address: asset, abi: stockTokenAbi, functionName: "oraclePaused", ...at }),
  };

  const R = { address: registry, abi: overcallRegistryAbi, ...at } as const;
  const liveCycle = await client.readContract({ ...R, functionName: "cycle" });
  const rungs = [];
  for (const optionId of liveCycle.optionIds) {
    rungs.push({
      optionId,
      strike: BigInt(await client.readContract({ ...R, functionName: "strikePerContract", args: [optionId] })),
      approved: await client.readContract({ ...R, functionName: "isApproved", args: [optionId] }),
    });
  }
  const registryLive: ChainFacts["registryLive"] = {
    cycleNumber: Number(liveCycle.number),
    exerciseTimestamp: BigInt(liveCycle.exerciseTimestamp),
    expiryTimestamp: BigInt(liveCycle.expiryTimestamp),
    lotSize: BigInt(liveCycle.lotSize),
    isWritingOpen: await client.readContract({ ...R, functionName: "isWritingOpen" }),
    isCycleLive: await client.readContract({ ...R, functionName: "isCycleLive" }),
    writeDeadline: BigInt(await client.readContract({ ...R, functionName: "writeDeadline" })),
    rungs,
  };

  const shares = await read<bigint>("balanceOf", [opts.depositor]);
  const [previewAssets, previewUsdg] = await read<readonly [bigint, bigint]>("previewCompleteRedeem", [opts.depositor]);
  const account: ChainFacts["account"] = {
    shares,
    sharesAsAssets: await read<bigint>("convertToAssets", [shares]),
    claimableUsdg: await read<bigint>("claimableUsdg", [opts.depositor]),
    queuedShares: await read<bigint>("queuedSharesOf", [opts.depositor]),
    queuedEpoch: await read<bigint>("queuedEpochOf", [opts.depositor]),
    previewAssets,
    previewUsdg,
  };

  return {
    rpc: opts.rpc,
    chainId,
    endBlock,
    startBlock,
    vault: getAddress(vault),
    depositor: getAddress(opts.depositor),
    immutables: { asset, usdg, clear, seaport, registry, overcallFeeRecipient },
    settings: {
      feeRecipient: await read<Address>("feeRecipient"),
      depositCap: await read<bigint>("depositCap"),
      maxPriceAge: await read<number>("maxPriceAge"),
      protocolFeeBps: Number(policy[4]),
    },
    cycles,
    harvests,
    listings,
    queue,
    deposits,
    claims,
    feeSwept,
    usdgDistributed,
    roles: [...roleState.values()],
    lastVaultActivityBlock,
    lastVaultActivityTimestamp: lastVaultActivityBlock === 0n ? 0n : await tsOf(lastVaultActivityBlock),
    endBlockTimestamp: await tsOf(endBlock),
    depositorFirstSeen: userBlocks.length === 0 ? null : await tsOf(userBlocks.reduce((m, b) => (b < m ? b : m))),
    depositorLastActivity: userBlocks.length === 0 ? null : await tsOf(userBlocks.reduce((m, b) => (b > m ? b : m))),
    views,
    registryLive,
    account,
  };
}
