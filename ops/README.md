# ops/

Everything needed to run Stonkhouse in production, and the on-chain evidence behind it.

Two rules for this directory:

1. **Nothing here is aspirational.** Every address carries the call that proved it and every command
   was run, not imagined. If something is unknown it says so.
2. **The recon under `recon/` outranks the spec, and the contracts outrank the recon.** Where the
   recon describes Overcall's registry, order book or API, it is **history** since the 2026-09-13
   redesign (§ "What changed"), kept because it is evidence, not because it is wired.

---

## What changed on 2026-09-13

The vault was redesigned (owner decisions D1 = A(ii), D16, D17, D14; report in
`~/Desktop/robinhood-dev/projects/callhouse/handoff-2026-09-13/REDESIGN-REPORT-2026-09-13.md`):

- **Write on fill.** `rollOpen(optionId)` arms the week and writes nothing. Every Seaport fill
  writes exactly the contracts it buys inside the vault's `authorizeOrder` hook; `contractsWritten
  == sold`; the vault never holds an unsold option token.
- **No Overcall.** No registry, no order book, no fee item, no EIP-1271, no API. The keeper creates
  the option type on the clearinghouse itself; the only venue is the self-hosted fill page.
- **Stranded claims.** A close whose redeem reverts (USDG pause/freeze, NVDA blocklist) reaches Idle
  with the claim kept; anyone can `retryStrandedClaim()`.
- **98,304 B.** Chain 4663's real code limit; the Vault runtime is above EIP-170 and that is fine.
- **Unaudited**, by decision. The gate is the test suite.

Every file in this directory was rewritten for it. `recon/` was not (it is evidence).

## What changed on 2026-09-15: Tier 1 markets

The pooled vault is **closed** (it only pays out leftovers; `app.stonkhouse.fun/collect`) and the
live product is the per-market **account factory** (`src/solo/` in the contracts repository: one
`AccountFactory` per Stock Token, isolated `WriterAccount` clones, write on fill, one Seaport order
per lot). NVDA's factory is `0xc4A5…2BBb` (block 64,038,234). Tier 1 adds the other 34 Stock Tokens
that have a Chainlink `us_equities_24/5` feed, the same way (design in
`docs/TECHSPEC-TIER1-MULTIMARKET.md`):

- **One registry.** `ops/markets/tier1.json` is the only list of markets; every market-specific
  value (token, feed, factory, keeper, mode, caps) is derived from it and nothing else hard-codes
  a ticker. `ops/markets/README.md` is its contract.
- **One process per market.** `keeper-<ticker>` and `indexer-<ticker>` Railway services, same
  images as today, env-only differences (`deploy.md` §14). No multi-market keeper, no multi-vault
  Ponder schema.
- **One web build.** `/<ticker>/account` and `/<ticker>/book` from a generated market list;
  `/account` and `/book` redirect to `/nvda/*`.
- **One keeper key per market**, derived from the ops mnemonic (indices 10–43), kept under
  `~/.callhouse-keys/markets/`. The admin and guardian keys are shared.
- **Waves.** canary (TSLA, AAPL) → wave1 (12) → wave2 (the rest), each gated on one clean weekly
  cycle (`deploy.md` §14.5; `runbooks/canary-week.md`).
- **Docs from the registry.** `callhouse-docs/product/markets.md` is rendered by
  `ops/markets/render-docs.mjs`; `--check` is a gate.

The vault-era runbooks below are kept for the closed vault; each now opens with a "Factory
markets" preamble that gives the per-market equivalent of every step.

---

## Index

| File | What it is |
|---|---|
| [`addresses.json`](addresses.json) | The address book. Every entry has `address`, `what`, `chainId`, `confirmed` and the `evidence` that proved it. Also the Seaport listing shape, the role hashes, explicit `null`s for our own not-yet-deployed pieces (incl. which clearinghouse), and the Overcall registry rows under `_history_overcall` |
| [`deploy.md`](deploy.md) | The four Railway services (`web`, `keeper`, `indexer`, `relay`), every variable, the Railway facts that changed (config-as-code dead, deploy-time-only healthchecks, sealed variables vs the CLI), §13, the contracts → app hand-off, §14, the per-market `keeper-<ticker>` / `indexer-<ticker>` layout and the wave gates, and §15, the v2 services (layout, the registry in the keeper image, variables, secrets, bot keys, rollback, a recorded dry run) |
| [`go-live-app.sh`](go-live-app.sh) | Sets the variables and deploys all four services in order once the vault exists; refuses a vault that is not ours, a stale Overcall variable, or a Railway CLI too old to see sealed variables |
| [`go-live-v2.sh`](go-live-v2.sh) | Creates, configures and deploys the v2 services. Default set is keyless (`relay`, `indexer-v2`, `pricing`, `notifier`, `monitor`; O8-05). Name `cranker`, `pricer`, `mm-bot`, `web` explicitly. With the recorded dev `--project` and `--environment`, uses `dev.json`/`env-dev`. Dry run by default; refuses an undeployed registry, assignment drift in a selected env file, a bot key that is not the registry address, and at `--apply` a ref whose images cannot carry the registry (`deploy.md` §15) |
| [`runbooks/ops-only-publication.md`](runbooks/ops-only-publication.md) | O8-05: the ops-only file list so a production monitor can be created from a public SHA without the long R1 train. Names only. |
| [`v2/derive-bot-keys.sh`](v2/derive-bot-keys.sh) | The v8 bot hot keys from the ops mnemonic (cranker 60, pricer 61, quoter 62, guardian 63) into `~/.callhouse-keys/v8/<bot>.env` (mode 600, directory 700); writes only the addresses into the registry `v2.bots`. Its own directory, not `~/.callhouse-keys/v2`: those are v7's indices 50-52 and both stacks run at once, so no key is shared. `CALLHOUSE_V2_KEYS_DIR` overrides it, and `go-live-v2.sh` and `ops/v8/cutover-env.mjs` default to the same v8 directory |
| [`v2/notifier-smoke.mjs`](v2/notifier-smoke.mjs) | O3-405: is a DEPLOYED notifier working? Health (database, breakers, Telegram bot, rules engine), CORS (one origin, never `*`, never the caller's), the VAPID public key decoded, the unauthenticated refusals, then a throwaway wallet signing in, subscribing with an already-true price alert, reading it back, taking its Telegram deep link and deleting the row. The base URL is an argument or `NOTIFIER_URL` — there is no default and no hostname in the file; `--read-only` writes nothing at all. `node --test ops/v2/notifier-smoke.test.mjs` |
| [`v2/notifier-backup.sh`](v2/notifier-backup.sh) | O3-409: `pg_dump --schema=notifier` against an operator-supplied connection string (environment, `--url-file` or `--url-stdin`; never a flag, never in argv), then reads the archive back and refuses one that carries no table data. Writes the dump and a manifest (row counts, SHA-256, versions). The restore drill is [`runbooks/notifier-restore.md`](runbooks/notifier-restore.md) |
| [`v2/daily-win.mjs`](v2/daily-win.mjs) | The daily "biggest win" post for X from the indexer's `/v2/stats`: qualification rule, copy checks, the share page and image links; dry run by default, `--post` only with the owner's X credentials in the environment (§ "Daily biggest-win post") |
| [`v2/monitor.mjs`](v2/monitor.mjs) | The v2 external monitor: late / held / disagreeing settlements, missed snapshots, redeem backlog, KeeperRewards budget, MakerVault limits, admin actions, Chainlink proxy and owner Safe, feeds that miss their heartbeat or reopen print, Stock Token and USDG flags, pool liquidity, L2 head lag, every service's `/health`; alerts to the relay, deduped in a JSON state file; `--once` (cron, exit codes) or a loop (`alerts.md` §V17, `deploy.md` §15.12). Tests: `node --test ops/v2/monitor.test.mjs`; devnet gate: `node ops/v2/monitor-devnet.mjs` |
| [`v2/rehearse.sh`](v2/rehearse.sh) | The O2-03 end-to-end fork rehearsal: one anvil fork of 4663, the production `DeployV2Batch.sh --rehearse` (NVDA + TSLA + META) and VerifyV2, Chainlink round feeds etched over the real proxies, a detached node; every v2 service health-checked (indexer, pricing stand-in, cranker, mm-bot, pricer, notifier and relay behind a Telegram stand-in, web); the scripted story asserted on chain and through the indexer with Playwright screenshots; ten failure drills (indexer down under the web ticket, feed paused, sources disagree, guardian veto and adminResolve, cranker killed, mint paused, 24 h fee change, pin refused, USDG paused, the monitor paging each), sandboxed on evm_snapshot where they need no live indexer; the report `v2/REHEARSAL-<date>.md` (`--publish`). Modules and the ledger under `v2/rehearse/` (`out/` gitignored); `--keep`, `--skip-web`, `--only <step>`; `node ops/v2/rehearse/stop.mjs` stops everything |
| [`devnet/`](devnet/README.md) | The local v2 chain: `up.sh` forks 4663 into anvil, deploys the v2 core set (`callhouse-contracts` `script/v2/DevDeploy.s.sol`) against the real USDG, Stock Tokens, feeds and pool, seeds a market with a settled ITM series, and prints the env blocks of every v2 service; `down.sh`, `set-feed.mjs` (mock Chainlink rounds). Anvil's public dev accounts only; the generated `addresses.json`, registry copy and env files are gitignored |
| [`markets/README.md`](markets/README.md) | The market registry's contract: what a row holds, which fields are hand-maintained, who consumes it, how `vol` / `fixed` is decided |
| [`markets/tier1.json`](markets/tier1.json) | **The registry.** 35 markets (every Stock Token with a live Chainlink equity feed), every address read on chain at `verifiedAtBlock`; NVDA `live`, 34 `superseded-by-v2` (their v1 factory rollout was cancelled for v2) with a keeper address each; a `v2` block per market and at the top level. Generated; `deployment.*`, `wave`, `status`, the `v2` blocks and the per-market knobs are hand-maintained |
| [`markets/build-markets.mjs`](markets/build-markets.mjs) | Builds and verifies the registry (feed directory → token list → on-chain checks → Cboe chain probe). `--check` exits 1 on drift or a failing market |
| [`markets/derive-keeper-keys.sh`](markets/derive-keeper-keys.sh) | One keeper hot key per market from the ops mnemonic (indices 10–43) into `~/.callhouse-keys/markets/<TICKER>.env`; writes only the addresses into the registry |
| [`markets/render-docs.mjs`](markets/render-docs.mjs) | Renders `callhouse-docs/product/markets.md` (and its GitBook mirror) from the registry; `--check` is the docs gate |
| [`v2-env.mjs`](v2-env.mjs) | Generates `ops/v2/env/<service>.env` for the six v2 services (`indexer-v2`, `cranker`, `pricing`, `mm-bot`, `pricer`, `notifier`) from the registry's `v2` block: public values only, every secret a named comment. `--check` is the drift gate |
| [`keeper-env.sh`](keeper-env.sh) | Generates [`ops/keeper/markets/<TICKER>.env`](keeper/markets/README.md) for each market from the registry (one file per factory keeper, NVDA's included; never a key). `--check` is the drift gate against the registry |
| [`keeper-railway.sh`](keeper-railway.sh) | Creates the `keeper-<ticker>` Railway services from those env files, layering `KEEPER_PK` on from `~/.callhouse-keys/markets/`; dry-run by default |
| [`runbooks/open-week.md`](runbooks/open-week.md) | The weekly open: flat and not stranded, oracle and fee switch, choose strike and window, create the type, arm, authorise one restricted listing, confirm a fill simulates, reprice after a rally, lock the book |
| [`runbooks/close-week.md`](runbooks/close-week.md) | The close: snapshot, `rollClose` (the unsold week, the stranded close), reconcile the redeem, check the harvest split, settle the queue, publish |
| [`runbooks/v2-canary.md`](runbooks/v2-canary.md) | **v2 go-live, NVDA only** (O2-04, owner-executed): the preconditions and the gates that must be green, the `DeployV2Batch.sh` rehearse → broadcast → verify sequence and how to resume a partial deploy, roles and funding, the MakerVault's canary limits (v7 `maxDailyOutflow` included) and the `MM_*` caps `go-live-v2.sh` waits for, the service bring-up order and its refusals, the first market day end to end with the numbers to record and the stop conditions, the abort and wind-down paths, the owner's sign-off checklist and the next morning. Its dry-run record is §8 |
| [`runbooks/v2-pricing-go-live.md`](runbooks/v2-pricing-go-live.md) | O3-303: keyless `pricing` on stonkhouse-dev then production from public `main`, `PRICING_URL` on each `indexer-v2`, rollback; then production-only `pricer` with `/data` and `RAILWAY_RUN_UID=0`, merge-redeploy outside exchange-close ±20 minutes America/New_York including early closes |
| [`runbooks/relay-monitor-go-live.md`](runbooks/relay-monitor-go-live.md) | O3-006: `RELAY_TOKEN` and the Discord or Telegram target, `relay` then `monitor` service creation, `ops/v2/test-alert.mjs`, expected one-time first-run pages |
| [`maker-epochs/`](maker-epochs/) | O3-205: published maker claim files (`<n>.json`), `check.mjs` (unposted is a distinct explicit state), README. Empty at launch |
| [`runbooks/v2-waves.md`](runbooks/v2-waves.md) | O2-07 expansion after a clean canary week: per-market source and harmonic-liquidity gates, exact-selection rehearsal and registration, registry projections, service rebuilds and first-expiry checks |
| [`runbooks/incident-v2.md`](runbooks/incident-v2.md) | v2: oracle dispute, paused settlement, payout conversion failing, bot key compromise (cranker, pricer, MM quoter), admin key compromise (what it can and cannot do), issuer freeze of a contract address |
| [`runbooks/v8-safes.md`](runbooks/v8-safes.md) | O8-02, INTERFACE_VERSION 8: creating the Admin and Treasury Safes on chain 4663 and signing a transaction **without** the Safe web app — what is verified and what is not, proving the singleton and factory have code, `setup`, `getTransactionHash`, two signatures in ascending owner order, `execTransaction` and its failure codes, writing the addresses back |
| [`runbooks/v8-roles.md`](runbooks/v8-roles.md) | O8-02, INTERFACE_VERSION 8: role operations on the `AccessManager` — which lane a call is in, schedule → wait → **call the target directly**, cancelling and what the guardian can and cannot cancel, instant hot-key rotation through `OPS_ADMIN`, and the two reverts an operator actually sees. Every id and delay is read from `abis/v2/roles.json` |
| [`runbooks/notifier-restore.md`](runbooks/notifier-restore.md) | The notifier backup/restore drill (O3-409): what is lost with each of the eight tables, restoring into a scratch database, checking it against the manifest, and the step that is always skipped — proving the offline `NOTIFIER_DATA_KEY` still decrypts the restored targets. Without that key a complete restore is a complete blank |
| [`runbooks/incident.md`](runbooks/incident.md) | Eleven failures, each with detection, the exact command, who can run it, and what **not** to do, incl. the stranded claim and the unfillable listing |
| [`safes.md`](safes.md) | Safe topology (admin 2/3 after the bootstrap handover, keeper hot key, guardian 1/1 on other hardware, fee Safe). Exactly which vault function each role gates, and how to verify in the source that the guardian can never move a token (re-derived at `ca0e985`). §1-§7 are the **v1 vault only**; §8 is the v8 topology (two 2-of-3 Safes, eleven roles on one `AccessManager`, nothing on the targets) and points at the two runbooks above |
| [`alerts.md`](alerts.md) | Every alert the keepers can raise: v1 (all 24 kinds, §V16), the v2 bots (`v2_*`), the services that send none (pricing, notifier, relay, indexer-v2) and the external monitor (`v2_mon_*`): meaning, severity, the first three things to check, the runbook |
| [`publish-template.md`](publish-template.md) | The weekly post. Five variants, one of which is `unfilled, 0` and one of which is `stranded`. The numbers to publish and the numbers never to publish |
| [`bsproxy.js`](bsproxy.js) | 60-line local reverse proxy that injects a `Referer` so CLI tooling can READ the mainnet Blockscout API. Not part of source verification any more (Sourcify is) |
| [`launch-legal.md`](launch-legal.md) | The legal residue the owner must settle |
| [`fixtures/api/`](fixtures/api) | The `/v1/cycles` row shapes the indexer emits and the web parses; pinned by tests at both ends |
| [`abis/`](abis) | ABIs and verified sources; see below |
| [`recon/`](recon) | The Phase-0 live-chain recon. Source of truth for every address. Do not edit; parts of it (registry, Overcall API, order shape) are now history |

---

## Quick reference

```
Chain            Robinhood Chain mainnet 4663 (0x1237), Arbitrum Orbit L2; code limit 98,304 B
RPC              https://rpc.mainnet.chain.robinhood.com      (primary, archive OK)
                 https://robinhood-rpc.publicnode.com         (backup; REJECTS old-range eth_getLogs)
Explorer         https://robinhoodchain.blockscout.com        (Cloudflare-gated for CLI reads: bsproxy.js)
Verification     Sourcify, --chain 4663; Blockscout imports the match

Valorem Clear    0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0     <- Overcall's unmodified instance, the default;
                                                                    the vault may target our own (vault.clear())
Seaport 1.6      0x0000000000000068F116a894984e2DB1123eB395
USDG (6 dp)      0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
NVDA (18 dp)     0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
Multicall3       0xcA11bde05977b3631167028862bE2a173976CA11
Clear feeTo      0xdAe7e82A2E7D566C67E87C164B05a1C560190782     <- the 15 bps fee-switch key on Overcall's Clear
Chainlink NVDA   0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15     <- "RHNVDA / USD", 8 dp

Listing shape    orderType 3 (PARTIAL_RESTRICTED), zone = the vault, zoneHash 0x0, conduitKey 0x0,
                 ONE USDG consideration item to the vault, empty signature, endTime <= cycleExerciseTs
Cycle window     the option's own exerciseTimestamp / expiryTimestamp, read from the vault
                 (cycleExerciseTs, cycleExpiryTs); the keeper anchors the week on the US close,
                 Friday 16:00 ET (20:00 UTC in DST, 21:00 UTC otherwise; Thursday's close on a
                 Friday NYSE holiday). Never bind to a wall-clock hour.
```

Testnet 46630 is not a useful rehearsal target: Overcall's own Clear exists there
(`0x0059Df7C…`, byte-identical to mainnet; an earlier paragraph here said it did not) but there is
no NVDA Stock Token, no Chainlink RHNVDA feed, and its Overcall cycles are hand-set and lapsed. A
mainnet fork with `--code-size-limit 98304` is the only place to compress a week into minutes.
Evidence: `recon/R7-R8-testnet-explorer.md`, `addresses.json` → `46630`.

---

## Six things that will bite you

1. **`RollOpen.contractsCount` is always 0.** Nothing is written at the open. Sold is the sum of
   `CallsWritten.contractsCount` per `claimKey`, one event per fill. Anything that reads the open
   event as "contracts this week" publishes an unfilled week for every week.
2. **A fill can be refused, and that is the floor working.** The hook re-prices the premium floor
   and the band floor at the spot of the fill block (`PremiumBelowFloorAtFill`, `StrikeBelowBand`).
   A listing priced at Monday's floor is unfillable on Tuesday's uptick until the keeper reprices
   (three authorisations per cycle, cancelled or not). `PREMIUM_MARGIN_BPS` is the cushion.
3. **36 of the vault's 92 custom errors are not in `Vault.json`.** They are raised inside the two
   linked libraries and live only in `ValoremLib.json` / `SeaportOrderLib.json`. Every decoder in
   this repo merges the error fragments; one built from `Vault.json` alone prints a bare selector
   for a mis-built order. Errors only: the library artefacts' function entries are not a parseable ABI.
4. **The 1e18 scalar on Valorem claims.** `claim().amountWritten` and `amountExercised` are
   WAD-scaled; `write()`'s `amount` is a raw `uint112` count. One contract reads as `1000000000000000000`.
5. **The price feed sleeps at the weekend.** `RHNVDA / USD` is a `us_equities_24/5` feed: 21 h gaps
   intra-week, 52 h over a weekend, 78 h over a three-day weekend, restarting 00:00:54 UTC Monday,
   and the frozen value can predate the close by hours. `maxPriceAge` is 4 days for that reason.
   There is **no sequencer uptime feed on 4663**, and at 4 days a stall does not surface as
   `StalePrice` for days: watch head liveness.
6. **A stranded close is a success.** `rollClose` returning with `isStranded() == true` means the
   redeem reverted inside USDG or the Stock Token and the vault kept the claim instead of bricking.
   Deposits, instant redemption and the next arm are shut; queueing, `settleQueue`, `claimUsdg` and
   `retryStrandedClaim` (anyone) are not.

---

## What is in `ops/abis`, and where it came from

| File | Entries | Origin |
|---|---|---|
| `Vault.json` | 209 (1 constructor, 116 functions, 36 events, 56 errors) | Compiled from `contracts/src/Vault.sol` in the `contracts/` submodule at `ca0e985` (`jq --indent 1 '.abi'`). After bumping the submodule pin, regenerate from `contracts/out/Vault.sol/Vault.json`, then `pnpm gen:abis` in `indexer/` and `web/` |
| `ValoremLib.json` | 28 (6 functions, 22 errors) | Compiled from `contracts/src/lib/ValoremLib.sol`. **Errors only** are merged into the generated vault ABIs (`StrikeAboveBand`, `ContractsAbove*`, `RedeemOutOfGas`, `WriteReturnedWrongClaim`, …); the function entries use forge-internal type names and are not usable |
| `SeaportOrderLib.json` | 27 (1 function, 26 errors) | Compiled from `contracts/src/lib/SeaportOrderLib.sol`. Same rule: the errors `approveListing` throws when a proposed order is malformed (`BadZone`, `BadOrderType`, `OfferExceedsCapacity`, …) |
| `Policy.json` | 14 errors | Compiled from `contracts/src/Policy.sol`. All 14 are already inside `Vault.json`; the merge is there for the day one is not |
| `ValoremClear.json` | 57 (1 constructor, 26 functions, 15 events, 15 errors) | **Reproduced upstream build.** Rebuilt from `github.com/valorem-labs-inc/valorem-core` @ `6436c823f560af493af119d6148fb3237037aca4`, solc 0.8.16, optimizer 200, no via-ir, the commit whose bytecode matches the deployed 16,110 bytes. Sourcify reports `exact_match` for the deployment. The keeper uses `newOptionType`, `NewOptionType`, `OptionsTypeExists` from it |
| `StockToken.json` | 56 (36 functions, 9 events, 4 errors) | The Robinhood `Stock` implementation behind the NVDA beacon proxy (`0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2`). Carries `uiMultiplier`, `oraclePaused`, `paused`, `terms`; the surface the vault probes with a `staticcall` |
| `USDG.json` | 94 (76 functions, 6 events, 2 errors) | Paxos USDG, the 6-decimal exercise asset |
| `OvercallRegistry.json`, `OvercallRegistry.abi.json`, `OvercallRegistry.sol`, `IOvercallRegistry.sol`, `IValoremClear.sol` | — | **History.** The verified source and ABI of Overcall's per-market registry, pulled from Blockscout for `0x8E973cE1…`. Nothing in the contracts or the app references a registry since the redesign; kept because `recon/` cites both spellings and because there is no public Overcall repo |

Blockscout's mainnet API is Cloudflare-gated for CLI clients; the pulls above went through a
`Referer`-injecting request. Use `bsproxy.js` for anything scripted that **reads** the API.

**Not committed here:** the Seaport 1.6 ABI. It is canonical and unmodified; take it from
`seaport-types` / `seaport-core`, or from `contracts/src/interfaces/ISeaport.sol`, which carries the
subset the vault uses (`getOrderHash`, `validate`, `cancel`, `incrementCounter`, `getCounter`,
`getOrderStatus`, `information`, plus `IZone` / `ZoneParameters` for the hooks).

---

## Spec repairs the recon forced (history)

Recorded because the old spec treated some of these as open. Rows about the registry
and Overcall's API are doubly historical: the recon answered them, and then the redesign removed the
question.

| Spec said | Chain said |
|---|---|
| `cycle()` returns a `status` enum | No status field anywhere in the registry ABI (moot: no registry) |
| Overcall POST body is `{chainId, order, signature, optionId, maker}` | It was `{chainId, components, signature}` (moot: no POST) |
| Overcall may reject unknown makers, a launch blocker | Their validator requires open orders with zone 0 and a 64/65-byte signature; the redesigned listing is restricted with the vault as zone and an empty signature, so their book is not a venue by design (L-04 dropped) |
| Registry/conduit/zone "fill in at deploy from a live order" | conduitKey `0x0` confirmed; the zone is now the vault itself; there is no registry |
| Price source unknown (R5) | Chainlink `RHNVDA / USD` proxy `0x379EC4f7…`, 8 dp, multiplier already applied |
| Two live weeks on testnet 46630 (M6) | Not useful: no NVDA, no feed; Overcall's Clear exists there but its cycles lapse. Fork instead |
| Staleness ~24 h | 4 days. The feed is `us_equities_24/5` and stops when the market does |
| Vault must fit EIP-170 | Chain 4663 enforces 98,304 B; the vault is 25,470 B and accepted |

---

## Reading assignment out of a close

`Vault.rollClose()` emits `RollClose(cycleNumber, assetsReturned, usdgFromAssignment,
contractsAssignedCount)`. `Vault.sol` reads `contractsAssigned()` *before* the redeem zeroes
`claimKey`, so the fourth field carries the real count. A **stranded** close emits
`RollClose(cycle, 0, 0, 0)` plus `ClaimStranded`; the numbers arrive with the retry's
`StrandedClaimRecovered` and a `Harvest` carrying the stranded cycle's number.

`RollClose.contractsAssignedCount` is a first-class source for the indexer and the publish. Keep
cross-checking it against `contractsWritten - underlyingReturned / 1e18` from the vault's own
`ClaimRedeemed`: two independent numbers that must agree is the whole reconciliation check in
`close-week.md` §4. Under write on fill `contractsWritten == sold`, so the vault is never assigned
on more than it sold.

The `contractsAssigned()` *view* returns 0 after a close, because `claimKey` is zeroed. Snapshot it
before `rollClose`, as `close-week.md` §1 does.

---

## A mid-cycle deposit splits the harvest across two events

Not a defect, but it breaks naive reconciliation and it is easy to miss.

`deposit` and `mint` call `_checkpointHarvest()`, which runs the same `_accrueHarvest` as the close
(with nothing excluded from the fee base: assignment proceeds cannot be in the balance until
`rollClose` redeems the claim). That exists so a late depositor cannot mint into premium earned
before they arrived. The consequence for ops: **a cycle can emit more than one `Harvest` event and
more than one `UsdgDistributed` event.** After a strand, the retry's `Harvest` is a third.

- The fee does **not** leave the vault at a checkpoint. `_accrueHarvest` adds it to `pendingFeeUsdg`;
  only `_harvest()`, which runs from `rollClose` alone, pushes the accumulated total to the fee Safe,
  best-effort (`sweepFee()` recovers a deferred push).
- So the fee Safe's balance increases by the **sum** of `Harvest.feeUsdg` over the cycle, which may not
  equal the feeUsdg on the close's own `Harvest`; that one can legitimately be `0`.
- The fee is 5% of premium only. On an assigned week the close's `Harvest.grossUsdg` includes the
  assignment proceeds but its `feeUsdg` does not: it is `floor((grossUsdg - RollClose.usdgFromAssignment)
  * protocolFeeBps / 10000)`. Never derive the rate as `feeUsdg / grossUsdg`.
- Likewise the week's net per share is the sum of `UsdgDistributed.credited` over the cycle, each
  divided by the `totalSupply` in *that* event.

Every reconciliation in `close-week.md` §5 and `publish-template.md` sums over the cycle for this
reason. Query by the `cycleNumber` topic, which every `Harvest` event carries indexed.

---

## Deploy-day order

The contract side is `contracts/docs/DEPLOY.md` (path A, bootstrap admin); `deploy.md` §13 is the
hand-off. In short:

1. (Optional) `contracts/script/DeployClear.s.sol`: our own clearinghouse, `feeTo` = admin.
2. Deploy: `contracts/script/Deploy.s.sol` (`--no-storage-caching --non-interactive --slow`); its
   preflight checks decimals, the Clear's fee state, Seaport 1.6 and the feed. No registry.
3. Verify: `script/Verify.s.sol` (63 checks). Configure: `script/Configure.s.sol` (keeper and
   guardian grants). Verify again (69).
4. Source verification through Sourcify (`--verifier sourcify --chain 4663`) for the vault and both
   libraries; Blockscout imports the match.
5. Walk `safes.md` §7 end to end, including the guardian check in §4.
6. Fill every `null` under `chains.4663.ours` in `addresses.json` from the broadcast receipts,
   including `clearinghouse` (= `vault.clear()`) and `adminPhase`.
7. `go-live-app.sh` (Railway CLI ≥ 5.47.2); seal the secrets; the web → keeper check; the monitors.
8. Hand over to the Safe (`HandoverAdmin.s.sol`, Verify 72/71) when scheduled; only then renounce.

That list is the pooled vault's (closed). A **factory market** deploys from the registry:
`DeploySoloBatch.sh --wave <wave> --rehearse --rpc http://127.0.0.1:8546` (anvil fork; the registry
defaults to `../callhouse/ops/markets/tier1.json` from the contracts root), then the owner runs
`--broadcast --rpc $RH_RPC` → `keeper-env.sh` + `keeper-railway.sh` →
`indexer-<ticker>` → `pnpm gen:markets` + web rebuild → `render-docs.mjs`; `deploy.md` §14.5 is
the ordered list with the gates.

---

## Daily biggest-win post (v2)

`ops/v2/daily-win.mjs` turns `/v2/stats` `biggestWinDay` (`--window week`: `biggestWinWeek`) into one
post for X that links the W2-09 share receipt (`/pnl/<id>`; X unfurls its `opengraph-image`). It
prints the post, the page URL and the generated image URLs (`/api/pnl/<id>/image`, `?format=square`).
**Dry run is the default.** Posting on X is owner-gated: the script posts only with `--post` and all
four credentials in the environment, and nothing in the repo holds them.

**What qualifies.** The indexer already drops self-fills, off-market fills, transferred positions,
cost under 0.10 USDG and anything that did not pay more than it cost. The script also requires: series
`settled`; cost >= 0.10 USDG (re-checked); payout >= 2x cost; settled within 36 h (day) or 8 days
(week) of now; `/v2/pnl/<id>` answers and agrees with the stats win. Anything else is a skip (exit 0,
reason printed). Data that contradicts itself is exit 1, never a post.

**What the text must do** (checked on every run; a failure is exit 1 and nothing is posted): pair
the payout with its cost ("The buyer paid X USDG, and the most they could lose was X USDG"), carry
"Most options expire worthless.", no promise of returns, no APY/APR/"guaranteed"/"risk-free", "stock"
only as "Stock Tokens", no @handles, no emojis, one link, at most 280 characters as X counts them
(a URL is 23). The amounts round like the share image: cost up, payout down, to 2 dp.

```bash
# Dry run against the fixtures (their day has no win, so the default window skips; the week has one)
node ops/fixtures/serve-v2.mjs --port 42070 &
node ops/v2/daily-win.mjs                                      # "skip (day): biggestWinDay is null"
node ops/v2/daily-win.mjs --window week --now 1789592400       # prints a real post
node --test ops/v2/daily-win.test.mjs                          # fixture server + fake X, never the real API
```

**How the owner posts.** Needs an X app with write access and an access token/secret for the posting
account (OAuth 1.0a user context), a web build with `NEXT_PUBLIC_V2=1` (with `--post` the script
first GETs the page and the image and refuses on anything but 200), and the indexer-v2 domain
(`deploy.md` §15). Keep the four values in a file of your own outside the repo; never type them on
a command line.

```bash
cd <callhouse>
export INDEXER_URL=https://<indexer-v2 domain>
node ops/v2/daily-win.mjs                                      # 1. read the post, open the page and image URLs
( set -a; . <file with X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET>; set +a
  node ops/v2/daily-win.mjs --post )                           # 2. posts once, prints https://x.com/i/web/status/<id>
```

Without all four variables `--post` refuses and names the missing ones. It sends exactly one
`POST /2/tweets` and never retries; X rejects the same text twice (403), so run it once per day.

**Cron (an idea, not configured).** `biggestWinDay` is the New York calendar day of the settlement
(`indexer/src/api/v2/feed.ts`), and a single-source daily finalizes about 6 h after the 16:00 close,
so run late in the New York evening, Monday to Friday: `CRON_TZ=America/New_York` `45 23 * * 1-5`,
or a Railway cron service at `45 3 * * 2-6` UTC (23:45 EDT / 22:45 EST), with the credentials as
sealed service variables and `INDEXER_URL` on the private network. Start with a week of dry runs
reviewed by hand before adding `--post`.
