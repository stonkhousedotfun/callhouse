#!/usr/bin/env node
// The indexer image excludes ops/. Commit this small, deterministic projection when card
// inputs change; `--check` runs in the indexer test gate and refuses a stale projection.
import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const source = path.join(root, "ops/markets/tier1.json");
const destination = path.join(root, "indexer/lib/v2/cardRegistry.generated.json");

function object(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function ladder(value, name) {
  object(value, name);
  const result = {};
  for (const key of ["rungs", "firstOtmBps", "stepBps", "cardTargetBps"]) {
    const entry = value[key];
    if (!Number.isSafeInteger(entry) || entry < 0) throw new Error(`${name}.${key} must be a nonnegative integer`);
    result[key] = entry;
  }
  return result;
}

function project(raw) {
  const registry = object(JSON.parse(raw), "registry");
  const v2 = object(registry.v2, "registry.v2");
  const fees = object(v2.fees, "registry.v2.fees");
  const defaults = object(v2.defaults, "registry.v2.defaults");
  const ladders = object(defaults.ladder, "registry.v2.defaults.ladder");
  if (!Array.isArray(registry.markets)) throw new Error("registry.markets must be an array");
  if (!/^(0|[1-9]\d*)$/.test(fees.takerFeeFlat ?? "")) throw new Error("registry.v2.fees.takerFeeFlat must be a decimal string");
  for (const key of ["takerFeeCapBps", "exerciseFeeBps"]) {
    if (!Number.isSafeInteger(fees[key]) || fees[key] < 0) throw new Error(`registry.v2.fees.${key} must be a nonnegative integer`);
  }
  const seen = new Set();
  const markets = registry.markets.map((item) => {
    object(item, "market");
    if (typeof item.ticker !== "string" || !/^[A-Z0-9.]{1,10}$/.test(item.ticker) || seen.has(item.ticker)) throw new Error(`invalid or duplicate market ticker: ${item.ticker}`);
    seen.add(item.ticker);
    const marketV2 = object(item.v2, `${item.ticker}.v2`);
    const overrides = object(marketV2.overrides, `${item.ticker}.v2.overrides`);
    const overrideLadder = overrides.ladder === undefined ? undefined : object(overrides.ladder, `${item.ticker}.v2.overrides.ladder`);
    const projectedLadder = {};
    if (overrideLadder !== undefined) {
      for (const tenor of ["daily", "weekly"]) {
        const partial = overrideLadder[tenor];
        if (partial === undefined) continue;
        object(partial, `${item.ticker}.v2.overrides.ladder.${tenor}`);
        const validated = {};
        for (const key of ["rungs", "firstOtmBps", "stepBps", "cardTargetBps"]) {
          if (partial[key] === undefined) continue;
          if (!Number.isSafeInteger(partial[key]) || partial[key] < 0) throw new Error(`${item.ticker}.v2.overrides.ladder.${tenor}.${key} must be a nonnegative integer`);
          validated[key] = partial[key];
        }
        projectedLadder[tenor] = validated;
      }
    }
    return { ticker: item.ticker, v2: { overrides: Object.keys(projectedLadder).length === 0 ? {} : { ladder: projectedLadder } } };
  });
  const projection = {
    v2: {
      fees: { takerFeeFlat: fees.takerFeeFlat, takerFeeCapBps: fees.takerFeeCapBps, exerciseFeeBps: fees.exerciseFeeBps },
      defaults: { ladder: { weekly: ladder(ladders.weekly, "registry.v2.defaults.ladder.weekly"), daily: ladder(ladders.daily, "registry.v2.defaults.ladder.daily") } },
    },
    markets,
  };
  // Hash only the fields copied into this image. Deploy bot addresses, metadata and other
  // unrelated registry edits do not change how cards are rendered.
  return {
    projectionSha256: createHash("sha256").update(JSON.stringify(projection)).digest("hex"),
    ...projection,
  };
}

const raw = readFileSync(source, "utf8");
const expected = `${JSON.stringify(project(raw), null, 2)}\n`;
if (process.argv.includes("--check")) {
  let actual;
  try { actual = readFileSync(destination, "utf8"); } catch { actual = null; }
  if (actual !== expected) {
    throw new Error("indexer card registry snapshot drifted from ops/markets/tier1.json; run pnpm --filter @callhouse/indexer gen:card-registry and commit the result");
  }
  process.stdout.write("indexer card registry snapshot matches source\n");
} else {
  const temp = `${destination}.tmp-${process.pid}`;
  writeFileSync(temp, expected);
  renameSync(temp, destination);
  process.stdout.write(`wrote ${path.relative(root, destination)}\n`);
}
