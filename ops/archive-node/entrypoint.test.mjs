/* -------------------------------------------------------------------------------------------------
 * node --test ops/archive-node/entrypoint.test.mjs
 *
 * entrypoint.sh's decisions, with a fake `nitro` that prints its argv: required L1 endpoints, the
 * chain-file checksum, an unwritable data dir, snapshot init only on an EMPTY database, the trailing
 * slash a multi-part snapshot needs, the genesis-sync opt-in, and that no keyed URL reaches stdout
 * or stderr except as the argument nitro itself receives.
 * ------------------------------------------------------------------------------------------------- */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, test } from "node:test";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, "entrypoint.sh");
const SECRET_RPC = "https://eth-mainnet.example/v2/RPCSECRET";
const SECRET_BEACON = "https://beacon.example/BEACONSECRET";
const SNAP = "https://robinhood-snapshots.offchainlabs.com/robinhood%20chain/2026-09-06-a346dc6c/";

const tmp = mkdtempSync(path.join(tmpdir(), "archive-entry-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

let root, data, nitro;
beforeEach(() => {
  const dir = mkdtempSync(path.join(tmp, "case-"));
  root = path.join(dir, "root");
  data = path.join(dir, "data");
  mkdirSync(root);
  mkdirSync(data);
  cpSync(path.join(HERE, "chain"), path.join(root, "chain"), { recursive: true });
  nitro = path.join(dir, "nitro");
  writeFileSync(nitro, '#!/bin/sh\nfor a in "$@"; do echo "ARG $a"; done\n');
  chmodSync(nitro, 0o755);
});

function runEntry(extra = {}) {
  const env = {
    PATH: process.env.PATH,
    ARCHIVE_ROOT: root,
    DATA_DIR: data,
    NITRO_BIN: nitro,
    PARENT_CHAIN_RPC_URL: SECRET_RPC,
    PARENT_CHAIN_BEACON_URL: SECRET_BEACON,
    ...extra,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  const r = spawnSync("sh", [ENTRY], { env, encoding: "utf8" });
  const args = r.stdout.split("\n").filter((l) => l.startsWith("ARG ")).map((l) => l.slice(4));
  const own = r.stdout.split("\n").filter((l) => !l.startsWith("ARG ")).join("\n") + r.stderr;
  return { code: r.status, args, own, stderr: r.stderr };
}

test("empty database + SNAPSHOT_URL: nitro gets the snapshot, the config file and both L1 endpoints", () => {
  const r = runEntry({ SNAPSHOT_URL: SNAP });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.args.includes(`--init.url=${SNAP}`));
  assert.ok(r.args.includes(`--conf.file=${root}/nitro.json`));
  assert.ok(r.args.includes(`--parent-chain.connection.url=${SECRET_RPC}`));
  assert.ok(r.args.includes(`--parent-chain.blob-client.beacon-url=${SECRET_BEACON}`));
  assert.match(r.own, /initialising from snapshot https:\/\/robinhood-snapshots\.offchainlabs\.com\/\.\.\./);
});

test("the entrypoint's own output never carries a keyed URL", () => {
  for (const extra of [{ SNAPSHOT_URL: SNAP }, { ALLOW_GENESIS_SYNC: "1" }, {}]) {
    const r = runEntry(extra);
    assert.doesNotMatch(r.own, /RPCSECRET|BEACONSECRET/, JSON.stringify(extra));
  }
});

test("existing database: resumes and passes NO init source even when SNAPSHOT_URL is still set", () => {
  mkdirSync(path.join(data, "Robinhood Chain", "nitro", "l2chaindata"), { recursive: true });
  const r = runEntry({ SNAPSHOT_URL: SNAP });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.args.some((a) => a.startsWith("--init.url")), r.args.join(" "));
  assert.match(r.own, /existing database found/);
});

test("empty database, no snapshot, no opt-in: refused", () => {
  const r = runEntry();
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no SNAPSHOT_URL/);
  assert.equal(r.args.length, 0, "nitro must not start");
});

test("empty database, ALLOW_GENESIS_SYNC=1: starts with no init source", () => {
  const r = runEntry({ ALLOW_GENESIS_SYNC: "1" });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.args.some((a) => a.startsWith("--init.url")));
});

test("a snapshot URL without the trailing slash is refused (Nitro would fetch one file, not the manifest)", () => {
  const r = runEntry({ SNAPSHOT_URL: SNAP.slice(0, -1) });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /must end in \//);
});

test("missing L1 endpoints are refused by name", () => {
  assert.match(runEntry({ PARENT_CHAIN_RPC_URL: undefined, SNAPSHOT_URL: SNAP }).stderr, /PARENT_CHAIN_RPC_URL is required/);
  assert.match(runEntry({ PARENT_CHAIN_BEACON_URL: undefined, SNAPSHOT_URL: SNAP }).stderr, /PARENT_CHAIN_BEACON_URL is required/);
});

test("a tampered chain file is refused before nitro starts", () => {
  appendFileSync(path.join(root, "chain", "robinhood-chain-info.json"), " ");
  const r = runEntry({ SNAPSHOT_URL: SNAP });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /checksum mismatch/);
  assert.equal(r.args.length, 0);
});

test("an unwritable data dir is refused", () => {
  chmodSync(data, 0o555);
  try {
    const r = runEntry({ SNAPSHOT_URL: SNAP });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not a writable volume/);
  } finally {
    chmodSync(data, 0o755);
  }
});

test("EXTRA_NITRO_ARGS are appended word by word", () => {
  const r = runEntry({ SNAPSHOT_URL: SNAP, EXTRA_NITRO_ARGS: "--a=1 --b=2" });
  assert.deepEqual(r.args.slice(-2), ["--a=1", "--b=2"]);
});
