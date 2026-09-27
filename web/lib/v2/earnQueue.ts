/**
 * What a lending-vault request that waits in the queue looks like to the person who made it: the preview
 * before a redemption ("paid now" or "will queue"), and one card per open request with its place in line, the
 * shares or USDG it holds, why it waits, when it should clear, and how to take it back.
 *
 * THE CONTRACT DECIDES, THIS FILE ONLY WORDS IT. `EarnVault.redeem` (callhouse-contracts
 * src/v2/periphery/earn/EarnVault.sol) either pays the WHOLE redemption now or queues the WHOLE redemption: when the
 * vault and its venue together cannot raise what is owed, nothing is burned and nothing is paid, and the full share
 * amount joins the back of the queue. There is no "part now, rest later", so no line here says so. Deposits and
 * withdrawals share ONE first-in-first-out queue, served only while the vault holds no option position, and each
 * entry is priced when it is served, not when it was asked for.
 *
 * Every branch the indexer cannot vouch for (`not-read`, or a field an older indexer does not send) says
 * "unavailable" and never "paid now": a guessed "now" is the one wrong answer someone would act on.
 */
import type { Address } from "viem";

import { fmtAsset, fmtUsdg } from "@/lib/format";
import type { EarliestWithdrawal, EarnQueuedRequest, EarnResponse, EarnVault } from "@/lib/v2/api-types";
import { closePhrase, faqHref } from "@/lib/v2/earliestWithdrawal";
import { HELD_SECTION_TITLE } from "@/lib/v2/earnDeferred";

/*//////////////////////////////////////////////////////////////
                        BEFORE THE REDEEM
//////////////////////////////////////////////////////////////*/

export type RedeemPreview = {
  /** `paid-now` and `queues` are what the vault's current state says will happen; `unknown` is "we cannot say". */
  outcome: "paid-now" | "queues" | "unknown";
  line: string;
  tooltip: string;
  faqHref: string;
};

const WHOLE_QUEUES =
  "If the vault and its lending venue cannot raise the whole amount, nothing is paid now: the whole redemption is "
  + "queued, your shares are held by the vault, and it is paid in order as cash comes back.";
const PRICED_LATER = "A queued redemption is priced when it is paid, not now, and you can cancel it until then.";

/**
 * @param input.ew the vault's `earliestWithdrawal` from `/v2/earn`; undefined from an indexer that predates it.
 * @param input.shares the share amount typed, or null when nothing valid is typed.
 * @param input.assetsPerShare USDG base units per WHOLE share, read on chain (`readEarnVault`). Null when not read;
 *        it reverts while a position is open, which is exactly when it is not needed.
 * @param input.shareDecimals the vault's `decimals()`: `shares` is in share base units, so the value is
 *        `shares x assetsPerShare / 10 ** shareDecimals`. Null when not read, and then no value is estimated.
 * @param input.queueDepth open entries ahead, from the indexer; null when not sent.
 */
