import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const indexerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("production card registry snapshot", () => {
  it("matches the source registry before an image can be built", () => {
    const check = spawnSync(process.execPath, ["scripts/gen-card-registry.mjs", "--check"], {
      cwd: indexerRoot, encoding: "utf8",
    });
    expect(check.status, check.stderr).toBe(0);
    expect(check.stdout).toContain("snapshot matches source");
  });
});
