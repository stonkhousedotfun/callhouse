# ops/

Everything needed to run Callhouse in production, and the on-chain evidence behind it.

Two rules for this directory:

1. **Nothing here is aspirational.** Every address carries the call that proved it and every command
   was run, not imagined. If something is unknown it says so.
2. **The recon under `recon/` outranks the spec, and the contracts outrank the recon.** Where
   `TECHSPEC.md` or `plan.md` disagree with `ops/recon/`, the recon is right; it was read off the
   live chain. Where the recon describes Overcall's registry, order book or API, it is **history**
   since the 2026-09-13 redesign (§ "What changed"), kept because it is evidence, not because it is
   wired.

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

---

## Index

| File | What it is |
|---|---|
| [`addresses.json`](addresses.json) | The address book. Every entry has `address`, `what`, `chainId`, `confirmed` and the `evidence` that proved it. Also the Seaport listing shape, the role hashes, explicit `null`s for our own not-yet-deployed pieces (incl. which clearinghouse), and the Overcall registry rows under `_history_overcall` |
| [`deploy.md`](deploy.md) | The four Railway services (`web`, `keeper`, `indexer`, `relay`), every variable, the Railway facts that changed (config-as-code dead, deploy-time-only healthchecks, sealed variables vs the CLI), and §13, the contracts → app hand-off |
| [`go-live-app.sh`](go-live-app.sh) | Sets the variables and deploys all four services in order once the vault exists; refuses a vault that is not ours, a stale Overcall variable, or a Railway CLI too old to see sealed variables |
| [`runbooks/open-week.md`](runbooks/open-week.md) | The weekly open: flat and not stranded, oracle and fee switch, choose strike and window, create the type, arm, authorise one restricted listing, confirm a fill simulates, reprice after a rally, lock the book |
| [`runbooks/close-week.md`](runbooks/close-week.md) | The close: snapshot, `rollClose` (the unsold week, the stranded close), reconcile the redeem, check the harvest split, settle the queue, publish |
| [`runbooks/incident.md`](runbooks/incident.md) | Eleven failures, each with detection, the exact command, who can run it, and what **not** to do, incl. the stranded claim and the unfillable listing |
| [`safes.md`](safes.md) | Safe topology (admin 2/3 after the bootstrap handover, keeper hot key, guardian 1/1 on other hardware, fee Safe). Exactly which vault function each role gates, and how to verify in the source that the guardian can never move a token (re-derived at `ca0e985`) |
| [`alerts.md`](alerts.md) | Every alert the keeper can raise (14 kinds): meaning, severity, and the first three things to check; plus the conditions nothing emits and the external monitors that must exist |
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

Recorded because `TECHSPEC.md` still reads as if some of these were open. Rows about the registry
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
