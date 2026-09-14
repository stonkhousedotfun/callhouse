/**
 * What the fork harnesses share: dryrun.ts (the three-cycle rehearsal) and dryrun-extended.ts.
 * Chain 4663 constants, the derived actors, raw anvil RPC, storage-written balances, linked
 * deployments, the recorded trail, the alert capture, the USDG freeze (Paxos's own role,
 * impersonated), and the ABI fragments the keeper itself never needs.
 *
 * Nothing here imports a keeper module that reads the environment (abi.ts has no imports), so a
 * harness can still set every keeper variable before config.ts is first evaluated.
 */
import { readFileSync } from 'node:fs';
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
import { vaultAbi } from './abi.js';

/*//////////////////////////////////////////////////////////////
                    CHAIN 4663 CONSTANTS (recon-confirmed)
//////////////////////////////////////////////////////////////*/

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

/*//////////////////////////////////////////////////////////////
                              SETTINGS
//////////////////////////////////////////////////////////////*/

export const RPC = process.env.DRYRUN_RPC ?? 'http://127.0.0.1:8545';
export const ARTIFACTS = process.env.DRYRUN_ARTIFACTS ?? fileURLToPath(new URL('../../contracts/out/', import.meta.url));

/** Refuse anything that is not a local anvil: this harness writes storage and warps time. */
export function assertLocalRpc(): void {
  const url = new URL(RPC);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost' && url.hostname !== '::1') {
    throw new Error(`DRYRUN_RPC must be a local anvil fork, got ${url.origin}`);
  }
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
export const DEPOSITOR = derivedActor('depositor');
export const BUYER = derivedActor('buyer');
export const BUYER_B = derivedActor('buyer-b');

export const forkChain: Chain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain (anvil fork)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

/** The HARNESS's clients. The keeper builds its own from the environment set below. */
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
  const revert = thrown instanceof BaseError ? thrown.walk((e) => e instanceof ContractFunctionRevertedError) : null;
  const decoded = revert instanceof ContractFunctionRevertedError ? revert.data : undefined;
  assertEq(decoded?.errorName ?? null, errorName, `${label}: revert reason (${thrown instanceof Error ? thrown.message.split('\n')[0] : String(thrown)})`);
  note(`${label}: reverted ${errorName}(${(decoded?.args ?? []).map(String).join(', ')})`);
  return decoded?.args ?? [];
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
export async function setUsdgFrozen(addr: Address, frozen: boolean): Promise<void> {
  const fn = frozen ? 'freeze' : 'unfreeze';
  try {
    await sendAs(`USDG.${fn}(${addr})`, USDG_ASSET_PROTECTION, USDG, encodeFunctionData({ abi: usdgAdminAbi, functionName: fn, args: [addr] }));
  } catch (error) {
    note(`${fn} from the role holder failed (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); writing the frozen slot directly`);
    const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [addr, USDG_FROZEN_SLOT]));
    await rpc('anvil_setStorageAt', [USDG, slot, pad(toHex(frozen ? 1n : 0n), { size: 32 })]);
  }
  assertEq(await isFrozen(addr), frozen, `USDG.isFrozen(${addr})`);
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

/**
 * MockFeed + both libraries + the linked Vault, from contracts/out, with KEEPER_ROLE granted.
 * The vault is constructed exactly as script/Deploy.s.sol constructs it, on the real Clear, the
 * real Seaport, the real tokens; only the feed is a mock seeded with the REAL answer so the run
 * can warp a week without tripping the vault's StalePrice gate.
 */
