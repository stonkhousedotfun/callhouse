# ops/

Everything needed to run Callhouse in production, and the on-chain evidence behind it.

Two rules for this directory:

1. **Nothing here is aspirational.** Every address carries the call that proved it and every command
   was run, not imagined. If something is unknown it says so.
2. **The recon under `recon/` outranks the spec.** Where `TECHSPEC.md` or `plan.md` disagree with
   `ops/recon/`, the recon is right — it was read off the live chain. The known spec repairs are
   listed in §5 below.

---

## Index

| File | What it is |
|---|---|
| [`addresses.json`](addresses.json) | The address book. Every entry has `address`, `what`, `chainId`, `confirmed` and the `evidence` that proved it. Also the Seaport order config, the Overcall API contract, the role hashes, and explicit `null`s for our own not-yet-deployed pieces |
| [`runbooks/open-week.md`](runbooks/open-week.md) | The Friday open — confirm the cycle rolled, check the oracle and the Valorem fee switch, pick the strike, write, list, verify visibility on Overcall **and** on our own surface |
| [`runbooks/close-week.md`](runbooks/close-week.md) | The Saturday close — snapshot, `rollClose`, reconcile the redeem, check the harvest split, settle the queue, publish |
| [`runbooks/incident.md`](runbooks/incident.md) | Ten failures, each with detection, the exact command, who can run it, and what **not** to do |
| [`safes.md`](safes.md) | Safe topology — admin 2/3, keeper hot key, guardian 1/1 on other hardware and another continent, fee Safe. Exactly which vault function each role gates, including how to verify in the source that the guardian can never move a token |
| [`alerts.md`](alerts.md) | Every alert the keeper can raise: meaning, severity, and the first three things to check |
| [`publish-template.md`](publish-template.md) | The weekly post. Four variants, one of which is `unfilled, 0`. The numbers to publish and the numbers never to publish |
| [`bsproxy.js`](bsproxy.js) | 60-line local reverse proxy that injects a `Referer` so `forge verify-contract` and CLI tooling can reach the mainnet Blockscout API |
| [`abis/`](abis) | ABIs and verified sources — see below |
| [`recon/`](recon) | The Phase-0 live-chain recon. Source of truth. Do not edit |

---

## Quick reference

```
Chain            Robinhood Chain mainnet 4663 (0x1237), Arbitrum Orbit L2
RPC              https://rpc.mainnet.chain.robinhood.com      (primary, archive OK)
                 https://robinhood-rpc.publicnode.com         (backup; REJECTS old-range eth_getLogs)
Explorer         https://robinhoodchain.blockscout.com        (Cloudflare-gated for CLI — use bsproxy.js)

Valorem Clear    0x9a7b40e5c1dB1Af822ef091c990b58b02C78C0C0
Seaport 1.6      0x0000000000000068F116a894984e2DB1123eB395
USDG (6 dp)      0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
NVDA (18 dp)     0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC
Multicall3       0xcA11bde05977b3631167028862bE2a173976CA11
Registry (NVDA)  0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA     <- per-market. NOT the config default
Overcall feeTo   0xdAe7e82A2E7D566C67E87C164B05a1C560190782     <- EOA, also ValoremClear.feeTo()
Chainlink NVDA   0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15     <- "RHNVDA / USD", 8 dp

Seaport config   zone 0x00..00, zoneHash 0x00..00, conduitKey 0x00..00, orderType 1 (PARTIAL_OPEN)
                 endTime = registry.exerciseTimestamp() (Friday book close, NOT Saturday expiry)
Cycle window     book close Fri 20:00 UTC, expiry Sat 20:00 UTC — but bind to registry.cycle(),
                 never to the wall clock
```

Testnet 46630 exists and is **useless for a dry run**: no Valorem Clear, no NVDA Stock Token, and a
`Stock` build that predates `oraclePaused()`. Rehearse on a mainnet fork plus a mock registry.

---

## Five things that will bite you

1. **The JUGGERNAUT registry trap.** Overcall's frontend config has a per-market `registries` map
   *and* a top-level `registry` key. The top-level one is `0x65dD407955912Be814f723724cE60f91ebd72616`
   — the JUGGERNAUT memecoin market, not NVDA. Both are the same 5,905-byte contract and both answer
   every getter; only the immutable `collateralToken` differs. Always read `registries.NVDA`.
