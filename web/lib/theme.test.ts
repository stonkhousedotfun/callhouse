import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  applyTheme, contrastRatio, otherTheme, parseTheme, readStoredTheme, resolveTheme, storeTheme, THEME_INIT_SCRIPT,
  THEME_STORAGE_KEY, toggleLabel, type Theme,
} from "./theme";

const memory = (initial: Record<string, string> = {}) => {
  const m = new Map(Object.entries(initial));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
};
const throwing = { getItem: () => { throw new Error("SecurityError"); }, setItem: () => { throw new Error("QuotaExceededError"); } };

describe("theme resolve and store", () => {
  it("a stored night or day wins over the system", () => {
    expect(resolveTheme(readStoredTheme(memory({ [THEME_STORAGE_KEY]: "night" })), false)).toBe("night");
    expect(resolveTheme(readStoredTheme(memory({ [THEME_STORAGE_KEY]: "day" })), true)).toBe("day");
  });
  it("nothing stored (or junk stored) follows the system", () => {
    expect(resolveTheme(readStoredTheme(memory()), true)).toBe("night");
    expect(resolveTheme(readStoredTheme(memory()), false)).toBe("day");
    expect(readStoredTheme(memory({ [THEME_STORAGE_KEY]: "dark" }))).toBeNull();
    expect(parseTheme("NIGHT")).toBeNull();
  });
  it("storage that throws falls back to the system and never throws itself", () => {
    expect(readStoredTheme(throwing)).toBeNull();
    expect(resolveTheme(readStoredTheme(throwing), true)).toBe("night");
    expect(storeTheme("day", throwing)).toBe(false);
    expect(readStoredTheme(null)).toBeNull();
  });
  it("applyTheme switches the page even when the write is refused, and persists when it is not", () => {
    const attrs: Record<string, string> = {};
    const root = { setAttribute: (k: string, v: string) => { attrs[k] = v; } };
    expect(applyTheme("day", root, throwing)).toBe(false);
    expect(attrs["data-theme"]).toBe("day");
    const s = memory();
    expect(applyTheme("night", root, s)).toBe(true);
    expect(s.m.get(THEME_STORAGE_KEY)).toBe("night");
  });
  it("the toggle names the mode it switches to", () => {
    expect(toggleLabel("night")).toBe("Switch to day mode");
    expect(toggleLabel("day")).toBe("Switch to night mode");
    expect(otherTheme("night")).toBe("day");
  });
});

/** The pre-paint script is a string; it is EXECUTED here against a fake page so it cannot disagree with resolveTheme. */
describe("THEME_INIT_SCRIPT", () => {
  const run = (stored: string | null | "throw", systemDark: boolean | "throw") => {
    const attrs: Record<string, string> = {};
    const localStorage = stored === "throw" ? throwing : memory(stored === null ? {} : { [THEME_STORAGE_KEY]: stored });
    const window = { matchMedia: () => { if (systemDark === "throw") throw new Error("no matchMedia"); return { matches: systemDark }; } };
    const document = { documentElement: { setAttribute: (k: string, v: string) => { attrs[k] = v; } } };
    new Function("document", "window", "localStorage", THEME_INIT_SCRIPT)(document, window, localStorage);
    return attrs["data-theme"] ?? null;
  };
  it("agrees with resolveTheme for every stored value and system setting", () => {
    for (const stored of ["night", "day", null, "junk"] as const) {
      for (const dark of [true, false]) {
        expect(run(stored, dark)).toBe(resolveTheme(parseTheme(stored), dark));
      }
    }
  });
  it("storage throwing falls back to the system; both failing leaves the attribute unset for the CSS fallback", () => {
    expect(run("throw", true)).toBe("night");
    expect(run("throw", false)).toBe("day");
    expect(run("throw", "throw")).toBeNull();
  });
  it("uses the shared key", () => {
    expect(THEME_INIT_SCRIPT).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });
});

