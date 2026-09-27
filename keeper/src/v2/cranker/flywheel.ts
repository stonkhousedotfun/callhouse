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
 * the published ABI this keeper compiles against: `ops/abis/v2/IFeeSplitter.json` is the earlier export (14
 * functions, of which only `treasury`, `buybackBalance` and `lastBuybackAt` are views), and the generated
 * `abi/feeSplitter.ts` mirrors it. Rather than wait for that re-export, this step is built so it needs
 * neither:
 *   - PAUSE COMES FROM THE REVERT. `distribute` and the buyback both `revert V2Errors.TradingPaused()` when the
 *     splitter is paused (FeeSplitter `_distribute` and `_buyback` each open with that check). `TradingPaused`
 *     is already in the merged error fragments, so `send()` reports `status: 'simulation-reverted'` with
 *     `revert: 'TradingPaused'`. That is the same read the chain itself makes, and it cannot go stale against a
 *     `paused()` view that says otherwise.
 *   - THE PER-CALL CAP NEEDS NO READ. The buyback does not revert on the cap; it spends
 *     `usdgIn = reserve < buybackCap ? reserve : buybackCap` (FeeSplitter `_buyback`). So a large balance simply
 *     drains over several intervals, and the simulated return says exactly what one call spends. No number
 *     from the contract's constructor is pinned here.
 * A hand-written ABI fragment for `paused()` would defeat the point of the generator, which states that the
 * keeper has no hand-written v2 ABIs (scripts/gen-abis.mjs:1-20).
 *
 * EVERY SKIP IS THE SPLITTER'S OWN. `distribute` returns 0 and emits `DistributionSkipped` for NO_ROUTE,
 * NO_SPOT, DUST and BELOW_FLOOR; `buybackWithDeadline` returns `(0, 0)` with `BuybackSkipped` for EMPTY and
 * NO_EXECUTOR.
 *
 * ONE SKIP IS SENT ANYWAY: THE WRITE-DOWN. `buybackBalance` is a counter; USDG can leave the
 * splitter without a buyback (an issuer burn or seizure). Since `_buyback` lowers the counter to the USDG
 * it really holds, emits `BuybackBalanceWrittenDown`, and only then decides to buy or skip. A skip returns `(0, 0)`,
 * so a step that sends only what the probe says will burn never sends it, the counter never comes down on chain, and
 * every interval re-probes the same hole forever (what SHORT_RESERVE used to do). So when the probe burns
 * nothing AND the splitter holds less USDG than the counter, the step sends `buybackWithDeadline` once, with
 * `minTokenOut = 2^256 - 1`: a skip never reaches the executor and lands the write-down; a buy (the state moved
 * between probe and send) reverts `TooLittleTokens` in the executor and moves nothing. It can write down, never buy.
 *
 * AND ONE DISTRIBUTE IS SENT ANYWAY, FIRST. That write-down waits for the cooldown: a buyback sent inside it
 * reverts CooldownActive, and the revert undoes the write-down with it. Since `distribute` writes the counter down too, before it
 * measures anything (FeeSplitter `_distribute` -> `_writeDownReserve`). With the counter above the balance `_pendingUsdg()`
 * is 0 and `distribute(usdg)` returns 0 whether or not it writes down, so the zero-return rule would never send it, and
 * every USDG that arrives meanwhile (this step's own claim first) refills the counted hole instead of paying the treasury
 * its share. So when the splitter holds less USDG than `buybackBalance`, `distribute(usdg)` is sent once, whatever it
 * returns, BEFORE the claim. See `writeDownFirst`.
 *
 * THE BUYBACK ENTRY POINT IS `buybackWithDeadline`. From the v9 FeeSplitter the frozen
 * `buyback(uint256)` ALWAYS reverts `BuybackDeadlineRequired` and leaves no event, so a cranker
 * still sending it looks exactly like a stopped one. This step never calls it, not even as a fallback: a fallback
 * would either revert every time or, against an older splitter, buy with no deadline, which the deadline fix removed.
 * `worthSending` judging the SIMULATED return therefore turns every one of those into a `no-op` that sends
 * nothing, without this file reimplementing a single one of those conditions off chain.
 *
 * A STOCK FEE THE WHOLE OF WHICH MISSES THE FLOOR IS OFFERED IN PIECES. `distribute(asset)` always sells
 * the splitter's whole balance, so a balance larger than the route can fill within the floor skipped BELOW_FLOOR on
 * every pass, for good. `distributeAmount(asset, assetIn)` sells a piece under the same floor, computed on the piece
 * (FeeSplitter `_distribute`, `requested`). The skip reason is only in the `DistributionSkipped` event, which a
 * simulation does not return and a no-op never broadcasts, so it is not read: of the splitter's skips only BELOW_FLOOR
 * can clear with a smaller piece (NO_ROUTE, NO_SPOT and HAIRCUT do not depend on the amount, and a piece of a DUST
 * balance is DUST too), so a smaller piece that sells is the proof. For any other reason the search finds nothing
 * and costs a handful of simulations. See `distributeInPieces` for the search and its bounds.
 */
import { parseAbi, type Address } from 'viem';
import { feeSplitterAbi } from '../abi/feeSplitter.js';
import { orderBookAbi } from '../abi/orderBook.js';
import { v2Markets } from '../registry.js';
import { describeError, revertDetail } from '../tx.js';
import { BUYBACK_DEADLINE_S, BPS, FLYWHEEL_MAX_PIECES, FLYWHEEL_MIN_PIECE_USDG, FLYWHEEL_PIECE_PROBES, FLYWHEEL_PIECE_STRIDE, GAS } from './constants.js';
import type { CrankOutcome } from './effects.js';
import { okResult, readMany, type AnyRead } from './reads.js';
import { Budget, flywheelMetaKey, head, newReport, send, type CrankContext, type StepReport } from './steps.js';

/**
 * Declared here rather than imported from `mm/reads.ts`, which owns the MM bot's copy: the cranker does not
 * import from the mm module, and `steps.ts:135` sets the precedent of a step file declaring the one-line ABI it
 * needs. It is the ERC-20 standard, not a v2 interface, so there is nothing for the generator to mirror.
 */
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);

