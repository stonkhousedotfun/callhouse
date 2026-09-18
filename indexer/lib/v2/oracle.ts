import type { Address } from "viem";

export type SettlementStatus = "None" | "Pending" | "Finalized" | "Held";

export type SettlementState = {
  status: SettlementStatus;
  price: bigint | null;
  sourceIndex: number | null;
  corroborated: boolean | null;
  candidatePrice: bigint | null;
  candidateSourceIndex: number | null;
  candidateDisagreed: boolean | null;
  candidateAt: bigint | null;
  finalizableAt: bigint | null;
  recordedSources: string;
  finalizedAt: bigint | null;
  finalizedTx: `0x${string}` | null;
  heldAt: bigint | null;
};

export type OracleEvent =
  | { kind: "SourceRecorded"; sourceIndex: number; ok: boolean; price: bigint }
  | { kind: "SettlementCandidate"; price: bigint; sourceIndex: number; disagreed: boolean; finalizableAt: bigint }
  | { kind: "SettlementFinalized"; price: bigint; sourceIndex: number; corroborated: boolean; tx: `0x${string}` }
  | { kind: "SettlementResolved"; price: bigint; tx: `0x${string}` }
  | { kind: "SettlementVetoed" }
  | { kind: "SettlementUnvetoed"; finalizableAt: bigint };

/** One verdict covers every strike and both sides at an underlying's expiry. */
export const settlementId = (underlying: Address, expiry: bigint): string =>
  `${underlying.toLowerCase()}-${expiry}`;

export const emptySettlement = (): SettlementState => ({
  status: "None",
  price: null,
  sourceIndex: null,
  corroborated: null,
  candidatePrice: null,
  candidateSourceIndex: null,
  candidateDisagreed: null,
  candidateAt: null,
  finalizableAt: null,
  recordedSources: "{}",
  finalizedAt: null,
  finalizedTx: null,
  heldAt: null,
});

/** Reduce the oracle's event tape without RPC reads or wall-clock state. */
export function reduceOracle(current: SettlementState, event: OracleEvent, at: bigint): SettlementState {
  switch (event.kind) {
    case "SourceRecorded": {
      const sources = JSON.parse(current.recordedSources) as Record<string, { ok: boolean; price: string; recordedAt: string }>;
      sources[String(event.sourceIndex)] = { ok: event.ok, price: event.price.toString(), recordedAt: at.toString() };
      return { ...current, recordedSources: JSON.stringify(sources) };
    }
    case "SettlementCandidate":
      return {
        ...current,
        status: "Pending",
        candidatePrice: event.price,
        candidateSourceIndex: event.sourceIndex,
        candidateDisagreed: event.disagreed,
        candidateAt: at,
        finalizableAt: event.finalizableAt,
        heldAt: null,
      };
    case "SettlementFinalized":
    case "SettlementResolved":
      return {
        ...current,
        status: "Finalized",
        price: event.price,
        sourceIndex: event.kind === "SettlementFinalized" ? event.sourceIndex : null,
        corroborated: event.kind === "SettlementFinalized" ? event.corroborated : null,
        candidatePrice: null,
        candidateSourceIndex: null,
        candidateDisagreed: null,
        candidateAt: null,
        finalizableAt: null,
        finalizedAt: at,
        finalizedTx: event.tx,
        heldAt: null,
      };
    case "SettlementVetoed":
      return { ...current, status: "Held", heldAt: at };
    case "SettlementUnvetoed":
      return {
        ...current,
        status: "Pending",
        candidateAt: at,
        finalizableAt: event.finalizableAt,
        heldAt: null,
      };
  }
}

/** An oracle verdict precedes Clearinghouse settlement; it must not mark a series settled. */
export type SeriesStatus = "open" | "cutoff" | "expired" | "settling" | "held" | "settled";

export function oracleSeriesStatus(current: SeriesStatus, settlement: SettlementStatus): SeriesStatus {
  if (current === "settled") return current;
  if (settlement === "Held") return "held";
  if (settlement === "Pending" || settlement === "Finalized") return "settling";
  return current;
}
