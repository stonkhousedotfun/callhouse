/**
 * The v8 flywheel step: claim the book's fees into the FeeSplitter, split what has arrived, and buy back.
 *
 * WHERE IT SITS. Last in STEP_ORDER, after `housekeeping`, because housekeeping's second half is what PUSHES
 * fees into the splitter (`sweepFees` per live asset, steps.ts). Running the same tick means this step splits
 * what that one just swept. The live cranker confirms each send before the next step, so the ordering holds.
 * A DRY RUN WILL UNDER-REPORT THIS STEP: `cranker/dryrun.ts:14-16` says the steps of one dry tick do not see
 * each other's effects, so the tick's `sweepFees` has not actually landed and the splitter's balances are
 * whatever they were before the tick.
 *
 * WHAT IT DELIBERATELY DOES NOT READ. `FeeSplitter.paused()` and `buybackCap()` exist on chain but are NOT in
 * the published ABI this keeper compiles against: `ops/abis/v2/IFeeSplitter.json` is the pre-T-75 export (14
 * functions, of which only `treasury`, `buybackBalance` and `lastBuybackAt` are views), and the generated
 * `abi/feeSplitter.ts` mirrors it. Rather than wait for that re-export, this step is built so it needs
 * neither:
 *   - PAUSE COMES FROM THE REVERT. `distribute` and `buyback` both `revert V2Errors.TradingPaused()` when the
 *     splitter is paused (FeeSplitter.sol:89, :146). `TradingPaused` is already in the merged error fragments,
 *     so `send()` reports `status: 'simulation-reverted'` with `revert: 'TradingPaused'`. That is the same
 *     read the chain itself makes, and it cannot go stale against a `paused()` view that says otherwise.
 *   - THE PER-CALL CAP NEEDS NO READ. `buyback` does not revert on the cap; it spends
 *     `usdgIn = reserve < buybackCap ? reserve : buybackCap` (FeeSplitter.sol:162). So a large balance simply
 *     drains over several intervals, and the simulated return says exactly what one call spends. No number
 *     from the contract's constructor is pinned here.
 * A hand-written ABI fragment for `paused()` would defeat the point of the generator, which states that the
 * keeper has no hand-written v2 ABIs (scripts/gen-abis.mjs:1-20).
 *
 * EVERY SKIP IS THE SPLITTER'S OWN. `distribute` returns 0 and emits `DistributionSkipped` for NO_ROUTE,
 * NO_SPOT, DUST and BELOW_FLOOR; `buyback` returns `(0, 0)` with `BuybackSkipped` for EMPTY and NO_EXECUTOR.
 * `worthSending` judging the SIMULATED return therefore turns every one of those into a `no-op` that sends
 * nothing, without this file reimplementing a single one of those conditions off chain.
 */
import { parseAbi, type Address } from 'viem';
import { feeSplitterAbi } from '../abi/feeSplitter.js';
import { orderBookAbi } from '../abi/orderBook.js';
import { v2Markets } from '../registry.js';
import { describeError, revertDetail } from '../tx.js';
import { BUYBACK_COOLDOWN, BPS, GAS } from './constants.js';
import type { CrankOutcome } from './effects.js';
import { okResult, readMany, type AnyRead } from './reads.js';
import { Budget, flywheelMetaKey, head, newReport, send, type CrankContext, type StepReport } from './steps.js';

/**
 * Declared here rather than imported from `mm/reads.ts`, which owns the MM bot's copy: the cranker does not
 * import from the mm lane, and `steps.ts:135` sets the precedent of a step file declaring the one-line ABI it
 * needs. It is the ERC-20 standard, not a v2 interface, so there is nothing for the generator to mirror.
 */
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);

/** The revert name `Managed` raises for a caller without the role (Managed.sol overrides it to V2Errors). */
const NOT_AUTHORIZED = 'NotAuthorized';
/** What `distribute` and `buyback` revert with when the guardian has paused the splitter. */
const TRADING_PAUSED = 'TradingPaused';

