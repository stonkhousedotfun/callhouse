# Runbook — v2 pricing go-live (O3-303)

Owner-run. It touches Railway. It never prints a key, a webhook URL or a connection string. An agent
does not run `--apply`.

Two stages, in this order. Stage 1 is keyless and may run on stonkhouse-dev, then on production from
a reviewed **public `main`** SHA. Stage 2 is the pricer: **production only**, because the same 4663
contracts are shared — a pricer in stonkhouse-dev would reprice live asks.

| | Stage 1 `pricing` | Stage 2 `pricer` |
|---|---|---|
| Key | none. `V2_MODE=pricing` sends no transaction | `PRICER_PK`, BIP-44 index 51 |
| Where | stonkhouse-dev, then Railway project `callhouse` production | production `callhouse` only |
| Volume | none (stateless) | `/data`, `RAILWAY_RUN_UID=0` |
| Relay | exempt (O3-004) | required |
| Image | `keeper/Dockerfile` | `keeper/Dockerfile` |
| Port | 8790 (`PRICING_PORT`) | 8794 (`PRICER_PORT`) |

Shell, from the app repo root on the machine that holds the Railway login:

```bash
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
export ETH_RPC_URL="$RH_RPC"
DEV_P=d8952b22-6bd8-4fd7-984a-7868ee353879    # Railway project stonkhouse-dev
DEV_E=a87aa3a2-1c68-41e7-9866-d0e72810035b
PROD_P=9988a803-0b8f-4b0e-8ada-ba71e5a505ae  # Railway project callhouse
PROD_E=319fcb44-0e25-4367-947c-09351a349d2e
probe() { railway ssh --service "$1" -- node -e "fetch('$2').then(async r=>console.log(r.status,(await r.text()).slice(0,4000))).catch(e=>console.log('ERR',e.message))"; }
```

`--ref` is a full 40-character reviewed commit SHA. Who supplies it: the owner. Stage 1 production
uses the reviewed public `main` SHA of `stonkhousedotfun/callhouse`. Stage 1 dev uses the reviewed
SHA of `leekzor/callhouse-dev` (the script selects that repo when the dev project ids are passed).
Do not type `main` or `v2` with `--apply`.

---

## 0. The clock: no merge-redeploy inside close ± 20 minutes

America/New_York. Regular session close is 16:00 → **15:40–16:20 is forbidden** for a merge-redeploy
of `pricer` (and of `cranker` / `mm-bot`). NYSE early close is 13:00 → **12:40–13:20 is forbidden**
on those dates, even though `go-live-v2.sh`'s `in_expiry_window` currently only checks weekday
15:40–16:20. Honor the early-close window by hand.

```bash
TZ=America/New_York date +%F\ %H:%M\ %u
# %u 1–5 is a weekday. On a regular day, refuse 15:40–16:20. On an early-close date, refuse 12:40–13:20.

node -e 'const j=JSON.parse(require("fs").readFileSync("ops/markets/v2-sources.json","utf8")); const y=new Date().toLocaleString("en-CA",{timeZone:"America/New_York"}).slice(0,4); console.log((j.nyseHolidays[y].earlyCloses||[]).map(x=>x.date).join("\n"));'
```

2026 early closes in that file: `2026-11-27`, `2026-12-24`. Re-read the file on the day; do not
memorise it. `pricing` is stateless and `go-live-v2.sh` already allows it inside the regular window
(`svc != pricing` in the upload guard); still do not start a **pricer** upload that could land in
the window — the build itself may take several minutes after `railway up`.

`--ignore-expiry-window` is an owner-reviewed exception, not a habit.

---

## 1. Stage 1 — keyless pricing

`pricing` holds no key, sends no transaction, and is relay-exempt. Dev Railway pricing is
**read-only against the shared 4663 contracts**. Anvil writes use fork-only keys in a different
runbook. Do not treat a green `/health` as per-series source readiness.

### 1.1 stonkhouse-dev

Empty Service named `pricing` in the Railway UI of project `stonkhouse-dev` (no repo, no image
source) if it does not already exist. Then:

```bash
ops/go-live-v2.sh --plan-gating --project $DEV_P --environment $DEV_E --services pricing
# action: allow, reason: relay-exempt

ops/go-live-v2.sh --ref <40-char leekzor/callhouse-dev SHA> \
  --project $DEV_P --environment $DEV_E --services pricing
# DRY RUN: read every printed railway command. Nothing is changed.

ops/go-live-v2.sh --apply --ref <same SHA> \
  --project $DEV_P --environment $DEV_E --services pricing
```

