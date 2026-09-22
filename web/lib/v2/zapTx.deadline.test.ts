/**
 * F-APP-02. The zap deadline comes from CHAIN time, not the browser clock.
 *
 * A SEPARATE FILE because `zapTx.test.ts` mocks `requireV2Address` to THROW — it asserts the
 * address-null-guarded behaviour, so no write in it ever reaches the deadline. This file mocks the
 * address as present so the write path actually runs and the argument can be read off the simulated
 * call.
 *
 * The protected fact is "the deadline lands inside the intended quote lifetime, measured against the
 * chain". The old code read `Math.floor(Date.now() / 1000)`, which is a guard that cannot see its
 * subject: a clock behind chain time gives an instant `DeadlinePassed` revert, and a clock ahead
 * silently stretches the window past the intended lifetime — the fail-open direction, and the one
 * nobody notices, because it weakens the staleness bound on an oracle-spot-derived `minOut`.
 */
import { describe, expect, it, vi } from "vitest";

// vi.mock is HOISTED above every top-level binding, so the address is inlined in the factory rather
// than referenced from a const — a const here fails with "Cannot access 'ZAP' before initialization".
vi.mock("./config", () => ({
  requireV2Address: (key: string) => {
    if (key !== "stockZap") throw new Error(`unexpected ${key}`);
    return "0x0000000000000000000000000000000000000066";
  },
  V2_DEPLOYMENT: { contracts: { stockZap: "0x0000000000000000000000000000000000000066" } },
}));

import { exitZap, writeZap, ZAP_DEADLINE_SECONDS } from "./zapTx";
import type { WriteContext } from "./tx";

const account = "0x0000000000000000000000000000000000000044";
const asset = "0x0000000000000000000000000000000000000055";

/** Chain time, deliberately far from any real wall clock so a leak is unmistakable. */
const CHAIN_TIME = 1_700_000_000n;

function harness() {
  const calls: { functionName: string; args: readonly unknown[] }[] = [];
  const client = {
    getBlock: vi.fn(async () => ({ number: 1n, timestamp: CHAIN_TIME })),
    simulateContract: vi.fn(async (request: { functionName: string; args: readonly unknown[] }) => {
      calls.push({ functionName: request.functionName, args: request.args });
      return { request };
    }),
    waitForTransactionReceipt: vi.fn(async () => ({ status: "success", logs: [] })),
  };
  const context = {
    account, client,
    wallet: { getChainId: async () => 4663, writeContract: async () => `0x${"1".repeat(64)}` },
  } as unknown as WriteContext;
  return { calls, context };
}

/** The deadline is the last argument of both zap calls. */
const deadlineOf = (args: readonly unknown[]) => Number(args[args.length - 1]);

describe("zap deadline is chain time", () => {
  it("derives writeZap's deadline from block.timestamp", async () => {
    const { calls, context } = harness();
    await writeZap(context, asset, 215_500_000n, 215_500_000n, 6, 18);
    expect(deadlineOf(calls[0]!.args)).toBe(Number(CHAIN_TIME) + ZAP_DEADLINE_SECONDS);
  });

  it("derives exitZap's deadline from block.timestamp", async () => {
    const { calls, context } = harness();
    await exitZap(context, asset, 10n ** 18n, 215_500_000n, 6, 18);
    expect(deadlineOf(calls[0]!.args)).toBe(Number(CHAIN_TIME) + ZAP_DEADLINE_SECONDS);
  });

  it("IGNORES a client clock running far AHEAD of chain time", async () => {
    // The fail-open case. A browser an hour ahead used to stretch the deadline an hour past the
    // intended lifetime; the quote would still be accepted long after it should have expired.
    const ahead = (Number(CHAIN_TIME) + 3_600) * 1_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(ahead);
    try {
      const { calls, context } = harness();
      await writeZap(context, asset, 215_500_000n, 215_500_000n, 6, 18);
      const deadline = deadlineOf(calls[0]!.args);
      expect(deadline).toBe(Number(CHAIN_TIME) + ZAP_DEADLINE_SECONDS);
      // The property that matters, stated as the bound rather than as an equality:
      expect(deadline - Number(CHAIN_TIME)).toBeLessThanOrEqual(ZAP_DEADLINE_SECONDS);
    } finally { spy.mockRestore(); }
  });

  it("IGNORES a client clock running BEHIND chain time", async () => {
    // The fail-closed case: this one used to produce an instant DeadlinePassed revert.
    const behind = (Number(CHAIN_TIME) - 86_400) * 1_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(behind);
    try {
      const { calls, context } = harness();
      await exitZap(context, asset, 10n ** 18n, 215_500_000n, 6, 18);
      const deadline = deadlineOf(calls[0]!.args);
      expect(deadline).toBeGreaterThan(Number(CHAIN_TIME));
      expect(deadline).toBe(Number(CHAIN_TIME) + ZAP_DEADLINE_SECONDS);
    } finally { spy.mockRestore(); }
  });

  it("reads the block rather than trusting any cached time", async () => {
    const { context } = harness();
    const client = (context as unknown as { client: { getBlock: ReturnType<typeof vi.fn> } }).client;
    await writeZap(context, asset, 215_500_000n, 215_500_000n, 6, 18);
    expect(client.getBlock).toHaveBeenCalled();
  });
});
