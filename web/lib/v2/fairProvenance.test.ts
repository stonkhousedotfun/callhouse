/**
 * W3-303. The protected fact is: A FAIR VALUE IS NEVER SHOWN WITHOUT A SOURCE QUALIFIER, and the
 * qualifier never overstates the source.
 *
 * That is the fact worth breaking, not "the function returns a string". The failure this row exists
 * to close is a label that goes quiet — X3-302's provenance contract was asserted by schema twins
 * and type tests while NO component read it, so the assertions passed on a field nobody rendered.
 * A test that only checks the happy branch would rebuild exactly that shape one layer up.
 */
import { describe, expect, it } from "vitest";

import { fairIsLive, fairLadderSourceSentence, fairProvenanceLabel, UNKNOWN_SOURCE_LABEL } from "./fairProvenance";

/** Only the fields the label reads; the real type is far larger and none of the rest matters here. */
function provenance(over: {
  cls?: string; declaredDelayS?: number | null; readiness?: string; quoteS?: number | null;
} = {}) {
  return {
    entitlement: {
      class: over.cls ?? "delayed",
      declaredDelayS: over.declaredDelayS ?? null,
      rightsRef: null,
    },
    quality: { readiness: over.readiness ?? "ready", reasons: [], uncertainty: null, disagreement: null, fallback: null },
    ages: { quoteS: over.quoteS ?? null, tradeS: null, underlyingS: null, volatilityS: null },
  };
}

describe("absence is never real-time", () => {
  it("labels missing, null and undefined provenance as unknown", () => {
    for (const value of [undefined, null]) {
      const label = fairProvenanceLabel(value);
      expect(label.text).toBe(UNKNOWN_SOURCE_LABEL);
      expect(label.isLive).toBe(false);
    }
  });

  it("labels a MALFORMED payload as unknown instead of throwing inside a render", () => {
    for (const value of [{}, { entitlement: null }, { entitlement: {} }, "delayed", 42, []]) {
      expect(() => fairProvenanceLabel(value)).not.toThrow();
      expect(fairProvenanceLabel(value).text, JSON.stringify(value)).toBe(UNKNOWN_SOURCE_LABEL);
    }
  });

  it("ALWAYS returns non-empty text and detail, on every input", () => {
    // The label going quiet is the regression this row closes. There is no input that produces
    // nothing to render.
    const inputs = [undefined, null, {}, provenance(), provenance({ cls: "real-time" }),
      provenance({ cls: "end-of-day" }), provenance({ cls: "indicative" }), provenance({ cls: "unknown" }),
      provenance({ readiness: "unavailable" }), provenance({ readiness: "degraded" })];
    for (const input of inputs) {
      const label = fairProvenanceLabel(input);
      expect(label.text.length, JSON.stringify(input)).toBeGreaterThan(0);
      expect(label.detail.length, JSON.stringify(input)).toBeGreaterThan(0);
    }
  });

  it("treats an entitlement class this build has never heard of as unknown", () => {
    // The enum can grow. A new class must land on the conservative branch, not a friendlier one.
    const label = fairProvenanceLabel(provenance({ cls: "some-future-class" }));
    expect(label.text).toBe(UNKNOWN_SOURCE_LABEL);
    expect(label.isLive).toBe(false);
  });
});

describe("the label matches the entitlement", () => {
  it("says delayed, and names the declared delay when there is one", () => {
    expect(fairProvenanceLabel(provenance({ cls: "delayed" })).text).toBe("Delayed data");
    expect(fairProvenanceLabel(provenance({ cls: "delayed", declaredDelayS: 900 })).text)
      .toBe("Delayed data (15 minutes)");
    expect(fairProvenanceLabel(provenance({ cls: "delayed", declaredDelayS: 900 })).detail)
      .toContain("lag the market");
  });

  it("does not claim a delay when the vendor declared none", () => {
    expect(fairProvenanceLabel(provenance({ cls: "delayed", declaredDelayS: 0 })).text).toBe("Delayed data");
  });

  it("says end-of-day and indicative in their own words", () => {
    expect(fairProvenanceLabel(provenance({ cls: "end-of-day" })).text).toBe("End-of-day data");
    expect(fairProvenanceLabel(provenance({ cls: "indicative" })).text).toBe("Indicative data");
    expect(fairProvenanceLabel(provenance({ cls: "indicative" })).isLive).toBe(false);
  });

  it("is live ONLY for a real-time feed that is also ready", () => {
    expect(fairIsLive(provenance({ cls: "real-time", readiness: "ready" }))).toBe(true);
    expect(fairIsLive(provenance({ cls: "real-time", readiness: "degraded" }))).toBe(false);
    expect(fairIsLive(provenance({ cls: "real-time", readiness: "unavailable" }))).toBe(false);
    expect(fairIsLive(provenance({ cls: "delayed", readiness: "ready" }))).toBe(false);
  });

  it("lets readiness OUTRANK entitlement — an unavailable source is never called real-time", () => {
    const label = fairProvenanceLabel(provenance({ cls: "real-time", readiness: "unavailable" }));
    expect(label.text).toBe("Source unavailable");
    expect(label.text).not.toContain("Real-time");
  });

  it("reports the quote age when one is known, and stays silent about it when not", () => {
    expect(fairProvenanceLabel(provenance({ quoteS: 30 })).detail).toContain("less than a minute");
    expect(fairProvenanceLabel(provenance({ quoteS: 900 })).detail).toContain("15 minutes");
    expect(fairProvenanceLabel(provenance({ quoteS: 7_200 })).detail).toContain("2 hours");
    expect(fairProvenanceLabel(provenance({ quoteS: null })).detail).not.toContain("observed");
  });

  it("keeps a declared delay and an observed age distinct", () => {
    // A 15-minute entitlement must not be allowed to describe a two-hour-old quote.
    const label = fairProvenanceLabel(provenance({ cls: "delayed", declaredDelayS: 900, quoteS: 7_200 }));
    expect(label.text).toBe("Delayed data (15 minutes)");
    expect(label.detail).toContain("delayed by 15 minutes");
    expect(label.detail).toContain("observed 2 hours ago");
  });
});

describe("the ladder sentence describes the whole set", () => {
  it("collapses to one sentence when every row shares a source", () => {
    const rows = [{ fairProvenance: provenance({ cls: "delayed" }) }, { fairProvenance: provenance({ cls: "delayed" }) }];
    expect(fairLadderSourceSentence(rows)).toContain("lag the market");
  });

  it("says so, rather than picking the friendliest, when rows disagree", () => {
    const rows = [
      { fairProvenance: provenance({ cls: "real-time" }) },
      { fairProvenance: provenance({ cls: "delayed" }) },
    ];
    const sentence = fairLadderSourceSentence(rows);
    expect(sentence).toContain("do not share one data source");
    expect(sentence).toContain("treat the ladder as delayed");
  });

  it("treats an EMPTY ladder as unknown — no rows is not evidence of a live source", () => {
    expect(fairLadderSourceSentence([])).toContain("not reported");
  });

  it("treats rows with no provenance at all as unknown", () => {
    expect(fairLadderSourceSentence([{}, {}])).toContain("not reported");
  });
});
