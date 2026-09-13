import { ponder } from "ponder:registry";
import schema from "ponder:schema";

import { CLEARINGHOUSE, OVERCALL_FEE_RECIPIENT, USDG, VAULT } from "../lib/env";
import { getCycle, getState, patchCycle, patchState, safeDiv } from "../lib/indexing";
import { log } from "../lib/log";

/** Seaport ItemType. Only these two ever appear in an Overcall listing. */
const ITEM_ERC20 = 1;
const ITEM_ERC1155 = 3;

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * A buyer filled one of our listings.
 *
 * THIS IS THE ONLY SOURCE OF TRUTH FOR WHAT WE SOLD AND WHAT WE GOT.
 * `AdapterValorem.contractsSold` is declared on the vault but never written on chain, and the
 * vault emits no fill event of its own — Seaport moves the ERC-1155 straight out of the vault
 * with no callback. So both the contract count and the realised price come from here.
 *
 * The order is PARTIAL_OPEN, so a fill may be partial and there may be several of them. Every
 * amount below is therefore accumulated, never assigned.
 *
 * The consideration is read by recipient rather than by position: item 0 pays the vault (95%
 * of gross) and item 1 pays Overcall (5%), but reading them positionally would silently
 * mis-attribute money if the shape ever changed. Seaport scales both items by the fill
 * fraction, which is exactly why the vault's listing check forces the fee to be rounded per
 * contract — an unevenly divisible item makes a partial fill revert with InexactFraction.
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
  let toOvercall = 0n;
  for (const item of consideration) {
    if (item.itemType !== ITEM_ERC20 || !eq(item.token, USDG)) continue;
    if (eq(item.recipient, VAULT)) toVault += item.amount;
    else if (eq(item.recipient, OVERCALL_FEE_RECIPIENT)) toOvercall += item.amount;
  }
  const gross = toVault + toOvercall;

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
      feePaidUsdg: listingRow.feePaidUsdg + toOvercall,
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
      status: c.status === "idle" || c.status === "listed" ? "filled" : c.status,
      contractsSold,
      premiumGross,
      premiumToVault: c.premiumToVault + toVault,
      overcallFee: c.overcallFee + toOvercall,
      fillUnitPriceUsdg: safeDiv(premiumGross, contractsSold),
      fillCount: c.fillCount + 1,
      firstFillAt: c.firstFillAt ?? event.block.timestamp,
      lastFillAt: event.block.timestamp,
    });
  }

  await patchState(context.db, {
    contractsSold: state.contractsSold + contracts,
    lifetimePremiumGross: state.lifetimePremiumGross + gross,
    lifetimePremiumToVault: state.lifetimePremiumToVault + toVault,
    lifetimeOvercallFee: state.lifetimeOvercallFee + toOvercall,
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
      toOvercall,
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
