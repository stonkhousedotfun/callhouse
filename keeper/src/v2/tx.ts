/**
 * Sending a transaction from a v2 mode: read state → simulate → send → record → wait, one at a
 * time, from one key.
 *
 * THE DISCIPLINE is v1's (solo.ts:809-837, roll.ts sendAndConfirm), made one reusable step:
 *   1. in flight?  the journal's newest submission for this (kind, key) is still `pending`: ask the
 *                  chain for its receipt. Mined → record it and carry on. Not mined and younger
 *                  than `inFlightTtlMs` → skip; a second copy of a transaction that has not landed
 *                  yet is how a keeper pays twice. Older, or its nonce already used on chain by
 *                  another transaction (a lost broadcast whose nonce the next send took) → mark it
 *                  `dropped` and carry on.
 *   2. advanced?   the caller's `isAdvanced()` reads chain state ("is this series already
 *                  settled?"). True → skip without simulating. Every v2 lifecycle call is
 *                  idempotent on chain, but a no-op still costs gas.
 *   3. simulate    against the fallback reader. A revert is an outcome with the decoded error name,
 *                  never a send.
 *   4. worth it?   the caller's `worthSending(result)` on the simulated return value (`settle`
 *                  returns `advanced`, `snapshot` returns `newlyRecorded`). False → skip.
 *   5. send        with an explicit nonce from NonceTracker.
 *   6. record      the hash in the journal BEFORE waiting, so a kill or a lost receipt leaves a
 *                  `pending` row that step 1 finds next time.
 *   7. wait        for the receipt, up to KEEPER_TX_TIMEOUT_MS; record the result either way.
 *
 * ONE AT A TIME. Every execute() runs inside one queue per sender, from step 1 to step 7. Two steps
 * of one tick (or a precise wake-up firing during a redeem loop) can therefore never race for a
 * nonce, and each step's state read sees the previous step's transaction mined. On a chain with
 * sub-second blocks the serialisation costs nothing that matters.
 *
 * NONCES. The next nonce is max(the tracker's own next, the node's `pending` count): the tracker
 * covers a load-balanced RPC whose answering node has not seen the transaction just sent; the
 * node covers a transaction sent from the same key by someone else (an operator by hand). The
 * tracker forgets its value whenever a send fails or a receipt does not come, so a nonce that was
 * never used is re-read from the chain instead of leaving a permanent gap.
 *
 * No alerts here: the outcome says what happened and the mode's loop decides what to page.
 * The chain is behind the TxChain port so the steps are unit-tested with a fake; viemTxChain is the
 * production adapter.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  HttpRequestError,
  LimitExceededRpcError,
  SocketClosedError,
  TimeoutError,
  TransactionReceiptNotFoundError,
  WebSocketRequestError,
  type Abi,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  type Hash,
  type PublicClient,
  type WalletClient,
} from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import type { Logger } from './logger.js';
import { redactUrls } from './redact.js';
import type { V2Store } from './store.js';

/*//////////////////////////////////////////////////////////////
                              CALLS
//////////////////////////////////////////////////////////////*/

export type WriteMutability = 'nonpayable' | 'payable';
export type WriteFunctionName<TAbi extends Abi> = ContractFunctionName<TAbi, WriteMutability>;

/** A state-changing call, typed by its ABI: `args` and the simulated result follow `functionName`. */
export interface WriteCall<TAbi extends Abi = Abi, TName extends WriteFunctionName<TAbi> = WriteFunctionName<TAbi>> {
  address: Address;
  abi: TAbi;
  functionName: TName;
  args: ContractFunctionArgs<TAbi, WriteMutability, TName>;
  /**
   * A FIXED gas limit, used for the simulation and the send. Required in practice for every call
   * that wraps an inner call in try/catch or a raw call (snapshot, finalize, settle, redeemBatch,
   * roll): eth_estimateGas finds the smallest limit at which the OUTER call succeeds, which is one
   * where the inner call ran out of gas and silently did nothing. Unset: the node estimates.
   */
  gas?: bigint;
}

export type WriteResult<TAbi extends Abi, TName extends WriteFunctionName<TAbi>> = ContractFunctionReturnType<TAbi, WriteMutability, TName>;