/** `simulation-reverted` with this decoded custom error, whatever else happened. */
function revertedWith(outcome: CrankOutcome, name: string): boolean {
  return outcome.status === 'simulation-reverted' && outcome.revert === name;
}

/**
 * Claim, distribute and buy back, at most once per `CRANKER_FLYWHEEL_INTERVAL_S`.
 *
 * `usdg` is passed in rather than read, exactly as `stepHousekeeping` takes it: the cranker memoises it once
 * per process (`cranker.ts`).
 */
export async function stepFlywheel(ctx: CrankContext, usdg: Address): Promise<StepReport> {
  const report = newReport('flywheel');
  const tuning = ctx.config.tuning;

  // GATE FIRST, and say which gate. ops/v2/env/cranker.env:26-27 already promises the operator that an empty
  // V2_FEE_SPLITTER makes the cranker run every other step and skip these; that comment shipped before this
  // code, and this is the code matching it.
  if (!tuning.flywheelEnabled) {
    report.notes = { skipped: 'disabled' };
    return report;
  }
  const splitter = ctx.addresses.feeSplitter;
  if (splitter === null) {
    report.notes = { skipped: 'no-splitter' };
    return report;
  }

  const budget = new Budget(tuning.maxTxPerStep, ctx.yieldWhen);
  const h = await head(ctx);
  const last = ctx.store.getMeta(flywheelMetaKey);
  const lastRanAt = last === null ? null : Number(last);
  if (lastRanAt !== null && h.timestamp < lastRanAt + tuning.flywheelIntervalS) {
    report.notes = { skipped: 'interval', nextAt: lastRanAt + tuning.flywheelIntervalS };
    report.wakeAt.push(lastRanAt + tuning.flywheelIntervalS);
    return report;
  }

  /** Set by the first TradingPaused: the guardian has paused the splitter, so stop asking. */
  let paused = false;
  const notes: Record<string, unknown> = {};

  /*//////////////////////////////////////////////////////////////
                      1. CLAIM THE BOOK'S FEES
  //////////////////////////////////////////////////////////////*/

  // claimOrderBookFees is never gated on `paused` (IFeeSplitter.sol:92-93): pulling the book's owed balance
  // into the splitter is safe while distribution is stopped, and a pause that also blocked the claim would
  // leave fees stranded on the book.
  try {
    const owed = await ctx.client.readContract({ address: ctx.addresses.orderBook, abi: orderBookAbi, functionName: 'owed', args: [splitter] });
    notes.owed = owed.toString();
    if (owed > 0n && budget.left) {
      // The contract returns 0 for a zero balance by itself (FeeSplitter.sol:76-85); the pre-read is only so a
      // tick with nothing owed sends nothing and logs nothing.
      await send(
        ctx,
        report,
        budget,
        `claimOrderBookFees (${owed})`,
        { address: splitter, abi: feeSplitterAbi, functionName: 'claimOrderBookFees', args: [], gas: GAS.claimOrderBookFees },
        { kind: 'claimOrderBookFees', key: splitter.toLowerCase(), worthSending: (claimed) => (claimed as bigint) > 0n },
      );
    }
  } catch (error) {
    notes.claimError = describeError(error);
  }

  /*//////////////////////////////////////////////////////////////
                           2. DISTRIBUTE
  //////////////////////////////////////////////////////////////*/

  // USDG first, so premium fees pulled in by the claim above are split in the same pass. `_pendingUsdg()` is
  // `balance - buybackBalance` (FeeSplitter.sol:248-251), so a zero return means nothing is unsplit.
  const assets: Address[] = [usdg, ...v2Markets(ctx.config.registry, ['live', 'paused']).map((m) => m.underlying)];
  // One multicall for every balance, as stepHousekeeping reads accruedFees for its own asset list.
  const balances = await readMany(
    ctx.client,
    assets.map((a): AnyRead => ({ address: a, abi: erc20Abi, functionName: 'balanceOf', args: [splitter] })),
    h.blockNumber,
  );

  const distributed: unknown[] = [];
  for (const [i, asset] of assets.entries()) {
    if (paused || !budget.left) break;
    // PER-ASSET ISOLATION. The step as a whole is already isolated by the tick loop; this is the finer grain,
    // so one market's read or send failure does not cost the others their distribution.
    try {
      const balance = okResult<bigint>(balances[i]) ?? 0n;
      // USDG is always worth asking about: its pending amount is a subtraction, not a balance, so a non-zero
      // splitter balance can be entirely buyback reserve and a zero one is impossible to confuse with it.
      if (asset !== usdg && balance === 0n) continue;
      const outcome = await send(
        ctx,
        report,
        budget,
        `distribute ${asset} (balance ${balance})`,
        { address: splitter, abi: feeSplitterAbi, functionName: 'distribute', args: [asset], gas: GAS.distribute },
        { kind: 'distribute', key: asset.toLowerCase(), worthSending: (usdgIn) => (usdgIn as bigint) > 0n },
      );
      if (revertedWith(outcome, TRADING_PAUSED)) paused = true;
      distributed.push({ asset, balance: balance.toString(), status: outcome.status });
    } catch (error) {
      distributed.push({ asset, error: describeError(error) });
    }
  }
  notes.distributed = distributed;

  /*//////////////////////////////////////////////////////////////
                            3. BUY BACK
  //////////////////////////////////////////////////////////////*/

  const buyback = await runBuyback(ctx, report, budget, splitter, h.timestamp, h.blockNumber, paused);
  Object.assign(notes, buyback.notes);
  if (buyback.wakeAt !== null) report.wakeAt.push(buyback.wakeAt);
  if (buyback.paused) paused = true;

  if (paused) {
    notes.paused = true;
    // once: false — a pause is a condition, and the operator should keep being told while it holds. The
    // monitor owns "buyback is stuck" (v2_mon_buyback_stuck, ops/alerts.md §V57); this says only that the
    // cranker was refused, which the monitor cannot see.
    await ctx.alerts.raise({
      kind: 'v2_error',
      dedupeKey: 'flywheel:paused',
      once: false,
      message: 'cranker flywheel: the FeeSplitter is paused; distribute and buyback were skipped',
      data: { splitter },
    });
  }

  if (!ctx.sender.dryRun) ctx.store.setMeta(flywheelMetaKey, String(h.timestamp));
  report.wakeAt.push(h.timestamp + tuning.flywheelIntervalS);
  report.notes = notes;
  return report;
}

