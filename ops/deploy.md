# Runbook — Deploy the frontend

**What this is.** How the dapp (`app.callhouse.finance`) gets onto Railway, what every setting means,
and the three things that go wrong. The other Railway services this repository deploys have their
own sections at the end: keeper §10, indexer §11, alert relay §12. Contracts are not covered. The
landing (`callhouse.finance`) deploys from its own repository, `leekzor/callhouse-site`, and that
repository's README is its runbook.

**Who runs it.** Anyone with write access to the Railway project. Nothing in this runbook touches
a private key, signs a transaction, or can move a token. The worst outcome of getting it wrong is
a page that lies about which contract it is pointed at — which is bad enough, so read §3.

**Time budget.** 30 minutes for the first setup, including DNS propagation. Two minutes for a
redeploy.

---

## 0. The shape of it

```
callhouse.finance          ->  Railway service "site"  ->  leekzor/callhouse-site (its own repo,
                           its own Dockerfile and build context). Not covered here.

app.callhouse.finance      ->  Railway service "web"   ->  web/Dockerfile   ->  web/server.js
                           The dapp, every route unchanged. wagmi + viem, one server route
                           (/api/overcall/listings).
```

One frontend service in this repository, **one build context: the repo root**. `web/Dockerfile`
copies `pnpm-lock.yaml`, `pnpm-workspace.yaml` and every workspace member's `package.json` before
it installs, because the lockfile is workspace-wide. This is why the Root Directory setting in §1
is not negotiable.

Nothing is shared between the two domains at runtime. No cookie, no session, no CORS grant, no
shared origin. Every "go and do something" control on `callhouse.finance` is a plain absolute link to
`https://app.callhouse.finance/...`, which is the whole reason the split is cheap.

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
| `NEXT_PUBLIC_SITE_URL` | `https://callhouse.finance` | ARG default, same value |
| `NEXT_PUBLIC_APP_URL` | `https://app.callhouse.finance` | ARG default, same value. Used as `metadataBase` |
| `NEXT_PUBLIC_DOCS_URL` | `https://docs.callhouse.finance` | ARG default, same value. Footer link to the GitBook docs |

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
| `KEEPER_ORDERS_URL` | `http://keeper.railway.internal:8787/orders` | **Server-side, read per request** by `app/api/keeper/orders`, the keeper fallback. Railway private networking: the `keeper` service (§10) in the same project and environment, on its `PORT` 8787. No default: **unset, the route answers 503 "not configured" and the cycle page shows no fallback.** Never `NEXT_PUBLIC_`, never a build ARG. Change it and **restart**. Must be http(s) with no credentials in it; the route refuses anything else and never prints the value |
| `PORT` | — | Injected by Railway. `server.js` reads `process.env.PORT`, which wins over the Dockerfile's `ENV PORT=3000`. Do not set it by hand |

That proxy exists because overcall.finance sends no CORS headers, so the browser cannot call it
from our origin. It is GET-only and takes no auth of any kind.

**The keeper fallback.** If Overcall's book does not show the vault's listing (their validator
refuses it, open question L-04, or their API is down), `/vault/nvda/cycle` asks
`/api/keeper/orders`, which reads the keeper's `GET /orders` over the private network and serves
only an order it has checked against the chain: Seaport's counter restored with `getCounter`, the
hash from Seaport's `getOrderHash` equal to the vault's `listingHash()`, offerer the vault, phase
Listed, not expired, and the two payment legs the vault's and Overcall's. Everything else is
logged on the web service (`"msg":"keeper order rejected"`, with reasons) and never offered. The
browser never talks to the keeper, so the keeper needs **no public domain** for this. Verify after
setting it:

```bash
curl -s https://app.callhouse.finance/api/keeper/orders | head -c 300
# {"configured":true,"orders":[...],"rejected":[]}      wired; orders is [] outside a Listed week
# {"configured":false,...}   HTTP 503                    KEEPER_ORDERS_URL is not set on web
# {"configured":true,...,"error":"The keeper could not be reached."}   HTTP 502   see §9 item on private networking
```

---

## 4. Custom domains

Attach in Railway → service → Settings → Networking → Custom Domain. Railway gives you a target
hostname of the form `<something>.up.railway.app`. Then create the DNS records.

