# Runbook — v2 market expansion (O2-07)

Use this after the [NVDA production canary](v2-canary.md) has completed one clean weekly cycle. The owner chooses the next market and sends every mainnet transaction. Keep v1 `status` separate from `v2.status`: only the latter enables a v2 market.

## Gate for each market

1. Read the canary's first-week record: settlement snapshot, finalize, settle, redeem, open-order pruning, maker quotes, keeper alerts and incident handling must all have completed without an unresolved fault. Keep the canary running during expansion.
2. Re-read the Stock Token, Chainlink feed, strike grid, gas and registry row on chain. Run `node ops/markets/build-markets.mjs --check` against the proposed registry. Confirm the market's `v2.mintFeePpm` is nonzero and its `v2.overrides` are intentional.
3. Decide the settlement source from a fresh pool probe. A Uniswap v3 pool needs a working 30-minute `observe`, fee tier at most 10000, and **observationCardinality at least 2401**. The 11 shallow-ring candidates named in [the registry guide](../markets/README.md) stay Chainlink-only until that gate is met on chain. A Chainlink-only market waits through the uncorroborated delay and pays winning calls in Stock Tokens if no payout route is configured.
4. For any pool that passes, re-derive `v2.univ3MinLiquidity` from **measured 30-minute harmonic liquidity at regular-session closes**, together with current USDG depth. Do not reuse a floor scaled from one instantaneous `liquidity()` read. The 2026-09-17 venue replay found 9 of 13 old pool floors would have missed at least one of 11 closes; AAPL missed 10. Keep the floor and pool set together, and record the observations and chosen floor before registration. A floor below the liquidity needed for the intended USDG depth removes the protection; a floor above normal harmonic liquidity sends settlement to the delayed single-source path.
5. There is one key set and one `mm-bot`, in Railway project `callhouse` production (quoter BIP-44 index 52). stonkhouse-dev is refused signing bots (`go-live-v2.sh --plan-gating --project d8952b22-6bd8-4fd7-984a-7868ee353879 --environment a87aa3a2-1c68-41e7-9866-d0e72810035b --services mm-bot` prints `refuse`). Do not create a second quoter or a second vault for expansion. Check gas, role grants, keeper bounty budget and alert delivery before enabling automated sends. Keep maker-vault limits and `MM_*` caps within the approved canary risk budget; adding a market does not authorize a larger vault.

The registry currently groups NVDA in `canary`, nine markets in `wave1` (AAPL, AMD, AMZN, GOOGL, META, MSFT, QQQ, SPY, TSLA) and the other 25 in `wave2`. A wave is a selection label, not a go-live switch. `--tickers T` makes one market reviewable at a time; `--wave wave1` or `--wave wave2` selects all unregistered rows in that wave.

## Rehearse and register

Start from clean, current `leekzor/v2` checkouts of `callhouse` and its pinned `callhouse-contracts` submodule. The registry must already hold all 13 production addresses and the deploy block from the canary. Keep a copy of the registry and the exact reviewed commit. Follow the key handling and anvil startup in [the canary runbook](v2-canary.md) §2: private keys stay in the environment, never in command arguments or logs.

From the **contracts** checkout, with `REG` set to the absolute path of the app's `ops/markets/tier1.json`, `RH_RPC` set, and an anvil fork on port 8551:

```bash
T=AAPL # replace after reviewing this market's row and source gate
script/v2/DeployV2Batch.sh --rehearse --rpc http://127.0.0.1:8551 \
  --registry "$REG" --tickers "$T"
script/v2/DeployV2Batch.sh --broadcast --rpc "$RH_RPC" \
  --registry "$REG" --tickers "$T"
script/v2/DeployV2Batch.sh --verify --rpc "$RH_RPC" --registry "$REG"
```

The broadcast requires a successful rehearsal of the **same registry, script fingerprint and market selection within 24 hours**. A `VERIFY_FLAGS` or registry change invalidates the record. Stop the anvil after rehearsal. Review the printed plan before typing its broadcast confirmation. If a prior market registered, the batch skips it; if a run partially mined, inspect the write-back and logs before choosing the documented `--resume` path. The batch writes `v2.registeredAt` and `v2.registerTx`; it does **not** set `v2.status`.

Commit the write-back, then set only the reviewed market's `v2.status` to `live`. From the app checkout, regenerate and check the projections before committing the new registry SHA:

```bash
node ops/markets/build-markets.mjs --check
node ops/v2-env.mjs
node ops/v2-env.mjs --check
pnpm --filter @callhouse/indexer gen:v2-registry
pnpm --filter @callhouse/indexer check:v2-registry
pnpm --filter @callhouse/web gen:markets
```

Commit `ops/markets/tier1.json`, `ops/v2/env/`, `indexer/lib/v2/marketRegistry.generated.ts` and `web/lib/markets.generated.ts` together. Rebuild each keeper-image service whose market registry is baked into its image; a restart does not load the new row. Deploy the indexer and web from the same reviewed app SHA, verify `/v2/config`, and then expand `MM_MARKETS` only if maker-vault and bot caps cover this market. A named ticker in `MM_MARKETS` can be quoted even when its registry status is `planned` or `paused`, so stopping its quotes requires removing it from that list or stopping the bot.

Observe the first new expiry end to end before repeating the sequence. Check the pinned source list and pool snapshot inside its ten-minute grace, then finalization, settlement, order pruning and redemption. Use [the incident runbook](incident-v2.md) when any stage stalls. Preserve the mainnet no-redeploy window around expiries described in [the deploy guide](../deploy.md).

## Puts and later source changes

Keep `v2.puts` false for a market until its calls have completed one clean week and the MakerVault has approved USDG collateral and limits for puts. Changing the settlement source for a registered market needs the batch's explicit `--resync` path, a fresh rehearsal and attention to already-pinned expiries. Never treat a source change as a registry-only edit.