export function redeemPreview(input: {
  ew: EarliestWithdrawal | undefined;
  shares: bigint | null;
  assetsPerShare: bigint | null;
  shareDecimals: number | null;
  queueDepth: number | null;
  now: number;
  /** The reader's zone for the close time; omitted, ET only. */
  timeZone?: string;
  /**
   * What EarnVault.previewRedeem said about the TYPED amount. The indexer's `liquid`
   * reason folds venue cash into `liquidityCap`, so a "Paid now" line stands only on `pays`:
   *   `pays`         answered, not queued, not needsVenue;
   *   `needs-venue`  answered needsVenue: paid in full only if the venue delivers the rest;
   *   `queues`       answered queued: nothing is paid now;
   *   `unread`       pending, reverted or failed: no paid-now amount until it answers.
   * Omitted when nothing is typed (there is no amount to ask about): the indexer's line stands.
   */
  contract?: "pays" | "needs-venue" | "queues" | "unread";
}): RedeemPreview {
  const faq = faqHref("earn");
  const ew = input.ew;
  if (ew === undefined || ew.reason === "not-read") {
    return {
      outcome: "unknown",
      line: "Unavailable: the vault's state could not be read, so it is not known whether this pays now or queues",
      tooltip: "No outcome is shown rather than a guessed one.",
      faqHref: faq,
    };
  }
  switch (ew.reason) {
    case "open-position":
      return {
        outcome: "queues",
        line: ew.at === null
          ? "Will queue: the vault has an open option, and redemptions are paid once it settles"
          : `Will queue: the vault has an option that settles after ${closePhrase(ew.at, input.now, input.timeZone)}`,
        tooltip: "While the vault holds an option, every redemption is queued and served only once the option has "
          + `settled. ${PRICED_LATER}`,
        faqHref: faq,
      };
    case "queue-ahead": {
      const depth = input.queueDepth;
      return {
        outcome: "queues",
        line: depth === null || depth <= 0
          ? "Will queue: behind earlier requests"
          : `Will queue: behind ${depth} earlier request${depth === 1 ? "" : "s"}`,
        tooltip: `The queue is first in, first out and is never stepped over, so a new redemption joins the back. ${PRICED_LATER}`,
        faqHref: faq,
      };
    }
    case "venue-unreadable":
      return {
        outcome: "queues",
        line: "Will queue: the lending venue can't be read right now",
        tooltip: `The vault can't price shares until it can read its lending venue, so every redemption waits in line, `
          + `even one it could pay now. ${PRICED_LATER}`,
        faqHref: faq,
      };
    case "venue-liquidity":
      return {
        outcome: "queues",
        line: "Will queue: waiting for venue liquidity",
        tooltip: `Neither the vault nor its lending venue can pay anything right now. ${PRICED_LATER}`,
        faqHref: faq,
      };
    case "liquid": {
      // previewRedeem needsVenue is still `liquid` here: liquidityCap is wallet + ledger + venue.
      const withoutCashPromise = (preview: RedeemPreview): RedeemPreview => {
        if (preview.outcome !== "paid-now" || input.contract === undefined || input.contract === "pays") return preview;
        if (input.contract === "needs-venue") {
          return {
            outcome: "unknown",
            line: "Not guaranteed until the lending venue delivers the rest",
            tooltip: "The vault's own cash does not cover this withdrawal. It is paid in full only if the "
              + "lending venue delivers the rest, and otherwise it is not paid now.",
            faqHref: preview.faqHref,
          };
        }
        if (input.contract === "queues") {
          return {
            outcome: "queues",
            line: "Will queue: the vault's own preview says this amount is not paid now",
            tooltip: WHOLE_QUEUES,
            faqHref: preview.faqHref,
          };
        }
        return {
          outcome: "unknown",
          line: "No amount is shown until the vault's own preview answers",
          tooltip: "The vault's preview of this withdrawal has not answered or could not be read, so no paid-now "
            + "amount is shown.",
          faqHref: preview.faqHref,
        };
      };
      const cap = ew.liquidityCap == null ? null : BigInt(ew.liquidityCap);
      if (cap === null) {
        return withoutCashPromise({ outcome: "paid-now", line: "Paid now, if the vault can raise the whole amount", tooltip: WHOLE_QUEUES, faqHref: faq });
      }
      const capText = `${fmtUsdg(cap, 2)} USDG`;
      if (input.shares === null || input.assetsPerShare === null || input.shareDecimals === null) {
        return withoutCashPromise({
          outcome: "paid-now",
          line: `Paid now if it is worth up to ${capText}; above that, the whole redemption queues`,
          tooltip: WHOLE_QUEUES,
          faqHref: faq,
        });
      }
      const value = (input.shares * input.assetsPerShare) / 10n ** BigInt(input.shareDecimals);
      const valueText = `${fmtUsdg(value, 2)} USDG`;
      if (value <= cap) {
        return withoutCashPromise({
          outcome: "paid-now",
          line: `Paid now: about ${valueText}`,
          tooltip: `The vault can raise up to ${capText} now. The amount is fixed by the share price in the block `
            + "your transaction lands in, so it can differ slightly from this estimate.",
          faqHref: faq,
        });
      }
      return withoutCashPromise({
        outcome: "queues",
        line: `Will queue: about ${valueText} is more than the ${capText} the vault can pay now`,
        tooltip: WHOLE_QUEUES,
        faqHref: faq,
      });
    }
    // House-only. A lending vault does not close its queue on an epoch boundary.
    case "epoch-boundary":
    case "boundary-pending":
      return { outcome: "unknown", line: "Unavailable", tooltip: "The indexer reported a state this vault does not have.", faqHref: faq };
    case "queue-closed":
      return {
        outcome: "unknown",
        line: ew.at === null
          ? "Closed until the vault rolls"
          : `Closed until the vault rolls; a request after the roll is priced after ${closePhrase(ew.at, input.now, input.timeZone)}`,
        tooltip: "Withdrawal requests are closed until the vault rolls. They reopen after the roll and are priced "
          + "at the next epoch's end.",
        faqHref: faq,
      };
  }
}

