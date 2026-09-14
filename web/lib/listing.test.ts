import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";

import { CLEARINGHOUSE, SEAPORT, USDG } from "./contracts";
import {
  type ExpectedListing,
  REASONS,
  checkListingIsOurs,
  isListingRow,
  isOrderComponents,
  type ListingRow,
  type OrderComponentsJson,
} from "./listing";
import { componentsHash } from "./seaportOrder";

/**
 * One good listing, then one tampering per test.
 *
 * The fixture is a vault listing under write on fill: the vault is offerer AND zone, the order is
 * PARTIAL_RESTRICTED (type 3), one ERC-1155 offer of 20 contracts, ONE USDG leg of 80.000000 USDG
 * (4.000000 per contract) to the vault, zero zone hash, zero conduit key. Every third-party address
 * is the compiled-in one from contracts.ts. The vault has no compiled-in default (it does not exist
 * until deployed), so the test pins one — with hex letters in it, so the case-insensitivity test
 * actually varies the case of something.
 *
 * `expected` carries what the vault's multicall returns: the hash and, from the same
 * approveListing() call, listingAmount, listingGrossUsdg, optionId and conduitKey. HASH is the
 * real Seaport EIP-712 hash of the fixture's components, because the check hashes them and
 * compares.
 *
 * Each tampering must fail with its own reason string — a check that fails for the wrong
 * reason is a check that is not looking at the field it claims to. A tampering that edits the
 * components also moves their hash, so the field checks are run twice where it matters: once as
 * an attacker would serve it (our hash string kept, so `componentsHash` joins the field's own
 * reason) and once `resigned`, as if the vault had authorised the edited order, so the field's
 * reason is shown to stand on its own.
 */
const VAULT_T = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const;
const STRANGER = "0x2222222222222222222222222222222222222222" as const;
/** The Stock Token: a real ERC-20 on this chain that is not USDG. */
const OTHER_ERC20 = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC" as const;
const OTHER_HASH = "0x0000000000000000000000000000000000000000000000000000000000000abc" as const;
const ZERO32 = `0x${"0".repeat(64)}` as const;
const OPTION_ID = "56885395977254369119998982131173877604217583767740146085872832926902011297792";

const NOW = 1_789_000_000;
const END = String(NOW + 3600);

function goodComponents(): OrderComponentsJson {
  return goodListingWithHash("0x" as Hex).components;
}

const HASH = componentsHash(goodComponents())!;

function goodListing(): ListingRow {
  return goodListingWithHash(HASH);
}

/** The listing with its orderHash re-derived from its (edited) components. */
function resigned(l: ListingRow): ListingRow {
  return { ...l, orderHash: componentsHash(l.components)! };
}

function goodListingWithHash(orderHash: Hex): ListingRow {
  return {
    orderHash,
    chainId: 4663,
    offerer: VAULT_T,
    optionId: OPTION_ID,
    quantity: "20",
    remaining: "20",
    unitPrice6: "4000000",
    totalPrice6: "80000000",
    startTime: "0",
    endTime: END,
    salt: "95941992777576660739888578361827826050802484697670100586800480598437555708740",
    counter: "0",
    status: "open",
    components: {
      offerer: VAULT_T,
      zone: VAULT_T,
      offer: [
        {
          itemType: 3,
          token: CLEARINGHOUSE,
          identifierOrCriteria: OPTION_ID,
          startAmount: "20",
          endAmount: "20",
        },
      ],
      consideration: [
        {
          itemType: 1,
          token: USDG,
          identifierOrCriteria: "0",
          startAmount: "80000000",
          endAmount: "80000000",
          recipient: VAULT_T,
        },
      ],
      orderType: 3,
      startTime: "0",
      endTime: END,
      zoneHash: ZERO32,
      salt: "95941992777576660739888578361827826050802484697670100586800480598437555708740",
      conduitKey: ZERO32,
      counter: "0",
    },
    signature: "0x",
  };
}

const expected: ExpectedListing = {
  vault: VAULT_T,
  usdg: USDG,
  clearinghouse: CLEARINGHOUSE,
  seaport: SEAPORT,
  listingHash: HASH,
  chainId: 4663,
  amount: 20n,
  grossUsdg: 80_000_000n,
  optionId: BigInt(OPTION_ID),
  conduitKey: ZERO32,
};

function reasonsOf(listing: ListingRow, override: Partial<typeof expected> = {}): string[] {
  const result = checkListingIsOurs(listing, { ...expected, ...override }, NOW);
  return result.ok ? [] : result.reasons;
}