/*//////////////////////////////////////////////////////////////
                            THE PORT
//////////////////////////////////////////////////////////////*/

export interface TxReceiptSummary {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  gasUsed: bigint;
}

/** What the sender needs from the chain. */
export interface TxChain {
  readonly account: Address;
  /** Rejects on a revert (or an RPC failure) with viem's error. */
  simulate(call: WriteCall): Promise<{ result: unknown; request: unknown }>;
  /** Sign and broadcast the simulated request at `nonce`. */
  broadcast(request: unknown, nonce: number): Promise<Hash>;
  /** The node's transaction count for the account, pending included. */
  pendingNonce(): Promise<number>;
  /** The node's transaction count for the account at the latest block: every nonce below it is used. */
  minedNonce(): Promise<number>;
  /** Rejects when no receipt arrives within `timeoutMs`. */
  waitForReceipt(hash: Hash, timeoutMs: number): Promise<TxReceiptSummary>;
  /** null when the node has no receipt (not mined, or unknown). */
  getReceipt(hash: Hash): Promise<TxReceiptSummary | null>;
}

const summary = (r: { status: 'success' | 'reverted'; blockNumber: bigint; gasUsed: bigint }): TxReceiptSummary => ({
  status: r.status,
  blockNumber: r.blockNumber,
  gasUsed: r.gasUsed,
});

/** Production TxChain: simulate on the fallback reader, sign and send on the primary-pinned wallet. */
export function viemTxChain(publicClient: PublicClient, walletClient: WalletClient, account: PrivateKeyAccount): TxChain {
  return {
    account: account.address,
    async simulate(call) {
      // The generic WriteCall<Abi> is too wide for viem's per-ABI inference; the call was typed at its origin.
      const { result, request } = await publicClient.simulateContract({ ...call, account } as never);
      return { result, request };
    },
    broadcast: (request, nonce) => walletClient.writeContract({ ...(request as object), nonce } as never),
    pendingNonce: () => publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' }),
    minedNonce: () => publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' }),
    waitForReceipt: async (hash, timeoutMs) => summary(await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs, confirmations: 1 })),
    async getReceipt(hash) {
      try {
        return summary(await publicClient.getTransactionReceipt({ hash }));
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) return null;
        throw error;
      }
    },
  };
}

/*//////////////////////////////////////////////////////////////
                         NONCES AND ORDER
//////////////////////////////////////////////////////////////*/

/** Runs async functions strictly one after another, in call order, whatever each one does. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(() => fn());
    // The chain must survive a rejection, or one failed step would reject every later one.
    this.tail = next.catch(() => undefined);
    return next;
  }
}

/** The next nonce for one key. Not safe on its own across concurrent callers: use it inside SerialQueue. */
export class NonceTracker {
  private nextNonce: number | null = null;

  /** max(own next, the node's pending count). */
  async take(readPending: () => Promise<number>): Promise<number> {
    const chain = await readPending();
    return this.nextNonce === null ? chain : Math.max(this.nextNonce, chain);
  }

  /** `nonce` was broadcast. */
  used(nonce: number): void {
    this.nextNonce = nonce + 1;
  }

  /** Forget: the next take() trusts the node. After a failed send or a missing receipt. */
  reset(): void {
    this.nextNonce = null;
  }

  peek(): number | null {
    return this.nextNonce;
  }
}

/*//////////////////////////////////////////////////////////////
                             ERRORS
//////////////////////////////////////////////////////////////*/

/** The custom error name a simulation or call reverted with (`TooEarly`, `AlreadySettled`), or null. */
export function revertName(error: unknown): string | null {
  return revertDetail(error)?.name ?? null;
}

/**
 * The custom error a simulation or call reverted with, with its decoded arguments (`SourceNotPinned(source, reason)`),
 * or null. An error the ABI does not know has its 4-byte selector as `name` and no arguments.
 */
export function revertDetail(error: unknown): { name: string; args: readonly unknown[] } | null {
  if (!(error instanceof BaseError)) return null;
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return null;
  if (reverted.data?.errorName !== undefined) return { name: reverted.data.errorName, args: reverted.data.args ?? [] };
  return reverted.signature === undefined ? null : { name: reverted.signature, args: [] };
}

