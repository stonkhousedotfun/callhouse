# Runbook — Deploy the app

**What this is.** How the dapp (`app.callhouse.finance`) gets onto Railway, what every setting means,
and the three things that go wrong. The other Railway services this repository deploys have their
own sections: keeper §10, indexer §11, alert relay §12. The contracts are deployed from the
contracts repository with its own runbook; §13 is the hand-off between the two. The landing
(`callhouse.finance`) deploys from `leekzor/callhouse-site`, and that repository's README is its
runbook.

**Who runs it.** Anyone with write access to the Railway project. Nothing in this runbook touches
a private key, signs a transaction, or can move a token. The worst outcome of getting it wrong is
a page that lies about which contract it is pointed at, which is bad enough, so read §3.

**Time budget.** 30 minutes for the first setup, including DNS propagation. Two minutes for a
redeploy.

**Two things that changed on 2026-09-13.**

- **Railway config-as-code (`railway.json`) is dead.** Railway deprecated it on 2026-08-21 (hard
  cutoff 2026-12-01; new services cannot opt in). Our services never used it, so the `*/railway.json`
  files in this repo are **reference settings only**: the Dockerfile path is the service variable
  `RAILWAY_DOCKERFILE_PATH`, the healthcheck timeout is `RAILWAY_HEALTHCHECK_TIMEOUT_SEC`, the
  healthcheck path, restart policy and replica count are set in the service settings UI, and the
  SIGTERM grace is `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`. Do not adopt Railway's replacement
  (`.railway/railway.ts`, project-wide, omit = delete) for the launch; keep manual settings.
- **The app no longer talks to Overcall.** The redesigned vault sells through the self-hosted fill
  page only (`/vault/nvda/cycle` → the keeper's `/orders`), so there is no `OVERCALL_*` variable
  anywhere, no `/api/overcall/listings` route, no registry address, and no HMAC relay route on the
  indexer. If you see one of those on a service, delete it.

---

## 0. The shape of it

```
callhouse.finance          ->  Railway service "site"  ->  leekzor/callhouse-site (its own repo,
                           its own Dockerfile and build context). Not covered here.

app.callhouse.finance      ->  Railway service "web"   ->  web/Dockerfile   ->  web/server.js
                           The dapp, every route unchanged. wagmi + viem, one server route
                           (/api/keeper/orders, the fill page's order source).
```

One frontend service in this repository, **one build context: the repo root**. `web/Dockerfile`
copies `pnpm-lock.yaml`, `pnpm-workspace.yaml` and every workspace member's `package.json` before
it installs, because the lockfile is workspace-wide. This is why the Root Directory setting in §1
is not negotiable.

Nothing is shared between the two domains at runtime. No cookie, no session, no CORS grant, no
shared origin. Every "go and do something" control on `callhouse.finance` is a plain absolute link to
`https://app.callhouse.finance/...`, which is the whole reason the split is cheap.

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
| Config file path | **empty.** Config-as-code is deprecated; clear any path a previous setup left |
| Builder | Dockerfile, via the service variable `RAILWAY_DOCKERFILE_PATH=web/Dockerfile` |
| Healthcheck | path `/` in the UI; `RAILWAY_HEALTHCHECK_TIMEOUT_SEC=120` |
| Restart policy | `On Failure`, 10 retries (UI) |
| Replicas | 1 (UI) |
| Public networking | enabled, target port 3000; set `PORT=3000` as a variable (§3) |

**Root Directory must stay empty.** It is the single setting people get wrong. Setting it to
`/web` makes Railway use `web/` as the build context, `pnpm-lock.yaml` and `pnpm-workspace.yaml`
are then outside the context, and the install either fails or silently resolves a different tree.

`RAILWAY_DOCKERFILE_PATH` is resolved **relative to the Root Directory**. Root Directory empty +
`web/Dockerfile` is a consistent pair. If you ever move the root, both halves move together.

### Watch paths

`web`, `keeper`, `indexer` and `relay` watch the same repository, so without a filter every push
rebuilds all four. Set Watch Paths in each service's settings (the `build.watchPatterns` in the
reference `railway.json` files are the values):

```
web:      web/**      scripts/**  package.json  pnpm-lock.yaml  pnpm-workspace.yaml
keeper:   keeper/**   package.json  pnpm-lock.yaml  pnpm-workspace.yaml
indexer:  indexer/**  package.json  pnpm-lock.yaml  pnpm-workspace.yaml
relay:    relay/**    package.json  pnpm-lock.yaml  pnpm-workspace.yaml
```

A lockfile change rebuilds all of them. That is correct: a workspace install feeds every image.

---

## 2. First deploy, in order

Do these in order. Step 2 before step 3, or the first image is built with an empty configuration
and you will deploy a page pointed at nothing.

1. **Confirm the workspace is coherent.** `keeper`, `indexer`, `relay` and `web` must be listed in
   `pnpm-workspace.yaml`, and `pnpm-lock.yaml` must have been regenerated and committed after the
   last change to that list. Verify locally:

   ```bash
   pnpm install --frozen-lockfile     # must succeed with no lockfile update
   ```

   If that command wants to modify the lockfile, **stop**. Every Docker build runs
   `pnpm install --frozen-lockfile` and all of them will fail with "lockfile is not up to date".

2. **Set every variable** from §3 on the service, before triggering a build.

3. **Deploy.** Push to `main`, or Railway → service → Deploy. (`ops/go-live-app.sh` does steps 2–3
   for every service in the right order once the vault exists; §13.)

4. **Verify** with §5.

5. **Attach the domains** (§4). Do this after a deploy is healthy, so a DNS failure is
   distinguishable from an application failure.

---

## 3. Environment variables

The split below is the most important thing in this file.

> **`NEXT_PUBLIC_*` is compiled into the JavaScript by `next build`. It is not read at runtime.**
> Railway passes a service variable into a Dockerfile build **only if the Dockerfile declares it
> as an `ARG`**; every one of them is declared, in the builder stage, before `next build`. A
> variable that is not declared is silently absent at build time: the container still starts, the
> healthcheck still passes, and the page serves the wrong configuration. Sealed variables still
> flow into ARGs, so never seal anything that would end up in a build layer.
>
> **Changing any of these requires a REBUILD, not a restart.**

The `site` service's variables are documented in `leekzor/callhouse-site`; the rule above applies
to it identically.

### `web` — build-time

