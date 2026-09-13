# Launch plan

Written 2026-09-13. Parts 1–4 are executed now; parts 5–7 are documented here and need decisions
or on-chain actions from the owner. Status of each step is kept in this file as it lands.

State at the start (verified 2026-09-13 ~13:10 PT):

| Surface | State |
|---|---|
| Cloudflare `callhouse.finance` | zone active (Free), SSL Full, Email Routing live (`legal@`, `privacy@`, `security@`). **No web records** for apex, `www`, `app`, `docs` |
| Railway project `callhouse` | one service, `site`, healthy at `site-production-bea7.up.railway.app`, deployed by `railway up` (not repo-connected). Custom domains `callhouse.finance` + `www` attached, waiting on DNS. No `web`, `keeper`, `indexer` services |
| GitHub CI | site and contracts green; **app repo red** (pnpm version specified twice) |
| `callhouse-contracts` | GitHub `main` at `2a9bb59` (two docs commits by another session); 8 local commits **not pushed**, including both 2026-09-13 contract fixes (lot size, queue fairness) |
| Docs | `leekzor/callhouse-docs` pushed; GitBook sync in progress; `docs.` CNAME target comes from GitBook |

Status (2026-09-13 ~14:30 PT):

| Part | State |
|---|---|
| 1.1–1.3 | **done.** Apex and `www` CNAMEs (DNS only) plus Railway's `_railway-verify` TXT records; both return 200 with valid TLS |
| 1.4 | **done** (owner connected the repo). Pushes to `callhouse-site` `main` deploy |
| 1.5 | **done** (14:54 PT). `CNAME docs → 9cbc89af57-hosting.gitbook.io` (DNS only); after ~2 h of Cloudflare 1014 while GitBook activated the custom hostname, `docs.callhouse.finance` serves 200 with its own certificate and the latest synced content |
| 2 | **done.** `callhouse-site` 39caed5, c721dba, 69fb6b3 (no-buyer weeks pay zero *premium*; queue USDG per entry; an issuer freeze can hold up the close). GitBook docs audited against the code (718 claims): `callhouse-docs` 29823dd, 3cf2b4e |
| 3 | **done.** Contracts `634bf55` on GitHub; app submodule pinned; `ops/safes.md` §7 updated |
| 4.1–4.9 | **done.** CI green; W-21, K-21, margin, indexer Dockerfile, X-11 (three indexer defects fixed), relay, K-22 (dead-listing defect fixed), W-13 (status flip-flop fixed in e5392fe). Follow-up 1c3de3d: an unfilled week that Valorem assigned anyway is labelled "unfilled, assigned N" in the web app |
| Open | keeper `/orders` fallback not wired into the web app (`docs/WIRING.md` §7); GitBook site title shows "callhouse Docs" (rename in GitBook site settings) |

---

## 1. Site live on `callhouse.finance`

| Step | Who | Done when |
|---|---|---|
| 1.1 Read Railway's required CNAME targets for both custom domains from the API (do not trust notes) | Claude | targets printed from Railway |
| 1.2 Create `CNAME callhouse.finance → <target>` and `CNAME www → <target>`, **DNS only** (Cloudflare flattens the apex) | Claude if the Cloudflare token has Zone DNS:Edit; otherwise the owner in the dashboard | `dig` resolves both |
| 1.3 Wait for Railway to issue TLS | — | `https://callhouse.finance` and `https://www.callhouse.finance` return 200 with a valid certificate |
| 1.4 Connect the `site` service to `leekzor/callhouse-site` (Settings → Source) for push-to-deploy | owner (the CLI/API repo-link mutation was rejected for this account) | a push to `main` triggers a deploy |
| 1.5 `docs.callhouse.finance`: CNAME to the target GitBook shows (DNS only) | owner reads the target in GitBook; Claude or owner adds it | GitBook marks the domain verified |

## 2. Correct live site copy that the code contradicts

Found while writing the GitBook docs (2026-09-13). Each claim is checked against the contracts before
it is rewritten; nothing is softened into something vaguer than the truth.

