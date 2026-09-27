/**
 * The house page's row assembly.
 *
 * These are the "render with a losing epoch" and "countdown copy" cases the House page needs,
 * written against the row builder rather than against rendered DOM: `web/vitest.config.ts` runs a
 * NODE environment and states that a jsdom environment is "deliberately absent", so there is no
 * render to assert on in this repository. Building the rows outside React is what makes the losing
 * epoch checkable at all — see the header of `houseRows.ts`.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { HouseEpoch, HouseMarketResponse } from "./api-types";
import { NAV_NOT_AVAILABLE } from "./houseEpoch";
import * as houseRows from "./houseRows";
import { houseCostsModel, houseCountdown, houseHeroModel, houseInKindPreview, houseProofRows, lastBoundaryAt, navCellLabel,
  navPoints, pastEpochRows, usdgText } from "./houseRows";
import type { HouseVaultReads } from "./chainReads";
import { markPerShare } from "./houseEpoch";

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
    // disclosure policy (nothing checks it automatically now) catches forward-looking vocabulary; it cannot catch an aggregate
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
  it("counts down to the epoch's own close and says the deposit joins there", () => {
    const current = epoch({ id: "11", start: 1_760_000_000, end: 1_760_000_600 });
    const countdown = countdownOf(1_760_000_000, current);
    expect(countdown.secondsRemaining).toBe(600);
    // The sentence (lib/v2/houseEpoch.ts depositJoinsSentence), exact.
    expect(countdown.depositJoinsSentence).toBe(`Your deposit joins at the next close (${countdown.boundaryLabel}).`);
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
  const market = {
    market: "NVDA", vault: "0x0000000000000000000000000000000000000001",
    currentEpoch: epoch({ id: "14" }), epochs: [], shares: null, queue: [],
  } as HouseMarketResponse;

  it("is unavailable before the close, because this API carries no boundary pool figures", () => {
    const preview = houseInKindPreview(market);
    expect(preview.available).toBe(false);
    expect(preview.available === false && preview.message).toBe(NAV_NOT_AVAILABLE);
    // A pending request has no quote yet; neither has an unread one, even if some quote object is lying around.
    const quote = { shares: 0n, usdg: 7_000_000n, stock: 5n };
    for (const state of [{ kind: "pending" }, { kind: "none" }, { kind: "unread" }, { kind: "unknown" }] as const)
      expect(houseInKindPreview(market, state, quote).available).toBe(false);
    expect(houseInKindPreview(market, { kind: "ready" }, null).available).toBe(false);
  });

  // This was hard-coded to "not available" for every wallet. A matured claim now shows the vault's own
  // claimable(account), exactly: no re-division, no event or rate arithmetic.
  it("a matured claim shows claimable(account)'s own USDG, Stock and shares", () => {
    const preview = houseInKindPreview(market, { kind: "ready" }, { shares: 3n, usdg: 7_000_001n, stock: 999_999_999_999_999_999n });
    expect(preview).toEqual({ available: true, usdgOut: 7_000_001n, stockOut: 999_999_999_999_999_999n, sharesOut: 3n });
  });

  it("a matured claim quoted at zero is shown as zero, not as unavailable", () => {
    expect(houseInKindPreview(market, { kind: "ready" }, { shares: 0n, usdg: 0n, stock: 0n }))
      .toEqual({ available: true, usdgOut: 0n, stockOut: 0n, sharesOut: 0n });
  });
});

/**
 * The in-kind preview's comment is the only place this repo restates the pool formula
 * `HouseVault.rollEpoch` pays withdrawals from, so it is pinned the way monitor.mjs is pinned: by
 * the contract function it was read in and by grep anchors, never by line numbers (the old `:440-455`
 * and `api-types.ts:380-387` had both drifted). A rewrite that drops book-owed term or
 * the stock leg goes red here.
 */