/** The revert name `Managed` raises for a caller without the role (Managed.sol overrides it to V2Errors). */
const NOT_AUTHORIZED = 'NotAuthorized';
/** What `distribute` and `buybackWithDeadline` revert with when the guardian has paused the splitter. */
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

  // GATE FIRST, and say which gate. ops/v2/env/cranker.env ("The distribute and buyback steps. With V2_FEE_SPLITTER
  // empty ...") already promises the operator that an empty V2_FEE_SPLITTER makes the cranker run every other step
  // and skip these; that comment shipped before this code, and this is the code matching it.
  if (!tuning.flywheelEnabled) {
    report.notes = { skipped: 'disabled' };
    // Off WITH a splitter configured is not "before the flywheel is deployed": it is launch-day fees that
    // are never claimed, distributed or bought back with. That used to be this same silent skip; it pages now.
    // ops/v2-env.mjs renders CRANKER_FLYWHEEL_ENABLED=1 whenever the registry records the splitter, so this fires
    // on a service whose variables were not re-set from the rendered file, or where somebody turned it off.
    if (ctx.addresses.feeSplitter !== null) {
      await ctx.alerts.raise({
        kind: 'v2_cranker_flywheel_disabled',
        dedupeKey: ctx.addresses.feeSplitter.toLowerCase(),
        once: false,
        message: 'cranker flywheel: CRANKER_FLYWHEEL_ENABLED is off but V2_FEE_SPLITTER is set; no fee claim, distribute or buyback is sent',
        data: { splitter: ctx.addresses.feeSplitter },
      });
    }
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
              0. A STALE BUYBACK COUNTER COMES DOWN FIRST
  //////////////////////////////////////////////////////////////*/

  const early = await writeDownFirst(ctx, report, budget, splitter, usdg, h.blockNumber);
  if (early.note !== null) notes.writeDown = early.note;
  if (early.paused) paused = true;

  /*//////////////////////////////////////////////////////////////
                      1. CLAIM THE BOOK'S FEES
  //////////////////////////////////////////////////////////////*/

  // claimOrderBookFees is never gated on `paused` (FeeSplitter `claimOrderBookFees` has no pause check): pulling
  // the book's owed balance into the splitter is safe while distribution is stopped, and a pause that also
  // blocked the claim would leave fees stranded on the book.
  try {
    const owed = await ctx.client.readContract({ address: ctx.addresses.orderBook, abi: orderBookAbi, functionName: 'owed', args: [splitter] });
    notes.owed = owed.toString();
    if (owed > 0n && budget.left) {
      // The contract returns 0 for a zero balance by itself (FeeSplitter `claimOrderBookFees`, `owed == 0`);
      // the pre-read is only so a tick with nothing owed sends nothing and logs nothing.
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
  // `balance - buybackBalance` (FeeSplitter `_pendingUsdg`), so a zero return means nothing is unsplit.
  const assets: Address[] = [usdg, ...v2Markets(ctx.config.registry, ['live', 'paused']).map((m) => m.underlying)];
  // One multicall for every balance, as stepHousekeeping reads accruedFees for its own asset list.
  const balances = await readMany(
    ctx.client,
    assets.map((a): AnyRead => ({ address: a, abi: erc20Abi, functionName: 'balanceOf', args: [splitter] })),
    h.blockNumber,
  );

  const distributed: Array<Record<string, unknown>> = [];
  /** Stock Tokens whose whole balance the splitter declined (a zero return), offered in pieces below. */
  const declined: Array<{ asset: Address; balance: bigint; entry: Record<string, unknown> }> = [];
  for (const [i, asset] of assets.entries()) {
    if (paused || !budget.left) break;
    // PER-ASSET ISOLATION. The step as a whole is already isolated by the tick loop; this is the finer grain,
    // so one market's read or send failure does not cost the others their distribution.
    try {
      // NOT `?? 0n`: an unread balance is not an empty one. A Stock Token whose balance could not be read is
      // not distributed this tick and the notes say so; USDG is asked either way (below), with its balance shown unread.
      const read = balances[i];
      const balance = okResult<bigint>(read);
      const balanceReadError = balance !== undefined ? undefined : read !== undefined && !read.ok ? read.error.message.split('\n')[0] : 'no result';
      if (asset !== usdg && balance === undefined) {
        distributed.push({ asset, balance: null, balanceReadError, status: 'not-sent' });
        continue;
      }
      // USDG is always worth asking about: its pending amount is a subtraction, not a balance, so a non-zero
      // splitter balance can be entirely buyback reserve and a zero one is impossible to confuse with it.
      if (asset !== usdg && balance === 0n) continue;
      const outcome = await send(
        ctx,
        report,
        budget,
        `distribute ${asset} (balance ${balance ?? 'unread'})`,
        { address: splitter, abi: feeSplitterAbi, functionName: 'distribute', args: [asset], gas: GAS.distribute },
        { kind: 'distribute', key: asset.toLowerCase(), worthSending: (usdgIn) => (usdgIn as bigint) > 0n },
      );
      if (revertedWith(outcome, TRADING_PAUSED)) paused = true;
      const entry: Record<string, unknown> = { asset, balance: balance === undefined ? null : balance.toString(), ...(balanceReadError === undefined ? {} : { balanceReadError }), status: outcome.status };
      distributed.push(entry);
      // Only a simulated 0: a revert (paused, treasury unset) is not a floor a smaller piece can clear. Never USDG,
      // which `distributeAmount` refuses (UnsupportedAsset) because it has no conversion to split up.
      if (asset !== usdg && balance !== undefined && outcome.status === 'no-op' && outcome.result === 0n) declined.push({ asset, balance, entry });
    } catch (error) {
      distributed.push({ asset, error: describeError(error) });
    }
  }

  // AFTER every whole-balance distribute, so a piece never takes a send an asset's own distribute would have used.
  for (const d of declined) {
    if (paused) break;
    try {
      const pieces = await distributeInPieces(ctx, report, budget, splitter, d.asset, d.balance);
      d.entry.pieces = pieces.notes;
      if (pieces.paused) paused = true;
    } catch (error) {
      d.entry.pieces = { error: describeError(error) };
    }
  }
  notes.distributed = distributed;

  /*//////////////////////////////////////////////////////////////
                            3. BUY BACK
  //////////////////////////////////////////////////////////////*/

  // Read at the block the write-down landed in, when one did: at the step's head the counter is the stale one this pass
  // already brought down, and the write-down would be sent a second time for a hole that is closed.
  const buyback = await runBuyback(ctx, report, budget, splitter, usdg, h.timestamp, early.landedAt ?? h.blockNumber, paused);
  Object.assign(notes, buyback.notes);
  if (buyback.wakeAt !== null) report.wakeAt.push(buyback.wakeAt);
  if (buyback.paused) paused = true;

  if (paused) {
    notes.paused = true;
    // once: false — a pause is a condition, and the operator should keep being told while it holds. The
    // monitor owns "buyback is stuck" (v2_mon_buyback_stuck); this says only that the
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
               THE DISTRIBUTE WRITE-DOWN
//////////////////////////////////////////////////////////////*/

interface WriteDownFirstResult {
  /** For the step's notes; null when no write-down is due, so a pass with nothing to correct reads as it always did. */
  note: Record<string, unknown> | null;
  paused: boolean;
  /** The block the write-down confirmed in; null when none did (nothing due, a dry run, a revert, a send that failed). */
  landedAt: bigint | null;
}

/**
 * `distribute(usdg)`, sent whatever it simulates to, when the splitter holds less USDG than `buybackBalance` at the step's
 * head block (see the file header). At most once per pass, before the claim, at GAS.distribute.
 *
 * NOTHING IS SENT when the splitter holds at least the counter, when either read fails (a hole nobody measured is not
 * acted on, as decided for its own write-down), or when the tick's budget is spent.
 *
 * SENT UNDER CRANKER_BUYBACK_DRY_RUN TOO. That flag withholds buyback calls; this is a distribute, which spends nothing
 * and which the flag already leaves live for every other asset.
 *
 * AGAINST A SPLITTER WITHOUT THE DISTRIBUTE WRITE-DOWN the call returns 0 and changes nothing, so the counter stays up and this is sent
 * again each interval until the buyback write-down lands. The note carries both reads, so that shows.
 */
async function writeDownFirst(ctx: CrankContext, report: StepReport, budget: Budget, splitter: Address, usdg: Address, blockNumber: bigint): Promise<WriteDownFirstResult> {
  let reserve: bigint | undefined;
  let held: bigint | undefined;
  try {
    const reads = await readMany(
      ctx.client,
      [
        { address: splitter, abi: feeSplitterAbi, functionName: 'buybackBalance', args: [] },
        { address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [splitter] },
      ],
      blockNumber,
    );
    reserve = okResult<bigint>(reads[0]);
    held = okResult<bigint>(reads[1]);
  } catch (error) {
    return { note: { sent: false, readError: describeError(error) }, paused: false, landedAt: null };
  }
  // NOT `?? 0n` for either: an unreadable balance read as 0 would be a hole under every non-zero counter, and an
  // unreadable counter read as 0 would hide one. The buyback leg reads both again and reports why it could not.
  if (reserve === undefined || held === undefined) {
    return { note: { sent: false, unreadable: reserve === undefined ? 'buybackBalance' : 'USDG balanceOf' }, paused: false, landedAt: null };
  }
  if (held >= reserve) return { note: null, paused: false, landedAt: null };

  const note: Record<string, unknown> = { buybackBalance: reserve.toString(), usdgHeld: held.toString() };
  if (!budget.left) return { note: { ...note, sent: false, why: 'tick budget spent' }, paused: false, landedAt: null };
  let outcome: CrankOutcome;
  try {
    outcome = await send(
      ctx,
      report,
      budget,
      `distribute ${usdg} write-down (buybackBalance ${reserve} > USDG held ${held})`,
      { address: splitter, abi: feeSplitterAbi, functionName: 'distribute', args: [usdg], gas: GAS.distribute },
      // No worthSending: the return is 0 whether or not the counter comes down, so it cannot judge this call.
      { kind: 'distribute', key: `${usdg.toLowerCase()}:write-down` },
    );
  } catch (error) {
    return { note: { ...note, sent: false, error: describeError(error) }, paused: false, landedAt: null };
  }
  return {
    note: { ...note, status: outcome.status },
    paused: revertedWith(outcome, TRADING_PAUSED),
    landedAt: outcome.status === 'confirmed' ? outcome.blockNumber : null,
  };
}

/*//////////////////////////////////////////////////////////////
                     THE PIECES
//////////////////////////////////////////////////////////////*/

/** A send is left beyond the one kept for the buyback, which runs after the pieces. */
function spareSend(budget: Budget): boolean {
  return budget.left && budget.max - budget.used > 1;
}

interface PiecesResult {
  notes: Record<string, unknown>;
  paused: boolean;
}

/** One simulated `distributeAmount`: the USDG it would split (0 when the splitter skips), or the revert that refused it. */
type Probe = { usdgIn: bigint } | { revert: string | null; error: string };

async function probePiece(ctx: CrankContext, splitter: Address, asset: Address, piece: bigint): Promise<Probe> {
  try {
    const { result } = await ctx.client.simulateContract({
      address: splitter,
      abi: feeSplitterAbi,
      functionName: 'distributeAmount',
      args: [asset, piece],
      account: ctx.sender.account,
      gas: GAS.distribute,
    });
    return { usdgIn: result as bigint };
  } catch (error) {
    const detail = revertDetail(error);
    return { revert: detail === null ? null : detail.name, error: describeError(error) };
  }
}

/**
 * `distributeAmount(asset, piece)` for a Stock Token whose whole `balance` the splitter just declined. Two parts:
 *
 * THE SEARCH, simulations only. Every candidate is a power-of-two fraction of the balance, `balance >> k`. Down from
 * half the balance, FLYWHEEL_PIECE_STRIDE halvings at a time, to the first piece the splitter fills at all (a return
 * above 0); then a bisection between that and the last refused size, to the LARGEST piece it fills. Along that line the
 * splitter's answer has one shape: 0 for a piece too big for the route (BELOW_FLOOR), then a sale, then 0 again once
 * the piece is DUST. The stride is far narrower than the band of pieces that sell (FLYWHEEL_PIECE_STRIDE), so the walk
 * down lands in it rather than stepping over it, and every size between the last refusal and the first sale is too big
 * or sells, which is what the bisection needs. If no size sells, the skip does not depend on the size (NO_SPOT,
 * NO_ROUTE, HAIRCUT) and nothing is learned or sent. No state is carried from one pass to the next, so a pass whose
 * spot was stale leaves nothing behind for the next one to trip on.
 *
 * THE SALE. That largest piece, sent at most FLYWHEEL_MAX_PIECES times while its simulation still returns at least
 * FLYWHEEL_MIN_PIECE_USDG (the last one clamped to what is left). A largest piece worth less than that is not sent.
 *
 * THE FLOOR IS THE SPLITTER'S, ON EVERY PIECE. The keeper passes an amount and nothing else: the splitter prices the
 * piece at its own oracle spot less its own haircut and refuses a fill under that (FeeSplitter `_distribute`). A
 * smaller piece is not a lower floor; it is a sale the route can fill at that floor.
 *
 * BOUNDED. At most FLYWHEEL_PIECE_PROBES simulations and FLYWHEEL_MAX_PIECES sends (each at GAS.distribute:
 * `distributeAmount` runs `distribute`'s body on the piece), never a send after a simulation under the minimum, and
 * never the step's last send, which stays for the buyback. The simulations are not report actions (one refused probe
 * is), so a stale-spot hour adds one log line per asset, not one per simulation.
 *
 * WHAT IS REPORTED IS WHAT THE CHAIN SAYS. A confirmed piece carries its simulation's return, and a pool that moved
 * before inclusion makes the splitter skip BELOW_FLOOR inside a successful transaction (FeeSplitter `_distribute`'s
 * catch). So `remaining` is the splitter's balance read at the last confirmed piece's block, and `sold` is how far the
 * balance fell; `sent` and `simulatedUsdgIn` are what the keeper sent and what the simulations said it would fetch.
 */
async function distributeInPieces(ctx: CrankContext, report: StepReport, budget: Budget, splitter: Address, asset: Address, balance: bigint): Promise<PiecesResult> {
  const probes: Array<Record<string, string>> = [];
  const each: Array<Record<string, string>> = [];
  let stop: string | null = null;
  let paused = false;

  /** The splitter's answer for `balance >> k`, or null when it reverted (and `stop` says so). */
  const ask = async (k: number): Promise<bigint | null> => {
    const piece = balance >> BigInt(k);
    const answer = await probePiece(ctx, splitter, asset, piece);
    if ('usdgIn' in answer) {
      probes.push({ assetIn: piece.toString(), usdgIn: answer.usdgIn.toString() });
      return answer.usdgIn;
    }
    probes.push({ assetIn: piece.toString(), revert: answer.revert ?? 'unknown' });
    report.actions.push({ what: `distributeAmount probe ${asset} (piece ${piece})`, kind: 'distributeAmount', key: asset.toLowerCase(), status: 'not-sent', revert: answer.revert, error: answer.error.slice(0, 300) });
    if (answer.revert === TRADING_PAUSED) paused = true;
    stop = `probe reverted: ${answer.revert ?? 'unknown'}`;
    return null;
  };

  // `refused` is a halving known to be too big: 0, the whole balance, is what `distribute` just declined.
  let refused = 0;
  let fills: number | null = null;
  let fillsUsdg = 0n;
  if (!spareSend(budget)) stop = 'tick budget spent';
  for (let k = 1; stop === null && fills === null; k += FLYWHEEL_PIECE_STRIDE) {
    if (probes.length >= FLYWHEEL_PIECE_PROBES) stop = 'probes spent';
    else if (balance >> BigInt(k) === 0n) stop = 'no size sells';
    else {
      const usdgIn = await ask(k);
      if (usdgIn === null) break;
      if (usdgIn > 0n) [fills, fillsUsdg] = [k, usdgIn];
      else refused = k;
    }
  }
  while (stop === null && fills !== null && fills - refused > 1 && probes.length < FLYWHEEL_PIECE_PROBES) {
    const mid = (refused + fills) >> 1;
    const usdgIn = await ask(mid);
    if (usdgIn === null) break;
    if (usdgIn > 0n) [fills, fillsUsdg] = [mid, usdgIn];
    else refused = mid;
  }
  if (stop === null && fills !== null && fillsUsdg < FLYWHEEL_MIN_PIECE_USDG) stop = 'under the piece floor';

  let unsent = balance;
  let sent = 0n;
  let simulatedUsdgIn = 0n;
  let lastBlock: bigint | null = null;
  if (stop === null && fills !== null) {
    const size = balance >> BigInt(fills);
    for (let n = 0; n < FLYWHEEL_MAX_PIECES && stop === null; n++) {
      if (unsent === 0n) break;
      if (!spareSend(budget)) {
        stop = 'tick budget spent';
        break;
      }
      const piece = size < unsent ? size : unsent;
      let outcome: CrankOutcome;
      try {
        outcome = await send(
          ctx,
          report,
          budget,
          `distributeAmount ${asset} (piece ${piece} of ${unsent})`,
          { address: splitter, abi: feeSplitterAbi, functionName: 'distributeAmount', args: [asset, piece], gas: GAS.distribute },
          { kind: 'distributeAmount', key: asset.toLowerCase(), worthSending: (usdgIn) => (usdgIn as bigint) >= FLYWHEEL_MIN_PIECE_USDG },
        );
      } catch (error) {
        // Kept inside the loop so the pieces that already went out stay on the record.
        each.push({ assetIn: piece.toString(), error: describeError(error) });
        stop = 'error';
        break;
      }
      const usdgIn = outcome.status === 'confirmed' || outcome.status === 'no-op' || outcome.status === 'would-send' ? (outcome.result as bigint) : null;
      each.push({ assetIn: piece.toString(), status: outcome.status, ...(usdgIn === null ? {} : { usdgIn: usdgIn.toString() }) });
      if (outcome.status === 'confirmed') {
        sent += piece;
        simulatedUsdgIn += usdgIn ?? 0n;
        unsent -= piece;
        lastBlock = outcome.blockNumber;
        continue;
      }
      if (revertedWith(outcome, TRADING_PAUSED)) paused = true;
      // The pool the last piece moved no longer fills this size (0), the remainder is under the minimum, a dry run's
      // would-send (its next simulation would not see this sale), a revert, or a send that did not confirm. The next
      // pass searches again from the balance it finds.
      stop = outcome.status === 'no-op' ? (usdgIn === 0n ? 'the size stopped filling' : 'under the piece floor') : outcome.status;
    }
    stop ??= unsent === 0n ? 'all sent' : 'pieces spent';
  }
  stop ??= 'no size sells';

  let remaining: bigint | null = balance;
  let remainingError: string | undefined;
  if (lastBlock !== null) {
    try {
      remaining = await ctx.client.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [splitter], blockNumber: lastBlock });
    } catch (error) {
      remaining = null;
      remainingError = describeError(error);
    }
  }
  // An inflow during the pass makes this an underestimate, never an overstatement.
  const sold = remaining === null ? null : remaining < balance ? balance - remaining : 0n;
  const notes: Record<string, unknown> = {
    sold: sold === null ? null : sold.toString(),
    remaining: remaining === null ? null : remaining.toString(),
    ...(remainingError === undefined ? {} : { remainingError }),
    sent: sent.toString(),
    simulatedUsdgIn: simulatedUsdgIn.toString(),
    stop,
    probes,
    each,
  };
  const fields = { step: 'flywheel', asset, sold, remaining, sent, simulatedUsdgIn, stop, probes: probes.length, pieces: each.length };
  if (sent > 0n && sold === 0n) {
    ctx.log.warn(fields, 'flywheel: stock-fee pieces confirmed but the splitter balance did not fall (the pool moved before inclusion?)');
  } else {
    ctx.log.info(fields, sent > 0n ? 'flywheel: sold a stock fee in pieces after its whole balance missed the splitter floor' : 'flywheel: no piece of a declined stock fee was sent');
  }
  return { notes, paused };
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
 * At most one `buybackWithDeadline(minTokenOut, deadline)`. Never `buyback(uint256)`: see the file header.
 *
 * `minTokenOut` IS A FRESH QUOTE OF THE EXACT CALL, not a price. `FeeSplitter.buybackWithDeadline` forwards to
 * `IBuybackExecutor.execute(usdgIn, minTokenOut)`, where `minTokenOut == 0` reverts `BadPrice` and
 * `tokenOut < minTokenOut` reverts `TooLittleTokens` (both in V4BuybackExecutor `execute`). So the only honest
 * quote is a simulation of the same call: it returns `burned` through the real v3 pool, the real unwrap, the
 * real pinned v4 key and the real hook cut. The tolerance then covers drift between the probe and inclusion —
 * nothing more. `IBuybackExecutor`'s own NatSpec says a keeper-supplied minimum "is not an
 * independent price, only a bound on this fill"; the structural protections (the executor's raise-never-lower
 * v3 TWAP floor, the declared and measured fee caps) are on chain, and this must not try to second-guess them.
 *
 * THE PROBE ARGUMENT NEVER REACHES THE SENDER. The probe is an explicit `simulateContract` read; the send is a
 * separate `send()` with the tightened floor. A probe value that leaked into the send would be a buyback with
 * `minTokenOut = 1`, i.e. no slippage bound at all.
 *
 * `deadline` IS THE HEAD TIMESTAMP READ JUST BEFORE THE PROBE, PLUS BUYBACK_DEADLINE_S. Not the step's `now`: claim
 * and distribute confirm before this runs, so that head can be minutes old and a deadline built on it would be
 * shorter than it says, or already past. The probe and the send carry the SAME deadline, so what was quoted is
 * exactly what may execute, and nothing later. A send that misses it reverts `DeadlinePassed` before any USDG
 * moves; `send()` records that revert on the action and the next pass re-quotes. It is never caught and hidden.
 */
async function runBuyback(
  ctx: CrankContext,
  report: StepReport,
  budget: Budget,
  splitter: Address,
  usdg: Address,
  now: number,
  blockNumber: bigint,
  alreadyPaused: boolean,
): Promise<BuybackResult> {
  const notes: Record<string, unknown> = {};
  if (alreadyPaused) return { notes: { buyback: 'skipped: splitter paused' }, wakeAt: null, paused: true };
  if (!budget.left) return { notes: { buyback: 'skipped: tick budget spent' }, wakeAt: null, paused: false };

  let reserve: bigint | undefined;
  let reserveError: string | undefined;
  /** Undefined when the read fails: unknown, never 0 ("never bought"). */
  let lastBuybackAt: number | undefined;
  // The least time between two buybacks is ADMIN-settable (setBuybackCooldown), so it is read at the
  // same block, never copied. Undefined when the read fails: then the step does not hold the probe back (the chain still
  // refuses CooldownActive inside the window) and says so in its notes.
  let cooldown: number | undefined;
  // The USDG the splitter really holds, read at the same block as the counter. Undefined when the read
  // fails: then no write-down is sent (the step cannot tell a hole from a quiet reserve) and the note says so.
  let held: bigint | undefined;
  try {
    const reads = await readMany(
      ctx.client,
      [
        { address: splitter, abi: feeSplitterAbi, functionName: 'buybackBalance', args: [] },
        { address: splitter, abi: feeSplitterAbi, functionName: 'lastBuybackAt', args: [] },
        { address: splitter, abi: feeSplitterAbi, functionName: 'buybackCooldown', args: [] },
        { address: usdg, abi: erc20Abi, functionName: 'balanceOf', args: [splitter] },
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
    // Arithmetic gives the right answer either way — 0 + 300 is long past — but it
    // is right by accident, so it is written down rather than relied on silently.
    // NOT `?? 0n`. An unread lastBuybackAt is unknown, not NEVER: it is shown as null with its error, and,
    // exactly like an unread cooldown, the probe is not held back on it; the chain refuses CooldownActive inside the
    // window, so no buyback is sent on the guess.
    const lastRead = okResult<bigint | number>(reads[1]);
    lastBuybackAt = lastRead === undefined ? undefined : Number(lastRead);
    if (lastBuybackAt === undefined) {
      const failed = reads[1];
      notes.lastBuybackAtReadError = failed !== undefined && !failed.ok ? failed.error.message.split('\n')[0] : 'no result';
    }
    const cooldownRead = okResult<bigint | number>(reads[2]);
    cooldown = cooldownRead === undefined ? undefined : Number(cooldownRead);
    if (cooldown === undefined) {
      const failed = reads[2];
      notes.buybackCooldownReadError = failed !== undefined && !failed.ok ? failed.error.message.split('\n')[0] : 'no result';
    }
    held = okResult<bigint>(reads[3]);
    if (held === undefined) {
      const failed = reads[3];
      notes.usdgHeldReadError = failed !== undefined && !failed.ok ? failed.error.message.split('\n')[0] : 'no result';
    }
  } catch (error) {
    return { notes: { buybackError: describeError(error) }, wakeAt: null, paused: false };
  }

  notes.lastBuybackAt = lastBuybackAt ?? null;
  notes.buybackCooldown = cooldown ?? null;
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

  const readyAt = lastBuybackAt === undefined || lastBuybackAt === 0 || cooldown === undefined ? now : lastBuybackAt + cooldown;
  if (now < readyAt) {
    // Do not even probe: inside the window the probe can only answer CooldownActive, and a probe that always
    // reverts trains the operator to ignore the record it leaves.
    return { notes: { ...notes, buyback: 'skipped: cooldown', readyAt }, wakeAt: readyAt, paused: false };
  }

  /*---- the deadline ----*/
  let deadline: bigint;
  try {
    deadline = BigInt((await head(ctx)).timestamp + BUYBACK_DEADLINE_S);
  } catch (error) {
    return { notes: { ...notes, buybackError: describeError(error) }, wakeAt: null, paused: false };
  }
  notes.deadline = deadline.toString();

  /*---- the probe ----*/
  let burned: bigint;
  let usdgIn: bigint;
  try {
    const probe = await ctx.client.simulateContract({
      address: splitter,
      abi: feeSplitterAbi,
      functionName: 'buybackWithDeadline',
      // minTokenOut 1, never 0: 0 reverts BadPrice and would make every probe useless. This value is the probe's
      // and the probe's only — see the send below. The deadline is the send's own.
      args: [1n, deadline],
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
  notes.usdgHeld = held === undefined ? null : held.toString();
  if (burned === 0n) {
    if (held !== undefined && held < reserve) return writeDown(ctx, report, budget, splitter, deadline, reserve, held, notes);
    return { notes: { ...notes, buyback: 'skipped: the route quotes nothing' }, wakeAt: null, paused: false };
  }

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
    // Reaching here means a buyback the route would take was withheld, so the switch is costing something
    // right now. It used to be a report note and nothing else: a dry run left on after the watch would keep the
    // reserve growing, with no burn, for as long as nobody read /state. It pages (warn) each time a buyback is
    // withheld; the alerter's cooldown spaces the pages. An empty reserve or a cooldown never reaches this line.
    await ctx.alerts.raise({
      kind: 'v2_cranker_buyback_dry_run',
      dedupeKey: splitter.toLowerCase(),
      once: false,
      message: `cranker flywheel: CRANKER_BUYBACK_DRY_RUN is on; a buyback of ${usdgIn} USDG base units was probed and not sent`,
      data: { splitter, usdgIn: usdgIn.toString(), burned: burned.toString(), minTokenOut: minTokenOut.toString() },
    });
    return { notes: { ...notes, buyback: 'dry run: probed, not sent' }, wakeAt: null, paused: false };
  }

  const outcome = await send(
    ctx,
    report,
    budget,
    `buybackWithDeadline (minTokenOut ${minTokenOut}, deadline ${deadline})`,
    { address: splitter, abi: feeSplitterAbi, functionName: 'buybackWithDeadline', args: [minTokenOut, deadline], gas: GAS.buyback },
    { kind: 'buyback', key: splitter.toLowerCase(), worthSending: (r) => (r as [bigint, bigint])[0] > 0n },
  );
  if (revertedWith(outcome, TRADING_PAUSED)) return { notes: { ...notes, buyback: outcome.status }, wakeAt: null, paused: true };
  return { notes: { ...notes, buyback: outcome.status }, wakeAt: cooldown === undefined ? null : now + cooldown, paused: false };
}

/** `minTokenOut` of the write-down send: no buy can meet it, so the call can only land a skip (see the file header). */
export const WRITE_DOWN_MIN_TOKEN_OUT = 2n ** 256n - 1n;

/**
 * The probe skipped (burned 0) while the splitter holds `held` < `reserve` USDG: send the buyback once so
 * the chain lowers `buybackBalance` to `held` (`BuybackBalanceWrittenDown`). Not under
 * CRANKER_BUYBACK_DRY_RUN, which sends no buyback call of any kind. After it lands the counter equals the balance,
 * so the next interval takes the normal path; no page here, the monitor pages on the event itself.
 */
async function writeDown(
  ctx: CrankContext,
  report: StepReport,
  budget: Budget,
  splitter: Address,
  deadline: bigint,
  reserve: bigint,
  held: bigint,
  notes: Record<string, unknown>,
): Promise<BuybackResult> {
  const key = `${splitter.toLowerCase()}:write-down`;
  const what = `buybackWithDeadline write-down (buybackBalance ${reserve} > USDG held ${held}; minTokenOut 2^256-1, cannot buy)`;
  if (ctx.config.tuning.buybackDryRun) {
    report.actions.push({ what: `${what} (dry)`, kind: 'buyback', key, status: 'not-sent' });
    return { notes: { ...notes, buyback: 'dry run: write-down probed, not sent' }, wakeAt: null, paused: false };
  }
  const outcome = await send(
    ctx,
    report,
    budget,
    what,
    { address: splitter, abi: feeSplitterAbi, functionName: 'buybackWithDeadline', args: [WRITE_DOWN_MIN_TOKEN_OUT, deadline], gas: GAS.buyback },
    { kind: 'buyback', key },
  );
  if (revertedWith(outcome, TRADING_PAUSED)) return { notes: { ...notes, buyback: `write-down: ${outcome.status}` }, wakeAt: null, paused: true };
  return { notes: { ...notes, buyback: `write-down: ${outcome.status}` }, wakeAt: null, paused: false };
}
