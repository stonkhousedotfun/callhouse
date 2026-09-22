/**
 * T-476. surveyExpiries reads each expiry's candidate() in the same pinned multicall as settlementPrice. A failed
 * candidate read must never look like "no candidate": that value makes planExpiry finalize a Pending expiry every tick
 * and skip the v2_sources_disagree alert, inside the one window (the guardian's veto window) where the alert matters.
 *
 * DELIBERATELY ABSENT: an RPC. The client answers multicall from a table, and a throwing entry is a failed outcome,
 * exactly as multicallMany reports a reverted view (allowFailure: true).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getAddress, type Abi, type Address } from 'viem';
import { planExpiry } from './planner.js';
import { surveyExpiries } from './reads.js';

const CH = getAddress('0x2256c045245288A314048aD2d71006a564343C63');
const ORACLE = getAddress('0x4b8c2BEFfecbdc4BeD6e6826e62093F0Cf635E78');
const CL = getAddress('0x157f589Cd9d0E4a94C9936ede3b23BEfa3017F20');
const POOL = getAddress('0x5d46388aD462fF7f92587fE4872e97668e98329d');
const U = getAddress('0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec');
const E = 1_789_934_400;
/** Past the snapshot grace, before the candidate's finalizableAt: the veto window. */
const NOW = E + 700;
const FINALIZABLE_AT = E + 21_600;
const THRESHOLDS = { noSourceAlertS: 3_600, pendingStuckS: 1_800 };

type Answer = (args: readonly unknown[], address: Address) => unknown;

/** A Pending, captured expiry with open interest whose two recorded sources disagreed. */
function answers(): Record<string, Answer> {
  return {
    openInterest: () => 100n,
    settlementPrice: () => [1, 0n], // Pending
    candidate: () => [216_000_000n, 0, true, FINALIZABLE_AT],
    settlementInfo: () => [1, 0n, 0, false, false, true], // captured
    recordedSources: () => [[CL, POOL], [true, true], [216_000_000n, 230_000_000n], 2],
    settlementConfig: () => [true, [CL, POOL], 150, 21_600, 90_000],
    windowPrice: () => [true, 216_000_000n],
  };
}

/**
 * T-496. The chain has TWO blocks with DIFFERENT state, and the fake answers at the block it is asked for.
 *
 * WHY: the cranker pins its post-read to the receipt's block (`readMany` -> `multicallMany(client, calls,
 * { blockNumber })`), and `multicallMany` OMITS the key entirely when the pin is undefined, which viem reads as
 * "head". A fake that destructured only `{ contracts }` could not tell the two apart, so every test in this file
 * stayed green when the pin was deleted from the call chain: they proved the survey's decisions, not that the
 * block reached the RPC. Answering from one table per block is what makes dropping the pin observable.
 */
const PINNED_BLOCK = 1n;
const HEAD_BLOCK = 2n;

function clientOf(atPinned: Record<string, Answer>, atHead: Record<string, Answer> = atPinned) {
  return {
    getBlockNumber: async () => HEAD_BLOCK,
    multicall: async ({ contracts, blockNumber }: { contracts: Array<{ functionName: string; args?: readonly unknown[]; address: Address; abi: Abi }>; blockNumber?: bigint }) => {
      // An unpinned read (`blockNumber` absent) is a head read, exactly as viem treats it.
      const results = blockNumber === PINNED_BLOCK ? atPinned : atHead;
      return contracts.map((c) => {
        try {
          return { status: 'success', result: results[c.functionName]!(c.args ?? [], c.address) };
        } catch (error) {
          return { status: 'failure', error };
        }
      });
    },
  };
}

function survey(results: Record<string, Answer>, atHead?: Record<string, Answer>) {
  return surveyExpiries(clientOf(results, atHead) as never, {
    clearinghouse: CH,
    orderBook: CH,
    keys: [{ oracle: ORACLE, underlying: U, expiry: E }],
    seriesOf: () => [],
    snapshotDone: () => true,
    now: NOW,
    blockNumber: PINNED_BLOCK,
    withOrders: false,
    prunable: () => [],
  });
}

