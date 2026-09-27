import { type Address, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";

import {
  CANNOT_PREVIEW, formatEarnDepositPreview, formatEarnQueuedPreview, formatEarnRedeemPreview,
  formatOptionRedeemPreview, formatRollPreview, readEarnDepositPreview, readEarnQueuedPreview,
  readEarnRedeemPreview, readOptionRedeemPreview, readRollPreview,
} from "./moneyPreviews";

const VAULT = "0x00000000000000000000000000000000000000a1" as Address;
const CH = "0x00000000000000000000000000000000000000a2" as Address;
const ROLLER = "0x00000000000000000000000000000000000000a3" as Address;
const HOLDER = "0x00000000000000000000000000000000000000b1" as Address;
const ASSET = "0x00000000000000000000000000000000000000c1" as Address;

function client(impl: (functionName: string, args: readonly unknown[]) => unknown): PublicClient {
  return {
    readContract: async (call: { functionName: string; args: readonly unknown[] }) => impl(call.functionName, call.args),
  } as unknown as PublicClient;
}

describe("contract previews", () => {
  it("the lend deposit line is the vault's share count, and a queued deposit does not print that count as a mint", () => {
    expect(formatEarnDepositPreview({ ok: true, shares: 2n * 10n ** 18n, queued: false }, 18)).toBe("You would receive 2 shares.");
    const queued = formatEarnDepositPreview({ ok: true, shares: 0n, queued: true }, 18);
    expect(queued).toBe("This deposit will queue. No shares are minted until it is served.");
    expect(queued).not.toMatch(/\d/);
  });

  it("the lend withdrawal line names a queue and a venue pull, and a revert is cannot preview with no number", () => {
    expect(formatEarnRedeemPreview({ ok: true, assets: 1_500_000n, queued: false, needsVenue: false }))
      .toBe("You would receive 1.50 USDG now.");
    expect(formatEarnRedeemPreview({ ok: true, assets: 0n, queued: true, needsVenue: false }))
      .toBe("This withdrawal will queue. Nothing is paid now.");
    expect(formatEarnRedeemPreview({ ok: true, assets: 4_000_000n, queued: false, needsVenue: true }))
      .toContain("only if the lending venue delivers the rest");
    expect(formatEarnRedeemPreview({ ok: false })).toBe(CANNOT_PREVIEW);
    expect(CANNOT_PREVIEW).not.toMatch(/\d/);
  });

  it("a queued request shows previewQueued's amount", () => {
    expect(formatEarnQueuedPreview({ ok: true, shares: 3n * 10n ** 18n, assets: 0n, headNow: true, needsVenue: false }, 18))
      .toBe("If served now: 3 shares.");
    expect(formatEarnQueuedPreview({ ok: true, shares: 0n, assets: 2_000_000n, headNow: false, needsVenue: false }, 18))
      .toBe("Estimate, earlier requests are served first: 2 USDG.");
    // Head redemption: shares 0, assets the full amount, needsVenue (EarnVault.previewQueued).
    expect(formatEarnQueuedPreview({ ok: true, shares: 0n, assets: 4_000_000n, headNow: true, needsVenue: true }, 18))
      .toBe("If served now: 4 USDG only if the lending venue delivers the rest.");
    expect(formatEarnQueuedPreview({ ok: false }, 18)).toBe(CANNOT_PREVIEW);
  });

  it("an option redemption shows the units, the asset and the USDG floor from previewRedeem", () => {
    const line = formatOptionRedeemPreview({
      ok: true, units: 100n, asset: ASSET, owed: 250_000n, minUsdgOut: 240_000n,
    });
    expect(line).toContain("100 units");
    expect(line).toContain(ASSET);
    expect(line).toContain("250000 base units");
    expect(line).toContain("0.24 USDG");
    expect(formatOptionRedeemPreview({ ok: false })).toBe(CANNOT_PREVIEW);
  });

  it("the next roll is previewRoll, and a roll that would place nothing does not show the zero quote", () => {
    const due = formatRollPreview({
      ok: true, due: true, strike: 100_000_000n, expiry: 1_800_000_000, price: 1_500_000n, units: 250n,
    });
    expect(due).toContain("2.5 shares");
    expect(due).toContain("100 USDG");
    expect(due).toContain("1.50 USDG");
    const idle = formatRollPreview({ ok: true, due: false, strike: 0n, expiry: 0, price: 0n, units: 0n });
    expect(idle).toBe("No new roll would be placed now.");
    expect(idle).not.toMatch(/\d/);
    expect(formatRollPreview({ ok: false })).toBe(CANNOT_PREVIEW);
  });

  it("each surface asks its own contract view, and a revert is cannot preview rather than a zero", async () => {
    const calls: string[] = [];
    const ok = client((name) => {
      calls.push(name);
      if (name === "previewDeposit") return [5n, false];
      if (name === "previewRedeem") return [9n, false, true];
      if (name === "previewQueued") return [0n, 8n, true, false];
      if (name === "previewRoll") return [false, 0n, 0, 0n, 0n];
      throw new Error("no");
    });
    expect(await readEarnDepositPreview(ok, VAULT, 1n)).toEqual({ ok: true, shares: 5n, queued: false });
    expect(await readEarnRedeemPreview(ok, VAULT, 2n)).toEqual({ ok: true, assets: 9n, queued: false, needsVenue: true });
    expect(await readEarnQueuedPreview(ok, VAULT, 3n)).toEqual({ ok: true, shares: 0n, assets: 8n, headNow: true, needsVenue: false });
    const failing = client(() => { throw new Error("VenueUnreadable()"); });
    expect(await readEarnDepositPreview(failing, VAULT, 1n)).toEqual({ ok: false });
    expect(formatEarnDepositPreview(await readEarnDepositPreview(failing, VAULT, 1n), 18)).toBe(CANNOT_PREVIEW);
    expect(await readOptionRedeemPreview(failing, CH, 4n, HOLDER, HOLDER)).toEqual({ ok: false });
    expect(await readRollPreview(ok, ROLLER, HOLDER, ASSET)).toMatchObject({ ok: true, due: false });
    expect(calls).toEqual(["previewDeposit", "previewRedeem", "previewQueued", "previewRoll"]);
  });
});
