// node --test scripts/check-schema.test.mjs   (from indexer/)
//
// The CLI is run as a child process with the same flags indexer/Dockerfile uses, so what passes
// here is what the build stage runs. Fixture schemas are written to a temporary directory INSIDE
// indexer/ because their `import ... from "ponder"` must resolve through indexer/node_modules, as
// the real schema's does; the directory is removed afterwards.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { CheckError, DEFAULT_ORDERING, readOrdering } from "./check-schema.mjs";

const indexerDir = fileURLToPath(new URL("..", import.meta.url));
const script = fileURLToPath(new URL("./check-schema.mjs", import.meta.url));
const realSchema = path.join(indexerDir, "ponder.schema.ts");

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(indexerDir, ".check-schema-test-"));
});
after(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function run(...args) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", script, ...args], {
    cwd: indexerDir,
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function fixture(name, source) {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, source);
  return file;
}

const minimal = (columns) => `import { onchainTable } from "ponder";
export const probe = onchainTable("probe", (t) => ({
  id: t.text().primaryKey(),
  ${columns}
}));
`;

test("the real schema passes Ponder's own buildSchema", () => {
  const r = run(indexerDir);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^schema ok: .*ponder\.schema\.ts passes ponder \d+\.\d+\.\d+ buildSchema \(ordering multichain\)/);
  assert.match(r.out, /the reserved-column canary was refused/);
  const tables = Number(r.out.match(/: (\d+) tables/)?.[1]);
  assert.ok(tables > 0, `expected a non-zero table count, got ${r.out}`);
});

test("the broken column turns the check red with Ponder's own message", () => {
  // Rebuild the schema from the real one: v2AccessOperation's `opId` column was
  // `operationId`, which Ponder snake-cases to the reserved `operation_id`.
  const source = fs.readFileSync(realSchema, "utf8");
  const table = source.indexOf('export const v2AccessOperation = onchainTable("v2_access_operation"');
  assert.ok(table >= 0, "v2AccessOperation is no longer in ponder.schema.ts; point this fixture at another table");
  const column = source.indexOf("  opId: t.hex().notNull(),", table);
  const nextTable = source.indexOf("export const ", table + 1);
  assert.ok(column > table && (nextTable < 0 || column < nextTable), "v2AccessOperation.opId not found where T-OP-197 put it");
  const broken = `${source.slice(0, column)}  operationId: t.hex().notNull(),${source.slice(column + "  opId: t.hex().notNull(),".length)}`;

  const r = run(indexerDir, "--schema", fixture("t197.schema.ts", broken));
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.match(r.err, /SCHEMA CHECK FAILED/);
  assert.match(r.err, /'v2AccessOperation\.operationId' is a reserved column name/);
});

for (const [column, reserved] of [
  ["operationId: t.hex(),", "operationId"],
  ["operation: t.text(),", "operation"],
  ["checkpoint: t.text(),", "checkpoint"],
]) {
  test(`every name Ponder reserves is refused: ${reserved}`, () => {
    const r = run(indexerDir, "--schema", fixture(`reserved-${reserved}.ts`, minimal(column)));
    assert.equal(r.code, 1, `${r.out}${r.err}`);
    assert.match(r.err, new RegExp(`'probe\\.${reserved}' is a reserved column name`));
  });
}

test("the rest of Ponder's rules run too, not only the reserved names", () => {
  const r = run(indexerDir, "--schema", fixture("unique.ts", minimal("owner: t.hex().unique(),")));
  assert.equal(r.code, 1, `${r.out}${r.err}`);
  assert.match(r.err, /'probe\.owner' has a unique constraint and unique constraints are unsupported/);
});

test("a clean minimal schema passes, so the red cases are about their columns", () => {
  const r = run(indexerDir, "--schema", fixture("clean.ts", minimal("owner: t.hex(),")));
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /: 1 tables/);
});

test("a check that cannot run exits 2, never 0", () => {
  const missing = run(indexerDir, "--schema", path.join(tmp, "absent.ts"));
  assert.equal(missing.code, 2);
  assert.match(missing.err, /SCHEMA CHECK COULD NOT RUN: no schema file/);

  const noConfig = run(tmp, "--schema", realSchema);
  assert.equal(noConfig.code, 2);
  assert.match(noConfig.err, /no ponder\.config\.ts/);

  const badArg = run(indexerDir, "--nope");
  assert.equal(badArg.code, 2);
  assert.match(badArg.err, /unknown option --nope/);
});

test("ordering: Ponder's default when unset, the literal when set, refused when unreadable", () => {
  assert.equal(DEFAULT_ORDERING, "multichain");
  assert.equal(readOrdering("export default createConfig({ chains: {} });"), "multichain");
  assert.equal(readOrdering('export default createConfig({ ordering: "experimental_isolated", chains: {} });'), "experimental_isolated");
  assert.equal(readOrdering("createConfig({\n  ordering: 'omnichain',\n})"), "omnichain");
  assert.throws(() => readOrdering("createConfig({ ordering: ORDERING })"), CheckError);
  assert.throws(() => readOrdering('createConfig({ ordering: "a", x: { ordering: "b" } })'), CheckError);
});
