/**
 * What the fork harnesses share: dryrun.ts (the three-week rehearsal) and dryrun-extended.ts.
 * Chain 4663 constants, the derived actors, raw anvil RPC, storage-written balances, the linked
 * deployment from contracts/out, the recorded trail, the alert capture, the USDG freeze (Paxos's
 * own role, impersonated), a buyer's fill and exercise against the REAL Seaport and the REAL Clear
 * from the keeper's own /orders payload, and the ABI fragments the keeper itself never needs.
 *
 * WRITE ON FILL, NO REGISTRY. Nothing here mocks Valorem, Seaport or a registry: the vault is
 * deployed against Overcall's Valorem Clear (whose `newOptionType` is permissionless and whose
 * fee switch is off), the real Seaport 1.6 and the real tokens. The one mock is the price feed,
 * seeded with the REAL Chainlink answer at the fork block so the clock can be warped a week
 * without tripping the vault's StalePrice gate — and moved on purpose when a week is meant to
 * be in the money or a listing is meant to go unfillable.
 *
 * Nothing here imports a keeper module that reads the environment (abi.ts and calendar.ts have
 * no imports of their own), so a harness can still set every keeper variable before config.ts is
 * first evaluated.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  pad,
  parseEventLogs,
  toHex,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { clearAbi, seaportAbi, vaultAbi } from './abi.js';

/*//////////////////////////////////////////////////////////////
                    CHAIN 4663 CONSTANTS (recon-confirmed)
//////////////////////////////////////////////////////////////*/

/** Overcall's unmodified ValoremOptionsClearinghouse: `newOptionType` is permissionless and
 *  `feesEnabled()` is false (integrations/valorem.md). The vault is constructed against it, exactly
 *  as script/Deploy.s.sol's default. */
export const CLEAR = '0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0' as const;
export const SEAPORT = '0x0000000000000068F116a894984e2DB1123eB395' as const;
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const;
export const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as const;
export const FEED = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15' as const;
export const CHAIN_ID = 4663;

/** The EOA holding USDG's PAUSE_ROLE and ASSET_PROTECTION_ROLE on 4663 (integrations/usdg.md §3).
 *  Impersonated to freeze the vault; if the role has moved, the harness writes the `frozen`
 *  mapping (slot 6) directly, the same fallback contracts/test/fork/ForkLive.t.sol uses. */
export const USDG_ASSET_PROTECTION = '0x3Af3e85f4f97De7AD0f000B724Fb77fE5ffc024B' as const;
export const USDG_FROZEN_SLOT = 6n;

export const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
export const ONE_HUNDRED_ETH = 100_000_000_000_000_000_000n;
export const LOT = 1_000_000_000_000_000_000n;
export const BPS = 10_000n;
/** Distributor.ACC_PRECISION: the USDG-per-share index is scaled by 1e27. */
export const ACC_PRECISION = 10n ** 27n;
/** Policy.MAX_LISTINGS_PER_CYCLE. */
export const MAX_LISTINGS = 3;
/** Valorem's `uint8 public constant feeBps = 15` (integrations/valorem.md). */
export const VALOREM_FEE_BPS = 15n;
/** ValoremLib.MIN_LEAD, the vault's own floor on how far out the exercise must be at the arm. */
export const VAULT_MIN_LEAD_S = 3_600;

/**
 * Policy.launchDefaults(): what the Vault constructor installs, and so what this run's vault
 * must read back before the keeper sizes its first listing. protocolFeeBps is 5% of harvested
 * PREMIUM, never of strike proceeds.
 */
export const LAUNCH_POLICY = {
  minOtmBps: 300n,
  maxOtmBps: 1200n,
  minPremiumBps: 40n,
  maxUtilizationBps: 9500n,
  protocolFeeBps: 500n,
  maxContractsCap: 50n,
} as const;

/**
 * The protocol fee on ONE Harvest event, charged exactly as Vault._accrueHarvest charges it:
 * floor((grossUsdg - feeFree) x protocolFeeBps / 10000), where `feeFree` is the strike proceeds
 * credited in the same transaction (RollClose.usdgFromAssignment, or a recovery's queue-free USDG)
 * and 0 for a deposit checkpoint.
 */
export function harvestFee(grossUsdg: bigint, feeFree: bigint, protocolFeeBps: bigint): bigint {
  const feeBearing = grossUsdg > feeFree ? grossUsdg - feeFree : 0n;
  return (feeBearing * protocolFeeBps) / BPS;
}

/** Policy.maxContracts(assets) − written: the capacity approveListing checks the offer against. */
export function capacityOf(totalAssets: bigint, written: bigint, p: { maxUtilizationBps: bigint; maxContractsCap: bigint }): bigint {
  const byUtilisation = (totalAssets * p.maxUtilizationBps) / BPS / LOT;
  const cap = byUtilisation < p.maxContractsCap ? byUtilisation : p.maxContractsCap;
  return cap > written ? cap - written : 0n;
}

/** The feed answer (8 dp) that puts spot exactly `usd` dollars above a USDG6 strike. */
export function answerAbove(strikeUsdg6: bigint, usd: bigint): bigint {
  return strikeUsdg6 * 100n + usd * 100_000_000n;
}

/*//////////////////////////////////////////////////////////////
                              SETTINGS
//////////////////////////////////////////////////////////////*/

export const RPC = process.env.DRYRUN_RPC ?? 'http://127.0.0.1:8560';
export const ARTIFACTS = process.env.DRYRUN_ARTIFACTS ?? fileURLToPath(new URL('../../contracts/out/', import.meta.url));

/** Refuse anything that is not a local anvil: this harness writes storage and warps time. */
export function assertLocalRpc(): void {
  const url = new URL(RPC);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '::1') {
    throw new Error(`DRYRUN_RPC must be a local anvil fork, got ${url.origin}`);
  }
}

/**
 * The preflight every harness runs first: a loopback RPC that answers as anvil on chain 4663.
 * Anything else — a real chain, another chain id, a non-anvil node — ends the run before a
 * single storage write. Returns what the report records about the fork.
 */
export async function preflightFork(): Promise<{ clientVersion: string; chainId: number; forkBlock: string }> {
  assertLocalRpc();
  const clientVersion = await rpc<string>('web3_clientVersion');
  assert(
    clientVersion.toLowerCase().includes('anvil'),
    `${RPC} is not anvil (reports "${clientVersion}"). This script writes storage and warps time; it must never be pointed at a real chain.`,
  );
  const chainId = await pub.getChainId();
  assertEq(chainId, CHAIN_ID, 'eth_chainId');
  let forkBlock = 'unknown';
  try {
    const info = await rpc<{ forkConfig?: { forkBlockNumber?: number } }>('anvil_nodeInfo');
    if (info.forkConfig?.forkBlockNumber !== undefined) forkBlock = String(info.forkConfig.forkBlockNumber);
  } catch {
    /* older anvil */
  }
  if (forkBlock === 'unknown') forkBlock = (await pub.getBlockNumber()).toString();
  note(`anvil ${clientVersion}, chain ${chainId}, fork block ${forkBlock}, head timestamp ${await latestTimestamp()}`);
  return { clientVersion, chainId, forkBlock };
}

/*//////////////////////////////////////////////////////////////
                               ACTORS
//////////////////////////////////////////////////////////////*/

