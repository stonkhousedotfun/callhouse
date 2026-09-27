/* -------------------------------------------------------------------------------------------------
 * The declared list of app copies of contract numbers. Checked by ops/v2/contract-mirrors.test.mjs.
 *
 * One entry per contract member, with every place (site) that copies it:
 *   kind "compiled"  the member is a compiled constant with no setter; a copy is right. The guard goes red by name the
 *                    day a restricted setter for it appears in ops/abis/v2/roles.json or in the fixture regenerated
 *                    from contracts, the day it stops being a constant, and whenever a copy's value differs.
 *   kind "pending"   the member is becoming a setting in an in-flight contracts change; `row` names the app change that makes
 *                    the app read it live. Checked like "compiled", so it stays honest: it is
 *                    green today because main has no setter yet, and it goes red naming that change when one lands.
 *   kind "live"      the member is settable and the app READS it from chain (or from indexed events); documentation
 *                    of where the live read is, and the stale-declaration check still applies to its sites.
 *
 * `setters` names extra setter functions that would make the member settable (`Contract.setX` limits the search to
 * that contract); `set<Member>` in camel case is always searched on every target. This file holds NO facts about which
 * setters exist: those come only from the manifests.
 *
 * Adding a copy: declare it here (the guard's scanner finds a name equal to a contract constant, or a
 * `Contract.MEMBER` citation in the comment block directly above a literal). If the value is settable on main, do not declare a
 * copy: read it from chain.
 * ------------------------------------------------------------------------------------------------- */

const s = (file, ...symbols) => symbols.map((symbol) => ({ file, symbol }));