`--apply` also writes `V2_REGISTRY_FILE=dev.json` on the dev project. After SUCCESS:

```bash
railway link -p $DEV_P -e $DEV_E
probe pricing http://pricing.railway.internal:8790/health
# 200, status ok | degraded. degraded means the process is up and the chain is stale — not a silent skip.
```

### 1.2 `PRICING_URL` on the dev indexer

`ops/v2/env-dev/indexer-v2.env` already contains
`PRICING_URL=http://pricing.railway.internal:8790`. A service that was deployed before that line
existed does not have it in the running process until you apply indexer-v2 from the same SHA:

```bash
ops/go-live-v2.sh --apply --ref <same SHA> \
  --project $DEV_P --environment $DEV_E --services indexer-v2
railway ssh --service indexer-v2 -- node -e "console.log(process.env.PRICING_URL)"
# http://pricing.railway.internal:8790
probe indexer-v2 http://pricing.railway.internal:8790/health
# 200 from inside the indexer container: private DNS works in this project
```

Who supplies a strike/expiry for a `/fair` probe: the owner, from a live NVDA series
(`cast` / the app). Example shape, values filled on the day:

```bash
probe pricing "http://pricing.railway.internal:8790/fair?ticker=NVDA&strike=<6dp>&expiry=<unix>&type=call"
```

### 1.3 production, from public `main`

Same shape, production ids, the reviewed public `main` SHA of `stonkhousedotfun/callhouse`:

```bash
railway link -p $PROD_P -e $PROD_E
ops/go-live-v2.sh --plan-gating --services pricing
ops/go-live-v2.sh --ref <40-char public main SHA> --services pricing          # DRY RUN
ops/go-live-v2.sh --apply --ref <same SHA> --services pricing
probe pricing http://pricing.railway.internal:8790/health                     # 200
ops/go-live-v2.sh --apply --ref <same SHA> --services indexer-v2
railway ssh --service indexer-v2 -- node -e "console.log(process.env.PRICING_URL)"
# http://pricing.railway.internal:8790
```

There is also a v1 `indexer` service in this project. It does not proxy `/v2/fair`. Do not set
`PRICING_URL` on it. "Each indexer" here means each **v2** indexer: `indexer-v2` in stonkhouse-dev
and `indexer-v2` in production `callhouse`.

In the Railway UI, per `pricing` service: healthcheck path `/health`, timeout 120 s, restart
**On Failure** 10 retries, replicas 1, **no public domain**, repo and image source disconnected.
Seal nothing: this service has no secret.

### 1.4 Rollback (stage 1)

Pricing is stateless. Rolling it back is a new CLI upload of an older reviewed SHA, or disconnecting
the indexer from it.

1. Railway UI: service `indexer-v2` → Variables → `PRICING_URL` → delete the variable (not blank —
   delete). Then, **outside** the close ±20 minute window if you would also touch a signing bot;
   indexer-v2 itself is not a signing bot:

   ```bash
   railway redeploy --service indexer-v2
   ```

   `/v2/fair` then has nowhere to proxy. That is the fail-closed path.

2. Leave the `pricing` service running (harmless, keyless) or delete it in the Railway UI:
   service `pricing` → Settings → Delete service. Who decides: the owner. Deleting it does not
   change the contracts.

3. Image rollback of `pricing` rolls back the registry copy baked into that image
   (`deploy.md` §15.10). If `ops/markets/tier1.json` moved since that SHA, rebuild from the
   current registry instead of the old image.

Do not set `PRICING_URL` to a made-up host. Delete it.

---

## 2. Stage 2 — pricer, production only

Do not start this until stage 1 production `/health` is 200 and `PRICING_URL` is set on production
`indexer-v2`. The pricer holds `PRICER_PK` and `PRICER_ROLE` on `AutoRoller`. stonkhouse-dev is
refused:

```bash
ops/go-live-v2.sh --plan-gating --project $DEV_P --environment $DEV_E --services pricer
# action: refuse, reason: signing service refused when project stonkhouse-dev is selected
```

### 2.1 Preconditions

- Relay live with `RELAY_TOKEN` and a target ([relay-monitor-go-live.md](relay-monitor-go-live.md)).
  An apply of `pricer` without that is `REFUSED`.
- `PRICER_ROLE` already granted to `v2.bots.pricer` (canary §3.1). Confirm, do not grant here:

  ```bash
  cast call $ROLLER "hasRole(bytes32,address)(bool)" $PRICER_ROLE $PRICER --rpc-url $RH_RPC
  ```

  `$ROLLER`, `$PRICER`, `$PRICER_ROLE` come from the canary shell-setup `eval`. If that `eval` is
  not in this shell, stop and use [v2-canary.md](v2-canary.md) "Shell setup".
