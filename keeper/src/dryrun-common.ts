/**
 * What the fork harnesses share: dryrun.ts (the three-cycle rehearsal) and dryrun-extended.ts
 * (the K-22 scenarios). Chain 4663 constants, the derived actors, raw anvil RPC, storage-written
 * balances, linked deployments, the recorded trail, the in-process Overcall stub and alert
 * capture, and the ABI fragments the keeper itself never needs.
 *
 * Nothing here imports a keeper module that reads the environment (abi.ts has no imports), so a
 * harness can still set every keeper variable before config.ts is first evaluated.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
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
export const REGISTRY_NVDA = '0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA' as const;
export const OVERCALL_FEE = '0xdAe7e82A2E7D566C67E87C164B05a1C560190782' as const;
export const FEED = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15' as const;
export const CHAIN_ID = 4663;

export const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
export const ONE_HUNDRED_ETH = 100_000_000_000_000_000_000n;
export const LOT = 1_000_000_000_000_000_000n;
export const BPS = 10_000n;

/**
 * Policy.launchDefaults(): what the Vault constructor installs, and so what this run's vault
 * must read back before the keeper sizes its first write. protocolFeeBps is the 2026-09-13
 * decision: 5% of harvested PREMIUM, never of strike proceeds.
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
 * floor((grossUsdg - feeFree) x protocolFeeBps / 10000), where `feeFree` is
 * `RollClose.usdgFromAssignment` for the terminal harvest inside rollClose (same transaction)
 * and 0 for a deposit/mint checkpoint. `grossUsdg` still includes the strike proceeds; only the
 * premium part is fee-bearing, and `netUsdg = grossUsdg - feeUsdg` either way.
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
  stubRequests: [] as string[],
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

/*//////////////////////////////////////////////////////////////
                         THE OVERCALL STUB
//////////////////////////////////////////////////////////////*/

export interface StubListing extends Record<string, unknown> {
  orderHash: string;
  status: string;
  optionId: string;
  offerer: string;
}

/**
 * The four endpoints overcallApi.ts speaks, with the response shapes recorded in recon R3. The
 * order hash is derived from the posted components the same way Overcall does it (they hash the
 * components server-side); the derivation is injected after the keeper's seaport.ts is imported.
 */