/*//////////////////////////////////////////////////////////////
                    globals.css GUARDS
//////////////////////////////////////////////////////////////*/

const css = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8");
/** The declarations of the FIRST rule whose selector text is exactly `selector` followed by " {". */
const rule = (selector: string, from = 0): Record<string, string> => {
  const at = css.indexOf(`${selector} {`, from);
  expect(at, `rule ${selector} not found`).toBeGreaterThan(-1);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)].map((m) => [m[1]!, m[2]!.trim()]));
};
const day = rule(':root,\n:root[data-theme="day"]');
const nightExplicit = rule(':root[data-theme="night"]');
const nightFallback = rule(':root:not([data-theme="day"])');

describe("globals.css tokens", () => {
  it("the two NIGHT copies (system fallback and explicit) are identical", () => {
    expect(nightFallback).toEqual(nightExplicit);
  });

  it("night and day define the same token names, and keep every Daylight name", () => {
    expect(Object.keys(nightExplicit).sort()).toEqual(Object.keys(day).sort());
    for (const name of ["ground", "surface", "surface-2", "ink", "ink-2", "ink-3", "line", "line-2", "accent", "accent-hover",
      "accent-ink", "accent-soft", "accent-text", "usdg", "usdg-soft", "warn", "warn-soft", "danger", "elevation-lift", "elevation-soft"])
      expect(day, `--${name} missing`).toHaveProperty(name);
    for (const name of ["field", "danger-text", "danger-soft", "select-bg", "select-ink", "inverse-bg", "inverse-ink", "row-selected"])
      expect(day, `new token --${name} missing`).toHaveProperty(name);
  });

  it("pins the spec's anchor values and the radii", () => {
    expect(nightExplicit).toMatchObject({ ground: "#000000", accent: "#c8ff2e", "accent-ink": "#000000", danger: "#ff5a4e" });
    expect(day).toMatchObject({ ground: "#ffffff", accent: "#0a7f55", "accent-ink": "#ffffff", danger: "#c2362b" });
    expect(nightExplicit["elevation-lift"]).toBe("none");
    const shared = rule(":root");
    expect(shared).toMatchObject({ "r-lg": "22px", "r-md": "14px", "r-sm": "10px", "r-pill": "999px" });
    expect(shared["curve-fill"]).toContain("var(--accent) 34%");
  });

  it("maps every new colour token and the pill radius into @theme inline", () => {
    for (const t of ["field", "danger-text", "danger-soft", "select-bg", "select-ink", "inverse-bg", "inverse-ink", "row-selected"])
      expect(css).toContain(`--color-${t}: var(--${t});`);
    expect(css).toContain("--radius-pill: var(--r-pill);");
    expect(css).toContain("var(--font-plus-jakarta-sans)");
    expect(css).toContain("--font-mono: var(--font-jetbrains-mono)");
  });
});

