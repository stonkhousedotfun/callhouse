import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { formatPriceExact, formatShares, formatSignedUsdg, formatUsdgCents, group } from "./payoffFormat";

/** The formatters' import-free leaf, so the site can twin it and payoffChart.ts byte for byte. */
const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
const importSpecifiers = (text: string) => [...text.matchAll(/^\s*import\b[^;]*?from\s+"([^"]+)"/gms)].map((m) => m[1]);

describe("the leaf formatter", () => {
  it("has no imports at all, not even type-only ones", () => {
    const text = source("payoffFormat.ts");
    expect(text).not.toMatch(/^\s*import\b/m);
    expect(text).not.toMatch(/\bfrom\s+["']/);
    expect(text).not.toMatch(/\brequire\(|\bimport\(/);
  });

  it("is where payoffChart.ts gets the four formatters, and payoffChart.ts imports only its site-twinned modules", () => {
    const chart = source("payoffChart.ts");
    expect(importSpecifiers(chart).sort()).toEqual(["./impliedVol", "./payoff", "./payoffFormat"]);
    expect(chart).toMatch(/import \{ formatPriceExact, formatShares, formatSignedUsdg, formatUsdgCents \} from "\.\/payoffFormat";/);
  });

  it("defines each of the four formatters exactly once in the app, here; payoffCard and payoffReceipt re-export it", () => {
    const webRoot = fileURLToPath(new URL("../..", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".")) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name)) files.push(path);
      }
    };
    for (const dir of ["lib", "components", "app"]) walk(join(webRoot, dir));
    const definers = (fn: string) => files
      .filter((path) => new RegExp(`(function\\s+${fn}\\s*\\(|(const|let|var)\\s+${fn}\\s*=)`).test(readFileSync(path, "utf8")))
      .map((path) => path.slice(webRoot.length));
    for (const fn of ["formatShares", "formatUsdgCents", "formatSignedUsdg", "formatPriceExact"]) {
      expect(definers(fn), fn).toEqual(["lib/v2/payoffFormat.ts"]);
    }
    // Control: the scan finds a definition that lives elsewhere, so an empty answer above could not pass.
    expect(definers("formatShareQuantity")).toEqual(["lib/v2/payoffCard.ts"]);
    expect(source("payoffCard.ts")).toContain('export { formatShares };');
    expect(source("payoffReceipt.ts")).toContain('export { formatPriceExact, formatSignedUsdg, formatUsdgCents };');
  });

  it("recognises an import when one is there (control for the two checks above)", () => {
    expect(importSpecifiers('import { a } from "./x";\nimport type { B } from "./y";')).toEqual(["./x", "./y"]);
    expect('import type { B } from "./y";').toMatch(/^\s*import\b/m);
  });
});

describe("formatters (behaviour moved unchanged)", () => {
  it("groups thousands", () => {
    expect(group(0n)).toBe("0");
    expect(group(1_234_567n)).toBe("1,234,567");
  });

  it("shows contract units as shares, trailing zeros dropped", () => {
    expect(formatShares(100n)).toBe("1");
    expect(formatShares(250n)).toBe("2.5");
    expect(formatShares(1n)).toBe("0.01");
    expect(formatShares(0n)).toBe("0");
  });

  it("rounds costs up and payouts down to the cent, a loss away from zero", () => {
    expect(formatUsdgCents(1_234_567n, "up")).toBe("1.24");
    expect(formatUsdgCents(1_234_567n, "down")).toBe("1.23");
    expect(formatUsdgCents(-1_234_567n, "down")).toBe("−1.24");
    expect(formatUsdgCents(1_000_000_000_000n, "down")).toBe("1,000,000.00");
  });

  it("signs P&L, floored", () => {
    expect(formatSignedUsdg(19_900_000n)).toBe("+19.90");
    expect(formatSignedUsdg(-2_600_000n)).toBe("−2.60");
    expect(formatSignedUsdg(0n)).toBe("0.00");
  });

  it("prints a USDG-6 price exactly, with at least cents", () => {
    expect(formatPriceExact(241_000_000n)).toBe("241.00");
    expect(formatPriceExact(236_123_400n)).toBe("236.1234");
    expect(formatPriceExact(1_234_000_000n)).toBe("1,234.00");
  });
});
