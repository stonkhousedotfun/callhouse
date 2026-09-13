/**
 * The keeper, for real, against an anvil fork of Robinhood Chain 4663.
 *
 * WHY THIS FILE EXISTS: the previous dry run drove the CONTRACTS through a week and never ran a
 * line of the keeper — it re-implemented the strike pick without production's isApproved/cycleOf
 * filters and touched none of roll.ts, state.ts, overcallApi.ts, alerts.ts or health.ts. This one
 * imports the production modules and calls `reconcile()` and `tick()`, exactly as index.ts does,
 * against a fork of mainnet state. Two cycles run:
 *
 *   cycle 1  the LIVE Overcall NVDA series (ids, strikes and timestamps read from the real
 *            registry at the fork block), mirrored into a MockRegistry so the fork's clock can be
 *            warped through it. deposit -> tick: rollOpen + approveListing + POST -> tick: the
 *            book shows it -> a buyer fills on the real Seaport from the keeper's own /orders
 *            payload -> tick: filled -> warp -> tick: lockBook -> warp -> tick: rollClose. The
 *            harvest lands, the depositor claims it.
 *   cycle 2  a fresh five-rung series created on the real Valorem Clear, and the vault is rolled
 *            open BEHIND the keeper's back ("rolled while asleep"). The keeper must adopt the
 *            cycle from chain, list from the policy floor, watch nobody fill it, retire the
 *            listing at lockBook, and close the week honestly as unfilled, 0.
 *
 * WHAT IS REAL: the fork (mainnet state), Valorem Clear, Seaport 1.6, NVDA, USDG, Multicall3, the
 * cycle-1 option series, the vault bytecode (linked and deployed from contracts/out), and every
 * keeper module. WHAT IS STUBBED, each for one stated reason:
 *   - OvercallRegistry -> src/mocks/MockRegistry.sol. The real one's cycle is set by Overcall's
 *     operator; a rehearsal needs to set it on demand, twice.
 *   - Chainlink RHNVDA/USD -> src/mocks/MockFeed.sol seeded with the REAL answer at the fork
 *     block. The run warps the clock a week, and the real feed would then trip the vault's
 *     StalePrice gate — correctly, and uselessly for a rehearsal. DRYRUN_FEED=real keeps the real
 *     feed and runs cycle 1 only.
 *   - Overcall's listings API -> an in-process HTTP server implementing POST/GET/DELETE
 *     /api/orders with the response shapes recon R3 recorded. overcallApi.ts runs unmodified.
 *   - ALERT_WEBHOOK -> an in-process capture. alerts.ts runs unmodified.
 *   - NVDA and USDG balances are written into storage (anvil_setStorageAt), the fork suite's
 *     `deal` technique, because nobody here holds real Stock Tokens.
 * WHAT IS NOT EXERCISED: index.ts's timer loop and signal handling (the harness calls tick()),
 * and Overcall's real validator. Neither can be, from here.
 *
 * HOW TO RUN IT (keeper/README.md "Dry run" has the long form):
 *   anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8545
 *   (cd contracts && forge build)
 *   pnpm --filter @callhouse/keeper dryrun
 *
 * ENV (all optional):
 *   DRYRUN_RPC           anvil endpoint. Default http://127.0.0.1:8545
 *   DRYRUN_ARTIFACTS     contracts/out. Default ../contracts/out relative to this package
 *   DRYRUN_OUT           where state.db, report.md and run.json go. Default ./dryrun-out/<utc>
 *   DRYRUN_DEPOSIT       asset base units to deposit. Default 25e18
 *   DRYRUN_FEED          mock (default) | real
 *   DRYRUN_KEEPER_PK     the hot key to run as. Default: a key derived from a label
 *   DRYRUN_HEALTH_PORT   KEEPER_PORT for the health server. Default 18787
 *   DRYRUN_SKIP_CYCLE2   1 to stop after the filled cycle
 *
 * Every keeper variable is set by this file before the keeper is imported; a keeper .env is
 * deliberately NOT read (KEEPER_ENV_FILE=/dev/null), so a mainnet key cannot leak into a fork run.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
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
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

/*//////////////////////////////////////////////////////////////
                    CHAIN 4663 CONSTANTS (recon-confirmed)
//////////////////////////////////////////////////////////////*/

const CLEAR = '0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0' as const;
const SEAPORT = '0x0000000000000068F116a894984e2DB1123eB395' as const;
const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168' as const;
const NVDA = '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC' as const;
const REGISTRY_NVDA = '0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA' as const;
const OVERCALL_FEE = '0xdAe7e82A2E7D566C67E87C164B05a1C560190782' as const;
const FEED = '0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15' as const;
const CHAIN_ID = 4663;

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const;
const ONE_HUNDRED_ETH = 100_000_000_000_000_000_000n;
const LOT = 1_000_000_000_000_000_000n;
const BPS = 10_000n;

/*//////////////////////////////////////////////////////////////
                              SETTINGS
//////////////////////////////////////////////////////////////*/

const RPC = process.env.DRYRUN_RPC ?? 'http://127.0.0.1:8545';
const ARTIFACTS = process.env.DRYRUN_ARTIFACTS ?? fileURLToPath(new URL('../../contracts/out/', import.meta.url));
const OUT = resolve(process.env.DRYRUN_OUT ?? join('dryrun-out', new Date().toISOString().replace(/[:.]/g, '-')));
const DEPOSIT = BigInt(process.env.DRYRUN_DEPOSIT ?? '25000000000000000000');
const FEED_MODE = process.env.DRYRUN_FEED === 'real' ? 'real' : 'mock';
const HEALTH_PORT = Number(process.env.DRYRUN_HEALTH_PORT ?? '18787');
const SKIP_CYCLE2 = process.env.DRYRUN_SKIP_CYCLE2 === '1';

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
function derivedActor(label: string): PrivateKeyAccount {
  return privateKeyToAccount(keccak256(toHex(`callhouse-dryrun:${label}`)));
}

