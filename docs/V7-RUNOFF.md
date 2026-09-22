# v7 run-off — the deployment pin

**This is the app-repo, deployment-half document.** It is *not* the contracts-side
`callhouse-contracts docs/V7-RUNOFF.md`, which is the authority on what the freeze calls do and what
a v7 holder can still do afterwards. This file answers one narrower question that the contracts side
does not: **what keeps the v7 indexer and cranker running while the run-off is open.**

The operator procedure is `ops/runbooks/v7-runoff.md` §9. This file holds the pin that procedure
reads, and `ops/go-live-v2.sh` refuses to deploy against it while the run-off is open.

---

## The gap this closes

Draft-3 row 13 says v7 does not move under a legacy route the way v1 did: the v7 indexer and cranker
**keep running from their v7 images**, reading the frozen `ops/markets/v7-legacy.json`.

The code half of that is done and holds at this SHA:

| Claim | Where it is enforced |
|---|---|
| the frozen registry is the v7 one | `ops/runbooks-v7-runoff.test.mjs:80-81` asserts `v2.interfaceVersion === 7` and a positive `deployBlock` |
| the builder will not touch it | `ops/markets/build-markets.mjs:214-215`, and again at `:1643` |
| one process never serves both versions | `keeper/src/v2/registry.ts:573-585` — a v8 keeper handed a v7 registry raises `V2RegistryError` and refuses **totally** |

The deployment half is **not** done, and it is worse than "unfinished":

1. **Nothing pins an image.** Every `railway.json` in this repo builds from source
   (`"builder": "DOCKERFILE"`); not one carries an `image`, a tag or a digest. `ops/go-live-v2.sh`
   takes `--ref <reviewed-SHA>`, which selects what to *build*, not what is *already running*.
2. **There is no separate v7 service.** Searching this repo for `indexer-v7`, `cranker-v7`,
   `v7-indexer` or `v7-cranker` returns nothing. The services that run v7 today are
   **`indexer-v2` and `cranker`** — `ops/deploy.md:1584` probes exactly those and records
   `{"status":"ok",…,"interfaceVersion":7}` coming back from `indexer-v2`.
3. **Those are the same service names v8 deploys into.** `ops/go-live-v2.sh:104` has
   `DEFAULT_SERVICES="relay indexer-v2 pricing notifier monitor"` and `cranker` is in its ordered
   service list. So the v8 cutover redeploys, in place, the two services the run-off depends on.

So "the v7 bots keep reading it from their own v7 image" currently describes an image that nothing
holds still, on a service name the cutover is about to overwrite.

## What happens today if the v7 image is rebuilt from a newer main

The keeper refuses and **exits**; it does not degrade:

> `v2.interfaceVersion: 7, but this keeper implements INTERFACE_VERSION 8. ops/markets/v7-legacy.json
> is the frozen v7 registry and is read by the v7 run-off image, not by this one`
> — `keeper/src/v2/registry.ts:579-584`

That refusal is correct and it is loud, which is the good news: a v8 cranker pointed at the v7
registry dies at startup rather than half-cranking a set it cannot price. The bad news is what it
means operationally — **the v7 cranker stops**. Expired v7 series then have nobody to settle them,
and holders cannot exercise, for as long as it takes someone to notice a service that is failing its
healthcheck rather than serving wrong data.

A redeploy of `indexer-v2` is the same shape one step earlier: the v8 indexer ingests against v8
schema and contracts, and the v7 read surface the run-off needs stops being served.

**What the pin prevents:** `ops/go-live-v2.sh` refuses to deploy `indexer-v2` or `cranker` while
`runoff_open` below is `yes`. It does not — and cannot — stop a Railway-side redeploy, a git push
that trips `watchPatterns`, or a hand-typed `railway up`. Those remain owner discipline, and §9 of
the runbook says so in the same words. What the pin buys is that the one automated path that would
do it silently now stops and says why.

---

## The pin

Fill every field **before** the v8 cutover, from Railway, and commit the result. Every value is a
fact this repository cannot derive: it has to be read off the running deployment.

**An unfilled field is not "unknown", it is a REFUSAL.** The gate fails closed: a missing file, a
missing field, an empty field or a malformed block all refuse, exactly as a `yes` would. That is
deliberate — the failure this exists to prevent is a check that passes because it could not see its
subject.

