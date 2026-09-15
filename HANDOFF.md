# Handoff (state as of 2026-09-15 ~17:00 UTC)

Renamed from Callhouse (callhouse.finance) to Stonkhouse (stonkhouse.fun) on 2026-09-15. Repo, package, service, env and on-chain names still say callhouse.

Stonkhouse is **deployed on Robinhood Chain (4663) and running its canary week**. Cycle 1 is Listed with one
contract offered and nothing sold yet. There is no external audit (owner decision D14). An internal review on
2026-09-14 found no Critical/High/Medium, and Low L-01 is fixed in the deployed source. Every figure below was
read on 2026-09-15 unless it says otherwise; the chain is the truth, so re-read before acting.

Canary runbook: `ops/runbooks/canary-week.md`. Address book: `ops/addresses.json` (`chains.4663.ours`).

## Repositories

Four private repositories under `leekzor`. SHAs are GitHub `main` on 2026-09-15.

| Repo | `main` | What is deployed from it | Unpushed work |
|---|---|---|---|
| `callhouse` (this repo: web, keeper, indexer, relay, ops) | `820ea75` before this branch; submodule `contracts/` pinned to `0e2f6f6` | web (rebuilds on push); keeper (uploaded with `railway up`, see Services) | none known on `main` |
| `callhouse-contracts` | `0e2f6f6` (docs-only rename on top of `165b4ab`) | tag `v1.0.0-rc1` = `165b4ab`, pushed. This is the deployed source: `src/` is identical between `165b4ab` and `0e2f6f6` | none |
| `callhouse-site` | `2e40746` (rebrand only) | stonkhouse.fun (rebuilds on push) | `redesign/write-on-fill` at `9529b13`, local only |
| `callhouse-docs` | `1ad8252` (rename only) | docs.stonkhouse.fun (GitBook Git Sync from `main`; push publishes, `main` is unprotected) | `redesign/pass-2` at `c2475ca`, local only |

The site and docs on `main` still describe the pre-redesign Overcall product. The write-on-fill rewrites exist
only on the local branches above (see Open items).

CI: the app's `ci` workflow is green on `820ea75`. The contracts `ci` workflow is **red on `main`**
(the push runs for `165b4ab` and `0e2f6f6` both failed). On `0e2f6f6` the fork job passes, but the
unit/invariant job fails 2 of 341 tests (`[FAIL: EvmError: CreateContractSizeLimit] constructor()`, once in `VaultInvariant.t.sol` and once in
`VaultQueue.t.sol`). The cause was not traced; the local runs use `code_size_limit = 98304`. The local gates recorded on 2026-09-14 (405 offline tests, 20/20 fork)
are what the deploy relied on.

## Live contracts and roles (chain 4663)

