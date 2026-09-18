/** OrderBook fee policy. Exercise fees belong to the Clearinghouse, not this schedule. */
export type OrderBookFees = {
  premiumFeeBps: number;
  resaleFeeBps: number;
  takerFeeFlat: bigint;
  takerFeeCapBps: number;
  makerRebateBps: number;
};

export type FeeSchedule = { fees: OrderBookFees; effectiveAt: bigint };
export type FeeState = { active: OrderBookFees; pending: FeeSchedule | null };

/** ABI-decoded FeeParamsScheduled.params. Small uints decode as numbers with viem. */
export type FeeParamsLog = {
  premiumFeeBps: number | bigint;
  resaleFeeBps: number | bigint;
  takerFeeFlat: number | bigint;
  takerFeeCapBps: number | bigint;
  makerRebateBps: number | bigint;
};

export function feesFromLog(params: FeeParamsLog): OrderBookFees {
  return {
    premiumFeeBps: Number(params.premiumFeeBps),
    resaleFeeBps: Number(params.resaleFeeBps),
    takerFeeFlat: BigInt(params.takerFeeFlat),
    takerFeeCapBps: Number(params.takerFeeCapBps),
    makerRebateBps: Number(params.makerRebateBps),
  };
}

/** Mirrors OrderBook._effectiveFees: activation has no event or storage write. */
export function effectiveFees(state: FeeState, at: bigint): OrderBookFees {
  return state.pending !== null && at >= state.pending.effectiveAt ? state.pending.fees : state.active;
}

/** A later schedule replaces the pending one, first retaining any change already due. */
export function scheduleFees(state: FeeState, fees: OrderBookFees, effectiveAt: bigint, scheduledAt: bigint): FeeState {
  if (effectiveAt <= scheduledAt) throw new RangeError("fee effectiveAt must follow its scheduling block");
  return { active: effectiveFees(state, scheduledAt), pending: { fees, effectiveAt } };
}

export function feesEqual(a: OrderBookFees, b: OrderBookFees): boolean {
  return a.premiumFeeBps === b.premiumFeeBps && a.resaleFeeBps === b.resaleFeeBps &&
    a.takerFeeFlat === b.takerFeeFlat && a.takerFeeCapBps === b.takerFeeCapBps &&
    a.makerRebateBps === b.makerRebateBps;
}

/** Columns stored in v2_order_book_state; absent constructor logs fall back to the registry. */
export type StoredFeeState = {
  premiumFeeBps: number | null;
  resaleFeeBps: number | null;
  takerFeeFlat: bigint | null;
  takerFeeCapBps: number | null;
  makerRebateBps: number | null;
  pendingPremiumFeeBps: number | null;
  pendingResaleFeeBps: number | null;
  pendingTakerFeeFlat: bigint | null;
  pendingTakerFeeCapBps: number | null;
  pendingMakerRebateBps: number | null;
  pendingEffectiveAt: bigint | null;
};

export function feeStateFromRow(row: StoredFeeState | null, defaults: OrderBookFees): FeeState {
  if (row === null) return { active: defaults, pending: null };
  const active = {
    premiumFeeBps: row.premiumFeeBps ?? defaults.premiumFeeBps,
    resaleFeeBps: row.resaleFeeBps ?? defaults.resaleFeeBps,
    takerFeeFlat: row.takerFeeFlat ?? defaults.takerFeeFlat,
    takerFeeCapBps: row.takerFeeCapBps ?? defaults.takerFeeCapBps,
    makerRebateBps: row.makerRebateBps ?? defaults.makerRebateBps,
  };
  if (row.pendingEffectiveAt === null) return { active, pending: null };
  const { pendingPremiumFeeBps, pendingResaleFeeBps, pendingTakerFeeFlat,
    pendingTakerFeeCapBps, pendingMakerRebateBps } = row;
  if (pendingPremiumFeeBps === null || pendingResaleFeeBps === null || pendingTakerFeeFlat === null ||
      pendingTakerFeeCapBps === null || pendingMakerRebateBps === null)
    throw new Error("incomplete scheduled OrderBook fees");
  return { active, pending: { effectiveAt: row.pendingEffectiveAt, fees: {
    premiumFeeBps: pendingPremiumFeeBps, resaleFeeBps: pendingResaleFeeBps,
    takerFeeFlat: pendingTakerFeeFlat, takerFeeCapBps: pendingTakerFeeCapBps,
    makerRebateBps: pendingMakerRebateBps,
  } } };
}

export function feeStateColumns(state: FeeState): StoredFeeState {
  const pending = state.pending?.fees;
  return {
    ...state.active,
    pendingPremiumFeeBps: pending?.premiumFeeBps ?? null,
    pendingResaleFeeBps: pending?.resaleFeeBps ?? null,
    pendingTakerFeeFlat: pending?.takerFeeFlat ?? null,
    pendingTakerFeeCapBps: pending?.takerFeeCapBps ?? null,
    pendingMakerRebateBps: pending?.makerRebateBps ?? null,
    pendingEffectiveAt: state.pending?.effectiveAt ?? null,
  };
}

/** Reduce the on-chain schedule log into columns without reading wall-clock time. */
export function scheduledFeeColumns(row: StoredFeeState | null, defaults: OrderBookFees,
  params: FeeParamsLog, effectiveAt: bigint, scheduledAt: bigint): StoredFeeState {
  return feeStateColumns(scheduleFees(feeStateFromRow(row, defaults), feesFromLog(params), effectiveAt, scheduledAt));
}