describe("houseInKindPreview's pool comment is pinned by contract function and anchor", () => {
  const source = readFileSync(fileURLToPath(new URL("./houseRows.ts", import.meta.url)), "utf8");
  const types = readFileSync(fileURLToPath(new URL("./api-types.ts", import.meta.url)), "utf8");

  it("names the contract function and the rollEpoch anchor it was read at", () => {
    expect(source).toContain("`rollEpoch` calls `_computeBoundary`");
    expect(source).toContain("`(uint256 usdgPool, uint256 stockPool) = _legsOf(`");
  });

  it("carries the book-owed term and both legs of the pool", () => {
    expect(source).toContain("+ orderBook.owed(vault)");
    expect(source).toContain("− (pendingDepositUsdg + owedUsdg), floored at 0");
    expect(source).toContain("− (pendingDepositStock + owedStock), floored at 0");
  });

  it("cites by anchor, not by the line numbers that drifted", () => {
    expect(source).not.toContain("rollEpoch:440-455");
    expect(source).not.toContain("api-types.ts:380-387");
    expect(types).toContain("export type HouseMarketResponse");
  });
});

/*//////////////////////////////////////////////////////////////
               -- VAULT PAGE VIEW MODELS
//////////////////////////////////////////////////////////////*/

const m6 = (raw: string) => ({ raw, decimals: 6, formatted: (Number(raw) / 1e6).toFixed(2) });
const epochWithNav = (id: string, at: number, navRaw: string, extra: Record<string, unknown> = {}): HouseEpoch => ({
  id, start: at - 604_800, end: at, resultUsdg: null,
  nav: { epoch: id, at, usdg: null, stockUnits: null, settlementPrice: m6("178420000"), navUsdg: m6(navRaw), ...extra },
});
const reads = (over: Partial<HouseVaultReads> = {}): HouseVaultReads => ({
  nav: 1_034_200n, totalSupply: 10n ** 18n, balance: 2n * 10n ** 18n, performanceFeeBps: 0, epochPerformanceFeeBps: 0, performanceFeeCeilBps: 2000,
  highWaterMark: 1_034_200n, splitter: "0x00000000000000000000000000000000000000aa", oracle: "0x00000000000000000000000000000000000000bb",
  lastSettlementPrice: 178_420_000n, limits: null, ...over,
});