const KEEPER = process.env.DRYRUN_KEEPER_PK ? privateKeyToAccount(process.env.DRYRUN_KEEPER_PK as Hex) : derivedActor('keeper');
const ADMIN = derivedActor('admin');
const FEE_SAFE = derivedActor('fee-safe');
const DEPOSITOR = derivedActor('depositor');
const BUYER = derivedActor('buyer');

const forkChain: Chain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain (anvil fork)',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

/** The HARNESS's clients. The keeper builds its own from the environment set below. */
const pub: PublicClient = createPublicClient({ chain: forkChain, transport: http(RPC) });
const wallet: WalletClient = createWalletClient({ chain: forkChain, transport: http(RPC) });

/*//////////////////////////////////////////////////////////////
                              THE RECORD
//////////////////////////////////////////////////////////////*/

interface TxRecord {
  label: string;
  by: string;
  hash: Hex;
  block: string;
  gasUsed: string;
}

interface StepRecord {
  step: string;
  ms: number;
  notes: string[];
}

const record = {
  startedAt: new Date().toISOString(),
  rpc: RPC,
  clientVersion: '',
  chainId: 0,
  forkBlock: '',
  feedMode: FEED_MODE,
  actors: {} as Record<string, string>,
  addresses: {} as Record<string, string>,
  cycle1: {} as Record<string, unknown>,
  cycle2: {} as Record<string, unknown>,
  harnessTxs: [] as TxRecord[],
  steps: [] as StepRecord[],
  health: {} as Record<string, unknown>,
  stubRequests: [] as string[],
  alerts: [] as Array<{ kind: string; severity: string; message: string }>,
  db: {} as Record<string, unknown>,
  stoppedAt: null as string | null,
  error: null as string | null,
  wallClockMs: 0,
};

const startedMs = Date.now();
let currentStep = 'preflight';
let currentNotes: string[] = [];

function note(text: string): void {
  currentNotes.push(text);
  process.stdout.write(`    ${text}\n`);
}

async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  currentStep = label;
  currentNotes = [];
  process.stdout.write(`\n== ${label}\n`);
  const t0 = Date.now();
  const result = await run();
  record.steps.push({ step: label, ms: Date.now() - t0, notes: currentNotes });
  return result;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED (${currentStep}): ${message}`);
}

function assertEq(actual: bigint | number | string | boolean | null, expected: typeof actual, message: string): void {
  assert(actual === expected, `${message} (expected ${String(expected)}, got ${String(actual)})`);
}

/*//////////////////////////////////////////////////////////////
                             RAW ANVIL RPC
//////////////////////////////////////////////////////////////*/

let rpcId = 0;

async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method} failed: ${body.error.message}`);
  return body.result as T;
}

async function setBalance(address: Address, wei: bigint): Promise<void> {
  await rpc('anvil_setBalance', [address, toHex(wei)]);
}

/** Scrub any code (an EIP-7702 delegation, see derivedActor) off a throwaway actor. */
async function clearDelegation(address: Address): Promise<void> {
  const code = await rpc<Hex>('eth_getCode', [address, 'latest']);
  if (code === '0x' || code === '0x0') return;
  await rpc('anvil_setCode', [address, '0x']);
  note(`cleared ${code.length / 2 - 1} bytes of code on ${address}`);
}

async function latestTimestamp(): Promise<bigint> {
  return (await pub.getBlock({ blockTag: 'latest' })).timestamp;
}

