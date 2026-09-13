# Runbook — Deploy the frontend

**What this is.** How the dapp (`app.callhouse.xyz`) gets onto Railway, what every setting means,
and the three things that go wrong. Contracts, keeper and indexer are not covered here. The
landing (`callhouse.xyz`) deploys from its own repository, `leekzor/callhouse-site`, and that
repository's README is its runbook.

**Who runs it.** Anyone with write access to the Railway project. Nothing in this runbook touches
a private key, signs a transaction, or can move a token. The worst outcome of getting it wrong is
a page that lies about which contract it is pointed at — which is bad enough, so read §3.

**Time budget.** 30 minutes for the first setup, including DNS propagation. Two minutes for a
redeploy.

---

## 0. The shape of it

```
callhouse.xyz          ->  Railway service "site"  ->  leekzor/callhouse-site (its own repo,
                           its own Dockerfile and build context). Not covered here.

app.callhouse.xyz      ->  Railway service "web"   ->  web/Dockerfile   ->  web/server.js
                           The dapp, every route unchanged. wagmi + viem, one server route
                           (/api/overcall/listings).
```

One frontend service in this repository, **one build context: the repo root**. `web/Dockerfile`
copies `pnpm-lock.yaml`, `pnpm-workspace.yaml` and every workspace member's `package.json` before
it installs, because the lockfile is workspace-wide. This is why the Root Directory setting in §1
is not negotiable.

Nothing is shared between the two domains at runtime. No cookie, no session, no CORS grant, no
shared origin. Every "go and do something" control on `callhouse.xyz` is a plain absolute link to
`https://app.callhouse.xyz/...`, which is the whole reason the split is cheap.

`web/railway.json` carries no comments — JSON has none. This file is its documentation. If you
change that file, change this one.

---

## 1. Railway service settings

