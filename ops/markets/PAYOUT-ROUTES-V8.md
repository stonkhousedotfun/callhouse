# v8 payout routes (O8-03)

`markets[].v2.payoutRoute` for the twenty v8 launch markets. A route is where the Clearinghouse may
sell a winning call's Stock Tokens for USDG; `null` means the payout is made **in kind**, which is a
legitimate and documented outcome (`ops/markets/build-markets.mjs:998`), not a gap to be filled later.

**14 of the 20 carry a route. Six are deliberately null: MU, SNDK, AMD, AMZN, ORCL, CRWV.**

## READ THIS BEFORE YOU USE THESE ROWS

These rows are **PROVISIONAL** and are re-measured immediately before `OWN8-06`. Three caveats travel
with them, and anyone reading these as measured depth has had to ignore this section to do it:

1. **The data is two days old and was not refreshed.** Every value here comes from the recon snapshot
   `stonkhouse-plan/status/VENUE-RECON-V4-2026-09-17.md`, raw output
   `~/.claude/jobs/f3df06ad/tmp/venues/v4/v4-pool-prices.json` and `v4-activity.json`, chain 4663 head
   **65,724,138** at **2026-09-17T22:27:13Z**. This task made **zero network calls** of any kind — owner
   decision 2026-09-19, `v8-plan/status/OWNER-ANSWERS-2026-09-19-B.md` section 1 — so nothing here was
   confirmed against the chain as it stands today.
2. **`virtUsdg` is an UPPER BOUND on depth, not a price-impact measurement.** It is `L*sqrt(P)/2^96`, the
   full-range-equivalent USDG side; for concentrated positions the real tradeable depth near mid is
   smaller, by an order of magnitude or more (recon §5). The price impact at 0.1 / 1 / 10 shares that the
   original O8-03 asked for **does not exist in this snapshot** and cannot be computed from it — the tick
   data is not there. No number in this document is a slippage estimate.
3. **The pool enumeration is incomplete.** One 4M-block `eth_getLogs` range (52,000,000–55,999,999)
   exhausted its retries, so the 54,921-pool count is a known undercount and a better pool may exist for
   some ticker inside that gap.

## The filter

`PayoutRouter.setRouteV4` rejects a dynamic fee (`fee & 0x800000`), a fee of 0 or above
`MAX_ROUTE_FEE_TIER = 10_000`, and any non-zero hooks address — and `V4Currency.key` builds the key with
`hooks = address(0)`, so a hooked pool is a different `PoolKey` and a different `poolId` entirely. Of the
446 live Stock↔USDG v4 pools, a candidate must therefore have:

    hooks == 0x0000000000000000000000000000000000000000
    fee > 0  and  fee & 0x800000 == 0  and  fee <= 10000
    liquidity > 0  and  tickSpacing in [1, 32767]

**The recon's headline "best pool" fails this filter for 7 of the 20 tickers** (AAPL, GOOGL, META, MU,
SNDK, SPCX, TSLA — hooked and/or dynamic-fee and/or fee 0). The route is chosen from the eligible subset.

## The ranking rule, and why it is not the recon's

Three gates, then a rank:

- **A — usable at all:** eligible per the filter, with at least one recorded swap in *any* activity
  window, and within `v2.defaults.maxDeviationBps` (**150**) of the Chainlink feed. The band is the
  registry's own, not a number invented here.
- **B — worth pinning:** depth upper bound ≥ 1,000,000 USDG **and** ≥ 5 swaps in its best window. This
  floor is a judgement, stated as one: `virtUsdg` is an upper bound, so a pool whose *upper* bound is five
  or six figures cannot absorb a settlement conversion, and pinning it is worse than pinning nothing —
  the conversion either eats the slippage or misses `minOut` and falls back in-kind having spent the gas.
- **C — the deviation must be a market, not a stale price:** `|devBps| <= 50` unless the pool has ≥ 100
  swaps in its best window. A quiet pool sitting 1% off the feed is a stale price a conversion would
  realise; a busy one at the same deviation is a market.