/** Move the fork's clock to `target` plus a minute of slack, and mine a block there. */
async function warpTo(target: bigint, label: string): Promise<void> {
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

const erc20Abi = [
  { type: 'function', name: 'balanceOf', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'approve', inputs: [{ name: 's', type: 'address' }, { name: 'v', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' },
] as const;

/**
 * Write a balance straight into the token's storage. NVDA (OpenZeppelin v5, upgradeable) keeps
 * `_balances` at the ERC-7201 namespaced slot; USDG keeps it at slot 1. Both were confirmed by
 * probing on a fork, and both are probed again here rather than assumed: a wrong guess is put
 * back before the next one is tried.
 */
const ERC20_STORAGE_BASES: bigint[] = [
  BigInt('0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00'),
  ...Array.from({ length: 64 }, (_, i) => BigInt(i)),
];

async function balanceOf(token: Address, holder: Address): Promise<bigint> {
  return pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] });
}

async function deal(token: Address, holder: Address, amount: bigint): Promise<void> {
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

interface Artifact {
  abi: Abi;
  bytecode: { object: Hex; linkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>> };
  metadata?: { settings?: { libraries?: Record<string, string> } };
}

function artifact(file: string): Artifact {
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
async function deployLinked(label: string, by: PrivateKeyAccount, art: Artifact, args: readonly unknown[]): Promise<Address> {
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

async function sendTx(label: string, by: PrivateKeyAccount, send: () => Promise<Hex>): Promise<{ hash: Hex; block: bigint }> {
  const hash = await send();
  const receipt = await pub.waitForTransactionReceipt({ hash });
  assert(receipt.status === 'success', `${label} reverted (tx ${hash})`);
  record.harnessTxs.push({ label, by: by.address, hash, block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() });
  note(`${label}: tx ${hash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
  return { hash, block: receipt.blockNumber };
}

async function deploy(label: string, by: PrivateKeyAccount, abi: Abi, bytecode: Hex, args: readonly unknown[]): Promise<Address> {
  const hash = await wallet.deployContract({ account: by, chain: forkChain, abi, bytecode, args: args as never });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  assert(receipt.status === 'success' && !!receipt.contractAddress, `${label} deployment reverted (tx ${hash})`);
  const address = getAddress(receipt.contractAddress);
  record.harnessTxs.push({ label: `deploy ${label}`, by: by.address, hash, block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() });
  record.addresses[label] = address;
  note(`${label} at ${address} (tx ${hash})`);
  return address;
}

/*//////////////////////////////////////////////////////////////
                         THE OVERCALL STUB
//////////////////////////////////////////////////////////////*/

interface StubListing extends Record<string, unknown> {
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
class OvercallStub {
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

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url ?? '/', 'http://stub');
    const method = req.method ?? 'GET';
    this.requests.push(`${method} ${url.pathname}${url.search}`);
    record.stubRequests.push(`${method} ${url.pathname}${url.search}`);

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
class AlertCapture {
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
        record.alerts.push({ kind: payload.kind, severity: payload.severity, message: payload.message });
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

const mockRegistryAbi = [
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

const mockFeedAbi = [
  { type: 'function', name: 'setAnswer', inputs: [{ name: 'a', type: 'int256' }], outputs: [], stateMutability: 'nonpayable' },
] as const;

const feedAbi = [
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
const newOptionTypeAbi = [
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

/*//////////////////////////////////////////////////////////////
                                MAIN
//////////////////////////////////////////////////////////////*/

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const dbPath = join(OUT, 'keeper.db');

  /* ---------- 0. preflight ---------- */

  await step('preflight: this is an anvil fork of 4663', async () => {
    const clientVersion = await rpc<string>('web3_clientVersion');
    assert(
      clientVersion.toLowerCase().includes('anvil'),
      `${RPC} is not anvil (reports "${clientVersion}"). This script writes storage and warps time; it must never be pointed at a real chain.`,
    );
    const chainId = await pub.getChainId();
    assertEq(chainId, CHAIN_ID, 'chain id');
    let forkBlock = 'unknown';
    try {
      const info = await rpc<{ forkConfig?: { forkBlockNumber?: number } }>('anvil_nodeInfo');
      if (info.forkConfig?.forkBlockNumber !== undefined) forkBlock = String(info.forkConfig.forkBlockNumber);
    } catch {
      /* older anvil */
    }
    if (forkBlock === 'unknown') forkBlock = (await pub.getBlockNumber()).toString();
    record.clientVersion = clientVersion;
    record.chainId = chainId;
    record.forkBlock = forkBlock;
    note(`anvil ${clientVersion}, fork block ${forkBlock}, head timestamp ${await latestTimestamp()}`);

    for (const [label, actor] of Object.entries({ keeper: KEEPER, admin: ADMIN, feeSafe: FEE_SAFE, depositor: DEPOSITOR, buyer: BUYER })) {
      await setBalance(actor.address, ONE_HUNDRED_ETH);
      await clearDelegation(actor.address);
      record.actors[label] = actor.address;
    }
    note(`keeper ${KEEPER.address}, admin ${ADMIN.address}, depositor ${DEPOSITOR.address}, buyer ${BUYER.address}`);
  });

  /* ---------- 1. the live series, read from the real registry ---------- */

  const registryAbi = (await import('./abi.js')).registryAbi;
  const clearAbi = (await import('./abi.js')).clearAbi;
  const vaultAbi = (await import('./abi.js')).vaultAbi;

  const live = await step('read the live Overcall NVDA cycle from the real registry', async () => {
    const cycle = await pub.readContract({ address: REGISTRY_NVDA, abi: registryAbi, functionName: 'cycle' });
    const now = await latestTimestamp();
    assert(cycle.number !== 0, 'the real registry has no cycle at this fork block; fork at a newer block');
    assert(BigInt(cycle.exerciseTimestamp) > now, 'the live cycle is past its write deadline at this fork block; fork at a newer block');
    const strikes = await Promise.all(
      cycle.optionIds.map((id) => pub.readContract({ address: REGISTRY_NVDA, abi: registryAbi, functionName: 'strikePerContract', args: [id] })),
    );
    note(`cycle ${cycle.number}: ${cycle.optionIds.length} rungs, strikes ${strikes.map((s) => (BigInt(s) / 1_000_000n).toString()).join('/')} USDG, exercise ${cycle.exerciseTimestamp}, expiry ${cycle.expiryTimestamp}`);
    record.cycle1.liveRegistryCycle = cycle.number;
    record.cycle1.optionIds = cycle.optionIds.map(String);
    record.cycle1.strikes = strikes.map(String);
    record.cycle1.exerciseTimestamp = cycle.exerciseTimestamp;
    record.cycle1.expiryTimestamp = cycle.expiryTimestamp;
    return { ids: [...cycle.optionIds], strikes: strikes.map((s) => BigInt(s)), exercise: BigInt(cycle.exerciseTimestamp), expiry: BigInt(cycle.expiryTimestamp), lot: BigInt(cycle.lotSize) };
  });

  /* ---------- 2. deploy: registry, feed, library, vault ---------- */

  const { registry, feed, vault, realAnswer } = await step('deploy MockRegistry, the feed, both libraries and the linked Vault', async () => {
    const [, answer] = await pub.readContract({ address: FEED, abi: feedAbi, functionName: 'latestRoundData' });
    note(`real Chainlink answer at the fork block: ${answer} (8 dp)`);

    const mockRegistry = artifact('MockRegistry.sol/MockRegistry.json');
    const registryAddr = await deploy('MockRegistry', ADMIN, mockRegistry.abi, mockRegistry.bytecode.object, [NVDA, USDG, CLEAR]);

    let feedAddr: Address = FEED;
    if (FEED_MODE === 'mock') {
      const mockFeed = artifact('MockFeed.sol/MockFeed.json');
      feedAddr = await deploy('MockFeed', ADMIN, mockFeed.abi, mockFeed.bytecode.object, [8, answer, 'RHNVDA / USD (dry-run mirror of the real answer)']);
    } else {
      note('DRYRUN_FEED=real: the vault reads the real Chainlink feed; cycle 2 will be skipped');
      record.addresses.feed = FEED;
    }

    const vaultArtifact = artifact('Vault.sol/Vault.json');
    const refs = Object.values(vaultArtifact.bytecode.linkReferences).flatMap((byName) => Object.keys(byName)).sort();
    assert(
      refs.join(',') === 'SeaportOrderLib,ValoremLib',
      `Vault should link exactly SeaportOrderLib and ValoremLib (contracts/README.md), the artifact names: ${refs.join(',') || 'none'}`,
    );
    const vaultAddr = await deployLinked('Vault', ADMIN, vaultArtifact, [
      {
        asset: NVDA,
        usdg: USDG,
        clear: CLEAR,
        seaport: SEAPORT,
        registry: registryAddr,
        priceFeed: feedAddr,
        maxPriceAge: 4 * 86_400,
        overcallFeeRecipient: OVERCALL_FEE,
        conduitKey: ZERO_BYTES32,
        seaportZone: '0x0000000000000000000000000000000000000000',
        admin: ADMIN.address,
        feeRecipient: FEE_SAFE.address,
        depositCap: 50n * LOT,
        name: 'Callhouse NVDA (dry run)',
        symbol: 'cNVDA',
      },
    ]);

    const keeperRole = await pub.readContract({ address: vaultAddr, abi: vaultAbi, functionName: 'KEEPER_ROLE' });
    await sendTx('grantRole(KEEPER_ROLE, keeper)', ADMIN, () =>
      wallet.writeContract({ account: ADMIN, chain: forkChain, address: vaultAddr, abi: vaultAbi, functionName: 'grantRole', args: [keeperRole, KEEPER.address] }),
    );
    return { registry: registryAddr, feed: feedAddr, vault: vaultAddr, realAnswer: answer };
  });

  /* ---------- 3. cycle 1 on the mock registry: the live series, verbatim ---------- */

  await step('set cycle 1 on MockRegistry = the live series (real option ids, strikes, timestamps)', async () => {
    await sendTx('MockRegistry.setCycleWithStrikes(cycle 1)', ADMIN, () =>
      wallet.writeContract({
        account: ADMIN,
        chain: forkChain,
        address: registry,
        abi: mockRegistryAbi,
        functionName: 'setCycleWithStrikes',
        args: [live.ids, live.strikes, Number(live.exercise), Number(live.expiry)],
      }),
    );
    const cycle = await pub.readContract({ address: registry, abi: registryAbi, functionName: 'cycle' });
    assertEq(cycle.number, 1, 'mock cycle number');
    assertEq(cycle.optionIds.length, live.ids.length, 'mock rung count');
  });

  /* ---------- 4. stubs, environment, and then — only then — the keeper ---------- */

  const stub = new OvercallStub();
  const alerts = new AlertCapture();
  await stub.start();
  await alerts.start();

  process.env.KEEPER_ENV_FILE = '/dev/null';
  process.env.RH_RPC = RPC;
  delete process.env.RH_RPC_2;
  process.env.CHAIN_ID = String(CHAIN_ID);
  process.env.REGISTRY = registry;
  process.env.VAULT = vault;
  process.env.KEEPER_PK = keccak256(toHex('callhouse-dryrun:keeper'));
  if (process.env.DRYRUN_KEEPER_PK) process.env.KEEPER_PK = process.env.DRYRUN_KEEPER_PK;
  process.env.KEEPER_DB_PATH = dbPath;
  process.env.KEEPER_PORT = String(HEALTH_PORT);
  process.env.KEEPER_LOG_LEVEL = process.env.KEEPER_LOG_LEVEL ?? 'info';
  process.env.KEEPER_FALLBACK_DIR = join(OUT, 'fallback');
  process.env.OVERCALL_ORDERS_URL = `${stub.url}/api/orders`;
  process.env.OVERCALL_MARKET = 'NVDA';
  process.env.OVERCALL_MAX_ATTEMPTS = '2';
  process.env.ALERT_WEBHOOK = alerts.url;
  delete process.env.KEEPER_UNIT_PRICE_USDG6;
  delete process.env.OVERCALL_API_KEY;

  // The production modules. config.ts validates the environment above the moment this runs.
  const roll = await import('./roll.js');
  const { store, KeeperStore } = await import('./state.js');
  const seaport = await import('./seaport.js');
  const policy = await import('./policy.js');
  const { startHealthServer } = await import('./health.js');
  const { config } = await import('./config.js');
  const { account } = await import('./clients.js');
  assert(account.address === KEEPER.address, 'the keeper module derived a different address than the harness');
  assertEq(config.VAULT, vault, 'keeper config VAULT');
  stub.hashOf = (components) => seaport.localOrderHash(seaport.componentsFromJson(components as never));

  const healthServer = startHealthServer();
  const health = async (path: string): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`http://127.0.0.1:${HEALTH_PORT}${path}`);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };

  const dumpDb = (): Record<string, unknown> => ({
    counts: store.counts(),
    cycles: store.recentCycles(10),
    listings: store.db.prepare('SELECT order_hash, cycle_number, seq, option_id, contracts, unit_price6, gross_usdg6, to_vault6, to_overcall6, end_time, status, api_status, api_error, approve_tx, cancel_tx, posted_at, visible_at, seaport_total_filled, seaport_total_size, seaport_cancelled FROM listings ORDER BY cycle_number, seq').all(),
    txs: store.recentTxs(50),
    alerts: store.recentAlerts(50).map((a) => ({ id: a.id, kind: a.kind, severity: a.severity, message: a.message, delivered: a.delivered })),
    meta: store.db.prepare('SELECT key, value FROM meta ORDER BY key').all(),
  });

  const stopServers = (): void => {
    healthServer.close();
    stub.stop();
    alerts.stop();
  };

  try {
    /* ---------- 5. boot: reconcile against a vault that has done nothing ---------- */

    await step('keeper boot: reconcile() against the fresh vault', async () => {
      await roll.reconcile();
      const snap = roll.getLastSnapshot();
      assert(snap !== null, 'reconcile produced no snapshot');
      assertEq(snap.phase, roll.Phase.Idle, 'phase');
      assertEq(snap.hasKeeperRole, true, 'keeper role');
      assertEq(snap.registryCycle.number, 1, 'registry cycle');
      assertEq(snap.isWritingOpen, true, 'writing open');
      assertEq(alerts.kinds().length, 0, 'no alert on a clean boot');
      const h = await health('/health');
      note(`GET /health -> ${h.status} ${String(h.body.status)}`);
      record.health.afterBoot = h.body;
    });

    /* ---------- 6. deposit ---------- */

    await step('a depositor puts 25 NVDA in', async () => {
      await deal(NVDA, DEPOSITOR.address, DEPOSIT);
      await sendTx('NVDA.approve(vault)', DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: NVDA, abi: erc20Abi, functionName: 'approve', args: [vault, DEPOSIT] }),
      );
      await sendTx('vault.deposit', DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'deposit', args: [DEPOSIT, DEPOSITOR.address] }),
      );
      const shares = await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'balanceOf', args: [DEPOSITOR.address] });
      assertEq(shares, DEPOSIT, 'first deposit is 1:1');
    });

    /* ---------- 7. tick: the keeper writes and lists ---------- */

    const listed = await step('tick #1 (Idle, writing open): rollOpen -> approveListing -> POST to Overcall', async () => {
      await roll.tick();
      const snap = roll.getLastSnapshot();
      assert(snap !== null, 'no snapshot');
      const phase = await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'phase' });
      assertEq(phase, roll.Phase.Listed, 'vault phase after tick #1');

      const cycle = store.getCycle(1);
      assert(cycle !== null, 'no cycle row');
      assertEq(cycle.status, 'open', 'cycle row status');
      assert(cycle.roll_open_tx !== null, 'roll_open_tx recorded');
      assertEq(store.getTx(cycle.roll_open_tx)?.status ?? null, 'success', 'rollOpen receipt');
      const listings = store.listingsForCycle(1);
      assertEq(listings.length, 1, 'one listing row');
      const row = listings[0];
      assert(row !== undefined, 'listing row');
      assertEq(row.status, 'posted', 'listing status after POST');
      assertEq(row.api_status, 'open', 'book status from the 201');
      assert(row.approve_tx !== null, 'approve_tx recorded');
      assertEq(stub.requests.filter((r) => r.startsWith('POST')).length, 1, 'exactly one POST');
      assertEq(alerts.kinds().join(','), 'roll_open', 'alerts so far');

      const expectedContracts = policy.maxContracts(DEPOSIT, live.lot, {
        minOtmBps: 300n, maxOtmBps: 1200n, minPremiumBps: 40n, maxUtilizationBps: 9500n, protocolFeeBps: 1000n, maxContractsCap: 50n,
      });
      assertEq(BigInt(row.contracts), expectedContracts, 'listed the whole write at 95% utilisation');
      const inventory = await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'balanceOf', args: [vault, BigInt(row.option_id)] });
      assertEq(inventory, expectedContracts, 'real Valorem minted the option tokens to the vault');
      const listingHash = await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'listingHash' });
      assertEq(listingHash.toLowerCase(), row.order_hash.toLowerCase(), 'the vault authorised the hash the keeper stored');

      note(`wrote ${row.contracts} contracts of option ${row.option_id.slice(0, 12)}… at strike ${cycle.strike_usdg6} USDG6, ask ${row.unit_price6} USDG6/contract, gross ${row.gross_usdg6}`);
      record.cycle1.contracts = row.contracts;
      record.cycle1.strikeUsdg6 = cycle.strike_usdg6;
      record.cycle1.unitPrice6 = row.unit_price6;
      record.cycle1.gross6 = row.gross_usdg6;
      record.cycle1.toVault6 = row.to_vault6;
      record.cycle1.toOvercall6 = row.to_overcall6;
      record.cycle1.orderHash = row.order_hash;
      return row;
    });

    await step('tick #2 (Listed, nobody has filled): Seaport says open, the book says open -> visible', async () => {
      await roll.tick();
      const row = store.getListing(listed.order_hash);
      assert(row !== null, 'row');
      assertEq(row.status, 'visible', 'listing status after the book check');
      assert(row.visible_at !== null, 'visible_at stamped');
      assertEq(row.seaport_total_filled, '0', 'nothing filled yet');
      assertEq(alerts.kinds().join(','), 'roll_open', 'no new alert');
    });

    /* ---------- 8. a buyer fills on the real Seaport, from the keeper's own /orders ---------- */

    await step("a buyer fills the listing on the real Seaport, using the keeper's /orders payload", async () => {
      const orders = await health('/orders');
      const served = (orders.body.orders as Array<Record<string, unknown>>)[0];
      assert(served !== undefined, '/orders served nothing');
      assertEq(String(served.orderHash).toLowerCase(), listed.order_hash.toLowerCase(), '/orders serves the authorised order');
      const p = served.parameters as {
        offerer: string; zone: string; orderType: number; startTime: string; endTime: string; zoneHash: string; salt: string; conduitKey: string;
        totalOriginalConsiderationItems: string;
        offer: Array<{ itemType: number; token: string; identifierOrCriteria: string; startAmount: string; endAmount: string }>;
        consideration: Array<{ itemType: number; token: string; identifierOrCriteria: string; startAmount: string; endAmount: string; recipient: string }>;
      };
      const parameters = {
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
      const gross = BigInt(listed.gross_usdg6);
      const vaultBefore = await balanceOf(USDG, vault);
      const overcallBefore = await balanceOf(USDG, OVERCALL_FEE);

      await deal(USDG, BUYER.address, gross);
      await sendTx('USDG.approve(seaport)', BUYER, () =>
        wallet.writeContract({ account: BUYER, chain: forkChain, address: USDG, abi: erc20Abi, functionName: 'approve', args: [SEAPORT, gross] }),
      );
      const seaportAbi = (await import('./abi.js')).seaportAbi;
      // The signature served is the 65-byte placeholder; the vault answers EIP-1271 for the hash.
      await sendTx('seaport.fulfillOrder (buyer, placeholder signature via EIP-1271)', BUYER, () =>
        wallet.writeContract({
          account: BUYER,
          chain: forkChain,
          address: SEAPORT,
          abi: seaportAbi,
          functionName: 'fulfillOrder',
          args: [{ parameters, signature: String(served.signature) as Hex }, ZERO_BYTES32],
        }),
      );
      assertEq((await balanceOf(USDG, vault)) - vaultBefore, BigInt(listed.to_vault6), "the vault's 95% leg landed");
      assertEq((await balanceOf(USDG, OVERCALL_FEE)) - overcallBefore, BigInt(listed.to_overcall6), "Overcall's 5% leg landed");
      const bought = await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'balanceOf', args: [BUYER.address, BigInt(listed.option_id)] });
      assertEq(bought, BigInt(listed.contracts), 'the buyer holds the option tokens');
      // Overcall's book re-syncs from chain; the stub does the same on request.
      stub.markFilled(listed.order_hash, listed.to_vault6);
    });

    await step('tick #3 (Listed, filled): Seaport getOrderStatus reports the fill', async () => {
      await roll.tick();
      const row = store.getListing(listed.order_hash);
      assert(row !== null, 'row');
      assertEq(row.status, 'filled', 'listing status');
      assertEq(row.seaport_total_filled, row.seaport_total_size, 'fully filled');
      assertEq(alerts.kinds().join(','), 'roll_open', 'no new alert');
    });

    /* ---------- 9. lockBook at the exercise timestamp ---------- */

    await step('warp to exerciseTimestamp; tick #4 -> lockBook', async () => {
      await warpTo(live.exercise, 'cycle-1 exerciseTimestamp');
      await roll.tick();
      assertEq(await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'phase' }), roll.Phase.Exercisable, 'phase');
      const cycle = store.getCycle(1);
      assert(cycle !== null, 'cycle row');
      assertEq(cycle.status, 'locked', 'cycle status');
      assert(cycle.lock_tx !== null, 'lock_tx recorded');
      record.cycle1.lockTx = cycle.lock_tx;
    });

    /* ---------- 10. rollClose at expiry ---------- */

    await step('warp to expiryTimestamp; tick #5 -> rollClose, harvest, settle', async () => {
      await warpTo(live.expiry, 'cycle-1 expiryTimestamp');
      await roll.tick();
      assertEq(await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'phase' }), roll.Phase.Idle, 'phase after rollClose');
      const cycle = store.getCycle(1);
      assert(cycle !== null, 'cycle row');
      assertEq(cycle.status, 'closed', 'cycle status');
      assert(cycle.roll_close_tx !== null, 'roll_close_tx recorded');
      const toVault = BigInt(listed.to_vault6);
      assertEq(cycle.gross_usdg6, toVault.toString(), 'gross harvest = the 95% leg that filled');
      assertEq(cycle.fee_usdg6, ((toVault * 1000n) / BPS).toString(), 'protocol fee = 10% of harvest');
      assertEq(cycle.net_usdg6, (toVault - (toVault * 1000n) / BPS).toString(), 'net to depositors');
      assertEq(cycle.contracts_assigned, 0, 'out of the money: nothing assigned');
      assertEq(alerts.kinds().join(','), 'roll_open,roll_close', 'alerts');
      const last = alerts.received[alerts.received.length - 1];
      assert(last !== undefined && /harvested/.test(last.message) && !/unfilled/.test(last.message), 'roll_close alert reports a filled week');

      const idle = await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'idleAssets' });
      assertEq(idle, DEPOSIT, 'all collateral came back from Valorem');
      const claimable = await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'claimableUsdg', args: [DEPOSITOR.address] });
      const net = BigInt(cycle.net_usdg6 ?? '0');
      assert(claimable <= net && claimable + 1_000n >= net, `claimable ${claimable} within dust of net ${net}`);
      await sendTx('vault.claimUsdg (depositor)', DEPOSITOR, () =>
        wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'claimUsdg' }),
      );
      assertEq(await balanceOf(USDG, DEPOSITOR.address), claimable, 'the depositor received exactly the claimable USDG');
      record.cycle1.rollCloseTx = cycle.roll_close_tx;
      record.cycle1.harvest = { gross: cycle.gross_usdg6, fee: cycle.fee_usdg6, net: cycle.net_usdg6, depositorReceived: claimable.toString() };
      note(`harvest gross ${roll.formatUsdg(BigInt(cycle.gross_usdg6 ?? '0'))} USDG, fee ${roll.formatUsdg(BigInt(cycle.fee_usdg6 ?? '0'))}, net ${roll.formatUsdg(net)}; depositor claimed ${roll.formatUsdg(claimable)}`);

      const h = await health('/health');
      assertEq(h.status, 200, '/health after a full cycle');
      record.health.afterCycle1 = h.body;
      record.health.cycles = (await health('/cycles')).body;
      note(`GET /health -> ${String(h.body.status)}; GET /cycles -> ${((record.health.cycles as { cycles: unknown[] }).cycles).length} cycle(s)`);
    });

    /* ---------- 11. cycle 2: rolled while asleep, unfilled, closed honestly ---------- */

    if (SKIP_CYCLE2 || FEED_MODE === 'real') {
      note(SKIP_CYCLE2 ? 'DRYRUN_SKIP_CYCLE2=1: stopping after cycle 1' : 'DRYRUN_FEED=real: cycle 2 needs a fresh oracle after a one-week warp; stopping after cycle 1');
      record.cycle2.skipped = true;
    } else {
      const series2 = await step('cycle 2: create a fresh five-rung series on the REAL Valorem Clear', async () => {
        await sendTx('MockFeed.setAnswer (refresh updatedAt after the warp)', ADMIN, () =>
          wallet.writeContract({ account: ADMIN, chain: forkChain, address: feed, abi: mockFeedAbi, functionName: 'setAnswer', args: [realAnswer] }),
        );
        const spot = await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'spotUsdg' });
        const now = await latestTimestamp();
        // Valorem: expiry >= now + 1 day and expiry >= exercise + 1 day. The vault: expiry
        // within 21 days. An hour before the write deadline is plenty for a rehearsal.
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
        await sendTx('MockRegistry.setCycleWithStrikes(cycle 2)', ADMIN, () =>
          wallet.writeContract({ account: ADMIN, chain: forkChain, address: registry, abi: mockRegistryAbi, functionName: 'setCycleWithStrikes', args: [ids, strikes, Number(exercise), Number(expiry)] }),
        );
        note(`spot ${spot} USDG6; strikes ${strikes.map((s) => (s / 1_000_000n).toString()).join('/')}; exercise ${exercise}, expiry ${expiry}`);
        record.cycle2.spotUsdg6 = spot.toString();
        record.cycle2.optionIds = ids.map(String);
        record.cycle2.strikes = strikes.map(String);
        record.cycle2.exerciseTimestamp = Number(exercise);
        record.cycle2.expiryTimestamp = Number(expiry);
        return { ids, strikes, exercise, expiry };
      });

      await step('cycle 2: the vault is rolled open BEHIND the keeper (same key, no database row)', async () => {
        // The plan is computed with the production picker so the write is exactly what the
        // keeper would have chosen; only the sending is done here, to simulate a keeper that
        // died between the transaction landing and the write to SQLite.
        const [cycle, p, rungs, spot, idle] = await Promise.all([
          policy.readCycle(),
          policy.readPolicy(),
          policy.readCycle().then((c) => policy.readRungs(c)),
          pub.readContract({ address: vault, abi: vaultAbi, functionName: 'spotUsdg' }),
          pub.readContract({ address: vault, abi: vaultAbi, functionName: 'idleAssets' }),
        ]);
        const plan = await policy.pickWrite({ cycle, rungs, policy: p, idleAssets: idle, spotUsdg6: spot, readLastFill: async () => null });
        assert(plan.ok, `picker refused cycle 2: ${plan.ok ? '' : plan.reason}`);
        assertEq(plan.strikeUsdg6, series2.strikes[0] ?? 0n, 'nearest in-band rung');
        await sendTx('vault.rollOpen (cycle 2, sent by the harness as the keeper key)', KEEPER, () =>
          wallet.writeContract({ account: KEEPER, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'rollOpen', args: [plan.optionId, plan.contracts] }),
        );
        assertEq(await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'phase' }), roll.Phase.Listed, 'phase');
        assertEq(store.getCycle(2) === null, true, 'the keeper has NO row for cycle 2');
        record.cycle2.contracts = plan.contracts.toString();
        record.cycle2.strikeUsdg6 = plan.strikeUsdg6.toString();
      });

      await step('cycle 2: reconcile() adopts the open cycle it has no record of', async () => {
        await roll.reconcile();
        const cycle = store.getCycle(2);
        assert(cycle !== null, 'adopted row exists');
        assertEq(cycle.status, 'open', 'adopted status');
        assertEq(cycle.option_id, series2.ids[0]?.toString() ?? '', 'adopted option id');
        assertEq(cycle.roll_open_tx, null, 'an adopted cycle has no rollOpen tx on record');
        assertEq(store.listingsForCycle(2).length, 0, 'and no listing yet');
      });

      const listed2 = await step('cycle 2, tick #6 (Listed, no listing): list from the policy floor -> approveListing -> POST', async () => {
        await roll.tick();
        const rows = store.listingsForCycle(2);
        assertEq(rows.length, 1, 'one listing');
        const row = rows[0];
        assert(row !== undefined, 'row');
        assertEq(row.status, 'posted', 'posted');
        assertEq(row.contracts, record.cycle2.contracts as string, 'listed the whole inventory');
        // The header's claim, made true: a first listing prices at the policy floor computed
        // from LIVE spot and policy — the same reads the tick just made.
        const [freshPolicy, freshSpot] = await Promise.all([
          policy.readPolicy(),
          pub.readContract({ address: vault, abi: vaultAbi, functionName: 'spotUsdg' }),
        ]);
        assertEq(row.unit_price6, policy.minUnitPrice6(BigInt(freshSpot), freshPolicy).toString(), 'listed at the freshly computed policy floor');
        assertEq(stub.requests.filter((r) => r.startsWith('POST')).length, 2, 'second POST');
        assertEq(store.getCycle(2)?.relists_used ?? -1, 0, 'a first listing is not a relist');
        record.cycle2.orderHash = row.order_hash;
        record.cycle2.unitPrice6 = row.unit_price6;
        return row;
      });

      await step('cycle 2, tick #7: visible in the book; nobody fills', async () => {
        await roll.tick();
        assertEq(store.getListing(listed2.order_hash)?.status ?? null, 'visible', 'visible');
      });

      await step('cycle 2: warp to exerciseTimestamp; tick #8 -> lockBook retires the live listing', async () => {
        await warpTo(series2.exercise, 'cycle-2 exerciseTimestamp');
        const deletesBefore = stub.requests.filter((r) => r.startsWith('DELETE')).length;
        await roll.tick();
        assertEq(await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'phase' }), roll.Phase.Exercisable, 'phase');
        assertEq(store.getCycle(2)?.status ?? null, 'locked', 'locked');
        assertEq(store.getListing(listed2.order_hash)?.status ?? null, 'expired', 'the unfilled listing row is retired');
        assertEq(stub.requests.filter((r) => r.startsWith('DELETE')).length, deletesBefore + 1, 'the book was told');
        assertEq(store.openListings().length, 0, '/orders offers nothing past endTime');
      });

      await step('cycle 2: warp to expiryTimestamp; tick #9 -> rollClose: unfilled, 0', async () => {
        await warpTo(series2.expiry, 'cycle-2 expiryTimestamp');
        await roll.tick();
        assertEq(await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'phase' }), roll.Phase.Idle, 'phase');
        const cycle = store.getCycle(2);
        assert(cycle !== null, 'cycle row');
        assertEq(cycle.status, 'closed', 'closed');
        assertEq(cycle.gross_usdg6, '0', 'unfilled: 0');
        assertEq(cycle.net_usdg6, '0', 'unfilled: 0 net');
        assertEq(alerts.kinds().join(','), 'roll_open,roll_close,roll_close', 'alerts');
        const last = alerts.received[alerts.received.length - 1];
        assert(last !== undefined && /unfilled: 0 USDG/.test(last.message), 'the roll_close alert says unfilled, 0');
        assertEq(await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'idleAssets' }), DEPOSIT, 'collateral back again');
        record.cycle2.rollCloseTx = cycle.roll_close_tx;
        record.cycle2.harvest = { gross: cycle.gross_usdg6, fee: cycle.fee_usdg6, net: cycle.net_usdg6 };
      });
    }

    /* ---------- 12. what the keeper remembers, after a restart ---------- */

    await step('close the store, reopen the same file: everything is still there', async () => {
      const before = dumpDb();
      record.health.final = (await health('/health')).body;
      record.health.state = (await health('/state')).body;
      stopServers();
      store.close();
      const reopened = new KeeperStore(dbPath);
      try {
        const counts = reopened.counts();
        assertEq(JSON.stringify(counts), JSON.stringify((before as { counts: unknown }).counts), 'row counts after reopen');
        note(`state.db rows after reopen: ${JSON.stringify(counts)}`);
      } finally {
        reopened.close();
      }
      record.db = before;
    });

    record.wallClockMs = Date.now() - startedMs;
    writeReport();
    process.stdout.write(`\nDRY RUN PASSED in ${(record.wallClockMs / 1000).toFixed(1)}s. Report: ${join(OUT, 'report.md')}\n`);
  } catch (error) {
    record.stoppedAt = currentStep;
    record.error = error instanceof Error ? error.message : String(error);
    record.wallClockMs = Date.now() - startedMs;
    try {
      record.db = dumpDb();
    } catch {
      /* the store may already be closed */
    }
    stopServers();
    writeReport();
    throw error;
  }
}

