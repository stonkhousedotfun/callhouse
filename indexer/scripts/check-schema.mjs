#!/usr/bin/env node
// Build the indexer's Ponder schema the way `ponder start` builds it, and fail if Ponder would
// refuse it. indexer/Dockerfile runs this in its build stage, so a schema Ponder refuses never
// becomes an image.
//
//   node --experimental-strip-types scripts/check-schema.mjs [indexer-dir] [--schema <file>]
//
//   indexer-dir   the directory holding ponder.config.ts and ponder.schema.ts (default: cwd).
//                 The Dockerfile passes /out, the tree `pnpm deploy` produced, so the check runs
//                 against the files and the Ponder the image ships.
//   --schema      validate this schema file instead of <indexer-dir>/ponder.schema.ts (tests).
//
// WHY. Ponder validates the schema only when `ponder start` or `ponder dev` builds it:
// reserved column names, serial columns, unique/foreign-key/check constraints, duplicate names.
// A change shipped `v2AccessOperation.operationId`, whose snake-cased name `operation_id` Ponder
// reserves, and the indexer could not boot. Nothing before boot saw it: CI runs typecheck and
// tests only, and `ponder codegen` does not build the schema at all (it exits 0 on the broken
// schema; a change measured that). Adding codegen to CI would therefore prove nothing.
//
// HOW. This does not re-implement Ponder's rules, which would drift the first time Ponder adds
// one. It imports the schema module (Node strips the types) and hands its exports to the
// installed Ponder's own `buildSchema` (dist/esm/build/schema.js), the function `ponder start`
// calls through `safeBuildSchema` at its "schema" build stage. Ponder is resolved from the
// schema file's own node_modules, the same way the schema's `import ... from "ponder"` resolves,
// so the schema and the validator share one drizzle-orm instance; Ponder's `instanceof` checks
// depend on that.
//
// Before a pass counts, the validator is given a table with a reserved column and must refuse
// it. A validator that cannot fail proves nothing.
//
// EXIT: 0 Ponder accepts the schema · 1 Ponder refuses it · 2 the check could not run. Both
// non-zero codes stop the Docker build.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Ponder's default when ponder.config.ts sets no `ordering` (dist/esm/build/pre.js:
// `ordering: config.ordering ?? "multichain"`).
export const DEFAULT_ORDERING = "multichain";

/** The check itself could not run. Exit 2, never a pass. */
export class CheckError extends Error {}

/** Ponder refused the schema. Exit 1. */
export class SchemaError extends Error {}

/**
 * The `ordering` ponder.config.ts sets, or Ponder's default. `buildSchema` applies extra rules
 * under "experimental_isolated" (a chainId column in every primary key), so validating with the
 * wrong ordering would under-check. A value this cannot read as a string literal is refused
 * rather than guessed.
 */
