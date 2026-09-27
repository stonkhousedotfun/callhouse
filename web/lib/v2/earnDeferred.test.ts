/**
 * The held-payment read (lib/v2/earnDeferred.ts), the receiver rule, the claim call and the cards. The read
 * runs against a stand-in client that answers `deferredAssets`, `queue` and `deferred(id)` the way EarnVault does
 * (callhouse-contracts src/v2/periphery/earn/EarnVault.sol, those three views), so no network is touched.
 */
import { decodeFunctionData, encodeFunctionData, getAddress, toFunctionSelector, type Address } from "viem";
import { describe, expect, it, vi } from "vitest";

import { earnVaultAbi } from "../abi/v2/earnVault";
import {
  HELD_SCAN_MAX, claimDeferredCall, heldPaymentsView, parseReceiver, readHeldPayments, type HeldPayment, type HeldPaymentsRead,
} from "./earnDeferred";

const VAULT = getAddress("0x00000000000000000000000000000000000000e5");
const ME = getAddress("0x1111111111111111111111111111111111111111");
const OTHER = getAddress("0x2222222222222222222222222222222222222222");
const STRANGER = getAddress("0x3333333333333333333333333333333333333333");
const ZERO = "0x0000000000000000000000000000000000000000";

type Deferred = readonly [Address, Address, bigint];

/** A vault with `deferredAssets` total, `tail` requests, and `held[id]` = (owner, receiver, assets). */
function chain(total: bigint, tail: bigint, held: Record<string, Deferred>, failIds: bigint[] = []) {
  const multicall = vi.fn(async ({ contracts }: { contracts: Array<{ args: readonly [bigint] }> }) =>
    contracts.map(({ args: [id] }) => failIds.includes(id)
      ? { status: "failure" as const, error: new Error("reverted") }
      : { status: "success" as const, result: held[id.toString()] ?? ([ZERO, ZERO, 0n] as Deferred) }));
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    if (functionName === "deferredAssets") return total;
    if (functionName === "queue") return [1n, tail] as const;
    throw new Error(`unexpected ${functionName}`);
  });
  return { client: { multicall, readContract } as never, multicall, readContract };
}

describe("readHeldPayments: the chain, never the indexer", () => {
  it("reads nothing per id when the vault holds nothing for anyone", async () => {
    const c = chain(0n, 40n, {});
    await expect(readHeldPayments(VAULT, ME, c.client)).resolves.toEqual({ status: "ok", items: [], complete: true, checked: 0 });
    expect(c.multicall).not.toHaveBeenCalled();
  });

  it("lists what this wallet may claim -- as owner or as receiver -- newest first, and nobody else's", async () => {
    const c = chain(260n, 5n, {
      "5": [STRANGER, STRANGER, 10n], // someone else's hold
      "4": [ME, ME, 0n],              // claimed already: zeroed, not deleted
      "3": [ME, OTHER, 100n],         // this wallet made the request, another address was to be paid
      "2": [OTHER, ME, 150n],         // this wallet was to be paid
    });
    const read = await readHeldPayments(VAULT, getAddress(ME).toLowerCase() as Address, c.client);
    expect(read).toEqual({
      status: "ok", complete: true, checked: 5,
      items: [
        { vault: VAULT, id: 3n, owner: ME, receiver: OTHER, assets: 100n },
        { vault: VAULT, id: 2n, owner: OTHER, receiver: ME, assets: 150n },
      ],
    });
    // ids 1..tail, every one asked about, newest first
    const asked = c.multicall.mock.calls.flatMap(([{ contracts }]) => contracts.map((x) => x.args[0]));
    expect(asked).toEqual([5n, 4n, 3n, 2n, 1n]);
  });

  it("says it could not check -- never 'nothing held' -- when any read fails", async () => {
    const failed = await readHeldPayments(VAULT, ME, chain(5n, 3n, { "2": [ME, ME, 5n] }, [1n]).client);
    expect(failed.status).toBe("unavailable");
    const broken = { multicall: vi.fn(), readContract: vi.fn(async () => { throw new Error("rpc down\nstack"); }) } as never;
    await expect(readHeldPayments(VAULT, ME, broken)).resolves.toEqual({ status: "unavailable", reason: "rpc down" });
  });

  it("checks the newest HELD_SCAN_MAX ids of a longer queue and says the list may be incomplete", async () => {
    const tail = BigInt(HELD_SCAN_MAX + 7);
    const c = chain(1n, tail, { [tail.toString()]: [ME, ME, 1n] });
    const read = await readHeldPayments(VAULT, ME, c.client);
    expect(read).toMatchObject({ status: "ok", complete: false, checked: HELD_SCAN_MAX });
    const asked = c.multicall.mock.calls.flatMap(([{ contracts }]) => contracts.map((x) => x.args[0]));
    expect(asked[0]).toBe(tail);
    expect(asked.at(-1)).toBe(tail - BigInt(HELD_SCAN_MAX) + 1n);
    expect(asked).toHaveLength(HELD_SCAN_MAX);
  });
});

