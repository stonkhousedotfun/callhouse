import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { keeperPricingFigures, type KeeperPricingFigures } from "@/lib/cycleTerms";

import {
  VOL_REASON_WORDS,
  askWords,
  chainTimeLabel,
  fairValueLabel,
  modeWords,
  pricingSourceNote,
  unavailableWords,
  type CyclePricingFeed,
} from "./CyclePricingWords";

/**
 * The words around the keeper's pricing report. Records are built from the keeper/README.md sample
 * (as lib/cycleTerms.test.ts uses it) and parsed by the real keeperPricingFigures, so each case is
 * one the page can actually receive.
 */

const FRESH = {
  mode: "vol", source: "cboe-delayed", priceSource: "vol-fair", volPath: "fresh",
  volUnavailableReason: null, targetDelta: 0.15, deltaAtStrike: 0.1464, ivAtStrike: 0.3266,
  strikeUsdg6: "225000000", deltaStrikeUsdg6: "225000000", strikeClamped: null, bandBufferBps: 50,
  fairUnit6: "860864", volUnit6: "946951", floorUnit6: "848840", marginUnit6: "857329",
  unitPrice6: "946951", edgeBps: 1000, marginBps: 100,
  shareSpot: 212.0404, spotUsdg6: "212210000",
  expiry: "2026-09-25", chainTimestamp: "2026-09-15 05:57:42", lastTradeTime: "2026-09-14T15:59:59",
};

/** Fresh market data was not usable: the previous listing's fair value, and no chain figures. */
const PREVIOUS = {
  ...FRESH,
  priceSource: "vol-previous-fair", volPath: "previous-fair", volUnavailableReason: "vol-stale",
  deltaAtStrike: null, ivAtStrike: null, shareSpot: null, expiry: null, chainTimestamp: null, lastTradeTime: null,
};

/** ceil(779390 × 1.1) = 857329 = the floor plus margin exactly: the keeper picks fill-floor at equality. */
const AT_EQUALITY = { fairUnit6: "779390", volUnit6: "857329", unitPrice6: "857329", priceSource: "fill-floor" };

function parsed(input: unknown): KeeperPricingFigures {
  const f = keeperPricingFigures(input);
  expect(f, JSON.stringify(input)).not.toBeNull();
  return f!;
}

function allWords(f: KeeperPricingFigures): string[] {
  return [modeWords(f), askWords(f), chainTimeLabel(f), pricingSourceNote(f), fairValueLabel(f)];
}

