# R13 — v2 sources, keepers, depth and calendar

Probe: 2026-09-17 UTC (2026-09-16 America/Los_Angeles). Reproduce with
`node ops/recon/r13-probe.mjs`; `--check` compares live results with
[`v2-sources.json`](../markets/v2-sources.json) using a 25% USDG-depth tolerance and fails on
pool, classification, feed ID, tick, provider or calendar drift. Public Robinhood RPC only; no
wallet, archive node or private key. JSON retains all 84 pools, both token balances, liquidity,
cardinality, 30-minute TWAP, live Chainlink spot and the full 35-ticker regular-hours stream IDs.

## Exact chain calls

RPC: `https://rpc.mainnet.chain.robinhood.com`, chain ID 4663. Commands below use NVDA and its
USDG pool as worked examples. The probe sends the same `eth_call` data for every ticker and fee
100/500/3000/10000, batching 20 calls and backing off on HTTP 429/5xx.

```sh
cast chain-id --rpc-url https://rpc.mainnet.chain.robinhood.com
cast code 0x1f7d7550b1b028f7571e69a784071f0205fd2efa --rpc-url https://rpc.mainnet.chain.robinhood.com
cast code 0xcaf681a66d020601342297493863e78c959e5cb2 --rpc-url https://rpc.mainnet.chain.robinhood.com
cast code 0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7 --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call 0x1f7d7550b1b028f7571e69a784071f0205fd2efa 'getPool(address,address,uint24)(address)' 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC 500 --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3 'liquidity()(uint128)' --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3 'slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)' --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3 'observe(uint32[])(int56[],uint160[])' '[1800,0]' --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168 'balanceOf(address)(uint256)' 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3 --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC 'balanceOf(address)(uint256)' 0xd4EB21209C4D6093f80B5b84f5C45cc093EA14a3 --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15 'latestRoundData()(uint80,int256,uint256,uint256,uint80)' --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call 0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15 'getRoundData(uint80)(uint80,int256,uint256,uint256,uint80)' 18446744073709552665 --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call 0xcE73c8ad08CBDEaCa6078BF0627C8fe0a9a536E7 's_feeManager()(address)' --rpc-url https://rpc.mainnet.chain.robinhood.com
cast call 0xACeA761c27A909d4D3895128EBe6370FDE2dF481 'verification_fee()(uint256)' --rpc-url https://rpc.mainnet.chain.robinhood.com
cast code 0x2A6C106ae13B558BB9E2Ec64Bd2f1f7BEFF3A5E0 --rpc-url https://rpc.mainnet.chain.robinhood.com
cast code 0x44bde1bccdD06119262f1fE441FBe7341EaaC185 --rpc-url https://rpc.mainnet.chain.robinhood.com
cast code 0x37D9dC70bfcd8BC77Ec2858836B923c560E891D1 --rpc-url https://rpc.mainnet.chain.robinhood.com
cast code 0x86EFBD0b6736Bed994962f9797049422A3A8E8Ad --rpc-url https://rpc.mainnet.chain.robinhood.com
```

The factory, SwapRouter02, QuoterV2 and Data Streams VerifierProxy all have runtime code. The
VerifierProxy is `VerifierProxy 2.0.0`; `s_feeManager()` returns the zero address. Pyth Pro has
runtime code and `verification_fee()` returns 1 wei. `cast code` checks use nonempty bytecode,
not source verification.

## Uniswap v3 inventory

Rule: a pool is **usable** only if USDG balance is at least 250,000, observation cardinality at
least 300, `observe([1800,0])` succeeds, and its TWAP differs from the **live** feed by at most
100 bps. A market is usable if any pool qualifies; otherwise thin if a pool exists, none if no
pool exists. The selected pool is the deepest qualifying pool, or the deepest pool otherwise.
Depth is balance, not executable quote depth; liquidity and both token balances remain in JSON.
The pool reading and feed reading are near-contemporaneous, not atomic; markets near 100 bps can
change class on a later run.