### `app.callhouse.finance` — the easy one

A subdomain. Plain `CNAME`, works at every registrar.

```
Type   Name   Value
CNAME  app    <target>.up.railway.app
```

TLS is issued by Railway automatically once the record resolves. Expect a few minutes.

### `callhouse.finance` and `www` — the landing's records, documented with the landing

The apex and `www` attach to the `site` service, and the full step is in the
`leekzor/callhouse-site` README. Two facts are repeated here because they live in the same DNS
zone as the record above: **a `CNAME` at the apex is not valid DNS**, so the apex needs
`ALIAS`/`ANAME` or Cloudflare's CNAME flattening, never an A record pinned to an IP you resolved
yourself; and `www.callhouse.finance` redirects to the apex, 301, at the DNS/CDN layer.

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
curl -sI https://app.callhouse.finance/        | head -1     # HTTP/2 200

# 2-4. The landing's checks (no wallet code, absolute CTAs into the app, its four routes)
#      moved with the landing to the leekzor/callhouse-site README.

# 5. THE ONE THAT MATTERS: which vault did this image get baked with?
curl -s https://app.callhouse.finance/vault/nvda | grep -oiE '0x[0-9a-f]{40}' | sort -u
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
| `KEEPER_ORDERS_URL` on `web` | **Restart.** It is read per request |
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
`callhouse.finance` can sit on last week's build while `app.callhouse.finance` ships.

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

2. **A `CNAME` at the apex is invalid DNS.** `callhouse.finance` needs `ALIAS`/`ANAME` or Cloudflare's
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

14. **The keeper fallback needs the keeper reachable on the private network, and the keeper binds
    `0.0.0.0`.** `keeper/src/health.ts` pins `hostname: '0.0.0.0'`, which is IPv4 only. The relay
    and indexer deliberately do not pin a host (§11.6 item 5) because a Railway environment whose
    private network is IPv6-only cannot reach an IPv4-only listener over `*.railway.internal`. If
    `/api/keeper/orders` answers 502 "The keeper could not be reached." while the keeper's own
    `/health` is green, this is the first suspect: confirm from the web service's shell
    (`wget -qO- http://keeper.railway.internal:8787/orders`). The fix is the keeper's
    (bind `::`), not the web app's; until then the fallback degrades to a warning on the cycle
    page and the Overcall path is unaffected.

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
| Public networking | **not required, and not needed for the fallback.** The healthcheck probes the container's `PORT` privately, and the web app's keeper fallback reads `GET /orders` server-side over the private network (`KEEPER_ORDERS_URL=http://keeper.railway.internal:8787/orders` on `web`, §3). No browser ever calls the keeper. See §9 item 14 on the keeper's IPv4 bind |
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
| `ALERT_WEBHOOK` | the relay, `http://relay.railway.internal:8080/alert` | recommended. Unset means alerts are logged and stored in SQLite, not delivered |
| `ALERT_WEBHOOK_TOKEN` | `${{relay.RELAY_TOKEN}}` | required by the relay; sent as `Authorization: Bearer` |
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
   keeper address. Keep them private: the fallback buy page reads `/orders` through the web
   service's server over the private network (`KEEPER_ORDERS_URL`, §3), so it never needs a
   public domain here. If `KEEPER_PORT` is ever changed from 8787, change the port in
   `KEEPER_ORDERS_URL` on `web` with it.
5. **One instance.** Said twice in this section on purpose.

---

## 11. The indexer

Added 2026-09-13 (L-08). Ponder and the public read API (`/v1/*`) in one process, over one
Postgres. Read [`../indexer/README.md`](../indexer/README.md) → "Deploy (Railway)" first; this
section is the settings list.

### 11.0 The shape of it

```
<indexer domain>  ->  Railway service "indexer"  ->  indexer/Dockerfile  ->  ponder start
                      Backfills from START_BLOCK, then follows the head. Serves /v1/*, /graphql
                      and Ponder's /health /ready /status /metrics on $PORT.
                  ->  Railway service "Postgres" (the database plugin), private network only.
```

