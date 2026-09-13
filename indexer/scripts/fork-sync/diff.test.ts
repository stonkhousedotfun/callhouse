import { describe, expect, it } from "vitest";

import { MISSING, compare, formatMismatches, getPath, jsonEqual, parsePath, type Json } from "./diff.ts";

const body: Json = {
  cycles: [
    { cycle: 3, harvest: { premiumNet: { raw: "18125297", decimals: 6 }, harvestedAt: null } },
    { cycle: 2, harvest: { premiumNet: { raw: "0", decimals: 6 }, harvestedAt: null } },
  ],
  count: 2,
};

describe("paths", () => {
  it("parses dots and indices", () => {
    expect(parsePath("cycles[1].harvest.premiumNet.raw")).toEqual(["cycles", 1, "harvest", "premiumNet", "raw"]);
    expect(parsePath("")).toEqual([]);
  });

  it("resolves leaves, array lengths and the whole body", () => {
    expect(getPath(body, "cycles[0].harvest.premiumNet.raw")).toBe("18125297");
    expect(getPath(body, "cycles.length")).toBe(2);
    expect(getPath(body, "")).toBe(body);
  });

  it("reports a path that does not resolve as MISSING, including null-valued parents and bad indices", () => {
    expect(getPath(body, "cycles[2].cycle")).toBe(MISSING);
    expect(getPath(body, "cycles[0].harvest.harvestedAt.raw")).toBe(MISSING);
    expect(getPath(body, "cycles[0].nope")).toBe(MISSING);
    expect(getPath(body, "count.raw")).toBe(MISSING);
  });
});

describe("jsonEqual is exact", () => {
  it("does not coerce", () => {
    expect(jsonEqual("0", 0)).toBe(false);
    expect(jsonEqual(null, MISSING)).toBe(false);
    expect(jsonEqual("0xABC", "0xabc")).toBe(false);
    expect(jsonEqual([1, 2], [1, 2])).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual({ a: 1, b: [null] }, { b: [null], a: 1 })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});

describe("compare", () => {
  it("counts passes and names each mismatch with its route, path, expected and actual", () => {
    const responses = { "GET /v1/cycles": body };
    const { passed, mismatches } = compare(responses, [
      { route: "GET /v1/cycles", path: "cycles[0].harvest.premiumNet.raw", expected: "18125297" },
      { route: "GET /v1/cycles", path: "cycles[1].harvest.premiumNet.raw", expected: "1", source: "run.json" },
      { route: "GET /v1/cycles", path: "cycles.length", expected: 3 },
      { route: "GET /v1/vault", path: "live", expected: true },
    ]);
    expect(passed).toBe(1);
    expect(mismatches.map((m) => [m.route, m.path, m.actual])).toEqual([
      ["GET /v1/cycles", "cycles[1].harvest.premiumNet.raw", "0"],
      ["GET /v1/cycles", "cycles.length", 2],
      ["GET /v1/vault", "live", MISSING],
    ]);
    const text = formatMismatches(mismatches);
    expect(text).toContain('expected "1"   (run.json)');
    expect(text).toContain('actual   "0"');
    expect(text).toContain("actual   <missing>");
  });
});