/**
 * Whether `error` is the transport failing (no answer, a timeout, a closed socket, a rate limit) rather than the
 * node executing the call and refusing it. A revert without data (an out-of-gas) is not a transport failure.
 */
export function isTransportError(error: unknown): boolean {
  if (error instanceof HttpRequestError || error instanceof TimeoutError || error instanceof WebSocketRequestError || error instanceof SocketClosedError || error instanceof LimitExceededRpcError) return true;
  if (!(error instanceof BaseError)) return false;
  return error.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError || e instanceof WebSocketRequestError || e instanceof SocketClosedError || e instanceof LimitExceededRpcError) !== null;
}

/** The `simulation-reverted` outcome of a simulation that threw `error`: its custom error's name and arguments. */
export function simulationReverted(error: unknown): Extract<TxOutcome, { status: 'simulation-reverted' }> {
  const detail = revertDetail(error);
  return {
    status: 'simulation-reverted',
    revert: detail?.name ?? null,
    error: describeError(error),
    ...(detail !== null && detail.args.length > 0 ? { revertArgs: detail.args } : {}),
    ...(isTransportError(error) ? { transportError: true } : {}),
  };
}

/** One line for a log or an alert: viem's short message, not its multi-paragraph dump; URLs by origin only. */
export function describeError(error: unknown): string {
  if (error instanceof BaseError) return redactUrls(error.shortMessage);
  return redactUrls(error instanceof Error ? error.message : String(error));
}

/**
 * Every URL in `text` whose path, query or userinfo could carry a key, reduced to scheme://host/…. The rule moved to
 * /redact.ts so the loggers apply the same one to every line; re-exported here for the call sites that
 * already import it from this module.
 */
export { redactUrls };

/*//////////////////////////////////////////////////////////////
                             SENDER
//////////////////////////////////////////////////////////////*/

export type TxOutcome =
  /** isAdvanced() said the state is already where this call would take it. Nothing simulated. */
  | { status: 'already-advanced' }
  /** An earlier submission for the same (kind, key) is still unmined. */
  | { status: 'in-flight'; hash: Hash }
  /** The simulation succeeded but worthSending() refused its result: the call would change nothing. */
  | { status: 'no-op'; result: unknown }
  /**
   * `revertArgs`: the decoded arguments of the custom error, when the ABI knows it (`SourceNotPinned(source, reason)`).
   * `transportError`: the simulation got no answer (isTransportError); absent when the node executed and refused it.
   */
  | { status: 'simulation-reverted'; revert: string | null; error: string; revertArgs?: readonly unknown[]; transportError?: true }
  /** Signing or broadcasting failed; nothing is known to be in a mempool. */
  | { status: 'send-failed'; error: string }
  | { status: 'confirmed'; hash: Hash; nonce: number; blockNumber: bigint; gasUsed: bigint; result: unknown }
  | { status: 'reverted'; hash: Hash; nonce: number; blockNumber: bigint; gasUsed: bigint }
  /** Broadcast and recorded, but no receipt within the timeout. The next attempt's in-flight check resolves it. */
  | { status: 'unconfirmed'; hash: Hash; nonce: number; error: string };

export interface ExecuteOptions<TResult> {
  /** The step, e.g. `settle`. Journal column and log field. */
  kind: string;
  /** The transition's identity within the kind, e.g. the longId as a decimal string. */
  key: string;
  /** Read chain state; true = already advanced, skip. Errors propagate (the tick fails and retries). */
  isAdvanced?: () => Promise<boolean>;
  /** Judge the simulated return value; false = would change nothing, skip. */
  worthSending?: (result: TResult) => boolean;
}

export interface TxSenderOptions {
  chain: TxChain;
  store: V2Store;
  log: Logger;
  txTimeoutMs: number;
  /** How long an unmined submission blocks a resend of the same (kind, key). Default 10 minutes. */
  inFlightTtlMs?: number;
  /** Wall clock for the journal and the in-flight age only; never a protocol decision. */
  now?: () => number;
  /**
   * Called after every execute(), whatever its outcome: the mode's heartbeat. A tick of hundreds of receipt-awaited
   * sends is alive; without it /health would read it as wedged once the tick outlived KEEPER_TX_TIMEOUT_MS + 60 s.
   */
  onProgress?: () => void;
  /** CRANKER_GAS_SCALE_PCT (config.ts): every fixed gas limit is sent at this percent of itself (scaleGas). Default 100. */
  gasScalePct?: number;
}

