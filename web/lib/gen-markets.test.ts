import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "..", "scripts", "gen-markets.mjs");
const REGISTRY = path.resolve(import.meta.dirname, "..", "..", "ops", "markets", "tier1.json");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "callhouse-gen-markets-"));
  temporaryRoots.push(root);
  const script = path.join(root, "web", "scripts", "gen-markets.mjs");
  const registry = path.join(root, "ops", "markets", "tier1.json");
  const output = path.join(root, "web", "lib", "markets.generated.ts");
  mkdirSync(path.dirname(script), { recursive: true });
  mkdirSync(path.dirname(registry), { recursive: true });
  mkdirSync(path.dirname(output), { recursive: true });
  copyFileSync(SCRIPT, script);
  copyFileSync(REGISTRY, registry);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
    });
  return { output, registry, run };
}

it("--check accepts a matching render without touching the output", () => {
  const { output, run } = fixture();
  expect(run().status).toBe(0);
  const contents = readFileSync(output, "utf8");
  const oldDate = new Date("2000-01-01T00:00:00Z");
  utimesSync(output, oldDate, oldDate);
  const mtime = statSync(output).mtimeMs;

  const check = run("--check");
  expect(check.status, `${check.stdout}${check.stderr}`).toBe(0);
  expect(check.stdout).toContain("gen-markets --check:");
  expect(readFileSync(output, "utf8")).toBe(contents);
  expect(statSync(output).mtimeMs).toBe(mtime);
  expect(existsSync(`${output}.tmp`)).toBe(false);
});

it("--check reports registry drift without replacing the generated file", () => {
  const { output, registry, run } = fixture();
  expect(run().status).toBe(0);
  const contents = readFileSync(output, "utf8");
  const source = JSON.parse(readFileSync(registry, "utf8"));
  source.generatedAt = "2030-01-01T00:00:00Z";
  writeFileSync(registry, JSON.stringify(source));

  const check = run("--check");
  expect(check.status).toBe(1);
  expect(check.stderr).toContain("missing or differs");
  expect(readFileSync(output, "utf8")).toBe(contents);
  expect(existsSync(`${output}.tmp`)).toBe(false);
});

it("--check reports a missing generated file without creating it", () => {
  const { output, run } = fixture();
  const check = run("--check");
  expect(check.status).toBe(1);
  expect(check.stderr).toContain("missing or differs");
  expect(existsSync(output)).toBe(false);
  expect(existsSync(`${output}.tmp`)).toBe(false);
});
