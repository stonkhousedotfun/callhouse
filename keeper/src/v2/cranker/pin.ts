/**
 * Refused settlement pins (INTERFACE_VERSION 6), named from a revert. Pure.
 *
 * Clearinghouse.createSeries calls SettlementOracle.pin for every series it creates. The first series of an
 * (underlying, expiry) copies the market's source list and parameters into the expiry's pinned configuration and asks
 * every source to pin its own (the feed, the pool, the stream). Pinning FAILS CLOSED: a refused pin reverts the
 * creation, with one of
 *
 *   NotAuthorized()                   the oracle's `clearinghouse` pointer is not this Clearinghouse
 *   NoSource()                        the market has no source on the oracle
 *   PinMismatch()                     the expiry was pinned through another Clearinghouse (or by the admin outside a
 *                                     series creation) and that copy differs from the market's current configuration
 *   SourceNotPinned(source, reason)   a source refused its own pin; `reason` is the first 4 bytes of its revert:
 *       NotAuthorized 0xea8e4eb5      the source's oracle allow-list does not hold this oracle (setOracle)
 *       NoSource      0x7d19c0ff      the source has no configuration for the underlying (setFeed / setPool)
 *       PinMismatch   0x52e8e6d6      the source holds an earlier pin of the expiry that differs from its current one
 *       0x00000000                    no revert data: no code at the source, an answer that is not the pin selector,
 *                                     or the source ran out of gas (so it proves a refusal only under ample gas)
 *
 * None of these heals by itself (an admin changes a pointer, an allow-list or a configuration), so the cranker does
 * not retry blindly: it skips the (underlying, expiry), pages `v2_pin_refused`, and asks again with a simulation after
 * PIN_REFUSED_RECHECK_S. AutoRoller.roll creates its series through createSeries, so PinMismatch and
 * SourceNotPinned also reach a roll; NotAuthorized and NoSource from a roll are ambiguous (the roller raises both for
 * its own reasons: a revoked operator approval, no spot) and are not read as pin refusals there.
 */
import { decodeErrorResult, type Abi, type Hex } from 'viem';

export const PIN_ERROR_SELECTORS = {
  PinMismatch: '0x52e8e6d6',
  SourceNotPinned: '0xf54720df',
  NotAuthorized: '0xea8e4eb5',
  NoSource: '0x7d19c0ff',
} as const;

export type PinErrorName = keyof typeof PIN_ERROR_SELECTORS;

/** SourceNotPinned's `reason` selectors a v2 source raises, by name. */
export const SOURCE_REASON_NAMES: Readonly<Record<string, string>> = {
  [PIN_ERROR_SELECTORS.NotAuthorized]: 'NotAuthorized',
  [PIN_ERROR_SELECTORS.NoSource]: 'NoSource',
  [PIN_ERROR_SELECTORS.PinMismatch]: 'PinMismatch',
  '0x00000000': 'none',
};

export interface PinRefusal {
  error: PinErrorName;
  /** SourceNotPinned: the refusing source. */
  source: string | null;
  /** SourceNotPinned: its revert selector (0x00000000 when it gave none). */
  reason: Hex | null;
  /** The reason's name (SOURCE_REASON_NAMES), or the raw selector of an error no v2 source raises. */
  reasonName: string | null;
  /** SourceNotPinned without revert data under a gas limit that may have starved the source: not proof of a refusal. */
  maybeOutOfGas: boolean;
  /** What the operator fixes, in one line. */
  explanation: string;
  /** Error, source and reason, lower-case: one page per distinct cause, however many expiries it blocks. */
  cause: string;
}

/** A revert as a name and its decoded arguments (tx.ts revertDetail; decodeRevertData for a Multicall3 result). */
export interface RevertLike {
  name: string | null;
  args?: readonly unknown[];
}

/** A failed call's revert data decoded against `abi`; the raw selector for an error the ABI does not know; null for no data. */
export function decodeRevertData(abi: Abi, data: Hex | undefined): { name: string; args: readonly unknown[] } | null {
  if (data === undefined || data.length < 10) return null;
  try {
    const decoded = decodeErrorResult({ abi, data });
    return { name: decoded.errorName, args: decoded.args ?? [] };
  } catch {
    return { name: data.slice(0, 10).toLowerCase(), args: [] };
  }
}

const EXPLAIN: Record<Exclude<PinErrorName, 'SourceNotPinned'>, string> = {
  NotAuthorized: "the oracle's clearinghouse pointer is not this Clearinghouse (SettlementOracle.setClearinghouse)",
  NoSource: 'the market has no price source on the oracle (SettlementOracle.setMarket)',
  PinMismatch: "the expiry was pinned through another Clearinghouse or by the admin, and that copy differs from the market's current configuration",
};

const EXPLAIN_REASON: Record<string, string> = {
  NotAuthorized: "the source's oracle allow-list does not hold this oracle (setOracle)",
  NoSource: 'the source has no configuration for the underlying (setFeed / setPool)',
  PinMismatch: 'the source holds an earlier pin of the expiry that differs from its current configuration',
  none: 'the source gave no revert data: no code, an answer that is not the pin selector, or out of gas',
};

/**
 * The pin refusal a revert describes, or null when it is not one. `context` says which call reverted (see the header
 * for why a roll's NotAuthorized and NoSource are not refusals); `ampleGas` says whether it ran under a limit that
 * cannot have starved a source (a probe), which is what makes a SourceNotPinned without data conclusive.
 */
export function pinRefusalOf(revert: RevertLike | null, context: 'createSeries' | 'roll', ampleGas: boolean): PinRefusal | null {
  if (revert === null || revert.name === null) return null;
  const name = revert.name;
  if (name === 'PinMismatch' || name === PIN_ERROR_SELECTORS.PinMismatch) return simple('PinMismatch');
  if ((name === 'NotAuthorized' || name === PIN_ERROR_SELECTORS.NotAuthorized) && context === 'createSeries') return simple('NotAuthorized');
  if ((name === 'NoSource' || name === PIN_ERROR_SELECTORS.NoSource) && context === 'createSeries') return simple('NoSource');
  if (name !== 'SourceNotPinned' && name !== PIN_ERROR_SELECTORS.SourceNotPinned) return null;
  const [sourceArg, reasonArg] = revert.args ?? [];
  const source = typeof sourceArg === 'string' ? sourceArg.toLowerCase() : null;
  const reason = typeof reasonArg === 'string' && /^0x[0-9a-fA-F]{8}$/.test(reasonArg) ? (reasonArg.toLowerCase() as Hex) : null;
  const reasonName = reason === null ? null : (SOURCE_REASON_NAMES[reason] ?? reason);
  const why = reasonName === null ? 'the source refused its pin' : (EXPLAIN_REASON[reasonName] ?? `the source reverted ${reasonName}`);
  return {
    error: 'SourceNotPinned',
    source,
    reason,
    reasonName,
    maybeOutOfGas: (reason === null || reason === '0x00000000') && !ampleGas,
    explanation: `source ${source ?? '?'} refused its pin: ${why}`,
    cause: `sourcenotpinned:${source ?? '?'}:${reason ?? '?'}`,
  };
}

function simple(error: Exclude<PinErrorName, 'SourceNotPinned'>): PinRefusal {
  return { error, source: null, reason: null, reasonName: null, maybeOutOfGas: false, explanation: EXPLAIN[error], cause: error.toLowerCase() };
}