export const DEFAULT_IN_FLIGHT_TTL_MS = 10 * 60_000;

/** CRANKER_GAS_SCALE_PCT's default and bounds (config.ts parses it with these; config.test.ts pins them equal). */
export const GAS_SCALE_PCT_DEFAULT = 100;
export const GAS_SCALE_PCT_MIN = 100;
export const GAS_SCALE_PCT_MAX = 300;
/**
 * The most a scaled limit may reach: 4663's per-transaction cap (cranker/steps.ts CHAIN_MAX_TX_GAS, 32,000,000) less the
 * 2,000,000 headroom the cranker already keeps under it (HOUSE_ROLL_GAS_HEADROOM). A send above the chain cap is not
 * included at all, so the scale may never take a limit there. Mirrored here so this module imports nothing from the
 * cranker; tx.test.ts pins it equal to those two constants.
 */
export const GAS_SCALE_CAP = 30_000_000n;

/**
 * The limit a fixed-gas call is
 * simulated and sent with: `gas` x `pct` / 100, rounded up, at most GAS_SCALE_CAP, and never below `gas` (a limit the
 * code already set above the cap, or a scale of 100, is left exactly as it is). Scaling UP only moves every call further
 * above the ceilings the contracts' starved-call guards test (StarvedCall.belowCeiling), so it cannot make a guarded
 * call re-throw that did not before. A tool for the operator when a contract has grown past a budget: raise the setting,
 * restart the service, and fix the budget in code after.
 */
export function scaleGas(gas: bigint, pct: number, cap: bigint = GAS_SCALE_CAP): bigint {
  if (pct === 100) return gas;
  const scaled = (gas * BigInt(pct) + 99n) / 100n;
  const capped = scaled < cap ? scaled : cap;
  return capped > gas ? capped : gas;
}

export class TxSender {
  readonly nonces = new NonceTracker();
  private readonly queue = new SerialQueue();
  private readonly chain: TxChain;
  private readonly store: V2Store;
  private readonly log: Logger;
  private readonly txTimeoutMs: number;
  private readonly inFlightTtlMs: number;
  private readonly now: () => number;
  private readonly onProgress: (() => void) | undefined;
  private readonly gasScalePct: number;

  constructor(options: TxSenderOptions) {
    this.chain = options.chain;
    this.store = options.store;
    this.log = options.log;
    this.txTimeoutMs = options.txTimeoutMs;
    this.inFlightTtlMs = options.inFlightTtlMs ?? DEFAULT_IN_FLIGHT_TTL_MS;
    this.now = options.now ?? Date.now;
    this.onProgress = options.onProgress;
    this.gasScalePct = options.gasScalePct ?? GAS_SCALE_PCT_DEFAULT;
  }

  get account(): Address {
    return this.chain.account;
  }

  /** Steps 1-7 of the header, serialised with every other execute() of this sender. */
  execute<const TAbi extends Abi, TName extends WriteFunctionName<TAbi>>(
    call: WriteCall<TAbi, TName>,
    options: ExecuteOptions<WriteResult<TAbi, TName>>,
  ): Promise<TxOutcome> {
    return this.queue.run(async () => {
      try {
        return await this.executeNow(call as unknown as WriteCall, options as ExecuteOptions<unknown>);
      } finally {
        this.onProgress?.();
      }
    });
  }

