import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { concatHex, encodeAbiParameters, getAddress, keccak256 } from "viem";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

const script = fileURLToPath(new URL("./maker-epoch.mjs", import.meta.url));
const exec = promisify(execFile);
const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

function run(rows: unknown[], budget = "10") {
  const dir = mkdtempSync(join(tmpdir(), "maker-epoch-"));
  scratch.push(dir);
  const input = join(dir, "makers.json");
  const output = join(dir, "epoch.json");
  writeFileSync(input, JSON.stringify(rows));
  execFileSync(process.execPath, [script, "2958", budget, "--input", input, "--output", output]);
  return JSON.parse(readFileSync(output, "utf8"));
}

function independentlyVerify(entry: { index: number; account: `0x${string}`; amount: string; proof: `0x${string}`[] }, root: string) {
  const encoded = encodeAbiParameters([
    { type: "uint256" }, { type: "uint256" }, { type: "address" }, { type: "uint256" },
  ], [2958n, BigInt(entry.index), entry.account, BigInt(entry.amount)]);
  let hash = keccak256(keccak256(encoded));
  for (const sibling of entry.proof) {
    const pair = [hash, sibling].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    hash = keccak256(concatHex(pair as [`0x${string}`, `0x${string}`]));
  }
  expect(hash).toBe(root);
}

describe("maker epoch CLI", () => {
  it("matches an OpenZeppelin authority vector, including every proof and a tampered leaf", () => {
    const fixture = JSON.parse(readFileSync(fileURLToPath(new URL("../src/v2/fixtures/maker-epoch-2958.oz.json", import.meta.url)), "utf8"));
    const values = fixture.entries.map((entry: { index: number; account: string; amount: string }) =>
      [String(fixture.epoch), String(entry.index), entry.account, entry.amount]);
    const tree = StandardMerkleTree.of(values, fixture.types);
    expect(tree.root).toBe(fixture.root);
    const result = run(fixture.entries.map((entry: { account: string; amount: string }) =>
      ({ maker: entry.account, scorePpm: entry.amount })), fixture.total);
    expect(result).toEqual({ epoch: fixture.epoch, root: fixture.root, total: fixture.total, entries: fixture.entries });
    for (const entry of fixture.entries) {
      expect(tree.getProof(entry.index)).toEqual(entry.proof);
      expect(StandardMerkleTree.verify(fixture.root, fixture.types,
        [String(fixture.epoch), String(entry.index), entry.account, entry.amount], entry.proof)).toBe(true);
    }
    const changed = fixture.tampered;
    expect(StandardMerkleTree.verify(fixture.root, fixture.types,
      [String(fixture.epoch), String(changed.index), changed.account, changed.amount], changed.proof)).toBe(changed.verifies);
  });

  it("allocates an exact budget and produces OZ-compatible double-hashed proofs", () => {
    const makers = [
      { maker: getAddress("0x0000000000000000000000000000000000000003"), scorePpm: "250000" },
      { maker: getAddress("0x0000000000000000000000000000000000000001"), scorePpm: "1000000" },
      { maker: getAddress("0x0000000000000000000000000000000000000002"), scorePpm: "500000" },
    ];
    const result = run(makers);
    expect(result.epoch).toBe(2958);
    expect(result.total).toBe("10");
    expect(result.entries.map((row: { index: number; amount: string }) => [row.index, row.amount])).toEqual([
      [0, "6"], [1, "3"], [2, "1"],
    ]);
    for (const entry of result.entries) independentlyVerify(entry, result.root);
    expect(result.root).toBe("0x676da18a286639fd7817f16ff91b727ba3f6b52a8459edfb20cca073ebfde4a0");
  });

  it("reindexes entries after dust allocations and rejects duplicate accounts", () => {
    const makers = [
      { maker: "0x0000000000000000000000000000000000000001", score: 100 },
      { maker: "0x0000000000000000000000000000000000000002", score: 1 },
    ];
    const result = run(makers, "1");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].index).toBe(0);
    independentlyVerify(result.entries[0], result.root);
    expect(() => run([makers[0], makers[0]])).toThrow();
  });

  it("consumes the frozen paginated /v2/makers response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maker-epoch-api-"));
    scratch.push(dir);
    const output = join(dir, "epoch.json");
    const requested: string[] = [];
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      requested.push(url.search);
      const second = url.searchParams.get("cursor") === "page-2";
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ epoch: { id: 2958, start: 1789344000, end: 1789948800 },
        items: [{ maker: second ? "0x0000000000000000000000000000000000000002" : "0x0000000000000000000000000000000000000001",
          score: second ? 50 : 100 }], nextCursor: second ? null : "page-2" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (typeof address === "string" || address === null) throw new Error("missing test server address");
      await exec(process.execPath, [script, "2958", "3", "--output", output], {
        env: { ...process.env, INDEXER_URL: `http://127.0.0.1:${address.port}` },
      });
      const result = JSON.parse(readFileSync(output, "utf8"));
      expect(result.entries.map((row: { amount: string }) => row.amount)).toEqual(["2", "1"]);
      expect(requested).toEqual(["?epoch=2958&limit=200", "?epoch=2958&limit=200&cursor=page-2"]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