export class OvercallStub {
  readonly listings = new Map<string, StubListing>();
  readonly requests: string[] = [];
  hashOf: ((components: unknown) => string) | null = null;
  private server: Server | null = null;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((done) => this.server?.listen(0, '127.0.0.1', done));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('stub did not bind');
    this.url = `http://127.0.0.1:${address.port}`;
  }

  stop(): void {
    this.server?.close();
  }

  markFilled(orderHash: string, realisedPremium6: string): void {
    const listing = this.listings.get(orderHash);
    if (!listing) throw new Error(`stub has no listing ${orderHash}`);
    Object.assign(listing, { status: 'filled', remaining: '0', filledNumerator: '1', filledDenominator: '1', realisedPremium6, checkedAt: new Date().toISOString() });
  }

  private postGate: { arrived: () => void; released: Promise<void> } | null = null;

  /**
   * Hold the NEXT POST /api/orders before it is answered. `arrived` resolves when the request
   * is in; the reply is sent only after `release()`. dryrun-extended.ts uses this to put a
   * SIGTERM inside a tick that is provably still in flight.
   */
  holdNextPost(): { arrived: Promise<void>; release: () => void } {
    let arrived!: () => void;
    let release!: () => void;
    const arrivedPromise = new Promise<void>((done) => {
      arrived = done;
    });
    const released = new Promise<void>((done) => {
      release = done;
    });
    this.postGate = { arrived, released };
    return { arrived: arrivedPromise, release };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://stub');
    const method = req.method ?? 'GET';
    this.requests.push(`${method} ${url.pathname}${url.search}`);
    trail.stubRequests.push(`${method} ${url.pathname}${url.search}`);
    if (method === 'POST' && this.postGate) {
      const gate = this.postGate;
      this.postGate = null;
      gate.arrived();
      await gate.released;
    }

    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    const match = /^\/api\/orders(?:\/(0x[0-9a-fA-F]{64}))?$/.exec(url.pathname);
    if (!match) return reply(404, { error: 'not found' });
    const hash = match[1]?.toLowerCase();

    if (method === 'POST' && !hash) {
      let body: { chainId?: number; components?: Record<string, unknown>; signature?: string };
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        return reply(400, { error: 'invalid json' });
      }
      if (url.searchParams.get('market') !== 'NVDA') return reply(400, { error: 'unknown market' });
      if (body.chainId !== CHAIN_ID) return reply(400, { error: 'wrong chainId' });
      if (!body.signature || !/^0x([0-9a-f]{128}|[0-9a-f]{130})$/.test(body.signature)) return reply(400, { error: 'signature must be 64 or 65 bytes' });
      const c = body.components;
      if (!c || !Array.isArray(c.offer) || !Array.isArray(c.consideration) || c.orderType !== 1) return reply(400, { error: 'components: bad shape' });
      if (!this.hashOf) return reply(500, { error: 'stub not wired' });
      const orderHash = this.hashOf(c).toLowerCase();
      const existing = this.listings.get(orderHash);
      if (existing) return reply(200, { listing: existing });
      const offer = (c.offer as Array<Record<string, string>>)[0] ?? {};
      const consideration = c.consideration as Array<Record<string, string>>;
      const total = consideration.reduce((sum, item) => sum + BigInt(item.startAmount ?? '0'), 0n);
      const quantity = BigInt(offer.startAmount ?? '0');
      const listing: StubListing = {
        orderHash,
        chainId: CHAIN_ID,
        offerer: String(c.offerer),
        optionId: String(offer.identifierOrCriteria),
        quantity: quantity.toString(),
        remaining: quantity.toString(),
        unitPrice6: quantity === 0n ? '0' : (total / quantity).toString(),
        totalPrice6: total.toString(),
        realisedPremium6: '0',
        startTime: String(c.startTime),
        endTime: String(c.endTime),
        salt: String(c.salt),
        counter: String(c.counter),
        status: 'open',
        filledNumerator: '0',
        filledDenominator: '0',
        signature: body.signature,
        createdAt: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
        components: c,
      };
      this.listings.set(orderHash, listing);
      return reply(201, { listing });
    }

    if (method === 'GET' && !hash) {
      const status = url.searchParams.get('status');
      const offerer = url.searchParams.get('offerer')?.toLowerCase();
      const optionId = url.searchParams.get('optionId');
      const limit = Number(url.searchParams.get('limit') ?? '50');
      const listings = [...this.listings.values()]
        .filter((l) => (status && status !== 'all' ? l.status === status : true))
        .filter((l) => (offerer ? l.offerer.toLowerCase() === offerer : true))
        .filter((l) => (optionId ? l.optionId === optionId : true))
        .slice(0, limit);
      return reply(200, { listings });
    }

    if (method === 'GET' && hash) {
      const listing = this.listings.get(hash);
      return listing ? reply(200, { listing }) : reply(404, { error: 'listing not found' });
    }

    if (method === 'DELETE' && hash) {
      const listing = this.listings.get(hash);
      if (!listing) return reply(404, { error: 'listing not found' });
      listing.status = 'cancelled';
      return reply(200, { ok: true });
    }

    return reply(405, { error: 'method not allowed' });
  }
}

/** Captures what alerts.ts POSTs to ALERT_WEBHOOK. */
export class AlertCapture {
  readonly received: Array<{ kind: string; severity: string; message: string; data: unknown }> = [];
  private server: Server | null = null;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { kind: string; severity: string; message: string; data: unknown };
        this.received.push(payload);
        trail.alerts.push({ kind: payload.kind, severity: payload.severity, message: payload.message });
        process.stdout.write(`    ALERT [${payload.severity}] ${payload.kind}: ${payload.message}\n`);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((done) => this.server?.listen(0, '127.0.0.1', done));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('alert capture did not bind');
    this.url = `http://127.0.0.1:${address.port}/alerts`;
  }

  stop(): void {
    this.server?.close();
  }

  kinds(): string[] {
    return this.received.map((a) => a.kind);
  }
}