  private async executeNow(unscaled: WriteCall, options: ExecuteOptions<unknown>): Promise<TxOutcome> {
    // A fixed limit is simulated AND sent at CRANKER_GAS_SCALE_PCT of itself (scaleGas); an estimated call is left alone.
    const call = unscaled.gas === undefined ? unscaled : { ...unscaled, gas: scaleGas(unscaled.gas, this.gasScalePct) };
    const { kind, key } = options;
    const ctx = { kind, key, fn: call.functionName, to: call.address };

    const inFlight = await this.resolveInFlight(kind, key);
    if (inFlight !== null) {
      this.log.info({ ...ctx, hash: inFlight }, 'earlier submission still in flight; not sending again');
      return { status: 'in-flight', hash: inFlight };
    }

    if (options.isAdvanced !== undefined && (await options.isAdvanced())) {
      this.log.debug(ctx, 'already advanced; skipped');
      return { status: 'already-advanced' };
    }

    let simulated: { result: unknown; request: unknown };
    try {
      simulated = await this.chain.simulate(call);
    } catch (error) {
      const outcome = simulationReverted(error);
      this.log.info({ ...ctx, revert: outcome.revert, error: outcome.error.slice(0, 200) }, 'simulation reverted; not sent');
      return outcome;
    }
    if (options.worthSending !== undefined && !options.worthSending(simulated.result)) {
      this.log.debug({ ...ctx, result: simulated.result }, 'simulation says it would change nothing; not sent');
      return { status: 'no-op', result: simulated.result };
    }

    let nonce: number;
    let hash: Hash;
    try {
      nonce = await this.nonces.take(() => this.chain.pendingNonce());
      hash = await this.chain.broadcast(simulated.request, nonce);
    } catch (error) {
      this.nonces.reset();
      const message = describeError(error);
      this.log.error({ ...ctx, error: message }, 'send failed');
      return { status: 'send-failed', error: message };
    }
    this.nonces.used(nonce);
    // Recorded before the wait: see the header, step 6.
    this.store.recordTxSubmitted({ hash, kind, key, nonce, to: call.address, functionName: call.functionName }, this.now());
    this.log.info({ ...ctx, hash, nonce }, 'transaction submitted');

    try {
      const receipt = await this.chain.waitForReceipt(hash, this.txTimeoutMs);
      if (receipt.status === 'success') {
        this.store.recordTxResult(hash, 'success', receipt.blockNumber, receipt.gasUsed, null, this.now());
        this.log.info({ ...ctx, hash, block: receipt.blockNumber, gas: receipt.gasUsed }, 'transaction confirmed');
        return { status: 'confirmed', hash, nonce, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed, result: simulated.result };
      }
      this.store.recordTxResult(hash, 'reverted', receipt.blockNumber, receipt.gasUsed, 'receipt status: reverted', this.now());
      this.log.error({ ...ctx, hash, block: receipt.blockNumber }, 'transaction reverted on chain');
      return { status: 'reverted', hash, nonce, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed };
    } catch (error) {
      const message = describeError(error);
      this.nonces.reset();
      this.store.recordTxResult(hash, 'pending', null, null, message, this.now());
      this.log.warn({ ...ctx, hash, error: message }, 'submitted but not confirmed in time');
      return { status: 'unconfirmed', hash, nonce, error: message };
    }
  }

  /** Step 1: the hash still blocking (kind, key), or null once nothing does. */
  private async resolveInFlight(kind: string, key: string): Promise<Hash | null> {
    const previous = this.store.latestTx(kind, key);
    if (previous === null || previous.status !== 'pending') return null;
    const hash = previous.hash as Hash;
    const receipt = await this.chain.getReceipt(hash);
    if (receipt !== null) {
      this.store.recordTxResult(hash, receipt.status, receipt.blockNumber, receipt.gasUsed, receipt.status === 'reverted' ? 'receipt status: reverted' : null, this.now());
      return null;
    }
    const ageMs = this.now() - previous.created_at;
    // No receipt, and the account's mined nonce is past this one: another transaction used it, so this one can never
    // mine. Waiting out the TTL would block a time-critical resend (a snapshot has 600 s).
    if (previous.nonce !== null) {
      const mined = await this.chain.minedNonce();
      if (mined > previous.nonce) {
        this.store.recordTxResult(hash, 'dropped', null, null, `nonce ${previous.nonce} was used by another transaction (mined count ${mined}); never mined`, this.now());
        this.log.warn({ kind, key, hash, nonce: previous.nonce, mined }, 'earlier submission lost: its nonce was used by another transaction; marked dropped');
        return null;
      }
    }
    if (ageMs < this.inFlightTtlMs) return hash;
    this.store.recordTxResult(hash, 'dropped', null, null, `no receipt ${Math.round(ageMs / 1000)} s after submission`, this.now());
    this.log.warn({ kind, key, hash, ageMs }, 'earlier submission never mined; marked dropped');
    return null;
  }
}
