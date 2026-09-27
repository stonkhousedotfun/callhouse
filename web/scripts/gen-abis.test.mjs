// Tests for web/scripts/gen-abis.mjs's hand-written allowlist, V2_HAND_WRITTEN.
//
// Run with `node --test web/scripts/gen-abis.test.mjs` from the repo root (or `node --test scripts/...` from
// web/). A node:test file for the same reason as gen-markets.test.mjs: the generator is a plain Node script,
// and web's vitest include does not collect scripts/.
//
// WHAT IS PINNED. lib/abi/v2/quoterV3.ts and lib/abi/v2/universalRouter.ts are hand-written ABIs of external
// Uniswap contracts, and lib/v2/stockSwap.ts imports both. ops/abis/v2 has no source for them, so before
// that, the stale sweep listed both under --check (red) and write mode DELETED them. V2_HAND_WRITTEN now
// names them: they are neither stale nor removed; a sourceless module it does not name still is both; and an
// entry whose file is gone, or whose path a V2_MODULES row also generates, is refused in both modes.
//
// NOTHING HERE WRITES INTO THE CHECKOUT. Case (1) runs --check, which renders in memory, against the real
// tree. Every other case runs the script from a temporary copy of the layout it reads and writes (web/scripts,
// web/lib/abi, web/lib/v2/seriesId.ts, ops/abis, ops/shared), which works because the script resolves every
// path from its own location.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "gen-abis.mjs");
const WEB = path.resolve(HERE, "..");
const REPO = path.resolve(WEB, "..");
const HAND_WRITTEN = ["lib/abi/v2/quoterV3.ts", "lib/abi/v2/universalRouter.ts"];

/** Run the generator; stdout and stderr together, since the refusals print to stderr. */
const run = (script, ...args) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};

const sandboxes = [];
after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/** A temporary copy of everything the script touches. `patch` rewrites the copied script's source. */
function sandbox(patch = (text) => text) {
  const root = mkdtempSync(path.join(tmpdir(), "gen-abis-"));
  sandboxes.push(root);
  const web = path.join(root, "web");
  mkdirSync(path.join(web, "scripts"), { recursive: true });
  const script = path.join(web, "scripts", "gen-abis.mjs");
  writeFileSync(script, patch(readFileSync(SCRIPT, "utf8")));
  cpSync(path.join(WEB, "lib", "abi"), path.join(web, "lib", "abi"), { recursive: true });
  mkdirSync(path.join(web, "lib", "v2"), { recursive: true });
  cpSync(path.join(WEB, "lib", "v2", "seriesId.ts"), path.join(web, "lib", "v2", "seriesId.ts"));
  mkdirSync(path.join(root, "ops"), { recursive: true });
  cpSync(path.join(REPO, "ops", "abis"), path.join(root, "ops", "abis"), { recursive: true });
  cpSync(path.join(REPO, "ops", "shared"), path.join(root, "ops", "shared"), { recursive: true });
  return { script, web };
}

test("(1) --check exits 0 on the committed tree and lists neither hand-written ABI as stale", () => {
  const r = run(SCRIPT, "--check");
  assert.equal(r.status, 0, r.out);
  for (const rel of HAND_WRITTEN) {
    assert.ok(!r.out.includes(rel), `--check named ${rel}:\n${r.out}`);
  }
});

test("(2) write mode leaves both hand-written ABIs present and byte-identical", () => {
  const box = sandbox();
  const r = run(box.script);
  assert.equal(r.status, 0, r.out);
  // Positive control: write mode ran and rendered the generated modules around the hand-written ones.
  assert.match(r.out, /^wrote lib\/abi\/v2\/clearinghouse\.ts /m, r.out);
  for (const rel of HAND_WRITTEN) {
    const file = path.join(box.web, rel);
    assert.ok(existsSync(file), `write mode removed ${rel}:\n${r.out}`);
    assert.ok(readFileSync(file).equals(readFileSync(path.join(WEB, rel))), `write mode changed ${rel}`);
  }
  const check = run(box.script, "--check");
  assert.equal(check.status, 0, `--check after write mode:\n${check.out}`);
});

test("(3) a sourceless module V2_HAND_WRITTEN does not name is still stale under --check and still removed", () => {
  const box = sandbox();
  const orphan = "lib/abi/v2/orphanProbe.ts";
  writeFileSync(path.join(box.web, orphan), "export const orphanProbeAbi = [] as const;\n");

  const check = run(box.script, "--check");
  assert.equal(check.status, 1, check.out);
  assert.match(check.out, /^stale: +lib\/abi\/v2\/orphanProbe\.ts \(no source in ops\/abis\/v2\)$/m, check.out);
  for (const rel of HAND_WRITTEN) {
    assert.ok(!check.out.includes(rel), `--check named ${rel}:\n${check.out}`);
  }

  const write = run(box.script);
  assert.equal(write.status, 0, write.out);
  assert.match(write.out, /^removed lib\/abi\/v2\/orphanProbe\.ts \(no source in ops\/abis\/v2\)$/m, write.out);
  assert.ok(!existsSync(path.join(box.web, orphan)), "write mode kept the orphan module");
  for (const rel of HAND_WRITTEN) {
    assert.ok(existsSync(path.join(box.web, rel)), `write mode removed ${rel}:\n${write.out}`);
  }
});

test("(4a) an allowlisted file that is absent is refused in both modes, before anything is written", () => {
  const box = sandbox();
  rmSync(path.join(box.web, "lib/abi/v2/quoterV3.ts"));
  const refusal = /^stale allowance: lib\/abi\/v2\/quoterV3\.ts \(named in V2_HAND_WRITTEN but absent\)$/m;

  const check = run(box.script, "--check");
  assert.equal(check.status, 1, check.out);
  assert.match(check.out, refusal, check.out);

  const write = run(box.script);
  assert.equal(write.status, 1, write.out);
  assert.match(write.out, refusal, write.out);
  assert.doesNotMatch(write.out, /^wrote /m, `write mode wrote before refusing:\n${write.out}`);
});

test("(4b) an allowlisted name a V2_MODULES row also generates is a collision in both modes; the file is not overwritten", () => {
  const anchor = "const V2_MODULES = [\n";
  const box = sandbox((text) => {
    // Positive control for the patch itself: if the anchor moves, fail here rather than test an unpatched copy.
    assert.ok(text.includes(anchor), "V2_MODULES anchor not found in gen-abis.mjs; update this test");
    return text.replace(anchor, `${anchor}  { name: "quoterV3", sources: ["V2Errors.json"], what: "collision probe" },\n`);
  });
  const file = path.join(box.web, "lib/abi/v2/quoterV3.ts");
  const before = readFileSync(file);
  const refusal =
    /^collision: lib\/abi\/v2\/quoterV3\.ts \(named in V2_HAND_WRITTEN and also generated from ops\/abis\/v2\)$/m;

  const check = run(box.script, "--check");
  assert.equal(check.status, 1, check.out);
  assert.match(check.out, refusal, check.out);

  const write = run(box.script);
  assert.equal(write.status, 1, write.out);
  assert.match(write.out, refusal, write.out);
  assert.ok(readFileSync(file).equals(before), "write mode overwrote the hand-written quoterV3.ts");
});
