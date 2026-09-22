/**
 * The house page's row assembly. AUTHORED, NOT RUN as a shipping gate — owner directive 2026-09-19.
 *
 * These are the "render with a losing epoch" and "countdown copy" cases from the task contract,
 * written against the row builder rather than against rendered DOM: `web/vitest.config.ts` runs a
 * NODE environment and states that a jsdom environment is "deliberately absent", so there is no
 * render to assert on in this repository. Building the rows outside React is what makes the losing
 * epoch checkable at all — see the header of `houseRows.ts`.
 */
import { describe, expect, it } from "vitest";

import type { HouseEpoch, HouseMarketResponse } from "./api-types";
import { NAV_NOT_AVAILABLE } from "./houseEpoch";
import * as houseRows from "./houseRows";
import { houseCountdown, houseInKindPreview, navCellLabel, pastEpochRows } from "./houseRows";

const money = (raw: string, decimals = 6) => ({ raw, decimals, formatted: raw });

function epoch(over: Partial<HouseEpoch> & { id: string }): HouseEpoch {
  // `??` here would have swallowed an EXPLICIT null, which is the case these tests exist to cover:
  // `start`/`end` are nullable on the wire and "not supplied" is not the same as "supplied as null".
  // The comparison is against `undefined` rather than an `in` check because `Partial<HouseEpoch>`
  // makes each key optional, so `in` narrows presence but leaves `undefined` in the type.
  return {
    id: over.id,
    start: over.start === undefined ? 1_760_000_000 : over.start,
    end: over.end === undefined ? 1_760_604_800 : over.end,
    nav: over.nav ?? null,
    resultUsdg: over.resultUsdg ?? null,
  };
}

/** The countdown for an epoch whose boundary IS observed. Fails loudly instead of asserting non-null. */
function countdownOf(nowUnixSeconds: number, current: HouseEpoch) {
  const countdown = houseCountdown(nowUnixSeconds, current);
  if (countdown === null) throw new Error("expected a countdown for an epoch with an observed end");
  return countdown;
}

function settled(id: string, navUsdg: string, resultUsdg: string): HouseEpoch {
  return epoch({
    id,
    nav: {
      epoch: id, at: 1_760_604_800, usdg: money(navUsdg), stockUnits: "0",
      settlementPrice: money("181.250000"), navUsdg: money(navUsdg),
    },
    resultUsdg: money(resultUsdg),
  });
}

