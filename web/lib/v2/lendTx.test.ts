/**
 * The Earn vault's address resolution.
 *
 * WHAT CHANGED: `earnVaultAddress()` used to `return null` unconditionally. It now resolves through
 * `config.ts` — registry first, then a validated `NEXT_PUBLIC_V2_EARN_VAULT` override, and nothing
 * else. The registry DOES carry `earnVault` now (the v8 write-back, `markets.generated.ts`
 * `V2_CONTRACTS.earnVault`), and this file used to assert `earnVaultAddress()` was null with it
 * present — a green that pinned the defect. The unmocked module therefore resolves the REGISTRY value;
 * the override and unconfigured cases run against a generated module mocked to be silent.
 *
 * THE OVERRIDE TESTS RE-IMPORT THE MODULE. `next build` inlines `process.env.NEXT_PUBLIC_*` at
 * build time and `config.ts` reads them once at module scope, so a variable set after import is
 * never seen. `vi.resetModules()` plus a dynamic import is what makes the set value reach the code
 * under test — and if that ever stops being true, these tests fail rather than passing vacuously.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OVERRIDE_ADDRESS_KEYS, V2_ADDRESS_KEYS } from "./config";
import { encodeAbiParameters, encodeEventTopics, type Log } from "viem";
import { earnVaultAbi } from "../abi/v2/earnVault";
import {
  cancelQueuedRequest, claimDeferredPayment, depositQueuedIdFrom, depositToVault, earnVaultAddress, redeemFromVault, redeemFromVaultTracked,
  lendRedeemInput, lendRedeemOverBalance, requireEarnVaultAddress, withdrawalQueuedIdFrom,
} from "./lendTx";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { EARN_REDEEM_ERROR_TEXT, explainEarnRedeemError } from "./errors";

const account = "0x0000000000000000000000000000000000000044";
const context = { account, wallet: { getChainId: async () => 4663 } } as never;

/** Lowercase on purpose: a resolver that returns its input unchanged must fail the checksum test. */
const OVERRIDE_LOWER = "0x70556baa315dd8d467ea452abcd7deebea073ff9";
const OVERRIDE_CHECKSUMMED = "0x70556BaA315dD8d467ea452aBcd7deEbEa073Ff9";

/** Makes the generated registry SILENT about earnVault, the state production was in before the write-back. */
function silentRegistry() {
  vi.doMock("../markets.generated", async (importOriginal) => {
    const original = await importOriginal<typeof import("../markets.generated")>();
    return { ...original, V2_CONTRACTS: { ...original.V2_CONTRACTS, earnVault: null } };
  });
}

async function lendTxWithEnv(value: string | undefined) {
  vi.resetModules();
  silentRegistry();
  if (value === undefined) vi.stubEnv("NEXT_PUBLIC_V2_EARN_VAULT", "");
  else vi.stubEnv("NEXT_PUBLIC_V2_EARN_VAULT", value);
  return import("./lendTx");
}

afterEach(() => { vi.unstubAllEnvs(); vi.doUnmock("../markets.generated"); vi.resetModules(); });