/**
 * Deterministic throwaway actors, derived from a label rather than taken from anvil's default
 * list. Every one of anvil's well-known accounts carries 23 bytes of code on chain 4663 — an
 * EIP-7702 delegation designator — so the EVM treats them as contracts, Valorem's ERC-1155 calls
 * `onERC1155Received` on them, the delegate reverts, and Seaport reports
 * TokenTransferGenericFailure, which reads like a broken order and is nothing of the kind.
 */
export function derivedActor(label: string): PrivateKeyAccount {
  return privateKeyToAccount(keccak256(toHex(`callhouse-dryrun:${label}`)));
}

export const KEEPER = process.env.DRYRUN_KEEPER_PK ? privateKeyToAccount(process.env.DRYRUN_KEEPER_PK as Hex) : derivedActor('keeper');
export const ADMIN = derivedActor('admin');
export const FEE_SAFE = derivedActor('fee-safe');
export const GUARDIAN = derivedActor('guardian');
export const DEPOSITOR = derivedActor('depositor');
export const BUYER = derivedActor('buyer');
export const BUYER_B = derivedActor('buyer-b');
/** Holds no role at all: the "anyone" of the permissionless entry points. */
export const ANYONE = derivedActor('anyone');

/** Fund and scrub every actor a harness uses, and record them. */
export async function fundActors(actors: Record<string, PrivateKeyAccount>): Promise<void> {
  for (const [label, actor] of Object.entries(actors)) {
    await setBalance(actor.address, ONE_HUNDRED_ETH);
    await clearDelegation(actor.address);
    trail.actors[label] = actor.address;
  }
  note(Object.entries(actors).map(([label, actor]) => `${label} ${actor.address}`).join(', '));
}

export const forkChain: Chain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain (anvil fork)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

/** The HARNESS's clients. The keeper builds its own from the environment set by each harness. */
export const pub: PublicClient = createPublicClient({ chain: forkChain, transport: http(RPC) });
export const wallet: WalletClient = createWalletClient({ chain: forkChain, transport: http(RPC) });

/*//////////////////////////////////////////////////////////////
                              THE RECORD
//////////////////////////////////////////////////////////////*/

export interface TxRecord {
  label: string;
  by: string;
  hash: Hex;
  block: string;
  gasUsed: string;
}

export interface StepRecord {
  step: string;
  ms: number;
  notes: string[];
}

/**
 * The trail every harness shares: the helpers below append to these arrays, and each harness's
 * own `record` holds the same array references, so its report sees every entry.
 */
export const trail = {
  actors: {} as Record<string, string>,
  addresses: {} as Record<string, string>,
  harnessTxs: [] as TxRecord[],
  steps: [] as StepRecord[],
  alerts: [] as Array<{ kind: string; severity: string; message: string }>,
};

let currentStepLabel = 'preflight';
let currentNotes: string[] = [];

export function currentStep(): string {
  return currentStepLabel;
}

export function note(text: string): void {
  currentNotes.push(text);
  process.stdout.write(`    ${text}\n`);
}

