import { ponder } from "ponder:registry";
import schema from "ponder:schema";

import { CLEARINGHOUSE, USDG, VAULT } from "../lib/env";
import { getCycle, getState, patchCycle, patchState, safeDiv } from "../lib/indexing";
import { log } from "../lib/log";

/** Seaport ItemType. Only these two ever appear in a vault listing. */
const ITEM_ERC20 = 1;
const ITEM_ERC1155 = 3;

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * A buyer filled one of our listings.
 *
 * THE FILL IS THE WRITE. The listing is a PARTIAL_RESTRICTED order whose zone is the vault, so
 * Seaport calls the vault's `authorizeOrder` before moving anything: the vault writes exactly
 * `offer[0].amount` contracts into Valorem (its own `CallsWritten`, earlier in this same
 * transaction, carries the count and the collateral), Seaport moves the freshly minted tokens to
 * the buyer, and `validateOrder` asserts none stayed behind. So the contract count here and the
 * count in `CallsWritten` are the same number seen from two sides, and the realised price is
 * this event's consideration.
 *
 * The order is partial, so a fill may be partial and there may be several of them. Every
 * amount below is therefore accumulated, never assigned.
 *
 * ONE CONSIDERATION ITEM: USDG to the vault. There is no venue fee item, so what the buyer paid
 * is what reached the vault. The item is still read by recipient rather than by position, and
 * anything else in the consideration is logged: the vault's approval rejects any other shape,
 * so a second item would mean the tape is reading an order the vault never authorised.
 */
ponder.on("Seaport:OrderFulfilled", async ({ event, context }) => {
  const { orderHash, offerer, offer, consideration } = event.args;

  // Belt and braces: the config already filters on `offerer`, which is an indexed topic.
  if (!eq(offerer, VAULT)) return;

  let contracts = 0n;
  for (const item of offer) {
    if (item.itemType === ITEM_ERC1155 && eq(item.token, CLEARINGHOUSE)) {
      contracts += item.amount;
    }
  }

  let toVault = 0n;
  let elsewhere = 0n;
  for (const item of consideration) {
    if (item.itemType !== ITEM_ERC20 || !eq(item.token, USDG)) continue;
    if (eq(item.recipient, VAULT)) toVault += item.amount;
    else elsewhere += item.amount;
  }
  if (elsewhere !== 0n) {
    log.warn({ orderHash, elsewhere, txHash: event.transaction.hash }, "fill paid USDG to a recipient other than the vault");
  }
  const gross = toVault;

  const listingRow = await context.db.find(schema.listing, { orderHash });
  const state = await getState(context.db);

  // A fill can only exist for an order the vault authorised, so the listing row is normally
  // present. If the indexer was started after the approval, fall back to the live cycle so
  // the money is still attributed rather than dropped.
  const cycleNumber = listingRow?.cycleNumber ?? state.cycleNumber;

  if (listingRow !== null) {
    const filledSoFar = listingRow.contractsFilled + contracts;
    const complete = filledSoFar >= listingRow.amount;
    await context.db.update(schema.listing, { orderHash }).set({
      contractsFilled: filledSoFar,
      proceedsUsdg: listingRow.proceedsUsdg + toVault,
      fillCount: listingRow.fillCount + 1,
      status: complete ? "filled" : "partially_filled",
      lastFillAt: event.block.timestamp,
      lastFillTx: event.transaction.hash,
      endedAt: complete ? event.block.timestamp : listingRow.endedAt,
      endedTx: complete ? event.transaction.hash : listingRow.endedTx,
      endReason: complete ? "filled" : listingRow.endReason,
    });
  }

  if (cycleNumber !== 0) {
    const c = await getCycle(context.db, cycleNumber);
    const contractsSold = c.contractsSold + contracts;
    const premiumGross = c.premiumGross + gross;
    await patchCycle(context.db, cycleNumber, {
      // `filled` only ever moves the cycle forward; a later rollClose decides the final word.
      status: c.status === "listed" ? "filled" : c.status,
      contractsSold,
      premiumGross,
      fillUnitPriceUsdg: safeDiv(premiumGross, contractsSold),
      fillCount: c.fillCount + 1,
      firstFillAt: c.firstFillAt ?? event.block.timestamp,
      lastFillAt: event.block.timestamp,
    });
  }

  await patchState(context.db, {
    lifetimePremiumGross: state.lifetimePremiumGross + gross,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });

  // FILL_DETECTED / PARTIAL_FILL from ops/alerts.md. The most important line of the week.
  log.info(
    {
      orderHash,
      cycleNumber,
      contracts,
      toVault,
      complete: listingRow !== null ? listingRow.contractsFilled + contracts >= listingRow.amount : null,
      txHash: event.transaction.hash,
    },
    "listing filled",
  );
});

/**
 * Seaport's own record of a cancellation, from `seaport.cancel([components])`.
 *
 * The vault emits `ListingCancelled` in the same transaction, so this mostly confirms the
 * other handler. It is indexed anyway because it is the only signal that survives if the
 * cancellation ever happens by a route the vault does not emit for.
 */
ponder.on("Seaport:OrderCancelled", async ({ event, context }) => {
  const { orderHash } = event.args;

  const l = await context.db.find(schema.listing, { orderHash });
  if (l === null || l.status === "filled") return;

  await context.db.update(schema.listing, { orderHash }).set({
    status: l.contractsFilled > 0n ? "partially_filled" : "cancelled",
    endedAt: l.endedAt ?? event.block.timestamp,
    endedTx: l.endedTx ?? event.transaction.hash,
    endReason: l.endReason ?? "cancelled",
  });
});

/** The offerer's nonce moved, so every outstanding order signed under the old one is dead. */
ponder.on("Seaport:CounterIncremented", async ({ event, context }) => {
  await patchState(context.db, {
    seaportCounter: event.args.newCounter,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});