describe("lend vault configuration", () => {
  it("resolves the DEPLOYED vault from the generated registry with no override set", async () => {
    const { V2_CONTRACTS } = await import("../markets.generated");
    const registry = (V2_CONTRACTS as Record<string, unknown>).earnVault;
    // The control: without a registry value this test would prove nothing about registry-first.
    expect(typeof registry, "the generated registry no longer carries earnVault").toBe("string");
    expect(earnVaultAddress()).toBe(registry);
    expect(requireEarnVaultAddress()).toBe(registry);
  });

  it("is unconfigured when the registry is silent and no override is set, and says which variable would set it", async () => {
    const lendTx = await lendTxWithEnv(undefined);
    expect(lendTx.earnVaultAddress()).toBeNull();
    expect(() => lendTx.requireEarnVaultAddress()).toThrow(/earnVault is not deployed/);
    expect(() => lendTx.requireEarnVaultAddress()).toThrow(/NEXT_PUBLIC_V2_EARN_VAULT/);
  });

  it("refuses writes when the vault address is unconfigured", async () => {
    const lendTx = await lendTxWithEnv(undefined);
    await expect(lendTx.depositToVault(context, 1n)).rejects.toThrow(/earnVault is not deployed/);
    await expect(lendTx.redeemFromVault(context, 1n)).rejects.toThrow(/earnVault is not deployed/);
    await expect(lendTx.processVaultQueue(context, 1n)).rejects.toThrow(/earnVault is not deployed/);
  });

  it("refuses a zero deposit or redeem before touching the wallet", async () => {
    await expect(depositToVault(context, 0n)).rejects.toThrow(/positive deposit/);
    await expect(redeemFromVault(context, 0n)).rejects.toThrow(/positive share/);
  });
});

describe("the NEXT_PUBLIC_V2_EARN_VAULT override, where the registry is silent", () => {
  it("makes the vault configured, and checksums the value rather than passing it through", async () => {
    const lendTx = await lendTxWithEnv(OVERRIDE_LOWER);
    expect(lendTx.earnVaultAddress()).toBe(OVERRIDE_CHECKSUMMED);
    expect(lendTx.requireEarnVaultAddress()).toBe(OVERRIDE_CHECKSUMMED);
    // The 2026-09-19 stubbed-viem incident: an identity `checksumAddress` made every assertion
    // written against already-checksummed fixtures pass. This one cannot, because the input is
    // lowercase and the expected value is mixed case.
    expect(OVERRIDE_CHECKSUMMED).not.toBe(OVERRIDE_LOWER);
  });

  it("is REPORTED, not silent — the key is named as override-served", async () => {
    vi.resetModules();
    silentRegistry();
    vi.stubEnv("NEXT_PUBLIC_V2_EARN_VAULT", OVERRIDE_LOWER);
    const config = await import("./config");
    expect(config.v2AddressOverrides()).toContain("earnVault");
    expect(config.v2AddressProvenanceNotices().join(" ")).toContain("NEXT_PUBLIC_V2_EARN_VAULT");
  });

  it("does NOT pause deposits by announcing itself", async () => {
    // The provenance notice is a separate channel from `v2ConfigWarnings`, which LendVault and
    // TradeTicket use to block. An override that disabled the action it enables would be useless.
    vi.resetModules();
    silentRegistry();
    vi.stubEnv("NEXT_PUBLIC_V2_EARN_VAULT", OVERRIDE_LOWER);
    const config = await import("./config");
    const { configResponseSchema } = await import("./api-schema");
    const fixture = configResponseSchema.parse((await import("../../../ops/fixtures/api/v2/config.json")).default);
    expect(config.v2AddressProvenanceNotices().length).toBeGreaterThan(0);
    expect(config.v2ConfigWarnings(fixture).join(" ")).not.toContain("NEXT_PUBLIC_V2_EARN_VAULT");
    expect(config.v2ConfigWarnings(fixture).join(" ")).not.toContain("earnVault");
  });

  it("a malformed override resolves to null rather than being cast to an address", async () => {
    for (const bad of ["not-an-address", "0x1234", "", "   "]) {
      const lendTx = await lendTxWithEnv(bad);
      expect(lendTx.earnVaultAddress(), bad).toBeNull();
      expect(() => lendTx.requireEarnVaultAddress()).toThrow(/not deployed/);
    }
  });
});