| Thing | Address | Notes |
|---|---|---|
| Vault "Callhouse NVDA" (cNVDA, 18 dp) | `0x88a98931E3682137E7e4D3426f623247f4A4ecbb` | deployed block 63467882 (07:06 UTC), runtime 25,775 B. `clear()` = our Clear, `seaport()` = Seaport 1.6, `conduitKey()` = 0 |
| Our Valorem Clear | `0x53d7A6d0489Daf3d67b9A314e0eAB2B78Acab9C6` | `feeTo()` = Safe below, `feesEnabled()` false, `feeBps()` 15 (compiled constant). Vault `valoremFeeAccepted()` false |
| SeaportOrderLib | `0x6B617a0B578Ef6EDCD07774468f08b3778272D8A` | CREATE2 via `0x4e59b448…`, linked into the vault |
| ValoremLib | `0xd3CB94893EAb55e425cCd77Db98458b38D75Fa3d` | CREATE2 via `0x4e59b448…`, linked into the vault |
| Seaport 1.6 | `0x0000000000000068F116a894984e2DB1123eB395` | `getCounter(vault)` 0 |
| NVDA Stock Token (18 dp) | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | vault asset |
| USDG (6 dp) | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` | premium and strike currency |
| Chainlink RHNVDA/USD (8 dp) | `0x379EC4f7C378F34a1B47E4F3cbeBCbAC3E8E9F15` | `maxPriceAge()` 345600 s (4 days) |
| Clear fee Safe (1-of-1, v1.4.1) | `0xff1454009F024507f3E455eb2027E98fAF4ccF61` | owner `0x7A3a8C3F6331f63107D5b3aEeA0515e799022C32`; Safe nonce 0, no modules, no guard; created by the admin EOA at its nonce 0 (block 63467156) |

Roles (plain OpenZeppelin AccessControl: no timelock, no admin delay; every role's admin is `DEFAULT_ADMIN_ROLE`).
Exactly three `RoleGranted` events and no `RoleRevoked`.

| Role | Holder | ETH on 4663 / nonce | Can |
|---|---|---|---|
| `DEFAULT_ADMIN_ROLE` | hot EOA `0xEb82c3D0F89d47453F94f0C2b2a2752e27a19d9b` (mnemonic account 0) | 0.0491 / 8 | `setPolicy`, `setDepositCap` (unbounded), `setFeeRecipient`, `setMaxPriceAge`, `acceptValoremFee`, `unhaltWrites`, `haltWrites`, grant/revoke any role. Effective immediately, mid-cycle included |
| `KEEPER_ROLE` | `0x06c131cfEd73A56893f5eB52D17252856FAFC1d2` (account 1) | 0.0199 / 5 | `rollOpen`, `approveListing`, `cancelListing`, `invalidateAllListings`, `rollClose` from expiry |
| `GUARDIAN_ROLE` | `0x29741A8d283a253E8Ce10aDfd04C6507438b6F39` (account 2) | 0.0100 / 0 (never sent a tx) | `haltWrites`, `cancelListing`, `invalidateAllListings`. Cannot unhalt |

All three keys come from one mnemonic. `vault.feeRecipient()` is the hot admin EOA. The Safe handover
(`HandoverAdmin.s.sol`) is deferred a few weeks; it does not move the Clear's `feeTo`.

### Verification status

| Contract | Sourcify (v2 API) | Blockscout |
|---|---|---|
| Vault | `match` (partial): creationMatch `match`, runtimeMatch `match`, 07:07 UTC | partially verified (via eth_bytecode_db / verifier_alliance) |
| SeaportOrderLib, ValoremLib | `match` (partial): runtimeMatch `match`, creationMatch null | not verified |
| Our Clear `0x53d7…C6` | **not verified** | **not verified** |
| Overcall's Clear `0x9a7b…C0` (reference only) | `exact_match` (2026-09-10) | v2 API says not verified |

Our Clear's runtime is byte-identical to Overcall's `0x9a7b…C0` except the CBOR metadata hash, and that
Sourcify source equals valorem-core `6436c823` (plus a trailing newline). Fetch the reference source from
Sourcify, not Blockscout (Blockscout's API sits behind a Cloudflare challenge; `ops/bsproxy.js` or a Referer
header gets through).

## Policy and parameters

Live `policy()` = minOtmBps 300, maxOtmBps 1200, **minPremiumBps 10**, maxUtilizationBps 9500, protocolFeeBps 500,
maxContractsCap 50. `depositCap()` 20 NVDA. `writesHalted()` false. Max 3 listings per cycle (compiled).

**Policy change:** `minPremiumBps` 40 → 10 by the admin EOA in
`0x97b7e52958c36dbb93f109139880bf7162471581377a792147c20255788dc37b` (block 63772251, 15:44 UTC). 10 is the
compiled floor `MIN_PREMIUM_FLOOR_BPS`. `Policy.launchDefaults()` in source still says 40, and so do
`contracts/docs/AUDIT-SCOPE.md` and the unpushed site branch. The keeper logged the change at 15:45 UTC. It does
not reprice a live listing down.

## Canary state (cycle 1)

| | |
|---|---|
| Deposit | 1.06 NVDA for 1.06 cNVDA by `0x2B7635F52F7E0818D48CF847BBCd5AaDBFC593Ad` (EOA), block 63487510, 07:39 UTC, tx `0x1baf6692…310c`. Sole holder |
| Arm | keeper `newOptionType` (block 63494157, 07:50 UTC) then `rollOpen` (block 63494170) |
| Option | id `0xa17b200709b7d411b46538364d52c7a7fd891f67` << 96; 1 NVDA for 223 USDG |
| Phase | `phase()` 1 = Listed; `cycleNumber()` 1; `epochId()` 1 |
| Exercise ts | 1789761600 = **Fri 2026-09-18 20:00 UTC** (16:00 ET). Fills and deposits stop here; exercise opens |
| Expiry ts | 1789848000 = **Sat 2026-09-19 20:00 UTC**. Keeper may `rollClose` from here; anyone from 21:00 UTC |
| Listings | 2 of 3 used. First `0x35e365ee…77a9` (gross 851950) approved 07:50 UTC, cancelled 12:57 UTC. Live `0x95bd566f…2da6`: 1 contract, gross 856436 (0.856436 USDG), validated on Seaport, 0 filled. One reprice left this cycle |
| Sold | `contractsWritten()` 0, `claimKey()` 0, no `OptionsWritten` on the Clear, vault USDG balance 0 |
| NAV | `totalAssets()` = `totalSupply()` = 1.06e18; reserved 0; queued 0; not stranded |
| Instant redeem | closed (only `phase == Idle && contractsWritten == 0` opens it); `queueRedeem` works |

The live listing has `pricing: null` in `/api/keeper/orders`: it was priced by the keeper build before vol pricing
and before the minPremium change, so the vol reprice-up rule does not apply to it. The first vol-priced arm can
come no earlier than the keeper's first tick after the cycle 1 close, as cycle 2 (exercise 1790366400, Fri
2026-09-25 20:00 UTC; expiry 1790452800), and it is not guaranteed: the keeper arms only with capacity of at least
1 contract (`floor(totalAssets × 9500 / 1e4 / 1e18) ≥ 1`, i.e. `totalAssets()` ≥ about 1.0527 NVDA, against 1.06
today) and only on usable Cboe data. An exercise of the canary contract (runbook step G) leaves 0.06 NVDA, so
nothing arms. Runbook step I's instant redeem races that tick: once the keeper arms, the vault is Listed and
instant redemption closes; if the redeem lands first, capacity is 0 and nothing arms.

## Services (Railway project `callhouse`, environment `production`)

| Service | State | How it deploys | Last deployment |
|---|---|---|---|
| keeper | Online, volume `keeper-volume`, no public domain (web reads `http://keeper.railway.internal:8787/orders`) | **`railway up` from a local tree; no git source**, so a push does not redeploy it | `8437b1c3` SUCCESS 15:28 UTC (earlier `58095a65` removed, `9b6b6276` failed). Boot log: phase Listed, cycle 1, pricing_json migration; vol mode (default, `KEEPER_PRICING_MODE` unset); `KEEPER_PREMIUM_MARGIN_BPS=50` |
| web | Online, https://app.stonkhouse.fun | rebuilds on push to `callhouse` `main` | `e677330e` SUCCESS 14:52 UTC, after `820ea75` |
| site | Online, https://stonkhouse.fun | rebuilds on push to `callhouse-site` `main` | `d82ebdeb` SUCCESS 14:33 UTC (`2e40746`) |
| indexer | Online, **synced** (re-checked 18:54 UTC) | not re-checked here; stores in the Postgres service | `aff9e5e0` SUCCESS 16:57 UTC; `15e69ee3` and `d920f6ec` removed |
| Postgres | Online, `postgres-volume` | | |
| relay | **Offline, not deployed** ("No deployments found"; only `PORT` and `RELAY_TOKEN` set) | | |