export async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  currentStepLabel = label;
  currentNotes = [];
  process.stdout.write(`\n== ${label}\n`);
  const t0 = Date.now();
  const result = await run();
  trail.steps.push({ step: label, ms: Date.now() - t0, notes: currentNotes });
  return result;
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED (${currentStepLabel}): ${message}`);
}

export function assertEq(actual: bigint | number | string | boolean | null, expected: typeof actual, message: string): void {
  assert(actual === expected, `${message} (expected ${String(expected)}, got ${String(actual)})`);
}

/** Address equality, case-insensitively, the way receipts come back. */
export function assertAddr(actual: string, expected: string, message: string): void {
  assertEq(actual.toLowerCase(), expected.toLowerCase(), message);
}

/**
 * Assert that a call reverts with a NAMED custom error. The catch here is the assertion, not a
 * swallow: a call that succeeds fails the step, and so does a revert with any other name.
 * Returns the decoded arguments, so a caller can pin them too.
 */
export async function expectRevert(label: string, errorName: string, run: () => Promise<unknown>): Promise<readonly unknown[]> {
  let thrown: unknown = null;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  assert(thrown !== null, `${label}: expected a ${errorName} revert, but the call succeeded`);
  const decoded = decodedRevert(thrown);
  assertEq(decoded?.errorName ?? null, errorName, `${label}: revert reason (${thrown instanceof Error ? thrown.message.split('\n')[0] : String(thrown)})`);
  note(`${label}: reverted ${errorName}(${(decoded?.args ?? []).map(String).join(', ')})`);
  return decoded?.args ?? [];
}

/** The custom error viem decoded out of a thrown call, if any. */
export function decodedRevert(thrown: unknown): { errorName: string; args?: readonly unknown[] } | undefined {
  const revert = thrown instanceof BaseError ? thrown.walk((e) => e instanceof ContractFunctionRevertedError) : null;
  return revert instanceof ContractFunctionRevertedError ? revert.data : undefined;
}

/** The one event of a kind that a given contract emitted in a receipt. */
export function only<T extends { address: Address }>(events: readonly T[], at: Address, what: string): T {
  const matching = events.filter((e) => e.address.toLowerCase() === at.toLowerCase());
  assertEq(matching.length, 1, `exactly one ${what} event from ${at}`);
  const found = matching[0];
  assert(found !== undefined, what);
  return found;
}

/** Every event of a kind a given contract emitted in a receipt. */
export function allFrom<T extends { address: Address }>(events: readonly T[], at: Address): T[] {
  return events.filter((e) => e.address.toLowerCase() === at.toLowerCase());
}

/*//////////////////////////////////////////////////////////////
                             RAW ANVIL RPC
//////////////////////////////////////////////////////////////*/

let rpcId = 0;

export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result as T;
}

export async function setBalance(address: Address, wei: bigint): Promise<void> {
  await rpc('anvil_setBalance', [address, toHex(wei)]);
}

/** Scrub any code (an EIP-7702 delegation, see derivedActor) off a throwaway actor. */
export async function clearDelegation(address: Address): Promise<void> {
  const code = await rpc<Hex>('eth_getCode', [address, 'latest']);
  if (code === '0x' || code === '0x0') return;
  await rpc('anvil_setCode', [address, '0x']);
  note(`cleared ${code.length / 2 - 1} bytes of code on ${address}`);
}

export async function latestTimestamp(): Promise<bigint> {
  return (await pub.getBlock({ blockTag: 'latest' })).timestamp;
}

/** Move the fork's clock to `target` plus a minute of slack, and mine a block there. */
export async function warpTo(target: bigint, label: string): Promise<void> {
  const before = await latestTimestamp();
  if (before >= target) {
    note(`${label}: already past ${target}`);
    return;
  }
  const delta = target - before + 60n;
  await rpc('evm_increaseTime', [Number(delta)]);
  await rpc('evm_mine', []);
  const after = await latestTimestamp();
  note(`warped ${label}: ${before} -> ${after} (+${delta}s)`);
}

/** Mine one empty block at exactly `timestamp`; returns its number. */
export async function mineAt(timestamp: bigint): Promise<bigint> {
  await rpc('evm_setNextBlockTimestamp', [Number(timestamp)]);
  await rpc('evm_mine', []);
  const block = await pub.getBlock({ blockTag: 'latest' });
  assertEq(block.timestamp, timestamp, 'mined at the requested timestamp');
  return block.number;
}

/** The NEXT mined block (the next transaction's) lands at exactly `timestamp`. */
export async function setNextBlockTimestamp(timestamp: bigint): Promise<void> {
  await rpc('evm_setNextBlockTimestamp', [Number(timestamp)]);
}

/**
 * Send a transaction FROM an address the harness does not hold the key for, through anvil's
 * impersonation. Used for USDG's role holder and for the Clear's `feeTo`.
 */
export async function sendAs(label: string, from: Address, to: Address, data: Hex): Promise<{ hash: Hex; receipt: TransactionReceipt }> {
  await setBalance(from, ONE_HUNDRED_ETH);
  await rpc('anvil_impersonateAccount', [from]);
  try {
    const hash = await rpc<Hex>('eth_sendTransaction', [{ from, to, data, gas: toHex(500_000n) }]);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    assert(receipt.status === 'success', `${label} reverted (tx ${hash})`);
    trail.harnessTxs.push({ label, by: from, hash, block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() });
    note(`${label}: tx ${hash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed}, impersonating ${from})`);
    return { hash, receipt };
  } finally {
    await rpc('anvil_stopImpersonatingAccount', [from]);
  }
}

/*//////////////////////////////////////////////////////////////
                            ERC-20 FUNDING
//////////////////////////////////////////////////////////////*/

export const erc20Abi = [
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'allowance', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const;

/**
 * Write a balance straight into the token's storage. NVDA (OpenZeppelin v5, upgradeable) keeps
 * `_balances` at the ERC-7201 namespaced slot; USDG keeps it at slot 1. Both were confirmed by
 * probing on a fork, and both are probed again here rather than assumed: a wrong guess is put
 * back before the next one is tried.
 */
export const ERC20_STORAGE_BASES: bigint[] = [
  BigInt('0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00'),
  ...Array.from({ length: 64 }, (_, i) => BigInt(i)),
];

export async function balanceOf(token: Address, holder: Address): Promise<bigint> {
  return pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] });
}

/** Ensure `holder` holds at least `amount` of `token`; the balance is set to exactly `amount`
 *  when it is below. */
export async function deal(token: Address, holder: Address, amount: bigint): Promise<void> {
  if ((await balanceOf(token, holder)) >= amount) return;
  for (const base of ERC20_STORAGE_BASES) {
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, base]));
    const previous = await rpc<Hex>('eth_getStorageAt', [token, slot, 'latest']);
    await rpc('anvil_setStorageAt', [token, slot, pad(toHex(amount), { size: 32 })]);
    if ((await balanceOf(token, holder)) === amount) {
      note(`dealt ${amount} of ${token} to ${holder} (balances base slot ${toHex(base)})`);
      return;
    }
    await rpc('anvil_setStorageAt', [token, slot, previous]);
  }
  throw new Error(`could not find the balances slot of ${token}`);
}

export async function approve(label: string, by: PrivateKeyAccount, token: Address, spender: Address, amount: bigint): Promise<void> {
  await sendTx(label, by, () =>
    wallet.writeContract({ account: by, chain: forkChain, address: token, abi: erc20Abi, functionName: 'approve', args: [spender, amount] }),
  );
}

/*//////////////////////////////////////////////////////////////
                          THE USDG FREEZE
//////////////////////////////////////////////////////////////*/

export const usdgAdminAbi = [
  { type: 'function', name: 'freeze', inputs: [{ name: 'addr', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'unfreeze', inputs: [{ name: 'addr', type: 'address' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'isFrozen', inputs: [{ name: 'addr', type: 'address' }], outputs: [{ type: 'bool' }], stateMutability: 'view' },
] as const;

export async function isFrozen(addr: Address): Promise<boolean> {
  return pub.readContract({ address: USDG, abi: usdgAdminAbi, functionName: 'isFrozen', args: [addr] });
}

/**
 * Freeze or unfreeze an address on the REAL USDG, the way Paxos would: `freeze(address)` from the
 * ASSET_PROTECTION_ROLE holder, impersonated. Falls back to writing the `frozen` mapping (slot 6)
 * if the role has moved since the recon. Either way `isFrozen` is read back as the proof.
 */
export async function setUsdgFrozen(addr: Address, frozen: boolean): Promise<Hex | null> {
  const fn = frozen ? 'freeze' : 'unfreeze';
  try {
    const { hash } = await sendAs(`USDG.${fn}(${addr})`, USDG_ASSET_PROTECTION, USDG, encodeFunctionData({ abi: usdgAdminAbi, functionName: fn, args: [addr] }));
    assertEq(await isFrozen(addr), frozen, `USDG.isFrozen(${addr})`);
    return hash;
  } catch (error) {
    note(`${fn} from the role holder failed (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); writing the frozen slot directly`);
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [addr, USDG_FROZEN_SLOT]));
    await rpc('anvil_setStorageAt', [USDG, slot, pad(toHex(frozen ? 1n : 0n), { size: 32 })]);
    assertEq(await isFrozen(addr), frozen, `USDG.isFrozen(${addr})`);
    return null;
  }
}

/*//////////////////////////////////////////////////////////////
                      TRANSACTIONS AND DEPLOYMENTS
//////////////////////////////////////////////////////////////*/

export interface Artifact {
  abi: Abi;
  bytecode: { object: Hex; linkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>> };
  metadata?: { settings?: { libraries?: Record<string, string> } };
}

export function artifact(file: string): Artifact {
  const path = join(ARTIFACTS, file);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Artifact;
  } catch (error) {
    throw new Error(`cannot read ${path} — run \`forge build\` in contracts/ first (${String(error)})`);
  }
}

/**
 * Link a creation bytecode the way `forge script` would: deploy every library the artifact's
 * `linkReferences` name, then splice each address in at the byte offsets the artifact gives.
 * Offsets, not a regex, because two libraries have two different placeholders.
 *
 * REFUSES an artifact compiled with a library pinned to an address (`metadata.settings.libraries`).
 * That happened once: a size-measuring build pinned SeaportOrderLib to 0x1111…1111, forge cached
 * it, `linkReferences` then named only ValoremLib, and the deployed vault DELEGATECALLed an
 * empty address on its first `approveListing` — an empty revert with no error data at all.
 */
export async function deployLinked(label: string, by: PrivateKeyAccount, art: Artifact, args: readonly unknown[]): Promise<Address> {
  const pinned = Object.entries(art.metadata?.settings?.libraries ?? {});
  if (pinned.length > 0) {
    throw new Error(
      `${label} artifact was compiled with libraries pinned to addresses (${pinned.map(([k, v]) => `${k}=${v}`).join(', ')}). ` +
        'That is a stale or size-measuring build. Run `forge clean && forge build` in contracts/ and try again.',
    );
  }
  let code = art.bytecode.object.slice(2);
  for (const [file, byName] of Object.entries(art.bytecode.linkReferences)) {
    for (const [name, sites] of Object.entries(byName)) {
      const libArtifact = artifact(`${name}.sol/${name}.json`);
      if (Object.keys(libArtifact.bytecode.linkReferences).length > 0) throw new Error(`${name} itself needs linking; not supported`);
      const address = await deploy(name, by, libArtifact.abi, libArtifact.bytecode.object, []);
      const hex = address.slice(2).toLowerCase();
      for (const site of sites) {
        assert(site.length === 20, `${file}:${name} link site of ${site.length} bytes`);
        const at = site.start * 2;
        assert(code.slice(at, at + 40).startsWith('__$'), `${name} placeholder expected at byte ${site.start}`);
        code = code.slice(0, at) + hex + code.slice(at + 40);
      }
      note(`linked ${name} at ${sites.length} site(s)`);
    }
  }
  assert(!code.includes('__$'), 'unlinked placeholders remain');
  return deploy(label, by, art.abi, `0x${code}` as Hex, args);
}

