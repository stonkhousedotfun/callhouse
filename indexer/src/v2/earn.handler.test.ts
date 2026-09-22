/**
 * The Earn-vault / zap indexing plane, as far as it exists without its ABIs.
 *
 * WHY THIS FILE DOES NOT USE THE `handlers.get("Contract:Event")` SHAPE that
 * flywheel.handler.test.ts:170 uses. That shape works by mocking ../../lib/registry so every
 * `.on(name, fn)` lands in a Map the test can call. src/v2/earn.ts registers nothing yet: neither
 * ops/abis/v2/EarnVault.json (the contract is unwritten, P8-02) nor ops/abis/v2/IStockZap.json
 * (landed but not in script/v2/abi-manifest.txt, T-78) exists, so neither contract can be a source
 * in ponder.config.ts and a registration would break the ponder:registry types package-wide. There
 * is nothing to capture. What is testable now is the row building the registrations will call, and
 * the event signatures they will be registered against.
 *
 * The signature assertions are the valuable half. A wrong event signature does not revert — it
 * silently decodes nothing, or worse, decodes the wrong field into the right-looking column. These
 * derive topic0 from the signature string this indexer coded against and compare it with the pin
 * published in v8-plan/status/INTERFACE-CHANGES-V8.md Entry 4, which was produced by a `forge test`
 * run against the compiled contract. Two independent derivations agreeing is the only reason the
 * v8 interface freeze's two wrong selector pins were ever caught.
 *
 * NOT RUN in this submission: the package has no node_modules in this worktree, so vitest and viem
 * cannot be resolved here. Authored, not executed (owner directive 2026-09-19).
 */
import { describe, expect, it } from "vitest";
import { toEventSelector } from "viem";

import { meta, zapActionRow } from "./earn";

/** Pinned in v8-plan/status/INTERFACE-CHANGES-V8.md Entry 4; derived there by forge from the contract. */
const PINNED_TOPIC0 = {
  WriteZapped: "0x1ae8864a999d8eea7c577cc18ede6b54ec495033e500d35c7d0bf7983d8f5b8b",
  ExitZapped: "0x23fdd2820484cbab406be2291fedb6a8a27d14e277812685619e9bbfad0620a1",
} as const;

/** Declared exactly as callhouse-contracts src/v2/interfaces/IStockZap.sol declares them. */
const ZAP_EVENTS = {
  WriteZapped:
    "event WriteZapped(address indexed account, address indexed asset, address caller, uint256 usdgIn, uint256 assetOut, uint8 venue)",
  ExitZapped:
    "event ExitZapped(address indexed account, address indexed asset, address caller, uint256 assetIn, uint256 usdgOut, uint8 venue)",
} as const;

const tx = `0x${"c".repeat(64)}` as const;
const ZAP = "0x000000000000000000000000000000000000a000" as `0x${string}`;
const ACCOUNT = "0x00000000000000000000000000000000000000Ac" as `0x${string}`;
const ASSET = "0x00000000000000000000000000000000000000A5" as `0x${string}`;
const CALLER = "0x00000000000000000000000000000000000000Ca" as `0x${string}`;

const event = (args: object, logIndex: number) => ({
  args: args as never,
  block: { timestamp: 1_700_000_000n, number: 64_100_000n },
  log: { logIndex, address: ZAP },
  transaction: { hash: tx },
});

describe("StockZap event signatures", () => {
  it("match the topic0s pinned from the compiled contract", () => {
    // Derived here from the signature this indexer coded against; the expectation is the forge pin.
    expect(toEventSelector(ZAP_EVENTS.WriteZapped)).toBe(PINNED_TOPIC0.WriteZapped);
    expect(toEventSelector(ZAP_EVENTS.ExitZapped)).toBe(PINNED_TOPIC0.ExitZapped);
  });

  it("does not confuse the two: they are different topics", () => {
    expect(PINNED_TOPIC0.WriteZapped).not.toBe(PINNED_TOPIC0.ExitZapped);
  });
});

describe("meta", () => {
  it("keys a row by transaction and log index and keeps the emitting address", () => {
    expect(meta(event({}, 7))).toEqual({
      id: `${tx}-7`,
      sourceAddress: ZAP.toLowerCase(),
      ts: 1_700_000_000n,
      block: 64_100_000n,
      logIndex: 7,
      tx,
    });
  });
});

describe("zapActionRow", () => {
  it("stores a write zap as USDG in, stock out", () => {
    const row = zapActionRow(
      "write",
      event({ account: ACCOUNT, asset: ASSET, caller: CALLER, usdgIn: 500_000_000n, assetOut: 3_000_000_000_000_000_000n, venue: 4 }, 1),
    );
    expect(row).toEqual({
      id: `${tx}-1`,
      zap: ZAP.toLowerCase(),
      kind: "write",
      account: ACCOUNT.toLowerCase(),
      asset: ASSET.toLowerCase(),
      caller: CALLER.toLowerCase(),
      amountIn: 500_000_000n,
      amountOut: 3_000_000_000_000_000_000n,
      venue: 4,
      ts: 1_700_000_000n,
      block: 64_100_000n,
      logIndex: 1,
      tx,
    });
  });

  it("stores an exit zap the other way round, so amountIn is always what the user gave up", () => {
    const row = zapActionRow(
      "exit",
      event({ account: ACCOUNT, asset: ASSET, caller: CALLER, assetIn: 3_000_000_000_000_000_000n, usdgOut: 499_000_000n, venue: 3 }, 2),
    );
    expect([row.kind, row.amountIn, row.amountOut, row.venue]).toEqual([
      "exit", 3_000_000_000_000_000_000n, 499_000_000n, 3,
    ]);
  });

  it("keeps caller distinct from account: a zap may be executed for someone else", () => {
    const row = zapActionRow(
      "write",
      event({ account: ACCOUNT, asset: ASSET, caller: CALLER, usdgIn: 1n, assetOut: 2n, venue: 0 }, 3),
    );
    expect(row.account).not.toBe(row.caller);
  });

  it("records venue 0 as an observed zero, never as absent", () => {
    const row = zapActionRow(
      "write",
      event({ account: ACCOUNT, asset: ASSET, caller: CALLER, usdgIn: 1n, assetOut: 2n, venue: 0 }, 4),
    );
    expect(row.venue).toBe(0);
  });
});