Same build context as every other service here — **the repo root**. There is no compile step:
Ponder loads the TypeScript sources at boot with esbuild and does not type-check them, so CI's
`pnpm --filter @callhouse/indexer typecheck` is the only type gate. `indexer/railway.json` is the
config-as-code and this section is its documentation.

Nothing else in the system calls the indexer's write surface except the keeper's optional HMAC
relay route; the web app reads it from the **browser** (`NEXT_PUBLIC_API_URL`), so it needs a
public domain.

### 11.1 Railway service settings

| Setting | `indexer` |
|---|---|
| Service name | `indexer` |
| Source → Repo / Branch | this repo / `main` |
| **Source → Root Directory** | **empty (repo root)** — same rule as §1 |
| Settings → Config-as-code path | `indexer/railway.json` |
| Builder / Dockerfile path | `DOCKERFILE` / `indexer/Dockerfile` (from railway.json) |
| Replicas | **1** (from railway.json). A second replica would open a second indexer on its own schema and double the RPC load for nothing |
| Public networking | **enabled**, target port `42069` (= `PORT`, 11.2). The domain goes into `web`'s `NEXT_PUBLIC_API_URL` — a build-time variable there, so `web` needs a **rebuild** after it changes (§6) |
| Volume | **none.** All state is in Postgres |
| Healthcheck | `GET /ready`, timeout **3600 s** (from railway.json) — see 11.4 |
| Restart | `ON_FAILURE`, 10 retries (from railway.json) |

Watch paths: `indexer/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`.

**Postgres.** Add Railway's PostgreSQL database to the same project and environment. Give the
indexer `DATABASE_URL=${{Postgres.DATABASE_URL}}` (a reference variable; the plugin's
`DATABASE_URL` is its private-network URL, so indexing traffic never leaves Railway). Do not use
`DATABASE_PUBLIC_URL` for the indexer. Nothing else in the system connects to this database.

### 11.2 Environment variables

**Build-time: none.** `indexer/Dockerfile` declares no `ARG`. Every value below is read at boot by
`indexer/lib/env.ts` or by Ponder itself, so a variable change is a **restart** — except that any
change to a value `ponder.config.ts` reads (addresses, blocks, RPC) is also a new Ponder build and
re-indexes, see 11.3. The authoritative list is [`../indexer/.env.example`](../indexer/.env.example).

| Variable | Set to | Notes |
|---|---|---|
| `PONDER_RPC_URL_4663` | `https://rpc.mainnet.chain.robinhood.com` | **required.** Archive-capable; backfill runs historical `eth_getLogs`. **Never** the publicnode backup — it refuses archive log queries. A dedicated endpoint turns a backfill from hours into minutes |
| `VAULT_ADDRESS` (alias `VAULT`) | `ops/addresses.json` → `chains.4663.ours.vault` | **required.** No default by design |
| `START_BLOCK` | the vault's deploy block | **required.** No default: a genesis scan of a 61M-block chain is not a backfill |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | **required on Railway.** Unset means PGlite inside the container, which dies with the container |
| `DATABASE_PRIVATE_URL` | leave unset | Ponder prefers it over `DATABASE_URL` when both are set. Set one, not both |
| `DATABASE_SCHEMA` | **leave unset** | The image falls back to `RAILWAY_DEPLOYMENT_ID`, one schema per deploy (11.3). Setting it to a fixed name breaks the second deploy |
| `DATABASE_VIEWS_SCHEMA` | optional, e.g. `callhouse` | Ponder-native. When set, Ponder maintains views of the live deployment's tables under this stable name once it is ready — only useful for someone querying Postgres directly. Must differ from the deploy schema |
| `PORT` | `42069` | Ponder reads `$PORT` and it wins over the CLI default. Set it explicitly so the public domain's target port is fixed |
| `KEEPER_HMAC_SECRET` | `openssl rand -hex 32`, **sealed** | optional. Enables `POST /v1/overcall/list`; unset ⇒ that route answers 503 and `/v1/health` reports `relay.keeperAuthConfigured: false` |
| `REGISTRY_START_BLOCK` | optional | Scan the Overcall registry from before the vault existed so pre-launch cycles appear in the tape. Defaults to `START_BLOCK` |
| `END_BLOCK` | **leave unset** | Bounds a replay. Set in production and the indexer stops following the head |
| `LIVE_READ_TIMEOUT_MS` | leave unset | Default 8000. Deadline on one Multicall3 batch of live reads |
| `OVERCALL_ORDERS_URL` | leave unset | Default `https://overcall.finance/api/orders` |
| `OVERCALL_MARKET` | leave unset | Default `NVDA` |
| `REGISTRY`, `CLEARINGHOUSE`, `SEAPORT`, `USDG`, `ASSET`, `OVERCALL_FEE_RECIPIENT`, `MULTICALL3` | leave unset | Recon-confirmed defaults in `lib/env.ts`. Override only for a fork. `REGISTRY` is the NVDA registry, never Overcall's top-level JUGGERNAUT one |
| `PONDER_LOG_LEVEL` | leave unset | `info`. Logs are JSON (`--log-format json` in the image) |
| `RAILWAY_DEPLOYMENT_ID` | — | Injected by Railway. Do not set it |