test('positive control: a disagreeing candidate read inside the veto window alerts and is not finalized early', async () => {
  const [s] = await survey(answers());
  assert.deepEqual(s!.view.candidate, { price: 216_000_000n, sourceIndex: 0, disagreed: true, finalizableAt: FINALIZABLE_AT });
  const plan = planExpiry(s!.view, THRESHOLDS);
  assert.equal(plan.finalize, false);
  assert.equal(plan.phase, 'pending');
  assert.equal(plan.wakeAt, FINALIZABLE_AT);
  assert.deepEqual(plan.alerts.map((a) => a.kind), ['v2_sources_disagree']);
});

test('a failed candidate() read fails the survey naming the expiry; it is never surveyed as "no candidate" and never finalized on', async () => {
  const results = answers();
  results.candidate = () => {
    throw new Error('execution reverted: rpc fault');
  };
  const outcome = await survey(results).then(
    ([s]) => ({ survey: s! }),
    (error: Error) => ({ error }),
  );
  if ('survey' in outcome) {
    const plan = planExpiry(outcome.survey.view, THRESHOLDS);
    assert.fail(
      `${U} expiry ${E}: a failed candidate() read was surveyed as candidate ${JSON.stringify(outcome.survey.view.candidate)}`
        + ` and planned finalize=${plan.finalize} with alerts [${plan.alerts.map((a) => a.kind).join(', ')}]`,
    );
  }
  assert.match(outcome.error.message, new RegExp(`^candidate\\(${U}, ${E}\\): execution reverted`));
});

test('the same failure with settlementInfo also failing does not invent a capture state from a default', async () => {
  // Before T-476, `captured` fell back to `status !== 'None' || finalizableAt !== 0` on the defaulted candidate.
  const results = answers();
  results.candidate = () => {
    throw new Error('execution reverted: rpc fault');
  };
  results.settlementInfo = () => {
    throw new Error('execution reverted: rpc fault');
  };
  await assert.rejects(survey(results), new RegExp(`^Error: candidate\\(${U}, ${E}\\)`));
});

/**
 * T-496. THE TEST THAT FAILS WHEN THE PIN IS DROPPED.
 *
 * The survey must read the block it was given, not whatever head happens to be. Head here is one block later and
 * the guardian's veto has already resolved there: the candidate no longer disagrees and is finalizable. At the
 * pinned block it still disagrees, which is the state the tick actually decided on.
 *
 * Delete `{ blockNumber }` at reads.ts:27 and this goes red: `multicallMany` omits the key, the fake answers from
 * head, and the survey reports a candidate that agreed and a plan that finalizes with no `v2_sources_disagree` —
 * finalizing inside the one window where the alert matters, on state from a block the tick never saw.
 */
test('T-496: the survey reads the block it was pinned to, not head', async () => {
  const atHead = answers();
  // At head the veto resolved: one source, no disagreement, and past its finalizableAt.
  atHead.candidate = () => [216_000_000n, 0, false, E];
  atHead.recordedSources = () => [[CL], [true], [216_000_000n], 1];

  const [s] = await survey(answers(), atHead);
  const got = s!.view.candidate;
  assert.equal(
    got.disagreed,
    true,
    `block ${PINNED_BLOCK}: the survey must report the candidate AT THE PINNED BLOCK, where the sources disagreed.`
      + ` It reported disagreed=${got.disagreed}, which is the state at head (block ${HEAD_BLOCK}) — the blockNumber`
      + ` never reached the multicall, so this tick decided on a block it never read.`,
  );

  const plan = planExpiry(s!.view, THRESHOLDS);
  assert.equal(
    plan.finalize,
    false,
    `block ${PINNED_BLOCK}: an expiry whose sources disagreed at the pinned block must not be finalized.`
      + ` finalize=${plan.finalize} means the plan was made from head (block ${HEAD_BLOCK}).`,
  );
  assert.deepEqual(
    plan.alerts.map((a) => a.kind),
    ['v2_sources_disagree'],
    `block ${PINNED_BLOCK}: the disagreement alert must be raised from the pinned block's sources;`
      + ` losing it means the survey read head (block ${HEAD_BLOCK}) instead.`,
  );
});
