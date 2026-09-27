/**
 * The claim button's state is HouseVault.claim()'s own test (the `retired` flag at the end of `claim`): a
 * queued deposit or withdrawal whose epochId is before the vault's epochId. The case hit on a v9 fork is the
 * first one below: a withdrawal requested in the CURRENT epoch is pending, and claim() refuses it.
 */
import { describe, expect, it } from "vitest";

import { formatNewYork } from "./houseEpoch";
import {
  HOUSE_CLAIM_DEPOSIT_REFUSED, HOUSE_CLAIM_NOTHING_READY, HOUSE_CLAIM_PAYS_NOTHING, houseClaimAmountLine, houseClaimAmounts,
  houseClaimAmountsText, houseClaimDoneLine, houseClaimLine, houseClaimState,
} from "./houseClaim";

const EPOCH = 12n;
const noDeposit = { epochId: 0n, usdg: 0n, stock: 0n };
const noWithdraw = { epochId: 0n, shares: 0n };
const at = (over: Partial<{ epochId: bigint | null; withdrawRequest: unknown; depositRequest: unknown }>) =>
  ({ epochId: EPOCH, withdrawRequest: noWithdraw, depositRequest: noDeposit, ...over }) as Parameters<typeof houseClaimState>[0];

describe("houseClaimState mirrors claim()", () => {
  it("a withdrawal queued in the current epoch is pending, not claimable", () => {
    expect(houseClaimState(at({ withdrawRequest: { epochId: EPOCH, shares: 5n } }))).toEqual({ kind: "pending" });
  });

  it("a withdrawal queued in an earlier epoch is ready", () => {
    expect(houseClaimState(at({ withdrawRequest: { epochId: EPOCH - 1n, shares: 5n } }))).toEqual({ kind: "ready" });
  });

  it("a matured deposit is ready too: claim() retires either leg", () => {
    expect(houseClaimState(at({ depositRequest: { epochId: 3n, usdg: 1n, stock: 0n } }))).toEqual({ kind: "ready" });
    expect(houseClaimState(at({ depositRequest: { epochId: 3n, usdg: 0n, stock: 7n } }))).toEqual({ kind: "ready" });
    expect(houseClaimState(at({ depositRequest: { epochId: EPOCH, usdg: 1n, stock: 0n } }))).toEqual({ kind: "pending" });
  });

  it("a request slot with a past epoch but nothing in it is nothing: claim() tests the amounts, not the epoch", () => {
    // A deleted request reads back as all zeros; a stale epochId alone must not make the button live.
    expect(houseClaimState(at({ withdrawRequest: { epochId: 3n, shares: 0n }, depositRequest: { epochId: 3n, usdg: 0n, stock: 0n } })))
      .toEqual({ kind: "none" });
    expect(houseClaimState(at({}))).toEqual({ kind: "none" });
  });

  it("fails closed: unread and failed reads are never ready", () => {
    expect(houseClaimState(undefined)).toEqual({ kind: "unread" });
    expect(houseClaimState(null)).toEqual({ kind: "unread" });
    // A fixture from before these fields existed, or a response without them.
    expect(houseClaimState({} as Parameters<typeof houseClaimState>[0])).toEqual({ kind: "unread" });
    expect(houseClaimState(at({ epochId: null, withdrawRequest: { epochId: 1n, shares: 5n } }))).toEqual({ kind: "unknown" });
    expect(houseClaimState(at({ withdrawRequest: null }))).toEqual({ kind: "unknown" });
    expect(houseClaimState(at({ depositRequest: null, withdrawRequest: { epochId: 1n, shares: 5n } }))).toEqual({ kind: "unknown" });
  });
});

describe("houseClaimLine says why the button is off and when that changes", () => {
  const END = 1_760_604_800;

  it("says nothing when the claim is ready", () => {
    expect(houseClaimLine({ kind: "ready" }, END, END - 10)).toBeNull();
  });

  it("a pending request names the close it matures at", () => {
    expect(houseClaimLine({ kind: "pending" }, END, END - 10)).toBe(`Claimable after this epoch closes at ${formatNewYork(END)}.`);
    expect(houseClaimLine({ kind: "pending" }, null, END)).toBe("Claimable after this epoch closes.");
    // Past the scheduled end but not yet rolled on chain: claim() still refuses, and the line says why.
    expect(houseClaimLine({ kind: "pending" }, END, END)).toBe("This epoch's close is due. Claimable as soon as the vault records it.");
  });

  it("nothing queued, unread and unreadable each say so", () => {
    expect(houseClaimLine({ kind: "none" }, END, 0)).toMatch(/^Nothing to claim\./);
    expect(houseClaimLine({ kind: "unread" }, END, 0)).toMatch(/Checking/);
    expect(houseClaimLine({ kind: "unknown" }, END, 0)).toMatch(/Could not read/);
  });

  it("the claim refusal copy is plain words about timing, not the shared quantity text", () => {
    expect(HOUSE_CLAIM_NOTHING_READY).toBe("Nothing is ready to claim yet; it pays after the next close.");
    expect(HOUSE_CLAIM_NOTHING_READY).not.toMatch(/share steps|quantity/i);
  });
});