### 11.3 Schemas, and what a redeploy does to sync state

The image starts `ponder start --schema "${DATABASE_SCHEMA:-$RAILWAY_DEPLOYMENT_ID}"`. On Railway,
with `DATABASE_SCHEMA` unset, **every deployment indexes into a new Postgres schema named after
its deployment id.** This is not optional, for two reasons:

1. **A schema belongs to one build.** Ponder records a build id (a hash of config, schema and
   handlers) in the schema. Start a different build on it and Ponder exits:
   `Schema "…" was previously used by a different Ponder app. Drop the schema first, or use a
   different schema.` Reproduced locally by changing only `START_BLOCK` between two runs.
2. **A schema is locked while its app is alive.** The running instance heartbeats every 10 s;
   a second instance waits out the 25 s lock window, retries once, then exits with
   `Failed to acquire lock on schema`. Railway keeps the old deployment serving until the new one
   passes its healthcheck — so a new container on the old schema could never go healthy.

What survives a redeploy, and what does not:

| Thing | Where it lives | On redeploy |
|---|---|---|
| RPC cache (blocks, logs, `eth_call` results) | shared `ponder_sync` schema | **Kept and reused.** The new deployment re-runs every handler from `START_BLOCK` over cached logs, and only fetches blocks newer than the cache. Expect minutes, not a cold backfill |
| Indexed tables (`cycle`, `listing`, …) | the deployment's own schema | **Rebuilt** in the new schema. The old deployment keeps serving its copy until the new one is ready |
| Old deployment schemas | Postgres | **Left behind.** Harmless, but they grow. Clean up with `ponder db prune` (drops every Ponder schema not held by a live instance), run from a checkout with the service's variables and the database's **public** URL (the private one does not resolve off Railway): `railway run --service indexer -- env DATABASE_URL=<Postgres DATABASE_PUBLIC_URL> pnpm --filter @callhouse/indexer exec ponder db prune` |
| `ponder_sync` itself | Postgres | Never dropped by Ponder. Dropping it by hand forces a cold backfill on the next deploy |

A **restart** (same deployment, same id, same schema, same build) is crash recovery: Ponder reverts
unfinalised rows and resumes from its last checkpoint. After a hard kill, the restart can wait up to
25 s for the dead instance's lock to expire before it proceeds.

### 11.4 Healthcheck: why `/ready`

| Path | Served by | Answers | Use |
|---|---|---|---|
| `/health` | Ponder (reserved) | empty 200 the moment the HTTP server exists — before a single block is indexed | nothing here |
| `/ready` | Ponder (reserved) | 503 `Historical indexing is not complete.` until the backfill finishes, then 200 | **Railway healthcheck** |
| `/status` | Ponder (reserved) | `{"robinhood":{"id":4663,"block":{…}}}` | debugging |
| `/v1/health` | this app | 503 `degraded` until the first checkpoint or when the RPC is unreachable; 200 `lagging` past 120 s behind; 200 `ok` | **uptime monitor** (`ops/alerts.md` §26) |