describe("pastEpochRows", () => {
  it("renders a losing epoch as a row, with its negative result intact", () => {
    const rows = pastEpochRows([settled("7", "990000000", "-10000000")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe("lost");
    expect(rows[0]!.resultUsdg).toBe(-10_000_000n);
  });

  it("keeps losing epochs in a mixed history rather than filtering them out", () => {
    const rows = pastEpochRows([
      settled("5", "1000000000", "25000000"),
      settled("6", "960000000", "-40000000"),
      settled("7", "960000000", "0"),
    ]);
    expect(rows.map((row) => row.id)).toEqual(["5", "6", "7"]);
    expect(rows.map((row) => row.outcome)).toEqual(["gained", "lost", "flat"]);
  });

  it("reports an epoch with no result as unreported, never as break-even", () => {
    const rows = pastEpochRows([epoch({ id: "8" })]);
    expect(rows[0]!.resultUsdg).toBeNull();
    expect(rows[0]!.outcome).toBe("unreported");
  });

  it("exposes no aggregate: the module has no total, average, streak or rate", () => {
    // A guard against the shape of the compliance failure, not against a spelling. The lint at
    // disclosure policy (copy-lint enforced this until it was removed on 2026-09-21; nothing checks it now) catches forward-looking vocabulary; it cannot catch an aggregate
    // being added here, so the absence is asserted on the module's own surface.
    const surface = Object.keys(houseRows);
    // copy-lint-allow — the forbidden token is the SUBJECT of this assertion: the test asserts no
    // export is named after an aggregate, so the name has to appear here to be ruled out.
    expect(surface.some((name) => /total|average|mean|streak|apy|annual|cumulative/i.test(name))).toBe(false); // copy-lint-allow
  });

  it("shows a NAV only as a boundary figure and labels the boundary it came from", () => {
    const [row] = pastEpochRows([settled("9", "1000000000", "0")]);
    expect(row!.nav.available).toBe(true);
    expect(row!.navAtLabel).not.toBeNull();
    expect(navCellLabel(row!)).toContain("boundary");
  });

  it("gives a running epoch the unavailable message instead of a number", () => {
    const [row] = pastEpochRows([epoch({ id: "10" })]);
    expect(row!.nav.available).toBe(false);
    expect(row!.nav.available === false && row!.nav.message).toBe(NAV_NOT_AVAILABLE);
    expect(navCellLabel(row!)).toBe(NAV_NOT_AVAILABLE);
  });
});

describe("an unobserved boundary is labelled, never dated", () => {
  /**
   * THIS IS THE TEST THAT CATCHES THE FORBIDDEN FIX. `start`/`end` are nullable because a boundary
   * is "null until observed" (`api-schema.ts`, `houseEpochSchema`). Coerce either one — `?? 0`, a
   * non-null assertion, `as number` — and `formatNewYork` renders the unix epoch, so the row claims
   * the vault started trading in 1969 or 1970 depending on the reader's offset from New York. That
   * is a user-visible lie on a vault page, which is worse than the build failure it would silence.
   */
  it("says not observed, and does not render a 1969/1970 date, for a null start or end", () => {
    const [row] = pastEpochRows([epoch({ id: "15", start: null, end: null })]);
    expect(row!.startLabel).toBe(houseRows.BOUNDARY_NOT_OBSERVED);
    expect(row!.endLabel).toBe(houseRows.BOUNDARY_NOT_OBSERVED);
    expect(row!.startLabel).not.toMatch(/19(69|70)/);
    expect(row!.endLabel).not.toMatch(/19(69|70)/);
  });

  it("still dates a boundary that WAS observed, so the label is not simply hard-coded", () => {
    const [row] = pastEpochRows([epoch({ id: "16", start: 1_760_000_000, end: 1_760_604_800 })]);
    expect(row!.startLabel).not.toBe(houseRows.BOUNDARY_NOT_OBSERVED);
    expect(row!.startLabel).toMatch(/2025|2026/);
  });
});

describe("houseCountdown", () => {
  it("counts down to the epoch's own boundary and says the deposit joins there", () => {
    const current = epoch({ id: "11", start: 1_760_000_000, end: 1_760_000_600 });
    const countdown = countdownOf(1_760_000_000, current);
    expect(countdown.secondsRemaining).toBe(600);
    expect(countdown.depositJoinsSentence).toContain("joins at the next boundary");
    expect(countdown.depositJoinsSentence).toContain(countdown.boundaryLabel);
  });

  it("floors at zero once the boundary has passed rather than going negative", () => {
    const current = epoch({ id: "12", end: 1_760_000_000 });
    expect(countdownOf(1_760_000_900, current).secondsRemaining).toBe(0);
  });

  it("promises no share count for the deposit", () => {
    const countdown = countdownOf(1_760_000_000, epoch({ id: "13", end: 1_760_000_600 }));
    expect(countdown.depositJoinsSentence).not.toMatch(/\bshares?\b/i);
  });

  /**
   * All three countdown fields are functions of `end`. There is no honest partial countdown, so an
   * unobserved boundary yields no countdown at all and `HouseVault.tsx` renders its own
   * "Epoch figures are unavailable." A zero here would read as "the boundary is now".
   */
  it("has no countdown at all when the boundary has not been observed", () => {
    expect(houseCountdown(1_760_000_000, epoch({ id: "14", end: null }))).toBeNull();
  });
});

describe("houseInKindPreview", () => {
  it("is unavailable, because this API carries no boundary pool figures", () => {
    const market = {
      market: "NVDA", vault: "0x0000000000000000000000000000000000000001",
      currentEpoch: epoch({ id: "14" }), epochs: [], shares: null, queue: [],
    } as HouseMarketResponse;
    const preview = houseInKindPreview(market);
    expect(preview.available).toBe(false);
    expect(preview.available === false && preview.message).toBe(NAV_NOT_AVAILABLE);
  });
});
