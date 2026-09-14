/**
 * What the fork itself says happened, read straight from the anvil node the dry run drove.
 *
 * Nothing here comes from Ponder or from the indexer's database: logs are fetched with
 * `eth_getLogs` over [startBlock, endBlock] and decoded with viem, and the end state is read
 * with `eth_call` at `endBlock`. The keeper dry run's run.json is the other source of truth; the
 * expectation builder (expected.ts) cross-checks the two before either is compared to the API.
 *
 * Under write on fill the vault is the clock: a cycle is a `RollOpen`, its writes are the
 * `CallsWritten` on that option id (one per fill), and a stranded close is a `ClaimStranded` in
 * the `rollClose` transaction. There is no registry to read.
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
import { seaportAbi } from "../../abis/seaport.ts";
import { stockTokenAbi } from "../../abis/stockToken.ts";
import { valoremClearAbi } from "../../abis/valoremClear.ts";
import { vaultAbi } from "../../abis/vault.ts";

export type ChainCycle = {
  cycleNumber: number;
  /** `RollOpen`, plus the option's window read from the vault at that block. */
  open: { txHash: Hex; block: bigint; timestamp: bigint; optionId: bigint; strike: bigint; exerciseTs: bigint; expiryTs: bigint } | null;
  /** Every `CallsWritten` on this cycle's option id: one per fill. */
  writes: Array<{ txHash: Hex; timestamp: bigint; claimKey: bigint; contracts: bigint; collateral: bigint }>;
  locked: { txHash: Hex; timestamp: bigint } | null;
  close: { txHash: Hex; block: bigint; timestamp: bigint; assetsReturned: bigint; usdgFromAssignment: bigint; contractsAssignedCount: bigint } | null;
  /** `ClaimStranded` in the close transaction, if the redeem reverted. */
  stranded: { gen: bigint; claimKey: bigint } | null;
  /** `accUsdgPerShare()` at the close block: the index the terminal harvest left behind. */
  accAfterClose: bigint | null;
  /** `totalSupply()` in the block before the close: the supply the terminal harvest indexed against. */
  supplyBeforeClose: bigint | null;
  /** `UsdgDistributed.totalSupply` in the close transaction, when the harvest distributed anything. */
  distributedSupply: bigint | null;
  /** Valorem `BucketWrittenInto` for this cycle's claim, emitted inside its first fill. */
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
  /** Seaport fills: the contracts moved and the one USDG consideration item, to the vault. */
  fills: Array<{ txHash: Hex; timestamp: bigint; contracts: bigint; toVault: bigint }>;
  /** ListingCancelled for this hash, and what else the same transaction did (the end reason). */
  cancelled: { txHash: Hex; timestamp: bigint; reason: "cancelled" | "counter" | "lockBook" | "rollClose" } | null;
};

export type ChainStrand = {
  gen: bigint;
  cycleNumber: number;
  claimKey: bigint;
  strandedTx: Hex;
  epochShares: Array<{ epochId: bigint; wad: bigint }>;
  recovered: { txHash: Hex; assets: bigint; usdgOut: bigint; queueWad: bigint } | null;
};

export type ChainFacts = {
  rpc: string;
  chainId: number;
  endBlock: bigint;
  startBlock: bigint;
  vault: Address;
  depositor: Address;
  immutables: { asset: Address; usdg: Address; clear: Address; seaport: Address };
  settings: { feeRecipient: Address; depositCap: bigint; maxPriceAge: number; protocolFeeBps: number; maxUtilizationBps: number; maxContractsCap: bigint };
  cycles: ChainCycle[];
  harvests: ChainHarvest[];
  listings: ChainListing[];
  strands: ChainStrand[];
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
    cycleNumber: number;
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
    contractsWritten: bigint;
    optionId: bigint;
    claimKey: bigint;
    cycleStrikeUsdg: bigint;
    cycleExerciseTs: bigint;
    cycleExpiryTs: bigint;
    isStranded: boolean;
    strandGen: bigint;
    lastResolvedGen: bigint;
    strandedRemainingWad: bigint;
    pendingFeeUsdg: bigint;
    usdgBalance: bigint;
    assetBalance: bigint;
    seaportCounter: bigint;
    oraclePaused: boolean;
  };
  account: {
    shares: bigint;
    sharesAsAssets: bigint;
    claimableUsdg: bigint;
    queuedShares: bigint;
    queuedEpoch: bigint;
    previewAssets: bigint;
    previewUsdg: bigint;
    owedStrandWad: bigint;
    owedStrandGen: bigint;
  };
};