export async function sendTx(label: string, by: { address: Address }, send: () => Promise<Hex>): Promise<{ hash: Hex; block: bigint; receipt: TransactionReceipt }> {
  const hash = await send();
  const receipt = await pub.waitForTransactionReceipt({ hash });
  assert(receipt.status === 'success', `${label} reverted (tx ${hash})`);
  trail.harnessTxs.push({ label, by: by.address, hash, block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() });
  note(`${label}: tx ${hash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
  return { hash, block: receipt.blockNumber, receipt };
}

export async function deploy(label: string, by: PrivateKeyAccount, abi: Abi, bytecode: Hex, args: readonly unknown[]): Promise<Address> {
  const hash = await wallet.deployContract({ account: by, chain: forkChain, abi, bytecode, args: args as never });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  assert(receipt.status === 'success' && !!receipt.contractAddress, `${label} deployment reverted (tx ${hash})`);
  const address = getAddress(receipt.contractAddress);
  trail.harnessTxs.push({ label: `deploy ${label}`, by: by.address, hash, block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() });
  trail.addresses[label] = address;
  note(`${label} at ${address} (tx ${hash})`);
  return address;
}

export interface Deployment {
  vault: Address;
  feed: Address;
  /** The real Chainlink answer (8 dp) the mock feed was seeded with. */
  answer: bigint;
  vaultDeployBlock: bigint;
}

/**
 * MockFeed + both libraries + the linked Vault, from contracts/out, with KEEPER_ROLE granted to
 * the keeper and GUARDIAN_ROLE to the guardian. The vault is constructed exactly as
 * script/Deploy.s.sol constructs it — the Config tuple with no registry and no zone argument — on
 * the real Clear, the real Seaport, the real tokens; only the feed is a mock, seeded with the
 * REAL answer so the run can warp a week without tripping the vault's StalePrice gate.
 */
export async function deployVault(depositCap: bigint, name: string): Promise<Deployment> {
  const [, answer] = await pub.readContract({ address: FEED, abi: feedAbi, functionName: 'latestRoundData' });
  note(`real Chainlink answer at the fork block: ${answer} (8 dp)`);
  assertEq(await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feesEnabled' }), false, "the real Clear's fee switch is off at the fork block");
  assertEq(await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feeBps' }), 15, "the real Clear's feeBps is the compiled 15");
  const mockFeed = artifact('MockFeed.sol/MockFeed.json');
  const feed = await deploy('MockFeed', ADMIN, mockFeed.abi, mockFeed.bytecode.object, [8, answer, 'RHNVDA / USD (dry-run mirror of the real answer)']);

  const vaultArtifact = artifact('Vault.sol/Vault.json');
  const refs = Object.values(vaultArtifact.bytecode.linkReferences).flatMap((byName) => Object.keys(byName)).sort();
  assert(refs.join(',') === 'SeaportOrderLib,ValoremLib', `Vault should link exactly SeaportOrderLib and ValoremLib, the artifact names: ${refs.join(',') || 'none'}`);
  // The harness-local fragments must describe the compiled vault, not a memory of it.
  for (const fragment of vaultHarnessAbi) {
    assert(
      vaultArtifact.abi.some((item) => item.type === fragment.type && 'name' in item && item.name === fragment.name),
      `Vault artifact has no ${fragment.type} named ${fragment.name}`,
    );
  }
  const vault = await deployLinked('Vault', ADMIN, vaultArtifact, [
    {
      asset: NVDA,
      usdg: USDG,
      clear: CLEAR,
      seaport: SEAPORT,
      priceFeed: feed,
      maxPriceAge: 4 * 86_400,
      conduitKey: ZERO_BYTES32,
      admin: ADMIN.address,
      feeRecipient: FEE_SAFE.address,
      depositCap,
      name,
      symbol: 'cNVDA',
    },
  ]);
  const deployTx = trail.harnessTxs.find((t) => t.label === 'deploy Vault');
  assert(deployTx !== undefined, 'the vault deployment is on the trail');
  const [keeperRole, guardianRole] = await Promise.all([
    pub.readContract({ address: vault, abi: vaultAbi, functionName: 'KEEPER_ROLE' }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: 'GUARDIAN_ROLE' }),
  ]);
  await sendTx('grantRole(KEEPER_ROLE, keeper)', ADMIN, () =>
    wallet.writeContract({ account: ADMIN, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'grantRole', args: [keeperRole, KEEPER.address] }),
  );
  await sendTx('grantRole(GUARDIAN_ROLE, guardian)', ADMIN, () =>
    wallet.writeContract({ account: ADMIN, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'grantRole', args: [guardianRole, GUARDIAN.address] }),
  );
  for (const [who, role, label] of [
    [ANYONE.address, keeperRole, 'anyone/KEEPER_ROLE'],
    [ANYONE.address, guardianRole, 'anyone/GUARDIAN_ROLE'],
    [GUARDIAN.address, keeperRole, 'guardian/KEEPER_ROLE'],
  ] as const) {
    assertEq(await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'hasRole', args: [role, who] }), false, `${label} is not held`);
  }
  assertAddr(await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'seaportZone' }), vault, 'the vault is its own Seaport zone');
  assertAddr(await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'clear' }), CLEAR, 'constructed on the real Clear');
  assertEq(await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'isApprovedForAll', args: [vault, SEAPORT] }), true, 'Seaport may pull the option tokens a fill mints');
  return { vault, feed, answer, vaultDeployBlock: BigInt(deployTx.block) };
}

/** Refresh the mock feed's `updatedAt` (and optionally move its answer) after a warp. */
export async function setFeed(feed: Address, answer: bigint, why: string): Promise<void> {
  await sendTx(`MockFeed.setAnswer(${answer}) (${why})`, ADMIN, () =>
    wallet.writeContract({ account: ADMIN, chain: forkChain, address: feed, abi: mockFeedAbi, functionName: 'setAnswer', args: [answer] }),
  );
}

/** Warp the fork to `target` and re-stamp the feed there, so the vault's StalePrice gate sees a
 *  print from this block, the way a live feed would have printed by then. */
export async function warpAndRefresh(target: bigint, label: string, feed: Address, answer: bigint): Promise<void> {
  await warpTo(target, label);
  await setFeed(feed, answer, `after the warp to ${label}`);
}

/*//////////////////////////////////////////////////////////////
                          THE KEEPER'S /orders
//////////////////////////////////////////////////////////////*/

/** One entry of GET /orders, as the keeper's health.ts serves it and the web fill route reads it. */
export interface ServedOrder {
  orderHash: string;
  chainId: number;
  seaport: string;
  vault: string;
  optionId: string;
  contracts: string;
  filledContracts: string;
  remainingContracts: string;
  unitPrice6: string;
  grossUsdg6: string;
  endTime: number;
  status: string;
  parameters: {
    offerer: string;
    zone: string;
    orderType: number;
    startTime: string;
    endTime: string;
    zoneHash: string;
    salt: string;
    conduitKey: string;
    totalOriginalConsiderationItems: string;
    offer: Array<{ itemType: number; token: string; identifierOrCriteria: string; startAmount: string; endAmount: string }>;
    consideration: Array<{ itemType: number; token: string; identifierOrCriteria: string; startAmount: string; endAmount: string; recipient: string }>;
  };
  signature: string;
}

export function healthClient(port: number) {
  const get = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return {
    get,
    orders: async (): Promise<ServedOrder[]> => (await get('/orders')).body.orders as ServedOrder[],
    /** The served entry for a hash, or a failed assertion. */
    order: async (orderHash: string): Promise<ServedOrder> => {
      const entry = (await get('/orders')).body.orders as ServedOrder[];
      const found = entry.find((o) => o.orderHash.toLowerCase() === orderHash.toLowerCase());
      assert(found !== undefined, `/orders serves ${orderHash}`);
      return found;
    },
  };
}

/** The OrderParameters struct a fulfil function takes, straight from the served JSON. */
export function parametersOf(served: ServedOrder) {
  const p = served.parameters;
  return {
    offerer: getAddress(p.offerer),
    zone: getAddress(p.zone),
    offer: p.offer.map((o) => ({ itemType: o.itemType, token: getAddress(o.token), identifierOrCriteria: BigInt(o.identifierOrCriteria), startAmount: BigInt(o.startAmount), endAmount: BigInt(o.endAmount) })),
    consideration: p.consideration.map((c) => ({ itemType: c.itemType, token: getAddress(c.token), identifierOrCriteria: BigInt(c.identifierOrCriteria), startAmount: BigInt(c.startAmount), endAmount: BigInt(c.endAmount), recipient: getAddress(c.recipient) })),
    orderType: p.orderType,
    startTime: BigInt(p.startTime),
    endTime: BigInt(p.endTime),
    zoneHash: p.zoneHash as Hex,
    salt: BigInt(p.salt),
    conduitKey: p.conduitKey as Hex,
    totalOriginalConsiderationItems: BigInt(p.totalOriginalConsiderationItems),
  };
}

/**
 * Assert the served payload is exactly the shape the vault authorises and the web fill route
 * accepts: PARTIAL_RESTRICTED, zone == offerer == vault, one ERC-1155 offer item on the Clear for
 * the armed option id, one USDG consideration item to the vault, endTime the exercise timestamp,
 * the empty signature.
 */
export function assertServedShape(served: ServedOrder, expect: { vault: Address; optionId: bigint; contracts: bigint; unitPrice6: bigint; endTime: bigint }): void {
  const p = served.parameters;
  assertEq(served.chainId, CHAIN_ID, '/orders chainId');
  assertAddr(served.seaport, SEAPORT, '/orders seaport');
  assertAddr(served.vault, expect.vault, '/orders vault');
  assertEq(served.signature, '0x', '/orders signature is EMPTY: the vault pre-validated on Seaport');
  assertEq(p.orderType, 3, 'orderType 3 = PARTIAL_RESTRICTED');
  assertAddr(p.offerer, expect.vault, 'offerer == vault');
  assertAddr(p.zone, expect.vault, 'zone == vault: authorizeOrder writes the fill');
  assertEq(p.zoneHash, ZERO_BYTES32, 'zoneHash 0');
  assertEq(p.conduitKey, ZERO_BYTES32, 'conduitKey 0: Seaport pulls the ERC-1155 itself');
  assertEq(p.startTime, '0', 'startTime 0');
  assertEq(BigInt(p.endTime), expect.endTime, 'endTime == cycleExerciseTs');
  assertEq(p.totalOriginalConsiderationItems, '1', 'totalOriginalConsiderationItems 1');
  assertEq(p.offer.length, 1, 'one offer item');
  const offer = p.offer[0];
  assert(offer !== undefined, 'offer[0]');
  assertEq(offer.itemType, 3, 'offer[0] ERC1155');
  assertAddr(offer.token, CLEAR, 'offer[0].token == the Clear');
  assertEq(BigInt(offer.identifierOrCriteria), expect.optionId, 'offer[0].identifier == the armed option id');
  assertEq(BigInt(offer.startAmount), expect.contracts, 'offer[0].startAmount == the listing size');
  assertEq(offer.endAmount, offer.startAmount, 'not a Dutch auction');
  assertEq(p.consideration.length, 1, 'ONE consideration item: no venue fee, nobody else is paid');
  const consid = p.consideration[0];
  assert(consid !== undefined, 'consideration[0]');
  assertEq(consid.itemType, 1, 'consideration[0] ERC20');
  assertAddr(consid.token, USDG, 'consideration[0].token == USDG');
  assertEq(consid.identifierOrCriteria, '0', 'consideration[0].identifier 0');
  assertEq(BigInt(consid.startAmount), expect.unitPrice6 * expect.contracts, 'consideration[0].startAmount == unit x N');
  assertEq(consid.endAmount, consid.startAmount, 'not a Dutch auction');
  assertAddr(consid.recipient, expect.vault, 'consideration[0].recipient == vault');
  assertEq(BigInt(served.unitPrice6), expect.unitPrice6, '/orders unitPrice6');
  assertEq(BigInt(served.grossUsdg6), expect.unitPrice6 * expect.contracts, '/orders grossUsdg6');
  assertEq(BigInt(served.contracts), expect.contracts, '/orders contracts');
}

/*//////////////////////////////////////////////////////////////
                    A FILL ON THE REAL SEAPORT
//////////////////////////////////////////////////////////////*/

/** Seaport's fulfil surface plus every error the vault and its libraries can throw, so a fill
 *  that the vault's hook refuses decodes to the hook's own error name. */
export const fillAbi = [...seaportAbi, ...vaultAbi] as const;

/** `fulfillAdvancedOrder` arguments for `numerator/denominator` of a served order, signature EMPTY. */
export function fillArgs(served: ServedOrder, numerator: bigint, denominator: bigint, recipient: Address) {
  return [
    { parameters: parametersOf(served), numerator, denominator, signature: '0x' as Hex, extraData: '0x' as Hex },
    [],
    ZERO_BYTES32,
    recipient,
  ] as const;
}

export interface FillResult {
  hash: Hex;
  gasUsed: bigint;
  block: bigint;
  premium: bigint;
  claimKey: bigint;
}

/**
 * A buyer fills `numerator/denominator` of `served` on the REAL Seaport through
 * `fulfillAdvancedOrder` with the EMPTY signature the keeper served, after approving USDG for
 * exactly the fraction. Every leg exact: OrderFulfilled for this hash, ONE CallsWritten from the
 * vault for exactly the filled contracts, the vault's ERC-1155 balance of the option back at
 * zero, the buyer holding the contracts, the premium landed on the vault, Seaport's fraction
 * advanced by the fill, and `contractsWritten` up by the fill.
 */
export async function fillFromOrders(who: string, buyer: PrivateKeyAccount, vault: Address, served: ServedOrder, numerator: bigint): Promise<FillResult> {
  const denominator = BigInt(served.contracts);
  const unit = BigInt(served.unitPrice6);
  const optionId = BigInt(served.optionId);
  const gross = BigInt(served.grossUsdg6);
  assertEq(gross, unit * denominator, 'the served gross is unit x size');
  assertEq((gross * numerator) % denominator, 0n, 'the premium of a fraction divides exactly (Seaport InexactFraction otherwise)');
  const premium = unit * numerator;

  const buyerUsdgBefore = await balanceOf(USDG, buyer.address);
  await deal(USDG, buyer.address, buyerUsdgBefore + premium);
  await approve(`USDG.approve(seaport, ${premium}) (${who})`, buyer, USDG, SEAPORT, premium);
  const [vaultUsdgBefore, buyerOptBefore, writtenBefore, statusBefore] = await Promise.all([
    balanceOf(USDG, vault),
    pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'balanceOf', args: [buyer.address, optionId] }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: 'contractsWritten' }),
    pub.readContract({ address: SEAPORT, abi: seaportAbi, functionName: 'getOrderStatus', args: [served.orderHash as Hex] }),
  ]);
  assertEq(await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'balanceOf', args: [vault, optionId] }), 0n, 'the vault holds no option tokens before the fill');

  const { hash, receipt, block } = await sendTx(`seaport.fulfillAdvancedOrder ${numerator}/${denominator} (${who}, signature 0x)`, buyer, () =>
    wallet.writeContract({
      account: buyer,
      chain: forkChain,
      address: SEAPORT,
      abi: seaportAbi,
      functionName: 'fulfillAdvancedOrder',
      args: fillArgs(served, numerator, denominator, buyer.address),
    }),
  );
  const fulfilled = only(parseEventLogs({ abi: seaportAbi, eventName: 'OrderFulfilled', logs: receipt.logs }), SEAPORT, 'OrderFulfilled');
  assertEq(fulfilled.args.orderHash.toLowerCase(), served.orderHash.toLowerCase(), 'OrderFulfilled.orderHash');
  assertAddr(fulfilled.args.offerer, vault, 'OrderFulfilled.offerer == vault');
  assertAddr(fulfilled.args.zone, vault, 'OrderFulfilled.zone == vault');
  assertEq(fulfilled.args.offer[0]?.amount ?? null, numerator, `OrderFulfilled offer: ${numerator} contracts`);
  assertEq(fulfilled.args.consideration.length, 1, 'OrderFulfilled: one consideration item');
  assertEq(fulfilled.args.consideration[0]?.amount ?? null, premium, 'OrderFulfilled consideration[0]: the premium');
  const written = only(parseEventLogs({ abi: vaultAbi, eventName: 'CallsWritten', logs: receipt.logs }), vault, 'CallsWritten');
  assertEq(written.args.optionId, optionId, 'CallsWritten.optionId');
  assertEq(BigInt(written.args.contractsCount), numerator, 'CallsWritten.contractsCount == exactly the filled contracts');
  assertEq(written.args.collateral, numerator * LOT, 'CallsWritten.collateral == contracts x LOT');
  const claimKey = written.args.claimKey;
  assertEq(await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'claimKey' }), claimKey, 'the vault holds the claim CallsWritten names');
  assertEq((await balanceOf(USDG, vault)) - vaultUsdgBefore, premium, 'the premium landed on the vault');
  assertEq(await balanceOf(USDG, buyer.address), buyerUsdgBefore, 'the buyer paid exactly the fraction');
  assertEq((await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'balanceOf', args: [buyer.address, optionId] })) - buyerOptBefore, numerator, 'the buyer received the contracts');
  assertEq(await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'balanceOf', args: [vault, optionId] }), 0n, "the vault's ERC-1155 balance of the option is 0 after the fill: written == sold");
  assertEq(await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'balanceOf', args: [vault, claimKey] }), 1n, 'the vault holds the claim NFT');
  assertEq(BigInt(await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'contractsWritten' })) - BigInt(writtenBefore), numerator, 'contractsWritten grew by the fill');
  const [, , totalFilled, totalSize] = await pub.readContract({ address: SEAPORT, abi: seaportAbi, functionName: 'getOrderStatus', args: [served.orderHash as Hex] });
  const [, , filledBefore, sizeBefore] = statusBefore;
  const before = sizeBefore === 0n ? 0n : (denominator * filledBefore) / sizeBefore;
  assertEq((denominator * totalFilled) / totalSize, before + numerator, `Seaport records ${totalFilled}/${totalSize}: ${before + numerator} of ${denominator} sold`);
  note(`${who} filled ${numerator}/${denominator} at ${unit} USDG6: premium ${premium}, gas ${receipt.gasUsed}, claim ${claimKey}`);
  return { hash, gasUsed: receipt.gasUsed, block, premium, claimKey };
}

/**
 * An eth_call of the same fill, decoded through the merged Seaport + vault ABI: `ok` when the
 * whole fill would go through, otherwise the error name and arguments (Seaport 1.6 bubbles the
 * zone's revert data, so a hook refusal decodes to the vault's own error). This is the web fill
 * page's pre-flight, from the harness.
 *
 * The hook runs BEFORE any transfer, so a refusal shows whatever the buyer holds; an ACCEPTANCE
 * only shows once the transfers run too, which needs the buyer funded and approved for the
 * fraction. `fund` stages exactly that (the way the fill page's buyer already is).
 */
export async function simulateFill(
  buyer: PrivateKeyAccount,
  served: ServedOrder,
  numerator: bigint,
  options: { fund?: boolean } = {},
): Promise<{ ok: true } | { ok: false; errorName: string; args: readonly unknown[]; message: string }> {
  const denominator = BigInt(served.contracts);
  if (options.fund) {
    const premium = BigInt(served.unitPrice6) * numerator;
    await deal(USDG, buyer.address, (await balanceOf(USDG, buyer.address)) + premium);
    await approve(`USDG.approve(seaport, ${premium}) (${buyer.address.slice(0, 10)}…, for a simulation)`, buyer, USDG, SEAPORT, premium);
  }
  try {
    await pub.simulateContract({
      account: buyer,
      address: SEAPORT,
      abi: fillAbi,
      functionName: 'fulfillAdvancedOrder',
      args: fillArgs(served, numerator, denominator, buyer.address),
    });
    return { ok: true };
  } catch (error) {
    const decoded = decodedRevert(error);
    const message = error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error);
    return { ok: false, errorName: decoded?.errorName ?? 'undecoded', args: decoded?.args ?? [], message };
  }
}

/*//////////////////////////////////////////////////////////////
                  AN EXERCISE ON THE REAL CLEAR
//////////////////////////////////////////////////////////////*/

export interface ExerciseResult {
  hash: Hex;
  /** strike x amount. */
  rx: bigint;
  /** The Clear's own fee on the exercise (0 while the switch is off). */
  fee: bigint;
  debit: bigint;
  feesEnabled: boolean;
}

/**
 * A buyer exercises `amount` of `optionId` on the REAL Clear inside the window; the Clear's fee
 * switch is read live. Every leg exact: the strike (plus fee) pulled in USDG, the underlying
 * delivered, the option tokens burnt, the vault's claim absorbing the assignment.
 */
export async function exerciseOn(who: string, buyer: PrivateKeyAccount, vault: Address, optionId: bigint, amount: bigint, strike: bigint): Promise<ExerciseResult> {
  const [feesEnabled, feeBps, claimKey] = await Promise.all([
    pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feesEnabled' }),
    pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feeBps' }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: 'claimKey' }),
  ]);
  assert(claimKey !== 0n, 'the vault has an open claim to be assigned on');
  const rx = strike * amount;
  let fee = 0n;
  if (feesEnabled) {
    fee = (rx * BigInt(feeBps)) / BPS;
    if (fee === 0n) fee = 1n;
  }
  const debit = rx + fee;
  const [buyerUsdg, buyerNvda, buyerOpt, clearUsdg, clearNvda, claimBefore, assignedBefore] = await Promise.all([
    balanceOf(USDG, buyer.address),
    balanceOf(NVDA, buyer.address),
    pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'balanceOf', args: [buyer.address, optionId] }),
    balanceOf(USDG, CLEAR),
    balanceOf(NVDA, CLEAR),
    pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'claim', args: [claimKey] }),
    pub.readContract({ address: vault, abi: vaultAbi, functionName: 'contractsAssigned' }),
  ]);
  assert(buyerOpt >= amount, `${who} holds ${buyerOpt} contracts, exercising ${amount}`);
  await deal(USDG, buyer.address, buyerUsdg + debit);
  await approve(`USDG.approve(clear, ${debit}) (${who})`, buyer, USDG, CLEAR, debit);
  const { hash, receipt } = await sendTx(`clear.exercise(optionId, ${amount}) (${who})`, buyer, () =>
    wallet.writeContract({ account: buyer, chain: forkChain, address: CLEAR, abi: clearAbi, functionName: 'exercise', args: [optionId, amount] }),
  );
  const ev = only(parseEventLogs({ abi: clearAbi, eventName: 'OptionsExercised', logs: receipt.logs }), CLEAR, 'OptionsExercised');
  assertEq(ev.args.optionId, optionId, 'OptionsExercised.optionId');
  assertAddr(ev.args.exerciser, buyer.address, 'OptionsExercised.exerciser');
  assertEq(BigInt(ev.args.amount), amount, 'OptionsExercised.amount');
  assertEq(await balanceOf(USDG, buyer.address), buyerUsdg, `the Clear pulled exactly ${rx} + fee ${fee}`);
  assertEq((await balanceOf(NVDA, buyer.address)) - buyerNvda, amount * LOT, 'the buyer took delivery');
  assertEq(buyerOpt - (await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'balanceOf', args: [buyer.address, optionId] })), amount, 'option tokens burnt');
  assertEq((await balanceOf(USDG, CLEAR)) - clearUsdg, debit, 'the strike USDG (plus any fee) sits in the Clear');
  assertEq(clearNvda - (await balanceOf(NVDA, CLEAR)), amount * LOT, 'the Clear released the underlying');
  const claimAfter = await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'claim', args: [claimKey] });
  assertEq(claimAfter.amountExercised - claimBefore.amountExercised, amount * LOT, "the vault's claim absorbed this exercise (the vault is the type's sole writer)");
  assertEq((await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'contractsAssigned' })) - assignedBefore, amount, 'vault.contractsAssigned() counts it, as a raw count');
  note(`${who} exercised ${amount} at strike ${strike}: debit ${rx} + fee ${fee}; claim.amountExercised ${claimAfter.amountExercised}`);
  return { hash, rx, fee, debit, feesEnabled };
}

/*//////////////////////////////////////////////////////////////
                           ALERT CAPTURE
//////////////////////////////////////////////////////////////*/

export interface CapturedAlert {
  kind: string;
  severity: string;
  message: string;
  data: Record<string, unknown>;
}

/** Captures what alerts.ts POSTs to ALERT_WEBHOOK. Can hold one delivery open, to put a signal
 *  inside a tick that is provably still in flight (alerts.ts aborts a delivery after 10 s, so a
 *  hold must be released well inside that). */
export class AlertCapture {
  readonly received: CapturedAlert[] = [];
  private server: Server | null = null;
  private gate: { kind: string; arrived: () => void; released: Promise<void> } | null = null;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CapturedAlert;
        const reply = (): void => {
          this.received.push(payload);
          trail.alerts.push({ kind: payload.kind, severity: payload.severity, message: payload.message });
          process.stdout.write(`    ALERT [${payload.severity}] ${payload.kind}: ${payload.message}\n`);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
        };
        if (this.gate && this.gate.kind === payload.kind) {
          const gate = this.gate;
          this.gate = null;
          gate.arrived();
          void gate.released.then(reply);
          return;
        }
        reply();
      });
    });
    await new Promise<void>((done) => this.server?.listen(0, '127.0.0.1', done));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('alert capture did not bind');
    this.url = `http://127.0.0.1:${address.port}/alerts`;
  }

  /** Hold the next delivery of `kind` before it is answered; `arrived` resolves when it is in. */
  holdNext(kind: string): { arrived: Promise<void>; release: () => void } {
    let arrived!: () => void;
    let release!: () => void;
    const arrivedPromise = new Promise<void>((done) => {
      arrived = done;
    });
    const released = new Promise<void>((done) => {
      release = done;
    });
    this.gate = { kind, arrived, released };
    return { arrived: arrivedPromise, release };
  }

  stop(): void {
    this.server?.close();
  }

  kinds(): string[] {
    return this.received.map((a) => a.kind);
  }

  /** The kinds received since index `from`. */
  since(from: number): string[] {
    return this.received.slice(from).map((a) => a.kind);
  }

  last(kind: string): CapturedAlert {
    const found = [...this.received].reverse().find((a) => a.kind === kind);
    assert(found !== undefined, `an alert of kind ${kind} was captured`);
    return found;
  }

  /** The newest alert of any kind, or a failed assertion when none has arrived. */
  latest(): CapturedAlert {
    const found = this.received[this.received.length - 1];
    assert(found !== undefined, 'at least one alert was captured');
    return found;
  }
}