| Variable | Value | If unset |
|---|---|---|
| `NEXT_PUBLIC_VAULT` | the deployed vault, from `ops/addresses.json` → `chains.4663.ours.vault` | **No default, deliberately.** Every page renders a "not configured" notice. This is the intended pre-deploy state, not a bug |
| `NEXT_PUBLIC_CHAIN_ID` | `4663` | Dockerfile ARG default `4663`. **Never set this to an empty string**: `lib/chain.ts` uses `??`, which does not treat `""` as missing, and the app would compile chain id `0` |
| `NEXT_PUBLIC_RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | ARG default, same value. Primary; archive reads and full-range `eth_getLogs` work here |
| `NEXT_PUBLIC_RPC_URL_2` | `https://robinhood-rpc.publicnode.com` | ARG default, same value. Backup; rejects old-range `eth_getLogs` |
| `NEXT_PUBLIC_EXPLORER_URL` | `https://robinhoodchain.blockscout.com` | ARG default, same value. Links only; nothing fetches it |
| `NEXT_PUBLIC_API_URL` | the deployed indexer's public URL | ARG default is `http://localhost:42069`, which is wrong in production. Every history panel reads "unavailable" and `/activity` falls back to a direct log scan. Degraded, not broken; **set it** |
| `NEXT_PUBLIC_ASSET` | leave unset | `lib/contracts.ts` carries the explorer-confirmed address. Blank is the intended value |
| `NEXT_PUBLIC_USDG` | leave unset | as above |
| `NEXT_PUBLIC_CLEARINGHOUSE` | leave unset unless the vault was built on our own Clear (§13) | `lib/contracts.ts` defaults to Overcall's unmodified instance `0x9a7b…C0C0`. It must equal `vault.clear()`; the fill payload's offer item names this token |
| `NEXT_PUBLIC_SEAPORT` | leave unset | as above |
| `NEXT_PUBLIC_VAULT_FROM_BLOCK` | the vault's deploy block | Falls back to `0`. Only makes `/activity`'s fallback scan cheaper |
| `NEXT_PUBLIC_SITE_URL` | `https://callhouse.finance` | ARG default, same value |
| `NEXT_PUBLIC_APP_URL` | `https://app.callhouse.finance` | ARG default, same value. Used as `metadataBase` |
| `NEXT_PUBLIC_DOCS_URL` | `https://docs.callhouse.finance` | ARG default, same value. Footer link to the GitBook docs |

The four address variables are left blank on purpose. `lib/contracts.ts` owns those values,
`ops/addresses.json` carries the evidence for each one, and a second copy in the Railway UI is a
second thing to drift. Override one only for a fork or a rehearsal deploy. There is no
`NEXT_PUBLIC_REGISTRY` any more; if the service still carries one, delete it.

`web/.env.example` is the authoritative list of what this package reads. If it grows a variable,
`web/Dockerfile` needs the matching `ARG`/`ENV` pair or the new variable will not exist in the
build.

### `web` — runtime

| Variable | Value | Notes |
|---|---|---|
| `KEEPER_ORDERS_URL` | `http://keeper.railway.internal:8787/orders` | **Server-side, read per request** by `app/api/keeper/orders`, the fill page's only order source. Railway private networking: the `keeper` service (§10) in the same project and environment, on its `KEEPER_PORT` (default 8787; keep `PORT` equal to it, §10.2). No default: **unset, the route answers 503 "not configured" and the cycle page has no fill button.** Never `NEXT_PUBLIC_`, never a build ARG. Change it and **restart**. Must be http(s) with no credentials in it; the route refuses anything else and never prints the value. `http://${{keeper.RAILWAY_PRIVATE_DOMAIN}}:8787/orders` is the reference-variable spelling |
| `PORT` | `3000` | Railway probes `$PORT` and routes the public domain to it; `server.js` reads `process.env.PORT`. Set it explicitly to `3000` so the domain's target port, the healthcheck and the server agree. (Railway's documented approach when a target port is pinned) |

**The fill page.** There is no third-party order book: the vault's listing is a `PARTIAL_RESTRICTED`
Seaport order with the vault as zone, and the only place a buyer sees it is `/vault/nvda/cycle`.
That page asks `/api/keeper/orders`, which reads the keeper's `GET /orders` over the private
network and serves only an order it has checked against the chain: Seaport's counter restored with
`getCounter`, the hash derived locally and by Seaport's `getOrderHash` equal to the vault's
`listingHash()`, offerer and zone the vault, orderType 3, phase Listed, not expired, not sold out or
cancelled, one USDG consideration item to the vault at the gross the vault recorded. An order that
names the authorised hash and is not that order is logged on the web service as a warning
(`"msg":"keeper orders rejected"`, one line per computation, with the count and the first reasons).
Sold-out, cancelled and superseded orders are `closed` and not logged as warnings; an order the
chain could not be read for is `unchecked`. None of them is offered. The page then runs an
`eth_call` fill simulation (~500k gas) before it enables the button, so a listing the vault would
refuse after a rally (`PremiumBelowFloorAtFill`, `StrikeBelowBand`) shows the reason instead of a
reverting transaction. The browser never talks to the keeper, so the keeper needs **no public
domain**. Verify after setting it:

```bash
curl -s https://app.callhouse.finance/api/keeper/orders | head -c 300
# {"configured":true,"orders":[...],"rejected":[],"closed":[],"unchecked":[]}   wired; orders is [] outside a Listed week
# {"configured":false,...}   HTTP 503                    KEEPER_ORDERS_URL is not set on web
# {"configured":true,...,"error":"The keeper could not be reached."}   HTTP 502   see §9 item 14
```

---

## 4. Custom domains

Attach in Railway → service → Settings → Networking → Custom Domain. Railway gives you a target
hostname of the form `<something>.up.railway.app` **and a `_railway-verify` TXT record**; without
the TXT the domain answers 404. Then create the DNS records, all **DNS only** (grey cloud) on
Cloudflare.

### `app.callhouse.finance`

A subdomain. Plain `CNAME`, works at every registrar.

```
Type   Name   Value
CNAME  app    <target>.up.railway.app
TXT    _railway-verify.app   <value Railway shows>
```

