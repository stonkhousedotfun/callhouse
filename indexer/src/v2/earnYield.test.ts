import { describe, expect, it } from "vitest";

import {
  DAY_S, ONE_SHARE, classifySkimmed, earnEarliestWithdrawal, houseEarliestWithdrawal, netOfSkim, pricePerShare,
  realisedSamplePrice, trailingApy, unescrowed, venueLiquidity,
} from "./earnYield";

const NOW = 1_800_000_000;

describe("share price and the skim", () => {
  it("mirrors EarnVault._pricePerShare and refuses a price for an empty supply", () => {
    expect(pricePerShare(1_050_000n, 1_000_000n)).toBe((1_050_000n * ONE_SHARE) / 1_000_000n);
    // The contract answers 0 here; a stored 0 would later read as a total loss, so this says "no price".
    expect(pricePerShare(5n, 0n)).toBeNull();
    expect(pricePerShare(null, 1n)).toBeNull();
    expect(pricePerShare(1n, null)).toBeNull();
  });

  it("charges the pending skim only above the high-water mark", () => {
    const mark = 1_000_000_000_000_000_000n;
    // 10% of a 5% gain: the holder keeps 4.5%.
    expect(netOfSkim(1_050_000_000_000_000_000n, mark, 1_000)).toBe(1_045_000_000_000_000_000n);
    // At or below the mark nothing is charged (EarnVault.skim: a flat or losing period takes ZERO).
    expect(netOfSkim(mark, mark, 1_000)).toBe(mark);
    expect(netOfSkim(990_000_000_000_000_000n, mark, 1_000)).toBe(990_000_000_000_000_000n);
    // A 0 bps skim charges nothing; an unread input is unread.
    expect(netOfSkim(1_050_000_000_000_000_000n, mark, 0)).toBe(1_050_000_000_000_000_000n);
    expect(netOfSkim(1n, null, 1_000)).toBeNull();
    expect(netOfSkim(1n, 1n, null)).toBeNull();
  });

  it("a mark that rises on a deposit is not yield", () => {
    const price = 1_100_000n;
    const netBefore = netOfSkim(price, 1_000_000n, 1_000);
    const netAfter = netOfSkim(price, price, 1_000);
    expect(netBefore).toBe(1_090_000n);
    expect(netAfter).toBe(price);
    // The gross share price did not move. Realised APY is that price, so the window is flat.
    expect(realisedSamplePrice({ pricePerShare: price, netPricePerShare: netBefore })).toBe(price);
    expect(trailingApy({ ts: NOW, price }, { ts: NOW - 7 * DAY_S, price }, 7 * DAY_S).bps).toBe(0);
    // The net-of-mark series did move. Using it as the yield series would publish a gain that is the mark.
    const fromMark = trailingApy(
      { ts: NOW, price: netAfter! },
      { ts: NOW - 7 * DAY_S, price: netBefore! },
      7 * DAY_S,
    );
    expect(fromMark.bps).not.toBe(0);
  });
});

describe("Skimmed labels", () => {
  it("tells a collected fee, a flat skim, a zero rate, and a refused fee apart", () => {
    expect(classifySkimmed(1_000n, 100n, 1_000)).toBe("collected");
    expect(classifySkimmed(0n, 0n, 1_000)).toBe("nothing");
    expect(classifySkimmed(1_000n, 0n, 0)).toBe("zero-rate");
    expect(classifySkimmed(1_000n, 0n, 1_000)).toBe("refused");
    expect(classifySkimmed(1_000n, 0n, null)).toBe("refused");
  });

  it("a gain whose fee rounds to nothing at the rate is dust (the mark moved), not a refused fee", () => {
    // EarnVault._skimFeeOn(gain) = gain * skimBps / BPS. At 1000 bps a gain of 9 charges 0 and 10 charges 1.
    expect(classifySkimmed(9n, 0n, 1_000)).toBe("dust");
    expect(classifySkimmed(10n, 0n, 1_000)).toBe("refused");
    // At 1 bps the fee is a whole unit only from a gain of 10,000.
    expect(classifySkimmed(9_999n, 0n, 1)).toBe("dust");
    expect(classifySkimmed(10_000n, 0n, 1)).toBe("refused");
    // An unseen rate still fails closed, however small the gain.
    expect(classifySkimmed(1n, 0n, null)).toBe("refused");
    // A fee that left is collected whatever the arithmetic says.
    expect(classifySkimmed(9n, 1n, 1_000)).toBe("collected");
  });
});

