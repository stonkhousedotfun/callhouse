/**
 * The queue's words, one test per state. The contract facts they rest on (EarnVault.sol, callhouse-contracts
 * src/v2/periphery/earn): `redeem` pays the WHOLE amount now or queues the WHOLE amount; deposits and withdrawals
 * share one FIFO; nothing is served while an option position is open; a queued entry is priced when served.
 */
import { describe, expect, it } from "vitest";

import type { EarliestWithdrawal, EarnQueuedRequest, EarnVault } from "./api-types";
import {
  DEPOSIT_PAID_NOTE, WITHDRAWAL_PAID_NOTE, lendQueueCards, queuePositionLine, queuedRequestCard, queuedRequestCards,
  redeemPreview,
} from "./earnQueue";
import { faqHref } from "./earliestWithdrawal";

const VAULT = "0x0000000000000000000000000000000000000066";
const OTHER_VAULT = "0x0000000000000000000000000000000000000077";
/** 2026-09-25 20:00:00Z, a 4 pm ET close; NOW is an hour before it. */
const EXPIRY = 1_790_366_400;
const NOW = EXPIRY - 3_600;
const SHARE = 10n ** 18n;

const ew = (reason: EarliestWithdrawal["reason"], extra: Partial<EarliestWithdrawal> = {}): EarliestWithdrawal => ({
  kind: reason === "liquid" ? "now" : reason === "not-read" ? "unknown" : "queued", at: null, reason, liquidityCap: null, ...extra,
});

const vaultRow = (earliest: EarliestWithdrawal | undefined, vault = VAULT): EarnVault => ({
  vault, asset: null, adapter: null, fundingEnabled: true, sharesSupply: "100", deposited: null, skimmed: null,
  indicativeAssetsPerShare: null, indicativeTotalAssets: null, hasOpenPosition: null, earliestWithdrawal: earliest,
});

const withdrawal = (over: Partial<EarnQueuedRequest> = {}): EarnQueuedRequest => ({
  id: `${VAULT}-5`, status: "queued", sharesQueued: (3n * SHARE).toString(), assetsRequested: null, fulfilledAssets: null,
  requestedAt: NOW - 600, vault: VAULT, queueId: "5", kind: "withdrawal", assetsQueued: null,
  sharesEscrowed: (3n * SHARE).toString(), position: 1, ...over,
});

const deposit = (over: Partial<EarnQueuedRequest> = {}): EarnQueuedRequest => ({
  id: `${VAULT}-6`, status: "queued", sharesQueued: "0", assetsRequested: null, fulfilledAssets: null,
  requestedAt: NOW - 300, vault: VAULT, queueId: "6", kind: "deposit", assetsQueued: "250000000",
  sharesEscrowed: "0", position: 2, ...over,
});

