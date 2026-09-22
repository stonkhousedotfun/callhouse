import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const indexerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("production card registry snapshot", () => {
  it("matches the source registry before an image can be built", () => {
    const check = spawnSync(process.execPath, ["scripts/gen-card-registry.mjs", "--check"], {
      cwd: indexerRoot, encoding: "utf8",
    });
    expect(check.status, check.stderr).toBe(0);
    expect(check.stdout).toContain("snapshot matches source");
  });

  it("projects default and per-market expiry counts", () => {
    const directory = mkdtempSync(join(tmpdir(), "stonkhouse-card-registry-test-"));
    temporary.push(directory);
    const source = join(directory, "registry.json");
    const output = join(directory, "projection.json");
    const ladder = { rungs: 5, firstOtmBps: 100, stepBps: 100, cardTargetBps: 200 };
    writeFileSync(source, JSON.stringify({
      v2: {
        fees: { takerFeeFlat: "100000", takerFeeCapBps: 1000, exerciseFeeBps: 25 },
        defaults: { ladder: { daily: ladder, weekly: ladder }, expiriesAhead: { daily: 3, weekly: 2 } },
      },
      markets: [{ ticker: "NVDA", v2: { overrides: { expiriesAhead: { daily: 1 } } } }],
    }));
    const result = spawnSync(process.execPath, ["scripts/gen-card-registry.mjs", "--registry", source,
      "--output", output], { cwd: indexerRoot, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(output, "utf8"))).toMatchObject({
      v2: { defaults: { expiriesAhead: { daily: 3, weekly: 2 } } },
      markets: [{ ticker: "NVDA", v2: { overrides: { expiriesAhead: { daily: 1 } } } }],
    });
  });
});