/*//////////////////////////////////////////////////////////////
                        THE BUYBACK LEG
//////////////////////////////////////////////////////////////*/

interface BuybackResult {
  notes: Record<string, unknown>;
  /** A head timestamp this step has time-critical work at (the cooldown's end). */
  wakeAt: number | null;
  paused: boolean;
}

/**
 * At most one `buyback(minTokenOut)`.
 *
 * `minTokenOut` IS A FRESH QUOTE OF THE EXACT CALL, not a price. `FeeSplitter.buyback` forwards to
 * `IBuybackExecutor.execute(usdgIn, minTokenOut)`, where `minTokenOut == 0` reverts `BadPrice` and
 * `tokenOut < minTokenOut` reverts `TooLittleTokens` (V4BuybackExecutor.sol:403, :429). So the only honest
 * quote is a simulation of the same call: it returns `burned` through the real v3 pool, the real unwrap, the
 * real pinned v4 key and the real hook cut. The tolerance then covers drift between the probe and inclusion —
 * nothing more. `IBuybackExecutor`'s own NatSpec and ADR-15 §4 say a keeper-supplied minimum "is not an
 * independent price, only a bound on this fill"; the structural protections (the executor's raise-never-lower
 * v3 TWAP floor, the declared and measured fee caps) are on chain, and this must not try to second-guess them.
 *
 * THE PROBE ARGUMENT NEVER REACHES THE SENDER. The probe is an explicit `simulateContract` read; the send is a
 * separate `send()` with the tightened floor. A probe value that leaked into the send would be a buyback with
 * `minTokenOut = 1`, i.e. no slippage bound at all.
 */