describe("redeemPreview: what happens before the redeem", () => {
  const base = { shares: null, assetsPerShare: null, shareDecimals: 18, queueDepth: null, now: NOW };

  it("open position: will queue, naming when the option settles", () => {
    const p = redeemPreview({ ...base, ew: ew("open-position", { at: EXPIRY }) });
    expect(p.outcome).toBe("queues");
    expect(p.line).toBe("Will queue: the vault has an option that settles after today's 4pm ET close");
    expect(p.tooltip).toContain("priced when it is paid, not now");
    expect(p.faqHref).toBe(faqHref("earn"));
  });

  it("open position with no indexed expiry: still queues, and names no time rather than a guessed one", () => {
    const p = redeemPreview({ ...base, ew: ew("open-position") });
    expect(p.outcome).toBe("queues");
    expect(p.line).not.toMatch(/\d/);
  });

  it("a queue ahead: joins the back, and counts what is ahead when the indexer sent it", () => {
    expect(redeemPreview({ ...base, ew: ew("queue-ahead"), queueDepth: 3 }).line).toBe("Will queue: behind 3 earlier requests");
    expect(redeemPreview({ ...base, ew: ew("queue-ahead"), queueDepth: 1 }).line).toBe("Will queue: behind 1 earlier request");
    expect(redeemPreview({ ...base, ew: ew("queue-ahead"), queueDepth: null }).line).toBe("Will queue: behind earlier requests");
  });

  it("the venue cannot be read: will queue, even a redemption the vault could pay", () => {
    // The vault prices nothing while it cannot read its venue, so even a payable redeem queues.
    const unreadable = redeemPreview({ ...base, ew: ew("venue-unreadable"), shares: SHARE, assetsPerShare: 1_500_000n });
    expect(unreadable.outcome).toBe("queues");
    expect(unreadable.line).toBe("Will queue: the lending venue can't be read right now");
    expect(unreadable.tooltip).toMatch(/even one it could pay now/);
  });

  it("no liquidity anywhere: will queue, waiting for venue liquidity", () => {
    const p = redeemPreview({ ...base, ew: ew("venue-liquidity", { liquidityCap: "0" }) });
    expect(p).toMatchObject({ outcome: "queues", line: "Will queue: waiting for venue liquidity" });
  });

  it("liquid and within the cap: paid now, with the estimate", () => {
    // 2 shares at 1.50 USDG a share = 3 USDG, under a 6 USDG cap.
    const p = redeemPreview({ ...base, ew: ew("liquid", { liquidityCap: "6000000" }), shares: 2n * SHARE, assetsPerShare: 1_500_000n });
    expect(p).toMatchObject({ outcome: "paid-now", line: "Paid now: about 3 USDG" }); // No zero tail
  });

  // previewRedeem needsVenue while the indexer reason is still liquid (cap includes venue cash).
  it("needsVenue: a liquid redemption is not shown as cash that will arrive", () => {
    const within = redeemPreview({
      ...base, ew: ew("liquid", { liquidityCap: "6000000" }), shares: 2n * SHARE, assetsPerShare: 1_500_000n,
      contract: "needs-venue",
    });
    expect(within.line).toBe("Not guaranteed until the lending venue delivers the rest");
    expect(within.outcome).not.toBe("paid-now");
    expect(within.line).not.toMatch(/paid now/i);
    expect(within.line).not.toMatch(/\d/);
    const unpriced = redeemPreview({ ...base, ew: ew("liquid", { liquidityCap: "6000000" }), contract: "needs-venue" });
    expect(unpriced.line).toBe("Not guaranteed until the lending venue delivers the rest");
    expect(unpriced.line).not.toMatch(/paid now/i);
    const over = redeemPreview({
      ...base, ew: ew("liquid", { liquidityCap: "6000000" }), shares: 5n * SHARE, assetsPerShare: 1_500_000n,
      contract: "needs-venue",
    });
    expect(over.outcome).toBe("queues");
    expect(over.line).toBe("Will queue: about 7.50 USDG is more than the 6 USDG the vault can pay now");
  });

  // P3. The indexer's paid-now line stands only once previewRedeem has answered for the typed amount and
  // pays it now. While it is pending or after a revert (`unread`), or when it says queued, no cash amount is shown.
  it("previewRedeem not answered for the typed amount: no paid-now cash line, whatever the indexer says", () => {
    const liquid = ew("liquid", { liquidityCap: "6000000" });
    const within = redeemPreview({ ...base, ew: liquid, shares: 2n * SHARE, assetsPerShare: 1_500_000n, contract: "unread" });
    expect(within).toMatchObject({ outcome: "unknown", line: "No amount is shown until the vault's own preview answers" });
    expect(within.line).not.toMatch(/\d/);
    const unpriced = redeemPreview({ ...base, ew: liquid, contract: "unread" });
    expect(unpriced.outcome).toBe("unknown");
    expect(unpriced.line).not.toMatch(/paid now/i);
    const uncapped = redeemPreview({ ...base, ew: ew("liquid", { liquidityCap: null }), shares: 2n * SHARE,
      assetsPerShare: 1_500_000n, contract: "unread" });
    expect(uncapped.outcome).toBe("unknown");
    expect(uncapped.line).not.toMatch(/paid now/i);
    // A queue line is not a cash promise and stays as the indexer sent it.
    const over = redeemPreview({ ...base, ew: liquid, shares: 5n * SHARE, assetsPerShare: 1_500_000n, contract: "unread" });
    expect(over.line).toBe("Will queue: about 7.50 USDG is more than the 6 USDG the vault can pay now");
  });

  it("previewRedeem says the typed amount queues: will queue, not paid now", () => {
    const p = redeemPreview({ ...base, ew: ew("liquid", { liquidityCap: "6000000" }), shares: 2n * SHARE,
      assetsPerShare: 1_500_000n, contract: "queues" });
    expect(p).toMatchObject({ outcome: "queues", line: "Will queue: the vault's own preview says this amount is not paid now" });
    expect(p.line).not.toMatch(/\d/);
  });

  it("previewRedeem pays the typed amount, or nothing is typed: the indexer's paid-now line stands", () => {
    const liquid = ew("liquid", { liquidityCap: "6000000" });
    expect(redeemPreview({ ...base, ew: liquid, shares: 2n * SHARE, assetsPerShare: 1_500_000n, contract: "pays" }))
      .toMatchObject({ outcome: "paid-now", line: "Paid now: about 3 USDG" });
    expect(redeemPreview({ ...base, ew: liquid, shares: null, assetsPerShare: 1_500_000n }))
      .toMatchObject({ outcome: "paid-now", line: "Paid now if it is worth up to 6 USDG; above that, the whole redemption queues" });
  });

  it("liquid but above the cap: the WHOLE redemption queues -- never 'part now, rest later'", () => {
    const p = redeemPreview({ ...base, ew: ew("liquid", { liquidityCap: "6000000" }), shares: 5n * SHARE, assetsPerShare: 1_500_000n });
    expect(p.outcome).toBe("queues");
    expect(p.line).toBe("Will queue: about 7.50 USDG is more than the 6 USDG the vault can pay now");
    expect(p.tooltip).toContain("the whole redemption is queued");
    expect(p.tooltip).not.toMatch(/rest|remainder|partly/i);
  });

  it("liquid at exactly the cap: paid now (the contract pays when what it raised covers what is owed)", () => {
    const p = redeemPreview({ ...base, ew: ew("liquid", { liquidityCap: "3000000" }), shares: 2n * SHARE, assetsPerShare: 1_500_000n });
    expect(p.outcome).toBe("paid-now");
  });

  // Shares are base units at the vault's decimals(); the estimate divides by one whole share at THAT scale.
  it("liquid: the estimate uses the vault's share decimals, and an unread decimals() estimates nothing", () => {
    const sixDp = redeemPreview({ ...base, ew: ew("liquid", { liquidityCap: "6000000" }), shares: 2_000_000n, assetsPerShare: 1_500_000n, shareDecimals: 6 });
    expect(sixDp).toMatchObject({ outcome: "paid-now", line: "Paid now: about 3 USDG" });
    const unread = redeemPreview({ ...base, ew: ew("liquid", { liquidityCap: "6000000" }), shares: 2n * SHARE, assetsPerShare: 1_500_000n, shareDecimals: null });
    expect(unread.line).toBe("Paid now if it is worth up to 6 USDG; above that, the whole redemption queues");
  });

  it("liquid with nothing typed or no share price read: states the cap and the all-or-nothing rule", () => {
    const p = redeemPreview({ ...base, ew: ew("liquid", { liquidityCap: "6000000" }) });
    expect(p).toMatchObject({ outcome: "paid-now", line: "Paid now if it is worth up to 6 USDG; above that, the whole redemption queues" });
    expect(redeemPreview({ ...base, ew: ew("liquid", { liquidityCap: "6000000" }), shares: SHARE }).outcome).toBe("paid-now");
  });

  it("not read, or an older indexer: unknown, and never 'paid now'", () => {
    for (const p of [redeemPreview({ ...base, ew: ew("not-read") }), redeemPreview({ ...base, ew: undefined })]) {
      expect(p.outcome).toBe("unknown");
      expect(p.line).toMatch(/^Unavailable/);
      expect(p.line).not.toMatch(/paid now/i);
    }
  });

  it("a House-only reason from this route is not worded as anything", () => {
    expect(redeemPreview({ ...base, ew: { kind: "daily", at: EXPIRY, reason: "epoch-boundary" } }).outcome).toBe("unknown");
  });

  it("a closed House queue says requests reopen after the roll and are priced at the next end", () => {
    const closed = redeemPreview({ ...base, ew: { kind: "daily", at: null, reason: "queue-closed" } });
    expect(closed.line).toBe("Closed until the vault rolls");
    expect(closed.tooltip).toMatch(/reopen after the roll/);
    expect(closed.tooltip).toMatch(/next epoch's end/);
    const dated = redeemPreview({ ...base, ew: { kind: "daily", at: EXPIRY, reason: "queue-closed" } });
    expect(dated.line).toMatch(/priced after /);
  });
});

describe("queuedRequestCard: a pending withdrawal", () => {
  it("while an option is open: place, shares held, the reason, the settlement time, the auto-pay note, Cancel", () => {
    const card = queuedRequestCard(withdrawal(), vaultRow(ew("open-position", { at: EXPIRY })), NOW);
    expect(card).toMatchObject({
      kind: "withdrawal",
      title: "Queued withdrawal #5",
      escrow: "3 shares held by the vault", // No zero tail
      partial: null,
      position: "Next in line",
      expected: "After the open option settles, after today's 4pm ET close",
      note: WITHDRAWAL_PAID_NOTE,
      faqHref: faqHref("earn"),
      cancelId: 5n,
      cancelLabel: "Cancel and return shares",
    });
    expect(card.reason).toContain("holds an option position");
  });

  // This pin changed ON PURPOSE. Now the vault HOLDS a payment the asset refuses to deliver
  // instead of reverting, so "paid automatically" alone was false for a held payment. The note keeps the first
  // sentence and adds that a held payment waits for a claim, and where to make it.
  it("the auto-pay note says who pays it and at what price, and that an undeliverable payment is held to claim", () => {
    expect(WITHDRAWAL_PAID_NOTE).toBe("You will be paid automatically when it clears: the keeper processes the queue after "
      + "settlement, and it is priced at that moment. If the payment cannot be delivered to the receiving address, the "
      + "vault holds it for you instead: it then appears under \"Payments held for you\" on this page and your portfolio, "
      + "to claim to any address.");
    expect(DEPOSIT_PAID_NOTE).toContain("the refund is held for you under \"Payments held for you\"");
  });

  it("waiting for venue liquidity", () => {
    const card = queuedRequestCard(withdrawal(), vaultRow(ew("venue-liquidity", { liquidityCap: "0" })), NOW);
    expect(card.expected).toBe("Waiting for venue liquidity");
    expect(card.reason).toContain("cannot pay right now");
  });

  // without the branch this card says "the next queue run serves it" while processQueue serves
  // nothing, next in line or not.
  it("the venue cannot be read: no queue run serves it until it can, next in line or not, deposit or withdrawal", () => {
    for (const position of [1, 3]) {
      const card = queuedRequestCard(withdrawal({ position }), vaultRow(ew("venue-unreadable")), NOW);
      expect(card.reason).toBe("The vault can't read its lending venue, so it can't price a withdrawal. The queue waits until it can.");
      expect(card.expected).toBe("When the lending venue can be read again");
      expect(card.reason).not.toContain("next queue run");
    }
    const dep = queuedRequestCard(deposit(), vaultRow(ew("venue-unreadable")), NOW);
    expect(dep.reason).toBe("The vault can't read its lending venue, so it can't price shares to mint. The queue waits until it can.");
    expect(dep.expected).toBe("When the lending venue can be read again");
  });

  it("the vault is flat and others are ahead: the FIFO reason; next in line: the next queue run", () => {
    const behind = queuedRequestCard(withdrawal({ position: 4 }), vaultRow(ew("queue-ahead")), NOW);
    expect(behind.position).toBe("4th in line, 3 requests ahead");
    expect(behind.reason).toContain("Earlier requests are ahead of it");
    expect(behind.expected).toBe("At the next queue run, or when the venue has the cash to pay it");
    const next = queuedRequestCard(withdrawal({ position: 1 }), vaultRow(ew("queue-ahead")), NOW);
    expect(next.reason).toContain("It is next in line");
  });

  it("a partly served request shows the shares still held and what has been paid so far", () => {
    const card = queuedRequestCard(withdrawal({ sharesEscrowed: (2n * SHARE).toString(), fulfilledAssets: "1500000" }),
      vaultRow(ew("queue-ahead")), NOW);
    expect(card.escrow).toBe("2 shares held by the vault"); // No zero tail
    expect(card.partial).toBe("Partly paid: 1 of 3 shares served so far for 1.50 USDG."); // No zero tail
  });

  it("the vault's state not read, or its row missing: no reason and no time are guessed", () => {
    for (const row of [vaultRow(ew("not-read")), vaultRow(undefined), undefined]) {
      const card = queuedRequestCard(withdrawal(), row, NOW);
      expect(card.expected).toBe("Unavailable");
      expect(card.reason).toContain("could not be read");
      // The request itself is still shown, with its Cancel: not knowing WHY it waits is no reason to hide it.
      expect(card.cancelId).toBe(5n);
    }
  });

  it("no queue id on the wire: no cancel is offered, rather than a guessed id", () => {
    const card = queuedRequestCard(withdrawal({ queueId: null }), vaultRow(ew("queue-ahead")), NOW);
    expect(card.cancelId).toBeNull();
    expect(card.title).toBe("Queued withdrawal");
  });
});

describe("queuedRequestCard: a queued deposit", () => {
  it("explains why a deposit waits, what it holds, that shares are minted automatically, and offers Cancel", () => {
    const card = queuedRequestCard(deposit(), vaultRow(ew("open-position", { at: EXPIRY })), NOW);
    expect(card).toMatchObject({
      kind: "deposit",
      title: "Queued deposit #6",
      escrow: "250 USDG held by the vault", // No zero tail
      partial: null,
      position: "2nd in line, 1 request ahead",
      note: DEPOSIT_PAID_NOTE,
      cancelId: 6n,
      cancelLabel: "Cancel and return USDG",
    });
    expect(card.reason).toBe("The vault holds an option position, so there is no fair share price to mint at until it settles.");
  });
});

describe("queue positions", () => {
  it("words first place and ordinals, including the teens", () => {
    expect(queuePositionLine(1)).toBe("Next in line");
    expect(queuePositionLine(2)).toBe("2nd in line, 1 request ahead");
    expect(queuePositionLine(3)).toBe("3rd in line, 2 requests ahead");
    expect(queuePositionLine(11)).toBe("11th in line, 10 requests ahead");
    expect(queuePositionLine(12)).toBe("12th in line, 11 requests ahead");
    expect(queuePositionLine(21)).toBe("21st in line, 20 requests ahead");
    expect(queuePositionLine(113)).toBe("113th in line, 112 requests ahead");
  });
});

describe("which requests get cards", () => {
  it("keeps queue order and pairs each request with its own vault's row", () => {
    const cards = queuedRequestCards([withdrawal(), deposit()], [vaultRow(ew("open-position", { at: EXPIRY }))], NOW);
    expect(cards.map((c) => c.key)).toEqual([`${VAULT}-5`, `${VAULT}-6`]);
    expect(cards[0]!.expected).toContain("today's 4pm ET close");
  });

  it("drops anything not still queued, and renders nothing for an empty or missing list", () => {
    expect(queuedRequestCards([withdrawal({ status: "fulfilled" }), deposit({ status: "cancelled" })], [], NOW)).toEqual([]);
    expect(queuedRequestCards([], [], NOW)).toEqual([]);
    expect(queuedRequestCards(undefined, undefined, NOW)).toEqual([]);
  });

  it("offers only the REGISTRY vault's requests: the cancel goes to that address, never one the indexer names", () => {
    const earn = { vaults: [vaultRow(ew("queue-ahead")), vaultRow(ew("queue-ahead"), OTHER_VAULT)], account: {
      address: "0x0000000000000000000000000000000000000044", shares: null,
      queued: [withdrawal(), withdrawal({ id: `${OTHER_VAULT}-9`, vault: OTHER_VAULT, queueId: "9" })],
    } };
    expect(lendQueueCards(VAULT, earn, NOW).map((c) => c.key)).toEqual([`${VAULT}-5`]);
    // Case does not matter: the registry checksums and the wire may not.
    expect(lendQueueCards(VAULT.toUpperCase().replace("0X", "0x") as `0x${string}`, earn, NOW)).toHaveLength(1);
    expect(lendQueueCards(null, earn, NOW)).toEqual([]);
    expect(lendQueueCards(VAULT, undefined, NOW)).toEqual([]);
  });
});