| Ticker | Selected pool | Fee | USDG balance | Cardinality | TWAP/feed bps | Class | Tick USDG |
|---|---|---:|---:|---:|---:|---|---:|
| AAPL | 0xaae0d815ee56e4092a5e5c2911e676fea50b2d6d | 500 | 350,950 | 1801 | 4 | usable | 2.5 |
| AMD | 0x48d284a2a4d3dc1b3da08231fe44317e7e7aa51f | 3000 | 118,602 | 1400 | 18 | thin | 2.5 |
| AMZN | 0x8ac92da74ab5f3b1d024dc1943ad7e15dc4179ef | 3000 | 481,698 | 1801 | 21 | usable | 2.5 |
| ASML | 0xedb22516b14eb2d1c86927db373b0e8bf70f5cd1 | 10000 | 6,252 | 1500 | 53 | thin | 10 |
| BABA | 0xa57ab582b310dd6f9e934ea1eeea152741545e6a | 3000 | 32,529 | 1800 | 18 | thin | 1 |
| CLSK | 0xf58a091afd28f26e7e2a60803e6dfb5a8e451021 | 10000 | 0 | 1 | 914 | thin | 0.5 |
| COIN | 0x5c51a0035051fa2db80aec8781be3bd6207d27e0 | 3000 | 0 | 256 | 164 | thin | 2.5 |
| CRCL | 0x654e4143e82a5824445ade0824351c2a9acd95a8 | 3000 | 748,326 | 1801 | 13 | usable | 1 |
| CRWV | — | — | — | — | — | none | 1 |
| DELL | 0xc30c89cb7815a1488b7998d15eec73961707fc5a | 10000 | 244,830 | 1500 | 47 | thin | 2.5 |
| EWY | 0x23a254c637ef0f13f6259586f059fff52b89ed6b | 10000 | 0 | 1 | 10000 | thin | 1 |
| GME | 0xe9713f453adb9245b19559790c96f470a18f2fdf | 10000 | 938,794 | 1860 | 92 | usable | 0.5 |
| GOOGL | 0x34d0dc122cf9a8eb296fc5e0d3a233625d7d19b7 | 500 | 1,261,739 | 1801 | 26 | usable | 2.5 |
| INTC | 0x2e5a92f5013a64661a49312111be2e8abd33f56a | 3000 | 120,072 | 1500 | 5 | thin | 0.5 |
| IONQ | 0xbc44b11f569d3feed9b4088f5a3fc569d2e3c77f | 10000 | 0 | 1 | 813 | thin | 0.5 |
| META | 0x107a7cb40d8665360ba10e59471af06150a50922 | 3000 | 204,441 | 1400 | 9 | thin | 2.5 |
| MSFT | 0xeb60bcd1d920ad6e102690ccfc6fb488899e1510 | 3000 | 301,906 | 1801 | 6 | usable | 2.5 |
| MSTR | 0x17578c0e0d15da44f31677263114f71ae76653ea | 10000 | 176,970 | 1500 | 40 | thin | 1 |
| MU | 0xd057b1bc54917855bbee58ead58647f47cab35e5 | 3000 | 595,356 | 1860 | 4 | usable | 5 |
| NBIS | 0x0dda7c6a2cce72abbfa88394afe407ff98417448 | 10000 | 0 | 1 | 385 | thin | 2.5 |
| NVDA | 0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3 | 500 | 2,637,568 | 6000 | 30 | usable | 2.5 |
| ORCL | — | — | — | — | — | none | 1 |
| PLTR | 0x851680416a4f4e1c463d45171d61acddbc8554c0 | 3000 | 73,459 | 1801 | 7 | thin | 2.5 |
| QQQ | 0xd60a5d14db690b7afad71f76b108071d7175597d | 500 | 319,103 | 1800 | 1 | usable | 1 |
| RGTI | 0xb549d4eaf467277e48aa350f216e413df8c8ba12 | 10000 | 0 | 1 | 2.2742163406190364e+53 | thin | 0.5 |
| RKLB | 0xa9888de1b9d64a93eaeb495a39fe9b3d00654928 | 10000 | 0 | 64 | 151 | thin | 1 |
| SGOV | 0xfab520051f96f4d2a32c22b6a3dd7fffdf231bfe | 3000 | 2,672,231 | 1800 | 14 | usable | 1 |
| SLV | 0x8cb787e6c315d464775289bad00fdd67d53ecb3d | 3000 | 88,022 | 1801 | 3 | thin | 0.5 |
| SNDK | 0xa1e1c9519cd5ae47e9a935645e1a7b935b944559 | 10000 | 16,381 | 1400 | 62 | thin | 10 |
| SPCX | 0xc61284332117c3fb23a2a56cceffd07f7af60029 | 500 | 1,740,696 | 3100 | 35 | usable | 1 |
| SPY | 0xa7bb1ac63bbab0c44316e6c8c455213441689167 | 500 | 160,771 | 1801 | 39 | thin | 1 |
| TSLA | 0xf4acdaeeb7022862a763c9b1b885e11191c889e3 | 3000 | 689,601 | 1801 | 9 | usable | 2.5 |
| TSM | 0x07e8ea83d4c1340774c8965125e26e12bf943bf1 | 10000 | 50,508 | 1801 | 82 | thin | 2.5 |
| USAR | 0x04391780f519b7d3ba59c9590459d76e23d225c4 | 3000 | 26,731 | 1400 | 17 | thin | 0.5 |
| USO | 0x02175608f1b5e6b5ed221ccfdc7be197d111d915 | 3000 | 641,276 | 1801 | 20 | usable | 1 |