async function runBuyback(
  ctx: CrankContext,
  report: StepReport,
  budget: Budget,
  splitter: Address,
  now: number,
  blockNumber: bigint,
  alreadyPaused: boolean,
): Promise<BuybackResult> {
  const notes: Record<string, unknown> = {};
  if (alreadyPaused) return { notes: { buyback: 'skipped: splitter paused' }, wakeAt: null, paused: true };
  if (!budget.left) return { notes: { buyback: 'skipped: tick budget spent' }, wakeAt: null, paused: false };

  let reserve: bigint | undefined;
  let reserveError: string | undefined;
  let lastBuybackAt: number;
  try {
    const reads = await readMany(
      ctx.client,
      [
        { address: splitter, abi: feeSplitterAbi, functionName: 'buybackBalance', args: [] },
        { address: splitter, abi: feeSplitterAbi, functionName: 'lastBuybackAt', args: [] },
      ],
      blockNumber,
    );
    // NOT `?? 0n`. multicallMany reads with allowFailure: true, so a reverted buybackBalance() (wrong
    // splitter address, nothing deployed there, ABI drift, a partial multicall) is a FAILED OUTCOME, not a
    // throw, and the catch below never sees it. Defaulting it to 0 recorded "skipped: empty reserve" for a
    // reserve nobody had read, so the buyback silently stopped while every signal said there was nothing to
    // buy. An unreadable reserve stays undefined and is reported as unreadable below.
    reserve = okResult<bigint>(reads[0]);
    if (reserve === undefined) {
      const failed = reads[0];
      reserveError = failed !== undefined && !failed.ok ? failed.error.message.split('\n')[0] : 'no result';
    }
    // lastBuybackAt is uint40 and viem widens it to a JS number-safe bigint; 0 means NEVER, not 1970
    // (ops/alerts.md:2066-2067). Arithmetic gives the right answer either way — 0 + 300 is long past — but it
    // is right by accident, so it is written down rather than relied on silently.
    lastBuybackAt = Number(okResult<bigint>(reads[1]) ?? 0n);
  } catch (error) {
    return { notes: { buybackError: describeError(error) }, wakeAt: null, paused: false };
  }

  notes.lastBuybackAt = lastBuybackAt;
  if (reserve === undefined) {
    // Not a throw: one unreadable view must not stop the rest of the tick (claim and distribute already ran,
    // and allowFailure: true is deliberate). Not a buy: a reserve we could not read cannot size one. So skip,
    // but say WHY in the note a human reads, and page, because unlike an empty reserve this does not fix
    // itself. once: false, the same as the pause: it is a condition and the operator keeps being told while it
    // holds.
    notes.buybackBalance = null;
    notes.buybackReadError = reserveError;
    await ctx.alerts.raise({
      kind: 'v2_error',
      dedupeKey: 'flywheel:buyback-reserve-unreadable',
      once: false,
      message: 'cranker flywheel: FeeSplitter.buybackBalance() could not be read; the buyback was skipped without knowing the reserve',
      data: { splitter, error: reserveError ?? null },
    });
    return { notes: { ...notes, buyback: 'skipped: reserve unreadable' }, wakeAt: null, paused: false };
  }
  notes.buybackBalance = reserve.toString();
  if (reserve === 0n) return { notes: { ...notes, buyback: 'skipped: empty reserve' }, wakeAt: null, paused: false };

  const readyAt = lastBuybackAt === 0 ? now : lastBuybackAt + BUYBACK_COOLDOWN;
  if (now < readyAt) {
    // Do not even probe: inside the window the probe can only answer CooldownActive, and a probe that always
    // reverts trains the operator to ignore the record it leaves.
    return { notes: { ...notes, buyback: 'skipped: cooldown', readyAt }, wakeAt: readyAt, paused: false };
  }

  /*---- the probe ----*/
  let burned: bigint;
  let usdgIn: bigint;
  try {
    const probe = await ctx.client.simulateContract({
      address: splitter,
      abi: feeSplitterAbi,
      functionName: 'buyback',
      // 1, never 0: 0 reverts BadPrice and would make every probe useless. This value is the probe's and the
      // probe's only — see the send below.
      args: [1n],
      account: ctx.sender.account,
      gas: GAS.buyback,
    });
    [usdgIn, burned] = probe.result as [bigint, bigint];
  } catch (error) {
    const detail = revertDetail(error);
    const name = detail === null ? null : detail.name;
    if (name === TRADING_PAUSED) return { notes: { ...notes, buyback: 'skipped: splitter paused' }, wakeAt: null, paused: true };
    if (name === NOT_AUTHORIZED) {
      // Under `Managed` an unauthorised call reverts V2Errors.NotAuthorized, which is byte-identical to
      // `distribute`'s treasury-unset refusal — so this is raised only from the BUYBACK probe, where the role
      // is the only thing it can mean for this caller.
      await ctx.alerts.raise({
        kind: 'v2_cranker_no_buyback_role',
        dedupeKey: `${splitter.toLowerCase()}:${ctx.sender.account.toLowerCase()}`,
        once: false,
        message: 'cranker flywheel: the cranker key does not hold BUYBACK on the FeeSplitter; no buyback can be sent',
        data: { splitter, signer: ctx.sender.account },
      });
      return { notes: { ...notes, buyback: 'refused: no BUYBACK role' }, wakeAt: null, paused: false };
    }
    if (name === 'CooldownActive') {
      // The chain disagreed with our arithmetic; log the readyAt it gave and wait, without paging.
      const readyFromChain = detail === null ? undefined : detail.args[0];
      return { notes: { ...notes, buyback: 'skipped: cooldown (chain)', readyAt: readyFromChain === undefined ? null : String(readyFromChain) }, wakeAt: null, paused: false };
    }
    report.actions.push({ what: 'buyback probe', kind: 'buyback', key: splitter.toLowerCase(), status: 'not-sent', revert: name, error: describeError(error).slice(0, 300) });
    return { notes: { ...notes, buyback: `probe reverted: ${name ?? 'unknown'}` }, wakeAt: null, paused: false };
  }

  notes.probe = { usdgIn: usdgIn.toString(), burned: burned.toString() };
  if (burned === 0n) return { notes: { ...notes, buyback: 'skipped: the route quotes nothing' }, wakeAt: null, paused: false };

  /*---- the floor ----*/
  const minTokenOut = (burned * (BPS - BigInt(ctx.config.tuning.buybackToleranceBps))) / BPS;
  notes.minTokenOut = minTokenOut.toString();
  if (minTokenOut === 0n) {
    // Only reachable on a dust quote, where the tolerance rounds the floor to zero. Sending it would be a
    // buyback with no slippage bound, which is exactly what BadPrice exists to refuse.
    return { notes: { ...notes, buyback: 'skipped: the tightened floor rounds to 0' }, wakeAt: null, paused: false };
  }
  if (ctx.config.tuning.buybackDryRun) {
    // NOT ctx.sender.dryRun, which is the whole process. This flag probes and reports while every other step
    // keeps running live — the way to watch the route for a few days before letting it spend.
    report.actions.push({ what: `buyback (dry) minTokenOut ${minTokenOut}`, kind: 'buyback', key: splitter.toLowerCase(), status: 'not-sent', result: { usdgIn: usdgIn.toString(), burned: burned.toString() } });
    return { notes: { ...notes, buyback: 'dry run: probed, not sent' }, wakeAt: null, paused: false };
  }

  const outcome = await send(
    ctx,
    report,
    budget,
    `buyback (minTokenOut ${minTokenOut})`,
    { address: splitter, abi: feeSplitterAbi, functionName: 'buyback', args: [minTokenOut], gas: GAS.buyback },
    { kind: 'buyback', key: splitter.toLowerCase(), worthSending: (r) => (r as [bigint, bigint])[0] > 0n },
  );
  if (revertedWith(outcome, TRADING_PAUSED)) return { notes: { ...notes, buyback: outcome.status }, wakeAt: null, paused: true };
  return { notes: { ...notes, buyback: outcome.status }, wakeAt: now + BUYBACK_COOLDOWN, paused: false };
}