export const MIRRORS = [
  /* ---- units and arithmetic: compiled, and a change would be a new interface version ---- */
  { name: "bps", contract: "V2Constants", member: "BPS", kind: "compiled", sites: [
    ...s("indexer/lib/v2/autoRoller.ts", "BPS"), ...s("indexer/lib/v2/cards.ts", "BPS"), ...s("indexer/lib/v2/makerScoring.ts", "BPS"),
    ...s("indexer/scripts/lender-epoch.mjs", "BPS"), ...s("indexer/src/v2/earnYield.ts", "BPS"), ...s("keeper/src/config.ts", "BPS"),
    ...s("keeper/src/dryrun-common.ts", "BPS"), ...s("keeper/src/v2/cranker/constants.ts", "BPS"), ...s("keeper/src/v2/earn/plan.ts", "BPS"),
    ...s("keeper/src/v2/mm/constants.ts", "BPS"), ...s("ops/rehearse-lifecycle/money/math.mjs", "BPS"), ...s("ops/v2/rehearse/3-story.mjs", "BPS"), ...s("ops/v2/rehearse/4-drills.mjs", "BPS"),
    ...s("ops/v2/rehearse/launch-set.mjs", "BPS"), ...s("ops/stonkctl/src/stonkctl/settledrill.py", "BPS"), ...s("web/lib/cycleTerms.ts", "BPS"), ...s("web/lib/exercise.ts", "BPS"),
    ...s("web/lib/format.ts", "BPS"), ...s("web/lib/v2/payoff.ts", "BPS"), ...s("web/lib/v2/smartPricing.ts", "BPS"), ...s("web/lib/v2/stockSwap.ts", "BPS"),
  ] },
  { name: "ppm", contract: "V2Constants", member: "PPM", kind: "compiled", sites: [...s("indexer/lib/v2/makerScoring.ts", "PPM"), ...s("keeper/src/v2/cranker/constants.ts", "PPM")] },
  { name: "unit", contract: "V2Constants", member: "UNIT", kind: "compiled", sites: [
    ...s("indexer/lib/v2/book.ts", "UNIT"), ...s("indexer/lib/v2/cards.ts", "UNIT"), ...s("indexer/src/api/v2/accounts.ts", "UNIT"),
    ...s("keeper/src/v2/cranker/constants.ts", "UNIT"), ...s("ops/rehearse-lifecycle/money/math.mjs", "UNIT"), ...s("web/lib/v2/payoff.ts", "UNIT"),
  ] },
  { name: "units-per-share", contract: "V2Constants", member: "UNITS_PER_SHARE", kind: "compiled", sites: [
    ...s("indexer/lib/v2/book.ts", "UNITS_PER_SHARE"), ...s("indexer/lib/v2/cards.ts", "UNITS_PER_SHARE"),
    ...s("keeper/src/v2/cranker/constants.ts", "UNITS_PER_SHARE"), ...s("keeper/src/v2/mm/constants.ts", "UNITS_PER_SHARE"), ...s("web/lib/v2/payoff.ts", "UNITS_PER_SHARE"),
  ] },
  { name: "price-tick", contract: "V2Constants", member: "PRICE_TICK", kind: "compiled", sites: [
    ...s("indexer/lib/v2/autoRoller.ts", "PRICE_TICK"), ...s("indexer/lib/v2/selfTrade.ts", "PRICE_TICK"), ...s("keeper/src/v2/cranker/constants.ts", "PRICE_TICK"),
    ...s("keeper/src/v2/mm/constants.ts", "PRICE_TICK"), ...s("ops/devnet/seed.mjs", "PRICE_TICK"), ...s("ops/markets/build-markets.mjs", "PRICE_TICK"),
    ...s("ops/v2/rehearse/keeper-defaults.mjs", "PRICE_TICK"), ...s("web/lib/v2/payoff.ts", "PRICE_TICK"), ...s("web/lib/v2/smartPricing.ts", "PRICE_TICK"),
  ] },
  { name: "share-1e18", contract: "Clearinghouse", member: "SHARE", kind: "compiled", sites: s("web/lib/v2/displaySpot.ts", "SHARE") },
  { name: "earn-one-share", contract: "EarnVault", member: "ONE_SHARE", kind: "compiled", sites: [
    ...s("indexer/src/v2/earnYield.ts", "ONE_SHARE"), ...s("web/lib/v2/chainReads.ts", "EARN_QUOTE_SHARES"),
  ] },
  { name: "seconds-per-day", contract: "ExpiryCalendar", member: "DAY", kind: "compiled", sites: [
    ...s("indexer/lib/v2/makerScoring.ts", "DAY"), ...s("indexer/src/v2/earnYield.ts", "DAY_S"), ...s("keeper/src/v2/pricing/coverage.ts", "DAY_S"),
    ...s("ops/v2/monitor.mjs", "DAY_S"), ...s("web/components/v2/chart/chartMath.ts", "DAY"), ...s("web/lib/v2/priceHistory.ts", "DAY"),
  ] },
  { name: "tick-min", contract: "TickMath", member: "MIN_TICK", kind: "compiled", sites: s("keeper/src/v2/pricing/pool-spot.ts", "MIN_TICK") },
  { name: "tick-max", contract: "TickMath", member: "MAX_TICK", kind: "compiled", sites: s("keeper/src/v2/pricing/pool-spot.ts", "MAX_TICK") },

  /* ---- settlement timing: compiled ---- */
  { name: "settlement-window", contract: "V2Constants", member: "SETTLEMENT_WINDOW", kind: "compiled", sites: [
    ...s("keeper/src/v2/cranker/constants.ts", "SETTLEMENT_WINDOW"), ...s("keeper/src/v2/mm/constants.ts", "SETTLEMENT_WINDOW"),
    ...s("ops/markets/render-docs.mjs", "SETTLEMENT_WINDOW_S"), ...s("ops/v2/monitor.mjs", "SETTLEMENT_WINDOW"),
    ...s("indexer/src/v2/settlementWindow.ts", "SETTLEMENT_WINDOW"),
    // The wave feed-age note (feed age + SETTLEMENT_WINDOW + the one clock jump, RegisterMarkets._feedAtSettlement).
    ...s("ops/stonkctl/src/stonkctl/waves.py", "SETTLEMENT_WINDOW_S"),
  ] },
  { name: "finalize-delay", contract: "V2Constants", member: "FINALIZE_DELAY", kind: "compiled", sites: [
    ...s("keeper/src/v2/cranker/constants.ts", "FINALIZE_DELAY"), ...s("ops/v2/monitor.mjs", "FINALIZE_DELAY"), ...s("web/lib/v2/payoutTiming.ts", "FINALIZE_DELAY_S"),
    ...s("ops/stonkctl/src/stonkctl/settledrill.py", "FINALIZE_DELAY"), ...s("ops/rehearse-lifecycle/weekend-drill/lib.mjs", "FINALIZE_DELAY_S"),
  ] },
  { name: "snapshot-grace", contract: "V2Constants", member: "SNAPSHOT_GRACE", kind: "compiled", sites: [
    ...s("keeper/src/v2/cranker/constants.ts", "SNAPSHOT_GRACE"), ...s("ops/markets/render-docs.mjs", "SNAPSHOT_GRACE_S"), ...s("ops/v2/monitor.mjs", "SNAPSHOT_GRACE"),
    ...s("ops/stonkctl/src/stonkctl/settledrill.py", "SNAPSHOT_GRACE"), ...s("ops/rehearse-lifecycle/weekend-drill/lib.mjs", "SNAPSHOT_GRACE_S"),
  ] },
  { name: "resolve-delay", contract: "V2Constants", member: "RESOLVE_DELAY", kind: "compiled", sites: [...s("ops/v2/monitor.mjs", "RESOLVE_DELAY"), ...s("web/lib/v2/payoutTiming.ts", "RESOLVE_DELAY_S"),
    ...s("ops/rehearse-lifecycle/weekend-drill/lib.mjs", "RESOLVE_DELAY_S")] },
  { name: "held-resolve-delay", contract: "SettlementOracle", member: "HELD_RESOLVE_DELAY", kind: "compiled", sites: [
    ...s("ops/v2/monitor.mjs", "HELD_RESOLVE_DELAY"), ...s("ops/rehearse-lifecycle/weekend-drill/lib.mjs", "HELD_RESOLVE_DELAY_S")] },
  // The week rollEpoch holds a boundary the vault did not lock. The keeper keeps no copy: it reads
  // the hold's end from the TooEarly refusal itself (keeper/src/v2/cranker/steps.ts houseRollHeldUntil).
  { name: "unpinned-boundary-hold", contract: "HouseVault", member: "UNPINNED_BOUNDARY_HOLD", kind: "compiled", sites: [
    ...s("ops/v2/monitor.mjs", "UNPINNED_BOUNDARY_HOLD"), ...s("web/lib/v2/houseEpoch.ts", "UNPINNED_BOUNDARY_HOLD_S")] },
  { name: "min-series-lead", contract: "V2Constants", member: "MIN_SERIES_LEAD", kind: "compiled", sites: [
    ...s("keeper/src/v2/cranker/constants.ts", "MIN_SERIES_LEAD"), ...s("ops/v2/monitor.mjs", "MIN_SERIES_LEAD"), ...s("web/lib/v2/earnTx.ts", "MIN_SERIES_LEAD_SECONDS"),
  ] },
  { name: "max-tenor", contract: "V2Constants", member: "MAX_TENOR", kind: "compiled", sites: [
    ...s("keeper/src/v2/cranker/constants.ts", "MAX_TENOR"), ...s("ops/v2/monitor.mjs", "MAX_TENOR"), ...s("web/lib/v2/earnTx.ts", "MAX_TENOR_SECONDS"),
  ] },
  { name: "next-expiry-search", contract: "ExpiryCalendar", member: "NEXT_EXPIRY_SEARCH", kind: "compiled", sites: s("keeper/src/v2/pricing/coverage.ts", "NEXT_EXPIRY_SEARCH_S") },
  { name: "roll-open-grace", contract: "AutoRoller", member: "ROLL_OPEN_GRACE", kind: "compiled", sites: s("keeper/src/v2/cranker/constants.ts", "ROLL_OPEN_GRACE_S") },
  // The daily roll's expiry is ExpiryCalendar.nextExpiry(now + DAILY_MIN_LEAD, false); the cranker reads that close
  // to refuse an NVDA daily roll into a Tuesday or Thursday series (cranker/steps.ts dailyListedOf).
  { name: "roll-daily-min-lead", contract: "AutoRoller", member: "DAILY_MIN_LEAD", kind: "compiled", sites: s("keeper/src/v2/cranker/constants.ts", "DAILY_MIN_LEAD_S") },
  // AutoRoller.cancelStale's witness path (_tryWitness) acts on a source-1 reading at most WITNESS_MAX_AGE
  // old. The cranker's stale step mirrors it to plan exactly the cancels the contract makes (cranker/steps.ts witnessesAt),
  // and the monitor's roller page to judge an ask overtaken the way the contract does (monitor.mjs witnessReading).
  { name: "roller-witness-max-age", contract: "AutoRoller", member: "WITNESS_MAX_AGE", kind: "compiled", sites: [
    ...s("keeper/src/v2/cranker/constants.ts", "STALE_WITNESS_MAX_AGE_S"), ...s("ops/v2/monitor.mjs", "WITNESS_MAX_AGE"),
  ] },
  { name: "spot-corroboration-age", contract: "SettlementOracle", member: "SPOT_CORROBORATION_AGE", kind: "compiled", sites: s("keeper/src/v2/mm/constants.ts", "SPOT_CORROBORATION_AGE_S") },
  { name: "oracle-max-sources", contract: "SettlementOracle", member: "MAX_SOURCES", kind: "compiled", sites: s("keeper/src/v2/cranker/constants.ts", "MAX_ORACLE_SOURCES") },
  { name: "min-uncorroborated-delay", contract: "SettlementOracle", member: "MIN_UNCORROBORATED_DELAY", kind: "compiled", sites: s("ops/markets/build-markets.mjs", "MIN_UNCORROBORATED_DELAY_S") },
  { name: "max-uncorroborated-delay", contract: "SettlementOracle", member: "MAX_UNCORROBORATED_DELAY", kind: "compiled", sites: s("ops/markets/build-markets.mjs", "MAX_UNCORROBORATED_DELAY_S") },
  // Found once DEFAULT_X matched an app copy named X. The web's fallback wait when a caller has no live
  // per-market value (the per-market delay is settable through setMarket; this compiled default is not).
  { name: "default-uncorroborated-delay", contract: "SettlementOracle", member: "DEFAULT_UNCORROBORATED_DELAY", kind: "compiled", sites: s("web/lib/v2/payoutTiming.ts", "UNCORROBORATED_DELAY_S") },
  { name: "max-spot-max-age", contract: "SettlementOracle", member: "MAX_SPOT_MAX_AGE", kind: "compiled", sites: s("ops/markets/build-markets.mjs", "MAX_SPOT_MAX_AGE_S") },
  { name: "min-pool-cardinality", contract: "V2Constants", member: "MIN_POOL_OBSERVATION_CARDINALITY", kind: "compiled", sites: [
    ...s("ops/markets/build-markets.mjs", "MIN_POOL_OBSERVATION_CARDINALITY"), ...s("ops/stonkctl/src/stonkctl/registry.py", "MIN_POOL_CARDINALITY"),
    ...s("ops/v8/liquidity-floors.mjs", "MIN_POOL_OBSERVATION_CARDINALITY"),
  ] },

  /* ---- fee ceilings and delays: compiled (the fees themselves are settable and read live) ---- */
  { name: "fee-change-delay", contract: "V2Constants", member: "FEE_CHANGE_DELAY", kind: "compiled", sites: [
    ...s("keeper/src/v2/mm/constants.ts", "FEE_CHANGE_DELAY_S"), ...s("ops/v2/monitor.mjs", "FEE_CHANGE_DELAY"), ...s("ops/v2/rehearse/4-drills.mjs", "FEE_CHANGE_DELAY_S"),
  ] },
  { name: "premium-fee-ceil", contract: "V2Constants", member: "PREMIUM_FEE_CEIL_BPS", kind: "compiled", sites: s("keeper/src/v2/mm/constants.ts", "PREMIUM_FEE_CEIL_BPS") },
  { name: "exercise-fee-ceil", contract: "V2Constants", member: "EXERCISE_FEE_CEIL_BPS", kind: "compiled", sites: s("web/components/v2/PnlImage.tsx", "EXERCISE_FEE_CEIL_BPS") },
  { name: "taker-fee-cap-ceil", contract: "V2Constants", member: "TAKER_FEE_CAP_CEIL_BPS", kind: "compiled", sites: s("keeper/src/v2/cranker/constants.ts", "TAKER_FEE_CAP_CEIL_BPS") },
  { name: "taker-fee-flat-ceil", contract: "V2Constants", member: "TAKER_FEE_FLAT_CEIL", kind: "compiled", sites: s("ops/markets/build-markets.mjs", "TAKER_FEE_FLAT_CEIL") },
  { name: "mint-fee-ceil", contract: "V2Constants", member: "MINT_FEE_CEIL_PPM", kind: "compiled", sites: [
    ...s("indexer/lib/v2/rent.ts", "MINT_FEE_CEIL_PPM"), ...s("keeper/src/v2/cranker/constants.ts", "MINT_FEE_CEIL_PPM"), ...s("keeper/src/v2/registry.ts", "MINT_FEE_CEIL_PPM"),
    ...s("ops/markets/build-markets.mjs", "MINT_FEE_CEIL_PPM"), ...s("ops/stonkctl/src/stonkctl/registry.py", "MINT_FEE_CEIL_PPM"), ...s("ops/v2/monitor.mjs", "MINT_FEE_CEIL_PPM"),
  ] },
  { name: "mint-fee-period", contract: "V2Constants", member: "MINT_FEE_PERIOD", kind: "compiled", sites: [
    ...s("indexer/lib/v2/rent.ts", "MINT_FEE_PERIOD"), ...s("keeper/src/v2/cranker/constants.ts", "MINT_FEE_PERIOD_S"), ...s("ops/v2/monitor.mjs", "MINT_FEE_PERIOD"), ...s("web/lib/v2/rent.ts", "MINT_FEE_PERIOD"),
  ] },
  { name: "max-route-fee-tier", contract: "V2Constants", member: "MAX_ROUTE_FEE_TIER", kind: "compiled", sites: [
    ...s("keeper/src/v2/registry.ts", "MAX_ROUTE_FEE_TIER"), ...s("ops/markets/build-markets.mjs", "MAX_ROUTE_FEE_TIER"), ...s("ops/markets/render-docs.mjs", "MAX_ROUTE_FEE_TIER"),
    ...s("ops/markets/route-liquidity.mjs", "MAX_ROUTE_FEE_TIER"), ...s("ops/v2/monitor.mjs", "MAX_ROUTE_FEE_TIER"),
  ] },
  { name: "max-route-fee-bps", contract: "V2Constants", member: "MAX_ROUTE_FEE_BPS", kind: "compiled", sites: [
    ...s("ops/v2/monitor.mjs", "MAX_ROUTE_FEE_BPS"), ...s("web/lib/v2/payoff.ts", "MAX_ROUTE_FEE_BPS"), ...s("ops/stonkctl/src/stonkctl/settledrill.py", "MAX_ROUTE_FEE_BPS"),
  ] },
  { name: "max-payout-slippage-ceil", contract: "V2Constants", member: "MAX_PAYOUT_SLIPPAGE_CEIL_BPS", kind: "compiled", sites: [
    ...s("web/lib/v2/payoff.ts", "MAX_PAYOUT_SLIPPAGE_CEIL_BPS"), ...s("ops/stonkctl/src/stonkctl/settledrill.py", "MAX_PAYOUT_SLIPPAGE_CEIL_BPS"),
  ] },
  { name: "max-discount", contract: "V2Constants", member: "MAX_DISCOUNT_BPS", kind: "compiled", sites: s("ops/v2/monitor.mjs", "MAX_DISCOUNT_BPS") },
  { name: "max-hook-fee", contract: "V2Constants", member: "MAX_HOOK_FEE_BPS", kind: "compiled", sites: s("ops/v2/monitor.mjs", "MAX_HOOK_FEE_BPS") },

  /* ---- vault and roller constants: compiled ---- */
  { name: "max-live-orders-per-series", contract: "MakerVault", member: "MAX_LIVE_ORDERS_PER_SERIES", kind: "compiled", sites: [
    ...s("keeper/src/v2/mm/constants.ts", "MAX_LIVE_ORDERS_PER_SERIES"), ...s("ops/v2/monitor.mjs", "MAX_LIVE_ORDERS_PER_SERIES"),
  ] },
  { name: "outflow-window", contract: "MakerVault", member: "OUTFLOW_WINDOW", kind: "compiled", sites: [...s("keeper/src/v2/mm/constants.ts", "OUTFLOW_WINDOW_S"), ...s("ops/v2/monitor.mjs", "OUTFLOW_WINDOW")] },
  { name: "vault-min-ask-of-spot", contract: "MakerVault", member: "MIN_ASK_BPS_OF_SPOT", kind: "compiled", sites: s("keeper/src/v2/mm/constants.ts", "MIN_ASK_BPS_OF_SPOT") },
  { name: "roller-min-ask", contract: "AutoRoller", member: "MIN_ASK_BPS", kind: "compiled", sites: [...s("indexer/lib/v2/autoRoller.ts", "MIN_ASK_BPS"), ...s("web/lib/v2/smartPricing.ts", "MIN_ASK_BPS")] },
  { name: "roller-max-ask", contract: "AutoRoller", member: "MAX_ASK_BPS", kind: "compiled", sites: [...s("indexer/lib/v2/autoRoller.ts", "MAX_ASK_BPS"), ...s("web/lib/v2/smartPricing.ts", "MAX_ASK_BPS")] },
  // The pricer steps a large drop down at this floor (keeper/src/v2/pricer/planner.ts repriceFloor).
  { name: "roller-max-reprice-drop", contract: "AutoRoller", member: "MAX_REPRICE_DROP_BPS", kind: "compiled", sites: [...s("ops/v2/monitor.mjs", "MAX_REPRICE_DROP_BPS"), ...s("indexer/lib/v2/autoRoller.ts", "MAX_REPRICE_DROP_BPS"), ...s("keeper/src/v2/cranker/constants.ts", "MAX_REPRICE_DROP_BPS")] },

  /* ---- oracle-source constants: compiled. The per-feed/per-pool values are settable (setFeed/setPool); the monitor
   *      compares each new pin against these deploy defaults on purpose (RegisterMarkets configures them). ---- */
  // waves.py's DEFAULT_MAX_STALE_S is the maxStale its feed-age note sizes the fresh-feed window against.
  { name: "chainlink-default-max-stale", contract: "ChainlinkFeedSource", member: "DEFAULT_MAX_STALE", kind: "compiled", sites: [
    ...s("ops/v2/monitor.mjs", "CHAINLINK_MAX_STALE"), ...s("ops/stonkctl/src/stonkctl/waves.py", "DEFAULT_MAX_STALE_S"),
  ] },
  { name: "chainlink-default-round-jump", contract: "ChainlinkFeedSource", member: "DEFAULT_MAX_ROUND_JUMP_BPS", kind: "compiled", sites: s("ops/v2/monitor.mjs", "CHAINLINK_MAX_ROUND_JUMP_BPS") },
  { name: "chainlink-max-round-reads", contract: "ChainlinkFeedSource", member: "MAX_ROUND_READS", kind: "compiled", sites: s("keeper/src/v2/guardian/watch.ts", "MAX_ROUND_READS") },
  { name: "univ3-default-window", contract: "UniV3TwapSource", member: "DEFAULT_WINDOW", kind: "compiled", sites: s("ops/v2/monitor.mjs", "UNIV3_WINDOW") },
  { name: "univ3-max-window", contract: "UniV3TwapSource", member: "MAX_WINDOW", kind: "compiled", sites: s("keeper/src/v2/pricing/pool-spot.ts", "MAX_POOL_TWAP_S") },

  /* ---- the gas caps the cranker sizes its fixed limits from (keeper constants.ts starvedCeiling).
   *      In the fixture since a --regen; compared by value like every other compiled mirror. ---- */
  { name: "starved-call-slack", contract: "StarvedCall", member: "CALL_SLACK", kind: "compiled", sites: s("keeper/src/v2/cranker/constants.ts", "STARVED_CALL_SLACK") },
  { name: "oracle-source-gas", contract: "SettlementOracle", member: "SOURCE_GAS", kind: "compiled", sites: s("keeper/src/v2/cranker/constants.ts", "SOURCE_GAS") },
  { name: "splitter-swap-gas", contract: "FeeSplitter", member: "SWAP_GAS", kind: "compiled", sites: s("keeper/src/v2/cranker/constants.ts", "SWAP_GAS") },
  { name: "redeem-conversion-gas", contract: "Clearinghouse", member: "CONVERSION_GAS", kind: "compiled", sites: s("keeper/src/v2/cranker/constants.ts", "CONVERSION_GAS") },
  // EarnVault.VENUE_PULL_GAS is private; in the fixture since a --regen, so a changed stipend fails by value.
  { name: "earn-venue-pull-gas", contract: "EarnVault", member: "VENUE_PULL_GAS", kind: "compiled", sites: s("keeper/src/v2/cranker/constants.ts", "VENUE_PULL_GAS") },
  // HouseVault.BOOK_PULL_GAS is private; the fixture carries it (read from the compiled HouseVault by
  // --regen), so a changed pull cap fails this guard by value. The keeper budgets one starvedCeiling of it into every
  // rollEpoch (steps.ts HOUSE_ROLL_BOOK_PULL_GAS).
  { name: "house-book-pull-gas", contract: "HouseVault", member: "BOOK_PULL_GAS", kind: "compiled", sites: s("keeper/src/v2/cranker/constants.ts", "BOOK_PULL_GAS") },

  /* ---- the three once-PENDING mirrors, made LIVE once the regenerated
     roles.json carried their setters. buyback-cap-ceiling is gone rather than live: its only copy, monitor.mjs
     BUYBACK_CAP_CEIL, was read by nothing, so it was deleted and there is nothing left to mirror. ---- */
  { name: "buyback-cooldown", contract: "V2Constants", member: "BUYBACK_COOLDOWN", kind: "live",
    note: "setBuybackCooldown (ADMIN, T-OP-607): the cranker's buyback step and the monitor's stuck check read FeeSplitter.buybackCooldown() each tick",
    sites: [...s("keeper/src/v2/cranker/flywheel.ts", "buybackCooldown"), ...s("ops/v2/monitor.mjs", "buybackCooldown")] },
  { name: "earn-daily-outflow-cap", contract: "EarnVault", member: "MAX_DAILY_OUTFLOW", kind: "live",
    note: "EarnVault.setLimits (TREASURY_ADMIN; tightenLimits GUARDIAN, T-OP-821): the Earn risk copy states no number and says the treasury can change the caps",
    sites: s("web/lib/v2/vaultCopy.ts", "the treasury can change") },

  /* ---- settable on main and READ LIVE ---- */
  { name: "settlement-market-config", contract: "SettlementOracle", member: "marketConfig", kind: "live",
    note: "setMarket (CONFIG_ADMIN): /v2/markets serves the indexed MarketConfigured row, registry only as fallback",
    sites: s("indexer/lib/v2/settlementMeta.ts", "settlementMeta") },
  { name: "payout-route", contract: "PayoutRouter", member: "routes", kind: "live",
    note: "setRouteV3/setRouteV4/clearRoute: /v2/markets serves the indexed RouteSet/RouteCleared row, registry only as fallback",
    sites: s("indexer/lib/v2/settlementMeta.ts", "routeFromRow") },
  { name: "house-roll-uncorroborated-delay", contract: "SettlementOracle", member: "settlementConfig", kind: "live",
    note: "setMarket (CONFIG_ADMIN): the House roll overdue page reads the boundary expiry's delay (keeper cranker/steps.ts), 7 h fallback",
    sites: s("keeper/src/v2/cranker/steps.ts", "readUncorroboratedDelay") },
  { name: "univ3-pool-floor", contract: "UniV3TwapSource", member: "pools", kind: "live",
    note: "setPool (CONFIG_ADMIN): the monitor's pool-liquidity page compares against the source's floor it reads, registry only when unread",
    sites: s("ops/v2/monitor.mjs", "sourceFloor") },
  { name: "vault-limits", contract: "MakerVault", member: "limits", kind: "live",
    note: "MakerVault/HouseVault setLimits: the MM reads limits() every tick (keeper/src/v2/mm/reads.ts)",
    sites: s("keeper/src/v2/mm/reads.ts", "limits") },
];