describe("trailing APY", () => {
  it("compounds a measured 7-day growth to a year", () => {
    const start = { ts: NOW - 7 * DAY_S, price: 1_000_000n };
    const end = { ts: NOW, price: 1_001_000n }; // +0.1% in 7 days
    const apy = trailingApy(end, start, 7 * DAY_S);
    expect(apy.reason).toBeNull();
    expect(apy.from).toBe(start.ts);
    expect(apy.to).toBe(end.ts);
    // (1.001)^(365/7) - 1 = 5.3486...% -> 535 bps.
    expect(apy.bps).toBe(Math.round((Math.pow(1.001, 365 / 7) - 1) * 10_000));
    expect(apy.bps).toBe(535);
  });

  it("is signed: a vault that lost money reports a negative figure", () => {
    const apy = trailingApy({ ts: NOW, price: 999_000n }, { ts: NOW - 7 * DAY_S, price: 1_000_000n }, 7 * DAY_S);
    expect(apy.bps).toBeLessThan(0);
    expect(apy.reason).toBeNull();
  });

  it("annualises over the ACTUAL span when sampling had a gap longer than the window", () => {
    const start = { ts: NOW - 10 * DAY_S, price: 1_000_000n };
    const apy = trailingApy({ ts: NOW, price: 1_001_000n }, start, 7 * DAY_S);
    expect(apy.bps).toBe(Math.round((Math.pow(1.001, 365 / 10) - 1) * 10_000));
    expect(apy.from).toBe(start.ts);
  });

  it("never extrapolates: less history than the window is null with short-history", () => {
    expect(trailingApy({ ts: NOW, price: 2n }, undefined, 7 * DAY_S))
      .toEqual({ bps: null, reason: "short-history", from: null, to: NOW });
    // A start the caller handed in that sits inside the window is refused the same way, not annualised.
    expect(trailingApy({ ts: NOW, price: 2n }, { ts: NOW - 6 * DAY_S, price: 1n }, 7 * DAY_S))
      .toEqual({ bps: null, reason: "short-history", from: null, to: NOW });
  });

  it("says no-samples and no-price rather than inventing a number", () => {
    expect(trailingApy(undefined, undefined, 7 * DAY_S)).toEqual({ bps: null, reason: "no-samples", from: null, to: null });
    expect(trailingApy({ ts: NOW, price: 5n }, { ts: NOW - 7 * DAY_S, price: 0n }, 7 * DAY_S))
      .toEqual({ bps: null, reason: "no-price", from: NOW - 7 * DAY_S, to: NOW });
  });

  it("refuses a figure that is not a safe integer of bps", () => {
    const apy = trailingApy({ ts: NOW, price: 10n ** 30n }, { ts: NOW - DAY_S, price: 1n }, DAY_S);
    expect(apy).toEqual({ bps: null, reason: "out-of-range", from: NOW - DAY_S, to: NOW });
  });
});