```v7-pin
project_id: 9988a803-0b8f-4b0e-8ada-ba71e5a505ae
environment_id: 319fcb44-0e25-4367-947c-09351a349d2e
indexer_service: indexer-v2
indexer_service_id: b12fe972-623a-4348-8788-e5cfdcaf5411
indexer_commit: e422163b7edbb3f84b88534a97f33902986bd32d
indexer_image_digest: railway-deployment:3b9b1011-55c7-4aa9-bc1e-83b959852b03
cranker_service: cranker
cranker_service_id: 42bf9281-c7f8-49fb-801d-6aeb2616434c
cranker_commit: e422163b7edbb3f84b88534a97f33902986bd32d
cranker_image_digest: railway-deployment:0965a3bc-5421-47fd-95ef-df677a19a4aa
runoff_open: no
released_by: Claude (session robinhood-dev-ab) on the owner's instruction of 2026-09-22 ~03:00 PDT to cut production over to v8
released_at: 2026-09-22T09:56:12Z
```

**Release record (2026-09-22).** Read before the cutover, all from the running deployment:
`railway` GraphQL `deployments` for both services report the same build commit `e422163b` (public main
of 2026-09-18) and deployments `3b9b1011…` / `0965a3bc…` dated 2026-09-18T05:54:31Z. Railway exposes no
image digest for a Dockerfile build, so the immutable deployment id is recorded in its place, labelled
as such. Run-off state: the v7 indexer (`indexer-v2-production-7867.up.railway.app`) reported
`interfaceVersion 7`, `/v2/cards` empty, `/v2/stats` one holder, `volumeAll` 0.14 USDG; the last
transaction to the v7 Clearinghouse `0x22dEf851…` was `settle(uint256)` + `sweepFees(address)` at
2026-09-18T20:02Z (Etherscan v2, chainid 4663). Every v7 series was settled; nothing was open to strand.
The contracts-side `FreezeV7` calls were NOT sent as part of this release (they sign; owner-gated).

Field by field:

| Field | How to read it | Why it is here |
|---|---|---|
| `project_id`, `environment_id` | `railway status --json` | a pin that does not name its environment can be satisfied by the wrong one |
| `indexer_service`, `cranker_service` | the service **names** `ops/go-live-v2.sh` would deploy | these are what the gate matches against `--services` |
| `*_service_id` | `railway service list --json` | names are editable in the Railway UI; ids are not |
| `*_commit` | the commit the current deployment was built from | this is the actual "image pin": the thing a rebuild would change |
| `*_image_digest` | the deployed image digest Railway reports | proves the running image is the one that commit produced, not a later rebuild of the same ref |
| `runoff_open` | `yes` until the run-off is finished | the switch the gate reads |
| `released_by`, `released_at` | who closed the run-off, and when | required when `runoff_open: no`; an unattributed release is refused |

### Checking it

```sh
ops/go-live-v2.sh --check-v7-pin          # reads docs/V7-RUNOFF.md, exits 0 clean / 1 refused
V7_PIN_FILE=/path/to/copy ops/go-live-v2.sh --check-v7-pin
```

**Worked:** `v7 pin: run-off OPEN; indexer-v2 and cranker are pinned` and exit 0, or, after release,
`v7 pin: run-off CLOSED by <name> at <ts>` and exit 0.

**Failed:** a `v7 pin:` line naming the exact field, and exit 1. The ones you will actually see:

| refusal | meaning |
|---|---|
| `docs/V7-RUNOFF.md not found` | the pin file is gone. The gate refuses rather than treating an absent pin as an open road |
| `no \`\`\`v7-pin block` | the block was renamed or reformatted |
| `indexer_commit is empty` | the pin was committed as a template and never filled in |
| `runoff_open must be yes or no, got ""` | same |
| `runoff_open is no but released_by is empty` | somebody flipped the switch without signing it |
| `cannot deploy cranker while the v7 run-off is open` | the gate did its job — this is the whole point of the file |

### Releasing the pin

When the run-off is genuinely over — every v7 series settled, per the contracts-side document's
"when the run-off ends" — set `runoff_open: no`, fill `released_by` and `released_at`, and commit.
Only then will `ops/go-live-v2.sh` deploy `indexer-v2` or `cranker`.

Do not release it by deleting the file or the block. Both refuse, on purpose.