2. **The fee rounding rule.** `feePerContract6 = floor(unitPrice6 × 500 / 10000)`, then multiply by
   contracts. Rounding on the total gives an order that signs, validates, and is then unfillable —
   Seaport reverts `InexactFraction` on a partial fill, and every Overcall order is `PARTIAL_OPEN`.
   `unitPrice6` must be ≥ 20 or the 5% floors to zero and their schema rejects it.
3. **The 1e18 scalar on Valorem claims.** `claim().amountWritten` and `amountExercised` are
   WAD-scaled; `write()`'s `amount` is a raw `uint112` count. One contract reads as `1000000000000000000`.
4. **The price feed sleeps at the weekend.** `RHNVDA / USD` is a `us_equities_24/5` feed: 17 h gaps
   intra-week, 52 h over a weekend, 78 h over a three-day weekend, restarting 00:00:54 UTC Monday.
   `maxPriceAge` is 4 days for that reason — a 24 h rule would have guaranteed a 0% week every
   weekend. There is **no sequencer uptime feed on 4663** to guard with.
5. **The registry has no `status` field.** `cycle()` returns
   `(number, exerciseTimestamp, expiryTimestamp, lotSize, optionIds[])`. The gate is
   `isWritingOpen()`. Size against `cycle().lotSize` / `cycleLotSize()`, never `lotSize()` — the
   latter is the forward-looking value the owner can change mid-cycle.

---

## What is in `ops/abis`, and where it came from

| File | Entries | Origin |
|---|---|---|
| `Vault.json` | 193 (1 constructor, 108 functions, 30 events, 54 errors) | Compiled from `contracts/src/Vault.sol` in this repo. Regenerate from `contracts/out/Vault.sol/Vault.json` (take `.abi`), then `pnpm gen:abis` in `indexer/` and `web/` |
| `Policy.json` | 14 errors | Compiled from `contracts/src/Policy.sol`. A library — the error selectors are what the keeper needs to decode a reverted roll |
| `SeaportOrderLib.json` | 30 (1 function, 29 errors) | Compiled from `contracts/src/lib/SeaportOrderLib.sol`. Same reason: these are the errors `approveListing` throws when a proposed order is malformed |
| `ValoremClear.json` | 57 (1 constructor, 26 functions, 15 events, 15 errors) | **Reproduced upstream build.** No 4663 explorer serves verified source for it, so the ABI was rebuilt from `github.com/valorem-labs-inc/valorem-core` @ `6436c823f560af493af119d6148fb3237037aca4`, solc 0.8.16, optimizer 200, no via-ir — the commit whose bytecode matches the deployed 16,110 bytes. Sourcify reports `exact_match` for the deployment |
| `OvercallRegistry.json` | 53 (1 constructor, 28 functions, 4 events, 20 errors) | **Verified source, pulled from Blockscout** for `0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA` (solc 0.8.28, optimizer 200, evm cancun). Every selector was cross-checked against the deployed bytecode's `PUSH4` dispatch table |
| `OvercallRegistry.abi.json` | 53 | Same ABI, different formatting. Semantically identical to `OvercallRegistry.json` — verified with a sorted `jq` diff. Kept because both spellings are referenced in `recon/` |
| `OvercallRegistry.sol` | — | The full verified Solidity source of the deployed registry. There is **no public Overcall repo**, so this file is the only upstream. Re-pull and diff it against this copy at deploy time |
| `IOvercallRegistry.sol` | — | The registry's own interface, from the same verified source. This is where the real `Cycle` struct lives — the one with no `status` field |
| `IValoremClear.sol` | — | Valorem's interface as the registry imports it |
| `StockToken.json` | 56 (36 functions, 9 events, 4 errors) | The Robinhood `Stock` implementation behind the NVDA beacon proxy (`0xb35490d6f9163DE4F80d88dc75c3516eb64C5aE2`). Carries `uiMultiplier`, `oraclePaused`, `paused`, `terms` — the surface the vault probes with a `staticcall` |
| `USDG.json` | 94 (76 functions, 6 events, 2 errors) | Paxos USDG, the 6-decimal exercise asset |

Blockscout's mainnet API is Cloudflare-gated for CLI clients; the pulls above went through
`firecrawl` or a `Referer`-injecting request. Use `bsproxy.js` for anything scripted.

**Not committed here:** the Seaport 1.6 ABI. It is canonical and unmodified — take it from
`seaport-types` / `seaport-core`, or from `contracts/src/interfaces/ISeaport.sol`, which carries the
subset the vault actually calls (`getOrderHash`, `validate`, `cancel`, `incrementCounter`,
`getCounter`, `getOrderStatus`, `information`).

---

## Spec repairs the recon forced