NVDA's 500-fee pool remains deep and passed this sample: roughly 2.17 million USDG, 18.7 thousand
Stock Tokens, cardinality 6000, 30-minute TWAP about $215.90 versus live Chainlink about $215.26
(30 bps). The old registry's spot was about $211.92; comparing to that stale value falsely marked
NVDA thin. The probe reads `latestRoundData` live for all 35 before classification.

## Chainlink push-feed round history

The probe walks backward through each proxy inside its current phase. It requests 200 rounds, or
all rounds in that phase when fewer exist, and covers the last ten NYSE session dates. Phase-one
round IDs decrement by one. Counts below include **zero-print** 15:30–16:00 New York windows;
the median is zero for all four feeds. The 96-round onchain walk bound comfortably exceeds prints
*inside* these observed half-hour windows, but this sample does not prove a bound for every future
market event or a walk initiated long after expiry.

| Feed | Rounds read | Rounds/hour mean (p50) | Biggest jump, bps | 15:30–16:00 p50 (max) |
|---|---:|---:|---:|---:|
| NVDA | 201 | 0.6 (0) | 114 | 0 (1) |
| TSLA | 201 | 1.37 (1) | 129 | 0 (2) |
| SPY | 135 | 0.13 (0) | 10000 | 0 (0) |
| SGOV | 60 | 0 (0) | 27 | 0 (0) |

| NYSE date | NVDA | TSLA | SPY | SGOV |
|---|---:|---:|---:|---:|
| 2026-09-16 | 1 | 1 | 0 | 0 |
| 2026-09-15 | 0 | 2 | 0 | 0 |
| 2026-09-14 | 0 | 0 | 0 | 0 |
| 2026-09-11 | 0 | 0 | 0 | 0 |
| 2026-09-10 | 0 | 0 | 0 | 0 |
| 2026-09-09 | 0 | 0 | 0 | 0 |
| 2026-09-08 | 0 | 1 | 0 | 0 |
| 2026-09-04 | 0 | 0 | 0 | 0 |
| 2026-09-03 | 1 | 2 | 0 | 0 |
| 2026-09-02 | 1 | 2 | 0 | 0 |

SPY's 10,000-bps maximum is an old scale discontinuity: round
`18446744073709551623` answered `7349800000000000000`, then
`18446744073709551624` answered `73683695000`. The planned 2,000-bps jump limit would reject
that historical interval. SGOV's current phase has only 60 rounds; a 200-round walk is impossible
there. Feed proxies preserve the phase high bits; decrement works **within** phase, and a phase
boundary requires an explicit aggregator transition rather than blind subtraction.

## Data Streams

