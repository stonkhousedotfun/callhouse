/* -------------------------------------------------------------------------------------------------
 * The keeper defaults the rehearsal's own numbers depend on, mirrored from keeper/src. botEnv (stack.mjs)
 * sets no MM_* or PRICER_* override, so the bots the rehearsal runs use exactly these values.
 * keeper-defaults.test.mjs reads the keeper source and fails when one of them drifts.
 *
 *   MM_FAIR_SPOT_TOLERANCE_BPS    a pool reading within this of the oracle's spot refreshes the mm-bot's spot clock
 *                                 (mm/reads.ts readSpotClocks); 2-services.mjs opens the dual market OUTSIDE it (50 bps
 *                                 cannot also leave r0 in the money), so 3-story.mjs heartbeats its feed
 *   MM_MAX_SPOT_AGE_S             the mm-bot's spot-age halt; 3-story.mjs's feed heartbeat stays under it
 *   MM_OPEN_GRACE_S               the mm-bot's open-grace halt; 4-drills.mjs mint-paused steps past it
 *   PRICER_EDGE_BPS               the pricer's target is fair × (1 + edge) (pricer/planner.ts targetPrice)
 *   PRICER_REPRICE_THRESHOLD_BPS  the pricer's "> 10 %" rule (pricer/planner.ts differsEnough)
 *   PRICE_TICK                    the order book's price grid (cranker/constants.ts)
 * ------------------------------------------------------------------------------------------------- */

/** keeper/src/v2/config.ts */
export const MM_FAIR_SPOT_TOLERANCE_BPS = 50n;
/** keeper/src/v2/config.ts */
export const MM_MAX_SPOT_AGE_S = 120;
/** keeper/src/v2/config.ts */
export const MM_OPEN_GRACE_S = 1_800;
/** keeper/src/v2/config.ts */
export const PRICER_EDGE_BPS = 500n;
/** keeper/src/v2/config.ts */
export const PRICER_REPRICE_THRESHOLD_BPS = 1_000n;
/** keeper/src/v2/cranker/constants.ts */
export const PRICE_TICK = 100n;
