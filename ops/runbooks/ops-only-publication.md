# Ops-only publication packet — production monitor (O8-05)

Owner-run. Local commits only until the owner publishes. This packet names files, never values.
It is the small publication path GO-LIVE-V7-SERVICES.md §4 row 21 asked for, so a production
monitor can be created from a public SHA without waiting for the long R1 release train.

Nothing here deploys, pushes, or reads a secret. The owner steps themselves are `OWN8-02`.

---

## 0. What the 3-series already covered

Do not redo these. O8-05 only closed what was still open.

| Task | State in this tree | What it already did | What was still open for O8-05 |
|---|---|---|---|
| O3-004 | done | Relay required only for pricer / mm-bot / monitor. `MONITOR_HEALTH` from selected ∪ existing. Signing bots refused on stonkhouse-dev. **Dev** `DEFAULT_SERVICES` is already keyless. | **Prod** `DEFAULT_SERVICES` still included `cranker` and `pricer`. Closed here. |
| O3-006 | done | `ops/runbooks/relay-monitor-go-live.md` and `ops/v2/test-alert.mjs` (rehearsal / local fake). | Production monitor still blocked by publication + env-equality. Closed here. |
| O3-401 | done | `go-live-v2.sh` sets `NOTIFIER_PUBLIC_URL` only when `SMTP_URL` is already on the service (`var_is_set`; a failed Railway read means "not set"). Tests in `ops/go-live-v2.test.mjs`. | Renderer comments still named the URL; a live assignment would still crash-loop. Guarded here. Leave `SMTP_URL`, `EMAIL_FROM`, `NOTIFIER_PUBLIC_URL` all unset. |
| O3-404 | still open | Notifier go-live runbook. Not this task. | Out of scope. |
| O3-405 | done | `ops/v2/notifier-smoke.mjs`. | Out of scope. |

---

## 1. Why a production monitor could not be created

Production builds from public `origin/main`. The private script against a public SHA was
refused because `ops/v2/env/pricer.env` differed by one comment line (`go-live-v2.sh` used
to `diff -qr` the whole env directory). Public `go-live-v2.sh` also had no `monitor` service
and public `ops/deploy.md` had no §15.

Two independent unblocks, both now in this tree:

1. **Selected-service env equality** (`ops/v2/env-equal.mjs`). `--apply --services monitor`
   compares assignment lines of selected services only. Comment-only drift in `pricer.env`
   no longer refuses a monitor. Assignment drift in a selected service still refuses.
