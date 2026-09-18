import { concatHex, encodeAbiParameters, getAddress, isAddress, keccak256,
  type Address, type Hex, type WalletClient } from "viem";

import { rewardsDistributorAbi } from "../abi/v2/rewardsDistributor";
import { publicClient, robinhoodChain } from "../chain";
import { waitForV2Receipt } from "./txStatus";

export type MakerClaim = { index: number; account: Address; amount: string; proof: Hex[] };
export type MakerEpochFile = { epoch: number; root: Hex; total: string; entries: MakerClaim[] };
const uint = (value: unknown) => typeof value === "string" && /^\d+$/.test(value);
const bytes32 = (value: unknown): value is Hex => typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);

/** Published epoch files are data from the operator; validate them before exposing a wallet action. */
export function parseMakerEpochFile(body: unknown, expectedEpoch: number): MakerEpochFile {
  if (!body || typeof body !== "object") throw new Error("Reward file is invalid.");
  const file = body as Record<string, unknown>;
  if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0 || file.epoch !== expectedEpoch || !bytes32(file.root)
      || !uint(file.total) || !Array.isArray(file.entries)) throw new Error("Reward file is invalid.");
  const seenAccounts = new Set<string>();
  const seenIndices = new Set<number>();
  let sum = 0n;
  const entries = file.entries.map((raw): MakerClaim => {
    if (!raw || typeof raw !== "object") throw new Error("Reward entry is invalid.");
    const row = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(row.index) || (row.index as number) < 0 || typeof row.account !== "string"
        || !isAddress(row.account) || !uint(row.amount) || !Array.isArray(row.proof) || !row.proof.every(bytes32))
      throw new Error("Reward entry is invalid.");
    const index = row.index as number;
    const account = getAddress(row.account);
    if (seenIndices.has(index) || seenAccounts.has(account.toLowerCase())) throw new Error("Reward entries repeat.");
    seenIndices.add(index); seenAccounts.add(account.toLowerCase());
    sum += BigInt(row.amount as string);
    return { index, account, amount: row.amount as string, proof: row.proof as Hex[] };
  });
  if (sum !== BigInt(file.total as string) || entries.some((entry, i) => entry.index !== i))
    throw new Error("Reward total or indices do not match the entries.");
  return { epoch: expectedEpoch, root: file.root as Hex, total: file.total as string, entries };
}

export function makerClaimProofValid(file: MakerEpochFile, entry: MakerClaim): boolean {
  const inner = keccak256(encodeAbiParameters([
    { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint256" },
  ], [BigInt(file.epoch), BigInt(entry.index), entry.account, BigInt(entry.amount)]));
  let node = keccak256(inner);
  for (const sibling of entry.proof) {
    node = keccak256(concatHex(node.toLowerCase() < sibling.toLowerCase()
      ? [node, sibling] : [sibling, node]));
  }
  return node.toLowerCase() === file.root.toLowerCase();
}

export async function readMakerClaim(distributor: Address, file: MakerEpochFile, account: Address) {
  const entry = file.entries.find((row) => row.account.toLowerCase() === account.toLowerCase());
  if (!entry) return { status: "no-reward" as const, entry: null };
  if (!makerClaimProofValid(file, entry)) throw new Error("Published proof does not match its root.");
  const [root, claimed] = await Promise.all([
    publicClient.readContract({ address: distributor, abi: rewardsDistributorAbi,
      functionName: "root", args: [BigInt(file.epoch)] }),
    publicClient.readContract({ address: distributor, abi: rewardsDistributorAbi,
      functionName: "isClaimed", args: [BigInt(file.epoch), BigInt(entry.index)] }),
  ]);
  if (root.toLowerCase() !== file.root.toLowerCase() || /^0x0{64}$/i.test(root))
    throw new Error("Published rewards do not match the on-chain root.");
  return { status: claimed ? "claimed" as const : "ready" as const, entry };
}

export async function claimMakerReward(wallet: WalletClient, account: Address, distributor: Address,
  file: MakerEpochFile, entry: MakerClaim) {
  if (account.toLowerCase() !== entry.account.toLowerCase() || !makerClaimProofValid(file, entry))
    throw new Error("This reward proof does not belong to your wallet.");
  if (await wallet.getChainId() !== robinhoodChain.id) throw new Error("Switch to Robinhood Chain to claim.");
  // A fresh read before simulation prevents a stale/public file from prompting a wallet write.
  const live = await readMakerClaim(distributor, file, account);
  if (live.status !== "ready") throw new Error("This reward is no longer claimable.");
  const { request } = await publicClient.simulateContract({ address: distributor, abi: rewardsDistributorAbi,
    functionName: "claim", args: [BigInt(file.epoch), BigInt(entry.index), account, BigInt(entry.amount), entry.proof], account });
  const hash = await wallet.writeContract({ ...request, account, chain: robinhoodChain });
  await waitForV2Receipt(publicClient, hash, "claim");
  return hash;
}
