import schema from "ponder:schema";

import { MARKET } from "../lib/env";
import { factoryAddress, findWeek, getAccount, getMarket, patchAccount, patchMarket, patchWeek } from "../lib/factoryIndexing";
import {
  accountAfterSettled,
  nextStatus,
  pendingLotsAfter,
  settlementOutcome,
  txLogId,
  weekAfterFill,
  weekAfterListing,
  weekAfterSettlement,
} from "../lib/factoryLifecycle";
import { log } from "../lib/log";
import { factoryPonder as ponder } from "../lib/registry";

/**
 * The clones' events. Every `WriterAccount` emits the same eight, and Ponder delivers them for
 * every address the factory's `AccountCreated` has announced (the `factory()` source in
 * ponder.config.ts), so `event.log.address` is the account and the row key.
 *
 * LOG-ONLY, like src/factory.ts: no `eth_call` in any handler. The consequences are visible in
 * the schema. An account's asset balance is not here (a clone's `Transfer`s cannot be filtered
 * at the node for a dynamic set of addresses, and `balanceOf` is a read), so the row carries
 * `depositedTotal` / `withdrawnTotal` and the API says what they are. Seaport is not followed
 * for the clones either: `LotFilled` carries the order hash and the premium, which is the fill.
 *
 * THE ORDER OF THINGS, per contracts/src/solo/Account.sol, and what each handler reduces:
 *   requestWrite → WriteRequested(lots)         status, requestedLots, the market's pendingLots
 *   list         → LotsListed(week, opt, n, ask) status, the pinned week, lotsListed per week
 *   fill         → LotFilled(hash, opt, premium) one lot_fill row, the fill totals
 *   settle       → Settled(nvda, usdg)           one account_settlement row, the account reset
 * The pure decisions (status, outcome, totals) are lib/factoryLifecycle.ts and are unit-tested.
 */

/*//////////////////////////////////////////////////////////////
                          DEPOSIT / WITHDRAW
//////////////////////////////////////////////////////////////*/

/** `deposit`: the owner's asset moved in. Capped per account by the factory's `depositCap`. */
ponder.on("WriterAccount:Deposited", async ({ event, context }) => {
  const account = event.log.address;
  const a = await getAccount(context.db, account, event);
  await patchAccount(context.db, account, event, { depositedTotal: a.depositedTotal + event.args.assets });
  await patchMarket(context.db, event, {});
});

/** `withdraw`: idle assets out. Refused (`InsufficientIdle`) for anything reserved under a listing. */
ponder.on("WriterAccount:Withdrawn", async ({ event, context }) => {
  const account = event.log.address;
  const a = await getAccount(context.db, account, event);
  await patchAccount(context.db, account, event, { withdrawnTotal: a.withdrawnTotal + event.args.assets });
  await patchMarket(context.db, event, {});
});

/*//////////////////////////////////////////////////////////////
                            THE REQUEST
//////////////////////////////////////////////////////////////*/

/**
 * `requestWrite(lots)`. Zero withdraws the request. The market's `pendingLots` is the keeper's
 * work queue and moves by exactly this account's change of contribution.
 */
ponder.on("WriterAccount:WriteRequested", async ({ event, context }) => {
  const account = event.log.address;
  const lots = BigInt(event.args.lots);

  const a = await getAccount(context.db, account, event);
  const m = await getMarket(context.db);

  const before = { status: a.status, requestedLots: a.requestedLots };
  const after = { status: nextStatus({ kind: "WriteRequested", lots }), requestedLots: lots };

  await patchAccount(context.db, account, event, after);
  await patchMarket(context.db, event, { pendingLots: pendingLotsAfter(m.pendingLots, before, after) });

  log.info({ market: MARKET, account, owner: a.owner, lots, status: after.status, txHash: event.transaction.hash }, "write requested");
});

/*//////////////////////////////////////////////////////////////
                             THE LISTING
//////////////////////////////////////////////////////////////*/

/**
 * `list`: the week's terms are pinned onto the account and `lots` one-lot orders are on the
 * book. The account leaves the pending queue here (`factory.notifyListed`), so its request stops
 * counting towards `pendingLots`; `requestedLots` itself stays until `settle`, as on chain.
 */
ponder.on("WriterAccount:LotsListed", async ({ event, context }) => {
  const account = event.log.address;
  const { weekId: weekIdRaw, optionId, askUsdg } = event.args;
  const lots = BigInt(event.args.lots);
  const weekId = Number(weekIdRaw);

  const a = await getAccount(context.db, account, event);
  const m = await getMarket(context.db);

  const before = { status: a.status, requestedLots: a.requestedLots };
  const after = { status: nextStatus({ kind: "LotsListed" }), requestedLots: a.requestedLots };

  await patchAccount(context.db, account, event, {
    status: after.status,
    listedLots: lots,
    filledLots: 0n,
    listedWeekId: weekId,
    optionId,
    listedAskUsdg: askUsdg,
    listedAt: event.block.timestamp,
    lotsListed: a.lotsListed + lots,
  });

  const week = await findWeek(context.db, weekId);
  if (week !== null) {
    await patchWeek(context.db, weekId, weekAfterListing(week, lots));
  } else {
    log.warn({ market: MARKET, account, weekId, txHash: event.transaction.hash }, "listing under a week whose WeekSet was not indexed; week totals skip it");
  }

  await patchMarket(context.db, event, {
    pendingLots: pendingLotsAfter(m.pendingLots, before, after),
    lotsListed: m.lotsListed + lots,
  });

  log.info({ market: MARKET, account, owner: a.owner, weekId, optionId, lots, askUsdg, txHash: event.transaction.hash }, "lots listed");
});

/*//////////////////////////////////////////////////////////////
                               THE FILL
//////////////////////////////////////////////////////////////*/

