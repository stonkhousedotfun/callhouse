/**
 *   node --test ops/maker-epochs/check.test.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { checkDir, parseEpochFile } from "./check.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE = path.join(ROOT, "indexer", "src", "v2", "fixtures", "maker-epoch-2958.oz.json");

function tmp() {
  return mkdtempSync(path.join(tmpdir(), "maker-epochs-"));
}

function fixtureUnposted() {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  return {
    epoch: raw.epoch,
    root: raw.root,
    total: raw.total,
    posted: false,
    entries: raw.entries,
  };
}

test("empty dir is ok", async () => {
  const dir = tmp();
  try {
    const result = await checkDir(dir, { offline: true });
    assert.equal(result.ok, true);
    assert.equal(result.reports[0].state, "empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C2-11 fixture verifies as unposted", async () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, "2958.json"), JSON.stringify(fixtureUnposted()));
    const result = await checkDir(dir, { offline: true });
    assert.equal(result.ok, true);
    assert.equal(result.reports[0].state, "unposted");
    assert.match(result.reports[0].detail, /UNPOSTED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing posted is a failure, not an implicit unposted", () => {
  const body = fixtureUnposted();
  delete body.posted;
  assert.throws(() => parseEpochFile(body, "2958.json"), /posted must be true or false/);
});

test("posted:true without RPC is refused", async () => {
  const dir = tmp();
  try {
    const body = fixtureUnposted();
    body.posted = true;
    writeFileSync(path.join(dir, "2958.json"), JSON.stringify(body));
    await assert.rejects(() => checkDir(dir, { offline: true, rpc: "" }), /posted:true files require RH_RPC/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown keys (tampered vector) are refused", () => {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));
  raw.posted = false;
  assert.throws(() => parseEpochFile(raw, "2958.json"), /unknown keys/);
});

test("scores snapshots are ignored", async () => {
  const dir = tmp();
  try {
    writeFileSync(path.join(dir, "2958.scores.json"), JSON.stringify({ epoch: 2958, not: "a claim file" }));
    const result = await checkDir(dir, { offline: true });
    assert.equal(result.reports[0].state, "empty");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("root .dockerignore re-includes maker-epochs json", () => {
  const text = readFileSync(path.join(ROOT, ".dockerignore"), "utf8");
  assert.match(text, /!ops\/maker-epochs\/\*\.json/);
});

test("a broken proof fails local verify", async () => {
  const dir = tmp();
  try {
    const body = fixtureUnposted();
    body.entries[0].proof[0] = `0x${"00".repeat(32)}`;
    writeFileSync(path.join(dir, "2958.json"), JSON.stringify(body));
    await assert.rejects(() => checkDir(dir, { offline: true }), /proof for index/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