Recorded here because `TECHSPEC.md` still reads as if some of these were open.

| Spec said | Chain says |
|---|---|
| `cycle()` returns a `status` enum | No status field anywhere in the ABI. Use `isWritingOpen()` / `isCycleLive()` |
| Overcall POST body is `{chainId, order, signature, optionId, maker}` | It is `{chainId, components, signature}`. `optionId` and `maker` are derived server-side |
| Overcall may reject unknown makers — launch blocker | No allowlist, no API key, no handshake. Their docs state check 8 accepts "EOA **or ERC-1271**" |
| Registry/conduit/zone "fill in at deploy from a live order" | All known and confirmed: registry `0x8E973cE1…`, zone `0x0`, conduitKey `0x0`, orderType `1` |
| Price source unknown (R5) | Chainlink `RHNVDA / USD` proxy `0x379EC4f7…`, 8 dp, multiplier already applied |
| Two live weeks on testnet 46630 (M6) | Impossible — no Valorem, no NVDA, no `oraclePaused()`. Fork + mock registry instead |
| Staleness ~24 h | 4 days. The feed is `us_equities_24/5` and stops when the market does |

---

## Reading assignment out of a close — resolved

`Vault.rollClose()` emits `RollClose(cycleNumber, assetsReturned, usdgFromAssignment,
contractsAssignedCount)`. An earlier draft of the vault hardcoded that fourth field to `0`, which made
every assigned week look unassigned. **That is fixed.** `Vault.sol` now reads
`contractsAssigned()` *before* `_redeemClaim` zeroes `claimKey`, so the field carries the real count:

```solidity
// Vault.sol, rollClose()
uint256 assignedCount = contractsAssigned();
(uint256 assetsReturned, uint256 usdgFromAssignment) = _redeemClaim(asset, usdg);
emit RollClose(cycleNumber, assetsReturned, usdgFromAssignment, assignedCount);
```

Verify before trusting this paragraph:

```bash
grep -n -A3 "uint256 assignedCount" contracts/src/Vault.sol
```

`RollClose.contractsAssignedCount` is now a first-class source for the indexer and the publish. Keep
cross-checking it against `contractsWritten - underlyingReturned / 1e18` from the vault's own
`ClaimRedeemed` — two independent numbers that must agree is the whole reconciliation check in
`close-week.md` §4 — but there is no longer a reason to route around the event.

Note the other half of the same trap is still live and is **not** a defect: `contractsAssigned()` the
*view* does return 0 after a close, because `claimKey` is zeroed. Snapshot it before `rollClose`, as
`close-week.md` §1 does.

---

## A mid-cycle deposit splits the harvest across two events

Not a defect either, but it breaks naive reconciliation and it is easy to miss.

`deposit` and `mint` call `_checkpointHarvest()`, which runs the same `_accrueHarvest()` as the close.
That exists so a late depositor cannot mint into premium earned before they arrived. The consequence
for ops: **a cycle can emit more than one `Harvest` event and more than one `UsdgDistributed` event.**

- The fee does **not** leave the vault at a checkpoint. `_accrueHarvest` adds it to `pendingFeeUsdg`;
  only `_harvest()`, which runs from `rollClose` alone, transfers the accumulated total to the fee Safe.
- So the fee Safe's balance increases by the **sum** of `Harvest.feeUsdg` over the cycle, which may not
  equal the feeUsdg on the close's own `Harvest` — that one can legitimately be `0`.
- Likewise the week's net per share is the sum of `UsdgDistributed.credited` over the cycle, each
  divided by the `totalSupply` in *that* event.

Every reconciliation in `close-week.md` §5 and `publish-template.md` sums over the cycle for this
reason. Query by the `cycleNumber` topic, which every `Harvest` event carries indexed.

---

## Deploy-day order

1. Deploy: `contracts/script/Deploy.s.sol` — its `_preflight` re-checks the registry's collateral,
   exercise token, clearinghouse and lot size before broadcasting, and prints the live feed age.
2. Configure: `contracts/script/Configure.s.sol` — grants `KEEPER_ROLE` and `GUARDIAN_ROLE`.
3. Verify on Blockscout through `bsproxy.js`, with a `dev.blockscout.com` API key.
4. Walk `safes.md` §7 end to end, including the guardian check in §4.
5. Fill every `null` under `chains.4663.ours` in `addresses.json` from the broadcast receipt.
6. Only then renounce the deployer's `DEFAULT_ADMIN_ROLE`, and only after confirming the Safe holds it.
