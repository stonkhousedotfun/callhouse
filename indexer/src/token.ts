import { ponder } from "ponder:registry";

import { getState, patchState, snapshot, sub } from "../lib/indexing";
import { log } from "../lib/log";

/**
 * Token balances, derived from logs instead of read over RPC.
 *
 * Two sources per token because a log filter ANDs its topics: `from == vault` and
 * `to == vault` cannot be expressed as one filter, so the config registers an "In" and an
 * "Out" contract at the same address. A self-transfer would hit both and net to zero, which
 * is the correct answer.
 *
 * Keeping these balances in the database rather than calling `balanceOf` at every event makes
 * the whole index deterministic and replayable from a backfill, and it is what lets
 * `idleAssets` (balance − reservedAssets) be reported without an RPC round trip.
 *
 * DECIMALS: the Stock Token is 18, USDG is 6. Nothing here converts between them; the API
 * reports base units and labels the scale.
 *
 * No snapshot is taken here. These transfers always sit inside a vault transaction that emits
 * its own event moments later — `Deposit` fires after the asset moves and after the mint — so
 * the snapshot taken by that handler already sees the updated balance.
 */

ponder.on("StockTokenIn:Transfer", async ({ event, context }) => {
  const s = await getState(context.db);
  await patchState(context.db, {
    assetBalance: s.assetBalance + event.args.value,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

ponder.on("StockTokenOut:Transfer", async ({ event, context }) => {
  const s = await getState(context.db);
  await patchState(context.db, {
    assetBalance: sub(s.assetBalance, event.args.value),
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

ponder.on("UsdgIn:Transfer", async ({ event, context }) => {
  const s = await getState(context.db);
  await patchState(context.db, {
    usdgBalance: s.usdgBalance + event.args.value,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

ponder.on("UsdgOut:Transfer", async ({ event, context }) => {
  const s = await getState(context.db);
  await patchState(context.db, {
    usdgBalance: sub(s.usdgBalance, event.args.value),
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
});

/*//////////////////////////////////////////////////////////////
                      THE ISSUER'S SWITCHES
//////////////////////////////////////////////////////////////*/

/**
 * Stock Tokens are debt securities issued by a regulated entity, and that entity keeps two
 * levers this vault cannot route around. Both are indexed and both are published.
 *
 *   oracle pause    `rollOpen` reverts while it is on, so the week is simply not written.
 *                   That is the designed response: no price, no write.
 *   transfer pause  freezes the token itself. Deposits, redemptions and settlement all stop.
 *                   Nothing in this codebase can fix that; the honest thing is to show it.
 *
 * Each gets a snapshot row so the trail shows exactly when the vault's hands were tied.
 */

ponder.on("StockToken:OraclePaused", async ({ event, context }) => {
  await patchState(context.db, {
    oraclePaused: true,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
  // ORACLE_PAUSED from ops/alerts.md: every rollOpen reverts until this lifts.
  log.warn({ txHash: event.transaction.hash }, "stock token oracle paused");
  await snapshot(context.db, event, "OraclePaused");
});

ponder.on("StockToken:OracleUnpaused", async ({ event, context }) => {
  await patchState(context.db, {
    oraclePaused: false,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
  log.info({ txHash: event.transaction.hash }, "stock token oracle unpaused");
  await snapshot(context.db, event, "OracleUnpaused");
});

ponder.on("StockToken:Paused", async ({ event, context }) => {
  await patchState(context.db, {
    tokenPaused: true,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
  // ASSET_TRANSFER_FAILED territory: deposits, redemptions and settlement all stop.
  log.warn({ txHash: event.transaction.hash }, "stock token transfers paused");
  await snapshot(context.db, event, "TokenPaused");
});

ponder.on("StockToken:Unpaused", async ({ event, context }) => {
  await patchState(context.db, {
    tokenPaused: false,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
  log.info({ txHash: event.transaction.hash }, "stock token transfers unpaused");
  await snapshot(context.db, event, "TokenUnpaused");
});

/**
 * ERC-8056: the issuer schedules a new display multiplier for a dividend or a split.
 *
 * `newMultiplier` does not take effect until `effectiveAtTimestamp`, so both are kept: the
 * live value is whatever `uiMultiplier()` returns now, and the pending pair is what the UI
 * should warn about. NOTHING here touches share maths — the vault never rebases, and a
 * multiplier change must leave the price per share untouched.
 */
ponder.on("StockToken:UIMultiplierUpdated", async ({ event, context }) => {
  const { newMultiplier, effectiveAtTimestamp } = event.args;
  await patchState(context.db, {
    uiMultiplierPending: newMultiplier,
    uiMultiplierEffectiveAt: effectiveAtTimestamp,
    lastBlock: event.block.number,
    lastTimestamp: event.block.timestamp,
  });
  // A dividend or a split, scheduled. Display-only for us — share maths never rebases — but
  // the UI warns about it, so the trail should show when it was announced.
  log.info({ newMultiplier, effectiveAtTimestamp, txHash: event.transaction.hash }, "ui multiplier scheduled");
  await snapshot(context.db, event, "UIMultiplierUpdated", {
    client: context.client,
    refreshMultiplier: true,
  });
});