`/ready` is the cutover signal: Railway keeps routing to the previous deployment until the new one
has the whole history, so the public tape never goes backwards mid-deploy. `/v1/health` is the
wrong deploy gate twice over — it would cut traffic to a deployment that is still backfilling as
soon as its first checkpoint lands (200 `lagging`), and an RPC blip at deploy time would fail an
otherwise good deploy. `healthcheckTimeout` is 3600 s because a first backfill from the vault's
deploy block on the public RPC can take tens of minutes; a redeploy over the cache takes minutes.
If the Railway UI caps the timeout lower, use the largest value it accepts and expect a first
deploy with a long backfill to need one retry — the second attempt runs over the cache.

Observed on the local smoke run (2,140-block range, public RPC, Postgres 16):
`/health` 200 at +4 s; `/ready` 503 until +22 s, then 200; `/v1/health` 503 `degraded` before the
first checkpoint, then `{"status":"ok", … "lag":{"blocks":"123","seconds":"14"}}`; `docker stop`
returned in 0.2 s with exit 0 (SIGTERM reaches Ponder, `Started shutdown sequence`).

### 11.5 First deploy, in order

1. `pnpm install --frozen-lockfile` passes locally and CI is green on the commit.
2. Postgres plugin exists (11.1). Every **required** variable in 11.2 is set; `DATABASE_SCHEMA` is
   **not**.
3. Deploy. Logs in order: `Connected to database` → `Connected to JSON-RPC` → `Created database
   tables` → `Created HTTP server` → `Started backfill indexing` → `Updated backfill indexing
   progress` … → `Completed backfill indexing across all chains` → `Started returning 200
   responses {"endpoint":"/ready"}` → `Started live indexing`.
4. Verify:
   ```bash
   curl -si https://<indexer domain>/ready       | head -1   # 200
   curl -s  https://<indexer domain>/v1/health   | jq '.status, .lag, .vault.address'
   curl -s -o /dev/null -w '%{http_code}\n' https://<indexer domain>/v1/cycles   # 200
   ```
   `.vault.address` must equal `ops/addresses.json`.
5. Set `NEXT_PUBLIC_API_URL` on `web` to the domain and **rebuild** `web` (§6).
6. Point the external uptime monitor at `/v1/health` (`ops/alerts.md` §26).

### 11.6 Known sharp edges, indexer edition

1. **`DATABASE_SCHEMA` must stay unset on Railway.** With a fixed schema the first deploy works and
   the second one crash-loops (11.3). The previous deployment keeps serving, so it looks like a
   deploy that is merely slow.
2. **`START_BLOCK` must be behind every RPC node's head.** `rpc.mainnet.chain.robinhood.com`
   load-balances across nodes that were measured ~4,000 blocks apart. A smoke test with
   `START_BLOCK` = head − 500 exited 75 with `BlockNotFoundError: Block at number "0x3b5b6f4"
   could not be found`; head − 2,000 worked. The vault's deploy block is always safe.
3. **Builder toolchain for a dependency the indexer never loads.** drizzle-orm (under Ponder)
   declares better-sqlite3 as an optional peer, the workspace lockfile resolves it to the keeper's
   copy, and its install script needs `python3 make g++`. The Dockerfile's header has the detail.
   Only the builder carries them.
4. **No `startCommand` in railway.json**, same reason as the keeper (§9.10): the Dockerfile's `CMD`
   runs `sh -c 'exec node … ponder start …'` — the `exec` makes node PID 1 so SIGTERM reaches Ponder
   and it releases the schema lock. A Railway `startCommand` would add a second shell above it.
5. **No `--hostname`.** Node binds `::` (and IPv4 with it). Pinning `0.0.0.0` would cut the service
   off Railway's IPv6 private network.
6. **`/graphql` is public** and auto-generated from `ponder.schema.ts`. It exposes nothing the
   `/v1/*` routes do not, but it is a query surface; it is not rate-limited here.

### 11.7 Building locally, before you push

```bash
# from the repo root
docker build -f indexer/Dockerfile -t callhouse-indexer .
docker run --rm callhouse-indexer
#   sh: 1: RAILWAY_DEPLOYMENT_ID: set DATABASE_SCHEMA, or run on Railway where RAILWAY_DEPLOYMENT_ID is injected
#   -> exit 2. That is the correct answer to "no schema".
```