- Key file `~/.callhouse-keys/v2/pricer.env` mode 600, derives to the registry address. This
  runbook never reads or prints it; `go-live-v2.sh` does, from that path, into
  `railway variables --set-from-stdin`.
- Volume `/data` and `RAILWAY_RUN_UID=0`. The script sets both when the service is selected.
- **Not** inside close ±20 minutes (section 0).

### 2.2 Create and apply

Empty Service named `pricer` in the Railway UI of project `callhouse` production if it does not
exist (no repo, no image source). Then:

```bash
railway link -p $PROD_P -e $PROD_E
ops/go-live-v2.sh --ref <40-char public main SHA> --services pricer          # DRY RUN
ops/go-live-v2.sh --apply --ref <same SHA> --services pricer
```

`--apply` sets `RAILWAY_RUN_UID=0`, `RAILWAY_DOCKERFILE_PATH=keeper/Dockerfile`,
`KEEPER_DB_PATH=/data/pricer.db`, `PRICING_URL=http://pricing.railway.internal:8790`,
`ALERT_WEBHOOK` + `ALERT_WEBHOOK_TOKEN=${{relay.RELAY_TOKEN}}`, and prompts for `PRICER_PK` only
if it is not already set. **Seal `PRICER_PK` in the Railway UI immediately after.** UI: service
`pricer` → Variables → `PRICER_PK` → ⋮ → Seal.

UI checks: volume mounted at `/data`, healthcheck `/health` timeout 300 s, restart On Failure 10
retries, replicas **1**, no public domain, repo and image source disconnected.

```bash
probe pricer http://pricer.railway.internal:8794/health     # 200 status ok (starting for ~3 intervals)
probe pricer http://pricing.railway.internal:8790/health    # 200: the pricer can reach pricing
railway ssh --service pricer -- ls -ld /data
# owner root, because RAILWAY_RUN_UID=0; without that the node user gets EACCES on /data/pricer.db
```

`PRICER_EDGE_BPS` is an owner decision ([v2-canary.md](v2-canary.md) §3.6). Changing it is a
Railway variable and a restart, not this runbook.

### 2.3 Merge-redeploy later

A code or registry change is a new reviewed SHA and:

```bash
ops/go-live-v2.sh --apply --ref <new 40-char SHA> --services pricer
```

Only **outside** the close ±20 minute window in America/New_York, early closes included (section 0).
The script refuses weekday 15:40–16:20 without `--ignore-expiry-window`; it does **not** refuse
12:40–13:20 on an early close — you do.

### 2.4 Rollback (stage 2)

A stopped pricer leaves every smart-pricing ask at its last price, inside the writer's band. That
is the designed last-price behaviour, not a bug.

1. Confirm you are outside the window (section 0).
2. Railway UI: service `pricer` → ⋮ → Restart, or delete the service (Settings → Delete service)
   if you want it gone. Who decides: the owner.
3. Image rollback is a registry rollback (`deploy.md` §15.10). The `/data` volume **stays**; the
   SQLite journal does not roll back with the image. If the registry moved, rebuild from the
   current registry rather than an old image.
4. Revoking `PRICER_ROLE` is [incident-v2.md](incident-v2.md) §4b, not a Railway action.

---

## 3. What this runbook does not do

- It does not buy a paid feed, set a vendor API key, or switch the live source. That is OWN3-308 /
  OWN3-309 after K3-308 qualification.
- It does not flip `app.stonkhouse.fun`. That is [v2-canary.md](v2-canary.md) §7.2.
- It does not deploy `mm-bot`. That is canary §3.4–§3.5, last, after this stage 1 is up.

## Related

- Script: [`../go-live-v2.sh`](../go-live-v2.sh), gating [`../v2/go-live-gating.mjs`](../v2/go-live-gating.mjs)
- Variables: [`../v2/env/pricing.env`](../v2/env/pricing.env), [`../v2/env/pricer.env`](../v2/env/pricer.env), [`../v2/env/indexer-v2.env`](../v2/env/indexer-v2.env)
- Layout: [`../deploy.md`](../deploy.md) §15.1, §15.10, §15.3
- Canary: [`v2-canary.md`](v2-canary.md) §3.6, §4
- Relay: [`relay-monitor-go-live.md`](relay-monitor-go-live.md)