/** Reasons for a listing whose hash the vault is taken to have authorised: the field checks alone. */
function fieldReasonsOf(listing: ListingRow, override: Partial<typeof expected> = {}): string[] {
  const signed = resigned(listing);
  return reasonsOf(signed, { listingHash: signed.orderHash, ...override });
}

describe("checkListingIsOurs", () => {
  it("accepts the vault's own PARTIAL_RESTRICTED, one-leg, vault-zoned listing", () => {
    expect(checkListingIsOurs(goodListing(), expected, NOW)).toEqual({ ok: true });
  });

  it("is case-insensitive on addresses and hashes", () => {
    const upper = (h: string) => h.toUpperCase().replace("0X", "0x");
    const l = goodListing();
    expect(upper(VAULT_T)).not.toBe(VAULT_T);
    l.components.offerer = upper(VAULT_T);
    l.components.zone = upper(VAULT_T);
    l.offerer = upper(VAULT_T);
    l.components.consideration[0]!.recipient = upper(VAULT_T);
    l.components.offer[0]!.token = upper(CLEARINGHOUSE);
    l.components.consideration[0]!.token = USDG.toLowerCase();
    l.orderHash = upper(HASH) as typeof HASH;
    expect(checkListingIsOurs(l, expected, NOW)).toEqual({ ok: true });
    expect(checkListingIsOurs(goodListing(), { ...expected, vault: upper(VAULT_T) as Address }, NOW)).toEqual({
      ok: true,
    });
  });

  it("rejects a swapped offerer", () => {
    const l = goodListing();
    l.components.offerer = STRANGER;
    l.offerer = STRANGER;
    expect(reasonsOf(l)).toContain(REASONS.seller);
  });

  it("rejects a zone that is not the vault: the fill hook would never run", () => {
    // A zero zone (the pre-redesign shape) is now wrong too: an open order would let Seaport
    // move tokens the vault does not hold, and nothing would be written.
    const zero = goodListing();
    zero.components.zone = "0x0000000000000000000000000000000000000000";
    expect(fieldReasonsOf(zero)).toEqual([REASONS.zone]);
    const stranger = goodListing();
    stranger.components.zone = STRANGER;
    expect(fieldReasonsOf(stranger)).toEqual([REASONS.zone]);
  });

  it("rejects an order type other than PARTIAL_RESTRICTED", () => {
    for (const type of [0, 1, 2, 4]) {
      const l = goodListing();
      l.components.orderType = type;
      expect(fieldReasonsOf(l)).toEqual([REASONS.orderType]);
    }
  });

  it("rejects a non-zero zone hash and a conduit key the vault did not name", () => {
    const zh = goodListing();
    zh.components.zoneHash = `0x${"00".repeat(31)}01`;
    expect(fieldReasonsOf(zh)).toEqual([REASONS.zoneHash]);
    const ck = goodListing();
    ck.components.conduitKey = `0x${"ab".repeat(32)}`;
    expect(fieldReasonsOf(ck)).toEqual([REASONS.conduit]);
    // The vault's own conduit key is what is expected; a vault deployed with one accepts it.
    expect(fieldReasonsOf(ck, { conduitKey: `0x${"ab".repeat(32)}` })).toEqual([]);
    // Unread, the deploy default (zero) is expected.
    expect(fieldReasonsOf(goodListing(), { conduitKey: undefined })).toEqual([]);
  });

  it("rejects a swapped payment recipient", () => {
    const l = goodListing();
    l.components.consideration[0]!.recipient = STRANGER;
    expect(fieldReasonsOf(l)).toEqual([REASONS.writerRecipient]);
  });

  it("rejects a payment leg in a different ERC-20", () => {
    const l = goodListing();
    l.components.consideration[0]!.token = OTHER_ERC20;
    expect(reasonsOf(l)).toContain(REASONS.considerationToken);
  });

  it("rejects an offer that is not a clearinghouse option", () => {
    const l = goodListing();
    l.components.offer[0]!.token = OTHER_ERC20;
    expect(reasonsOf(l)).toContain(REASONS.offerToken);
  });

  it("rejects an order hash that is not the vault's authorised one", () => {
    // A real, self-consistent order: its components hash to its orderHash, which is not ours.
    const other = goodListing();
    other.components.salt = "1";
    expect(reasonsOf(resigned(other))).toEqual([REASONS.hashMismatch]);
    // A made-up string is both not ours and not what the components hash to.
    const l = goodListing();
    l.orderHash = OTHER_HASH;
    expect(reasonsOf(l)).toEqual([REASONS.hashMismatch, REASONS.componentsHash]);
  });

  it("binds salt, counter and start time to the hash: a row cannot keep our hash and edit them", () => {
    // Every field check passes on each of these, and the hash string is ours. Before the
    // components were hashed, each one showed a fill button whose fulfilment would revert.
    const salt = goodListing();
    salt.components.salt = (BigInt(salt.components.salt) + 1n).toString();
    const counter = goodListing();
    counter.components.counter = "7";
    const start = goodListing();
    start.components.startTime = "1";
    for (const l of [salt, counter, start]) {
      expect(reasonsOf(l)).toEqual([REASONS.componentsHash]);
    }
  });

  it("reports components that cannot be hashed as a reason rather than throwing", () => {
    const l = goodListing();
    l.components.offer[0]!.startAmount = "twenty";
    expect(() => checkListingIsOurs(l, expected, NOW)).not.toThrow();
    expect(reasonsOf(l)).toContain(REASONS.componentsHash);
  });

  it("refuses while the vault's hash is unread or empty", () => {
    expect(reasonsOf(goodListing(), { listingHash: undefined })).toEqual([REASONS.hashUnread]);
    expect(reasonsOf(goodListing(), { listingHash: ZERO32 as Hex })).toEqual([REASONS.hashNone]);
  });

  it("rejects an expired endTime", () => {
    const l = goodListing();
    l.components.endTime = String(NOW - 1);
    expect(reasonsOf(l)).toContain(REASONS.expired);
    const edge = goodListing();
    edge.components.endTime = String(NOW);
    expect(reasonsOf(edge)).toContain(REASONS.expired);
  });

  it("rejects a second payment leg: there is no fee leg any more", () => {
    // The pre-redesign shape carried a 5% third-party fee leg. The vault now refuses any order
    // with more than one consideration item (BadConsiderationLength), and so does this check.
    const l = goodListing();
    l.components.consideration.push({
      itemType: 1,
      token: USDG,
      identifierOrCriteria: "0",
      startAmount: "4000000",
      endAmount: "4000000",
      recipient: STRANGER,
    });
    expect(fieldReasonsOf(l, { grossUsdg: undefined })).toEqual([REASONS.considerationShape]);
    const none = goodListing();
    none.components.consideration = [];
    expect(fieldReasonsOf(none, { grossUsdg: undefined })).toContain(REASONS.considerationShape);
  });

  it("rejects a gross that does not divide by the contract count", () => {
    // 20 contracts for 80.000001 USDG: Seaport cannot fill k/20 of that exactly (InexactFraction),
    // and the vault refuses it at approveListing (PremiumNotDivisibleByOrderSize).
    const l = goodListing();
    l.components.consideration[0]!.startAmount = "80000001";
    l.components.consideration[0]!.endAmount = "80000001";
    expect(fieldReasonsOf(l, { grossUsdg: 80_000_001n })).toEqual([REASONS.notDivisible]);
    const fine = goodListing();
    fine.components.consideration[0]!.startAmount = "80000020";
    fine.components.consideration[0]!.endAmount = "80000020";
    expect(fieldReasonsOf(fine, { grossUsdg: 80_000_020n })).toEqual([]);
  });

  it("rejects a contract count that is not the vault's listingAmount", () => {
    // Same hash, same unit price, twice the size: the denominator the page would send is not
    // the one Seaport holds, and the buyer's cost for k contracts would still add up.
    const l = goodListing();
    l.components.offer[0]!.startAmount = "40";
    l.components.offer[0]!.endAmount = "40";
    l.components.consideration[0]!.startAmount = "160000000";
    l.components.consideration[0]!.endAmount = "160000000";
    expect(reasonsOf(l)).toEqual([REASONS.amountMismatch, REASONS.grossMismatch, REASONS.componentsHash]);
    expect(fieldReasonsOf(l)).toEqual([REASONS.amountMismatch, REASONS.grossMismatch]);
    expect(fieldReasonsOf(l, { amount: 40n, grossUsdg: 160_000_000n })).toEqual([]);
  });

  it("rejects a price that is not the vault's listingGrossUsdg", () => {
    // Our hash, our addresses, a divisible gross — at ten times the price. Only the chain's
    // number catches this before approve().
    const l = goodListing();
    l.components.consideration[0]!.startAmount = "800000000";
    l.components.consideration[0]!.endAmount = "800000000";
    expect(reasonsOf(l)).toEqual([REASONS.grossMismatch, REASONS.componentsHash]);
    expect(fieldReasonsOf(l)).toEqual([REASONS.grossMismatch]);
  });

  it("rejects an option id that is not the vault's optionId", () => {
    const l = goodListing();
    l.components.offer[0]!.identifierOrCriteria = "12345";
    expect(reasonsOf(l)).toEqual([REASONS.optionIdMismatch, REASONS.componentsHash]);
    expect(fieldReasonsOf(l)).toEqual([REASONS.optionIdMismatch]);
  });

  it("falls back to a hash-only check when the caller has no on-chain amounts", () => {
    const l = goodListing();
    l.components.consideration[0]!.startAmount = "800000000";
    l.components.consideration[0]!.endAmount = "800000000";
    l.components.offer[0]!.identifierOrCriteria = "12345";
    const noAmounts = { amount: undefined, grossUsdg: undefined, optionId: undefined };
    expect(fieldReasonsOf(l, noAmounts)).toEqual([]);
    // Even without the amounts, the hash is now bound to the components: our hash string on
    // edited components is refused.
    expect(reasonsOf(l, noAmounts)).toEqual([REASONS.componentsHash]);
  });

  it("reports a malformed amount as a reason rather than throwing", () => {
    const l = goodListing();
    l.components.consideration[0]!.startAmount = "1e6";
    l.components.consideration[0]!.endAmount = "1e6";
    expect(() => checkListingIsOurs(l, expected, NOW)).not.toThrow();
    expect(reasonsOf(l)).toEqual([REASONS.malformedAmount, REASONS.componentsHash]);

    const badId = goodListing();
    badId.components.offer[0]!.identifierOrCriteria = "0xabc";
    expect(reasonsOf(badId)).toEqual([REASONS.malformedAmount, REASONS.componentsHash]);
  });

  it("rejects an amount that drifts between start and end", () => {
    const l = goodListing();
    l.components.consideration[0]!.endAmount = "800000000";
    expect(reasonsOf(l)).toContain(REASONS.amountsDrift);
  });

  it("collects every reason rather than stopping at the first", () => {
    const l = goodListing();
    l.components.offerer = STRANGER;
    l.offerer = STRANGER;
    l.components.zone = STRANGER;
    l.orderHash = OTHER_HASH;
    expect(reasonsOf(l)).toEqual([REASONS.seller, REASONS.zone, REASONS.hashMismatch, REASONS.componentsHash]);
  });

  it("rejects a row whose offerer disagrees with the order's components", () => {
    const l = goodListing();
    l.offerer = STRANGER;
    expect(reasonsOf(l)).toEqual([REASONS.offererMismatch]);
  });

  it("fails without a configured vault", () => {
    expect(reasonsOf(goodListing(), { vault: undefined })).toContain(REASONS.noVault);
  });
});