export async function deployVault(depositCap: bigint): Promise<{ vault: Address; feed: Address; answer: bigint }> {
  const [, answer] = await pub.readContract({ address: FEED, abi: feedAbi, functionName: 'latestRoundData' });
  note(`real Chainlink answer at the fork block: ${answer} (8 dp)`);
  const mockFeed = artifact('MockFeed.sol/MockFeed.json');
  const feed = await deploy('MockFeed', ADMIN, mockFeed.abi, mockFeed.bytecode.object, [8, answer, 'RHNVDA / USD (dry-run mirror of the real answer)']);

  const vaultArtifact = artifact('Vault.sol/Vault.json');
  const refs = Object.values(vaultArtifact.bytecode.linkReferences).flatMap((byName) => Object.keys(byName)).sort();
  assert(refs.join(',') === 'SeaportOrderLib,ValoremLib', `Vault should link exactly SeaportOrderLib and ValoremLib, the artifact names: ${refs.join(',') || 'none'}`);
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
      name: 'Callhouse NVDA (dry run)',
      symbol: 'cNVDA',
    },
  ]);
  const keeperRole = await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'KEEPER_ROLE' });
  await sendTx('grantRole(KEEPER_ROLE, keeper)', ADMIN, () =>
    wallet.writeContract({ account: ADMIN, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'grantRole', args: [keeperRole, KEEPER.address] }),
  );
  const zone = await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'seaportZone' });
  assertEq(zone, vault, 'the vault is its own Seaport zone');
  return { vault, feed, answer };
}

/** Refresh the mock feed's `updatedAt` (and optionally its answer) after a warp. */
export async function refreshFeed(feed: Address, answer: bigint, why: string): Promise<void> {
  await sendTx(`MockFeed.setAnswer(${answer}) (${why})`, ADMIN, () =>
    wallet.writeContract({ account: ADMIN, chain: forkChain, address: feed, abi: mockFeedAbi, functionName: 'setAnswer', args: [answer] }),
  );
}

/*//////////////////////////////////////////////////////////////
                           ALERT CAPTURE
//////////////////////////////////////////////////////////////*/

/** Captures what alerts.ts POSTs to ALERT_WEBHOOK. Can hold one delivery open, to put a signal
 *  inside a tick that is provably still in flight. */
export class AlertCapture {
  readonly received: Array<{ kind: string; severity: string; message: string; data: Record<string, unknown> }> = [];
  private server: Server | null = null;
  private gate: { kind: string; arrived: () => void; released: Promise<void> } | null = null;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { kind: string; severity: string; message: string; data: Record<string, unknown> };
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

  last(kind: string): { kind: string; severity: string; message: string; data: Record<string, unknown> } {
    const found = [...this.received].reverse().find((a) => a.kind === kind);
    assert(found !== undefined, `an alert of kind ${kind} was captured`);
    return found;
  }
}

/*//////////////////////////////////////////////////////////////
                          ABI FRAGMENTS (harness)
//////////////////////////////////////////////////////////////*/

export const mockFeedAbi = [
  { type: 'function', name: 'setAnswer', inputs: [{ name: 'a', type: 'int256' }], outputs: [], stateMutability: 'nonpayable' },
] as const;

export const feedAbi = [
  {
    type: 'function',
    name: 'latestRoundData',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
    stateMutability: 'view',
  },
] as const;

/**
 * The vault surface the keeper never touches — the redeem queue and the USDG accounting views —
 * absent from abi.ts on purpose.
 */
export const vaultQueueAbi = [
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
    name: 'epochs',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ name: 'sharesRemaining', type: 'uint256' }, { name: 'assetsRemaining', type: 'uint256' }, { name: 'usdgRemaining', type: 'uint256' }],
    stateMutability: 'view',
  },
  { type: 'function', name: 'pendingFeeUsdg', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'usdgDust', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'usdgOwed', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'usdgAccounted', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'previewRedeem', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'event',
    name: 'QueueSettled',
    inputs: [
      { name: 'epochId', type: 'uint256', indexed: true },
      { name: 'shares', type: 'uint256', indexed: false },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'usdgOut', type: 'uint256', indexed: false },
    ],
  },
  { type: 'error', name: 'EpochNotSettled', inputs: [{ name: 'epochId', type: 'uint256' }, { name: 'currentEpoch', type: 'uint256' }] },
  { type: 'error', name: 'NothingQueued', inputs: [] },
  { type: 'error', name: 'DepositsClosed', inputs: [] },
] as const;

/**
 * The Clear's fee surface the keeper does not carry in abi.ts: the switch its `feeTo` owns and
 * the per-token fee ledger (ops/recon/R4-valorem-abi.md).
 */
export const clearFeeAbi = [
  { type: 'function', name: 'setFeesEnabled', inputs: [{ name: 'enabled', type: 'bool' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'feeBalance', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const;

export const erc20AllowanceAbi = [
  { type: 'function', name: 'allowance', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const;
