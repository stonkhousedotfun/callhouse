# Runbook — Deploy the app

**What this is.** How the dapp (`app.stonkhouse.fun`) gets onto Railway, what every setting means,
and the three things that go wrong. The other Railway services this repository deploys have their
own sections: keeper §10, indexer §11, alert relay §12, the per-market v1 layout §14, and the v2
services (indexer-v2, pricing, cranker, pricer, mm-bot, notifier) §15. The contracts are deployed from the
contracts repository with its own runbook; §13 is the hand-off between the two. The landing
(`stonkhouse.fun`) deploys from `stonkhousedotfun/callhouse-site`, and that repository's README is its
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
stonkhouse.fun             ->  Railway service "site"  ->  stonkhousedotfun/callhouse-site (its own repo,
                           its own Dockerfile and build context). Not covered here.

app.stonkhouse.fun         ->  Railway service "web"   ->  web/Dockerfile   ->  web/server.js
                           The dapp, every route unchanged. wagmi + viem, one server route
                           (/api/keeper/orders, the fill page's order source).
```

One frontend service in this repository, **one build context: the repo root**. `web/Dockerfile`
copies `pnpm-lock.yaml`, `pnpm-workspace.yaml` and every workspace member's `package.json` before
it installs, because the lockfile is workspace-wide. This is why the Root Directory setting in §1
is not negotiable.

Nothing is shared between the two domains at runtime. No cookie, no session, no CORS grant, no
shared origin. Every "go and do something" control on `stonkhouse.fun` is a plain absolute link to
`https://app.stonkhouse.fun/...`, which is the whole reason the split is cheap.

---

## 1. Railway service settings

Create the `web` service from this GitHub repository. (The `site` service's source is
`stonkhousedotfun/callhouse-site`; its settings are in that repository's README.)

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

The `site` service's variables are documented in `stonkhousedotfun/callhouse-site`; the rule above applies
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
| `NEXT_PUBLIC_SITE_URL` | `https://stonkhouse.fun` | ARG default, same value |
| `NEXT_PUBLIC_APP_URL` | `https://app.stonkhouse.fun` | ARG default, same value. Used as `metadataBase` |
| `NEXT_PUBLIC_DOCS_URL` | `https://docs.stonkhouse.fun` | ARG default, same value. Footer link to the GitBook docs |
| `NEXT_PUBLIC_DEV_PREVIEW` | `1` for the separate dev app build only | ARG default `0`. Dev builds show a DEV PREVIEW banner and trade warning, return noindex headers/metadata and no sitemap, and disallow crawling in `robots.txt`. Set `NEXT_PUBLIC_APP_URL=https://dev.app.stonkhouse.fun` alongside it; rebuild after changing either value |

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
curl -s https://app.stonkhouse.fun/api/keeper/orders | head -c 300
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

### `app.stonkhouse.fun`

A subdomain. Plain `CNAME`, works at every registrar.

```
Type   Name   Value
CNAME  app    <target>.up.railway.app
TXT    _railway-verify.app   <value Railway shows>
```

TLS is issued by Railway (Let's Encrypt, 90 days, auto-renewed) once the record resolves. Expect a
few minutes. If CAA records are ever added to the zone, allow `letsencrypt.org` (Railway) and
`pki.goog` (GitBook, for `docs.`).

### `stonkhouse.fun` and `www` — the landing's records, documented with the landing

The apex and `www` attach to the `site` service, and the full step is in the
`stonkhousedotfun/callhouse-site` README. One fact is repeated here because it lives in the same DNS zone as
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
curl -sI https://app.stonkhouse.fun/        | head -1     # HTTP/2 200

# 2-4. The landing's checks (no wallet code, absolute CTAs into the app, its four routes)
#      moved with the landing to the stonkhousedotfun/callhouse-site README.

# 5. THE ONE THAT MATTERS: which vault did this image get baked with?
curl -s https://app.stonkhouse.fun/vault/nvda | grep -oiE '0x[0-9a-f]{40}' | sort -u
```

Take the addresses from step 5 and diff them against `ops/addresses.json`. If the vault address is
absent, the page will be showing "not configured" and `NEXT_PUBLIC_VAULT` was not set **at build
time**. Setting it now and restarting changes nothing; see §6.

Then look at the page itself: the vault card renders, an unfilled week shows as `unfilled, 0`
rather than an error, and the layout does not scroll sideways at 400px.

`scripts/copy-lint.mjs` is a CI gate on `web/`, not a deploy gate; its twin gates the landing in
`stonkhousedotfun/callhouse-site` the same way. A deploy cannot introduce a copy violation that CI did not
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
`stonkhouse.fun` can sit on last week's build while `app.stonkhouse.fun` ships.

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

2. **A `CNAME` at the apex is invalid DNS.** `stonkhouse.fun` needs Cloudflare's CNAME
   flattening. Do not pin an A record to an IP you resolved yourself. (The landing's record; the
   full step is in the `stonkhousedotfun/callhouse-site` README, §4 here has the summary.)

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
| `stonkhousedotfun/callhouse-site` README | The landing: its image, Railway service, variables and the apex-domain DNS step |
| [`../.dockerignore`](../.dockerignore) | What reaches the build context, and what must stay in |
| [`../web/.env.example`](../web/.env.example) | Authoritative list of what `web/` reads |
| [`addresses.json`](addresses.json) | The address book. Diff §5 step 5 against it |
| [`go-live-app.sh`](go-live-app.sh) | Sets the variables and deploys all four services in order once the vault exists (§13) |
| [`go-live-v2.sh`](go-live-v2.sh) | Creates, configures and deploys the v2 services once the v2 contracts are written back into the registry; dry run by default (§15) |
| [`v2/env/`](v2/env) | The v2 services' public variables, generated by [`v2-env.mjs`](v2-env.mjs) from the registry (§15.3) |
| [`v2/derive-bot-keys.sh`](v2/derive-bot-keys.sh) | The four v8 bot keys (mnemonic indices 60–63) into `~/.callhouse-keys/v8/`, their addresses into the registry (§15.6). v7's keys (50–52) stay in `~/.callhouse-keys/v2/` |
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

**Per-market keepers.** This section is the `keeper` service as deployed for NVDA, and since Tier
1 that service is the **closed pooled vault only**: `VAULT` set, `WIND_DOWN=1`, never `FACTORY`.
The NVDA **factory** has its own keeper, the service `keeper-nvda`, rendered from
`ops/keeper/markets/NVDA.env` (`KEEPER_PRICING_MODE=vol`, `KEEPER_MIN_ASK_USDG6=100000`, its own
volume) exactly like every other market: each market runs the **same image** as its own service
`keeper-<ticker>`, with env-only differences and no vault. §14.2 is that variable set, and §14.5
the order in which the services come up. Nothing in this section changes for them except the
variables. `FACTORY` must come off `keeper` **before** `keeper-nvda` starts: both use the NVDA hot
key (mnemonic index 1), and two processes on one key against one factory collide on nonces and
double-send `setWeek` — the failure the next paragraph exists to prevent.

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
| `WIND_DOWN` | `1` | the vault is closed: never arm or list, still `lockBook` / `rollClose` / `settleQueue` so queued redemptions pay. `FACTORY` is **not set on this service**: the NVDA factory keeper is `keeper-nvda` (§14.2), and the factory pricing variables (`KEEPER_MIN_ASK_USDG6`, `KEEPER_PRICING_MODE`) live in its generated env, not here |
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
5. Verify: `railway ssh --service keeper -- node -e "fetch('http://127.0.0.1:8787/health').then(async r=>console.log(r.status,await r.text()))"` answers
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

**Per-market indexers.** This is the `indexer` service as deployed for NVDA. Every other market
runs the same image as its own service `indexer-<ticker>` against that market's factory
(`FACTORY_ADDRESS`, `MARKET`, `START_BLOCK`), all on the **one** Postgres, each deployment in its
own schema exactly as 11.3 describes. §14.3 is the variable set.

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
| `PONDER_RPC_URL_4663` | an archive endpoint; production uses `https://robinhood-mainnet.g.alchemy.com/v2/<key>` | **required.** Backfill runs historical `eth_getLogs` **and** `eth_call` at past blocks. `rpc.mainnet.chain.robinhood.com` answers "metadata is not found" on a historical `eth_call`, and a backfill against it stalled at 0% on 2026-09-15. **Never** the publicnode backup either; it refuses archive queries without a token. The URL carries the API key, so treat it as a secret |
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
| Draining | `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=12` so an in-flight webhook can finish before Railway stops the old instance |

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
hostname does not resolve, and the sealed token is not handed to `railway run` anyway. The image is
`bookworm-slim` and has neither `curl` nor `wget` (§15.11 item 10), so `node` sends it; the URL and the
token stay in the container's environment and never reach a command line.

```bash
railway ssh --service keeper -- node -e 'fetch(process.env.ALERT_WEBHOOK,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+process.env.ALERT_WEBHOOK_TOKEN},body:JSON.stringify({source:"callhouse-keeper",kind:"boot",severity:"info",message:"relay wiring test",data:{}})}).then(async r=>console.log(r.status,await r.text())).catch(e=>console.log("ERR",e.message))'
# 200 {"ok":true,"delivered":["discord"],"failed":[]}   and the message is in the channel
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

The contract-side runbook is `contracts/docs/DEPLOY.md` (stonkhousedotfun/callhouse-contracts), deployed
from the release tag on branch `redesign/a2-own-strikes-2026-09-13` or its successor. The parts an
app operator needs to know, so the two runbooks agree:

| Fact | Detail |
|---|---|
| Scripts | `DeployClear.s.sol` (**optional**: our own ValoremOptionsClearinghouse from the vendored upstream artifact, `feeTo` = our admin) → `Deploy.s.sol` (preflight: decimals 18/6, Clear `feeBps == 15` and switch off, Seaport 1.6 with the canonical ConduitController, feed; then both libraries by CREATE2 and the vault; **no registry and no zone argument**, the zone is the vault) → `Verify.s.sol` → `Configure.s.sol` → later `HandoverAdmin.s.sol` |
| Factory scripts (the live product) | `DeploySolo.s.sol` deploys one `AccountFactory` + `WriterAccount` implementation for one Stock Token (`ASSET`, `PRICE_FEED`, `DEPOSIT_CAP`, shared `CLEARINGHOUSE` / `SEAPORT` / `USDG`, `ADMIN`, `SAFE_FEE`), with a preflight that pins `EXPECTED_TICKER` to the token's `symbol()`, checks the feed's description / decimals / freshness and probes `uiMultiplier` / `oraclePaused` → `ConfigureSolo.s.sol` (`FACTORY`, `KEEPER`, `GUARDIAN`, `ADMIN_PK`, `DEPOSIT_CAP`: the role grants and the per-account cap) → `VerifySolo.s.sol`. `DeploySoloBatch.sh --tickers A,B` or `--wave <wave>` runs the three per market in `--rehearse`, `--dry-run` or `--broadcast` mode and **writes `deployment.factory` / `implementation` / `deployBlock` / `deployTx` / `sourcify` / `configuredAt` back into the registry**. Run it from the contracts repository: the registry defaults to `../callhouse/ops/markets/tier1.json` relative to the contracts root (if you pass `--registry`, give an absolute path — the script `cd`s before resolving it), `--rehearse` needs a local anvil (`--rpc http://127.0.0.1:8546`, started with `--code-size-limit 98304`), and the owner's run is `--broadcast --rpc $RH_RPC`. Broadcasts are the owner's; nothing in this repository sends one |
| Verify counts | **63** bootstrap-unconfigured, **69** bootstrap-configured, **72** safe phase with the owner set pinned, **71** without; 8 library link sites read from the artifact. Any FAIL is a stop. `VerifySolo.s.sol` has its own count per factory; likewise any FAIL is a stop |
| Sizes | Vault runtime 25,470 B at `ca0e985` (above EIP-170's 24,576 B, fine on chain 4663 whose limit is **98,304 B**; re-measure with `forge build --sizes` after any re-pin); ValoremLib 5,993 B, SeaportOrderLib 5,170 B |
| Rehearsal | `script/rehearse-deploy.sh` against `anvil --fork-url … --chain-id 4663 --code-size-limit 98304`. A default anvil **refuses** the vault |
| Broadcast flags | `--no-storage-caching` on **every** `forge script` (forge's fork cache can hand a mainnet run rehearsal state; `rm -rf ~/.foundry/cache/rpc/4663` first); `--non-interactive` on the deploys (forge stops at an EIP-170 confirmation prompt for the 25 KB vault, fatal on a non-terminal); `--slow` |
| Source verification | **Sourcify**: `forge verify-contract --verifier sourcify --chain 4663 <addr> <contract>` for the vault (with both `--libraries`) and each library, or `--verify --verifier sourcify` on the deploy; then Blockscout → "Verify & publish → via Sourcify" imports the match. Blockscout's own API sits behind a Cloudflare challenge `forge` cannot pass: **do not** use `--verifier blockscout`, and `ops/bsproxy.js` is no longer part of the deploy (it remains a handy Referer-injecting proxy for reading the explorer API) |
| Library addresses | CREATE2 through `0x4e59b44847b379578588920cA78FbF26c0B4956C`, fixed by bytecode: at `ca0e985` SeaportOrderLib `0x6B617a0B578Ef6EDCD07774468f08b3778272D8A`, ValoremLib `0xd3CB94893EAb55e425cCd77Db98458b38D75Fa3d`. They change with every library byte |
| Clearinghouse | the vault settles on whichever Clear it was constructed with (`vault.clear()`). Default: Overcall's unmodified instance `0x9a7b…C0C0`. If A0 deployed our own, set `CLEARINGHOUSE` on the keeper and indexer and `NEXT_PUBLIC_CLEARINGHOUSE` on web to that address, and record it in `ops/addresses.json` → `ours.clearinghouse` |
| Cycle timing | the vault reads exercise and expiry from the option type; the keeper anchors the week on the US close, Friday 16:00 ET (20:00 UTC in DST, 21:00 UTC otherwise; Thursday's close on a Friday NYSE holiday). Nothing in the app hard-codes a UTC hour |

After the contracts are on chain, in this repository:

1. `ops/addresses.json`: fill `chains.4663.ours` (vault, both libraries, clearinghouse, Safes,
   guardian, keeper, deploy block, admin phase). For a **factory** market the batch script already
   wrote `deployment.*` into `ops/markets/tier1.json`, which is the record; `addresses.json` →
   `ours.factories` holds only the first factory (NVDA) and is not extended per market.
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

---

## 14. Many markets

One factory per Stock Token, one keeper process and one indexer process per factory, one web build
for all of them, one docs page rendered from one registry. `ops/markets/tier1.json` (read
[`markets/README.md`](markets/README.md) first) is the only place a market is defined; every
service below is configured **from** it and none of them hard-codes a ticker. §10 and §11 still
describe each service's mechanics (image, volume, schema, healthcheck, sharp edges); this section
is what changes when there are 35 of them. The design, and the reasons behind "one process per
market", are in [`../docs/TECHSPEC-TIER1-MULTIMARKET.md`](../docs/TECHSPEC-TIER1-MULTIMARKET.md).

**Two things that do not change, and one that does.** The NVDA `indexer` keeps its env and is not
redeployed. The NVDA `keeper` service **changes role, once**: it becomes the closed pooled vault's
wind-down process (`VAULT`, `WIND_DOWN=1`, `FACTORY` removed), and the NVDA factory's weeks move to
a new service `keeper-nvda`, created from `ops/keeper/markets/NVDA.env` by the same
`ops/keeper-railway.sh` flow as every other market (§14.5 step 5). Until `keeper-nvda` boots, the
NVDA factory has no keeper; its first `setWeek` prices `vol` with the registry floor
(`KEEPER_MIN_ASK_USDG6=100000`, 0.10 USDG — the keeper's compiled default is 1 USDG, so the
variable matters). And nothing in this section broadcasts a transaction: the factory deploys are
the owner's, from the contracts repository.

### 14.0 The shape of it

```
ops/markets/tier1.json ─┬─► contracts: script/DeploySoloBatch.sh --registry … --wave <wave>
                        │       one AccountFactory per market; writes deployment.factory /
                        │       implementation / deployBlock / deployTx back into the registry
                        ├─► ops/keeper-env.sh ──► ops/keeper/markets/<TICKER>.env ──► ops/keeper-railway.sh
                        │       Railway service keeper-<ticker>   keeper/Dockerfile, replicas 1, own volume
                        ├─► indexer env: FACTORY_ADDRESS, MARKET, START_BLOCK
                        │       Railway service indexer-<ticker>  indexer/Dockerfile, replicas 1, shared Postgres
                        ├─► web: pnpm gen:markets ──► web/lib/markets.generated.ts   ONE web service, one build
                        │       /<ticker>/account, /<ticker>/book; /account and /book → /nvda/*
                        └─► ops/markets/render-docs.mjs ──► callhouse-docs/product/markets.md (+ docs/ mirror)
```

### 14.1 Service layout

| Service | Image | How many | Differences between instances | State |
|---|---|---|---|---|
| `keeper-<ticker>` | `keeper/Dockerfile`, the §10 image unchanged | one per live market | **env only** (14.2) | one volume per service at `/data`; replicas **1**. §10's "exactly one instance" is per key, and there is now one key per market, so 35 keepers are 35 single instances, not a scaled service |
| `indexer-<ticker>` | `indexer/Dockerfile`, the §11 image unchanged | one per live market | **env only** (14.3) | **one shared Postgres** (the existing plugin). Each deployment indexes into its own schema named after `RAILWAY_DEPLOYMENT_ID` (11.3), so 34 services on one database never collide. The `ponder_sync` RPC cache is shared across them, which is a saving (one block fetched once), not a hazard |
| `web` | `web/Dockerfile` | **one** | none: one build serves every market from `web/lib/markets.generated.ts` (14.4) | none |
| `relay` | unchanged | one | every keeper posts to the same relay; the alert carries `KEEPER_MARKET` | none |
| `indexer` (NVDA) | as today | one | untouched | as today |
| `keeper` (NVDA vault) | `keeper/Dockerfile` | one | the closed pooled vault only: `VAULT` + `WIND_DOWN=1`, `FACTORY` removed **before** `keeper-nvda` starts (both use the NVDA key, index 1) | as today |

`keeper-nvda` is not a special case: NVDA is a live market, so its factory keeper is one of the
`keeper-<ticker>` row above, rendered from `ops/keeper/markets/NVDA.env` (`vol`,
`KEEPER_MIN_ASK_USDG6=100000`, `KEEPER_DB_PATH=/data/keeper-nvda.db`).

Naming: lowercase ticker, `keeper-tsla`, `indexer-tsla`. The service name is the private hostname
(`keeper-tsla.railway.internal`) and the key every alert, runbook loop and dashboard uses, so keep
it exact. Watch paths are §1's, per service.

### 14.2 `keeper-<ticker>` variables

Generated, not typed. `ops/keeper-env.sh` reads the registry and writes one file per market,
`ops/keeper/markets/<TICKER>.env` (the README in that directory documents the file); it never
contains a key. `ops/keeper-railway.sh` creates the service and sets the variables from that file,
**dry-run by default**: it prints the plan and touches nothing until run with the flag it
documents. The hot key lives in `~/.callhouse-keys/markets/<TICKER>.env` (mode 600, from
`ops/markets/derive-keeper-keys.sh`, mnemonic indices 10–43) and goes onto the service as a
**sealed runtime variable**, exactly as `KEEPER_PK` does on `keeper` (10.2). Never paste a key
into any file under the repository, and never print one. The generated file is the authoritative
variable set — the table below summarises it — and `ops/keeper-env.sh --check` is the drift gate
between the files and the registry (§14.5 step 5, §14.6).

| Variable | From the registry | Notes |
|---|---|---|
| `FACTORY` | `deployment.factory` | **required.** The market's `AccountFactory`. This is a **factory-only process**: it sets the week, lists pending accounts, settles expired ones; it has no vault to roll |
| `VAULT` | unset | **Leave unset.** `VAULT` is set only on the NVDA `keeper`, the closed pooled vault's wind-down process (`WIND_DOWN=1`). A per-market keeper refuses nothing without it: `VAULT` is optional in the factory-only process |
| `KEEPER_MARKET` | `ticker` | the ticker, carried in logs, alerts and `/health` so 35 services are told apart |
| `PRICE_FEED` | `feed` | the market's Chainlink proxy. Cross-checked against `factory.priceFeed()` at boot; a mismatch is fatal |
| `ASSET` | `asset` | the Stock Token. Cross-checked against `factory.asset()` |
| `KEEPER_PK` | `~/.callhouse-keys/markets/<TICKER>.env` | **sealed, runtime only.** Holds gas and `KEEPER_ROLE` on **this** factory alone. Fund ~0.05 ETH; the address is `deployment.keeper` in the registry |
| `KEEPER_PRICING_MODE` | `mode` | `vol` or `fixed`, **per market**, from the registry's evidence (SGOV is the only `fixed`; `modeOverride` forces one by hand) |
| `KEEPER_VOL_URL`, `KEEPER_VOL_ROOT` | `cboe.url`, `cboe.root` | vol mode: **this** market's Cboe chain, not NVDA's. The container needs outbound https to `cdn.cboe.com` |
| `KEEPER_MIN_ASK_USDG6` | `minAskUsdg6` | **v1 factory keeper only:** its ask is never below this. The registry value is `100000` (0.10 USDG); the keeper's compiled default is **1 USDG** (the floor the first factory keeper hard-coded), so the variable **must be set** — the generated file sets it on every market, NVDA included. The v2 MM bot does not read it |
| `KEEPER_STRIKE_OTM_BPS` | `strikeOtmBps` | fixed mode: strike = spot × (1 + bps/1e4), whole USDG |
| `KEEPER_TARGET_DELTA`, `KEEPER_PRICE_EDGE_BPS`, `KEEPER_PREMIUM_MARGIN_BPS` | `targetDelta`, `priceEdgeBps`, `premiumMarginBps` | vol knobs; the registry rows carry the keeper defaults unless an operator changed one |
| `RH_RPC`, `RH_RPC_2`, `CLEARINGHOUSE`, `SEAPORT`, `USDG` | `shared` + chain-wide defaults | as 10.2. `CLEARINGHOUSE` is our Clear `0x53d7…C6`, the one every factory is constructed with; the boot cross-check against `factory.clear()` catches a mismatch. `MULTICALL3` and `CHAIN_ID` are **not** in the generated file; the compiled defaults are correct for chain 4663 |
| `PORT`, `KEEPER_PORT`, `POLL_INTERVAL_MS` | `8787`, `60000` | chain-wide constants the generator writes out so the file is the whole environment. Whether `web` reads a per-market keeper's `/orders` is the web lane's decision; if it does, it is one `KEEPER_ORDERS_URL`-shaped runtime variable per market on `web`, documented in §3 when it exists |
| `ALERT_WEBHOOK`, `ALERT_WEBHOOK_TOKEN` | the relay | as 12.3; the **same** relay for every market. The generator writes `ALERT_WEBHOOK`; `ALERT_WEBHOOK_TOKEN=${{relay.RELAY_TOKEN}}` goes on the service, not in the file |
| `KEEPER_DB_PATH` | `/data/keeper-<ticker>.db` | one SQLite file per market on this service's own volume. The generator sets it explicitly so two services can never share a database by falling back to the compiled default |
| everything else in `keeper/README.md` | unset | defaults |

Railway settings are §10.1 verbatim: root directory empty, `RAILWAY_DOCKERFILE_PATH=keeper/Dockerfile`,
replicas 1, volume at `/data`, `RAILWAY_RUN_UID=0`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=120`,
healthcheck `GET /health` with `RAILWAY_HEALTHCHECK_TIMEOUT_SEC=300`. No public domain.

**Per-market dry run before the service exists:** `pnpm --filter @callhouse/keeper solo:quote`
with `ops/keeper/markets/<TICKER>.env` loaded prints the week the keeper would set (strike, ask,
window, mode and the vol evidence or the `vol-*` refusal) without sending anything. Run it for
every market of a wave before `keeper-railway.sh`; a market whose quote is refused is a market
whose Cboe chain or feed needs looking at, not a service to create.

### 14.3 `indexer-<ticker>` variables

| Variable | Set to | Notes |
|---|---|---|
| `FACTORY_ADDRESS` | `deployment.factory` | **required.** The indexer follows the factory (`AccountCreated`, `WeekSet`, `WritesHalted`, …), its accounts (`LotsListed`, `LotFilled`, `Settled`, …), Seaport's fills for those accounts and the Clear's events for their option types |
| `MARKET` | the ticker | **required in practice.** `indexer/lib/env.ts` defaults it to `NVDA`, so a service deployed without it still boots, backfills the right factory and then answers `ticker: NVDA` on `/v1/market` — set it on every per-market service, and let the §14.6 check prove it. Served on `/v1/market` so a consumer can prove which market an API answers for before it trusts a number |
| `VAULT_ADDRESS` (alias `VAULT`) | unset | **Leave unset** on a per-market indexer: optional in the factory deployment. Set only on the NVDA `indexer` |
| `START_BLOCK` | `deployment.deployBlock` | **required.** The market's own factory deploy block; nothing earlier, and never a guess (11.6 item 2) |
| `PONDER_RPC_URL_4663` | the keyed archive endpoint | as 11.2. Backfills from recent deploy blocks are small; one key serves every service |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | the **same** Postgres for every market; the schema is per deployment (11.3), so nothing collides |
| `DATABASE_SCHEMA` | unset | as 11.2 |
| `PORT` | `42069` | one public domain per service. The readers are operators and dashboards (14.6): the web app reads the factory and its accounts over RPC with wagmi, not this API (14.4) |
| `CLEARINGHOUSE`, `SEAPORT`, `USDG`, `MULTICALL3` | unset | shared defaults, as 11.2 |
| `END_BLOCK`, `LIVE_READ_TIMEOUT_MS`, `PONDER_LOG_LEVEL` | unset | as 11.2 |

Routes a per-market indexer serves: `/v1/market`, `/v1/market/weeks`, `/v1/market/fills`,
`/v1/market/accounts/:address`, plus `/v1/health` and Ponder's `/ready` (the healthcheck, 11.4).
Railway settings are §11.1 verbatim, one public domain per service. Note that `ponder db prune`
(11.3) run from any one service drops every Ponder schema on the database that no live instance
holds, across markets; that is harmless (old deployments' tables) but the count will surprise you.

### 14.4 `web`

One service, one build. `pnpm gen:markets` in `web/` renders `web/lib/markets.generated.ts` from
the registry (`ticker`, `name`, `asset`, `feed`, `deployment.factory`, `deployment.deployBlock`,
`status`, `mode`, `cboe.root`), so the image knows every market with no `NEXT_PUBLIC_FACTORY` per
market; `lib/markets.ts` is the typed accessor and `NEXT_PUBLIC_FACTORY` / `NEXT_PUBLIC_ASSET`
still move only the default (NVDA) market, for forks. Routes: `/<ticker>/account` and
`/<ticker>/book` (lowercase); `/account` and `/book` redirect to `/nvda/*`; a market switcher in
the nav lists the live markets; `/vault/nvda/*` (the closed vault's collect flow) is untouched.
A planned market renders nothing: no route, no switcher entry. Adding a market to the web is:
the registry row goes `live` → `pnpm gen:markets` → commit → `web` rebuilds (§6: build-time). The
pages read the factory and its accounts over RPC; the per-market indexer domains (14.3) serve
operators and dashboards (14.6), not the web build.

### 14.5 Rollout order and the wave gates

Waves, from the registry's `waves`: **canary** TSLA, AAPL → **wave1** MSFT, META, GOOGL, AMZN,
AMD, ORCL, PLTR, COIN, MSTR, TSM, QQQ, SPY → **wave2** the remaining 20. NVDA is `live` and is
not redeployed. Per wave, in this order:

1. `node ops/markets/build-markets.mjs --check` is green (every address re-verified on chain, no
   drift, no failing market).
2. Keys: `ops/markets/derive-keeper-keys.sh <TICKERS>` for any row without `deployment.keeper`
   (all 34 have one today); fund each `deployment.keeper` address with ~0.05 ETH. The keys never
   leave `~/.callhouse-keys/markets/`.
3. Contracts, from the contracts repository: `script/DeploySoloBatch.sh --wave <wave> --rehearse
   --rpc http://127.0.0.1:8546` against an anvil fork started with `--code-size-limit 98304` (the
   registry defaults to `../callhouse/ops/markets/tier1.json` from the contracts root; pass
   `--registry` only as an absolute path). Read every preflight line (`EXPECTED_TICKER` = the
   token's `symbol()`, feed description / decimals / freshness, `uiMultiplier` / `oraclePaused`).
   Then `script/DeploySoloBatch.sh --wave <wave> --broadcast --rpc $RH_RPC`, **run by the owner**.
   It writes `deployment.factory`, `implementation`, `deployBlock`, `deployTx`, `sourcify` and
   `configuredAt` back into the registry; `ConfigureSolo.s.sol`
   grants `KEEPER` (that market's key) and `GUARDIAN` and sets `DEPOSIT_CAP`; `VerifySolo.s.sol`
   must PASS for each factory.
4. Set `status: "live"` on the wave's rows; commit the registry with the receipts.
5. Keepers: `ops/keeper-env.sh` → `ops/keeper/markets/<TICKER>.env`; `ops/keeper-env.sh --check`
   green; `solo:quote` per market; `ops/keeper-railway.sh` (dry-run, read the plan, then for
   real); seal `KEEPER_PK` on each new service; watch each boot for the `factory wiring verified`
   log line and the `boot` alert naming the market (`reconciled against chain state` is the vault
   process's boot line; a factory-only keeper never prints it); `/health` `ok` with
   `keeper.hasKeeperRole: true`. The **canary wave** also creates `keeper-nvda` from
   `ops/keeper/markets/NVDA.env`: remove `FACTORY` from the `keeper` service and set `WIND_DOWN=1`
   there **before** `keeper-nvda` starts — both use the NVDA hot key (index 1), and two processes
   on one key against one factory is §10's nonce-collision failure on the only live market.
6. Indexers: one `indexer-<ticker>` per market with 14.3; wait for `/ready` 200; `/v1/market` must
   name the factory and the ticker.
7. Web: `pnpm gen:markets`, commit, rebuild `web`; open `/<ticker>/account` and `/<ticker>/book`
   for each new market; the switcher lists them. (The copy-lint gate was removed on 2026-09-21.)
8. Docs: `node ops/markets/render-docs.mjs`, commit the page in callhouse-docs (a push
   **publishes**: do it when the wave is live, not before), then `--check` green.
9. One full weekly cycle on the new markets: each keeper's `setWeek`; at least one
   `requestWrite` + `listFor` per market (the owner's own account at 1 lot, as the NVDA canary
   did); one fill from a second wallet on `/<ticker>/book`; the Friday close; `settle()` on every
   listed account; the publish per market.

**The gate to the next wave**, every box on every market of the wave, over that one cycle:

- [ ] **zero keeper failures**: no `tx_revert`, `keeper_error` or `cycle_not_created` alert from
      any `keeper-<ticker>` (`phase_stuck` belongs to the vault process; a factory keeper's
      "week not set" alert is `cycle_not_created`, and one whose reason is `stale-oracle` or
      `vol-stale` inside the Friday-close-to-Monday window is the one allowed exception);
      `/health` `ok` on each throughout the cycle
- [ ] **no stale-price skips outside the weekend windows**: a `stale-oracle` / `StalePrice` /
      `vol-stale` skip (the Cboe chain sleeps over the weekend with the equity market) is
      acceptable only between the Friday close and the Monday feed restart (`README.md` "Six
      things", item 5); any skip at another time is a stop
- [ ] **indexer backfill complete**: every `indexer-<ticker>` `/ready` 200, and `/v1/market`
      correct (factory, ticker, week id and strike equal to `week()` on chain)
- [ ] **docs updated**: the page regenerated and pushed; `render-docs.mjs --check`,
      `build-markets.mjs --check` and `ops/keeper-env.sh --check` all green
- [ ] the publish for the week done per market, including `unfilled, 0`

A wave that fails a gate stays where it is: fix, run another full cycle, gate again. Do not start
the next wave's deploy to save a week; the point of the waves is that a defect in the shared code
path shows up on two markets before it shows up on twelve.

### 14.6 What to check after each wave

Per market, once, after the wave's first cycle:

```bash
T=tsla   # lowercase for Railway service names and app routes; the registry uses uppercase
railway ssh --service keeper-$T -- node -e "fetch('http://127.0.0.1:8787/health').then(async r=>console.log(await r.text()))" | jq '.status, .keeper'
curl -s -o /dev/null -w '%{http_code}\n' https://<indexer-$T domain>/ready                  # 200
curl -s https://<indexer-$T domain>/v1/market | jq '.market.factory, .market.ticker'              # this factory, and ticker == the service's market (MARKET defaults to NVDA when unset — check it, don't assume it)
curl -s https://app.stonkhouse.fun/$T/book | grep -oiE '0x[0-9a-f]{40}' | sort -u             # this market's factory / token / feed and the shared contracts, nothing else
```

Diff the last line against the market's registry row. And once per wave: every keeper address
holds gas (`cast balance`), every factory's `writesHalted()` is `false`, the three `--check`s are
green (`build-markets.mjs`, `render-docs.mjs`, `ops/keeper-env.sh`), and the external `/health`
monitor (`alerts.md` §11) covers every new keeper. On the canary wave also confirm the split NVDA
layout: `keeper` answers `/health` as the vault wind-down (no factory) and `keeper-nvda` answers
with `market: "NVDA"` and `keeper.hasKeeperRole: true`. A keeper
wedge on one market is still invisible to Railway (10.7 item 6); with 35 of them, the monitor is
the only thing that notices.


---

## 15. v2 services

§10–§14 describe v1: one keeper and one indexer per product, keys per market. v2 (plan
`01-architecture.md` §4) is one set of contracts for every market, so it is one set of services
for every market, and none of them is per ticker. They run **beside** the v1 services until the v1
run-off switches those off (`runbooks/v1-runoff.md`, O2-05); nothing in §10–§14 changes for them.

Everything here is the owner's to run. `ops/go-live-v2.sh` is the script (dry run by default,
§15.8 is its recorded dry run), `ops/v2/env/*.env` the variables it sets, `ops/v2/derive-bot-keys.sh`
the keys. The contracts must be deployed and written back into the registry first
(contracts `script/v2/DeployV2Batch.sh`, C2-13); the script refuses a registry whose `v2` block
still has nulls.

### 15.0 The shape of it

```
browser ──► app.stonkhouse.fun ─────► "web"         web/Dockerfile       NEXT_PUBLIC_V2=1 build; addresses from
        │                                                                 web/lib/markets.generated.ts, never env
        ├─► <indexer-v2 domain> ────► "indexer-v2"  indexer/Dockerfile   Ponder, /v2/*, /ready      (§15.1)
        └─► notify.stonkhouse.fun ──► "notifier"    notifier/Dockerfile  subscriptions API, Telegram poller

Railway private network, http://<service>.railway.internal:<port>, runtime only:
  indexer-v2 ─── PRICING_URL ──► pricing :8790        keeper/Dockerfile  V2_MODE=pricing   no key, no volume
  cranker :8792 ─ INDEXER_URL ─► indexer-v2 :42069    keeper/Dockerfile  V2_MODE=cranker   CRANKER_PK, /data
  pricer  :8794 ─ PRICING_URL, INDEXER_URL ─►         keeper/Dockerfile  V2_MODE=pricer    PRICER_PK, /data
  mm-bot  :8793 ─ PRICING_URL, INDEXER_URL ─►         keeper/Dockerfile  V2_MODE=mm        MM_QUOTER_PK, /data, /kill
  notifier ────── INDEXER_URL ─► indexer-v2 :42069
  cranker, pricer, mm-bot ── ALERT_WEBHOOK ──► relay :8080 ──► Discord / Telegram (operators, §12)
  indexer-v2, notifier ───── DATABASE_URL ───► Postgres (the existing plugin; indexer-v2 in a schema
                                                per deployment, notifier in schema "notifier")
```

Four services run the **same keeper image** as the v1 keepers (`keeper/src/index.ts`: `V2_MODE`
unset is v1, set is `keeper/src/v2`); only the environment differs. Every service keeps §1's rule:
Root Directory empty, build context the repo root, `RAILWAY_DOCKERFILE_PATH` a variable, settings in
the UI (config-as-code is dead, header), no Start Command (§9 item 10: every image's `CMD` already
execs node as PID 1).

### 15.1 Service layout

| Service | Dockerfile | Port (`PORT` =) | Healthcheck | Replicas | Volume | Public networking | Draining / uid |
|---|---|---|---|---|---|---|---|
| `indexer-v2` | `indexer/Dockerfile` (exists, the §11 image) | 42069 | `/ready`, 3600 s | **1** | none | **generated domain** → `web`'s `NEXT_PUBLIC_API_URL` | 30 s |
| `pricing` | `keeper/Dockerfile` (carries the registry, §15.2) | 8790 (`PRICING_PORT`) | `/health`, 120 s | 1 (stateless; 2 is safe) | none | none | 30 s |
| `cranker` | `keeper/Dockerfile` (carries the registry, §15.2) | 8792 (`CRANKER_PORT`) | `/health`, 300 s | **1** | `/data` | none | 120 s, `RAILWAY_RUN_UID=0` |
| `pricer` | `keeper/Dockerfile` (carries the registry, §15.2) | 8794 (`PRICER_PORT`) | `/health`, 300 s | **1** | `/data` | none | 120 s, `RAILWAY_RUN_UID=0` |
| `mm-bot` | `keeper/Dockerfile` (carries the registry, §15.2) | 8793 (`MM_PORT`) | `/health`, 300 s | **1** | `/data` | **never** | 120 s, `RAILWAY_RUN_UID=0` |
| `notifier` | `notifier/Dockerfile` (exists, N2-01) | 8791 | `/health`, 60 s | **1** | none | **`notify.stonkhouse.fun`** | 30 s |
| `relay` | `relay/Dockerfile` (exists, §12) | 8080 | `/health`, 60 s | 1 | none | none | unchanged |
| `web` | `web/Dockerfile` (exists; needs §15.5) | 3000 | `/`, 120 s | 1 | none | `app.stonkhouse.fun` | unchanged |

Healthcheck path, restart policy (`On Failure`, 10 retries) and replicas are UI
settings; the script prints them as a TODO per service. These v2 services are
uploaded by `railway up` from a reviewed `--ref` clone. They have no GitHub or
image source and **no automatic watch-path rebuild**. When code or the registry
changes, review and push the new commit, then run `go-live-v2.sh --apply --ref
<new-SHA> --services <affected-services>` again. The script refuses a connected
repo or image source, including the existing `web` service until the owner
disconnects that source in the Railway UI. This prevents a later public `main`
push from bypassing the reviewed SHA and the expiry-window guard.

What each healthcheck means (all deploy-time only, §5; the uptime and chain monitor is §15.12):

- `indexer-v2`: Ponder's `/ready`, 503 until the backfill from `V2_START_BLOCK` is done, exactly
  §11.4. The v2 deploy block is recent, so a first backfill is short. Uptime: `/v2/health`
  (`ok | lagging | degraded`, no cache).
- `cranker`, `pricer`, `mm-bot`: `keeper/src/v2/health.ts`, v1's rule: **503 only when the loop is
  wedged** (no heartbeat for three poll intervals, no tick in flight); low gas or a lagging RPC is
  `degraded` on a 200 and pages through the relay; `starting` for the first three intervals.
- `pricing`: 200 while it serves; `degraded` when its market data is stale.
- `notifier`: 200 while it serves, `status: ok | degraded` with the database and per-channel
  breakers in the body.

**Why one replica, service by service.**

- `cranker`: every call it makes is permissionless and idempotent (ADR-06), so a second cranker is
  harmless to users: its simulation sees the work already advanced and sends nothing, and when two
  race, the loser's transaction is a no-op that **wastes gas**. On the **same key** it is worse:
  nonce collisions (§10). A second cranker for resilience runs with a different key and is a
  separate service, not a replica (the O2-03 drill).
- `pricer`, `mm-bot`: one key each, so one process each (nonces). The MM bot's inventory and loss
  limits are also per process.
- `notifier`: the Telegram channel long-polls `getUpdates` in process; a second poller on the same
  bot token gets 409 and waits (`notifier/src/channels/telegram.ts`). During a redeploy Railway keeps
  the old container until the new one is healthy, so a short 409 in the logs is expected once.
- `indexer-v2`: a second replica is a second Ponder app on its own schema, double the RPC load for
  nothing (§11.1).
- `pricing`: stateless. Private DNS answers with every replica, each with its own Cboe cache; two
  are safe, one is enough.

**`mm-bot` never gets a public domain.** Its kill switch (`POST /kill`, `Authorization: Bearer
<MM_KILL_TOKEN>`) is on `MM_PORT`, the same port as `/health`; a domain would put it on the internet
behind nothing but its token. The only callers are `railway ssh --service mm-bot` and services in
this project. `go-live-v2.sh` refuses to deploy `mm-bot` while it has a domain. The command, with the
token read inside the container and never typed (`ops/alerts.md` §V11 has the answers; `/resume` is the
same without a body):

```bash
railway ssh --service mm-bot -- node -e 'fetch("http://127.0.0.1:8793/kill",{method:"POST",headers:{authorization:"Bearer "+process.env.MM_KILL_TOKEN,"content-type":"application/json"},body:JSON.stringify({reason:"on-call"})}).then(async(r)=>console.log(r.status,await r.text()))'
```

**`indexer-v2` is v2 only.** Same image as §11, configured with the `V2_*` addresses and
`V2_START_BLOCK` and nothing else: no `VAULT_ADDRESS`, `FACTORY_ADDRESS` or `START_BLOCK` (the
script refuses them). `DATABASE_SCHEMA` stays **unset**, as §11.3 requires for every Ponder
service here: the image indexes into a schema named after `RAILWAY_DEPLOYMENT_ID`. The stable
name for anyone querying Postgres directly is `DATABASE_VIEWS_SCHEMA=callhouse_v2` (Ponder keeps
views of the live deployment's tables there).

**`notifier` shares the Postgres** and owns schema `notifier` (migrations applied at boot,
`notifier/migrations`). `ponder db prune` (§11.3) never touches it: Ponder 0.17's prune only drops
schemas that carry its `_ponder_meta` table.

**The `relay` exists but has never deployed** (Railway service list, 2026-09-16: no region, no
deployment), so v1 keepers deliver no alert today either. The v2 bots post to it with
`source: callhouse-<mode>` and `v2_*` kinds; nothing about the relay changes. `go-live-v2.sh`
deploys it only when `RELAY_TOKEN` and a target are set. An apply run refuses to deploy
an alert-producing service until the relay is live. A later relay-only run prepares
`ALERT_WEBHOOK` and its token reference on existing services; if any is already running,
the run is incomplete until it is redeployed with `--services <name>` so the reference
reaches the process. Check the relay wiring from each caller in §15.7.

### 15.2 The registry inside the keeper image (required before any bot deploys)

The four keeper-image services read their markets, and by default their contract addresses, from
the registry at boot (`keeper/src/v2/config.ts`, `keeper/src/v2/pricing/main.ts`). **The image carries
it today.** It did not when this section was written, for two reasons, both fixed on `v2` right after
(the dry run in §15.8 predates the fix); `go-live-v2.sh --apply` still refuses a ref that has not
fixed both:

1. **`.dockerignore` excludes `ops`** (§9 item 13).
2. **`keeper/Dockerfile` copies no registry.** Its runner stage installs the package at `/app`
   (`WORKDIR /app`, `/out` copied to `./`), so the keeper's default `V2_REGISTRY_PATH`,
   `../ops/markets/tier1.json` resolved against the package directory, is `/ops/markets/tier1.json`,
   not `/app/ops/…`. `ops/v2/env/*.env` therefore sets the absolute `V2_REGISTRY_PATH=/app/ops/markets/tier1.json`.

The change, exactly (the K lane owns `keeper/`; the root `.dockerignore` goes with it):

```diff
--- a/.dockerignore
+++ b/.dockerignore
@@ ---- ops and docs. …
 ops
+# … except the market registry: the v2 bots read it at boot (keeper/Dockerfile runner stage,
+# ops/deploy.md §15.2). The only file under ops/ any image carries.
+!ops/markets/tier1.json
 docs
```

```diff
--- a/keeper/Dockerfile
+++ b/keeper/Dockerfile
@@ runner
 COPY --from=builder --chown=node:node /out ./
 
+# The market registry the v2 modes read at boot (V2_REGISTRY_PATH=/app/ops/markets/tier1.json in
+# ops/v2/env/*.env). Last, so a registry-only change rebuilds one layer. The v1 keeper never reads it.
+COPY --chown=node:node ops/markets/tier1.json ./ops/markets/tier1.json
+
 USER node
```

An exception under an excluded directory works in both Docker's classic builder and BuildKit (the
context walk enters an excluded directory when an exception pattern lies below it). Prove it once
with `docker build -f keeper/Dockerfile .` and
`docker run --rm --entrypoint ls callhouse-keeper -l /app/ops/markets/tier1.json`.

**Which registry the image bakes.** The runner declares `ARG V2_REGISTRY_FILE=tier1.json` and copies
`ops/markets/$V2_REGISTRY_FILE`. A production build never passes it, so it copies
`ops/markets/tier1.json` to the same path as before and the image is byte-identical. The mainnet **dev**
environment ([`runbooks/v2-dev-deploy.md`](runbooks/v2-dev-deploy.md)) sets `V2_REGISTRY_FILE=dev.json`
as a service variable, which Railway passes to the build, together with
`V2_REGISTRY_PATH=/app/ops/markets/dev.json` at runtime — `ops/v2-env.mjs` renders that path from the
basename of the registry it read. Both files are re-included in the root `.dockerignore`; a name that is
neither fails the `COPY` at build time.

What baking it in means:

- **A registry change is a rebuild** of all four keeper-image services, never a restart: a market
  going `live`, the deploy write-back, a ladder override. The owner manually
  reruns `go-live-v2.sh --apply --ref <new-SHA> --services pricing,cranker,pricer,mm-bot`
  after reviewing the new registry; there is no GitHub watch path on CLI-uploaded services.
  `go-live-v2.sh --apply` also refuses when the ref it builds carries a different
  `tier1.json` than the checkout it planned against.
- **Rolling an image back rolls its registry back** (§15.10).
- The v1 `keeper` and `keeper-<ticker>` images carry the file too and never read it; they do not
  watch it, so their copy goes stale harmlessly.
- The alternative, a copy on a volume or a mounted file, was rejected: it is one more thing to
  keep in step by hand, nobody reviews it, and a redeploy cannot tell which registry it runs.

### 15.3 Variables

Generated, not typed: `node ops/v2-env.mjs` renders `ops/v2/env/<service>.env` from the registry
(`indexer-v2`, `pricing`, `cranker`, `pricer`, `mm-bot`, `notifier`); `--check` is the drift gate,
and each file is the service's whole **public** environment with every secret a named comment.
`go-live-v2.sh` sets exactly those assignments, plus the Railway settings and reference variables
below. For `--apply`, the script compares the local render with the immutable reviewed
`--ref` clone and reads the clone's committed env files when setting Railway values.
An uncommitted local renderer or env change fails that comparison. The keeper's
variable reference is `keeper/README.md` → "v2 modes", the indexer's
`indexer/.env.example`, the notifier's `notifier/README.md` → "Environment"; each wins over this
table if they disagree.

| Service | From `ops/v2/env/<service>.env` | Set by the script besides | Secrets (§15.4) |
|---|---|---|---|
| `indexer-v2` | `V2_CLEARINGHOUSE`, `V2_ORDER_BOOK`, `V2_SETTLEMENT_ORACLE`, `V2_AUTO_ROLLER`, `V2_MAKER_REGISTRY`, `V2_EXPIRY_CALENDAR`, `V2_KEEPER_REWARDS`, `V2_START_BLOCK`, `PRICING_URL`, `DATABASE_VIEWS_SCHEMA=callhouse_v2`, `PORT=42069` | `DATABASE_URL=${{Postgres.DATABASE_URL}}`; `RAILWAY_DOCKERFILE_PATH`, `RAILWAY_HEALTHCHECK_TIMEOUT_SEC=3600`, `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30` | `PONDER_RPC_URL_4663` |
| `pricing` | `V2_MODE=pricing`, `RH_RPC`, `RH_RPC_2`, `V2_REGISTRY_PATH`, `PRICING_PORT=8790`, `PORT=8790` | `RAILWAY_*` (120 s, 30 s) | none: no key, sends nothing |
| `cranker` | `V2_MODE=cranker`, `RH_RPC`, `RH_RPC_2`, `V2_REGISTRY_PATH`, `INDEXER_URL`, `CRANKER_PORT=8792`, `PORT=8792`, `KEEPER_DB_PATH=/data/cranker.db`, `ALERT_WEBHOOK` | `ALERT_WEBHOOK_TOKEN=${{relay.RELAY_TOKEN}}`; `RAILWAY_*` (300 s, 120 s), `RAILWAY_RUN_UID=0` | `CRANKER_PK` |
| `pricer` | as `cranker` with `V2_MODE=pricer`, `PRICING_URL`, `PRICER_PORT=8794`, `PORT=8794`, `KEEPER_DB_PATH=/data/pricer.db`; the `PRICER_*` tuning as comments with their defaults (K2-05: edge 500 bps over fair, reprice past a 10 % move, at most every 30 min) | as `cranker` | `PRICER_PK` |
| `mm-bot` | as `cranker` with `V2_MODE=mm`, `PRICING_URL`, `MM_PORT=8793`, `PORT=8793`, `KEEPER_DB_PATH=/data/mm-bot.db`; the `MM_*` quoting and risk settings are comments with their defaults (set one on Railway only to change it) | as `cranker` | `MM_QUOTER_PK`, `MM_KILL_TOKEN` |
| `notifier` | `INDEXER_URL`, `RH_RPC`, `APP_URL=https://app.stonkhouse.fun`, `PORT=8791` | `DATABASE_URL=${{Postgres.DATABASE_URL}}`; `RAILWAY_*` (60 s, 30 s) | `NOTIFIER_DATA_KEY`, `TELEGRAM_BOT_TOKEN`, `VAPID_PUBLIC_KEY` + `VAPID_PRIVATE_KEY`; `SMTP_URL` (+ `EMAIL_FROM`, `NOTIFIER_PUBLIC_URL=https://notify.stonkhouse.fun`) only to turn email on |
| `web` | none | `NEXT_PUBLIC_V2=1`, `NEXT_PUBLIC_API_URL=https://<indexer-v2 domain>`, `NEXT_PUBLIC_NOTIFIER_URL=https://notify.stonkhouse.fun` (**build-time**, §15.5) | none |

**Private-network URLs**, all `http`, all runtime only (private DNS does not resolve at build or
from a laptop; §9 item 14):

| Variable | Value | On |
|---|---|---|
| `INDEXER_URL` | `http://indexer-v2.railway.internal:42069` | `cranker` and `pricer` (optional: both fall back to their own log scans), `mm-bot`, `notifier` |
| `PRICING_URL` | `http://pricing.railway.internal:8790` | `indexer-v2` (`/v2/fair` proxy), `pricer`, `mm-bot` |
| `ALERT_WEBHOOK` | `http://relay.railway.internal:8080/alert` | `cranker`, `pricer`, `mm-bot` |
| the kill switch | `http://mm-bot.railway.internal:8793/kill` | called from inside the project only |

The service name is the hostname, so the names in §15.1 are exact. Every server here binds without
a host (`::`, IPv4 with it), as §11.6 item 5 requires for the private network.

**O2-01's three guesses, checked against the code:**

| Guess | Verdict |
|---|---|
| Ports 8792–8794 for cranker / mm / pricer | **Confirmed.** `keeper/src/v2/config.ts` `DEFAULT_MODE_PORT` is cranker 8792, mm 8793, pricer 8794, read from `CRANKER_PORT`, `MM_PORT`, `PRICER_PORT`. The env files now set all three names (they set only `CRANKER_PORT` before) and `PORT` equal to each |
| `DATABASE_SCHEMA=callhouse_v2` | **Corrected.** It must stay unset on Railway (§11.3; the second deploy on a fixed schema crash-loops). The name moved to `DATABASE_VIEWS_SCHEMA` |
| `V2_REGISTRY_PATH=/app/ops/markets/tier1.json`, the build excluding `ops/` | **Confirmed**, for a different reason than O2-01 gave: the runner's package root is `/app`, not `/app/keeper`, so the keeper default resolves to `/ops/markets/tier1.json` and the absolute path is required. The image carries no registry until §15.2 lands |

Also added to the env files: `KEEPER_DB_PATH=/data/<service>.db` for the three signing bots (the
image's default is `/data/keeper.db`; one explicit file per service, as `keeper-<ticker>` does), the
notifier's email trio as comments, and the `/kill` token placeholder comment on `mm-bot`.

**Changing things.** Every value above is read at boot: a change is a **restart**, with three
exceptions. A registry change is a **rebuild** of the keeper-image services (§15.2). Any value
`indexer/ponder.config.ts` reads (the `V2_*` addresses, `V2_START_BLOCK`, the RPC) is a new Ponder
build and re-indexes into a new schema (§11.3). `NEXT_PUBLIC_*` on `web` is a **rebuild** (§6).

**Never redeploy `cranker` (or `pricer`, `mm-bot`) between 15:40 and 16:20 New York time on a
session day.** The daily expiry is 16:00; the oracle snapshot must land in `[expiry, expiry + 600 s]`
(`SNAPSHOT_GRACE`) and finalize starts at `expiry + 120 s`. A volume allows one deployment at a
time, so a redeploy is a minute or two of no cranker. Anyone may snapshot, and a missed snapshot
falls back to the single-source delay rather than losing the expiry, but do not cause one.
`go-live-v2.sh --apply` refuses the signing bots inside that window without
`--ignore-expiry-window`. It checks both before setting up each bot and immediately
before uploading its image, since key prompts can cross into the window. Start
well before 15:40: the Railway build itself may take several minutes after upload.

### 15.4 Secrets

Runtime variables only, never a build `ARG` (§10.2), each **sealed** right after it is set (§9
item 15; CLI ≥ 5.47.2, which the script requires). `go-live-v2.sh` sets a secret only when the
service does not already have it (sealed or not): from a key file, or pasted into `read -rs`, then
piped to `railway variables --set-from-stdin`. Nothing is ever an argument or a file in the clone.

| Secret | Service | Comes from | Rotate |
|---|---|---|---|
| `CRANKER_PK` | `cranker` | `~/.callhouse-keys/v8/cranker.env` (§15.6, index 60) | any time: it holds no role. New key, fund it, `--rotate-keys`, move the leftover gas |
| `PRICER_PK` | `pricer` | `~/.callhouse-keys/v8/pricer.env` (index 61) | admin grants `PRICER_ROLE` to the new address **first**, then `--rotate-keys`, then revokes the old |
| `MM_QUOTER_PK` | `mm-bot` | `~/.callhouse-keys/v8/quoter.env` (index 62) | the same with `QUOTER_ROLE` on `MakerVault`; kill switch first if the old key is suspect |
| `MM_KILL_TOKEN` | `mm-bot` | `openssl rand -hex 32` (64 hex characters; the bot refuses to boot without one of at least 32); keep a copy in the password manager for the on-call. The `railway ssh --service mm-bot -- node -e` line above reads the token out of the container's own environment and cancels every vault order and stops quoting until the same call to `/resume`; `curl` and `wget` are in no image (§15.11 item 10) and `mm-bot.railway.internal` resolves nowhere else | set the new value and restart (a killed bot stays killed across the restart) |
| `PONDER_RPC_URL_4663` | `indexer-v2` | the keyed archive endpoint, the same value as `indexer` (§11.2) | set and restart (re-indexes over the cache). A reference `${{indexer.PONDER_RPC_URL_4663}}` would avoid pasting it, but breaks the day the v1 `indexer` is deleted (O2-05) |
| `NOTIFIER_DATA_KEY` | `notifier` | `openssl rand -hex 32`, **with an offline copy** (password manager): losing it orphans every stored target | not supported (`notifier/README.md`) |
| `TELEGRAM_BOT_TOKEN` | `notifier` | @BotFather: a **new, user-facing** bot, never the relay's operator bot, with no webhook set on it | revoke in @BotFather, set, restart |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | `notifier` | `npx web-push generate-vapid-keys`, one run, both values (the public key is not secret but must be the private key's pair; the notifier checks at boot) | a new pair invalidates every browser subscription |
| `SMTP_URL` | `notifier` | the mail provider; optional, set in the UI with `EMAIL_FROM` and `NOTIFIER_PUBLIC_URL`. All three or none: the notifier refuses to boot on half an email setup, which is why `go-live-v2.sh` sets `NOTIFIER_PUBLIC_URL` on the dev path only when `SMTP_URL` is already there (O3-401) | set, restart |
| `DATABASE_URL` | `indexer-v2`, `notifier` | reference `${{Postgres.DATABASE_URL}}`, not a value | Railway's |
| `ALERT_WEBHOOK_TOKEN` | the three bots | reference `${{relay.RELAY_TOKEN}}` (§12.3) | rotate `RELAY_TOKEN`; the references follow on restart |
| `RELAY_TOKEN`, `DISCORD_WEBHOOK_URL` / `TELEGRAM_*` | `relay` | §12.2, set by hand, already provisioned or not | §12 |

Before attaching `notify.stonkhouse.fun`, verify the Railway ingress appends the real
client address as the final trusted `X-Forwarded-For` hop. The notifier applies its
120-challenge-per-client minute gate before taking a database connection; a forged
header must not let one client rotate its identity or exhaust another client's
allowance. Keep direct paths that bypass the trusted ingress closed, and apply an
ingress rate limit for session and subscription writes across replicas. The process
local gate does not replace that shared ingress limit. Test two clients and a forged
header through the actual public edge, then record the result in the launch log.

Web Push subscriptions are restricted in code to FCM, Mozilla, Apple and Windows
push-service hosts. Restrict notifier egress to those HTTPS services when the hosting
network supports it; verify DNS and redirects cannot reach private addresses. Enable
`SMTP_URL` only after the provider's confirmation send, timeout and unsubscribe flows
have been tested. The email caps and normalized inbox policy are in
`notifier/README.md` under Abuse bounds.

### 15.5 `web`

One service, as today. v2 changes three **build-time** values and no runtime one; addresses keep
coming from `web/lib/markets.generated.ts` (regenerated and committed after the deploy write-back).
`go-live-v2.sh` touches `web` only when `--services` names it: the flip of `app.stonkhouse.fun` to
the buyer-first app is a launch decision (O2-04), not a side effect of bringing the bots up.

`web/Dockerfile` declares none of the v2 variables today, so a Railway variable would be silently
absent from the build (§3). The web lane adds, in the builder stage beside the other pairs:

```dockerfile
ARG NEXT_PUBLIC_V2=""
ENV NEXT_PUBLIC_V2=$NEXT_PUBLIC_V2
ARG NEXT_PUBLIC_NOTIFIER_URL=""
ENV NEXT_PUBLIC_NOTIFIER_URL=$NEXT_PUBLIC_NOTIFIER_URL
ARG NEXT_PUBLIC_WC_PROJECT_ID=""
ENV NEXT_PUBLIC_WC_PROJECT_ID=$NEXT_PUBLIC_WC_PROJECT_ID
```

with the same entries in `web/.env.example`, and code that treats `""` as unset (the
`NEXT_PUBLIC_CHAIN_ID` lesson in §3). `go-live-v2.sh --apply --ref <reviewed-SHA> --services web` refuses a ref without
the first two, and one whose `markets.generated.ts` does not carry the deployed addresses.

`NEXT_PUBLIC_API_URL` is read by both `web/lib/api.ts` (v1 pages) and `web/lib/v2/api.ts`. Pointed
at `indexer-v2`, the `/legacy` vault pages lose their history panels to "unavailable" and
`/legacy/activity` falls back to its log scan: degraded, not broken (§3), and acceptable only
because v1 is in run-off. If the legacy pages must keep them, the web lane adds a separate legacy
API variable before the flip.

Verify after the rebuild: `curl -s -o /dev/null -w '%{http_code}' https://app.stonkhouse.fun/settings/notifications`
answers **200** only in a `NEXT_PUBLIC_V2=1` build (404 otherwise).

### 15.6 Bot keys

One key per process, from the ops mnemonic, recorded in the registry **by address only**:

| Bot | BIP-44 index | Variable | Key file | Registry | Role |
|---|---|---|---|---|---|
| cranker | 60 | `CRANKER_PK` | `~/.callhouse-keys/v8/cranker.env` | `v2.bots.cranker` | `BUYBACK` on the FeeSplitter; every lifecycle call is permissionless |
| pricer | 61 | `PRICER_PK` | `~/.callhouse-keys/v8/pricer.env` | `v2.bots.pricer` | `PRICER` on the AccessManager (`AutoRoller.reprice`) |
| MM quoter | 62 | `MM_QUOTER_PK` | `~/.callhouse-keys/v8/quoter.env` | `v2.bots.quoter` | `QUOTER` on the AccessManager (quotes; cannot withdraw) |
| guardian | 63 | `GUARDIAN_PK` | `~/.callhouse-keys/v8/guardian.env` | `v2.bots.guardian` | `GUARDIAN` (pause, veto, cancel scheduled operations) |

Indices 0–2 are admin, NVDA keeper and guardian, 10–43 the v1 market keepers, 44–49 stay free,
50–52 the v7 cranker, pricer and mmQuoter, 60–63 the v8 bots above (`ops/v2/derive-bot-keys.sh`
header). The v8 key files live in `~/.callhouse-keys/v8/`, not `~/.callhouse-keys/v2/`: v7 wrote
indices 50–52 to `v2/cranker.env`, `v2/pricer.env` and `v2/mmQuoter.env`, and the script never
overwrites a key file, so a v8 derivation there dies on any machine that ran v7 and the file still
holds the v7 key. v7's files stay where they are. A dev stack (`ops/markets/dev.json`) uses none of
these: its bots are anvil's public dev accounts (`node ops/devnet/devnet.mjs env`).

```bash
ops/v2/derive-bot-keys.sh                 # the owner, once; prints addresses only
node ops/markets/build-markets.mjs --check  # v2.bots: EIP-55 or null, distinct from each other and every other registry key
git add ops/markets/tier1.json && git commit -m "Record the v2 bot addresses"
jq '.v2.bots' ops/markets/tier1.json      # the addresses to fund and grant
```

The script reads the phrase exactly as `ops/markets/derive-keeper-keys.sh` does (a mode-600 temp
file, never an argument), checks index 0 is the registry admin, writes each key file mode 600 in a
mode-700 directory, and refuses to overwrite a key file that is not its index or to re-point a
registry address that is not that key. Re-running it is a no-op. Exercised with a throwaway phrase
(`CALLHOUSE_WALLET_FILE`, `CALLHOUSE_V2_KEYS_DIR`, `CALLHOUSE_REGISTRY` pointed at a temp directory):
first run writes, second run keeps, and a tampered key file, a mode-644 file, a re-pointed registry
address and a wrong phrase each refuse.

Before the bots start: **fund** each address (the v1 keepers run on ~0.05 ETH; the bots alert
`v2_low_gas` under `KEEPER_MIN_GAS_WEI`, 0.01 ETH, and the cranker spends the most: snapshot,
finalize, settle and redeem for every expiry, paid back in part by `KeeperRewards` bounties), and
have the admin **grant** `PRICER_ROLE` and `QUOTER_ROLE` to those two addresses (contracts
`script/v2`, C2-13, reads them from `v2.bots`). `go-live-v2.sh` reports each bot's balance and
role on chain and each key file's derived address before it plans anything.

Rotation needs a new index, and both tools refuse a half-done one: `derive-bot-keys.sh` never
overwrites a key file and never re-points a non-null `v2.bots` entry, and `go-live-v2.sh
--rotate-keys` takes the key only when it derives to the address in the **pushed** registry. The
order that works — burn the index, archive the key file, null the entry, derive, push, grant, then
`--rotate-keys` — is `runbooks/incident-v2.md` §4d. What each key's compromise means is the same
file: cranker harmless (gas only), pricer revoke the role, quoter the admin withdraws the vault.

### 15.7 First deploy, in order

1. **Contracts written back.** `v2.deployBlock` and every `v2.contracts` address in the registry
   (C2-13 `--broadcast`), `node ops/markets/build-markets.mjs --check` green, `node ops/v2-env.mjs`
   re-run and `ops/v2/env` committed with it (`--check` green), `pnpm --filter @callhouse/web
   gen:markets` committed. Every market registered with `spotMaxAge` 90000 before its first series
   (§15.13, release runbook step 1).
2. **Keys.** §15.6: derived, recorded, funded, roles granted.
3. **Images.** §15.2 is in the ref (it is on `v2`, and `go-live-v2.sh` refuses a ref where it is
   not); `docker build -f keeper/Dockerfile .` and the `ls` there pass. For the web flip later,
   §15.5's ARGs merged.
4. **Pushed and reviewed.** Resolve the intended release to an immutable Git commit SHA,
   review that exact code and its contract submodule pin, and pass it with `--ref <SHA>` to
   both the dry run and apply. The script prints the checked-out SHA and compares its
   registry with this checkout. `--apply` requires a full 40-character commit SHA and verifies
   the clone resolves to it. That check does not prove the code was reviewed. Record the approved
   SHA in the release notes before running `--apply`.
5. **Relay.** Set `RELAY_TOKEN` and a Discord or Telegram target on `relay` (§12.2)
   before deploying any alert producer. A relay-only run that discovers an already
   running unwired producer exits incomplete and tells you which service to redeploy.
6. **Dry run, read it, apply:**
   ```bash
   ops/go-live-v2.sh --ref <reviewed-SHA>          # preflight + every command, nothing changed; §15.8 is what it prints
   ops/go-live-v2.sh --apply --ref <reviewed-SHA>  # relay, indexer-v2, pricing, notifier, monitor (keyless; O8-05)
   # cranker, pricer and mm-bot are not in that default set. Name cranker/pricer explicitly; name
   # mm-bot once the canary runbook (O2-04) has set its MM_* caps, or it quotes every live market
   # up to the vault's own limits. Always pass --services.
   ```
   Order matters and is fixed: the relay first so boot alerts land; `indexer-v2` before its callers.
   The script waits for a **new** indexer deployment ID to reach `SUCCESS` before
   accepting `/ready` and `/v2/config`; the previous deployment's healthy response
   cannot satisfy this gate. It refuses the public web flip while any earlier
   selected service is incomplete. `pricing` comes before `pricer`
   and `mm-bot`; `mm-bot` last of the bots, because it is the one that commits capital.
   Expected boot lines: `indexer-v2` as §11.5 step 3; the bots `v2_boot` in the relay's channel
   naming the mode, the chain and the signer; `pricing` `pricing service listening`; `notifier`
   its `/health` `status: ok`.
7. **In the UI:** seal every secret the run set; per service set the healthcheck path,
   restart policy and replicas 1. Keep its repo and image source disconnected;
   `railway up` with a reviewed SHA is the deployment path.
8. **DNS (owner):** the CNAME `notify` and TXT `_railway-verify.notify` that
   `railway domain notify.stonkhouse.fun` printed, Cloudflare **DNS only** (§4). Then
   `curl -s https://notify.stonkhouse.fun/health` answers `"service"` with `status: ok`.
9. **Private network, from each caller** (Debian images carry no `wget`; `node` is in every image):
   ```bash
   probe() { railway ssh --service "$1" -- node -e "fetch('$2').then(async r=>console.log(r.status,(await r.text()).slice(0,160))).catch(e=>console.log('ERR',e.message))"; }
   probe indexer-v2 http://pricing.railway.internal:8790/health            # 200
   probe cranker    http://indexer-v2.railway.internal:42069/v2/health      # 200 {"status":"ok",…,"interfaceVersion":7}
   probe mm-bot     http://pricing.railway.internal:8790/health            # 200
   probe notifier   http://indexer-v2.railway.internal:42069/v2/health      # 200
   railway domain list --service mm-bot --json                              # {"domains":[]}: the kill switch is private
   ```
   An `ERR` while the target's own `/health` is green is the service name, the port, or the two
   services in different environments (§9 item 14). The relay: §12.4's wiring test from `cranker`
   with `"source":"callhouse-cranker"`.
10. **Monitors.** Railway restarts nothing that answers 503 after boot (§5): O2-06's
    `ops/v2/monitor.mjs` and the `/health` / `/v2/health` uptime checks are part of the deploy.
11. **The web flip**, when the canary runbook (O2-04) says so:
    `ops/go-live-v2.sh --apply --ref <reviewed-SHA> --services web`, then §15.5's check.

### 15.8 Dry run, recorded

Run 2026-09-16 on `v2` at `9a86dcd` plus this change, Railway CLI 5.57.1, never with `--apply`.
This is historical output, not the current release procedure. In particular,
the watch-path TODOs below were wrong for CLI-uploaded services; use §15.1 and
the current script's dry run, which requires manual redeployment from a reviewed
SHA and refuses connected repo or image sources.

**Against the committed registry** (contracts not deployed): refuses, and says what is missing.

```
$ ops/go-live-v2.sh

== Preflight (dry run: nothing is changed) ==
  services: relay indexer-v2 pricing cranker pricer mm-bot notifier
  web: not selected (add web to --services to flip https://app.stonkhouse.fun to v2; §15.5)
  railway CLI 5.57.1
REFUSED: the registry's v2 deployment is not complete; run the v2 deploy write-back (contracts script/v2/DeployV2Batch.sh) first:
  v2.deployBlock is null
  v2.contracts.clearinghouse is null
  v2.contracts.orderBook is null
  v2.contracts.settlementOracle is null
  v2.contracts.expiryCalendar is null
  v2.contracts.keeperRewards is null
  v2.contracts.autoRoller is null
  v2.contracts.payoutAdapter is null
  v2.contracts.makerVault is null
  v2.contracts.makerRegistry is null
  v2.contracts.rewardsDistributor is null
  v2.contracts.sources.chainlink is null
  v2.contracts.sources.univ3 is null
  v2.bots.cranker is null (ops/v2/derive-bot-keys.sh)
  v2.bots.pricer is null (ops/v2/derive-bot-keys.sh)
  v2.bots.mmQuoter is null (ops/v2/derive-bot-keys.sh)
```

**Against a rehearsal copy**: `ops/markets/tier1.json` with fake, checksummed addresses in
`v2.contracts` and `v2.deployBlock`, NVDA's `v2.status` live, and `v2.bots` the indices 50–52 of a
**throwaway** phrase whose key files `ops/v2/derive-bot-keys.sh` wrote into the same temp directory
(`/tmp/v2-rehearsal` below; the chain checks are skipped with `--offline`, which `--apply` refuses).
The two `WILL REFUSE` lines were §15.2, open on that ref and fixed by the next commit on `v2`.

```
$ CALLHOUSE_V2_KEYS_DIR=/tmp/v2-rehearsal/keys ops/go-live-v2.sh --registry /tmp/v2-rehearsal/rehearsal-tier1.json --offline

== Preflight (dry run: nothing is changed) ==
  services: relay indexer-v2 pricing cranker pricer mm-bot notifier
  web: not selected (add web to --services to flip https://app.stonkhouse.fun to v2; §15.5)
  REHEARSAL: planning against /tmp/v2-rehearsal/tier1.json, not ops/markets/tier1.json
  railway CLI 5.57.1
  registry v2: interface version 6, deploy block 65120000, clearinghouse 0xC339575219A949815fA7d8c7470F874310ba44B4
  v2.contracts.sources.dataStreams is null: fine, DataStreamsSource ships disabled (C2-12)
  v2 live markets: NVDA
  env rendered for: cranker indexer-v2 mm-bot notifier pricer pricing
  --offline: chain checks skipped (code at each contract, deploy block, bot gas and roles)
  CRANKER_PK: /tmp/v2-rehearsal/keys/cranker.env derives to v2.bots.cranker 0xf53352F5c5d9A6a795cd331935CFaB0947fCF20A
  PRICER_PK: /tmp/v2-rehearsal/keys/pricer.env derives to v2.bots.pricer 0x2F4F2Eb75EfAfD454242B2Fbcee851E9CF2a1B28
  MM_QUOTER_PK: /tmp/v2-rehearsal/keys/mmQuoter.env derives to v2.bots.mmQuoter 0xC196807708b4BEbC84475D8527B29eA41639aF63
  WILL REFUSE at --apply (checked on the clone of the ref): keeper/Dockerfile does not COPY ops/markets/tier1.json into the runner: the bots boot without a registry (ops/deploy.md §15.2)
  WILL REFUSE at --apply (checked on the clone of the ref): .dockerignore keeps ops/markets/tier1.json out of the build context (ops/deploy.md §15.2)

== Plan (dry run: every railway command --apply runs, in order; nothing was changed) ==
  $ git clone stonkhousedotfun/callhouse (temp dir); git checkout main; railway link -p 9988a803-0b8f-4b0e-8ada-ba71e5a505ae -e 319fcb44-0e25-4367-947c-09351a349d2e
    # the clone's ops/markets/tier1.json must equal the registry planned against, and the shape checks run on it

== relay ==
  # deployed only if RELAY_TOKEN and DISCORD_WEBHOOK_URL (or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) are already set on relay (§12.2)
  $ railway variables --service relay --skip-deploys \
      --set RAILWAY_DOCKERFILE_PATH=relay/Dockerfile \
      --set RAILWAY_HEALTHCHECK_TIMEOUT_SEC=60
    # Railway settings
  $ railway up --ci --service relay -m "go-live-v2: main"
    # then wait for the deployment's SUCCESS (up to 900s)

== indexer-v2 ==
  $ railway add --service indexer-v2
    # only if the service does not exist
  $ railway variables --service indexer-v2 --skip-deploys \
      --set RAILWAY_DOCKERFILE_PATH=indexer/Dockerfile \
      --set RAILWAY_HEALTHCHECK_TIMEOUT_SEC=3600 \
      --set RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30 \
      --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
      --set V2_CLEARINGHOUSE=0xC339575219A949815fA7d8c7470F874310ba44B4 \
      --set V2_ORDER_BOOK=0xC1cA119f7D2B6d79E801fEEc82296B221a0c7b5F \
      --set V2_SETTLEMENT_ORACLE=0xF44B72B284f1f3b35ccA07CFFbC16c68623453Fd \
      --set V2_AUTO_ROLLER=0x87119D20Ad7D89008F73805436Fa0d810846f82c \
      --set V2_MAKER_REGISTRY=0x7479920A5De08a28dC402e413aEcc0483094b828 \
      --set V2_EXPIRY_CALENDAR=0x5424097F86806A5Fe608854Fed6dDa017Df0827b \
      --set V2_KEEPER_REWARDS=0xaa5083eec5dA4D56F46D58cf1857bb8B8D86a3a8 \
      --set V2_START_BLOCK=65120000 \
      --set PRICING_URL=http://pricing.railway.internal:8790 \
      --set DATABASE_VIEWS_SCHEMA=callhouse_v2 \
      --set PORT=42069
    # Railway settings + every assignment in ops/v2/env/indexer-v2.env
  $ railway variables --service indexer-v2 --set-from-stdin PONDER_RPC_URL_4663 --skip-deploys
    # only if PONDER_RPC_URL_4663 is unset on indexer-v2; value pasted with read -rs: the keyed archive RPC URL, the v1 indexer's value (§11.2)
  $ railway domain --service indexer-v2 --port 42069
    # only if indexer-v2 has no domain; the https://<domain> becomes web's NEXT_PUBLIC_API_URL
  $ railway up --detach --service indexer-v2 -m "go-live-v2: main"
    # /ready waits for the backfill
  $ curl -s https://<indexer-v2 domain>/ready
    # polled up to 1200s for 200; then /v2/config must name clearinghouse 0xC339575219A949815fA7d8c7470F874310ba44B4

== pricing ==
  $ railway add --service pricing
    # only if the service does not exist
  $ railway variables --service pricing --skip-deploys \
      --set RAILWAY_DOCKERFILE_PATH=keeper/Dockerfile \
      --set RAILWAY_HEALTHCHECK_TIMEOUT_SEC=120 \
      --set RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30 \
      --set V2_MODE=pricing \
      --set RH_RPC=https://rpc.mainnet.chain.robinhood.com \
      --set RH_RPC_2=https://robinhood-rpc.publicnode.com \
      --set V2_REGISTRY_PATH=/app/ops/markets/tier1.json \
      --set PRICING_PORT=8790 \
      --set PORT=8790
    # Railway settings + every assignment in ops/v2/env/pricing.env
  $ railway up --ci --service pricing -m "go-live-v2: main"
    # then wait for the deployment's SUCCESS (up to 900s)
  $ railway ssh --service pricing -- node -e 'fetch("http://127.0.0.1:8790/health").then(async r=>console.log(r.status, await r.text()))'
    # expect 200 and status ok (degraded or starting while it warms up)

== cranker ==
  $ railway add --service cranker
    # only if the service does not exist
  $ railway variables --service cranker --skip-deploys \
      --set RAILWAY_DOCKERFILE_PATH=keeper/Dockerfile \
      --set RAILWAY_HEALTHCHECK_TIMEOUT_SEC=300 \
      --set RAILWAY_DEPLOYMENT_DRAINING_SECONDS=120 \
      --set RAILWAY_RUN_UID=0 \
      --set V2_MODE=cranker \
      --set RH_RPC=https://rpc.mainnet.chain.robinhood.com \
      --set RH_RPC_2=https://robinhood-rpc.publicnode.com \
      --set V2_REGISTRY_PATH=/app/ops/markets/tier1.json \
      --set INDEXER_URL=http://indexer-v2.railway.internal:42069 \
      --set CRANKER_PORT=8792 \
      --set PORT=8792 \
      --set KEEPER_DB_PATH=/data/cranker.db \
      --set ALERT_WEBHOOK=http://relay.railway.internal:8080/alert \
      --set 'ALERT_WEBHOOK_TOKEN=${{relay.RELAY_TOKEN}}'
    # Railway settings + every assignment in ops/v2/env/cranker.env; ALERT_WEBHOOK and its token only when the relay is deployed
  $ railway variables --service cranker --set-from-stdin CRANKER_PK --skip-deploys
    # only if CRANKER_PK is unset on cranker (or --rotate-keys); from /tmp/v2-rehearsal/keys/cranker.env, else read -rs; must derive to 0xf53352F5c5d9A6a795cd331935CFaB0947fCF20A
  $ railway volume --service cranker add --mount-path /data
    # only if cranker has no volume
  $ railway up --ci --service cranker -m "go-live-v2: main"
    # then wait for the deployment's SUCCESS (up to 900s)
  $ railway ssh --service cranker -- node -e 'fetch("http://127.0.0.1:8792/health").then(async r=>console.log(r.status, await r.text()))'
    # expect 200 and status ok (degraded or starting while it warms up)

== pricer ==
  $ railway add --service pricer
    # only if the service does not exist
  $ railway variables --service pricer --skip-deploys \
      --set RAILWAY_DOCKERFILE_PATH=keeper/Dockerfile \
      --set RAILWAY_HEALTHCHECK_TIMEOUT_SEC=300 \
      --set RAILWAY_DEPLOYMENT_DRAINING_SECONDS=120 \
      --set RAILWAY_RUN_UID=0 \
      --set V2_MODE=pricer \
      --set RH_RPC=https://rpc.mainnet.chain.robinhood.com \
      --set RH_RPC_2=https://robinhood-rpc.publicnode.com \
      --set V2_REGISTRY_PATH=/app/ops/markets/tier1.json \
      --set PRICING_URL=http://pricing.railway.internal:8790 \
      --set INDEXER_URL=http://indexer-v2.railway.internal:42069 \
      --set PRICER_PORT=8794 \
      --set PORT=8794 \
      --set KEEPER_DB_PATH=/data/pricer.db \
      --set ALERT_WEBHOOK=http://relay.railway.internal:8080/alert \
      --set 'ALERT_WEBHOOK_TOKEN=${{relay.RELAY_TOKEN}}'
    # Railway settings + every assignment in ops/v2/env/pricer.env; ALERT_WEBHOOK and its token only when the relay is deployed
  $ railway variables --service pricer --set-from-stdin PRICER_PK --skip-deploys
    # only if PRICER_PK is unset on pricer (or --rotate-keys); from /tmp/v2-rehearsal/keys/pricer.env, else read -rs; must derive to 0x2F4F2Eb75EfAfD454242B2Fbcee851E9CF2a1B28
  $ railway volume --service pricer add --mount-path /data
    # only if pricer has no volume
  $ railway up --ci --service pricer -m "go-live-v2: main"
    # then wait for the deployment's SUCCESS (up to 900s)
  $ railway ssh --service pricer -- node -e 'fetch("http://127.0.0.1:8794/health").then(async r=>console.log(r.status, await r.text()))'
    # expect 200 and status ok (degraded or starting while it warms up)

== mm-bot ==
  $ railway add --service mm-bot
    # only if the service does not exist
  $ railway variables --service mm-bot --skip-deploys \
      --set RAILWAY_DOCKERFILE_PATH=keeper/Dockerfile \
      --set RAILWAY_HEALTHCHECK_TIMEOUT_SEC=300 \
      --set RAILWAY_DEPLOYMENT_DRAINING_SECONDS=120 \
      --set RAILWAY_RUN_UID=0 \
      --set V2_MODE=mm \
      --set RH_RPC=https://rpc.mainnet.chain.robinhood.com \
      --set RH_RPC_2=https://robinhood-rpc.publicnode.com \
      --set MAKER_VAULT=0x53D645E21886A914B66f11943368238C6a7f3ABa \
      --set V2_REGISTRY_PATH=/app/ops/markets/tier1.json \
      --set PRICING_URL=http://pricing.railway.internal:8790 \
      --set INDEXER_URL=http://indexer-v2.railway.internal:42069 \
      --set MM_PORT=8793 \
      --set PORT=8793 \
      --set KEEPER_DB_PATH=/data/mm-bot.db \
      --set ALERT_WEBHOOK=http://relay.railway.internal:8080/alert \
      --set 'ALERT_WEBHOOK_TOKEN=${{relay.RELAY_TOKEN}}'
    # Railway settings + every assignment in ops/v2/env/mm-bot.env; ALERT_WEBHOOK and its token only when the relay is deployed
  $ railway variables --service mm-bot --set-from-stdin MM_QUOTER_PK --skip-deploys
    # only if MM_QUOTER_PK is unset on mm-bot (or --rotate-keys); from /tmp/v2-rehearsal/keys/mmQuoter.env, else read -rs; must derive to 0xC196807708b4BEbC84475D8527B29eA41639aF63
  $ railway volume --service mm-bot add --mount-path /data
    # only if mm-bot has no volume
  # mm-bot: refuses to deploy while it has any public domain (the kill switch is on port 8793)
  $ railway up --ci --service mm-bot -m "go-live-v2: main"
    # then wait for the deployment's SUCCESS (up to 900s)
  $ railway ssh --service mm-bot -- node -e 'fetch("http://127.0.0.1:8793/health").then(async r=>console.log(r.status, await r.text()))'
    # expect 200 and status ok (degraded or starting while it warms up)

== notifier ==
  $ railway add --service notifier
    # only if the service does not exist
  $ railway variables --service notifier --skip-deploys \
      --set RAILWAY_DOCKERFILE_PATH=notifier/Dockerfile \
      --set RAILWAY_HEALTHCHECK_TIMEOUT_SEC=60 \
      --set RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30 \
      --set 'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
      --set INDEXER_URL=http://indexer-v2.railway.internal:42069 \
      --set RH_RPC=https://rpc.mainnet.chain.robinhood.com \
      --set APP_URL=https://app.stonkhouse.fun \
      --set PORT=8791
    # Railway settings + every assignment in ops/v2/env/notifier.env
  $ railway variables --service notifier --set-from-stdin NOTIFIER_DATA_KEY --skip-deploys
    # only if NOTIFIER_DATA_KEY is unset on notifier; value pasted with read -rs: openssl rand -hex 32; keep an offline copy, losing it orphans every stored target
  $ railway variables --service notifier --set-from-stdin TELEGRAM_BOT_TOKEN --skip-deploys
    # only if TELEGRAM_BOT_TOKEN is unset on notifier; value pasted with read -rs: @BotFather, a user-facing bot, never the relay's operator bot
  $ railway variables --service notifier --set-from-stdin VAPID_PUBLIC_KEY --skip-deploys
    # only if VAPID_PUBLIC_KEY is unset on notifier; value pasted with read -rs: npx web-push generate-vapid-keys (public, but generated with the private key)
  $ railway variables --service notifier --set-from-stdin VAPID_PRIVATE_KEY --skip-deploys
    # only if VAPID_PRIVATE_KEY is unset on notifier; value pasted with read -rs: the same generate-vapid-keys run
  # SMTP_URL (+ EMAIL_FROM, NOTIFIER_PUBLIC_URL) is not touched: set it in the UI to turn email on
  $ railway domain notify.stonkhouse.fun --service notifier --port 8791
    # only if missing; prints the CNAME and _railway-verify TXT the owner adds in Cloudflare (DNS only)
  $ railway up --ci --service notifier -m "go-live-v2: main"
    # then wait for the deployment's SUCCESS (up to 900s)
  $ railway ssh --service notifier -- node -e 'fetch("http://127.0.0.1:8791/health").then(async r=>console.log(r.status, await r.text()))'
    # expect 200 and status ok (degraded or starting while it warms up)

== What the CLI cannot do (Railway UI / owner) ==
  seal every secret just set: CRANKER_PK, PRICER_PK, MM_QUOTER_PK, PONDER_RPC_URL_4663, NOTIFIER_DATA_KEY, TELEGRAM_BOT_TOKEN, VAPID_PRIVATE_KEY (§9.15)
  relay: healthcheck path /health; restart On Failure, 10 retries; replicas 1; watch paths relay/** package.json pnpm-lock.yaml pnpm-workspace.yaml
  indexer-v2: healthcheck path /ready; restart On Failure, 10 retries; replicas 1; watch paths indexer/** package.json pnpm-lock.yaml pnpm-workspace.yaml
  pricing: healthcheck path /health; restart On Failure, 10 retries; replicas 1; watch paths keeper/** ops/markets/tier1.json package.json pnpm-lock.yaml pnpm-workspace.yaml
  cranker: healthcheck path /health; restart On Failure, 10 retries; replicas 1; watch paths keeper/** ops/markets/tier1.json package.json pnpm-lock.yaml pnpm-workspace.yaml
  pricer: healthcheck path /health; restart On Failure, 10 retries; replicas 1; watch paths keeper/** ops/markets/tier1.json package.json pnpm-lock.yaml pnpm-workspace.yaml
  mm-bot: healthcheck path /health; restart On Failure, 10 retries; replicas 1; watch paths keeper/** ops/markets/tier1.json package.json pnpm-lock.yaml pnpm-workspace.yaml
  notifier: healthcheck path /health; restart On Failure, 10 retries; replicas 1; watch paths notifier/** package.json pnpm-lock.yaml pnpm-workspace.yaml
  DNS (owner): CNAME notify -> the Railway target, TXT _railway-verify.notify; Cloudflare DNS only (§4)
  then ops/deploy.md §15.7: private-network reachability from each caller, the relay wiring test, the external monitors

DRY RUN COMPLETE: nothing was changed. Re-run with --apply to do it.
```

**The web flip**, same copy: all three shape checks fail today (§15.5).

```
$ CALLHOUSE_V2_KEYS_DIR=/tmp/v2-rehearsal/keys ops/go-live-v2.sh --registry /tmp/v2-rehearsal/rehearsal-tier1.json --offline --services web

== Preflight (dry run: nothing is changed) ==
  services: web
  REHEARSAL: planning against /tmp/v2-rehearsal/tier1.json, not ops/markets/tier1.json
  railway CLI 5.57.1
  registry v2: interface version 6, deploy block 65120000, clearinghouse 0xC339575219A949815fA7d8c7470F874310ba44B4
  v2.contracts.sources.dataStreams is null: fine, DataStreamsSource ships disabled (C2-12)
  v2 live markets: NVDA
  env rendered for: cranker indexer-v2 mm-bot notifier pricer pricing
  --offline: chain checks skipped (code at each contract, deploy block, bot gas and roles)
  WARNING: web/lib/api.ts (the v1 vault history under /legacy) and web/lib/v2/api.ts read the same NEXT_PUBLIC_API_URL;
    pointed at indexer-v2, the /legacy history panels answer 'unavailable' (indexer-v2 has no VAULT_ADDRESS). §15.5
  WILL REFUSE at --apply (checked on the clone of the ref): web/Dockerfile declares no ARG NEXT_PUBLIC_V2: the build silently drops it (ops/deploy.md §3, §15.5)
  WILL REFUSE at --apply (checked on the clone of the ref): web/Dockerfile declares no ARG NEXT_PUBLIC_NOTIFIER_URL: the build silently drops it (ops/deploy.md §3, §15.5)
  WILL REFUSE at --apply (checked on the clone of the ref): web/lib/markets.generated.ts does not carry the deployed v2 addresses: pnpm --filter @callhouse/web gen:markets, commit

== Plan (dry run: every railway command --apply runs, in order; nothing was changed) ==
  $ git clone stonkhousedotfun/callhouse (temp dir); git checkout main; railway link -p 9988a803-0b8f-4b0e-8ada-ba71e5a505ae -e 319fcb44-0e25-4367-947c-09351a349d2e
    # the clone's ops/markets/tier1.json must equal the registry planned against, and the shape checks run on it

== web ==
  $ railway variables --service web --skip-deploys \
      --set NEXT_PUBLIC_V2=1 \
      --set NEXT_PUBLIC_API_URL=https://<indexer-v2 domain> \
      --set NEXT_PUBLIC_NOTIFIER_URL=https://notify.stonkhouse.fun
    # build-time values: the deploy below is a REBUILD, never a restart (§6)
  $ railway up --ci --service web -m "go-live-v2: main"
    # then wait for the deployment's SUCCESS (up to 900s)
  $ curl -s -o /dev/null -w '%{http_code}' https://app.stonkhouse.fun/settings/notifications
    # 200 only in a NEXT_PUBLIC_V2=1 build (404 otherwise)

== What the CLI cannot do (Railway UI / owner) ==
  web: healthcheck path /; restart On Failure, 10 retries; replicas 1; watch paths web/** scripts/** package.json pnpm-lock.yaml pnpm-workspace.yaml
  then ops/deploy.md §15.7: private-network reachability from each caller, the relay wiring test, the external monitors

DRY RUN COMPLETE: nothing was changed. Re-run with --apply to do it.
```

Also exercised: an `mmQuoter` registry address that is not the key file's refuses before the plan
(`REFUSED: …/mmQuoter.env derives to 0xC196…aF63, but registry v2.bots.mmQuoter is 0x0000…dEaD`);
`--services foo` refuses; `bash -n` clean.

### 15.9 Scaling and cost

Nothing here scales out: every service but `pricing` is one per key, one per poller or one per
schema (§15.1). Growth is vertical and small. Railway's 7-day averages for today's services
(`railway metrics --all --since 7d`, 2026-09-16):

| Service | CPU | Memory |
|---|---|---|
| `indexer` | 0.02 vCPU | 287 MB |
| `Postgres` | < 0.01 vCPU | 626 MB |
| `keeper` | < 0.01 vCPU | 72 MB |
| `web` | < 0.01 vCPU | 54 MB |
| `site` | < 0.01 vCPU | 59 MB |

What to expect from v2, by the same yardstick: four keeper-image processes at roughly the v1
keeper's size each (the MM bot and the cranker do more per tick, not more in memory); `indexer-v2`
at least the v1 indexer's, since one process indexes every market's series, orders and fills; the
notifier relay-sized plus its connection pool. Three small volumes: a SQLite journal of transactions
and alerts per bot (the v1 keeper's `/data` holds 906 MB after a week of polling; watch the bots'
with `railway metrics --volume` and back them up as §10.3). Postgres grows by one `indexer-v2`
schema per deploy until `ponder db prune` (§11.3; the prune also sweeps old v1 schemas). The bill
is usage-based (memory, CPU, volume, egress); read it with `railway usage` or the project's Usage
page rather than from this file. Costs outside Railway: the archive RPC for `indexer-v2` (the
provider's key, the v1 indexer's plan), gas for the three bots, and `KeeperRewards` bounties, which
are on-chain spend from the treasury budget (O2-06 alerts on it).

### 15.10 Rollback

Railway → service → Deployments → the last good one → Redeploy (§7) restores the image with its
build-time values. Per service, what that does and does not undo:

| Service | Redeploy the previous deployment | Watch out |
|---|---|---|
| `indexer-v2` | New deployment id, new schema, re-index from `V2_START_BLOCK` over the cache (§11.3); the current deployment serves until `/ready` | minutes of backfill; nothing is lost, the tables are rebuilt |
| `pricing` | Stateless; immediate | the image's registry copy rolls back with it |
| `cranker`, `pricer`, `mm-bot` | The volume stays, so the SQLite journal does not roll back: the rolled-back code must read the newer `v2_*` tables (they are `CREATE TABLE IF NOT EXISTS`; a later migration that changes one makes this unsafe) | **the image's registry rolls back too**: an image from before a market went `live` ignores that market, one from before the write-back refuses to boot. If the registry moved since, revert the code commit and rebuild from the current registry instead. Not inside the expiry window (§15.3). Before rolling back `mm-bot`, kill its quotes |
| `notifier` | Migrations run forward only, once each: an older image on a newer schema is safe only if the newer migrations were additive | the data key and VAPID pair are variables, not in the image: unchanged |
| `web` | §7. The fastest way out of the v2 flip: redeploy the last `NEXT_PUBLIC_V2` unset deployment | reverting the variable alone does nothing until a rebuild (§6) |
| `relay` | Stateless | none |

There is no rollback for the contracts (immutable): the way back is guardian pause of new risk,
a fixed deployment, and the registry pointed at it (C2-13 `docs/DEPLOY-V2.md`), which then reaches
these services as a registry change (§15.2 rebuild, §15.3 re-index). That is the only path: `ops/v2/env`
sets **no contract address on a bot**, so nothing on Railway can outlive the rebuild that replaced a
contract. A bot boots refusing an address env var that disagrees with the registry in its image and
names both; `V2_CONTRACTS_FROM_ENV=1` overrides that on purpose, and is a hand-set variable only —
delete it in the same change that rebuilds the registry.

### 15.11 Known sharp edges, v2 edition

1. **`DATABASE_SCHEMA` stays unset on `indexer-v2`**, as on every indexer (§11.6 item 1). The first
   env file set it; it is `DATABASE_VIEWS_SCHEMA` now, and the script refuses a service that has it.
2. **The registry is in the keeper image** (§15.2): rebuild, never restart, after a registry
   change; an image rollback is a registry rollback. There is no automatic watch path:
   the owner redeploys the affected services from the new reviewed SHA.
3. **`V2_REGISTRY_PATH` is absolute.** The keeper's relative default resolves against the package
   root, which is `/app` in the image: `/ops/markets/tier1.json`, a file that never exists.
4. **`railway volume add --service` is rejected** by CLI 5.57.1 (`error: unexpected argument
   '--service' found`): the service is an option of `volume`, not of `add`, and the mount flag is
   `--mount-path`. `railway volume --service <svc> add --mount-path /data`. `ops/keeper-railway.sh`
   had the old spelling and is fixed; it also reads volumes from `railway service list --json` now.
5. **One notifier.** Two Telegram pollers on one token conflict (409); a short one during a
   redeploy is expected. Never set a webhook on the notifier's bot, and never reuse the relay's.
6. **`mm-bot` has no domain**, ever (§15.1). The script refuses to deploy it otherwise.
7. **The expiry window** (§15.3): no signing-bot redeploys 15:40–16:20 New York time on a session
   day.
8. **Two indexers watch `indexer/**`.** Every indexer commit re-indexes `indexer` and `indexer-v2`.
9. **`web`'s v2 values are build ARGs** that `web/Dockerfile` does not declare yet (§15.5): set on
   the service without them, the build drops them silently and the page stays v1.
10. **Debian images have no `wget`** and no image has `curl`: `keeper` and `indexer` are
    `bookworm-slim`, `relay`, `notifier` and `web` are alpine (busybox `wget` only). Every
    in-container probe therefore uses `node -e fetch(…)` — §15.7 step 9's `probe`, which
    `ops/alerts.md` §V18 and `ops/runbooks/incident-v2.md` also define. The only `wget` left is §9
    item 14's, from the `web` service. A `*.railway.internal` name resolves nowhere else: not on a
    laptop, not under `railway run`.
11. **`spotMaxAgeS` is 90000 (25 h), not the contract's 1 h default** (§15.13). The feeds print on a
    24 h heartbeat, so a smaller value stops quoting and rolls for most of each session. Register it
    before the first series: every later pin of the expiry compares the pinned copy. **What this one
    registry number feeds:** `Clearinghouse._floorPrice` and **every vault's** `_checkPrice` — Maker,
    Earn and House. Earn and House read `spot`, not `trySpot`, so past the age they revert `StaleSpot`
    and the vault stops quoting: it is a fail-closed launch parameter, not a tolerance (§15.13, the
    INTERFACE_VERSION 8 addendum, with the v8 line numbers). The 1 h in the sentence above is the
    contract's `DEFAULT_SPOT_MAX_AGE`, applied **only when the registry passes 0** — never a target.
12. **The notifier's challenge rate gate trusts the platform's `X-Forwarded-For`.** Sign-in
    challenges are limited to 120 per client per minute, and the client is the **last** hop in that header
    (`notifier/src/server.ts`): the connecting address, which Railway's ingress appends, never the
    caller-supplied first hop. The gate therefore depends on that ingress, and the notifier's domain
    must stay on it — a tunnel, a second proxy in front, or anything that reaches the container
    directly puts every request in the shared `unknown` bucket, and one anonymous client can then
    spend the whole allowance and 429 real sign-ins (`challenge-rate-limited`). A second bound
    survives that: 20 challenges per address per minute, enforced in Postgres under a per-address
    lock (`notifier/src/auth.ts`), so it holds across replicas and however the header arrives. If
    the header ever changes shape, re-check that read before trusting the per-client half.

### 15.12 The external monitor (`monitor`)

`ops/v2/monitor.mjs` watches what no v2 service emits: settlements late, held or disagreeing,
missed snapshots, redeem backlogs, the KeeperRewards budget, MakerVault limits, admin actions on our
contracts, the Chainlink proxies and their owner Safe, Stock Token and USDG flags, pool liquidity, L2
head lag, whether each feed keeps its heartbeat (§15.13, §V44), every other service's `/health`
(`ops/alerts.md` §V17 and §V20-§V37), and the
INTERFACE_VERSION 6 wiring: scheduled fee changes, payout routes, the sources' oracle allow-lists, the
oracle's Clearinghouse pointer, pins made outside a series creation, and whether every creatable expiry
can still pin and every expiry with series is pinned to the registry's configuration (§V38-§V43). It
reads only; it holds no key. `go-live-v2.sh --services monitor` creates and configures the service
from the same reviewed SHA as the other v2 services. It requires a live relay with a target.

| Setting | Value |
|---|---|
| Image | `keeper/Dockerfile` (the runner carries `ops/v2/monitor.mjs` and viem next to the registry, §15.2) |
| Start command | `node ops/v2/monitor.mjs --interval 60` (always on, recommended), or `node ops/v2/monitor.mjs --once` with a Railway cron schedule `*/5 * * * *` |
| Failure signal | Always-on: after 3 consecutive passes that reached nobody (a delivery the relay refused, or a pass that threw) the process exits with that pass's code, Railway restarts it and emails. `MONITOR_MAX_FAILED_PASSES` tunes it, 0 disables. Cron: failed runs in the UI (§V14) |
| Volume | `/data`, `RAILWAY_RUN_UID=0`: the state file is the dedupe memory; without it every open condition re-pages on each run |
| Replicas | **1** (two monitors page everything twice) |
| Healthcheck, domain | none; no port is served |
| Watch paths | `keeper/** ops/markets/tier1.json ops/v2/monitor.mjs` plus the lockfiles |

Variables (no secret but the relay token). The first two are the build and the volume: the repo root has
no Dockerfile, so without `RAILWAY_DOCKERFILE_PATH` the service builds nothing, and without
`RAILWAY_RUN_UID=0` the `node` user cannot write `/data` — the monitor then pages
`v2_mon_state_unwritable` (§V37a) and keeps its memory in the container's temp directory, which every
redeploy wipes:

```
RAILWAY_DOCKERFILE_PATH=keeper/Dockerfile
RAILWAY_RUN_UID=0
RH_RPC=https://rpc.mainnet.chain.robinhood.com
V2_REGISTRY_PATH=/app/ops/markets/tier1.json
MONITOR_STATE_PATH=/data/monitor-v2.json
ALERT_WEBHOOK=http://relay.railway.internal:8080/alert
ALERT_WEBHOOK_TOKEN=${{relay.RELAY_TOKEN}}
MONITOR_HEALTH=cranker=http://cranker.railway.internal:8792/health,mm-bot=http://mm-bot.railway.internal:8793/health,pricer=http://pricer.railway.internal:8794/health,pricing=http://pricing.railway.internal:8790/health,notifier=http://notifier.railway.internal:8791/health,indexer-v2=http://indexer-v2.railway.internal:42069/v2/health,relay=http://relay.railway.internal:8080/health
```

`go-live-v2.sh` sets this block, the monitor start command and restart policy before upload. The
dev project additionally sets `V2_REGISTRY_FILE=dev.json` as a build argument and uses
`V2_REGISTRY_PATH=/app/ops/markets/dev.json`. The script refuses a public domain and more than
one replica. In the Railway UI, verify **one replica**, **no healthcheck**, and the `/data` mount.

**INTERFACE_VERSION 6 needs no new variable.** The `fees` and `pins` checks read the same registry (its
`v2.defaults` and each market's `v2.overrides` are the published pin). Two things of the RPC they rely on:
the pin dry run is an `eth_call` whose `from` is the Clearinghouse (a contract; the public RPC accepts it),
and the bulk reads go through `shared.multicall3`. Optional: `MONITOR_THRESHOLDS=pinCheckS=900`, how long
the `pins` check serves its last reads when no pin or wiring log arrived (a re-read is about 45 eth_calls at
35 markets; §V43).

`RH_RPC` must serve `eth_getLogs` over the deploy-block range on the first run (it halves ranges
down to 100 blocks before failing); the public RPC does for recent blocks. First run: it scans from
`v2.deployBlock` (at most 200 ranges per run, then continues; exit 3 until caught up) and adopts every
admin event before that moment without paging.

Verify after the deploy, from a laptop with the same registry (reads only, nothing sent, no state):

```bash
node ops/v2/monitor.mjs --once --rpc $RH_RPC --no-alerts; echo "exit $?"    # 0, every check [ok]
railway logs --service monitor                                               # "summary: 0 finding(s) … exit 0" per pass
```

`--no-alerts` keeps no cursor, so it scans `v2.deployBlock` to the head on every run; that is the point
(a windowed run would report "nothing late" about anything created past the window), but it costs minutes
once the deploy is old. `--threshold maxRangesPerRun=200` caps it and says how much it left unscanned.

Then prove delivery once, from the service's shell: `node ops/v2/monitor.mjs --once --state /tmp/probe.json
--health probe=http://127.0.0.1:1/health` pages `v2_mon_service_down` for `probe` through the relay (the
throwaway state file leaves the real one untouched; the other findings of that run page too, once). Not built locally: the Docker daemon is off on the build machine (as §15.2); prove the image
with `docker build -f keeper/Dockerfile .` and `docker run --rm <image> node ops/v2/monitor.mjs --help`.

### 15.13 Oracle spot age (`spotMaxAgeS`)

**The value: `v2.defaults.spotMaxAgeS = 90000` (25 h) for every market, no `v2.overrides`.**
`SettlementOracle.spot()` reverts `StaleSpot` when `block.timestamp - updatedAt > spotMaxAge`
(callhouse-contracts 78d7f0d `src/v2/oracle/SettlementOracle.sol` L811-820). The Robinhood Chain equity
feeds print on a 0.5 % move or a 24 h heartbeat (the registry's `feedThresholdPct`, `feedHeartbeatS`),
so inside a regular session a quiet feed's print is hours old, and with the old 1 h value `spot()`
reverted for most of each session: MakerVault quoting, AutoRoller rolls and reprices and every bot that
reads spot stopped with it. `RegisterMarkets.s.sol` passes the registry value to `setMarket` (L528);
the contract's `DEFAULT_SPOT_MAX_AGE` (1 h) applies only to a 0, which `build-markets.mjs --check`
refuses along with anything under a feed's heartbeat + 1 h or over `MAX_SPOT_MAX_AGE` (4 days).

**The data.** 35 Chainlink proxies (registry b0199c0), every round from 2026-08-03T00:00Z to block
65,492,842 (2026-09-17T15:59:39Z): 45 days, 33 regular sessions (09:30-16:00 New York), no read errors.
Share of regular-session time in which `spot()` would have reverted:

| spotMaxAgeS | markets with any stale second | worst markets |
|---|---|---|
| 3600 (the old value) | 35 of 35 | SGOV 100 %, SPY 88.6 %, QQQ 78.4 %, MSFT 53.9 %, NVDA 41.9 % |
| 14400 | 25 | SGOV 100 %, SPY 59.2 %, QQQ 38.6 % |
| 43200 | 14 | SGOV 100 %, SPY 32.4 %, QQQ 9.8 % |
| 86400 | 2 | SPY 0.011 % (4 sessions), QQQ 0.003 % (1): the heartbeat's own transmit latency |
| **90000**, 93600, 172800, 345600 | 0 | none, over the 45 days and over the last 21 |

- The oldest print in force during any regular session was 86,427 s old (SPY, 2026-08-14; QQQ 86,426):
  the heartbeat plus a transmit latency of at most 30 s. 90000 is the smallest candidate with no stale
  second; 93600 (26 h, `ChainlinkFeedSource.DEFAULT_MAX_STALE`) is the only reasonable alternative.
- More buys nothing. Every feed printed within a minute of every 24/5 reopen (Sunday, or a holiday's,
  20:00 New York = 00:00Z in EDT), so the print in force at a Monday or post-holiday open was never older
  than 13.5 h. A larger value would only trust a stalled feed for longer.
- No feed missed its heartbeat: every gap over 24 h was a weekend or holiday closure or a
  24 h + 1-30 s heartbeat; the longest gap while the market was open was 86,430 s (SGOV, which prints
  only on its heartbeat).
- The measurement is EDT-only. After the 2026-11-01 DST change the reopen print moves to 01:00Z: re-run
  it on November data (no change expected).

**The tradeoff.** An accepted spot can be up to 25 h old:

- **A healthy feed:** the print is within the 0.5 % deviation threshold of the price network's latest
  price, however old it is (the move at the moment an old print was replaced: 52-55 bps typically, at
  most 65-67 bps on NVDA, AAPL, MSFT and TSLA).
- **At the 09:30 open** the print in force can be from the previous session (SPY 8 of 32 sessions,
  GME 5, AAPL 4, GOOGL 4, QQQ 3, AMZN 3) and misses the opening move until the first deviation print,
  usually 20-185 s later. The largest opening move measured was 342 bps (CLSK).
- **A stalled price network:** a print up to 25 h old is accepted whatever the price did since. Nothing
  on chain but `spotMaxAgeS` bounds it, and no `spotMaxAgeS` filters a fresh bad print (2026-09-11,
  below).

**What the contracts do with an old accepted spot** (78d7f0d):

- **MakerVault** (`src/v2/mm/MakerVault.sol`). `place` (L283), `replace` (L313) and `take` (L358) call
  `_checkPrice` (L517-524) at `spot()` of the series' oracle (`_spot`, L498-501). A bid, or a buying
  take's limit, above `spot × maxBidBpsOfSpot / 10000` reverts `BadPrice`; an ask, or a selling take's
  limit, below `_askFloor` = max(0, intrinsic − spot × askToleranceBps / 10000), intrinsic at that spot
  (L504-514), reverts. Both bounds move one-for-one with the spot error. They are fat-finger bounds, not
  the price: the price is the quoter's. A standing order is never re-checked when it fills (L48-49), so
  `maxOrderLifetime` and the bot's `MM_MAX_QUOTE_LIFETIME_S` (1800) bound how long a quote placed at an
  old spot can fill.
- **AutoRoller.roll** (`src/v2/AutoRoller.sol` L231). It is permissionless and pays the ROLL bounty.
  `_plan` (L367-410) needs `isRegularSession` (L376) and `trySpot` ok (L379-384). Then
  strike = roundUp(spot × (1 + otmBps / 10000), strikeTick) (L393-395) and
  ask = roundUp(spot × askBps / 10000, PRICE_TICK) (L396-397). **Both shift one-for-one with the spot
  error, and the keeper's `/fair` checks do not apply: anyone can call `roll`.** A guardian
  `setMintPaused(asset, true)` makes it revert `MintPaused` (L248).
- **AutoRoller.reprice** (L272, PRICER_ROLE). The new ask must lie in
  `[minAskBps, maxAskBps] × spot()` (L280-282). There is no session check.
- **Clearinghouse.createSeries** (L332). The strike must lie in [spot / 2, 2 × spot] when `trySpot` is
  ok (L357-362); the band is skipped otherwise. It is a fat-finger check that a small spot error does
  not move.

**INTERFACE_VERSION 8 addendum to that list** (T-SEC-OPS-LAUNCH-PARAMS, re-derived at callhouse-contracts
`v8` = `3d36fcb31f95383e4af55f12063bf5af164b0336`; the line numbers above are 78d7f0d's and are left as they were). The list predates two
vaults and one Clearinghouse path, so `spotMaxAgeS` reaches further than it reads:

- **Clearinghouse `_floorPrice`** (`src/v2/Clearinghouse.sol:1128`, called from `:1088`). It reads
  `ISettlementOracle.trySpot` through a gas-bounded staticcall (`:1135`), so the 25 h window sets the
  floor a keeper-routed conversion must clear.
- **EarnVault `_checkPrice`** (`src/v2/periphery/earn/EarnVault.sol:988`, called from `:708`) reads
  `ISettlementOracle(s.oracle).spot(s.underlying)` (`:989`) — `spot`, not `trySpot`, so a reading past
  `spotMaxAge` does not merely widen a bound, it **reverts `StaleSpot` and the vault stops quoting**.
- **HouseVault `_checkPrice`** (`src/v2/periphery/house/HouseVault.sol:963`, called from `:662`, `:688`
  and `:735`) reads `_spot` (`:964`), same fail-closed shape.
- **MakerVault `_checkPrice`** is already above; at v8 it is `src/v2/mm/MakerVault.sol:759`, reading
  `_spot` at `:760`, called from `:396`, `:431` and `:491`.

So the one registry number feeds **`Clearinghouse._floorPrice` and every vault's `_checkPrice`**. Read
it as a launch parameter with three fail-closed consumers, not as a tolerance.

> **Do not confuse it with `OrderBook._checkPriceAndUnits`** (`src/v2/OrderBook.sol:727`). Same-looking
> name, unrelated function: it is `private pure`, it checks the tick grid and the unit bounds, and it
> reads no oracle at all.

**The compiled bounds, mirrored not re-reasoned** (`src/v2/oracle/SettlementOracle.sol`):
`DEFAULT_SPOT_MAX_AGE = 1 hours` (`:205`) is the value applied **only when the registry passes 0**, and
`MAX_SPOT_MAX_AGE = 4 days` (`:206`) is the ceiling `setMarket` enforces. **1 h is a default, never a
target**; the launch value is the 90000 this section derives. `spotMaxAge` is a per-market field of the
SettlementOracle (`:150`, written at `:317`, read by `_spotMaxAge` at `:941`) — **the AutoRoller has no
`spotMaxAge` of its own** (its constants are `src/v2/AutoRoller.sol:101-123`), it consumes the market's.

**Settlement does not use `spotMaxAge`** (78d7f0d, checked in the source and in the data):

- **SettlementOracle.** `_spotMaxAge` is read only by `_spot` (L811-820, behind `spot` L374 and
  `trySpot` L383), by `pin`, which copies it (L354; "Informational in a pinned copy", L131), by
  `_sameConfig` (L847) and by the config views (L593, L624). `snapshot` (L400), `finalize` (L416) and
  `adminResolve` (L468) price through `_refresh` (L645) and `_windowPrice` (L794):
  `IPriceSource.windowPrice(expiry − 1800, expiry)`.
- **ChainlinkFeedSource.windowPrice** (L218) walks the round history. Its only age rule is
  `r.updatedAt + cfg.maxStale < start` (L244), with the pinned `maxStale` (`DEFAULT_MAX_STALE` 26 h,
  L98). The 2000 bps round-jump rule and the 96-read limit also apply. `latest()` (L186-187) checks no
  age: "the oracle applies spotMaxAge".
- **Measured,** treating each of the 32 closes as an expiry: the round in force at close − 30 min was at
  most 22.2 h old (SPY; QQQ and SGOV 19.5 h), under 26 h. The walk needed at most 16 of 96 reads, and the
  largest move between rounds in a window was 205 bps. Every one of the 35 × 32 windows priced.
- **The one link:** `_sameConfig` compares `spotMaxAge`. Changing it after an expiry is pinned makes a
  pin confirmation from a *different* Clearinghouse revert `PinMismatch` (the same Clearinghouse returns
  early, L339), and the monitor pages `v2_mon_pin_mismatch` for that expiry. **Register 90000 before the
  canary's first series** and do not change it while series are open.

**The keeper guards that bound it.** Neither quoting bot acts on `trySpot` alone:

- **mm-bot.** The `spot-stale` halt uses only `trySpot` (`keeper/src/v2/mm/reads.ts` L198,
  `engine.ts` L152). But no quote is placed without a `/fair` answer (`engine.ts` L162-163) whose
  `asOf`, the Cboe chain's last trade, is at most `MM_FAIR_MAX_AGE_S` (1800 s) old in session
  (L164-165), and whose spot is within `MM_FAIR_SPOT_TOLERANCE_BPS` (300) of the oracle's (L170-176).
  Nothing is quoted outside the session unless `MM_QUOTE_OFF_HOURS=1` (L149). **Keep it 0.**
- **pricing `/fair`** (`keeper/src/v2/pricing/fair.ts`). It refuses `chain-stale` or `chain-inconsistent`
  when the Cboe chain fails its clocks (L234; `keeper/src/vol.ts` `chainFreshness`: the last trade is
  older than `maxPriceAgeS` or from before the latest completed session). It refuses `spot-divergence`
  when the Chainlink print, from the same feed as the oracle, is more than `maxSpotDivergenceBps` (300)
  from Cboe's `current_price` (L259-262). Its own feed age limit is `maxPriceAgeS` (345,600 s,
  `pricing/main.ts` L138): that limit catches a dead feed, not an old print.
- **pricer.** `planCheck` skips on `trySpot` (`pricer/planner.ts` L186), and a reprice needs a `/fair`
  answer (`pricer/pricer.ts` L299-306).
- **cranker.** Ladders (`cranker/steps.ts` L675) and rolls (`cranker/planner.ts` L633) use `trySpot`
  alone, on purpose. A ladder rung is a strike listing rounded to `strikeTick` that commits no capital,
  and a print that a healthy feed keeps is within 0.5 % of the price: at most one strike tick on 29 of
  the 35 markets, four on SPY and QQQ. A roll is permissionless: a cranker that declined one would hand the bounty to another
  caller, not stop the roll. The stop is on chain (`setMintPaused`, `ops/runbooks/incident-v2.md` §7).
- **The tests.** `keeper/src/v2/spot-age.test.ts` runs the real pieces end to end. A 23.9 h old print
  that agrees with Cboe is quoted. The same print 3.3 % off is refused `spot-divergence`: the mm-bot
  halts `fair-unavailable` and cancels its quotes, and the pricer gets no fair value.
- **The blind spot,** pinned by the same test: a stalled network whose price moved between 0.5 % and
  3 % passes `spot()` and the divergence check. Roll strikes and asks, the vault's guard bounds and the
  quotes then all rest on the stale print.

**Release runbook (the canary, then every wave):**

1. **Before `RegisterMarkets`:** `node ops/markets/build-markets.mjs --check` is green. After it, for
   every market and before its first series:
   `cast call $ORACLE "marketConfig(address)(address[],uint16,uint32,uint32)" $ASSET --rpc-url $RH_RPC`
   ends in `90000`.
2. **Monitor:** `v2_mon_feed_stale` (`ops/alerts.md` §V44) pages an error when a feed misses its
   heartbeat by an hour of open market, and a warning when it misses the print at the 24/5 reopen.
   `v2_mon_pin_mismatch` (§V43) pages an expiry pinned with another spot age. The `feeds` line of every
   run prints each feed's last round age.
3. **Watch for a stalled network during the canary's sessions** — an on-call job each session while the
   two open items below are open, not something the monitor does. Nothing pages inside the 300 bps
   band. Signs: `spot-divergence` refusals in `mm-bot` `/state` and `v2_mm_pricing`,
   `v2_pricer_fair_unavailable`, or a Chainlink print more than 150-300 bps from Cboe's `current_price` × `uiMultiplier`
   or from the pool TWAP for over 5 minutes (`cast call $UNI_SRC "latest(address)(bool,uint256,uint256)" $ASSET`).
   Another sign is a feed that normally prints several times an hour going silent for an hour. When one
   appears: `ops/runbooks/incident-v2.md` §7.
4. **Keep `MM_QUOTE_OFF_HOURS=0`,** and do not reprice from the overnight session by hand. On
   2026-09-11 from 00:00:29 to 00:01:23Z (Thursday 20:00 New York, the overnight open), 11 feeds printed
   jumps that reversed at 01:49-01:52Z: CRWV +12.1 %, USAR +7.0 %, INTC +5.7 %, AMD +5.7 %, GME −5.6 %.
   25 of the 35 feeds then printed nothing for 1 h 47 m. Every move was under the 2000 bps jump rule, so
   `latest()` accepted them.
5. **If Data Streams ever becomes source 0** (callhouse-contracts `docs/V2-DATA-STREAMS.md` step 6),
   `spotMaxAge` bounds the keeper's report cadence instead of the push feed: derive the value again. At
   launch `RegisterMarkets` lists `chainlinkSource` first (L517-519).

**Follow-up status.** The pricer session gate is in code. The monitor divergence check is wired but
stays inactive until each market's band is calibrated from 30 days of paired source prices (§V48).

| Item | What is missing | Until then | Ticket |
|---|---|---|---|
| **Price divergence** | `v2_mon_price_divergence` compares the Chainlink source and pool TWAP at one head, warns past a market's calibrated band and escalates on a second pass. No band is shipped by default. | Derive a band from 30 days of paired prices per market, then set `MONITOR_DIVERGENCE_BANDS` on the monitor (§V48). Until then, keep the manual watch in step 3. | O2-06 code done; calibration pending. |
| **Pricer session gate** | `PRICER_REPRICE_OFF_HOURS=0` makes the pricer skip outside `ExpiryCalendar.isRegularSession`; `/state` shows `market-closed` or `session-unavailable`. | Keep the flag at 0 unless an owner explicitly wants off-hours repricing. | K2-05 follow-up done. |