/**
 * THE KEY-SET INVARIANT, restated for override-only address keys.
 *
 * It used to read "V2_CONTRACT_NAMES and config.ts addressKeys name the same set". With override-only keys
 * they MUST differ, by exactly the override-only keys, so the assertion that carries the same
 * weight is: every address key is either registry-backed (in the generator's closed list) or
 * declared override-only. A key in neither is the old defect again — present, unfillable, and silently false.
 *
 * It lives in this file rather than in `config.test.ts` for historical reasons; it belongs
 * there and can move.
 *
 * IT READS THE GENERATOR AS TEXT ON PURPOSE. `gen-markets.mjs` WRITES FILES at module scope, so
 * importing it from a test would regenerate `lib/markets.generated.ts` as a side effect of running
 * the suite. The regex is given a positive control below so a parse that silently matches nothing
 * fails instead of passing.
 */
describe("the address key set is closed, and every key has a source", () => {
  const source = readFileSync(fileURLToPath(new URL("../../scripts/gen-markets.mjs", import.meta.url)), "utf8");
  const block = source.match(/const V2_CONTRACT_NAMES = \[([\s\S]*?)\];/);
  const generatorNames = (block?.[1]?.match(/"([A-Za-z0-9_]+)"/g) ?? []).map((name) => name.slice(1, -1));

  it("the generator's list was actually parsed — the control for every assertion below", () => {
    // Without this, a renamed const or a reformatted array would make `generatorNames` empty and
    // every "is not in the generator list" assertion below would pass for the wrong reason.
    expect(block, "V2_CONTRACT_NAMES not found in gen-markets.mjs").not.toBeNull();
    expect(generatorNames.length).toBeGreaterThan(5);
    expect(generatorNames).toContain("clearinghouse");
    expect(generatorNames).toContain("rewardsDistributor");
  });

  it("every address key is either registry-backed or declared override-only", () => {
    for (const key of V2_ADDRESS_KEYS) {
      const backed = generatorNames.includes(key) || (OVERRIDE_ADDRESS_KEYS as readonly string[]).includes(key);
      expect(backed, `${key} is in neither the generator list nor the override-only list`).toBe(true);
    }
  });

  it("the three override-only keys are NOT in the generator's registry list", () => {
    for (const key of OVERRIDE_ADDRESS_KEYS) expect(generatorNames, key).not.toContain(key);
  });

  it("stockZap is still an address key — removing it is the wrong fix (trap T2)", () => {
    expect(V2_ADDRESS_KEYS as readonly string[]).toContain("stockZap");
  });
});

/**
 * REGISTRY FIRST: the registry wins over the environment. Also placed here rather than in `config.test.ts`,
 * for the same reason.
 *
 * These use `stockZap` with an injected registry value. Since every overridable key reads its
 * `v2.contracts` slot (`config.ts` `REGISTRY_NAME`), so `earnVault` and the lender distributor get the
 * same rule; their registry-first cases, including the `rewardsDistributorLender` name mapping, are in
 * `config.test.ts`. The registry value is injected by mocking the GENERATED module, which is the same
 * thing a deployment would change.
 */