Create the `web` service from this GitHub repository. (The `site` service's source is
`leekzor/callhouse-site`; its settings are in that repository's README.)

| Setting | `web` |
|---|---|
| Service name | `web` |
| Source → Repo | this repo |
| Source → Branch | `main` |
| **Source → Root Directory** | **empty (repo root)** |
| Settings → Config-as-code path | `web/railway.json` |
| Builder | `DOCKERFILE` (from railway.json) |
| Dockerfile path | `web/Dockerfile` (from railway.json) |
| Public networking | enabled, port 3000 |

**Root Directory must stay empty.** It is the single setting people get wrong. Setting it to
`/web` makes Railway use `web/` as the build context, `pnpm-lock.yaml` and `pnpm-workspace.yaml`
are then outside the context, and the install either fails or silently resolves a different tree.

`dockerfilePath` inside each `railway.json` is resolved **relative to the Root Directory**. Root
Directory empty + `"dockerfilePath": "web/Dockerfile"` is a consistent pair. If you ever move the
root, both halves move together.

### Watch paths

`web` and `keeper` (§10) watch the same repository, so without a filter every push rebuilds both.
Each `railway.json` declares `build.watchPatterns`:

```
web:   web/**    scripts/**  package.json  pnpm-lock.yaml  pnpm-workspace.yaml
```

A lockfile change rebuilds both. That is correct: a workspace install feeds both images.

---

## 2. First deploy, in order

Do these in order. Step 2 before step 3, or the first image is built with an empty configuration
and you will deploy a page pointed at nothing.

1. **Confirm the workspace is coherent.** `keeper`, `indexer` and `web` must be listed in
   `pnpm-workspace.yaml`, and `pnpm-lock.yaml` must have been regenerated and committed after the
   last change to that list. Verify locally:

   ```bash
   pnpm install --frozen-lockfile     # must succeed with no lockfile update
   ```

   If that command wants to modify the lockfile, **stop**. The `web` and `keeper` Docker builds
   run `pnpm install --frozen-lockfile` and both will fail with "lockfile is not up to date".

2. **Set every variable** from §3 on the service, before triggering a build.

3. **Deploy.** Push to `main`, or Railway → service → Deploy.

4. **Verify** with §5.

5. **Attach the domains** (§4). Do this after a deploy is healthy, so a DNS failure is
   distinguishable from an application failure.

---

## 3. Environment variables

The split below is the most important thing in this file.

> **`NEXT_PUBLIC_*` is compiled into the JavaScript by `next build`. It is not read at runtime.**
> Railway passes a service variable into a Dockerfile build **only if the Dockerfile declares it
> as an `ARG`** — every one of them is declared, in the builder stage, before `next build`. A
> variable that is not declared is silently absent at build time: the container still starts, the
> healthcheck still passes, and the page serves the wrong configuration.
>
> **Changing any of these requires a REBUILD, not a restart.**

The `site` service's variables are documented in `leekzor/callhouse-site`; the rule above applies
to it identically.

### `web` — build-time

| Variable | Value | If unset |
|---|---|---|
| `NEXT_PUBLIC_VAULT` | the deployed vault, from `ops/addresses.json` → `chains.4663.ours.vault` | **No default, deliberately.** Every page renders a "not configured" notice. This is the intended pre-deploy state, not a bug |
| `NEXT_PUBLIC_CHAIN_ID` | `4663` | Dockerfile ARG default `4663`. **Never set this to an empty string** — `lib/chain.ts` uses `??`, which does not treat `""` as missing, and the app would compile chain id `0` |
| `NEXT_PUBLIC_RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | ARG default, same value. Primary — archive reads and full-range `eth_getLogs` work here |
| `NEXT_PUBLIC_RPC_URL_2` | `https://robinhood-rpc.publicnode.com` | ARG default, same value. Backup — rejects old-range `eth_getLogs` |
| `NEXT_PUBLIC_EXPLORER_URL` | `https://robinhoodchain.blockscout.com` | ARG default, same value. Links only; nothing fetches it |
| `NEXT_PUBLIC_API_URL` | the deployed indexer's public URL | ARG default is `http://localhost:42069`, which is wrong in production. Every history panel reads "unavailable" and `/activity` falls back to a direct log scan. Degraded, not broken — **set it** |
| `NEXT_PUBLIC_ASSET` | leave unset | `lib/contracts.ts` carries the explorer-confirmed address. Blank is the intended value |
| `NEXT_PUBLIC_USDG` | leave unset | as above |
| `NEXT_PUBLIC_REGISTRY` | leave unset | as above — and the compiled-in default is the **NVDA** registry, not the JUGGERNAUT one. Setting this by hand is how you point the UI at the wrong market |
| `NEXT_PUBLIC_CLEARINGHOUSE` | leave unset | as above |
| `NEXT_PUBLIC_SEAPORT` | leave unset | as above |
| `NEXT_PUBLIC_VAULT_FROM_BLOCK` | the vault's deploy block | Falls back to `0`. Only makes `/activity`'s fallback scan cheaper |
| `NEXT_PUBLIC_SITE_URL` | `https://callhouse.xyz` | ARG default, same value |
| `NEXT_PUBLIC_APP_URL` | `https://app.callhouse.xyz` | ARG default, same value. Used as `metadataBase` |

The five address variables are left blank on purpose. `lib/contracts.ts` owns those values,
`ops/addresses.json` carries the evidence for each one, and a second copy in the Railway UI is a
second thing to drift. Override one only for a fork or a rehearsal deploy.

`web/.env.example` is the authoritative list of what this package reads. If it grows a variable,
`web/Dockerfile` needs the matching `ARG`/`ENV` pair or the new variable will not exist in the
build.

### `web` — runtime

| Variable | Value | Notes |
|---|---|---|
| `OVERCALL_API_BASE` | `https://overcall.finance` | **Server-side, read per request** by `app/api/overcall/listings`. It is not a build ARG and must not become one. Change it and **restart** — no rebuild needed. Leave it unset and `route.ts` uses the same default |
| `PORT` | — | Injected by Railway. `server.js` reads `process.env.PORT`, which wins over the Dockerfile's `ENV PORT=3000`. Do not set it by hand |

That proxy exists because overcall.finance sends no CORS headers, so the browser cannot call it
from our origin. It is GET-only and takes no auth of any kind.

---

## 4. Custom domains

Attach in Railway → service → Settings → Networking → Custom Domain. Railway gives you a target
hostname of the form `<something>.up.railway.app`. Then create the DNS records.

### `app.callhouse.xyz` — the easy one

A subdomain. Plain `CNAME`, works at every registrar.

```
Type   Name   Value
CNAME  app    <target>.up.railway.app
```

TLS is issued by Railway automatically once the record resolves. Expect a few minutes.

### `callhouse.xyz` and `www` — the landing's records, documented with the landing

The apex and `www` attach to the `site` service, and the full step is in the
`leekzor/callhouse-site` README. Two facts are repeated here because they live in the same DNS
zone as the record above: **a `CNAME` at the apex is not valid DNS**, so the apex needs
`ALIAS`/`ANAME` or Cloudflare's CNAME flattening, never an A record pinned to an IP you resolved
yourself; and `www.callhouse.xyz` redirects to the apex, 301, at the DNS/CDN layer.

---

## 5. Healthchecks, and how to verify a deploy

`web/railway.json` declares:

```json
"healthcheckPath": "/", "healthcheckTimeout": 120,
"restartPolicyType": "ON_FAILURE", "restartPolicyMaxRetries": 10
```

**A healthcheck that times out almost always means the server is bound to the wrong interface.**
Next's standalone server binds `127.0.0.1` unless `HOSTNAME` says otherwise; inside a container
that means nothing outside the container can reach it, and Railway reports a timeout that reads
like a slow boot. `web/Dockerfile` sets `ENV HOSTNAME=0.0.0.0` for exactly this reason. If you are
debugging a failing healthcheck, confirm that line survives before you look anywhere else.

The second cause is a `PORT` mismatch: Railway injects `$PORT` and probes it, and `server.js` reads
`process.env.PORT`. Do not override `PORT` in the service variables.

### Verify

```bash
# 1. The host answers.
curl -sI https://app.callhouse.xyz/        | head -1     # HTTP/2 200

# 2-4. The landing's checks (no wallet code, absolute CTAs into the app, its four routes)
#      moved with the landing to the leekzor/callhouse-site README.

# 5. THE ONE THAT MATTERS: which vault did this image get baked with?
curl -s https://app.callhouse.xyz/vault/nvda | grep -oiE '0x[0-9a-f]{40}' | sort -u
```

Take the addresses from step 5 and diff them against `ops/addresses.json`. If the vault address is
absent, the page will be showing "not configured" and `NEXT_PUBLIC_VAULT` was not set **at build
time**. Setting it now and restarting changes nothing — see §6.

Then look at the page itself: the vault card renders, an unfilled week shows as `unfilled, 0`
rather than an error, and the layout does not scroll sideways at 400px.

`scripts/copy-lint.mjs` is a CI gate on `web/`, not a deploy gate; its twin gates the landing in
`leekzor/callhouse-site` the same way. A deploy cannot introduce a copy violation that CI did not
already see, because CI and the image build from the same commit.

---

## 6. Changing a variable

| What changed | What to do |
|---|---|
| `NEXT_PUBLIC_*` on `web` | **Rebuild.** Railway → service → Deploy → Redeploy, or push a commit. The value is compiled into the JavaScript; a restart re-runs the identical bundle |
| `OVERCALL_API_BASE` on `web` | **Restart.** It is read per request |
| Anything in `railway.json` | Push the commit. Config-as-code is applied at the start of the next build |

The vault deploy is the concrete case: the day `NEXT_PUBLIC_VAULT` is filled in for the first
time, the `web` service needs a **rebuild**, and the deploy is not finished until step 5 of §5
returns the address in `ops/addresses.json`.

---

## 7. Rollback

Railway → service → **Deployments** → pick the last known-good deployment → **Redeploy**.

This restores the **image**, not just the commit — which is the behaviour you want, because the
image carries the `NEXT_PUBLIC_*` values it was built with. Rolling back a bad variable change is
therefore the same action as rolling back bad code: redeploy the deployment from before it.

The corollary: reverting the commit alone does **not** undo a variable change. The variable lives
on the service, and the next build will pick it up again. Fix the variable, then rebuild.

Rolling back `web` does not affect the landing. They share nothing, not even a repository, so
`callhouse.xyz` can sit on last week's build while `app.callhouse.xyz` ships.

---

## 8. Building locally, before you push

Worth doing once, and any time a Dockerfile changes. The context is the repo root — the trailing
`.` is load-bearing.

```bash
# from the repo root
docker build -f web/Dockerfile -t callhouse-web \
  --build-arg NEXT_PUBLIC_VAULT=0x0000000000000000000000000000000000000000 \
  --build-arg NEXT_PUBLIC_API_URL=http://localhost:42069 .
docker run --rm -p 3000:3000 -e OVERCALL_API_BASE=https://overcall.finance callhouse-web
```

The build asserts its standalone entry point and fails with a readable message rather than a
bare COPY error. If you see that message, read the next section.

---

## 9. Known sharp edges

1. **`NEXT_PUBLIC_*` is baked at build time.** Said three times in this file because it is the
   only failure here that is silent. The container starts, the healthcheck passes, the page serves
   the wrong vault. Rebuild, never restart, and verify with §5 step 5.

2. **A `CNAME` at the apex is invalid DNS.** `callhouse.xyz` needs `ALIAS`/`ANAME` or Cloudflare's
   CNAME flattening. Do not pin an A record to an IP you resolved yourself. (The landing's record;
   the full step is in the `leekzor/callhouse-site` README, §4 here has the summary.)

3. **`HOSTNAME=0.0.0.0`.** Remove it and standalone binds localhost, unreachable from outside the
   container, and every healthcheck times out. This is the first thing to check on a failing
   deploy.

4. **Root Directory must be the repo root.** Point it at `/web` and the build context loses
   `pnpm-lock.yaml` and `pnpm-workspace.yaml`, and the workspace install has nothing to work from.

5. **The install is filtered, and it has to be.** The web image runs
   `pnpm install --frozen-lockfile --filter @callhouse/web...` — that package plus its
   dependencies, nothing else. Drop the filter and pnpm also installs `keeper`, whose
   `better-sqlite3` is a native addon: `node-gyp` runs on `node:22-alpine`, finds no Python, and
   the build dies with `Could not find any Python installation to use`. Both alternatives are
   worse than a filter — install `python3` and `build-base` to compile a database driver into a
   web image, or pass `--ignore-scripts` and silently skip every legitimate postinstall. The
   trailing `...` is load-bearing: `--filter @callhouse/web` alone omits the dependencies.

6. **Every member's `package.json` is still copied.** `web`, `keeper`, `indexer` — all
   three, filtered install or not, because pnpm compares the lockfile's importer set against the
   workspace before it resolves anything. Add a package to `pnpm-workspace.yaml` without
   regenerating and committing `pnpm-lock.yaml`, or forget to copy its manifest, and **both**
   images (web and keeper) fail with "lockfile is not up to date". No keeper or indexer *code*
   reaches the web image; only the manifests do.

7. **The standalone entry point nests.** `outputFileTracingRoot` is the repo root, so the output
   mirrors it: `.next/standalone/web/server.js`, not `.next/standalone/server.js`. `.next/static`
   is **not** inside the standalone tree and is copied separately to `web/.next/static` — miss it
   and the page renders unstyled with every asset 404ing. `web/Dockerfile` asserts the entry point
   exists at the end of the builder stage so this fails with an explanation.

8. **`output: 'standalone'` lives in `web/next.config.mjs`.** Delete it there and the
   image build fails at the assertion, not at deploy time. If a future Next release stops emitting
   standalone output under a Turbopack build, build with `--webpack` before changing anything
   else — the rest of this file is unaffected.

9. **`web` and `keeper` watch one repository.** Without `build.watchPatterns` in each `railway.json`
   every push rebuilds both. If Railway rejects that key on a future schema, the fallback is the
   Watch Paths field in the service settings; the deploy is not broken either way, just noisier.

10. **The keeper's `railway.json` carries no `startCommand` — deliberately.** Railway runs a
    `startCommand` through a shell, which puts `/bin/sh` at PID 1, swallows SIGTERM, and turns
    every redeploy into a 30-second kill mid-transaction. With the key absent the Dockerfile's
    exec-form `CMD ["node", "dist/index.js"]` runs, node is PID 1, and the SIGTERM handler in
    `index.ts` (finish the in-flight tick, close SQLite, exit 0) actually gets to run. Do not
    re-add the key for legibility; the start command is readable in keeper/Dockerfile.

11. **`corepack prepare pnpm@9 --activate` resolves the latest 9.x at build time.** That is
    deliberate — it tracks the lockfile's format, not a pinned patch. If corepack ever fails to
    fetch, it fails loudly in the install layer and no image ships.

12. **The web image runs as `nextjs` (uid 1001), not root.** Anything that needs to write at
    runtime needs to be writable by that user. Nothing does today; the package does not write to
    disk.

13. **`ops/`, `docs/` and `contracts/` are excluded from the build context** by the root
    `.dockerignore`. `web/lib/abi/*.ts` are generated and committed, so `next build` never reads
    `ops/abis`. If a frontend file ever imports across those boundaries, the build fails in Docker
    while working locally — fix the import, do not widen the context.

---

## Related

| File | What it covers |
|---|---|
| [`../web/Dockerfile`](../web/Dockerfile) | The dapp image. The build-arg block is commented at length |
| `leekzor/callhouse-site` README | The landing: its image, Railway service, variables and the apex-domain DNS step |
| [`../.dockerignore`](../.dockerignore) | What reaches the build context, and what must stay in |
| [`../web/.env.example`](../web/.env.example) | Authoritative list of what `web/` reads |
| [`addresses.json`](addresses.json) | The address book. Diff §5 step 5 against it |
| [`runbooks/incident.md`](runbooks/incident.md) | When the problem is the protocol, not the deploy |

---

## 10. The keeper

Added 2026-09-13. Everything above is about the `web` frontend; this section is the other Railway
service this repository deploys, and it is different in kind: it holds a hot key, it writes to
chain, and it keeps state. Read [`../keeper/README.md`](../keeper/README.md) first.

### 10.0 The shape of it

```
(no domain)            ->  Railway service "keeper"  ->  keeper/Dockerfile  ->  node dist/index.js
                           One process, one vault. Polls the registry and the vault every
                           POLL_INTERVAL_MS, writes the week's calls, lists them, closes the
                           week. Health on GET /health. SQLite at /data/keeper.db on a volume.
```

Same build context as `web` — **the repo root** — for the same reason: the lockfile is
workspace-wide. `keeper/railway.json` is the config-as-code and this section is its documentation.

**Exactly one instance. Never scale it.** Two keepers see the same `Idle` vault, both pick the
same rung, both send `rollOpen`, one reverts `WrongPhase`, both try to `approveListing`, both
POST, both alert, and their nonces collide on the same hot key. `keeper/railway.json` pins
`numReplicas: 1`, and the SQLite volume can only be attached to one container, which is the
enforcement. If Railway ever offers you a second replica, the answer is no.

### 10.1 Railway service settings

| Setting | `keeper` |
|---|---|
| Service name | `keeper` |
| Source → Repo / Branch | this repo / `main` |
| **Source → Root Directory** | **empty (repo root)** — same rule as §1, same failure if you set it |
| Settings → Config-as-code path | `keeper/railway.json` |
| Builder / Dockerfile path | `DOCKERFILE` / `keeper/Dockerfile` (from railway.json) |
| Replicas | **1** (from railway.json) |
| Public networking | **not required.** The healthcheck probes the container's `PORT` privately. Expose a domain only if the web app's fallback buy page must read `GET /orders` from here, and put it behind your own boundary; nothing on this server is a write endpoint |
| Volume | mount path **`/data`** — see 10.3 |
| Healthcheck | `GET /health` on `PORT`, timeout 300 s (from railway.json). 503 only when the loop is wedged; `degraded` is a 200 |

Watch paths: `keeper/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`. A lockfile change
rebuilds both of this repository's services, which is correct. (The landing has its own lockfile.)

### 10.2 Environment variables

**Build-time: none.** `keeper/Dockerfile` declares no `ARG`. Nothing the keeper reads is compiled
in; every value is read by `config.ts` at boot. A variable change is therefore a **restart**, never
a rebuild.

**`KEEPER_PK` is a RUNTIME variable and must never become a build `ARG`.** A build ARG is written
into the image's layer metadata (`docker history` shows it) and into the build log that Railway
keeps; anyone who can pull the image or read the log has the hot key. Runtime variables reach only
the running container's environment. Mark it *sealed* in Railway so the UI cannot display it
either. The key holds gas and `KEEPER_ROLE`; it cannot move depositor funds, but it can propose a
week's listings, and rotating it means an admin Safe transaction.

The full reference for every key is `keeper/README.md` → "Environment". Split for Railway:

| Runtime variable | Set to | Notes |
|---|---|---|
| `RH_RPC` | `https://rpc.mainnet.chain.robinhood.com` | **required.** Must serve `eth_getLogs`; the harvest is summed from `Harvest` logs |
| `REGISTRY` | `0x8E973cE1A6884E28Ad3E377d5f670Bc0b463f4EA` | **required.** The NVDA registry — not the top-level `registry` key in Overcall's config, which is JUGGERNAUT. The vault's constructor and the keeper's boot both refuse a mismatch |
| `VAULT` | `ops/addresses.json` → `chains.4663.ours.vault` | **required.** The keeper cross-checks the vault's wiring against every address below at boot and refuses to start on a mismatch |
| `KEEPER_PK` | the hot key, 32-byte hex | **required, sealed, runtime only.** Fund it with ~0.05 ETH |
| `PORT` | `8787` | Railway probes `$PORT`; the keeper listens on `KEEPER_PORT`, whose Dockerfile default is 8787. Set `PORT=8787` so the two agree, or set both to the same other value |
| `KEEPER_DB_PATH` | leave unset | Dockerfile default `/data/keeper.db`, on the volume |
| `RH_RPC_2` | `https://robinhood-rpc.publicnode.com` | recommended. Backup for `eth_call`/sends only; it rejects archive `eth_getLogs`, and the keeper never sends a log query there |
| `ALERT_WEBHOOK` | your JSON webhook relay | recommended. Unset means alerts are logged and stored in SQLite, not delivered |
| `KEEPER_LOG_LEVEL` | `info` | `debug` is per-tick chain reads; not for production |
| `POLL_INTERVAL_MS` | `60000` | default |
| `OVERCALL_ORDERS_URL` | leave unset | default `https://overcall.finance/api/orders` |
| `CHAIN_ID`, `CLEARINGHOUSE`, `SEAPORT`, `USDG`, `ASSET`, `MULTICALL3`, `SEAPORT_ZONE`, `SEAPORT_CONDUIT_KEY`, `OVERCALL_FEE_RECIPIENT` | leave unset | recon-confirmed defaults in `config.ts`; override only for a fork or a second market |
| `KEEPER_UNIT_PRICE_USDG6` | leave unset | a manual ask override for one unusual cycle. Remove it afterwards or every week is priced by hand |
| everything else in `keeper/README.md` | leave unset | defaults |

### 10.3 The volume

The keeper's memory of what it has already done — cycles, listings with their signed components,
transactions, alerts, the heartbeat — is one SQLite file. Attach a Railway volume with mount path
**`/data`**. Without it every redeploy starts from an empty database: the keeper still reconciles
against chain and never re-does a write, but the cycle tape it serves from `GET /cycles` (unfilled
weeks included) is gone, and a listing whose components are lost can only be killed with
`invalidateAllListings()` rather than `cancelListing(components)`.

The image runs as the stock `node` user (uid 1000) and `chown`s `/data` at build time, but a
Railway volume is mounted at run time. If the first boot logs `EACCES` opening
`/data/keeper.db`, Railway's documented workaround is the service variable `RAILWAY_RUN_UID=0`;
prefer confirming the mount's ownership first. Back the file up: `railway volume` snapshots, or a
periodic `sqlite3 /data/keeper.db ".backup /data/keeper.$(date +%F).db"`.

### 10.4 First deploy, in order

1. **The dry run must have passed** on the commit you are deploying:
   `keeper/README.md` → "Dry run against a fork", recorded in `keeper/DRYRUN.md`. It is the only
   place the whole roll executes before Friday.
2. **The root `.dockerignore` must admit the keeper's sources.** It excludes `keeper/*` except
   `package.json` (so the frontend images stay small) and needs these lines for this image:
   ```
   !keeper/src
   !keeper/tsconfig.json
   ```
   `docker build -f keeper/Dockerfile .` from the repo root fails at `COPY keeper/src` until they
   are there. Verify locally before pushing — §10.6.
3. Create the volume (10.3) and set every variable in 10.2 **before** the first build; a keeper
   that boots without `VAULT` exits 1 with the list of missing keys, which is correct but noisy.
4. Deploy. Watch the logs for, in order: `callhouse keeper starting` → `reconciled against chain
   state` → `health server listening` → the `boot` alert. A `Keeper config does not match the
   deployed vault` line means a variable in 10.2 disagrees with the vault; fix it and restart.
5. Verify: `GET /health` answers `"status":"ok"` with `checks.heartbeat: true` after the first
   tick, and `keeper.hasKeeperRole: true`. If the role is false the keeper can close but not
   open — run `script/Configure.s.sol`.

### 10.5 Changing things

| What changed | What to do |
|---|---|
| any runtime variable | **restart** the service. Nothing is compiled in |
| `KEEPER_PK` | grant `KEEPER_ROLE` to the new address from the admin Safe **first**, then change the variable and restart, then revoke the old role. The keeper alerts `keeper … does not hold KEEPER_ROLE` and refuses to open a cycle otherwise |
| keeper code | push; Railway rebuilds. Restart is safe at any instant: SIGTERM lets the in-flight tick finish, then SQLite closes. During a redeploy Railway may run the old and new containers briefly side by side; the volume attaches to one, and the vault's phase machine rejects the loser's duplicate write with `WrongPhase` |
| `railway.json` | push the commit |

Rollback is §7, unchanged. The database is on the volume, not in the image, so rolling the image
back does not roll the keeper's memory back — which is what you want.

### 10.6 Building locally, before you push

```bash
# from the repo root
docker build -f keeper/Dockerfile -t callhouse-keeper .
docker run --rm callhouse-keeper
#   Keeper configuration is not usable. Fix these and restart:
#     RH_RPC: Required
#     REGISTRY: Required
#     VAULT: Required
#     KEEPER_PK: Required
#   -> exit 1. That is the correct answer to "no environment".
docker run --rm -e RH_RPC=… -e REGISTRY=… -e VAULT=… -e KEEPER_PK=… -e PORT=8787 \
  -v callhouse-keeper-db:/data -p 8787:8787 callhouse-keeper
curl -s localhost:8787/health | jq .status
```

### 10.7 Known sharp edges, keeper edition

1. **pnpm is pinned by `packageManager` in the root `package.json`** (`pnpm@9.10.0`, the version
   that wrote `pnpm-lock.yaml`). `corepack enable` in every Dockerfile resolves that field; the
   first keeper image had no pin, corepack resolved pnpm 12, and the install died with
   `ERR_PNPM_IGNORED_BUILDS` before better-sqlite3 was ever built. Do not `corepack prepare` a
   different version in a Dockerfile; change the field.
2. **better-sqlite3 needs `python3 make g++` in the builder** even though version 13 ships prebuilt
   binaries: its install script runs `node-gyp rebuild` regardless. The runner has none of them.
   The Dockerfile asserts the addon loads from the pruned tree before the runner stage exists.
3. **`PORT` vs `KEEPER_PORT`.** Railway injects and probes `PORT`; the keeper reads `KEEPER_PORT`
   (Dockerfile default 8787). Set `PORT=8787`. A mismatch is a healthcheck timeout that looks like
   a slow boot.
4. **The keeper is not a web service.** No domain, no CORS, no auth on `/health`, `/state`,
   `/orders`, `/cycles` — they are read-only and hold no secret, but they name the vault and the
   keeper address. Keep them private unless the fallback buy page needs `/orders`.
5. **One instance.** Said twice in this section on purpose.