export function readOrdering(configSource) {
  const matches = [...configSource.matchAll(/\bordering\s*:\s*([^,}\n]+)/g)];
  if (matches.length === 0) return DEFAULT_ORDERING;
  if (matches.length > 1) {
    throw new CheckError("ponder.config.ts names `ordering` more than once; cannot tell which one Ponder uses");
  }
  const literal = matches[0][1].trim().match(/^(["'])([A-Za-z_]+)\1$/);
  if (!literal) {
    throw new CheckError(
      `ponder.config.ts sets ordering to ${matches[0][1].trim()}, not a string literal; ` +
        "teach scripts/check-schema.mjs to read it rather than validating with a guess",
    );
  }
  return literal[2];
}

/**
 * The installed Ponder, found the way Node resolves the schema's `import ... from "ponder"`:
 * the nearest node_modules/ponder walking up from `fromDir`, symlinks followed.
 */
export function findPonder(fromDir) {
  for (let dir = path.resolve(fromDir); ; dir = path.dirname(dir)) {
    const pkgFile = path.join(dir, "node_modules", "ponder", "package.json");
    if (fs.existsSync(pkgFile)) {
      const pkgDir = fs.realpathSync(path.dirname(pkgFile));
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
      const entryRel = pkg.exports?.["."]?.import;
      if (typeof entryRel !== "string") {
        throw new CheckError(`ponder ${pkg.version} at ${pkgDir} has no exports["."].import; its layout changed`);
      }
      const entry = path.join(pkgDir, entryRel);
      const validator = path.join(path.dirname(entry), "build", "schema.js");
      for (const file of [entry, validator]) {
        if (!fs.existsSync(file)) {
          throw new CheckError(
            `ponder ${pkg.version} has no ${path.relative(pkgDir, file)}; its layout changed. ` +
              "Point this check at the new location of buildSchema; do not delete the check",
          );
        }
      }
      return { dir: pkgDir, version: pkg.version, entry, validator };
    }
    if (path.dirname(dir) === dir) {
      throw new CheckError(`no node_modules/ponder above ${fromDir}; install (or pnpm deploy) the indexer first`);
    }
  }
}

async function importFile(file, what) {
  try {
    return await import(pathToFileURL(file).href);
  } catch (error) {
    const hint =
      error?.code === "ERR_UNKNOWN_FILE_EXTENSION"
        ? " (run node with --experimental-strip-types so it can load TypeScript)"
        : "";
    throw new CheckError(`could not load ${what} ${file}: ${error?.message ?? error}${hint}`);
  }
}

/**
 * Validate a schema with the installed Ponder's own buildSchema.
 * Returns counts on success; throws SchemaError when Ponder refuses, CheckError when it cannot run.
 */
export async function checkSchema({ dir = process.cwd(), schemaFile } = {}) {
  const root = path.resolve(dir);
  const configFile = path.join(root, "ponder.config.ts");
  if (!fs.existsSync(configFile)) throw new CheckError(`no ponder.config.ts in ${root}`);
  const ordering = readOrdering(fs.readFileSync(configFile, "utf8"));

  const schemaPath = path.resolve(schemaFile ?? path.join(root, "ponder.schema.ts"));
  if (!fs.existsSync(schemaPath)) throw new CheckError(`no schema file at ${schemaPath}`);

  const ponder = findPonder(path.dirname(schemaPath));
  const { onchainTable } = await importFile(ponder.entry, "ponder");
  const { buildSchema } = await importFile(ponder.validator, "ponder's schema validator");
  if (typeof buildSchema !== "function" || typeof onchainTable !== "function") {
    throw new CheckError(`ponder ${ponder.version} no longer exports buildSchema/onchainTable where this check expects them`);
  }

  // Positive control: the validator must refuse a reserved column before its pass means anything.
  const canary = {
    checkSchemaCanary: onchainTable("check_schema_canary", (t) => ({
      id: t.text().primaryKey(),
      operationId: t.hex(),
    })),
  };
  let canaryRefused = false;
  try {
    buildSchema({ schema: canary, preBuild: { ordering } });
  } catch (error) {
    canaryRefused = /reserved column name/.test(error?.message ?? "");
  }
  if (!canaryRefused) {
    throw new CheckError(
      `ponder ${ponder.version}'s buildSchema accepted a table with the reserved column operation_id; ` +
        "either Ponder dropped that reservation (update the canary) or this is not the validator ponder start runs",
    );
  }

  const schema = await importFile(schemaPath, "schema");
  let statements;
  try {
    ({ statements } = buildSchema({ schema, preBuild: { ordering } }));
  } catch (error) {
    throw new SchemaError(error?.message ?? String(error));
  }
  const rows = (kind) => (Array.isArray(statements?.[kind]?.json) ? statements[kind].json : []);
  const count = (kind) => rows(kind).length;
  return {
    schemaFile: schemaPath,
    ponderVersion: ponder.version,
    ordering,
    // Ponder emits a `_reorg__<table>` shadow for every table; count the schema's own.
    tables: rows("tables").filter((t) => !String(t.tableName).startsWith("_reorg__")).length,
    views: count("views"),
    enums: count("enums"),
    indexes: count("indexes"),
  };
}

function parseArgs(argv) {
  const args = { dir: undefined, schemaFile: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--schema") {
      args.schemaFile = argv[++i];
      if (!args.schemaFile) throw new CheckError("--schema needs a file");
    } else if (arg.startsWith("-")) {
      throw new CheckError(`unknown option ${arg}`);
    } else if (args.dir === undefined) {
      args.dir = arg;
    } else {
      throw new CheckError(`unexpected argument ${arg}`);
    }
  }
  return args;
}

async function main() {
  try {
    const result = await checkSchema(parseArgs(process.argv.slice(2)));
    console.log(
      `schema ok: ${result.schemaFile} passes ponder ${result.ponderVersion} buildSchema ` +
        `(ordering ${result.ordering}): ${result.tables} tables, ${result.views} views, ` +
        `${result.enums} enums, ${result.indexes} indexes; the reserved-column canary was refused`,
    );
    return 0;
  } catch (error) {
    if (error instanceof SchemaError) {
      console.error(`SCHEMA CHECK FAILED: ponder start would refuse this schema.\n  ${error.message}`);
      return 1;
    }
    console.error(`SCHEMA CHECK COULD NOT RUN: ${error?.message ?? error}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = await main();
}