describe("parseReceiver: canonical addresses only", () => {
  it("accepts the checksummed form, trimmed", () => {
    expect(parseReceiver(`  ${OTHER} `)).toEqual({ ok: true, address: OTHER });
    const mixed = "0x70556BaA315dD8d467ea452aBcd7deEbEa073Ff9";
    expect(parseReceiver(mixed)).toEqual({ ok: true, address: mixed });
  });

  it("refuses all-lowercase (no checksum), a broken checksum, the zero address, non-addresses and empty input", () => {
    expect(parseReceiver("0x70556baa315dd8d467ea452abcd7deebea073ff9")).toMatchObject({ ok: false, reason: expect.stringMatching(/checksum/) });
    expect(parseReceiver("0x70556BaA315dD8d467ea452aBcd7deEbEa073FF9")).toMatchObject({ ok: false });
    expect(parseReceiver(ZERO)).toMatchObject({ ok: false, reason: expect.stringMatching(/zero address/) });
    expect(parseReceiver("0x1234")).toMatchObject({ ok: false, reason: "That is not an address." });
    expect(parseReceiver("vitalik.eth")).toMatchObject({ ok: false });
    expect(parseReceiver("   ")).toMatchObject({ ok: false, reason: "Enter the address to pay." });
  });
});

describe("claimDeferredCall: the vault's own checks, then claimDeferred(id, to)", () => {
  const held: HeldPayment = { vault: VAULT, id: 9n, owner: ME, receiver: OTHER, assets: 42n };

  it("encodes claimDeferred(uint256,address) against the EarnVault ABI, for the owner and for the receiver", () => {
    for (const caller of [ME, OTHER]) {
      const call = claimDeferredCall(held, caller, STRANGER);
      expect(call.address).toBe(VAULT);
      expect(call.functionName).toBe("claimDeferred");
      const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args });
      // The selector is derived from the signature the contract declares, not pasted.
      expect(data.slice(0, 10)).toBe(toFunctionSelector("claimDeferred(uint256,address)"));
      const decoded = decodeFunctionData({ abi: earnVaultAbi, data });
      expect(decoded.functionName).toBe("claimDeferred");
      expect(decoded.args).toEqual([9n, STRANGER]);
    }
  });

  it("refuses a caller who is neither owner nor receiver, an empty hold, and a bad or zero receiver", () => {
    expect(() => claimDeferredCall(held, STRANGER, ME)).toThrow(/owner or its receiver/);
    expect(() => claimDeferredCall({ ...held, assets: 0n }, ME, ME)).toThrow(/Nothing is held/);
    // An address with letters: the all-digit fixtures above are already canonical in lowercase.
    expect(() => claimDeferredCall(held, ME, "0x70556baa315dd8d467ea452abcd7deebea073ff9")).toThrow(/checksum/);
    expect(() => claimDeferredCall(held, ME, ZERO)).toThrow(/zero address/);
  });
});

describe("heldPaymentsView: the cards /lend and /portfolio show", () => {
  const ok = (items: HeldPayment[], complete = true): HeldPaymentsRead => ({ status: "ok", items, complete, checked: 12 });

  it("says nothing without a wallet or before the read, and nothing when nothing is held", () => {
    expect(heldPaymentsView(ok([{ vault: VAULT, id: 1n, owner: ME, receiver: ME, assets: 1n }]), undefined)).toEqual({ cards: [], status: null });
    expect(heldPaymentsView(undefined, ME)).toEqual({ cards: [], status: null });
    expect(heldPaymentsView(ok([]), ME)).toEqual({ cards: [], status: null });
  });

  it("a card per held payment: amount, who could not be paid, why this wallet may claim, the wallet as default receiver", () => {
    const view = heldPaymentsView(ok([
      { vault: VAULT, id: 3n, owner: ME, receiver: OTHER, assets: 1_234_560n },
      { vault: VAULT, id: 2n, owner: OTHER, receiver: ME, assets: 5_000_000n },
    ]), ME);
    expect(view.status).toBeNull();
    const [owned, received] = view.cards;
    expect(owned).toMatchObject({ title: "Held payment for request #3", amount: "1.23 USDG", defaultReceiver: ME, receiverWarning: null, claimLabel: "Claim" });
    expect(owned!.why).toBe(`The vault could not pay ${OTHER}, so it is holding the payment. You can claim it because you made the request.`);
    // The wallet IS the address that could not be paid: say so, because the default receiver may be the one that fails.
    expect(received!.why).toContain("because you were to receive it");
    expect(received!.receiverWarning).toMatch(/claim to another address you control/);
  });

  it("says the read failed, and says when older requests were not checked", () => {
    expect(heldPaymentsView({ status: "unavailable", reason: "x" }, ME)).toEqual({
      cards: [], status: "Payments held for you by the lending vault could not be checked right now." });
    expect(heldPaymentsView(ok([], false), ME).status).toBe("Only the latest 12 requests were checked; an older held payment may not be listed.");
  });
});
