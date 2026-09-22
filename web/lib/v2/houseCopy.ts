/**
 * House vault disclosure copy. Import these strings on the page; do not paraphrase them there.
 *
 * The four facts, each read at the line cited:
 * - v8-plan/tasks/X-W-indexer-web.md:79 (W8-06) — "you can lose money; our bot does the quoting
 *   inside on-chain limits; withdrawals are processed once a week", and past epochs as facts
 *   "including losing ones".
 * - v8-plan/tasks/P-periphery.md:66 — withdrawals are paid in kind, pro rata, so the vault never
 *   has to swap to pay someone out.
 * - v8-plan/tasks/P-periphery.md:78 — the copy rule itself: depositors can lose money, our bot
 *   does the quoting, results are per-epoch facts including losing epochs, and none of the
 *   forward-looking rate words the compliance table forbids. Read that line for its exact wording;
 *   it is not quoted here because this file is linted against that same table. (The task contract
 *   cites :75, which is "the treasury may deposit like anyone else" and is not a copy fact. :78 is
 *   the copy rule and is what these strings mirror.)
 *
 * NOTHING MACHINE-CHECKS THIS WORDING ANY MORE (owner decision, plan section 5.4, W5). copy-lint
 * and the no-rate rule in houseCopy.test.ts were removed together, because the owner directed that
 * the lending vault's interest percentage BE SHOWN and a rule forbidding "a percentage per unit of
 * time" cannot coexist with a requirement to publish one.
 *
 * SO THE DISCIPLINE IS NOW THE AUTHOR'S, AND IT IS WORTH STATING PLAINLY. Every string below says
 * what happened in ONE epoch and says nothing about what happens next. The failure it guards
 * against is not a banned word; it is a forward-looking claim wearing the clothes of a fact -- an
 * average across epochs, a run of good ones, a figure per unit of time. A linter went green on
 * those anyway, which is part of why removing it costs less than it appears to.
 *
 * Unrelated and still enforced: houseEpoch.ts returns NAV_NOT_AVAILABLE for a running epoch
 * (section 5.4.1). That is a correctness guard, not a copy rule, and this decision does not reach it.
 */

export const HOUSE_DISCLOSURE_CAN_LOSE =
  "You can lose money. House vault depositors share inventory risk with the quoting bot. An epoch can end with less USDG and stock than it started with.";

export const HOUSE_DISCLOSURE_BOT_QUOTES =
  "Our bot does the quoting, inside limits set on chain. Those limits bind the bot; they do not stop an epoch from losing money.";

export const HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS =
  "Withdrawals are processed once a week at the boundary, after that week's series have settled, and are paid in kind: your slice of the vault's USDG and your slice of its stock. A request you place during the epoch is queued until then.";

export const HOUSE_DISCLOSURE_PER_EPOCH_FACTS =
  "Figures below are what happened in each epoch, including epochs that lost money. They are per-epoch facts, not a rate, not an average across epochs, and not a streak.";

export const HOUSE_DISCLOSURES = [
  HOUSE_DISCLOSURE_CAN_LOSE,
  HOUSE_DISCLOSURE_BOT_QUOTES,
  HOUSE_DISCLOSURE_WEEKLY_WITHDRAWALS,
  HOUSE_DISCLOSURE_PER_EPOCH_FACTS,
] as const;