/**
 * `authorizeOrder`, inside a Seaport fill: one order gone, one contract written into the
 * account's claim, `premiumUsdg` paid. The premium is the whole ask (`gross == listedAskUsdg`);
 * Seaport pays the seller's part to the owner and the fee item to the fee recipient directly,
 * so nothing lands on the account itself.
 */
ponder.on("WriterAccount:LotFilled", async ({ event, context }) => {
  const account = event.log.address;
  const { orderHash, optionId, premiumUsdg } = event.args;

  const a = await getAccount(context.db, account, event);
  const m = await getMarket(context.db);

  await context.db
    .insert(schema.lotFill)
    .values({
      id: txLogId(event.transaction.hash, event.log.logIndex),
      factory: factoryAddress(),
      account,
      owner: a.owner,
      weekId: a.listedWeekId,
      optionId,
      orderHash,
      premiumUsdg,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();

  await patchAccount(context.db, account, event, {
    filledLots: a.filledLots + 1n,
    lotsFilled: a.lotsFilled + 1n,
    premiumUsdg: a.premiumUsdg + premiumUsdg,
  });

  if (a.listedWeekId !== null) {
    const week = await findWeek(context.db, a.listedWeekId);
    if (week !== null) await patchWeek(context.db, a.listedWeekId, weekAfterFill(week, premiumUsdg));
  }

  await patchMarket(context.db, event, {
    lotsFilled: m.lotsFilled + 1n,
    premiumUsdg: m.premiumUsdg + premiumUsdg,
  });

  // FILL_DETECTED from ops/alerts.md. The most important line of the week.
  log.info(
    { market: MARKET, account, owner: a.owner, weekId: a.listedWeekId, optionId, orderHash, premiumUsdg, filledLots: a.filledLots + 1n, listedLots: a.listedLots, txHash: event.transaction.hash },
    "lot filled",
  );
});

/*//////////////////////////////////////////////////////////////
                             SETTLEMENT
//////////////////////////////////////////////////////////////*/

/**
 * `settle`, by anyone, after the account's own expiry. The unsold orders are cancelled with a
 * counter bump, the claim is redeemed if there is one, and the account is reset. The verdict
 * (`settlementOutcome`) needs this listing's fills, which the account row still holds at this
 * point, so the settlement row is written BEFORE the reset.
 */
ponder.on("WriterAccount:Settled", async ({ event, context }) => {
  const account = event.log.address;
  const { nvdaReturned, strikeUsdg } = event.args;

  const a = await getAccount(context.db, account, event);
  const m = await getMarket(context.db);

  const outcome = settlementOutcome({ filledLots: a.filledLots, assetReturned: nvdaReturned, strikeUsdg });

  await context.db
    .insert(schema.accountSettlement)
    .values({
      id: txLogId(event.transaction.hash, event.log.logIndex),
      factory: factoryAddress(),
      account,
      owner: a.owner,
      weekId: a.listedWeekId,
      lotsListed: a.listedLots,
      lotsFilled: a.filledLots,
      assetReturned: nvdaReturned,
      strikeUsdg,
      outcome,
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
      timestamp: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();

  const before = { status: a.status, requestedLots: a.requestedLots };
  const reset = accountAfterSettled(a, outcome);
  const after = { status: reset.status, requestedLots: reset.requestedLots };

  await patchAccount(context.db, account, event, {
    ...reset,
    settlements: a.settlements + 1,
    lastSettledAt: event.block.timestamp,
  });

  if (a.listedWeekId !== null) {
    const week = await findWeek(context.db, a.listedWeekId);
    if (week !== null) await patchWeek(context.db, a.listedWeekId, weekAfterSettlement(week, { assetReturned: nvdaReturned, strikeUsdg }));
  }

  await patchMarket(context.db, event, {
    pendingLots: pendingLotsAfter(m.pendingLots, before, after),
    settlements: m.settlements + 1,
    assetReturned: m.assetReturned + nvdaReturned,
    assignedUsdg: m.assignedUsdg + strikeUsdg,
  });

  const fields = { market: MARKET, account, owner: a.owner, weekId: a.listedWeekId, outcome, lotsListed: a.listedLots, lotsFilled: a.filledLots, nvdaReturned, strikeUsdg, txHash: event.transaction.hash };
  if (outcome === "unredeemed") {
    // The redeem returned nothing on a written week: the account keeps its claim and cannot list
    // again until it is resolved. STRANDED_CLAIM territory for one account rather than the pool.
    log.warn(fields, "account settled with an unredeemed claim");
  } else {
    log.info(fields, "account settled");
  }
});

/*//////////////////////////////////////////////////////////////
                           USDG / OWNERSHIP
//////////////////////////////////////////////////////////////*/

/** `claimUsdg`: strike proceeds (an assigned week's USDG lands on the account) swept to the owner. Premium never passes through here. */
ponder.on("WriterAccount:UsdgClaimed", async ({ event, context }) => {
  const account = event.log.address;
  const { amount } = event.args;
  const a = await getAccount(context.db, account, event);
  const m = await getMarket(context.db);
  await patchAccount(context.db, account, event, { claimedUsdg: a.claimedUsdg + amount });
  await patchMarket(context.db, event, { claimedUsdg: m.claimedUsdg + amount });
  log.info({ market: MARKET, account, to: event.args.to, amount, txHash: event.transaction.hash }, "usdg claimed");
});

/** The clone's side of a rekey, one log after `Factory:AccountRekeyed`. Same owner, set twice. */
ponder.on("WriterAccount:OwnershipTransferred", async ({ event, context }) => {
  const account = event.log.address;
  await patchAccount(context.db, account, event, { owner: event.args.to });
  await patchMarket(context.db, event, {});
});
