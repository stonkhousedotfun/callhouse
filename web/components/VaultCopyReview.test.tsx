import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useAccount, useWriteContract } from "wagmi";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CHAIN_ID } from "@/lib/chain";
import type { AccountPosition, VaultSnapshot } from "@/lib/hooks";
import type { ListingRow } from "@/lib/listing";

import { CyclePricing } from "./CyclePricing";
import { CycleTape } from "./CycleTape";
import { GuardBadges, PhaseBadge } from "./PhaseBadge";
import { PositionSplit } from "./PositionSplit";
import { RedeemQueue } from "./RedeemQueue";
import { StrandedBanner } from "./StrandedBanner";
import { UsdgClaim } from "./UsdgClaim";

/**
 * SSR checks on the copy of the shared legacy-vault components that have no test of their own (RedeemQueue,
 * StrandedBanner, UsdgClaim, CycleTape, PositionSplit, PhaseBadge, CyclePricing). The copy rules: short,
 * plain words; the longer explanation behind a "?" InfoTip, never a `title` (invisible to touch); no internal terms;
 * numbers through the formatters. Every disclosure that moved is asserted where it now lives, so a later
 * trim cannot drop one silently.
 */

vi.mock("wagmi", () => ({ useAccount: vi.fn(), useWriteContract: vi.fn() }));
vi.mock("./ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("./TxToast", () => ({ useTxRunner: () => vi.fn() }));
vi.mock("@/lib/hooks", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/hooks")>()), useNow: () => NOW }));

const NOW = 1_790_186_400;
const E18 = 10n ** 18n;
const ADDRESS = "0x00000000000000000000000000000000000000a1";

function account(connected: boolean) {
  vi.mocked(useAccount).mockReturnValue(
    (connected ? { address: ADDRESS, isConnected: true, chainId: CHAIN_ID } : { address: undefined, isConnected: false, chainId: undefined }) as unknown as ReturnType<typeof useAccount>,
  );
}

beforeEach(() => {
  account(false);
  vi.mocked(useWriteContract).mockReturnValue({ writeContractAsync: vi.fn() } as unknown as ReturnType<typeof useWriteContract>);
});

const snap = (over: Partial<VaultSnapshot>) => over as VaultSnapshot;
const pos = (over: Partial<AccountPosition>) => ({ ready: true, ...over }) as AccountPosition;

const TOOLTIP = /<span role="tooltip"[^>]*>([\s\S]*?)<\/span>/g;

/** What a sighted reader sees before opening any "?": tags, tooltips and comments stripped, entities decoded. */
function visible(html: string): string {
  return html
    .replace(TOOLTIP, " ")
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** The InfoTip bubbles' text, in order. */
function tips(html: string): string[] {
  return [...html.matchAll(TOOLTIP)].map((m) => visible(m[1]!));
}

/** Internal words ruled out of visible copy, plus contract function and error names. */
const JARGON = /\bepochs?\b|boundar|\bNAV\b|StillStranded|previewCompleteRedeem|completeRedeem|settleQueue|retryStrandedClaim|rollClose|Valorem|Seaport/i;

function expectPlain(html: string) {
  expect(visible(html)).not.toMatch(JARGON);
  // A `title` is invisible to touch and keyboard readers: explanations live in InfoTips now.
  expect(html).not.toMatch(/ title="/);
}

describe("RedeemQueue", () => {
  const position = pos({ shares: 5n * E18, queuedShares: 0n, pendingAssets: 0n, pendingUsdg: 0n });

  it("each withdrawal path in one short line, the detail behind a \"?\"", () => {
    const loading = renderToStaticMarkup(createElement(RedeemQueue, { snapshot: snap({}), position, onDone: () => {} }));
    expect(visible(loading)).toContain("Loading the vault. The contract picks the path when you send.");
    expect(tips(loading)).toEqual([expect.stringContaining("Instant while the vault holds no open call; queued otherwise.")]);

    const instant = renderToStaticMarkup(createElement(RedeemQueue, { snapshot: snap({ canRedeemInstantly: true }), position, onDone: () => {} }));
    expect(visible(instant)).toContain("No call is open, so you're paid in the same transaction.");
    expect(visible(instant)).toContain("instant");

    // The fork acceptance run (tests/acceptance/fork.acceptance.ts) reads this sentence; it stays word for word.
    const open = renderToStaticMarkup(createElement(RedeemQueue, { snapshot: snap({ canRedeemInstantly: false }), position, onDone: () => {} }));
    expect(visible(open)).toMatch(/A call is open\. Redemptions are queued and paid after the keeper closes the week\./);
    expect(tips(open)).toEqual(["If the call is assigned, part of the queue is paid in USDG at the strike instead of in NVDA."]);

    for (const html of [loading, instant, open]) expectPlain(html);
  });

  it("a stranded claim: queue still works, and the payout limits are kept in the tip", () => {
    const html = renderToStaticMarkup(createElement(RedeemQueue, {
      snapshot: snap({ canRedeemInstantly: false, isStranded: true }), position, onDone: () => {},
    }));
    expect(visible(html)).toContain("queue only · claim stranded");
    expect(visible(html)).toContain("A claim is stranded, so instant withdrawals are off. You can still queue.");
    const [tip] = tips(html);
    expect(tip).toContain("Settling the queue always works");
    expect(tip).toContain("NVDA is paid only while the Stock Token lets the vault transfer");
    expect(tip).toContain("USDG only while USDG can move");
    expect(tip).toContain("The claim's share is paid once the claim is redeemed.");
    expectPlain(html);
  });

  it("an entry nothing will settle: plain words, a batch number, and what settling does in the tip", () => {
    const html = renderToStaticMarkup(createElement(RedeemQueue, {
      snapshot: snap({ canRedeemInstantly: true, phase: 0, epochId: 3n }),
      position: pos({ shares: 0n, queuedShares: 2n * E18, queuedEpoch: 3n, pendingAssets: 0n, pendingUsdg: 0n }),
      onDone: () => {},
    }));
    expect(visible(html)).toContain("batch #3 · now #3");
    expect(visible(html)).toContain("No call is open, so this waits until someone settles the queue. You can do it now; no keeper needed.");
    const settle = tips(html).find((t) => t.startsWith("It pays what an instant redemption"));
    expect(settle).toContain("It settles every entry in this batch, not only yours, and anyone can send it.");
    expect(settle).toContain("collect with Complete redemption");
    // Not connected: the settle button is off, marked the way React renders a boolean attribute.
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>Settle queue<\/button>/);
    expectPlain(html);
  });

  it("a queued entry waiting on the week's close, and a USDG leg still owed", () => {
    const waiting = renderToStaticMarkup(createElement(RedeemQueue, {
      snapshot: snap({ canRedeemInstantly: false, phase: 1, epochId: 3n }),
      position: pos({ shares: 0n, queuedShares: 2n * E18, queuedEpoch: 3n, pendingAssets: 0n, pendingUsdg: 0n }),
      onDone: () => {},
    }));
    expect(visible(waiting)).toContain("Paid after the keeper closes the week at expiry. The amounts above fill in then.");
    expectPlain(waiting);

    const owed = renderToStaticMarkup(createElement(RedeemQueue, {
      snapshot: snap({ canRedeemInstantly: true, phase: 0, epochId: 4n, lastResolvedGen: 0n }),
      position: pos({ shares: 0n, queuedShares: 0n, queuedEpoch: 3n, pendingAssets: 0n, pendingUsdg: 1_500_000n }),
      onDone: () => {},
    }));
    expect(visible(owed)).toContain("Ready to collect");
    expect(visible(owed)).toContain("Payable USDG 1.50");
    expect(visible(owed)).toContain("Some USDG from an earlier collection is still owed. The vault kept it for you; Complete redemption tries again.");
    expect(tips(owed)).toContain("It could not move at the time: USDG was paused, or the vault or the receiver was frozen on USDG.");
    expectPlain(owed);
  });
});

describe("StrandedBanner", () => {
  const snapshot = snap({
    isStranded: true, phase: 0, cycleNumber: 4, lockedAssets: 5n * E18, strandedRemainingWad: (6n * E18) / 10n,
    strandGen: 2n, lastResolvedGen: 1n, epochId: 9n, totalSupply: 10n * E18,
  });

  it("says what is held and what is off in two sentences, the cause and payout limits in the tip", () => {
    account(true);
    const html = renderToStaticMarkup(createElement(StrandedBanner, {
      snapshot, position: pos({ shares: 5n * E18, queuedShares: 0n, owedStrandWad: E18 / 10n, pendingAssets: 0n, pendingUsdg: 0n }),
    }));
    const text = visible(html);
    expect(text).toContain("A claim is stranded (cycle #4): the week closed, but its collateral could not be returned yet.");
    expect(text).toContain("5 NVDA (plus the strike USDG for anything assigned) is still held by the options contract.");
    expect(text).toContain("Until it comes back, deposits and instant withdrawals are off and no new week can start. Queued withdrawals still settle.");
    const cause = tips(html).find((t) => t.startsWith("At the close"));
    expect(cause).toContain("USDG was paused or frozen, or the Stock Token issuer blocked the vault");
    expect(cause).toContain("an issuer block on the vault holds the NVDA part back until it lifts");
    expect(cause).toContain("a USDG pause or freeze holds back the USDG part");
    // The rows: the claim split, the stranded-claim counter, and this account's shares, all through the formatters.
    expect(text).toContain("Claim owed to current holders 60%");
    expect(text).toContain("Claim owed to settled withdrawals 40%");
    expect(text).toContain("Stranded claim #2 · last cleared #1");
    expect(text).toContain("Your share, queued");
    expect(text).toContain("Your share, held");
    expect(text).toContain("You can collect now 0 NVDA · 0 USDG");
    expect(tips(html)).toEqual(expect.arrayContaining([
      "Your queued withdrawal's share of the stranded claim. Paid with Complete redemption once the claim is redeemed.",
      expect.stringContaining("it comes back in the share price, and any strike USDG through the USDG claim."),
    ]));
    expect(text).toContain("Anyone can send this. It fails until the cause clears, then brings the claim back. No keeper needed.");
    expectPlain(html.replace(TOOLTIP, ""));
  });

  it("renders nothing while no claim is stranded", () => {
    expect(renderToStaticMarkup(createElement(StrandedBanner, { snapshot: snap({ isStranded: false, phase: 0, claimKey: 0n }) }))).toBe("");
  });
});

describe("UsdgClaim", () => {
  it("keeps the row labels the fork run reads, says strike proceeds are not premium, and moves the row title into a tip", () => {
    account(true);
    const html = renderToStaticMarkup(createElement(UsdgClaim, {
      snapshot: snap({ accUsdgPerShare: 1_234_500n * 1_000_000_000n, totalUsdgDistributed: 12_345_678_900n }),
      position: pos({ claimableUsdg: 0n }),
      onDone: () => {},
    }));
    const text = visible(html);
    expect(text).toContain("premium, plus strike proceeds if assigned");
    // Per-share through fmtUsdg(…, 6): no zero tail. The vault total compacts from 10,000.
    expect(text).toContain("Distributed to date, per cNVDA 1.2345 USDG");
    expect(text).toContain("Vault total distributed 12.3K USDG");
    // The label alone, no "?" inside it: the fork run matches /^Distributed to date, per cNVDA$/ on this <dt>.
    expect(html).toMatch(/<dt data-slot="k"[^>]*>Distributed to date, per (<!-- -->)?cNVDA<\/dt>/);
    expect(text).toContain("Includes strike proceeds from assigned weeks: returned collateral, not premium.");
    expect(tips(html)).toEqual([
      "Distributed to date is everything credited to one share since launch: premium after fees, plus strike proceeds from assigned weeks. Not a return.",
    ]);
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*>Nothing to claim<\/button>/);
    expectPlain(html);
  });
});

describe("CycleTape", () => {
  it("a plain title, the state in words, and the NYSE-close detail in the tip", () => {
    const html = renderToStaticMarkup(createElement(CycleTape, {
      snapshot: snap({ phase: 1, cycleNumber: 7, cycleExerciseTs: NOW + 3_600, cycleExpiryTs: NOW + 90_000 }),
    }));
    const text = visible(html);
    expect(text).toContain("This week");
    expect(text).not.toContain("Cycle tape");
    expect(text).toContain("cycle #7 · selling");
    expect(text).toContain("Calls can be bought until the sale window closes, and exercised from then until expiry.");
    const [tip] = tips(html);
    expect(tip).toContain("the last moment a buyer can fill");
    expect(tip).toContain("4:00pm New York, so the UTC hour moves with daylight time");
    expect(tip).toContain("The times shown are the chain's, not a calendar's.");
    expectPlain(html);
  });

  it("nothing started, and a stranded claim, in plain words", () => {
    const idle = visible(renderToStaticMarkup(createElement(CycleTape, { snapshot: snap({ phase: 0, cycleNumber: 7, cycleExerciseTs: 0 }) })));
    expect(idle).toContain("cycle #7 · not started");
    expect(idle).not.toMatch(/armed/);
    const stranded = visible(renderToStaticMarkup(createElement(CycleTape, { snapshot: snap({ phase: 0, isStranded: true, cycleNumber: 7 }) })));
    expect(stranded).toContain("cycle #7 · claim stranded");
    const exercisable = visible(renderToStaticMarkup(createElement(CycleTape, {
      snapshot: snap({ phase: 2, cycleNumber: 7, cycleExerciseTs: NOW - 60, cycleExpiryTs: NOW + 3_600 }),
    })));
    expect(exercisable).toContain("cycle #7 · can be exercised");
  });
});

describe("PositionSplit", () => {
  it("names the three slices in plain words with the explanations in one tip, amounts through fmtAsset", () => {
    const html = renderToStaticMarkup(createElement(PositionSplit, { idle: 3n * E18, sold: 25n * 10n ** 17n, assigned: 0n }));
    const text = visible(html);
    expect(text).toContain("Free 3");
    expect(text).toContain("Sold 2.5");
    expect(text).toContain("Assigned 0");
    expect(tips(html)).toEqual([
      "Free: not backing any call. Sold: backs a call a buyer owns, so it can be assigned. Assigned: already taken at the strike.",
    ]);
    expectPlain(html);
  });
});

describe("PhaseBadge and GuardBadges", () => {
  it("the sold count goes through the quantity formatter", () => {
    expect(visible(renderToStaticMarkup(createElement(PhaseBadge, { phase: 1, fillState: "selling", sold: 3n })))).toContain("Selling · 3 sold");
    expect(visible(renderToStaticMarkup(createElement(PhaseBadge, { phase: 1, fillState: "selling", sold: 12_345n })))).toContain("Selling · 12.3K sold");
  });

  it("each guard chip's explanation is an InfoTip, not a title", () => {
    const html = renderToStaticMarkup(createElement(GuardBadges, { snapshot: { isStranded: true, writesHalted: true } }));
    expect(visible(html)).toContain("Claim stranded");
    expect(visible(html)).toContain("Writes halted");
    expect(html).toContain('aria-label="About Claim stranded"');
    expect(html).toContain('aria-label="About Writes halted"');
    expect(tips(html)).toHaveLength(2);
    expect(html).not.toMatch(/ title="/);
  });
});

describe("CyclePricing", () => {
  const FRESH = {
    mode: "vol", source: "cboe-delayed", priceSource: "vol-fair", volPath: "fresh",
    volUnavailableReason: null, targetDelta: 0.15, deltaAtStrike: 0.1464, ivAtStrike: 0.3266,
    strikeUsdg6: "225000000", deltaStrikeUsdg6: "225000000", strikeClamped: null, bandBufferBps: 50,
    fairUnit6: "860864", volUnit6: "946951", floorUnit6: "848840", marginUnit6: "857329",
    unitPrice6: "946951", edgeBps: 1000, marginBps: 100,
    shareSpot: 212.0404, spotUsdg6: "212210000",
    expiry: "2026-09-25", chainTimestamp: "2026-09-15 05:57:42", lastTradeTime: "2026-09-14T15:59:59",
  };
  const listing = { pricing: FRESH } as unknown as ListingRow;

  it("one short note, with the source and what the vault enforces in the tip", () => {
    const html = renderToStaticMarkup(createElement(CyclePricing, { listing, feed: "loading", vaultStrike6: 225_000_000n, vaultUnitPrice6: 946_951n }));
    expect(visible(html)).toContain("Reported by the keeper, not read from the chain. For information only.");
    const [tip] = tips(html);
    expect(tip).toContain("The market figures come from Cboe's delayed quotes, so they lag the market.");
    expect(tip).toContain("it refuses a strike outside the band and a price below the floor, whatever this report says.");
    expect(html).not.toContain('data-slot="pricing-mismatch"');
  });

  it("a report that disagrees with the vault says which figures count, in one line", () => {
    const html = renderToStaticMarkup(createElement(CyclePricing, { listing, feed: "loading", vaultStrike6: 230_000_000n, vaultUnitPrice6: 946_951n }));
    expect(visible(html)).toContain("The vault's own strike and price are what a buyer pays. This report is out of date or wrong.");
  });

  it("no report: the short reason, without Seaport", () => {
    const html = renderToStaticMarkup(createElement(CyclePricing, { listing: undefined, feed: "order-finished", vaultStrike6: undefined, vaultUnitPrice6: undefined }));
    expect(visible(html)).toContain("This order is sold out or cancelled, so there is no pricing report.");
    expectPlain(html);
  });
});