Indexer health, `curl https://indexer-production-5881.up.railway.app/v1/health` at 18:54 UTC: `status: ok`, indexer
head 63882183 vs RPC 63882185, lag 2 blocks / 0 s, vault Listed, cycle 1, lastActivityBlock 63772251. Earlier that
afternoon (16:56 UTC, before deployment `aff9e5e0`) it was `lagging` by about 7.3 h; the activity page uses the
indexer while it answers, so check `/v1/health` before trusting history there.

Alerts are **not delivered**: the keeper has `ALERT_WEBHOOK_TOKEN` but no `ALERT_WEBHOOK`, and the relay is not
deployed. Alerts are logged and stored in the keeper's SQLite only. `CLEARINGHOUSE` is set to our Clear in keeper,
web and indexer env. The web code default now names our Clear too; the keeper and indexer code defaults still name
Overcall's `0x9a7b…C0`, so those two services must keep `CLEARINGHOUSE` set. The indexer backfills from a keyed Alchemy
archive endpoint (`PONDER_RPC_URL_4663`); Robinhood's public RPC cannot serve historical `eth_call`.

## Owner decisions to date

- **2026-09-13, redesign D1-D17 (final):** write on fill inside the vault's own PARTIAL_RESTRICTED Seaport order;
  the keeper creates each week's option type; no Overcall registry, order book, fee or EIP-1271 (D1 = A(ii),
  D2 = b: the app's cycle page is the only venue). D14: no external audit, the test suite is the gate. D17:
  chain 4663's 98,304 B code limit is relied on. W-1: a deposit while a call is open is priced at face value and
  shares that week's assignment.