/**
 * The amount beside the claim button is the vault's own `claimable(account)`, passed through. It
 * never decides whether the button is on: a matured request can quote (0, 0, 0) and must still be claimed, because
 * requestDeposit / requestWithdraw refuse TooEarly until claim() retires it.
 */
describe("what the claim pays, from claimable(account)", () => {
  const ready = { kind: "ready" } as const;
  // 1.5 shares (18 dp), 12.34 USDG (6 dp), 0.25 Stock Tokens (18 dp).
  const amounts = { shares: 1_500_000_000_000_000_000n, usdg: 12_340_000n, stock: 250_000_000_000_000_000n };

  it("decodes the (shares, usdgAmount, stockAmount) triple viem returns, and nothing else", () => {
    expect(houseClaimAmounts([1n, 2n, 3n])).toEqual({ shares: 1n, usdg: 2n, stock: 3n });
    expect(houseClaimAmounts([0n, 0n, 0n])).toEqual({ shares: 0n, usdg: 0n, stock: 0n });
    // The earlier claim() returned nothing: viem decodes that as undefined, which is not a zero quote.
    expect(houseClaimAmounts(undefined)).toBeNull();
    expect(houseClaimAmounts(null)).toBeNull();
    expect(houseClaimAmounts([1n, 2n])).toBeNull();
    expect(houseClaimAmounts([1n, 2n, 3])).toBeNull();
  });

  it("formats each leg at its own decimals and names only the non-zero ones", () => {
    expect(houseClaimAmountsText(amounts)).toBe("1.5 shares, 12.34 USDG and 0.25 Stock Tokens");
    expect(houseClaimAmountsText({ shares: 0n, usdg: 12_340_000n, stock: 250_000_000_000_000_000n })).toBe("12.34 USDG and 0.25 Stock Tokens");
    expect(houseClaimAmountsText({ shares: 0n, usdg: 12_340_000n, stock: 0n })).toBe("12.34 USDG");
    expect(houseClaimAmountsText({ shares: 0n, usdg: 0n, stock: 0n })).toBeNull();
  });

  it("a ready claim shows the vault's quote beside the button", () => {
    expect(houseClaimAmountLine(ready, amounts)).toBe("Claim pays 1.5 shares, 12.34 USDG and 0.25 Stock Tokens.");
  });

  it("a matured request quoted at (0, 0, 0) still says to claim it, because claim() must still retire it", () => {
    const line = houseClaimAmountLine(ready, { shares: 0n, usdg: 0n, stock: 0n });
    expect(line).toBe(HOUSE_CLAIM_PAYS_NOTHING);
    expect(line).toMatch(/Claim it anyway/);
  });

  it("shows nothing when the claim is not ready or the view was not read, never a guessed figure", () => {
    for (const state of [{ kind: "pending" }, { kind: "none" }, { kind: "unread" }, { kind: "unknown" }] as const)
      expect(houseClaimAmountLine(state, amounts)).toBeNull();
    expect(houseClaimAmountLine(ready, null)).toBeNull();
    expect(houseClaimAmountLine(ready, undefined)).toBeNull();
  });

  it("the confirmation prefers the receipt's Claimed log, falls back to claim()'s simulated return, and never errors", () => {
    expect(houseClaimDoneLine({ paid: amounts, quoted: null })).toBe("Claim confirmed. It paid 1.5 shares, 12.34 USDG and 0.25 Stock Tokens.");
    expect(houseClaimDoneLine({ paid: null, quoted: { shares: 0n, usdg: 12_340_000n, stock: 0n } }))
      .toBe("Claim confirmed. The vault quoted 12.34 USDG when you sent it.");
    expect(houseClaimDoneLine({ paid: { shares: 0n, usdg: 0n, stock: 0n }, quoted: amounts }))
      .toBe("Claim confirmed. It paid nothing and cleared your matured request.");
    expect(houseClaimDoneLine({ paid: null, quoted: null })).toBe("Claim confirmed.");
  });
});

/**
 * When the close REFUSED the matured deposit (HouseVault epochRates `depositRefused`), the amount
 * beside Claim is that deposit coming back, and the line says so. Only an explicit true says it: an unread flag (null)
 * or no matured deposit says nothing about a refusal.
 */
describe("a refused deposit is shown as returned", () => {
  const ready = { kind: "ready" } as const;
  const refund = { shares: 0n, usdg: 12_340_000n, stock: 0n };

  it("a refused deposit's quote is introduced as the deposit returned, not shares", () => {
    expect(houseClaimAmountLine(ready, refund, true)).toBe(`${HOUSE_CLAIM_DEPOSIT_REFUSED} Claim pays 12.34 USDG.`);
    expect(HOUSE_CLAIM_DEPOSIT_REFUSED).toMatch(/refused your deposit, so the claim returns it/);
  });

  it("a priced deposit (false), an unread flag (null) and no flag at all keep the plain line", () => {
    for (const flag of [false, null, undefined]) expect(houseClaimAmountLine(ready, refund, flag)).toBe("Claim pays 12.34 USDG.");
  });

  it("the flag never makes a line appear where there was none", () => {
    expect(houseClaimAmountLine({ kind: "pending" }, refund, true)).toBeNull();
    expect(houseClaimAmountLine(ready, null, true)).toBeNull();
  });
});