TLS is issued by Railway (Let's Encrypt, 90 days, auto-renewed) once the record resolves. Expect a
few minutes. If CAA records are ever added to the zone, allow `letsencrypt.org` (Railway) and
`pki.goog` (GitBook, for `docs.`).

### `callhouse.finance` and `www` — the landing's records, documented with the landing

The apex and `www` attach to the `site` service, and the full step is in the
`leekzor/callhouse-site` README. One fact is repeated here because it lives in the same DNS zone as
the record above: **a `CNAME` at the apex is not valid DNS**, so the apex needs Cloudflare's CNAME
flattening (DNS only), never an A record pinned to an IP you resolved yourself. (`www` currently
answers 200 on its own rather than redirecting; whether it should 301 is the landing repo's call.)

---

## 5. Healthchecks, and how to verify a deploy

Set in the `web` service settings (the reference `web/railway.json` carries the same values):

```
healthcheck path      /
RAILWAY_HEALTHCHECK_TIMEOUT_SEC=120
restart policy        On Failure, 10 retries
```

**Railway healthchecks run at deploy start only.** They are not continuous monitoring, and
`On Failure` restarts a crashed process, not a serving one that answers 503. For the keeper that
distinction matters (§10.1, `ops/alerts.md` §11).

**A healthcheck that times out almost always means the server is bound to the wrong interface.**
Next's standalone server binds `127.0.0.1` unless `HOSTNAME` says otherwise; inside a container
that means nothing outside the container can reach it, and Railway reports a timeout that reads
like a slow boot. `web/Dockerfile` sets `ENV HOSTNAME=0.0.0.0` for exactly this reason. If you are
debugging a failing healthcheck, confirm that line survives before you look anywhere else.

The second cause is a `PORT` mismatch: Railway probes `$PORT` and `server.js` reads
`process.env.PORT`. Set `PORT=3000` on the service and make the domain's target port 3000.

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
time**. Setting it now and restarting changes nothing; see §6.

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
| `KEEPER_ORDERS_URL` or `PORT` on `web` | **Restart.** Read at runtime |
| `RAILWAY_DOCKERFILE_PATH`, `RAILWAY_HEALTHCHECK_TIMEOUT_SEC`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, a UI setting | Takes effect on the next deploy |
| Anything in a `railway.json` | Nothing happens. The files are reference settings; change the service variable or UI setting they document, and keep the file in step so the two do not drift |

The vault deploy is the concrete case: the day `NEXT_PUBLIC_VAULT` is filled in for the first
time, the `web` service needs a **rebuild**, and the deploy is not finished until step 5 of §5
returns the address in `ops/addresses.json`.

---

## 7. Rollback

Railway → service → **Deployments** → pick the last known-good deployment → **Redeploy**.

This restores the **image**, not just the commit, which is the behaviour you want, because the
image carries the `NEXT_PUBLIC_*` values it was built with. Rolling back a bad variable change is
therefore the same action as rolling back bad code: redeploy the deployment from before it.

The corollary: reverting the commit alone does **not** undo a variable change. The variable lives
on the service, and the next build will pick it up again. Fix the variable, then rebuild.

Rolling back `web` does not affect the landing. They share nothing, not even a repository, so
`callhouse.finance` can sit on last week's build while `app.callhouse.finance` ships.

---

## 8. Building locally, before you push

Worth doing once, and any time a Dockerfile changes. The context is the repo root; the trailing
`.` is load-bearing.

```bash
# from the repo root
docker build -f web/Dockerfile -t callhouse-web \
  --build-arg NEXT_PUBLIC_VAULT=0x0000000000000000000000000000000000000000 \
  --build-arg NEXT_PUBLIC_API_URL=http://localhost:42069 .
docker run --rm -p 3000:3000 -e PORT=3000 -e KEEPER_ORDERS_URL=http://host.docker.internal:8787/orders callhouse-web
```

The build asserts its standalone entry point and fails with a readable message rather than a
bare COPY error. If you see that message, read the next section.

---

## 9. Known sharp edges

1. **`NEXT_PUBLIC_*` is baked at build time.** Said three times in this file because it is the
   only failure here that is silent. The container starts, the healthcheck passes, the page serves
   the wrong vault. Rebuild, never restart, and verify with §5 step 5.

2. **A `CNAME` at the apex is invalid DNS.** `callhouse.finance` needs Cloudflare's CNAME
   flattening. Do not pin an A record to an IP you resolved yourself. (The landing's record; the
   full step is in the `leekzor/callhouse-site` README, §4 here has the summary.)

3. **`HOSTNAME=0.0.0.0`.** Remove it and standalone binds localhost, unreachable from outside the
   container, and every healthcheck times out. This is the first thing to check on a failing
   deploy.

4. **Root Directory must be the repo root.** Point it at `/web` and the build context loses
   `pnpm-lock.yaml` and `pnpm-workspace.yaml`, and the workspace install has nothing to work from.

5. **The install is filtered, and it has to be.** The web image runs
   `pnpm install --frozen-lockfile --filter @callhouse/web...`: that package plus its
   dependencies, nothing else. Drop the filter and pnpm also installs `keeper`, whose
   `better-sqlite3` is a native addon: `node-gyp` runs on `node:22-alpine`, finds no Python, and
   the build dies with `Could not find any Python installation to use`. Both alternatives are
   worse than a filter: install `python3` and `build-base` to compile a database driver into a
   web image, or pass `--ignore-scripts` and silently skip every legitimate postinstall. The
   trailing `...` is load-bearing: `--filter @callhouse/web` alone omits the dependencies.

6. **Every member's `package.json` is still copied.** `web`, `keeper`, `indexer`, `relay`: all of
   them, filtered install or not, because pnpm compares the lockfile's importer set against the
   workspace before it resolves anything. Add a package to `pnpm-workspace.yaml` without
   regenerating and committing `pnpm-lock.yaml`, or forget to copy its manifest, and **every**
   image fails with "lockfile is not up to date". No keeper or indexer *code* reaches the web
   image; only the manifests do.

7. **The standalone entry point nests.** `outputFileTracingRoot` is the repo root, so the output
   mirrors it: `.next/standalone/web/server.js`, not `.next/standalone/server.js`. `.next/static`
   is **not** inside the standalone tree and is copied separately to `web/.next/static`; miss it
   and the page renders unstyled with every asset 404ing. `web/Dockerfile` asserts the entry point
   exists at the end of the builder stage so this fails with an explanation.

8. **`output: 'standalone'` lives in `web/next.config.mjs`.** Delete it there and the
   image build fails at the assertion, not at deploy time. If a future Next release stops emitting
   standalone output under a Turbopack build, build with `--webpack` before changing anything
   else; the rest of this file is unaffected.

9. **Four services watch one repository.** Without Watch Paths in each service's settings every
   push rebuilds all four. Not broken either way, just noisier and slower.

10. **No Start Command on the keeper or the indexer, deliberately.** For a Dockerfile deployment
    Railway runs a Start Command in exec form, replacing the image's `ENTRYPOINT`/`CMD`; both
    images already exec `node` as PID 1 (the keeper's `CMD ["node", "dist/index.js"]`, the
    indexer's `sh -c 'exec node … ponder start …'`) so SIGTERM reaches the process and its handler
    runs (finish the in-flight tick, close SQLite, exit 0 / release the Ponder schema lock). Leave
    the field empty so nobody re-adds a shell wrapper; and set
    `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (default **0**, which is an immediate SIGKILL after
    SIGTERM): `120` on the keeper (a tick with a transaction wait), `30` on the indexer.

11. **`corepack enable` resolves the `packageManager` pin** in the root `package.json`
    (`pnpm@9.10.0`, the version that wrote `pnpm-lock.yaml`). Do not `corepack prepare` a
    different version in a Dockerfile; change the field. The first keeper image had no pin,
    corepack resolved pnpm 12, and the install died with `ERR_PNPM_IGNORED_BUILDS`.

12. **The web image runs as `nextjs` (uid 1001), not root.** Anything that needs to write at
    runtime needs to be writable by that user. Nothing does today; the package does not write to
    disk.

13. **`ops/`, `docs/` and `contracts/` are excluded from the build context** by the root
    `.dockerignore`. `web/lib/abi/*.ts` are generated and committed, so `next build` never reads
    `ops/abis`. If a frontend file ever imports across those boundaries, the build fails in Docker
    while working locally: fix the import, do not widen the context.

14. **Post-deploy check, required before launch: `web` reaches the keeper on the private
    network.** The fill page is the only venue, so this link is the product. The keeper's HTTP
    server pins no host (it binds `::`, and IPv4 with it), like the relay and the indexer (§11.6
    item 5); `keeper/src/health.test.ts` fails if a pinned `0.0.0.0` comes back. Railway's private
    DNS is dual-stack in environments created after 2025-10-16 and IPv6-only in older ones, and
    is available at runtime only, never at build. After both services are deployed, from the
    **web** service's shell:

    ```bash
    railway ssh --service web -- wget -qO- http://keeper.railway.internal:8787/orders     # {"orders":[...]}; must answer
    railway ssh --service web -- wget -qO- http://127.0.0.1:3000/api/keeper/orders         # "configured":true and no "error"
    ```

    Use the keeper's `KEEPER_PORT` if it is not 8787. A connection refused or a timeout on the
    first line, while the keeper's own `/health` is green, is the service name, the port, or the
    two services being in different Railway environments. Until it passes, the cycle page shows
    "The fill page is unavailable right now." and nobody can buy the week.

15. **Sealed variables and the Railway CLI.** Seal `KEEPER_PK`, `RELAY_TOKEN`,
    `DISCORD_WEBHOOK_URL` / `TELEGRAM_BOT_TOKEN` right after setting them; a sealed value is never
    shown again in the UI, the API, `railway variables` or `railway run`. **CLI 4.54.0 drops
    sealed variables from `railway variables --json` entirely**, so a script that checks "is
    `KEEPER_PK` set" by value sees nothing and re-prompts (or, for the relay, skips the deploy).
    CLI **≥ 5.47.2** lists them as `null`. Upgrade before sealing anything; `ops/go-live-app.sh`
    refuses to run on an older CLI and tests key presence, not value truthiness.

---

## Related

| File | What it covers |
|---|---|
| [`../web/Dockerfile`](../web/Dockerfile) | The dapp image. The build-arg block is commented at length |
| `leekzor/callhouse-site` README | The landing: its image, Railway service, variables and the apex-domain DNS step |
| [`../.dockerignore`](../.dockerignore) | What reaches the build context, and what must stay in |
| [`../web/.env.example`](../web/.env.example) | Authoritative list of what `web/` reads |
| [`addresses.json`](addresses.json) | The address book. Diff §5 step 5 against it |
| [`go-live-app.sh`](go-live-app.sh) | Sets the variables and deploys all four services in order once the vault exists (§13) |
| [`runbooks/incident.md`](runbooks/incident.md) | When the problem is the protocol, not the deploy |
| `contracts/docs/DEPLOY.md` | The contract-side runbook (bootstrap admin, optional own Clear, Verify, Safe handover) |

---

## 10. The keeper

Everything above is about the `web` frontend; this section is the other Railway service this
repository deploys, and it is different in kind: it holds a hot key, it writes to chain, and it
keeps state. Read [`../keeper/README.md`](../keeper/README.md) first.

### 10.0 The shape of it

```
(no domain)            ->  Railway service "keeper"  ->  keeper/Dockerfile  ->  node dist/index.js
                           One process, one vault. Polls the vault every POLL_INTERVAL_MS. Each
                           week: creates the option type on the clearinghouse, ARMS it
                           (rollOpen writes nothing), authorises one restricted Seaport listing,
                           simulates a fill every tick and reprices after a rally, locks the book,
                           closes the week, retries a stranded claim on a timer. Serves /health,
                           /state, /cycles and /orders (the fill page's order source). SQLite at
                           /data/keeper.db on a volume.
```

Same build context as `web`, **the repo root**, for the same reason: the lockfile is
workspace-wide. `keeper/railway.json` is reference settings; this section is the documentation.

**Exactly one instance. Never scale it.** Two keepers see the same `Idle` vault, both create the
type, both send `rollOpen`, one reverts `WrongPhase`, both try to `approveListing`, both alert,
and their nonces collide on the same hot key. Replicas = 1 in the service settings, and the SQLite
volume can only be attached to one container, which is the enforcement. If Railway ever offers you
a second replica, the answer is no.

### 10.1 Railway service settings

| Setting | `keeper` |
|---|---|
| Service name | `keeper` |
| Source → Repo / Branch | this repo / `main` |
| **Source → Root Directory** | **empty (repo root)**; same rule as §1, same failure if you set it |
| Config file path | empty |
| Builder | `RAILWAY_DOCKERFILE_PATH=keeper/Dockerfile` |
| Replicas | **1** |
| Public networking | **not required, and not needed for the fill page.** The healthcheck probes the container's `PORT` privately, and the web app reads `GET /orders` server-side over the private network (`KEEPER_ORDERS_URL`, §3). No browser ever calls the keeper. §9 item 14 is the post-deploy reachability check |
| Volume | mount path **`/data`**; see 10.3 |
| Healthcheck | `GET /health` on `PORT`, `RAILWAY_HEALTHCHECK_TIMEOUT_SEC=300`. 503 only when the loop is wedged; `degraded` is a 200. **Deploy-time only**: a wedge after boot is caught by nothing on Railway, so the external monitor (`ops/alerts.md` §11) is part of the deploy, not a nicety |
| Draining | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=120` so SIGTERM is not followed by an immediate SIGKILL mid-transaction (the default is 0) |
| Run as | `RAILWAY_RUN_UID=0`: Railway volumes mount root-owned and the image runs as `node`; without this the first boot logs `EACCES` on `/data/keeper.db` (10.3) |

Watch paths: `keeper/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`.

### 10.2 Environment variables

**Build-time: none.** `keeper/Dockerfile` declares no `ARG`. Nothing the keeper reads is compiled
in; every value is read by `config.ts` at boot. A variable change is therefore a **restart**, never
a rebuild.

**`KEEPER_PK` is a RUNTIME variable and must never become a build `ARG`.** A build ARG is written
into the image's layer metadata (`docker history` shows it) and into the build log that Railway
keeps; anyone who can pull the image or read the log has the hot key. Runtime variables reach only
the running container's environment. **Seal it** in Railway so the UI cannot display it either
(after upgrading the CLI, §9 item 15). The key holds gas and `KEEPER_ROLE`; it cannot move
depositor funds, but it chooses the week's strike inside the band and prices inside policy, and
rotating it means an admin transaction.

The full reference for every key is `keeper/README.md` → "Environment"; that file wins if this
table disagrees. Split for Railway:

| Runtime variable | Set to | Notes |
|---|---|---|
| `RH_RPC` | `https://rpc.mainnet.chain.robinhood.com` | **required.** Must serve `eth_getLogs`; the harvest is summed from `Harvest` logs and fills from `CallsWritten` |
| `VAULT` | `ops/addresses.json` → `chains.4663.ours.vault` | **required.** The keeper cross-checks the vault's wiring (`asset`, `usdg`, `clear`, `seaport`, `seaportZone == vault`, `conduitKey`) against every address below at boot and refuses to start on a mismatch |
| `KEEPER_PK` | the hot key, 32-byte hex | **required, sealed, runtime only.** Fund it with ~0.05 ETH |
| `PORT` | `8787` | Railway probes `$PORT`; the keeper listens on `KEEPER_PORT`, whose Dockerfile default is 8787. Set `PORT=8787` so the two agree, or set both to the same other value |
| `KEEPER_DB_PATH` | leave unset | Dockerfile default `/data/keeper.db`, on the volume |
| `RH_RPC_2` | `https://robinhood-rpc.publicnode.com` | recommended. Backup for `eth_call`/sends only; it rejects archive `eth_getLogs`, and the keeper never sends a log query there |
| `ALERT_WEBHOOK` | the relay, `http://relay.railway.internal:8080/alert` | recommended. Unset means alerts are logged and stored in SQLite, not delivered |
| `ALERT_WEBHOOK_TOKEN` | `${{relay.RELAY_TOKEN}}` | required by the relay; sent as `Authorization: Bearer`. Confirm the reference resolves after sealing: `railway ssh --service keeper -- sh -c 'echo ${#ALERT_WEBHOOK_TOKEN}'` prints only the length |
| `KEEPER_LOG_LEVEL` | `info` | `debug` is per-tick chain reads; not for production |
| `POLL_INTERVAL_MS` | `60000` | default |
| `CLEARINGHOUSE` | leave unset unless the vault was built on our own Clear (§13) | default is Overcall's unmodified instance; the boot cross-check against `vault.clear()` catches a mismatch either way |
| `CHAIN_ID`, `SEAPORT`, `USDG`, `ASSET`, `MULTICALL3`, `SEAPORT_CONDUIT_KEY` | leave unset | recon-confirmed defaults in `config.ts`; override only for a fork or a second market. `SEAPORT_ZONE` is gone: the zone is the vault |
| `KEEPER_PRICING_MODE` | leave unset (`vol`) | `vol`: strike at `KEEPER_TARGET_DELTA` (0.15) from Cboe's free delayed NVDA quotes, ask at `max(floor + margin, fair value + KEEPER_PRICE_EDGE_BPS)`; unusable market data skips the week with a `vol-*` reason. Set `fixed` as the operator fallback when Cboe is unusable: strike `spot + KEEPER_STRIKE_OTM_BPS`, ask floor + margin. The container needs outbound https to `cdn.cboe.com` in vol mode |
| `KEEPER_STRIKE_OTM_BPS`, `KEEPER_TARGET_DELTA`, `KEEPER_PRICE_EDGE_BPS`, `KEEPER_STRIKE_BAND_BUFFER_BPS`, `KEEPER_VOL_*` | leave unset | see `keeper/README.md` → Environment; the keeper chooses the strike (there is no ladder any more); the vault's arm gate refuses anything outside the band |
| `PREMIUM_MARGIN_BPS` | owner decision, default `0` | cushion above the policy floor. Under write on fill the floor is re-priced at every fill, so `0` makes the listing unfillable on the first upward tick until the keeper reprices; `50` absorbs a normal tick |
| `KEEPER_MAX_RELISTS` | `1` (default) | reprices per cycle after a rally, under the vault's 3 authorisations per cycle |
| `KEEPER_UNIT_PRICE_USDG6` | leave unset | a manual ask override for one unusual cycle. Remove it afterwards or every week is priced by hand. In vol mode it can only raise the ask |
| everything else in `keeper/README.md` | leave unset | defaults |

There is no `REGISTRY`, no `OVERCALL_*`, no `SEAPORT_ZONE` and no `OVERCALL_FEE_RECIPIENT` any
more. `config.ts` does not read them; delete them from the service so nobody wonders what they do.

### 10.3 The volume

The keeper's memory of what it has already done (cycles, listings with their components,
transactions, alerts, the heartbeat) is one SQLite file. Attach a Railway volume with mount path
**`/data`**. Without it every redeploy starts from an empty database: the keeper still reconciles
against chain and never re-does a write, but the cycle tape it serves from `GET /cycles` (unfilled
weeks included) is gone, and a listing whose components are lost can only be killed with
`invalidateAllListings()` rather than `cancelListing(components)`, and cannot be served to the fill
page until it is relisted.

Railway mounts volumes **root-owned**; the image runs as the stock `node` user (uid 1000) and
`chown`s `/data` at build time, which does not survive the runtime mount. Set `RAILWAY_RUN_UID=0`
on the service before the first deploy (Railway's documented workaround), or add a root entrypoint
that chowns `/data` and drops to `node`. A volume allows one deployment at a time, so **every
redeploy of the keeper has brief downtime**; schedule redeploys away from the arm and close
windows. Enable Railway's volume backups; a deleted volume is restorable for 48 h. Or back the file
up yourself: `sqlite3 /data/keeper.db ".backup /data/keeper.$(date +%F).db"`.

### 10.4 First deploy, in order

1. **The dry run must have passed** on the commit you are deploying:
   `keeper/README.md` → "Dry run against a fork", recorded in `keeper/DRYRUN.md`. It is the only
   place the whole week (create type → arm → list → fill through the hook → close) executes before
   it runs for real.
2. **The root `.dockerignore` must admit the keeper's sources.** It excludes `keeper/*` except
   `package.json` (so the frontend images stay small) and needs these lines for this image:
   ```
   !keeper/src
   !keeper/tsconfig.json
   ```
   `docker build -f keeper/Dockerfile .` from the repo root fails at `COPY keeper/src` until they
   are there. Verify locally before pushing; §10.6.
3. Create the volume (10.3) and set every variable in 10.2 and every `RAILWAY_*` in 10.1 **before**
   the first build; a keeper that boots without `VAULT` exits 1 with the list of missing keys,
   which is correct but noisy.
4. Deploy. Watch the logs for, in order: `callhouse keeper starting` → `reconciled against chain
   state` → `health server listening` → the `boot` alert. A `Keeper config does not match the
   deployed vault` line means a variable in 10.2 disagrees with the vault; fix it and restart.
5. Verify: `railway ssh --service keeper -- wget -qO- http://127.0.0.1:8787/health` answers
   `"status":"ok"` with `checks.heartbeat: true` after the first tick, and
   `keeper.hasKeeperRole: true`. If the role is false the keeper can close but not arm; run
   `script/Configure.s.sol`.
6. Stand up the external `/health` monitor (`ops/alerts.md` §11). Railway will not restart or
   alert on a 503.

### 10.5 Changing things

| What changed | What to do |
|---|---|
| any runtime variable | **restart** the service. Nothing is compiled in |
| `KEEPER_PK` | grant `KEEPER_ROLE` to the new address from the admin **first**, then change the variable and restart, then revoke the old role. The keeper alerts `keeper … does not hold KEEPER_ROLE` and refuses to arm a cycle otherwise |
| keeper code | push; Railway rebuilds. Restart is safe at any instant: SIGTERM lets the in-flight tick finish (with `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` set), then SQLite closes. The volume attaches to one container, so the new one starts after the old one stops; a duplicate write from a briefly overlapping tick is rejected by the vault's phase machine (`WrongPhase`) |
| a `RAILWAY_*` setting | takes effect on the next deploy |

Rollback is §7, unchanged. The database is on the volume, not in the image, so rolling the image
back does not roll the keeper's memory back, which is what you want.

### 10.6 Building locally, before you push

```bash
# from the repo root
docker build -f keeper/Dockerfile -t callhouse-keeper .
docker run --rm callhouse-keeper
#   Keeper configuration is not usable. Fix these and restart:
#     RH_RPC: Required
#     VAULT: Required
#     KEEPER_PK: Required
#   -> exit 1. That is the correct answer to "no environment".
docker run --rm -e RH_RPC=… -e VAULT=… -e KEEPER_PK=… -e PORT=8787 \
  -v callhouse-keeper-db:/data -p 8787:8787 callhouse-keeper
curl -s localhost:8787/health | jq .status
```

### 10.7 Known sharp edges, keeper edition

1. **pnpm is pinned by `packageManager` in the root `package.json`** (`pnpm@9.10.0`, the version
   that wrote `pnpm-lock.yaml`). `corepack enable` in every Dockerfile resolves that field.
2. **better-sqlite3 needs `python3 make g++` in the builder** even though version 13 ships prebuilt
   binaries: its install script runs `node-gyp rebuild` regardless. The runner has none of them.
   The Dockerfile asserts the addon loads from the pruned tree before the runner stage exists.
3. **`PORT` vs `KEEPER_PORT`.** Railway injects and probes `PORT`; the keeper reads `KEEPER_PORT`
   (Dockerfile default 8787). Set `PORT=8787`. A mismatch is a healthcheck timeout that looks like
   a slow boot.
4. **The keeper is not a web service.** No domain, no CORS, no auth on `/health`, `/state`,
   `/orders`, `/cycles`; they are read-only and hold no secret, but they name the vault and the
   keeper address. Keep them private: the fill page reads `/orders` through the web service's
   server over the private network (`KEEPER_ORDERS_URL`, §3), so it never needs a public domain
   here. If `KEEPER_PORT` is ever changed from 8787, change the port in `KEEPER_ORDERS_URL` on
   `web` with it.
5. **One instance.** Said twice in this section on purpose.
6. **A wedged keeper is invisible to Railway.** Healthchecks run at deploy start; `On Failure`
   restarts crashes. The external monitor is the only thing that notices a 503.

---

## 11. The indexer

Ponder and the public read API (`/v1/*`) in one process, over one Postgres. Read
[`../indexer/README.md`](../indexer/README.md) → "Deploy (Railway)" first; this section is the
settings list.

### 11.0 The shape of it

```
<indexer domain>  ->  Railway service "indexer"  ->  indexer/Dockerfile  ->  ponder start
                      Backfills from START_BLOCK, then follows the head. Serves /v1/*, /graphql
                      and Ponder's /health /ready /status /metrics on $PORT.
                  ->  Railway service "Postgres" (the database plugin), private network only.
```

Same build context as every other service here, **the repo root**. There is no compile step:
Ponder loads the TypeScript sources at boot with esbuild and does not type-check them, so CI's
`pnpm --filter @callhouse/indexer typecheck` is the only type gate. `indexer/railway.json` is
reference settings; this section is the documentation.

The indexer is read-only. Nothing in the system writes to it; the web app reads it from the
**browser** (`NEXT_PUBLIC_API_URL`), so it needs a public domain.

### 11.1 Railway service settings

| Setting | `indexer` |
|---|---|
| Service name | `indexer` |
| Source → Repo / Branch | this repo / `main` |
| **Source → Root Directory** | **empty (repo root)**; same rule as §1 |
| Config file path | empty |
| Builder | `RAILWAY_DOCKERFILE_PATH=indexer/Dockerfile` |
| Replicas | **1**. A second replica would open a second indexer on its own schema and double the RPC load for nothing |
| Public networking | **enabled**, target port `42069` (= `PORT`, 11.2). The domain goes into `web`'s `NEXT_PUBLIC_API_URL`, a build-time variable there, so `web` needs a **rebuild** after it changes (§6) |
| Volume | **none.** All state is in Postgres |
| Healthcheck | `GET /ready`, `RAILWAY_HEALTHCHECK_TIMEOUT_SEC=3600`; see 11.4 |
| Restart | `On Failure`, 10 retries |
| Draining | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30` so Ponder releases its schema lock cleanly |

Watch paths: `indexer/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`.

**Postgres.** Add Railway's PostgreSQL database to the same project and environment. Give the
indexer `DATABASE_URL=${{Postgres.DATABASE_URL}}` (a reference variable; the plugin's
`DATABASE_URL` is its private-network URL, so indexing traffic never leaves Railway). Do not use
`DATABASE_PUBLIC_URL` for the indexer. Nothing else in the system connects to this database.

### 11.2 Environment variables

**Build-time: none.** `indexer/Dockerfile` declares no `ARG`. Every value below is read at boot by
`indexer/lib/env.ts` or by Ponder itself, so a variable change is a **restart**, except that any
change to a value `ponder.config.ts` reads (addresses, blocks, RPC) is also a new Ponder build and
re-indexes, see 11.3. The authoritative list is [`../indexer/.env.example`](../indexer/.env.example).

| Variable | Set to | Notes |
|---|---|---|
| `PONDER_RPC_URL_4663` | `https://rpc.mainnet.chain.robinhood.com` | **required.** Archive-capable; backfill runs historical `eth_getLogs`. **Never** the publicnode backup; it refuses archive log queries. A dedicated endpoint turns a backfill from hours into minutes |
| `VAULT_ADDRESS` (alias `VAULT`) | `ops/addresses.json` → `chains.4663.ours.vault` | **required.** No default by design |
| `START_BLOCK` | the vault's deploy block | **required.** No default: a genesis scan of a 62M-block chain is not a backfill |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | **required on Railway.** Unset means PGlite inside the container, which dies with the container |
| `DATABASE_PRIVATE_URL` | leave unset | Ponder prefers it over `DATABASE_URL` when both are set. Set one, not both |
| `DATABASE_SCHEMA` | **leave unset** | The image falls back to `RAILWAY_DEPLOYMENT_ID`, one schema per deploy (11.3). Setting it to a fixed name breaks the second deploy |
| `DATABASE_VIEWS_SCHEMA` | optional, e.g. `callhouse` | Ponder-native. When set, Ponder maintains views of the live deployment's tables under this stable name once it is ready; only useful for someone querying Postgres directly. Must differ from the deploy schema |
| `PORT` | `42069` | Ponder reads `$PORT` and it wins over the CLI default. Set it explicitly so the public domain's target port is fixed |
| `END_BLOCK` | **leave unset** | Bounds a replay. Set in production and the indexer stops following the head |
| `LIVE_READ_TIMEOUT_MS` | leave unset | Default 8000. Deadline on one Multicall3 batch of live reads |
| `CLEARINGHOUSE` | leave unset unless the vault was built on our own Clear (§13) | The indexer follows this contract's `OptionsWritten` / `OptionsExercised` / `ClaimRedeemed` for the vault; it must be the one `vault.clear()` names |
| `SEAPORT`, `USDG`, `ASSET`, `MULTICALL3` | leave unset | Recon-confirmed defaults in `lib/env.ts`. Override only for a fork |
| `PONDER_LOG_LEVEL` | leave unset | `info`. Logs are JSON (`--log-format json` in the image) |
| `RAILWAY_DEPLOYMENT_ID` | — | Injected by Railway. Do not set it |

Gone with the redesign: `REGISTRY`, `REGISTRY_START_BLOCK`, `OVERCALL_ORDERS_URL`,
`OVERCALL_MARKET`, `OVERCALL_FEE_RECIPIENT`, `KEEPER_HMAC_SECRET` (there is no `POST /v1/overcall/list`
route). Delete them from the service if they are there.

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
   passes its healthcheck, so a new container on the old schema could never go healthy.

What survives a redeploy, and what does not:

| Thing | Where it lives | On redeploy |
|---|---|---|
| RPC cache (blocks, logs, `eth_call` results) | shared `ponder_sync` schema | **Kept and reused.** The new deployment re-runs every handler from `START_BLOCK` over cached logs, and only fetches blocks newer than the cache. Expect minutes, not a cold backfill |
| Indexed tables (`cycle`, `listing`, `fill`, …) | the deployment's own schema | **Rebuilt** in the new schema. The old deployment keeps serving its copy until the new one is ready |
| Old deployment schemas | Postgres | **Left behind.** Harmless, but they grow. Clean up with `ponder db prune` (drops every Ponder schema not held by a live instance), run from a checkout with the service's variables and the database's **public** URL (the private one does not resolve off Railway): `railway run --service indexer -- env DATABASE_URL=<Postgres DATABASE_PUBLIC_URL> pnpm --filter @callhouse/indexer exec ponder db prune` |
| `ponder_sync` itself | Postgres | Never dropped by Ponder. Dropping it by hand forces a cold backfill on the next deploy |

A **restart** (same deployment, same id, same schema, same build) is crash recovery: Ponder reverts
unfinalised rows and resumes from its last checkpoint. After a hard kill, the restart can wait up to
25 s for the dead instance's lock to expire before it proceeds.

### 11.4 Healthcheck: why `/ready`

| Path | Served by | Answers | Use |
|---|---|---|---|
| `/health` | Ponder (reserved) | empty 200 the moment the HTTP server exists, before a single block is indexed | nothing here |
| `/ready` | Ponder (reserved) | 503 `Historical indexing is not complete.` until the backfill finishes, then 200 | **Railway healthcheck** |
| `/status` | Ponder (reserved) | `{"robinhood":{"id":4663,"block":{…}}}` | debugging |
| `/v1/health` | this app | 503 `degraded` until the first checkpoint or when the RPC is unreachable; 200 `lagging` past 120 s behind; 200 `ok` | **uptime monitor** (`ops/alerts.md` §25) |

`/ready` is the cutover signal: Railway keeps routing to the previous deployment until the new one
has the whole history, so the public tape never goes backwards mid-deploy. `/v1/health` is the
wrong deploy gate twice over: it would cut traffic to a deployment that is still backfilling as
soon as its first checkpoint lands (200 `lagging`), and an RPC blip at deploy time would fail an
otherwise good deploy. The timeout is 3600 s because a first backfill from the vault's deploy block
on the public RPC can take tens of minutes; a redeploy over the cache takes minutes. Railway's
schema puts no maximum on the timeout; if the UI caps it lower, use the largest value it accepts
and expect a first deploy with a long backfill to need one retry (the second attempt runs over the
cache).

Observed on the local smoke run (2,140-block range, public RPC, Postgres 16):
`/health` 200 at +4 s; `/ready` 503 until +22 s, then 200; `/v1/health` 503 `degraded` before the
first checkpoint, then `{"status":"ok", … "lag":{"blocks":"123","seconds":"14"}}`; `docker stop`
returned in 0.2 s with exit 0 (SIGTERM reaches Ponder, `Started shutdown sequence`).

### 11.5 First deploy, in order

1. `pnpm install --frozen-lockfile` passes locally and the indexer gate is green on the commit.
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
6. Point the external uptime monitor at `/v1/health` (`ops/alerts.md` §25).

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
4. **No Start Command**, same reason as the keeper (§9 item 10): the Dockerfile's `CMD` runs
   `sh -c 'exec node … ponder start …'`, and the `exec` makes node PID 1 so SIGTERM reaches Ponder
   and it releases the schema lock.
5. **No `--hostname`.** Node binds `::` (and IPv4 with it). Pinning `0.0.0.0` would cut the service
   off Railway's private network in a legacy IPv6-only environment.
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

A small stateless HTTP service that turns the keeper's JSON alert webhook into Discord and/or
Telegram messages. Package and HTTP contract: [`../relay/README.md`](../relay/README.md).
Keeper-side wiring: `ops/alerts.md` "Transport".

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
| **Source → Root Directory** | **empty (repo root)**; same rule as §1 |
| Config file path | empty |
| Builder | `RAILWAY_DOCKERFILE_PATH=relay/Dockerfile` |
| Replicas | 1. It is stateless, so more would be safe; one is enough |
| Public networking | **not required** when the keeper is in the same Railway project: use the private URL `http://relay.railway.internal:8080/alert`. Enable a public domain only if the keeper runs elsewhere; the token (12.2) is what protects it |
| Volume | none |
| Healthcheck | `GET /health`, `RAILWAY_HEALTHCHECK_TIMEOUT_SEC=60` |

Watch paths: `relay/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`.

### 12.2 Environment variables

Build-time: **none**. All runtime; a change is a **restart**. The relay refuses to boot on a bad
configuration and prints which variable is wrong, never its value.

| Variable | Set to | Notes |
|---|---|---|
| `RELAY_TOKEN` | `openssl rand -hex 32`, **sealed** | **required.** ≥ 32 characters. The same value goes into the keeper's `ALERT_WEBHOOK_TOKEN` (12.3) |
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

Run this **inside the keeper container**: `railway run` executes locally, where the private
hostname does not resolve, and the sealed token is not handed to `railway run` anyway.

```bash
railway ssh --service keeper -- sh -c 'wget -qO- --post-data "{\"source\":\"callhouse-keeper\",\"kind\":\"boot\",\"severity\":\"info\",\"message\":\"relay wiring test\",\"data\":{}}" \
  --header "content-type: application/json" --header "Authorization: Bearer $ALERT_WEBHOOK_TOKEN" "$ALERT_WEBHOOK"'
# {"ok":true,"delivered":["discord"],"failed":[]}   and the message is in the channel
```

`502` with `failed[].error` = `http_401`/`http_404` on Discord means the webhook URL is wrong or was
deleted; `http_400`/`http_403` from Telegram usually means a wrong chat id or a bot that is not in
the chat. The relay's own log line carries the same codes.

### 12.5 Building locally

```bash
# from the repo root
docker build -f relay/Dockerfile -t callhouse-relay .
docker run --rm callhouse-relay
#   Relay configuration is not usable:
#     RELAY_TOKEN: Required
#   -> exit 1.
```

---

## 13. Contracts → app hand-off

The contract-side runbook is `contracts/docs/DEPLOY.md` (leekzor/callhouse-contracts), deployed
from the release tag on branch `redesign/a2-own-strikes-2026-09-13` or its successor. The parts an
app operator needs to know, so the two runbooks agree:

| Fact | Detail |
|---|---|
| Scripts | `DeployClear.s.sol` (**optional**: our own ValoremOptionsClearinghouse from the vendored upstream artifact, `feeTo` = our admin) → `Deploy.s.sol` (preflight: decimals 18/6, Clear `feeBps == 15` and switch off, Seaport 1.6 with the canonical ConduitController, feed; then both libraries by CREATE2 and the vault; **no registry and no zone argument**, the zone is the vault) → `Verify.s.sol` → `Configure.s.sol` → later `HandoverAdmin.s.sol` |
| Verify counts | **63** bootstrap-unconfigured, **69** bootstrap-configured, **72** safe phase with the owner set pinned, **71** without; 8 library link sites read from the artifact. Any FAIL is a stop |
| Sizes | Vault runtime 25,470 B at `ca0e985` (above EIP-170's 24,576 B, fine on chain 4663 whose limit is **98,304 B**; re-measure with `forge build --sizes` after any re-pin); ValoremLib 5,993 B, SeaportOrderLib 5,170 B |
| Rehearsal | `script/rehearse-deploy.sh` against `anvil --fork-url … --chain-id 4663 --code-size-limit 98304`. A default anvil **refuses** the vault |
| Broadcast flags | `--no-storage-caching` on **every** `forge script` (forge's fork cache can hand a mainnet run rehearsal state; `rm -rf ~/.foundry/cache/rpc/4663` first); `--non-interactive` on the deploys (forge stops at an EIP-170 confirmation prompt for the 25 KB vault, fatal on a non-terminal); `--slow` |
| Source verification | **Sourcify**: `forge verify-contract --verifier sourcify --chain 4663 <addr> <contract>` for the vault (with both `--libraries`) and each library, or `--verify --verifier sourcify` on the deploy; then Blockscout → "Verify & publish → via Sourcify" imports the match. Blockscout's own API sits behind a Cloudflare challenge `forge` cannot pass: **do not** use `--verifier blockscout`, and `ops/bsproxy.js` is no longer part of the deploy (it remains a handy Referer-injecting proxy for reading the explorer API) |
| Library addresses | CREATE2 through `0x4e59b44847b379578588920cA78FbF26c0B4956C`, fixed by bytecode: at `ca0e985` SeaportOrderLib `0x6B617a0B578Ef6EDCD07774468f08b3778272D8A`, ValoremLib `0xd3CB94893EAb55e425cCd77Db98458b38D75Fa3d`. They change with every library byte |
| Clearinghouse | the vault settles on whichever Clear it was constructed with (`vault.clear()`). Default: Overcall's unmodified instance `0x9a7b…C0C0`. If A0 deployed our own, set `CLEARINGHOUSE` on the keeper and indexer and `NEXT_PUBLIC_CLEARINGHOUSE` on web to that address, and record it in `ops/addresses.json` → `ours.clearinghouse` |
| Cycle timing | the vault reads exercise and expiry from the option type; the keeper anchors the week on the US close, Friday 16:00 ET (20:00 UTC in DST, 21:00 UTC otherwise; Thursday's close on a Friday NYSE holiday). Nothing in the app hard-codes a UTC hour |

After the contracts are on chain, in this repository:

1. `ops/addresses.json`: fill `chains.4663.ours` (vault, both libraries, clearinghouse, Safes,
   guardian, keeper, deploy block, admin phase).
2. Pin `contracts/` at the deployed tag; `forge build` there; refresh `ops/abis/{Vault,ValoremLib,SeaportOrderLib,Policy}.json`
   (`jq --indent 1 '.abi'`); `pnpm gen:abis` in `indexer/` and `web/`; the keeper's ABI cross-check
   test fails loudly on any drift (`docs/WIRING.md` §5).
3. Upgrade the Railway CLI to ≥ 5.47.2, then `ops/go-live-app.sh --vault 0x… --from-block N --dry-run`,
   read the plan, run it without `--dry-run`. It sets the variables above on every service in the
   right order, deploys, and checks keeper `/health`, indexer `/ready` and the web page.
4. Seal `KEEPER_PK`, `RELAY_TOKEN`, `DISCORD_WEBHOOK_URL` / `TELEGRAM_BOT_TOKEN`.
5. §9 item 14 (web → keeper), §12.4 (keeper → relay), and the two external monitors
   (`ops/alerts.md` §11, §25).
6. Before the first live week: one real 1-contract fill through the fill page by a friendly buyer,
   so the whole path (type → arm → list → `authorizeOrder` writes → Seaport moves → `validateOrder`
   → `CallsWritten` indexed → shown on `/activity`) has run once on mainnet.
