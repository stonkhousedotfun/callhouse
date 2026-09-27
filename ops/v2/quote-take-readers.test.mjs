// Every ops reader of OrderBook.quoteTake simulates it FROM the taker's account.
//
//   node --test ops/v2/quote-take-readers.test.mjs
//
// callhouse-contracts: quoteTake is no longer a view. It runs take's own code and rolls it back, so the ABI
// says `nonpayable`, it is asked with an eth_call (viem simulateContract), and a call with no `from` (msg.sender
// address(0)) reverts NotAuthorized. The three ops helpers below are the only ops paths that quote; each is fed a fake
// client here, so no RPC runs. The devnet seed and the money rehearsal are read as text because importing them starts
// their run.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
process.env.REHEARSE_OUT ??= mkdtempSync(path.join(tmpdir(), "quote-take-readers-"));

const devnet = await import("../devnet/lib.mjs");
const rehearse = await import("./rehearse/lib.mjs");
const money = await import("../rehearse-lifecycle/money/lib.mjs");

const BOOK = "0x00000000000000000000000000000000000000b0";
const TAKER = "0x00000000000000000000000000000000000000c1";
const ZERO = "0x0000000000000000000000000000000000000000";
const PARAMS = { longId: 7n, buying: true, orderIds: [3n], units: 100n, minUnits: 1n, limitPrice: 250_000n,
  writeToSell: false, recipient: TAKER, deadline: 1_789_620_300, maxTotalFee: 0n };
const QUOTE = [100n, 250_000n, 1_000n, 0n];

/** A client that answers simulateContract and refuses a view read of quoteTake, as the current book does. */
function fakeClient() {
  const calls = [];
  return {
    calls,
    simulateContract: async (args) => { calls.push(args); return { result: QUOTE, request: args }; },
    readContract: async () => { throw new Error("quoteTake is not a view since T-OP-835"); },
  };
}

test("the published OrderBook ABIs say quoteTake is nonpayable", () => {
  for (const name of ["OrderBook", "IOrderBook"]) {
    const abi = JSON.parse(readFileSync(path.join(ROOT, "ops", "abis", "v2", `${name}.json`), "utf8"));
    const fn = abi.find((x) => x.type === "function" && x.name === "quoteTake");
    assert.equal(fn?.stateMutability, "nonpayable", `${name}.quoteTake`);
  }
});

for (const [label, quote] of [
  ["ops/devnet/lib.mjs quoteTake", (client, taker) => devnet.quoteTake(BOOK, taker, PARAMS, client)],
  ["ops/v2/rehearse/lib.mjs quoteTake", (client, taker) => rehearse.quoteTake(BOOK, taker, PARAMS, client)],
  ["ops/rehearse-lifecycle/money fork.simulate", (client, taker) =>
    money.makeFork({ pub: client, rpc: async () => null }).simulate(BOOK, [], "quoteTake", [PARAMS], taker)],
]) {
  test(`${label} simulates quoteTake FROM the taker and returns its four values`, async () => {
    const client = fakeClient();
    assert.deepEqual(await quote(client, TAKER), QUOTE);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].functionName, "quoteTake");
    assert.equal(client.calls[0].address, BOOK);
    assert.equal(client.calls[0].account, TAKER);
    assert.deepEqual(client.calls[0].args, [PARAMS]);
  });

  test(`${label} refuses a missing or zero taker before any RPC`, async () => {
    for (const taker of [undefined, ZERO]) {
      const client = fakeClient();
      await assert.rejects(quote(client, taker));
      assert.equal(client.calls.length, 0, `taker ${taker}`);
    }
  });
}

test("the devnet seed and the money rehearsal quote through those helpers, never through a view read", () => {
  const code = (rel) => readFileSync(path.join(ROOT, rel), "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  const seed = code("ops/devnet/seed.mjs");
  assert.doesNotMatch(seed, /read\([^)]*["']quoteTake["']/, "seed.mjs reads quoteTake as a view");
  assert.match(seed, /await quoteTake\(C\.orderBook, acct\[who\], quoted\)/);
  const run = code("ops/rehearse-lifecycle/money/run.mjs");
  assert.doesNotMatch(run, /read\([^)]*["']quoteTake["']/, "money/run.mjs reads quoteTake as a view");
  assert.match(run, /await simulate\(C\.ob, ABI\.ob, "quoteTake", \[[^\]]*\], taker\.address\)/);
});