describe("view models", () => {
  it("pastEpochRows carries fee, tx and supply when the wire has them, null (never 0) when it does not", () => {
    const tx = `0x${"ab".repeat(32)}`;
    const [bare, full] = pastEpochRows([
      epochWithNav("1", 1_789_156_800, "1000000"),
      epochWithNav("2", 1_789_761_600, "1010000", { supply: "1000000000000000000", performanceFee: m6("0"), tx }),
    ]);
    expect(bare).toMatchObject({ feeTakenUsdg: null, tx: null, supply: null });
    expect(full).toMatchObject({ feeTakenUsdg: 0n, tx, supply: 10n ** 18n });
  });

  it("navPoints: one per settled epoch, supply null until sent, feeTaken only on a positive fee", () => {
    const pts = navPoints([
      { id: "0", start: null, end: null, nav: null, resultUsdg: null },
      epochWithNav("1", 1, "1000000"),
      epochWithNav("2", 2, "1010000", { supply: "1000000000000000000", performanceFee: m6("5") }),
    ]);
    expect(pts.map((p) => p.epoch)).toEqual(["1", "2"]);
    expect(pts[0]!.supply).toBeNull();
    expect(pts[1]!.feeTaken).toBe(true);
    expect(lastBoundaryAt([epochWithNav("1", 5, "1"), epochWithNav("2", 9, "1")])).toBe(9);
  });

  it("markPerShare divides the boundary mark by supply and refuses an empty or unread vault", () => {
    expect(markPerShare(1_034_200n, 10n ** 18n)).toBe(1_034_200n);
    expect(markPerShare(1n, 0n)).toBeNull();
    expect(markPerShare(null, 1n)).toBeNull();
  });

  it("hero: the mark and TVL carry the boundary label; position is at the mark; no boundary yet has its own sentence", () => {
    const h = houseHeroModel(reads(), [epochWithNav("1", 1_789_156_800, "1034200")], 1_789_761_600);
    expect(h.value.text).toBe("1.0342 USDG");
    // The mark label (lib/v2/vaultCopy.ts vaultMarkLabel).
    expect(h.value.label).toContain("as of the last close, ");
    expect(h.value.label).toContain("not a live price");
    expect(h.tvl.label).toBe(h.value.label);
    expect(h.positionAtMark).toEqual({ text: "2.07 USDG", label: "at the mark" });
    const none = houseHeroModel(null, [], 1_789_761_600);
    expect(none.value.text).toBe("No boundary yet");
    expect(none.value.label).toContain("the first price is struck at");
    const unread = houseHeroModel(reads({ nav: null }), [epochWithNav("1", 1, "1")], null);
    expect(unread.value.text).toBeNull();
    expect(unread.tvl.text).toBeNull();
  });

  it("costs: fee line from reads, protocol fees from config, delay from config, null where not read", () => {
    const fees = { premiumFeeBps: 500, resaleFeeBps: 0, takerFeeFlat: m6("100000"), takerFeeCapBps: 1000, makerRebateBps: 5000,
      exerciseFeeBps: 25, mintFeePpm: 0, maxPayoutSlippageBps: null };
    const c = houseCostsModel(reads(), fees, 172_800, { burnBps: 5000, treasury: null });
    // The fee line through displayRatioPercent (lib/v2/vaultCopy.ts houseFeeLine), exact.
    expect(c.vaultFeeLine).toBe(
      "Performance fee 0% now (up to 20%), taken in USDG at each close, only on gains above the vault's previous high.",
    );
    expect(c.protocol.map((r) => r.value)).toEqual(["5.00 %", "0.10 USDG, capped at 10.00 % of premium", "0.25 %", "50.00 % of the taker fee back"]);
    expect(c.feeDelaySentence).toBe("Fee changes wait 48 h after being scheduled.");
    // The route line through displayRatioPercent (lib/v2/vaultCopy.ts feeRouteLine), exact.
    expect(c.feeRoute).toBe("Fees are split 50% to buy and burn STONKHOUSE, 50% to the treasury.");
    const blank = houseCostsModel(null, null, null, null);
    expect(blank.vaultFeeLine).toBeNull();
    // The fee shown is the rate IN FORCE (epochPerformanceFeeBps). A rise the treasury has only staged
    // (performanceFeeBps) is charged from the next epoch, so it is not the fee "now".
    const staged = houseCostsModel(reads({ performanceFeeBps: 1_500, epochPerformanceFeeBps: 1_000 }), null, null, null);
    expect(staged.rateBps).toBe(1_000);
    expect(staged.vaultFeeLine).toMatch(/^Performance fee 10% now \(up to 20%\)/);
    // (ADDITION 3): the staged rate is still shown, as the rate from the next epoch; an unchanged one is not.
    expect(staged.vaultFeeLine).toMatch(/ It changes to 15% from the next epoch\.$/);
    expect(houseCostsModel(reads({ performanceFeeBps: 1_000, epochPerformanceFeeBps: 1_000 }), null, null, null).vaultFeeLine)
      .not.toMatch(/next epoch/);
    expect(houseCostsModel(reads({ performanceFeeBps: 1_500, epochPerformanceFeeBps: null }), null, null, null).vaultFeeLine)
      .toBeNull(); // an unread in-force rate is unknown, never the staged one
    expect(blank.protocol.every((r) => r.value === null)).toBe(true);
    expect(blank.feeRoute).toBeNull();
  });

  it("proof: the vault, splitter, oracle and last boundary tx; unread rows carry null", () => {
    const tx = `0x${"cd".repeat(32)}`;
    const rows = houseProofRows("0x0000000000000000000000000000000000000066", reads(), "0x0000000000000000000000000000000000000011",
      { burnBps: 5000, treasury: null }, [epochWithNav("1", 1_789_156_800, "1", { tx })]);
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(by["Fee splitter"]!.note).toBe("burnBps 5000");
    expect(by["Last boundary"]!.value).toBe(tx);
    expect(houseProofRows(null, null, null, null, []).find((r) => r.label === "Oracle")!.value).toBeNull();
  });
});