const lower = (a: string) => a.toLowerCase();

export async function readChainFacts(opts: {
  rpc: string;
  vault: Address;
  depositor: Address;
  startBlock: bigint;
  endBlock: bigint;
}): Promise<ChainFacts> {
  const client: PublicClient = createPublicClient({ transport: http(opts.rpc) });
  const { vault, startBlock, endBlock } = opts;

  const chainId = await client.getChainId();

  // The vault ABI is 245 entries and viem's inference over it exceeds TypeScript's instantiation
  // depth, so every vault read goes through this one untyped seam. Each name below is a real view.
  const readAt = <T>(functionName: string, args: readonly unknown[] = [], blockNumber: bigint = endBlock): Promise<T> =>
    client.readContract({ address: vault, abi: vaultAbi, functionName: functionName as never, args: args as never, blockNumber }) as Promise<T>;
  const read = <T>(functionName: string, args: readonly unknown[] = []): Promise<T> => readAt<T>(functionName, args);

  const [asset, usdg, clear, seaport] = await Promise.all([
    read<Address>("asset"),
    read<Address>("usdg"),
    read<Address>("clear"),
    read<Address>("seaport"),
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
  const [vaultLogsRaw, clearLogsRaw, seaportLogsRaw, assetLogsRaw, usdgLogsRaw] = await Promise.all([
    client.getLogs({ address: vault, ...range }),
    client.getLogs({ address: clear, ...range }),
    client.getLogs({ address: seaport, ...range }),
    client.getLogs({ address: asset, ...range }),
    client.getLogs({ address: usdg, ...range }),
  ]);
  const vaultLogs = parseEventLogs({ abi: vaultAbi, logs: vaultLogsRaw });
  const clearLogs = parseEventLogs({ abi: valoremClearAbi, logs: clearLogsRaw });
  const seaportLogs = parseEventLogs({ abi: seaportAbi, logs: seaportLogsRaw });

  const ofEvent = <N extends string>(name: N) =>
    vaultLogs.filter((l): l is Extract<(typeof vaultLogs)[number], { eventName: N }> => l.eventName === name);

  /* ---- cycles ---- */
  const cycles: ChainCycle[] = [];
  for (const openLog of ofEvent("RollOpen")) {
    const n = Number(openLog.args.cycleNumber);
    const lockLog = ofEvent("BookLocked").find((l) => Number(l.args.cycleNumber) === n);
    const closeLog = ofEvent("RollClose").find((l) => Number(l.args.cycleNumber) === n);
    const strandLog = ofEvent("ClaimStranded").find((l) => Number(l.args.cycleNumber) === n);
    // Every fill's write on this cycle's option id, between the open and the close.
    const writeLogs = ofEvent("CallsWritten").filter(
      (l) =>
        l.args.optionId === openLog.args.optionId &&
        l.blockNumber >= openLog.blockNumber &&
        (closeLog === undefined || l.blockNumber <= closeLog.blockNumber),
    );
    const firstWrite = writeLogs[0];
    const bucketLog =
      firstWrite === undefined
        ? undefined
        : clearLogs.find(
            (l) => l.eventName === "BucketWrittenInto" && l.transactionHash === firstWrite.transactionHash && l.args.claimId === firstWrite.args.claimKey,
          );
    const bucketIndex = bucketLog !== undefined && bucketLog.eventName === "BucketWrittenInto" ? BigInt(bucketLog.args.bucketIndex) : null;
    let bucketAssigned = 0n;
    let marketExercised = 0n;
    for (const l of clearLogs) {
      if (l.eventName === "BucketAssignedExercise" && l.args.optionId === openLog.args.optionId && bucketIndex !== null && BigInt(l.args.bucketIndex) === bucketIndex) {
        bucketAssigned += BigInt(l.args.amountAssigned);
      }
      if (l.eventName === "OptionsExercised" && l.args.optionId === openLog.args.optionId) marketExercised += BigInt(l.args.amount);
    }
    const distributed =
      closeLog === undefined ? undefined : ofEvent("UsdgDistributed").find((l) => l.transactionHash === closeLog.transactionHash);

    const writes: ChainCycle["writes"] = [];
    for (const w of writeLogs) {
      writes.push({ txHash: w.transactionHash, timestamp: await tsOf(w.blockNumber), claimKey: w.args.claimKey, contracts: BigInt(w.args.contractsCount), collateral: w.args.collateral });
    }

    cycles.push({
      cycleNumber: n,
      open: {
        txHash: openLog.transactionHash,
        block: openLog.blockNumber,
        timestamp: await tsOf(openLog.blockNumber),
        optionId: openLog.args.optionId,
        strike: openLog.args.strikeUsdg,
        exerciseTs: BigInt(await readAt<bigint | number>("cycleExerciseTs", [], openLog.blockNumber)),
        expiryTs: BigInt(await readAt<bigint | number>("cycleExpiryTs", [], openLog.blockNumber)),
      },
      writes,
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
      stranded: strandLog === undefined ? null : { gen: strandLog.args.gen, claimKey: strandLog.args.claimKey },
      accAfterClose: closeLog === undefined ? null : await readAt<bigint>("accUsdgPerShare", [], closeLog.blockNumber),
      supplyBeforeClose: closeLog === undefined ? null : await readAt<bigint>("totalSupply", [], closeLog.blockNumber - 1n),
      distributedSupply: distributed === undefined ? null : distributed.args.totalSupply,
      bucketIndex,
      bucketAssigned,
      marketExercised,
    });
  }
  cycles.sort((a, b) => a.cycleNumber - b.cycleNumber);

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
      for (const item of s.args.consideration) {
        if (item.itemType === 1 && lower(item.token) === lower(usdg) && lower(item.recipient) === lower(vault)) toVault += item.amount;
      }
      fills.push({ txHash: s.transactionHash, timestamp: await tsOf(s.blockNumber), contracts, toVault });
    }
    const cancelLog = ofEvent("ListingCancelled").find((c) => c.args.orderHash === l.args.orderHash);
    let cancelled: ChainListing["cancelled"] = null;
    if (cancelLog !== undefined) {
      const tx = cancelLog.transactionHash;
      const reason: NonNullable<ChainListing["cancelled"]>["reason"] = ofEvent("RollClose").some((x) => x.transactionHash === tx)
        ? "rollClose"
        : ofEvent("BookLocked").some((x) => x.transactionHash === tx)
          ? "lockBook"
          : ofEvent("AllListingsInvalidated").some((x) => x.transactionHash === tx)
            ? "counter"
            : "cancelled";
      cancelled = { txHash: tx, timestamp: await tsOf(cancelLog.blockNumber), reason };
    }
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
      cancelled,
    });
  }

  /* ---- stranded claims ---- */
  const strands: ChainStrand[] = ofEvent("ClaimStranded").map((l) => {
    const recoveredLog = ofEvent("StrandedClaimRecovered").find((r) => r.args.gen === l.args.gen);
    return {
      gen: l.args.gen,
      cycleNumber: Number(l.args.cycleNumber),
      claimKey: l.args.claimKey,
      strandedTx: l.transactionHash,
      epochShares: ofEvent("EpochStrandShare")
        .filter((e) => e.args.gen === l.args.gen)
        .map((e) => ({ epochId: e.args.epochId, wad: e.args.wad })),
      recovered:
        recoveredLog === undefined
          ? null
          : { txHash: recoveredLog.transactionHash, assets: recoveredLog.args.assets, usdgOut: recoveredLog.args.usdgOut, queueWad: recoveredLog.args.queueWad },
    };
  });

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
  // (not share Transfer/Approval, Deposit, Withdraw, QueueEntrySettled, StrandShareSettled or the
  // role events), token transfers in or out of the vault, Seaport fills and counters for it, and
  // Valorem writes by it. The latest of those is what /v1/health reports as last activity.
  const noLastBlock = new Set(["Transfer", "Approval", "Deposit", "Withdraw", "QueueEntrySettled", "StrandShareSettled", "RoleGranted", "RoleRevoked", "RoleAdminChanged"]);
  const activity: bigint[] = [
    ...vaultLogs.filter((l) => !noLastBlock.has(l.eventName)).map((l) => l.blockNumber),
    ...clearLogs.filter((l) => l.eventName === "OptionsWritten" && lower(l.args.writer) === lower(vault)).map((l) => l.blockNumber),
    ...seaportLogs.filter((l) => "offerer" in l.args && lower(l.args.offerer as string) === lower(vault)).map((l) => l.blockNumber),
    ...[...parseEventLogs({ abi: erc20Abi, logs: [...assetLogsRaw, ...usdgLogsRaw], eventName: "Transfer" })]
      .filter((l) => lower(l.args.from) === lower(vault) || lower(l.args.to) === lower(vault))
      .map((l) => l.blockNumber),
  ];
  const lastVaultActivityBlock = activity.reduce((m, b) => (b > m ? b : m), 0n);

  // Handlers that call getUser(): share Transfer (either side), Deposit/Withdraw owner, QueueRedeem,
  // QueueEntrySettled, StrandShareSettled, ReserveHaircut, UsdgLegDeferred, CompleteRedeem owner,
  // ClaimUsdg account.
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
        case "StrandShareSettled":
        case "ReserveHaircut":
        case "UsdgLegDeferred":
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
  const policy = await read<readonly [number, number, number, number, number, bigint]>("policy");
  let spotUsdg: bigint | null = null;
  try {
    spotUsdg = await read<bigint>("spotUsdg");
  } catch {
    spotUsdg = null;
  }
  const at = { blockNumber: endBlock } as const;
  const views: ChainFacts["views"] = {
    phase: await read<number>("phase"),
    cycleNumber: await read<number>("cycleNumber"),
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
    contractsWritten: BigInt(await read<bigint | number>("contractsWritten")),
    optionId: await read<bigint>("optionId"),
    claimKey: await read<bigint>("claimKey"),
    cycleStrikeUsdg: await read<bigint>("cycleStrikeUsdg"),
    cycleExerciseTs: BigInt(await read<bigint | number>("cycleExerciseTs")),
    cycleExpiryTs: BigInt(await read<bigint | number>("cycleExpiryTs")),
    isStranded: await read<boolean>("isStranded"),
    strandGen: await read<bigint>("strandGen"),
    lastResolvedGen: await read<bigint>("lastResolvedGen"),
    strandedRemainingWad: await read<bigint>("strandedRemainingWad"),
    pendingFeeUsdg: await read<bigint>("pendingFeeUsdg"),
    usdgBalance: await client.readContract({ address: usdg, abi: erc20Abi, functionName: "balanceOf", args: [vault], ...at }),
    assetBalance: await client.readContract({ address: asset, abi: erc20Abi, functionName: "balanceOf", args: [vault], ...at }),
    seaportCounter: await client.readContract({ address: seaport, abi: seaportAbi, functionName: "getCounter", args: [vault], ...at }),
    oraclePaused: await client.readContract({ address: asset, abi: stockTokenAbi, functionName: "oraclePaused", ...at }),
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
    owedStrandWad: await read<bigint>("owedStrandWad", [opts.depositor]),
    owedStrandGen: await read<bigint>("owedStrandGen", [opts.depositor]),
  };

  return {
    rpc: opts.rpc,
    chainId,
    endBlock,
    startBlock,
    vault: getAddress(vault),
    depositor: getAddress(opts.depositor),
    immutables: { asset, usdg, clear, seaport },
    settings: {
      feeRecipient: await read<Address>("feeRecipient"),
      depositCap: await read<bigint>("depositCap"),
      maxPriceAge: await read<number>("maxPriceAge"),
      protocolFeeBps: Number(policy[4]),
      maxUtilizationBps: Number(policy[3]),
      maxContractsCap: BigInt(policy[5]),
    },
    cycles,
    harvests,
    listings,
    strands,
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
    account,
  };
}