| Live claim | What the code does | Fix |
|---|---|---|
| An unfilled week returns the collateral whole / "the tokens come back" | Valorem assigns exercises across **all writers of the same option series** by bucket (`AdapterValorem.sol` header; recon R4). If other writers' calls on that series are exercised, the vault's claim can be assigned even though its own listing never sold: zero premium, and tokens leave at the strike | say so plainly on `/`, `/how-it-works`, `/risks`, and in the FAQ-style copy; keep it in the risk disclosure |
| The guardian can close the week after expiry | the keeper closes from expiry; **anyone** can close one hour after expiry (`Vault.rollClose`); the guardian has no close power | rewrite to "anyone can close it an hour after expiry" |
| An oracle pause stops settlement | the feed is read only to gate writes and listings; settlement never reads it. An issuer freeze does stop settlement, because `rollClose` moves NVDA | separate the two |
| Deposit cap "20–50 NVDA" | `Deploy.s.sol` `LAUNCH_DEPOSIT_CAP = 20e18` | 20 NVDA |

Done when: site builds, copy-lint passes, the four statements are gone from the live site after a
redeploy, and the matching wording is consistent with `leekzor/callhouse-docs`.

## 3. Contracts on GitHub, app pinned to them

| Step | Done when |
|---|---|
| 3.1 Rebase the 8 local commits onto GitHub `main` (`2a9bb59`); resolve conflicts in `README.md`, `SECURITY.md`, `docs/AUDIT-SCOPE.md` keeping both the domain/contact changes and the fix records | clean rebase |
| 3.2 Re-run `forge fmt --check`, unit + invariant, fork suite, `forge build --sizes`; re-run the deploy rehearsal | 319/319, 21/21, rehearsal PASSED |
| 3.3 Push `callhouse-contracts` (fast-forward only, no force) | GitHub CI green |
| 3.4 Bump the app's `contracts/` submodule; confirm `ops/abis/Vault.json` still equals the build; re-run keeper tests and the keeper dry run through the submodule | dry run PASSED |
| 3.5 Update app docs that the scripts changed: `ops/safes.md` §7 (renounce happens through `HandoverAdmin.s.sol`, bootstrap plan), `tasks.md`, `HANDOFF.md` | committed |

## 4. App code before the vault goes live