/*//////////////////////////////////////////////////////////////
          -- usdgText NEVER ASKS Intl FOR min > max
//////////////////////////////////////////////////////////////*/

describe("usdgText and the Quoter limits row", () => {
  const limits = {
    maxSeriesUnits: 50n, maxTotalNotional: 250_000_000_000n, askToleranceBps: 200, maxBidBpsOfSpot: 9500,
    maxOrderLifetime: 3600, maxDailyOutflow: 0n,
  };

  it.each([
    [0, "1,234,568 USDG"],
    [1, "1,234,567.9 USDG"],
    [2, "1,234,567.89 USDG"],
    [4, "1,234,567.8912 USDG"],
  ])("maximumFractionDigits %i renders %s and does not throw", (max, text) => {
    expect(usdgText(1_234_567_891_234n, max)).toBe(text);
  });

  it("keeps two places whenever the caller allows two, and no more places than the caller allows", () => {
    expect(usdgText(1_500_000n, 4)).toBe("1.50 USDG");
    expect(usdgText(2_000_000n, 2)).toBe("2.00 USDG");
    expect(usdgText(2_000_000n, 1)).toBe("2.0 USDG");
    expect(usdgText(2_000_000n, 0)).toBe("2 USDG");
  });

  it("builds the proof rows with the vault's limits read, and the limits row shows whole USDG", () => {
    const build = () => houseProofRows("0x0000000000000000000000000000000000000066", reads({ limits }), null, null, []);
    expect(build).not.toThrow();
    const row = build().find((r) => r.label === "Quoter limits")!;
    expect(row.note).toBe("maxSeriesUnits 50 · maxTotalNotional 250,000 USDG · askTolerance 2.00 % · maxBid 95.00 % of spot");
  });

  it("every other caller renders as before: 4 dp value and high-water mark, 2 dp TVL and position", () => {
    const h = houseHeroModel(reads({ limits }), [epochWithNav("1", 1_789_156_800, "1034200")], 1_789_761_600);
    expect(h.value.text).toBe("1.0342 USDG");
    expect(h.tvl.text).toBe("1.03 USDG");
    expect(h.positionAtMark!.text).toBe("2.07 USDG");
    expect(houseCostsModel(reads({ limits }), null, null, null).highWaterMark).toBe("1.0342 USDG / share");
  });
});

// Boundary labels follow the reader's zone when one is passed; omitted, New York as before.
describe("house boundary labels with the reader's zone", () => {
  const END = Date.UTC(2026, 8, 25, 20, 0, 0) / 1000; // Fri 4:00 PM EDT
  it("countdown, past rows and the hero label use the reader's time with ET beside it", () => {
    const current = epoch({ id: "9", end: END });
    expect(houseCountdown(END - 3_600, current, "America/Los_Angeles")!.boundaryLabel).toBe("Sep 25, 1:00 PM PDT (4:00 PM ET)");
    expect(pastEpochRows([epoch({ id: "8", start: END - 604_800, end: END })], "America/Los_Angeles")[0]!.endLabel)
      .toBe("Sep 25, 1:00 PM PDT (4:00 PM ET)");
    expect(houseHeroModel(null, [], END, "America/Los_Angeles").value.label)
      .toBe("No boundary yet — the first price is struck at Sep 25, 1:00 PM PDT (4:00 PM ET).");
  });

  it("a New York reader sees the time once", () => {
    expect(houseCountdown(END - 3_600, epoch({ id: "9", end: END }), "America/New_York")!.boundaryLabel).toBe("Sep 25, 4:00 PM EDT");
  });
});