/*//////////////////////////////////////////////////////////////
                              THE REPORT
//////////////////////////////////////////////////////////////*/

const bigintToString = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? v.toString() : v);

/**
 * Write run.json (the machine record; the indexer's fork-sync reads it) and report.md (the same
 * record for a human) into `out`. `sections` names the per-scenario blocks of the record, in the
 * order they should read.
 */
export function writeRunFiles(out: string, title: string, record: Record<string, unknown>, sections: Array<[string, string]>): void {
  writeFileSync(join(out, 'run.json'), JSON.stringify(record, bigintToString, 2));

  const lines: string[] = [];
  const h = (t: string) => lines.push('', `### ${t}`, '');
  const kv = (body: unknown) => {
    for (const [k, v] of Object.entries((body ?? {}) as Record<string, unknown>)) {
      lines.push(`- ${k}: ${typeof v === 'object' && v !== null ? JSON.stringify(v, bigintToString) : String(v)}`);
    }
  };
  lines.push(`# ${title} ${String(record.startedAt)}`, '');
  lines.push(`- result: ${record.error ? `**FAILED at "${String(record.stoppedAt)}"**: ${String(record.error)}` : '**passed**'}`);
  lines.push(`- wall clock: ${(Number(record.wallClockMs) / 1000).toFixed(1)}s`);
  lines.push(`- anvil: ${String(record.clientVersion)}, chain ${String(record.chainId)}, fork block ${String(record.forkBlock)}, rpc ${String(record.rpc)}`);
  lines.push(`- deposit: ${String(record.deposit)}`);
  lines.push(`- blocks: ${JSON.stringify(record.blocks ?? {}, bigintToString)}`);
  h('Actors');
  kv(record.actors);
  h('Deployed on the fork');
  kv(record.addresses);
  for (const [key, heading] of sections) {
    h(heading);
    kv(record[key]);
  }
  h('Harness transactions');
  lines.push('| step | by | tx | block | gas |', '|---|---|---|---|---|');
  for (const t of (record.harnessTxs as TxRecord[] | undefined) ?? []) lines.push(`| ${t.label} | \`${t.by.slice(0, 10)}…\` | \`${t.hash}\` | ${t.block} | ${t.gasUsed} |`);
  h('Keeper transactions (from keeper.db txs)');
  const txs = (((record.db as Record<string, unknown> | undefined)?.txs as Array<Record<string, unknown>> | undefined) ?? []).slice().reverse();
  lines.push('| kind | cycle | tx | block | gas | status |', '|---|---|---|---|---|---|');
  for (const t of txs) lines.push(`| ${String(t.kind)} | ${String(t.cycle_number)} | \`${String(t.hash)}\` | ${String(t.block_number)} | ${String(t.gas_used)} | ${String(t.status)} |`);
  for (const table of ['cycles', 'listings', 'meta'] as const) {
    h(`keeper.db ${table}`);
    lines.push('```json', JSON.stringify((record.db as Record<string, unknown> | undefined)?.[table] ?? [], bigintToString, 1), '```');
  }
  h('Alerts captured at ALERT_WEBHOOK, in order');
  for (const a of (record.alerts as Array<{ kind: string; severity: string; message: string }> | undefined) ?? []) lines.push(`- [${a.severity}] **${a.kind}**: ${a.message}`);
  h('Health endpoints');
  lines.push('```json', JSON.stringify(record.health ?? {}, bigintToString, 1), '```');
  h('Steps');
  for (const s of (record.steps as StepRecord[] | undefined) ?? []) {
    lines.push(`- ${s.step} (${s.ms} ms)`);
    for (const n of s.notes) lines.push(`  - ${n}`);
  }
  writeFileSync(join(out, 'report.md'), `${lines.join('\n')}\n`);
}