describe("a deployed registry value is never shadowed by a stale override", () => {
  const REGISTRY_LOWER = "0x1111111111111111111111111111111111111111";

  afterEach(() => { vi.doUnmock("../markets.generated"); });

  it("prefers the registry, and does not report the key as override-served", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_V2_STOCK_ZAP", OVERRIDE_LOWER);
    vi.doMock("../markets.generated", async (importOriginal) => {
      const original = await importOriginal<typeof import("../markets.generated")>();
      return { ...original, V2_CONTRACTS: { ...original.V2_CONTRACTS, stockZap: REGISTRY_LOWER } };
    });
    const config = await import("./config");
    const resolved = config.resolveV2Address("stockZap");
    expect(resolved.source).toBe("registry");
    expect(resolved.address?.toLowerCase()).toBe(REGISTRY_LOWER);
    expect(resolved.address?.toLowerCase()).not.toBe(OVERRIDE_LOWER);
    expect(config.v2AddressOverrides()).not.toContain("stockZap");
    expect(config.v2AddressProvenanceNotices().join(" ")).not.toContain("NEXT_PUBLIC_V2_STOCK_ZAP");
  });

  it("falls back to the override only where the registry is silent — the control for the test above", async () => {
    // Same setup minus the registry value. If this did not switch to the override, the assertion
    // above would be proving nothing more than "stockZap resolves to something". The committed
    // registry carries stockZap now, so "minus the registry value" is a mocked silence, not the default.
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_V2_STOCK_ZAP", OVERRIDE_LOWER);
    vi.doMock("../markets.generated", async (importOriginal) => {
      const original = await importOriginal<typeof import("../markets.generated")>();
      return { ...original, V2_CONTRACTS: { ...original.V2_CONTRACTS, stockZap: null } };
    });
    const config = await import("./config");
    const resolved = config.resolveV2Address("stockZap");
    expect(resolved.source).toBe("override");
    expect(resolved.address).toBe(OVERRIDE_CHECKSUMMED);
    expect(config.v2AddressOverrides()).toContain("stockZap");
  });

  it("an override that DISAGREES with a published indexer address still blocks", async () => {
    // The one case where an override belongs in the blocking array: the indexer publishes this key
    // and names a different contract. Silence from the indexer is not disagreement and must not
    // block — that is asserted in the deposits test above.
    //
    // CHANGED THIS CASE ON PURPOSE. It used stockZap as its example, and asserted that a stockZap
    // disagreement pauses trading. tier1.json now carries stockZap and the indexer does not send it, and the two
    // deploy separately, so a blocking stockZap check pauses Buy/Bid/Earn/Lend/Portfolio in one deploy order or the
    // other (config.test.ts "" cases). The blocking example is now earnVault, which keeps the rule; the
    // stockZap disagreement is asserted to land in the Zap-only channel instead.
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_V2_EARN_VAULT", OVERRIDE_LOWER);
    silentRegistry();
    const config = await import("./config");
    const { configResponseSchema } = await import("./api-schema");
    const fixture = configResponseSchema.parse((await import("../../../ops/fixtures/api/v2/config.json")).default);
    expect(config.resolveV2Address("earnVault").source, "control: earnVault is override-served here").toBe("override");
    const disagrees = { ...fixture, contracts: { ...fixture.contracts, earnVault: REGISTRY_LOWER } };
    expect(config.v2ConfigWarnings(disagrees).join(" ")).toContain("earnVault override does not match");
    const agrees = { ...fixture, contracts: { ...fixture.contracts, earnVault: OVERRIDE_CHECKSUMMED } };
    expect(config.v2ConfigWarnings(agrees).join(" ")).not.toContain("earnVault override does not match");
  });

  it("a stockZap override the indexer contradicts disables Zap only, never the blocking channel", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_V2_STOCK_ZAP", OVERRIDE_LOWER);
    vi.doMock("../markets.generated", async (importOriginal) => {
      const original = await importOriginal<typeof import("../markets.generated")>();
      return { ...original, V2_CONTRACTS: { ...original.V2_CONTRACTS, stockZap: null } };
    });
    const config = await import("./config");
    const { configResponseSchema } = await import("./api-schema");
    const fixture = configResponseSchema.parse((await import("../../../ops/fixtures/api/v2/config.json")).default);
    expect(config.resolveV2Address("stockZap").source, "control: stockZap is override-served here").toBe("override");
    const disagrees = { ...fixture, contracts: { ...fixture.contracts, stockZap: REGISTRY_LOWER } };
    expect(config.v2ConfigWarnings(disagrees)).toEqual(config.v2ConfigWarnings(fixture));
    expect(config.v2ConfigWarnings(disagrees).join(" ")).not.toContain("stockZap");
    expect(config.v2StockZapMismatch(disagrees)).toContain(REGISTRY_LOWER.slice(2, 8));
    const agrees = { ...fixture, contracts: { ...fixture.contracts, stockZap: OVERRIDE_CHECKSUMMED } };
    expect(config.v2StockZapMismatch(agrees)).toBeNull();
  });
});