- **Rank:** most swaps in the best window, then depth. Ties never arose.

**`swaps24h` alone is not usable as the ranking signal, and this is a defect in the snapshot's derived
table.** In `v4-pool-prices.json`, **26 of 446 rows have `swaps30m > swaps24h`**, which is impossible —
the 30-minute window (blocks 65,706,234–65,724,138) is *inside* the 24-hour window
(64,864,778–65,724,138). All 26 have `swaps24h == 0`. The `d7` window totals 22,243 swaps against `h24`'s
45,500, which is also impossible for the same reason. The `h24` map is **partial**, and it is partial on
exactly the deepest pools: META's 167.8M-USDG pool reads `h24 = 0` beside `m30 = 545`, SPY's 890M pool
reads `h24 = 0` beside `m30 = 111`. Ranking on `swaps24h` therefore buries the real venues and promotes
starved ones — which is why several rows below differ from the table in the task description, derived the
same way from the same file.

## The decisions

| Ticker | Route | fee | tickSpacing | poolId | Why |
|---|---|---|---|---|---|
| `SPCX` | **v4** | 10000 | 200 | `0xcb6ffbcc84359535c2cc0a5688c0a76520ea6e0a4820fddd3ac8d7880e576370` | 5 swaps in its best window (m30 5 / h24 0 / d7 5), depth upper bound 13,565,580 USDG, -11 bps off the Chainlink feed |
| `SPY` | **v4** | 500 | 5 | `0xe5923c8a8be481ec89a2ca784a2bbfa4235de6d88f92260fd66b660c4babf907` | 7118 swaps in its best window (m30 44 / h24 5056 / d7 7118), depth upper bound 42,547,347 USDG, -3 bps off the Chainlink feed |
| `MU` | null | — | — | — | no eligible traded pool clears the depth floor and the 5-swap floor together: deepest is 3,904,691 USDG upper bound with 2 swaps, busiest is 2 swaps with 3,904,691 |
| `QQQ` | **v4** | 3000 | 60 | `0xf9568ec0cba6e9ba30d9daabbf3e807813b8852e5737b7d83ea06529c73c9758` | 59 swaps in its best window (m30 1 / h24 59 / d7 0), depth upper bound 2,183,442 USDG, -19 bps off the Chainlink feed |
| `SNDK` | null | — | — | — | only candidate is -102 bps off the feed on 6 recorded swaps: at that activity the deviation reads as a stale price rather than a market, and a conversion would realise it |
| `AAPL` | **v4** | 3000 | 60 | `0xc748f4671a867db48b552f6b7650bf3255e05f80f00e3f7aad1b17ccb7898fdb` | 15 swaps in its best window (m30 15 / h24 0 / d7 14), depth upper bound 12,271,800 USDG, -36 bps off the Chainlink feed |
| `MSFT` | **v4** | 3000 | 60 | `0x9194a557b6a6bb2236b49ea7e2bbccec5d3eeb705aef00903be4b3de1d949579` | 2056 swaps in its best window (m30 1 / h24 1224 / d7 2056), depth upper bound 7,150,668 USDG, +18 bps off the Chainlink feed |
| `INTC` | **v4** | 10000 | 200 | `0xf2e329e631d0fb315a5c563ee3a9120f24822b5ef6c502a91cb56b174d5d8c22` | 2229 swaps in its best window (m30 24 / h24 1877 / d7 2229), depth upper bound 2,397,775 USDG, -18 bps off the Chainlink feed |
| `TSLA` | **v4** | 3000 | 60 | `0x8517f8071ae5b831b738052f12125e8e3d6c158b78728aa44ce3b25e5104d32e` | 9 swaps in its best window (m30 9 / h24 0 / d7 6), depth upper bound 29,622,900 USDG, +3 bps off the Chainlink feed |
| `META` | **v4** | 3000 | 60 | `0x5875d407a42965b0e768c8925cea290e06fa50603ef34fc99eb92a1050e6ae36` | 545 swaps in its best window (m30 545 / h24 0 / d7 298), depth upper bound 167,817,233 USDG, -30 bps off the Chainlink feed |
| `AMD` | null | — | — | — | no eligible traded pool clears the depth floor and the 5-swap floor together: deepest is 4,302,013 USDG upper bound with 1 swaps, busiest is 300 swaps with 124,599 |
| `GOOGL` | **v4** | 300 | 3 | `0x43fe16b75cabbf38f5b185d16142b02d1d9200d8f1ba17cb6cf899f562c6197f` | 1564 swaps in its best window (m30 30 / h24 1564 / d7 27), depth upper bound 1,065,044 USDG, -14 bps off the Chainlink feed |
| `AMZN` | null | — | — | — | no eligible traded pool clears the depth floor and the 5-swap floor together: deepest is 358,081 USDG upper bound with 161 swaps, busiest is 161 swaps with 358,081 |
| `MSTR` | **v4** | 2500 | 25 | `0x319bac87e616a89e241c10aeb8afd4892a852cdd8b373cd9765ecddc40b87cfe` | 3429 swaps in its best window (m30 48 / h24 3429 / d7 40), depth upper bound 9,818,514 USDG, -1 bps off the Chainlink feed |
| `PLTR` | **v4** | 1500 | 15 | `0xc59eaeda6d1a6f031bc7e1d039772f2d675e7b4de2c8668610f4471bd60b3802` | 721 swaps in its best window (m30 9 / h24 721 / d7 8), depth upper bound 4,463,958 USDG, -21 bps off the Chainlink feed |
| `DELL` | **v4** | 5000 | 25 | `0x729651c09684919bdffda473141be4e908ee0e8cf8a43f41135831217fa7d3bb` | 240 swaps in its best window (m30 1 / h24 240 / d7 1), depth upper bound 1,532,325 USDG, -31 bps off the Chainlink feed |
| `ORCL` | null | — | — | — | no eligible traded pool clears the depth floor and the 5-swap floor together: deepest is 161,408 USDG upper bound with 1228 swaps, busiest is 1228 swaps with 161,408 |
| `TSM` | **v4** | 7500 | 75 | `0x0ba5d53d2f6255f334b7c8ead4f56b6aef5af3402c5e4d11180afd38c6b85fb1` | 357 swaps in its best window (m30 11 / h24 357 / d7 1), depth upper bound 3,677,299 USDG, +23 bps off the Chainlink feed |
| `CRWV` | null | — | — | — | no eligible traded pool clears the depth floor and the 5-swap floor together: deepest is 14,467 USDG upper bound with 121 swaps, busiest is 121 swaps with 14,467 |
| `NVDA` | **v4** | 375 | 4 | `0xdf5c0bcd967d54774c139a4ef803ec994779736346fb4c21b50ed241b1fd2682` | 1567 swaps in its best window (m30 11 / h24 1567 / d7 10), depth upper bound 10,315,609 USDG, -17 bps off the Chainlink feed |

Every pinned id was recomputed offline as `keccak256(abi.encode(PoolKey))` from
`{currency0, currency1, fee, tickSpacing, hooks: address(0)}` with sorted currencies and matched its
pin: **14 of 14**. `ops/markets/build-markets.test.mjs` asserts this against the committed registry via
`poolIdIssues`, using `cast keccak` only — a local foundry call, no RPC.

## What is NOT established

- **On-chain acceptance of these 20 keys is unverified.** `setRouteV4` reads live pool state through
  `IV4StateView.getSlot0`/`getLiquidity`, so proving it needs a fork and therefore an RPC connection,
  which the owner's answer excludes. A fork test written *without* `--fork-url` passes while checking
  nothing (`06-QUIRKS` §A), which is worse than no test. This belongs to the pre-`OWN8-06` re-measurement.
- **`build-markets.mjs --check` was not run.** Its `main()` opens with `cast block-number --rpc-url` and
  `probeV2Pools` makes `cast call --rpc-url` reads (`build-markets.mjs:505,515`), so running it would
  break the no-network rule. The offline validators were run instead, through `node --test`.