| Item | Scope | Done when |
|---|---|---|
| 4.1 CI | remove the duplicate pnpm version in `.github/workflows/ci.yml` | app CI green |
| 4.2 W-21 assigned-week labels | indexer API and web separate premium from strike proceeds (`RollClose.usdgFromAssignment`); "realized", "gross premium", "net", per-share figures use premium only; strike proceeds shown as their own line | fixtures + tests updated; an assigned week shows premium and strike proceeds separately |
| 4.3 K-21 keeper observability | persist `assetsReturned` and `usdgFromAssignment` per cycle; `/cycles` exposes them; the `roll_close` alert on an assigned week names strike proceeds and premium separately | keeper tests; dry run cycle 3 alert wording |
| 4.4 Premium floor margin | keeper lists at `floor × (1 + PREMIUM_MARGIN_BPS)`; default **0** (today's behaviour) so the owner decides the number; documented | config + tests |
| 4.5 Indexer deployable | `indexer/Dockerfile`, `indexer/railway.json`, Postgres via `DATABASE_URL`, health check, runbook section in `ops/deploy.md` | `docker build` passes and the container starts against a local Postgres |
| 4.6 X-11 indexer against a fork | script that runs the dry-run fork, points the indexer at it, and asserts API tables against chain state | script passes |
| 4.7 L-09 alert relay | small service that accepts the keeper's JSON webhook and posts to Discord/Telegram; no secrets in code; Dockerfile + `railway.json` | unit tests + a local end-to-end POST |
| 4.8 K-22 dry-run gaps | extend `keeper/src/dryrun.ts` or add harnesses for: `index.ts` loop + SIGTERM, multiple exercisers, guardian/anyone `rollClose`, cancel / partial fill / relist budget | each gap either covered by a passing run or recorded as still open with the reason |
| 4.9 W-13 web acceptance on a fork | web served against the fork + indexer: deposit, queue, claim, and a fill from the keeper's `/orders` payload; what cannot be automated without a real wallet UI is listed | script/test passes; remaining manual steps written down |

Part 4 does **not** deploy `web`, `keeper` or `indexer` to Railway: there is no vault address yet
(part 6).

---

## 5. External audit — decision and plan (owner)

Recommendation: audit before real deposits, even at the 20 NVDA cap. The 2026-09-13 review found two
real defects without an auditor, one of which (lot size) let a third party drain up to ~44% of the book
in a proof of concept.

1. Choose an auditor and a window. Scope and everything they need is `callhouse-contracts/docs/AUDIT-SCOPE.md` (properties P-01…P-28, known issues, build steps).
2. Freeze: tag the engagement commit `audit-<date>` in `callhouse-contracts`; point the app's submodule at the tag.
3. During the engagement: no contract changes except auditor-requested fixes, each with a regression test that fails before the fix.
4. Triage every finding in `SECURITY.md`; re-tag `audit-<date>-fixes`; re-run the full gate and the deploy rehearsal on the final tag.
5. Publish the report location in `SECURITY.md` and on the site's risk page.
6. Bug bounty (E-07): draft during the audit, open in mainnet week 2.

If the owner decides to launch without an audit, record the decision and date in `SECURITY.md` and on
`/risks`, and keep the cap at 20 NVDA until one is done.

## 6. Mainnet deploy — plan (owner-run, rehearsed)

Runbook: `callhouse-contracts/docs/DEPLOY.md`, path A (bootstrap admin: the deployer key is admin until
the handover). Rehearsed end to end on a fork with negative checks.

1. **Prepare**: audited tag checked out and built; `rm -rf ~/.foundry/cache/rpc/4663`; deployer key
   funded (~7.6M gas + configure); keeper key and guardian key generated (guardian on separate
   hardware); fee Safe created in Safe{Wallet} on Robinhood Chain; Blockscout proxy running.
2. **Deploy** with `ADMIN = deployer`, `--no-storage-caching`, verify source. Record vault, both
   library addresses, deploy block.
3. **Verify** (`ADMIN_PHASE=bootstrap EXPECT_KEEPER_CONFIGURED=false`) → **Configure** with the deployer
   key → **Verify** again.
4. **Wire the app**: `ops/addresses.json` (add `valoremLib`); submodule at the deployed tag;
   `ops/abis` + `pnpm gen:abis`.
5. **Railway services** in project `callhouse`:
   - `indexer` + Postgres plugin: `VAULT_ADDRESS`, `START_BLOCK`, RPC; health check.
   - `keeper`: volume at `/data`, `PORT=8787`, `KEEPER_PK` as a runtime variable only, RPCs,
     `ALERT_WEBHOOK` → the relay; one replica.
   - `relay`: Discord/Telegram target as a runtime secret.
   - `web`: every `NEXT_PUBLIC_*` as a build variable before the first build
     (`NEXT_PUBLIC_VAULT`, `NEXT_PUBLIC_VAULT_FROM_BLOCK`, `NEXT_PUBLIC_API_URL` = indexer URL).
   - Connect each service to `leekzor/callhouse` with its `railway.json` path.
6. **DNS**: `app.callhouse.finance` CNAME to the web service target (DNS only); indexer on a Railway
   domain or `api.` if the web app needs a stable name.
7. **Monitors**: keeper `/health`, indexer health, site, app — external uptime checks alerting the same
   channel as the relay. Test the webhook end to end.
8. **First listing (L-04)**: one real 1-contract Overcall listing to confirm Overcall's validator accepts
   the vault's EIP-1271 signature. If it fails, the self-hosted fill page on `/vault/nvda/cycle` is the
   fallback.
9. **Open**: deposit cap 20 NVDA; publish every weekly result including "unfilled, 0" (L-10..13) before
   raising the cap.

Stop conditions at any step: a Verify FAIL, a preflight revert, a keeper alert the runbook does not
explain, or a listing Overcall rejects.

## 7. Admin handover to the Safe — plan (owner)

Runbook: `callhouse-contracts/docs/DEPLOY.md` A4; script `script/HandoverAdmin.s.sol`.

1. Create the admin Safe: 2 of 3, owners on hardware, no modules, no guard (Verify checks all of these).
2. `STEP=grant`: grants `DEFAULT_ADMIN_ROLE` to the Safe; prints `GRANT_NONCE`; writes the smoke batch.
3. The Safe imports and executes the smoke batch (`setMaxPriceAge` to its current value) in Safe{Wallet}.
4. `STEP=renounce` with `GRANT_NONCE`: refused until the Safe has executed a transaction after the grant.
5. `Verify.s.sol` with `ADMIN_PHASE=safe` and `EXPECT_SAFE_OWNER_SET` = the three owners.
6. Record the grant, smoke and renounce transactions in `SECURITY.md` and on the docs site's roles page;
   remove the "one key holds every admin power" warning.

Until step 6, the deployer key holds every admin power. Keep it offline and use it only for the steps
in part 6.
