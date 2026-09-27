/*
 * node --test ops/v2/abi-drift.test.mjs
 *
 * Every case builds a miniature contracts checkout (manifest, sources, out/ artifacts whose metadata
 * hashes those sources, roles.v8.json) and a matching ops/abis/v2 copy, proves the pair is clean, then breaks one
 * thing and asserts the line that names it.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { checkDrift, itemKey, keccak256, main, parseManifest } from "./abi-drift.mjs";

const FOO_ABI = [
  { type: "constructor", inputs: [{ name: "owner", type: "address", internalType: "address" }], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "set",
    inputs: [{ name: "value", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "get",
    inputs: [],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "Moved",
    inputs: [
      { name: "to", type: "address", indexed: true, internalType: "address" },
      { name: "amount", type: "uint256", indexed: false, internalType: "uint256" },
    ],
    anonymous: false,
  },
  { type: "error", name: "TooBig", inputs: [{ name: "max", type: "uint256", internalType: "uint256" }] },
];
const BAR_ABI = [
  {
    type: "function",
    name: "quote",
    inputs: [
      {
        name: "legs",
        type: "tuple[]",
        internalType: "struct IBar.Leg[]",
        components: [
          { name: "id", type: "uint256", internalType: "uint256" },
          { name: "who", type: "address", internalType: "address" },
        ],
      },
    ],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
];
const ROLES = { interfaceVersion: 8, roles: { ADMIN: 0, SETTER: 7 }, targets: { Foo: { "set(uint256)": "SETTER" } } };
const SOURCES = { "src/Foo.sol": "contract Foo {}\n", "src/IBar.sol": "interface IBar {}\n" };

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

const writeJson = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

/** A contracts checkout with a fresh out/, and an ops/abis/v2 copy that matches it. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "abi-drift-"));
  dirs.push(root);
  const contracts = path.join(root, "contracts");
  const abis = path.join(root, "abis");
  mkdirSync(path.join(contracts, "script/v2"), { recursive: true });
  writeFileSync(path.join(contracts, "script/v2/abi-manifest.txt"), "# published\nIBar  # interface\n\nFoo\n");
  for (const [rel, text] of Object.entries(SOURCES)) {
    mkdirSync(path.dirname(path.join(contracts, rel)), { recursive: true });
    writeFileSync(path.join(contracts, rel), text);
  }
  const artifact = (abi, rel) => ({ abi, metadata: { sources: { [rel]: { keccak256: keccak256(SOURCES[rel]) } } } });
  writeJson(path.join(contracts, "out/Foo.sol/Foo.json"), artifact(FOO_ABI, "src/Foo.sol"));
  writeJson(path.join(contracts, "out/IBar.sol/IBar.json"), artifact(BAR_ABI, "src/IBar.sol"));
  writeJson(path.join(contracts, "script/v2/roles.v8.json"), ROLES);
  writeJson(path.join(abis, "Foo.json"), FOO_ABI);
  writeJson(path.join(abis, "IBar.json"), BAR_ABI);
  writeJson(path.join(abis, "roles.json"), ROLES);
  return { contracts, abis };
}

function run({ contracts, abis }) {
  const log = [];
  const error = [];
  const code = main(["--contracts", contracts, "--abis", abis], { log: (l) => log.push(l), error: (l) => error.push(l) });
  return { code, log, error, all: [...log, ...error].join("\n") };
}

const editCopy = (abis, name, edit) => {
  const file = path.join(abis, `${name}.json`);
  writeJson(file, edit(JSON.parse(readFileSync(file, "utf8"))));
};

test("keccak256 matches solc's hash (vectors from `cast keccak`), across the 136-byte block boundary", () => {
  assert.equal(keccak256(""), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256("abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
  assert.equal(keccak256("a".repeat(135)), "0x34367dc248bbd832f4e3e69dfaac2f92638bd0bbd18f2912ba4ef454919cf446");
  assert.equal(keccak256("a".repeat(136)), "0xa6c4d403279fe3e0af03729caada8374b5ca54d8065329a3ebcaeb4b60aa386e");
  assert.equal(keccak256("a".repeat(200)), "0x96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d");
});

test("the manifest parses as export-abis.sh parses it", () => {
  assert.deepEqual(parseManifest("# c\nA\n  B  # note\n\nC\n"), ["A", "B", "C"]);
  assert.throws(() => parseManifest("A\nA\n"), /listed twice/);
  assert.throws(() => parseManifest("A-B\n"), /not a contract name/);
  assert.throws(() => parseManifest("# only comments\n"), /lists no names/);
});

test("items are keyed by kind and canonical signature, tuples expanded", () => {
  assert.equal(itemKey(BAR_ABI[0]), "function quote((uint256,address)[])");
  assert.equal(itemKey(FOO_ABI[0]), "constructor(address)");
  assert.equal(itemKey(FOO_ABI[3]), "event Moved(address,uint256)");
});

test("a copy that matches the contracts' compiled output: exit 0", () => {
  const r = run(fixture());
  assert.equal(r.code, 0, r.all);
  assert.match(r.all, /no drift \(2 ABIs \+ roles\.json match/);
});

test("break: an event removed from the copy is named ADDED (the contracts have it)", () => {
  const f = fixture();
  editCopy(f.abis, "Foo", (abi) => abi.filter((item) => item.name !== "Moved"));
  const r = run(f);
  assert.equal(r.code, 1);
  assert.ok(r.log.includes("ADDED    Foo event Moved(address,uint256)"), r.all);
  assert.match(r.all, /1 drifted item\(s\) in 1 file\(s\)/);
});

test("break: a fake function added to the copy is named REMOVED (the contracts do not have it)", () => {
  const f = fixture();
  editCopy(f.abis, "IBar", (abi) => [...abi, { type: "function", name: "fake", inputs: [{ name: "x", type: "uint256" }], outputs: [], stateMutability: "nonpayable" }]);
  const r = run(f);
  assert.equal(r.code, 1);
  assert.ok(r.log.includes("REMOVED  IBar function fake(uint256)"), r.all);
});

test("same signature, different detail: CHANGED names what differs (indexed, mutability, outputs, names)", () => {
  const f = fixture();
  editCopy(f.abis, "Foo", (abi) =>
    abi.map((item) =>
      item.name === "Moved"
        ? { ...item, inputs: item.inputs.map((p) => ({ ...p, indexed: false })) }
        : item.name === "get"
          ? { ...item, stateMutability: "pure" }
          : item,
    ),
  );
  const r = run(f);
  assert.equal(r.code, 1);
  assert.ok(r.log.includes("CHANGED  Foo event Moved(address,uint256): was Moved(address to, uint256 amount); now Moved(address indexed to, uint256 amount)"), r.all);
  assert.ok(r.log.includes("CHANGED  Foo function get(): was get() pure returns (uint256); now get() view returns (uint256)"), r.all);
});

test("same items in another order: ORDER", () => {
  const f = fixture();
  editCopy(f.abis, "Foo", (abi) => [...abi].reverse());
  const r = run(f);
  assert.equal(r.code, 1);
  assert.ok(r.log.some((l) => l.startsWith("ORDER    Foo:")), r.all);
});

test("a manifest contract with no copy is MISSING; a copy the manifest does not list is STALE", () => {
  const f = fixture();
  rmSync(path.join(f.abis, "IBar.json"));
  writeJson(path.join(f.abis, "Gone.json"), []);
  const r = run(f);
  assert.equal(r.code, 1);
  assert.ok(r.log.includes("MISSING  IBar: in script/v2/abi-manifest.txt, no ops/abis/v2/IBar.json"), r.all);
  assert.ok(r.log.includes("STALE    Gone: ops/abis/v2/Gone.json is not in script/v2/abi-manifest.txt"), r.all);
});

test("roles.json that differs from script/v2/roles.v8.json: ROLES names the path", () => {
  const f = fixture();
  writeJson(path.join(f.abis, "roles.json"), { ...ROLES, targets: { Foo: {} } });
  const r = run(f);
  assert.equal(r.code, 1);
  assert.ok(r.log.includes("ROLES    roles targets.Foo.set(uint256): ops/abis/v2/roles.json differs from script/v2/roles.v8.json"), r.all);
});

test("out/ not built from this checkout refuses the whole run (exit 2), naming the source", () => {
  const f = fixture();
  editCopy(f.abis, "Foo", (abi) => abi.slice(1)); // drift that must NOT be reported from an untrusted out/
  writeFileSync(path.join(f.contracts, "src/Foo.sol"), "contract Foo { event New(); }\n");
  const r = run(f);
  assert.equal(r.code, 2);
  assert.match(r.all, /out\/Foo\.sol\/Foo\.json was not built from this checkout \(src\/Foo\.sol changed since it was compiled\)/);
  assert.equal(r.log.some((l) => /^(ADDED|REMOVED|CHANGED)/.test(l)), false, "no drift lines from an untrusted build");
});

test("a missing artifact, source or manifest refuses (exit 2)", () => {
  const f = fixture();
  rmSync(path.join(f.contracts, "out/IBar.sol"), { recursive: true });
  assert.match(run(f).all, /missing artifact out\/IBar\.sol\/IBar\.json for manifest entry IBar/);
  const g = fixture();
  rmSync(path.join(g.contracts, "src/IBar.sol"));
  const rg = run(g);
  assert.equal(rg.code, 2);
  assert.match(rg.all, /src\/IBar\.sol is not in the checkout/);
  const h = fixture();
  rmSync(path.join(h.contracts, "script/v2/abi-manifest.txt"));
  assert.equal(checkDrift({ contractsDir: h.contracts, abisDir: h.abis }).errors[0].startsWith("no manifest at"), true);
});

test("usage: --contracts is required", () => {
  const error = [];
  assert.equal(main([], { log() {}, error: (l) => error.push(l) }), 2);
  assert.match(error.join("\n"), /usage: node ops\/v2\/abi-drift\.mjs --contracts/);
  assert.equal(main(["--contracts"], { log() {}, error() {} }), 2);
});