/**
 * The queued-deposit notice quotes the id from THIS vault's DepositQueued log. The log is built from the
 * compiled ABI's own event definition, so the test cannot pass on a shape the vault never emits.
 */
describe("depositQueuedIdFrom", () => {
  const vault = "0x0000000000000000000000000000000000000066" as const;
  const other = "0x0000000000000000000000000000000000000077" as const;
  const owner = "0x0000000000000000000000000000000000000044" as const;
  const event = earnVaultAbi.find((e) => e.type === "event" && e.name === "DepositQueued")!;
  const nonIndexed = (event as unknown as { inputs: readonly { indexed?: boolean; type: string; name: string }[] }).inputs.filter((i) => !i.indexed);
  const log = (address: `0x${string}`, id: bigint): Log => ({
    address,
    topics: encodeEventTopics({ abi: earnVaultAbi, eventName: "DepositQueued", args: { id, owner } as never }) as [`0x${string}`, ...`0x${string}`[]],
    data: encodeAbiParameters(nonIndexed, nonIndexed.map(() => 5n) as never),
    blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false,
  });

  it("reads the id from the vault's own log and ignores another contract's", () => {
    expect(depositQueuedIdFrom({ logs: [log(other, 9n), log(vault, 41n)] }, vault)).toBe(41n);
  });
  it("is null for an instant deposit (no such log)", () => {
    expect(depositQueuedIdFrom({ logs: [] }, vault)).toBeNull();
    expect(depositQueuedIdFrom({ logs: [log(other, 9n)] }, vault)).toBeNull();
  });
});

/** The redeem receipt's queue id, the tracked redeem, and cancelQueued. */
describe("withdrawalQueuedIdFrom", () => {
  const vault = "0x0000000000000000000000000000000000000066" as const;
  const other = "0x0000000000000000000000000000000000000077" as const;
  const owner = "0x0000000000000000000000000000000000000044" as const;
  const event = earnVaultAbi.find((e) => e.type === "event" && e.name === "WithdrawalQueued")!;
  const nonIndexed = (event as unknown as { inputs: readonly { indexed?: boolean; type: string; name: string }[] }).inputs.filter((i) => !i.indexed);
  const log = (address: `0x${string}`, id: bigint, eventName: "WithdrawalQueued" | "DepositQueued" = "WithdrawalQueued"): Log => ({
    address,
    topics: encodeEventTopics({ abi: earnVaultAbi, eventName, args: { id, owner, receiver: owner } as never }) as [`0x${string}`, ...`0x${string}`[]],
    data: encodeAbiParameters(nonIndexed, nonIndexed.map(() => 5n) as never),
    blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false,
  });

  it("reads the id from the vault's own WithdrawalQueued log and ignores another contract's", () => {
    expect(withdrawalQueuedIdFrom({ logs: [log(other, 9n), log(vault, 12n)] }, vault)).toBe(12n);
  });
  it("is null for a redemption paid now, and never mistakes a DepositQueued log for one", () => {
    expect(withdrawalQueuedIdFrom({ logs: [] }, vault)).toBeNull();
    expect(withdrawalQueuedIdFrom({ logs: [log(other, 9n)] }, vault)).toBeNull();
    expect(withdrawalQueuedIdFrom({ logs: [log(vault, 3n, "DepositQueued")] }, vault)).toBeNull();
  });

  it("the tracked redeem reports the queued id from THIS vault's log in the mined receipt", async () => {
    const registry = requireEarnVaultAddress();
    const simulateContract = vi.fn(async () => ({ request: {} }));
    const receipt = { status: "success", logs: [log(other, 9n), log(registry, 21n)] };
    const context = {
      account: owner,
      client: { simulateContract, waitForTransactionReceipt: async () => receipt },
      wallet: { getChainId: async () => 4663, writeContract: async () => `0x${"cd".repeat(32)}` },
    } as never;
    await expect(redeemFromVaultTracked(context, 3n)).resolves.toMatchObject({ queuedId: 21n });
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({ address: registry, functionName: "redeem", args: [3n, owner] }));
    await expect(redeemFromVaultTracked(context, 0n)).rejects.toThrow(/positive share/);
  });
});

