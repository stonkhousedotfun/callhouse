# ops/fixtures/api/v2/

The indexer API v2 wire contract (plan `02-interfaces.md` §4) as files: one example response per
route, laid out by route path, for W2 (web) and S2 (site) to build against until the devnet
(F2-04) exists. The shapes are defined by the strict zod schemas in
`web/lib/v2/api-schema.ts` (types: `web/lib/v2/api-types.ts`); X2-04 copies that schema file into
the indexer and validates real responses with it, so these files, the dapp and the indexer are
held to one contract.

Every file is **generated** by `gen.mjs` from a hand-written scenario. No id, Money or derived
figure is typed by hand: longIds are `keccak256(abi.encode(underlying, isPut, strike, expiry)) & ~1`,
`formatted` is `formatUnits(raw, decimals)`, and balances, open interest, volumes, fees, rebates,
payouts, wins, the leaderboard and cards are replayed from the scenario's events by the rules of
`01-architecture.md` (ADR-04 units, ADR-05 settlement, ADR-08 fees, ADR-12 cards, §3.1 OptionMath).

## Regenerate, check, serve

```bash
node ops/fixtures/api/v2/gen.mjs            # rewrite every file (and delete stale ones)
node ops/fixtures/api/v2/gen.mjs --check    # exit 1 on any missing, extra or differing file
node ops/fixtures/serve-v2.mjs              # http://localhost:42070/v2/health  (--port N or PORT=N)
NEXT_PUBLIC_API_URL=http://localhost:42070 pnpm --filter @callhouse/web dev
pnpm --filter @callhouse/web test           # web/lib/v2/api-schema.test.ts, see below
```

Change the scenario in `gen.mjs`, never a JSON file: `web/lib/v2/api-schema.test.ts` runs
`gen.mjs --check`, so a hand edit is a red test. Commit the fixture diff with the generator change.

The server maps `GET /v2/<path>` to `<path>.json` (re-read per request), ignores the query string,
matches path segments case-insensitively when there is no exact hit (a lowercase address still
resolves), sends `Cache-Control: no-store` on `/v2/health` and `public, max-age=15` elsewhere,
CORS `*` with an `OPTIONS` preflight, and answers an unknown route or id with
`404 { error: { code: "not_found", message } }` and any other method with
`405 { error: { code: "method_not_allowed", message } }`. Because it ignores `?cursor`, **every list
fixture ends with `nextCursor: null`**; a pager pointed at it would otherwise loop forever.

## Layout

| route | file(s) |
|---|---|
| `/v2/health` | `health.json` |
| `/v2/config` | `config.json` |
| `/v2/admin/operations` | `admin/operations.json` — a cursor-paged pending AccessManager operation |
| `/v2/flywheel` | `flywheel.json` — native-asset revenue, held balances, distributions and burn totals |
| `/v2/markets` | `markets.json` |
| `/v2/calendar/holidays` | `calendar/holidays.json` — 31 day indices (the default range), one holiday |
| `/v2/markets/:ticker/series` | `markets/NVDA/series.json`, `markets/TSLA/series.json` |
| `/v2/series/:longId` | `series/<longId>.json` — all 40 series |
| `/v2/series/:longId/book` | `series/<longId>/book.json` — all 40 |
| `/v2/series/:longId/holders` | `series/<longId>/holders.json` — all 40 (side=long) |
| `/v2/series/:longId/trades` | `series/<longId>/trades.json` — all 40 |
| `/v2/cards` | `cards.json` |
| `/v2/cards/hero` | `cards/hero.json` |
| `/v2/accounts/:address/positions` | `accounts/<sam>/positions.json`, `accounts/<roller>/positions.json` |
| `/v2/accounts/:address/history` | `accounts/<sam>/history.json`, `accounts/<roller>/history.json` |
| `/v2/feed/wins` | `feed/wins.json` (window=week) |
| `/v2/feed/activity` | `feed/activity.json` (no `since`: newest first) |
| `/v2/strategies` | `strategies.json` |
| `/v2/leaderboard` | `leaderboard.json` (metric=multiple, window=week) |
| `/v2/rewards/epochs?program=maker` | `rewards/epochs.json` — entitlement and claimed sums per posted epoch, funding and balance per distributor |
| `/v2/rewards/:address/claims` | `rewards/<sam>/claims.json` — claimed and root-matched committed leaves, without proofs |
| `/v2/vault` | `vault.json` — protocol MakerVault wallet/ledger balances, live limits, outflow, orders and tracked series |
| `/v2/pnl/:id` | `pnl/<longId>-<holder>.json` — one per win |
| `/v2/stats` | `stats.json` |
| `/v2/makers`, `/v2/makers/:address` | `makers.json`, `makers/<address>.json` — all 3 makers |
| `/v2/fair/:longId` | `fair/<longId>.json` — all 40 (expired ones use the `{ fair: null, reason }` form) |