/*//////////////////////////////////////////////////////////////
                              THE REPORT
//////////////////////////////////////////////////////////////*/

function writeReport(): void {
  const json = JSON.stringify(record, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2);
  writeFileSync(join(OUT, 'run.json'), json);

  const lines: string[] = [];
  const h = (t: string) => lines.push('', `### ${t}`, '');
  lines.push(`# Dry run ${record.startedAt}`, '');
  lines.push(`- result: ${record.error ? `**FAILED at "${record.stoppedAt}"**: ${record.error}` : '**passed**'}`);
  lines.push(`- wall clock: ${(record.wallClockMs / 1000).toFixed(1)}s`);
  lines.push(`- anvil: ${record.clientVersion}, chain ${record.chainId}, fork block ${record.forkBlock}, rpc ${record.rpc}`);
  lines.push(`- feed: ${record.feedMode}`);
  h('Actors');
  for (const [k, v] of Object.entries(record.actors)) lines.push(`- ${k}: \`${v}\``);
  h('Deployed on the fork');
  for (const [k, v] of Object.entries(record.addresses)) lines.push(`- ${k}: \`${v}\``);
  h('Cycle 1 (the live series, filled)');
  for (const [k, v] of Object.entries(record.cycle1)) lines.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  h('Cycle 2 (fresh series, rolled while asleep, unfilled)');
  for (const [k, v] of Object.entries(record.cycle2)) lines.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  h('Harness transactions');
  lines.push('| step | by | tx | block | gas |', '|---|---|---|---|---|');
  for (const t of record.harnessTxs) lines.push(`| ${t.label} | \`${t.by.slice(0, 10)}…\` | \`${t.hash}\` | ${t.block} | ${t.gasUsed} |`);
  h('Keeper transactions (from state.db txs)');
  const txs = ((record.db as { txs?: Array<Record<string, unknown>> }).txs ?? []).slice().reverse();
  lines.push('| kind | cycle | tx | block | gas | status |', '|---|---|---|---|---|---|');
  for (const t of txs) lines.push(`| ${String(t.kind)} | ${String(t.cycle_number)} | \`${String(t.hash)}\` | ${String(t.block_number)} | ${String(t.gas_used)} | ${String(t.status)} |`);
  h('state.db cycles');
  lines.push('```json', JSON.stringify((record.db as { cycles?: unknown }).cycles ?? [], null, 1), '```');
  h('state.db listings');
  lines.push('```json', JSON.stringify((record.db as { listings?: unknown }).listings ?? [], null, 1), '```');
  h('state.db meta');
  lines.push('```json', JSON.stringify((record.db as { meta?: unknown }).meta ?? [], null, 1), '```');
  h('Alerts captured at ALERT_WEBHOOK, in order');
  for (const a of record.alerts) lines.push(`- [${a.severity}] **${a.kind}**: ${a.message}`);
  h('Requests the Overcall stub received, in order');
  for (const r of record.stubRequests) lines.push(`- \`${r}\``);
  h('Health endpoints');
  lines.push('```json', JSON.stringify(record.health, null, 1), '```');
  h('Steps');
  for (const s of record.steps) {
    lines.push(`- ${s.step} (${s.ms} ms)`);
    for (const n of s.notes) lines.push(`  - ${n}`);
  }
  writeFileSync(join(OUT, 'report.md'), `${lines.join('\n')}\n`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    process.stderr.write(`\nDRY RUN FAILED at "${currentStep}": ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`Partial report: ${join(OUT, 'report.md')}\n`);
    process.exit(1);
  });