- **2026-09-14:** own Clear via `DeployClear.s.sol`, `feeTo` = a 1-of-1 Safe owned by `0x7A3a…2C32`. Vault admin
  stays the hot EOA (account 0) until handover; keeper account 1; guardian account 2 of the same mnemonic.
  `feeRecipient` = hot EOA for the canary. `KEEPER_PREMIUM_MARGIN_BPS=50`. Deposit cap 20 NVDA, raised weekly by
  the owner after clean weeks (the owner names each raise). No alerts for the canary. Merge and push both repos
  when gates are green, tag `v1.0.0-rc1` (done). Land L-01 before rc1 (done). Legal residue (entity, governing
  law, GDPR controller) ignored for the canary. Keeper vol pricing is the default: strike at delta about 0.15
  from Cboe's free delayed NVDA chain, ask = max(floor + margin, fair + 10%), unusable data skips the week;
  `KEEPER_PRICING_MODE=fixed` is the operator fallback (`keeper/README.md`).
- **2026-09-15:** rebrand to Stonkhouse / stonkhouse.fun (identifiers keep callhouse). `minPremiumBps` lowered to
  10 (tx above).
- **Standing:** not available to US persons, by the terms only (no technical control, no KYC). Contacts are
  `security@`, `legal@` and `privacy@stonkhouse.fun`. No bug bounty exists.

## Open items

This list points at the documents that own each item rather than copying them.

- **Finish the canary** per `ops/runbooks/canary-week.md` steps F-J: one fill through
  https://app.stonkhouse.fun/vault/nvda/cycle before Fri 18 Sep 20:00 UTC, optional exercise between then and
  Sat 20:00 UTC, the close, then redeem and claim. Only one listing slot remains this cycle. The exercise can
  go through the cycle page's Exercise card, which this branch (`accuracy/exercise-and-docs`) adds and which is
  live only once it is merged and web rebuilds; until then, and always as the fallback, call `exercise` on the
  Clear directly (step G). See the cycle 2 note under Canary state: an exercise or an early redeem means the
  keeper does not arm cycle 2.
- **Audit and review findings:** the internal review is
  `~/Desktop/robinhood-dev/projects/callhouse/handoff-2026-09-13/AUDIT-FINDINGS-2026-09-14.md`; the audit scope is
  `contracts/docs/AUDIT-SCOPE.md`, which is stale against the deployment (appendix says "not deployed", names a
  Fee Safe as fee recipient, quotes minPremium 40).
- **Launch checklists:** `docs/LAUNCH-PLAN.md` (DNS/site/docs steps, some recorded against callhouse.finance) and
  the owner's untracked `LAUNCH-CHECKLIST.md` in the app checkout (dated 2026-09-13, pre-deploy; read it, do not
  edit it).