2. **This packet.** Publish the files below onto public `main` so the owner can run from a
   checkout at the **same SHA** as `--ref` (the script's existing rule).

Path (1) lets the private script create a production monitor from a public SHA whose image
already ships `ops/v2/monitor.mjs` (keeper Dockerfile + `.dockerignore` exception). Path (2)
is what the owner should still do, so the next operator is not running a private script
against a public SHA.

---

## 2. Minimal file list for public `main`

Publish these as one ops-only commit (no indexer, web, keeper behaviour, no registry
addresses). Generated env files stay generated: change the renderer, re-run
`node ops/v2-env.mjs`, commit the result; never hand-edit them.

| Path | Why the production monitor needs it |
|---|---|
| `ops/go-live-v2.sh` | `monitor` in the service table; volume, start command, gating, keyless default set |
| `ops/v2/go-live-gating.mjs` | `ORDER` includes `monitor`; `MONITOR_HEALTH` owner |
| `ops/v2/env-equal.mjs` | selected-service env equality (this packet) |
| `ops/v2/monitor.mjs` | the process the keeper image runs as `monitor` |
| `ops/deploy.md` §15, especially §15.12 | the documented create path; public had no §15 |
| `ops/runbooks/relay-monitor-go-live.md` | owner commands, names only |
| `ops/runbooks/ops-only-publication.md` | this file |
| `.dockerignore` | `!ops/v2/monitor.mjs` (already on both refs); **`!ops/markets/dev.json`** is for **dev** pricing/monitor, not prod, but publish it in the same packet so a later public SHA can deploy those too |
| `ops/v2/env/*.env` and `ops/v2-env.mjs` | only required if you deploy a service that has a generated env file, or if a future check restores whole-dir equality. The historic refuse was one comment line in `pricer.env` (`PRICER_REPRICE_OFF_HOURS`) |

Already identical on public `main` at the packet's writing, so do not wait on them: `keeper/Dockerfile` (copies `ops/markets/${V2_REGISTRY_FILE}` and `ops/v2/monitor.mjs`), `relay/Dockerfile`, `notifier/Dockerfile`.

Do **not** put `ops/v2/env-dev/*`, bot key files, or any `.env` with a value in this packet.

### 2a. The list, in a form the script can check

The table above is prose and prose drifts. The block below is the same packet in a form
`ops/go-live-v2.sh --check-public-ref` reads, so "is the monitor creatable from public `main`?" is a
command rather than a memory. **Edit the block and the table together** — the block is what the
check uses.

Only `core` and `monitor` are specified: this packet is about the production monitor. The check
**refuses** for any other service rather than passing it, because a service with no list is a
question nobody has answered, not a service with nothing to publish.

```publication-manifest
core: ops/go-live-v2.sh ops/v2/go-live-gating.mjs ops/v2-env.mjs .dockerignore ops/deploy.md
monitor: ops/v2/monitor.mjs ops/v2/env-equal.mjs ops/runbooks/relay-monitor-go-live.md ops/runbooks/ops-only-publication.md
```

```sh
ops/go-live-v2.sh --check-public-ref --services monitor          # against origin/main
PUBLIC_REF=origin/main ops/go-live-v2.sh --check-public-ref --services monitor
```

**Worked:** `public ref <sha> (<date>): every path the monitor packet needs is present`, exit 0.

**Failed:** one `REFUSED: public ref:` line naming every absent path, exit 1 — which is the state
today, and §2b says what that looks like.

The check reads the **local remote-tracking ref** and never fetches: a worker does not call off this
machine. So it is only as current as your last `git fetch origin`, and it prints the ref's SHA and
commit date on every run so you can see for yourself how old that is. A ref it cannot resolve is a
refusal, not a pass.

### 2b. What a production monitor creation attempt does today

Re-derived 2026-09-21 against the local `origin/main` at
`e422163b7edbb3f84b88534a97f33902986bd32d` (committed 2026-09-17 22:54:29 -0700):

```
ops/go-live-v2.sh --apply --services monitor --ref e422163…
  REFUSED: unknown service 'monitor' (one of: relay indexer-v2 pricing cranker pricer mm-bot notifier web)
```

That refusal comes from `ops/go-live-v2.sh:175` **on the public ref**, where `ORDER` is a hard-coded
string (line 82) that does not contain `monitor`. The public script is 815 lines; the private one is
1141 and derives `ORDER` from `ops/v2/go-live-gating.mjs`, which is itself not published.

The good news is that this fails **loudly and immediately**, before any Railway call. What it is not
is a near miss:

| Path | At `origin/main` |
|---|---|
| `ops/go-live-v2.sh` | present but **differs** — 815 lines, no `monitor` in `ORDER` |
| `ops/v2/go-live-gating.mjs` | **absent** (the private script's `ORDER` and `MONITOR_HEALTH` owner) |
| `ops/v2/env-equal.mjs` | **absent** |
| `ops/runbooks/relay-monitor-go-live.md` | **absent** |
| `ops/runbooks/ops-only-publication.md` | **absent** (this file) |
| `ops/v2/monitor.mjs` | **present** but differs — 4055 lines public vs 6462 private |
| `ops/deploy.md`, `.dockerignore`, `ops/v2-env.mjs` | present, differ |
| `keeper/Dockerfile`, `relay/Dockerfile`, `notifier/Dockerfile` | **identical** — §2's claim still holds |

`ops/v2/monitor.mjs` being present is the trap this row exists to name. Someone asking "is the
monitor public?" gets **yes**, and concludes the blocker is gone. The process file is public; the
path that *creates the service* is not, and neither is the gating module the current script cannot
start without.

**Correction to §2:** that table lists `ops/v2/go-live-gating.mjs` as needed but reads as though only
`env-equal.mjs` were outstanding. Both are absent, and `go-live-gating.mjs` is the harder blocker —
without it the private script cannot even compute its service list.

**Publication remains the owner's action.** Nothing in this repository can perform it, and no row
should try: `ops/go-live-v2.sh:73` points production at `stonkhousedotfun/callhouse`, and pushing
there is owner-gated. What this row adds is that the packet is now checkable in one command, so the
owner can confirm the publication worked instead of assuming it.

---

## 3. How to run, after publication

From a checkout at the published SHA. Always pass `--services`. `--ref` is the full
40-character SHA of that same commit. Railway CLI ≥ 5.47.2. Project ids (names only):
production `callhouse` `9988a803-0b8f-4b0e-8ada-ba71e5a505ae` / env `319fcb44-0e25-4367-947c-09351a349d2e`.
Dev `stonkhouse-dev` `d8952b22-6bd8-4fd7-984a-7868ee353879` / env `a87aa3a2-1c68-41e7-9866-d0e72810035b`.

```bash
# production, keyless, in order. Dry run first, then --apply.
ops/go-live-v2.sh --services relay --ref <SHA>
ops/go-live-v2.sh --apply --services relay --ref <SHA>
ops/go-live-v2.sh --services monitor --ref <SHA>
ops/go-live-v2.sh --apply --services monitor --ref <SHA>
ops/go-live-v2.sh --services pricing --ref <SHA>
ops/go-live-v2.sh --apply --services pricing --ref <SHA>
ops/go-live-v2.sh --services notifier --ref <SHA>
ops/go-live-v2.sh --apply --services notifier --ref <SHA>
```

Dev form of any run: add `--project <stonkhouse-dev-id> --environment <dev-env-id>`. Notifier
and web also need `--notifier-domain` with the approved hostname. A bare `--apply` now deploys
the keyless set only (`relay indexer-v2 pricing notifier monitor`); still pass `--services`.

Until the packet lands on public `main`, the private script against a public SHA that already
ships `ops/v2/monitor.mjs` can `--apply --services monitor` without the historic `pricer.env`
comment refusal. Still run from a checkout at that SHA.

---

## 4. Remaining owner inputs, names only

Never paste a value into a chat, a file, or a command line. The script takes each at a hidden
prompt (`ops/go-live-v2.sh`).

| Name | Who supplies it | Service |
|---|---|---|
| `RELAY_TOKEN` | owner, `openssl rand -hex 32`, ≥ 32 characters, seal it | relay |
| `DISCORD_WEBHOOK_URL` | owner, Discord channel webhook. The URL path is the credential | relay |
| or `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | owner, an **operator** bot from @BotFather, added to the chat first | relay |
| `NOTIFIER_DATA_KEY` | owner, `openssl rand -hex 32`, **offline copy in the password manager** | notifier |
| `TELEGRAM_BOT_TOKEN` | owner, a **new user-facing** bot per environment. Never the relay's bot | notifier |
| `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY` | owner, one `npx web-push generate-vapid-keys` pair per environment | notifier |
| notifier hostnames | owner. Plan default: `dev-notify.stonkhouse.fun` / `notify.stonkhouse.fun` | notifier |
| `SMTP_URL`, `EMAIL_FROM`, `NOTIFIER_PUBLIC_URL` | **leave all three unset** | notifier |

Decisions only the owner can make (GO-LIVE-V7-SERVICES.md §1.1), still open:

- A — operator alert target (Discord webhook, Telegram bot + chat, or both)
- B — whether production pricing goes on before the app labels fair value as delayed
- C — notifier hostnames
- D — two Telegram bot usernames (dev, production)
- E — accept the monitor's known standing pages (KeeperRewards / MakerVault at 0; services that do not exist until v8)
- F — cranker redeploy so `ALERT_WEBHOOK` reaches the live relay (signing-bot redeploy, outside close ±20 min America/New_York)

---

## 5. What this packet does not do

- No Railway contact, no deploy, no push, no live transaction.
- No cranker, pricer, or mm-bot. Name them explicitly after v8 if they are wanted.
- No email channel. All three of `SMTP_URL` / `EMAIL_FROM` / `NOTIFIER_PUBLIC_URL` stay unset.
- No DNS records. The script prints CNAME and `_railway-verify` TXT; the owner adds them, DNS only.
- O3-404 (notifier go-live runbook) remains a separate task.
