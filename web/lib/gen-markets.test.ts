import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "..", "scripts", "gen-markets.mjs");
const REGISTRY = path.resolve(import.meta.dirname, "..", "..", "ops", "markets", "tier1.json");
// T-OP-170. Since T-OP-138 the generator imports the REAL builder (`../../ops/markets/build-markets.mjs`, for
// V2_MARKET_KEYS / V2_EXTERNAL_CONTRACT_NAMES: one key list, never a copy), so the temp root must carry that
// module at the same relative path or every spawn dies ERR_MODULE_NOT_FOUND before it reads a byte -- which is
// how 7 of these 8 cases were red at the tip while the generator itself was fine. The builder is COPIED from the
// checkout, never stubbed: a hand-written stand-in exporting a shorter key list would pass every case here and
// prove nothing about the file the app is generated from (the T-OP-123 lesson). It imports only node builtins
// (checked below), so nothing under node_modules is copied or linked.
const BUILDER = path.resolve(import.meta.dirname, "..", "..", "ops", "markets", "build-markets.mjs");
const temporaryRoots: string[] = [];

type FixtureRegistry = {
  v2: {
    contracts: Record<string, unknown> & { sources: Record<string, unknown> };
    fees: Record<string, unknown>;
  };
  markets: Array<{ v2: Record<string, unknown> }>;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture({ withBuilder = true }: { withBuilder?: boolean } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "callhouse-gen-markets-"));
  temporaryRoots.push(root);
  const script = path.join(root, "web", "scripts", "gen-markets.mjs");
  const registry = path.join(root, "ops", "markets", "tier1.json");
  const builder = path.join(root, "ops", "markets", "build-markets.mjs");
  const output = path.join(root, "web", "lib", "markets.generated.ts");
  mkdirSync(path.dirname(script), { recursive: true });
  mkdirSync(path.dirname(registry), { recursive: true });
  mkdirSync(path.dirname(output), { recursive: true });
  copyFileSync(SCRIPT, script);
  copyFileSync(REGISTRY, registry);
  // `withBuilder: false` is the positive control below: the fixture WITHOUT the module is what was red.
  if (withBuilder) copyFileSync(BUILDER, builder);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
    });
  return { output, registry, run };
}

function mutateRegistry(file: string, mutate: (source: FixtureRegistry) => void) {
  const source = JSON.parse(readFileSync(file, "utf8")) as FixtureRegistry;
  mutate(source);
  writeFileSync(file, JSON.stringify(source));
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

it("rejects unknown or missing keys in the v8 contract, source and market blocks", () => {
  const mutations: Array<(source: FixtureRegistry) => void> = [
    (source) => { source.v2.contracts.unknownContract = null; },
    (source) => { delete source.v2.contracts.accessManager; },
    (source) => { source.v2.contracts.sources.unknownSource = null; },
    (source) => { delete source.v2.contracts.sources.dataStreams; },
    (source) => { source.markets[0]!.v2.unknownMarketField = null; },
    (source) => { delete source.markets[0]!.v2.payoutRoute; },
  ];
  for (const mutate of mutations) {
    const { registry, run } = fixture();
    mutateRegistry(registry, mutate);
    const result = run();
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
    expect(result.stderr).toContain("keys differ from the v8 registry schema");
  }
});

it.each([
  { venue: "v3", fee: 3_000 },
  { venue: "v4", fee: 3_000, tickSpacing: 60, poolId: `0x${"1".repeat(64)}` },
])("accepts and projects a valid $venue payout route", (route) => {
  const { output, registry, run } = fixture();
  mutateRegistry(registry, (source) => { source.markets[0]!.v2.payoutRoute = route; });
  const result = run();
  expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  expect(readFileSync(output, "utf8")).toContain(`venue: "${route.venue}"`);
});

it("rejects a payout route with a bad venue, shape, fee, spacing or pool id", () => {
  const routes: unknown[] = [
    { venue: "v2", fee: 3_000 },
    { venue: "v3", fee: 0 },
    { venue: "v3", fee: 3_000, poolId: `0x${"1".repeat(64)}` },
    { venue: "v4", fee: 3_000, tickSpacing: 0, poolId: `0x${"1".repeat(64)}` },
    { venue: "v4", fee: 3_000, tickSpacing: 60, poolId: "0x1234" },
  ];
  for (const route of routes) {
    const { registry, run } = fixture();
    mutateRegistry(registry, (source) => { source.markets[0]!.v2.payoutRoute = route; });
    const result = run();
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(1);
  }
});

it("requires zero shared and market rent unless allowRent explicitly opts in", () => {
  const shared = fixture();
  mutateRegistry(shared.registry, (source) => { source.v2.fees.mintFeePpm = 1; });
  expect(shared.run().status).toBe(1);

  const market = fixture();
  mutateRegistry(market.registry, (source) => { source.markets[0]!.v2.mintFeePpm = 1; });
  expect(market.run().status).toBe(1);

  const optedIn = fixture();
  mutateRegistry(optedIn.registry, (source) => {
    source.v2.fees.allowRent = true;
    source.v2.fees.mintFeePpm = 5_000;
    source.markets[0]!.v2.mintFeePpm = 5_000;
  });
  const accepted = optedIn.run();
  expect(accepted.status, `${accepted.stdout}${accepted.stderr}`).toBe(0);

  const aboveCeiling = fixture();
  mutateRegistry(aboveCeiling.registry, (source) => {
    source.v2.fees.allowRent = true;
    source.markets[0]!.v2.mintFeePpm = 5_001;
  });
  expect(aboveCeiling.run().status).toBe(1);
});

it("T-OP-170: the fixture carries the real builder module; without it the generator cannot even start", () => {
  // The builder's own imports are node builtins only, so the copy is self-contained (no node_modules in the root).
  const source = readFileSync(BUILDER, "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  expect(imports.length).toBeGreaterThan(0);
  expect(imports.every((s) => s.startsWith("node:"))).toBe(true);

  // With the builder: the generator runs (the eight cases above prove what it does with the registry).
  const ok = fixture();
  const good = ok.run("--check");
  expect(good.stderr).not.toContain("ERR_MODULE_NOT_FOUND");

  // Without it: ERR_MODULE_NOT_FOUND naming the builder, before any registry byte is read -- the shape that hid
  // seven red cases behind a spawn that died on import.
  const bare = fixture({ withBuilder: false });
  const dead = bare.run("--check");
  expect(dead.status).not.toBe(0);
  expect(dead.stderr).toContain("ERR_MODULE_NOT_FOUND");
  expect(dead.stderr).toContain("ops/markets/build-markets.mjs");
});