describe("cancelQueuedRequest", () => {
  const owner = "0x0000000000000000000000000000000000000044" as const;
  it("sends cancelQueued(id) to the registry vault, simulated first", async () => {
    const simulateContract = vi.fn(async () => ({ request: {} }));
    const context = {
      account: owner,
      client: { simulateContract, waitForTransactionReceipt: async () => ({ status: "success", logs: [] }) },
      wallet: { getChainId: async () => 4663, writeContract: async () => `0x${"ef".repeat(32)}` },
    } as never;
    await cancelQueuedRequest(context, 5n);
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      account: owner, address: requireEarnVaultAddress(), functionName: "cancelQueued", args: [5n],
    }));
  });
  it("refuses a zero id before touching the wallet: the contract never issues one", async () => {
    await expect(cancelQueuedRequest(context, 0n)).rejects.toThrow(/no queue id/);
  });
});

/*
 * claimDeferred(id, to): the owner-or-receiver check runs on a FRESH `deferred(id)` read, before the simulation
 * and any wallet prompt, and only the registry vault is ever called.
 */
describe("claimDeferredPayment", () => {
  const me = "0x0000000000000000000000000000000000000044" as const;
  const other = "0x2222222222222222222222222222222222222222" as const;
  const to = "0x70556BaA315dD8d467ea452aBcd7deEbEa073Ff9" as const;
  function ctx(deferred: readonly [string, string, bigint]) {
    const readContract = vi.fn(async () => deferred);
    const simulateContract = vi.fn(async () => ({ request: {} }));
    const context = {
      account: me,
      client: { readContract, simulateContract, waitForTransactionReceipt: async () => ({ status: "success", logs: [] }) },
      wallet: { getChainId: async () => 4663, writeContract: async () => `0x${"ef".repeat(32)}` },
    } as never;
    return { context, readContract, simulateContract };
  }

  it("re-reads deferred(id) on the registry vault, then sends claimDeferred(id, to) as the request's owner", async () => {
    const c = ctx([me, other, 5_000_000n]);
    await claimDeferredPayment(c.context, 7n, to);
    expect(c.readContract).toHaveBeenCalledWith(expect.objectContaining({ address: requireEarnVaultAddress(), functionName: "deferred", args: [7n] }));
    expect(c.simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      account: me, address: requireEarnVaultAddress(), functionName: "claimDeferred", args: [7n, to],
    }));
  });

  it("and as its receiver", async () => {
    const c = ctx([other, me, 1n]);
    await claimDeferredPayment(c.context, 3n, to);
    expect(c.simulateContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "claimDeferred", args: [3n, to] }));
  });

  it("refuses before any simulation: a caller the chain says is neither owner nor receiver, nothing held, a bad receiver, id 0", async () => {
    const stranger = ctx([other, other, 5n]);
    await expect(claimDeferredPayment(stranger.context, 7n, to)).rejects.toThrow(/owner or its receiver/);
    const empty = ctx([me, me, 0n]);
    await expect(claimDeferredPayment(empty.context, 7n, to)).rejects.toThrow(/Nothing is held/);
    const bad = ctx([me, me, 5n]);
    await expect(claimDeferredPayment(bad.context, 7n, to.toLowerCase())).rejects.toThrow(/checksum/);
    for (const c of [stranger, empty, bad]) expect(c.simulateContract).not.toHaveBeenCalled();
    await expect(claimDeferredPayment(ctx([me, me, 5n]).context, 0n, to)).rejects.toThrow(/no request id/);
  });
});