describe("CyclePricingWords: reason codes are never echoed", () => {
  it("a known code is printed in the page's words", () => {
    const ask = askWords(parsed(PREVIOUS));
    expect(ask).toBe(
      "The previous listing's fair value plus the keeper's edge, which was above the vault floor plus margin; fresh market data was not usable (the quotes were too old)",
    );
    expect(ask).not.toContain("vol-stale");
  });

  it("every keeper code in keeper/src has words", () => {
    const keeperSources = ["../../keeper/src/vol.ts", "../../keeper/src/policy.ts"]
      .map((rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"))
      .join("\n");
    const codes = new Set([...keeperSources.matchAll(/reason: '(vol-[a-z-]+)'/g)].map((m) => m[1]!));
    expect(codes.size).toBeGreaterThan(0);
    for (const code of codes) expect(Object.hasOwn(VOL_REASON_WORDS, code), code).toBe(true);
  });

  it.each([
    // Assembled at runtime, a habit from when copy-lint scanned this file (removed 2026-09-21).
    ["an unknown code", ["guar" + "anteed", "40", "a" + "py", "yield"].join("-")],
    ["an Object.prototype key", "constructor"],
  ])("%s is dropped", (_name, code) => {
    const f = parsed({ ...PREVIOUS, volUnavailableReason: code });
    expect(f.volUnavailableReason).toBe(code);
    const ask = askWords(f);
    expect(ask).toBe("The previous listing's fair value plus the keeper's edge, which was above the vault floor plus margin; fresh market data was not usable");
    expect(ask).not.toContain(code);
  });
});

describe("CyclePricingWords: Cboe is named only for Cboe's source", () => {
  it("cboe-delayed", () => {
    const f = parsed(FRESH);
    expect(modeWords(f)).toBe("vol · strike at a target delta on Cboe's delayed NVDA option chain");
    expect(chainTimeLabel(f)).toBe("Cboe data time");
    expect(pricingSourceNote(f)).toBe("The market figures come from Cboe's delayed quotes, so they lag the market.");
  });

  it("another source", () => {
    const f = parsed({ ...FRESH, source: "someother-feed", chainTimestamp: "2026-09-14 15:00:00" });
    expect(f.chainTime?.ts).toBeUndefined();
    for (const words of allWords(f)) expect(words).not.toMatch(/cboe/i);
    expect(chainTimeLabel(f)).toBe("Market data time");
  });
});

describe("CyclePricingWords: what set the ask", () => {
  it("fill-floor at equality with the market figure says at or above", () => {
    const f = parsed({ ...FRESH, ...AT_EQUALITY });
    expect(f.volUnit6).toBe(f.marginUnit6);
    expect(askWords(f)).toBe("The vault floor plus the keeper's margin, which was at or above the market fair value plus edge");
  });

  it("fill-floor on the previous listing's fair value does not call it a market figure", () => {
    const f = parsed({ ...PREVIOUS, ...AT_EQUALITY });
    expect(f.priceSource).toBe("fill-floor");
    expect(f.volPath).toBe("previous-fair");
    expect(askWords(f)).toBe(
      "The vault floor plus the keeper's margin, which was at or above the previous listing's fair value plus edge; fresh market data was not usable (the quotes were too old)",
    );
    expect(fairValueLabel(f)).toBe("Previous listing's fair value per contract");
    expect(pricingSourceNote(f)).not.toMatch(/delayed quotes/);
    for (const words of allWords(f)) expect(words).not.toMatch(/market fair value/i);
  });

  it("fresh vol-fair and fixed mode", () => {
    expect(askWords(parsed(FRESH))).toBe("The market fair value plus the keeper's edge, which was above the vault floor plus margin");
    expect(fairValueLabel(parsed(FRESH))).toBe("Market fair value per contract");
    const fixed = parsed({
      ...PREVIOUS,
      mode: "fixed", source: null, priceSource: "fill-floor", volPath: null, volUnavailableReason: null,
      targetDelta: null, edgeBps: null, fairUnit6: null, volUnit6: null, unitPrice6: "857329",
    });
    expect(askWords(fixed)).toBe("The vault floor plus the keeper's margin");
    expect(modeWords(fixed)).toBe("fixed · strike a set distance above spot, ask at the vault floor plus margin");
    expect(pricingSourceNote(fixed)).toBe("In fixed mode no market data is used.");
  });
});

describe("CyclePricingWords: the unavailable line says why", () => {
  it.each([
    ["loading", "Reading the keeper's pricing report…"],
    ["order-finished", "Seaport reports this order sold out or cancelled, so the order feed is not read and there is no pricing report to show."],
    ["unread", "The order feed could not be read, so the keeper's pricing report is not shown."],
    ["not-served", "The order feed is not serving the vault's order, so there is no pricing report to show."],
  ] as const)("%s", (feed: CyclePricingFeed, line) => {
    expect(unavailableWords(false, feed)).toBe(line);
    expect(unavailableWords(true, feed)).toBe("The keeper sent no pricing report with this order that could be read.");
  });
});

describe("CyclePricingWords: copy", () => {
  it("no return, profit, per-year or percentage framing in any sentence", () => {
    const records = [FRESH, PREVIOUS, { ...FRESH, ...AT_EQUALITY }, { ...PREVIOUS, ...AT_EQUALITY }, { ...FRESH, source: "other" }];
    const sentences = [
      ...records.flatMap((r) => allWords(parsed(r))),
      ...Object.values(VOL_REASON_WORDS),
      ...(["loading", "order-finished", "unread", "not-served"] as const).map((s) => unavailableWords(false, s)),
    ];
    const framing = [/\byield/i, /\breturns?\b/i, /\bprofit/i, /\bearn/i, /\bgain/i, /\bincome/i, /\bannual/i, /per\s+year/i, /%/, /\bprojected/i, /\bguarantee/i];
    for (const s of sentences) for (const re of framing) expect(re.test(s), `${JSON.stringify(s)} vs ${re}`).toBe(false);
  });
});