- **Public copy is behind the product:** stonkhouse.fun (`main` `2e40746`) still describes Overcall, "not
  deployed", 0.40% minimum premium and a planned external audit, and `/legal` promises a bug bounty in launch week 2.
  The site and docs rewrites are unpushed (`redesign/write-on-fill` `9529b13`, `redesign/pass-2` `c2475ca`) and
  the site branch still says "not deployed", 0.40% and a 1% margin. Publishing is the owner's call.
- **Alert delivery** (relay deploy plus `ALERT_WEBHOOK`) before public deposits, and keep an eye on indexer
  health (it lagged by hours earlier on 2026-09-15 before a redeploy).
- **Source verification** of our Clear (Sourcify or Blockscout), and Blockscout for both libraries.
- **Contracts CI** red on `main` (size limit in two suites, above).
- **Admin handover** to a Safe, `feeRecipient` off the hot EOA, and a guardian key off the shared mnemonic.
- Keeper calendar limits: early closes are not modelled, and the built-in NYSE holiday table ends after 2027
  (`keeper/src/calendar.ts`).

## History

- 2026-09-15: DeployClear, Deploy, Verify and Configure on mainnet (admin EOA nonces 0-6: Safe, Clear, two
  libraries, vault, keeper grant, guardian grant); Sourcify verification; Railway go-live; deposit, arm, list,
  relist; policy change.
- 2026-09-14: contracts `165b4ab` (L-01 in `bec4dbd`); keeper 96/96 with both fork dry runs; indexer X-11 passed;
  web W-13 passed; deploy rehearsal on a fork (block 63400155) passed. Per-package detail:
  `~/Desktop/robinhood-dev/projects/callhouse/handoff-2026-09-13/HANDOFF-2026-09-14.md`.
- 2026-09-13: contracts redesign, app port started, ops and docs rewritten for write on fill
  (`~/Desktop/robinhood-dev/projects/callhouse/handoff-2026-09-13/REDESIGN-REPORT-2026-09-13.md`).

## Traps

- The public RPC keeps only a few thousand trailing blocks of state (historical `eth_call` fails with
  "metadata is not found"; `eth_getLogs` over history works). Start anvil and run the dry run within minutes,
  **with the code-size flag**:

  ```bash
  (cd contracts && forge build)
  anvil --fork-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663 --port 8545 --code-size-limit 98304
  pnpm --filter @callhouse/keeper dryrun
  ```

- A default anvil refuses the 25 KB vault. `forge build --sizes` exits 1 on its EIP-170 line; that
  is forge, not the chain. `forge script --broadcast` needs `--non-interactive` for the same reason.
- Pass `--no-storage-caching` to every forked `forge script`/`forge test` run near anvil: forge's
  RPC cache (`~/.foundry/cache/rpc/4663/`) can store anvil blocks and silently make later runs lie.
- `RollOpen.contractsCount` is always 0 now; sold is the sum of `CallsWritten` per `claimKey`.
- 36 of the vault's 92 custom errors live only in the library artefacts. A decoder built from
  `Vault.json` alone prints a bare selector for a mis-built order.
- Premium from a fill is not claimable until the next deposit, `settleQueue`, `rollClose` or
  `retryStrandedClaim` indexes it; there is no public harvest.
- `contracts/` is a submodule. An empty `contracts/` means `git submodule update --init --recursive`
  was never run. `git submodule update` resets the pin to what this repo records.
- A change that spans repos is paired commits. Land the contracts commit first, then bump the pin
  here in the same commit as the app-side changes that depend on it. Copy that changes in `web/`
  usually needs the same change in `callhouse-site` and `callhouse-docs`.
- The keeper is not repo-connected: merging keeper code to `main` does not change what runs until someone
  runs `railway up` for it.
- Railway: config-as-code is deprecated (the `railway.json` files are reference only); healthchecks
  run at deploy time only; sealed variables are invisible to CLI 4.54.0; volumes mount root-owned.
  `ops/deploy.md` has each. A bare `railway domain` creates a public domain.
- Several Claude sessions work in these trees at once. Run `git status` before committing, stage
  only your own files, and push fast-forward only. `LAUNCH-CHECKLIST.md` and `docs/COPY.md` in the
  app tree are the owner's untracked files; leave them alone.