/*//////////////////////////////////////////////////////////////
                          ABI FRAGMENTS (harness)
//////////////////////////////////////////////////////////////*/

export const mockFeedAbi = [
  { type: 'function', name: 'setAnswer', inputs: [{ name: 'a', type: 'int256' }], outputs: [], stateMutability: 'nonpayable' },
] as const;

/** The Chainlink read surface. Lives in feed.ts since the factory-only keeper reads the feed
 *  itself (no vault to ask); re-exported here so the harness and its callers do not change. */
import { feedAbi } from './feed.js';
export { feedAbi };

/**
 * The vault surface the keeper never touches — the redeem queue, the instant path, the USDG
 * accounting views, the fee sweep and the events of all of them — absent from abi.ts on purpose.
 * deployVault asserts every fragment exists in the compiled artifact.
 */
export const vaultHarnessAbi = [
  { type: 'function', name: 'queueRedeem', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ name: 'queuedEpoch', type: 'uint256' }], stateMutability: 'nonpayable' },
  {
    type: 'function',
    name: 'completeRedeem',
    inputs: [{ name: 'receiver', type: 'address' }],
    outputs: [{ name: 'assets', type: 'uint256' }, { name: 'usdgOut', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'redeem',
    inputs: [{ name: 'shares', type: 'uint256' }, { name: 'receiver', type: 'address' }, { name: 'owner', type: 'address' }],
    outputs: [{ name: 'assets', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
  { type: 'function', name: 'sweepFee', inputs: [], outputs: [{ name: 'fee', type: 'uint256' }], stateMutability: 'nonpayable' },
  { type: 'function', name: 'retryStrandedClaim', inputs: [], outputs: [], stateMutability: 'nonpayable' },
  {
    type: 'function',
    name: 'epochs',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ name: 'sharesRemaining', type: 'uint256' }, { name: 'assetsRemaining', type: 'uint256' }, { name: 'usdgRemaining', type: 'uint256' }],
    stateMutability: 'view',
  },
  { type: 'function', name: 'queuedSharesOf', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'queuedEpochOf', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'owedAssets', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'owedQueueUsdg', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'pendingFeeUsdg', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'usdgDust', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'usdgUnallocated', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'usdgAccounted', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalUsdgClaimed', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'previewRedeem', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'depositCap', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'event',
    name: 'QueueRedeem',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'shares', type: 'uint256', indexed: false },
      { name: 'epochId', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'CompleteRedeem',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'receiver', type: 'address', indexed: true },
      { name: 'shares', type: 'uint256', indexed: false },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'usdgOut', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'QueueEntrySettled',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'epochId', type: 'uint256', indexed: true },
      { name: 'shares', type: 'uint256', indexed: false },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'usdgOut', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'StrandShareSettled',
    inputs: [
      { name: 'owner', type: 'address', indexed: true },
      { name: 'gen', type: 'uint256', indexed: true },
      { name: 'wad', type: 'uint256', indexed: false },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'usdgOut', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Withdraw',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'receiver', type: 'address', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'shares', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Deposit',
    inputs: [
      { name: 'caller', type: 'address', indexed: true },
      { name: 'owner', type: 'address', indexed: true },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'shares', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'UsdgDistributed',
    inputs: [
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'accUsdgPerShare', type: 'uint256', indexed: false },
      { name: 'totalSupply', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ClaimUsdg',
    inputs: [
      { name: 'account', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'FeeSwept',
    inputs: [
      { name: 'feeRecipient', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'ClaimRedeemed',
    inputs: [
      { name: 'claimKey', type: 'uint256', indexed: true },
      { name: 'underlyingReturned', type: 'uint256', indexed: false },
      { name: 'exerciseReceived', type: 'uint256', indexed: false },
    ],
  },
  { type: 'error', name: 'EpochNotSettled', inputs: [{ name: 'epochId', type: 'uint256' }, { name: 'currentEpoch', type: 'uint256' }] },
  { type: 'error', name: 'NothingQueued', inputs: [] },
  { type: 'error', name: 'NothingToClaim', inputs: [] },
  { type: 'error', name: 'DepositsClosed', inputs: [] },
  { type: 'error', name: 'StillStranded', inputs: [] },
  { type: 'error', name: 'NotStranded', inputs: [] },
  { type: 'error', name: 'UseQueue', inputs: [] },
] as const;

/**
 * The Clear's fee surface the keeper does not carry in abi.ts: the switch its `feeTo` owns and
 * the per-token fee ledger (integrations/valorem.md §3).
 */
export const clearFeeAbi = [
  { type: 'function', name: 'setFeesEnabled', inputs: [{ name: 'enabled', type: 'bool' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'feeBalance', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const;
