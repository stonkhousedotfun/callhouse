import { describe, expect, it } from "vitest";

import { settlementOracleAbi } from "../../abis/v2/settlementOracle";
import { emptySettlement, oracleSeriesStatus, reduceOracle, settlementId } from "../../lib/v2/oracle";

const UNDERLYING = "0x00000000000000000000000000000000000000aA" as const;
const TX = "0x1234" as const;

describe("SettlementOracle event reduction", () => {
  it("enumerates every frozen oracle event", () => {
    expect(settlementOracleAbi.filter((item) => item.type === "event").map((item) => item.name)).toEqual(expect.arrayContaining([
      "MarketSourcesSet", "SettlementCandidate", "SettlementFinalized", "SettlementResolved",
      "SettlementUnvetoed", "SettlementVetoed", "SourceRecorded",
    ]));
  });

  it("keys all strikes in an expiry to one verdict", () => {
    expect(settlementId(UNDERLYING, 123n)).toBe("0x00000000000000000000000000000000000000aa-123");
  });

  it("records sources, candidate, veto and corroborated finalization", () => {
    let state = emptySettlement();
    state = reduceOracle(state, { kind: "SourceRecorded", sourceIndex: 0, ok: true, price: 215_000_000n }, 100n);
    state = reduceOracle(state, { kind: "SourceRecorded", sourceIndex: 1, ok: false, price: 0n }, 101n);
    expect(JSON.parse(state.recordedSources)).toEqual({
      "0": { ok: true, price: "215000000", recordedAt: "100" },
      "1": { ok: false, price: "0", recordedAt: "101" },
    });
    state = reduceOracle(state, { kind: "SettlementCandidate", price: 215_000_000n, sourceIndex: 0, disagreed: true, finalizableAt: 500n }, 120n);
    expect(state).toMatchObject({ status: "Pending", candidatePrice: 215_000_000n, candidateAt: 120n, finalizableAt: 500n });
    state = reduceOracle(state, { kind: "SettlementVetoed" }, 130n);
    expect(state).toMatchObject({ status: "Held", heldAt: 130n, candidatePrice: 215_000_000n });
    state = reduceOracle(state, { kind: "SettlementUnvetoed", finalizableAt: 600n }, 140n);
    expect(state).toMatchObject({ status: "Pending", heldAt: null, candidateAt: 140n, finalizableAt: 600n });
    state = reduceOracle(state, {
      kind: "SettlementFinalized", price: 216_000_000n, sourceIndex: 1, corroborated: true, tx: TX,
    }, 150n);
    expect(state).toMatchObject({
      status: "Finalized", price: 216_000_000n, sourceIndex: 1, corroborated: true,
      candidatePrice: null, heldAt: null, finalizedAt: 150n, finalizedTx: TX,
    });
  });

  it("resolves a held market without inventing source provenance", () => {
    const held = reduceOracle(emptySettlement(), { kind: "SettlementVetoed" }, 10n);
    const resolved = reduceOracle(held, { kind: "SettlementResolved", price: 200_000_000n, tx: TX }, 20n);
    expect(resolved).toMatchObject({
      status: "Finalized", price: 200_000_000n, sourceIndex: null, corroborated: null,
      heldAt: null, finalizedTx: TX,
    });
  });

  it("moves series through oracle phases without overwriting Clearinghouse settlement", () => {
    expect(oracleSeriesStatus("open", "Pending")).toBe("settling");
    expect(oracleSeriesStatus("settling", "Held")).toBe("held");
    expect(oracleSeriesStatus("held", "Finalized")).toBe("settling");
    expect(oracleSeriesStatus("settled", "Held")).toBe("settled");
  });
});