/** Spec 3.3: every text token on every ground, and each ink-on-fill pair, at least 4.5:1, in both modes. */
describe("contrast (WCAG 2.x)", () => {
  const TEXT = ["ink", "ink-2", "ink-3", "accent-text", "danger-text", "danger", "warn", "usdg", "accent"];
  const GROUNDS = ["ground", "surface", "surface-2", "field"];
  const FILLS = [["accent-ink", "accent"], ["select-ink", "select-bg"], ["inverse-ink", "inverse-bg"], ["accent-text", "accent-soft"],
    ["danger-text", "danger-soft"], ["warn", "warn-soft"], ["usdg", "usdg-soft"], ["ink", "row-selected"]] as const;
  const pairs = (t: Record<string, string>) => [
    ...TEXT.flatMap((f) => GROUNDS.map((g) => [f, g] as const)), ...FILLS,
  ].map(([f, g]) => ({ pair: `${f} on ${g}`, ratio: contrastRatio(t[f]!, t[g]!) }));

  for (const [mode, tokens] of [["day", day], ["night", nightExplicit]] as const) {
    it(`${mode}: all 44 pairs pass 4.5:1`, () => {
      const rows = pairs(tokens);
      expect(rows).toHaveLength(44);
      expect(rows.filter((r) => r.ratio < 4.5)).toEqual([]);
    });
  }
  it("matches the spec's published lowest ratios", () => {
    expect(contrastRatio(day.accent!, day.field!).toFixed(2)).toBe("4.66");
    expect(contrastRatio(nightExplicit.danger!, nightExplicit["surface-2"]!).toFixed(2)).toBe("5.66");
    expect(contrastRatio(nightExplicit["ink-3"]!, nightExplicit["surface-2"]!).toFixed(2)).toBe("6.19");
  });
  it("the formula itself: black on white is 21, a colour on itself is 1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#0a7f55", "#0a7f55")).toBe(1);
  });

  /**
   * Pairs the app screens put on the page that the 44 above do not name. Found by
   * listing every text-/bg- utility pair in the files those rows touched:
   *   ink-3 and accent-text on row-selected   the selected strike row and leaderboard row (MarketPage, WinsLeaderboard)
   *   ink and ink-2 on accent-soft            your own order row on a series page (SeriesPage)
   *   accent on accent-ink                    the "Collect payout" button inside the accent card (Portfolio)
   *   inverse-ink at 75% and 80% opacity      the chart tooltip's secondary lines (PayoffChart)
   * Opacity is composited over the fill it sits on, the way the browser does, before the ratio is taken.
   */
  const blend = (fg: string, bg: string, alpha: number) => {
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    const [f, b] = [rgb(fg), rgb(bg)];
    return `#${f.map((c, i) => Math.round(alpha * c + (1 - alpha) * b[i]!).toString(16).padStart(2, "0")).join("")}`;
  };
  const SCREEN_PAIRS = [["ink-3", "row-selected"], ["accent-text", "row-selected"], ["ink", "accent-soft"],
    ["ink-2", "accent-soft"], ["accent", "accent-ink"]] as const;
  for (const [mode, tokens] of [["day", day], ["night", nightExplicit]] as const) {
    it(`${mode}: the pairs the Neon app screens added pass 4.5:1`, () => {
      const rows = [
        ...SCREEN_PAIRS.map(([f, g]) => ({ pair: `${f} on ${g}`, ratio: contrastRatio(tokens[f]!, tokens[g]!) })),
        ...[0.75, 0.8].map((a) => ({ pair: `inverse-ink@${a} on inverse-bg`,
          ratio: contrastRatio(blend(tokens["inverse-ink"]!, tokens["inverse-bg"]!, a), tokens["inverse-bg"]!) })),
      ];
      expect(rows).toHaveLength(7);
      expect(rows.filter((r) => r.ratio < 4.5)).toEqual([]);
    });
  }
  it("blend composites like the browser: full alpha is the colour, zero alpha is the ground", () => {
    expect(blend("#ffffff", "#000000", 1)).toBe("#ffffff");
    expect(blend("#ffffff", "#000000", 0)).toBe("#000000");
    expect(blend("#ffffff", "#000000", 0.5)).toBe("#808080");
  });
});

describe("twin block markers (the marketing site copies the block verbatim)", () => {
  it("has exactly one BEGIN and one END, BEGIN first, and the app-only tail after END", () => {
    const begin = css.indexOf("/* ==== TWIN BLOCK BEGIN ==== */");
    const end = css.indexOf("/* ==== TWIN BLOCK END ==== */");
    expect(css.split("TWIN BLOCK BEGIN ====").length - 1).toBe(1);
    expect(css.split("TWIN BLOCK END ====").length - 1).toBe(1);
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    expect(css.indexOf("APP-ONLY TAIL")).toBeGreaterThan(end);
  });
});

// Type-only use so an unused-import lint cannot drop the Theme union from this file's contract.
const _t: Theme = "night";
void _t;