/*//////////////////////////////////////////////////////////////
                      AFTER IT QUEUED: THE CARDS
//////////////////////////////////////////////////////////////*/

export type QueuedRequestCard = {
  key: string;
  kind: "withdrawal" | "deposit";
  title: string;
  /** What the vault holds for it: shares for a withdrawal, USDG for a deposit. */
  escrow: string;
  /** Present only for a partly served withdrawal. */
  partial: string | null;
  position: string;
  reason: string;
  expected: string;
  note: string;
  faqHref: string;
  /** The `cancelQueued` argument; null when the indexer sent no queue id, and then no cancel is offered. */
  cancelId: bigint | null;
  cancelLabel: string;
  /** EarnVault.previewQueued's amount, or null while that read has not returned. */
  contractPreview?: string | null;
};

/**
 * "automatically" is qualified. Since the vault HOLDS a payment the asset refuses to deliver (USDG
 * can freeze an address) instead of reverting, and a held payment waits for a claim (lib/v2/earnDeferred.ts). Each note
 * says so and says where to claim it.
 */
export const WITHDRAWAL_PAID_NOTE =
  "You will be paid automatically when it clears: the keeper processes the queue after settlement, and it is "
  + `priced at that moment. If the payment cannot be delivered to the receiving address, the vault holds it for you `
  + `instead: it then appears under "${HELD_SECTION_TITLE}" on this page and your portfolio, to claim to any address.`;
export const DEPOSIT_PAID_NOTE =
  "Your shares are minted automatically when it clears: the keeper processes the queue after settlement, and the "
  + "deposit is priced at that moment. If the vault refunds it instead and the USDG cannot be delivered, the refund is "
  + `held for you under "${HELD_SECTION_TITLE}" on this page and your portfolio, to claim to any address.`;

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
}

export function queuePositionLine(position: number): string {
  if (position <= 1) return "Next in line";
  const ahead = position - 1;
  return `${ordinal(position)} in line, ${ahead} request${ahead === 1 ? "" : "s"} ahead`;
}

function reasonAndTime(kind: "withdrawal" | "deposit", ew: EarliestWithdrawal | undefined, position: number, now: number, timeZone?: string) {
  if (ew === undefined || ew.reason === "not-read" || ew.reason === "epoch-boundary" || ew.reason === "boundary-pending") {
    return {
      reason: "The vault's state could not be read, so no reason is shown rather than a guessed one.",
      expected: "Unavailable",
    };
  }
  if (ew.reason === "queue-closed") {
    return {
      reason: "Withdrawal requests are closed until the vault rolls. They reopen after the roll.",
      expected: ew.at === null
        ? "Priced at the next epoch's end"
        : `Priced after ${closePhrase(ew.at, now, timeZone)}`,
    };
  }
  if (ew.reason === "open-position") {
    return {
      reason: kind === "deposit"
        ? "The vault holds an option position, so there is no fair share price to mint at until it settles."
        : "The vault holds an option position. The queue is served only once it settles, so every request is "
          + "priced at a settled value.",
      expected: ew.at === null
        ? "After the vault's open option settles"
        : `After the open option settles, after ${closePhrase(ew.at, now, timeZone)}`,
    };
  }
  if (ew.reason === "venue-unreadable") {
    // processQueue serves nothing while the vault cannot read its lending venue, so
    // no request moves, next in line or not. The indexer names this before queue-ahead for that reason.
    return {
      reason: kind === "deposit"
        ? "The vault can't read its lending venue, so it can't price shares to mint. The queue waits until it can."
        : "The vault can't read its lending venue, so it can't price a withdrawal. The queue waits until it can.",
      expected: "When the lending venue can be read again",
    };
  }
  if (ew.reason === "venue-liquidity") {
    return {
      reason: "The vault and its lending venue cannot pay right now. The queue is served in order as cash comes back.",
      expected: "Waiting for venue liquidity",
    };
  }
  // `queue-ahead` (or a `liquid` the indexer read a moment after this request was served): the vault is flat.
  return {
    reason: position > 1
      ? "Earlier requests are ahead of it. The queue is first in, first out and never steps over anyone."
      : "It is next in line and the vault holds no option, so the next queue run serves it if the vault can pay it "
        + "in full.",
    expected: "At the next queue run, or when the venue has the cash to pay it",
  };
}