Every longId that appears anywhere resolves to its series, book, holders, trades and fair files,
so a dapp can click through the whole set against the server. There are 235 generated JSON fixtures
(237 files including `gen.mjs` and this README), about 460 KiB in total.

## The scenario

"Now" is `1789592400` = Wed 2026-09-16 21:00Z = 17:00 New York, after the close
(`cards.generatedAt`). Expiries are 16:00 New York = 20:00Z; `mintCutoff = expiry − 1800`.

**Markets.** NVDA `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC`, spot 215.50, strikeTick 1 USDG,
two settlement sources (Chainlink, Uniswap v3). TSLA `0x322F0929c4625eD5bAd873c95208D54E1c003b2d`,
spot 355.85, strikeTick 5 USDG, Chainlink only. Each market carries the optional `settlement` object in
`markets.json`, in two shapes. NVDA is the routed pooled example: `{ sourceCount: 2, uncorroboratedDelayS: 21600,
route: { venue: "v3", fee: 100 } }`, where the payout router attempts to convert a winning call's payout to USDG;
if the USDG output misses the conversion floor, the call still pays Stock Tokens in kind. The v3 object mirrors
the registry's closed `{ venue, fee }` shape and deliberately carries no pool address: `univ3Pool` remains a
settlement-oracle source, not a payout route. This is an illustrative scenario route chosen to exercise the
non-null wire shape; every production registry `payoutRoute` is currently null. TSLA is the
single-source example: `{ sourceCount: 1, uncorroboratedDelayS: 3600, route: null }`, where a null route means
winning calls settle in Stock Tokens in kind. USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`
(6 dp); both Stock Tokens 18 dp. Calls only (`puts: false`). Fees mirror `ops/markets/tier1.json:133-140`
(premium 500 bps, writer rent 0 ppm/week for every market, resale 0, taker `min(0.10 USDG, 10 %)`, rebate 5000 bps, exercise
25 bps). Contract addresses in `config.json` are keccak-derived placeholders; `dataStreams` is null.

The live `/v2/markets` response keeps every indexed market in the array when an oracle read fails.
For that ticker only, `spot` and `spotUpdatedAt` are both `null`; other tickers retain their live
spot and update time. Clients must show an unavailable price, suppress spot-based comparisons and
new buy/bid/write actions for that ticker, and keep position exits, cancellation and claims usable.
The checked-in fixture is the healthy case; the indexer route and web schema tests cover partial
oracle failure. Card pricing can use a separate feed and must never stand in for the missing live
settlement-oracle spot.

**Actors** (addresses are `keccak256("stonkhouse.fixtures.v2:<label>")`, checksummed):

| who | address | role |
|---|---|---|
| MakerVault | `0xd3b47D8a6B8e3fc6160Cd02634CF7Ae74aDeB66f` | protocol MM: quotes asks at fair × 1.08 (min 0.25 USDG) and bids at fair × 0.92 (only ≥ 0.05) on every open quoted series, capped per series (NVDA 400, TSLA 120 units short); payouts in kind to its ledger |
| writer.manual | `0x70556BaA315dD8d467ea452aBcd7deEbEa073Ff9` | writes a few asks by hand, sells once into a bid with writeToSell, the proceeds paid to its treasury; MakerRegistry tier 6000 bps |
| writer.manual.treasury | `0xF9806B161b1d09106C63E25907F50B4a93EF8fda` | receives writer.manual's USDG from that sale: the take's `recipient`, neither taker nor maker. Appears only in `feed/activity.json` |
| writer.roller | `0xD6b49a27Ead99118b61F0827C7aB2782aea07bE6` | AutoRoller user: weekly, otm 450 bps, ask 12 bps of spot, all free collateral, payouts to ledger. **positions + history fixture** |
| buyer.sam | `0xE37876AcBfbA6186E4687f4ef465D9AC21558De3` | contract wallet that turned third-party redemption off. **positions + history fixture** |
| buyer.ape | `0x4088c59Eb3fB713B124f182E7083AEb3358A030B` | buys, lists a resale ask |
| buyer.degen | `0x83daA58d0a8d82D7b971338a03AA2f99bfADf4F8` | buys; the week's best win |
| buyer.lucy | `0x300a7AB2f92B536e3f58422372c964B2Bb535ea2` | takes payouts in kind |
| buyer.otto | `0xdFbfcf5f533505281840cA0d640aE0580D05a2Be` | buys far OTM; no win this week |

**Series** (cranker ladders: rung strike = `roundUp(spot × (1 + (first + i·step) bps), strikeTick)`,
weekly 200/200, daily 100/100, 5 rungs; rungs that round to the same strike collapse):

| ladder | strikes | status | what it pins |
|---|---|---|---|
| NVDA Fri 09-11 weekly | 210, 214, **216**, 218, 223, 227 | `settled` | Corroborated, final at 219.40 (`finalizedAt` expiry + 125). 216 is the AutoRoller's own series, off the cranker ladder. ITM 210/214/216/218 pay; 223/227 expire worthless. Wins for ape (210), lucy (210, in kind), degen (214, 216); degen resells 50 of the 216 longs to the roller so the roller can close that pair, leaving degen 150 and making degen's 214 the largest-profit weekly win. lucy's 30 units of 218 cost 0.0825 USDG, under the 0.10 floor, so they are **not** a win; otto (223) and ape (227) lose. sam's 100 units of 218 are **unredeemed** (third-party redemption off): `claimable` in his positions, `holders` of 218 still lists him, OI 100. The roller's remaining 150-unit 216 short is redeemed by its next roll; writer assignment is reflected in writer stats. `long + fee + short == 1e16` per unit on every strike |
| TSLA Tue 09-15 daily | 355, 360, 365, 370 | `held` | Four strikes, not five ($5 tick, 1 % steps). Chainlink-only candidate 371.35 (4 % over the close) vetoed: `settlement.status "Held"`, candidate kept, `finalizableAt` is the schedule the veto interrupted. otto holds 80 units of 360 |
| NVDA Wed 09-16 daily | 215, 217, 219, 221, 224 | `settling` | The Uniswap snapshot was missed, so only Chainlink is ok: `status "Pending"`, candidate 215.62, `sourceIndex 0`, `disagreed false`, `finalizableAt = expiry + 120 + 21600`. sam holds 40 × 215 (mark, unrealised and claimable all null) |
| NVDA Thu 09-17 daily | 216, 219, 221, 223, 225 | `open` | Fair source `model` (09-17 is not a listed Cboe expiry). 216 has a bid fill (manual writes-to-sell into the MakerVault bid, `takerIsBuyer false`, `primary true`, `recipient` = writer.manual.treasury, which receives premium − seller fee − taker fee = 0.68051 USDG). 219 has two bid levels: the MakerVault's and sam's 0.50 bid. 225 has no bid (fair × 0.92 < 0.05) |
| NVDA Fri 09-18 weekly | 214, 218, 222, 227, 231 | `open` | 218: a two-level ask book, MakerVault then ape's `AskResale` at 2.25 (20 of 40 left; degen took 20, `primary false`). 227: MakerVault at 0.25 and the roller's `AskWrite` at 0.2601 (237 of 297 left after lucy took 60). 231: the MakerVault is 300 short, so it quotes only 100 units and no bid |
| TSLA Fri 09-18 weekly | 360, 365, 370, 380, 385 | `open` | 385: the MakerVault is 80 short against its 120 cap, so its best ask has only **40 units** (plus manual's 30 at 0.40, 70 in all). That card has the highest multiple (69.04), `perShare: null`, and is **not** the hero; the hero is TSLA 380 (120 units, 43.3; `perShare` 0.43879 → 19 USDG, 43.3). 370: the MakerVault is 30 short, so it quotes 90 units and nothing else rests there: `perShare: null` again |
| NVDA Fri 09-25 weekly | 217, 221, 226, 230, 234 | `open` | 221: manual's ask at 3.60 (50 left) beats the MakerVault's 3.7507, so its `perShare` ticket spans two levels (50 × 3.60 + 50 × 3.7507 = 3.67535 premium + one 0.10 taker fee = 3.77535) |
| TSLA Fri 09-25 weekly | 365, 375, 380, 385, 395 | `open` | **Empty books**: `bids: []`, `asks: []`, `bestBid/bestAsk null`, no cards; fair value still quoted |

**Other files.**

| file | pins |
|---|---|
| `health.json` | `ok`, 2 s lag, `interfaceVersion 8` (also in `config.json`) |
| `config.json` | v8 contract addresses plus AccessManager role/member delays, one pending operation, both Safes, flywheel addresses and `feeChangeDelay: 172800` |
| `admin/operations.json` | the config operation as a `status: pending` cursor-paged item; query filtering is owned by the live route |
| `flywheel.json` | a configured splitter with USDG and native NVDA revenue, an unconverted NVDA balance, two distributions and native-token burn totals |
| `markets.json` | the bare array; `expiries` = expiries with an open or cutoff series; 24 h volume, 7 d primary premium, OI of unsettled series, open series count |
| `cards.json` | 20 cards (every open series with an ask), best `perUnit.multiple` first; multiples from 1.42 to 69.04; `perShare` on 18, null on the two TSLA 09-18 books under 100 ask units (385, 370) |
| `cards/hero.json` | the best card with ≥ 100 units at its ask: TSLA 09-18 380, not the 40-unit TSLA 385 on top of `cards.json` |
| `accounts/<sam>/positions.json` | three longs across settled (claimable in NVDA, 18 dp), settling (all nulls) and open (mark, **negative** unrealised); one live `Bid`; empty shorts, ledger, strategies |
| `accounts/<roller>/positions.json` | one short, one live `AskWrite` with `filled`, an NVDA ledger balance, the AutoRoller strategy with its current series, order and `lastRolledAt` (Mon 09-14 13:35Z), `toLedger: true` |
| `accounts/<roller>/history.json` | every history kind: deposit, mint emitted by an OrderBook write fill, maker fill, resale buyback, direct close, withdrawal, short redemption with null event `realisedPnl`, maker fill |
| `feed/wins.json` | 5 wins (newest settlement first) |
| `feed/activity.json` | 45 items: 23 fills (every ask hit's `recipient` is its taker; the one bid hit pays a third wallet, listed in `accounts`), 6 settlements, 14 redemptions (USDG-converted, in kind, worthless, to ledger; each with `settlementPrice` 219.40), 2 rolls |
| `calendar/holidays.json` | day indices 20712–20742 (Wed 09-16 → Fri 10-16), weekends not session days, and one holiday: a **hypothetical** ExpiryCalendar closure on Mon 09-21 (dayIndex 20717). There is no NYSE holiday in that range; this one sits the day after the NVDA 09-18 weekly, so the roller's next roll falls due Tue 09-22, and no series expires on it |
| `strategies.json` | the roller's strategy with current longId, order, expiry and `lastRolledAt` |
| `leaderboard.json` | metric multiple, window week: degen 7.34 (2–0), sam 4.58, lucy 3.83, ape 3.39 (1–1); otto has no win and is not ranked |
| `pnl/<id>.json` | one per win, with units, average entry price, settlement price 219.40 and spot at entry |
| `stats.json` | `biggestWinDay: null` (nothing settled in the last 24 h), `biggestWinWeek` = degen's 214 |
| `makers.json`, `makers/*.json` | epoch 2958 (Mon 09-14 → Mon 09-21) ranked by score; per-maker epochs 2958 and 2957; fills, volume and rebates are replayed, uptime/spread/depth/score and the `samples` counts are stated constants (they come from book sampling, not events); non-MakerVault `avgSpreadBps` is null (never quoted both sides). `benchmarkPolicy` is **not** stated: `gen.mjs` reads `MAKER_BENCHMARK_POLICY` out of `indexer/lib/v2/makerScoring.ts` and fails generation if it cannot, so the fixtures cannot claim a benchmark the producer no longer uses. `samples.absent` + `samples.valid` is what uptime is averaged over and `samples.missingReference` sits outside it; generation asserts `uptimePct` never exceeds the valid share, that some maker-epoch has a missing reference and some has none, and that E1 keeps the absent-vs-quoted contrast X8-312 exists to make visible |
| `fair/<longId>.json` | open series: `{ fair, iv, delta, source, asOf }`; expired series: `{ fair: null, reason }` |

Fixture-only modelling (not contract, K2 and X2 own the real thing): fair values are
Black-Scholes at r = 0 with a mild smile (NVDA base IV 0.42, TSLA 0.55); the MakerVault quoting
rule above; the PayoutAdapter converts at 10 bps under the settlement-price value; block numbers
advance 4 per second from the registry's `verifiedAtBlock`.

## Decisions where §4 is vague

§4 was followed exactly where it states a shape. Where it names a route or field without one,
this is the decision the schema pins (change it with an `INTERFACE_VERSION` bump):

1. **Lists.** Paginated `{ items }` responses carry `nextCursor: string | null`, per the §4 list
   convention (the table omits it on series, trades, cards, wins, strategies and leaderboard).
   `/v2/calendar/holidays` returns a bounded complete range without a cursor.
   `/v2/markets` stays a bare array exactly as §4 shows it.
2. **Scalars.** Block numbers are decimal strings (`health.block`, `book.updatedBlock`,
   `config.deployBlock`), as in v1. `lagSeconds` is a number. Money `raw` is a canonical decimal
   (no leading zeros); only PnL (`unrealised`, `realisedPnl`, leaderboard `absolute`) may be negative.
3. **SeriesRef.status.** `expired` = past expiry with no candidate, or final but `settle` not yet
   called; `settling` = oracle `Pending`; `held` = oracle `Held`; `settled` = the series stored
   its payouts.
4. **Quote.** `bidUnits` / `askUnits` are the units at the best price; `last` is the last fill price;
   `fair`, `iv`, `delta` are null once past expiry.
5. **Card.** `unitsAvailable` and `orderIds` are the best ask level in take order (so each of
   those units costs `perUnit.cost` for a 1-unit take); `multiple` is rounded **down** to 2 dp.
   `hero.maxMultiple` is the hero card's own `perUnit.multiple` (null with no card), not the best
   of all cards, which may be too thin to be honest; the hero is still the best `perUnit.multiple`
   with ≥ 100 units at its best ask.
   **Target** (USDG per share): call `T = roundUp(K × (1 + cardTargetBps/1e4), strikeTick)`; put
   `T = roundDown(K × (1 − cardTargetBps/1e4), strikeTick)`, never below one strikeTick. Net
   payout per unit at T in USDG base units: call gross `(T − K)/100`, fee
   `min(T × exerciseFeeBps/1e4/100, gross × 1000/1e4)`; put gross `(K − T)/100`, fee
   `min((K/100) × exerciseFeeBps/1e4, gross × 1000/1e4)` (`K/100` is a put's collateralPerUnit).
   The fixtures hold calls only; the put branch is in `gen.mjs` and unit-tested by hand.
   **perShare** (interface 3): a one-share, 100-unit ticket that walks the whole ask side cheapest
   first, in take order, across price levels: `cost = Σ premium(price_i, units_i)` over exactly
   100 units `+` ONE taker fee `min(takerFeeFlat, Σpremium × takerFeeCapBps/1e4)`;
   `payoutAtTarget = 100 ×` the per-unit net payout; `multiple` rounded down to 2 dp. `null` when
   the book holds fewer than 100 ask units.
6. **Settlement.** `null` before expiry; `status` is the SettlementStatus name; `price`,
   `longPayoutPerUnit`, `feePerUnit`, `shortPayoutPerUnit` (Money in the collateral asset: 18 dp for
   calls), `finalizedAt`, `sourceIndex`, `corroborated` are null until final; `settledAt` is the SeriesSettled time (null until `settle` runs, so it can trail `finalizedAt`); `candidate` is set
   while Pending or Held.
7. **Positions.** `avgCost` is USDG per whole share including taker fees; `mark` is fair value per
   share; `unrealised = (mark − avgCost) × units / 100`; `claimable` is the collateral-asset
   amount `redeem` would pay (null unless settled). Long `units` include the account's units
   escrowed in its own resale asks. Shorts: `premiumReceived` is net of the premium fee,
   `collateralLocked` is in the collateral asset, `claimable` is Money or null. `orders[].units` is
   the original size. Still-open orders remain listed after `validUntil`, since expired resale asks
   continue to escrow longs until cancellation or pruning. Strategies include `lastRolledAt`,
   `lastStaleCancelAt` and `staleSpot`; a stale withdrawal preserves the active series with `orderId: null`.
   `ledger` lists assets with a non-zero free balance.
8. **History** (`/v2/accounts/:address/history`, newest first): `{ id, kind, ts, longId, series,
   data }` with `kind ∈ fill | mint | close | redemption | deposit | withdrawal` (discriminated;
   `longId` and `series` are null for deposit and withdrawal). A fill made through the book that
   mints produces both a `fill` with `primary: true` and a `mint`: the indexer stores every
   `Clearinghouse.Minted` event without filtering its caller and returns that row to both `writer`
   and `longTo`. In v8 the scenario has no direct mint; the roller's `close` remains a direct
   Clearinghouse call after its write → resale buyback round trip. `fill.data`
   has `side`, `role`, `counterparty`, `fee` (taker fee as taker, seller fee as a selling maker),
   `rebate`, `realisedPnl` (when longs are sold out of a position). For long redemptions,
   `redemption.data.realisedPnl` in USDG is payout value minus FIFO cost. It is null for short
   redemptions because the live indexer records assignment in writer stats, without assigning
   trade premiums to a specific short redemption. Mint `fee` and close `feeRefund` use native
   collateral Money and remain separate from USDG PnL. `tx` lives in `data`, as in activity.
9. **Activity.** `data` by kind — fill: the OrderFilled fields including `recipient` (who received
   the longs on an ask hit, the taker's USDG on a bid hit), plus the Taken
   taker fee; settlement: SeriesSettled (price and the three per-unit payouts); redemption: Redeemed
   (holder, side, tokenId, units, delivered asset and amount, amountInKind, toLedger) plus
   `settlementPrice`; roll: Rolled (writer, orderId, price, units); stale_cancel: withdrawn ask
   (writer, orderId, spot, spotUpdatedAt, nextRollAfter, tx). Stale events are exercised in the
   live handler/API tests; this scenario has no stale withdrawal. `accounts` includes the fill
   recipient, or the redemption holder and destination. A settlement's `ts`, transaction and cursor
   come from SeriesSettled, even if the oracle finalized earlier. Oracle candidates and vetoes are
   not activity items (they are on the series).
10. **Wins.** A win is a settled long position (per holder per series) whose payout is greater than
    its FIFO cost including taker fees, after the integrity rules. `payout` is the USDG delivered
    when converted, else the in-kind amount valued at the settlement price; `tx` is the redemption
    that paid it, or the `settle` tx while unredeemed; `settledAt` is the series' settle time.
11. **Leaderboard.** Discriminated on `metric` with `window` echoed: `value` is a number (aggregate
    Σpayout / Σcost, rounded down) for `multiple`, signed USDG Money for `absolute`, an integer for
    `streak`. `wins` / `losses` count counted positions; only holders with at least one win are
    ranked (`best` is a Win).
12. **PnL.** The Win's fields flat, plus `units`, `entryPrice` (average fill price per share, fees
    excluded), `settlementPrice`, `spotAtEntry` (Money or null).
13. **Stats.** `volume*` = premium traded (all fills); `premiumAll` = primary premium;
    `feesAll` = premium fees + taker fees − maker rebates + exercise fees on redeemed longs (valued
    at the settlement price); `contractsFilled` = units filled; `holders` = distinct accounts that
    ever received longs through the book. Native collateral rent is separate from these USDG totals. `biggestWin*` = the largest profit (payout − cost).
14. **Config.** `{ chainId, interfaceVersion, deployBlock, usdg: { address, symbol, decimals },
    contracts: { …the registry's v2.contracts, accessManager, sources }, flywheel, safes, access,
    pendingOperations, fees (takerFeeFlat as Money), pendingFees, constants (unit as a decimal
    string, the protocol durations in seconds, including feeChangeDelay), ladder }`. `access.roles[].delayS`
    is the chain role's grant delay; `holders[].delayS` is that member's execution delay. The scenario's
    role ids, names and intended holder assignments mirror `ops/abis/v2/roles.json`, while the wire values
    represent indexed chain state. `feeChangeDelay` is 172800 from
    `callhouse-contracts/src/v2/interfaces/V2Constants.sol:60`, not from an AccessManager role delay.
    `fees` is the effective OrderBook policy at the indexed block timestamp. `pendingFees` is
    either `null` or the five scheduled OrderBook rates and `effectiveAt` in Unix seconds. It is
    null after activation or when a replacement schedule matches effective fees (cancellation).
    Exercise fees are outside this schedule. `/v2/config` is never response cached; the web
    refreshes it regularly, and on-chain fees are ultimately set when a transaction executes.
15. **Markets.** `status ∈ planned | live | paused` (the registry's `v2.status`); `expiries` as in
    the table above; `stats.volume24h` premium traded, `premium7d` primary premium. The optional
    `settlement` object is `{ sourceCount, uncorroboratedDelayS, route }`. `route` is the USDG conversion
    route the payout router attempts — `null`, `{ venue: "v3", fee }`, or
    `{ venue: "v4", fee, tickSpacing, poolId }`, exactly matching the registry's closed per-venue shapes.
    A payout that misses the conversion floor is still paid in Stock Tokens in kind; see the scenario
    above for the v3 and null shapes.
    `/v2/markets/:ticker/series` with no filters returns every series of the ticker, all statuses,
    by expiry then strike.
16. **Makers.** `/v2/makers` = `{ epoch: { id, start, end }, items: [{ maker, tierBps, uptimePct,
    avgSpreadBps | null, depthWithin100bps (units), fills, volume, rebates, score }], nextCursor }`;
    `/v2/makers/:address` = `{ maker, tierBps, epochs: [{ epoch, …the same stats }] }`, newest first.
    Epochs are weeks from Monday 00:00Z; `epoch.id` = `floor((start − 345600) / 604800)`, whole weeks since
    Monday 1970-01-05 (the same `uint256 epoch` as the RewardsDistributor, 02-interfaces §1.9); `tierBps` is the
    effective rebate.
17. **Fair.** The union `{ fair, iv, delta, source, asOf } | { fair: null, reason }`: the pricing
    service never throws on bad data (§5), and the indexer passes its answer through.
18. **Calendar.** `/v2/calendar/holidays?fromDay=<n>&toDay=<n>` returns every inclusive UTC day
    index in a 1–62 day range as `{ dayIndex, isHoliday, isSessionDay }`. A day index is
    `floor(unixSeconds / 86400)` for that New York date's 16:00 close. `isHoliday` reflects the
    latest ExpiryCalendar HolidaySet event; `isSessionDay` is a weekday with no holiday override.
19. **Admin operations.** `/v2/admin/operations` is `{ items, nextCursor }`; each item carries the
    config operation fields plus `status ∈ pending | executed | canceled`. The config's
    `pendingOperations` array carries the same item without `status`, because every member is pending.
20. **Flywheel.** Amounts remain decimal strings in their native units. `revenue7d` groups what the
    splitter actually received by asset, `held` reports unconverted balances without assigning a USDG
    value, and each distribution states both native `assetInRaw` and realised `usdgInRaw`. Burn totals
    are in the flywheel token's `tokenDecimals`.

## What holds these files

- `web/lib/v2/api-schema.test.ts`: every file maps to exactly one ROUTES entry and parses with
  its strict schema; every route has a fixture; the schemas reject an extra key, a missing key, a
  non-canonical or negative raw, a lowercase address and a fractional timestamp; every SeriesRef's
  ids are recomputed with viem; every Money's `formatted` equals `formatUnits`; every address is
  checksummed; every longId resolves to its files; every card is recomputed per ADR-12 and equals
  the best ask level of its book, and its `perShare` is re-walked from the full ask side (null
  exactly under 100 units); the put target and payout are checked against hand-computed numbers; books are ordered and uncrossed; status and settlement agree
  and settled payouts satisfy OptionMath; wins and pnl pages agree; every list ends its pages;
  `gen.mjs --check` passes; and `serve-v2.mjs` answers with the right bodies, headers and errors.
- `web/lib/v2/api-types.ts`: a compile-time equality between every hand-written type and its schema.
- X2-04 (later): the indexer validates its real responses with the twin of `api-schema.ts`.

## v8 zero-rent fields and accounting

Each generated SeriesRef carries the immutable `mintFeePpm`, native `mintFeesHeld` and
`mintFeesAccrued`; all three are zero in this launch scenario because the registry pins rent to 0.
The generator still runs the same rent functions on write asks, write-to-sell and close, so the
wire fields and zero-rate boundary remain explicit. There is no direct mint: every scenario mint
comes from the OrderBook and its `Minted` event is represented in account history. The fixture rate
is deliberately pinned in `gen.mjs`, independently of deployment addresses.

The book carries raw native `makerFreeCollateral`, `makerFreeUnits`, and the
original `onChainRemainingUnits`. `updatedBlock` corresponds to `snapshotTimestamp`, the
balance snapshot time. At rent 0, capacity is exactly `free collateral / UNIT`; live ticket
planning still skips a whole unfunded proposal. The synthetic book has enough collateral
for its displayed orders; shared-budget and whole-or-skip boundaries are covered by the runtime tests.