describe("venue liquidity", () => {
  it("uses the POSITION on an advisory (Morpho Vault V2-shaped) venue, never withdrawable() = 0", () => {
    // Steakhouse USDG on 4663 is a Morpho Vault V2: maxDeposit reads 0, so the adapter is advisory and its
    // withdrawable() is 0 by design while withdraw() still pays through _withdrawAdvisory.
    expect(venueLiquidity({ advisory: true, withdrawable: 0n, position: 7_000_000n }))
      .toEqual({ amount: 7_000_000n, source: "position" });
  });

  it("uses maxWithdraw on a standard ERC-4626 venue, where it is the real bound", () => {
    expect(venueLiquidity({ advisory: false, withdrawable: 3_000_000n, position: 7_000_000n }))
      .toEqual({ amount: 3_000_000n, source: "maxWithdraw" });
  });

  it("does not guess when the advisory flag or the needed figure is unread", () => {
    expect(venueLiquidity({ advisory: null, withdrawable: 3n, position: 7n })).toEqual({ amount: null, source: null });
    expect(venueLiquidity({ advisory: true, withdrawable: 3n, position: null })).toEqual({ amount: null, source: null });
    expect(venueLiquidity({ advisory: false, withdrawable: null, position: 7n })).toEqual({ amount: null, source: null });
  });

  it("floors the wallet at the queued-deposit escrow, as _unescrowed does", () => {
    expect(unescrowed(10n, 4n, 0n)).toBe(6n);
    expect(unescrowed(3n, 4n, 0n)).toBe(0n);
    expect(unescrowed(null, 4n, 0n)).toBeNull();
    expect(unescrowed(10n, null, 0n)).toBeNull();
  });

  // `_deliverable` reserves escrowedAssets + deferredAssets; payments held for claimDeferred are not liquid.
  it("subtracts the payments held for claimDeferred as well, saturating at zero exactly as _deliverable does", () => {
    expect(unescrowed(10n, 4n, 3n)).toBe(3n);
    expect(unescrowed(10n, 0n, 7n)).toBe(3n);
    expect(unescrowed(10n, 4n, 6n), "deferred plus escrow equal to the wallet: nothing liquid").toBe(0n);
    expect(unescrowed(10n, 0n, 12n), "deferred above the wallet: 0, never negative").toBe(0n);
  });

  it("a deferredAssets() read that failed is unknown: null, never read as 0", () => {
    expect(unescrowed(10n, 4n, null)).toBeNull();
  });
});

describe("earliest withdrawal: EarnVault, one test per branch of redeem", () => {
  // `ledger` is Clearinghouse.free(vault, asset), which `_raise` also pulls. Zero here, so these cases keep
  // describing a vault with nothing on the ledger; the ledger term's own cases are in derivedStates.test.ts.
  const liquid = {
    now: NOW, positionOpen: false, positionExpiry: null, queueOpen: false, venueUnreadable: false,
    wallet: 2_000_000n, ledger: 0n, venueAttached: true, venue: 5_000_000n,
  };

  it("now: flat, no queue, and wallet plus venue can raise it -- with the cap", () => {
    expect(earnEarliestWithdrawal(liquid))
      .toEqual({ kind: "now", at: NOW, reason: "liquid", liquidityCap: "7000000" });
  });

  it("now with no venue attached: _raise has only the wallet", () => {
    expect(earnEarliestWithdrawal({ ...liquid, venueAttached: false, venue: null }))
      .toEqual({ kind: "now", at: NOW, reason: "liquid", liquidityCap: "2000000" });
  });

  it("queued, open-position: at is the latest expiry still held", () => {
    expect(earnEarliestWithdrawal({ ...liquid, positionOpen: true, positionExpiry: NOW + 3_600 }))
      .toEqual({ kind: "queued", at: NOW + 3_600, reason: "open-position", liquidityCap: null });
    // Open position wins over an open queue and over liquidity: redeem checks it first.
    expect(earnEarliestWithdrawal({ ...liquid, positionOpen: true, positionExpiry: null, queueOpen: true }))
      .toEqual({ kind: "queued", at: null, reason: "open-position", liquidityCap: null });
  });

  it("queued, queue-ahead: a queue is open, so the redemption joins its back", () => {
    expect(earnEarliestWithdrawal({ ...liquid, queueOpen: true }))
      .toEqual({ kind: "queued", at: null, reason: "queue-ahead", liquidityCap: null });
  });

  it("queued, venue-liquidity: nothing can be raised now", () => {
    expect(earnEarliestWithdrawal({ ...liquid, wallet: 0n, venue: 0n }))
      .toEqual({ kind: "queued", at: null, reason: "venue-liquidity", liquidityCap: "0" });
  });

  it("queued, venue-unreadable: the vault prices nothing while its venue cannot be read, even with cash", () => {
    // Without the rule this is "now, liquid, 7000000": redeem would queue it, the page would say paid now.
    expect(earnEarliestWithdrawal({ ...liquid, venueUnreadable: true }))
      .toEqual({ kind: "queued", at: null, reason: "venue-unreadable", liquidityCap: null });
    // Named before an open queue (processQueue serves nothing, so the queue waits on the venue too), and
    // after an open position, as redeem checks it. The queued cards read this reason.
    expect(earnEarliestWithdrawal({ ...liquid, venueUnreadable: true, queueOpen: true }))
      .toEqual({ kind: "queued", at: null, reason: "venue-unreadable", liquidityCap: null });
    expect(earnEarliestWithdrawal({ ...liquid, venueUnreadable: true, queueOpen: null }))
      .toEqual({ kind: "queued", at: null, reason: "venue-unreadable", liquidityCap: null });
    // An unread probe still lets an open queue say queue-ahead (it joins the back either way).
    expect(earnEarliestWithdrawal({ ...liquid, venueUnreadable: null, queueOpen: true }))
      .toEqual({ kind: "queued", at: null, reason: "queue-ahead", liquidityCap: null });
    expect(earnEarliestWithdrawal({ ...liquid, venueUnreadable: true, positionOpen: true, positionExpiry: NOW + 60 }))
      .toEqual({ kind: "queued", at: NOW + 60, reason: "open-position", liquidityCap: null });
  });

  it("unknown, not-read: any input the decision needs is unread, never guessed", () => {
    const notRead = { kind: "unknown", at: null, reason: "not-read", liquidityCap: null };
    expect(earnEarliestWithdrawal({ ...liquid, positionOpen: null })).toEqual(notRead);
    expect(earnEarliestWithdrawal({ ...liquid, queueOpen: null })).toEqual(notRead);
    expect(earnEarliestWithdrawal({ ...liquid, wallet: null })).toEqual(notRead);
    expect(earnEarliestWithdrawal({ ...liquid, venue: null })).toEqual(notRead);
    expect(earnEarliestWithdrawal({ ...liquid, ledger: null })).toEqual(notRead);
    // An unread venue probe is not "liquid" either.
    expect(earnEarliestWithdrawal({ ...liquid, venueUnreadable: null })).toEqual(notRead);
  });
});