/** Scanner hits that are not copies of a contract number, each with the reason. */
export const NOT_MIRRORS = [
  { file: "ops/devnet/seed.mjs", symbol: "ROLL_COLLATERAL", reason: "devnet seed collateral amount; the comment above mentions MIN_ASK_BPS" },
  { file: "keeper/src/v2/cranker/constants.ts", symbol: "PIN_REFUSED_RECHECK_S", reason: "the keeper's own recheck interval after a refused pin" },
  { file: "keeper/src/v2/cranker/constants.ts", symbol: "FIRST_MINT_DEADLINE_S", reason: "the keeper's own inclusion deadline for a first-mint take" },
  { file: "indexer/src/v2/earnYield.ts", symbol: "YEAR_S", reason: "annualisation of a yield; no contract has a year" },
  { file: "indexer/lib/v2/selfTrade.ts", symbol: "SELF_TRADE_MIN_PRICE_TICKS", reason: "the indexer's self-trade heuristic, counted in ticks" },
  { file: "web/app/api/keeper/orders/route.ts", symbol: "SHARE_MS", reason: "a route cache interval; the name only normalizes to SHARE" },
  { file: "keeper/src/v2/pricing/pool-spot.ts", symbol: "DEFAULT_POOL_TWAP_S", reason: "the pricing service's own TWAP window choice, inside [MIN_POOL_TWAP_S, MAX_POOL_TWAP_S]" },
  { file: "ops/v8/buyback-enable.mjs", symbol: "DEFAULT_WINDOW_SECONDS", reason: "how long the first-burn watch waits (T-OP-1024: the name matches UniV3TwapSource.DEFAULT_WINDOW, the value is not a TWAP window)" },
];
