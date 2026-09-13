/**
 * The keeper, for real, against an anvil fork of Robinhood Chain 4663.
 *
 * WHY THIS FILE EXISTS: the previous dry run drove the CONTRACTS through a week and never ran a
 * line of the keeper — it re-implemented the strike pick without production's isApproved/cycleOf
 * filters and touched none of roll.ts, state.ts, overcallApi.ts, alerts.ts or health.ts. This one
 * imports the production modules and calls `reconcile()` and `tick()`, exactly as index.ts does,
 * against a fork of mainnet state. Three cycles run:
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
 *   cycle 3  a fresh series again, and this week is IN THE MONEY. The keeper writes and lists
 *            from Idle, a buyer fills on the real Seaport, the depositor queues 10 of the 25
 *            shares while the call is live, the feed moves above the strike, the keeper locks
 *            the book, and the buyer exercises 9 of the 23 contracts on the real Valorem Clear
 *            inside the window. rollClose must redeem the assigned claim (14 NVDA back, 9 x
 *            strike USDG in), publish contracts_assigned = 9, harvest premium + strike proceeds
 *            with the protocol fee on the premium ONLY (the strike proceeds are the assigned
 *            depositors' principal and are never fee'd), and settle the queue; the depositor
 *            then completes the redeem (NVDA plus the escrow's USDG) and claims the rest, to
 *            the base unit.
 *            The keeper's pre-close read, contractsAssignedAt, is also called directly against
 *            the real Clear (9 before the redeem; TokenNotFound -> unknown after) and both
 *            branches of resolveContractsAssigned are driven on the real receipt, because a
 *            tick alone can only ever exercise the event path: Vault.sol:801 always emits.
 *
 * WHAT IS REAL: the fork (mainnet state), Valorem Clear — including its exercise, assignment and
 * claim redemption in cycle 3 — Seaport 1.6, NVDA, USDG, Multicall3, the cycle-1 option series,
 * the vault bytecode (linked and deployed from contracts/out), and every keeper module. WHAT IS
 * STUBBED, each for one stated reason:
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
 *   DRYRUN_SKIP_CYCLE2   1 to stop after the filled cycle (cycle 3 is skipped too)
 *   DRYRUN_SKIP_CYCLE3   1 to stop after cycle 2
 *
 * Every keeper variable is set by this file before the keeper is imported; a keeper .env is
 * deliberately NOT read (KEEPER_ENV_FILE=/dev/null), so a mainnet key cannot leak into a fork run.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  encodeEventTopics,
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
// Type-only, erased at runtime: the keeper's state.ts (and config.ts behind it) is still not
// loaded until the environment below has been set.
import type { ListingRow } from './state.js';

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

/**
 * Policy.launchDefaults(): what the Vault constructor installs, and so what this run's vault
 * must read back before the keeper sizes its first write. protocolFeeBps is the 2026-09-13
 * decision: 5% of harvested PREMIUM, never of strike proceeds.
 */