describe("the redeem button's cap mirrors EarnVault.redeem taking the shares from the wallet", () => {
  const fmt = (raw: bigint) => (Number(raw) / 1e18).toString();
  const ONE = 10n ** 18n;

  it("refuses more than the wallet holds, naming the balance (ERC20InsufficientBalance on either path)", () => {
    expect(lendRedeemOverBalance(3n * ONE + 1n, 3n * ONE, fmt)).toBe("You hold 3 shares. Enter that many or fewer.");
  });

  it("the whole balance and less pass; the edge is inclusive, as the token's own check is", () => {
    expect(lendRedeemOverBalance(3n * ONE, 3n * ONE, fmt)).toBeNull();
    expect(lendRedeemOverBalance(ONE, 3n * ONE, fmt)).toBeNull();
  });

  it("an unread or failed balance refuses nothing, and neither does an empty field", () => {
    expect(lendRedeemOverBalance(ONE, undefined, fmt)).toBeNull();
    expect(lendRedeemOverBalance(ONE, null, fmt)).toBeNull();
    expect(lendRedeemOverBalance(null, 0n, fmt)).toBeNull();
  });
});

/*
 * The redeem cap used to parse and format shares at a hard-coded 18;
 * the box now takes both from the vault's own decimals() (lendRedeemInput), and a failed redeem keeps its name through
 * this module's own error wrapper (lendTx.ts `write`: `new Error(explainV2Error(error), { cause: error })`).
 */
describe("the redeem box and its error at the vault's own share decimals", () => {
  it("parses and caps at 6-dp shares: 2 typed over a 1.5-share balance is refused naming 1.5 shares", () => {
    expect(lendRedeemInput("2", 6, 1_500_000n)).toEqual({ shares: 2_000_000n, over: "You hold 1.5 shares. Enter that many or fewer." });
    expect(lendRedeemInput("1.5", 6, 1_500_000n)).toEqual({ shares: 1_500_000n, over: null });
  });

  it("the same text at 18 dp is 18-dp shares, with the same line", () => {
    expect(lendRedeemInput("2", 18, 15n * 10n ** 17n))
      .toEqual({ shares: 2n * 10n ** 18n, over: "You hold 1.5 shares. Enter that many or fewer." });
  });

  it("no amount and no line while decimals() is unread, or the text is not a positive amount", () => {
    expect(lendRedeemInput("2", null, 1n)).toEqual({ shares: null, over: null });
    for (const raw of ["", "0", "abc", "-1"]) expect(lendRedeemInput(raw, 6, 1n), raw).toEqual({ shares: null, over: null });
    expect(lendRedeemInput("2", 6, null)).toEqual({ shares: 2_000_000n, over: null });
  });

  it("a redeem over the balance keeps its name through lendTx's own wrapper, so the redeem copy can name it", async () => {
    const data = encodeErrorResult({ abi: earnVaultAbi, errorName: "ERC20InsufficientBalance", args: [account, 1n, 2n] });
    const client = { simulateContract: async () => {
      throw new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: earnVaultAbi, data, functionName: "redeem" }),
        { abi: earnVaultAbi, functionName: "redeem", args: [], contractAddress: account, sender: account });
    } };
    const error: unknown = await redeemFromVaultTracked({ account, wallet: { getChainId: async () => 4663 }, client } as never, 2n)
      .then(() => null, (caught: unknown) => caught);
    if (!(error instanceof Error)) throw new Error("the redeem did not refuse");
    // The wrapper's own message is the general line; only the redeem copy, walking its cause, names the shares.
    expect(error.message).not.toBe(EARN_REDEEM_ERROR_TEXT.ERC20InsufficientBalance);
    expect(explainEarnRedeemError(error)).toBe(EARN_REDEEM_ERROR_TEXT.ERC20InsufficientBalance);
  });
});