The [Chainlink v11 report schema](https://github.com/smartcontractkit/documentation/blob/main/src/features/feeds/components/reportSchemaData.ts)
is `feedId bytes32`, `validFromTimestamp uint32`, `observationsTimestamp uint32`, `nativeFee
uint192`, `linkFee uint192`, `expiresAt uint32`, `mid int192`, `lastSeenTimestampNs uint64`,
`bid int192`, `bidVolume int192`, `ask int192`, `askVolume int192`, `lastTradedPrice int192`,
`marketStatus uint32`. [Chainlink's 24/5 equity guide](https://docs.chain.link/data-streams/rwa-streams/24-5-us-equities-user-guide)
defines separate Regular, Extended and Overnight IDs. R13 records **Regular Hours** IDs for the
15:30–16:00 settlement window. They are equity prices: multiply `mid` by Stock Token
`uiMultiplier()` for token-price comparison. Check market status and `lastSeenTimestampNs`.
Chainlink says `lastTradedPrice` should stop being a production input by 2026-10-12.

All 35 candidate IDs came from Chainlink's
[Arbitrum reference directory](https://reference-data-directory.vercel.app/feeds-ethereum-mainnet-arbitrum-1.json)
(`sourceChain=42161`). Chainlink's unauthenticated
[mainnet Discovery API](https://docs.chain.link/data-streams/reference/data-streams-api/discovery-endpoint)
currently exposes 14 of them: AAPL, AMZN, COIN, CRCL, GOOGL, META, MSFT, MSTR, NVDA, ORCL,
PLTR, QQQ, SPY, TSLA. The other 21 catalog IDs are **candidates, not confirmed entitlements or
4663 availability**; SGOV and USAR are marked hidden in the directory. The owner must confirm
the exact ID list with an entitled Chainlink account before enabling Data Streams for any market.
The [billing guide](https://docs.chain.link/data-streams/billing) says verification is subscription
based; no LINK funding path applies with this zero FeeManager. Owner action: buy/obtain Chainlink
Data Streams mainnet subscription and API key/secret, then test signed reports against the 4663
VerifierProxy. This is owner-gated.

## Automation providers and Pyth

As checked 2026-09-17 UTC:

| Provider | 4663 result | Primary evidence |
|---|---|---|
| Gelato Automate | No published deployment found | [Gelato Automate address map](https://github.com/gelatodigital/automate/blob/master/hardhat/config/addresses.ts) has no Robinhood entry; all 27 published Automate addresses return `eth_getCode=0x` on 4663. Gelato's former [contract-address page](https://docs.gelato.cloud/developer-services/automate/contract-addresses) currently returns 404. An unpublished deployment cannot be excluded. |
| Chainlink Automation | No | [Supported-network list](https://github.com/smartcontractkit/documentation/blob/main/src/content/chainlink-automation/overview/supported-networks.mdx) omits Robinhood; published Arbitrum Registry/Registrar addresses return `0x` code on 4663. |
| Pyth Core | No | [Core EVM address list](https://docs.pyth.network/price-feeds/core/contract-addresses/evm) omits Robinhood. |
| Pyth Pro | **Yes** | [Pro contract list](https://docs.pyth.network/price-feeds/pro/contract-addresses) lists Robinhood `0xACeA761c27A909d4D3895128EBe6370FDE2dF481`; code exists, `verification_fee()` returns 1 wei. [Pro market hours](https://docs.pyth.network/price-feeds/pro/market-hours) cover US equities. Owner needs a Pyth Pro subscription/API key and equity entitlement to submit signed updates. |

Pyth Pro is a possible future source, but the present interface/adapter plan covers Chainlink
Data Streams only. Gelato's missing published deployment leaves permissionless cranker/bounties
as the keeper path in ADR-06.

## NYSE calendar and strike increments

NYSE dates come from the [official 2026–2028 hours and holidays table](https://www.nyse.com/trade/hours-calendars).
Each stored `dayIndex` is `floor(16:00 America/New_York / 86400)`, numerically the UTC day of
the listed NY date. Early closes are 13:00 New York for equities (eligible options may close at
13:15); ADR-07 still treats them as session days. Full closures alone seed `ExpiryCalendar`.

| Year | Full closures (`date:dayIndex`) | Early closes (`date:dayIndex`) |
|---|---|---|
| 2026 | 2026-01-01:20454, 2026-01-19:20472, 2026-02-16:20500, 2026-04-03:20546, 2026-05-25:20598, 2026-06-19:20623, 2026-07-03:20637, 2026-09-07:20703, 2026-11-26:20783, 2026-12-25:20812 | 2026-11-27:20784, 2026-12-24:20811 |
| 2027 | 2027-01-01:20819, 2027-01-18:20836, 2027-02-15:20864, 2027-03-26:20903, 2027-05-31:20969, 2027-06-18:20987, 2027-07-05:21004, 2027-09-06:21067, 2027-11-25:21147, 2027-12-24:21176 | 2027-11-26:21148 |
| 2028 | 2028-01-17:21200, 2028-02-21:21235, 2028-04-14:21288, 2028-05-29:21333, 2028-06-19:21354, 2028-07-04:21369, 2028-09-04:21431, 2028-11-23:21511, 2028-12-25:21543 | 2028-07-03:21368, 2028-11-24:21512 |

Strike proposals use the two [Cboe All Series](https://cdn.cboe.com/data/us/options/market_statistics/symbol_reference/cone-all-series.csv)
calls straddling each registry spot for the 2026-09-18 expiry, measured 2026-09-16. The source
file is a snapshot; expiry-specific listings can differ, and some chains mix increments. Of 35
tickers, 25 near-money gaps differ from the simple rule at the probe's live spot (24 differed at
the earlier registry spot; INTC crossed the $100 threshold). Both values are in JSON
(`strikeTick`, `heuristicStrikeTick`); C2-02/O2-07 should validate actual listed strikes before
creating a ladder.

## ADR check and handoff

- **ADR-05 holds:** Chainlink proxy round history and Uniswap 30-minute observations work;
  NVDA's 500-fee pool passes the rule in this sample; Data Streams VerifierProxy exists and is
  subscription billed.
- **ADR-05 assumption fails:** "Pyth is not on 4663" is too broad. Pyth Core is absent, but Pyth
  Pro is deployed and supports US-equity market hours. The owner must decide whether ADR-05
  explicitly excludes Pro or adds a future Pro source. No adapter or interface was changed here.
- **ADR-06 holds:** no Gelato Automate or Chainlink Automation deployment was found; permissionless
  cranker plus capped bounties remains the documented path.
- **ADR-07 holds:** NYSE 2026–2028 closures and early closes are available as day indexes.

R13 is complete, but the board task is blocked per the plan's ADR rule until ADR-05 states the
Pyth Pro decision. The JSON can be used by O2-01 for pool selection and calendar/strike inputs;
`dataStreamsFeedId` values outside the public Discovery list require entitlement confirmation.