/**
 * @param request one entry of `/v2/earn` `account.queued`.
 * @param vault that vault's row from the same response, for why it waits and when; undefined when absent.
 */
export function queuedRequestCard(request: EarnQueuedRequest, vault: EarnVault | null | undefined, now: number, timeZone?: string): QueuedRequestCard {
  const { reason, expected } = reasonAndTime(request.kind, vault?.earliestWithdrawal, request.position, now, timeZone);
  const number = request.queueId === null ? "" : ` #${request.queueId}`;
  const cancelId = request.queueId === null ? null : BigInt(request.queueId);
  if (request.kind === "deposit") {
    return {
      key: request.id,
      kind: "deposit",
      title: `Queued deposit${number}`,
      escrow: request.assetsQueued === null ? "Amount unavailable" : `${fmtUsdg(BigInt(request.assetsQueued), 2)} USDG held by the vault`,
      partial: null,
      position: queuePositionLine(request.position),
      reason,
      expected,
      note: DEPOSIT_PAID_NOTE,
      faqHref: faqHref("earn"),
      cancelId,
      cancelLabel: "Cancel and return USDG",
    };
  }
  const left = BigInt(request.sharesEscrowed);
  const served = BigInt(request.sharesQueued) - left;
  return {
    key: request.id,
    kind: "withdrawal",
    title: `Queued withdrawal${number}`,
    escrow: `${fmtAsset(left, 4)} shares held by the vault`,
    partial: served > 0n
      ? `Partly paid: ${fmtAsset(served, 4)} of ${fmtAsset(BigInt(request.sharesQueued), 4)} shares served so far`
        + (request.fulfilledAssets === null ? "." : ` for ${fmtUsdg(BigInt(request.fulfilledAssets), 2)} USDG.`)
      : null,
    position: queuePositionLine(request.position),
    reason,
    expected,
    note: WITHDRAWAL_PAID_NOTE,
    faqHref: faqHref("earn"),
    cancelId,
    cancelLabel: "Cancel and return shares",
  };
}

/** Every open request the indexer lists for this wallet, in queue order, each with its vault's row. */
export function queuedRequestCards(
  queued: readonly EarnQueuedRequest[] | undefined,
  vaults: readonly EarnVault[] | undefined,
  now: number,
  timeZone?: string,
): QueuedRequestCard[] {
  if (!queued?.length) return [];
  const byVault = new Map((vaults ?? []).map((row) => [row.vault.toLowerCase(), row]));
  return queued
    .filter((request) => request.status === "queued")
    .map((request) => queuedRequestCard(request, byVault.get(request.vault.toLowerCase()), now, timeZone));
}

/**
 * The connected wallet's open requests in THE registry vault, as cards, for /earn and the portfolio. Only that
 * vault's: the cancel is sent to `earnVaultAddress()`, never to an address the indexer names, so a request the
 * indexer lists in any other vault is not offered a button that would go somewhere else.
 */
export function lendQueueCards(vault: Address | null, earn: Pick<EarnResponse, "vaults" | "account"> | undefined, now: number,
  timeZone?: string): QueuedRequestCard[] {
  if (!vault) return [];
  const mine = earn?.account?.queued?.filter((request) => request.vault.toLowerCase() === vault.toLowerCase());
  return queuedRequestCards(mine, earn?.vaults, now, timeZone);
}
