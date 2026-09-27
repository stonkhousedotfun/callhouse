import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const SCRIPT = path.resolve(import.meta.dirname, "..", "scripts", "gen-markets.mjs");
const REGISTRY = path.resolve(import.meta.dirname, "..", "..", "ops", "markets", "tier1.json");
// Since the generator imports the REAL builder (`../../ops/markets/build-markets.mjs`, for
// V2_MARKET_KEYS / V2_EXTERNAL_CONTRACT_NAMES: one key list, never a copy), so the temp root must carry that
// module at the same relative path or every spawn dies ERR_MODULE_NOT_FOUND before it reads a byte -- which is
// how 7 of these 8 cases were red at the tip while the generator itself was fine. The builder is COPIED from the
// checkout, never stubbed: a hand-written stand-in exporting a shorter key list would pass every case here and
// prove nothing about the file the app is generated from (the lesson). It imports only node builtins
// (checked below), so nothing under node_modules is copied or linked.
const BUILDER = path.resolve(import.meta.dirname, "..", "..", "ops", "markets", "build-markets.mjs");
const REPO = path.resolve(import.meta.dirname, "..", "..");
const temporaryRoots: string[] = [];

/** Every static import / re-export specifier in a module, single- or multi-line, including bare `import "x";`. */
function moduleSpecifiers(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/^(?:import|export)\s(?:[^;]*?\sfrom\s)?\s*"([^"]+)";/gm)].map((m) => m[1]!);
}

// The builder stopped being one file when it began to import ./route-liquidity.mjs: a root carrying
// build-markets.mjs alone died ERR_MODULE_NOT_FOUND on every spawn, and 8 cases here were once red with the
// generator fine -- the shape again, one module further down. So the copy set is the builder's
// relative-import closure, read from the sources rather than listed: the next sibling it imports is carried with no
// edit here. Builder first.
function builderClosure(): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of moduleSpecifiers(file)) if (spec.startsWith(".")) visit(path.resolve(path.dirname(file), spec));
  };
  visit(BUILDER);
  return [...seen];
}
const BUILDER_CLOSURE = builderClosure();

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

function fixture({ omit }: { omit?: string } = {}) {
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
  // `omit` is the positive control below: a root WITHOUT one module of the closure is what was red.
  for (const file of BUILDER_CLOSURE) {
    if (file === omit) continue;
    const copy = path.join(root, path.relative(REPO, file));
    mkdirSync(path.dirname(copy), { recursive: true });
    copyFileSync(file, copy);
  }
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

it("carries markets[].v2.house into every row and refuses a malformed one", () => {
  // Every market's v2 block has { weekly, daily }. The generator accepted the key (assertExactKeys) and then
  // left it out of the row it returned, so lib/markets.generated.ts dropped it while --check agreed with itself.
  const plain = fixture();
  const rows = (JSON.parse(readFileSync(plain.registry, "utf8")) as FixtureRegistry).markets.length;
  expect(plain.run().status).toBe(0);
  expect(readFileSync(plain.output, "utf8").match(/^ {6}house: \{$/gm)?.length).toBe(rows);

  const daily = `0x${"a".repeat(40)}`;
  const projected = fixture();
  mutateRegistry(projected.registry, (source) => { source.markets[0]!.v2.house = { weekly: null, daily }; });
  const accepted = projected.run();
  expect(accepted.status, `${accepted.stdout}${accepted.stderr}`).toBe(0);
  expect(readFileSync(projected.output, "utf8")).toContain(`daily: "${daily}",`);

  const refused: Array<[unknown, string]> = [
    [null, ".house is not an object"],
    [{ weekly: null }, "keys differ from the v8 registry schema"],
    [{ weekly: null, daily: null, monthly: null }, "keys differ from the v8 registry schema"],
    [{ weekly: null, daily: "0x1234" }, ".house.daily is neither null nor an address"],
    [{ weekly: 7, daily: null }, ".house.weekly is neither null nor an address"],
  ];
  for (const [house, message] of refused) {
    const { output, registry, run } = fixture();
    mutateRegistry(registry, (source) => { source.markets[0]!.v2.house = house; });
    const result = run();
    expect(result.status, JSON.stringify(house)).toBe(1);
    expect(result.stderr, JSON.stringify(house)).toContain(message);
    expect(existsSync(output), JSON.stringify(house)).toBe(false);
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

it("the fixture carries the real builder module and its import closure; without any of it the generator cannot even start", () => {
  // Every carried module imports only node builtins or another carried module, so the copy is self-contained (no
  // node_modules in the root). A bare package import anywhere in the closure fails here, by name.
  expect(BUILDER_CLOSURE[0]).toBe(BUILDER);
  expect(moduleSpecifiers(BUILDER).length).toBeGreaterThan(0);
  for (const file of BUILDER_CLOSURE) {
    for (const spec of moduleSpecifiers(file)) {
      if (spec.startsWith("node:")) continue;
      const where = `${path.relative(REPO, file)} imports ${spec}`;
      expect(spec.startsWith("."), where).toBe(true);
      expect(BUILDER_CLOSURE, where).toContain(path.resolve(path.dirname(file), spec));
    }
  }

  // With the whole closure: the generator runs (the cases above prove what it does with the registry).
  const ok = fixture();
  const good = ok.run("--check");
  expect(good.stderr).not.toContain("ERR_MODULE_NOT_FOUND");

  // Without it: ERR_MODULE_NOT_FOUND naming the builder, before any registry byte is read -- the shape that hid
  // seven red cases behind a spawn that died on import.
  const bare = fixture({ omit: BUILDER });
  const dead = bare.run("--check");
  expect(dead.status).not.toBe(0);
  expect(dead.stderr).toContain("ERR_MODULE_NOT_FOUND");
  expect(dead.stderr).toContain("ops/markets/build-markets.mjs");

  // Without one of the builder's own imports: the shape, the builder present and a module it needs absent.
  for (const sibling of BUILDER_CLOSURE.slice(1)) {
    const partial = fixture({ omit: sibling });
    const died = partial.run("--check");
    expect(died.status, sibling).not.toBe(0);
    expect(died.stderr, sibling).toContain("ERR_MODULE_NOT_FOUND");
    expect(died.stderr, sibling).toContain(path.relative(REPO, sibling));
  }
});