describe("isListingRow", () => {
  it("accepts the fixture and its components, with an empty signature", () => {
    const l = goodListing();
    expect(isOrderComponents(l.components)).toBe(true);
    expect(isListingRow(l)).toBe(true);
    expect(l.signature).toBe("0x");
  });

  it("allows unknown extra keys", () => {
    expect(isListingRow({ ...goodListing(), somethingNew: { nested: true } })).toBe(true);
  });

  it("rejects a listing with components missing", () => {
    const { components: _components, ...rest } = goodListing();
    expect(isListingRow(rest)).toBe(false);
    expect(isListingRow({ ...rest, components: null })).toBe(false);
    expect(isListingRow({ ...rest, components: {} })).toBe(false);
  });

  it("rejects malformed fields that would blow up or mis-encode in the fill", () => {
    const base = goodListing();
    expect(isListingRow({ ...base, orderHash: "0x1234" })).toBe(false);
    expect(isListingRow({ ...base, signature: "not hex" })).toBe(false);
    expect(isListingRow({ ...base, status: 1 })).toBe(false);
    expect(isListingRow({ ...base, quantity: "twenty" })).toBe(false);

    const badItem = goodListing();
    badItem.components.consideration[0]!.startAmount = "1e6";
    expect(isOrderComponents(badItem.components)).toBe(false);

    const noRecipient = goodListing();
    delete (noRecipient.components.consideration[0] as { recipient?: string }).recipient;
    expect(isOrderComponents(noRecipient.components)).toBe(false);

    const floatEnum = goodListing();
    floatEnum.components.orderType = 1.5;
    expect(isOrderComponents(floatEnum.components)).toBe(false);
  });

  it("rejects non-objects", () => {
    expect(isListingRow(null)).toBe(false);
    expect(isListingRow("listing")).toBe(false);
    expect(isListingRow([goodListing()])).toBe(false);
  });
});