/*//////////////////////////////////////////////////////////////
                          ABI FRAGMENTS (harness)
//////////////////////////////////////////////////////////////*/

export const mockRegistryAbi = [
  {
    type: 'function',
    name: 'setCycleWithStrikes',
    inputs: [
      { name: 'ids', type: 'uint256[]' },
      { name: 'strikes', type: 'uint96[]' },
      { name: 'exerciseAt', type: 'uint40' },
      { name: 'expireAt', type: 'uint40' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

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

/** Valorem's option-type factory, absent from abi.ts because the keeper never creates options. */
export const newOptionTypeAbi = [
  {
    type: 'function',
    name: 'newOptionType',
    inputs: [
      { name: 'underlyingAsset', type: 'address' },
      { name: 'underlyingAmount', type: 'uint96' },
      { name: 'exerciseAsset', type: 'address' },
      { name: 'exerciseAmount', type: 'uint96' },
      { name: 'exerciseTimestamp', type: 'uint40' },
      { name: 'expiryTimestamp', type: 'uint40' },
    ],
    outputs: [{ name: 'optionId', type: 'uint256' }],
    stateMutability: 'nonpayable',
  },
] as const;

/**
 * The vault surface the keeper never touches — the redeem queue and the USDG accounting views —
 * absent from abi.ts on purpose. Cycle 3 checks every fragment here against the compiled
 * artifact before using it, so this cannot drift from Vault.sol unnoticed.
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
    name: 'previewCompleteRedeem',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: 'assets', type: 'uint256' }, { name: 'usdgOut', type: 'uint256' }],
    stateMutability: 'view',
  },
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
  { type: 'function', name: 'usdgOwed', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'usdgAccounted', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalUsdgClaimed', inputs: [], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'previewRedeem', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'maxDeposit', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
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
    name: 'QueueSettled',
    inputs: [
      { name: 'epochId', type: 'uint256', indexed: true },
      { name: 'shares', type: 'uint256', indexed: false },
      { name: 'assets', type: 'uint256', indexed: false },
      { name: 'usdgOut', type: 'uint256', indexed: false },
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
    name: 'UsdgDistributed',
    inputs: [
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'accUsdgPerShare', type: 'uint256', indexed: false },
      { name: 'totalSupply', type: 'uint256', indexed: false },
    ],
  },
  /** AdapterValorem's ClaimRedeemed (the balance deltas), not the Clear's event of the same name. */
  {
    type: 'event',
    name: 'ClaimRedeemed',
    inputs: [
      { name: 'claimKey', type: 'uint256', indexed: true },
      { name: 'underlyingReturned', type: 'uint256', indexed: false },
      { name: 'exerciseReceived', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'Harvest',
    inputs: [
      { name: 'cycleNumber', type: 'uint32', indexed: true },
      { name: 'grossUsdg', type: 'uint256', indexed: false },
      { name: 'feeUsdg', type: 'uint256', indexed: false },
      { name: 'netUsdg', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'RollClose',
    inputs: [
      { name: 'cycleNumber', type: 'uint32', indexed: true },
      { name: 'assetsReturned', type: 'uint256', indexed: false },
      { name: 'usdgFromAssignment', type: 'uint256', indexed: false },
      { name: 'contractsAssignedCount', type: 'uint256', indexed: false },
    ],
  },
  { type: 'error', name: 'EpochNotSettled', inputs: [{ name: 'epochId', type: 'uint256' }, { name: 'currentEpoch', type: 'uint256' }] },
  { type: 'error', name: 'NothingQueued', inputs: [] },
  { type: 'error', name: 'DepositsClosedForCycle', inputs: [{ name: 'exerciseTs', type: 'uint40' }] },
] as const;

/**
 * The Clear's fee surface the keeper does not carry in abi.ts: the switch its `feeTo` owns, the
 * per-token fee ledger, and the event that moves the switch (ops/recon/R4-valorem-abi.md).
 */
export const clearFeeAbi = [
  { type: 'function', name: 'setFeesEnabled', inputs: [{ name: 'enabled', type: 'bool' }], outputs: [], stateMutability: 'nonpayable' },
  { type: 'function', name: 'feeBalance', inputs: [{ name: 'token', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  {
    type: 'event',
    name: 'FeeSwitchUpdated',
    inputs: [
      { name: 'feeTo', type: 'address', indexed: false },
      { name: 'enabled', type: 'bool', indexed: false },
    ],
  },
] as const;

export const erc20AllowanceAbi = [
  { type: 'function', name: 'allowance', inputs: [{ name: 'o', type: 'address' }, { name: 's', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
] as const;

/** Mine one empty block at exactly `timestamp`; returns its number. */
export async function mineAt(timestamp: bigint): Promise<bigint> {
  await rpc('evm_setNextBlockTimestamp', [Number(timestamp)]);
  await rpc('evm_mine', []);
  const block = await pub.getBlock({ blockTag: 'latest' });
  assertEq(block.timestamp, timestamp, 'mined at the requested timestamp');
  return block.number;
}

/** The next block (and so the next transaction) lands at exactly `timestamp`. */
export async function setNextBlockTimestamp(timestamp: bigint): Promise<void> {
  await rpc('evm_setNextBlockTimestamp', [Number(timestamp)]);
}

/** The addresses a harness deploys, which the shared cycle helper below needs. */
export interface ForkDeployment {
  vault: Address;
  feed: Address;
  registry: Address;
  /** The real Chainlink answer at the fork block, which MockFeed mirrors. */
  answer: bigint;
}

/**
 * Five fresh option types on the REAL Valorem Clear, installed on the mock registry as cycle
 * `n`. Fresh timestamps mean fresh option ids even when the strikes repeat (Valorem hashes the
 * whole tuple; identical parameters would revert OptionsTypeExists).
 */
export async function createFreshSeries(
  d: ForkDeployment,
  n: number,
  rec: Record<string, unknown>,
): Promise<{ ids: bigint[]; strikes: bigint[]; exercise: bigint; expiry: bigint }> {
  await sendTx('MockFeed.setAnswer (refresh updatedAt after the warp)', ADMIN, () =>
    wallet.writeContract({ account: ADMIN, chain: forkChain, address: d.feed, abi: mockFeedAbi, functionName: 'setAnswer', args: [d.answer] }),
  );
  const spot = await pub.readContract({ address: d.vault, abi: vaultAbi, functionName: 'spotUsdg' });
  const now = await latestTimestamp();
  // The real Clear needs only a minute between now, exercise and expiry; the registry's
  // MIN_EXERCISE_WINDOW is a day, and the vault caps the tenor at 21 days. An hour before the
  // write deadline is plenty for a rehearsal.
  const exercise = now + 3_600n;
  const expiry = exercise + 86_400n;
  const strikes = [1035n, 1055n, 1075n, 1095n, 1115n].map((bps) => ((spot * bps) / 1000n / 1_000_000n) * 1_000_000n);
  const ids: bigint[] = [];
  for (const strike of strikes) {
    const { result, request } = await pub.simulateContract({
      account: ADMIN,
      address: CLEAR,
      abi: newOptionTypeAbi,
      functionName: 'newOptionType',
      args: [NVDA, LOT, USDG, strike, Number(exercise), Number(expiry)],
    });
    await sendTx(`clear.newOptionType(strike ${strike / 1_000_000n})`, ADMIN, () => wallet.writeContract(request));
    ids.push(result);
  }
  await sendTx(`MockRegistry.setCycleWithStrikes(cycle ${n})`, ADMIN, () =>
    wallet.writeContract({ account: ADMIN, chain: forkChain, address: d.registry, abi: mockRegistryAbi, functionName: 'setCycleWithStrikes', args: [ids, strikes, Number(exercise), Number(expiry)] }),
  );
  note(`spot ${spot} USDG6; strikes ${strikes.map((s) => (s / 1_000_000n).toString()).join('/')}; exercise ${exercise}, expiry ${expiry}`);
  rec.spotUsdg6 = spot.toString();
  rec.optionIds = ids.map(String);
  rec.strikes = strikes.map(String);
  rec.exerciseTimestamp = Number(exercise);
  rec.expiryTimestamp = Number(expiry);
  return { ids, strikes, exercise, expiry };
}