The full Postgres smoke run is in `indexer/README.md` → "Deploy (Railway)".

---

## 12. The alert relay

Added 2026-09-13 (L-09). A small stateless HTTP service that turns the keeper's JSON alert
webhook into Discord and/or Telegram messages. Package and HTTP contract:
[`../relay/README.md`](../relay/README.md). Keeper-side wiring: `ops/alerts.md` "Transport".

### 12.0 The shape of it

```
keeper  --POST ALERT_WEBHOOK-->  Railway service "relay"  ->  relay/Dockerfile  ->  node dist/index.js
                                   GET /health, POST /alert (token)
                                     -> Discord webhook       (DISCORD_WEBHOOK_URL)
                                     -> Telegram sendMessage  (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
```

### 12.1 Railway service settings

| Setting | `relay` |
|---|---|
| Service name | `relay` |
| Source → Repo / Branch | this repo / `main` |
| **Source → Root Directory** | **empty (repo root)** — same rule as §1 |
| Settings → Config-as-code path | `relay/railway.json` |
| Builder / Dockerfile path | `DOCKERFILE` / `relay/Dockerfile` (from railway.json) |
| Replicas | 1 (from railway.json). It is stateless, so more would be safe; one is enough |
| Public networking | **not required** when the keeper is in the same Railway project: use the private URL `http://relay.railway.internal:8080/alert`. Enable a public domain only if the keeper runs elsewhere — the token (12.2) is what protects it |
| Volume | none |
| Healthcheck | `GET /health`, timeout 60 s (from railway.json) |

Watch paths: `relay/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`.

### 12.2 Environment variables

Build-time: **none**. All runtime; a change is a **restart**. The relay refuses to boot on a bad
configuration and prints which variable is wrong, never its value.

| Variable | Set to | Notes |
|---|---|---|
| `RELAY_TOKEN` | `openssl rand -hex 32`, **sealed** | **required.** ≥ 32 characters. The same value goes into the keeper's `ALERT_WEBHOOK` (12.3) |
| `DISCORD_WEBHOOK_URL` | Discord → channel → Integrations → Webhooks → Copy URL, **sealed** | one of Discord / Telegram required. The URL's path is the credential |
| `TELEGRAM_BOT_TOKEN` | from @BotFather, **sealed** | with `TELEGRAM_CHAT_ID` |
| `TELEGRAM_CHAT_ID` | the chat id; `-100…` for a channel. Add the bot to the chat first | with the bot token |
| `PORT` | `8080` | Set explicitly so the private URL's port is fixed |
| `RELAY_TIMEOUT_MS` | leave unset | Default 5000, max 9000 (the keeper aborts at 10 s) |
| `TELEGRAM_API_BASE` | leave unset | Tests only |

### 12.3 Wiring the keeper

The keeper sends `Authorization: Bearer <ALERT_WEBHOOK_TOKEN>` when that variable is set. On the
`keeper` service (§10.2), both as runtime variables:

```
ALERT_WEBHOOK=http://relay.railway.internal:8080/alert
ALERT_WEBHOOK_TOKEN=${{relay.RELAY_TOKEN}}
```

The Railway reference writes the token once. Restart the keeper; its `boot` alert is the first
end-to-end test. Do not put the token in the URL (`?token=` works but can land in proxy logs).

### 12.4 Verify

```bash
# from a shell with the keeper's variables (railway run --service keeper -- sh)
curl -s "$ALERT_WEBHOOK" -H 'content-type: application/json' \
  -d '{"source":"callhouse-keeper","kind":"boot","severity":"info","message":"relay wiring test","data":{}}'
# {"ok":true,"delivered":["discord"],"failed":[]}   and the message is in the channel
```

`502` with `failed[].error` = `http_401`/`http_404` on Discord means the webhook URL is wrong or was
deleted; `http_400`/`http_403` from Telegram usually means a wrong chat id or a bot that is not in the chat. The relay's own log
line carries the same codes.

### 12.5 Building locally

```bash
# from the repo root
docker build -f relay/Dockerfile -t callhouse-relay .
docker run --rm callhouse-relay
#   Relay configuration is not usable:
#     RELAY_TOKEN: Required
#   -> exit 1.
```