describe("earliest withdrawal: HouseVault, per kind", () => {
  const windowS = 1_800;

  it("weekly and daily: the current epoch's end, before the queue cutoff", () => {
    expect(houseEarliestWithdrawal({ now: NOW, kind: "weekly", epochEnd: NOW + 5 * DAY_S, settlementWindow: windowS }))
      .toEqual({ kind: "weekly", at: NOW + 5 * DAY_S, reason: "epoch-boundary" });
    expect(houseEarliestWithdrawal({ now: NOW, kind: "daily", epochEnd: NOW + 3_600, settlementWindow: windowS }))
      .toEqual({ kind: "daily", at: NOW + 3_600, reason: "epoch-boundary" });
  });

  it("the queue is open one second before the cutoff and closed from the cutoff until the roll", () => {
    const end = NOW + 10_000;
    const next = end + 86_400;
    expect(houseEarliestWithdrawal({ now: end - windowS - 1, kind: "daily", epochEnd: end, settlementWindow: windowS }))
      .toEqual({ kind: "daily", at: end, reason: "epoch-boundary" });
    expect(houseEarliestWithdrawal({ now: end - windowS, kind: "daily", epochEnd: end, settlementWindow: windowS, nextEpochEnd: next }))
      .toEqual({ kind: "daily", at: next, reason: "queue-closed" });
    expect(houseEarliestWithdrawal({ now: end, kind: "daily", epochEnd: end, settlementWindow: windowS }))
      .toEqual({ kind: "daily", at: null, reason: "queue-closed" });
    expect(houseEarliestWithdrawal({ now: end + 60, kind: "weekly", epochEnd: end, settlementWindow: windowS, nextEpochEnd: next }))
      .toEqual({ kind: "weekly", at: next, reason: "queue-closed" });
  });

  it("an unknown kind keeps its end before the cutoff; an unread end is not-read", () => {
    expect(houseEarliestWithdrawal({ now: NOW, kind: "unknown", epochEnd: NOW + 10_000, settlementWindow: windowS }))
      .toEqual({ kind: "unknown", at: NOW + 10_000, reason: "epoch-boundary" });
    expect(houseEarliestWithdrawal({ now: NOW, kind: "weekly", epochEnd: null, settlementWindow: windowS }))
      .toEqual({ kind: "weekly", at: null, reason: "not-read" });
  });
});