const LAUNCH_POLICY = {
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
function harvestFee(grossUsdg: bigint, feeFree: bigint, protocolFeeBps: bigint): bigint {
  const feeBearing = grossUsdg > feeFree ? grossUsdg - feeFree : 0n;
  return (feeBearing * protocolFeeBps) / BPS;
}

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
const SKIP_CYCLE3 = process.env.DRYRUN_SKIP_CYCLE3 === '1';

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
  cycle3: {} as Record<string, unknown>,
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

/**
 * Assert that a call reverts with a NAMED custom error. The catch here is the assertion, not a
 * swallow: a call that succeeds fails the step, and so does a revert with any other name.
 */
async function expectRevert(label: string, errorName: string, run: () => Promise<unknown>): Promise<void> {
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

async function sendTx(label: string, by: PrivateKeyAccount, send: () => Promise<Hex>): Promise<{ hash: Hex; block: bigint; receipt: TransactionReceipt }> {
  const hash = await send();
  const receipt = await pub.waitForTransactionReceipt({ hash });
  assert(receipt.status === 'success', `${label} reverted (tx ${hash})`);
  record.harnessTxs.push({ label, by: by.address, hash, block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString() });
  note(`${label}: tx ${hash} (block ${receipt.blockNumber}, gas ${receipt.gasUsed})`);
  return { hash, block: receipt.blockNumber, receipt };
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

/**
 * The vault surface the keeper never touches — the redeem queue and the USDG accounting views —
 * absent from abi.ts on purpose. Cycle 3 checks every fragment here against the compiled
 * artifact before using it, so this cannot drift from Vault.sol unnoticed.
 */
const vaultQueueAbi = [
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
  const seaportAbi = (await import('./abi.js')).seaportAbi;
  const harvestEvent = (await import('./abi.js')).harvestEvent;
  const rollCloseEvent = (await import('./abi.js')).rollCloseEvent;

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

  /**
   * A buyer fills `listed` in full on the REAL Seaport, using the parameters and signature the
   * keeper's own GET /orders serves. Shared by cycles 1 and 3, transaction for transaction.
   */
  const buyerFills = async (listed: ListingRow): Promise<{ fillTx: Hex }> => {
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
    // The signature served is the 65-byte placeholder; the vault answers EIP-1271 for the hash.
    const fill = await sendTx('seaport.fulfillOrder (buyer, placeholder signature via EIP-1271)', BUYER, () =>
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
    return { fillTx: fill.hash };
  };

  /**
   * Five fresh option types on the REAL Valorem Clear, installed on the mock registry as cycle
   * `n`. Fresh timestamps mean fresh option ids even when the strikes repeat (Valorem hashes the
   * whole tuple; identical parameters would revert OptionsTypeExists). Shared by cycles 2 and 3.
   */
  const createFreshSeries = async (n: number, rec: Record<string, unknown>): Promise<{ ids: bigint[]; strikes: bigint[]; exercise: bigint; expiry: bigint }> => {
    await sendTx('MockFeed.setAnswer (refresh updatedAt after the warp)', ADMIN, () =>
      wallet.writeContract({ account: ADMIN, chain: forkChain, address: feed, abi: mockFeedAbi, functionName: 'setAnswer', args: [realAnswer] }),
    );
    const spot = await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'spotUsdg' });
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
      wallet.writeContract({ account: ADMIN, chain: forkChain, address: registry, abi: mockRegistryAbi, functionName: 'setCycleWithStrikes', args: [ids, strikes, Number(exercise), Number(expiry)] }),
    );
    note(`spot ${spot} USDG6; strikes ${strikes.map((s) => (s / 1_000_000n).toString()).join('/')}; exercise ${exercise}, expiry ${expiry}`);
    rec.spotUsdg6 = spot.toString();
    rec.optionIds = ids.map(String);
    rec.strikes = strikes.map(String);
    rec.exerciseTimestamp = Number(exercise);
    rec.expiryTimestamp = Number(expiry);
    return { ids, strikes, exercise, expiry };
  };

  const dumpDb = (): Record<string, unknown> => ({
    counts: store.counts(),
    cycles: store.recentCycles(10),
    listings: store.db.prepare('SELECT order_hash, cycle_number, seq, option_id, contracts, unit_price6, gross_usdg6, to_vault6, to_overcall6, end_time, status, api_status, api_error, approve_tx, cancel_tx, posted_at, visible_at, seaport_total_filled, seaport_total_size, seaport_cancelled FROM listings ORDER BY cycle_number, seq').all(),
    txs: store.recentTxs(50),
    alerts: store.recentAlerts(50).map((a) => ({ id: a.id, kind: a.kind, severity: a.severity, message: a.message, delivered: a.delivered })),
    meta: store.db.prepare('SELECT key, value FROM meta ORDER BY key').all(),
  });

  /** The one event of a kind that a given contract emitted in a receipt. */
  const only = <T extends { address: Address }>(events: readonly T[], at: Address, what: string): T => {
    const matching = events.filter((e) => e.address.toLowerCase() === at.toLowerCase());
    assertEq(matching.length, 1, `exactly one ${what} event from ${at}`);
    const found = matching[0];
    assert(found !== undefined, what);
    return found;
  };

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

      // The vault's policy is whatever its constructor installed. Read it back through the
      // keeper's own reader and pin every field to Policy.launchDefaults(), rather than
      // restating the numbers where a stale copy could size the write.
      const onChainPolicy = await policy.readPolicy();
      for (const key of Object.keys(LAUNCH_POLICY) as Array<keyof typeof LAUNCH_POLICY>) {
        assertEq(onChainPolicy[key], LAUNCH_POLICY[key], `vault.policy().${key} = Policy.launchDefaults().${key}`);
      }
      const expectedContracts = policy.maxContracts(DEPOSIT, live.lot, onChainPolicy);
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
      await buyerFills(listed);
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
      // The fee rule, from the chain: the policy's bps, and the fee-free amount from the
      // RollClose log in the same transaction (0 on an out-of-the-money week, so the whole
      // harvest is premium and fee-bearing).
      const { protocolFeeBps } = await policy.readPolicy();
      const closeReceipt1 = await pub.getTransactionReceipt({ hash: cycle.roll_close_tx as Hex });
      const rollClose1 = only(parseEventLogs({ abi: vaultAbi, eventName: 'RollClose', logs: closeReceipt1.logs }), vault, 'RollClose');
      assertEq(rollClose1.args.usdgFromAssignment, 0n, 'out of the money: RollClose.usdgFromAssignment = 0, nothing is fee-free');
      const fee1 = harvestFee(toVault, rollClose1.args.usdgFromAssignment, protocolFeeBps);
      assertEq(cycle.fee_usdg6, fee1.toString(), 'protocol fee = floor(premium x protocolFeeBps / 10000)');
      assertEq(cycle.net_usdg6, (toVault - fee1).toString(), 'net to depositors = gross - fee');
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
      record.cycle3.skipped = true;
    } else {
      const series2 = await step('cycle 2: create a fresh five-rung series on the REAL Valorem Clear', () => createFreshSeries(2, record.cycle2));

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
        assertEq(cycle.fee_usdg6, '0', 'unfilled: 0 fee');
        assertEq(cycle.net_usdg6, '0', 'unfilled: 0 net');
        assertEq(alerts.kinds().join(','), 'roll_open,roll_close,roll_close', 'alerts');
        const last = alerts.received[alerts.received.length - 1];
        assert(last !== undefined && /unfilled: 0 USDG/.test(last.message), 'the roll_close alert says unfilled, 0');
        assertEq(await pub.readContract({ address: vault, abi: vaultAbi, functionName: 'idleAssets' }), DEPOSIT, 'collateral back again');
        record.cycle2.rollCloseTx = cycle.roll_close_tx;
        record.cycle2.harvest = { gross: cycle.gross_usdg6, fee: cycle.fee_usdg6, net: cycle.net_usdg6 };
      });

      /* ---------- 12. cycle 3: in the money — filled, a queued redeem, 9 of 23 assigned ---------- */

      if (SKIP_CYCLE3) {
        note('DRYRUN_SKIP_CYCLE3=1: stopping after cycle 2');
        record.cycle3.skipped = true;
      } else {
        /** Contracts the buyer exercises, of the 23 written. Partial assignment is the normal case. */
        const EXERCISED = 9n;
        /** Shares the depositor queues while the call is live, of the 25e18 minted 1:1. */
        const QUEUED = 10n * LOT;
        /** Distributor.ACC_PRECISION: the USDG-per-share index is scaled by 1e27. */
        const ACC_PRECISION = 10n ** 27n;
        const V = { address: vault, abi: vaultAbi } as const;
        const Q = { address: vault, abi: vaultQueueAbi } as const;
        const strikeOfCycle3 = (): bigint => {
          const row = store.getCycle(3);
          assert(row !== null && row.strike_usdg6 !== null, 'cycle 3 strike on record');
          return BigInt(row.strike_usdg6);
        };
        /** The feed answer that puts spot 5 USD above the strike: USDG6 -> 8 dp, plus 5e8. */
        const itmAnswer8 = (): bigint => strikeOfCycle3() * 100n + 5n * 100_000_000n;

        const series3 = await step('cycle 3: create a fresh five-rung series on the REAL Valorem Clear', async () => {
          // The harness-local fragment must describe the compiled vault, not a memory of it.
          const compiled = artifact('Vault.sol/Vault.json').abi;
          for (const fragment of vaultQueueAbi) {
            assert(
              compiled.some((item) => item.type === fragment.type && 'name' in item && item.name === fragment.name),
              `Vault artifact has no ${fragment.type} named ${fragment.name}`,
            );
          }
          const series = await createFreshSeries(3, record.cycle3);
          const cycle = await pub.readContract({ address: registry, abi: registryAbi, functionName: 'cycle' });
          assertEq(cycle.number, 3, 'mock registry cycle number');
          assertEq(await pub.readContract({ address: registry, abi: registryAbi, functionName: 'isWritingOpen' }), true, 'writing open');
          return series;
        });

        const listed3 = await step('cycle 3, tick #10 (Idle, writing open): the KEEPER writes and lists', async () => {
          const idleBefore = await pub.readContract({ ...V, functionName: 'idleAssets' });
          assertEq(idleBefore, DEPOSIT, 'idle collateral entering cycle 3: both earlier cycles expired out of the money');
          await roll.tick();
          assertEq(await pub.readContract({ ...V, functionName: 'phase' }), roll.Phase.Listed, 'vault phase after the tick');
          assertEq(await pub.readContract({ ...V, functionName: 'cycleNumber' }), 3, 'vault cycle number');

          const cycle = store.getCycle(3);
          assert(cycle !== null, 'cycle row 3');
          assertEq(cycle.status, 'open', 'cycle row status');
          assert(cycle.roll_open_tx !== null, "roll_open_tx recorded: this rollOpen was the keeper's own");
          assertEq(store.getTx(cycle.roll_open_tx)?.status ?? null, 'success', 'rollOpen receipt');
          assertEq(cycle.option_id, series3.ids[0]?.toString() ?? '', 'the nearest in-band rung');
          assertEq(cycle.strike_usdg6, series3.strikes[0]?.toString() ?? '', 'its strike');
          assertEq(cycle.exercise_ts, Number(series3.exercise), 'exercise_ts');
          assertEq(cycle.expiry_ts, Number(series3.expiry), 'expiry_ts');

          const [freshPolicy, freshSpot, registryCycle] = await Promise.all([
            policy.readPolicy(),
            pub.readContract({ ...V, functionName: 'spotUsdg' }),
            policy.readCycle(),
          ]);
          const expectedContracts = policy.maxContracts(idleBefore, registryCycle.lotSize, freshPolicy);
          assertEq(cycle.contracts, Number(expectedContracts), 'wrote the whole idle balance at 95% utilisation');

          const rows = store.listingsForCycle(3);
          assertEq(rows.length, 1, 'one listing row');
          const row = rows[0];
          assert(row !== undefined, 'row');
          assertEq(row.status, 'posted', 'listing status after POST');
          assertEq(row.api_status, 'open', 'book status from the 201');
          assert(row.approve_tx !== null, 'approve_tx recorded');
          assertEq(BigInt(row.contracts), expectedContracts, 'listed the whole write');
          assertEq(row.unit_price6, policy.minUnitPrice6(freshSpot, freshPolicy).toString(), 'priced at the policy floor: the book has no fill on these fresh ids');
          const inventory = await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'balanceOf', args: [vault, BigInt(row.option_id)] });
          assertEq(inventory, expectedContracts, 'real Valorem minted the option tokens to the vault');
          const listingHash = await pub.readContract({ ...V, functionName: 'listingHash' });
          assertEq(listingHash.toLowerCase(), row.order_hash.toLowerCase(), 'the vault authorised the hash the keeper stored');
          const claimKey = await pub.readContract({ ...V, functionName: 'claimKey' });
          assert(claimKey !== 0n, 'the vault holds a Valorem claim');
          assertEq(stub.requests.filter((r) => r.startsWith('POST')).length, 3, 'third POST');

          // A second roll_open inside the hour. roll.ts sends roll_open and roll_close with
          // `force: true`, so the KEEPER_ALERT_COOLDOWN_MS (1 h, keyed 'roll_open:') in alerts.ts
          // does not suppress it; the exact list below is the assertion of that.
          assertEq(alerts.kinds().join(','), 'roll_open,roll_close,roll_close,roll_open', 'alerts: the second roll_open is force-sent past the cooldown');
          const last = alerts.received[alerts.received.length - 1];
          assert(last !== undefined, 'alert');
          assertEq((last.data as { cycleNumber?: number }).cycleNumber ?? null, 3, 'the roll_open alert names cycle 3');

          note(`wrote ${row.contracts} contracts of option ${row.option_id.slice(0, 12)}… at strike ${cycle.strike_usdg6} USDG6, ask ${row.unit_price6} USDG6/contract, gross ${row.gross_usdg6}`);
          record.cycle3.contracts = row.contracts;
          record.cycle3.strikeUsdg6 = cycle.strike_usdg6;
          record.cycle3.unitPrice6 = row.unit_price6;
          record.cycle3.gross6 = row.gross_usdg6;
          record.cycle3.toVault6 = row.to_vault6;
          record.cycle3.toOvercall6 = row.to_overcall6;
          record.cycle3.orderHash = row.order_hash;
          record.cycle3.rollOpenTx = cycle.roll_open_tx;
          record.cycle3.optionId = row.option_id;
          record.cycle3.claimKey = claimKey.toString();
          return row;
        });

        await step('cycle 3, tick #11 (Listed, nobody has filled): visible in the book', async () => {
          await roll.tick();
          const row = store.getListing(listed3.order_hash);
          assert(row !== null, 'row');
          assertEq(row.status, 'visible', 'listing status after the book check');
          assert(row.visible_at !== null, 'visible_at stamped');
          assertEq(alerts.kinds().length, 4, 'no new alert');
        });

        await step("cycle 3: a buyer fills the listing on the real Seaport, using the keeper's /orders payload", async () => {
          const { fillTx } = await buyerFills(listed3);
          record.cycle3.fillTx = fillTx;
        });

        await step('cycle 3, tick #12 (Listed, filled): Seaport getOrderStatus reports the fill', async () => {
          await roll.tick();
          const row = store.getListing(listed3.order_hash);
          assert(row !== null, 'row');
          assertEq(row.status, 'filled', 'listing status');
          assertEq(row.seaport_total_filled, row.seaport_total_size, 'fully filled');
          assertEq(alerts.kinds().length, 4, 'no new alert');
        });

        await step('cycle 3: the depositor queues 10 of 25 shares while the call is live (Listed, filled)', async () => {
          const epochBefore = await pub.readContract({ ...V, functionName: 'epochId' });
          assertEq(epochBefore, 1n, 'epoch 1: the constructor starts there and no queue has settled yet');
          assertEq(await pub.readContract({ ...V, functionName: 'balanceOf', args: [DEPOSITOR.address] }), DEPOSIT, 'all 25e18 shares still free');
          const { hash, receipt } = await sendTx('vault.queueRedeem(10e18) (depositor)', DEPOSITOR, () =>
            wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultQueueAbi, functionName: 'queueRedeem', args: [QUEUED] }),
          );
          const ev = only(parseEventLogs({ abi: vaultQueueAbi, eventName: 'QueueRedeem', logs: receipt.logs }), vault, 'QueueRedeem');
          assertEq(ev.args.owner.toLowerCase(), DEPOSITOR.address.toLowerCase(), 'QueueRedeem.owner');
          assertEq(ev.args.shares, QUEUED, 'QueueRedeem.shares');
          assertEq(ev.args.epochId, epochBefore, 'QueueRedeem.epochId');
          assertEq(await pub.readContract({ ...V, functionName: 'balanceOf', args: [DEPOSITOR.address] }), DEPOSIT - QUEUED, 'the depositor keeps 15e18');
          assertEq(await pub.readContract({ ...V, functionName: 'balanceOf', args: [vault] }), QUEUED, 'the vault escrows the 10e18 on itself');
          assertEq(await pub.readContract({ ...V, functionName: 'totalSupply' }), DEPOSIT, 'nothing is burned until settlement');
          assertEq(await pub.readContract({ ...V, functionName: 'queuedShares' }), QUEUED, 'queuedShares');
          assertEq(await pub.readContract({ ...Q, functionName: 'queuedSharesOf', args: [DEPOSITOR.address] }), QUEUED, 'queuedSharesOf');
          assertEq(await pub.readContract({ ...Q, functionName: 'queuedEpochOf', args: [DEPOSITOR.address] }), epochBefore, 'queuedEpochOf');
          assertEq(await pub.readContract({ ...V, functionName: 'canRedeemInstantly' }), false, 'the queue is the only exit while a call is open');
          assertEq(await pub.readContract({ ...Q, functionName: 'previewRedeem', args: [QUEUED] }), 0n, 'previewRedeem quotes 0: no instant path');
          await expectRevert('completeRedeem before the epoch settles', 'EpochNotSettled', () =>
            pub.simulateContract({ account: DEPOSITOR, address: vault, abi: vaultQueueAbi, functionName: 'completeRedeem', args: [DEPOSITOR.address] }),
          );
          record.cycle3.queue = { sharesQueued: QUEUED.toString(), epoch: epochBefore.toString(), queueTx: hash };
        });

        await step('cycle 3: warp to exerciseTimestamp; spot moves above the strike; tick #13 -> lockBook', async () => {
          await warpTo(series3.exercise, 'cycle-3 exerciseTimestamp');
          const strike = strikeOfCycle3();
          // In the money, honestly: the feed says spot = strike + 5 USD. Set only NOW, after the
          // keeper has written and listed — before rollOpen it would have moved the OTM band and
          // the pick, before approveListing the premium floor. Nothing in lockBook, exercise,
          // rollClose or the queue reads spot, and Valorem is physically settled with no oracle,
          // so this is the narrative of the week, not its mechanism.
          await sendTx('MockFeed.setAnswer (strike + 5 USD: in the money)', ADMIN, () =>
            wallet.writeContract({ account: ADMIN, chain: forkChain, address: feed, abi: mockFeedAbi, functionName: 'setAnswer', args: [itmAnswer8()] }),
          );
          const spot = await pub.readContract({ ...V, functionName: 'spotUsdg' });
          assert(spot > strike, `spot ${spot} above strike ${strike}`);
          note(`spot ${spot} USDG6 > strike ${strike} USDG6`);
          record.cycle3.itmSpotUsdg6 = spot.toString();

          // The deposit gate keys on the timestamp, not the phase: the vault is still Listed but
          // the exercise window has opened, so new money is refused before anyone can mint against
          // a NAV that an exercise is about to collapse (Vault._requireDepositPhase).
          assertEq(await pub.readContract({ ...Q, functionName: 'maxDeposit', args: [DEPOSITOR.address] }), 0n, 'maxDeposit quotes 0 once the exercise window is open');
          await expectRevert('deposit after the exercise window opened (vault still Listed)', 'DepositsClosedForCycle', () =>
            pub.simulateContract({ account: DEPOSITOR, address: vault, abi: vaultAbi, functionName: 'deposit', args: [LOT, DEPOSITOR.address] }),
          );

          const deletesBefore = stub.requests.filter((r) => r.startsWith('DELETE')).length;
          await roll.tick();
          assertEq(await pub.readContract({ ...V, functionName: 'phase' }), roll.Phase.Exercisable, 'phase');
          const cycle = store.getCycle(3);
          assert(cycle !== null, 'cycle row');
          assertEq(cycle.status, 'locked', 'cycle status');
          assert(cycle.lock_tx !== null, 'lock_tx recorded');
          assertEq(store.getTx(cycle.lock_tx)?.status ?? null, 'success', 'lockBook receipt');
          // A filled row is terminal: liveListingsForCycle excludes it, so lockBook neither retires
          // it nor tells the book. (Cycle 2's unfilled row became 'expired' with a DELETE.)
          assertEq(store.getListing(listed3.order_hash)?.status ?? null, 'filled', 'the filled listing row stays filled');
          assertEq(stub.requests.filter((r) => r.startsWith('DELETE')).length, deletesBefore, 'no DELETE for a filled listing');
          assertEq(store.openListings().length, 0, '/orders serves nothing');
          assertEq(alerts.kinds().length, 4, 'no new alert');
          record.cycle3.lockTx = cycle.lock_tx;
        });

        const exercised3 = await step('cycle 3: the buyer exercises 9 of 23 on the REAL Valorem Clear', async () => {
          const strike = strikeOfCycle3();
          const optionId = BigInt(listed3.option_id);
          const written = BigInt(listed3.contracts);
          const claimKey = await pub.readContract({ ...V, functionName: 'claimKey' });
          assert(claimKey !== 0n, 'claim still open');

          // What the Clear pulls: exerciseAmount x amount, plus its own fee ONLY if the fee switch
          // is on (live 4663: off). Read live rather than assumed; the debit is asserted exact.
          const [feesEnabled, feeBps] = await Promise.all([
            pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feesEnabled' }),
            pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'feeBps' }),
          ]);
          const rx = strike * EXERCISED;
          let clearFee = 0n;
          if (feesEnabled) {
            clearFee = (rx * BigInt(feeBps)) / 10_000n;
            if (clearFee === 0n) clearFee = 1n;
          }
          const debit = rx + clearFee;
          note(`Clear feesEnabled=${String(feesEnabled)} feeBps=${feeBps}: exercising ${EXERCISED} pulls ${rx} + fee ${clearFee} = ${debit} USDG6`);

          assertEq(await balanceOf(USDG, BUYER.address), 0n, 'the buyer spent every USDG6 on the fill');
          const buyerNvdaBefore = await balanceOf(NVDA, BUYER.address);
          const clearUsdgBefore = await balanceOf(USDG, CLEAR);
          const clearNvdaBefore = await balanceOf(NVDA, CLEAR);
          const vaultUsdgBefore = await balanceOf(USDG, vault);
          assertEq(vaultUsdgBefore, BigInt(listed3.to_vault6), 'the vault holds exactly this premium leg: cycle 1 was claimed out, cycle 2 earned nothing');
          assertEq(await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'balanceOf', args: [BUYER.address, optionId] }), written, 'the buyer holds all 23 option tokens');
          assertEq(await pub.readContract({ ...V, functionName: 'totalAssets' }), DEPOSIT, 'NAV before the exercise');
          assertEq(await pub.readContract({ ...V, functionName: 'contractsAssigned' }), 0n, 'nothing assigned yet');

          await deal(USDG, BUYER.address, debit);
          await sendTx('USDG.approve(clear)', BUYER, () =>
            wallet.writeContract({ account: BUYER, chain: forkChain, address: USDG, abi: erc20Abi, functionName: 'approve', args: [CLEAR, debit] }),
          );
          const { hash, receipt } = await sendTx(`clear.exercise(optionId, ${EXERCISED}) (buyer)`, BUYER, () =>
            wallet.writeContract({ account: BUYER, chain: forkChain, address: CLEAR, abi: clearAbi, functionName: 'exercise', args: [optionId, EXERCISED] }),
          );
          const ev = only(parseEventLogs({ abi: clearAbi, eventName: 'OptionsExercised', logs: receipt.logs }), CLEAR, 'OptionsExercised');
          assertEq(ev.args.optionId, optionId, 'OptionsExercised.optionId');
          assertEq(ev.args.exerciser.toLowerCase(), BUYER.address.toLowerCase(), 'OptionsExercised.exerciser');
          assertEq(ev.args.amount, EXERCISED, 'OptionsExercised.amount');

          // All four token legs, exact.
          assertEq(await balanceOf(USDG, BUYER.address), 0n, 'the Clear pulled exactly exerciseAmount x 9 (+ fee)');
          assertEq((await balanceOf(NVDA, BUYER.address)) - buyerNvdaBefore, EXERCISED * LOT, 'the buyer took delivery of 9 NVDA');
          assertEq((await balanceOf(USDG, CLEAR)) - clearUsdgBefore, debit, 'the strike USDG sits in the Clear');
          assertEq(clearNvdaBefore - (await balanceOf(NVDA, CLEAR)), EXERCISED * LOT, 'the Clear released 9 NVDA');
          assertEq(await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'balanceOf', args: [BUYER.address, optionId] }), written - EXERCISED, '23 -> 14 option tokens');
          assertEq(await balanceOf(USDG, vault), vaultUsdgBefore, 'nothing reached the vault yet: the proceeds wait inside the claim');

          // The vault is the SOLE writer of this private option type, so every exercised contract
          // lands on its claim. Read BEFORE rollClose: it zeroes claimKey and Valorem then reverts.
          const claim = await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'claim', args: [claimKey] });
          assertEq(claim.optionId, optionId, 'claim.optionId');
          assertEq(claim.amountWritten, written * LOT, 'claim.amountWritten is a 1e18-scaled scalar');
          assertEq(claim.amountExercised, EXERCISED * LOT, 'claim.amountExercised = 9e18, the scalar');
          const position = await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'position', args: [claimKey] });
          assertEq(position.underlyingAmount, (written - EXERCISED) * LOT, 'position.underlyingAmount: 14 lots still locked');
          assertEq(position.exerciseAmount, rx, 'position.exerciseAmount: 9 strikes of USDG');
          assertEq(await pub.readContract({ ...V, functionName: 'contractsAssigned' }), EXERCISED, 'vault.contractsAssigned() is the raw count 9, not 9e18');
          assertEq(await pub.readContract({ ...V, functionName: 'lockedAssets' }), (written - EXERCISED) * LOT, 'vault.lockedAssets()');
          assertEq(await pub.readContract({ ...V, functionName: 'claimedExerciseProceeds' }), rx, 'vault.claimedExerciseProceeds()');
          assertEq(await pub.readContract({ ...V, functionName: 'totalAssets' }), DEPOSIT - EXERCISED * LOT, 'NAV is already down 9 lots, before settlement');
          assertEq(await pub.readContract({ ...V, functionName: 'contractsWritten' }), written, 'contractsWritten');
          assertEq(await pub.readContract({ ...V, functionName: 'contractsRemaining' }), 0n, 'no unsold inventory');
          assertEq(await pub.readContract({ ...V, functionName: 'contractsSold' }), written, 'contractsSold');
          assertEq(await pub.readContract({ ...Q, functionName: 'maxDeposit', args: [DEPOSITOR.address] }), 0n, 'deposits stay closed: Exercisable, and unredeemed strike proceeds in the claim');

          record.cycle3.exerciseTx = hash;
          record.cycle3.contractsExercised = EXERCISED.toString();
          record.cycle3.exerciseDebitUsdg6 = debit.toString();
          record.cycle3.clearFeesEnabled = feesEnabled;
          record.cycle3.claimAmountExercised = claim.amountExercised.toString();
          return { strike, optionId, claimKey, rx, debit };
        });

        const closed3 = await step('cycle 3: warp to expiryTimestamp; tick #14 -> rollClose: redeem the assigned claim, harvest, settle the queue', async () => {
          await warpTo(series3.expiry, 'cycle-3 expiryTimestamp');
          await sendTx('MockFeed.setAnswer (refresh updatedAt; still in the money)', ADMIN, () =>
            wallet.writeContract({ account: ADMIN, chain: forkChain, address: feed, abi: mockFeedAbi, functionName: 'setAnswer', args: [itmAnswer8()] }),
          );
          const written = BigInt(listed3.contracts);
          const toVault = BigInt(listed3.to_vault6);
          const [supplyBefore, accBefore, distributedBefore, claimedBefore, epochBefore, vaultUsdgBefore, vaultNvdaBefore, feeSafeBefore, protocol] = await Promise.all([
            pub.readContract({ ...V, functionName: 'totalSupply' }),
            pub.readContract({ ...V, functionName: 'accUsdgPerShare' }),
            pub.readContract({ ...V, functionName: 'totalUsdgDistributed' }),
            pub.readContract({ ...Q, functionName: 'totalUsdgClaimed' }),
            pub.readContract({ ...V, functionName: 'epochId' }),
            balanceOf(USDG, vault),
            balanceOf(NVDA, vault),
            balanceOf(USDG, FEE_SAFE.address),
            policy.readPolicy(),
          ]);
          assertEq(supplyBefore, DEPOSIT, 'the escrowed shares still count in the supply');
          assertEq(vaultNvdaBefore, DEPOSIT - written * LOT, 'the vault holds what it did not write');
          assertEq(await pub.readContract({ ...V, functionName: 'contractsAssigned' }), EXERCISED, "the harness's own read of vault.contractsAssigned(): 9 before the close");
          assertEq(await pub.readContract({ ...V, functionName: 'claimKey' }), exercised3.claimKey, 'claim still open');

          // THE KEEPER'S OWN pre-close read, called directly. roll.ts:doRollClose takes
          // `contractsAssignedAt(snap)` before it sends the transaction; with this vault bytecode
          // the RollClose event then wins in resolveContractsAssigned (Vault.sol:797-801 reads the
          // count and emits it unconditionally), so nothing downstream of the tick — the cycle
          // row, /cycles, the alert — would notice a wrong divisor or a swallowed revert in that
          // function. Here it runs through the keeper's own publicClient (Multicall3-batched, the
          // production read path) against the real Clear, on the keeper's own snapshot.
          const keeperSnap = await roll.snapshot();
          assertEq(keeperSnap.phase, roll.Phase.Exercisable, "the keeper's snapshot: still Exercisable");
          assertEq(keeperSnap.vaultClaimKey, exercised3.claimKey, "the keeper's snapshot carries the open claim key");
          assert(keeperSnap.blockTimestamp >= BigInt(series3.expiry), "the keeper's snapshot is past expiry: the next tick closes");
          const assignedBefore = await roll.contractsAssignedAt(keeperSnap);
          assertEq(assignedBefore, EXERCISED, 'roll.contractsAssignedAt(snap) = 9n: claim.amountExercised 9e18 / 1e18, the keeper twin of ValoremLib.sol:149');

          await roll.tick();
          assertEq(await pub.readContract({ ...V, functionName: 'phase' }), roll.Phase.Idle, 'phase after rollClose');
          const cycle = store.getCycle(3);
          assert(cycle !== null, 'cycle row');
          assertEq(cycle.status, 'closed', 'cycle status');
          assert(cycle.roll_close_tx !== null, 'roll_close_tx recorded');
          assertEq(store.getTx(cycle.roll_close_tx)?.status ?? null, 'success', 'rollClose receipt');
          const receipt = await pub.getTransactionReceipt({ hash: cycle.roll_close_tx as Hex });

          /* ---- the receipt: what the vault and the Clear said happened ---- */
          const rc = only(parseEventLogs({ abi: vaultQueueAbi, eventName: 'RollClose', logs: receipt.logs }), vault, 'RollClose');
          assertEq(rc.args.cycleNumber, 3, 'RollClose.cycleNumber');
          assertEq(rc.args.assetsReturned, (written - EXERCISED) * LOT, 'RollClose.assetsReturned = 14 NVDA');
          assertEq(rc.args.usdgFromAssignment, exercised3.rx, 'RollClose.usdgFromAssignment = 9 x strike');
          assertEq(rc.args.contractsAssignedCount, EXERCISED, 'RollClose.contractsAssignedCount = 9');
          const assetsReturned = rc.args.assetsReturned;
          const usdgFromAssignment = rc.args.usdgFromAssignment;

          // Both branches of the keeper's resolver, on the REAL receipt and the REAL pre-read.
          // The event path is what the tick just took (bound below through the row and the
          // alert); the fallback path is reachable only by removing the RollClose log, which is
          // done to a copy of the receipt here and nowhere in production.
          const viaEvent = roll.resolveContractsAssigned(receipt, assignedBefore);
          assertEq(viaEvent.source, 'RollClose', 'resolver: the vault event is the source');
          assertEq(viaEvent.assigned, Number(EXERCISED), 'resolver: 9 published from the event');
          assertEq(viaEvent.fromEvent, EXERCISED, 'resolver: fromEvent 9n');
          assertEq(viaEvent.fromClaim, EXERCISED, 'resolver: fromClaim 9n, the pre-read');
          assertEq(viaEvent.mismatch, false, 'resolver: the event and the pre-close Valorem read agree');
          const rollCloseTopic = encodeEventTopics({ abi: [rollCloseEvent], eventName: 'RollClose' })[0];
          const withoutRollClose = { ...receipt, logs: receipt.logs.filter((entry) => entry.topics[0] !== rollCloseTopic) };
          assertEq(withoutRollClose.logs.length, receipt.logs.length - 1, 'exactly one RollClose log stripped from the copy');
          const viaClaim = roll.resolveContractsAssigned(withoutRollClose, assignedBefore);
          assertEq(viaClaim.source, 'claim-preread', 'resolver without the event: the pre-close Valorem read stands in');
          assertEq(viaClaim.assigned, Number(EXERCISED), 'resolver without the event: still 9, from the real pre-read');
          assertEq(viaClaim.fromEvent, null, 'resolver without the event: fromEvent null');
          assertEq(viaClaim.mismatch, false, 'resolver without the event: nothing to compare');
          const viaNothing = roll.resolveContractsAssigned(withoutRollClose, null);
          assertEq(viaNothing.source, 'unknown', 'resolver with neither: unknown');
          assertEq(viaNothing.assigned, 0, 'resolver with neither: 0, and doRollClose warns');

          const clearRedeemed = only(parseEventLogs({ abi: clearAbi, eventName: 'ClaimRedeemed', logs: receipt.logs }), CLEAR, "the Clear's ClaimRedeemed");
          assertEq(clearRedeemed.args.claimId, exercised3.claimKey, 'Clear.ClaimRedeemed.claimId');
          assertEq(clearRedeemed.args.optionId, exercised3.optionId, 'Clear.ClaimRedeemed.optionId');
          assertEq(clearRedeemed.args.redeemer.toLowerCase(), vault.toLowerCase(), 'the vault redeemed its own claim');
          assertEq(clearRedeemed.args.exerciseAmountRedeemed, usdgFromAssignment, 'Clear.ClaimRedeemed.exerciseAmountRedeemed');
          assertEq(clearRedeemed.args.underlyingAmountRedeemed, assetsReturned, 'Clear.ClaimRedeemed.underlyingAmountRedeemed');
          const adapterRedeemed = only(parseEventLogs({ abi: vaultQueueAbi, eventName: 'ClaimRedeemed', logs: receipt.logs }), vault, "the adapter's ClaimRedeemed");
          assertEq(adapterRedeemed.args.claimKey, exercised3.claimKey, 'ClaimRedeemed.claimKey');
          assertEq(adapterRedeemed.args.underlyingReturned, assetsReturned, 'ClaimRedeemed.underlyingReturned, measured as a balance delta');
          assertEq(adapterRedeemed.args.exerciseReceived, usdgFromAssignment, 'ClaimRedeemed.exerciseReceived, measured as a balance delta');

          const hv = only(parseEventLogs({ abi: vaultQueueAbi, eventName: 'Harvest', logs: receipt.logs }), vault, 'Harvest');
          const gross = hv.args.grossUsdg;
          const fee = hv.args.feeUsdg;
          const net = hv.args.netUsdg;
          assertEq(hv.args.cycleNumber, 3, 'Harvest.cycleNumber');
          assertEq(gross, toVault + usdgFromAssignment, 'gross = the premium leg that filled + the strike proceeds the claim returned');
          assertEq(protocol.protocolFeeBps, LAUNCH_POLICY.protocolFeeBps, 'policy().protocolFeeBps is still the launch 500 (5% of premium)');
          // Fee-free = RollClose.usdgFromAssignment from THIS receipt, the amount rollClose hands
          // _harvest. The gross still carries the strike proceeds; the fee does not touch them.
          assertEq(fee, harvestFee(gross, usdgFromAssignment, protocol.protocolFeeBps), "fee = floor((gross - RollClose.usdgFromAssignment) x protocolFeeBps / 10000): premium only, strike proceeds never fee'd");
          assertEq(fee, (toVault * protocol.protocolFeeBps) / BPS, 'fee = floor(premium leg x protocolFeeBps / 10000), the same number from the fill side');
          assertEq(net, gross - fee, 'net = gross - fee, strike proceeds credited to holders in full');

          // The keeper sums every Harvest for the cycle from its own rollOpen block to the close.
          // Re-derived here from the chain; there must be exactly one (no deposit ran a checkpoint).
          const openTx = store.getTx(cycle.roll_open_tx ?? '');
          assert(openTx !== null && openTx.block_number !== null, 'the rollOpen block is on record');
          const harvestLogs = await pub.getLogs({ address: vault, event: harvestEvent, args: { cycleNumber: 3 }, fromBlock: BigInt(openTx.block_number), toBlock: receipt.blockNumber });
          assertEq(harvestLogs.length, 1, 'one Harvest event over [rollOpen block, rollClose block]');
          // Every Harvest over the range obeys the per-event fee rule: the terminal one (in the
          // rollClose transaction) excludes the strike proceeds, a deposit checkpoint excludes 0.
          for (const entry of harvestLogs) {
            const feeFree = entry.transactionHash === receipt.transactionHash ? usdgFromAssignment : 0n;
            assertEq(
              entry.args.feeUsdg ?? null,
              harvestFee(entry.args.grossUsdg ?? 0n, feeFree, protocol.protocolFeeBps),
              `Harvest in ${String(entry.transactionHash)}: fee on premium only (fee-free ${feeFree})`,
            );
            assertEq(entry.args.netUsdg ?? null, (entry.args.grossUsdg ?? 0n) - (entry.args.feeUsdg ?? 0n), `Harvest in ${String(entry.transactionHash)}: net = gross - fee`);
          }
          const summed = harvestLogs.reduce(
            (acc, entry) => ({ gross: acc.gross + (entry.args.grossUsdg ?? 0n), fee: acc.fee + (entry.args.feeUsdg ?? 0n), net: acc.net + (entry.args.netUsdg ?? 0n) }),
            { gross: 0n, fee: 0n, net: 0n },
          );
          assertEq(summed.gross, gross, 'summed Harvest gross');
          assertEq(summed.fee, fee, 'summed Harvest fee');
          assertEq(summed.net, net, 'summed Harvest net');

          /* ---- the keeper's row and alert ---- */
          assertEq(cycle.gross_usdg6, gross.toString(), 'gross_usdg6');
          assertEq(cycle.fee_usdg6, fee.toString(), 'fee_usdg6');
          assertEq(cycle.net_usdg6, net.toString(), 'net_usdg6');
          assertEq(cycle.contracts_assigned, Number(EXERCISED), 'contracts_assigned = 9, from the RollClose event');
          assertEq(alerts.kinds().join(','), 'roll_open,roll_close,roll_close,roll_open,roll_close', 'alerts');
          const last = alerts.received[alerts.received.length - 1];
          assert(last !== undefined, 'alert');
          assertEq(last.message, `cycle 3 closed: ${roll.formatUsdg(gross)} USDG harvested, ${roll.formatUsdg(net)} to depositors.`, "the roll_close message, in the keeper's own format");
          const data = last.data as {
            cycleNumber?: number;
            contractsAssigned?: number;
            contractsAssignedSource?: string;
            contractsAssignedFromClaim?: number | null;
          };
          assertEq(data.cycleNumber ?? null, 3, 'roll_close alert cycle');
          assertEq(data.contractsAssigned ?? null, Number(EXERCISED), 'roll_close alert carries contractsAssigned = 9');
          assertEq(data.contractsAssignedSource ?? null, 'RollClose', 'roll_close alert: the count came from the RollClose event');
          // This binds the value doRollClose's OWN contractsAssignedAt call returned inside the
          // tick — not the harness's call above — to 9: the pre-read the keeper took, and would
          // have published had the event been missing.
          assertEq(
            data.contractsAssignedFromClaim === undefined ? 'absent' : data.contractsAssignedFromClaim,
            Number(EXERCISED),
            "roll_close alert: the keeper's own pre-close Valorem read inside the tick was 9",
          );
          note('the roll_close MESSAGE has the same shape as an unassigned filled week; the assignment count travels only in data.contractsAssigned (with contractsAssignedSource and contractsAssignedFromClaim beside it)');

          /* ---- fee, distribution, queue settlement ---- */
          const swept = only(parseEventLogs({ abi: vaultQueueAbi, eventName: 'FeeSwept', logs: receipt.logs }), vault, 'FeeSwept');
          assertEq(swept.args.feeRecipient.toLowerCase(), FEE_SAFE.address.toLowerCase(), 'FeeSwept.feeRecipient');
          assertEq(swept.args.amount, fee, 'FeeSwept.amount');
          assertEq((await balanceOf(USDG, FEE_SAFE.address)) - feeSafeBefore, fee, 'the fee Safe received the fee in the same transaction');
          assertEq(await pub.readContract({ ...Q, functionName: 'pendingFeeUsdg' }), 0n, 'no fee left pending');

          const accAfter = await pub.readContract({ ...V, functionName: 'accUsdgPerShare' });
          const indexDelta = accAfter - accBefore;
          assertEq(indexDelta, (net * ACC_PRECISION) / supplyBefore, 'index delta = floor(net x 1e27 / totalSupply), escrow included in the supply');
          const distributed = only(parseEventLogs({ abi: vaultQueueAbi, eventName: 'UsdgDistributed', logs: receipt.logs }), vault, 'UsdgDistributed');
          assertEq(distributed.args.totalSupply, supplyBefore, 'UsdgDistributed.totalSupply: the escrowed shares were still in the supply');
          assertEq(distributed.args.accUsdgPerShare, accAfter, 'UsdgDistributed.accUsdgPerShare');
          assertEq(distributed.args.amount, (indexDelta * supplyBefore) / ACC_PRECISION, 'UsdgDistributed.amount = what the index can represent');
          const dust = await pub.readContract({ ...Q, functionName: 'usdgDust' });
          assertEq(dust, net - distributed.args.amount, 'usdgDust = net - credited');
          assertEq((await pub.readContract({ ...V, functionName: 'totalUsdgDistributed' })) - distributedBefore, distributed.args.amount, 'totalUsdgDistributed grew by the credited amount');

          const settled = only(parseEventLogs({ abi: vaultQueueAbi, eventName: 'QueueSettled', logs: receipt.logs }), vault, 'QueueSettled');
          assertEq(settled.args.epochId, epochBefore, 'QueueSettled.epochId');
          assertEq(settled.args.shares, QUEUED, 'QueueSettled.shares');
          const escrowUsdg = settled.args.usdgOut;
          const payoutAssets = settled.args.assets;
          assertEq(escrowUsdg, (QUEUED * indexDelta) / ACC_PRECISION, "the escrow's own accrual: 10e18 x indexDelta / 1e27, taken out of the index for the queue");
          assertEq(payoutAssets, ((vaultNvdaBefore + assetsReturned) * QUEUED) / supplyBefore, 'payoutAssets = idleAssets after the redeem x queued / supply');
          assertEq((await pub.readContract({ ...Q, functionName: 'totalUsdgClaimed' })) - claimedBefore, escrowUsdg, 'totalUsdgClaimed counts the escrow take');
          if (DEPOSIT === 25n * LOT) {
            assertEq(payoutAssets, 6_400_000_000_000_000_000n, '16e18 x 10e18 / 25e18 = 6.4 NVDA, not the 10 that were queued');
            assertEq(dust, 0n, '1e27 / 25e18 is an integer, so the index is exact and there is no dust');
            assertEq(escrowUsdg, (net * 2n) / 5n, 'floor(2/5 of net)');
          }

          /* ---- state after ---- */
          assertEq(await pub.readContract({ ...V, functionName: 'totalSupply' }), supplyBefore - QUEUED, 'the escrowed shares were burned at settlement');
          assertEq(await pub.readContract({ ...V, functionName: 'queuedShares' }), 0n, 'queue drained');
          assertEq(await pub.readContract({ ...V, functionName: 'epochId' }), epochBefore + 1n, 'epoch advanced');
          const [epochSharesLeft, epochAssetsLeft, epochUsdgLeft] = await pub.readContract({ ...Q, functionName: 'epochs', args: [epochBefore] });
          assertEq(epochSharesLeft, QUEUED, 'epochs[1].sharesRemaining');
          assertEq(epochAssetsLeft, payoutAssets, 'epochs[1].assetsRemaining');
          assertEq(epochUsdgLeft, escrowUsdg, 'epochs[1].usdgRemaining');
          assertEq(await pub.readContract({ ...V, functionName: 'reservedAssets' }), payoutAssets, 'reservedAssets');
          assertEq(await pub.readContract({ ...V, functionName: 'usdgReservedForQueue' }), escrowUsdg, 'usdgReservedForQueue');
          const vaultNvdaAfter = await balanceOf(NVDA, vault);
          assertEq(vaultNvdaAfter, vaultNvdaBefore + assetsReturned, 'the vault holds 2 never written + 14 returned');
          const idleAfter = await pub.readContract({ ...V, functionName: 'idleAssets' });
          assertEq(idleAfter, vaultNvdaAfter - payoutAssets, 'idleAssets excludes what is reserved for the epoch');
          assertEq(await pub.readContract({ ...V, functionName: 'totalAssets' }), idleAfter, 'totalAssets: nothing locked any more');
          assertEq(await pub.readContract({ ...V, functionName: 'lockedAssets' }), 0n, 'lockedAssets');
          assertEq(await pub.readContract({ ...V, functionName: 'claimKey' }), 0n, 'claimKey zeroed');
          assertEq(await pub.readContract({ ...V, functionName: 'contractsWritten' }), 0n, 'contractsWritten zeroed');
          assertEq(await pub.readContract({ ...V, functionName: 'contractsAssigned' }), 0n, 'contractsAssigned reads 0 AFTER the close, which is why the keeper reads it before');
          // The keeper's function after the close, on the keeper's own fresh snapshot: claimKey
          // is 0 (AdapterValorem.sol:148 zeroes it inside _redeemClaim), answered without a read.
          const keeperSnapAfter = await roll.snapshot();
          assertEq(keeperSnapAfter.vaultClaimKey, 0n, "the keeper's snapshot after the close: claimKey 0");
          assertEq(await roll.contractsAssignedAt(keeperSnapAfter), 0n, 'roll.contractsAssignedAt after the close: 0n from the zero claimKey, no read');
          // ...and the read it must never take: the burned claim. On the real Clear, claim() now
          // reverts TokenNotFound (the vault's and the keeper's stated reason for reading first;
          // decoded with the keeper's own clearAbi), and the keeper reports that as unknown
          // (null), never as a silent 0 — pinned on the real revert, not a stub. This probe is the
          // run's one deliberate warn line in the keeper log besides cycle 2's adoption.
          await expectRevert('clear.claim(redeemed claimKey)', 'TokenNotFound', () =>
            pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'claim', args: [exercised3.claimKey] }),
          );
          assertEq(await roll.contractsAssignedAt({ ...keeperSnapAfter, vaultClaimKey: exercised3.claimKey }), null, 'roll.contractsAssignedAt on the burned claim: null (unknown), not 0');
          assertEq(await pub.readContract({ ...V, functionName: 'canRedeemInstantly' }), true, 'flat again');
          assertEq(await pub.readContract({ address: CLEAR, abi: clearAbi, functionName: 'balanceOf', args: [vault, exercised3.claimKey] }), 0n, 'the claim NFT was burned by the redeem');
          assertEq(await balanceOf(USDG, vault), vaultUsdgBefore + usdgFromAssignment - fee, 'vault USDG = premium + strike proceeds - fee = net');
          assertEq(await balanceOf(NVDA, BUYER.address), EXERCISED * LOT, 'the buyer keeps the 9 NVDA');
          if (DEPOSIT === 25n * LOT) assertEq(idleAfter, 9_600_000_000_000_000_000n, 'idle 16 - 6.4 = 9.6 NVDA');

          const h = await health('/health');
          assertEq(h.status, 200, '/health after the assigned cycle');
          assertEq(String(h.body.status), 'ok', '/health status');
          const cycles = (await health('/cycles')).body.cycles as Array<Record<string, unknown>>;
          const servedCycle = cycles[0];
          assert(servedCycle !== undefined, '/cycles served nothing');
          assertEq(servedCycle.cycle_number as number, 3, '/cycles[0] is cycle 3');
          assertEq(servedCycle.contracts_assigned as number, Number(EXERCISED), '/cycles shows contracts_assigned 9');
          assertEq(String(servedCycle.gross_usdg6), gross.toString(), '/cycles shows the gross');
          record.health.afterCycle3 = h.body;

          record.cycle3.rollCloseTx = cycle.roll_close_tx;
          record.cycle3.harvest = {
            gross: gross.toString(),
            fee: fee.toString(),
            net: net.toString(),
            premium: toVault.toString(),
            usdgFromAssignment: usdgFromAssignment.toString(),
            feeBearing: (gross - usdgFromAssignment).toString(),
            protocolFeeBps: protocol.protocolFeeBps.toString(),
            assetsReturned: assetsReturned.toString(),
            contractsAssigned: cycle.contracts_assigned,
            contractsAssignedSource: data.contractsAssignedSource ?? null,
            contractsAssignedFromClaim: data.contractsAssignedFromClaim ?? null,
            keeperPreReadBeforeTick: assignedBefore === null ? null : assignedBefore.toString(),
          };
          record.cycle3.queue = {
            ...(record.cycle3.queue as Record<string, unknown>),
            payoutAssets: payoutAssets.toString(),
            escrowUsdg: escrowUsdg.toString(),
            indexDelta: indexDelta.toString(),
            usdgDust: dust.toString(),
          };
          note(
            `harvest gross ${roll.formatUsdg(gross)} USDG (premium ${roll.formatUsdg(toVault)} + strike proceeds ${roll.formatUsdg(usdgFromAssignment)}), ` +
              `fee ${roll.formatUsdg(fee)} (${protocol.protocolFeeBps} bps of the premium only; the strike proceeds are fee-free), net ${roll.formatUsdg(net)}; epoch ${epochBefore} reserved ${payoutAssets} NVDA wei + ${roll.formatUsdg(escrowUsdg)} USDG`,
          );
          return { gross, fee, net, escrowUsdg, payoutAssets, indexDelta, epoch: epochBefore, vaultNvdaAfter };
        });

        await step('cycle 3: the depositor completes the queued redeem, then claims the rest', async () => {
          const [previewAssets, previewUsdg] = await pub.readContract({ ...Q, functionName: 'previewCompleteRedeem', args: [DEPOSITOR.address] });
          assertEq(previewAssets, closed3.payoutAssets, 'previewCompleteRedeem.assets');
          assertEq(previewUsdg, closed3.escrowUsdg, 'previewCompleteRedeem.usdgOut');
          const nvdaBefore = await balanceOf(NVDA, DEPOSITOR.address);
          const usdgBefore = await balanceOf(USDG, DEPOSITOR.address);

          const { hash: completeTx, receipt } = await sendTx('vault.completeRedeem (depositor)', DEPOSITOR, () =>
            wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultQueueAbi, functionName: 'completeRedeem', args: [DEPOSITOR.address] }),
          );
          const entry = only(parseEventLogs({ abi: vaultQueueAbi, eventName: 'QueueEntrySettled', logs: receipt.logs }), vault, 'QueueEntrySettled');
          assertEq(entry.args.owner.toLowerCase(), DEPOSITOR.address.toLowerCase(), 'QueueEntrySettled.owner');
          assertEq(entry.args.epochId, closed3.epoch, 'QueueEntrySettled.epochId');
          assertEq(entry.args.shares, QUEUED, 'QueueEntrySettled.shares');
          assertEq(entry.args.assets, closed3.payoutAssets, 'QueueEntrySettled.assets');
          assertEq(entry.args.usdgOut, closed3.escrowUsdg, 'QueueEntrySettled.usdgOut');
          const done = only(parseEventLogs({ abi: vaultQueueAbi, eventName: 'CompleteRedeem', logs: receipt.logs }), vault, 'CompleteRedeem');
          assertEq(done.args.owner.toLowerCase(), DEPOSITOR.address.toLowerCase(), 'CompleteRedeem.owner');
          assertEq(done.args.receiver.toLowerCase(), DEPOSITOR.address.toLowerCase(), 'CompleteRedeem.receiver');
          assertEq(done.args.shares, QUEUED, 'CompleteRedeem.shares');
          assertEq(done.args.assets, closed3.payoutAssets, 'CompleteRedeem.assets');
          assertEq(done.args.usdgOut, closed3.escrowUsdg, 'CompleteRedeem.usdgOut');
          assertEq((await balanceOf(NVDA, DEPOSITOR.address)) - nvdaBefore, closed3.payoutAssets, 'NVDA actually delivered');
          assertEq((await balanceOf(USDG, DEPOSITOR.address)) - usdgBefore, closed3.escrowUsdg, "the escrow's USDG actually delivered");
          assertEq(await pub.readContract({ ...V, functionName: 'reservedAssets' }), 0n, 'the only claimant drained the epoch: no assets stranded');
          assertEq(await pub.readContract({ ...V, functionName: 'usdgReservedForQueue' }), 0n, 'no USDG stranded');
          assertEq(await pub.readContract({ ...Q, functionName: 'queuedSharesOf', args: [DEPOSITOR.address] }), 0n, 'queue slot cleared');
          assertEq(await pub.readContract({ ...Q, functionName: 'queuedEpochOf', args: [DEPOSITOR.address] }), 0n, 'queue epoch cleared');
          assertEq(await pub.readContract({ ...Q, functionName: 'owedAssets', args: [DEPOSITOR.address] }), 0n, 'nothing owed');
          assertEq(await pub.readContract({ ...Q, functionName: 'owedQueueUsdg', args: [DEPOSITOR.address] }), 0n, 'nothing owed');
          const [epochSharesLeft, epochAssetsLeft, epochUsdgLeft] = await pub.readContract({ ...Q, functionName: 'epochs', args: [closed3.epoch] });
          assertEq(epochSharesLeft + epochAssetsLeft + epochUsdgLeft, 0n, 'the epoch is empty');

          // The 15e18 that stayed earn their share of the same index move.
          const sharesLeft = await pub.readContract({ ...V, functionName: 'balanceOf', args: [DEPOSITOR.address] });
          assertEq(sharesLeft, DEPOSIT - QUEUED, '15e18 shares left');
          const claimable = await pub.readContract({ ...V, functionName: 'claimableUsdg', args: [DEPOSITOR.address] });
          assertEq(claimable, (sharesLeft * closed3.indexDelta) / ACC_PRECISION, 'claimable = shares x indexDelta / 1e27');
          const { hash: claimTx, receipt: claimReceipt } = await sendTx('vault.claimUsdg (depositor)', DEPOSITOR, () =>
            wallet.writeContract({ account: DEPOSITOR, chain: forkChain, address: vault, abi: vaultAbi, functionName: 'claimUsdg' }),
          );
          const claimed = only(parseEventLogs({ abi: vaultQueueAbi, eventName: 'ClaimUsdg', logs: claimReceipt.logs }), vault, 'ClaimUsdg');
          assertEq(claimed.args.account.toLowerCase(), DEPOSITOR.address.toLowerCase(), 'ClaimUsdg.account');
          assertEq(claimed.args.to.toLowerCase(), DEPOSITOR.address.toLowerCase(), 'ClaimUsdg.to');
          assertEq(claimed.args.amount, claimable, 'ClaimUsdg.amount = exactly claimableUsdg');
          assertEq((await balanceOf(USDG, DEPOSITOR.address)) - usdgBefore, closed3.escrowUsdg + claimable, 'USDG received this cycle: the escrow leg plus the claim');
          assertEq(await pub.readContract({ ...V, functionName: 'claimableUsdg', args: [DEPOSITOR.address] }), 0n, 'nothing left to claim');

          // Where every base unit of the gross went.
          const remainder = await balanceOf(USDG, vault);
          const [dust, unallocated, owed, accounted] = await Promise.all([
            pub.readContract({ ...Q, functionName: 'usdgDust' }),
            pub.readContract({ ...Q, functionName: 'usdgUnallocated' }),
            pub.readContract({ ...Q, functionName: 'usdgOwed' }),
            pub.readContract({ ...Q, functionName: 'usdgAccounted' }),
          ]);
          assertEq(closed3.escrowUsdg + claimable + closed3.fee + dust + owed, closed3.gross, 'gross = escrow + claim + fee + dust + owed');
          assertEq(remainder, dust + owed, 'what stays in the vault is exactly the index dust plus the per-account floor loss');
          assertEq(accounted, remainder, 'and it sits inside usdgAccounted, so it can never be re-harvested as new premium');
          assertEq(unallocated, 0n, 'nothing was received while the supply was zero');
          assert(owed <= 1n, `usdgOwed ${owed}: the MasterChef floor loss is at most one base unit (Distributor.sol, the usdgAccounted and _claimUsdg comments)`);
          if (DEPOSIT === 25n * LOT) {
            assertEq(owed, closed3.net % 5n === 0n ? 0n : 1n, 'floor(2n/5) + floor(3n/5) = n - 1 unless 5 divides n');
          }

          // Final shape.
          assertEq(await pub.readContract({ ...V, functionName: 'phase' }), roll.Phase.Idle, 'phase');
          assertEq(await pub.readContract({ ...V, functionName: 'totalSupply' }), DEPOSIT - QUEUED, 'totalSupply');
          const vaultNvda = await balanceOf(NVDA, vault);
          assertEq(vaultNvda, closed3.vaultNvdaAfter - closed3.payoutAssets, 'the vault paid the epoch out of its balance');
          assertEq(await pub.readContract({ ...V, functionName: 'reservedAssets' }), 0n, 'reservedAssets back to 0');
          assertEq(await pub.readContract({ ...V, functionName: 'idleAssets' }), vaultNvda, 'idleAssets = the whole balance again');
          assertEq(await pub.readContract({ ...V, functionName: 'totalAssets' }), vaultNvda, 'totalAssets');
          if (DEPOSIT === 25n * LOT) assertEq(vaultNvda, 9_600_000_000_000_000_000n, '9.6 NVDA backing 15 shares');
          assert((await pub.readContract({ ...Q, functionName: 'previewRedeem', args: [sharesLeft] })) > 0n, 'the instant path is open again');

          record.cycle3.queue = {
            ...(record.cycle3.queue as Record<string, unknown>),
            completeRedeemTx: completeTx,
            assetsOut: closed3.payoutAssets.toString(),
            usdgOut: closed3.escrowUsdg.toString(),
          };
          record.cycle3.claimed = claimable.toString();
          record.cycle3.claimTx = claimTx;
          record.cycle3.usdgLeftInVault = { remainder: remainder.toString(), usdgDust: dust.toString(), usdgOwed: owed.toString() };
          record.cycle3.final = {
            totalSupply: (DEPOSIT - QUEUED).toString(),
            idleAssets: vaultNvda.toString(),
            depositorNvda: (await balanceOf(NVDA, DEPOSITOR.address)).toString(),
            depositorShares: sharesLeft.toString(),
          };
          note(`completeRedeem paid ${closed3.payoutAssets} NVDA wei + ${roll.formatUsdg(closed3.escrowUsdg)} USDG; claimUsdg paid ${roll.formatUsdg(claimable)}; fee ${roll.formatUsdg(closed3.fee)}; ${remainder} base unit(s) left in the vault (dust ${dust}, owed ${owed})`);
        });
      }
    }

    /* ---------- 13. what the keeper remembers, after a restart ---------- */

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
        if (record.cycle3.skipped !== true) {
          // Derived, not guessed. txs: 4 (cycle 1) + 3 (cycle 2; its rollOpen was the harness's)
          // + 4 (cycle 3) keeper transactions. alerts: the five captured above, both roll kinds
          // force-sent past the cooldown. meta: last_heartbeat_ms plus one book_poll_ms per listing.
          assertEq(JSON.stringify(counts), JSON.stringify({ cycles: 3, listings: 3, txs: 11, alerts: 5, meta: 4 }), 'row counts after three cycles');
        }
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
  h('Cycle 3 (fresh series, in the money: filled, queued redeem, 9 of 23 assigned)');
  for (const [k, v] of Object.entries(record.cycle3)) lines.push(`- ${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
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
